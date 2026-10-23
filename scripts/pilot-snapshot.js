#!/usr/bin/env node
/**
 * 坐席试点快照：采集 Linux Browser health +（可选）带 Token 的 list 统计，
 * 写入 data 目录 JSON，便于一周对照。
 *
 * 用法：
 *   node scripts/pilot-snapshot.js
 *   TKSWARM_SMOKE_TOKEN=xxx node scripts/pilot-snapshot.js --note "day1-linux"
 */
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.env.TKSWARM_BROWSER_PORT || 54345);
const base = `http://127.0.0.1:${port}`;
const token = String(process.env.TKSWARM_SMOKE_TOKEN || process.env.TKSWARM_BROWSER_TOKEN || '').trim();
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx >= 0 ? String(process.argv[noteIdx + 1] || '') : '';

async function post(p, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/${p.replace(/^\//, '')}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

(async () => {
  const health = await post('health', {});
  const data = health?.data || {};
  const snap = {
    at: new Date().toISOString(),
    note: note || undefined,
    api: base,
    provider: data.provider,
    providerLabel: data.providerLabel,
    hostId: data.hostId,
    version: data.version,
    loggedIn: data.loggedIn,
    runningWindows: data.runningWindows,
    maxConcurrent: data.maxConcurrent,
    headlessWindows: data.headlessWindows,
    headedWindows: data.headedWindows,
    activeSessions: data.activeSessions,
    memory: data.memory,
    disk: data.disk,
    profiles: null,
  };

  if (token) {
    const list = await post('browser/list', { page: 0, pageSize: 500 });
    const items = list?.data?.list || [];
    snap.profiles = {
      total: list?.data?.totalNum ?? items.length,
      running: items.filter((p) => p.status === 1 || p.status === 2).length,
      withLastIp: items.filter((p) => p.lastIp).length,
      boundHosts: [...new Set(items.map((p) => p.boundHostId).filter(Boolean))],
    };
  } else {
    snap.profiles = { skipped: 'no TKSWARM_SMOKE_TOKEN' };
  }

  const outDir = path.join(__dirname, '..', 'data', 'pilot');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `pilot-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
  console.log(JSON.stringify(snap, null, 2));
  console.log('[pilot-snapshot] wrote', file);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
