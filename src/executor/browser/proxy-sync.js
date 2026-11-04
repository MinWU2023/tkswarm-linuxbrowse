/**
 * 账号代理 → 浏览器环境 统一同步（比特 / 自研共用 BitBrowserProvider API）
 * 自研浏览器 SOCKS 需本地桥 + proxy_pass 落库；比特引擎原生支持，但写入路径相同。
 *
 * 自愈策略（解决「任务自动推送/测试/拓客 一开就报环境不存在」）：
 *   1) 按当前后端的候选环境依次尝试；
 *   2) 当前后端全部不存在 → 换用账号在其它后端已绑定的环境；
 *   3) 仍然没有 → 自动新建环境并把绑定写回中心库，任务继续跑，不用人工解绑。
 */
const { resolveProxyCredsFromBundle } = require('../proxy-probe');
const {
  getProvider,
  getProviderAsync,
  profileIdCandidatesForBackend,
  labelFor,
  protocolBackendId,
  resolveEffectiveBackend,
  normalizeBackendId,
} = require('./providers');
const { publish: liveLog } = require('../live-log');

function isMissingBrowserProfileError(error) {
  return /不存在|已删除|not\s*found/i.test(String(error?.message || error || ''));
}

/** 从账号 bundle 构造 updateProxy 所需对象；无代理返回 null */
async function buildSyncProxyFromBundle(bundle) {
  if (!bundle?.proxy_host || !bundle?.proxy_port) return null;
  const creds = await resolveProxyCredsFromBundle(bundle);
  return creds || {
    protocol: bundle.proxy_protocol || 'socks5',
    host: bundle.proxy_host,
    port: bundle.proxy_port,
    username: bundle.proxy_username || '',
    password: bundle.proxy_password || '',
  };
}

/**
 * 关闭环境窗口并把代理写入 browses/比特（含回读校验）
 * 注意：必须在 browser/open 之前调用；窗口已打开时禁止再调（会冲掉 SOCKS → 代理错误页）。
 * @param {object} provider BitBrowserProvider
 * @param {string} profileId
 * @param {object|null} syncProxy updateProxy 参数；null 表示清空代理
 * @param {{ skipClose?: boolean }} [opts] skipClose=true 时不写代理（仅占位，调用方应直接跳过）
 */
async function syncProxyToProfile(provider, profileId, syncProxy, opts = {}) {
  const pid = String(profileId || '').trim();
  if (!pid) throw new Error('缺少浏览器环境 ID，无法同步代理');
  if (opts.skipClose) return pid;
  await provider.close(pid).catch(() => {});
  await provider.updateProxy(pid, syncProxy);
  return pid;
}

function proxyHint(syncProxy) {
  return syncProxy ? `${syncProxy.protocol || 'proxy'}://${syncProxy.host}:${syncProxy.port}` : '直连';
}

/** 候选环境 ID：按后端列表 + 主字段，保持先后顺序去重 */
function candidateIds(bundle, backendId, fallbackProfileId) {
  const list = profileIdCandidatesForBackend(bundle, backendId);
  const merged = [];
  for (const id of [...list, String(fallbackProfileId || '').trim()]) {
    const s = String(id || '').trim();
    if (s && !merged.includes(s)) merged.push(s);
  }
  return merged;
}

async function providerAvailable(provider) {
  if (!provider) return false;
  try {
    await provider.health();
    return true;
  } catch {
    return false;
  }
}

/**
 * 选一个真的在运行的后端来新建环境：优先当前后端，其次自研，最后比特。
 * 只按配置猜是没用的——客户端没开就必须跳过，否则报错更难懂。
 */
async function pickProvisionTarget(preferredBackend, currentProvider) {
  const order = [];
  const push = (be, prov) => {
    const key = protocolBackendId(be) || be;
    if (!key || order.some((x) => x.key === key)) return;
    order.push({ key, backend: normalizeBackendId(be) || be, provider: prov });
  };
  push(preferredBackend, currentProvider);
  push('tkswarm', null);
  push('bit', null);

  for (const entry of order) {
    let provider = entry.provider;
    if (!provider) {
      try {
        await getProviderAsync(entry.key).catch(() => {});
        provider = getProvider(entry.key);
      } catch {
        continue;
      }
    }
    if (await providerAvailable(provider)) {
      return { backend: entry.backend, provider };
    }
  }
  return null;
}

/**
 * 打开环境前确保代理与中心库一致（所有自动化入口应调用，不仅登录）
 * @param {object} bundle 账号 bundle
 * @param {{ profileId?: string, provider?: object, accountId?: number, backend?: string, autoProvision?: boolean, skipProxyWrite?: boolean }} [opts]
 * skipProxyWrite：总任务窗口已打开且本批已同步过代理时必须为 true，禁止再 close+updateProxy。
 */
async function ensureAccountProxySynced(bundle, {
  profileId,
  provider,
  accountId = 0,
  backend,
  autoProvision = true,
  skipProxyWrite = false,
} = {}) {
  if (!bundle) return { profileId, provider };
  const syncProxy = await buildSyncProxyFromBundle(bundle);
  const backendId = backend || resolveEffectiveBackend(bundle);
  const label = labelFor(backendId);

  const tried = new Set();
  const tryIds = candidateIds(bundle, backendId, profileId);
  if (!tryIds.length && !autoProvision) return { profileId, provider };

  let currentProvider = provider || getProvider(protocolBackendId(backendId));
  let lastMissingError = null;

  // ① 只处理「目标环境」：本机 → 中心库包 → 同名同配置代建
  //    禁止因本机另有旧环境（如 afc9bd95）就擅自切走主绑。
  const { ensureEnvReady, prepareEnvForOpen } = require('./env-pack-sync');
  const ownerUserId = Number(bundle.owner_id || bundle.owner_user_id || 0) || 0;
  const targetId = String(profileId || tryIds[0] || '').trim();
  const primaryId = targetId;

  const finishWithPid = async (pid, {
    skipped = false,
    bindAsPrimary = false,
    previousId = '',
  } = {}) => {
    if (skipped) {
      if (accountId) {
        liveLog(
          `账号 #${accountId}：${label}环境已在本批同步过代理，跳过关窗重写（避免冲成代理错误页）`,
          'info',
          { accountId },
        );
      }
      if (bindAsPrimary && accountId && pid) {
        try {
          const { persistBrowserBinding } = require('./profile-provision');
          await persistBrowserBinding(accountId, pid, true, backendId, ownerUserId);
        } catch (e) {
          liveLog(`账号 #${accountId}：写入环境绑定失败：${e.message || e}`, 'warn', { accountId });
        }
      }
      return { profileId: pid, provider: currentProvider, skippedProxy: true };
    }
    await syncProxyToProfile(currentProvider, pid, syncProxy);
    if (bindAsPrimary && accountId && pid) {
      try {
        const { persistBrowserBinding } = require('./profile-provision');
        await persistBrowserBinding(accountId, pid, true, backendId, ownerUserId);
        if (previousId && previousId !== pid) {
          liveLog(
            `账号 #${accountId}：目标环境不可用，已代建并关联新环境 ${pid.slice(0, 8)}…（替换 ${previousId.slice(0, 8)}…）`,
            'warn',
            { accountId },
          );
        }
      } catch (e) {
        liveLog(`账号 #${accountId}：写入环境绑定失败：${e.message || e}`, 'warn', { accountId });
      }
    }
    if (accountId) {
      liveLog(`账号 #${accountId}：${label}环境代理已同步（${proxyHint(syncProxy)}）`, 'info', { accountId });
    }
    return { profileId: pid, provider: currentProvider };
  };

  if (targetId) {
    tried.add(targetId);
    try {
      const ready = await ensureEnvReady(targetId, {
        accountId,
        provider: currentProvider,
        bundle,
        backend: backendId,
        autoProvision: true,
      });
      const readyId = String(ready?.profileId || targetId).trim();
      const local = await currentProvider.detail(readyId).catch(() => null);
      if (local && (local.id || local.name)) {
        if (!skipProxyWrite && ready?.source === 'local') {
          await prepareEnvForOpen(readyId, {
            accountId,
            provider: currentProvider,
            bundle,
            backend: backendId,
            autoProvision: false,
          }).catch((e) => {
            if (/其它主机/i.test(String(e.message || e))) throw e;
          });
        }
        // 仅「代建替换」才改主绑；本机命中 / 拉包还原不切到其它环境 ID
        const bindAsPrimary = Boolean(ready?.provisioned) && readyId !== targetId;
        return await finishWithPid(readyId, {
          skipped: skipProxyWrite,
          bindAsPrimary,
          previousId: targetId,
        });
      }
      lastMissingError = new Error(ready?.reason || '环境就绪失败');
    } catch (e) {
      if (/其它主机/i.test(String(e.message || e))) throw e;
      liveLog(
        `账号 #${accountId}：目标环境 ${targetId.slice(0, 8)}… 就绪失败：${e.message || e}`,
        'warn',
        { accountId },
      );
      lastMissingError = e;
    }
  }

  // ② 账号在其它后端还有绑定（常见：主字段是已删的比特环境，自研列才是活的）
  for (const other of ['tkswarm', 'bit', 'linux']) {
    if (protocolBackendId(other) === protocolBackendId(backendId)) continue;
    const ids = candidateIds(bundle, other, '').filter((id) => !tried.has(id));
    if (!ids.length) continue;
    let otherProvider = null;
    try {
      await getProviderAsync(protocolBackendId(other)).catch(() => {});
      otherProvider = getProvider(protocolBackendId(other));
    } catch {
      continue;
    }
    for (const pid of ids) {
      tried.add(pid);
      try {
        await syncProxyToProfile(otherProvider, pid, syncProxy);
        liveLog(`账号 #${accountId}：${label}环境不存在，改用${labelFor(other)}环境 ${pid.slice(0, 8)}…`, 'warn', { accountId });
        return { profileId: pid, provider: otherProvider, backend: other };
      } catch (e) {
        if (!isMissingBrowserProfileError(e)) {
          lastMissingError = e;
        }
      }
    }
  }

  // ③ 都没有 → 换可用后端代建同名同配置并上线关联原账号
  if (autoProvision && accountId) {
    const target = await pickProvisionTarget(backendId, currentProvider);
    if (target) {
      try {
        const ready = await ensureEnvReady(primaryId || `account-${accountId}`, {
          accountId,
          provider: target.provider,
          bundle,
          backend: target.backend,
          autoProvision: true,
        });
        const readyId = String(ready?.profileId || '').trim();
        if (!readyId) throw new Error(ready?.reason || '代建未返回环境 ID');
        await syncProxyToProfile(target.provider, readyId, syncProxy);
        liveLog(
          `账号 #${accountId}：原环境不可用且中心无包，已代建并关联 ${readyId.slice(0, 8)}…（${proxyHint(syncProxy)}；新环境无旧登录态）`,
          'warn',
          { accountId },
        );
        return {
          profileId: readyId,
          provider: target.provider,
          backend: target.backend,
          provisioned: true,
        };
      } catch (e) {
        throw new Error(
          `账号 #${accountId} 的浏览器环境已不存在，自动代建也失败了：${e.message || e}。`
          + '请确认第一页自研浏览器已登录并保持运行，然后重试',
        );
      }
    }
  }

  const detail = String(lastMissingError?.message || lastMissingError || '浏览器环境不存在或已删除')
    // provider 层会附「请在账号里解绑后重新创建」，现在已能自动重建，这句会误导用户
    .replace(/。?请在账号里解绑后重新「创建环境」。?/g, '。')
    .replace(/原错误：/g, '原因：')
    .trim();
  throw new Error(
    `账号 #${accountId} 的浏览器环境失效：${detail}。`
    + '已尝试改用其它后端并自动新建，都未成功；请确认第一页自研浏览器已登录并保持运行后重试',
  );
}

module.exports = {
  buildSyncProxyFromBundle,
  syncProxyToProfile,
  ensureAccountProxySynced,
  isMissingBrowserProfileError,
  candidateIds,
  pickProvisionTarget,
};
