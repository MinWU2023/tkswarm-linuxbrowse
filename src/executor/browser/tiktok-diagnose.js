/**
 * TikTok Studio 账号诊断（按真实操作路径）：
 * 1. Profile（我）
 * 2. 右上角 ≡
 * 3. TikTok Studio（创作者中心）
 * 4. More tools → Account Check
 * 5. 开始检测 → 截图入库（可选 Account Standing / CHR）
 */
const path = require('node:path');
const fs = require('node:fs');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { capture } = require('../automation-guard');
const {
  goToPersonalCenter,
  dismissOverlays,
  clickByTextDeep,
  scrapePublicProfile,
  persistProfile,
} = require('./tiktok-profile');
const phpApi = require('../php-api');
const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickPattern(page, pattern, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = await clickByTextDeep(page, pattern);
    if (hit) return hit;
    await delay(400);
  }
  return '';
}

async function pageBodySample(page, limit = 4000) {
  return page.evaluate((n) => (document.body?.innerText || '').slice(0, n), limit).catch(() => '');
}

function isStudioUrl(url) {
  return /tiktok\.com\/tiktokstudio/i.test(String(url || ''));
}

function isAccountCheckUrl(url) {
  return /tiktokstudio\/(?:account[-_]?check|accountcheck|tools\/account)/i.test(String(url || ''));
}

async function isOnAccountCheckPage(page) {
  const url = page.url();
  if (isAccountCheckUrl(url)) return true;
  if (!isStudioUrl(url)) return false;
  const body = await pageBodySample(page);
  // 必须像 Account Check 页，不能只因为在 Studio 就通过
  return /Account Check|账号检测|账号检查|账号体检|Start check|开始检测|Check now|立即检测/i.test(body)
    && !/Analytics overview|数据概览|Upload video|上传视频/i.test(body.slice(0, 400));
}

/** 点个人主页右上角 ≡ 菜单 */
async function openProfileHamburger(page) {
  await dismissOverlays(page);
  const candidates = [
    page.locator('[data-e2e="more-menu-icon"]').first(),
    page.locator('[data-e2e="user-more"]').first(),
    page.locator('button[aria-label*="More" i]').first(),
    page.locator('button[aria-label*="更多" i]').first(),
  ];
  for (const el of candidates) {
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 5000 }).catch(() => {});
    await delay(900);
    const menuVisible = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('a, button, div[role="menuitem"], li, span'))
        .map((n) => String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 48);
      return texts.some((t) => /TikTok Studio|创作者中心|Creator Center|Creator tools|Settings|设置/i.test(t));
    }).catch(() => false);
    if (menuVisible) return true;
  }

  // DOM 兜底：右上角小按钮
  const found = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const btns = [...document.querySelectorAll('button, [role="button"], a')].filter(visible);
    const topRight = btns
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.top < 120 && r.right > window.innerWidth * 0.7 && r.width <= 56 && r.height <= 56;
      })
      .reverse();
    for (const b of topRight) {
      b.click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (found) {
    await delay(900);
    return true;
  }
  return false;
}

/** Profile → ≡ → TikTok Studio */
async function enterTikTokStudioFromProfile(page) {
  if (isStudioUrl(page.url())) return true;

  const opened = await openProfileHamburger(page);
  if (!opened) return false;

  const hit = await clickPattern(
    page,
    '^TikTok Studio$|^创作者中心$|Creator Center|Creator tools|TikTok\\s*Studio',
    5000
  );
  if (hit) {
    await delay(2800);
    await dismissOverlays(page);
    if (isStudioUrl(page.url())) return true;
  }

  // 菜单点不到时再直达 Studio 首页（仍算进入 Studio，后续必须进 Account Check）
  await page.goto('https://www.tiktok.com/tiktokstudio?lang=en', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await delay(2800);
  await dismissOverlays(page);
  return isStudioUrl(page.url());
}

/** Studio → More tools → Account Check（必须真正落到检测页） */
async function openAccountCheck(page) {
  if (await isOnAccountCheckPage(page)) return true;

  // More tools（侧栏/宫格）
  await clickPattern(page, '^More tools$|^更多工具$|More Tools|Tools$', 3500);
  await delay(1200);

  let hit = await clickPattern(
    page,
    '^Account Check$|^账号检测$|^账号检查$|^账号体检$|Account check',
    6000
  );
  if (hit) {
    await delay(2800);
    await dismissOverlays(page);
    if (await isOnAccountCheckPage(page)) return true;
  }

  // 仅允许 Account Check 专用 URL，禁止落到 analytics 等无关页
  const urls = [
    'https://www.tiktok.com/tiktokstudio/account-check?lang=en',
    'https://www.tiktok.com/tiktokstudio/accountcheck?lang=en',
    'https://www.tiktok.com/tiktokstudio/tools/account-check?lang=en',
  ];
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await delay(2500);
    await dismissOverlays(page);
    if (await isOnAccountCheckPage(page)) return true;
  }
  return false;
}

async function startAccountCheck(page) {
  const hit = await clickPattern(
    page,
    '^Start$|^Start check$|^开始检测$|^开始$|^Check now$|^立即检测$|^Run check$|^Check$',
    5000
  );
  if (hit) {
    await delay(4500);
    return true;
  }
  return false;
}

async function captureAndSave(page, accountId, label, source) {
  const file = await capture(page, accountId, 'diagnose', label);
  if (!file || !fs.existsSync(file)) {
    throw new Error(`截图失败：${label}`);
  }
  const basename = path.basename(file);
  const saved = await phpApi.post(`/node/accounts/${accountId}/diagnosis-result`, {
    screenshotPath: basename,
    screenshot_path: basename,
    label,
    source: source || 'manual',
  }).catch(async () => phpApi.post(`/accounts/${accountId}/diagnosis-records`, {
    screenshotPath: basename,
    screenshot_path: basename,
    label,
    source: source || 'manual',
  }));

  const deleted = saved?.deletedPaths || saved?.deleted_paths || [];
  for (const name of deleted) {
    const base = path.basename(String(name || ''));
    if (!base) continue;
    const full = path.join(path.dirname(file), base);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch { /* ignore */ }
  }

  return {
    file,
    basename,
    download: `/api/browser/diagnostics/${encodeURIComponent(basename)}`,
    record: saved || null,
  };
}

/**
 * 执行账号诊断并截图入库（仅保留最近 3 条由 PHP 侧裁剪）
 */
async function runAccountDiagnose(accountId, options = {}) {
  const source = String(options.source || 'manual');
  let connection;
  try {
    connection = await connectAccount(accountId, null, 'diagnose');
    const { page, account } = connection;
    const handle = String(account.username || '').replace(/^@/, '');

    // 1) 打开 TikTok → Profile（我）
    await page.goto('https://www.tiktok.com/foryou?lang=en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});
    await delay(2000);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    await dismissOverlays(page);

    const onProfile = await goToPersonalCenter(page, handle).catch(() => false);
    if (!onProfile && handle) {
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=en`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }).catch(() => {});
      await delay(2200);
    }
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    await dismissOverlays(page);

    // 个人主页粉丝/关注等统计入库（不替代 Studio 检测）
    let profileStats = null;
    try {
      const profile = await scrapePublicProfile(page, account);
      await persistProfile(account.id, profile);
      profileStats = {
        handle: profile.handle,
        displayName: profile.displayName,
        followers: profile.followersCount ?? 0,
        following: profile.followingCount ?? 0,
        likes: profile.likesCount ?? 0,
        videos: profile.videosCount ?? 0,
      };
    } catch (e) {
      profileStats = { error: String(e?.message || e) };
    }

    // 2+3) ≡ → TikTok Studio（创作者中心）—— 不要先点 Settings
    const inStudio = await enterTikTokStudioFromProfile(page);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    if (!inStudio) {
      const shot = await capture(page, accountId, 'diagnose', 'studio-miss').catch(() => '');
      throw new Error(`未进入 TikTok Studio（创作者中心）${shot ? `（截图：${path.basename(shot)}）` : ''}`);
    }

    // 4) More tools → Account Check
    const onCheck = await openAccountCheck(page);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    if (!onCheck) {
      const shot = await capture(page, accountId, 'diagnose', 'account-check-miss').catch(() => '');
      throw new Error(`未打开 Account Check（账号检测）页${shot ? `（截图：${path.basename(shot)}）` : ''}`);
    }

    // 5) 开始检测
    await startAccountCheck(page);
    await delay(2000);
    if (!(await isOnAccountCheckPage(page))) {
      // 点开始后偶发跳转，再确认一次
      await openAccountCheck(page);
    }

    const screenshots = [];
    screenshots.push(await captureAndSave(page, accountId, 'account-check', source));

    // 电商相关：Account Standing / CHR（有则截，不强制）
    const extraTargets = [
      { pattern: '^Account Standing$|^账号状态$', label: 'account-standing' },
      { pattern: 'CHR|创作者健康|Creator Health', label: 'chr' },
    ];
    for (const t of extraTargets) {
      const hit = await clickPattern(page, t.pattern, 2000);
      if (!hit) continue;
      await delay(2000);
      try {
        screenshots.push(await captureAndSave(page, accountId, t.label, source));
      } catch {
        /* 可选截图失败忽略 */
      }
    }

    return {
      status: 'ok',
      accountId: Number(accountId),
      profileStats,
      path: 'profile→menu→studio→account-check',
      screenshots: screenshots.map((s) => ({
        name: s.basename,
        download: s.download,
        label: s.record?.label || undefined,
      })),
      count: screenshots.length,
    };
  } finally {
    await closeConnection(connection).catch(() => {});
  }
}

module.exports = { runAccountDiagnose };
