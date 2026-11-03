/**
 * Profile 打包导出 / 导入：meta.json + userdata（仅登录会话）。
 * 统一 format：tkswarm-browser-profile（兼容旧 tkswarm-linuxbrowse-profile）。
 *
 * 白名单只打 Cookies / Local Storage / Preferences；不打 IndexedDB、Service Worker、Cache。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { PROFILES_DIR, DATA_ROOT, PROVIDER_ID, VERSION, HOST_ID } = require('../config');
const { profileRoot } = require('./profile-cleanup');
const db = require('../db');

const FORMAT = 'tkswarm-browser-profile';
const LEGACY_FORMATS = new Set(['tkswarm-browser-profile', 'tkswarm-linuxbrowse-profile']);

const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');

/** 仅打包登录会话相关路径（相对 user-data-dir） */
const SESSION_KEEP_RELS = [
  'Local State',
  'First Run',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Network/Network Persistent State',
  'Default/Network/TransportSecurity',
  'Default/Extension Cookies',
  'Default/Extension Cookies-journal',
];

const SKIP_NAMES = new Set([
  '.tkswarm-chrome.pid',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DawnCache',
  'Crashpad',
  'BrowserMetrics',
  'component_crx_cache',
  'optimization_guide_model_store',
  'IndexedDB',
  'Service Worker',
  'Service Workers',
  'CacheStorage',
  'blob_storage',
  'File System',
  'VideoDecodeStats',
  'History',
  'Favicons',
  'shared_proto_db',
  'Platform Notifications',
]);

function ensureExportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  return EXPORTS_DIR;
}

function tarBin() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

/** Windows bsdtar 会把 `\` 当转义，传给 tar 的路径改用正斜杠 */
function toTarArg(p) {
  const abs = path.resolve(String(p || ''));
  return process.platform === 'win32' ? abs.replace(/\\/g, '/') : abs;
}

function hasTar() {
  try {
    const r = spawnSync(tarBin(), ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
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
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyDirFiltered(from, to);
    else fs.copyFileSync(from, to);
  }
}

function copySessionOnly(srcRoot, destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  if (!fs.existsSync(srcRoot)) return;
  for (const rel of SESSION_KEEP_RELS) {
    const parts = String(rel).split('/').filter(Boolean);
    const from = path.join(srcRoot, ...parts);
    if (!fs.existsSync(from)) continue;
    const to = path.join(destRoot, ...parts);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      copyDirFiltered(from, to);
    } else if (st.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
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

/**
 * 导出环境为 .tgz（含 meta + userdata）
 * @returns {{ filePath: string, fileName: string, bytes: number, kind: string }}
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
      format: FORMAT,
      formatVersion: 1,
      provider: PROVIDER_ID,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      profile: { ...row },
      note: closeFirst ? 'exported-after-close-hint' : 'export-live-ok-if-idle',
    };
    fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    const ud = path.join(work, 'userdata');
    // 会话白名单：不打 Cache / IndexedDB / Service Worker 等
    copySessionOnly(profileRoot(id), ud);

    if (!hasTar()) {
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

    // 在 work 内用相对名打包，避开 Windows tar 吃掉反斜杠 / 中文路径
    const tmpTgz = path.join(work, fileName);
    const r = spawnSync(
      tarBin(),
      ['-czf', fileName, 'meta.json', 'userdata'],
      { encoding: 'utf8', cwd: work, windowsHide: true },
    );
    if (r.status !== 0 || !fs.existsSync(tmpTgz)) {
      const dirPack = filePath.replace(/\.tgz$/i, '.tkpack');
      if (fs.existsSync(dirPack)) fs.rmSync(dirPack, { recursive: true, force: true });
      fs.cpSync(work, dirPack, {
        recursive: true,
        filter: (src) => path.basename(src) !== fileName,
      });
      if (r.status !== 0) {
        console.warn('[profile-backup] tar 失败，已回退 .tkpack:', r.stderr || r.stdout || r.status);
      }
      return {
        filePath: dirPack,
        fileName: path.basename(dirPack),
        bytes: dirSize(dirPack),
        kind: 'tkpack',
      };
    }
    fs.copyFileSync(tmpTgz, filePath);
    const st = fs.statSync(filePath);
    return { filePath, fileName, bytes: st.size, kind: 'tgz' };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
}

function extractTgz(tgzPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(
    tarBin(),
    ['-xzf', toTarArg(tgzPath), '-C', toTarArg(destDir)],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(r.stderr || '解压失败');
}

/**
 * @param {string} packPath .tgz 或 .tkpack 目录
 * @param {{ ownerId: number, keepId?: boolean, forceOverwrite?: boolean, newName?: string }} opts
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
    if (!LEGACY_FORMATS.has(String(meta.format || ''))) {
      throw new Error('不是受支持的 Profile 包');
    }
    const src = meta.profile || {};
    const forceOverwrite = opts.forceOverwrite === true;
    const wantKeepId = opts.keepId !== false && src.id;
    const existing = wantKeepId ? db.getProfile(String(src.id)) : null;

    let row;
    if (existing && (wantKeepId || forceOverwrite)) {
      const id = String(src.id);
      row = db.updateProfileMeta(id, {
        name: opts.newName || src.name || existing.name,
        remark: src.remark != null ? src.remark : existing.remark,
        groupId: src.group_id || existing.group_id,
        platform: src.platform || existing.platform,
        fingerprint_json: src.fingerprint_json || existing.fingerprint_json,
        timezone: src.timezone,
        language: src.language,
        latitude: src.latitude,
        longitude: src.longitude,
        country: src.country,
        last_ip: src.last_ip,
        proxy_type: src.proxy_type,
        proxy_host: src.proxy_host,
        proxy_port: src.proxy_port,
        proxy_user: src.proxy_user,
        proxy_pass: src.proxy_pass,
        bound_host_id: HOST_ID,
      }) || existing;
      db.setProfileBoundHost(id, HOST_ID);
    } else {
      const keepId = wantKeepId && !existing;
      const id = keepId ? String(src.id) : undefined;
      row = db.createProfile({
        id,
        owner_id: ownerId,
        group_id: src.group_id || 'default',
        name: opts.newName || (keepId ? (src.name || 'imported') : `${src.name || 'imported'} (导入)`),
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
        bound_host_id: HOST_ID,
      });
    }

    const udSrc = path.join(work, 'userdata');
    const udDest = profileRoot(row.id);
    if (fs.existsSync(udSrc)) {
      if (fs.existsSync(udDest)) fs.rmSync(udDest, { recursive: true, force: true });
      fs.cpSync(udSrc, udDest, { recursive: true });
    }
    return { profile: row, sourceId: src.id || null, overwritten: Boolean(existing) };
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
  FORMAT,
  exportProfilePack,
  importProfilePack,
  listExportFiles,
  resolveExportFile,
  EXPORTS_DIR,
  ensureExportsDir,
  PROFILES_DIR,
};
