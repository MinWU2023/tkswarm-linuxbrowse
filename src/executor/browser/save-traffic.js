/**
 * 省流模式：拦截图片/视频/音频/字体/广告/SVG 图标等非必要资源，降低带宽与内存占用。
 * 挂在 BrowserContext 上，覆盖该环境内所有 Page。
 *
 * 例外：人机验证 / 滑块拼图相关资源一律放行，否则人工无法处理验证弹框。
 */

const BLOCK_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/** 人机验证 / 安全校验资源：永不拦截（含拼图底图、滑块块、验证码图、校验接口、样式与字体） */
const ALLOW_URL_RE = [
  /captcha/i,
  /\/verify(?:\/|$|\?)/i,
  /verify[-_]?center/i,
  /verify[-_]?image/i,
  /verification/i,
  /secsdk/i,
  /security[-_]?check/i,
  /slide[-_]?verify/i,
  /slider/i,
  /puzzle/i,
  /whirl/i,
  /rotate[-_]?verify/i,
  /rc[-_]?captcha/i,
  /geetest/i,
  /hcaptcha/i,
  /recaptcha/i,
  /arkose/i,
  /funcaptcha/i,
  /(?:^|\.)byteoversea\.com\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk|tos-|obj\/)/i,
  /(?:^|\.)(?:ibyteimg|byteimg|ibytedtos|ttwstatic)\.com\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk|tos-|obj\/|eden)/i,
  /p\d+-(?:rc-)?cap(?:tcha)?/i,
  /p\d+-security/i,
  /sf\d+-(?:website-login|secsdk|captcha)/i,
  /captcha[-.].*\.(?:tiktok|bytedance|byteoversea|tiktokv|capcut)/i,
  /verification[-.].*\.(?:tiktok|byte|tiktokv|capcut)/i,
  /tiktokcdn[^/]*\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk|eden|tos-)/i,
  /rc[-_]?verification/i,
  /secsdk-captcha/i,
  /get_captcha|check_captcha|verify_captcha/i,
];

const CAPTCHA_FRAME_URL_RE = /captcha|verify[-_]?center|verification|secsdk|security[-_]?check|rc[-_]?captcha|rc[-_]?verification|whirl|puzzle|geetest|hcaptcha|recaptcha|arkose|p\d+-(?:rc-)?cap|get_captcha|verify_captcha/i;

/** 广告 / 追踪 / 图标字体 / 媒体等 URL 特征 */
const BLOCK_URL_RE = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.net\/.*\/fbevents/i,
  /adservice\./i,
  /\/ads?[/?]/i,
  /pagead/i,
  /pixel\./i,
  /analytics\./i,
  /hotjar\.com/i,
  /sentry\.io/i,
  /\.woff2?(?:\?|$)/i,
  /\.ttf(?:\?|$)/i,
  /\.otf(?:\?|$)/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /avatar/i,
  /profile[_-]?pic/i,
  /\/icon[s]?\//i,
  /favicon/i,
  /\.svg(?:\?|$|#)/i,
  /\/svg(?:\/|$|\?)/i,
  /image\/svg\+xml/i,
  /format=svg/i,
  /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)(?:\?|$)/i,
  /\.(?:mp4|webm|m4v|mov|avi|mkv|mp3|wav|ogg|m4a|aac)(?:\?|$)/i,
];

/**
 * 全站隐藏 SVG 图标（仅透明，不改宽高，避免点视频失效）。
 * 验证码区域强制可见。
 */
const HIDE_SVG_CSS = `
/* tkswarm save-traffic: hide ALL page SVGs visually */
svg, svg * {
  opacity: 0 !important;
  fill-opacity: 0 !important;
  stroke-opacity: 0 !important;
}
img[src*=".svg" i],
img[src^="data:image/svg" i],
img[src*="image/svg" i],
svg image {
  opacity: 0 !important;
}
/* 人机验证弹框内必须可见 */
#captcha-verify-container svg,
#captcha-verify-container svg *,
.captcha_verify_container svg,
.captcha_verify_container svg *,
[id*="captcha" i] svg,
[id*="captcha" i] svg *,
[class*="captcha" i] svg,
[class*="captcha" i] svg *,
[class*="Captcha"] svg,
[class*="Captcha"] svg *,
[id*="verify" i] svg,
[id*="verify" i] svg *,
[class*="verify" i] svg,
[class*="verify" i] svg *,
[class*="secsdk" i] svg,
[class*="secsdk" i] svg *,
[id*="secsdk" i] svg,
[id*="secsdk" i] svg *,
[class*="cap-"] svg,
[class*="cap-"] svg *,
[aria-label*="captcha" i] svg,
[aria-label*="verify" i] svg,
.TUXModal svg,
.TUXModal svg *,
[role="dialog"] svg,
[role="dialog"] svg *,
#captcha-verify-container img,
.captcha_verify_container img,
[id*="captcha" i] img,
[class*="captcha" i] img,
[id*="verify" i] img,
[class*="verify" i] img,
[class*="secsdk" i] img,
[id*="secsdk" i] img,
[class*="cap-"] img,
.TUXModal img,
[role="dialog"] img {
  opacity: 1 !important;
  fill-opacity: 1 !important;
  stroke-opacity: 1 !important;
  visibility: visible !important;
}
`.trim();

const CAPTCHA_CLOSEST = '#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="Captcha"], [id*="verify" i], [class*="verify" i], [class*="secsdk" i], [id*="secsdk" i], [class*="cap-"], .TUXModal, [role="dialog"]';

function parseSaveTrafficFlag(raw, defaultValue = false) {
  if (raw === undefined || raw === null || raw === '') return !!defaultValue;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'null' || s === 'undefined') return !!defaultValue;
  if (['1', 'true', 'yes', 'on', '开启'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', '关闭'].includes(s)) return false;
  return !!defaultValue;
}

function isAllowedCaptchaUrl(url) {
  return ALLOW_URL_RE.some((re) => re.test(url));
}

function isSvgLikeUrl(url) {
  return (
    /\.svg(?:\?|$|#)/i.test(url)
    || /\/svg(?:\/|$|\?)/i.test(url)
    || /image\/svg\+xml/i.test(url)
    || /format=svg(?:&|$)/i.test(url)
  );
}

/**
 * 本地壳 / 诊断页 / 非 http(s)：省流一律不拦、不注入。
 * Playwright 对 data: 调 route.continue() 会把 HTML 渲成纯文本（整页 CSS 原文「乱码」）。
 */
function isShellOrLocalUrl(url) {
  const u = String(url || '');
  if (!u) return true;
  if (/^(data:|blob:|about:|file:|chrome:|chrome-error:|devtools:|edge:)/i.test(u)) return true;
  if (/env-shell\.html|env-.*-status\.html|加载诊断|环境窗口/i.test(u)) return true;
  return false;
}

/** 仅对 http(s) 远端资源启用省流路由 */
function saveTrafficUrlFilter(url) {
  try {
    const href = typeof url === 'string' ? url : String(url?.href || url || '');
    if (isShellOrLocalUrl(href)) return false;
    return /^https?:\/\//i.test(href);
  } catch {
    return false;
  }
}

function isRequestFromCaptchaBypassOrFrame(request) {
  try {
    const headers = typeof request?.headers === 'function' ? request.headers() : (request?.headers || {});
    const ref = String(headers?.referer || headers?.referrer || headers?.origin || '');
    if (ref && CAPTCHA_FRAME_URL_RE.test(ref)) return true;

    const frame = typeof request?.frame === 'function' ? request.frame() : null;
    if (frame) {
      const fUrl = String(frame.url?.() || '');
      if (fUrl && CAPTCHA_FRAME_URL_RE.test(fUrl)) return true;
      const page = typeof frame.page === 'function' ? frame.page() : null;
      const pUrl = String(page?.url?.() || '');
      if (pUrl && CAPTCHA_FRAME_URL_RE.test(pUrl)) return true;
      if (page?.__tkNoCaptchaSolving) return true;
      const ctx = typeof page?.context === 'function' ? page.context() : null;
      if (ctx) {
        if (!ctx.__saveTrafficEnabled) return true;
        if (ctx.__saveTrafficCaptchaBypass) {
          // 防止极端情况下 bypass 一直卡住：仅当超过 120s 且没有正在求解才自动过期
          const age = Date.now() - Number(ctx.__saveTrafficCaptchaBypassAt || 0);
          if (age < 120000 || page?.__tkNoCaptchaSolving) return true;
          ctx.__saveTrafficCaptchaBypass = false;
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

async function hasCaptchaModalInDomCached(page) {
  if (!page || page.isClosed?.()) return false;
  if (page.__tkNoCaptchaSolving) return true;
  const now = Date.now();
  const cached = page.__tkCaptchaDomBypassCache;
  if (cached && now - cached.at < 260) {
    return cached.active;
  }
  const active = await page.evaluate(() => {
    try {
      const sels = [
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
        '#captcha_slide_button',
        'img[data-e2e="captcha-whirl-outer"]',
        'img[data-e2e="captcha-whirl-inner"]',
      ];
      for (const s of sels) {
        const nodes = document.querySelectorAll(s);
        for (const el of nodes) {
          const st = window.getComputedStyle?.(el);
          if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
          const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
          if (r.width > 8 && r.height > 8) return true;
        }
      }
      const dialogs = document.querySelectorAll('.TUXModal, [role="dialog"]');
      for (const d of dialogs) {
        const st = window.getComputedStyle?.(d);
        if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
        const r = d.getBoundingClientRect?.() || { width: 0, height: 0 };
        if (r.width <= 40 || r.height <= 40) continue;
        const txt = String(d.innerText || '');
        const cls = `${d.id || ''} ${d.className || ''}`;
        if (
          /captcha|secsdk|verify/i.test(cls)
          || /drag the slider|fit the puzzle|verify to continue|verify you are human|拖动滑块|完成拼图|旋转|安全验证|人机验证/i.test(txt)
          || d.querySelector('[class*="cap-"], [class*="captcha" i], [id*="captcha" i], [class*="secsdk" i]')
        ) {
          return true;
        }
      }
    } catch {}
    return false;
  }).catch(() => false);
  page.__tkCaptchaDomBypassCache = { at: Date.now(), active };
  return active;
}

function shouldAbortRequest(request) {
  const url = String(request.url?.() || request.url || '');
  if (!url || isShellOrLocalUrl(url)) {
    return false;
  }
  if (isRequestFromCaptchaBypassOrFrame(request)) {
    return false;
  }
  if (isAllowedCaptchaUrl(url)) return false;

  // data:image/svg 常被用作图标，省流时拦截；其它 data: 已由 isShellOrLocalUrl 放行
  if (/^data:image\/svg\+xml/i.test(url) || /^data:image\/svg/i.test(url)) {
    return true;
  }

  const type = String(request.resourceType?.() || request.resourceType || '').toLowerCase();
  // 主文档/子框架/长连接绝不 abort（避免验证 iframe 或页面白屏）
  if (type === 'document' || type === 'websocket' || type === 'eventsource') return false;
  // 脚本/样式/接口请求不按 URL 关键字拦（avatar、icon、analytics 等会误伤站点 JS 分包和 API，导致页面白屏）
  if (['script', 'stylesheet', 'xhr', 'fetch', 'manifest', 'texttrack'].includes(type)) return false;
  if (BLOCK_RESOURCE_TYPES.has(type)) return true;
  if (isSvgLikeUrl(url)) return true;
  return BLOCK_URL_RE.some((re) => re.test(url));
}

async function saveTrafficRouteHandler(route, request) {
  try {
    const req = request || route.request();
    const url = String(req.url?.() || req.url || '');
    // 双保险：即使误挂到本地 URL，也绝不 continue/abort 主壳
    if (isShellOrLocalUrl(url)) {
      try {
        await route.fallback();
      } catch {
        try { await route.continue(); } catch { /* ignore */ }
      }
      return;
    }

    // 检测到人机验证脚本/接口/iframe 请求时，立刻同步开启验证码旁路并移除隐藏样式，确保随后的拼图图片永不被拦截
    const frame = typeof req.frame === 'function' ? req.frame() : null;
    const page = typeof frame?.page === 'function' ? frame.page() : null;
    const ctx = typeof page?.context === 'function' ? page.context() : null;
    if (CAPTCHA_FRAME_URL_RE.test(url)) {
      if (ctx && ctx.__saveTrafficEnabled) {
        ctx.__saveTrafficDesired = true;
        ctx.__saveTrafficCaptchaBypass = true;
        ctx.__saveTrafficCaptchaBypassAt = Date.now();
        if (page) removeHideSvgOnPage(page).catch(() => {});
      }
      await route.continue().catch(() => route.fallback().catch(() => {}));
      return;
    }

    if (shouldAbortRequest(req)) {
      // 兜底检查：若当前页面 DOM 已经挂出人机验证弹框，即使图片走随机哈希 CDN URL 也绝不拦截
      if (page && await hasCaptchaModalInDomCached(page)) {
        if (ctx && ctx.__saveTrafficEnabled) {
          ctx.__saveTrafficDesired = true;
          ctx.__saveTrafficCaptchaBypass = true;
          ctx.__saveTrafficCaptchaBypassAt = Date.now();
          removeHideSvgOnPage(page).catch(() => {});
        }
        await route.continue().catch(() => route.fallback().catch(() => {}));
        return;
      }
      await route.abort('blockedbyclient');
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    await route.continue();
  } catch {
    // continue 失败时勿 abort 文档，交给浏览器默认处理
    try {
      await route.fallback();
    } catch { /* ignore */ }
  }
}

/** 浏览器内执行：注入 CSS + 直接改 SVG 样式 + MutationObserver */
function buildHideSvgInjector() {
  // 作为字符串注入，避免 Playwright 序列化丢失
  return `(() => {
    try {
      const href = String(location.href || '');
      if (/^(data:|blob:|about:|file:|chrome:|chrome-error:)/i.test(href)) return;
      if (!/^https?:/i.test(href)) return;
      if (/captcha|verify|secsdk|whirl|puzzle|rc-verification/i.test(href)) return;
      if (window.__tkSaveTrafficSvgDisabled) return;
    } catch { return; }
    const CSS = ${JSON.stringify(HIDE_SVG_CSS)};
    const CAP = ${JSON.stringify(CAPTCHA_CLOSEST)};
    try {
      const head = document.head;
      if (!head) return;
      let style = document.getElementById('tkswarm-save-traffic-svg');
      if (!style) {
        style = document.createElement('style');
        style.id = 'tkswarm-save-traffic-svg';
        head.appendChild(style);
      }
      style.textContent = CSS;

      const hideOne = (el) => {
        try {
          if (!el || !el.style || window.__tkSaveTrafficSvgDisabled) return;
          if (el.closest && el.closest(CAP)) {
            el.style.setProperty('opacity', '1', 'important');
            return;
          }
          el.setAttribute('data-tk-svg-hidden', '1');
          el.style.setProperty('opacity', '0', 'important');
        } catch {}
      };

      const sweep = () => {
        try {
          if (window.__tkSaveTrafficSvgDisabled) return;
          document.querySelectorAll('svg').forEach(hideOne);
          document.querySelectorAll('img[src*=".svg" i], img[src^="data:image/svg" i]').forEach(hideOne);
        } catch {}
      };
      sweep();

      if (!window.__tkSaveTrafficSvgObs) {
        let t = 0;
        window.__tkSaveTrafficSvgObs = new MutationObserver(() => {
          if (window.__tkSaveTrafficSvgDisabled || t) return;
          t = setTimeout(() => { t = 0; sweep(); }, 80);
        });
        try {
          window.__tkSaveTrafficSvgObs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'class', 'style'],
          });
        } catch {}
      }
      if (!window.__tkSaveTrafficSvgTimer) {
        window.__tkSaveTrafficSvgTimer = setInterval(sweep, 1500);
      }
    } catch {}
  })()`;
}

async function removeHideSvgOnPage(page) {
  if (!page || page.isClosed?.()) return;
  try {
    const href = String(page.url?.() || '');
    if (isShellOrLocalUrl(href)) return;
  } catch { /* ignore */ }
  await page.evaluate(() => {
    try {
      window.__tkSaveTrafficSvgDisabled = true;
      if (window.__tkSaveTrafficSvgTimer) {
        clearInterval(window.__tkSaveTrafficSvgTimer);
        window.__tkSaveTrafficSvgTimer = null;
      }
      if (window.__tkSaveTrafficSvgObs) {
        try { window.__tkSaveTrafficSvgObs.disconnect(); } catch {}
        window.__tkSaveTrafficSvgObs = null;
      }
      const st = document.getElementById('tkswarm-save-traffic-svg');
      if (st) st.remove();
      document.querySelectorAll('[data-tk-svg-hidden]').forEach((el) => {
        try {
          el.style.removeProperty('opacity');
          el.removeAttribute('data-tk-svg-hidden');
        } catch {}
      });
    } catch {}
  }).catch(() => {});
}

async function injectHideSvgOnPage(page) {
  if (!page || page.isClosed?.()) return;
  try {
    const href = String(page.url?.() || '');
    if (isShellOrLocalUrl(href) || CAPTCHA_FRAME_URL_RE.test(href)) return;
    const ctx = page.context?.();
    if (ctx && (ctx.__saveTrafficCaptchaBypass || !ctx.__saveTrafficEnabled)) return;
  } catch { /* ignore */ }
  await page.evaluate(() => { try { window.__tkSaveTrafficSvgDisabled = false; } catch {} }).catch(() => {});
  const src = buildHideSvgInjector();
  try {
    await page.evaluate(src);
  } catch {
    try {
      await page.evaluate((css, cap) => {
        if (/^(data:|blob:|about:|file:)/i.test(String(location.href || ''))) return;
        const head = document.head;
        if (!head) return;
        let style = document.getElementById('tkswarm-save-traffic-svg');
        if (!style) {
          style = document.createElement('style');
          style.id = 'tkswarm-save-traffic-svg';
          head.appendChild(style);
        }
        style.textContent = css;
        document.querySelectorAll('svg').forEach((el) => {
          if (el.closest && el.closest(cap)) {
            el.style.setProperty('opacity', '1', 'important');
          } else {
            el.style.setProperty('opacity', '0', 'important');
          }
        });
      }, HIDE_SVG_CSS, CAPTCHA_CLOSEST);
    } catch { /* ignore */ }
  }
}

function attachCaptchaBypassResponseHook(page, context) {
  if (!page || !context || page.__tkSaveTrafficCaptchaRespHooked) return;
  page.__tkSaveTrafficCaptchaRespHooked = true;
  const onResp = (resp) => {
    try {
      const url = String(resp?.url?.() || '');
      if (!url) return;
      if (CAPTCHA_FRAME_URL_RE.test(url) || /p\d+-(?:rc-)?captcha|p\d+-security|get_captcha|verify_captcha/i.test(url)) {
        if (context.__saveTrafficEnabled) {
          context.__saveTrafficDesired = true;
          context.__saveTrafficCaptchaBypass = true;
          context.__saveTrafficCaptchaBypassAt = Date.now();
          removeHideSvgOnPage(page).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  };
  page.on?.('response', onResp);
  page.once?.('close', () => {
    try { page.off?.('response', onResp); } catch { /* ignore */ }
  });
}

async function ensureHideSvgStyle(context) {
  if (!context) return;

  const hookPageSvg = (page) => {
    if (!page) return;
    attachCaptchaBypassResponseHook(page, context);
    if (page.__tkSaveTrafficSvgHooked) return;
    page.__tkSaveTrafficSvgHooked = true;
    const syncSvgState = () => {
      if (context.__saveTrafficEnabled && !context.__saveTrafficCaptchaBypass) {
        injectHideSvgOnPage(page).catch(() => {});
      } else {
        removeHideSvgOnPage(page).catch(() => {});
      }
    };
    page.on('domcontentloaded', syncSvgState);
    page.on('load', syncSvgState);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) syncSvgState();
    });
  };

  // 已打开页面立刻注入，并在导航后按实时状态同步
  try {
    for (const page of context.pages?.() || []) {
      hookPageSvg(page);
      await injectHideSvgOnPage(page);
    }
  } catch { /* ignore */ }

  // 新 page 打开时也挂钩
  if (!context.__saveTrafficPageHook) {
    context.__saveTrafficPageHook = true;
    try {
      context.on('page', (page) => {
        hookPageSvg(page);
        if (context.__saveTrafficEnabled && !context.__saveTrafficCaptchaBypass) {
          injectHideSvgOnPage(page).catch(() => {});
        }
      });
    } catch { /* ignore */ }
  }
}

/**
 * 在 context 上开启或关闭省流拦截。可重复调用以切换。
 * @param {import('playwright').BrowserContext|null|undefined} context
 * @param {boolean} enabled
 */
async function applySaveTraffic(context, enabled) {
  if (!context) return { ok: false, enabled: false };
  const on = !!enabled;
  const prev = context.__saveTrafficEnabled;
  const handler = context.__saveTrafficHandler;
  const filter = context.__saveTrafficUrlFilter || saveTrafficUrlFilter;

  if (handler) {
    try {
      await context.unroute(filter, handler);
    } catch {
      try {
        await context.unroute(filter);
      } catch {
        try { await context.unroute('**/*', handler); } catch { /* ignore */ }
      }
    }
    context.__saveTrafficHandler = null;
    context.__saveTrafficUrlFilter = null;
  }

  context.__saveTrafficEnabled = on;
  if (!on) {
    context.__saveTrafficCaptchaBypass = false;
    try {
      for (const page of context.pages?.() || []) {
        await removeHideSvgOnPage(page);
      }
    } catch { /* ignore */ }
    return { ok: true, enabled: false, changed: prev !== false };
  }

  await ensureHideSvgStyle(context);
  const nextHandler = async (route, request) => saveTrafficRouteHandler(route, request);
  context.__saveTrafficHandler = nextHandler;
  context.__saveTrafficUrlFilter = saveTrafficUrlFilter;
  // 只挂 http(s)，避免拦截 data:/file: 诊断页导致整页 CSS 原文乱码
  await context.route(saveTrafficUrlFilter, nextHandler);
  return { ok: true, enabled: true, changed: prev !== true };
}

/**
 * 从连接对象应用省流（优先 context，其次 page.context）。
 */
async function applySaveTrafficOnConnection(connection, enabled) {
  if (!connection) return { ok: false, enabled: false };
  const context = connection.context
    || connection.page?.context?.()
    || connection.browser?.contexts?.()?.[0]
    || null;
  const result = await applySaveTraffic(context, enabled);
  // context 可能拿不到时，至少对当前 page 注入隐藏样式
  if (enabled && connection.page) {
    await injectHideSvgOnPage(connection.page).catch(() => {});
  }
  connection.saveTraffic = !!enabled;
  return result;
}

function resolveContext(pageOrContext) {
  if (!pageOrContext) return null;
  if (typeof pageOrContext.route === 'function' && typeof pageOrContext.pages === 'function') {
    return pageOrContext;
  }
  try {
    return pageOrContext.context?.() || null;
  } catch {
    return null;
  }
}

/**
 * 检测到人机验证时调用：临时关闭拦截并打标，保证验证弹框图片/拼图可加载。
 */
async function pauseSaveTrafficForCaptcha(pageOrContext) {
  const context = resolveContext(pageOrContext);
  if (!context) return { paused: false, wasEnabled: false };
  const wasEnabled = !!context.__saveTrafficEnabled || !!context.__saveTrafficDesired;
  context.__saveTrafficDesired = wasEnabled || !!context.__saveTrafficDesired;
  context.__saveTrafficCaptchaBypass = true;
  context.__saveTrafficCaptchaBypassAt = Date.now();
  if (context.__saveTrafficEnabled) {
    await applySaveTraffic(context, false);
  } else {
    try {
      for (const p of context.pages?.() || []) {
        await removeHideSvgOnPage(p);
      }
    } catch { /* ignore */ }
  }
  context.__saveTrafficCaptchaBypass = true;
  context.__saveTrafficCaptchaBypassAt = Date.now();
  return { paused: true, wasEnabled: !!context.__saveTrafficDesired };
}

/**
 * 验证结束（cleared）后恢复省流；need_manual 期间保持关闭，方便人工操作。
 */
async function resumeSaveTrafficAfterCaptcha(pageOrContext, { force = false } = {}) {
  const context = resolveContext(pageOrContext);
  if (!context) return { resumed: false };
  const want = force || !!context.__saveTrafficDesired;
  context.__saveTrafficCaptchaBypass = false;
  context.__saveTrafficCaptchaBypassAt = 0;
  try {
    for (const p of context.pages?.() || []) {
      p.__tkCaptchaDomBypassCache = null;
    }
  } catch { /* ignore */ }
  if (want) {
    await applySaveTraffic(context, true);
    return { resumed: true };
  }
  return { resumed: false };
}

module.exports = {
  parseSaveTrafficFlag,
  shouldAbortRequest,
  isShellOrLocalUrl,
  saveTrafficUrlFilter,
  isAllowedCaptchaUrl,
  applySaveTraffic,
  applySaveTrafficOnConnection,
  pauseSaveTrafficForCaptcha,
  resumeSaveTrafficAfterCaptcha,
  injectHideSvgOnPage,
  removeHideSvgOnPage,
  BLOCK_RESOURCE_TYPES,
  ALLOW_URL_RE,
};
