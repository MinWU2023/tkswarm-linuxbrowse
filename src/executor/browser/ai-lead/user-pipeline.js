/**
 * AI拓客 · 按用户类型
 * 搜索 Users → 粉丝筛选 → 打开主页校验点赞 → 抓视频 → 抓评论 → AI 筛选 → 入库
 *
 * 下限对应：
 *   关注 limitFollows → 创作者粉丝
 *   点赞 limitLikes   → 创作者主页获赞（不对视频）
 *   浏览 limitLook    → 主页视频网格播放量
 */
const { parseMetricCount, pickLabeledMetricText } = require('./parse-metric-count');
// 必须注入函数本体。toString 后在页面里可用；勿转发 Node 闭包。
const PARSE_METRIC_FN = parseMetricCount.toString();
const PICK_LABELED_METRIC_FN = pickLabeledMetricText.toString();

const {
  connectAccount,
  closeConnection,
  absUrl,
  profileUrlFromUsername,
  searchUsersPage,
  scrollLoadMore,
  scrollSearchResults,
  reportProgress,
  saveCreator,
  saveVideo,
  filterCommentsViaAi,
  saveMatchedComments,
  finishLead,
  safeGoto,
  humanPause,
  firstVisible,
  SELECTORS,
  liveLog,
  delay,
  assertLeadActive,
  clearLeadAbort,
  dismissSearchOverlays,
  countSearchUserSignals,
  registerLeadRun,
  unregisterLeadRun,
  isAbortError,
  isLeadAborted,
  toNavConnection,
  ensureLivePage,
} = require('./pipeline-base');

function isRecoverableBrowserError(err) {
  const msg = String(err?.message || err || '');
  return Boolean(err?.recoverable)
    || /BROWSER_DISCONNECTED|CONTEXT_DEAD|浏览器上下文已失效|浏览器进程已断开|ECONNREFUSED|Target page|has been closed|browser has been closed|CDP/i.test(msg);
}

const MAX_USERS = 30;
/** 列表粉丝为 0/未加载时，最多进主页复核的人数（避免 70 个全点主页） */
const MAX_PROFILE_VERIFY_PENDING = 25;
const MAX_VIDEOS_PER_USER = 20;
const MAX_COMMENT_ROUNDS = 8;
/** 搜索列表最多滚动轮次（每轮采集+筛选，无新用户连续 N 轮则停） */
const MAX_SEARCH_SCROLL_ROUNDS = 28;
const SEARCH_STALE_ROUNDS_STOP = 3;

/**
 * 页面上收集原始用户卡片（未做下限筛选）
 * 适配 TikTok 新版 Users 列表结构：
 *   a.link-a11y-focus[href="/@user"]
 *     > div[class*="DivSearchItemContainer"] / DivSearchUserItemContainer
 *       p(bold)=昵称, p(normal)=username, p+p = "37.1K"+"Followers", p+p = "243.1K"+"Likes"
 */
async function collectUsersFromFrame(frame) {
  return frame.evaluate((parseFnSource) => {
    const parseMetricCount = eval(`(${parseFnSource})`);

    const skipUser = (u) => {
      const x = String(u || '').toLowerCase();
      return !x || x === 'tiktok' || x.startsWith('http') || x.includes('login') || x.includes('signup');
    };

    /** 从卡片内 p/span 序列解析 Followers / Likes（数字与标签分列或合写） */
    const pickMetricFromLabels = (ps, labelRe) => {
      const numRe = /^[\d.,]+\s*[kKmMbB万亿wW]?$/i;
      // 嵌入组合正则时去掉 ^$，否则 "70.5K Followers" 永远匹配失败 → 粉丝被当成 0
      const labelBody = String(labelRe.source || '').replace(/^\^/, '').replace(/\$$/, '');
      for (let i = 0; i < ps.length; i += 1) {
        if (!labelRe.test(ps[i])) continue;
        for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
          const t = ps[j];
          if (numRe.test(t)) return t;
        }
        // 标签后也可能是数字（少见）
        for (let j = i + 1; j <= Math.min(ps.length - 1, i + 2); j += 1) {
          if (numRe.test(ps[j])) return ps[j];
        }
      }
      // 兼容 "70.5K Followers" / "70.5K·Followers" / "粉丝 70.5K" 合在同一节点
      const combined = new RegExp(
        `([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?\\s*[·•.\\-–—]?\\s*(?:${labelBody})`,
        'i'
      );
      const combinedRev = new RegExp(
        `(?:${labelBody})\\s*[·•.\\-–—]?\\s*([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?`,
        'i'
      );
      for (const t of ps) {
        const m = String(t).match(combined) || String(t).match(combinedRev);
        if (m) return m[0];
      }
      return '';
    };

    /** 整卡 text 兜底：避免 DOM 拆分变化导致读不到粉丝 */
    const pickMetricFromBlob = (blob, labelWords) => {
      const text = String(blob || '').replace(/\s+/g, ' ');
      if (!text) return '';
      const words = labelWords.join('|');
      const m1 = text.match(
        new RegExp(
          `([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?\\s*[·•]?\\s*(?:${words})`,
          'i'
        )
      );
      if (m1) return m1[0];
      const m2 = text.match(
        new RegExp(
          `(?:${words})\\s*[·•]?\\s*([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?`,
          'i'
        )
      );
      return m2 ? m2[0] : '';
    };

    // 新版：整行是 a.link-a11y-focus；旧版可能还有 data-e2e
    const anchors = Array.from(document.querySelectorAll(
      [
        'a.link-a11y-focus[href*="/@"]',
        'a[href*="/@"][class*="link"]',
        'div[class*="DivSearchUserItemContainer"] a[href*="/@"]',
        'div[class*="DivSearchItemContainer"] a[href*="/@"]',
        '[data-e2e="search-user-item"] a[href*="/@"]',
        'a[href*="/@"]',
      ].join(', ')
    ));

    const items = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (/\/video\//i.test(href)) continue;
      const m = href.match(/\/@([^/?#]+)/);
      if (!m) continue;
      let username = m[1];
      try { username = decodeURIComponent(username); } catch { /* keep */ }
      if (skipUser(username) || seen.has(username.toLowerCase())) continue;

      // 卡片根：优先 SearchUserItem / SearchItem 容器
      const root = anchor.querySelector('[class*="DivSearchUserItemContainer"], [class*="DivSearchItemContainer"]')
        || anchor.closest('[class*="DivSearchUserItemContainer"], [class*="DivSearchItemContainer"], [data-e2e="search-user-item"]')
        || anchor;

      // 只取卡片内短文本 p/span，避免 Follow 按钮等干扰
      const ps = Array.from(root.querySelectorAll('p.TUXText, p, span.TUXText, span'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 64 && t !== '·' && t !== '•' && !/^follow$/i.test(t));

      // 昵称：粗体；用户名：与 href 一致的那一行
      const boldEl = root.querySelector('p.TUXText--weight-bold, p[class*="weight-bold"], strong');
      let nickname = (boldEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const handleEl = Array.from(root.querySelectorAll('p.TUXText--weight-normal, p[class*="weight-normal"], p'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .find((t) => t && t.toLowerCase() === username.toLowerCase());
      if (handleEl) {
        // ok
      }
      if (!nickname || nickname.toLowerCase() === username.toLowerCase()) {
        nickname = ps.find((t) => (
          t.toLowerCase() !== username.toLowerCase()
          && !/^(followers?|likes?|获赞|粉丝)$/i.test(t)
          && !/^[\d.,]+\s*[kKmMbB万亿wW]?$/i.test(t)
        )) || username;
      }

      let followersText = pickMetricFromLabels(ps, /^(followers?|粉丝)$/i);
      let likesText = pickMetricFromLabels(ps, /^(likes?|获赞)$/i);
      const cardBlob = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
      if (!followersText) {
        followersText = pickMetricFromBlob(cardBlob, ['followers?', '粉丝']);
      }
      if (!likesText) {
        likesText = pickMetricFromBlob(cardBlob, ['likes?', '获赞']);
      }
      // 仍无标签时：取卡片内最大的 K/M 数字作粉丝候选（搜索列表角标通常粉丝更大）
      if (!followersText) {
        const nums = [];
        for (const t of ps) {
          if (/^[\d.,]+\s*[kKmMbB万亿wW]$/i.test(t) || /[\d.,]+\s*[kKmMbB]/i.test(t)) {
            const n = parseMetricCount(t);
            if (n > 0) nums.push({ t, n });
          }
        }
        if (nums.length) {
          nums.sort((a, b) => b.n - a.n);
          followersText = nums[0].t;
        }
      }
      if (!followersText && !likesText && ps.length < 2) {
        // 不像用户卡片（可能是顶栏/其它链接）
        continue;
      }

      seen.add(username.toLowerCase());
      const img = root.querySelector('img.user-avatar, img.TUXBaseAvatar-src, .user-avatar-container img, img');
      const pathOnly = href.split('?')[0];
      items.push({
        username,
        nickname: nickname || username,
        avatar: img?.getAttribute('src') || '',
        profileUrl: pathOnly.startsWith('http') ? pathOnly : `https://www.tiktok.com${pathOnly}`,
        followersText,
        likesText,
        followers: parseMetricCount(followersText),
        likes: parseMetricCount(likesText),
        hasLikesOnCard: !!likesText,
        _cardHint: cardBlob.slice(0, 80),
      });
    }
    return items;
  }, PARSE_METRIC_FN).catch((err) => {
    console.error('[ai-lead] collectUsersFromFrame failed', err?.message || err);
    return { __error: String(err?.message || err) };
  });
}

async function collectRawUsersFromPage(page) {
  const frames = [page, ...(page.frames?.() || []).filter((f) => f !== page.mainFrame?.())];
  const merged = [];
  const seen = new Set();
  let lastError = '';
  for (const frame of frames) {
    const rows = await collectUsersFromFrame(frame);
    if (rows && rows.__error) {
      lastError = rows.__error;
      continue;
    }
    for (const row of rows || []) {
      const key = String(row.username || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  if (!merged.length && lastError) {
    liveLog(`AI拓客页面解析异常: ${lastError}`, 'warn');
  }
  return merged;
}

async function dumpSearchPageHint(page) {
  const dump = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const blocked = /verify you.?re (a )?human|security check|captcha|unusual traffic|登录|log in to tiktok|sign up to search/i.test(text);
    const noResults = /no results|couldn.?t find|没有结果|未找到/i.test(text);
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState || '',
      atLinks: document.querySelectorAll('a[href*="/@"]').length,
      searchCards: document.querySelectorAll(
        '[class*="DivSearchUserItemContainer"], [class*="DivSearchItemContainer"], a.link-a11y-focus, [data-e2e="search-user-item"]'
      ).length,
      bodyLen: text.length,
      blocked,
      noResults,
      hint: text.slice(0, 200),
    };
  }).catch((err) => ({
    url: '',
    title: '',
    readyState: '',
    atLinks: 0,
    searchCards: 0,
    bodyLen: 0,
    blocked: false,
    noResults: false,
    hint: String(err?.message || err),
  }));
  const flags = [
    dump.blocked ? '疑似验证/登录墙' : '',
    dump.noResults ? '页面提示无结果' : '',
    dump.bodyLen < 80 ? '正文过短(可能未加载)' : '',
  ].filter(Boolean).join(' · ');
  liveLog(
    `AI拓客诊断 url=${dump.url} title=${dump.title || '-'} @链接=${dump.atLinks} 搜索节点=${dump.searchCards} ready=${dump.readyState}${flags ? ` ${flags}` : ''} ${dump.hint || ''}`,
    dump.blocked || dump.bodyLen < 80 ? 'warn' : 'info'
  );
  return dump;
}

/**
 * 列表筛选：卡片有明确粉丝数且不足则丢弃；粉丝为 0/未读到则 defer 到主页（与获赞同理）。
 * 返回 { raw, passed, dropped }
 */
function filterUsersByLimits(rawRows, limits) {
  const minFollowers = Number(limits.limitFollows || 0);
  const minLikes = Number(limits.limitLikes || 0);
  const seen = new Set();
  const passed = [];
  const dropped = [];

  for (const row of rawRows || []) {
    const username = String(row.username || '').trim();
    if (!username || seen.has(username.toLowerCase())) continue;
    seen.add(username.toLowerCase());

    const followers = parseMetricCount(row.followersText ?? row.followers);
    const likes = parseMetricCount(row.likesText ?? row.likes);
    const hasLikesOnCard = !!row.hasLikesOnCard || !!row.likesText;
    const followersText = String(row.followersText || '').trim();
    // TikTok 搜索卡常显示 "0 Followers" 或未加载，不能当真实粉丝数
    const followersPending = minFollowers > 0 && (followers <= 0 || !followersText);

    if (!followersPending && minFollowers > 0 && followers < minFollowers) {
      dropped.push({ username, followers, likes, reason: `粉丝${followers}<${minFollowers}` });
      continue;
    }
    // 仅当卡片上确实有获赞数据时才在列表阶段卡获赞；否则留到主页再验
    if (hasLikesOnCard && minLikes > 0 && likes < minLikes) {
      dropped.push({ username, followers, likes, reason: `获赞${likes}<${minLikes}` });
      continue;
    }

    passed.push({
      username,
      nickname: row.nickname || username,
      avatar: row.avatar || '',
      profileUrl: absUrl(row.profileUrl) || profileUrlFromUsername(username),
      followers,
      likes,
      hasLikesOnCard,
      likesPending: !hasLikesOnCard && minLikes > 0,
      followersPending,
    });
  }
  return { raw: rawRows || [], passed, dropped };
}

/**
 * 搜索页持续下滑采集：首屏没有合格用户也不停，直到
 * - 合格数 ≥ maxUsers，或
 * - 连续 staleStop 轮解析不到新用户名，或
 * - 达到 maxRounds
 */
async function collectUsersUntilExhausted(page, limits, {
  leadId = 0,
  maxUsers = MAX_USERS,
  maxRounds = MAX_SEARCH_SCROLL_ROUNDS,
  staleStop = SEARCH_STALE_ROUNDS_STOP,
  pauseMs = 3500,
} = {}) {
  const allRawByKey = new Map();
  const passedByKey = new Map();
  const dropped = [];
  const minFollowers = Number(limits.limitFollows || 0);
  let staleRounds = 0;
  let round = 0;

  const countCardQualified = () => Array.from(passedByKey.values()).filter(
    (u) => !u.followersPending && Number(u.followers || 0) >= minFollowers
  ).length;

  while (round < maxRounds && countCardQualified() < maxUsers) {
    round += 1;
    if (leadId) assertLeadActive(leadId);
    try {
      const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const batch = await collectRawUsersFromPage(page);
    let newRaw = 0;
    for (const row of batch || []) {
      const key = String(row.username || '').toLowerCase();
      if (!key) continue;
      if (!allRawByKey.has(key)) {
        allRawByKey.set(key, row);
        newRaw += 1;
      }
    }

    const { passed: batchPassed, dropped: batchDropped } = filterUsersByLimits(
      Array.from(allRawByKey.values()),
      limits
    );
    for (const d of batchDropped) {
      if (!dropped.some((x) => x.username === d.username)) dropped.push(d);
    }
    let newPassed = 0;
    for (const u of batchPassed) {
      const key = String(u.username || '').toLowerCase();
      if (!key) continue;
      if (!passedByKey.has(key)) {
        passedByKey.set(key, u);
        newPassed += 1;
      }
    }
    const cardQualified = countCardQualified();
    const pendingN = Array.from(passedByKey.values()).filter((u) => u.followersPending).length;

    liveLog(
      `AI拓客 #${leadId} 搜索第${round}轮 本屏新用户=${newRaw} 累计解析=${allRawByKey.size} `
      + `列表达标=${cardQualified}/${maxUsers} 待主页验粉=${pendingN}（本轮新增=${newPassed}）`,
      cardQualified || newRaw ? 'info' : 'warn',
      { leadId }
    );

    if (cardQualified >= maxUsers) break;

    if (newRaw < 1) {
      staleRounds += 1;
      if (staleRounds >= staleStop) {
        liveLog(
          `AI拓客 #${leadId} 连续 ${staleRounds} 轮无新用户，停止翻页（累计 ${allRawByKey.size}）`,
          'info',
          { leadId }
        );
        break;
      }
    } else {
      staleRounds = 0;
    }

    await humanPause(pauseMs, 0.12, leadId);
    await scrollSearchResults(page);
    await humanPause(Math.max(1200, Math.round(pauseMs * 0.45)), 0.15, leadId);
  }

  // 诊断：累计里粉丝读成 0 的样例
  const rawList = Array.from(allRawByKey.values());
  const zeroFans = rawList.filter((r) => !Number(r.followers || 0)).slice(0, 3);
  if (zeroFans.length) {
    liveLog(
      `AI拓客粉丝读数诊断: ${zeroFans.map((r) => `@${r.username} text=${JSON.stringify(r.followersText || '')} hint=${JSON.stringify(String(r._cardHint || '').slice(0, 60))}`).join('；')}`,
      'warn',
      { leadId }
    );
  }
  if (dropped.length) {
    liveLog(
      `AI拓客丢弃样例: ${dropped.slice(0, 8).map((d) => `@${d.username} ${d.reason}`).join('；')}`,
      'info',
      { leadId }
    );
  }

  const cardOk = [];
  const pendingProfile = [];
  for (const u of passedByKey.values()) {
    if (u.followersPending) pendingProfile.push(u);
    else cardOk.push(u);
  }
  const passedMerged = [...cardOk, ...pendingProfile].slice(0, maxUsers + MAX_PROFILE_VERIFY_PENDING);

  return {
    raw: rawList,
    passed: passedMerged,
    dropped,
    rounds: round,
  };
}

async function waitForUserResults(page, { timeoutMs = 35000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
      const rot = await solveRotateCaptchaIfPresent(page);
      if (rot?.detected && rot?.solved) {
        await humanPause(1000, 0.15);
      }
    } catch { /* ignore */ }
    const n = await countSearchUserSignals(page);
    if (n >= 1) return true;
    const blocked = await page.evaluate(() => {
      const t = (document.body?.innerText || '').slice(0, 4000);
      return /verify you.?re (a )?human|security check|captcha|something went wrong|unusual traffic|登录|log in to tiktok/i.test(t);
    }).catch(() => false);
    if (blocked) {
      try {
        const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
        const rot2 = await solveRotateCaptchaIfPresent(page);
        if (rot2?.detected && rot2?.solved) {
          await humanPause(1000, 0.15);
          continue;
        }
      } catch { /* ignore */ }
      return false;
    }
    await dismissSearchOverlays(page);
    await humanPause(900, 0.2);
  }
  return false;
}

async function scrapeProfileStats(page, username) {
  const profileUrl = profileUrlFromUsername(username);
  await safeGoto({ page }, profileUrl, {
    label: `主页统计 @${username}`,
    beforeMs: 2500,
    afterMs: 4500,
  });
  await humanPause(1500, 0.15);
  try {
    const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }

  const stats = await page.evaluate(({ parseFnSource, pickFnSource }) => {
    const parseMetricCount = eval(`(${parseFnSource})`);
    const pickLabeledMetricText = eval(`(${pickFnSource})`);
    const readByE2e = (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t) return t;
      }
      return '';
    };
    let followersText = readByE2e([
      '[data-e2e="followers-count"]',
      'strong[data-e2e="followers-count"]',
      '[data-e2e="user-follower-count"]',
    ]);
    let likesText = readByE2e([
      '[data-e2e="likes-count"]',
      'strong[data-e2e="likes-count"]',
      '[data-e2e="user-likes-count"]',
    ]);
    // 分列标签：数字在前一节点
    const texts = Array.from(document.querySelectorAll('strong, span, p'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 48);
    if (!followersText || !likesText) {
      for (let i = 0; i < texts.length; i += 1) {
        if (/^(followers?|粉丝)$/i.test(texts[i]) && !followersText) {
          followersText = texts[i - 1] || '';
        }
        if (/^(likes?|获赞)$/i.test(texts[i]) && !likesText) {
          likesText = texts[i - 1] || '';
        }
      }
    }
    // 合写兜底："243.1K Likes" / "获赞 1.2M"（勿把 ^$ 嵌进正则）
    const blob = texts.join(' ') || (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2000);
    if (!followersText || parseMetricCount(followersText) < 1) {
      followersText = pickLabeledMetricText(blob, 'followers?|粉丝') || followersText;
    }
    if (!likesText || parseMetricCount(likesText) < 1) {
      likesText = pickLabeledMetricText(blob, 'likes?|获赞') || likesText;
    }
    const followers = parseMetricCount(followersText);
    const likes = parseMetricCount(likesText);
    const avatar = document.querySelector('img[data-e2e="user-avatar"], span[shape="circle"] img, img')?.getAttribute('src') || '';
    const nickname = (document.querySelector('h1[data-e2e="user-title"], h1, h2')?.textContent || '').trim();
    return { followers, likes, avatar, nickname, followersText, likesText };
  }, { parseFnSource: PARSE_METRIC_FN, pickFnSource: PICK_LABELED_METRIC_FN }).catch(() => ({
    followers: 0, likes: 0, avatar: '', nickname: '',
  }));

  if (!stats.followers || !stats.likes) {
    liveLog(
      `AI拓客主页计数诊断 @${username} 粉丝=${stats.followers}(${stats.followersText || '-'}) 获赞=${stats.likes}(${stats.likesText || '-'})`,
      'warn'
    );
  }
  return stats;
}

/**
 * 监听 TikTok 主页 post/item_list API，提取 playCount（比 DOM 更稳）。
 */
function attachProfilePostListCapture(page) {
  const map = new Map();
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!res.ok() || !/\/api\/post\/|item_list|user\/post/i.test(url)) return;
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (ct && !ct.includes('json')) return;
      const json = await res.json();
      const lists = [
        json?.itemList,
        json?.item_list,
        json?.aweme_list,
        json?.items,
        json?.data?.itemList,
        json?.data?.item_list,
      ].filter(Array.isArray);
      for (const list of lists) {
        for (const item of list) {
          const id = String(item?.id || item?.aweme_id || item?.awemeId || '').trim();
          if (!id) continue;
          const play = Number(
            item?.stats?.playCount
            ?? item?.stats?.play_count
            ?? item?.statistics?.play_count
            ?? item?.statistics?.playCount
            ?? 0
          );
          if (play > 0) map.set(id, play);
        }
      }
    } catch {
      /* ignore parse errors */
    }
  };
  page.on('response', onResponse);
  return {
    map,
    detach: () => page.off('response', onResponse),
  };
}

async function ensureProfileVideosTab(page) {
  const hasGrid = await page.locator('[data-e2e="user-post-item"], [data-e2e="user-post-item-list"]').count().catch(() => 0);
  if (hasGrid > 0) return;
  const tabSels = [
    '[data-e2e="videos-tab"]',
    '[role="tab"]:has-text("Videos")',
    '[role="tab"]:has-text("视频")',
    '[role="tab"]:has-text("作品")',
  ];
  for (const sel of tabSels) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 4000 }).catch(() => loc.click({ force: true }).catch(() => {}));
      await humanPause(1800, 0.12);
      break;
    }
  }
}

async function waitForProfileVideoGrid(page, timeoutMs = 18000) {
  await page.locator(
    '[data-e2e="user-post-item"], [data-e2e="user-post-item-list"] a[href*="/video/"], a[href*="/video/"]'
  ).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  await humanPause(1500, 0.1);
}

/**
 * 主页视频网格角标数字是播放量（views），不是点赞。
 * 优先 [data-e2e="user-post-item"] + [data-e2e="video-views"]。
 */
async function collectProfileVideoRows(page, minViews) {
  const videos = await page.evaluate(({ minView, parseFnSource, pickFnSource }) => {
    const parseMetricCount = eval(`(${parseFnSource})`);
    const pickLabeledMetricText = eval(`(${pickFnSource})`);
    const extractViewsText = (scope) => {
      const root = scope || document.body;
      const viewsEl = root.querySelector?.(
        '[data-e2e="video-views"], strong[data-e2e="video-views"], strong.video-count, [class*="VideoCount"] strong, strong[class*="video-count"]'
      );
      if (viewsEl) {
        const t = (viewsEl.textContent || viewsEl.getAttribute('title') || '').trim();
        if (t) return t;
      }
      const parts = [];
      const aria = root.getAttribute?.('aria-label') || '';
      if (aria) parts.push(aria);
      const strong = root.querySelector?.('strong');
      if (strong) parts.push((strong.textContent || '').trim());
      parts.push((root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240));
      for (const text of parts) {
        const labeled = pickLabeledMetricText(text, 'views?|plays?|播放|观看|次播放');
        if (labeled) return labeled;
      }
      for (const text of parts) {
        const cleaned = String(text).replace(/[\u00a0\u202f]/g, ' ').trim();
        const m = cleaned.match(/^([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?$/i);
        if (m) return m[0];
        if (/like|赞|heart/i.test(cleaned)) continue;
        const anywhere = cleaned.match(
          /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i
        );
        if (anywhere) return anywhere[0];
      }
      return '';
    };
    const out = [];
    const seen = new Set();
    const pushItem = (scope, a) => {
      const href = (a.getAttribute('href') || '').split('?')[0];
      if (!href.includes('/video/') || seen.has(href)) return;
      seen.add(href);
      const img = a.querySelector('img') || scope?.querySelector?.('img');
      const cover = img?.getAttribute('src') || '';
      const title = (a.getAttribute('title') || img?.getAttribute('alt') || a.textContent || '').trim().slice(0, 120);
      const viewsText = extractViewsText(scope || a);
      const views = parseMetricCount(viewsText);
      if (views >= minView) {
        out.push({
          videoUrl: href.startsWith('http') ? href : `https://www.tiktok.com${href}`,
          videoCover: cover,
          videoName: title,
          viewsText,
          views,
        });
      }
    };
    document.querySelectorAll('[data-e2e="user-post-item"]').forEach((card) => {
      const a = card.querySelector('a[href*="/video/"]');
      if (a) pushItem(card, a);
    });
    if (!out.length) {
      document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
        let scope = a.closest('[data-e2e="user-post-item"]');
        if (!scope) {
          for (let p = a.parentElement, i = 0; p && i < 6; i += 1, p = p.parentElement) {
            if (p.querySelector?.('[data-e2e="video-views"]') || p.querySelector?.('strong')) {
              scope = p;
              break;
            }
          }
        }
        pushItem(scope || a, a);
      });
    }
    return out;
  }, { minView: minViews, parseFnSource: PARSE_METRIC_FN, pickFnSource: PICK_LABELED_METRIC_FN }).catch(() => []);

  return (videos || [])
    .map((v) => ({
      ...v,
      views: parseMetricCount(v.viewsText ?? v.views),
    }))
    .filter((v) => v.views >= minViews);
}

/**
 * 主页找视频：读完当前屏 → 等 5s → 再下滑；按播放量 ≥ 浏览下限筛选。
 */
async function scrapeProfileVideos(page, creatorUsername, minViews) {
  const cur = page.url() || '';
  const need = profileUrlFromUsername(creatorUsername);
  if (!cur.includes(`/@${creatorUsername}`)) {
    await safeGoto({ page }, need, {
      label: `主页视频 @${creatorUsername}`,
      beforeMs: 2500,
      afterMs: 5000,
    });
  } else {
    await humanPause(3000, 0.15);
  }

  const merged = [];
  const seen = new Set();
  const maxRounds = 6;
  for (let round = 0; round < maxRounds; round += 1) {
    try {
      const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const batch = await collectProfileVideoRows(page, minViews);
    for (const v of batch) {
      const key = String(v.videoUrl || '').split('?')[0];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(v);
      if (merged.length >= MAX_VIDEOS_PER_USER) break;
    }
    if (merged.length >= MAX_VIDEOS_PER_USER) break;
    liveLog(`AI拓客 @${creatorUsername} 主页视频第${round + 1}屏已采 ${merged.length} 个（播放≥${minViews}），5秒后下滑`, 'info');
    await humanPause(5000, 0.08);
    await page.mouse.wheel(0, 1100).catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    await humanPause(1500, 0.15);
  }
  return merged.slice(0, MAX_VIDEOS_PER_USER);
}

/**
 * 用浏览器登录态请求 /api/post/item_list/，读取 stats.playCount（最可靠）。
 * @returns {{ map: Map<string, number>, secUid: string }}
 */
async function fetchProfileVideoViewsViaPageApi(page, targetVideoIds = []) {
  const targets = (targetVideoIds || []).map((x) => String(x || '').trim()).filter(Boolean);
  const raw = await page.evaluate(async ({ targetIds }) => {
    const out = {};
    const markFromList = (list) => {
      for (const item of list || []) {
        const id = String(item?.id || item?.aweme_id || item?.awemeId || '').trim();
        if (!id) continue;
        const play = Number(
          item?.stats?.playCount
          ?? item?.stats?.play_count
          ?? item?.statsV2?.playCount
          ?? item?.statsV2?.play_count
          ?? item?.statistics?.play_count
          ?? item?.statistics?.playCount
          ?? 0
        );
        if (play > 0) out[id] = play;
        else if (out[id] == null) out[id] = 0;
      }
    };
    const parseSecUid = () => {
      const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!script?.textContent) return '';
      try {
        const data = JSON.parse(script.textContent);
        return (
          data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user?.secUid
          || data?.['webapp.user-detail']?.userInfo?.user?.secUid
          || ''
        );
      } catch {
        return '';
      }
    };
    try {
      const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (script?.textContent) {
        const data = JSON.parse(script.textContent);
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const detail = scope['webapp.user-detail'] || {};
        markFromList(detail.itemList || detail.postList || detail.post?.itemList || []);
      }
    } catch {
      /* ignore SSR parse */
    }
    const secUid = parseSecUid();
    if (!secUid) return { items: out, secUid: '' };
    let cursor = 0;
    let hasMore = true;
    for (let pageNo = 0; pageNo < 12 && hasMore; pageNo += 1) {
      const u = new URL(`${location.origin}/api/post/item_list/`);
      u.searchParams.set('aid', '1988');
      u.searchParams.set('count', '35');
      u.searchParams.set('cursor', String(cursor));
      u.searchParams.set('device_platform', 'web_pc');
      u.searchParams.set('secUid', secUid);
      u.searchParams.set('coverFormat', '2');
      let resp;
      try {
        resp = await fetch(u.toString(), {
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            referer: location.href,
          },
        });
      } catch {
        break;
      }
      if (!resp.ok) break;
      let json;
      try {
        json = await resp.json();
      } catch {
        break;
      }
      markFromList(json?.itemList || json?.item_list || []);
      hasMore = !!json?.hasMore;
      const next = Number(json?.cursor ?? json?.maxCursor ?? NaN);
      if (Number.isFinite(next) && next !== cursor) cursor = next;
      else cursor += 35;
      if (targetIds.length && targetIds.every((id) => (out[id] || 0) > 0)) break;
    }
    return { items: out, secUid };
  }, { targetIds: targets }).catch(() => ({ items: {}, secUid: '' }));

  const map = new Map();
  for (const [id, play] of Object.entries(raw?.items || {})) {
    if (id) map.set(id, Number(play) || 0);
  }
  return { map, secUid: String(raw?.secUid || '') };
}

/**
 * 从当前主页视频网格读取指定视频的播放量（角标数字，非详情页）。
 */
async function readViewsFromProfileGrid(page, videoId) {
  const vid = String(videoId || '').trim();
  if (!vid) return 0;
  const rows = await collectProfileVideoRows(page, 0);
  const hit = (rows || []).find((r) => extractVideoId(r.videoUrl) === vid);
  return Number(hit?.views || 0) || parseMetricCount(hit?.viewsText);
}

/**
 * 打开作者主页，滚动视频网格，批量解析目标 videoId 的播放量。
 * @param {string[]} targetVideoIds
 * @returns {Map<string, number>}
 */
async function collectProfileVideoViewsMap(pageOrConn, creatorUsername, targetVideoIds = []) {
  const connection = toNavConnection(pageOrConn) || { page: pageOrConn };
  let page = await ensureLivePage(connection).catch(() => connection.page);
  const uname = String(creatorUsername || '').replace(/^@+/, '').trim();
  const targets = new Set((targetVideoIds || []).map((x) => String(x || '').trim()).filter(Boolean));
  const map = new Map();
  if (!uname) return map;

  const capture = attachProfilePostListCapture(page);
  try {
    const profileUrl = profileUrlFromUsername(uname);
    const cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
    const onProfile = new RegExp(`/@${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(cur);
    if (!onProfile || /\/video\//i.test(cur) || await isOopsOrBlockedPage(page)) {
      page = await safeGoto(connection, profileUrl, {
        label: `主页列表播放量 @${uname}`,
        beforeMs: 2500,
        afterMs: 5000,
      });
    } else {
      await humanPause(2500, 0.15);
    }
    await ensureProfileVideosTab(page);
    await waitForProfileVideoGrid(page);

    const apiFetch = await fetchProfileVideoViewsViaPageApi(page, [...targets]);
    for (const [id, play] of apiFetch.map.entries()) {
      const prev = map.get(id);
      if (play > 0 && (prev == null || prev === 0)) map.set(id, play);
      else if (prev == null) map.set(id, play);
    }
    if (apiFetch.secUid) {
      const apiHits = targets.size
        ? [...targets].filter((id) => (map.get(id) || 0) > 0).length
        : apiFetch.map.size;
      liveLog(
        `主页 item_list API @${uname} secUid OK，API直取播放量 ${apiHits}${targets.size ? `/${targets.size}` : ''}（不足时回退网格 DOM）`,
        'info',
        { accountUsername: uname, apiHits, targetCount: targets.size }
      );
    } else {
      liveLog(`主页 item_list API @${uname} 未拿到 secUid，回退 DOM 网格`, 'warn', { accountUsername: uname });
    }

    const mergeApi = () => {
      for (const [id, play] of capture.map.entries()) {
        const prev = map.get(id);
        if (play > 0 && (prev == null || prev === 0)) map.set(id, play);
      }
    };

    const mergeDom = (batch) => {
      for (const v of batch || []) {
        const id = extractVideoId(v.videoUrl);
        if (!id) continue;
        const nextViews = Number(v.views || 0) || parseMetricCount(v.viewsText);
        const prev = map.get(id);
        if (prev == null || (prev === 0 && nextViews > 0)) {
          map.set(id, nextViews);
        }
      }
    };

    const maxRounds = targets.size > 6 ? 14 : 10;
    for (let round = 0; round < maxRounds; round += 1) {
      try {
        const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
        await solveRotateCaptchaIfPresent(page);
      } catch { /* ignore */ }
      mergeApi();
      mergeDom(await collectProfileVideoRows(page, 0));
      const matchedTargets = targets.size
        ? [...targets].filter((id) => (map.get(id) || 0) > 0).length
        : 0;
      if (targets.size && matchedTargets >= targets.size) break;
      if (targets.size && [...targets].every((id) => map.has(id) && (map.get(id) || 0) > 0)) break;
      if (!targets.size && map.size > 0) break;
      await humanPause(round === 0 ? 2500 : 4000, 0.08);
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.keyboard.press('End').catch(() => {});
      await humanPause(1500, 0.15);
    }
    mergeApi();
  } finally {
    capture.detach();
  }
  return map;
}

/** TikTok 直链 /video/ 常被边缘风控打成 Oops 页；短链也会落到 /404?fromUrl= */
async function isOopsOrBlockedPage(page) {
  const cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
  if (/\/404(?:\?|$|\/)/i.test(cur) || /[?&]fromUrl=\/video\//i.test(cur)) return true;
  try {
    const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }
  return page.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 2500);
    return /oops!?\s*something went wrong|something went wrong|please contact your administrator|verify you.?re (a )?human|security check|unusual traffic|页面出错|出了点问题|无法观看|视频不存在|video (?:is )?n.?t available|couldn.?t find this video|this video isn.?t available|couldn.?t find this page|page not found|找不到该页面/i.test(t);
  }).catch(() => false);
}

function extractVideoId(videoUrl) {
  const m = String(videoUrl || '').match(/\/video\/(\d+)/);
  return m ? m[1] : '';
}

/** 浏览态/详情页是否已打开（禁止用泛型 video 标签，主页网格会误判） */
async function isVideoBrowseOpen(page, videoId = '') {
  const vid = String(videoId || '').trim();
  const cur = String(page.url() || '');
  if (vid && cur.includes(vid)) return true;

  const commentIcon = await page.locator('[data-e2e="browse-comment-icon"]').count().catch(() => 0);
  const likeCtl = await page.locator(
    '[data-e2e="browse-like-icon"], [data-e2e="browse-like-count"]'
  ).count().catch(() => 0);
  const browseVideo = await page.locator('[data-e2e="browse-video"]').count().catch(() => 0);
  const browseNav = await page.locator(
    '[data-e2e="browse-close"], [data-e2e="browse-navigate"], [data-e2e="browse-navigation"]'
  ).count().catch(() => 0);

  if (commentIcon > 0 && likeCtl > 0) return true;
  if (browseVideo > 0 && (commentIcon > 0 || likeCtl > 0 || browseNav > 0)) return true;

  // 仍在纯主页（有作品网格、无 browse 控件）→ 未打开详情
  const onProfileFeed = /\/@[^/?#]+\/?(?:\?|$|#)/.test(cur) && !/\/video\//.test(cur);
  if (onProfileFeed) {
    const grid = await page.locator('[data-e2e="user-post-item"]').count().catch(() => 0);
    if (grid > 0 && commentIcon === 0 && likeCtl === 0) return false;
  }

  return commentIcon > 0 || (likeCtl > 0 && browseNav > 0);
}

async function waitForVideoBrowseOpen(page, videoId, rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    try {
      const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    if (await isVideoBrowseOpen(page, videoId)) return true;
    await humanPause(i === 0 ? 1200 : 900, 0.12);
  }
  return false;
}

/**
 * 禁止 page.goto 公开 /video/ 直链（易触发 Oops）。
 * 回到作者主页，点击对应封面进入浏览态。
 */
async function openVideoViaProfileClick(pageOrConn, videoUrl, creatorUsername) {
  const connection = toNavConnection(pageOrConn) || { page: pageOrConn };
  let page = await ensureLivePage(connection);
  const videoId = extractVideoId(videoUrl);
  const uname = String(creatorUsername || '').replace(/^@+/, '');
  if (!videoId || !uname) return { ok: false, views: 0 };

  const profileUrl = profileUrlFromUsername(uname);
  const cur = (() => { try { return page.url() || ''; } catch { return ''; } })();
  const onProfile = new RegExp(`/@${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(cur);
  if (!onProfile || /\/video\//i.test(cur) || await isOopsOrBlockedPage(page)) {
    page = await safeGoto(connection, profileUrl, {
      label: `回主页开视频 @${uname}`,
      beforeMs: 2500,
      afterMs: 4500,
    });
  } else {
    await humanPause(2500, 0.15);
  }
  await ensureProfileVideosTab(page);
  await waitForProfileVideoGrid(page);

  // 滚动找封面：每屏找完再等下滑；点击后等待 browse 控件（URL 不一定含 videoId）
  for (let round = 0; round < 14; round += 1) {
    const loc = page.locator(
      `[data-e2e="user-post-item"] a[href*="/video/${videoId}"], a[href*="/video/${videoId}"]`
    ).first();
    if (await loc.count().catch(() => 0)) {
      const listViews = await readViewsFromProfileGrid(page, videoId);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await humanPause(800, 0.2);
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45).catch(() => {});
        await humanPause(400, 0.1);
      }
      await loc.click({ timeout: 5000, delay: 60 }).catch(() => loc.click({ force: true }).catch(() => {}));
      if (!(await waitForVideoBrowseOpen(page, videoId, 8))) {
        const card = page.locator(`[data-e2e="user-post-item"]:has(a[href*="/video/${videoId}"])`).first();
        if (await card.count().catch(() => 0)) {
          await card.click({ timeout: 5000, delay: 80 }).catch(() => {});
        }
      }

      if (await isOopsOrBlockedPage(page)) {
        liveLog(`AI拓客视频风控 Oops（点击后）id=${videoId}`, 'warn');
        page = await safeGoto(connection, profileUrl, {
          label: `Oops 后回主页 @${uname}`,
          beforeMs: 2000,
          afterMs: 4500,
        });
        return { ok: false, views: listViews };
      }
      if (await waitForVideoBrowseOpen(page, videoId, 12)) {
        return { ok: true, views: listViews };
      }
    }
    await humanPause(round < 2 ? 2500 : 4500, 0.08);
    await page.mouse.wheel(0, 1100).catch(() => {});
    await humanPause(1200, 0.15);
  }
  return { ok: false, views: 0 };
}

async function ensureCommentPanelOpen(page) {
  try {
    const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }
  const ready = await firstVisible(page, SELECTORS.commentPanelReady, 2500);
  if (ready) return true;

  const openBtn = await firstVisible(page, SELECTORS.commentOpen, 8000);
  if (openBtn) {
    await openBtn.click({ timeout: 5000 }).catch(() => openBtn.click({ force: true }).catch(() => {}));
    await humanPause(1600, 0.2);
  } else {
    // 浏览态偶发没有 data-e2e，用文案点一次
    const byText = page.getByText(/^(Comments|评论|留言)$/i).first();
    if (await byText.count().catch(() => 0)) {
      await byText.click({ timeout: 4000 }).catch(() => {});
      await humanPause(1200, 0.2);
    }
  }

  try {
    const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }

  // 空白侧栏时再点一次评论图标
  let ok = await firstVisible(page, SELECTORS.commentPanelReady, 6000);
  if (!ok) {
    const again = await firstVisible(page, SELECTORS.commentOpen, 3000);
    if (again) {
      await again.click({ force: true }).catch(() => {});
      await humanPause(1500, 0.2);
      try {
        const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
        await solveRotateCaptchaIfPresent(page);
      } catch { /* ignore */ }
      ok = await firstVisible(page, SELECTORS.commentPanelReady, 5000);
    }
  }
  return !!ok;
}

/**
 * 视频详情/浏览态读取真实点赞数（非主页网格播放量）。
 */
async function scrapeVideoLikeCount(page) {
  const likesText = await page.evaluate(({ pickFnSource }) => {
    const pickLabeledMetricText = eval(`(${pickFnSource})`);
    const pick = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        const t = (el?.textContent || el?.getAttribute?.('title') || '').trim();
        if (t) return t;
      }
      return '';
    };
    let t = pick([
      '[data-e2e="browse-like-count"]',
      'strong[data-e2e="browse-like-count"]',
      '[data-e2e="like-count"]',
      'strong[data-e2e="like-count"]',
      '[data-e2e="video-like-count"]',
    ]);
    if (t) return t;
    // 点赞按钮旁的数字 / aria
    const likeBtn = document.querySelector(
      '[data-e2e="browse-like-icon"], [data-e2e="like-icon"], button[aria-label*="Like"], button[aria-label*="赞"]'
    );
    if (likeBtn) {
      const near = likeBtn.closest('button, [role="button"], div') || likeBtn.parentElement;
      const strong = near?.querySelector?.('strong');
      if (strong?.textContent) return strong.textContent.trim();
      const aria = likeBtn.getAttribute('aria-label') || near?.getAttribute?.('aria-label') || '';
      const fromAria = pickLabeledMetricText(aria, 'likes?|like|赞|获赞')
        || (aria.match(/([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i) || [])[0];
      if (fromAria) return fromAria;
    }
    // 浏览态侧栏合写兜底
    const blob = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2500);
    return pickLabeledMetricText(blob, 'likes?|获赞') || '';
  }, { pickFnSource: PICK_LABELED_METRIC_FN }).catch(() => '');
  return parseMetricCount(likesText);
}

/**
 * 规范化视频详情 URL：有创作者时优先 @user/video/id（裸 /video/id 常跳 /404?fromUrl=）。
 */
function buildVideoOpenCandidates(videoUrl, creatorUsername = '') {
  const raw = String(videoUrl || '').trim();
  const videoId = extractVideoId(raw);
  let uname = String(creatorUsername || '').replace(/^@+/, '').trim();
  if (!uname) {
    const m = raw.match(/\/@([^/?#]+)/);
    if (m) {
      try { uname = decodeURIComponent(m[1]); } catch { uname = m[1]; }
    }
  }
  const out = [];
  const push = (u) => {
    const s = String(u || '').trim().split('?')[0];
    if (s && !out.includes(s)) out.push(s);
  };
  if (videoId && uname) push(`https://www.tiktok.com/@${encodeURIComponent(uname)}/video/${videoId}`);
  if (/\/@[^/?#]+\/video\/\d+/i.test(raw)) push(raw);
  if (videoId) push(`https://www.tiktok.com/video/${videoId}`);
  else push(raw);
  return { videoId, uname, candidates: out.filter(Boolean) };
}

/**
 * 直接打开视频 URL（按视频模式优先；失败再回退主页点封面）。
 * @param {string} [creatorUsername]
 */
async function openVideoDirect(pageOrConn, videoUrl, creatorUsername = '') {
  const connection = toNavConnection(pageOrConn) || { page: pageOrConn };
  let page = await ensureLivePage(connection);
  const { videoId, candidates } = buildVideoOpenCandidates(videoUrl, creatorUsername);
  if (!candidates.length) return false;

  // 若仍在搜索页，优先点封面（更像真人、少风控）
  const cur0 = (() => { try { return page.url() || ''; } catch { return ''; } })();
  if (videoId && /\/search/i.test(cur0)) {
    const loc = page.locator(`a[href*="/video/${videoId}"]`).first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await humanPause(600, 0.2);
      await loc.click({ timeout: 5000, delay: 60 }).catch(() => loc.click({ force: true }).catch(() => {}));
      if (await waitForVideoBrowseOpen(page, videoId, 8) && !(await isOopsOrBlockedPage(page))) {
        return true;
      }
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const url = candidates[i];
    try {
      page = await safeGoto(connection, url, {
        label: `直开视频 ${videoId || ''}${candidates.length > 1 ? ` #${i + 1}` : ''}`,
        beforeMs: i === 0 ? 2000 : 1200,
        afterMs: 4500,
        retries: candidates.length > 1 ? 2 : 3,
      });
    } catch (e) {
      const msg = String(e?.message || e || '');
      // CDP/上下文已死：不要空转候选，直接抛出让上层重开环境
      if (isRecoverableBrowserError(e)) throw e;
      // 短链落到 404 时换下一条候选，不直接整段失败
      if (/\/404|fromUrl=\/video\//i.test(msg) || /导航后仍停留在/i.test(msg)) {
        liveLog(`直开视频候选失败，尝试下一条: ${url} → ${msg.slice(0, 120)}`, 'warn');
        continue;
      }
      if (i < candidates.length - 1) {
        liveLog(`直开视频候选异常，尝试下一条: ${msg.slice(0, 120)}`, 'warn');
        continue;
      }
      throw e;
    }
    if (await isOopsOrBlockedPage(page)) {
      liveLog(`直开视频落到异常/404 页，换链重试: ${page.url?.() || url}`, 'warn');
      continue;
    }
    if (await waitForVideoBrowseOpen(page, videoId, 10)) return true;
  }
  return false;
}

/**
 * @param {{ preferDirect?: boolean, includeAuthorComments?: boolean, allowDirectFallback?: boolean }} options
 *   preferDirect=true 时先直开/搜索点封面，失败再主页点封面；
 *   includeAuthorComments=true 时保留视频作者（创作者）自己的评论（拉取视频数据需要）；
 *   allowDirectFallback=true 时主页点封面失败后尝试直链（拉取视频数据兜底）。
 * @returns {{ comments: Array, likes: number, views: number, opened: boolean }}
 */
async function scrapeVideoComments(pageOrConn, videoUrl, creatorUsername, options = {}) {
  const connection = toNavConnection(pageOrConn) || { page: pageOrConn };
  let page = await ensureLivePage(connection);
  const preferDirect = options.preferDirect === true;
  const includeAuthorComments = options.includeAuthorComments === true;
  const allowDirectFallback = options.allowDirectFallback === true;
  let uname = String(creatorUsername || '').replace(/^@+/, '').trim();
  if (!uname) {
    const um = String(videoUrl || '').match(/\/@([^/?#]+)/);
    if (um) {
      try { uname = decodeURIComponent(um[1]); } catch { uname = um[1]; }
    }
  }
  let opened = false;
  let listViews = 0;
  // 统一成 @user/video/id，避免短链 /video/id → 404
  const preferredUrl = buildVideoOpenCandidates(videoUrl, uname).candidates[0] || videoUrl;
  if (preferDirect) {
    opened = await openVideoDirect(connection, preferredUrl, uname);
    page = connection.page || page;
  }
  if (!opened) {
    const openResult = await openVideoViaProfileClick(connection, preferredUrl, uname);
    opened = !!openResult?.ok;
    listViews = Number(openResult?.views || 0);
    page = connection.page || page;
  }
  if (!opened && allowDirectFallback) {
    liveLog(`主页点封面未打开，回退直链: ${preferredUrl}`, 'warn');
    opened = await openVideoDirect(connection, preferredUrl, uname);
    page = connection.page || page;
  }
  if (!opened) {
    liveLog(`AI拓客跳过视频（无法打开/风控）: ${videoUrl}`, 'warn');
    return { comments: [], likes: 0, views: listViews, opened: false, panelOpen: false };
  }

  page = await ensureLivePage(connection);
  if (await isOopsOrBlockedPage(page)) {
    liveLog(`AI拓客跳过视频（评论页 Oops）: ${videoUrl}`, 'warn');
    return { comments: [], likes: 0, views: listViews, opened: false, panelOpen: false };
  }

  // 详情页时机：先拿点赞数
  await humanPause(800, 0.15);
  const likes = await scrapeVideoLikeCount(page);

  const panelOk = await ensureCommentPanelOpen(page);
  if (!panelOk) {
    liveLog(`AI拓客评论栏未打开: ${videoUrl}`, 'warn');
  }

  const vidCheck = extractVideoId(videoUrl);
  const reallyOpen = await isVideoBrowseOpen(page, vidCheck);
  if (!reallyOpen) {
    liveLog(`视频浏览态未确认（可能仍在主页）: ${videoUrl}`, 'warn');
    return { comments: [], likes: 0, views: listViews, opened: false, panelOpen: false };
  }

  const authorFilter = includeAuthorComments
    ? ''
    : String(uname || creatorUsername || '').replace(/^@+/, '').toLowerCase();
  const comments = [];
  const seen = new Set();

  for (let round = 0; round < MAX_COMMENT_ROUNDS; round += 1) {
    try {
      const { solveRotateCaptchaIfPresent } = require('../nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    const batch = await page.evaluate((author) => {
      const out = [];
      const seenLocal = new Set();
      const cleanText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const emojiFromImgs = (root) => {
        if (!root) return '';
        return Array.from(root.querySelectorAll('img[alt]'))
          .map((img) => (img.getAttribute('alt') || '').trim())
          .filter((alt) => alt && alt.length <= 8 && !/avatar|profile|photo/i.test(alt))
          .join('');
      };
      const hasEmojiOrKaomoji = (s) => {
        const t = String(s || '');
        if (!t) return false;
        try {
          if (/\p{Extended_Pictographic}/u.test(t)) return true;
        } catch { /* older engines */ }
        if (/[♡♥❤✨⭐🌟🔥👍👏🙏😍🥰😊😉😭🥺💕💘👀💯✅]/u.test(t)) return true;
        if (/[◕☆★＞＜。・´｀＾]/.test(t) && /[)(（）]/.test(t)) return true;
        if (/\^[._\-]?\^|[><][._\-]|[Tt][._\-]?[Tt]|[Oo][Ww][Oo]|[Uu][Ww][Uu]|[>＞][.<]/.test(t)) return true;
        return false;
      };

      const extractOne = (node, parentMeta) => {
        if (!node) return null;
        const link = node.querySelector('a[href*="/@"]');
        const href = link?.getAttribute('href') || '';
        const um = href.match(/\/@([^/?#]+)/);
        let username = um ? um[1] : '';
        try { username = decodeURIComponent(username); } catch { /* keep */ }
        if (!username) return null;

        const nicknameEl = node.querySelector(
          '[data-e2e="comment-username"], [data-e2e="comment-user-uniqueid"], a[href*="/@"] span, a[href*="/@"] p, strong'
        );
        let nickname = cleanText(nicknameEl) || username;

        const textEl = node.querySelector(
          [
            'span[data-e2e="comment-text"]',
            'p[data-e2e="comment-text"]',
            'span[class*="CommentText"]',
            'p[class*="CommentText"]',
            'div[class*="DivCommentContent"] span',
            'div[class*="DivCommentContent"] p',
          ].join(', ')
        );
        let text = cleanText(textEl);
        const emojiBits = emojiFromImgs(textEl || node);
        if (emojiBits && !text.includes(emojiBits)) text = `${text} ${emojiBits}`.trim();
        if (!text) {
          const raw = cleanText(node);
          text = raw
            .replace(nickname, '')
            .replace(username, '')
            .replace(/\bCreator\b|\b创作者\b/gi, ' ')
            .replace(/\b\d+\s*(d|h|m|w|mo|y|天|小时|分钟|周|月|年)\b/gi, ' ')
            .replace(/\b(Reply|回复|Like|赞|Delete|删除)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const moreEmoji = emojiFromImgs(node);
          if (moreEmoji && !text.includes(moreEmoji)) text = `${text} ${moreEmoji}`.trim();
        }
        if (!text) return null;
        if (text.length < 2 && !hasEmojiOrKaomoji(text)) return null;
        if (/^(Reply|回复|View\s+\d+|查看)/i.test(text)) return null;

        const timeEl = node.querySelector(
          'span[data-e2e="comment-time"], [class*="CommentTime"], span[class*="SpanCreatedTime"]'
        );
        const timeText = cleanText(timeEl).slice(0, 40);
        const isReply = !!parentMeta
          || node.getAttribute('data-e2e') === 'comment-level-2'
          || !!node.closest('[data-e2e="comment-level-2"]');

        return {
          username,
          nickname: nickname || username,
          profileUrl: href.startsWith('http') ? href.split('?')[0] : `https://www.tiktok.com${href.split('?')[0]}`,
          comment_text: text.slice(0, 500),
          comment_time: timeText,
          parentUsername: parentMeta?.username || '',
          parentText: parentMeta?.comment_text || '',
          level: isReply ? 2 : 1,
        };
      };

      const pushItem = (item) => {
        if (!item) return;
        if (author && item.username.toLowerCase() === author && item.level === 1) return;
        const key = `${item.level}|${item.username.toLowerCase()}|${item.comment_text.slice(0, 60)}`;
        if (seenLocal.has(key)) return;
        seenLocal.add(key);
        out.push(item);
      };

      const itemRoots = document.querySelectorAll('[data-e2e="comment-item"]');
      if (itemRoots.length) {
        itemRoots.forEach((item) => {
          const l1 = item.querySelector('[data-e2e="comment-level-1"]') || item;
          const parentRow = extractOne(l1, null);
          if (parentRow) pushItem(parentRow);
          item.querySelectorAll('[data-e2e="comment-level-2"]').forEach((l2) => {
            pushItem(extractOne(l2, parentRow));
          });
        });
        return out;
      }

      document.querySelectorAll('[data-e2e="comment-level-1"]').forEach((l1) => {
        const parentRow = extractOne(l1, null);
        if (parentRow) pushItem(parentRow);
        const wrap = l1.closest('[data-e2e="comment-item"], div[class*="CommentItem"], div[class*="DivComment"]') || l1.parentElement;
        if (!wrap) return;
        wrap.querySelectorAll('[data-e2e="comment-level-2"]').forEach((l2) => {
          pushItem(extractOne(l2, parentRow));
        });
      });

      if (!out.length) {
        document.querySelectorAll(
          'div[class*="CommentItem"], div[class*="DivCommentObjectWrapper"], div[class*="DivCommentItemContainer"]'
        ).forEach((node) => {
          if (node.querySelector('[data-e2e="comment-level-1"], [data-e2e="comment-level-2"]')) return;
          pushItem(extractOne(node, null));
        });
      }
      return out;
    }, authorFilter).catch(() => []);

    let added = 0;
    for (const c of batch || []) {
      const key = `${c.level || 1}:${c.username}:${c.comment_text.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(c);
      added += 1;
    }
    if (!added && round > 1) break;

    // 评论侧栏内滚动加载更多
    await page.evaluate(() => {
      const box = document.querySelector(
        '[data-e2e="comment-list"], [class*="DivCommentListContainer"], [class*="DivCommentMain"]'
      );
      if (box) {
        box.scrollTop = box.scrollHeight;
        return;
      }
      window.scrollBy(0, 600);
    }).catch(() => {});
    await humanPause(900, 0.2);
  }

  return { comments, likes, views: listViews, opened: true, panelOpen: panelOk };
}

async function runUserPipeline(accountId, payload) {
  const leadId = Number(payload.leadId || payload.lead_id || 0);
  const keyword = String(payload.keyword || payload.keywords || '').trim();
  const limits = {
    limitFollows: Number(payload.limitFollows || payload.limit_follows || 0),
    limitLikes: Number(payload.limitLikes || payload.limit_likes || 0),
    limitLook: Number(payload.limitLook || payload.limit_look || 0),
  };
  const filterPrompt = String(payload.filterPrompt || payload.filter_prompt || '');

  if (!leadId || !keyword) {
    throw new Error('AI拓客 payload 缺少 leadId 或 keyword');
  }

  // 重推会先 abort-ai-lead 留下 sticky flag，新一轮开始前清除
  clearLeadAbort(leadId);

  let connection = null;
  const stats = { creators: 0, videos: 0, comments: 0, leads: 0, rawUsers: 0, droppedUsers: 0 };

  try {
    liveLog(
      `AI拓客 #${leadId} 按用户开始 account#${accountId} kw=${keyword} 粉丝≥${limits.limitFollows} 获赞≥${limits.limitLikes} 播放≥${limits.limitLook}`,
      'info',
      { accountId, leadId }
    );
    await reportProgress(leadId, { phase: 'connect', keyword, accountId, limits });

    {
      const { parseSaveTrafficFlag } = require('../save-traffic');
      connection = await connectAccount(accountId, null, 'ai_lead', {
        saveTraffic: parseSaveTrafficFlag(payload?.saveTraffic ?? payload?.save_traffic, true),
        browserBackend: payload?.browserBackend || payload?.browser_backend,
      });
    }
    registerLeadRun(leadId, connection, accountId);
    let page = connection?.page;
    if (!page) throw new Error('无法连接浏览器');

    await reportProgress(leadId, { phase: 'search_users', keyword });
    page = await searchUsersPage(connection, keyword, accountId);

    const hasResults = await waitForUserResults(page, { timeoutMs: 32000 });
    if (!hasResults) {
      await humanPause(3000, 0.2);
    }
    await dismissSearchOverlays(page);
    // 先等首屏落稳；若完全解析不到卡片，点一次 Users Tab 再开滚
    await humanPause(3000, 0.15);
    let probe = await collectRawUsersFromPage(page);
    if (!probe.length) {
      liveLog(`AI拓客 #${leadId} 首屏未解析到用户卡片，重试 Users Tab + 滚动`, 'warn', { leadId });
      const tab = await firstVisible(page, SELECTORS.usersTab, 5000);
      if (tab) {
        await tab.click({ force: true }).catch(() => {});
        await humanPause(3500, 0.2);
      } else {
        const byRole = page.getByRole('tab', { name: /Users|用户|帳號|账号/i }).first();
        if (await byRole.count().catch(() => 0)) {
          await byRole.click({ timeout: 3000 }).catch(() => {});
          await humanPause(3500, 0.2);
        }
      }
      await scrollLoadMore(page, { rounds: 3, pauseMs: 3500, settleFirst: false, leadId });
      probe = await collectRawUsersFromPage(page);
    }
    if (!probe.length) {
      const hint = await dumpSearchPageHint(page);
      if (hint?.blocked) {
        throw new Error(
          '搜索页触发验证/登录墙，无法加载用户列表。请在自研浏览器中手动完成验证后重试'
        );
      }
      if (hint?.noResults) {
        throw new Error(
          `关键词「${keyword}」在 Users 搜索下无结果，请更换关键词或调低筛选条件后重试`
        );
      }
      throw new Error(
        '搜索页未解析到任何用户卡片（可能未切到 Users、页面未加载或需验证）。浏览器将关闭，请降低风控后重试'
      );
    }

    // 持续翻页：首屏没有合格用户也继续滚，直到无新数据或凑满上限
    const collected = await collectUsersUntilExhausted(page, limits, {
      leadId,
      maxUsers: MAX_USERS,
      maxRounds: MAX_SEARCH_SCROLL_ROUNDS,
      staleStop: SEARCH_STALE_ROUNDS_STOP,
      pauseMs: 3500,
    });
    const raw = collected.raw;
    let passed = collected.passed;
    const dropped = collected.dropped;
    stats.rawUsers = raw.length;
    stats.droppedUsers = dropped.length;

    const pendingProfileN = passed.filter((u) => u.followersPending).length;
    liveLog(
      `AI拓客 #${leadId} 搜索结束 轮次=${collected.rounds} 解析=${raw.length} 进入主页校验=${passed.length}（待验粉=${pendingProfileN}） 列表丢弃=${dropped.length}`,
      passed.length ? 'info' : 'warn',
      { leadId, accountId }
    );

    if (!passed.length) {
      throw new Error(
        `已翻页 ${collected.rounds} 轮、解析 ${raw.length} 个用户，仍无用户可进入主页校验（粉丝≥${limits.limitFollows}`
        + (limits.limitLikes > 0 ? `，获赞≥${limits.limitLikes}` : '')
        + '）。搜索列表常显示 0 粉丝或读数偏低，请换关键词/多翻页后重试'
      );
    }

    await reportProgress(leadId, {
      phase: 'users_found',
      count: passed.length,
      raw: raw.length,
      dropped: dropped.length,
      rounds: collected.rounds,
    }, stats);

    const savedCreators = [];
    for (const user of passed) {
      assertLeadActive(leadId);
      let finalUser = { ...user };

      // 列表粉丝/获赞未加载或需复核时进主页（搜索卡常显示 0 Followers）
      const needProfile = user.followersPending
        || (!user.hasLikesOnCard && (user.likesPending || (limits.limitLikes > 0 && !user.likes)))
        || !user.followers;
      if (needProfile) {
        await reportProgress(leadId, { phase: 'verify_profile', creator: user.username }, stats);
        const profile = await scrapeProfileStats(page, user.username);
        const followers = profile.followers || user.followers || 0;
        const likes = profile.likes || user.likes || 0;
        if (followers < limits.limitFollows || likes < limits.limitLikes) {
          liveLog(
            `AI拓客跳过 @${user.username}：主页粉丝=${followers} 获赞=${likes}（需≥${limits.limitFollows}/${limits.limitLikes}）${user.followersPending ? ' [列表粉丝未加载]' : ''}`,
            'info',
            { leadId }
          );
          stats.droppedUsers += 1;
          continue;
        }
        finalUser = {
          ...user,
          followers,
          likes,
          avatar: profile.avatar || user.avatar,
          nickname: profile.nickname || user.nickname,
          likesPending: false,
          followersPending: false,
          hasLikesOnCard: true,
        };
        liveLog(
          `AI拓客 @${user.username} 主页校验通过 粉丝=${followers} 获赞=${likes}${user.followersPending ? '（列表曾为0/未读）' : ''}`,
          'info',
          { leadId }
        );
      } else if (user.followers < limits.limitFollows || user.likes < limits.limitLikes) {
        liveLog(
          `AI拓客跳过 @${user.username}：列表粉丝=${user.followers} 获赞=${user.likes}（需≥${limits.limitFollows}/${limits.limitLikes}）`,
          'info',
          { leadId }
        );
        stats.droppedUsers += 1;
        continue;
      }

      const saved = await saveCreator(leadId, accountId, finalUser).catch((e) => {
        liveLog(`保存用户失败 @${finalUser.username}: ${e.message}`, 'warn', { leadId });
        return null;
      });
      const creatorId = Number(saved?.id || saved?.data?.id || 0);
      if (!creatorId && !saved) continue;
      savedCreators.push({ ...finalUser, creatorId });
      stats.creators += 1;
      liveLog(
        `AI拓客入库用户 @${finalUser.username} 粉丝=${finalUser.followers} 获赞=${finalUser.likes}`,
        'info',
        { leadId }
      );
    }

    if (!savedCreators.length) {
      throw new Error(
        `主页校验后无用户满足粉丝≥${limits.limitFollows} 且获赞≥${limits.limitLikes}，请调低下限`
      );
    }

    for (const creator of savedCreators) {
      await reportProgress(leadId, {
        phase: 'scrape_videos',
        creator: creator.username,
      }, stats);

      const videos = await scrapeProfileVideos(page, creator.username, limits.limitLook);
      stats.videos += videos.length;
      liveLog(
        `AI拓客 @${creator.username} 合格视频 ${videos.length}（播放≥${limits.limitLook}）`,
        'info',
        { leadId }
      );

      for (const video of videos) {
        const vRes = await saveVideo(leadId, accountId, {
          creatorId: creator.creatorId,
          videoUrl: video.videoUrl,
          videoCover: video.videoCover,
          videoName: video.videoName,
          views: video.views,
          likes: 0,
        }).catch((e) => {
          liveLog(`保存视频失败: ${e.message}`, 'warn', { leadId });
          return null;
        });
        const videoId = Number(vRes?.id || vRes?.data?.id || 0);

        await reportProgress(leadId, {
          phase: 'scrape_comments',
          creator: creator.username,
          videoUrl: video.videoUrl,
        }, stats);

        const detail = await scrapeVideoComments(page, video.videoUrl, creator.username);
        const rawComments = detail.comments || [];
        const videoLikes = Number(detail.likes || 0);
        if (videoLikes > 0) {
          await saveVideo(leadId, accountId, {
            videoUrl: video.videoUrl,
            likes: videoLikes,
          }).catch((e) => {
            liveLog(`回填视频点赞失败: ${e.message}`, 'warn', { leadId });
          });
          liveLog(
            `AI拓客 @${creator.username} 视频点赞=${videoLikes} 浏览=${video.views}`,
            'info',
            { leadId }
          );
        }
        stats.comments += rawComments.length;
        liveLog(
          `AI拓客 @${creator.username} 视频评论原始 ${rawComments.length} 条${rawComments[0] ? ` 样例=@${rawComments[0].username}:${String(rawComments[0].comment_text || '').slice(0, 40)}` : ''}`,
          rawComments.length ? 'info' : 'warn',
          { leadId }
        );
        // 下一条仍从主页点封面，避免停留在 /video/ 直链态
        await safeGoto(
          { page },
          profileUrlFromUsername(creator.username),
          {
            accountId,
            label: `评论后回主页 @${creator.username}`,
            beforeMs: 2500,
            afterMs: 4500,
          }
        ).catch(() => {});
        await humanPause(2000, 0.15);
        if (!rawComments.length) continue;

        const matched = await filterCommentsViaAi(rawComments, filterPrompt);
        liveLog(
          `AI拓客 AI筛选 ${rawComments.length}→${matched.length} 条意向`,
          matched.length ? 'info' : 'warn',
          { leadId }
        );
        if (!matched.length) continue;

        await saveMatchedComments(leadId, videoId, matched);
        stats.leads += matched.length;
        liveLog(`AI拓客 命中评论 ${matched.length} 条 video=${video.videoUrl}`, 'info', { leadId });
      }
    }

    if (connection) {
      await closeConnection(connection).catch(() => {});
      connection = null;
    }

    // 线索抓取与私信推送解耦：私信由 ai-lead:dm-dispatch 计划任务常态化入队
    stats.dmsPending = stats.leads || 0;
    stats.summary = [
      `抓取用户 ${stats.creators || 0}`,
      `评论 ${stats.comments || 0}`,
      `意向 ${stats.leads || 0}`,
      `待发私信 ${stats.dmsPending || 0}`,
    ].join(' · ');

    await finishLead(leadId, true, stats);
    liveLog(
      `AI拓客 #${leadId} 完成 ${stats.summary}`,
      'info',
      { leadId, accountId }
    );
    return { status: 'completed', ...stats };
  } catch (error) {
    if (isAbortError(error) || isLeadAborted(leadId)) {
      const msg = isAbortError(error) ? error.message : '任务已暂停';
      liveLog(`AI拓客 #${leadId} 已暂停/终止: ${msg}`, 'warn', { leadId, accountId });
      await finishLead(leadId, false, { aborted: true, error: msg, ...stats });
      if (connection) {
        await closeConnection(connection, { force: true }).catch(() => {});
        connection = null;
      }
      return { status: 'cancelled', aborted: true, ...stats };
    }
    await finishLead(leadId, false, { error: error.message, ...stats });
    liveLog(`AI拓客 #${leadId} 失败: ${error.message}`, 'error', { leadId, accountId });
    throw error;
  } finally {
    unregisterLeadRun(leadId);
    if (connection) {
      await closeConnection(connection, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  runUserPipeline,
  scrapeVideoComments,
  scrapeProfileStats,
  scrapeProfileVideos,
  readViewsFromProfileGrid,
  fetchProfileVideoViewsViaPageApi,
  collectProfileVideoViewsMap,
  openVideoViaProfileClick,
  openVideoDirect,
  ensureCommentPanelOpen,
  scrapeVideoLikeCount,
  isOopsOrBlockedPage,
  isVideoBrowseOpen,
  extractVideoId,
  isRecoverableBrowserError,
};
