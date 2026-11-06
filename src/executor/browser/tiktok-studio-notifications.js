/**
 * TikTok 系统通知抓取（主站侧栏 Activity → System Notifications 抽屉）
 *
 * 路径：https://www.tiktok.com/foryou?lang=en
 *    → 左侧栏「Activity」（鼠标真实点击，React 面板靠 pointer 事件）
 *    → 面板里的 System Notifications 条目（DivSystemNotifItemContainer）
 *    → 右侧抽屉（DivInboxContainer）里的通知列表（LiInboxItemWrapper）
 *
 * DOM 特征（class 带构建哈希，按后缀匹配）：
 *   [class*="DivSystemNotifItemContainer"]      Activity 面板里的 System Notifications 入口
 *   [class*="DivInboxContainer"]                通知抽屉
 *   [class*="LiInboxItemWrapper"]               单条通知
 *   [class*="DivSystemNotifListItemHeader"]     分类（Account Updates / Business Account）
 *   [class*="DivSystemNotifListItemTitle"]      标题
 *   [class*="DivSystemNotifListItemBodyText"]   正文 + 时间（最后一个 span 是时间，如 9-24）
 */
const { publish: liveLog } = require('../live-log');

/** 必须先到主站 Feed 页，侧栏才有 Activity（Studio 里的通知页并不存在） */
const HOME_URL = 'https://www.tiktok.com/foryou?lang=en';
const EXPLORE_URL = 'https://www.tiktok.com/explore?lang=en';

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return String(v);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(v);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return String(v);
}

const TITLE_KEYS = ['title', 'subject', 'notice_title', 'noticeTitle', 'name', 'heading'];
const BODY_KEYS = ['content', 'body', 'text', 'notice_content', 'noticeContent', 'description', 'desc', 'message', 'detail'];
const TIME_KEYS = ['create_time', 'created_at', 'time', 'timestamp', 'notice_time', 'publish_time', 'send_time', 'createTime', 'createdAt'];

function pickKey(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') {
      return obj[k];
    }
  }
  return null;
}

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' ').trim();
  if (typeof v === 'object') {
    return asText(v.title || v.text || v.content || v.desc || v.name || v.notice || '');
  }
  return '';
}

/** 从 inbox/notification 接口 JSON 里挖通知条目（DOM 抓不到时的补充） */
function harvestApiNotices(json, out) {
  const walk = (node, depth) => {
    if (!node || depth > 10 || out.length > 400) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const title = asText(pickKey(node, TITLE_KEYS));
    const body = asText(pickKey(node, BODY_KEYS));
    const tm = pickKey(node, TIME_KEYS);
    const id = asText(node.nid || node.notice_id || node.noticeId || '');
    if ((title || body) && !title.includes('[object Object]') && (title.length + body.length) >= 8 && (title.length + body.length) <= 4000) {
      out.push({ title, content: body, time: fmtTime(tm), key: id });
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(json, 0);
}

/** 通知列表下一页游标（has_more + min_time/cursor） */
function noticeCursor(json) {
  let best = null;
  const walk = (node, depth) => {
    if (!node || depth > 6 || best) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const hasMore = node.has_more === 1 || node.has_more === true || node.hasMore === 1 || node.hasMore === true;
    const minTime = node.min_time ?? node.minTime;
    const cursor = node.cursor ?? node.next_cursor ?? node.nextCursor;
    if (hasMore && (minTime || cursor)) {
      best = { minTime: minTime || '', cursor: cursor || '' };
      return;
    }
    Object.values(node).forEach((v) => walk(v, depth + 1));
  };
  walk(json, 0);
  return best;
}

// ---------------------------------------------------------------- 接口探测（不渲染页面）

/** 在已登录页面里直接 fetch TikTok 的通知接口：不导航、不加载 Feed，不会把浏览器拖崩 */
async function probeNoticeApis(page, log) {
  const qs = 'aid=1988&app_name=tiktok_web&device_platform=web_pc&channel=tiktok_web&lang=en';
  const paths = [
    `/api/inbox/notice_list/?${qs}`,
    `/api/inbox/notification/list/?${qs}`,
    `/api/notification/list/?${qs}`,
    `/api/notice/list/?${qs}`,
    `/api/inbox/multi/list/?${qs}`,
  ];
  const found = [];
  const fetchJson = (p) => page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      const text = await r.text();
      return { status: r.status, len: text.length, body: text.slice(0, 300000) };
    } catch (e) {
      return { status: 0, len: 0, body: '', error: String((e && e.message) || e) };
    }
  }, p).catch(() => null);

  for (const path of paths) {
    let url = path;
    const seen = new Set();
    for (let pageNo = 0; pageNo < 6 && url && !seen.has(url); pageNo += 1) {
      seen.add(url);
      const res = await fetchJson(url);
      if (!res) continue;
      if (!res.status) {
        log(`probe ${url}: 请求失败 ${res.error || ''}`);
        break;
      }
      if (res.status >= 400) {
        log(`probe ${url}: HTTP ${res.status}`);
        break;
      }
      let json = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        log(`probe ${url}: 返回不是 JSON（len=${res.len}）`);
        break;
      }
      const keys = Object.keys(json || {}).slice(0, 8).join(',');
      const code = json && (json.status_code !== undefined ? json.status_code : json.statusCode);
      const msg = (json && (json.status_msg || json.statusMsg || json.message)) || '';
      const bucket = [];
      harvestApiNotices(json, bucket);
      log(`probe ${url}: HTTP ${res.status} status_code=${code === undefined ? '-' : code} msg=${String(msg).slice(0, 60)} keys=${keys} items=${bucket.length}`);
      if (!bucket.length && pageNo === 0) {
        log(`probe ${url}: 原始片段 ${String(res.body || '').replace(/\s+/g, ' ').slice(0, 220)}`);
      }
      if (bucket.length) found.push(...bucket);
      const cur = noticeCursor(json);
      if (!cur) break;
      const next = new URL(path, 'https://www.tiktok.com');
      if (cur.cursor) next.searchParams.set('cursor', String(cur.cursor));
      if (cur.minTime) {
        next.searchParams.set('max_time', String(cur.minTime));
        next.searchParams.set('min_time', '0');
      }
      url = `${next.pathname}?${next.searchParams.toString()}`;
    }
  }
  return found;
}

// ---------------------------------------------------------------- 通用：定位 + 鼠标点击

/** 在页面里找元素并返回视口坐标（mouse.click 用），找不到返回 null */
async function findActivityBox(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isActivity = (t) => t === 'activity' || t.startsWith('activity') || t === '活动' || t.startsWith('活动');
    const isNotice = (t) => t === 'notifications' || t === 'notification' || t === '通知';
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
      return { x, y };
    };
    for (const el of document.querySelectorAll('[data-e2e="activity-icon" i], a[href*="/activity"], [data-e2e*="activity" i]')) {
      const b = box(el.closest('a,button,[role="button"],[role="link"],li') || el);
      if (b) return { ...b, label: `e2e:${el.getAttribute('data-e2e') || el.getAttribute('href') || 'activity'}` };
    }
    for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"], li, [data-e2e]')) {
      const txt = norm(el.textContent || '');
      const aria = norm(el.getAttribute('aria-label') || '');
      if (txt.length > 32 && aria.length > 32) continue;
      if (!(isActivity(txt) || isNotice(txt) || isActivity(aria) || isNotice(aria))) continue;
      const b = box(el.closest('a,button,[role="button"],[role="link"]') || el);
      if (b) return { ...b, label: txt || aria };
    }
    return null;
  }).catch(() => null);
}

async function findSystemNotifBox(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
      return { x, y };
    };
    const nodes = [...document.querySelectorAll('[class*="DivSystemNotifItemContainer"]')];
    const scored = nodes.map((n) => ({ n, t: norm(n.textContent || '') }));
    const best = scored.find((x) => x.t.includes('system notification') || x.t.includes('系统通知')) || scored[0];
    if (best) {
      const b = box(best.n) || box(best.n.querySelector('div,p,span'));
      if (b) return { ...b, label: best.t.slice(0, 60) };
    }
    for (const el of document.querySelectorAll('div,button,p,h2,li,span')) {
      if (el.id === 'header-inbox-title' || el.closest('[class*="DivInboxHeaderContainer"]')) continue;
      const t = norm(el.textContent || '');
      if (!t.includes('system notification')) continue;
      if (t.length > 120) continue;
      const b = box(el);
      if (b) return { ...b, label: t.slice(0, 60) };
    }
    return null;
  }).catch(() => null);
}

/**
 * Activity 弹出层里，System Notifications 在列表最底部（Previous 下面）。
 * 在弹出层内向下滚，直到入口卡片有实际尺寸。
 */
async function scrollActivityPanelToSystemNotif(page, log = () => {}) {
  for (let pass = 0; pass < 12; pass += 1) {
    const hit = await page.evaluate(() => {
      const titleOf = (el) => String((el.querySelector('[class*="PTitleText"]') || {}).textContent || '')
        .replace(/\s+/g, ' ').trim();
      const isEntry = (n) => {
        const title = titleOf(n);
        if (!/system notifications?/i.test(title) && !/^系统通知$/.test(title)) return false;
        // 系统通知抽屉里的单条消息不是入口
        if (n.closest('[class*="DivSystemNotifListItem"]')) return false;
        if (n.closest('[class*="LiInboxItemWrapper"]')?.querySelector('[class*="DivSystemNotifListItemTitle"]')) return false;
        return true;
      };
      const nodes = [...document.querySelectorAll('[class*="DivSystemNotifItemContainer"]')].filter(isEntry);
      const pick = (n) => {
        const r = n.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: titleOf(n).slice(0, 80),
        };
      };
      // 优先已有尺寸的
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        if (r.width >= 8 && r.height >= 8 && r.top < window.innerHeight && r.bottom > 0) {
          return { ok: true, ...pick(n), scrolled: false };
        }
      }
      // 滚到第一个入口卡片
      if (nodes[0]) {
        nodes[0].scrollIntoView({ block: 'center', inline: 'nearest' });
        const after = nodes[0].getBoundingClientRect();
        if (after.width >= 8 && after.height >= 8) {
          return { ok: true, ...pick(nodes[0]), scrolled: true };
        }
      }
      // 弹出层列表向下滚一屏
      const root = document.querySelector('[class*="DivActivityContainer"]')
        || document.querySelector('[class*="DivInboxContainer"]')
        || document.querySelector('[class*="DivDrawerContainer"]');
      let scroller = null;
      if (root) {
        const cands = [root, ...root.querySelectorAll('*')];
        let best = 0;
        for (const el of cands) {
          const room = el.scrollHeight - el.clientHeight;
          if (room < 40) continue;
          const st = getComputedStyle(el);
          if (el !== document.scrollingElement && !/auto|scroll|overlay/.test(st.overflowY)) continue;
          if (room > best) {
            best = room;
            scroller = el;
          }
        }
      }
      if (!scroller) return { ok: false, moved: false, total: nodes.length };
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollHeight, before + Math.max(240, scroller.clientHeight * 0.85));
      return { ok: false, moved: scroller.scrollTop !== before, total: nodes.length };
    }).catch(() => null);

    if (hit && hit.ok) {
      if (hit.scrolled) log(`已滚到 System Notifications 入口 ${hit.w}x${hit.h}`);
      return hit;
    }
    if (!hit || !hit.moved) {
      log(`弹出层滚到底仍找不到可点的 System Notifications（节点 ${hit ? hit.total : 0}）`);
      return null;
    }
    log(`弹出层向下滚，找底部的 System Notifications（第 ${pass + 1} 次）`);
    await page.waitForTimeout(450);
  }
  return null;
}

/**
 * 点 Activity 弹出层底部的 System Notifications 入口卡片。
 * 先在弹出层内滚到底，再点有尺寸的 DivSystemNotifItemContainer。
 */
async function clickSystemNotifCard(page, log) {
  const hit = await scrollActivityPanelToSystemNotif(page, log);
  if (!hit || !hit.ok) {
    log('没找到弹出层底部的 System Notifications 入口');
    return false;
  }
  log(`点 System Notifications 入口 ${hit.w}x${hit.h} @${hit.x},${hit.y}`);
  await page.mouse.move(hit.x, hit.y).catch(() => {});
  await page.waitForTimeout(120);
  await page.mouse.click(hit.x, hit.y).catch(() => {});
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const card = el && el.closest('[class*="DivSystemNotifItemContainer"]');
    if (card) card.click();
  }, { x: hit.x, y: hit.y }).catch(() => {});
  return true;
}

async function clickBox(page, box) {
  if (!box) return '';
  try {
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(200);
    await page.mouse.click(box.x, box.y);
  } catch { /* ignore */ }
  return box.label || '';
}

/** 用 Playwright 定位器点击：自动等可见、自动滚动，失败会把原因写进日志 */
async function clickLocator(page, label, locator, log) {
  try {
    const count = await locator.count();
    if (!count) {
      log(`${label}: 未找到`);
      return false;
    }
    const el = locator.first();
    await el.waitFor({ state: 'visible', timeout: 8000 });
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el.click({ timeout: 8000 });
    log(`${label}: 已点击`);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    log(`${label}: 点击失败 ${msg}`);
    return false;
  }
}

/** Activity 入口是否已渲染 */
async function detectActivity(page, timeoutMs, locators) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const [, loc] of locators) {
      if (await loc.count().catch(() => 0) > 0) return true;
    }
    await page.waitForTimeout(600);
  }
  return false;
}

// ---------------------------------------------------------------- 面板 / 抽屉状态

async function panelState(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const nodes = [...document.querySelectorAll('[class*="DivSystemNotifItemContainer"]')];
    const inboxEl = document.querySelector('[class*="DivInboxContainer"]');
    const rows = [...document.querySelectorAll('[class*="LiInboxItemWrapper"]')];
    const drawerEl = document.querySelector('[class*="DivDrawerContainer"], [class*="DivActivityContainer"]');
    return {
      items: nodes.filter(vis).length, // 可见的 System Notifications 条目
      itemsAll: nodes.length, // 含未渲染完成的（判断面板到底有没有出来）
      inbox: !!inboxEl,
      rows: rows.filter(vis).length,
      drawer: vis(drawerEl),
    };
  }).catch(() => ({ items: 0, itemsAll: 0, inbox: false, rows: 0, drawer: false }));
}

const EMPTY_PANEL = { items: 0, itemsAll: 0, inbox: false, rows: 0, drawer: false };

/** 等 Activity 面板出现（条目/抽屉任一出现即算），返回最后一次状态 */
async function waitPanel(page, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let last = EMPTY_PANEL;
  while (Date.now() < end) {
    last = await panelState(page);
    if (last.items > 0 || last.itemsAll > 0 || last.drawer || last.inbox || last.rows > 0) {
      return last;
    }
    await page.waitForTimeout(500);
  }
  return last;
}

/** 面板没打开时，把通知/抽屉相关的可见元素 class 后缀+文本打出来，便于按真实结构调整 */
async function panelDiag(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    const push = (line) => {
      if (seen.has(line)) return;
      seen.add(line);
      out.push(line);
    };
    const clsKey = (el) => {
      const cls = String((el && el.className) || '');
      const one = cls.split(' ').find((c) => c.includes('--')) || cls.split(' ')[0] || '';
      return one.replace(/^css-[a-z0-9]+-/, '').slice(0, 44);
    };
    // 1) 通知抽屉/面板相关容器
    const sel = '[class*="SystemNotif" i], [class*="Inbox" i], [class*="Activity" i], [class*="Drawer" i], [class*="Popover" i], [class*="Panel" i], [role="dialog"], [role="menu"]';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      push(`${el.tagName.toLowerCase()}.${clsKey(el)}:${norm(el.textContent).slice(0, 36)}`);
      if (out.length >= 18) break;
    }
    // 2) 文本以 System Notifications 开头的元素（说明条目在，只是选择器没匹配）
    for (const el of document.querySelectorAll('p,span,h2,h3,div,a,button')) {
      const t = norm(el.textContent);
      if (!t.toLowerCase().startsWith('system notification')) continue;
      if (t.length > 80) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      push(`MATCH ${el.tagName.toLowerCase()}.${clsKey(el)}:${t.slice(0, 40)}`);
      if (out.length >= 26) break;
    }
    return out;
  }).catch(() => []);
}

async function inboxState(page) {
  return page.evaluate(() => {
    const clean = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const inbox = document.querySelector('[class*="DivInboxContainer"]');
    const rows = document.querySelectorAll('[class*="LiInboxItemWrapper"]');
    const titleEl = document.querySelector('#header-inbox-title, [class*="HeaderInboxTitle"], [class*="InboxHeaderTitle"]');
    const title = clean(titleEl);
    // 真正的系统通知行：里面含 SystemNotif 的标题/正文/分类标记
    const sysSel = '[class*="DivSystemNotifListItemTitle"], [class*="DivSystemNotifListItemBodyText"], [class*="DivSystemNotifListItemHeader"]';
    const sysRows = [...rows].filter((n) => n.querySelector(sysSel)).length;
    const sysDirect = document.querySelectorAll('[class*="DivSystemNotifListItemHeader"]').length;
    const titleNorm = title.toLowerCase();
    // 抽屉标题变成 System notifications 才算进去；全部动态标题是 Notifications，不会命中
    const isSysNotif = sysRows > 0 || sysDirect > 0
      || titleNorm === 'system notifications'
      || titleNorm === 'system notification'
      || titleNorm === '系统通知';
    return {
      open: !!inbox || rows.length > 0 || sysDirect > 0,
      rows: rows.length,
      sysRows: sysRows || sysDirect,
      title,
      isSysNotif,
    };
  }).catch(() => ({ open: false, rows: 0, sysRows: 0, title: '', isSysNotif: false }));
}

// ---------------------------------------------------------------- 抽取通知

async function extractInboxItems(page) {
  return page.evaluate(() => {
    const clean = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const TITLE = '[class*="DivSystemNotifListItemTitle"]';
    const drawer = [...document.querySelectorAll('[class*="DivDrawerContainer"]')].find((d) => (
      /system notifications?/i.test(clean(d.querySelector('#header-inbox-title')))
    ));
    const root = drawer
      || document.querySelector('[class*="DivInboxContentContainer"]')
      || document;
    const titleNodes = [...root.querySelectorAll(TITLE)];
    // 每个标题单独成行。整表容器也带 LiInboxItemWrapper 时，querySelector 只会读到第一条。
    let list = [];
    const seenRow = new Set();
    for (const titleEl of titleNodes) {
      let row = titleEl;
      let parent = titleEl.parentElement;
      for (let i = 0; i < 8 && parent; i += 1) {
        if (parent.querySelectorAll(TITLE).length !== 1) break;
        row = parent;
        parent = parent.parentElement;
      }
      if (seenRow.has(row)) continue;
      seenRow.add(row);
      list.push(row);
    }
    const items = [];
    const isTitle = (el) => !!(el && el.matches && el.matches('[class*="DivSystemNotifListItemTitle"]'));
    const isBody = (el) => !!(el && el.matches && el.matches('[class*="DivSystemNotifListItemBodyText"]'));
    for (const n of list) {
      const titleEl = isTitle(n) ? n : n.querySelector('[class*="DivSystemNotifListItemTitle"]');
      let bodyEl = isBody(n) ? n : n.querySelector('[class*="DivSystemNotifListItemBodyText"]');
      if (!bodyEl && titleEl) {
        let sib = titleEl.nextElementSibling;
        for (let i = 0; i < 4 && sib; i += 1) {
          if (isBody(sib)) { bodyEl = sib; break; }
          const inner = sib.querySelector && sib.querySelector('[class*="DivSystemNotifListItemBodyText"]');
          if (inner && sib.querySelectorAll('[class*="DivSystemNotifListItemTitle"]').length === 0) {
            bodyEl = inner;
            break;
          }
          sib = sib.nextElementSibling;
        }
      }
      const headEl = (n.querySelector && n.querySelector('[class*="DivSystemNotifListItemHeader"]'))
        || (titleEl && titleEl.parentElement && titleEl.parentElement.querySelector('[class*="DivSystemNotifListItemHeader"]'));
      const looksLikeTime = (t) => /^(\d{1,2}[-\/]\d{1,2}|\d+\s*(?:s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y|秒|分钟|小时|天|周|个月|年)(?:\s*(?:ago|前))?|刚刚|just now|\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/i.test(String(t || '').trim());
      let title = clean(titleEl);
      let content = '';
      let time = '';
      const timeEl = n.querySelector('time, [class*="NotifTime"], [class*="NotifDate"], [class*="ListItemTime"], [datetime]');
      if (timeEl) {
        time = clean(timeEl) || String(timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || '').trim();
      }
      if (bodyEl) {
        const spans = [...bodyEl.querySelectorAll('span')].map((s) => clean(s)).filter(Boolean);
        if (!time && spans.length) {
          const last = spans[spans.length - 1];
          if (looksLikeTime(last) || last.length <= 16) time = last;
        }
        const bodySpans = spans.filter((s) => s !== time);
        content = bodySpans.length ? bodySpans.join(' ') : clean(bodyEl);
        if (time && content.endsWith(time)) content = content.slice(0, -time.length).trim();
      }
      if (!time) {
        const bits = [...n.querySelectorAll('span, div, time')]
          .map((el) => clean(el))
          .filter((t) => t && t.length <= 24 && looksLikeTime(t));
        if (bits.length) time = bits[bits.length - 1];
      }
      if (!time && content) {
        const tm = content.match(/(?:^|\s)(\d{1,2}[-\/]\d{1,2}|\d+\s*(?:s|m|h|d|w|mo|y)(?:\s*ago)?|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|刚刚)$/i);
        if (tm) {
          time = tm[1];
          content = content.slice(0, content.length - tm[0].length).trim();
        }
      }
      if (!title && content) {
        title = content.slice(0, 80);
      }
      if (!titleEl && !bodyEl) continue;
      if (!title && !content) continue;
      // 入口卡片「System notifications」不是一条通知
      if (/^(system notifications?|系统通知)$/i.test(title) && !content) continue;
      items.push({
        title: title.slice(0, 500),
        content: content.slice(0, 4000),
        time: time.slice(0, 64),
        category: clean(headEl) || 'System Notifications',
      });
    }
    return items;
  }).catch(() => []);
}

/** 抽屉里向下滚一屏。优先滚真正可滚动、且装着通知行的容器。 */
async function scrollInboxOnce(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[class*="DivInboxContainer"]')
      || document.querySelector('[class*="DivSystemNotif"]')
      || document.body;
    const nodes = [root, ...root.querySelectorAll('*')];
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      const room = el.scrollHeight - el.clientHeight;
      if (room < 40 || el.clientHeight < 80) continue;
      const st = getComputedStyle(el);
      if (el !== document.scrollingElement && !/auto|scroll|overlay/.test(st.overflowY)) continue;
      const rows = el.querySelectorAll('[class*="DivSystemNotifListItemTitle"]').length;
      const score = room + rows * 200;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    const target = best || document.scrollingElement;
    if (!target) return false;
    const before = target.scrollTop;
    const step = Math.max(220, Math.floor(target.clientHeight * 0.85));
    target.scrollTop = Math.min(target.scrollHeight, before + step);
    return target.scrollTop !== before;
  }).catch(() => false);
}

function normalizeAndDedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const title = String(it.title || '').replace(/\s+/g, ' ').trim();
    const content = String(it.content || '').replace(/\s+/g, ' ').trim();
    const time = String(it.time || '').replace(/\s+/g, ' ').trim();
    if (!title && !content) continue;
    if ((title + content).length < 6) continue;
    const key = `${String(it.key || '')}|${title}|${content}|${time}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 500),
      content: content.slice(0, 4000),
      time: time.slice(0, 64),
      category: String(it.category || '').slice(0, 64),
      key: String(it.key || '').slice(0, 180),
    });
    if (out.length >= 200) break;
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

/**
 * 抓取系统通知（在已登录的浏览器上下文里调用）
 *
 * 注意：主站 /foryou 会自动播放视频，比特内核容易整窗闪退，
 * 所以这里单独开一个标签页、屏蔽 media/font 资源再进去；失败一律不影响统计数据。
 *
 * @param {import('playwright-core').Page} page
 * @param {{log?:Function, maxScroll?:number}} [opts]
 * @returns {Promise<{pageUrl:string,items:Array,source:string,domCount:number,apiCount:number,error?:string}>}
 */
async function pullStudioNotifications(page, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : (m) => liveLog(`通知：${m}`, 'info', {});
  const apiHits = [];
  let tab = null;
  let ownTab = false;

  const onResponse = async (res) => {
    try {
      if (apiHits.length >= 40) return;
      const url = res.url();
      if (!/notic|inbox|notification|announcement/i.test(url)) return;
      const ct = String(res.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      const json = await res.json().catch(() => null);
      if (!json) return;
      const bucket = [];
      harvestApiNotices(json, bucket);
      if (bucket.length) apiHits.push(...bucket);
    } catch { /* ignore */ }
  };

  const alive = () => {
    try {
      return !!tab && !tab.isClosed();
    } catch {
      return false;
    }
  };
  const connAlive = () => {
    try {
      const b = page.context() && page.context().browser && page.context().browser();
      return b ? !!b.isConnected() : true;
    } catch {
      return true;
    }
  };

  let probed = [];
  try {
    // 0) 先试接口。只拿到很少几条时不能停，列表页上往往还有更多。
    try {
      probed = await probeNoticeApis(page, log);
      const apiItems = normalizeAndDedupe(probed);
      log(apiItems.length
        ? `接口返回 ${apiItems.length} 条（含点赞/评论等，不入库），改打开 System Notifications`
        : '接口没有系统通知列表，改打开 System Notifications');
    } catch (e) {
      log(`接口探测失败：${e.message}`);
    }

    // 1) 独立标签页 + 屏蔽视频/字体/图片（避免主站 Feed 把浏览器拖崩）
    try {
      const ctx = typeof page.context === 'function' ? page.context() : null;
      if (ctx && typeof ctx.newPage === 'function') {
        tab = await ctx.newPage();
        ownTab = true;
        // 注意：拦 media 会让主站 Feed 的播放器报错、整页只剩 "We're having trouble playing this video"，
        // 侧栏（Activity 入口）根本不会渲染，所以这里不做任何资源拦截，只靠独立标签页隔离。
        void tab;
        log('新标签页已就绪');
      } else {
        tab = page;
      }
    } catch (e) {
      log(`新开标签页失败，改用当前页：${e.message}`);
      tab = page;
      ownTab = false;
    }

    try {
      const { installPageCaptchaHooks } = require('./cdp-connect');
      installPageCaptchaHooks(tab);
    } catch { /* ignore */ }

    tab.on('response', onResponse);

    // 1) 主站 Feed 页（侧栏才有 Activity）
    log(`goto ${HOME_URL}`);
    await tab.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      log(`goto 失败：${e.message}`);
    });

    // 2) 等侧栏渲染出 Activity 入口
    const actLocators = [
      ['data-e2e=activity-icon', tab.locator('[data-e2e="activity-icon"]')],
      ['a[href*=/activity]', tab.locator('a[href*="/activity"]')],
      ['[data-e2e*=activity]', tab.locator('[data-e2e*="activity" i]')],
      ['[aria-label*=activity]', tab.locator('[aria-label*="activity" i]')],
      ['[aria-label*=通知]', tab.locator('[aria-label*="通知"]')],
      [':text-is(Activity)', tab.locator(':text-is("Activity")')],
      ['text=Activity 模糊', tab.locator('text=Activity').first()],
    ];
    let actReady = false;
    const shellUp = async (ms) => {
      const end = Date.now() + ms;
      let info = null;
      while (Date.now() < end && alive()) {
        try {
          const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
          await solveRotateCaptchaIfPresent(tab);
        } catch { /* ignore */ }
        info = await tab.evaluate(() => ({
          links: document.querySelectorAll('a').length,
          buttons: document.querySelectorAll('button').length,
          textLen: String((document.body && document.body.innerText) || '').length,
          title: String(document.title || '').slice(0, 40),
          hasLogin: !!document.querySelector('[data-e2e="top-login-button"], a[href*="/login"]'),
          labels: [...document.querySelectorAll('a,button')].slice(0, 20)
            .map((a) => String(a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14))
            .filter(Boolean),
        })).catch(() => null);
        if (info && (info.links >= 8 || info.textLen > 1200)) return info;
        await tab.waitForTimeout(700);
      }
      return info;
    };
    let shell = await shellUp(18000);
    const shellLine = (tag, s) => `${tag}: links=${s ? s.links : 0} buttons=${s ? s.buttons : 0} textLen=${s ? s.textLen : 0} title=${s ? s.title : '-'} 需登录=${s ? (s.hasLogin ? '是' : '否') : '?'} 入口=${s ? s.labels.join('|') : ''}`;
    log(shellLine('shell(/foryou)', shell));
    actReady = await detectActivity(tab, 8000, actLocators);
    if (!actReady && alive()) {
      log('/foryou 没找到 Activity 入口，改用 /explore（同一个侧栏）');
      await tab.goto(EXPLORE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e) => log(`goto explore 失败：${e.message}`));
      shell = await shellUp(18000);
      log(shellLine('shell(/explore)', shell));
      actReady = await detectActivity(tab, 8000, actLocators);
    }
    if (!alive()) {
      log('标签页已关闭（浏览器疑似闪退），停止抓取通知');
      return { pageUrl: '', items: normalizeAndDedupe(apiHits), source: 'none', domCount: 0, apiCount: apiHits.length, error: 'browser-closed' };
    }
    log(`notif page: url=${tab.url()} activityEntry=${actReady ? '已渲染' : '未找到'}`);
    if (!actReady) {
      const diag = await panelDiag(tab);
      log(`侧栏没找到 Activity，页面可见入口：${diag.join(' | ').slice(0, 400)}`);
    }

    // 3) 只点一次 Activity，打开弹出层（不要关）
    //    System Notifications 在弹出层列表最底部（Previous 下面），向下滚再点
    let actOpened = false;
    let st = EMPTY_PANEL;
    for (const [name, loc] of actLocators) {
      if (!alive()) break;
      if (await loc.count().catch(() => 0) === 0) continue;
      if (!(await clickLocator(tab, `Activity(${name})`, loc, log))) continue;
      st = await waitPanel(tab, 8000);
      log(`Activity(${name}) 后面板：itemsAll=${st.itemsAll} items=${st.items} drawer=${st.drawer} inbox=${st.inbox} rows=${st.rows}`);
      if (st.drawer || st.inbox || st.rows > 0 || st.itemsAll > 0 || st.items > 0) {
        actOpened = true;
        break;
      }
      log(`Activity(${name}) 点了但弹出层没出现，换下一个候选`);
    }

    // 4) 在弹出层内滚到底 → 点 System Notifications → 等系统通知列表
    let domItems = [];
    if (alive() && actOpened) {
      st = await panelState(tab);
      log(`panel: itemsAll=${st.itemsAll} items=${st.items} drawer=${st.drawer} inbox=${st.inbox} rows=${st.rows}`);
      const sysClicked = await clickSystemNotifCard(tab, log);
      if (!sysClicked) {
        const diag = await panelDiag(tab);
        log(`没点到弹出层底部的 System Notifications：${diag.join(' | ').slice(0, 500)}`);
      }

      // 5) 等标题变成 System Notifications 的抽屉
      let inbox = await inboxState(tab);
      if (alive()) {
        const endInbox = Date.now() + 10000;
        while (!inbox.isSysNotif && Date.now() < endInbox && alive()) {
          await tab.waitForTimeout(500);
          inbox = await inboxState(tab);
        }
        // 若还停在活动列表，再滚到底部点一次
        if (!inbox.isSysNotif) {
          log('再滚到底部点一次 System Notifications');
          await clickSystemNotifCard(tab, log);
          const end2 = Date.now() + 8000;
          while (!inbox.isSysNotif && Date.now() < end2 && alive()) {
            await tab.waitForTimeout(500);
            inbox = await inboxState(tab);
          }
        }
        log(`inbox: open=${inbox.open} rows=${inbox.rows} sysRows=${inbox.sysRows} title=${inbox.title || '-'} 系统通知=${inbox.isSysNotif ? '是' : '否'}`);
        if (inbox.isSysNotif) {
          const bag = [];
          const take = async () => {
            bag.push(...await extractInboxItems(tab));
          };
          await take();
          const rounds = Number(opts.maxScroll) || 8;
          for (let i = 0; i < rounds; i += 1) {
            const moved = await scrollInboxOnce(tab);
            if (!moved) break;
            await tab.waitForTimeout(700);
            await take();
          }
          domItems = normalizeAndDedupe(bag);
          log(`inbox rows=${domItems.length}`);
          if (domItems.length) {
            const sample = domItems.slice(0, 3)
              .map((i) => `${String(i.title || '').slice(0, 36)}@${i.time || '-'}`)
              .join(' | ');
            log(`样本: ${sample.slice(0, 400)}`);
          } else {
            const rowsText = await tab.evaluate(() => [...document.querySelectorAll('[class*="LiInboxItemWrapper"]')]
              .slice(0, 6)
              .map((n) => String((n.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 50)));
            log(`没解析到系统通知行，抽屉前几行：${rowsText.join(' | ').slice(0, 500)}`);
          }
        } else if (sysClicked) {
          const diag = await panelDiag(tab);
          log(`抽屉没出现，当前可见条目：${diag.join(' | ').slice(0, 500)}`);
        }
      }
    }

    const crashed = !alive() || !connAlive();
    if (crashed) {
      log('浏览器连接已断开（疑似闪退），本次通知未取全');
    }

    if (!domItems.length && !apiHits.length && alive()) {
      const head = await tab.evaluate(() => String((document.body && document.body.innerText) || '')
        .replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
      log(`没有抓到任何通知，url=${tab.url()} head=${head}`);
    }

    const items = domItems;
    log(`collected: system=${items.length}（已忽略接口里的点赞/评论 ${normalizeAndDedupe([...probed, ...apiHits]).length} 条）`);
    return {
      pageUrl: alive() ? tab.url() : '',
      items,
      source: items.length ? 'system-notifications' : 'none',
      domCount: domItems.length,
      apiCount: 0,
      ...(crashed ? { error: 'browser-closed' } : {}),
    };
  } catch (e) {
    log(`通知抓取异常：${e.message}`);
    return {
      pageUrl: '',
      items: [],
      source: 'none',
      domCount: 0,
      apiCount: 0,
      error: e.message,
    };
  } finally {
    try {
      if (tab) tab.off('response', onResponse);
    } catch { /* ignore */ }
    if (ownTab && tab) {
      try {
        await tab.close();
      } catch { /* 浏览器已崩就忽略 */ }
    }
  }
}

module.exports = { pullStudioNotifications, HOME_URL };
