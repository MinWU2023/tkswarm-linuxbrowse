/**
 * 浏览器后端统一入口：比特 / 第一页自研浏览器 共用比特兼容本地 API。
 * 业务层只应调用 getProvider()，不要直接 new BitBrowserProvider()。
 * 任务可经 runWithBrowserBackend / session.browserBackend 强制指定后端。
 */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { BitBrowserProvider } = require('./bit-browser-provider');
const phpApi = require('../php-api');

const PROVIDERS = {
  bit: { id: 'bit', name: '自研浏览器', ready: true },
  tkswarm: { id: 'tkswarm', name: '第一页自研浏览器', ready: true },
  auto: { id: 'auto', name: '自动探测', ready: true },
  adspower: { id: 'adspower', name: 'AdsPower', ready: false },
  vmlogin: { id: 'vmlogin', name: 'VMLogin', ready: false },
  playwright: { id: 'playwright', name: 'Playwright', ready: false },
};

/** @type {{ backend: string, label: string, at: number }|null} */
let cachedDetect = null;
const DETECT_TTL_MS = 15_000;
const backendAls = new AsyncLocalStorage();

function normalizeBackendId(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'linux' || v === 'tkswarm-linux' || v === 'tkswarm-linuxbrowse') return 'linux';
  if (v === 'tkswarm' || v === 'tkswarm-browses' || v === 'desktop') return 'tkswarm';
  if (v === 'bit') return 'bit';
  return null;
}

/** 展示用三类型标签 */
function backendTypeLabel(backend) {
  const b = normalizeBackendId(backend) || String(backend || '').toLowerCase();
  if (b === 'linux') return 'Linux';
  if (b === 'tkswarm') return '第一页自研浏览器';
  if (b === 'bit') return '自研浏览器';
  return '本地';
}

/**
 * 协议族：linux 与桌面同走 tkswarm Provider；绑定入库仍区分 linux。
 * @returns {'bit'|'tkswarm'}
 */
function protocolBackendId(backend) {
  const b = normalizeBackendId(backend);
  if (b === 'linux' || b === 'tkswarm') return 'tkswarm';
  return 'bit';
}

/** 当前异步上下文中的任务级后端（bit|tkswarm） */
function activeBackendOverride() {
  const fromAls = normalizeBackendId(backendAls.getStore()?.backend);
  if (fromAls) return fromAls;
  try {
    const { getSession } = require('../session-context');
    return normalizeBackendId(getSession()?.browserBackend);
  } catch {
    return null;
  }
}

/**
 * 在指定浏览器后端上下文中执行（供任务 runner / 批处理使用）。
 * @param {'bit'|'tkswarm'|string|null|undefined} backend
 * @param {() => any} fn
 */
function runWithBrowserBackend(backend, fn) {
  const b = normalizeBackendId(backend);
  if (!b) return fn();
  return backendAls.run({ backend: b }, fn);
}

function localSettingsPath() {
  return path.resolve(__dirname, '../../../data/local-settings.json');
}

function readLocalSetting(key, fallback) {
  try {
    const file = localSettingsPath();
    if (!fs.existsSync(file)) return fallback;
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return Object.prototype.hasOwnProperty.call(j, key) ? j[key] : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalSetting(key, value) {
  try {
    const file = localSettingsPath();
    const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {};
    j[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
  } catch { /* ignore */ }
}

function configuredBackend() {
  const raw = String(
    process.env.TKSWARM_BROWSER_BACKEND
    || readLocalSetting('browserBackend', 'auto')
    || 'auto'
  ).toLowerCase().trim();
  if (raw === 'bit' || raw === 'tkswarm' || raw === 'auto') return raw;
  return 'auto';
}

function labelFor(backend) {
  const b = normalizeBackendId(backend) || backend;
  if (b === 'linux') return '第一页自研浏览器 Linux';
  if (b === 'tkswarm') {
    const cached = String(cachedDetect?.label || '').trim();
    if (cached) return cached;
    const p = String(cachedDetect?.provider || '').toLowerCase();
    if (p === 'tkswarm-linuxbrowse') return '第一页自研浏览器 Linux';
    return '第一页自研浏览器';
  }
  if (b === 'bit') return '自研浏览器';
  return '本地浏览器';
}

/**
 * 协议探测：返回 bit|tkswarm（linux 协议归 tkswarm）。
 * 若需入库三类型，用 detectEnvTypeFromHealth。
 */
function detectFromHealth(healthPayload) {
  const kind = detectEnvTypeFromHealth(healthPayload);
  return kind === 'linux' ? 'tkswarm' : kind;
}

/** 环境类型三选一：bit | tkswarm | linux */
function detectEnvTypeFromHealth(healthPayload) {
  if (healthPayload && typeof healthPayload === 'object') {
    const p = String(healthPayload.provider || '').toLowerCase();
    const family = String(healthPayload.providerFamily || '').toLowerCase();
    if (p === 'tkswarm-linuxbrowse' || p === 'linux') return 'linux';
    if (p === 'tkswarm-browses' || family === 'tkswarm') return 'tkswarm';
  }
  return 'bit';
}

function listProviders() {
  return Object.values(PROVIDERS).filter((p) => p.id !== 'auto' || p.ready);
}

/** 服务器浏览器（Linux）默认地址：设置里可改，留空就用它 */
/** 内置执行器默认打本机 linuxbrowse 回环，禁止依赖旁路 Node 或远程写死 IP */
const DEFAULT_LINUX_BROWSER_API_URL = 'http://127.0.0.1:54345';

/**
 * 归一化服务器浏览器地址：
 * - 允许只填 IP:端口（自动补 http://）
 * - 去掉结尾的 / （用户习惯填 http://ip:port/）
 */
function normalizeLinuxApiUrl(raw) {
  let url = String(raw == null ? '' : raw).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

function resolveLinuxApiUrl() {
  const fromEnv = String(process.env.BIT_API_URL || process.env.TKSWARM_LINUX_BROWSER_API_URL || '').trim();
  if (fromEnv) return normalizeLinuxApiUrl(fromEnv);
  return normalizeLinuxApiUrl(readApiUrl('linuxBrowserApiUrl', '')) || DEFAULT_LINUX_BROWSER_API_URL;
}

function resolveBaseUrlFor(backend) {
  const main = readApiUrl('browserApiUrl', 'http://127.0.0.1:54345');
  // Linux 服务器浏览器是独立部署的常驻服务，必须有自己的地址（可与桌面端并存）
  if (backend === 'linux') return resolveLinuxApiUrl();
  if (backend === 'tkswarm') return readApiUrl('tkswarmBrowserApiUrl', '') || main;
  if (backend === 'bit') return readApiUrl('bitBrowserApiUrl', '') || main;
  return main;
}

function accountEnvIds(accountBundle) {
  const primary = String(accountBundle?.browser_profile_id || '').trim();
  const bitFromCol = String(accountBundle?.bit_browser_profile_id || '').trim();
  const tk = String(accountBundle?.tkswarm_browser_profile_id || '').trim();
  const linux = String(accountBundle?.linux_browser_profile_id || '').trim();
  // bit_browser_profile_id 来自 account_browser_envs；无专用列时回退主列（常为比特 ID）
  const bit = bitFromCol || primary;
  return { bit, tkswarm: tk, linux };
}

/**
 * 解析账号实际应使用的浏览器后端（bit | tkswarm | linux）。
 * 双绑定时：全局 auto/自研 或仅存在自研 ID 时优先自研，避免仍用过期比特主字段。
 */
function resolveEffectiveBackend(accountBundle, opts = {}) {
  const fromOpts = normalizeBackendId(opts.browserBackend);
  if (fromOpts) return fromOpts;
  const fromAls = activeBackendOverride();
  if (fromAls) return fromAls;

  const ids = accountEnvIds(accountBundle);
  const accountBe = normalizeBackendId(accountBundle?.browser_backend);
  const globalBe = configuredBackend();

  // Linux 服务器浏览器只供 AI 拓客 / 多账号客服这类长期占用任务显式指定，
  // 绝不因为账号上残留了 linux 环境 ID 就被普通任务自动选中。
  if (ids.tkswarm && ids.bit) return 'tkswarm';

  if (globalBe === 'tkswarm') {
    if (ids.tkswarm) return 'tkswarm';
    if (ids.bit) return 'bit';
    return 'tkswarm';
  }

  if (globalBe === 'auto') {
    const detected = normalizeBackendId(cachedDetect?.envType) || normalizeBackendId(cachedDetect?.backend);
    if ((detected === 'tkswarm' || detected === 'linux') && ids.tkswarm) return 'tkswarm';
    if (detected === 'bit' && ids.bit) return 'bit';
    if (ids.tkswarm && !ids.bit) return 'tkswarm';
    if (ids.bit) return 'bit';
    if (ids.tkswarm) return 'tkswarm';
    return accountBe === 'linux' ? 'bit' : (accountBe || 'bit');
  }

  if (ids.bit) return 'bit';
  if (ids.tkswarm) return 'tkswarm';
  return accountBe === 'linux' ? 'bit' : (accountBe || 'bit');
}

function profileIdForBackend(accountBundle, backend) {
  const ids = accountEnvIds(accountBundle);
  // linux：优先服务器绑定；无则回退自研桌面 ID（同 EL 核环境包，由 ensureServerBrowserEnv / hydrate 落盘）
  if (backend === 'linux') return ids.linux || ids.tkswarm;
  if (backend === 'tkswarm') return ids.tkswarm || ids.linux || ids.bit;
  return ids.bit || ids.tkswarm || ids.linux;
}

/** 某后端候选环境 ID（新 → 旧），旧环境已删时登录可自动换用再绑的新环境 */
function profileIdCandidatesForBackend(accountBundle, backend) {
  const b = normalizeBackendId(backend) || 'bit';
  const lists = accountBundle?.env_profile_ids || {};
  const ids = accountEnvIds(accountBundle);
  const key = b === 'linux' ? 'linux' : (b === 'tkswarm' ? 'tkswarm' : 'bit');
  const fromList = Array.isArray(lists[key])
    ? lists[key].map((id) => String(id).trim()).filter(Boolean)
    : [];
  const merged = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (s && !merged.includes(s)) merged.push(s);
  };
  for (const id of fromList) push(id);
  push(profileIdForBackend(accountBundle, b));
  // 服务器浏览器与桌面自研共用环境包：linux 任务也试 tkswarm 绑定 ID（不含比特）
  if (b === 'linux') {
    const tkList = Array.isArray(lists.tkswarm)
      ? lists.tkswarm.map((id) => String(id).trim()).filter(Boolean)
      : [];
    for (const id of tkList) push(id);
    push(ids.tkswarm);
  }
  return merged;
}

/**
 * 按后端解析账号应打开的环境 ID。
 * @param {object} accountBundle
 * @param {{ browserBackend?: string, profileId?: string, browserProfileId?: string }} [opts]
 */
function resolveProfileIdForAccount(accountBundle, opts = {}) {
  const forced = String(opts.browserProfileId || opts.profileId || '').trim();
  if (forced) return forced;
  try {
    const { getSessionProfileId } = require('../session-context');
    const leased = String(getSessionProfileId() || '').trim();
    if (leased) return leased;
  } catch { /* ignore */ }
  const backend = normalizeBackendId(opts.browserBackend)
    || resolveEffectiveBackend(accountBundle, opts);
  return profileIdForBackend(accountBundle, backend);
}

/**
 * 业务统一：按当前后端解析 provider + profileId。
 * @param {object} accountBundle
 * @param {{ browserBackend?: string, profileId?: string, browserProfileId?: string, requireProfile?: boolean }} [opts]
 * @returns {{ provider: import('./bit-browser-provider').BitBrowserProvider, profileId: string, backend: string, label: string }}
 */
function resolveAccountBrowser(accountBundle, opts = {}) {
  const backend = normalizeBackendId(opts.browserBackend)
    || resolveEffectiveBackend(accountBundle, opts);
  const provider = getProvider(normalizeBackendId(backend) || protocolBackendId(backend));
  const profileId = resolveProfileIdForAccount(accountBundle, {
    ...opts,
    browserBackend: backend,
  });
  if (opts.requireProfile !== false && !profileId) {
    throw new Error('账号尚未绑定浏览器环境（请确认当前浏览器后端下已创建/绑定环境）');
  }
  return {
    provider,
    profileId: String(profileId || ''),
    backend,
    label: provider.backendLabel || labelFor(backend),
  };
}

/**
 * 同步获取 Provider（协议兼容，均为 BitBrowserProvider）。
 * @param {string} [type] 强制类型；省略则读任务上下文 / browserBackend 配置
 */
function getProvider(type) {
  const forcedType = type ? String(type).toLowerCase() : '';
  const override = !forcedType ? activeBackendOverride() : null;
  const configured = forcedType || override || configuredBackend();
  let backend = configured;
  if (backend === 'auto') {
    backend = cachedDetect?.backend || 'bit';
  }
  // linux 协议并入 tkswarm Provider
  const protocol = protocolBackendId(backend) || (backend === 'auto' ? 'bit' : backend);
  const meta = PROVIDERS[protocol] || PROVIDERS.bit;
  if (!meta.ready && protocol !== 'auto' && protocol !== 'bit' && protocol !== 'tkswarm') {
    throw new Error(`${meta.name} 正在开发中，当前仅支持自研浏览器 / Linux`);
  }
  if (protocol === 'bit' || protocol === 'tkswarm' || backend === 'auto') {
    const id = backend === 'auto' ? (cachedDetect?.backend || 'bit') : protocol;
    const envKind = normalizeBackendId(backend) === 'linux'
      ? 'linux'
      : (cachedDetect?.envType || id);
    const isLinux = envKind === 'linux';
    const provider = new BitBrowserProvider({
      // Linux 服务器浏览器：独立地址 + 独立 Token，固定不被全局配置覆盖
      baseUrl: resolveBaseUrlFor(isLinux ? 'linux' : id),
      apiToken: isLinux ? readApiUrl('linuxBrowserApiToken', '') : undefined,
      backendId: id === 'linux' ? 'tkswarm' : id,
      backendLabel: labelFor(envKind === 'linux' ? 'linux' : id),
      envType: envKind === 'linux' ? 'linux' : (id === 'tkswarm' ? 'tkswarm' : 'bit'),
      pinBaseUrl: isLinux ? true : undefined,
    });
    // BitBrowserProvider 不保存 envType，这里补上，状态接口/日志靠它区分桌面自研与 Linux
    provider.envType = envKind === 'linux' ? 'linux' : (id === 'tkswarm' ? 'tkswarm' : 'bit');
    return provider;
  }
  throw new Error(`未知浏览器类型：${type || configured}`);
}

/**
 * 异步获取 Provider；auto 模式下会先 health 探测并缓存结果。
 */
async function getProviderAsync(type) {
  // 从 PHP 设置同步浏览器相关键到本地，供同步 getProvider / 分 URL 使用
  try {
    const dataStore = require('../data-store');
    const remote = await dataStore.getSetting('browserBackend', null);
    if (remote === 'auto' || remote === 'bit' || remote === 'tkswarm' || remote === 'linux') {
      writeLocalSetting('browserBackend', remote);
    }
    for (const key of ['browserApiUrl', 'bitBrowserApiUrl', 'tkswarmBrowserApiUrl', 'linuxBrowserApiUrl', 'browserApiToken', 'tkswarmBrowserApiToken', 'linuxBrowserApiToken']) {
      const v = await dataStore.getSetting(key, null);
      if (v != null && String(v).trim() !== '') writeLocalSetting(key, v);
    }
  } catch { /* keep local */ }

  let configured = type ? String(type).toLowerCase() : configuredBackend();
  if (configured === 'auto') {
    const now = Date.now();
    if (!cachedDetect || now - cachedDetect.at > DETECT_TTL_MS) {
      try {
        const avail = await probeAvailableBackends();
        const hit = avail.preferred ? avail[avail.preferred] : null;
        if (hit?.provider) {
          const envType = hit.provider.envType
            || (hit.detected === 'tkswarm' ? (detectEnvTypeFromHealth(hit.health) === 'linux' ? 'linux' : 'tkswarm') : 'bit');
          cachedDetect = {
            backend: envType === 'linux' ? 'tkswarm' : (hit.detected || 'bit'),
            envType,
            provider: String(hit.health?.provider || hit.health?.data?.provider || '').toLowerCase(),
            label: hit.provider.backendLabel || labelFor(envType),
            at: now,
            apiUrl: hit.url,
          };
        } else {
          cachedDetect = { backend: 'bit', envType: 'bit', provider: '', label: labelFor('bit'), at: now };
        }
      } catch {
        cachedDetect = { backend: 'bit', envType: 'bit', provider: '', label: labelFor('bit'), at: now };
      }
    }
  } else {
    const envType = normalizeBackendId(configured) || configured;
    cachedDetect = {
      backend: protocolBackendId(configured) || configured,
      envType,
      label: labelFor(envType),
      at: Date.now(),
    };
  }
  return getProvider(configured === 'auto' ? undefined : configured);
}

function getCachedBackend() {
  const configured = configuredBackend();
  if (configured !== 'auto') {
    const envType = normalizeBackendId(configured) || configured;
    return { configured, backend: protocolBackendId(configured) || configured, envType, label: labelFor(envType) };
  }
  return {
    configured: 'auto',
    backend: cachedDetect?.backend || 'unknown',
    envType: cachedDetect?.envType || cachedDetect?.backend || 'unknown',
    label: cachedDetect?.label || '本地浏览器（自动）',
  };
}

function clearBackendCache() {
  cachedDetect = null;
}

function readApiUrl(key, fallback) {
  try {
    const file = localSettingsPath();
    if (!fs.existsSync(file)) return fallback;
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return j[key] || fallback;
  } catch {
    return fallback;
  }
}

const LOCAL_BROWSER_FALLBACK_PORTS = [54345, 54352, 54346];

function normProbeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
    .replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
    .replace(/^https:\/\/localhost(?=[:/]|$)/i, 'https://127.0.0.1');
}

/** 配置地址 + 本机常用端口，避免填错端口时误判离线 */
function buildLocalBrowserProbeUrls() {
  const mainUrl = readApiUrl('browserApiUrl', 'http://127.0.0.1:54345');
  const tkUrl = readApiUrl('tkswarmBrowserApiUrl', '') || mainUrl;
  const bitUrl = readApiUrl('bitBrowserApiUrl', '') || mainUrl;
  const out = new Set();
  for (const u of [mainUrl, tkUrl, bitUrl]) {
    const n = normProbeUrl(u);
    if (n) out.add(n);
  }
  for (const port of LOCAL_BROWSER_FALLBACK_PORTS) {
    out.add(`http://127.0.0.1:${port}`);
  }
  return [...out];
}

function maybeAutoFixBrowserApiUrl(workingUrl, backend = '') {
  const hit = normProbeUrl(workingUrl);
  if (!hit || !/^https?:\/\/127\.0\.0\.1:\d+$/i.test(hit)) return false;
  // 按识别到的后端写专用键，避免把全局 browserApiUrl 改成自研端口后带偏比特
  const key = backend === 'tkswarm' ? 'tkswarmBrowserApiUrl' : (backend === 'bit' ? 'bitBrowserApiUrl' : 'browserApiUrl');
  const configured = normProbeUrl(readApiUrl(key, '') || readApiUrl('browserApiUrl', 'http://127.0.0.1:54345'));
  if (configured === hit) return false;
  writeLocalSetting(key, hit);
  try {
    const dataStore = require('../data-store');
    dataStore.setSetting(key, hit).catch(() => {});
  } catch { /* ignore */ }
  return true;
}

/**
 * 探测本机可用后端：比特 / TkSwarm；两者都在线时优先 tkswarm（自研）。
 * @returns {Promise<{ bit: object|null, tkswarm: object|null, preferred: 'bit'|'tkswarm'|null, autoFixedUrl?: string }>}
 */
async function probeAvailableBackends() {
  const mainUrl = readApiUrl('browserApiUrl', 'http://127.0.0.1:54345');
  const tkUrl = readApiUrl('tkswarmBrowserApiUrl', '') || mainUrl;
  const bitUrl = readApiUrl('bitBrowserApiUrl', '') || mainUrl;
  const token = readApiUrl('browserApiToken', '');
  // 自研客户端默认不校验 Token，带比特 Token 反而会被拒（token 无效或已过期）
  const tkToken = readApiUrl('tkswarmBrowserApiToken', '');
  let autoFixedUrl = '';

  async function probeOnce(url, forceId, apiToken) {
    try {
      const p = new BitBrowserProvider({
        baseUrl: url,
        apiToken,
        backendId: forceId,
        backendLabel: labelFor(forceId === 'auto' ? 'bit' : forceId),
        pinBaseUrl: true,
      });
      const health = await p.health();
      const detected = detectFromHealth(health);
      await p.profiles(0, 1);
      return {
        online: true,
        url: normProbeUrl(url),
        detected,
        health,
        provider: p,
      };
    } catch {
      return null;
    }
  }

  /**
   * 依次尝试候选 Token：自研不校验 Token（带错误 Token 会被拒），比特通常必填。
   * 同一端口可能换着跑比特/自研，因此逐个 Token 试到通为止。
   */
  async function probe(url, forceId) {
    const sessionToken = phpApi.getAuthTokenBare();
    const candidates = forceId === 'tkswarm'
      ? [tkToken, sessionToken, token]
      : (forceId === 'bit' ? [token, tkToken] : [token, tkToken, sessionToken, '']);
    for (const tk of [...new Set(candidates)]) {
      const hit = await probeOnce(url, forceId, tk);
      if (hit) return hit;
    }
    return null;
  }

  function wrapHit(hit, id) {
    if (!hit) return null;
    const envType = hit.detected === 'tkswarm'
      ? (detectEnvTypeFromHealth(hit.health) === 'linux' ? 'linux' : 'tkswarm')
      : 'bit';
    const backendId = envType === 'linux' ? 'tkswarm' : (hit.detected === 'tkswarm' ? 'tkswarm' : 'bit');
    const apiToken = backendId === 'tkswarm'
      ? (tkToken || phpApi.getAuthTokenBare() || token)
      : token;
    const provider = new BitBrowserProvider({
      baseUrl: hit.url,
      apiToken,
      backendId,
      backendLabel: labelFor(envType),
    });
    provider.envType = envType;
    return { ...hit, provider };
  }

  let bit = null;
  let tkswarm = null;

  const sameUrl = normProbeUrl(bitUrl) === normProbeUrl(tkUrl);
  if (sameUrl) {
    for (const url of buildLocalBrowserProbeUrls()) {
      const one = await probe(url, 'auto');
      if (!one) continue;
      if (maybeAutoFixBrowserApiUrl(one.url, one.detected)) autoFixedUrl = one.url;
      if (one.detected === 'tkswarm') tkswarm = wrapHit(one, 'tkswarm');
      else bit = wrapHit(one, 'bit');
      break;
    }
  } else {
    const bitCandidates = [...new Set([normProbeUrl(bitUrl), ...buildLocalBrowserProbeUrls()])];
    const tkCandidates = [...new Set([normProbeUrl(tkUrl), ...buildLocalBrowserProbeUrls()])];
    for (const url of bitCandidates) {
      const one = await probe(url, 'bit');
      if (!one) continue;
      if (maybeAutoFixBrowserApiUrl(one.url, one.detected)) autoFixedUrl = one.url;
      if (one.detected === 'tkswarm') tkswarm = wrapHit(one, 'tkswarm');
      else bit = wrapHit(one, 'bit');
      break;
    }
    for (const url of tkCandidates) {
      const one = await probe(url, 'tkswarm');
      if (!one) continue;
      if (one.detected === 'tkswarm') {
        tkswarm = wrapHit(one, 'tkswarm');
        break;
      }
      if (!bit) bit = wrapHit(one, 'bit');
    }
  }

  let preferred = null;
  if (tkswarm) preferred = 'tkswarm';
  else if (bit) preferred = 'bit';

  return { bit, tkswarm, preferred, autoFixedUrl };
}

/**
 * 创建/再绑环境：强制 bit/tkswarm/linux 尊重设置；auto 时优先自研。
 * 返回的 backend 为入库三类型 bit|tkswarm|linux。
 */
async function resolvePreferredCreateProvider() {
  const configured = configuredBackend();
  if (configured === 'bit' || configured === 'tkswarm' || configured === 'linux') {
    const p = await getProviderAsync(configured);
    const envType = normalizeBackendId(configured) || configured;
    p.envType = envType;
    return {
      provider: p,
      backend: envType,
      label: p.backendLabel || labelFor(envType),
    };
  }

  const avail = await probeAvailableBackends();
  if (avail.preferred === 'tkswarm' && avail.tkswarm?.provider) {
    const health = avail.tkswarm.health;
    const envType = detectEnvTypeFromHealth(health) === 'linux' ? 'linux' : 'tkswarm';
    cachedDetect = { backend: 'tkswarm', envType, label: labelFor(envType), at: Date.now() };
    const p = avail.tkswarm.provider;
    p.backendId = 'tkswarm';
    p.envType = envType;
    p.backendLabel = labelFor(envType);
    return { provider: p, backend: envType, label: labelFor(envType), available: avail };
  }
  if (avail.preferred === 'bit' && avail.bit?.provider) {
    cachedDetect = { backend: 'bit', envType: 'bit', label: labelFor('bit'), at: Date.now() };
    const p = avail.bit.provider;
    p.backendId = 'bit';
    p.envType = 'bit';
    p.backendLabel = labelFor('bit');
    return { provider: p, backend: 'bit', label: labelFor('bit'), available: avail };
  }

  const p = await getProviderAsync('auto');
  const envType = cachedDetect?.envType || p.envType || p.backendId || 'bit';
  return {
    provider: p,
    backend: envType,
    label: p.backendLabel || labelFor(envType),
    available: avail,
  };
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  getProviderAsync,
  configuredBackend,
  detectFromHealth,
  detectEnvTypeFromHealth,
  labelFor,
  backendTypeLabel,
  protocolBackendId,
  getCachedBackend,
  clearBackendCache,
  probeAvailableBackends,
  resolvePreferredCreateProvider,
  runWithBrowserBackend,
  activeBackendOverride,
  resolveProfileIdForAccount,
  resolveEffectiveBackend,
  resolveAccountBrowser,
  profileIdCandidatesForBackend,
  normalizeBackendId,
  DEFAULT_LINUX_BROWSER_API_URL,
  normalizeLinuxApiUrl,
  resolveLinuxApiUrl,
};
