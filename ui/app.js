const API = window.tkswarmBrowser?.apiPort
  ? `http://127.0.0.1:${window.tkswarmBrowser.apiPort}`
  : (window.location.origin || 'http://127.0.0.1:54345');

const TOKEN_KEY = 'tkswarm_lb_token';
/** 上次登录成功标记：用于刷新时直接进面板（服务端也可能是 Cookie 会话，本地没有 Token） */
const SEEN_KEY = 'tkswarm_lb_seen';
/** @type {object[]} */
let lastWindows = [];
/** @type {object[]} */
let cachedProfiles = [];

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

async function bitListProfiles() {
  const res = await fetch(`${API}/browser/list`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ page: 0, pageSize: 200 }),
  });
  const j = await res.json();
  return j.data?.list || [];
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
  if (!host) {
    // eslint-disable-next-line no-alert
    alert(message);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-ico" aria-hidden="true"></span><span class="toast-msg">${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    el.style.transition = 'opacity .2s ease, transform .2s ease';
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'confirm-mask';
    mask.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true">
        <div class="modal-head"><strong>${esc(title)}</strong></div>
        <div class="modal-body">${esc(message)}</div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="cancel">取消</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const close = (v) => { mask.remove(); resolve(v); };
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    mask.querySelector('[data-act="cancel"]').onclick = () => close(false);
    mask.querySelector('[data-act="ok"]').onclick = () => close(true);
    document.body.appendChild(mask);
    mask.querySelector('[data-act="ok"]').focus();
  });
}

function emptyRow(colspan, title, detail) {
  return `<tr><td colspan="${colspan}" class="empty">
    <div class="empty-block">
      <strong>${esc(title)}</strong>
      ${detail ? `<span class="muted">${esc(detail)}</span>` : ''}
    </div>
  </td></tr>`;
}

function fmtBytes(n) {
  const v = Number(n || 0);
  if (!v) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  show('#modal-root', true);
  document.getElementById('modal-root').setAttribute('aria-hidden', 'false');
}

function closeModal() {
  show('#modal-root', false);
  document.getElementById('modal-root').setAttribute('aria-hidden', 'true');
  document.getElementById('modal-body').innerHTML = '';
}

function filteredWindows() {
  const q = String(document.getElementById('win-filter')?.value || '').trim().toLowerCase();
  const mode = document.getElementById('win-mode-filter')?.value || 'all';
  return lastWindows.filter((w) => {
    if (mode === 'headless' && !w.headless) return false;
    if (mode === 'headed' && w.headless) return false;
    if (!q) return true;
    const hay = `${w.profileId} ${w.name || ''} ${w.display || ''} ${w.pid || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderWindows() {
  const winBody = document.getElementById('win-body');
  const windows = filteredWindows();
  const countEl = document.getElementById('win-count');
  if (countEl) countEl.textContent = `${windows.length} 条`;
  if (!lastWindows.length) {
    winBody.innerHTML = emptyRow(7, '暂无运行中的窗口', '打开环境后会出现在这里');
    return;
  }
  if (!windows.length) {
    winBody.innerHTML = emptyRow(7, '无匹配窗口', '调整筛选条件');
    return;
  }
  winBody.innerHTML = windows.map((w) => `
    <tr>
      <td class="col-check"><input type="checkbox" class="win-check" value="${esc(w.profileId)}" /></td>
      <td><code title="${esc(w.profileId)}">${esc(String(w.profileId).slice(0, 10))}…</code></td>
      <td>${esc(w.name)}</td>
      <td><span class="tag ${w.headless ? 'headless' : 'visible'}">${w.headless ? '无头' : '有头'}</span></td>
      <td><code>${w.pid || '—'}</code></td>
      <td class="muted">${esc(w.display || '—')}</td>
      <td>
        <div class="row-actions">
          ${w.headless ? `<button class="btn small primary btn-show" type="button" data-id="${esc(w.profileId)}">显示</button>` : ''}
          ${!w.headless && w.vnc ? `<button class="btn small primary btn-vnc" type="button" data-id="${esc(w.profileId)}" data-href="${esc(w.vnc.viewPath || ('/vnc.html?id=' + w.profileId))}">VNC</button>` : ''}
          ${!w.headless ? (w.recording
            ? `<button class="btn small ghost btn-rec-stop" type="button" data-id="${esc(w.profileId)}">停录(${w.recording.elapsedSec || 0}s)</button>`
            : `<button class="btn small ghost btn-rec-start" type="button" data-id="${esc(w.profileId)}">录屏</button>`) : ''}
          <button class="btn small ghost btn-shot" type="button" data-id="${esc(w.profileId)}">截图</button>
          <button class="btn small ghost btn-close" type="button" data-id="${esc(w.profileId)}">关闭</button>
        </div>
      </td>
    </tr>
  `).join('');
  winBody.querySelectorAll('.btn-show').forEach((btn) => {
    btn.onclick = () => showWindow(btn.dataset.id);
  });
  winBody.querySelectorAll('.btn-close').forEach((btn) => {
    btn.onclick = () => closeWindow(btn.dataset.id);
  });
  winBody.querySelectorAll('.btn-shot').forEach((btn) => {
    btn.onclick = () => previewScreenshot(btn.dataset.id);
  });
  winBody.querySelectorAll('.btn-vnc').forEach((btn) => {
    btn.onclick = () => openVncEmbed(btn.dataset.id, btn.dataset.href);
  });
  winBody.querySelectorAll('.btn-rec-start').forEach((btn) => {
    btn.onclick = () => startRecord(btn.dataset.id);
  });
  winBody.querySelectorAll('.btn-rec-stop').forEach((btn) => {
    btn.onclick = () => stopRecord(btn.dataset.id);
  });
}

function proxyTag(p) {
  const type = String(p.proxyType || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !type) {
    return '<span class="tag noproxy">直连</span>';
  }
  const host = [p.host, p.port].filter(Boolean).join(':');
  return `<span class="tag proxy">${esc(type)}</span>${host ? ` <span class="muted">${esc(host)}</span>` : ''}${
    p.lastIp ? `<div class="cell-sub">IP ${esc(p.lastIp)}</div>` : ''
  }`;
}

function renderProfileRows(list) {
  const profileBody = document.getElementById('profile-body');
  const countEl = document.getElementById('profile-count');
  if (countEl) countEl.textContent = `${list.length} 条`;
  if (!profileBody) return;
  if (!list.length) {
    const q = document.getElementById('profile-search')?.value?.trim();
    profileBody.innerHTML = emptyRow(
      7,
      q ? '无匹配结果' : '暂无环境',
      q ? '尝试其他关键词' : '请在 Node 账号页创建并绑定'
    );
    return;
  }
  profileBody.innerHTML = list.map((p) => {
    const running = p.status === 1 || p.status === 2;
    const group = p.groupId || 'default';
    return `
      <tr>
        <td><code title="${esc(p.id)}">${esc(String(p.id).slice(0, 12))}…</code></td>
        <td>${esc(p.name)}${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}</td>
        <td><span class="tag group">${esc(group)}</span></td>
        <td>${proxyTag(p)}</td>
        <td>${esc(p.timezone || '—')}</td>
        <td><span class="status-dot ${running ? 'running' : 'idle'}">${running ? '运行中' : '空闲'}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn small ghost btn-export" type="button" data-id="${esc(p.id)}">导出</button>
            <button class="btn small ghost btn-rebind" type="button" data-id="${esc(p.id)}" title="将粘滞主机改绑到本机">重绑主机</button>
          </div>
          ${p.boundHostId ? `<div class="cell-sub">绑定 ${esc(p.boundHostId)}</div>` : ''}
        </td>
      </tr>`;
  }).join('');
  profileBody.querySelectorAll('.btn-export').forEach((btn) => {
    btn.onclick = () => exportProfile(btn.dataset.id);
  });
  profileBody.querySelectorAll('.btn-rebind').forEach((btn) => {
    btn.onclick = () => rebindHost(btn.dataset.id);
  });
}

function filterProfiles() {
  const q = (document.getElementById('profile-search')?.value || '').trim().toLowerCase();
  if (!q) {
    renderProfileRows(cachedProfiles);
    return;
  }
  const filtered = cachedProfiles.filter((p) => {
    const blob = [
      p.id, p.name, p.remark, p.groupId, p.proxyType, p.host, p.port, p.timezone, p.lastIp, p.boundHostId,
    ].map((x) => String(x ?? '').toLowerCase()).join(' ');
    return blob.includes(q);
  });
  renderProfileRows(filtered);
}

async function startRecord(id) {
  const r = await json('POST', `/api/windows/${encodeURIComponent(id)}/record/start`, {});
  if (!r?.ok) toast(r?.message || '无法开始录屏（需 ffmpeg + 有头）', 'err');
  else toast('已开始录屏', 'ok');
  await refreshDashboard();
}

async function stopRecord(id) {
  const r = await json('POST', `/api/windows/${encodeURIComponent(id)}/record/stop`, {});
  if (!r?.ok) {
    toast(r?.message || '停止录屏失败', 'err');
    await refreshDashboard();
    return;
  }
  const dl = r.data?.download;
  if (dl) {
    try {
      const res = await fetch(`${API}${dl}`, { headers: authHeaders() });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.data.fileName || 'recording.mp4';
      a.click();
      URL.revokeObjectURL(url);
      toast('录屏已保存', 'ok');
    } catch { /* ignore */ }
  }
  await refreshDashboard();
}

async function refreshDashboard() {
  const pack = await json('GET', '/api/dashboard/stats/async');
  if (!pack.ok) {
    if (pack.message === '未登录' || /token/i.test(pack.message || '')) {
      setToken('');
      show('#dashboard', false);
      show('#login-panel', true);
    }
    return;
  }
  const { user, self, children, windows, sessions, resources } = pack;
  document.getElementById('user-chip').textContent =
    `${user.nickname || user.username} · ${user.role || ''}`;
  show('#user-chip', true);
  show('#btn-logout', true);
  document.getElementById('stat-self').textContent = `${self.used} / ${self.limit}`;
  const hostEl = document.getElementById('stat-host');
  if (hostEl) hostEl.textContent = pack.hostId || '—';
  const tokenEl = document.getElementById('api-token');
  if (pack.token) {
    tokenEl.textContent = pack.token;
    setToken(pack.token);
  }
  document.getElementById('stat-windows').textContent = String(windows.length);
  if (Number(user.is_super) === 1) {
    show('#audit-panel', true);
    refreshAudit().catch(() => {});
  } else {
    show('#audit-panel', false);
  }
  if (resources) {
    document.getElementById('stat-max').textContent = String(resources.maxConcurrent ?? '—');
    document.getElementById('stat-rss').textContent = fmtBytes(resources.memory?.rss);
    document.getElementById('stat-memfree').textContent = fmtBytes(resources.memory?.systemFree);
  }
  const childEl = document.getElementById('stat-children');
  if (!children?.length) {
    childEl.textContent = '无子级账号或无权限查看';
  } else {
    childEl.innerHTML = children.map((c) =>
      `<div class="child-row"><span>${esc(c.nickname || c.username)}</span><span class="muted">${c.used}/${c.limit}</span></div>`
    ).join('');
  }

  const sessPanel = document.getElementById('sessions-panel');
  const sessBody = document.getElementById('sess-body');
  if (sessPanel && Array.isArray(sessions)) {
    show('#sessions-panel', true);
    document.getElementById('stat-sessions').textContent = String(sessions.length);
    if (!sessions.length) {
      sessBody.innerHTML = emptyRow(4, '暂无并发会话', '其他账号登录后会出现在此');
    } else {
      sessBody.innerHTML = sessions.map((s) => `
        <tr>
          <td>${esc(s.nickname || s.username || ('#' + s.userId))}</td>
          <td>${esc(s.role || '—')}</td>
          <td><code>${esc(s.tokenHint || '')}</code></td>
          <td class="muted">${esc((s.lastSeenAt || s.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
        </tr>
      `).join('');
    }
  } else if (sessPanel) {
    show('#sessions-panel', false);
  }

  lastWindows = Array.isArray(windows) ? windows : [];
  renderWindows();

  const profiles = await bitListProfiles();
  cachedProfiles = profiles;
  filterProfiles();
}

async function rebindHost(id) {
  const ok = await confirmDialog({
    title: '重绑主机',
    message: '将把该环境的粘滞主机改绑到本机。请确认环境已关闭且 userdata 已在本机。',
    confirmText: '确认重绑',
    danger: true,
  });
  if (!ok) return;
  const res = await fetch(`${API}/browser/host/rebind`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id }),
  });
  const r = await res.json();
  if (!r?.success) {
    toast(r?.msg || r?.message || '重绑失败', 'err');
    return;
  }
  toast(`已重绑到 ${r.data?.boundHostId || '本机'}`, 'ok');
  await refreshDashboard();
}

async function exportProfile(id) {
  const ok = await confirmDialog({
    title: '导出环境',
    message: '导出将先关闭该环境窗口（若在运行）。是否继续？',
    confirmText: '继续导出',
    danger: true,
  });
  if (!ok) return;
  const r = await json('POST', `/api/profiles/${encodeURIComponent(id)}/export`);
  if (!r?.ok) {
    toast(r?.message || '导出失败', 'err');
    return;
  }
  const a = document.createElement('a');
  a.href = `${API}${r.download}`;
  a.download = r.fileName || 'profile.tgz';
  try {
    const res = await fetch(a.href, { headers: authHeaders() });
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('导出完成', 'ok');
  } catch (e) {
    toast(e.message || '下载失败', 'err');
  }
  await refreshDashboard();
}

async function importProfileFile(file) {
  if (!file) return;
  const res = await fetch(`${API}/api/backups/import`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: file,
  });
  const r = await res.json();
  if (!r?.ok) {
    toast(r?.message || '导入失败', 'err');
    return;
  }
  toast(`已导入环境 ${r.profile?.name || r.profile?.id || ''}`, 'ok');
  await refreshDashboard();
}

async function refreshAudit() {
  const pack = await json('GET', '/api/audit/recent?limit=60');
  const body = document.getElementById('audit-body');
  if (!body) return;
  if (!pack?.ok) {
    body.innerHTML = emptyRow(3, pack?.message || '无法加载', '');
    return;
  }
  const list = pack.list || [];
  if (!list.length) {
    body.innerHTML = emptyRow(3, '暂无审计记录', '');
    return;
  }
  body.innerHTML = list.map((row) => {
    const { at, event, ...rest } = row;
    return `<tr>
      <td class="muted">${esc(String(at || '').replace('T', ' ').slice(0, 19))}</td>
      <td><code>${esc(event || '')}</code></td>
      <td class="muted"><code class="audit-detail">${esc(JSON.stringify(rest))}</code></td>
    </tr>`;
  }).join('');
}

async function showWindow(id) {
  const r = await json('POST', `/api/windows/${encodeURIComponent(id)}/show`);
  await refreshDashboard();
  if (r?.ok && r.data?.vnc?.viewPath) {
    openVncEmbed(id, r.data.vnc.viewPath);
  }
}

async function closeWindow(id) {
  const ok = await confirmDialog({
    title: '关闭窗口',
    message: '确认关闭该运行中的环境窗口？',
    confirmText: '关闭',
    danger: true,
  });
  if (!ok) return;
  await json('POST', `/api/windows/${encodeURIComponent(id)}/close`);
  toast('窗口已关闭', 'ok');
  await refreshDashboard();
}

async function closeSelected() {
  const ids = [...document.querySelectorAll('.win-check:checked')].map((el) => el.value);
  if (!ids.length) {
    toast('请先勾选窗口', 'info');
    return;
  }
  const ok = await confirmDialog({
    title: '批量关闭',
    message: `确认关闭选中的 ${ids.length} 个窗口？`,
    confirmText: '全部关闭',
    danger: true,
  });
  if (!ok) return;
  await json('POST', '/api/windows/close-batch', { ids });
  const all = document.getElementById('win-check-all');
  if (all) all.checked = false;
  toast(`已关闭 ${ids.length} 个窗口`, 'ok');
  await refreshDashboard();
}

async function previewScreenshot(id) {
  openModal('截图预览', `<p class="muted">加载中…</p>`);
  const r = await json('GET', `/api/windows/${encodeURIComponent(id)}/screenshot`);
  if (!r?.ok || !r.data) {
    openModal('截图预览', `<p class="error">${esc(r?.message || '截图失败')}</p>`);
    return;
  }
  const src = `data:${r.mimeType || 'image/png'};base64,${r.data}`;
  openModal(`截图 · ${String(id).slice(0, 12)}…`, `
    <img class="shot-img" src="${src}" alt="screenshot" />
    <div class="modal-foot-row">
      <a class="btn small ghost" href="${src}" download="tkswarm-${esc(String(id).slice(0, 8))}.png">下载 PNG</a>
    </div>
  `);
}

function openVncEmbed(id, href) {
  const url = href || `/vnc.html?id=${encodeURIComponent(id)}`;
  openModal(`VNC · ${String(id).slice(0, 12)}…`, `
    <iframe class="vnc-frame" src="${esc(url)}" title="VNC" allow="clipboard-read; clipboard-write"></iframe>
    <div class="modal-foot-row">
      <a class="btn small ghost" href="${esc(url)}" target="_blank" rel="noopener">新窗口打开</a>
    </div>
  `);
}

async function doLogin(e) {
  e?.preventDefault?.();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  const pack = await json('POST', '/api/auth/login', {
    apiBase: document.getElementById('api-base').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  });
  if (!pack.ok) {
    errEl.textContent = pack.message || '登录失败';
    errEl.classList.remove('hidden');
    return;
  }
  if (pack.token) setToken(pack.token);
  show('#login-panel', false);
  show('#dashboard', true);
  toast('登录成功', 'ok');
  await refreshDashboard();
}

function bootDone() {
  document.body.classList.remove('booting');
}

/**
 * 首屏判定：只看本地登录痕迹（Token / 上次登录标记），同步执行。
 * 有痕迹就直接进面板，绝不会先显示登录页再跳走；真失效时由 init() 校验后回退登录页。
 */
function bootUI() {
  try {
    const known = !!getToken() || localStorage.getItem(SEEN_KEY) === '1';
    show('#login-panel', !known);
    show('#dashboard', known);
    if (known) {
      show('#user-chip', true);
      show('#btn-logout', true);
    }
  } finally {
    bootDone();
  }
}

/** 兜底：任何异常都不能把页面卡在启动占位上 */
setTimeout(bootDone, 3000);

async function init() {
  document.getElementById('api-url').textContent = API;
  const settings = await json('GET', '/api/settings').catch(() => ({}));
  if (settings.apiBase) {
    document.getElementById('api-base').value = settings.apiBase;
  }
  const st = await json('GET', '/api/auth/status').catch(() => ({}));
  if (st.loggedIn || getToken()) {
    localStorage.setItem(SEEN_KEY, '1');
    show('#login-panel', false);
    show('#dashboard', true);
    await refreshDashboard();
  } else {
    // Token 缺失或已失效：这时才回登录页
    setToken('');
    show('#dashboard', false);
    show('#login-panel', true);
  }

  document.getElementById('login-form').addEventListener('submit', doLogin);
  document.getElementById('btn-login').onclick = doLogin;

  document.getElementById('btn-logout').onclick = async () => {
    await json('POST', '/api/auth/logout', { token: getToken() });
    setToken('');
    show('#dashboard', false);
    show('#login-panel', true);
    show('#user-chip', false);
    show('#btn-logout', false);
    toast('已退出登录', 'info');
  };
  document.getElementById('btn-refresh').onclick = async () => {
    await refreshDashboard();
    toast('数据已刷新', 'ok');
  };
  document.getElementById('btn-audit-refresh')?.addEventListener('click', async () => {
    await refreshAudit();
    toast('审计已刷新', 'ok');
  });
  document.getElementById('import-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importProfileFile(f);
  });
  document.getElementById('btn-close-selected')?.addEventListener('click', closeSelected);
  document.getElementById('win-filter')?.addEventListener('input', renderWindows);
  document.getElementById('win-mode-filter')?.addEventListener('change', renderWindows);
  document.getElementById('profile-search')?.addEventListener('input', filterProfiles);
  document.getElementById('win-check-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.win-check').forEach((c) => { c.checked = e.target.checked; });
  });
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });
  document.getElementById('btn-copy-token').onclick = async () => {
    const t = document.getElementById('api-token').textContent.trim();
    if (!t || t === '—') {
      toast('暂无 Token 可复制', 'err');
      return;
    }
    await navigator.clipboard.writeText(t);
    const btn = document.getElementById('btn-copy-token');
    btn.textContent = '已复制';
    toast('Token 已复制', 'ok');
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  };
  window.tkswarmBrowser?.onWindowsUpdated?.(() => refreshDashboard());
  setInterval(() => {
    if (!document.getElementById('dashboard')?.classList.contains('hidden')) refreshDashboard();
  }, 8000);
}

bootUI();
init().catch(console.error);
