/**
 * Electron 环境子进程入口（Linux 服务器浏览器）。
 * 由 electron-launcher 以 `electron electron-env-main.js` 拉起；
 * 配置走环境变量 TKSWARM_ENV_CONFIG（JSON）。
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
    app.commandLine.appendSwitch('disable-dev-shm-usage');
  } catch { /* ignore */ }
}

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
      sandbox: true,
    },
  });

  // 时区 / 指纹由父进程 cdp-inject.applyEmulation 注入。
  // 禁止在此 attach webContents.debugger：Electron 页级 Debugger 互斥，
  // 占着会导致 Playwright 连 browser CDP 后 contexts/pages 为空。

  win.webContents.setUserAgent(userAgent || win.webContents.getUserAgent());
  if (locale) {
    try { app.commandLine.appendSwitch('lang', locale); } catch { /* ignore */ }
  }

  win.on('closed', () => {
    app.quit();
  });

  try {
    await win.loadURL(startUrl);
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
