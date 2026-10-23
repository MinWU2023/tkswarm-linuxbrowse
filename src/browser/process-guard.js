/**
 * 僵尸 Chrome 回收：按 profile 目录记录 pid，启动前/关闭后清理残留。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PROFILES_DIR } = require('../config');

function pidFile(profileId) {
  return path.join(PROFILES_DIR, String(profileId), '.tkswarm-chrome.pid');
}

function writePid(profileId, pid) {
  try {
    const dir = path.join(PROFILES_DIR, String(profileId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFile(profileId), String(pid));
  } catch { /* ignore */ }
}

function readPid(profileId) {
  try {
    const p = pidFile(profileId);
    if (!fs.existsSync(p)) return 0;
    return Number(fs.readFileSync(p, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function clearPid(profileId) {
  try {
    const p = pidFile(profileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

function isPidAlive(pid) {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!pid || pid < 1) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* */ }
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
      }, 1500);
    }
  } catch { /* ignore */ }
}

/** 等待 pid 退出（关窗后再开依赖此项） */
function waitForPidExit(pid, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!pid || !isPidAlive(pid)) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const tick = () => {
      if (!isPidAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** 打开前：杀掉该环境残留进程并等到退出 */
async function reclaimBeforeOpen(profileId) {
  const pid = readPid(profileId);
  if (pid && isPidAlive(pid)) {
    killPid(pid);
    await waitForPidExit(pid, 8000);
  }
  clearPid(profileId);
}

/** 扫描所有环境目录，清理无主 pid */
function reclaimOrphans(exceptIds = new Set()) {
  try {
    if (!fs.existsSync(PROFILES_DIR)) return { killed: 0 };
    let killed = 0;
    for (const name of fs.readdirSync(PROFILES_DIR)) {
      if (exceptIds.has(name)) continue;
      const pid = readPid(name);
      if (pid && isPidAlive(pid)) {
        killPid(pid);
        killed += 1;
      }
      if (pid) clearPid(name);
    }
    return { killed };
  } catch {
    return { killed: 0 };
  }
}

module.exports = {
  writePid,
  readPid,
  clearPid,
  killPid,
  isPidAlive,
  waitForPidExit,
  reclaimBeforeOpen,
  reclaimOrphans,
};
