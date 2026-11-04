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

/** 等待 CDP 上的可见 page（自研 Electron attach 可能晚于 browser 连接） */
async function waitForPlaywrightPage(browser, { timeoutMs = 30000, preferUrl = /tiktok\.com/i } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((ctx) => ctx.pages()).filter((p) => !p.isClosed());
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

module.exports = { connectPlaywrightOverCDP, waitForPlaywrightPage, wsToHttpBase };
