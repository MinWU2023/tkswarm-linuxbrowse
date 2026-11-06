/**
 * 省流模式：拦截图片/视频/音频/字体/广告/SVG 图标等非必要资源，降低带宽与内存占用。
 * 挂在 BrowserContext 上，覆盖该环境内所有 Page。
 *
 * 例外：人机验证 / 滑块拼图相关资源一律放行，否则人工无法处理验证弹框。
 */

const BLOCK_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/** 人机验证 / 安全校验资源：永不拦截（含拼图底图、滑块块、验证码图） */
const ALLOW_URL_RE = [
  /captcha/i,
  /\/verify(?:\/|$|\?)/i,
  /verify[-_]?center/i,
  /verify[-_]?image/i,
  /secsdk/i,
  /security[-_]?check/i,
  /slide[-_]?verify/i,
  /slider/i,
  /puzzle/i,
  /whirl/i,
  /rotate[-_]?verify/i,
  /rc-captcha/i,
  /geetest/i,
  /hcaptcha/i,
  /recaptcha/i,
  /arkose/i,
  /funcaptcha/i,
  /(?:^|\.)byteoversea\.com\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk)/i,
  /(?:^|\.)(?:ibyteimg|byteimg|ibytedtos|ttwstatic)\.com\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk|tos-|obj\/)/i,
  /p\d+-(?:rc-)?captcha/i,
  /p\d+-security/i,
  /sf\d+-website-login/i,
  /captcha[-.].*\.(?:tiktok|bytedance|byteoversea)/i,
  /verification[-.].*\.(?:tiktok|byte)/i,
  /tiktokcdn[^/]*\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|secsdk|eden)/i,
  /rc-verification/i,
  /secsdk-captcha/i,
];

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
image {
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
[class*="secsdk" i] svg,
[class*="secsdk" i] svg *,
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
.TUXModal img,
[role="dialog"] img {
  opacity: 1 !important;
  fill-opacity: 1 !important;
  stroke-opacity: 1 !important;
  visibility: visible !important;
}
`.trim();

const CAPTCHA_CLOSEST = '#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="Captcha"], [class*="secsdk" i], .TUXModal, [role="dialog"]';

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

function shouldAbortRequest(request) {
  const url = String(request.url?.() || request.url || '');
  if (!url || isShellOrLocalUrl(url)) {
    return false;
  }
  // data:image/svg 常被用作图标，省流时拦截；其它 data: 已由 isShellOrLocalUrl 放行
  if (/^data:image\/svg\+xml/i.test(url) || /^data:image\/svg/i.test(url)) {
    return true;
  }
  if (isAllowedCaptchaUrl(url)) return false;

  const type = String(request.resourceType?.() || request.resourceType || '').toLowerCase();
  // 主文档绝不 abort（避免白屏/诊断页被毁）
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
    if (shouldAbortRequest(req)) {
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
          if (!el || !el.style) return;
          if (el.closest && el.closest(CAP)) {
            el.style.setProperty('opacity', '1', 'important');
            return;
          }
          el.style.setProperty('opacity', '0', 'important');
        } catch {}
      };

      const sweep = () => {
        try {
          document.querySelectorAll('svg').forEach(hideOne);
          document.querySelectorAll('img[src*=".svg" i], img[src^="data:image/svg" i]').forEach(hideOne);
        } catch {}
      };
      sweep();

      if (!window.__tkSaveTrafficSvgObs) {
        let t = 0;
        window.__tkSaveTrafficSvgObs = new MutationObserver(() => {
          if (t) return;
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

async function injectHideSvgOnPage(page) {
  if (!page || page.isClosed?.()) return;
  try {
    const href = String(page.url?.() || '');
    if (isShellOrLocalUrl(href)) return;
  } catch { /* ignore */ }
  const src = buildHideSvgInjector();
  try {
    await page.addStyleTag({ content: HIDE_SVG_CSS }).catch(() => {});
  } catch { /* ignore */ }
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

async function ensureHideSvgStyle(context) {
  if (!context) return;
  const css = HIDE_SVG_CSS;
  const cap = CAPTCHA_CLOSEST;

  // 每个新文档自动注入（跳过 data:/file: 诊断壳；必须等 document.head，避免打断解析导致 CSS 原文上屏）
  if (!context.__saveTrafficSvgInit) {
    try {
      await context.addInitScript(({ cssText, capSel }) => {
        try {
          const href = String(location.href || '');
          if (/^(data:|blob:|about:|file:|chrome:|chrome-error:)/i.test(href)) return;
          if (!/^https?:/i.test(href)) return;
        } catch { return; }
        const run = () => {
          try {
            const head = document.head;
            if (!head) return;
            let style = document.getElementById('tkswarm-save-traffic-svg');
            if (!style) {
              style = document.createElement('style');
              style.id = 'tkswarm-save-traffic-svg';
              head.appendChild(style);
            }
            style.textContent = cssText;
            const hide = (el) => {
              if (!el?.style) return;
              if (el.closest?.(capSel)) {
                el.style.setProperty('opacity', '1', 'important');
                return;
              }
              el.style.setProperty('opacity', '0', 'important');
            };
            const sweep = () => {
              document.querySelectorAll('svg').forEach(hide);
              document.querySelectorAll('img[src*=".svg" i], img[src^="data:image/svg" i]').forEach(hide);
            };
            sweep();
            if (!window.__tkSaveTrafficSvgObs) {
              let t = 0;
              window.__tkSaveTrafficSvgObs = new MutationObserver(() => {
                if (t) return;
                t = setTimeout(() => { t = 0; sweep(); }, 80);
              });
              window.__tkSaveTrafficSvgObs.observe(document.documentElement, {
                childList: true,
                subtree: true,
              });
            }
            if (!window.__tkSaveTrafficSvgTimer) {
              window.__tkSaveTrafficSvgTimer = setInterval(sweep, 1500);
            }
          } catch { /* ignore */ }
        };
        if (document.head) run();
        else document.addEventListener('DOMContentLoaded', run, { once: true });
      }, { cssText: css, capSel: cap });
      context.__saveTrafficSvgInit = true;
    } catch { /* ignore */ }
  }

  // 已打开页面立刻注入，并在导航后重注
  try {
    for (const page of context.pages?.() || []) {
      await injectHideSvgOnPage(page);
      if (!page.__tkSaveTrafficSvgHooked) {
        page.__tkSaveTrafficSvgHooked = true;
        page.on('load', () => { injectHideSvgOnPage(page).catch(() => {}); });
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) injectHideSvgOnPage(page).catch(() => {});
        });
      }
    }
  } catch { /* ignore */ }

  // 新 page 打开时也挂钩
  if (!context.__saveTrafficPageHook) {
    context.__saveTrafficPageHook = true;
    try {
      context.on('page', (page) => {
        injectHideSvgOnPage(page).catch(() => {});
        page.on('load', () => { injectHideSvgOnPage(page).catch(() => {}); });
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) injectHideSvgOnPage(page).catch(() => {});
        });
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
  if (context.__saveTrafficEnabled) {
    await applySaveTraffic(context, false);
  }
  context.__saveTrafficCaptchaBypass = true;
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
  BLOCK_RESOURCE_TYPES,
  ALLOW_URL_RE,
};
