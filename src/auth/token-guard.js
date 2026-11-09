/**
 * 与 PHP 同步校验会话 Token；失效则踢本地 session。
 */
const db = require('../db');
const { readSettings } = require('../settings');
const {
  TKSWARM_API_BASE,
  TOKEN_VALIDATE_TTL_MS,
  TOKEN_VALIDATE_INTERVAL_MS,
} = require('../config');

/** @type {Map<string, { ok: boolean, at: number, reason?: string }>} */
const cache = new Map();

function apiBase() {
  const s = readSettings();
  return String(s.apiBase || process.env.TKSWARM_API_BASE || TKSWARM_API_BASE).replace(/\/+$/, '');
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateTokenRemote(token) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, reason: 'empty' };

  // 服务级 DEFAULT token 不向 PHP 校验
  const { DEFAULT_API_TOKEN } = require('../config');
  if (DEFAULT_API_TOKEN && t === DEFAULT_API_TOKEN) {
    return { ok: true };
  }

  const now = Date.now();
  const hit = cache.get(t);
  if (hit && now - hit.at < TOKEN_VALIDATE_TTL_MS) {
    return { ok: hit.ok, reason: hit.reason };
  }

  try {
    const res = await fetch(`${apiBase()}/auth/status`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    const ok = res.ok && (json.success === true || json.code === 0 || json.code === 200
      || json.ok === true || json.data?.user || json.user);
    // 部分实现：未登录返回 401 / success:false
    const denied = res.status === 401 || res.status === 403
      || json.success === false
      || (json.message && /未登录|token|失效|过期|unauthorized/i.test(String(json.message)));
    const body = json.data || json;
    const remoteUser = body?.user || body?.loginUser || null;
    if (ok && !denied && remoteUser && Number(remoteUser.id) > 0) {
      try {
        db.saveUser({
          id: Number(remoteUser.id),
          username: remoteUser.username,
          nickname: remoteUser.nickname,
          role_name: remoteUser.role || remoteUser.roleName || remoteUser.role_name,
          is_super: remoteUser.isSuper || Number(remoteUser.role_id) === 1 ? 1 : 0,
          browser_env_quota: remoteUser.browserEnvQuota ?? remoteUser.browser_env_quota,
          browser_env_used: remoteUser.browserEnvUsed ?? remoteUser.browser_env_used,
          preserveLoginTime: true,
        });
      } catch { /* ignore */ }
    }
    const result = (!ok || denied)
      ? { ok: false, reason: json.message || `HTTP ${res.status}` }
      : { ok: true };
    cache.set(t, { ...result, at: now });
    return result;
  } catch (e) {
    // 网络故障时不踢会话，避免 PHP 短暂不可用导致全挂
    return { ok: true, reason: 'skip_network_error' };
  }
}

async function assertTokenAlive(token) {
  const r = await validateTokenRemote(token);
  if (!r.ok && r.reason !== 'skip_network_error') {
    db.logoutToken(token);
    cache.delete(String(token || ''));
    return false;
  }
  return true;
}

/** 扫描全部本地会话，踢失效 Token */
async function sweepInvalidSessions() {
  const sessions = db.listSessionsDetailed?.() || [];
  let kicked = 0;
  for (const s of sessions) {
    const token = s.token;
    if (!token) continue;
    const alive = await assertTokenAlive(token);
    if (!alive) kicked += 1;
  }
  return { checked: sessions.length, kicked };
}

function startTokenGuard() {
  const tick = () => {
    sweepInvalidSessions().then((r) => {
      if (r.kicked > 0) {
        console.log(`[token-guard] swept sessions: checked=${r.checked} kicked=${r.kicked}`);
      }
    }).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, TOKEN_VALIDATE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function invalidateCache(token) {
  if (token) cache.delete(String(token));
  else cache.clear();
}

/**
 * 把「本机 sessions 不认识、但对 PHP 仍有效」的 Bearer 登记为本地会话。
 * 场景：B 只登录了 Node，Node 带着 B 的 Token 调 Linux 浏览器；
 * A 已在本机建好环境。采纳后 B 也能按共用规则打开 A 的环境。
 *
 * @returns {Promise<{ user: object, token: string }|null>}
 */
async function adoptRemoteToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (db.getUserByToken(t)) {
    return { user: db.getUserByToken(t), token: t };
  }
  const remote = await validateTokenRemote(t);
  if (!remote.ok) return null;

  try {
    const res = await fetch(`${apiBase()}/auth/status`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    const body = json.data || json;
    const user = body.user || body;
    const id = Number(user?.id || user?.userId || 0);
    if (!res.ok || id < 1) return null;
    const role = user.role || user.roleName || user.role_name || '';
    const isSuper = user.isSuper || user.is_super || Number(user.role_id) === 1 || role === '超级管理员';
    db.saveUser({
      id,
      username: user.username || `user-${id}`,
      nickname: user.nickname || '',
      token: t,
      role_name: role,
      is_super: isSuper ? 1 : 0,
      parent_id: 0,
      browser_env_quota: user.browserEnvQuota ?? user.browser_env_quota,
      browser_env_used: user.browserEnvUsed ?? user.browser_env_used,
    });
    db.upsertSession({ token: t, userId: id });
    cache.set(t, { ok: true, at: Date.now() });
    const local = db.getUserByToken(t);
    return local ? { user: local, token: t } : null;
  } catch {
    return null;
  }
}

module.exports = {
  validateTokenRemote,
  assertTokenAlive,
  sweepInvalidSessions,
  startTokenGuard,
  invalidateCache,
  adoptRemoteToken,
};
