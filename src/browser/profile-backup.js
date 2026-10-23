/**
 * Profile 打包导出 / 导入：meta.json + userdata（Cookie 等）。
 * 优先系统 tar；不可用时用目录拷贝包（.tkpack 目录再打 zip via tar 或直接目录）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { PROFILES_DIR, DATA_ROOT, PROVIDER_ID, VERSION, HOST_ID } = require('../config');
const { profileRoot } = require('./profile-cleanup');
const db = require('../db');

const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');
const SKIP_NAMES = new Set([
  '.tkswarm-chrome.pid',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
]);

function ensureExportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  return EXPORTS_DIR;
}

function hasTar() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(src)) return;
  for (const name of fs.readdirSync(src)) {
    if (SKIP_NAMES.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDirFiltered(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 导出环境为 .tgz（含 meta + userdata）
 * @returns {{ filePath: string, fileName: string, bytes: number }}
 */
function exportProfilePack(profileId, { closeFirst } = {}) {
  const id = String(profileId);
  const row = db.getProfile(id);
  if (!row) throw new Error('环境不存在');

  ensureExportsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `tkswarm-profile-${id.slice(0, 12)}-${stamp}.tgz`;
  const filePath = path.join(EXPORTS_DIR, fileName);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-lb-export-'));

  try {
    const meta = {
      format: 'tkswarm-linuxbrowse-profile',
      formatVersion: 1,
      provider: PROVIDER_ID,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      profile: { ...row },
      note: closeFirst ? 'exported-after-close-hint' : 'export-live-ok-if-idle',
    };
    fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    const ud = path.join(work, 'userdata');
    copyDirFiltered(profileRoot(id), ud);

    if (!hasTar()) {
      // 无 tar：落盘为目录包（同名去 .tgz）
      const dirPack = filePath.replace(/\.tgz$/i, '.tkpack');
      if (fs.existsSync(dirPack)) fs.rmSync(dirPack, { recursive: true, force: true });
      fs.cpSync(work, dirPack, { recursive: true });
      return {
        filePath: dirPack,
        fileName: path.basename(dirPack),
        bytes: dirSize(dirPack),
        kind: 'tkpack',
      };
    }

    const r = spawnSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', filePath, '-C', work, 'meta.json', 'userdata'],
      { encoding: 'utf8' }
    );
    if (r.status !== 0) {
      throw new Error(r.stderr || r.stdout || 'tar 打包失败');
    }
    const st = fs.statSync(filePath);
    return { filePath, fileName, bytes: st.size, kind: 'tgz' };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
}

function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else n += st.size;
    }
  };
  try { walk(dir); } catch { /* */ }
  return n;
}

function extractTgz(tgzPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xzf', tgzPath, '-C', destDir],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(r.stderr || '解压失败');
}

/**
 * @param {string} packPath .tgz 或 .tkpack 目录
 * @param {{ ownerId: number, keepId?: boolean, newName?: string }} opts
 */
function importProfilePack(packPath, opts = {}) {
  const ownerId = Number(opts.ownerId || 0);
  if (!ownerId) throw new Error('缺少 ownerId');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-lb-import-'));
  try {
    const st = fs.statSync(packPath);
    if (st.isDirectory()) {
      fs.cpSync(packPath, work, { recursive: true });
    } else {
      if (!hasTar()) throw new Error('系统无 tar，无法解压 .tgz');
      extractTgz(packPath, work);
    }

    const metaPath = path.join(work, 'meta.json');
    if (!fs.existsSync(metaPath)) throw new Error('包内缺少 meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.format !== 'tkswarm-linuxbrowse-profile') {
      throw new Error('不是本服务的 Profile 包');
    }
    const src = meta.profile || {};
    const keepId = opts.keepId !== false && src.id && !db.getProfile(src.id);
    const id = keepId ? String(src.id) : undefined;

    const row = db.createProfile({
      id,
      owner_id: ownerId,
      group_id: src.group_id || 'default',
      name: opts.newName || `${src.name || 'imported'} (导入)`,
      remark: src.remark || '',
      platform: src.platform,
      proxy_type: src.proxy_type,
      proxy_host: src.proxy_host,
      proxy_port: src.proxy_port,
      proxy_user: src.proxy_user,
      proxy_pass: src.proxy_pass,
      fingerprint_json: src.fingerprint_json,
      timezone: src.timezone,
      language: src.language,
      latitude: src.latitude,
      longitude: src.longitude,
      country: src.country,
      last_ip: src.last_ip,
      // 导入到本机即视为重绑
      bound_host_id: HOST_ID,
    });

    const udSrc = path.join(work, 'userdata');
    const udDest = profileRoot(row.id);
    if (fs.existsSync(udSrc)) {
      if (fs.existsSync(udDest)) fs.rmSync(udDest, { recursive: true, force: true });
      fs.cpSync(udSrc, udDest, { recursive: true });
    }
    return { profile: row, sourceId: src.id || null };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
}

function listExportFiles() {
  ensureExportsDir();
  return fs.readdirSync(EXPORTS_DIR)
    .filter((n) => /\.(tgz|tkpack)$/i.test(n) || fs.statSync(path.join(EXPORTS_DIR, n)).isDirectory())
    .map((name) => {
      const p = path.join(EXPORTS_DIR, name);
      const st = fs.statSync(p);
      return {
        name,
        path: p,
        bytes: st.isDirectory() ? dirSize(p) : st.size,
        mtime: st.mtime.toISOString(),
        kind: st.isDirectory() || /\.tkpack$/i.test(name) ? 'tkpack' : 'tgz',
      };
    })
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
}

function resolveExportFile(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.includes('..')) return null;
  const p = path.join(EXPORTS_DIR, base);
  if (!fs.existsSync(p)) return null;
  return p;
}

module.exports = {
  exportProfilePack,
  importProfilePack,
  listExportFiles,
  resolveExportFile,
  EXPORTS_DIR,
  ensureExportsDir,
};
