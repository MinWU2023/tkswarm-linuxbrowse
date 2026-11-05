const { chromium } = require('playwright-core');

function wsToHttpBase(ws) {
  return String(ws || '').trim().replace(/^ws:/i, 'http:').replace(/\/devtools\/.*$/i, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableCdpError(err) {
  const msg = String(err?.message || err || '');
  return /timeout|Timeout|ECONNREFUSED|ECONNRESET|closed|Target closed|WebSocket|CDP|browser has been closed/i.test(msg);
}

function isCreateTargetUnsupported(err) {
  const msg = String(err?.message || err || '');
  return /Not supported|createTarget|Target\.createTarget/i.test(msg);
}

async function fetchJsonList(httpBase) {
  const base = String(httpBase || '').replace(/\/+$/, '');
  if (!base) return [];
  try {
    const res = await fetch(`${base}/json/list`);
    const list = await res.json().catch(() => []);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 从 /json/list 取最新 page 级 webSocketDebuggerUrl */
async function resolvePageWs(httpBase, fallbackWs = '') {
  const list = await fetchJsonList(httpBase);
  const pages = list.filter((t) => t?.type === 'page' && t?.webSocketDebuggerUrl);
  const preferred = pages.find((t) => /tiktok\.com/i.test(String(t.url || '')))
    || pages.find((t) => t.url && !/^about:/i.test(String(t.url || '')))
    || pages[0];
  return preferred?.webSocketDebuggerUrl || String(fallbackWs || '').trim() || '';
}

/**
 * 连接本地浏览器 CDP（比特 / 自研 Electron）。
 * - 优先 http://host:port（Playwright 官方推荐），失败再回退 ws
 * - Electron / 同进程：必须连 page 级 ws（browser 级常导致 contexts/pages 为空）
 * - 刚 open 后常出现「ws connected 但协议握手超时」，故短等 + 重试
 */
async function connectPlaywrightOverCDP(opened, {
  timeoutMs = 60000,
  retries = 3,
  settleMs = 600,
} = {}) {
  const http = String(opened?.http || opened?.httpUrl || '').trim().replace(/\/+$/, '');
  let ws = String(opened?.ws || '').trim();
  const inProcess = Boolean(opened?.inProcess);
  const preferPageWs = Boolean(
    opened?.preferPageWs
    || inProcess
    || String(opened?.engine || '').toLowerCase() === 'electron'
  );
  const opts = { timeout: Math.max(15000, Number(timeoutMs) || 60000) };
  const maxAttempts = Math.max(1, Number(retries) || 1);

  if (preferPageWs && http) {
    const pageWs = await resolvePageWs(http, ws);
    if (pageWs) ws = pageWs;
  }

  if (inProcess || preferPageWs) {
    if (!ws) throw new Error('Electron/同进程环境未返回 page CDP WebSocket 地址');
  } else {
    const endpoint = http || wsToHttpBase(ws);
    if (!endpoint && !ws) throw new Error('本地浏览器未返回 CDP 地址');
  }

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt === 1 && settleMs > 0) {
      await sleep(settleMs);
    } else if (attempt > 1) {
      await sleep(700 * attempt);
      // 重试前刷新 page ws（注入/导航后 target id 可能变）
      if (preferPageWs && http) {
        const fresh = await resolvePageWs(http, ws);
        if (fresh) ws = fresh;
      }
    }
    try {
      if (inProcess || preferPageWs) {
        return await chromium.connectOverCDP(ws, opts);
      }
      const endpoint = http || wsToHttpBase(ws);
      try {
        return await chromium.connectOverCDP(endpoint, opts);
      } catch (first) {
        if (!ws || ws === endpoint) throw first;
        return await chromium.connectOverCDP(ws, opts);
      }
    } catch (err) {
      lastErr = err;
      if (!isRetryableCdpError(err) || attempt >= maxAttempts) {
        const tip = '（可检查：自研浏览器是否卡住/弹窗未关、代理是否可用；稍后重试或强制重开环境）';
        const msg = String(err?.message || err || 'CDP 连接失败');
        const wrapped = new Error(
          attempt > 1
            ? `连接浏览器 CDP 失败（第 ${attempt} 次）：${msg} ${tip}`
            : `${msg} ${tip}`
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
  }
  throw lastErr || new Error('连接浏览器 CDP 失败');
}

function listOpenPages(browser) {
  try {
    return browser.contexts().flatMap((ctx) => ctx.pages()).filter((p) => !p.isClosed?.());
  } catch {
    return [];
  }
}

/** 等待 CDP 上的可见 page（自研 Electron attach 可能晚于 browser 连接） */
async function waitForPlaywrightPage(browser, { timeoutMs = 30000, preferUrl = /tiktok\.com/i } = {}) {
  const deadline = Date.now() + Math.max(3000, Number(timeoutMs) || 30000);
  while (Date.now() < deadline) {
    const pages = listOpenPages(browser);
    const preferred = pages.find((p) => preferUrl.test(String(p.url() || '')));
    const visible = pages.find((p) => {
      const url = String(p.url() || '');
      return url && !/^about:/i.test(url);
    });
    if (preferred || visible || pages[0]) return preferred || visible || pages[0];
    await sleep(250);
  }
  return null;
}

/**
 * 取得可用 Page。Electron CDP 不支持 Target.createTarget，禁止依赖 newPage()。
 * 比特等 Chromium 在无页时可回退 newPage。
 * @returns {Promise<{ page: import('playwright-core').Page, browser?: any }>}
 * 兼容旧调用：若只拿 Page，仍返回 Page；内部失败时抛错。
 */
async function ensurePlaywrightPage(browser, {
  timeoutMs = 45000,
  preferUrl = /tiktok\.com/i,
  allowNewPage = true,
  httpBase = '',
  /** 若 browser 级连接看不到页，允许用 page ws 重连并替换 */
  allowPageWsReconnect = true,
} = {}) {
  let page = await waitForPlaywrightPage(browser, { timeoutMs: Math.min(8000, timeoutMs), preferUrl });
  if (page && !page.isClosed?.()) return page;

  page = listOpenPages(browser)[0] || null;
  if (page && !page.isClosed?.()) return page;

  // Electron：browser 连接无页时，改连 /json/list 的 page ws（与桌面 inProcess 一致）
  if (!allowNewPage && allowPageWsReconnect && httpBase) {
    // 候选端点：Playwright 的 connectOverCDP 要 browser 级端点（http 或 /json/version 的 browser ws），
    // page 级 ws 常导致 contexts()/pages() 为空；因此先试 browser 级，最后才回退 page ws。
    const base = String(httpBase).replace(/\/+$/, '');
    const candidates = [base];
    try {
      const ver = await (await fetch(`${base}/json/version`)).json();
      if (ver?.webSocketDebuggerUrl) candidates.push(String(ver.webSocketDebuggerUrl));
    } catch { /* ignore */ }
    const pageWs = await resolvePageWs(httpBase);
    if (pageWs) candidates.push(pageWs);
    for (const endpoint of candidates) {
      try {
        const alt = await chromium.connectOverCDP(endpoint, {
          timeout: Math.max(15000, Number(timeoutMs) || 45000),
        });
        page = await waitForPlaywrightPage(alt, {
          timeoutMs: Math.min(12000, Math.max(5000, Number(timeoutMs) || 0)),
          preferUrl,
        });
        if (page && !page.isClosed?.()) {
          // 挂上替代 browser，供调用方后续 close（若需要）
          page._tkswarmAltBrowser = alt;
          return page;
        }
        await alt.close().catch(() => {});
      } catch { /* try next endpoint */ }
    }
  }

  page = await waitForPlaywrightPage(browser, {
    timeoutMs: Math.max(5000, Number(timeoutMs) || 45000),
    preferUrl,
  });
  if (page && !page.isClosed?.()) return page;

  if (!allowNewPage) {
    let listHint = '';
    const base = String(httpBase || '').replace(/\/+$/, '');
    if (base) {
      const list = await fetchJsonList(base);
      const pages = list.filter((t) => t?.type === 'page');
      listHint = pages.length
        ? `（CDP /json/list 有 ${pages.length} 个 page，但 Playwright 不可见——请确认已用 page 级 ws 连接）`
        : '（CDP /json/list 也无 page，窗口可能未创建成功或立刻退出）';
    }
    throw Object.assign(
      new Error(`Electron 环境未出现可用页面（不支持 CDP 新建页）。请确认有头窗口已启动且未立刻退出${listHint}`),
      { code: 'NO_PAGE_ELECTRON' }
    );
  }

  const context = browser.contexts()[0] || null;
  if (!context) {
    try {
      const ctx = await browser.newContext();
      return await ctx.newPage();
    } catch (e) {
      if (isCreateTargetUnsupported(e)) {
        throw Object.assign(
          new Error(`Electron 不支持新建上下文/页面：${e.message || e}`),
          { code: 'CREATE_TARGET_UNSUPPORTED' }
        );
      }
      throw e;
    }
  }
  try {
    return await context.newPage();
  } catch (e) {
    if (isCreateTargetUnsupported(e)) {
      page = await waitForPlaywrightPage(browser, { timeoutMs: 15000, preferUrl });
      if (page) return page;
      throw Object.assign(
        new Error(`Electron 不支持 CDP newPage（Target.createTarget Not supported），且未找到已有页面`),
        { code: 'CREATE_TARGET_UNSUPPORTED' }
      );
    }
    throw e;
  }
}

module.exports = {
  connectPlaywrightOverCDP,
  waitForPlaywrightPage,
  ensurePlaywrightPage,
  listOpenPages,
  wsToHttpBase,
  isCreateTargetUnsupported,
  resolvePageWs,
  fetchJsonList,
};
