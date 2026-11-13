/**
 * 服务器浏览器：页面 / Worker 内的时区、navigator 兜底脚本。
 * 与桌面 tkswarm-browses/src/browser/env-emulation.js 的 tzPatch / workerPatch 同源（逐字搬运），
 * 保证同一环境包在两端表现一致。改这里必须同步改桌面版。
 */
const { normalizeWebglRenderer, webgpuInfoOf } = require('./fp-inject');

function acceptLanguageOf(locale) {
  const primary = String(locale || 'en-US').split(',')[0].trim() || 'en-US';
  const base = primary.split('-')[0] || 'en';
  return primary.includes('-') && base.toLowerCase() !== primary.toLowerCase()
    ? `${primary},${base}`
    : primary;
}

/**
 * 页面内时区兜底（纯 JS，不依赖 debugger）。
 * CDP Emulation.setTimezoneOverride 会在 debugger 脱离（如打开 DevTools）、换渲染进程时整体清空，
 * 这里在 JS 层再保一道：Intl 默认时区、getTimezoneOffset、toString 系列、toLocale* 系列。
 * 该函数会被 toString() 序列化注入页面，因此必须自包含，不能引用外部变量。
 */
function tzPatch(TZ) {
  // 防重复标记：Symbol 键 + 不可枚举，window 的字符串属性名里不会出现工具专属名字
  const TZK = Symbol.for('wr.cfg.t');
  if (window[TZK] === TZ) return;
  try { Object.defineProperty(window, TZK, { value: TZ }); } catch (e) { return; }
  try {
    const OrigDTF = Intl.DateTimeFormat;
    const withTz = (o) => {
      if (o == null) return { timeZone: TZ };
      if (typeof o === 'object' && !o.timeZone) return { ...o, timeZone: TZ };
      return o;
    };
    const Patched = function DateTimeFormat(locales, options) {
      return Reflect.construct(OrigDTF, [locales, withTz(options)], new.target || Patched);
    };
    Patched.prototype = OrigDTF.prototype;
    // 原生 supportedLocalesOf 不依赖 this，直接复用，避免出现 "bound ..." 名称
    Object.defineProperty(Patched, 'supportedLocalesOf', { value: OrigDTF.supportedLocalesOf, writable: true, configurable: true });
    Object.defineProperty(Patched, 'length', { value: OrigDTF.length, configurable: true });
    // prototype.constructor 必须指回对外可见的构造器，否则 new Intl.DateTimeFormat().constructor !== Intl.DateTimeFormat
    Object.defineProperty(OrigDTF.prototype, 'constructor', { value: Patched, writable: true, configurable: true });
    Intl.DateTimeFormat = Patched;

    // 伪装：在已有（可能已被 fp-inject 伪装过的）Function.prototype.toString 之上再叠一层，
    // 让本脚本覆盖的函数对外表现为原生（toString / name / length）。
    const prevToString = Function.prototype.toString;
    const masked = new WeakMap();
    const mask = (fn, orig) => {
      try {
        masked.set(fn, prevToString.call(orig));
        Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
        Object.defineProperty(fn, 'length', { value: orig.length, configurable: true });
      } catch (e) { /* */ }
    };
    const toStr = function toString() {
      const m = masked.get(this);
      return m !== undefined ? m : prevToString.call(this);
    };
    mask(toStr, prevToString);
    Object.defineProperty(Function.prototype, 'toString', { value: toStr, writable: true, configurable: true });
    mask(Patched, OrigDTF);

    const partsFmt = new OrigDTF('en-US', {
      timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = (t) => {
      const p = {};
      partsFmt.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; });
      return p;
    };
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const offsetMin = (t) => {
      const p = parts(t);
      const asUtc = Date.UTC(+p.year, MONTHS[p.month], +p.day, (+p.hour) % 24, +p.minute, +p.second);
      return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
    };
    let tzName = TZ;
    try {
      const n = new OrigDTF(navigator.language || 'en-US', { timeZone: TZ, timeZoneName: 'long' })
        .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      if (n) tzName = n.value;
    } catch (e) { /* */ }
    const pad = (n) => String(n).padStart(2, '0');
    const gmt = (t) => {
      const m = offsetMin(t);
      const a = Math.abs(m);
      return `GMT${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)} (${tzName})`;
    };
    const DP = Date.prototype;
    const def = (name, fn) => {
      try {
        const orig = DP[name];
        Object.defineProperty(DP, name, { value: fn, writable: true, configurable: true });
        if (typeof orig === 'function') mask(fn, orig);
      } catch (e) { /* */ }
    };
    def('getTimezoneOffset', function getTimezoneOffset() {
      const t = this.getTime();
      return Number.isNaN(t) ? NaN : -offsetMin(t);
    });
    def('toString', function toString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.weekday} ${p.month} ${p.day} ${p.year} ${p.hour}:${p.minute}:${p.second} ${gmt(t)}`;
    });
    def('toTimeString', function toTimeString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.hour}:${p.minute}:${p.second} ${gmt(t)}`;
    });
    def('toDateString', function toDateString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.weekday} ${p.month} ${p.day} ${p.year}`;
    });
    ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((name) => {
      const orig = DP[name];
      def(name, function (locales, options) { return orig.call(this, locales, withTz(options)); });
    });
  } catch (e) { /* 兜底失败不影响其它覆盖 */ }
}

function buildTimezoneScript(timezone) {
  const tz = String(timezone || '').trim();
  if (!tz) return '';
  return `(${tzPatch.toString()})(${JSON.stringify(tz)});`;
}

/**
 * Worker 全局里的 navigator 补丁（toString 序列化后经 CDP Runtime.evaluate 注入）。
 * 页面主线程已被覆盖，但 Dedicated/Shared/Service Worker 是独立全局，
 * 风控脚本在 Worker 里再读一遍 UA / 语言 / 核数，若仍是本机值就会与页面对不上。
 */
function workerPatch(CFG) {
  try {
    const WN = self.WorkerNavigator && self.WorkerNavigator.prototype;
    if (!WN) return;
    const nativeToString = Function.prototype.toString;
    const masked = new WeakMap();
    const find = (o, k) => {
      for (let p = o; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, k);
        if (d) return d;
      }
      return null;
    };
    const mask = (fn, orig) => {
      try {
        masked.set(fn, nativeToString.call(orig));
        Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
        Object.defineProperty(fn, 'length', { value: orig.length, configurable: true });
      } catch (e) { /* */ }
    };
    const toStr = function toString() {
      const m = masked.get(this);
      return m !== undefined ? m : nativeToString.call(this);
    };
    mask(toStr, nativeToString);
    Object.defineProperty(Function.prototype, 'toString', { value: toStr, writable: true, configurable: true });
    const def = (k, v) => {
      try {
        const orig = find(WN, k);
        if (!orig || typeof orig.get !== 'function') return;
        const getter = function () { return v; };
        Object.defineProperty(WN, k, { get: getter, set: undefined, enumerable: orig.enumerable, configurable: true });
        mask(getter, orig.get);
      } catch (e) { /* non-configurable 时忽略，交给 CDP 覆盖 */ }
    };
    if (CFG.userAgent) {
      def('userAgent', CFG.userAgent);
      def('appVersion', CFG.userAgent.replace(/^Mozilla\//, ''));
    }
    if (CFG.platform) def('platform', CFG.platform);
    if (CFG.languages && CFG.languages.length) {
      def('language', CFG.languages[0]);
      def('languages', Object.freeze(CFG.languages.slice()));
    }
    if (CFG.hardwareConcurrency > 0) def('hardwareConcurrency', CFG.hardwareConcurrency);
    if (CFG.deviceMemory > 0) def('deviceMemory', CFG.deviceMemory);

    // Worker 里的 OffscreenCanvas WebGL：实测会泄露真实显卡(Intel UHD)，与页面伪装的显卡矛盾
    if (CFG.webglRenderer) {
      [self.WebGLRenderingContext, self.WebGL2RenderingContext].forEach((C) => {
        try {
          if (!C || !C.prototype) return;
          const orig = C.prototype.getParameter;
          if (typeof orig !== 'function') return;
          const f = function getParameter(param) {
            if (param === 0x9245) return CFG.webglVendor;
            if (param === 0x9246) return CFG.webglRenderer;
            return orig.call(this, param);
          };
          C.prototype.getParameter = f;
          mask(f, orig);
        } catch (e) { /* */ }
      });
    }
    // Worker 里的 WebGPU adapter.info
    if (CFG.gpuInfo && self.GPUAdapterInfo && self.GPUAdapterInfo.prototype) {
      const GP = self.GPUAdapterInfo.prototype;
      [['vendor', CFG.gpuInfo.vendor], ['architecture', CFG.gpuInfo.architecture]].forEach(([k, v]) => {
        try {
          const d = Object.getOwnPropertyDescriptor(GP, k);
          if (!d || typeof d.get !== 'function') return;
          const g = function () { return v; };
          Object.defineProperty(GP, k, { get: g, set: d.set, enumerable: d.enumerable, configurable: true });
          mask(g, d.get);
        } catch (e) { /* */ }
      });
    }
  } catch (e) { /* */ }
}

function buildWorkerScript(cfg) {
  try {
    const parts = [`(${workerPatch.toString()})(${JSON.stringify(cfg)});`];
    if (cfg.timezone) {
      // tzPatch 里引用了 window，Worker 里没有：用局部变量别名，避免给 Worker 全局多出一个 window
      parts.push(`try{(function(){var window=self;(${tzPatch.toString()})(${JSON.stringify(cfg.timezone)});})();}catch(e){}`);
    }
    return parts.join('\n');
  } catch { return ''; }
}
/** 页面主线程用：时区 JS 兜底脚本（空时区返回空串） */
function timezoneScriptFor(timezone) {
  return buildTimezoneScript(timezone);
}

/** Worker 全局用：navigator / 显卡 / 时区补丁 */
function workerScriptFor({ userAgent, os, locale, fp = {}, timezone }) {
  return buildWorkerScript({
    userAgent: String(userAgent || ''),
    platform: String(os || fp.os || 'Win32'),
    languages: acceptLanguageOf(locale).split(',').map((x) => x.trim()).filter(Boolean),
    hardwareConcurrency: Number(fp.hardwareConcurrency || 0),
    deviceMemory: Number(fp.deviceMemory || 0),
    timezone: String(timezone || ''),
    webglVendor: String(fp.webglVendor || ''),
    webglRenderer: fp.webglRenderer ? normalizeWebglRenderer(fp.webglRenderer) : '',
    gpuInfo: fp.webglRenderer ? webgpuInfoOf(normalizeWebglRenderer(fp.webglRenderer)) : null,
  });
}

/**
 * 页面主线程：navigator.userAgent / appVersion / platform / userAgentData 与 UA、Client Hints 头同源。
 * 旧版 fp-inject 在页内强制过这些，换成桌面版 fp-inject 后需要单独补回；
 * 否则从页面加载到 Playwright 连上之前，页面会露出 Electron 的真实 Linux 值。
 * metadata 取自 fingerprint.buildUserAgentMetadata（GREASE 品牌 + 真实内核版本）。
 */
function uaDataScriptFor({ userAgent, platform, metadata }) {
  const m = metadata || {};
  const cfg = {
    ua: String(userAgent || ''),
    platform: String(platform || 'Win32'),
    uaPlat: String(m.platform || 'Windows'),
    uaPlatVer: String(m.platformVersion || '10.0.0'),
    brands: Array.isArray(m.brands) ? m.brands : [],
    fullVersionList: Array.isArray(m.fullVersionList) ? m.fullVersionList : [],
    fullVersion: String(m.fullVersion || ''),
  };
  if (!cfg.ua || !cfg.brands.length) return '';
  return `(() => { try {
    const C = ${JSON.stringify(cfg)};
    const prevTS = Function.prototype.toString;
    const masked = new WeakMap();
    const mask = (fn, orig) => { try { masked.set(fn, prevTS.call(orig)); Object.defineProperty(fn, 'name', { value: orig.name, configurable: true }); } catch (e) {} };
    const ts = function toString() { const x = masked.get(this); return x !== undefined ? x : prevTS.call(this); };
    mask(ts, prevTS);
    Object.defineProperty(Function.prototype, 'toString', { value: ts, writable: true, configurable: true });
    const findDesc = (o, k) => { for (let p = o; p; p = Object.getPrototypeOf(p)) { const d = Object.getOwnPropertyDescriptor(p, k); if (d) return d; } return null; };
    const def = (k, v) => { try {
      const orig = findDesc(Navigator.prototype, k);
      const g = function () { return v; };
      Object.defineProperty(Navigator.prototype, k, { get: g, set: undefined, enumerable: orig ? orig.enumerable : true, configurable: true });
      if (orig && orig.get) mask(g, orig.get);
    } catch (e) {} };
    def('userAgent', C.ua);
    def('appVersion', C.ua.replace('Mozilla/', ''));
    def('platform', C.platform);
    const brands = Object.freeze(C.brands.map((b) => Object.freeze(b)));
    const fvl = Object.freeze(C.fullVersionList.map((b) => Object.freeze(b)));
    const high = { architecture: 'x86', bitness: '64', brands, formFactors: ['Desktop'], fullVersionList: fvl, mobile: false, model: '', platform: C.uaPlat, platformVersion: C.uaPlatVer, uaFullVersion: C.fullVersion, wow64: false };
    const uaData = {
      get brands() { return brands; },
      get mobile() { return false; },
      get platform() { return C.uaPlat; },
      toJSON() { return { brands, mobile: false, platform: C.uaPlat }; },
      getHighEntropyValues(h) {
        const out = { brands, mobile: false, platform: C.uaPlat };
        if (Array.isArray(h)) { for (const k of h) { if (k in high) out[k] = high[k]; } }
        return Promise.resolve(out);
      },
    };
    if (typeof NavigatorUAData === 'function' && NavigatorUAData.prototype) { try { Object.setPrototypeOf(uaData, NavigatorUAData.prototype); } catch (e) {} }
    if ('userAgentData' in Navigator.prototype) def('userAgentData', uaData);
  } catch (e) {} })();`;
}

module.exports = { timezoneScriptFor, workerScriptFor, uaDataScriptFor, buildTimezoneScript, buildWorkerScript, acceptLanguageOf };
