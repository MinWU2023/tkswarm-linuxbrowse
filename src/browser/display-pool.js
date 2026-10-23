/**
 * 每个有头环境独占一个 Xvfb DISPLAY，便于挂独立 x11vnc。
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const { USE_XVFB } = require('../config');

/** @type {Map<string, { display: string, proc: import('child_process').ChildProcess|null }>} */
const profileDisplays = new Map();
let nextDisplayNum = 110;

function xvfbInstalled() {
  try {
    execSync('which Xvfb', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function displayLockPath(num) {
  return `/tmp/.X${num}-lock`;
}

function pickFreeDisplayNum() {
  for (let n = nextDisplayNum; n < nextDisplayNum + 80; n += 1) {
    if (!fs.existsSync(displayLockPath(n))) {
      const used = [...profileDisplays.values()].some((x) => x.display === `:${n}`);
      if (!used) {
        nextDisplayNum = n + 1;
        return n;
      }
    }
  }
  return 110 + Math.floor(Math.random() * 50);
}

function waitPortGone(ms = 200) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 为有头环境分配/复用 DISPLAY。
 * @returns {Promise<string|null>} 如 ":112"
 */
async function acquireDisplay(profileId) {
  const id = String(profileId);
  const existing = profileDisplays.get(id);
  if (existing?.display) {
    if (existing.proc && !existing.proc.killed) return existing.display;
    if (process.env.DISPLAY && !USE_XVFB) return existing.display;
  }

  if (process.platform !== 'linux' || !USE_XVFB) {
    const d = process.env.DISPLAY || null;
    if (d) profileDisplays.set(id, { display: d, proc: null });
    return d;
  }

  if (!xvfbInstalled()) {
    console.warn('[display-pool] Xvfb 未安装，有头模式可能失败');
    return process.env.DISPLAY || null;
  }

  const num = pickFreeDisplayNum();
  const display = `:${num}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac', '-nolisten', 'tcp'], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref?.();
  proc.on('exit', () => {
    const cur = profileDisplays.get(id);
    if (cur?.display === display) profileDisplays.delete(id);
  });
  profileDisplays.set(id, { display, proc });
  await waitPortGone(350);
  return display;
}

function getDisplay(profileId) {
  return profileDisplays.get(String(profileId))?.display || null;
}

function releaseDisplay(profileId) {
  const id = String(profileId);
  const cur = profileDisplays.get(id);
  if (!cur) return;
  try {
    if (cur.proc && !cur.proc.killed) {
      cur.proc.kill('SIGTERM');
      setTimeout(() => {
        try { cur.proc.kill('SIGKILL'); } catch { /* */ }
      }, 1500);
    }
  } catch { /* */ }
  profileDisplays.delete(id);
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

module.exports = {
  acquireDisplay,
  getDisplay,
  releaseDisplay,
  getFreeTcpPort,
  xvfbInstalled,
};
