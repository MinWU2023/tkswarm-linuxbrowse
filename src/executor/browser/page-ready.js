/**
 * 慢网 / 高延迟代理下的页面就绪兜底。
 * 各任务导航后应等待「文档就绪 + 关键内容出现」，而不是仅靠 domcontentloaded。
 *
 * 环境变量：
 *   TKSWARM_SLOW_NET=1（默认开启）放大超时
 *   TKSWARM_PAGE_READY_FACTOR=1.5~3 超时倍率（默认 2）
 */
const { humanPause, sleep } = require('../human-pace');

function slowNetEnabled() {
  const v = String(process.env.TKSWARM_SLOW_NET || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function readyFactor() {
  if (!slowNetEnabled()) return 1;
  const n = Number(process.env.TKSWARM_PAGE_READY_FACTOR);
  if (Number.isFinite(n) && n >= 1 && n <= 4) return n;
  return 2;
}

/** 按慢网倍率放大毫秒数 */
function scaleTimeout(ms, floor = 5000) {
  const base = Math.max(0, Number(ms) || 0);
  return Math.max(floor, Math.round(base * readyFactor()));
}

/** 浏览器错误页 / 代理失败（不抛错，返回错误码或空串） */
async function detectProxyErrorPage(page) {
  if (!page || page.isClosed?.()) return '';
  try {
    const { detectBrowserNetworkError } = require('./tiktok-login');
    return (await detectBrowserNetworkError(page)) || '';
  } catch {
    return '';
  }
}

/**
 * 检测「整页变成原始 JSON / i18n 字典」的异常文档。
 * 常见于：深链搜索返回 application/json、JS 未启动、代理/风控改写了文档。
 * 这类页 innerText 很长，会骗过「body 有字就算就绪」的判断。
 */
async function detectRawDocumentPage(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    return await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = String(body.innerText || '').slice(0, 24000);
      if (text.length < 200) return false;

      // 正常 TikTok 壳
      const hasShell = !!(
        document.querySelector('#app [data-e2e], #root [data-e2e], [data-e2e="search-user-input"], [data-e2e="search-box"], form[action*="search"]')
        || document.querySelector('video, [data-e2e*="feed"], [data-e2e*="browse"], [data-e2e*="recommend"]')
      );

      const colonQuotes = (text.match(/"[^"\n]{2,96}"\s*:/g) || []).length;
      const looksJson = colonQuotes >= 10 && /[{,]\s*"/.test(text);
      const i18nKeyHits = (text.match(/"[a-zA-Z0-9]+_[a-zA-Z0-9_]+"/g) || []).length;
      const childCount = body.children ? body.children.length : 0;
      // 文档几乎无 DOM 结构、正文却是大段 "key": value → Chromium 直接渲染了 JSON
      const plainDump = childCount <= 4 && looksJson && text.length > 400;
      // 有点 DOM 但没有 TikTok 壳，且大量 i18n key
      const i18nDump = looksJson && i18nKeyHits >= 15 && !hasShell;

      // content-type 被当成纯文本时，常见只有一个 pre / 无结构
      const onlyPre = childCount <= 2 && !!body.querySelector('pre') && text.length > 400;

      return plainDump || i18nDump || (onlyPre && looksJson);
    });
  } catch {
    return false;
  }
}

/** 从最近一次导航响应判断是否拿到了非 HTML 文档 */
function responseLooksNonHtml(response) {
  if (!response) return false;
  try {
    const ct = String(response.headers?.()['content-type'] || response.headers?.()['Content-Type'] || '');
    if (!ct) return false;
    if (/text\/html|application\/xhtml/i.test(ct)) return false;
    return /application\/json|text\/plain|application\/javascript/i.test(ct);
  } catch {
    return false;
  }
}

/**
 * 中途出现代理/网络错误页时：退避后 reload（或重新 goto）再继续。
 * @returns {Promise<boolean>} 是否已尝试恢复（不保证成功）
 */
async function recoverProxyErrorPage(page, {
  url = '',
  attempts = 3,
  label = '代理恢复',
  log = null,
} = {}) {
  const say = (msg) => {
    if (typeof log === 'function') log(`${label}: ${msg}`);
  };
  let code = await detectProxyErrorPage(page);
  if (!code) return false;
  for (let i = 1; i <= attempts; i += 1) {
    say(`检测到 ${code}，第 ${i}/${attempts} 次恢复（高延迟代理常见抖动）`);
    await humanPause(1200 * i, 0.2);
    const target = String(url || '').trim() || (() => {
      try { return page.url() || ''; } catch { return ''; }
    })();
    if (target && !/^chrome-error:|^about:blank|data:/i.test(target) && !/ERR_/i.test(target)) {
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: scaleTimeout(90000, 60000),
      }).catch(() => {});
    } else {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: scaleTimeout(90000, 60000),
      }).catch(() => {});
    }
    await waitDocumentReady(page, 12000);
    await humanPause(1500, 0.2);
    code = await detectProxyErrorPage(page);
    if (!code) {
      say('恢复成功');
      return true;
    }
  }
  say(`仍失败：${code}`);
  return true;
}

async function waitDocumentReady(page, timeoutMs = 20000) {
  const budget = scaleTimeout(timeoutMs, 8000);
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (!page || page.isClosed?.()) return false;
    const state = await page.evaluate(() => document.readyState).catch(() => '');
    if (state === 'interactive' || state === 'complete') return true;
    await sleep(300);
  }
  return false;
}

/**
 * 轮询等待任意选择器出现（可见优先）。
 * @returns {Promise<boolean>}
 */
async function waitForAnySelector(page, selectors, {
  timeoutMs = 45000,
  visible = true,
  pollMs = 700,
  onTick = null,
  absolute = false,
} = {}) {
  const list = (Array.isArray(selectors) ? selectors : [selectors])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!page || !list.length) return false;
  const budget = absolute ? Math.max(1000, Number(timeoutMs) || 0) : scaleTimeout(timeoutMs, 12000);
  const end = Date.now() + budget;
  let tick = 0;
  while (Date.now() < end) {
    if (page.isClosed?.()) return false;
    for (const sel of list) {
      const loc = page.locator(sel).first();
      const n = await loc.count().catch(() => 0);
      if (n < 1) continue;
      if (!visible) return true;
      if (await loc.isVisible().catch(() => false)) return true;
    }
    tick += 1;
    if (typeof onTick === 'function') {
      try { await onTick(tick); } catch { /* ignore */ }
    }
    await humanPause(pollMs, 0.15);
  }
  return false;
}

/**
 * 等待页面主体「像样」：readyState + body 有一定内容长度，或命中关键选择器。
 * 用于 goto 后的通用兜底，避免慢代理刚到 URL 就判定失败。
 */
async function waitPageSettled(page, {
  timeoutMs = 30000,
  minBodyChars = 80,
  contentSelectors = [],
  reloadOnce = false,
  label = '页面加载',
  log = null,
  /** 传入已按慢网放大的绝对值时设 true，避免二次放大 */
  absolute = false,
} = {}) {
  if (!page || page.isClosed?.()) return false;
  const budget = absolute ? Math.max(8000, Number(timeoutMs) || 0) : scaleTimeout(timeoutMs, 15000);
  const say = (msg) => {
    if (typeof log === 'function') log(`${label}: ${msg}`);
  };

  const tryOnce = async (ms) => {
    await waitDocumentReady(page, Math.min(ms, 15000));
    const end = Date.now() + ms;
    let recovered = 0;
    let rawRecovered = 0;
    while (Date.now() < end) {
      if (page.isClosed?.()) return false;
      if (await detectProxyErrorPage(page)) {
        if (recovered >= 2) return false;
        recovered += 1;
        await recoverProxyErrorPage(page, { attempts: 2, label, log });
        continue;
      }
      // 检测到旋转图片验证时自动调用 NoCaptchaAI 解决
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        const capRes = await solveRotateCaptchaIfPresent(page, { log: say });
        if (capRes?.detected && !capRes?.solved) {
          await humanPause(800, 0.15);
          continue;
        }
      } catch { /* ignore */ }
      // 原始 JSON/i18n 乱码页：绝不当「有字即就绪」，尝试刷新一次
      if (await detectRawDocumentPage(page)) {
        if (rawRecovered >= 1) {
          say('仍是原始 JSON/乱码页，放弃本轮就绪');
          return false;
        }
        rawRecovered += 1;
        say('检测到原始 JSON/i18n 乱码页，刷新重试');
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: scaleTimeout(60000, 45000),
        }).catch(() => {});
        await waitDocumentReady(page, 12000);
        await humanPause(1200, 0.2);
        continue;
      }
      if (contentSelectors.length) {
        const hit = await waitForAnySelector(page, contentSelectors, {
          timeoutMs: Math.min(2500, end - Date.now()),
          pollMs: 500,
          absolute: true,
        });
        if (hit) return true;
      }
      const ok = await page.evaluate((minChars) => {
        const body = document.body;
        if (!body) return false;
        // 再挡一层：正文像 JSON 字典时不算就绪
        const text = String(body.innerText || '').replace(/\s+/g, ' ').trim();
        const colonQuotes = (text.match(/"[^"\n]{2,96}"\s*:/g) || []).length;
        if (colonQuotes >= 10 && text.length > 400
          && !document.querySelector('[data-e2e], video, form[action*="search"]')) {
          return false;
        }
        if (text.length >= minChars) return true;
        // 常见加载骨架：有 DOM 节点但文案很少，继续等
        const nodes = body.querySelectorAll('a, article, main, [data-e2e], video, img');
        return nodes.length >= 8 && text.length >= Math.max(20, Math.floor(minChars / 3));
      }, minBodyChars).catch(() => false);
      if (ok) return true;
      await humanPause(600, 0.15);
    }
    return false;
  };

  say(`等待就绪（最多约 ${Math.round(budget / 1000)}s，慢网倍率 ${readyFactor()}）`);
  let ok = await tryOnce(budget);
  if (ok) {
    say('已就绪');
    return true;
  }
  if (reloadOnce) {
    say('首轮未就绪，刷新重试');
    if (await detectProxyErrorPage(page)) {
      await recoverProxyErrorPage(page, { attempts: 2, label, log });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: scaleTimeout(60000, 45000) }).catch(() => {});
    }
    await humanPause(1500, 0.2);
    ok = await tryOnce(Math.round(budget * 0.85));
    if (ok) say('刷新后已就绪');
  }
  return ok;
}

/**
 * 等待搜索结果视频卡片；首轮失败则刷新再等一轮。
 * checkEmpty / countCards 由调用方注入，避免循环依赖。
 */
async function waitSearchContent(page, {
  timeoutMs = 60000,
  accountId = 0,
  countCards,
  isEmpty,
  isCaptcha,
  onCaptcha,
  reloadOnce = true,
  log = null,
  absolute = false,
} = {}) {
  const budget = absolute ? Math.max(15000, Number(timeoutMs) || 0) : scaleTimeout(timeoutMs, 45000);
  const say = (msg) => {
    if (typeof log === 'function') log(msg);
  };

  const poll = async (ms) => {
    const end = Date.now() + ms;
    let emptyStable = 0;
    let proxyRecovered = 0;
    let rawRecovered = 0;
    while (Date.now() < end) {
      if (page.isClosed?.()) return { ok: false, reason: 'closed' };
      if (await detectProxyErrorPage(page)) {
        if (proxyRecovered >= 3) return { ok: false, reason: 'proxy' };
        proxyRecovered += 1;
        await recoverProxyErrorPage(page, {
          attempts: 2,
          label: '搜索代理恢复',
          log,
        });
        continue;
      }
      if (await detectRawDocumentPage(page)) {
        if (rawRecovered >= 1) return { ok: false, reason: 'raw_json' };
        rawRecovered += 1;
        say('搜索页为原始 JSON/乱码，刷新后继续等');
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: scaleTimeout(75000, 50000),
        }).catch(() => {});
        await waitDocumentReady(page, 12000);
        await humanPause(1500, 0.2);
        continue;
      }
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        const rot = await solveRotateCaptchaIfPresent(page, { accountId, log: say });
        if (rot?.detected && rot?.solved) {
          await humanPause(1000, 0.15);
        }
      } catch { /* ignore */ }
      if (typeof isCaptcha === 'function' && await isCaptcha(page)) {
        // 省流会拦验证码图：一检测到人机验证就临时关闭省流
        try {
          const { pauseSaveTrafficForCaptcha } = require('./save-traffic');
          await pauseSaveTrafficForCaptcha(page);
        } catch { /* ignore */ }
        // 关闭省流后再尝试一次 NoCaptchaAI 旋转图片识别
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          const rot2 = await solveRotateCaptchaIfPresent(page, { accountId, log: say });
          if (rot2?.detected && rot2?.solved) {
            try {
              const { resumeSaveTrafficAfterCaptcha } = require('./save-traffic');
              await resumeSaveTrafficAfterCaptcha(page);
            } catch { /* ignore */ }
            await humanPause(1000, 0.15);
            continue;
          }
        } catch { /* ignore */ }
        if (typeof onCaptcha === 'function') {
          const cap = await onCaptcha(page, accountId, Math.min(120000, end - Date.now()));
          if (cap === 'timeout' || cap === 'need_manual') {
            return { ok: false, reason: 'captcha' };
          }
          try {
            const { resumeSaveTrafficAfterCaptcha } = require('./save-traffic');
            if (cap === 'cleared' || cap === 'absent') await resumeSaveTrafficAfterCaptcha(page);
          } catch { /* ignore */ }
        }
      }
      const n = typeof countCards === 'function' ? await countCards(page) : 0;
      if (n > 0) return { ok: true, reason: 'cards' };
      // 空态需连续确认，避免加载中误报
      if (typeof isEmpty === 'function' && await isEmpty(page)) {
        emptyStable += 1;
        if (emptyStable >= 3) return { ok: false, reason: 'empty' };
      } else {
        emptyStable = 0;
      }
      await page.mouse.wheel(0, 450).catch(() => {});
      await humanPause(800, 0.2);
    }
    const n2 = typeof countCards === 'function' ? await countCards(page) : 0;
    return n2 > 0 ? { ok: true, reason: 'cards' } : { ok: false, reason: 'timeout' };
  };

  await waitDocumentReady(page, 12000);
  say(`等待搜索结果（约 ${Math.round(budget / 1000)}s）`);
  let result = await poll(budget);
  if (result.ok || result.reason === 'empty' || result.reason === 'captcha') {
    return result;
  }
  if (reloadOnce) {
    say('搜索结果未出，刷新后继续等');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: scaleTimeout(75000, 50000) }).catch(() => {});
    await humanPause(2000, 0.2);
    result = await poll(Math.round(budget * 0.9));
  }
  return result;
}

module.exports = {
  slowNetEnabled,
  readyFactor,
  scaleTimeout,
  waitDocumentReady,
  waitForAnySelector,
  waitPageSettled,
  waitSearchContent,
  detectProxyErrorPage,
  recoverProxyErrorPage,
  detectRawDocumentPage,
  responseLooksNonHtml,
};
