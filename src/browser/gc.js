/**
 * 启动 / 定时回收：孤儿 Chrome、无主 Xvfb、陈旧 manager 会话。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { reclaimOrphans } = require('./process-guard');
const { PROFILES_DIR, GC_INTERVAL_MS, SESSION_STALE_MS } = require('../config');
const manager = require('./manager');
const vnc = require('./vnc');
const { releaseDisplay } = require('./display-pool');

/** 受保护的环境 id（运行中 + 启动中）；reclaimOrphans 按环境目录名（profile id）匹配，不是 pid */
function listAliveManagedPids() {
  try {
    return manager.listProtectedProfileIds();
  } catch {
    return new Set(manager.listWindows().map((w) => String(w.profileId)));
  }
}

function reclaimOrphanXvfb() {
  if (process.platform !== 'linux') return 0;
  let killed = 0;
  try {
    // 只清我们常用的高位 DISPLAY（display-pool 从 :110 起）
    const out = execSync("ps -eo pid,args | grep -E '[X]vfb :1[0-9]{2}' || true", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').filter(Boolean);
    const managedDisplays = new Set(
      manager.listWindows().map((w) => w.display).filter(Boolean)
    );
    // 启动中的环境已 acquireDisplay 但尚未登记进 running：其 Xvfb 也不能回收
    try {
      const { getDisplay } = require('./display-pool');
      for (const pid of manager.listProtectedProfileIds()) {
        const d = getDisplay(pid);
        if (d) managedDisplays.add(d);
      }
    } catch { /* ignore */ }
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+.*Xvfb\s+(:\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      const display = m[2];
      if (managedDisplays.has(display)) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed += 1;
      } catch { /* */ }
    }
  } catch { /* */ }
  return killed;
}

function reclaimOrphanX11vnc() {
  if (process.platform !== 'linux') return 0;
  let killed = 0;
  try {
    const activePorts = new Set(
      (vnc.listVnc() || []).map((x) => Number(x.rfbPort)).filter(Boolean)
    );
    const out = execSync("ps -eo pid,args | grep -E '[x]11vnc' || true", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n').filter(Boolean)) {
      const m = line.trim().match(/^(\d+)\s+.*-rfbport\s+(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      const port = Number(m[2]);
      if (activePorts.has(port)) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed += 1;
      } catch { /* */ }
    }
  } catch { /* */ }
  return killed;
}

function dropStaleManagerSessions() {
  // manager.listWindows 内部已 dropStale；再扫一遍无 pid 文件残留状态
  const windows = manager.listWindows();
  let n = 0;
  for (const w of windows) {
    // 触发 getSession 内 drop
    const s = manager.getSession(w.profileId);
    if (!s) n += 1;
  }
  return n;
}

async function runGc(reason = 'tick') {
  const alive = listAliveManagedPids();
  let chrome = 0;
  try {
    reclaimOrphans(alive);
    // reclaimOrphans 不返回数量，粗略统计 pid 文件
    if (fs.existsSync(PROFILES_DIR)) {
      for (const name of fs.readdirSync(PROFILES_DIR)) {
        const pf = path.join(PROFILES_DIR, name, '.tkswarm-chrome.pid');
        if (!fs.existsSync(pf)) continue;
        // 已由 reclaimOrphans 处理
        chrome += 1;
      }
    }
  } catch { /* */ }

  const stale = dropStaleManagerSessions();
  const xvfb = reclaimOrphanXvfb();
  const x11 = reclaimOrphanX11vnc();
  let idleClosed = 0;
  if (SESSION_STALE_MS > 0 && typeof manager.closeIdleSessions === 'function') {
    try {
      const r = await manager.closeIdleSessions(SESSION_STALE_MS);
      idleClosed = r.closed || 0;
    } catch { /* */ }
  }

  if (xvfb || x11 || stale || idleClosed) {
    console.log(`[gc:${reason}] staleSessions≈${stale} idleClosed=${idleClosed} orphanXvfb=${xvfb} orphanX11vnc=${x11} pidFiles≈${chrome}`);
  }
  return { stale, xvfb, x11, chrome, idleClosed };
}

function startGcLoop() {
  Promise.resolve(runGc('boot')).catch(() => {});
  const timer = setInterval(() => {
    Promise.resolve(runGc('tick')).catch(() => {});
  }, GC_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { runGc, startGcLoop, reclaimOrphanXvfb, reclaimOrphanX11vnc };
