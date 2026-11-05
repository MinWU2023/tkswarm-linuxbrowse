const fs = require('node:fs');
const path = require('node:path');
const dataStore = require('../data-store');
const phpApi = require('../php-api');

function readLocalSettings() {
  try {
    const file = path.resolve(__dirname, '../../../data/local-settings.json');
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function settingSync(key, fallback) {
  const local = readLocalSettings();
  if (key === 'browserApiUrl') {
    return process.env.BIT_API_URL || local.browserApiUrl || fallback;
  }
  if (key === 'browserApiToken') {
    return process.env.BIT_API_TOKEN || local.browserApiToken || fallback;
  }
  if (key === 'tkswarmBrowserApiToken') {
    if (Object.prototype.hasOwnProperty.call(local, 'tkswarmBrowserApiToken')) {
      return local.tkswarmBrowserApiToken == null ? '' : String(local.tkswarmBrowserApiToken);
    }
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(local, key)) return local[key];
  return fallback;
}

function normalizeBitBaseUrl(url) {
  let raw = String(url || 'http://127.0.0.1:54345').trim().replace(/\/+$/, '');
  if (!raw) raw = 'http://127.0.0.1:54345';
  // localhost 在部分 Windows / Node 上会走 IPv6(::1)，比特本地服务只监听 127.0.0.1
  raw = raw.replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1');
  raw = raw.replace(/^https:\/\/localhost(?=[:/]|$)/i, 'https://127.0.0.1');
  return raw;
}

function isBitSuccess(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === true || result.success === 'true' || result.success === 1) return true;
  if (result.code === 0 || result.code === '0') return true;
  return false;
}

function nestErrCode(error) {
  let cur = error;
  for (let i = 0; i < 4 && cur; i += 1) {
    if (cur.code) return String(cur.code);
    cur = cur.cause;
  }
  return '';
}

function friendlyBitBusinessError(raw, endpoint = '', errCode = '') {
  const msg = String(raw || '').trim();
  const code = String(errCode || '').trim().toUpperCase();
  if (code === 'HOST_MISMATCH' || /绑定主机|HOST_MISMATCH/i.test(msg)) {
    return `环境已绑定其他主机，无法在本机打开。请导出后导入，或调用 host/rebind。${msg ? `（${msg}）` : ''}`;
  }
  if (code === 'CONCURRENT_LIMIT' || /同时打开窗口已达上限|MAX_CONCURRENT/i.test(msg)) {
    return `同时打开的浏览器窗口已达上限，请先关闭部分环境后再试。${msg ? `（${msg}）` : ''}`;
  }
  if (code === 'TOKEN_INVALID' || code === 'AUTH_REQUIRED') {
    return [
      '本地浏览器账号未登录或 API Token 已失效。',
      '请打开本地浏览器重新登录，并到「设置」核对 Token。',
      msg ? `原始返回：${msg}。` : '',
      endpoint ? `（接口：${endpoint}）` : '',
    ].filter(Boolean).join('');
  }
  if (code === 'PROXY_PROBE_FAIL' || code === 'PROXY_ERROR') {
    return `代理/出口 IP 探测失败：${msg || '请检查代理后重试'}`;
  }
  if (code === 'NOT_RUNNING') {
    return `浏览器环境未在运行：${msg || '请先打开环境'}`;
  }
  if (!msg) return '本地浏览器请求失败';
  // 客户端主账号已退出 / 本地 API token 失效：health 仍可能成功，但 list/open 失败
  if (/login\s*out/i.test(msg) || /token\s*(失效|无效|过期|invalid|expire)/i.test(msg) || /请.*登录状态|重新登录|未登录/.test(msg)) {
    const why = /login\s*out/i.test(msg)
      ? '客户端桌面端尚未登录（返回 Login out）'
      : `客户端判定 Token 不一致（返回 ${msg}）`;
    return [
      `本地浏览器账号未登录或 API Token 已失效：${why}。`,
      '请打开本地浏览器完成登录后再试；自研客户端默认不校验 Token，「设置 → 第一页自研浏览器专用 Token」留空即可。',
      endpoint ? `（接口：${endpoint}）` : '',
    ].filter(Boolean).join('');
  }
  if (/权限不足|无权|无权限|not\s*allow|permission|forbidden/i.test(msg)) {
    const isOpen = /open|打开/i.test(String(endpoint || ''));
    if (isOpen) {
      return [
        '本地浏览器拒绝打开环境：当前客户端仍按创建者隔离，或开启了 TKSWARM_STRICT_ENV_OWNER。',
        '请升级自研桌面/Linux 浏览器到「本机环境共用」版本，并确认未设置 STRICT_ENV_OWNER=1。',
        endpoint ? `（接口：${endpoint}）` : '',
      ].filter(Boolean).join('');
    }
    return [
      '本地浏览器拒绝操作：删除/改配置在严格隔离模式下仅创建者可写；打开环境默认应共用。',
      '请检查：1) 客户端已登录；2) 升级至最新版本；3) 未设置 TKSWARM_STRICT_ENV_OWNER=1。',
      endpoint ? `（接口：${endpoint}）` : '',
    ].filter(Boolean).join('');
  }
  if (/不存在|not\s*found|已删除|找不到/i.test(msg) && /browser|窗口|环境|profile/i.test(`${msg} ${endpoint}`)) {
    return `浏览器环境不存在或已删除。请在账号里解绑后重新「创建环境」。原错误：${msg}`;
  }
  return msg;
}

function friendlyBitConnectError(error, baseUrl) {
  const code = nestErrCode(error);
  const msg = String(error?.message || '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return `无法连接本地浏览器 API（${baseUrl}）。请确认：1) 自研浏览器已登录运行；2) 本地 API 已开启；3) 端口与地址一致（默认 54345）。`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|getaddrinfo/i.test(msg)) {
    return `浏览器 API 地址无法解析（${baseUrl}）。请改回 http://127.0.0.1:54345，不要填云端域名。`;
  }
  if (code === 'ETIMEDOUT' || /timeout|ETIMEDOUT/i.test(msg)) {
    return `连接本地浏览器 API 超时（${baseUrl}）。请检查防火墙，或重启浏览器客户端后重试。`;
  }
  if (/fetch failed/i.test(msg)) {
    return `无法访问本地浏览器 API（${baseUrl}）。请先启动自研浏览器并启用本地 API。`;
  }
  return msg || '本地浏览器请求失败';
}

function normalizeOpenData(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.ws) return data;
  // 少数版本只回 http，补成 CDP ws
  const http = String(data.http || data.httpUrl || '').trim();
  if (http) {
    const host = http.replace(/^https?:\/\//i, '');
    return { ...data, ws: `ws://${host}/devtools/browser` };
  }
  return data;
}

class BitBrowserProvider {
  constructor(opts = {}) {
    const url = opts.baseUrl || settingSync('browserApiUrl', 'http://127.0.0.1:54345');
    this.baseUrl = normalizeBitBaseUrl(url);
    this.backendId = opts.backendId || 'bit';
    // 自研不继承比特的 Token：带错 Token 会被客户端判为「token 无效或已过期」
    const defaultToken = this.backendId === 'tkswarm' ? '' : settingSync('browserApiToken', '');
    this.apiToken = String(opts.apiToken != null ? opts.apiToken : defaultToken);
    this.backendLabel = opts.backendLabel || '本地浏览器';
    this._pinBaseUrl = !!opts.pinBaseUrl;
  }

  async refreshConfig() {
    if (this._pinBaseUrl) return;
    try {
      // 按后端优先读专用 URL，避免 tkswarm Provider 被主 browserApiUrl 覆盖
      const preferKey = this.backendId === 'tkswarm'
        ? 'tkswarmBrowserApiUrl'
        : (this.backendId === 'bit' ? 'bitBrowserApiUrl' : 'browserApiUrl');
      let url = await dataStore.getSetting(preferKey, '');
      if (!url) url = await dataStore.getSetting('browserApiUrl', this.baseUrl);
      // Token：比特用主 Token；自研/Linux 默认空（本机控制台已登录即可共用环境）。
      // 仅当本机 local-settings 手动配置了 tkswarmBrowserApiToken 才带 Bearer；
      // 绝不回落到 PHP 会话 Token / 比特 Token（A/B 换人后会 Login out）。
      let token;
      if (this.backendId === 'tkswarm') {
        token = await dataStore.getSetting('tkswarmBrowserApiToken', '');
        token = token == null ? '' : String(token).trim();
      } else {
        token = await dataStore.getSetting('browserApiToken', this.apiToken);
      }
      if (url) this.baseUrl = normalizeBitBaseUrl(url);
      if (token != null) this.apiToken = String(token);
    } catch { /* keep sync defaults */ }
  }

  async request(endpoint, payload = {}, timeoutMs = 15000) {
    await this.refreshConfig();
    const withAuth = !!this.apiToken;
    try {
      return await this.sendOnce(endpoint, payload, timeoutMs, withAuth);
    } catch (error) {
      const msg = String(error?.message || '');
      const authIssue = /未登录|Login out|token\s*(无效|失效|过期|invalid|expire)|API Token 已失效|重新登录/i.test(msg);
      if (withAuth && authIssue) {
        // Token 与本机客户端不一致时自动去掉 Token 重试一次：
        // 自研（tkswarm-browses）默认不校验 Token，带上不匹配的 Token 反而会被拒
        try {
          const data = await this.sendOnce(endpoint, payload, timeoutMs, false);
          this.apiToken = '';
          this.tokenAutoDropped = true;
          return data;
        } catch { /* 保留第一次的错误信息 */ }
      }
      throw error;
    }
  }

  async sendOnce(endpoint, payload, timeoutMs, withAuth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (withAuth && this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
      const response = await fetch(`${this.baseUrl}/${endpoint.replace(/^\//, '')}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') || '';
        throw new Error(`本地浏览器 API 返回重定向（${response.status}${location ? ` → ${location}` : ''}），请检查本地浏览器服务和环境 ID`);
      }
      const text = await response.text();
      let result;
      try {
        result = text ? JSON.parse(text) : { success: response.ok };
      } catch {
        throw new Error(`本地浏览器返回了非 JSON 数据（HTTP ${response.status}）`);
      }
      if (!response.ok || !isBitSuccess(result)) {
        const raw = result.msg || result.message || result.error || `本地浏览器请求失败（HTTP ${response.status}）`;
        const errCode = result.errCode || result.data?.errCode || '';
        const err = new Error(friendlyBitBusinessError(raw, endpoint, errCode));
        err.rawMessage = String(result.msg || result.message || '');
        err.businessCode = String(result.code ?? '');
        throw err;
      }
      return result.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`本地浏览器请求超时：${endpoint}`);
      // 已是友好中文业务错误则原样抛出（保留 rawMessage 供诊断）
      if (error instanceof Error && error.rawMessage) throw error;
      if (error && error.message && /比特|自研浏览器|BitBrowser|本地 API|比特浏览器拒绝|本地浏览器/i.test(error.message) && !/fetch failed/i.test(error.message)) {
        throw error;
      }
      throw new Error(friendlyBitConnectError(error, this.baseUrl));
    } finally {
      clearTimeout(timer);
    }
  }

  health() { return this.request('health', {}); }
  groups(page = 0, pageSize = 100) { return this.request('group/list', { page, pageSize }); }
  profiles(page = 0, pageSize = 100, name = '') { return this.request('browser/list', { page, pageSize, name }); }

  async open(id, options = {}) {
    const profileId = String(id || '').trim();
    if (!profileId) throw new Error('缺少浏览器环境 ID，请先给账号创建/绑定浏览器环境');
    const payload = {
      id: profileId,
      // 排队打开，避免批量登录并发打爆本地 API
      queue: options.queue !== false,
      forceRelaunch: Boolean(options.forceRelaunch),
    };
    if (options.fastOpen) payload.fastOpen = true;
    if (options.headless) {
      payload.args = Array.isArray(options.args) && options.args.length
        ? options.args
        : ['--headless=new', '--disable-gpu'];
    }
    try {
      const data = normalizeOpenData(await this.request('browser/open', payload, 60000));
      if (!data?.ws) {
        throw new Error('本地浏览器已响应，但未返回 CDP WebSocket 地址。请确认本地 API 正常或升级客户端');
      }
      return data;
    } catch (error) {
      const msg = String(error?.message || '');
      if (/权限不足|无权|拒绝操作/i.test(msg)) {
        throw new Error(`${msg}（环境ID：${profileId.slice(0, 8)}…）`);
      }
      throw error;
    }
  }

  close(id) {
    // 诊断：记录是谁调用了关窗（定位「登录后黑屏」）
    try {
      const stack = String(new Error().stack || '').split('\n').slice(2, 6).map((s) => s.trim()).join(' <- ');
      console.warn(`[provider.close] id=${String(id || '').slice(0, 8)}… 调用方: ${stack}`);
    } catch { /* ignore */ }
    return this.request('browser/close', { id: String(id || '') }, 30000);
  }
  delete(id) { return this.request('browser/delete', { id: String(id || '') }, 30000); }
  detail(id) { return this.request('browser/detail', { id: String(id || '') }); }

  /** 导出本地环境包（同机 filePath，供上传中心库） */
  exportPack(id, opts = {}) {
    const payload = { id: String(id || '') };
    // live=true：窗口保持打开，在线导出
    if (opts.live) payload.live = true;
    return this.request('browser/export', payload, 120000);
  }

  /**
   * 从本机包路径导入环境（keepId 强制同 ID）
   * @param {{ filePath: string, id?: string, keepId?: boolean, forceOverwrite?: boolean }} opts
   */
  importPack(opts = {}) {
    return this.request('browser/import', {
      filePath: String(opts.filePath || ''),
      id: String(opts.id || ''),
      keepId: opts.keepId !== false,
      forceOverwrite: opts.forceOverwrite !== false,
    }, 120000);
  }

  /**
   * Linux Browser 窗口保活（桌面/比特可忽略失败）。
   * keepBrowser 批任务期间、子任务切换前调用，避免 SESSION_STALE 误关。
   */
  async heartbeat(id) {
    const profileId = String(id || '').trim();
    if (!profileId) return null;
    try {
      return await this.request('browser/heartbeat', { id: profileId }, 10000);
    } catch {
      return null;
    }
  }

  /** 比特 proxyType：http / https / socks5 / noproxy */
  normalizeProxyType(protocol) {
    const p = String(protocol || '').trim().toLowerCase();
    if (!p || p === 'noproxy' || p === 'none') return 'noproxy';
    if (p === 'socks' || p === 'socks5' || p === 'socks5h') return 'socks5';
    if (p === 'https' || p === 'http') return p;
    return 'http';
  }

  /**
   * 把账号绑定的代理写入已有比特环境（登录前同步，避免环境里还是失效 SOCKS）
   * 优先走专用接口 /browser/proxy/update；勿用 /browser/update 只改代理（指纹对象必传，容易改失败）。
   * 须在 browser/open 之前调用。
   */
  async updateProxy(id, proxy = null) {
    const profileId = String(id || '').trim();
    if (!profileId) throw new Error('缺少浏览器环境 ID，无法同步代理');
    const hasProxy = Boolean(proxy?.host && proxy?.port);
    const proxyType = hasProxy ? this.normalizeProxyType(proxy.protocol) : 'noproxy';
    const portNum = hasProxy ? Number(proxy.port) : 0;
    // 专用批量改代理接口（官方推荐），不碰指纹
    await this.request('browser/proxy/update', {
      ids: [profileId],
      ipCheckService: 'ip-api',
      proxyMethod: 2,
      proxyType,
      host: hasProxy ? String(proxy.host) : '',
      port: hasProxy ? portNum : 0,
      proxyUserName: hasProxy ? String(proxy.username || '') : '',
      proxyPassword: hasProxy ? String(proxy.password || '') : '',
    }, 30000);

    // 回读确认，避免「同步成功」但窗口仍是旧 SOCKS
    const detail = await this.detail(profileId).catch(() => null);
    if (!detail) return detail;
    const gotType = String(detail.proxyType || '').toLowerCase();
    const gotHost = String(detail.host || '');
    const gotPort = Number(detail.port || 0);
    if (!hasProxy) {
      if (gotType && gotType !== 'noproxy' && gotHost) {
        throw new Error(`浏览器环境代理未清空（仍为 ${gotType} ${gotHost}:${gotPort}）`);
      }
      return detail;
    }
    if (gotType !== proxyType || gotHost !== String(proxy.host) || gotPort !== portNum) {
      throw new Error(
        `浏览器环境代理未写入成功：期望 ${proxyType}://${proxy.host}:${portNum}，实际 ${gotType}://${gotHost}:${gotPort || '-'}`
      );
    }
    const sentUser = hasProxy ? String(proxy.username || '').trim() : '';
    const sentPass = hasProxy ? String(proxy.password || '') : '';
    const gotUser = String(detail.proxyUserName || detail.proxy_user || '').trim();
    const gotPass = String(detail.proxyPassword || detail.proxy_pass || '');
    if (hasProxy && sentUser && !gotUser) {
      throw new Error(`浏览器环境代理用户名未写入（期望已设置 ${sentUser.slice(0, 8)}…）`);
    }
    if (hasProxy && sentPass && !gotPass) {
      throw new Error('浏览器环境代理密码未写入（Node 已发送密码但环境内仍为空，请重开自研浏览器后再登录）');
    }
    const needsAuth = proxyType === 'socks5' && Boolean(sentUser || sentPass);
    if (hasProxy && needsAuth && !gotPass) {
      throw new Error('SOCKS5 代理需要密码，但浏览器环境内 proxy_pass 为空（自研浏览器无法建认证桥）');
    }
    if (hasProxy && needsAuth && sentUser && !sentPass) {
      throw new Error('SOCKS5 代理账密不完整：有用户名但密码为空，请检查中心库 proxies 表或重新同步代理');
    }
    return detail;
  }

  create({
    name,
    username = '',
    remark = '',
    proxy = null,
    language = 'en-US',
    coreVersion = '148',
    groupId = '',
    ownerId = 0,
    maxEnvs,
  } = {}) {
    const hasProxy = Boolean(proxy?.host && proxy?.port);
    const proxyType = hasProxy ? this.normalizeProxyType(proxy.protocol) : 'noproxy';
    const oid = Number(ownerId) || 0;
    const quota = Number(maxEnvs);
    return this.request('browser/update', {
      platform: 'https://www.tiktok.com',
      platformIcon: 'other',
      url: 'https://www.tiktok.com',
      name,
      remark,
      groupId: groupId || undefined,
      // 自研/Linux：按管理用户计环境额度；比特忽略
      ...(oid > 0 ? { ownerId: oid, owner_id: oid } : {}),
      ...(Number.isFinite(quota) && quota > 0 ? { maxEnvs: quota, max_envs: quota } : {}),
      // Keep platform username blank. TikTok's username is stored only in TkSwarm;
      // BitBrowser rejects creation when a deleted/hidden profile has the same username.
      userName: '',
      password: '',
      cookie: '',
      otherCookie: '',
      isGlobalProxyInfo: false,
      proxyMethod: 2,
      proxyType,
      host: hasProxy ? proxy.host : '',
      port: hasProxy ? proxy.port : '',
      proxyUserName: hasProxy ? proxy.username : '',
      proxyPassword: hasProxy ? proxy.password : '',
      ipCheckService: 'ip2location',
      browserFingerPrint: {
        coreVersion: String(coreVersion || '148'),
        ostype: 'PC',
        os: 'Win32',
        isIpCreateTimeZone: true,
        isIpCreatePosition: true,
        isIpCreateLanguage: true,
        languages: language,
        resolutionType: '0',
        resolution: '1920 x 1080',
        webRTC: '0',
      },
    }, 30000);
  }

  sanitizeProfile(profile) {
    return {
      id: profile.id,
      seq: profile.seq,
      code: profile.code,
      name: profile.name,
      remark: profile.remark,
      status: profile.status,
      platform: profile.platform,
      proxyType: profile.proxyType,
      host: profile.host,
      port: profile.port,
      country: profile.country || profile.lastCountry,
      lastIp: profile.lastIp,
      coreProduct: profile.coreProduct,
      coreVersion: profile.coreVersion,
      createdTime: profile.createdTime,
      updateTime: profile.updateTime,
    };
  }
}

module.exports = { BitBrowserProvider };
