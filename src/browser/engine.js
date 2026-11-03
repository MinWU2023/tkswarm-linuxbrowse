/**
 * 服务器浏览器内核：强制 Electron（EL 核），与桌面 tkswarm-browses 同核以共用环境包。
 * 禁止回退系统 Chrome/Chromium（与桌面 EL 包不兼容）。
 *
 * 配置 TKSWARM_BROWSER_ENGINE / settings.engine 若写成 chrome 一律拒绝。
 */
const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_PATH } = require('../config');

function normalizeEngine(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'electron' || v === 'chrome') return v;
  return '';
}

function electronBinaryExists() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const electronPath = require('electron');
    return Boolean(electronPath && fs.existsSync(String(electronPath)));
  } catch {
    return false;
  }
}

/**
 * @returns {'electron'}
 * @throws {Error} 未安装 Electron 或配置为 chrome
 */
function resolveEngine() {
  const fromEnv = normalizeEngine(process.env.TKSWARM_BROWSER_ENGINE);
  if (fromEnv === 'chrome') {
    throw new Error(
      '已禁止 Chrome/Chromium 内核：服务器浏览器必须使用 Electron（EL）才能与桌面自研共用环境包。请设 TKSWARM_BROWSER_ENGINE=electron 并 npm install electron'
    );
  }

  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const cfg = normalizeEngine(JSON.parse(raw || '{}').engine);
    if (cfg === 'chrome') {
      throw new Error(
        'settings.engine=chrome 已禁用：请改为 electron，与桌面自研保持同一 EL 核'
      );
    }
  } catch (e) {
    if (e && /已禁用|已禁止/.test(String(e.message || e))) throw e;
    /* ignore missing settings */
  }

  if (!electronBinaryExists()) {
    throw new Error(
      '未安装 Electron（EL 核），无法启动服务器浏览器。请在 tkswarm-linuxbrowse 目录执行 npm install（含 electron），勿使用系统 Chrome'
    );
  }
  return 'electron';
}

/** 供 health：不抛错，返回探测结果 */
function probeEngine() {
  try {
    const engine = resolveEngine();
    return { engine, ok: true, electron: true };
  } catch (e) {
    return {
      engine: 'unavailable',
      ok: false,
      electron: electronBinaryExists(),
      error: String(e.message || e),
    };
  }
}

module.exports = { resolveEngine, normalizeEngine, electronBinaryExists, probeEngine };
