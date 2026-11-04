const phpApi = require('./php-api');
const { openUpstreamSocket, describeProbeRoute, resolveSystemProxyMode } = require('./system-proxy');

function proxyUrl(proxy) {
  const password = proxy.password || '';
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(password || '')}@` : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

async function tcpProbeOnce(proxy, timeoutMs = 12000) {
  const started = Date.now();
  try {
    const { socket, via } = await openUpstreamSocket(proxy.host, Number(proxy.port), timeoutMs);
    try { socket.destroy(); } catch { /* ignore */ }
    return {
      available: true,
      latencyMs: Date.now() - started,
      via,
    };
  } catch {
    return { available: false, latencyMs: null, via: '' };
  }
}

async function tcpProbe(proxy, timeoutMs = 5000, retries = 0) {
  const attempts = Math.max(1, Number(retries) + 1);
  let last = { available: false, latencyMs: null };
  for (let i = 0; i < attempts; i += 1) {
    last = await tcpProbeOnce(proxy, timeoutMs);
    if (last.available) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350));
  }
  return last;
}

/**
 * SOCKS5 握手；可选 CONNECT 目标并经隧道取出口 IP（HTTP）。
 * opts.fetchEgress: 握手成功后探测出口 IP
 */
async function socks5HandshakeProbe(proxy, timeoutMs = 20000, opts = {}) {
  const started = Date.now();
  const host = String(proxy.host || '');
  const port = Number(proxy.port);
  const user = String(proxy.username || '');
  const pass = String(proxy.password || '');
  const fetchEgress = opts.fetchEgress === true;
  if (!host || !port) return { available: false, latencyMs: null, detail: 'SOCKS5 信息不完整', egressIp: '', via: '' };

  let opened;
  try {
    opened = await openUpstreamSocket(host, port, timeoutMs);
  } catch (err) {
    return {
      available: false,
      latencyMs: null,
      detail: `SOCKS5 连接失败：${err.message || err}`,
      egressIp: '',
      via: '',
    };
  }
  const { socket, via } = opened;

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let step = 'greeting';
    let egressIp = '';
    /** SOCKS CONNECT 成功时刻（不含后续 HTTP 取出口 IP），用于列表「延迟」展示 */
    let connectLatencyMs = null;
    const done = (available, detail, extra = {}) => {
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      const handshakeMs = connectLatencyMs ?? (available ? Date.now() - started : null);
      const totalMs = available ? Date.now() - started : null;
      const viaHint = via && via !== 'direct' ? ` · 经本机翻墙` : '';
      resolve({
        available,
        latencyMs: extra.latencyMs ?? handshakeMs,
        connectLatencyMs: handshakeMs,
        egressLatencyMs: extra.egressLatencyMs ?? (fetchEgress && available ? totalMs : null),
        detail: `${detail}${viaHint}`,
        egressIp,
        via,
      });
    };
    const markConnectOk = () => {
      if (connectLatencyMs == null) connectLatencyMs = Date.now() - started;
    };
    const timer = setTimeout(() => done(false, 'SOCKS5 握手超时'), Math.max(timeoutMs, 15000));
    socket.on('error', (err) => done(false, `SOCKS5 连接失败：${err.message || err}`));

    const sendConnect = (domain, dport) => {
      const name = Buffer.from(domain, 'utf8');
      const req = Buffer.alloc(7 + name.length);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = name.length;
      name.copy(req, 5);
      req.writeUInt16BE(dport, 5 + name.length);
      socket.write(req);
    };

    const beginConnect = () => {
      if (fetchEgress) {
        step = 'connect-egress';
        sendConnect('api.ipify.org', 80);
      } else {
        step = 'connect-reply';
        sendConnect('www.tiktok.com', 443);
      }
    };

    const parseConnectReply = () => {
      if (buf.length < 4) return null;
      if (buf[0] !== 0x05) {
        done(false, 'SOCKS5 CONNECT 响应异常');
        return null;
      }
      const rep = buf[1];
      const atyp = buf[3];
      let hdr = 4;
      if (atyp === 0x01) hdr += 4 + 2;
      else if (atyp === 0x03) {
        if (buf.length < 5) return null;
        hdr += 1 + buf[4] + 2;
      } else if (atyp === 0x04) hdr += 16 + 2;
      else {
        done(false, 'SOCKS5 不支持地址类型');
        return null;
      }
      if (buf.length < hdr) return null;
      buf = buf.subarray(hdr);
      if (rep !== 0x00) {
        const map = {
          0x01: '总称失败',
          0x02: '规则不允许',
          0x03: '网络不可达',
          0x04: '主机不可达',
          0x05: '连接被拒绝',
          0x06: 'TTL 超时',
          0x07: '不支持命令',
          0x08: '不支持地址类型',
        };
        done(false, `SOCKS5 CONNECT 失败：${map[rep] || `code ${rep}`}`);
        return null;
      }
      return true;
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (step === 'greeting') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return done(false, '非 SOCKS5 响应');
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0xFF) {
            const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
            if (greetPass < 2) {
              buf = Buffer.alloc(0);
              step = 'greeting';
              sendGreeting();
              return;
            }
            if (!hasAuth) {
              return done(false, 'SOCKS5 需要账密认证（请填写代理用户名和密码）');
            }
            return done(false, 'SOCKS5 拒绝认证（账密错误或代理不支持该认证方式）');
          }
          if (method === 0x02) {
            const u = Buffer.from(user, 'utf8');
            const p = Buffer.from(pass, 'utf8');
            if (u.length > 255 || p.length > 255) return done(false, 'SOCKS5 账密过长');
            const auth = Buffer.alloc(3 + u.length + p.length);
            auth[0] = 0x01;
            auth[1] = u.length;
            u.copy(auth, 2);
            auth[2 + u.length] = p.length;
            p.copy(auth, 3 + u.length);
            step = 'auth';
            socket.write(auth);
            return;
          }
          if (method !== 0x00) return done(false, `SOCKS5 未知认证方式 ${method}`);
          beginConnect();
          return;
        }
        if (step === 'auth') {
          if (buf.length < 2) return;
          const ok = buf[0] === 0x01 && buf[1] === 0x00;
          buf = buf.subarray(2);
          if (!ok) return done(false, 'SOCKS5 用户名/密码认证失败');
          beginConnect();
          return;
        }
        if (step === 'connect-reply') {
          if (parseConnectReply() !== true) return;
          markConnectOk();
          const ms = connectLatencyMs;
          return done(true, ms != null ? `SOCKS5 握手成功 · ${ms}ms` : 'SOCKS5 握手成功');
        }
        if (step === 'connect-egress') {
          if (parseConnectReply() !== true) return;
          markConnectOk();
          step = 'http-egress';
          socket.write(
            'GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n'
          );
          return;
        }
        if (step === 'http-egress') {
          const text = buf.toString('utf8');
          const sep = text.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const body = text.slice(sep + 4).trim();
          try {
            const data = JSON.parse(body);
            egressIp = String(data.ip || '').trim();
          } catch {
            const m = body.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
            egressIp = m ? m[1] : '';
          }
          const handshake = connectLatencyMs;
          const total = Date.now() - started;
          const latencyHint = handshake != null ? ` · 握手 ${handshake}ms` : '';
          if (egressIp) {
            return done(true, `SOCKS5 出口 ${egressIp}${latencyHint}`, {
              latencyMs: handshake,
              egressLatencyMs: total,
            });
          }
          return done(true, `SOCKS5 握手成功（未解析到出口 IP）${latencyHint}`, {
            latencyMs: handshake,
            egressLatencyMs: total,
          });
        }
      } catch (e) {
        done(false, `SOCKS5 探测异常：${e.message || e}`);
      }
    });
    let greetPass = 0;
    const sendGreeting = () => {
      const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
      greetPass += 1;
      if (!hasAuth) {
        socket.write(greetPass === 1
          ? Buffer.from([0x05, 0x01, 0x00])
          : Buffer.from([0x05, 0x02, 0x00, 0x02]));
        return;
      }
      // 有账密：先只提供用户名密码（部分住宅代理见到 0x00+0x02 会直接 0xFF）
      if (greetPass === 1) {
        socket.write(Buffer.from([0x05, 0x01, 0x02]));
        return;
      }
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    };

    // 套接字已由 openUpstreamSocket 建好（可能经本机翻墙）
    sendGreeting();
  });
}

/** HTTP(S) 代理：经本机翻墙连到账号代理后，用绝对 URI GET 取出口 IP */
async function egressProbe(proxy) {
  if (!['http', 'https'].includes(String(proxy.protocol || '').toLowerCase())) {
    return { egressIp: '', detail: 'SOCKS5 仅完成端口探测', via: '' };
  }
  const started = Date.now();
  let socket;
  let via = '';
  try {
    const opened = await openUpstreamSocket(proxy.host, Number(proxy.port), 20000);
    socket = opened.socket;
    via = opened.via;
    const user = String(proxy.username || '').trim();
    const pass = String(proxy.password || '');
    const lines = [
      'GET http://api.ipify.org/?format=json HTTP/1.1',
      'Host: api.ipify.org',
      'Connection: close',
    ];
    if (user || pass) {
      const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    lines.push('', '');
    const body = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        try { socket.destroy(); } catch { /* */ }
        reject(new Error('出口探测超时'));
      }, 15000);
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      socket.on('end', () => {
        clearTimeout(timer);
        resolve(buf);
      });
      socket.write(lines.join('\r\n'));
    });
    const sep = body.indexOf('\r\n\r\n');
    const head = sep >= 0 ? body.slice(0, sep) : body;
    const text = sep >= 0 ? body.slice(sep + 4).trim() : '';
    if (!/^HTTP\/1\.\d 200/i.test(head)) {
      throw new Error(`代理响应 ${head.split('\r\n')[0] || '非 200'}`);
    }
    let egressIp = '';
    try {
      egressIp = String(JSON.parse(text).ip || '').trim();
    } catch {
      const m = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      egressIp = m ? m[1] : '';
    }
    const viaHint = via && via !== 'direct' ? ' · 经本机翻墙' : '';
    return {
      egressIp,
      latencyMs: Date.now() - started,
      detail: egressIp ? `出口 IP 探测成功${viaHint}` : `未解析到出口 IP${viaHint}`,
      via,
    };
  } catch (error) {
    return { egressIp: '', detail: `出口探测失败：${error.message}`, via };
  } finally {
    try { socket?.destroy(); } catch { /* */ }
  }
}

async function lookupCountryByIp(ip) {
  const addr = String(ip || '').trim();
  if (!addr || !/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return '';
  const { fetch } = require('undici');
  const endpoints = [
    {
      url: `http://ip-api.com/json/${encodeURIComponent(addr)}?fields=status,country,countryCode`,
      parse: (d) => (d?.status === 'success' ? (d.countryCode || d.country) : ''),
    },
    {
      url: `https://ipapi.co/${encodeURIComponent(addr)}/json/`,
      parse: (d) => (d?.error ? '' : (d.country_code || d.country)),
    },
    {
      url: `https://ipwho.is/${encodeURIComponent(addr)}`,
      parse: (d) => (d?.success === false ? '' : (d.country_code || d.country)),
    },
  ];
  for (const ep of endpoints) {
    try {
      const response = await fetch(ep.url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) continue;
      const data = await response.json();
      const code = String(ep.parse(data) || '').trim();
      if (code) return code;
    } catch {
      /* try next */
    }
  }
  return '';
}

async function loadProxyForProbe(proxyId) {
  const bundle = await phpApi.get(`/node/proxies/${proxyId}/bundle`);
  if (!bundle?.host || !bundle?.port) {
    throw new Error('代理不存在或 host/port 无效');
  }
  return {
    id: bundle.id,
    protocol: bundle.protocol,
    host: bundle.host,
    port: bundle.port,
    username: bundle.username || '',
    password: bundle.password || '',
  };
}

/** 登录/同步用：优先账号 bundle，缺账密时按 proxy_id 回读中心库解密密码 */
async function resolveProxyCredsFromBundle(bundle) {
  const host = String(bundle?.proxy_host || '').trim();
  const port = Number(bundle?.proxy_port || 0);
  if (!host || !port) return null;
  let username = String(bundle?.proxy_username || '').trim();
  let password = String(bundle?.proxy_password || '');
  const proxyId = Number(bundle?.proxy_id || 0);
  if (proxyId > 0 && (!username || !password)) {
    try {
      const pb = await loadProxyForProbe(proxyId);
      username = username || String(pb.username || '').trim();
      password = password || String(pb.password || '');
    } catch {
      /* 回读失败仍用账号 bundle 已有字段 */
    }
  }
  return {
    protocol: bundle?.proxy_protocol || 'socks5',
    host,
    port,
    username,
    password,
  };
}

async function probeProxyObject(proxy, opts = {}) {
  if (!proxy?.host || !proxy?.port) throw new Error('代理信息不完整');
  const wantCountry = opts.detectCountry !== false;
  const strictSocks = opts.strictSocks === true;
  const proto = String(proxy.protocol || '').toLowerCase();
  const isSocks = proto === 'socks5' || proto === 'socks' || proto === 'socks5h';
  const hasUser = Boolean(String(proxy.username || '').trim());
  const hasPass = Boolean(String(proxy.password || '').trim());
  const hasCreds = hasUser && hasPass;

  if (isSocks) {
    // SOCKS 一次探测即可（勿先 TCP 再 SOCKS，会重复建连且把 HTTP 取出口耗时误算成「延迟」）
    const socks = await socks5HandshakeProbe(proxy, opts.socksTimeoutMs || (wantCountry ? 10000 : 6000), {
      fetchEgress: opts.fetchEgress ?? wantCountry,
    });
    const portReachable = !/^SOCKS5 连接失败/i.test(String(socks.detail || ''))
      && !/信息不完整/i.test(String(socks.detail || ''));
    const tcp = {
      available: portReachable,
      latencyMs: socks.connectLatencyMs ?? socks.latencyMs,
    };

    let country = '';
    if (wantCountry && socks.available && socks.egressIp) {
      country = await lookupCountryByIp(socks.egressIp);
    }

    const authFail = /认证失败|拒绝认证|需要账密|非 SOCKS5/i.test(String(socks.detail || ''));
    const missingPass = hasUser && !hasPass;
    const missingUser = hasPass && !hasUser;
    const socksOk = Boolean(socks.available);
    // let：登录预检 relaxedForLogin 会改写 available / hardFail / softWarning
    let available = strictSocks
      ? Boolean(tcp.available && socksOk)
      : Boolean(tcp.available && socksOk);

    const detailParts = [];
    if (!tcp.available) {
      detailParts.push('端口不可连接');
    } else if (missingPass) {
      detailParts.push('端口可连接，但缺少代理密码（SOCKS 无法鉴权）');
    } else if (missingUser) {
      detailParts.push('端口可连接，但缺少代理用户名');
    } else if (socksOk) {
      detailParts.push(socks.egressIp ? `SOCKS5 出口 ${socks.egressIp}` : 'SOCKS5 握手成功');
    } else if (socks.detail) {
      detailParts.push(socks.detail);
    } else {
      detailParts.push('SOCKS5 握手失败');
    }
    if (country) detailParts.push(`国家 ${country}`);
    const via = socks.via || tcp.via || '';
    if (via && via !== 'direct' && !detailParts.some((x) => /经本机翻墙/.test(x))) {
      detailParts.push('经本机翻墙');
    }

    let hardFail = !available;
    let softWarning = Boolean(
      tcp.available && !socksOk && !missingPass && !missingUser && /超时/i.test(String(socks.detail || '')),
    );

    // 登录前预检：端口通即可继续，SOCKS 细节交给自研浏览器实测（与比特行为一致）
    if (opts.relaxedForLogin && isSocks) {
      const explicitAuthFail = hasCreds && /认证失败|拒绝认证/.test(String(socks.detail || ''));
      const credsMissingInRequest = !hasUser && !hasPass;
      available = Boolean(tcp.available);
      hardFail = Boolean(!tcp.available || explicitAuthFail);
      softWarning = Boolean(tcp.available && !socksOk && !hardFail);
      if (credsMissingInRequest && !socksOk && tcp.available) {
        detailParts.length = 0;
        detailParts.push(
          socks.detail
            ? `端口可连接（${socks.detail}，仍将打开浏览器验证）`
            : '端口可连接（SOCKS 预检未通过，仍将打开浏览器验证）',
        );
      }
    }

    return {
      available,
      hardFail,
      softWarning,
      latencyMs: socks.connectLatencyMs ?? socks.latencyMs ?? tcp.latencyMs,
      egressLatencyMs: socks.egressLatencyMs ?? null,
      egressIp: socks.egressIp || '',
      country,
      via,
      detail: detailParts.join(' · '),
    };
  }

  const tcp = await tcpProbe(proxy, opts.tcpTimeoutMs || 12000, opts.tcpRetries || 0);
  let egress = { egressIp: '', detail: '', via: tcp.via || '' };
  if (tcp.available) egress = await egressProbe(proxy);
  const reallyAvailable = Boolean(tcp.available && egress.egressIp);
  const via = egress.via || tcp.via || '';

  let country = '';
  if (wantCountry) {
    const ipForGeo = egress.egressIp || (/^\d{1,3}(\.\d{1,3}){3}$/.test(String(proxy.host || '')) ? String(proxy.host) : '');
    if (ipForGeo) country = await lookupCountryByIp(ipForGeo);
  }

  const detailParts = [];
  if (reallyAvailable) {
    detailParts.push(egress.egressIp ? `出口 IP ${egress.egressIp}` : '端口可连接');
    if (country) detailParts.push(`国家 ${country}`);
  } else {
    detailParts.push(egress.detail || (tcp.available ? '出口探测失败' : '连接失败'));
  }
  if (via && via !== 'direct' && !/经本机翻墙/.test(detailParts.join(''))) {
    detailParts.push('经本机翻墙');
  }

  return {
    available: reallyAvailable,
    hardFail: !reallyAvailable,
    softWarning: false,
    latencyMs: egress.latencyMs || tcp.latencyMs,
    egressIp: egress.egressIp || '',
    country,
    via,
    detail: detailParts.join(' · '),
  };
}

async function testProxyReal(proxyId, opts = {}) {
  const proxy = await loadProxyForProbe(proxyId);
  const result = await probeProxyObject(proxy, opts);
  await phpApi.post(`/node/proxies/${proxyId}/probe-result`, result).catch(() => {});
  return result;
}

async function batchTestProxies(proxyIds) {
  const ids = [...new Set(proxyIds.map(Number).filter(Number.isInteger))];
  const results = [];
  let updated = 0;
  try {
    const { publish: liveLog } = require('./live-log');
    liveLog(`代理检测路由：${await describeProbeRoute()}（模式 ${resolveSystemProxyMode()}）`, 'info');
  } catch { /* ignore */ }
  for (const id of ids) {
    try {
      const result = await testProxyReal(id, { detectCountry: true, fetchEgress: true });
      if (result.country) updated += 1;
      results.push({ id, ...result });
    } catch (error) {
      const fail = { available: false, latencyMs: null, egressIp: '', country: '', detail: error.message || '检测失败' };
      await phpApi.post(`/node/proxies/${id}/probe-result`, fail).catch(() => {});
      results.push({ id, ...fail });
    }
  }
  return {
    total: ids.length,
    available: results.filter((x) => x.available).length,
    unavailable: results.filter((x) => !x.available).length,
    updated,
    items: results,
  };
}

async function fetchCloudProxies() {
  throw new Error('云端取代理请使用 PHP /api/proxies/fetch');
}

module.exports = {
  probeProxyObject,
  testProxyReal,
  batchTestProxies,
  loadProxyForProbe,
  resolveProxyCredsFromBundle,
  lookupCountryByIp,
  fetchCloudProxies,
  proxyUrl,
};
