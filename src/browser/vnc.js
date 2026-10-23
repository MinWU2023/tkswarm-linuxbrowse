/**
 * 有头窗口远程查看：x11vnc + WebSocket 桥接 + noVNC 页面。
 * 依赖系统包：x11vnc（Dockerfile / README 已说明）。
 */
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const { WebSocketServer } = require('ws');
const { getFreeTcpPort } = require('./display-pool');
const { VNC_PASSWORD, VNC_BIND_HOST, API_HOST } = require('../config');

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

function x11vncInstalled() {
  try {
    execSync('which x11vnc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
    // 可选：带 token 时校验归属（无 token 时仅内网场景放行）
    try {
      const db = require('../db');
      const token = String(url.searchParams.get('token') || '').trim();
      if (token) {
        const user = db.getUserByToken(token);
        const profile = db.getProfile(profileId);
        if (!user || (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id))) {
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
  const tcp = net.connect(rfbPort, '127.0.0.1');
  tcp.on('error', () => {
    try { ws.close(); } catch { /* */ }
  });
  ws.on('error', () => {
    try { tcp.destroy(); } catch { /* */ }
  });
  tcp.on('data', (buf) => {
    if (ws.readyState === 1) ws.send(buf);
  });
  ws.on('message', (data) => {
    if (!tcp.destroyed) tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
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
  if (VNC_PASSWORD) {
    args.push('-passwd', VNC_PASSWORD);
  } else {
    args.push('-nopw');
  }

  const proc = spawn('x11vnc', args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DISPLAY: display },
  });
  proc.unref?.();
  proc.on('exit', () => {
    const cur = vncByProfile.get(id);
    if (cur?.rfbPort === rfbPort) vncByProfile.delete(id);
  });

  const viewPath = `/vnc.html?id=${encodeURIComponent(id)}`;
  const info = {
    display,
    rfbPort,
    proc,
    viewUrl: viewPath,
    bindHost: VNC_BIND_HOST,
  };
  vncByProfile.set(id, info);
  await new Promise((r) => setTimeout(r, 400));
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
};
