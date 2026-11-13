/** 支持的 Chrome 内核档位（UA / Client Hints；实际二进制仍用本机 Chrome） */
const CORE_VERSIONS = ['120', '124', '128', '131', '136', '140', '144', '148', '150', '152', '154', '156', '157', '158', '159', '160'];

/**
 * 打开环境时探测到的真实内核版本。
 *
 * 服务器上装的 Chromium/Chrome 版本往往和指纹里选的档位差很远（例如内核 131、
 * 指纹写 148），页面做一次特性探测就能发现「UA 说 148、身上只有 131 的 API」。
 * 见 syncRealCoreVersion()。
 */
let REAL_CORE_VERSION = '';
let REAL_CORE_PROBED = false;

/**
 * 用真实内核版本同步指纹版本。
 * 只有与真实版本相差 >= 5 个大版本才强制纠正（尊重刻意选择的档位）。
 * @returns {string} 真实主版本号，探测失败返回 ''
 */
function syncRealCoreVersion() {
  if (REAL_CORE_PROBED) return REAL_CORE_VERSION;
  REAL_CORE_PROBED = true;
  try {
    const { detectChromeMajorVersion } = require('./chrome-path');
    REAL_CORE_VERSION = String(detectChromeMajorVersion() || '').trim();
  } catch {
    REAL_CORE_VERSION = '';
  }
  return REAL_CORE_VERSION;
}

/** 与真实内核版本对齐后的 coreVersion */
function alignedCoreVersion(rawWanted) {
  const real = syncRealCoreVersion();
  const wanted = String(rawWanted || '').match(/^(\d{2,3})/)?.[1] || '';
  if (!real) return wanted || DEFAULT_FP.coreVersion;
  if (!wanted) return real;
  if (Math.abs(Number(real) - Number(wanted)) >= 5) return real;
  return wanted;
}

const DEFAULT_FP = {
  coreVersion: '131',
  coreProduct: 'chrome',
  ostype: 'PC',
  os: process.platform === 'darwin' ? 'MacIntel' : 'Win32',
  isIpCreateTimeZone: true,
  isIpCreatePosition: true,
  isIpCreateLanguage: true,
  languages: 'en-US',
  resolutionType: '0',
  resolution: '1920 x 1080',
  webRTC: '0',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  devicePixelRatio: 1,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
};

/**
 * 按**指纹声称的操作系统**给出 sec-ch-ua-platform-version。
 *
 * ⚠ 关键区别：服务器跑 Linux，但指纹统一伪装成 Windows 桌面。
 * 这里绝不能读 process.platform —— 否则 Linux 服务器会输出 "6.5.0"，
 * 和自己声称的 Windows UA 直接矛盾，属于最容易被抓的一类破绽。
 *
 * 所以：声明 Win32 → Windows 10 的 "10.0.0"；声明 MacIntel → macOS 版本；
 * 只有真正声明 Linux 时才回退到内核版本。
 */
function platformVersionFor(fpOs, realPlatform = process.platform) {
  const os = String(fpOs || '');
  if (os === 'MacIntel') return '14.5.0';
  // 声称 Windows 就报 Windows 10 的 platformVersion（Win10 build < 22000）
  if (os === 'Win32' || os === 'Win64' || os === '') return '10.0.0';
  if (realPlatform === 'linux') return '6.5.0';
  return '10.0.0';
}

function normalizeCoreVersion(raw) {
  const v = String(raw || '').trim();
  const major = (v.match(/^(\d{2,3})/) || [])[1];
  if (major && CORE_VERSIONS.includes(major)) return major;
  // 允许接近档位：取最近的受支持版本
  if (major) {
    const n = Number(major);
    let best = CORE_VERSIONS[0];
    let dist = Infinity;
    for (const c of CORE_VERSIONS) {
      const d = Math.abs(Number(c) - n);
      if (d < dist) { dist = d; best = c; }
    }
    return best;
  }
  const real = syncRealCoreVersion();
  return real || DEFAULT_FP.coreVersion;
}

function mergeFingerprint(input = {}) {
  const fp = { ...DEFAULT_FP, ...(input || {}) };
  if (input?.browserFingerPrint) {
    Object.assign(fp, input.browserFingerPrint);
  }
  // UA 声称的版本必须与内核真实版本一致，否则一眼假
  fp.coreVersion = alignedCoreVersion(normalizeCoreVersion(fp.coreVersion));
  return fp;
}

function parseResolution(res) {
  const m = String(res || '1920 x 1080').match(/(\d+)\s*[x×]\s*(\d+)/i);
  return { width: Number(m?.[1] || 1920), height: Number(m?.[2] || 1080) };
}

function buildUserAgent(fp) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  if (fp.os === 'MacIntel') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
}

/** Sec-CH-UA 近似串（供后续 CDP Network 覆盖用） */
function buildSecChUa(fp = {}) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  return `"Not-A.Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`;
}

/**
 * 构造与 User-Agent 严格一致的 CDP userAgentMetadata，
 * 避免 Linux Chromium 原生 uaData（Linux / Chromium 130）或空 Sec-CH-UA 暴露真实内核。
 */
function buildUserAgentMetadata(fp = {}) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  const fullVer = `${ver}.0.0.0`;
  const isMac = fp.os === 'MacIntel';
  return {
    brands: [
      { brand: 'Not-A.Brand', version: '99' },
      { brand: 'Google Chrome', version: String(ver) },
      { brand: 'Chromium', version: String(ver) },
    ],
    fullVersionList: [
      { brand: 'Not-A.Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: fullVer },
      { brand: 'Chromium', version: fullVer },
    ],
    fullVersion: fullVer,
    platform: isMac ? 'macOS' : 'Windows',
    platformVersion: platformVersionFor(fp.os),
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/**
 * 构造与 User-Agent 一致的 HTTP Client Hints 请求头（供 Electron webRequest 与 CDP 兜底）
 */
function buildClientHintHeaders(fp = {}, locale = 'en-US') {
  const ver = normalizeCoreVersion(fp.coreVersion);
  const fullVer = `${ver}.0.0.0`;
  const isMac = fp.os === 'MacIntel';
  const primaryLang = String(locale || fp.languages || 'en-US').split(',')[0].trim() || 'en-US';
  const baseLang = primaryLang.split('-')[0] || 'en';
  const acceptLang = primaryLang.includes('-') && baseLang.toLowerCase() !== primaryLang.toLowerCase()
    ? `${primaryLang},${baseLang};q=0.9`
    : `${primaryLang};q=0.9`;
  return {
    'sec-ch-ua': `"Not-A.Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isMac ? '"macOS"' : '"Windows"',
    'sec-ch-ua-platform-version': `"${platformVersionFor(fp.os)}"`,
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-full-version': `"${fullVer}"`,
    'sec-ch-ua-full-version-list': `"Not-A.Brand";v="99.0.0.0", "Google Chrome";v="${fullVer}", "Chromium";v="${fullVer}"`,
    'accept-language': acceptLang,
  };
}

/* ------------------------------------------------------------------ *
 * 硬件指纹池
 *
 * 旧实现 DEFAULT_FP 写死 'Google Inc. (NVIDIA)' + GTX 1660，
 * **所有环境拿到完全相同的 WebGL 指纹**。平台只要把 renderer 当设备 ID 用，
 * 就能把这些"不同的人"归并到同一台机器，隔离等于没做。
 *
 * 做法：按环境 ID 哈希，从真实存在的 GPU 组合里确定性选一个。
 * - 同一环境每次打开结果一致（每刷新都变同样是异常特征）
 * - 不同环境分散到不同组合
 * - vendor / renderer / 核数 / 内存 / DPR 彼此搭配合理，避免「Intel 核显配 32G 显存」这种一眼假
 * ------------------------------------------------------------------ */
const GPU_POOL = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 4, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 16, dpr: 1.25 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 6, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 16, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1.25 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 4, mem: 4, dpr: 1 },
];

/** 分辨率候选，避免所有环境都是 1920x1080 */
const RESOLUTION_POOL = ['1920 x 1080', '1920 x 1080', '1920 x 1080', '2560 x 1440', '1600 x 900', '1536 x 864', '1366 x 768'];

function hashSeedKey(key) {
  let h = 2166136261;
  const s = String(key || 'tkswarm');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 按环境 ID 确定性地分配硬件指纹；只填用户没有显式配置的项。
 * @param {object} fp mergeFingerprint 的结果（就地修改）
 * @param {string} seedKey 环境 ID
 * @param {Set<string>} explicitKeys 用户显式配置过的字段
 */
function assignHardwareFingerprint(fp, seedKey, explicitKeys = new Set()) {
  const seed = hashSeedKey(seedKey);
  const gpu = GPU_POOL[seed % GPU_POOL.length];
  const want = (k) => !explicitKeys.has(k);

  if (want('webglVendor') || !fp.webglVendor) fp.webglVendor = gpu.vendor;
  if (want('webglRenderer') || !fp.webglRenderer) fp.webglRenderer = gpu.renderer;
  if (want('hardwareConcurrency') || !fp.hardwareConcurrency) fp.hardwareConcurrency = gpu.cores;
  if (want('deviceMemory') || !fp.deviceMemory) fp.deviceMemory = gpu.mem;
  if (want('devicePixelRatio') || !fp.devicePixelRatio) fp.devicePixelRatio = gpu.dpr;
  if (want('resolution') || !fp.resolution) {
    fp.resolution = RESOLUTION_POOL[(seed >>> 8) % RESOLUTION_POOL.length];
  }
  fp.fpSeed = seed;
  return fp;
}

/** 哪些指纹字段是调用方显式指定的（用于尊重用户配置） */
function explicitFingerprintKeys(input = {}) {
  const src = (input && input.browserFingerPrint) || input || {};
  const keys = new Set();
  for (const k of ['webglVendor', 'webglRenderer', 'hardwareConcurrency', 'deviceMemory', 'devicePixelRatio', 'resolution']) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') keys.add(k);
  }
  return keys;
}

module.exports = {
  mergeFingerprint,
  parseResolution,
  buildUserAgent,
  buildSecChUa,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  normalizeCoreVersion,
  syncRealCoreVersion,
  alignedCoreVersion,
  platformVersionFor,
  assignHardwareFingerprint,
  explicitFingerprintKeys,
  hashSeedKey,
  GPU_POOL,
  RESOLUTION_POOL,
  CORE_VERSIONS,
  DEFAULT_FP,
};
