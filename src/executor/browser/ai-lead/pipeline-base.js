const { connectAccount, closeConnection } = require('../tiktok-actions');
const phpApi = require('../../php-api');
const { publish: liveLog } = require('../../live-log');

const HOME_URL = 'https://www.tiktok.com/';

const SELECTORS = {
  usersTab: [
    '[data-e2e="search-user"]',
    '[data-e2e="tab-search_user"]',
    '[data-e2e="search-tab-user"]',
    'a[href*="/search/user"]',
  ],
  videosTab: [
    '[data-e2e="search-video"]',
    '[data-e2e="tab-search_video"]',
    '[data-e2e="search-tab-video"]',
    'a[href*="/search/video"]',
    '[data-e2e="search-tabs"] a[href*="video"]',
  ],
  searchUserItem: [
    'div[class*="DivSearchUserItemContainer"]',
    'div[class*="DivSearchItemContainer"]',
    'a.link-a11y-focus[href*="/@"]',
    '[data-e2e="search-user-item"]',
    '[data-e2e="search-user-info"]',
    'a[href*="/@"]',
  ],
  searchVideoItem: [
    '[data-e2e="search_video-item"]',
    '[data-e2e="search-video-item"]',
    'div[class*="DivItemContainerForSearch"]',
    'div[class*="DivVideoCard"]',
    'a[href*="/video/"]',
  ],
  commentOpen: [
    '[data-e2e="browse-comment-icon"]',
    'button[data-e2e="browse-comment-icon"]',
    '[data-e2e="comment-icon"]',
    '[data-e2e="video-comment-icon"]',
    'button[aria-label*="Comment" i]',
    'button[aria-label*="comment" i]',
    'button[aria-label*="评论"]',
  ],
  commentPanelReady: [
    '[data-e2e="comment-list"]',
    '[data-e2e="comment-item"]',
    '[data-e2e="comment-level-1"]',
    '[data-e2e="comment-input"]',
    '[class*="DivCommentListContainer"]',
    '[class*="DivCommentContainer"]',
    '[class*="CommentItem"]',
    '[placeholder*="Add comment" i]',
    '[placeholder*="添加评论"]',
  ],
  commentItem: [
    '[data-e2e="comment-item"]',
    '[data-e2e="comment-level-1"]',
    'div[class*="CommentItem"]',
    'div[class*="DivCommentObjectWrapper"]',
  ],
};

const { scaleMs, jitter, sleep: delay } = require('../../human-pace');
const {
  scaleTimeout,
  waitDocumentReady,
  waitPageSettled,
} = require('../page-ready');

async function humanPause(baseMs, spread = 0.3, leadId = 0) {
  // 全局人类节奏缩放，降低拓客触发验证的概率
  const total = Math.max(0, jitter(scaleMs(baseMs), spread));
  if (!leadId || total < 800) {
    if (leadId) assertLeadActive(leadId);
    await delay(total);
    return;
  }
  // 分段等待，暂停后最多约 0.5s 内响应
  const slice = 500;
  let left = total;
  while (left > 0) {
    assertLeadActive(leadId);
    const step = Math.min(slice, left);
    await delay(step);
    left -= step;
  }
}

/** 用户暂停/终止拓客时抛出，供流水线协作退出 */
class AbortError extends Error {
  constructor(message = '任务已暂停') {
    super(message);
    this.name = 'AbortError';
    this.aborted = true;
  }
}

/** leadId -> { connection, aborted, reason, accountId } */
const activeLeadRuns = new Map();

function registerLeadRun(leadId, connection, accountId = 0) {
  const id = Number(leadId || 0);
  if (!id) return;
  const prev = activeLeadRuns.get(id);
  // 新一轮流水线注册时不继承 abort（重推会先 abort-ai-lead 留下 sticky flag）
  activeLeadRuns.set(id, {
    connection: connection || prev?.connection || null,
    accountId: Number(accountId || prev?.accountId || 0),
    aborted: false,
    reason: '',
  });
}

function unregisterLeadRun(leadId) {
  const id = Number(leadId || 0);
  if (id) activeLeadRuns.delete(id);
}

/**
 * 立即标记终止并强制关窗（暂停按钮 / 重推时调用）。
 * @returns {{ closed: string[], reason: string }}
 */
async function abortLeadRun(leadId, reason = '任务已暂停') {
  const id = Number(leadId || 0);
  const closed = [];
  if (!id) return { closed, reason };
  const cur = activeLeadRuns.get(id) || {};
  cur.aborted = true;
  cur.reason = reason || '任务已暂停';
  activeLeadRuns.set(id, cur);
  const connection = cur.connection;
  const profileId = String(connection?.account?.browser_profile_id || '');
  if (connection) {
    try {
      await closeConnection(connection, { force: true });
      if (profileId) closed.push(profileId);
    } catch { /* ignore */ }
    cur.connection = null;
  }
  if (profileId) {
    try {
      const { forceCloseBrowserProfile } = require('../tiktok-actions');
      await forceCloseBrowserProfile(profileId);
      if (!closed.includes(profileId)) closed.push(profileId);
    } catch { /* ignore */ }
  }
  return { closed, reason: cur.reason };
}

function isLeadAborted(leadId) {
  const cur = activeLeadRuns.get(Number(leadId || 0));
  return !!(cur && cur.aborted);
}

/** 新一轮抓取/重推/私信测试前清除 abort 标记（abort-ai-lead 会留下 sticky flag） */
function clearLeadAbort(leadId) {
  const id = Number(leadId || 0);
  if (!id) return;
  const cur = activeLeadRuns.get(id);
  if (!cur) return;
  if (cur.connection) {
    cur.aborted = false;
    cur.reason = '';
    activeLeadRuns.set(id, cur);
  } else {
    activeLeadRuns.delete(id);
  }
}

function assertLeadActive(leadId) {
  const id = Number(leadId || 0);
  if (!id) return;
  const cur = activeLeadRuns.get(id);
  if (cur && cur.aborted) {
    throw new AbortError(cur.reason || '任务已暂停');
  }
}

const { parseMetricCount } = require('./parse-metric-count');

function absUrl(href) {
  const u = String(href || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u.split('?')[0];
  if (u.startsWith('//')) return `https:${u.split('?')[0]}`;
  if (u.startsWith('/')) return `https://www.tiktok.com${u.split('?')[0]}`;
  return u;
}

function profileUrlFromUsername(username) {
  const u = String(username || '').replace(/^@+/, '').trim();
  return u ? `https://www.tiktok.com/@${u}` : '';
}

async function firstVisible(page, selectors, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() && await loc.isVisible().catch(() => false)) {
          return loc;
        }
      } catch { /* next */ }
    }
    await humanPause(400, 0.2);
  }
  return null;
}

function isBrowserDisconnected(browser) {
  try {
    if (!browser) return true;
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) return true;
    return false;
  } catch {
    return true;
  }
}

/** page / connection 归一成带 page+context+browser 的导航对象，便于 safeGoto 自愈 */
function toNavConnection(pageOrConn) {
  if (!pageOrConn) return null;
  const looksLikeConn = Boolean(
    pageOrConn.browser
    || pageOrConn.context
    || (pageOrConn.page && pageOrConn.page !== pageOrConn)
  );
  const conn = looksLikeConn ? pageOrConn : { page: pageOrConn };
  if (!conn.page && conn.context) {
    try {
      conn.page = (conn.context.pages?.() || []).find((p) => p && !p.isClosed?.()) || null;
    } catch { /* ignore */ }
  }
  if (conn.page && !conn.context) {
    try { conn.context = conn.page.context?.(); } catch { /* ignore */ }
  }
  if (conn.context && !conn.browser) {
    try { conn.browser = conn.context.browser?.(); } catch { /* ignore */ }
  }
  if (!conn.browser && conn.page) {
    try { conn.browser = conn.page.context?.()?.browser?.(); } catch { /* ignore */ }
  }
  return conn;
}

async function ensureLivePage(connection) {
  if (!connection) throw new Error('无浏览器连接');
  const conn = toNavConnection(connection) || connection;
  // 把补全后的引用写回，后续重试能用到 context/browser
  if (conn !== connection) {
    connection.page = conn.page;
    connection.context = conn.context || connection.context;
    connection.browser = conn.browser || connection.browser;
  } else {
    if (conn.context && !connection.context) connection.context = conn.context;
    if (conn.browser && !connection.browser) connection.browser = conn.browser;
  }

  let page = connection.page;
  if (page && !page.isClosed?.()) return page;

  if (isBrowserDisconnected(connection.browser)) {
    const err = new Error('浏览器进程已断开（CDP 失效），需要重新打开环境');
    err.recoverable = true;
    err.code = 'BROWSER_DISCONNECTED';
    throw err;
  }

  let context = connection.context;
  if (!context) {
    try {
      context = connection.browser?.contexts?.()?.[0] || null;
    } catch {
      context = null;
    }
  }
  if (!context) {
    const err = new Error('浏览器上下文已失效');
    err.recoverable = true;
    err.code = 'CONTEXT_DEAD';
    throw err;
  }
  connection.context = context;

  try {
    const existing = (context.pages?.() || []).find((p) => p && !p.isClosed?.());
    if (existing) {
      connection.page = existing;
      await existing.bringToFront().catch(() => {});
      return existing;
    }
    const fresh = await context.newPage();
    connection.page = fresh;
    return fresh;
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/closed|Target|ECONNREFUSED|disconnected/i.test(msg)) {
      const err = new Error(`浏览器上下文已失效：${msg.slice(0, 160)}`);
      err.recoverable = true;
      err.code = 'CONTEXT_DEAD';
      err.cause = e;
      throw err;
    }
    throw e;
  }
}

function urlLooksLike(target, actual) {
  try {
    const t = new URL(target);
    const a = new URL(actual);
    if (t.hostname.replace(/^www\./, '') !== a.hostname.replace(/^www\./, '')) return false;
    if (t.pathname.includes('/search') && a.pathname.includes('/search')) return true;
    return a.pathname.startsWith(t.pathname) || a.href.startsWith(t.origin + t.pathname);
  } catch {
    return String(actual || '').includes(String(target || '').split('?')[0]);
  }
}

async function dismissSearchOverlays(page) {
  const dismissSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Allow all")',
    'button:has-text("Got it")',
    'button:has-text("允许全部")',
    'button:has-text("同意全部")',
    'button:has-text("我知道了")',
  ];
  for (const sel of dismissSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 1200 }).catch(() => {});
        await humanPause(400, 0.2);
      }
    } catch { /* ignore */ }
  }
  for (const re of [
    /^(Accept all|Accept|Allow all|I agree|Got it|OK|Agree|允许全部|同意|接受|知道了)$/i,
  ]) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 1200 }).catch(() => {});
      await humanPause(400, 0.2);
    }
  }
}

const USER_LINK_SELECTORS = [
  'div[class*="DivSearchUserItemContainer"] a[href*="/@"]',
  'div[class*="DivSearchItemContainer"] a[href*="/@"]',
  'a.link-a11y-focus[href*="/@"]',
  '[data-e2e="search-user-item"] a[href*="/@"]',
  '[data-e2e="search-user-item"]',
  'a[href*="/@"]',
];

async function countSearchUserSignals(page) {
  return page.locator(USER_LINK_SELECTORS.join(', ')).count().catch(() => 0);
}

async function clickUsersTab(page) {
  await humanPause(600, 0.15);
  for (let round = 0; round < 4; round += 1) {
    const tab = await firstVisible(page, SELECTORS.usersTab, 2500);
    if (tab) {
      await tab.click({ timeout: 5000 }).catch(() => tab.click({ force: true }).catch(() => {}));
      await humanPause(2200, 0.2);
      return true;
    }
    const byRole = page.getByRole('tab', { name: /Users|用户|帳號|账号/i }).first();
    if ((await byRole.count().catch(() => 0)) && (await byRole.isVisible().catch(() => false))) {
      await byRole.click({ timeout: 2500 }).catch(() => {});
      await humanPause(2200, 0.2);
      return true;
    }
    await humanPause(500, 0.15);
  }
  return false;
}

/**
 * 页面跳转：带重试 + URL 校验 + location.assign 兜底。
 */
async function safeGoto(connection, url, {
  accountId = 0,
  label = 'navigate',
  beforeMs = 2000,
  afterMs = 4000,
  retries = 3,
  waitUntil = 'domcontentloaded',
  timeout = 90000,
} = {}) {
  const navTimeout = scaleTimeout(timeout, 60000);
  let lastErr;
  for (let i = 1; i <= retries; i += 1) {
    try {
      let page = await ensureLivePage(connection);
      const cur0 = (() => { try { return page.url() || ''; } catch { return ''; } })();
      if (url === HOME_URL && /^https?:\/\/(www\.)?tiktok\.com\/?(\?|#|$)/i.test(cur0)) {
        connection.page = page;
        await waitPageSettled(page, {
          timeoutMs: 25000,
          label: `AI拓客 ${label}`,
          log: (m) => liveLog(m, 'info', { accountId }),
        });
        return page;
      }
      if (urlLooksLike(url, cur0) && /\/search\//i.test(cur0)) {
        connection.page = page;
        await waitPageSettled(page, {
          timeoutMs: Math.max(afterMs, 35000),
          contentSelectors: SELECTORS.searchVideoItem.concat(SELECTORS.searchUserItem),
          label: `AI拓客 ${label}`,
          log: (m) => liveLog(m, 'info', { accountId }),
        });
        return page;
      }

      liveLog(`AI拓客 ${label}: ${url}${retries > 1 ? ` (${i}/${retries})` : ''} · 超时 ${Math.round(navTimeout / 1000)}s`, 'info', { accountId });
      await humanPause(beforeMs, 0.2);
      try {
        await page.goto(url, { waitUntil, timeout: navTimeout });
      } catch (gotoErr) {
        lastErr = gotoErr;
      }

      await waitDocumentReady(page, 12000);
      await humanPause(1000, 0.15);
      page = await ensureLivePage(connection);
      let cur = (() => { try { return page.url() || ''; } catch { return ''; } })();

      if (!urlLooksLike(url, cur)) {
        await Promise.all([
          page.waitForNavigation({ waitUntil, timeout: Math.min(navTimeout, 60000) }).catch(() => null),
          page.evaluate((u) => { window.location.assign(u); }, url),
        ]);
        await humanPause(1200, 0.15);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
      }

      if (!urlLooksLike(url, cur)) {
        await page.evaluate((u) => { window.location.href = u; }, url);
        await humanPause(2500, 0.15);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
      }

      // 短链 /video/{id} 常被 TikTok 打到 /404?fromUrl=…，立刻失败以便上层换 @user 链
      if (/\/404(?:\?|$|\/)/i.test(cur) || /[?&]fromUrl=\/video\//i.test(cur)) {
        throw new Error(`导航后仍停留在 ${cur || '(空)'}`);
      }
      if (!urlLooksLike(url, cur) && !/\/search\//i.test(cur)) {
        throw new Error(`导航后仍停留在 ${cur || '(空)'}`);
      }

      await dismissSearchOverlays(page);
      await waitPageSettled(page, {
        timeoutMs: Math.max(afterMs, /\/search\//i.test(cur) ? 45000 : 25000),
        contentSelectors: /\/search\//i.test(cur)
          ? SELECTORS.searchVideoItem.concat(SELECTORS.searchUserItem)
          : ['[data-e2e]', 'main', 'header'],
        reloadOnce: i >= retries,
        label: `AI拓客 ${label}`,
        log: (m) => liveLog(m, 'info', { accountId }),
      });
      connection.page = page;
      return page;
    } catch (err) {
      lastErr = err;
      if (i < retries) await humanPause(2000, 0.2);
    }
  }
  throw lastErr || new Error(`${label} 导航失败`);
}

async function searchUsersPage(connection, keyword, accountId) {
  const raw = String(keyword || '').trim();
  const q = encodeURIComponent(raw);
  const userSearchUrl = `https://www.tiktok.com/search/user?q=${q}`;
  const generalSearchUrl = `https://www.tiktok.com/search?q=${q}`;

  let page = await ensureLivePage(connection);
  const cur0 = (() => { try { return page.url() || ''; } catch { return ''; } })();
  if (!/tiktok\.com/i.test(cur0)) {
    page = await safeGoto(connection, HOME_URL, {
      accountId,
      label: '首页预热',
      beforeMs: 1500,
      afterMs: 3500,
      retries: 2,
    });
  }

  page = await safeGoto(connection, userSearchUrl, {
    accountId,
    label: '用户搜索',
    beforeMs: 1500,
    afterMs: 6500,
    retries: 3,
  });
  await clickUsersTab(page);

  let signals = await countSearchUserSignals(page);
  if (signals < 1) {
    liveLog('AI拓客 用户搜索首屏无卡片，改试综合搜索 + Users Tab', 'warn', { accountId });
    page = await safeGoto(connection, generalSearchUrl, {
      accountId,
      label: '综合搜索',
      beforeMs: 1200,
      afterMs: 5500,
      retries: 3,
    });
    await clickUsersTab(page);
    signals = await countSearchUserSignals(page);
  }

  if (signals < 1) {
    liveLog('AI拓客 用户搜索仍无卡片，慢网刷新再等', 'warn', { accountId });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: scaleTimeout(75000, 50000) }).catch(() => {});
    await dismissSearchOverlays(page);
    await waitPageSettled(page, {
      timeoutMs: 50000,
      contentSelectors: SELECTORS.searchUserItem,
      label: 'AI拓客用户搜索',
      log: (m) => liveLog(m, 'info', { accountId }),
    });
    await clickUsersTab(page);
  }

  connection.page = page;
  return page;
}

async function searchVideosPage(connection, keyword, accountId) {
  const q = encodeURIComponent(String(keyword || '').trim());
  const videoSearchUrl = `https://www.tiktok.com/search/video?q=${q}`;
  const generalSearchUrl = `https://www.tiktok.com/search?q=${q}`;

  let page = await ensureLivePage(connection);
  page = await safeGoto(connection, videoSearchUrl, {
    accountId,
    label: '视频搜索',
    beforeMs: 1500,
    afterMs: 8000,
    retries: 3,
  });
  const tab = await firstVisible(page, SELECTORS.videosTab, 8000);
  if (tab) {
    await tab.click({ timeout: 5000 }).catch(() => tab.click({ force: true }).catch(() => {}));
    await humanPause(3000, 0.2);
  } else {
    page = await safeGoto(connection, generalSearchUrl, {
      accountId,
      label: '综合搜索(视频)',
      beforeMs: 1200,
      afterMs: 7000,
      retries: 2,
    });
    const vTab = await firstVisible(page, SELECTORS.videosTab, 8000);
    if (vTab) {
      await vTab.click({ timeout: 5000 }).catch(() => vTab.click({ force: true }).catch(() => {}));
      await humanPause(3000, 0.2);
    }
  }
  await waitPageSettled(page, {
    timeoutMs: 50000,
    contentSelectors: SELECTORS.searchVideoItem,
    reloadOnce: true,
    label: 'AI拓客视频搜索',
    log: (m) => liveLog(m, 'info', { accountId }),
  });
  connection.page = page;
  return page;
}

/**
 * 搜索页（用户/视频 Tab）下滑加载。
 * TikTok 常在内部可滚动容器里懒加载，单纯 window.wheel / End 往往滚不动列表。
 */
async function scrollSearchResults(page, {
  lastItemSelectors = [
    'a[href*="/video/"]',
    '[data-e2e="search_video-item"]',
    '[data-e2e="search-video-item"]',
    '[data-e2e="search-user-item"]',
    'div[class*="DivSearchUserItemContainer"] a[href*="/@"]',
  ],
} = {}) {
  for (const sel of lastItemSelectors) {
    const lastItem = page.locator(sel).last();
    if (await lastItem.count().catch(() => 0)) {
      await lastItem.scrollIntoViewIfNeeded().catch(() => {});
      break;
    }
  }
  await humanPause(350, 0.15);

  await page.evaluate(() => {
    const isScrollable = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      if (!/(auto|scroll|overlay)/i.test(style.overflowY || '')) return false;
      return node.scrollHeight > node.clientHeight + 40;
    };

    const findScrollParent = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        if (isScrollable(node)) return node;
        node = node.parentElement;
      }
      const hints = [
        document.querySelector('[class*="DivSearchContainer"]'),
        document.querySelector('[class*="DivItemContainerForSearch"]'),
        document.querySelector('[class*="DivBodyContainer"]'),
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
      ].filter(Boolean);
      for (const h of hints) {
        if (isScrollable(h)) return h;
      }
      let best = null;
      let bestScore = 0;
      for (const candidate of document.querySelectorAll('div, main, section')) {
        if (!isScrollable(candidate)) continue;
        const score = candidate.scrollHeight - candidate.clientHeight;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      return best || document.scrollingElement || document.documentElement;
    };

    const anchor = document.querySelector(
      'a[href*="/video/"], [data-e2e="search_video-item"], [data-e2e="search-user-item"], a[href*="/@"]'
    );
    const scrollEl = findScrollParent(anchor);
    const step = Math.max(500, Math.round((scrollEl.clientHeight || window.innerHeight || 700) * 0.85));
    scrollEl.scrollTop = Math.min(scrollEl.scrollTop + step, scrollEl.scrollHeight);
    window.scrollBy(0, step);
    try {
      scrollEl.dispatchEvent(new WheelEvent('wheel', {
        deltaY: step, bubbles: true, cancelable: true, view: window,
      }));
    } catch { /* ignore */ }
  }).catch(() => {});

  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.move(Math.floor(vp.width * 0.5), Math.floor(vp.height * 0.65)).catch(() => {});
  await page.mouse.wheel(0, 1100).catch(() => {});
  await page.keyboard.press('PageDown').catch(() => {});
  await page.keyboard.press('End').catch(() => {});
}

/**
 * 下滑加载更多。
 * 默认：每屏内容看完后再滚，间隔 5s（防封）；搜索等场景可传更短 pauseMs。
 * settleFirst：首轮滚动前先等一页内容落稳。
 */
async function scrollLoadMore(page, {
  rounds = 6,
  pauseMs = 5000,
  settleFirst = true,
  leadId = 0,
} = {}) {
  if (settleFirst) {
    await humanPause(Math.min(pauseMs, 3000), 0.15);
  }
  for (let i = 0; i < rounds; i += 1) {
    if (leadId) assertLeadActive(leadId);
    await scrollSearchResults(page);
    await humanPause(pauseMs, 0.12, leadId);
  }
}

function isManualDmTestProgress(progress, stats) {
  const phase = String(progress?.phase || '').toLowerCase();
  if (phase === 'dm_test') return true;
  if (progress?.testMode === true) return true;
  if (stats?.testMode === true) return true;
  return false;
}

async function reportProgress(leadId, progress, stats) {
  if (!leadId) return null;
  const manualDmTest = isManualDmTestProgress(progress, stats);
  if (!manualDmTest) assertLeadActive(leadId);
  let data = null;
  try {
    data = await phpApi.post(`/node/ai-leads/${leadId}/progress`, {
      progress: { ...(progress || {}), testMode: manualDmTest || progress?.testMode || undefined },
      stats: stats || undefined,
    });
  } catch (e) {
    // 网络抖动不中断；真正终止靠 aborted 标志 / 本地 abort
    liveLog(`AI拓客进度上报失败: ${e?.message || e}`, 'warn', { leadId });
    return null;
  }
  if (data && (data.aborted === true || data.abort === true)) {
    if (manualDmTest) {
      liveLog(`AI拓客 #${leadId} 手动私信测试忽略暂停中止信号`, 'warn', { leadId });
      return data;
    }
    const reason = String(data.reason || '任务已暂停');
    const cur = activeLeadRuns.get(Number(leadId)) || {};
    cur.aborted = true;
    cur.reason = reason;
    activeLeadRuns.set(Number(leadId), cur);
    throw new AbortError(reason);
  }
  return data;
}

async function saveCreator(leadId, accountId, user) {
  return phpApi.post(`/node/ai-leads/${leadId}/creators`, {
    accountId,
    ...user,
  });
}

async function saveVideo(leadId, accountId, video) {
  return phpApi.post(`/node/ai-leads/${leadId}/videos`, {
    accountId,
    ...video,
  });
}

async function filterCommentsViaAi(comments, filterPrompt) {
  if (!comments?.length) return [];
  try {
    const res = await phpApi.post('/node/ai-leads/filter-comments', {
      comments,
      prompt: filterPrompt || '',
    });
    const list = res?.comments || res?.data?.comments || res?.data?.data?.comments || [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    liveLog(`AI拓客 AI筛选失败: ${err?.message || err}`, 'warn');
    return [];
  }
}

async function saveMatchedComments(leadId, videoId, comments) {
  return phpApi.post(`/node/ai-leads/${leadId}/comments`, {
    videoId,
    comments,
    aiPass: true,
  });
}

async function finishLead(leadId, success, result) {
  await phpApi.post(`/node/ai-leads/${leadId}/finish`, { success, result }).catch(() => {});
}

function isAbortError(err) {
  return !!(err && (err.name === 'AbortError' || err.aborted === true));
}

module.exports = {
  HOME_URL,
  SELECTORS,
  delay,
  humanPause,
  AbortError,
  isAbortError,
  registerLeadRun,
  unregisterLeadRun,
  abortLeadRun,
  clearLeadAbort,
  isLeadAborted,
  assertLeadActive,
  parseMetricCount,
  parseCount: parseMetricCount,
  absUrl,
  profileUrlFromUsername,
  connectAccount,
  closeConnection,
  firstVisible,
  ensureLivePage,
  toNavConnection,
  isBrowserDisconnected,
  dismissSearchOverlays,
  countSearchUserSignals,
  safeGoto,
  searchUsersPage,
  searchVideosPage,
  scrollSearchResults,
  scrollLoadMore,
  reportProgress,
  saveCreator,
  saveVideo,
  filterCommentsViaAi,
  saveMatchedComments,
  finishLead,
  liveLog,
};
