const express = require('express');
const db = require('../db');
const manager = require('../browser/manager');
const { mergeFingerprint } = require('../browser/fingerprint');
const { getCurrentUser } = require('../db');
const { resolveRequestUser } = require('../settings');
const { probeExitIp } = require('../browser/exit-ip');
const { lookupGeoByIp, applyIpCreateFields } = require('../browser/geo-from-ip');
const { clearProfileCache, removeProfileDir } = require('../browser/profile-cleanup');
const { REQUIRE_BEARER, HOST_ID } = require('../config');
const { assertTokenAlive } = require('../auth/token-guard');
const { collectHealthExtras } = require('../browser/metrics');
const { captureSessionScreenshot } = require('../browser/screenshot');
const record = require('../browser/record');
const { audit } = require('../auth/audit');

function ok(data) {
  return { success: true, code: 0, data };
}

function fail(msg, code = 1, errCode) {
  const body = { success: false, code, msg: String(msg) };
  if (errCode) body.errCode = String(errCode);
  return body;
}

function errCodeFromMessage(msg) {
  const m = String(msg || '');
  if (/Login out|未登录/i.test(m)) return 'AUTH_REQUIRED';
  if (/token|过期|失效/i.test(m)) return 'TOKEN_INVALID';
  if (/上限|MAX_CONCURRENT|并发/i.test(m)) return 'CONCURRENT_LIMIT';
  if (/不存在|已删除/i.test(m)) return 'PROFILE_NOT_FOUND';
  if (/无权/i.test(m)) return 'FORBIDDEN';
  if (/代理|proxy|socks|出口/i.test(m)) return 'PROXY_ERROR';
  if (/绑定主机|hostId|STICKY|重绑/i.test(m)) return 'HOST_MISMATCH';
  return undefined;
}

async function authMiddleware(req, res, next) {
  const { user, token } = resolveRequestUser(req);
  if (!user || !token) {
    if (!REQUIRE_BEARER) {
      const fallback = getCurrentUser();
      if (fallback && !token) {
        req.currentUser = fallback;
        return next();
      }
    }
    return res.json(fail('Login out', 1, 'AUTH_REQUIRED'));
  }
  const alive = await assertTokenAlive(token);
  if (!alive) {
    return res.json(fail('token 无效或已过期，请重新登录', 1, 'TOKEN_INVALID'));
  }
  // 可能刚被踢，重新解析
  const again = resolveRequestUser(req);
  if (!again.user) {
    return res.json(fail('Login out', 1, 'AUTH_REQUIRED'));
  }
  req.currentUser = again.user;
  req.authToken = token;
  next();
}

/** 严格按 owner_id 隔离（老多租户行为）。默认关闭：同机环境共用。 */
function strictEnvOwner() {
  return String(process.env.TKSWARM_STRICT_ENV_OWNER || '').trim() === '1';
}

/**
 * 环境权限（与 tkswarm-browses 对齐）
 * ---------------------------------------------------------------
 * 默认共用：同一 data 目录里的环境，任何已登录用户都能查看、打开、改配置、清理、删除。
 * A 绑定账号后 B 换账号登录同机，不能再被 owner_id 拦住。
 * owner_id 只用于记录创建者与每人创建额度（MAX_ENVS_PER_USER）。
 * 真·多租户主机设 TKSWARM_STRICT_ENV_OWNER=1 退回按人隔离。
 */
function assertProfileOwner(user, profile, opts = {}) {
  if (!profile) return { ok: false, msg: 'browser环境不存在或已删除' };
  if (!user) return { ok: false, msg: 'Login out' };
  if (!strictEnvOwner()) return { ok: true };

  const write = !!opts.write;
  if (Number(user.is_super) === 1) return { ok: true };
  if (!write) return { ok: true };
  const owner = Number(profile.owner_id || 0);
  if (owner === 0 || owner === Number(user.id)) return { ok: true };
  return { ok: false, msg: '无权修改该浏览器环境（仅创建者可删除或改配置）' };
}

function toBitProfile(row, runtime = null) {
  if (!row) return null;
  const fp = JSON.parse(row.fingerprint_json || '{}');
  const status = runtime
    ? (runtime.headless ? 1 : 2)
    : (row.status === 'running' || row.status === 'headless' ? 1 : 0);
  return {
    id: row.id,
    seq: row.seq,
    code: row.id.slice(0, 8),
    name: row.name,
    remark: row.remark,
    groupId: row.group_id || 'default',
    status,
    platform: row.platform,
    proxyType: row.proxy_type,
    host: row.proxy_host,
    port: row.proxy_port,
    proxyUserName: row.proxy_user,
    proxyPassword: row.proxy_pass,
    country: row.country || '',
    lastIp: row.last_ip || '',
    boundHostId: row.bound_host_id || '',
    hostId: HOST_ID,
    latitude: row.latitude || 0,
    longitude: row.longitude || 0,
    coreProduct: fp.coreProduct || 'chrome',
    coreVersion: fp.coreVersion || '131',
    browserFingerPrint: fp,
    fingerprint: fp,
    ua: fp.userAgent,
    timezone: row.timezone,
    language: row.language,
    createdTime: row.created_at,
    updateTime: row.updated_at,
    ownerId: row.owner_id,
  };
}

async function resolveGeoFromProxy(proxyFields, fp, body = {}) {
  let lastIp = '';
  let geo = {};
  let proxyError = '';
  if (proxyFields.proxy_type && proxyFields.proxy_type !== 'noproxy' && proxyFields.proxy_host) {
    const probed = await probeExitIp(proxyFields).catch((e) => ({ ip: '', via: 'error', error: e.message }));
    lastIp = probed?.ip || '';
    if (!lastIp && (probed?.error || probed?.via === 'error')) {
      proxyError = probed?.error || '出口 IP 探测失败';
    }
    if (lastIp) geo = await lookupGeoByIp(lastIp).catch(() => ({}));
  }
  const fields = applyIpCreateFields(fp, geo, body);
  return { lastIp, geo, fields, proxyError };
}

function createRouter() {
  const router = express.Router();

  // health 无需登录也能探活（节点设置页「检测」）；list/open 仍需登录
  router.post('/health', (req, res) => {
    const { PROVIDER_ID, PROVIDER_LABEL, VERSION, MAX_CONCURRENT_OPENS } = require('../config');
    const extras = collectHealthExtras();
    const loggedIn = extras.activeSessions > 0 || !!getCurrentUser();
    res.json(ok({
      status: 'ok',
      provider: PROVIDER_ID,
      providerFamily: 'tkswarm',
      providerLabel: PROVIDER_LABEL,
      platform: 'linux',
      hostId: HOST_ID,
      loggedIn,
      version: VERSION,
      runningWindows: extras.runningWindows,
      maxConcurrent: extras.maxConcurrent || MAX_CONCURRENT_OPENS,
      headlessWindows: extras.headlessWindows,
      headedWindows: extras.headedWindows,
      activeSessions: extras.activeSessions,
      memory: extras.memory,
      disk: extras.disk,
    }));
  });

  router.post('/group/list', authMiddleware, (req, res) => {
    const page = Number(req.body?.page || 0);
    const pageSize = Number(req.body?.pageSize || 100);
    const user = req.currentUser;
    // 默认共用：列出全部组；严格模式非超管只看自己的
    const ownerFilter = (!strictEnvOwner() || Number(user.is_super) === 1) ? null : Number(user.id);
    const all = db.listGroups({ ownerId: ownerFilter });
    const limit = Math.min(500, Math.max(1, pageSize));
    const offset = Math.max(0, page) * limit;
    const list = all.slice(offset, offset + limit).map((g) => ({
      id: g.id,
      name: g.name,
      sort: g.sort || 0,
    }));
    res.json(ok({ list, page, pageSize: limit, totalNum: all.length }));
  });

  router.post('/group/add', authMiddleware, (req, res) => {
    try {
      const user = req.currentUser;
      const row = db.createGroup({
        name: req.body?.groupName || req.body?.name || '未命名分组',
        ownerId: user.id,
        sort: Number(req.body?.sort || 0),
      });
      res.json(ok({ id: row.id, name: row.name, sort: row.sort }));
    } catch (e) {
      res.json(fail(e.message || '创建分组失败'));
    }
  });

  router.post('/group/edit', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.updateGroup(id, {
        name: req.body?.groupName || req.body?.name,
        sort: req.body?.sort,
      });
      if (!row) return res.json(fail('分组不存在'));
      res.json(ok(row));
    } catch (e) {
      res.json(fail(e.message || '编辑分组失败'));
    }
  });

  router.post('/group/delete', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      db.deleteGroup(id);
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '删除分组失败'));
    }
  });

  router.post('/browser/list', authMiddleware, (req, res) => {
    const page = Number(req.body?.page || 0);
    const pageSize = Number(req.body?.pageSize || 100);
    const name = String(req.body?.name || '');
    const groupId = req.body?.groupId != null ? String(req.body.groupId) : null;
    const user = req.currentUser;
    // 默认共用：列表展示全部本地环境；严格模式非超管只看自己的；额度仍按 owner_id
    const ownerFilter = (!strictEnvOwner() || Number(user.is_super) === 1) ? null : Number(user.id);
    const pack = db.listProfiles({ page, pageSize, name, ownerId: ownerFilter, groupId });
    const windows = manager.listWindows();
    const winMap = new Map(windows.map((w) => [w.profileId, w]));
    const list = pack.list.map((row) => toBitProfile(row, winMap.get(row.id)));
    res.json(ok({ list, page: pack.page, pageSize: pack.pageSize, totalNum: pack.totalNum }));
  });

  router.post('/browser/detail', authMiddleware, (req, res) => {
    const id = String(req.body?.id || '');
    const row = db.getProfile(id);
    const gate = assertProfileOwner(req.currentUser, row);
    if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
    const runtime = manager.getSession(id);
    res.json(ok(toBitProfile(row, runtime)));
  });

  /** 换机后把环境粘滞重绑到本机 HOST_ID（导入包会自动绑；手工迁移用此接口） */
  router.post('/browser/host/rebind', authMiddleware, (req, res) => {
    const id = String(req.body?.id || '');
    const row = db.getProfile(id);
    const gate = assertProfileOwner(req.currentUser, row, { write: true });
    if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
    if (manager.getSession(id)) {
      return res.json(fail('请先关闭窗口再重绑主机', 1, 'STILL_RUNNING'));
    }
    db.setProfileBoundHost(id, HOST_ID);
    audit('browser.host.rebind', { userId: req.currentUser?.id, profileId: id, hostId: HOST_ID });
    res.json(ok({ id, boundHostId: HOST_ID }));
  });

  /** Node keepBrowser / 长任务心跳：刷新 lastActiveAt，避免 SESSION_STALE 误杀 */
  router.post('/browser/heartbeat', authMiddleware, (req, res) => {
    const id = String(req.body?.id || '');
    const row = db.getProfile(id);
    const gate = assertProfileOwner(req.currentUser, row);
    if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
    const alive = !!manager.getSession(id);
    if (alive) manager.touchSession(id);
    res.json(ok({ id, running: alive, at: Date.now() }));
  });

  router.post('/browser/open', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
      const args = req.body?.args;
      const headlessFromArgs = Array.isArray(args) && args.some((a) => /headless/i.test(String(a)));
      const headless = req.body?.headless === true || req.body?.headless === 1 || headlessFromArgs;
      const data = await manager.openProfile(id, { headless, args, queue: req.body?.queue !== false });
      audit('browser.open', {
        userId: req.currentUser?.id,
        profileId: id,
        headless: !!headless,
        hostId: HOST_ID,
      });
      res.json(ok({
        ...data,
        lastIp: row.last_ip || '',
        proxyType: row.proxy_type || '',
        host: row.proxy_host || '',
        port: row.proxy_port || 0,
      }));
    } catch (e) {
      const msg = e.message || '打开失败';
      audit('browser.open.fail', { userId: req.currentUser?.id, profileId: String(req.body?.id || ''), msg });
      res.json(fail(msg, 1, errCodeFromMessage(msg)));
    }
  });

  router.post('/browser/close', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
      await manager.closeProfile(id);
      audit('browser.close', { userId: req.currentUser?.id, profileId: id, hostId: HOST_ID });
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '关闭失败'));
    }
  });

  /** 运行中环境截图（PNG base64）；无头/有头均可 */
  router.post('/browser/screenshot', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
      const session = manager.getSession(id);
      if (!session) return res.json(fail('环境未在运行', 1, 'NOT_RUNNING'));
      const shot = await captureSessionScreenshot(session);
      manager.touchSession?.(id);
      audit('browser.screenshot', { userId: req.currentUser?.id, profileId: id });
      res.json(ok({ id, mimeType: shot.mimeType, data: shot.data }));
    } catch (e) {
      res.json(fail(e.message || '截图失败', 1, 'SCREENSHOT_FAIL'));
    }
  });

  /** 有头短时录屏：需 DISPLAY + ffmpeg */
  router.post('/browser/record/start', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
      const session = manager.getSession(id);
      if (!session) return res.json(fail('环境未在运行', 1, 'NOT_RUNNING'));
      if (session.headless || !session.display) {
        return res.json(fail('仅有头窗口可录屏（请先显示窗口）', 1, 'NEED_HEADED'));
      }
      const info = record.startRecording(id, session.display, {
        maxSeconds: req.body?.maxSeconds,
      });
      manager.touchSession?.(id);
      audit('browser.record.start', { userId: req.currentUser?.id, profileId: id, maxSec: info?.maxSec });
      res.json(ok(info));
    } catch (e) {
      res.json(fail(e.message || '开始录屏失败', 1, 'RECORD_FAIL'));
    }
  });

  router.post('/browser/record/stop', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
      const result = await record.stopRecording(id);
      audit('browser.record.stop', {
        userId: req.currentUser?.id,
        profileId: id,
        fileName: result.fileName,
        ok: result.ok,
      });
      if (!result.ok) return res.json(fail(result.message || '停止录屏失败', 1, 'RECORD_FAIL'));
      res.json(ok(result));
    } catch (e) {
      res.json(fail(e.message || '停止录屏失败', 1, 'RECORD_FAIL'));
    }
  });

  router.post('/browser/delete', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      await manager.closeProfile(id).catch(() => {});
      db.deleteProfile(id);
      removeProfileDir(id);
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '删除失败'));
    }
  });

  /** 清 Cookie / Cache（不删环境）；需先关闭窗口 */
  router.post('/browser/clear', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      if (manager.getSession(id)) {
        await manager.closeProfile(id);
      }
      const result = clearProfileCache(id);
      res.json(ok(result));
    } catch (e) {
      res.json(fail(e.message || '清理失败'));
    }
  });

  router.post('/browser/proxy/update', authMiddleware, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const proxyType = String(req.body?.proxyType || 'noproxy');
      const host = String(req.body?.host || '');
      const port = Number(req.body?.port || 0);
      const proxyUserName = req.body?.proxyUserName || '';
      const proxyPassword = req.body?.proxyPassword || '';
      const proxyFields = {
        proxy_type: proxyType,
        proxy_host: host,
        proxy_port: port,
        proxy_user: proxyUserName,
        proxy_pass: proxyPassword,
      };

      let lastIp = '';
      let proxyError = '';
      let fields = { timezone: '', language: '', latitude: 0, longitude: 0, country: '' };
      for (const id of ids) {
        const row = db.getProfile(id);
        const gate = assertProfileOwner(req.currentUser, row, { write: true });
        if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
        const fp = JSON.parse(row.fingerprint_json || '{}');
        const resolved = await resolveGeoFromProxy(proxyFields, fp, {});
        lastIp = resolved.lastIp;
        fields = resolved.fields;
        if (resolved.proxyError) proxyError = resolved.proxyError;
        db.updateProfileProxy(id, {
          proxyType,
          host,
          port,
          proxyUserName,
          proxyPassword,
          lastIp,
          timezone: fields.timezone,
          language: fields.language,
          latitude: fields.latitude,
          longitude: fields.longitude,
          country: fields.country,
        });
        if (manager.getSession(id)) {
          await manager.closeProfile(id).catch(() => {});
        }
      }
      const payload = {
        ok: true,
        lastIp,
        timezone: fields.timezone,
        language: fields.language,
      };
      if (proxyError && !lastIp) {
        payload.proxyWarn = proxyError;
        payload.errCode = 'PROXY_PROBE_FAIL';
      }
      res.json(ok(payload));
    } catch (e) {
      const msg = e.message || '代理更新失败';
      res.json(fail(msg, 1, errCodeFromMessage(msg) || 'PROXY_ERROR'));
    }
  });

  router.post('/browser/update', authMiddleware, async (req, res) => {
    try {
      const user = req.currentUser;
      const body = req.body || {};
      const existingId = String(body.id || '').trim();
      const fp = mergeFingerprint(body.browserFingerPrint || body);
      const hasProxy = body.proxyType && body.proxyType !== 'noproxy' && body.host;
      const proxyFields = {
        proxy_type: hasProxy ? body.proxyType : 'noproxy',
        proxy_host: hasProxy ? String(body.host) : '',
        proxy_port: hasProxy ? Number(body.port) : 0,
        proxy_user: hasProxy ? String(body.proxyUserName || '') : '',
        proxy_pass: hasProxy ? String(body.proxyPassword || '') : '',
      };
      const { lastIp, fields, proxyError } = await resolveGeoFromProxy(proxyFields, fp, body);

      // 带 id：比特兼容 upsert（更新已有环境）
      if (existingId) {
        const existing = db.getProfile(existingId);
        const gate = assertProfileOwner(user, existing, { write: true });
        if (!gate.ok) return res.json(fail(gate.msg, 1, errCodeFromMessage(gate.msg) || 'FORBIDDEN'));
        const row = db.updateProfileMeta(existingId, {
          name: body.name != null ? body.name : existing.name,
          remark: body.remark != null ? body.remark : existing.remark,
          groupId: body.groupId || body.group_id || existing.group_id,
          platform: body.url || body.platform || existing.platform,
          fingerprint_json: fp,
          timezone: fields.timezone,
          language: fields.language,
          latitude: fields.latitude,
          longitude: fields.longitude,
          country: fields.country,
          last_ip: lastIp,
          ...proxyFields,
        });
        if (manager.getSession(existingId)) {
          await manager.closeProfile(existingId).catch(() => {});
        }
        const out = toBitProfile(row);
        if (proxyError && !lastIp) out.proxyWarn = proxyError;
        if (proxyError && !lastIp) out.errCode = 'PROXY_PROBE_FAIL';
        return res.json(ok(out));
      }

      // 额度归属：可显式指定 ownerId（超管再绑环境耗用指定管理用户额度）；否则记在当前登录用户
      const requestedOwner = Number(body.ownerId || body.owner_id || 0);
      const ownerId = requestedOwner > 0 ? requestedOwner : Number(user.id || 0);
      const row = db.createProfile({
        owner_id: ownerId,
        group_id: body.groupId || body.group_id || 'default',
        name: body.name || `TK-${Date.now()}`,
        remark: body.remark || '',
        platform: body.url || body.platform || 'https://www.tiktok.com',
        ...proxyFields,
        fingerprint_json: fp,
        timezone: fields.timezone,
        language: fields.language,
        latitude: fields.latitude,
        longitude: fields.longitude,
        country: fields.country,
        last_ip: lastIp,
      });
      const out = toBitProfile(row);
      if (proxyError && !lastIp) {
        out.proxyWarn = proxyError;
        out.errCode = 'PROXY_PROBE_FAIL';
      }
      res.json(ok(out));
    } catch (e) {
      const msg = e.message || '创建失败';
      res.json(fail(msg, 1, errCodeFromMessage(msg)));
    }
  });

  /** 更新备注 / 名称 / 分组（对齐比特管理体验） */
  router.post('/browser/update/partial', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      const updated = db.updateProfileMeta(id, {
        name: req.body?.name,
        remark: req.body?.remark,
        groupId: req.body?.groupId,
      });
      res.json(ok(toBitProfile(updated)));
    } catch (e) {
      res.json(fail(e.message || '更新失败'));
    }
  });

  return router;
}

module.exports = { createRouter, ok, fail, assertProfileOwner, strictEnvOwner };
