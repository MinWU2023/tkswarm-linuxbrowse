#!/usr/bin/env node
/**
 * 运维通路冒烟：healthz / metrics / health.hostId（不依赖 Token）。
 */
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const base = `http://127.0.0.1:${port}`;

(async () => {
  const hz = await fetch(`${base}/healthz`).then((r) => r.json());
  if (!hz?.ok || hz.provider !== 'tkswarm-linuxbrowse') {
    console.error('[smoke-ops] healthz fail', hz);
    process.exit(1);
  }
  console.log('[smoke-ops] healthz OK', { hostId: hz.hostId, runningWindows: hz.runningWindows });

  const metrics = await fetch(`${base}/metrics`).then((r) => r.text());
  if (!/tkswarm_lb_up 1/.test(metrics) || !/tkswarm_lb_running_windows/.test(metrics)) {
    console.error('[smoke-ops] metrics missing expected series');
    process.exit(1);
  }
  console.log('[smoke-ops] metrics OK');

  const health = await fetch(`${base}/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  const data = health?.data || {};
  if (!data.hostId) {
    console.error('[smoke-ops] health missing hostId', data);
    process.exit(1);
  }
  console.log('[smoke-ops] health.hostId=', data.hostId);
  console.log('[smoke-ops] PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
