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
async function connectPlaywrightOverCDPRaw(opened, {
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
  // isLocal: true —— 浏览器就在本机，Playwright 才会直接传本地文件路径；
  // 否则按「远程浏览器」处理，setFiles 超过 50MB 会报 Cannot transfer files larger than 50Mb
  const opts = { timeout: Math.max(15000, Number(timeoutMs) || 60000), isLocal: true };
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

/**
 * 服务器浏览器统一的「等页面加载完整」：每次 goto / reload 返回前，
 * 先等 load 事件（最多 20 秒），再额外固定等待 TKSWARM_PAGE_SETTLE_MS（默认 20000 毫秒），
 * 让页面和 VNC 画面显示完整后才进入下一步。设为 0 可关闭固定等待。
 * 导航本身抛错时不再等待，原样抛给调用方处理。
 */
function pageSettleMs() {
  const raw = process.env.TKSWARM_PAGE_SETTLE_MS;
  if (raw === undefined || raw === '') return 20000;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 20000;
}

async function settlePage(page) {
  if (!page || page.isClosed?.()) return;
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  const ms = pageSettleMs();
  if (ms > 0 && !page.isClosed?.()) await sleep(ms);
  if (!page.isClosed?.()) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const r1 = await solveRotateCaptchaIfPresent(page);
      if (!r1?.detected) {
        const t = setTimeout(() => {
          if (!page || page.isClosed?.() || page.__tkNoCaptchaSolving) return;
          solveRotateCaptchaIfPresent(page).catch(() => {});
        }, 1200);
        t.unref?.();
      }
    } catch { /* ignore */ }
  }
}

/**
 * 确保当前 Page 的 User-Agent、HTTP Sec-CH-UA* 请求头与 JS navigator.userAgentData 完全一致，
 * 并保持 CDP Session 常驻（防止临时 WS 断开后 Chromium 重置 Emulation 回 Linux Chromium/130）。
 */
async function ensureConsistentUaAndClientHints(page, openedMeta = null) {
  if (!page || page.isClosed?.()) return;
  if (page.__tkUaConsistentPromise) {
    await page.__tkUaConsistentPromise.catch(() => {});
    return;
  }
  const meta = openedMeta || page.__tkOpenedMeta || page.context?.()?.__tkOpenedMeta || null;
  page.__tkUaConsistentPromise = (async () => {
    try {
      let ua = String(meta?.userAgent || '').trim();
      let lang = String(meta?.locale || meta?.fp?.languages || '').trim();
      if (!ua || !lang) {
        const probed = await page.evaluate(() => ({
          ua: navigator.userAgent || '',
          lang: navigator.language || 'en-US',
        })).catch(() => ({ ua: '', lang: 'en-US' }));
        if (!ua) ua = String(probed.ua || '').trim();
        if (!lang) lang = String(probed.lang || 'en-US').trim();
      }
      const ver = String(
        meta?.coreVersion
        || meta?.fp?.coreVersion
        || (ua.match(/Chrome\/(\d{2,3})/i) || [])[1]
        || '131'
      ).trim();
      const fullVer = `${ver}.0.0.0`;
      const isMac = meta?.os === 'MacIntel' || meta?.fp?.os === 'MacIntel' || /Macintosh|Mac OS X/i.test(ua);
      // 若 UA 仍残留 Linux / Electron 字样，规整为标准桌面 Chrome UA
      if (!ua || /Linux|Electron/i.test(ua)) {
        ua = isMac
          ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`
          : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
      }
      const navPlatform = isMac ? 'MacIntel' : 'Win32';
      const uaPlatform = isMac ? 'macOS' : 'Windows';
      const uaPlatformVersion = isMac ? '14.5.0' : '10.0.0';
      const primaryLang = String(lang || 'en-US').split(',')[0].trim() || 'en-US';
      const baseLang = primaryLang.split('-')[0] || 'en';
      // CDP 的 acceptLanguage 只接受不带权重的语言列表（如 en-US,en）；
      // Chromium 会自行追加 ;q=0.9，若这里再写 ;q=0.9 会发出畸形头 "en-US,en;q=0.9;q=0.9"
      const acceptLanguage = primaryLang.includes('-') && baseLang.toLowerCase() !== primaryLang.toLowerCase()
        ? `${primaryLang},${baseLang}`
        : primaryLang;
      const userAgentMetadata = {
        brands: [
          { brand: 'Not-A.Brand', version: '99' },
          { brand: 'Google Chrome', version: String(ver) },
          { brand: 'Chromium', version: String(ver) },
        ],
        fullVersionList: [
          { brand: 'Not-A.Brand', version: '99.0.0.0' },
          { brand: 'Google Chrome', version: fullVer },
          { brand: 'Chromium', version: fullVer },
        ],
        fullVersion: fullVer,
        platform: uaPlatform,
        platformVersion: uaPlatformVersion,
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      };
      const uaPatchScript = `(() => {
        try {
          const def = (obj, key, val) => {
            try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch (e) {}
          };
          const ua = ${JSON.stringify(ua)};
          const appVer = ua.replace(/^Mozilla\\//i, '');
          const navPlat = ${JSON.stringify(navPlatform)};
          const uaPlat = ${JSON.stringify(uaPlatform)};
          const uaPlatVer = ${JSON.stringify(uaPlatformVersion)};
          const ver = ${JSON.stringify(ver)};
          const fullVer = ${JSON.stringify(fullVer)};
          def(Navigator.prototype, 'webdriver', false);
          def(Navigator.prototype, 'userAgent', ua);
          def(Navigator.prototype, 'appVersion', appVer);
          def(Navigator.prototype, 'vendor', 'Google Inc.');
          def(Navigator.prototype, 'platform', navPlat);
          try { delete navigator.webdriver; } catch (e) {}
          try { delete navigator.userAgent; } catch (e) {}
          try { delete navigator.platform; } catch (e) {}
          const brands = Object.freeze([
            Object.freeze({ brand: 'Not-A.Brand', version: '99' }),
            Object.freeze({ brand: 'Google Chrome', version: ver }),
            Object.freeze({ brand: 'Chromium', version: ver }),
          ]);
          const fullVersionList = Object.freeze([
            Object.freeze({ brand: 'Not-A.Brand', version: '99.0.0.0' }),
            Object.freeze({ brand: 'Google Chrome', version: fullVer }),
            Object.freeze({ brand: 'Chromium', version: fullVer }),
          ]);
          const highEntropyMap = {
            architecture: 'x86',
            bitness: '64',
            brands,
            formFactors: ['Desktop'],
            fullVersionList,
            mobile: false,
            model: '',
            platform: uaPlat,
            platformVersion: uaPlatVer,
            uaFullVersion: fullVer,
            wow64: false,
          };
          const uaDataObj = {
            get brands() { return brands; },
            get mobile() { return false; },
            get platform() { return uaPlat; },
            toJSON() { return { brands, mobile: false, platform: uaPlat }; },
            getHighEntropyValues(hints) {
              const out = { brands, mobile: false, platform: uaPlat };
              if (Array.isArray(hints)) {
                for (const h of hints) {
                  if (h in highEntropyMap) out[h] = highEntropyMap[h];
                }
              }
              return Promise.resolve(out);
            },
          };
          if (typeof NavigatorUAData === 'function' && NavigatorUAData.prototype) {
            try { Object.setPrototypeOf(uaDataObj, NavigatorUAData.prototype); } catch (e) {}
          }
          def(Navigator.prototype, 'userAgentData', uaDataObj);
          try { delete navigator.userAgentData; } catch (e) {}
          if (navigator.userAgentData !== uaDataObj) def(navigator, 'userAgentData', uaDataObj);
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = {};
        } catch (e) {}
      })();`;

      const ctx = page.context?.();
      if (ctx) {
        const cdp = await ctx.newCDPSession(page).catch(() => null);
        if (cdp) {
          page.__tkUaCdpSession = cdp;
          const uaParams = {
            userAgent: ua,
            acceptLanguage,
            platform: navPlatform,
            userAgentMetadata,
          };
          await cdp.send('Emulation.setUserAgentOverride', uaParams).catch(() => {});
          await cdp.send('Network.setUserAgentOverride', uaParams).catch(() => {});
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: uaPatchScript }).catch(() => {});
        }
      }
      await page.addInitScript(uaPatchScript).catch(() => {});
      await page.evaluate(uaPatchScript).catch(() => {});
    } catch { /* ignore */ }
  })();
  await page.__tkUaConsistentPromise.catch(() => {});
}

function installPageSettle(page) {
  if (!page) return page;
  try {
    const { attachAutoRotateCaptchaWatcher } = require('./nocaptchaai');
    attachAutoRotateCaptchaWatcher(page);
  } catch { /* ignore */ }
  ensureConsistentUaAndClientHints(page).catch(() => {});
  if (page.__tkSettleInstalled) return page;
  page.__tkSettleInstalled = true;
  for (const method of ['goto', 'reload']) {
    const orig = typeof page[method] === 'function' ? page[method].bind(page) : null;
    if (!orig) continue;
    page[method] = async (...args) => {
      await ensureConsistentUaAndClientHints(page).catch(() => {});
      const result = await orig(...args);
      await settlePage(page).catch(() => {});
      return result;
    };
  }
  return page;
}

function installBrowserPageSettle(browser, opened = null) {
  try {
    if (opened) browser.__tkOpenedMeta = opened;
    for (const ctx of browser.contexts()) {
      if (opened) ctx.__tkOpenedMeta = opened;
      ctx.pages().forEach((p) => {
        if (opened) p.__tkOpenedMeta = opened;
        installPageSettle(p);
      });
      if (!ctx.__tkSettleInstalled) {
        ctx.__tkSettleInstalled = true;
        ctx.on('page', (p) => {
          if (opened) p.__tkOpenedMeta = opened;
          installPageSettle(p);
        });
      }
    }
  } catch { /* ignore */ }
  return browser;
}

async function connectPlaywrightOverCDP(opened, options) {
  const browser = await connectPlaywrightOverCDPRaw(opened, options);
  return installBrowserPageSettle(browser, opened);
}

async function ensurePlaywrightPage(browser, options) {
  const page = await ensurePlaywrightPageRaw(browser, options);
  if (browser?.__tkOpenedMeta && page) page.__tkOpenedMeta = browser.__tkOpenedMeta;
  installPageSettle(page);
  await ensureConsistentUaAndClientHints(page, browser?.__tkOpenedMeta || null).catch(() => {});
  return page;
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
async function ensurePlaywrightPageRaw(browser, {
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
          isLocal: true,
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
