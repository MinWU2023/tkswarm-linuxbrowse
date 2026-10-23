/**
 * 环境目录清理：清 Cookie/Cache，或整目录删除。
 */
const fs = require('node:fs');
const path = require('node:path');
const { PROFILES_DIR } = require('../config');

function profileRoot(profileId) {
  return path.join(PROFILES_DIR, String(profileId));
}

function rmSafe(target) {
  try {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 删除整个环境目录（deleteProfile 后调用） */
function removeProfileDir(profileId) {
  return { ok: rmSafe(profileRoot(profileId)), id: String(profileId) };
}

/**
 * 清理 Cookie / Cache / Code Cache / Crashpad，保留其余配置以便重开。
 */
function clearProfileCache(profileId) {
  const root = profileRoot(profileId);
  if (!fs.existsSync(root)) {
    return { ok: true, cleared: [], missing: true };
  }
  const targets = [
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Network',
    'Default/Cache',
    'Default/Code Cache',
    'Default/GPUCache',
    'Default/Service Worker',
    'Default/Local Storage',
    'Default/Session Storage',
    'Default/IndexedDB',
    'Crashpad',
    'BrowserMetrics',
    'ShaderCache',
  ];
  const cleared = [];
  for (const rel of targets) {
    if (rmSafe(path.join(root, rel))) cleared.push(rel);
  }
  return { ok: true, cleared, id: String(profileId) };
}

module.exports = { clearProfileCache, removeProfileDir, profileRoot };
