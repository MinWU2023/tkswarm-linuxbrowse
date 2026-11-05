const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { generateTotp } = require('../totp');
const {
  getProvider,
  getProviderAsync,
  resolveAccountBrowser,
  resolveEffectiveBackend,
  profileIdCandidatesForBackend,
  labelFor,
  protocolBackendId,
} = require('./providers');
const { inspectTikTokSession, pageLooksLoggedOut } = require('./cdp-client');
const { connectPlaywrightOverCDP, ensurePlaywrightPage } = require('./cdp-connect');
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { publish: liveLog } = require('../live-log');
const { isHeadless } = require('./headless');
const { isMissingBrowserProfileError } = require('./proxy-sync');

const sessions = new Map();
/** @type {Map<string, number>} accountId -> lock startedAt */
const activeLogins = new Map();
// 含打开环境 / 代理冷启动 / 填表提交；过短会在页面仍加载时误报超时
// 每次 goto 后统一多等约 20 秒让页面完整加载（见 cdp-connect.js），总超时相应放宽
const LOGIN_LOCK_TTL_MS = 360_000;
const screenshotDir = path.resolve(__dirname, '../../data/automation');
fs.mkdirSync(screenshotDir, { recursive: true });

/**
 * 一键登录封装：填账号密码 → 自动点 Log in → 填 2FA 并确认 → 校验会话。
 * 前台只需点一次「登录」。
 */
async function fullLogin(accountId, options = {}) {
  return loginAssist(accountId, {
    autoSubmit: true,
    submitAfterTotp: true,
    ...options,
  });
}

/**
 * 按实际登录结果回调 PHP，同步账号 login_status：成功→online，失败→offline
 * options.skipEnvPackPush：总任务复用窗口时禁止关窗推包（否则会杀掉 CDP、并把空包盖掉中心库）
 */
async function callbackLoginStatus(accountId, result, options = {}) {
  const ok = Boolean(result?.loginOk || result?.alreadyLoggedIn);
  const status = ok ? 'online' : 'offline';
  const skipPush = Boolean(options.skipEnvPackPush || result?.skipEnvPackPush);
  try {
    await dataStore.updateLoginStatus(accountId, status);
    if (!ok) {
      await dataStore.clearSession(accountId).catch(() => {});
    }
    liveLog(`账号 #${accountId}：登录状态已回调为 ${status === 'online' ? '已登录' : '未登录'}`, ok ? 'info' : 'warn', { accountId });
  } catch (error) {
    liveLog(`账号 #${accountId}：登录状态回调失败：${error.message || error}`, 'error', { accountId });
  }
  let pid = String(result?.profileId || result?.browserProfileId || '').trim();
  if (!pid) {
    try {
      const b = await dataStore.getAccountBundle(accountId);
      pid = String(
        b?.tkswarm_browser_profile_id
        || b?.linux_browser_profile_id
        || b?.browser_profile_id
        || '',
      ).trim();
    } catch { /* ignore */ }
  }
  // 任意登录成功：先上传环境包+凭证，再解除占用并通知 FIFO 等待方
  if (pid && !skipPush) {
    // 账号列表独立登录：推包但保持窗口开着；上传成功后中心库会 signal 等待队列
    await pushEnvPackBestEffort(accountId, pid, { keepOpen: true });
  } else if (pid && skipPush) {
    liveLog(
      `账号 #${accountId}：同窗登录中，跳过立即上传（总任务结束时统一推包并通知等待方）`,
      'info',
      { accountId },
    );
  } else if (pid && !ok) {
    // 登录失败也释放占用，避免锁死等待方
    try {
      const { releasePackLeaseBestEffort } = require('./env-pack-sync');
      await releasePackLeaseBestEffort(pid);
    } catch { /* ignore */ }
  }
  return { ...(result || {}), loginStatus: status, loginOk: ok, profileId: pid || undefined, skipEnvPackPush: skipPush };
}

/**
 * 推环境包前尽量优雅刷盘 Cookie。
 * 注意：绝不要 goto about:blank——自研客户端会把空白页判成「环境窗口没能正常打开页面」。
 * keepOpen=true：不断开 CDP、不关窗（账号列表登录后需保持开着）。
 */
async function flushBrowserBeforePack(profileId, { keepOpen = false } = {}) {
  const pid = String(profileId || '').trim();
  if (!pid) return;
  const session = sessions.get(pid);
  if (!session?.browser) return;
  try {
    const page = session.page;
    if (page && !page.isClosed?.()) {
      await page.evaluate(() => {
        try { document.cookie; } catch { /* ignore */ }
      }).catch(() => {});
      // 停留当前业务页刷写，勿跳 blank
      await new Promise((r) => setTimeout(r, keepOpen ? 800 : 400));
    }
  } catch { /* ignore */ }
  if (keepOpen) return;
  sessions.delete(pid);
  try {
    session.browser.removeAllListeners?.('disconnected');
  } catch { /* ignore */ }
  await session.browser.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
}

/** 登录后若被误导航到 blank/错误页，拉回 TikTok 主站 */
async function ensureLoginLandingPage(profileId, accountId = 0) {
  const pid = String(profileId || '').trim();
  if (!pid) return;
  const session = sessions.get(pid);
  const page = session?.page;
  if (!page || page.isClosed?.()) return;
  let url = '';
  try { url = String(page.url() || ''); } catch { /* ignore */ }
  if (/tiktok\.com/i.test(url) && !/chrome-error:|about:blank/i.test(url)) return;
  liveLog(
    `账号 #${accountId || '-'}：登录后页面异常（${url || '空'}），正在恢复打开 TikTok…`,
    'warn',
    { accountId },
  );
  await page.goto('https://www.tiktok.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  }).catch(() => {});
}

async function pushEnvPackBestEffort(accountId, profileId, options = {}) {
  const pid = String(profileId || '').trim();
  if (!pid) return;
  const keepOpen = options.keepOpen === true;
  try {
    const { pushLocalEnvPack, releasePackLeaseBestEffort } = require('./env-pack-sync');
    const { getProvider } = require('./providers');

    // 登录成功：窗口保持打开 → 刷盘 → 在线(live)导出环境包 → 上传服务器 → 解除占用
    // （pushLocalEnvPack 的 finally 释放，中心库随后通过 WSS 中继只推给 FIFO 队首）。
    if (keepOpen) {
      const prov = sessions.get(pid)?.provider || getProvider();
      await flushBrowserBeforePack(pid, { keepOpen: true });
      const { getLastReleaseSignal } = require('./env-pack-sync');
      const pushed = await pushLocalEnvPack(pid, {
        accountId: Number(accountId) || 0,
        provider: prov,
        skipClose: true,
        live: true,
      });
      if (!pushed?.pushed) await releasePackLeaseBestEffort(pid);
      const waiting = String(getLastReleaseSignal(pid)?.nextHostId || '').trim();
      await ensureLoginLandingPage(pid, accountId);
      try {
        const { publishEvent } = require('../live-log');
        publishEvent('pack-lease-released', {
          accountId: Number(accountId) || 0,
          profileId: pid,
          pushed: !!pushed?.pushed,
          keepOpen: true,
          live: true,
          nextHostId: waiting || undefined,
        });
      } catch { /* ignore */ }
      liveLog(
        `账号 #${accountId}：登录成功，窗口保持打开；环境包${pushed?.pushed ? '已在线上传服务器' : '上传失败'}并已解除占用`
        + (waiting ? `，已通过 WSS 通知队首等待方 ${waiting}` : ''),
        pushed?.pushed ? 'info' : 'warn',
        { accountId },
      );
      return;
    }

    await flushBrowserBeforePack(pid, { keepOpen: false });
    const { keepOpen: _keep, skipClose: skipCloseOpt, ...rest } = options;
    const pushed = await pushLocalEnvPack(pid, {
      accountId: Number(accountId) || 0,
      provider: getProvider(),
      ...rest,
      skipClose: skipCloseOpt === true,
    });
    await releasePackLeaseBestEffort(pid);
    try {
      const { publishEvent } = require('../live-log');
      publishEvent('pack-lease-released', {
        accountId: Number(accountId) || 0,
        profileId: pid,
        pushed: !!pushed?.pushed,
        keepOpen: false,
      });
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

async function finalizeAfterLogin(accountId, sessionWs, base = {}, page = null, context = null) {
  const skipPush = Boolean(base.skipEnvPackPush);
  const profileHint = String(base.profileId || base.browserProfileId || '').trim();
  if (base.alreadyLoggedIn || base.loginOk) {
    if (page && await pageLooksLoggedOut(page)) {
      return { ...base, alreadyLoggedIn: false, loginOk: false, message: '页面仍显示登录入口，未确认登录' };
    }
    if (context) await persistAccountSessionLog(accountId, context, page, '', profileHint);
    await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
    // 推包统一交给 callbackLoginStatus，避免这里先推一次（空包）再推一次
    return { ...base, loginOk: true, skipEnvPackPush: skipPush };
  }
  if (base.attemptLimited || base.captcha) {
    return { ...base, loginOk: false, skipEnvPackPush: skipPush };
  }
  // 提交 / 2FA 后短暂轮询，确认是否已真正进入登录态
  for (let i = 0; i < 12; i += 1) {
    try {
      const check = await inspectTikTokSession(sessionWs, page);
      if (check?.loggedIn) {
        if (context) await persistAccountSessionLog(accountId, context, page, '', profileHint);
        await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
        return {
          ...base,
          loginOk: true,
          alreadyLoggedIn: true,
          skipEnvPackPush: skipPush,
          message: base.submitted || base.totpFilled
            ? '登录成功（已自动提交并确认会话）'
            : (base.message || '登录成功'),
        };
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (base.submitted || base.totpFilled) {
    return {
      ...base,
      loginOk: false,
      skipEnvPackPush: skipPush,
      message: (base.message || '已提交登录') + '；尚未检测到有效会话，已标记为未登录',
    };
  }
  return { ...base, loginOk: false, skipEnvPackPush: skipPush };
}

function acquireLoginLock(accountId) {
  const lockKey = String(accountId);
  const now = Date.now();
  const startedAt = activeLogins.get(lockKey);
  if (startedAt && (now - startedAt) < LOGIN_LOCK_TTL_MS) {
    const left = Math.max(1, Math.ceil((LOGIN_LOCK_TTL_MS - (now - startedAt)) / 1000));
    throw new Error(`该账号正在执行登录流程，请约 ${left} 秒后再试（勿连点）`);
  }
  activeLogins.set(lockKey, now);
  return lockKey;
}

function releaseLoginLock(lockKey) {
  if (lockKey) activeLogins.delete(lockKey);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

/** 登录提交钮（避免点到禁用的 login-button 卡满 30s） */
async function findLoginSubmitButton(page) {
  const candidates = [
    page.locator('[data-e2e="login-button"]').first(),
    page.locator('button[type="submit"][data-e2e="login-button"]').first(),
    page.getByRole('button', { name: /^(Log in|登录|Sign in)$/i }).first(),
    page.locator('button[type="submit"]').filter({ hasText: /^(Log in|登录|Sign in)$/i }).first(),
    page.locator('button[type="submit"]').first(),
  ];
  for (const loc of candidates) {
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
      return loc;
    }
  }
  return null;
}

/**
 * 填完账号密码后，等提交钮变为 enabled 再点。
 * TikTok 常用 disabled 的 data-e2e="login-button"；直接 click 会默认等 30s 超时。
 */
async function clickLoginSubmitWhenEnabled(page, {
  timeoutMs = 18000,
  accountId = 0,
  username = '',
  password = '',
} = {}) {
  const end = Date.now() + timeoutMs;
  let button = await findLoginSubmitButton(page);
  if (!button) return { clicked: false, reason: '未找到登录按钮' };
  let refillTried = 0;

  // 轻推 React 校验：点一下用户名再失焦密码框，促使 Log in 启用
  const nudgeValidation = async () => {
    const { usernameInput, passwordInput } = await resolveCredentialInputs(page);
    if (usernameInput) await usernameInput.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);
    if (passwordInput) {
      await passwordInput.click({ timeout: 2000 }).catch(() => {});
      await passwordInput.blur().catch(() => {});
    }
  };
  await nudgeValidation();
  await page.waitForTimeout(200);

  while (Date.now() < end) {
    const { usernameInput, passwordInput } = await resolveCredentialInputs(page);
    const u = usernameInput ? await readInputValue(usernameInput) : '';
    const p = passwordInput ? await readInputValue(passwordInput) : '';
    if (!u || !p) {
      if (username && password && refillTried < 2) {
        refillTried += 1;
        liveLog(`账号 #${accountId}：等待点击时输入被清空，自动补填（${refillTried}/2）`, 'warn', { accountId });
        await fillLoginCredentials(page, username, password, { accountId, attempts: 2 });
        await nudgeValidation();
        continue;
      }
      liveLog(`账号 #${accountId}：等待点击时输入框仍空，停止空等`, 'warn', { accountId });
      return { clicked: false, reason: '登录框内容被页面清空，无法点击 Log in' };
    }

    button = (await findLoginSubmitButton(page)) || button;
    const enabled = await button.isEnabled().catch(() => false);
    // aria-disabled / class 禁用（isEnabled 偶发不准）
    const ariaDisabled = String(await button.getAttribute('aria-disabled').catch(() => '') || '').toLowerCase() === 'true';
    const disabledAttr = await button.getAttribute('disabled').catch(() => null);
    const reallyEnabled = enabled && !ariaDisabled && disabledAttr === null;
    if (reallyEnabled) {
      try {
        await button.click({ timeout: 4000 });
        return { clicked: true, reason: '' };
      } catch (e) {
        const msg = String(e.message || e);
        if (/not enabled|disabled|Timeout/i.test(msg)) {
          await page.waitForTimeout(400);
          continue;
        }
        throw e;
      }
    }
    await page.waitForTimeout(350);
  }

  // 仍禁用：不要硬点（Playwright 会卡 30s），返回明确原因
  const stillDisabled = !(await button.isEnabled().catch(() => false));
  liveLog(
    `账号 #${accountId}：登录按钮仍为${stillDisabled ? '禁用' : '不可点'}，跳过自动点击（避免超时）`,
    'warn',
    { accountId }
  );
  return {
    clicked: false,
    reason: stillDisabled
      ? '登录按钮仍为禁用（请确认账号密码已正确填入，或页面有验证码/风控）'
      : '登录按钮不可点击',
  };
}

async function firstVisibleText(page, texts) {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: true }).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function pageBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

/** Chrome/比特网络错误页（如 ERR_SOCKS_CONNECTION_FAILED） */
async function detectBrowserNetworkError(page) {
  if (!page || page.isClosed?.()) return '';
  const url = String(page.url() || '');
  const title = String(await page.title().catch(() => '') || '');
  const body = String(await pageBodyText(page) || '');
  const blob = `${url}\n${title}\n${body}`;
  const m = blob.match(
    /ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_SSL_PROTOCOL_ERROR|ERR_CERT_|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_INTERNET_DISCONNECTED/i
  );
  if (m) return m[0].toUpperCase();
  if (/无法访问此网站|This site can['’]?t be reached|网页可能暂时无法连接|不支持代理协议/i.test(blob)
    && /ERR_|proxy|代理|SOCKS/i.test(blob)) {
    return 'ERR_PROXY_OR_NETWORK';
  }
  return '';
}

function networkErrorMessage(code, proxyHint = '') {
  const c = String(code || '').toUpperCase();
  const proxyPart = proxyHint ? `（当前代理 ${proxyHint}）` : '';
  if (/SOCKS|PROXY|TUNNEL/i.test(c)) {
    return `无法打开 TikTok：代理连接失败 ${c}${proxyPart}。请到账号编辑更换可用代理，或在「代理IP」里检测该代理后再登录`;
  }
  if (/NAME_NOT_RESOLVED/i.test(c)) {
    return `无法打开 TikTok：DNS 解析失败 ${c}${proxyPart}。请检查代理/网络`;
  }
  return `无法打开 TikTok：网络错误 ${c}${proxyPart}。请检查自研浏览器环境代理与本机网络后重试`;
}

async function assertPageNetworkOk(page, { accountId = 0, proxyHint = '' } = {}) {
  const code = await detectBrowserNetworkError(page);
  if (!code) return;
  liveLog(`账号 #${accountId}：检测到浏览器网络错误 ${code}`, 'error', { accountId });
  throw new Error(networkErrorMessage(code, proxyHint));
}

async function safeLoginGoto(page, url, { accountId = 0, proxyHint = '', timeout = 90000 } = {}) {
  const { scaleTimeout, waitPageSettled } = require('./page-ready');
  const navTimeout = scaleTimeout(timeout, 60000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (e) {
    const msg = String(e.message || e);
    const code = (msg.match(/ERR_[A-Z0-9_]+/i) || [])[0]
      || (await detectBrowserNetworkError(page))
      || 'NAVIGATION_FAILED';
    liveLog(`账号 #${accountId}：打开 ${url} 失败：${msg.slice(0, 160)}`, 'error', { accountId });
    throw new Error(networkErrorMessage(code, proxyHint));
  }
  await waitPageSettled(page, {
    timeoutMs: 30000,
    contentSelectors: ['input', 'button', '[data-e2e]', 'form', 'main'],
    reloadOnce: true,
    label: '登录页加载',
    log: (m) => liveLog(`账号 #${accountId}：${m}`, 'info', { accountId }),
  });
  await assertPageNetworkOk(page, { accountId, proxyHint });
}

/**
 * TikTok's real rate-limit banner is very specific.
 * Do NOT match bare "Try again later" / "稍后再试" — those appear on many
 * unrelated TikTok strings and caused false "Maximum attempts" reports across all accounts.
 */
async function findAttemptLimitMessage(page) {
  const exact = page.getByText(/Maximum number of attempts reached/i).first();
  if (await exact.count() && await exact.isVisible().catch(() => false)) {
    return 'Maximum number of attempts reached';
  }
  const zh = page.getByText(/尝试次数过多|登录尝试次数已达上限|尝试次数已达上限/i).first();
  if (await zh.count() && await zh.isVisible().catch(() => false)) {
    return String(await zh.innerText().catch(() => '尝试次数过多')).trim() || '尝试次数过多';
  }
  const body = await pageBodyText(page);
  if (/Maximum number of attempts reached/i.test(body)) return 'Maximum number of attempts reached';
  if (/尝试次数过多|登录尝试次数已达上限|尝试次数已达上限/i.test(body)) return '尝试次数过多';
  return '';
}

function attemptLimitedResult(account, page, screenshot = '') {
  return {
    accountId: account.id,
    username: account.username,
    filled: false,
    submitted: false,
    captcha: false,
    attemptLimited: true,
    screenshot,
    currentUrl: page.url(),
    pageTitle: '',
    message: 'TikTok 页面显示登录次数已达上限。请关闭该自研浏览器环境后换新代理，或新建浏览器环境再试（不要在同一环境内连点）',
  };
}

async function clearTikTokCookiesOnly(context) {
  const cookies = await context.cookies().catch(() => []);
  const keep = (cookies || []).filter((c) => {
    const domain = String(c.domain || '').toLowerCase().replace(/^\./, '');
    return !domain.includes('tiktok');
  });
  await context.clearCookies().catch(() => {});
  if (keep.length) await context.addCookies(keep).catch(() => {});
  for (const p of context.pages().filter((item) => !item.isClosed() && /tiktok\.com/i.test(item.url()))) {
    await p.evaluate(() => {
      try { localStorage.clear(); } catch { /* ignore */ }
      try { sessionStorage.clear(); } catch { /* ignore */ }
    }).catch(() => {});
  }
}

async function readInputValue(locator) {
  return String(await locator.inputValue().catch(() => '') || '');
}

/** React 受控输入：必须清 _valueTracker，否则 UI 看起来没填上、Log in 一直 disabled */
async function setReactInputValue(locator, value) {
  return locator.evaluate((el, v) => {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      try { tracker.setValue(el.value === v ? `${v}\u200b` : el.value); } catch { /* ignore */ }
    }
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return el.value === v;
  }, value).catch(() => false);
}

async function fillAndVerify(locator, value) {
  const expected = String(value ?? '');
  if (!expected) return false;
  // Skip rewrite when already correct — repeated fills can trip TikTok's attempt limit.
  if ((await readInputValue(locator)) === expected) return true;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});

  const page = locator.page();

  // 1) 逐字输入（最稳，能触发 TikTok/React 校验并点亮 Log in）
  await locator.press('ControlOrMeta+A').catch(() => {});
  await locator.press('Backspace').catch(() => {});
  const { typeDelay } = require('../human-pace');
  const keyDelay = typeDelay(80, 160);
  await locator.pressSequentially(expected, { delay: keyDelay }).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
  if ((await readInputValue(locator)) === expected) return true;

  // 2) Playwright fill
  await locator.fill('').catch(() => {});
  await locator.fill(expected).catch(() => {});
  await page.waitForTimeout(350).catch(() => {});
  if ((await readInputValue(locator)) === expected) return true;

  // 3) 原生 setter + React _valueTracker
  if (await setReactInputValue(locator, expected)) {
    await page.waitForTimeout(350).catch(() => {});
    if ((await readInputValue(locator)) === expected) return true;
  }

  // 4) keyboard.type（部分比特环境 pressSequentially 不生效）
  await locator.click({ timeout: 3000 }).catch(() => {});
  await locator.press('ControlOrMeta+A').catch(() => {});
  await locator.press('Backspace').catch(() => {});
  await page.keyboard.type(expected, { delay: keyDelay }).catch(() => {});
  await page.waitForTimeout(500).catch(() => {});
  return (await readInputValue(locator)) === expected;
}

/** 定位邮箱/用户名 + 密码框（优先 placeholder / autocomplete，避免误填隐藏 input） */
async function resolveCredentialInputs(page) {
  const userCandidates = [
    page.getByPlaceholder(/Email or username|email or username|Phone|手机|邮箱|用户名/i).first(),
    page.locator('input[name="username"]').first(),
    page.locator('input[autocomplete="username"]').first(),
    page.locator('input[placeholder*="Email or username"]').first(),
    page.locator('input[placeholder*="email or username"]').first(),
    page.locator('input[placeholder*="Username"]').first(),
    page.locator('input[placeholder*="username"]').first(),
    page.locator('input[placeholder*="Email"]').first(),
    page.locator('input[placeholder*="邮箱"]').first(),
    page.locator('input[placeholder*="用户名"]').first(),
  ];
  const passCandidates = [
    page.locator('input[type="password"]').first(),
    page.locator('input[autocomplete="current-password"]').first(),
    page.getByPlaceholder(/^Password$|密码/i).first(),
  ];

  let usernameInput = null;
  for (const loc of userCandidates) {
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false) && await loc.isEditable().catch(() => true)) {
      usernameInput = loc;
      break;
    }
  }
  let passwordInput = null;
  for (const loc of passCandidates) {
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false) && await loc.isEditable().catch(() => true)) {
      passwordInput = loc;
      break;
    }
  }

  // 仍缺用户名：在含密码的 form 内找第一个可见文本框
  if (!usernameInput && passwordInput) {
    const form = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
    const scope = (await form.count().catch(() => 0)) ? form : page;
    const fallback = await firstVisible(scope, ['input[type="text"]', 'input:not([type])']);
    if (fallback && await fallback.isEditable().catch(() => true)) usernameInput = fallback;
  }
  return { usernameInput, passwordInput };
}

/** 填账号密码并确认值仍留在 DOM（防止 React 重渲染清空后误以为已填） */
async function fillLoginCredentials(page, username, password, { accountId = 0, attempts = 3 } = {}) {
  const user = String(username || '').replace(/^@+/, '').trim();
  const pass = String(password || '');
  if (!user || !pass) return { ok: false, usernameFilled: false, passwordFilled: false, message: '账号或密码为空' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { usernameInput, passwordInput } = await resolveCredentialInputs(page);
    if (!usernameInput || !passwordInput) {
      liveLog(`账号 #${accountId}：第 ${attempt}/${attempts} 次未找到登录输入框`, 'warn', { accountId });
      await page.waitForTimeout(600);
      continue;
    }
    liveLog(`账号 #${accountId}：填写登录表（第 ${attempt}/${attempts} 次）用户名 ${user}`, 'info', { accountId });
    const usernameFilled = await fillAndVerify(usernameInput, user);
    const passwordFilled = await fillAndVerify(passwordInput, pass);

    // 失焦触发校验，给 React 一点时间；再读一次确认没有被清空
    await passwordInput.blur().catch(() => {});
    await page.waitForTimeout(350);
    const userNow = await readInputValue(usernameInput);
    const passNow = await readInputValue(passwordInput);
    const userOk = userNow === user;
    const passOk = passNow === pass;
    liveLog(
      `账号 #${accountId}：填表校验 用户名=${userOk ? 'OK' : `空/错(${userNow.length}字)`} 密码=${passOk ? 'OK' : `空/错(${passNow.length}字)`}`,
      userOk && passOk ? 'info' : 'warn',
      { accountId }
    );
    if (userOk && passOk) {
      return { ok: true, usernameFilled: true, passwordFilled: true, message: '' };
    }
    // 被清空则再点一下输入框重试
    await usernameInput.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  return {
    ok: false,
    usernameFilled: false,
    passwordFilled: false,
    message: 'TikTok 登录框未保持填写（页面可能拦截了自动输入）。请在自研浏览器窗口手动输入后点 Log in，或关闭环境后重试',
  };
}

async function fillTotpCode(page, selectors, code) {
  // Prefer the labeled 6-digit field TikTok shows on 2-step verification.
  const preferred = page.getByPlaceholder(/Enter 6-digit code|6-digit code|验证码/i).first();
  if (await preferred.count() && await preferred.isVisible().catch(() => false)) {
    if (await fillAndVerify(preferred, code)) return true;
  }
  const candidates = page.locator(selectors.join(', '));
  const visible = [];
  for (let i = 0; i < await candidates.count(); i += 1) {
    const item = candidates.nth(i);
    if (await item.isVisible().catch(() => false)) visible.push(item);
  }
  if (!visible.length) return false;
  if (visible.length === 1) return fillAndVerify(visible[0], code);
  // Some TikTok versions render six separate one-character inputs.
  const boxes = visible.slice(0, 6);
  if (boxes.length >= 6) {
    for (let i = 0; i < 6; i += 1) await fillAndVerify(boxes[i], code[i]);
    await page.waitForTimeout(350);
    const values = await Promise.all(boxes.map(item => item.inputValue().catch(() => '')));
    return values.join('') === code;
  }
  return fillAndVerify(visible[0], code);
}

const TOTP_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[placeholder="Enter 6-digit code"]',
  'input[placeholder*="6-digit"]',
  'input[placeholder*="6 digit"]',
  'input[placeholder*="code"]',
  'input[placeholder*="Code"]',
  'input[placeholder*="验证码"]',
  'input[name*="code"]',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
];

async function isTwoStepVerificationPage(page) {
  if (/\/login\/2sv\//i.test(page.url())) return true;
  const codeInput = await firstVisible(page, TOTP_INPUT_SELECTORS);
  if (!codeInput) return false;
  // Password page must not be mistaken for 2SV.
  if (await firstVisible(page, ['input[type="password"]', 'input[autocomplete="current-password"]'])) return false;
  const text = await pageBodyText(page);
  return /2-step verification|authenticator app|Enter 6-digit code|两步验证|身份验证器|验证器应用/i.test(text);
}

async function fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run) {
  if (!totpSecret) throw new Error('账号没有已保存的 2FA 密钥，请在「密码/2FA」里补填或重新导入带 2FA 的账号');
  const totpInputSelectors = [...TOTP_INPUT_SELECTORS, 'input[type="text"]', 'input:not([type])'];
  let hasTotpInput = await firstVisible(page, totpInputSelectors);
  for (let i = 0; !hasTotpInput && i < 10; i += 1) {
    assertNotCancelled(run);
    await page.waitForTimeout(400);
    hasTotpInput = await firstVisible(page, totpInputSelectors);
  }
  if (!hasTotpInput) throw new Error('当前处于 TikTok 2-step 页面，但未找到 2FA 输入框');
  let token = generateTotp(totpSecret);
  if (token.validForSeconds <= 8) {
    await page.waitForTimeout((token.validForSeconds + 1) * 1000);
    token = generateTotp(totpSecret);
  }
  assertNotCancelled(run);
  liveLog(`账号 #${account.id}：正在填入 2FA 验证码`,'info',{accountId: account.id});
  const codeVisible = await fillTotpCode(page, totpInputSelectors, token.code);
  if (!codeVisible) throw new Error('已生成 2FA 验证码，但 TikTok 输入框未保持填写状态');
  const preparedScreenshot = path.join(screenshotDir, `login-${account.id}-${Date.now()}-2sv-prepared.png`);
  await page.screenshot({ path: preparedScreenshot, fullPage: false }).catch(() => {});
  let nextClicked = false;
  if (submitAfterTotp) {
    const next = await firstVisible(page, [
      'button[type="submit"]:not([disabled])',
      'button:has-text("Next")',
      'button:has-text("下一步")',
      'button:has-text("Verify")',
      'button:has-text("验证")',
    ]);
    if (next && await next.isEnabled().catch(() => false)) {
      await next.click({ timeout: 5000 }).catch(() => {});
      nextClicked = true;
      await page.waitForTimeout(2500);
    }
  }
  return {
    accountId: account.id, username: account.username, filled: true, submitted: nextClicked,
    twoFactorRequired: true, totpFilled: true, captcha: false, screenshot: preparedScreenshot,
    currentUrl: page.url(), pageTitle: await page.title(),
    message: nextClicked ? '已在 2-step 页面填入并提交验证码' : '已自动填入 2FA 验证码（未点确认）',
  };
}

async function clickSafeLoginMethod(page, pattern) {
  // Prefer links / method tiles. Never click the credential submit button
  // ("Log in" / "登录") — that counts as a real login attempt on TikTok.
  const candidates = [
    page.getByRole('link', { name: pattern }).first(),
    page.locator('a, div[role="link"], div[tabindex="0"], div[role="button"]').filter({ hasText: pattern }).first(),
    page.getByRole('button', { name: pattern }).first(),
    page.getByText(pattern).first(),
  ];
  for (const locator of candidates) {
    if (!await locator.count() || !await locator.isVisible().catch(() => false)) continue;
    const label = String(await locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (/^(Log in|登录|Sign in|Next|下一步|Verify|验证)$/i.test(label)) continue;
    if (/^(Continue|继续)$/i.test(label)) continue;
    // Never pick social / QR providers.
    if (/Google|Facebook|Apple|QR|二维码/i.test(label) && !/phone|email|username|手机|邮箱|用户名/i.test(label)) continue;
    const type = await locator.getAttribute('type').catch(() => '');
    if (String(type).toLowerCase() === 'submit') continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 5000 }).catch(async () => {
      const clickable = locator.locator('xpath=ancestor-or-self::*[self::a or self::button or @role="button" or @role="link" or self::div][1]');
      if (await clickable.count()) {
        const ancestorLabel = String(await clickable.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (/^(Log in|登录|Sign in|Next|下一步)$/i.test(ancestorLabel)) throw new Error('跳过提交按钮');
        await clickable.click({ timeout: 5000 });
      } else throw new Error('登录方式入口不可点击');
    });
    return true;
  }
  return false;
}

async function clickPhoneEmailUsernameEntry(page) {
  const exactTexts = [
    'Use phone or email',
    'Use phone / email',
    'Use phone / email / username',
    'Use phone/email/username',
    '使用手机号或邮箱',
    '使用手机号 / 邮箱',
    '使用手机号 / 邮箱 / 用户名',
    '使用手机号/邮箱/用户名',
    '使用电话 / 邮箱 / 用户名',
  ];
  for (const text of exactTexts) {
    const loc = page.getByText(text, { exact: true }).first();
    if (!await loc.count() || !await loc.isVisible().catch(() => false)) continue;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 5000 }).catch(async () => {
      const clickable = loc.locator('xpath=ancestor-or-self::*[self::a or self::button or @role="button" or @role="link" or self::div][1]');
      if (await clickable.count()) await clickable.click({ timeout: 5000 });
      else throw new Error('无法点击手机/邮箱入口');
    });
    return true;
  }
  // 模糊匹配（含 Last used 角标的那一行）
  const fuzzy = page.locator('div, button, a, span').filter({
    hasText: /Use phone\s*(or|\/)\s*email|使用手机号.*邮箱/i,
  }).first();
  if (await fuzzy.count() && await fuzzy.isVisible().catch(() => false)) {
    await fuzzy.scrollIntoViewIfNeeded().catch(() => {});
    await fuzzy.click({ timeout: 5000 }).catch(async () => {
      const clickable = fuzzy.locator('xpath=ancestor-or-self::*[self::a or self::button or @role="button" or @role="link" or self::div][1]');
      if (await clickable.count()) await clickable.click({ timeout: 5000 });
    });
    return true;
  }
  return clickSafeLoginMethod(page,
    /Use phone\s*(or|\/)\s*email(?:\s*\/\s*username)?|phone\s*\/\s*email|使用.*(?:手机号|电话).*邮箱/i);
}

async function hasCredentialForm(page) {
  const { usernameInput, passwordInput } = await resolveCredentialInputs(page);
  return Boolean(usernameInput && passwordInput);
}

async function isLoginMethodHub(page) {
  if (await hasCredentialForm(page)) return false;
  if (await isTwoStepVerificationPage(page)) return false;
  const text = await pageBodyText(page);
  return /Log in to TikTok|登录到 TikTok|Use phone\s*(or|\/)\s*email|Use phone\s*\/\s*email\s*\/\s*username|使用手机号.*邮箱|Continue with Google|Continue with Facebook|Use QR code|使用二维码/i.test(text);
}

/** 清掉首页「Log in to TikTok」弹层/黑罩，避免 VNC 里以为整页挂了、也挡导航 */
async function dismissLoginOverlay(page) {
  if (!page || page.isClosed?.()) return;
  try {
    const skip = page.getByRole('button', { name: /^Skip$/i })
      .or(page.getByText(/^Skip$/i))
      .or(page.locator('[aria-label="Skip"], button:has-text("Skip")'))
      .first();
    if (await skip.isVisible({ timeout: 1200 }).catch(() => false)) {
      await skip.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    }
  } catch { /* ignore */ }
  await page.evaluate(() => {
    // 保护：绝不动 html/body/根容器，也不动包含主站导航/搜索/头像/视频流的元素（否则整页被删成黑屏）
    const APP_MARKERS = '[data-e2e="nav-profile"], [data-e2e="top-profile-icon"], [data-e2e="profile-icon"], [data-e2e="search-box"], [data-e2e="recommend-list-item-container"], [data-e2e="user-post-item"], main, nav, header, video';
    const kill = (el) => {
      try {
        if (!el || el === document.body || el === document.documentElement) return;
        if (el.id === 'app' || el.id === 'root' || el.id === '__next') return;
        if (el.querySelector(APP_MARKERS)) return;
        const r = el.getBoundingClientRect();
        // 覆盖全屏且子节点很多 = 页面主体，不是弹层
        if (r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95 && el.querySelectorAll('*').length > 120) return;
        // 改为隐藏而非 remove，避免破坏页面框架脚本
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      } catch { /* */ }
    };
    document.querySelectorAll(
      '[data-e2e="modal-close-inner-button"], [class*="DivModalContainer"], [class*="ModalMask"], [class*="modal-mask"]',
    ).forEach(kill);
    for (const el of Array.from(document.querySelectorAll('div, section'))) {
      const t = String(el.innerText || '').slice(0, 80);
      if (/^Log in to TikTok|^登录到 TikTok/i.test(t.trim()) && el.childElementCount < 40) {
        let node = el;
        for (let i = 0; i < 5 && node; i += 1) {
          const style = window.getComputedStyle(node);
          if (style.position === 'fixed' || style.position === 'absolute' || Number(style.zIndex) > 1000) {
            kill(node);
            break;
          }
          node = node.parentElement;
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      try {
        const st = window.getComputedStyle(el);
        if (st.position !== 'fixed') continue;
        const zi = Number(st.zIndex) || 0;
        if (zi < 1000) continue;
        const bg = st.backgroundColor || '';
        const rgba = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
        const alpha = rgba ? Number(rgba[4] ?? 1) : 1;
        const dark = rgba && Number(rgba[1]) < 40 && Number(rgba[2]) < 40 && Number(rgba[3]) < 40;
        if (dark && alpha > 0.2 && alpha < 0.95) kill(el);
      } catch { /* */ }
    }
    try { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } catch { /* */ }
  }).catch(() => {});
}

async function openEmailCredentialForm(page, accountId, proxyHint = '') {
  await assertPageNetworkOk(page, { accountId, proxyHint });
  if (await hasCredentialForm(page)) return true;

  // 首页弹层也带 “Log in to TikTok”，会被当成 hub；必须先清罩再硬跳独立邮箱登录页
  await dismissLoginOverlay(page);
  const alreadyOnEmail = /\/login\/phone-or-email\/email/i.test(String(page.url() || ''));
  if (!alreadyOnEmail) {
    liveLog(`账号 #${accountId}：硬跳邮箱/用户名登录页`, 'info', { accountId });
    await safeLoginGoto(page, 'https://www.tiktok.com/login/phone-or-email/email', { accountId, proxyHint });
    await page.waitForTimeout(1000);
    await dismissLoginOverlay(page);
  }
  if (await hasCredentialForm(page)) return true;

  // Hub page (QR / Google / Apple / phone-email-username)：点「手机/邮箱」
  if (await isLoginMethodHub(page) || /tiktok\.com\/login\/?(?:\?|$)/i.test(page.url())) {
    liveLog(`账号 #${accountId}：点击「手机 / 邮箱 / 用户名」`, 'info', { accountId });
    const clicked = await clickPhoneEmailUsernameEntry(page);
    if (clicked) await page.waitForTimeout(1200);
  }
  await assertPageNetworkOk(page, { accountId, proxyHint });
  if (await hasCredentialForm(page)) return true;

  // Intermediate "phone or email" chooser — pick email/username.
  if (/\/login\/phone-or-email\/?(?:\?|$)/i.test(page.url()) || /Log in with (?:email|username)|email\s*(?:or|\/)\s*username/i.test(await pageBodyText(page))) {
    liveLog(`账号 #${accountId}：点击「用邮箱/用户名登录」`, 'info', { accountId });
    const clicked = await clickSafeLoginMethod(page,
      /Log in with (?:email|username)|email\s*(?:or|\/)\s*username|使用.*(?:邮箱|用户名).*登录/i);
    if (clicked) await page.waitForTimeout(1200);
  }
  if (await hasCredentialForm(page)) return true;

  // Last attempt: deep-link again after the hub click path.
  await dismissLoginOverlay(page);
  await safeLoginGoto(page, 'https://www.tiktok.com/login/phone-or-email/email', { accountId, proxyHint });
  await page.waitForTimeout(1200);
  // 输入框偶发晚挂载
  for (let i = 0; i < 8 && !(await hasCredentialForm(page)); i += 1) {
    await page.waitForTimeout(400);
  }
  return hasCredentialForm(page);
}

async function selectUsernameLogin(page) {
  // Only select TikTok's ordinary credential flow. Never select Google,
  // Facebook, Apple, QR code, or another external authentication provider.
  if (await hasCredentialForm(page)) return true;
  if (await isLoginMethodHub(page) || /tiktok\.com\/login\/?(?:\?|$)/i.test(page.url())) {
    const selected = await clickPhoneEmailUsernameEntry(page);
    if (selected) await page.waitForTimeout(1000);
    return selected;
  }
  if (/\/login\/phone-or-email\/?(?:\?|$)/i.test(page.url())) {
    const selected = await clickSafeLoginMethod(page,
      /Log in with (?:email|username)|email\s*(?:or|\/)\s*username|使用.*(?:邮箱|用户名).*登录/i);
    if (selected) await page.waitForTimeout(1000);
    return selected;
  }
  return false;
}

function assertNotCancelled(run) {
  if (run?.cancelled) throw new Error('登录辅助已取消或超时，已停止操作');
}


function isMissingProfileError(error) {
  return isMissingBrowserProfileError(error);
}

function resolveLoginUsernameFromBundle(bundle) {
  const systemUsername = String(bundle.username || '').replace(/^@+/, '').trim();
  const pendingUsername = String(bundle.username_prev || bundle.usernamePrev || '').replace(/^@+/, '').trim();
  // 有待提交改名时，登录仍用 TikTok 上的原名（pending 存在且与系统名不同）
  const loginUsername = (pendingUsername && systemUsername
    && pendingUsername.toLowerCase() !== systemUsername.toLowerCase())
    ? pendingUsername
    : systemUsername;
  return { loginUsername: loginUsername || systemUsername, systemUsername, pendingUsername };
}

async function promoteProfileBindingIfNeeded(accountId, profileId, backend, previousId) {
  const pid = String(profileId || '').trim();
  if (!pid || !accountId) return;
  if (String(previousId || '').trim() === pid) return;
  try {
    const { persistBrowserBinding } = require('./profile-provision');
    await persistBrowserBinding(accountId, pid, true, backend || 'tkswarm', 0);
  } catch (e) {
    liveLog(`账号 #${accountId}：自动提升环境绑定失败：${e.message || e}`, 'warn', { accountId });
  }
}

async function findLocalProfileForAccount(provider, bundle) {
  const username = String(bundle?.username || '').replace(/^@+/, '').trim().toLowerCase();
  if (!username) return '';
  const prefix = `tk-${username}`;
  try {
    const raw = await provider.profiles(0, 100, '');
    const list = raw?.data?.list || raw?.list || (Array.isArray(raw?.data) ? raw.data : []);
    if (!Array.isArray(list)) return '';
    const matches = list.filter((p) => {
      const name = String(p.name || p.remark || '').toLowerCase();
      return name.startsWith(prefix);
    });
    if (!matches.length) return '';
    const pick = matches[matches.length - 1];
    return String(pick.id || '').trim();
  } catch {
    return '';
  }
}

/**
 * 登录用：解析环境；优先本机已有 / 已打开窗口，避免对失效主绑反复拉包。
 * @param {object} bundle
 * @param {number} accountId
 * @param {{ preferredProfileId?: string, allowHydrate?: boolean }} [opts]
 */
async function resolveLoginBrowser(bundle, accountId, opts = {}) {
  await getProviderAsync().catch(() => {});
  const backend = resolveEffectiveBackend(bundle);
  const candidates = profileIdCandidatesForBackend(bundle, backend);
  if (!candidates.length) {
    return resolveAccountBrowser(bundle);
  }
  await getProviderAsync(backend).catch(() => {});
  const provider = getProvider(protocolBackendId(backend));
  const label = labelFor(backend);
  const preferred = String(opts.preferredProfileId || '').trim();
  const allowHydrate = opts.allowHydrate !== false;
  // 目标环境：已打开窗 > 主绑；绝不因本机另有同账号旧窗就抢先切换
  const targetId = preferred || String(candidates[0] || '').trim();

  const { ensureEnvReady, prepareEnvForOpen } = require('./env-pack-sync');

  const finish = async (profileId, {
    detailAlready = null,
    promote = false,
    previousId = '',
  } = {}) => {
    let detail = detailAlready;
    if (!detail) {
      detail = await provider.detail(profileId).catch(() => null);
    }
    if (!detail) return null;
    try {
      await prepareEnvForOpen(profileId, {
        accountId,
        provider,
        bundle,
        backend,
        autoProvision: false,
      });
    } catch (e) {
      if (/其它主机/i.test(String(e.message || e))) throw e;
    }
    if (promote && previousId && previousId !== profileId) {
      await promoteProfileBindingIfNeeded(accountId, profileId, backend, previousId);
      liveLog(
        `账号 #${accountId}：目标环境不可用，已代建并关联新环境 ${profileId.slice(0, 8)}…（替换 ${previousId.slice(0, 8)}…）`,
        'warn',
        { accountId }
      );
    } else {
      liveLog(
        `账号 #${accountId}：登录使用${label} ${profileId.slice(0, 8)}…`,
        'info',
        { accountId }
      );
    }
    return { provider, profileId, backend, label };
  };

  if (targetId) {
    const local = await provider.detail(targetId).catch(() => null);
    if (local && (local.id || local.name)) {
      const hit = await finish(targetId, { detailAlready: local });
      if (hit) return hit;
    }
    if (allowHydrate) {
      try {
        const prepared = await ensureEnvReady(targetId, {
          accountId,
          provider,
          bundle,
          backend,
          autoProvision: true,
        });
        const readyId = String(prepared?.profileId || targetId).trim();
        const hit = await finish(readyId, {
          promote: Boolean(prepared?.provisioned) && readyId !== targetId,
          previousId: targetId,
        });
        if (hit) return hit;
      } catch (e) {
        if (/其它主机/i.test(String(e.message || e))) throw e;
        liveLog(
          `账号 #${accountId}：目标环境 ${targetId.slice(0, 8)}… 就绪失败：${e.message || e}`,
          'warn',
          { accountId },
        );
      }
    }
  }

  const fallback = resolveAccountBrowser(bundle);
  liveLog(
    `账号 #${accountId}：${fallback.label}目标环境不可用（${targetId ? `${targetId.slice(0, 8)}…` : '无绑定'}），请再绑或创建环境`,
    'error',
    { accountId }
  );
  return fallback;
}

/** 仅丢掉本机 CDP 会话缓存，绝不调用 provider.close（那会真关窗） */
function detachLoginSession(profileId, { reason = '' } = {}) {
  const pid = String(profileId || '');
  if (!pid) return;
  const old = sessions.get(pid);
  sessions.delete(pid);
  if (!old?.browser) return;
  try {
    old.browser.removeAllListeners?.('disconnected');
  } catch { /* ignore */ }
  // 部分自研/比特客户端会把 Playwright browser.close() 当成关窗，登录流程里禁止调用
  if (reason) {
    liveLog(`登录会话已断开 CDP（不关窗）${reason ? `：${reason}` : ''}`, 'info');
  }
}

async function syncProxyToBrowser(bundle, accountId, resolved, syncProxy) {
  let { provider, profileId, label, backend } = resolved;
  const backendId = backend || resolveEffectiveBackend(bundle);
  const candidates = profileIdCandidatesForBackend(bundle, backendId);
  let tryIds = candidates.length
    ? [...candidates]
    : [String(profileId || '').trim()].filter(Boolean);
  const localHit = await findLocalProfileForAccount(provider, bundle);
  if (localHit && !tryIds.includes(localHit)) tryIds.unshift(localHit);

  for (let i = 0; i < tryIds.length; i += 1) {
    const pid = tryIds[i];
    if (!pid) continue;
    if (i > 0) {
      await getProviderAsync(backendId).catch(() => {});
      provider = getProvider(protocolBackendId(backendId));
      label = labelFor(backendId);
      profileId = pid;
    }
    // 只断 CDP，不 provider.close：否则一点「登录」就会先把已开窗口关掉，后续 open 失败就彻底没了
    detachLoginSession(profileId, { reason: '同步代理前' });
    try {
      await provider.updateProxy(profileId, syncProxy);
      if (i > 0) {
        await promoteProfileBindingIfNeeded(accountId, pid, backendId, tryIds[0] || '');
        liveLog(
          `账号 #${accountId}：${label}环境已切换到 ${pid.slice(0, 8)}…`,
          'warn',
          { accountId }
        );
      }
      liveLog(`账号 #${accountId}：${label}环境代理已同步`, 'info', { accountId });
      return { provider, profileId, label, backend: backendId };
    } catch (e) {
      if (isMissingProfileError(e) && i < tryIds.length - 1) continue;
      if (isMissingProfileError(e)) {
        const { ensureAccountProxySynced } = require('./proxy-sync');
        const healed = await ensureAccountProxySynced(bundle, {
          profileId,
          provider,
          accountId,
          backend: backendId,
        });
        return {
          provider: healed.provider,
          profileId: healed.profileId,
          label: healed.provider?.backendLabel || label,
          backend: healed.backend || backendId,
        };
      }
      throw new Error(
        `无法把代理写入${label}环境：${e.message || e}。请在账号里「再绑环境」或「创建环境」后重试`
      );
    }
  }
  const { ensureAccountProxySynced } = require('./proxy-sync');
  const healed = await ensureAccountProxySynced(bundle, { profileId, provider, accountId, backend: backendId });
  return {
    provider: healed.provider,
    profileId: healed.profileId,
    label: healed.provider?.backendLabel || label,
    backend: healed.backend || backendId,
  };
}

function cookieHeaderFromPlaywrightCookies(cookies) {
  return (cookies || [])
    .filter((c) => {
      const domain = String(c.domain || '').toLowerCase().replace(/^\./, '');
      return domain.includes('tiktok');
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 中心库 PUT /session 的 LocalStorage 上限约 2MB；超出则裁剪，Cookie 仍可单独保存 */
const SESSION_STORAGE_MAX_BYTES = 1_800_000;
const SESSION_STORAGE_VALUE_MAX = 32_000;

/**
 * 裁剪 localStorage JSON：丢掉超大单项，按 key 长度优先保留，总长压到上限内。
 * 登录恢复主要靠 Cookie；Storage 过大时宁可省略也不要 422。
 */
function trimStorageJson(rawJson, maxBytes = SESSION_STORAGE_MAX_BYTES) {
  const raw = String(rawJson || '');
  if (!raw || raw.length <= maxBytes) return raw;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { return ''; }
  if (!obj || typeof obj !== 'object') return '';
  const entries = Object.entries(obj)
    .filter(([k, v]) => {
      if (k == null) return false;
      const s = v == null ? '' : String(v);
      return s.length <= SESSION_STORAGE_VALUE_MAX;
    })
    .sort((a, b) => String(a[0]).length - String(b[0]).length || String(a[1]).length - String(b[1]).length);
  const out = {};
  let packed = '{}';
  for (const [k, v] of entries) {
    out[k] = v == null ? '' : String(v);
    const next = JSON.stringify(out);
    if (next.length > maxBytes) {
      delete out[k];
      break;
    }
    packed = next;
  }
  return packed === '{}' ? '' : packed;
}

async function collectStorageSnapshot(page) {
  if (!page || page.isClosed()) return '';
  try {
    const raw = await page.evaluate(() => {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k != null) out[k] = localStorage.getItem(k);
        }
      } catch { /* ignore */ }
      return out;
    });
    return trimStorageJson(JSON.stringify(raw || {}));
  } catch {
    return '';
  }
}

async function persistAccountSessionLog(accountId, context, page, fingerprint = '', profileIdHint = '') {
  try {
    const cookies = await context.cookies().catch(() => []);
    const cookie = cookieHeaderFromPlaywrightCookies(cookies);
    if (!cookie || !/sessionid|sid_tt/i.test(cookie)) return false;
    let storage = await collectStorageSnapshot(page);
    try {
      await dataStore.saveSession(accountId, { cookie, storage, fingerprint: fingerprint || '' });
    } catch (e) {
      // 仍可能被网关/旧 API 拒：降级只存 Cookie
      if (/LocalStorage|过大|422|413|payload|entity too large/i.test(String(e.message || e))) {
        storage = '';
        await dataStore.saveSession(accountId, { cookie, storage: '', fingerprint: fingerprint || '' });
        liveLog(
          `账号 #${accountId}：LocalStorage 过大，已仅保存 Cookie（登录态仍有效）`,
          'warn',
          { accountId }
        );
        return true;
      }
      throw e;
    }
    liveLog(
      storage
        ? `账号 #${accountId}：已写入最新登录会话日志（Cookie+Storage）`
        : `账号 #${accountId}：已写入最新登录会话日志（仅 Cookie）`,
      'info',
      { accountId }
    );
    // 占用释放改到「环境包上传成功」之后，由中心库 FIFO 推送唤醒等待方
    void profileIdHint;
    return true;
  } catch (e) {
    liveLog(`账号 #${accountId}：保存会话日志失败：${e.message || e}`, 'warn', { accountId });
    return false;
  }
}

async function applySavedSessionToContext(context, page, saved) {
  const cookieText = String(saved?.cookie || '').trim();
  if (!cookieText) return false;
  const parts = cookieText.split(';').map((s) => s.trim()).filter(Boolean);
  const cookies = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: '.tiktok.com',
      path: '/',
      httpOnly: /sessionid|sid_tt|tt_chain_token|ttwid/i.test(name),
      secure: true,
      sameSite: 'None',
    });
  }
  if (!cookies.length) return false;
  await context.addCookies(cookies).catch(() => {});
  const storageRaw = String(saved?.storage || '').trim();
  if (storageRaw && page && !page.isClosed()) {
    try {
      const obj = JSON.parse(storageRaw);
      if (obj && typeof obj === 'object') {
        await page.evaluate((data) => {
          try {
            for (const [k, v] of Object.entries(data || {})) {
              if (v == null) continue;
              localStorage.setItem(String(k), String(v));
            }
          } catch { /* ignore */ }
        }, obj).catch(() => {});
      }
    } catch { /* ignore bad storage json */ }
  }
  return true;
}

/**
 * 存在会话日志则注入 Cookie/Storage 并校验；成功则免表单登录。
 * @returns {Promise<object|null>} 已登录结果，或 null 继续走表单
 */
async function tryFormFreeLogin(accountId, account, session, page, run) {
  let saved = null;
  try {
    saved = await dataStore.getSession(accountId);
  } catch (e) {
    liveLog(`账号 #${accountId}：读取会话日志失败：${e.message || e}`, 'warn', { accountId });
    return null;
  }
  if (!saved?.cookie) {
    liveLog(`账号 #${accountId}：无会话日志，走表单登录`, 'info', { accountId });
    return null;
  }
  liveLog(`账号 #${accountId}：检测到会话日志，尝试免表单登录`, 'info', { accountId });
  assertNotCancelled(run);
  await applySavedSessionToContext(session.context, page, saved);
  await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const check = await inspectTikTokSession(session.ws, page);
  assertNotCancelled(run);
  if (check?.loggedIn && !(await pageLooksLoggedOut(page))) {
    await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
    await persistAccountSessionLog(
      accountId,
      session.context,
      page,
      saved.fingerprint || '',
      session.profileId || '',
    );
    return {
      accountId,
      username: account.username,
      filled: false,
      submitted: false,
      twoFactorRequired: false,
      totpFilled: false,
      captcha: false,
      alreadyLoggedIn: true,
      loginOk: true,
      formFree: true,
      screenshot: '',
      currentUrl: page.url(),
      pageTitle: await page.title().catch(() => ''),
      message: '已使用会话日志免表单登录',
    };
  }
  liveLog(`账号 #${accountId}：会话日志失效，清除后走表单登录`, 'warn', { accountId });
  await dataStore.clearSession(accountId).catch(() => {});
  await clearTikTokCookiesOnly(session.context);
  return null;
}


async function getSession(profileId, provider, {
  forceOpen = false,
  forceVisible = false,
  forceRelaunch = true,
  connection = null,
} = {}) {
  // 总任务已打开的 CDP：直接复用，禁止关窗重开
  if (connection?.browser?.isConnected?.() && connection?.page && !connection.page.isClosed?.()) {
    const session = {
      browser: connection.browser,
      context: connection.context || connection.browser.contexts?.()?.[0],
      page: connection.page,
      profileId,
      ws: connection.ws,
      opened: { ws: connection.ws },
      provider: connection.provider || provider,
      reused: true,
    };
    sessions.set(profileId, session);
    return session;
  }
  const existing = sessions.get(profileId);
  if (!forceOpen && existing && existing.browser.isConnected() && !existing.page.isClosed()) {
    return existing;
  }
  if (existing) {
    // 勿 browser.close()：自研客户端可能把 CDP close 当成关窗，表现为「一点登录窗口就没了」
    detachLoginSession(profileId, { reason: '重新打开前' });
  }
  const headless = forceVisible ? false : isHeadless('login');
  const label = provider?.backendLabel || '本地浏览器';
  // 登录默认尽量复用已开窗口；仅显式 forceRelaunch 才关开一次（代理变更后由调用方决定）
  const relaunch = forceRelaunch === true;
  liveLog(
    `${relaunch ? '重开' : '打开/复用'}${label}环境 ${String(profileId).slice(0, 8)}…（${headless ? '无头' : '可见'}）`,
    'info',
  );
  let opened;
  try {
    opened = await provider.open(profileId, { headless, forceRelaunch: relaunch });
  } catch (e) {
    // 首次无 relaunch 失败时再强制拉起一次，避免残留半开状态
    if (!relaunch) {
      liveLog(`${label}环境复用失败，改为强制重开：${e.message || e}`, 'warn');
      opened = await provider.open(profileId, { headless, forceRelaunch: true });
    } else {
      throw e;
    }
  }
  if (!opened?.ws && !opened?.http) throw new Error(`${label}未返回 CDP 地址`);
  const browser = await connectPlaywrightOverCDP(opened, { timeoutMs: 60000 });
  // Electron 不支持 CDP newPage：复用窗口已有页
  const page = await ensurePlaywrightPage(browser, {
    preferUrl: /tiktok\.com/i,
    allowNewPage: !/linux|第一页自研浏览器 Linux/i.test(label),
    httpBase: opened?.http || opened?.httpUrl || '',
  });
  const context = page.context?.() || browser.contexts()[0];
  try {
    const { attachAutoRotateCaptchaWatcher } = require('./nocaptchaai');
    attachAutoRotateCaptchaWatcher(page);
  } catch { /* ignore */ }
  const session = {
    browser,
    context,
    page,
    profileId,
    ws: opened.ws || opened.http,
    opened,
    provider,
  };
  sessions.set(profileId, session);
  browser.on('disconnected', () => {
    if (sessions.get(profileId) === session) sessions.delete(profileId);
  });
  return session;
}

async function loginAssist(accountId, {
  autoSubmit = true,
  submitAfterTotp = true,
  connection = null,
  reuseOpen = false,
  forceRelaunch,
  usernameOverride = '',
  skipEnvPackPush = false,
} = {}) {
  // 先清掉可能残留的锁，避免上次超时后「点了没反应」
  activeLogins.delete(String(accountId));
  const lockKey = acquireLoginLock(accountId);
  const run = { cancelled: false };
  // 总任务已打开窗口时：禁止登录流程里关窗推包
  const deferPack = Boolean(skipEnvPackPush || reuseOpen || connection);
  liveLog(`账号 #${accountId}：开始一键登录`,'info',{accountId});
  try {
    const result = await withTimeout(
      runLoginAssist(accountId, {
        autoSubmit,
        submitAfterTotp,
        run,
        usernameOverride,
        connection,
        reuseOpen: reuseOpen || Boolean(connection),
        forceRelaunch,
        skipEnvPackPush: deferPack,
      }),
      LOGIN_LOCK_TTL_MS,
      `登录超时（${Math.round(LOGIN_LOCK_TTL_MS / 1000)} 秒）。请确认自研浏览器环境已打开且页面可操作后重试`
    );
    // 无论成功失败，按实际结果回调同步账号登录状态
    return await callbackLoginStatus(accountId, result || { loginOk: false }, { skipEnvPackPush: deferPack });
  } catch (error) {
    run.cancelled = true;
    await callbackLoginStatus(accountId, { loginOk: false, message: error.message }, { skipEnvPackPush: deferPack }).catch(() => {});
    throw error;
  } finally {
    liveLog(`账号 #${accountId}：登录流程结束`,'info',{accountId});
    releaseLoginLock(lockKey);
  }
}

async function runLoginAssist(accountId, {
  autoSubmit = true,
  submitAfterTotp = true,
  run,
  usernameOverride = '',
  connection = null,
  reuseOpen = false,
  forceRelaunch,
  skipEnvPackPush = false,
} = {}) {
  const deferPack = Boolean(skipEnvPackPush || reuseOpen || connection);
  const bundle = await dataStore.getAccountBundle(accountId);
  assertNotCancelled(run);
  if (!bundle) throw new Error('账号不存在');
  // 总任务已打开窗口：直接用该环境，禁止再去拉失效主绑（否则会卡在「正在从中心库拉取包」）
  const openedPid = String(connection?.account?.browser_profile_id || '').trim();
  let { provider, profileId, label } = await resolveLoginBrowser(bundle, accountId, {
    preferredProfileId: openedPid,
    allowHydrate: !openedPid,
  });
  const password = String(bundle.password || '');
  const totpSecret = String(bundle.totp_secret || '');
  if (!password) {
    if (bundle.password_decrypt_failed) {
      throw new Error('账号密码密文无法解密（密钥可能已更换）。请在操作里点「密码/2FA」重新填写 TikTok 密码');
    }
    throw new Error('账号没有可用登录密码。请在操作里点「密码/2FA」补填 TikTok 密码（及 2FA），或重新导入带密码的账号');
  }
  const { loginUsername, systemUsername, pendingUsername } = resolveLoginUsernameFromBundle(bundle);
  const overrideName = String(usernameOverride || '').replace(/^@+/, '').trim();
  const useUsername = overrideName || loginUsername;
  if (!overrideName && pendingUsername && loginUsername && systemUsername
    && loginUsername.toLowerCase() !== systemUsername.toLowerCase()) {
    liveLog(
      `账号 #${accountId}：有待提交的修改资料（@${systemUsername}），登录使用原账号名 @${loginUsername}`,
      'info',
      { accountId, loginUsername, systemUsername, pendingUsername },
    );
  }
  const account = {
    id: bundle.id,
    username: useUsername,
    system_username: systemUsername,
    browser_profile_id: profileId,
    login_status: bundle.login_status,
  };
  if (!account.username) throw new Error('账号用户名为空，无法填写登录表');

  const proxyHint = bundle.proxy_host
    ? `${bundle.proxy_protocol || 'proxy'}://${bundle.proxy_host}:${bundle.proxy_port || ''}`
    : '';

  if (bundle.proxy_host && bundle.proxy_port) {
    try {
      const { probeProxyObject, resolveProxyCredsFromBundle } = require('../proxy-probe');
      const proxyCreds = await resolveProxyCredsFromBundle(bundle);
      liveLog(`账号 #${accountId}：登录前检测代理 ${proxyHint}`, 'info', { accountId });
      const probe = await probeProxyObject(proxyCreds || {
        protocol: bundle.proxy_protocol || 'socks5',
        host: bundle.proxy_host,
        port: bundle.proxy_port,
        username: bundle.proxy_username || '',
        password: bundle.proxy_password || '',
      }, {
        detectCountry: false,
        strictSocks: false,
        relaxedForLogin: true,
        tcpRetries: 2,
        tcpTimeoutMs: 8000,
      });
      const probeDetail = String(probe.detail || '');
      const tcpOnlyFail = !probe.available && /端口不可连接/.test(probeDetail);
      if (tcpOnlyFail) {
        liveLog(
          `账号 #${accountId}：代理端口预检未响应（仍尝试打开浏览器）：${probeDetail}`,
          'warn',
          { accountId }
        );
      } else if (!probe.available || probe.hardFail) {
        throw new Error(
          `账号绑定的代理不可用${proxyHint ? `（${proxyHint}）` : ''}：${probeDetail || '连接失败'}。请更换代理或到「代理IP」检测通过后再登录`
        );
      } else if (probe.softWarning) {
        liveLog(`账号 #${accountId}：代理预检告警（仍继续登录）：${probeDetail}`, 'warn', { accountId });
      } else {
        liveLog(`账号 #${accountId}：代理检测通过 ${probeDetail}`.trim(), 'info', { accountId });
      }
    } catch (e) {
      if (/代理不可用/i.test(String(e.message || e))) throw e;
      liveLog(`账号 #${accountId}：代理预检异常（继续尝试打开）：${e.message || e}`, 'warn', { accountId });
    }
  }

  let syncProxy = null;
  if (bundle.proxy_host && bundle.proxy_port) {
    const { resolveProxyCredsFromBundle } = require('../proxy-probe');
    const creds = await resolveProxyCredsFromBundle(bundle);
    syncProxy = creds || {
      protocol: bundle.proxy_protocol || 'socks5',
      host: bundle.proxy_host,
      port: bundle.proxy_port,
      username: bundle.proxy_username || '',
      password: bundle.proxy_password || '',
    };
  }
  // 总任务已打开环境时：跳过「关窗改代理再开」，在同一窗口里登录
  if (!reuseOpen && !connection) {
    liveLog(
      `账号 #${accountId}：同步代理到${label}环境 ${syncProxy ? proxyHint : '（清空/直连）'}`,
      'info',
      { accountId }
    );
    const synced = await syncProxyToBrowser(bundle, accountId, { provider, profileId, label }, syncProxy);
    provider = synced.provider;
    profileId = synced.profileId;
    label = synced.label || label;
    account.browser_profile_id = profileId;
  } else if (connection?.account?.browser_profile_id) {
    profileId = String(connection.account.browser_profile_id);
    account.browser_profile_id = profileId;
    if (connection.provider) provider = connection.provider;
  }

  liveLog(
    `账号 #${accountId}：${reuseOpen || connection ? '复用已打开的' : '打开绑定'}浏览器环境（${label}）`,
    'info',
    { accountId }
  );
  // 代理刚写入后需要重启一次才生效；除此之外默认复用已开窗口，禁止先 close 再 open 失败导致「一点登录就没了」
  const needRelaunchForProxy = Boolean(syncProxy?.host && !reuseOpen && !connection);
  const session = await getSession(profileId, provider, {
    forceOpen: !(reuseOpen || connection),
    forceVisible: true,
    forceRelaunch: forceRelaunch === true || needRelaunchForProxy,
    connection: connection || null,
  });
  assertNotCancelled(run);
  dataStore.updateLoginStatus(accountId, 'checking').catch(() => {});
  liveLog(`账号 #${accountId}：当前页面 ${session.page.url()}`,'info',{accountId});
  // BitBrowser may add its own workbench tab after the TikTok tab. Always target
  // the active TikTok 2FA/login page rather than relying on the first cached tab.
  const openPages = session.context.pages().filter(item => !item.isClosed());
  let page = openPages.find(item => /tiktok\.com\/login\/2sv\//i.test(item.url()))
    || openPages.find(item => /tiktok\.com/i.test(item.url()))
    || session.page;
  session.page = page;
  await page.bringToFront().catch(() => {});

  // 已停在 Chrome 错误页（如 ERR_SOCKS_CONNECTION_FAILED）时直接报代理问题
  await assertPageNetworkOk(page, { accountId, proxyHint });

  // 先落到 TikTok 主站，才能用页面上的登录墙交叉验证（只看 Cookie 会误判）
  if (!/tiktok\.com/i.test(String(page.url() || '')) || await detectBrowserNetworkError(page)) {
    await safeLoginGoto(page, 'https://www.tiktok.com/', { accountId, proxyHint });
    await page.waitForTimeout(1500);
    page = session.page;
  }

  const withPackFlag = (obj) => ({
    ...(obj || {}),
    skipEnvPackPush: deferPack,
    profileId: String(obj?.profileId || profileId || ''),
    browserProfileId: String(obj?.browserProfileId || profileId || ''),
  });
  const finalize = async (base, pg = page, ctx = session.context) =>
    finalizeAfterLogin(accountId, session.ws, withPackFlag(base), pg, ctx);

  {
    const formFree = await tryFormFreeLogin(accountId, account, session, page, run);
    if (formFree) return withPackFlag(formFree);
  }

  const existingSession = await inspectTikTokSession(session.ws, page);
  assertNotCancelled(run);

  // 用户主动点登录：只要出现登录弹窗/Log in，一律不算已登录，清掉失效 Cookie 继续填表
  const onLoginWall = existingSession.uiLoggedOut || await isLoginMethodHub(page);
  if (onLoginWall) {
    if (existingSession.hasSessionCookie) {
      liveLog(`账号 #${accountId}：页面仍是登录墙，忽略失效 Cookie，继续登录`, 'warn', { accountId });
      await clearTikTokCookiesOnly(session.context);
    }
    await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
  } else if (existingSession.loggedIn) {
    await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
    await persistAccountSessionLog(accountId, session.context, page, '', profileId);
    return withPackFlag({
      accountId,
      username: account.username,
      filled: false,
      submitted: false,
      twoFactorRequired: false,
      totpFilled: false,
      captcha: false,
      alreadyLoggedIn: true,
      loginOk: true,
      screenshot: '',
      currentUrl: page.url(),
      pageTitle: await page.title(),
      message: '检测到已有有效 TikTok 登录状态，无需重复登录（自研浏览器窗口已打开）',
    });
  }

  // 未登录：先清首页弹层并硬跳邮箱密码页（不要停在 FYP「Log in to TikTok」里点）
  if (!(await hasCredentialForm(page)) && !(await isTwoStepVerificationPage(page))) {
    if (onLoginWall || await isLoginMethodHub(page) || !/\/login\/phone-or-email\/email/i.test(String(page.url() || ''))) {
      liveLog(`账号 #${accountId}：离开首页/方式选择页，进入邮箱登录表单`, 'info', { accountId });
      await openEmailCredentialForm(page, accountId, proxyHint);
    }
  }

  // Handle 2-step FIRST. Never clear cookies / navigate away while the user is
  // already on the authenticator page — that would kill the login session.
  if (await isTwoStepVerificationPage(page)) {
    return finalize(await fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run));
  }

  // If a previous failed attempt left the rate-limit banner on this profile,
  // clear TikTok site data once and open a fresh login page. Do not refuse to
  // navigate — that used to trap every retry on the same error screen.
  let limitedMsg = await findAttemptLimitMessage(page);
  if (limitedMsg) {
    liveLog(`账号 #${accountId}：检测到限流文案，清理 TikTok Cookie 并重新打开登录页`,'warn',{accountId});
    await clearTikTokCookiesOnly(session.context);
    await safeLoginGoto(page, 'https://www.tiktok.com/login/phone-or-email/email', { accountId, proxyHint });
    await page.waitForTimeout(1000);
    if (await isTwoStepVerificationPage(page)) {
      return finalize(await fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run));
    }
    limitedMsg = await findAttemptLimitMessage(page);
    if (limitedMsg) {
      await dataStore.updateLoginStatus(accountId, 'offline');
      const shot = path.join(screenshotDir, `login-${accountId}-${Date.now()}-limited.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      const result = attemptLimitedResult(account, page, shot);
      result.pageTitle = await page.title().catch(() => '');
      return withPackFlag(result);
    }
  }

  // Reach the email/username + password form. The generic /login hub
  // (QR / Google / Apple / phone-email-username) is NOT the credential form —
  // staying there was why users only saw "Log in to TikTok" method tiles.
  const currentUrl = page.url();
  liveLog(`账号 #${accountId}：登录选定页面 ${currentUrl}`,'info',{accountId});
  assertNotCancelled(run);
  const openedForm = await openEmailCredentialForm(page, accountId, proxyHint);
  if (!openedForm) {
    await dataStore.updateLoginStatus(accountId, 'offline');
    // 若其实是代理错误页，优先报网络原因
    await assertPageNetworkOk(page, { accountId, proxyHint });
    return withPackFlag({
      accountId, username: account.username, filled: false, submitted: false, captcha: false, loginOk: false,
      screenshot: '', currentUrl: page.url(), pageTitle: await page.title().catch(() => ''),
      message: '仍停留在登录方式选择页（QR/Google/Apple）。请手动点「Use phone / email / username」后重试一键登录',
    });
  }
  assertNotCancelled(run);
  if (await isTwoStepVerificationPage(page)) {
    return finalize(await fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run));
  }
  limitedMsg = await findAttemptLimitMessage(page);
  if (limitedMsg) {
    liveLog(`账号 #${accountId}：登录页仍有限流文案，清理后重开一次`,'warn',{accountId});
    await clearTikTokCookiesOnly(session.context);
    await openEmailCredentialForm(page, accountId, proxyHint);
    limitedMsg = await findAttemptLimitMessage(page);
    if (limitedMsg) {
      await dataStore.updateLoginStatus(accountId, 'offline');
      const shot = path.join(screenshotDir, `login-${accountId}-${Date.now()}-limited.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      const result = attemptLimitedResult(account, page, shot);
      result.pageTitle = await page.title().catch(() => '');
      return result;
    }
  }
  const hasCaptcha = async () => {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const rot = await solveRotateCaptchaIfPresent(page, { accountId });
      if (rot?.detected) {
        return !rot.solved;
      }
    } catch { /* ignore */ }
    const textHit = /(captcha|verify you are human|drag the slider to fit the puzzle|人机验证|滑块|旋转|security check)/i.test(await pageBodyText(page));
    if (!textHit) return false;
    try {
      await page.waitForTimeout(700).catch(() => {});
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const rot2 = await solveRotateCaptchaIfPresent(page, { accountId });
      if (rot2?.detected && rot2?.solved) return false;
    } catch { /* ignore */ }
    return /(captcha|verify you are human|drag the slider to fit the puzzle|人机验证|滑块|旋转|security check)/i.test(await pageBodyText(page));
  };
  let captcha = await hasCaptcha();
  // Form should already be open; wait briefly if TikTok is still rendering inputs.
  for (let i = 0; !captcha && i < 10; i += 1) {
    assertNotCancelled(run);
    if (await findAttemptLimitMessage(page)) break;
    if (await isTwoStepVerificationPage(page)) {
      return finalize(await fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run));
    }
    if (await hasCredentialForm(page)) break;
    if (await isLoginMethodHub(page)) {
      await openEmailCredentialForm(page, accountId, proxyHint);
    } else {
      await selectUsernameLogin(page);
    }
    await assertPageNetworkOk(page, { accountId, proxyHint });
    await page.waitForTimeout(500);
    captcha = await hasCaptcha();
  }
  limitedMsg = await findAttemptLimitMessage(page);
  if (limitedMsg) {
    await dataStore.updateLoginStatus(accountId, 'offline');
    const result = attemptLimitedResult(account, page);
    result.pageTitle = await page.title().catch(() => '');
    return result;
  }
  let screenshot = '';
  if (captcha) {
    screenshot = path.join(screenshotDir, `login-${accountId}-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
  }

  // 等输入框真正可编辑（页面已渲染到邮箱密码表，但 input 偶发晚挂载）
  for (let i = 0; i < 15; i += 1) {
    assertNotCancelled(run);
    const ready = await resolveCredentialInputs(page);
    if (ready.usernameInput && ready.passwordInput) break;
    await page.waitForTimeout(400);
  }
  assertNotCancelled(run);
  const fillRes = await fillLoginCredentials(page, account.username, password, { accountId, attempts: 3 });
  const usernameFilled = Boolean(fillRes.usernameFilled);
  const passwordFilled = Boolean(fillRes.passwordFilled);
  limitedMsg = await findAttemptLimitMessage(page);
  if (limitedMsg) {
    await dataStore.updateLoginStatus(accountId, 'offline');
    const result = attemptLimitedResult(account, page, screenshot);
    result.pageTitle = await page.title().catch(() => '');
    return result;
  }
  if (!fillRes.ok) {
    await dataStore.updateLoginStatus(accountId, 'offline');
    screenshot = path.join(screenshotDir, `login-${accountId}-${Date.now()}-fill-fail.png`);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
    return {
      accountId, username: account.username, filled: false, submitted: false,
      twoFactorRequired: false, totpFilled: false, captcha, screenshot,
      currentUrl: page.url(), pageTitle: await page.title(),
      message: fillRes.message || '未能填写账号密码',
    };
  }
  let totpFilled = false;
  let submitted = false;
  let twoFactorRequired = false;
  // 一键登录：等 Log in 启用后再点，进入 2FA 后自动填码并确认
  let submitBlockReason = '';
  if (autoSubmit && !captcha && !(await findAttemptLimitMessage(page))) {
    assertNotCancelled(run);
    // 点登录前再确认一次值还在；被清空则补填
    const preClick = await resolveCredentialInputs(page);
    if (preClick.usernameInput && preClick.passwordInput) {
      const u = await readInputValue(preClick.usernameInput);
      const p = await readInputValue(preClick.passwordInput);
      if (u !== account.username || p !== password) {
        liveLog(`账号 #${accountId}：点击前发现输入被清空，重新填写`, 'warn', { accountId });
        await fillLoginCredentials(page, account.username, password, { accountId, attempts: 2 });
      }
    }
    liveLog(`账号 #${accountId}：等待登录按钮启用并点击…`, 'info', { accountId });
    const clickRes = await clickLoginSubmitWhenEnabled(page, {
      timeoutMs: 18000,
      accountId,
      username: account.username,
      password,
    });
    if (clickRes.clicked) {
      submitted = true;
      for (let i = 0; i < 80; i += 1) {
        assertNotCancelled(run);
        await page.waitForTimeout(500);
        if (await findAttemptLimitMessage(page)) break;
        if (await hasCaptcha()) { captcha = true; break; }
        if (await isTwoStepVerificationPage(page)) {
          twoFactorRequired = true;
          if (totpSecret) {
            const step = await fillTwoStepVerification(page, account, totpSecret, submitAfterTotp, run);
            return finalize({ ...step, submitted: true, usernameFilled, passwordFilled });
          }
          break;
        }
        try {
          const mid = await inspectTikTokSession(session.ws, page);
          if (mid?.loggedIn) {
            return finalize({
              accountId, username: account.username, filled: true, usernameFilled, passwordFilled,
              submitted: true, twoFactorRequired: false, totpFilled: false, captcha: false,
              message: '登录成功',
            });
          }
        } catch { /* continue waiting */ }
      }
    } else {
      submitBlockReason = clickRes.reason || '未能自动点击登录按钮';
    }
  }
  if (captcha && !screenshot) {
    screenshot = path.join(screenshotDir, `login-${accountId}-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
  }
  const limitedNow = Boolean(await findAttemptLimitMessage(page));
  const result = {
    accountId, username: account.username, filled: true, usernameFilled, passwordFilled, submitted, twoFactorRequired, totpFilled, captcha,
    attemptLimited: limitedNow, screenshot, currentUrl: page.url(), pageTitle: await page.title(),
    message: limitedNow
      ? 'TikTok 页面显示登录次数已达上限。请关闭该自研浏览器环境后换新代理，或新建浏览器环境再试'
      : (captcha ? '检测到安全验证（滑块/人机），已暂停自动提交，请在自研浏览器窗口人工完成后再点「检测登录」'
        : (submitted
          ? (twoFactorRequired && !totpSecret
            ? '已提交登录，但缺少 2FA 密钥，请在「密码/2FA」补填后重试'
            : '已自动提交登录，正在确认会话')
          : (submitBlockReason || '账号和密码已填充，但未能自动点击登录按钮，请检查页面后重试'))),
  };
  return finalize(result);
}

async function closeSession(profileId, { accountId = 0, pushPack = true } = {}) {
  const pid = String(profileId || '').trim();
  if (!pid) return;
  const session = sessions.get(pid);
  if (session) {
    await session.browser.close().catch(() => {});
    sessions.delete(pid);
  }
  const provider = getProvider();
  const local = await provider.detail(pid).catch(() => null);
  if (!local) {
    // 本机已无此环境：只清会话，禁止再 export（否则日志刷「环境不存在」）
    return;
  }
  await provider.close(pid).catch(() => {});
  if (pushPack) {
    try {
      const { pushLocalEnvPack } = require('./env-pack-sync');
      await pushLocalEnvPack(pid, { accountId, provider });
    } catch { /* pushLocalEnvPack 内部已 warn */ }
  }
}

/**
 * 「打开环境」后的后台自动恢复登录（不关窗、不弹表单、不清 Cookie）：
 * 1) 环境包里的登录态已生效 → 直接标记在线；
 * 2) 否则用中心库保存的会话凭证（Cookie/Storage）注入并校验；
 * 3) 仍无效 → 只记日志，保留现场，由用户点「登录」走表单并保存新凭证。
 */
async function restoreLoginOnOpen(accountId, profileId, provider) {
  const aid = Number(accountId) || 0;
  const pid = String(profileId || '').trim();
  if (!aid || !pid || !provider) return { restored: false, reason: 'skip' };
  // 正在登录的账号不要抢页面
  if (activeLogins.has(String(aid))) return { restored: false, reason: 'login-running' };
  try {
    const session = await getSession(pid, provider, {
      forceOpen: true,
      forceVisible: true,
      forceRelaunch: false,
    });
    const pages = session.context.pages().filter((p) => !p.isClosed());
    const page = pages.find((p) => /tiktok\.com/i.test(p.url())) || session.page;
    session.page = page;
    if (!/tiktok\.com/i.test(String(page.url() || ''))) {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    let status = await inspectTikTokSession(session.ws, page).catch(() => null);
    if (status?.loggedIn && !(await pageLooksLoggedOut(page))) {
      await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
      liveLog(`账号 #${aid}：打开环境后检测到已登录（环境包登录态有效）`, 'info', { accountId: aid });
      return { restored: true, source: 'env-pack' };
    }

    const saved = await dataStore.getSession(aid).catch(() => null);
    if (!saved?.cookie) {
      liveLog(`账号 #${aid}：打开环境后未登录，且中心库无已存凭证，请点「登录」走表单登录并保存凭证`, 'warn', { accountId: aid });
      return { restored: false, reason: 'no-saved-session' };
    }
    liveLog(`账号 #${aid}：打开环境后未登录，正在用已存凭证自动登录`, 'info', { accountId: aid });
    await applySavedSessionToContext(session.context, page, saved);
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    status = await inspectTikTokSession(session.ws, page).catch(() => null);
    if (status?.loggedIn && !(await pageLooksLoggedOut(page))) {
      await dataStore.updateLoginStatus(aid, 'online').catch(() => {});
      await persistAccountSessionLog(aid, session.context, page, saved.fingerprint || '', pid).catch(() => {});
      liveLog(`账号 #${aid}：已用已存凭证自动登录成功`, 'info', { accountId: aid });
      return { restored: true, source: 'session-log' };
    }
    // 注意：这里不清 Cookie、不清会话日志，避免打开环境就破坏现场
    liveLog(`账号 #${aid}：已存凭证已失效，请点「登录」走表单登录并保存新凭证`, 'warn', { accountId: aid });
    return { restored: false, reason: 'session-expired' };
  } catch (e) {
    liveLog(`账号 #${aid}：打开环境后自动恢复登录失败：${e.message || e}`, 'warn', { accountId: aid });
    return { restored: false, reason: String(e.message || e) };
  } finally {
    // 打开环境时 prepareEnvForOpen 占了租约；恢复检测结束就释放，WSS 才能唤醒队首等待设备
    try {
      const { releasePackLeaseBestEffort } = require('./env-pack-sync');
      await releasePackLeaseBestEffort(pid);
    } catch { /* ignore */ }
  }
}

/** 仅丢掉登录 CDP 缓存，不关浏览器窗口 */
function forgetSession(profileId) {
  const pid = String(profileId || '');
  if (!pid) return;
  sessions.delete(pid);
}

module.exports = {
  loginAssist,
  fullLogin,
  closeSession,
  clearTikTokCookiesOnly,
  forgetSession,
  restoreLoginOnOpen,
  detectBrowserNetworkError,
  networkErrorMessage,
  applySavedSessionToContext,
  persistAccountSessionLog,
  pushEnvPackBestEffort,
  fillLoginCredentials,
  openEmailCredentialForm,
  dismissLoginOverlay,
};
