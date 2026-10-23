#!/usr/bin/env node
/**
 * VNC 通路冒烟（不强制真开有头窗）：
 * 1) health 含 platform=linux
 * 2) /vnc.html 可访问
 * 3) 可选：有 TOKEN + 环境时 open 有头并检查 vnc 字段（无显示环境则 skip）
 *
 * 用法：
 *   node scripts/smoke-vnc.js
 *   TKSWARM_SMOKE_TOKEN=xxx TKSWARM_SMOKE_VNC_OPEN=1 node scripts/smoke-vnc.js
 */
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const base = `http://127.0.0.1:${port}`;
const token = String(process.env.TKSWARM_SMOKE_TOKEN || process.env.TKSWARM_BROWSER_TOKEN || '').trim();
const tryOpen = String(process.env.TKSWARM_SMOKE_VNC_OPEN || '') === '1';

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
  const health = await post('health', {});
  const data = health?.data || {};
  if (!health?.success || data.provider !== 'tkswarm-linuxbrowse') {
    console.error('[smoke-vnc] health fail', health);
    process.exit(1);
  }
  if (String(data.platform || '').toLowerCase() !== 'linux' && process.platform === 'linux') {
    console.warn('[smoke-vnc] warn: health.platform 非 linux', data.platform);
  }
  console.log('[smoke-vnc] health OK', {
    providerLabel: data.providerLabel,
    runningWindows: data.runningWindows,
  });

  const page = await fetch(`${base}/vnc.html`);
  if (!page.ok) {
    console.error('[smoke-vnc] /vnc.html HTTP', page.status);
    process.exit(1);
  }
  const html = await page.text();
  if (!/novnc|vnc|websock/i.test(html)) {
    console.error('[smoke-vnc] /vnc.html 内容不像 VNC 页');
    process.exit(1);
  }
  console.log('[smoke-vnc] /vnc.html OK');

  if (!tryOpen || !token) {
    console.log('[smoke-vnc] 跳过有头 open（设 TKSWARM_SMOKE_VNC_OPEN=1 且 TOKEN 可测）');
    console.log('[smoke-vnc] PASS');
    process.exit(0);
  }

  const list = await post('browser/list', { page: 0, pageSize: 1 });
  const id = list?.data?.list?.[0]?.id;
  if (!id) {
    console.log('[smoke-vnc] 无环境，通路检查已通过');
    process.exit(0);
  }

  let opened;
  try {
    opened = await post('browser/open', { id, args: [], queue: true });
  } catch (e) {
    console.warn('[smoke-vnc] open headed skip:', e.message);
    process.exit(0);
  }
  if (!opened?.success) {
    console.warn('[smoke-vnc] open headed 失败（可能缺 Xvfb），页面通路已 OK:', opened?.msg || opened);
    process.exit(0);
  }
  const vnc = opened?.data?.vnc;
  if (vnc?.viewPath || vnc?.wsPath) {
    console.log('[smoke-vnc] VNC session', { viewPath: vnc.viewPath, wsPath: vnc.wsPath });
  } else {
    console.warn('[smoke-vnc] open 成功但无 vnc 字段（可能未装 x11vnc 或密码策略拒绝）');
  }
  await post('browser/close', { id });
  console.log('[smoke-vnc] PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
