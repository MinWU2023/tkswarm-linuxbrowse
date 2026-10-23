#!/usr/bin/env node
/**
 * CDP dry-run：open 后请求 /json/version，确认调试端口可用。
 * 需 TKSWARM_SMOKE_TOKEN 与至少一个环境。
 */
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const base = `http://127.0.0.1:${port}`;
const token = String(process.env.TKSWARM_SMOKE_TOKEN || process.env.TKSWARM_BROWSER_TOKEN || '').trim();

async function post(path, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

(async () => {
  if (!token) {
    console.log('[smoke-cdp] skip: no TKSWARM_SMOKE_TOKEN');
    process.exit(0);
  }
  const list = await post('browser/list', { page: 0, pageSize: 1 });
  const id = list?.data?.list?.[0]?.id;
  if (!id) {
    console.log('[smoke-cdp] skip: no profile');
    process.exit(0);
  }
  const opened = await post('browser/open', { id, args: ['--headless=new'] });
  const httpUrl = opened?.data?.http;
  if (!httpUrl) {
    console.error('[smoke-cdp] open failed', opened);
    process.exit(1);
  }
  try {
    const ver = await fetch(`${httpUrl}/json/version`).then((r) => r.json());
    if (!ver?.webSocketDebuggerUrl) throw new Error('no ws in json/version');
    console.log('[smoke-cdp] CDP OK', ver.Browser || ver['User-Agent'] || 'ok');
  } finally {
    await post('browser/close', { id });
  }
  console.log('[smoke-cdp] PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
