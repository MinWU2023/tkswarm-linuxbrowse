/**
 * 对运行中环境经 CDP 截取当前页 PNG（base64）。
 */
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cdpCall(wsUrl, method, params = {}, timeoutMs = 12000) {
  const Ws = globalThis.WebSocket;
  if (!Ws) return Promise.reject(new Error('no WebSocket'));
  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error(`${method} timeout`));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, method, params }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id !== id) return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        if (msg.error) reject(new Error(msg.error.message || method));
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

/**
 * @param {{ http?: string, ws?: string, port?: number }} session
 * @returns {Promise<{ mimeType: string, data: string, width?: number, height?: number }>}
 */
async function captureSessionScreenshot(session) {
  const httpBase = session.http
    || (session.port ? `http://127.0.0.1:${session.port}` : '');
  if (!httpBase) throw new Error('环境未运行或无调试端口');

  const targets = await fetchJson(`${httpBase}/json/list`).catch(() => null);
  let pageWs = '';
  if (Array.isArray(targets)) {
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      || targets.find((t) => t.webSocketDebuggerUrl);
    pageWs = page?.webSocketDebuggerUrl || '';
  }
  if (!pageWs) {
    const ver = await fetchJson(`${httpBase}/json/version`);
    pageWs = ver?.webSocketDebuggerUrl || session.ws || '';
  }
  if (!pageWs) throw new Error('无法取得 CDP WebSocket');

  // 先 enable Page，再截图
  await cdpCall(pageWs, 'Page.enable', {}).catch(() => ({}));
  const result = await cdpCall(pageWs, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (!result?.data) throw new Error('截图失败：无数据');
  return {
    mimeType: 'image/png',
    data: result.data,
  };
}

module.exports = { captureSessionScreenshot };
