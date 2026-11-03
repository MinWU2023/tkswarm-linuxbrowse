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

function mapWorkBatch(row) {
  const scope = String(row.batch_scope || row.batchScope || 'general');
  const pending = Number(row.pending_count || 0);
  const paused = Number(row.paused_count || 0);
  const total = Number(row.item_total || row.item_count || 0);
  const username = row.username || `#${row.account_id || ''}`;
  const scopeLabel = scope === 'cs_seat' ? '客服坐席' : (scope === 'ai_lead' ? 'AI 拓客' : '矩阵任务');
  return {
    id: `awb-${row.id}`,
    workBatchId: Number(row.id),
    kind: 'account_work',
    name: `${scopeLabel} · ${username}`,
    type: scope === 'cs_seat' ? 'chat_seat' : (scope === 'ai_lead' ? 'ai_lead' : 'account_work'),
    typeLabel: scopeLabel,
    status: String(row.status || ''),
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
      lastError: row.last_error || '',
    },
    note: pending ? `${pending} 项待执行` : (row.last_error || SEAT_TYPE_LABEL[scope] || ''),
  };
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

  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }

  const token = authToken(req, user);
  const wantWork = source !== 'center';
  const wantCenter = source !== 'work';

  try {
    const fetches = [];

    if (wantWork) {
      const wqs = new URLSearchParams();
      wqs.set('page', String(page));
      wqs.set('pageSize', String(pageSize));
      wqs.set('batchScope', 'cs_seat,ai_lead');
      wqs.set('status', status);
      if (keyword) wqs.set('keyword', keyword);
      fetches.push(
        upstreamGet(base, `/account-work-batches?${wqs}`, token).then((r) => ({ key: 'work', ...r }))
      );
    } else {
      fetches.push(Promise.resolve({ key: 'work', ok: true, data: { items: [], total: 0, pages: 1 } }));
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
    const center = results.find((r) => r.key === 'center') || {};

    // 坐席队列失败不整页挂掉（中心任务仍可展示）
    if (!work.ok && wantWork && !wantCenter) {
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

    const workRows = Array.isArray(work.data?.items)
      ? work.data.items
      : (Array.isArray(work.data?.list) ? work.data.list : []);
    const centerRows = Array.isArray(center.data?.items)
      ? center.data.items
      : (Array.isArray(center.data?.list) ? center.data.list : []);

    let workItems = work.ok
      ? workRows
        .filter((r) => {
          const scope = String(r.batch_scope || r.batchScope || '');
          return scope === 'cs_seat' || scope === 'ai_lead';
        })
        .map(mapWorkBatch)
      : [];
    let centerItems = center.ok
      ? centerRows.filter(isAllowedCenterTask).map(mapCenterTask)
      : [];

    // 类型筛选：chat_seat → 只留 cs_seat；ai_lead → 只留拓客
    if (type === 'chat_seat') {
      workItems = workItems.filter((x) => x.batchScope === 'cs_seat');
      centerItems = [];
    } else if (type === 'ai_lead' || type === 'ai_lead_dm') {
      workItems = workItems.filter((x) => x.batchScope === 'ai_lead');
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
    const workTotal = work.ok ? Number(work.data?.total || workItems.length || 0) : 0;
    // 中心库 total 按白名单过滤后的结果估算（避免把 publish 计数算进来）
    const centerDropped = Math.max(0, centerRows.length - (center.ok ? centerRows.filter(isAllowedCenterTask).length : 0));
    const centerTotalRaw = center.ok ? Number(center.data?.total || centerItems.length || 0) : 0;
    const centerTotal = Math.max(0, centerTotalRaw - centerDropped);
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);

    res.json({
      ok: true,
      items: merged,
      total,
      page,
      pages,
      pageSize,
      status,
      apiBase: base,
      sources: {
        work: { ok: !!work.ok, total: workTotal, message: work.ok ? '' : (work.json?.message || '') },
        center: { ok: !!center.ok, total: centerTotal, message: center.ok ? '' : (center.json?.message || '') },
      },
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e.message || '无法连接中心 API',
    });
  }
});

module.exports = router;
