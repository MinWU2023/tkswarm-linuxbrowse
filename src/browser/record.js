/**
 * 有头短时录屏：ffmpeg x11grab 抓取环境 DISPLAY。
 * 依赖系统 ffmpeg；无 DISPLAY / 无头模式不可用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { DATA_ROOT } = require('../config');

const RECORDINGS_DIR = path.join(DATA_ROOT, 'recordings');
const DEFAULT_MAX_SEC = Number(process.env.TKSWARM_RECORD_MAX_SEC || 120);
const HARD_MAX_SEC = 600;

/** @type {Map<string, { proc: import('child_process').ChildProcess, filePath: string, fileName: string, startedAt: number, maxSec: number, timer?: NodeJS.Timeout }>} */
const active = new Map();

function ensureDir() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  return RECORDINGS_DIR;
}

function ffmpegInstalled() {
  try {
    execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listRecordings(limit = 50) {
  ensureDir();
  return fs.readdirSync(RECORDINGS_DIR)
    .filter((n) => /\.(mp4|mkv|webm)$/i.test(n))
    .map((name) => {
      const p = path.join(RECORDINGS_DIR, name);
      const st = fs.statSync(p);
      return { name, bytes: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
    .slice(0, Math.max(1, limit));
}

function resolveRecording(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.includes('..')) return null;
  const p = path.join(RECORDINGS_DIR, base);
  return fs.existsSync(p) ? p : null;
}

function getRecordingInfo(profileId) {
  const cur = active.get(String(profileId));
  if (!cur) return null;
  return {
    profileId: String(profileId),
    fileName: cur.fileName,
    startedAt: cur.startedAt,
    maxSec: cur.maxSec,
    elapsedSec: Math.floor((Date.now() - cur.startedAt) / 1000),
  };
}

/**
 * @param {string} profileId
 * @param {string} display 如 :110
 * @param {{ maxSeconds?: number }} [opts]
 */
function startRecording(profileId, display, opts = {}) {
  const id = String(profileId);
  if (!display) throw new Error('无 DISPLAY，仅有头窗口可录屏');
  if (!ffmpegInstalled()) throw new Error('未安装 ffmpeg（apt install ffmpeg）');
  if (active.has(id)) throw new Error('该环境已在录屏中');

  ensureDir();
  const maxSec = Math.min(
    HARD_MAX_SEC,
    Math.max(5, Number(opts.maxSeconds || DEFAULT_MAX_SEC) || DEFAULT_MAX_SEC)
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `rec-${id.slice(0, 10)}-${stamp}.mp4`;
  const filePath = path.join(RECORDINGS_DIR, fileName);

  // x11grab：Xvfb 默认 1280x720 或 1920x1080；用 -video_size 探测失败时让 ffmpeg 自适
  const args = [
    '-y',
    '-f', 'x11grab',
    '-framerate', '8',
    '-i', display,
    '-t', String(maxSec),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-an',
    filePath,
  ];

  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DISPLAY: display },
  });

  let errBuf = '';
  proc.stderr?.on('data', (c) => {
    errBuf += String(c);
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  });

  const entry = {
    proc,
    filePath,
    fileName,
    startedAt: Date.now(),
    maxSec,
    errBuf: () => errBuf,
  };

  const finish = () => {
    const cur = active.get(id);
    if (cur?.timer) clearTimeout(cur.timer);
    active.delete(id);
  };

  proc.on('exit', () => finish());
  proc.on('error', () => finish());

  // 比 -t 稍长一点强制收尾
  entry.timer = setTimeout(() => {
    stopRecording(id).catch(() => {});
  }, (maxSec + 3) * 1000);
  entry.timer.unref?.();

  active.set(id, entry);
  return getRecordingInfo(id);
}

async function stopRecording(profileId) {
  const id = String(profileId);
  const cur = active.get(id);
  if (!cur) return { ok: false, message: '未在录屏' };

  if (cur.timer) clearTimeout(cur.timer);

  await new Promise((resolve) => {
    const done = () => resolve();
    try {
      // 优雅结束：发 'q' 到 stdin 不可用时用 SIGINT
      cur.proc.kill('SIGINT');
    } catch { /* */ }
    const t = setTimeout(() => {
      try { cur.proc.kill('SIGKILL'); } catch { /* */ }
      done();
    }, 4000);
    cur.proc.once('exit', () => {
      clearTimeout(t);
      done();
    });
  });

  active.delete(id);
  const exists = fs.existsSync(cur.filePath);
  const bytes = exists ? fs.statSync(cur.filePath).size : 0;
  if (!exists || bytes < 1000) {
    return {
      ok: false,
      message: '录屏文件无效（可能缺 ffmpeg 编解码或 DISPLAY 不可抓）',
      fileName: cur.fileName,
      hint: cur.errBuf?.()?.slice(-300),
    };
  }
  return {
    ok: true,
    fileName: cur.fileName,
    bytes,
    download: `/api/recordings/download/${encodeURIComponent(cur.fileName)}`,
    elapsedSec: Math.floor((Date.now() - cur.startedAt) / 1000),
  };
}

/** 关窗时顺带停录 */
async function stopIfRecording(profileId) {
  if (!active.has(String(profileId))) return null;
  return stopRecording(profileId);
}

module.exports = {
  startRecording,
  stopRecording,
  stopIfRecording,
  getRecordingInfo,
  listRecordings,
  resolveRecording,
  ffmpegInstalled,
  RECORDINGS_DIR,
  DEFAULT_MAX_SEC,
};
