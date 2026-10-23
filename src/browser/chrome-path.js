const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DATA_ROOT } = require('../config');

function chromiumFromPlaywright() {
  try {
    const { chromium } = require('playwright-core');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

function systemChromePaths() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

function resolveChromeExecutable() {
  const cached = path.join(DATA_ROOT, 'chrome-path.txt');
  if (fs.existsSync(cached)) {
    const p = fs.readFileSync(cached, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const candidates = [process.env.TKSWARM_CHROME_PATH, chromiumFromPlaywright(), ...systemChromePaths()].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.writeFileSync(cached, p);
      return p;
    }
  }
  throw new Error('未找到 Chrome/Chromium。请安装 Google Chrome 或运行 npm run postinstall');
}

module.exports = { resolveChromeExecutable };
