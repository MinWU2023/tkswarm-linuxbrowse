/**
 * 本机翻墙前置代理（Clash / V2Ray 系统代理）。
 * 供代理检测、上游连接与自研浏览器桥共用同一策略：
 *   system —— 优先经系统代理连账号上游（默认）
 *   auto   —— 先直连，失败再借道
 *   direct —— 只直连
 */
const net = require('node:net');
const http = require('node:http');
const { execFile } = require('node:child_process');

const SYS_PROXY_TTL_MS = 60000;
const SYS_PROXY_MISS_TTL_MS = 5000;
let sysProxyCache = { at: 0, value: null };
let sysProxyInflight = null;

function resolveSystemProxyMode() {
  const noSys = String(process.env.TKSWARM_NO_SYSTEM_PROXY || '').trim();
  if (noSys === '1') return 'direct';
  const forceSys = String(process.env.TKSWARM_USE_SYSTEM_PROXY || '').trim();
  if (forceSys === '1') return 'system';
  const envMode = String(process.env.TKSWARM_SYSTEM_PROXY_MODE || '').trim().toLowerCase();
  if (envMode === 'direct' || envMode === 'auto' || envMode === 'system') return envMode;
  // 默认 system：检测与浏览器均经本机翻墙再连账号代理
  return 'system';
}

function parseSystemProxyString(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const pick = (key) => {
    const m = text.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]+)`, 'i'));
    return m ? m[1].trim() : null;
  };

  let value = null;
  let scheme = 'http';
  if (text.includes('=')) {
    const httpEntry = pick('http') || pick('https') || pick('proxy');
    const socksEntry = pick('socks') || pick('socks5');
    if (httpEntry) value = httpEntry;
    else if (socksEntry) {
      value = socksEntry;
      scheme = 'socks5';
    } else return null;
  } else {
    value = text;
  }

  const cleaned = value.replace(/^[a-z0-9]+:\/\//i, '');
  const m = cleaned.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/) || cleaned.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  if (/^socks/i.test(String(raw || ''))) scheme = 'socks5';
  return { type: scheme, host: m[1], port };
}

function envSystemProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) continue;
    const parsed = parseSystemProxyString(raw);
    if (parsed) {
      if (/^socks/i.test(raw)) parsed.type = 'socks5';
      return parsed;
    }
  }
  return null;
}

function queryWindowsSystemProxy() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 4000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        const enable = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
        if (!enable || parseInt(enable[1], 16) !== 1 || !server) return resolve(null);
        return resolve(parseSystemProxyString(server[1]));
      },
    );
  });
}

async function detectSystemProxy() {
  if (resolveSystemProxyMode() === 'direct') return null;
  const age = Date.now() - sysProxyCache.at;
  const ttl = sysProxyCache.value ? SYS_PROXY_TTL_MS : SYS_PROXY_MISS_TTL_MS;
  if (sysProxyCache.at > 0 && age < ttl) return sysProxyCache.value;
  if (sysProxyInflight) return sysProxyInflight;

  sysProxyInflight = (async () => {
    let value = envSystemProxy();
    if (!value && process.platform === 'win32') {
      try { value = await queryWindowsSystemProxy(); } catch { value = null; }
    }
    sysProxyCache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await sysProxyInflight;
  } finally {
    sysProxyInflight = null;
  }
}

function buildSocks5ConnectBuf(dest) {
  const port = Number(dest.port) || 0;
  const host = String(dest.host || '').trim();
  const hostBuf = Buffer.from(host, 'utf8');
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05;
  req[1] = 0x01;
  req[2] = 0x00;
  req[3] = 0x03;
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(port, 5 + hostBuf.length);
  return req;
}

function connectDirect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ host, port: Number(port), timeout: timeoutMs });
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    sock.once('timeout', () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`TCP 连接上游代理超时（${timeoutMs}ms）`));
    });
  });
}

function viaHttpProxy(sysProxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: sysProxy.host,
      port: sysProxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      agent: false,
    });
    const bail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* */ }
      reject(err);
    };
    req.setTimeout(timeoutMs, () => bail(new Error(
      `经系统前置代理 ${sysProxy.host}:${sysProxy.port} 连接上游超时（${timeoutMs}ms）`,
    )));
    req.once('connect', (res, socket) => {
      if (settled) {
        try { socket.destroy(); } catch { /* */ }
        return;
      }
      settled = true;
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch { /* */ }
        return reject(new Error(`系统前置代理 CONNECT 失败，状态码 ${res.statusCode}`));
      }
      socket.setTimeout(0);
      return resolve(socket);
    });
    req.once('error', bail);
    req.end();
  });
}

function viaSocksProxy(sysProxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host: sysProxy.host, port: Number(sysProxy.port), timeout: timeoutMs });
    const bail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners('data');
      sock.setTimeout(0);
      resolve(sock);
    };
    sock.once('error', bail);
    sock.once('timeout', () => bail(new Error(
      `经系统 SOCKS 代理 ${sysProxy.host}:${sysProxy.port} 连接上游超时（${timeoutMs}ms）`,
    )));
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return bail(new Error('系统代理不是 SOCKS5'));
        if (buf[1] === 0xFF) return bail(new Error('系统 SOCKS 代理要求认证，暂不支持'));
        buf = buf.slice(2);
        stage = 'connect';
        sock.write(buildSocks5ConnectBuf({ host, port }));
        return;
      }
      if (stage === 'connect') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return bail(new Error(`系统 SOCKS 代理拒绝连接 ${host}:${port}，code=${buf[1]}`));
        done();
      }
    });
  });
}

function isImmediateFailure(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || error);
  return code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOENT'
    || code === 'EADDRNOTAVAIL'
    || /状态码/.test(msg);
}

function isDirectConnectFailure(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || error);
  return code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENETUNREACH'
    || code === 'EHOSTUNREACH'
    || /超时/.test(msg);
}

async function connectViaSystemProxy(sysProxy, targetHost, targetPort, timeoutMs) {
  if (sysProxy.type === 'socks5') {
    return viaSocksProxy(sysProxy, targetHost, targetPort, timeoutMs);
  }
  return viaHttpProxy(sysProxy, targetHost, targetPort, timeoutMs);
}

/**
 * 打开到账号上游代理 host:port 的原始套接字（可经本机翻墙）。
 * @returns {Promise<{ socket: import('node:net').Socket, via: string }>}
 */
async function openUpstreamSocket(host, port, timeoutMs = 20000) {
  const targetHost = String(host || '');
  const targetPort = Number(port);
  const isLocal = /^(127\.|localhost$|::1$|0\.0\.0\.0$)/i.test(targetHost);
  const mode = resolveSystemProxyMode();
  const budget = Math.max(5000, Number(timeoutMs) || 20000);

  if (!targetHost || !targetPort) {
    throw new Error('上游代理 host/port 无效');
  }

  if (!isLocal && mode === 'system') {
    const sysProxy = await detectSystemProxy();
    if (sysProxy && !(sysProxy.host === targetHost && Number(sysProxy.port) === targetPort)) {
      try {
        const socket = await connectViaSystemProxy(sysProxy, targetHost, targetPort, budget);
        return {
          socket,
          via: `system:${sysProxy.type}://${sysProxy.host}:${sysProxy.port}`,
        };
      } catch (error) {
        if (!isImmediateFailure(error)) throw error;
        // 前置代理没开：退回直连并标明
      }
    }
  }

  try {
    const socket = await connectDirect(targetHost, targetPort, budget);
    return { socket, via: 'direct' };
  } catch (directErr) {
    if (isLocal || mode === 'direct' || !isDirectConnectFailure(directErr)) {
      throw directErr;
    }
    const sysProxy = await detectSystemProxy();
    if (!sysProxy || (sysProxy.host === targetHost && Number(sysProxy.port) === targetPort)) {
      throw directErr;
    }
    const socket = await connectViaSystemProxy(sysProxy, targetHost, targetPort, budget);
    return {
      socket,
      via: `auto:${sysProxy.type}://${sysProxy.host}:${sysProxy.port}`,
    };
  }
}

async function describeProbeRoute() {
  const mode = resolveSystemProxyMode();
  const sys = mode === 'direct' ? null : await detectSystemProxy();
  if (mode === 'system') {
    return sys
      ? `强制经本机翻墙 ${sys.type}://${sys.host}:${sys.port} → 账号代理`
      : '模式=system，但未检测到系统代理 → 将尝试直连账号代理';
  }
  if (mode === 'auto') {
    return sys
      ? `先直连，失败回退 ${sys.type}://${sys.host}:${sys.port}`
      : '先直连；未检测到系统代理，失败无法回退';
  }
  return '只直连账号代理（不经本机翻墙）';
}

module.exports = {
  resolveSystemProxyMode,
  detectSystemProxy,
  openUpstreamSocket,
  describeProbeRoute,
  parseSystemProxyString,
};
