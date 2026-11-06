/**
 * AI矩阵 · 拉取视频数据：主页视频列表读取播放量，详情页抓取点赞/发布时间与评论树。
 */
const phpApi = require('../php-api');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const {
  scrapeVideoComments,
  scrapeVideoLikeCount,
  isOopsOrBlockedPage,
  extractVideoId,
  collectProfileVideoViewsMap,
  isVideoBrowseOpen,
  isRecoverableBrowserError,
} = require('./ai-lead/user-pipeline');
const { parseMetricCount, pickLabeledMetricText } = require('./ai-lead/parse-metric-count');
const { humanPause } = require('./ai-lead/pipeline-base');
const { publish: liveLog } = require('../live-log');
const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');

/** CDP/上下文挂掉时：清缓存、强制重开环境，返回新 connection */
async function reconnectPullBrowser(accountId, deadConn, reason = '') {
  liveLog(
    `拉取视频数据 account#${accountId} 浏览器失效${reason ? `（${String(reason).slice(0, 80)}）` : ''}，强制重开环境`,
    'warn',
    { accountId }
  );
  try {
    const { clearActiveConnection } = require('../session-context');
    clearActiveConnection(deadConn);
  } catch { /* ignore */ }
  await closeConnection(deadConn, { force: true }).catch(() => {});
  return connectAccount(accountId, 'https://www.tiktok.com/', 'pull_comments', {
    forceRelaunch: true,
    reuseConnection: false,
  });
}

const PICK_FN = pickLabeledMetricText.toString();

async function scrapeVideoViews(page) {
  const text = await page.evaluate(({ pickFnSource }) => {
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
      '[data-e2e="video-views"]',
      'strong[data-e2e="video-views"]',
      'strong.video-count',
      '[data-e2e="browse-video-desc"] strong',
      '[data-e2e="detail-video-views"]',
      '[data-e2e="browse-play-count"]',
    ]);
    if (t) return t;
    const blob = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000);
    return pickLabeledMetricText(blob, 'views?|plays?|播放|观看') || '';
  }, { pickFnSource: PICK_FN }).catch(() => '');
  return parseMetricCount(text);
}

async function scrapePublishedAt(page) {
  return page.evaluate(() => {
    const sels = [
      '[data-e2e="browser-nickname"] + span',
      'span[data-e2e="video-create-time"]',
      '[data-e2e="video-create-time"]',
      'span[class*="SpanOtherInfos"] span:last-child',
      'span[class*="CreateTime"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && /ago|前|\d{4}|\d{1,2}[-/]\d{1,2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|月|天|小时|分钟|周/i.test(t)) {
        return t.slice(0, 64);
      }
    }
    // 描述区旁短时间文案
    const infos = document.querySelector('[class*="SpanOtherInfos"], [data-e2e="browser-nickname"]')?.parentElement;
    if (infos) {
      const spans = [...infos.querySelectorAll('span')].map((x) => (x.textContent || '').trim()).filter(Boolean);
      const hit = spans.find((t) => /ago|前|\d{1,2}[-/]\d{1,2}|月|天|小时|周/i.test(t) && t.length < 40);
      if (hit) return hit;
    }
    return '';
  }).catch(() => '');
}

function resolveVideoUrl(video, accountUsername) {
  const raw = String(video.videoUrl || video.video_url || '').trim();
  const vid = String(video.videoId || video.video_id || extractVideoId(raw) || '').trim();
  const uname = String(accountUsername || '').replace(/^@+/, '').trim();
  // TikTok 短链 /video/{id} 常跳到 /404?fromUrl=…，有用户名时一律用 @user/video/id
  if (vid && uname) return `https://www.tiktok.com/@${encodeURIComponent(uname)}/video/${vid}`;
  if (/\/@[^/?#]+\/video\/\d+/i.test(raw)) return raw.split('?')[0];
  if (vid) return `https://www.tiktok.com/video/${vid}`;
  return raw;
}

function resolveCreatorUsername(videos, accountUsername) {
  const fromAccount = String(accountUsername || '').replace(/^@+/, '').trim();
  if (fromAccount) return fromAccount;
  for (const video of videos || []) {
    const url = resolveVideoUrl(video, '');
    const m = String(url || '').match(/\/@([^/?#]+)\/video\//);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
  }
  return '';
}

/**
 * @param {number} accountId
 * @param {object} payload
 */
async function runPullComments(accountId, payload = {}) {
  const pullTaskId = Number(payload.pullTaskId || payload.pull_task_id || payload.taskRefId || 0);
  const videos = Array.isArray(payload.videos) ? payload.videos : [];
  if (!videos.length) {
    throw new Error('拉取视频数据缺少视频列表');
  }

  if (pullTaskId > 0) {
    await phpApi.post(`/node/pull-comment-tasks/${pullTaskId}/start`, {}).catch(() => {});
  }

  liveLog(
    `拉取视频数据 #${pullTaskId || '-'} account#${accountId} 视频 ${videos.length} 个`,
    'info',
    { accountId, pullTaskId }
  );

  let connection = await connectAccount(accountId, 'https://www.tiktok.com/', 'pull_comments');
  await solveRotateCaptchaIfPresent(connection.page, { accountId }).catch(() => {});
  const accountUsername = resolveCreatorUsername(
    videos,
    connection.account?.username || payload.accountUsername || payload.username || ''
  );
  if (!accountUsername) {
    liveLog(`拉取视频数据 account#${accountId} 缺少发布账号用户名，无法从主页列表读播放量`, 'warn', { accountId, pullTaskId });
  }
  const results = [];
  let totalComments = 0;
  let failed = 0;
  let lastError = '';

  const targetVideoIds = videos
    .map((v) => extractVideoId(resolveVideoUrl(v, accountUsername)))
    .filter(Boolean);
  let profileViewsMap = new Map();
  if (accountUsername && targetVideoIds.length) {
    try {
      profileViewsMap = await collectProfileVideoViewsMap(connection, accountUsername, targetVideoIds);
      const withViews = targetVideoIds.filter((id) => (profileViewsMap.get(id) || 0) > 0).length;
      liveLog(
        `拉取视频数据 主页列表播放量 @${accountUsername} 已解析 ${withViews}/${targetVideoIds.length}（网格+API）`,
        withViews > 0 ? 'info' : 'warn',
        { accountId, pullTaskId, matched: withViews, total: targetVideoIds.length, accountUsername }
      );
    } catch (e) {
      if (isRecoverableBrowserError(e)) {
        try {
          connection = await reconnectPullBrowser(accountId, connection, e.message || e);
          profileViewsMap = await collectProfileVideoViewsMap(connection, accountUsername, targetVideoIds);
          const withViews = targetVideoIds.filter((id) => (profileViewsMap.get(id) || 0) > 0).length;
          liveLog(
            `拉取视频数据 主页列表播放量 @${accountUsername} 重开后已解析 ${withViews}/${targetVideoIds.length}`,
            withViews > 0 ? 'info' : 'warn',
            { accountId, pullTaskId, matched: withViews, total: targetVideoIds.length, accountUsername }
          );
        } catch (e2) {
          liveLog(`拉取视频数据 主页列表播放量解析失败: ${e2.message || e2}`, 'warn', { accountId, pullTaskId });
        }
      } else {
        liveLog(`拉取视频数据 主页列表播放量解析失败: ${e.message || e}`, 'warn', { accountId, pullTaskId });
      }
    }
  }

  try {
    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i] || {};
      const materialId = Number(video.materialId || video.material_id || 0);
      const videoUrl = resolveVideoUrl(video, accountUsername);
      if (!videoUrl || !materialId) {
        failed += 1;
        lastError = '素材缺少平台视频链接';
        results.push({ materialId, status: 'failed', error: lastError });
        continue;
      }

      liveLog(
        `拉取视频数据 ${i + 1}/${videos.length} 素材#${materialId} ${extractVideoId(videoUrl) || videoUrl}`,
        'info',
        { accountId, pullTaskId, materialId }
      );

      try {
        // 发布账号登录态：优先直开自己的视频（比未登录直链稳）；失败再主页点封面
        const scrapeOpts = {
          preferDirect: true,
          includeAuthorComments: true,
          allowDirectFallback: true,
        };
        const pullOne = async () => {
          let scraped = await scrapeVideoComments(connection, videoUrl, accountUsername, scrapeOpts);
          const needRetry = scraped?.opened === false
            || (!scraped?.panelOpen && !(scraped?.comments || []).length && !Number(scraped?.likes || 0));
          if (needRetry) {
            liveLog(`拉取视频数据 详情未就绪，回退主页点封面 素材#${materialId}`, 'warn', { accountId, pullTaskId, materialId });
            scraped = await scrapeVideoComments(connection, videoUrl, accountUsername, {
              preferDirect: false,
              includeAuthorComments: true,
              allowDirectFallback: true,
            });
          }
          const page = connection.page;
          await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
          if (await isOopsOrBlockedPage(page)) {
            liveLog(`拉取视频数据 首屏异常，直链重试 素材#${materialId}`, 'warn', { accountId, pullTaskId, materialId });
            scraped = await scrapeVideoComments(connection, videoUrl, accountUsername, scrapeOpts);
            await solveRotateCaptchaIfPresent(connection.page, { accountId }).catch(() => {});
          }
          if (await isOopsOrBlockedPage(connection.page)) {
            throw new Error('视频详情出现异常页（TikTok 页面出错，请稍后重试或手动打开该视频验证）');
          }
          const comments = Array.isArray(scraped?.comments) ? scraped.comments : [];
          const vid = extractVideoId(videoUrl);
          const detailOpen = scraped?.opened !== false
            && (await isVideoBrowseOpen(connection.page, vid)
              || Number(scraped?.likes || 0) > 0
              || comments.length > 0);
          if (vid && !detailOpen) {
            throw new Error('视频详情未打开（主页未找到封面或浏览态未加载，请确认素材链接与账号主页可见该视频）');
          }
          const likesEarly = Number(scraped?.likes || 0);
          if (detailOpen && !comments.length && !likesEarly && !scraped?.panelOpen) {
            throw new Error('视频详情疑似未真正打开（仍在主页，评论栏不可用）');
          }
          const likes = Number(scraped?.likes || 0) || await scrapeVideoLikeCount(connection.page);
          let views = Number(profileViewsMap.get(vid) || scraped?.views || 0);
          let viewsSource = views > 0 ? 'list' : '';
          if (!views) {
            views = await scrapeVideoViews(connection.page);
            if (views > 0) viewsSource = 'detail';
          }
          if (viewsSource === 'detail') {
            liveLog(`拉取视频数据 素材#${materialId} 列表未解析到播放量，已回退详情页`, 'warn', { accountId, pullTaskId, materialId });
          }
          const publishedRaw = await scrapePublishedAt(connection.page);
          return { scraped, comments, likes, views, viewsSource, publishedRaw };
        };

        let pulled;
        try {
          pulled = await pullOne();
        } catch (e) {
          if (!isRecoverableBrowserError(e)) throw e;
          connection = await reconnectPullBrowser(accountId, connection, e.message || e);
          pulled = await pullOne();
        }

        if (pullTaskId > 0) {
          await phpApi.post(`/node/pull-comment-tasks/${pullTaskId}/ingest`, {
            materialId,
            views: pulled.views,
            likes: pulled.likes,
            publishedAt: pulled.publishedRaw,
            comments: pulled.comments,
          });
        }
        totalComments += pulled.comments.length;
        results.push({
          materialId,
          status: 'ok',
          views: pulled.views,
          likes: pulled.likes,
          comments: pulled.comments.length,
          publishedAt: pulled.publishedRaw,
        });
        liveLog(
          `拉取视频数据成功 素材#${materialId} 播放=${pulled.views}${pulled.viewsSource ? `(${pulled.viewsSource === 'list' ? '列表' : '详情'})` : ''} 赞=${pulled.likes} 评论=${pulled.comments.length}`,
          'info',
          { accountId, pullTaskId, materialId, viewsSource: pulled.viewsSource || 'none' }
        );
      } catch (e) {
        failed += 1;
        lastError = e.message || String(e);
        results.push({ materialId, status: 'failed', error: lastError });
        liveLog(`拉取视频数据失败 素材#${materialId}: ${lastError}`, 'error', { accountId, pullTaskId, materialId });
        // 不可恢复的浏览器死了：后续视频也先重开一次，避免连环失败
        if (isRecoverableBrowserError(e)) {
          try {
            connection = await reconnectPullBrowser(accountId, connection, lastError);
          } catch { /* 留给下一轮再失败 */ }
        }
      }
      await humanPause(2500, 0.25);
    }

    const ok = failed < videos.length;
    if (pullTaskId > 0) {
      await phpApi.post(`/node/pull-comment-tasks/${pullTaskId}/finish`, {
        success: ok,
        error: ok ? '' : lastError,
        results,
        commentCount: totalComments,
      }).catch(() => {});
    }

    return {
      status: ok ? 'ok' : 'failed',
      pullTaskId,
      videos: results.length,
      comments: totalComments,
      failed,
      results,
      error: ok ? '' : lastError,
    };
  } finally {
    await closeConnection(connection).catch(() => {});
  }
}

module.exports = { runPullComments, scrapeVideoViews, scrapePublishedAt };
