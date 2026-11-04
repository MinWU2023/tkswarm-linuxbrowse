const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');

const als = new AsyncLocalStorage();
const root = path.resolve(__dirname, '../..');
let cachedAuth = '';

function loadApiBase() {
  if (process.env.TKSWARM_API_BASE) {
    return String(process.env.TKSWARM_API_BASE).replace(/\/+$/, '');
  }
  const files = [
    path.join(root, 'data', 'api.json'),
    path.join(root, 'config', 'api.json'),
  ];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j?.apiBase) return String(j.apiBase).replace(/\/+$/, '');
    } catch { /* ignore */ }
  }
  return 'http://tkswarm-api.dyyweb.com';
}

function loadStaticToken() {
  if (process.env.TKSWARM_API_TOKEN) return String(process.env.TKSWARM_API_TOKEN);
  const files = [
    path.join(root, 'data', 'api.json'),
    path.join(root, 'config', 'api.json'),
  ];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j?.token) return String(j.token);
    } catch { /* ignore */ }
  }
  return '';
}

function runWithRequest(req, next) {
  let auth = String(req.headers.authorization || '');
  // <video src> 无法带 Authorization，用 ?token= 透传
  if (!auth) {
    const qToken = String(req.query?.token || req.query?.access_token || '');
    if (qToken) auth = `Bearer ${qToken.replace(/^Bearer\s+/i, '')}`;
  }
  if (auth) cachedAuth = auth;
  const actingAs = String(
    req.headers['x-acting-as'] || req.query?.actingAs || req.query?.acting_as || ''
  );
  const ctx = { auth, actingAs };
  return als.run(ctx, () => next());
}

function setAuthToken(token) {
  const value = token ? `Bearer ${String(token).replace(/^Bearer\s+/i, '')}` : '';
  cachedAuth = value;
  const cur = als.getStore();
  if (cur) cur.auth = value;
}

function resolveAuth(ctx) {
  if (ctx.auth) return ctx.auth;
  if (cachedAuth) return cachedAuth;
  const staticToken = loadStaticToken();
  return staticToken ? `Bearer ${staticToken.replace(/^Bearer\s+/i, '')}` : '';
}

/** 当前请求/缓存的 PHP 登录 Token（与自研浏览器桌面端登录后相同） */
function getAuthTokenBare() {
  return String(resolveAuth({}) || '').replace(/^Bearer\s+/i, '').trim();
}

async function request(method, apiPath, body, options = {}) {
  const base = loadApiBase();
  const ctx = als.getStore() || {};
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const auth = resolveAuth(ctx);
  if (auth) headers.Authorization = auth;
  if (ctx.actingAs) headers['X-Acting-As'] = ctx.actingAs;

  const timeoutMs = Number(options.timeoutMs) || 0;
  const ac = timeoutMs > 0 ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`${base}/api${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac ? ac.signal : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`PHP API 请求超时（${Math.round(timeoutMs / 1000)}s）（${method} /api${apiPath}）`);
      err.status = 408;
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({ success: false, message: 'PHP API 响应无效' }));
  if (!res.ok || !json.success) {
    // 把接口带上：否则任务日志里只有「无权访问该资源」，看不出是哪个接口
    let detail = json.message;
    if (detail != null && typeof detail !== 'string') {
      try { detail = JSON.stringify(detail); } catch { detail = String(detail); }
    }
    detail = detail || `PHP API ${res.status}`;
    const err = new Error(`${detail}（${method} /api${apiPath} → HTTP ${res.status}）`);
    err.status = res.status;
    err.payload = json;
    console.error(`[php-api] ${method} ${apiPath} => ${res.status}`, detail);
    throw err;
  }
  return json.data;
}

/**
 * 下载二进制（素材流等），路径可为 /api/... 或相对 /materials/...；大文件流式写盘。
 * @param {string} apiPath
 * @param {string} [destFile]
 * @param {{ onProgress?: (p:{loaded:number,total:number,pct:number,speed:number})=>void, timeoutMs?: number, progressIntervalMs?: number }} [options]
 */
async function download(apiPath, destFile, options = {}) {
  const { Readable, Transform } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10 * 60 * 1000;
  const progressIntervalMs = Math.max(1000, Number(options.progressIntervalMs) || 2000);
  const base = loadApiBase();
  const ctx = als.getStore() || {};
  const headers = { Accept: '*/*' };
  const auth = resolveAuth(ctx);
  if (auth) headers.Authorization = auth;
  if (ctx.actingAs) headers['X-Acting-As'] = ctx.actingAs;
  let url = String(apiPath || '');
  if (!url.startsWith('http')) {
    if (url.startsWith('/api/')) url = `${base}${url}`;
    else if (url.startsWith('/')) url = `${base}${url.startsWith('/api') ? url : `/api${url}`}`;
    else url = `${base}/api/${url}`;
  }
  const ac = new AbortController();
  // 大视频可能较慢；超时避免无限挂起
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new Error(`下载超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`);
    throw e;
  }
  if (!res.ok) {
    clearTimeout(timer);
    let detail = `下载失败 HTTP ${res.status}`;
    try {
      const j = await res.clone().json();
      if (j?.message) detail = String(j.message);
    } catch { /* binary or empty */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }

  const totalHeader = Number(res.headers.get('content-length') || 0);
  const totalHint = Number(options.totalBytes || 0);
  const total = totalHeader > 0 ? totalHeader : (totalHint > 0 ? totalHint : 0);
  let loaded = 0;
  const t0 = Date.now();
  let lastEmitAt = 0;
  let lastPctBucket = -1;
  let lastLoadedAtEmit = 0;
  let lastStallEmitAt = 0;
  // 进度回调默认按 5% 一档（无总长时约每 5MB）
  const pctStep = Math.max(1, Math.min(20, Number(options.progressPctStep) || 5));

  const emit = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    const pct = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
    const pctBucket = total > 0
      ? Math.floor(pct / pctStep)
      : Math.floor(loaded / (pctStep * 1024 * 1024));
    if (!force) {
      if (pctBucket === lastPctBucket) return;
    }
    lastEmitAt = now;
    lastPctBucket = pctBucket;
    lastLoadedAtEmit = loaded;
    const elapsed = Math.max(0.001, (now - t0) / 1000);
    onProgress({
      loaded,
      total,
      pct: total > 0 ? pct : -1,
      speed: loaded / elapsed,
    });
  };

  try {
    if (destFile) {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      if (res.body && typeof Readable.fromWeb === 'function') {
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            loaded += chunk.length;
            emit(false);
            cb(null, chunk);
          },
        });
        // 卡死探测：仅当字节长时间无增长时偶尔强制报一次，避免 5% 档刷屏
        const heartbeat = onProgress
          ? setInterval(() => {
            if (loaded !== lastLoadedAtEmit) return;
            const now = Date.now();
            if (now - lastStallEmitAt < Math.max(15000, progressIntervalMs * 5)) return;
            lastStallEmitAt = now;
            emit(true);
          }, progressIntervalMs)
          : null;
        if (heartbeat?.unref) heartbeat.unref();
        try {
          emit(true);
          await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destFile));
          emit(true);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
        return destFile;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      loaded = buf.length;
      emit(true);
      fs.writeFileSync(destFile, buf);
      return buf;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    loaded = buf.length;
    emit(true);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * multipart 上传文件（环境包等）。fields 为额外文本字段；fileField 默认 file。
 * @returns {Promise<any>} PHP data
 */
async function uploadMultipart(apiPath, filePath, { fields = {}, fileField = 'file', fileName } = {}) {
  const base = loadApiBase();
  const ctx = als.getStore() || {};
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) throw new Error('上传文件不存在');
  const buf = fs.readFileSync(abs);
  const name = fileName || path.basename(abs);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) continue;
    form.append(String(k), String(v));
  }
  form.append(fileField, new Blob([buf]), name);

  const headers = { Accept: 'application/json' };
  const auth = resolveAuth(ctx);
  if (auth) headers.Authorization = auth;
  if (ctx.actingAs) headers['X-Acting-As'] = ctx.actingAs;

  let url = String(apiPath || '');
  if (!url.startsWith('http')) {
    if (url.startsWith('/api/')) url = `${base}${url}`;
    else if (url.startsWith('/')) url = `${base}${url.startsWith('/api') ? url : `/api${url}`}`;
    else url = `${base}/api/${url}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body: form });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    const hint = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const looksNginx = /404 Not Found|nginx/i.test(hint);
    json = {
      success: false,
      message: looksNginx
        ? `中心库上传接口不可用（HTTP ${res.status}，请确认已部署 /api/node/browser-profiles/*/pack）`
        : (hint ? `PHP API 返回非 JSON：${hint}` : 'PHP API 响应无效'),
    };
  }
  if (!res.ok || !json.success) {
    const detail = json.message || `PHP API ${res.status}`;
    const err = new Error(`${detail}（POST ${apiPath} → HTTP ${res.status}）`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json.data;
}

const get = (p, options) => request('GET', p, undefined, options || {});
const post = (p, body, options) => request('POST', p, body || {}, options || {});
const put = (p, body, options) => request('PUT', p, body || {}, options || {});
const patch = (p, body, options) => request('PATCH', p, body || {}, options || {});

module.exports = {
  loadApiBase,
  runWithRequest,
  setAuthToken,
  getAuthTokenBare,
  request,
  download,
  uploadMultipart,
  get,
  post,
  put,
  patch,
};
