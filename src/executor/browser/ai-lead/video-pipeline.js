/**
 * AI拓客 · 按视频类型
 *
 * 与按用户的差异：
 * 1) 关键词搜索 Videos（不是 Users）
 * 2) 滚动搜索结果，按播放量筛选
 * 3) 合格视频先全部入库
 * 4) 再逐一打开视频 → 创作者入库 → 评论入库 → AI 筛选
 * 5) 私信阶段与按用户完全一致（runDmPhase）
 *
 * 下限：limitLook=视频播放量；limitFollows/limitLikes=创作者主页粉丝/获赞。
 */
const { parseMetricCount, pickLabeledMetricText } = require('./parse-metric-count');
const PARSE_METRIC_FN = parseMetricCount.toString();
const PICK_LABELED_METRIC_FN = pickLabeledMetricText.toString();

const {
  connectAccount,
  closeConnection,
  profileUrlFromUsername,
  searchVideosPage,
  scrollLoadMore,
  scrollSearchResults,
  reportProgress,
  saveCreator,
  saveVideo,
  filterCommentsViaAi,
  saveMatchedComments,
  finishLead,
  humanPause,
  firstVisible,
  SELECTORS,
  liveLog,
  assertLeadActive,
  clearLeadAbort,
  registerLeadRun,
  unregisterLeadRun,
  isAbortError,
  isLeadAborted,
} = require('./pipeline-base');

const {
  scrapeVideoComments,
  scrapeProfileStats,
} = require('./user-pipeline');

const MAX_VIDEOS = 40;
const MAX_SEARCH_SCROLL_ROUNDS = 24;
const SEARCH_STALE_ROUNDS_STOP = 3;

/**
 * 从 Videos 搜索结果解析卡片：视频 URL、封面、播放量、作者。
 */
async function collectSearchVideosFromPage(page) {
  return page.evaluate(({ parseFnSource, pickFnSource }) => {
    const parseMetricCount = eval(`(${parseFnSource})`);
    const pickLabeledMetricText = eval(`(${pickFnSource})`);

    const extractViews = (root) => {
      const parts = [];
      const strong = root.querySelector?.('strong');
      if (strong) parts.push((strong.textContent || '').trim());
      const aria = root.getAttribute?.('aria-label') || '';
      if (aria) parts.push(aria);
      parts.push((root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240));
      for (const text of parts) {
        const labeled = pickLabeledMetricText(text, 'views?|plays?|播放|观看|次播放');
        if (labeled) return labeled;
      }
      for (const text of parts) {
        if (/like|赞|heart|follower|粉丝/i.test(text) && !/view|play|播放/i.test(text)) continue;
        const m = String(text).match(
          /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i
        );
        if (m) return m[0];
      }
      return '';
    };

    const out = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    for (const a of anchors) {
      const href = (a.getAttribute('href') || '').split('?')[0];
      if (!href.includes('/video/') || seen.has(href)) continue;
      seen.add(href);

      let card = a.closest(
        '[data-e2e="search_video-item"], [data-e2e="search-video-item"], div[class*="DivItemContainer"], div[class*="DivVideo"]'
      ) || a.parentElement;
      for (let i = 0; i < 4 && card; i += 1) {
        if (card.querySelector?.('a[href*="/@"]')) break;
        card = card.parentElement;
      }
      const scope = card || a;

      const authorA = Array.from(scope.querySelectorAll('a[href*="/@"]')).find((el) => {
        const h = el.getAttribute('href') || '';
        return /\/@[^/?#]+/.test(h) && !h.includes('/video/');
      });
      const authorHref = authorA?.getAttribute('href') || '';
      const um = authorHref.match(/\/@([^/?#]+)/);
      let username = um ? um[1] : '';
      try { username = decodeURIComponent(username); } catch { /* keep */ }
      if (!username) {
        const m2 = href.match(/\/@([^/?#]+)\/video\//);
        if (m2) {
          try { username = decodeURIComponent(m2[1]); } catch { username = m2[1]; }
        }
      }
      if (!username) continue;

      const img = a.querySelector('img') || scope.querySelector('img');
      const cover = img?.getAttribute('src') || '';
      const title = (a.getAttribute('title') || img?.getAttribute('alt') || '').trim().slice(0, 120);
      const nickname = ((authorA?.textContent || '').replace(/\s+/g, ' ').trim() || username).slice(0, 80);
      const viewsText = extractViews(scope);
      const views = parseMetricCount(viewsText);
      const videoUrl = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;

      out.push({
        videoUrl,
        videoCover: cover,
        videoName: title,
        views,
        viewsText,
        username,
        nickname,
        profileUrl: `https://www.tiktok.com/@${username}`,
      });
    }
    return out;
  }, { parseFnSource: PARSE_METRIC_FN, pickFnSource: PICK_LABELED_METRIC_FN }).catch(() => []);
}

async function waitForVideoResults(page, { timeoutMs = 70000 } = {}) {
  const { scaleTimeout, waitSearchContent } = require('../page-ready');
  const budget = scaleTimeout(timeoutMs, 45000);
  const countCards = async (p) => {
    const n = await p.locator(
      '[data-e2e="search_video-item"], [data-e2e="search-video-item"], a[href*="/video/"]'
    ).count().catch(() => 0);
    return n;
  };
  const isEmpty = async (p) => p.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 4000);
    if (/Loading|正在加载|加载中/i.test(t) && !/no results|couldn'?t find|没有结果/i.test(t)) return false;
    return /Couldn't find|No results found|没有任何结果|没有找到相关|unusual traffic/i.test(t);
  }).catch(() => false);
  const isCaptcha = async (p) => p.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 4000);
    return /verify you.?re (a )?human|security check|人机验证|拖动滑块/i.test(t);
  }).catch(() => false);

  const result = await waitSearchContent(page, {
    timeoutMs: budget,
    absolute: true,
    reloadOnce: true,
    countCards,
    isEmpty,
    isCaptcha,
    log: (m) => liveLog(`AI拓客 ${m}`, 'info'),
  });
  return !!result.ok;
}

/**
 * 持续翻页采集合格视频（播放量 ≥ limitLook）。
 */
async function collectVideosUntilExhausted(page, minViews, {
  leadId = 0,
  maxVideos = MAX_VIDEOS,
  maxRounds = MAX_SEARCH_SCROLL_ROUNDS,
  staleStop = SEARCH_STALE_ROUNDS_STOP,
  pauseMs = 3500,
} = {}) {
  const passed = [];
  const passedKeys = new Set();
  const rawKeys = new Set();
  let dropped = 0;
  let stale = 0;
  let rounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    if (leadId) assertLeadActive(leadId);
    const batch = await collectSearchVideosFromPage(page);
    let newRaw = 0;
    for (const v of batch || []) {
      const key = String(v.videoUrl || '').split('?')[0];
      if (!key || rawKeys.has(key)) continue;
      rawKeys.add(key);
      newRaw += 1;
      const views = Number(v.views || 0);
      if (views < minViews) {
        dropped += 1;
        continue;
      }
      if (passedKeys.has(key)) continue;
      passedKeys.add(key);
      passed.push(v);
      if (passed.length >= maxVideos) break;
    }

    liveLog(
      `AI拓客 #${leadId} 视频搜索第${rounds}轮 本屏新=${newRaw} 合格累计=${passed.length}/${maxVideos} 丢弃=${dropped}`,
      'info',
      { leadId }
    );

    if (passed.length >= maxVideos) break;
    if (newRaw === 0) {
      stale += 1;
      if (stale >= staleStop) {
        liveLog(
          `AI拓客 #${leadId} 连续 ${stale} 轮无新视频，停止翻页（累计解析 ${rawKeys.size}，合格 ${passed.length}）`,
          'info',
          { leadId }
        );
        break;
      }
    } else {
      stale = 0;
    }

    await humanPause(pauseMs, 0.12, leadId);
    await scrollSearchResults(page);
    await humanPause(Math.max(1200, Math.round(pauseMs * 0.45)), 0.15, leadId);
  }

  return {
    passed: passed.slice(0, maxVideos),
    rawCount: rawKeys.size,
    dropped,
    rounds,
  };
}

/**
 * 阶段 3：合格视频先全部入库（creator_id 可先为 0，后续打开时回填）。
 * @returns {Array<{ videoUrl, username, nickname, views, videoCover, videoName, dbId: number }>}
 */
async function persistFilteredVideos(leadId, accountId, videos) {
  const saved = [];
  for (const video of videos) {
    const uname = String(video.username || '').replace(/^@+/, '');
    if (!uname || !video.videoUrl) continue;
    const vRes = await saveVideo(leadId, accountId, {
      creatorId: 0,
      videoUrl: video.videoUrl,
      videoCover: video.videoCover,
      videoName: video.videoName || `@${uname}`,
      views: video.views,
      likes: 0,
    }).catch((e) => {
      liveLog(`保存视频失败: ${e.message}`, 'warn', { leadId });
      return null;
    });
    const dbId = Number(vRes?.id || vRes?.data?.id || 0);
    if (!dbId) {
      liveLog(`视频入库未返回 id，跳过后续: ${video.videoUrl}`, 'warn', { leadId });
      continue;
    }
    saved.push({
      ...video,
      username: uname,
      dbId,
    });
    liveLog(
      `AI拓客入库视频 #${dbId} @${uname} 播放=${video.views} ${String(video.videoUrl).slice(0, 80)}`,
      'info',
      { leadId }
    );
  }
  return saved;
}

/**
 * 阶段 4：逐一打开已入库视频 → 校验/入库创作者 → 抓评论 → AI → 评论入库。
 */
async function processSavedVideos(page, leadId, accountId, savedVideos, limits, filterPrompt, stats) {
  const creatorCache = new Map(); // username → { creatorId, ok, ... }

  for (let i = 0; i < savedVideos.length; i += 1) {
    assertLeadActive(leadId);
    const video = savedVideos[i];
    const uname = String(video.username || '').replace(/^@+/, '');
    const videoId = Number(video.dbId || 0);
    if (!uname || !videoId) continue;

    await reportProgress(leadId, {
      phase: 'open_video',
      index: i + 1,
      total: savedVideos.length,
      creator: uname,
      videoUrl: video.videoUrl,
    }, stats);

    // 4a) 创作者粉丝/获赞校验（同作者只验一次）
    let creator = creatorCache.get(uname.toLowerCase());
    if (!creator) {
      await reportProgress(leadId, { phase: 'verify_creator', creator: uname }, stats);
      const profile = await scrapeProfileStats(page, uname);
      const followers = Number(profile.followers || 0);
      const likes = Number(profile.likes || 0);
      const ok = followers >= limits.limitFollows && likes >= limits.limitLikes;
      if (!ok) {
        liveLog(
          `AI拓客跳过创作者 @${uname}：粉丝=${followers} 获赞=${likes}（需≥${limits.limitFollows}/${limits.limitLikes}），视频已入库保留`,
          'info',
          { leadId }
        );
        stats.droppedCreators += 1;
        creatorCache.set(uname.toLowerCase(), { ok: false });
        continue;
      }

      const userPayload = {
        username: uname,
        nickname: profile.nickname || video.nickname || uname,
        avatar: profile.avatar || '',
        profileUrl: profileUrlFromUsername(uname),
        followers,
        likes,
      };
      const savedC = await saveCreator(leadId, accountId, userPayload).catch((e) => {
        liveLog(`保存创作者失败 @${uname}: ${e.message}`, 'warn', { leadId });
        return null;
      });
      const creatorId = Number(savedC?.id || savedC?.data?.id || 0);
      if (!creatorId && !savedC) {
        creatorCache.set(uname.toLowerCase(), { ok: false });
        continue;
      }
      creator = { ok: true, creatorId, followers, likes, ...userPayload };
      creatorCache.set(uname.toLowerCase(), creator);
      stats.creators += 1;
      liveLog(
        `AI拓客入库创作者 @${uname} 粉丝=${followers} 获赞=${likes}`,
        'info',
        { leadId }
      );
    } else if (!creator.ok) {
      continue;
    }

    // 回填 creator_id
    await saveVideo(leadId, accountId, {
      videoUrl: video.videoUrl,
      creatorId: creator.creatorId,
      views: video.views,
    }).catch(() => {});

    // 4b) 打开视频抓评论（优先直开/搜索点封面）
    await reportProgress(leadId, {
      phase: 'scrape_comments',
      creator: uname,
      videoUrl: video.videoUrl,
      index: i + 1,
      total: savedVideos.length,
    }, stats);

    const detail = await scrapeVideoComments(page, video.videoUrl, uname, { preferDirect: true });
    const rawComments = detail.comments || [];
    const videoLikes = Number(detail.likes || 0);
    if (videoLikes > 0) {
      await saveVideo(leadId, accountId, {
        videoUrl: video.videoUrl,
        likes: videoLikes,
        creatorId: creator.creatorId,
      }).catch(() => {});
    }
    stats.comments += rawComments.length;
    liveLog(
      `AI拓客 @${uname} 视频评论原始 ${rawComments.length} 条 播放=${video.views}`,
      rawComments.length ? 'info' : 'warn',
      { leadId }
    );
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
    liveLog(`AI拓客 命中评论 ${matched.length} 条 video=#${videoId}`, 'info', { leadId });
  }
}

async function runVideoPipeline(accountId, payload) {
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

  clearLeadAbort(leadId);

  let connection = null;
  const stats = {
    creators: 0,
    videos: 0,
    comments: 0,
    leads: 0,
    rawVideos: 0,
    droppedVideos: 0,
    droppedCreators: 0,
  };

  try {
    liveLog(
      `AI拓客 #${leadId} 按视频开始 account#${accountId} kw=${keyword} 播放≥${limits.limitLook} 粉丝≥${limits.limitFollows} 获赞≥${limits.limitLikes}`,
      'info',
      { accountId, leadId }
    );
    await reportProgress(leadId, { phase: 'connect', keyword, accountId, limits, type: 'video' });

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

    // —— 1) 关键词搜索 Videos ——
    await reportProgress(leadId, { phase: 'search_videos', keyword }, stats);
    page = await searchVideosPage(connection, keyword, accountId);

    const hasResults = await waitForVideoResults(page, { timeoutMs: 70000 });
    if (!hasResults) {
      await humanPause(4000, 0.2);
    }
    await humanPause(2500, 0.15);

    let probe = await collectSearchVideosFromPage(page);
    if (!probe.length) {
      liveLog(`AI拓客 #${leadId} 首屏未解析到视频卡片，重试 Videos Tab`, 'warn', { leadId });
      const tab = await firstVisible(page, SELECTORS.videosTab, 4000);
      if (tab) {
        await tab.click({ force: true }).catch(() => {});
        await humanPause(3000, 0.2);
      }
      await scrollLoadMore(page, { rounds: 2, pauseMs: 3000, settleFirst: false, leadId });
      probe = await collectSearchVideosFromPage(page);
    }
    if (!probe.length) {
      throw new Error(
        '搜索页未解析到任何视频卡片（可能未切到 Videos、页面未加载或需验证）。请降低风控后重试'
      );
    }

    // —— 2) 滚动筛选播放量合格视频 ——
    const collected = await collectVideosUntilExhausted(page, limits.limitLook, {
      leadId,
      maxVideos: MAX_VIDEOS,
      maxRounds: MAX_SEARCH_SCROLL_ROUNDS,
      staleStop: SEARCH_STALE_ROUNDS_STOP,
      pauseMs: 3500,
    });
    stats.rawVideos = collected.rawCount;
    stats.droppedVideos = collected.dropped;

    liveLog(
      `AI拓客 #${leadId} 视频搜索结束 轮次=${collected.rounds} 解析=${collected.rawCount} 合格=${collected.passed.length} 丢弃=${collected.dropped}`,
      collected.passed.length ? 'info' : 'warn',
      { leadId, accountId }
    );

    if (!collected.passed.length) {
      throw new Error(
        `已翻页 ${collected.rounds} 轮、解析 ${collected.rawCount} 个视频，仍无一满足播放≥${limits.limitLook}。请调低浏览下限或换关键词`
      );
    }

    await reportProgress(leadId, {
      phase: 'videos_found',
      count: collected.passed.length,
      raw: collected.rawCount,
      dropped: collected.dropped,
      rounds: collected.rounds,
    }, stats);

    // —— 3) 合格视频先全部入库 ——
    await reportProgress(leadId, { phase: 'persist_videos', count: collected.passed.length }, stats);
    const savedVideos = await persistFilteredVideos(leadId, accountId, collected.passed);
    stats.videos = savedVideos.length;
    liveLog(
      `AI拓客 #${leadId} 已入库视频 ${savedVideos.length}/${collected.passed.length}，开始逐一打开`,
      'info',
      { leadId, accountId }
    );

    if (!savedVideos.length) {
      throw new Error('合格视频入库失败（接口未返回 id），请检查 API / 数据库');
    }

    // —— 4) 逐一打开 → 创作者 + 评论 ——
    await processSavedVideos(page, leadId, accountId, savedVideos, limits, filterPrompt, stats);

    if (connection) {
      await closeConnection(connection).catch(() => {});
      connection = null;
    }

    // 线索抓取与私信推送解耦：私信由 ai-lead:dm-dispatch 计划任务常态化入队
    stats.dmsPending = stats.leads || 0;
    stats.summary = [
      `入库视频 ${stats.videos || 0}`,
      `创作者 ${stats.creators || 0}`,
      `评论 ${stats.comments || 0}`,
      `意向 ${stats.leads || 0}`,
      `待发私信 ${stats.dmsPending || 0}`,
    ].join(' · ');

    await finishLead(leadId, true, stats);
    liveLog(`AI拓客 #${leadId} 按视频完成 ${stats.summary}`, 'info', { leadId, accountId });
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
    liveLog(`AI拓客 #${leadId} 按视频失败: ${error.message}`, 'error', { leadId, accountId });
    throw error;
  } finally {
    unregisterLeadRun(leadId);
    if (connection) {
      await closeConnection(connection, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  runVideoPipeline,
  collectSearchVideosFromPage,
  collectVideosUntilExhausted,
  persistFilteredVideos,
};
