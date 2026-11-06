/**
 * 视频增值：搜索发布者昵称 → 进主页 → 下滑找到目标视频 → 看完暂停 → 点赞 → 评论 → 转发。
 * 复用 tiktok-auto-follow 导出的搜索 / 找人 / 点赞 / 评论 helper。
 */
const phpApi = require('../php-api');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { sleep } = require('../human-pace');
const { waitPageSettled } = require('./page-ready');
const AF = require('./tiktok-auto-follow');
const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');

const MAX_SCROLLS = 40;
const WATCH_MAX_MS = 180000;

function log(accountId, msg, level = 'info', extra = {}) {
  AF.log(accountId, `[视频增值] ${msg}`, level, extra);
}

/** 回写视频增值明细结果 */
async function reportVideoBoostFinish(itemId, body) {
  if (!(itemId > 0)) return;
  await phpApi.post(`/node/video-boost-items/${itemId}/finish`, body);
}

function extractVideoId(url) {
  const tail = String(url || '').split('/video/')[1] || '';
  return tail.replace(/\D.*$/, '');
}

/** 评论：AI 模式走养号同一接口（传入提示词 + 视频变量），失败或固定模式用固定文案 */
async function generateComment(plan, payload, accountId) {
  if (plan.commentMode === 'fixed') {
    return String(plan.commentText || '').trim();
  }
  const prompt = String(plan.commentAiPrompt || '').trim();
  if (!prompt) {
    return String(plan.commentText || '').trim();
  }
  const variables = {
    video_title: payload.videoTitle || '',
    video_desc: payload.videoDesc || '',
    author: payload.publisherNickname || payload.publisherUsername || '',
  };
  try {
    const r = await phpApi.post('/node/warm/ai-comment', {
      prompt,
      variables,
      templateId: plan.commentAiTemplateId || 0,
    });
    const text = String(r?.comment ?? r?.data?.comment ?? '').trim();
    if (text) return text;
  } catch (e) {
    log(accountId, `AI 生成评论失败，改用固定文案: ${e.message || e}`, 'warn');
  }
  return String(plan.commentText || '').trim();
}

/** 搜索发布者昵称 → Users 列表点人；搜不到则直达 @用户名主页 */
async function findPublisherProfile(page, payload, accountId) {
  const username = String(payload.publisherUsername || '').replace(/^@+/, '').trim();
  const keyword = String(payload.searchKeyword || payload.publisherNickname || username).trim();
  if (keyword) {
    const s = await AF.searchKeyword(page, keyword, accountId).catch(() => ({ ok: false }));
    if (s && s.ok !== false) {
      await AF.switchToUsersTab(page, accountId).catch(() => {});
      const hit = username
        ? await AF.clickUserInSearchResults(page, username, accountId).catch(() => ({ found: false }))
        : { found: false };
      if (hit && hit.found) return { via: 'search' };
    }
    log(accountId, `搜索「${keyword}」未直接命中主页，改直达 @${username}`, 'warn');
  }
  if (!username) {
    throw new Error('缺少发布者用户名，无法打开主页');
  }
  await page.goto(`https://www.tiktok.com/@${username}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(1800);
  return { via: 'direct' };
}

/** 主页上反复下滑，直到找到目标视频链接并点击进入 */
async function findVideoOnProfile(page, videoId, accountId) {
  for (let i = 0; i < MAX_SCROLLS; i++) {
    const hrefs = (await AF.listProfileVideoHrefs(page).catch(() => [])) || [];
    const hit = hrefs.some((h) => String(typeof h === 'string' ? h : (h?.href || '')).includes(`/video/${videoId}`));
    if (hit) {
      const clicked = await page.evaluate((id) => {
        const a = [...document.querySelectorAll('a[href*="/video/"]')]
          .find((x) => String(x.getAttribute('href') || '').includes(`/video/${id}`));
        if (!a) return false;
        a.scrollIntoView({ block: 'center' });
        a.click();
        return true;
      }, videoId).catch(() => false);
      if (clicked) {
        log(accountId, `第 ${i + 1} 次下滑找到目标视频，已打开`, 'info');
        return true;
      }
    }
    await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
    await sleep(1200 + Math.floor(Math.random() * 800));
  }
  return false;
}

/** 观看到完播后暂停；超过上限也强制暂停 */
async function watchToEndThenPause(page, accountId) {
  const deadline = Date.now() + WATCH_MAX_MS;
  let done = false;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { t: v.currentTime || 0, d: v.duration || 0, ended: !!v.ended, paused: !!v.paused };
    }).catch(() => null);
    if (!st) {
      await sleep(1000);
      continue;
    }
    if (st.ended || (st.d > 0 && st.t >= st.d - 1)) {
      done = true;
      break;
    }
    if (st.paused) {
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.play().catch(() => {});
      }).catch(() => {});
    }
    await sleep(1000);
  }
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.pause();
  }).catch(() => {});
  log(accountId, done ? '视频已完整播放，已暂停' : '观看超时，已强制暂停', done ? 'info' : 'warn');
  return done;
}

/** 转发：点分享按钮 → 选择「转发/Repost」（尽力而为，找不到按钮则跳过） */
async function shareRepostIfNeeded(page) {
  const btn = await page.$('[data-e2e="share-icon"], [data-e2e="share-button"], button[aria-label*="Share" i], button[aria-label*="分享"]').catch(() => null);
  if (!btn) return { ok: false, reason: 'share_button_not_found' };
  await btn.click().catch(() => {});
  await sleep(1200);
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-e2e*="repost" i], button, div[role="button"], span, a, li')];
    const el = nodes.find((n) => /^(repost|转发)$/i.test(String(n.innerText || '').trim()));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }).catch(() => false);
  await sleep(1500);
  await page.keyboard.press('Escape').catch(() => {});
  return { ok: !!clicked, reason: clicked ? '' : 'repost_option_not_found' };
}

/** 点赞 → 评论 → 转发，各步独立兜底 */
async function likeCommentShare(page, plan, payload, accountId, result) {
  if (plan.doLike !== false) {
    const r = await AF.clickLikeIfNeeded(page).catch(() => null);
    result.liked = !!(r?.liked ?? r?.ok ?? r === true);
  }
  if (plan.doComment !== false) {
    const text = await generateComment(plan, payload, accountId);
    if (text) {
      const c = await AF.postCommentIfNeeded(page, text).catch(() => null);
      result.commented = !!(c?.posted ?? c?.ok ?? c === true);
      result.commentText = text;
    } else {
      result.commented = false;
      result.commentReason = 'empty_comment_text';
    }
  }
  if (plan.doShare !== false) {
    const s = await shareRepostIfNeeded(page);
    result.shared = !!s.ok;
    if (!s.ok) result.shareReason = s.reason;
  }
}

/**
 * @param {number} accountId 执行账号（发起点赞/评论/转发的账号）
 * @param {object} payload taskId / itemId / videoUrl / videoId / publisherUsername / publisherNickname / searchKeyword / actionPlan
 */
async function runVideoBoost(accountId, payload = {}) {
  const itemId = Number(payload.itemId || payload.item_id || 0);
  const taskId = Number(payload.taskId || payload.task_id || 0);
  const videoUrl = String(payload.videoUrl || payload.video_url || '').trim();
  const videoId = String(payload.videoId || payload.video_id || extractVideoId(videoUrl) || '').trim();
  const plan = payload.actionPlan && typeof payload.actionPlan === 'object' ? payload.actionPlan : {};
  const result = { via: '', watched: false, liked: false, commented: false, shared: false, commentText: '' };

  if (!videoId && !videoUrl) {
    const error = '缺少视频链接/ID';
    await reportVideoBoostFinish(itemId, { success: false, error, result }).catch(() => {});
    return { status: 'failed', success: false, error, result, itemId, taskId };
  }

  log(
    accountId,
    `开始 task#${taskId || '-'} item#${itemId || '-'} 发布者=${payload.publisherNickname || payload.publisherUsername || '-'} video=${videoId || videoUrl}`,
    'info',
    { taskId, itemId }
  );

  const { parseSaveTrafficFlag } = require('./save-traffic');
  const connection = await connectAccount(accountId, 'https://www.tiktok.com/', 'video_boost', {
    saveTraffic: parseSaveTrafficFlag(payload.saveTraffic ?? payload.save_traffic, true),
    browserBackend: payload.browserBackend || payload.browser_backend,
  });

  let ok = false;
  let error = '';
  try {
    const page = connection.page;
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    const nav = await findPublisherProfile(page, payload, accountId);
    result.via = nav.via;
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    await waitPageSettled(page, {
      timeoutMs: 30000,
      contentSelectors: ['a[href*="/video/"]'],
      label: '视频增值主页',
      log: (m) => log(accountId, m),
    }).catch(() => {});

    const found = videoId ? await findVideoOnProfile(page, videoId, accountId) : false;
    if (!found) {
      if (!videoUrl) throw new Error('主页下滑未找到目标视频');
      log(accountId, '下滑未找到目标视频，直接打开视频链接', 'warn');
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      result.via = `${result.via}+direct_video`;
    }
    await sleep(2000);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});

    result.watched = await watchToEndThenPause(page, accountId);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    await likeCommentShare(page, plan, payload, accountId, result);
    log(accountId, `完成 点赞=${result.liked} 评论=${result.commented} 转发=${result.shared}`, 'info');
    ok = true;
  } catch (e) {
    error = String(e?.message || e || '视频增值失败');
    log(accountId, `失败: ${error}`, 'error', { taskId, itemId });
  } finally {
    await closeConnection(connection).catch(() => {});
  }

  await reportVideoBoostFinish(itemId, { success: ok, error: ok ? '' : error, result }).catch((finishErr) => {
    log(accountId, `失败回写异常: ${finishErr.message || finishErr}`, 'warn', { itemId });
  });
  return { status: ok ? 'completed' : 'failed', success: ok, error, result, itemId, taskId };
}

module.exports = {
  runVideoBoost,
  extractVideoId,
};
