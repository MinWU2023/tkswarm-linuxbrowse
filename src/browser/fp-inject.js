/**
 * 生成注入到每个新文档的 Canvas / WebGL / Audio / 硬件指纹脚本。
 * seed 来自环境 id，保证同一环境稳定、不同环境不同。
 */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str || 'tkswarm');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildInjectScript(seedKey, fp = {}) {
  const seed = hashSeed(seedKey);
  const vendor = String(fp.webglVendor || 'Google Inc. (NVIDIA)');
  const renderer = String(fp.webglRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)');
  const hardwareConcurrency = Number(fp.hardwareConcurrency || 8);
  const deviceMemory = Number(fp.deviceMemory || 8);
  const isMac = String(fp.os || '') === 'MacIntel';
  const platform = isMac ? 'MacIntel' : String(fp.os || 'Win32');
  const coreVersion = (String(fp.coreVersion || '131').match(/^(\d{2,3})/) || [])[1] || '131';
  const fullVersion = `${coreVersion}.0.0.0`;
  const userAgent = String(
    fp.userAgent || (isMac
      ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${coreVersion}.0.0.0 Safari/537.36`
      : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${coreVersion}.0.0.0 Safari/537.36`)
  );
  const appVersion = userAgent.replace(/^Mozilla\//i, '');
  const uaDataPlatform = isMac ? 'macOS' : 'Windows';
  const uaDataPlatformVersion = isMac ? '14.5.0' : '10.0.0';
  const languages = String(fp.languages || 'en-US').split(',').map((x) => x.trim()).filter(Boolean);
  const devicePixelRatio = Number(fp.devicePixelRatio || fp.dpr || 1) || 1;
  const clientRectNoise = (seed % 7) - 3; // -3..3 px 级稳定偏移
  const fontList = Array.isArray(fp.fonts) && fp.fonts.length
    ? fp.fonts
    : ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New',
      'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

  return `(() => {
  if (window.__TKSWARM_FP__) return;
  window.__TKSWARM_FP__ = true;
  const SEED = ${seed};
  function rnd(n) {
    let x = (SEED ^ (n * 2654435761)) >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  }
  function noiseByte(i) {
    return Math.floor(rnd(i + 17) * 4) - 1; // -1..2
  }

  // —— Canvas 2D ——
  //
  // 旧实现把噪声 putImageData **写回原画布**，导致同一个 canvas 每读一次就被再改一次，
  // 连续两次 toDataURL 结果不同。真实设备 canvas 指纹完全稳定，连读两次即可识破，
  // 比不伪造更危险。改为在**离屏副本**上变换，绝不回写原画布。
  const cloneWithNoise = (srcCanvas, width, height, salt) => {
    const off = document.createElement('canvas');
    off.width = srcCanvas.width || width;
    off.height = srcCanvas.height || height;
    const offCtx = off.getContext('2d');
    if (!offCtx) return null;
    offCtx.drawImage(srcCanvas, 0, 0);
    const w = Math.min(off.width, width);
    const h = Math.min(off.height, height);
    if (w > 0 && h > 0) {
      const img = offCtx.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (img.data[i] + noiseByte(i + salt)) & 255;
      }
      offCtx.putImageData(img, 0, 0);
    }
    return off;
  };

  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        if (this.width && this.height) {
          const off = cloneWithNoise(this, 16, 16, 17);
          if (off) return toDataURL.apply(off, args);
        }
      } catch (e) {}
      return toDataURL.apply(this, args);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    if (toBlob) {
      HTMLCanvasElement.prototype.toBlob = function(cb, ...rest) {
        try {
          if (this.width && this.height) {
            const off = cloneWithNoise(this, 16, 16, 99);
            if (off) return toBlob.call(off, cb, ...rest);
          }
        } catch (e) {}
        return toBlob.call(this, cb, ...rest);
      };
    }
    // getImageData 返回副本，改副本不会污染画布
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const img = getImageData.apply(this, args);
      try {
        if (img && img.data && img.data.length >= 4) {
          const n = Math.min(img.data.length, 256 * 4);
          for (let i = 0; i < n; i += 4) {
            img.data[i] = (img.data[i] + noiseByte(i + 511)) & 255;
          }
        }
      } catch (e) {}
      return img;
    };
  } catch (e) {}

  // —— WebGL ——
  try {
    const patchGetParameter = (proto) => {
      if (!proto || proto.__tkPatched) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function(param) {
        const UNMASKED_VENDOR = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        if (param === UNMASKED_VENDOR) return ${JSON.stringify(vendor)};
        if (param === UNMASKED_RENDERER) return ${JSON.stringify(renderer)};
        return getParameter.call(this, param);
      };
      proto.__tkPatched = true;
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGetParameter(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);

    const patchReadPixels = (proto) => {
      if (!proto || proto.__tkReadPatched) return;
      const readPixels = proto.readPixels;
      proto.readPixels = function(...args) {
        readPixels.apply(this, args);
        try {
          const buf = args[6];
          if (buf && buf.length) {
            for (let i = 0; i < Math.min(buf.length, 64); i += 4) {
              buf[i] = (buf[i] + noiseByte(i + 200)) & 255;
            }
          }
        } catch (e) {}
      };
      proto.__tkReadPatched = true;
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchReadPixels(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchReadPixels(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // —— AudioContext 指纹 ——
  //
  // 旧实现只改 getChannelData 前 32 个样本，而 AudioContext 指纹通常取整段 buffer
  // 的加权累加和，改 32 个样本几乎不影响结果；且同一份底层数据会被反复叠加（累积污染）。
  // 现在用 WeakSet 保证每个 buffer 只处理一次，噪声按索引确定性撒在整段上，恒等且有效。
  try {
    const processed = new WeakSet();
    const getChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = getChannelData.call(this, channel);
      try {
        if (data && data.length && !processed.has(data)) {
          processed.add(data);
          const n = data.length;
          const step = n > 200000 ? Math.floor(n / 200000) * 997 + 1 : 997;
          for (let i = 0; i < n; i += step) {
            data[i] = data[i] + (rnd(i + 300) - 0.5) * 2e-7;
          }
          const last = n - 1;
          if (last > 0) data[last] = data[last] + (rnd(last + 301) - 0.5) * 2e-7;
        }
      } catch (e) {}
      return data;
    };
    // copyFromChannel 是另一条读取路径，不能漏
    const copyFromChannel = AudioBuffer.prototype.copyFromChannel;
    if (copyFromChannel) {
      AudioBuffer.prototype.copyFromChannel = function(dest, channel, startInChannel) {
        const r = copyFromChannel.call(this, dest, channel, startInChannel);
        try {
          if (dest && dest.length) {
            const step = dest.length > 2000 ? Math.floor(dest.length / 2000) + 1 : 1;
            for (let i = 0; i < dest.length; i += step) {
              dest[i] = dest[i] + (rnd(i + 302) - 0.5) * 2e-7;
            }
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}

  // —— Navigator ——
  try {
    const def = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch (e) {}
    };
    def(Navigator.prototype, 'webdriver', false);
    def(Navigator.prototype, 'userAgent', ${JSON.stringify(userAgent)});
    def(Navigator.prototype, 'appVersion', ${JSON.stringify(appVersion)});
    def(Navigator.prototype, 'vendor', 'Google Inc.');
    def(Navigator.prototype, 'hardwareConcurrency', ${hardwareConcurrency});
    def(Navigator.prototype, 'deviceMemory', ${deviceMemory});
    def(Navigator.prototype, 'platform', ${JSON.stringify(platform)});
    def(Navigator.prototype, 'languages', Object.freeze(${JSON.stringify(languages)}));
    def(Navigator.prototype, 'language', ${JSON.stringify(languages[0] || 'en-US')});
    try { delete navigator.webdriver; } catch (e) {}
    try { delete navigator.userAgent; } catch (e) {}
    try { delete navigator.platform; } catch (e) {}

    // 伪造与 User-Agent 一致的 navigator.userAgentData（消除 Linux Chromium/130 与 Windows Chrome 的矛盾）
    const brands = Object.freeze([
      Object.freeze({ brand: 'Not-A.Brand', version: '99' }),
      Object.freeze({ brand: 'Google Chrome', version: ${JSON.stringify(coreVersion)} }),
      Object.freeze({ brand: 'Chromium', version: ${JSON.stringify(coreVersion)} }),
    ]);
    const fullVersionList = Object.freeze([
      Object.freeze({ brand: 'Not-A.Brand', version: '99.0.0.0' }),
      Object.freeze({ brand: 'Google Chrome', version: ${JSON.stringify(fullVersion)} }),
      Object.freeze({ brand: 'Chromium', version: ${JSON.stringify(fullVersion)} }),
    ]);
    const uaPlatformVal = ${JSON.stringify(uaDataPlatform)};
    const highEntropyMap = {
      architecture: 'x86',
      bitness: '64',
      brands,
      formFactors: ['Desktop'],
      fullVersionList,
      mobile: false,
      model: '',
      platform: uaPlatformVal,
      platformVersion: ${JSON.stringify(uaDataPlatformVersion)},
      uaFullVersion: ${JSON.stringify(fullVersion)},
      wow64: false,
    };
    const uaDataObj = {
      get brands() { return brands; },
      get mobile() { return false; },
      get platform() { return uaPlatformVal; },
      toJSON() {
        return { brands, mobile: false, platform: uaPlatformVal };
      },
      getHighEntropyValues(hints) {
        const out = { brands, mobile: false, platform: uaPlatformVal };
        if (Array.isArray(hints)) {
          for (const h of hints) {
            if (h in highEntropyMap) out[h] = highEntropyMap[h];
          }
        }
        return Promise.resolve(out);
      },
    };
    if (typeof NavigatorUAData === 'function' && NavigatorUAData.prototype) {
      try { Object.setPrototypeOf(uaDataObj, NavigatorUAData.prototype); } catch (e) {}
    }
    def(Navigator.prototype, 'userAgentData', uaDataObj);
    try { delete navigator.userAgentData; } catch (e) {}
    if (navigator.userAgentData !== uaDataObj) {
      def(navigator, 'userAgentData', uaDataObj);
    }
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}

  // —— DPI ——
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => ${devicePixelRatio},
      configurable: true,
    });
  } catch (e) {}

  // —— ClientRects 微调（同环境稳定） ——
  try {
    const noise = ${clientRectNoise};
    const patchRect = (proto, method) => {
      const orig = proto[method];
      if (!orig || orig.__tkPatched) return;
      proto[method] = function(...args) {
        const r = orig.apply(this, args);
        if (!r) return r;
        try {
          const shift = noise * 0.001;
          if (typeof DOMRect === 'function' && r instanceof DOMRect) {
            return new DOMRect(r.x + shift, r.y + shift, r.width, r.height);
          }
          return r;
        } catch (e) { return r; }
      };
      proto[method].__tkPatched = true;
    };
    patchRect(Element.prototype, 'getBoundingClientRect');
    if (typeof Range !== 'undefined') patchRect(Range.prototype, 'getBoundingClientRect');
  } catch (e) {}

  // —— Fonts 探测干扰（document.fonts.check） ——
  try {
    const allow = new Set(${JSON.stringify(fontList)}.map((f) => String(f).toLowerCase()));
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        try {
          const m = String(font || '').match(/([A-Za-z][A-Za-z0-9 ]{0,40})/);
          const name = (m && m[1] ? m[1] : '').trim().toLowerCase();
          if (name && allow.size && !allow.has(name)) return false;
        } catch (e) {}
        return origCheck(font, text);
      };
    }
  } catch (e) {}

  // —— WebRTC 防泄露 ——
  //
  // 旧实现把 RTCPeerConnection 换成抛异常的构造器。问题：
  //   1. 真实 Chrome 一定存在该对象，构造即抛 NotAllowedError 是极强特征；
  //   2. 检测脚本 new RTCPeerConnection() 一个 try 就能判定环境被改造；
  //   3. 音视频类站点会直接崩，行为不自然。
  // 现在保留原生构造器，只在 ICE 候选与 SDP 两个出口净化，API 语义正常但拿不到本地地址。
  // 配合启动参数 --force-webrtc-ip-handling-policy=disable_non_proxied_udp 形成双层防护。
  try {
    const RTC = window.RTCPeerConnection;
    if (typeof RTC === 'function') {
      const isLeakyCandidate = (candStr) => {
        const s = String(candStr || '');
        if (!s) return true;
        if (/\\btyp\\s+host\\b/.test(s) || /\\btyp\\s+srflx\\b/.test(s)) return true;
        if (/\\b(10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\b172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\.local\\b/.test(s)) return true;
        if (/\\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2,7}\\b/i.test(s) && /candidate/i.test(s)) return true;
        return false;
      };
      const scrubSdp = (sdp) => String(sdp || '')
        .split('\\r\\n')
        .filter((line) => !(line.indexOf('a=candidate:') === 0 && isLeakyCandidate(line)))
        .join('\\r\\n');

      const scrubCandidateEvent = (ev) => {
        try {
          if (!ev) return ev;
          const c = ev.candidate;
          if (!c) return ev; // null candidate 表示收集结束，必须放行
          if (isLeakyCandidate(c.candidate)) {
            return Object.defineProperty(
              Object.create(Object.getPrototypeOf(ev) || Object.prototype),
              'candidate',
              { value: null, configurable: true },
            );
          }
        } catch (e) {}
        return ev;
      };

      const patchEvents = (proto) => {
        if (!proto || proto.__tkRtcPatched) return;
        const addEventListener = proto.addEventListener;
        if (typeof addEventListener === 'function') {
          proto.addEventListener = function(type, listener, ...rest) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              const wrapped = function(ev) {
                const clean = scrubCandidateEvent(ev);
                if (clean && clean.candidate === null && ev && ev.candidate) return undefined;
                return listener.call(this, clean);
              };
              return addEventListener.call(this, type, wrapped, ...rest);
            }
            return addEventListener.call(this, type, listener, ...rest);
          };
        }
        const setLocalDescription = proto.setLocalDescription;
        if (typeof setLocalDescription === 'function') {
          proto.setLocalDescription = function(desc) {
            try {
              if (desc && typeof desc === 'object' && typeof desc.sdp === 'string') {
                desc = { type: desc.type, sdp: scrubSdp(desc.sdp) };
              }
            } catch (e) {}
            return setLocalDescription.call(this, desc);
          };
        }
        const createOffer = proto.createOffer;
        if (typeof createOffer === 'function') {
          proto.createOffer = function(...args) {
            return createOffer.apply(this, args).then((desc) => {
              try {
                if (desc && typeof desc.sdp === 'string') {
                  return { type: desc.type, sdp: scrubSdp(desc.sdp) };
                }
              } catch (e) {}
              return desc;
            });
          };
        }
        proto.__tkRtcPatched = true;
      };
      patchEvents(RTC.prototype);

      try {
        const desc = Object.getOwnPropertyDescriptor(RTC.prototype, 'onicecandidate');
        if (desc && desc.set) {
          Object.defineProperty(RTC.prototype, 'onicecandidate', {
            configurable: true,
            get: desc.get,
            set(fn) {
              if (typeof fn !== 'function') return desc.set.call(this, fn);
              const self = this;
              return desc.set.call(this, function(ev) {
                const clean = scrubCandidateEvent(ev);
                if (clean && clean.candidate === null && ev && ev.candidate) return undefined;
                return fn.call(self, clean);
              });
            },
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
})();`;
}

module.exports = { buildInjectScript, hashSeed };
