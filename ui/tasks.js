const API = window.location.origin || 'http://127.0.0.1:54345';
const TOKEN_KEY = 'tkswarm_lb_token';
const SEEN_KEY = 'tkswarm_lb_seen';

let state = {
  page: 1,
  pageSize: 20,
  pages: 1,
  total: 0,
  status: 'pending',
  keyword: '',
  source: 'all',
  items: [],
};

/** 仅内存：刷新页面即清空 */
const logCache = new Map();
let logViewer = {
  open: false,
  taskKey: '',
  title: '',
  itemId: 0,
  pollTimer: null,
};

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(SEEN_KEY, '1');
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SEEN_KEY);
  }
}

function authHeaders(extra = {}) {
  const h = { Accept: 'application/json', ...extra };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function json(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function show(el, on) {
  document.querySelector(el)?.classList.toggle('hidden', !on);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(message, type = 'info') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-msg">${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

const STATUS_LABEL = {
  draft: '草稿',
  queued: '排队中',
  pending: '待执行',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const TYPE_LABEL = {
  ai_lead: 'AI 拓客',
  ai_lead_dm: 'AI 拓客私信',
  chat_seat: '客服坐席',
  account_work: '矩阵任务',
  message: '私信',
  dm_reply: '客服发信',
  sync_fans: '同步粉丝',
  sync_following: '同步关注',
  dm_sync: '私信同步',
  cs_login: '客服登录',
  cs_logout: '客服退出',
  cs_detect: '客服检测登录',
};

function statusBadge(st) {
  const s = String(st || '');
  const label = STATUS_LABEL[s] || s || '-';
  let cls = 'badge';
  if (s === 'queued' || s === 'pending' || s === 'paused') cls += ' warn';
  else if (s === 'running') cls += ' info';
  else if (s === 'completed') cls += ' success';
  else if (s === 'failed') cls += ' danger';
  return `<span class="${cls}">${esc(label)}</span>`;
}

function typeLabel(x) {
  if (x.typeLabel) return x.typeLabel;
  const k = String(x.taskType || x.type || '');
  return TYPE_LABEL[k] || k || '-';
}

function progressText(x) {
  const ok = Number(x.success_count || 0);
  const fail = Number(x.fail_count || 0);
  const total = Number(x.total_count || 0);
  const pending = Number(x.pending_count || 0);
  if (x.kind === 'account_work') {
    if (!total) return pending ? `${pending} 待执行` : '-';
    return `${ok + fail} / ${total}${pending ? `（待 ${pending}）` : ''}`;
  }
  if (!total) return `${ok + fail} / -`;
  return `${ok + fail} / ${total}`;
}

function idCell(x) {
  if (x.kind === 'account_work') {
    return `<code>B#${esc(x.workBatchId || String(x.id).replace(/^awb-/, ''))}</code>`;
  }
  return `<code>#${esc(x.id)}</code>`;
}

function taskKeyOf(x) {
  if (x.kind === 'account_work') return `awb-${x.workBatchId || String(x.id).replace(/^awb-/i, '')}`;
  return String(x.id);
}

function renderRows(items) {
  const body = document.getElementById('task-body');
  state.items = items || [];
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">
      <div class="empty-block"><strong>暂无任务</strong>
      <span class="muted">客服拉粉丝会以「客服粉丝/关注同步」出现在坐席队列；可切换「全部状态 / 已完成」查看</span></div>
    </td></tr>`;
    return;
  }
  body.innerHTML = items.map((x) => {
    const payload = x.payload || {};
    const backend = payload.browserBackend || payload.browser_backend || '';
    const note = x.note
      || (backend ? `后端 ${backend}` : '')
      || (x.group_name || '-');
    const key = taskKeyOf(x);
    const active = logViewer.open && logViewer.taskKey === key ? ' is-active' : '';
    return `<tr class="task-row${active}" data-task-key="${esc(key)}" data-item-id="${esc(x.workItemId || 0)}" title="点击查看实时日志">
      <td>${idCell(x)}</td>
      <td><b>${esc(x.name || '-')}</b></td>
      <td>${esc(typeLabel(x))}</td>
      <td>${statusBadge(x.status)}</td>
      <td><span class="muted">${esc(progressText(x))}</span></td>
      <td class="muted">${esc(x.created_at || '-')}</td>
      <td class="muted">${esc(note)}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr.task-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const key = tr.getAttribute('data-task-key') || '';
      const itemId = Number(tr.getAttribute('data-item-id') || 0) || 0;
      const row = state.items.find((x) => taskKeyOf(x) === key);
      openLogDrawer(row || { id: key, name: key }, itemId);
    });
  });
}

function renderPager() {
  document.getElementById('task-meta').textContent = `${state.total} 条`;
  document.getElementById('pager-label').textContent = `第 ${state.page} / ${state.pages} 页`;
  document.getElementById('btn-prev').disabled = state.page <= 1;
  document.getElementById('btn-next').disabled = state.page >= state.pages;
  document.getElementById('page-size').value = String(state.pageSize);
}

function formatLogTime(s) {
  const t = String(s || '');
  if (t.length >= 19) return t.slice(11, 19);
  return t || '--:--:--';
}

function renderLogBody(lines) {
  const host = document.getElementById('log-drawer-body');
  if (!lines.length) {
    host.innerHTML = `<p class="log-empty">暂无日志（入队后会出现；执行过程中自动刷新）</p>`;
    return;
  }
  host.innerHTML = lines.map((row) => {
    const lv = String(row.level || 'info').toLowerCase();
    return `<div class="log-line">
      <span class="t">${esc(formatLogTime(row.created_at))}</span>
      <span class="lv ${esc(lv)}">${esc(lv)}</span>
      <span class="msg">${esc(row.message || '')}</span>
    </div>`;
  }).join('');
  host.scrollTop = host.scrollHeight;
}

function stopLogPoll() {
  if (logViewer.pollTimer) {
    clearInterval(logViewer.pollTimer);
    logViewer.pollTimer = null;
  }
}

function closeLogDrawer() {
  stopLogPoll();
  logViewer.open = false;
  logViewer.taskKey = '';
  show('#log-drawer', false);
  document.getElementById('log-drawer')?.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('tr.task-row.is-active').forEach((el) => el.classList.remove('is-active'));
}

async function fetchTaskLogs(taskKey, itemId = 0, { silent = false } = {}) {
  const qs = new URLSearchParams({ limit: '300' });
  if (itemId > 0) qs.set('itemId', String(itemId));
  const res = await fetch(`${API}/api/tasks/${encodeURIComponent(taskKey)}/logs?${qs}`, {
    headers: authHeaders(),
  });
  const j = await res.json();
  if (!j.ok) {
    if (!silent) toast(j.message || '拉取日志失败', 'err');
    return [];
  }
  const lines = Array.isArray(j.items) ? j.items : [];
  logCache.set(taskKey, { lines, at: Date.now(), itemId });
  return lines;
}

async function openLogDrawer(row, itemId = 0) {
  const key = taskKeyOf(row);
  const title = row.name || key;
  logViewer.open = true;
  logViewer.taskKey = key;
  logViewer.title = title;
  logViewer.itemId = itemId || Number(row.workItemId || 0) || 0;

  document.getElementById('log-drawer-title').textContent = title;
  document.getElementById('log-drawer-sub').textContent = `${key} · 内存缓存 · 刷新页面后清空`;
  show('#log-drawer', true);
  document.getElementById('log-drawer')?.setAttribute('aria-hidden', 'false');
  document.querySelectorAll('tr.task-row').forEach((el) => {
    el.classList.toggle('is-active', el.getAttribute('data-task-key') === key);
  });

  const cached = logCache.get(key);
  if (cached?.lines?.length) renderLogBody(cached.lines);
  else document.getElementById('log-drawer-body').innerHTML = `<p class="log-empty">加载日志中…</p>`;

  try {
    const lines = await fetchTaskLogs(key, logViewer.itemId);
    if (logViewer.taskKey === key) renderLogBody(lines);
  } catch (e) {
    if (logViewer.taskKey === key) {
      document.getElementById('log-drawer-body').innerHTML = `<p class="log-empty">${esc(e.message || '加载失败')}</p>`;
    }
  }

  stopLogPoll();
  logViewer.pollTimer = setInterval(async () => {
    if (!logViewer.open || logViewer.taskKey !== key) return;
    try {
      const lines = await fetchTaskLogs(key, logViewer.itemId, { silent: true });
      if (logViewer.taskKey === key) renderLogBody(lines);
    } catch { /* ignore poll errors */ }
  }, 2500);
}

async function loadTasks() {
  const qs = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    status: state.status || 'pending',
    source: state.source || 'all',
  });
  if (state.keyword) qs.set('keyword', state.keyword);
  const body = document.getElementById('task-body');
  body.innerHTML = `<tr><td colspan="7" class="empty">加载中…</td></tr>`;
  try {
    const res = await fetch(`${API}/api/tasks?${qs}`, { headers: authHeaders() });
    const j = await res.json();
    if (!j.ok) {
      if (String(j.message || '').includes('未登录') || res.status === 401) {
        enterLogin();
        toast(j.message || '请先登录', 'err');
        return;
      }
      body.innerHTML = `<tr><td colspan="7" class="empty">${esc(j.message || '加载失败')}</td></tr>`;
      toast(j.message || '加载失败', 'err');
      return;
    }
    state.total = Number(j.total || 0);
    state.page = Number(j.page || state.page);
    state.pages = Math.max(1, Number(j.pages || 1));
    state.pageSize = Number(j.pageSize || state.pageSize);
    renderRows(j.items || []);
    renderPager();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message || '网络错误')}</td></tr>`;
    toast(e.message || '网络错误', 'err');
  }
}

function enterLogin() {
  closeLogDrawer();
  show('#tasks-panel', false);
  show('#login-panel', true);
  show('#user-chip', false);
  show('#btn-logout', false);
}

function enterTasks(user) {
  show('#login-panel', false);
  show('#tasks-panel', true);
  show('#user-chip', true);
  show('#btn-logout', true);
  const chip = document.getElementById('user-chip');
  if (chip && user) {
    chip.textContent = user.nickname || user.username || '已登录';
    chip.classList.remove('hidden');
  }
  document.getElementById('api-url').textContent = API;
}

function bootDone() {
  document.body.classList.remove('booting');
}

function bootUI() {
  try {
    const known = !!getToken() || localStorage.getItem(SEEN_KEY) === '1';
    show('#login-panel', !known);
    show('#tasks-panel', known);
    if (known) {
      show('#user-chip', true);
      show('#btn-logout', true);
    }
  } finally {
    bootDone();
  }
}

setTimeout(bootDone, 3000);

async function doLogin(e) {
  e?.preventDefault?.();
  const apiBase = document.getElementById('api-base').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  try {
    const j = await json('POST', '/api/auth/login', { apiBase, username, password });
    if (!j.ok) throw new Error(j.message || '登录失败');
    setToken(j.token || j.user?.token || '');
    enterTasks(j.user);
    toast('登录成功', 'ok');
    await loadTasks();
  } catch (ex) {
    err.textContent = ex.message || '登录失败';
    err.classList.remove('hidden');
  }
}

async function boot() {
  bootUI();
  document.getElementById('api-url').textContent = API;
  try {
    const s = await json('GET', '/api/settings');
    if (s.apiBase) document.getElementById('api-base').value = s.apiBase;
  } catch { /* ignore */ }

  const st = await json('GET', '/api/auth/status').catch(() => ({}));
  if (st.loggedIn || getToken()) {
    localStorage.setItem(SEEN_KEY, '1');
    enterTasks(st.user || { username: '已登录' });
    await loadTasks();
  } else {
    setToken('');
    enterLogin();
  }

  document.getElementById('login-form').onsubmit = doLogin;
  document.getElementById('btn-logout').onclick = async () => {
    await json('POST', '/api/auth/logout', { token: getToken() });
    setToken('');
    enterLogin();
    toast('已退出', 'info');
  };
  document.getElementById('btn-refresh').onclick = () => loadTasks();
  document.getElementById('btn-search').onclick = () => {
    state.keyword = document.getElementById('keyword').value.trim();
    state.status = document.getElementById('status-filter').value;
    state.source = document.getElementById('source-filter').value;
    state.page = 1;
    loadTasks();
  };
  document.getElementById('keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-search').click();
  });
  document.getElementById('status-filter').onchange = () => {
    state.status = document.getElementById('status-filter').value;
    state.page = 1;
    loadTasks();
  };
  document.getElementById('source-filter').onchange = () => {
    state.source = document.getElementById('source-filter').value;
    state.page = 1;
    loadTasks();
  };
  document.getElementById('btn-prev').onclick = () => {
    if (state.page > 1) {
      state.page -= 1;
      loadTasks();
    }
  };
  document.getElementById('btn-next').onclick = () => {
    if (state.page < state.pages) {
      state.page += 1;
      loadTasks();
    }
  };
  document.getElementById('page-size').onchange = () => {
    state.pageSize = Number(document.getElementById('page-size').value) || 20;
    state.page = 1;
    loadTasks();
  };
  document.getElementById('btn-log-close').onclick = () => closeLogDrawer();
  document.getElementById('btn-log-refresh').onclick = async () => {
    if (!logViewer.taskKey) return;
    try {
      const lines = await fetchTaskLogs(logViewer.taskKey, logViewer.itemId);
      renderLogBody(lines);
      toast('日志已刷新', 'ok');
    } catch (e) {
      toast(e.message || '刷新失败', 'err');
    }
  };

  setInterval(() => {
    if (!document.getElementById('tasks-panel')?.classList.contains('hidden')) loadTasks();
  }, 15000);
}

boot().catch((e) => {
  console.error(e);
  bootDone();
});
