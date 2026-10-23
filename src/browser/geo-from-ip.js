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

function httpJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
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
 * @param {string} ip
 * @returns {Promise<{ ip, country, countryCode, timezone, language, latitude, longitude, city }>}
 */
async function lookupGeoByIp(ip) {
  const clean = String(ip || '').trim();
  if (!clean || !/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return emptyGeo(clean);
  }
  try {
    // ip-api.com 免费非商用；失败则回退空结果
    const data = await httpJson(`http://ip-api.com/json/${clean}?fields=status,message,country,countryCode,city,lat,lon,timezone,query`);
    if (data?.status !== 'success') {
      return emptyGeo(clean, data?.message);
    }
    const cc = String(data.countryCode || '').toUpperCase();
    return {
      ip: data.query || clean,
      country: data.country || '',
      countryCode: cc,
      city: data.city || '',
      timezone: data.timezone || 'UTC',
      language: COUNTRY_LOCALE[cc] || 'en-US',
      latitude: Number(data.lat) || 0,
      longitude: Number(data.lon) || 0,
    };
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
 */
function applyIpCreateFields(fp = {}, geo = {}, body = {}) {
  const out = {
    timezone: body.timezone || '',
    language: body.language || '',
    latitude: body.latitude != null ? Number(body.latitude) : null,
    longitude: body.longitude != null ? Number(body.longitude) : null,
    country: body.country || geo.country || '',
  };
  if (!out.timezone) {
    if (fp.isIpCreateTimeZone !== false && geo.timezone) out.timezone = geo.timezone;
    else out.timezone = 'America/New_York';
  }
  if (!out.language) {
    if (fp.isIpCreateLanguage !== false && geo.language) out.language = geo.language;
    else out.language = fp.languages || 'en-US';
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

module.exports = { lookupGeoByIp, applyIpCreateFields, COUNTRY_LOCALE };
