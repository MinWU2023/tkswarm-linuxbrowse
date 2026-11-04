/**
 * Linux 服务器：用 npm 依赖的 Electron 二进制拉起环境窗（CDP 契约与 Chrome 启动器一致）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILES_DIR, DATA_ROOT, CHROME_NO_SANDBOX } = require('../config');
const { mergeFingerprint, parseResolution, buildUserAgent } = require('./fingerprint');
const { resolveChromeProxy } = require('./proxy-auth');
const { reclaimBeforeOpen, writePid, clearPid } = require('./process-guard');
const { acquireDisplay } = require('./display-pool');
const { getFreePort, waitForDevtools, waitForPageTarget, fetchJson } = require('./launcher');
const { buildInjectScript } = require('./fp-inject');
const { injectFingerprintOnNewDocument, applyEmulation } = require('./cdp-inject');

function profileDir(profileId) {
  const dir = path.join(PROFILES_DIR, String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveElectronBinary() {
  // require('electron') 在纯 Node 下返回二进制路径字符串
  // eslint-disable-next-line import/no-extraneous-dependencies
  const bin = require('electron');
  if (!bin || !fs.existsSync(String(bin))) {
    throw new Error('未找到 Electron 二进制，请在 linuxbrowse 目录执行 npm install（含 electron）');
  }
  return String(bin);
}

function envLogFile(profileId) {
  const dir = path.join(DATA_ROOT, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return path.join(dir, `env-${profileId}.log`);
}

function appendLog(file, line) {
  if (!file) return;
  try { fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`); } catch { /* */ }
}

/**
 * @returns {Promise<{ pid, port, ws, http, headless, userDataDir, process, userAgent, timezone, fp, releaseProxy, engine, display }>}
 */
async function launchProfileElectron(profile, options = {}) {
  await reclaimBeforeOpen(profile.id);

  const electronBin = resolveElectronBinary();
  const mainJs = path.join(__dirname, 'electron-env-main.js');
  const userDataDir = profileDir(profile.id);
  const fp = mergeFingerprint(JSON.parse(profile.fingerprint_json || '{}'));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  const timezone = profile.timezone || 'America/New_York';
  const locale = profile.language || fp.languages || 'en-US';
  const latitude = Number(profile.latitude || fp.latitude || 0);
  const longitude = Number(profile.longitude || fp.longitude || 0);
  const port = await getFreePort();
  const logFile = envLogFile(profile.id);

  const proxy = await resolveChromeProxy(profile);
  const proxyServer = proxy.proxyArg
    ? String(proxy.proxyArg).replace(/^--proxy-server=/i, '')
    : '';

  const envConfig = {
    profileId: String(profile.id),
    name: profile.name || profile.id,
    userDataDir,
    headless,
    width,
    height,
    userAgent,
    locale,
    startUrl: profile.platform || 'https://www.tiktok.com',
    title: `${profile.name || profile.id} - TkSwarm Linux Electron`,
    proxyServer,
    timezone,
    latitude,
    longitude,
    softwareRender: String(process.env.TKSWARM_SOFTWARE_RENDER || '') === '1',
  };

  const args = [
    mainJs,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-background-networking',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    `--lang=${locale}`,
  ];
  if (CHROME_NO_SANDBOX || process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }
  if (Array.isArray(options.args)) {
    for (const a of options.args) {
      if (a && !args.includes(a)) args.push(a);
    }
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.TKSWARM_ENV_CONFIG = JSON.stringify(envConfig);

  let display = null;
  if (!headless && process.platform === 'linux') {
    display = await acquireDisplay(profile.id);
    if (display) childEnv.DISPLAY = display;
  }

  appendLog(logFile, [
    '',
    `=== ${new Date().toISOString()} Electron 打开环境 ${profile.id} ===`,
    `spawn=${electronBin}`,
    `port=${port} headless=${headless ? 1 : 0} display=${display || '-'}`,
    `userData=${userDataDir}`,
    `proxy=${proxyServer || '直连'}`,
  ].join('\n'));

  const child = spawn(electronBin, args, {
    detached: false,
    stdio: 'ignore',
    env: childEnv,
    windowsHide: headless,
  });
  child.on('error', (error) => appendLog(logFile, `[spawn error] ${error?.message || error}`));
  child.on('exit', (code, signal) => appendLog(logFile, `[exit] code=${code} signal=${signal}`));
  writePid(profile.id, child.pid);

  let ver;
  try {
    ver = await waitForDevtools(port, 45000);
  } catch (error) {
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw new Error(
      `Electron 环境启动失败（CDP :${port}）：${error?.message || error}`
    );
  }

  const httpUrl = `http://127.0.0.1:${port}`;
  // Electron 必须等 page target；桌面端也是返回 page 级 ws，browser 级 ws 下 Playwright 常看不到页
  const pageTarget = await waitForPageTarget(port, 30000);
  if (!pageTarget?.webSocketDebuggerUrl) {
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw new Error(`Electron 已启动但未出现可用页面（CDP :${port} /json/list 无 page）`);
  }

  const injectSrc = buildInjectScript(profile.id, {
    ...fp,
    languages: locale,
    os: fp.os,
  });
  for (let i = 0; i < 3; i += 1) {
    const r = await injectFingerprintOnNewDocument(port, injectSrc).catch(() => null);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await applyEmulation(port, { timezone, locale, latitude, longitude }).catch(() => null);

  // 注入后 page target 可能刷新，再取一次最新 page ws
  let pageWs = pageTarget.webSocketDebuggerUrl;
  try {
    const again = await waitForPageTarget(port, 8000);
    if (again?.webSocketDebuggerUrl) pageWs = again.webSocketDebuggerUrl;
  } catch { /* keep first */ }

  const browserWs = ver.webSocketDebuggerUrl
    || (await fetchJson(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.webSocketDebuggerUrl
    || '';

  return {
    pid: child.pid,
    port,
    // 对 Playwright：优先 page 级 ws（与 tkswarm-browses inProcess 一致）
    ws: pageWs || browserWs,
    browserWs,
    http: httpUrl,
    headless,
    display,
    userDataDir,
    process: child,
    userAgent,
    timezone,
    fp,
    engine: 'electron',
    preferPageWs: true,
    releaseProxy: proxy.release || (() => {}),
    localProxyPort: proxy.localPort || 0,
  };
}

module.exports = { launchProfileElectron, resolveElectronBinary, profileDir };
