const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const { DB_PATH, PROFILES_DIR, MAX_ENVS_PER_USER } = require('../config');

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
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

function countProfilesByOwner(ownerId) {
  return readOnly((d) => d.profiles.filter((p) => Number(p.owner_id) === Number(ownerId)).length);
}

function assertCanCreateProfile(ownerId) {
  const n = countProfilesByOwner(ownerId);
  if (n >= MAX_ENVS_PER_USER) {
    throw new Error(`每个账号最多 ${MAX_ENVS_PER_USER} 个浏览器环境，当前已用 ${n} 个`);
  }
}

function nextSeq(data) {
  const max = data.profiles.reduce((m, p) => Math.max(m, Number(p.seq || 0)), 0);
  return max + 1;
}

function ensureDefaultGroup(data, ownerId = 0) {
  if (!Array.isArray(data.groups)) data.groups = [];
  let g = data.groups.find((x) => x.id === 'default');
  if (!g) {
    g = {
      id: 'default',
      name: '默认分组',
      sort: 0,
      owner_id: Number(ownerId || 0),
      created_at: new Date().toISOString(),
    };
    data.groups.push(g);
  }
  return g;
}

function createProfile(row) {
  return withStore((data) => {
    assertCanCreateProfile(row.owner_id);
    ensureDefaultGroup(data, row.owner_id);
    const id = row.id || uuidv4().replace(/-/g, '').slice(0, 24);
    const profile = {
      id,
      seq: row.seq || nextSeq(data),
      owner_id: Number(row.owner_id || 0),
      group_id: String(row.group_id || row.groupId || 'default'),
      name: row.name,
      remark: row.remark || '',
      platform: row.platform || 'https://www.tiktok.com',
      proxy_type: row.proxy_type || 'noproxy',
      proxy_host: row.proxy_host || '',
      proxy_port: Number(row.proxy_port || 0),
      proxy_user: row.proxy_user || '',
      proxy_pass: row.proxy_pass || '',
      fingerprint_json: typeof row.fingerprint_json === 'string'
        ? row.fingerprint_json
        : JSON.stringify(row.fingerprint_json || {}),
      timezone: row.timezone || 'America/New_York',
      language: row.language || 'en-US',
      latitude: Number(row.latitude || 0),
      longitude: Number(row.longitude || 0),
      country: row.country || '',
      last_ip: row.last_ip || '',
      bound_host_id: row.bound_host_id != null ? String(row.bound_host_id || '') : '',
      status: 'idle',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    data.profiles.push(profile);
    return { ...profile };
  });
}

function setProfileBoundHost(id, hostId) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    p.bound_host_id = String(hostId || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function getProfile(id) {
  return readOnly((d) => d.profiles.find((p) => p.id === String(id)) || null);
}

function listProfiles({ page = 0, pageSize = 100, name = '', ownerId = null, groupId = null } = {}) {
  return readOnly((d) => {
    let list = [...d.profiles];
    if (name) {
      const q = name.toLowerCase();
      list = list.filter((p) =>
        p.name.toLowerCase().includes(q)
        || String(p.remark || '').toLowerCase().includes(q)
        || p.id.includes(q)
      );
    }
    if (ownerId != null && ownerId > 0) {
      list = list.filter((p) => Number(p.owner_id) === Number(ownerId));
    }
    if (groupId != null && String(groupId)) {
      list = list.filter((p) => String(p.group_id || 'default') === String(groupId));
    }
    list.sort((a, b) => (a.seq - b.seq) || String(b.created_at).localeCompare(String(a.created_at)));
    const totalNum = list.length;
    const limit = Math.min(500, Math.max(1, pageSize));
    const offset = Math.max(0, page) * limit;
    return { list: list.slice(offset, offset + limit), page, pageSize: limit, totalNum };
  });
}

function updateProfileProxy(id, proxy) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    p.proxy_type = proxy.proxyType || 'noproxy';
    p.proxy_host = proxy.host || '';
    p.proxy_port = Number(proxy.port || 0);
    p.proxy_user = proxy.proxyUserName || '';
    p.proxy_pass = proxy.proxyPassword || '';
    if (proxy.lastIp != null) p.last_ip = String(proxy.lastIp || '');
    if (proxy.timezone) p.timezone = String(proxy.timezone);
    if (proxy.language) p.language = String(proxy.language);
    if (proxy.latitude != null) p.latitude = Number(proxy.latitude) || 0;
    if (proxy.longitude != null) p.longitude = Number(proxy.longitude) || 0;
    if (proxy.country != null) p.country = String(proxy.country || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function setProfileLastIp(id, lastIp) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    p.last_ip = String(lastIp || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function updateProfileMeta(id, meta = {}) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    if (meta.name != null) p.name = String(meta.name || p.name);
    if (meta.remark != null) p.remark = String(meta.remark || '');
    if (meta.group_id != null || meta.groupId != null) {
      p.group_id = String(meta.group_id || meta.groupId || 'default');
    }
    if (meta.timezone != null) p.timezone = String(meta.timezone || '');
    if (meta.language != null) p.language = String(meta.language || '');
    if (meta.latitude != null) p.latitude = Number(meta.latitude) || 0;
    if (meta.longitude != null) p.longitude = Number(meta.longitude) || 0;
    if (meta.country != null) p.country = String(meta.country || '');
    if (meta.last_ip != null) p.last_ip = String(meta.last_ip || '');
    if (meta.fingerprint_json != null) {
      p.fingerprint_json = typeof meta.fingerprint_json === 'string'
        ? meta.fingerprint_json
        : JSON.stringify(meta.fingerprint_json || {});
    }
    if (meta.platform != null) p.platform = String(meta.platform || p.platform);
    if (meta.proxy_type != null) p.proxy_type = String(meta.proxy_type);
    if (meta.proxy_host != null) p.proxy_host = String(meta.proxy_host || '');
    if (meta.proxy_port != null) p.proxy_port = Number(meta.proxy_port) || 0;
    if (meta.proxy_user != null) p.proxy_user = String(meta.proxy_user || '');
    if (meta.proxy_pass != null) p.proxy_pass = String(meta.proxy_pass || '');
    if (meta.bound_host_id != null) p.bound_host_id = String(meta.bound_host_id || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function listGroups({ ownerId = null } = {}) {
  return withStore((data) => {
    ensureDefaultGroup(data, ownerId || 0);
    let list = [...data.groups];
    if (ownerId != null && ownerId > 0) {
      list = list.filter((g) => !g.owner_id || Number(g.owner_id) === Number(ownerId) || g.id === 'default');
    }
    list.sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.name).localeCompare(String(b.name)));
    return list.map((g) => ({ ...g }));
  });
}

function createGroup({ name, ownerId = 0, sort = 0 } = {}) {
  return withStore((data) => {
    ensureDefaultGroup(data, ownerId);
    const id = uuidv4().replace(/-/g, '').slice(0, 16);
    const row = {
      id,
      name: String(name || '未命名分组'),
      sort: Number(sort || 0),
      owner_id: Number(ownerId || 0),
      created_at: new Date().toISOString(),
    };
    data.groups.push(row);
    return { ...row };
  });
}

function updateGroup(id, patch = {}) {
  return withStore((data) => {
    const g = data.groups.find((x) => x.id === String(id));
    if (!g) return null;
    if (patch.name != null) g.name = String(patch.name);
    if (patch.sort != null) g.sort = Number(patch.sort) || 0;
    return { ...g };
  });
}

function deleteGroup(id) {
  return withStore((data) => {
    const gid = String(id);
    if (gid === 'default') throw new Error('默认分组不可删除');
    data.groups = (data.groups || []).filter((g) => g.id !== gid);
    for (const p of data.profiles) {
      if (String(p.group_id || '') === gid) p.group_id = 'default';
    }
    return { ok: true };
  });
}

function deleteProfile(id) {
  withStore((data) => {
    data.profiles = data.profiles.filter((p) => p.id !== String(id));
  });
}

function setProfileStatus(id, status) {
  withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (p) {
      p.status = status;
      p.updated_at = new Date().toISOString();
    }
  });
}

const sessions = require('./sessions');

function saveUser(user) {
  return sessions.upsertUser(user);
}

function getCurrentUser() {
  return sessions.getCurrentUser();
}

function statsForOwner(ownerId) {
  const used = countProfilesByOwner(ownerId);
  return { ownerId, used, limit: MAX_ENVS_PER_USER, remaining: Math.max(0, MAX_ENVS_PER_USER - used) };
}

function statsAllOwners() {
  return readOnly((d) => {
    const map = {};
    for (const p of d.profiles) {
      const oid = Number(p.owner_id);
      if (!map[oid]) map[oid] = { ownerId: oid, used: 0, limit: MAX_ENVS_PER_USER };
      map[oid].used += 1;
    }
    return map;
  });
}

/** @deprecated 使用 sessions.upsertSession；保留兼容：绑定到最近用户 */
function setApiToken(token) {
  const user = sessions.getCurrentUser();
  return sessions.upsertSession({ token, userId: user?.id || 0 });
}

function validateApiToken(token) {
  return sessions.validateApiToken(token);
}

function getDb() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  return { path: DB_PATH };
}

module.exports = {
  getDb,
  createProfile,
  getProfile,
  listProfiles,
  updateProfileProxy,
  setProfileLastIp,
  setProfileBoundHost,
  updateProfileMeta,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  deleteProfile,
  setProfileStatus,
  saveUser,
  getCurrentUser,
  statsForOwner,
  statsAllOwners,
  countProfilesByOwner,
  setApiToken,
  validateApiToken,
  getUserByToken: sessions.getUserByToken,
  upsertSession: sessions.upsertSession,
  removeSession: sessions.removeSession,
  logoutToken: sessions.logoutToken,
  listSessions: sessions.listSessions,
  listSessionsDetailed: sessions.listSessionsDetailed,
  countActiveSessions: sessions.countActiveSessions,
  listUsers: sessions.listUsers,
  touchSession: sessions.touchSession,
  MAX_ENVS_PER_USER,
};
