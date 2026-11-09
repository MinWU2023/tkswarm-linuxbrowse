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
const QUOTA_LIMIT = 200;

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

function clearNocaptchaKeyCache() {
  cachedRemoteKey = null;
  cachedRemoteFetchedAt = 0;
}

/** 识别 NoCaptchaAI 返回的当日额度耗尽 / 200 次上限 / 余额不足类错误 */
function looksLikeQuotaExhausted(payloadOrMsg) {
  const text = typeof payloadOrMsg === 'string'
    ? payloadOrMsg
    : JSON.stringify(payloadOrMsg || {});
  return /daily[_\s-]?(limit|quota)|zero[_\s-]?balance|insufficient|no[_\s-]?balance|out[_\s-]?of[_\s-]?(credit|quota)|quota[_\s-]?(exceed|limit|used)|free[_\s-]?(limit|trial)|limit[_\s-]?reached|余额不足|额度|用完|耗尽|上限/i.test(text);
}

/** 识别免费 30 天到期 / 账号封停类永久报废错误 */
function looksLikeKeyScrapped(payloadOrMsg) {
  const text = typeof payloadOrMsg === 'string'
    ? payloadOrMsg
    : JSON.stringify(payloadOrMsg || {});
  return /trial[_\s-]?expired|free[_\s-]?plan[_\s-]?expired|account[_\s-]?(banned|suspended|terminated)|已过期|已报废/i.test(text);
}

/**
 * 上报用量到中心库；当日达 200（或 exhausted=true / 超 30 天报废）时自动切换下一个可用密钥。
 * @returns {Promise<{ switched?: boolean, active?: any }|null>}
 */
async function reportUsageToCenter({
  apiKey = '',
  id = 0,
  increment = 1,
  exhausted = false,
  scrapped = false,
  remoteUsed = null,
} = {}) {
  try {
    const payload = {
      apiKey: String(apiKey || cachedRemoteKey?.apiKey || '').trim(),
      id: Number(id || cachedRemoteKey?.id || 0) || 0,
      increment: Math.max(0, Number(increment) || 0),
      exhausted: Boolean(exhausted || scrapped),
      scrapped: Boolean(scrapped),
    };
    if (remoteUsed != null && Number.isFinite(Number(remoteUsed))) {
      payload.remoteUsed = Math.max(0, Number(remoteUsed));
    }
    const res = typeof dataStore.reportNocaptchaUsage === 'function'
      ? await dataStore.reportNocaptchaUsage(payload)
      : await phpApi.post('/node/nocaptcha-key/report-usage', payload);
    if (res?.switched || res?.exhausted || res?.scrapped) {
      clearNocaptchaKeyCache();
      const nextKey = String(res?.active?.apiKey || res?.active?.api_key || '').trim();
      const reasonLabel = res?.scrapped ? '已满30天报废' : '今日200次额度已满';
      if (nextKey) {
        cachedRemoteKey = {
          enabled: true,
          apiKey: nextKey,
          id: Number(res.active?.id || 0),
          email: String(res.active?.email || ''),
          usedCount: Number(res.active?.usedCount ?? res.active?.used_count ?? 0),
          quotaLimit: Number(res.active?.quotaLimit ?? res.active?.quota_limit ?? QUOTA_LIMIT),
        };
        cachedRemoteFetchedAt = Date.now();
        liveLog(
          `[NoCaptchaAI] 当前密钥${reasonLabel}，已自动切换到 #${cachedRemoteKey.id || '-'}（${cachedRemoteKey.email || '备用'}）`,
          'warn',
        );
      } else {
        liveLog(`[NoCaptchaAI] 当前密钥${reasonLabel}，且暂无其它可用密钥可切换`, 'warn');
      }
    } else if (res?.active) {
      const used = Number(res.active.usedCount ?? res.active.used_count ?? 0);
      if (cachedRemoteKey) {
        cachedRemoteKey.usedCount = used;
        cachedRemoteKey.quotaLimit = Number(res.active.quotaLimit ?? res.active.quota_limit ?? QUOTA_LIMIT);
      }
    }
    return res || null;
  } catch {
    return null;
  }
}

/**
 * 从中心库（开发管理 · NoCaptchaAI 密钥管理）读取当前启用（status=1、未报废且当日未满 200）记录的 api_key。
 * 若启用记录当日已达 200 或已满 30 天报废，中心库会自动切换到下一条可用密钥。
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
      const enabled = res.enabled !== undefined
        ? Boolean(res.enabled)
        : (
          Number(res.status) === 1
          && Number(res.isScrapped ?? res.is_scrapped ?? 0) !== 1
          && Number(res.isExhausted ?? res.is_exhausted ?? 0) !== 1
          && Boolean(key)
        );
      cachedRemoteKey = {
        enabled,
        apiKey: enabled ? key : '',
        id: Number(res.id || 0),
        email: String(res.email || ''),
        usedCount: Number(res.usedCount ?? res.used_count ?? 0),
        quotaLimit: Number(res.quotaLimit ?? res.quota_limit ?? QUOTA_LIMIT),
      };
      cachedRemoteFetchedAt = now;
      return cachedRemoteKey.apiKey;
    }
  } catch { /* ignore and fallback */ }

  try {
    const fromSetting = await dataStore.getSetting('nocaptchaApiKey', '');
    if (fromSetting) {
      const k = String(fromSetting).trim();
      cachedRemoteKey = { enabled: true, apiKey: k, id: 0, email: '', usedCount: 0, quotaLimit: QUOTA_LIMIT };
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
  _failoverDepth = 0,
} = {}) {
  const clientKey = await resolveActiveApiKey(apiKey, { forceRefresh: _failoverDepth > 0 });
  if (!clientKey) {
    return { ok: false, angle: 0, angles: [], raw: null, error: '未配置或暂无可用的 NoCaptchaAI 密钥（今日额度已满或已报废）' };
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

  const markSuccess = async () => {
    await reportUsageToCenter({ apiKey: clientKey, increment: 1 });
  };
  const markExhaustedIfNeeded = async (payload) => {
    const scrapped = looksLikeKeyScrapped(payload);
    const exhausted = scrapped || looksLikeQuotaExhausted(payload);
    if (!exhausted) return { exhausted: false, nextKey: '' };
    const r = await reportUsageToCenter({ apiKey: clientKey, increment: 0, exhausted: true, scrapped });
    const nextKey = String(r?.active?.apiKey || r?.active?.api_key || '').trim();
    return { exhausted: true, nextKey };
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
      await markSuccess();
      return {
        ok: true,
        angle: directAngles[0],
        angles: directAngles,
        raw: created,
      };
    }

    if (created.errorId || created.code) {
      const errMsg = created.errorDescription || created.msg || created.errorCode || JSON.stringify(created);
      const { exhausted, nextKey } = await markExhaustedIfNeeded(created);
      if (exhausted && !apiKey && nextKey && nextKey !== clientKey && _failoverDepth < 3) {
        return requestRotateSolution({
          outerBase64,
          innerBase64,
          websiteURL,
          apiKey: '',
          timeoutMs,
          _failoverDepth: _failoverDepth + 1,
        });
      }
      return {
        ok: false,
        angle: 0,
        angles: [],
        raw: created,
        exhausted,
        error: `NoCaptchaAI createTask 失败: ${errMsg}`,
      };
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
        await markSuccess();
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
        const { exhausted, nextKey } = await markExhaustedIfNeeded(result);
        if (exhausted && !apiKey && nextKey && nextKey !== clientKey && _failoverDepth < 3) {
          return requestRotateSolution({
            outerBase64,
            innerBase64,
            websiteURL,
            apiKey: '',
            timeoutMs,
            _failoverDepth: _failoverDepth + 1,
          });
        }
        return {
          ok: false,
          angle: 0,
          angles: [],
          raw: result,
          exhausted,
          error: `NoCaptchaAI 任务失败: ${errMsg}`,
        };
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
      '.TUXModal.captcha-verify-container',
      '#captcha-verify-container',
      '.captcha_verify_container',
      '[class*="captcha-verify-container" i]',
      '[class*="captcha_verify_container" i]',
      '[id*="captcha" i]',
      '[class*="secsdk-captcha" i]',
      '[class*="Captcha" i]',
      '[role="dialog"]',
    ];

    // 先修复被遮罩清理逻辑误设为 opacity: 0 或 pointer-events: none 的验证弹窗容器及祖先节点
    const explicitCaptchaNodes = Array.from(document.querySelectorAll(
      '.TUXModal.captcha-verify-container, #captcha-verify-container, .captcha_verify_container, [class*="captcha-verify-container" i], [class*="captcha_verify_container" i], [id*="captcha" i], [class*="secsdk-captcha" i], [class*="secsdk_captcha" i]'
    ));
    for (const node of explicitCaptchaNodes) {
      let cur = node;
      while (cur && cur !== document.body && cur instanceof HTMLElement) {
        if (cur.hasAttribute('data-tkswarm-mask-cleared') || cur.style.opacity === '0' || cur.style.pointerEvents === 'none') {
          cur.style.opacity = '';
          cur.style.pointerEvents = '';
          cur.removeAttribute('data-tkswarm-mask-cleared');
        }
        cur = cur.parentElement;
      }
    }

    let container = null;
    for (const sel of containerSelectors) {
      const list = Array.from(document.querySelectorAll(sel)).filter(vis);
      for (const el of list) {
        const imgs = Array.from(el.querySelectorAll('img'));
        const text = String(el.innerText || '');
        const isExplicitCaptchaShell = sel !== '[role="dialog"]' && (
          /captcha|secsdk/i.test(`${el.id || ''} ${el.className || ''}`)
          || Boolean(el.querySelector('iframe[src*="captcha" i], iframe[src*="verify" i], iframe[src*="secsdk" i], [class*="captcha" i], [id*="captcha" i]'))
        );
        const hasSlideBtn = Boolean(
          el.querySelector('#captcha_slide_button, .secsdk-captcha-drag-icon, div.cap-flex.cap-absolute')
        );
        if (
          isExplicitCaptchaShell
          || hasSlideBtn
          || imgs.filter(vis).length >= 2
          || /drag the slider to fit the puzzle|rotate|旋转|拖动滑块|完成拼图|调整角度|verify to continue|安全验证|人机验证/i.test(text)
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
    const hasExplicitContainer = Boolean(
      container && (
        /captcha|secsdk/i.test(`${container.id || ''} ${container.className || ''}`)
        || container.querySelector('#captcha-verify-container, .captcha_verify_container, [class*="captcha" i], [id*="captcha" i], iframe')
      )
    );
    const hasRotateHint = Boolean(
      container
      && (
        hasExplicitContainer
        || root.querySelector('#captcha_slide_button, .secsdk-captcha-drag-icon, div.cap-flex.cap-absolute')
        || /drag the slider to fit the puzzle|rotate|旋转|拖动滑块.*拼图|调整角度|verify to continue|安全验证|人机验证/i.test(rootText)
      )
    );

    const allImgs = Array.from(root.querySelectorAll('img')).filter((img) => {
      if (!vis(img)) return false;
      const src = String(img.currentSrc || img.src || '');
      if (!src || /\.svg(?:\?|$)/i.test(src)) return false;
      const r = img.getBoundingClientRect();
      return r.width >= 40 && r.height >= 40;
    });

    let outerImg = root.querySelector(
      '[data-e2e="captcha-whirl-outer"], img[class*="whirl-outer" i], img[id*="whirl-outer" i]'
    );
    let innerImg = root.querySelector(
      '[data-e2e="captcha-whirl-inner"], img[class*="whirl-inner" i], img[id*="whirl-inner" i]'
    );

    if (!outerImg || !innerImg || !vis(outerImg) || !vis(innerImg)) {
      outerImg = null;
      innerImg = null;
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
          if (centerDist <= Math.max(36, big.r.width * 0.25) && big.r.width >= small.r.width) {
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
      if (hasRotateHint) {
        const failedImg = Array.from(root.querySelectorAll('img')).some(
          (img) => img.complete === true && img.naturalWidth === 0
        );
        const widgetErr = /something went wrong|couldn'?t load|network error|try again|刷新|重试/i.test(rootText);
        return {
          detected: false,
          loading: true,
          failedLoad: Boolean(failedImg || widgetErr),
          reason: widgetErr ? 'captcha_widget_error' : 'captcha_container_images_loading',
        };
      }
      return { detected: false };
    }

    if (
      (outerImg.complete === false || innerImg.complete === false)
      || (outerImg.naturalWidth === 0 || innerImg.naturalWidth === 0)
    ) {
      const failedLoad = (outerImg.complete === true && outerImg.naturalWidth === 0)
        || (innerImg.complete === true && innerImg.naturalWidth === 0);
      return {
        detected: false,
        loading: true,
        failedLoad,
        reason: failedLoad ? 'captcha_images_broken' : 'captcha_images_incomplete',
      };
    }

    const handleSelectors = [
      '#captcha_slide_button',
      'div.cap-flex.cap-absolute',
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
      return { detected: false, loading: hasRotateHint, reason: 'found_images_but_no_slider_handle' };
    }

    // 若命中的是滑块按钮内部的小图标，向上归并到滑块按钮本体（通常宽 40~80px）
    if (handleEl.getBoundingClientRect().width < 34 && handleEl.parentElement) {
      const pr = handleEl.parentElement.getBoundingClientRect();
      if (pr.width >= 36 && pr.width <= 92 && pr.height >= 28 && pr.height <= 85) {
        handleEl = handleEl.parentElement;
      }
    }

    const handleRect = handleEl.getBoundingClientRect();

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
        if (r.width >= Math.max(180, outerRect.width * 0.85) && r.width <= 520 && r.height <= 90) {
          trackEl = p;
          break;
        }
        p = p.parentElement;
      }
    }

    const defaultSlideDist = window.innerWidth < 640 ? 224 : 284;
    const trackRect = trackEl
      ? trackEl.getBoundingClientRect()
      : {
          left: handleRect.left,
          top: handleRect.top,
          width: defaultSlideDist + handleRect.width,
          height: handleRect.height,
        };

    const maxSlideDistance = trackEl
      ? Math.max(100, trackRect.width - handleRect.width)
      : defaultSlideDist;

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
 * 本地 Canvas 极坐标交界像素匹配算法（零成本、毫秒级，完全替代第三方接口）：
 * ---------------------------------------------------------------------------
 * 原理：
 * 1. TikTok 旋转图片验证由同一张方形原图切分为外环（outer）和内圆（inner）；
 * 2. 将内外图按页面真实显示比例统一绘制到离屏 Canvas（默认 320x320，中心对齐）；
 * 3. 从中心向外扫描内圆透明度/掩码与外环内洞边界，自适应定位同心圆切割半径 R_seam；
 * 4. 在交界处内侧（R_seam - δ）和外侧（R_seam + δ）做 720 点（步长 0.5°）双线性插值极坐标采样，
 *    同时提取 RGB 色彩通道、亮度通道与环向切线梯度（一阶差分）；
 * 5. 对 θ ∈ [0°, 360°) 全角度计算「多圈边缘色差（SAD）+ 环向梯度归一化互相关（NCC）」综合损失，
 *    找出最佳对齐角 θ*（外环相对于内圆的顺时针对齐角）及抛物线亚像素拟合角度。
 *
 * @param {import('playwright-core').Page|import('playwright-core').Frame} target
 * @param {object} params
 * @param {string} [params.outerBase64]
 * @param {string} [params.innerBase64]
 * @param {string} [params.outerSrc]
 * @param {string} [params.innerSrc]
 * @param {object} [params.outerRect]
 * @param {object} [params.innerRect]
 * @returns {Promise<{ ok: boolean, angle: number, secondAngle?: number, confidence: number, seamRadius?: number, elapsedMs?: number, error?: string }>}
 */
async function solveRotateAngleByLocalCanvas(target, {
  outerBase64 = '',
  innerBase64 = '',
  outerSrc = '',
  innerSrc = '',
  outerRect = null,
  innerRect = null,
} = {}) {
  if (!target) {
    return { ok: false, angle: 0, confidence: 0, error: '缺少页面上下文 target' };
  }
  const outerDataUrl = outerBase64
    ? (/^data:image\//i.test(outerBase64) ? outerBase64 : `data:image/png;base64,${outerBase64}`)
    : '';
  const innerDataUrl = innerBase64
    ? (/^data:image\//i.test(innerBase64) ? innerBase64 : `data:image/png;base64,${innerBase64}`)
    : '';

  const displayRatio = (
    outerRect?.width > 20
    && innerRect?.width > 20
    && innerRect.width < outerRect.width * 0.98
  )
    ? (innerRect.width / outerRect.width)
    : 0;

  return target.evaluate(async ({
    outerDataUrl: oData,
    innerDataUrl: iData,
    outerSrc: oUrl,
    innerSrc: iUrl,
    displayRatio: domRatio,
  }) => {
    const t0 = performance.now();

    const loadImg = (dataUrl, rawUrl) => new Promise((resolve, reject) => {
      const tryDom = () => {
        if (!rawUrl) return null;
        const imgs = Array.from(document.querySelectorAll('img'));
        const hit = imgs.find((im) => (im.currentSrc || im.src) === rawUrl && im.complete && im.naturalWidth > 0);
        return hit || null;
      };
      if (dataUrl) {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => {
          const d = tryDom();
          if (d) resolve(d);
          else reject(new Error('image_dataurl_load_failed'));
        };
        im.src = dataUrl;
        return;
      }
      const domHit = tryDom();
      if (domHit) {
        resolve(domHit);
        return;
      }
      if (rawUrl) {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('image_url_load_failed'));
        im.src = rawUrl;
        return;
      }
      reject(new Error('empty_image_source'));
    });

    try {
      const [outerImg, innerImg] = await Promise.all([
        loadImg(oData, oUrl),
        loadImg(iData, iUrl),
      ]);

      const SIZE = 320;
      const HALF = SIZE / 2;

      // 计算图像真实非空白包围盒中心（防止 PNG 透明边距不对称导致裁剪偏心）
      const findOpaqueCircleCenter = (img) => {
        const w = img.naturalWidth || SIZE;
        const h = img.naturalHeight || SIZE;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let minX = w; let maxX = -1; let minY = h; let maxY = -1;
        let hasAlphaHole = false;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const a = data[(y * w + x) * 4 + 3];
            if (a < 250) hasAlphaHole = true;
            if (a > 24) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (hasAlphaHole && maxX > minX + 10 && maxY > minY + 10) {
          return {
            cx: (minX + maxX + 1) / 2,
            cy: (minY + maxY + 1) / 2,
            span: Math.max(maxX - minX + 1, maxY - minY + 1),
            w,
            h,
          };
        }
        return { cx: w / 2, cy: h / 2, span: Math.max(w, h), w, h };
      };

      const oBox = findOpaqueCircleCenter(outerImg);
      const iBox = findOpaqueCircleCenter(innerImg);

      // 外图居中偏移补偿（使外圆质心严格落在 HALF, HALF）
      const oScale = SIZE / (outerImg.naturalWidth || SIZE);
      const oShiftX = HALF - oBox.cx * oScale;
      const oShiftY = HALF - oBox.cy * oScale;

      const cOuter = document.createElement('canvas');
      cOuter.width = SIZE;
      cOuter.height = SIZE;
      const ctxOuter = cOuter.getContext('2d', { willReadFrequently: true });
      ctxOuter.clearRect(0, 0, SIZE, SIZE);
      ctxOuter.drawImage(outerImg, oShiftX, oShiftY, SIZE, SIZE);
      const outerPixels = ctxOuter.getImageData(0, 0, SIZE, SIZE).data;

      // 计算内图相对于外图的绘制尺寸：
      // 1) 若页面 DOM 上内外图尺寸有显著比例（如内圆 128px / 外圆 210px），按 DOM 比例居中绘制；
      // 2) 否则若 naturalWidth 有显著比例，按 naturalWidth 比例；
      // 3) 若两张都是同尺寸透明底图，则 1:1 绘制（再结合中心探测微调）。
      const natRatio = (outerImg.naturalWidth > 0 && innerImg.naturalWidth > 0)
        ? (innerImg.naturalWidth / outerImg.naturalWidth)
        : 1;
      const scaleRatio = (domRatio > 0.25 && domRatio < 0.96)
        ? domRatio
        : ((natRatio > 0.25 && natRatio < 0.96) ? natRatio : 1);

      const innerDrawSize = SIZE * scaleRatio;
      const iScale = innerDrawSize / (innerImg.naturalWidth || SIZE);
      const innerOffsetX = HALF - iBox.cx * iScale;
      const innerOffsetY = HALF - iBox.cy * iScale;

      const cInner = document.createElement('canvas');
      cInner.width = SIZE;
      cInner.height = SIZE;
      const ctxInner = cInner.getContext('2d', { willReadFrequently: true });
      ctxInner.clearRect(0, 0, SIZE, SIZE);
      ctxInner.drawImage(innerImg, innerOffsetX, innerOffsetY, innerDrawSize, innerDrawSize);
      const innerPixels = ctxInner.getImageData(0, 0, SIZE, SIZE).data;

      // 双线性插值读取像素 (R, G, B, A, 灰度 L)
      const samplePixel = (data, x, y) => {
        const x0 = Math.max(0, Math.min(SIZE - 1, Math.floor(x)));
        const y0 = Math.max(0, Math.min(SIZE - 1, Math.floor(y)));
        const x1 = Math.min(SIZE - 1, x0 + 1);
        const y1 = Math.min(SIZE - 1, y0 + 1);
        const fx = x - x0;
        const fy = y - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const i00 = (y0 * SIZE + x0) * 4;
        const i10 = (y0 * SIZE + x1) * 4;
        const i01 = (y1 * SIZE + x0) * 4;
        const i11 = (y1 * SIZE + x1) * 4;
        const r = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
        const g = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
        const b = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
        const a = data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11;
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        return { r, g, b, a, l };
      };

      // 自动探测同心圆交界半径（同时独立探测内圆外沿 R_in 与外环内孔 R_out，彻底规避 DOM/CSS 边框误差导致的采样半径偏离）
      const detectSeamRadii = () => {
        const dirs = 48;
        const inRadii = [];
        const outRadii = [];
        const maxSearchR = Math.min(HALF - 5, Math.round(SIZE * 0.48));
        const minSearchR = Math.max(24, Math.round(SIZE * 0.14));

        for (let d = 0; d < dirs; d += 1) {
          const rad = (d * 2 * Math.PI) / dirs;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);

          // 1) 探测内圆外边界：从大到小找首个不透明像素（alpha > 180 且外侧 3px 透明）
          let rIn = 0;
          for (let r = Math.min(maxSearchR, Math.round(innerDrawSize / 2) + 8); r >= minSearchR; r -= 1) {
            const pIn = samplePixel(innerPixels, HALF + r * cos, HALF + r * sin);
            const pOut = samplePixel(innerPixels, HALF + (r + 3) * cos, HALF + (r + 3) * sin);
            if (pIn.a > 190 && pOut.a < 80) {
              rIn = r;
              break;
            }
          }
          if (rIn >= minSearchR) inRadii.push(rIn);

          // 2) 探测外环内孔边界：从小到大找首个从透明跳变为不透明的半径
          let rOut = 0;
          for (let r = minSearchR; r <= maxSearchR; r += 1) {
            const pHole = samplePixel(outerPixels, HALF + (r - 3) * cos, HALF + (r - 3) * sin);
            const pRing = samplePixel(outerPixels, HALF + (r + 2) * cos, HALF + (r + 2) * sin);
            if (pHole.a < 80 && pRing.a > 190) {
              rOut = r;
              break;
            }
          }
          if (rOut >= minSearchR) outRadii.push(rOut);
        }

        const median = (arr) => {
          if (!arr.length) return 0;
          const s = [...arr].sort((a, b) => a - b);
          return s[Math.floor(s.length / 2)];
        };

        let rInFinal = inRadii.length >= 10 ? median(inRadii) : 0;
        let rOutFinal = outRadii.length >= 10 ? median(outRadii) : 0;

        // 若内图无 alpha 透明边（例如被 CSS border-radius: 50% 裁圆的方形图）：内半径 = innerDrawSize / 2
        if (!rInFinal) {
          rInFinal = scaleRatio < 0.95 ? Math.round(innerDrawSize / 2) : Math.round(SIZE * 0.305);
        }
        // 若外环无中心透明孔（极少见）：取与内圆同半径
        if (!rOutFinal) {
          rOutFinal = rInFinal;
        }
        return { rIn: rInFinal, rOut: rOutFinal };
      };

      const { rIn: seamInR, rOut: seamOutR } = detectSeamRadii();
      const seamR = Math.round((seamInR + seamOutR) * 0.5);

      // 分别在内圆真实外沿内侧（seamInR - δ）与外环真实内孔外侧（seamOutR + δ）采样，
      // 避开交界 2px 的抗锯齿混合像素，且彻底消除两张图存在微弱尺寸/padding 差异时的径向错位！
      const innerBands = [Math.max(14, seamInR - 2.0), Math.max(13, seamInR - 3.6), Math.max(12, seamInR - 5.4), Math.max(11, seamInR - 7.5)];
      const outerBands = [Math.min(HALF - 4, seamOutR + 2.0), Math.min(HALF - 3, seamOutR + 3.6), Math.min(HALF - 2, seamOutR + 5.4), Math.min(HALF - 1, seamOutR + 7.5)];
      const bandWeights = [0.42, 0.28, 0.18, 0.12];

      const STEPS = 720; // 0.5° 分辨率
      const inR = new Float32Array(STEPS);
      const inG = new Float32Array(STEPS);
      const inB = new Float32Array(STEPS);
      const inL = new Float32Array(STEPS);

      const outR = new Float32Array(STEPS);
      const outG = new Float32Array(STEPS);
      const outB = new Float32Array(STEPS);
      const outL = new Float32Array(STEPS);

      for (let i = 0; i < STEPS; i += 1) {
        const theta = (i * 2 * Math.PI) / STEPS;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);

        let ir = 0; let ig = 0; let ib = 0; let il = 0;
        let or = 0; let og = 0; let ob = 0; let ol = 0;
        for (let b = 0; b < innerBands.length; b += 1) {
          const w = bandWeights[b];
          const pi = samplePixel(innerPixels, HALF + innerBands[b] * cos, HALF + innerBands[b] * sin);
          const po = samplePixel(outerPixels, HALF + outerBands[b] * cos, HALF + outerBands[b] * sin);
          ir += pi.r * w; ig += pi.g * w; ib += pi.b * w; il += pi.l * w;
          or += po.r * w; og += po.g * w; ob += po.b * w; ol += po.l * w;
        }
        inR[i] = ir; inG[i] = ig; inB[i] = ib; inL[i] = il;
        outR[i] = or; outG[i] = og; outB[i] = ob; outL[i] = ol;
      }

      // 局部均值滤波平滑采样序列，抑制 JPEG 块效应与单像素噪点，再计算环向切线梯度
      const smoothCircular = (arr) => {
        const out = new Float32Array(STEPS);
        for (let i = 0; i < STEPS; i += 1) {
          const p = (i - 1 + STEPS) % STEPS;
          const n = (i + 1) % STEPS;
          out[i] = arr[p] * 0.25 + arr[i] * 0.5 + arr[n] * 0.25;
        }
        return out;
      };
      const sInR = smoothCircular(inR);
      const sInG = smoothCircular(inG);
      const sInB = smoothCircular(inB);
      const sInL = smoothCircular(inL);
      const sOutR = smoothCircular(outR);
      const sOutG = smoothCircular(outG);
      const sOutB = smoothCircular(outB);
      const sOutL = smoothCircular(outL);

      // 计算环向切线梯度（三通道合并 + 亮度，抗内外环整体亮度偏移及彩色纯色边缘）
      const inGrad = new Float32Array(STEPS);
      const outGrad = new Float32Array(STEPS);
      const inGradR = new Float32Array(STEPS);
      const outGradR = new Float32Array(STEPS);
      const inGradG = new Float32Array(STEPS);
      const outGradG = new Float32Array(STEPS);
      const inGradB = new Float32Array(STEPS);
      const outGradB = new Float32Array(STEPS);
      let inGradNorm = 0;
      let outGradNorm = 0;

      for (let i = 0; i < STEPS; i += 1) {
        const prev = (i - 2 + STEPS) % STEPS;
        const next = (i + 2) % STEPS;
        const ig = (sInL[next] - sInL[prev]) * 0.5;
        const og = (sOutL[next] - sOutL[prev]) * 0.5;
        inGrad[i] = ig;
        outGrad[i] = og;
        inGradR[i] = (sInR[next] - sInR[prev]) * 0.5;
        outGradR[i] = (sOutR[next] - sOutR[prev]) * 0.5;
        inGradG[i] = (sInG[next] - sInG[prev]) * 0.5;
        outGradG[i] = (sOutG[next] - sOutG[prev]) * 0.5;
        inGradB[i] = (sInB[next] - sInB[prev]) * 0.5;
        outGradB[i] = (sOutB[next] - sOutB[prev]) * 0.5;
        inGradNorm += ig * ig;
        outGradNorm += og * og;
      }
      const gradDenom = Math.sqrt(inGradNorm * outGradNorm) || 1;

      // 去均值颜色序列（用于亮度 + RGB 三通道独立 ZNCC，避免同亮度不同颜色的色块误匹配）
      let meanInL = 0; let meanOutL = 0;
      let meanInR = 0; let meanOutR = 0;
      let meanInG = 0; let meanOutG = 0;
      let meanInB = 0; let meanOutB = 0;
      for (let i = 0; i < STEPS; i += 1) {
        meanInL += sInL[i]; meanOutL += sOutL[i];
        meanInR += sInR[i]; meanOutR += sOutR[i];
        meanInG += sInG[i]; meanOutG += sOutG[i];
        meanInB += sInB[i]; meanOutB += sOutB[i];
      }
      meanInL /= STEPS; meanOutL /= STEPS;
      meanInR /= STEPS; meanOutR /= STEPS;
      meanInG /= STEPS; meanOutG /= STEPS;
      meanInB /= STEPS; meanOutB /= STEPS;

      let varInL = 0; let varOutL = 0;
      let varInRgb = 0; let varOutRgb = 0;
      for (let i = 0; i < STEPS; i += 1) {
        const di = sInL[i] - meanInL;
        const do0 = sOutL[i] - meanOutL;
        varInL += di * di;
        varOutL += do0 * do0;
        const dir = sInR[i] - meanInR; const dig = sInG[i] - meanInG; const dib = sInB[i] - meanInB;
        const dor = sOutR[i] - meanOutR; const dog = sOutG[i] - meanOutG; const dob = sOutB[i] - meanOutB;
        varInRgb += dir * dir + dig * dig + dib * dib;
        varOutRgb += dor * dor + dog * dog + dob * dob;
      }
      const lumaDenom = Math.sqrt(varInL * varOutL) || 1;
      const rgbDenom = Math.sqrt(varInRgb * varOutRgb) || 1;

      // 遍历全部旋转步长 s ∈ [0, STEPS)
      // 定义：当内圆顺时针旋转 angleDeg (= s * 0.5°) 时，原先在 (i - s) 处的内圆像素转到了位置 i，与外环位置 i 对齐
      const scores = new Float32Array(STEPS);
      let minSad = Infinity;
      let maxSad = -Infinity;
      const sadArr = new Float32Array(STEPS);
      const nccArr = new Float32Array(STEPS);

      for (let s = 0; s < STEPS; s += 1) {
        let sadSum = 0;
        let gradDot = 0;
        let lumaDot = 0;
        let rgbDot = 0;

        for (let i = 0; i < STEPS; i += 1) {
          const j = (i - s + STEPS) % STEPS;
          const dr = Math.abs(sOutR[i] - sInR[j]);
          const dg = Math.abs(sOutG[i] - sInG[j]);
          const db = Math.abs(sOutB[i] - sInB[j]);
          const dgrad = Math.abs(outGrad[i] - inGrad[j])
            + 0.35 * (Math.abs(outGradR[i] - inGradR[j]) + Math.abs(outGradG[i] - inGradG[j]) + Math.abs(outGradB[i] - inGradB[j]));
          // 使用平方根阻尼抑制个别坏点/压缩毛刺，同时保留边缘匹配敏感度
          sadSum += (dr + dg + db) * 0.3333 + dgrad * 0.72;

          gradDot += outGrad[i] * inGrad[j];
          lumaDot += (sOutL[i] - meanOutL) * (sInL[j] - meanInL);
          rgbDot += (sOutR[i] - meanOutR) * (sInR[j] - meanInR)
            + (sOutG[i] - meanOutG) * (sInG[j] - meanInG)
            + (sOutB[i] - meanOutB) * (sInB[j] - meanInB);
        }

        const sad = sadSum / STEPS;
        sadArr[s] = sad;
        if (sad < minSad) minSad = sad;
        if (sad > maxSad) maxSad = sad;

        const gradNcc = gradDot / gradDenom;
        const lumaNcc = lumaDot / lumaDenom;
        const rgbNcc = rgbDot / rgbDenom;
        nccArr[s] = gradNcc * 0.45 + rgbNcc * 0.35 + lumaNcc * 0.20;
      }

      const sadSpan = Math.max(1e-5, maxSad - minSad);
      let bestStep = 0;
      let bestScore = -Infinity;

      // 跳过极小角度（< 8° 或 > 352°），因为旋转验证码初始偏角永远不会几乎对齐
      const minValidStep = Math.round(8 * (STEPS / 360));
      const maxValidStep = STEPS - minValidStep;

      for (let s = 0; s < STEPS; s += 1) {
        const normSadScore = 1 - (sadArr[s] - minSad) / sadSpan; // 越大越好 [0, 1]
        const combined = normSadScore * 0.52 + nccArr[s] * 0.48;
        scores[s] = combined;
        if (s >= minValidStep && s <= maxValidStep && combined > bestScore) {
          bestScore = combined;
          bestStep = s;
        }
      }

      // 寻找距离主峰 >= 20° 的次优峰（用于衡量置信度并在极少数对称纹理下作备选）
      let secondStep = bestStep;
      let secondScore = -Infinity;
      const minPeakSep = Math.round(20 * (STEPS / 360));
      for (let s = minValidStep; s <= maxValidStep; s += 1) {
        const dist = Math.min(Math.abs(s - bestStep), STEPS - Math.abs(s - bestStep));
        if (dist >= minPeakSep && scores[s] > secondScore) {
          secondScore = scores[s];
          secondStep = s;
        }
      }

      // 从高分候选峰中做局部二次精化验证：在主峰 ±2°（±4步）内微调寻优
      const refinePeak = (centerStep) => {
        let bStep = centerStep;
        let bScore = -Infinity;
        for (let off = -4; off <= 4; off += 1) {
          const idx = (centerStep + off + STEPS) % STEPS;
          if (idx >= minValidStep && idx <= maxValidStep && scores[idx] > bScore) {
            bScore = scores[idx];
            bStep = idx;
          }
        }
        return { step: bStep, score: bScore };
      };

      const p1 = refinePeak(bestStep);
      bestStep = p1.step;
      bestScore = p1.score;

      // 抛物线三点亚像素插值精化角度
      const sPrev = scores[(bestStep - 1 + STEPS) % STEPS];
      const sCurr = scores[bestStep];
      const sNext = scores[(bestStep + 1) % STEPS];
      const denom = 2 * (sPrev - 2 * sCurr + sNext);
      const delta = Math.abs(denom) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (sPrev - sNext) / denom)) : 0;

      const exactAngle = (((bestStep + delta) * 360) / STEPS + 360) % 360;
      const secondAngle = ((secondStep * 360) / STEPS + 360) % 360;
      const confidence = Math.max(0, Math.min(1, (bestScore - secondScore) * 2.5 + 0.5));

      return {
        ok: true,
        angle: Number(exactAngle.toFixed(2)),
        secondAngle: Number(secondAngle.toFixed(2)),
        confidence: Number(confidence.toFixed(3)),
        seamRadius: seamR,
        seamInR,
        seamOutR,
        elapsedMs: Math.round(performance.now() - t0),
      };
    } catch (err) {
      return {
        ok: false,
        angle: 0,
        confidence: 0,
        error: `本地 Canvas 极坐标算法异常: ${err?.message || err}`,
      };
    }
  }, {
    outerDataUrl,
    innerDataUrl,
    outerSrc,
    innerSrc,
    displayRatio,
  }).catch((err) => ({
    ok: false,
    angle: 0,
    confidence: 0,
    error: `本地 Canvas 执行失败: ${err?.message || err}`,
  }));
}

/**
 * 动态标定或按角度拖动旋转验证码滑块：
 * - 在开始滑动时实时读取内外图 CSS transform rotate(deg) 的变化率（deg/px），
 *   无论当前 TikTok 弹窗采用「单向 360°」还是「内外环反向各转 180°（合速 360°）」，
 *   都能在一次滑动过程中实时闭环校准终点位置！
 */
async function dragSliderWithAngularCalibration(page, target, info, targetAngleDeg) {
  const handleRect = info.handleRect;
  const maxSlide = Math.max(100, Number(info.maxSlideDistance) || 260);
  const startX = handleRect.x + handleRect.width / 2 + (Math.random() * 3 - 1.5);
  const startY = handleRect.y + handleRect.height / 2 + (Math.random() * 3 - 1.5);

  const readRelativeRotationDeg = async () => {
    if (!target) return null;
    return target.evaluate(({ oSrc, iSrc }) => {
      const parseOwnDeg = (el) => {
        if (!el) return null;
        const inlineTf = String(el.style?.transform || '');
        const mInline = inlineTf.match(/rotate\(([-\d.]+)deg\)/i);
        if (mInline) return Number(mInline[1]) || 0;
        const st = window.getComputedStyle?.(el);
        const tf = String(st?.transform || '');
        if (!tf || tf === 'none') return null;
        const m = tf.match(/matrix\(([^)]+)\)/i);
        if (!m) return null;
        const parts = m[1].split(',').map((v) => Number(v.trim()));
        if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
          if (Math.abs(parts[0] - 1) < 1e-4 && Math.abs(parts[1]) < 1e-4) return null;
          let deg = Math.atan2(parts[1], parts[0]) * (180 / Math.PI);
          if (deg < 0) deg += 360;
          return deg;
        }
        return null;
      };
      const parseDeg = (el) => {
        let cur = el;
        for (let d = 0; d < 3 && cur && cur !== document.body; d += 1) {
          const v = parseOwnDeg(cur);
          if (v !== null) return v;
          cur = cur.parentElement;
        }
        return 0;
      };
      const imgs = Array.from(document.querySelectorAll('img'));
      const outer = imgs.find((im) => (im.currentSrc || im.src) === oSrc)
        || document.querySelector('[data-e2e="captcha-whirl-outer"], img[class*="whirl-outer" i]');
      const inner = imgs.find((im) => (im.currentSrc || im.src) === iSrc)
        || document.querySelector('[data-e2e="captcha-whirl-inner"], img[class*="whirl-inner" i]');
      if (!outer && !inner) return null;
      const degIn = parseDeg(inner);
      const degOut = parseDeg(outer);
      return ((degIn - degOut) % 360 + 360) % 360;
    }, { oSrc: info.outerSrc || '', iSrc: info.innerSrc || '' }).catch(() => null);
  };

  // 默认按滑轨满程 = 360° 相对旋转估算初始目标距离
  let distancePx = Math.max(4, Math.min(maxSlide, (targetAngleDeg / 360) * maxSlide));

  await page.mouse.move(startX, startY, { steps: 6 });
  await sleep(75 + Math.floor(Math.random() * 80));
  await page.mouse.down();
  await sleep(55 + Math.floor(Math.random() * 65));

      // 自动探测旋转方向：极短试探性滑动后读取 DOM 中内圆与外环真实的增量旋转方向，
      // 防止少数新弹窗出现反向旋转导致角度互补（360 - θ）失败，同时精确标定角速度 deg/px
      const initRel = await readRelativeRotationDeg();
      const probePx = Math.min(28, Math.max(14, distancePx * 0.35));
      const probeSteps = 6;
      for (let i = 1; i <= probeSteps; i += 1) {
        const p = i / probeSteps;
        await page.mouse.move(
          startX + probePx * p,
          startY + (Math.random() * 1.6 - 0.8)
        );
        await sleep(10);
      }
      await sleep(35);

      const measuredDegRaw = await readRelativeRotationDeg();
      let effectiveTargetDeg = targetAngleDeg;
      if (measuredDegRaw != null && probePx >= 12) {
        let deltaDeg = initRel != null ? (measuredDegRaw - initRel) : measuredDegRaw;
        // 规范化到 [-180, 180]
        if (deltaDeg > 180) deltaDeg -= 360;
        if (deltaDeg < -180) deltaDeg += 360;
        // 若向右拖动滑块时相对角度是逆时针减小的（deltaDeg < -2°），说明需要对齐的角度应取互补角 (360 - targetAngleDeg)
        if (deltaDeg < -2.5) {
          effectiveTargetDeg = (360 - targetAngleDeg) % 360;
        }
        const absDelta = Math.abs(deltaDeg);
        if (absDelta > 2.5 && absDelta < 160) {
          const degPerPx = absDelta / probePx;
          if (degPerPx > 0.35 && degPerPx < 4.5) {
            distancePx = Math.max(4, Math.min(maxSlide, effectiveTargetDeg / degPerPx));
          }
        }
      }

      const remainingPx = distancePx - probePx;
      const steps = Math.max(14, Math.min(40, Math.round(Math.abs(remainingPx) / 4)));
      const overshoot = distancePx > 28 && distancePx < maxSlide - 6 ? (Math.random() * 2.6 + 1.0) : 0;

      for (let i = 1; i <= steps; i += 1) {
        const progress = i / steps;
        const eased = 1 - Math.pow(1 - progress, 3);
        const curX = startX + probePx + (remainingPx + overshoot) * eased;
        const curY = startY + Math.sin(progress * Math.PI) * (Math.random() * 2.2 - 1.1);
        await page.mouse.move(curX, curY);
        await sleep(8 + Math.floor(Math.random() * 12));
      }

      const targetX = startX + distancePx;
      if (overshoot > 0) {
        await sleep(65 + Math.floor(Math.random() * 55));
        await page.mouse.move(targetX, startY + (Math.random() * 1.4 - 0.7), { steps: 4 });
      }

      // 松手前做闭环微调校准（最多 2 轮，确保实际旋转角度与目标角度偏差 < 0.9°）
      for (let fineRound = 0; fineRound < 2; fineRound += 1) {
        const curRel = await readRelativeRotationDeg();
        if (curRel == null || distancePx <= 10) break;
        let actualMoved = initRel != null ? (curRel - initRel) : curRel;
        actualMoved = ((actualMoved % 360) + 360) % 360;
        // 如果之前探测为反向，实际累积变化量用反方向衡量
        if (effectiveTargetDeg !== targetAngleDeg) {
          actualMoved = (360 - actualMoved) % 360;
        }
        const desiredMoved = effectiveTargetDeg !== targetAngleDeg ? effectiveTargetDeg : targetAngleDeg;
        let errDeg = desiredMoved - actualMoved;
        if (errDeg > 180) errDeg -= 360;
        if (errDeg < -180) errDeg += 360;
        if (Math.abs(errDeg) < 0.9 || Math.abs(errDeg) > 45) break;
        const degPerPx = actualMoved > 3 ? (actualMoved / distancePx) : (360 / maxSlide);
        if (degPerPx > 0.35 && degPerPx < 4.5) {
          distancePx = Math.max(4, Math.min(maxSlide, distancePx + errDeg / degPerPx));
          await page.mouse.move(startX + distancePx, startY, { steps: 3 });
          await sleep(40);
        } else {
          break;
        }
      }

  await sleep(85 + Math.floor(Math.random() * 95));
  await page.mouse.up();
  return distancePx;
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
  const overshoot = distancePx > 25 ? (Math.random() * 3 + 1.2) : 0;

  for (let i = 1; i <= steps; i += 1) {
    const progress = i / steps;
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
 * 点击验证码弹框中的「刷新」按钮，用于在图片加载卡死或单次拖动后未自动换图时刷新验证码。
 */
async function clickCaptchaRefresh(target) {
  if (!target) return false;
  return target.evaluate(() => {
    const selectors = [
      '#captcha_refresh_button',
      '.secsdk_captcha_refresh',
      '[id*="captcha_refresh" i]',
      '[class*="secsdk_captcha_refresh" i]',
      '[class*="captcha" i] [class*="refresh" i]',
      '[class*="cap-" i] [class*="refresh" i]',
      'button[aria-label*="refresh" i]',
      'button[aria-label*="刷新" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') {
        el.click();
        return true;
      }
    }
    const scopes = Array.from(document.querySelectorAll(
      '#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="secsdk" i], .TUXModal, [role="dialog"]'
    ));
    for (const scope of scopes) {
      const btns = Array.from(scope.querySelectorAll('button, [role="button"], a'));
      const hit = btns.find((b) => {
        const txt = String(b.innerText || b.getAttribute('aria-label') || '').trim();
        return /^(Refresh|Try again|Retry|Reload|刷新|重试)$/i.test(txt);
      });
      if (hit && typeof hit.click === 'function') {
        hit.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

/**
 * 在 Page（含子 Frame）中定位旋转验证码详情。
 */
async function detectRotateCaptcha(page) {
  if (!page || page.isClosed?.()) return { detected: false };
  const targets = [page, ...(page.frames?.() || []).filter((f) => f !== page.mainFrame?.())];
  let anyLoading = false;
  let loadingTarget = null;
  for (const target of targets) {
    const info = await inspectRotateCaptchaInContext(target);
    if (info?.detected) {
      let offsetX = 0;
      let offsetY = 0;
      if (target !== page && typeof target.frameElement === 'function') {
        try {
          const frameEl = await target.frameElement();
          await frameEl?.scrollIntoViewIfNeeded?.().catch(() => {});
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
    if (info?.loading) {
      anyLoading = true;
      loadingTarget = target;
    }
  }
  return anyLoading ? { detected: false, loading: true, target: loadingTarget || page } : { detected: false };
}

/**
 * 检测并自动使用「本地 Canvas 极坐标交界像素匹配算法」（零成本、毫秒级）解决 TikTok 旋转图片验证。
 */
async function solveRotateCaptchaIfPresent(page, {
  accountId = 0,
  maxAttempts = 4,
  apiKey = '',
  log = null,
} = {}) {
  if (!page || page.isClosed?.()) return { detected: false, solved: false, attempts: 0 };

  if (page.__tkNoCaptchaSolving) {
    return page.__tkNoCaptchaSolving;
  }

  const effectiveAccountId = Number(accountId || page.__tkAccountId || 0);
  if (effectiveAccountId && !page.__tkAccountId) {
    page.__tkAccountId = effectiveAccountId;
  }

  const say = (msg, level = 'info') => {
    if (typeof log === 'function') {
      try { log(msg, level); } catch { /* ignore */ }
    }
    liveLog(
      `[旋转验证${effectiveAccountId ? `#${effectiveAccountId}` : ''}] ${msg}`,
      level,
      effectiveAccountId ? { accountId: effectiveAccountId } : {}
    );
  };

  const runner = (async () => {
    let firstCheck = await detectRotateCaptcha(page);
    if (!firstCheck.detected && !firstCheck.loading) {
      return { detected: false, solved: false, attempts: 0 };
    }

    let pausedSaveTraffic = false;
    try {
      const { pauseSaveTrafficForCaptcha } = require('./save-traffic');
      await pauseSaveTrafficForCaptcha(page);
      pausedSaveTraffic = true;
    } catch { /* ignore */ }

    if (!firstCheck.detected && firstCheck.loading) {
      let refreshedWhileLoading = false;
      if (firstCheck.failedLoad) {
        refreshedWhileLoading = true;
        await clickCaptchaRefresh(firstCheck.target || page).catch(() => {});
        await sleep(650);
      }
      const loadWaitStart = Date.now();
      const loadWaitEnd = loadWaitStart + 10000;
      while (Date.now() < loadWaitEnd) {
        await sleep(450);
        firstCheck = await detectRotateCaptcha(page);
        if (firstCheck.detected || !firstCheck.loading) break;
        if ((!refreshedWhileLoading && Date.now() - loadWaitStart > 3200) || (firstCheck.failedLoad && !refreshedWhileLoading)) {
          refreshedWhileLoading = true;
          await clickCaptchaRefresh(firstCheck.target || page).catch(() => {});
        }
      }
      if (!firstCheck.detected) {
        if (pausedSaveTraffic) {
          try {
            const { resumeSaveTrafficAfterCaptcha } = require('./save-traffic');
            await resumeSaveTrafficAfterCaptcha(page);
          } catch { /* ignore */ }
        }
        return { detected: false, solved: false, attempts: 0 };
      }
    }

    let lastError = '';
    let lastAngle = 0;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let info = attempt === 1 ? firstCheck : await detectRotateCaptcha(page);
        if (!info.detected && info.loading) {
          let refreshedMid = false;
          const waitImgStart = Date.now();
          const waitImgEnd = waitImgStart + 7000;
          while (Date.now() < waitImgEnd) {
            await sleep(400);
            info = await detectRotateCaptcha(page);
            if (info.detected || !info.loading) break;
            if (!refreshedMid && Date.now() - waitImgStart > 2800) {
              refreshedMid = true;
              await clickCaptchaRefresh(info.target || page).catch(() => {});
            }
          }
        }
        if (!info.detected) {
          page.__tkNoCaptchaLastSolvedAt = Date.now();
          say('旋转图片验证已消失，验证通过');
          return { detected: true, solved: true, attempts: attempt - 1, lastAngle };
        }

        say(`检测到旋转图片验证（第 ${attempt}/${maxAttempts} 次），正在执行本地 Canvas 极坐标像素匹配…`);

        await sleep(350);
        const outerBase64 = await fetchImageAsBase64(info.target || page, info.outerSrc, info.outerRect);
        const innerBase64 = await fetchImageAsBase64(info.target || page, info.innerSrc, info.innerRect);

        // 优先使用零成本、毫秒级的本地 Canvas 极坐标交界像素匹配算法
        let sol = await solveRotateAngleByLocalCanvas(info.target || page, {
          outerBase64,
          innerBase64,
          outerSrc: info.outerSrc,
          innerSrc: info.innerSrc,
          outerRect: info.outerRect,
          innerRect: info.innerRect,
        });

        // 仅当显式开启 TKSWARM_ENABLE_NOCAPTCHAAI_FALLBACK=1 且本地 Canvas 极端异常失败时才回退远程接口
        if (
          (!sol.ok || !Number.isFinite(sol.angle))
          && outerBase64
          && innerBase64
          && String(process.env.TKSWARM_ENABLE_NOCAPTCHAAI_FALLBACK || '0').trim() === '1'
        ) {
          const pageUrl = (() => {
            try { return page.url() || 'https://www.tiktok.com'; } catch { return 'https://www.tiktok.com'; }
          })();
          sol = await requestRotateSolution({
            outerBase64,
            innerBase64,
            websiteURL: pageUrl,
            apiKey,
          });
        }

        if (!sol.ok || !Number.isFinite(sol.angle)) {
          lastError = sol.error || '未能计算出有效旋转角度';
          say(`识别失败：${lastError}，点击刷新后重试`, 'warn');
          await clickCaptchaRefresh(info.target || page);
          await sleep(1100);
          continue;
        }

        const rawAngle = Number(sol.angle);
        const angle = ((rawAngle % 360) + 360) % 360;
        const prevAngle = lastAngle;
        lastAngle = angle;

        // 若页面上的图片初始状态非 0°（或上次拖动残留），计算相对目标还差的角度；
        // canvas.drawImage 仅绘制原始图像不含 CSS transform，故这里必须扣除当前 DOM 相对偏移
        const baseCssRelDeg = await (info.target || page).evaluate(({ oSrc, iSrc }) => {
          const parseOwnDeg = (el) => {
            if (!el) return null;
            const inlineTf = String(el.style?.transform || '');
            const mInline = inlineTf.match(/rotate\(([-\d.]+)deg\)/i);
            if (mInline) return Number(mInline[1]) || 0;
            const st = window.getComputedStyle?.(el);
            const tf = String(st?.transform || '');
            if (!tf || tf === 'none') return null;
            const m = tf.match(/matrix\(([^)]+)\)/i);
            if (!m) return null;
            const parts = m[1].split(',').map((v) => Number(v.trim()));
            if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
              if (Math.abs(parts[0] - 1) < 1e-4 && Math.abs(parts[1]) < 1e-4) return null;
              let deg = Math.atan2(parts[1], parts[0]) * (180 / Math.PI);
              if (deg < 0) deg += 360;
              return deg;
            }
            return null;
          };
          const parseDeg = (el) => {
            let cur = el;
            for (let d = 0; d < 3 && cur && cur !== document.body; d += 1) {
              const v = parseOwnDeg(cur);
              if (v !== null) return v;
              cur = cur.parentElement;
            }
            return 0;
          };
          const imgs = Array.from(document.querySelectorAll('img'));
          const outer = imgs.find((im) => (im.currentSrc || im.src) === oSrc)
            || document.querySelector('[data-e2e="captcha-whirl-outer"], img[class*="whirl-outer" i]');
          const inner = imgs.find((im) => (im.currentSrc || im.src) === iSrc)
            || document.querySelector('[data-e2e="captcha-whirl-inner"], img[class*="whirl-inner" i]');
          if (!outer && !inner) return 0;
          return ((parseDeg(inner) - parseDeg(outer)) % 360 + 360) % 360;
        }, { oSrc: info.outerSrc || '', iSrc: info.innerSrc || '' }).catch(() => 0);

        const effectiveAngle = ((angle - (Number(baseCssRelDeg) || 0)) % 360 + 360) % 360;

        // 若同一张图连续尝试未通过（prevAngle === angle）且存在有效次峰、且置信度不算极高，则偶数次改试次优角提高兜底命中率
        let chosenAngle = effectiveAngle > 3 ? effectiveAngle : angle;
        if (
          attempt >= 2
          && prevAngle === angle
          && sol.secondAngle != null
          && Number(sol.confidence ?? 1) < 0.85
          && Math.abs(((Number(sol.secondAngle) - angle + 540) % 360) - 180) > 15
          && attempt % 2 === 0
        ) {
          const altEff = ((Number(sol.secondAngle) - (Number(baseCssRelDeg) || 0)) % 360 + 360) % 360;
          chosenAngle = altEff > 3 ? altEff : Number(sol.secondAngle);
          say(`同图上次主峰未过(置信度=${Number(sol.confidence ?? 0).toFixed(2)})，尝试次优峰角度=${Number(sol.secondAngle).toFixed(1)}°`);
        }

        const usedDistancePx = await dragSliderWithAngularCalibration(
          page,
          info.target || page,
          info,
          chosenAngle
        );

        say(
          `本地极坐标匹配完成：角度=${angle.toFixed(1)}°（置信度=${Number(sol.confidence ?? 1).toFixed(2)}，耗时=${sol.elapsedMs ?? 0}ms，滑轨=${Math.round(info.maxSlideDistance)}px，拖动=${usedDistancePx.toFixed(1)}px）`
        );

        let imageChanged = false;
        const checkDeadline = Date.now() + 4800;
        while (Date.now() < checkDeadline) {
          await sleep(600);
          const after = await detectRotateCaptcha(page);
          if (!after.detected && !after.loading) {
            page.__tkNoCaptchaLastSolvedAt = Date.now();
            say(`旋转图片验证已通过（第 ${attempt} 次尝试）`);
            return { detected: true, solved: true, attempts: attempt, lastAngle };
          }
          if (after.outerSrc && info.outerSrc && after.outerSrc !== info.outerSrc) {
            imageChanged = true;
            break;
          }
        }

        const finalAfter = await detectRotateCaptcha(page);
        if (!finalAfter.detected && !finalAfter.loading) {
          page.__tkNoCaptchaLastSolvedAt = Date.now();
          say(`旋转图片验证已通过（第 ${attempt} 次尝试）`);
          return { detected: true, solved: true, attempts: attempt, lastAngle };
        }

        say(`第 ${attempt} 次拖动后旋转验证仍存在，准备换图重试…`, 'warn');
        if (!imageChanged && attempt < maxAttempts) {
          await clickCaptchaRefresh(info.target || page);
          await sleep(1000);
        } else {
          await sleep(800);
        }
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
 * 在任意任务执行期间，只要页面加载出 TikTok 旋转验证图片或弹出验证层，
 * 自动触发 solveRotateCaptchaIfPresent。
 */
function attachAutoRotateCaptchaWatcher(page, { accountId = 0, apiKey = '' } = {}) {
  if (!page || page.isClosed?.()) return;
  if (accountId) page.__tkAccountId = Number(accountId);
  if (apiKey) page.__tkNoCaptchaApiKey = String(apiKey);
  if (page.__tkNoCaptchaWatcherAttached) return;
  page.__tkNoCaptchaWatcherAttached = true;

  let debounceTimer = null;
  let retryTimer = null;
  const runSolve = async (isFollowUp = false) => {
    if (!page || page.isClosed?.() || page.__tkNoCaptchaSolving) return;
    try {
      const res = await solveRotateCaptchaIfPresent(page, {
        accountId: page.__tkAccountId || accountId,
        apiKey: page.__tkNoCaptchaApiKey || apiKey,
      });
      if (!isFollowUp && !res?.detected) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          runSolve(true).catch(() => {});
        }, 1500);
        retryTimer.unref?.();
      }
    } catch { /* ignore */ }
  };

  const triggerCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSolve(false).catch(() => {});
    }, 650);
    debounceTimer.unref?.();
  };

  const onResponse = (resp) => {
    try {
      const url = String(resp.url?.() || '');
      if (!url) return;
      const status = Number(resp.status?.() || 0);
      if (
        /captcha|verify[-_]?center|verification|secsdk|security[-_]?check|whirl|rotate[-_]?verify|rc[-_]?captcha|rc[-_]?verification|p\d+-(?:rc-)?cap|p\d+-security|get_captcha|verify_captcha/i.test(url)
        && (status === 0 || (status >= 200 && status < 400))
      ) {
        triggerCheck();
      }
    } catch { /* ignore */ }
  };

  const onFrameNav = (frame) => {
    try {
      const fUrl = String(frame?.url?.() || '');
      if (fUrl && /captcha|verify[-_]?center|verification|secsdk|whirl|rc[-_]?captcha|rc[-_]?verification/i.test(fUrl)) {
        triggerCheck();
      }
    } catch { /* ignore */ }
  };

  page.on?.('response', onResponse);
  page.on?.('framenavigated', onFrameNav);
  page.once?.('close', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    try { page.off?.('response', onResponse); } catch { /* ignore */ }
    try { page.off?.('framenavigated', onFrameNav); } catch { /* ignore */ }
  });
}

module.exports = {
  DEFAULT_API_KEY,
  QUOTA_LIMIT,
  getApiKey,
  resolveActiveApiKey,
  clearNocaptchaKeyCache,
  reportUsageToCenter,
  looksLikeQuotaExhausted,
  requestRotateSolution,
  solveRotateAngleByLocalCanvas,
  dragSliderWithAngularCalibration,
  detectRotateCaptcha,
  solveRotateCaptchaIfPresent,
  attachAutoRotateCaptchaWatcher,
};
