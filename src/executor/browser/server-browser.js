/**
 * Linux 服务器浏览器（常驻：AI 拓客 + 客服坐席）
 * ---------------------------------------------------------------
 * 1. 仅白名单任务可用 linux；其它任务禁止；
 * 2. 强制 Electron（EL）核，与桌面自研共用环境包（同一 profileId）；
 * 3. 无中心环境包时：AI 拓客不代建空环境，抛 WAITING_ENV_PACK 软等待；
 *    客服坐席（allowProvision）在服务器本机复用/代建环境，由任务走「已存凭证 → 一键登录 → 登录页」，
 *    登录成功后立刻上传环境包+凭证并解除占用；
 * 4. 跨机租约等待失败（超时/被占用）一律中止本次任务，不在没拿到租约时开窗。
 */
const dataStore = require('../data-store');
const { publish: liveLog } = require('../live-log');
const { getProvider, labelFor } = require('./providers');
const {
  prepareEnvForOpen,
  ensureLocalEnvHydrated,
  pushLocalEnvPack,
  provisionReplacementEnv,
  isPackLeaseBusyError,
} = require('./env-pack-sync');

/** 跨机租约获取失败（被占用/等待超时/中继失败）：必须中止，不能在没拿到租约时继续开窗 */
function isLeaseWaitError(e) {
  const msg = String(e?.message || e || '');
  return isPackLeaseBusyError(e)
    || /其它主机|等待环境释放|跨机环境租约失败|PACK_LEASE_BUSY/i.test(msg);
}

/** 允许使用服务器浏览器的分任务类型 */
const SERVER_BROWSER_TASK_TYPES = new Set([
  'ai_lead',
  'ai_lead_dm',
  'dm_sync',
  'message',
  'dm_reply',
  'sync_fans',
  'cs_login',
  'cs_logout',
  'cs_detect',
]);

/** 允许使用服务器浏览器的总任务范围 */
const SERVER_BROWSER_BATCH_SCOPES = new Set(['ai_lead', 'cs_seat']);

const WAITING_ENV_PACK = 'WAITING_ENV_PACK';
const WAITING_LOGIN_DATA = 'WAITING_LOGIN_DATA';

function isServerBrowserTaskType(type) {
  return SERVER_BROWSER_TASK_TYPES.has(String(type || '').trim().toLowerCase());
}

function isServerBrowserBatchScope(scope) {
  return SERVER_BROWSER_BATCH_SCOPES.has(String(scope || 'general').trim().toLowerCase());
}

function isCsSeatTaskType(type) {
  const t = String(type || '').trim().toLowerCase();
  return [
    'dm_sync', 'message', 'dm_reply', 'sync_fans',
    'cs_login', 'cs_logout', 'cs_detect',
  ].includes(t);
}

function serverBrowserForbiddenError(type) {
  const label = labelFor('linux');
  return Object.assign(
    new Error(`「${label}」只用于 AI 拓客和客服坐席，${type || '当前'}任务不能使用服务器浏览器`),
    { status: 422, nonRetryable: true }
  );
}

function waitingEnvPackError(accountId, detail = '') {
  const msg = `账号 #${accountId}：缺环境包，等待本地推送上传后再执行${detail ? `（${detail}）` : ''}`;
  return Object.assign(new Error(msg), {
    code: WAITING_ENV_PACK,
    waiting: true,
    nonRetryable: false,
    status: 409,
  });
}

function waitingLoginDataError(accountId, detail = '') {
  const msg = `账号 #${accountId}：登录数据无法同步登录，等待本地更新登录态后再执行${detail ? `（${detail}）` : ''}`;
  return Object.assign(new Error(msg), {
    code: WAITING_LOGIN_DATA,
    waiting: true,
    nonRetryable: false,
    status: 409,
  });
}

/** 同一账号并发推送时只准备一次环境 */
const inflight = new Map();

async function loadAccountBundle(accountId) {
  const account = await dataStore.getAccountBundle(accountId);
  if (!account) throw Object.assign(new Error('账号不存在'), { status: 404 });
  return account;
}

/**
 * 服务器侧候选环境 ID：linux 绑定 → 自研桌面绑定（同包共用）→ 主字段（若后端属自研族）
 * 故意不含比特 ID：比特环境包与 EL 核不兼容。
 */
function sharedPackCandidateIds(account) {
  const merged = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (s && !merged.includes(s)) merged.push(s);
  };
  push(account?.linux_browser_profile_id);
  push(account?.tkswarm_browser_profile_id);
  const lists = account?.env_profile_ids || {};
  for (const id of [...(lists.linux || []), ...(lists.tkswarm || [])]) push(id);
  const primaryBe = String(account?.browser_backend || '').toLowerCase();
  if (primaryBe === 'tkswarm' || primaryBe === 'linux') {
    push(account?.browser_profile_id);
  }
  return merged;
}

async function bindLinuxProfile(accountId, profileId) {
  const { persistBrowserBinding } = require('./profile-provision');
  await persistBrowserBinding(accountId, profileId, false, 'linux', 0);
}

/**
 * health 校验：必须是 EL 核；否则拒绝跑 linux 任务。
 */
async function assertLinuxEngineOk(provider) {
  const p = provider || getProvider('linux');
  if (!p || typeof p.health !== 'function') {
    throw Object.assign(new Error('服务器浏览器未配置或不可用'), { status: 503, nonRetryable: true });
  }
  let health;
  try {
    health = await p.health();
  } catch (e) {
    throw Object.assign(
      new Error(`服务器浏览器健康检查失败：${e.message || e}`),
      { status: 503, nonRetryable: false }
    );
  }
  const data = health?.data && typeof health.data === 'object' ? health.data : health;
  const engine = String(data?.engine || '').toLowerCase();
  const engineOk = data?.engineOk !== false && (engine === 'electron' || engine === '');
  // 旧版 linuxbrowse 无 engine 字段时：仍允许，但新版必须 electron
  if (data && Object.prototype.hasOwnProperty.call(data, 'engineOk') && !data.engineOk) {
    throw Object.assign(
      new Error(`服务器浏览器未就绪 EL 核：${data.engineError || '请安装 Electron 并设 TKSWARM_BROWSER_ENGINE=electron'}`),
      { status: 503, nonRetryable: true, code: 'ENGINE_NOT_EL' }
    );
  }
  if (engine && engine !== 'electron' && engine !== 'unavailable') {
    throw Object.assign(
      new Error(`服务器浏览器内核必须为 Electron（EL），当前为 ${engine}，禁止 Chrome/Chromium`),
      { status: 503, nonRetryable: true, code: 'ENGINE_NOT_EL' }
    );
  }
  if (engine === 'unavailable') {
    throw Object.assign(
      new Error(`服务器浏览器 EL 核不可用：${data.engineError || '未安装 Electron'}`),
      { status: 503, nonRetryable: true, code: 'ENGINE_NOT_EL' }
    );
  }
  return data;
}

/**
 * 尝试让本机 linuxbrowse 具备该 profile：detail 成功，或从中心库 hydrate（禁止代建）。
 * @returns {Promise<{ ok: boolean, hydrated?: boolean, reason?: string }>}
 */
async function tryReadySharedEnv(profileId, { accountId, provider }) {
  const pid = String(profileId || '').trim();
  if (!pid) return { ok: false, reason: 'empty-id' };

  const local = await provider.detail(pid).catch((e) => {
    if (/不存在|已删除|not\s*found/i.test(String(e?.message || e))) return null;
    throw e;
  });
  if (local && (local.id || local.name)) {
    await prepareEnvForOpen(pid, { accountId, provider }).catch((e) => {
      if (isLeaseWaitError(e)) throw e;
    });
    return { ok: true, hydrated: false };
  }

  const hydrated = await ensureLocalEnvHydrated(pid, { accountId, provider, autoProvision: false });
  if (hydrated?.hydrated) {
    await prepareEnvForOpen(pid, { accountId, provider }).catch((e) => {
      if (isLeaseWaitError(e)) throw e;
    });
    return { ok: true, hydrated: true };
  }

  const again = await provider.detail(pid).catch(() => null);
  if (again && (again.id || again.name)) {
    return { ok: true, hydrated: false };
  }
  return { ok: false, reason: hydrated?.reason || 'no-cloud-pack' };
}

/**
 * 取该账号可用的服务器浏览器环境 ID（复用绑定 / 从中心库拉包）。
 * 拉不到包时抛 WAITING_ENV_PACK（软等待）。
 * @param {number} accountId
 * @param {{ recreate?: boolean }} [opts]
 * @returns {Promise<string>} 环境 ID
 */
async function ensureServerBrowserEnv(accountId, opts = {}) {
  const aid = Number(accountId);
  if (!aid) throw new Error('账号无效，无法准备服务器浏览器环境');
  if (inflight.has(aid)) return inflight.get(aid);

  const task = (async () => {
    const account = await loadAccountBundle(aid);
    const provider = getProvider('linux');
    await assertLinuxEngineOk(provider);
    const phpApi = require('../php-api');

    let candidates = opts.recreate === true ? [] : sharedPackCandidateIds(account);
    const tried = [];
    const seen = new Set(candidates);

    // 绑定 ID 全 miss 时，按账号扫中心库「有包」的 tkswarm/linux 环境再试
    const appendPackableFromApi = async () => {
      try {
        const packInfo = await phpApi.get(`/node/accounts/${aid}/env-packs`);
        const packable = Array.isArray(packInfo?.packable) ? packInfo.packable : [];
        const all = Array.isArray(packInfo?.all) ? packInfo.all : [];
        for (const row of [...packable, ...all]) {
          const pid = String(row?.profileId || '').trim();
          const be = String(row?.browserBackend || '').toLowerCase();
          if (!pid || seen.has(pid)) continue;
          if (be && be !== 'tkswarm' && be !== 'linux') continue;
          if (!(row?.hasPack || row?.packFileExists)) continue;
          seen.add(pid);
          candidates.push(pid);
        }
        if (all.length) {
          const brief = all.slice(0, 4).map((r) => {
            const id = String(r.profileId || '').slice(0, 8);
            const why = r.hasPack ? 'hasPack' : (r.packFileExists ? 'fileOnly' : (r.reason || 'no-pack'));
            return `${id}…(${r.browserBackend || '?'}/${why})`;
          }).join('；');
          liveLog(`账号 #${aid}：中心库环境包诊断 → ${brief}`, 'info', { accountId: aid });
        }
      } catch (e) {
        liveLog(`账号 #${aid}：查询中心库 env-packs 失败：${e.message || e}`, 'warn', { accountId: aid });
      }
    };

    await appendPackableFromApi();

    /** 中心库无包时：若桌面自研本机有同 ID 环境，先导出上传再给服务器浏览器拉 */
    const pushFromDesktopIfPresent = async (pid, metaReason = '') => {
      let desktop;
      try {
        desktop = getProvider('tkswarm');
      } catch (e) {
        return { pushed: false, reason: `desktop-provider:${e.message || e}` };
      }
      if (!desktop) return { pushed: false, reason: 'desktop-provider-missing' };
      const local = await desktop.detail(pid).catch((e) => {
        if (/不存在|已删除|not\s*found/i.test(String(e?.message || e))) return null;
        throw e;
      });
      if (!local || !(local.id || local.name)) {
        return { pushed: false, reason: 'not-on-desktop' };
      }
      // 上传接口要求 account_browser_envs 有行；缺行时先补绑定
      if (metaReason === 'env-row-missing') {
        try {
          const { persistBrowserBinding } = require('./profile-provision');
          await persistBrowserBinding(aid, pid, false, 'tkswarm', 0);
          liveLog(
            `账号 #${aid}：已补建中心库环境绑定 ${pid.slice(0, 8)}…（tkswarm），便于上传包`,
            'info',
            { accountId: aid, profileId: pid },
          );
        } catch (e) {
          return { pushed: false, reason: `ensure-binding:${e.message || e}` };
        }
      }
      liveLog(
        `账号 #${aid}：中心库无包，但桌面自研有环境 ${pid.slice(0, 8)}…，正在导出上传供服务器浏览器拉取`,
        'info',
        { accountId: aid, profileId: pid },
      );
      return pushLocalEnvPack(pid, { accountId: aid, provider: desktop });
    };

    const tryOne = async (pid) => {
      let cloudOk = false;
      let metaReason = '';
      try {
        const meta = await phpApi.get(`/node/browser-profiles/${encodeURIComponent(pid)}/pack-meta`);
        cloudOk = !!(meta?.hasPack || meta?.packFileExists);
        metaReason = meta?.reason || (meta?.exists === false ? 'env-row-missing' : 'pack-file-missing');
      } catch (e) {
        const msg = String(e.message || e);
        if (/404|不存在/.test(msg)) metaReason = 'env-row-missing';
        else {
          liveLog(`账号 #${aid}：pack-meta ${String(pid).slice(0, 8)}… 查询失败：${msg}`, 'warn', { accountId: aid });
          metaReason = 'pack-meta-error';
        }
      }

      if (!cloudOk) {
        // 用户常说「包明明有」：其实在桌面本机，尚未首传到中心库
        try {
          const up = await pushFromDesktopIfPresent(pid, metaReason);
          if (up?.pushed) {
            cloudOk = true;
            liveLog(
              `账号 #${aid}：已把桌面环境 ${pid.slice(0, 8)}… 上传中心库，继续拉到服务器浏览器`,
              'info',
              { accountId: aid, profileId: pid },
            );
          } else if (up?.reason && up.reason !== 'not-on-desktop') {
            liveLog(
              `账号 #${aid}：桌面环境 ${pid.slice(0, 8)}… 未能上传：${up.reason}`,
              'warn',
              { accountId: aid },
            );
          }
        } catch (e) {
          liveLog(
            `账号 #${aid}：尝试从桌面上传环境包失败：${e.message || e}`,
            'warn',
            { accountId: aid },
          );
        }
      }

      if (!cloudOk) {
        return {
          ok: false,
          reason: `no-cloud-pack:${metaReason || 'pack-file-missing'}`,
        };
      }
      return tryReadySharedEnv(pid, { accountId: aid, provider });
    };

    for (const pid of candidates) {
      try {
        const ready = await tryOne(pid);
        if (!ready.ok) {
          tried.push(`${pid.slice(0, 8)}…(${ready.reason || 'unavailable'})`);
          continue;
        }
        const currentLinux = String(account.linux_browser_profile_id || '').trim();
        if (currentLinux !== pid) {
          await bindLinuxProfile(aid, pid);
          liveLog(
            `账号 #${aid}：服务器浏览器已绑定共用环境 ${pid.slice(0, 8)}…${ready.hydrated ? '（已从中心库拉包）' : ''}`,
            'info',
            { accountId: aid, profileId: pid },
          );
        } else if (ready.hydrated) {
          liveLog(
            `账号 #${aid}：服务器浏览器环境 ${pid.slice(0, 8)}… 已从中心库拉包还原`,
            'info',
            { accountId: aid, profileId: pid },
          );
        }
        return pid;
      } catch (e) {
        if (e?.code === 'ENGINE_NOT_EL' || e?.nonRetryable === true) throw e;
        if (isLeaseWaitError(e)) throw e;
        tried.push(`${String(pid).slice(0, 8)}…(${e.message || e})`);
        liveLog(
          `账号 #${aid}：共用环境 ${String(pid).slice(0, 8)}… 不可用：${e.message || e}`,
          'warn',
          { accountId: aid },
        );
      }
    }

    // 客服坐席：缺包不再软等待，改为服务器本机复用/代建环境，交给任务走登录流程
    if (opts.allowProvision === true) {
      // ① 本机已有候选环境（上次代建后登录未完成、中心库还没包）：直接复用，避免反复代建
      for (const pid of candidates) {
        const local = await provider.detail(pid).catch(() => null);
        if (!local || !(local.id || local.name)) continue;
        try {
          await prepareEnvForOpen(pid, { accountId: aid, provider });
        } catch (e) {
          if (isLeaseWaitError(e)) throw e;
        }
        if (String(account.linux_browser_profile_id || '').trim() !== pid) {
          await bindLinuxProfile(aid, pid);
        }
        liveLog(
          `账号 #${aid}：中心库无可用包，复用服务器本机环境 ${pid.slice(0, 8)}…，将用已存凭证/账密登录并同步凭证`,
          'warn',
          { accountId: aid, profileId: pid },
        );
        return pid;
      }
      // ② 代建（不抢主绑定、不推空包；登录成功后再上传）
      liveLog(
        `账号 #${aid}：中心库无包且本机无环境，在服务器浏览器代建环境，稍后用已存凭证/账密登录并同步凭证`,
        'warn',
        { accountId: aid },
      );
      const provisioned = await provisionReplacementEnv('', {
        accountId: aid,
        provider,
        bundle: account,
        backend: 'linux',
        asPrimary: false,
        skipPush: true,
      });
      const newPid = String(provisioned?.profileId || '').trim();
      if (!newPid) throw waitingEnvPackError(aid, '代建服务器浏览器环境未返回 ID');
      try {
        await prepareEnvForOpen(newPid, { accountId: aid, provider });
      } catch (e) {
        if (isLeaseWaitError(e)) throw e;
      }
      return newPid;
    }

    const detail = candidates.length
      ? `已尝试 ${candidates.length} 个绑定${tried.length ? `：${tried.slice(0, 4).join('；')}` : ''}`
      : '账号未绑定 linux/自研环境，且中心库无可用包';
    throw waitingEnvPackError(aid, detail);
  })().finally(() => inflight.delete(aid));

  inflight.set(aid, task);
  return task;
}

module.exports = {
  SERVER_BROWSER_TASK_TYPES,
  SERVER_BROWSER_BATCH_SCOPES,
  WAITING_ENV_PACK,
  WAITING_LOGIN_DATA,
  isServerBrowserTaskType,
  isServerBrowserBatchScope,
  isCsSeatTaskType,
  serverBrowserForbiddenError,
  waitingEnvPackError,
  waitingLoginDataError,
  assertLinuxEngineOk,
  ensureServerBrowserEnv,
  sharedPackCandidateIds,
};
