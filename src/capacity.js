/**
 * 服务器并发容量自动评估
 *
 * 作用：读取当前服务器 CPU 核数 / 内存，算出"这台机器同时能开多少个环境浏览器"，
 * 并把结论写进 ${DATA_ROOT}/capacity.json，供运维查看、排障与人工覆盖。
 *
 * 优先级：环境变量 TKSWARM_BROWSER_MAX_CONCURRENT
 *       > capacity.json（硬件未变化时沿用上次结果）
 *       > 按硬件自动计算
 *
 * 实测基准（有头 Chromium 跑 TikTok：浏览/私信/客服常规页面）
 *   内存 0.6–1.0 GB/环境，CPU 0.25–0.4 核/环境
 * 这里按 0.8 GB + 0.3 核规划，再乘 0.85 安全系数，避免贴边跑被 OOM 杀掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 单环境规划占用 */
const PER_ENV_MEMORY_GB = 0.8;
const PER_ENV_CPU = 0.3;
/** 系统 / node / Xvfb / 文件缓存预留 */
const RESERVED_MEMORY_GB = 1;
/** 安全系数：不把机器压到极限 */
const SAFETY = 0.85;
/** 有头模式每个环境独占一个 Xvfb DISPLAY（号段 80 个），硬上限 */
const HARD_CAP = 80;
const MIN_CONCURRENT = 2;

const TIERS = [
  { key: 'small', label: '入门（≤2核4G）', max: 4 },
  { key: 'standard', label: '标准（4核8G）', max: 8 },
  { key: 'medium', label: '中级（8核16G）', max: 18 },
  { key: 'large', label: '大型（16核32G）', max: 36 },
  { key: 'xlarge', label: '超大型（32核64G+）', max: Infinity },
];

/** 读取本机硬件信息 */
function readHardware() {
  const cpuCores = Math.max(1, (os.cpus() || []).length || 1);
  const memoryGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  return {
    cpuCores,
    memoryGB,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
  };
}

/**
 * 纯计算：硬件 → 并发容量（不读写文件，便于测试）
 * @param {{cpuCores:number, memoryGB:number}} hw
 */
function computeCapacity(hw) {
  const cores = Math.max(1, Number(hw?.cpuCores) || 1);
  const memoryGB = Math.max(1, Number(hw?.memoryGB) || 1);
  const usableMem = Math.max(0.5, memoryGB - RESERVED_MEMORY_GB);
  const byMemory = usableMem / PER_ENV_MEMORY_GB;
  const byCpu = cores / PER_ENV_CPU;
  const raw = Math.min(byMemory, byCpu);
  const maxConcurrent = Math.max(MIN_CONCURRENT, Math.min(HARD_CAP, Math.floor(raw * SAFETY)));
  const tier = TIERS.find((t) => maxConcurrent <= t.max) || TIERS[TIERS.length - 1];
  return {
    maxConcurrent,
    tier: tier.key,
    tierLabel: tier.label,
    limitedBy: byMemory <= byCpu ? 'memory' : 'cpu',
    perEnvMemoryGB: PER_ENV_MEMORY_GB,
    perEnvCpu: PER_ENV_CPU,
    estimatedMemoryGB: Math.round(maxConcurrent * PER_ENV_MEMORY_GB * 10) / 10,
    estimatedCpu: Math.round(maxConcurrent * PER_ENV_CPU * 10) / 10,
  };
}

/** 硬件是否基本未变（核数一致、内存差异 ≤10%） */
function sameHardware(prev, now) {
  if (!prev || !now) return false;
  const prevCores = Number(prev.cpuCores);
  const prevMem = Number(prev.memoryGB);
  if (!Number.isFinite(prevCores) || !Number.isFinite(prevMem)) return false;
  const memTolerance = Math.max(0.5, Number(now.memoryGB) * 0.1);
  return prevCores === Number(now.cpuCores) && Math.abs(prevMem - Number(now.memoryGB)) <= memTolerance;
}

/**
 * 解析生效容量：必要时重算并写配置文件
 * @param {{dataRoot?:string, envMax?:string|number, envMaxEnvs?:string|number}} opts
 */
function resolveCapacity(opts = {}) {
  const hw = readHardware();
  const computed = computeCapacity(hw);
  const dataRoot = opts.dataRoot || path.join(os.homedir(), '.local', 'share', 'TkSwarmLinuxBrowse');
  const filePath = path.join(dataRoot, 'capacity.json');

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { /* 首次启动或文件损坏，按自动计算 */ }

  const envMax = Number(opts.envMax || 0);
  let maxConcurrent = computed.maxConcurrent;
  let source = 'auto';
  if (envMax > 0) {
    maxConcurrent = envMax;
    source = 'env';
  } else if (prev && Number(prev.maxConcurrent) > 0 && prev.source !== 'env' && sameHardware(prev.hardware, hw)) {
    maxConcurrent = Number(prev.maxConcurrent);
    source = 'file';
  }

  const envMaxEnvs = Number(opts.envMaxEnvs || 0);
  const maxEnvs = envMaxEnvs > 0 ? envMaxEnvs : Math.max(300, maxConcurrent * 5);

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    hardware: hw,
    ...computed,
    maxConcurrent,
    maxEnvs,
    source,
    hardwareChanged: !!(prev && !sameHardware(prev.hardware, hw)),
    previous: prev ? { maxConcurrent: prev.maxConcurrent, source: prev.source, generatedAt: prev.generatedAt } : null,
    filePath,
    limits: { hardCap: HARD_CAP, safety: SAFETY, reservedMemoryGB: RESERVED_MEMORY_GB },
    overrides: { TKSWARM_BROWSER_MAX_CONCURRENT: envMax > 0 ? envMax : null, TKSWARM_BROWSER_MAX_ENVS: envMaxEnvs > 0 ? envMaxEnvs : null },
  };

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch (error) {
    result.writeError = error.message;
  }
  return result;
}

module.exports = {
  PER_ENV_MEMORY_GB,
  PER_ENV_CPU,
  HARD_CAP,
  TIERS,
  readHardware,
  computeCapacity,
  sameHardware,
  resolveCapacity,
};
