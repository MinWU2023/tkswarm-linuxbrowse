const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { getProvider, resolvePreferredCreateProvider, resolveAccountBrowser } = require('./providers');
const { inspectTikTokSession, command } = require('./cdp-client');
const { publish: liveLog } = require('../live-log');
const { isHeadless } = require('./headless');
const dataStore = require('../data-store');

const sessions = new Map();
const screenshotDir = path.resolve(__dirname, '../../data/automation');
fs.mkdirSync(screenshotDir, { recursive: true });

function publicShot(filePath) {
  const name = path.basename(filePath);
  return `/api/browser/diagnostics/${encodeURIComponent(name)}`;
}

async function captureQr(page) {
  const candidates = [
    page.locator('canvas').first(),
    page.locator('img[src*="qr"]').first(),
    page.locator('[class*="qrcode"] img').first(),
    page.locator('[class*="QRCode"] img').first(),
  ];
  for (const locator of candidates) {
    if (await locator.count() && await locator.isVisible().catch(() => false)) {
      const file = path.join(screenshotDir, `${Date.now()}-qrcode.png`);
      await locator.screenshot({ path: file });
      return file;
    }
  }
  const file = path.join(screenshotDir, `${Date.now()}-qrcode-page.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function createQrSession({ groupId = null, proxyId = null, accountId = null } = {}) {
  let account = null;
  if (accountId) {
    account = await dataStore.getAccountBundle(accountId);
  }
  let proxy = null;
  if (account?.proxy_host) {
    const { buildSyncProxyFromBundle } = require('./proxy-sync');
    proxy = await buildSyncProxyFromBundle(account);
  }

  let provider = getProvider();
  let backend = provider.backendId === 'tkswarm' ? 'tkswarm' : 'bit';
  let profileId = '';
  if (account) {
    try {
      const resolved = resolveAccountBrowser(account, { requireProfile: false });
      provider = resolved.provider;
      backend = resolved.backend === 'tkswarm' ? 'tkswarm' : 'bit';
      profileId = resolved.profileId;
    } catch { /* create below */ }
  }
  if (!profileId) {
    const pack = await resolvePreferredCreateProvider();
    provider = pack.provider;
    backend = pack.backend === 'tkswarm' ? 'tkswarm' : 'bit';
    const name = `QR-${Date.now().toString(36)}`;
    const created = await provider.create({
      name,
      remark: 'TkSwarm QR login',
      proxy: proxy ? {
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
      } : null,
    });
    profileId = created.id || created;
    if (account?.id) {
      await dataStore.updateBrowserBinding(account.id, profileId, false, true, backend);
    }
  }

  if (account && profileId) {
    const { ensureAccountProxySynced } = require('./proxy-sync');
    const synced = await ensureAccountProxySynced(account, { profileId, provider, accountId: account.id });
    provider = synced.provider;
    profileId = synced.profileId;
  }
  const connection = await provider.open(profileId, {
    headless: isHeadless('scan'),
    forceRelaunch: Boolean(account),
  });
  const label = provider.backendLabel || (backend === 'tkswarm' ? '第一页自研浏览器' : '本地浏览器');
  if (!connection?.ws) throw new Error(`${label}未返回 CDP WebSocket 地址`);
  const browser = await chromium.connectOverCDP(connection.ws);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.tiktok.com/login/qrcode', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  });
  await page.waitForTimeout(1500);
  try {
    const { attachAutoRotateCaptchaWatcher, solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    attachAutoRotateCaptchaWatcher(page, { accountId: Number(account?.id || 0) });
    await solveRotateCaptchaIfPresent(page, { accountId: Number(account?.id || 0) });
  } catch { /* ignore */ }
  const shot = await captureQr(page);
  const id = `qr_${Date.now().toString(36)}`;
  const expiresAt = Date.now() + 5 * 60 * 1000;
  sessions.set(id, {
    id,
    profileId,
    accountId: account?.id || null,
    groupId,
    proxyId: proxyId || proxy?.id || null,
    status: 'waiting',
    qrImage: publicShot(shot),
    message: '??? TikTok App ?????????????????????',
    expiresAt,
    browser,
    provider,
  });
  liveLog(`??????????${id}`);
  return {
    id,
    profileId,
    accountId: account?.id || null,
    status: 'waiting',
    qrImage: publicShot(shot),
    expiresIn: 300,
    message: '??? TikTok App ?????',
  };
}

async function checkQrSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error('???????????');
  if (Date.now() > session.expiresAt) {
    session.status = 'expired';
    await closeQrSession(id).catch(() => {});
    return { id, status: 'expired', message: '扫码登录成功' };
  }
  const connection = await session.provider.open(session.profileId, { headless: isHeadless('scan') });
  const status = await inspectTikTokSession(connection.ws);
  if (!status.loggedIn) {
    return { id, status: 'waiting', qrImage: session.qrImage, message: '?????', expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)) };
  }

  let username = '';
  try {
    const browser = await chromium.connectOverCDP(connection.ws);
    const page = browser.contexts()[0]?.pages()?.[0];
    if (page) {
      username = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        const m = text.match(/@([a-zA-Z0-9._]{2,64})/);
        return m ? m[1] : '';
      }).catch(() => '');
      await browser.close().catch(() => {});
    }
  } catch { /* ignore */ }

  if (!username) username = `qr_user_${Date.now().toString(36)}`;

  let cookieText = '';
  try {
    const cookies = await command(connection.ws, 'Storage.getCookies');
    const tiktok = (cookies.cookies || []).filter(c => /(^|\.)tiktok\.com$/i.test(String(c.domain || '').replace(/^\./, '')));
    cookieText = tiktok.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { /* ignore */ }

  const saved = await dataStore.qrComplete({
    accountId: session.accountId || 0,
    username,
    profileId: session.profileId,
    groupId: session.groupId || null,
    proxyId: session.proxyId || null,
    cookie: cookieText,
  });
  const accountId = Number(saved?.id || session.accountId || 0);

  session.status = 'success';
  session.accountId = accountId;
  await session.provider.close(session.profileId).catch(() => {});
  if (session.browser) await session.browser.close().catch(() => {});
  sessions.delete(id);
  liveLog(`扫码登录成功：@${username}`);
  return { id, status: 'success', accountId, username, message: '扫码登录成功' };
}

async function closeQrSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  try { if (session.browser) await session.browser.close(); } catch { /* ignore */ }
  try { await session.provider.close(session.profileId); } catch { /* ignore */ }
  sessions.delete(id);
}

module.exports = { createQrSession, checkQrSession, closeQrSession };
