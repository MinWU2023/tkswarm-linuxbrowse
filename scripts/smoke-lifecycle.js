#!/usr/bin/env node
/**
 * Linux 冒烟：health →（可选）带 Token 创建/打开/关闭环境。
 * 用法：
 *   node scripts/smoke-lifecycle.js
 *   TKSWARM_SMOKE_TOKEN=xxx node scripts/smoke-lifecycle.js
 */
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const host = '127.0.0.1';
const base = `http://${host}:${port}`;
const token = String(process.env.TKSWARM_SMOKE_TOKEN || process.env.TKSWARM_BROWSER_TOKEN || '').trim();

async function post(path, body = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/${path.replace(/^\//, '')}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log('[smoke-lifecycle] health…');
  const h = await post('health', {});
  const data = h.json?.data || {};
  if (!h.json?.success || data.provider !== 'tkswarm-linuxbrowse') {
    console.error('health fail', h.json);
    process.exit(1);
  }
  console.log('[smoke-lifecycle] health OK', {
    version: data.version,
    loggedIn: data.loggedIn,
    runningWindows: data.runningWindows,
    maxConcurrent: data.maxConcurrent,
    activeSessions: data.activeSessions,
  });

  if (!token) {
    console.log('[smoke-lifecycle] 无 TOKEN，跳过 open/close（设置 TKSWARM_SMOKE_TOKEN 可测全链路）');
    process.exit(0);
  }

  console.log('[smoke-lifecycle] browser/list…');
  const list = await post('browser/list', { page: 0, pageSize: 5 });
  if (!list.json?.success) {
    console.error('list fail', list.json);
    process.exit(1);
  }
  const items = list.json.data?.list || [];
  console.log('[smoke-lifecycle] profiles', items.length);

  if (!items.length) {
    console.log('[smoke-lifecycle] 无环境可 open，list 通路 OK');
    process.exit(0);
  }

  const id = items[0].id;
  console.log('[smoke-lifecycle] open headless', id.slice(0, 12));
  const opened = await post('browser/open', { id, args: ['--headless=new'], queue: true });
  if (!opened.json?.success || !opened.json?.data?.ws) {
    console.error('open fail', opened.json);
    process.exit(1);
  }
  console.log('[smoke-lifecycle] open OK ws=', String(opened.json.data.ws).slice(0, 48));

  const closed = await post('browser/close', { id });
  if (!closed.json?.success) {
    console.error('close fail', closed.json);
    process.exit(1);
  }
  console.log('[smoke-lifecycle] close OK');
  console.log('[smoke-lifecycle] PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
