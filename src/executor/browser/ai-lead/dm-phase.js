/**
 * AI拓客 · 意向评论私信（独立模块）
 * 常态化推送由 PHP ai-lead:dm-dispatch 入队；此处执行单条或测试批量。
 * 日额度与间隔由账号视频激活权重决定。
 */
const { prepareMessage } = require('../tiktok-actions');
const phpApi = require('../../php-api');
const { reportProgress, liveLog, humanPause } = require('./pipeline-base');

const DAILY_LIMIT_FALLBACK = 3;

function sortAccountsForPick(accounts, options = {}) {
  const forcedId = Number(options.accountId || 0);
  return [...(accounts || [])].sort((a, b) => {
    const aid = Number(a.accountId || a.id || 0);
    const bid = Number(b.accountId || b.id || 0);
    if (forcedId > 0) {
      if (aid === forcedId && bid !== forcedId) return -1;
      if (bid === forcedId && aid !== forcedId) return 1;
    }
    const ac = a.canSendNow === false ? 1 : 0;
    const bc = b.canSendNow === false ? 1 : 0;
    if (ac !== bc) return ac - bc;
    const rem = Number(b.remaining || 0) - Number(a.remaining || 0);
    if (rem !== 0) return rem;
    return Number(a.usedToday || 0) - Number(b.usedToday || 0);
  });
}

function pickAccount(accounts, options = {}) {
  const sorted = sortAccountsForPick(accounts, options);
  const forcedId = Number(options.accountId || 0);
  const exclude = new Set((options.excludeAccountIds || []).map(Number));
  if (forcedId > 0 && !exclude.has(forcedId)) {
    const forced = sorted.find((a) => Number(a.accountId || a.id || 0) === forcedId);
    if (forced && Number(forced.remaining || 0) > 0 && forced.canSendNow !== false) return forced;
  }
  return sorted.find((a) => {
    const id = Number(a.accountId || a.id || 0);
    if (exclude.has(id)) return false;
    return Number(a.remaining || 0) > 0 && a.canSendNow !== false;
  }) || null;
}

function renderMessage(template, target) {
  const raw = String(template || '').trim();
  const username = String(target?.username || '').replace(/^@+/, '');
  const nickname = String(target?.nickname || username);
  if (!raw) {
    return `Hi ${nickname}! Thanks for your interest. Feel free to message me for product details.`;
  }
  return raw
    .replace(/\{\{\s*username\s*\}\}/gi, username)
    .replace(/\{\{\s*nickname\s*\}\}/gi, nickname)
    .replace(/\{\{\s*comment\s*\}\}/gi, String(target?.commentText || '').slice(0, 80));
}

async function fetchDmPlan(leadId) {
  return (await phpApi.get(`/node/ai-leads/${leadId}/dm-plan`)) || {};
}

async function saveDmRecord(leadId, payload) {
  return phpApi.post(`/node/ai-leads/${leadId}/dm-records`, payload);
}

async function generateDmOpener(target, product = '') {
  try {
    const res = await phpApi.post('/node/ai-leads/generate-dm', {
      username: target.username,
      nickname: target.nickname || target.username,
      commentText: target.commentText || target.comment_text || '',
      product: product || '',
    });
    const message = String(res?.message || '').trim();
    if (message) {
      return {
        message,
        source: res?.source || 'ai',
        error: res?.error || '',
      };
    }
  } catch (e) {
    return { message: '', source: 'error', error: e.message || String(e) };
  }
  return { message: '', source: 'empty', error: 'AI 返回空文案' };
}

/**
 * 向单个意向用户发一条私信（独立可测）。
 * @returns {Promise<{status:string,errorMessage:string,content:string,accountId:number}>}
 */
async function alreadySentDm(leadId, target) {
  const username = String(target?.username || '').replace(/^@+/, '').trim();
  if (!username && !target?.uuid) return null;
  try {
    return await phpApi.post(`/node/ai-leads/${leadId}/dm-already-sent`, {
      username,
      uuid: String(target?.uuid || ''),
    });
  } catch (e) {
    liveLog(`AI拓客私信查重失败 @${username}: ${e.message}`, 'warn', { leadId });
    return null;
  }
}

async function sendOneDm(leadId, target, account, {
  messageTpl = '',
  productHint = '',
  autoSend = true,
  skipGate = false,
  saveTraffic = true,
  browserBackend = undefined,
} = {}) {
  const accountId = Number(account?.accountId || account?.id || 0);
  if (!skipGate) {
    if (account?.canSendNow === false) {
      const reason = String(account?.blockReason || '账号暂不可私信');
      return {
        status: 'skipped',
        errorMessage: reason,
        content: '',
        accountId,
        remaining: account?.remaining,
      };
    }
    if (Number(account?.remaining ?? 1) < 1) {
      return {
        status: 'skipped',
        errorMessage: '今日私信额度已满',
        content: '',
        accountId,
        remaining: 0,
      };
    }
  }
  const prior = await alreadySentDm(leadId, target);
  if (prior?.sent) {
    liveLog(
      `AI拓客私信跳过 @${target.username}：已发送过（记录 #${prior.recordId || 0}）`,
      'info',
      { leadId, accountId }
    );
    return {
      status: 'skipped',
      alreadySent: true,
      errorMessage: '已发送过，跳过',
      content: '',
      accountId,
      remaining: account?.remaining,
    };
  }
  const ai = await generateDmOpener(target, productHint);
  let content = String(ai.message || '').trim();
  if (!content) {
    content = renderMessage(messageTpl, target);
    liveLog(
      `AI拓客私信文案回退模板 @${target.username}: ${ai.error || ai.source}`,
      'warn',
      { leadId, accountId }
    );
  } else {
    liveLog(
      `AI拓客私信文案(${ai.source}) @${target.username}: ${content.slice(0, 80)}`,
      'info',
      { leadId, accountId }
    );
  }

  liveLog(
    `AI拓客私信 @${target.username} ← account#${accountId}（今日剩余 ${account.remaining}）`,
    'info',
    { leadId, accountId }
  );

  await humanPause(3500, 0.2);

  let status = 'failed';
  let errMsg = '';
  try {
    const { parseSaveTrafficFlag } = require('../save-traffic');
    const result = await prepareMessage(accountId, content, target.username, {
      autoSend,
      saveTraffic: parseSaveTrafficFlag(saveTraffic, true),
      browserBackend,
    });
    const st = String(result?.status || '');
    if (st === 'sent') {
      status = 'sent';
    } else if (st === 'security_paused' || st === 'manual_required') {
      status = 'failed';
      errMsg = result?.reason || result?.error || st;
    } else {
      status = 'failed';
      errMsg = result?.error || result?.reason || st || '发送失败';
    }
  } catch (e) {
    status = 'failed';
    errMsg = e.message || String(e);
  }

  if (status !== 'sent') {
    liveLog(`AI拓客私信失败 @${target.username}: ${errMsg}`, 'error', { leadId, accountId });
  }

  const rec = await saveDmRecord(leadId, {
    accountId,
    username: target.username,
    uuid: target.uuid,
    message: content,
    errorMessage: errMsg,
    status,
  }).catch((e) => {
    liveLog(`私信记录回写失败: ${e.message}`, 'warn', { leadId });
    return null;
  });

  return {
    status: String(rec?.status || status),
    errorMessage: errMsg,
    content,
    accountId,
    remaining: rec?.remaining,
  };
}

/**
 * @param {number} leadId
 * @param {object} [baseStats]
 * @param {object} [options]
 * @param {string} [options.username] 仅测指定用户
 * @param {number} [options.limit] 最多发几条（测试时可限 1）
 * @param {boolean} [options.testMode] 测试模式日志前缀
 * @returns {Promise<object>} DM 汇总 stats
 */
/**
 * 计划任务 dispatch 模式：仅发送 payload 指定的一条目标。
 */
async function runDmDispatch(accountId, payload = {}) {
  const leadId = Number(payload.leadId || payload.lead_id || 0);
  if (!leadId) throw new Error('dispatch 缺少 leadId');
  const target = payload.forceTarget || null;
  if (!target || !target.username) throw new Error('dispatch 缺少 forceTarget');
  liveLog(
    `AI拓客 #${leadId} 私信 dispatch account#${accountId} @${target.username}`,
    'info',
    { leadId, accountId }
  );
  const plan = await fetchDmPlan(leadId).catch(() => ({}));
  const accounts = Array.isArray(plan.accounts) ? plan.accounts : [];
  const acc = accounts.find((a) => Number(a.accountId || 0) === accountId) || null;
  if (!acc) {
    const reason = '账号不在拓客关联列表或环境不可用';
    await saveDmRecord(leadId, {
      accountId,
      username: target.username,
      uuid: target.uuid,
      message: '',
      errorMessage: reason,
      status: 'skipped',
    }).catch(() => {});
    return { status: 'skipped', dmsSkipped: 1, dmsSent: 0, dmsFailed: 0, lastError: reason };
  }
  if (acc.canSendNow === false || Number(acc.remaining || 0) < 1) {
    const reason = acc.blockReason || '账号暂不可私信';
    await saveDmRecord(leadId, {
      accountId,
      username: target.username,
      uuid: target.uuid,
      message: '',
      errorMessage: reason,
      status: 'skipped',
    }).catch(() => {});
    return { status: 'skipped', dmsSkipped: 1, dmsSent: 0, dmsFailed: 0, lastError: reason };
  }
  const result = await sendOneDm(leadId, target, acc, {
    messageTpl: plan.message || '',
    productHint: plan.product || plan.keyword || payload.product || '',
    autoSend: payload.autoSend !== false,
    saveTraffic: payload.saveTraffic ?? payload.save_traffic ?? true,
    browserBackend: payload.browserBackend || payload.browser_backend,
  });
  const sent = result.status === 'sent' ? 1 : 0;
  const failed = result.status === 'failed' ? 1 : 0;
  const skipped = result.status === 'skipped' || result.alreadySent ? 1 : 0;
  return {
    status: sent > 0 ? 'completed' : (failed > 0 ? 'failed' : 'completed'),
    mode: 'dispatch',
    dmsSent: sent,
    dmsFailed: failed,
    dmsSkipped: skipped,
    lastError: result.errorMessage || '',
  };
}

async function runDmPhase(leadId, baseStats = {}, options = {}) {
  const out = {
    dmsNeeded: 0,
    dmsSent: 0,
    dmsFailed: 0,
    dmsSkipped: 0,
    dmsAlreadySent: 0,
    accountsBound: 0,
    accountsUsed: 0,
    accountsNeeded: 0,
    accountsMissing: 0,
    capacityToday: 0,
    testMode: !!options.testMode,
    lastError: '',
  };

  let plan;
  try {
    plan = await fetchDmPlan(leadId);
  } catch (e) {
    liveLog(`AI拓客 #${leadId} 私信计划拉取失败: ${e.message}`, 'warn', { leadId });
    return out;
  }

  let targets = Array.isArray(plan.targets) ? plan.targets : [];
  const filterUser = String(options.username || options.onlyUsername || '').replace(/^@+/, '').trim().toLowerCase();
  if (filterUser) {
    targets = targets.filter((t) => String(t.username || '').replace(/^@+/, '').toLowerCase() === filterUser);
  }
  // 测试指定用户：计划里没有时用 forceTarget（可重试已发失败/已发送用户）
  const force = options.forceTarget || null;
  if (filterUser && !targets.length && force && String(force.username || '').replace(/^@+/, '')) {
    targets = [force];
  }
  const limit = Number(options.limit || 0);
  if (limit > 0) {
    targets = targets.slice(0, limit);
  }

  const accounts = (Array.isArray(plan.accounts) ? plan.accounts : []).map((a) => ({
    ...a,
    remaining: Number(a.remaining || 0),
  }));
  const summary = plan.summary || {};
  const messageTpl = plan.message || '';
  const dailyLimit = Number(plan.dailyLimit || DAILY_LIMIT_FALLBACK);
  const productHint = String(plan.product || plan.keyword || options.product || '').trim();
  const tag = options.testMode ? '私信测试' : '私信';

  out.dmsNeeded = targets.length;
  out.accountsBound = Number(summary.accountsBound ?? accounts.length);
  out.accountsNeeded = Number(summary.accountsNeeded ?? 0);
  out.accountsMissing = Number(summary.accountsMissing ?? 0);
  out.capacityToday = Number(summary.capacity ?? accounts.reduce((s, a) => s + a.remaining, 0));

  await reportProgress(leadId, {
    phase: options.testMode ? 'dm_test' : 'dm',
    targets: targets.length,
    capacity: out.capacityToday,
    accountsBound: out.accountsBound,
    accountsNeeded: out.accountsNeeded,
    accountsMissing: out.accountsMissing,
  }, { ...baseStats, ...out });

  liveLog(
    `AI拓客 #${leadId} ${tag}阶段 待发=${targets.length} 今日额度=${out.capacityToday} `
    + `关联账号=${out.accountsBound} 需要=${out.accountsNeeded} 缺=${out.accountsMissing}（每号≤${dailyLimit}/天）`,
    targets.length ? 'info' : 'warn',
    { leadId }
  );

  if (!targets.length) {
    liveLog(`AI拓客 #${leadId} ${tag}无待发目标（可能已发过或无线索）`, 'warn', { leadId });
    return out;
  }

  const usedSet = new Set();

  if (!accounts.length) {
    out.dmsSkipped = targets.length;
    out.accountsMissing = Math.max(out.accountsMissing, Math.ceil(targets.length / dailyLimit) || 1);
    liveLog(`AI拓客 #${leadId} 无可用关联账号，跳过 ${targets.length} 条私信`, 'warn', { leadId });
    return out;
  }

  const { assertLeadActive } = require('./pipeline-base');
  const usedAccountIds = [];
  for (const target of targets) {
    if (!options.testMode) assertLeadActive(leadId);
    const acc = pickAccount(accounts, {
      ...options,
      excludeAccountIds: usedAccountIds,
    });
    if (!acc) {
      out.dmsSkipped += 1;
      await saveDmRecord(leadId, {
        accountId: accounts[0].accountId,
        username: target.username,
        uuid: target.uuid,
        message: '',
        errorMessage: '今日关联账号私信额度不足',
        status: 'skipped',
      }).catch(() => {});
      continue;
    }

    const result = await sendOneDm(leadId, target, acc, {
      messageTpl,
      productHint,
      autoSend: options.autoSend !== false,
      skipGate: !!(options.skipGate || options.testMode),
    });

    const finalStatus = result.status;
    if (result.alreadySent) {
      out.dmsSkipped += 1;
      out.dmsAlreadySent += 1;
    } else if (finalStatus === 'sent') {
      out.dmsSent += 1;
      usedSet.add(result.accountId);
      if (result.accountId) usedAccountIds.push(Number(result.accountId));
      acc.remaining = Math.max(0, Number(result.remaining ?? (acc.remaining - 1)));
    } else if (finalStatus === 'skipped') {
      out.dmsSkipped += 1;
      acc.remaining = 0;
    } else {
      out.dmsFailed += 1;
      if (result.errorMessage) out.lastError = result.errorMessage;
    }

    await reportProgress(leadId, {
      phase: options.testMode ? 'dm_test' : 'dm',
      lastUser: target.username,
      lastStatus: finalStatus,
      lastError: result.errorMessage || '',
      dmsSent: out.dmsSent,
      dmsFailed: out.dmsFailed,
      dmsSkipped: out.dmsSkipped,
    }, { ...baseStats, ...out, accountsUsed: usedSet.size });

    if (!result.alreadySent) await humanPause(4000, 0.25);
  }

  out.accountsUsed = usedSet.size;
  const quotaSkipped = Math.max(0, out.dmsSkipped - out.dmsAlreadySent);
  const remainTargets = Math.max(0, out.dmsNeeded - out.dmsSent - out.dmsFailed - out.dmsAlreadySent);
  if (remainTargets > 0 || quotaSkipped > 0) {
    const left = quotaSkipped + Math.max(0, remainTargets - quotaSkipped);
    if (left > 0) {
      out.accountsMissing = Math.max(out.accountsMissing, Math.ceil(left / dailyLimit));
    }
  }

  liveLog(
    `AI拓客 #${leadId} ${tag}结束 发送=${out.dmsSent} 失败=${out.dmsFailed} 跳过=${out.dmsSkipped} `
    + `用号=${out.accountsUsed}/${out.accountsBound} 需要=${out.accountsNeeded} 缺=${out.accountsMissing}`,
    'info',
    { leadId }
  );

  return out;
}

/**
 * 独立私信测试入口（不跑抓取）。
 * payload: { leadId, username?, limit?, accountId? }
 */
async function runDmTest(accountId, payload = {}) {
  const leadId = Number(payload.leadId || payload.lead_id || 0);
  if (!leadId) throw new Error('私信测试缺少 leadId');
  const { clearLeadAbort } = require('./pipeline-base');
  clearLeadAbort(leadId);
  liveLog(
    `AI拓客 #${leadId} 私信独立测试开始 account#${accountId}`
    + (payload.username ? ` user=@${String(payload.username).replace(/^@+/, '')}` : '')
    + (payload.limit ? ` limit=${payload.limit}` : ''),
    'info',
    { leadId, accountId }
  );
  const stats = await runDmPhase(leadId, {}, {
    testMode: true,
    skipGate: true,
    username: payload.username || '',
    limit: Number(payload.limit || 0) || 0,
    product: payload.product || payload.keyword || '',
    forceTarget: payload.forceTarget || null,
  });
  const sent = Number(stats.dmsSent || 0);
  const failed = Number(stats.dmsFailed || 0);
  const status = sent > 0 ? 'completed' : (failed > 0 ? 'failed' : 'completed');
  return { status, mode: 'dm_test', ...stats };
}

module.exports = {
  runDmPhase,
  runDmTest,
  runDmDispatch,
  sendOneDm,
  generateDmOpener,
  renderMessage,
  DAILY_LIMIT_FALLBACK,
};
