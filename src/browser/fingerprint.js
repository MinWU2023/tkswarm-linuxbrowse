/** 支持的 Chrome 内核档位（UA / Client Hints；实际二进制仍用本机 Chrome） */
const CORE_VERSIONS = ['120', '124', '128', '131', '136', '148'];

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
  return DEFAULT_FP.coreVersion;
}

function mergeFingerprint(input = {}) {
  const fp = { ...DEFAULT_FP, ...(input || {}) };
  if (input?.browserFingerPrint) {
    Object.assign(fp, input.browserFingerPrint);
  }
  fp.coreVersion = normalizeCoreVersion(fp.coreVersion);
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
    platformVersion: isMac ? '14.5.0' : '10.0.0',
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
    'sec-ch-ua-platform-version': isMac ? '"14.5.0"' : '"10.0.0"',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-full-version': `"${fullVer}"`,
    'sec-ch-ua-full-version-list': `"Not-A.Brand";v="99.0.0.0", "Google Chrome";v="${fullVer}", "Chromium";v="${fullVer}"`,
    'accept-language': acceptLang,
  };
}

module.exports = {
  mergeFingerprint,
  parseResolution,
  buildUserAgent,
  buildSecChUa,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  normalizeCoreVersion,
  CORE_VERSIONS,
  DEFAULT_FP,
};
