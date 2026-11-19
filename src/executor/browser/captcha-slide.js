/**
 * 图片拖拽「平移」人机验证：识别 + 本地 Canvas 模板匹配 + 闭环拟人拖拽
 * ===========================================================================
 * 与 ./nocaptchaai.js 里的「图片拖拽旋转（双圆环）」并列，共用同一套自动过码入口：
 *
 *   nocaptchaai.detectCaptcha(page)                  -> { detected, kind: 'rotate' | 'slide' | 'dragbar', ... }
 *   nocaptchaai.solveRotateCaptchaIfPresent(page)     // 名字保留（历史调用点 40+ 处），内部按 kind 分发
 *   nocaptchaai.solveCaptchaIfPresent(page)          // 同上，语义更准的新名字
 *
 * 本模块负责 kind = 'slide'（拼图缺口平移）与 kind = 'dragbar'（无图、把滑块拖到最右），
 * 绝不负责 'rotate'；旋转仍由 nocaptchaai.js 的极坐标算法处理。
 *
 * 为什么要「辨别」而不是「先转再说」：
 *   两类验证共用 TikTok 的同一套弹框外壳（#captcha-verify-container / .captcha_verify_container /
 *   #captcha_slide_button / .secsdk-captcha-drag-icon），文案也常常一模一样
 *   （Drag the slider to fit the puzzle），只靠类名或文案必然互相误判。
 *   本模块只用【几何】证据区分，全部以可见元素的真实 getBoundingClientRect 为准：
 *     1) 旋转：外环 + 内圆两张近方形图，中心几乎重合（同心），宽高比都落在 0.78~1.28；
 *     2) 平移：一张横向大图（宽高比 >= 1.15，宽 >= 180）上叠着一块 12%~52% 宽的小图，小图贴在左侧；
 *     3) 纯滑条：弹框里一张验证图都没有，只有 >= 160px 的滑轨 + 滑块，且文案要求「拖到最右」。
 *   三条证据互斥，因此不会把旋转当成平移、也不会把普通裁剪/进度条滑块当成验证码：
 *   任何一条都必须先落在 captcha / secsdk / verify 的弹框外壳里才成立。
 *
 * 缺口定位（零成本、免 Key、毫秒级、不受省流与截图限制影响）：
 *   1) 直接吃页面里的两张图（img / canvas / background-image 均可），按真实 CSS 尺寸等比重绘到离屏 Canvas；
 *   2) 以拼图块的不透明区域为模板，在背景图上滑窗，四项信号加权：
 *        · 亮度 NCC            （结构相关，对缺口整体压暗不敏感）
 *        · 梯度 NCC            （对亮度整体缩放完全不敏感）
 *        · 拼图 alpha 轮廓响应  （背景缺口被涂成纯黑/纯色剪影时，只剩轮廓还能对上）
 *        · 缺口矩形四边框能量   （轮廓退化、拼图块无透明通道时的兜底）
 *      取主峰、抑制次峰得到置信度；主峰太弱则退回「边框能量」全图搜索；
 *   3) 结果换算成【拼图块元素相对背景元素的 CSS 位移】，不依赖缩放比例、DPR 或设备像素。
 *
 * 落点校准（过关率的关键）：
 *   按住后先走一小段试探位移，读拼图块 getBoundingClientRect 的真实位移，算出
 *   「滑块 px -> 拼图 px」映射比 r（有的 1:1、有的 0.5、有的前 20px 死区），
 *   之后每走一步都重读真实位移用 r 闭环纠偏，把残差压到 <= 1.6px 再松手。
 *   所以本模块不写死 scale / maxSlideDistance / 初始 left，也不需要知道滑轨的宽度。
 *
 * 环境变量：
 *   TKSWARM_CAPTCHA_SLIDE_AUTO=0      关闭自动过平移验证（仍然识别分类，命中后交人工）
 *   TKSWARM_CAPTCHA_DRAGBAR_AUTO=0    关闭自动过「无图滑条拖到最右」验证
 *   TKSWARM_CAPTCHA_SLIDE_ATTEMPTS=3  单个弹框最多尝试次数（1~6）
 *   TKSWARM_CAPTCHA_SLIDE_MODE=auto   拖拽入口：auto | handle（只认滑轨滑块）| piece（只拖拼图块）
 *   TKSWARM_CAPTCHA_SLIDE_DEBUG=1     打印每次模板匹配的 TOP 候选（很吵，仅调参用）
 *   TKSWARM_CAPTCHA_DEBUG=1           求解失败时落盘 DOM 片段 + 截图到 src/data/captcha-debug/
 *
 * 注意：本模块只做「读页面 + 发鼠标事件」，不改 DOM 属性、不注入样式，
 * 以免给 secsdk 的 MutationObserver 送特征。
 */

const KINDS = Object.freeze({
  ROTATE: 'rotate',
  SLIDE: 'slide',
  DRAGBAR: 'dragbar',
});

const DEFAULT_MAX_ATTEMPTS = 3;
const MATCH_ACCEPT_SCORE = 0.34;      // 低于此分视为「没找到缺口」
const MATCH_GOOD_CONFIDENCE = 0.45;   // 低于此置信度会提示一句，但仍然会尝试拖

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function clampNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function round1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function envFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return !/^(0|false|off|no|none|disable|disabled)$/i.test(String(raw).trim());
}

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

/** 裸 base64 / dataURL 统一成可喂给 <img> 的 dataURL */
function toImageDataUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^data:image\//i.test(text)) return text;
  let mime = 'image/png';
  if (/^\/9j\//.test(text)) mime = 'image/jpeg';
  else if (/^R0lGOD/.test(text)) mime = 'image/gif';
  else if (/^UklGR/.test(text)) mime = 'image/webp';
  else if (/^iVBOR/.test(text)) mime = 'image/png';
  return `data:${mime};base64,${text.replace(/\s+/g, '')}`;
}

// ---------------------------------------------------------------------------
// 1) 页面内识别：这一屏到底是「旋转」还是「平移」
// ---------------------------------------------------------------------------
/**
 * 在 Page / Frame 内探测「图片拖拽平移」验证。
 *
 * 未命中时：{ detected:false, hint:boolean, loading?:boolean, reason?:string }
 *   hint=true 表示确实有验证器外壳或滑轨，只是还没凑齐可解结构（调用方可以再等一会儿）。
 *
 * 命中时：{ detected:true, kind:'slide'|'dragbar', bgSrc, pieceSrc, bgFit, pieceFit,
 *          bgRect, bgBox, pieceRect, pieceOffsetX, pieceOffsetY, handleRect, trackRect,
 *          maxSlideDistance, dragMode:'handle'|'piece', solvable, reason, hintText, ... }
 *
 * 所有 rect 都是「相对当前 document 视口」的 CSS 像素；
 * 落在 iframe 里时由 nocaptchaai.detectCaptcha() 统一补 frame 偏移。
 *
 * @param {{ evaluate: Function }} target Page 或 Frame
 * @param {{ debug?: boolean, mode?: string }} [opts]
 */
async function inspectSlideCaptchaInContext(target, opts = {}) {
  if (!target || typeof target.evaluate !== 'function') return { detected: false };
  const wantDebug = Boolean(opts && opts.debug);
  const mode = String((opts && opts.mode) || 'auto');
  const raw = await target.evaluate((opt) => {
    const DEBUG = Boolean(opt && opt.debug);
    const FORCE_MODE = String((opt && opt.mode) || 'auto').toLowerCase();
    try {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;

      // ---------------- 基础工具 ----------------
      const styleOf = (el) => {
        try { return window.getComputedStyle(el) || null; } catch (e) { return null; }
      };
      const nameOf = (el) => {
        let cls = '';
        try {
          cls = (typeof el.className === 'string')
            ? el.className
            : String((el.getAttribute && el.getAttribute('class')) || '');
        } catch (e) { cls = ''; }
        const id = String((el && el.id) || '');
        const e2e = String((el && el.getAttribute && el.getAttribute('data-e2e')) || '');
        return `${id} ${cls} ${e2e}`.replace(/\s+/g, ' ').trim().slice(0, 160);
      };
      const textOf = (el) => {
        try { return String((el && (el.innerText || el.textContent)) || ''); } catch (e) { return ''; }
      };
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const isVisible = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if (el === document.body || el === document.documentElement) return false;
        const r = el.getBoundingClientRect();
        if (!(r.width > 6 && r.height > 6)) return false;
        const st = styleOf(el);
        if (!st) return false;
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
        if (Number(st.opacity) === 0) return false;
        if (r.bottom < -6 || r.right < -6) return false;
        if (r.top > vh + 6 || r.left > vw + 6) return false;
        return true;
      };

      // 被 overflow:hidden/auto 的祖先裁掉之后，真正还能看见的区域（截图兜底要用它）
      const visibleRectOf = (el) => {
        const base = boxOf(el);
        let x0 = base.x;
        let y0 = base.y;
        let x1 = base.right;
        let y1 = base.bottom;
        let p = el.parentElement;
        for (let depth = 0; p && p !== document.documentElement && depth < 5; depth += 1, p = p.parentElement) {
          const st = styleOf(p);
          if (!st) continue;
          const ov = `${st.overflow} ${st.overflowX} ${st.overflowY}`;
          if (!/(hidden|clip|auto|scroll)/i.test(ov)) continue;
          const pr = boxOf(p);
          if (pr.x > x0) x0 = pr.x;
          if (pr.y > y0) y0 = pr.y;
          if (pr.right < x1) x1 = pr.right;
          if (pr.bottom < y1) y1 = pr.bottom;
        }
        if (!(x1 - x0 > 6 && y1 - y0 > 6)) return null;
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      };

      // ---------------- 1. 验证弹框外壳 ----------------
      const SHELL_SELECTORS = [
        '.TUXModal.captcha-verify-container',
        '#captcha-verify-container',
        '.captcha_verify_container',
        '[class*="captcha-verify-container" i]',
        '[class*="captcha_verify_container" i]',
        '[class*="captcha_verify" i]',
        '[class*="secsdk-captcha" i]',
        '[class*="secsdk_captcha" i]',
        '[id*="captcha-verify" i]',
        '[id*="captcha_verify" i]',
        '[class*="captcha" i]',
        '[id*="captcha" i]',
      ];

      const seenShell = new Set();
      const shells = [];
      for (let si = 0; si < SHELL_SELECTORS.length; si += 1) {
        let list = [];
        try { list = Array.from(document.querySelectorAll(SHELL_SELECTORS[si])); } catch (e) { list = []; }
        for (let li = 0; li < list.length && shells.length < 14; li += 1) {
          const el = list[li];
          if (!el || seenShell.has(el)) continue;
          seenShell.add(el);
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 110 || r.height < 40) continue;
          if (r.width > vw * 1.05 || r.height > vh * 1.05) continue;
          shells.push({ el, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, area: r.width * r.height });
        }
      }
      if (!shells.length) return { detected: false, hint: false, reason: 'no_captcha_shell' };

      // ---------------- 2. 拖拽入口（滑轨 / 滑块） ----------------
      const DRAG_SELECTORS = [
        '#captcha_slide_button',
        '.secsdk-captcha-drag-icon',
        'div.cap-flex.cap-absolute',
        '[class*="captcha_verify_slide" i]',
        '[class*="slide--slidebar" i]',
        '[class*="slidebar" i]',
        '[class*="slide-bar" i]',
        '[class*="slider-track" i]',
        '[class*="slider_btn" i]',
        '[class*="slider-button" i]',
        '[class*="slide-btn" i]',
        '[class*="slide_btn" i]',
        '[class*="drag-icon" i]',
        '[class*="drag_icon" i]',
        '[class*="drag-btn" i]',
        '[class*="drag_bar" i]',
        '[class*="drag-bar" i]',
        '[role="slider"]',
        '[aria-label*="slider" i]',
        '[aria-label*="滑块" i]',
      ];
      const DRAG_SEL = DRAG_SELECTORS.join(',');

      const TRACK_SELECTORS = [
        '.captcha_verify_slide--slidebar',
        '[class*="captcha_verify_slide--slidebar" i]',
        '[class*="captcha_verify_slide" i]',
        '[class*="secsdk-captcha-drag-wrapper" i]',
        '[class*="slidebar" i]',
        '[class*="slide-bar" i]',
        '[class*="slider-track" i]',
        '[class*="slide-track" i]',
        '[class*="drag-bar" i]',
        '[class*="drag-track" i]',
        '[class*="drag-wrapper" i]',
        '[class*="bar-bg" i]',
      ];
      const TRACK_SEL = TRACK_SELECTORS.join(',');

      const PIECE_HINT = /puzzle|piece|jigsaw|block|cap-|slice|cut|frag|gap|drag|move|slide|thumb/i;
      const BG_HINT = /image|img|bg|back|photo|pic|canvas|main|verify|slide|puzzle/i;

      const queryWithin = (parent, sel) => {
        if (!parent || typeof parent.querySelectorAll !== 'function') return [];
        try { return Array.from(parent.querySelectorAll(sel)); } catch (e) { return []; }
      };

      const cueSizeOk = (r) => r.width >= 14 && r.width <= 220 && r.height >= 10 && r.height <= 96;

      /** 返回该作用域内「挨着这颗背景图下方」的滑块，挑最近的那个 */
      const pickCueFor = (bgRect, cueList) => {
        let best = null;
        let bestDy = Infinity;
        for (let i = 0; i < cueList.length; i += 1) {
          const el = cueList[i];
          let r = null;
          try { r = el.getBoundingClientRect(); } catch (e) { continue; }
          if (!cueSizeOk(r)) continue;
          if (r.left < bgRect.x - 90 || r.left > bgRect.x + bgRect.width + 90) continue;
          const dy = r.top - (bgRect.y + bgRect.height);
          if (dy < -42 || dy > 190) continue;
          const dist = Math.abs(dy);
          if (dist < bestDy) { bestDy = dist; best = el; }
        }
        return best;
      };

      // ---------------- 3. 候选图片节点 ----------------
      const collectImageNodes = (rootEl) => {
        const out = [];
        if (!rootEl) return out;
        const raw = queryWithin(rootEl, 'img, canvas').filter(isVisible);
        for (let i = 0; i < raw.length && out.length < 40; i += 1) {
          const el = raw[i];
          const r = el.getBoundingClientRect();
          if (r.width < 18 || r.height < 18) continue;
          out.push({ el, tag: String(el.tagName || '').toUpperCase(), rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
        }
        // 图片也可能画在 div 的 background-image 上；只在 img/canvas 不够用时才扫，避免 getComputedStyle 风暴
        if (out.length < 4) {
          const BG_SELECTORS = [
            'div[style*="background-image"]', 'span[style*="background-image"]', 'i[style*="background-image"]',
            '[class*="puzzle" i]', '[class*="piece" i]', '[class*="jigsaw" i]', '[class*="block" i]',
            '[class*="captcha_verify" i]', '[class*="captcha-verify" i]',
            '[class*="image" i]', '[class*="img-" i]', '[class*="bg-" i]', '[class*="pic" i]',
            '[class*="canvas" i]', '[class*="slice" i]', '[class*="cut-" i]', '[class*="frag" i]',
          ];
          let cands = [];
          for (let si2 = 0; si2 < BG_SELECTORS.length; si2 += 1) {
            cands = cands.concat(queryWithin(rootEl, BG_SELECTORS[si2]));
          }
          for (let i = 0; i < cands.length && i < 260 && out.length < 44; i += 1) {
            const el = cands[i];
            if (!isVisible(el)) continue;
            if (el.querySelector('img, canvas')) continue;   // 只认叶子容器
            const st = styleOf(el);
            const bi = st && st.backgroundImage ? String(st.backgroundImage) : '';
            if (!/^url\(/i.test(bi)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 18 || r.height < 18) continue;
            out.push({ el, tag: 'NODE', bgImage: bi, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
            // 去重：同一节点可能被多条选择器命中
            for (let k = out.length - 2; k >= 0; k -= 1) {
              if (out[k].el === el) { out.splice(k, 1); break; }
            }
          }
        }
        // 同一块区域既有 <img> 又有包着它的 div 时，只留真正画图的节点
        const rank = (t) => (t === 'IMG' ? 0 : (t === 'CANVAS' ? 1 : 2));
        const sorted = out.slice().sort((a, b) => rank(a.tag) - rank(b.tag));
        const kept = [];
        for (let i = 0; i < sorted.length; i += 1) {
          const n = sorted[i];
          let dup = false;
          for (let k = 0; k < kept.length; k += 1) {
            const o = kept[k];
            if (Math.abs(o.rect.x - n.rect.x) < 3 && Math.abs(o.rect.y - n.rect.y) < 3
              && Math.abs(o.rect.width - n.rect.width) < 3 && Math.abs(o.rect.height - n.rect.height) < 3) {
              dup = true;
              break;
            }
          }
          if (!dup) kept.push(n);
        }
        return kept;
      };

      const srcOf = (node) => {
        const el = node.el;
        try {
          if (node.tag === 'IMG') return String(el.currentSrc || el.src || '');
          if (node.tag === 'CANVAS') {
            const d = el.toDataURL('image/png');
            return (d && d.length > 64) ? d : '';
          }
          const m = String(node.bgImage || '').match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/i);
          return m ? String(m[2]).trim() : '';
        } catch (e) {
          return '';
        }
      };

      const fitOf = (node) => {
        const el = node.el;
        try {
          if (node.tag === 'IMG') {
            const st = styleOf(el);
            const f = String((st && st.objectFit) || (el.style && el.style.objectFit) || 'fill').toLowerCase();
            if (f === 'scale-down') return 'contain';
            return f;
          }
          if (node.tag === 'NODE') {
            const st = styleOf(el);
            const bs = String((st && st.backgroundSize) || '').toLowerCase();
            if (bs.indexOf('cover') >= 0) return 'cover';
            if (bs.indexOf('contain') >= 0) return 'contain';
            return 'fill';
          }
        } catch (e) { /* ignore */ }
        return 'fill';
      };

      const pieceDraggable = (el) => {
        if (!el) return false;
        try {
          const st = styleOf(el);
          if (st) {
            if (st.position === 'absolute' || st.position === 'fixed') return true;
            if (st.transform && st.transform !== 'none') return true;
            if (st.cursor && /(pointer|move|grab|grabbing)/i.test(st.cursor)) return true;
          }
          const inline = String((el.getAttribute && el.getAttribute('style')) || '');
          if (/(left|top|translate|transform)\s*:/i.test(inline)) return true;
          if (el.getAttribute && el.getAttribute('draggable') === 'true') return true;
          if (PIECE_HINT.test(nameOf(el))) return true;
          const parent = el.parentElement;
          if (parent) {
            const pst = styleOf(parent);
            if (pst && pst.cursor && /(pointer|move|grab)/i.test(pst.cursor)) return true;
          }
        } catch (e) { /* ignore */ }
        return false;
      };

      // ---------------- 4. 找「宽背景 + 小拼图块」 ----------------
      const seenPairKeys = [];
      const scannedScopes = new Set();
      let bestPair = null;

      const considerScope = (scopeEl, cueList) => {
        if (!scopeEl || !isVisible(scopeEl)) return;
        // 多个外壳常常共享同一层遮罩/卡片，沿父级上探时会重复命中：每个作用域只扫一次
        if (scannedScopes.has(scopeEl)) return;
        scannedScopes.add(scopeEl);
        const nodes = collectImageNodes(scopeEl);
        if (nodes.length < 2) return;
        for (let i = 0; i < nodes.length; i += 1) {
          const bgNode = nodes[i];
          const bgAspect = bgNode.rect.width / Math.max(1, bgNode.rect.height);
          if (bgNode.rect.width < 180 || bgNode.rect.height < 80) continue;
          if (bgAspect < 1.15 || bgAspect > 3.4) continue;
          if (bgNode.rect.width > 1080) continue;
          if (bgNode.rect.width > vw * 0.94 || bgNode.rect.height > vh * 0.82) continue;

          const cueNear = pickCueFor(bgNode.rect, cueList);

          for (let j = 0; j < nodes.length; j += 1) {
            const pcNode = nodes[j];
            if (pcNode.el === bgNode.el) continue;
            if (pcNode.rect.width >= bgNode.rect.width) continue;
            if (pcNode.rect.height >= bgNode.rect.height) continue;
            const wRatio = pcNode.rect.width / bgNode.rect.width;
            if (wRatio < 0.1 || wRatio > 0.52) continue;
            if (pcNode.rect.height > bgNode.rect.height * 0.86) continue;
            const pcAspect = pcNode.rect.width / Math.max(1, pcNode.rect.height);
            if (pcAspect < 0.45 || pcAspect > 2.1) continue;

            const overlapTop = Math.max(pcNode.rect.y, bgNode.rect.y);
            const overlapBottom = Math.min(pcNode.rect.y + pcNode.rect.height, bgNode.rect.y + bgNode.rect.height);
            const overlap = overlapBottom - overlapTop;
            if (overlap <= 0) continue;
            const overlapRatio = overlap / Math.min(pcNode.rect.height, bgNode.rect.height);
            if (overlapRatio < 0.55) continue;

            if (pcNode.rect.x + pcNode.rect.width < bgNode.rect.x + 4) continue;
            if (pcNode.rect.x > bgNode.rect.x + bgNode.rect.width - 8) continue;

            const pcName = nameOf(pcNode.el);
            const bgName = nameOf(bgNode.el);
            const pcHinted = /puzzle|piece|jigsaw|block|slice|cut|frag|gap|drag|move/i.test(pcName);
            const pcDraggable = pieceDraggable(pcNode.el);
            // 安全闸：既没有贴着的滑块、拼图块自己也没有任何「可拖」证据 => 不当成验证码，继续等
            if (!cueNear && !pcHinted && !(pcDraggable && wRatio <= 0.34 && (pcNode.rect.y - bgNode.rect.y) < bgNode.rect.height * 0.5)) continue;

            let score = 0.34;
            score += 0.16 * (1 - Math.min(1, Math.abs(pcAspect - 1)));
            if (wRatio >= 0.16 && wRatio <= 0.42) score += 0.10;
            if (pcHinted) score += 0.18;
            if (BG_HINT.test(bgName)) score += 0.10;
            if (pcNode.rect.x - bgNode.rect.x < bgNode.rect.width * 0.18) score += 0.12;
            if (pcNode.tag === 'CANVAS' || bgNode.tag === 'CANVAS') score += 0.04;
            if (pcNode.rect.width >= 24 && pcNode.rect.height >= 24) score += 0.04;
            if (pcNode.rect.y - bgNode.rect.y < bgNode.rect.height * 0.55) score += 0.03;
            if (cueNear) {
              const cr = cueNear.getBoundingClientRect();
              score += 0.14;
              if (cr.left >= bgNode.rect.x - 44 && cr.right <= bgNode.rect.x + bgNode.rect.width + 44) score += 0.06;
            }
            if (overlapRatio >= 0.85) score += 0.04;
            score = Math.min(1, score);

            const key = `${Math.round(bgNode.rect.x)}:${Math.round(bgNode.rect.y)}:${Math.round(bgNode.rect.width)}`
              + `|${Math.round(pcNode.rect.x)}:${Math.round(pcNode.rect.y)}:${Math.round(pcNode.rect.width)}`;
            if (seenPairKeys.indexOf(key) >= 0) continue;
            seenPairKeys.push(key);

            if (!bestPair || score > bestPair.score) {
              bestPair = { bgNode, pcNode, cue: cueNear, score, scopeEl, overlapRatio };
            }
          }
        }
      };

      for (let si = 0; si < shells.length && si < 12; si += 1) {
        const shell = shells[si];
        const cues = queryWithin(shell.el, DRAG_SEL).filter(isVisible);
        considerScope(shell.el, cues);
        // 滑轨挂在某个「卡片」上时，卡片往往比整块遮罩更贴近图片集合：沿父级上探 6 层
        let cursor = cues.length ? cues[0].parentElement : null;
        for (let up = 0; cursor && cursor !== document.body && up < 6; up += 1, cursor = cursor.parentElement) {
          const cr = cursor.getBoundingClientRect();
          if (cr.width < 150 || cr.height < 60) continue;
          if (cr.width > vw * 1.05 || cr.height > vh * 1.05) continue;
          considerScope(cursor, cues);
        }
      }

      const hintTextOf = (el) => String(textOf(el || document.body)).replace(/\s+/g, ' ').trim().slice(0, 240);
      const hasPuzzleWords = (txt) => /puzzle|jigsaw|拼图|缺口|fit\s*the\s*(puzzle|picture)|rotate|旋转|调整角度|turn\s*the\s*image|align\s*the/i.test(txt);
      const hasDragRightWords = (txt) => /(slide|drag|swipe)\s*(it\s*)?(to\s*the\s*)?(right|end)|最右|右端|向右拖动|拖到最右|滑动验证|拖动滑块验证|slide\s*to\s*verify|swipe\s*to\s*verify/i.test(txt);

      // ---------------- 5. 没有图对：判断是无图滑条，还是图还没加载 ----------------
      if (!bestPair) {
        for (let si = 0; si < shells.length && si < 12; si += 1) {
          const shell = shells[si];
          const cueList = queryWithin(shell.el, DRAG_SEL).filter(isVisible);
          if (!cueList.length) continue;
          // 有「验证大图」就不算纯滑条：小图标/logo/二维码（<=119x59）不算，
          // 这样带品牌位图的滑条仍能过，而拼图/旋转（背景一定是大图）绝不会被当成滑条
          const shellImgs = collectImageNodes(shell.el);
          if (shellImgs.some((n) => n.rect.width >= 120 && n.rect.height >= 60)) continue;
          const txt = hintTextOf(shell.el);
          if (!txt || !hasDragRightWords(txt)) continue;
          if (hasPuzzleWords(txt)) continue;

          const handleEl = cueList[0];
          const hr = handleEl.getBoundingClientRect();
          if (hr.width < 16 || hr.width > 140 || hr.height < 10 || hr.height > 92) continue;

          let trackEl = null;
          const trackCands = queryWithin(shell.el, TRACK_SEL).filter(isVisible);
          for (let ti = 0; ti < trackCands.length; ti += 1) {
            const t = trackCands[ti];
            const tr = t.getBoundingClientRect();
            if (tr.width < hr.width * 1.8 || tr.width > 900) continue;
            if (tr.height > 110) continue;
            if (tr.top < hr.top - 70 || tr.bottom > hr.bottom + 70) continue;
            trackEl = t;
            break;
          }
          const trackRectRaw = trackEl ? trackEl.getBoundingClientRect() : null;
          const travel = trackRectRaw
            ? Math.max(60, trackRectRaw.width - hr.width)
            : Math.max(120, Math.min(vw - hr.left - hr.width - 14, vw * 0.62));

          return {
            detected: true,
            kind: 'dragbar',
            bgSrc: '',
            pieceSrc: '',
            bgFit: 'fill',
            pieceFit: 'fill',
            bgRect: null,
            bgBox: null,
            pieceRect: null,
            pieceOffsetX: 0,
            pieceOffsetY: 0,
            handleRect: { x: hr.left, y: hr.top, width: hr.width, height: hr.height },
            trackRect: trackRectRaw
              ? { x: trackRectRaw.left, y: trackRectRaw.top, width: trackRectRaw.width, height: trackRectRaw.height }
              : { x: hr.left, y: hr.top, width: travel + hr.width, height: hr.height },
            trackSource: trackRectRaw ? 'selector' : 'synth',
            maxSlideDistance: travel,
            dragMode: 'handle',
            solvable: true,
            reason: '',
            hintText: txt.slice(0, 200),
            shellHtml: DEBUG ? String(shell.el.outerHTML || '').slice(0, 6000) : '',
          };
        }

        const hintText = hintTextOf(null);
        // 弹框已显示 "Verification timed out. Please close this window."：里面没有图也没有刷新钮
        const shellText = shells.slice(0, 12).map((s) => hintTextOf(s.el)).join(' ');
        const timedOut = /verification timed out|timed out\.?\s*please close|please close this window|验证超时|验证已超时|已超时|请关闭此窗口|请关闭窗口/i.test(`${shellText} ${hintText}`);
        return {
          detected: false,
          hint: true,
          loading: true,
          timedOut,
          reason: timedOut ? 'captcha_verification_timed_out' : (hasPuzzleWords(hintText) ? 'slide_images_pending' : 'captcha_shell_without_pair'),
          hintText: hintText.slice(0, 200),
        };
      }

      // ---------------- 6. 拼出平移验证的完整几何 ----------------
      const bgEl = bestPair.bgNode.el;
      const pcEl = bestPair.pcNode.el;
      const bgBox = bestPair.bgNode.rect;
      const pcBox = bestPair.pcNode.rect;
      const bgVisible = visibleRectOf(bgEl) || bgBox;
      const clipFrac = Math.max(0, 1 - (bgVisible.width * bgVisible.height) / Math.max(1, bgBox.width * bgBox.height));

      const handleEl = bestPair.cue || null;
      let handleRect = null;
      if (handleEl) {
        const hr = handleEl.getBoundingClientRect();
        handleRect = { x: hr.left, y: hr.top, width: hr.width, height: hr.height };
      }

      let trackRect = null;
      let trackSource = 'synth';
      if (handleRect) {
        const trackCands = queryWithin(document, TRACK_SEL).filter(isVisible);
        for (let ti = 0; ti < trackCands.length && ti < 24; ti += 1) {
          const t = trackCands[ti];
          const tr = t.getBoundingClientRect();
          if (tr.width < handleRect.width * 1.8 || tr.width > 900) continue;
          if (tr.height > 110) continue;
          if (tr.top < handleRect.y - 70 || tr.bottom > handleRect.y + handleRect.height + 70) continue;
          if (!(t.contains(handleEl) || t === handleEl.parentElement || t.parentElement === handleEl.parentElement)) continue;
          trackRect = { x: tr.left, y: tr.top, width: tr.width, height: tr.height };
          trackSource = 'selector';
          break;
        }
        if (!trackRect) {
          let p = handleEl.parentElement;
          for (let depth = 0; p && p !== document.body && depth < 6; depth += 1, p = p.parentElement) {
            const pr = p.getBoundingClientRect();
            if (pr.width >= Math.max(170, handleRect.width * 1.9) && pr.width <= 760
              && pr.height <= 110 && pr.height >= Math.max(12, handleRect.height - 6)) {
              trackRect = { x: pr.left, y: pr.top, width: pr.width, height: pr.height };
              trackSource = 'parent';
              break;
            }
          }
        }
        if (!trackRect) {
          const maxTravel = Math.max(60, Math.min(vw - handleRect.x - handleRect.width - 14, vw * 0.66));
          trackRect = { x: handleRect.x, y: handleRect.y, width: handleRect.width + maxTravel, height: handleRect.height };
          trackSource = 'synth';
        }
      }

      let maxSlideDistance;
      if (trackRect && handleRect) maxSlideDistance = Math.max(60, trackRect.width - handleRect.width);
      else if (trackRect) maxSlideDistance = Math.max(60, trackRect.width * 0.7);
      else maxSlideDistance = Math.max(60, Math.min(vw * 0.62, bgBox.width * 0.9));

      let dragMode = handleRect ? 'handle' : 'piece';
      if (FORCE_MODE === 'handle' && !handleRect) dragMode = 'piece';
      if (FORCE_MODE === 'piece') dragMode = 'piece';

      const pcDraggable = pieceDraggable(pcEl);
      // 背景要是被父级裁掉一大半（比如只露出顶部一条），缺口坐标就不可信了，宁可不拖
      const solvable = clipFrac < 0.4;

      return {
        detected: true,
        kind: 'slide',
        bgSrc: srcOf(bestPair.bgNode),
        pieceSrc: srcOf(bestPair.pcNode),
        bgSrcKind: bestPair.bgNode.tag,
        pieceSrcKind: bestPair.pcNode.tag,
        bgFit: fitOf(bestPair.bgNode),
        pieceFit: fitOf(bestPair.pcNode),
        bgRect: { x: bgVisible.x, y: bgVisible.y, width: bgVisible.width, height: bgVisible.height },
        bgBox: { x: bgBox.x, y: bgBox.y, width: bgBox.width, height: bgBox.height },
        pieceRect: { x: pcBox.x, y: pcBox.y, width: pcBox.width, height: pcBox.height },
        pieceOffsetX: pcBox.x - bgVisible.x,
        pieceOffsetY: pcBox.y - bgVisible.y,
        handleRect,
        trackRect,
        trackSource,
        maxSlideDistance,
        dragMode,
        solvable,
        reason: solvable ? '' : 'bg_mostly_clipped',
        clipFrac: Math.round(clipFrac * 100) / 100,
        pairScore: Math.round(bestPair.score * 100) / 100,
        overlapRatio: Math.round(bestPair.overlapRatio * 100) / 100,
        pieceDraggable: pcDraggable,
        bgName: nameOf(bgEl).slice(0, 120),
        pieceName: nameOf(pcEl).slice(0, 120),
        hintText: hintTextOf(bestPair.scopeEl).slice(0, 200),
        shellHtml: DEBUG ? String((bestPair.scopeEl || document.body).outerHTML || '').slice(0, 8000) : '',
      };
    } catch (err) {
      return { detected: false, error: String((err && err.message) || err) };
    }
  }, { debug: wantDebug, mode }).catch((err) => ({
    detected: false,
    error: `inspect_slide_evaluate_failed: ${(err && err.message) || err}`,
  }));

  if (!raw || typeof raw !== 'object') return { detected: false, reason: 'bad_inspect_result' };
  return raw;
}

// ---------------------------------------------------------------------------
// 2) 本地 Canvas 模板匹配：拼图块还应该相对背景水平位移多少 CSS 像素
// ---------------------------------------------------------------------------
/**
 * 纯本地、零成本、不发网络请求：把两张图按页面真实 CSS 尺寸重绘到离屏 Canvas，
 * 在背景上滑窗做「亮度 NCC + 梯度 NCC + 拼图轮廓响应 + 缺口边框能量」加权匹配。
 *
 * @param {{ evaluate: Function }} target
 * @param {object} params
 * @param {string} params.bgDataUrl      背景图 dataURL
 * @param {string} params.pieceDataUrl   拼图块 dataURL
 * @param {{width:number,height:number}} params.bgRect     背景绘制区 CSS 尺寸
 * @param {{width:number,height:number}} params.pieceRect  拼图块 CSS 尺寸
 * @param {number} [params.pieceOffsetX] 拼图块当前相对背景左上角的 CSS 位移（与 bgRect 同一坐标系）
 * @param {number} [params.pieceOffsetY]
 * @param {string} [params.bgFit]        背景的 object-fit / background-size 映射：fill|cover|contain|none
 * @param {string} [params.pieceFit]
 * @param {boolean} [params.screenshotMode] 图来自屏幕截图（背景里已经含着拼图块本身）
 * @returns {Promise<{ok:boolean, deltaXCss?:number, targetLeftCss?:number, confidence?:number,
 *   score?:number, method?:string, error?:string, elapsedMs?:number, candidates?:Array}>}
 */
async function solveSlideTargetByLocalCanvas(target, params = {}) {
  const {
    bgDataUrl = '',
    pieceDataUrl = '',
    bgRect = null,
    pieceRect = null,
    pieceOffsetX = 0,
    pieceOffsetY = 0,
    bgFit = 'fill',
    pieceFit = 'fill',
    screenshotMode = false,
  } = params || {};

  if (!target || typeof target.evaluate !== 'function') {
    return { ok: false, confidence: 0, error: '缺少页面上下文 target' };
  }
  if (!bgRect || !pieceRect || !(bgRect.width > 20) || !(pieceRect.width > 8)) {
    return { ok: false, confidence: 0, error: '缺少背景图/拼图块几何信息' };
  }
  const bgUrl = toImageDataUrl(bgDataUrl);
  const pieceUrl = toImageDataUrl(pieceDataUrl);
  if (!bgUrl || !pieceUrl) {
    return { ok: false, confidence: 0, error: '缺少背景图或拼图块像素数据' };
  }

  const scale = Math.min(
    1,
    560 / Math.max(80, Number(bgRect.width) || 0),
    900 / Math.max(24, Number(bgRect.height) || 0),
  );

  let res = null;
  try {
    res = await target.evaluate(async (a) => {
      const t0 = performance.now();
      const MAX_SAMPLES = 1600;
      const ACCEPT = Number(a.accept) > 0 ? Number(a.accept) : 0.34;
      const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

      const newCanvas = (w, h) => {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
      };
      const drawFitted = (ctx, img, W, H, fit) => {
        const iw = img.naturalWidth || img.width || W;
        const ih = img.naturalHeight || img.height || H;
        if (!iw || !ih) { ctx.drawImage(img, 0, 0, W, H); return; }
        if (fit === 'cover' || fit === 'contain') {
          const s = fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
          ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
          return;
        }
        if (fit === 'none') { ctx.drawImage(img, 0, 0, iw, ih); return; }
        ctx.drawImage(img, 0, 0, W, H);
      };
      const loadImage = (url, tag) => new Promise((resolve, reject) => {
        if (!url) { reject(new Error('empty_' + tag)); return; }
        const im = new Image();
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(tag + '_timeout'));
        }, 15000);
        im.onload = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(im);
        };
        im.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(tag + '_load_failed'));
        };
        im.src = url;
      });
      const sobel = (src, w, h, gx, gy) => {
        for (let y = 1; y < h - 1; y += 1) {
          const row = y * w;
          for (let x = 1; x < w - 1; x += 1) {
            const i = row + x;
            const tl = src[i - w - 1];
            const tc = src[i - w];
            const tr = src[i - w + 1];
            const ml = src[i - 1];
            const mr = src[i + 1];
            const bl = src[i + w - 1];
            const bc = src[i + w];
            const br = src[i + w + 1];
            gx[i] = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
            gy[i] = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
          }
        }
      };

      try {
        const bgW = Math.max(24, Math.min(1000, a.bgW | 0));
        const bgH = Math.max(16, Math.min(1000, a.bgH | 0));
        const pW = Math.max(8, Math.min(400, a.pW | 0));
        const pH = Math.max(8, Math.min(400, a.pH | 0));
        const sc = a.scale > 0 ? a.scale : 1;

        const [bgImg, pieceImg] = await Promise.all([
          loadImage(a.bgUrl, 'bg'),
          loadImage(a.pieceUrl, 'piece'),
        ]);

        // ---- 背景像素 ----
        const bgCanvas = newCanvas(bgW, bgH);
        const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
        bgCtx.clearRect(0, 0, bgW, bgH);
        drawFitted(bgCtx, bgImg, bgW, bgH, a.bgFit);
        const bgPix = bgCtx.getImageData(0, 0, bgW, bgH).data;

        // ---- 拼图块像素 ----
        const pcCanvas = newCanvas(pW, pH);
        const pcCtx = pcCanvas.getContext('2d', { willReadFrequently: true });
        pcCtx.clearRect(0, 0, pW, pH);
        drawFitted(pcCtx, pieceImg, pW, pH, a.pieceFit);
        const pcPix = pcCtx.getImageData(0, 0, pW, pH).data;

        const bgL = new Float32Array(bgW * bgH);
        const bgAlive = new Uint8Array(bgW * bgH);
        for (let i = 0, p = 0; i < bgL.length; i += 1, p += 4) {
          bgL[i] = 0.299 * bgPix[p] + 0.587 * bgPix[p + 1] + 0.114 * bgPix[p + 2];
          bgAlive[i] = bgPix[p + 3] > 16 ? 1 : 0;
        }
        const pcL = new Float32Array(pW * pH);
        const pcA = new Uint8Array(pW * pH);
        for (let i = 0, p = 0; i < pcL.length; i += 1, p += 4) {
          pcL[i] = 0.299 * pcPix[p] + 0.587 * pcPix[p + 1] + 0.114 * pcPix[p + 2];
          pcA[i] = pcPix[p + 3];
        }

        // ---- 拼图块不透明包围盒 ----
        let bx0 = pW;
        let by0 = pH;
        let bx1 = -1;
        let by1 = -1;
        let transparentPixels = 0;
        for (let y = 0; y < pH; y += 1) {
          const row = y * pW;
          for (let x = 0; x < pW; x += 1) {
            const i = row + x;
            if (pcA[i] <= 40) { transparentPixels += 1; continue; }
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
          }
        }
        if (bx1 < bx0 || by1 < by0) return { ok: false, error: 'piece_fully_transparent' };
        const boxW = bx1 - bx0 + 1;
        const boxH = by1 - by0 + 1;
        if (boxW < 6 || boxH < 6) return { ok: false, error: 'piece_too_small' };
        if (boxW > bgW - 4 || boxH > bgH - 4) return { ok: false, error: 'piece_larger_than_bg' };
        const hasAlphaMask = transparentPixels > 4 && transparentPixels < pW * pH * 0.98;

        // ---- 拼图块梯度 ----
        const pcGX = new Float32Array(pW * pH);
        const pcGY = new Float32Array(pW * pH);
        sobel(pcL, pW, pH, pcGX, pcGY);

        // ---- 取样本：内部像素（离 alpha 边和画布边都 >= 2px）+ 轮廓像素 ----
        const samples = [];
        const bounds = [];
        const margin = 2;
        for (let y = by0 + margin; y <= by1 - margin; y += 1) {
          const row = y * pW;
          for (let x = bx0 + margin; x <= bx1 - margin; x += 1) {
            const i = row + x;
            if (pcA[i] <= 160) continue;
            let interior = true;
            for (let dy = -2; dy <= 2 && interior; dy += 1) {
              const r2 = (y + dy) * pW;
              for (let dx = -2; dx <= 2; dx += 1) {
                if (pcA[r2 + x + dx] <= 160) { interior = false; break; }
              }
            }
            if (interior) samples.push(i);
            if (hasAlphaMask && pcA[i] > 200) {
              const l = x > 0 ? pcA[i - 1] : 0;
              const r = x < pW - 1 ? pcA[i + 1] : 0;
              const u = y > 0 ? pcA[i - pW] : 0;
              const d = y < pH - 1 ? pcA[i + pW] : 0;
              if (!(l > 120 && r > 120 && u > 120 && d > 120)) bounds.push({ dx: x - bx0, dy: y - by0 });
            }
          }
        }
        if (samples.length < 40) {
          samples.length = 0;
          for (let y = by0; y <= by1; y += 1) {
            for (let x = bx0; x <= bx1; x += 1) {
              const i = y * pW + x;
              if (pcA[i] > 160) samples.push(i);
            }
          }
        }
        if (samples.length < 24) return { ok: false, error: 'piece_too_flat' };

        const stride = Math.max(1, Math.ceil(samples.length / MAX_SAMPLES));
        const sampDx = [];
        const sampDy = [];
        const sampL = [];
        const sampGx = [];
        const sampGy = [];
        let pSum = 0;
        let pSum2 = 0;
        let pG2 = 0;
        for (let k = 0; k < samples.length; k += stride) {
          const i = samples[k];
          const x = i % pW;
          const y = (i - x) / pW;
          const l = pcL[i];
          sampDx.push(x - bx0);
          sampDy.push(y - by0);
          sampL.push(l);
          sampGx.push(pcGX[i]);
          sampGy.push(pcGY[i]);
          pSum += l;
          pSum2 += l * l;
          pG2 += pcGX[i] * pcGX[i] + pcGY[i] * pcGY[i];
        }
        const n = sampDx.length;
        if (n < 20) return { ok: false, error: 'piece_too_small' };
        const varP = Math.max(0, pSum2 - (pSum * pSum) / n);
        if (varP < 24) return { ok: false, error: 'piece_has_no_texture' };

        const bStride = Math.max(1, Math.ceil(bounds.length / 460));
        const boundsSlim = [];
        for (let k = 0; k < bounds.length; k += bStride) boundsSlim.push(bounds[k]);

        // ---- 背景梯度 / 边缘强度 ----
        const bgGX = new Float32Array(bgW * bgH);
        const bgGY = new Float32Array(bgW * bgH);
        sobel(bgL, bgW, bgH, bgGX, bgGY);
        const bgMag = new Float32Array(bgW * bgH);
        let magSum = 0;
        let magCount = 0;
        for (let i = 0; i < bgMag.length; i += 1) {
          const m = Math.abs(bgGX[i]) + Math.abs(bgGY[i]);
          bgMag[i] = m;
          if (bgAlive[i] && m > 0) { magSum += m; magCount += 1; }
        }
        const meanMag = magCount ? magSum / magCount : 0;
        const silScale = Math.max(24, meanMag * 2.6);
        const edgeNorm = Math.max(12, meanMag * 2.0);
        // 轮廓响应容忍 1px 误差：取 4 邻域最大
        const bgMagD = new Float32Array(bgMag.length);
        for (let y = 1; y < bgH - 1; y += 1) {
          const row = y * bgW;
          for (let x = 1; x < bgW - 1; x += 1) {
            const i = row + x;
            let m = bgMag[i];
            if (bgMag[i - 1] > m) m = bgMag[i - 1];
            if (bgMag[i + 1] > m) m = bgMag[i + 1];
            if (bgMag[i - bgW] > m) m = bgMag[i - bgW];
            if (bgMag[i + bgW] > m) m = bgMag[i + bgW];
            bgMagD[i] = m;
          }
        }

        // ---- 缺口边框能量（积分图，O(1) 取任意矩形）----
        const psW = bgW + 1;
        const psH = bgH + 1;
        const psX = new Float64Array(psW * psH);
        const psY = new Float64Array(psW * psH);
        for (let y = 0; y < bgH; y += 1) {
          let rx = 0;
          let ry = 0;
          for (let x = 0; x < bgW; x += 1) {
            const i = y * bgW + x;
            rx += Math.abs(bgGX[i]);
            ry += Math.abs(bgGY[i]);
            const o = (y + 1) * psW + (x + 1);
            psX[o] = psX[o - psW] + rx;
            psY[o] = psY[o - psW] + ry;
          }
        }
        const sumX = (x0, y0, x1, y1) => psX[y1 * psW + x1] - psX[y0 * psW + x1] - psX[y1 * psW + x0] + psX[y0 * psW + x0];
        const sumY = (x0, y0, x1, y1) => psY[y1 * psW + x1] - psY[y0 * psW + x1] - psY[y1 * psW + x0] + psY[y0 * psW + x0];
        const borderScore = (x, y, w, h) => {
          if (w < 8 || h < 8) return 0;
          if (x < 0 || y < 0 || x + w > bgW || y + h > bgH) return 0;
          const left = sumX(x, y, x + 1, y + h) / h;
          const right = sumX(x + w - 1, y, x + w, y + h) / h;
          const top = sumY(x, y, x + w, y + 1) / w;
          const bottom = sumY(x, y + h - 1, x + w, y + h) / w;
          const border = (left + right + top + bottom) / 4;
          const innerArea = Math.max(1, (w - 2) * (h - 2));
          const innerAvg = (sumX(x + 1, y + 1, x + w - 1, y + h - 1) + sumY(x + 1, y + 1, x + w - 1, y + h - 1)) / innerArea;
          const raw = border - 0.55 * innerAvg;
          return clamp(raw / edgeNorm, 0, 1);
        };

        // ---- 打分 ----
        const sampCount = n;
        const scoreAt = (x, y) => {
          let sumB = 0;
          let sumB2 = 0;
          let sumPB = 0;
          let gDot = 0;
          let gB2 = 0;
          let dead = 0;
          let o = y * bgW + x;
          for (let k = 0; k < sampCount; k += 1) {
            const idx = o + sampDx[k] + sampDy[k] * bgW;
            const bl = bgL[idx];
            sumB += bl;
            sumB2 += bl * bl;
            sumPB += sampL[k] * bl;
            const bgx = bgGX[idx];
            const bgy = bgGY[idx];
            gDot += sampGx[k] * bgx + sampGy[k] * bgy;
            gB2 += bgx * bgx + bgy * bgy;
            if (bgAlive[idx] === 0) dead += 1;
          }
          const numL = sumPB - (pSum * sumB) / sampCount;
          const varB = Math.max(0, sumB2 - (sumB * sumB) / sampCount);
          let lncc = 0;
          if (varB > 1e-3) lncc = numL / Math.sqrt(varP * varB);
          let gncc = 0;
          if (gB2 > 1e-3) gncc = gDot / Math.sqrt(pG2 * gB2);
          let sil = 0;
          if (boundsSlim.length) {
            let acc = 0;
            for (let k2 = 0; k2 < boundsSlim.length; k2 += 1) {
              const bx = x + boundsSlim[k2].dx;
              const by = y + boundsSlim[k2].dy;
              if (bx < 0 || by < 0 || bx >= bgW || by >= bgH) continue;
              acc += bgMagD[by * bgW + bx];
            }
            sil = clamp(acc / boundsSlim.length / silScale, 0, 1);
          }
          const bd = borderScore(x, y, boxW, boxH);
          const struct = 0.65 * Math.max(0, lncc) + 0.35 * Math.max(0, gncc);
          let score = 0.55 * struct + 0.45 * Math.max(sil, bd);
          if (dead > 0) score *= Math.max(0, 1 - 1.6 * (dead / sampCount));
          return { x, y, score, lncc, gncc, sil, bd, struct };
        };

        const xMax = bgW - boxW;
        const yMax = bgH - boxH;
        if (xMax < 2 || yMax < 0) return { ok: false, error: 'bg_too_small_for_piece' };
        const baseY = clamp(a.oy + by0, 0, yMax);
        const skipX0 = a.ox - 6;
        const skipX1 = a.ox + pW + 6;
        const skipCurrent = !!a.screenshotMode;
        const skip = (x) => skipCurrent && (x + boxW > skipX0) && (x < skipX1);

        // 第一遍：拼图块当前 y 附近细扫全宽（横向是唯一自由度）
        const ys = [];
        for (let d = -6; d <= 6; d += 2) {
          const yy = clamp(baseY + d, 0, yMax);
          if (ys.indexOf(yy) < 0) ys.push(yy);
        }
        const local = [];
        for (let yi = 0; yi < ys.length; yi += 1) {
          for (let x = 0; x <= xMax; x += 2) {
            if (skip(x)) continue;
            local.push(scoreAt(x, ys[yi]));
          }
        }
        local.sort((p, q) => q.score - p.score);
        let best = local.length ? local[0] : { x: 0, y: baseY, score: 0 };

        // 第二遍（兜底）：局部峰值太弱 => 全图粗扫 + 峰附近细化
        if (best.score < ACCEPT) {
          let coarse = null;
          for (let y = 0; y <= yMax; y += 6) {
            for (let x = 0; x <= xMax; x += 8) {
              if (skip(x)) continue;
              const s = scoreAt(x, y);
              if (!coarse || s.score > coarse.score) coarse = s;
            }
          }
          if (coarse && coarse.score > best.score) {
            let refined = coarse;
            for (let y = Math.max(0, coarse.y - 6); y <= Math.min(yMax, coarse.y + 6); y += 2) {
              for (let x = Math.max(0, coarse.x - 10); x <= Math.min(xMax, coarse.x + 10); x += 2) {
                if (skip(x)) continue;
                const s = scoreAt(x, y);
                if (s.score > refined.score) refined = s;
              }
            }
            best = refined;
          }
        }

        // 亚像素级：主峰 ±1 邻域再比一次（消除步长 2 带来的半像素系统误差）
        let peak = best;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = clamp(best.x + dx, 0, xMax);
            const yy = clamp(best.y + dy, 0, yMax);
            if (xx === best.x && yy === best.y) continue;
            const s = scoreAt(xx, yy);
            if (s.score > peak.score) peak = s;
          }
        }

        // 次峰（排除主峰 ±30% 拼图宽 的邻域），用于置信度
        const sep = Math.max(10, Math.round(boxW * 0.3));
        let second = 0;
        for (let i = 0; i < local.length; i += 1) {
          const s = local[i];
          if (Math.abs(s.x - peak.x) <= sep && Math.abs(s.y - peak.y) <= 4) continue;
          if (s.score > second) second = s.score;
          if (i > 400) break;
        }
        // 注意：变量名不能叫 margin —— 上面取样本时已用过同名 const（同一块作用域，重复声明是语法错误）
        const peakGap = clamp(peak.score - second, 0, 1);
        const confidence = Math.round(
          clamp((peak.score - 0.26) / 0.5, 0, 1) * clamp(peakGap / 0.16, 0, 1) * 100,
        ) / 100;

        const targetLeftCss = (peak.x - bx0) / sc;
        const deltaXCss = targetLeftCss - (a.pieceOffsetXCss || 0);
        if (!Number.isFinite(deltaXCss) || Math.abs(deltaXCss) > bgW / sc * 1.2 + 40) {
          return { ok: false, error: 'implausible_delta' };
        }

        return {
          ok: peak.score >= ACCEPT,
          deltaXCss,
          targetLeftCss,
          score: Math.round(peak.score * 1000) / 1000,
          confidence,
          method: peak.struct >= 0.22 ? 'template' : 'border',
          lncc: Math.round(peak.lncc * 1000) / 1000,
          gncc: Math.round(peak.gncc * 1000) / 1000,
          sil: Math.round(peak.sil * 1000) / 1000,
          border: Math.round(peak.bd * 1000) / 1000,
          bgW,
          bgH,
          pW,
          pH,
          boxW,
          boxH,
          scale: sc,
          hasAlphaMask,
          meanMag: Math.round(meanMag * 10) / 10,
          candidates: local.slice(0, 3).map((s) => ({
            x: s.x,
            y: s.y,
            score: Math.round(s.score * 1000) / 1000,
            lncc: Math.round(s.lncc * 1000) / 1000,
            gncc: Math.round(s.gncc * 1000) / 1000,
            sil: Math.round(s.sil * 1000) / 1000,
            bd: Math.round(s.bd * 1000) / 1000,
          })),
          elapsedMs: Math.round(performance.now() - t0),
        };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }, {
      bgUrl,
      pieceUrl,
      bgW: Math.max(24, Math.round(Number(bgRect.width) * scale)),
      bgH: Math.max(16, Math.round(Number(bgRect.height) * scale)),
      pW: Math.max(8, Math.round(Number(pieceRect.width) * scale)),
      pH: Math.max(8, Math.round(Number(pieceRect.height) * scale)),
      ox: Math.round(Number(pieceOffsetX || 0) * scale),
      oy: Math.round(Number(pieceOffsetY || 0) * scale),
      pieceOffsetXCss: Number(pieceOffsetX) || 0,
      bgFit: String(bgFit || 'fill'),
      pieceFit: String(pieceFit || 'fill'),
      screenshotMode: Boolean(screenshotMode),
      scale,
      accept: MATCH_ACCEPT_SCORE,
    });
  } catch (err) {
    return {
      ok: false,
      confidence: 0,
      error: `slide_match_evaluate_failed: ${(err && err.message) || err}`,
    };
  }

  if (!res || typeof res !== 'object') return { ok: false, confidence: 0, error: 'slide_match_no_result' };
  if (!res.ok && res.error) return { ...res, confidence: 0 };
  return {
    ...res,
    confidence: Number(res.confidence) || 0,
    elapsedMs: Number(res.elapsedMs) || 0,
  };
}

// ---------------------------------------------------------------------------
// 3) 截图兜底（图片被 canvas 污染 / 跨域 CORS 撞死 / blob 撤回时）
// ---------------------------------------------------------------------------
function viewportSizeOf(page) {
  try {
    const vp = page && typeof page.viewportSize === 'function' ? page.viewportSize() : null;
    if (vp && vp.width > 0 && vp.height > 0) return vp;
  } catch { /* ignore */ }
  return { width: 1280, height: 800 };
}

/**
 * 截取页面某一块并返回 { b64, rect }；rect 是「真正截到的那块区域」（已按视口裁剪），
 * 因此和截出来的图严格同尺寸、同原点，可以直接当坐标系用。
 */
async function captureRect(page, rect) {
  if (!page || typeof page.screenshot !== 'function' || !rect) return null;
  const vp = viewportSizeOf(page);
  let x = Math.round(Number(rect.x) || 0);
  let y = Math.round(Number(rect.y) || 0);
  let w = Math.round(Number(rect.width) || 0);
  let h = Math.round(Number(rect.height) || 0);
  if (!(w >= 8 && h >= 8)) return null;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > vp.width) w = vp.width - x;
  if (y + h > vp.height) h = vp.height - y;
  if (!(w >= 8 && h >= 8)) return null;
  try {
    const buf = await page.screenshot({ clip: { x, y, width: w, height: h }, type: 'png' });
    if (!buf || !buf.length) return null;
    return { b64: Buffer.from(buf).toString('base64'), rect: { x, y, width: w, height: h } };
  } catch {
    return null;
  }
}

/**
 * 取「背景图 + 拼图块」两路像素：
 *   1) 首选 DOM 里的图片地址（data/blob/相对路径都行，Node 侧 fetch 没有 CORS 限制）；
 *   2) 拿不到（canvas 被污染、@font 动态贴图、CSP 拦 fetch）时，退化为屏幕上截图两块区域。
 *
 * @returns {Promise<{ok:boolean, mode:'dom'|'screenshot', bgB64?:string, pieceB64?:string,
 *   bgRect?:object, pieceRect?:object, pieceOffsetX?:number, pieceOffsetY?:number, error?:string}>}
 */
async function resolveSlideImages(page, info, deps = {}) {
  if (!info) return { ok: false, mode: 'none', error: 'no_geometry' };
  const fetchImage = typeof deps.fetchImageAsBase64 === 'function' ? deps.fetchImageAsBase64 : null;
  const target = info.target || page;
  const bgBox = info.bgBox || info.bgRect;
  const bgSrc = String(info.bgSrc || '');
  const pieceSrc = String(info.pieceSrc || '');

  let bgB64 = '';
  let pieceB64 = '';
  if (fetchImage) {
    if (bgSrc) {
      try { bgB64 = String(await fetchImage(target, bgSrc, info.bgRect) || ''); } catch { bgB64 = ''; }
    }
    if (pieceSrc) {
      try { pieceB64 = String(await fetchImage(target, pieceSrc, info.pieceRect) || ''); } catch { pieceB64 = ''; }
    }
  }
  if (bgB64 && pieceB64 && info.bgRect && info.pieceRect && bgBox) {
    return {
      ok: true,
      mode: 'dom',
      bgB64,
      pieceB64,
      bgRect: { ...bgBox },
      pieceRect: { ...info.pieceRect },
      pieceOffsetX: info.pieceRect.x - bgBox.x,
      pieceOffsetY: info.pieceRect.y - bgBox.y,
      bgFit: info.bgFit || 'fill',
      pieceFit: info.pieceFit || 'fill',
    };
  }

  // 截图兜底：只能截「看得见的部分」，所以两边都按裁剪后的 rect 对齐
  if (!info.bgRect || !info.pieceRect) {
    return { ok: false, mode: 'none', error: '缺少元素矩形，无法截图' };
  }
  const bgShot = await captureRect(page, info.bgRect);
  if (!bgShot) return { ok: false, mode: 'none', error: '背景图截图失败' };
  const pcShot = await captureRect(page, info.pieceRect);
  if (!pcShot) return { ok: false, mode: 'none', error: '拼图块截图失败' };
  // 拼图块一旦被裁剪，模板就和背景里的缺口对不上号了，直接放弃，别瞎拖
  if (Math.abs(pcShot.rect.width - Number(info.pieceRect.width)) > 1.5
    || Math.abs(pcShot.rect.height - Number(info.pieceRect.height)) > 1.5) {
    return { ok: false, mode: 'screenshot', error: '拼图块被视口裁切，无法定位缺口' };
  }
  return {
    ok: true,
    mode: 'screenshot',
    bgB64: bgShot.b64,
    pieceB64: pcShot.b64,
    bgRect: bgShot.rect,
    pieceRect: pcShot.rect,
    pieceOffsetX: pcShot.rect.x - bgShot.rect.x,
    pieceOffsetY: pcShot.rect.y - bgShot.rect.y,
    bgFit: 'fill',
    pieceFit: 'fill',
  };
}


// ---------------------------------------------------------------------------
// 4) 拟人拖拽 + 闭环校准
// ---------------------------------------------------------------------------
/**
 * 向右（或向左）拖动滑块/拼图块，让拼图块落到缺口上。
 *
 * 关键点：deltaCss 是「拼图块还需要位移多少 CSS 像素」，不是「鼠标要移动多少像素」。
 * 两者在很多实现里并不相等（1:1 / 0.5 / 带死区 / 带缓动），所以这里按住后先试探，
 * 用 readState() 读回拼图块的真实位移反推映射比，再闭环把残差压到 <= 1.6px。
 *
 * @param {object} page Playwright Page
 * @param {object} geom inspectSlideCaptchaInContext() 的返回
 * @param {number} deltaCss 拼图块还需要水平位移的 CSS 像素（正=向右）
 * @param {object} ctx
 * @param {Function} [ctx.readState] 读当前 { pieceOffsetX }，null 表示读不到/已消失
 * @param {number} [ctx.maxSliderPx] 滑轨最大行程（滑块 px）
 * @param {string} [ctx.dragMode] 'handle' | 'piece'
 * @param {Function} [ctx.sleep]
 */
async function performSlideDrag(page, geom, deltaCss, ctx = {}) {
  const sleepFn = typeof ctx.sleep === 'function' ? ctx.sleep : sleep;
  const readState = typeof ctx.readState === 'function' ? ctx.readState : null;
  const dragMode = String(ctx.dragMode || (geom && geom.dragMode) || 'handle');
  const startRect = (dragMode === 'handle' && geom && geom.handleRect) ? geom.handleRect : (geom && geom.pieceRect);
  if (!startRect || !(Number(startRect.width) > 0) || !(Number(startRect.height) > 0)) {
    return { ok: false, error: '没有可拖拽的滑块或拼图块' };
  }
  if (!page || !page.mouse || typeof page.mouse.move !== 'function') {
    return { ok: false, error: '当前页面不支持鼠标事件' };
  }
  const desired = Number(deltaCss);
  if (!Number.isFinite(desired)) return { ok: false, error: 'invalid_delta' };
  if (Math.abs(desired) < 1.2) return { ok: true, sliderPx: 0, ratio: 1, rounds: 0, noop: true, dragMode };

  const vp = viewportSizeOf(page);
  const startX = Math.round(startRect.x + startRect.width / 2 + rand(-1.2, 1.2));
  const startY = Math.round(startRect.y + startRect.height / 2 + rand(-1.2, 1.2));
  const capRight = Math.max(0, Math.min(Number(ctx.maxSliderPx) > 0 ? Number(ctx.maxSliderPx) : (vp.width - startX - 12), vp.width - startX - 12));
  const capLeft = Math.max(0, Math.min(Number(ctx.maxSliderPx) > 0 ? Number(ctx.maxSliderPx) : (startX - 12), startX - 12));
  const wanted = clampNum(desired, -capLeft, capRight);

  let moved = 0;
  let ratio = null;
  let rounds = 0;
  let lastOffset = null;
  let baseOffset = null;
  let targetOffset = null;
  let released = false;

  const moveTo = async (toPx, opts = {}) => {
    const ease = opts.ease !== false;
    const jitterY = Number.isFinite(Number(opts.jitterY)) ? Number(opts.jitterY) : 1.1;
    const from = moved;
    const delta = toPx - from;
    if (Math.abs(delta) < 0.35) return;
    const segments = Math.round(clampNum(Math.abs(delta) / 6, ease ? 3 : 1, ease ? 26 : 8));
    for (let i = 1; i <= segments; i += 1) {
      const p = i / segments;
      const pe = ease ? 1 - Math.pow(1 - p, 2.4) : p;
      const nx = startX + from + delta * pe;
      const ny = startY + Math.sin(p * Math.PI) * rand(-jitterY, jitterY) + rand(-0.45, 0.45);
      await page.mouse.move(nx, ny);
      await sleepFn(rand(4.5, 11.5));
    }
    await page.mouse.move(startX + toPx, startY + rand(-0.4, 0.4));
    moved = toPx;
  };

  try {
    const base = readState ? await readState() : null;
    if (base && Number.isFinite(Number(base.pieceOffsetX))) {
      baseOffset = Number(base.pieceOffsetX);
      targetOffset = baseOffset + wanted;
    }

    await page.mouse.move(startX, startY, { steps: randInt(4, 8) });
    await sleepFn(rand(70, 150));
    // 悬停微动：部分实现对「一开始就静止按住」不触发 pointermove
    await page.mouse.move(startX + 0.7, startY + rand(-0.4, 0.4));
    await sleepFn(rand(18, 55));
    await page.mouse.down();
    await sleepFn(rand(45, 95));

    if (!readState) {
      // 读不到拼图块位置（纯滑条）：按 1:1 一次走到底，加上人手在末段的减速
      await moveTo(wanted, { ease: true });
    } else {
      // ---- 试探位移 ----
      const probePx = clampNum(wanted * 0.24, -24, 24);
      if (Math.abs(probePx) >= 4) {
        await moveTo(probePx, { ease: true, jitterY: 0.9 });
        await sleepFn(rand(40, 85));
      }
      const probeState = readState ? await readState() : null;
      if (probeState && baseOffset == null && Number.isFinite(Number(probeState.pieceOffsetX))) {
        baseOffset = Number(probeState.pieceOffsetX);
        targetOffset = baseOffset + wanted;
      }

      // ---- 闭环纠偏 ----
      for (let round = 0; round < 4; round += 1) {
        let st = null;
        try { st = round === 0 && probeState ? probeState : (readState ? await readState() : null); } catch { st = null; }
        if (!st && round === 0) {
          // 首轮读不到多半是碰上「图正在替换」的空窗：短等后补读一次，
          // 补得到就还能闭环纠偏，补不到就 break（下面松手 + 让上层判结果），绝不盲拖到底。
          await sleepFn(rand(110, 190));
          try { st = await readState(); } catch { st = null; }
        }
        if (!st || !Number.isFinite(Number(st.pieceOffsetX))) break;
        const cur = Number(st.pieceOffsetX);
        lastOffset = cur;
        if (baseOffset == null) { baseOffset = cur; }
        if (targetOffset == null) { targetOffset = baseOffset + wanted; }

        if (Math.abs(moved) > 4) {
          const measured = (cur - baseOffset) / moved;
          if (measured > 0.08 && measured < 8) ratio = measured;
        }
        const residual = targetOffset - cur;
        if (Math.abs(residual) <= 1.6) break;

        const stepCss = ratio ? residual / ratio : residual;
        const maxStep = Math.max(24, Math.abs(wanted) * 0.9);
        const nextMoved = clampNum(moved + clampNum(stepCss, -maxStep, maxStep), -capLeft, capRight);
        if (Math.abs(nextMoved - moved) < 0.6) break;   // 已经顶到滑轨尽头
        rounds += 1;
        await moveTo(nextMoved, { ease: Math.abs(nextMoved - moved) > 6, jitterY: 1.15 });
        await sleepFn(rand(28, 66));
      }
    }

    // 松手前的「人手微修正」：1px 级回摆 + 停一下，避免机臂式直停
    if (Math.abs(moved) > 0.5) {
      await sleepFn(rand(45, 85));
      await page.mouse.move(startX + moved + rand(-0.9, 0.9), startY + rand(-0.5, 0.5), { steps: 2 });
      await sleepFn(rand(55, 115));
      await page.mouse.move(startX + moved + rand(-0.25, 0.25), startY + rand(-0.3, 0.3));
    }
    await sleepFn(rand(60, 130));
    await page.mouse.up();
    released = true;
  } catch (err) {
    return {
      ok: false,
      error: `拖拽异常: ${(err && err.message) || err}`,
      sliderPx: moved,
      ratio,
      rounds,
    };
  } finally {
    if (!released) {
      try { await page.mouse.up(); } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    dragMode,
    sliderPx: moved,
    ratio,
    rounds,
    targetOffset,
    finalOffset: lastOffset,
  };
}

// ---------------------------------------------------------------------------
// 5) 松手后判定：通过了 / 换图了 / 换成旋转验证了
// ---------------------------------------------------------------------------
/**
 * 松手后不能只看一眼就下结论：
 *   - 有的实现先播 200~600ms 的「校验中」动画，弹框才消失；
 *   - 有的实现换图时会有 1~2 帧「图还没插回来」的空窗，单次采样容易误判成「已通过」。
 * 所以要求连续两次采样都确认「验证结构不存在」，才认定通过。
 */
async function waitSlideOutcome(page, info, ctx = {}) {
  const sleepFn = typeof ctx.sleep === 'function' ? ctx.sleep : sleep;
  const inspect = typeof ctx.inspect === 'function' ? ctx.inspect : inspectSlideCaptchaInContext;
  const detect = typeof ctx.detect === 'function' ? ctx.detect : null;
  const target = info.target || page;
  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : 4400;
  const deadline = Date.now() + timeoutMs;
  let misses = 0;
  let sawSwap = false;
  let lastDetected = null;

  const noteSwap = (next) => {
    if (next && next.bgSrc && info.bgSrc && next.bgSrc !== info.bgSrc) sawSwap = true;
  };

  while (Date.now() < deadline) {
    await sleepFn(rand(330, 520));

    let now = null;
    try { now = await inspect(target); } catch { now = null; }
    if (now && now.detected) {
      misses = 0;
      lastDetected = now;
      noteSwap(now);
      continue;
    }

    // 平移结构看不到了：再用统一检测确认一遍，避免「换成旋转了」被当成「通过了」
    let uni = null;
    let detectFailed = false;
    try {
      uni = detect ? await detect(page) : null;
    } catch {
      uni = null;
      detectFailed = true;
    }
    // 检测器自己抛错既不能算「通过」也不能算「未通过」：不计 miss，等下一轮；
    // 若一直坏到超时，会走下面的 timeout 分支 → 调用方按「未通过」处理（宁可多试一次，也不谎报成功）
    if (detectFailed) continue;
    if (uni && uni.detected) {
      misses = 0;
      lastDetected = uni;
      noteSwap(uni);
      if (uni.kind !== 'slide') {
        return { gone: false, changedImage: true, info: uni, otherKind: uni.kind, reason: `验证类型变为 ${uni.kind}` };
      }
      continue;
    }
    if (uni && uni.loading && uni.timedOut) {
      // 弹框已显示 "Verification timed out"：继续等没有意义，立刻返回，由主流程关闭弹框并刷新页面
      return { gone: false, timeout: true, timedOut: true, changedImage: sawSwap, info: lastDetected, reason: '验证弹框已超时' };
    }
    if (uni && uni.loading) { misses = 0; continue; }

    misses += 1;
    if (misses >= 2) return { gone: true, info: lastDetected, reason: '' };
  }

  return {
    gone: false,
    timeout: true,
    changedImage: sawSwap,
    info: lastDetected,
    reason: sawSwap ? '验证未通过，图片已换新' : '验证弹框未消失（多半仍未通过）',
  };
}

// ---------------------------------------------------------------------------
// 6) 对外主流程
// ---------------------------------------------------------------------------
function makeLogger({ accountId = 0, log = null, liveLog = null } = {}) {
  const prefix = `[平移验证${accountId ? `#${accountId}` : ''}]`;
  return (msg, level = 'info') => {
    const text = String(msg == null ? '' : msg);
    if (typeof log === 'function') {
      try { log(text, level); } catch { /* ignore */ }
    }
    if (typeof liveLog === 'function') {
      try { liveLog(`${prefix} ${text}`, level, accountId ? { accountId } : {}); } catch { /* ignore */ }
    }
  };
}

function markCaptchaKind(page, kind) {
  try {
    page.__tkCaptchaKind = kind;
    page.__tkCaptchaKindAt = Date.now();
  } catch { /* ignore */ }
}

const KIND_HOP_WINDOW_MS = 15000;
const KIND_HOP_LIMIT = 2;

/**
 * 平移 <-> 滑条 互相委派次数的闸。
 *
 * 两个判定器看的是同一片 DOM，正常情况下一张截图中结论唯一；但站点如果在几帧之间
 * 反复挂载 / 卸载拼图块，两边会各自"看见"不同的结论并来回委派 —— 那就是无界递归：
 * 每一层都真发一次鼠标拖拽（风控最恨的行为）+ 等 1~2 秒，还各自 pause 一次省流、
 * 只有返回时才 resume，等于永不恢复。所以委派窗口内数次数，超过就直接转人工。
 * 用时间戳而不是计数器，是为了让状态能自愈：抛异常 / 页面换了都不用清理。
 */
function noteKindHandoff(page) {
  try {
    const now = Date.now();
    const last = Number(page.__tkCaptchaKindHandoffAt) || 0;
    const count = now - last < KIND_HOP_WINDOW_MS ? (Number(page.__tkCaptchaKindHandoffs) || 0) + 1 : 1;
    page.__tkCaptchaKindHandoffAt = now;
    page.__tkCaptchaKindHandoffs = count;
    return count;
  } catch {
    return 1;
  }
}

/** 平移/滑条互相甩锅超过上限时的兜底返回：只说不确定，绝不谎报通过。 */
function kindHopBail(kind) {
  return {
    detected: true,
    solved: false,
    kind: kind || KINDS.SLIDE,
    attempts: 0,
    manualRequired: true,
    error: '平移 / 滑动条验证类型在反复切换，已放弃自动过码（转人工）',
  };
}

/**
 * 自动过「图片拖拽平移」验证（拼图缺口）。
 *
 * @param {object} page Playwright Page
 * @param {object} firstCheck inspectSlideCaptchaInContext() 的返回（detectCaptcha 已补 target/frame 偏移）
 * @param {object} opts
 * @param {number} [opts.accountId]
 * @param {number} [opts.maxAttempts]
 * @param {Function} [opts.log]
 * @param {Function} [opts.deps.liveLog]
 * @param {Function} [opts.deps.detectCaptcha] 统一分类（用于判定「已通过」/「类型切换」）
 * @param {Function} [opts.deps.inspectSlide]
 * @param {Function} [opts.deps.fetchImageAsBase64]
 * @param {Function} [opts.deps.clickCaptchaRefresh]
 * @param {Function} [opts.deps.pauseSaveTraffic]
 * @param {Function} [opts.deps.resumeSaveTraffic]
 * @param {Function} [opts.deps.dumpDebug]
 * @param {boolean}  [opts.saveTrafficPaused] 调用方已经关过省流
 * @returns {Promise<{detected:boolean, solved:boolean, kind:string, attempts:number, error?:string}>}
 */
async function solveSlideCaptcha(page, firstCheck, opts = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return { detected: false, solved: false, kind: KINDS.SLIDE, attempts: 0 };
  }
  const deps = opts.deps || {};
  const accountId = Number(opts.accountId || page.__tkAccountId || 0) || 0;
  const say = makeLogger({ accountId, log: opts.log, liveLog: deps.liveLog });
  const detect = typeof deps.detectCaptcha === 'function' ? deps.detectCaptcha : null;
  const inspect = typeof deps.inspectSlide === 'function' ? deps.inspectSlide : inspectSlideCaptchaInContext;
  const refresh = typeof deps.clickCaptchaRefresh === 'function' ? deps.clickCaptchaRefresh : null;
  const autoSlide = envFlag('TKSWARM_CAPTCHA_SLIDE_AUTO', true);
  const maxAttempts = clampNum(
    Number(opts.maxAttempts) || envNum('TKSWARM_CAPTCHA_SLIDE_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    1,
    6,
  );
  const dragModePref = String(process.env.TKSWARM_CAPTCHA_SLIDE_MODE || 'auto').toLowerCase();

  let info = firstCheck && firstCheck.detected ? firstCheck : null;
  if (info && info.kind === 'dragbar') {
    if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.SLIDE);
    return solveDragBarCaptcha(page, info, { ...opts, deps, accountId });
  }
  if (!info) {
    try { info = await inspect(page, { mode: dragModePref }); } catch { info = null; }
    if (info && info.kind === 'dragbar') {
      if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.SLIDE);
      return solveDragBarCaptcha(page, info, { ...opts, deps, accountId });
    }
  }
  if (!info || !info.detected) {
    return { detected: false, solved: false, kind: KINDS.SLIDE, attempts: 0 };
  }

  markCaptchaKind(page, info.kind || KINDS.SLIDE);
  const sayKind = info.kind === 'dragbar'
    ? '图片拖拽「拖动滑块到最右」验证（无图滑条）'
    : '图片拖拽「平移」验证（拼图缺口）';
  say(`已辨别验证类型：${sayKind}（配对置信 ${info.pairScore != null ? info.pairScore : '-'}，拖拽入口=${info.dragMode === 'handle' ? '滑轨滑块' : '直接拖拼图块'}）`);

  if (!autoSlide) {
    say('已按配置 TKSWARM_CAPTCHA_SLIDE_AUTO=0 关闭平移验证自动过码，保留人工处理', 'warn');
    return {
      detected: true,
      solved: false,
      kind: info.kind || KINDS.SLIDE,
      attempts: 0,
      manualRequired: true,
      error: '平移验证自动过码已关闭',
    };
  }

  if (!info.solvable) {
    const why = info.reason || 'unknown';
    say(`识别到平移验证，但当前不可自动求解（${why}），保留人工处理`, 'warn');
    if (typeof deps.dumpDebug === 'function') {
      try { await deps.dumpDebug(page, info, { stage: 'unsolvable', reason: why }); } catch { /* ignore */ }
    }
    return {
      detected: true,
      solved: false,
      kind: info.kind || KINDS.SLIDE,
      attempts: 0,
      unsolvable: true,
      manualRequired: true,
      error: `不可自动求解：${why}`,
    };
  }

  let target = info.target || page;
  const readState = async () => {
    try {
      const st = await inspect(target, { mode: dragModePref });
      if (!st || !st.detected) return null;
      // 只取一个数字，不拿 kind 当闸门：几何启发式在拖动过程中偶尔会抖成 dragbar/rotate，
      // 若因此判 null，闭环会整段退化成「盲拖一次」——滑块 px → 拼图 px 的映射比往往不是 1:1。
      if (st.kind === 'dragbar') return null;
      if (info.bgSrc && st.bgSrc && st.bgSrc !== info.bgSrc && !/^data:image/i.test(String(st.bgSrc))) return null;
      const off = Number(st.pieceOffsetX);
      if (!Number.isFinite(off)) return null;
      return { pieceOffsetX: off, bgSrc: st.bgSrc, raw: st };
    } catch {
      return null;
    }
  };

  let pausedHere = false;
  let lastError = '';
  let attemptsDone = 0;
  let lastDrag = null;
  let timedOutRecoveries = 0;

  try {
    if (!opts.saveTrafficPaused && typeof deps.pauseSaveTraffic === 'function') {
      try {
        const r = await deps.pauseSaveTraffic(page);
        pausedHere = Boolean(r && r.paused);
      } catch { pausedHere = false; }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!info || !info.detected) {
        // 三态：① 本模块 inspector 明确说「没有」；② 统一检测器说「还有，且是别的类型」；
        // ③ 检测器自己抛错 / inspector 报错 —— 这一态绝不能当成「验证码已消失」，
        // 否则会把失败静默写成成功，并污染 page.__tkNoCaptchaLastSolvedAt 让上层不再重试。
        let fresh = null;
        let inspectSaidNo = false;
        try {
          fresh = await inspect(target, { mode: dragModePref });
          inspectSaidNo = Boolean(fresh && !fresh.detected && !fresh.loading && !fresh.error);
        } catch { fresh = null; inspectSaidNo = false; }
        if (!fresh || !fresh.detected) {
          let uni = null;
          let detectFailed = false;
          if (detect) {
            try { uni = await detect(page); } catch { uni = null; detectFailed = true; }
          }
          if (uni && uni.detected) {
            if (uni.kind === 'dragbar') {
              if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.SLIDE);
              return await solveDragBarCaptcha(page, uni, { ...opts, deps, accountId });
            }
            if (uni.kind !== 'slide') {
              return {
                detected: true, solved: false, kind: uni.kind, attempts: attemptsDone,
                switched: true, manualRequired: true, error: `验证类型已切换为 ${uni.kind}`,
              };
            }
            fresh = uni;
          } else if (uni && uni.loading && uni.timedOut && typeof deps.recoverTimedOut === 'function' && timedOutRecoveries < 2) {
            // 弹框已超时（"Verification timed out"）：没有图也没有刷新钮，只能关掉并刷新页面重新下发验证
            lastError = '验证弹框已超时';
            timedOutRecoveries += 1;
            try { await deps.recoverTimedOut(page, uni.target || page); } catch { /* ignore */ }
            let again = null;
            try { again = await detect(page); } catch { again = null; }
            if (again && again.detected && again.kind === 'slide') {
              info = again;
              target = again.target || page;
              attempt -= 1;
              continue;
            }
            return {
              detected: Boolean(again && (again.detected || again.loading)),
              solved: false,
              kind: KINDS.SLIDE,
              attempts: attemptsDone,
              timedOutRecovered: true,
              reason: 'verification_timed_out',
            };
          } else if ((uni && uni.loading) || detectFailed) {
            await sleep(rand(420, 620));
            continue;
          } else if (attempt === 1 && inspectSaidNo) {
            page.__tkNoCaptchaLastSolvedAt = Date.now();
            markCaptchaKind(page, 'slide');
            say('平移验证已消失（未拖动，可能已由其它通道通过）');
            return { detected: true, solved: true, kind: KINDS.SLIDE, attempts: 0 };
          } else {
            // 我们刷新过图，验证框随之收掉了；或检测结果不确定：都不谎报「已过」，交回调用方
            return {
              detected: false,
              solved: false,
              kind: KINDS.SLIDE,
              attempts: attempt - 1,
              refreshed: attempt > 1,
              reason: detectFailed ? 'detector_failed' : (inspectSaidNo ? 'refreshed' : 'inspect_uncertain'),
            };
          }
        }
        info = fresh;
        if (info.kind === 'dragbar') {
          if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.SLIDE);
          return await solveDragBarCaptcha(page, info, { ...opts, deps, accountId });
        }
      }

      say(`检测到图片拖拽平移验证（第 ${attempt}/${maxAttempts} 次），正在本地 Canvas 模板匹配定位缺口…`);

      const imgs = await resolveSlideImages(page, { ...info, target }, deps);
      if (!imgs.ok) {
        lastError = imgs.error || '图片像素获取失败';
        say(`取图失败：${lastError}`, 'warn');
        if (refresh) { try { await refresh(page); } catch { /* ignore */ } }
        await sleep(rand(800, 1200));
        info = null;
        continue;
      }

      const sol = await solveSlideTargetByLocalCanvas(target, {
        bgDataUrl: imgs.bgB64,
        pieceDataUrl: imgs.pieceB64,
        bgRect: imgs.bgRect,
        pieceRect: imgs.pieceRect,
        pieceOffsetX: imgs.pieceOffsetX,
        pieceOffsetY: imgs.pieceOffsetY,
        bgFit: imgs.bgFit || 'fill',
        pieceFit: imgs.pieceFit || 'fill',
        screenshotMode: imgs.mode === 'screenshot',
      });

      if (!sol.ok) {
        lastError = sol.error || '未能定位缺口';
        say(`缺口定位失败：${lastError}，换图重试`, 'warn');
        if (typeof deps.dumpDebug === 'function') {
          try { await deps.dumpDebug(page, info, { stage: 'match_failed', sol, images: { mode: imgs.mode } }); } catch { /* ignore */ }
        }
        if (refresh) { try { await refresh(page); } catch { /* ignore */ } }
        await sleep(rand(850, 1250));
        info = null;
        continue;
      }

      say(`缺口定位完成：还需水平位移 ${round1(sol.deltaXCss)}px（置信度 ${sol.confidence}，方法 ${sol.method}，得分 ${sol.score}，耗时 ${sol.elapsedMs}ms，取图 ${imgs.mode}）`);
      if (Number(sol.confidence) < MATCH_GOOD_CONFIDENCE) {
        say(`缺口匹配置信度偏低（${sol.confidence} < ${MATCH_GOOD_CONFIDENCE}），仍按当前位置最佳点尝试`, 'warn');
      }
      if (envFlag('TKSWARM_CAPTCHA_SLIDE_DEBUG', false) && Array.isArray(sol.candidates) && sol.candidates.length) {
        say(`缺口候选 TOP${sol.candidates.length}：${sol.candidates
          .map((c) => `(${c.x},${c.y}) 分=${c.score} 亮度=${c.lncc} 梯度=${c.gncc} 轮廓=${c.sil} 边框=${c.bd}`)
          .join(' | ')}（画布 ${sol.bgW}x${sol.bgH}，模板 ${sol.pW}x${sol.pH}，拼图块 ${sol.boxW}x${sol.boxH}，缩放 ${sol.scale}）`);
      }

      const dragRes = await performSlideDrag(page, info, sol.deltaXCss, {
        sleep,
        readState,
        maxSliderPx: info.maxSlideDistance,
        dragMode: info.dragMode,
      });
      lastDrag = dragRes;
      if (!dragRes.ok) {
        lastError = dragRes.error || '拖拽失败';
        say(`拖拽失败：${lastError}，换图重试`, 'warn');
        if (refresh) { try { await refresh(page); } catch { /* ignore */ } }
        await sleep(rand(800, 1200));
        info = null;
        continue;
      }
      const ratioText = dragRes.ratio ? `，映射比 ${round1(dragRes.ratio)}` : '，映射比未测出（按 1:1 走完）';
      say(`已拖动 ${round1(dragRes.sliderPx)}px${ratioText}${dragRes.rounds ? `，闭环纠偏 ${dragRes.rounds} 次` : ''}，等待校验…`);

      const outcome = await waitSlideOutcome(page, info, { sleep, inspect, detect });
      attemptsDone = attempt;

      if (outcome.gone) {
        page.__tkNoCaptchaLastSolvedAt = Date.now();
        markCaptchaKind(page, 'slide');
        say(`平移验证已通过（第 ${attempt} 次，滑块位移 ${round1(dragRes.sliderPx)}px${ratioText}）`);
        return {
          detected: true,
          solved: true,
          kind: KINDS.SLIDE,
          attempts: attempt,
          sliderPx: dragRes.sliderPx,
          ratio: dragRes.ratio,
          deltaXCss: sol.deltaXCss,
          confidence: sol.confidence,
        };
      }

      if (outcome.otherKind) {
        return {
          detected: true,
          solved: false,
          kind: outcome.otherKind,
          attempts: attempt,
          switched: true,
          manualRequired: true,
          error: outcome.reason || `验证类型切换为 ${outcome.otherKind}`,
        };
      }

      lastError = outcome.reason || '拖动后验证未通过';
      say(`${lastError}，准备换图重试…`, 'warn');
      if (typeof deps.dumpDebug === 'function') {
        try {
          await deps.dumpDebug(page, info, {
            stage: 'verify_failed', attempt, sol, drag: dragRes, outcome,
          });
        } catch { /* ignore */ }
      }
      if (refresh) { try { await refresh(page); } catch { /* ignore */ } }
      await sleep(rand(700, 1100));
      info = null;
    }

    return {
      detected: true,
      solved: false,
      kind: KINDS.SLIDE,
      attempts: attemptsDone || maxAttempts,
      manualRequired: true,
      error: lastError || `连续 ${maxAttempts} 次未通过平移验证`,
      lastDrag,
    };
  } finally {
    if (pausedHere && typeof deps.resumeSaveTraffic === 'function') {
      let stillThere = true;
      try {
        const uni = detect ? await detect(page) : null;
        stillThere = Boolean(uni && (uni.detected || uni.loading));
      } catch { stillThere = true; }
      if (!stillThere) {
        try { await deps.resumeSaveTraffic(page); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * 无图滑条验证：按住滑块拖到最右即可。这类验证一旦拖到位置就一定通过，
 * 所以不需要缺口计算，只需要拟人轨迹 + 到点后稳一下。
 */
async function solveDragBarCaptcha(page, firstCheck, opts = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return { detected: false, solved: false, kind: KINDS.DRAGBAR, attempts: 0 };
  }
  if (!envFlag('TKSWARM_CAPTCHA_DRAGBAR_AUTO', true)) {
    return {
      detected: true,
      solved: false,
      kind: KINDS.DRAGBAR,
      attempts: 0,
      manualRequired: true,
      error: '已关闭滑动条验证自动过码（TKSWARM_CAPTCHA_DRAGBAR_AUTO=0）',
    };
  }
  const deps = opts.deps || {};
  const accountId = Number(opts.accountId || page.__tkAccountId || 0) || 0;
  const say = makeLogger({ accountId, log: opts.log, liveLog: deps.liveLog });
  const detect = typeof deps.detectCaptcha === 'function' ? deps.detectCaptcha : null;
  const inspect = typeof deps.inspectSlide === 'function' ? deps.inspectSlide : inspectSlideCaptchaInContext;
  const maxAttempts = clampNum(Number(opts.maxAttempts) || 2, 1, 4);
  let geom = firstCheck || null;
  if (!geom || !geom.handleRect) {
    // 进来时没有可信的滑块矩形就自己再看一眼：宁可判「没看到」，也不要按 240px 盲拖别的东西
    try { geom = await inspect(geom && geom.target ? geom.target : page); } catch { geom = null; }
  }
  if (!geom || !geom.detected || geom.kind !== KINDS.DRAGBAR || !geom.handleRect) {
    return { detected: false, solved: false, kind: KINDS.DRAGBAR, attempts: 0, reason: 'no_dragbar_handle' };
  }
  const target = geom.target || page;
  let travel = Math.max(80, Math.round(Number(geom.maxSlideDistance) || 240));

  markCaptchaKind(page, KINDS.DRAGBAR);
  say(`已辨别验证类型：图片拖拽「滑动条」验证（无图滑条，按滑块拖到最右处理，行程 ${travel}px）`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const dragRes = await performSlideDrag(page, geom, travel, {
      sleep,
      readState: null,
      maxSliderPx: travel,
      dragMode: 'handle',
    });
    if (!dragRes.ok) {
      return {
        detected: true, solved: false, kind: KINDS.DRAGBAR, attempts: attempt - 1,
        manualRequired: true, error: dragRes.error || '拖动滑块失败',
      };
    }
    say(`第 ${attempt} 次已把滑块拖到最右（位移 ${round1(dragRes.sliderPx)}px），等待校验…`);
    await sleep(rand(1200, 1800));

    const afterInspect = await inspect(target).catch(() => null);
    if (!afterInspect || !afterInspect.detected) {
      const uni = detect ? await detect(page).catch(() => null) : null;
      if (!(uni && uni.detected)) {
        // 两个读口都挂了 ≠ 验证已通过：拿不到任何一次「确实不在了」的观测就不许报成功
        if (!afterInspect && !uni) {
          return {
            detected: false, solved: false, kind: KINDS.DRAGBAR, attempts: attempt,
            reason: 'state_unreadable',
          };
        }
        page.__tkNoCaptchaLastSolvedAt = Date.now();
        markCaptchaKind(page, KINDS.DRAGBAR);
        say('滑动条验证已通过');
        return { detected: true, solved: true, kind: KINDS.DRAGBAR, attempts: attempt };
      }
      // 换成拼图了：交给平移流程，别再拿同一套行程去拖一个缺口验证
      if (uni.kind === 'slide') {
        if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.DRAGBAR);
        return await solveSlideCaptcha(page, uni, { ...opts, deps, accountId });
      }
      return {
        detected: true,
        solved: false,
        kind: uni.kind || KINDS.DRAGBAR,
        attempts: attempt,
        switched: true,
        manualRequired: true,
        error: `滑动条验证未通过，且验证类型已切换为 ${uni.kind || 'unknown'}`,
      };
    }
    // 仍是本类验证框：只接受「滑条」这一种结论，否则下一轮会拿 handle 行程去拖别的类型
    if (afterInspect.kind !== KINDS.DRAGBAR) {
      if (noteKindHandoff(page) > KIND_HOP_LIMIT) return kindHopBail(KINDS.DRAGBAR);
      return await solveSlideCaptcha(page, afterInspect, { ...opts, deps, accountId });
    }
    geom = afterInspect;
    travel = Math.max(80, Math.round(Number(afterInspect.maxSlideDistance) || travel));
  }

  return {
    detected: true,
    solved: false,
    kind: KINDS.DRAGBAR,
    attempts: maxAttempts,
    manualRequired: true,
    error: '滑动条验证未通过',
  };
}

function isSlideKind(kind) {
  const k = String(kind || '').toLowerCase();
  return k === KINDS.SLIDE || k === KINDS.DRAGBAR;
}

module.exports = {
  KINDS,
  isSlideKind,
  inspectSlideCaptchaInContext,
  solveSlideTargetByLocalCanvas,
  resolveSlideImages,
  captureRect,
  performSlideDrag,
  waitSlideOutcome,
  solveSlideCaptcha,
  solveDragBarCaptcha,
  MATCH_ACCEPT_SCORE,
  MATCH_GOOD_CONFIDENCE,
};