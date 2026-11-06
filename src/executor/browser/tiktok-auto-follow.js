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

/**
 * 读取个人主页关注按钮状态。
 * @returns {Promise<'followed'|'unfollowed'|'unknown'|'self'|'missing'>}
 */
async function readProfileFollowState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
    };
    const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
    const body = String(document.body?.innerText || '').slice(0, 4000);
    if (/couldn'?t find this account|无法找到该账号|找不到此账号|该账号不存在/i.test(body)) return 'missing';

    const edit = [...document.querySelectorAll(
      '[data-e2e="edit-profile-enter"], [data-e2e="edit-profile-button"], button[data-e2e*="edit-profile"]'
    )].some(visible);
    if (edit) return 'self';

    const buttons = [...document.querySelectorAll(
      '[data-e2e="follow-button"], button[data-e2e="follow-button"], [data-e2e*="follow-button"], button[data-e2e*="follow"]'
    )].filter(visible);

    for (const el of buttons) {
      const t = labelOf(el);
      if (/\bfollowing\b|已关注|friends?|好友|消息|message/i.test(t)) return 'followed';
      if (/\bfollow\b|关注|follow back|回关/i.test(t)) return 'unfollowed';
    }
    return 'unknown';
  }).catch(() => 'unknown');
}

async function clickProfileFollow(page) {
  const hit = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
    const candidates = [...document.querySelectorAll(
      '[data-e2e="follow-button"], button[data-e2e="follow-button"], [data-e2e*="follow-button"], button[data-e2e*="follow"]'
    )].filter(visible);

    for (const el of candidates) {
      const t = labelOf(el);
      if (/\bfollowing\b|已关注|friends?|好友|消息|message/i.test(t)) {
        return { already: true, x: 0, y: 0 };
      }
      if (/\bfollow\b|关注|follow back|回关/i.test(t) || el.getAttribute('data-e2e') === 'follow-button') {
        const r = el.getBoundingClientRect();
        return { already: false, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  }).catch(() => null);

  if (!hit) return { clicked: false, already: false };
  if (hit.already) return { clicked: false, already: true };
  await page.mouse.click(hit.x, hit.y);
  return { clicked: true, already: false };
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
    if (last === want || last === 'self' || last === 'missing') return last;
    await sleep(500);
  }
  return last;
}

async function ensureFollowOnProfile(page, accountId) {
  let state = await waitFollowState(page, 'unfollowed', 8000);
  if (state === 'missing') throw new Error('目标账号不存在或主页打不开');
  if (state === 'self') throw new Error('目标是当前登录账号，无法自增粉');
  if (state === 'followed') {
    log(accountId, '已关注，跳过点击');
    return { success: true, alreadyFollowed: true };
  }

  const click = await clickProfileFollow(page);
  if (click.already) return { success: true, alreadyFollowed: true };
  if (!click.clicked) {
    await sleep(1500);
    const retry = await clickProfileFollow(page);
    if (retry.already) return { success: true, alreadyFollowed: true };
    if (!retry.clicked) throw new Error('未找到关注按钮');
  }
  await sleep(1200);
  state = await waitFollowState(page, 'followed', 12000);
  if (state !== 'followed') throw new Error(`关注后状态异常: ${state}`);
  return { success: true, alreadyFollowed: false };
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
  clickProfileFollow,
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
