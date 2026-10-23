#!/usr/bin/env node
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const host = process.env.TKSWARM_BROWSER_HOST === '0.0.0.0' ? '127.0.0.1' : (process.env.TKSWARM_BROWSER_HOST || '127.0.0.1');

(async () => {
  const res = await fetch(`http://${host}:${port}/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  const p = json?.data?.provider || json?.provider;
  if (p !== 'tkswarm-linuxbrowse') {
    console.error('unexpected provider', p);
    process.exit(1);
  }
  console.log('smoke-health OK');
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
