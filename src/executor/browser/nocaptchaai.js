/**
 * NoCaptchaAI 对接模块（TikTok 旋转图片验证 / 圆形双环滑块验证码自动识别与拖拽）
 * ---------------------------------------------------------------------------------
 * 官方文档：https://docs.nocaptchaai.com/docs/imagetasks/tiktok
 * 接口地址：POST https://api.nocaptchaai.com/createTask
 *           POST https://api.nocaptchaai.com/getTaskResult
 *           POST https://api.nocaptchaai.com/solve
 *
 * 默认密钥可通过环境变量 NOCAPTCHAAI_KEY / TKSWARM_NOCAPTCHAAI_KEY 覆盖。
 */
const { publish: liveLog } = require('../live-log');
const dataStore = require('../data-store');
const phpApi = require('../php-api');

const DEFAULT_API_KEY = 'nocap_XrWSZYi3dyxKzr2zvtUxLzbM';
const BASE_URL = (process.env.NOCAPTCHAAI_BASE_URL || 'https://api.nocaptchaai.com').replace(/\/+$/, '');
const KEY_CACHE_TTL_MS = 10000;

let cachedRemoteKey = null;
let cachedRemoteFetchedAt = 0;

function getApiKey(overrideKey = '') {
  return String(
    overrideKey
    || cachedRemoteKey?.apiKey
    || process.env.NOCAPTCHAAI_KEY
    || process.env.TKSWARM_NOCAPTCHAAI_KEY
    || DEFAULT_API_KEY
  ).trim();
}

/**
 * 从中心库（开发管理 · NoCaptchaAI 密钥管理）读取当前启用（status=1）记录的 api_key 字段。
 * - 若有启用记录，返回其 apiKey；
 * - 若所有记录均已禁用（enabled=false 且成功从后端返回），返回空字符串以尊重禁用状态；
 * - 若网络/接口不可达，回退环境变量或默认密钥。
 */
async function resolveActiveApiKey(overrideKey = '', { forceRefresh = false } = {}) {
  const manual = String(overrideKey || '').trim();
  if (manual) return manual;

  const now = Date.now();
  if (!forceRefresh && cachedRemoteKey && (now - cachedRemoteFetchedAt) < KEY_CACHE_TTL_MS) {
    return cachedRemoteKey.apiKey;
  }

  try {
    const res = typeof dataStore.getNocaptchaKey === 'function'
      ? await dataStore.getNocaptchaKey()
      : await phpApi.get('/node/nocaptcha-key');
    if (res && typeof res === 'object') {
      const key = String(res.apiKey ?? res.api_key ?? '').trim();
      const enabled = res.enabled !== undefined ? Boolean(res.enabled) : (Number(res.status) === 1 && Boolean(key));
      cachedRemoteKey = {
        enabled,
        apiKey: enabled ? key : '',
        id: Number(res.id || 0),
        email: String(res.email || ''),
      };
      cachedRemoteFetchedAt = now;
      return cachedRemoteKey.apiKey;
    }
  } catch { /* ignore and fallback */ }

  try {
    const fromSetting = await dataStore.getSetting('nocaptchaApiKey', '');
    if (fromSetting) {
      const k = String(fromSetting).trim();
      cachedRemoteKey = { enabled: true, apiKey: k, id: 0, email: '' };
      cachedRemoteFetchedAt = now;
      return k;
    }
  } catch { /* ignore */ }

  return getApiKey();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripDataUrlPrefix(b64) {
  return String(b64 || '')
    .trim()
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '');
}

/**
 * 调用 NoCaptchaAI 识别 TikTok 旋转验证码角度。
 * @param {object} params
 * @param {string} params.outerBase64 外圈环形图片 base64（不含 data: 前缀）
 * @param {string} params.innerBase64 内圈目标图片 base64（不含 data: 前缀）
 * @param {string} [params.websiteURL] 当前页面 URL
 * @param {string} [params.apiKey] API Key
 * @param {number} [params.timeoutMs] 超时毫秒
 * @returns {Promise<{ ok: boolean, angle: number, angles: number[], raw: any, error?: string }>}
 */
async function requestRotateSolution({
  outerBase64,
  innerBase64,
  websiteURL = 'https://www.tiktok.com',
  apiKey = '',
  timeoutMs = 45000,
} = {}) {
  const clientKey = await resolveActiveApiKey(apiKey);
  if (!clientKey) {
    return { ok: false, angle: 0, angles: [], raw: null, error: '未配置或未启用 NoCaptchaAI 密钥（请在开发管理 → NoCaptchaAI 启用一条密钥记录）' };
  }
  const outer = stripDataUrlPrefix(outerBase64);
  const inner = stripDataUrlPrefix(innerBase64);
  if (!outer || !inner) {
    return { ok: false, angle: 0, angles: [], raw: null, error: '未提取到完整的内外圈旋转验证码图片' };
  }

  const taskPayload = {
    clientKey,
    task: {
      type: 'TiktokClassification',
      images: [outer],
      examples: [inner],
      question: 'tiktok_slide:Rotate the image to the correct angle',
      websiteURL: websiteURL || 'https://www.tiktok.com',
    },
  };

  const parseAngles = (data) => {
    if (!data || typeof data !== 'object') return [];
    const sol = data.solution ?? data.result?.answer ?? data.result ?? null;
    const slide = sol?.slide ?? data.slide ?? (Array.isArray(sol) ? sol : null);
    const out = [];
    if (Array.isArray(slide)) {
      for (const item of slide) {
        if (Array.isArray(item)) {
          for (const v of item) {
            const n = Number(v);
            if (Number.isFinite(n)) out.push(n);
          }
        } else {
          const n = Number(item);
          if (Number.isFinite(n)) out.push(n);
        }
      }
    } else if (typeof sol === 'number' && Number.isFinite(sol)) {
      out.push(sol);
    } else if (typeof sol?.angle === 'number' && Number.isFinite(sol.angle)) {
      out.push(sol.angle);
    } else if (typeof sol?.degree === 'number' && Number.isFinite(sol.degree)) {
      out.push(sol.degree);
    }
    return out;
  };

  try {
    const createRes = await fetch(`${BASE_URL}/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: clientKey,
      },
      body: JSON.stringify(taskPayload),
      signal: AbortSignal.timeout(Math.min(25000, timeoutMs)),
    });
    const created = await createRes.json().catch(() => ({}));

    // 部分图片任务 createTask 直接同步返回 solution
    const directAngles = parseAngles(created);
    if (directAngles.length > 0) {
      return {
        ok: true,
        angle: directAngles[0],
        angles: directAngles,
        raw: created,
      };
    }

    if (created.errorId || created.code) {
      const errMsg = created.errorDescription || created.msg || created.errorCode || JSON.stringify(created);
      return { ok: false, angle: 0, angles: [], raw: created, error: `NoCaptchaAI createTask 失败: ${errMsg}` };
    }

    const taskId = created.taskId || created.id;
    if (!taskId) {
      return {
        ok: false,
        angle: 0,
        angles: [],
        raw: created,
        error: `NoCaptchaAI 未返回 taskId 或 solution: ${JSON.stringify(created).slice(0, 240)}`,
      };
    }

    const deadline = Date.now() + Math.max(10000, timeoutMs);
    while (Date.now() < deadline) {
      await sleep(1500);
      const pollRes = await fetch(`${BASE_URL}/getTaskResult`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: clientKey,
        },
        body: JSON.stringify({ clientKey, taskId }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await pollRes.json().catch(() => ({}));
      const angles = parseAngles(result);
      if (angles.length > 0) {
        return {
          ok: true,
          angle: angles[0],
          angles,
          raw: result,
        };
      }
      if (result.status === 'ready') {
        return {
          ok: false,
          angle: 0,
          angles: [],
          raw: result,
          error: `NoCaptchaAI 返回 ready 但无有效角度: ${JSON.stringify(result).slice(0, 240)}`,
        };
      }
      if (result.status === 'failed' || result.errorId || result.code) {
        const errMsg = result.errorDescription || result.msg || result.errorCode || JSON.stringify(result);
        return { ok: false, angle: 0, angles: [], raw: result, error: `NoCaptchaAI 任务失败: ${errMsg}` };
      }
    }

    return { ok: false, angle: 0, angles: [], raw: null, error: `NoCaptchaAI 轮询超时 (${taskId})` };
  } catch (err) {
    return {
      ok: false,
      angle: 0,
      angles: [],
      raw: null,
      error: `NoCaptchaAI 请求异常: ${err?.message || err}`,
    };
  }
}

/**
 * 在 Frame 或 Page 内探测是否存在 TikTok 旋转图片验证（双圆环拼图/旋转角度验证）。
 */
async function inspectRotateCaptchaInContext(target) {
  return target.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      const st = window.getComputedStyle?.(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      return r.width > 12 && r.height > 12;
    };

    const containerSelectors = [
      '#captcha-verify-container',
      '.captcha_verify_container',
      '[class*="captcha-verify-container" i]',
      '[class*="captcha_verify_container" i]',
      '[id*="captcha" i]',
      '[class*="secsdk-captcha" i]',
      '[class*="Captcha" i]',
      '[role="dialog"]',
    ];

    let container = null;
    for (const sel of containerSelectors) {
      const list = Array.from(document.querySelectorAll(sel)).filter(vis);
      for (const el of list) {
        const imgs = Array.from(el.querySelectorAll('img')).filter(vis);
        const text = String(el.innerText || '');
        if (
          imgs.length >= 2
          || /drag the slider to fit the puzzle|rotate|旋转|拖动滑块|完成拼图|调整角度/i.test(text)
        ) {
          container = el;
          break;
        }
      }
      if (container) break;
    }

    const root = container || document.body;
    if (!root) return { detected: false };

    const rootText = String(root.innerText || '').slice(0, 4000);
    const allImgs = Array.from(root.querySelectorAll('img')).filter((img) => {
      if (!vis(img)) return false;
      const src = String(img.currentSrc || img.src || '');
      if (!src || /\.svg(?:\?|$)/i.test(src)) return false;
      const r = img.getBoundingClientRect();
      return r.width >= 40 && r.height >= 40;
    });

    // 查找旋转图特征：
    // 1. 显式 data-e2e / whirl / rotate 命名
    // 2. 同一中心附近的两个近似正方形图片（外圈大圆 + 内圈小圆）
    let outerImg = root.querySelector(
      '[data-e2e="captcha-whirl-outer"], img[class*="whirl-outer" i], img[id*="whirl-outer" i]'
    );
    let innerImg = root.querySelector(
      '[data-e2e="captcha-whirl-inner"], img[class*="whirl-inner" i], img[id*="whirl-inner" i]'
    );

    if (!outerImg || !innerImg || !vis(outerImg) || !vis(innerImg)) {
      outerImg = null;
      innerImg = null;
      // 在可见图片中寻找同心或重叠的两个近似正方形圆环图
      const squareImgs = allImgs.filter((img) => {
        const r = img.getBoundingClientRect();
        const ratio = r.width / Math.max(1, r.height);
        return ratio >= 0.78 && ratio <= 1.28 && r.width >= 45 && r.width <= 380;
      });

      let bestPair = null;
      let bestScore = Infinity;
      for (let i = 0; i < squareImgs.length; i += 1) {
        for (let j = i + 1; j < squareImgs.length; j += 1) {
          const a = squareImgs[i];
          const b = squareImgs[j];
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const cxa = ra.left + ra.width / 2;
          const cya = ra.top + ra.height / 2;
          const cxb = rb.left + rb.width / 2;
          const cyb = rb.top + rb.height / 2;
          const centerDist = Math.hypot(cxa - cxb, cya - cyb);
          const big = ra.width >= rb.width ? { el: a, r: ra } : { el: b, r: rb };
          const small = ra.width >= rb.width ? { el: b, r: rb } : { el: a, r: ra };
          // 同心圆：中心距离很小，且外圈比内圈大（或者大小相近重叠）
          if (centerDist <= Math.max(36, big.r.width * 0.25) && big.r.width >= small.r.width * 1.05) {
            if (centerDist < bestScore) {
              bestScore = centerDist;
              bestPair = { outer: big.el, inner: small.el };
            }
          }
        }
      }

      if (bestPair) {
        outerImg = bestPair.outer;
        innerImg = bestPair.inner;
      } else if (
        squareImgs.length >= 2
        && (/drag the slider to fit the puzzle|rotate|旋转|拖动滑块.*拼图|调整角度/i.test(rootText)
          || container)
      ) {
        // 按面积从大到小排，取前两个近似正方形图（排除方形背景拼图+小窄滑块：拼图滑块通常宽高比悬殊或宽度 < 70 且不居同心）
        const sorted = [...squareImgs].sort((x, y) => {
          const rx = x.getBoundingClientRect();
          const ry = y.getBoundingClientRect();
          return (ry.width * ry.height) - (rx.width * rx.height);
        });
        const r0 = sorted[0].getBoundingClientRect();
        const r1 = sorted[1].getBoundingClientRect();
        const cx0 = r0.left + r0.width / 2;
        const cy0 = r0.top + r0.height / 2;
        const cx1 = r1.left + r1.width / 2;
        const cy1 = r1.top + r1.height / 2;
        if (Math.hypot(cx0 - cx1, cy0 - cy1) <= Math.max(55, r0.width * 0.35)) {
          outerImg = sorted[0];
          innerImg = sorted[1];
        }
      }
    }

    if (!outerImg || !innerImg) {
      return { detected: false };
    }

    // 寻找滑块按钮与滑轨
    const handleSelectors = [
      '.secsdk-captcha-drag-icon',
      '[class*="captcha_verify_slide--slidebar" i] [class*="icon" i]',
      '[class*="secsdk-captcha-drag-icon" i]',
      '[class*="drag-icon" i]',
      '[class*="slider-button" i]',
      '[class*="slider_btn" i]',
      '[class*="slide-btn" i]',
      '[aria-label*="slider" i]',
      'div[role="slider"]',
      'button[role="slider"]',
    ];
    let handleEl = null;
    for (const sel of handleSelectors) {
      const cand = Array.from(root.querySelectorAll(sel)).find(vis)
        || Array.from(document.querySelectorAll(sel)).find(vis);
      if (cand) {
        handleEl = cand;
        break;
      }
    }

    // 兜底查找滑块手柄：位于外圈图片下方、宽度 28~90、高度 24~80 的可拖拽块
    const outerRect = outerImg.getBoundingClientRect();
    if (!handleEl) {
      const cands = Array.from(root.querySelectorAll('div, button, span')).filter((el) => {
        if (!vis(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.top < outerRect.bottom - 20 || r.top > outerRect.bottom + 140) return false;
        if (r.width < 28 || r.width > 95 || r.height < 24 || r.height > 85) return false;
        const st = window.getComputedStyle(el);
        return st.cursor === 'pointer' || st.cursor === 'grab' || st.cursor === 'move'
          || /drag|slide|btn|handle|icon/i.test(`${el.className || ''} ${el.id || ''}`);
      });
      cands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      handleEl = cands[0] || null;
    }

    if (!handleEl) {
      return { detected: false, reason: 'found_images_but_no_slider_handle' };
    }

    const handleRect = handleEl.getBoundingClientRect();

    // 查找滑轨宽度
    const trackSelectors = [
      '.captcha_verify_slide--slidebar',
      '[class*="captcha_verify_slide--slidebar" i]',
      '[class*="secsdk-captcha-drag-wrapper" i]',
      '[class*="slidebar" i]',
      '[class*="slider-track" i]',
      '[class*="slide-bar" i]',
    ];
    let trackEl = null;
    for (const sel of trackSelectors) {
      const cand = Array.from(root.querySelectorAll(sel)).find((el) => {
        if (!vis(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > handleRect.width * 2;
      });
      if (cand) {
        trackEl = cand;
        break;
      }
    }
    if (!trackEl) {
      let p = handleEl.parentElement;
      while (p && p !== document.body) {
        const r = p.getBoundingClientRect();
        if (r.width >= Math.max(160, outerRect.width * 0.75) && r.width <= 520 && r.height <= 90) {
          trackEl = p;
          break;
        }
        p = p.parentElement;
      }
    }

    const trackRect = trackEl
      ? trackEl.getBoundingClientRect()
      : {
          left: outerRect.left,
          top: handleRect.top,
          width: Math.max(outerRect.width, 260),
          height: handleRect.height,
        };

    const maxSlideDistance = Math.max(100, trackRect.width - handleRect.width);

    return {
      detected: true,
      outerSrc: String(outerImg.currentSrc || outerImg.src || ''),
      innerSrc: String(innerImg.currentSrc || innerImg.src || ''),
      outerRect: {
        x: outerRect.left,
        y: outerRect.top,
        width: outerRect.width,
        height: outerRect.height,
      },
      innerRect: {
        x: innerImg.getBoundingClientRect().left,
        y: innerImg.getBoundingClientRect().top,
        width: innerImg.getBoundingClientRect().width,
        height: innerImg.getBoundingClientRect().height,
      },
      handleRect: {
        x: handleRect.left,
        y: handleRect.top,
        width: handleRect.width,
        height: handleRect.height,
      },
      trackRect: {
        x: trackRect.left,
        y: trackRect.top,
        width: trackRect.width,
        height: trackRect.height,
      },
      maxSlideDistance,
    };
  }).catch(() => ({ detected: false }));
}

/**
 * 将图片 URL 或页面内 img 转为纯 base64 字符串。
 */
async function fetchImageAsBase64(target, imgUrl, fallbackSelectorInfo = null) {
  const raw = String(imgUrl || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) {
    return stripDataUrlPrefix(raw);
  }

  // 1) 在浏览器上下文内通过 fetch / canvas 提取（自动携带同源 Cookie 与 Referer）
  const inPageB64 = await target.evaluate(async ({ url, rect }) => {
    const toBase64FromBlob = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (res.ok) {
        const blob = await res.blob();
        const dataUrl = await toBase64FromBlob(blob);
        if (dataUrl && dataUrl.includes(',')) return dataUrl.split(',')[1];
      }
    } catch { /* fallback to canvas */ }

    try {
      const imgs = Array.from(document.querySelectorAll('img'));
      const matched = imgs.find((im) => (im.currentSrc || im.src) === url)
        || (rect
          ? imgs.find((im) => {
              const r = im.getBoundingClientRect();
              return Math.abs(r.left - rect.x) < 10 && Math.abs(r.width - rect.width) < 10;
            })
          : null);
      if (matched && matched.complete && matched.naturalWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = matched.naturalWidth;
        canvas.height = matched.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(matched, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.includes(',')) return dataUrl.split(',')[1];
      }
    } catch { /* ignore */ }
    return '';
  }, { url: raw, rect: fallbackSelectorInfo }).catch(() => '');

  if (inPageB64) return stripDataUrlPrefix(inPageB64);

  // 2) Node 侧兜底下载
  try {
    const res = await fetch(raw, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://www.tiktok.com/',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 拟人化拖动旋转验证码滑块。
 */
async function dragSliderByDistance(page, handleRect, distancePx) {
  const startX = handleRect.x + handleRect.width / 2 + (Math.random() * 4 - 2);
  const startY = handleRect.y + handleRect.height / 2 + (Math.random() * 4 - 2);
  const targetX = startX + distancePx;

  await page.mouse.move(startX, startY, { steps: 6 });
  await sleep(80 + Math.floor(Math.random() * 90));
  await page.mouse.down();
  await sleep(60 + Math.floor(Math.random() * 80));

  const steps = Math.max(18, Math.min(45, Math.round(Math.abs(distancePx) / 4)));
  // 先微超一点点再回拉（模拟真人对齐双圆环边缘）
  const overshoot = distancePx > 25 ? (Math.random() * 3 + 1.2) : 0;

  for (let i = 1; i <= steps; i += 1) {
    const progress = i / steps;
    // easeOutCubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const curX = startX + (distancePx + overshoot) * eased;
    const curY = startY + Math.sin(progress * Math.PI) * (Math.random() * 2.5 - 1.25);
    await page.mouse.move(curX, curY);
    await sleep(8 + Math.floor(Math.random() * 14));
  }

  if (overshoot > 0) {
    await sleep(70 + Math.floor(Math.random() * 60));
    await page.mouse.move(targetX, startY + (Math.random() * 1.5 - 0.75), { steps: 4 });
  }

  await sleep(90 + Math.floor(Math.random() * 110));
  await page.mouse.up();
}

/**
 * 在 Page（含子 Frame）中定位旋转验证码详情。
 */
async function detectRotateCaptcha(page) {
  if (!page || page.isClosed?.()) return { detected: false };
  const targets = [page, ...(page.frames?.() || []).filter((f) => f !== page.mainFrame?.())];
  for (const target of targets) {
    const info = await inspectRotateCaptchaInContext(target);
    if (info?.detected) {
      // 若在子 iframe 内，转换坐标到主页面视口以便 page.mouse 拖拽
      let offsetX = 0;
      let offsetY = 0;
      if (target !== page && typeof target.frameElement === 'function') {
        try {
          const frameEl = await target.frameElement();
          const box = await frameEl?.boundingBox?.();
          if (box) {
            offsetX = box.x;
            offsetY = box.y;
          }
        } catch { /* ignore */ }
      }
      return {
        ...info,
        target,
        handleRect: {
          ...info.handleRect,
          x: info.handleRect.x + offsetX,
          y: info.handleRect.y + offsetY,
        },
        trackRect: {
          ...info.trackRect,
          x: info.trackRect.x + offsetX,
          y: info.trackRect.y + offsetY,
        },
      };
    }
  }
  return { detected: false };
}

/**
 * 检测并自动使用 NoCaptchaAI 解决 TikTok 旋转图片验证。
 * - 若页面不存在旋转图片验证，返回 { detected: false, solved: false }
 * - 若存在旋转图片验证，自动提取内外环图片 → 调 NoCaptchaAI → 计算距离并拖拽滑块 → 校验验证弹层是否消失
 *
 * @param {import('playwright-core').Page} page
 * @param {object} [options]
 * @param {number} [options.accountId]
 * @param {number} [options.maxAttempts] 最多尝试几次（失败刷新后重试）
 * @param {string} [options.apiKey]
 * @param {function} [options.log]
 * @returns {Promise<{ detected: boolean, solved: boolean, attempts: number, lastAngle?: number, error?: string }>}
 */
async function solveRotateCaptchaIfPresent(page, {
  accountId = 0,
  maxAttempts = 3,
  apiKey = '',
  log = null,
} = {}) {
  if (!page || page.isClosed?.()) return { detected: false, solved: false, attempts: 0 };

  // 防止同一 page 并发重入执行多次拖拽
  if (page.__tkNoCaptchaSolving) {
    return page.__tkNoCaptchaSolving;
  }

  const say = (msg, level = 'info') => {
    if (typeof log === 'function') {
      try { log(msg, level); } catch { /* ignore */ }
    }
    liveLog(
      `[NoCaptchaAI${accountId ? `#${accountId}` : ''}] ${msg}`,
      level,
      accountId ? { accountId } : {}
    );
  };

  const runner = (async () => {
    let firstCheck = await detectRotateCaptcha(page);
    if (!firstCheck.detected) {
      return { detected: false, solved: false, attempts: 0 };
    }

    // 临时关闭省流拦截，保证验证码旋转图片与刷新资源正常加载
    let pausedSaveTraffic = false;
    try {
      const { pauseSaveTrafficForCaptcha } = require('./save-traffic');
      await pauseSaveTrafficForCaptcha(page);
      pausedSaveTraffic = true;
    } catch { /* ignore */ }

    let lastError = '';
    let lastAngle = 0;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const info = attempt === 1 ? firstCheck : await detectRotateCaptcha(page);
        if (!info.detected) {
          say('旋转图片验证已消失，验证通过');
          return { detected: true, solved: true, attempts: attempt - 1, lastAngle };
        }

        say(`检测到旋转图片验证（第 ${attempt}/${maxAttempts} 次），正在提取内外环图片并调用 NoCaptchaAI…`);

        // 等待图片加载完成
        await sleep(500);
        const outerBase64 = await fetchImageAsBase64(info.target || page, info.outerSrc, info.outerRect);
        const innerBase64 = await fetchImageAsBase64(info.target || page, info.innerSrc, info.innerRect);

        if (!outerBase64 || !innerBase64) {
          lastError = '未能读取旋转验证码内外环图片数据';
          say(`${lastError}，稍后重试`, 'warn');
          await sleep(1200);
          continue;
        }

        const pageUrl = (() => {
          try { return page.url() || 'https://www.tiktok.com'; } catch { return 'https://www.tiktok.com'; }
        })();

        const sol = await requestRotateSolution({
          outerBase64,
          innerBase64,
          websiteURL: pageUrl,
          apiKey,
        });

        if (!sol.ok || !Number.isFinite(sol.angle)) {
          lastError = sol.error || 'NoCaptchaAI 未返回有效旋转角度';
          say(`识别失败：${lastError}`, 'warn');
          await sleep(1200);
          continue;
        }

        // 归一化角度到 [0, 360)
        const rawAngle = Number(sol.angle);
        const angle = ((rawAngle % 360) + 360) % 360;
        lastAngle = angle;

        // TikTok 双环旋转验证：滑块从左滑到右对应旋转 180°（内外圈反向同步旋转各 180°，合计 360°）
        // 当返回角度在 (0, 360) 时，若超过 180° 则按 180° 或 360° 比例映射：
        // NoCaptchaAI TiktokClassification `tiktok_slide` 返回的角度直接对应 (angle / 180) * maxSlideDistance（若 angle > 180 则走 360 满量程比例）
        const fullScaleDeg = angle > 180 ? 360 : 180;
        const distancePx = Math.max(4, Math.min(info.maxSlideDistance, (angle / fullScaleDeg) * info.maxSlideDistance));

        say(
          `NoCaptchaAI 识别成功：角度=${rawAngle.toFixed(2)}°（滑轨可滑=${Math.round(info.maxSlideDistance)}px，拖动距离=${distancePx.toFixed(1)}px）`
        );

        await dragSliderByDistance(page, info.handleRect, distancePx);

        // 等待验证结果判定（消失或刷新换新图）
        const checkDeadline = Date.now() + 4800;
        while (Date.now() < checkDeadline) {
          await sleep(600);
          const after = await detectRotateCaptcha(page);
          if (!after.detected) {
            say(`旋转图片验证已通过（第 ${attempt} 次尝试）`);
            return { detected: true, solved: true, attempts: attempt, lastAngle };
          }
          // 若图片 src 已变化，说明本次未对齐已自动刷新下一张，提前进入下一轮识别
          if (after.outerSrc && info.outerSrc && after.outerSrc !== info.outerSrc) {
            break;
          }
        }

        say(`第 ${attempt} 次拖动后旋转验证仍存在，准备重试…`, 'warn');
        await sleep(800);
      }

      return {
        detected: true,
        solved: false,
        attempts: maxAttempts,
        lastAngle,
        error: lastError || '多次尝试后旋转图片验证仍未通过',
      };
    } finally {
      if (pausedSaveTraffic) {
        try {
          const stillThere = await detectRotateCaptcha(page);
          if (!stillThere.detected) {
            const { resumeSaveTrafficAfterCaptcha } = require('./save-traffic');
            await resumeSaveTrafficAfterCaptcha(page);
          }
        } catch { /* ignore */ }
      }
    }
  })();

  page.__tkNoCaptchaSolving = runner;
  try {
    return await runner;
  } finally {
    page.__tkNoCaptchaSolving = null;
  }
}

/**
 * 为 Page 挂载后台自动监听器：
 * 在服务器浏览器任意任务执行期间，只要页面加载出 TikTok 旋转验证图片或弹出验证层，
 * 自动触发 solveRotateCaptchaIfPresent。
 */
function attachAutoRotateCaptchaWatcher(page, { accountId = 0, apiKey = '' } = {}) {
  if (!page || page.isClosed?.() || page.__tkNoCaptchaWatcherAttached) return;
  page.__tkNoCaptchaWatcherAttached = true;

  let debounceTimer = null;
  const triggerCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!page || page.isClosed?.() || page.__tkNoCaptchaSolving) return;
      solveRotateCaptchaIfPresent(page, { accountId, apiKey }).catch(() => {});
    }, 650);
    debounceTimer.unref?.();
  };

  const onResponse = (resp) => {
    try {
      const url = String(resp.url?.() || '');
      if (!url) return;
      if (
        /captcha|verify[-_]?center|secsdk|whirl|rotate[-_]?verify|p\d+-captcha/i.test(url)
        && resp.status?.() === 200
      ) {
        triggerCheck();
      }
    } catch { /* ignore */ }
  };

  page.on?.('response', onResponse);
  page.once?.('close', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    try { page.off?.('response', onResponse); } catch { /* ignore */ }
  });
}

module.exports = {
  DEFAULT_API_KEY,
  getApiKey,
  resolveActiveApiKey,
  requestRotateSolution,
  detectRotateCaptcha,
  solveRotateCaptchaIfPresent,
  attachAutoRotateCaptchaWatcher,
};
