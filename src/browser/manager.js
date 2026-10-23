const { EventEmitter } = require('node:events');
const { launchProfile, killProcessAndWait, clearPid, isPidAlive } = require('./launcher');
const { reclaimOrphans } = require('./process-guard');
const { releaseDisplay } = require('./display-pool');
const vnc = require('./vnc');
const record = require('./record');
const { MAX_CONCURRENT_OPENS, HOST_ID, STICKY_HOST } = require('../config');
const db = require('../db');

/** @type {Map<string, object>} */
const running = new Map();
const queue = [];
let queueBusy = false;
const events = new EventEmitter();

try {
  reclaimOrphans(new Set());
} catch { /* ignore */ }

function listWindows() {
  return [...running.entries()].map(([id, s]) => {
    const vncInfo = !s.headless ? vnc.getVncInfo(id) : null;
    const recording = record.getRecordingInfo(id);
    return {
      id,
      profileId: id,
      name: s.profile?.name || id,
      ownerId: s.profile?.owner_id || 0,
      pid: s.pid,
      headless: s.headless,
      display: s.display || null,
      ws: s.ws,
      http: s.http,
      port: s.port,
      startedAt: s.startedAt,
      vnc: vncInfo,
      recording,
    };
  });
}

function isSessionAlive(session) {
  if (!session) return false;
  if (session.pid && isPidAlive(session.pid)) return true;
  if (session.process?.pid && isPidAlive(session.process.pid)) return true;
  return false;
}

function dropStaleSession(id) {
  const session = running.get(id);
  if (!session) return false;
  if (isSessionAlive(session)) return false;
  try { session.releaseProxy?.(); } catch { /* */ }
  try { vnc.stopVnc(id); } catch { /* */ }
  try { releaseDisplay(id); } catch { /* */ }
  clearPid(id);
  running.delete(id);
  db.setProfileStatus(id, 'idle');
  return true;
}

async function processQueue() {
  if (queueBusy || !queue.length) return;
  queueBusy = true;
  const job = queue.shift();
  try {
    const result = await job.run();
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    queueBusy = false;
    processQueue();
  }
}

function enqueueOpen(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ run: fn, resolve, reject });
    processQueue();
  });
}

async function openProfile(profileId, options = {}) {
  const id = String(profileId);
  dropStaleSession(id);
  const existing = running.get(id);
  if (existing?.ws && isSessionAlive(existing)) {
    return formatOpenResult(id, existing);
  }
  if (existing) dropStaleSession(id);

  return enqueueOpen(async () => {
    dropStaleSession(id);
    if (running.has(id) && isSessionAlive(running.get(id))) {
      return formatOpenResult(id, running.get(id));
    }

    for (const rid of [...running.keys()]) dropStaleSession(rid);
    const maxConc = Number(MAX_CONCURRENT_OPENS || 0);
    if (maxConc > 0 && running.size >= maxConc) {
      throw new Error(`同时打开窗口已达上限 ${maxConc}，请先关闭部分环境后再试（可用 TKSWARM_BROWSER_MAX_CONCURRENT 调整）`);
    }

    const profile = db.getProfile(id);
    if (!profile) throw new Error('browser环境不存在或已删除');

    if (STICKY_HOST) {
      const bound = String(profile.bound_host_id || '').trim();
      if (bound && bound !== HOST_ID) {
        throw new Error(
          `环境已绑定主机 ${bound}，当前为 ${HOST_ID}。请导出后在本机导入，或调用 host/rebind，或设 TKSWARM_STICKY_HOST=0`
        );
      }
      if (!bound && typeof db.setProfileBoundHost === 'function') {
        db.setProfileBoundHost(id, HOST_ID);
        profile.bound_host_id = HOST_ID;
      }
    }

    const launched = await launchProfile(profile, {
      headless: options.headless,
      args: options.args,
    });

    const now = Date.now();
    const session = {
      ...launched,
      profile,
      startedAt: new Date(now).toISOString(),
      lastActiveAt: now,
    };
    running.set(id, session);
    db.setProfileStatus(id, options.headless ? 'headless' : 'running');

    if (!session.headless && session.display) {
      try {
        session.vnc = await vnc.startVnc(id, session.display);
      } catch (e) {
        console.warn('[vnc] start failed:', e.message || e);
      }
    }

    events.emit('window-open', listWindows());
    return formatOpenResult(id, session);
  });
}

function touchSession(profileId) {
  const id = String(profileId || '');
  const session = running.get(id);
  if (!session) return false;
  session.lastActiveAt = Date.now();
  return true;
}

function formatOpenResult(id, session) {
  touchSession(id);
  const fp = session.fp || {};
  const vncInfo = vnc.getVncInfo(id);
  return {
    id,
    ws: session.ws,
    http: session.http,
    pid: session.pid,
    name: session.profile?.name || id,
    seq: session.profile?.seq,
    coreVersion: fp.coreVersion || '131',
    headless: session.headless,
    display: session.display || null,
    vnc: vncInfo,
  };
}

async function closeProfile(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  try { await record.stopIfRecording(id); } catch { /* */ }
  try { vnc.stopVnc(id); } catch { /* */ }
  try { releaseDisplay(id); } catch { /* */ }
  if (!session) {
    clearPid(id);
    db.setProfileStatus(id, 'idle');
    return { ok: true };
  }
  await killProcessAndWait(session.process, 10000, session.port || 0);
  try { session.releaseProxy?.(); } catch { /* */ }
  clearPid(id);
  running.delete(id);
  db.setProfileStatus(id, 'idle');
  events.emit('window-close', listWindows());
  return { ok: true };
}

/** 无头 → 有头：关旧进程再以有头模式重开（并挂 VNC） */
async function showWindow(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  if (session && !session.headless && isSessionAlive(session)) {
    if (!vnc.getVncInfo(id) && session.display) {
      try { session.vnc = await vnc.startVnc(id, session.display); } catch { /* */ }
    }
    return formatOpenResult(id, session);
  }
  await closeProfile(id);
  return openProfile(id, { headless: false, queue: true });
}

function getSession(profileId) {
  const id = String(profileId);
  dropStaleSession(id);
  const session = running.get(id) || null;
  if (session) touchSession(id);
  return session;
}

/**
 * 关闭超过 idleMs 无 API 活动的窗口（配合 Node keepBrowser 批任务结束后收尸）。
 * idleMs<=0 时不处理。
 */
async function closeIdleSessions(idleMs) {
  const limit = Number(idleMs || 0);
  if (limit <= 0) return { closed: 0 };
  const now = Date.now();
  const victims = [];
  for (const [id, s] of running.entries()) {
    const last = Number(s.lastActiveAt || Date.parse(s.startedAt) || 0);
    if (last && now - last >= limit) victims.push(id);
  }
  let closed = 0;
  for (const id of victims) {
    try {
      await closeProfile(id);
      closed += 1;
    } catch { /* */ }
  }
  return { closed, checked: running.size + closed };
}

module.exports = {
  openProfile,
  closeProfile,
  showWindow,
  listWindows,
  getSession,
  touchSession,
  closeIdleSessions,
  events,
};
