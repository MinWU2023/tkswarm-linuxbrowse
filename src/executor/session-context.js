/**
 * 账号会话执行上下文（AsyncLocalStorage）
 * 用于把 claim 到的比特环境 profileId 传到 connectAccount 等下游。
 *
 * keepBrowser=true：总任务/手动测试串行期间不关窗口、不断 CDP，子任务（登录检测→拉资料→发布等）直接复用；
 * 仅总任务 finally（closeConnection force）再关环境。
 *
 * proxySynced：本批已对哪些 profile 做过 close+updateProxy。
 * 已同步过的禁止再关窗写代理，否则主页刚打开会被冲成 ERR_SOCKS / 代理错误页。
 *
 * activeConnection：当前保活的 Playwright 连接，供 connectAccount 复用。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithSession(ctx, fn) {
  const base = ctx || {};
  if (!base.proxySynced) base.proxySynced = new Set();
  return als.run(base, fn);
}

function getSession() {
  return als.getStore() || null;
}

function getSessionProfileId() {
  const st = als.getStore();
  return String(st?.browserProfileId || st?.profileId || '');
}

/** 代建/拉包后实际打开的环境可能与批次绑定 ID 不同，必须回写会话 */
function setSessionProfileId(profileId) {
  const st = als.getStore();
  if (!st) return '';
  const pid = String(profileId || '').trim();
  if (!pid) return String(st.browserProfileId || st.profileId || '');
  st.browserProfileId = pid;
  st.profileId = pid;
  return pid;
}

/** 总任务 / 手动测试：子任务间保持浏览器环境不关（含 test 会话，否则登录后发布会断连卡住） */
function shouldKeepBrowserOpen() {
  const st = als.getStore();
  return Boolean(st?.keepBrowser);
}

function markProxySynced(profileId) {
  const st = als.getStore();
  const pid = String(profileId || '').trim();
  if (!st || !pid) return;
  if (!st.proxySynced) st.proxySynced = new Set();
  st.proxySynced.add(pid);
}

function isProxySynced(profileId) {
  const st = als.getStore();
  const pid = String(profileId || '').trim();
  if (!st?.proxySynced || !pid) return false;
  return st.proxySynced.has(pid);
}

/** 总任务内复用的 CDP 连接（登录检测后接着发视频，不要断连重开） */
function getActiveConnection() {
  const st = als.getStore();
  const conn = st?.activeConnection || null;
  if (!conn) return null;
  try {
    if (!conn.browser?.isConnected?.()) return null;
    if (conn.page?.isClosed?.()) return null;
  } catch {
    return null;
  }
  return conn;
}

function setActiveConnection(connection) {
  const st = als.getStore();
  if (!st) return;
  st.activeConnection = connection || null;
}

function clearActiveConnection(connection = null) {
  const st = als.getStore();
  if (!st) return;
  if (!connection || st.activeConnection === connection) {
    st.activeConnection = null;
  }
}

/** 当前会话省流开关（全浏览器任务 keepBrowser 期间可按分任务切换） */
function getSessionSaveTraffic() {
  const st = als.getStore();
  return Boolean(st?.saveTraffic);
}

function setSessionSaveTraffic(enabled) {
  const st = als.getStore();
  if (!st) return false;
  st.saveTraffic = !!enabled;
  return st.saveTraffic;
}

module.exports = {
  runWithSession,
  getSession,
  getSessionProfileId,
  setSessionProfileId,
  shouldKeepBrowserOpen,
  markProxySynced,
  isProxySynced,
  getActiveConnection,
  setActiveConnection,
  clearActiveConnection,
  getSessionSaveTraffic,
  setSessionSaveTraffic,
};
