const db = require('../db');
const { TKSWARM_API_BASE } = require('../config');
const { writeSettings } = require('../settings');

async function login({ apiBase, username, password, captcha, captchaKey }) {
  const base = String(apiBase || TKSWARM_API_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password, captcha, captchaKey }),
  });
  const json = await res.json().catch(() => ({}));
  const ok = json.success === true || json.code === 0 || json.code === 200;
  if (!res.ok || !ok) {
    throw new Error(json.message || json.msg || '登录失败');
  }
  const data = json.data || json;
  const token = data.token || data.accessToken || '';
  const user = data.user || {};
  const role = user.role || user.roleName || (Number(user.role_id) === 1 ? '超级管理员' : 'user');
  const saved = db.saveUser({
    id: Number(user.id || 0),
    username: user.username || username,
    nickname: user.nickname || '',
    token,
    role_name: role,
    is_super: user.isSuper || user.roleId === 1 ? 1 : 0,
    parent_id: 0,
  });
  if (token) {
    db.upsertSession({ token, userId: saved.id });
    // 仅更新默认 apiBase，不覆盖其他账号的 token
    writeSettings({ apiBase: base });
    fetch(`${base}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tkswarmBrowserApiToken: token }),
    }).catch(() => {});
  }
  return { token, user: db.getUserByToken(token) || saved };
}

/** 只退出指定 token，不影响其他并发账号 */
function logout(token) {
  if (token) {
    db.logoutToken(token);
    return;
  }
  // 无 token 时兼容旧行为：清最近用户的会话
  const u = db.getCurrentUser();
  if (u?.token) db.logoutToken(u.token);
}

async function fetchChildrenStats(user) {
  if (!user?.token) return [];
  const base = String(process.env.TKSWARM_API_BASE || TKSWARM_API_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/auth/status`, {
      headers: { Authorization: `Bearer ${user.token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    const body = json.data || json;
    const children = body.children || [];
    return children.map((c) => ({
      id: c.id,
      username: c.username,
      nickname: c.nickname || c.username,
      ...db.statsForOwner(c.id),
    }));
  } catch {
    return [];
  }
}

module.exports = { login, logout, fetchChildrenStats };
