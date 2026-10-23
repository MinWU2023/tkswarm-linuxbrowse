const os = require('node:os');
const fs = require('node:fs');
const { PROFILES_DIR, DATA_ROOT, MAX_CONCURRENT_OPENS } = require('../config');
const manager = require('./manager');
const db = require('../db');

function diskUsageRough(dir) {
  try {
    if (!fs.existsSync(dir)) return { bytes: 0 };
    // 粗略：只统计一级子目录大小（避免全盘 walk 太慢）
    let bytes = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries.slice(0, 500)) {
      const p = require('node:path').join(dir, ent.name);
      try {
        const st = fs.statSync(p);
        bytes += st.size || 0;
        if (ent.isDirectory()) {
          for (const sub of fs.readdirSync(p).slice(0, 200)) {
            try {
              bytes += fs.statSync(require('node:path').join(p, sub)).size || 0;
            } catch { /* */ }
          }
        }
      } catch { /* */ }
    }
    return { bytes };
  } catch {
    return { bytes: 0 };
  }
}

function collectHealthExtras() {
  const windows = manager.listWindows();
  const mem = process.memoryUsage();
  const free = os.freemem();
  const total = os.totalmem();
  const profilesDisk = diskUsageRough(PROFILES_DIR);
  return {
    runningWindows: windows.length,
    maxConcurrent: MAX_CONCURRENT_OPENS,
    headlessWindows: windows.filter((w) => w.headless).length,
    headedWindows: windows.filter((w) => !w.headless).length,
    activeSessions: typeof db.countActiveSessions === 'function' ? db.countActiveSessions() : 0,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      systemFree: free,
      systemTotal: total,
    },
    disk: {
      dataRoot: DATA_ROOT,
      profilesBytesApprox: profilesDisk.bytes,
    },
  };
}

module.exports = { collectHealthExtras };
