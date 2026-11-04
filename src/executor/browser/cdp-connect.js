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

/**
 * 连接本地浏览器 CDP（比特 / 自研 Electron）。
 * - 优先 http://host:port（Playwright 官方推荐），失败再回退 ws
 * - 自研同进程环境窗使用 session partition，必须连 page ws（inProcess）
 * - 刚 open 后常出现「ws connected 但协议握手超时」，故短等 + 重试
 */
async function connectPlaywrightOverCDP(opened, {
  timeoutMs = 60000,
  retries = 3,
  settleMs = 600,
} = {}) {
  const http = String(opened?.http || opened?.httpUrl || '').trim().replace(/\/+$/, '');
  const ws = String(opened?.ws || '').trim();
  const inProcess = Boolean(opened?.inProcess);
  const opts = { timeout: Math.max(15000, Number(timeoutMs) || 60000) };
  const maxAttempts = Math.max(1, Number(retries) || 1);

  if (inProcess) {
    if (!ws) throw new Error('同进程环境窗未返回 page CDP WebSocket 地址');
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
    }
    try {
      if (inProcess) {
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
 */
async function ensurePlaywrightPage(browser, {
  timeoutMs = 45000,
  preferUrl = /tiktok\.com/i,
  allowNewPage = true,
  /** 可选：http://127.0.0.1:port，用于交叉核对 /json/list（Electron Debugger 占用时 Playwright 页列表为空） */
  httpBase = '',
} = {}) {
  let page = await waitForPlaywrightPage(browser, { timeoutMs, preferUrl });
  if (page && !page.isClosed?.()) return page;

  page = listOpenPages(browser)[0] || null;
  if (page && !page.isClosed?.()) return page;

  // 再等一小段：Electron 窗 loadURL 可能晚于 CDP 握手
  page = await waitForPlaywrightPage(browser, {
    timeoutMs: Math.min(12000, Math.max(3000, Number(timeoutMs) || 0)),
    preferUrl,
  });
  if (page && !page.isClosed?.()) return page;

  if (!allowNewPage) {
    let listHint = '';
    const base = String(httpBase || '').replace(/\/+$/, '');
    if (base) {
      try {
        const res = await fetch(`${base}/json/list`);
        const list = await res.json().catch(() => []);
        const pages = Array.isArray(list) ? list.filter((t) => t?.type === 'page') : [];
        listHint = pages.length
          ? `（CDP /json/list 有 ${pages.length} 个 page，但 Playwright 不可见——常见于 Electron debugger 未 detach）`
          : '（CDP /json/list 也无 page，窗口可能未创建成功）';
      } catch { /* ignore */ }
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
      // 再等一轮已有页（窗口可能刚挂上）
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
};
