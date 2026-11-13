const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DATA_ROOT } = require('../config');

function chromiumFromPlaywright() {
  try {
    const { chromium } = require('playwright-core');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

function systemChromePaths() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

function resolveChromeExecutable() {
  const cached = path.join(DATA_ROOT, 'chrome-path.txt');
  if (fs.existsSync(cached)) {
    const p = fs.readFileSync(cached, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const candidates = [process.env.TKSWARM_CHROME_PATH, chromiumFromPlaywright(), ...systemChromePaths()].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.writeFileSync(cached, p);
      return p;
    }
  }
  throw new Error('未找到 Chrome/Chromium。请安装 Google Chrome 或运行 npm run postinstall');
}

/**
 * 读取 Chrome/Chromium 二进制的真实主版本号。
 *
 * ⚠ 平台差异很大，必须分开处理：
 *   - Windows：chrome.exe --version **不会**输出到 stdout，而是直接拉起浏览器窗口并常驻，
 *     同步调用会把主进程线程彻底卡死（表现：点「打开环境」完全没反应）。绝不 spawn。
 *   - Linux / macOS：`chrome --version` 会打印版本随即退出，是安全的；但 snap / 只读挂载
 *     等场景仍可能慢，所以必须给短超时，失败就走文件线索。
 * 文件线索优先，spawn 只作为兜底。
 *
 * @param {string} [exePath] 不传则内部解析
 * @returns {string} 主版本号，如 '131'；失败返回 ''
 */
function detectChromeMajorVersion(exePath) {
  try {
    const exe = exePath || resolveChromeExecutable();
    if (!exe || !fs.existsSync(exe)) return '';

    // 1) 同目录下的完整版本号子目录（Windows 的 Application/、部分 Linux 打包）
    try {
      const appDir = path.dirname(exe);
      const dirs = fs.readdirSync(appDir).filter((n) => /^\d{2,3}\.\d+\.\d+\.\d+$/.test(n));
      if (dirs.length) {
        const latest = dirs
          .map((n) => ({ n, v: n.split('.').map(Number) }))
          .sort((a, b) => {
            for (let i = 0; i < 4; i += 1) {
              const d = (b.v[i] || 0) - (a.v[i] || 0);
              if (d) return d;
            }
            return 0;
          })[0];
        if (latest) return String(latest.v[0]);
      }
    } catch { /* 下一级兜底 */ }

    // 2) 真实路径里带版本号的情况，如 /opt/google/chrome/131.0.6778.85/chrome
    try {
      const real = fs.realpathSync(exe);
      const m = String(real).match(/\/(\d{2,3})\.\d+\.\d+\.\d+\//);
      if (m) return m[1];
    } catch { /* ignore */ }

    // 3) macOS：读 bundle 的 Info.plist
    if (process.platform === 'darwin') {
      try {
        const plist = path.resolve(path.dirname(exe), '..', 'Info.plist');
        if (fs.existsSync(plist)) {
          const text = fs.readFileSync(plist, 'utf8');
          const m = text.match(/CFBundleShortVersionString[\s\S]{0,200}?<string>(\d{2,3})\./);
          if (m) return m[1];
        }
      } catch { /* ignore */ }
    }

    // 4) Linux：`<bin> --version` 打印即退出，安全；加短超时兜底
    //    （Windows 绝不能走这条，见上文说明）
    if (process.platform === 'linux') {
      try {
        const { execFileSync } = require('node:child_process');
        const out = execFileSync(exe, ['--version'], {
          timeout: 4000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const m = String(out || '').match(/(\d{2,3})\.\d+\.\d+\.\d+/);
        if (m) return m[1];
      } catch { /* 下一级兜底 */ }

      // Linux 发行版常把版本记在 deb/rpm 元数据或 chrome.1 里
      try {
        const optDir = path.dirname(fs.realpathSync(exe)); // 通常是 /opt/google/chrome
        for (const candidate of [
          path.join(optDir, 'chrome.1'),
          path.join(optDir, 'resources', 'version'),
          '/usr/share/doc/google-chrome-stable/changelog.Debian.gz',
        ]) {
          if (!fs.existsSync(candidate)) continue;
          if (candidate.endsWith('.gz')) continue; // 不解析压缩包
          const text = fs.readFileSync(candidate, 'utf8').slice(0, 2000);
          const m = text.match(/(\d{2,3})\.\d+\.\d+\.\d+/);
          if (m) return m[1];
        }
      } catch { /* ignore */ }
    }

    // 5) Playwright 下载的 chromium：目录名 chromium-1148 之类无法可靠映射主版本，跳过
    try {
      const pwDir = path.resolve(path.dirname(exe), '..');
      if (fs.existsSync(path.join(pwDir, 'DEPENDENCIES_VALIDATED'))) return '';
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  return '';
}

module.exports = { resolveChromeExecutable, detectChromeMajorVersion };
