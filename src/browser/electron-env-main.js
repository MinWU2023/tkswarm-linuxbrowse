/**
 * Electron 环境子进程入口（Linux 服务器浏览器）。
 * 由 electron-launcher 以 `electron electron-env-main.js` 拉起；
 * 配置走环境变量 TKSWARM_ENV_CONFIG（JSON）。
 *
 * 关键：先 load about:blank 立刻挂上 CDP page target，再导航业务 URL。
 * 否则父进程 waitForPageTarget 常超时（/json/list 无 page），Playwright 报「未出现可用页面」。
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function readConfig() {
  try {
    return JSON.parse(process.env.TKSWARM_ENV_CONFIG || '{}') || {};
  } catch {
    return {};
  }
}

const cfg = readConfig();
const profileId = String(cfg.profileId || '');
const userDataDir = String(cfg.userDataDir || '');

if (!profileId || !userDataDir) {
  console.error('[electron-env] 缺少 profileId / userDataDir');
  process.exit(1);
}

try {
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
} catch (e) {
  console.error('[electron-env] userData 不可用:', e.message || e);
  process.exit(1);
}

function markPageReady(extra = '') {
  try {
    const readyFile = path.join(userDataDir, '.cdp-page-ready');
    fs.writeFileSync(readyFile, `${Date.now()}\n${extra}\n`, 'utf8');
  } catch { /* ignore */ }
}

if (cfg.softwareRender) {
  try {
    app.disableHardwareAcceleration();
    // 新版 Chromium 已取消「自动回退软件 WebGL」，必须显式允许 SwiftShader；
    // 否则 WebGL 上下文创建失败（日志：fail_if_major_perf_caveat + swiftshader / kFatalFailure），TikTok 页面黑屏。
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
  } catch { /* ignore */ }
}

if (process.platform === 'linux') {
  try {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
  } catch { /* ignore */ }
}

// 清掉上次残留的 ready 标记
try { fs.unlinkSync(path.join(userDataDir, '.cdp-page-ready')); } catch { /* */ }

app.whenReady().then(async () => {
  const locale = String(cfg.locale || 'en-US');
  const userAgent = String(cfg.userAgent || '');
  const width = Number(cfg.width || 1280) || 1280;
  const height = Number(cfg.height || 720) || 720;
  const headless = Boolean(cfg.headless);
  const startUrl = String(cfg.startUrl || 'https://www.tiktok.com');

  const ses = session.defaultSession;
  if (userAgent) {
    try { ses.setUserAgent(userAgent); } catch { /* ignore */ }
  }

  const proxyServer = String(cfg.proxyServer || '').trim();
  if (proxyServer) {
    try {
      await ses.setProxy({ proxyRules: proxyServer, proxyBypassRules: '<-loopback>' });
    } catch (e) {
      console.warn('[electron-env] setProxy failed:', e.message || e);
    }
  }

  // 省流（服务器浏览器默认强制开）：不加载图片/视频/音频/字体/SVG；验证码相关资源放行。
  // TKSWARM_SERVER_SAVE_TRAFFIC=0 可关闭。只拦 http(s)，主文档/XHR/脚本/样式不动。
  if (String(process.env.TKSWARM_SERVER_SAVE_TRAFFIC || '1').trim() !== '0') {
    const ALLOW = /captcha|\/verify(?:\/|$|\?)|verify[-_]?(?:center|image)|secsdk|security[-_]?check|slide[-_]?verify|slider|puzzle|whirl|rotate[-_]?verify|rc-captcha|geetest|hcaptcha|recaptcha|arkose|funcaptcha|(?:^|\.)(?:ibyteimg|byteimg|byteoversea|ibytedtos|ttwstatic)\.com\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|security|secsdk)|p\d+-(?:rc-)?captcha|p\d+-security|sf\d+-website-login|tiktokcdn[^/]*\/.*(?:captcha|verify|puzzle|slide|whirl|rotate|secsdk|eden)/i;
    const CAPTCHA_TRIGGER = /captcha|verify[-_]?(?:center|image)|secsdk|whirl|rotate[-_]?verify|rc-captcha|security[-_]?check/i;
    const BLOCK_TYPES = new Set(['image', 'media']);
    const BLOCK_URL = /\.(?:woff2?|ttf|otf|eot)(?:\?|$)|fonts\.(?:googleapis|gstatic)\.com|\.svg(?:\?|$|#)|\/svg(?:\/|$|\?)|format=svg|\.(?:png|jpe?g|gif|webp|bmp|ico|avif)(?:\?|$)|\.(?:mp4|webm|m4v|mov|mkv|mp3|wav|ogg|m4a|aac)(?:\?|$)/i;
    let blocked = 0;
    let captchaGraceUntil = 0;
    try {
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        try {
          const url = String(details.url || '');
          const type = String(details.resourceType || '');
          if (CAPTCHA_TRIGGER.test(url)) {
            captchaGraceUntil = Math.max(captchaGraceUntil, Date.now() + 30000);
          }
          if (type === 'mainFrame' || type === 'subFrame' || type === 'webSocket' || ALLOW.test(url)) {
            return callback({});
          }
          // 验证码触发后的 30s 窗口期内放行图片资源，确保旋转双圆环与刷新新图 100% 加载成功
          if (type === 'image' && Date.now() < captchaGraceUntil) {
            return callback({});
          }
          // 脚本/样式/XHR 不按 URL 关键字拦（路径里带 svg/png 的 JS 分包与接口会被误杀，页面停在骨架屏）
          const CRITICAL_TYPES = type === 'script' || type === 'stylesheet' || type === 'xhr' || type === 'ping' || type === 'cspReport' || type === 'object';
          if (BLOCK_TYPES.has(type) || type === 'font' || (!CRITICAL_TYPES && BLOCK_URL.test(url))) {
            blocked += 1;
            if (blocked === 1 || blocked % 200 === 0) console.log(`[electron-env] 省流已拦截 ${blocked} 个资源（最近：${type} ${url.slice(0, 80)}）`);
            return callback({ cancel: true });
          }
        } catch { /* fall through */ }
        callback({});
      });
      console.log('[electron-env] 省流模式已开启（图片/视频/字体/SVG 不加载，验证码资源与触发期图片自动放行）');
    } catch (e) {
      console.warn('[electron-env] 省流拦截挂载失败:', e.message || e);
    }
  }

  const win = new BrowserWindow({
    width,
    height,
    show: !headless,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    title: String(cfg.title || `TkSwarm Env ${profileId}`),
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      // Linux + --no-sandbox 下再开 sandbox 易导致渲染进程起不来 → CDP 无 page
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 禁止 attach webContents.debugger（与 Playwright CDP 互斥）

  try {
    win.webContents.setUserAgent(userAgent || win.webContents.getUserAgent());
  } catch { /* ignore */ }
  if (locale) {
    try { app.commandLine.appendSwitch('lang', locale); } catch { /* ignore */ }
  }

  win.on('closed', () => {
    try { fs.unlinkSync(path.join(userDataDir, '.cdp-page-ready')); } catch { /* */ }
    app.quit();
  });

  let renderReloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron-env] render-process-gone', details?.reason || details);
    // 渲染进程崩溃（黑屏）：窗口还在就重载，避免整个环境失去 page；最多 3 次，防止崩溃循环
    if (renderReloads >= 3) return;
    renderReloads += 1;
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.loadURL(startUrl).catch(() => {});
      } catch { /* ignore */ }
    }, 800);
  });
  app.on('child-process-gone', (_e, details) => {
    console.error('[electron-env] child-process-gone', details?.type, details?.reason);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn(`[electron-env] did-fail-load ${code} ${desc} ${url}`);
  });

  // 1) 先挂空白页，保证 /json/list 立刻有 page target
  try {
    await win.loadURL('about:blank');
  } catch (e) {
    console.warn('[electron-env] load about:blank:', e.message || e);
  }
  markPageReady('about:blank');

  // 2) 再进业务页（失败也不清 ready，父进程仍可连上空白页再 goto）
  try {
    await win.loadURL(startUrl);
    markPageReady(startUrl);
  } catch (e) {
    console.warn('[electron-env] loadURL:', e.message || e);
  }

  if (headless) {
    try { win.hide(); } catch { /* ignore */ }
  }
}).catch((e) => {
  console.error('[electron-env] boot failed:', e);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});
