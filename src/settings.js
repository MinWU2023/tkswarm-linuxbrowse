const fs = require('node:fs');
const { SETTINGS_PATH, DEFAULT_API_TOKEN } = require('./config');
const db = require('./db');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {};
    }
  } catch { /* ignore */ }
  return {};
}

function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  fs.mkdirSync(require('node:path').dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function getApiToken() {
  return String(readSettings().apiToken || DEFAULT_API_TOKEN || '');
}

function extractBearer(req) {
  const auth = String(req?.headers?.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = req?.query?.token || req?.headers?.['x-api-token'];
  return String(q || '').trim();
}

/** 从请求解析当前用户（多账号并发核心） */
function resolveRequestUser(req) {
  const token = extractBearer(req);
  if (token) {
    const user = db.getUserByToken(token);
    if (user) {
      db.touchSession?.(token);
      return { user, token };
    }
  }
  return { user: null, token: token || '' };
}

function isAuthorizedRequest(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  return !!db.getUserByToken(t);
}

module.exports = {
  readSettings,
  writeSettings,
  getApiToken,
  extractBearer,
  resolveRequestUser,
  isAuthorizedRequest,
};
