const WebSocket = require('ws');
const { nowChinaIso } = require('../utils/china-time');

function command(wsUrl, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`CDP 命令超时：${method}`));
    }, timeoutMs);

    socket.once('open', () => socket.send(JSON.stringify({ id, method, params })));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message || `CDP 命令失败：${method}`));
      else resolve(message.result || {});
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`无法连接浏览器 CDP：${error.message}`));
    });
  });
}

/**
 * 仅看 Cookie 不够：过期/失效的 sessionid 仍会留在本地，但页面已显示 Log in。
 * 有 page 时必须用页面态交叉验证。
 */
async function pageLooksLoggedOut(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    const url = String(page.url() || '');
    if (/tiktok\.com\/login/i.test(url)) return true;

    const body = String(await page.locator('body').innerText().catch(() => '') || '');
    // 登录方式弹窗 / 登录墙（用户截图里的那种）
    if (/Log in to TikTok|登录到 TikTok|登录 TikTok/i.test(body)) return true;
    if (/Use QR code|使用二维码/i.test(body) && /Use phone or email|Use phone\s*\/\s*email|使用手机号/i.test(body)) return true;
    if (/Don['’]t have an account\?\s*Sign up|还没有账号？\s*注册/i.test(body)) return true;

    const topLogin = page.locator('[data-e2e="top-login-button"]').first();
    if (await topLogin.count() && await topLogin.isVisible().catch(() => false)) return true;

    // 登录表单提交钮（含 disabled）出现即视为登录墙
    const formLogin = page.locator('[data-e2e="login-button"]').first();
    if (await formLogin.count() && await formLogin.isVisible().catch(() => false)) return true;

    const loginControls = [
      page.getByRole('button', { name: /^(Log in|登录|Sign in)$/i }).first(),
      page.getByRole('link', { name: /^(Log in|登录|Sign in)$/i }).first(),
      page.locator('button, a').filter({ hasText: /^(Log in|登录)$/i }).first(),
    ];
    for (const loc of loginControls) {
      if (await loc.count() && await loc.isVisible().catch(() => false)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** TikTok Studio 后台壳（上传/内容管理）没有主站 profile 图标，单独识别 */
async function pageLooksLikeStudioAuthed(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    const url = String(page.url() || '');
    if (!/tiktokstudio/i.test(url)) return false;
    if (await pageLooksLoggedOut(page)) return false;
    // 能看到 Studio 上传/侧栏，匿名用户通常会被踢去登录页
    const markers = [
      page.getByText(/Select video to upload|Select video|Or drag and drop/i).first(),
      page.getByRole('tab', { name: /^(Videos|Photos)$/i }).first(),
      page.getByText(/TikTok Studio/i).first(),
      page.locator('a[href*="tiktokstudio"]').first(),
    ];
    for (const loc of markers) {
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return true;
    }
    // URL 已在 studio 且无登录墙，也视为已登录壳
    return /tiktokstudio\/(upload|content|analytics|home|comments?)/i.test(url);
  } catch {
    return false;
  }
}

/** 只有页面明确像已登录（有个人入口且无登录墙）才算已登录 */
async function pageLooksLoggedIn(page) {
  if (!page || page.isClosed?.()) return false;
  if (await pageLooksLoggedOut(page)) return false;
  try {
    if (await pageLooksLikeStudioAuthed(page)) return true;
    const markers = [
      page.locator('[data-e2e="nav-profile"]').first(),
      page.locator('[data-e2e="profile-icon"]').first(),
      page.locator('[data-e2e="top-profile-icon"]').first(),
      page.locator('a[href*="/@"]').first(),
      page.locator('[data-e2e="user-avatar"], [data-e2e="avatar"]').first(),
    ];
    for (const loc of markers) {
      if (await loc.count() && await loc.isVisible().catch(() => false)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 读 TikTok 页面「右上角」：显示的是 Log in 按钮还是账号头像。
 * 只看顶部右侧区域（几何过滤），避免信息流里的 Log in 文案 / 作者链接误判。
 */
function urlHost(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return ''; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ __timeout: true, reason: `timeout:${label}` }), ms);
      timer.unref?.();
    }),
  ]);
}

/** 服务端真相接口：TikTok 自己的「当前登录账号」 */
const ACCOUNT_INFO_URL = 'https://www.tiktok.com/passport/web/account/info/?aid=1459&app_name=tiktok_web&device_platform=web';

/**
 * 问 TikTok 服务器「现在这个 session 还有效吗」。
 * 有效 → {"message":"success","data":{"user_id":...}}
 * 残留/失效 Cookie → {"message":"error","data":{"error_code":13,"name":"session_expired"}}
 * 注意：这一步只有页面本身在 tiktok.com 上才能做（同源 + 自动带 Cookie）。
 */
async function probeAccountInfo(page) {
  if (!page || page.isClosed?.()) return { ok: false, reason: 'no-page' };
  const pageUrl = String(page.url() || '');
  if (!/(^|\.)tiktok\.com$/i.test(urlHost(pageUrl))) {
    return { ok: false, reason: 'not-tiktok-page', pageUrl };
  }
  try {
    const res = await withTimeout(page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        return { status: resp.status, json, text: json ? '' : text.slice(0, 200) };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    }, ACCOUNT_INFO_URL), 9000, 'account-info');

    if (res?.__timeout) return { ok: false, reason: res.reason };
    if (res?.error) return { ok: false, reason: 'fetch-error', error: res.error };
    if (!res || typeof res !== 'object') return { ok: false, reason: 'no-result' };

    const json = res.json;
    if (!json || typeof json !== 'object') {
      return { ok: false, reason: 'not-json', status: res.status, text: res.text || '' };
    }
    const message = String(json.message || '');
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const userId = String(data.user_id || data.uid || data.userId || '');
    const username = String(data.username || data.unique_id || '');

    if (message === 'success') {
      // 正常登录态会带 user_id / uid / username；万一接口结构变了，别急着判「已登录」
      if (userId || username) {
        return { ok: true, loggedIn: true, userId, username, message, httpStatus: res.status };
      }
      return { ok: false, reason: 'success-without-user', message, httpStatus: res.status };
    }
    const reason = String(data.name || data.description || message || 'unknown');
    return {
      ok: true,
      loggedIn: false,
      reason,
      errorCode: Number(data.error_code || 0) || null,
      sessionExpired: /session_expired/i.test(reason) || Number(data.error_code || 0) === 13,
      message,
      httpStatus: res.status,
    };
  } catch (error) {
    return { ok: false, reason: 'evaluate-failed', error: String(error?.message || error) };
  }
}

/**
 * 门禁页导航探针：/messages 是登录后页面，未登录会被踢到 /login?redirect_url=...
 * 只有在「接口 + 右上角都判不出来」时才会用到（代价是一次页面跳转）。
 */
async function probeLoginGate(page, options = {}) {
  if (!page || page.isClosed?.()) return { ok: false, reason: 'no-page' };
  if (!/(^|\.)tiktok\.com$/i.test(urlHost(String(page.url() || '')))) {
    return { ok: false, reason: 'not-tiktok-page' };
  }
  const timeout = options.timeout || 30000;
  try {
    const res = await withTimeout((async () => {
      await page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(1200);
      const finalUrl = String(page.url() || '');
      return { ok: true, loggedIn: !/\/login(\?|$|\/)/i.test(finalUrl), finalUrl };
    })(), timeout + 6000, 'login-gate');
    if (res?.__timeout) return { ok: false, reason: res.reason };
    return res && typeof res === 'object' ? res : { ok: false, reason: 'no-result' };
  } catch (error) {
    return { ok: false, reason: 'goto-failed', error: String(error?.message || error) };
  }
}


async function topRightAuthState(page) {
  const empty = { ok: false, loginButton: false, avatar: false, loginHits: 0, avatarHits: 0, url: '' };
  if (!page || page.isClosed?.()) return empty;
  const url = String(page.url?.() || '');
  try {
    const data = await page.evaluate(() => {
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      // 顶部条：右侧 45% 且纵向在前 1/3（最多 260px）内
      const minLeft = vw * 0.55;
      const maxBottom = Math.max(140, Math.min(260, vh * 0.34));
      const visibleInTopRight = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (rect.right < minLeft || rect.bottom < 0 || rect.top > maxBottom) return false;
        return true;
      };
      const textOf = (el) => String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      const loginSamples = [];
      let loginHits = 0;
      const loginSel = '[data-e2e="top-login-button"],[data-e2e="login-button"],[data-e2e*="login-button"],a[href*="/login"]';
      for (const el of document.querySelectorAll(loginSel)) {
        if (!visibleInTopRight(el)) continue;
        loginHits += 1;
        if (loginSamples.length < 3) loginSamples.push((textOf(el) || el.getAttribute('data-e2e') || el.tagName).slice(0, 40));
      }
      if (!loginHits) {
        for (const el of document.querySelectorAll('button,a,[role="button"]')) {
          if (!visibleInTopRight(el)) continue;
          const text = textOf(el);
          if (!text || text.length > 30) continue;
          if (/^(log ?in|sign ?in|登录)$/i.test(text)) {
            loginHits += 1;
            if (loginSamples.length < 3) loginSamples.push(text);
          }
        }
      }
      const avatarSel = '[data-e2e="top-profile-icon"],[data-e2e="nav-profile"],[data-e2e="profile-icon"],[data-e2e*="avatar"]';
      const avatarSamples = [];
      let avatarHits = 0;
      for (const el of document.querySelectorAll(avatarSel)) {
        if (!visibleInTopRight(el)) continue;
        avatarHits += 1;
        if (avatarSamples.length < 3) avatarSamples.push((textOf(el) || el.getAttribute('data-e2e') || el.tagName).slice(0, 40));
      }
      if (!avatarHits) {
        // 兜底：右上角的圆形头像图 / 指向个人主页的链接
        for (const el of document.querySelectorAll('a[href^="/@"],img')) {
          if (!visibleInTopRight(el)) continue;
          const rect = el.getBoundingClientRect();
          const round = Math.abs(rect.width - rect.height) <= 4 && rect.width >= 20 && rect.width <= 96;
          if (!round && !String(el.getAttribute('href') || '').startsWith('/@')) continue;
          avatarHits += 1;
          if (avatarSamples.length < 3) avatarSamples.push((el.getAttribute('href') || el.tagName).slice(0, 40));
        }
      }
      return { vw, vh, loginHits, loginSamples, avatarHits, avatarSamples };
    });
    return {
      ok: true,
      url,
      host: urlHost(url),
      onTikTok: /(^|\.)tiktok\.com$/i.test(urlHost(url)),
      loginHits: Number(data?.loginHits || 0),
      avatarHits: Number(data?.avatarHits || 0),
      loginButton: Number(data?.loginHits || 0) > 0,
      avatar: Number(data?.avatarHits || 0) > 0,
      loginSamples: data?.loginSamples || [],
      avatarSamples: data?.avatarSamples || [],
    };
  } catch (error) {
    return { ...empty, url, host: urlHost(url), error: error?.message || String(error) };
  }
}

/**
 * 登录判定（纯函数，便于单测）：
 * 1) TikTok 账号接口 = 服务端真相（唯一能证明「Cookie 还有效」的东西）
 * 2) 页面右上角头像 / Log in 按钮 = 页面真相，可覆盖残留 Cookie
 * 3) 登录墙 / Studio 壳 = 辅助
 * 4) 门禁页导航探针 = 接口和页面都判不出来时的仲裁
 * 5) 全都判不出来才退回 Cookie（旧行为）
 */
function decideLoginState(input = {}) {
  const {
    hasPage, hasSessionCookie, uiLoggedOut, uiLoggedIn, studioAuthed, topRight, apiProbe, gateProbe,
  } = input;
  const loginButton = Boolean(topRight?.loginButton);
  const avatar = Boolean(topRight?.avatar);
  if (!hasPage) return hasSessionCookie;
  // 1) 接口有明确结论时以接口为准
  if (apiProbe?.ok) return Boolean(apiProbe.loggedIn);
  // 2) 右上角头像 → 已登录（再要求有会话 Cookie 或其他已登录特征，避免把推广气泡当头像）
  if (avatar && !loginButton && (hasSessionCookie || uiLoggedIn)) return true;
  // 3) 右上角是 Log in 按钮 → 未登录：必须覆盖残留 Cookie
  if (loginButton && !avatar) return false;
  if (uiLoggedOut) return false;
  if (studioAuthed) return true;
  // 4) 门禁页探针
  if (gateProbe?.ok) return Boolean(gateProbe.loggedIn);
  // 5) 兜底：只看 Cookie（页面没起来 / 接口不可用时）
  if (uiLoggedIn && hasSessionCookie) return true;
  if (hasSessionCookie && !uiLoggedOut) return true;
  return false;
}

async function inspectTikTokSession(wsUrl, page = null, options = {}) {
  const result = await command(wsUrl, 'Storage.getCookies');
  const now = Date.now() / 1000;
  const cookies = (result.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!/(^|\.)tiktok\.com$/i.test(domain)) return false;
    // 过期 Cookie 不算有效登录
    if (cookie.expires && cookie.expires > 0 && cookie.expires < now) return false;
    if (!cookie.value || String(cookie.value).trim() === '') return false;
    return true;
  });
  const names = new Set(cookies.map((cookie) => cookie.name));
  const evidence = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'tt_chain_token'].filter((name) => names.has(name));
  const hasSessionCookie = names.has('sessionid') || names.has('sessionid_ss') || evidence.length >= 2;

  let uiLoggedOut = false;
  let uiLoggedIn = false;
  let studioAuthed = false;
  let topRight = null;
  let apiProbe = null;
  let gateProbe = null;
  if (page) {
    uiLoggedOut = await pageLooksLoggedOut(page);
    topRight = await topRightAuthState(page).catch(() => null);
    // 服务端真相：问 TikTok 这个 session 还有效吗（能识破「Cookie 还在但已退出登录」）
    apiProbe = await probeAccountInfo(page).catch(() => null);
    studioAuthed = !uiLoggedOut && await pageLooksLikeStudioAuthed(page);
    uiLoggedIn = !uiLoggedOut && (studioAuthed || await pageLooksLoggedIn(page));

    // 只有接口没结论、右上角也没结论、但本地有 Cookie 时，才多花一次导航去门禁页仲裁
    const uiConclusive = Boolean(topRight?.loginButton || topRight?.avatar) || uiLoggedOut;
    if (!apiProbe?.ok && !uiConclusive && hasSessionCookie && options.gateProbe !== false) {
      gateProbe = await probeLoginGate(page, { timeout: options.gateProbeTimeout || 30000 }).catch(() => null);
    }
  }

  const loggedIn = decideLoginState({
    hasPage: Boolean(page),
    hasSessionCookie,
    uiLoggedOut,
    uiLoggedIn,
    studioAuthed,
    topRight,
    apiProbe,
    gateProbe,
  });

  // 本地有 Cookie，但服务端说 session 已失效 → 这些 Cookie 是垃圾，判定后可以清掉
  const invalidCookie = Boolean(hasSessionCookie && apiProbe?.ok && !apiProbe.loggedIn);
  // 接口与页面互相矛盾时留个标记，方便排查（仍以接口为准）
  const apiConflict = Boolean(
    apiProbe?.ok
    && ((apiProbe.loggedIn && (topRight?.loginButton || uiLoggedOut))
      || (!apiProbe.loggedIn && topRight?.avatar && !topRight?.loginButton))
  );

  return {
    loggedIn,
    hasSessionCookie,
    invalidCookie,
    apiConflict,
    uiLoggedOut,
    uiLoggedIn,
    studioAuthed,
    topRight,
    apiProbe,
    gateProbe,
    cookieCount: cookies.length,
    evidence,
    pageUrl: page ? String(page.url() || '') : '',
    checkedAt: nowChinaIso(),
  };
}

module.exports = {
  command,
  inspectTikTokSession,
  pageLooksLoggedOut,
  pageLooksLoggedIn,
  pageLooksLikeStudioAuthed,
  topRightAuthState,
  decideLoginState,
  probeAccountInfo,
  probeLoginGate,
};

