const API = window.tkswarmBrowser?.apiPort
  ? `http://127.0.0.1:${window.tkswarmBrowser.apiPort}`
  : (window.location.origin || 'http://127.0.0.1:54345');

const TOKEN_KEY = 'tkswarm_lb_token';
/** @type {object[]} */
let lastWindows = [];

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
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
      <td>${w.pid || '—'}</td>
      <td class="muted">${esc(w.display || '—')}</td>
      <td>
        <div class="row-actions">
          ${w.headless ? `<button class="btn small primary btn-show" type="button" data-id="${esc(w.profileId)}">显示窗口</button>` : ''}
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

async function startRecord(id) {
  const r = await json('POST', `/api/windows/${encodeURIComponent(id)}/record/start`, {});
  if (!r?.ok) alert(r?.message || '无法开始录屏（需 ffmpeg + 有头）');
  await refreshDashboard();
}

async function stopRecord(id) {
  const r = await json('POST', `/api/windows/${encodeURIComponent(id)}/record/stop`, {});
  if (!r?.ok) {
    alert(r?.message || '停止录屏失败');
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
  const profileBody = document.getElementById('profile-body');
  if (!profiles.length) {
    profileBody.innerHTML = emptyRow(7, '暂无环境', '请在 Node 账号页创建并绑定');
  } else {
    profileBody.innerHTML = profiles.map((p) => {
      const running = p.status === 1 || p.status === 2;
      return `
      <tr>
        <td><code title="${esc(p.id)}">${esc(String(p.id).slice(0, 12))}…</code></td>
        <td>${esc(p.name)}${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}</td>
        <td>${esc(p.groupId || 'default')}</td>
        <td>${esc(p.proxyType || 'noproxy')} ${esc(p.host || '')}${p.port ? ':' + p.port : ''}${p.lastIp ? `<div class="cell-sub">IP ${esc(p.lastIp)}</div>` : ''}</td>
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
}

async function rebindHost(id) {
  if (!confirm('将把该环境的粘滞主机改绑到本机。确认环境已关闭且 userdata 已在本机？')) return;
  const res = await fetch(`${API}/browser/host/rebind`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id }),
  });
  const r = await res.json();
  if (!r?.success) {
    alert(r?.msg || r?.message || '重绑失败');
    return;
  }
  alert(`已重绑到 ${r.data?.boundHostId || '本机'}`);
  await refreshDashboard();
}

async function exportProfile(id) {
  if (!confirm('导出将先关闭该环境窗口（若在运行）。继续？')) return;
  const r = await json('POST', `/api/profiles/${encodeURIComponent(id)}/export`);
  if (!r?.ok) {
    alert(r?.message || '导出失败');
    return;
  }
  const a = document.createElement('a');
  a.href = `${API}${r.download}`;
  a.download = r.fileName || 'profile.tgz';
  // 带 Token：用 fetch blob
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
  } catch (e) {
    alert(e.message || '下载失败');
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
    alert(r?.message || '导入失败');
    return;
  }
  alert(`已导入环境 ${r.profile?.name || r.profile?.id || ''}`);
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
  await json('POST', `/api/windows/${encodeURIComponent(id)}/close`);
  await refreshDashboard();
}

async function closeSelected() {
  const ids = [...document.querySelectorAll('.win-check:checked')].map((el) => el.value);
  if (!ids.length) return;
  if (!confirm(`确认关闭选中的 ${ids.length} 个窗口？`)) return;
  await json('POST', '/api/windows/close-batch', { ids });
  const all = document.getElementById('win-check-all');
  if (all) all.checked = false;
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
  await refreshDashboard();
}

/**
 * 首屏判定：只看本地是否已有 Token，同步执行，避免"先闪一下登录页再跳到面板"。
 * 手上没有 Token 才停在登录页；有 Token 但服务端已失效时，init() 校验失败再退回登录页。
 */
function bootUI() {
  const hasToken = !!getToken();
  show('#login-panel', !hasToken);
  show('#dashboard', hasToken);
  if (hasToken) {
    show('#user-chip', true);
    show('#btn-logout', true);
    const host = document.querySelector('#windows-list') || document.querySelector('#dashboard');
    if (host && !host.textContent.trim()) host.innerHTML = '<div class="empty">正在恢复会话…</div>';
  }
}

async function init() {
  document.getElementById('api-url').textContent = API;
  const settings = await json('GET', '/api/settings').catch(() => ({}));
  if (settings.apiBase) {
    document.getElementById('api-base').value = settings.apiBase;
  }
  const st = await json('GET', '/api/auth/status').catch(() => ({}));
  if (st.loggedIn || getToken()) {
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
  };
  document.getElementById('btn-refresh').onclick = () => refreshDashboard();
  document.getElementById('btn-audit-refresh')?.addEventListener('click', () => refreshAudit());
  document.getElementById('import-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importProfileFile(f);
  });
  document.getElementById('btn-close-selected')?.addEventListener('click', closeSelected);
  document.getElementById('win-filter')?.addEventListener('input', renderWindows);
  document.getElementById('win-mode-filter')?.addEventListener('change', renderWindows);
  document.getElementById('win-check-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.win-check').forEach((c) => { c.checked = e.target.checked; });
  });
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });
  document.getElementById('btn-copy-token').onclick = async () => {
    const t = document.getElementById('api-token').textContent.trim();
    if (!t || t === '—') return;
    await navigator.clipboard.writeText(t);
    document.getElementById('btn-copy-token').textContent = '已复制';
    setTimeout(() => { document.getElementById('btn-copy-token').textContent = '复制'; }, 1500);
  };
  window.tkswarmBrowser?.onWindowsUpdated?.(() => refreshDashboard());
  setInterval(() => {
    if (!document.getElementById('dashboard')?.classList.contains('hidden')) refreshDashboard();
  }, 8000);
}

bootUI();
init().catch(console.error);
