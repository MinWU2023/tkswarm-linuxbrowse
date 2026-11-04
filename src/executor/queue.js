/**
 * 服务器浏览器任务队列（客服坐席 cs_seat / Linux AI 拓客）
 * ---------------------------------------------------------------
 * 规则（产品约定）：
 * 1. 待执行任务自动入队领取，最多同时跑 3 路（TKSWARM_SERVER_BROWSER_CONCURRENCY）
 * 2. 任一路结束立刻补位下一个，无需前台「任务执行」开关
 * 3. 全程写中心库 account_work_logs（与 Node 实时日志同源）
 * 4. 支持强制关停（打断本机执行并关窗）、重试（重置后立刻踢入队列）
 */
const phpApi = require('./php-api');
const { publish: liveLog } = require('./live-log');
const { getProvider } = require('./browser/providers');
const { isServerBrowserBatchScope } = require('./browser/server-browser');
const { forceCloseBrowserProfile } = require('./browser/tiktok-actions');

/**
 * 必须与 task-runner.WORKER_ID 一致。
 * claim-item / heartbeat / finish 都校验 locked_by === workerId；
 * 若用 sbq: 前缀领取，执行阶段永远领不到分项，任务会一直「待执行」或空转结束。
 */
const WORKER_ID = (() => {
  try {
    const { hostId } = require('./browser/env-pack-sync');
    return `node-${hostId()}`;
  } catch {
    return `node-${require('node:os').hostname() || 'node'}`;
  }
})();

function maxConcurrency() {
  const n = Number(process.env.TKSWARM_SERVER_BROWSER_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1) return Math.min(12, Math.floor(n));
  return 3;
}

/** @type {Map<number, { abort: boolean, profileId: string, startedAt: number }>} */
const running = new Map();
/** 强制关停标记：即便从 running 移除后，仍在跑的 executeWorkBatch 能读到 abort */
const aborted = new Set();
let filling = false;
let started = false;
let lastHealthOk = false;
let lastHealthAt = 0;

async function linuxReady() {
  const flag = String(process.env.TKSWARM_SERVER_BROWSER_AUTO || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  const now = Date.now();
  if (now - lastHealthAt < 15000) return lastHealthOk;
  lastHealthAt = now;
  try {
    await getProvider('linux').health();
    lastHealthOk = true;
  } catch (e) {
    lastHealthOk = false;
    if (now - (linuxReady._lastWarn || 0) > 60000) {
      linuxReady._lastWarn = now;
      console.warn('[server-browser-queue] linuxbrowse 不可用，暂停自动领取:', e.message || e);
    }
  }
  return lastHealthOk;
}

function stats() {
  return {
    workerId: WORKER_ID,
    maxConcurrent: maxConcurrency(),
    running: running.size,
    runningBatchIds: [...running.keys()],
    linuxReady: lastHealthOk,
  };
}

function isAbortRequested(batchId) {
  const id = Number(batchId);
  if (aborted.has(id)) return true;
  const st = running.get(id);
  return Boolean(st?.abort);
}

function setRunningProfile(batchId, profileId) {
  const st = running.get(Number(batchId));
  if (!st) return;
  st.profileId = String(profileId || '').trim();
}

async function claimOne() {
  const token = phpApi.getAuthTokenBare?.() || '';
  if (!token && !process.env.TKSWARM_API_TOKEN) {
    // 仍可尝试：可能请求上下文里有 Bearer
  }
  const batch = await phpApi.post('/node/work-batches/claim', {
    workerId: WORKER_ID,
    leaseSeconds: 300,
    serverBrowserOnly: true,
  }).catch((e) => {
    const msg = String(e.message || e);
    if (!/404|empty|no pending|暂无/i.test(msg)) {
      liveLog(`服务器浏览器队列领取失败：${msg}`, 'warn', {});
    }
    return null;
  });
  if (!batch || !batch.id) return null;
  const scope = String(batch.batch_scope || batch.batchScope || '');
  if (!isServerBrowserBatchScope(scope) && scope !== 'cs_seat') {
    try {
      await phpApi.post(`/node/work-batches/${batch.id}/release`, {
        workerId: WORKER_ID,
        reason: '非服务器浏览器范围',
        errorMessage: '非服务器浏览器范围',
      });
    } catch { /* ignore */ }
    return null;
  }
  return batch;
}

async function runBatch(batch) {
  const batchId = Number(batch.id);
  const accountId = Number(batch.account_id || batch.account?.id || 0);
  const scope = String(batch.batch_scope || '');
  liveLog(
    `服务器浏览器队列：开始执行总任务 #${batchId}（${scope || 'linux'}，并发 ${running.size}/${maxConcurrency()}）`,
    'info',
    { batchId, accountId, scope, queue: true }
  );
  try {
    await phpApi.post(`/node/work-batches/${batchId}/mark-executing`, {
      workerId: WORKER_ID,
    }).catch(() => {});

    const { executeWorkBatch } = require('./runner');
    await executeWorkBatch(batch);

    if (isAbortRequested(batchId)) {
      liveLog(`服务器浏览器队列：总任务 #${batchId} 已被强制关停`, 'warn', { batchId, accountId });
      return;
    }
    liveLog(
      `服务器浏览器队列：总任务 #${batchId} 结束（槽位释放，准备补位）`,
      'info',
      { batchId, accountId }
    );
  } catch (err) {
    const msg = String(err?.message || err);
    liveLog(`服务器浏览器队列：总任务 #${batchId} 失败：${msg}`, 'error', { batchId, accountId });
    if (isAbortRequested(batchId)) return;
    // 软等待类：退回 pending 稍后再领；硬失败：强制失败避免死循环
    if (/WAITING_ENV_PACK|WAITING_LOGIN_DATA|缺环境包|登录数据无法同步/i.test(msg)) {
      try {
        await phpApi.post(`/node/work-batches/${batchId}/release`, {
          workerId: WORKER_ID,
          reason: msg.slice(0, 500),
          errorMessage: msg.slice(0, 500),
        });
      } catch { /* ignore */ }
    } else if (/账号未登录|一键登录|nonRetryable|无权|禁止/i.test(msg) || err?.nonRetryable) {
      try {
        await phpApi.post(`/node/work-batches/${batchId}/force-fail`, {
          errorMessage: msg.slice(0, 500),
        });
      } catch { /* ignore */ }
    } else {
      try {
        await phpApi.post(`/node/work-batches/${batchId}/release`, {
          workerId: WORKER_ID,
          reason: msg.slice(0, 500),
          errorMessage: msg.slice(0, 500),
        });
      } catch { /* ignore */ }
    }
  }
}

async function fillSlots() {
  if (filling) return;
  filling = true;
  try {
    if (!(await linuxReady())) return;
    const max = maxConcurrency();
    while (running.size < max) {
      // 关停过程中先不领新的，避免挤掉正在 abort 的槽位补位节奏
      if ([...running.values()].some((x) => x.abort)) break;
      const batch = await claimOne();
      if (!batch?.id) break;
      const id = Number(batch.id);
      if (running.has(id)) break;
      aborted.delete(id);
      running.set(id, { abort: false, profileId: '', startedAt: Date.now() });
      void runBatch(batch).finally(() => {
        running.delete(id);
        aborted.delete(id);
        // 跑完立刻补位
        setImmediate(() => { fillSlots().catch(() => {}); });
      });
    }
  } finally {
    filling = false;
  }
}

/** 重试/恢复后立刻尝试把指定 batch 踢进队列 */
async function kickBatch(batchId) {
  const id = Number(batchId || 0);
  if (!id) throw new Error('缺少 batchId');
  if (running.has(id)) {
    return { ok: true, batchId: id, already: true, ...stats() };
  }
  if (!(await linuxReady())) {
    throw new Error('本机 linuxbrowse 不可用，无法执行服务器浏览器任务');
  }
  if (running.size >= maxConcurrency()) {
    // 已满：保持 pending，等槽位；仍返回 ok 让 UI 知道已入队等待
    liveLog(
      `服务器浏览器队列：总任务 #${id} 已重试，当前满载 ${running.size}/${maxConcurrency()}，排队等待补位`,
      'info',
      { batchId: id }
    );
    return { ok: true, batchId: id, queued: true, ...stats() };
  }
  const batch = await phpApi.post('/node/work-batches/claim-one', {
    batchId: id,
    workerId: WORKER_ID,
    leaseSeconds: 300,
  }).catch((e) => {
    throw new Error(e.message || '领取失败');
  });
  if (!batch?.id) {
    throw new Error('无法领取该任务（可能已在跑或无待执行分项）');
  }
  const bid = Number(batch.id);
  aborted.delete(bid);
  running.set(bid, { abort: false, profileId: '', startedAt: Date.now() });
  liveLog(
    `服务器浏览器队列：重试踢入总任务 #${bid}（并发 ${running.size}/${maxConcurrency()}）`,
    'info',
    { batchId: bid, accountId: batch.account_id }
  );
  void runBatch(batch).finally(() => {
    running.delete(bid);
    aborted.delete(bid);
    setImmediate(() => { fillSlots().catch(() => {}); });
  });
  return { ok: true, batchId: bid, started: true, ...stats() };
}

/** 强制关停：标记 abort + 关窗 + 中心库 force-fail */
async function forceStop(batchId, reason = '服务器浏览器手动强制关停') {
  const id = Number(batchId || 0);
  if (!id) throw new Error('缺少 batchId');
  aborted.add(id);
  const st = running.get(id);
  if (st) {
    st.abort = true;
    const pid = String(st.profileId || '').trim();
    if (pid) {
      try { await forceCloseBrowserProfile(pid); } catch { /* ignore */ }
    }
  }
  liveLog(`服务器浏览器队列：强制关停总任务 #${id}`, 'warn', { batchId: id });
  try {
    await phpApi.post(`/node/work-batches/${id}/force-fail`, {
      errorMessage: String(reason || '强制关停').slice(0, 500),
    });
  } catch (e) {
    // 即使 PHP 失败，本机也已标记 abort；等 runBatch.finally 释放槽位
    return { ok: true, batchId: id, localAbort: true, message: e.message, ...stats() };
  }
  // 不从 running 删除：留给 runBatch.finally，避免关停瞬间并发超限抢跑
  setImmediate(() => { fillSlots().catch(() => {}); });
  return { ok: true, batchId: id, ...stats() };
}

function startServerBrowserQueue() {
  if (started) return;
  started = true;
  const ms = Math.max(1500, Number(process.env.TKSWARM_SERVER_BROWSER_TICK_MS || 2000) || 2000);
  const timer = setInterval(() => {
    fillSlots().catch(() => {});
  }, ms);
  timer.unref?.();
  console.log(
    `[INFO] server-browser-queue: max ${maxConcurrency()} concurrent, tick ${ms}ms, worker ${WORKER_ID}`
  );
  setTimeout(() => { fillSlots().catch(() => {}); }, 800);
}

module.exports = {
  startServerBrowserQueue,
  fillSlots,
  kickBatch,
  forceStop,
  isAbortRequested,
  setRunningProfile,
  stats,
  WORKER_ID,
  maxConcurrency,
};
