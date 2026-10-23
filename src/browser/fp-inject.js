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
  const platform = String(fp.os || 'Win32');
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
  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width && this.height) {
          const w = Math.min(this.width, 16);
          const h = Math.min(this.height, 16);
          const img = ctx.getImageData(0, 0, w, h);
          for (let i = 0; i < img.data.length; i += 4) {
            img.data[i] = (img.data[i] + noiseByte(i)) & 255;
          }
          ctx.putImageData(img, 0, 0);
        }
      } catch (e) {}
      return toDataURL.apply(this, args);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    if (toBlob) {
      HTMLCanvasElement.prototype.toBlob = function(cb, ...rest) {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width && this.height) {
            const img = ctx.getImageData(0, 0, Math.min(this.width, 8), Math.min(this.height, 8));
            for (let i = 0; i < img.data.length; i += 4) {
              img.data[i] = (img.data[i] + noiseByte(i + 99)) & 255;
            }
            ctx.putImageData(img, 0, 0);
          }
        } catch (e) {}
        return toBlob.call(this, cb, ...rest);
      };
    }
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

  // —— AudioContext ——
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const origCreate = AC.prototype.createAnalyser || AC.prototype.createOscillator;
      const getChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel) {
        const data = getChannelData.call(this, channel);
        try {
          if (data && data.length > 100) {
            for (let i = 0; i < 32; i += 1) {
              data[i] = data[i] + (rnd(i + 300) - 0.5) * 1e-7;
            }
          }
        } catch (e) {}
        return data;
      };
      void origCreate;
    }
  } catch (e) {}

  // —— Navigator ——
  try {
    const def = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch (e) {}
    };
    def(Navigator.prototype, 'hardwareConcurrency', ${hardwareConcurrency});
    def(Navigator.prototype, 'deviceMemory', ${deviceMemory});
    def(Navigator.prototype, 'platform', ${JSON.stringify(platform)});
    def(Navigator.prototype, 'languages', Object.freeze(${JSON.stringify(languages)}));
    def(Navigator.prototype, 'language', ${JSON.stringify(languages[0] || 'en-US')});
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
  try {
    const Blocked = function() {
      throw new DOMException('WebRTC disabled by 第一页自研浏览器', 'NotAllowedError');
    };
    Blocked.prototype = {};
    if (typeof window.RTCPeerConnection !== 'undefined') {
      window.RTCPeerConnection = Blocked;
    }
    if (typeof window.webkitRTCPeerConnection !== 'undefined') {
      window.webkitRTCPeerConnection = Blocked;
    }
    if (typeof navigator.mediaDevices !== 'undefined') {
      try {
        navigator.mediaDevices.getUserMedia = function() {
          return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        };
      } catch (e) {}
    }
  } catch (e) {}
})();`;
}

module.exports = { buildInjectScript, hashSeed };
