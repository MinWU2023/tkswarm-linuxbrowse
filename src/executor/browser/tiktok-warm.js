/**
 * TikTok 自动养号 · 比特浏览器执行器
 *
 * 流程（单账号 / 单次 work-item）：
 *   1. 解析 executionPlan（保存时固化；缺省本地按同规则生成）
 *   2. 打开比特 → 进入 https://www.tiktok.com/ 首页 → 校验登录
 *   3. 按关键词循环：
 *        首页搜索框输入关键词 → 回车
 *        → 点击 Videos / 视频 Tab
 *        → 点击第一个搜索结果进入浏览态
 *        → 按计划：停留观看 + 点赞/收藏/关注/评论…
 *        → 点击侧栏下箭头切下一条（禁止直链 /video/xxx）
 *   4. 汇总统计返回；关闭浏览器（可 keepOpen）
 *
 * 约定：
 *   - 搜索类型固定为 video（经 UI Tab，不走深链）
 *   - 评论文案默认「很棒的视频，点赞」
 *   - 单条失败跳过；整关键词 0 条刷到记 skipped
 */
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { inspectTikTokSession } = require('./cdp-client');
const { capture } = require('../automation-guard');
let nowChinaIso;
try {
  ({ nowChinaIso } = require('../../utils/china-time'));
} catch {
  ({ nowChinaIso } = require('../utils/china-time'));
}

const HOME_URL = 'https://www.tiktok.com/';
const DEFAULT_COMMENT_TEXT = '很棒的视频，点赞';

const SELECTORS = {
  searchInput: [
    '[data-e2e="search-user-input"]',
    'input[data-e2e="search-user-input"]',
    '[data-e2e="search-box"] input',
    'form[data-e2e="search-box"] input',
    'form[action*="search"] input',
    'header input[type="search"]',
    'header input[type="text"]',
    'nav input[type="search"]',
    'nav input[type="text"]',
    'input[type="search"]',
    'input[name="q"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="search" i]',
    'input[placeholder*="搜索"]',
    'input[aria-label*="Search" i]',
    'input[aria-label*="搜索"]',
  ],
  searchTrigger: [
    '[data-e2e="search-box"]',
    '[data-e2e="nav-search"]',
    '[data-e2e="search-entry"]',
    'button[aria-label*="Search" i]',
    'a[aria-label*="Search" i]',
    'div[aria-label*="Search" i]',
    '[class*="SearchIcon"]',
    '[class*="search-icon"]',
    'form[data-e2e="search-box"]',
  ],
  videosTab: [
    '[data-e2e="search-video"]',
    '[data-e2e="tab-search_video"]',
    '[data-e2e="search-tab-video"]',
    'a[href*="/search/video"]',
  ],
  searchVideoItem: [
    '[data-e2e="search_video-item"]',
    '[data-e2e="search-card-video"]',
    '[data-e2e="search-result-item"] a[href*="/video/"]',
    'div[data-e2e="search_video-item"] a',
    'a[href*="/video/"]',
  ],
  like: [
    '[data-e2e="browse-like-icon"]',
    '[data-e2e="like-icon"]',
    '[data-e2e="video-like-icon"]',
    'button[aria-label*="Like"]',
    'button[aria-label*="赞"]',
    'span[data-e2e="like-icon"]',
  ],
  favorite: [
    '[data-e2e="browse-favorite-icon"]',
    '[data-e2e="video-favorite-icon"]',
    '[data-e2e="favorite-icon"]',
    'button[aria-label*="Favorite"]',
    'button[aria-label*="Add to Favorites"]',
    'button[aria-label*="收藏"]',
  ],
  follow: [
    // 浏览态右侧栏：头像底部红色「+」，禁止点头像链
    'button[data-e2e="browse-follow"]',
    '[data-e2e="browse-follow"] button',
    '[data-e2e="browse-follow"]',
    'button[data-e2e="feed-follow"]',
    '[data-e2e="feed-follow"] button',
    '[data-e2e="feed-follow"]',
    'button[data-e2e="video-follow"]',
    '[data-e2e="video-follow"]',
    'button[data-e2e="follow-button"]',
    '[data-e2e="follow-button"]',
  ],
  commentOpen: [
    '[data-e2e="browse-comment-icon"]',
    '[data-e2e="comment-icon"]',
    '[data-e2e="video-comment-icon"]',
    'button[aria-label*="Comment"]',
    'button[aria-label*="评论"]',
  ],
  commentInput: [
    '[data-e2e="comment-input"]',
    '[data-e2e="comment-text"]',
    '[data-e2e="comment-input"] [contenteditable="true"]',
    '[data-e2e="comment-input"] div[contenteditable="true"]',
    'div[contenteditable="true"][data-e2e*="comment"]',
    '[placeholder="Add comment..."]',
    '[placeholder*="Add comment" i]',
    '[placeholder*="添加评论"]',
    '[placeholder*="写评论"]',
    'textarea[placeholder*="Add comment" i]',
    'textarea[placeholder*="comment" i]',
    'textarea[placeholder*="评论"]',
    'div[contenteditable="true"][placeholder*="comment" i]',
    'div[contenteditable="true"][data-placeholder*="comment" i]',
  ],
  commentPost: [
    '[data-e2e="comment-post"]',
    'button[data-e2e="comment-post"]',
    '[data-e2e="comment-post-button"]',
    'button[data-e2e="comment-post-button"]',
    'button[aria-label*="Post" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发布" i]',
    'button[aria-label*="发送" i]',
  ],
  // 仅 Cookie/同意类；禁止 Close —— 会误关视频浏览层导致「打开又秒关」
  dismiss: [
    'button:has-text("Accept all")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Allow all")',
    'button:has-text("Got it")',
    'button:has-text("允许全部")',
    'button:has-text("同意全部")',
    'button:has-text("我知道了")',
  ],
  /** 浏览态右侧「下一条」箭头（UI 为向下三角，DOM 常为 arrow-right） */
  nextVideo: [
    'button[data-e2e="arrow-right"]',
    '[data-e2e="arrow-right"]',
    'button[data-e2e="arrow-down"]',
    '[data-e2e="arrow-down"]',
    'button[data-e2e="browse-arrow-down"]',
    '[data-e2e="browse-arrow-down"]',
    'button[aria-label*="Next video" i]',
    'button[aria-label*="Go to next" i]',
    'button[aria-label*="下一个" i]',
    'button[aria-label*="下一条" i]',
  ],
};

/* ───────── utils ───────── */

const {
  humanPause,
  randInt,
  sleep: delay,
  typeDelay,
  clickHoldMs,
} = require('../human-pace');
const {
  scaleTimeout,
  waitDocumentReady,
  waitPageSettled,
  waitSearchContent,
  detectProxyErrorPage,
  recoverProxyErrorPage,
  detectRawDocumentPage,
} = require('./page-ready');

function splitTerms(text) {
  if (Array.isArray(text)) {
    return text.map((x) => String(x || '').trim()).filter(Boolean);
  }
  return String(text || '')
    .split(/[\r\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSearchUrl(term) {
  // 仅作兜底；主流程走首页搜索框，不直接深链视频详情
  return `https://www.tiktok.com/search/video?q=${encodeURIComponent(String(term || '').trim())}`;
}

function countByRate(total, rate) {
  const n = Number(total) || 0;
  const r = Math.max(0, Math.min(100, Number(rate) || 0));
  if (n < 1 || r < 1) return 0;
  return Math.floor((n * r) / 100);
}

function pickIndices(total, need) {
  const n = Math.max(0, Number(total) || 0);
  const k = Math.min(n, Math.max(0, Number(need) || 0));
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return new Set(all.slice(0, k));
}

function logWarm(accountId, msg, extra = {}) {
  const line = `[warm#${accountId}] ${msg}`;
  try {
    const { publish } = require('../live-log');
    publish(line, 'info', { accountId, ...extra });
  } catch {
    console.log(line, extra && Object.keys(extra).length ? extra : '');
  }
}

/* ───────── plan ───────── */

function pickCommentConfig(cfg = {}) {
  const mode = String(cfg.commentMode || 'fixed').toLowerCase() === 'ai' ? 'ai' : 'fixed';
  let texts = [];
  if (Array.isArray(cfg.commentTexts)) {
    texts = cfg.commentTexts.map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (!texts.length && cfg.commentText) {
    texts = [String(cfg.commentText).trim()].filter(Boolean);
  }
  if (!texts.length) texts = [DEFAULT_COMMENT_TEXT];
  return {
    commentMode: mode,
    commentTexts: texts,
    commentText: texts[0],
    commentAiTemplateId: Number(cfg.commentAiTemplateId || 0) || 0,
    commentAiPrompt: String(cfg.commentAiPrompt || '').trim(),
  };
}

function buildExecutionPlanLocal(cfg = {}) {
  const terms = splitTerms(cfg.searchTerms);
  const commentCfg = pickCommentConfig(cfg);
  if (!terms.length) {
    return { videoTotal: 0, keywords: [], ...commentCfg };
  }
  const minV = Math.max(1, Math.min(100, Number(cfg.videoCountMin || 10)));
  const maxV = Math.max(minV, Math.min(100, Number(cfg.videoCountMax || 20)));
  const stayMin = Math.max(1, Math.min(300, Number(cfg.staySecondsMin || 30)));
  const stayMax = Math.max(stayMin, Math.min(300, Number(cfg.staySecondsMax || 50)));
  const likeRate = Number(cfg.likeRate || 0);
  const commentRate = Number(cfg.commentRate ?? cfg.viewCommentRate ?? 0);
  const followRate = Number(cfg.followRate || 0);
  const favoriteRate = Number(cfg.favoriteRate || 0);
  const viewCommentRate = Number(cfg.viewCommentRate || 0);
  const commentLikeRate = Number(cfg.commentLikeRate || 0);

  const videoTotal = randInt(minV, maxV);
  const n = terms.length;
  const base = Math.floor(videoTotal / n);
  const rem = videoTotal % n;

  const keywords = terms.map((term, i) => {
    const videoCount = base + (i < rem ? 1 : 0);
    const likeSet = pickIndices(videoCount, countByRate(videoCount, likeRate));
    const commentSet = pickIndices(videoCount, countByRate(videoCount, commentRate));
    const followSet = pickIndices(videoCount, countByRate(videoCount, followRate));
    const favoriteSet = pickIndices(videoCount, countByRate(videoCount, favoriteRate));
    const viewSet = pickIndices(videoCount, countByRate(videoCount, viewCommentRate));
    const cLikeSet = pickIndices(videoCount, countByRate(videoCount, commentLikeRate));
    const videos = [];
    for (let j = 0; j < videoCount; j++) {
      const doComment = commentSet.has(j);
      videos.push({
        index: j,
        staySeconds: randInt(stayMin, stayMax),
        like: likeSet.has(j),
        comment: doComment,
        follow: followSet.has(j),
        favorite: favoriteSet.has(j),
        viewComments: doComment || viewSet.has(j),
        commentLike: cLikeSet.has(j),
      });
    }
    return {
      term,
      videoCount,
      likeCount: videos.filter((v) => v.like).length,
      commentCount: videos.filter((v) => v.comment).length,
      videos,
    };
  });

  return {
    videoTotal,
    ...commentCfg,
    keywords,
    generatedAt: nowChinaIso(),
    source: 'local-fallback',
  };
}

/**
 * 对齐 videoCount 与 videos[]：缺行补「仅停留」，避免抬头 9 条实际只有 4 步。
 */
function normalizeKeywordVideos(kw, cfg = {}) {
  const stayMin = Math.max(1, Number(cfg.staySecondsMin || 30));
  const stayMax = Math.max(stayMin, Number(cfg.staySecondsMax || 50));
  let videos = [];
  if (Array.isArray(kw?.videos)) {
    videos = kw.videos.slice();
  } else if (kw?.videos && typeof kw.videos === 'object') {
    videos = Object.keys(kw.videos)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => kw.videos[k])
      .filter(Boolean);
  }
  const declared = Math.max(0, Number(kw?.videoCount || 0));
  const target = Math.max(videos.length, declared);
  while (videos.length < target) {
    const i = videos.length;
    videos.push({
      index: i,
      staySeconds: randInt(stayMin, stayMax),
      like: false,
      comment: false,
      follow: false,
      favorite: false,
      viewComments: false,
      commentLike: false,
    });
  }
  return {
    ...kw,
    term: String(kw?.term || '').trim(),
    videoCount: videos.length,
    videos,
    likeCount: videos.filter((v) => v?.like).length,
    commentCount: videos.filter((v) => v?.comment).length,
  };
}

function resolvePlan(cfg = {}) {
  const plan = cfg.executionPlan;
  if (plan && Array.isArray(plan.keywords) && plan.keywords.length) {
    const keywords = plan.keywords.map((kw) => normalizeKeywordVideos(kw, cfg));
    const videoTotal = keywords.reduce((s, k) => s + Number(k.videoCount || 0), 0);
    const commentCfg = pickCommentConfig({ ...cfg, ...plan });
    return {
      ...plan,
      ...commentCfg,
      keywords,
      videoTotal: Number(plan.videoTotal || videoTotal) || videoTotal,
      source: plan.source || 'payload',
    };
  }
  return buildExecutionPlanLocal(cfg);
}

/** 浏览态当前视频元信息（供 AI 评论） */
async function readBrowseVideoMeta(page) {
  try {
    return await page.evaluate(() => {
      const text = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
      const desc =
        text('[data-e2e="browse-video-desc"]') ||
        text('[data-e2e="video-desc"]') ||
        text('h1[data-e2e="browse-video-desc"]') ||
        text('[class*="DivDescriptionContentContainer"]');
      const author =
        text('[data-e2e="browse-user-nickname"]') ||
        text('[data-e2e="video-author-uniqueid"]') ||
        text('[data-e2e="browse-username"]') ||
        text('a[data-e2e="browse-user-avatar"] + *');
      const like =
        text('[data-e2e="browse-like-count"]') ||
        text('[data-e2e="like-count"]');
      const comments =
        text('[data-e2e="browse-comment-count"]') ||
        text('[data-e2e="comment-count"]');
      return {
        video_desc: desc,
        author,
        like_count: like,
        comment_count: comments,
        video_url: location.href,
      };
    });
  } catch {
    return { video_desc: '', author: '', video_url: '' };
  }
}

/**
 * 按计划取本条评论文案：固定池随机 / AI 英文
 * AI 模式：必须等接口成功返回有效文案；失败重试后仍无结果则返回空串（禁止空开评论栏）
 */
async function resolveCommentText(page, ctx = {}) {
  const mode = String(ctx.commentMode || 'fixed').toLowerCase();
  const fallback = String(ctx.commentText || DEFAULT_COMMENT_TEXT);
  if (mode !== 'ai') {
    const pool = Array.isArray(ctx.commentTexts) ? ctx.commentTexts.filter(Boolean) : [];
    if (pool.length) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    return fallback;
  }

  const phpApi = require('../php-api');
  const meta = await readBrowseVideoMeta(page);
  const payload = {
    prompt: ctx.commentAiPrompt || '',
    templateId: ctx.commentAiTemplateId || 0,
    variables: meta,
  };
  const attempts = 2;
  for (let i = 1; i <= attempts; i++) {
    try {
      logWarm(ctx.accountId || 0, `等待 AI 生成评论 (${i}/${attempts})…`);
      const data = await phpApi.post('/node/warm/ai-comment', payload);
      const comment = String(data?.comment || '').trim();
      if (comment) {
        logWarm(ctx.accountId || 0, `AI 评论已就绪: ${comment.slice(0, 80)}`);
        return comment;
      }
      logWarm(ctx.accountId || 0, `AI 评论返回空文案 (${i}/${attempts})`);
    } catch (e) {
      logWarm(ctx.accountId || 0, `AI 评论失败 (${i}/${attempts}): ${e.message || e}`);
    }
    if (i < attempts) await humanPause(1200, 0.2);
  }
  // AI 模式不回退固定文案，避免打开空白评论栏后「假发送」
  return '';
}

/* ───────── page helpers ───────── */

async function dismissOverlays(page, { escape = false } = {}) {
  try {
    const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }
  for (const sel of SELECTORS.dismiss) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 1200 }).catch(() => {});
        await humanPause(400, 0.2);
      }
      } catch { /* ignore */ }
    }
  // 默认不按 Escape：浏览态被 Escape 会直接缩小/关掉视频层
  if (escape) {
    await page.keyboard.press('Escape').catch(() => {});
    await humanPause(200, 0.2);
  }
}

function urlLooksLike(target, actual) {
  try {
    const t = new URL(target);
    const a = new URL(actual);
    if (t.hostname.replace(/^www\./, '') !== a.hostname.replace(/^www\./, '')) return false;
    if ((t.pathname === '/' || t.pathname === '') && (a.pathname === '/' || a.pathname === '')) return true;
    if (t.pathname.includes('/search') && a.pathname.includes('/search')) return true;
    return a.pathname.startsWith(t.pathname) || a.href.startsWith(t.origin + t.pathname);
  } catch {
    return String(actual || '').includes(String(target || '').split('?')[0]);
  }
}

async function clickFirstVisible(page, selectors, { timeout = 2000 } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout });
      return true;
    } catch { /* next */ }
  }
  return false;
}

async function clickByPatterns(page, patterns, { timeout = 2500 } = {}) {
  const targets = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const target of targets) {
    for (const pattern of patterns) {
      try {
        const btn = target.getByRole('button', { name: pattern }).first();
        if ((await btn.count()) && (await btn.isVisible())) {
          await btn.click({ timeout });
          return true;
        }
      } catch { /* continue */ }
      try {
        const el = target.getByText(pattern).first();
        if ((await el.count()) && (await el.isVisible())) {
          await el.click({ timeout });
          return true;
        }
      } catch { /* continue */ }
    }
  }
  return false;
}

async function waitVideoReady(page, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const ok = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && (v.readyState >= 2 || v.currentTime > 0)) return true;
      if (document.querySelector('[data-e2e="browse-video"], [data-e2e="video-player"], [data-e2e="browse-video-desc"]')) return true;
      if (/\/video\/\d+/.test(location.pathname)) return true;
      return false;
    }).catch(() => false);
    if (ok) return true;
    await humanPause(500, 0.2);
  }
  return false;
}

/**
 * 浏览态视频指纹（多信号）。禁止用搜索网格 / #one-column-item-0 的固定首条链接。
 */
async function readBrowseFingerprint(page) {
  return page.evaluate(() => {
    const parts = [];
    const href = location.href || '';
    const um = href.match(/\/@([^/?#]+)\/video\/(\d+)/);
    if (um) parts.push(`url:${um[1]}/${um[2]}`);
    else {
      const um2 = href.match(/\/video\/(\d+)/);
      if (um2) parts.push(`url:${um2[1]}`);
    }

    const textOf = (sel) => {
      const el = document.querySelector(sel);
      return (el?.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const author = textOf('[data-e2e="browse-user-nickname"]')
      || textOf('[data-e2e="video-author-uniqueid"]')
      || textOf('[data-e2e="browse-username"]')
      || textOf('[data-e2e="user-title"]');
    const desc = textOf('[data-e2e="browse-video-desc"]') || textOf('[data-e2e="video-desc"]');
    const likes = textOf('[data-e2e="browse-like-count"]') || textOf('[data-e2e="like-count"]');
    const cmt = textOf('[data-e2e="browse-comment-count"]') || textOf('[data-e2e="comment-count"]');
    if (author) parts.push(`a:${author.slice(0, 48)}`);
    if (desc) parts.push(`d:${desc.slice(0, 72)}`);
    if (likes) parts.push(`l:${likes}`);
    if (cmt) parts.push(`c:${cmt}`);

    // 仅从浏览层内取 /video/ 链接（不要整页 querySelector）
    const browseRoot = document.querySelector('[data-e2e="browse-video"]')
      || document.querySelector('[class*="DivBrowserModeContainer"]')
      || document.querySelector('[class*="DivPlayerContainer"]');
    if (browseRoot) {
      const a = browseRoot.querySelector('a[href*="/video/"]');
      const mm = String(a?.href || a?.getAttribute?.('href') || '').match(/\/video\/(\d+)/);
      if (mm) parts.push(`href:${mm[1]}`);
      const ua = browseRoot.querySelector('a[href*="/@"]');
      const um3 = String(ua?.href || '').match(/\/@([^/?#]+)/);
      if (um3) parts.push(`user:${um3[1]}`);
    }

    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area < 80 * 80) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    if (best) {
      parts.push(`src:${(best.currentSrc || best.src || '').slice(-80)}`);
      parts.push(`dur:${Number.isFinite(best.duration) ? best.duration.toFixed(2) : '?'}`);
      parts.push(`dim:${best.videoWidth}x${best.videoHeight}`);
    }

    return parts.join('||') || href;
  }).catch(() => '');
}

/** @deprecated 兼容旧调用名 */
async function readCurrentVideoKey(page) {
  return readBrowseFingerprint(page);
}

async function waitFingerprintChange(page, before, timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const after = await readBrowseFingerprint(page);
    if (after && after !== before) return after;
    // 视频导航事件（blob 源不变时的兜底）
    const nav = await page.evaluate(() => !!window.__warmVideoNav).catch(() => false);
    if (nav) {
      await humanPause(600, 0.1);
      const after2 = await readBrowseFingerprint(page);
      if (after2 && after2 !== before) return after2;
      // 事件已触发但文案尚未刷新：仍视为已翻页
      return after2 || `${String(before)}__nav`;
    }
    await humanPause(280, 0.08);
  }
  return '';
}

/**
 * 拟人停留：只等待，不滚轮（滚轮易把搜索浏览 swiper 弄到半态，导致后续下箭头失灵）
 */
async function watchVideo(page, staySeconds) {
  const total = Math.max(1, Number(staySeconds) || 10) * 1000;
  const slices = Math.max(2, Math.min(6, Math.round(total / 4000)));
  const slice = total / slices;
  for (let i = 0; i < slices; i++) {
    await humanPause(slice, 0.12);
  }
}

/** 翻页前关掉评论侧栏（禁止 Escape，以免关掉整个浏览层） */
async function closeCommentPanel(page) {
  const open = await page.locator(
    '[data-e2e="comment-input"], [placeholder*="Add comment" i], [data-e2e="comment-list"], [class*="DivCommentContainer"]'
  ).first().isVisible().catch(() => false);
  if (!open) return false;

  // 再点一次评论图标 = 收起
  const toggled = await clickFirstVisible(page, [
    '[data-e2e="browse-comment-icon"]',
    '[data-e2e="comment-icon"]',
    'button[data-e2e="browse-comment-icon"]',
  ], { timeout: 1500 });
  if (toggled) {
    await humanPause(450, 0.15);
    return true;
  }

  // 点视频中央夺回焦点（不按 Escape）
  const box = await page.evaluate(() => {
    const v = document.querySelector('[data-e2e="browse-video"] video, video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 40) return null;
    return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.45 };
  }).catch(() => null);
  if (box) {
    await page.mouse.click(box.x, box.y).catch(() => {});
    await humanPause(350, 0.15);
  }
  return true;
}

async function assertPageAlive(page, step = '') {
  if (!page || page.isClosed?.()) {
    throw new Error(`浏览器页面已关闭${step ? `（${step}）` : ''}，无法继续养号`);
  }
}

function isTransientNavError(err) {
  const msg = String(err?.message || err || '');
  return /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_PROXY|ERR_SOCKS|ERR_TUNNEL|ERR_SSL|Timeout|Target page|has been closed|Browser has been closed|Navigation failed|代理连接失败|网络错误/i.test(msg);
}

/**
 * 在当前 context 上取可用 page（原 page 关掉时新建）
 */
async function ensureLivePage(connection) {
  if (!connection) throw new Error('无浏览器连接');
  let page = connection.page;
  if (page && !page.isClosed?.()) return page;

  const context = connection.context || connection.browser?.contexts?.()?.[0];
  if (!context) throw new Error('浏览器上下文已失效，请检查浏览器环境是否被关闭');

  const existing = (context.pages?.() || []).find((p) => p && !p.isClosed?.());
  if (existing) {
    connection.page = existing;
    await existing.bringToFront().catch(() => {});
    return existing;
  }
  const fresh = await context.newPage();
  connection.page = fresh;
  return fresh;
}

/**
 * 带重试的导航：goto 后校验真实 URL；未跳转则 location.assign 强制跳
 */
async function safeGoto(connection, url, {
  accountId = 0,
  retries = 3,
  waitUntil = 'domcontentloaded',
  timeout = 90000,
  label = '导航',
  settle = true,
} = {}) {
  const navTimeout = scaleTimeout(timeout, 60000);
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      let page = await ensureLivePage(connection);
      const cur0 = (() => { try { return page.url() || ''; } catch { return ''; } })();
      if (url === HOME_URL && /^https?:\/\/(www\.)?tiktok\.com\/?(\?|#|$)/i.test(cur0)) {
        logWarm(accountId, `${label}: 已在首页，跳过重复打开`);
        if (settle) {
          await waitPageSettled(page, {
            timeoutMs: 25000,
            label,
            log: (m) => logWarm(accountId, m),
          });
        }
        return page;
      }
      if (urlLooksLike(url, cur0) && /\/search\//i.test(cur0)) {
        logWarm(accountId, `${label}: 已在目标页 ${cur0}`);
        if (settle) {
          await waitPageSettled(page, {
            timeoutMs: 35000,
            contentSelectors: [
              '[data-e2e="search_video-item"]',
              'a[href*="/video/"]',
              '[data-e2e="search-user-container"]',
            ],
            label,
            log: (m) => logWarm(accountId, m),
          });
        }
        return page;
      }

      logWarm(accountId, `${label}: goto ${url} (第 ${i}/${retries} 次，超时 ${Math.round(navTimeout / 1000)}s)`);
      try {
        await page.goto(url, { waitUntil, timeout: navTimeout });
      } catch (gotoErr) {
        lastErr = gotoErr;
        logWarm(accountId, `${label} goto 异常: ${String(gotoErr.message || gotoErr).slice(0, 120)}`);
      }

      await waitDocumentReady(page, 12000);
      await humanPause(1000, 0.15);
      page = await ensureLivePage(connection);
      let cur = (() => { try { return page.url() || ''; } catch { return ''; } })();

      // 深链偶发返回 application/json / i18n 字典当正文：刷新后再验
      if (await detectRawDocumentPage(page)) {
        logWarm(accountId, `${label}: 检测到原始 JSON/乱码文档，刷新重试`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(navTimeout, 60000) }).catch(() => {});
        await waitDocumentReady(page, 12000);
        await humanPause(1200, 0.15);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
        if (await detectRawDocumentPage(page)) {
          throw new Error(`导航后页面为原始 JSON/i18n 乱码（非 HTML UI）url=${cur}`);
        }
      }

      if (!urlLooksLike(url, cur)) {
        logWarm(accountId, `${label}: 地址未真正跳转(当前 ${cur})，改用 location.assign`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(navTimeout, 60000) }).catch(() => null),
          page.evaluate((u) => { window.location.assign(u); }, url),
        ]);
        await humanPause(1200, 0.15);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
      }

      if (!urlLooksLike(url, cur)) {
        await page.evaluate((u) => { window.location.href = u; }, url);
        await humanPause(2500, 0.15);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
      }

      if (!urlLooksLike(url, cur)) {
        throw new Error(`导航后仍停留在 ${cur || '(空)'}，目标 ${url}`);
      }

      // 高延迟代理中途抖成错误页：退避重开，不当作永久失败
      const netCode = await detectProxyErrorPage(page);
      if (netCode) {
        logWarm(accountId, `${label}: 导航后出现 ${netCode}，尝试恢复`);
        await recoverProxyErrorPage(page, {
          url,
          attempts: 3,
          label,
          log: (m) => logWarm(accountId, m),
        });
        const still = await detectProxyErrorPage(page);
        if (still) throw new Error(`代理/网络错误页 ${still}`);
        page = await ensureLivePage(connection);
        cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
      }

      if (settle) {
        await waitPageSettled(page, {
          timeoutMs: /\/search\//i.test(cur) ? 40000 : 25000,
          contentSelectors: /\/search\//i.test(cur)
            ? ['[data-e2e="search_video-item"]', 'a[href*="/video/"]', '[data-e2e*="search"]']
            : ['[data-e2e]', 'main', 'header'],
          reloadOnce: i >= retries,
          label,
          log: (m) => logWarm(accountId, m),
        });
      }

      connection.page = page;
      logWarm(accountId, `${label}: 已到达 ${cur}`);
      return page;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      logWarm(accountId, `${label}失败: ${msg.slice(0, 160)}`);
      if (i >= retries) break;
      if (!isTransientNavError(err) && !/仍停留|未真正跳转/i.test(msg) && i >= 2) break;
      await humanPause(2000 * i, 0.1);
      try {
        const context = connection.context || connection.browser?.contexts?.()?.[0];
        if (context) {
          const p = await context.newPage();
          connection.page = p;
        }
      } catch { /* ignore */ }
    }
  }
  throw new Error(
    `${label}失败（已重试 ${retries} 次）: ${lastErr?.message || lastErr}。请检查代理/网络是否能打开 TikTok`
  );
}

async function gotoHome(connection, accountId = 0) {
  const page = await safeGoto(connection, HOME_URL, {
    accountId,
    retries: 4,
    label: '打开首页',
  });
  await humanPause(2200, 0.25);
  await dismissOverlays(page);
  await humanPause(800, 0.2);
  await dismissOverlays(page);
  return page;
}

function isUsableInput(el) {
  return el.evaluate((n) => {
    if (!n) return false;
    const st = window.getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    // 允许 opacity 很低的未展开搜索框，只要在布局里有尺寸
    const r = n.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    if (n.disabled) return false;
    return true;
  }).catch(() => false);
}

async function clickSearchTriggers(page) {
  for (const sel of SELECTORS.searchTrigger) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 2000 }).catch(() => {});
      await humanPause(400, 0.2);
    } catch { /* next */ }
  }
  // 顶栏放大镜文案
  await page.getByRole('button', { name: /search|搜索/i }).first().click({ timeout: 1500 }).catch(() => {});
  await humanPause(300, 0.2);
}

async function findSearchInputOnce(page) {
  for (const sel of SELECTORS.searchInput) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (!(await isUsableInput(el))) continue;
      return el;
    } catch { /* next */ }
  }
  // Playwright placeholder
  const byPh = page.getByPlaceholder(/search|搜索/i).first();
  if ((await byPh.count().catch(() => 0)) && (await isUsableInput(byPh))) return byPh;

  // DOM 扫描：顶栏附近的 input
  const handle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input')];
    const scored = [];
    for (const n of inputs) {
      const st = window.getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (r.width < 20 || r.height < 10) continue;
      if (n.disabled) continue;
      const ph = `${n.placeholder || ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('data-e2e') || ''}`.toLowerCase();
      const type = (n.type || '').toLowerCase();
      let score = 0;
      if (/search|搜索/.test(ph)) score += 50;
      if (type === 'search') score += 30;
      if (n.name === 'q') score += 20;
      if (/search/.test(n.getAttribute('data-e2e') || '')) score += 40;
      if (r.top < 120) score += 15; // 顶栏
      if (r.width > 120) score += 10;
      if (score > 0) scored.push({ n, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.n || null;
  });
  const el = handle.asElement?.();
  if (el) {
    // 包成 locator 不便，直接返回 element handle 包装：用 page.locator 根据唯一属性
    const meta = await el.evaluate((n) => ({
      e2e: n.getAttribute('data-e2e') || '',
      name: n.getAttribute('name') || '',
      ph: n.getAttribute('placeholder') || '',
      type: n.getAttribute('type') || '',
    })).catch(() => null);
    if (meta?.e2e) {
      const loc = page.locator(`input[data-e2e="${meta.e2e}"]`).first();
      if (await loc.count()) return loc;
    }
    if (meta?.ph) {
      const loc = page.getByPlaceholder(meta.ph).first();
      if (await loc.count()) return loc;
    }
    if (meta?.name) {
      const loc = page.locator(`input[name="${meta.name}"]`).first();
      if (await loc.count()) return loc;
    }
  }
  return null;
}

async function findSearchInput(page, { timeoutMs = 15000 } = {}) {
  await assertPageAlive(page, '找搜索框');
  const end = Date.now() + timeoutMs;
  let triedTrigger = false;
  while (Date.now() < end) {
    let input = await findSearchInputOnce(page);
    if (input) return input;
    if (!triedTrigger) {
      await clickSearchTriggers(page);
      triedTrigger = true;
      input = await findSearchInputOnce(page);
      if (input) return input;
    }
    await dismissOverlays(page);
    await humanPause(600, 0.15);
  }
  return null;
}

/**
 * 展开顶栏搜索并填入关键词（TikTok 的 input 常在 DOM 里但未 visible，需先点容器）
 */
async function revealAndFillSearch(page, term, accountId = 0) {
  const q = String(term || '').trim();
  // 1) 先点搜索容器 / 放大镜，把隐藏 input 展开
  await clickSearchTriggers(page);
  const boxSelectors = [
    '[data-e2e="search-box"]',
    'form[data-e2e="search-box"]',
    'form[action*="search"]',
    '[data-e2e="nav-search"]',
    'header form',
  ];
  for (const sel of boxSelectors) {
    try {
      const box = page.locator(sel).first();
      if (!(await box.count())) continue;
      await box.click({ timeout: 2000 }).catch(async () => {
        await box.click({ timeout: 2000, force: true }).catch(() => {});
      });
      await humanPause(400, 0.2);
    } catch { /* next */ }
  }

  const input = page.locator('input[data-e2e="search-user-input"], input[placeholder*="Search" i], input[type="search"][name="q"]').first();
  // 2) 等变为可见（最多 5s）
  const visible = await input.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

  if (visible) {
    await input.click({ timeout: 3000 }).catch(() => input.click({ force: true, timeout: 3000 }));
    await humanPause(200, 0.2);
    await input.fill('');
    await input.type(q, { delay: typeDelay(80, 160) });
    await humanPause(400, 0.2);
    await page.keyboard.press('Enter');
    logWarm(accountId, '搜索框已展开并提交');
    return true;
  }

  // 3) 仍不可见：force 聚焦 + 写入 value / 键盘
  if (await input.count().catch(() => 0)) {
    logWarm(accountId, '搜索框存在但不可见，改用 force 输入');
    await input.click({ force: true, timeout: 3000 }).catch(() => {});
    await input.focus({ force: true }).catch(() => {});
    await humanPause(200, 0.2);
    try {
      await input.fill(q, { force: true, timeout: 3000 });
    } catch {
      await input.evaluate((el, value) => {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, q).catch(() => {});
    }
    await humanPause(300, 0.2);
    await page.keyboard.press('Enter');
    // 勿用裸 button[type=submit]：未登录页会命中禁用的 data-e2e="login-button" 并卡死
    await page.locator(
      '[data-e2e="search-box"] button:not([data-e2e="login-button"]), button[aria-label*="Search" i], form[action*="search"] button[type="submit"]'
    ).first().click({ force: true, timeout: 2000 }).catch(() => {});
    return true;
  }

  return false;
}

/**
 * 深链搜索若落到「整页 i18n/JSON 乱码」：刷新一次；仍坏则回首页用搜索框提交。
 */
async function recoverFromRawSearchPage(connection, term, accountId = 0) {
  let page = await ensureLivePage(connection);
  if (!(await detectRawDocumentPage(page))) return page;

  logWarm(accountId, '搜索页呈现原始 JSON/i18n 乱码，先刷新');
  await capture(page, `warm-raw-json-${accountId}`).catch(() => '');
  await page.reload({
    waitUntil: 'domcontentloaded',
    timeout: scaleTimeout(75000, 50000),
  }).catch(() => {});
  await waitDocumentReady(page, 12000);
  await humanPause(1800, 0.2);
  page = await ensureLivePage(connection);
  if (!(await detectRawDocumentPage(page))) {
    logWarm(accountId, '刷新后乱码页已恢复');
    return page;
  }

  logWarm(accountId, '刷新仍乱码，改走首页搜索框');
  page = await gotoHome(connection, accountId);
  await humanPause(1200, 0.2);
  const filled = await revealAndFillSearch(page, term, accountId);
  if (!filled) {
    throw new Error('搜索页乱码且首页搜索框不可用');
  }
  await humanPause(2500, 0.25);
  page = await ensureLivePage(connection);
  await waitPageSettled(page, {
    timeoutMs: 40000,
    contentSelectors: [
      '[data-e2e="search_video-item"]',
      'a[href*="/video/"]',
      '[data-e2e="search-user-input"]',
      '[data-e2e*="search"]',
    ],
    reloadOnce: true,
    label: '首页搜索落地',
    log: (m) => logWarm(accountId, m),
  });
  if (await detectRawDocumentPage(page)) {
    await capture(page, `warm-raw-json-ui-${accountId}`).catch(() => '');
    throw new Error(`搜索结果仍为原始 JSON/乱码页 url=${page.url()}`);
  }
  return page;
}

/**
 * 首页就绪后直达视频搜索结果页（不依赖顶栏；goto 失败会 location.assign）
 * 若深链返回 JSON/i18n 乱码文档，自动刷新并回退到顶栏搜索框。
 */
async function searchKeywordFromHome(connection, term, accountId = 0) {
  const q = String(term || '').trim();
  if (!q) throw new Error('空搜索词');

  // 先确保比特在 TikTok 域（首页）
  let page = await ensureLivePage(connection);
  let url = '';
  try { url = page.url() || ''; } catch { url = ''; }
  if (!/tiktok\.com/i.test(url)) {
    page = await gotoHome(connection, accountId);
  }

  const searchVideoUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(q)}`;
  const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`;

  // 主路径：直接进视频搜索结果（避免顶栏“只改地址栏不跳转”）
  logWarm(accountId, `打开视频搜索结果 q=${q}`);
  page = await safeGoto(connection, searchVideoUrl, {
    accountId,
    retries: 4,
    label: '打开视频搜索',
  });
  await humanPause(2000, 0.25);
  await dismissOverlays(page, { escape: false });

  page = await ensureLivePage(connection);
  if (await detectRawDocumentPage(page)) {
    page = await recoverFromRawSearchPage(connection, q, accountId);
  }

  let onSearch = /\/search\//i.test(page.url() || '');
  if (!onSearch && !(await detectRawDocumentPage(page))) {
    logWarm(accountId, 'video 搜索未落地，改试 /search?q=');
    page = await safeGoto(connection, searchUrl, {
      accountId,
      retries: 3,
      label: '打开综合搜索',
    });
    await humanPause(2000, 0.25);
    await dismissOverlays(page, { escape: false });
    page = await ensureLivePage(connection);
    if (await detectRawDocumentPage(page)) {
      page = await recoverFromRawSearchPage(connection, q, accountId);
    }
    onSearch = /\/search\//i.test(page.url() || '');
  }

  if (await detectRawDocumentPage(page)) {
    await capture(page, `warm-raw-json-final-${accountId}`).catch(() => '');
    throw new Error(`搜索页为原始 JSON/i18n 乱码（非正常 TikTok UI）url=${page.url()}`);
  }

  if (!onSearch) {
    const hasResults = await page.locator('a[href*="/video/"], [data-e2e="search_video-item"], [data-e2e="search-video"]').first()
      .isVisible().catch(() => false);
    if (!hasResults) {
      await capture(page, 'warm-no-search-result').catch(() => '');
      throw new Error(`搜索后未进入结果页（当前 ${page.url()}）`);
    }
  }

  logWarm(accountId, `已在搜索结果 url=${page.url()}`);
  return page;
}

async function clickVideosTab(page) {
  await assertPageAlive(page, '切 Videos Tab');
  await humanPause(800, 0.2);

  // 多次尝试，等 Tab 渲染
  for (let round = 0; round < 4; round++) {
    if (await clickFirstVisible(page, SELECTORS.videosTab, { timeout: 2000 })) {
      await humanPause(1800, 0.25);
      return true;
    }
    const byRole = page.getByRole('tab', { name: /Videos|视频|影片/i }).first();
    if ((await byRole.count().catch(() => 0)) && (await byRole.isVisible().catch(() => false))) {
      await byRole.click({ timeout: 2500 }).catch(() => {});
      await humanPause(1800, 0.25);
      return true;
    }
    if (await clickByPatterns(page, [/^Videos$/i, /^视频$/, /^影片$/], { timeout: 2000 })) {
      await humanPause(1800, 0.25);
      return true;
    }
    if (/\/search\/video/i.test(page.url() || '')) return true;
    await humanPause(700, 0.2);
  }
  return /\/search\/video/i.test(page.url() || '');
}

/**
 * TikTok 搜索页滑块 / 拼图人机验证（常见文案：Drag the slider to fit the puzzle）
 * 有验证时结果区只有骨架屏，不能当成「关键词无视频」。
 */
async function detectCaptchaChallenge(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '').slice(0, 12000);
    if (/Drag the slider to fit the puzzle|Verify to continue|verify you.?re (a )?human|Security check|人机验证|安全验证|拖动滑块|完成拼图|请完成验证/i.test(text)) {
      return true;
    }
    const nodes = document.querySelectorAll([
      '#captcha-verify-container',
      '.captcha_verify_container',
      '[id*="captcha"]',
      '[class*="captcha"]',
      '[class*="Captcha"]',
      'iframe[src*="captcha"]',
      'iframe[src*="verify"]',
      '[aria-label*="captcha" i]',
      '[aria-label*="verify" i]',
    ].join(','));
    for (const el of nodes) {
      const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      if (r.width > 80 && r.height > 60) return true;
      // iframe 无 getBoundingClientRect 时仍视为存在
      if (el.tagName === 'IFRAME') return true;
    }
    return false;
  }).catch(() => false);
}

/**
 * 检测到验证码：短等片刻（可能自动消失），否则立即返回 need_manual，由人工验证队列暂停任务。
 * @returns {'cleared'|'timeout'|'absent'|'need_manual'}
 */
async function waitForCaptchaClear(page, accountId = 0, timeoutMs = 180000) {
  if (!(await detectCaptchaChallenge(page))) return 'absent';
  // 省流会拦拼图/验证码图片：检测到验证后立刻临时关闭省流，方便人工处理
  try {
    const { pauseSaveTrafficForCaptcha, resumeSaveTrafficAfterCaptcha } = require('./save-traffic');
    await pauseSaveTrafficForCaptcha(page);
    page.__tkResumeSaveTrafficAfterCaptcha = resumeSaveTrafficAfterCaptcha;
  } catch { /* ignore */ }
  logWarm(
    accountId,
    '检测到 TikTok 人机验证（滑块/拼图），正在尝试 NoCaptchaAI 自动识别过码（已临时关闭省流以便显示验证图片）…'
  );
  await capture(page, `warm-captcha-${accountId}`).catch(() => '');
  const resumeIfCleared = async () => {
    try {
      const resume = page.__tkResumeSaveTrafficAfterCaptcha;
      if (typeof resume === 'function') await resume(page);
    } catch { /* ignore */ }
  };
  // 留足时间让关闭省流后的旋转图片加载 + NoCaptchaAI 3 次识别重试完成
  const briefMs = Math.min(35000, Math.max(18000, Number(timeoutMs) || 0) || 25000);
  const end = Date.now() + briefMs;
  while (Date.now() < end) {
    await assertPageAlive(page, '等待验证码完成').catch(() => {});
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      const rot = await solveRotateCaptchaIfPresent(page, { accountId });
      if (rot?.detected && rot?.solved) {
        logWarm(accountId, 'NoCaptchaAI 旋转图片验证已通过，继续');
        await resumeIfCleared();
        await humanPause(800, 0.2);
        return 'cleared';
      }
    } catch { /* ignore */ }
    if (!(await detectCaptchaChallenge(page))) {
      logWarm(accountId, '人机验证已消失，继续');
      await resumeIfCleared();
      await humanPause(800, 0.2);
      return 'cleared';
    }
    if (await countSearchVideoCards(page) > 0) {
      logWarm(accountId, '验证码仍在，但已出现视频卡片，继续');
      await resumeIfCleared();
      return 'cleared';
    }
    await humanPause(800, 0.1);
  }
  logWarm(accountId, '人机验证仍在，交由人工验证队列暂停任务（保持省流关闭以便显示验证图片）');
  await capture(page, `warm-captcha-manual-${accountId}`).catch(() => '');
  return 'need_manual';
}

/** TikTok 搜索无结果空态（文案/节点）——有验证码/仍在加载时不当作空态 */
async function detectSearchEmpty(page) {
  if (await detectCaptchaChallenge(page)) return false;
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 8000);
    // 加载中常见文案，勿当空态
    if (/Loading|正在加载|加载中|Please wait|稍候|Something went wrong.*try again later/i.test(text)
      && !/Couldn't find|No results|没有任何结果|没有找到/i.test(text)) {
      return false;
    }
    // 避免匹配搜索框旁的「Try searching…」提示；只认明确的空结果文案
    const emptyRe = /Couldn't find (this|any)|Couldn.?t find|No results found|No videos found|没有任何结果|没有找到相关|未找到结果|找不到结果|暂无结果|没有相关视频|没有搜到/;
    if (emptyRe.test(text)) return true;
    const emptyNodes = document.querySelectorAll(
      '[data-e2e="search-empty"], [data-e2e="search-error"], [class*="DivErrorContainer"], [class*="DivEmptyState"], [class*="EmptyState"]'
    );
    for (const el of emptyNodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return true;
    }
    return false;
  }).catch(() => false);
}

async function countSearchVideoCards(page) {
  for (const sel of [
    '[data-e2e="search_video-item"]',
    '[data-e2e="search-card-video"]',
    'div[class*="DivItemContainer"] a[href*="/video/"]',
    'a[href*="/@"][href*="/video/"]',
  ]) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) {
      const vis = await page.locator(sel).first().isVisible().catch(() => false);
      if (vis) return n;
    }
  }
  return 0;
}

async function waitSearchVideoGrid(page, timeoutMs = 60000, accountId = 0) {
  // 先处理验证码：否则骨架屏会被当成「无结果」
  const captcha = await waitForCaptchaClear(page, accountId, Math.min(180000, Math.max(timeoutMs, 90000)));
  if (captcha === 'timeout' || captcha === 'need_manual') {
    return false;
  }
  const result = await waitSearchContent(page, {
    timeoutMs,
    accountId,
    reloadOnce: true,
    countCards: countSearchVideoCards,
    isEmpty: detectSearchEmpty,
    isCaptcha: detectCaptchaChallenge,
    onCaptcha: waitForCaptchaClear,
    log: (m) => logWarm(accountId, m),
  });
  if (result.ok) return true;
  if (result.reason === 'empty') {
    logWarm(accountId, '搜索空态已确认');
    return false;
  }
  if (result.reason === 'captcha') return false;
  logWarm(accountId, `等待视频网格超时 url=${page.url()}`);
  return (await countSearchVideoCards(page)) > 0;
}

async function isInVideoBrowseMode(page) {
  // 搜索结果页点开后常是侧栏/全屏浏览层，URL 可能仍带 /search/
  const browseUi = await page.locator([
    '[data-e2e="browse-like-icon"]',
    '[data-e2e="browse-comment-icon"]',
    '[data-e2e="browse-favorite-icon"]',
    '[data-e2e="browse-follow"]',
    '[data-e2e="browse-video"]',
    'button[data-e2e="arrow-right"]',
    '[data-e2e="arrow-right"]',
    '[data-e2e="browse-video-desc"]',
  ].join(', ')).first().isVisible().catch(() => false);
  if (browseUi) return true;

  const url = page.url() || '';
  if (/\/@[^/]+\/video\/\d+|\/video\/\d+/.test(url) && !/\/search\//i.test(url)) return true;
  return false;
}

/**
 * 只点一次搜索结果第 1 条，进入浏览态后保持住。
 * 禁止随后点 Close / 按 Escape（那是「打开又秒关」的根因）。
 * 成功后只依赖下箭头切下一条，不再回网格重开。
 */

/** 自研浏览器导航失败时注入的 data: 诊断页（非 TikTok） */
function isEnvLoadDiagnosticPage(page) {
  try {
    const url = String(page.url?.() || page.url || '');
    if (/^data:text\/html/i.test(url)) return true;
    if (/环境窗口没能正常打开|加载诊断|页面加载超时/i.test(url)) return true;
  } catch { /* ignore */ }
  return false;
}

async function assertNotDiagnosticPage(page, where = '') {
  if (!isEnvLoadDiagnosticPage(page)) return;
  const url = String(page.url?.() || '');
  throw new Error(
    `环境窗口未打开 TikTok（${where || '页面'}）。当前是加载诊断页，通常为网络/代理超时。请检查代理后重试。url=${url.slice(0, 160)}`
  );
}

async function openFirstSearchVideo(page, accountId = 0) {
  await assertPageAlive(page, '点第一条视频前');
  await assertNotDiagnosticPage(page, '点第一条视频前');
  if (await isInVideoBrowseMode(page)) {
    logWarm(accountId, '已在浏览态，跳过再次点击');
    return true;
  }

  // 网格已由 runKeyword 预检；此处再确认一次（慢网再给一轮，不再刷新以免打断）
  let hasGrid = (await countSearchVideoCards(page)) > 0;
  if (!hasGrid) hasGrid = await waitSearchVideoGrid(page, 45000, accountId);
  if (!hasGrid) {
    const cap = await detectCaptchaChallenge(page);
    logWarm(accountId, `搜索网格未出现${cap ? '（仍有人机验证）' : ''} url=${page.url()}`);
    return false;
  }
  await humanPause(600, 0.2);

  // 优先点整张卡片；不要乱点 Close，也不要多选择器连环点
  const cardSelectors = [
    '[data-e2e="search_video-item"]',
    '[data-e2e="search-card-video"]',
    '[data-e2e="search_video-item"] a[href*="/video/"]',
    'a[href*="/@"][href*="/video/"]',
  ];

  let target = null;
  let usedSel = '';
  for (const sel of cardSelectors) {
    const item = page.locator(sel).first();
    if (!(await item.count().catch(() => 0))) continue;
    if (!(await item.isVisible().catch(() => false))) continue;
    target = item;
    usedSel = sel;
    break;
  }
  if (!target) {
    logWarm(accountId, '未找到可点的第一条视频卡片');
    return false;
  }

  const href = await target.getAttribute('href').catch(() => '')
    || await target.locator('a[href*="/video/"]').first().getAttribute('href').catch(() => '');

  await target.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(400, 0.2);

  // 鼠标移到卡片中心单击一次即可（不要双击，双击容易开了又关）
  const box = await target.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
    await humanPause(250, 0.1);
  }

  logWarm(accountId, `单击第1条视频 selector=${usedSel} href=${href || '-'}`);
  try {
    await target.click({ timeout: 5000, delay: clickHoldMs() });
  } catch {
    await target.click({ timeout: 5000, force: true }).catch(() => {});
  }

  // 等到浏览控件稳定出现（连续两次检测到），期间绝不点 Close / Escape
  let stableHits = 0;
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page, { accountId });
    } catch { /* ignore */ }
    if (await isInVideoBrowseMode(page)) {
      stableHits += 1;
      if (stableHits >= 2) {
        await waitVideoReady(page, 10000);
        logWarm(accountId, `已进入并保持浏览态 url=${page.url()}`);
        return true;
      }
    } else {
      stableHits = 0;
    }
    await humanPause(450, 0.1);
  }

  logWarm(accountId, `单击后未保持浏览态 url=${page.url()}`);
  return false;
}

/**
 * 定位并点击「下一条」箭头（UI ↓ / data-e2e=arrow-right）
 * 优先用鼠标坐标点可见按钮，避免点到隐藏副本或上一条。
 * @returns {Promise<string>}
 */
async function clickNextVideoArrow(page) {
  const target = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (r.width < 8 || r.height < 8) return false;
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') return false;
      if (Number(st.opacity || '1') < 0.15) return false;
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const isDisabled = (el) => !!(el?.disabled || el?.getAttribute?.('aria-disabled') === 'true');
    const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });

    const scored = [];
    const pushEl = (el, tag) => {
      if (!isVisible(el) || isDisabled(el)) return;
      const e2e = (el.getAttribute('data-e2e') || '').toLowerCase();
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
      if (/arrow-left|arrow-up|previous|prev|上一条|上一个/.test(`${e2e} ${label}`)) return;
      const r = el.getBoundingClientRect();
      // 越靠右、越靠近垂直中线分越高；arrow-right 额外加分
      let score = r.left + (100 - Math.abs((r.top + r.height / 2) - innerHeight / 2) / innerHeight * 100);
      if (e2e === 'arrow-right' || e2e === 'arrow-down' || e2e === 'browse-arrow-down') score += 500;
      if (/next|下一条|下一个/.test(label)) score += 200;
      if (r.left < innerWidth * 0.45) score -= 400; // 不要点左侧
      scored.push({ tag, ...center(r), score, e2e });
    };

    for (const el of document.querySelectorAll(
      'button[data-e2e="arrow-right"], [data-e2e="arrow-right"], button[data-e2e="arrow-down"], [data-e2e="arrow-down"], button[data-e2e="browse-arrow-down"]'
    )) pushEl(el, 'e2e');

    // 成对上下圆钮 → 取下面那个
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    for (let i = 0; i < buttons.length - 1; i++) {
      const a = buttons[i];
      const b = buttons[i + 1];
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const sameColumn = Math.abs(ra.left - rb.left) < 18;
      const stacked = rb.top - ra.bottom >= -4 && rb.top - ra.bottom < 60;
      const roundish = ra.width >= 22 && ra.width <= 64 && Math.abs(ra.width - ra.height) < 14
        && rb.width >= 22 && rb.width <= 64 && Math.abs(rb.width - rb.height) < 14;
      const onRight = ra.left > innerWidth * 0.5;
      if (sameColumn && stacked && roundish && onRight && !isDisabled(b)) {
        pushEl(b, 'pair-down');
      }
    }

    scored.sort((x, y) => y.score - x.score);
    return scored[0] || null;
  }).catch(() => null);

  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await page.mouse.move(target.x, target.y).catch(() => {});
    await humanPause(80, 0.1);
    await page.mouse.click(target.x, target.y, { delay: clickHoldMs() }).catch(() => {});
    // 同步派发 click，防止被遮罩吞掉 mouse 事件
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      const btn = el.closest('button, [role="button"], [data-e2e*="arrow"]') || el;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
    }, { x: target.x, y: target.y }).catch(() => {});
    return `${target.tag || 'mouse'}:${target.e2e || 'x'}`;
  }

  // Playwright 兜底
  for (const sel of SELECTORS.nextVideo) {
    try {
      const el = page.locator(sel).last(); // last 更接近「向下」那颗
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 2500, force: true });
      return `pw:${sel}`;
    } catch { /* next */ }
  }
  return '';
}

function armVideoNavFlag(page) {
  return page.evaluate(() => {
    window.__warmVideoNav = false;
    const mark = () => { window.__warmVideoNav = true; };
    document.querySelectorAll('video').forEach((v) => {
      ['loadstart', 'emptied', 'loadeddata', 'playing'].forEach((ev) => {
        v.addEventListener(ev, mark, { once: true });
      });
    });
  }).catch(() => {});
}

/**
 * 切到下一条：关评论 → 点 ↓ → 键盘 → 滚轮；指纹/视频事件任一变化即成功
 */
async function swipeToNextVideo(page, accountId = 0) {
  await closeCommentPanel(page);
  try {
    const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    await solveRotateCaptchaIfPresent(page, { accountId });
  } catch { /* ignore */ }

  if (!(await isInVideoBrowseMode(page))) {
    logWarm(accountId, '翻页前已不在浏览态，放弃');
    await capture(page, accountId, 'warm', 'swipe-no-browse').catch(() => '');
    return false;
  }

  const before = await readBrowseFingerprint(page);
  logWarm(accountId, `翻页前指纹 ${String(before).slice(0, 100)}`);

  const finishIfChanged = async (how) => {
    const after = await waitFingerprintChange(page, before, 7500);
    if (after && after !== before) {
      logWarm(accountId, `翻页成功 via ${how}`);
      await waitVideoReady(page, 10000);
      return true;
    }
    return false;
  };

  // 1) 鼠标点 ↓
  for (let attempt = 0; attempt < 3; attempt++) {
    await armVideoNavFlag(page);
    const how = await clickNextVideoArrow(page);
    if (how) {
      if (await finishIfChanged(`arrow#${attempt + 1}:${how}`)) return true;
      logWarm(accountId, `箭头已点(${how})未检测到切换 attempt=${attempt + 1}`);
    } else {
      logWarm(accountId, `未找到下箭头 attempt=${attempt + 1}`);
    }
    await humanPause(500, 0.15);
  }

  // 2) 聚焦视频后按 ArrowDown
  await armVideoNavFlag(page);
  await page.evaluate(() => {
    const v = document.querySelector('[data-e2e="browse-video"] video, video');
    if (v) {
      try { v.focus(); } catch { /* ignore */ }
      v.click();
    }
  }).catch(() => {});
  await humanPause(200, 0.1);
  for (const key of ['ArrowDown', 'PageDown', 'Space']) {
    if (key === 'Space') continue; // Space 只暂停，不翻页
    await page.keyboard.press(key).catch(() => {});
    if (await finishIfChanged(`key:${key}`)) return true;
  }

  // 3) 对浏览容器派发 wheel + 真实滚轮
  await armVideoNavFlag(page);
  await page.evaluate(() => {
    const target = document.querySelector('[data-e2e="browse-video"]')
      || document.querySelector('[class*="DivBrowserModeContainer"]')
      || document.querySelector('video')
      || document.body;
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 1200, bubbles: true, cancelable: true, view: window,
    }));
  }).catch(() => {});
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.move(Math.floor(vp.width * 0.4), Math.floor(vp.height * 0.5)).catch(() => {});
  await page.mouse.wheel(0, 1600).catch(() => {});
  if (await finishIfChanged('wheel')) return true;

  const still = await readBrowseFingerprint(page);
  logWarm(accountId, `翻页失败 before=${String(before).slice(0, 80)} after=${String(still).slice(0, 80)} url=${page.url()}`);
  await capture(page, accountId, 'warm', 'swipe-fail').catch(() => '');
  return false;
}

/* ───────── actions ───────── */

async function tryLike(page) {
  if (await clickFirstVisible(page, SELECTORS.like)) return true;
  return clickByPatterns(page, [/like/i, /^赞$/, /^点赞$/, /^喜歡$/, /^喜欢$/]);
}

async function tryFavorite(page) {
  if (await clickFirstVisible(page, SELECTORS.favorite)) return true;
  return clickByPatterns(page, [/favorite/i, /add to favorites/i, /^收藏$/, /^收藏视频$/, /^加入收藏$/]);
}

/**
 * 只读「当前浏览视频」右侧动作栏的关注状态，避免页面其它 Following 误判成功。
 * @returns {'followed'|'unfollowed'|'unknown'}
 */
async function readBrowseFollowState(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (r.width < 4 || r.height < 4) return false;
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth * 1.05;
    };
    const like = document.querySelector('[data-e2e="browse-like-icon"], [data-e2e="like-icon"]');
    const likeR = like && vis(like) ? like.getBoundingClientRect() : null;
    const nearActionBar = (r) => {
      if (r.left < innerWidth * 0.45) return false;
      if (!likeR) return r.left > innerWidth * 0.7;
      const lx = likeR.left + likeR.width / 2;
      return Math.abs((r.left + r.width / 2) - lx) < 56 && r.bottom <= likeR.top + 20;
    };
    const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();

    const nodes = [
      ...document.querySelectorAll(
        '[data-e2e="browse-follow"], [data-e2e="feed-follow"], [data-e2e="video-follow"], button[data-e2e="browse-follow"]'
      ),
    ].filter(vis);

    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (!nearActionBar(r) && r.left < innerWidth * 0.55) continue;
      const t = labelOf(el);
      // 严格：Following / 已关注；不要把纯 Follow 当已关注
      if (/\bfollowing\b|已关注|好友/.test(t)) return 'followed';
      // 仍有可点的 + / Follow → 未关注
      if (/\+|^\s*follow\s*$|^\s*关注\s*$/.test(t) || el.querySelector('svg') || (el.textContent || '').includes('+')) {
        return 'unfollowed';
      }
      // browse-follow 可见且无 Following 文案 → 视为未关注（红 + 图标常见无文本）
      if (el.getAttribute('data-e2e')?.includes('follow')) return 'unfollowed';
    }

    // 无 browse-follow 节点：可能已关注后节点移除，或 UI 未渲染
    if (likeR) {
      const avatar = document.querySelector('[data-e2e="browse-user-avatar"], [data-e2e="video-author-avatar"]');
      if (avatar && vis(avatar)) {
        // 头像在、加号控件完全消失，且没有 Follow 文案 → 倾向已关注
        const plusLeft = [...document.querySelectorAll('button, [role="button"], [data-e2e*="follow"]')].some((el) => {
          if (!vis(el)) return false;
          const r = el.getBoundingClientRect();
          if (!nearActionBar(r)) return false;
          const t = labelOf(el);
          if (/\bfollowing\b|已关注/.test(t)) return false;
          const ar = avatar.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const onPlus = Math.abs(cx - (ar.left + ar.width / 2)) < 24
            && cy >= ar.bottom - 20 && cy <= ar.bottom + 24
            && r.width <= 40 && r.height <= 40;
          return onPlus || /\bfollow\b|关注|\+/.test(t);
        });
        if (!plusLeft) return 'followed';
      }
    }
    return 'unknown';
  }).catch(() => 'unknown');
}

/** 定位当前视频右侧栏头像底部「+」点击点 */
async function locateAvatarPlus(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (r.width < 6 || r.height < 6) return false;
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-e2e') || ''} ${el.textContent || ''}`.toLowerCase();
    const mid = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const hits = [];

    const like = document.querySelector('[data-e2e="browse-like-icon"], [data-e2e="like-icon"]');
    const likeR = like && vis(like) ? like.getBoundingClientRect() : null;

    for (const el of document.querySelectorAll(
      '[data-e2e="browse-follow"], [data-e2e="feed-follow"], [data-e2e="video-follow"], button[data-e2e="browse-follow"]'
    )) {
      if (!vis(el)) continue;
      const t = labelOf(el);
      if (/\bfollowing\b|已关注/.test(t)) {
        return { already: true, tag: 'already', x: 0, y: 0, score: 999 };
      }
      const r = el.getBoundingClientRect();
      if (r.left < innerWidth * 0.45) continue;
      if (likeR && Math.abs(mid(r).x - (likeR.left + likeR.width / 2)) > 60) continue;
      const m = mid(r);
      // 大容器：点下沿（红 +）；小按钮：点中心
      if (r.width > 40 || r.height > 40) {
        hits.push({ score: 150, tag: 'e2e-bottom', x: m.x, y: r.bottom - 5, w: r.width, h: r.height });
      } else {
        hits.push({ score: 180, tag: 'e2e-plus', x: m.x, y: m.y, w: r.width, h: r.height });
      }
    }

    const avatar = document.querySelector('[data-e2e="browse-user-avatar"], [data-e2e="video-author-avatar"]');
    if (avatar && vis(avatar)) {
      const shell = avatar;
      const ar = shell.getBoundingClientRect();
      for (const btn of document.querySelectorAll(
        '[data-e2e="browse-follow"], [data-e2e="feed-follow"], button, [role="button"]'
      )) {
        if (!vis(btn)) continue;
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const aligned = Math.abs(cx - (ar.left + ar.width / 2)) < 22;
        const onBottom = cy >= ar.bottom - 16 && cy <= ar.bottom + 20;
        const small = r.width >= 10 && r.width <= 42 && r.height >= 10 && r.height <= 42;
        if (!(aligned && onBottom && small)) continue;
        const t = labelOf(btn);
        if (/\bfollowing\b|已关注|like|comment|share|favorite|赞|评论|分享|收藏/.test(t)) continue;
        let score = 120;
        const bg = `${window.getComputedStyle(btn).backgroundColor || ''}`.toLowerCase();
        if (/rgb\(\s*(254|255|232|229|220)/.test(bg) || /fe2c55|ff3b5c/.test(bg)) score += 40;
        if ((btn.textContent || '').includes('+') || btn.querySelector('svg')) score += 15;
        hits.push({ score, tag: 'avatar-plus', x: cx, y: cy, w: r.width, h: r.height });
      }
      // 低优先级兜底：头像下沿（仅当上面没命中时）
      if (!hits.length) {
        hits.push({
          score: 40,
          tag: 'avatar-edge',
          x: ar.left + ar.width / 2,
          y: ar.bottom - 3,
          w: 20,
          h: 20,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits[0] || null;
  }).catch(() => null);
}

async function clickAvatarPlusAt(page, hit) {
  const x = Number(hit.x);
  const y = Number(hit.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const urlBefore = page.url();
  let didClick = false;

  // 优先 Playwright 点官方 follow（只点一次，避免点两次变成取关）
  if (String(hit.tag || '').startsWith('e2e') || hit.tag === 'pw') {
    for (const sel of SELECTORS.follow) {
      try {
        const loc = page.locator(sel).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        const box = await loc.boundingBox().catch(() => null);
        if (!box || box.x < (page.viewportSize()?.width || 1280) * 0.45) continue;
        if (box.width > 40 || box.height > 40) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height - 5, { delay: clickHoldMs() });
        } else {
          await loc.click({ timeout: 2000, force: true });
        }
        didClick = true;
        break;
      } catch { /* coords */ }
    }
  }

  if (!didClick) {
    const clickY = y;
    await page.mouse.move(x, clickY, { steps: 3 }).catch(() => {});
    await humanPause(50, 0.1);
    const top = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { ok: false, reason: 'no-el', y };
      const follow = el.closest?.(
        '[data-e2e="browse-follow"], [data-e2e="feed-follow"], [data-e2e="video-follow"], [data-e2e="follow-button"]'
      );
      const a = el.closest?.('a[href*="/@"]');
      if (a && !follow) {
        const el2 = document.elementFromPoint(x, y + 8);
        const f2 = el2?.closest?.(
          '[data-e2e="browse-follow"], [data-e2e="feed-follow"], [data-e2e="video-follow"], button, [role="button"]'
        );
        if (!f2 || (f2.closest?.('a[href*="/@"]') === a && !f2.getAttribute?.('data-e2e')?.includes('follow'))) {
          return { ok: false, reason: 'hit-avatar-link', y: y + 8 };
        }
        f2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y + 8 }));
        return { ok: true, reason: 'offset-plus', y: y + 8 };
      }
      const target = follow || el.closest?.('button, [role="button"]') || el;
      if (target.closest?.('a[href*="/@"]') && !target.closest?.('[data-e2e*="follow"]')) {
        return { ok: false, reason: 'avatar-anchor', y };
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      return { ok: true, reason: 'clicked', y };
    }, { x, y: clickY }).catch(() => ({ ok: false, reason: 'eval-fail', y: clickY }));

    if (!top?.ok) {
      await page.mouse.click(x, Number(top?.y || clickY), { delay: clickHoldMs() }).catch(() => {});
    }
    didClick = true;
  }

  await humanPause(1000, 0.15);
  const urlAfter = page.url();
  if (/\/@[^/]+\/?(\?|$)/.test(urlAfter) && !/\/video\//.test(urlAfter) && urlAfter !== urlBefore) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    await humanPause(600, 0.15);
    return false;
  }
  return didClick;
}

/**
 * 关注：点头像底部红色「+」，必须以当前视频栏状态变为已关注才算成功
 */
async function tryFollow(page, accountId = 0) {
  const before = await readBrowseFollowState(page);
  if (before === 'followed') {
    logWarm(accountId, '关注跳过：当前视频已是已关注');
    return true;
  }

  const first = await locateAvatarPlus(page);
  if (first?.already) {
    logWarm(accountId, '关注跳过：locate 判定已关注');
    return true;
  }
  if (!first) {
    logWarm(accountId, '关注失败：未找到头像底部加号');
    return false;
  }
  logWarm(accountId, `关注瞄准 ${first.tag} (${Math.round(first.x)},${Math.round(first.y)}) score=${first.score || 0}`);

  const attempts = [first];
  for (const sel of SELECTORS.follow) {
    try {
      const loc = page.locator(sel);
      const n = Math.min(4, await loc.count().catch(() => 0));
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.x < (page.viewportSize()?.width || 1280) * 0.45) continue;
        const x = box.x + box.width / 2;
        const y = (box.width > 40 || box.height > 40) ? (box.y + box.height - 5) : (box.y + box.height / 2);
        attempts.push({ score: 100, tag: 'pw', x, y });
      }
    } catch { /* next */ }
  }

  const seen = new Set();
  for (const hit of attempts.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = `${Math.round(hit.x)},${Math.round(hit.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const clicked = await clickAvatarPlusAt(page, hit);
    if (!clicked) {
      logWarm(accountId, `关注点击无效 tag=${hit.tag}`);
      continue;
    }

    // 必须等到当前栏状态变成 followed；点一下不算成功（期间若弹出旋转验证则自动识别过码）
    const end = Date.now() + 3500;
    while (Date.now() < end) {
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(page, { accountId });
      } catch { /* ignore */ }
      const after = await readBrowseFollowState(page);
      if (after === 'followed') {
        logWarm(accountId, `关注状态已确认 tag=${hit.tag}`);
        return true;
      }
      await humanPause(350, 0.1);
    }
    const still = await readBrowseFollowState(page);
    logWarm(accountId, `关注未确认仍为 ${still} tag=${hit.tag}`);
  }

  return false;
}

/** 评论输入框是否已可见可点（右侧栏真正就绪，而非空白壳） */
async function isCommentInputReady(page) {
  return page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        '[data-e2e="comment-input"], [data-e2e="comment-input"] [contenteditable="true"], [placeholder*="Add comment" i], [placeholder*="添加评论"], textarea[placeholder*="comment" i], div[contenteditable="true"][placeholder*="comment" i], div[contenteditable="true"][data-placeholder*="comment" i]'
      ),
    ];
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const st = window.getComputedStyle(n);
      if (r.width < 40 || r.height < 16) continue;
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      // 输入区一般在视口右下 / 底部
      if (r.bottom < innerHeight * 0.35) continue;
      return true;
    }
    return false;
  }).catch(() => false);
}

async function waitCommentInputReady(page, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    if (await isCommentInputReady(page)) return true;
    await humanPause(350, 0.12);
  }
  return false;
}

async function openComments(page, { timeoutMs = 15000 } = {}) {
  // 已打开且输入框就绪则跳过
  if (await isCommentInputReady(page)) return true;

  let clicked = await clickFirstVisible(page, SELECTORS.commentOpen);
  if (!clicked) {
    clicked = await clickByPatterns(page, [/^Comments$/i, /comment/i, /^评论$/, /^留言$/, /^查看评论$/]);
  }
  if (!clicked) return false;
  await humanPause(800, 0.2);

  // 必须等到底部「Add comment」输入框出现，空白侧栏不算成功
  const ready = await waitCommentInputReady(page, timeoutMs);
  if (!ready) {
    // 再点一次评论图标，部分布局首次只出空壳
    await clickFirstVisible(page, SELECTORS.commentOpen, { timeout: 1500 }).catch(() => false);
    await humanPause(600, 0.15);
    return waitCommentInputReady(page, Math.min(8000, timeoutMs));
  }
  return true;
}

async function scrollCommentPanel(page, pages) {
  const n = Math.max(0, Number(pages) || 0);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, randInt(400, 700)).catch(() => {});
    await humanPause(650, 0.25);
  }
}

async function likeComments(page, maxN = 3) {
  let liked = 0;
  const hearts = page.locator(
    '[data-e2e*="comment"] [data-e2e*="like"], [data-e2e="comment-like-icon"], button[aria-label*="Like"], button[aria-label*="赞"]'
  );
  const count = Math.min(maxN, await hearts.count().catch(() => 0));
  for (let i = 0; i < count; i++) {
    try {
      await hearts.nth(i).click({ timeout: 1500 });
      liked += 1;
      await humanPause(350, 0.2);
    } catch { /* ignore */ }
  }
  return liked;
}

/** 读取当前评论草稿（去掉首尾空白） */
async function readCommentDraft(page) {
  return page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        '[data-e2e="comment-input"] [contenteditable="true"], [data-e2e="comment-input"], [data-e2e="comment-text"], [contenteditable="true"][placeholder*="comment" i], textarea[placeholder*="comment" i], [placeholder*="Add comment" i]'
      ),
    ];
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      const t = (n.tagName || '').toLowerCase();
      if (t === 'textarea' || t === 'input') {
        const v = String(n.value || '').trim();
        if (v) return v;
        continue;
      }
      const ce = n.getAttribute('contenteditable') === 'true'
        ? n
        : n.querySelector('[contenteditable="true"]');
      if (!ce) continue;
      const v = String(ce.innerText || ce.textContent || '').replace(/\u200b/g, '').trim();
      if (v && !/^add comment/i.test(v)) return v;
    }
    const ae = document.activeElement;
    if (ae) {
      const t = (ae.tagName || '').toLowerCase();
      if (t === 'textarea' || t === 'input') return String(ae.value || '').trim();
      if (ae.getAttribute('contenteditable') === 'true') {
        return String(ae.innerText || ae.textContent || '').replace(/\u200b/g, '').trim();
      }
    }
    return '';
  }).catch(() => '');
}

/** 向已聚焦的评论框整段写入（避免 keyboard.type 吞掉首字符） */
async function insertCommentText(page, text) {
  const value = String(text || '');
  // 1) CDP insertText：整串插入，不会丢首字母
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.insertText', { text: value });
    await session.detach().catch(() => {});
    return true;
  } catch { /* fallthrough */ }

  // 2) execCommand insertText
  const ok = await page.evaluate((v) => {
    const el = document.activeElement;
    if (!el) return false;
    const t = (el.tagName || '').toLowerCase();
    if (t === 'textarea' || t === 'input') {
      el.focus();
      el.value = '';
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) {
      el.focus();
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, v);
  } catch {
        el.textContent = v;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
      return true;
    }
    return false;
  }, value).catch(() => false);
  return !!ok;
}

/**
 * 定位右侧评论栏底部「Add comment...」输入框并填入文案
 * 注意：TikTok contenteditable 用 keyboard.type 常会丢掉首字母（Nice → ice）
 */
async function fillCommentInput(page, text) {
  const value = String(text || '');
  if (!value) return false;

  const candidates = [
    page.locator('[data-e2e="comment-input"] [contenteditable="true"]').first(),
    page.locator('[data-e2e="comment-input"]').first(),
    page.getByPlaceholder(/Add comment/i).first(),
    page.getByPlaceholder(/添加评论|写评论|说点什么/i).first(),
    page.locator('[data-e2e="comment-text"]').first(),
    page.locator('div[contenteditable="true"][placeholder*="comment" i]').first(),
    page.locator('textarea[placeholder*="comment" i]').first(),
  ];

  for (const el of candidates) {
    try {
      if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 2500 });
      await humanPause(400, 0.15);

      // 点到外壳时再点内部 contenteditable
      const inner = el.locator('[contenteditable="true"], textarea, input').first();
      if (await inner.count().catch(() => 0)) {
        await inner.click({ timeout: 2000 }).catch(() => {});
        await humanPause(200, 0.1);
      }

      // 清空：选中后直接 insertText 覆盖，避免 Backspace 与首键竞态
      await page.keyboard.press('Control+A').catch(() => {});
      await humanPause(80, 0.05);

      let wrote = await insertCommentText(page, value);
      if (!wrote) {
        // 最后才用逐字输入，并在开头垫一个空格再删掉，防止吞首字母
        await page.keyboard.type(` ${value}`, { delay: typeDelay(80, 160) });
        await page.keyboard.press('Home').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        wrote = true;
      }
      await humanPause(300, 0.15);

      let draft = await readCommentDraft(page);
      const looksGood = (d) => !!d && (d === value || d.replace(/\s+/g, ' ') === value.replace(/\s+/g, ' '));
      // 首字母被吞：Nice → ice
      if (draft && value.length > 1 && draft === value.slice(1)) {
        await page.keyboard.press('Control+A').catch(() => {});
        await insertCommentText(page, value);
        draft = await readCommentDraft(page);
        if (draft === value.slice(1)) {
          await page.keyboard.press('Home').catch(() => {});
          await insertCommentText(page, value[0]);
          draft = await readCommentDraft(page);
        }
      }
      if (looksGood(draft)) return true;
      // 整段重写一次
      await page.keyboard.press('Control+A').catch(() => {});
      await insertCommentText(page, value);
      draft = await readCommentDraft(page);
      if (looksGood(draft)) return true;
      if (draft === value.slice(1) && value[0]) {
        await page.keyboard.press('Home').catch(() => {});
        await insertCommentText(page, value[0]);
        draft = await readCommentDraft(page);
      }
      if (looksGood(draft) || (draft && draft[0] === value[0] && draft.length >= Math.min(4, value.length))) {
        return true;
      }
    } catch { /* next */ }
  }

  const filled = await page.evaluate((v) => {
    const nodes = [
      ...document.querySelectorAll('[data-e2e="comment-input"], [data-e2e="comment-text"], [contenteditable="true"], textarea, input'),
    ];
    const hit = nodes.find((n) => {
      const ph = `${n.getAttribute('placeholder') || ''} ${n.getAttribute('data-placeholder') || ''} ${n.getAttribute('aria-label') || ''}`.toLowerCase();
      const e2e = `${n.getAttribute('data-e2e') || ''}`.toLowerCase();
      return /add comment|添加评论|写评论|comment/.test(ph) || /comment-input|comment-text/.test(e2e);
    });
    if (!hit) return false;
    const target = hit.getAttribute('contenteditable') === 'true'
      ? hit
      : (hit.querySelector('[contenteditable="true"], textarea, input') || hit);
    target.focus();
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const proto = target.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(target, v);
      else target.value = v;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, v);
      } catch {
        target.textContent = v;
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
    }
    return true;
  }, value).catch(() => false);

  if (!filled) return false;
  const draft = await readCommentDraft(page);
  if (draft === value.slice(1) && value[0]) {
    await page.keyboard.press('Home').catch(() => {});
    await insertCommentText(page, value[0]);
  }
  return true;
}

/**
 * 点击评论栏右侧圆形红色「上箭头」发送按钮
 */
async function clickCommentSend(page) {
  if (await clickFirstVisible(page, SELECTORS.commentPost, { timeout: 2500 })) {
    return true;
  }

  // 文案按钮兜底
  if (await clickByPatterns(page, [/^Post$/i, /^Publish$/i, /^发送$/, /^发布$/], { timeout: 1500 })) {
    return true;
  }

  // UI：输入框右侧深红圆钮 + 白色上箭头
  const clicked = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 10 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none';
    };

    const byE2e = document.querySelector(
      'button[data-e2e="comment-post"], [data-e2e="comment-post"], button[data-e2e="comment-post-button"]'
    );
    if (byE2e && isVisible(byE2e)) {
      byE2e.click();
      return 'e2e';
    }

    // 找「Add comment」输入附近的圆形按钮
    const inputs = [...document.querySelectorAll(
      '[data-e2e="comment-input"], [placeholder*="Add comment" i], [placeholder*="添加评论"], textarea[placeholder*="comment" i], [contenteditable="true"]'
    )].filter(isVisible);
    const input = inputs[inputs.length - 1] || null;
    const inputBox = input ? input.getBoundingClientRect() : null;

    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    const scored = [];
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      const roundish = Math.abs(r.width - r.height) < 8 && r.width >= 28 && r.width <= 52;
      if (!roundish) continue;
      // 在输入框右侧或同一行
      let near = true;
      if (inputBox) {
        near = Math.abs(r.top - inputBox.top) < 40 && r.left >= inputBox.right - 8 && r.left < inputBox.right + 80;
      } else {
        near = r.bottom > innerHeight * 0.75; // 底部评论区
      }
      if (!near) continue;

      const st = window.getComputedStyle(btn);
      const bg = `${st.backgroundColor || ''} ${st.color || ''}`.toLowerCase();
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-e2e') || ''}`.toLowerCase();
      let score = 10;
      if (/post|send|发布|发送|comment-post/.test(label)) score += 50;
      // 红色系背景（#fe2c55 一类）
      if (/rgb\(\s*(254|255|232|229|220)/.test(bg) || /fe2c55|ff3b5c|e94359/.test(bg)) score += 40;
      if (btn.querySelector('svg, path')) score += 5;
      scored.push({ btn, score, r });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 15) {
      scored[0].btn.click();
      return `round:${scored[0].score}`;
    }
    return '';
  }).catch(() => '');

  return !!clicked;
}

/** 发送后草稿应清空（或变短很多） */
async function waitCommentPosted(page, beforeDraft, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  const before = String(beforeDraft || '').trim();
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const draft = String(await readCommentDraft(page) || '').trim();
    if (!draft) return true;
    if (before && draft !== before && draft.length < Math.max(4, before.length * 0.5)) return true;
    // 发送钮消失 / 输入框仍在也算可能已发
    await humanPause(350, 0.1);
  }
  const draft = String(await readCommentDraft(page) || '').trim();
  return !draft || (before && draft !== before);
}

/**
 * 右侧评论栏：打开 → 等输入框就绪 → 填文案 → 点发送 → 确认发出
 * 文案为空直接失败（AI 未就绪时禁止打开空白栏）
 */
async function tryPostComment(page, text, opts = {}) {
  const body = String(text || '').trim();
  if (!body) return false;
  const accountId = opts.accountId || 0;
  const openTimeout = Number(opts.openTimeoutMs || 15000);

  const opened = await openComments(page, { timeoutMs: openTimeout });
  if (!opened) {
    logWarm(accountId, '评论栏未出现输入框（空白侧栏），放弃发送');
    return false;
  }
  await humanPause(500, 0.2);

  let filled = await fillCommentInput(page, body);
  if (!filled) {
    await humanPause(800, 0.15);
    filled = await fillCommentInput(page, body);
  }
  if (!filled) {
    logWarm(accountId, '评论输入框填写失败');
    return false;
  }
  await humanPause(500, 0.2);

  const draftBefore = await readCommentDraft(page);
  let posted = await clickCommentSend(page);
  if (!posted) {
    await page.keyboard.press('Control+Enter').catch(() => {});
    await humanPause(400, 0.2);
    posted = await clickCommentSend(page);
  }
  if (!posted) {
    logWarm(accountId, '未点到评论发送按钮');
    return false;
  }

  const confirmed = await waitCommentPosted(page, draftBefore, 8000);
  if (!confirmed) {
    logWarm(accountId, '评论发送未确认（草稿仍在），视为失败');
    return false;
  }
  logWarm(accountId, `评论已发送: ${body.slice(0, 60)}`);
  await humanPause(1200, 0.2);
  return true;
}

/* ───────── keyword / video sessions ───────── */

/**
 * 对当前浏览态视频执行计划动作（不导航 URL）
 */
async function interactCurrentVideo(page, step, ctx) {
  const {
    commentPages,
    stats,
    keywordLog,
  } = ctx;

  await assertPageAlive(page, '互动当前视频');
  if (!(await isInVideoBrowseMode(page))) {
    throw new Error(`未处于视频浏览态，拒绝互动（url=${page.url()}）`);
  }

  // 浏览态内禁止点 Close；只关 Cookie 类
  await dismissOverlays(page, { escape: false });
  await waitVideoReady(page);

  stats.browsed += 1;
  keywordLog.browsed += 1;

  const staySec = Math.max(1, Number(step.staySeconds || 10));
  const watchFirst = Math.max(2, Math.floor(staySec * 0.65));
  const watchAfter = Math.max(0, staySec - watchFirst);
  await watchVideo(page, watchFirst);

  if (step.like) {
    if (await tryLike(page)) {
      stats.liked += 1;
      keywordLog.liked += 1;
    }
    await humanPause(450, 0.2);
  }
  if (step.favorite) {
    if (await tryFavorite(page)) {
      stats.favorited += 1;
      keywordLog.favorited += 1;
    }
    await humanPause(450, 0.2);
  }
  if (step.follow) {
    const ok = await tryFollow(page, ctx.accountId || 0);
    if (ok) {
      stats.followed += 1;
      keywordLog.followed += 1;
      logWarm(ctx.accountId || 0, '关注成功（头像底部 +）');
    } else {
      logWarm(ctx.accountId || 0, '关注失败：未点到头像底部红色加号');
    }
    await humanPause(450, 0.2);
  }

  const needCommentUi = !!(step.comment || step.viewComments || step.commentLike);
  if (needCommentUi) {
    const isAiComment = step.comment && String(ctx.commentMode || '').toLowerCase() === 'ai';
    if (step.comment) {
      // AI：先等接口返回有效文案，再打开评论栏；禁止空文案打开空白侧栏
      if (isAiComment) {
        logWarm(ctx.accountId || 0, 'AI 评论：等待生成完成后再打开评论栏…');
      }
      const commentBody = await resolveCommentText(page, ctx);
      if (!commentBody) {
        logWarm(ctx.accountId || 0, isAiComment
          ? 'AI 评论未生成成功，跳过本条（不打开评论栏）'
          : '评论文案为空，跳过本条');
      } else {
        await dismissOverlays(page, { escape: false });
        let ok = await tryPostComment(page, commentBody, { accountId: ctx.accountId || 0 });
        if (!ok && isAiComment) {
          logWarm(ctx.accountId || 0, 'AI 评论首次发送失败，关闭后重试一次…');
          await closeCommentPanel(page);
          await humanPause(800, 0.2);
          ok = await tryPostComment(page, commentBody, {
            accountId: ctx.accountId || 0,
            openTimeoutMs: 18000,
          });
        }
        if (ok) {
          stats.commented += 1;
          stats.commentsOpened += 1;
          keywordLog.commented += 1;
          stats.lastCommentText = commentBody;
          // 发送成功后稍停，避免立刻关栏看起来像「空白就结束」
          await humanPause(isAiComment ? 1600 : 800, 0.2);
        } else {
          logWarm(ctx.accountId || 0, '评论发送失败，本条不计成功');
        }
      }
    } else if (step.viewComments) {
      if (await openComments(page)) {
        stats.commentsOpened += 1;
        keywordLog.viewedComments += 1;
      }
    }
    if (commentPages > 0 && (step.viewComments || step.commentLike || step.comment)) {
      await scrollCommentPanel(page, commentPages);
    }
    if (step.commentLike) {
      if (!(await isCommentInputReady(page))) {
        await openComments(page).catch(() => false);
      }
      const n = await likeComments(page, 3);
      keywordLog.commentLiked += n;
      stats.commentLiked += n;
    }
    // 翻页前必须收起评论；禁止 Escape（会关掉整个浏览层）
    await closeCommentPanel(page);
  }

  if (watchAfter > 0) {
    await watchVideo(page, watchAfter);
  }
}

/** 当前关键词无结果 / 打不开：记日志并回首页，供下一个关键词继续 */
async function abortKeywordNoResults(page, connection, ctx, keywordLog, reason) {
  keywordLog.openedFeed = false;
  keywordLog.noResults = true;
  keywordLog.skipReason = reason;
  keywordLog.skipped = Math.max(keywordLog.skipped, keywordLog.planned || 0);
  ctx.stats.skipped = (ctx.stats.skipped || 0) + (keywordLog.planned || 0);
  logWarm(ctx.accountId, `关键词「${keywordLog.term}」无可用结果，终止本词 → 下一词 · ${reason}`);
  await capture(page, `warm-no-result-${ctx.accountId}-${String(keywordLog.term || '').slice(0, 20)}`).catch(() => '');
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await gotoHome(connection, ctx.accountId);
  } catch { /* ignore */ }
  return keywordLog;
}

async function runKeyword(page, kw, ctx) {
  const term = String(kw.term || '').trim();
  const videos = Array.isArray(kw.videos) ? kw.videos : [];
  const need = videos.length || Number(kw.videoCount || 0);
  const connection = ctx.connection;
  const keywordLog = {
    term,
    planned: need,
    browsed: 0,
    liked: 0,
    commented: 0,
    favorited: 0,
    followed: 0,
    viewedComments: 0,
    commentLiked: 0,
    skipped: 0,
    openedFeed: false,
    noResults: false,
    skipReason: '',
  };

  if (!term || need < 1) {
    return keywordLog;
  }

  logWarm(ctx.accountId, `首页搜索「${term}」目标 ${need} 条`);

  page = await ensureLivePage(connection);
  try {
    page = await searchKeywordFromHome(connection, term, ctx.accountId);
  } catch (err) {
    return abortKeywordNoResults(page, connection, ctx, keywordLog, `搜索失败: ${err.message || err}`);
  }
  ctx.page = page;
  logWarm(ctx.accountId, `搜索完成 url=${page.url()}`);

  const tabOk = await clickVideosTab(page);
  logWarm(ctx.accountId, `Videos Tab ${tabOk ? '已切换' : '未点到'} url=${page.url()}`);
  if (!tabOk && !/\/search\/video/i.test(page.url() || '')) {
    await clickByPatterns(page, [/^Videos$/i, /^视频$/], { timeout: 3000 });
    await humanPause(1500, 0.2);
  }

  // 人机验证优先：yoga 等热词也会出滑块，绝不能报「无视频」
  if (await detectCaptchaChallenge(page)) {
    const cap = await waitForCaptchaClear(page, ctx.accountId, 180000);
    if (cap === 'timeout' || cap === 'need_manual') {
      keywordLog.securityPaused = true;
      return abortKeywordNoResults(
        page,
        connection,
        ctx,
        keywordLog,
        'TikTok 人机验证（滑块拼图），请在浏览器里完成验证后从通知中心恢复任务'
      );
    }
  }

  // 慢网先等内容；空态需连续确认，避免加载中误判
  if (await detectRawDocumentPage(page)) {
    try {
      page = await recoverFromRawSearchPage(connection, term, ctx.accountId);
      ctx.page = page;
    } catch (err) {
      return abortKeywordNoResults(
        page,
        connection,
        ctx,
        keywordLog,
        `搜索页 JSON/乱码: ${err.message || err}`
      );
    }
  }

  const hasGrid = await waitSearchVideoGrid(page, 90000, ctx.accountId);
  if (!hasGrid) {
    const stillCaptcha = await detectCaptchaChallenge(page);
    if (stillCaptcha) keywordLog.securityPaused = true;
    const rawDoc = !stillCaptcha && await detectRawDocumentPage(page);
    const emptyConfirmed = !stillCaptcha && !rawDoc && await detectSearchEmpty(page);
    return abortKeywordNoResults(
      page,
      connection,
      ctx,
      keywordLog,
      stillCaptcha
        ? '仍被 TikTok 人机验证挡住，搜索结果未加载（不是关键词无视频）'
        : rawDoc
          ? '搜索页为原始 JSON/i18n 乱码（非正常 UI）'
          : emptyConfirmed
            ? '搜索空态'
            : `无视频卡片（已含慢网等待/刷新） url=${page.url()}`
    );
  }

  // 只打开一次第 1 条；之后全部用下箭头切换，绝不再回网格重开
  const opened = await openFirstSearchVideo(page, ctx.accountId);
  keywordLog.openedFeed = opened;
  if (!opened) {
    return abortKeywordNoResults(
      page,
      connection,
      ctx,
      keywordLog,
      isEnvLoadDiagnosticPage(page)
      ? `环境窗口未打开 TikTok（加载超时/诊断页），无法点开视频。请检查代理与网络。url=${String(page.url()).slice(0, 120)}`
      : `未能点开第1条视频 url=${page.url()}`
    );
  }
  logWarm(ctx.accountId, `已打开第1条，后续用下箭头切换，共 ${need} 条`);

  for (let i = 0; i < need; i++) {
    page = await ensureLivePage(connection);
    await assertPageAlive(page, `刷第 ${i + 1} 条`);
    if (!(await isInVideoBrowseMode(page))) {
      throw new Error(`第 ${i + 1} 条时已不在视频浏览态（勿重开网格，请检查是否被 Close/Escape 关掉）url=${page.url()}`);
    }
    const step = videos[i] || {
      index: i,
      staySeconds: randInt(Number(ctx.cfg.staySecondsMin || 30), Number(ctx.cfg.staySecondsMax || 50)),
      like: false,
      comment: false,
      follow: false,
      favorite: false,
      viewComments: false,
      commentLike: false,
    };
    try {
      const key = await readCurrentVideoKey(page);
      logWarm(ctx.accountId, `浏览 #${i + 1}/${need} · 停留 ${step.staySeconds}s · ${key || 'current'}`, {
        like: !!step.like,
        comment: !!step.comment,
        follow: !!step.follow,
        favorite: !!step.favorite,
      });
      await interactCurrentVideo(page, step, { ...ctx, keywordLog });

      if (i < need - 1) {
        const swiped = await swipeToNextVideo(page, ctx.accountId);
        if (!swiped) {
          throw new Error(`第 ${i + 1} 条后点击下箭头翻页失败，流程中断`);
        }
        await humanPause(randInt(800, 1600), 0.2);
      }
    } catch (err) {
      const msg = String(err.message || err);
      if (/已关闭|翻页失败|不在视频浏览态|未能点开|未处于视频浏览态|导航失败|ERR_CONNECTION/i.test(msg)) {
        throw err;
      }
      keywordLog.skipped += 1;
      ctx.stats.skipped += 1;
      logWarm(ctx.accountId, `当前视频动作失败(继续下一条): ${msg}`);
      if (i < need - 1) {
        const swiped = await swipeToNextVideo(page, ctx.accountId).catch(() => false);
        if (!swiped) {
          throw new Error(`动作失败后翻页仍失败，流程中断（已刷 ${keywordLog.browsed}/${need}）`);
        }
      }
    }
  }

  try {
    await page.keyboard.press('Escape').catch(() => {});
    await gotoHome(connection, ctx.accountId);
  } catch { /* ignore */ }

  return keywordLog;
}

/* ───────── orchestrator ───────── */

/**
 * @param {number} accountId
 * @param {object} cfg warm payload（含 executionPlan）
 * @param {object} [options]
 * @param {object} [options.connection] 复用已有比特连接
 * @param {boolean} [options.keepOpen] 结束后不关浏览器
 */
async function runWarmAccount(accountId, cfg = {}, options = {}) {
  const plan = resolvePlan(cfg);
  const keywords = plan.keywords || [];
  if (!keywords.length) {
    throw new Error('缺少搜索词 / 执行计划');
  }

  const commentCfg = pickCommentConfig({ ...cfg, ...plan });
  const commentPages = Number(cfg.commentPages || 0);
  const keepOpen = !!options.keepOpen;
  const reuse = options.connection || null;
  /** 人机验证挂起时 finally 不关窗 */
  let holdForHumanVerify = false;

  const stats = {
    browsed: 0,
    liked: 0,
    favorited: 0,
    followed: 0,
    commented: 0,
    commentsOpened: 0,
    commentLiked: 0,
    skipped: 0,
    planVideoTotal: Number(plan.videoTotal || 0),
    screenshot: '',
    lastCommentText: '',
  };
  const keywordResults = [];

  let connection = reuse;
  let owned = false;

  try {
    if (!connection) {
      logWarm(accountId, `打开浏览器 → 首页 · 计划 ${stats.planVideoTotal} 条 · ${keywords.length} 个关键词`);
      // 先只拉起比特，避免 connect 里 goto 与后续首页 goto 叠加重试冲突
      const { parseSaveTrafficFlag } = require('./save-traffic');
      connection = await connectAccount(accountId, null, 'warm', {
        saveTraffic: parseSaveTrafficFlag(cfg.saveTraffic ?? cfg.save_traffic ?? options.saveTraffic, true),
        browserBackend: cfg.browserBackend || cfg.browser_backend || options.browserBackend,
      });
      owned = true;
      await humanPause(1200, 0.2);
    }

    let page = await gotoHome(connection, accountId);

    const { ensureSessionLoggedIn } = require('./tiktok-actions');
    connection.page = page;
    const session = await ensureSessionLoggedIn(connection, accountId, {
      reloadUrl: 'https://www.tiktok.com/',
      label: '养号',
    }).catch(() => null);
    if (session && session.loggedIn === false) {
      stats.screenshot = await capture(page, `warm-nologin-${accountId}`).catch(() => '');
      throw new Error('当前浏览器没有有效 TikTok 登录状态，请先登录后再养号');
    }

    const ctx = {
      accountId,
      cfg,
      ...commentCfg,
      commentPages,
      stats,
      connection,
    };

    for (let ki = 0; ki < keywords.length; ki++) {
      page = await ensureLivePage(connection);
      let kwResult;
      try {
        kwResult = await runKeyword(page, keywords[ki], ctx);
      } catch (err) {
        const msg = String(err.message || err);
        // 登录/连接类致命错误仍中断整账号；搜索无结果类应已在 runKeyword 内消化
        if (/没有有效 TikTok 登录|比特|自研浏览器|浏览器已关闭|ERR_CONNECTION|页面已关闭|人机验证.*超时/i.test(msg)) {
          throw err;
        }
        logWarm(accountId, `关键词「${keywords[ki]?.term || ''}」异常，跳过改下一词: ${msg}`);
        kwResult = {
          term: String(keywords[ki]?.term || ''),
          planned: Number(keywords[ki]?.videoCount || (keywords[ki]?.videos || []).length || 0),
          browsed: 0,
          skipped: Number(keywords[ki]?.videoCount || (keywords[ki]?.videos || []).length || 0),
          openedFeed: false,
          noResults: true,
          skipReason: msg,
        };
        ctx.stats.skipped = (ctx.stats.skipped || 0) + (kwResult.skipped || 0);
        try {
          page = await gotoHome(connection, accountId);
        } catch { /* ignore */ }
      }
      keywordResults.push(kwResult);
      if (kwResult?.securityPaused) {
        holdForHumanVerify = true;
        break;
      }
      if (kwResult?.noResults) {
        logWarm(accountId, `已跳过「${kwResult.term}」，准备下一个关键词 (${ki + 1}/${keywords.length})`);
      }
      if (ki < keywords.length - 1) {
        await humanPause(randInt(1500, 2800), 0.2);
      }
    }

    page = await ensureLivePage(connection).catch(() => connection.page);
    if (holdForHumanVerify || keywordResults.some((k) => k?.securityPaused)) {
      holdForHumanVerify = true;
      stats.screenshot = stats.screenshot
        || (await capture(page, `warm-captcha-hold-${accountId}`).catch(() => ''));
      return {
        status: 'security_paused',
        reason: 'TikTok 人机验证（滑块/拼图），请在浏览器完成验证后从右上角通知恢复任务',
        manualRequired: true,
        screenshot: stats.screenshot || '',
        ...stats,
        keywords: keywordResults,
        executionPlan: plan,
      };
    }
    if (!stats.browsed) {
      stats.screenshot = await capture(page, `warm-empty-${accountId}`).catch(() => '');
      const reasons = keywordResults
        .map((k) => String(k?.skipReason || ''))
        .filter(Boolean);
      const captchaHit = reasons.some((r) => /人机验证|滑块|拼图|captcha/i.test(r));
      if (captchaHit) {
        holdForHumanVerify = true;
        return {
          status: 'security_paused',
          reason: 'TikTok 人机验证（滑块/拼图），请在浏览器完成验证后从右上角通知恢复任务',
          manualRequired: true,
          screenshot: stats.screenshot || '',
          ...stats,
          keywords: keywordResults,
          executionPlan: plan,
        };
      }
      throw new Error(
        `未刷到任何视频。关键词结果：${reasons.slice(0, 3).join('；') || '无可用结果'}。请检查登录状态、验证码或网络`
      );
    }

    logWarm(accountId, `完成 browsed=${stats.browsed} liked=${stats.liked} commented=${stats.commented} skipped=${stats.skipped}`);

    return {
      status: 'success',
      ...stats,
      commentMode: commentCfg.commentMode,
      commentText: stats.lastCommentText || commentCfg.commentText,
      commentTexts: commentCfg.commentTexts,
      keywords: keywordResults,
      executionPlan: plan,
    };
  } finally {
    // 总任务 keepBrowser / 人机验证挂起：不关窗口
    if (owned && connection && !keepOpen && !holdForHumanVerify) {
      await closeConnection(connection);
    }
  }
}

module.exports = {
  runWarmAccount,
  buildSearchUrl,
  buildExecutionPlanLocal,
  resolvePlan,
  pickCommentConfig,
  resolveCommentText,
  readBrowseVideoMeta,
  DEFAULT_COMMENT_TEXT,
  HOME_URL,
  SELECTORS,
};
