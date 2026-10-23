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

module.exports = {
  validateTokenRemote,
  assertTokenAlive,
  sweepInvalidSessions,
  startTokenGuard,
  invalidateCache,
};
