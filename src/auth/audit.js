/**
 * 关键操作审计：JSONL 追加到数据目录。
 * 开启：默认开；TKSWARM_AUDIT=0 关闭。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_ROOT } = require('../config');

const ENABLED = String(process.env.TKSWARM_AUDIT || '1') !== '0';
const LOG_PATH = path.join(DATA_ROOT, 'audit.jsonl');
const MAX_BYTES = Number(process.env.TKSWARM_AUDIT_MAX_BYTES || 20 * 1024 * 1024);

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const st = fs.statSync(LOG_PATH);
    if (st.size < MAX_BYTES) return;
    const bak = `${LOG_PATH}.${Date.now()}.bak`;
    fs.renameSync(LOG_PATH, bak);
  } catch { /* */ }
}

/**
 * @param {string} event
 * @param {object} [detail]
 */
function audit(event, detail = {}) {
  if (!ENABLED) return;
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    rotateIfNeeded();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event: String(event || 'unknown'),
      ...detail,
    });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch { /* 审计失败不影响主路径 */ }
}

function readRecent(limit = 100) {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const slice = lines.slice(-Math.min(500, Math.max(1, limit)));
    return slice.map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    }).reverse();
  } catch {
    return [];
  }
}

module.exports = { audit, readRecent, LOG_PATH, ENABLED };
