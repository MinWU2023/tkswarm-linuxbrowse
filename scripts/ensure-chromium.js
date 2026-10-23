#!/usr/bin/env node
/** 可选：通过 playwright 下载 Chromium 供无系统 Chrome 时使用 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
  execSync('npx playwright install chromium', { stdio: 'inherit', cwd: path.join(__dirname, '..'), timeout: 120000 });
} catch (e) {
  console.warn('[ensure-chromium] Skip download. Install Google Chrome or run: npx playwright install chromium');
  process.exit(0);
}
