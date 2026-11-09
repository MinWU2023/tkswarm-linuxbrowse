const { EventEmitter } = require('node:events');
const { launchProfile, killProcessAndWait, clearPid, isPidAlive } = require('./launcher');
const { resolveEngine } = require('./engine');
const { launchProfileElectron } = require('./electron-launcher');
const { reclaimOrphans } = require('./process-guard');
const { releaseDisplay } = require('./display-pool');
const vnc = require('./vnc');
const record = require('./record');
const { MAX_CONCURRENT_OPENS, HOST_ID, STICKY_HOST } = require('../config');
const db = require('../db');

/** @type {Map<string, object>} */
const running = new Map();
/** 正在启动中的环境 id（进程/Xvfb 已起但尚未登记进 running），GC 不得回收 */
const launching = new Set();
const queue = [];
let queueBusy = false;
const events = new EventEmitter();

try {
  reclaimOrphans(new Set());
  try {
    const n = db.resetStaleRunningStatus?.() || 0;
    if (n) console.log(`[manager] 启动复位 ${n} 个残留「运行中」环境状态为 idle`);
  } catch { /* ignore */ }
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

/** GC 用：已运行 + 启动中的环境 id */
function listProtectedProfileIds() {
  return new Set([...running.keys(), ...launching]);
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

/** 复用前确认 CDP 上仍有 page；进程活着但窗已崩时强制重开 */
async function sessionStillHasPage(session) {
  const port = Number(session?.port || 0);
  if (!port) return Boolean(session?.ws);
  try {
    const { waitForPageTarget } = require('./launcher');
    const page = await waitForPageTarget(port, 2500);
    return Boolean(page?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function openProfile(profileId, options = {}) {
  const id = String(profileId);
  const forceRelaunch = Boolean(options.forceRelaunch);
  dropStaleSession(id);
  const existing = running.get(id);
  // 显式 forceRelaunch：先关再开，避免僵尸进程「活着但无 page」被 Playwright 连上后空转 45s
  if (forceRelaunch && existing) {
    await closeProfile(id).catch(() => {});
  } else if (existing?.ws && isSessionAlive(existing)) {
    const ok = await sessionStillHasPage(existing);
    if (ok) return formatOpenResult(id, existing);
    console.warn(`[manager] 复用环境 ${id.slice(0, 8)}… 进程在但无 page，强制重开`);
    await closeProfile(id).catch(() => {});
  }
  if (existing && !forceRelaunch) dropStaleSession(id);

  return enqueueOpen(async () => {
    dropStaleSession(id);
    if (!forceRelaunch && running.has(id) && isSessionAlive(running.get(id))) {
      return formatOpenResult(id, running.get(id));
    }
    if (forceRelaunch && running.has(id)) {
      await closeProfile(id).catch(() => {});
    }

    for (const rid of [...running.keys()]) dropStaleSession(rid);
    const maxConc = Number(MAX_CONCURRENT_OPENS || 0);
    if (maxConc > 0 && running.size >= maxConc) {
      throw new Error(`同时打开窗口已达上限 ${maxConc}，请先关闭部分环境后再试（可用 TKSWARM_BROWSER_MAX_CONCURRENT 调整）`);
    }

    let profile = db.getProfile(id);
    if (!profile) throw new Error('browser环境不存在或已删除');

    try {
      const { enrichProfileProxyFromApi } = require('./proxy-enrich');
      const hasProxy = Boolean(profile.proxy_host && profile.proxy_port);
      const needCreds = hasProxy
        && (!String(profile.proxy_user || '').trim() || !String(profile.proxy_pass || ''));
      const enrichPromise = enrichProfileProxyFromApi(profile).catch(() => profile);
      if (needCreds) {
        profile = await enrichPromise;
      }
    } catch (error) {
      console.warn(`[manager] 代理 API 补全跳过: ${error?.message || error}`);
    }

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

    // 强制 EL 核；resolveEngine 在缺 Electron / 配置 chrome 时抛错
    resolveEngine();
    launching.add(id);
    let launched;
    try {
      launched = await launchProfileElectron(profile, {
        headless: options.headless,
        args: options.args,
      });
    } finally {
      launching.delete(id);
    }

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
    browserWs: session.browserWs || '',
    http: session.http,
    pid: session.pid,
    name: session.profile?.name || id,
    seq: session.profile?.seq,
    coreVersion: fp.coreVersion || '131',
    userAgent: session.userAgent || '',
    os: fp.os || 'Win32',
    locale: session.profile?.language || fp.languages || 'en-US',
    timezone: session.timezone || '',
    fp,
    headless: session.headless,
    display: session.display || null,
    vnc: vncInfo,
    engine: session.engine || '',
    preferPageWs: Boolean(session.preferPageWs || session.engine === 'electron'),
  };
}

async function closeProfile(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  // 诊断：记录是谁关的环境（定位「登录后黑屏」），无论来自路由、GC 还是 openProfile
  try {
    const stack = String(new Error().stack || '').split('\n').slice(2, 7).map((s) => s.trim().replace(/^at\s+/, '')).join(' <- ');
    console.warn(`[manager] closeProfile id=${id.slice(0, 8)}… hasSession=${Boolean(session)} 调用方: ${stack}`);
  } catch { /* ignore */ }
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
  listProtectedProfileIds,
  events,
};
