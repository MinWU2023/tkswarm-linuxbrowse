const fs = require('node:fs');
const path = require('node:path');

function readLocal() {
  try {
    const file = path.resolve(__dirname, '../../../data/local-settings.json');
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

const cache = { at: 0, map: null };

function setting(key, fallback) {
  const local = readLocal();
  if (Object.prototype.hasOwnProperty.call(local, key)) return local[key];
  // 同步路径不打 PHP；启动后由 bit-browser-provider 异步刷新。默认可见窗口。
  if (key === 'browserWindowMode') return fallback || 'visible';
  return fallback;
}

const ACTION_KEYS = {
  login: 'headlessLogin',
  publish: 'headlessPublish',
  message: 'headlessMessage',
  profile: 'headlessProfile',
  sync: 'headlessProfile',
  scan: 'headlessScan',
  capcut: 'headlessCapcut',
  warm: 'headlessWarm',
  diagnose: 'headlessProfile',
};

function browserWindowMode() {
  const mode = String(setting('browserWindowMode', 'visible') || 'visible').toLowerCase();
  if (mode === 'hidden' || mode === 'headless') return 'hidden';
  if (mode === 'auto') return 'auto';
  return 'visible';
}

function isHeadless(action) {
  const mode = browserWindowMode();
  if (mode === 'hidden') return true;
  if (mode === 'visible') return false;
  const key = ACTION_KEYS[action] || ACTION_KEYS.profile;
  return Boolean(setting(key, false));
}

module.exports = { isHeadless, browserWindowMode, setting };
