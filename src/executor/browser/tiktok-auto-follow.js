/**
 * 自动增粉：搜索 → Users 列表找人 → 进主页 → 看视频(停留/点赞/评论) → 关注。
 * 每步有兜底：搜不到/无视频/视频不够 → 尽量继续并最终关注。
 */
const phpApi = require('../php-api');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { publish: liveLog } = require('../live-log');

const { sleep, typeDelay } = require('../human-pace');
const { scaleTimeout, waitPageSettled } = require('./page-ready');

function log(accountId, msg, level = 'info', extra = {}) {
  liveLog(`[自动关注#${accountId}] ${msg}`, level, { accountId, ...extra });
}

/** 回写增粉明细结果；失败抛错，避免账号总任务已完成但增粉明细仍 enqueued */
async function reportAutoFollowFinish(itemId, body) {
  if (!(itemId > 0)) return;
  await phpApi.post(`/node/auto-follow-items/${itemId}/finish`, body);
}

function resolveTargetProfileUrl(payload = {}) {
  const username = String(payload.targetUsername || payload.target_username || '')
    .replace(/^@+/, '')
    .trim();
  if (username) {
    return `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  }
  const uid = String(payload.targetTiktokUid || payload.target_tiktok_uid || '').trim();
  if (uid && !uid.startsWith('u:')) {
    return `https://www.tiktok.com/@${encodeURIComponent(uid)}`;
  }
  return '';
}

function normalizeActionPlan(payload = {}) {
  const plan = payload.actionPlan || payload.action_plan || {};
  const videos = Array.isArray(plan.videos) ? plan.videos : [];
  return {
    searchKeyword: String(plan.searchKeyword || payload.searchKeyword || payload.targetUsername || '')
      .replace(/^@+/, '')
      .trim(),
    watchVideoCount: Number(plan.watchVideoCount || videos.length || 0),
    videos: videos.map((v, i) => ({
      index: Number(v.index ?? i),
      staySeconds: Math.max(1, Math.min(300, Number(v.staySeconds || 10))),
      like: !!v.like,
      comment: !!v.comment,
    })),
    commentMode: String(plan.commentMode || 'ai'),
    commentAiTemplateId: Number(plan.commentAiTemplateId || 0) || 0,
    commentAiPrompt: String(plan.commentAiPrompt || ''),
    commentText: String(plan.commentText || 'Nice video!'),
    commentTexts: Array.isArray(plan.commentTexts) ? plan.commentTexts : [],
  };
}

/*
 * 关注层（与 tkswarm-node/src/services/browser/tiktok-auto-follow.js 保持同一套判定约束，改动需同步）：
 *  1) 只认结构/样式，不靠按钮文案定位；文案仅作整串匹配的兜底，认不出状态就不点（宁可漏、不取关）。
 *  2) 不缓存节点：定位 + 判状态 + 滚动 + 量坐标 + elementFromPoint 自检在同一个 evaluate 里完成。
 *  3) 点击后停留 20s → 刷新主页 → 复核状态，复核通过才返回 success（由调用方写入增粉明细）。
 */
const FOLLOWED_TEXT_SRC = '^(following|following back|followed|unfollow|friends?|friend|'
  + '已关注|已關注|关注中|關注中|互相关注|互相關注|互粉|好友|朋友|取消关注|取消關注|'
  + 'abonné(?:e)?s?|ami(?:e)?s?|siguiendo|amigos?|seguindo|gefolgt|freunde|segui già|già segui|amici|'
  + 'mengikuti|teman|đang follow|đang theo dõi|bạn bè|กำลังติดตาม|takip ediliyor|вы подписаны|подписки|'
  + 'متابَع|متابع|フォロー中|팔로잉|obserwujesz|volgend|opvolgend)$';
const FOLLOW_TEXT_SRC = '^(follow|follow back|关注|關注|回关|回關|s[\'’]abonner|suivre|seguir|folgen|segui|ikuti|theo dõi|ติดตาม|takip et|подписаться|متابعة|フォロー|フォローする|팔로우|obserwuj|volgen|ikut)$';
// 私密号：点关注后进入「等待对方同意」，同样算关注成功
const REQUESTED_TEXT_SRC = '^(requested|request sent|pending|request pending|'
  + '已请求|已申請|请求已发送|已发送请求|请求关注|待确认|待对方确认|申請中|'
  + 'en attente|demande envoyée|solicitado|pendiente|solicitud enviada|angefragt|anfrage gesendet|'
  + 'richiesto|in attesa|diminta|tertunda|menunggu|đã yêu cầu|đang chờ|ส่งคำขอแล้ว|'
  + 'istek gönderildi|запрос отправлен|заявка отправлена|درخواست شده|درخواست ارسال شد|'
  + '요청함|요청 보냄|wysłano prośbę|prośba wysłana|aangevraagd|verzoek verzonden)$';
const NOT_FOUND_TEXT_SRC = "couldn'?t find this account|无法找到该账号|找不到此账号|该账号不存在|無法找到此帳號|impossible de trouver ce compte|no se pudo encontrar esta cuenta|konnte nicht gefunden werden|não foi possível encontrar esta conta|non è stato possibile trovare questo account|tidak dapat menemukan akun ini|không thể tìm thấy tài khoản này|не удалось найти этот аккаунт|bu hesap bulunamadı|このアカウントが見つかりませんでした|계정을 찾을 수 없";

const rnd = (min, max) => min + Math.random() * (max - min);
const rndInt = (min, max) => Math.floor(rnd(min, max + 1));

/** 主页头部里「不是关注」的按钮：按 data-e2e 值排除，与语言无关 */
const HEADER_NON_FOLLOW_E2E = [
  'message-button',
  'show-suggested-accounts',
  'share-btn',
  'user-more',
  'edit-profile-button',
  'edit-profile-enter',
  'follow-back-button',
];

/**
 * 页面内一次完成「重新定位 → 判状态 → 滚动到位 → 量坐标 → 命中自检」，只返回纯数据（绝不返回 DOM 节点）。
 * 状态顺序：data-e2e 明确的 unfollow/following → 整串文案 → 容器底色（主色红=未关注 / 中性实心=已关注）→ unknown。
 * data-e2e="follow-button" 两种状态都存在，不是状态信号。
 */
async function probeFollowButton(page) {
  if (!page || page.isClosed?.()) return { state: 'unknown', reason: 'page_closed' };
  const cfg = {
    followed: FOLLOWED_TEXT_SRC,
    follow: FOLLOW_TEXT_SRC,
    requested: REQUESTED_TEXT_SRC,
    notFound: NOT_FOUND_TEXT_SRC,
    contSel: '[data-testid="tux-web-button-container"]',
    panelSel: '[class*="DivButtonPanelWrapper"]',
    skipE2e: HEADER_NON_FOLLOW_E2E,
  };
  try {
    return await page.evaluate(async (c) => {
      const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u200b]+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.visibility !== 'collapse' && Number(st.opacity) !== 0;
      };
      const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms));
      const parseColor = (v) => {
        const m = String(v || '').match(/[\d.]+/g);
        if (!m || m.length < 3) return null;
        const n = m.map(Number);
        if (n.some((x) => !Number.isFinite(x))) return null;
        return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
      };
      const isPrimaryRed = (col) => !!col && col.a > 0.06 && col.r >= 150 && col.r - col.g >= 45 && col.r - col.b >= 30;
      const isNeutralSolid = (col) => !!col && col.a > 0.5 && Math.abs(col.r - col.g) <= 24 && Math.abs(col.g - col.b) <= 24 && col.r < 150;
      // 配色挂在 tux 容器 div 上，button 自身透明；向上最多找 4 层，遇到 body/html 就放弃（暗色模式页面底色不是按钮色）
      const bgColorOf = (el) => {
        let cur = el;
        for (let depth = 0; cur && depth < 4; depth += 1, cur = cur.parentElement) {
          if (cur === document.body || cur === document.documentElement) return null;
          const col = parseColor(getComputedStyle(cur).backgroundColor);
          if (!col || col.a <= 0.06) continue;
          if (col.r >= 250 && col.g >= 250 && col.b >= 250 && col.a >= 0.99) continue;
          return col;
        }
        return null;
      };
      const describe = (el) => {
        if (!el) return '';
        const e2e = el.getAttribute && el.getAttribute('data-e2e');
        const cls = String((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).filter(Boolean)[0] || '';
        return (el.tagName || '?') + (e2e ? '[e2e=' + e2e + ']' : '') + (cls ? '.' + cls : '');
      };

      const followedRe = new RegExp(c.followed, 'i');
      const followRe = new RegExp(c.follow, 'i');
      const requestedRe = new RegExp(c.requested, 'i');
      const notFoundRe = new RegExp(c.notFound, 'i');
      const panel = document.querySelector(c.panelSel) || document.querySelector('.user-profile-header') || null;

      const cands = [];
      const addCand = (btn, cont) => {
        if (!btn || !isVisible(btn)) return;
        if (cands.some((x) => x.btn === btn)) return;
        const e2e = String(btn.getAttribute('data-e2e') || '').toLowerCase();
        if (e2e && c.skipE2e.includes(e2e)) return;
        if (btn.closest('a') || (cont && cont.closest('a'))) return; // 「消息」被 <a> 包着
        if (btn.querySelector('svg, img') && !norm(btn.textContent)) return; // 纯图标按钮
        cands.push({ btn, cont: cont || null });
      };

      // ① data-e2e 语义
      for (const el of document.querySelectorAll('[data-e2e="unfollow-button"], [data-e2e="follow-button"]')) {
        addCand(el, el.closest(c.contSel));
      }
      // ② data-e2e 变体（改版容错）
      if (!cands.length) {
        for (const el of document.querySelectorAll('[data-e2e^="follow-button"], [data-e2e$="-follow-button"], button[data-e2e^="follow"]')) {
          if (/back|suggest/i.test(String(el.getAttribute('data-e2e') || ''))) continue;
          addCand(el, el.closest(c.contSel));
        }
      }
      // ③ 纯结构：头部按钮面板里「宽 ≥92、有文字、不在 <a> 里」的胶囊按钮（图标按钮 44x44 被排除）
      if (!cands.length) {
        const roots = panel ? panel.querySelectorAll('button') : document.querySelectorAll(c.contSel + ' button');
        for (const btn of roots) {
          if (!isVisible(btn)) continue;
          const r = btn.getBoundingClientRect();
          if (r.width < 92 || r.height < 34) continue;
          if (!norm(btn.textContent)) continue;
          addCand(btn, btn.closest(c.contSel));
        }
      }
      // ④ 整串文案兜底（仅头部面板内）
      if (!cands.length) {
        for (const btn of (panel || document).querySelectorAll('button, [role="button"]')) {
          if (!isVisible(btn)) continue;
          const t = norm(btn.textContent);
          if (!t || t.length > 24) continue;
          if (!(followedRe.test(t) || followRe.test(t) || requestedRe.test(t))) continue;
          addCand(btn, btn.closest(c.contSel));
          if (cands.length >= 3) break;
        }
      }

      const body = String(document.body?.innerText || '').slice(0, 4000);
      const loginWall = !!document.querySelector('[data-e2e="login-modal"], [data-e2e*="login-container"], #login-modal');
      if (!cands.length) {
        const notFound = notFoundRe.test(body);
        return {
          state: notFound ? 'missing' : 'unknown',
          reason: notFound ? 'account_not_found' : (loginWall ? 'login_wall' : 'no_follow_button'),
          loginWall,
          buttonCount: 0,
        };
      }

      const ranked = cands.map((x) => {
        const col = bgColorOf(x.btn) || (x.cont ? bgColorOf(x.cont) : null);
        const e2e = String(x.btn.getAttribute('data-e2e') || '').toLowerCase();
        const text = norm(x.btn.textContent);
        const aria = norm(x.btn.getAttribute('aria-label'));
        let state = 'unknown';
        let how = 'none';
        if (/unfollow|following/.test(e2e)) { state = 'followed'; how = 'e2e'; }
        if (state === 'unknown') {
          if (requestedRe.test(text) || requestedRe.test(aria)) { state = 'requested'; how = 'text'; }
          else if (followedRe.test(text) || followedRe.test(aria)) { state = 'followed'; how = 'text'; }
          else if (followRe.test(text) || followRe.test(aria)) { state = 'unfollowed'; how = 'text'; }
        }
        if (state === 'unknown') {
          if (isPrimaryRed(col)) { state = 'unfollowed'; how = 'style'; }
          else if (isNeutralSolid(col)) { state = 'followed'; how = 'style'; }
        }
        const score = (state === 'unfollowed' ? 2 : 0) + (isPrimaryRed(col) ? 1 : 0) + (e2e === 'follow-button' ? 1 : 0);
        return { ...x, state, how, e2e, text, aria, col, score };
      }).sort((a, b) => b.score - a.score);

      const hit0 = ranked[0];
      const base = {
        state: hit0.state,
        how: hit0.how,
        e2e: hit0.e2e,
        text: hit0.text,
        aria: hit0.aria,
        bg: hit0.col ? 'rgba(' + hit0.col.r + ',' + hit0.col.g + ',' + hit0.col.b + ',' + hit0.col.a + ')' : '',
        buttonCount: cands.length,
        loginWall,
        reason: hit0.state === 'unknown' ? 'ambiguous_state' : undefined,
      };
      if (hit0.state !== 'unfollowed') return base;

      try { hit0.btn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
      await sleepIn(70);
      let r = hit0.btn.getBoundingClientRect();
      if (r.top < 78) {
        try { window.scrollBy(0, r.top - 140); } catch { /* ignore */ }
        await sleepIn(90);
        r = hit0.btn.getBoundingClientRect();
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (!(r.width > 1 && r.height > 1) || cx < 1 || cy < 1 || cx > window.innerWidth - 1 || cy > window.innerHeight - 1) {
        return { ...base, hitOk: false, occludedBy: 'offscreen', x: cx, y: cy };
      }
      const at = document.elementFromPoint(cx, cy);
      const cont = hit0.btn.closest(c.contSel) || hit0.btn;
      // 容器里有 hover overlay，elementFromPoint 会命中它：判定标准是命中点落在按钮/容器子树内
      const hitOk = !!at && (hit0.btn === at || hit0.btn.contains(at) || cont.contains(at));
      return { ...base, x: cx, y: cy, w: r.width, h: r.height, hitOk, occludedBy: hitOk ? '' : describe(at) };
    }, cfg);
  } catch (err) {
    return { state: 'unknown', reason: `probe_failed: ${(err && err.message) || err}`, pageError: true };
  }
}

/** @returns {Promise<'followed'|'unfollowed'|'requested'|'unknown'|'self'|'missing'>} */
async function readProfileFollowState(page) {
  return (await probeFollowButton(page)).state;
}

async function inspectFollowButton(page) {
  const hit = await probeFollowButton(page);
  return { ...hit, buttonCount: hit.buttonCount ?? 0 };
}

/** 自己的主页会有 edit-profile 按钮：单独判 self，避免把自己当成目标 */
async function isSelfProfile(page) {
  return page.evaluate(() => [...document.querySelectorAll(
    '[data-e2e="edit-profile-enter"], [data-e2e="edit-profile-button"], button[data-e2e*="edit-profile"]'
  )].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  })).catch(() => false);
}

/** 拟人点击：从左侧移入 → 抖动修正 → 按住 45~105ms */
async function humanClickAt(page, x, y) {
  const tx = Number(x);
  const ty = Number(y);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) throw new Error('点击坐标无效');
  await page.mouse.move(tx + rndInt(-110, -50), ty + rndInt(-22, 22), { steps: rndInt(6, 12) }).catch(() => {});
  await sleep(rndInt(70, 170));
  await page.mouse.move(tx + rnd(-2, 2), ty + rnd(-2, 2), { steps: rndInt(9, 18) }).catch(() => {});
  await sleep(rndInt(90, 220));
  await page.mouse.move(tx, ty, { steps: 3 }).catch(() => {});
  await sleep(rndInt(45, 130));
  await page.mouse.down();
  await sleep(rndInt(45, 105));
  await page.mouse.up();
}

async function waitFollowFlip(page, timeoutMs = 4500) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    await sleep(rndInt(320, 520));
    last = await probeFollowButton(page);
    if (last.state === 'followed' || last.state === 'requested') return { ok: true, after: last };
    if (last.state === 'missing') return { ok: false, after: last };
  }
  return { ok: false, after: last };
}

/** Cookie 政策弹窗会遮挡页面：按结构定位（容器内最后一个按钮），不看文案，适配各语言 */
async function dismissCookieBanner(page, accountId) {
  try {
    const { acceptCookieBannerIfPresent } = require('./cookie-consent');
    const r = await acceptCookieBannerIfPresent(page, {
      accountId,
      log: (m) => log(accountId, m),
    });
    return !!r.clicked;
  } catch { /* ignore */ }
  return false;
}

/**
 * 点击关注：unfollowed 且命中自检才点；followed/requested/self/missing/unknown 一律不点。
 * probe 返回的 (x,y) 就是「滚动到位 + 重排落定 + 命中自检」之后的坐标，拿到后直接点击。
 */
async function clickFollowButton(page, accountId) {
  let before = await probeFollowButton(page);
  if (before.state === 'unknown' && !before.loginWall) {
    await sleep(rndInt(600, 900)); // 骨架屏 → 真实布局的空窗
    before = await probeFollowButton(page);
  }
  if (before.state === 'followed') return { clicked: false, already: true, before };
  if (before.state === 'requested') return { clicked: false, already: true, requested: true, before };
  if (before.state === 'missing') return { clicked: false, already: false, missing: true, before };
  if (before.state !== 'unfollowed') {
    if (await isSelfProfile(page)) return { clicked: false, already: false, self: true, before };
    return { clicked: false, already: false, unknown: true, before };
  }
  if (!before.hitOk) {
    log(accountId, `关注按钮被遮挡（${before.occludedBy || '未知浮层'}），先尝试关闭浮层`, 'warn');
    await dismissCookieBanner(page, accountId);
    await sleep(rndInt(500, 900));
    before = await probeFollowButton(page);
    if (before.state !== 'unfollowed') {
      return { clicked: false, already: before.state === 'followed', unknown: before.state === 'unknown', before };
    }
    if (!before.hitOk) return { clicked: false, already: false, occluded: true, before };
  }
  await humanClickAt(page, before.x, before.y);
  log(
    accountId,
    `已点击关注按钮（定位=${before.how || '?'}；按钮文本「${before.text || before.aria || '-'}」；data-e2e=${before.e2e || '-'}；底色=${before.bg || '-'}）`
  );
  const flip = await waitFollowFlip(page, 4500);
  return { clicked: true, already: false, before, flipped: flip.ok, after: flip.after };
}

/** 兼容旧签名：只点、不做翻转确认 */
async function clickProfileFollow(page) {
  const hit = await probeFollowButton(page);
  if (hit.state === 'followed' || hit.state === 'requested') return { clicked: false, already: true, before: hit };
  if (hit.state !== 'unfollowed' || !hit.hitOk) return { clicked: false, already: false, before: hit };
  await humanClickAt(page, hit.x, hit.y);
  return { clicked: true, already: false, before: hit };
}

/** 等主页头部真正渲染（出现关注/编辑资料按钮，或明确的「账号不存在」「登录墙」）；user-title 先出现不算就绪 */
async function waitProfileHeaderReady(page, accountId, timeoutMs = 30000) {
  const budget = scaleTimeout(timeoutMs, 15000);
  const end = Date.now() + budget;
  let last = null;
  while (Date.now() < end) {
    if (!page || page.isClosed?.()) return null;
    last = await page.evaluate((notFoundSrc) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const body = String(document.body?.innerText || '').slice(0, 4000);
      return {
        notFound: new RegExp(notFoundSrc, 'i').test(body),
        loginWall: !!document.querySelector('[data-e2e="login-modal"], [data-e2e*="login-container"], #login-modal'),
        hasTitle: !!document.querySelector('[data-e2e="user-title"]'),
        hasAction: [...document.querySelectorAll(
          '[data-e2e="follow-button"], [data-e2e*="follow-button"], [data-e2e*="edit-profile"], button[data-e2e*="follow"],'
          + ' [class*="DivButtonPanelWrapper"] button, [data-testid="tux-web-button-container"] button'
        )].some(visible),
      };
    }, NOT_FOUND_TEXT_SRC).catch(() => null);
    if (last && (last.hasAction || last.notFound || last.loginWall)) return last;
    await sleep(700);
  }
  log(accountId, `主页头部等待超时（${Math.round(budget / 1000)}s）：标题=${last?.hasTitle ? '有' : '无'} 按钮=${last?.hasAction ? '有' : '无'}`, 'warn');
  return last;
}

async function waitFollowState(page, want, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    last = await readProfileFollowState(page);
    if (last === 'unknown' && await isSelfProfile(page)) return 'self';
    if (last === want || last === 'self' || last === 'missing' || last === 'requested') return last;
    if (want === 'unfollowed' && last === 'followed') return last;
    await sleep(500);
  }
  return last;
}

/** 找不到关注按钮时查清页面状态（登录墙 / 验证码 / 私密 / 没加载），只返回原因文本 */
async function diagnoseFollowMiss(page, accountId) {
  const info = await page.evaluate(() => {
    const body = String(document.body?.innerText || '').slice(0, 6000);
    return {
      url: location.href,
      loginWall: !!document.querySelector('[data-e2e="login-modal"], [data-e2e*="login-container"], #login-modal')
        || /log in to (tiktok|follow)|登录.{0,6}(TikTok|关注)/i.test(body),
      captcha: /captcha|drag the slider|verify you are human|安全验证|人机验证|滑块|too many attempts|unusual activity/i.test(body),
      blocked: /something went wrong|try again later|network error|出错了|稍后再试/i.test(body),
      privateOrBanned: /this account is private|account banned|此账号不公开|账号已被封禁/i.test(body),
      hasProfile: !!document.querySelector('[data-e2e="user-page"], [data-e2e="user-title"], [data-e2e="followers-count"]'),
    };
  }).catch(() => null);
  let reason = '页面无法读取';
  if (info) {
    if (info.loginWall) reason = '出现登录弹窗，账号登录态可能已失效';
    else if (info.captcha) reason = '出现验证码/安全验证';
    else if (info.blocked) reason = '页面报错（网络或风控）';
    else if (info.privateOrBanned) reason = '目标账号私密或已被封禁';
    else if (!info.hasProfile) reason = '主页没有加载出来（代理慢或被拦截）';
    else reason = '主页已加载但页面上没有关注按钮';
  }
  log(accountId, `关注按钮诊断：${reason}${info ? `；url=${info.url}` : ''}`, 'warn');
  return { reason };
}

/** 关注后在主页停留：保持轻微鼠标活动，期间处理人机验证；不滚轮、不跳转 */
async function dwellOnProfile(page, accountId, ms = 20000) {
  const budget = Math.max(1200, Number(ms) + rndInt(-400, 700));
  const end = Date.now() + budget;
  const vp = page.viewportSize?.() || { width: 1280, height: 800 };
  let captchaSeen = 0;
  let lastProbe = 0;
  while (Date.now() < end) {
    if (Date.now() - lastProbe > 1800) {
      lastProbe = Date.now();
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        const r = await solveRotateCaptchaIfPresent(page);
        if (r?.detected) {
          captchaSeen += 1;
          log(accountId, `停留期间出现人机验证（第 ${captchaSeen} 次）：${r.solved ? '已自动通过' : '未能通过，交给刷新后复核'}`, r.solved ? 'warn' : 'error');
        }
      } catch { /* ignore */ }
    }
    try {
      if (Math.random() < 0.4) {
        await page.mouse.move(rnd(80, Math.max(120, vp.width - 80)), rnd(220, Math.max(260, vp.height - 220)), { steps: rndInt(2, 5) });
      }
    } catch { /* ignore */ }
    await sleep(rndInt(600, 1400));
  }
  return { ms: budget, captchaSeen };
}

/** 刷新主页并复核：刷新后重新渲染的 DOM 才是服务端真值（点击是乐观更新，可能被回滚） */
async function verifyFollowAfterReload(page, accountId) {
  if (!page || page.isClosed?.()) throw new Error('页面已关闭，无法复核关注结果');
  const url = String(page.url() || '');
  if (!/\/@[^/?#]+/i.test(url)) throw new Error(`关注后页面已不在主页（当前 ${url}），无法复核`);

  let reloaded = false;
  let lastErr = '';
  for (let i = 1; i <= 2 && !reloaded; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scaleTimeout(60000, 45000) });
      reloaded = true;
    } catch (e) {
      lastErr = e.message || String(e);
      log(accountId, `刷新主页复核失败（第 ${i} 次）：${lastErr}`, 'warn');
      await sleep(rndInt(1200, 2200));
    }
  }
  if (!reloaded) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      reloaded = true;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  if (!reloaded) throw new Error(`刷新主页失败，无法复核关注结果：${lastErr}`);

  await dismissCookieBanner(page, accountId);
  await waitProfileHeaderReady(page, accountId, 30000);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  const state = await waitFollowState(page, 'followed', 14000);
  const after = await probeFollowButton(page);
  log(
    accountId,
    `刷新后复核：判定=${state}，按钮文本「${after.text || after.aria || '-'}」，底色=${after.bg || '-'}，识别方式=${after.how || '-'}`,
    state === 'followed' || state === 'requested' ? 'info' : 'warn'
  );
  return { followed: state === 'followed', requested: state === 'requested', state, after };
}

async function ensureFollowOnProfile(page, accountId) {
  await dismissCookieBanner(page, accountId);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await waitProfileHeaderReady(page, accountId, 30000);
  await dismissCookieBanner(page, accountId);

  let state = await waitFollowState(page, 'unfollowed', 10000);
  if (state === 'unknown') {
    log(accountId, '未识别到关注按钮，刷新主页重试', 'warn');
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: scaleTimeout(60000, 45000) }).catch(() => {});
    await waitPageSettled(page, {
      timeoutMs: 30000,
      contentSelectors: ['[data-e2e="user-title"]', '[data-e2e="follow-button"]', '[data-e2e="followers-count"]'],
      reloadOnce: false,
      label: '自动关注主页',
      log: (m) => log(accountId, m),
    }).catch(() => {});
    await waitProfileHeaderReady(page, accountId, 30000);
    await dismissCookieBanner(page, accountId);
    state = await waitFollowState(page, 'unfollowed', 15000);
  }
  if (state === 'missing') throw new Error('目标账号不存在或主页打不开');
  if (state === 'self') throw new Error('目标是当前登录账号，无法自增粉');
  if (state === 'followed' || state === 'requested') {
    log(accountId, state === 'requested' ? '已发出关注申请（私密号），跳过点击' : '已关注，跳过点击');
    return { success: true, alreadyFollowed: true, requestPending: state === 'requested' };
  }

  const clickRes = await clickFollowButton(page, accountId);
  if (clickRes.already) {
    log(accountId, '已关注（或关注申请已发出），跳过点击');
    return { success: true, alreadyFollowed: true, requestPending: !!clickRes.requested };
  }
  if (clickRes.self) throw new Error('目标是当前登录账号，无法自增粉');
  if (clickRes.missing) throw new Error('目标账号不存在或主页打不开');
  if (!clickRes.clicked) {
    const diag = await diagnoseFollowMiss(page, accountId);
    throw new Error(`未找到关注按钮（${diag.reason}${clickRes.occluded ? '；按钮存在但被浮层遮挡' : ''}）`);
  }
  if (!clickRes.flipped) {
    log(accountId, `点击后 4.5s 内按钮未翻转为「已关注」（当前 ${clickRes.after?.state || 'unknown'}），等刷新后的复核结果`, 'warn');
  }

  // 任务要求：点上关注后在本主页停留 20 秒，再刷新复核
  const dwell = await dwellOnProfile(page, accountId, 20000);
  log(accountId, `已在主页停留 ${Math.round((dwell?.ms || 20000) / 1000)}s${dwell?.captchaSeen ? `（期间处理人机验证 ${dwell.captchaSeen} 次）` : ''}，开始刷新复核`);

  const verdict = await verifyFollowAfterReload(page, accountId);
  if (!verdict.followed && !verdict.requested) {
    throw new Error(
      `关注后复核未通过：刷新主页后按钮仍为「${verdict.state}」，`
      + `点击前「${clickRes.before?.text || clickRes.before?.e2e || '-'}」`
      + `→ 点击后「${clickRes.after?.text || clickRes.after?.state || '-'}」`
    );
  }
  return {
    success: true,
    alreadyFollowed: false,
    verifiedAfterReload: true,
    requestPending: !!verdict.requested,
    dwellMs: dwell?.ms || 0,
    state: verdict.state,
  };
}

/** 打开搜索页并输入关键词 */
async function searchKeyword(page, keyword, accountId) {
  const q = String(keyword || '').trim();
  if (!q) return { ok: false, reason: 'empty_keyword' };

  const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: scaleTimeout(90000, 60000) }).catch(() => {});
  await waitPageSettled(page, {
    timeoutMs: 45000,
    contentSelectors: ['a[href*="/@"]', '[data-e2e*="search"]', 'input[type="search"]'],
    reloadOnce: true,
    label: '自动关注搜索',
    log: (m) => log(accountId, m),
  });

  // 尝试填搜索框并回车（部分语言区会落到首页）
  try {
    const input = page.locator(
      'input[data-e2e="search-user-input"], input[type="search"], input[name="q"], input[placeholder*="Search" i], input[placeholder*="搜索"]'
    ).first();
    if (await input.count()) {
      await input.click({ timeout: 2000 }).catch(() => {});
      await input.fill('');
      await input.type(q, { delay: typeDelay(80, 160) });
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(1800);
    }
  } catch {
    /* ignore */
  }

  const url = String(page.url() || '');
  log(accountId, `搜索关键词「${q}」→ ${url}`);
  return { ok: /\/search/i.test(url) || true, reason: '' };
}

/** 切到 Users / 用户 Tab */
async function switchToUsersTab(page, accountId) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const nodes = [...document.querySelectorAll('a, button, div[role="tab"], span')].filter(visible);
    for (const el of nodes) {
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      const href = String(el.getAttribute?.('href') || '');
      if (/^users?$/i.test(t) || t === '用户' || /\/search\/user/i.test(href)) {
        el.click();
        return t || href || 'users';
      }
    }
    return '';
  }).catch(() => '');

  if (clicked) {
    log(accountId, `切换到用户页签: ${clicked}`);
    await sleep(1600);
    return true;
  }

  // URL 兜底
  try {
    const u = new URL(page.url());
    const q = u.searchParams.get('q') || '';
    if (q) {
      await page.goto(`https://www.tiktok.com/search/user?q=${encodeURIComponent(q)}`, {
        waitUntil: 'domcontentloaded',
        timeout: scaleTimeout(75000, 50000),
      }).catch(() => {});
      await waitPageSettled(page, {
        timeoutMs: 40000,
        contentSelectors: ['a[href*="/@"]', '[data-e2e*="search-user"]', '[data-e2e*="search"]'],
        reloadOnce: true,
        label: '自动关注用户搜索',
        log: (m) => log(accountId, m),
      });
      return true;
    }
  } catch {
    /* ignore */
  }
  log(accountId, '未找到「用户」页签，继续在当前结果里找用户', 'warn');
  return false;
}

/**
 * 在用户搜索结果中点击目标用户。
 * @returns {Promise<{found:boolean, via:string}>}
 */
async function clickUserInSearchResults(page, targetUsername, accountId) {
  const want = String(targetUsername || '').replace(/^@+/, '').trim().toLowerCase();
  if (!want) return { found: false, via: 'no_username' };

  const hit = await page.evaluate((uname) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const anchors = [...document.querySelectorAll('a[href*="/@"]')].filter(visible);
    const exact = [];
    const soft = [];
    for (const a of anchors) {
      const href = String(a.getAttribute('href') || '');
      const m = href.match(/\/@([^/?#]+)/);
      if (!m) continue;
      const handle = decodeURIComponent(m[1]).replace(/^@+/, '').toLowerCase();
      const r = a.getBoundingClientRect();
      const pt = { x: r.left + r.width / 2, y: r.top + r.height / 2, handle, href };
      if (handle === uname) exact.push(pt);
      else if (handle.includes(uname) || uname.includes(handle)) soft.push(pt);
    }
    const pick = exact[0] || soft[0];
    return pick || null;
  }, want).catch(() => null);

  if (!hit) {
    log(accountId, `搜索结果未找到用户 @${want}`, 'warn');
    return { found: false, via: 'not_in_list' };
  }

  await page.mouse.click(hit.x, hit.y);
  await sleep(2200);
  log(accountId, `点击搜索用户 @${hit.handle}`);
  return { found: true, via: 'search_list' };
}

/** 收集主页视频入口 */
async function listProfileVideoHrefs(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      if (!visible(a)) continue;
      let href = String(a.getAttribute('href') || '');
      if (!href) continue;
      if (href.startsWith('/')) href = `https://www.tiktok.com${href}`;
      const key = href.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(href);
    }
    return out;
  }).catch(() => []);
}

async function clickLikeIfNeeded(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
    const btns = [...document.querySelectorAll(
      '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], button[data-e2e*="like"], [class*="LikeButton"]'
    )].filter(visible);
    for (const el of btns) {
      const t = labelOf(el);
      const pressed = el.getAttribute('aria-pressed') === 'true' || /liked|已点赞|unlike/i.test(t);
      if (pressed) return { ok: true, already: true };
      el.click();
      return { ok: true, already: false };
    }
    return { ok: false, already: false };
  }).catch(() => ({ ok: false, already: false }));
}

async function resolveCommentText(plan, accountId) {
  if (plan.commentMode === 'ai' && (plan.commentAiPrompt || plan.commentAiTemplateId)) {
    try {
      const r = await phpApi.post('/node/warm/ai-comment', {
        prompt: plan.commentAiPrompt || '',
        templateId: Number(plan.commentAiTemplateId || 0) || 0,
        variables: { author: '', video_desc: '' },
      });
      const text = String(r?.comment || r?.text || '').trim();
      if (text) return text;
    } catch (e) {
      log(accountId, `AI 评论失败，改用固定文案: ${e.message || e}`, 'warn');
    }
  }
  const pool = (plan.commentTexts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return String(plan.commentText || 'Nice video!').trim() || 'Nice video!';
}

async function postCommentIfNeeded(page, text) {
  const body = String(text || '').trim();
  if (!body) return { ok: false };
  try {
    // 打开评论区
    await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const btns = [...document.querySelectorAll(
        '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], button[data-e2e*="comment"]'
      )].filter(visible);
      if (btns[0]) btns[0].click();
    }).catch(() => {});
    await sleep(1000);

    const box = page.locator(
      '[data-e2e="comment-input"] div[contenteditable="true"], div[contenteditable="true"][data-e2e*="comment"], textarea[placeholder*="comment" i], textarea[placeholder*="评论"]'
    ).first();
    if (!(await box.count())) return { ok: false };
    await box.click({ timeout: 3000 }).catch(() => {});
    await box.fill('').catch(() => {});
    await page.keyboard.type(body, { delay: typeDelay(80, 160) });
    await sleep(900);
    await page.keyboard.press('Enter').catch(() => {});
    // 再点发送按钮兜底
    await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const btns = [...document.querySelectorAll('button, div[role="button"]')].filter(visible);
      for (const el of btns) {
        const t = String(el.textContent || '').trim().toLowerCase();
        if (/^post$|^send$|^发布$|^发送$/.test(t)) {
          el.click();
          return;
        }
      }
    }).catch(() => {});
    await sleep(1200);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function watchVideosOnProfile(page, plan, accountId) {
  const wanted = Array.isArray(plan.videos) ? plan.videos : [];
  if (!wanted.length) {
    log(accountId, '计划观看数为 0，跳过视频直接准备关注');
    return { watched: 0, available: 0 };
  }

  const hrefs = await listProfileVideoHrefs(page);
  log(accountId, `主页视频可用 ${hrefs.length} 个，计划 ${wanted.length} 个`);
  if (!hrefs.length) {
    log(accountId, '主页无视频，跳过观看直接关注', 'warn');
    return { watched: 0, available: 0 };
  }

  const n = Math.min(wanted.length, hrefs.length);
  let watched = 0;
  for (let i = 0; i < n; i++) {
    const step = wanted[i];
    const href = hrefs[i];
    try {
      log(accountId, `观看视频 ${i + 1}/${n} stay=${step.staySeconds}s like=${!!step.like} comment=${!!step.comment}`);
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(page, { accountId });
      } catch { /* ignore */ }
      await sleep(Math.max(800, step.staySeconds * 1000));
      if (step.like) {
        const liked = await clickLikeIfNeeded(page);
        log(accountId, liked.ok ? (liked.already ? '已点赞' : '已点赞成功') : '未找到点赞按钮', liked.ok ? 'info' : 'warn');
      }
      if (step.comment) {
        const text = await resolveCommentText(plan, accountId);
        const posted = await postCommentIfNeeded(page, text);
        log(accountId, posted.ok ? `已评论: ${text.slice(0, 40)}` : '评论失败/无输入框', posted.ok ? 'info' : 'warn');
      }
      watched++;
    } catch (e) {
      log(accountId, `观看第 ${i + 1} 个视频失败: ${e.message || e}`, 'warn');
    }
  }

  // 回到主页准备关注（用历史后退或目标 URL 由外层处理）
  return { watched, available: hrefs.length };
}

/**
 * 尽量通过搜索进主页；失败则直达 profileUrl。
 */
async function navigateToTargetProfile(page, payload, plan, accountId) {
  const targetUsername = String(payload.targetUsername || '').replace(/^@+/, '').trim();
  const profileUrl = resolveTargetProfileUrl(payload);
  const keyword = plan.searchKeyword || targetUsername;

  let via = 'direct';
  if (keyword) {
    await searchKeyword(page, keyword, accountId);
    await switchToUsersTab(page, accountId);
    const found = await clickUserInSearchResults(page, targetUsername || keyword, accountId);
    if (found.found) {
      via = found.via;
      await sleep(1200);
      // 确认已在主页
      const cur = String(page.url() || '');
      if (/tiktok\.com\/@/i.test(cur)) {
        return { ok: true, via, profileUrl: cur };
      }
    } else {
      log(accountId, '搜索未命中目标用户，改直达主页', 'warn');
    }
  }

  if (!profileUrl) {
    throw new Error('缺少目标用户名/UID，且搜索未找到用户');
  }
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(1800);
  return { ok: true, via: 'direct', profileUrl };
}

/**
 * @param {number} accountId 源账号（执行关注）
 * @param {object} payload
 */
async function runAutoFollow(accountId, payload = {}) {
  const itemId = Number(payload.itemId || payload.item_id || 0);
  const taskId = Number(payload.taskId || payload.task_id || 0);
  const profileUrl = resolveTargetProfileUrl(payload);
  const targetUsername = String(payload.targetUsername || payload.target_username || '').replace(/^@+/, '').trim();
  const targetUid = String(payload.targetTiktokUid || payload.target_tiktok_uid || '').trim();
  const targetAccountId = Number(payload.targetAccountId || payload.target_account_id || 0);
  const plan = normalizeActionPlan(payload);

  if (!profileUrl && !plan.searchKeyword && !targetUsername) {
    throw new Error('缺少目标用户名/UID，无法打开主页');
  }

  log(
    accountId,
    `开始 task#${taskId || '-'} item#${itemId || '-'} → @${targetUsername || targetUid || '-'} keyword=${plan.searchKeyword || '-'} videos=${plan.videos.length}`,
    'info',
    { taskId, itemId }
  );

  const startUrl = profileUrl || 'https://www.tiktok.com/';
  const { parseSaveTrafficFlag } = require('./save-traffic');
  const connection = await connectAccount(accountId, startUrl, 'auto_follow', {
    saveTraffic: parseSaveTrafficFlag(payload.saveTraffic ?? payload.save_traffic, true),
    browserBackend: payload.browserBackend || payload.browser_backend,
  });
  let success = false;
  let alreadyFollowed = false;
  let error = '';
  let navVia = 'direct';

  try {
    const page = connection.page;

    const nav = await navigateToTargetProfile(page, payload, plan, accountId);
    navVia = nav.via;

    // 主页观看计划（无视频/不够则看完可用的再关注）
    try {
      // 确保在主页网格
      const cur = String(page.url() || '');
      if (!/tiktok\.com\/@[^/]+\/?(\?|$)/i.test(cur) && (nav.profileUrl || profileUrl)) {
        await page.goto(nav.profileUrl || profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await sleep(1500);
      }
      const watch = await watchVideosOnProfile(page, plan, accountId);
      if (watch.watched > 0 || watch.available === 0) {
        // 回主页再关注
        const backUrl = resolveTargetProfileUrl(payload) || nav.profileUrl;
        if (backUrl) {
          await page.goto(backUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
          await sleep(1500);
        } else {
          await page.goBack({ timeout: 15000 }).catch(() => {});
          await sleep(1200);
        }
      }
    } catch (e) {
      log(accountId, `主页观看流程异常（继续关注）: ${e.message || e}`, 'warn');
      if (profileUrl) {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await sleep(1500);
      }
    }

    const follow = await ensureFollowOnProfile(page, accountId);
    success = !!follow.success;
    alreadyFollowed = !!follow.alreadyFollowed;

    await reportAutoFollowFinish(itemId, {
      success: true,
      alreadyFollowed,
      followedAccountId: targetAccountId,
      followedTiktokUid: targetUid,
      followedUsername: targetUsername,
      navVia,
    });

    log(
      accountId,
      `成功 ${alreadyFollowed ? '(已关注)' : ''} via=${navVia} → ${targetUsername || targetUid || profileUrl}`,
      'info',
      { taskId, itemId }
    );

    return {
      status: 'ok',
      success: true,
      alreadyFollowed,
      profileUrl,
      navVia,
      itemId,
      taskId,
    };
  } catch (e) {
    error = e.message || String(e);
    try {
      await reportAutoFollowFinish(itemId, {
        success: false,
        error,
        followedAccountId: targetAccountId,
        followedTiktokUid: targetUid,
        followedUsername: targetUsername,
        navVia,
      });
    } catch (finishErr) {
      log(accountId, `失败回写异常: ${finishErr.message || finishErr}`, 'warn', { itemId });
    }
    log(accountId, `失败: ${error}`, 'error', { taskId, itemId });
    return {
      status: 'failed',
      success: false,
      error,
      profileUrl,
      navVia,
      itemId,
      taskId,
    };
  } finally {
    await closeConnection(connection).catch(() => {});
  }
}

module.exports = {
  runAutoFollow,
  resolveTargetProfileUrl,
  readProfileFollowState,
  inspectFollowButton,
  probeFollowButton,
  clickFollowButton,
  clickProfileFollow,
  dwellOnProfile,
  verifyFollowAfterReload,
  normalizeActionPlan,
  log,
  searchKeyword,
  switchToUsersTab,
  clickUserInSearchResults,
  listProfileVideoHrefs,
  clickLikeIfNeeded,
  resolveCommentText,
  postCommentIfNeeded,
};
