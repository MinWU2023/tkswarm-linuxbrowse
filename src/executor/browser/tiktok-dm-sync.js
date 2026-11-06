const crypto = require('node:crypto');
const dataStore = require('../data-store');
const { translateText } = require('../translator');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { inspectTikTokSession } = require('./cdp-client');

async function setting(key, fallback) {
  try {
    return await dataStore.getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

async function getCookieAndFingerprint(accountId) {
  const bundle = await dataStore.getAccountBundle(accountId);
  if (!bundle) throw new Error('账号不存在');
  const { resolveProfileIdForAccount } = require('./providers');
  return {
    cookie: bundle?.cookie || '',
    fingerprint: bundle?.fingerprint || bundle?.session_fingerprint || '',
    dmChannel: bundle?.dm_channel || 'auto',
    browserProfileId: resolveProfileIdForAccount(bundle) || '',
    username: bundle?.username || '',
  };
}

function parseCookieMap(cookie) {
  const map = {};
  String(cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) map[k] = v;
  });
  return map;
}

function hashId(...parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 32);
}

/** 纯 HTTP 探测 TikTok Web IM（无签名时常失败 → unsupported） */
async function fetchInboxViaApi(cookie, fingerprint) {
  if (!cookie) {
    return { ok: false, status: 'unsupported', reason: '账号无 CK，无法走 API 模式' };
  }
  const jar = parseCookieMap(cookie);
  const msToken = jar.msToken || jar.mstoken || '';
  const verifyFp = jar.s_v_web_id || jar.verifyFp || fingerprint || '';
  const csrf = jar['tt-csrf-token'] || jar.tt_csrf_token || '';
  const qs = new URLSearchParams({
    aid: '1988',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    channel: 'tiktok_web',
  });
  if (msToken) qs.set('msToken', msToken);
  if (verifyFp) qs.set('verifyFp', String(verifyFp).slice(0, 128));

  const endpoints = [
    `https://www.tiktok.com/api/im/conversation/list/?${qs}`,
    `https://www.tiktok.com/api/im/v1/conversation/list/?${qs}`,
    `https://www.tiktok.com/api/inbox/notice_list/?${qs}`,
    `https://www.tiktok.com/api/inbox/multi/list/?${qs}`,
  ];
  const headers = {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.tiktok.com/messages',
    Origin: 'https://www.tiktok.com',
  };
  if (csrf) headers['x-tt-csrf-token'] = csrf;
  if (fingerprint) headers['X-Bogus'] = String(fingerprint).slice(0, 128);

  const errors = [];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        errors.push(`${url.split('?')[0]} → HTTP ${res.status}`);
        continue;
      }
      if (!data || data.status_code === 8 || data.statusCode === 8 || data.status_code === 2483) {
        errors.push(`${url.split('?')[0]} → 登录态无效或风控`);
        continue;
      }
      const conversations = normalizeConversations(data);
      if (conversations?.length) {
        return { ok: true, status: 'ok', source: 'api-http', conversations, rawEndpoint: url.split('?')[0] };
      }
      errors.push(`${url.split('?')[0]} → 响应无法解析为会话列表`);
    } catch (e) {
      errors.push(`${String(url).split('?')[0]} → ${e.message}`);
    }
  }
  return {
    ok: false,
    status: 'unsupported',
    reason: 'TikTok IM HTTP API 探测失败（需签名/风控）。可开启浏览器降级。',
    errors,
  };
}

function normalizeConversations(data) {
  const list = data?.conversation_list
    || data?.conversations
    || data?.data?.conversation_list
    || data?.data?.conversations
    || data?.data?.conversationList
    || data?.inbox?.conversations
    || data?.body?.conversation_list
    || null;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((c) => normalizeOneConversation(c)).filter((x) => x.uid);
}

function normalizeOneConversation(c) {
  const peer = c.participant || c.user || c.to_user || c.peer || c.user_info || c.opponent || {};
  const uid = String(
    c.conversation_id || c.cid || c.conversationId
    || peer.uid || peer.id || peer.user_id || peer.sec_uid || ''
  );
  const username = peer.unique_id || peer.uniqueId || peer.username || peer.nick_name || peer.display_name || uid;
  const nickname = peer.nickname || peer.nick_name || peer.display_name || username;
  const last = c.last_message || c.latest_message || c.message || c.lastMessage || {};
  const lastText = last.content || last.text || last.body || last.msg_content || c.last_message_content || '';
  const externalId = last.server_message_id || last.message_id || last.id || last.client_message_id || null;
  const unread = Number(c.unread_count || c.badge_count || c.unreadCount || 0) || 0;
  const fromMe = !!(last.is_self || last.from_me || last.isSelf || last.sender === 'me' || last.direction === 'out');
  return {
    uid: uid || String(username),
    conversationId: String(c.conversation_id || c.cid || c.conversationId || uid || ''),
    username: String(username || uid),
    nickname: String(nickname || username || uid),
    avatar: peer.avatar_url || peer.avatar || peer.avatarThumb || '',
    lastText: String(lastText || '').slice(0, 500),
    externalId: externalId ? String(externalId) : null,
    unread,
    direction: fromMe ? 'out' : 'in',
    messages: Array.isArray(c.messages) ? c.messages.map(normalizeOneMessage).filter(Boolean) : [],
  };
}

function normalizeOneMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const content = String(m.content || m.text || m.body || m.msg_content || '').trim();
  if (!content) return null;
  const fromMe = !!(m.is_self || m.from_me || m.isSelf || m.sender === 'me' || m.direction === 'out');
  const externalId = m.server_message_id || m.message_id || m.id || m.client_message_id || null;
  return {
    content: content.slice(0, 4000),
    direction: fromMe ? 'out' : 'in',
    externalId: externalId ? String(externalId) : null,
    createdAt: m.create_time || m.created_at || m.timestamp || null,
  };
}

function normalizeMessagesPayload(data) {
  const list = data?.message_list
    || data?.messages
    || data?.data?.message_list
    || data?.data?.messages
    || data?.body?.message_list
    || null;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeOneMessage).filter(Boolean);
}

async function maybeTranslateIn(friend, text) {
  if (!friend || !text) return '';
  if (!friend.translate_in) return '';
  try {
    const r = await translateText(text, {
      from: friend.translate_source || 'auto',
      to: friend.translate_target || 'zh',
    });
    return r.text || '';
  } catch {
    return '';
  }
}

async function persistConversations(accountId, conversations) {
  const friends = [];
  const messages = [];
  for (const item of conversations || []) {
    friends.push({
      friendUid: item.uid,
      username: item.username,
      nickname: item.nickname,
      avatarUrl: item.avatar || '',
      relation: item.relation || 'stranger',
      unreadCount: item.unread || 0,
      lastMessage: (item.lastText || '').slice(0, 200),
      lastDirection: item.direction || 'in',
      isNew: true,
    });
    const msgs = item.messages?.length
      ? item.messages
      : (item.lastText
        ? [{ content: item.lastText, direction: item.direction || 'in', externalId: item.externalId }]
        : []);
    for (const msg of msgs) {
      if (!msg.content) continue;
      const translated = (msg.direction || 'in') === 'in'
        ? await maybeTranslateIn({ translate_in: false }, msg.content)
        : '';
      messages.push({
        friendId: 0,
        friendUid: item.uid,
        username: item.username,
        content: msg.content,
        direction: msg.direction || 'in',
        translated,
        externalId: msg.externalId || `h:${hashId(accountId, item.uid, msg.direction || 'in', String(msg.content).slice(0, 80))}`,
      });
    }
  }
  const result = await dataStore.dmIngest({ accountId, friends, messages, lastError: '' });
  return {
    friendsUpserted: result?.friends || friends.length,
    messagesUpserted: result?.messages || messages.length,
  };
}

function mergeConversations(a, b) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    const key = item.uid || item.username;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item, messages: item.messages || [] });
    } else {
      map.set(key, {
        ...prev,
        ...item,
        lastText: item.lastText || prev.lastText,
        messages: mergeMessages(prev.messages || [], item.messages || []),
      });
    }
  }
  return [...map.values()];
}

function mergeMessages(a, b) {
  const seen = new Set();
  const out = [];
  for (const m of [...a, ...b]) {
    const key = m.externalId || `${m.direction}:${m.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

async function scrapeConversationsDom(page, limit) {
  const rows = await page.evaluate((max) => {
    const out = [];
    const nodes = [...document.querySelectorAll('[data-e2e*="chat-list"] [data-e2e*="list-item"], [class*="DivConversation"], [class*="conversation-item"], a[href*="/messages"]')];
    const pool = nodes.length ? nodes : [...document.querySelectorAll('[role="listitem"], li')];
    for (const el of pool) {
      const text = (el.innerText || '').trim();
      if (!text || text.length < 2) continue;
      const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      if (!lines.length) continue;
      const username = lines[0].replace(/^@/, '').slice(0, 80);
      if (!username || /^(Messages|私信|Inbox|New chat|新建)/i.test(username)) continue;
      const lastText = lines.slice(1).join(' ').slice(0, 200);
      const href = el.closest('a')?.getAttribute('href') || el.getAttribute('href') || '';
      out.push({ username, nickname: username, lastText, href, uid: username });
      if (out.length >= max) break;
    }
    return out;
  }, limit).catch(() => []);
  return (rows || []).map((r) => ({
    uid: r.uid || r.username,
    username: r.username,
    nickname: r.nickname || r.username,
    avatar: '',
    lastText: r.lastText || '',
    externalId: null,
    unread: 0,
    direction: 'in',
    messages: [],
    _href: r.href || '',
  }));
}

async function openConversationInList(page, conv) {
  const handle = conv.username || conv.uid;
  if (!handle) return false;
  const byText = page.getByText(handle, { exact: false }).first();
  if (await byText.count().catch(() => 0)) {
    await byText.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  if (conv._href) {
    await page.goto(conv._href.startsWith('http') ? conv._href : `https://www.tiktok.com${conv._href}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

async function scrapeMessagesDom(page, limit) {
  const rows = await page.evaluate((max) => {
    const out = [];
    const bubbles = [...document.querySelectorAll('[data-e2e*="message"], [class*="DivMessage"], [class*="message-item"], [class*="ChatMessage"]')];
    for (const el of bubbles) {
      const text = (el.innerText || '').trim();
      if (!text || text.length > 4000) continue;
      const cls = `${el.className || ''} ${el.getAttribute('data-e2e') || ''}`.toLowerCase();
      const fromMe = /self|outgoing|mine|send|out/.test(cls);
      out.push({ content: text.split(/\n/)[0].slice(0, 4000), direction: fromMe ? 'out' : 'in' });
      if (out.length >= max) break;
    }
    return out;
  }, limit).catch(() => []);
  return rows || [];
}

/** Bit 打开 /messages：优先拦截真实 IM XHR，失败则 DOM 只读爬取 */
async function fetchInboxViaBit(accountId, opts = {}) {
  const maxConversations = Math.min(40, Math.max(3, Number(opts.maxConversations) || 15));
  const maxMessagesPerChat = Math.min(50, Math.max(1, Number(opts.maxMessagesPerChat) || 12));
  const isLinux = String(opts.browserBackend || '').toLowerCase() === 'linux';
  const connection = await connectAccount(
    accountId,
    'https://www.tiktok.com/messages',
    'message',
    isLinux ? { browserBackend: 'linux' } : {},
  );
  const captured = [];
  let holdForLogin = false;
  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!/tiktok\.com\/api\/.*(im|inbox|message|conversation)/i.test(url)) return;
      if (!response.ok()) return;
      const data = await response.json().catch(() => null);
      if (data) captured.push({ url, data });
    } catch { /* ignore */ }
  };
  try {
    if (isLinux) {
      // 服务器浏览器：先检测登录 → 注入同步登录数据 → 一键/表单登录 → 登录页填表；登录后才同步私信
      await require('./seat-tasks').ensureSeatLoggedIn(connection, accountId, { label: '同步私信' });
    } else {
      const session = await inspectTikTokSession(connection.ws);
      if (!session.loggedIn) {
        return { ok: false, status: 'unsupported', reason: '浏览器环境未检测到 TikTok 登录态' };
      }
    }
    connection.page.on('response', onResponse);
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(connection.page, { accountId });
    } catch { /* ignore */ }
    await connection.page.waitForTimeout(2500);
    for (let i = 0; i < 4; i += 1) {
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(connection.page, { accountId });
      } catch { /* ignore */ }
      await connection.page.evaluate(() => {
        const panes = [...document.querySelectorAll('[class*="conversation"],[class*="inbox"],[data-e2e*="chat"],aside,nav')];
        const el = panes.find((n) => n.scrollHeight > n.clientHeight + 20) || document.scrollingElement;
        if (el) el.scrollTop = el.scrollHeight;
      }).catch(() => {});
      await connection.page.waitForTimeout(800);
    }

    let conversations = [];
    for (const item of captured) {
      const list = normalizeConversations(item.data);
      if (list?.length) conversations = mergeConversations(conversations, list);
      const msgs = normalizeMessagesPayload(item.data);
      if (msgs.length && conversations.length) {
        const last = conversations[conversations.length - 1];
        last.messages = mergeMessages(last.messages || [], msgs);
      }
    }

    if (!conversations.length) {
      conversations = await scrapeConversationsDom(connection.page, maxConversations);
    } else {
      conversations = conversations.slice(0, maxConversations);
    }

    if (!conversations.length) {
      return {
        ok: false,
        status: 'unsupported',
        reason: '打开消息页后未解析到会话（结构变化或空收件箱）',
        capturedApis: captured.map((c) => c.url.split('?')[0]),
      };
    }

    for (let i = 0; i < Math.min(conversations.length, maxConversations); i += 1) {
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(connection.page, { accountId });
      } catch { /* ignore */ }
      const conv = conversations[i];
      const beforeCount = captured.length;
      const opened = await openConversationInList(connection.page, conv);
      if (!opened) continue;
      await connection.page.waitForTimeout(1200);
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(connection.page, { accountId });
      } catch { /* ignore */ }
      for (let j = beforeCount; j < captured.length; j += 1) {
        const msgs = normalizeMessagesPayload(captured[j].data);
        if (msgs.length) conv.messages = mergeMessages(conv.messages || [], msgs);
        const more = normalizeConversations(captured[j].data);
        if (more?.length) {
          const hit = more.find((x) => x.uid === conv.uid || x.username === conv.username);
          if (hit?.messages?.length) conv.messages = mergeMessages(conv.messages || [], hit.messages);
        }
      }
      if (!(conv.messages && conv.messages.length)) {
        const domMsgs = await scrapeMessagesDom(connection.page, maxMessagesPerChat);
        if (domMsgs.length) {
          conv.messages = mergeMessages(conv.messages || [], domMsgs);
          if (!conv.lastText && domMsgs[domMsgs.length - 1]) {
            conv.lastText = domMsgs[domMsgs.length - 1].content;
            conv.direction = domMsgs[domMsgs.length - 1].direction;
          }
        }
      }
      if (conv.messages?.length > maxMessagesPerChat) {
        conv.messages = conv.messages.slice(-maxMessagesPerChat);
      }
    }

    return {
      ok: true,
      status: 'ok',
      source: captured.length ? 'bit-intercept' : 'bit-dom',
      conversations,
      capturedApis: [...new Set(captured.map((c) => c.url.split('?')[0]))],
    };
  } catch (e) {
    // 等待登录：窗口留给 VNC 人工完成验证，不关窗
    if (e?.waiting) holdForLogin = true;
    throw e;
  } finally {
    try { connection.page.off('response', onResponse); } catch { /* ignore */ }
    if (holdForLogin) {
      try { await closeConnection(connection, { force: false, keepAlive: true }); } catch { /* ignore */ }
    } else {
      await closeConnection(connection);
    }
  }
}

/** 同步单个账号私信：API HTTP →（可选）Bit 拦截/爬取 */
async function syncAccountDm(accountId, opts = {}) {
  const sessionInfo = await getCookieAndFingerprint(accountId);
  const { cookie, fingerprint, dmChannel, browserProfileId } = sessionInfo;

  const globalMode = String(await setting('messageSyncMode', 'api') || 'api');
  const bitFallback = (await setting('dmSyncBitFallback', true)) !== false;

  const forceBit = opts.preferBit === true
    || dmChannel === 'browser'
    || globalMode === 'browser'
    || opts.via === 'bit';

  let fetched = null;
  const attempts = [];

  if (!forceBit && (dmChannel === 'api' || dmChannel === 'auto')) {
    if (!cookie && dmChannel === 'api') {
      return { status: 'skipped', reason: 'api 通道需要 CK', accountId };
    }
    if (cookie) {
      fetched = await fetchInboxViaApi(cookie, fingerprint);
      attempts.push({ via: 'api-http', ok: fetched.ok, reason: fetched.reason });
    } else {
      attempts.push({ via: 'api-http', ok: false, reason: '无 CK' });
    }
  }

  const needBit = forceBit
    || (!fetched?.ok && bitFallback && (dmChannel === 'auto' || dmChannel === 'browser' || globalMode === 'browser' || dmChannel === 'api'));

  if ((!fetched || !fetched.ok) && needBit) {
    if (!browserProfileId) {
      const reason = fetched?.reason || '无浏览器环境，无法降级爬取';
      await dataStore.dmIngest({ accountId, friends: [], messages: [], lastError: reason }).catch(() => {});
      return {
        status: fetched?.status || 'unsupported',
        reason,
        errors: fetched?.errors || [],
        attempts,
        accountId,
      };
    }
    try {
      fetched = await fetchInboxViaBit(accountId, opts);
      attempts.push({ via: fetched.source || 'bit', ok: fetched.ok, reason: fetched.reason });
    } catch (e) {
      // 等待登录（WAITING_LOGIN_DATA）必须抛给上层，由队列软等待重试，不能吞成「同步失败」
      if (e?.waiting) throw e;
      attempts.push({ via: 'bit', ok: false, reason: e.message });
      fetched = {
        ok: false,
        status: 'unsupported',
        reason: `浏览器私信同步失败：${e.message}`,
        errors: [e.message],
      };
    }
  }

  if (!fetched?.ok) {
    const reason = fetched?.reason || '私信同步未成功';
    await dataStore.dmIngest({ accountId, friends: [], messages: [], lastError: reason }).catch(() => {});
    return {
      status: fetched?.status || 'unsupported',
      reason,
      errors: fetched?.errors || [],
      attempts,
      accountId,
    };
  }

  const { friendsUpserted, messagesUpserted } = await persistConversations(accountId, fetched.conversations || []);

  return {
    status: 'success',
    accountId,
    friendsUpserted,
    messagesUpserted,
    source: fetched.source || 'api',
    endpoint: fetched.rawEndpoint || null,
    capturedApis: fetched.capturedApis || [],
    attempts,
  };
}

module.exports = {
  syncAccountDm,
  fetchInboxViaApi,
  fetchInboxViaBit,
};
