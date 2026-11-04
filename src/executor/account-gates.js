const dataStore = require('./data-store');

async function loadGate(accountId) {
  try {
    const account = await dataStore.getAccountBundle(accountId);
    if (!account) return { ok: false, reason: '账号不存在', account: null };
    return {
      ok: true,
      account,
      hasSession: Boolean(account.has_session || account.cookie),
      capcut: Boolean(account.capcut_authorized),
    };
  } catch (e) {
    return { ok: false, reason: e.message || '账号读取失败', account: null };
  }
}

async function assertPublishGate(accountId, channel = 'bit') {
  const gate = await loadGate(accountId);
  if (!gate.ok) throw new Error(gate.reason);
  if (gate.account.account_status === 'banned') throw new Error('账号已封号，无法发布');
  if (gate.account.login_status !== 'online' && !gate.hasSession) {
    throw new Error('账号未登录且无可用会话（CK），请先扫码/登录辅助或导入 CK');
  }
  if (channel === 'capcut' && !gate.capcut) {
    throw new Error('CapCut 通道需要先完成 CapCut 授权');
  }
  if (channel === 'studio' && !gate.hasSession && gate.account.login_status !== 'online') {
    throw new Error('Studio 通道需要有效登录会话');
  }
  return gate;
}

async function assertChatGate(accountId) {
  const gate = await loadGate(accountId);
  if (!gate.ok) throw new Error(gate.reason);
  const { resolveProfileIdForAccount } = require('./browser/providers');
  const profileId = resolveProfileIdForAccount(gate.account);
  if (!profileId) throw new Error('账号尚未绑定浏览器环境');
  gate.account.browser_profile_id = profileId;
  if (gate.account.login_status !== 'online' && !gate.hasSession) {
    throw new Error('请先完成 TikTok 登录或导入有效 CK');
  }
  return gate;
}

module.exports = { loadGate, assertPublishGate, assertChatGate };
