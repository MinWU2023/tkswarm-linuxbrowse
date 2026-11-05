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
  fillLoginCredentials,
  dismissLoginOverlay,
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
  // 坐席任务：缺包时在服务器本机复用/代建环境，再走登录流程（不再卡在 WAITING_ENV_PACK）
  const profileId = await ensureServerBrowserEnv(accountId, { allowProvision: true });
  // 坐席分任务各自开窗：必须 forceRelaunch。
  // 若为 false，代理同步 close 后常挂到正在退出的僵尸进程 → newPage「has been closed」。
  // 必须有头（headless:false）才能挂 x11vnc，否则远程查看页必然「连接失败」。
  const connection = await connectAccount(accountId, startUrl, 'message', {
    browserProfileId: profileId,
    browserBackend: 'linux',
    forceRelaunch: true,
    saveTraffic: false,
    headless: false,
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
      // 先离开首页弹层，再走一键登录（避免停在 FYP + 黑罩）
      await ensureLoginPageAndFill(connection, aid, { fillOnly: false }).catch(() => {});
      let login = null;
      try {
        login = await fullLogin(aid, {
          connection,
          reuseOpen: true,
          forceRelaunch: false,
        });
      } catch (e) {
        liveLog(`账号 #${aid}：一键登录异常：${e.message || e}`, 'warn', { accountId: aid });
        await ensureLoginPageAndFill(connection, aid).catch(() => {});
        keepOpen = true;
        throw waitingLoginDataError(aid, e.message || '一键登录异常，已打开登录页并尝试填表');
      }
      const ok = Boolean(login?.loginOk || login?.alreadyLoggedIn);
      if (!ok) {
        await dataStore.updateLoginStatus(aid, 'offline').catch(() => {});
        // 未填上账密时再硬跳+填表；已填则保留当前页（验证码/2FA）
        if (!login?.usernameFilled || !login?.passwordFilled) {
          await ensureLoginPageAndFill(connection, aid).catch(() => {});
        }
        keepOpen = true;
        throw waitingLoginDataError(aid, login?.message || '一键登录未完成，已打开登录页并填入账密，请在 VNC 完成验证后重试');
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
    } else {
      // 留给 VNC 人工完成验证码/登录；不断 Electron 窗
      try { await closeConnection(connection, { force: false, keepAlive: true }); } catch { /* */ }
      liveLog(
        `账号 #${aid}：浏览器窗口保持打开，请在远程查看完成登录`,
        'warn',
        { accountId: aid, profileId },
      );
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

const LOGIN_EMAIL_URL = 'https://www.tiktok.com/login/phone-or-email/email';
const LOGIN_HUB_URL = 'https://www.tiktok.com/login';

/**
 * 未登录时：清首页遮罩 → 硬跳邮箱登录页 →（可选）自动填入账密。
 * fillOnly=false 时只导航不填（留给随后的 fullLogin）。
 */
async function ensureLoginPageAndFill(connection, accountId, { fillOnly = true } = {}) {
  const page = connection?.page;
  if (!page || page.isClosed?.()) return { ok: false, message: '页面已关闭' };
  liveLog(
    `账号 #${accountId}：打开邮箱登录页${fillOnly ? '并填写账密' : ''}`,
    'warn',
    { accountId },
  );
  if (typeof dismissLoginOverlay === 'function') {
    await dismissLoginOverlay(page);
  }
  await page.goto(LOGIN_EMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout?.(800).catch(() => {});
  if (typeof dismissLoginOverlay === 'function') {
    await dismissLoginOverlay(page);
  }

  // 若落在方法选择页，点「Use phone / email」
  try {
    const phoneEmail = page.getByText(/Use phone(?:\/| or )?email|手机(?:号)?或邮箱|电话或电子邮件/i).first();
    if (await phoneEmail.isVisible({ timeout: 2500 }).catch(() => false)) {
      await phoneEmail.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout?.(600).catch(() => {});
    }
  } catch { /* ignore */ }

  // 仍不在 /login：再走 hub
  const url = String(page.url() || '');
  if (!/\/login/i.test(url)) {
    await page.goto(LOGIN_HUB_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout?.(400).catch(() => {});
    if (typeof dismissLoginOverlay === 'function') await dismissLoginOverlay(page);
    try {
      const phoneEmail = page.getByText(/Use phone(?:\/| or )?email|手机(?:号)?或邮箱/i).first();
      if (await phoneEmail.isVisible({ timeout: 2000 }).catch(() => false)) {
        await phoneEmail.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout?.(500).catch(() => {});
      }
    } catch { /* ignore */ }
    // 再硬跳一次邮箱页
    await page.goto(LOGIN_EMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout?.(600).catch(() => {});
  }

  if (!fillOnly) return { ok: true, filled: false, message: '已打开登录页' };

  const bundle = await dataStore.getAccountBundle(accountId).catch(() => null);
  const systemUsername = String(bundle?.username || '').replace(/^@+/, '').trim();
  const pendingUsername = String(bundle?.username_prev || bundle?.usernamePrev || '').replace(/^@+/, '').trim();
  // 有待提交改名时，登录仍用 TikTok 原名
  const username = (pendingUsername && systemUsername
    && pendingUsername.toLowerCase() !== systemUsername.toLowerCase())
    ? pendingUsername
    : systemUsername;
  const password = String(bundle?.password || '');
  if (!username || !password) {
    const reason = bundle?.password_decrypt_failed
      ? '密码密文无法解密，请在「密码/2FA」重新填写'
      : '账号缺少用户名或密码，无法自动填表';
    liveLog(`账号 #${accountId}：${reason}`, 'warn', { accountId });
    return { ok: false, filled: false, message: reason };
  }

  for (let i = 0; i < 12; i += 1) {
    const hasPass = await page.locator('input[type="password"]').first().isVisible({ timeout: 400 }).catch(() => false);
    if (hasPass) break;
    await page.waitForTimeout?.(400).catch(() => {});
  }

  const fillRes = await fillLoginCredentials(page, username, password, { accountId, attempts: 3 });
  if (fillRes?.ok) {
    liveLog(`账号 #${accountId}：已自动填入用户名和密码`, 'info', { accountId });
  } else {
    liveLog(`账号 #${accountId}：自动填表未完成：${fillRes?.message || '未知'}`, 'warn', { accountId });
  }
  return { ok: Boolean(fillRes?.ok), filled: Boolean(fillRes?.ok), message: fillRes?.message || '' };
}

/** 兼容旧调用：跳登录页并填账密 */
async function gotoLoginPageForManual(connection, accountId) {
  return ensureLoginPageAndFill(connection, accountId, { fillOnly: true });
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
  // 先打开首页探测登录态；未登录再进登录页，已登录再进粉丝/关注列表
  const { connection, profileId } = await openSeatBrowser(aid, 'https://www.tiktok.com/');
  let livePushed = false;
  let keepOpen = false;
  /** 本次新拿到登录态（注入已存会话 / 一键登录）：确认后立刻推包，不等列表抓完 */
  let freshLogin = false;
  try {
    let session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      session = await probeLogin(connection, aid);
      if (session?.loggedIn) freshLogin = true;
    }
    if (!session?.loggedIn) {
      // 服务器侧尝试一键登录（有账号密码时）；失败则打开登录页留给 VNC
      liveLog(`账号 #${aid}：同步粉丝前未登录，尝试一键登录`, 'warn', { accountId: aid });
      let login = null;
      try {
        login = await fullLogin(aid, {
          connection,
          reuseOpen: true,
          forceRelaunch: false,
        });
      } catch (e) {
        liveLog(`账号 #${aid}：一键登录异常：${e.message || e}`, 'warn', { accountId: aid });
      }
      const ok = Boolean(login?.loginOk || login?.alreadyLoggedIn);
      if (!ok) {
        await gotoLoginPageForManual(connection, aid);
        await dataStore.updateLoginStatus(aid, 'offline').catch(() => {});
        keepOpen = true;
        throw waitingLoginDataError(
          aid,
          login?.message || '同步粉丝/关注前需已登录：已打开登录页，请在 VNC 完成登录后重试',
        );
      }
      session = await probeLogin(connection, aid);
      if (!session?.loggedIn) {
        await gotoLoginPageForManual(connection, aid);
        keepOpen = true;
        throw waitingLoginDataError(aid, '一键登录后仍未登录，请在 VNC 完成登录后重试');
      }
      freshLogin = true;
    }
    // 每步日志附带页面体检：渲染进程是否还响应、DOM 是否被清空（4 秒无响应 = 渲染进程挂死/黑屏）
    const pageProbe = async () => {
      try {
        const r = await Promise.race([
          connection.page.evaluate(() => ({
            rs: document.readyState,
            textLen: String(document.body?.innerText || '').length,
            kids: document.body?.childElementCount || 0,
            vis: document.visibilityState,
            size: `${window.innerWidth}x${window.innerHeight}`,
          })),
          new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 4000)),
        ]);
        if (r?.hung) return '渲染进程4秒无响应';
        return `readyState=${r.rs} 文本长度=${r.textLen} body子节点=${r.kids} vis=${r.vis} 窗口=${r.size}`;
      } catch (e) {
        return `体检失败：${String(e?.message || e).slice(0, 80)}`;
      }
    };
    const stepLog = async (msg) => {
      const probe = await pageProbe();
      liveLog(`账号 #${aid}：同步粉丝步骤 · ${msg}（页面 ${String(connection.page?.url?.() || '').slice(0, 80)}；${probe}）`, 'info', { accountId: aid });
    };
    if (freshLogin) {
      // 登录确认后立即：落会话凭证 → 在线导出环境包上传 → 解除占用（WSS 通知队首），再去抓列表
      await stepLog('登录已确认，开始保存会话凭证');
      await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
      if (connection.context) {
        await persistAccountSessionLog(aid, connection.context, connection.page).catch(() => {});
      }
      await stepLog('会话凭证已保存，开始在线导出并上传环境包');
      await pushEnvPackBestEffort(aid, profileId, { keepOpen: true });
      livePushed = true;
      await stepLog('环境包流程结束');
    }
    await stepLog(`准备打开列表页 ${startUrl}`);
    await connection.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      liveLog(`账号 #${aid}：打开列表页失败：${String(e?.message || e).slice(0, 160)}`, 'warn', { accountId: aid });
    });
    await connection.page.waitForTimeout?.(2000).catch(() => {});
    await stepLog('列表页已打开，开始抓取');
    // 列表页又被踢回登录墙：同样打开登录页并软等待
    const again = await probeLogin(connection, aid);
    if (!again?.loggedIn) {
      await gotoLoginPageForManual(connection, aid);
      keepOpen = true;
      throw waitingLoginDataError(aid, '打开粉丝/关注页后仍未登录，已跳转登录页');
    }

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

    // 已在登录确认后推过包则不重复；否则（环境包里本就是登录态）抓完刷新一次凭证
    if (!livePushed) {
      await pushEnvPackBestEffort(aid, profileId, { keepOpen: true });
      livePushed = true;
    }
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
    if (!keepOpen) {
      try { await closeConnection(connection, { force: true }); } catch { /* */ }
      try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
      if (!livePushed) await releaseSeatLease(profileId);
    } else {
      // 留给 VNC 人工登录；只断 Playwright 会话缓存，不关 Electron 窗
      try { await closeConnection(connection, { force: false, keepAlive: true }); } catch { /* */ }
      liveLog(
        `账号 #${aid}：浏览器窗口保持打开，请在远程查看完成登录后重试「粉丝/关注同步」`,
        'warn',
        { accountId: aid, profileId },
      );
    }
  }
}

module.exports = {
  runCsLogin,
  runCsDetect,
  runCsLogout,
  runSyncFans,
};
