const fs = require('node:fs');
const path = require('node:path');

const SECURITY_PATTERNS = [
  /captcha/i, /verify/i, /verification/i, /人机验证/, /安全验证/, /设备验证/, /滑块/, /slider/i,
  /unusual activity/i, /suspicious/i, /maximum number of attempts/i, /too many attempts/i,
  /oops!?\s*something went wrong/i, /something went wrong/i, /please contact your administrator/i,
];

function automationDir() {
  const dir = path.resolve(__dirname, '../data/automation');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function tryRefreshCaptchaOrErrorModal(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    const hasCaptchaShell = await page.evaluate(() => Boolean(
      document.querySelector(
        '#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="secsdk" i], iframe[src*="captcha" i], iframe[src*="verify" i], iframe[src*="secsdk" i]'
      )
    )).catch(() => false);
    if (hasCaptchaShell) {
      try {
        const { pauseSaveTrafficForCaptcha } = require('./browser/save-traffic');
        await pauseSaveTrafficForCaptcha(page);
      } catch { /* ignore */ }
    }
    const clicked = await page.evaluate(() => {
      const scopes = Array.from(document.querySelectorAll(
        '#captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], [class*="secsdk" i], .TUXModal, [role="dialog"]'
      ));
      for (const scope of scopes) {
        const btns = Array.from(scope.querySelectorAll('button, [role="button"], a'));
        const hit = btns.find((b) => {
          const txt = String(b.innerText || b.getAttribute('aria-label') || '').trim();
          return /^(Refresh|Try again|Retry|Reload|刷新|重试)$/i.test(txt);
        });
        if (hit && typeof hit.click === 'function') {
          hit.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    return clicked || hasCaptchaShell;
  } catch {
    return false;
  }
}

async function inspectPage(page) {
  let rotSolved = false;
  try {
    const { solveRotateCaptchaIfPresent } = require('./browser/nocaptchaai');
    const rot = await solveRotateCaptchaIfPresent(page);
    if (rot?.solved) rotSolved = true;
  } catch { /* ignore */ }
  if (rotSolved) {
    await page.waitForTimeout?.(900).catch(() => {});
  }
  const url = page.url();
  let body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  let inputText = await page.locator('input,button').allTextContents().catch(() => []);
  let text = `${url}\n${body}\n${inputText.join('\n')}`;
  let matched = SECURITY_PATTERNS.find(pattern => pattern.test(text));
  if (matched && !rotSolved && /captcha|verify|verification|人机验证|安全验证|设备验证|滑块|slider|something went wrong/i.test(matched.source)) {
    try {
      if (/something went wrong/i.test(matched.source)) {
        await tryRefreshCaptchaOrErrorModal(page);
        await page.waitForTimeout?.(1100).catch(() => {});
      } else {
        await page.waitForTimeout?.(800).catch(() => {});
      }
      const { solveRotateCaptchaIfPresent } = require('./browser/nocaptchaai');
      const rot2 = await solveRotateCaptchaIfPresent(page);
      if (rot2?.solved) {
        await page.waitForTimeout?.(900).catch(() => {});
      }
      body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      inputText = await page.locator('input,button').allTextContents().catch(() => []);
      text = `${url}\n${body}\n${inputText.join('\n')}`;
      matched = SECURITY_PATTERNS.find(pattern => pattern.test(text));
    } catch { /* ignore */ }
  }
  return { blocked: Boolean(matched), reason: matched ? matched.source : '', url };
}

/**
 * 私信页风控检测：Business Suite 聊天区偶发 "Something went wrong" 可侧栏重试，
 * 不应与验证码/全局风控混为一谈。
 */
async function inspectPageForDm(page) {
  let rotSolved = false;
  try {
    const { solveRotateCaptchaIfPresent } = require('./browser/nocaptchaai');
    const rot = await solveRotateCaptchaIfPresent(page);
    if (rot?.solved) rotSolved = true;
  } catch { /* ignore */ }
  if (rotSolved) {
    await page.waitForTimeout?.(900).catch(() => {});
  }
  const url = String(page.url() || '');
  const isMsgShell = /business-suite\/messages|\/messages(?:\?|$)/i.test(url);
  let body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  let inputText = await page.locator('input,button').allTextContents().catch(() => []);
  let text = `${url}\n${body}\n${inputText.join('\n')}`;
  const patterns = isMsgShell
    ? SECURITY_PATTERNS.filter((p) => !/something went wrong/i.test(String(p.source || '')))
    : SECURITY_PATTERNS;
  let matched = patterns.find((pattern) => pattern.test(text));
  if (matched && !rotSolved && /captcha|verify|verification|人机验证|安全验证|设备验证|滑块|slider/i.test(matched.source)) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./browser/nocaptchaai');
      const rot2 = await solveRotateCaptchaIfPresent(page);
      if (rot2?.solved) {
        await page.waitForTimeout?.(900).catch(() => {});
        body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        inputText = await page.locator('input,button').allTextContents().catch(() => []);
        text = `${url}\n${body}\n${inputText.join('\n')}`;
        matched = patterns.find((pattern) => pattern.test(text));
      }
    } catch { /* ignore */ }
  }
  return { blocked: Boolean(matched), reason: matched ? matched.source : '', url };
}

async function capture(page, accountId, action, label = 'state') {
  const dir = automationDir();
  const safeAction = String(action).replace(/[^a-z0-9_-]/gi, '_');
  const file = path.join(dir, `${Date.now()}-account-${accountId}-${safeAction}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

function classify(text) {
  const value = String(text || '');
  if (SECURITY_PATTERNS.some(pattern => pattern.test(value))) return 'security_paused';
  if (/published|posted|发布成功|已发布|sent|发送成功|已发送/i.test(value)) return 'success';
  if (/failed|error|失败|错误|try again/i.test(value)) return 'failed';
  return 'unknown';
}

module.exports = { inspectPage, inspectPageForDm, capture, classify, SECURITY_PATTERNS };
