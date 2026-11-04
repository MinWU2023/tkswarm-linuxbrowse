/**
 * 全局人类操作节奏：降低 TikTok 风控触发概率。
 *
 * 环境变量 TKSWARM_HUMAN_PACE（默认 1.7）：
 *   1.0 = 原节奏；1.7 = 整体放慢约 70%；建议 1.5~2.2
 * TKSWARM_ACTION_GAP_MS：同账号敏感动作最小间隔（默认 8000）
 */
const DEFAULT_PACE = 1.7;
const DEFAULT_ACTION_GAP_MS = 8000;

const lastAction = new Map();

function paceFactor() {
  const n = Number(process.env.TKSWARM_HUMAN_PACE);
  if (Number.isFinite(n) && n >= 0.8 && n <= 4) return n;
  return DEFAULT_PACE;
}

function actionGapMs(override) {
  if (Number.isFinite(Number(override)) && Number(override) > 0) {
    return Math.round(Number(override) * paceFactor());
  }
  const env = Number(process.env.TKSWARM_ACTION_GAP_MS);
  const base = Number.isFinite(env) && env >= 1000 ? env : DEFAULT_ACTION_GAP_MS;
  return Math.round(base * Math.max(1, paceFactor() / DEFAULT_PACE));
}

function sleep(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, n));
}

function randInt(min, max) {
  const a = Math.min(Number(min) || 0, Number(max) || 0);
  const b = Math.max(Number(min) || 0, Number(max) || 0);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function jitter(baseMs, spread = 0.25) {
  const b = Math.max(0, Number(baseMs) || 0);
  const s = Math.max(0, Number(spread) || 0);
  const delta = b * s * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(b + delta));
}

/** 缩放后的停顿（供各任务 humanPause 复用） */
function scaleMs(baseMs) {
  return Math.max(0, Math.round((Number(baseMs) || 0) * paceFactor()));
}

/**
 * @param {number} baseMs 未缩放基准毫秒
 * @param {number} [spread=0.25]
 */
async function humanPause(baseMs, spread = 0.25) {
  await sleep(jitter(scaleMs(baseMs), spread));
}

/** 人类打字间隔（每键毫秒） */
function typeDelay(min = 70, max = 150) {
  const f = paceFactor();
  return randInt(Math.round(min * f), Math.round(max * f));
}

/** 点击按住时长 */
function clickHoldMs() {
  return typeDelay(55, 120);
}

/**
 * 同步计算需等待毫秒（兼容旧 waitForSlot）
 * @returns {number}
 */
function waitForSlot(key, intervalMs) {
  const gap = actionGapMs(intervalMs);
  const now = Date.now();
  const previous = lastAction.get(key) || 0;
  const wait = Math.max(0, previous + gap - now);
  lastAction.set(key, now + wait);
  return wait;
}

/** 异步占槽并等待 */
async function awaitSlot(key, intervalMs) {
  const wait = waitForSlot(key, intervalMs);
  if (wait > 0) await sleep(wait);
  return wait;
}

function reset() {
  lastAction.clear();
}

module.exports = {
  paceFactor,
  actionGapMs,
  sleep,
  randInt,
  jitter,
  scaleMs,
  humanPause,
  typeDelay,
  clickHoldMs,
  waitForSlot,
  awaitSlot,
  reset,
  DEFAULT_PACE,
  DEFAULT_ACTION_GAP_MS,
};
