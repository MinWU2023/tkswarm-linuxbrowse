/**
 * 经上游代理探测出口 IP（供 detail / proxy/update 回写）。
 */
const net = require('node:net');
const http = require('node:http');

function socks5Connect(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const fail = (e) => { try { sock.destroy(); } catch { /* */ } reject(e); };

    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 'auth';
          const u = Buffer.from(String(user || ''), 'utf8');
          const p = Buffer.from(String(pass || ''), 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        if (method === 0x00) {
          stage = 'request';
          sendReq();
          return;
        }
        return fail(new Error('socks method'));
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fail(new Error('socks auth fail'));
        buf = buf.slice(2);
        stage = 'request';
        sendReq();
        return;
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new Error('socks connect fail'));
        sock.removeAllListeners('data');
        resolve(sock);
      }
    });

    function sendReq() {
      const hb = Buffer.from(destHost, 'utf8');
      const req = Buffer.alloc(7 + hb.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hb.length;
      hb.copy(req, 5);
      req.writeUInt16BE(destPort, 5 + hb.length);
      sock.write(req);
    }

    const methods = (user || pass) ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    sock.write(methods);
  });
}

function httpGetOverSocket(sock, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    let data = '';
    sock.on('data', (c) => { data += c.toString('utf8'); });
    sock.on('end', () => {
      const idx = data.indexOf('\r\n\r\n');
      resolve(idx >= 0 ? data.slice(idx + 4).trim() : data.trim());
    });
    sock.on('error', reject);
    sock.write(req);
  });
}

/**
 * @param {{ proxy_type?: string, proxy_host?: string, proxy_port?: number, proxy_user?: string, proxy_pass?: string }} profile
 */
async function probeExitIp(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) {
    return probeDirect();
  }
  try {
    if (type === 'socks5' || type === 'socks') {
      const sock = await socks5Connect(
        profile.proxy_host,
        profile.proxy_port,
        profile.proxy_user,
        profile.proxy_pass,
        'api.ipify.org',
        80
      );
      const body = await httpGetOverSocket(sock, 'api.ipify.org', '/');
      sock.destroy();
      const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
      return { ip, via: 'socks5' };
    }
    // http(s) proxy: CONNECT then GET
    const sock = net.connect(Number(profile.proxy_port), profile.proxy_host);
    const auth = (profile.proxy_user || profile.proxy_pass)
      ? Buffer.from(`${profile.proxy_user || ''}:${profile.proxy_pass || ''}`, 'utf8').toString('base64')
      : '';
    const head = [
      'CONNECT api.ipify.org:80 HTTP/1.1',
      'Host: api.ipify.org:80',
      auth ? `Proxy-Authorization: Basic ${auth}` : '',
      '',
      '',
    ].filter(Boolean).join('\r\n');
    await new Promise((resolve, reject) => {
      let buf = '';
      sock.on('error', reject);
      sock.on('data', (c) => {
        buf += c.toString('binary');
        if (buf.includes('\r\n\r\n')) {
          if (!/^HTTP\/1\.\d 200/i.test(buf)) {
            reject(new Error(buf.split('\r\n')[0]));
            return;
          }
          sock.removeAllListeners('data');
          resolve();
        }
      });
      sock.write(head);
    });
    const body = await httpGetOverSocket(sock, 'api.ipify.org', '/');
    sock.destroy();
    const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
    return { ip, via: 'http' };
  } catch (e) {
    return { ip: '', via: 'error', error: e.message };
  }
}

function probeDirect() {
  return new Promise((resolve) => {
    http.get('http://api.ipify.org/', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
        resolve({ ip, via: 'direct' });
      });
    }).on('error', (e) => resolve({ ip: '', via: 'error', error: e.message }));
  });
}

module.exports = { probeExitIp };
