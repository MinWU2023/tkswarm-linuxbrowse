const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { resolveCapacity } = require('./capacity');

const isDev = process.argv.includes('--dev') || process.env.TKSWARM_BROWSER_DEV === '1';

function appDataRoot() {
  if (process.env.TKSWARM_BROWSER_DATA) {
    return path.resolve(process.env.TKSWARM_BROWSER_DATA);
  }
  // Linux 服务：优先 /var/lib；无权限则退回用户目录
  const systemDir = '/var/lib/tkswarm-linuxbrowse';
  try {
    if (process.platform === 'linux' && (process.getuid?.() === 0 || fs.existsSync(path.dirname(systemDir)))) {
      fs.mkdirSync(systemDir, { recursive: true });
      return systemDir;
    }
  } catch { /* fall through */ }
  const dir = path.join(os.homedir(), '.local', 'share', 'TkSwarmLinuxBrowse');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DATA_ROOT = appDataRoot();

/**
 * 并发容量：启动时读一次本机 CPU/内存，按档位自动定并发上限，
 * 并把结论写到 ${DATA_ROOT}/capacity.json（运维可查、可用环境变量覆盖）。
 */
const CAPACITY = resolveCapacity({
  dataRoot: DATA_ROOT,
  envMax: process.env.TKSWARM_BROWSER_MAX_CONCURRENT,
  envMaxEnvs: process.env.TKSWARM_BROWSER_MAX_ENVS,
});

module.exports = {
  isDev,
  PROVIDER_ID: 'tkswarm-linuxbrowse',
  PROVIDER_LABEL: '第一页自研浏览器 Linux',
  VERSION: '1.0.0',
  DATA_ROOT,
  DB_PATH: path.join(DATA_ROOT, 'tkswarm-linuxbrowse.json'),
  PROFILES_DIR: path.join(DATA_ROOT, 'profiles'),
  SETTINGS_PATH: path.join(DATA_ROOT, 'settings.json'),
  // 服务端默认可被同机 Node / 内网 Node 访问；生产请用防火墙收口
  API_HOST: process.env.TKSWARM_BROWSER_HOST || '0.0.0.0',
  API_PORT: Number(process.env.TKSWARM_BROWSER_PORT || 54345),
  MAX_ENVS_PER_USER: CAPACITY.maxEnvs,
  MAX_CONCURRENT_OPENS: CAPACITY.maxConcurrent,
  /** 硬件评估结果（档位、依据、配置文件路径） */
  CAPACITY,
  DEFAULT_API_TOKEN: process.env.TKSWARM_BROWSER_TOKEN || '',
  TKSWARM_API_BASE: process.env.TKSWARM_API_BASE || 'http://127.0.0.1:8080/api',
  /** 有头模式是否依赖 Xvfb（无物理显示器的服务器建议 1） */
  USE_XVFB: String(process.env.TKSWARM_BROWSER_XVFB || '1') !== '0',
  /** Docker / root 下 Chrome 需要 --no-sandbox */
  CHROME_NO_SANDBOX: String(process.env.TKSWARM_CHROME_NO_SANDBOX || '1') !== '0',
  /** VNC 密码（空=无密码；监听非本机时强烈建议设置） */
  VNC_PASSWORD: String(process.env.TKSWARM_VNC_PASSWORD || ''),
  VNC_BIND_HOST: process.env.TKSWARM_VNC_BIND || '127.0.0.1',
  /**
   * browser/* 是否强制 Bearer。
   * 默认开启；本地调试可设 TKSWARM_ALLOW_ANON=1 允许无 Token 兜底最近用户。
   */
  REQUIRE_BEARER: String(process.env.TKSWARM_ALLOW_ANON || '0') !== '1',
  /** Token 远程校验缓存 TTL */
  TOKEN_VALIDATE_TTL_MS: Number(process.env.TKSWARM_TOKEN_VALIDATE_TTL_MS || 60_000),
  /** 全量会话扫 PHP 间隔 */
  TOKEN_VALIDATE_INTERVAL_MS: Number(process.env.TKSWARM_TOKEN_VALIDATE_INTERVAL_MS || 120_000),
  /** 资源 / 僵尸回收间隔 */
  GC_INTERVAL_MS: Number(process.env.TKSWARM_GC_INTERVAL_MS || 60_000),
  /** 运行中窗口无心跳多久后收尸（ms）；0=不按心跳收尸 */
  SESSION_STALE_MS: Number(process.env.TKSWARM_SESSION_STALE_MS || 0),
  /**
   * 本机身份（多机 sticky 用）：默认主机名。
   * Node / 网关可按环境固定打到同一 hostId。
   */
  HOST_ID: String(process.env.TKSWARM_HOST_ID || os.hostname() || 'linuxbrowse'),
  /**
   * 环境粘滞到首次打开的 hostId。
   * 换机导入会重绑到本机；跨机误开会拒绝（设 TKSWARM_STICKY_HOST=0 关闭）。
   */
  STICKY_HOST: String(process.env.TKSWARM_STICKY_HOST || '1') !== '0',
};
