const phpApi = require('./php-api');
const { syncVideos } = require('./browser/tiktok-data');
const { preparePublish, prepareMessage, connectAccount, closeConnection, forceCloseBrowserProfile } = require('./browser/tiktok-actions');
const { assertPublishGate, loadGate } = require('./account-gates');
const {
  fullLogin,
  closeSession,
  clearTikTokCookiesOnly,
  applySavedSessionToContext,
  persistAccountSessionLog,
} = require('./browser/tiktok-login');
const { publish: liveLog, publishEvent } = require('./live-log');
const executorHub = require('./executor-hub');
const { runWithSession, getSession, setSessionSaveTraffic, getActiveConnection } = require('./session-context');
const { parseSaveTrafficFlag, applySaveTrafficOnConnection } = require('./browser/save-traffic');
const dataStore = require('./data-store');

/** 从 payload 解析省流并同步到会话 / 已打开的浏览器 */
async function syncSaveTrafficFromPayload(payload, defaultOn = false) {
  const enabled = parseSaveTrafficFlag(
    payload?.saveTraffic ?? payload?.save_traffic,
    defaultOn
  );
  try {
    setSessionSaveTraffic(enabled);
  } catch { /* ignore */ }
  try {
    const live = getActiveConnection();
    if (live) await applySaveTrafficOnConnection(live, enabled);
  } catch { /* ignore */ }
  return enabled;
}
const { inspectTikTokSession } = require('./browser/cdp-client');
const { runWithBrowserBackend, normalizeBackendId, resolveProfileIdForAccount, getProvider } = require('./browser/providers');
const {
  isServerBrowserTaskType,
  isServerBrowserBatchScope,
  serverBrowserForbiddenError,
  ensureServerBrowserEnv,
  waitingLoginDataError,
  WAITING_ENV_PACK,
  WAITING_LOGIN_DATA,
} = require('./browser/server-browser');
const os = require('node:os');

function taskBrowserBackend(payload = {}, account = {}) {
  return normalizeBackendId(payload.browserBackend || payload.browser_backend || account.browser_backend)
    || normalizeBackendId(payload.pushChannel)
    || normalizeBackendId(payload.massChannel)
    || null;
}

/** Concurrent work batches = concurrent 自研/Bit browser windows（可由设置 taskConcurrency 覆盖） */
/** 默认并发略降，降低多窗同时猛操作触发验证的概率 */
const DEFAULT_MAX_CONCURRENT_BATCHES = 4;
const MIN_MAX_CONCURRENT_BATCHES = 2;
const HARD_MAX_CONCURRENT_BATCHES = 12;
/** @deprecated 兼容旧引用；运行时请用 resolveMaxConcurrent() */
const MAX_CONCURRENT_BATCHES = DEFAULT_MAX_CONCURRENT_BATCHES;
let activeBatchCount = 0;
let claiming = false;
let _cachedMaxConcurrent = DEFAULT_MAX_CONCURRENT_BATCHES;
let _cachedMaxConcurrentAt = 0;

function clampTaskConcurrency(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_BATCHES;
  return Math.min(HARD_MAX_CONCURRENT_BATCHES, Math.max(MIN_MAX_CONCURRENT_BATCHES, Math.floor(n)));
}

/** 读取本机/用户设置中的自研任务并发（缓存 15s） */
async function resolveMaxConcurrent() {
  const now = Date.now();
  if (_cachedMaxConcurrentAt && (now - _cachedMaxConcurrentAt) < 15000) {
    return _cachedMaxConcurrent;
  }
  try {
    const dataStore = require('./data-store');
    const v = await dataStore.getSetting('taskConcurrency', DEFAULT_MAX_CONCURRENT_BATCHES);
    _cachedMaxConcurrent = clampTaskConcurrency(v);
  } catch {
    _cachedMaxConcurrent = DEFAULT_MAX_CONCURRENT_BATCHES;
  }
  _cachedMaxConcurrentAt = now;
  return _cachedMaxConcurrent;
}
/** Stable workerId (no pid) so restart can release/resume leases；与 env-pack hostId 同源，避免同机被判「其它主机」 */
const WORKER_ID = (() => {
  try {
    const { hostId } = require('./browser/env-pack-sync');
    return `node-${hostId()}`;
  } catch {
    return `node-${os.hostname()}`;
  }
})();

/** Manual test locks: `batch:1` | `item:8` ? also skips PHP CK gate */
const testingLocal = new Set();
function isManualTest() {
  return Boolean(getSession()?.test) || testingLocal.size > 0;
}

function isHumanVerifyResult(out) {
  if (!out || typeof out !== 'object') return false;
  const st = String(out.status || out.result?.status || '');
  return st === 'security_paused'
    || st === 'manual_required'
    || out.manualRequired === true
    || out.result?.manualRequired === true;
}

/** 检测到人机验证：上报 PHP 入队通知并暂停分任务/总任务（不关浏览器） */
async function reportHumanVerifyAndPause({
  accountId = 0,
  batchId = 0,
  itemId = 0,
  taskType = '',
  result = null,
} = {}) {
  const reason = String(
    result?.reason
    || result?.errorMessage
    || result?.result?.reason
    || result?.status
    || '需要人工完成 TikTok 验证'
  );
  let notice = null;
  try {
    notice = await phpApi.post('/node/human-verify/report', {
      accountId: Number(accountId) || 0,
      batchId: Number(batchId) || 0,
      itemId: Number(itemId) || 0,
      taskType: String(taskType || ''),
      reason,
      status: result?.status || result?.result?.status || 'security_paused',
      screenshot: result?.screenshot || result?.result?.screenshot || '',
      workerId: WORKER_ID,
      meta: result && typeof result === 'object' ? result : {},
    });
    liveLog(
      `账号 #${accountId}：已挂起等待人工验证${notice?.id ? `（通知#${notice.id}）` : ''}：${reason}`,
      'warn',
      { accountId, batchId, itemId }
    );
  } catch (err) {
    liveLog(`人工验证上报失败：${err.message || err}`, 'error', { accountId, batchId, itemId });
  }
  try {
    publishEvent('human-verify', notice || {
      accountId,
      batchId,
      itemId,
      taskType,
      reason,
      status: 'pending',
    });
  } catch { /* ignore */ }
  return notice;
}

/** Pushed to frontend, waiting for /api/executor/run */
const pendingOffers = new Map(); // batchId -> { batch, at, ownerId }
const OFFER_TTL_MS = 45000;
/** Locally executing batch ids */
const runningLocal = new Set();

async function executePhpTask(task) {
  const type = task.type;
  const accounts = Array.isArray(task.accounts) ? task.accounts : [];
  const payload = task.payload || {};
  const backend = taskBrowserBackend(payload);
  liveLog(
    `任务 #${task.id} ${task.name || type}，账号数 ${accounts.length}${backend ? `，浏览器=${backend}` : ''}`,
    'info',
    { taskId: task.id, browserBackend: backend || undefined }
  );

  return runWithBrowserBackend(backend, async () => {
  let success = 0;
  let fail = 0;
  for (const acc of accounts) {
    const accountId = Number(acc.id || acc.accountId);
    try {
      if (type === 'publish') await assertPublishGate(accountId, backend || payload.pushChannel || 'bit');
      let result;
      if (type === 'profile' || type === 'pull_stats') {
        const { pullStudioStats } = require('./browser/tiktok-studio-stats');
        const saveTraffic = await syncSaveTrafficFromPayload(payload, true);
        result = await pullStudioStats(accountId, { saveTraffic });
      } else if (type === 'sync') {
        result = await syncVideos(accountId);
      } else if (type === 'publish') {
        const materialId = Number(acc.materialId || acc.material_id || payload.materialId);
        const saveTraffic = await syncSaveTrafficFromPayload(payload, false);
        result = await preparePublish(
          accountId,
          materialId,
          payload.publishTitle || payload.publish_title || payload.shareTitle || payload.share_title || payload.title || '',
          payload.publishCaption || payload.publish_caption || payload.shareCaption || payload.share_caption || payload.caption || '',
          {
          autoPublish: !payload.manualConfirm,
          hashtags: payload.hashtags || payload.tags || '',
          saveTraffic,
          deleteAfterPublish: !!payload.deleteAfterPublish,
        });
        if (result?.status === 'security_paused' || result?.status === 'manual_required') {
          await reportHumanVerifyAndPause({
            accountId,
            taskType: type,
            result,
          });
          await phpApi.post(`/node/tasks/${task.id}/account-result`, {
            accountId,
            status: 'skipped',
            result,
            errorMessage: result.reason || result.status,
          }).catch(() => {});
          continue;
        }
        if (result?.status !== 'published') throw new Error(result?.error || `publish incomplete: ${result?.status}`);
        if (materialId > 0) {
          await phpApi.post(`/node/materials/${materialId}/mark-published`, {
            accountId,
            deleteAfterPublish: !!payload.deleteAfterPublish,
            videoId: result?.videoId || result?.video_id || '',
            videoUrl: result?.videoUrl || result?.video_url || '',
          }).catch((err) => {
            liveLog(`标记素材已发布失败：${err.message}`, 'warn', { accountId, materialId });
          });
          result = {
            ...(result || {}),
            materialId,
            accountId,
            videoId: result?.videoId || result?.video_id || '',
            videoUrl: result?.videoUrl || result?.video_url || '',
          };
        }
      } else if (type === 'message') {
        const saveTrafficMsg = await syncSaveTrafficFromPayload(payload, false);
        result = await prepareMessage(accountId, payload.content || payload.publishCaption || '', payload.recipient || '', {
          saveTraffic: saveTrafficMsg,
          browserBackend: payload.browserBackend || payload.browser_backend,
        });
      } else if (type === 'dm_sync') {
        const { syncAccountDm } = require('./browser/tiktok-dm-sync');
        result = await syncAccountDm(accountId, payload);
      } else if (type === 'warm') {
        const { runWarmAccount } = require('./browser/tiktok-warm');
        await syncSaveTrafficFromPayload(payload, true);
        liveLog(`任务 #${task.id} 养号 账号#${accountId}`, 'info', { taskId: task.id, accountId });
        result = await runWarmAccount(accountId, payload);
      } else {
        throw new Error(`unsupported task type (php mode): ${type}`);
      }
      await phpApi.post(`/node/tasks/${task.id}/account-result`, {
        accountId,
        status: 'success',
        result,
      });
      success += 1;
    } catch (error) {
      fail += 1;
      await phpApi.post(`/node/tasks/${task.id}/account-result`, {
        accountId,
        status: 'failed',
        errorMessage: error.message,
      }).catch(() => {});
      liveLog(`任务 #${task.id} 账号#${accountId} 失败：${error.message}`, 'error', { taskId: task.id });
    }
  }
  await phpApi.post(`/node/tasks/${task.id}/finish`, { success, fail });
  liveLog(`任务 #${task.id} 完成：成功 ${success}，失败 ${fail}`, 'info', { taskId: task.id });
  });
}

/**
 * 探测登录态，并在「Cookie 还在但服务端已判定失效」时顺手清掉残留 Cookie。
 * 自研浏览器用的是持久化 profile 目录，关窗不会清 Cookie；残留的 sessionid 会被
 * 误当成已登录，所以判定失效后直接清理，保证下一次判断/登录是干净的。
 */
async function probeSessionAndClean(ws, page, accountId, batchId, context = null) {
  const session = await inspectTikTokSession(ws, page);
  if (session?.invalidCookie && context) {
    await clearTikTokCookiesOnly(context).catch(() => {});
    liveLog(
      `Account#${accountId} 环境里的 TikTok Cookie 已被服务端判定失效（session_expired），已清理，避免下次又被当成"已登录"`,
      'warn',
      { accountId, batchId }
    );
  }
  return session;
}

/** 把登录依据拼成一行中文，方便在日志里一眼看出「凭什么判定」 */
function describeLoginEvidence(session) {
  if (!session) return '未探测';
  const parts = [];
  if (session.apiProbe?.ok) {
    parts.push(session.apiProbe.loggedIn
      ? `接口：已登录${session.apiProbe.userId ? '（user_id ' + session.apiProbe.userId + '）' : ''}`
      : `接口：${session.apiProbe.sessionExpired ? 'session_expired（Cookie 已失效）' : (session.apiProbe.reason || '未登录')}`);
  } else {
    parts.push(`接口：无结论${session.apiProbe?.reason ? '（' + session.apiProbe.reason + '）' : ''}`);
  }
  if (session.topRight) {
    parts.push(session.topRight.avatar ? '右上角：头像' : (session.topRight.loginButton ? '右上角：Log in 按钮' : '右上角：未识别'));
  } else {
    parts.push('右上角：页面未就绪');
  }
  if (session.gateProbe?.ok) parts.push(session.gateProbe.loggedIn ? '门禁页：可进' : '门禁页：被踢到登录');
  parts.push(`Cookie ${session.hasSessionCookie ? '有' : '无'}`);
  return parts.join('，');
}

/**
 * 总任务内执行过一键登录后：窗口保持打开 → 刷写会话凭证 → 在线(live)导出环境包 → 上传服务器 → 解除占用。
 * 中心库随后通过 WSS 中继只推给 FIFO 队首的等待设备，对方拉取本机上传的环境包与凭证后自动登录。
 * 不关窗、不重开、不动 connection，分任务继续在同一窗口里跑。
 */
async function uploadPackAfterBatchLogin(accountId, connection, batchId) {
  const pid = String(connection?.account?.browser_profile_id || '').trim();
  const provider = connection?.provider;
  if (!pid || !provider) return false;
  const sync = require('./browser/env-pack-sync');
  if (!sync.supportsPackSync(provider)) return false; // 比特等不支持环境包的后端：不处理
  const ctx = { accountId, batchId, profileId: pid };
  liveLog(`账号 #${accountId}：登录成功，窗口保持打开，在线上传环境包与登录凭证`, 'info', ctx);

  // 先把最新会话凭证写入中心库，再让浏览器把 Cookie 刷盘
  if (connection.context) {
    await persistAccountSessionLog(accountId, connection.context, connection.page).catch(() => {});
  }
  try {
    if (connection.page && !connection.page.isClosed?.()) {
      await connection.page.evaluate(() => { try { return document.cookie; } catch { return ''; } }).catch(() => {});
    }
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));

  // live：不关窗在线导出；pushLocalEnvPack 的 finally 会解除占用并通知 FIFO 队首
  const pushed = await sync.pushLocalEnvPack(pid, { accountId, provider, skipClose: true, live: true });
  try {
    publishEvent('pack-lease-released', {
      accountId,
      profileId: pid,
      pushed: !!pushed?.pushed,
      batch: true,
      live: true,
      nextHostId: String(sync.getLastReleaseSignal(pid)?.nextHostId || '') || undefined,
    });
  } catch { /* ignore */ }
  const next = String(sync.getLastReleaseSignal(pid)?.nextHostId || '').trim();
  liveLog(
    pushed?.pushed
      ? `账号 #${accountId}：环境包与凭证已上传并解除占用${next ? `，已通过 WSS 通知队首等待设备 ${next}` : ''}；窗口保持打开`
      : `账号 #${accountId}：登录后环境包上传失败（${pushed?.reason || '未知'}），已解除占用，窗口保持打开继续执行`,
    pushed?.pushed ? 'info' : 'warn',
    ctx,
  );
  return true;
}

/**
 * 排队接力：本机凭借上一台上传的环境包/凭证已经是登录态，不需要再登录也不需要重新导出，
 * 但必须立刻解除本机持有的占用，中心库才会通过 WSS 把队首的下一台唤醒（第 3、4、5 台依次接力）。
 */
async function releaseLeaseAfterLoggedIn(accountId, connection, batchId) {
  const pid = String(connection?.account?.browser_profile_id || '').trim();
  if (!pid) return;
  try {
    const sync = require('./browser/env-pack-sync');
    if (!connection?.provider || !sync.supportsPackSync(connection.provider)) return;
    await sync.releasePackLeaseBestEffort(pid);
    const next = String(sync.getLastReleaseSignal(pid)?.nextHostId || '').trim();
    publishEvent('pack-lease-released', {
      accountId, profileId: pid, pushed: false, batch: true, relay: true, nextHostId: next || undefined,
    });
    liveLog(
      `账号 #${accountId}：已用服务器上的环境包/凭证登录，立即解除占用${next ? `，已通过 WSS 通知队首等待设备 ${next}` : ''}；窗口保持打开`,
      'info',
      { accountId, batchId, profileId: pid },
    );
  } catch (e) {
    liveLog(`账号 #${accountId}：解除占用失败：${e.message || e}`, 'warn', { accountId, batchId });
  }
}

/**
 * 总任务执行前必须确认「真的登录着」。
 * 桌面自研：未登录则同窗一键登录。
 * 服务器浏览器（linux）：只用环境包/中心库会话同步，禁止密码/2FA；失败则 WAITING_LOGIN_DATA 软等待。
 * options.connection：复用已打开的环境；options.browserBackend：当前后端。
 */
async function ensureAccountLogin(account, probedSession = null, options = {}) {
  const accountId = Number(account?.id || 0);
  if (!accountId) return null;
  const batchId = Number(getSession()?.batchId || 0);
  const connection = options.connection || null;
  const backend = normalizeBackendId(options.browserBackend || options.backend || '');
  const isServerBrowser = backend === 'linux';
  let session = probedSession || null;
  if (!session) {
    liveLog(`账号 #${accountId}：没有探测到页面登录态（页面未就绪），按未知处理`, 'warn', { accountId, batchId });
  }

  liveLog(
    `账号 #${accountId}：登录态 ${session ? (session.loggedIn ? '已登录' : '未登录') : '未知'}（${describeLoginEvidence(session)}）`,
    'info',
    { accountId, batchId, topRight: session?.topRight || null, api: session?.apiProbe || null }
  );

  if (session?.loggedIn) {
    await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
    if (connection?.context) {
      await persistAccountSessionLog(accountId, connection.context, connection.page).catch(() => {});
    }
    await releaseLeaseAfterLoggedIn(accountId, connection, batchId);
    liveLog(`账号 #${accountId}：已登录，接着执行分任务`, 'info', { accountId, batchId });
    return session;
  }

  // 服务器浏览器：仅尝试注入中心库已同步的 Cookie/Storage，禁止一键密码登录
  if (isServerBrowser) {
    liveLog(
      `账号 #${accountId}：服务器浏览器未登录，尝试用本地/中心库同步的登录数据注入（不走密码登录）`,
      'warn',
      { accountId, batchId }
    );
    let saved = null;
    try {
      saved = await dataStore.getSession(accountId);
    } catch (e) {
      liveLog(`账号 #${accountId}：读取会话失败：${e.message || e}`, 'warn', { accountId, batchId });
    }
    if (saved?.cookie && connection?.context) {
      const applied = await applySavedSessionToContext(connection.context, connection.page, saved).catch(() => false);
      if (applied && connection.page) {
        await connection.page.goto('https://www.tiktok.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        }).catch(() => {});
        await connection.page.waitForTimeout?.(1200).catch(() => {});
        try {
          session = await probeSessionAndClean(
            connection.ws,
            connection.page,
            accountId,
            batchId,
            connection.context
          );
        } catch (probeErr) {
          liveLog(`账号 #${accountId}：注入会话后探测失败：${probeErr.message}`, 'warn', { accountId, batchId });
        }
      }
    }
    if (session?.loggedIn) {
      await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
      if (connection?.context) {
        await persistAccountSessionLog(accountId, connection.context, connection.page).catch(() => {});
      }
      await releaseLeaseAfterLoggedIn(accountId, connection, batchId);
      liveLog(`账号 #${accountId}：已用同步登录数据恢复会话，继续执行`, 'info', { accountId, batchId });
      return session;
    }
    await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
    // 登录数据不可用也要释放打开环境时占的租约，否则排队设备要等到租约过期
    await releaseLeaseAfterLoggedIn(accountId, connection, batchId);
    throw waitingLoginDataError(accountId, '请先在桌面自研浏览器登录并上传环境包/会话');
  }

  // 桌面自研：未登录 → 同窗一键登录（禁止登录流程里关窗推包，否则会杀掉本批 CDP / 把空包盖掉中心库）
  liveLog(
    session
      ? `账号 #${accountId}：未登录，在同一环境内执行一键登录（不关窗重开）`
      : `账号 #${accountId}：登录态未知，在同一环境内执行一键登录确认（不关窗重开）`,
    'warn',
    { accountId, batchId }
  );
  let login = null;
  try {
    login = await fullLogin(accountId, {
      connection: connection || undefined,
      reuseOpen: Boolean(connection),
      forceRelaunch: false,
      skipEnvPackPush: true,
    });
  } catch (error) {
    await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
    const err = new Error(`账号未登录，一键登录失败：${error.message || error}`);
    err.nonRetryable = true;
    throw err;
  }
  const okLogin = Boolean(login?.loginOk || login?.alreadyLoggedIn || login?.loginStatus === 'online');
  if (!okLogin) {
    await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
    const err = new Error(
      `账号未登录，一键登录未完成：${login?.message || '请先在「账号管理」点登录完成验证（可能需要滑块 / 2FA）'}`
    );
    err.nonRetryable = true;
    throw err;
  }

  // 再探一次活页：避免「loginOk=true 但窗口其实已被关 / Cookie 已丢」后还去跑养号
  if (connection?.page && !connection.page.isClosed?.()) {
    try {
      const recheck = await probeSessionAndClean(
        connection.ws,
        connection.page,
        accountId,
        batchId,
        connection.context
      );
      if (recheck && recheck.loggedIn === false) {
        await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
        const err = new Error(
          `账号未登录，一键登录回报成功但复检失败（${describeLoginEvidence(recheck)}）`
        );
        err.nonRetryable = true;
        throw err;
      }
      if (recheck?.loggedIn && connection.context) {
        await persistAccountSessionLog(accountId, connection.context, connection.page).catch(() => {});
      }
    } catch (e) {
      if (e?.nonRetryable) throw e;
      liveLog(`账号 #${accountId}：登录后复检异常：${e.message || e}`, 'warn', { accountId, batchId });
    }
  } else if (connection) {
    await dataStore.updateLoginStatus(accountId, 'offline').catch(() => {});
    const err = new Error('账号未登录：一键登录后任务窗口已关闭（疑似被环境包上传关窗），请重试');
    err.nonRetryable = true;
    throw err;
  }

  await dataStore.updateLoginStatus(accountId, 'online').catch(() => {});
  // 执行过登录就要立即上传环境包+凭证并解除占用，不再等到总任务结束
  if (connection) {
    await uploadPackAfterBatchLogin(accountId, connection, batchId);
  }
  liveLog(`账号 #${accountId}：一键登录完成，继续执行分任务`, 'info', { accountId, batchId });
  return login;
}

async function executeWorkItem(item) {
  const type = item.task_type;
  const accountId = Number(item.account_id);
  const payload = item.payload || {};
  const taskId = Number(item.task_ref_id || 0);
  const batchId = Number(item.batch_id || getSession()?.batchId || 0);
  const itemId = Number(item.id || 0);
  const logCtx = { accountId, batchId, itemId, taskId };
  // 养号 / 拓客 / 增粉 / 回评 / 拉取数据 / 拉取视频列表 / 修改资料：省流默认开；其余默认关
  const saveTrafficDefaultOn = ['warm', 'ai_lead', 'ai_lead_dm', 'auto_follow', 'comment_reply', 'pull_stats', 'pull_video_list', 'modify_profile', 'profile'].includes(type);
  const saveTraffic = await syncSaveTrafficFromPayload(payload, saveTrafficDefaultOn);
  // 服务器浏览器只有 AI 拓客 / 客服坐席能用：其他类型即使 payload 里写了 linux 也拒绝执行
  if (normalizeBackendId(payload.browserBackend || payload.browser_backend) === 'linux'
    && !isServerBrowserTaskType(type)) {
    throw serverBrowserForbiddenError(type);
  }

  if (type === 'modify_profile') {
    const { modifyTikTokProfile } = require('./browser/tiktok-actions');
    // 早期版本会把「与系统一致」的昵称丢成空串，导致老分任务的 payload 根本没有昵称，
    // 执行时就只改了头像/签名。这里做兜底：payload 没带昵称时回退用账号的系统昵称。
    let nickname = String(payload.nickname || payload.displayName || '').trim();
    const originalNickname = String(payload.originalNickname ?? payload.original_nickname ?? '').trim();
    const skipNickname = payload.skipNickname === true || payload.skip_nickname === true;
    if (skipNickname) {
      nickname = '';
      liveLog('改资料：昵称仍在 7 天冷却内，本次不提交昵称', 'info', logCtx);
    } else if (!nickname) {
      const acc = await phpApi.get(`/accounts/${accountId}`).catch(() => null);
      const systemNick = String(acc?.nickname || '').trim();
      if (systemNick) {
        nickname = systemNick;
        liveLog(`改资料：分任务未带昵称，回退使用账号昵称「${systemNick}」`, 'warn', logCtx);
      } else {
        liveLog('改资料：分任务未带昵称，账号也没有设置昵称，本次不改昵称', 'info', logCtx);
      }
    }
    const result = await modifyTikTokProfile(accountId, {
      username: payload.username || payload.handle || '',
      originalUsername: payload.originalUsername || payload.original_username || '',
      nickname,
      originalNickname,
      signature: payload.signature || payload.bio || '',
      avatarPath: payload.avatarPath || payload.avatar_path || '',
      avatarUrl: payload.avatarUrl || payload.avatar_url || '',
      saveTraffic,
      // 让浏览器侧每一步都落到该分任务的日志里（任务汇总 → 查看日志）
      logContext: logCtx,
    });
    if (result?.status && result.status !== 'ok') {
      return {
        status: 'failed',
        result,
        errorMessage: result.error || 'modify profile failed',
      };
    }
    return { status: 'completed', result };
  }

  if (type === 'publish') {
    const isTest = isManualTest();
    if (!isTest) {
      await assertPublishGate(accountId, payload.pushChannel || 'bit');
    } else {
      // Manual test: ignore PHP login_status/CK; Bit page session is checked in preparePublish.
      const gate = await loadGate(accountId);
      if (!gate.ok) throw new Error(gate.reason);
      if (gate.account?.account_status === 'banned') throw new Error('account banned, cannot publish');
    }
    const materialId = Number(payload.materialId || payload.material_id || 0);
    if (!materialId) throw new Error('publish item missing materialId');
    console.log('[publish] start', { accountId, materialId, isTest, manualConfirm: !!payload.manualConfirm });
    liveLog(
      `账号 #${accountId}：开始发布素材 #${materialId}${isTest ? '（测试）' : ''}`,
      'info',
      { accountId, batchId, itemId, materialId }
    );
    const result = await preparePublish(
      accountId,
      materialId,
      payload.publishTitle || payload.publish_title || payload.shareTitle || payload.share_title || payload.title || '',
      payload.publishCaption || payload.publish_caption || payload.shareCaption || payload.share_caption || payload.caption || '',
      {
        autoPublish: !payload.manualConfirm,
        // 测试态 keepOpen：方便人工核对描述/标签是否写入
        keepOpen: isTest,
        deleteAfterPublish: !!payload.deleteAfterPublish,
        hashtags: payload.hashtags || payload.tags || '',
        saveTraffic,
      }
    );
    console.log('[publish] prepare result', {
      accountId,
      materialId,
      status: result?.status,
      videoId: result?.videoId || '',
    });
    if (result?.status === 'security_paused' || result?.status === 'manual_required') {
      liveLog(
        `发布遇验证（${result.status}）素材 #${materialId}：挂起等待人工，未标记已发布`,
        'warn',
        { accountId, materialId, batchId, itemId }
      );
      return {
        status: result.status,
        result,
        errorMessage: result.reason || result.status,
        manualRequired: true,
      };
    }
    if (result?.status !== 'published') {
      throw new Error(result?.error || `publish incomplete: ${result?.status}`);
    }
    // preparePublish ?????? mark-published
    return {
      status: 'completed',
      result: {
        ...(result && typeof result === 'object' ? result : {}),
        materialId,
        accountId,
        deleteAfterPublish: !!payload.deleteAfterPublish,
        videoId: result?.videoId || '',
        videoUrl: result?.videoUrl || '',
      },
    };
  }

  if (type === 'cs_login') {
    const { runCsLogin } = require('./browser/seat-tasks');
    return runCsLogin(accountId, payload);
  }
  if (type === 'cs_detect') {
    const { runCsDetect } = require('./browser/seat-tasks');
    return runCsDetect(accountId, payload);
  }
  if (type === 'cs_logout') {
    const { runCsLogout } = require('./browser/seat-tasks');
    return runCsLogout(accountId, payload);
  }

  if (type === 'message' || type === 'dm_reply') {
    const seatSend = String(payload.source || '') === 'chat.seat' || payload.autoSend === true;
    const result = await prepareMessage(
      accountId,
      payload.content || payload.publishCaption || payload.reply || '',
      payload.recipient || payload.toUser || '',
      {
        saveTraffic,
        browserBackend: payload.browserBackend || payload.browser_backend || (seatSend ? 'linux' : undefined),
        autoSend: seatSend || payload.autoSend === true,
      }
    );
    if (result?.status === 'security_paused' || result?.status === 'manual_required') {
      return {
        status: result.status,
        result,
        errorMessage: result.reason || result.status,
        manualRequired: true,
      };
    }
    if (result?.status === 'failed') {
      return { status: 'failed', result, errorMessage: result.error || '私信发送失败' };
    }
    // 坐席发送成功后回写本地会话
    if (seatSend && payload.friendId) {
      try {
        await phpApi.post('/node/chat/bit-send-result', {
          friendId: Number(payload.friendId),
          accountId,
          content: payload.content || '',
          translated: payload.translated || '',
          status: 'sent',
        });
      } catch (e) {
        liveLog(`账号 #${accountId}：坐席发信回写本地失败：${e.message || e}`, 'warn', logCtx);
      }
    }
    return { status: 'completed', result };
  }

  if (type === 'dm_sync') {
    const { syncAccountDm } = require('./browser/tiktok-dm-sync');
    const result = await syncAccountDm(accountId, {
      ...payload,
      browserBackend: payload.browserBackend || payload.browser_backend || 'linux',
    });
    return { status: 'completed', result };
  }

  if (type === 'warm') {
    const { runWarmAccount } = require('./browser/tiktok-warm');
    liveLog(
      `账号 #${accountId}：养号开始（计划视频=${Number(payload?.executionPlan?.videoTotal || 0) || '自动'}）`,
      'info',
      { accountId, itemId: item.id, taskId }
    );
    const result = await runWarmAccount(accountId, payload, { keepOpen: true });
    if (result?.status === 'security_paused' || result?.manualRequired) {
      liveLog(
        `账号 #${accountId}：养号遇人机验证，已挂起等待人工`,
        'warn',
        { accountId, itemId: item.id, taskId }
      );
      return {
        status: 'security_paused',
        result,
        errorMessage: result.reason || '需要人工验证',
        manualRequired: true,
      };
    }
    liveLog(
      `账号 #${accountId}：养号完成 浏览=${result?.browsed || 0} 点赞=${result?.liked || 0} 评论=${result?.commented || 0}`,
      'info',
      { accountId, itemId: item.id, taskId }
    );
    return { status: 'completed', result };
  }

  if (type === 'ai_lead') {
    const { runAiLead } = require('./browser/ai-lead');
    liveLog(
      `账号 #${accountId}：AI拓客开始 lead#${Number(payload?.leadId || taskId || 0)} 类型=${payload?.type || 'user'}`,
      'info',
      { accountId, itemId: item.id, taskId }
    );
    const result = await runAiLead(accountId, payload);
    const cancelled = result?.status === 'cancelled' || result?.aborted;
    liveLog(
      `账号 #${accountId}：AI拓客${cancelled ? '已取消' : '完成'} 创作者=${result?.creators || 0} 线索=${result?.leads || 0}`,
      cancelled ? 'warn' : 'info',
      { accountId, itemId: item.id, taskId }
    );
    if (cancelled) {
      return {
        status: 'cancelled',
        aborted: true,
        result,
        errorMessage: result?.error || '任务已暂停',
      };
    }
    return { status: 'completed', result };
  }

  if (type === 'ai_lead_dm') {
    const { runDmTest, runDmDispatch } = require('./browser/ai-lead/dm-phase');
    const leadId = Number(payload?.leadId || taskId || 0);
    const isDispatch = payload?.mode === 'dispatch' || payload?.dispatch === true;
    liveLog(
      `账号 #${accountId}：AI拓客私信${isDispatch ? '推送' : '测试'} lead#${leadId}`
      + (payload?.username ? ` @${String(payload.username).replace(/^@+/, '')}` : '')
      + (payload?.forceTarget?.username ? ` @${String(payload.forceTarget.username).replace(/^@+/, '')}` : ''),
      'info',
      { accountId, itemId: item.id, taskId: leadId }
    );
    const result = isDispatch
      ? await runDmDispatch(accountId, { ...payload, leadId })
      : await runDmTest(accountId, { ...payload, leadId });
    if (result?.status === 'security_paused' || result?.status === 'manual_required' || result?.manualRequired) {
      return {
        status: result.status || 'security_paused',
        result,
        errorMessage: result.reason || result.lastError || '需要人工验证',
        manualRequired: true,
      };
    }
    const sent = Number(result?.dmsSent || 0);
    const failed = Number(result?.dmsFailed || 0);
    const skipped = Number(result?.dmsSkipped || 0);
    liveLog(
      `账号 #${accountId}：AI拓客私信${isDispatch ? '推送' : '测试'}结束 sent=${sent} fail=${failed} skip=${skipped}`,
      failed > 0 && sent === 0 && !isDispatch ? 'error' : 'info',
      { accountId, itemId: item.id, taskId: leadId }
    );
    if (!isDispatch && failed > 0 && sent === 0) {
      throw new Error(result?.lastError || `私信测试失败 ${failed} 条`);
    }
    return { status: 'completed', result };
  }

  if (type === 'diagnose') {
    const { runAccountDiagnose } = require('./browser/tiktok-diagnose');
    liveLog(
      `账号 #${accountId}：诊断开始（主页 → Studio → 账号检测）`,
      'info',
      { accountId, itemId: item.id, source: payload.source || 'manual' }
    );
    const result = await runAccountDiagnose(accountId, {
      source: payload.source || 'manual',
    });
    if (result?.status && result.status !== 'ok') {
      throw new Error(result.error || 'diagnose failed');
    }
    return { status: 'completed', result };
  }

  if (type === 'pull_stats' || type === 'profile') {
    const { pullStudioStats } = require('./browser/tiktok-studio-stats');
    const result = await pullStudioStats(accountId, { ...(payload || {}), logContext: logCtx });
    if (result?.status && result.status !== 'ok') {
      throw new Error(result.error || result.message || 'pull stats failed');
    }
    liveLog(`拉数据#${accountId}：${result?.message || '完成'}`, 'info', logCtx);
    return { status: 'completed', result };
  }

  if (type === 'pull_video_list') {
    const { pullOnlineVideoList } = require('./browser/pull-online-video-list');
    liveLog(`账号 #${accountId}：拉取视频列表开始`, 'info', logCtx);
    const result = await pullOnlineVideoList(accountId, { ...(payload || {}), logContext: logCtx });
    if (result?.status && result.status !== 'ok') {
      throw new Error(result.error || result.message || '拉取视频列表失败');
    }
    liveLog(`账号 #${accountId}：${result?.message || '拉取视频列表完成'}`, 'info', logCtx);
    return { status: 'completed', result };
  }

  if (type === 'sync') {
    let result = await syncVideos(accountId);
    return { status: 'completed', result };
  }

  if (type === 'delete_video') {
    const { batchDeleteTikTokVideos, deleteTikTokVideo } = require('./browser/tiktok-actions');
    const items = Array.isArray(payload.items) ? payload.items : [];
    const videoIds = Array.isArray(payload.videoIds)
      ? payload.videoIds
      : (payload.videoId ? [payload.videoId] : items.map((x) => x.videoId || x.video_id).filter(Boolean));
    let result;
    if (videoIds.length === 0 && (payload.keepLatest != null || payload.keep_latest != null)) {
      result = await batchDeleteTikTokVideos([accountId], {
        keepLatest: payload.keepLatest ?? payload.keep_latest,
        threads: 1,
      });
    } else if (videoIds.length > 1 || items.length > 1) {
      const out = [];
      const list = items.length
        ? items
        : videoIds.map((videoId) => ({ videoId, videoUrl: payload.videoUrl || payload.video_url || '' }));
      for (const it of list) {
        out.push(await deleteTikTokVideo(accountId, {
          videoId: it.videoId || it.video_id || '',
          videoUrl: it.videoUrl || it.video_url || '',
          materialId: it.materialId || it.material_id || 0,
          materialName: it.materialName || it.material_name || '',
          shareTitle: it.shareTitle || it.share_title || '',
          publishTitle: it.publishTitle || it.publish_title || '',
          description: it.description || '',
          searchTitle: it.searchTitle || it.publishTitle || it.shareTitle || it.materialName || '',
        }));
      }
      result = { items: out, deleted: out.filter((x) => x.status === 'ok').length };
    } else {
      const one = items[0] || {};
      result = await deleteTikTokVideo(accountId, {
        videoId: videoIds[0] || one.videoId || one.video_id || '',
        videoUrl: payload.videoUrl || payload.video_url || one.videoUrl || '',
        materialId: payload.materialId || one.materialId || one.material_id || 0,
        materialName: payload.materialName || one.materialName || one.material_name || '',
        shareTitle: payload.shareTitle || one.shareTitle || one.share_title || '',
        publishTitle: payload.publishTitle || one.publishTitle || one.publish_title || '',
        description: payload.description || one.description || '',
        searchTitle: payload.searchTitle || one.searchTitle || payload.publishTitle || one.publishTitle || payload.shareTitle || one.shareTitle || payload.materialName || one.materialName || '',
      });
      if (result?.status && result.status !== 'ok') {
        throw new Error(result.error || 'delete video failed');
      }
    }
    return { status: 'completed', result };
  }

  if (type === 'comment_reply') {
    const { runCommentReply } = require('./browser/tiktok-comment-reply');
    liveLog(
      `账号 #${accountId}：评论回复开始（最多=${Number(payload.maxReplies || payload.max_replies || 10)}，模式=${payload.replyMode || payload.commentMode || 'fixed'}）`,
      'info',
      logCtx
    );
    const result = await runCommentReply(accountId, payload || {});
    liveLog(
      `账号 #${accountId}：评论回复完成 已回=${result?.replied || 0} 视频=${result?.videosVisited || 0}`,
      'info',
      logCtx
    );
    if (result?.status && result.status !== 'ok' && result.status !== 'completed') {
      throw new Error(result.error || 'comment reply failed');
    }
    return { status: 'completed', result };
  }

  if (type === 'pull_comments') {
    const { runPullComments } = require('./browser/tiktok-pull-comments');
    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    liveLog(
      `账号 #${accountId}：拉取评论开始（视频=${videos.length}，任务=#${payload.pullTaskId || payload.pull_task_id || taskId || 0}）`,
      'info',
      logCtx
    );
    const result = await runPullComments(accountId, {
      ...payload,
      pullTaskId: Number(payload.pullTaskId || payload.pull_task_id || taskId || 0),
    });
    const okResults = (result?.results || []).filter((r) => r?.status === 'ok');
    const totalViews = okResults.reduce((n, r) => n + (Number(r.views) || 0), 0);
    const totalLikes = okResults.reduce((n, r) => n + (Number(r.likes) || 0), 0);
    liveLog(
      `账号 #${accountId}：拉取视频数据完成 视频=${okResults.length} 播放=${totalViews} 赞=${totalLikes} 评论=${result?.comments || 0} 失败=${result?.failed || 0}`,
      'info',
      logCtx
    );
    if (result?.status && result.status !== 'ok' && result.status !== 'completed') {
      throw new Error(result.error || '拉取视频数据失败');
    }
    return { status: 'completed', result };
  }

  if (type === 'auto_follow') {
    const { runAutoFollow } = require('./browser/tiktok-auto-follow');
    liveLog(
      `账号 #${accountId}：自动关注开始（分项=#${payload.itemId || payload.item_id || 0}，任务=#${payload.taskId || taskId || 0}）`,
      'info',
      logCtx
    );
    const result = await runAutoFollow(accountId, {
      ...payload,
      taskId: Number(payload.taskId || payload.task_id || taskId || 0),
      itemId: Number(payload.itemId || payload.item_id || 0),
    });
    liveLog(
      `账号 #${accountId}：自动关注完成 状态=${result?.status || ''} 已关注=${!!result?.alreadyFollowed}`,
      'info',
      logCtx
    );
    if (result?.status && result.status !== 'ok' && result.status !== 'completed') {
      throw new Error(result.error || 'auto follow failed');
    }
    return { status: 'completed', result };
  }

  if (type === 'sync_fans') {
    const { runSyncFans } = require('./browser/seat-tasks');
    return runSyncFans(accountId, {
      ...payload,
      browserBackend: payload.browserBackend || payload.browser_backend || 'linux',
    });
  }

  if (type === 'env_pack_upload') {
    const { healPushOrRegenerate } = require('./browser/env-pack-sync');
    const profileId = String(payload.profileId || payload.profile_id || '').trim();
    if (!profileId) throw new Error('env_pack_upload 缺少 profileId');
    // 缺包补齐走桌面自研（与 linux 共用包）；勿强制 linux 以免被服务器浏览器白名单拦住
    let backend = normalizeBackendId(payload.browserBackend || payload.browser_backend) || 'tkswarm';
    if (backend === 'linux') backend = 'tkswarm';
    if (backend === 'bit') {
      throw Object.assign(new Error('比特环境不支持中心库环境包补齐'), { nonRetryable: true });
    }
    const provider = getProvider(backend);
    liveLog(
      `账号 #${accountId}：环境包补齐开始 ${profileId.slice(0, 8)}…（静默，不打开页面）`,
      'info',
      logCtx
    );
    const result = await healPushOrRegenerate(profileId, {
      accountId,
      provider,
      backend,
    });
    if (!result?.ok) {
      throw new Error(result?.reason || '环境包补齐失败');
    }
    liveLog(
      `账号 #${accountId}：环境包补齐完成 source=${result.source || ''} id=${String(result.profileId || '').slice(0, 8)}…`,
      'info',
      logCtx
    );
    return { status: 'completed', result };
  }

  throw new Error(`unsupported work item type: ${type}${taskId ? ` (task#${taskId})` : ''}`);
}

async function waitForAiLeadEnv(batch, maxWaitMs = 1800000) {
  const batchId = Number(batch?.id || 0);
  if (!batchId) return batch;
  if (!batch?.env_pending && batch?.wait_reason !== 'general_running' && batch?.wait_reason !== 'env_busy') {
    return batch;
  }
  const start = Date.now();
  liveLog(`AI拓客 总任务#${batchId} 等待浏览器环境空闲（不抢占常规任务）…`, 'info', { batchId });
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const fresh = await phpApi.post('/node/work-batches/claim-one', {
        batchId,
        workerId: WORKER_ID,
        leaseSeconds: 300,
      });
      if (fresh && !fresh.env_pending && fresh.browser_profile_id) {
        liveLog(`AI拓客 总任务#${batchId} 环境已就绪`, 'info', { batchId });
        return fresh;
      }
    } catch {
      /* retry */
    }
  }
  throw new Error('等待浏览器环境超时（常规任务可能仍在占用，请稍后再试）');
}

/** 总任务待办是否全是环境包补齐（无需开 TikTok / 登录） */
function isEnvPackHealOnlyBatch(batch) {
  const items = Array.isArray(batch?.items) ? batch.items : [];
  if (!items.length) return false;
  return items.every((it) => String(it?.task_type || it?.taskType || '').trim() === 'env_pack_upload');
}

/** 静默补齐路径：不 connect / 不登录，仅 export/upload 或重建后上传 */
async function executeEnvPackHealOnlyBatch(batch) {
  const batchId = Number(batch.id);
  const account = batch.account || {};
  const accountId = Number(batch.account_id || account.id);
  let success = 0;
  let fail = 0;
  const heartbeatTimer = setInterval(() => {
    phpApi.post(`/node/work-batches/${batchId}/heartbeat`, {
      workerId: WORKER_ID,
      leaseSeconds: 300,
    }).catch(() => {});
  }, 60000);
  heartbeatTimer.unref?.();

  liveLog(
    `总任务 #${batchId} 账号#${accountId}：环境包补齐（静默，不开页）`,
    'info',
    { accountId, batchId }
  );

  try {
    try {
      await phpApi.post(`/node/work-batches/${batchId}/mark-executing`, { workerId: WORKER_ID });
    } catch { /* ignore */ }

    for (;;) {
      const item = await phpApi.post(`/node/work-batches/${batchId}/claim-item`, {
        workerId: WORKER_ID,
      });
      if (!item || !item.id) break;
      if (String(item.task_type || '') !== 'env_pack_upload') {
        // 混入其它类型：退回失败提示，避免静默路径误跑业务任务
        await phpApi.post(`/node/work-batches/${batchId}/items/${item.id}/result`, {
          workerId: WORKER_ID,
          status: 'failed',
          result: {},
          errorMessage: '静默补齐批次中出现非 env_pack_upload 分任务',
        }).catch(() => {});
        fail += 1;
        break;
      }
      try {
        const out = await executeWorkItem(item);
        const st = out.status || 'completed';
        await phpApi.post(`/node/work-batches/${batchId}/items/${item.id}/result`, {
          workerId: WORKER_ID,
          status: st === 'cancelled' ? 'failed' : st,
          result: out.result || out || {},
          errorMessage: out.errorMessage || '',
        });
        if (st === 'completed') success += 1;
        else fail += 1;
      } catch (error) {
        fail += 1;
        await phpApi.post(`/node/work-batches/${batchId}/items/${item.id}/result`, {
          workerId: WORKER_ID,
          status: 'failed',
          result: {},
          errorMessage: error.message || String(error),
        }).catch(() => {});
        liveLog(`环境包补齐失败：${error.message}`, 'error', { accountId, batchId, itemId: item.id });
      }
    }

    await phpApi.post(`/node/work-batches/${batchId}/finish`, {
      workerId: WORKER_ID,
      status: fail > 0 && success < 1 ? 'failed' : 'completed',
    }).catch(() => {});
    liveLog(
      `总任务 #${batchId} 环境包补齐结束 成功=${success} 失败=${fail}`,
      fail > 0 ? 'warn' : 'info',
      { accountId, batchId }
    );
    return { batchId, success, fail, silent: true };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function executeWorkBatch(batch) {
  const batchId = Number(batch.id);
  if (batch?.env_pending || batch?.wait_reason === 'general_running' || batch?.wait_reason === 'env_busy') {
    batch = await waitForAiLeadEnv(batch);
  }

  // 仅缺包补齐：跳过开窗与 TikTok 登录
  if (isEnvPackHealOnlyBatch(batch)) {
    return executeEnvPackHealOnlyBatch(batch);
  }

  const account = batch.account || {};
  const accountId = Number(batch.account_id || account.id);
  // claim 包常无 batch.payload，坐席/拓客后端写在分任务 payload 或 browser_backend
  const firstItemPayload = (Array.isArray(batch.items) && batch.items[0] && batch.items[0].payload)
    ? batch.items[0].payload
    : {};
  const backend = taskBrowserBackend(batch.payload || firstItemPayload, account)
    || normalizeBackendId(batch.browser_backend)
    || (String(batch.batch_scope || '') === 'cs_seat' ? 'linux' : null)
    || null;
  let profileId = String(batch.browser_profile_id || '');
  if (backend === 'linux') {
    // 服务器浏览器：复用桌面自研同 ID 环境包；本机没有则拉包；拉不到则失败（不新建空环境）
    if (!isServerBrowserBatchScope(batch.batch_scope)) {
      throw serverBrowserForbiddenError(batch.batch_scope || 'general');
    }
    profileId = await ensureServerBrowserEnv(accountId);
    account.linux_browser_profile_id = profileId;
    try {
      const { setRunningProfile } = require('./queue');
      setRunningProfile(batchId, profileId);
    } catch { /* ignore */ }
    liveLog(
      `账号 #${accountId}：服务器浏览器环境已就绪 ${profileId.slice(0, 8)}…（拉包/复用）`,
      'info',
      { accountId, batchId, profileId }
    );
  } else if (!profileId) {
    profileId = resolveProfileIdForAccount(account, { browserBackend: backend || undefined });
  }
  if (profileId) account.browser_profile_id = profileId;

  // 全浏览器总任务：首启按批次类型默认省流（养号/拓客/增粉/回评开，其它关），分任务执行时再按 payload 切换
  const batchTypeHint = String(batch.batch_scope || batch.primary_type || batch.task_type || '').toLowerCase();
  const bootSaveTraffic = parseSaveTrafficFlag(
    batch.saveTraffic ?? batch.save_traffic,
    ['warm', 'ai_lead', 'auto_follow', 'comment_reply'].some((t) => batchTypeHint.includes(t))
  );

  return runWithBrowserBackend(backend, () => runWithSession({
    browserProfileId: profileId,
    batchId,
    accountId,
    keepBrowser: true,
    browserBackend: backend || undefined,
    saveTraffic: bootSaveTraffic,
  }, async () => {
    liveLog(
      `开始总任务 #${batchId} 账号#${accountId}（${account.username || ''}）环境 ${profileId ? `${profileId.slice(0, 8)}…` : '无'}${backend ? ` 后端=${backend}` : ''}（整批保持窗口不关，省流=${bootSaveTraffic ? '开' : '关'}）`,
      'info',
      { accountId, batchId, profileId, browserBackend: backend || undefined, saveTraffic: bootSaveTraffic }
    );

    let success = 0;
    let fail = 0;
    let emptyRounds = 0;
    /** 人机验证挂起：finally 不关窗，留给人工拖滑块 */
    let holdBrowserForHumanVerify = false;
    /** 本批是否确认过登录：未确认时结束不推包，避免用未登录状态覆盖中心库好包 */
    let batchLoginOk = false;
    const heartbeatTimer = setInterval(() => {
      phpApi.post(`/node/work-batches/${batchId}/heartbeat`, {
        workerId: WORKER_ID,
        leaseSeconds: 300,
      }).catch(() => {});
    }, 60000);
    heartbeatTimer.unref?.();

    try {
      if (!profileId) {
        throw new Error('账号尚未绑定自研浏览器环境');
      }

      const isCsSeatBatch = String(batch.batch_scope || '') === 'cs_seat';
      if (isCsSeatBatch) {
        // 坐席分任务自行开窗（登录/退出/发信/同步），此处不预登录，避免与 cs_login/cs_logout 冲突
        liveLog(
          `坐席总任务 #${batchId}：环境 ${profileId.slice(0, 8)}… 已就绪，分任务自行开窗执行`,
          'info',
          { accountId, batchId, profileId }
        );
      } else {
        liveLog(`打开环境 ${profileId.slice(0, 8)}…（整批保持同一窗口：登录检测→登录→任务）`, 'info', { accountId, batchId, profileId });
        // 一次打开环境：探测登录 → 未登录则同窗登录 → 同一 CDP 接着跑分任务（中间不断连）
        const boot = await connectAccount(accountId, 'https://www.tiktok.com/', 'warm', {
          browserProfileId: profileId,
          forceRelaunch: false,
          saveTraffic: bootSaveTraffic,
          browserBackend: backend || undefined,
        });
        let probedSession = null;
        try {
          probedSession = await probeSessionAndClean(boot.ws, boot.page, accountId, batchId, boot.context);
        } catch (probeErr) {
          liveLog(`账号 #${accountId}：登录态探测失败：${probeErr.message}`, 'warn', { accountId, batchId });
        }
        // 桌面：同窗一键登录；服务器浏览器：仅同步登录数据，失败软等待
        await ensureAccountLogin(account, probedSession, { connection: boot, browserBackend: backend });
        // 登录确认后保留 CDP，供发布等分任务直接复用（不要先断连再重连）
        try {
          const { setActiveConnection } = require('./session-context');
          setActiveConnection(boot);
        } catch { /* ignore */ }
        batchLoginOk = true;
        liveLog(`账号 #${accountId}：登录已确认，开始领取并执行分任务`, 'info', { accountId, batchId });
      }

      for (;;) {
        try {
          const { isAbortRequested } = require('./queue');
          if (isAbortRequested(batchId)) {
            throw Object.assign(new Error('任务已被强制关停'), { nonRetryable: true, aborted: true });
          }
        } catch (e) {
          if (e?.aborted || e?.nonRetryable) throw e;
        }
        let processed = 0;
        for (;;) {
          try {
            const { isAbortRequested } = require('./queue');
            if (isAbortRequested(batchId)) {
              throw Object.assign(new Error('任务已被强制关停'), { nonRetryable: true, aborted: true });
            }
          } catch (e) {
            if (e?.aborted || e?.nonRetryable) throw e;
          }
          const item = await phpApi.post(`/node/work-batches/${batchId}/claim-item`, {
            workerId: WORKER_ID,
          });
          if (!item || !item.id) break;
          processed += 1;
          emptyRounds = 0;

          liveLog(
            `总任务#${batchId} 分任务#${item.id} ${item.task_type}`,
            'info',
            { accountId, batchId, itemId: item.id }
          );

          try {
            const out = await executeWorkItem(item);
            if (isHumanVerifyResult(out)) {
              holdBrowserForHumanVerify = true;
              await reportHumanVerifyAndPause({
                accountId,
                batchId,
                itemId: item.id,
                taskType: item.task_type || '',
                result: out.result || out,
              });
              // 分任务已由 human-verify/report 置为 paused，勿再 finishItem
              liveLog(
                `总任务#${batchId} 分任务#${item.id} 因人机验证已暂停，等待人工确认后恢复（浏览器保持打开）`,
                'warn',
                { accountId, batchId, itemId: item.id }
              );
              break;
            }
            const st = out.status || 'completed';
            await phpApi.post(`/node/work-batches/${batchId}/items/${item.id}/result`, {
              workerId: WORKER_ID,
              status: st === 'cancelled' ? 'failed' : st,
              result: out.result || out || {},
              errorMessage: out.errorMessage || (st === 'cancelled' ? (out.error || '任务已暂停') : ''),
            });
            if (st === 'completed') success += 1;
            if (st === 'failed') fail += 1;
            if (st === 'cancelled' || out.aborted) {
              liveLog(
                `总任务#${batchId} 分任务#${item.id} 已取消（暂停）`,
                'warn',
                { accountId, batchId, itemId: item.id }
              );
              break;
            }
          } catch (error) {
            const msg = String(error?.message || error || '');
            if (/人机验证|滑块|拼图|captcha|security.?check|verify you.?re/i.test(msg)) {
              holdBrowserForHumanVerify = true;
              await reportHumanVerifyAndPause({
                accountId,
                batchId,
                itemId: item.id,
                taskType: item.task_type || '',
                result: { status: 'security_paused', reason: msg, manualRequired: true },
              });
              liveLog(
                `总任务#${batchId} 分任务#${item.id} 因人机验证已暂停（浏览器保持打开）：${msg}`,
                'warn',
                { accountId, batchId, itemId: item.id }
              );
              break;
            }
            fail += 1;
            await phpApi.post(`/node/work-batches/${batchId}/items/${item.id}/result`, {
              workerId: WORKER_ID,
              status: 'failed',
              errorMessage: error.message,
            }).catch(() => {});
            liveLog(
              `总任务#${batchId} 分任务#${item.id} 失败：${error.message}`,
              'error',
              { accountId, batchId, itemId: item.id }
            );
          }
        }

        let finished;
        try {
          finished = await phpApi.post(`/node/work-batches/${batchId}/finish`, {
            workerId: WORKER_ID,
          });
        } catch (finishErr) {
          liveLog(`总任务#${batchId} 收尾失败：${finishErr.message}，退回排队`, 'warn', { batchId });
          await releaseOfferedBatch(batchId, finishErr.message || 'finish failed');
          break;
        }

        if (finished?.status === 'paused' || finished?.status === 'cancelled') {
          liveLog(
            `总任务 #${batchId} ${finished.status === 'paused' ? '已暂停' : finished.status === 'cancelled' ? '已取消' : finished.status}：成功 ${success}，失败 ${fail}`,
            'info',
            { accountId, batchId }
          );
          break;
        }
        if (finished?.has_more) {
          if (processed === 0) {
            emptyRounds += 1;
            if (emptyRounds >= 3) {
              liveLog(`总任务#${batchId} 无法领取分任务，退回排队`, 'warn', { batchId });
              await releaseOfferedBatch(batchId, 'cannot claim items');
              break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }
        if (success === 0 && fail === 0) {
          liveLog(`总任务 #${batchId}：登录后未领到待执行分任务（可能已跑完或状态异常）`, 'warn', { accountId, batchId });
        }
        liveLog(
          `总任务 #${batchId} 完成：成功 ${success}，失败 ${fail}，状态 ${finished?.status || ''}`,
          'info',
          { accountId, batchId }
        );
        break;
      }
    } catch (error) {
      const code = String(error?.code || '');
      const waiting = error?.waiting === true
        || code === WAITING_ENV_PACK
        || code === WAITING_LOGIN_DATA
        || /WAITING_ENV_PACK|WAITING_LOGIN_DATA|缺环境包|登录数据无法同步/i.test(String(error?.message || ''));
      // 未登录软等待：保持窗口，方便 VNC 完成登录后再重试
      if (waiting && (
        code === WAITING_LOGIN_DATA
        || /登录数据无法同步|需已登录|打开登录页|VNC/i.test(String(error?.message || ''))
      )) {
        holdBrowserForHumanVerify = true;
      }
      liveLog(
        `总任务 #${batchId} ${waiting ? '等待重试' : '出错'}：${error.message}`,
        waiting ? 'warn' : 'error',
        { accountId, batchId, code: code || undefined }
      );
      const reason = error.message || 'execute error';
      if (waiting) {
        // 写入矩阵日志，服务器浏览器 /tasks「日志」能直接看到缺包等原因（不只 Node 实时日志）
        try {
          await phpApi.post('/node/work-logs', {
            batchId,
            accountId,
            level: 'warn',
            message: reason,
            meta: { code: code || 'WAITING', waiting: true },
          });
        } catch { /* ignore */ }
        await releaseOfferedBatch(batchId, reason).catch(() => {});
      } else if (error?.nonRetryable === true || isNonRetryableBrowserError(reason)) {
        await failOfferedBatch(batchId, reason).catch(() => {});
      } else {
        await releaseOfferedBatch(batchId, reason).catch(() => {});
      }
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      if (holdBrowserForHumanVerify) {
        liveLog(
          `总任务 #${batchId} 因人工验证/待登录挂起，浏览器窗口保持打开，请在 VNC 完成后重试或点「恢复」`,
          'warn',
          { accountId, batchId, profileId }
        );
      } else {
        let closePid = String(profileId || '').trim();
        try {
          const {
            getActiveConnection,
            clearActiveConnection,
            getSessionProfileId,
          } = require('./session-context');
          const live = getActiveConnection();
          // 拉包/代建后实际 ID 可能已变：关窗与回传必须用真实打开的环境
          closePid = String(
            live?.account?.browser_profile_id
            || getSessionProfileId()
            || profileId
            || '',
          ).trim();
          // 总任务结束：强制断 CDP 并关窗（分任务期间 keepBrowser 会保活连接）
          if (live) await closeConnection(live, { force: true }).catch(() => {});
          clearActiveConnection();
        } catch { /* ignore */ }
        if (closePid) {
          liveLog(`关闭浏览器环境 ${closePid.slice(0, 8)}…（总任务 #${batchId} 已结束）`, 'info', {
            accountId, batchId, profileId: closePid,
          });
          try {
            await closeSession(closePid, { accountId, pushPack: false });
          } catch {
            /* ignore */
          }
          try {
            await forceCloseBrowserProfile(closePid);
          } catch {
            /* ignore */
          }
          // 服务器 / 自研：关窗后回传环境包，供桌面与其它主机共用登录态
          if ((backend === 'linux' || backend === 'tkswarm') && !batchLoginOk) {
            // 本批没确认登录（坐席分任务自行上传 / 登录失败）：不推包，只释放占用让排队设备继续
            try { await require('./browser/env-pack-sync').releasePackLeaseBestEffort(closePid); } catch { /* ignore */ }
          } else if (backend === 'linux' || backend === 'tkswarm') {
            try {
              const { pushLocalEnvPack } = require('./browser/env-pack-sync');
              const { getProvider } = require('./browser/providers');
              await pushLocalEnvPack(closePid, {
                accountId,
                provider: getProvider(backend === 'linux' ? 'linux' : 'tkswarm'),
              });
            } catch {
              /* push 内部已 warn */
            }
          }
        }
      }
    }
  }));
}

/** Bit permission / missing env: releasing to queue only spams retries */
function isNonRetryableBrowserError(message) {
  const msg = String(message || '');
  // 缺包 / 登录数据等待：必须可重试
  if (/WAITING_ENV_PACK|WAITING_LOGIN_DATA|缺环境包|登录数据无法同步|等待本地/i.test(msg)) return false;
  if (/no Bit browser env|尚未绑定浏览器|尚未绑定自研浏览器|TikTok login/i.test(msg)) return true;
  // 未登录（一键登录也没成功）：重试只会反复失败，直接判定不可重试
  if (/账号未登录|一键登录失败|一键登录未完成/.test(msg)) return true;
  if (/forbidden|permission|not\s*allow|unauthorized/i.test(msg) && /bit|browser|env|profile|window/i.test(msg)) {
    return true;
  }
  // Chinese Bit errors from friendlyBitBusinessError (match by stable keywords)
  if (msg.includes('\u62d2\u7edd\u64cd\u4f5c') || msg.includes('\u65e0\u6743') || msg.includes('\u6743\u9650\u4e0d\u8db3')) {
    return true;
  }
  if (msg.includes('\u73af\u5883\u4e0d\u5b58\u5728') || msg.includes('\u5df2\u5220\u9664')) {
    return true;
  }
  if (msg.includes('\u6bd4\u7279\u6d4f\u89c8\u5668\u62d2\u7edd') || msg.includes('\u65e0\u6743\u6253\u5f00')) {
    return true;
  }
  return false;
}

async function releaseOfferedBatch(batchId, reason = 'frontend did not accept') {
  executorHub.clearOfferedEverywhere(batchId);
  const msg = String(reason || '').slice(0, 500);
  try {
    await phpApi.post(`/node/work-batches/${batchId}/release`, {
      workerId: WORKER_ID,
      reason: msg,
      errorMessage: msg,
    });
  } catch { /* ignore */ }
  liveLog(`总任务 #${batchId} 已退回排队：${msg || reason}`, 'warn', { batchId });
}

/** Permanent fail: mark remaining items failed and close batch (no requeue) */
async function failOfferedBatch(batchId, reason = 'non-retryable error') {
  executorHub.clearOfferedEverywhere(batchId);
  const msg = String(reason || 'execute failed').slice(0, 500);
  try {
    await phpApi.post(`/node/work-batches/${batchId}/finish`, {
      workerId: WORKER_ID,
      status: 'failed',
      errorMessage: msg,
    });
  } catch {
    // finish ??????????????????? release ???
    try {
      await phpApi.post(`/node/work-batches/${batchId}/force-fail`, {
        errorMessage: msg,
      });
    } catch (e2) {
      liveLog(`总任务 #${batchId} 强制失败也失败了：${e2.message}`, 'error', { batchId });
    }
  }
  liveLog(`总任务 #${batchId} 失败（不重试）：${msg}`, 'error', { batchId });
}

async function offerBatchToFrontend(batch, reasonTag = 'push') {
  if (!batch || !batch.id) return false;
  const id = Number(batch.id);
  if (pendingOffers.has(id) || runningLocal.has(id)) return false;

  const push = executorHub.pushWork(batch);
  if (!push?.ok) {
    const reason = push?.reason || 'no matching online executor';
    liveLog(`推送总任务 #${id} 失败：${reason}`, 'warn', {
      batchId: id,
      batchOwner: batch.owner_id,
      reason,
    });
    await releaseOfferedBatch(id, reason);
    return false;
  }

  pendingOffers.set(id, { batch, at: Date.now(), ownerId: Number(batch.owner_id || 0) });
  const taskLabel = String(batch.task_label || batch.taskLabel || '');
  const reasonZh = ({
    push: '推送',
    're-offer': '再次推送',
    'offer-one': '定点推送',
    reclaim: '回收重推',
    poll: '轮询推送',
  })[String(reasonTag || 'push')] || String(reasonTag || '推送');
  liveLog(
    `${reasonZh}总任务 #${id}${taskLabel ? ` [${taskLabel}]` : ''}（账号#${batch.account_id || batch.account?.id || ''} 归属#${batch.owner_id || '-'}）`,
    'info',
    { batchId: id, accountId: batch.account_id, ownerId: batch.owner_id, taskLabel }
  );
  executorHub.broadcastExecutorStatus({ lastPushedBatchId: id });
  return true;
}

function cleanupStaleOffers() {
  const now = Date.now();
  for (const [id, offer] of pendingOffers) {
    if (now - offer.at > OFFER_TTL_MS) {
      pendingOffers.delete(id);
      releaseOfferedBatch(id, 'offer TTL timeout');
    }
  }
}

async function acceptAndRunBatch(batch) {
  const batchId = Number(batch?.id || 0);
  if (!batchId) throw new Error('missing batchId');
  if (runningLocal.has(batchId)) {
    return { ok: true, batchId, already: true };
  }
  const offer = pendingOffers.get(batchId);
  const payload = offer?.batch || batch;
  pendingOffers.delete(batchId);

  const maxConc = await resolveMaxConcurrent();
  if (activeBatchCount >= maxConc) {
    await releaseOfferedBatch(batchId, `concurrent full (max ${maxConc})`);
    throw new Error(`concurrent full (max ${maxConc})`);
  }

  activeBatchCount += 1;
  runningLocal.add(batchId);
  try {
    await phpApi.post(`/node/work-batches/${batchId}/mark-executing`, {
      workerId: WORKER_ID,
    }).catch(() => {});
    await executeWorkBatch(payload);
    executorHub.notifyWorkDone(batchId, { status: 'completed' });
    return { ok: true, batchId };
  } catch (err) {
    executorHub.notifyWorkDone(batchId, { status: 'failed', error: err.message });
    throw err;
  } finally {
    runningLocal.delete(batchId);
    activeBatchCount = Math.max(0, activeBatchCount - 1);
    executorHub.clearOfferedEverywhere(batchId);
  }
}

/**
 * Claim by current logged-in owner; fill free browser slots (taskConcurrency, default 6).
 * 服务器浏览器（cs_seat/linux）由 server-browser-queue 独立队列执行（固定最多 3 路），不走此 WSS 路径。
 */
async function tick() {
  if (claiming) return;
  claiming = true;
  try {
    cleanupStaleOffers();

    await phpApi.post('/node/work-batches/reclaim', {
      workerId: WORKER_ID,
    }).catch(() => null);

    const clients = executorHub.listEnabledClients();
    if (!clients.length) return;

    const maxConc = await resolveMaxConcurrent();
    const freeSlots = () => maxConc - activeBatchCount - pendingOffers.size;

    // Only re-offer orphans with push_status=offered (executing excluded by PHP)
    if (freeSlots() > 0) {
      const reclaim = await phpApi.post('/node/work-batches/reclaim', {
        workerId: WORKER_ID,
      }).catch(() => null);
      const orphans = Array.isArray(reclaim?.claimed) ? reclaim.claimed : [];
      for (const batch of orphans) {
        if (freeSlots() <= 0) break;
        // 服务器浏览器孤儿交给独立队列，避免推给桌面前台空转
        if (isServerBrowserBatchScope(batch.batch_scope)) continue;
        const batchOwner = Number(batch.owner_id || 0);
        if (!batchOwner) {
          await releaseOfferedBatch(batch.id, 'owner missing');
          continue;
        }
        const hasClient = clients.some((c) => Number(c.ownerId) === batchOwner);
        if (!hasClient) continue;
        await offerBatchToFrontend(batch, 're-offer');
      }
    }

    for (const client of clients) {
      while (freeSlots() > 0) {
        const batch = await phpApi.runWithRequest(
          {
            headers: {
              authorization: client.token ? `Bearer ${client.token}` : '',
              'x-acting-as': client.actingAs || '',
            },
          },
          () => phpApi.post('/node/work-batches/claim', {
            workerId: WORKER_ID,
            leaseSeconds: 300,
            ownerId: client.ownerId,
          })
        ).catch((e) => {
          if (!/404|empty|no pending/i.test(e.message || '')) {
            console.error('[task-runner] claim', e.message);
          }
          return null;
        });

        if (!batch || !batch.id) break;
        // 误领到坐席/linux：退回，由 server-browser-queue 领取
        if (isServerBrowserBatchScope(batch.batch_scope)) {
          await releaseOfferedBatch(batch.id, '交给服务器浏览器队列');
          break;
        }

        const batchOwner = Number(batch.owner_id || 0);
        if (batchOwner > 0 && batchOwner !== Number(client.ownerId)) {
          await releaseOfferedBatch(batch.id, `owner mismatch (batch=${batchOwner}, client=${client.ownerId})`);
          break;
        }

        const ok = await offerBatchToFrontend(batch);
        if (!ok) break;
      }
    }
  } finally {
    claiming = false;
  }
}

/** linuxbrowse 内置执行器不跑桌面 WSS 领取；队列由 ./queue 单独启动 */
function startTaskRunner() {
  /* no-op */
}

function getExecutorStats() {
  return {
    maxConcurrent: _cachedMaxConcurrent || DEFAULT_MAX_CONCURRENT_BATCHES,
    activeBatchCount,
    pendingOffers: pendingOffers.size,
    onlineExecutors: executorHub.countEnabled(),
    workerId: WORKER_ID,
  };
}

async function loadBatchPack(batchId) {
  const pack = await phpApi.get(`/account-work-batches/${batchId}/items`);
  if (!pack?.batch) throw new Error(`batch #${batchId} not found`);
  return pack;
}

async function resolveProfileId(accountId, batch) {
  const fromBatch = String(batch?.browser_profile_id || '');
  if (fromBatch) return fromBatch;
  const bundle = await phpApi.get(`/node/accounts/${accountId}/bundle`).catch(() => null);
  const backend = taskBrowserBackend(batch?.payload || {}, {
    browser_backend: batch?.browser_backend || bundle?.browser_backend,
    tkswarm_browser_profile_id: bundle?.tkswarm_browser_profile_id,
    browser_profile_id: bundle?.browser_profile_id,
  });
  return resolveProfileIdForAccount(bundle || {}, { browserBackend: backend || undefined })
    || String(bundle?.browser_profile_id || '');
}

/**
 * 手动测试入口：先开环境并检测登录；未登录则同窗登录；成功后保活 CDP 给后续单元/总任务测试。
 * 失败才关环境；成功绝不关窗（等测试 finally 统一关闭）。
 */
async function ensureTestAccountReady(accountId, profileId, hint = {}) {
  const {
    setActiveConnection,
    clearActiveConnection,
    setSessionProfileId,
    getSessionProfileId,
  } = require('./session-context');
  const bundle = await phpApi.get(`/node/accounts/${accountId}/bundle`).catch(() => null);
  const testBackend = taskBrowserBackend(hint || {}, bundle || {})
    || normalizeBackendId(bundle?.browser_backend)
    || null;
  const account = {
    id: accountId,
    username: hint.username || bundle?.username || '',
    browser_profile_id: profileId || String(bundle?.browser_profile_id || ''),
    browser_backend: testBackend || bundle?.browser_backend || '',
    login_status: String(bundle?.login_status || 'offline'),
    has_session: Boolean(bundle?.has_session || bundle?.cookie),
  };
  if (!account.browser_profile_id) {
    account.browser_profile_id = resolveProfileIdForAccount(bundle || {}, {
      browserBackend: testBackend || undefined,
    }) || '';
  }
  if (!account.browser_profile_id) throw new Error('账号尚未绑定浏览器环境');

  let boot = null;
  try {
    liveLog(`测试 账号#${accountId}：打开环境并探测 TikTok 登录态（检测后不关窗）`, 'info', { accountId });
    boot = await connectAccount(accountId, 'https://www.tiktok.com/', 'warm', {
      browserProfileId: account.browser_profile_id,
      forceRelaunch: false,
      browserBackend: testBackend || undefined,
    });
    // 拉包/代建后实际 ID 可能已变，后续关窗/回传必须用真实打开的环境
    const openedPid = String(boot?.account?.browser_profile_id || account.browser_profile_id || '').trim();
    if (openedPid) {
      account.browser_profile_id = openedPid;
      setSessionProfileId(openedPid);
      if (openedPid !== String(profileId || '').trim()) {
        liveLog(
          `测试 账号#${accountId}：实际打开环境 ${openedPid.slice(0, 8)}…（批次绑定 ${String(profileId || '').slice(0, 8)}…）`,
          'info',
          { accountId, profileId: openedPid },
        );
      }
    }
    let probed = null;
    try {
      probed = await probeSessionAndClean(boot.ws, boot.page, accountId, 0, boot.context);
    } catch (probeErr) {
      liveLog(`测试 账号#${accountId}：登录态探测失败：${probeErr.message}`, 'warn', { accountId });
    }
    // 测试路径：按账号后端规则确认登录（linux 仅同步会话）；同窗禁止关窗推包
    await ensureAccountLogin(account, probed, { connection: boot, browserBackend: testBackend });
    account.login_status = 'online';
    account.has_session = true;
    setActiveConnection(boot);
    liveLog(`测试 账号#${accountId}：登录已确认，当前环境保持打开，开始执行测试任务`, 'info', { accountId });
    return account;
  } catch (err) {
    // 仅失败时关环境；成功路径必须留给后续测试分任务复用
    const failPid = String(
      boot?.account?.browser_profile_id
      || getSessionProfileId()
      || account.browser_profile_id
      || '',
    ).trim();
    if (boot) {
      await closeConnection(boot, { force: true }).catch(() => {});
      clearActiveConnection(boot);
    }
    if (failPid) {
      try { await closeSession(failPid, { accountId, pushPack: false }); } catch { /* ignore */ }
      try { await forceCloseBrowserProfile(failPid); } catch { /* ignore */ }
    }
    liveLog(`测试 账号#${accountId}：登录准备失败：${err.message}`, 'error', { accountId });
    throw err;
  }
}

/** 测试会话结束：强制断 CDP 并关闭浏览器环境（优先关实际打开的 ID，而非批次旧绑定） */
async function releaseTestSessionConnection(profileId = '') {
  const accountId = Number(getSession()?.accountId || 0) || 0;
  let pid = '';
  try {
    const { getActiveConnection, clearActiveConnection, getSessionProfileId } = require('./session-context');
    const live = getActiveConnection();
    pid = String(
      live?.account?.browser_profile_id
      || getSessionProfileId()
      || profileId
      || '',
    ).trim();
    if (live) {
      await closeConnection(live, { force: true }).catch(() => {});
    }
    clearActiveConnection();
  } catch { /* ignore */ }
  if (!pid) pid = String(profileId || '').trim();
  if (pid) {
    liveLog(`测试结束：关闭浏览器环境 ${pid.slice(0, 8)}…`, 'info', { profileId: pid, accountId });
    try { await closeSession(pid, { accountId, pushPack: true }); } catch { /* ignore */ }
    try { await forceCloseBrowserProfile(pid); } catch { /* ignore */ }
  }
}

/** Manual test: open Bit and run one item (no WSS claim). */
async function testRunItem({ batchId, itemId }) {
  const key = `item:${itemId}`;
  if (testingLocal.has(key) || testingLocal.has(`batch:${batchId}`)) {
    throw new Error('this task is already running a test');
  }
  testingLocal.add(key);
  try {
    const pack = await loadBatchPack(batchId);
    const item = (pack.items || []).find((x) => Number(x.id) === Number(itemId));
    if (!item) throw new Error(`item #${itemId} not found`);
    if (item.status === 'cancelled') throw new Error('cancelled item cannot be tested');

    const accountId = Number(item.account_id || pack.batch.account_id);
    const profileId = await resolveProfileId(accountId, pack.batch);
    if (!profileId) throw new Error('账号尚未绑定自研浏览器环境');

    liveLog(`测试分任务 #${itemId} ${item.task_type}（总任务 #${batchId}）：先检登录→同窗执行→结束后关环境`, 'info', {
      batchId, itemId, accountId,
    });

    return runWithSession({
      browserProfileId: profileId,
      batchId,
      accountId,
      test: true,
      keepBrowser: true,
    }, async () => {
      try {
        await ensureTestAccountReady(accountId, profileId, { username: pack.batch.username || '' });
        liveLog(`测试执行分任务 #${itemId} ${item.task_type}（复用当前已打开环境）`, 'info', {
          batchId, itemId, accountId,
        });
        const out = await executeWorkItem(item);
        const failed = (out.status || 'completed') === 'failed';
        const reason = out.errorMessage || out.result?.error || out.result?.message || '';
        liveLog(
          `测试分任务 #${itemId} 完成：${out.status || 'completed'}${failed && reason ? ` — ${reason}` : ''}`,
          failed ? 'error' : 'info',
          { batchId, itemId, accountId }
        );
        return {
          ok: true,
          batchId: Number(batchId),
          itemId: Number(itemId),
          taskType: item.task_type,
          status: out.status || 'completed',
          result: out.result || null,
          errorMessage: out.errorMessage || '',
        };
      } finally {
        await releaseTestSessionConnection(profileId);
      }
    });
  } finally {
    testingLocal.delete(key);
  }
}

/** Manual test: open Bit and run batch items in priority/seq order. */
async function testRunBatch({ batchId }) {
  const key = `batch:${batchId}`;
  if (testingLocal.has(key)) {
    throw new Error('this batch is already running a test');
  }
  testingLocal.add(key);
  try {
    const pack = await loadBatchPack(batchId);
    const batch = pack.batch;
    const items = (pack.items || [])
      .filter((x) => x.status !== 'cancelled' && x.status !== 'deleted')
      .slice()
      .sort((a, b) => {
        const p = Number(a.priority || 0) - Number(b.priority || 0);
        if (p !== 0) return p;
        const seq = Number(a.seq || 0) - Number(b.seq || 0);
        if (seq !== 0) return seq;
        return Number(a.id) - Number(b.id);
      });
    if (!items.length) throw new Error('batch has no testable items');

    const accountId = Number(batch.account_id);
    const profileId = await resolveProfileId(accountId, batch);
    if (!profileId) throw new Error('账号尚未绑定自研浏览器环境');

    liveLog(`测试总任务 #${batchId}，共 ${items.length} 个分任务：先检登录→同窗串行执行→结束后关环境`, 'info', {
      batchId, accountId,
    });

    return runWithSession({
      browserProfileId: profileId,
      batchId,
      accountId,
      test: true,
      keepBrowser: true,
    }, async () => {
      try {
        await ensureTestAccountReady(accountId, profileId, { username: batch.username || '' });
        const results = [];
        let success = 0;
        let fail = 0;
        for (const item of items) {
          liveLog(`测试执行分任务 #${item.id} ${item.task_type}（复用当前已打开环境）`, 'info', {
            batchId, itemId: item.id, accountId,
          });
          try {
            const out = await executeWorkItem(item);
            const status = out.status || 'completed';
            const reason = out.errorMessage || out.result?.error || out.result?.message || '';
            if (status === 'completed') success += 1;
            else if (status === 'failed') fail += 1;
            results.push({
              itemId: Number(item.id),
              taskType: item.task_type,
              status,
              errorMessage: reason,
            });
            if (status === 'failed') {
              liveLog(`测试执行分任务 #${item.id} 失败：${reason || '未返回失败原因'}`, 'error', {
                batchId, itemId: item.id, accountId,
              });
            }
          } catch (error) {
            fail += 1;
            results.push({
              itemId: Number(item.id),
              taskType: item.task_type,
              status: 'failed',
              errorMessage: error.message || 'failed',
            });
            liveLog(`测试分任务 #${item.id} 失败：${error.message}`, 'error', {
              batchId, itemId: item.id, accountId,
            });
          }
        }
        liveLog(`测试总任务 #${batchId} 完成：成功 ${success}，失败 ${fail}`, 'info', { batchId, accountId });
        return {
          ok: true,
          batchId: Number(batchId),
          total: items.length,
          success,
          fail,
          results,
        };
      } finally {
        await releaseTestSessionConnection(profileId);
      }
    });
  } finally {
    testingLocal.delete(key);
  }
}

/**
 * ????? WSS ???? batch?AI????????
 */
async function offerSpecificBatch(batchId) {
  const id = Number(batchId || 0);
  if (!id) throw new Error('?? batchId');
  if (!executorHub.hasEnabled()) {
    throw new Error('????????????');
  }
  const batch = await phpApi.post('/node/work-batches/claim-one', {
    batchId: id,
    workerId: WORKER_ID,
    leaseSeconds: 300,
  });
  if (!batch || !batch.id) {
    throw new Error('????? batch???????????');
  }
  const ok = await offerBatchToFrontend(batch, 'offer-one');
  if (!ok) {
    // WSS 推送失败时本机直接执行，避免切换身份后「重推无反应」
    await acceptAndRunBatch(batch);
    return {
      ok: true,
      batchId: Number(batch.id),
      taskLabel: batch.task_label || batch.taskLabel || '',
      direct: true,
    };
  }
  return {
    ok: true,
    batchId: Number(batch.id),
    taskLabel: batch.task_label || batch.taskLabel || '',
  };
}

/**
 * 手动操作（测试/重试）：服务器浏览器走独立队列 kick；其它走本机直跑。
 * 注意：坐席/linux 只走 kickBatch（由其内部 claim-one），禁止先 claim 再 kick，
 * 否则 locked_by / 队列 running Map 会错乱，任务卡在「待执行」。
 */
async function runClaimedBatchDirect(batchId) {
  const id = Number(batchId || 0);
  if (!id) throw new Error('缺少 batchId');
  let scope = '';
  try {
    const pack = await phpApi.get(`/account-work-batches/${id}/items`).catch(() => null);
    scope = String(pack?.batch?.batch_scope || pack?.batch_scope || '');
  } catch { /* ignore */ }
  if (isServerBrowserBatchScope(scope) || scope === 'cs_seat') {
    const { kickBatch } = require('./queue');
    return kickBatch(id);
  }
  if (runningLocal.has(id)) {
    return { ok: true, batchId: id, already: true, taskLabel: '' };
  }
  const batch = await phpApi.post('/node/work-batches/claim-one', {
    batchId: id,
    workerId: WORKER_ID,
    leaseSeconds: 300,
  });
  if (!batch || !batch.id) {
    throw new Error('无法领取该 batch，可能已被占用或已完成');
  }
  // 探测失败时以 claim 结果为准：仍是服务器浏览器则退回队列 kick（先 release 再领）
  if (isServerBrowserBatchScope(batch.batch_scope) || String(batch.batch_scope || '') === 'cs_seat') {
    try {
      await phpApi.post(`/node/work-batches/${id}/release`, {
        workerId: WORKER_ID,
        reason: '移交服务器浏览器队列',
        errorMessage: '移交服务器浏览器队列',
      });
    } catch { /* ignore */ }
    const { kickBatch } = require('./queue');
    return kickBatch(id);
  }
  await acceptAndRunBatch(batch);
  return {
    ok: true,
    batchId: Number(batch.id),
    taskLabel: batch.task_label || batch.taskLabel || '',
  };
}

module.exports = {
  startTaskRunner,
  tick,
  WORKER_ID,
  MAX_CONCURRENT_BATCHES,
  DEFAULT_MAX_CONCURRENT_BATCHES,
  resolveMaxConcurrent,
  acceptAndRunBatch,
  getExecutorStats,
  executeWorkBatch,
  executeWorkItem,
  executePhpTask,
  testRunBatch,
  testRunItem,
  offerSpecificBatch,
  runClaimedBatchDirect,
};

