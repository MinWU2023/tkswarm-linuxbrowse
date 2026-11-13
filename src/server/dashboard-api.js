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
const { assertProfileOwner, strictEnvOwner } = require('./bit-api');

const router = express.Router();

async function requireUser(req, res) {
  const { user, token } = resolveRequestUser(req);
  if (user && token) {
    const alive = await assertTokenAlive(token);
    if (alive) {
      const again = resolveRequestUser(req);
      if (again.user) {
        req.currentUser = again.user;
        req.authToken = token;
        return again.user;
      }
    }
  } else if (token) {
    try {
      const { adoptRemoteToken } = require('../auth/token-guard');
      const adopted = await adoptRemoteToken(token);
      if (adopted?.user) {
        req.currentUser = adopted.user;
        req.authToken = token;
        return adopted.user;
      }
    } catch { /* fall through */ }
  }
  // 本机共用：任意已登录用户即可操作控制台（与 bit-api 鉴权一致）
  const fallback = db.getCurrentUser();
  if (fallback) {
    req.currentUser = fallback;
    req.authToken = fallback.token || token || '';
    return fallback;
  }
  if (!REQUIRE_BEARER) {
    res.json({ ok: false, message: '未登录' });
    return null;
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

/**
 * VNC 自动鉴权：下发 TKSWARM_VNC_PASSWORD 给远程页免弹窗。
 * 有 Token 时优先校验登录；无 Token 也返回密码（54345 本就需内网/鉴权，
 * 否则 iframe/新窗口常因未带 Bearer 拿不到密码 → 鉴权失败秒断）。
 */
router.get('/api/vnc-config', async (req, res) => {
  const { user, token } = resolveRequestUser(req);
  if (token && !user) {
    // Token 无效：仍不阻断 VNC（避免「连不上」），只是不绑定用户
  }
  const { VNC_PASSWORD } = require('../config');
  // 经典 VNC 只认前 8 字符，须与 x11vnc -storepasswd 一致
  const password = typeof vnc.normalizeVncPassword === 'function'
    ? vnc.normalizeVncPassword(VNC_PASSWORD)
    : String(VNC_PASSWORD || '').slice(0, 8);
  res.json({
    ok: true,
    hasPassword: password !== '',
    password,
    autoAuth: true,
    loggedIn: !!user,
  });
});

router.get('/api/dashboard/stats', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  await auth.fetchChildrenStats(user).catch(() => []);
  const freshUser = db.getUserById(user.id) || user;
  const self = db.statsForOwner(freshUser.id);
  res.json({
    ok: true,
    user: {
      id: freshUser.id,
      username: freshUser.username,
      nickname: freshUser.nickname,
      role: freshUser.role_name,
      browserEnvQuota: freshUser.browser_env_quota,
      browserEnvUsed: freshUser.browser_env_used,
    },
    self,
    children: [],
    windows: filterWindowsForUser(freshUser, manager.listWindows()),
    sessions: Number(freshUser.is_super) === 1 ? db.listSessions() : undefined,
  });
});

router.get('/api/dashboard/stats/async', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const children = await auth.fetchChildrenStats(user);
  const freshUser = db.getUserById(user.id) || user;
  const resources = collectHealthExtras();
  res.json({
    ok: true,
    hostId: HOST_ID,
    user: {
      id: freshUser.id,
      username: freshUser.username,
      nickname: freshUser.nickname,
      role: freshUser.role_name,
      is_super: freshUser.is_super,
      browserEnvQuota: freshUser.browser_env_quota,
      browserEnvUsed: freshUser.browser_env_used,
    },
    token: freshUser.token || req.authToken || '',
    self: db.statsForOwner(freshUser.id),
    children,
    windows: filterWindowsForUser(freshUser, manager.listWindows()),
    sessions: Number(freshUser.is_super) === 1 ? db.listSessions() : [],
    usersOnline: Number(freshUser.is_super) === 1 ? db.listUsers().filter((u) => u.hasToken) : undefined,
    resources,
  });
});

function filterWindowsForUser(user, windows) {
  if (!strictEnvOwner()) return windows;
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
    const gate = assertProfileOwner(user, profile);
    if (!gate.ok) return res.json({ ok: false, message: gate.msg });
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
    if (profile) {
      const gate = assertProfileOwner(user, profile);
      if (!gate.ok) return res.json({ ok: false, message: gate.msg });
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
  if (profile) {
    const gate = assertProfileOwner(user, profile);
    if (!gate.ok) return res.json({ ok: false, message: gate.msg });
  }
  let info = vnc.getVncInfo(id);
  if (!info && typeof vnc.reviveVncIfNeeded === 'function') {
    try {
      await vnc.reviveVncIfNeeded(id);
      info = vnc.getVncInfo(id);
    } catch { /* */ }
  }
  if (!info) {
    const session = manager.getSession?.(id);
    if (!session) {
      return res.json({ ok: false, message: '环境未在运行：请先打开有头窗口再点 VNC' });
    }
    if (session.headless) {
      return res.json({ ok: false, message: '当前是无头模式，请先「显示窗口」再开 VNC' });
    }
    return res.json({ ok: false, message: '该窗口未开启 VNC（检查 x11vnc 是否安装、TKSWARM_VNC_PASSWORD 是否已设）' });
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
      if (profile) {
        const gate = assertProfileOwner(user, profile);
        if (!gate.ok) {
          errors.push({ id, message: gate.msg || '无权' });
          continue;
        }
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
    if (profile) {
      const gate = assertProfileOwner(user, profile);
      if (!gate.ok) return res.json({ ok: false, message: gate.msg });
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
    const gate = assertProfileOwner(user, profile, { write: true });
    if (!gate.ok) return res.json({ ok: false, message: gate.msg === 'browser环境不存在或已删除' ? '环境不存在' : (gate.msg || '无权导出') });
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
    const gate = assertProfileOwner(user, profile);
    if (!gate.ok) return res.json({ ok: false, message: gate.msg === 'browser环境不存在或已删除' ? '环境不存在' : gate.msg });
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
    if (profile) {
      const gate = assertProfileOwner(user, profile);
      if (!gate.ok) return res.json({ ok: false, message: gate.msg });
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

/** 环境参数（只读）：配置参数 + 站点实际读到的浏览器参数；不含代理账号密码 */
router.get('/api/windows/:id/env-info', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const id = req.params.id;
    const profile = db.getProfile(id);
    if (profile) {
      const gate = assertProfileOwner(user, profile);
      if (!gate.ok) return res.json({ ok: false, message: gate.msg });
    }
    const session = manager.getSession?.(id);
    if (!session) return res.json({ ok: false, message: '环境未在运行' });
    const { collectEnvInfo } = require('../browser/env-info');
    const data = await collectEnvInfo(profile || session.profile || {}, session);
    manager.touchSession?.(id);
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, message: e.message || '采集环境参数失败' });
  }
});

router.get('/api/recordings/download/:name', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const filePath = record.resolveRecording(req.params.name);
  if (!filePath) return res.status(404).json({ ok: false, message: '文件不存在' });
  res.download(filePath, path.basename(filePath));
});

module.exports = router;
