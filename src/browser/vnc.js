/**
 * 有头窗口远程查看：x11vnc + WebSocket 桥接 + noVNC 页面。
 * 依赖系统包：x11vnc（Dockerfile / README 已说明）。
 *
 * 注意：x11vnc 的 -passwd / -rfbauth 需要的是「密码文件路径」，不是明文。
 * 明文必须先经 x11vnc -storepasswd 写成文件，否则进程秒退 → 前端「连接失败」。
 */
const { spawn, execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { WebSocketServer } = require('ws');
const { getFreeTcpPort } = require('./display-pool');
const { VNC_PASSWORD, VNC_BIND_HOST, API_HOST, DATA_ROOT } = require('../config');

function vncPasswordRequired() {
  const host = String(API_HOST || '');
  const exposed = host === '0.0.0.0' || host === '::' || (host && host !== '127.0.0.1' && host !== 'localhost');
  if (String(process.env.TKSWARM_VNC_REQUIRE_PASSWORD || '') === '1') return true;
  // 监听非本机时默认要求密码（可用 TKSWARM_VNC_ALLOW_NOPW=1 显式放开）
  if (exposed && String(process.env.TKSWARM_VNC_ALLOW_NOPW || '') !== '1') return true;
  return false;
}

/** @type {Map<string, { display: string, rfbPort: number, proc: import('child_process').ChildProcess|null, viewUrl: string }>} */
const vncByProfile = new Map();

/** @type {WebSocketServer|null} */
let wss = null;

/** 缓存：明文 → 密码文件路径 */
let cachedPassFile = '';
let cachedPassPlain = '';

function x11vncInstalled() {
  try {
    execSync('which x11vnc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把明文密码写成 x11vnc / libvncserver 可读的 passwd 文件。
 * @returns {string} 文件绝对路径
 */
function ensureVncPassFile(plain) {
  const password = String(plain || '');
  if (!password) return '';
  if (cachedPassFile && cachedPassPlain === password && fs.existsSync(cachedPassFile)) {
    return cachedPassFile;
  }
  const dir = path.join(DATA_ROOT, 'vnc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x11vnc.pass');
  try {
    // x11vnc -storepasswd <pass> <file>：非交互写入
    execFileSync('x11vnc', ['-storepasswd', password, file], {
      stdio: 'ignore',
      timeout: 8000,
    });
  } catch (e) {
    // 少数发行版参数顺序不同：-storepasswd file 再交互；失败则手写极简文件不可靠，直接抛
    throw new Error(`写入 VNC 密码文件失败：${e.message || e}（请确认已安装 x11vnc）`);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  if (!fs.existsSync(file)) {
    throw new Error('VNC 密码文件未生成');
  }
  cachedPassFile = file;
  cachedPassPlain = password;
  return file;
}

function waitPortOpen(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(tryOnce, 120);
      });
    };
    tryOnce();
  });
}

function attachToHttpServer(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/vnc-ws/')) {
      return;
    }
    const profileId = decodeURIComponent(url.pathname.slice('/vnc-ws/'.length).replace(/\/$/, ''));
    const info = vncByProfile.get(String(profileId));
    if (!info?.rfbPort) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // 可选：带 token 时校验归属（默认共用放行）。无 token 时仅内网场景放行
    try {
      const db = require('../db');
      const { assertProfileOwner } = require('../server/bit-api');
      const token = String(url.searchParams.get('token') || '').trim();
      if (token) {
        const user = db.getUserByToken(token);
        const profile = db.getProfile(profileId);
        if (!user || (profile && !assertProfileOwner(user, profile).ok)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    } catch { /* ignore auth errors, still allow connect on trusted network */ }
    wss.handleUpgrade(req, socket, head, (ws) => {
      bridgeWsToRfb(ws, info.rfbPort);
    });
  });
  return wss;
}

function bridgeWsToRfb(ws, rfbPort) {
  try { ws.binaryType = 'nodebuffer'; } catch { /* */ }
  const tcp = net.connect(rfbPort, '127.0.0.1');
  tcp.on('error', () => {
    try { ws.close(); } catch { /* */ }
  });
  ws.on('error', () => {
    try { tcp.destroy(); } catch { /* */ }
  });
  tcp.on('data', (buf) => {
    if (ws.readyState === 1) {
      try { ws.send(buf); } catch { /* */ }
    }
  });
  ws.on('message', (data, isBinary) => {
    if (tcp.destroyed) return;
    let buf;
    if (Buffer.isBuffer(data)) buf = data;
    else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else buf = Buffer.from(String(data));
    // RFB 必须是二进制；若被当文本会立刻鉴权失败
    if (isBinary === false && buf.length && buf[0] > 127) {
      /* still forward */
    }
    try { tcp.write(buf); } catch { /* */ }
  });
  const closeBoth = () => {
    try { ws.close(); } catch { /* */ }
    try { tcp.destroy(); } catch { /* */ }
  };
  ws.on('close', closeBoth);
  tcp.on('close', closeBoth);
}

/**
 * 在指定 DISPLAY 上启动 x11vnc。
 * @returns {Promise<{ rfbPort: number, viewPath: string, display: string }|null>}
 */
async function startVnc(profileId, display) {
  const id = String(profileId);
  stopVnc(id);
  if (!display || process.platform !== 'linux') return null;
  if (!x11vncInstalled()) {
    console.warn('[vnc] 未安装 x11vnc，跳过远程查看（apt install x11vnc）');
    return null;
  }

  if (vncPasswordRequired() && !VNC_PASSWORD) {
    console.warn('[vnc] 服务监听非本机且未设置 TKSWARM_VNC_PASSWORD，拒绝启动无密码 VNC（可设密码或 TKSWARM_VNC_ALLOW_NOPW=1）');
    return null;
  }

  let passFile = '';
  if (VNC_PASSWORD) {
    try {
      passFile = ensureVncPassFile(VNC_PASSWORD);
    } catch (e) {
      console.warn('[vnc] 密码文件准备失败:', e.message || e);
      return null;
    }
  }

  const rfbPort = await getFreeTcpPort();
  const args = [
    '-display', display,
    '-rfbport', String(rfbPort),
    '-localhost', // RFB 只绑本机，经 WebSocket 反代出去
    '-forever',
    '-shared',
    '-noxdamage',
    '-wait', '10',
    '-defer', '10',
  ];
  if (passFile) {
    // -rfbauth / -passwd 都是「文件路径」；切勿把明文密码直接跟在后面
    args.push('-rfbauth', passFile);
  } else {
    args.push('-nopw');
  }

  const logDir = path.join(DATA_ROOT, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* */ }
  const logFile = path.join(logDir, `x11vnc-${id.slice(0, 12)}.log`);
  let logFd = null;
  try {
    logFd = fs.openSync(logFile, 'a');
  } catch { /* ignore */ }

  const proc = spawn('x11vnc', args, {
    detached: true,
    stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
    env: { ...process.env, DISPLAY: display },
  });
  if (logFd != null) {
    try { fs.closeSync(logFd); } catch { /* */ }
  }
  proc.unref?.();
  proc.on('exit', (code, signal) => {
    console.warn(`[vnc] x11vnc 退出 profile=${id.slice(0, 8)}… code=${code} signal=${signal} log=${logFile}`);
    const cur = vncByProfile.get(id);
    if (cur?.rfbPort === rfbPort) vncByProfile.delete(id);
  });

  const ready = await waitPortOpen(rfbPort, 6000);
  if (!ready || (proc.exitCode != null && proc.exitCode !== 0)) {
    try { proc.kill('SIGKILL'); } catch { /* */ }
    console.warn(`[vnc] x11vnc 未在 :${rfbPort} 就绪，请看日志 ${logFile}`);
    return null;
  }

  const viewPath = `/vnc.html?id=${encodeURIComponent(id)}`;
  const info = {
    display,
    rfbPort,
    proc,
    viewUrl: viewPath,
    bindHost: VNC_BIND_HOST,
  };
  vncByProfile.set(id, info);
  return { rfbPort, viewPath, display };
}

function stopVnc(profileId) {
  const id = String(profileId);
  const cur = vncByProfile.get(id);
  if (!cur) return;
  try {
    if (cur.proc && !cur.proc.killed) {
      cur.proc.kill('SIGTERM');
      setTimeout(() => {
        try { cur.proc.kill('SIGKILL'); } catch { /* */ }
      }, 1200);
    }
  } catch { /* */ }
  vncByProfile.delete(id);
}

function getVncInfo(profileId) {
  const cur = vncByProfile.get(String(profileId));
  if (!cur) return null;
  return {
    profileId: String(profileId),
    display: cur.display,
    rfbPort: cur.rfbPort,
    viewPath: cur.viewUrl,
    wsPath: `/vnc-ws/${encodeURIComponent(String(profileId))}`,
  };
}

function listVnc() {
  return [...vncByProfile.keys()].map((id) => getVncInfo(id));
}

module.exports = {
  attachToHttpServer,
  startVnc,
  stopVnc,
  getVncInfo,
  listVnc,
  x11vncInstalled,
  vncPasswordRequired,
  ensureVncPassFile,
};
