#!/usr/bin/env node
/** 可选：通过 playwright 下载 Chromium 供无系统 Chrome 时使用 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasSystemChrome() {
  const candidates = [
    process.env.TKSWARM_CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* continue */
    }
  }
  return '';
}

const systemChrome = hasSystemChrome();
if (systemChrome) {
  console.log('[ensure-chromium] System browser found, skip download:', systemChrome);
  process.exit(0);
}

try {
  const { chromium } = require('playwright-core');
  const exe = chromium.executablePath();
  if (fs.existsSync(exe)) {
    console.log('[ensure-chromium] OK:', exe);
    process.exit(0);
  }
} catch {
  /* install below */
}

console.log('[ensure-chromium] Downloading Chromium via playwright (optional)…');
try {
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    timeout: 120000,
    env: {
      ...process.env,
      // 避开宝塔全局过期的 registry.npm.taobao.org
      npm_config_registry: process.env.npm_config_registry || 'https://registry.npmmirror.com',
    },
  });
} catch (e) {
  console.warn('[ensure-chromium] Skip download. Install Google Chrome or run: npx playwright install chromium');
  process.exit(0);
}
