/**
 * 本地代理桥：Chrome 不支持带账密的 SOCKS5/HTTP 代理直连。
 * 本模块在 127.0.0.1 起一个无认证本地端口，再转发到上游并带上认证。
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');

/** @type {Map<string, { server: net.Server, port: number, refs: number }>} */
const bridges = new Map();

function bridgeKey(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  return [
    type,
    profile.proxy_host || '',
    profile.proxy_port || 0,
    profile.proxy_user || '',
    profile.proxy_pass || '',
  ].join('|');
}

function needsAuthBridge(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) return false;
  return Boolean(String(profile.proxy_user || '').trim() || String(profile.proxy_pass || '').trim());
}

function packSocksAuth(user, pass) {
  const u = Buffer.from(String(user || ''), 'utf8');
  const p = Buffer.from(String(pass || ''), 'utf8');
  return Buffer.concat([
    Buffer.from([0x01, u.length]),
    u,
    Buffer.from([p.length]),
    p,
  ]);
}

function connectUpstreamSocks5(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const fail = (err) => {
      try { sock.destroy(); } catch { /* */ }
      reject(err);
    };

    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('上游不是 SOCKS5'));
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 'auth';
          sock.write(packSocksAuth(user, pass));
          return;
        }
        if (method === 0x00) {
          stage = 'request';
          sendConnect();
          return;
        }
        return fail(new Error(`SOCKS5 不支持的认证方法: ${method}`));
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fail(new Error('SOCKS5 用户名/密码认证失败'));
        buf = buf.slice(2);
        stage = 'request';
        sendConnect();
        return;
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${buf[1]}`));
        // 跳过回复头
        let need = 4;
        const atyp = buf[3];
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          need += 1 + buf[4] + 2;
        } else if (atyp === 0x04) need += 16 + 2;
        if (buf.length < need) return;
        sock.removeAllListeners('data');
        resolve(sock);
      }
    });

    function sendConnect() {
      const hostBuf = Buffer.from(destHost, 'utf8');
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(Number(destPort), 5 + hostBuf.length);
      sock.write(req);
    }

    // greeting: 支持 no-auth + user/pass
    sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  });
}

function connectUpstreamHttp(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    const auth = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    const req = [
      `CONNECT ${destHost}:${destPort} HTTP/1.1`,
      `Host: ${destHost}:${destPort}`,
      `Proxy-Authorization: Basic ${auth}`,
      'Proxy-Connection: Keep-Alive',
      '',
      '',
    ].join('\r\n');

    let buf = '';
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk.toString('binary');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      if (!/^HTTP\/1\.\d 200/i.test(head)) {
        sock.destroy();
        reject(new Error(`HTTP 代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
        return;
      }
      sock.removeAllListeners('data');
      resolve(sock);
    });
    sock.write(req);
  });
}

function startLocalSocksBridge(profile) {
  const key = bridgeKey(profile);
  const existing = bridges.get(key);
  if (existing) {
    existing.refs += 1;
    return Promise.resolve({ port: existing.port, key, release: () => releaseBridge(key) });
  }

  const upHost = String(profile.proxy_host);
  const upPort = Number(profile.proxy_port);
  const user = String(profile.proxy_user || '');
  const pass = String(profile.proxy_pass || '');
  const type = String(profile.proxy_type || 'socks5').toLowerCase();

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let buf = Buffer.alloc(0);
      let stage = 'greeting';

      client.on('error', () => client.destroy());
      client.on('data', async (chunk) => {
        try {
          if (stage === 'tunnel') return;
          buf = Buffer.concat([buf, chunk]);
          if (stage === 'greeting') {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05) {
              client.destroy();
              return;
            }
            const nMethods = buf[1];
            if (buf.length < 2 + nMethods) return;
            // 本地桥：对 Chrome 声明无认证
            client.write(Buffer.from([0x05, 0x00]));
            buf = buf.slice(2 + nMethods);
            stage = 'request';
            if (!buf.length) return;
          }
          if (stage === 'request') {
            if (buf.length < 7) return;
            if (buf[0] !== 0x05 || buf[1] !== 0x01) {
              client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              return;
            }
            const atyp = buf[3];
            let offset = 4;
            let destHost = '';
            let destPort = 0;
            if (atyp === 0x01) {
              if (buf.length < 10) return;
              destHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
              destPort = buf.readUInt16BE(8);
              offset = 10;
            } else if (atyp === 0x03) {
              const len = buf[4];
              if (buf.length < 5 + len + 2) return;
              destHost = buf.slice(5, 5 + len).toString('utf8');
              destPort = buf.readUInt16BE(5 + len);
              offset = 5 + len + 2;
            } else {
              client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              return;
            }
            const leftover = buf.slice(offset);
            buf = Buffer.alloc(0);
            stage = 'tunnel';
            client.pause();

            let upstream;
            if (type === 'http' || type === 'https') {
              upstream = await connectUpstreamHttp(upHost, upPort, user, pass, destHost, destPort);
            } else {
              upstream = await connectUpstreamSocks5(upHost, upPort, user, pass, destHost, destPort);
            }
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (leftover.length) upstream.write(leftover);
            client.resume();
            client.pipe(upstream);
            upstream.pipe(client);
            upstream.on('error', () => client.destroy());
            client.on('close', () => upstream.destroy());
          }
        } catch (e) {
          try {
            client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          } catch { /* */ }
          client.destroy();
        }
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      bridges.set(key, { server, port, refs: 1 });
      resolve({ port, key, release: () => releaseBridge(key) });
    });
  });
}

function releaseBridge(key) {
  const entry = bridges.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  bridges.delete(key);
  try { entry.server.close(); } catch { /* */ }
}

/**
 * @returns {Promise<{ proxyArg: string|null, release: function, localPort?: number }>}
 */
async function resolveChromeProxy(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) {
    return { proxyArg: null, release: () => {} };
  }

  if (!needsAuthBridge(profile)) {
    const host = profile.proxy_host;
    const port = profile.proxy_port;
    if (type === 'socks5' || type === 'socks') {
      return { proxyArg: `--proxy-server=socks5://${host}:${port}`, release: () => {} };
    }
    return { proxyArg: `--proxy-server=${host}:${port}`, release: () => {} };
  }

  // 有账密：本地 SOCKS 桥（Chrome 连本地无认证 SOCKS5）
  const bridge = await startLocalSocksBridge(profile);
  return {
    proxyArg: `--proxy-server=socks5://127.0.0.1:${bridge.port}`,
    release: bridge.release,
    localPort: bridge.port,
  };
}

module.exports = {
  resolveChromeProxy,
  needsAuthBridge,
  releaseBridge,
  bridges,
};
