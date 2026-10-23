const http = require('node:http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body || 'null')); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * 通过 CDP WebSocket 在浏览器层注入「每个新文档执行」的指纹脚本。
 * 使用原生 WebSocket（Node 22+ / Electron 内置）。
 */
async function injectFingerprintOnNewDocument(debugPort, scriptSource) {
  const Ws = globalThis.WebSocket;
  if (!Ws) {
    // Node < 22 无原生 WS 时跳过（指纹仍有 UA/分辨率）
    return { ok: false, reason: 'no WebSocket' };
  }

  const ver = await httpGet(`http://127.0.0.1:${debugPort}/json/version`);
  const browserWs = ver?.webSocketDebuggerUrl;
  if (!browserWs) return { ok: false, reason: 'no browser ws' };

  return new Promise((resolve) => {
    const ws = new Ws(browserWs);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const msgId = ++id;
      pending.set(msgId, { res, rej });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      resolve({ ok: false, reason: 'timeout' });
    }, 8000);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'cdp error'));
          else res(msg.result);
        }
      } catch { /* */ }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'ws error' });
    };

    ws.onopen = async () => {
      try {
        // 浏览器目标：为后续 Target 附加脚本
        await send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => null);

        // 对已有 page 目标注入
        const targets = await httpGet(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
        const pages = Array.isArray(targets) ? targets.filter((t) => t.type === 'page') : [];
        for (const page of pages) {
          if (!page.webSocketDebuggerUrl) continue;
          await injectOnPageWs(page.webSocketDebuggerUrl, scriptSource).catch(() => null);
        }

        // 也在 browser session 尝试 Page 域（部分 Chromium 版本支持）
        await send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource }).catch(() => null);

        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        resolve({ ok: true });
      } catch (e) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        resolve({ ok: false, reason: e.message });
      }
    };
  });
}

function injectOnPageWs(pageWsUrl, scriptSource) {
  const Ws = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new Ws(pageWsUrl);
    let id = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('page inject timeout'));
    }, 5000);

    ws.onopen = () => {
      const msgId = ++id;
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: scriptSource },
      }));
      // 立即在当前页也执行一次
      const msgId2 = ++id;
      ws.send(JSON.stringify({
        id: msgId2,
        method: 'Runtime.evaluate',
        params: { expression: scriptSource, returnByValue: true },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id === 1 || msg.id === 2) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* */ }
          resolve(true);
        }
      } catch { /* */ }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('page ws error'));
    };
  });
}

function sendEmulationOnWs(wsUrl, { timezone, locale, latitude, longitude, accuracy, reload }) {
  const Ws = globalThis.WebSocket;
  const hasGeo = Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    && (Number(latitude) !== 0 || Number(longitude) !== 0);

  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    let id = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('emulation timeout'));
    }, 6000);
    const send = (method, params = {}) => {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
    };
    ws.onopen = () => {
      if (timezone) send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      if (locale) send('Emulation.setLocaleOverride', { locale });
      if (hasGeo) {
        send('Emulation.setGeolocationOverride', {
          latitude: Number(latitude),
          longitude: Number(longitude),
          accuracy: Number(accuracy) || 100,
        });
      }
      // Intl 兜底：部分 Chromium 对 setTimezoneOverride 不即时生效
      if (timezone) {
        const tzLit = JSON.stringify(String(timezone));
        send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(()=>{try{const TZ=${tzLit};const O=Intl.DateTimeFormat;Intl.DateTimeFormat=function(...a){if(a.length<2||a[1]==null)a[1]={};if(typeof a[1]==='object'&&!a[1].timeZone)a[1]={...a[1],timeZone:TZ};return Reflect.construct(O,a,Intl.DateTimeFormat)};Intl.DateTimeFormat.prototype=O.prototype;Intl.DateTimeFormat.supportedLocalesOf=O.supportedLocalesOf.bind(O);const ro=O.prototype.resolvedOptions;O.prototype.resolvedOptions=function(){const r=ro.apply(this,arguments);try{r.timeZone=TZ}catch(e){}return r}}catch(e){}})();`,
        });
        send('Runtime.evaluate', {
          expression: `(()=>{try{const TZ=${tzLit};const O=Intl.DateTimeFormat;Intl.DateTimeFormat=function(...a){if(a.length<2||a[1]==null)a[1]={};if(typeof a[1]==='object'&&!a[1].timeZone)a[1]={...a[1],timeZone:TZ};return Reflect.construct(O,a,Intl.DateTimeFormat)};Intl.DateTimeFormat.prototype=O.prototype;const ro=O.prototype.resolvedOptions;O.prototype.resolvedOptions=function(){const r=ro.apply(this,arguments);try{r.timeZone=TZ}catch(e){}return r};TZ}catch(e){''}})()`,
          returnByValue: true,
        });
      }
      if (reload) send('Page.reload', { ignoreCache: true });
      setTimeout(() => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        resolve(true);
      }, reload ? 800 : 400);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
}

/**
 * 对已有 page 应用时区 / 语言 / 地理（CDP Emulation）
 */
async function applyEmulation(debugPort, opts = {}) {
  const Ws = globalThis.WebSocket;
  if (!Ws) return { ok: false, reason: 'no WebSocket' };
  const targets = await httpGet(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
  const pages = Array.isArray(targets) ? targets.filter((t) => t.type === 'page') : [];
  if (!pages.length) return { ok: false, reason: 'no page' };

  let okCount = 0;
  for (const page of pages) {
    if (!page.webSocketDebuggerUrl) continue;
    try {
      await sendEmulationOnWs(page.webSocketDebuggerUrl, { ...opts, reload: Boolean(opts.reload) });
      okCount += 1;
    } catch { /* next page */ }
  }
  return { ok: okCount > 0, pages: okCount };
}

module.exports = { injectFingerprintOnNewDocument, applyEmulation };
