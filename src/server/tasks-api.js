/**
 * 待执行任务列表 API（仅服务器浏览器白名单）
 * - 账号矩阵 /api/account-work-batches：客服坐席 cs_seat / AI 拓客 ai_lead
 * - 中心库 /api/tasks：仅 ai_lead / ai_lead_dm（禁止 publish / warm 等）
 */
const express = require('express');
const { TKSWARM_API_BASE } = require('../config');
const { readSettings, resolveRequestUser, extractBearer } = require('../settings');
const { assertTokenAlive } = require('../auth/token-guard');
const db = require('../db');
const worker = require('../worker');

const router = express.Router();

async function requireUser(req, res) {
  const { user, token } = resolveRequestUser(req);
  if (user && token) {
    const alive = await assertTokenAlive(token);
    if (alive) {
      const again = resolveRequestUser(req);
      if (again.user) {
        req.currentUser = again.user;
        req.authToken = token;
        return again.user;
      }
    }
  } else if (token) {
    try {
      const { adoptRemoteToken } = require('../auth/token-guard');
      const adopted = await adoptRemoteToken(token);
      if (adopted?.user) {
        req.currentUser = adopted.user;
        req.authToken = token;
        return adopted.user;
      }
    } catch { /* fall through */ }
  }
  const fallback = db.getCurrentUser();
  if (fallback) {
    req.currentUser = fallback;
    req.authToken = fallback.token || token || '';
    return fallback;
  }
  res.status(401).json({ ok: false, message: '未登录，请先打开控制台登录' });
  return null;
}

function apiBase() {
  const s = readSettings();
  return String(s.apiBase || TKSWARM_API_BASE || '').replace(/\/+$/, '');
}

function authToken(req, user) {
  return req.authToken || user.token || extractBearer(req) || '';
}

async function upstreamGet(base, path, token) {
  const upstream = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const json = await upstream.json().catch(() => ({}));
  const ok = json.success === true || json.code === 0 || json.code === 200 || upstream.ok;
  return { upstream, json, ok, data: json.data || json };
}

async function upstreamPost(base, path, token, body = {}) {
  const upstream = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const json = await upstream.json().catch(() => ({}));
  const ok = json.success === true || json.code === 0 || json.code === 200 || upstream.ok;
  return { upstream, json, ok, data: json.data || json };
}

function parseTaskTarget(raw) {
  const id = String(raw || '').trim();
  if (/^awb-/i.test(id)) {
    return { kind: 'account_work', batchId: Number(String(id).replace(/^awb-/i, '')) || 0, taskId: 0 };
  }
  const n = Number(id) || 0;
  // 纯数字：优先按矩阵总任务；中心库拓客也用数字 ID，由路由调用方区分 kind
  return { kind: 'unknown', batchId: n, taskId: n };
}

const SEAT_TYPE_LABEL = {
  cs_login: '客服登录',
  cs_logout: '客服退出',
  cs_detect: '客服检测登录',
  dm_reply: '客服发信',
  dm_sync: '客服私信同步',
  sync_fans: '客服粉丝/关注同步',
  ai_lead: 'AI 拓客',
  ai_lead_dm: 'AI 拓客私信',
};

/** 中心库 tasks 表里允许出现在服务器浏览器任务页的类型 */
const CENTER_SERVER_BROWSER_TYPES = new Set(['ai_lead', 'ai_lead_dm']);
const CENTER_TYPE_QUERY = 'ai_lead,ai_lead_dm';

/** 坐席/拓客分任务类型（含误入 general 的 sync_fans 等） */
const SEAT_WORK_TASK_TYPES = new Set([
  'sync_fans', 'dm_sync', 'dm_reply', 'cs_login', 'cs_logout', 'cs_detect',
  'ai_lead', 'ai_lead_dm',
]);

function isSeatWorkRow(row) {
  const scope = String(row.batch_scope || row.batchScope || '').trim().toLowerCase();
  if (scope === 'cs_seat' || scope === 'ai_lead') return true;
  const taskType = String(row.primary_task_type || row.primaryTaskType || '').trim().toLowerCase();
  if (SEAT_WORK_TASK_TYPES.has(taskType)) return true;
  const seatAction = String(row.seat_action || row.seatAction || '').trim();
  return seatAction !== '';
}

function pickUpstreamRows(block) {
  return Array.isArray(block?.data?.items)
    ? block.data.items
    : (Array.isArray(block?.data?.list) ? block.data.list : []);
}

/** 旧 API 列表无 primary_task_type 时，抽查分任务识别坐席类 */
async function enrichSeatRowsFromItems(base, token, rows, limit = 15) {
  const candidates = rows.filter((r) => !isSeatWorkRow(r)).slice(0, limit);
  if (!candidates.length) return rows;
  const found = new Map();
  await Promise.all(candidates.map(async (r) => {
    const id = Number(r.id || 0);
    if (id < 1) return;
    try {
      const detail = await upstreamGet(base, `/account-work-batches/${id}/items?pageSize=8`, token);
      if (!detail.ok) return;
      const items = pickUpstreamRows(detail);
      for (const it of items) {
        const tt = String(it.task_type || it.taskType || '').trim().toLowerCase();
        const payload = it.payload || {};
        const seatAction = String(payload.seatAction || payload.seat_action || '').trim();
        const be = String(payload.browserBackend || payload.browser_backend || '').trim().toLowerCase();
        const hit = SEAT_WORK_TASK_TYPES.has(tt)
          || seatAction !== ''
          || (tt === 'message' && (seatAction || be === 'linux'));
        if (!hit) continue;
        found.set(id, {
          ...r,
          primary_task_type: tt || r.primary_task_type,
          seat_action: seatAction || r.seat_action || '',
          last_item_id: Number(it.id || 0) || r.last_item_id,
          last_item_status: String(it.status || r.last_item_status || ''),
        });
        return;
      }
    } catch { /* ignore */ }
  }));
  if (!found.size) return rows;
  return rows.map((r) => found.get(Number(r.id)) || r);
}

function mapWorkBatch(row) {
  const scope = String(row.batch_scope || row.batchScope || 'general');
  const pending = Number(row.pending_count || 0);
  const paused = Number(row.paused_count || 0);
  const total = Number(row.item_total || row.item_count || 0);
  const username = row.username || `#${row.account_id || ''}`;
  const scopeLabel = scope === 'cs_seat' ? '客服坐席' : (scope === 'ai_lead' ? 'AI 拓客' : '矩阵任务');
  const taskType = String(row.primary_task_type || row.primaryTaskType || '').trim();
  const seatAction = String(row.seat_action || row.seatAction || '').trim();
  const actionKey = seatAction || taskType;
  const actionLabel = SEAT_TYPE_LABEL[actionKey] || SEAT_TYPE_LABEL[taskType] || actionKey || scopeLabel;
  const lastItemId = Number(row.last_item_id || row.lastItemId || 0);
  const listType = scope === 'cs_seat' || SEAT_WORK_TASK_TYPES.has(taskType) || seatAction
    ? (scope === 'ai_lead' || taskType.startsWith('ai_lead') ? 'ai_lead' : 'chat_seat')
    : (scope === 'ai_lead' ? 'ai_lead' : 'account_work');
  return {
    id: `awb-${row.id}`,
    workBatchId: Number(row.id),
    workItemId: lastItemId || 0,
    kind: 'account_work',
    name: `${actionLabel} · ${username}`,
    type: listType,
    taskType: taskType || actionKey || scope,
    typeLabel: actionLabel,
    status: String(row.status || ''),
    itemStatus: String(row.last_item_status || row.lastItemStatus || ''),
    success_count: Math.max(0, total - pending - paused),
    fail_count: 0,
    total_count: total,
    created_at: row.created_at || '',
    group_name: username,
    accountId: Number(row.account_id || 0),
    batchScope: scope,
    pending_count: pending,
    payload: {
      browserBackend: 'linux',
      browser_backend: 'linux',
      source: scope === 'cs_seat' ? 'chat.seat' : scope,
      batchScope: scope,
      seatAction: seatAction || '',
      taskType,
      lastError: row.last_error || '',
    },
    note: (() => {
      const err = String(row.last_error || row.lastError || '').trim();
      if (err) return err;
      if (pending) return `${pending} 项待执行`;
      return `${scopeLabel}${taskType ? ` · ${actionLabel}` : ''}`;
    })(),
    lastError: String(row.last_error || row.lastError || '').trim(),
  };
}

/** 工作队列状态：UI 的 queued/draft 映射为 pending 别名 */
function workStatusQuery(status) {
  const s = String(status || 'pending').trim().toLowerCase();
  if (!s || s === 'all') return '';
  if (s === 'queued' || s === 'draft') return 'pending';
  if (s === 'pending') return 'pending'; // PHP 侧展开为 pending,running,paused
  return s;
}

function mapCenterTask(row) {
  const t = String(row.type || '');
  return {
    ...row,
    id: row.id,
    kind: 'task',
    type: t,
    typeLabel: SEAT_TYPE_LABEL[t] || t || '-',
    payload: row.payload || {},
  };
}

function isAllowedCenterTask(row) {
  return CENTER_SERVER_BROWSER_TYPES.has(String(row?.type || '').trim().toLowerCase());
}

/**
 * GET /api/tasks
 * query: page, pageSize, status(pending|…), type, keyword, source(all|work|center)
 */
router.get('/api/tasks', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20) || 20));
  let status = String(req.query.status || 'pending').trim();
  if (!status) status = 'pending';
  const type = String(req.query.type || '').trim();
  const keyword = String(req.query.keyword || req.query.name || '').trim();
  const source = String(req.query.source || 'all').trim().toLowerCase(); // all | work | center
  const debug = String(req.query.debug || '') === '1';

  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }

  const token = authToken(req, user);
  const wantWork = source !== 'center';
  const wantCenter = source !== 'work';

  try {
    const fetches = [];
    const wStatus = workStatusQuery(status);

    if (wantWork) {
      // 优先 forServerBrowser（含 general 里误入的 sync_fans）；旧 API 忽略未知参数时再靠本地过滤
      const wqs = new URLSearchParams();
      wqs.set('page', String(page));
      wqs.set('pageSize', String(Math.max(pageSize, 50)));
      wqs.set('forServerBrowser', '1');
      wqs.set('batchScope', 'cs_seat,ai_lead'); // 旧版只认这个；新版 forServerBrowser 优先
      if (wStatus) wqs.set('status', wStatus);
      if (keyword) wqs.set('keyword', keyword);
      fetches.push(
        upstreamGet(base, `/account-work-batches?${wqs}`, token).then((r) => ({ key: 'work', ...r }))
      );
      // 兜底：无 scope 过滤，本地挑坐席类型（覆盖「新列表过滤 + 旧入队 general」）
      const fqs = new URLSearchParams();
      fqs.set('page', '1');
      fqs.set('pageSize', '50');
      if (wStatus) fqs.set('status', wStatus);
      if (keyword) fqs.set('keyword', keyword);
      fetches.push(
        upstreamGet(base, `/account-work-batches?${fqs}`, token).then((r) => ({ key: 'workAll', ...r }))
      );
    } else {
      fetches.push(Promise.resolve({ key: 'work', ok: true, data: { items: [], total: 0, pages: 1 } }));
      fetches.push(Promise.resolve({ key: 'workAll', ok: true, data: { items: [], total: 0, pages: 1 } }));
    }

    // 中心库只拉拓客类；坐席仅在 work 队列；publish/warm 等永不进入本页
    const skipCenter = !wantCenter || type === 'chat_seat'
      || (type && type !== 'all' && type !== 'ai_lead' && type !== 'ai_lead_dm');
    if (!skipCenter) {
      const tqs = new URLSearchParams();
      tqs.set('page', String(page));
      tqs.set('pageSize', String(pageSize));
      tqs.set('status', status);
      tqs.set('type', (type === 'ai_lead' || type === 'ai_lead_dm') ? type : CENTER_TYPE_QUERY);
      if (keyword) tqs.set('name', keyword);
      fetches.push(
        upstreamGet(base, `/tasks?${tqs}`, token).then((r) => ({ key: 'center', ...r }))
      );
    } else {
      fetches.push(Promise.resolve({ key: 'center', ok: true, data: { items: [], total: 0, pages: 1 } }));
    }

    const results = await Promise.all(fetches);
    const work = results.find((r) => r.key === 'work') || {};
    const workAll = results.find((r) => r.key === 'workAll') || {};
    const center = results.find((r) => r.key === 'center') || {};

    // 坐席队列失败不整页挂掉（中心任务仍可展示）
    if (!work.ok && !workAll.ok && wantWork && !wantCenter) {
      return res.status(work.upstream?.status >= 400 ? work.upstream.status : 502).json({
        ok: false,
        message: work.json?.message || work.json?.msg || '拉取坐席任务失败',
      });
    }
    if (!center.ok && wantCenter && !wantWork) {
      return res.status(center.upstream?.status >= 400 ? center.upstream.status : 502).json({
        ok: false,
        message: center.json?.message || center.json?.msg || '拉取中心任务失败',
      });
    }

    const workRowsScoped = work.ok ? pickUpstreamRows(work) : [];
    let workRowsAll = workAll.ok ? pickUpstreamRows(workAll) : [];
    // 列表字段缺 primary_task_type（旧 API）且 scope 过滤为空时，按分任务探测坐席类
    const needEnrich = workRowsAll.some((r) => !isSeatWorkRow(r)
      && !String(r.primary_task_type || r.primaryTaskType || '').trim());
    if (needEnrich && wantWork) {
      workRowsAll = await enrichSeatRowsFromItems(base, token, workRowsAll, 20);
    }
    const byId = new Map();
    for (const r of [...workRowsScoped, ...workRowsAll]) {
      const id = Number(r.id || 0);
      if (id > 0 && isSeatWorkRow(r)) byId.set(id, r);
    }
    const workRows = [...byId.values()];
    const centerRows = pickUpstreamRows(center);

    let workItems = workRows.map(mapWorkBatch);
    let centerItems = center.ok
      ? centerRows.filter(isAllowedCenterTask).map(mapCenterTask)
      : [];

    // 类型筛选：chat_seat → 只留坐席；ai_lead → 只留拓客
    if (type === 'chat_seat') {
      workItems = workItems.filter((x) => x.type === 'chat_seat' || x.batchScope === 'cs_seat');
      centerItems = [];
    } else if (type === 'ai_lead' || type === 'ai_lead_dm') {
      workItems = workItems.filter((x) => x.type === 'ai_lead' || x.batchScope === 'ai_lead');
      centerItems = centerItems.filter((x) => {
        const t = String(x.type || '');
        return type === 'ai_lead' ? (t === 'ai_lead' || t === 'ai_lead_dm') : t === type;
      });
    } else if (type && type !== 'all') {
      // 其它类型（publish 等）在本页一律不展示
      workItems = [];
      centerItems = [];
    }

    // 合并：坐席/拓客优先，再拼中心库任务；同页各取 pageSize 再裁切
    const merged = [...workItems, ...centerItems].slice(0, pageSize);
    const workTotal = Math.max(
      work.ok ? Number(work.data?.total || 0) : 0,
      workItems.length
    );
    // 中心库 total 按白名单过滤后的结果估算（避免把 publish 计数算进来）
    const centerDropped = Math.max(0, centerRows.length - (center.ok ? centerRows.filter(isAllowedCenterTask).length : 0));
    const centerTotalRaw = center.ok ? Number(center.data?.total || centerItems.length || 0) : 0;
    const centerTotal = Math.max(0, centerTotalRaw - centerDropped);
    const total = Math.max(workItems.length + centerItems.length, workTotal + centerTotal);
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);

    const body = {
      ok: true,
      items: merged,
      total,
      page,
      pages,
      pageSize,
      status,
      apiBase: base,
      sources: {
        work: {
          ok: !!(work.ok || workAll.ok),
          total: workItems.length,
          message: (work.ok || workAll.ok) ? '' : (work.json?.message || workAll.json?.message || ''),
        },
        center: { ok: !!center.ok, total: centerTotal, message: center.ok ? '' : (center.json?.message || '') },
      },
    };
    if (debug) {
      const dbgAccountId = Number(req.query.accountId || req.query.account_id || 0) || 0;
      body.debug = {
        userId: user?.id || 0,
        username: user?.username || '',
        workOk: !!work.ok,
        workUpstreamStatus: work.upstream?.status || 0,
        workRawTotal: Number(work.data?.total || 0),
        workRawCount: workRowsScoped.length,
        workAllOk: !!workAll.ok,
        workAllRawTotal: Number(workAll.data?.total || 0),
        workAllRawCount: workRowsAll.length,
        seatMatched: workRows.length,
        sample: workRowsAll.slice(0, 8).map((r) => ({
          id: r.id,
          scope: r.batch_scope || r.batchScope || '',
          status: r.status,
          primary_task_type: r.primary_task_type || r.primaryTaskType || '',
          seat_action: r.seat_action || r.seatAction || '',
          account_id: r.account_id,
          owner_id: r.owner_id,
          last_error: r.last_error || '',
        })),
      };
      // 顺带诊断账号环境包（部署后可直接 ?debug=1&accountId=105）
      if (dbgAccountId > 0) {
        try {
          const packs = await upstreamGet(base, `/node/accounts/${dbgAccountId}/env-packs`, token);
          body.debug.envPacks = packs.ok ? packs.data : { error: packs.json?.message || 'env-packs 查询失败' };
        } catch (e) {
          body.debug.envPacks = { error: e.message || String(e) };
        }
      }
    }
    res.json(body);
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e.message || '无法连接中心 API',
    });
  }
});

/**
 * POST /api/tasks/:id/action
 * body: { action: pause|resume|reset|fail, kind?: account_work|task }
 * awb-* → 矩阵总任务；纯数字且 kind=task → 中心库；默认按矩阵。
 */
router.post('/api/tasks/:id/action', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const action = String(req.body?.action || req.query.action || '').trim().toLowerCase();
  const allowed = new Set(['pause', 'resume', 'reset', 'retry', 'fail', 'force-fail']);
  if (!allowed.has(action)) {
    return res.status(400).json({ ok: false, message: '不支持的操作' });
  }
  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }
  const token = authToken(req, user);
  const raw = String(req.params.id || '').trim();
  const hintKind = String(req.body?.kind || req.query.kind || '').trim().toLowerCase();
  const target = parseTaskTarget(raw);
  // awb-* 或 kind=account_work → 矩阵；kind=task → 中心库；缺省矩阵（坐席主路径）
  const useCenter = !/^awb-/i.test(raw) && (hintKind === 'task' || hintKind === 'center');

  try {
    let path = '';
    let body = {};
    if (useCenter) {
      const taskId = target.taskId || Number(raw) || 0;
      if (taskId < 1) return res.status(400).json({ ok: false, message: '无效任务 ID' });
      if (action === 'pause') path = `/tasks/${taskId}/pause`;
      else if (action === 'resume') path = `/tasks/${taskId}/start`;
      else if (action === 'reset' || action === 'retry') path = `/tasks/${taskId}/retry`;
      else return res.status(400).json({ ok: false, message: '中心库任务不支持强制失败，请用重试' });
    } else {
      const batchId = /^awb-/i.test(raw)
        ? (Number(String(raw).replace(/^awb-/i, '')) || 0)
        : (target.batchId || Number(raw) || 0);
      if (batchId < 1) return res.status(400).json({ ok: false, message: '无效总任务 ID' });
      if (action === 'pause') path = `/account-work-batches/${batchId}/pause`;
      else if (action === 'resume') path = `/account-work-batches/${batchId}/resume`;
      else if (action === 'reset' || action === 'retry') path = `/account-work-batches/${batchId}/reset`;
      else if (action === 'fail' || action === 'force-fail') {
        path = `/account-work-batches/${batchId}/force-fail`;
        body = { errorMessage: String(req.body?.errorMessage || req.body?.reason || '服务器浏览器手动强制失败') };
      }
    }

    const r = await upstreamPost(base, path, token, body);
    if (!r.ok) {
      return res.status(r.upstream?.status >= 400 ? r.upstream.status : 502).json({
        ok: false,
        message: r.json?.message || r.json?.msg || '操作失败',
      });
    }

    // 本进程内置队列：重试入队 / 强制关停（不再转发同机 tkswarm-node）
    let workerKick = null;
    if (!useCenter) {
      const batchId = /^awb-/i.test(raw)
        ? (Number(String(raw).replace(/^awb-/i, '')) || 0)
        : (target.batchId || Number(raw) || 0);
      if (batchId > 0) {
        try {
          if (action === 'reset' || action === 'retry' || action === 'resume') {
            if (token) process.env.TKSWARM_API_TOKEN = token;
            const out = await worker.kickBatch(batchId);
            await worker.fillSlots().catch(() => {});
            workerKick = { ok: true, data: out };
          } else if (action === 'fail' || action === 'force-fail') {
            const out = await worker.forceStop(
              batchId,
              body.errorMessage || '服务器浏览器手动强制失败',
            );
            workerKick = { ok: true, data: out };
          }
        } catch (e) {
          workerKick = { ok: false, message: e.message || '本机执行器失败' };
        }
      }
    }

    const kicked = workerKick?.ok;
    let message = r.json?.message || '操作成功';
    if (kicked && (action === 'reset' || action === 'retry' || action === 'resume')) {
      message = `${message}，已进入本机执行队列（最多 3 路）`;
    } else if (kicked && (action === 'fail' || action === 'force-fail')) {
      message = `${message}，已强制关停`;
    } else if (workerKick && !kicked && workerKick.message) {
      message = `${message}（执行器：${workerKick.message}）`;
    }
    return res.json({
      ok: true,
      action,
      message,
      data: r.data,
      workerKick,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message || '无法连接中心 API' });
  }
});

/**
 * GET /api/executor-queue
 * 本机内置执行队列状态（最多 3 路）
 */
router.get('/api/executor-queue', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const token = authToken(req, user);
    if (token) process.env.TKSWARM_API_TOKEN = token;
    const data = worker.stats();
    return res.json({
      ok: data.ok !== false,
      message: data.message || '',
      ...data,
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message || '执行队列不可用' });
  }
});

/**
 * GET /api/debug/env-packs?accountId=105
 * 诊断：账号绑定 vs 中心库是否真有可下载环境包（澄清「API 项目里有包」误解）
 */
router.get('/api/debug/env-packs', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const accountId = Number(req.query.accountId || req.query.account_id || 0) || 0;
  if (accountId < 1) {
    return res.status(400).json({ ok: false, message: '请传 accountId' });
  }
  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址' });
  }
  const token = authToken(req, user);
  try {
    const bundle = await upstreamGet(base, `/node/accounts/${accountId}/bundle`, token);
    const packs = await upstreamGet(base, `/node/accounts/${accountId}/env-packs`, token);
    const b = bundle.ok ? (bundle.data || {}) : {};
    const ids = [];
    const push = (v) => {
      const s = String(v || '').trim();
      if (s && !ids.includes(s)) ids.push(s);
    };
    push(b.linux_browser_profile_id);
    push(b.tkswarm_browser_profile_id);
    push(b.browser_profile_id);
    const lists = b.env_profile_ids || {};
    for (const x of [...(lists.linux || []), ...(lists.tkswarm || [])]) push(x);

    const metas = [];
    for (const pid of ids) {
      const m = await upstreamGet(base, `/node/browser-profiles/${encodeURIComponent(pid)}/pack-meta`, token);
      const d = m.ok ? (m.data || {}) : { error: m.json?.message || '查询失败', profileId: pid };
      metas.push({
        profileId: pid,
        exists: !!d.exists,
        hasPack: !!d.hasPack,
        packFileExists: !!d.packFileExists,
        packBytes: Number(d.packBytes || 0),
        packRevision: Number(d.packRevision || 0),
        browserBackend: d.browserBackend || '',
        reason: d.reason || d.error || '',
        packPath: d.packPath || '',
      });
    }

    const packable = packs.ok ? (packs.data?.packable || []) : [];
    const all = packs.ok ? (packs.data?.all || []) : [];
    const storageDir = packs.ok ? (packs.data?.storageDir || '') : '';

    return res.json({
      ok: true,
      accountId,
      apiBase: base,
      bindings: {
        linux: b.linux_browser_profile_id || '',
        tkswarm: b.tkswarm_browser_profile_id || '',
        primary: b.browser_profile_id || '',
        backend: b.browser_backend || '',
      },
      candidateMetas: metas,
      packableCount: packable.length,
      packable,
      allEnvs: all,
      storageDir,
      verdict: packable.length > 0
        ? '中心库有可拉包；若仍报 no-cloud-pack，请更新 Node（env-packs 兜底）后重试'
        : '中心库对当前绑定没有可下载包：账号绑定了 profileId，但 pack 文件未上传或 API 机磁盘上不存在。桌面打开该环境并关闭一次以首传；不要把「账号已绑环境」当成「已有跨机包」。',
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message || '诊断失败' });
  }
});

/**
 * POST /api/tasks/:id/logs/clear
 * 清空中心库该总任务（或指定分任务）的执行日志
 */
router.post('/api/tasks/:id/logs/clear', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const raw = String(req.params.id || '').trim();
  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }
  const token = authToken(req, user);
  let batchId = 0;
  if (/^awb-/i.test(raw)) {
    batchId = Number(String(raw).replace(/^awb-/i, '')) || 0;
  } else if (/^\d+$/.test(raw)) {
    batchId = Number(raw) || 0;
  }
  if (batchId < 1) {
    return res.status(400).json({ ok: false, message: '无效总任务 ID（仅支持矩阵任务清空日志）' });
  }
  const itemId = Number(req.body?.itemId || req.query?.itemId || 0) || 0;
  try {
    const r = await upstreamPost(base, `/account-work-batches/${batchId}/logs/clear`, token, {
      itemId,
    });
    if (!r.ok) {
      return res.status(r.upstream?.status >= 400 ? r.upstream.status : 502).json({
        ok: false,
        message: r.json?.message || r.json?.msg || '清空日志失败',
      });
    }
    return res.json({
      ok: true,
      message: r.json?.message || '日志已清空',
      batchId,
      itemId,
      deleted: Number(r.data?.deleted || 0),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message || '清空日志失败' });
  }
});

/**
 * GET /api/tasks/:id/logs
 * id: awb-123 | 123（矩阵总任务）或中心库任务数字 ID
 * 实时日志来自中心库 account_work_logs / 任务事件；本服务不做落库。
 */
router.get('/api/tasks/:id/logs', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const raw = String(req.params.id || '').trim();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || req.query.pageSize || 200) || 200));
  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }
  const token = authToken(req, user);

  let batchId = 0;
  let itemId = Number(req.query.itemId || 0) || 0;
  if (/^awb-/i.test(raw)) {
    batchId = Number(String(raw).replace(/^awb-/i, '')) || 0;
  } else if (/^\d+$/.test(raw)) {
    batchId = Number(raw) || 0;
  }

  try {
    if (batchId > 0) {
      const path = itemId > 0
        ? `/account-work-batches/${batchId}/items/${itemId}/logs?pageSize=${limit}`
        : `/account-work-batches/${batchId}/logs?pageSize=${limit}`;
      const r = await upstreamGet(base, path, token);
      if (!r.ok) {
        return res.status(r.upstream?.status >= 400 ? r.upstream.status : 502).json({
          ok: false,
          message: r.json?.message || r.json?.msg || '拉取任务日志失败',
        });
      }
      const items = Array.isArray(r.data?.items) ? r.data.items : (Array.isArray(r.data?.list) ? r.data.list : []);
      return res.json({
        ok: true,
        kind: 'account_work',
        batchId,
        itemId: itemId || Number(r.data?.itemId || 0) || 0,
        items: items.map((row) => ({
          id: row.id,
          level: row.level || 'info',
          message: row.message || '',
          created_at: row.created_at || row.createdAt || '',
          itemId: Number(row.item_id || row.itemId || 0),
          meta: row.meta || {},
        })),
        total: Number(r.data?.total || items.length || 0),
      });
    }

    // 中心库任务：事件流
    const taskId = Number(raw) || 0;
    if (taskId > 0) {
      const r = await upstreamGet(base, `/tasks/${taskId}/events?pageSize=${limit}`, token);
      if (!r.ok) {
        return res.status(r.upstream?.status >= 400 ? r.upstream.status : 502).json({
          ok: false,
          message: r.json?.message || r.json?.msg || '拉取任务事件失败',
        });
      }
      const items = Array.isArray(r.data?.items) ? r.data.items : (Array.isArray(r.data?.list) ? r.data.list : []);
      return res.json({
        ok: true,
        kind: 'task',
        batchId: 0,
        itemId: 0,
        taskId,
        items: items.map((row) => ({
          id: row.id,
          level: row.level || row.type || 'info',
          message: row.message || row.content || '',
          created_at: row.created_at || row.createdAt || '',
          itemId: 0,
          meta: row.meta || {},
        })),
        total: Number(r.data?.total || items.length || 0),
      });
    }

    return res.status(400).json({ ok: false, message: '无效任务 ID' });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message || '无法连接中心 API' });
  }
});

module.exports = router;
