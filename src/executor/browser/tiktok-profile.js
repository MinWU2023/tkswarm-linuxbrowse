/**
 * TikTok 资料同步 / 编辑资料 浏览器封装
 * 同步资料流程：个人中心 → 编辑资料 → 填入信息 → 保存提交 → 回写本地
 */
const { resolveAccountBrowser } = require('./providers');
const { inspectTikTokSession, pageLooksLoggedOut, pageLooksLoggedIn } = require('./cdp-client');
const { capture } = require('../automation-guard');
const dataStore = require('../data-store');
const phpApi = require('../php-api');
const { nowChinaSql } = require('../utils/china-time');
const { typeDelay, humanPause } = require('../human-pace');

function numberFromText(value) {
  const text = String(value || '').replace(/,/g, '').trim().toUpperCase();
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
  if (!match) return null;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

function extractStat(text, labels) {
  for (const label of labels) {
    // "Followers 12" / "粉丝 12"
    let match = String(text || '').match(new RegExp(`(${label})\\s*([0-9][0-9,.]*\\s*[KMB]?)`, 'i'));
    if (match) return numberFromText(match[2]);
    // "12 Followers" / "12 粉丝"（个人主页常见）
    match = String(text || '').match(new RegExp(`([0-9][0-9,.]*\\s*[KMB]?)\\s*(${label})\\b`, 'i'));
    if (match) return numberFromText(match[1]);
  }
  return null;
}

async function loadAccount(accountId) {
  const bundle = await dataStore.getAccountBundle(accountId);
  if (!bundle) throw new Error('账号不存在');
  const { profileId } = resolveAccountBrowser(bundle, { requireProfile: false });
  return {
    id: bundle.id,
    username: bundle.username,
    nickname: String(bundle.nickname || '').trim(),
    profileBio: String(bundle.profile_bio || bundle.profileBio || '').trim(),
    profileAvatar: String(bundle.profile_avatar || bundle.profileAvatar || '').trim(),
    browser_profile_id: profileId,
    _bundle: bundle,
  };
}

async function openBitPage(account, action = 'profile', url = null) {
  const { connectAccount } = require('./tiktok-actions');
  const accountId = Number(account?.id || 0);
  if (!accountId) throw new Error('账号不存在');
  // 统一走 connectAccount：总任务 keepBrowser 时复用已开环境
  const connection = await connectAccount(accountId, url, action);
  account.browser_profile_id = connection.account?.browser_profile_id || account.browser_profile_id;
  return {
    provider: connection.provider,
    browser: connection.browser,
    page: connection.page,
    ws: connection.ws,
    profileId: connection.account?.browser_profile_id || '',
    label: connection.provider?.backendLabel || '本地浏览器',
    _connection: connection,
  };
}

async function closeBitPage(session, account) {
  if (!session) return;
  const { closeConnection } = require('./tiktok-actions');
  if (session._connection) {
    await closeConnection(session._connection).catch(() => {});
    return;
  }
  // 兼容旧会话对象
  const fake = {
    browser: session.browser,
    provider: session.provider,
    account: { browser_profile_id: session.profileId || account?.browser_profile_id },
  };
  await closeConnection(fake).catch(() => {});
}

/**
 * 编辑资料弹框内操作：Username / Name / Bio / Logo。
 * Username 若占用冲突：恢复原值后再次保存，避免拖累昵称/头像提交。
 * Logo：头像右下角编辑图标 → filechooser / input[type=file]
 */

const USERNAME_TAKEN_RE = /username.{0,40}(taken|unavailable|already|exist|in use|not available)|this username isn.?t available|unique.?id.{0,40}(taken|unavailable)|用户名.{0,20}(已被|占用|不可用|已存在|重复)|该用户名|账号名.{0,10}(已被|占用|不可用)/i;
const NICKNAME_LOCK_RE = /nickname can only be changed|can change it again after|每\s*7\s*天|7\s*天.*改|天后.*改|暂时无法修改|cannot be changed/i;

function normalizeHandle(value) {
  return String(value || '').replace(/^@+/, '').trim();
}

async function waitBrief(page, ms = 200) {
  await page.waitForTimeout(ms).catch(() => {});
}

/** React controlled input：用原生 value setter 触发 input/change */
async function setReactInputValue(locator, value) {
  const el = locator.first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  await el.click({ timeout: 5000 }).catch(() => {});
  const ok = await el.evaluate((node, next) => {
    const tag = (node.tagName || '').toLowerCase();
    const proto =
      tag === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const fire = (type) => {
      node.dispatchEvent(new Event(type, { bubbles: true }));
      try {
        node.dispatchEvent(new InputEvent(type, { bubbles: true, data: String(next ?? ''), inputType: 'insertText' }));
      } catch (_) {}
    };
    node.focus();
    if (setter) setter.call(node, '');
    else node.value = '';
    fire('input');
    if (setter) setter.call(node, String(next ?? ''));
    else node.value = String(next ?? '');
    fire('input');
    node.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      node.blur();
    } catch (_) {}
    return String(node.value ?? '') === String(next ?? '');
  }, String(value ?? '')).catch(() => false);

  if (!ok) {
    await el.fill(String(value ?? '')).catch(async () => {
      await el.press('Control+A').catch(() => {});
      await el.type(String(value ?? ''), { delay: typeDelay(80, 160) }).catch(() => {});
    });
  }
  const cur = await el.inputValue().catch(async () => (await el.textContent().catch(() => '')) || '');
  return String(cur).trim() === String(value ?? '').trim()
    || String(cur).includes(String(value ?? '').trim());
}

function fieldMeta(attrs = {}) {
  return `${attrs.e2e || ''} ${attrs.name || ''} ${attrs.placeholder || ''} ${attrs.aria || ''} ${attrs.id || ''}`.toLowerCase();
}

function looksLikeUsername(meta) {
  return /username|unique.?id|user.?name|edit-profile-username|@/.test(meta);
}

function looksLikeName(meta) {
  if (looksLikeUsername(meta)) return false;
  return /edit-profile-name|nickname|display.?name|(^|[^a-z])name([^a-z]|$)|昵称|名字/.test(meta);
}

function looksLikeBio(meta, tag = '') {
  return /bio|签名|简介|desc|edit-profile-bio/.test(meta) || tag === 'textarea';
}

/**
 * 编辑资料弹框里的 Name 输入框定位器。
 * 现行 TikTok DOM 把 data-e2e 挂在**包裹 div** 上，真正的输入框在它内部：
 *   <div data-e2e="edit-profile-name-input"><input placeholder="Name" value="..."></div>
 * 所以必须用 `[data-e2e="edit-profile-name-input"] input`，
 * 直接 `input[data-e2e="edit-profile-name-input"]` 是匹配不到的（历史 bug）。
 */
const NAME_INPUT_SELECTORS = [
  '[data-e2e="edit-profile-name-input"] input',
  '[data-e2e="edit-profile-name"] input',
  'input[data-e2e="edit-profile-name-input"]',
  '[role="dialog"] input[placeholder="Name"]',
  '[role="dialog"] input[placeholder*="name" i]:not([placeholder*="user" i]):not([placeholder*="unique" i])',
  '[role="dialog"] input[aria-label*="name" i]:not([aria-label*="user" i]):not([aria-label*="unique" i])',
];

/** 同理，Bio 的 data-e2e 也挂在包裹容器上 */
const BIO_INPUT_SELECTORS = [
  '[data-e2e="edit-profile-bio-input"] textarea',
  '[data-e2e="edit-profile-bio-input"] input',
  'textarea[data-e2e="edit-profile-bio-input"]',
  '[role="dialog"] textarea[placeholder*="bio" i]',
  '[role="dialog"] textarea',
];

async function listEditInputs(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;
    const nodes = Array.from(root.querySelectorAll('input, textarea'));
    return nodes.map((el, index) => {
      const rect = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        e2e: el.getAttribute('data-e2e') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        aria: el.getAttribute('aria-label') || '',
        value: el.value || '',
        visible: !!(rect.width && rect.height && el.offsetParent !== null),
      };
    }).filter((x) => x.visible && x.type !== 'hidden' && x.type !== 'file');
  }).catch(() => []);
}

/**
 * Name 输入框是否可输入。
 * 判定只看输入框本身（存在 / 可见 / disabled / readonly），不看页面文案：
 * TikTok 编辑资料弹框里常驻一行 "Your nickname can only be changed once every 7 days."，
 * 那只是提示语，输入框仍然可以正常输入并提交。
 *   - reason=name-input-locked  输入框存在但被禁用/只读 → 官方确实限制修改
 *   - reason=no-name-input      没识别到输入框（DOM 变化），不代表被限制，调用方应继续尝试填写
 */
async function isNameFieldEditable(page) {
  const dialog = page.locator('[role="dialog"]').first();
  const scope = (await dialog.count().catch(() => 0)) ? dialog : page;

  for (const sel of NAME_INPUT_SELECTORS) {
    const el = scope.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const disabled = await el.isDisabled().catch(() => false);
    const readonly = await el.getAttribute('readonly').catch(() => null);
    if (!disabled && readonly == null) return { editable: true, locator: el };
    return { editable: false, reason: 'name-input-locked' };
  }

  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const isUsernameish = (t) => /username|用户名|handle|@/.test(String(t || '').toLowerCase());
    const isNameLabel = (t) => {
      const x = String(t || '').trim().toLowerCase();
      if (!x || isUsernameish(x) || x.length > 24) return false;
      return x === 'name' || x === 'nickname' || x === 'display name'
        || x === '昵称' || x === '名字' || x === '名称';
    };
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.body;
    const labels = Array.from(root.querySelectorAll('label, span, div, p, strong, b'));
    for (const n of labels) {
      if (!visible(n)) continue;
      const t = (n.textContent || '').trim();
      if (!isNameLabel(t)) continue;
      if (n.closest('button, a, [role="button"]')) continue;
      let row = n.parentElement;
      for (let d = 0; d < 6 && row; d++) {
        const inputs = [...row.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea')]
          .filter((el) => visible(el) && !n.contains(el));
        const candidates = [];
        for (const el of inputs) {
          const meta = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
          if (isUsernameish(meta) || /bio|简介/.test(meta)) continue;
          candidates.push(el);
        }
        if (candidates.length) {
          // 文案（含 7 天提示）不参与判定，只看输入框能不能输入
          const usable = candidates.find((el) => !el.disabled && !el.readOnly);
          if (usable) return { editable: true };
          return { editable: false, reason: 'name-input-locked' };
        }
        row = row.parentElement;
      }
    }
    return { editable: false, reason: 'no-name-input' };
  }).catch(() => ({ editable: false, reason: 'probe-failed' }));
}

/** 兜底：有些受控输入只认真实键盘事件，聚焦后逐字输入 */
async function typeIntoValue(page, locator, value, log = () => {}) {
  try {
    await locator.click({ timeout: 5000 });
    await page.waitForTimeout(120);
    await locator.press('Control+A').catch(() => {});
    await locator.press('Delete').catch(() => {});
    await locator.type(String(value), { delay: typeDelay(80, 160) });
    await humanPause(500, 0.2);
    const cur = String(await locator.inputValue().catch(() => '')).trim();
    if (cur === String(value).trim()) return true;
    // 有些输入会把新内容拼在旧值后面，清空重来一次
    await locator.press('Control+A').catch(() => {});
    await locator.press('Delete').catch(() => {});
    await locator.type(String(value), { delay: typeDelay(80, 160) });
    await humanPause(500, 0.2);
    const cur2 = String(await locator.inputValue().catch(() => '')).trim();
    if (cur2 !== String(value).trim()) log(`name: keyboard type left value "${cur2}"`);
    return cur2 === String(value).trim();
  } catch (_) {
    return false;
  }
}

/**
 * 昵称填写后 TikTok 会弹「Set nickname?」二次确认框：
 *   <div data-e2e="set-username-popup">
 *     <p data-e2e="set-username-popup-title">Set nickname?</p>
 *     <button data-e2e="set-username-popup-cancel">Cancel</button>
 *     <button data-e2e="set-username-popup-confirm">Confirm</button>
 * 出现即点 Confirm（点 Cancel 会导致昵称不生效）。
 * 注意：这个弹框的说明文字同样含 "once every 7 days"，所以必须按 data-e2e / 标题识别，
 * 不能按文案判锁。
 */
async function confirmSetNicknamePopup(page, log = () => {}, timeoutMs = 4000) {
  const CONFIRM_SELECTORS = [
    '[data-e2e="set-username-popup-confirm"]',
    '[data-e2e="set-username-popup"] button:has-text("Confirm")',
    '[role="dialog"]:has-text("Set nickname?") button:has-text("Confirm")',
  ];
  const end = Date.now() + timeoutMs;
  // 让当前焦点离开输入框，TikTok 是在 blur 之后才弹这个确认框的
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && typeof el.blur === 'function') el.blur();
  }).catch(() => {});
  while (Date.now() < end) {
    let shown = await page.locator('[data-e2e="set-username-popup"]').first().isVisible().catch(() => false);
    if (!shown) {
      shown = await page.locator('[data-e2e="set-username-popup-title"]').first().isVisible().catch(() => false);
    }
    if (!shown) {
      const byText = page.locator('[role="dialog"]').filter({ hasText: /Set nickname\?/i }).first();
      shown = await byText.isVisible().catch(() => false);
    }
    if (shown) {
      for (const sel of CONFIRM_SELECTORS) {
        const btn = page.locator(sel).first();
        if (!(await btn.count().catch(() => 0))) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (await btn.isEnabled().catch(() => true)) {
          await btn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(700);
          // 可能第一次点击没生效（动画中），再补一次
          if (await page.locator('[data-e2e="set-username-popup"]').first().isVisible().catch(() => false)) {
            await btn.click({ timeout: 5000, force: true }).catch(() => {});
            await page.waitForTimeout(600);
          }
          const still = await page.locator('[data-e2e="set-username-popup"]').first().isVisible().catch(() => false);
          log(`name: 已点击「Set nickname?」确认按钮 (${sel})，弹框${still ? '仍在' : '已关闭'}`);
          return !still;
        }
      }
      log('name: 「Set nickname?」弹框已出现但找不到可点的 Confirm');
      return false;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * 填写 Name。只有「输入框存在但被禁用/只读」才跳过（官方限制）；
 * 认不出输入框时继续用各种选择器尝试，绝不因为提示文案而跳过。
 */
async function fillNameInEditModal(page, value, log = () => {}) {
  if (!value) return false;

  // 只有「输入框存在但被禁用/只读」才算被官方限制；找不到输入框要继续尝试各种定位方式
  const state = await isNameFieldEditable(page);
  if (!state.editable && state.reason === 'name-input-locked') {
    log('name: skip (input disabled/readonly — locked by TikTok)');
    return false;
  }

  for (const sel of NAME_INPUT_SELECTORS) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.isDisabled().catch(() => true)) {
      log(`name: skip (${sel} disabled)`);
      return false;
    }
    const readonly = await el.getAttribute('readonly').catch(() => null);
    if (readonly != null) {
      log(`name: skip (${sel} readonly)`);
      return false;
    }
    if (await setReactInputValue(el, value)) {
      log(`name: filled via ${sel} → ${String(await el.inputValue().catch(() => '')).trim()}`);
      return true;
    }
    if (await typeIntoValue(page, el, value, log)) {
      log(`name: filled via ${sel} (keyboard) → ${String(await el.inputValue().catch(() => '')).trim()}`);
      return true;
    }
    log(`name: set value failed via ${sel}, try next`);
  }

  const byLabel = page.getByLabel(/^Name$/i).first();
  if (await byLabel.count().catch(() => 0) && await byLabel.isVisible().catch(() => false)) {
    const tag = await byLabel.evaluate((el) => (el.tagName || '').toLowerCase()).catch(() => '');
    if (tag === 'input' || tag === 'textarea') {
      const disabled = await byLabel.isDisabled().catch(() => true);
      const readonly = await byLabel.getAttribute('readonly').catch(() => null);
      if (!disabled && readonly == null) {
        const meta = fieldMeta({
          e2e: await byLabel.getAttribute('data-e2e').catch(() => ''),
          name: await byLabel.getAttribute('name').catch(() => ''),
          placeholder: await byLabel.getAttribute('placeholder').catch(() => ''),
          aria: await byLabel.getAttribute('aria-label').catch(() => ''),
        });
        if (!looksLikeUsername(meta) && (await setReactInputValue(byLabel, value))) {
          log('name: filled via label');
          return true;
        }
      }
    }
  }

  const handle = await page.evaluateHandle(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const isUsernameish = (t) => /username|用户名|handle|@/.test(String(t || '').toLowerCase());
    const isNameLabel = (t) => {
      const x = String(t || '').trim().toLowerCase();
      if (!x || isUsernameish(x) || x.length > 24) return false;
      return x === 'name' || x === 'nickname' || x === 'display name'
        || x === '昵称' || x === '名字' || x === '名称';
    };
    const dialog = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;
    const labels = Array.from(dialog.querySelectorAll('label, span, div, p, strong, b'));
    for (const n of labels) {
      if (!visible(n)) continue;
      const t = (n.textContent || '').trim();
      if (!isNameLabel(t)) continue;
      if (n.closest('button, a, [role="button"]')) continue;
      if (n.tagName === 'LABEL' && n.htmlFor) {
        const byFor = document.getElementById(n.htmlFor);
        if (byFor && visible(byFor) && !byFor.disabled && !byFor.readOnly
          && !isUsernameish(byFor.getAttribute('data-e2e') || '')) {
          return byFor;
        }
      }
      let row = n.parentElement;
      for (let i = 0; i < 6 && row; i++) {
        const inputs = [...row.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea')]
          .filter((el) => visible(el) && !n.contains(el) && !el.disabled && !el.readOnly);
        for (const el of inputs) {
          const meta = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
          if (isUsernameish(meta) || /bio|简介/.test(meta)) continue;
          return el;
        }
        row = row.parentElement;
      }
    }
    return null;
  });

  const el = handle.asElement?.() || null;
  if (el) {
    const filled = await el.evaluate((node, next) => {
      if (node.disabled || node.readOnly) return false;
      const tag = (node.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return false;
      const proto = tag === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      node.focus();
      if (setter) setter.call(node, '');
      else node.value = '';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      if (setter) setter.call(node, String(next ?? ''));
      else node.value = String(next ?? '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return String(node.value ?? '') === String(next ?? '');
    }, String(value)).catch(() => false);
    if (filled) {
      log('name: filled via nearby input');
      return true;
    }
  }

  // 兜底：编辑资料弹框内若只剩一个非 Username / 非 Bio 的文本框，基本就是 Name
  const solo = await page.evaluate((next) => {
    const dialog = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]');
    if (!dialog) return null; // 认不出弹框就不猜，避免写进搜索框
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const inputs = [...dialog.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea')]
      .filter((el) => visible(el) && !el.disabled && !el.readOnly);
    const candidates = inputs.filter((el) => {
      const meta = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
      if (/username|unique.?id|handle|@|bio|简介|search|搜索/.test(meta)) return false;
      if ((el.getAttribute('type') || '').toLowerCase() === 'search') return false;
      return true;
    });
    if (candidates.length !== 1) return null;
    const node = candidates[0];
    const tag = (node.tagName || '').toLowerCase();
    const proto = tag === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    node.focus();
    if (setter) setter.call(node, String(next ?? '')); else node.value = String(next ?? '');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    try { node.blur(); } catch (_) {}
    return { tag, e2e: node.getAttribute('data-e2e') || '', value: node.value };
  }, String(value)).catch(() => null);
  if (solo && String(solo.value ?? '') === String(value)) {
    log(`name: filled via solo-input (${solo.e2e || solo.tag})`);
    return true;
  }

  const inputs = await listEditInputs(page).catch(() => []);
  log(`name: skip (no editable Name input found); candidates=${JSON.stringify(inputs.map((x) => ({ e2e: x.e2e, name: x.name, ph: x.placeholder, type: x.type })))}`);
  return false;
}

async function fillBioInEditModal(page, value) {
  if (!value) return false;
  for (const sel of BIO_INPUT_SELECTORS) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await setReactInputValue(el, value)) return true;
    break;
  }
  const byLabel = page.getByLabel(/^Bio$/i).first();
  if (await byLabel.count().catch(() => 0) && await byLabel.isVisible().catch(() => false)) {
    if (await setReactInputValue(byLabel, value)) return true;
  }
  const area = page.locator('[role="dialog"] textarea, textarea[placeholder*="Bio" i]').first();
  if (await area.count().catch(() => 0) && await area.isVisible().catch(() => false)) {
    if (await setReactInputValue(area, value)) return true;
  }
  return false;
}

function isAvatarVideoFile(filePath) {
  return /\.(mp4|webm|mov)$/i.test(String(filePath || ''));
}

/**
 * 在 Edit profile 弹层内找头像 file input（图片 / 视频，含隐藏 / accept 过滤）。
 * @param {'image'|'video'|'any'} preferKind
 */
async function findAvatarFileInput(page, waitMs = 3000, preferKind = 'any') {
  const end = Date.now() + waitMs;
  const imageSels = [
    '[role="dialog"] input[type="file"][accept*="image"]',
    '[role="dialog"] input[type="file"][accept*="jpg"]',
    '[role="dialog"] input[type="file"][accept*="png"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="jpg"]',
  ];
  const videoSels = [
    '[role="dialog"] input[type="file"][accept*="video"]',
    '[role="dialog"] input[type="file"][accept*="mp4"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"][accept*="mp4"]',
  ];
  const anySels = [
    '[role="dialog"] input[type="file"]',
    'input[type="file"]',
  ];
  const selectors = preferKind === 'video'
    ? [...videoSels, ...anySels, ...imageSels]
    : preferKind === 'image'
      ? [...imageSels, ...anySels, ...videoSels]
      : [...imageSels, ...videoSels, ...anySels];

  while (Date.now() < end) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) return loc;
    }
    // Shadow / late mount
    const handle = await page.evaluateHandle((kind) => {
      const walk = (root, out = []) => {
        root.querySelectorAll?.('input[type="file"]')?.forEach((n) => out.push(n));
        root.querySelectorAll?.('*')?.forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot, out);
        });
        return out;
      };
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const inputs = walk(dialog);
      const acceptOf = (i) => String(i.getAttribute('accept') || '');
      const isVideo = (i) => /video|mp4|webm|mov/i.test(acceptOf(i));
      const isImage = (i) => /image|jpg|jpeg|png|webp|gif/i.test(acceptOf(i));
      let prefer = null;
      if (kind === 'video') prefer = inputs.find(isVideo) || inputs.find((i) => !acceptOf(i) || isImage(i) || isVideo(i));
      else if (kind === 'image') prefer = inputs.find(isImage) || inputs.find((i) => !acceptOf(i) || isImage(i) || isVideo(i));
      else prefer = inputs.find((i) => isImage(i) || isVideo(i)) || inputs[0];
      return prefer || null;
    }, preferKind).catch(() => null);
    const el = handle?.asElement?.() || null;
    if (el) return el;
    await waitBrief(page, 250);
  }
  return null;
}

/**
 * 点铅笔后若出现「Upload photo / Upload video」菜单，按文件类型点对应项。
 */
async function pickAvatarSourceMenu(page, isVideo, log = () => {}) {
  const videoRe = /upload\s*video|select\s*video|choose\s*video|上传视频|选择视频|视频头像/i;
  const photoRe = /upload\s*photo|upload\s*image|select\s*photo|choose\s*photo|change\s*photo|上传照片|上传图片|选择照片|图片头像|更换照片/i;
  const want = isVideo ? videoRe : photoRe;
  const fallback = isVideo ? photoRe : videoRe;

  for (let i = 0; i < 6; i += 1) {
    const hit = await page.evaluate((patterns) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const nodes = [...document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], label, li, div, span, a')];
      const match = (re) => nodes.find((el) => {
        if (!visible(el)) return false;
        const t = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim();
        if (t.length > 80) return false;
        return re.test(t);
      });
      const wantRe = new RegExp(patterns.want, 'i');
      const fbRe = new RegExp(patterns.fallback, 'i');
      const el = match(wantRe) || match(fbRe);
      if (!el) return false;
      const clickable = el.closest('button, [role="menuitem"], [role="option"], [role="button"], label, a') || el;
      clickable.click();
      return true;
    }, { want: want.source, fallback: fallback.source }).catch(() => false);

    if (hit) {
      log(`avatar: clicked ${isVideo ? 'video' : 'photo'} source menu`);
      await waitBrief(page, 400);
      return true;
    }
    await waitBrief(page, 250);
  }
  return false;
}

/**
 * 定位 Profile photo 右下角铅笔（支持字母头像，无 img）。
 * 返回 ElementHandle 或 null。
 */
async function findAvatarPencil(page) {
  // 常见 data-e2e / aria
  for (const sel of [
    '[role="dialog"] [data-e2e="edit-profile-avatar-icon"]',
    '[role="dialog"] [data-e2e*="edit-profile-photo"]',
    '[role="dialog"] [data-e2e*="avatar-upload"]',
    '[role="dialog"] [data-e2e*="edit-avatar"]',
    '[role="dialog"] button[aria-label*="Edit profile photo" i]',
    '[role="dialog"] button[aria-label*="Change photo" i]',
    '[role="dialog"] button[aria-label*="Upload" i]',
    '[role="dialog"] label[for]',
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
      return loc.elementHandle();
    }
  }

  return page.evaluateHandle(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;

    const attrHit = [...root.querySelectorAll('button, [role="button"], label, span, div, a')].find((el) => {
      if (!visible(el)) return false;
      const key = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
      return /edit-profile-photo|edit-avatar|edit.?photo|change.?photo|edit.?avatar|upload.?photo|upload.?avatar|编辑头像|上传头像|更换头像|更换照片/.test(key)
        || (/avatar|photo|profile/.test(key) && /edit|upload|change|pencil/.test(key));
    });
    if (attrHit) return attrHit.closest('button, [role="button"], label, a') || attrHit;

    // Profile photo 区块
    const texts = [...root.querySelectorAll('span, div, p, label, h1, h2, h3, strong')].filter((n) => {
      if (!visible(n)) return false;
      const t = (n.textContent || '').trim();
      return /^Profile photo$/i.test(t) || /^头像$/i.test(t) || /^照片$/i.test(t) || /^Profile picture$/i.test(t);
    });

    const scoreCandidate = (c, ir) => {
      const cr = c.getBoundingClientRect();
      if (cr.width > 72 || cr.height > 72 || cr.width < 6 || cr.height < 6) return -1;
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      const nearRight = cx >= ir.left + ir.width * 0.35;
      const nearBottom = cy >= ir.top + ir.height * 0.35;
      const dist = Math.hypot(cx - ir.right, cy - ir.bottom);
      if (!(dist < 120 || (nearRight && nearBottom))) return -1;
      const label = `${c.getAttribute('aria-label') || ''} ${c.getAttribute('data-e2e') || ''} ${c.className || ''}`.toLowerCase();
      let score = 10;
      if (/edit|upload|change|photo|camera|pencil|编辑|上传|更换|相机/.test(label)) score += 40;
      if (c.querySelector('svg') || c.tagName === 'svg' || c.querySelector('path')) score += 25;
      if (nearRight && nearBottom) score += 30;
      if (dist < 56) score += 20;
      // 小圆按钮（铅笔常见 24–40px）
      if (cr.width >= 18 && cr.width <= 44 && cr.height >= 18 && cr.height <= 44) score += 15;
      return score;
    };

    const findNearAvatar = (area) => {
      // 圆形头像：img / 字母占位 / Avatar 容器
      const avatars = [
        ...area.querySelectorAll('img'),
        ...area.querySelectorAll('[class*="Avatar"], [class*="avatar"], [class*="AvatarWrapper"]'),
        ...area.querySelectorAll('div, span'),
      ].filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 48 || r.height < 48 || r.width > 220 || r.height > 220) return false;
        // 近似圆形
        if (Math.abs(r.width - r.height) > 24) return false;
        return true;
      });
      let best = null;
      let bestScore = -1;
      for (const av of avatars) {
        const ir = av.getBoundingClientRect();
        const pool = [
          ...area.querySelectorAll('button, [role="button"], label, span, div, a, svg'),
        ].filter(visible);
        for (const c of pool) {
          if (c === av || (av.contains && av.contains(c) && c !== av)) continue;
          const score = scoreCandidate(c, ir);
          if (score > bestScore) {
            bestScore = score;
            best = c.closest('button, [role="button"], label, a') || c;
          }
        }
      }
      return best;
    };

    for (const t of texts) {
      let row = t.parentElement;
      for (let i = 0; i < 6 && row; i++) {
        const hit = findNearAvatar(row);
        if (hit) return hit;
        row = row.parentElement;
      }
    }

    // 弹层上半区域：找带 svg 的小圆按钮（铅笔）
    const dialogBox = root.getBoundingClientRect();
    const topBtns = [...root.querySelectorAll('button, [role="button"], label, span, div')].filter((b) => {
      if (!visible(b)) return false;
      const r = b.getBoundingClientRect();
      if (r.top < dialogBox.top || r.top > dialogBox.top + 280) return false;
      if (r.width < 16 || r.width > 48 || r.height < 16 || r.height > 48) return false;
      return !!(b.querySelector('svg') || b.tagName === 'svg' || /edit|pencil|camera|upload/i.test(b.getAttribute('aria-label') || ''));
    });
    // 偏好更靠右下的
    topBtns.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.left + br.top) - (ar.left + ar.top);
    });
    return topBtns[0] || null;
  });
}

/**
 * Logo：点头像右下角编辑图标 → 用 Playwright filechooser / setInputFiles。
 * 兼容图片头像（JPG/PNG/WebP）与视频头像（MP4 ≤6s）。
 * 禁止在没有 filechooser 监听时点击铅笔，否则会弹出系统「打开」对话框无法接管。
 */
async function setAvatarInEditModal(page, filePath, log = () => {}) {
  if (!filePath) return false;
  const fs = require('node:fs');
  const path = require('node:path');
  if (!fs.existsSync(filePath)) {
    // 头像文件缺失：改用默认头像，不让整个任务失败
    const missing = filePath;
    filePath = require('./default-avatar').resolveAvatarOrDefault(missing, log);
    if (!filePath) throw new Error(`头像文件不存在：${missing}`);
  }

  const isVideo = isAvatarVideoFile(filePath);
  const preferKind = isVideo ? 'video' : 'image';
  const settleMs = isVideo ? 2200 : 1200;
  log(`avatar: file=${path.basename(filePath)} kind=${isVideo ? 'video' : 'image'}`);

  const setFiles = async (target) => {
    if (!target) return false;
    try {
      if (typeof target.setInputFiles === 'function') {
        await target.setInputFiles(filePath);
        return true;
      }
    } catch (_) {}
    try {
      await target.setFiles?.(filePath);
      return true;
    } catch (_) {}
    try {
      await target.setInputFiles(filePath);
      return true;
    } catch (_) {}
    return false;
  };

  const afterSet = async (via) => {
    log(`avatar: set via ${via}`);
    await waitBrief(page, settleMs);
    await confirmAvatarCrop(page, { isVideo, log });
    return true;
  };

  // A) 已有 input：直接 setInputFiles，不点铅笔（避免系统对话框）
  log('avatar: try direct input[type=file]');
  let input = await findAvatarFileInput(page, 2500, preferKind);
  if (input && await setFiles(input)) {
    return afterSet('existing input');
  }

  // B) 先挂 filechooser，再点铅笔；若弹出 Upload photo/video 菜单则再选对应项
  log('avatar: locate pencil + filechooser');
  const pencilHandle = await findAvatarPencil(page);
  const pencilEl = pencilHandle?.asElement?.() || (pencilHandle?.click ? pencilHandle : null);

  if (pencilEl) {
    try {
      let chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
      await pencilEl.click({ timeout: 8000, force: true }).catch(async () => {
        await page.evaluate((el) => el.click(), pencilEl).catch(() => {});
      });

      // 并行：直接 filechooser，或先出 Upload photo / Upload video 菜单
      const first = await Promise.race([
        chooserPromise.then((c) => ({ type: 'chooser', c })).catch((e) => ({ type: 'err', e })),
        (async () => {
          await waitBrief(page, 700);
          const menu = await pickAvatarSourceMenu(page, isVideo, log);
          return menu ? { type: 'menu' } : { type: 'pending' };
        })(),
      ]);

      if (first.type === 'chooser' && first.c) {
        await first.c.setFiles(filePath);
        return afterSet('filechooser');
      }

      if (first.type === 'menu') {
        // 菜单项再触发 filechooser，或挂载 input；丢弃旧监听
        chooserPromise.catch(() => null);
        chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 });
        const afterMenu = await Promise.race([
          chooserPromise.then((c) => ({ type: 'chooser', c })).catch((e) => ({ type: 'err', e })),
          (async () => {
            const late = await findAvatarFileInput(page, 5000, preferKind);
            if (late && await setFiles(late)) return { type: 'input' };
            return { type: 'pending' };
          })(),
        ]);
        if (afterMenu.type === 'chooser' && afterMenu.c) {
          await afterMenu.c.setFiles(filePath);
          return afterSet('menu+filechooser');
        }
        if (afterMenu.type === 'input') {
          return afterSet('menu+input');
        }
        // 仍在等 chooser
        if (afterMenu.type === 'pending') {
          const c = await chooserPromise;
          await c.setFiles(filePath);
          return afterSet('menu+filechooser');
        }
        throw afterMenu.e || new Error('menu clicked but no filechooser/input');
      }

      // pending：菜单未出现，继续等最初的 filechooser
      if (first.type === 'pending') {
        const chooser = await chooserPromise;
        await chooser.setFiles(filePath);
        return afterSet('filechooser');
      }
      throw first.e || new Error('filechooser timeout');
    } catch (e) {
      log(`avatar: filechooser failed: ${e.message || e}`);
      // 绝不在无监听时再点铅笔（会弹出系统「打开」框）
    }
  } else {
    log('avatar: pencil not found');
  }

  // C) JS 点击 Profile photo 区小按钮 + filechooser（仍必须先监听）
  log('avatar: JS click pencil + filechooser');
  try {
    let chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 });
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]') || document.body;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      let el = [...root.querySelectorAll('button, [role="button"], label')].find((n) => {
        if (!visible(n)) return false;
        const key = `${n.getAttribute('aria-label') || ''} ${n.getAttribute('data-e2e') || ''}`.toLowerCase();
        return /photo|avatar|upload|edit|pencil|头像|上传|video/.test(key);
      });
      if (!el) {
        const title = [...root.querySelectorAll('*')].find((n) => {
          const t = (n.textContent || '').trim();
          return /^Profile photo$/i.test(t) || /^头像$/i.test(t) || /^Profile picture$/i.test(t);
        });
        const area = title?.closest('div') || root;
        const av = [...area.querySelectorAll('img, video, div, span')].find((n) => {
          const r = n.getBoundingClientRect();
          return r.width >= 64 && r.width <= 200 && Math.abs(r.width - r.height) < 20;
        });
        if (av) {
          const ir = av.getBoundingClientRect();
          el = [...area.querySelectorAll('button, [role="button"], span, div')].find((n) => {
            if (!visible(n) || !n.querySelector?.('svg')) return false;
            const r = n.getBoundingClientRect();
            if (r.width > 48 || r.height > 48) return false;
            return r.left >= ir.left + ir.width * 0.3 && r.top >= ir.top + ir.height * 0.3;
          });
        }
      }
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    });
    if (clicked) {
      const menuClicked = await pickAvatarSourceMenu(page, isVideo, log).catch(() => false);
      if (menuClicked) {
        chooserPromise.catch(() => null);
        chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 });
      }
      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);
      return afterSet('JS filechooser');
    }
    await chooserPromise.catch(() => null);
  } catch (e) {
    log(`avatar: JS filechooser failed: ${e.message || e}`);
  }

  // D) 点击后再找 input（部分 UI 点击后才挂载 input，且不走系统对话框）
  input = await findAvatarFileInput(page, 6000, preferKind);
  if (input && await setFiles(input)) {
    return afterSet('input after pencil');
  }

  log('avatar: all strategies failed');
  return false;
}

async function confirmAvatarCrop(page, { isVideo = false, log = () => {} } = {}) {
  // 图片裁剪 / 视频预览确认，避开 Edit profile 底部 Save
  const dialogRe = isVideo
    ? /crop|preview|trim|调整|裁剪|预览|剪辑|Drag to reposition|拖动|video|视频/i
    : /crop|preview|调整|裁剪|预览|Drag to reposition|拖动/i;
  const btnNames = isVideo
    ? ['Apply', '应用', 'Done', '完成', 'Confirm', '确认', 'Use', '使用', 'Next', '下一步', 'OK', 'Select', '选择']
    : ['Apply', '应用', 'Done', '完成', 'Confirm', '确认', 'OK'];

  for (let i = 0; i < (isVideo ? 12 : 8); i += 1) {
    const cropDialog = page.locator('[role="dialog"]').filter({ hasText: dialogRe }).first();
    const hasCrop = await cropDialog.count().catch(() => 0) && await cropDialog.isVisible().catch(() => false);
    const scope = hasCrop ? cropDialog : page;

    for (const name of btnNames) {
      const apply = scope.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
      if (!(await apply.count().catch(() => 0))) continue;
      if (!(await apply.isVisible().catch(() => false))) continue;
      if (!hasCrop && /^(Save|保存)$/i.test(name)) continue;
      await apply.click({ timeout: 5000, force: true }).catch(() => {});
      log(`avatar: confirmed ${isVideo ? 'video' : 'crop'} via ${name}`);
      await waitBrief(page, isVideo ? 1200 : 800);
      return true;
    }
    await waitBrief(page, isVideo ? 500 : 400);
  }
  return false;
}

async function fillProfileField(page, labels, value) {
  const wantBio = (labels || []).some((x) => /bio|签名|简介/i.test(x));
  if (wantBio) return fillBioInEditModal(page, value);
  return fillNameInEditModal(page, value);
}


async function clickProfileSave(page) {
  // 「Set nickname?」确认框可能盖在编辑弹框上，先点掉再点保存
  await confirmSetNicknamePopup(page, () => {}, 1200);

  // 注意：确认框本身也是 role="dialog"，所以要按标题锁定「编辑资料」那个弹框，
  // 否则可能把确认框里的 Confirm 当成保存按钮点了（假成功）。
  const editDialog = page.locator('[role="dialog"]').filter({ hasText: /Edit profile|编辑资料/i }).first();
  const scopes = [];
  if (await editDialog.count().catch(() => 0) && await editDialog.isVisible().catch(() => false)) {
    scopes.push(editDialog);
  }
  scopes.push(page);

  for (const scope of scopes) {
    // 弹框底部 Save（可能需滚动）
    await scope.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await page.waitForTimeout(300);
    for (const name of ['Save', '保存', 'Done', '完成']) {
      const button = scope.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
      if (await button.count().catch(() => 0) && await button.isVisible().catch(() => false)) {
        const disabled = await button.isDisabled().catch(() => false);
        if (disabled) continue;
        await button.click({ timeout: 8000 });
        return true;
      }
    }
    const textBtn = scope.getByText(/^(Save|保存)$/i).first();
    if (await textBtn.count().catch(() => 0) && await textBtn.isVisible().catch(() => false)) {
      await textBtn.click({ timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** 定位 Username / Unique ID 输入框 */
async function findUsernameInput(page) {
  const selectors = [
    'input[data-e2e="edit-profile-username-input"]',
    'input[data-e2e*="username"]',
    'input[name*="username" i]',
    'input[placeholder*="username" i]',
    'input[aria-label*="username" i]',
    'input[aria-label*="Unique ID" i]',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      return el;
    }
  }
  const byLabel = page.getByLabel(/^(Username|Unique ID|用户名|账号名)$/i).first();
  if (await byLabel.count().catch(() => 0) && await byLabel.isVisible().catch(() => false)) {
    const tag = await byLabel.evaluate((n) => (n.tagName || '').toLowerCase()).catch(() => '');
    if (tag === 'input') return byLabel;
  }
  const handle = await page.evaluateHandle(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const isUserLabel = (t) => {
      const x = String(t || '').trim().toLowerCase();
      return x === 'username' || x === 'unique id' || x === 'user name'
        || x === '用户名' || x === '账号名' || x === '账号名称';
    };
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;
    const labels = Array.from(root.querySelectorAll('label, span, div, p, strong, b'));
    for (const n of labels) {
      if (!visible(n)) continue;
      const t = (n.textContent || '').trim();
      if (!isUserLabel(t) || t.length > 24) continue;
      if (n.closest('button, a, [role="button"]')) continue;
      if (n.tagName === 'LABEL' && n.htmlFor) {
        const byFor = document.getElementById(n.htmlFor);
        if (byFor && visible(byFor) && (byFor.tagName || '').toLowerCase() === 'input') return byFor;
      }
      let row = n.parentElement;
      for (let i = 0; i < 6 && row; i++) {
        const inputs = [...row.querySelectorAll('input:not([type="hidden"]):not([type="file"])')]
          .filter((el) => visible(el) && !n.contains(el));
        for (const el of inputs) {
          const meta = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
          if (/bio|简介|edit-profile-name|(^|\s)name(\s|$)/.test(meta) && !/username|unique|user.?name|用户名/.test(meta)) continue;
          if (/username|unique|user.?name|用户名/.test(meta) || isUserLabel(t)) return el;
        }
        row = row.parentElement;
      }
    }
    return null;
  });
  return handle.asElement?.() || null;
}

async function readUsernameFromEditModal(page) {
  const el = await findUsernameInput(page);
  if (!el) return '';
  let val = '';
  if (typeof el.inputValue === 'function') {
    val = await el.inputValue().catch(() => '');
  }
  if (!val && typeof el.evaluate === 'function') {
    val = await el.evaluate((n) => n.value || '').catch(() => '');
  }
  return normalizeHandle(val);
}

async function fillUsernameInEditModal(page, value, log = () => {}) {
  const next = normalizeHandle(value);
  if (!next) return false;
  const el = await findUsernameInput(page);
  if (!el) {
    log('username: input not found');
    return false;
  }
  // Locator：走 setReactInputValue；ElementHandle：直接 evaluate
  if (typeof el.first === 'function') {
    const disabled = await el.isDisabled().catch(() => true);
    const readonly = await el.getAttribute('readonly').catch(() => null);
    if (disabled || readonly != null) {
      log('username: input locked');
      return false;
    }
    const ok = await setReactInputValue(el, next);
    log(ok ? `username: filled ${next}` : `username: fill failed ${next}`);
    return ok;
  }
  const filled = await el.evaluate((node, nextVal) => {
    if (node.disabled || node.readOnly) return false;
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const fire = (type) => {
      node.dispatchEvent(new Event(type, { bubbles: true }));
      try {
        node.dispatchEvent(new InputEvent(type, { bubbles: true, data: String(nextVal ?? ''), inputType: 'insertText' }));
      } catch (_) {}
    };
    node.focus();
    if (setter) setter.call(node, '');
    else node.value = '';
    fire('input');
    if (setter) setter.call(node, String(nextVal ?? ''));
    else node.value = String(nextVal ?? '');
    fire('input');
    node.dispatchEvent(new Event('change', { bubbles: true }));
    try { node.blur(); } catch (_) {}
    return String(node.value ?? '').replace(/^@+/, '') === String(nextVal ?? '').replace(/^@+/, '');
  }, next).catch(() => false);
  log(filled ? `username: filled ${next}` : `username: fill failed ${next}`);
  return !!filled;
}

/** 检测弹框内 Username 占用/不可用提示 */
async function detectUsernameConflict(page) {
  const text = await page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;
    return String(root?.innerText || document.body?.innerText || '');
  }).catch(() => '');
  const compact = String(text || '').replace(/\s+/g, ' ');
  if (!USERNAME_TAKEN_RE.test(compact)) return null;
  const m = compact.match(USERNAME_TAKEN_RE);
  const snippet = (m && m[0]) ? m[0] : 'Username is unavailable';
  return snippet.slice(0, 180);
}

/**
 * 只用于「展示/日志」的文案探测——**不要用它判定昵称是否被限制**。
 * TikTok 编辑资料弹框里常驻 "Your nickname can only be changed once every 7 days."
 * 这类提示语，输入框依然可以正常输入提交；判锁一律以 isNameFieldEditable 的输入框状态为准。
 */
async function detectNicknameLockMessage(page) {
  const text = await page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]')
      || document.querySelector('[class*="DivEditProfileContainer"]')
      || document.querySelector('[class*="edit-profile"]')
      || document.body;
    return String(root?.innerText || '');
  }).catch(() => '');
  const compact = String(text || '').replace(/\s+/g, ' ');
  if (!NICKNAME_LOCK_RE.test(compact)) return '';
  const m = compact.match(NICKNAME_LOCK_RE);
  return (m && m[0] ? m[0] : '昵称受 7 天修改限制').slice(0, 180);
}

/**
 * 保存资料；若因 Username 冲突失败，恢复原 Username 再保存一次，保证昵称/头像可提交。
 * @returns {{ saved: boolean, usernameConflict: boolean, usernameFailReason: string }}
 */
async function saveEditProfileWithUsernameRecovery(page, {
  originalUsername = '',
  attemptedUsername = '',
} = {}, log = () => {}) {
  const result = {
    saved: false,
    usernameConflict: false,
    usernameFailReason: '',
  };
  const wantChange = normalizeHandle(attemptedUsername)
    && normalizeHandle(attemptedUsername) !== normalizeHandle(originalUsername);
  const saved = await clickProfileSave(page);
  if (!saved) return result;
  // 有些情况下「Set nickname?」确认框是在点保存之后才弹出来的
  await confirmSetNicknamePopup(page, log, 2500);
  await page.waitForTimeout(1600);

  let reason = await detectUsernameConflict(page);
  if (!reason && wantChange) {
    // 弹框仍在且 Save 仍可点 → 可能校验失败未关闭
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Edit profile|编辑资料/i }).first();
    const stillOpen = await dialog.isVisible().catch(() => false);
    if (stillOpen) {
      const saveBtn = dialog.getByRole('button', { name: /^(Save|保存)$/i }).first();
      const saveVisible = await saveBtn.isVisible().catch(() => false);
      if (saveVisible) {
        reason = await detectUsernameConflict(page) || 'Username 可能不可用（保存后弹框未关闭）';
      }
    }
  }

  if (reason && wantChange) {
    result.usernameConflict = true;
    result.usernameFailReason = reason;
    log(`username: conflict — ${reason}; restoring ${originalUsername}`);
    const restored = await fillUsernameInEditModal(page, originalUsername, log);
    if (!restored) {
      log('username: restore fill failed');
    }
    await page.waitForTimeout(500);
    const saved2 = await clickProfileSave(page);
    if (saved2) {
      await page.waitForTimeout(1800);
      result.saved = true;
      log('username: restored and re-saved');
    }
    return result;
  }

  result.saved = true;
  return result;
}

/**
 * 在已打开的 Edit profile 弹框中写入 Username/Name/Bio/头像。
 * @returns {object} 明细结果（兼容旧调用：changed === false | true，name_locked 用 nameLocked）
 */
async function applyEditProfileChanges(page, {
  username = '',
  originalUsername = '',
  nickname = '',
  bio = '',
  avatarPath = '',
} = {}, log = () => {}) {
  const outcome = {
    changed: false,
    nameLocked: false,
    nameLockReason: '',
    nicknameFilled: false,
    nicknameAttempted: false,
    nicknameConfirmed: false,
    nicknameValueChanged: false,
    nicknameFailReason: '',
    usernameFilled: false,
    usernameAttempted: '',
    usernameFailReason: '',
    bioFilled: false,
    bioFailReason: '',
    avatarFilled: false,
    originalUsername: normalizeHandle(originalUsername),
  };

  const wantUser = normalizeHandle(username);
  const origUser = normalizeHandle(originalUsername) || (await readUsernameFromEditModal(page));
  outcome.originalUsername = origUser;
  // 一眼看出这次到底要改哪些字段（昵称显示 - 就说明上游没把昵称传下来）
  log(`plan: username=${wantUser || '-'} nickname=${nickname || '-'} bio=${bio ? 'yes' : '-'} avatar=${avatarPath ? 'yes' : '-'}`);
  const formInputs = await listEditInputs(page).catch(() => []);
  log(`form inputs: ${formInputs.filter((i) => i.visible).map((i) => `${i.tag}${i.e2e ? `[e2e=${i.e2e}]` : ''}${i.placeholder ? `[ph=${i.placeholder}]` : ''}="${String(i.value || '').slice(0, 14)}"`).join(' | ') || '(none)'}`);
  if (wantUser && wantUser !== origUser) {
    outcome.usernameAttempted = wantUser;
    outcome.usernameFilled = await fillUsernameInEditModal(page, wantUser, log);
    if (outcome.usernameFilled) outcome.changed = true;
    else outcome.usernameFailReason = '未找到可编辑的 Username 输入框';
  }

  if (nickname) {
    outcome.nicknameAttempted = true;
    // 记录填写前的昵称，用于判断「真的改了」还是「填了一样的值」
    const before = await readProfileFormValues(page).catch(() => ({ nickname: '', bio: '' }));
    const prevNick = String(before?.nickname || '').trim();
    // 是否被官方限制「只按输入框是否可输入」判断：
    // 弹框里常驻的 "Your nickname can only be changed once every 7 days." 只是提示文案，
    // 输入框仍可正常填写并提交，不能据此判锁。
    const nameState = await isNameFieldEditable(page);
    const lockedByInput = !nameState.editable && nameState.reason === 'name-input-locked';
    if (lockedByInput) {
      outcome.nameLocked = true;
      outcome.nameLockReason = '距离上次修改未超过7天暂时无法修改';
      outcome.nicknameFailReason = outcome.nameLockReason;
      log('name: locked (input disabled/readonly)');
    } else {
      if (!nameState.editable) {
        log(`name: input not identified (${nameState.reason || 'unknown'}) — 继续尝试填写`);
      }
      const nameOk = await fillNameInEditModal(page, nickname, log);
      if (nameOk) {
        outcome.nicknameFilled = true;
        outcome.changed = true;
        outcome.nicknameValueChanged = prevNick ? prevNick !== String(nickname).trim() : true;
        log(`name: value "${prevNick || '(空)'}" → "${String(nickname).trim()}" (valueChanged=${outcome.nicknameValueChanged})`);
        // 填完立刻处理「Set nickname?」二次确认框，否则会挡住后续保存
        outcome.nicknameConfirmed = await confirmSetNicknamePopup(page, log, 4000);
      } else {
        outcome.nicknameFailReason = '未找到可填写的昵称输入框（弹框结构未识别）';
        // 填完再探一次：只有输入框变成禁用/只读才判锁
        const again = await isNameFieldEditable(page);
        if (!again.editable && again.reason === 'name-input-locked') {
          outcome.nameLocked = true;
          outcome.nameLockReason = '距离上次修改未超过7天暂时无法修改';
          outcome.nicknameFailReason = outcome.nameLockReason;
          log('name: locked after fill attempt (input disabled/readonly)');
        }
      }
    }
  }

  if (bio) {
    outcome.bioFilled = await fillBioInEditModal(page, bio);
    if (outcome.bioFilled) outcome.changed = true;
    else outcome.bioFailReason = '未找到可填写的 Bio 输入框';
  }
  if (avatarPath) {
    const ok = await setAvatarInEditModal(page, avatarPath, log);
    if (!ok) {
      throw new Error('头像/Logo 上传失败：未能通过自动化选择图片或视频。若桌面弹出了系统「打开」对话框请先点取消，然后重试同步资料');
    }
    outcome.avatarFilled = true;
    outcome.changed = true;
  }

  // 仅想改 Name 且当前不可改：不算失败
  if (!outcome.changed && outcome.nameLocked && !bio && !avatarPath && !outcome.usernameFilled) {
    log('name: locked — nothing else to sync');
    outcome.nameLockedOnly = true;
  }
  return outcome;
}

/** 关闭 Cookie / 提示遮罩，避免挡住编辑按钮 */
async function dismissOverlays(page) {
  const labels = [
    /^(Accept all|Accept|Allow all|I agree|Got it|OK|Agree|允许全部|同意|接受|知道了)$/i,
    /Accept cookies|接受 Cookie/i,
  ];
  for (const re of labels) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

/** 在页面及 iframe 内按文案点击（含非 button 节点） */
async function clickByTextDeep(page, pattern) {
  const frames = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    const hit = await frame.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div, p'));
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40) continue;
        if (!rx.test(text)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        el.click();
        return text;
      }
      return '';
    }, pattern).catch(() => '');
    if (hit) {
      await page.waitForTimeout(1500);
      return hit;
    }
  }
  return '';
}

async function waitForEditForm(page, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Edit profile|编辑资料/i }).first();
    if (await dialog.count().catch(() => 0) && await dialog.isVisible().catch(() => false)) {
      const hasFields = await dialog.locator('input, textarea').count().catch(() => 0);
      if (hasFields > 0) return true;
    }
    const vals = await readProfileFormValues(page);
    const hasInput = await page.locator([
      ...NAME_INPUT_SELECTORS,
      ...BIO_INPUT_SELECTORS,
      '[role="dialog"] input',
      '[role="dialog"] textarea',
    ].join(', ')).count().catch(() => 0);
    if (hasInput || profileFormFilled(vals)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/** 进入本人个人中心（Profile） */
async function goToPersonalCenter(page, handle) {
  await dismissOverlays(page);

  // 优先点导航「个人中心 / Profile」
  const navCandidates = [
    page.locator('[data-e2e="nav-profile"]').first(),
    page.locator('[data-e2e="profile-icon"]').first(),
    page.locator('a[href*="/@"][data-e2e*="profile" i]').first(),
    page.getByRole('link', { name: /^(Profile|个人中心|我|Me)$/i }).first(),
    page.getByRole('button', { name: /^(Profile|个人中心|我|Me)$/i }).first(),
  ];
  for (const candidate of navCandidates) {
    if (await candidate.count().catch(() => 0) && await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await dismissOverlays(page);
      if (new RegExp(`tiktok\\.com/@${handle}`, 'i').test(page.url()) || /tiktok\.com\/@/i.test(page.url())) {
        return true;
      }
    }
  }

  // 右上角头像 → View profile
  const avatarSelectors = [
    '[data-e2e="nav-profile"] img',
    '[data-e2e="top-login-avatar"]',
    '[data-e2e="top-login-avatar"] img',
    'header [class*="Avatar"] img',
    'button[aria-label*="profile" i] img',
  ];
  for (const sel of avatarSelectors) {
    const avatar = page.locator(sel).first();
    if (!(await avatar.count().catch(() => 0)) || !(await avatar.isVisible().catch(() => false))) continue;
    await avatar.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const viewHit = await clickByTextDeep(page, 'View profile|查看主页|查看资料|个人主页|^Profile$');
    if (viewHit || /tiktok\.com\/@/i.test(page.url())) {
      await page.waitForTimeout(2000);
      return true;
    }
  }

  // 兜底：直接打开本人主页（强制 en 便于匹配 Edit profile）
  const urls = [
    `https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=en`,
    `https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=zh-Hans`,
    `https://www.tiktok.com/@${encodeURIComponent(handle)}`,
  ];
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2800);
    await dismissOverlays(page);
    if (/tiktok\.com\/@/i.test(page.url())) return true;
  }
  return false;
}

/** 尝试点击个人主页上的 Edit profile 按钮，打开编辑弹框 */
async function tryClickEditEntry(page) {
  // SPA 渲染有延迟：先等按钮/文案出现，避免 2 秒前就判死
  await page.waitForSelector(
    '[data-e2e="edit-profile-enter"], [data-e2e="edit-profile-button"], button[data-e2e*="edit-profile"]',
    { timeout: 6000 }
  ).catch(() => {});

  // 截图中的主按钮：个人主页统计下方的 “Edit profile”
  const exact = [
    page.locator('[data-e2e="edit-profile-enter"]').first(),
    page.locator('[data-e2e="edit-profile-button"]').first(),
    page.locator('a[data-e2e="edit-profile-enter"]').first(),
    page.getByRole('button', { name: /^Edit profile$/i }).first(),
    page.getByRole('button', { name: /^编辑资料$/i }).first(),
    page.locator('button').filter({ hasText: /^Edit profile$/i }).first(),
    page.locator('button').filter({ hasText: /^编辑资料$/i }).first(),
    page.getByRole('link', { name: /^Edit profile$/i }).first(),
  ];
  for (const el of exact) {
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (await waitForEditForm(page, 8000)) return true;
    }
  }

  const textHit = await clickByTextDeep(page, '^Edit profile$|^编辑资料$');
  if (textHit && await waitForEditForm(page, 8000)) return true;
  return false;
}

/** 读取个人主页当前状态，用于判断「为什么没有 Edit profile 按钮」 */
async function describeProfilePageState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const anyVisible = (sel) => Array.from(document.querySelectorAll(sel)).some(visible);
    const txt = String((document.body && document.body.innerText) || '').slice(0, 6000);
    return {
      editBtn: anyVisible('[data-e2e="edit-profile-enter"], [data-e2e="edit-profile-button"], button[data-e2e*="edit-profile"]'),
      followBtn: anyVisible('[data-e2e="follow-button"], button[data-e2e*="follow"]'),
      loginWall: anyVisible('[data-e2e*="login"], a[href*="/login"], button[data-e2e*="login"]'),
      notFound: /couldn'?t find this account|无法找到该账号|找不到此账号|该账号不存在/i.test(txt),
      captcha: /captcha|verify|verification|安全验证|人机验证|滑块|unusual activity|too many attempts/i.test(txt),
      title: (document.querySelector('[data-e2e="user-title"], [data-e2e="user-subtitle"], h1')?.textContent || '').trim().slice(0, 60),
      url: location.href,
    };
  }).catch(() => null);
}

/** 等主页渲染到可判断状态（出现按钮 / 不存在 / 登录墙），返回最后一次探测结果 */
async function waitForProfileActionable(page, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await describeProfilePageState(page);
    if (last && (last.editBtn || last.notFound || last.captcha || last.followBtn)) return last;
    await page.waitForTimeout(400);
  }
  return last;
}

/** 从页面导航栏解析「当前真正登录的」TikTok handle */
async function resolveLoggedInHandle(page) {
  return page.evaluate(() => {
    const probes = ['[data-e2e="nav-profile"]', 'header a[href^="/@"]', 'a[href^="/@"][data-e2e*="profile" i]'];
    for (const sel of probes) {
      for (const el of document.querySelectorAll(sel)) {
        const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
        const m = String(href).match(/^\/@([A-Za-z0-9._]+)/);
        if (m) return m[1];
      }
    }
    return '';
  }).catch(() => '');
}

/** 在个人中心打开「编辑资料」弹框 */
async function openEditProfile(page, handle, log = () => {}) {
  await dismissOverlays(page);

  // 直接打开本人主页（与用户截图一致）
  await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=en`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(1500);
  await dismissOverlays(page);

  let state = await waitForProfileActionable(page, 15000);
  if (state) {
    log(`profile page: edit=${state.editBtn} follow=${state.followBtn} login=${state.loginWall} notFound=${state.notFound} captcha=${state.captcha} title=${state.title || '-'}`);
  }
  if (state?.captcha) {
    throw new Error(`TikTok 出现人机/安全验证，无法进入编辑资料（${state.url}），请先在浏览器里人工处理验证`);
  }

  // 不是本人主页（不存在 / 只有 Follow）→ 走导航栏个人中心，落到真正登录的账号
  if (!state?.editBtn && (state?.notFound || state?.followBtn || state?.loginWall || !state)) {
    log(`profile page: 未出现 Edit profile（notFound=${!!state?.notFound} follow=${!!state?.followBtn}），改用导航栏个人中心`);
    await goToPersonalCenter(page, handle).catch(() => {});
    const after = await waitForProfileActionable(page, 12000);
    if (after) {
      log(`profile page(after nav): edit=${after.editBtn} follow=${after.followBtn} login=${after.loginWall} title=${after.title || '-'} url=${after.url}`);
      state = after;
    }
  }

  if (state && !state.editBtn && state.loginWall) {
    throw new Error('TikTok 登录状态疑似已失效：个人主页没有「Edit profile」按钮，请到账号页重新登录该浏览器环境后再试');
  }

  if (await tryClickEditEntry(page)) return true;

  // 系统里的 username 可能已被改过（TikTok 上是另一个名字）→ 用页面导航栏解析出的真实 handle 再试
  const realHandle = await resolveLoggedInHandle(page);
  if (realHandle && realHandle.toLowerCase() !== String(handle || '').toLowerCase()) {
    log(`profile page: 系统 @${handle} 与登录账号 @${realHandle} 不一致，改用 @${realHandle}`);
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(realHandle)}?lang=en`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});
    await page.waitForTimeout(1800);
    await dismissOverlays(page);
    const s2 = await waitForProfileActionable(page, 12000);
    if (s2) log(`profile page(real handle): edit=${s2.editBtn} follow=${s2.followBtn} login=${s2.loginWall} title=${s2.title || '-'}`);
    if (await tryClickEditEntry(page)) return true;
  }

  await page.mouse.wheel(0, 300).catch(() => {});
  await page.waitForTimeout(800);
  if (await tryClickEditEntry(page)) return true;

  // 导航栏进个人中心再点
  await goToPersonalCenter(page, handle).catch(() => {});
  await page.waitForTimeout(1500);
  return tryClickEditEntry(page);
}

/** 读取编辑资料弹框中的 Name / Bio（忽略 Username） */
async function readProfileFormValues(page) {
  const result = { nickname: '', bio: '' };
  for (const sel of NAME_INPUT_SELECTORS) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    result.nickname = String(await el.inputValue().catch(() => '') || '').trim();
    break;
  }
  if (!result.nickname) {
    const byLabel = page.getByLabel(/^Name$/i).first();
    if (await byLabel.count().catch(() => 0) && await byLabel.isVisible().catch(() => false)) {
      const meta = fieldMeta({
        e2e: await byLabel.getAttribute('data-e2e').catch(() => ''),
        name: await byLabel.getAttribute('name').catch(() => ''),
      });
      if (!looksLikeUsername(meta)) {
        result.nickname = String(await byLabel.inputValue().catch(() => '') || '').trim();
      }
    }
  }
  for (const sel of BIO_INPUT_SELECTORS) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    result.bio = String(await el.inputValue().catch(() => '') || '').trim();
    break;
  }
  return result;
}

function profileFormFilled(fields) {
  return Boolean(String(fields?.nickname || '').trim() || String(fields?.bio || '').trim());
}

/** 从个人主页 DOM 读取 Following / Followers / Likes / Videos */
async function scrapeProfileStatsFromDom(page) {
  return page.evaluate(() => {
    const parseNum = (raw) => {
      const text = String(raw || '').replace(/,/g, '').trim().toUpperCase();
      const m = text.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
      if (!m) return null;
      const mul = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
      return Math.round(Number(m[1]) * mul);
    };
    const pick = (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const n = parseNum(el.getAttribute('title') || el.textContent || '');
        if (n != null) return n;
      }
      return null;
    };
    const following = pick([
      '[data-e2e="following-count"]',
      'strong[data-e2e="following-count"]',
      'a[href*="/following"] strong',
      'a[href*="/following"] [title]',
    ]);
    const followers = pick([
      '[data-e2e="followers-count"]',
      'strong[data-e2e="followers-count"]',
      'a[href*="/followers"] strong',
      'a[href*="/followers"] [title]',
    ]);
    const likes = pick([
      '[data-e2e="likes-count"]',
      'strong[data-e2e="likes-count"]',
      '[data-e2e="like-count"]',
    ]);

    let videos = null;
    const tabNodes = Array.from(document.querySelectorAll('[data-e2e*="tab"], [role="tab"], a, span, div, strong, p'));
    for (const n of tabNodes) {
      const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40) continue;
      const m = t.match(/^(?:Videos|视频|作品)\s*([0-9][0-9,.]*\s*[KMB]?)$/i)
        || t.match(/^([0-9][0-9,.]*\s*[KMB]?)\s*(?:Videos|视频|作品)$/i);
      if (m) {
        videos = parseNum(m[1]);
        if (videos != null) break;
      }
    }
    if (videos == null) {
      const grid = document.querySelectorAll(
        '[data-e2e="user-post-item"], [data-e2e="user-post-item-list"] a[href*="/video/"], a[href*="/video/"]'
      );
      if (grid.length) videos = grid.length;
    }

    const body = (document.body?.innerText || '').slice(0, 4000);
    const fromBody = (label) => {
      const m1 = body.match(new RegExp(`([0-9][0-9,.]*\\s*[KMB]?)\\s*(?:${label})\\b`, 'i'));
      if (m1) return parseNum(m1[1]);
      const m2 = body.match(new RegExp(`(?:${label})\\s*([0-9][0-9,.]*\\s*[KMB]?)`, 'i'));
      if (m2) return parseNum(m2[1]);
      return null;
    };

    return {
      followingCount: following ?? fromBody('Following|关注'),
      followersCount: followers ?? fromBody('Followers|粉丝|关注者'),
      likesCount: likes ?? fromBody('Likes|赞|获赞'),
      videosCount: videos,
      displayName: (document.querySelector('h1, [data-e2e="user-title"]')?.textContent || '').trim(),
      bio: (document.querySelector('[data-e2e="user-bio"], h2')?.textContent || '').trim(),
      avatarUrl: document.querySelector('[data-e2e="user-avatar"] img, img')?.getAttribute('src') || '',
    };
  }).catch(() => ({}));
}

/** 公开主页抓取资料与粉丝等统计 */
async function scrapePublicProfile(page, account) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/log in|登录|sign up/i.test(body) && !/followers|关注者|Following|粉丝/i.test(body)) {
    throw new Error('当前浏览器没有有效 TikTok 登录状态');
  }
  const dom = await scrapeProfileStatsFromDom(page);
  const profile = {
    accountId: account.id,
    handle: account.username,
    displayName: String(dom.displayName || '').trim(),
    bio: String(dom.bio || '').trim(),
    avatarUrl: String(dom.avatarUrl || '').trim(),
    followersCount: dom.followersCount ?? extractStat(body, ['followers', '粉丝', '关注者']),
    followingCount: dom.followingCount ?? extractStat(body, ['following', '关注']),
    likesCount: dom.likesCount ?? extractStat(body, ['likes', '赞', '获赞']),
    videosCount: dom.videosCount ?? extractStat(body, ['videos', '视频', '作品']),
    verified: /verified|已认证/i.test(body) ? 1 : 0,
    sourceUrl: page.url(),
  };
  if (!profile.displayName) {
    const title = await page.title().catch(() => '');
    profile.displayName = title.replace(/\s*\|\s*TikTok.*$/i, '').trim() || account.username;
  }
  if (!profile.avatarUrl) {
    profile.avatarUrl = await page.locator('img').first().getAttribute('src').catch(() => '') || '';
  }
  return profile;
}

async function persistProfile(accountId, profile) {
  await dataStore.tiktokSync(accountId, {
    profile: {
      handle: profile.handle,
      displayName: profile.displayName,
      bio: profile.bio || '',
      avatarUrl: profile.avatarUrl,
      followers: profile.followersCount || 0,
      following: profile.followingCount || 0,
      likes: profile.likesCount || 0,
      videos: profile.videosCount || 0,
    },
    stats: {
      followers: profile.followersCount || 0,
      following: profile.followingCount || 0,
      likes: profile.likesCount || 0,
      videos: profile.videosCount || 0,
    },
  });
}

async function loadStoredProfile(accountId) {
  try {
    return await phpApi.get(`/accounts/${accountId}/tiktok-profile`);
  } catch {
    return null;
  }
}

/**
 * 同步资料 = 把「系统里设置的资料」推送到 TikTok（不是从 TikTok 拉回系统）
 * 流程：读系统 username / nickname / profile_bio / profile_avatar
 *      → 个人主页 → Edit profile → 填 Username/Name/Bio/头像 → Save（Username 冲突则恢复）
 */
async function syncProfile(accountId, options = {}) {
  const account = await loadAccount(accountId);
  let session;
  let keepOpenOnFail = false;
  try {
    const originalUsername = normalizeHandle(
      options.originalUsername || options.original_username || account.username,
    );
    const wantUsername = normalizeHandle(options.username || options.handle || '');
    const wantNickname = String(options.nickname || options.displayName || account.nickname || '').trim();
    const wantBio = String(options.signature || options.bio || account.profileBio || '').trim();
    let avatarPath = String(options.avatarPath || options.avatarUrl || account.profileAvatar || '').trim();
    const hasOriginalNickname = options.originalNickname != null || options.original_nickname != null;
    const originalNickname = String(options.originalNickname ?? options.original_nickname ?? '').trim();

    if (!wantUsername && !wantNickname && !wantBio && !avatarPath) {
      throw new Error('系统资料为空：请先在「修改资料」里设置账号名/昵称/签名/头像，再点同步资料推送到 TikTok');
    }

    let avatarFile = '';
    if (avatarPath) {
      const path = require('node:path');
      const fs = require('node:fs');
      avatarFile = avatarPath;
      const { uploadDir } = require('../../routes/uploads');
      const m = avatarPath.match(/^\/?uploads\/([^/\\]+)$/i)
        || avatarPath.match(/\/uploads\/([^/\\]+)(?:\?|$)/i);
      if (m) avatarFile = path.join(uploadDir, m[1]);
      if (!path.isAbsolute(avatarFile)) avatarFile = path.resolve(process.cwd(), avatarFile);
      if (!fs.existsSync(avatarFile)) {
        // 头像文件缺失：改用默认头像，不让同步资料失败
        const missing = avatarFile;
        avatarFile = require('./default-avatar').resolveAvatarOrDefault(missing, (m) => {
          try { require('../live-log').publish(`同步资料#${accountId}：${m}`, 'warn', { accountId }); } catch { /* ignore */ }
        });
        if (!avatarFile) throw new Error(`头像文件不存在：${missing}`);
      }
      if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(avatarFile)) {
        throw new Error('头像仅支持图片（JPG/PNG/WebP/GIF）或视频（MP4，建议 ≤6 秒）');
      }
    }

    session = await openBitPage(account, 'profile');
    const { page, ws } = session;
    const { publish: liveLog } = require('../live-log');
    const log = (msg) => liveLog(`同步资料#${accountId}：${msg}`, 'info', { accountId });

    await page.goto('https://www.tiktok.com/foryou?lang=en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissOverlays(page);

    if (await pageLooksLoggedOut(page)) {
      keepOpenOnFail = true;
      throw new Error('当前浏览器未登录 TikTok，请先点「登录」完成登录后再同步资料');
    }
    const login = await inspectTikTokSession(ws).catch(() => null);
    if (login && login.loggedIn === false && !(await pageLooksLoggedIn(page))) {
      keepOpenOnFail = true;
      throw new Error('当前浏览器没有有效 TikTok 登录状态，请先登录');
    }

    // 个人主页必须用「原 Username」（TikTok 侧尚未改名）
    const navHandle = originalUsername || normalizeHandle(account.username);
    const opened = await openEditProfile(page, navHandle);
    if (!opened) {
      keepOpenOnFail = true;
      const shot = await capture(page, account.id, 'profile', 'edit-miss').catch(() => '');
      throw new Error(`未找到「Edit profile」入口，请确认已登录本人账号${shot ? `（截图：${shot}）` : ''}`);
    }

    if (avatarFile) log(`avatar file: ${avatarFile}`);
    const applied = await applyEditProfileChanges(page, {
      username: wantUsername,
      originalUsername: navHandle,
      nickname: wantNickname,
      bio: wantBio,
      avatarPath: avatarFile,
    }, log);

    if (applied.nameLocked && wantNickname && hasOriginalNickname) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        restoreNickname: originalNickname,
        nicknameLocked: true,
        markNicknameChanged: true,
      }).catch(() => {});
    }

    if (applied.nameLockedOnly) {
      return {
        accountId: account.id,
        handle: navHandle,
        pushed: false,
        nameLocked: true,
        nicknameFilled: false,
        nicknameError: applied.nameLockReason,
        nicknameLockedAt: nowChinaSql(),
        message: 'Name 当前受 7 天修改限制，已跳过；无其它可同步项',
      };
    }
    if (!applied.changed) {
      keepOpenOnFail = true;
      const shot = await capture(page, account.id, 'profile', 'fields-miss').catch(() => '');
      throw new Error(`未能写入 Username/Bio/头像（Name 若不可改已自动跳过）${shot ? `（截图：${shot}）` : ''}`);
    }

    const saveResult = await saveEditProfileWithUsernameRecovery(page, {
      originalUsername: navHandle,
      attemptedUsername: applied.usernameAttempted || wantUsername,
    }, log);
    if (saveResult.usernameConflict) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        restoreUsername: navHandle,
      }).catch(() => {});
    }
    if (!saveResult.saved) {
      keepOpenOnFail = true;
      throw new Error(saveResult.usernameConflict
        ? `账号名称不可用，已恢复原账号名：${saveResult.usernameFailReason || 'Username unavailable'}`
        : '资料已填入但未找到 Save，请在浏览器窗口手动保存');
    }

    if (applied.nicknameFilled) {
      await phpApi.patch(`/accounts/${accountId}/profile-outcome`, {
        nicknameSuccess: true,
        markNicknameChanged: true,
      }).catch(() => {});
    }

    await page.waitForTimeout(800);
    const finalHandle = saveResult.usernameConflict
      ? navHandle
      : (wantUsername || navHandle);

    await goToPersonalCenter(page, finalHandle).catch(() => {});
    const profile = await scrapePublicProfile(page, { ...account, username: finalHandle }).catch(() => ({
      accountId: account.id,
      handle: finalHandle,
      displayName: applied.nicknameFilled ? wantNickname : account.nickname,
      bio: wantBio,
      avatarUrl: account.profileAvatar || '',
      followersCount: 0,
      followingCount: 0,
      likesCount: 0,
      videosCount: null,
      verified: 0,
      sourceUrl: page.url(),
    }));
    if (applied.nicknameFilled && wantNickname) profile.displayName = wantNickname;
    if (wantBio) profile.bio = wantBio;
    await persistProfile(account.id, profile).catch(() => {});

    const lockedAt = applied.nameLocked
      ? nowChinaSql()
      : undefined;

    return {
      ...profile,
      pushed: true,
      editOpened: true,
      editSaved: true,
      formNickname: wantNickname,
      formBio: wantBio,
      nameLocked: applied.nameLocked,
      nicknameFilled: !!applied.nicknameFilled,
      nicknameError: applied.nameLockReason || undefined,
      nicknameLockedAt: lockedAt,
      originalUsername: navHandle,
      usernameFailReason: saveResult.usernameFailReason || undefined,
      usernameConflict: saveResult.usernameConflict,
      message: saveResult.usernameConflict
        ? `Username 不可用已恢复原账号名；其余资料已同步${applied.nameLocked ? '（昵称受 7 天限制已跳过）' : ''}`
        : (applied.nameLocked
          ? '系统资料已同步到 TikTok（昵称受 7 天限制已跳过）'
          : '系统资料已同步到 TikTok'),
    };
  } catch (error) {
    await dataStore.tiktokSync(account.id, { error: error.message }).catch(() => {});
    throw error;
  } finally {
    if (!keepOpenOnFail) await closeBitPage(session, account);
  }
}

module.exports = {
  syncProfile,
  fillProfileField,
  fillNameInEditModal,
  fillBioInEditModal,
  setAvatarInEditModal,
  applyEditProfileChanges,
  clickProfileSave,
  saveEditProfileWithUsernameRecovery,
  fillUsernameInEditModal,
  readUsernameFromEditModal,
  detectUsernameConflict,
  detectNicknameLockMessage,
  isNameFieldEditable,
  openEditProfile,
  goToPersonalCenter,
  dismissOverlays,
  clickByTextDeep,
  readProfileFormValues,
  profileFormFilled,
  scrapePublicProfile,
  persistProfile,
  openBitPage,
  closeBitPage,
  loadAccount,
};

