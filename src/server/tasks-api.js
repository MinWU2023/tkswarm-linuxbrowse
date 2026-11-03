/**
 * 待执行任务列表 API（代理中心库 /api/tasks，供控制台 /tasks 分页展示）
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

/**
 * GET /api/tasks
 * query: page, pageSize, status(pending|queued|draft|running|paused|逗号多值), type, keyword
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

  const base = apiBase();
  if (!base) {
    return res.json({ ok: false, message: '未配置中心 API 地址（TKSWARM_API_BASE）' });
  }

  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  qs.set('status', status);
  if (type) qs.set('type', type);
  if (keyword) qs.set('name', keyword);

  const token = req.authToken || user.token || extractBearer(req) || '';
  try {
    const upstream = await fetch(`${base}/tasks?${qs.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const json = await upstream.json().catch(() => ({}));
    const ok = json.success === true || json.code === 0 || json.code === 200 || upstream.ok;
    if (!upstream.ok || !ok) {
      return res.status(upstream.status >= 400 ? upstream.status : 502).json({
        ok: false,
        message: json.message || json.msg || `拉取任务失败（HTTP ${upstream.status}）`,
      });
    }
    const data = json.data || json;
    const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.list) ? data.list : []);
    res.json({
      ok: true,
      items,
      total: Number(data.total || items.length || 0),
      page: Number(data.page || page),
      pages: Number(data.pages || 1),
      pageSize: Number(data.pageSize || pageSize),
      status,
      apiBase: base,
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e.message || '无法连接中心 API',
    });
  }
});

module.exports = router;
