/**
 * 将 TikTok 展示的计数文案转为整数，再与下限比较。
 * 支持：16.2K、1.2M、16.2W、16.2万、1,234,567、162000 等。
 *
 * 单位约定：
 *   K/k → ×1,000
 *   M/m → ×1,000,000
 *   B/b → ×1,000,000,000
 *   W/w/万 → ×10,000
 *   亿 → ×100,000,000
 */
function parseMetricCount(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));

  let s = String(raw).trim();
  if (!s) return 0;

  // 全角数字 / 标点 / 不间断空格
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/，/g, ',').replace(/．/g, '.');
  s = s.replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, ' ');

  // 从整段文案中提取第一个「数字 + 可选单位」（如 "16.2K Followers" → 16.2K）
  const m = s.match(
    /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i
  );
  if (!m) {
    const digits = s.replace(/[^\d]/g, '');
    const n = parseInt(digits, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  const numStr = m[1].replace(/,/g, '');
  let n = parseFloat(numStr);
  if (!Number.isFinite(n)) return 0;

  const u = (m[2] || '').toLowerCase();
  if (u === 'k') n *= 1000;
  else if (u === 'm') n *= 1000000;
  else if (u === 'b') n *= 1000000000;
  else if (u === 'w' || u === '万') n *= 10000;
  else if (u === '亿') n *= 100000000;

  return Math.max(0, Math.round(n));
}

/** 供 page.evaluate 注入：必须是完整函数体，不能转发 Node 侧 parseMetricCount */
function parseMetricCountInBrowser(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  let s = String(raw).trim();
  if (!s) return 0;
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/，/g, ',').replace(/．/g, '.');
  s = s.replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, ' ');
  const m = s.match(
    /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i
  );
  if (!m) {
    const digits = s.replace(/[^\d]/g, '');
    const n = parseInt(digits, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  const numStr = m[1].replace(/,/g, '');
  let n = parseFloat(numStr);
  if (!Number.isFinite(n)) return 0;
  const u = (m[2] || '').toLowerCase();
  if (u === 'k') n *= 1000;
  else if (u === 'm') n *= 1000000;
  else if (u === 'b') n *= 1000000000;
  else if (u === 'w' || u === '万') n *= 10000;
  else if (u === '亿') n *= 100000000;
  return Math.max(0, Math.round(n));
}

/**
 * 从文案中按标签提取计数原文（粉丝/获赞/播放）。
 * 注意：labelBody 不要带 ^$，否则合写 "243.1K Likes" 会匹配失败。
 */
function pickLabeledMetricText(text, labelBody) {
  const s = String(text || '').replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || !labelBody) return '';
  const body = String(labelBody).replace(/^\^/, '').replace(/\$$/, '');
  const combined = new RegExp(
    `([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?\\s*[·•.\\-–—]?\\s*(?:${body})`,
    'i'
  );
  const combinedRev = new RegExp(
    `(?:${body})\\s*[·•.\\-–—]?\\s*([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?`,
    'i'
  );
  const m = s.match(combined) || s.match(combinedRev);
  return m ? m[0] : '';
}

module.exports = {
  parseMetricCount,
  parseMetricCountInBrowser,
  pickLabeledMetricText,
  /** @deprecated 使用 parseMetricCount */
  parseCount: parseMetricCount,
};
