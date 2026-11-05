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
    app.commandLine.appendSwitch('use-gl', 'swiftshader');
    app.commandLine.appendSwitch('disable-gpu');
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

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron-env] render-process-gone', details?.reason || details);
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
