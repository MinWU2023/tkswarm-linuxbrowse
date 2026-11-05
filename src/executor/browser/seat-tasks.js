/**
 * 客服坐席：服务器浏览器（linux / EL）执行登录 / 检测 / 退出 / 粉丝关注同步。
 */
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { publish: liveLog } = require('../live-log');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { inspectTikTokSession } = require('./cdp-client');
const {
  fullLogin,
  applySavedSessionToContext,
  persistAccountSessionLog,
  closeSession,
  pushEnvPackBestEffort,
} = require('./tiktok-login');
const { ensureServerBrowserEnv, waitingLoginDataError } = require('./server-browser');
const { getProvider } = require('./providers');

/** 未上传新包时也要解除本机持有的占用，WSS 才能唤醒队首等待设备（不推包，避免用未登录状态覆盖中心库好包） */
async function releaseSeatLease(profileId) {
  try {
    await require('./env-pack-sync').releasePackLeaseBestEffort(profileId);
  } catch { /* ignore */ }
}

async function openSeatBrowser(accountId, startUrl = 'https://www.tiktok.com/') {
  const profileId = await ensureServerBrowserEnv(accountId);
  // 坐席分任务各自开窗：必须 forceRelaunch。
  // 若为 false，代理同步 close 后常挂到正在退出的僵尸进程 → newPage「has been closed」。
  const connection = await connectAccount(accountId, startUrl, 'message', {
    browserProfileId: profileId,
    browserBackend: 'linux',
    forceRelaunch: true,
    saveTraffic: false,
  });
  return { connection, profileId };
}

async function probeLogin(connection, accountId) {
  try {
    return await inspectTikTokSession(connection.ws, connection.page);
  } catch (e) {
    liveLog(`账号 #${accountId}：坐席登录探测失败：${e.message || e}`, 'warn', { accountId });
    return null;
  }
}

async function tryInjectSavedSession(connection, accountId) {
  const saved = await dataStore.getSession(accountId).catch(() => null);
  if (!saved?.cookie || !connection?.context) return false;
  const ok = await applySavedSessionToContext(connection.context, connection.page, saved).catch(() => false);
  if (!ok) return false;
  await connection.page.goto('https://www.tiktok.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  }).catch(() => {});
  await connection.page.waitForTimeout?.(1200).catch(() => {});
  return true;
}

/** 坐席登录：优先同步会话；不行再同窗一键登录（服务器可有头/VNC） */
async function runCsLogin(accountId, payload = {}) {
  const aid = Number(accountId);
  liveLog(`账号 #${aid}：坐席登录任务开始（服务器浏览器）`, 'info', { accountId: aid });
  const { connection, profileId } = await openSeatBrowser(aid);
  let keepOpen = false;
  let livePushed = false;
  try {
    let session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      session = await probeLogin(connection, aid);
    }
    if (!session?.loggedIn) {
      liveLog(`账号 #${aid}：同步会话无效，尝试服务器侧一键登录`, 'warn', { accountId: aid });
      const login = await fullLogin(aid, {
        connection,
        reuseOpen: true,
        forceRelaunch: false,
      });
      const ok = Boolean(login?.loginOk || login?.alreadyLoggedIn);
      if (!ok) {
        await dataStore.updateLoginStatus(aid, 'offline').catch(() => {});
        // 需要人工验证时保持窗口
        if (login?.captcha || login?.manualRequired) keepOpen = true;
        throw waitingLoginDataError(aid, login?.message || '一键登录未完成，请在 VNC/桌面完成登录后重试');
      }
    }
    await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
    if (connection.context) {
      await persistAccountSessionLog(aid, connection.context, connection.page).catch(() => {});
    }
    // 登录成功：窗口保持打开 → 在线导出环境包+凭证 → 上传 → 解除占用，WSS 通知队首等待设备
    await pushEnvPackBestEffort(aid, profileId, { keepOpen: true });
    livePushed = true;
    // 自动标记客服连接在线
    try {
      await phpApi.post(`/chat/accounts/${aid}/connect`, {
        autoTranslate: false,
        syncMessages: true,
      });
    } catch { /* ignore */ }
    liveLog(`账号 #${aid}：坐席登录成功`, 'info', { accountId: aid, profileId });
    return {
      status: 'completed',
      result: { loginOk: true, profileId, loginStatus: 'online' },
    };
  } finally {
    if (!keepOpen) {
      try { await closeConnection(connection, { force: true }); } catch { /* */ }
      // 登录成功时已在线上传并解除占用，这里不再重复导出上传
      try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
      if (!livePushed) await releaseSeatLease(profileId);
    }
  }
}

async function runCsDetect(accountId) {
  const aid = Number(accountId);
  const { connection, profileId } = await openSeatBrowser(aid);
  let livePushed = false;
  try {
    let session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      session = await probeLogin(connection, aid);
    }
    const loggedIn = Boolean(session?.loggedIn);
    await dataStore.updateLoginStatus(aid, loggedIn ? 'online' : 'offline').catch(() => {});
    if (!loggedIn) await dataStore.clearSession(aid).catch(() => {});
    if (loggedIn && connection.context) {
      await persistAccountSessionLog(aid, connection.context, connection.page).catch(() => {});
    }
    // 已登录才在线上传（带最新凭证）；未登录不推包，只释放占用
    if (loggedIn) {
      await pushEnvPackBestEffort(aid, profileId, { keepOpen: true });
      livePushed = true;
    }
    return {
      status: 'completed',
      result: { loggedIn, loginStatus: loggedIn ? 'online' : 'offline', profileId },
    };
  } finally {
    try { await closeConnection(connection, { force: true }); } catch { /* */ }
    try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
    if (!livePushed) await releaseSeatLease(profileId);
  }
}

async function runCsLogout(accountId) {
  const aid = Number(accountId);
  let profileId = '';
  try {
    profileId = await ensureServerBrowserEnv(aid).catch(() => '');
  } catch { /* no pack */ }
  await dataStore.updateLoginStatus(aid, 'offline').catch(() => {});
  await dataStore.clearSession(aid).catch(() => {});
  try {
    await phpApi.post(`/chat/accounts/${aid}/disconnect`, {});
  } catch { /* ignore */ }
  if (profileId) {
    const provider = getProvider('linux');
    await provider.close(profileId).catch(() => {});
    await pushEnvPackBestEffort(aid, profileId);
    try { await closeSession(profileId, { accountId: aid, pushPack: true }); } catch { /* */ }
  }
  liveLog(`账号 #${aid}：坐席已退出（服务器浏览器）`, 'info', { accountId: aid });
  return { status: 'completed', result: { loginStatus: 'offline', profileId } };
}

/**
 * 粉丝/关注列表同步：打开主页列表页，抓取可见用户写入 chat_users（dm-ingest）。
 */
async function runSyncFans(accountId, payload = {}) {
  const aid = Number(accountId);
  const listKind = String(payload.listKind || 'followers').toLowerCase() === 'following'
    ? 'following'
    : 'followers';
  const maxPerRun = Math.max(20, Math.min(2000, Number(payload.maxPerRun || 500) || 500));
  const relation = listKind === 'following' ? 'following' : 'follower';
  const bundle = await dataStore.getAccountBundle(aid);
  const uname = String(bundle?.username || '').replace(/^@+/, '');
  if (!uname) throw new Error('账号用户名为空，无法打开粉丝/关注页');

  const pathSeg = listKind === 'following' ? 'following' : 'followers';
  const startUrl = `https://www.tiktok.com/@${encodeURIComponent(uname)}/${pathSeg}`;
  const { connection, profileId } = await openSeatBrowser(aid, startUrl);
  let livePushed = false;
  try {
    const session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      const again = await probeLogin(connection, aid);
      if (!again?.loggedIn) {
        throw waitingLoginDataError(aid, '同步粉丝/关注前需已登录');
      }
    }
    await connection.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await connection.page.waitForTimeout?.(2000).catch(() => {});

    const users = [];
    const seen = new Set();
    for (let round = 0; round < 25 && users.length < maxPerRun; round += 1) {
      const batch = await connection.page.evaluate(() => {
        const out = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="/@"]'));
        for (const a of anchors) {
          const href = String(a.getAttribute('href') || '');
          const m = href.match(/\/@([^/?#]+)/);
          if (!m) continue;
          const username = decodeURIComponent(m[1] || '').replace(/^@+/, '');
          if (!username || /^(following|followers|video|live|music|tag)$/i.test(username)) continue;
          const nickname = String(a.innerText || a.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || username;
          out.push({ username, nickname, friendUid: username });
        }
        return out;
      }).catch(() => []);
      for (const u of batch || []) {
        const key = String(u.username || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        users.push({
          username: u.username,
          nickname: u.nickname || u.username,
          friendUid: u.friendUid || u.username,
          relation,
        });
        if (users.length >= maxPerRun) break;
      }
      await connection.page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        el.scrollTop = el.scrollHeight;
      }).catch(() => {});
      await connection.page.waitForTimeout?.(900).catch(() => {});
    }

    let added = 0;
    let updated = 0;
    if (users.length) {
      const ingested = await phpApi.post('/node/chat/dm-ingest', {
        accountId: aid,
        friends: users,
        source: listKind === 'following' ? 'chat.refresh-following' : 'chat.refresh-fans',
      }).catch(() => null);
      const upserted = Number(ingested?.friends || ingested?.added || 0) || users.length;
      added = upserted;
      updated = Math.max(0, users.length - added);
    }

    await pushEnvPackBestEffort(aid, profileId, { keepOpen: true });
    livePushed = true;
    const progress = { scraped: users.length, added, updated, listKind };
    liveLog(
      `账号 #${aid}：${listKind === 'following' ? '关注' : '粉丝'}同步完成 抓取=${users.length} 新增=${added}`,
      'info',
      { accountId: aid }
    );
    return {
      status: 'completed',
      result: { progress, count: users.length, profileId },
    };
  } finally {
    try { await closeConnection(connection, { force: true }); } catch { /* */ }
    try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
    if (!livePushed) await releaseSeatLease(profileId);
  }
}

module.exports = {
  runCsLogin,
  runCsDetect,
  runCsLogout,
  runSyncFans,
};
