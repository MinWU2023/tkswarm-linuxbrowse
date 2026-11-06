const { getProvider } = require('./providers');
const { inspectTikTokSession } = require('./cdp-client');
const {
  connectPlaywrightOverCDP,
  waitForPlaywrightPage,
  ensurePlaywrightPage,
  isCreateTargetUnsupported,
} = require('./cdp-connect');
const { inspectPage, inspectPageForDm, capture, classify } = require('../automation-guard');
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { waitForSlot, typeDelay, awaitSlot } = require('../human-pace');
const { isHeadless } = require('./headless');
const { nowChinaSql, nowChinaIso } = require('../utils/china-time');

/**
 * 任务前登录门禁：先用页面交叉验证；若被踢到登录页，尝试注入本地会话日志再复检。
 */
async function ensureSessionLoggedIn(connection, accountId, { reloadUrl = '', label = '任务' } = {}) {
  const aid = Number(accountId || 0);
  const page = connection?.page;
  let session = await inspectTikTokSession(connection?.ws, page).catch(() => null);
  if (session?.loggedIn) return session;

  const { publish: liveLog } = require('../live-log');
  liveLog(
    `账号 #${aid}：${label}登录门禁未通过 url=${session?.pageUrl || page?.url?.() || '-'} cookie=${session?.hasSessionCookie}，尝试注入会话日志`,
    'warn',
    { accountId: aid },
  );

  const saved = await dataStore.getSession(aid).catch(() => null);
  if (saved?.cookie && connection?.context) {
    const { applySavedSessionToContext } = require('./tiktok-login');
    const ok = await applySavedSessionToContext(connection.context, page, saved).catch(() => false);
    if (ok && page && !page.isClosed?.()) {
      const target = String(reloadUrl || page.url() || 'https://www.tiktok.com/').trim()
        || 'https://www.tiktok.com/';
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout?.(1500).catch(() => {});
      session = await inspectTikTokSession(connection.ws, page).catch(() => null);
      if (session?.loggedIn) {
        liveLog(`账号 #${aid}：注入会话后已恢复登录，继续${label}`, 'info', { accountId: aid });
        await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
        return session;
      }
    }
  }

  return session;
}

/** 发布成功后立刻回写素材状态/账号/平台 video_id（所有发布入口统一走这里） */
async function markMaterialPublishedCallback(accountId, materialId, extra = {}) {
  const mid = Number(materialId || 0);
  const aid = Number(accountId || 0);
  if (mid < 1) {
    console.error('[mark-published] skip: missing materialId', { accountId: aid, materialId: mid });
    return { ok: false, error: 'missing materialId' };
  }
  const body = {
    accountId: aid,
    deleteAfterPublish: !!extra.deleteAfterPublish,
    videoId: String(extra.videoId || extra.video_id || ''),
    videoUrl: String(extra.videoUrl || extra.video_url || ''),
  };
  const attempts = [
    { path: `/node/materials/${mid}/mark-published`, method: 'post', body },
    { path: `/materials/${mid}/mark-published`, method: 'post', body },
  ];
  console.log('[mark-published] calling', { materialId: mid, apiBase: phpApi.loadApiBase?.() || '', ...body });
  let lastErr = null;
  for (const at of attempts) {
    try {
      const data = await phpApi.post(at.path, at.body);
      console.log('[mark-published] ok via', at.path, data);
      try {
        const { publish: liveLog } = require('../live-log');
        liveLog(
          `素材 #${mid} 已标记发布（账号 #${aid}${body.videoId ? `，视频 ${body.videoId}` : ''}）`,
          'info',
          { accountId: aid, materialId: mid, videoId: body.videoId }
        );
      } catch { /* ignore */ }
      writeMarkPublishedDebug({ ok: true, path: at.path, materialId: mid, accountId: aid, data });
      return { ok: true, data, path: at.path };
    } catch (err) {
      lastErr = err;
      console.error('[mark-published] fail via', at.path, err.message, err.status || '', err.payload || '');
    }
  }
  // 最后兜底：PUT 更新（线上若已部署 update 的 publish 字段）
  try {
    const mat = await phpApi.get(`/node/materials/${mid}`).catch(() => null);
    const data = await phpApi.put(`/materials/${mid}`, {
      name: mat?.name || `material-${mid}`,
      filePath: mat?.file_path || mat?.filePath || '',
      fileName: mat?.file_name || mat?.fileName || '',
      mimeType: mat?.mime_type || mat?.mimeType || 'video/mp4',
      sizeBytes: mat?.size_bytes || mat?.sizeBytes || 0,
      description: mat?.description || '',
      tags: mat?.tags || '',
      status: mat?.status || 'ready',
      shareTitle: mat?.share_title || mat?.shareTitle || '',
      shareCaption: mat?.share_caption || mat?.shareCaption || '',
      publishStatus: 'published',
      publishAccountId: aid,
      platformVideoId: body.videoId,
      platformVideoUrl: body.videoUrl,
      videoId: body.videoId,
      videoUrl: body.videoUrl,
    });
    console.log('[mark-published] ok via PUT /materials', data);
    writeMarkPublishedDebug({ ok: true, path: `PUT /materials/${mid}`, materialId: mid, accountId: aid, data });
    return { ok: true, data, path: `PUT /materials/${mid}` };
  } catch (err) {
    lastErr = err;
    console.error('[mark-published] PUT fallback FAILED', err.message, err.payload || '');
  }
  writeMarkPublishedDebug({
    ok: false,
    materialId: mid,
    accountId: aid,
    error: lastErr?.message || 'unknown',
    status: lastErr?.status,
    payload: lastErr?.payload,
    apiBase: (() => { try { return require('../php-api').loadApiBase(); } catch { return ''; } })(),
  });
  try {
    const { publish: liveLog } = require('../live-log');
    liveLog(`标记素材 #${mid} 失败：${lastErr?.message || '未知错误'}`, 'error', { accountId: aid, materialId: mid });
  } catch { /* ignore */ }
  return { ok: false, error: lastErr?.message || 'mark-published failed' };
}

function writeMarkPublishedDebug(info) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.resolve(__dirname, '../../data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'last-mark-published.json'),
      JSON.stringify({ at: nowChinaIso(), ...info }, null, 2),
      'utf8'
    );
  } catch { /* ignore */ }
}
async function resolveConnectSaveTraffic(options = {}) {
  const { parseSaveTrafficFlag } = require('./save-traffic');
  // 服务器浏览器（linux 后端）一律省流；TKSWARM_SERVER_SAVE_TRAFFIC=0 可关闭
  if (String(process.env.TKSWARM_SERVER_SAVE_TRAFFIC || '1').trim() !== '0'
    && String(options.browserBackend || '').trim().toLowerCase() === 'linux') {
    return true;
  }
  if (options.saveTraffic != null || options.save_traffic != null) {
    return parseSaveTrafficFlag(options.saveTraffic ?? options.save_traffic, false);
  }
  try {
    const { getSessionSaveTraffic } = require('../session-context');
    return !!getSessionSaveTraffic();
  } catch {
    return false;
  }
}

async function attachSaveTraffic(conn, enabled) {
  if (!conn) return;
  try {
    const { applySaveTrafficOnConnection } = require('./save-traffic');
    await applySaveTrafficOnConnection(conn, !!enabled);
  } catch { /* ignore */ }
  try {
    const { attachAutoRotateCaptchaWatcher, solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    const aid = Number(conn.account?.id || 0);
    if (conn.page) {
      attachAutoRotateCaptchaWatcher(conn.page, { accountId: aid });
      await solveRotateCaptchaIfPresent(conn.page, { accountId: aid });
    }
  } catch { /* ignore */ }
}

async function connectAccount(accountId, url, action = 'publish', options = {}) {
  const { resolveProfileIdForAccount, activeBackendOverride } = require('./providers');
  const bundle = await dataStore.getAccountBundle(accountId);
  if (!bundle) throw new Error('账号不存在');
  // 优先用会话租约 / 显式 profile；再按任务后端选比特或 TkSwarm 环境 ID
  let profileId = resolveProfileIdForAccount(bundle, {
    browserProfileId: options.browserProfileId,
    profileId: options.profileId,
    browserBackend: options.browserBackend || activeBackendOverride(),
  });
  if (!profileId) throw new Error('账号尚未绑定浏览器环境（请确认所选浏览器后端下已创建环境）');
  const account = {
    id: bundle.id,
    username: bundle.username,
    browser_profile_id: profileId,
    browser_backend: options.browserBackend || activeBackendOverride() || bundle.browser_backend || 'bit',
  };
  const provider = getProvider(options.browserBackend || undefined);
  const { ensureAccountProxySynced } = require('./proxy-sync');
  const {
    shouldKeepBrowserOpen,
    isProxySynced,
    markProxySynced,
    getActiveConnection,
    setActiveConnection,
  } = require('../session-context');
  const saveTraffic = await resolveConnectSaveTraffic(options);
  const keepBrowser = shouldKeepBrowserOpen();
  // 总任务 keepBrowser：复用已开窗口，禁止 forceRelaunch（否则登录检测后又被关掉重开）
  let forceRelaunch = options.forceRelaunch != null
    ? Boolean(options.forceRelaunch)
    : !keepBrowser;
  // 本批已同步过代理则禁止再 close+updateProxy（否则主页会变成代理错误页）
  const skipProxyWrite = Boolean(options.skipProxyWrite)
    || (keepBrowser && isProxySynced(profileId) && options.forceProxyResync !== true);

  // 登录检测留下的 CDP：直接在同一窗口跳转，接着跑发布等任务
  let reused = keepBrowser && options.reuseConnection !== false ? getActiveConnection() : null;
  const reusedPid = String(reused?.account?.browser_profile_id || '').trim();
  const dropReuse = async (reason) => {
    if (!reused) return;
    const { publish: liveLog } = require('../live-log');
    liveLog(`账号 #${accountId}：${reason}，强制重开环境`, 'warn', { accountId });
    try {
      const { clearActiveConnection } = require('../session-context');
      clearActiveConnection(reused);
    } catch { /* ignore */ }
    await reused.browser?.close?.().catch(() => {});
    reused = null;
    forceRelaunch = true;
  };
  if (reused && (!reusedPid || reusedPid === profileId)) {
    const { isBrowserDisconnected } = require('./ai-lead/pipeline-base');
    let reuseOk = true;
    let context = reused.context;
    try {
      if (isBrowserDisconnected(reused.browser)) reuseOk = false;
      else {
        context = context || reused.browser?.contexts?.()?.[0] || null;
        if (!context) reuseOk = false;
      }
    } catch {
      reuseOk = false;
    }
    if (!reuseOk) {
      await dropReuse('缓存的浏览器 CDP 已失效');
    } else {
      account.browser_profile_id = reusedPid || profileId;
      let page = reused.page;
      if (context?.pages) {
        page = context.pages().find((p) => /tiktokstudio\/upload/i.test(p.url() || ''))
          || context.pages().find((p) => /tiktok\.com/i.test(p.url() || ''))
          || page
          || context.pages()[0];
      }
      if ((!page || page.isClosed?.()) && context) {
        try { page = await context.newPage(); } catch { page = null; }
      }
      if (!page || page.isClosed?.()) {
        await dropReuse('复用环境无可用页面');
      } else {
        const { publish: liveLog } = require('../live-log');
        reused.page = page;
        reused.context = context;
        reused.account = account;
        await page.bringToFront().catch(() => {});
        if (url) {
          liveLog(
            `账号 #${accountId}：复用已打开环境，前往 ${
              /tiktokstudio\/upload/i.test(url) ? 'Studio 上传页'
                : /tiktokstudio\/content/i.test(url) ? 'Studio 内容页'
                  : /tiktokstudio/i.test(url) ? 'Studio'
                    : '目标页'
            }`,
            'info',
            { accountId }
          );
          const { scaleTimeout, waitPageSettled } = require('./page-ready');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scaleTimeout(90000, 60000) }).catch(() => {});
          const { detectBrowserNetworkError } = require('./tiktok-login');
          const netErr = await detectBrowserNetworkError(page).catch(() => null);
          if (netErr) {
            await dropReuse(`复用窗口跳转出现网络错误（${netErr}）`);
          } else {
            if (/tiktokstudio\/upload/i.test(url)) {
              await page.getByText(/Select video/i).first().waitFor({ state: 'visible', timeout: scaleTimeout(45000, 30000) }).catch(() => {});
              await page.waitForTimeout(1500);
            } else {
              await waitPageSettled(page, {
                timeoutMs: 25000,
                contentSelectors: ['[data-e2e]', 'main', 'header', 'video', 'form'],
                label: '复用环境加载',
                log: (m) => liveLog(`账号 #${accountId}：${m}`, 'info', { accountId }),
              });
            }
            const reusedConn = {
              account,
              provider: reused.provider || provider,
              browser: reused.browser,
              page,
              context,
              ws: reused.ws,
              reused: true,
            };
            await attachSaveTraffic(reusedConn, saveTraffic);
            setActiveConnection(reusedConn);
            return reusedConn;
          }
        } else {
          const reusedConn = {
            account,
            provider: reused.provider || provider,
            browser: reused.browser,
            page,
            context,
            ws: reused.ws,
            reused: true,
          };
          await attachSaveTraffic(reusedConn, saveTraffic);
          setActiveConnection(reusedConn);
          return reusedConn;
        }
      }
    }
  }

  const synced = await ensureAccountProxySynced(bundle, {
    profileId,
    provider,
    accountId: bundle.id,
    backend: options.browserBackend || account.browser_backend,
    skipProxyWrite,
  });
  if (!skipProxyWrite && !synced.skippedProxy) {
    markProxySynced(synced.profileId);
    // syncProxyToProfile 会先 close 再写代理；此处若仍 forceRelaunch=false，
    // open 可能挂到正在退出的僵尸进程 → newPage/waitForTimeout 报「has been closed」
    forceRelaunch = true;
  }
  async function openAndAttach(force) {
    if (force) {
      // 关窗写代理 / 杀僵尸后稍等刷盘，避免连上半死进程
      await new Promise((r) => setTimeout(r, 800));
    }
    const openedInner = await synced.provider.open(synced.profileId, {
      // 坐席 / VNC 等可显式强制有头
      headless: options.headless === false
        ? false
        : (options.headless === true ? true : isHeadless(action)),
      forceRelaunch: force,
    });
    if (!openedInner?.ws && !openedInner?.http) {
      throw new Error(`${synced.provider.backendLabel || '本地浏览器'}未返回 CDP 地址`);
    }
    await synced.provider.heartbeat?.(synced.profileId)?.catch?.(() => {});
    const browserInner = await connectPlaywrightOverCDP(openedInner, {
      timeoutMs: 60000,
      retries: 3,
      settleMs: force ? 1200 : 800,
    });
    if (!browserInner?.isConnected?.()) {
      throw new Error(`${synced.provider.backendLabel || '本地浏览器'} CDP 已断开（环境可能刚被关窗写代理，请重试）`);
    }
    // Electron（linux）不支持 Target.createTarget：只能等/复用已有页，禁止 newPage
    const isLinux = String(options.browserBackend || account.browser_backend || '').toLowerCase() === 'linux'
      || /linux|第一页自研浏览器 Linux/i.test(String(synced.provider.backendLabel || ''));
    let pageInner;
    try {
      pageInner = await ensurePlaywrightPage(browserInner, {
        timeoutMs: 45000,
        preferUrl: /tiktokstudio\/upload|tiktok\.com/i,
        allowNewPage: !isLinux,
        httpBase: openedInner?.http || '',
      });
    } catch (e) {
      const noPage = e?.code === 'NO_PAGE_ELECTRON' || /未出现可用页面|NO_PAGE/i.test(String(e?.message || e));
      const createUnsupported = isCreateTargetUnsupported(e) || e?.code === 'CREATE_TARGET_UNSUPPORTED';
      const hint = createUnsupported
        ? '（Electron 请复用窗口内已有页，勿 CDP newPage）'
        : noPage
          ? '（窗口可能未挂上页 / Debugger 被占用；将强制重开）'
          : '（浏览器已关闭，请确认未并发关窗/推环境包）';
      const err = new Error(
        `${synced.provider.backendLabel || '本地浏览器'} 无法取得页面：${e.message || e}${hint}`
      );
      err.code = e?.code || (createUnsupported ? 'CREATE_TARGET_UNSUPPORTED' : (noPage ? 'NO_PAGE_ELECTRON' : 'PAGE_CONTEXT_CLOSED'));
      throw err;
    }
    const contextInner = pageInner.context?.() || browserInner.contexts()[0] || null;
    return { opened: openedInner, browser: browserInner, context: contextInner, page: pageInner };
  }

  let opened;
  let browser;
  let context;
  let page;
  try {
    ({ opened, browser, context, page } = await openAndAttach(forceRelaunch));
  } catch (e) {
    // 僵尸/半关进程：强制关窗后整窗重开一次
    // 含 CDP 端口拒绝连接（Electron 进程已退出）：同样整窗重开一次
    if (/PAGE_CONTEXT_CLOSED|CREATE_TARGET_UNSUPPORTED|NO_PAGE|has been closed|Target closed|Target page|context or browser|Not supported|ECONNREFUSED|ECONNRESET|WebSocket error|连接浏览器 CDP 失败|CDP 已断开|未返回 CDP/i.test(String(e?.message || e || e?.code))) {
      const { publish: liveLog } = require('../live-log');
      liveLog(
        `账号 #${accountId}：开页失败（${String(e.message || e).slice(0, 120)}），强制重开环境再试`,
        'warn',
        { accountId },
      );
      await synced.provider.close(synced.profileId).catch(() => {});
      ({ opened, browser, context, page } = await openAndAttach(true));
    } else {
      throw e;
    }
  }
  profileId = synced.profileId;
  account.browser_profile_id = profileId;
  try {
    const { setSessionProfileId } = require('../session-context');
    setSessionProfileId(profileId);
  } catch { /* ignore */ }
  const activeProvider = synced.provider;
  await page.bringToFront().catch(() => {});
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // 导航后若落成代理/网络错误页：整窗重开一次（允许重新写代理）
    const { detectBrowserNetworkError, networkErrorMessage } = require('./tiktok-login');
    let netErr = await detectBrowserNetworkError(page).catch(() => null);
    if (netErr && options.allowProxyRecovery !== false) {
      const { publish: liveLog } = require('../live-log');
      liveLog(
        `账号 #${accountId}：打开后出现代理/网络错误页（${netErr}），关闭后重写代理并重开一次`,
        'warn',
        { accountId },
      );
      await browser.close().catch(() => {});
      try {
        const { forgetSession } = require('./tiktok-login');
        forgetSession(profileId);
      } catch { /* ignore */ }
      await activeProvider.close(profileId).catch(() => {});
      const recovered = await ensureAccountProxySynced(bundle, {
        profileId,
        provider: activeProvider,
        accountId: bundle.id,
        backend: options.browserBackend || account.browser_backend,
        skipProxyWrite: false,
      });
      markProxySynced(recovered.profileId);
      const reOpened = await recovered.provider.open(recovered.profileId, {
        headless: options.headless === false
          ? false
          : (options.headless === true ? true : isHeadless(action)),
        forceRelaunch: true,
      });
      if (!reOpened?.ws && !reOpened?.http) throw new Error(`${recovered.provider.backendLabel || '本地浏览器'}重开后未返回 CDP`);
      const browser2 = await connectPlaywrightOverCDP(reOpened, { timeoutMs: 60000, retries: 3, settleMs: 800 });
      const page2 = await ensurePlaywrightPage(browser2, {
        preferUrl: /tiktok\.com/i,
        allowNewPage: String(options.browserBackend || '').toLowerCase() !== 'linux',
        httpBase: reOpened?.http || '',
      });
      const context2 = page2.context?.() || browser2.contexts()[0];
      await page2.bringToFront().catch(() => {});
      await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      netErr = await detectBrowserNetworkError(page2).catch(() => null);
      if (netErr) {
        const hint = bundle.proxy_host
          ? `${bundle.proxy_protocol || 'proxy'}://${bundle.proxy_host}:${bundle.proxy_port || ''}`
          : '';
        throw new Error(networkErrorMessage(netErr, hint));
      }
      page = page2;
      if (/tiktokstudio\/upload/i.test(url)) {
        await page.getByText(/Select video/i).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
      } else if (action === 'warm') {
        await page.waitForTimeout(2000);
      } else {
        await page.waitForTimeout(1500);
      }
      const recoveredConn = {
        account,
        provider: recovered.provider,
        browser: browser2,
        page,
        context: context2,
        ws: reOpened.ws || reOpened.http,
        opened: reOpened,
      };
      await attachSaveTraffic(recoveredConn, saveTraffic);
      if (keepBrowser) setActiveConnection(recoveredConn);
      return recoveredConn;
    }
    if (page.isClosed?.() || !browser.isConnected?.()) {
      // 只整窗重开一次；仍然关闭就如实报错
      if (!options.__reopenedAfterGoto) {
        const { publish: liveLog } = require('../live-log');
        liveLog(
          `账号 #${accountId}：打开目标页后浏览器已关闭（页面已关=${Boolean(page.isClosed?.())}，CDP 断开=${!browser.isConnected?.()}），强制重开环境再试一次`,
          'warn',
          { accountId },
        );
        // 缓存的旧连接无需手动清：getActiveConnection() 对已断开/已关页的连接会返回 null
        await browser.close?.().catch(() => {});
        await activeProvider.close(profileId).catch(() => {});
        return connectAccount(accountId, url, action, {
          ...options,
          forceRelaunch: true,
          __reopenedAfterGoto: true,
        });
      }
      throw new Error('打开目标页后浏览器已关闭（重开一次后仍关闭；可能是 Electron 渲染进程崩溃或被并发关窗）');
    }
    if (/tiktokstudio\/upload/i.test(url)) {
      await page.getByText(/Select video/i).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500).catch(() => {});
    } else if (action === 'warm') {
      // 登录探测：不必干等 5 秒；过长等待时代理抖动更容易把主页刷成错误页
      await page.waitForTimeout(2000).catch(() => {});
    } else {
      await page.waitForTimeout(1500).catch(() => {});
    }
    if (page.isClosed?.() || !browser.isConnected?.()) {
      throw new Error('页面就绪等待期间浏览器已关闭（可能被并发关窗/写代理打断）');
    }
  } else {
    await page.waitForTimeout(1500).catch(() => {});
  }
  const conn = {
    account,
    provider: activeProvider,
    browser,
    page,
    context,
    ws: opened.ws || opened.http,
    opened,
  };
  await attachSaveTraffic(conn, saveTraffic);
  if (keepBrowser) setActiveConnection(conn);
  return conn;
}
/**
 * 结束分任务时的连接收尾。
 * - 总任务 keepBrowser：默认保活 CDP + 窗口（下一项直接接着用），禁止关了再开
 * - options.keepAlive=false：仅断 CDP，窗口仍留给整批（特殊场景）
 * - options.force=true：总任务 finally — 断 CDP 并关闭浏览器环境
 */
async function closeConnection(connection, options = {}) {
  if (!connection) return;
  const force = options.force === true;
  let keepBrowser = false;
  try {
    const { shouldKeepBrowserOpen } = require('../session-context');
    keepBrowser = shouldKeepBrowserOpen();
  } catch { /* ignore */ }

  // 总任务内默认保活；显式 keepAlive=false 才断 CDP；force 一律拆掉
  const keepAlive = !force && (
    options.keepAlive === true
    || (keepBrowser && options.keepAlive !== false)
  );

  const profileId = String(connection.account?.browser_profile_id || '');
  if (keepAlive) {
    try {
      const { setActiveConnection } = require('../session-context');
      setActiveConnection(connection);
    } catch { /* ignore */ }
    if (profileId) {
      const provider = connection.provider || getProvider();
      await provider.heartbeat?.(profileId)?.catch?.(() => {});
    }
    return;
  }

  await connection.browser?.close?.().catch(() => {});
  try {
    const { clearActiveConnection } = require('../session-context');
    clearActiveConnection(connection);
  } catch { /* ignore */ }
  if (profileId) {
    try {
      const loginMod = require('./tiktok-login');
      loginMod.forgetSession?.(profileId);
    } catch { /* ignore */ }
  }
  // keepBrowser 且非 force：窗口留给整批（兼容旧调用 keepAlive:false）
  if (!force && keepBrowser) {
    if (profileId) {
      const provider = connection.provider || getProvider();
      await provider.heartbeat?.(profileId)?.catch?.(() => {});
    }
    return;
  }
  if (!profileId) return;
  const provider = connection.provider || getProvider();
  await provider.close(profileId).catch(() => {});
}

/** 强制关闭比特环境窗口（无视 keepBrowser） */
async function forceCloseBrowserProfile(profileId) {
  const id = String(profileId || '');
  if (!id) return;
  const provider = getProvider();
  await provider.close(id).catch(() => {});
}

async function findFileInput(page, waitMs = 15000) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const frame of frames) {
      for (const sel of [
        'input[type="file"][accept*="video"]',
        'input[type="file"][accept*="mp4"]',
        'input[type="file"]',
      ]) {
        const loc = frame.locator(sel).first();
        if (await loc.count().catch(() => 0)) return loc;
      }
    }
    // Shadow DOM / late-mounted inputs
    const handle = await page.evaluateHandle(() => {
      const walk = (root, out = []) => {
        root.querySelectorAll?.('input[type="file"]')?.forEach((n) => out.push(n));
        root.querySelectorAll?.('*')?.forEach((n) => {
          if (n.shadowRoot) walk(n.shadowRoot, out);
        });
        return out;
      };
      const list = walk(document);
      const prefer = list.find((n) => /video|mp4|webm/i.test(String(n.accept || ''))) || list[0];
      return prefer || null;
    }).catch(() => null);
    const el = handle?.asElement?.();
    if (el) return el;
    await page.waitForTimeout(400);
  }
  return null;
}

async function waitStudioUploadReady(page, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const url = page.url() || '';
    if (!/tiktokstudio\/upload|tiktok\.com\/upload/i.test(url)) {
      await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    const ready = await page.getByText(/Select video to upload|选择视频|上传视频/i).first()
      .isVisible()
      .catch(() => false);
    const btn = await page.locator('button, [role="button"]').filter({ hasText: /^Select video$/i }).first()
      .isVisible()
      .catch(() => false);
    if (ready || btn) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function clickSelectVideoTriggers(page) {
  const exactBtn = page.locator('button').filter({ hasText: /^Select video$/i }).first();
  if (await exactBtn.count().catch(() => 0) && await exactBtn.isVisible().catch(() => false)) {
    return exactBtn;
  }
  const labels = /Select video|Select video to upload|Upload video|选择视频|上传视频|选择文件/i;
  const candidates = [
    page.getByRole('button', { name: labels }),
    page.locator('button').filter({ hasText: labels }),
    page.locator('[role="button"]').filter({ hasText: labels }),
    page.locator('div[class*="upload" i] button').filter({ hasText: labels }),
    page.getByText(/^Select video$/i),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    return el;
  }
  // Drop zone itself
  const zone = page.getByText(/Or drag and drop it here|拖放到此处/i).first();
  if (await zone.count().catch(() => 0) && await zone.isVisible().catch(() => false)) {
    return zone;
  }
  return null;
}

async function setInputFilesSafe(target, filePath) {
  if (!target) return false;
  try {
    if (typeof target.setInputFiles === 'function') {
      await target.setInputFiles(filePath);
      return true;
    }
  } catch (e) {
    // ElementHandle vs Locator differences
  }
  try {
    await target.setInputFiles(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Select local video on TikTok Studio upload page. */
async function selectVideoFile(page, filePath, log = () => {}) {
  const fs = require('node:fs');
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`素材文件不存在或不可读：${filePath || '(空路径)'}`);
  }
  const size = fs.statSync(filePath).size;
  if (size < 1024) throw new Error(`素材文件过小（${size} bytes），可能下载失败：${filePath}`);

  log(`上传页：等待 Studio 就绪（${page.url()}）`);
  await waitStudioUploadReady(page, 45000);

  // Switch Videos tab
  const videosTab = page.getByRole('tab', { name: /^Videos$/i }).or(page.getByText(/^Videos$/i)).first();
  if (await videosTab.isVisible().catch(() => false)) {
    await videosTab.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // A) Prefer filechooser + red Select video button (matches current Studio UI)
  const trigger = await clickSelectVideoTriggers(page);
  if (trigger) {
    log('上传：点击选择视频并打开文件选择器');
    try {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
      await trigger.click({ timeout: 10000, force: true });
      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);
      log('上传：已通过文件选择器选中文件');
      return { method: 'chooser' };
    } catch (e) {
      log(`上传：文件选择器失败：${e.message}`);
    }
  } else {
    log('上传：尚未找到「选择视频」按钮');
  }

  // B) Hidden / shadow file input
  log('上传：尝试直接写入文件输入框');
  let input = await findFileInput(page, 8000);
  if (input && await setInputFilesSafe(input, filePath)) {
    log('上传：已通过文件输入框选中文件');
    return { method: 'input' };
  }

  // C) Force-create chooser by dispatching click on any upload CTA via JS + filechooser
  log('上传：用脚本点击「选择视频」');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], div, span, a, label')];
    const el = nodes.find((n) => /^Select video$/i.test((n.innerText || n.textContent || '').trim()));
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
    const any = nodes.find((n) => /Select video to upload|选择视频/i.test((n.innerText || '').trim()));
    if (any) {
      any.click();
      return true;
    }
    return false;
  }).catch(() => false);
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(filePath);
    log('上传：脚本点击后已选中文件');
    return { method: 'js-chooser' };
  }

  // D) Last try: deep input again after click
  input = await findFileInput(page, 6000);
  if (input && await setInputFilesSafe(input, filePath)) {
    log('上传：点击后通过输入框选中文件');
    return { method: 'input-after-click' };
  }

  const dump = await page.evaluate(() => ({
    url: location.href,
    buttons: [...document.querySelectorAll('button,[role=button]')]
      .map((x) => (x.innerText || x.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 40),
    fileInputs: [...document.querySelectorAll('input[type=file]')].map((x) => ({
      accept: x.accept,
      id: x.id,
      cls: x.className,
    })),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  })).catch(() => ({}));
  throw new Error(
    `未能触发 Select video / 选择文件。url=${dump.url || page.url()} buttons=${(dump.buttons || []).join('|').slice(0, 200)} inputs=${dump.fileInputs?.length || 0}`
  );
}

/** Wait until leave select-video splash and editor/post controls appear. */
/** Studio 封面/上传是否仍在 Uploading（此时写描述会被文件名冲掉） */
async function isStudioStillUploading(page) {
  return page.evaluate(() => {
    const blob = `${document.body?.innerText || ''}`.slice(0, 8000);
    // 封面区 Uploading… / 顶部进度；Uploaded 表示完成
    if (/\bUploaded\b/i.test(blob) && !/\bUploading\b/i.test(blob)) return false;
    if (/\bUploading(\.\.\.|…|\s|$)/i.test(blob)) return true;
    if (/\bProcessing\b|\b上传中\b|\b处理中\b/i.test(blob)) return true;
    // 封面灰块文案
    const nodes = [...document.querySelectorAll('div,span,p')].slice(0, 400);
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (/^Uploading(\.\.\.|…)?$/i.test(t)) return true;
    }
    return false;
  }).catch(() => false);
}

async function waitUploadEditorReady(page, timeoutMs = 180000, log = () => {}) {
  const end = Date.now() + timeoutMs;
  let sawEditor = false;
  let lastUploadLog = 0;
  while (Date.now() < end) {
    await dismissPublishDialogs(page, log);
    const selectSplash = await page.getByText(/Select video to upload/i).first().isVisible().catch(() => false);
    const hasCaption = await page.locator(
      'div[contenteditable="true"][role="combobox"], [data-e2e="caption_container"] [contenteditable="true"], textarea, [contenteditable="true"]'
    ).first().count().catch(() => 0);
    const hasPost = await page.getByRole('button', { name: /^(Post|Publish|发布|投稿)$/i }).first()
      .isVisible()
      .catch(() => false);
    const editing = await page.getByText(/Description|Add description|Describe your video|添加描述|作品描述|封面|Cover|Split|编辑/i).first()
      .isVisible()
      .catch(() => false);
    if (!selectSplash && (hasCaption > 0 || hasPost || editing)) {
      sawEditor = true;
    }
    const uploading = await isStudioStillUploading(page);
    if (uploading) {
      if (Date.now() - lastUploadLog > 4000) {
        log('上传：封面/视频仍在处理中，等待完成后再写描述…');
        lastUploadLog = Date.now();
      }
      await page.waitForTimeout(1500);
      continue;
    }
    // 必须看到编辑区，且上传已结束，才算就绪
    if (sawEditor && !uploading) {
      return true;
    }
    await page.waitForTimeout(1500);
  }
  return sawEditor;
}

/**
 * 在页面/iframe 里打分找 Studio 描述框（Description / Draft combobox）。
 * 不依赖 isVisible：遮罩下仍可能 attached。
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function locatePublishCaptionEditor(page) {
  const tryLocateIn = async (root) => {
    // 1) 经典选择器（attached 即可）
    const ordered = [
      'div[contenteditable="true"][role="combobox"]',
      '[data-e2e="caption_container"] [contenteditable="true"]',
      '[data-e2e="caption-input"] [contenteditable="true"]',
      '[data-e2e="new_video_caption"] [contenteditable="true"]',
      '[data-e2e="caption_container"] textarea',
      '.public-DraftEditor-content[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.DraftEditor-root [contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea',
    ];
    for (const sel of ordered) {
      const loc = root.locator(sel).first();
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const ph = String(await loc.getAttribute('placeholder').catch(() => '') || '');
      const aria = String(await loc.getAttribute('aria-label').catch(() => '') || '');
      if (/search|搜索|Search for post/i.test(`${ph} ${aria}`)) continue;
      // 排除明显不可用的隐藏节点（display:none）；opacity/被遮罩仍接受
      const usable = await loc.evaluate((el) => {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 12;
      }).catch(() => false);
      if (!usable) continue;
      return loc;
    }

    // 2) DOM 打分：靠近 Description 文案 / 带 /4000 字数 / combobox
    const marker = await root.evaluate(() => {
      const pick = [...document.querySelectorAll('[contenteditable="true"], textarea')];
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < pick.length; i += 1) {
        const el = pick[i];
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 12) continue;
        const aria = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`;
        if (/search|搜索|Search for post/i.test(aria)) continue;
        let score = 0;
        const role = el.getAttribute('role') || '';
        if (role === 'combobox') score += 50;
        if (role === 'textbox') score += 20;
        if (el.isContentEditable) score += 10;
        // 祖先文本含 Description
        let p = el.parentElement;
        let depth = 0;
        let nearDesc = false;
        let nearCounter = false;
        while (p && depth < 6) {
          const t = (p.innerText || '').slice(0, 500);
          if (/^Description$|Description\n|添加描述|作品描述|Describe your video/im.test(t)) nearDesc = true;
          if (/\d+\s*\/\s*(2200|4000|5000)/.test(t)) nearCounter = true;
          if (/#\s*Hashtags|@\s*(Friend|Mention)|话题|好友/i.test(t)) score += 15;
          p = p.parentElement;
          depth += 1;
        }
        if (nearDesc) score += 80;
        if (nearCounter) score += 40;
        // 上传页中部区域加分
        if (r.top > 80 && r.top < window.innerHeight * 0.85) score += 10;
        // 顶部搜索框通常很靠上且很矮
        if (r.top < 70 && r.height < 40) score -= 40;
        if (score > bestScore) {
          bestScore = score;
          best = { idx: i, score, tag: el.tagName, role };
        }
      }
      return best && best.score >= 20 ? best : null;
    }).catch(() => null);

    if (marker && Number.isFinite(marker.idx)) {
      return root.locator('[contenteditable="true"], textarea').nth(marker.idx);
    }
    return null;
  };

  // 主文档
  let hit = await tryLocateIn(page);
  if (hit) return hit;
  // iframe（少数 Studio 壳）
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      hit = await tryLocateIn(frame);
      if (hit) return hit;
    } catch { /* next frame */ }
  }
  return null;
}

/** 等待描述框出现（清遮罩 + 滚到 Details） */
async function waitForPublishCaptionEditor(page, timeoutMs = 45000, log = () => {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await dismissPublishDialogs(page, log).catch(() => {});
    await clearStuckPublishMask(page, log).catch(() => {});
    // 点一下 Description / Details 区域，促发编辑器挂载
    await page.getByText(/^Description$/i).first().click({ timeout: 800 }).catch(() => {});
    await page.getByText(/^Details$/i).first().click({ timeout: 600 }).catch(() => {});
    const loc = await locatePublishCaptionEditor(page);
    if (loc) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return loc;
    }
    await page.waitForTimeout(800);
  }
  return null;
}

/** 读取当前描述框文本 */
async function readPublishDescriptionText(loc) {
  return String(
    await loc.inputValue().catch(async () => loc.innerText().catch(() => '')) || ''
  ).replace(/\u00a0/g, ' ').trim();
}

/** 校验描述框内容是否已是我们要写的文案（不能把文件名占位当成成功） */
function descriptionLooksFilled(got, expected) {
  const g = String(got || '').replace(/\s+/g, ' ').trim();
  const e = String(expected || '').replace(/\s+/g, ' ').trim();
  if (!g || !e) return false;
  // 仍像本地文件名（m-时间戳-xxx / 纯文件 stem）→ 失败
  if (/^m-\d{10,}[-_][a-z0-9]+$/i.test(g)) return false;
  if (/^[a-f0-9]{16,}\.(mp4|mov|webm)?$/i.test(g)) return false;
  const head = e.slice(0, Math.min(16, e.length));
  if (head && g.toLowerCase().includes(head.toLowerCase())) return true;
  if (e.length >= 24) {
    const tail = e.slice(-12);
    if (g.toLowerCase().includes(e.slice(0, 10).toLowerCase()) && g.toLowerCase().includes(tail.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function looksLikeFilenameCaption(text) {
  const g = String(text || '').replace(/\s+/g, ' ').trim();
  if (!g) return false;
  if (/^m-\d{10,}[-_][a-z0-9]+$/i.test(g)) return true;
  if (/\.(mp4|mov|webm|avi)$/i.test(g) && g.length < 80) return true;
  if (/^[a-f0-9]{20,}$/i.test(g)) return true;
  return false;
}

/** 写入 Studio 上传页描述框正文（不含话题）。话题须走 fillPublishHashtagsViaSuggest。 */
async function fillPublishDescription(page, text, log = () => {}) {
  // Studio 描述上限常见 4000；略留余量（话题后续追加）
  let value = String(text || '');
  if (!value) return false;
  if (value.length > 3600) {
    value = value.slice(0, 3600);
    log(`发布描述过长，已截断至 ${value.length} 字`);
  }
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  const focusCaption = async (loc) => {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    // 先点 Description 标签附近，再点编辑器本体（Draft 偶发点到外壳不进焦）
    await page.getByText(/^Description$/i).first().click({ timeout: 600 }).catch(() => {});
    await loc.click({ timeout: 4000, force: true }).catch(() => loc.click({ timeout: 2000 }).catch(() => {}));
    await loc.focus().catch(() => {});
    await page.waitForTimeout(180);
  };

  const clearCaption = async (loc) => {
    await focusCaption(loc);
    // Draft 对 focus 会 collapseToEnd：先点再全选删除；并留空档，否则立刻插入会被吞掉
    await page.keyboard.press(`${mod}+A`).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(500);
    // Draft 清空后节点常会重建，旧 locator 失效——调用方需重新 locate
  };

  const insertCaption = async (loc) => {
    await focusCaption(loc);
    // 1) Playwright insertText（最稳）
    try {
      await page.keyboard.insertText(value);
      return 'insertText';
    } catch { /* fallthrough */ }
    // 2) execCommand
    const ok = await loc.evaluate((el, v) => {
      try {
        el.focus();
        // 选中全部后插入，避免叠在旧文案上
        const sel = window.getSelection();
        if (sel && el.childNodes.length) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return document.execCommand('insertText', false, v);
      } catch {
        return false;
      }
    }, value).catch(() => false);
    if (ok) return 'execCommand';
    // 3) 剪贴板粘贴（Draft 对 paste 事件支持较好）
    try {
      await page.evaluate(async (v) => {
        try {
          await navigator.clipboard.writeText(v);
          return true;
        } catch {
          // 无权限时塞到临时 textarea
          const ta = document.createElement('textarea');
          ta.value = v;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          return true;
        }
      }, value);
      await page.keyboard.press(`${mod}+V`);
      await page.waitForTimeout(200);
      return 'paste';
    } catch { /* fallthrough */ }
    // 4) 逐字输入
    if (value.length <= 600) {
      await page.keyboard.type(value, { delay: 8 });
      return 'type';
    }
    await page.keyboard.type(value.slice(0, 180), { delay: 6 });
    try { await page.keyboard.insertText(value.slice(180)); } catch {
      await page.keyboard.type(value.slice(180), { delay: 2 });
    }
    return 'type-chunk';
  };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      let loc = attempt === 1
        ? (await waitForPublishCaptionEditor(page, 30000, log))
        : (await locatePublishCaptionEditor(page) || await waitForPublishCaptionEditor(page, 12000, log));
      if (!loc) {
        log(`未找到 Description 描述框（第 ${attempt} 次）`);
        await page.waitForTimeout(1000);
        continue;
      }
      await clearCaption(loc);
      // Draft 重建后必须重新定位再写入
      await page.waitForTimeout(350);
      loc = await locatePublishCaptionEditor(page) || loc;
      const via = await insertCaption(loc);
      // 正文不含 #，一般无需关联想；若粘贴带 # 则关掉，避免挡后续操作
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      // 读文本也用新定位，避免读到已卸载节点
      const fresh = await locatePublishCaptionEditor(page) || loc;
      const got = await readPublishDescriptionText(fresh);
      if (descriptionLooksFilled(got, value)) {
        log(`发布描述正文已写入（${got.length} 字，via=${via}，第 ${attempt} 次）`);
        return true;
      }
      log(`描述写入未生效（第 ${attempt} 次，via=${via}，当前「${(got || '').slice(0, 36)}」），重试`);
    } catch (e) {
      log(`描述写入异常（第 ${attempt} 次）：${e.message || e}`);
    }
    await page.waitForTimeout(900);
  }
  return false;
}

/**
 * 按 Studio 联想下拉插入话题。
 *
 * 正确选中方式（用户确认）：
 * 输入 #关键词 → 等关键词联想弹层出现 → **选中弹层里的匹配项**（选中后弹层自动收起，并在描述框生成正式话题实体）。
 * 绝不能在未高亮任何联想项时直接在「发布描述」框里 Enter（只会换行/无效）。
 *
 * 关键修复：
 * 1) 弹层位置与结构兼容：
 *    - TikTok Studio 联想下拉项的新旧样式不一（有的左侧只渲染 `#` 图标，关键词本身不带 `#` 前缀，右侧为 `12.3K posts/videos`；有的直接是 `#keyword`；也有的通过 `[role="option"]` / `[role="listbox"]` 挂载）。
 *    - 弹层会根据视口空间出现在光标下方或上方，甚至挂载在 body 顶层 Portal，因此不再死卡 `r.top >= editorBottom - 8`，改为识别 `[role="listbox"]` / 浮层容器及光标/描述框附近的候选项。
 * 2) 防止 blur 导致弹层闪退未选中：
 *    - 真实 `mouse.click` 触发 `mousedown` 时若让 contenteditable 先失焦（blur），React 浮层会在 `click` 生效前卸载，导致“弹框出现并未选中”。
 *    - 优先在匹配的候选项节点（及其 `[role="option"]` / `li` 可点父节点）上派发带 `preventDefault` 保护的合成指针/鼠标事件链（pointerdown → mousedown → mouseup → click），保持编辑器焦点不丢失；
 *    - 若弹层仍未收起，再依次尝试键盘 `ArrowDown + Enter`（或直接对已高亮项 `Enter`）、Playwright 定位器点击、坐标点击。
 * 3) 严格校验是否真正成为话题实体：
 *    - 仅用 `/#tag\b/` 判断文本会误判（因为刚敲完 `#tag` 时纯文本本就存在）。
 *    - 必须同时校验：弹层已收起，且描述框内新增了话题标签 DOM 节点（如 `span[data-offset-key]` 独立实体、彩色/链接样式节点、或文本末尾已自动补齐空格/替换为联想词）。
 */
async function fillPublishHashtagsViaSuggest(page, hashtags, log = () => {}) {
  const normTag = (s) => String(s || '').trim().replace(/^#+/, '').toLowerCase();
  const tags = (Array.isArray(hashtags) ? hashtags : String(hashtags || '').split(/\s+/))
    .map((t) => String(t || '').replace(/^#+/, '').trim())
    .filter(Boolean);
  if (!tags.length) return { ok: true, inserted: 0, failed: [] };

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const failed = [];
  let inserted = 0;
  let scanSeq = 0;
  const pageAlive = () => !page.isClosed();

  const focusEnd = async () => {
    if (!pageAlive()) return null;
    const loc = await locatePublishCaptionEditor(page) || await waitForPublishCaptionEditor(page, 12000, log);
    if (!loc) return null;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 3000, force: true }).catch(() => {});
    await loc.focus().catch(() => {});
    await page.keyboard.press(`${mod}+End`).catch(() => page.keyboard.press('End').catch(() => {}));
    await page.waitForTimeout(120);
    return loc;
  };

  const dismissSuggest = async () => {
    if (!pageAlive()) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
  };

  const typeKeys = async (text, delay = 90) => {
    if (!pageAlive() || !text) return;
    await page.keyboard.type(String(text), { delay });
  };

  const cleanupMarks = async () => {
    if (!pageAlive()) return;
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-dsh-sug]')) {
        el.removeAttribute('data-dsh-sug');
      }
    }).catch(() => {});
  };

  /**
   * 统计当前描述框内的话题实体数量与末尾状态，用于区分「真正点中弹层生成了话题 chip」和「仅仅停留在敲入的纯文本 #tag」。
   */
  const inspectEditorHashtagState = async (tagName) => {
    if (!pageAlive()) return { text: '', rawText: '', chipCount: 0, hasTagChip: false, hasTrailingSpace: false };
    const want = normTag(tagName);
    return page.evaluate((wantTag) => {
      const eds = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter((el) => {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width >= 100 && r.height >= 12;
      });
      const ed = eds[0];
      if (!ed) return { text: '', rawText: '', chipCount: 0, hasTagChip: false, hasTrailingSpace: false };
      const rawText = String(ed.innerText || ed.textContent || ed.value || '').replace(/\u200b/g, '');
      const text = rawText.replace(/\u00a0/g, ' ').trim();

      let chipCount = 0;
      let hasTagChip = false;
      const edColor = window.getComputedStyle(ed).color;
      for (const node of ed.querySelectorAll('a, span, strong, b, em')) {
        const nt = String(node.innerText || node.textContent || '').replace(/[\s\u00a0\u200b]+/g, ' ').trim();
        if (!nt || !/^#[^\s#]+$/.test(nt)) continue;
        const st = window.getComputedStyle(node);
        const cls = `${node.className || ''} ${node.parentElement?.className || ''}`;
        const isEntity = node.tagName === 'A'
          || /hashtag|mention|topic|tag|highlight|link/i.test(cls)
          || node.hasAttribute('data-mention')
          || node.hasAttribute('data-hashtag')
          || (st.color && st.color !== edColor)
          || (st.fontWeight && Number(st.fontWeight) >= 600);
        if (isEntity) {
          chipCount += 1;
          const clean = nt.replace(/^#+/, '').toLowerCase();
          if (clean === wantTag || clean.startsWith(wantTag) || wantTag.startsWith(clean)) {
            hasTagChip = true;
          }
        }
      }

      const escaped = wantTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const trailingSpaceRe = new RegExp(`#${escaped}[A-Za-z0-9_\\u00C0-\\u024F\\u0400-\\u04FF\\u4e00-\\u9fff]*[\\s\\u00a0]+$`, 'i');
      const hasTagText = new RegExp(`#\\s*${escaped}(?![A-Za-z0-9_\\u00C0-\\u024F\\u0400-\\u04FF\\u4e00-\\u9fff])`, 'i').test(text);
      return {
        text,
        rawText,
        chipCount,
        hasTagChip,
        hasTagText,
        hasTrailingSpace: trailingSpaceRe.test(rawText),
      };
    }, want).catch(() => ({ text: '', rawText: '', chipCount: 0, hasTagChip: false, hasTagText: false, hasTrailingSpace: false }));
  };

  /**
   * 扫描关键词弹层行（兼容上下方向弹出、Portal 浮层、带 # 与不带 # 的列表项结构）。
   * 命中项会打上 `data-dsh-sug` 标记，供后续合成事件或定位器直接点击。
   */
  const findSuggestRows = async (tagName) => {
    if (!pageAlive()) return { open: false, rows: [], count: 0 };
    const want = normTag(tagName);
    const token = `s${Date.now().toString(36)}_${(scanSeq += 1)}`;
    return page.evaluate(({ wantTag, markPrefix }) => {
      const visible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 20 && r.height >= 12 && r.bottom > 0 && r.top < window.innerHeight + 20;
      };
      const textOf = (el) => String(el.innerText || el.textContent || '').replace(/[\s\u00a0\u200b]+/g, ' ').trim();
      const postsRe = /\b\d[\d,.]*\s*[KkMmBb]?\s*(posts?|videos?|views?|个视频|视频|作品|次观看)\b/i;
      const hashTokenRe = /(?:^|\s)#([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]{1,64})/;
      const bareWordRe = /^([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]{1,64})(?:\s+\d[\d,.]*\s*[KkMmBb]?\s*(?:posts?|videos?|views?|个视频|视频|作品|次观看)?)?$/i;
      const stopWords = /^(hashtags?|mentions?|friends?|topics?|upload|details|description|settings|location|post|discard|cancel|edit|cover|preview|feed|profile|web|following|for\s*you|search)$/i;

      // 定位描述框与光标锚点
      let editorRect = null;
      for (const ed of document.querySelectorAll('[contenteditable="true"], textarea')) {
        if (!visible(ed)) continue;
        const r = ed.getBoundingClientRect();
        if (r.width < 120) continue;
        if (!editorRect || r.width >= editorRect.width) editorRect = r;
      }

      let caretRect = null;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0).cloneRange();
          range.collapse(false);
          const rects = range.getClientRects();
          const cr = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
          if (cr && (cr.top > 0 || cr.left > 0)) caretRect = cr;
        }
      } catch { /* ignore */ }

      const anchorTop = caretRect ? caretRect.top : (editorRect ? editorRect.top : 120);
      const anchorBottom = caretRect ? caretRect.bottom : (editorRect ? editorRect.bottom : 360);
      const editorLeft = editorRect ? editorRect.left : 180;
      const editorRight = editorRect ? editorRect.right : window.innerWidth - 200;

      // 判断节点是否位于浮动弹层 / 联想列表容器内
      const isInSuggestContainer = (el) => {
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 9) {
          const role = (cur.getAttribute('role') || '').toLowerCase();
          if (role === 'listbox' || role === 'menu' || role === 'option') return true;
          const cls = `${cur.className || ''} ${cur.getAttribute('data-e2e') || ''} ${cur.id || ''}`;
          if (/suggest|mention|hashtag|autocomplete|typeahead|dropdown|popover|popup|popper|option|menu|portal|floating/i.test(cls)) {
            return true;
          }
          const st = window.getComputedStyle(cur);
          if ((st.position === 'fixed' || st.position === 'absolute') && Number.parseInt(st.zIndex || '0', 10) >= 10) {
            return true;
          }
          cur = cur.parentElement;
          depth += 1;
        }
        return false;
      };

      // 找到弹层项的可点击行容器（优先 role=option / li / 弹层列表的直接子项）
      const resolveClickableRow = (el) => {
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 6) {
          const role = (cur.getAttribute('role') || '').toLowerCase();
          if (role === 'option' || role === 'menuitem' || cur.tagName === 'LI' || cur.tagName === 'BUTTON') {
            return cur;
          }
          const parentRole = (cur.parentElement?.getAttribute('role') || '').toLowerCase();
          if (parentRole === 'listbox' || parentRole === 'menu') {
            return cur;
          }
          const cls = `${cur.className || ''} ${cur.getAttribute('data-e2e') || ''}`;
          if (/item|option|row|candidate|suggest-item|hashtag-item/i.test(cls)) {
            const r = cur.getBoundingClientRect();
            if (r.height >= 18 && r.height <= 88 && r.width <= 760) return cur;
          }
          cur = cur.parentElement;
          depth += 1;
        }
        let p = el;
        let d = 0;
        while (p && p !== document.body && d < 4) {
          const st = window.getComputedStyle(p);
          if (st.cursor === 'pointer' && p.parentElement && window.getComputedStyle(p.parentElement).cursor !== 'pointer') {
            const r = p.getBoundingClientRect();
            if (r.height >= 18 && r.height <= 88 && r.width <= 760) return p;
          }
          p = p.parentElement;
          d += 1;
        }
        return el;
      };

      const isActiveRow = (el) => {
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 4) {
          if (cur.getAttribute('aria-selected') === 'true' || cur.getAttribute(' data-selected') === 'true') return true;
          const cls = String(cur.className || '');
          if (/\b(active|selected|focused|highlighted|is-active|is-selected)\b/i.test(cls)) return true;
          cur = cur.parentElement;
          depth += 1;
        }
        return false;
      };

      const extractHit = (t, inPopup) => {
        if (!t || t.length > 110) return '';
        if (/^#\s*Hashtags$/i.test(t) || /^@\s*(Mention|Friend)/i.test(t)) return '';
        const hm = t.match(hashTokenRe);
        if (hm && hm[1]) {
          const w = hm[1].replace(/^#+/, '').toLowerCase();
          if (!stopWords.test(w)) return w;
        }
        // 兼容不带 # 号但有 posts 计数、或位于明确联想容器内且与输入词匹配的项
        if (postsRe.test(t) || inPopup) {
          const cleaned = t.replace(/^#\s*/, '').trim();
          const bm = cleaned.match(bareWordRe) || cleaned.match(/^([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]{1,64})\b/);
          if (bm && bm[1]) {
            const w = bm[1].toLowerCase();
            if (!stopWords.test(w)) {
              if (postsRe.test(t)) return w;
              if (inPopup && wantTag && (w === wantTag || w.startsWith(wantTag) || wantTag.startsWith(w))) return w;
            }
          }
        }
        return '';
      };

      for (const old of document.querySelectorAll('[data-dsh-sug]')) {
        old.removeAttribute('data-dsh-sug');
      }

      const raw = [];
      const seenRowEl = new Set();
      const nodes = document.querySelectorAll('[role="option"], [role="menuitem"], li, div, span, p, button, a');
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        if (!visible(el)) continue;
        if (el.getAttribute('contenteditable') === 'true') continue;
        if (el.closest && el.closest('[contenteditable="true"], textarea')) continue;
        // 排除右侧手机预览区及导航链接
        if (el.tagName === 'A' && el.getAttribute('href')) continue;
        if (el.closest && el.closest('[class*="preview" i], [data-e2e*="preview" i], nav, header')) continue;

        const r = el.getBoundingClientRect();
        if (r.height > 88 || r.height < 12 || r.width > 760 || r.width < 20) continue;
        // 水平方向不能偏离描述框太远（排除右侧预览卡和左侧主导航）
        if (r.right < editorLeft - 60 || r.left > editorRight + 60) continue;
        // 垂直方向允许在描述框上方或下方弹出
        if (r.bottom < anchorTop - 380 || r.top > anchorBottom + 500) continue;

        const inPopup = isInSuggestContainer(el);
        const t = textOf(el);
        const hit = extractHit(t, inPopup);
        if (!hit) continue;

        // 若不在明确浮层容器内，则必须满足以 # 开头或带 posts 数量，且不能是描述框上方的静态标签
        if (!inPopup && !/^#/.test(t) && !postsRe.test(t)) continue;

        // 叶子/行级去重：若子元素能提取出相同的 hit 且带计数或同文本，则跳过外层大盒子
        const hasMoreSpecificChild = [...el.children].some((c) => {
          if (!visible(c)) return false;
          const cr = c.getBoundingClientRect();
          if (cr.height < 12 || cr.width < 20) return false;
          const ct = textOf(c);
          const ch = extractHit(ct, inPopup);
          return ch === hit && (postsRe.test(ct) || !postsRe.test(t));
        });
        if (hasMoreSpecificChild) continue;

        const clickEl = resolveClickableRow(el);
        const cr = clickEl.getBoundingClientRect();
        const rowText = textOf(clickEl) || t;
        const hasPosts = postsRe.test(rowText);
        const exact = hit === wantTag;
        const prefix = exact || (wantTag ? (hit.startsWith(wantTag) || wantTag.startsWith(hit)) : false);
        const dist = Math.min(Math.abs(cr.top - anchorBottom), Math.abs(cr.bottom - anchorTop));

        raw.push({
          clickEl,
          leafEl: el,
          hit,
          text: rowText.slice(0, 72),
          exact,
          prefix,
          inPopup,
          hasPosts,
          active: isActiveRow(clickEl),
          cx: Math.round(cr.left + Math.min(80, Math.max(24, cr.width * 0.3))),
          cy: Math.round(cr.top + cr.height * 0.5),
          top: Math.round(cr.top),
          left: Math.round(cr.left),
          w: Math.round(cr.width),
          h: Math.round(cr.height),
          dist: Math.round(dist),
        });
      }

      raw.sort((a, b) => {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
        if (a.hasPosts !== b.hasPosts) return a.hasPosts ? -1 : 1;
        if (a.inPopup !== b.inPopup) return a.inPopup ? -1 : 1;
        return a.top - b.top || a.left - b.left;
      });

      const rows = [];
      for (const item of raw) {
        if (rows.length >= 16) break;
        if (seenRowEl.has(item.clickEl)) continue;
        seenRowEl.add(item.clickEl);
        const idx = rows.length;
        const mark = `${markPrefix}_${idx}`;
        try {
          item.clickEl.setAttribute('data-dsh-sug', mark);
          if (item.leafEl && item.leafEl !== item.clickEl) {
            item.leafEl.setAttribute('data-dsh-sug-leaf', mark);
          }
        } catch { /* ignore */ }
        rows.push({
          mark,
          hit: item.hit,
          text: item.text,
          exact: item.exact,
          prefix: item.prefix,
          inPopup: item.inPopup,
          hasPosts: item.hasPosts,
          active: item.active,
          cx: item.cx,
          cy: item.cy,
          top: item.top,
          left: item.left,
          w: item.w,
          h: item.h,
        });
      }

      return { open: rows.length >= 1, rows, count: raw.length };
    }, { wantTag: want, markPrefix: token }).catch(() => ({ open: false, rows: [], count: 0 }));
  };

  const waitSuggestRows = async (tagName, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    let last = { open: false, rows: [], count: 0 };
    while (Date.now() < end) {
      if (!pageAlive()) return last;
      last = await findSuggestRows(tagName);
      if (last.open && last.rows && last.rows.length) return last;
      await page.waitForTimeout(180);
    }
    return last;
  };

  const clearTrailingHashJunk = async (protectNorm = []) => {
    if (!pageAlive()) return;
    const protect = new Set((protectNorm || []).map(normTag).filter(Boolean));
    await dismissSuggest();
    await focusEnd();
    for (let i = 0; i < 80; i += 1) {
      const loc = await locatePublishCaptionEditor(page);
      if (!loc) break;
      const t = await readPublishDescriptionText(loc);
      if (!t) break;
      const m = t.match(/(#\s*([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]*))$/);
      if (!m) break;
      const hit = normTag(m[2] || '');
      if (hit && protect.has(hit)) {
        if (!/\s$/.test(t)) await typeKeys(' ', 30);
        return;
      }
      await page.keyboard.press('Backspace').catch(() => {});
    }
  };

  /**
   * 校验话题是否已通过联想弹层真正选中（而非仅残留在描述框里的纯文本）：
   * 1) 弹层已关闭，且
   * 2) 话题实体 chip 数量增加 / 检测到该话题的实体节点 / 文本末尾已被自动补齐空格或替换为完整联想词。
   */
  const verifyHashtagSelected = async (tagName, baselineState, pickedHit = '') => {
    const still = await findSuggestRows(tagName);
    const cur = await inspectEditorHashtagState(pickedHit || tagName);
    const origState = pickedHit && normTag(pickedHit) !== normTag(tagName)
      ? await inspectEditorHashtagState(tagName)
      : cur;
    const hasTagText = Boolean(cur.hasTagText || origState.hasTagText);
    if (!hasTagText) return { selected: false, popupOpen: still.open, state: cur };

    const chipAdded = cur.chipCount > (baselineState?.chipCount || 0) || cur.hasTagChip || origState.hasTagChip;
    const replacedWithLonger = Boolean(
      pickedHit && normTag(pickedHit) !== normTag(tagName) && cur.hasTagText
    );
    const selected = !still.open && (chipAdded || cur.hasTrailingSpace || origState.hasTrailingSpace || replacedWithLonger);
    return {
      selected,
      hasTagText,
      popupOpen: still.open,
      chipAdded,
      state: cur,
    };
  };

  /**
   * 选中弹层中的匹配项（多级无失焦/抗闪退策略）：
   * 策略 1：在目标 DOM 元素上直接派发合成 pointerdown/mousedown/mouseup/click 事件链（不触发描述框 blur 闪退）。
   * 策略 2：键盘方向键高亮 + Enter 选中（Draft.js / Slate 原生无失焦方式）。
   * 策略 3：Playwright 定位器与真实鼠标坐标点击兜底。
   */
  const selectSuggestInPopup = async (tagName, state, baselineState) => {
    const want = normTag(tagName);
    const pickBest = (rows = []) => rows.find((r) => normTag(r.hit) === want)
      || rows.find((r) => {
        const h = normTag(r.hit);
        return h.startsWith(want) || want.startsWith(h);
      })
      || rows[0];

    let pick = pickBest((state && state.rows) || []);
    if (!pick) return { how: '', verified: false };

    const fuzzySuffix = pick.exact || normTag(pick.hit) === want ? '' : '-fuzzy';
    log(`话题 #${tagName}：尝试选中弹层项「${pick.text || ('#' + pick.hit)}」@(${pick.cx},${pick.cy})`);

    // 策略 1：合成指针/鼠标事件链（直接在候选节点及子叶节点触发，阻止 mousedown 默认失焦）
    const synthOk = await page.evaluate((mark) => {
      const rowEl = document.querySelector(`[data-dsh-sug="${mark}"]`);
      const leafEl = document.querySelector(`[data-dsh-sug-leaf="${mark}"]`) || rowEl;
      if (!rowEl && !leafEl) return false;
      const targets = [leafEl, rowEl].filter((x, idx, arr) => x && arr.indexOf(x) === idx);
      for (const target of targets) {
        const r = target.getBoundingClientRect();
        const cx = r.left + Math.min(60, Math.max(16, r.width * 0.35));
        const cy = r.top + r.height * 0.5;
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: cx,
          clientY: cy,
          screenX: cx,
          screenY: cy,
          button: 0,
          buttons: 1,
          detail: 1,
        };
        const fire = (type, extra = {}) => {
          const isPtr = /^pointer/.test(type) && typeof PointerEvent === 'function';
          const Ctor = isPtr ? PointerEvent : MouseEvent;
          const ev = new Ctor(type, {
            ...init,
            ...(isPtr ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {}),
            ...extra,
          });
          target.dispatchEvent(ev);
        };
        fire('pointerover', { buttons: 0 });
        fire('mouseover', { buttons: 0 });
        fire('pointermove', { buttons: 0 });
        fire('mousemove', { buttons: 0 });
        fire('pointerdown', { buttons: 1 });
        fire('mousedown', { buttons: 1 });
        fire('pointerup', { buttons: 0 });
        fire('mouseup', { buttons: 0 });
        fire('click', { buttons: 0 });
      }
      return true;
    }, pick.mark).catch(() => false);

    if (synthOk) {
      await page.waitForTimeout(260);
      const v1 = await verifyHashtagSelected(tagName, baselineState, pick.hit);
      if (v1.selected) {
        return { how: `popup-synth-click${fuzzySuffix}`, verified: true, pickedHit: pick.hit };
      }
    }

    // 策略 2：键盘导航选中（保持焦点在描述框内，通过 ArrowDown / Enter 让编辑器插件自己消费选中）
    let fresh = await findSuggestRows(tagName);
    if (fresh.open && fresh.rows.length) {
      pick = pickBest(fresh.rows) || pick;
      const targetIdx = Math.max(0, fresh.rows.findIndex((r) => r.mark === pick.mark));
      const firstActive = fresh.rows[0]?.active;
      // 若首项尚未高亮，或目标项不是第 0 项，先按 ArrowDown 移动高亮
      const downSteps = firstActive ? targetIdx : (targetIdx + 1);
      for (let s = 0; s < Math.min(downSteps, 6); s += 1) {
        await page.keyboard.press('ArrowDown').catch(() => {});
        await page.waitForTimeout(110);
      }
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(280);
      const v2 = await verifyHashtagSelected(tagName, baselineState, pick.hit);
      if (v2.selected) {
        return { how: `popup-key-enter${fuzzySuffix}`, verified: true, pickedHit: pick.hit };
      }
      // 有些 Studio 版本默认首项已处于预选中态，一次 ArrowDown 反而跳到第二项或需要再试 Tab/Enter
      fresh = await findSuggestRows(tagName);
      if (fresh.open) {
        await page.keyboard.press('ArrowUp').catch(() => {});
        await page.waitForTimeout(90);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(260);
        const v2b = await verifyHashtagSelected(tagName, baselineState, pick.hit);
        if (v2b.selected) {
          return { how: `popup-up-enter${fuzzySuffix}`, verified: true, pickedHit: pick.hit };
        }
      }
    }

    // 策略 3：真实鼠标悬停 + 点击（先在目标节点上拦截 mousedown 默认失焦行为，避免 blur 先关掉弹层）
    fresh = await findSuggestRows(tagName);
    if (fresh.open && fresh.rows.length) {
      pick = pickBest(fresh.rows) || pick;
      await page.evaluate((mark) => {
        const el = document.querySelector(`[data-dsh-sug="${mark}"]`);
        if (!el) return;
        const guard = (e) => e.preventDefault();
        el.addEventListener('mousedown', guard, { capture: true, once: true });
        el.addEventListener('pointerdown', guard, { capture: true, once: true });
      }, pick.mark).catch(() => {});

      const loc = page.locator(`[data-dsh-sug="${pick.mark}"]`).first();
      const hasLoc = await loc.count().catch(() => 0);
      if (hasLoc) {
        await loc.hover({ timeout: 1200 }).catch(() => {});
        await page.waitForTimeout(80);
        await loc.click({ timeout: 2000, delay: 35 }).catch(() => {});
      } else if (Number.isFinite(pick.cx) && Number.isFinite(pick.cy)) {
        await page.mouse.move(pick.cx, pick.cy).catch(() => {});
        await page.waitForTimeout(80);
        await page.mouse.click(pick.cx, pick.cy, { delay: 40 }).catch(() => {});
      }
      await page.waitForTimeout(280);
      const v3 = await verifyHashtagSelected(tagName, baselineState, pick.hit);
      if (v3.selected || (!v3.popupOpen && v3.hasTagText)) {
        return { how: `popup-mouse-click${fuzzySuffix}`, verified: true, pickedHit: pick.hit };
      }
    }

    const vFinal = await verifyHashtagSelected(tagName, baselineState, pick.hit);
    if (!vFinal.popupOpen && vFinal.hasTagText && vFinal.chipAdded) {
      return { how: `popup-fallback${fuzzySuffix}`, verified: true, pickedHit: pick.hit };
    }
    return { how: '', verified: false, pickedHit: pick.hit };
  };

  const doneNorm = [];
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    try {
      if (!pageAlive()) {
        failed.push(tag);
        log(`话题 #${tag}：页面已关闭，中止`);
        break;
      }

      await clearTrailingHashJunk(doneNorm);
      const loc = await focusEnd();
      if (!loc) {
        failed.push(tag);
        log(`话题 #${tag}：找不到描述框`);
        continue;
      }

      const cur = await readPublishDescriptionText(loc);
      if (cur && !/\s$/.test(cur)) {
        await typeKeys(' ', 40);
      }

      const baselineState = await inspectEditorHashtagState(tag);

      // 在描述框输入 #关键词，触发弹层（此时焦点仍在描述框，正常）
      await typeKeys('#', 60);
      await page.waitForTimeout(200);
      log(`话题 #${tag}：已输入 #，输入关键词并等待弹层…`);
      await typeKeys(tag, 95);
      await page.waitForTimeout(450);

      // 必须等到弹层行出现；没有弹层就不能在描述框里瞎 Enter
      let state = await waitSuggestRows(tag, 8000);
      if (!state.open || !state.rows.length) {
        // 再敲末字触发一次
        if (tag.length > 2) {
          await page.keyboard.press('Backspace').catch(() => {});
          await page.waitForTimeout(200);
          await typeKeys(tag.slice(-1), 100);
          state = await waitSuggestRows(tag, 5000);
        }
      }

      if (!state.open || !state.rows.length) {
        log(`话题 #${tag}：关键词弹层未出现，无法聚焦列表，已清理残片`);
        await clearTrailingHashJunk(doneNorm);
        failed.push(tag);
        continue;
      }

      const preview = state.rows.slice(0, 5).map((r) => r.text || r.hit).join(' | ');
      log(`话题 #${tag}：弹层已出（${state.rows.length} 项）：${preview}`);

      let selResult = await selectSuggestInPopup(tag, state, baselineState);

      // 若首次选中未成功（例如弹层被意外关闭而未转成实体），重敲末字再唤起弹层重试一次
      if (!selResult.verified && tag.length >= 2) {
        log(`话题 #${tag}：首次点击弹层未完成选中，重敲末字重试一次…`);
        await focusEnd();
        const midText = await readPublishDescriptionText((await locatePublishCaptionEditor(page)) || loc);
        if (new RegExp(`#\\s*${escapeRe(tag)}$`, 'i').test(midText || '')) {
          await page.keyboard.press('Backspace').catch(() => {});
          await page.waitForTimeout(180);
          await typeKeys(tag.slice(-1), 95);
          await page.waitForTimeout(350);
          const retryState = await waitSuggestRows(tag, 4500);
          if (retryState.open && retryState.rows.length) {
            selResult = await selectSuggestInPopup(tag, retryState, baselineState);
          }
        }
      }

      const still = await findSuggestRows(tag);
      if (still.open) await dismissSuggest();

      const after = await readPublishDescriptionText(
        (await locatePublishCaptionEditor(page)) || loc
      );
      const pickedTag = selResult.pickedHit || tag;
      const finalState = await inspectEditorHashtagState(pickedTag);
      const tagExists = Boolean(
        finalState.hasTagText
        || new RegExp(`#\\s*(?:${escapeRe(tag)}|${escapeRe(pickedTag)})(?:\\s|$)`, 'i').test(after || '')
      );

      if (selResult.verified && tagExists) {
        inserted += 1;
        doneNorm.push(normTag(tag));
        if (pickedTag) doneNorm.push(normTag(pickedTag));
        if (after && !/\s$/.test(after)) {
          await focusEnd();
          await typeKeys(' ', 30);
        }
        log(`话题已通过弹层选中：#${pickedTag}（${selResult.how}）`);
      } else {
        log(`话题 #${tag} 弹层选中后未生效，清理残片。末尾「${(after || '').slice(-48)}」`);
        await clearTrailingHashJunk(doneNorm);
        failed.push(tag);
      }
    } catch (e) {
      failed.push(tag);
      const msg = String(e && e.message ? e.message : e);
      log(`话题 #${tag} 插入异常：${msg}`);
      if (/closed|Target page|browser has been closed/i.test(msg)) break;
      await clearTrailingHashJunk(doneNorm).catch(() => {});
    } finally {
      await cleanupMarks();
    }
  }

  return { ok: failed.length === 0, inserted, failed };
}

/** 正文 + 话题：正文粘贴，话题走联想下拉（正确方式） */
async function fillPublishCaptionWithHashtags(page, bodyText, hashtags, log = () => {}) {
  const body = String(bodyText || '').trim();
  const tags = (Array.isArray(hashtags) ? hashtags : String(hashtags || '').split(/\s+/))
    .map((t) => String(t || '').replace(/^#+/, '').trim())
    .filter(Boolean);

  if (!body && !tags.length) return false;

  let bodyOk = true;
  if (body) {
    bodyOk = await fillPublishDescription(page, body, log);
    if (!bodyOk) return false;
  } else {
    // 仅话题：先清空默认文件名
    const loc = await waitForPublishCaptionEditor(page, 20000, log);
    if (loc) {
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await loc.click({ timeout: 3000, force: true }).catch(() => {});
      await page.keyboard.press(`${mod}+A`).catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  if (!tags.length) return bodyOk;

  log(`开始按联想下拉写入 ${tags.length} 个话题…`);
  const tagResult = await fillPublishHashtagsViaSuggest(page, tags, log);
  if (tagResult.failed.length) {
    log(`话题未完全写入：成功 ${tagResult.inserted}/${tags.length}，失败 ${tagResult.failed.map((t) => `#${t}`).join(' ')}`);
  } else {
    log(`全部话题已按联想方式写入（${tagResult.inserted} 个）`);
  }
  // 正文成功即可继续发布；话题失败只告警（避免整单卡死）
  return bodyOk || tagResult.inserted > 0;
}

/** 读取当前页面上的发布描述（用于发布前复核） */
async function peekPublishDescription(page) {
  const loc = await locatePublishCaptionEditor(page);
  if (!loc) return '';
  return readPublishDescriptionText(loc);
}

async function readSetting(key, fallback) {
  try {
    return await dataStore.getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

async function loadMaterial(materialId, log = () => {}) {
  const fs = require('node:fs');
  let material;
  try {
    log(`读取素材 #${materialId} 元数据`);
    material = await phpApi.get(`/node/materials/${materialId}`);
  } catch (e) {
    throw new Error(e.message || '素材不存在');
  }
  if (!material) throw new Error('素材不存在');
  // 线下素材模式：只使用数据库中的本机绝对路径，不再从服务器下载
  const localPath = String(material.file_path || material.filePath || '').trim();
  if (!localPath) {
    throw new Error(`素材 #${materialId} 未绑定本机路径（线下素材模式，请重新添加本地视频）`);
  }
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    throw new Error(`本机找不到素材文件：${localPath}`);
  }
  log(`使用本机素材文件：${localPath}`);
  material.file_path = localPath;
  material.filePath = localPath;
  return material;
}

/** Click a button even if a dim mask intercepts pointer events. */
async function forceClick(locator, label, log = () => {}) {
  if (!(await locator.count().catch(() => 0))) return false;
  // Prefer visible; still force-click if attached (mask may cover it)
  const attached = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }).catch(() => false);
  if (!attached && !(await locator.isVisible().catch(() => false))) return false;
  if (await locator.isDisabled().catch(() => false)) return false;
  await locator.click({ timeout: 5000, force: true }).catch(async () => {
    await locator.evaluate((el) => el.click()).catch(() => null);
  });
  log(`弹窗：已点击 ${label}`);
  return true;
}

/**
 * 判断页面或子 Frame 中是否存在正在加载或已渲染的人机验证/旋转验证弹窗。
 * 存在时绝不能按 Escape、点 Close 或强拆全屏遮罩，否则会把验证弹框打成白屏或触发 "Something went wrong"。
 */
async function hasActiveOrLoadingCaptchaModal(page) {
  if (!page || page.isClosed?.()) return false;
  if (page.__tkNoCaptchaSolving) return true;
  try {
    const { detectRotateCaptcha } = require('./nocaptchaai');
    const det = await detectRotateCaptcha(page);
    if (det?.detected || det?.loading || det?.containerPending) return true;
  } catch { /* ignore */ }

  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle?.(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      return r.width > 12 && r.height > 12;
    };
    const captchaSelectors = [
      '.TUXModal.captcha-verify-container',
      '#captcha-verify-container',
      '.captcha_verify_container',
      '[class*="captcha-verify-container" i]',
      '[class*="captcha_verify_container" i]',
      '[id*="captcha-verify" i]',
      '[class*="secsdk-captcha" i]',
      '[class*="secsdk_captcha" i]',
      'iframe[src*="captcha" i]',
      'iframe[src*="verify" i]',
      'iframe[src*="secsdk" i]',
    ];
    for (const sel of captchaSelectors) {
      if (Array.from(document.querySelectorAll(sel)).some(vis)) return true;
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .TUXModal')).filter(vis);
    for (const d of dialogs) {
      const idCls = `${d.id || ''} ${d.className || ''}`;
      const txt = String(d.innerText || '');
      if (
        /captcha|secsdk|verify-container/i.test(idCls)
        || /drag the slider|fit the puzzle|verify to continue|verify you are human|拖动滑块|完成拼图|旋转|安全验证|人机验证/i.test(txt)
        || d.querySelector('#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="secsdk" i], iframe')
      ) {
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

/**
 * Remove orphan full-screen dim layers that block clicks after a modal was dismissed
 * without leaving Cancel/close. Prefer Escape first; only strip inert backdrops.
 */
async function clearStuckPublishMask(page, log = () => {}) {
  // 若当前存在或正在加载人机验证弹框，先交由 NoCaptchaAI 处理，严禁按 Escape / 拆遮罩导致验证弹框白屏
  if (await hasActiveOrLoadingCaptchaModal(page)) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page, { log });
    } catch { /* ignore */ }
    if (await hasActiveOrLoadingCaptchaModal(page)) return 0;
  }

  // Never Escape while a publish confirm or captcha is on screen — that cancels Post now / Turn on or breaks captcha
  const confirmLive = await page.evaluate(() => {
    const t = String(document.body?.innerText || '');
    return /Continue to post|Turn on automatic content checks|copyright check is incomplete|drag the slider|fit the puzzle|verify to continue|安全验证|人机验证/i.test(t)
      || !!Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^(Post now|Turn on)$/i.test(String(b.innerText || '').trim()));
  }).catch(() => false);
  if (confirmLive) return 0;

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);

  if (await hasActiveOrLoadingCaptchaModal(page)) return 0;

  // Close (X) only on leftover dialogs that are NOT publish confirms and NOT captcha modals
  const junkDialog = page.locator('[role="dialog"]').filter({
    hasNotText: /Continue to post|automatic content checks|Post now|Turn on|drag the slider|fit the puzzle|verify|captcha|安全验证|人机验证|拖动滑块|旋转/i,
  }).first();
  if (await junkDialog.count().catch(() => 0) && await junkDialog.isVisible().catch(() => false)) {
    const isCaptchaDialog = await junkDialog.evaluate((el) => {
      const idCls = `${el.id || ''} ${el.className || ''}`;
      if (/captcha|secsdk|verify/i.test(idCls)) return true;
      return Boolean(el.querySelector('#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="secsdk" i], iframe'));
    }).catch(() => true);
    if (!isCaptchaDialog) {
      const closeBtn = junkDialog.locator(
        'button[aria-label*="Close" i], button[aria-label*="关闭" i], [class*="close" i]'
      ).first();
      if (await closeBtn.count().catch(() => 0)) {
        await closeBtn.click({ force: true, timeout: 2000 }).catch(() => {});
      }
    }
  }

  const removed = await page.evaluate(() => {
    let n = 0;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const CAPTCHA_SEL = '.TUXModal.captcha-verify-container, #captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="Captcha"], [class*="secsdk" i], iframe[src*="captcha" i], iframe[src*="verify" i], iframe[src*="secsdk" i]';
    if (document.querySelector(CAPTCHA_SEL)) return 0;
    const nodes = Array.from(document.querySelectorAll('body *'));
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.85 || r.height < vh * 0.85) continue;
      const idCls = `${el.id || ''} ${el.className || ''}`;
      if (/captcha|secsdk|verify|TUXModal/i.test(idCls)) continue;
      if (el.closest?.(CAPTCHA_SEL) || el.querySelector?.(CAPTCHA_SEL) || el.querySelector?.('iframe')) continue;
      const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      // Keep real confirm dialogs & captcha dialogs
      if (/Continue to post|Turn on automatic content checks|Post now|copyright check is incomplete|drag the slider|fit the puzzle|verify|captcha|安全验证|人机验证|拖动滑块|旋转/i.test(text)) {
        continue;
      }
      const buttons = el.querySelectorAll('button, [role="button"]');
      const actionable = Array.from(buttons).filter((b) => {
        const t = String(b.innerText || b.getAttribute('aria-label') || '').trim();
        return t && !/^x$/i.test(t);
      });
      // Orphan dim mask: covers viewport, no real actions (or only close)
      const bg = style.backgroundColor || '';
      const z = Number.parseInt(style.zIndex, 10) || 0;
      const looksMask = z >= 50 || /rgba?\(\s*0,\s*0,\s*0/i.test(bg) || style.backdropFilter !== 'none';
      if (!looksMask) continue;
      if (actionable.length > 1) continue;
      if (text.length > 80 && actionable.length > 0) continue;
      el.style.pointerEvents = 'none';
      el.style.opacity = '0';
      el.setAttribute('data-tkswarm-mask-cleared', '1');
      // Detach pure backdrops with almost no content
      if (text.length < 40 && actionable.length === 0) {
        el.remove();
        n += 1;
      } else {
        n += 1;
      }
    }
    return n;
  }).catch(() => 0);

  if (removed > 0) log(`弹窗：已清除卡住遮罩 ×${removed}`);
  return removed;
}

/**
 * Auto-dismiss Studio publish modals if present.
 * - "Turn on automatic content checks?" → Turn on
 * - "Continue to post?" → Post now (critical)
 * Never click Cancel. Uses force click to pierce dim layers.
 */
async function dismissPublishDialogs(page, log = () => {}) {
  try {
    const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }
  const clicked = [];
  const tryLabels = async (patterns, label) => {
    for (const re of patterns) {
      const byRole = page.getByRole('button', { name: re }).first();
      if (await forceClick(byRole, label, log)) {
        clicked.push(label);
        await page.waitForTimeout(500);
        return true;
      }
      const byText = page.locator('button, [role="button"]').filter({ hasText: re }).first();
      if (await forceClick(byText, label, log)) {
        clicked.push(label);
        await page.waitForTimeout(500);
        return true;
      }
    }
    // Deep click in frames / non-button nodes
    const hit = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'));
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!rx.test(text) || text.length > 24) continue;
        el.click();
        return text;
      }
      return '';
    }, patterns[0].source || String(patterns[0])).catch(() => '');
    if (hit) {
      clicked.push(label);
      log(`弹窗：已点击 ${label}（深层）`);
      await page.waitForTimeout(500);
      return true;
    }
    return false;
  };

  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 12000)).catch(() => '');
  const blob = String(body || '').replace(/\s+/g, ' ');

  // Prefer Post now confirmation first (publish gate)
  if (/Continue to post|copyright check is incomplete|Post now|继续发布|版权检测未完成/i.test(blob)
    || await page.getByRole('button', { name: /^Post now$/i }).count().catch(() => 0)) {
    if (await tryLabels([/^Post now$/i, /^立即发布$/, /^继续发布$/], 'Post now')) {
      await clearStuckPublishMask(page, log);
      return clicked;
    }
  }

  // Content-check opt-in modal (strict title — avoid matching page "Music copyright check" toggle)
  if (/Turn on automatic content checks|automatic content checks\?/i.test(blob)
    || (/Content check lite/i.test(blob) && /Turn on/i.test(blob) && /Cancel/i.test(blob))) {
    if (await tryLabels([/^Turn on$/i, /^Enable$/i, /^开启$/, /^启用$/], 'Turn on')) {
      await clearStuckPublishMask(page, log);
      return clicked;
    }
  }

  // Visible Post now even if body text snapshot missed it
  if (await tryLabels([/^Post now$/i], 'Post now')) {
    await clearStuckPublishMask(page, log);
    return clicked;
  }

  // If dim mask remains with no actionable dialog, clear it
  const hasPostNow = await page.getByRole('button', { name: /^Post now$/i }).count().catch(() => 0);
  const hasTurnOn = await page.getByRole('button', { name: /^Turn on$/i }).count().catch(() => 0);
  if (!hasPostNow && !hasTurnOn) {
    await clearStuckPublishMask(page, log);
  }

  return clicked;
}

/** Wait copyright scan idle, or keep confirming Post now while checking. */
async function settleCopyrightAndConfirms(page, timeoutMs = 60000, log = () => {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await dismissPublishDialogs(page, log);
    const checking = await page.getByText(/Checking in progress|still checking your video|This will take about|检测中|正在检查/i)
      .first()
      .isVisible()
      .catch(() => false);
    const postNowVisible = await page.getByRole('button', { name: /^Post now$/i }).first()
      .isVisible()
      .catch(() => false);
    if (postNowVisible) {
      await forceClick(page.getByRole('button', { name: /^Post now$/i }).first(), 'Post now', log);
      await page.waitForTimeout(800);
      continue;
    }
    if (!checking) {
      await clearStuckPublishMask(page, log);
      return true;
    }
    // Checking under a stuck dim layer — peel mask so Post/Post now stay clickable
    await clearStuckPublishMask(page, log);
    log('版权检测进行中…');
    await page.waitForTimeout(2000);
  }
  await clearStuckPublishMask(page, log);
  return false;
}

async function clickPostButton(page, log = () => {}) {
  try {
    const { pauseSaveTrafficForCaptcha } = require('./save-traffic');
    await pauseSaveTrafficForCaptcha(page);
  } catch { /* ignore */ }
  await clearStuckPublishMask(page, log);
  // Prefer main Post/Publish; Post now is confirm dialog
  const namePatterns = [
    /^Post$/i, /^Publish$/i, /^发布$/, /^投稿$/, /^发布视频$/,
  ];
  const targets = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const target of targets) {
    for (const pattern of namePatterns) {
      const button = target.getByRole('button', { name: pattern }).first();
      if (await forceClick(button, 'Post', log)) return true;
    }
    for (const selector of [
      'button[data-e2e="post_video_button"]',
      'button[data-e2e="publish-button"]',
      '[data-e2e="post_video_button"]',
    ]) {
      const button = target.locator(selector).first();
      if (await forceClick(button, 'Post', log)) return true;
    }
  }
  for (const target of targets) {
    const byText = target.locator('button, [role="button"]').filter({ hasText: /^(Post|Publish|发布|投稿)$/i }).first();
    if (await forceClick(byText, 'Post', log)) return true;
  }
  return false;
}

/**
 * After primary Post: hammer confirm dialogs, clear mask, retry Post if still on upload.
 */
async function drivePublishConfirmations(page, timeoutMs = 120000, log = () => {}) {
  try {
    const { pauseSaveTrafficForCaptcha } = require('./save-traffic');
    await pauseSaveTrafficForCaptcha(page);
  } catch { /* ignore */ }
  const end = Date.now() + timeoutMs;
  let postRetries = 0;
  let postCaptchaSolvedRetries = 0;
  let lastSolvedStamp = Number(page.__tkNoCaptchaLastSolvedAt || 0);
  // 点击 Post 后先留出短暂窗口让可能弹出的旋转验证码或二次确认框挂载，避免瞬间 Escape 把弹框打成白屏
  await page.waitForTimeout(1000).catch(() => {});
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const rot = await solveRotateCaptchaIfPresent(page, { log });
      const nowSolvedStamp = Number(page.__tkNoCaptchaLastSolvedAt || 0);
      if ((rot?.detected && rot?.solved) || (nowSolvedStamp > lastSolvedStamp)) {
        lastSolvedStamp = Math.max(lastSolvedStamp, nowSolvedStamp, Date.now());
        log('旋转图片验证已由 NoCaptchaAI 自动通过，继续推进发布确认…');
        await page.waitForTimeout(1500).catch(() => {});
        const curUrl = page.url() || '';
        if (/upload/i.test(curUrl) && postCaptchaSolvedRetries < 3) {
          const postNowAfterCap = page.getByRole('button', { name: /^Post now$/i }).first();
          if (await postNowAfterCap.count().catch(() => 0) && await postNowAfterCap.isVisible().catch(() => false)) {
            await forceClick(postNowAfterCap, 'Post now', log);
          } else {
            const reClicked = await clickPostButton(page, log);
            if (reClicked) {
              postCaptchaSolvedRetries += 1;
              log(`旋转验证通过后重新点击发布（第 ${postCaptchaSolvedRetries} 次）`);
            }
          }
          await page.waitForTimeout(1500).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    await dismissPublishDialogs(page, log);
    await settleCopyrightAndConfirms(page, Math.min(20000, end - Date.now()), log);

    const url = page.url() || '';
    if (/tiktok\.com\/(@|content|tiktokstudio\/content)/i.test(url) && !/upload/i.test(url)) {
      const vid = (url.match(/\/video\/(\d+)/) || [])[1] || '';
      return { status: 'published', via: 'url', videoId: vid, videoUrl: vid ? url.split('?')[0] : '' };
    }
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 8000)).catch(() => '');
    if (/uploaded successfully|posted successfully|your video was (uploaded|posted)|发布成功|已发布|上传成功|视频已发布/i.test(text)
      && !/Checking in progress|being uploaded|Uploading/i.test(text)) {
      return { status: 'published', via: 'text' };
    }

    const postNow = page.getByRole('button', { name: /^Post now$/i }).first();
    if (await postNow.count().catch(() => 0)) {
      await forceClick(postNow, 'Post now', log);
      await page.waitForTimeout(1000);
      continue;
    }

    // 若验证码弹框正在加载或识别中，等待其完成，不要清理遮罩或误判 security_paused
    if (await hasActiveOrLoadingCaptchaModal(page)) {
      await page.waitForTimeout(1200).catch(() => {});
      continue;
    }

    // Still on upload editor with mask / no confirm → clear mask and re-hit Post (max 3)
    if (/upload/i.test(url) && postRetries < 3) {
      const checking = /Checking in progress/i.test(text);
      if (!checking) {
        await clearStuckPublishMask(page, log);
        if (await hasActiveOrLoadingCaptchaModal(page)) {
          continue;
        }
        const again = await clickPostButton(page, log);
        if (again) {
          postRetries += 1;
          log(`清除遮罩后重新点击发布（第 ${postRetries} 次）`);
          await page.waitForTimeout(1200);
          continue;
        }
      }
    }

    const security = await inspectPage(page);
    if (security.blocked) {
      // 若触发的是 something went wrong 且仍在上传页，先尝试解决可能刚弹出的旋转验证码并重试点击一次 Post，避免误挂起人工
      if (/something went wrong/i.test(String(security.reason || '')) && /upload/i.test(url) && postRetries < 3) {
        log(`页面提示 "${security.reason}"，尝试检测旋转验证码并重试点击发布…`);
        await page.waitForTimeout(1200).catch(() => {});
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          await solveRotateCaptchaIfPresent(page, { log });
        } catch { /* ignore */ }
        const retried = await clickPostButton(page, log);
        if (retried) {
          postRetries += 1;
          await page.waitForTimeout(2000).catch(() => {});
          continue;
        }
      }
      return { status: 'security_paused', reason: security.reason };
    }
    await page.waitForTimeout(1500);
  }
  return { status: 'timeout' };
}

/** 用 videoId + 用户名拼平台公开链接（拉取视频数据依赖此 URL） */
function buildPlatformVideoUrl(videoId, username = '') {
  const id = String(videoId || '').trim();
  if (!/^\d{6,}$/.test(id)) return '';
  const user = String(username || '').replace(/^@/, '').trim();
  if (user) return `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${id}`;
  return `https://www.tiktok.com/video/${id}`;
}

function pickVideoMetaFromUrl(u, username = '') {
  const m = String(u || '').match(/\/video\/(\d{6,})/);
  if (!m) return null;
  const videoId = m[1];
  const clean = String(u).split('?')[0];
  return {
    videoId,
    videoUrl: /\/@[^/]+\/video\//i.test(clean) ? clean : (buildPlatformVideoUrl(videoId, username) || clean),
  };
}

/** 从当前页 DOM / 内嵌 JSON 收集 videoId（Studio 列表常无 /video/ 锚点） */
async function scrapeVideoIdsFromPage(page) {
  return page.evaluate(() => {
    const ids = [];
    const push = (raw) => {
      const s = String(raw || '').trim();
      if (/^\d{10,}$/.test(s) && !ids.includes(s)) ids.push(s);
    };
    const fromUrl = (u) => {
      const s = String(u || '');
      const m = s.match(/\/video\/(\d{10,})/);
      if (m) push(m[1]);
      const m2 = s.match(/[?&](?:item_id|itemId|video_id|videoId|aweme_id|awemeId)=(\d{10,})/i);
      if (m2) push(m2[1]);
    };
    document.querySelectorAll('a[href], [href]').forEach((el) => {
      fromUrl(el.href || el.getAttribute('href') || '');
    });
    document.querySelectorAll('[data-video-id],[data-id],[data-item-id],[data-e2e]').forEach((el) => {
      push(el.getAttribute('data-video-id'));
      push(el.getAttribute('data-item-id'));
      const did = el.getAttribute('data-id');
      if (/^\d{10,}$/.test(String(did || ''))) push(did);
    });
    const html = document.documentElement?.innerHTML || '';
    for (const m of html.matchAll(/"(?:id|aweme_id|awemeId|itemId|item_id|video_id|videoId)"\s*:\s*"?(\d{10,})"?/g)) {
      push(m[1]);
    }
    try {
      const uni = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
      if (uni) {
        for (const m of JSON.stringify(uni).matchAll(/"(?:id|aweme_id|awemeId|itemId)"\s*:\s*"?(\d{10,})"?/g)) {
          push(m[1]);
        }
      }
    } catch { /* ignore */ }
    try {
      const sigi = window.SIGI_STATE || window.__NEXT_DATA__;
      if (sigi) {
        for (const m of JSON.stringify(sigi).matchAll(/"(?:id|aweme_id|awemeId|itemId)"\s*:\s*"?(\d{10,})"?/g)) {
          push(m[1]);
        }
      }
    } catch { /* ignore */ }
    return ids;
  }).catch(() => []);
}

function collectVideoIdsFromJson(json, out = []) {
  if (!json || typeof json !== 'object') return out;
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (/^\d{10,}$/.test(s) && !out.includes(s)) out.push(s);
  };
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      node.slice(0, 40).forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    push(node.id);
    push(node.aweme_id);
    push(node.awemeId);
    push(node.itemId);
    push(node.item_id);
    push(node.video_id);
    push(node.videoId);
    for (const key of ['itemList', 'item_list', 'post_list', 'posts', 'videos', 'list', 'data', 'items']) {
      if (node[key] != null) walk(node[key], depth + 1);
    }
  };
  walk(json);
  return out;
}

/**
 * 在已打开的主页上，用登录态请求 /api/post/item_list/ 取最新一条视频。
 * Studio 成功 toast 后公开页常无 /video/ 锚点，此接口最稳。
 */
async function fetchNewestVideoViaItemListApi(page, username = '', log = () => {}) {
  const user = String(username || '').replace(/^@/, '').trim();
  if (!user) return null;
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(user)}`;
  if (!new RegExp(`/@${user}(?:\\?|/|$)`, 'i').test(page.url() || '')) {
    log(`打开主页以请求 item_list：@${user}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const raw = await page.evaluate(async () => {
    const pickId = (item) => String(item?.id || item?.aweme_id || item?.awemeId || '').trim();
    const parseSecUid = () => {
      try {
        const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!script?.textContent) return '';
        const data = JSON.parse(script.textContent);
        return (
          data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user?.secUid
          || data?.['webapp.user-detail']?.userInfo?.user?.secUid
          || ''
        );
      } catch {
        return '';
      }
    };
    const fromSsr = () => {
      try {
        const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!script?.textContent) return '';
        const data = JSON.parse(script.textContent);
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const detail = scope['webapp.user-detail'] || {};
        const list = detail.itemList || detail.postList || detail.post?.itemList || [];
        return pickId(list?.[0]) || '';
      } catch {
        return '';
      }
    };
    let id = fromSsr();
    if (id) return { videoId: id, via: 'ssr' };
    const secUid = parseSecUid();
    if (!secUid) return { videoId: '', via: 'no-secUid' };
    try {
      const u = new URL(`${location.origin}/api/post/item_list/`);
      u.searchParams.set('aid', '1988');
      u.searchParams.set('count', '12');
      u.searchParams.set('cursor', '0');
      u.searchParams.set('device_platform', 'web_pc');
      u.searchParams.set('secUid', secUid);
      u.searchParams.set('coverFormat', '2');
      const resp = await fetch(u.toString(), {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*', referer: location.href },
      });
      if (!resp.ok) return { videoId: '', via: `http-${resp.status}` };
      const json = await resp.json();
      const list = json?.itemList || json?.item_list || [];
      id = pickId(list?.[0]) || '';
      return { videoId: id, via: id ? 'item_list' : 'empty-list' };
    } catch (e) {
      return { videoId: '', via: String(e?.message || e || 'fetch-fail') };
    }
  }).catch((e) => ({ videoId: '', via: String(e?.message || e || 'evaluate-fail') }));

  const videoId = String(raw?.videoId || '').trim();
  if (!videoId) {
    log(`item_list 未取到最新视频（${raw?.via || 'unknown'}）`);
    return null;
  }
  log(`item_list 解析到最新 videoId=${videoId}（${raw?.via || ''}）`);
  return {
    videoId,
    videoUrl: buildPlatformVideoUrl(videoId, user),
  };
}

/** 发布成功后尽量解析平台 video_id（URL / DOM / Studio / item_list 接口） */
async function resolvePublishedVideoMeta(page, username = '', log = () => {}, options = {}) {
  const user = String(username || options.username || '').replace(/^@/, '').trim();
  const pack = (videoId, videoUrl = '') => {
    const id = String(videoId || '').trim();
    if (!id) return { videoId: '', videoUrl: '' };
    return {
      videoId: id,
      videoUrl: String(videoUrl || '').trim() || buildPlatformVideoUrl(id, user),
    };
  };

  let hit = pickVideoMetaFromUrl(page.url() || '', user);
  if (hit) return pack(hit.videoId, hit.videoUrl);

  const fromDom = async () => {
    const ids = await scrapeVideoIdsFromPage(page);
    if (ids.length) return pack(ids[0]);
    return null;
  };
  hit = await fromDom();
  if (hit?.videoId) return hit;

  // 刚发布完公开页可能延迟：多轮重试
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) {
      log(`videoId 仍为空，等待索引后重试（${round + 1}/3）`);
      await page.waitForTimeout(3000 + round * 1500);
    }

    const apiIds = [];
    const onResp = async (resp) => {
      try {
        const u = resp.url() || '';
        if (!/item.?list|post.?list|creator|tiktokstudio|aweme|video.?list|content\/item|\/api\/post\//i.test(u)) return;
        const ct = String(resp.headers()['content-type'] || '');
        if (ct && !/json|javascript|text/i.test(ct)) return;
        const text = await resp.text().catch(() => '');
        if (!text || text.length > 2_500_000) return;
        try {
          collectVideoIdsFromJson(JSON.parse(text), apiIds);
        } catch {
          for (const m of text.matchAll(/"(?:id|aweme_id|awemeId|itemId|item_id|video_id|videoId)"\s*:\s*"?(\d{10,})"?/g)) {
            if (!apiIds.includes(m[1])) apiIds.push(m[1]);
          }
        }
      } catch { /* ignore */ }
    };
    page.on('response', onResp);

    const candidates = [
      'https://www.tiktok.com/tiktokstudio/content?lang=en',
      'https://www.tiktok.com/tiktokstudio/content?tab=video&lang=en',
      user ? `https://www.tiktok.com/@${encodeURIComponent(user)}` : '',
      user ? `https://www.tiktok.com/@${encodeURIComponent(user)}?lang=en` : '',
    ].filter(Boolean);

    try {
      for (const target of candidates) {
        try {
          log(`通过 ${target} 解析 videoId`);
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          for (let i = 0; i < 8; i += 1) {
            await page.waitForTimeout(i === 0 ? 2000 : 900);
            hit = pickVideoMetaFromUrl(page.url() || '', user);
            if (hit) return pack(hit.videoId, hit.videoUrl);
            if (apiIds.length) return pack(apiIds[0]);
            const ids = await scrapeVideoIdsFromPage(page);
            if (ids.length) return pack(ids[0]);
            if (user) {
              const hrefs = await page.evaluate((uname) => (
                [...document.querySelectorAll(`a[href*="/@${uname}/video/"]`)]
                  .map((a) => a.href || '')
                  .filter(Boolean)
              ), user).catch(() => []);
              for (const h of hrefs) {
                hit = pickVideoMetaFromUrl(h, user);
                if (hit) return pack(hit.videoId, hit.videoUrl);
              }
            }
          }
        } catch (e) {
          log(`解析 videoId 跳过：${e.message || e}`);
        }
      }
    } finally {
      page.off('response', onResp);
    }

    if (apiIds.length) return pack(apiIds[0]);

    // 主页 item_list：取最新一条（刚发布的通常排第一）
    if (user) {
      const newest = await fetchNewestVideoViaItemListApi(page, user, log).catch(() => null);
      if (newest?.videoId) return pack(newest.videoId, newest.videoUrl);
    }
  }

  return { videoId: '', videoUrl: '' };
}

async function waitPublishOutcome(page, timeoutMs = 120000, log = () => {}) {
  return drivePublishConfirmations(page, timeoutMs, log);
}
async function clickSendButton(page) {
  const names = ['Send', '发送', 'Message'];
  const targets = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
  for (const target of targets) {
    for (const name of names) {
      const button = target.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
      if (await button.count().catch(() => 0) && await button.isVisible().catch(() => false)) {
        const disabled = await button.isDisabled().catch(() => false);
        if (disabled) continue;
        await button.click({ timeout: 8000 });
        return true;
      }
    }
  }
  return false;
}

async function fillMessageEditor(page, content) {
  const editors = [
    page.locator('[data-e2e="message-input-area"] [contenteditable="true"]').last(),
    page.locator('[contenteditable="true"]').last(),
    page.locator('textarea').last(),
  ];
  for (const editor of editors) {
    if (!(await editor.count().catch(() => 0))) continue;
    if (!(await editor.isVisible().catch(() => false))) continue;
    await editor.click({ timeout: 5000 }).catch(() => {});
    await editor.fill(content).catch(async () => {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.type(content, { delay: typeDelay(80, 160) });
    });
    return true;
  }
  return false;
}

/** 私信界面：代理慢时最多等这么久；输入框一出现就返回，不等满 */
const DM_CHAT_WAIT_MS = 20000;
const DM_NAV_TIMEOUT_MS = 90000;
/** 首次打开失败后，最多再重新加载这么多次 */
const DM_LOAD_RETRIES = 3;
const DM_LOAD_FAIL_RE = /something went wrong|something'?s wrong|please try again|couldn'?t load|failed to load|网络异常|加载失败|出错了|oops/i;

async function dmEditorVisible(page, loose = false) {
  const scoped = page.locator(
    '[data-e2e="message-input-area"] [contenteditable="true"], [data-e2e="message-input-area"] textarea, [data-e2e="dm-input"]'
  ).first();
  if (await scoped.isVisible().catch(() => false)) return true;
  const onMessages = /messages/i.test(String(page.url() || ''));
  if (!loose && !onMessages) return false;
  return page.locator('textarea, [contenteditable="true"]').first().isVisible().catch(() => false);
}

async function dmMessageButton(page) {
  const btn = page.getByRole('button', { name: /^(Message|私信|发私信)$/i }).first();
  if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) return btn;
  // 兜底：按钮可能是链接或带 data-e2e 的元素
  const alt = page.locator('[data-e2e="message-button"], [data-e2e="dm-button"], a[role="button"]:text-is("Message"), a:text-is("Message"), a:text-is("私信")').first();
  if (await alt.count().catch(() => 0) && await alt.isVisible().catch(() => false)) return alt;
  return null;
}

async function dmPageLoadFailed(page) {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return DM_LOAD_FAIL_RE.test(String(text || ''));
}

/**
 * 等到私信输入框、Message 按钮，或明确的加载失败。
 * 成功态立即返回，不把等待时间耗满。
 * @returns {'ready'|'button'|'failed'|'timeout'}
 */
async function waitDmSurface(page, timeoutMs = DM_CHAT_WAIT_MS, loose = false) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    if (await dmEditorVisible(page, loose)) return 'ready';
    if (await dmPageLoadFailed(page)) return 'failed';
    if (!loose && await dmMessageButton(page)) return 'button';
    await page.waitForTimeout(400);
  }
  if (await dmEditorVisible(page, loose)) return 'ready';
  if (await dmPageLoadFailed(page)) return 'failed';
  if (!loose && await dmMessageButton(page)) return 'button';
  return 'timeout';
}

async function profileLooksLoaded(page) {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (DM_LOAD_FAIL_RE.test(String(text || ''))) return false;
  // 左侧导航自带 "Following"，只看整页文字会把「资料区没渲染」误判成已加载；必须看到目标用户的资料区元素
  return page.locator('[data-e2e="user-page"], [data-e2e="user-title"], [data-e2e="followers-count"]').first().isVisible().catch(() => false);
}

/** 主页没有私信入口时走消息页搜索；加载失败返回 failed，找到输入框立刻 ready */
async function openViaMessagesInbox(page, handle) {
  await page.goto('https://www.tiktok.com/messages', {
    waitUntil: 'domcontentloaded',
    timeout: DM_NAV_TIMEOUT_MS,
  }).catch(() => {});
  const inbox = await waitDmSurface(page, DM_CHAT_WAIT_MS, true);
  if (inbox === 'ready') return 'ready';
  if (inbox === 'failed') return 'failed';
  const search = page.locator('input[placeholder*="Search"],input[placeholder*="搜索"],input[type="search"]').first();
  if (await search.count().catch(() => 0) && await search.isVisible().catch(() => false)) {
    await search.fill(handle).catch(async () => {
      await search.click();
      await page.keyboard.type(handle);
    });
    const hit = page.getByText(handle, { exact: false }).first();
    const hitEnd = Date.now() + 8000;
    while (Date.now() < hitEnd) {
      if (await dmEditorVisible(page, true)) return 'ready';
      if (await dmPageLoadFailed(page)) return 'failed';
      if (await hit.isVisible().catch(() => false)) {
        await hit.click().catch(() => {});
        break;
      }
      await page.waitForTimeout(400);
    }
    const after = await waitDmSurface(page, DM_CHAT_WAIT_MS, true);
    if (after === 'ready') return 'ready';
    if (after === 'failed') return 'failed';
  }
  if (await dmPageLoadFailed(page)) return 'failed';
  return 'miss';
}

/** 私信失败时的页面现场：URL、DOM 是否为空、文本片段、可见按钮，便于判断是白屏、报错页还是缺入口 */
async function dmPageProbe(page) {
  try {
    const r = await Promise.race([
      page.evaluate(() => ({
        url: location.href.slice(0, 90),
        jsua: `${String(navigator.userAgent || '').slice(0, 100)} | uaData=${navigator.userAgentData ? `${navigator.userAgentData.platform} ${(navigator.userAgentData.brands || []).map((b) => `${b.brand}/${b.version}`).join(',')}`.slice(0, 120) : '无'} | webdriver=${navigator.webdriver}`,
        rs: document.readyState,
        kids: document.body?.childElementCount || 0,
        textLen: String(document.body?.innerText || '').length,
        text: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
        act: Array.from(document.querySelectorAll('button,a,[role="button"]')).map((b) => String(b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter((t) => /message|follow|log ?in|sign ?up|私信|关注|登录|注册/i.test(t)).slice(0, 10).map((t) => t.slice(0, 18)).join('|'),
        btns: Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 8).map((b) => String(b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 14)).filter(Boolean).join('|'),
        e2e: Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((n) => n.getAttribute('data-e2e')))).filter((x) => x && !['tiktok-logo', 'search-box', 'search-user-input', 'search-box-button', 'upload-icon', 'inbox-icon', 'inbox-notifications', 'inbox-bar', 'all', 'likes', 'comments'].includes(x)).slice(0, 40).join(','),
        scripts: document.scripts.length,
        hdr: (() => {
          const t = document.querySelector('[data-e2e="user-title"]');
          const box = t ? (t.closest('[data-e2e="user-page"]') || t.parentElement?.parentElement?.parentElement || t.parentElement) : null;
          if (!box) return '无user-title';
          return Array.from(box.querySelectorAll('button,a,[role="button"]')).slice(0, 10).map((n) => `${n.tagName.toLowerCase()}:${String(n.getAttribute('data-e2e') || '')}:${String(n.innerText || n.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 12)}`).join('|') || '资料区内无按钮/链接';
        })(),
      })),
      new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 4000)),
    ]);
    if (r?.hung) return '渲染进程4秒无响应';
    return `页面=${r.url} JS_UA=[${r.jsua}] readyState=${r.rs} body子节点=${r.kids} 文本长度=${r.textLen} 按钮=[${r.btns}] 相关元素=[${r.act}] data-e2e=[${r.e2e}] 资料区控件=[${r.hdr}] 脚本数=${r.scripts} 文本=${r.text}`;
  } catch (e) {
    return `体检失败：${String(e?.message || e).slice(0, 80)}`;
  }
}

/** 包一层网络监听：把主文档状态码、失败请求、4xx/5xx、页面脚本报错带进失败现场 */
async function openRecipientChat(page, recipient, log = () => {}) {
  const net = { doc: '', docs: [], hdr: '', failed: [], bad: [], errors: [] };
  const onResp = (resp) => {
    try {
      const req = resp.request();
      const type = req.resourceType();
      const url = String(resp.url() || '');
      if (type === 'document' && req.frame() === page.mainFrame()) {
        net.doc = `${resp.status()} ${url.slice(0, 80)}`;
        if (net.docs.length < 8) net.docs.push(`${resp.status()} ${url.replace(/^https?:\/\/[^/]+/, '').slice(0, 50)}`);
        // 记下主文档实际发出的请求头与响应头，用来核对 UA / Client Hints 是否自相矛盾
        const rh = resp.headers() || {};
        net.rhdr = `server=${rh.server || '-'} ct=${String(rh['content-type'] || '-').slice(0, 30)} logid=${String(rh['x-tt-logid'] || '-').slice(0, 24)}`;
        req.allHeaders().then((h) => {
          net.hdr = `ua=${String(h['user-agent'] || '-').slice(0, 110)} sec-ch-ua=${String(h['sec-ch-ua'] || '-').slice(0, 90)} platform=${h['sec-ch-ua-platform'] || '-'} lang=${String(h['accept-language'] || '-').slice(0, 20)}`;
        }).catch(() => {});
      } else if (resp.status() >= 400 && net.bad.length < 6) {
        net.bad.push(`${resp.status()} ${type} ${url.slice(0, 70)}`);
      }
    } catch { /* ignore */ }
  };
  const onFail = (req) => {
    try {
      // 省流主动拦掉的图片/媒体/字体不算故障，否则 6 条名额会被噪音占满
      if (['image', 'media', 'font', 'ping', 'other'].includes(req.resourceType())) return;
      if (net.failed.length < 6) net.failed.push(`${req.resourceType()} ${req.failure()?.errorText || ''} ${String(req.url() || '').slice(0, 70)}`);
    } catch { /* ignore */ }
  };
  const onPageErr = (e) => {
    if (net.errors.length < 4) net.errors.push(String(e?.message || e).slice(0, 100));
  };
  const summary = () => `主文档=${net.doc || '无响应'} 文档历史=[${net.docs.join(' ; ')}] 响应头=[${net.rhdr || '-'}] 请求头=[${net.hdr || '-'}] 失败请求=[${net.failed.join(' ; ')}] 4xx5xx=[${net.bad.join(' ; ')}] 脚本报错=[${net.errors.join(' ; ')}]`;
  page.on('response', onResp);
  page.on('requestfailed', onFail);
  page.on('pageerror', onPageErr);
  try {
    return await openRecipientChatInner(page, recipient, log, summary);
  } finally {
    page.off('response', onResp);
    page.off('requestfailed', onFail);
    page.off('pageerror', onPageErr);
  }
}

/** 人工验证等待时长（毫秒），默认 5 分钟；可用 TKSWARM_DM_MANUAL_WAIT_MS 覆盖 */
const DM_MANUAL_WAIT_MS = Number(process.env.TKSWARM_DM_MANUAL_WAIT_MS || 300000) || 300000;

/**
 * 主文档 403（疑似人机验证/风控）时：不再重载，临时关闭省流，等人工在 VNC 里完成验证。
 * @returns {'ready'|'loaded'|'timeout'}
 */
async function waitManualVerify(page, handle, log = () => {}) {
  let paused = false;
  try {
    const st = require('./save-traffic');
    await st.pauseSaveTrafficForCaptcha(page);
    paused = true;
  } catch { /* ignore */ }
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  log(`@${handle} 主页返回 403（疑似人机验证/风控）：已临时关闭省流并尝试自动恢复/识别旋转验证，最多等 ${Math.round(DM_MANUAL_WAIT_MS / 60000)} 分钟`);
  const end = Date.now() + DM_MANUAL_WAIT_MS;
  let result = 'timeout';
  let triedSoftRecover = false;
  while (Date.now() < end) {
    if (page.isClosed?.()) break;
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const rot = await solveRotateCaptchaIfPresent(page, { log });
      if (rot?.detected && rot?.solved) {
        await page.waitForTimeout(1200).catch(() => {});
      }
    } catch { /* ignore */ }
    if (await dmEditorVisible(page, true).catch(() => false)) { result = 'ready'; break; }
    if (await dmMessageButton(page).catch(() => null)) { result = 'loaded'; break; }
    if (await profileLooksLoaded(page).catch(() => false)) { result = 'loaded'; break; }
    // 网关 403 空页面没有任何 DOM 与验证码脚本：关闭省流后先做一次首页预热再重新进主页，让前端能正常拉起验证弹层或主页
    if (!triedSoftRecover) {
      triedSoftRecover = true;
      const bodyKids = await page.evaluate(() => document.body?.childElementCount || 0).catch(() => 0);
      const bodyLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
      if (bodyKids <= 1 && bodyLen < 120) {
        log(`@${handle} 403 页面为空（子元素=${bodyKids}, 文本=${bodyLen}），尝试回首页预热后重进主页以唤起验证或页面`);
        await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          await solveRotateCaptchaIfPresent(page, { log });
        } catch { /* ignore */ }
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});
        continue;
      }
    }
    await page.waitForTimeout(2000).catch(() => {});
  }
  if (paused) {
    try {
      const st = require('./save-traffic');
      if (result !== 'timeout') await st.resumeSaveTrafficAfterCaptcha(page);
    } catch { /* ignore */ }
  }
  log(result === 'timeout' ? '等待人工验证超时，未恢复' : '页面已恢复，继续打开私信');
  return result;
}

async function openRecipientChatInner(page, recipient, log = () => {}, netSummary = () => '') {
  const handle = String(recipient || '').replace(/^@/, '').trim();
  if (!handle) return false;
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  let noBtn = 0;

  for (let attempt = 0; attempt <= DM_LOAD_RETRIES; attempt += 1) {
    log(attempt === 0
      ? `打开私信 @${handle}`
      : `私信界面重新加载 @${handle}（${attempt}/${DM_LOAD_RETRIES}）`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: DM_NAV_TIMEOUT_MS }).catch(() => {});
    if (/主文档=403/.test(netSummary())) {
      const manual = await waitManualVerify(page, handle, log);
      if (manual === 'ready') return true;
      if (manual === 'timeout') {
        page.__dmLastProbe = `主文档 403（疑似人机验证/风控），等待人工 ${Math.round(DM_MANUAL_WAIT_MS / 60000)} 分钟后仍未恢复：${await dmPageProbe(page)} ｜网络：${netSummary()}`;
        return false;
      }
    }
    let state = await waitDmSurface(page, DM_CHAT_WAIT_MS);
    if (state === 'ready') return true;
    if (state === 'button') {
      const btn = await dmMessageButton(page);
      if (btn) await btn.click({ timeout: 8000 }).catch(() => {});
      state = await waitDmSurface(page, DM_CHAT_WAIT_MS, true);
      if (state === 'ready') return true;
    }

    const loadError = state === 'failed' || (state === 'timeout' && !(await profileLooksLoaded(page)));
    if (!loadError) {
      // 主页资料区已渲染：Message 按钮可能还在 hydrate，再多等一会儿
      let btn2 = null;
      const btnEnd = Date.now() + 15000;
      while (Date.now() < btnEnd) {
        btn2 = await dmMessageButton(page);
        if (btn2) break;
        await page.waitForTimeout(500);
      }
      if (btn2) {
        await btn2.click({ timeout: 8000 }).catch(() => {});
        state = await waitDmSurface(page, DM_CHAT_WAIT_MS, true);
        if (state === 'ready') return true;
        log(`已点击 Message 但未出现输入框，当前页面 ${String(page.url() || '').slice(0, 100)}`);
      } else {
        // 不再走消息页搜索：新联系人没有历史会话，搜不到；且 /messages 会被重定向到 business-suite
        const profileProbe = await dmPageProbe(page);
        noBtn += 1;
        page.__dmLastProbe = `主页已加载但没有 Message 按钮（对方可能关闭私信或需互相关注；或页面按钮未加载出来）｜主页：${profileProbe}｜网络：${netSummary()}`;
        log(`@${handle} 主页没有 Message 按钮（第 ${noBtn} 次）：${profileProbe}`);
        if (noBtn >= 2) return false;
        continue;
      }
    }

    const probe = `${await dmPageProbe(page)} ｜网络：${netSummary()}`;
    page.__dmLastProbe = `${state === 'failed' ? '页面异常或加载失败' : '超时未出现输入框'}：${probe}`;
    log(`私信界面未加载（${state === 'failed' ? '页面异常或加载失败' : '超时未出现输入框'}）：${probe}${attempt >= DM_LOAD_RETRIES ? '' : '，准备重新加载'}`);
    if (attempt >= DM_LOAD_RETRIES) break;
  }
  return false;
}

async function prepareMessage(accountId, content, recipient = '', options = {}) {
  await awaitSlot(`message:${accountId}`, 10000);
  const autoSend = options.autoSend === true;
  const { parseSaveTrafficFlag } = require('./save-traffic');
  // 有收件人：从首页起步，随后进对方主页点 Message（/messages 会被 302 到 business-suite 营销页，且新联系人没有历史会话）
  const connection = await connectAccount(accountId, recipient ? 'https://www.tiktok.com/' : 'https://www.tiktok.com/messages', 'message', {
    saveTraffic: parseSaveTrafficFlag(options.saveTraffic ?? options.save_traffic, false),
    browserBackend: options.browserBackend,
  });
  let keepOpen = false;
  try {
    if (String(options.browserBackend || '').toLowerCase() === 'linux') {
      // 服务器浏览器：先检测登录 → 注入同步登录数据 → 一键/表单登录 → 登录页填表；登录后才继续私信
      try {
        await require('./seat-tasks').ensureSeatLoggedIn(connection, accountId, { label: '私信' });
      } catch (e) {
        if (e?.waiting) keepOpen = true;
        throw e;
      }
    } else {
      const session = await inspectTikTokSession(connection.ws);
      if (!session.loggedIn) throw new Error('当前浏览器没有有效 TikTok 登录状态');
    }
    const before = await capture(connection.page, accountId, 'message', 'before');
    const security = await inspectPageForDm(connection.page);
    if (security.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: security.reason, screenshot: before, manualRequired: true };
    }
    if (recipient) {
      const { publish: liveLog } = require('../live-log');
      const opened = await openRecipientChat(connection.page, recipient, (msg) => {
        liveLog(`私信#${accountId}：${msg}`, 'info', { accountId });
      });
      if (!opened) {
        keepOpen = true;
        return {
          status: 'failed',
          error: `私信界面打开失败：${recipient}${connection.page.__dmLastProbe ? `；页面现场：${String(connection.page.__dmLastProbe).slice(0, 1800)}` : ''}`,
          screenshot: before,
          recipient,
        };
      }
    }
    const filled = await fillMessageEditor(connection.page, content);
    if (!filled) throw new Error('未找到消息输入控件');
    const prepared = await capture(connection.page, accountId, 'message', 'prepared');
    const after = await inspectPageForDm(connection.page);
    if (after.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: after.reason, screenshot: prepared, manualRequired: true };
    }
    if (!autoSend) {
      keepOpen = true;
      return { status: 'manual_required', manualRequired: true, screenshot: prepared, recipient, contentLength: String(content).length };
    }
    const clicked = await clickSendButton(connection.page);
    if (!clicked) {
      await connection.page.keyboard.press('Enter').catch(() => {});
      await connection.page.waitForTimeout(800);
    }
    const sentShot = await capture(connection.page, accountId, 'message', 'sent').catch(() => prepared);
    const blocked = await inspectPageForDm(connection.page);
    if (blocked.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: blocked.reason, screenshot: sentShot, manualRequired: true };
    }
    return { status: 'sent', screenshot: sentShot, recipient, contentLength: String(content).length, clicked: clicked || 'enter' };
  } finally {
    if (!keepOpen) await closeConnection(connection);
  }
}

async function sendBitMessageBatch(accountId, items = [], options = {}) {
  await awaitSlot(`message:${accountId}`, 10000);
  // 批量私信默认间隔 8s（原 800ms 过快易触发风控）
  const interval = Math.min(120000, Math.max(3000, Number(options.interval) || 8000));
  const connection = await connectAccount(accountId, 'https://www.tiktok.com/messages', 'message');
  let keepOpen = false;
  const results = [];
  try {
    const session = await inspectTikTokSession(connection.ws);
    if (!session.loggedIn) throw new Error('当前浏览器没有有效 TikTok 登录状态');
    for (const item of items) {
      const recipient = item.recipient || item.uid || item.username || '';
      const content = item.content || '';
      try {
        const security = await inspectPage(connection.page);
        if (security.blocked) {
          keepOpen = true;
          results.push({ ...item, ok: false, status: 'security_paused', reason: security.reason });
          break;
        }
        if (recipient) {
          const opened = await openRecipientChat(connection.page, recipient);
          if (!opened) {
            results.push({ ...item, ok: false, status: 'failed', reason: `未能打开会话：${recipient}` });
            if (interval) await connection.page.waitForTimeout(interval);
            continue;
          }
        }
        const filled = await fillMessageEditor(connection.page, content);
        if (!filled) {
          results.push({ ...item, ok: false, status: 'failed', reason: '未找到消息输入控件' });
          continue;
        }
        let clicked = await clickSendButton(connection.page);
        if (!clicked) {
          await connection.page.keyboard.press('Enter').catch(() => {});
          clicked = true;
        }
        await connection.page.waitForTimeout(800);
        results.push({ ...item, ok: true, status: 'sent', clicked });
      } catch (error) {
        results.push({ ...item, ok: false, status: 'failed', reason: error.message });
      }
      if (interval) await connection.page.waitForTimeout(interval);
    }
    return { results, paused: results.some(row => row.status === 'security_paused') };
  } finally {
    if (!keepOpen) await closeConnection(connection);
  }
}

/** 素材/任务标签 → TikTok 话题名列表（无 #，过滤系统内部分类标签） */
function normalizePublishHashtags(...sources) {
  const INTERNAL = new Set([
    'local', 'materials', 'material-picker', 'local-folder', 'zip-import', 'publish-wizard',
  ]);
  const seen = new Set();
  const out = [];
  for (const src of sources) {
    if (Array.isArray(src)) {
      for (const item of src) {
        const part = String(item || '').replace(/^#+/, '').replace(/\s+/g, '').trim();
        if (!part) continue;
        const key = part.toLowerCase();
        if (INTERNAL.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(part);
      }
      continue;
    }
    const parts = String(src || '')
      .split(/[,，、;\s]+/)
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    for (let part of parts) {
      part = part.replace(/^#+/, '').trim();
      if (!part) continue;
      const key = part.toLowerCase();
      if (INTERNAL.has(key)) continue;
      if (seen.has(key)) continue;
      // 去掉空格，避免变成多个无效标签
      const compact = part.replace(/\s+/g, '');
      if (!compact) continue;
      seen.add(key);
      out.push(compact);
    }
  }
  return out;
}

/** 从文案中抽出 #话题，避免当纯文本粘贴 */
function extractHashtagsFromText(text) {
  const s = String(text || '');
  const found = [];
  const re = /#([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) found.push(m[1]);
  }
  return normalizePublishHashtags(found);
}

/** 去掉文案里的 #话题，正文与话题分开写 */
function stripHashtagsFromText(text) {
  return String(text || '')
    .replace(/#([A-Za-z0-9_\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]+)/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 组装发布正文（不含话题）与话题列表。
 * 话题必须走联想下拉写入，不能拼进 description 纯文本。
 */
function buildPublishCaptionParts(title, caption, hashtagNames) {
  const rawTitle = String(title || '').trim();
  const rawCaption = String(caption || '').trim();
  const fromTitle = extractHashtagsFromText(rawTitle);
  const fromCaption = extractHashtagsFromText(rawCaption);
  const tags = normalizePublishHashtags(hashtagNames, fromTitle, fromCaption);

  const t = stripHashtagsFromText(rawTitle);
  const c = stripHashtagsFromText(rawCaption);
  const lines = [];
  if (t) lines.push(t);
  if (c && c !== t) lines.push(c);
  return {
    body: lines.join('\n').trim(),
    hashtags: tags,
    /** @deprecated 兼容旧校验：正文+话题预览字串 */
    description: [lines.join('\n').trim(), tags.map((x) => `#${x}`).join(' ')].filter(Boolean).join('\n').trim(),
  };
}

function buildPublishDescription(title, caption, hashtagText) {
  // 兼容旧调用：返回「正文+话题预览」；真正写入请用 buildPublishCaptionParts
  const names = Array.isArray(hashtagText)
    ? hashtagText
    : normalizePublishHashtags(hashtagText);
  return buildPublishCaptionParts(title, caption, names).description;
}

async function preparePublish(accountId, materialId, title='', caption='', options={}) {
  const { publish: liveLog } = require('../live-log');
  const log = (msg) => liveLog(`发布#${accountId}：${msg}`, 'info', { accountId, materialId });
  log(`开始准备素材 #${materialId}`);
  await awaitSlot(`publish:${accountId}`, 12000);
  const material=await loadMaterial(materialId, log);
  if(!material) throw new Error('素材不存在');
  const status = material.status || 'ready';
  if(status!=='ready') throw new Error('素材状态不可用');
  const filePath = material.file_path || material.filePath || '';
  if (!filePath) throw new Error('素材文件路径为空（请确认 PHP 素材可被本机访问）');
  material.file_path = filePath;
  material.file_name = material.file_name || material.fileName || '';
  // 任务级文案优先；为空则回退素材分享标题 → 素材名（跳过像 m-时间戳 的文件名）
  const rawName = String(material.name || '').trim();
  const shareOnly = String(material.shareTitle || material.share_title || '').trim();
  const nameAsTitle = rawName && !looksLikeFilenameCaption(rawName) ? rawName : '';
  const matTitle = shareOnly || nameAsTitle;
  const matCaption = String(material.shareCaption || material.share_caption || '').trim();
  title = String(title || '').trim() || matTitle;
  caption = String(caption || '').trim() || matCaption;
  if (!title && !caption && looksLikeFilenameCaption(rawName)) {
    log(`警告：素材#${materialId} 未填分享标题，素材名像文件名「${rawName.slice(0, 40)}」，不会当作发布描述`);
  }
  // 任务 hashtags + 素材 tags + 文案内 #tag → 话题列表（须走联想下拉，禁止纯文本粘贴）
  const hashtagNames = normalizePublishHashtags(
    options.hashtags,
    options.tags,
    material.tags,
  );
  const captionParts = buildPublishCaptionParts(title, caption, hashtagNames);
  const hashtagText = captionParts.hashtags.map((t) => `#${t}`).join(' ');
  log(
    `文案来源：标题=${title ? `「${title.slice(0, 40)}${title.length > 40 ? '…' : ''}」` : '空'}`
    + ` 文案=${caption ? `${caption.length}字` : '空'}`
    + ` 标签=${captionParts.hashtags.length ? `${captionParts.hashtags.length}个` : '无'}`
    + `（素材#${materialId} shareTitle=${material.shareTitle || material.share_title ? '有' : '无'} tags=${material.tags ? '有' : '无'}）`
  );
  if (hashtagText) log(`将按联想下拉写入话题：${hashtagText}`);
  const autoPublish = options.autoPublish !== undefined ? Boolean(options.autoPublish) : !(await readSetting('publishManualConfirm', false));
  const saveTraffic = Boolean(options.saveTraffic);
  const forceKeepOpen = Boolean(options.keepOpen);
  // Studio upload UI: https://www.tiktok.com/tiktokstudio/upload
  const startUrl = options.uploadUrl || 'https://www.tiktok.com/tiktokstudio/upload';
  log('连接浏览器并打开 Studio 上传页');
  const connection = await connectAccount(accountId, startUrl, 'publish', {
    saveTraffic,
    browserBackend: options.browserBackend,
    browserProfileId: options.browserProfileId,
    profileId: options.profileId,
  });
  let keepOpen = false;
  try {
    const pause = (ms) => connection.page.waitForTimeout(saveTraffic ? Math.min(ms, 1500) : ms);
    // Re-focus Studio upload tab (Bit may open extra workbench tabs)
    const pages = connection.browser.contexts()[0]?.pages?.() || connection.context?.pages?.() || [];
    let page = pages.find((p) => /tiktokstudio\/upload/i.test(p.url() || ''))
      || pages.find((p) => /tiktok\.com\/upload/i.test(p.url() || ''))
      || connection.page;
    connection.page = page;
    await page.bringToFront().catch(() => {});
    if (!/tiktokstudio\/upload|tiktok\.com\/upload/i.test(page.url() || '')) {
      log(`从 ${page.url()} 进入 Studio 上传页`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pause(3000);
    }
    const session = await ensureSessionLoggedIn(connection, accountId, {
      reloadUrl: startUrl,
      label: '发布',
    });
    if (!session?.loggedIn) {
      liveLog(
        `发布#${accountId}：登录检测失败 url=${session?.pageUrl} cookie=${session?.hasSessionCookie} studio=${session?.studioAuthed} out=${session?.uiLoggedOut} in=${session?.uiLoggedIn} evidence=${(session?.evidence || []).join(',')}`,
        'warn',
        { accountId }
      );
      throw new Error(
        `当前浏览器没有有效 TikTok 登录状态（url=${session?.pageUrl || '-'} cookie=${session?.hasSessionCookie} studio=${!!session?.studioAuthed}）。请确认浏览器窗口已登录且停在 Studio 上传页后重试`
      );
    }
    await require('../data-store').updateLoginStatus(accountId, 'online').catch(() => {});
    const before = saveTraffic ? null : await capture(connection.page, accountId, 'publish', 'before');
    const security = await inspectPage(connection.page);
    if (security.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: security.reason, screenshot: before || '', manualRequired: true };
    }

    log(`选择视频文件：${material.file_name || material.file_path}`);
    const picked = await selectVideoFile(connection.page, material.file_path, log);
    log(`已选择视频（方式：${picked.method}）`);
    const ready = await waitUploadEditorReady(connection.page, saveTraffic ? 120000 : 240000, log);
    if (!ready) {
      keepOpen = true;
      await capture(connection.page, accountId, 'publish', 'upload-stuck').catch(() => '');
      throw new Error('已选择视频，但未进入编辑/发布页（可能仍在上传处理）。页面已保留');
    }
    // 再确认封面 Uploading 已消失；未完成则最多再等一轮
    for (let i = 0; i < 40 && await isStudioStillUploading(connection.page); i += 1) {
      if (i === 0 || i % 4 === 0) log('上传未完成，继续等待封面就绪…');
      await pause(2000);
    }
    await pause(saveTraffic ? 800 : 1200);

    const description = captionParts.description;
    const bodyText = captionParts.body;
    const tagList = captionParts.hashtags;
    if (bodyText || tagList.length) {
      await dismissPublishDialogs(connection.page, log).catch(() => {});
      await clearStuckPublishMask(connection.page, log).catch(() => {});
      // 滚到详情区，避免描述框在视口外导致「找不到」
      await connection.page.getByText(/^Description$|^Details$|^添加描述$|^作品描述$/i).first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      log(
        `填写发布描述：正文 ${bodyText.length} 字`
        + (tagList.length ? ` + ${tagList.length} 个话题（联想下拉）` : '（无话题）')
      );
      let filled = await fillPublishCaptionWithHashtags(connection.page, bodyText, tagList, log);
      if (!filled) {
        await pause(2500);
        await clearStuckPublishMask(connection.page, log).catch(() => {});
        filled = await fillPublishCaptionWithHashtags(connection.page, bodyText, tagList, log);
      }
      const peek = await peekPublishDescription(connection.page);
      const bodyOk = !bodyText || descriptionLooksFilled(peek, bodyText);
      if (!filled || looksLikeFilenameCaption(peek) || !bodyOk) {
        keepOpen = true;
        const diag = await connection.page.evaluate(() => {
          const eds = [...document.querySelectorAll('[contenteditable="true"], textarea')];
          return {
            url: location.href,
            editors: eds.length,
            sample: eds.slice(0, 5).map((el) => ({
              role: el.getAttribute('role') || '',
              aria: (el.getAttribute('aria-label') || '').slice(0, 40),
              text: (el.innerText || el.value || '').slice(0, 40),
              wh: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
            })),
          };
        }).catch(() => ({}));
        log(`描述框诊断 url=${diag.url || '-'} editors=${diag.editors ?? '?'} sample=${JSON.stringify(diag.sample || [])}`);
        await capture(connection.page, accountId, 'publish', 'caption-fail').catch(() => '');
        throw new Error(
          `未能写入素材分享描述（当前框内「${(peek || '').slice(0, 48)}」）。已保留页面，请确认素材已填分享标题/文案后重试`
        );
      }
    } else {
      log('警告：任务与素材均无分享标题/文案/标签，将保留 Studio 默认文件名描述');
    }
    const prepared = await capture(connection.page, accountId, 'publish', 'prepared');
    const after = await inspectPage(connection.page);
    if (after.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: after.reason, screenshot: prepared, manualRequired: true };
    }
    if (!autoPublish) {
      keepOpen = true;
      console.warn('[publish] autoPublish=false → manual_required, will NOT mark-published until Post succeeds via resume');
      log('自动发布关闭：等待手动点击发布 / 恢复发布');
      return {
        status: 'manual_required',
        manualRequired: true,
        screenshot: prepared,
        material: { id: material.id, name: material.name, fileName: material.file_name },
      };
    }
    // Wait post button enabled; dismiss mid-flow modals; wait copyright scan if already running
    for (let i = 0; i < 40; i += 1) {
      await dismissPublishDialogs(connection.page, log);
      await clearStuckPublishMask(connection.page, log);
      const btn = connection.page.getByRole('button', { name: /^(Post|Publish|发布|投稿)$/i }).first();
      if (await btn.count() && await btn.isVisible().catch(() => false) && !(await btn.isDisabled().catch(() => true))) break;
      await pause(1500);
    }
    // 点发布前再核对：上传完成后 Studio 偶发把描述重置回文件名
    if (bodyText || tagList.length) {
      const cur = await peekPublishDescription(connection.page);
      const bodyMissing = bodyText && !descriptionLooksFilled(cur, bodyText);
      const tagsMissing = tagList.some((t) => !new RegExp(`#${t}\\b`, 'i').test(cur || ''));
      if (bodyMissing || tagsMissing || looksLikeFilenameCaption(cur)) {
        log(`发布前描述不符（当前「${(cur || '').slice(0, 40)}」），重新写入正文与话题`);
        const ok = await fillPublishCaptionWithHashtags(connection.page, bodyText, tagList, log);
        const again = await peekPublishDescription(connection.page);
        if (!ok || (bodyText && !descriptionLooksFilled(again, bodyText))) {
          keepOpen = true;
          throw new Error(`发布前描述仍未写入成功（当前「${(again || '').slice(0, 48)}」），已中止以免发成文件名`);
        }
      }
    }
    await settleCopyrightAndConfirms(connection.page, saveTraffic ? 20000 : 45000, log);
    await clearStuckPublishMask(connection.page, log);
    const clicked = await clickPostButton(connection.page, log);
    if (!clicked) {
      keepOpen = true;
      return {
        status: 'failed',
        error: '未找到发布按钮，已保留浏览器页面',
        screenshot: prepared,
        material: { id: material.id, name: material.name, fileName: material.file_name },
      };
    }
    log('已点击发布，处理弹窗/遮罩并等待结果');
    let outcome = await drivePublishConfirmations(connection.page, saveTraffic ? 90000 : 150000, log);
    const shot = saveTraffic ? prepared : await capture(connection.page, accountId, 'publish', 'posted').catch(() => prepared);
    if (outcome.status === 'security_paused') {
      keepOpen = true;
      return { status: 'security_paused', reason: outcome.reason, screenshot: shot, manualRequired: true };
    }
    if (outcome.status !== 'published') {
      // 页面可能已发成功但文案/URL 未匹配：再解析一次 video_id，有则视为成功
      const meta = await resolvePublishedVideoMeta(
        connection.page,
        connection.account?.username || '',
        log
      ).catch(() => ({ videoId: '', videoUrl: '' }));
      if (meta.videoId) {
        log(`结果状态为 ${outcome.status}，但已找到 videoId=${meta.videoId}，按已发布处理`);
        outcome = { status: 'published', via: `recover:${outcome.status}`, videoId: meta.videoId, videoUrl: meta.videoUrl };
      }
    }
    if (outcome.status === 'published') {
      const username = String(
        connection.account?.username
        || (await dataStore.getAccountBundle(accountId).catch(() => null))?.username
        || ''
      ).replace(/^@/, '').trim();
      let videoId = String(outcome.videoId || '').trim();
      let videoUrl = String(outcome.videoUrl || '').trim();
      if (videoId && !videoUrl) videoUrl = buildPlatformVideoUrl(videoId, username);
      if (!videoId) {
        log('发布已确认，正在解析平台 videoId / 链接（供拉取视频数据使用）…');
        const meta = await resolvePublishedVideoMeta(
          connection.page,
          username,
          log
        ).catch(() => ({ videoId: '', videoUrl: '' }));
        videoId = String(meta.videoId || '').trim();
        videoUrl = String(meta.videoUrl || '').trim() || buildPlatformVideoUrl(videoId, username);
        if (videoId) log(`已解析平台 videoId=${videoId} url=${videoUrl || '-'}`);
        else log('已发布但尚未解析到平台 videoId（列表将缺少平台链接，正在二次尝试）');
      }
      if (!videoId && username) {
        await connection.page.waitForTimeout(4000);
        const newest = await fetchNewestVideoViaItemListApi(connection.page, username, log).catch(() => null);
        if (newest?.videoId) {
          videoId = newest.videoId;
          videoUrl = newest.videoUrl || buildPlatformVideoUrl(videoId, username);
          log(`二次 item_list 补全 videoId=${videoId}`);
        }
      }
      const published = {
        status: 'published',
        screenshot: shot,
        material: { id: material.id, name: material.name, fileName: material.file_name },
        videoId,
        videoUrl,
      };
      let marked = await markMaterialPublishedCallback(accountId, materialId, {
        videoId,
        videoUrl,
        deleteAfterPublish: !!options.deleteAfterPublish,
      });
      // 仍无 ID：抓主页网格写入 tiktok_videos 后再回写一次（修复「已发布但拉取页空白」）
      if (!videoId && username) {
        try {
          const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
          if (!new RegExp(`/@${username}(?:\\?|/|$)`, 'i').test(connection.page.url() || '')) {
            await connection.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await connection.page.waitForTimeout(2800);
          }
          const links = await connection.page.evaluate((uname) => (
            [...document.querySelectorAll(`a[href*="/@${uname}/video/"]`)]
              .map((a) => {
                const href = String(a.href || '').split('?')[0];
                const m = href.match(/\/video\/(\d{8,})/);
                return m ? {
                  videoId: m[1],
                  videoUrl: href,
                  description: String(a.innerText || a.getAttribute('aria-label') || '').slice(0, 200),
                  thumbnailUrl: a.querySelector('img')?.src || '',
                } : null;
              })
              .filter(Boolean)
          ), username).catch(() => []);
          if (links.length) {
            await dataStore.tiktokSync(accountId, { videos: links }).catch(() => {});
            videoId = String(links[0].videoId || '').trim();
            videoUrl = String(links[0].videoUrl || '').trim() || buildPlatformVideoUrl(videoId, username);
            published.videoId = videoId;
            published.videoUrl = videoUrl;
            if (videoId) {
              log(`主页网格补全 videoId=${videoId}，再次回写素材`);
              marked = await markMaterialPublishedCallback(accountId, materialId, {
                videoId,
                videoUrl,
                deleteAfterPublish: !!options.deleteAfterPublish,
              });
            }
          }
        } catch (e) {
          log(`主页网格补全失败：${e.message || e}`);
        }
      }
      if (!videoId) {
        liveLog(
          `素材 #${materialId} 已标记发布，但缺少平台视频链接；拉取视频数据页将看不到该素材，请到账号页同步视频后刷新创建页`,
          'warn',
          { accountId, materialId }
        );
      } else if (!marked?.ok) {
        liveLog(`素材 #${materialId} 平台链接已解析但回写失败：${marked?.error || '未知'}`, 'error', {
          accountId,
          materialId,
          videoId,
        });
      }
      return published;
    }
    keepOpen = true;
    console.error('[publish] not confirmed published', { accountId, materialId, outcome: outcome.status });
    return {
      status: 'failed',
      error: '已点击发布，但未确认成功',
      screenshot: shot,
      material: { id: material.id, name: material.name, fileName: material.file_name },
    };
  } finally {
    if (!keepOpen && !forceKeepOpen) await closeConnection(connection);
  }
}

async function resumePublish(accountId, options = {}) {
  await awaitSlot(`publish:${accountId}`, 12000);
  const saveTraffic = Boolean(options.saveTraffic);
  const connection = await connectAccount(accountId, '', 'publish');
  let keepOpen = false;
  try {
    const session = await inspectTikTokSession(connection.ws);
    if (!session.loggedIn) throw new Error('当前浏览器没有有效 TikTok 登录状态');
    const url = connection.page.url() || '';
    if (!/upload|tiktokstudio/i.test(url)) {
      await connection.page.goto('https://www.tiktok.com/upload', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await connection.page.waitForTimeout(saveTraffic ? 2000 : 4000);
    }
    const security = await inspectPage(connection.page);
    if (security.blocked) {
      keepOpen = true;
      return { status: 'security_paused', reason: security.reason, manualRequired: true };
    }
    await dismissPublishDialogs(connection.page);
    await clearStuckPublishMask(connection.page);
    const clicked = await clickPostButton(connection.page);
    if (!clicked) {
      keepOpen = true;
      const shot = await capture(connection.page, accountId, 'publish', 'resume-miss').catch(() => '');
      return { status: 'failed', error: '未找到发布按钮，请确认页面仍在上传/编辑态', screenshot: shot };
    }
    const outcome = await drivePublishConfirmations(connection.page, saveTraffic ? 90000 : 150000);
    const shot = await capture(connection.page, accountId, 'publish', 'resume-posted').catch(() => '');
    if (outcome.status === 'security_paused') {
      keepOpen = true;
      return { status: 'security_paused', reason: outcome.reason, screenshot: shot, manualRequired: true };
    }
    if (outcome.status === 'published') {
      const username = String(connection.account?.username || '').replace(/^@/, '').trim();
      let videoId = String(outcome.videoId || '').trim();
      let videoUrl = String(outcome.videoUrl || '').trim();
      if (videoId && !videoUrl) videoUrl = buildPlatformVideoUrl(videoId, username);
      if (!videoId) {
        const meta = await resolvePublishedVideoMeta(
          connection.page,
          username,
          (m) => console.log(`resumePublish: ${m}`)
        ).catch(() => ({ videoId: '', videoUrl: '' }));
        videoId = String(meta.videoId || '').trim();
        videoUrl = String(meta.videoUrl || '').trim() || buildPlatformVideoUrl(videoId, username);
      }
      if (!videoId && username) {
        const newest = await fetchNewestVideoViaItemListApi(
          connection.page,
          username,
          (m) => console.log(`resumePublish: ${m}`)
        ).catch(() => null);
        if (newest?.videoId) {
          videoId = newest.videoId;
          videoUrl = newest.videoUrl || buildPlatformVideoUrl(videoId, username);
        }
      }
      const published = { status: 'published', screenshot: shot, videoId, videoUrl };
      const mid = Number(options.materialId || options.material_id || 0);
      if (mid > 0) {
        await markMaterialPublishedCallback(accountId, mid, {
          videoId,
          videoUrl,
          deleteAfterPublish: !!options.deleteAfterPublish,
        });
      } else {
        console.warn('[mark-published] resumePublish missing materialId, skip material callback');
      }
      return published;
    }
    keepOpen = true;
    return { status: 'failed', error: '已点击发布，但未确认成功', screenshot: shot };
  } finally {
    if (!keepOpen) await closeConnection(connection);
  }
}

const {
  fillProfileField,
  clickProfileSave,
  openEditProfile,
  applyEditProfileChanges,
  saveEditProfileWithUsernameRecovery,
} = require('./tiktok-profile');

function pickDistributed(list, index, strategy = 'sequential') {
  if (!Array.isArray(list) || !list.length) return '';
  if (strategy === 'random') return list[Math.floor(Math.random() * list.length)];
  return list[index % list.length];
}

function normalizeProfileHandle(value) {
  return String(value || '').replace(/^@+/, '').trim();
}

/** 通过比特环境打开 TikTok 资料编辑页并修改 Username/昵称/签名/头像 */
async function modifyTikTokProfile(accountId, options = {}) {
  const username = normalizeProfileHandle(options.username || options.handle || '');
  const originalUsername = normalizeProfileHandle(
    options.originalUsername || options.original_username || '',
  );
  const nickname = String(options.nickname || options.displayName || '').trim();
  const hasOriginalNickname = options.originalNickname != null || options.original_nickname != null;
  const originalNickname = String(options.originalNickname ?? options.original_nickname ?? '').trim();
  const signature = String(options.signature || options.bio || '').trim();
  let avatarPath = String(options.avatarPath || options.avatarUrl || '').trim();
  if (!username && !nickname && !signature && !avatarPath) {
    throw new Error('未指定要修改的账号名称、昵称、签名或头像');
  }

  if (avatarPath) {
    const path = require('node:path');
    const fs = require('node:fs');
    const { uploadDir } = require('../../routes/uploads');
    // 上传接口返回 /uploads/xxx.jpg → 解析为本地绝对路径
    const m = avatarPath.match(/^\/?uploads\/([^/\\]+)$/i)
      || avatarPath.match(/\/uploads\/([^/\\]+)(?:\?|$)/i);
    if (m) {
      avatarPath = path.join(uploadDir, m[1]);
    }
    if (!path.isAbsolute(avatarPath)) {
      avatarPath = path.resolve(process.cwd(), avatarPath);
    }
    if (!fs.existsSync(avatarPath)) {
      // 头像文件缺失：改用默认头像，不让改资料任务失败
      const missing = avatarPath;
      avatarPath = require('./default-avatar').resolveAvatarOrDefault(missing, (m) => {
        try {
          require('../live-log').publish(`改资料#${accountId}：${m}`, 'warn', { accountId, ...(options.logContext || options.log_context || {}) });
        } catch { /* ignore */ }
      });
      if (!avatarPath) throw new Error(`头像文件不存在：${missing}`);
    }
    if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(avatarPath)) {
      throw new Error('头像仅支持图片（JPG/PNG/WebP/GIF）或视频（MP4，建议 ≤6 秒）');
    }
  }

  const connection = await connectAccount(accountId, null, 'profile', {
    saveTraffic: options.saveTraffic,
  });
  let keepOpen = false;
  // 分任务上下文：带上 batchId/itemId 才能落到「任务汇总 → 查看日志」
  const { publish: liveLog } = require('../live-log');
  const logCtx = { accountId, ...(options.logContext || options.log_context || {}) };
  const log = (msg) => liveLog(`改资料#${accountId}：${msg}`, 'info', logCtx);
  const logErr = (msg) => liveLog(`改资料#${accountId}：失败 ${msg}`, 'error', logCtx);

  // 逐字段结果：无论成功失败都记下来，供「修改资料记录」弹框查看
  const wantUser = normalizeProfileHandle(username);
  let navHandle = '';
  let applied = null;
  const buildFields = (extra = {}) => {
    const s = applied || {};
    const userRequested = !!wantUser && wantUser !== navHandle;
    const fields = {
      username: {
        requested: userRequested,
        target: wantUser || '',
        original: navHandle || '',
        ok: extra.usernameOk !== undefined ? !!extra.usernameOk : !!s.usernameFilled,
        reason: extra.usernameReason || s.usernameFailReason || '',
      },
      nickname: {
        requested: !!nickname,
        target: nickname || '',
        original: originalNickname || '',
        ok: extra.nicknameOk !== undefined ? !!extra.nicknameOk : !!s.nicknameFilled,
        reason: extra.nicknameReason || s.nameLockReason || s.nicknameFailReason || '',
        locked: !!s.nameLocked,
      },
      bio: {
        requested: !!signature,
        target: signature || '',
        ok: !!s.bioFilled,
        reason: s.bioFailReason || '',
      },
      avatar: {
        requested: !!avatarPath,
        target: avatarPath || '',
        ok: !!s.avatarFilled,
        reason: s.avatarFailReason || '',
      },
    };
    // 没点成保存：已填入的也不能算成功
    if (extra.notSubmitted) {
      for (const key of Object.keys(fields)) {
        if (!fields[key].requested) continue;
        fields[key].ok = false;
        fields[key].reason = fields[key].reason || '资料未提交（保存失败）';
      }
    }
    return fields;
  };
  /** 写一条「修改资料记录」（失败不影响主流程） */
  const record = async (status, message, extra = {}) => {
    const fields = buildFields(extra);
    let screenshot = '';
    if (extra.screenshot) {
      screenshot = require('node:path').basename(String(extra.screenshot));
    }
    try {
      await phpApi.post(`/node/accounts/${accountId}/profile-change-log`, {
        batchId: Number(logCtx.batchId || 0),
        itemId: Number(logCtx.itemId || 0),
        taskId: Number(logCtx.taskId || 0),
        status: String(status || 'failed'),
        message: String(message || ''),
        screenshot,
        fields,
      });
    } catch {
      /* 记录失败不影响主流程 */
    }
    return fields;
  };
  try {
    const session = await ensureSessionLoggedIn(connection, accountId, {
      reloadUrl: 'https://www.tiktok.com/',
      label: '改资料',
    });
    if (!session?.loggedIn) {
      logErr('当前浏览器没有有效 TikTok 登录状态');
      throw new Error('当前浏览器没有有效 TikTok 登录状态');
    }
    // 导航必须用 TikTok 当前仍有效的原 Username
    navHandle = originalUsername
      || normalizeProfileHandle(connection.account?.username)
      || username;
    let opened = false;
    let openError = '';
    try {
      opened = await openEditProfile(connection.page, navHandle, log);
    } catch (e) {
      openError = e.message || '打开编辑资料失败';
      opened = false;
    }
    if (!opened) {
      keepOpen = true;
      const shot = await capture(connection.page, accountId, 'profile', 'edit-miss').catch(() => '');
      logErr(openError || `未找到「编辑资料」按钮（导航主页 @${navHandle || '-'}，当前页 ${connection.page.url()}）`);
      if (shot) log(`截图：${shot}`);
      const fields = await record('failed', openError || '未找到「编辑资料」按钮', { screenshot: shot });
      return {
        status: 'failed',
        error: openError || '未找到「编辑资料」按钮，请确认已登录本人主页',
        screenshot: shot,
        fields,
      };
    }

    applied = await applyEditProfileChanges(connection.page, {
      username,
      originalUsername: navHandle,
      nickname,
      bio: signature,
      avatarPath,
    }, log);

    const lockedAt = nowChinaSql();

    if (applied.nameLocked && nickname && hasOriginalNickname) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        restoreNickname: originalNickname,
        nicknameLocked: true,
        markNicknameChanged: true,
      }).catch(() => {});
    }

    if (applied.nameLockedOnly) {
      log(`完成：${applied.nameLockReason || '昵称受 7 天限制'}，已跳过`);
      const nicknameReason = applied.nameLockReason || '距离上次修改未超过7天暂时无法修改';
      const fields = await record('ok', `昵称受 7 天限制已跳过（${nicknameReason}）`, {
        nicknameOk: false,
        nicknameReason,
      });
      return {
        status: 'ok',
        nameLocked: true,
        nicknameLocked: true,
        nicknameFilled: false,
        nickname,
        nicknameError: nicknameReason,
        nicknameLockedAt: lockedAt,
        originalUsername: navHandle,
        message: 'Name 当前受 7 天修改限制，已跳过',
        fields,
      };
    }
    if (!applied.changed) {
      keepOpen = true;
      const shot = await capture(connection.page, accountId, 'profile', 'fields-miss').catch(() => '');
      const wanted = [
        username ? `Username ${username}` : '',
        nickname ? `昵称 ${nickname}` : '',
        signature ? '签名' : '',
        avatarPath ? '头像' : '',
      ].filter(Boolean).join(' / ') || '无';
      const reason = applied.nameLockReason
        ? `昵称不可改（${applied.nameLockReason}）`
        : '未找到可编辑的 Username / Bio / 头像；昵称输入框可能被 TikTok 置为只读文案';
      const error = `未能写入任何字段（目标：${wanted}）：${reason}`;
      logErr(error);
      const fields = await record('failed', error, { screenshot: shot });
      return {
        status: 'failed',
        error,
        screenshot: shot,
        nicknameError: applied.nameLockReason || undefined,
        nicknameLockedAt: applied.nameLocked ? lockedAt : undefined,
        originalUsername: navHandle,
        fields,
      };
    }

    const saveResult = await saveEditProfileWithUsernameRecovery(connection.page, {
      originalUsername: navHandle,
      attemptedUsername: applied.usernameAttempted || username,
    }, log);
    if (saveResult.usernameConflict) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        restoreUsername: navHandle,
      }).catch(() => {});
    }

    if (!saveResult.saved) {
      keepOpen = true;
      const shot = await capture(connection.page, accountId, 'profile', 'save-miss').catch(() => '');
      const error = saveResult.usernameConflict
        ? `账号名称不可用，已恢复原账号名：${saveResult.usernameFailReason || 'Username unavailable'}`
        : '已填写资料但未找到保存按钮';
      logErr(error);
      const fields = await record('failed', error, {
        usernameOk: false,
        usernameReason: saveResult.usernameFailReason
          || (saveResult.usernameConflict ? '账号名称已被占用' : '未找到保存按钮，用户名未提交'),
        notSubmitted: true,
        screenshot: shot,
      });
      return {
        status: 'failed',
        error,
        screenshot: shot,
        manualRequired: !saveResult.usernameConflict,
        originalUsername: navHandle,
        usernameFailReason: saveResult.usernameFailReason || undefined,
        usernameConflict: !!saveResult.usernameConflict,
        nameLocked: !!applied.nameLocked,
        nicknameLocked: !!applied.nameLocked,
        nicknameFilled: !!applied.nicknameFilled,
        nicknameError: applied.nameLockReason || undefined,
        nicknameLockedAt: applied.nameLocked ? lockedAt : undefined,
        fields,
      };
    }

    // 只有「昵称确实改了」才记 7 天冷却时间，避免填了同值也被锁定
    if (applied.nicknameFilled && applied.nicknameValueChanged !== false) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        nicknameSuccess: true,
        markNicknameChanged: true,
      }).catch(() => {});
    }

    await connection.page.waitForTimeout(1200);
    const shot = await capture(connection.page, accountId, 'profile', 'saved').catch(() => '');
    const parts = [];
    if (saveResult.usernameConflict) parts.push('Username 不可用已恢复原账号名');
    if (applied.nameLocked) parts.push('昵称受 7 天限制已跳过');
    if (!parts.length) parts.push('资料已提交');
    log(`完成：${parts.join('；')}`);

    // 成功/部分成功也要记：哪一项成功、哪一项为什么没改
    const fields = await record('ok', parts.join('；'), {
      usernameOk: saveResult.usernameConflict
        ? false
        : (applied.usernameAttempted ? !!applied.usernameFilled : true),
      usernameReason: saveResult.usernameConflict
        ? (saveResult.usernameFailReason || '账号名称已被占用，已恢复原账号名')
        : (applied.usernameAttempted && !applied.usernameFilled ? (applied.usernameFailReason || '用户名未能填入') : ''),
      nicknameOk: !!applied.nicknameFilled,
      screenshot: shot,
    });

    return {
      status: 'ok',
      username: saveResult.usernameConflict ? navHandle : (username || undefined),
      nickname: applied.nicknameFilled ? nickname : undefined,
      signature: signature || undefined,
      screenshot: shot,
      originalUsername: navHandle,
      usernameFailReason: saveResult.usernameFailReason || undefined,
      usernameConflict: !!saveResult.usernameConflict,
      nameLocked: !!applied.nameLocked,
      nicknameLocked: !!applied.nameLocked,
      nicknameFilled: !!applied.nicknameFilled,
      nicknameError: applied.nameLockReason || undefined,
      nicknameLockedAt: applied.nameLocked ? lockedAt : undefined,
      message: parts.join('；'),
      fields,
    };
  } catch (error) {
    await record('failed', error.message || '修改资料失败');
    throw error;
  } finally {
    if (!keepOpen) await closeConnection(connection);
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function batchModifyTikTokProfiles(accountIds, options = {}) {
  const nicknameList = String(options.nicknameList || '')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const signatureList = String(options.signatureList || '')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const avatarFolder = String(options.avatarFolder || '').trim();
  const strategy = options.distributionStrategy === 'random' ? 'random' : 'sequential';
  const threads = Math.min(5, Math.max(1, Number(options.threads) || 1));
  const modifyNickname = options.modifyNickname !== false && nicknameList.length > 0;
  const modifySignature = options.modifySignature !== false && signatureList.length > 0;
  const modifyAvatar = options.modifyAvatar === true && avatarFolder;

  const fs = require('node:fs');
  const path = require('node:path');
  let avatars = [];
  if (modifyAvatar) {
    if (!fs.existsSync(avatarFolder) || !fs.statSync(avatarFolder).isDirectory()) {
      throw new Error('头像文件夹不存在或不是目录');
    }
    avatars = fs.readdirSync(avatarFolder)
      .filter((name) => /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(name))
      .map((name) => path.join(avatarFolder, name));
    if (!avatars.length) throw new Error('头像文件夹内没有可用图片或视频（支持 JPG/PNG/WebP/GIF/MP4）');
  }
  if (!modifyNickname && !modifySignature && !modifyAvatar) {
    throw new Error('请至少开启昵称、签名或头像其中一项');
  }

  const items = await runPool(accountIds, threads, async (accountId, index) => {
    try {
      const result = await modifyTikTokProfile(accountId, {
        nickname: modifyNickname ? pickDistributed(nicknameList, index, strategy) : '',
        signature: modifySignature ? pickDistributed(signatureList, index, strategy) : '',
        avatarPath: modifyAvatar ? pickDistributed(avatars, index, strategy) : '',
      });
      return { accountId, ok: result.status === 'ok', ...result };
    } catch (error) {
      return { accountId, ok: false, status: 'failed', error: error.message };
    }
  });
  return {
    items,
    success: items.filter((x) => x.ok).length,
    failed: items.filter((x) => !x.ok).length,
  };
}

/** 在 Studio DOM（含 shadow / iframe）里找搜索框并打标 */
async function markStudioSearchInput(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  let last = { ok: false, url: page.url(), placeholders: [] };
  for (const frame of frames) {
    const ok = await frame.evaluate(() => {
      const walk = (root, out = []) => {
        root.querySelectorAll?.('input, textarea').forEach((n) => out.push(n));
        root.querySelectorAll?.('*').forEach((n) => {
          if (n.shadowRoot) walk(n.shadowRoot, out);
        });
        return out;
      };
      document.querySelectorAll('[data-tk-studio-search]').forEach((n) => n.removeAttribute('data-tk-studio-search'));
      const inputs = walk(document);
      const score = (el) => {
        const ph = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${el.className || ''}`;
        let s = 0;
        if (/Search for post description/i.test(ph)) s += 100;
        if (/search.*post|post.*description|搜索.*(作品|描述|标题)/i.test(ph)) s += 50;
        if (/search|搜索/i.test(ph)) s += 20;
        if (el.type === 'search') s += 10;
        if (el.offsetParent === null && el.getClientRects().length === 0) s -= 30;
        return s;
      };
      inputs.sort((a, b) => score(b) - score(a));
      const best = inputs.find((el) => score(el) > 0);
      if (!best) {
        return {
          ok: false,
          url: location.href,
          placeholders: inputs.slice(0, 12).map((el) => el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.type || ''),
        };
      }
      best.setAttribute('data-tk-studio-search', '1');
      try { best.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
      return {
        ok: true,
        url: location.href,
        placeholder: best.getAttribute('placeholder') || best.getAttribute('aria-label') || '',
      };
    }).catch(() => null);
    if (ok?.ok) return ok;
    if (ok) last = ok;
  }
  return last;
}

/** 搜索框只搜完整发布标题一次；不要拆一堆前缀/视频 ID 反复搜 */
function studioSearchTerms(title) {
  const raw = String(title || '').trim();
  const first = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return first ? [first] : [];
}

/**
 * 标记 Studio 列表中的目标行。
 * 注意：列表标题常被截成 "xxx…"，完整标题不一定出现在 DOM 文本里；
 * 搜索过滤后若只剩 1 条内容行，直接采用。
 */
async function markStudioContentRow(page, needle, videoId = '', opts = {}) {
  const n = String(needle || '').trim();
  const vid = String(videoId || '').trim();
  const acceptSingle = opts.acceptSingleResult !== false;
  if (!n && !vid && !acceptSingle) return false;
  return page.evaluate(({ text, videoId: id, acceptSingleResult }) => {
    document.querySelectorAll('[data-tk-del-row]').forEach((el) => el.removeAttribute('data-tk-del-row'));
    const rowSel = 'tr, [role="row"], [class*="Row"], [class*="row"], li, [class*="Item"], [class*="item"], [class*="card" i], [class*="Card"]';
    const isHeader = (t) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (!s) return true;
      if (/^Posts\s*\(Created on\)/i.test(s) && s.length < 80) return true;
      if (/^(Posts|Privacy|Views|Likes|Comments|Actions)(\s|$)/i.test(s) && s.length < 120) return true;
      return false;
    };
    const hasActions = (row) => !!row.querySelector('button, [role="button"], svg');
    const mark = (row) => {
      row.setAttribute('data-tk-del-row', '1');
      try { row.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      return true;
    };
    const allRows = [...document.querySelectorAll(rowSel)];
    const dataRows = allRows.filter((row) => {
      const t = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || isHeader(t)) return false;
      // 内容行：有时长/隐私/操作按钮等特征
      if (hasActions(row)) return true;
      if (/\bEveryone\b|\bFriends\b|\bOnly you\b|仅自己|好友|所有人/i.test(t)) return true;
      if (/\d{1,2}:\d{2}/.test(t) && /Views|Likes|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|\d{4}/i.test(t)) return true;
      return false;
    });

    // 1) videoId 链接
    if (id && /^\d{5,}$/.test(id)) {
      for (const a of document.querySelectorAll(`a[href*="/video/${id}"], a[href*="${id}"]`)) {
        const row = a.closest(rowSel);
        if (row && !isHeader(row.innerText || '')) return mark(row);
      }
    }

    // 2) 搜索后列表只剩 1 条：直接用（用户场景：名称一搜就出来）
    if (acceptSingleResult && dataRows.length === 1) {
      return mark(dataRows[0]);
    }

    if (!text) return false;
    const needleLower = text.toLowerCase();
    const prefix20 = text.slice(0, Math.min(20, text.length)).toLowerCase();
    const prefix32 = text.slice(0, Math.min(32, text.length)).toLowerCase();

    const rowMatchesTitle = (row) => {
      const t = (row.innerText || '').replace(/\s+/g, ' ');
      const tl = t.toLowerCase();
      if (id && row.querySelector(`a[href*="${id}"]`)) return true;
      // 完整标题（少见，未截断时）
      if (tl.includes(needleLower)) return true;
      // 截断标题：DOM 里是 "14 head … for melon…"，用前缀匹配
      if (prefix20.length >= 8 && tl.includes(prefix20)) return true;
      if (prefix32.length >= 12 && tl.includes(prefix32)) return true;
      // 反过来：行内标题去掉省略号后，完整发布标题以其开头
      for (const el of row.querySelectorAll('a, span, div, p, strong, h1, h2, h3')) {
        let s = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!s || s.length < 8 || s.length > 240) continue;
        s = s.replace(/[…．.。]{2,}$/u, '').replace(/\.{2,}$/g, '').trim();
        const sl = s.toLowerCase();
        if (!sl) continue;
        if (needleLower.startsWith(sl) || sl.startsWith(prefix20) || needleLower.includes(sl) || sl.includes(prefix20)) {
          return true;
        }
      }
      return false;
    };

    for (const row of dataRows) {
      if (rowMatchesTitle(row)) return mark(row);
    }
    // 宽松：任意带操作按钮的行
    for (const row of allRows) {
      const t = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || isHeader(t) || !hasActions(row)) continue;
      if (rowMatchesTitle(row)) return mark(row);
    }
    // 搜索结果 2～3 条时，取第一条标题前缀最像的
    if (acceptSingleResult && dataRows.length > 1 && dataRows.length <= 3 && prefix20.length >= 8) {
      const hit = dataRows.find((row) => (row.innerText || '').toLowerCase().includes(prefix20));
      if (hit) return mark(hit);
    }
    return false;
  }, { text: n, videoId: vid, acceptSingleResult: acceptSingle }).catch(() => false);
}

/**
 * 与发布一致：Studio 列表显示的「作品名」= 发布时填入的标题。
 * 发布表单默认：shareTitle || material.name；禁止用同步描述里的 videoplayback 等垃圾串。
 */
function isJunkPublishTitle(raw) {
  let t = String(raw || '').trim();
  if (!t) return true;
  t = t.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  if (!t) return true;
  if (/^\d{8,}$/.test(t)) return true;
  const base = t.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  if (/^(videoplayback|untitled|no title|tiktok|video|null|undefined|none|n\/a)$/i.test(t)) return true;
  if (/^(videoplayback|untitled|no title|tiktok|video|null|undefined|none|n\/a)$/i.test(base)) return true;
  return false;
}

function normalizePublishTitle(raw) {
  if (isJunkPublishTitle(raw)) return '';
  return String(raw || '').trim().split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
}

/** 与发布弹窗同一套：分享标题 → 素材名 → 文件名（去垃圾） */
function titleFromMaterial(mat) {
  if (!mat || typeof mat !== 'object') return '';
  return normalizePublishTitle(
    mat.shareTitle
    || mat.share_title
    || mat.name
    || mat.fileName
    || mat.file_name
    || ''
  );
}

/** 解析 Studio 搜索用的发布标题（与发布字段一致，绝不用 video_id / videoplayback） */
async function resolveDeletePublishTitle(accountId, options = {}) {
  const pickTitle = (...vals) => {
    for (const v of vals) {
      const t = normalizePublishTitle(v);
      if (t) return t;
    }
    return '';
  };

  // 1) 入队时明确带的发布标题 / 素材名（description 最后且需过垃圾过滤）
  let title = pickTitle(
    options.publishTitle,
    options.publish_title,
    options.shareTitle,
    options.share_title,
    options.materialName,
    options.material_name,
    options.searchTitle,
    options.title,
    options.description
  );
  if (title) return { title, source: 'payload' };

  const mid = Number(options.materialId || options.material_id || 0);
  const videoId = String(options.videoId || options.video_id || '').trim();
  const idFromUrl = String(options.videoUrl || options.video_url || '').match(/\/video\/(\d+)/)?.[1] || '';
  const targetId = videoId || idFromUrl;

  // 2) 按 materialId 取素材（与发布同一字段）
  if (mid > 0) {
    const mat = await phpApi.get(`/node/materials/${mid}`).catch(() => phpApi.get(`/materials/${mid}`).catch(() => null));
    title = titleFromMaterial(mat);
    if (title) return { title, source: `material#${mid}` };
  }

  // 3) 该账号已发布素材：按 platform_video_id 精确匹配
  try {
    const pack = await phpApi.get(`/materials?publishAccountId=${Number(accountId) || 0}&publishStatus=published`).catch(() => null);
    const items = Array.isArray(pack) ? pack : (pack?.items || []);
    let mat = null;
    if (targetId) {
      mat = items.find((m) => String(m.platformVideoId || m.platform_video_id || '').trim() === targetId) || null;
    }
    if (!mat && mid > 0) {
      mat = items.find((m) => Number(m.id) === mid) || null;
    }
    title = titleFromMaterial(mat);
    if (title) return { title, source: `materials-by-account#${mat?.id || '?'}` };
  } catch { /* ignore */ }

  // 4) 全库按 platform_video_id
  if (targetId) {
    try {
      const pack = await phpApi.get('/materials').catch(() => null);
      const items = Array.isArray(pack) ? pack : (pack?.items || []);
      const mat = items.find((m) => String(m.platformVideoId || m.platform_video_id || '').trim() === targetId) || null;
      title = titleFromMaterial(mat);
      if (title) return { title, source: `materials-by-video#${mat?.id || '?'}` };
    } catch { /* ignore */ }
  }

  // 5) 最后才用同步描述，且必须不是 videoplayback 之类
  if (targetId) {
    try {
      const videos = await phpApi.get(`/accounts/${accountId}/tiktok-videos`).catch(() => []);
      const list = Array.isArray(videos) ? videos : (videos?.items || []);
      const hit = list.find((v) => String(v.video_id || v.videoId || '').trim() === targetId);
      title = pickTitle(hit?.description);
      if (title) return { title, source: 'tiktok_videos.description' };
    } catch { /* ignore */ }
  }

  return { title: '', source: 'none' };
}

/**
 * 在 Studio 列表 HTML 里按 videoId / 视频链接标记行。
 * 匹配 a[href*="/video/{id}"]，并提升到含 Actions 的整行。
 */
async function markStudioRowByVideoId(page, videoId) {
  const id = String(videoId || '').trim();
  if (!/^\d{5,}$/.test(id)) return { ok: false, reason: 'invalid-id' };
  return page.evaluate((vid) => {
    document.querySelectorAll('[data-tk-del-row]').forEach((el) => el.removeAttribute('data-tk-del-row'));
    // eslint-disable-next-line no-new-func
    const resolveActionRow = (fromEl) => {
      if (!fromEl) return null;
      let node = fromEl;
      let best = null;
      let bestScore = 0;
      while (node && node !== document.body && node !== document.documentElement) {
        const btns = node.querySelectorAll('button, [role="button"]').length;
        const svgs = node.querySelectorAll('svg').length;
        const hasVideo = !!node.querySelector('a[href*="/video/"]');
        let score = 0;
        if (node.tagName === 'TR') score += 50;
        if (btns >= 3) score += 40;
        else if (btns >= 1) score += 15;
        if (svgs >= 3) score += 20;
        if (hasVideo) score += 10;
        if (/\b(row|Row|Post|post|item|Item)\b/.test(String(node.className || ''))) score += 8;
        try {
          const r = node.getBoundingClientRect();
          if (r.width >= 480) score += 12;
          if (r.width < 160) score -= 20;
        } catch { /* ignore */ }
        if (score > bestScore && (btns >= 1 || svgs >= 2)) {
          bestScore = score;
          best = node;
        }
        if (node.tagName === 'TR' && (btns >= 1 || svgs >= 2)) {
          best = node;
          break;
        }
        node = node.parentElement;
      }
      return best || fromEl.closest('tr') || fromEl;
    };
    const mark = (el) => {
      const row = resolveActionRow(el);
      if (!row) return false;
      row.setAttribute('data-tk-del-row', '1');
      try { row.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
      const btns = row.querySelectorAll('button, [role="button"]').length;
      const svgs = row.querySelectorAll('svg').length;
      return { ok: true, btns, svgs, tag: row.tagName, w: Math.round(row.getBoundingClientRect().width || 0) };
    };
    const hrefHas = (el) => {
      const href = `${el.getAttribute('href') || ''} ${el.getAttribute('data-href') || ''}`;
      return href.includes(`/video/${vid}`) || href.includes(`video_id=${vid}`) || href.includes(`item_id=${vid}`);
    };
    for (const a of document.querySelectorAll('a[href]')) {
      if (!hrefHas(a)) continue;
      const info = mark(a);
      if (info) return { ok: true, via: 'a-href', href: a.getAttribute('href') || '', ...info };
    }
    for (const el of document.querySelectorAll('[href], [data-href], [data-video-id], [data-id], [data-item-id]')) {
      const blob = [
        el.getAttribute('href'),
        el.getAttribute('data-href'),
        el.getAttribute('data-video-id'),
        el.getAttribute('data-id'),
        el.getAttribute('data-item-id'),
      ].filter(Boolean).join(' ');
      if (!blob.includes(vid)) continue;
      const info = mark(el);
      if (info) return { ok: true, via: 'data-attr', href: blob.slice(0, 160), ...info };
    }
    return { ok: false, reason: 'not-in-dom' };
  }, id).catch((e) => ({ ok: false, reason: e.message || 'evaluate-failed' }));
}

/**
 * 在已标记行内点「⋯」：Studio Actions 多为圆形图标按钮（SVG），不一定有 More 文案。
 * 策略：优先 aria-label=More；否则取行内最右侧的操作图标。
 */
async function clickStudioRowMoreMenu(page, log = () => {}) {
  const info = await page.evaluate(() => {
    document.querySelectorAll('[data-tk-more]').forEach((el) => el.removeAttribute('data-tk-more'));
    const row = document.querySelector('[data-tk-del-row="1"]');
    if (!row) return { ok: false, reason: 'no-row' };

    const seen = new Set();
    const candidates = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      if (el.closest('input, textarea, select, [role="listbox"], [role="combobox"]')) return;
      // 隐私下拉（Everyone）不是 More
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${(el.innerText || '').slice(0, 40)}`;
      if (/Everyone|Friends|Only you|所有人|好友|仅自己|Privacy|公开/i.test(label) && !/more|更多/i.test(label)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10 || r.width > 80 || r.height > 80) return;
      if (r.bottom < 0 || r.top > (window.innerHeight || 800)) return;
      seen.add(el);
      candidates.push({
        el,
        left: r.left,
        top: r.top,
        label: label.trim(),
        tag: el.tagName,
      });
    };

    row.querySelectorAll('button, [role="button"]').forEach(add);
    // 圆形图标容器：内部主要是 svg
    row.querySelectorAll('div, span, a').forEach((el) => {
      const svg = el.querySelector(':scope > svg, :scope > span > svg, svg');
      if (!svg) return;
      if (el.querySelector('img[src*="http"]') && el.querySelectorAll('svg').length === 0) return;
      const childCount = el.childElementCount;
      if (childCount > 4) return;
      add(el);
    });

    if (!candidates.length) {
      return {
        ok: false,
        reason: 'no-btn',
        rowTag: row.tagName,
        rowW: Math.round(row.getBoundingClientRect().width || 0),
        btnCount: row.querySelectorAll('button, [role="button"]').length,
        svgCount: row.querySelectorAll('svg').length,
      };
    }

    let more = candidates.find((c) => /more|更多|more options|选项/i.test(c.label));
    if (!more) {
      // Actions 在行右侧：取最靠右的图标；同列取最后一个
      candidates.sort((a, b) => (b.left - a.left) || (a.top - b.top));
      more = candidates[0];
    }
    more.el.setAttribute('data-tk-more', '1');
    try { more.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
    return {
      ok: true,
      count: candidates.length,
      label: more.label || more.tag,
      left: Math.round(more.left),
    };
  }).catch((e) => ({ ok: false, reason: e.message || 'evaluate-failed' }));

  if (!info?.ok) {
    log(`⋯ 定位失败：${info?.reason || 'unknown'} row=${info?.rowTag || '-'} w=${info?.rowW || 0} btn=${info?.btnCount || 0} svg=${info?.svgCount || 0}`);
    return info;
  }
  log(`⋯ 候选 ${info.count} 个，点击最右侧操作（${info.label || 'icon'}）`);
  const btn = page.locator('[data-tk-more="1"]').first();
  await btn.click({ timeout: 8000, force: true }).catch(async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-tk-more="1"]');
      if (el) el.click();
    });
  });
  return info;
}

/** 统计列表里可见作品行数量（用于判断滚动是否加载了更多） */
async function countStudioListRows(page) {
  return page.evaluate(() => {
    const rowSel = 'tr, [role="row"], [class*="Row"], [class*="row"], li, [class*="Item"], [class*="item"], [class*="card" i], [class*="Card"]';
    const rows = [...document.querySelectorAll(rowSel)];
    let n = 0;
    for (const row of rows) {
      const t = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 8) continue;
      if (/^Posts\s*\(Created on\)/i.test(t) && t.length < 80) continue;
      if (/^(Posts|Privacy|Views|Likes|Comments|Actions)(\s|$)/i.test(t) && t.length < 100) continue;
      if (row.querySelector('button, [role="button"], svg, a[href*="/video/"]')) n += 1;
    }
    // 也统计含 /video/ 的链接数，作为加载进度
    const links = document.querySelectorAll('a[href*="/video/"]').length;
    return { rows: n, videoLinks: links, scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0 };
  }).catch(() => ({ rows: 0, videoLinks: 0, scrollHeight: 0 }));
}

/**
 * 滚动 Studio 列表，按 videoId 匹配链接，直到找到或没有更多数据。
 */
async function scrollStudioListFindByVideoId(page, videoId, log = () => {}) {
  const id = String(videoId || '').trim();
  if (!/^\d{5,}$/.test(id)) return { ok: false, reason: 'missing-video-id' };

  let stableRounds = 0;
  let lastLinks = -1;
  let lastHeight = -1;
  const maxRounds = 80; // 足够滚完长列表

  for (let round = 0; round < maxRounds; round += 1) {
    const hit = await markStudioRowByVideoId(page, id);
    if (hit?.ok) {
      log(`已在列表 HTML 中匹配到 /video/${id}（via=${hit.via || '-'}，滚动第 ${round + 1} 轮）`);
      return { ok: true, via: hit.via || 'href', round: round + 1, href: hit.href || '' };
    }

    const stats = await countStudioListRows(page);
    log(`滚动加载更多… 第 ${round + 1} 轮，当前链接约 ${stats.videoLinks} 条`);

    // 优先滚列表容器，再滚窗口
    await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('[class*="scroll" i], [class*="Scroll" i], [class*="list" i], [class*="List" i], main, [role="main"]'),
        document.scrollingElement,
        document.documentElement,
        document.body,
      ].filter(Boolean);
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        try {
          const sh = el.scrollHeight || 0;
          const ch = el.clientHeight || 0;
          if (sh > ch + 80 && sh > bestScore) {
            best = el;
            bestScore = sh;
          }
        } catch { /* ignore */ }
      }
      if (best) best.scrollTop = (best.scrollTop || 0) + Math.max(600, Math.floor((best.clientHeight || 800) * 0.9));
      else window.scrollBy(0, 1200);
    }).catch(() => {});
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(900);

    const after = await countStudioListRows(page);
    const grew = after.videoLinks > lastLinks || after.scrollHeight > lastHeight + 40 || after.rows > (stats.rows || 0);
    lastLinks = Math.max(lastLinks, after.videoLinks);
    lastHeight = Math.max(lastHeight, after.scrollHeight);
    if (!grew) {
      stableRounds += 1;
      if (stableRounds >= 3) {
        log(`列表已无更多数据（连续 ${stableRounds} 轮未增长，共约 ${after.videoLinks} 条链接）`);
        break;
      }
    } else {
      stableRounds = 0;
    }
  }

  const last = await markStudioRowByVideoId(page, id);
  if (last?.ok) return { ok: true, via: last.via || 'href', href: last.href || '' };
  return { ok: false, reason: 'exhausted-list', videoLinks: lastLinks };
}

/** Studio 内容列表：按视频链接/ID 滚动匹配 → 三点 → Delete → 确认。禁止打开公开直链页。 */
async function deleteTikTokVideo(accountId, options = {}) {
  const videoId = String(options.videoId || options.video_id || '').trim();
  let videoUrl = String(options.videoUrl || options.video_url || '').trim();
  const idFromUrl = videoUrl.match(/\/video\/(\d+)/)?.[1] || '';
  const targetId = videoId || idFromUrl;

  const resolved = await resolveDeletePublishTitle(accountId, options).catch(() => ({ title: '', source: 'none' }));
  const title = String(resolved.title || '').trim();
  const firstLine = title.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const searchTitle = studioSearchTerms(firstLine || title)[0] || firstLine;

  if (!targetId && !searchTitle) {
    throw new Error(
      `缺少平台 videoId/视频链接，无法在 Studio 列表匹配。materialId=${options.materialId || options.material_id || 0}。请先同步视频后再删。`
    );
  }

  const connection = await connectAccount(accountId, null, 'profile');
  let keepOpen = false;
  const log = (msg) => {
    try {
      const { publish: liveLog } = require('../live-log');
      liveLog(`[删除视频] 账号#${accountId} ${msg}`, 'info', { accountId, videoId: targetId, title: firstLine });
    } catch { /* ignore */ }
    console.log(`[delete-video] #${accountId}`, msg);
  };
  log(`目标 videoId=${targetId || '-'} 标题="${firstLine || '-'}"`);

  try {
    const session = await inspectTikTokSession(connection.ws);
    if (!session.loggedIn) throw new Error('当前浏览器没有有效 TikTok 登录状态');
    const page = connection.page;

    // 只进 Studio 作品列表，绝不 goto 公开 /video/ 直链
    const studioUrls = [
      'https://www.tiktok.com/tiktokstudio/content?lang=en',
      'https://www.tiktok.com/tiktokstudio/content?tab=video&lang=en',
      'https://www.tiktok.com/tiktokstudio/content',
    ];
    let listReady = false;
    for (const studioUrl of studioUrls) {
      log(`打开 Studio 列表 ${studioUrl}`);
      await page.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          await solveRotateCaptchaIfPresent(page, { accountId });
        } catch { /* ignore */ }
        const ready = await page.evaluate(() => {
          const t = (document.body?.innerText || '').slice(0, 8000);
          return /Posts\s*\(Created on\)|Search for post description|Views[\s\S]{0,40}Likes|Privacy/i.test(t)
            || !!document.querySelector('a[href*="/video/"]');
        }).catch(() => false);
        if (ready) {
          listReady = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (listReady) break;
    }
    log(`Studio 地址=${page.url()} 就绪=${listReady}`);

    let matchedTerm = '';
    let findVia = '';

    // 主路径：用 videoId 在列表 HTML 的链接里匹配，滚动加载直到找到或没有更多
    if (targetId) {
      log(`按视频链接匹配 /video/${targetId}，滚动列表加载…`);
      const found = await scrollStudioListFindByVideoId(page, targetId, log);
      if (found.ok) {
        matchedTerm = targetId;
        findVia = found.via || 'video-id-href';
      } else {
        log(`滚动完毕仍未匹配到 /video/${targetId}（${found.reason || 'miss'}）`);
      }
    }

    // 兜底：无 videoId 或链接未挂上时，才用标题滚找（不反复搜索框）
    if (!matchedTerm && searchTitle) {
      log(`链接未命中，改按标题滚找：${searchTitle}`);
      for (let round = 0; round < 40; round++) {
        if (await markStudioContentRow(page, searchTitle, targetId, { acceptSingleResult: false })) {
          matchedTerm = searchTitle;
          findVia = 'title-scroll';
          break;
        }
        const before = await countStudioListRows(page);
        await page.mouse.wheel(0, 1400).catch(() => {});
        await page.waitForTimeout(800);
        const after = await countStudioListRows(page);
        if (after.videoLinks <= before.videoLinks && after.scrollHeight <= before.scrollHeight + 40 && round > 2) {
          // 再确认两轮无增长则停
          let stable = true;
          for (let k = 0; k < 2; k++) {
            await page.mouse.wheel(0, 1400).catch(() => {});
            await page.waitForTimeout(700);
            const again = await countStudioListRows(page);
            if (again.videoLinks > after.videoLinks || again.scrollHeight > after.scrollHeight + 40) {
              stable = false;
              break;
            }
          }
          if (stable) break;
        }
      }
    }

    if (!matchedTerm) {
      keepOpen = true;
      const shot = await capture(page, accountId, 'video', 'studio-row-miss').catch(() => '');
      return {
        status: 'failed',
        error: `Studio 列表滚动完毕仍未匹配到视频${targetId ? ` /video/${targetId}` : ''}${firstLine ? `「${firstLine}」` : ''}。请确认已同步到正确 video_id，或视频不在该账号作品列表中。当前页: ${(page.url() || '').slice(0, 120)}`,
        via: 'studio-list-scroll',
        screenshot: shot,
      };
    }

    log(`已定位视频（via=${findVia}）「${matchedTerm}」，打开 ⋯ 菜单`);
    const moreClick = await clickStudioRowMoreMenu(page, log);
    if (!moreClick?.ok) {
      keepOpen = true;
      const shot = await capture(page, accountId, 'video', 'more-miss').catch(() => '');
      return {
        status: 'failed',
        error: `找到视频但未找到「⋯」更多按钮（${moreClick?.reason || 'unknown'}，行宽=${moreClick?.rowW || 0}，btn=${moreClick?.btnCount || 0}，svg=${moreClick?.svgCount || 0}）`,
        via: 'studio-list',
        screenshot: shot,
      };
    }
    await page.waitForTimeout(1000);

    log('点击菜单「删除」');
    let menuDelete = null;
    const menuCandidates = [
      page.getByRole('menuitem', { name: /^Delete$|^删除$/i }).first(),
      page.locator('[role="menu"] [role="menuitem"], [role="listbox"] [role="option"], [class*="Menu"] [role="menuitem"]')
        .filter({ hasText: /^Delete$|^删除$/i }).first(),
      page.locator('[role="menu"], [data-radix-menu-content], [class*="DropdownMenu"]').getByText(/^Delete$|^删除$/i).first(),
      page.getByText(/^Delete$/).last(),
      page.getByText(/^删除$/).last(),
    ];
    for (const c of menuCandidates) {
      if (await c.count().catch(() => 0) && await c.isVisible().catch(() => false)) {
        menuDelete = c;
        break;
      }
    }
    if (!menuDelete) {
      keepOpen = true;
      const shot = await capture(page, accountId, 'video', 'menu-delete-miss').catch(() => '');
      return { status: 'failed', error: '已点⋯但未出现 Delete/删除（请确认账号有删帖权限）', via: 'studio-list', screenshot: shot };
    }
    await menuDelete.click({ timeout: 8000 });
    await page.waitForTimeout(1200);

    log('确认删除帖子？');
    const dialogCandidates = [
      page.getByRole('dialog').filter({ hasText: /Delete post|删除作品|删除帖子|Recently deleted|Delete this post/i }).first(),
      page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /Delete post|删除|Recently deleted/i }).first(),
      page.locator('[class*="Modal"], [class*="modal"], [class*="Dialog"], [class*="dialog"]').filter({ hasText: /Delete post|删除/i }).first(),
    ];
    let dialog = null;
    for (let wait = 0; wait < 8 && !dialog; wait += 1) {
      for (const c of dialogCandidates) {
        if (await c.count().catch(() => 0) && await c.isVisible().catch(() => false)) {
          dialog = c;
          break;
        }
      }
      if (!dialog) await page.waitForTimeout(400);
    }

    let confirmBtn = null;
    if (dialog) {
      // 弹框里的 Delete，避开 Cancel
      confirmBtn = dialog.getByRole('button', { name: /^Delete$|^删除$/i }).first();
      if (!(await confirmBtn.count().catch(() => 0))) {
        confirmBtn = dialog.locator('button').filter({ hasText: /^Delete$|^删除$/i }).first();
      }
      // 有的皮肤主按钮文案在 span 里
      if (!(await confirmBtn.count().catch(() => 0))) {
        confirmBtn = dialog.locator('button').filter({ hasText: /Delete|删除/i }).filter({ hasNotText: /Cancel|取消|Keep|保留/i }).last();
      }
    }
    if (!confirmBtn || !(await confirmBtn.count().catch(() => 0))) {
      confirmBtn = page.getByRole('button', { name: /^Delete$/i }).last();
    }
    if (!(await confirmBtn.count().catch(() => 0))) {
      keepOpen = true;
      const shot = await capture(page, accountId, 'video', 'confirm-miss').catch(() => '');
      return { status: 'failed', error: '未出现「Delete post?」确认弹框，视频未删除', via: 'studio-list', screenshot: shot };
    }
    await confirmBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2500);

    // 复核：刷新列表后再按 videoId 滚找，还在则失败
    log('复核：刷新列表并按视频链接确认已消失…');
    await page.goto('https://www.tiktok.com/tiktokstudio/content?lang=en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
    let stillThere = false;
    if (targetId) {
      const recheck = await scrollStudioListFindByVideoId(page, targetId, (m) => log(`[复核] ${m}`));
      stillThere = !!recheck.ok;
    } else if (searchTitle) {
      stillThere = await markStudioContentRow(page, searchTitle, '', { acceptSingleResult: false });
    }

    if (stillThere) {
      keepOpen = true;
      const shot = await capture(page, accountId, 'video', 'still-present').catch(() => '');
      return {
        status: 'failed',
        error: `已点删除确认，但 Studio 列表仍能匹配到${targetId ? ` /video/${targetId}` : `「${firstLine}」`}。请手动检查是否有二次确认/权限限制后重试`,
        via: 'studio-verify-failed',
        screenshot: shot,
      };
    }

    const shot = await capture(page, accountId, 'video', 'deleted').catch(() => '');
    if (targetId || videoUrl) {
      await phpApi.post(`/node/accounts/${accountId}/tiktok-videos/delete`, { videoId: targetId, videoUrl }).catch(() => {});
    }
    log(`删除成功并已复核：${matchedTerm}`);
    return {
      status: 'ok',
      videoId: targetId,
      videoUrl,
      title: matchedTerm || firstLine,
      via: findVia || 'studio-scroll-delete',
      screenshot: shot,
      verifiedGone: true,
    };
  } finally {
    if (!keepOpen) await closeConnection(connection);
  }
}

async function batchDeleteTikTokVideos(accountIds, options = {}) {
  const keepLatest = Math.max(0, Number(options.keepLatest) || 0);
  const threads = Math.min(3, Math.max(1, Number(options.threads) || 1));
  const jobs = [];
  for (const accountId of accountIds) {
    let videos = [];
    try {
      videos = await phpApi.get(`/accounts/${accountId}/tiktok-videos`) || [];
    } catch {
      videos = [];
    }
    if (!Array.isArray(videos)) videos = [];
    const remove = videos.slice(keepLatest);
    for (const video of remove) {
      jobs.push({ accountId, video });
    }
  }
  if (!jobs.length) return { items: [], success: 0, failed: 0, deleted: 0 };

  const items = await runPool(jobs, threads, async (job) => {
    try {
      const result = await deleteTikTokVideo(job.accountId, {
        videoId: job.video.video_id || job.video.videoId,
        videoUrl: job.video.video_url || job.video.videoUrl,
        description: job.video.description || '',
        // 批量删也只按发布描述/标题搜，绝不用 video_id
        publishTitle: String(job.video.description || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '',
        searchTitle: String(job.video.description || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '',
      });
      return { accountId: job.accountId, videoId: job.video.video_id || job.video.videoId, ok: result.status === 'ok', ...result };
    } catch (error) {
      return { accountId: job.accountId, videoId: job.video.video_id || job.video.videoId, ok: false, status: 'failed', error: error.message };
    }
  });
  return {
    items,
    success: items.filter((x) => x.ok).length,
    failed: items.filter((x) => !x.ok).length,
    deleted: items.filter((x) => x.ok).length,
  };
}

/**
 * 仅做「登录态检测」：在已经打开的环境上接 CDP，不重新拉起窗口。
 * 用真实页面的右上角（Log in 按钮 / 头像）判断，避免只凭残留 Cookie 误判为已登录。
 */
async function inspectOpenedSession(ws, options = {}) {
  if (!ws) throw new Error('缺少 CDP 地址，无法检测登录态');
  const opened = typeof ws === 'object' && ws
    ? ws
    : { ws: String(ws), http: String(ws).replace(/^ws:/i, 'http:').replace(/\/devtools\/.*$/i, '') };
  const browser = await connectPlaywrightOverCDP(opened, {
    timeoutMs: options.timeout || 45000,
    retries: 2,
    settleMs: 400,
  });
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    let page = await waitForPlaywrightPage(browser, { preferUrl: /tiktok\.com/i })
      || context.pages().find((p) => /tiktok\.com/i.test(p.url() || ''))
      || context.pages()[0]
      || await context.newPage();
    if (!/tiktok\.com/i.test(page.url() || '')) {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(options.settleMs ?? 2500);
    }
    const cdpWs = opened.ws || String(ws);
    return await inspectTikTokSession(cdpWs, page);
  } finally {
    // CDP 连接上的 close() 只断开连接，不会关掉用户窗口
    await browser.close().catch(() => {});
  }
}

module.exports = {
  connectAccount,
  inspectOpenedSession,
  ensureSessionLoggedIn,
  preparePublish,
  resumePublish,
  prepareMessage,
  sendBitMessageBatch,
  closeConnection,
  forceCloseBrowserProfile,
  classify,
  modifyTikTokProfile,
  batchModifyTikTokProfiles,
  deleteTikTokVideo,
  batchDeleteTikTokVideos,
  markMaterialPublishedCallback,
  fillPublishHashtagsViaSuggest,
  fillPublishCaptionWithHashtags,
};

