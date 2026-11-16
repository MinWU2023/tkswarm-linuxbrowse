/**
 * TikTok Cookie 政策弹窗（.tiktok-cookie-banner）统一处理。
 * 与 tkswarm-node/src/services/browser/cookie-consent.js 保持一致，改动需同步。
 *
 * 弹窗是页面打开后过一会儿才异步渲染出来的，所以不能只在个别步骤里检查，
 * 而是随连接挂一个常驻巡检器：只要页面还开着就持续看，出现就点「全部允许」。
 *
 * 定位只靠结构，不靠文案（弹窗文案随账号地区变成法语/德语/日语…）：
 *  - 容器：.tiktok-cookie-banner（非哈希类名，稳定）；兜底 [class*="cookie-banner" i]
 *  - 按钮：容器内可见按钮，取最后一个。TikTok 的顺序是「拒绝可选 Cookie」在前、「全部允许」在后；
 *    只有一个按钮时就点它。
 * 每次都在页面内重新查询，不缓存 DOM 节点（Lit 组件会重渲染）。
 */

const BANNER_SEL = '.tiktok-cookie-banner, [class*="cookie-banner" i]';
const POLL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.random() * (max - min);
const rndInt = (min, max) => Math.floor(rnd(min, max + 1));

function emit(accountId, msg, level = 'info') {
  try {
    const { publish } = require('../live-log');
    publish(`${accountId ? `账号 #${accountId}：` : ''}${msg}`, level, accountId ? { accountId } : {});
  } catch { /* ignore */ }
}

/**
 * 检测并同意 Cookie 弹窗。
 * @returns {Promise<{detected:boolean, clicked:boolean, gone?:boolean, buttons?:number, text?:string}>}
 */
async function acceptCookieBannerIfPresent(page, { accountId = 0, log = null } = {}) {
  if (!page || page.isClosed?.()) return { detected: false, clicked: false };
  let info = null;
  try {
    info = await page.evaluate((sel) => {
      const visible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
      };
      const banner = [...document.querySelectorAll(sel)].find(visible);
      if (!banner) return null;
      const btns = [...banner.querySelectorAll('button, [role="button"]')].filter(visible);
      if (!btns.length) return { buttons: 0 };
      const target = btns[btns.length - 1];
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return {
        buttons: btns.length,
        x,
        y,
        text: String(target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        hitOk: !!at && (target === at || target.contains(at) || at.contains(target)),
      };
    }, BANNER_SEL);
  } catch {
    return { detected: false, clicked: false };
  }
  if (!info) return { detected: false, clicked: false };
  if (!info.buttons || !info.hitOk) return { detected: true, clicked: false, buttons: info.buttons || 0 };

  const say = log || ((m) => emit(accountId, m));
  say(`检测到 Cookie 政策弹窗，自动同意（按钮 ${info.buttons} 个，点最后一个「${info.text || '-'}」）`);
  try {
    await sleep(rndInt(500, 1300));
    await page.mouse.move(info.x + rndInt(-60, -20), info.y + rndInt(-14, 14), { steps: rndInt(5, 9) });
    await sleep(rndInt(60, 160));
    await page.mouse.move(info.x, info.y, { steps: rndInt(3, 6) });
    await sleep(rndInt(50, 130));
    await page.mouse.down();
    await sleep(rndInt(50, 110));
    await page.mouse.up();
  } catch {
    return { detected: true, clicked: false, buttons: info.buttons, text: info.text };
  }
  await sleep(rndInt(700, 1100));
  const stillThere = await page.evaluate((sel) => [...document.querySelectorAll(sel)].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).display !== 'none';
  }), BANNER_SEL).catch(() => false);
  if (stillThere) say('Cookie 弹窗点击后仍在，稍后巡检会再试');
  return { detected: true, clicked: true, gone: !stillThere, buttons: info.buttons, text: info.text };
}

/**
 * 给页面挂常驻巡检：页面关闭自动清理，同一页面只挂一次。
 */
function attachCookieConsentWatcher(page, { accountId = 0 } = {}) {
  if (!page || page.isClosed?.()) return;
  if (accountId) page.__tkAccountId = page.__tkAccountId || Number(accountId);
  if (page.__tkCookieWatcherAttached) return;
  page.__tkCookieWatcherAttached = true;

  let busy = false;
  let pauseUntil = 0;
  let timer = null;

  const tick = async () => {
    if (busy || !page || page.isClosed?.()) return;
    if (Date.now() < pauseUntil) return;
    // 验证码求解中（鼠标正在拖拽）：不能插进去点击，否则会打断拖拽
    if (page.__tkNoCaptchaSolving) return;
    const url = String(page.url?.() || '');
    if (!/tiktok\.com/i.test(url)) return;
    busy = true;
    try {
      const r = await acceptCookieBannerIfPresent(page, { accountId: page.__tkAccountId || accountId });
      if (r.clicked) pauseUntil = Date.now() + 5000;
    } catch { /* ignore */ } finally {
      busy = false;
    }
  };

  timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  timer.unref?.();
  const onLoad = () => { setTimeout(() => { tick().catch(() => {}); }, 400).unref?.(); };
  page.on?.('domcontentloaded', onLoad);
  page.once?.('close', () => {
    if (timer) clearInterval(timer);
    timer = null;
    try { page.off?.('domcontentloaded', onLoad); } catch { /* ignore */ }
  });
}

/** 对整个 context 生效：已有页面 + 之后新开的页面 */
function attachCookieConsentToContext(context, { accountId = 0 } = {}) {
  if (!context) return;
  try {
    for (const p of context.pages?.() || []) attachCookieConsentWatcher(p, { accountId });
  } catch { /* ignore */ }
  if (context.__tkCookieCtxAttached) return;
  context.__tkCookieCtxAttached = true;
  try {
    context.on?.('page', (p) => attachCookieConsentWatcher(p, { accountId }));
  } catch { /* ignore */ }
}

module.exports = {
  acceptCookieBannerIfPresent,
  attachCookieConsentWatcher,
  attachCookieConsentToContext,
};
