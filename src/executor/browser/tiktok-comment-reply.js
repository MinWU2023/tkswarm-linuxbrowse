/**
 * 回复评论（TikTok Studio）：
 * 1. 打开比特 → 进入 TikTok Studio
 * 2. 侧栏 / URL 进入 Comments
 * 3. 筛选「Not replied / 未回复」
 * 4. 逐条：固定文案 或 AI 提示词模板 + /node/comment-reply/ai 生成后回复
 */
const phpApi = require('../php-api');
const { connectAccount, closeConnection } = require('./tiktok-actions');
const { inspectTikTokSession } = require('./cdp-client');
const { capture } = require('../automation-guard');
const { publish: liveLog } = require('../live-log');
const { clickByTextDeep, dismissOverlays } = require('./tiktok-profile');
const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');

const STUDIO_COMMENT_URLS = [
  'https://www.tiktok.com/tiktokstudio/comment?lang=en',
  'https://www.tiktok.com/tiktokstudio/comments?lang=en',
  'https://www.tiktok.com/tiktokstudio/comment',
  'https://www.tiktok.com/tiktokstudio/comments',
];

function log(accountId, msg, level = 'info') {
  liveLog(`评论回复#${accountId}：${msg}`, level, { accountId });
}

const { humanPause, randInt, sleep, typeDelay } = require('../human-pace');
const { scaleTimeout, waitPageSettled } = require('./page-ready');

async function clickPattern(page, pattern, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = await clickByTextDeep(page, pattern);
    if (hit) return hit;
    await sleep(350);
  }
  return '';
}

function pickReplyConfig(payload = {}) {
  const mode = String(payload.replyMode || payload.commentMode || 'fixed').toLowerCase() === 'ai' ? 'ai' : 'fixed';
  let texts = [];
  if (Array.isArray(payload.replyTexts)) {
    texts = payload.replyTexts.map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (!texts.length && Array.isArray(payload.commentTexts)) {
    texts = payload.commentTexts.map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (!texts.length && payload.replyText) {
    texts = [String(payload.replyText).trim()].filter(Boolean);
  }
  if (!texts.length) {
    texts = ['Thanks for your comment!'];
  }
  return {
    replyMode: mode,
    replyTexts: texts,
    replyText: texts[0],
    replyAiTemplateId: Number(payload.replyAiTemplateId || payload.commentAiTemplateId || 0) || 0,
    replyAiPrompt: String(payload.replyAiPrompt || payload.commentAiPrompt || '').trim(),
    replyTemplateIds: Array.isArray(payload.replyTemplateIds)
      ? payload.replyTemplateIds.map(Number).filter(Boolean)
      : [],
    maxReplies: Math.max(1, Math.min(50, Number(payload.maxReplies || payload.max_replies || 10))),
  };
}

async function resolveReplyText(cfg, variables = {}) {
  if (cfg.replyMode !== 'ai') {
    const pool = cfg.replyTexts || [];
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    return cfg.replyText || 'Thanks for your comment!';
  }
  const payload = {
    prompt: cfg.replyAiPrompt || '',
    templateId: cfg.replyAiTemplateId || 0,
    variables,
  };
  for (let i = 1; i <= 2; i++) {
    try {
      const data = await phpApi.post('/node/comment-reply/ai', payload);
      const reply = String(data?.reply || data?.comment || '').trim();
      if (reply) return reply;
    } catch (e) {
      if (i === 2) throw e;
    }
    await humanPause(1000, 0.15);
  }
  return '';
}

function isStudioUrl(url) {
  return /tiktok\.com\/tiktokstudio/i.test(String(url || ''));
}

function isStudioCommentsUrl(url) {
  return /tiktokstudio\/comments?/i.test(String(url || ''));
}

async function pageLooksLikeStudioComments(page) {
  if (isStudioCommentsUrl(page.url())) return true;
  if (!isStudioUrl(page.url())) return false;
  return page.evaluate(() => {
    if (document.querySelector('[data-tt="components_CommentList_FlexColumn"]')) return true;
    const t = (document.body?.innerText || '').slice(0, 12000);
    // Studio Comments 页常见：筛选 Not replied / Replied，以及 Reply 操作
    const hasFilter = /Not replied|未回复|Not Replied|Replied|已回复/i.test(t);
    const hasNav = /\bComments\b|评论管理|评论/.test(t);
    const hasListHint = /Reply|回复|Posted by|评论者|Follower/i.test(t);
    return (hasFilter && hasNav) || (hasFilter && hasListHint);
  }).catch(() => false);
}

/** 进入 TikTok Studio（优先直达，失败再走菜单） */
async function enterStudio(page, accountId) {
  if (isStudioUrl(page.url())) return true;
  await page.goto('https://www.tiktok.com/tiktokstudio?lang=en', {
    waitUntil: 'domcontentloaded',
    timeout: scaleTimeout(75000, 50000),
  }).catch(() => {});
  await waitPageSettled(page, {
    timeoutMs: 35000,
    contentSelectors: ['[data-e2e]', 'nav', 'aside', 'main'],
    reloadOnce: true,
    label: '进入Studio',
    log: (m) => log(accountId, m),
  });
  await dismissOverlays(page).catch(() => {});
  if (isStudioUrl(page.url())) return true;

  // 兜底：个人主页 ≡ → TikTok Studio
  try {
    const { goToPersonalCenter } = require('./tiktok-profile');
    await goToPersonalCenter(page).catch(() => {});
    await humanPause(1200, 0.1);
    const more = page.locator('[data-e2e="more-menu-icon"], button[aria-label*="More" i]').first();
    if (await more.count().catch(() => 0)) {
      await more.click({ timeout: 3000 }).catch(() => {});
      await humanPause(800, 0.1);
    }
    await clickPattern(page, '^TikTok Studio$|^创作者中心$|Creator Center|TikTok\\s*Studio', 5000);
    await humanPause(2200, 0.15);
  } catch (e) {
    log(accountId, `菜单进 Studio 失败: ${e.message || e}`, 'warn');
  }
  return isStudioUrl(page.url());
}

/** Studio → Comments */
async function openStudioComments(page, accountId) {
  if (await pageLooksLikeStudioComments(page)) return true;

  for (const url of STUDIO_COMMENT_URLS) {
    log(accountId, `打开 Studio 评论页 ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scaleTimeout(75000, 50000) }).catch(() => {});
    await waitPageSettled(page, {
      timeoutMs: 45000,
      contentSelectors: [
        '[data-tt="components_CommentList_FlexColumn"]',
        '[class*="Comment"]',
        'main',
      ],
      reloadOnce: true,
      label: 'Studio评论页',
      log: (m) => log(accountId, m),
    });
    await dismissOverlays(page).catch(() => {});
    for (let i = 0; i < 20; i++) {
      if (await pageLooksLikeStudioComments(page)) return true;
      await humanPause(600, 0.1);
    }
  }

  // 侧栏点 Comments
  log(accountId, 'URL 未直达，尝试侧栏「评论」');
  if (!isStudioUrl(page.url())) {
    await enterStudio(page, accountId);
  }
  const hit = await clickPattern(
    page,
    '^Comments$|^评论$|^评论管理$|Comment management',
    8000
  );
  if (hit) {
    await humanPause(2200, 0.15);
    if (await pageLooksLikeStudioComments(page)) return true;
  }
  return pageLooksLikeStudioComments(page);
}

/**
 * Studio 顶部筛选是下拉：「All comments」→ 打开后选「Not replied」
 */
async function filterNotReplied(page, accountId) {
  const studioFilter = await page.evaluate(() => {
    const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    for (const btn of document.querySelectorAll('[data-tt="components_FilterButton_FlexCenter"]')) {
      const label = btn.querySelector('[data-tt="components_FilterButton_TUXText"]');
      const t = label ? textOf(label) : textOf(btn);
      if (/^(Not replied|未回复|Not Replied)$/i.test(t)) return 'already:' + t;
      if (/^(All comments|全部评论)$/i.test(t)) {
        btn.click();
        return 'open:' + t;
      }
    }
    return '';
  }).catch(() => '');
  if (String(studioFilter).startsWith('already:')) {
    log(accountId, '已在「未回复」筛选');
    return true;
  }

  const filterLabel = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 20 && r.height > 12 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const nodes = [...document.querySelectorAll('button, div[role="button"], [class*="Select" i], span, div')];
    for (const el of nodes) {
      if (!visible(el)) continue;
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(Not replied|未回复)$/i.test(t)) return 'already:' + t;
      if (/^(All comments|全部评论)$/i.test(t)) return 'open:' + t;
      if (/^All comments|^全部评论/i.test(t) && t.length < 40) return 'open:' + t;
    }
    return '';
  }).catch(() => '');

  if (String(filterLabel).startsWith('already:')) {
    log(accountId, '已在「未回复」筛选');
    return true;
  }

  if (String(studioFilter).startsWith('open:')) {
    await humanPause(500, 0.1);
  } else {
  // 点开 All comments 下拉（Studio 顶部筛选 pill，可能带 ▾）
  let opened = false;
  const openPatterns = [/^All comments$/i, /^全部评论$/, /All comments/i, /全部评论/];
  for (const pat of openPatterns) {
    try {
      const allBtn = page.getByRole('button', { name: pat }).first();
      if (await allBtn.count() && await allBtn.isVisible().catch(() => false)) {
        await allBtn.click({ timeout: 4000 });
        opened = true;
        break;
      }
    } catch { /* next */ }
    try {
      const allBtn = page.locator('button, div[role="button"], div[role="combobox"]').filter({ hasText: pat }).first();
      if (await allBtn.count() && await allBtn.isVisible().catch(() => false)) {
        await allBtn.click({ timeout: 4000 });
        opened = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!opened) {
    opened = !!(await clickPattern(page, '^All comments$|^全部评论$|All comments|全部评论', 4000));
  }
  await humanPause(500, 0.1);
  }

  // 菜单项：Not replied / 未回复
  let hit = '';
  try {
    const opt = page.getByRole('option', { name: /^(Not replied|未回复|Not Replied)$/i }).first();
    if (await opt.count() && await opt.isVisible().catch(() => false)) {
      await opt.click({ timeout: 3000 });
      hit = 'option';
    }
  } catch { /* ignore */ }
  if (!hit) {
    try {
      const item = page.getByText(/^(Not replied|未回复|Not Replied)$/i).first();
      if (await item.count() && await item.isVisible().catch(() => false)) {
        await item.click({ timeout: 3000 });
        hit = 'text';
      }
    } catch { /* ignore */ }
  }
  if (!hit) {
    hit = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      for (const el of document.querySelectorAll('li, [role="option"], [role="menuitem"], button, div, span')) {
        if (!visible(el)) continue;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(Not replied|未回复|Not Replied)$/i.test(t)) {
          el.click();
          return t;
        }
      }
      return '';
    }).catch(() => '');
  }

  await humanPause(1600, 0.15);
  const applied = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 20 && r.height > 12 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    for (const el of document.querySelectorAll('button, div[role="button"], span, div')) {
      if (!visible(el)) continue;
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(Not replied|未回复|Not Replied)$/i.test(t)) return t;
    }
    return '';
  }).catch(() => '');
  if (hit || applied) {
    log(accountId, `已筛选未回复 (${hit || applied})`);
    return true;
  }
  log(accountId, '未点到「未回复」，改为处理当前列表里可回复的评论', 'warn');
  // 关掉可能打开的下拉
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

/**
 * 标记「一级且未回复」的评论卡片。
 * Studio 新版 DOM：data-tt="components_CommentList_Container" + MessageCell_Container(Reply)
 */
async function markUnrepliedRows(page, limit = 20, ownerUsername = '') {
  return page.evaluate(({ max, ownerUsername: owner }) => {
    document.querySelectorAll('[data-tk-cr-row]').forEach((n) => n.removeAttribute('data-tk-cr-row'));
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
        && Number(st.opacity || 1) > 0.1;
    };
    const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const ownerNorm = String(owner || '').replace(/^@/, '').toLowerCase();

    /** Studio 评论列表（data-index 虚拟列表项） */
    const studioItems = [...document.querySelectorAll('[data-tt="components_CommentList_Container"][data-index]')];
    if (studioItems.length) {
      let skippedSelf = 0;
      let skippedReplied = 0;
      const rows = [];
      for (const item of studioItems) {
        if (item.getAttribute('data-tk-cr-done') === '1') continue;
        if (!visible(item)) continue;

        const authorEl = item.querySelector('[data-tt="components_MessageCell_a"]')
          || item.querySelector('a[href*="/@"]');
        const author = authorEl ? textOf(authorEl).replace(/^@/, '') : '';

        const hasCreatorBadge = [...item.querySelectorAll('[data-tt="components_MessageCell_TUXText"]')]
          .some((el) => /^(Creator|创作者)$/i.test(textOf(el)));
        if (hasCreatorBadge || (ownerNorm && author.toLowerCase() === ownerNorm)) {
          skippedSelf += 1;
          continue;
        }

        const blob = textOf(item);
        if (/View\s+\d+\s+replies?|Hide\s+\d+\s+replies?|查看\s*\d+\s*条回复/i.test(blob)) {
          skippedReplied += 1;
          continue;
        }
        if (/▸|►/.test(blob) && /Reply to|回复\s*@/i.test(blob)) {
          skippedReplied += 1;
          continue;
        }

        const replyCtrl = [...item.querySelectorAll('[data-tt="components_MessageCell_Container"]')]
          .find((el) => visible(el) && /^(Reply|回复)$/i.test(textOf(el)));
        if (!replyCtrl) continue;

        rows.push(item);
        if (rows.length >= max) break;
      }
      rows.forEach((row, i) => row.setAttribute('data-tk-cr-row', String(i)));
      return {
        count: rows.length,
        skippedNested: 0,
        skippedReplied,
        skippedSelf,
        candidates: studioItems.length,
        replyRaw: studioItems.length,
        replyLeaf: rows.length,
        via: 'studio-data-tt',
      };
    }

    /** 是否为二级及以下回复行（旧版/兜底） */
    const isNestedReplyRow = (row) => {
      const t = textOf(row);
      // Studio 嵌套：A Creator ▸ B
      if (/▸|►|›/.test(t)) return true;
      if (/Reply to\s|回复\s*@|回复了/i.test(t)) return true;
      const cls = `${row.className || ''} ${row.getAttribute('data-e2e') || ''}`.toLowerCase();
      if (/reply-item|comment-reply|sub-comment|nested|level-2|level2/.test(cls)) return true;
      return false;
    };

    /** 在节点及邻近兄弟/父级中找「已有回复」信号 */
    const hasReplySignalIn = (el) => {
      if (!el) return false;
      const t = textOf(el);
      if (/View\s+\d+\s+replies?/i.test(t)) return true;
      if (/Hide\s+\d+\s+replies?/i.test(t)) return true;
      if (/查看\s*\d+\s*条回复|收起\s*\d+\s*条回复|已有\s*\d+\s*条回复|\d+\s*条回复/i.test(t)) return true;
      if (/▸|►/.test(t) && /Creator|创作者/i.test(t)) return true;
      return false;
    };

    /**
     * 一级评论是否已被创作者回复过：
     * View N replies / 展开的嵌套 ▸ / 卡片下方邻近区域的回复入口
     */
    const alreadyHasReplies = (row) => {
      if (hasReplySignalIn(row)) return true;
      // 卡片内嵌套回复块
      if ([...row.querySelectorAll('*')].some((n) => {
        if (!visible(n) || n === row) return false;
        const s = textOf(n);
        if (s.length > 200) return false;
        return /▸|►/.test(s);
      })) return true;

      // 仅当已展开子回复线程时，多个 Reply 才表示「已有回复」
      const hasThread = [...row.querySelectorAll('*')].some((n) => {
        if (!visible(n)) return false;
        const s = textOf(n);
        return /View\s+\d+\s+replies?|Hide\s+\d+\s+replies?|查看\s*\d+\s*条回复|收起\s*\d+\s*条回复|▸|►/.test(s);
      });
      if (hasThread) {
        const replyBtns = [...row.querySelectorAll('button, a, span, div, p')].filter((el) => {
          if (!visible(el)) return false;
          return /^(Reply|回复)$/i.test(textOf(el));
        });
        if (replyBtns.length >= 2) return true;
      }

      return false;
    };

    /** 视频创作者在自己视频下的评论（带 Creator 徽章或作者=当前账号） */
    const isCreatorSelfComment = (row) => {
      const authorEl = row.querySelector('a[href*="/@"]');
      if (!authorEl) return false;
      const author = textOf(authorEl).replace(/^@/, '').toLowerCase();
      const owner = String(owner || '').replace(/^@/, '').toLowerCase();
      if (owner && author && author === owner) return true;
      const authorTop = authorEl.getBoundingClientRect().top;
      const badges = [...row.querySelectorAll('span, div, p, strong')].filter((el) => {
        if (!visible(el)) return false;
        const bt = textOf(el);
        return bt === 'Creator' || bt === '创作者';
      });
      for (const badge of badges) {
        const br = badge.getBoundingClientRect();
        if (Math.abs(br.top - authorTop) < 36 && br.left >= authorEl.getBoundingClientRect().left - 12) {
          return true;
        }
      }
      return false;
    };

    const isReplyControl = (el) => {
      const t = textOf(el);
      const aria = String(el.getAttribute('aria-label') || '').trim();
      return /^(Reply|回复)$/i.test(t) || /^(Reply|回复)$/i.test(aria);
    };

    const findCardAround = (start) => {
      let best = null;
      let bestArea = Infinity;
      let node = start;
      for (let i = 0; i < 14 && node; i++) {
        if (!visible(node)) {
          node = node.parentElement;
          continue;
        }
        const r = node.getBoundingClientRect();
        const hasAuthor = !!node.querySelector('a[href*="/@"]');
        const hasReply = [...node.querySelectorAll('button, a, [role="button"], span, div, p')]
          .some((n) => visible(n) && isReplyControl(n));
        if (hasAuthor && hasReply && r.height >= 48 && r.height <= 420 && r.width >= 160 && r.left >= 160) {
          const area = r.width * r.height;
          if (area < bestArea) {
            best = node;
            bestArea = area;
          }
        }
        node = node.parentElement;
      }
      return best;
    };

    const findRowFromReplyBtn = (btn) => findCardAround(btn.parentElement || btn);

    const allReplyMatches = [...document.querySelectorAll('button, a, [role="button"], span, div, p')]
      .filter(visible)
      .filter((el) => {
        if (el.getAttribute('data-tk-cr-done') === '1') return false;
        if (el.closest('[data-tk-cr-done="1"]')) return false;
        if (el.closest('nav, aside, header')) return false;
        return isReplyControl(el);
      });
    // Studio 常见 <button><span>Reply</span></button>：保留最内层 Reply，勿用 childHas 全排除
    const replyNodes = allReplyMatches.filter((el) =>
      !allReplyMatches.some((other) => other !== el && other.contains(el))
    );

    const pushCandidate = (list, row) => {
      if (!row || list.includes(row)) return;
      if (row.closest('nav, aside, header')) return;
      if (row.getAttribute('data-tk-cr-done') === '1') return;
      list.push(row);
    };

    // 先收集候选行（Reply 按钮 → 最小卡片），再按 @ 链接兜底
    const candidates = [];
    for (const btn of replyNodes) {
      pushCandidate(candidates, findRowFromReplyBtn(btn));
    }
    if (!candidates.length) {
      for (const link of document.querySelectorAll('a[href*="/@"]')) {
        if (!visible(link)) continue;
        if (link.closest('nav, aside, header')) continue;
        const box = link.getBoundingClientRect();
        if (box.left < 180 || box.top < 100) continue;
        pushCandidate(candidates, findCardAround(link));
      }
    }

    if (!candidates.length) {
      return {
        count: 0,
        skippedNested: 0,
        skippedReplied: 0,
        skippedSelf: 0,
        candidates: 0,
        replyRaw: allReplyMatches.length,
        replyLeaf: replyNodes.length,
      };
    }

    const minLeft = Math.min(...candidates.map((r) => r.getBoundingClientRect().left));
    const rows = [];
    let skippedNested = 0;
    let skippedReplied = 0;
    let skippedSelf = 0;
    for (const row of candidates) {
      const left = row.getBoundingClientRect().left;
      // 比最左一级明显更靠右 → 嵌套
      if (left - minLeft > 28 || isNestedReplyRow(row)) {
        skippedNested += 1;
        continue;
      }
      if (isCreatorSelfComment(row)) {
        skippedSelf += 1;
        continue;
      }
      if (alreadyHasReplies(row)) {
        skippedReplied += 1;
        continue;
      }
      rows.push(row);
      if (rows.length >= max) break;
    }

    rows.forEach((row, i) => row.setAttribute('data-tk-cr-row', String(i)));
    return {
      count: rows.length,
      skippedNested,
      skippedReplied,
      skippedSelf,
      candidates: candidates.length,
      replyRaw: allReplyMatches.length,
      replyLeaf: replyNodes.length,
    };
  }, { max: limit, ownerUsername }).catch(() => ({
    count: 0, skippedNested: 0, skippedReplied: 0, skippedSelf: 0, candidates: 0, replyRaw: 0, replyLeaf: 0,
  }));
}

async function readRowMeta(page, index) {
  return page.evaluate((idx) => {
    const row = document.querySelector(`[data-tk-cr-row="${idx}"]`);
    if (!row) return { comment_text: '', author: '', video_desc: '' };
    const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

    let author = '';
    const authorEl = row.querySelector('[data-tt="components_MessageCell_a"]')
      || row.querySelector('a[href*="/@"]');
    if (authorEl) author = textOf(authorEl).replace(/^@/, '');

    const bodyEl = row.querySelector('[data-tt="components_TUXTextWithMention_TUXText"]');
    if (bodyEl) {
      const videoEl = row.querySelector('[data-tt="components_MessageCell_TruncateText"] span[data-tt="components_MessageCell_TUXText"]');
      return {
        comment_text: textOf(bodyEl).slice(0, 400),
        author: author.slice(0, 80),
        video_desc: videoEl ? textOf(videoEl).slice(0, 200) : '',
      };
    }

    // 兜底：从整卡文本解析
    let raw = textOf(row);
    raw = raw
      .replace(/\bCreator\b/gi, ' ')
      .replace(/\b\d+\s*[smhd]\s*ago\b/gi, ' ')
      .replace(/\b\d+\s*(秒|分钟|小时|天)前\b/gi, ' ')
      .replace(/\b(Reply|回复|Delete|删除|Like|赞|Hide|隐藏|Translate|翻译)\b/gi, ' ')
      .replace(/\bm-\d+-\d+\b/gi, ' ')
      .replace(/\b\d+\b/g, ' ') // 点赞数等
      .replace(/\s+/g, ' ')
      .trim();
    if (author) {
      raw = raw.replace(new RegExp(`^@?${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
    }
    // 若仍太长，取中间较短段落
    if (raw.length > 180) raw = raw.slice(0, 180);

    return {
      comment_text: raw.slice(0, 400),
      author: author.slice(0, 80),
      video_desc: '',
    };
  }, index).catch(() => ({ comment_text: '', author: '', video_desc: '' }));
}

async function openReplyOnRow(page, index) {
  // 只点一级卡片自身操作栏的 Reply，跳过嵌套子回复上的 Reply
  const clicked = await page.evaluate((idx) => {
    const row = document.querySelector(`[data-tk-cr-row="${idx}"]`);
    if (!row) return '';
    const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const inNested = (el) => {
      let n = el;
      while (n && n !== row) {
        const t = textOf(n);
        if (/▸|►|→/.test(t) && t.length < 160) return true;
        const cls = `${n.className || ''}`.toLowerCase();
        if (/reply-item|sub-comment|nested|level-2/.test(cls)) return true;
        // 缩进明显大于一级卡片
        if (n.getBoundingClientRect().left - row.getBoundingClientRect().left > 36) return true;
        n = n.parentElement;
      }
      return false;
    };

    // Studio：Reply 在 div[data-tt=components_MessageCell_Container] 内，非 button
    const studioReply = [...row.querySelectorAll('[data-tt="components_MessageCell_Container"]')]
      .find((el) => visible(el) && /^(Reply|回复)$/i.test(textOf(el)));
    if (studioReply) {
      studioReply.scrollIntoView({ block: 'center', inline: 'nearest' });
      studioReply.click();
      return 'studio-reply';
    }

    const isReplyControl = (el) => {
      const t = textOf(el);
      const aria = String(el.getAttribute('aria-label') || '').trim();
      return /^(Reply|回复)$/i.test(t) || /^(Reply|回复)$/i.test(aria);
    };
    const toClickable = (el) => {
      let n = el;
      for (let i = 0; i < 6 && n && n !== row; i++) {
        const tag = (n.tagName || '').toLowerCase();
        if (n.getAttribute('data-tt') === 'components_MessageCell_Container') return n;
        if (n.getAttribute('cursor') === 'pointer') return n;
        if (tag === 'button' || tag === 'a' || n.getAttribute('role') === 'button') return n;
        n = n.parentElement;
      }
      return el;
    };
    const nodes = [...row.querySelectorAll('button, a, [role="button"], span, div, p')].filter(visible);
    const replies = nodes.filter((el) => isReplyControl(el) && !inNested(el));
    replies.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const target = replies[0] ? toClickable(replies[0]) : null;
    if (!target) return '';
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return 'reply';
  }, index).catch(() => '');

  if (clicked) {
    await humanPause(700, 0.15);
    return true;
  }

  try {
    const row = page.locator(`[data-tk-cr-row="${index}"]`).first();
    const studioReply = row.locator('[data-tt="components_MessageCell_Container"]').filter({ hasText: /^(Reply|回复)$/i }).first();
    if (await studioReply.count()) {
      await studioReply.click({ timeout: 4000 });
      await humanPause(700, 0.15);
      return true;
    }
    const reply = row.getByText(/^(Reply|回复)$/i).first();
    if (await reply.count()) {
      await reply.click({ timeout: 4000 });
      await humanPause(700, 0.15);
      return true;
    }
  } catch { /* ignore */ }

  return false;
}

async function findReplyInput(page) {
  // Studio 点 Reply 后输入框常出现在同条 CommentCell 下方空列
  const sels = [
    '[data-tk-cr-row] [data-tt="components_CommentCell_FlexColumn"] textarea',
    '[data-tk-cr-row] [data-tt="components_CommentCell_FlexColumn"] [contenteditable="true"]',
    '[data-tt="components_CommentCell_FlexColumn"] textarea',
    '[data-tt="components_CommentCell_FlexColumn"] [contenteditable="true"]',
    '[placeholder="Reply to comment"]',
    '[placeholder*="Reply to comment" i]',
    '[placeholder*="回复评论" i]',
    '[placeholder*="回复" i]',
    '[data-e2e="comment-input"] [contenteditable="true"]',
    '[data-e2e="comment-input"]',
    'textarea[placeholder*="Reply" i]',
    'div[contenteditable="true"][placeholder*="Reply" i]',
    'div[contenteditable="true"][data-placeholder*="Reply" i]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).last();
    try {
      if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width >= 60 && box.height >= 14) return el;
      if (!box) return el;
    } catch { /* next */ }
  }
  // 兜底：当前焦点已是输入框
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'textarea' || tag === 'input' || el.isContentEditable;
  }).catch(() => false);
  if (focused) return page.locator(':focus').first();
  return null;
}

async function fillReplyInput(page, text) {
  const value = String(text || '');
  if (!value) return false;
  let el = await findReplyInput(page);
  if (!el) {
    await humanPause(800, 0.1);
    el = await findReplyInput(page);
  }
  if (!el) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 3000 }).catch(() => {});
  await humanPause(250, 0.1);
  await page.keyboard.press('Control+A').catch(() => {});
  const inserted = await page.evaluate((v) => {
    const active = document.activeElement;
    if (!active) return false;
    if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
      const proto = active.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(active, v);
      else active.value = v;
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (active.getAttribute('contenteditable') === 'true' || active.isContentEditable) {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, v);
      } catch {
        active.textContent = v;
      }
      active.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
      return true;
    }
    return false;
  }, value).catch(() => false);

  if (!inserted) {
    await page.keyboard.type(value, { delay: typeDelay(80, 160) });
  }
  return true;
}

async function clickReplySend(page) {
  const sels = [
    '[data-e2e="comment-post"]',
    'button[data-e2e="comment-post"]',
    '[data-e2e="comment-post-button"]',
    'button[aria-label*="Post" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发布"]',
    'button[aria-label*="发送"]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).last();
    try {
      if ((await el.count()) && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 2000 });
        return true;
      }
    } catch { /* next */ }
  }
  // Studio 常见：输入后按 Enter 发送
  await page.keyboard.press('Enter').catch(() => {});
  await humanPause(600, 0.1);
  // 若输入框已清空，视为发送成功
  const cleared = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return !String(el.value || '').trim();
    }
    if (el.isContentEditable) return !String(el.textContent || '').trim();
    return false;
  }).catch(() => false);
  if (cleared) return true;

  const byText = await clickPattern(page, '^Post$|^Publish$|^Send$|^发送$|^发布$', 2000);
  return !!byText;
}

async function markRowDone(page, index) {
  await page.evaluate((idx) => {
    const row = document.querySelector(`[data-tk-cr-row="${idx}"]`);
    if (row) {
      row.setAttribute('data-tk-cr-done', '1');
      row.removeAttribute('data-tk-cr-row');
    }
  }, index).catch(() => {});
}

async function replyOneRow(page, accountId, cfg, index, stats) {
  const meta = await readRowMeta(page, index);
  let commentText = String(meta.comment_text || '').trim();
  // 再点 Reply 前先留住文案；点开后 DOM 可能变
  if (!commentText) {
    log(accountId, `第 ${index + 1} 条评论文案为空，跳过`, 'warn');
    await markRowDone(page, index);
    return false;
  }
  log(accountId, `准备回复 @${meta.author || '?'}：「${commentText.slice(0, 80)}」`);

  const opened = await openReplyOnRow(page, index);
  if (!opened) {
    log(accountId, `第 ${index + 1} 条无法点击「回复」`, 'warn');
    return false;
  }

  // 等「Reply to comment」输入框出现
  let inputReady = false;
  for (let i = 0; i < 12; i++) {
    if (await findReplyInput(page)) {
      inputReady = true;
      break;
    }
    await humanPause(350, 0.1);
  }
  if (!inputReady) {
    log(accountId, '点击「回复」后未出现评论输入框', 'warn');
    return false;
  }

  let body = '';
  try {
    if (cfg.replyMode === 'ai') {
      log(accountId, '调用 AI 接口生成回复…');
    }
    body = await resolveReplyText(cfg, {
      comment_text: commentText,
      video_desc: meta.video_desc || '',
      author: meta.author || '',
      nickname: meta.author || '',
      video_url: '',
      video_id: '',
    });
  } catch (e) {
    log(accountId, `生成回复失败: ${e.message || e}`, 'warn');
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  if (!body) {
    log(accountId, '回复文案为空，跳过', 'warn');
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  log(accountId, `回复文案: ${body.slice(0, 80)}`);

  const filled = await fillReplyInput(page, body);
  if (!filled) {
    log(accountId, '未找到 Studio 回复输入框', 'warn');
    return false;
  }
  await humanPause(400, 0.1);
  const sent = await clickReplySend(page);
  if (!sent) {
    log(accountId, '发送失败（按钮/Enter）', 'warn');
    return false;
  }
  await humanPause(1400, 0.2);
  await markRowDone(page, index);
  stats.replied += 1;
  stats.lastReply = body;
  log(accountId, `已回复成功: ${body.slice(0, 60)}`);
  return true;
}

/**
 * @param {number} accountId
 * @param {object} payload
 */
async function runCommentReply(accountId, payload = {}, options = {}) {
  const cfg = pickReplyConfig(payload);
  const keepOpen = !!options.keepOpen;
  const stats = {
    replied: 0,
    scanned: 0,
    maxReplies: cfg.maxReplies,
    replyMode: cfg.replyMode,
    lastReply: '',
    screenshot: '',
    via: 'studio-comments',
  };

  let connection = options.connection || null;
  let owned = false;
  try {
    if (!connection) {
      log(accountId, `打开浏览器 → Studio 评论 · 最多 ${cfg.maxReplies} 条 · 模式 ${cfg.replyMode}`);
      const { parseSaveTrafficFlag } = require('./save-traffic');
      connection = await connectAccount(accountId, null, 'warm', {
        saveTraffic: parseSaveTrafficFlag(
          payload.saveTraffic ?? payload.save_traffic ?? options.saveTraffic,
          true
        ),
        browserBackend: payload.browserBackend || payload.browser_backend || options.browserBackend,
      });
      owned = true;
      await humanPause(1000, 0.15);
    }
    const page = connection.page;
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    const session = await inspectTikTokSession(connection.ws, page).catch(() => null);
    if (session && session.loggedIn === false) {
      stats.screenshot = await capture(page, `comment-reply-nologin-${accountId}`).catch(() => '');
      throw new Error('当前浏览器没有有效 TikTok 登录状态，请先登录后再回复评论');
    }

    const inStudio = await enterStudio(page, accountId);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    if (!inStudio) {
      stats.screenshot = await capture(page, `comment-reply-nostudio-${accountId}`).catch(() => '');
      throw new Error('未能进入 TikTok Studio');
    }

    const opened = await openStudioComments(page, accountId);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    if (!opened) {
      stats.screenshot = await capture(page, `comment-reply-nocomments-${accountId}`).catch(() => '');
      throw new Error('未能打开 TikTok Studio Comments 页');
    }
    log(accountId, `已在 Studio 评论页 url=${page.url()}`);

    await filterNotReplied(page, accountId);
    await solveRotateCaptchaIfPresent(page, { accountId }).catch(() => {});
    await humanPause(1000, 0.15);

    const ownerUsername = String(connection.account?.username || payload.accountUsername || '')
      .replace(/^@/, '')
      .trim();
    if (ownerUsername) {
      log(accountId, `当前账号 @${ownerUsername}，将跳过 Creator 自有评论`);
    }

    // 诊断：页面上可见的 Reply 文字链数量
    const replyLinkCount = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      return [...document.querySelectorAll('button, a, span, div, p')]
        .filter(visible)
        .filter((el) => /^(Reply|回复)$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim()))
        .length;
    }).catch(() => 0);
    log(accountId, `页面可见「回复」链接约 ${replyLinkCount} 个`);

    // 多轮：每回复一条后重新标记（列表会变化）
    let idleRounds = 0;
    while (stats.replied < cfg.maxReplies && idleRounds < 4) {
      const markLimit = Math.min(20, cfg.maxReplies - stats.replied + 2);
      const marked = await markUnrepliedRows(page, markLimit, ownerUsername);
      const count = typeof marked === 'number' ? marked : Number(marked?.count || 0);
      const skippedReplied = typeof marked === 'object' ? Number(marked.skippedReplied || 0) : 0;
      const skippedNested = typeof marked === 'object' ? Number(marked.skippedNested || 0) : 0;
      const skippedSelf = typeof marked === 'object' ? Number(marked.skippedSelf || 0) : 0;
      const candidateN = typeof marked === 'object' ? Number(marked.candidates || 0) : 0;
      const replyRaw = typeof marked === 'object' ? Number(marked.replyRaw || 0) : 0;
      const replyLeaf = typeof marked === 'object' ? Number(marked.replyLeaf || 0) : 0;
      const scanVia = typeof marked === 'object' ? String(marked.via || 'generic') : 'generic';
      stats.scanned += count;
      log(
        accountId,
        `扫描[${scanVia}]：列表 ${replyRaw} · 候选 ${candidateN} · 跳过已回复 ${skippedReplied} · 嵌套 ${skippedNested} · 自有 ${skippedSelf} · 待回 ${count}`
      );
      if (!count) {
        await page.mouse.wheel(0, randInt(500, 900)).catch(() => {});
        await humanPause(900, 0.15);
        const moreMarked = await markUnrepliedRows(page, markLimit, ownerUsername);
        const more = typeof moreMarked === 'number' ? moreMarked : Number(moreMarked?.count || 0);
        if (!more) {
          idleRounds += 1;
          log(accountId, `未找到可回复的一级评论 (idle=${idleRounds})`);
          continue;
        }
      }
      idleRounds = 0;

      const before = stats.replied;
      const ok = await replyOneRow(page, accountId, cfg, 0, stats);
      if (!ok) {
        const alt = await replyOneRow(page, accountId, cfg, 1, stats);
        if (!alt) {
          idleRounds += 1;
          // 标记失败行，避免死循环
          await markRowDone(page, 0);
          await page.mouse.wheel(0, 600).catch(() => {});
          await humanPause(800, 0.15);
        }
      }
      if (stats.replied === before && ok === false) {
        await page.evaluate(() => {
          document.querySelectorAll('[data-tk-cr-row]').forEach((n) => n.removeAttribute('data-tk-cr-row'));
        }).catch(() => {});
      }
      await humanPause(randInt(1000, 2000), 0.2);
    }

    if (!stats.replied) {
      stats.screenshot = await capture(page, `comment-reply-empty-${accountId}`).catch(() => '');
      log(accountId, 'Studio 未回复列表中未成功回复任何评论', 'warn');
    } else {
      log(accountId, `完成 已回复=${stats.replied} 已扫描≈${stats.scanned}`);
    }

    return { status: 'ok', ...stats };
  } finally {
    if (owned && connection && !keepOpen) {
      await closeConnection(connection);
    }
  }
}

module.exports = {
  runCommentReply,
  pickReplyConfig,
  resolveReplyText,
};
