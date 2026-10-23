const express = require('express');
const db = require('../db');
const manager = require('../browser/manager');
const auth = require('../auth/service');
const vnc = require('../browser/vnc');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { collectHealthExtras } = require('../browser/metrics');
const { captureSessionScreenshot } = require('../browser/screenshot');
const {
  exportProfilePack, importProfilePack, listExportFiles, resolveExportFile,
} = require('../browser/profile-backup');
const record = require('../browser/record');
const { audit, readRecent } = require('../auth/audit');
const { readSettings, writeSettings, resolveRequestUser, extractBearer } = require('../settings');
const { TKSWARM_API_BASE, REQUIRE_BEARER, HOST_ID } = require('../config');
const { assertTokenAlive } = require('../auth/token-guard');

const router = express.Router();

async function requireUser(req, res) {
  const { user, token } = resolveRequestUser(req);
  if (user && token) {
    const alive = await assertTokenAlive(token);
    if (!alive) {
      res.json({ ok: false, message: 'token 无效或已过期，请重新登录' });
      return null;
    }
    const again = resolveRequestUser(req);
    req.currentUser = again.user;
    req.authToken = token;
    return again.user;
  }
  if (!REQUIRE_BEARER) {
    const fallback = db.getCurrentUser();
    if (fallback) {
      req.currentUser = fallback;
      req.authToken = fallback.token || '';
      return fallback;
    }
  }
  res.json({ ok: false, message: '未登录' });
  return null;
}

router.get('/api/settings', (req, res) => {
  const s = readSettings();
  res.json({
    ok: true,
    apiBase: s.apiBase || TKSWARM_API_BASE,
  });
});

router.get('/api/dashboard/stats', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const self = db.statsForOwner(user.id);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role_name },
    self,
    children: [],
    windows: filterWindowsForUser(user, manager.listWindows()),
    sessions: Number(user.is_super) === 1 ? db.listSessions() : undefined,
  });
});

router.get('/api/dashboard/stats/async', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const children = await auth.fetchChildrenStats(user);
  const resources = collectHealthExtras();
  res.json({
    ok: true,
    hostId: HOST_ID,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role_name, is_super: user.is_super },
    token: user.token || req.authToken || '',
    self: db.statsForOwner(user.id),
    children,
    windows: filterWindowsForUser(user, manager.listWindows()),
    sessions: Number(user.is_super) === 1 ? db.listSessions() : [],
    usersOnline: Number(user.is_super) === 1 ? db.listUsers().filter((u) => u.hasToken) : undefined,
    resources,
  });
});

function filterWindowsForUser(user, windows) {
  if (Number(user.is_super) === 1) return windows;
  return windows.filter((w) => Number(w.ownerId) === Number(user.id));
}

router.post('/api/auth/login', async (req, res) => {
  try {
    const { apiBase, username, password, captcha, captchaKey } = req.body || {};
    const pack = await auth.login({ apiBase, username, password, captcha, captchaKey });
    audit('auth.login', { userId: pack.user?.id, username: pack.user?.username || username, hostId: HOST_ID });
    res.json({ ok: true, ...pack });
  } catch (e) {
    audit('auth.login.fail', { username: req.body?.username, message: e.message });
    res.json({ ok: false, message: e.message || '登录失败' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  const token = extractBearer(req) || req.body?.token || '';
  const { user } = resolveRequestUser(req);
  auth.logout(token);
  audit('auth.logout', { userId: user?.id });
  res.json({ ok: true });
});

router.get('/api/auth/status', (req, res) => {
  const { user, token } = resolveRequestUser(req);
  const u = user || (!token ? db.getCurrentUser() : null);
  res.json({
    ok: true,
    loggedIn: !!u,
    user: u ? {
      id: u.id, username: u.username, nickname: u.nickname, role: u.role_name,
    } : null,
  });
});

router.get('/api/sessions', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (Number(user.is_super) !== 1) {
    return res.json({ ok: false, message: '仅超管可查看全部会话' });
  }
  res.json({ ok: true, sessions: db.listSessions(), users: db.listUsers() });
});

router.post('/api/windows/:id/show', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (!profile) return res.json({ ok: false, message: '环境不存在' });
    if (Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权操作该环境' });
    }
    const data = await manager.showWindow(id);
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/api/windows/:id/close', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权操作该环境' });
    }
    await manager.closeProfile(id);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.get('/api/windows/:id/vnc', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const id = req.params.id;
  const profile = db.getProfile(id);
  if (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
    return res.json({ ok: false, message: '无权查看' });
  }
  const info = vnc.getVncInfo(id);
  if (!info) {
    return res.json({ ok: false, message: '该窗口未开启 VNC（需有头模式）' });
  }
  res.json({ ok: true, data: info });
});

router.post('/api/windows/close-batch', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.json({ ok: false, message: '缺少 ids' });
    let closed = 0;
    const errors = [];
    for (const id of ids) {
      const profile = db.getProfile(id);
      if (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
        errors.push({ id, message: '无权' });
        continue;
      }
      try {
        await manager.closeProfile(id);
        closed += 1;
      } catch (e) {
        errors.push({ id, message: e.message || '关闭失败' });
      }
    }
    res.json({ ok: true, closed, errors });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.get('/api/windows/:id/screenshot', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权操作该环境' });
    }
    const session = manager.getSession(id);
    if (!session) return res.json({ ok: false, message: '环境未在运行' });
    const shot = await captureSessionScreenshot(session);
    manager.touchSession?.(id);
    res.json({ ok: true, mimeType: shot.mimeType, data: shot.data });
  } catch (e) {
    res.json({ ok: false, message: e.message || '截图失败' });
  }
});

router.post('/api/settings/api-base', (req, res) => {
  const base = String(req.body?.apiBase || '').trim();
  if (base) writeSettings({ apiBase: base });
  res.json({ ok: true });
});

router.post('/api/profiles/:id/export', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (!profile) return res.json({ ok: false, message: '环境不存在' });
    if (Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权导出' });
    }
    if (manager.getSession(id)) {
      await manager.closeProfile(id).catch(() => {});
    }
    const pack = exportProfilePack(id, { closeFirst: true });
    audit('profile.export', { userId: user.id, profileId: id, file: pack.fileName });
    res.json({
      ok: true,
      fileName: pack.fileName,
      bytes: pack.bytes,
      kind: pack.kind,
      download: `/api/backups/download/${encodeURIComponent(pack.fileName)}`,
    });
  } catch (e) {
    res.json({ ok: false, message: e.message || '导出失败' });
  }
});

router.get('/api/backups', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json({ ok: true, hostId: HOST_ID, list: listExportFiles().map(({ path: _p, ...rest }) => rest) });
});

router.get('/api/backups/download/:name', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const filePath = resolveExportFile(req.params.name);
  if (!filePath) return res.status(404).json({ ok: false, message: '文件不存在' });
  const st = fs.statSync(filePath);
  if (st.isDirectory()) {
    return res.status(400).json({ ok: false, message: '目录包请在服务器上拷贝，或用 tar 环境导出 .tgz' });
  }
  res.download(filePath, path.basename(filePath));
});

router.post('/api/backups/import', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const chunks = [];
  let total = 0;
  const max = 400 * 1024 * 1024;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        total += c.length;
        if (total > max) {
          reject(new Error('文件过大（上限约 400MB）'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }

  const buf = Buffer.concat(chunks);
  if (!buf.length) {
    return res.json({ ok: false, message: '空请求体：请用 application/octet-stream 上传 .tgz' });
  }

  const tmp = path.join(os.tmpdir(), `tk-lb-up-${Date.now()}.tgz`);
  try {
    fs.writeFileSync(tmp, buf);
    const keepId = String(req.query.keepId || '1') !== '0';
    const result = importProfilePack(tmp, { ownerId: user.id, keepId });
    audit('profile.import', {
      userId: user.id,
      profileId: result.profile?.id,
      sourceId: result.sourceId,
    });
    res.json({ ok: true, profile: result.profile, sourceId: result.sourceId });
  } catch (e) {
    res.json({ ok: false, message: e.message || '导入失败' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* */ }
  }
});

router.get('/api/audit/recent', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (Number(user.is_super) !== 1) {
    return res.json({ ok: false, message: '仅超管可查看审计' });
  }
  const limit = Number(req.query.limit || 80);
  res.json({ ok: true, list: readRecent(limit) });
});

router.post('/api/windows/:id/record/start', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (!profile) return res.json({ ok: false, message: '环境不存在' });
    if (Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权操作' });
    }
    const session = manager.getSession(id);
    if (!session?.display || session.headless) {
      return res.json({ ok: false, message: '仅有头窗口可录屏' });
    }
    const info = record.startRecording(id, session.display, { maxSeconds: req.body?.maxSeconds });
    audit('browser.record.start', { userId: user.id, profileId: id });
    res.json({ ok: true, data: info });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/api/windows/:id/record/stop', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (profile && Number(user.is_super) !== 1 && Number(profile.owner_id) !== Number(user.id)) {
      return res.json({ ok: false, message: '无权操作' });
    }
    const result = await record.stopRecording(id);
    audit('browser.record.stop', { userId: user.id, profileId: id, fileName: result.fileName });
    if (!result.ok) return res.json({ ok: false, message: result.message, data: result });
    res.json({ ok: true, data: result });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.get('/api/recordings', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json({
    ok: true,
    ffmpeg: record.ffmpegInstalled(),
    defaultMaxSec: record.DEFAULT_MAX_SEC,
    list: record.listRecordings(40),
  });
});

router.get('/api/recordings/download/:name', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const filePath = record.resolveRecording(req.params.name);
  if (!filePath) return res.status(404).json({ ok: false, message: '文件不存在' });
  res.download(filePath, path.basename(filePath));
});

module.exports = router;
