/**
 * 多账号并发会话：多个 TkSwarm 用户可同时登录本服务。
 * Node / Web 通过 Bearer Token 识别「当前操作者」；
 * 默认环境共用（owner_id 只计创建额度），见 bit-api.assertProfileOwner。
 */
const fs = require('node:fs');
const { DB_PATH, DEFAULT_API_TOKEN } = require('../config');

const DEFAULT = { users: [], profiles: [], sessions: [], groups: [] };

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return { ...DEFAULT, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
    }
  } catch { /* reset */ }
  return { ...DEFAULT };
}

function save(data) {
  fs.mkdirSync(require('node:path').dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function withStore(fn) {
  const data = load();
  const out = fn(data);
  save(data);
  return out;
}

function readOnly(fn) {
  return fn(load());
}

function upsertUser(user) {
  return withStore((data) => {
    const idx = data.users.findIndex((u) => Number(u.id) === Number(user.id));
    const prev = idx >= 0 ? data.users[idx] : {};
    const rawQuota = user.browser_env_quota ?? user.browserEnvQuota ?? prev.browser_env_quota;
    const rawUsed = user.browser_env_used ?? user.browserEnvUsed ?? prev.browser_env_used;
    const row = {
      id: Number(user.id),
      username: user.username ?? prev.username ?? '',
      nickname: user.nickname ?? prev.nickname ?? '',
      token: user.token ?? prev.token ?? '',
      role_name: user.role_name ?? prev.role_name ?? '',
      is_super: (user.is_super !== undefined ? user.is_super : prev.is_super) ? 1 : 0,
      parent_id: Number(user.parent_id ?? prev.parent_id ?? 0),
      browser_env_quota: rawQuota !== undefined && rawQuota !== null && Number.isFinite(Number(rawQuota))
        ? Math.max(0, Math.floor(Number(rawQuota)))
        : undefined,
      browser_env_used: rawUsed !== undefined && rawUsed !== null && Number.isFinite(Number(rawUsed))
        ? Math.max(0, Math.floor(Number(rawUsed)))
        : undefined,
      logged_in_at: user.preserveLoginTime && prev.logged_in_at ? prev.logged_in_at : new Date().toISOString(),
    };
    if (idx >= 0) data.users[idx] = { ...data.users[idx], ...row };
    else data.users.push(row);
    return { ...row };
  });
}

/** 写入/刷新会话（不踢掉其他账号） */
function upsertSession({ token, userId }) {
  const t = String(token || '').trim();
  if (!t) return null;
  return withStore((data) => {
    if (!Array.isArray(data.sessions)) data.sessions = [];
    const now = new Date().toISOString();
    const idx = data.sessions.findIndex((s) => s.token === t);
    const row = {
      token: t,
      user_id: Number(userId || 0),
      created_at: idx >= 0 ? (data.sessions[idx].created_at || now) : now,
      last_seen_at: now,
    };
    if (idx >= 0) data.sessions[idx] = row;
    else data.sessions.push(row);
    // 同步用户行上的 token，便于按用户查
    const u = data.users.find((x) => Number(x.id) === Number(userId));
    if (u) u.token = t;
    return { ...row };
  });
}

function touchSession(token) {
  const t = String(token || '').trim();
  if (!t) return;
  withStore((data) => {
    const s = (data.sessions || []).find((x) => x.token === t);
    if (s) s.last_seen_at = new Date().toISOString();
  });
}

function removeSession(token) {
  const t = String(token || '').trim();
  if (!t) return;
  withStore((data) => {
    data.sessions = (data.sessions || []).filter((s) => s.token !== t);
    for (const u of data.users) {
      if (u.token === t) u.token = '';
    }
  });
}

/** 仅清当前 token 对应会话，保留其他账号 */
function logoutToken(token) {
  removeSession(token);
}

function getUserById(id) {
  return readOnly((d) => d.users.find((u) => Number(u.id) === Number(id)) || null);
}

/**
 * 按 Bearer Token 解析用户。支持：
 * - 用户登录后的 JWT/会话 token
 * - 环境变量 DEFAULT_API_TOKEN（映射到最近登录的超管，或任意最近用户）
 */
function getUserByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return readOnly((d) => {
    // 1) sessions 表
    const sess = (d.sessions || []).find((s) => s.token === t);
    if (sess) {
      const u = d.users.find((x) => Number(x.id) === Number(sess.user_id));
      if (u) return { ...u, token: t };
    }
    // 2) 用户行上的 token
    const byUser = d.users.find((u) => u.token && u.token === t);
    if (byUser) return { ...byUser };
    // 3) 全局服务 Token
    if (DEFAULT_API_TOKEN && t === DEFAULT_API_TOKEN) {
      const supers = d.users.filter((u) => Number(u.is_super) === 1);
      const pick = supers[0] || [...d.users].sort((a, b) =>
        String(b.logged_in_at || '').localeCompare(String(a.logged_in_at || ''))
      )[0];
      if (pick) return { ...pick, token: t, is_service_token: true };
    }
    return null;
  });
}

/** 兼容旧「最近登录用户」语义 */
function getCurrentUser() {
  return readOnly((d) => {
    if (!d.users.length) return null;
    return [...d.users].sort((a, b) => String(b.logged_in_at || '').localeCompare(String(a.logged_in_at || '')))[0];
  });
}

function listSessions() {
  return readOnly((d) => {
    const sessions = d.sessions || [];
    return sessions.map((s) => {
      const u = d.users.find((x) => Number(x.id) === Number(s.user_id));
      return {
        userId: Number(s.user_id),
        username: u?.username || '',
        nickname: u?.nickname || '',
        role: u?.role_name || '',
        isSuper: Number(u?.is_super) === 1,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        tokenHint: String(s.token || '').slice(0, 8) + '…',
      };
    });
  });
}

/** 含完整 token，仅供服务端 sweep 使用 */
function listSessionsDetailed() {
  return readOnly((d) => (d.sessions || []).map((s) => ({ ...s })));
}

function countActiveSessions() {
  return readOnly((d) => (d.sessions || []).length);
}

function listUsers() {
  return readOnly((d) => (d.users || []).map((u) => ({
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role_name,
    isSuper: Number(u.is_super) === 1,
    loggedInAt: u.logged_in_at,
    hasToken: !!u.token,
  })));
}

/** 含 token 的用户行（仅服务端内部：proxy-enrich 等） */
function listUsersDetailed() {
  return readOnly((d) => [...(d.users || [])].sort(
    (a, b) => String(b.logged_in_at || '').localeCompare(String(a.logged_in_at || ''))
  ));
}

/** 本机仍保留的会话 Token（最近 8 个），开窗拉代理账密时兜底 */
function listSessionTokens() {
  return readOnly((d) => (Array.isArray(d.sessions) ? d.sessions : [])
    .map((s) => String(s && s.token ? s.token : '').trim())
    .filter(Boolean)
    .slice(0, 8));
}

function validateApiToken(token) {
  return !!getUserByToken(token);
}

module.exports = {
  upsertUser,
  upsertSession,
  touchSession,
  removeSession,
  logoutToken,
  getUserById,
  getUserByToken,
  getCurrentUser,
  listSessions,
  listSessionsDetailed,
  countActiveSessions,
  listUsers,
  listUsersDetailed,
  listSessionTokens,
  validateApiToken,
};
