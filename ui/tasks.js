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
  publish: '发布视频',
  message: '私信',
  warm: '养号',
  ai_lead: 'AI 拓客',
  chat_seat: '客服坐席',
  account_work: '矩阵任务',
  comment_reply: '回复评论',
  pull_video_list: '拉取视频列表',
  pull_comments: '拉取视频详情',
  auto_follow: '自动关注',
  sync_fans: '同步粉丝',
  dm_sync: '私信同步',
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
  const k = String(x.type || '');
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

function renderRows(items) {
  const body = document.getElementById('task-body');
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">
      <div class="empty-block"><strong>暂无待执行任务</strong>
      <span class="muted">当前筛选条件下没有任务（含客服坐席推送）</span></div>
    </td></tr>`;
    return;
  }
  body.innerHTML = items.map((x) => {
    const payload = x.payload || {};
    const backend = payload.browserBackend || payload.browser_backend || '';
    const note = x.note
      || (backend ? `后端 ${backend}` : '')
      || (x.group_name || '-');
    return `<tr>
      <td>${idCell(x)}</td>
      <td><b>${esc(x.name || '-')}</b></td>
      <td>${esc(typeLabel(x))}</td>
      <td>${statusBadge(x.status)}</td>
      <td><span class="muted">${esc(progressText(x))}</span></td>
      <td class="muted">${esc(x.created_at || '-')}</td>
      <td class="muted">${esc(note)}</td>
    </tr>`;
  }).join('');
}

function renderPager() {
  document.getElementById('task-meta').textContent = `${state.total} 条`;
  document.getElementById('pager-label').textContent = `第 ${state.page} / ${state.pages} 页`;
  document.getElementById('btn-prev').disabled = state.page <= 1;
  document.getElementById('btn-next').disabled = state.page >= state.pages;
  document.getElementById('page-size').value = String(state.pageSize);
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

/**
 * 首屏同步判定：有 Token / 上次登录标记则直接进列表，避免先闪登录页再跳回。
 */
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

  setInterval(() => {
    if (!document.getElementById('tasks-panel')?.classList.contains('hidden')) loadTasks();
  }, 15000);
}

boot().catch((e) => {
  console.error(e);
  bootDone();
});
