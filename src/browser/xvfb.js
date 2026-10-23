/**
 * 无物理显示器的 Linux 上为「有头」Chrome 提供虚拟 DISPLAY。
 * 需系统安装 xvfb（Dockerfile / systemd 文档已说明）。
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');

let xvfbProc = null;
let displayName = '';

function hasDisplay() {
  const d = String(process.env.DISPLAY || '').trim();
  return d !== '';
}

function xvfbInstalled() {
  try {
    execSync('which Xvfb', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pickDisplay() {
  for (let n = 99; n < 120; n += 1) {
    const lock = `/tmp/.X${n}-lock`;
    if (!fs.existsSync(lock)) return `:${n}`;
  }
  return ':99';
}

/**
 * @returns {Promise<string|null>} DISPLAY 值
 */
async function ensureDisplayEnv() {
  if (hasDisplay()) return process.env.DISPLAY;
  if (!xvfbInstalled()) {
    console.warn('[xvfb] 未安装 Xvfb：有头模式可能失败。请 apt install xvfb，或仅使用 headless。');
    return null;
  }
  if (xvfbProc && !xvfbProc.killed && displayName) {
    return displayName;
  }
  displayName = pickDisplay();
  xvfbProc = spawn('Xvfb', [displayName, '-screen', '0', '1920x1080x24', '-ac'], {
    detached: true,
    stdio: 'ignore',
  });
  xvfbProc.unref?.();
  xvfbProc.on('exit', () => {
    xvfbProc = null;
    displayName = '';
  });
  await new Promise((r) => setTimeout(r, 400));
  process.env.DISPLAY = displayName;
  console.log(`[xvfb] started on ${displayName}`);
  return displayName;
}

module.exports = { ensureDisplayEnv, hasDisplay, xvfbInstalled };
