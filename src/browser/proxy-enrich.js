/**
 * 开窗前从中心 API 拉取绑定账号的代理账密，写入本地 profile。
 * 与 tkswarm-browses 同源：A 建环境绑代理、B 登录同机打开时必须能补全 SOCKS 账密。
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { getApiToken, readSettings } = require('../settings');
const { TKSWARM_API_BASE, DATA_ROOT } = require('../config');

function apiBase() {
  const s = readSettings();
  const base = String(s.apiBase || TKSWARM_API_BASE || '').trim().replace(/\/+$/, '');
  return base || String(TKSWARM_API_BASE || '').replace(/\/+$/, '');
}

/**
 * 候选 Token（按优先级去重）
 *   1) 环境创建者（owner_id）自己的 Token
 *   2) 当前最近登录用户的 Token
 *   3) settings 里的 apiToken
 *   4) 本机仍保留的其它会话 Token
 */
function authTokens(profile) {
  const out = [];
  const push = (t) => {
    const v = String(t || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const ownerId = Number(profile?.owner_id || 0);
  if (ownerId > 0) {
    try {
      const users = typeof db.listUsersDetailed === 'function'
        ? db.listUsersDetailed()
        : [];
      const owner = users.find((u) => Number(u.id) === ownerId);
      push(owner && owner.token);
    } catch { /* ignore */ }
  }
  try {
    const cur = db.getCurrentUser();
    push(cur && cur.token);
  } catch { /* ignore */ }
  push(getApiToken());
  try {
    for (const t of (db.listSessionTokens?.() || [])) push(t);
  } catch { /* ignore */ }
  return out;
}

function appendLog(profileId, message) {
  const line = `[${new Date().toISOString()}] [proxy-enrich] ${message}`;
  try { console.log(line); } catch { /* */ }
  try {
    const dir = path.join(DATA_ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `env-${profileId}.log`), `${line}\n`);
  } catch { /* */ }
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || json.msg || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const ok = json.success === true || json.code === 0 || json.code === 200;
  if (!ok && json.success !== undefined) {
    throw new Error(json.message || json.msg || 'API 返回失败');
  }
  return json.data !== undefined ? json.data : json;
}

async function fetchProfileProxyBundle(profileId, profile = null) {
  const tokens = authTokens(profile);
  if (!tokens.length) return null;
  const url = `${apiBase()}/node/browser-profiles/${encodeURIComponent(profileId)}/proxy-bundle`;
  let lastError = null;
  for (const token of tokens) {
    try {
      return await fetchJson(url, token);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '');
      if (!/401|403|未登录|Login out|token\s*(无效|失效|过期|invalid|expire)|鉴权|无权/i.test(msg)) break;
    }
  }
  if (lastError) {
    appendLog(profileId, `API 拉取代理失败: ${lastError?.message || lastError}`);
  }
  return null;
}

function proxyNeedsEnrich(profile) {
  if (!profile?.proxy_host || !profile?.proxy_port) return true;
  const user = String(profile.proxy_user || '').trim();
  const pass = String(profile.proxy_pass || '');
  return !user || !pass;
}

/**
 * @param {object} profile
 * @returns {Promise<object>}
 */
async function enrichProfileProxyFromApi(profile) {
  if (!profile?.id) return profile;
  if (!authTokens(profile).length) {
    if (proxyNeedsEnrich(profile)) {
      appendLog(profile.id, '未登录中心 API，无法拉取代理账密（请先在 Linux 浏览器控制台登录）');
    }
    return profile;
  }

  const bundle = await fetchProfileProxyBundle(profile.id, profile);
  if (!bundle?.hasProxy) {
    if (proxyNeedsEnrich(profile) && profile.proxy_host) {
      appendLog(profile.id, '中心库未找到该环境绑定账号的代理，或账号未绑代理');
    }
    return profile;
  }

  const nextUser = String(bundle.username || '').trim();
  const nextPass = String(bundle.password || '');
  const sameEndpoint = String(profile.proxy_host || '') === String(bundle.host || '')
    && Number(profile.proxy_port || 0) === Number(bundle.port || 0);
  const sameCreds = String(profile.proxy_user || '').trim() === nextUser
    && String(profile.proxy_pass || '') === nextPass;

  if (sameEndpoint && sameCreds && !proxyNeedsEnrich(profile)) {
    return profile;
  }

  db.updateProfileProxy(profile.id, {
    proxyType: bundle.protocol || profile.proxy_type || 'socks5',
    host: bundle.host,
    port: bundle.port,
    proxyUserName: nextUser,
    proxyPassword: nextPass,
    proxyId: bundle.proxy_id,
  });
  appendLog(
    profile.id,
    `已从中心 API 同步代理 ${bundle.protocol}://${bundle.host}:${bundle.port}`
    + `（user=${nextUser ? '有' : '无'} pass=${nextPass ? '有' : '无'} account=#${bundle.account_id || '?'})`,
  );
  return db.getProfile(profile.id) || profile;
}

module.exports = {
  enrichProfileProxyFromApi,
  fetchProfileProxyBundle,
  proxyNeedsEnrich,
};
