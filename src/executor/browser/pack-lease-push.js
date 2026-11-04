/**
 * 环境包租约「被动推送」客户端。
 *
 * 流程：
 *  1. 向 PHP 换取中继票据，主动连 WSS 中继（不监听任何端口，NAT 后也能收推送）。
 *  2. 对被占用的环境调用 /pack-lease/enqueue（入队即返回，不挂起）。
 *  3. 占用方上传环境包并释放后，PHP 通知中继，中继只推给 FIFO 队首 → 本模块 resolve 对应等待。
 *
 * 没有定时轮询：只有两种一次性补漏——WSS 断线重连后重新入队；租约到期时刻重新入队一次
 * （占用方崩溃、没有释放时，中心库只在租约过期后才会放行）。
 */
const WebSocket = require('ws');
const phpApi = require('../php-api');
const { publish: liveLog } = require('../live-log');

/** profileId -> Set<waiter> */
const waiters = new Map();
let sock = null;
let sockHost = '';
let connecting = null;
let reconnectTimer = null;
let backoffMs = 1000;

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function allWaiters() {
  const out = [];
  for (const set of waiters.values()) for (const w of set) out.push(w);
  return out;
}

function removeWaiter(w) {
  const set = waiters.get(w.profileId);
  if (set) {
    set.delete(w);
    if (!set.size) waiters.delete(w.profileId);
  }
  clearTimeout(w.timer);
  clearTimeout(w.leaseTimer);
}

function finish(w, result) {
  removeWaiter(w);
  w.resolve(result);
}

function fail(w, err) {
  removeWaiter(w);
  w.reject(err);
}

function leaseDelayMs(leaseUntil) {
  const t = Date.parse(String(leaseUntil || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return 10 * 60 * 1000;
  return Math.min(2 * 60 * 60 * 1000, Math.max(15_000, t - Date.now() + 2000));
}

/** 入队一次；已轮到本端则直接放行，否则等推送（并挂一个租约到期时刻的一次性补漏） */
async function enqueueOnce(w) {
  let state;
  try {
    state = await phpApi.post(
      `/node/browser-profiles/${encodeURIComponent(w.profileId)}/pack-lease/enqueue`,
      { hostId: w.hostId, accountId: Number(w.accountId) || 0 },
    );
  } catch (e) {
    if (/不存在|404/i.test(String(e.message || e))) return fail(w, codeError('RELAY_NOT_FOUND', String(e.message || e)));
    liveLog(`环境 ${w.profileId.slice(0, 8)}… 入队请求失败（${e.message || e}），断线重连或到期后会再次入队`, 'warn', { accountId: w.accountId });
    return undefined;
  }
  if (!waiters.get(w.profileId)?.has(w)) return undefined; // 已被其它路径结束
  if (state?.ready) return finish(w, { ready: true, position: Number(state.position || 1), releaseSeq: state.releaseSeq });
  w.position = Number(state?.position || 0);
  w.queueSize = Number(state?.queueSize || 0);
  clearTimeout(w.leaseTimer);
  w.leaseTimer = setTimeout(() => { enqueueOnce(w).catch(() => {}); }, leaseDelayMs(state?.leaseUntil));
  w.leaseTimer.unref?.();
  return undefined;
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg?.type !== 'pack-lease-ready') return;
  const pid = String(msg.data?.profileId || '');
  const set = waiters.get(pid);
  if (!set) return;
  for (const w of [...set]) {
    if (!msg.data.hostId || msg.data.hostId === w.hostId) {
      finish(w, { ready: true, pushed: true, position: 1, releaseSeq: msg.data.releaseSeq });
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !allWaiters().length) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!allWaiters().length) return;
    try {
      await ensureConnected(sockHost);
      backoffMs = 1000;
      // 断线期间可能错过推送：重连后对所有等待方重新入队补漏
      for (const w of allWaiters()) enqueueOnce(w).catch(() => {});
    } catch {
      backoffMs = Math.min(60_000, backoffMs * 2);
      scheduleReconnect();
    }
  }, backoffMs);
  reconnectTimer.unref?.();
}

async function ensureConnected(hostId) {
  if (sock && sock.readyState === WebSocket.OPEN && sockHost === hostId) return;
  if (connecting) return connecting;
  connecting = (async () => {
    let t;
    try {
      t = await phpApi.post('/node/pack-relay/ticket', { hostId });
    } catch (e) {
      throw codeError('RELAY_UNCONFIGURED', `无法获取中继票据：${e.message || e}`);
    }
    const base = String(process.env.TKSWARM_RELAY_URL || t?.url || '').trim();
    if (!t?.ticket || !base) throw codeError('RELAY_UNCONFIGURED', '未配置 WSS 中继地址（TKSWARM_RELAY_URL 或服务端 TKSWARM_RELAY_PUBLIC_URL）');
    const url = `${base}${base.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t.ticket)}`;
    await new Promise((resolve, reject) => {
      const s = new WebSocket(url, { handshakeTimeout: 15000 });
      let opened = false;
      s.once('open', () => {
        opened = true;
        sock = s;
        sockHost = hostId;
        resolve();
      });
      s.on('message', onMessage);
      s.on('error', (e) => { if (!opened) reject(codeError('RELAY_CONNECT', `连接中继失败：${e.message || e}`)); });
      s.on('close', () => {
        if (sock === s) sock = null;
        scheduleReconnect();
      });
    });
  })().finally(() => { connecting = null; });
  return connecting;
}

/**
 * 被动等待某环境的占用解除。resolve 时表示已轮到本端，调用方应立刻重新 acquire。
 * reject.code：RELAY_UNCONFIGURED / RELAY_CONNECT（可退回旧挂起）、RELAY_TIMEOUT、RELAY_NOT_FOUND。
 */
async function waitForRelease(profileId, { hostId, accountId = 0, timeoutMs = 15 * 60 * 1000 } = {}) {
  const pid = String(profileId || '').trim();
  const hid = String(hostId || '').trim();
  if (!pid || !hid) throw codeError('RELAY_BAD_ARGS', '缺少 profileId/hostId');
  await ensureConnected(hid);
  return new Promise((resolve, reject) => {
    const w = { profileId: pid, hostId: hid, accountId, resolve, reject, timer: null, leaseTimer: null };
    if (!waiters.has(pid)) waiters.set(pid, new Set());
    waiters.get(pid).add(w);
    w.timer = setTimeout(() => fail(w, codeError('RELAY_TIMEOUT', '等待环境释放超时')), Math.max(5000, timeoutMs));
    w.timer.unref?.();
    enqueueOnce(w).catch((e) => fail(w, e));
  });
}

module.exports = { waitForRelease };
