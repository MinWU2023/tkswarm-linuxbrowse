/**
 * 统一数据访问：客服端 Node 只走 PHP API（无本机 MySQL）。
 */
const fs = require('node:fs');
const path = require('node:path');
const phpApi = require('./php-api');

function usePhp() {
  return true;
}

function readLocalSetting(key, fallback) {
  try {
    const file = path.resolve(__dirname, '../../data/local-settings.json');
    if (!fs.existsSync(file)) return fallback;
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return Object.prototype.hasOwnProperty.call(j, key) ? j[key] : fallback;
  } catch {
    return fallback;
  }
}

async function resolveBrowserTokenSetting(key, fallback = '') {
  if (key === 'browserApiToken' && process.env.BIT_API_TOKEN) {
    return String(process.env.BIT_API_TOKEN);
  }
  try {
    const file = path.resolve(__dirname, '../../data/local-settings.json');
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      if (Object.prototype.hasOwnProperty.call(j, key)) {
        const v = j[key];
        return v == null ? '' : String(v);
      }
    }
  } catch { /* fall through */ }
  // 自研/Linux 专用 Token：只认本机手动配置，绝不从 PHP 用户设置读取。
  // 登录自动写入的会话 Token 会在 A/B 换人后变成「错的 Bearer」，
  // Linux 默认强制鉴权时直接 Login out，桌面端虽可兜底也会干扰多用户共用。
  if (key === 'tkswarmBrowserApiToken') {
    return fallback == null ? '' : String(fallback);
  }
  try {
    const map = await phpApi.get('/node/settings');
    if (map && Object.prototype.hasOwnProperty.call(map, key)) {
      const v = map[key];
      return v == null ? '' : String(v);
    }
  } catch { /* fall through */ }
  if (key === 'browserApiToken') {
    const session = phpApi.getAuthTokenBare();
    if (session) return session;
  }
  return fallback == null ? '' : String(fallback);
}

async function getSetting(key, fallback) {
  if (key === 'browserApiUrl') {
    return process.env.BIT_API_URL || readLocalSetting('browserApiUrl', fallback || 'http://127.0.0.1:54345');
  }
  if (key === 'browserApiToken' || key === 'tkswarmBrowserApiToken') {
    return resolveBrowserTokenSetting(key, fallback || '');
  }
  try {
    const map = await phpApi.get('/node/settings');
    if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  } catch { /* fall through */ }
  return readLocalSetting(key, fallback);
}

/**
 * 历史：登录后把 PHP Token 写入 tkswarmBrowserApiToken。
 * 现已停用——自研/Linux 本机共用环境时，只要桌面端/Linux 控制台有人登录即可；
 * Node 不应再自动带会话 Token（见 resolveBrowserTokenSetting）。
 * 保留函数签名供前端调用，避免旧客户端报错；需要远程鉴权时请在「设置」手动填写。
 */
async function syncBrowserAuthToken(_token) {
  return false;
}

function writeLocalSettingFile(key, value) {
  try {
    const file = path.resolve(__dirname, '../../data/local-settings.json');
    const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {};
    j[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
  } catch { /* ignore */ }
}

async function setSetting(key, value) {
  try {
    await phpApi.post('/settings', { [key]: value });
  } catch {
    // 本地兜底（翻译配额等非关键）
    writeLocalSettingFile(key, value);
  }
  // Provider 同步读 local-settings：浏览器相关键始终落本地
  if (/^(browserApiUrl|browserApiToken|browserBackend|bitBrowserApiUrl|tkswarmBrowserApiUrl|tkswarmBrowserApiToken|linuxBrowserApiUrl|linuxBrowserApiToken)$/.test(String(key))) {
    writeLocalSettingFile(key, value);
  }
}

async function getAccountBundle(accountId) {
  return phpApi.get(`/node/accounts/${accountId}/bundle`);
}

async function updateBrowserBinding(
  accountId,
  profileId,
  clear = false,
  asPrimary = false,
  browserBackend = 'bit',
  ownerUserId = 0,
) {
  const be = String(browserBackend || 'bit').toLowerCase();
  const backend = (be === 'linux' || be === 'tkswarm-linuxbrowse')
    ? 'linux'
    : (be === 'tkswarm' ? 'tkswarm' : 'bit');
  const body = {
    profileId: profileId || '',
    clear: Boolean(clear),
    asPrimary: Boolean(asPrimary),
    browserBackend: backend,
  };
  const oid = Number(ownerUserId) || 0;
  if (oid > 0) body.ownerUserId = oid;
  return phpApi.post(`/node/accounts/${accountId}/browser-binding`, body);
}

async function updateLoginStatus(accountId, status) {
  return phpApi.patch(`/accounts/${accountId}/status`, { loginStatus: status });
}

async function saveSession(accountId, { cookie, fingerprint = '', storage = '' } = {}) {
  const body = { cookie, fingerprint };
  if (storage != null && String(storage) !== '') body.storage = String(storage);
  return phpApi.put(`/accounts/${accountId}/session`, body);
}

async function getSession(accountId) {
  try {
    return await phpApi.get(`/accounts/${accountId}/session`);
  } catch (e) {
    if (/404|没有已保存/i.test(String(e.message || e))) return null;
    throw e;
  }
}

async function clearSession(accountId) {
  return phpApi.post(`/accounts/${accountId}/session/clear`, {});
}

async function saveFingerprint(accountId, fingerprint) {
  return phpApi.post(`/node/accounts/${accountId}/fingerprint`, { fingerprint });
}

async function tiktokSync(accountId, payload) {
  return phpApi.post(`/node/accounts/${accountId}/tiktok-sync`, payload);
}

async function tiktokAnalyticsSync(accountId, payload) {
  return phpApi.post(`/node/accounts/${accountId}/tiktok-analytics-sync`, payload);
}

async function accountNotificationsSync(accountId, payload) {
  return phpApi.post(`/node/accounts/${accountId}/notifications-sync`, payload);
}

async function restoreExpiredBans() {
  return phpApi.post('/node/maintenance/restore-bans', {});
}

async function qrComplete(payload) {
  return phpApi.post('/node/accounts/qr-complete', payload);
}

async function saveMonitorResult(result) {
  return phpApi.post('/node/monitor/result', { result });
}

async function dmIngest(payload) {
  return phpApi.post('/node/chat/dm-ingest', payload);
}

async function getNocaptchaKey() {
  return phpApi.get('/node/nocaptcha-key');
}

async function reportNocaptchaUsage(payload = {}) {
  return phpApi.post('/node/nocaptcha-key/report-usage', payload);
}

module.exports = {
  usePhp,
  getSetting,
  setSetting,
  syncBrowserAuthToken,
  getAccountBundle,
  updateBrowserBinding,
  updateLoginStatus,
  saveSession,
  getSession,
  clearSession,
  saveFingerprint,
  tiktokSync,
  tiktokAnalyticsSync,
  accountNotificationsSync,
  restoreExpiredBans,
  qrComplete,
  saveMonitorResult,
  dmIngest,
  getNocaptchaKey,
  reportNocaptchaUsage,
};
