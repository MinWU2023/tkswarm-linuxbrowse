/**
 * Linux 服务器：用 npm 依赖的 Electron 二进制拉起环境窗（CDP 契约与 Chrome 启动器一致）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILES_DIR, DATA_ROOT, CHROME_NO_SANDBOX } = require('../config');
const {
  mergeFingerprint,
  parseResolution,
  buildUserAgent,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  assignHardwareFingerprint,
  explicitFingerprintKeys,
} = require('./fingerprint');
const { timezoneForCountry, languageForCountry } = require('./geo-from-ip');
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
  const rawFp = JSON.parse(profile.fingerprint_json || '{}');
  const fp = mergeFingerprint(rawFp);
  // 每环境独立 GPU / 核数 / 分辨率，避免所有环境共用同一套 WebGL 指纹
  assignHardwareFingerprint(fp, profile.id, explicitFingerprintKeys(rawFp));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  // 时区/语言跟随代理地区，不写死美国东部
  const timezone = profile.timezone || timezoneForCountry(profile.country, profile.longitude) || '';
  const locale = profile.language || fp.languages || languageForCountry(profile.country) || 'en-US';
  const latitude = Number(profile.latitude || fp.latitude || 0);
  const longitude = Number(profile.longitude || fp.longitude || 0);
  const port = await getFreePort();
  const logFile = envLogFile(profile.id);

  const proxy = await resolveChromeProxy(profile);
  const proxyServer = proxy.proxyArg
    ? String(proxy.proxyArg).replace(/^--proxy-server=/i, '')
    : '';

  const userAgentMetadata = buildUserAgentMetadata(fp);
  const clientHintHeaders = buildClientHintHeaders(fp, locale);
  const injectSrc = buildInjectScript(profile.id, {
    ...fp,
    userAgent,
    languages: locale,
    os: fp.os,
  });

  const envConfig = {
    profileId: String(profile.id),
    name: profile.name || profile.id,
    userDataDir,
    headless,
    width,
    height,
    userAgent,
    userAgentMetadata,
    clientHintHeaders,
    injectScript: injectSrc,
    locale,
    startUrl: profile.platform || 'https://www.tiktok.com',
    title: `${profile.name || profile.id} - TkSwarm Linux Electron`,
    proxyServer,
    timezone,
    latitude,
    longitude,
    // Linux 服务器（Xvfb 无 GPU）默认软件渲染，否则常见「黑屏 → 窗口/进程退出」；设 TKSWARM_SOFTWARE_RENDER=0 可关闭
    softwareRender: process.platform === 'linux'
      ? String(process.env.TKSWARM_SOFTWARE_RENDER || '1') !== '0'
      : String(process.env.TKSWARM_SOFTWARE_RENDER || '') === '1',
  };

  const args = [
    mainJs,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-background-networking',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    // 关掉 navigator.webdriver=true 与「正受自动化软件控制」相关差异
    '--disable-blink-features=AutomationControlled',
    '--excludeSwitches=enable-automation',
    // DNS 防泄露：AsyncDns 会在本地发起解析，暴露真实归属。
    // 关掉后交给 SOCKS5 上游（ATYP=域名）远程解析，DNS 与 IP 地区保持一致。
    '--disable-features=AsyncDns,PrefetchDNS',
    '--dns-prefetch-disable',
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

  // stdout/stderr 落到 env-<id>.log，便于排查 GPU / 渲染进程崩溃（原先 stdio:'ignore' 全部丢弃）
  let logFd = null;
  try { logFd = fs.openSync(logFile, 'a'); } catch { logFd = null; }
  const child = spawn(electronBin, args, {
    detached: false,
    stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
    env: childEnv,
    windowsHide: headless,
  });
  if (logFd != null) {
    try { fs.closeSync(logFd); } catch { /* 子进程已继承 fd */ }
  }
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

  // 子进程会在 load about:blank 后写 .cdp-page-ready；与 /json/list 双保险
  const readyFile = path.join(userDataDir, '.cdp-page-ready');
  const readyDeadline = Date.now() + 45000;
  while (Date.now() < readyDeadline) {
    if (fs.existsSync(readyFile)) break;
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // Electron 必须等 page target；桌面端也是返回 page 级 ws
  let pageTarget = await waitForPageTarget(port, 35000);
  if (!pageTarget?.webSocketDebuggerUrl) {
    const tail = (() => {
      try {
        return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-12).join(' | ');
      } catch { return ''; }
    })();
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw new Error(
      `Electron 已启动但未出现可用页面（CDP :${port} /json/list 无 page）`
      + (tail ? `；日志：${tail.slice(0, 400)}` : '')
    );
  }

  for (let i = 0; i < 3; i += 1) {
    const r = await injectFingerprintOnNewDocument(port, injectSrc).catch(() => null);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await applyEmulation(port, {
    timezone,
    locale,
    latitude,
    longitude,
    userAgent,
    platform: fp.os,
    userAgentMetadata,
  }).catch(() => null);

  try {
    fs.writeFileSync(path.join(userDataDir, '.cdp-fp-ready'), `${Date.now()}\n`, 'utf8');
  } catch { /* ignore */ }

  // 注入后 page target 可能刷新，再取一次最新 page ws；若没了再等一轮
  let pageWs = pageTarget.webSocketDebuggerUrl;
  try {
    const again = await waitForPageTarget(port, 10000);
    if (again?.webSocketDebuggerUrl) pageWs = again.webSocketDebuggerUrl;
  } catch { /* keep first */ }
  if (!pageWs) {
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw new Error(`Electron 指纹注入后 page target 消失（CDP :${port}）`);
  }

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
