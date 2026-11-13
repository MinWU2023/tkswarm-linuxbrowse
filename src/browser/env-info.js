'use strict';
/**
 * 环境参数采集（只读）：
 *  - config：环境记录 + 运行会话里的配置参数（代理只给地址/类型，不含账号密码）
 *  - live：经 CDP 在当前页面里读到的「站点实际看到的」浏览器参数
 */

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cdpEvaluate(wsUrl, expression, timeoutMs = 10000) {
  const Ws = globalThis.WebSocket;
  if (!Ws) return Promise.reject(new Error('no WebSocket'));
  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('Runtime.evaluate timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id !== id) return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        if (msg.error) reject(new Error(msg.error.message || 'evaluate error'));
        else resolve(msg.result || {});
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('cdp ws error'));
    };
  });
}

const LIVE_SNIPPET = `(function () {
  var out = { ok: false };
  try {
    var n = navigator;
    var uaData = n.userAgentData;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var d = new Date();
    var gl = null;
    try {
      var c = document.createElement('canvas');
      var g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (g) {
        var ext = g.getExtension('WEBGL_debug_renderer_info');
        gl = {
          vendor: ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : (g.getParameter(g.VENDOR) || ''),
          renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (g.getParameter(g.RENDERER) || '')
        };
      }
    } catch (e) {}
    out = {
      ok: true,
      url: location.href,
      userAgent: n.userAgent,
      platform: n.platform,
      vendor: n.vendor,
      language: n.language,
      languages: (n.languages || []).join(','),
      timezone: tz,
      tzOffsetMin: -d.getTimezoneOffset(),
      localTime: d.toString(),
      hardwareConcurrency: n.hardwareConcurrency,
      deviceMemory: n.deviceMemory != null ? n.deviceMemory : '',
      maxTouchPoints: n.maxTouchPoints,
      webdriver: n.webdriver,
      screen: screen.width + 'x' + screen.height,
      inner: window.innerWidth + 'x' + window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      doNotTrack: n.doNotTrack,
      cookieEnabled: n.cookieEnabled,
      onLine: n.onLine,
      webgl: gl,
      uaData: uaData ? {
        brands: (uaData.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(' | '),
        mobile: uaData.mobile,
        platform: uaData.platform,
        platformVersion: uaData.platformVersion
      } : null
    };
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return JSON.stringify(out);
})()`;

function pickPageTarget(list) {
  const pages = (Array.isArray(list) ? list : []).filter((t) => (
    t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').startsWith('devtools://')
  ));
  return pages.find((t) => t.url && !/^about:/i.test(t.url)) || pages[0] || null;
}

async function collectLive(session) {
  const httpBase = session.http || (session.port ? `http://127.0.0.1:${session.port}` : '');
  if (!httpBase) return { ok: false, error: '环境无调试端口' };
  try {
    const target = pickPageTarget(await fetchJson(`${httpBase}/json/list`));
    if (!target) return { ok: false, error: '窗口里还没有页面，请稍后再刷新' };
    const r = await cdpEvaluate(target.webSocketDebuggerUrl, LIVE_SNIPPET);
    const value = r?.result?.value;
    if (typeof value !== 'string') return { ok: false, error: '页面未返回参数（可能正在跳转）' };
    return JSON.parse(value);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function buildConfig(profile, session) {
  const p = profile || {};
  const s = session || {};
  const fp = s.fp || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (fp[k] != null && fp[k] !== '') return fp[k];
    }
    return '';
  };
  return {
    profileId: String(p.id || ''),
    name: p.name || '',
    country: p.country || '',
    timezone: s.timezone || p.timezone || '',
    locale: s.locale || p.language || '',
    latitude: Number(s.latitude || p.latitude || 0) || null,
    longitude: Number(s.longitude || p.longitude || 0) || null,
    proxyType: p.proxy_type || 'noproxy',
    proxyHost: p.proxy_host || '',
    proxyPort: p.proxy_port || '',
    lastIp: p.last_ip || '',
    userAgent: s.userAgent || '',
    engine: s.engine || '',
    headless: Boolean(s.headless),
    display: s.display || '',
    startedAt: s.startedAt || '',
    fp: {
      os: pick('os'),
      coreVersion: pick('coreVersion'),
      resolution: pick('resolution'),
      hardwareConcurrency: pick('hardwareConcurrency'),
      deviceMemory: pick('deviceMemory'),
      webglVendor: pick('webglVendor'),
      webglRenderer: pick('webglRenderer'),
      languages: pick('languages'),
    },
  };
}

async function collectEnvInfo(profile, session) {
  const config = buildConfig(profile, session);
  const live = await collectLive(session);
  return { config, live, collectedAt: new Date().toISOString() };
}

module.exports = { collectEnvInfo, buildConfig };
