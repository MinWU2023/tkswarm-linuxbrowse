/**
 * 拉取视频列表：打开 TikTok Studio 内容页，抓封面/标题/链接，入库为「线上」素材。
 */
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { publish: liveLog } = require('../live-log');
const { inspectTikTokSession } = require('./cdp-client');
const { capture } = require('../automation-guard');

const CONTENT_URLS = [
  'https://www.tiktok.com/tiktokstudio/content?lang=en',
  'https://www.tiktok.com/tiktokstudio/content?tab=video&lang=en',
  'https://www.tiktok.com/tiktokstudio/content',
];

/** 与删除视频一致：等列表文案 / 视频链出现 */
async function waitStudioContentReady(page, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const ready = await page.evaluate(() => {
      const t = (document.body?.innerText || '').slice(0, 12000);
      if (/Posts\s*\(Created on\)|Search for post description|Views[\s\S]{0,80}Likes|Privacy/i.test(t)) return true;
      if (document.querySelectorAll('a[href*="/video/"]').length > 0) return true;
      // 常见作品行特征：时长 + Everyone / Views
      if (/\d{1,2}:\d{2}/.test(t) && /\b(Everyone|Friends|Only you|Views|Likes)\b/i.test(t)) return true;
      return false;
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

function attachStudioApiListener(page, bucket) {
  const onResponse = async (res) => {
    try {
      if (bucket.length >= 40) return;
      const url = res.url() || '';
      // 收紧：只收「我的帖子/作品列表」相关接口，避免 content|aweme|studio/api 把推荐/相关视频一并吸入
      if (!/(item_list|item\/list|post\/list|posted\/list|creator\/.*?(post|item)|\/api\/post\/item_list)/i.test(url)) return;
      // 明确排除推荐 / 发现 / 相关 / 广告类接口
      if (/(recommend|related|discover|foryou|for_you|ads?\/|promote|trending|search)/i.test(url)) return;
      const ct = String(res.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      const json = await res.json().catch(() => null);
      if (!json) return;
      bucket.push({ url, json });
    } catch { /* ignore */ }
  };
  page.on('response', onResponse);
  return () => {
    try { page.off('response', onResponse); } catch { /* ignore */ }
  };
}

function extractAuthorMeta(node) {
  const author = node?.author || node?.authorInfo || node?.creator || node?.user || {};
  const uniqueId = String(
    author.uniqueId || author.unique_id || author.unique_name || author.username
    || node.uniqueId || node.unique_id || node.authorUniqueId || node.author_unique_id || ''
  ).replace(/^@+/, '').trim().toLowerCase();
  const secUid = String(
    author.secUid || author.sec_uid || node.secUid || node.sec_uid || ''
  ).trim();
  const uid = String(author.id || author.uid || node.author_id || node.authorId || '').trim();
  const shareUrl = String(node.share_url || node.shareUrl || node.videoUrl || node.video_url || '');
  const urlHandle = (shareUrl.match(/tiktok\.com\/@([^/?#]+)/i) || [])[1] || '';
  return {
    uniqueId: uniqueId || String(urlHandle).replace(/^@+/, '').trim().toLowerCase(),
    secUid,
    uid,
  };
}

function authorMatchesAccount(meta, expectUsername = '', expectSecUid = '') {
  const expect = String(expectUsername || '').replace(/^@+/, '').trim().toLowerCase();
  const sec = String(expectSecUid || '').trim();
  if (sec && meta.secUid && meta.secUid === sec) return true;
  if (expect && meta.uniqueId && meta.uniqueId === expect) return true;
  // 无作者信息：不可信，交给上层决定是否丢弃
  if (!meta.uniqueId && !meta.secUid && !meta.uid) return null;
  return false;
}

function walkCollectVideos(node, out, depth = 0) {
  if (!node || depth > 14 || out.length >= 150) return;
  if (Array.isArray(node)) {
    node.forEach((x) => walkCollectVideos(x, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const id = String(
    node.id || node.aweme_id || node.awemeId || node.itemId || node.item_id
    || node.video_id || node.videoId || node.itemID || ''
  ).trim();
  const title = String(node.desc || node.title || node.description || node.caption || node.text || '').trim();
  const pickCover = () => {
    const tryOne = (c) => {
      if (!c) return '';
      if (typeof c === 'object') c = c.urlList?.[0] || c.url_list?.[0] || c.url || '';
      c = String(c || '').trim();
      return /^https?:\/\//i.test(c) ? c : '';
    };
    return tryOne(node.video?.cover)
      || tryOne(node.video?.originCover)
      || tryOne(node.cover)
      || tryOne(node.originCover)
      || tryOne(node.covers?.[0])
      || tryOne(node.thumbnail)
      || tryOne(node.coverUrl)
      || '';
  };
  if (/^\d{8,}$/.test(id)) {
    const stats = node.stats || node.statistics || node.stat || {};
    const author = extractAuthorMeta(node);
    out.push({
      videoId: id,
      videoUrl: String(node.share_url || node.shareUrl || node.videoUrl || node.video_url || '').split('?')[0]
        || `https://www.tiktok.com/video/${id}`,
      title,
      coverUrl: pickCover(),
      views: Number(stats.playCount ?? stats.play_count ?? stats.views ?? node.views ?? 0) || 0,
      likes: Number(stats.diggCount ?? stats.digg_count ?? stats.likes ?? node.likes ?? 0) || 0,
      comments: Number(stats.commentCount ?? stats.comment_count ?? stats.comments ?? node.comments ?? 0) || 0,
      shares: Number(stats.shareCount ?? stats.share_count ?? stats.shares ?? 0) || 0,
      postedAt: String(node.createTime || node.create_time || node.postedAt || '').slice(0, 64),
      authorUsername: author.uniqueId,
      authorSecUid: author.secUid,
      authorUid: author.uid,
    });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkCollectVideos(v, out, depth + 1);
  }
}

function videosFromApiHits(apiHits, expectUsername = '', expectSecUid = '') {
  const raw = [];
  const seen = new Set();
  for (const hit of apiHits || []) {
    walkCollectVideos(hit.json, raw);
  }
  const out = [];
  let dropped = 0;
  for (const row of raw) {
    if (!row.videoId || seen.has(row.videoId)) continue;
    const match = authorMatchesAccount({
      uniqueId: row.authorUsername || '',
      secUid: row.authorSecUid || '',
      uid: row.authorUid || '',
    }, expectUsername, expectSecUid);
    // 有作者信息但不是本号 → 丢弃；无作者信息的脏 JSON 也丢弃（避免推荐视频混入）
    if (match === false || match === null) {
      dropped += 1;
      continue;
    }
    seen.add(row.videoId);
    out.push(row);
  }
  return { items: out.slice(0, 120), dropped };
}

/**
 * Studio 内容页 DOM：表格或虚拟列表行（常无公开 /video/ 链，先抓标题+封面）。
 */
async function scrapeStudioContentList(page) {
  return page.evaluate(() => {
    const pickId = (u) => {
      const m = String(u || '').match(/\/video\/(\d{8,})/);
      return m ? m[1] : '';
    };
    const isNum = (s) => /^[+-]?[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(String(s || '').trim());
    const isHeader = (t) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (!s) return true;
      if (/^Posts\s*\(Created on\)/i.test(s) && s.length < 80) return true;
      if (/^(Posts|Privacy|Views|Likes|Comments|Actions|Status)(\s|$)/i.test(s) && s.length < 120) return true;
      return false;
    };
    const items = [];
    const seen = new Set();
    const push = (raw) => {
      const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const videoUrl = String(raw.videoUrl || '').split('?')[0];
      let videoId = String(raw.videoId || pickId(videoUrl) || '').trim();
      if (!videoId && /^\d{8,}$/.test(String(raw.attrId || ''))) videoId = String(raw.attrId);
      const key = videoId || `${title}|${raw.views || 0}|${raw.postedAt || ''}`;
      if (!title && !videoId) return;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        title,
        views: Number(raw.views) || 0,
        likes: Number(raw.likes) || 0,
        comments: Number(raw.comments) || 0,
        shares: Number(raw.shares) || 0,
        postedAt: String(raw.postedAt || '').slice(0, 64),
        videoId,
        videoUrl: videoUrl || (videoId ? `https://www.tiktok.com/video/${videoId}` : ''),
        coverUrl: String(raw.coverUrl || '').slice(0, 1000),
      });
    };

    const rowSel = 'tr, [role="row"], [class*="Row"], [class*="row"], li, [class*="Item"], [class*="item"], [class*="card" i], [class*="Card"]';
    const rows = [...document.querySelectorAll(rowSel)];
    for (const row of rows) {
      const t = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 8 || isHeader(t)) continue;
      const hasAction = !!row.querySelector('button, [role="button"], svg');
      const looksPost = /\bEveryone\b|\bFriends\b|\bOnly you\b|仅自己|好友|所有人/i.test(t)
        || (/\d{1,2}:\d{2}/.test(t) && /Views|Likes|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|\d{4}/i.test(t));
      if (!hasAction && !looksPost && !row.querySelector('a[href*="/video/"]')) continue;

      const a = row.querySelector('a[href*="/video/"], a[href*="item_id="], a[href*="aweme"], a[href*="tiktok.com/@"]');
      const img = row.querySelector('img');
      const lines = t.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean);
      const cells = [...row.querySelectorAll('td')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
      const textParts = cells.length ? cells : lines;
      const title = textParts
        .filter((c) => c && !isNum(c) && !/^(Everyone|Friends|Only you|Public|Private|Views|Likes|Comments)$/i.test(c))
        .filter((c) => !/^\d{1,2}:\d{2}(:\d{2})?$/.test(c))
        .sort((a, b) => b.length - a.length)[0]
        || (a?.getAttribute('aria-label') || a?.innerText || '').trim();
      const nums = textParts.filter(isNum);
      let cover = img?.currentSrc || img?.src || img?.getAttribute('data-src') || '';
      if (!/^https?:\/\//i.test(cover)) {
        const bgEl = row.querySelector('[style*="background"], [class*="cover" i], [class*="thumb" i], [class*="Cover"], [class*="Thumb"]');
        const style = bgEl ? (bgEl.getAttribute('style') || '') : '';
        const bm = style.match(/url\(["']?(https?[^"')]+)/i);
        if (bm) cover = bm[1];
      }
      const attrId = row.getAttribute('data-video-id')
        || row.getAttribute('data-item-id')
        || row.getAttribute('data-id')
        || row.querySelector('[data-video-id]')?.getAttribute('data-video-id')
        || row.querySelector('[data-item-id]')?.getAttribute('data-item-id')
        || '';
      const href = a?.href || '';
      push({
        title: String(title || '').replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, ''),
        views: nums[0],
        likes: nums[1],
        comments: nums[2],
        shares: nums[3],
        postedAt: textParts.find((l) => /\b(ago|天前|周前|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|\d{4})\b/i.test(l)) || '',
        videoUrl: href,
        videoId: pickId(href) || (/^\d{8,}$/.test(attrId) ? attrId : ''),
        attrId,
        coverUrl: /^https?:\/\//i.test(cover) ? cover : '',
      });
    }

    // 再扫一遍所有 /video/ 链（虚拟列表可能行选择器漏掉）
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const href = (a.href || '').split('?')[0];
      const id = pickId(href);
      if (!id) continue;
      const img = a.querySelector('img');
      push({
        title: (a.getAttribute('aria-label') || a.innerText || '').replace(/\s+/g, ' ').trim(),
        videoUrl: href,
        videoId: id,
        coverUrl: img?.src || '',
      });
    }

    return items.slice(0, 120);
  }).catch(() => []);
}

async function scrollStudioList(page, rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('[class*="scroll" i], [class*="Scroll" i], [class*="list" i], [class*="List" i], main, [role="main"]'),
        document.scrollingElement,
        document.documentElement,
        document.body,
      ].filter(Boolean);
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        try {
          const sh = el.scrollHeight || 0;
          const ch = el.clientHeight || 0;
          if (sh > ch + 80 && sh > bestScore) {
            best = el;
            bestScore = sh;
          }
        } catch { /* ignore */ }
      }
      if (best) best.scrollTop = (best.scrollTop || 0) + Math.max(600, Math.floor((best.clientHeight || 800) * 0.9));
      else window.scrollBy(0, 1200);
    }).catch(() => {});
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * 以「主页目录 catalog」为权威来源（secUid item_list，仅本账号投稿）。
 * DOM / Studio API 只用于补封面与统计；不再把无作者校验的 API 剩余项直接入库。
 */
function mergeByVideoId(domRows, catalog, username = '', trustedApiRows = []) {
  const uname = String(username || '').replace(/^@+/, '').trim();
  const byId = new Map();
  // 权威：主页目录
  for (const row of catalog || []) {
    const id = String(row.videoId || '').trim();
    if (id) byId.set(id, { ...row, _src: 'catalog' });
  }
  // 可信 API（已按作者过滤）仅在 catalog 为空时作为补充源
  if (!byId.size) {
    for (const row of trustedApiRows || []) {
      const id = String(row.videoId || '').trim();
      if (id && !byId.has(id)) byId.set(id, { ...row, _src: 'api' });
    }
  } else {
    // catalog 已有：API 只 enrich，不新增 ID
    for (const row of trustedApiRows || []) {
      const id = String(row.videoId || '').trim();
      if (!id || !byId.has(id)) continue;
      const cur = byId.get(id);
      byId.set(id, {
        ...cur,
        title: cur.title || row.title || '',
        coverUrl: cur.coverUrl || row.coverUrl || '',
        views: cur.views || row.views || 0,
        likes: cur.likes || row.likes || 0,
        comments: cur.comments || row.comments || 0,
      });
    }
  }

  const out = [];
  const seen = new Set();
  const enrichFromDom = (base) => {
    const id = String(base.videoId || '').trim();
    const domHit = (domRows || []).find((r) => String(r.videoId || '') === id)
      || (base.title ? (domRows || []).find((r) => {
        const t = String(r.title || '').toLowerCase().replace(/^\d{1,2}:\d{2}\s+/, '').slice(0, 40);
        const ct = String(base.title || '').toLowerCase().slice(0, 40);
        return t && ct && (ct.includes(t) || t.includes(ct));
      }) : null);
    let videoUrl = String(base.videoUrl || domHit?.videoUrl || '').trim();
    if (id && uname) {
      videoUrl = `https://www.tiktok.com/@${encodeURIComponent(uname)}/video/${id}`;
    } else if (!videoUrl && id) {
      videoUrl = `https://www.tiktok.com/video/${id}`;
    }
    return {
      title: base.title || domHit?.title || '',
      views: Number(domHit?.views || base.views || 0) || 0,
      likes: Number(domHit?.likes || base.likes || 0) || 0,
      comments: Number(domHit?.comments || base.comments || 0) || 0,
      shares: Number(domHit?.shares || base.shares || 0) || 0,
      postedAt: String(domHit?.postedAt || base.postedAt || '').slice(0, 64),
      videoId: id,
      videoUrl,
      coverUrl: String(domHit?.coverUrl || base.coverUrl || '').slice(0, 1000),
      authorUsername: uname,
    };
  };

  // 有权威目录 / 可信 API：只输出这些 ID
  if (byId.size) {
    for (const row of byId.values()) {
      const videoId = String(row.videoId || '').trim();
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      out.push(enrichFromDom(row));
    }
    return out.slice(0, 120);
  }

  // 兜底：仅当主页+可信 API 都空时，才用 DOM（且必须带 videoId；URL 含 @本号 才收）
  for (const row of domRows || []) {
    const videoId = String(row.videoId || '').trim();
    if (!videoId) continue;
    const href = String(row.videoUrl || '');
    if (uname) {
      const handle = ((href.match(/tiktok\.com\/@([^/?#]+)/i) || [])[1] || '').replace(/^@+/, '').toLowerCase();
      // DOM 链带了别人的 @handle → 丢弃；无 handle 的短链暂收（Studio 列表常见）
      if (handle && handle !== uname.toLowerCase()) continue;
    }
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push(enrichFromDom({ ...row, videoId }));
  }
  return out.slice(0, 120);
}

async function pageDiag(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const videoLinks = document.querySelectorAll('a[href*="/video/"]').length;
    const imgs = document.querySelectorAll('img').length;
    return { url: location.href, text, videoLinks, imgs };
  }).catch(() => ({ url: '', text: '', videoLinks: 0, imgs: 0 }));
}

async function ensureStudioContentPage(page, log = () => {}) {
  if (/tiktokstudio\/content/i.test(page.url() || '')) {
    const ready = await waitStudioContentReady(page, 8000);
    if (ready) return true;
  }
  for (const url of CONTENT_URLS) {
    log(`返回内容列表 ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (await waitStudioContentReady(page, 15000)) return true;
  }
  return /tiktokstudio\/content/i.test(page.url() || '');
}

/** Studio 内容列表页（含 ?videoId= 伪详情）一律不当作视频详情 */
function isStudioContentListUrl(url) {
  const href = String(url || '');
  if (!/tiktokstudio\/content/i.test(href)) return false;
  // analytics 不在 content 路径下；content 本身就是列表
  return true;
}

function buildVideoDetailCandidates(videoId, username, videoUrl = '') {
  const id = String(videoId || '').trim();
  const handle = String(username || '').replace(/^@+/, '').trim();
  const out = [];
  const push = (u) => {
    const s = String(u || '').trim().split('#')[0];
    if (s && !out.includes(s)) out.push(s);
  };
  // 优先 Studio 视频分析/详情（创作者后台真实详情，不是 content 列表）
  push(`https://www.tiktok.com/tiktokstudio/analytics/${id}`);
  push(`https://www.tiktok.com/tiktokstudio/analytics/video/${id}`);
  if (handle) push(`https://www.tiktok.com/@${encodeURIComponent(handle)}/video/${id}`);
  const raw = String(videoUrl || '').trim();
  if (/\/@[^/?#]+\/video\/\d+/i.test(raw)) push(raw.split('?')[0]);
  push(`https://www.tiktok.com/video/${id}`);
  return out;
}

/**
 * 仅认真实详情页：Studio analytics 或公开 /@user/video/id。
 * 明确拒绝 tiktokstudio/content 列表（此前误把列表当详情截图）。
 */
async function isVideoDetailPage(page, videoId) {
  const id = String(videoId || '').trim();
  const href = String(page.url() || '');
  if (!id || !href) return false;
  if (isStudioContentListUrl(href)) return false;
  if (/\/(login|signup|404)(\?|$|\/)/i.test(href) && !href.includes(id)) return false;

  if (/tiktokstudio\/analytics/i.test(href) && href.includes(id)) {
    const ready = await page.evaluate(() => {
      const t = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 40) return false;
      return /Views|Likes|Comments|Overview|Analytics|Post details|视频详情|播放|点赞|评论/i.test(t);
    }).catch(() => false);
    return !!ready;
  }

  if (/\/video\/\d+/i.test(href) && href.includes(id) && !/tiktokstudio/i.test(href)) {
    const ready = await page.evaluate((vid) => {
      const t = (document.body?.innerText || '').slice(0, 8000);
      if (/Oops|something went wrong|页面不存在|视频不存在/i.test(t)) return false;
      if (location.href.includes(vid)) return true;
      return !!document.querySelector(
        '[data-e2e="browse-video"], [data-e2e="video-detail"], video, [class*="VideoPlayer"], [class*="video-player"]'
      );
    }, id).catch(() => false);
    return !!ready;
  }

  return false;
}

/** 关掉除主窗口外的多余标签，避免列表点击/跳转开出多子窗口并行 */
async function closeExtraPages(page, log = () => {}) {
  if (!page) return;
  let context = null;
  try { context = page.context?.(); } catch { context = null; }
  if (!context || typeof context.pages !== 'function') return;
  const pages = context.pages();
  for (const p of pages) {
    if (!p || p === page) continue;
    try {
      if (typeof p.isClosed === 'function' && p.isClosed()) continue;
    } catch { /* ignore */ }
    try {
      log(`关闭多余子窗口 ${(p.url?.() || '').slice(0, 80)}`);
      await p.close({ runBeforeUnload: false });
    } catch { /* ignore */ }
  }
  try { await page.bringToFront(); } catch { /* ignore */ }
}

/**
 * 主环境窗口内串行 goto 视频详情（禁止点列表开新窗/侧栏误判）。
 */
async function openVideoDetailPage(page, videoId, username, log = () => {}, videoUrl = '') {
  const id = String(videoId || '').trim();
  if (!/^\d{5,}$/.test(id)) return { ok: false, reason: 'bad-id' };

  await closeExtraPages(page, log);

  const candidates = buildVideoDetailCandidates(id, username, videoUrl);
  for (const url of candidates) {
    log(`主窗口打开详情 ${url}`);
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await closeExtraPages(page, log);
    await page.waitForTimeout(1200);

    const end = Date.now() + 12000;
    while (Date.now() < end) {
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(page);
      } catch { /* ignore */ }
      const href = String(page.url() || '');
      if (isStudioContentListUrl(href)) break;
      if (/\/(login|signup)(\?|$|\/)/i.test(href) && !href.includes(id)) break;
      if (await isVideoDetailPage(page, id)) {
        return { ok: true, via: 'detail_goto', url: href || url };
      }
      await page.waitForTimeout(500);
    }

    const href = String(page.url() || '');
    if (isStudioContentListUrl(href)) {
      log(`仍停在 Studio 列表，换下一候选 videoId=${id}`);
      continue;
    }
    log(`详情未就绪，换下一候选 videoId=${id} url=${href.slice(0, 120)}`);
  }
  return { ok: false, reason: 'open-failed', url: page.url() };
}

async function capturePageBase64(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false }).catch(() => null);
  if (!buf || !buf.length) return '';
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** 截图阶段强制省流（拦视频/媒体），避免详情页拉流 */
async function ensureShotSaveTraffic(page, log = () => {}) {
  try {
    const { applySaveTrafficOnConnection } = require('./save-traffic');
    await applySaveTrafficOnConnection({ page, context: page?.context?.() }, true);
    log('详情截图已开启省流（拦截视频等媒体）');
    return true;
  } catch (e) {
    log(`开启省流失败：${e.message || e}`);
    return false;
  }
}

/**
 * 列表入库后：主窗口串行打开真实视频详情 → 截图 → 再跳下一条（不开多子窗并行）
 */
async function captureAndSaveVideoDetails(page, accountId, items, username, log = () => {}, options = {}) {
  const list = (items || []).filter((x) => x && x.videoId);
  const max = Math.max(1, Math.min(120, Number(options.maxScreenshots || options.max_screenshots || 80)));
  const slice = list.slice(0, max);
  let saved = 0;
  let failed = 0;

  await ensureShotSaveTraffic(page, log);
  await closeExtraPages(page, log);

  // 截图期间若意外弹出新标签，立即关掉，保证只在主窗口串行
  let context = null;
  try { context = page.context?.(); } catch { context = null; }
  const onPopup = (p) => {
    if (!p || p === page) return;
    Promise.resolve()
      .then(async () => {
        try {
          log(`拦截并关闭弹窗子窗口 ${(p.url?.() || '').slice(0, 80)}`);
          await p.close({ runBeforeUnload: false });
        } catch { /* ignore */ }
      })
      .catch(() => {});
  };
  if (context?.on) context.on('page', onPopup);

  try {
    for (let i = 0; i < slice.length; i += 1) {
      const row = slice[i];
      const vid = String(row.videoId);
      log(`详情截图 ${i + 1}/${slice.length} videoId=${vid}`);
      try {
        await closeExtraPages(page, log);
        const opened = await openVideoDetailPage(page, vid, username, log, row.videoUrl || '');
        if (!opened?.ok) {
          failed += 1;
          log(`打开详情失败 videoId=${vid}：${opened?.reason || 'unknown'}`);
          continue;
        }
        // 再次确认不是列表页，避免误存 Studio 列表截图
        if (isStudioContentListUrl(page.url()) || !(await isVideoDetailPage(page, vid))) {
          failed += 1;
          log(`拒绝非详情页截图 videoId=${vid} url=${String(page.url() || '').slice(0, 120)}`);
          continue;
        }
        await page.waitForTimeout(400);
        const b64 = await capturePageBase64(page);
        if (!b64) {
          failed += 1;
          log(`截图为空 videoId=${vid}`);
          continue;
        }
        await phpApi.post(`/node/accounts/${accountId}/tiktok-videos/screenshots`, {
          videoId: vid,
          videoUrl: row.videoUrl || '',
          pageUrl: page.url() || opened.url || '',
          source: 'video_detail',
          mimeType: 'image/jpeg',
          screenshotBase64: b64,
        });
        saved += 1;
        log(`截图已保存 videoId=${vid} via=${opened.via}`);
      } catch (e) {
        failed += 1;
        log(`截图保存失败 videoId=${vid}：${e.message || e}`);
      }
      // 下一条直接 goto 下一个详情，不回列表、不开新窗
    }
  } finally {
    if (context?.off) {
      try { context.off('page', onPopup); } catch { /* ignore */ }
    }
    await closeExtraPages(page, log).catch(() => {});
  }
  return { saved, failed, total: slice.length, skipped: Math.max(0, list.length - slice.length) };
}

/**
 * @param {number|string} accountId
 * @param {object} [options]
 */
async function pullOnlineVideoList(accountId, options = {}) {
  let account;
  try {
    account = await dataStore.getAccountBundle(accountId);
  } catch (e) {
    throw new Error(`读取账号包失败：${e.message}`);
  }
  if (!account) throw new Error('账号不存在');

  const logCtx = { accountId, ...(options.logContext || {}) };
  const log = (msg) => liveLog(`拉取视频列表#${accountId}：${msg}`, 'info', logCtx);
  const { connectAccount, closeConnection } = require('./tiktok-actions');
  // 先连上再自己 goto 内容页；省流默认开，详情截图时不加载视频流
  const saveTraffic = options.saveTraffic !== false && options.save_traffic !== false;
  const connection = await connectAccount(accountId, null, 'sync', { saveTraffic });
  const page = connection.page;
  const apiHits = [];
  const detachApi = attachStudioApiListener(page, apiHits);

  try {
    const session = await inspectTikTokSession(connection.ws, page).catch(() => null);
    if (session && session.loggedIn === false) {
      throw new Error('当前浏览器没有有效 TikTok 登录状态，请先到账号页登录后再拉取');
    }

    let listReady = false;
    for (const url of CONTENT_URLS) {
      log(`打开 ${url}`);
      await page.bringToFront().catch(() => {});
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const href = String(page.url() || '');
      if (!/tiktokstudio\/content/i.test(href)) {
        log(`未落到内容页，当前 ${href}`);
        continue;
      }
      listReady = await waitStudioContentReady(page, 25000);
      log(`内容页就绪=${listReady} url=${page.url()}`);
      if (listReady) break;
    }
    if (!/tiktokstudio\/content/i.test(page.url() || '')) {
      const diag = await pageDiag(page);
      await capture(page, accountId, 'pull-list', 'wrong-page').catch(() => '');
      throw new Error(`无法打开 Studio 内容页（当前 ${diag.url || page.url()}）`);
    }
    if (!listReady) {
      log('列表特征未出现，仍尝试抓取（可能是新版布局或空账号）');
    }

    await scrollStudioList(page, 12);
    let domRows = await scrapeStudioContentList(page);
    log(`Studio 内容页 DOM：${domRows.length} 条；监听 API ${apiHits.length} 条`);

    const username = account.username || '';
    let apiPack = videosFromApiHits(apiHits, username);
    let fromApi = apiPack.items || [];
    if (fromApi.length || apiPack.dropped) {
      log(`Studio 接口解析：保留 ${fromApi.length} 条（按作者过滤丢弃 ${apiPack.dropped || 0}）`);
    }

    let catalog = [];
    try {
      const { fetchProfileVideoCatalog } = require('./tiktok-studio-stats');
      if (typeof fetchProfileVideoCatalog === 'function') {
        const catalogResult = await fetchProfileVideoCatalog(page, account.username || '', log);
        catalog = Array.isArray(catalogResult) ? catalogResult : (catalogResult?.items || []);
      }
    } catch (e) {
      log(`主页目录失败：${e.message || e}`);
      catalog = [];
    }

    // 回到内容页再扫一轮（主页跳转后列表可能更全）
    if ((!domRows.length || !domRows.some((r) => r.videoId)) && /tiktok\.com\/@/i.test(page.url() || '')) {
      log('从主页返回 Studio 内容页补抓');
      await page.goto(CONTENT_URLS[0], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitStudioContentReady(page, 20000);
      await scrollStudioList(page, 8);
      const again = await scrapeStudioContentList(page);
      if (again.length > domRows.length) domRows = again;
      apiPack = videosFromApiHits(apiHits, username);
      fromApi = apiPack.items || [];
    }

    // 主页目录为权威；已过滤作者的 API 仅作 enrich / 兜底
    let items = mergeByVideoId(domRows, catalog, username, fromApi);
    if (!items.some((x) => x.videoId) && (fromApi.length || catalog.length)) {
      items = mergeByVideoId([], catalog, username, fromApi);
    }

    const withId = items.filter((x) => x.videoId).length;
    const withCover = items.filter((x) => x.coverUrl).length;
    log(`合并后 ${items.length} 条（有 ID ${withId}，有封面 ${withCover}）`);

    // 只要有平台 ID 的才入库；仅有标题没有 ID 的跳过
    const toSave = items.filter((x) => x.videoId);
    if (!toSave.length) {
      const diag = await pageDiag(page);
      await capture(page, accountId, 'pull-list', 'empty').catch(() => '');
      throw new Error(
        `未抓到任何已发布视频（DOM=${domRows.length} API=${fromApi.length} 主页=${catalog.length}；`
        + `页内 /video/ 链=${diag.videoLinks}）。当前 ${diag.url || page.url()}。`
        + `摘要：${String(diag.text || '').slice(0, 160)}`
      );
    }

    try {
      await dataStore.tiktokSync(account.id, {
        videos: toSave.map((x) => ({
          videoId: x.videoId,
          videoUrl: x.videoUrl,
          description: x.title,
          thumbnailUrl: x.coverUrl,
        })),
      });
    } catch (e) {
      log(`tiktok_videos 同步失败：${e.message}`);
    }

    const saved = await phpApi.post(`/node/accounts/${account.id}/online-materials/sync`, {
      items: toSave.map((x) => ({
        title: x.title,
        videoId: x.videoId,
        videoUrl: x.videoUrl,
        coverUrl: x.coverUrl,
        views: x.views,
        likes: x.likes,
        comments: x.comments,
        postedAt: x.postedAt,
        authorUsername: x.authorUsername || username,
      })),
    });

    const created = Number(saved?.created || 0);
    const updated = Number(saved?.updated || 0);
    const skipped = Number(saved?.skipped || 0);
    log(`入库完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}`);

    // 列表入库后：主窗口串行打开真实视频详情截图（不回列表点行、不开多子窗）
    let shot = { saved: 0, failed: 0, total: 0, skipped: 0 };
    const skipShots = options.skipScreenshots === true || options.skip_screenshots === true;
    if (!skipShots && toSave.length) {
      log(`开始详情截图，共 ${toSave.length} 条（主窗口串行，省流拦截视频）`);
      shot = await captureAndSaveVideoDetails(
        page,
        account.id,
        toSave,
        username,
        log,
        options
      );
      log(`详情截图完成：成功 ${shot.saved}，失败 ${shot.failed}，跳过 ${shot.skipped || 0}`);
    }

    return {
      status: 'ok',
      accountId: Number(account.id),
      count: toSave.length,
      created,
      updated,
      skipped,
      screenshotsSaved: shot.saved,
      screenshotsFailed: shot.failed,
      message: `拉取视频列表完成：${toSave.length} 条（新建 ${created}，更新 ${updated}；详情截图 ${shot.saved}/${shot.total || 0}）`,
    };
  } finally {
    detachApi();
    await closeConnection(connection).catch(() => {});
  }
}

module.exports = { pullOnlineVideoList, captureAndSaveVideoDetails };
