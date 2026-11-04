/**
 * 服务器浏览器内置任务 Worker
 * ---------------------------------------------------------------
 * 业务执行核心在 ../executor（已内置），不依赖旁路 tkswarm-node 进程或源码路径。
 * 本文件只负责：注入本机浏览器回环地址 / API Token，并启动最多 3 路队列。
 */
const fs = require('node:fs');
const path = require('node:path');
const { API_PORT, TKSWARM_API_BASE, DEFAULT_API_TOKEN, DATA_ROOT } = require('../config');

let started = false;
let lastError = '';

function browserSelfBase() {
  const port = Number(process.env.TKSWARM_BROWSER_PORT || API_PORT || 54345);
  return `http://127.0.0.1:${port}`;
}

function pickApiToken() {
  try {
    const { getCurrentUser } = require('../db');
    const u = getCurrentUser();
    if (u?.token) return String(u.token).trim();
  } catch { /* ignore */ }
  if (process.env.TKSWARM_API_TOKEN) return String(process.env.TKSWARM_API_TOKEN).trim();
  return String(DEFAULT_API_TOKEN || '').trim();
}

function normalizePhpApiOrigin(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

function seedLocalSettings() {
  const base = browserSelfBase();
  const token = pickApiToken();
  const apiOrigin = normalizePhpApiOrigin(TKSWARM_API_BASE || process.env.TKSWARM_API_BASE || '');
  if (apiOrigin) process.env.TKSWARM_API_BASE = apiOrigin;
  if (token) process.env.TKSWARM_API_TOKEN = token;

  process.env.BIT_API_URL = base;
  process.env.BIT_API_TOKEN = token || process.env.BIT_API_TOKEN || '';
  process.env.TKSWARM_SERVER_BROWSER_OWNER = 'linuxbrowse';

  const dataDir = path.join(path.resolve(__dirname, '../..'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'local-settings.json');
  let cur = {};
  try {
    if (fs.existsSync(settingsFile)) cur = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
  } catch { cur = {}; }
  cur.browserBackend = 'linux';
  cur.linuxBrowserApiUrl = base;
  cur.tkswarmBrowserApiUrl = base;
  cur.browserApiUrl = base;
  if (token) {
    cur.linuxBrowserApiToken = token;
    cur.tkswarmBrowserApiToken = token;
    cur.browserApiToken = token;
  }
  fs.writeFileSync(settingsFile, JSON.stringify(cur, null, 2));

  if (apiOrigin) {
    fs.writeFileSync(path.join(dataDir, 'api.json'), JSON.stringify({
      apiBase: apiOrigin,
      token: token || '',
    }, null, 2));
  }

  try {
    const phpApi = require('../executor/php-api');
    if (token) phpApi.setAuthToken?.(token);
  } catch { /* ignore */ }
}

function refreshAuth() {
  seedLocalSettings();
}

function loadQueue() {
  seedLocalSettings();
  // eslint-disable-next-line global-require
  return require('../executor/queue');
}

function stats() {
  try {
    const q = loadQueue();
    return {
      ok: true,
      owner: 'linuxbrowse',
      builtin: true,
      browserBase: browserSelfBase(),
      dataRoot: DATA_ROOT,
      ...q.stats(),
    };
  } catch (e) {
    lastError = e.message || String(e);
    return {
      ok: false,
      owner: 'linuxbrowse',
      builtin: true,
      message: lastError,
      browserBase: browserSelfBase(),
      maxConcurrent: 3,
      running: 0,
      runningBatchIds: [],
    };
  }
}

async function kickBatch(batchId) {
  refreshAuth();
  return loadQueue().kickBatch(batchId);
}

async function forceStop(batchId, reason) {
  refreshAuth();
  return loadQueue().forceStop(batchId, reason);
}

async function fillSlots() {
  refreshAuth();
  return loadQueue().fillSlots();
}

function startWorker() {
  if (started) return stats();
  started = true;
  const flag = String(process.env.TKSWARM_SERVER_BROWSER_AUTO || '1').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') {
    console.warn('[worker] 已禁用自动队列（TKSWARM_SERVER_BROWSER_AUTO=0）');
    return stats();
  }
  try {
    const q = loadQueue();
    q.startServerBrowserQueue();
    console.log(`[worker] 内置执行队列已启动（最多 ${q.maxConcurrency()} 路，核心 src/executor）`);
    console.log(`[worker] 浏览器回环 ${browserSelfBase()} · API ${process.env.TKSWARM_API_BASE || '(未设)'}`);
  } catch (e) {
    lastError = e.message || String(e);
    console.error('[worker] 启动失败:', lastError);
  }
  return stats();
}

module.exports = {
  startWorker,
  stats,
  kickBatch,
  forceStop,
  fillSlots,
};
