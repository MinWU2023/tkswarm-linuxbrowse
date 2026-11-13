/**
 * 根据出口 IP 推断时区 / 语言 / 经纬度（对齐比特 isIpCreate* 行为）。
 */
const http = require('node:http');
const https = require('node:https');

const COUNTRY_LOCALE = {
  US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  RU: 'ru-RU', TR: 'tr-TR', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID',
  IN: 'en-IN', MX: 'es-MX', PH: 'en-PH', SG: 'en-SG', MY: 'en-MY',
};

/**
 * 国家码 → 代表时区（地理查询全部失败时的兜底）。
 * 旧实现兜底写死 'America/New_York'，导致「代理在亚洲，时区报纽约」这种
 * 比不设置更危险的硬矛盾。
 */
const COUNTRY_TIMEZONE = {
  US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo',
  GB: 'Europe/London', IE: 'Europe/Dublin', DE: 'Europe/Berlin', FR: 'Europe/Paris',
  ES: 'Europe/Madrid', IT: 'Europe/Rome', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels',
  CH: 'Europe/Zurich', AT: 'Europe/Vienna', SE: 'Europe/Stockholm', NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow', UA: 'Europe/Kiev', TR: 'Europe/Istanbul', CZ: 'Europe/Prague',
  GR: 'Europe/Athens', RO: 'Europe/Bucharest', HU: 'Europe/Budapest',
  CN: 'Asia/Shanghai', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', ID: 'Asia/Jakarta', PH: 'Asia/Manila',
  IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh', IL: 'Asia/Jerusalem', KZ: 'Asia/Almaty',
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
  ZA: 'Africa/Johannesburg', EG: 'Africa/Cairo', NG: 'Africa/Lagos', KE: 'Africa/Nairobi',
};

/** 一个国家多个时区时按经度挑最近的一个 */
const COUNTRY_MULTI_TIMEZONE = {
  US: [
    { tz: 'America/New_York', lon: -74 }, { tz: 'America/Chicago', lon: -87.6 },
    { tz: 'America/Denver', lon: -105 }, { tz: 'America/Los_Angeles', lon: -118.2 },
    { tz: 'America/Phoenix', lon: -112 },
  ],
  CA: [
    { tz: 'America/Toronto', lon: -79.4 }, { tz: 'America/Vancouver', lon: -123.1 },
    { tz: 'America/Edmonton', lon: -113.5 },
  ],
  AU: [
    { tz: 'Australia/Sydney', lon: 151.2 }, { tz: 'Australia/Perth', lon: 115.9 },
    { tz: 'Australia/Adelaide', lon: 138.6 }, { tz: 'Australia/Brisbane', lon: 153 },
  ],
  RU: [
    { tz: 'Europe/Moscow', lon: 37.6 }, { tz: 'Asia/Novosibirsk', lon: 82.9 },
    { tz: 'Asia/Vladivostok', lon: 131.9 },
  ],
  BR: [
    { tz: 'America/Sao_Paulo', lon: -46.6 }, { tz: 'America/Manaus', lon: -60 },
  ],
};

function httpJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: { accept: 'application/json', 'user-agent': 'tkswarm-linuxbrowse/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('geo lookup timeout'));
    });
  });
}

/**
 * 多源查询地理信息。
 *
 * 旧实现只有 ip-api.com 一个来源（HTTP、限流 45 次/分），一旦失败就静默回落到
 * 写死的美国东部时区 —— 代理明明在欧洲却报纽约。这里改成三源级联，任一成功即可。
 */
async function lookupGeoMultiSource(ip) {
  const sources = [
    {
      url: `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,lat,lon,timezone,query`,
      parse: (d) => (d?.status === 'success' ? {
        country: d.country, countryCode: d.countryCode, city: d.city,
        timezone: d.timezone, latitude: d.lat, longitude: d.lon, ip: d.query,
      } : null),
    },
    {
      url: `https://ipapi.co/${ip}/json/`,
      parse: (d) => (d && !d.error ? {
        country: d.country_name, countryCode: d.country_code, city: d.city,
        timezone: d.timezone, latitude: d.latitude, longitude: d.longitude, ip: d.ip,
      } : null),
    },
    {
      url: `https://ipwho.is/${ip}`,
      parse: (d) => (d?.success !== false && d?.country_code ? {
        country: d.country, countryCode: d.country_code, city: d.city,
        timezone: d.timezone?.id, latitude: d.latitude, longitude: d.longitude, ip: d.ip,
      } : null),
    },
  ];

  for (const src of sources) {
    try {
      const data = await httpJson(src.url, 6000);
      const parsed = src.parse(data);
      if (parsed && parsed.countryCode) {
        const cc = String(parsed.countryCode || '').toUpperCase();
        return {
          ip: parsed.ip || ip,
          country: parsed.country || '',
          countryCode: cc,
          city: parsed.city || '',
          timezone: parsed.timezone || '',
          language: COUNTRY_LOCALE[cc] || '',
          latitude: Number(parsed.latitude) || 0,
          longitude: Number(parsed.longitude) || 0,
        };
      }
    } catch { /* 换下一个源 */ }
  }
  return null;
}

/**
 * @param {string} ip
 * @returns {Promise<{ ip, country, countryCode, timezone, language, latitude, longitude, city }>}
 */
async function lookupGeoByIp(ip) {
  const clean = String(ip || '').trim();
  if (!clean || !/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return emptyGeo(clean);
  }
  try {
    const hit = await lookupGeoMultiSource(clean);
    if (hit) return hit;
    return emptyGeo(clean, 'all geo sources failed');
  } catch (e) {
    return emptyGeo(clean, e.message);
  }
}

function emptyGeo(ip = '', error = '') {
  return {
    ip: ip || '',
    country: '',
    countryCode: '',
    city: '',
    timezone: '',
    language: '',
    latitude: 0,
    longitude: 0,
    error: error || '',
  };
}

/**
 * 按指纹开关，把出口 IP 地理信息合并进 profile 创建/更新字段。
 *
 * 时区兜底改为「按国家码推断」，未知则留空（跟随系统），
 * 绝不伪造一个错误时区 —— 那比不设置更容易暴露。
 */
function applyIpCreateFields(fp = {}, geo = {}, body = {}) {
  const out = {
    timezone: body.timezone || '',
    language: body.language || '',
    latitude: body.latitude != null ? Number(body.latitude) : null,
    longitude: body.longitude != null ? Number(body.longitude) : null,
    country: body.country || geo.country || '',
  };
  const cc = String(geo.countryCode || '').toUpperCase();
  if (!out.timezone) {
    if (fp.isIpCreateTimeZone !== false && geo.timezone) out.timezone = geo.timezone;
    else out.timezone = COUNTRY_TIMEZONE[cc] || '';
  }
  if (!out.language) {
    if (fp.isIpCreateLanguage !== false && geo.language) out.language = geo.language;
    else out.language = COUNTRY_LOCALE[cc] || fp.languages || 'en-US';
  }
  if (out.latitude == null || out.longitude == null) {
    if (fp.isIpCreatePosition !== false && geo.latitude && geo.longitude) {
      out.latitude = geo.latitude;
      out.longitude = geo.longitude;
    } else {
      out.latitude = out.latitude ?? 0;
      out.longitude = out.longitude ?? 0;
    }
  }
  return out;
}

/** 按国家 + 经度给出最合理的时区 */
function timezoneForCountry(countryCode, longitude) {
  const cc = String(countryCode || '').toUpperCase();
  if (!cc) return '';
  const multi = COUNTRY_MULTI_TIMEZONE[cc];
  if (multi && multi.length) {
    const lon = Number(longitude);
    if (Number.isFinite(lon)) {
      let best = multi[0];
      let dist = Infinity;
      for (const item of multi) {
        const d = Math.abs(item.lon - lon);
        if (d < dist) { dist = d; best = item; }
      }
      return best.tz;
    }
    return multi[0].tz;
  }
  return COUNTRY_TIMEZONE[cc] || '';
}

/** 按国家给语言 */
function languageForCountry(countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  return COUNTRY_LOCALE[cc] || '';
}

/**
 * 把 fp 的时区/语言强制对齐到 IP 所在国家。
 *
 * 「美国 IP + 上海时区 + 中文」这类组合是风控最容易识破的矛盾。
 * 这里统一收口，并返回冲突说明供创建接口提示用户。
 *
 * @param {object} fp 会被就地修改
 * @param {{ countryCode?: string, timezone?: string, longitude?: number, latitude?: number }} geo
 * @param {{ force?: boolean }} [opts]
 * @returns {{ changed: string[], conflicts: string[], timezone: string, language: string }}
 */
function alignRegionToProxy(fp = {}, geo = {}, opts = {}) {
  const cc = String(geo.countryCode || '').toUpperCase();
  const force = opts.force === true;
  const changed = [];
  const conflicts = [];
  if (!cc) {
    return {
      changed,
      conflicts: ['未能识别代理 IP 的国家，时区/语言未对齐'],
      timezone: fp.timezone || '',
      language: fp.language || '',
    };
  }

  const wantTz = timezoneForCountry(cc, geo.longitude);
  const wantLang = languageForCountry(cc);

  if (wantTz) {
    const cur = String(fp.timezone || '').trim();
    if (!cur || force) {
      if (cur !== wantTz) { fp.timezone = wantTz; changed.push(`时区 ${cur || '(空)'} → ${wantTz}`); }
    } else if (cur !== wantTz) {
      conflicts.push(`时区与代理地区不符：${cur}，代理国家 ${cc} 应为 ${wantTz}`);
      if (force) fp.timezone = wantTz;
    }
  }

  if (wantLang) {
    const cur = String(fp.language || fp.languages || '').trim();
    if (!cur || force) {
      if (cur !== wantLang) {
        fp.language = wantLang;
        fp.languages = wantLang;
        changed.push(`语言 ${cur || '(空)'} → ${wantLang}`);
      }
    } else if (cur.toLowerCase() !== wantLang.toLowerCase()) {
      conflicts.push(`语言与代理地区不符：${cur}，代理国家 ${cc} 应为 ${wantLang}`);
      if (force) { fp.language = wantLang; fp.languages = wantLang; }
    }
  }

  if (geo.latitude != null && geo.longitude != null) {
    if (fp.latitude == null || force) fp.latitude = Number(geo.latitude);
    if (fp.longitude == null || force) fp.longitude = Number(geo.longitude);
  }

  return {
    changed,
    conflicts,
    timezone: fp.timezone || '',
    language: fp.language || fp.languages || '',
  };
}

module.exports = {
  lookupGeoByIp,
  lookupGeoMultiSource,
  applyIpCreateFields,
  alignRegionToProxy,
  timezoneForCountry,
  languageForCountry,
  COUNTRY_LOCALE,
  COUNTRY_TIMEZONE,
  COUNTRY_MULTI_TIMEZONE,
};
