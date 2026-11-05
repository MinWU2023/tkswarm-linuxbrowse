/**
 * 跨机环境包同步策略（自研桌面 / Linux）：
 * 1) 本机已有目标环境 → 直接使用
 * 2) 中心库有环境包文件 → 日志「已找到」后拉取，每增 10% 打一次进度，再 import keepId
 * 3) 中心库也无包 → 当前登录用户代原账号归属用户，在本机创建同名同配置环境，上传中心库并绑定原账号
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const phpApi = require('../php-api');
const { publish: liveLog } = require('../live-log');
const packLeasePush = require('./pack-lease-push');

/** profileId -> 最近一次释放返回的 signal（含 nextHostId），供登录后判断是否还有等待方 */
const lastReleaseSignals = new Map();
function getLastReleaseSignal(profileId) {
  return lastReleaseSignals.get(String(profileId || '').trim()) || null;
}

/**
 * 本机记录「上次与中心库同步的环境包版本」(packRevision)。
 * 打开环境时若中心库版本与本机记录不同（别的设备登录后上传了新包），就拉新包覆盖，
 * 这样即使本机已有旧环境，也能拿到最新登录凭证。没有记录时不覆盖，避免误伤本机新数据。
 */
const packRevFile = path.resolve(__dirname, '../../../data/pack-revisions.json');
function readPackRevs() {
  try {
    return JSON.parse(fs.readFileSync(packRevFile, 'utf8')) || {};
  } catch {
    return {};
  }
}
function getPackRev(profileId) {
  return String(readPackRevs()[String(profileId || '').trim()] || '');
}
function recordPackRev(profileId, rev) {
  const pid = String(profileId || '').trim();
  const r = String(rev || '').trim();
  if (!pid || !r) return;
  try {
    const all = readPackRevs();
    all[pid] = r;
    fs.mkdirSync(path.dirname(packRevFile), { recursive: true });
    fs.writeFileSync(packRevFile, JSON.stringify(all));
  } catch { /* 记录失败不影响主流程 */ }
}

function hostId() {
  try {
    return String(process.env.TKSWARM_HOST_ID || os.hostname() || 'node').slice(0, 120);
  } catch {
    return 'node';
  }
}

function supportsPackSync(provider) {
  const id = String(provider?.backendId || '').toLowerCase();
  const env = String(provider?.envType || '').toLowerCase();
  // linux Provider 的 backendId 常映射为 tkswarm，故同时认 envType
  return id === 'tkswarm' || id === 'linux' || env === 'tkswarm' || env === 'linux';
}

function isMissingLocal(error) {
  return /不存在|已删除|not\s*found/i.test(String(error?.message || error || ''));
}

function formatPackBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)}KB`;
  return `${(v / (1024 * 1024)).toFixed(1)}MB`;
}

function formatSpeed(bps) {
  const v = Number(bps) || 0;
  if (v <= 0) return '0KB/s';
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))}KB/s`;
  return `${(v / (1024 * 1024)).toFixed(1)}MB/s`;
}

async function fetchPackMeta(profileId) {
  const pid = String(profileId || '').trim();
  if (!pid) return { exists: false, hasPack: false, profileId: '' };
  try {
    return await phpApi.get(`/node/browser-profiles/${encodeURIComponent(pid)}/pack-meta`);
  } catch (e) {
    const msg = String(e.message || e);
    if (/404|不存在/i.test(msg)) {
      return { exists: false, hasPack: false, profileId: pid, reason: msg };
    }
    throw e;
  }
}

async function detailLocal(provider, profileId) {
  const pid = String(profileId || '').trim();
  if (!pid || !provider) return null;
  try {
    const detail = await provider.detail(pid);
    if (detail && (detail.id || detail.name)) return detail;
    return null;
  } catch (e) {
    if (isMissingLocal(e)) return null;
    throw e;
  }
}

function isPackLeaseBusyError(err) {
  const payload = err?.payload || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const code = String(data.code || payload.code || '');
  const msg = String(err?.message || err || '');
  return code === 'PACK_LEASE_BUSY' || /其它主机|PACK_LEASE_BUSY/i.test(msg);
}

function packLeaseBusyInfo(err) {
  const payload = err?.payload || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  return {
    holderHost: String(data.holderHost || ''),
    leaseUntil: String(data.leaseUntil || ''),
    lockedBy: String(data.lockedBy || ''),
  };
}

function packLeaseWaitMs() {
  const n = Number(process.env.TKSWARM_PACK_LEASE_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

/**
 * 占用跨机租约；若对方占用则 FIFO 入队，并被动等待 WSS 中继推送（无轮询、无服务端长请求）。
 * 唤醒后拉最新包 + 会话凭证自动登录。
 * @returns {Promise<{ ok: boolean, waited?: boolean, reason?: string, meta?: any, error?: Error }>}
 */
async function acquirePackLeaseWithWait(profileId, {
  accountId = 0,
  hostId: hostOverride = '',
  leaseSeconds = 7200,
  waitMs = packLeaseWaitMs(),
} = {}) {
  const pid = String(profileId || '').trim();
  const hid = String(hostOverride || hostId());
  if (!pid || !hid) return { ok: false, reason: 'missing-args' };

  const deadline = Date.now() + Math.max(30_000, waitMs);
  let announced = false;
  let lastHint = '';

  while (true) {
    try {
      const meta = await phpApi.post(`/node/browser-profiles/${encodeURIComponent(pid)}/pack-lease`, {
        hostId: hid,
        leaseSeconds: Math.max(120, leaseSeconds),
      });
      if (announced) {
        liveLog(
          `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8)}… 已收到占用解除推送，本端取得锁，开始拉取最新登录凭证`,
          'info',
          { accountId },
        );
        try {
          const { publishEvent } = require('../live-log');
          publishEvent('pack-lease-acquired', {
            accountId,
            profileId: pid,
            hostId: hid,
            waited: true,
          });
        } catch { /* ignore */ }
      }
      return { ok: true, waited: announced, meta };
    } catch (e) {
      const msg = String(e.message || e);
      if (/不存在|404/i.test(msg) && !isPackLeaseBusyError(e)) {
        return { ok: false, reason: 'not-found', error: e };
      }
      if (!isPackLeaseBusyError(e)) {
        liveLog(
          `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8)}… 无法占用跨机租约：${msg}`,
          'error',
          { accountId },
        );
        throw new Error(`跨机环境租约失败：${msg}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          msg.includes('其它主机')
            ? `${msg}（已等待超时）`
            : `等待环境释放超时：${msg}`,
        );
      }

      const info = packLeaseBusyInfo(e);
      const hint = info.holderHost || '其它主机';
      if (!announced || hint !== lastHint) {
        announced = true;
        lastHint = hint;
        const until = info.leaseUntil ? `，租约至 ${info.leaseUntil}` : '';
        liveLog(
          `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8)}… 正被 ${hint} 占用${until}，已加入等待队列（FIFO），被动等待对方上传凭证并解除占用（WSS 推送）…`,
          'warn',
          { accountId },
        );
      }

      // 优先 WSS 中继被动推送；中继未部署时退回短轮询 enqueue（避免整链路卡死）
      try {
        const pushed = await packLeasePush.waitForRelease(pid, {
          hostId: hid,
          accountId,
          timeoutMs: Math.max(5000, deadline - Date.now()),
        });
        liveLog(
          `账号 #${accountId || '-'}：收到占用解除${pushed?.pushed ? '推送' : '通知'}（队列第 ${pushed?.position || 1} 位），准备拉取环境包并自动登录`,
          'info',
          { accountId },
        );
        try {
          const { publishEvent } = require('../live-log');
          publishEvent('pack-lease-ready', {
            accountId,
            profileId: pid,
            hostId: hid,
            position: pushed?.position || 1,
            releaseSeq: pushed?.releaseSeq,
            pushed: !!pushed?.pushed,
          });
        } catch { /* ignore */ }
        continue; // 立即再 acquire
      } catch (pe) {
        if (pe?.code === 'RELAY_TIMEOUT') continue; // 回到循环顶部由 deadline 判定超时
        if (pe?.code === 'RELAY_NOT_FOUND') return { ok: false, reason: 'not-found', error: pe };
        const relayMissing = pe?.code === 'RELAY_UNCONFIGURED' || pe?.code === 'RELAY_CONNECT'
          || /中继未配置|RELAY_UNCONFIGURED|TKSWARM_RELAY/i.test(String(pe?.message || pe));
        if (relayMissing) {
          if (!announced || lastHint !== `${hint}|poll`) {
            lastHint = `${hint}|poll`;
            liveLog(
              `账号 #${accountId || '-'}：WSS 中继不可用（${pe.message || pe}），改用短轮询等待占用释放（建议部署 ws-relay 并配置 TKSWARM_RELAY_SECRET / TKSWARM_RELAY_PUBLIC_URL）`,
              'warn',
              { accountId },
            );
          }
          try {
            const state = await phpApi.post(
              `/node/browser-profiles/${encodeURIComponent(pid)}/pack-lease/enqueue`,
              { hostId: hid, accountId: Number(accountId) || 0 },
            );
            if (state?.ready) {
              liveLog(
                `账号 #${accountId || '-'}：轮询到队首可占用（第 ${state.position || 1} 位），准备拉取环境包`,
                'info',
                { accountId },
              );
              continue;
            }
          } catch (enqErr) {
            if (/不存在|404/i.test(String(enqErr.message || enqErr))) {
              return { ok: false, reason: 'not-found', error: enqErr };
            }
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw new Error(
          `等待环境释放失败：WSS 中继不可用（${pe.message || pe}）。请确认已部署中继并配置 TKSWARM_RELAY_SECRET / TKSWARM_RELAY_PUBLIC_URL`,
        );
      }
    }
  }
}

/**
 * 中心库有包：租约 → 下载（10% 进度）→ import keepId。
 */
async function pullRemotePack(profileId, {
  accountId = 0,
  provider,
  meta,
  hostId: hostOverride = '',
  skipLease = false,
} = {}) {
  const pid = String(profileId || '').trim();
  const hid = String(hostOverride || hostId());
  const packBytes = Number(meta?.packBytes || 0) || 0;
  const sizeHint = formatPackBytes(packBytes);
  const rev = meta?.packRevision || '?';

  let acquiredHere = false;
  if (!skipLease) {
    const lease = await acquirePackLeaseWithWait(pid, {
      accountId,
      hostId: hid,
      leaseSeconds: 7200,
    });
    if (!lease.ok) {
      const msg = String(lease.error?.message || lease.reason || '跨机环境租约失败');
      throw new Error(msg.includes('其它主机') ? msg : `跨机环境租约失败：${msg}`);
    }
    acquiredHere = true;
  }

  const tmp = path.join(os.tmpdir(), `tk-env-pack-${pid.slice(0, 12)}-${Date.now()}.tgz`);
  try {
    liveLog(
      `账号 #${accountId || '-'}：中心库已找到环境包 ${pid.slice(0, 8)}…（rev ${rev}${sizeHint ? `，${sizeHint}` : ''}），开始拉取`,
      'info',
      { accountId },
    );

    const timeoutMs = Math.max(
      10 * 60 * 1000,
      packBytes > 0 ? Math.ceil((packBytes / (50 * 1024)) * 1000) + 120000 : 10 * 60 * 1000,
    );
    let lastLoggedPct = -1;
    await phpApi.download(`/node/browser-profiles/${encodeURIComponent(pid)}/pack`, tmp, {
      totalBytes: packBytes,
      timeoutMs,
      progressPctStep: 10,
      progressIntervalMs: 8000,
      onProgress: ({ loaded, total, pct, speed }) => {
        const totalLabel = formatPackBytes(total || packBytes) || '?';
        const loadedLabel = formatPackBytes(loaded) || '0B';
        if (pct >= 0) {
          const bucket = Math.floor(pct / 10) * 10;
          if (bucket === lastLoggedPct && pct < 100) return;
          lastLoggedPct = bucket;
          liveLog(
            `账号 #${accountId || '-'}：拉取环境包 ${pid.slice(0, 8)}… ${bucket}%（${loadedLabel}/${totalLabel}，${formatSpeed(speed)}）`,
            'info',
            { accountId },
          );
          return;
        }
        liveLog(
          `账号 #${accountId || '-'}：拉取环境包 ${pid.slice(0, 8)}… 已下 ${loadedLabel}（${formatSpeed(speed)}）`,
          'info',
          { accountId },
        );
      },
    });

    const downloaded = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    liveLog(
      `账号 #${accountId || '-'}：环境包 ${pid.slice(0, 8)}… 下载完成（${formatPackBytes(downloaded) || '0B'}），正在导入本机…`,
      'info',
      { accountId },
    );
    await provider.importPack({
      filePath: tmp,
      id: pid,
      keepId: true,
      forceOverwrite: true,
    });
    const again = await detailLocal(provider, pid);
    if (!again) {
      throw new Error('环境包已下载但本地导入后仍查不到环境');
    }
    liveLog(
      `账号 #${accountId || '-'}：已从中心库还原环境 ${pid.slice(0, 8)}…（含登录态数据）`,
      'info',
      { accountId },
    );
    recordPackRev(pid, meta?.packRevision);
    return { hydrated: true, profileId: pid, source: 'remote-pack' };
  } catch (e) {
    if (acquiredHere) {
      await phpApi.post(`/node/browser-profiles/${encodeURIComponent(pid)}/pack-lease/release`, {
        hostId: hid,
      }).catch(() => {});
    }
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* */ }
  }
}

/** 本机已有同账号环境（按 remark / 同名），优先复用，避免反复代建堆窗 */
async function findLocalAccountEnv(provider, accountId, preferredName = '') {
  const aid = Number(accountId) || 0;
  if (!aid || !provider?.profiles) return '';
  const remarkNeedle = `account #${aid}`;
  const nameNeedle = String(preferredName || '').trim().toLowerCase();
  try {
    const raw = await provider.profiles(0, 100, '');
    const list = raw?.data?.list || raw?.list || (Array.isArray(raw?.data) ? raw.data : []);
    if (!Array.isArray(list) || !list.length) return '';
    const scored = [];
    for (const p of list) {
      const id = String(p?.id || '').trim();
      if (!id) continue;
      const name = String(p.name || '').trim();
      const remark = String(p.remark || '').trim();
      const hitRemark = remark.toLowerCase().includes(remarkNeedle);
      const hitName = nameNeedle && name.toLowerCase() === nameNeedle;
      if (!hitRemark && !hitName) continue;
      scored.push({
        id,
        // 优先：同名且 remark 命中 > 仅 remark > 仅同名；同档取列表靠后（更新）
        score: (hitRemark && hitName ? 300 : hitRemark ? 200 : 100) + Number(p.seq || 0),
      });
    }
    if (!scored.length) return '';
    scored.sort((a, b) => b.score - a.score);
    return scored[0].id;
  } catch {
    return '';
  }
}

/**
 * 中心库无包：当前操作员在本机代建同名同配置环境 → 绑定原账号/原归属用户 → 上传中心库。
 * 若本机已有同账号同名窗，直接复用并提升主绑，不再新建。
 */
async function provisionReplacementEnv(targetProfileId, {
  accountId = 0,
  provider,
  bundle = null,
  backend = 'tkswarm',
  meta = null,
  // 服务器浏览器代建：asPrimary=false 不抢账号主绑定；skipPush=true 先不推空包
  // （登录成功后再推真实凭证，避免空包覆盖桌面端已有的好包）
  asPrimary = true,
  skipPush = false,
} = {}) {
  const aid = Number(accountId) || Number(bundle?.id) || 0;
  if (!aid || !provider) {
    return { hydrated: false, profileId: String(targetProfileId || ''), reason: 'no-account-for-provision' };
  }

  let account = bundle;
  if (!account) {
    const dataStore = require('../data-store');
    account = await dataStore.getAccountBundle(aid);
  }
  if (!account) {
    throw new Error(`账号 #${aid} 不存在，无法代建环境`);
  }

  const ownerUserId = Number(
    meta?.ownerUserId
    || account.owner_user_id
    || account.owner_id
    || 0,
  ) || 0;

  const username = String(account.username || '').replace(/^@+/, '').trim() || String(aid);
  const sameName = String(meta?.label || '').trim() || `TK-${username}`;
  const remark = `TkSwarm account #${aid}`;
  const be = backend || meta?.browserBackend || 'tkswarm';
  const { persistBrowserBinding, provisionProfileForAccount } = require('./profile-provision');

  const reusedId = await findLocalAccountEnv(provider, aid, sameName);
  if (reusedId && reusedId !== String(targetProfileId || '').trim()) {
    liveLog(
      `账号 #${aid}：目标 ${String(targetProfileId || '').slice(0, 8) || '—'}… 本机/中心均无包，复用本机同名环境 ${reusedId.slice(0, 8)}…「${sameName}」并关联账号`,
      'warn',
      { accountId: aid },
    );
    await persistBrowserBinding(aid, reusedId, asPrimary, be, ownerUserId);
    // skipPush 时不上传，用 not-local 仅为抑制下面的告警日志
    const pushed = skipPush
      ? { pushed: false, reason: 'not-local' }
      : await pushLocalEnvPack(reusedId, { accountId: aid, provider });
    if (!pushed?.pushed && pushed?.reason !== 'not-local') {
      liveLog(
        `账号 #${aid}：复用环境已绑定，上传中心库未完成：${pushed?.reason || 'unknown'}`,
        'warn',
        { accountId: aid },
      );
    }
    return {
      hydrated: true,
      provisioned: true,
      reused: true,
      profileId: reusedId,
      previousProfileId: String(targetProfileId || ''),
      source: 'provisioned-reuse',
      ownerUserId,
    };
  }

  liveLog(
    `账号 #${aid}：本机与中心库均无环境包 ${String(targetProfileId || '').slice(0, 8) || '—'}…，由当前登录用户代原归属用户#${ownerUserId || '-'} 创建同名同配置环境「${sameName}」`,
    'warn',
    { accountId: aid },
  );

  const created = await provisionProfileForAccount(account, provider, {
    asPrimary,
    browserBackend: be,
    ownerUserId,
    name: sameName,
    remark,
    suffix: '',
  });

  const newPid = String(created.profileId || '').trim();
  if (!newPid) throw new Error('代建环境未返回 ID');

  liveLog(
    `账号 #${aid}：已代建本地环境 ${newPid.slice(0, 8)}…（同名「${sameName}」，归属用户#${ownerUserId || '-'}），正在同步上线…`,
    'info',
    { accountId: aid },
  );

  const pushed = skipPush
    ? { pushed: true }
    : await pushLocalEnvPack(newPid, {
      accountId: aid,
      provider,
    });
  if (!pushed?.pushed) {
    liveLog(
      `账号 #${aid}：代建环境已绑定，但上传中心库失败：${pushed?.reason || 'unknown'}（本机仍可继续使用）`,
      'warn',
      { accountId: aid },
    );
  }

  return {
    hydrated: true,
    provisioned: true,
    profileId: newPid,
    previousProfileId: String(targetProfileId || ''),
    source: 'provisioned',
    ownerUserId,
  };
}

/**
 * 目标环境就绪策略：本机 → 远程包 → 代建。
 * @returns {Promise<{ hydrated: boolean, profileId: string, source?: string, reason?: string, provisioned?: boolean }>}
 */
async function ensureEnvReady(profileId, {
  accountId = 0,
  provider,
  hostId: hostOverride = '',
  bundle = null,
  backend = '',
  autoProvision = true,
} = {}) {
  const pid = String(profileId || '').trim();
  if (!provider) return { hydrated: false, profileId: pid, reason: 'missing-provider' };
  if (!supportsPackSync(provider)) {
    const localOnly = await detailLocal(provider, pid);
    if (localOnly) return { hydrated: false, profileId: pid, source: 'local', reason: 'already-local' };
    if (autoProvision && accountId) {
      return provisionReplacementEnv(pid, {
        accountId,
        provider,
        bundle,
        backend: backend || provider.backendId || 'tkswarm',
      });
    }
    return { hydrated: false, profileId: pid, reason: 'backend-unsupported' };
  }

  // ① 本机已有 → 直接用
  const local = await detailLocal(provider, pid);
  if (local) {
    return { hydrated: false, profileId: pid, source: 'local', reason: 'already-local' };
  }

  // ② 接口查远程包文件
  let meta = null;
  try {
    meta = await fetchPackMeta(pid);
  } catch (e) {
    liveLog(
      `账号 #${accountId || '-'}：查询环境包元数据失败：${e.message || e}`,
      'warn',
      { accountId },
    );
    meta = { exists: false, hasPack: false, profileId: pid };
  }

  // 有效包，或仅有包文件：优先拉包还原，避免误代建把绑定搅乱
  if (meta?.hasPack || (meta?.packFileExists && Number(meta?.packBytes || 0) > 0)) {
    try {
      return await pullRemotePack(pid, {
        accountId,
        provider,
        meta,
        hostId: hostOverride,
      });
    } catch (e) {
      liveLog(
        `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8) || '—'}… 中心库有包但拉取失败（${e.message || e}），将尝试代建恢复`,
        'warn',
        { accountId },
      );
    }
  }

  liveLog(
    `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8) || '—'}… 本机不存在，中心库也无可用环境包`,
    'warn',
    { accountId },
  );

  // ③ 无远程包 → 代建同名同配置并上线关联
  if (!autoProvision) {
    return { hydrated: false, profileId: pid, reason: 'no-cloud-pack' };
  }
  if (!accountId && !bundle?.id) {
    return { hydrated: false, profileId: pid, reason: 'no-cloud-pack' };
  }

  return provisionReplacementEnv(pid, {
    accountId: accountId || bundle.id,
    provider,
    bundle,
    backend: backend || meta?.browserBackend || provider.backendId || 'tkswarm',
    meta,
  });
}

/**
 * 兼容旧调用：仅做「本机缺失时 hydrate / 代建」。
 */
async function ensureLocalEnvHydrated(profileId, opts = {}) {
  return ensureEnvReady(profileId, opts);
}

/**
 * 含 Cookie 的会话包通常远大于此。
 * 默认拒传过小包，避免 1KB 空包盖掉中心库好包（曾导致「检测已登录、任务无 Cookie」）。
 * 设 TKSWARM_ENV_PACK_ALLOW_TINY=1 可强制仍上传；
 * TKSWARM_ENV_PACK_MIN_BYTES 控制阈值（默认 8KB）。
 */
function minEnvPackBytes() {
  const n = Number(process.env.TKSWARM_ENV_PACK_MIN_BYTES);
  if (Number.isFinite(n) && n >= 0) return n;
  return 8 * 1024;
}

function rejectTinyEnvPack() {
  const allow = String(process.env.TKSWARM_ENV_PACK_ALLOW_TINY || '').trim().toLowerCase();
  if (allow === '1' || allow === 'true' || allow === 'on') return false;
  const v = String(process.env.TKSWARM_ENV_PACK_REJECT_TINY || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** 尽力释放跨机租约并触发中心库 FIFO 唤醒（登录上传后 / 关窗 / 失败兜底） */
async function releasePackLeaseBestEffort(profileId, hostOverride = '') {
  const pid = String(profileId || '').trim();
  if (!pid) return null;
  const hid = String(hostOverride || hostId());
  try {
    const data = await phpApi.post(`/node/browser-profiles/${encodeURIComponent(pid)}/pack-lease/release`, {
      hostId: hid,
    });
    const signal = data?.signal || data;
    lastReleaseSignals.set(pid, signal || null);
    if (signal?.nextHostId) {
      liveLog(
        `环境 ${pid.slice(0, 8)}… 已解除占用，通知等待队列下一端：${signal.nextHostId}`,
        'info',
      );
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * 关闭后导出并上传中心库，然后释放租约。
 * 失败只打日志，不抛（避免阻断关闭）。
 * options.skipClose：勿关窗（调用方已关或窗口仍在任务中）；仍会尝试导出，失败则返回。
 * options.forceTiny：兼容旧参数（现默认过小也会传；仅 REJECT_TINY=1 时有用）。
 */
async function pushLocalEnvPack(profileId, {
  accountId = 0,
  provider,
  hostId: hostOverride = '',
  skipClose = false,
  live = false,
  forceTiny = false,
} = {}) {
  const pid = String(profileId || '').trim();
  if (!pid || !provider || !supportsPackSync(provider)) {
    return { pushed: false, reason: 'skip' };
  }
  const hid = String(hostOverride || hostId());
  // 本机无实体时不要去 export/upload，避免刷「环境不存在」误报（常见于批次仍记着旧 ID）
  const local = await detailLocal(provider, pid).catch(() => null);
  if (!local) {
    liveLog(
      `账号 #${accountId || '-'}：跳过环境包上传（本机无环境 ${pid.slice(0, 8)}…）`,
      'info',
      { accountId },
    );
    // 仍释放：开窗时可能已占租约，避免「本机已删环境」把对方锁死
    await releasePackLeaseBestEffort(pid, hid);
    return { pushed: false, reason: 'not-local' };
  }
  let exportPath = '';
  let handoffPath = '';
  try {
    if (!skipClose && !live) {
      await provider.close(pid).catch(() => {});
      // Cookie/SQLite 刷盘需要比「强杀进程」更长的时间；过短会打出 1KB 空包被中心库 422
      await new Promise((r) => setTimeout(r, 2500));
    }
    // live：窗口不关，由浏览器端刷盘后在线打包
    const exported = await provider.exportPack(pid, { live });
    exportPath = String(exported?.filePath || '').trim();
    handoffPath = exportPath;
    if (!exportPath || !fs.existsSync(exportPath)) {
      throw new Error('本地导出未返回有效 filePath');
    }
    const kind = String(exported?.kind || '');
    // 旧版自研浏览器可能回退成目录包；或路径落在中文目录导致 tar 失败。
    // 同步只接受 .tgz：必要时在 ASCII 临时目录再打一包。
    if (kind === 'tkpack' || fs.statSync(exportPath).isDirectory()) {
      throw new Error(
        '本地导出的是目录包(.tkpack)而非 .tgz。请升级/重启「第一页自研浏览器」到 1.0.41+（会话白名单打包）后再同步',
      );
    }
    if (!/\.tgz$/i.test(exportPath)) {
      throw new Error(`本地导出文件不是 .tgz：${path.basename(exportPath)}`);
    }
    // 必须以磁盘真实体积为准（exported.bytes 偶发虚高会漏过空包）
    const localBytes = fs.statSync(exportPath).size;
    const minBytes = minEnvPackBytes();
    const tooSmall = minBytes > 0 && localBytes < minBytes;
    if (tooSmall && rejectTinyEnvPack() && !forceTiny) {
      liveLog(
        `账号 #${accountId || '-'}：环境包过小（${formatPackBytes(localBytes) || localBytes + 'B'} < ${formatPackBytes(minBytes)}），`
        + `已拒绝覆盖中心库（默认拒传空包；需要上传时设 TKSWARM_ENV_PACK_ALLOW_TINY=1）`,
        'warn',
        { accountId },
      );
      return { pushed: false, reason: 'pack-too-small', bytes: localBytes };
    }
    if (tooSmall) {
      liveLog(
        `账号 #${accountId || '-'}：环境包过小（${formatPackBytes(localBytes) || localBytes + 'B'} < ${formatPackBytes(minBytes)}），`
        + `仍上传覆盖中心库（Cookie 可能未刷全，以本机会话日志为准）`,
        'warn',
        { accountId },
      );
    }
    // 若浏览器仍返回中文安装目录下的路径，说明客户端过旧；上传前必须拷到 ASCII Temp
    const uploadTmp = path.join(os.tmpdir(), `tk-env-upload-${pid.slice(0, 12)}-${Date.now()}.tgz`);
    fs.copyFileSync(exportPath, uploadTmp);
    exportPath = uploadTmp;
    const meta = await phpApi.uploadMultipart(
      `/node/browser-profiles/${encodeURIComponent(pid)}/pack`,
      exportPath,
      { fields: { hostId: hid }, fileName: path.basename(exportPath) },
    );
    const bytes = Number(meta?.packBytes || exported.bytes || localBytes || 0) || 0;
    liveLog(
      `账号 #${accountId || '-'}：环境 ${pid.slice(0, 8)}… 已原名替换中心库包 ${pid.replace(/[^a-zA-Z0-9_-]/g, '') || pid.slice(0, 12)}.tgz`
      + `（rev ${meta?.packRevision || '?'}，${formatPackBytes(bytes) || `${Math.round(bytes / 1024)}KB`}）`,
      'info',
      { accountId },
    );
    recordPackRev(pid, meta?.packRevision);
    return { pushed: true, meta };
  } catch (e) {
    let msg = String(e.message || e);
    // 旧客户端把含中文的绝对路径喂给 tar.exe 时的典型乱码
    if (/Failed to open|datalexports|tar\.?exe/i.test(msg) && /[^\x00-\x7F]|\?\?/.test(msg)) {
      msg = `${msg}（安装目录含中文/空格时 Windows tar 会失败：请升级「第一页自研浏览器」到 1.0.36+，将改用 Node 打包并走 Temp 纯英文路径）`;
    }
    liveLog(
      `账号 #${accountId || '-'}：环境包上传失败：${msg}`,
      'warn',
      { accountId },
    );
    return { pushed: false, reason: msg };
  } finally {
    // 成功/失败/过小拒传都释放，避免对方一直卡在等待
    await releasePackLeaseBestEffort(pid, hid);
    for (const p of [exportPath, handoffPath]) {
      if (p && /[\\/](tk-env-upload-|tk-pack-out-)/.test(p)) {
        try { fs.unlinkSync(p); } catch { /* */ }
      }
    }
  }
}

/**
 * 打开前：按策略就绪环境；本机可用时再占租约（防双机）。
 * 若对方占用：等待其登录完成并释放 → 强制拉最新包（含登录凭证）→ 本端继续开窗/自动登录。
 * 可能返回新的 profileId（代建替换时）。
 */
async function prepareEnvForOpen(profileId, opts = {}) {
  const pid = String(profileId || '').trim();
  const { accountId = 0, provider } = opts;
  if (!pid || !provider) return { profileId: pid, hydrated: false };

  let result = await ensureEnvReady(pid, opts);
  const readyId = String(result.profileId || pid).trim();
  if (!supportsPackSync(provider)) return { ...result, profileId: readyId };

  const local = await detailLocal(provider, readyId);
  if (!local) {
    return { ...result, profileId: readyId, lease: false };
  }

  // 本机可用：占租约；对方占用则等待（勿直接抛错打断登录）
  const hid = String(opts.hostId || hostId());
  let lease;
  try {
    lease = await acquirePackLeaseWithWait(readyId, {
      accountId,
      hostId: hid,
      leaseSeconds: 7200,
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (isPackLeaseBusyError(e) || /等待环境释放超时|其它主机/i.test(msg)) {
      throw new Error(msg);
    }
    liveLog(
      `账号 #${accountId || '-'}：占用环境租约告警：${msg}`,
      'warn',
      { accountId },
    );
    return { ...result, profileId: readyId, lease: false };
  }

  if (!lease?.ok) {
    // 无绑定行时 pack-lease 404 — 忽略，交给后续创建
    return { ...result, profileId: readyId, lease: false };
  }

  // 等过对方：强制覆盖拉包，拿到其刚上传的登录 Cookie/环境
  if (lease.waited) {
    let meta = null;
    try {
      meta = await fetchPackMeta(readyId);
    } catch {
      meta = null;
    }
    const hasPack = !!(meta?.hasPack || (meta?.packFileExists && Number(meta?.packBytes || 0) > 0));
    if (hasPack) {
      try {
        liveLog(
          `账号 #${accountId || '-'}：环境 ${readyId.slice(0, 8)}… 正在拉取对方上传的最新登录凭证…`,
          'info',
          { accountId },
        );
        const pulled = await pullRemotePack(readyId, {
          accountId,
          provider,
          meta,
          hostId: hid,
          skipLease: true,
        });
        result = { ...result, ...pulled, waitedForLease: true };
      } catch (e) {
        liveLog(
          `账号 #${accountId || '-'}：等待后拉取最新环境包失败：${e.message || e}（将尝试用本机会话/会话日志继续）`,
          'warn',
          { accountId },
        );
      }
    } else {
      liveLog(
        `账号 #${accountId || '-'}：对方已释放占用，但中心库暂无环境包；将依赖会话日志免表单登录`,
        'warn',
        { accountId },
      );
    }
  }

  // 没等过别人：本机已有旧环境时，若中心库包版本与本机上次同步的不同（别的设备已登录并上传），拉新包覆盖
  if (!lease.waited) {
    try {
      const meta = await fetchPackMeta(readyId);
      const remoteRev = String(meta?.packRevision || '').trim();
      const localRev = getPackRev(readyId);
      const hasPack = !!(meta?.hasPack || (meta?.packFileExists && Number(meta?.packBytes || 0) > 0));
      if (hasPack && remoteRev && localRev && remoteRev !== localRev) {
        liveLog(
          `账号 #${accountId || '-'}：中心库环境包有更新（本机 rev ${localRev} → 中心库 rev ${remoteRev}），拉取最新登录凭证…`,
          'info',
          { accountId },
        );
        const pulled = await pullRemotePack(readyId, {
          accountId,
          provider,
          meta,
          hostId: hid,
          skipLease: true,
        });
        result = { ...result, ...pulled, updatedFromRemote: true };
      }
    } catch (e) {
      liveLog(
        `账号 #${accountId || '-'}：检查/拉取中心库最新环境包失败：${e.message || e}（继续用本机环境）`,
        'warn',
        { accountId },
      );
    }
  }

  return { ...result, profileId: readyId, lease: true, waitedForLease: !!lease.waited };
}

/**
 * 缺包自愈：本机有环境 → 静默导出上传；本机无 → 代建同名同配置后上传。
 * 不打开 TikTok 页面，仅操作本地浏览器环境实体。
 */
async function healPushOrRegenerate(profileId, {
  accountId = 0,
  provider,
  backend = 'tkswarm',
  bundle = null,
  meta = null,
} = {}) {
  const pid = String(profileId || '').trim();
  if (!pid || !provider) {
    return { ok: false, reason: 'missing-profile-or-provider', profileId: pid };
  }
  if (!supportsPackSync(provider)) {
    return { ok: false, reason: 'backend-unsupported', profileId: pid };
  }

  const local = await detailLocal(provider, pid);
  if (local) {
    liveLog(
      `账号 #${accountId || '-'}：缺包补齐 · 本机已有环境 ${pid.slice(0, 8)}…，静默上传中心库`,
      'info',
      { accountId },
    );
    const pushed = await pushLocalEnvPack(pid, { accountId, provider });
    if (!pushed?.pushed) {
      return {
        ok: false,
        reason: pushed?.reason || 'upload-failed',
        profileId: pid,
        source: 'local-upload',
      };
    }
    return {
      ok: true,
      pushed: true,
      profileId: pid,
      previousProfileId: pid,
      source: 'local-upload',
      meta: pushed.meta || null,
    };
  }

  liveLog(
    `账号 #${accountId || '-'}：缺包补齐 · 本机无环境 ${pid.slice(0, 8)}…，将重建后上传`,
    'warn',
    { accountId },
  );

  let remoteMeta = meta;
  if (!remoteMeta) {
    try {
      remoteMeta = await fetchPackMeta(pid);
    } catch {
      remoteMeta = { exists: true, hasPack: false, profileId: pid };
    }
  }

  const provisioned = await provisionReplacementEnv(pid, {
    accountId,
    provider,
    bundle,
    backend: backend || provider.backendId || 'tkswarm',
    meta: remoteMeta,
  });
  const readyId = String(provisioned.profileId || '').trim();
  if (!readyId) {
    return { ok: false, reason: 'provision-failed', profileId: pid, previousProfileId: pid };
  }
  // provision 内已尝试 push；再补一次确保中心库有文件（已有则覆盖 revision）
  const again = await pushLocalEnvPack(readyId, { accountId, provider });
  if (!again?.pushed && again?.reason !== 'not-local') {
    // 若第一次 push 已成功、第二次因瞬时失败，仍以 meta 为准
    let hasPack = false;
    try {
      const m = await fetchPackMeta(readyId);
      hasPack = !!m?.hasPack;
    } catch { /* ignore */ }
    if (!hasPack) {
      return {
        ok: false,
        reason: again?.reason || 'upload-failed-after-provision',
        profileId: readyId,
        previousProfileId: pid,
        source: provisioned.source || 'provisioned',
        provisioned: true,
      };
    }
  }
  return {
    ok: true,
    pushed: true,
    profileId: readyId,
    previousProfileId: pid,
    source: provisioned.source || 'provisioned',
    provisioned: true,
    reused: !!provisioned.reused,
  };
}

module.exports = {
  hostId,
  supportsPackSync,
  fetchPackMeta,
  ensureEnvReady,
  provisionReplacementEnv,
  ensureLocalEnvHydrated,
  pushLocalEnvPack,
  prepareEnvForOpen,
  healPushOrRegenerate,
  acquirePackLeaseWithWait,
  isPackLeaseBusyError,
  releasePackLeaseBestEffort,
  getLastReleaseSignal,
};
