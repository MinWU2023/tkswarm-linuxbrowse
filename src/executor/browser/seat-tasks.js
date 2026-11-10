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
    saveTraffic: true, // 服务器浏览器一律省流
    headless: false,
  });
  return { connection, profileId };
}

async function probeLogin(connection, accountId) {
  try {
    if (connection?.page) {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(connection.page, { accountId }).catch(() => {});
    }
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

/**
 * 客服坐席「获取语言」：打开对方主页，从 SSR 的 webapp.user-detail 取简介/昵称，
 * 回传中心库判断语种（TikTok 用户对象没有 language 字段，只能按文本判断）。
 * 判断不出由 PHP 侧默认英语，与「对方无语种则默认英语」的约定一致。
 */
async function runFetchLang(accountId, payload = {}) {
  const aid = Number(accountId);
  const friendId = Number(payload.friendId || 0);
  const target = String(payload.recipient || payload.toUser || payload.username || '')
    .replace(/^@+/, '')
    .trim();
  if (!friendId) throw new Error('获取语言需要 friendId');
  if (!target) throw new Error('获取语言需要对方用户名（recipient）');

  liveLog(`账号 #${aid}：开始获取对方 @${target} 的语种`, 'info', { accountId: aid });
  const { connection, profileId } = await openSeatBrowser(aid, 'https://www.tiktok.com/');
  liveLog(
    `账号 #${aid}：获取语种用浏览器环境已打开 ${String(profileId || '').slice(0, 8)}…，可在环境列表 / VNC 远程查看`,
    'info',
    { accountId: aid, profileId },
  );
  let keepOpen = false;
  try {
    // 未登录会被踢到登录墙，抓不到主页 SSR：先探测，必要时注入已存会话
    let session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      session = await probeLogin(connection, aid);
    }
    if (!session?.loggedIn) {
      keepOpen = true;
      throw waitingLoginDataError(aid, '获取对方语种前需已登录：请在 VNC 完成登录后重试（窗口已保持打开）');
    }
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(target)}`;
    await connection.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      liveLog(`账号 #${aid}：打开对方主页失败：${String(e?.message || e).slice(0, 160)}`, 'warn', { accountId: aid });
    });
    await connection.page.waitForTimeout?.(2500).catch(() => {});

    // 主页 SSR 数据：__DEFAULT_SCOPE__['webapp.user-detail'].userInfo.user
    const profile = await connection.page.evaluate(() => {
      try {
        const nodes = Array.from(document.querySelectorAll('script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#__NEXT_DATA__'));
        for (const n of nodes) {
          const raw = String(n.textContent || '').trim();
          if (!raw) continue;
          const data = JSON.parse(raw);
          const scope = data?.__DEFAULT_SCOPE__ || data || {};
          const detail = scope['webapp.user-detail'] || null;
          const u = detail?.userInfo?.user || null;
          if (u) {
            return {
              uniqueId: String(u.uniqueId || u.unique_id || ''),
              nickname: String(u.nickname || u.nickName || ''),
              signature: String(u.signature || u.bio || ''),
              region: String(u.region || ''),
            };
          }
        }
      } catch { /* 解析失败按无数据处理 */ }
      // SSR 缺失时用页面文本兜底：简介通常在 h2 之后的区域，取可见文本片段
      const h = document.querySelector('[data-e2e="user-bio"]');
      return {
        uniqueId: '',
        nickname: '',
        signature: String(h?.innerText || '').trim().slice(0, 300),
        region: '',
      };
    }).catch(() => null);

    const bio = String(profile?.signature || '').trim();
    const nickname = String(profile?.nickname || '').trim();
    let out = null;
    try {
      out = await phpApi.post('/node/chat/friend-lang', {
        friendId,
        accountId: aid,
        bio,
        nickname,
        uniqueId: profile?.uniqueId || target,
        region: profile?.region || '',
      });
    } catch (e) {
      throw new Error(`语种回写中心库失败：${String(e?.message || e).slice(0, 200)}`);
    }
    const lang = String(out?.lang || 'en');
    liveLog(
      `账号 #${aid}：@${target} 语种=${lang}${out?.fallback ? '（未能判断，按默认英语）' : ''}`
      + `${bio ? `，依据简介：${bio.slice(0, 40)}` : '，简介为空'}`,
      out?.fallback ? 'warn' : 'info',
      { accountId: aid },
    );
    return {
      status: 'completed',
      result: { friendId, lang, fallback: Boolean(out?.fallback), bio: bio.slice(0, 200), profileId },
    };
  } catch (e) {
    // 出错保留窗口：环境秒关的话远程看不到登录墙/验证码
    keepOpen = true;
    throw e;
  } finally {
    if (!keepOpen) {
      try { await closeConnection(connection, { force: true }); } catch { /* */ }
      try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
      await releaseSeatLease(profileId);
    } else {
      // 留给 VNC 人工查看：不断开 Electron 窗
      try { await closeConnection(connection, { force: false, keepAlive: true }); } catch { /* */ }
      // 必须解除跨机包租约：keepOpen 只保留窗口，租约不释放会挂满 2 小时，
      // 后续同账号任务全部卡在「等待环境释放」→ 界面永远「执行中」且不打开新环境
      await releaseSeatLease(profileId);
      liveLog(
        `账号 #${aid}：获取语种任务的浏览器窗口保持打开（环境 ${String(profileId || '').slice(0, 8)}…），可在环境列表 / VNC 查看`,
        'warn',
        { accountId: aid, profileId },
      );
    }
  }
}

/** 坐席用户搜索：关键词最少长度（大于 5 个字符，与前后端校验保持一致） */
const SEARCH_KEYWORD_MIN = 6;

/**
 * 客服坐席「搜索用户」：走服务器浏览器在 TikTok 搜索页拉用户列表。
 * 结果只随任务返回给界面做临时展示，不写 chat_users；下次搜索直接覆盖。
 */
async function runSearchUsers(accountId, payload = {}) {
  const aid = Number(accountId);
  const keyword = String(payload.keyword || '').trim();
  if (keyword.length < SEARCH_KEYWORD_MIN) {
    throw new Error(`搜索词至少 ${SEARCH_KEYWORD_MIN} 个字符（当前 ${keyword.length} 个）`);
  }
  const limit = Math.max(5, Math.min(100, Number(payload.limit || 40) || 40));

  const {
    searchUsersPage,
    scrollSearchResults,
    dismissSearchOverlays,
    humanPause,
  } = require('./ai-lead/pipeline-base');

  liveLog(`账号 #${aid}：开始在 TikTok 搜索「${keyword}」（上限 ${limit} 条）`, 'info', { accountId: aid });
  const { connection, profileId } = await openSeatBrowser(aid, 'https://www.tiktok.com/');
  liveLog(
    `账号 #${aid}：搜索用浏览器环境已打开 ${String(profileId || '').slice(0, 8)}…，可在环境列表 / VNC 远程查看执行过程`,
    'info',
    { accountId: aid, profileId },
  );
  // 需要人工介入（未登录 / 触发验证 / 无结果）时保留窗口，方便在 VNC 里查看和排查
  let keepOpen = false;
  try {
    let session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await tryInjectSavedSession(connection, aid);
      session = await probeLogin(connection, aid);
    }
    if (!session?.loggedIn) {
      keepOpen = true;
      throw waitingLoginDataError(aid, '搜索用户前需已登录：请在 VNC 完成登录后重试（窗口已保持打开）');
    }

    const page = await searchUsersPage(connection, keyword, aid);
    await humanPause(2500, 0.15).catch(() => {});
    await dismissSearchOverlays(page).catch(() => {});

    // 从搜索卡片收集用户：优先 @链接，其次卡片容器
    const collect = () => page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll(
        'div[class*="DivSearchUserItemContainer"] a[href*="/@"],'
        + 'div[class*="DivSearchItemContainer"] a[href*="/@"],'
        + '[data-e2e="search-user-item"] a[href*="/@"],'
        + 'a[href^="/@"]'
      ));
      for (const a of anchors) {
        const href = String(a.getAttribute('href') || '');
        const m = href.match(/^\/@([^/?#]+)/);
        if (!m) continue;
        const username = decodeURIComponent(m[1]).trim();
        if (!username || seen.has(username.toLowerCase())) continue;
        // 侧边栏/顶栏里的「Perfil / Profile」是当前登录账号自己的主页入口，不是搜索结果
        if (a.closest('nav, aside, header, [data-e2e="nav-profile"], [data-e2e="profile-icon"], [data-e2e="nav-user"]')) continue;
        // 卡片 = 从链接向上走、且只包含「这一个用户」链接的最大祖先。
        // 旧逻辑 closest(容器类名) 可能命中包住整个结果列表的大容器，
        // 导致每个用户都取到列表第一行（昵称/头像/粉丝数全部相同）。
        const usersIn = (el) => {
          const set = new Set();
          el.querySelectorAll('a[href*="/@"]').forEach((x) => {
            const mm = String(x.getAttribute('href') || '').match(/\/@([^/?#]+)/);
            if (mm) set.add(decodeURIComponent(mm[1]).toLowerCase());
          });
          return set;
        };
        let box = a;
        for (let el = a.parentElement, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth += 1) {
          if (usersIn(el).size > 1) break;
          box = el;
        }
        const txt = String(box.innerText || '').trim();
        const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
        const img = box.querySelector('img');
        const uname = username.toLowerCase();
        const nickEl = box.querySelector('[data-e2e="search-user-nickname"], [data-e2e="search-user-title"]');
        const nickText = String(nickEl?.innerText || '').trim();
        const nickname = nickText || lines.find((s) => {
          const l = s.toLowerCase();
          if (l === uname || l === `@${uname}`) return false;
          if (/\d.*(followers|粉丝)|(followers|粉丝).*\d/i.test(s)) return false;
          if (/^(follow|following|friends|关注|已关注)$/i.test(s)) return false;
          return true;
        }) || username;
        // 粉丝数通常是「123.4K followers」这类行
        const followers = lines.find((s) => /followers|粉丝/i.test(s)) || '';
        seen.add(username.toLowerCase());
        out.push({
          username,
          nickname: nickname.slice(0, 120),
          avatar: String(img?.getAttribute('src') || ''),
          profileUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
          followersText: followers,
        });
        if (out.length >= 200) break;
      }
      return out;
    }).catch(() => []);

    let items = await collect();
    // 首屏为空时先滚动几轮再判断
    if (!items.length) {
      await scrollSearchResults(page).catch(() => {});
      await humanPause(2500, 0.15).catch(() => {});
      items = await collect();
    }
    let rounds = 0;
    while (items.length < limit && rounds < 6) {
      rounds += 1;
      const before = items.length;
      await scrollSearchResults(page).catch(() => {});
      await humanPause(1800, 0.15).catch(() => {});
      const next = await collect();
      if (next.length > items.length) items = next;
      if (items.length <= before) break;
    }

    const result = items.slice(0, limit).map((u) => ({
      ...u,
      friendUid: '',
      relation: 'stranger',
    }));
    // 搜索结果本身没有语种，回查本地会话里已获取过的语言（没加入会话的用户就没有）
    if (result.length) {
      try {
        const back = await phpApi.post('/node/chat/friend-langs', {
          accountId: aid,
          usernames: result.map((u) => String(u.username || '')),
        });
        const byName = new Map();
        for (const it of (back?.items || [])) {
          byName.set(String(it.username || '').toLowerCase(), it);
        }
        for (const u of result) {
          const hit = byName.get(String(u.username || '').toLowerCase());
          u.lang = String(hit?.lang || '');
          u.friendId = Number(hit?.friendId || 0) || 0;
        }
      } catch (e) {
        // 回查失败不影响搜索结果本身，只是列表里少了语言标签
        liveLog(`账号 #${aid}：搜索结果回查语言失败：${String(e?.message || e).slice(0, 160)}`, 'warn', { accountId: aid });
      }
    }
    if (!result.length) {
      // 无结果：保留窗口，让人能在 VNC 里看是不是撞了验证码 / 登录墙
      keepOpen = true;
      liveLog(
        `账号 #${aid}：搜索「${keyword}」未解析到用户卡片（可能触发验证或关键词无结果），浏览器窗口已保持打开，请在远程查看确认`,
        'warn',
        { accountId: aid, profileId },
      );
    } else {
      liveLog(`账号 #${aid}：搜索「${keyword}」拿到 ${result.length} 个用户（临时结果，未入库）`, 'info', { accountId: aid });
    }
    return {
      status: 'completed',
      result: {
        keyword,
        total: result.length,
        items: result,
        profileId,
        // 明确标记：结果仅在本次任务结果里临时可见，不写本地好友
        temporary: true,
      },
    };
  } catch (e) {
    // 出错也保留窗口，否则环境秒关，远程完全看不到发生了什么
    keepOpen = true;
    throw e;
  } finally {
    if (!keepOpen) {
      try { await closeConnection(connection, { force: true }); } catch { /* */ }
      try { await closeSession(profileId, { accountId: aid, pushPack: false }); } catch { /* */ }
      await releaseSeatLease(profileId);
    } else {
      // 留给 VNC 人工查看：不断开 Electron 窗
      try { await closeConnection(connection, { force: false, keepAlive: true }); } catch { /* */ }
      // 同上：keepOpen 也必须解除跨机包租约，否则后续任务全卡在等待环境释放
      await releaseSeatLease(profileId);
      liveLog(
        `账号 #${aid}：搜索任务的浏览器窗口保持打开（环境 ${String(profileId || '').slice(0, 8)}…），可在环境列表 / VNC 查看`,
        'warn',
        { accountId: aid, profileId },
      );
    }
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
    // TikTok 网页端的 /@user/followers 不是独立页面（会被重定向到 /foryou），
    // 必须先开主页，再点粉丝/关注数，在弹出的列表里抓取。
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(uname)}`;
    const MODAL_SEL = '[data-e2e="follow-info-popup"], [class*="DivFollowInfoContainer" i], [class*="UserListContainer" i], [role="dialog"]';
    const kindLabel = listKind === 'following' ? '关注' : '粉丝';
    await stepLog(`准备打开主页 ${profileUrl}，再点「${kindLabel}」数打开列表弹窗`);
    await connection.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      liveLog(`账号 #${aid}：打开主页失败：${String(e?.message || e).slice(0, 160)}`, 'warn', { accountId: aid });
    });
    await connection.page.waitForTimeout?.(2500).catch(() => {});
    // 主页白屏（body 无子节点）：多半是脚本分包没加载出来，刷新重试最多 2 次
    for (let r = 1; r <= 2; r += 1) {
      const kids = await connection.page.evaluate(() => document.body?.childElementCount || 0).catch(() => 0);
      if (kids > 0) break;
      await stepLog(`主页白屏（body 无内容），第 ${r}/2 次刷新重试`);
      await connection.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await connection.page.waitForTimeout?.(3000).catch(() => {});
    }
    // 主页被踢回登录墙：先探测（在点开弹窗之前，避免探测干扰弹窗）
    const again = await probeLogin(connection, aid);
    if (!again?.loggedIn) {
      await gotoLoginPageForManual(connection, aid);
      keepOpen = true;
      throw waitingLoginDataError(aid, '打开个人主页后仍未登录，已跳转登录页');
    }
    const countSel = listKind === 'following'
      ? '[data-e2e="following-count"], [data-e2e="following"]'
      : '[data-e2e="followers-count"], [data-e2e="followers"]';
    const pg = connection.page;
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(pg, { accountId: aid });
    } catch { /* ignore */ }
    // 先等主页上的粉丝/关注数渲染出来
    await pg.locator(countSel).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(pg, { accountId: aid });
    } catch { /* ignore */ }
    // 弹窗检测：先按已知选择器，再按「悬浮层里至少 2 个用户链接」兜底；命中的根节点打上 data-tks-list 标记，供抓取/滚动复用
    const detectList = async (timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          await solveRotateCaptchaIfPresent(pg, { accountId: aid });
        } catch { /* ignore */ }
        const hit = await pg.evaluate(({ sel, self }) => {
          const vis = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 80 && r.height > 80 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const userLinks = (root) => Array.from(root.querySelectorAll('a[href*="/@"]')).filter((a) => {
            const m = String(a.getAttribute('href') || '').match(/\/@([^/?#]+)/);
            return m && decodeURIComponent(m[1]).toLowerCase() !== self;
          });
          document.querySelectorAll('[data-tks-list]').forEach((n) => n.removeAttribute('data-tks-list'));
          let root = Array.from(document.querySelectorAll(sel)).find((el) => {
            if (!vis(el)) return false;
            if (el.getAttribute('role') !== 'dialog') return true;
            return userLinks(el).length > 0 || /Following|Followers|关注|粉丝/i.test(el.innerText || '');
          }) || null;
          if (!root) {
            const cands = Array.from(document.querySelectorAll('div,section,aside')).filter((el) => {
              const p = getComputedStyle(el).position;
              return (p === 'fixed' || p === 'absolute') && vis(el) && userLinks(el).length >= 2;
            });
            cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
            root = cands[0] || null;
          }
          if (!root) return false;
          root.setAttribute('data-tks-list', '1');
          return true;
        }, { sel: MODAL_SEL, self: uname.toLowerCase() }).catch(() => false);
        if (hit) return true;
        await pg.waitForTimeout(500).catch(() => {});
      }
      return false;
    };
    const textRe = listKind === 'following' ? /^(Following|关注)$/i : /^(Followers|粉丝)$/i;
    const clickers = [
      () => pg.locator(countSel).first().click({ timeout: 6000 }),
      () => pg.locator(countSel).first().click({ timeout: 4000, force: true }),
      () => pg.locator(countSel).first().evaluate((el) => (el.closest('a,button,[role="button"]') || el.parentElement || el).click()),
      () => pg.getByText(textRe).first().click({ timeout: 5000 }),
    ];
    let listOpened = false;
    for (let i = 0; i < clickers.length && !listOpened; i += 1) {
      try { await clickers[i](); } catch { /* 换下一种点法 */ }
      listOpened = await detectList(6000);
      if (!listOpened) await stepLog(`第 ${i + 1}/${clickers.length} 种点击方式后未见列表弹窗`);
    }
    await stepLog(`列表弹窗${listOpened ? '已打开' : '未能打开'}，开始抓取`);
    if (!listOpened) {
      // 把页面现状写进日志，便于对照真实 DOM 调整选择器
      const diag = await pg.evaluate(() => {
        const e2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((n) => n.getAttribute('data-e2e')))).slice(0, 40).join(',');
        const dialogs = document.querySelectorAll('[role="dialog"]').length;
        const links = document.querySelectorAll('a[href*="/@"]').length;
        const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
        return `data-e2e=[${e2e}] dialog=${dialogs} /@链接=${links} 文本=${text}`;
      }).catch((e) => `诊断失败：${String(e?.message || e).slice(0, 80)}`);
      liveLog(`账号 #${aid}：打开「${kindLabel}」弹窗失败，页面现状：${diag}`, 'warn', { accountId: aid });
      throw new Error(`未能打开「${kindLabel}」列表弹窗（当前页 ${String(connection.page.url?.() || '').slice(0, 80)}），本次不入库，避免把推荐流当成${kindLabel}`);
    }
    const users = [];
    const seen = new Set();
    for (let round = 0; round < 25 && users.length < maxPerRun; round += 1) {
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(connection.page, { accountId: aid });
      } catch { /* ignore */ }
      const batch = await connection.page.evaluate(({ sel, self }) => {
        const out = [];
        // 只在列表弹窗内取，不碰页面其它区域
        const root = document.querySelector('[data-tks-list="1"]') || document.querySelector(sel);
        if (!root) return out;
        const anchors = Array.from(root.querySelectorAll('a[href*="/@"]'));
        for (const a of anchors) {
          const href = String(a.getAttribute('href') || '');
          const m = href.match(/\/@([^/?#]+)/);
          if (!m) continue;
          const username = decodeURIComponent(m[1] || '').replace(/^@+/, '');
          if (!username || /^(following|followers|video|live|music|tag)$/i.test(username)) continue;
          if (username.toLowerCase() === self) continue;
          const nickname = String(a.innerText || a.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || username;
          out.push({ username, nickname, friendUid: username });
        }
        return out;
      }, { sel: MODAL_SEL, self: uname.toLowerCase() }).catch(() => []);
      for (const u of batch || []) {
        const key = String(u.username || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        users.push({
          username: u.username,
          nickname: u.nickname || u.username,
          friendUid: u.friendUid || u.username,
          relation,
          isNew: 0, // 旧版 PHP dm-ingest 读 is_new 无默认值会 500，显式带上
        });
        if (users.length >= maxPerRun) break;
      }
      // 滚动弹窗里真正可滚动的容器（不是整页）
      await connection.page.evaluate((sel) => {
        const root = document.querySelector('[data-tks-list="1"]') || document.querySelector(sel);
        if (!root) return;
        const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
        const scroller = nodes.find((n) => n.scrollHeight > n.clientHeight + 20
          && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) || root;
        scroller.scrollTop = scroller.scrollHeight;
      }, MODAL_SEL).catch(() => {});
      await connection.page.waitForTimeout?.(900).catch(() => {});
    }

    await stepLog(`抓取循环结束 抓到=${users.length}${users.length ? '' : '（为 0：列表页可能没渲染出来）'}`);
    let added = 0;
    let updated = 0;
    if (users.length) {
      let ingested = null;
      try {
        ingested = await phpApi.post('/node/chat/dm-ingest', {
          accountId: aid,
          friends: users,
          source: listKind === 'following' ? 'chat.refresh-following' : 'chat.refresh-fans',
        });
      } catch (e) {
        const m = String(e?.message || e).slice(0, 300);
        liveLog(`账号 #${aid}：${kindLabel}写入中心库失败：${m}`, 'error', { accountId: aid });
        throw new Error(`抓到 ${users.length} 个${kindLabel}，但写入中心库失败：${m}`);
      }
      const upserted = Number(ingested?.friends);
      added = Number.isFinite(upserted) ? upserted : 0;
      updated = Math.max(0, users.length - added);
      liveLog(`账号 #${aid}：${kindLabel}已写入中心库 提交=${users.length} 中心库确认=${added}`, 'info', { accountId: aid });
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
    liveLog(`账号 #${aid}：同步粉丝收尾 keepOpen=${keepOpen} livePushed=${livePushed} freshLogin=${freshLogin}${keepOpen ? '（保留窗口）' : '（将关闭环境）'}`, 'info', { accountId: aid });
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

/**
 * 服务器浏览器任务统一登录门禁（执行任务前必须先过）：
 * 1) 检测登录态；2) 未登录 → 注入已同步的会话/环境包登录数据；
 * 3) 仍未登录 → 服务器侧一键（表单）登录；4) 仍失败 → 打开登录页并填账密，留给 VNC，抛 WAITING_LOGIN_DATA。
 * 本次新拿到登录态时，立刻落会话凭证并回传环境包。
 */
async function ensureSeatLoggedIn(connection, accountId, { label = '任务' } = {}) {
  const aid = Number(accountId);
  const profileId = String(connection?.account?.browser_profile_id || '');
  let session = await probeLogin(connection, aid);
  if (session?.loggedIn) {
    liveLog(`账号 #${aid}：${label}前登录检测通过`, 'info', { accountId: aid });
    return { session, fresh: false };
  }

  liveLog(`账号 #${aid}：${label}前检测到未登录，尝试注入已同步的登录数据`, 'warn', { accountId: aid });
  await tryInjectSavedSession(connection, aid);
  session = await probeLogin(connection, aid);

  if (!session?.loggedIn) {
    liveLog(`账号 #${aid}：同步登录数据无效，尝试服务器侧一键（表单）登录`, 'warn', { accountId: aid });
    let login = null;
    try {
      login = await fullLogin(aid, { connection, reuseOpen: true, forceRelaunch: false });
    } catch (e) {
      liveLog(`账号 #${aid}：一键登录异常：${e.message || e}`, 'warn', { accountId: aid });
    }
    const ok = Boolean(login?.loginOk || login?.alreadyLoggedIn);
    if (ok) session = await probeLogin(connection, aid);
    if (!session?.loggedIn) {
      await dataStore.updateLoginStatus(aid, 'offline').catch(() => {});
      if (!login?.usernameFilled || !login?.passwordFilled) {
        await ensureLoginPageAndFill(connection, aid).catch(() => {});
      }
      throw waitingLoginDataError(
        aid,
        login?.message || `${label}前需已登录：自动登录未成功，已打开登录页并尝试填入账密，请在 VNC 完成验证后重试`,
      );
    }
  }

  liveLog(`账号 #${aid}：登录已确认，保存会话凭证并回传环境包后继续${label}`, 'info', { accountId: aid });
  await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
  if (connection.context) {
    await persistAccountSessionLog(aid, connection.context, connection.page).catch(() => {});
  }
  if (profileId) await pushEnvPackBestEffort(aid, profileId, { keepOpen: true }).catch(() => {});
  return { session, fresh: true };
}

module.exports = {
  ensureSeatLoggedIn,
  runCsLogin,
  runCsDetect,
  runCsLogout,
  runSyncFans,
  runFetchLang,
  runSearchUsers,
};
