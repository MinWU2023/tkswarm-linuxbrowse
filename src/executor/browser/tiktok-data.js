const { resolveAccountBrowser } = require('./providers');
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { syncProfile } = require('./tiktok-profile');

async function loadAccount(accountId) {
  const bundle = await dataStore.getAccountBundle(accountId);
  if (!bundle) throw new Error('账号不存在');
  const { profileId } = resolveAccountBrowser(bundle, { requireProfile: false });
  return {
    id: bundle.id,
    username: bundle.username,
    browser_profile_id: profileId,
    _bundle: bundle,
  };
}

async function syncVideos(accountId, limit = 100) {
  const account = await loadAccount(accountId);
  const { connectAccount, closeConnection } = require('./tiktok-actions');
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(account.username || '')}`;
  // keepBrowser 会话内自动复用；独立同步仍走默认 forceRelaunch
  const connection = await connectAccount(accountId, profileUrl, 'sync');
  try {
    const page = connection.page;
    await page.waitForTimeout(2500);
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page, { accountId });
    } catch { /* ignore */ }
    const uname = account.username || '';
    const links = await page.locator(`a[href*="/@${uname}/video/"]`).evaluateAll((els, max) => els.slice(0, max).map((el) => ({
      url: el.href, text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
      image: el.querySelector('img')?.src || '',
    })), Math.min(100, Math.max(1, Number(limit) || 100)));
    const items = links.map((item) => {
      const match = item.url.match(/\/video\/(\d+)/);
      return match ? { videoId: match[1], videoUrl: item.url, description: item.text.slice(0, 1000), thumbnailUrl: item.image } : null;
    }).filter(Boolean);

    await dataStore.tiktokSync(account.id, { videos: items });
    return { accountId: account.id, count: items.length, items };
  } finally {
    await closeConnection(connection).catch(() => {});
  }
}

async function getProfile(accountId) {
  try {
    return await phpApi.get(`/accounts/${accountId}/tiktok-profile`);
  } catch {
    return null;
  }
}

async function getVideos(accountId) {
  try {
    const data = await phpApi.get(`/accounts/${accountId}/tiktok-videos`);
    return Array.isArray(data) ? data : (data?.items || []);
  } catch {
    return [];
  }
}

async function getStats(accountId) {
  try {
    const data = await phpApi.get(`/accounts/${accountId}/tiktok-stats`);
    if (Array.isArray(data)) return { snapshots: data, daily28: [] };
    return {
      snapshots: data?.snapshots || data?.items || [],
      daily28: data?.daily28 || [],
    };
  } catch {
    return { snapshots: [], daily28: [] };
  }
}

module.exports = { syncProfile, getProfile, syncVideos, getVideos, getStats };
