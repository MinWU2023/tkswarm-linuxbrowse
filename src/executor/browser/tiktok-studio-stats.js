/**
 * TikTok Studio 数据分析拉取
 *
 * 目标页：https://www.tiktok.com/tiktokstudio/analytics
 * 四个页签：Overview / Content / Followers / Viewer
 *
 * 采集策略（三层，任何一层拿到数据就够用）：
 *   1) 卡片/文本对解析 DOM：把「指标名 + 数值」归一化成 metric 列表；
 *   2) 网络 JSON 监听：抓页面自己请求的分析接口，按日序列/指标名递归挖；
 *   3) 原始文本 + 原始 JSON 全量入库：解析失败也能事后补，不再出现「全是 0 还不知道为什么」。
 */
const { inspectTikTokSession } = require('./cdp-client');
const dataStore = require('../data-store');
const { publish: liveLog } = require('../live-log');
let nowChinaIso;
try {
  ({ nowChinaIso } = require('../../utils/china-time'));
} catch {
  ({ nowChinaIso } = require('../utils/china-time'));
}

const ANALYTICS_URL = 'https://www.tiktok.com/tiktokstudio/analytics?lang=en';

/** 四个页签的常见中英文名（按顺序即展示顺序）。注意第 4 个是 Viewers（复数） */
const TAB_ALIASES = [
  { key: 'overview', names: ['overview', '概览', '总览'] },
  { key: 'content', names: ['content', '内容'] },
  { key: 'followers', names: ['followers', 'follower', '粉丝'] },
  { key: 'viewer', names: ['viewers', 'viewer', '观众', '受众'] },
];

/** 已知指标名（小写比较）。未知但「纯文字 + 下一行是数字」的也会被收录 */
const METRIC_LABELS = [
  // Overview
  'video views', 'profile views', 'likes', 'comments', 'shares', 'est. rewards', 'estimated rewards',
  'new followers', 'followers', 'following', 'videos', 'total views', 'post views', 'live views',
  'video plays', 'profile view', 'video view', 'unique viewers', 'watch time',
  // Content
  'watch time', 'average watch time', 'full video watched rate', 'reach', 'traffic source',
  'total play time', 'average play time', 'played full video', 'video duration', 'posted',
  // Followers / Viewer
  'lost followers', 'total followers', 'male', 'female', 'other',
  'top countries', 'top territories', 'top regions', 'returning viewers', 'new viewers',
  'live viewers', 'age', 'gender',
  // 中文
  '视频播放', '主页浏览', '点赞', '评论', '分享', '预估收益', '新增粉丝', '粉丝', '关注',
  '视频数', '播放量', '完播率', '观看时长', '平均观看时长', '受众', '性别', '年龄', '地区',
];

/** 明显不是指标的文案，避免误收 */
const LABEL_BLOCKLIST = [
  'see more', 'view all', 'see all', 'learn more', 'details', 'export', 'export data',
  'last 28 days', 'last 7 days', 'last 30 days', 'last 60 days', 'last 90 days',
  'yesterday', 'today', 'this week', 'this month', 'all', 'more', 'show more',
  'download', 'filter', 'sort by', 'search', 'cancel', 'confirm', 'save', 'apply',
  '查看全部', '更多', '导出', '近7天', '近28天', '近30天',
];

const METRIC_KEYS = METRIC_LABELS.concat(LABEL_BLOCKLIST);

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(/,/g, '').replace(/\s+/g, ' ').toUpperCase();
  // 拒绝把视频 ID（≥8 位纯数字）当成播放/评论指标
  if (/^\d{8,}$/.test(s)) return 0;
  const m = s.match(/^[$€£¥]?\s*([+-]?[0-9]*\.?[0-9]+)\s*([KMB])?/);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
  return Math.round(Number(m[1]) * mult * 10000) / 10000;
}

/**
 * Studio 表头列定位。
 * 勿用粗糙的 includes('view')：会命中筛选条/Overview 等，且易与 Posts 表列错位，
 * 典型后果是把真实播放量写进「评论」列。
 */
function findContentMetricCol(headerCells, kind) {
  const headers = (headerCells || []).map((h) => String(h || '').trim().toLowerCase());
  const scoreAt = (i, score) => ({ i, score });
  const ranked = [];
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    if (!h) continue;
    if (kind === 'views') {
      if (/viewers?/.test(h) && !/video\s*views?/.test(h)) continue;
      if (/^videos?$/.test(h)) continue; // 纯 Video 列
      if (/video\s*views?|post\s*views?|播放量|视频播放/.test(h)) ranked.push(scoreAt(i, 100));
      else if (/\bviews?\b|播放/.test(h) && !/overview|preview|profile/.test(h)) ranked.push(scoreAt(i, 80));
    } else if (kind === 'likes') {
      if (/\blikes?\b|点赞|digg/.test(h) && !/liked\s*videos?/.test(h)) ranked.push(scoreAt(i, 100));
    } else if (kind === 'comments') {
      if (/\bcomments?\b|评论/.test(h)) ranked.push(scoreAt(i, 100));
    } else if (kind === 'shares') {
      if (/\bshares?\b|分享|转发|reposts?/.test(h)) ranked.push(scoreAt(i, 100));
    } else if (kind === 'date') {
      if (/\b(date|time|posted|publish|发布)/.test(h)) ranked.push(scoreAt(i, 100));
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.i - b.i);
  return ranked.length ? ranked[0].i : -1;
}

/** 公开页 / item_list 指标优先于 Studio DOM（DOM 列易错位） */
function preferCatalogStat(domVal, catalogVal) {
  const c = Number(catalogVal) || 0;
  if (c > 0) return c;
  return Number(domVal) || 0;
}

/**
 * 纠错：评论远大于播放时，多为把「Views」列读进了 comments
 * （常见原因：把筛选条 Views/Likes/Comments 误当成表头）。
 */
function sanitizeContentMetrics(row) {
  const views = Number(row?.views) || 0;
  const likes = Number(row?.likes) || 0;
  const comments = Number(row?.comments) || 0;
  const shares = Number(row?.shares) || 0;
  const out = {
    ...row,
    views,
    likes,
    comments,
    shares,
  };
  // 评论 >= 3×播放 且 评论 > 点赞：对调播放/评论后更合理则对调
  if (comments > 0 && comments >= Math.max(views, 1) * 3 && comments > likes) {
    const swappedViews = comments;
    const swappedComments = views;
    if (swappedViews >= swappedComments && swappedViews >= likes) {
      out.views = swappedViews;
      out.comments = swappedComments;
      out._metricsSwapped = 'views<->comments';
    }
  }
  return out;
}

/** 是否像真正的 Posts/Content 表头（而非筛选按钮行） */
function isLikelyContentTableHeader(headerCells) {
  const headers = (headerCells || []).map((h) => String(h || '').trim().toLowerCase());
  if (headers.length < 3) return false;
  const joined = headers.join(' | ');
  const hasVideoCol = headers.some((h) => /^(posts?|videos?|content|post)$/i.test(h)
    || /posts?\s*\(|created on|视频|作品|内容/.test(h));
  const hasViews = findContentMetricCol(headers, 'views') >= 0;
  const hasLikes = findContentMetricCol(headers, 'likes') >= 0;
  const hasComments = findContentMetricCol(headers, 'comments') >= 0;
  // 筛选条通常只有 Views/Likes/Comments/Privacy，没有 Posts 列
  const onlyFilters = hasViews && hasLikes && hasComments
    && !hasVideoCol
    && headers.every((h) => !h
      || /^(views?|likes?|comments?|shares?|privacy|everyone|公开|隐私|播放|点赞|评论|分享)$/i.test(h)
      || /view|like|comment|share|privacy|播放|点赞|评论|分享/.test(h));
  if (onlyFilters && headers.length <= 6) return false;
  // 至少要有播放列，且（有作品列 或 同时具备赞/评）
  return hasViews && (hasVideoCol || (hasLikes && hasComments) || /privacy|隐私/.test(joined));
}

function dateKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function last28DateKeys(end = new Date()) {
  const keys = [];
  const base = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()));
  for (let i = 27; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(dateKey(d));
  }
  return keys;
}

function emptyDay(metricDate) {
  return {
    metricDate,
    videoViews: 0,
    profileViews: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    estRewards: 0,
  };
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'metric';
}

function tabKeyOf(label) {
  const low = String(label || '').trim().toLowerCase();
  const hit = TAB_ALIASES.find((t) => t.names.includes(low));
  if (hit) return hit.key;
  return slug(low);
}

/** 从接口 JSON 里尽量抽出按日序列 */
function extractSeriesFromJson(payload, out, hintKey = '') {
  const walk = (node, depth = 0, keyHint = hintKey) => {
    if (!node || depth > 10) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object') {
        const sample = node[0];
        const dateField = ['date', 'day', 'metric_date', 'stat_date', 'time', 'timestamp', 'dt']
          .find((k) => sample && sample[k] != null);
        if (dateField) {
          for (const row of node) {
            let dk = '';
            const raw = row[dateField];
            if (typeof raw === 'number') dk = dateKey(new Date(raw > 1e12 ? raw : raw * 1000));
            else dk = dateKey(raw) || String(raw || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
            const slot = out.days.get(dk) || emptyDay(dk);
            const pick = (...keys) => {
              for (const k of keys) {
                if (row[k] != null) return num(row[k]);
              }
              return null;
            };
            const vv = pick('video_views', 'videoViews', 'vv', 'views', 'value', 'count', 'play_count');
            const pv = pick('profile_views', 'profileViews', 'pv');
            const lk = pick('likes', 'like_count', 'likes_count', 'digg_count');
            const cm = pick('comments', 'comment_count', 'comments_count');
            const sh = pick('shares', 'share_count', 'shares_count');
            const er = pick('est_rewards', 'estimated_rewards', 'rewards', 'revenue');
            if (vv != null) slot.videoViews = Math.max(slot.videoViews, vv);
            if (pv != null) slot.profileViews = Math.max(slot.profileViews, pv);
            if (lk != null) slot.likes = Math.max(slot.likes, lk);
            if (cm != null) slot.comments = Math.max(slot.comments, cm);
            if (sh != null) slot.shares = Math.max(slot.shares, sh);
            if (er != null) slot.estRewards = Math.max(slot.estRewards, er);
            // 单指标序列：按外层 key 归类
            if (vv == null && pv == null && lk == null && cm == null && sh == null) {
              const single = pick('value', 'count', 'total', 'num');
              if (single != null) {
                const k = String(keyHint || '').toLowerCase();
                if (/profile/.test(k)) slot.profileViews = Math.max(slot.profileViews, single);
                else if (/like/.test(k)) slot.likes = Math.max(slot.likes, single);
                else if (/comment/.test(k)) slot.comments = Math.max(slot.comments, single);
                else if (/share/.test(k)) slot.shares = Math.max(slot.shares, single);
                else slot.videoViews = Math.max(slot.videoViews, single);
              }
            }
            out.days.set(dk, slot);
          }
        }
      }
      node.forEach((x) => walk(x, depth + 1, keyHint));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walk(v, depth + 1, k);
      }
    }
  };
  walk(payload);
}

/** 打开 Analytics 页，返回页面诊断信息 */
async function gotoAnalytics(page, log, url = ANALYTICS_URL) {
  log(`打开 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  // 等页面真正渲染出「页签」或关键指标
  const end = Date.now() + 30000;
  let last = null;
  while (Date.now() < end) {
    try {
      const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
      await solveRotateCaptchaIfPresent(page);
    } catch { /* ignore */ }
    last = await pageDiagnostics(page);
    if (last.tabs > 0 || last.hasKeyMetrics || last.loginWall) break;
    await page.waitForTimeout(800);
  }
  return last || { url: page.url(), tabs: 0, hasKeyMetrics: false };
}

async function dismissBanners(page) {
  try {
    const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
    await solveRotateCaptchaIfPresent(page);
  } catch { /* ignore */ }
  const btns = [
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button[data-e2e="cookie-banner-accept"]',
    'button:has-text("Got it")',
    'button:has-text("全部接受")',
  ];
  for (const sel of btns) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

async function pageDiagnostics(page) {
  return page.evaluate((aliases) => {
    const text = String(document.body && document.body.innerText || '');
    const names = aliases.flatMap((a) => a.names);
    const found = new Set();
    for (const el of document.querySelectorAll('[role="tab"], button, div, span, a')) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t || t.length > 12) continue;
      if (!names.includes(t)) continue;
      if (el.closest('[data-tt*="Sidebar"], nav, aside')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) found.add(t);
    }
    return {
      url: location.href,
      title: document.title,
      tabs: found.size,
      tabLabels: [...found],
      hasKeyMetrics: /video views|profile views|new followers|followers|analytics|总览|概览/i.test(text),
      loginWall: /log in to tiktok|登录 tiktok|sign up/i.test(text),
      textLen: text.length,
      head: text.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TAB_ALIASES).catch(() => ({ url: page.url(), tabs: 0, tabLabels: [], hasKeyMetrics: false, head: '' }));
}

/** 找出四个页签里当前页面存在的那些（排除左侧导航里的同名菜单项） */
async function discoverTabs(page) {
  return page.evaluate((aliases) => {
    const names = aliases.flatMap((a) => a.names);
    const pickIn = (selector, tier) => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(selector)) {
        const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length > 12) continue;
        const low = raw.toLowerCase();
        if (!names.includes(low)) continue;
        // 左侧导航/面包屑里也有 "Content"，必须排除，否则会点走页面
        if (el.closest('[data-tt*="Sidebar"], nav, aside')) continue;
        if (el.closest('table')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const innerSame = [...el.children].some(
          (c) => (c.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === low
        );
        if (innerSame) continue;
        if (seen.has(low)) continue;
        seen.add(low);
        out.push({ label: raw, tier });
      }
      return out;
    };
    // 依次尝试更宽松的选择器，取能识别出最多页签的那一层
    const tiers = [
      pickIn('[role="tab"]', 0),
      pickIn('button[role="tab"], button', 1),
      pickIn('div[role="tab"], span[role="tab"], div, span', 2),
    ];
    let best = [];
    for (const t of tiers) if (t.length > best.length) best = t;
    return best.map((t) => ({ label: t.label }));
  }, TAB_ALIASES).catch(() => []);
}

async function activateTab(page, label, log) {
  const clicked = await page.evaluate((lb) => {
    const want = String(lb).trim().toLowerCase();
    const selectors = ['[role="tab"]', 'button', 'div', 'span'];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (raw.toLowerCase() !== want) continue;
        if (el.closest('[data-tt*="Sidebar"], nav, aside, table')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const innerSame = [...el.children].some(
          (c) => (c.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === want
        );
        if (innerSame) continue;
        el.click();
        return true;
      }
    }
    return false;
  }, label).catch(() => false);
  if (!clicked) {
    log(`页签 ${label}：找不到可点击节点`);
    return false;
  }
  await page.waitForTimeout(2800);
  // 点错点到导航会把页面带走，这里兜回来
  if (!/tiktokstudio\/analytic/i.test(page.url())) {
    log(`页签 ${label}：点击后跳到了 ${page.url()}，判定不是页签，返回数据分析`);
    await page.goto(ANALYTICS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 时间区间
// Studio Analytics 默认是 Last 7 days，必须逐个页签切到 Last 28 days，
// 否则「28 天数据」永远是 7 天的口径。
const RANGE_TRIGGER_SRC = '^((last|past)\\s*\\d+\\s*days?|近\\s*\\d+\\s*天|过去\\s*\\d+\\s*天|yesterday|昨天|today|今天)$';
const RANGE_28_TEXTS = ['last 28 days', 'past 28 days', '过去 28 天', '近 28 天', '过去28天', '近28天', '28 days', '28天'];

/** 读当前区间文案（如 "Last 7 days"） */
async function readRangeLabel(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const tiers = ['button', '[role="button"], [role="combobox"]', 'div, span'];
    for (const sel of tiers) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24 || !re.test(t)) continue;
        if (el.closest('[data-tt*="Sidebar"], nav, aside')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const innerSame = [...el.children].some(
          (c) => re.test((c.innerText || '').replace(/\s+/g, ' ').trim())
        );
        if (innerSame) continue;
        return t;
      }
    }
    return '';
  }, RANGE_TRIGGER_SRC).catch(() => '');
}

/** 点开区间下拉 */
async function openRangeMenu(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const tiers = ['button', '[role="button"], [role="combobox"]', 'div, span'];
    for (const sel of tiers) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24 || !re.test(t)) continue;
        if (el.closest('[data-tt*="Sidebar"], nav, aside')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const innerSame = [...el.children].some(
          (c) => re.test((c.innerText || '').replace(/\s+/g, ' ').trim())
        );
        if (innerSame) continue;
        el.click();
        return true;
      }
    }
    return false;
  }, RANGE_TRIGGER_SRC).catch(() => false);
}

/** 在下拉里点 28 天 */
async function pick28Option(page) {
  return page.evaluate((targets) => {
    const want = new Set(targets);
    const sel = 'button, [role="option"], [role="menuitem"], li, div, span';
    const nodes = [...document.querySelectorAll(sel)];
    const clickIf = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      el.click();
      return true;
    };
    // 先精确匹配文案
    for (const el of nodes) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!want.has(t)) continue;
      const innerSame = [...el.children].some(
        (c) => want.has((c.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase())
      );
      if (innerSame) continue;
      if (clickIf(el)) return t;
    }
    // 再宽松匹配：含 28 且带 days/天
    for (const el of nodes) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/^[^0-9]{0,12}28\s*(days?|天)\s*$/i.test(t)) continue;
      const innerSame = [...el.children].some(
        (c) => /^[^0-9]{0,12}28\s*(days?|天)\s*$/i.test((c.innerText || '').replace(/\s+/g, ' ').trim())
      );
      if (innerSame) continue;
      if (clickIf(el)) return t.toLowerCase();
    }
    return '';
  }, RANGE_28_TEXTS).catch(() => '');
}

/** 把当前页签切到「最近 28 天」，返回切换后的区间文案 */
async function ensureLast28Days(page, log) {
  const before = await readRangeLabel(page);
  if (before && /28/.test(before)) {
    log(`时间范围：已是「${before}」，无需切换`);
    return before;
  }
  // 原生 <select> 兜底
  const hasSelect = await page.evaluate(() => {
    for (const s of document.querySelectorAll('select')) {
      if ([...s.options].some((o) => /28/.test(o.textContent || ''))) return true;
    }
    return false;
  }).catch(() => false);
  if (hasSelect) {
    await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        const opt = [...s.options].find((o) => /28/.test(o.textContent || ''));
        if (opt) {
          s.value = opt.value;
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(2800);
    const after = await readRangeLabel(page);
    log(`时间范围：${before || '默认'} → ${after || '未知'}（下拉框）`);
    return after || before;
  }
  if (!await openRangeMenu(page)) {
    log(`时间范围：找不到选择器，保持默认「${before || '未知'}」——本页数据口径可能不是 28 天`);
    return before;
  }
  await page.waitForTimeout(1200);
  const picked = await pick28Option(page);
  if (!picked) {
    log(`时间范围：下拉里没有 28 天选项，保持默认「${before || '未知'}」`);
    await page.keyboard.press('Escape').catch(() => {});
    return before;
  }
  await page.waitForTimeout(3000);
  const after = await readRangeLabel(page);
  log(`时间范围：${before || '默认'} → ${after || '未知'}（点了「${picked}」）`);
  return after || picked;
}

/** 抓「指标名 + 数值」的卡片/行 */
async function scrapeCards(page) {
  return page.evaluate((arg) => {
    const known = new Set((arg.labels || []).map((s) => String(s).toLowerCase()));
    const blocked = new Set((arg.blocked || []).map((s) => String(s).toLowerCase()));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isNumLine = (s) => {
      const t = norm(s);
      if (!t || t.length > 24) return false;
      return /^[+-]?\s*[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(t);
    };
    const labelOk = (s) => {
      const t = norm(s);
      if (!t || t.length > 40) return false;
      if (!/[a-z\u4e00-\u9fa5]/i.test(t)) return false;
      if (known.has(t.toLowerCase())) return true;
      if (blocked.has(t.toLowerCase())) return false;
      // 未知但像指标名：英文短句 / 纯中文短词
      return /^[A-Za-z][A-Za-z0-9 .&%'/+-]{1,39}$/.test(t) || /^[\u4e00-\u9fa5]{2,12}$/.test(t);
    };
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('div, li, article, section, p, span');
    for (const el of nodes) {
      const txt = el.innerText || '';
      if (!txt || txt.length > 400) continue;
      const lines = txt.split('\n').map(norm).filter(Boolean);
      if (lines.length < 2 || lines.length > 8) continue;
      const label = lines[0];
      if (!labelOk(label)) continue;
      let idx = -1;
      for (let i = 1; i < lines.length; i += 1) {
        if (isNumLine(lines[i])) { idx = i; break; }
      }
      if (idx < 1) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, value: lines[idx], extra: lines.slice(idx + 1, idx + 3) });
    }
    return out.slice(0, 120);
  }, { labels: METRIC_KEYS, blocked: LABEL_BLOCKLIST }).catch(() => []);
}

/** 兜底：把整页 innerText 按行切成「标签 + 数值」对 */
async function scrapeTextPairs(page) {
  return page.evaluate((arg) => {
    const known = new Set((arg.labels || []).map((s) => String(s).toLowerCase()));
    const blocked = new Set((arg.blocked || []).map((s) => String(s).toLowerCase()));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isNumLine = (s) => /^[+-]?\s*[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(norm(s));
    const text = String(document.body && document.body.innerText || '');
    const lines = text.split('\n').map(norm).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < lines.length - 1; i += 1) {
      const label = lines[i];
      const low = label.toLowerCase();
      if (!known.has(low) || blocked.has(low)) continue;
      const next = lines[i + 1];
      if (!isNumLine(next)) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      out.push({ label, value: next, extra: [] });
    }
    return out.slice(0, 120);
  }, { labels: METRIC_KEYS, blocked: LABEL_BLOCKLIST }).catch(() => []);
}

async function scrapePageText(page) {
  return page.evaluate(() => String(document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 20000))
    .catch(() => '');
}

/** 把卡片/文本对归一化成 metric 列表 */
function normalizeMetrics(cards, pairs) {
  const out = [];
  const seen = new Set();
  const push = (label, value) => {
    const low = String(label || '').trim().toLowerCase();
    if (!low || seen.has(low)) return;
    seen.add(low);
    out.push({
      key: slug(low),
      label: String(label).trim(),
      text: String(value).trim(),
      value: num(value),
    });
  };
  cards.forEach((c) => push(c.label, c.value));
  pairs.forEach((p) => push(p.label, p.value));
  return out;
}

function findMetric(metrics, names) {
  for (const n of names) {
    const low = n.toLowerCase();
    const hit = metrics.find((m) => m.label.trim().toLowerCase() === low);
    if (hit) return hit;
  }
  for (const n of names) {
    const low = n.toLowerCase();
    const hit = metrics.find((m) => m.label.trim().toLowerCase().includes(low));
    if (hit) return hit;
  }
  return null;
}

/** 表格抓取（Content 页签的逐条视频数据） */
async function scrapeTables(page) {
  return page.evaluate(() => {
    const out = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [];
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('th,td')]
          .map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
        if (cells.length >= 2) rows.push(cells);
      }
      if (rows.length >= 2) out.push(rows);
    }
    return out.slice(0, 5);
  }).catch(() => []);
}

/**
 * Content 页签：直接从 DOM 抓标题 / 播放数据 / 视频链接 / 封面。
 * Studio 表格单元格常不含公开 /video/ 链，需从行内 a/img 或 data-* 补全。
 */
async function scrapeContentItems(page) {
  return page.evaluate(() => {
    const pickId = (u) => {
      const m = String(u || '').match(/\/video\/(\d{8,})/);
      return m ? m[1] : '';
    };
    const isMetricNum = (s) => {
      const t = String(s || '').trim();
      if (!t || /^\d{8,}$/.test(t.replace(/,/g, ''))) return false; // 排除视频 ID
      return /^[+-]?[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(t);
    };
    const parseMetric = (raw) => {
      const s = String(raw || '').trim().replace(/,/g, '').replace(/\s+/g, ' ').toUpperCase();
      if (!s || /^\d{8,}$/.test(s)) return 0;
      // 单元格可能是「2 Discover...」：只取独立指标行，避免 Number('2 xxx') 误解析
      const first = s.split(/\s+/)[0];
      const m = first.match(/^[$€£¥]?([+-]?[0-9]*\.?[0-9]+)([KMB])?$/);
      if (!m) return 0;
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
      return Math.round(Number(m[1]) * mult);
    };
    const findCol = (header, kind) => {
      const ranked = [];
      for (let i = 0; i < header.length; i += 1) {
        const h = String(header[i] || '').trim().toLowerCase();
        if (!h) continue;
        if (kind === 'views') {
          if (/viewers?/.test(h) && !/video\s*views?/.test(h)) continue;
          if (/^videos?$/.test(h)) continue;
          if (/video\s*views?|post\s*views?|播放量|视频播放/.test(h)) ranked.push({ i, score: 100 });
          else if (/\bviews?\b|播放/.test(h) && !/overview|preview|profile/.test(h)) ranked.push({ i, score: 80 });
        } else if (kind === 'likes') {
          if (/\blikes?\b|点赞|digg/.test(h)) ranked.push({ i, score: 100 });
        } else if (kind === 'comments') {
          if (/\bcomments?\b|评论/.test(h)) ranked.push({ i, score: 100 });
        } else if (kind === 'shares') {
          if (/\bshares?\b|分享|转发|reposts?/.test(h)) ranked.push({ i, score: 100 });
        } else if (kind === 'date') {
          if (/\b(date|time|posted|publish|发布)/.test(h)) ranked.push({ i, score: 100 });
        }
      }
      ranked.sort((a, b) => b.score - a.score || a.i - b.i);
      return ranked.length ? ranked[0].i : -1;
    };
    const items = [];
    const seen = new Set();

    const push = (raw) => {
      const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const videoUrl = String(raw.videoUrl || '').split('?')[0];
      const videoId = String(raw.videoId || pickId(videoUrl) || '').trim();
      const views = parseMetric(raw.views);
      const likes = parseMetric(raw.likes);
      const comments = parseMetric(raw.comments);
      const shares = parseMetric(raw.shares);
      const key = videoId || `${title}|${views}|${raw.postedAt || ''}`;
      if (!title && !videoId) return;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        title,
        views,
        likes,
        comments,
        shares,
        postedAt: String(raw.postedAt || '').slice(0, 64),
        videoId,
        videoUrl: videoUrl || (videoId ? `https://www.tiktok.com/video/${videoId}` : ''),
        coverUrl: String(raw.coverUrl || '').slice(0, 1000),
      });
    };

    const isFilterOnlyHeader = (header) => {
      const hs = (header || []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
      if (hs.length < 2 || hs.length > 6) return false;
      const hasPosts = hs.some((h) => /posts?|videos?|created on|视频|作品|内容/.test(h));
      if (hasPosts) return false;
      // 仅 Views/Likes/Comments/Privacy 之类筛选条
      return hs.every((h) => /^(views?|likes?|comments?|shares?|privacy|everyone|公开|隐私|播放|点赞|评论|分享)$/i.test(h)
        || /^(views?|likes?|comments?|shares?|privacy|播放|点赞|评论|分享)\b/.test(h));
    };

    // 1) 表格行
    for (const table of document.querySelectorAll('table')) {
      const trs = [...table.querySelectorAll('tr')];
      if (trs.length < 2) continue;
      // 找真正表头：优先含 th 的行，跳过筛选条
      let headerRow = trs.find((tr) => tr.querySelectorAll('th').length >= 2) || trs[0];
      let header = [...headerRow.querySelectorAll('th,td')].map((c) => (c.innerText || '').toLowerCase());
      if (isFilterOnlyHeader(header)) {
        const alt = trs.find((tr) => {
          if (tr === headerRow) return false;
          const cells = [...tr.querySelectorAll('th,td')].map((c) => (c.innerText || '').toLowerCase());
          const hasPosts = cells.some((h) => /posts?|videos?|created on|视频|作品/.test(h));
          const hasViews = cells.some((h) => /\bviews?\b|播放/.test(h));
          return hasPosts && hasViews;
        });
        if (alt) {
          headerRow = alt;
          header = [...alt.querySelectorAll('th,td')].map((c) => (c.innerText || '').toLowerCase());
        } else {
          continue; // 没有可靠表头，跳过该表，避免 Views 读进 Comments
        }
      }
      const iViews = findCol(header, 'views');
      const iLikes = findCol(header, 'likes');
      const iComments = findCol(header, 'comments');
      const iShares = findCol(header, 'shares');
      const iDate = findCol(header, 'date');
      if (iViews < 0 && iComments < 0) continue;
      const bodyStart = trs.indexOf(headerRow) + 1;
      // 表头含空首列（勾选框）而 body 没有时，按「表头列数 - 数据列数」校正下标
      for (const tr of trs.slice(Math.max(1, bodyStart))) {
        const tds = [...tr.querySelectorAll('td')];
        const cells = tds.map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
        if (!cells.length) continue;
        const offset = Math.max(0, header.length - cells.length);
        const at = (idx) => {
          if (idx < 0) return '';
          const j = idx - offset;
          return j >= 0 && j < cells.length ? cells[j] : '';
        };
        const a = tr.querySelector('a[href*="/video/"], a[href*="item_id="], a[href*="aweme"], a[href*="tiktok.com/@"]');
        const img = tr.querySelector('img');
        const href = a?.href || '';
        const title = cells
          .filter((c) => c && !isMetricNum(c))
          .sort((a, b) => b.length - a.length)[0] || (a?.getAttribute('aria-label') || a?.innerText || '').trim();
        const nums = cells.filter(isMetricNum);
        let cover = img?.currentSrc || img?.src || img?.getAttribute('data-src') || img?.getAttribute('srcset')?.split(/\s/)[0] || '';
        if (!/^https?:\/\//i.test(cover)) {
          const bgEl = tr.querySelector('[style*="background"], [class*="cover"], [class*="thumb"], [class*="Cover"], [class*="Thumb"]');
          const style = bgEl ? (bgEl.getAttribute('style') || '') : '';
          const bm = style.match(/url\(["']?(https?[^"')]+)/i);
          if (bm) cover = bm[1];
        }
        const attrId = tr.getAttribute('data-video-id')
          || tr.getAttribute('data-item-id')
          || tr.getAttribute('data-id')
          || tr.querySelector('[data-video-id]')?.getAttribute('data-video-id')
          || tr.querySelector('[data-item-id]')?.getAttribute('data-item-id')
          || '';
        const hasHeaderMap = iViews >= 0 || iLikes >= 0 || iComments >= 0;
        push({
          title,
          views: hasHeaderMap && iViews >= 0 ? at(iViews) : nums[0],
          likes: hasHeaderMap && iLikes >= 0 ? at(iLikes) : nums[1],
          comments: hasHeaderMap && iComments >= 0 ? at(iComments) : nums[2],
          shares: hasHeaderMap && iShares >= 0 ? at(iShares) : nums[3],
          postedAt: iDate >= 0 ? at(iDate) : '',
          videoUrl: href,
          videoId: pickId(href) || (/^\d{8,}$/.test(attrId) ? attrId : ''),
          coverUrl: /^https?:\/\//i.test(cover) ? cover : '',
        });
      }
    }

    // 2) 卡片/列表布局（无 table 时）
    if (!items.length) {
      const cards = document.querySelectorAll(
        '[class*="Content"], [class*="content"] [class*="item"], [class*="Post"], [class*="video-card"], [data-e2e*="video"]'
      );
      for (const card of cards) {
        const a = card.querySelector('a[href*="/video/"], a[href*="tiktok.com/@"]');
        const img = card.querySelector('img');
        const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text && !a) continue;
        const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const title = lines.find((l) => l.length > 2 && !isMetricNum(l) && !/^(views?|likes?|comments?|shares?|播放|点赞|评论|分享)$/i.test(l)) || '';
        const nums = lines.filter(isMetricNum);
        push({
          title: title || (a?.innerText || '').trim(),
          views: nums[0],
          likes: nums[1],
          comments: nums[2],
          shares: nums[3],
          postedAt: lines.find((l) => /\b(ago|天前|周前|小时|分钟|yesterday|w ago|d ago|h ago)\b/i.test(l)) || '',
          videoUrl: a?.href || '',
          videoId: pickId(a?.href || '') || card.getAttribute('data-video-id') || '',
          coverUrl: img?.src || '',
        });
      }
    }

    return items.slice(0, 100);
  }).catch(() => []);
}

function parseContentRows(tables) {
  const rows = [];
  for (const table of tables) {
    const header = table[0].map((h) => String(h || '').toLowerCase());
    if (!isLikelyContentTableHeader(header)) continue;
    const iViews = findContentMetricCol(header, 'views');
    const iLikes = findContentMetricCol(header, 'likes');
    const iComments = findContentMetricCol(header, 'comments');
    const iShares = findContentMetricCol(header, 'shares');
    const iDate = findContentMetricCol(header, 'date');
    for (const row of table.slice(1)) {
      const title = row
        .filter((c) => c && !/^[+-]?[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(c) && !/^\d{8,}$/.test(String(c).replace(/,/g, '')))
        .sort((a, b) => b.length - a.length)[0] || '';
      const nums = row.filter((c) => {
        const t = String(c || '').trim().replace(/,/g, '');
        if (/^\d{8,}$/.test(t)) return false;
        return /^[+-]?[$€£¥]?\s*[0-9][0-9,.\s]*\s*(%|K|M|B)?$/i.test(String(c || '').trim());
      });
      if (!title && !nums.length) continue;
      const offset = Math.max(0, header.length - row.length);
      const at = (idx) => {
        if (idx < 0) return '';
        const j = idx - offset;
        return j >= 0 && j < row.length ? row[j] : '';
      };
      const hasHeaderMap = iViews >= 0 || iLikes >= 0 || iComments >= 0;
      rows.push({
        title: String(title).slice(0, 500),
        views: num(hasHeaderMap && iViews >= 0 ? at(iViews) : nums[0]),
        likes: num(hasHeaderMap && iLikes >= 0 ? at(iLikes) : nums[1]),
        comments: num(hasHeaderMap && iComments >= 0 ? at(iComments) : nums[2]),
        shares: num(hasHeaderMap && iShares >= 0 ? at(iShares) : nums[3]),
        postedAt: iDate >= 0 ? String(at(iDate) || '').slice(0, 64) : '',
        videoId: '',
        videoUrl: '',
        coverUrl: '',
      });
    }
  }
  return rows.slice(0, 100);
}

/** 去掉时长前缀 / 重复标题，便于把 Studio「00:15 Foo Foo」对上公开页 desc */
function normalizeContentTitle(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '');
  const half = Math.floor(s.length / 2);
  if (half >= 4) {
    const a = s.slice(0, half).trim();
    const b = s.slice(half).trim();
    if (a && a === b) s = a;
  }
  return s.toLowerCase();
}

function titlesLooselyMatch(a, b) {
  const na = normalizeContentTitle(a);
  const nb = normalizeContentTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const short = Math.min(na.length, nb.length, 48);
  if (short >= 8 && na.slice(0, short) === nb.slice(0, short)) return true;
  return false;
}

function pickCoverUrl(node) {
  if (!node || typeof node !== 'object') return '';
  const candidates = [
    node.cover,
    node.coverUrl,
    node.cover_url,
    node.originCover,
    node.origin_cover,
    node.dynamicCover,
    node.dynamic_cover,
    node.thumbnail,
    node.thumbnailUrl,
    node.thumbnail_url,
    node.video?.cover,
    node.video?.originCover,
    node.video?.dynamicCover,
    node.video?.cover?.urlList?.[0],
    node.video?.cover?.url_list?.[0],
    node.cover?.urlList?.[0],
    node.cover?.url_list?.[0],
    Array.isArray(node.covers) ? node.covers[0] : '',
  ];
  for (let c of candidates) {
    if (!c) continue;
    if (typeof c === 'object') {
      c = c.urlList?.[0] || c.url_list?.[0] || c.url || c.uri || '';
    }
    c = String(c || '').trim();
    if (/^https?:\/\//i.test(c)) return c;
  }
  return '';
}

/**
 * 用登录态打开主页并请求 /api/post/item_list/，拿封面 + videoId + 标题。
 * Studio Content 表格本身几乎没有公开链和封面，这项是主数据源。
 */
/**
 * 打开公开主页，抓视频目录 + 账号终身总量（粉丝/关注/获赞/视频数，以及可汇总的播放/评论）
 * 返回 { items, totals }；旧调用方若当数组用会拿到空（已全部改为解构）。
 */
async function fetchProfileVideoCatalog(page, username = '', log = () => {}) {
  const user = String(username || '').replace(/^@/, '').trim();
  const empty = { items: [], totals: emptyProfileTotals() };
  if (!user || !page) return empty;
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(user)}`;
  try {
    const userRe = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`/@${userRe}(?:\\?|/|$)`, 'i').test(page.url() || '')) {
      log(`打开主页补总量与视频目录：@${user}`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2800);
      try {
        const { solveRotateCaptchaIfPresent } = require('./nocaptchaai');
        await solveRotateCaptchaIfPresent(page);
      } catch { /* ignore */ }
    }
  } catch (e) {
    log(`打开主页失败：${e.message || e}`);
  }

  const raw = await page.evaluate(async (uname) => {
    const parseNum = (raw) => {
      const text = String(raw || '').replace(/,/g, '').trim().toUpperCase();
      const m = text.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
      if (!m) return null;
      const mul = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
      return Math.round(Number(m[1]) * mul);
    };
    const pickId = (item) => String(item?.id || item?.aweme_id || item?.awemeId || item?.itemId || item?.item_id || '').trim();
    const pickCover = (item) => {
      const tryOne = (c) => {
        if (!c) return '';
        if (typeof c === 'object') c = c.urlList?.[0] || c.url_list?.[0] || c.url || '';
        c = String(c || '').trim();
        return /^https?:\/\//i.test(c) ? c : '';
      };
      return tryOne(item?.video?.cover)
        || tryOne(item?.video?.originCover)
        || tryOne(item?.video?.dynamicCover)
        || tryOne(item?.cover)
        || tryOne(item?.originCover)
        || tryOne(item?.covers?.[0])
        || '';
    };
    const packList = (list) => (Array.isArray(list) ? list : []).map((item) => {
      const id = pickId(item);
      if (!/^\d{8,}$/.test(id)) return null;
      const stats = item.stats || item.statistics || item.stat || {};
      const title = String(item.desc || item.title || item.description || item.caption || '').trim();
      return {
        videoId: id,
        videoUrl: `https://www.tiktok.com/@${encodeURIComponent(uname)}/video/${id}`,
        coverUrl: pickCover(item),
        title,
        views: Number(stats.playCount ?? stats.play_count ?? stats.views ?? 0) || 0,
        likes: Number(stats.diggCount ?? stats.digg_count ?? stats.likes ?? 0) || 0,
        comments: Number(stats.commentCount ?? stats.comment_count ?? stats.comments ?? 0) || 0,
        shares: Number(stats.shareCount ?? stats.share_count ?? stats.shares ?? 0) || 0,
        postedAt: '',
      };
    }).filter(Boolean);

    const readUserDetail = () => {
      try {
        const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!script?.textContent) return null;
        const data = JSON.parse(script.textContent);
        const scope = data?.__DEFAULT_SCOPE__ || data || {};
        return scope['webapp.user-detail'] || null;
      } catch {
        return null;
      }
    };

    const detail = readUserDetail();
    const userInfo = detail?.userInfo || {};
    const u = userInfo.user || {};
    const st = userInfo.stats || userInfo.statsV2 || {};
    const ssrTotals = {
      handle: String(u.uniqueId || u.unique_id || uname || '').replace(/^@/, ''),
      displayName: String(u.nickname || u.nickName || '').trim(),
      bio: String(u.signature || u.bio || '').trim(),
      avatarUrl: String(u.avatarLarger || u.avatarMedium || u.avatarThumb || u.avatar_larger || '').trim(),
      followers: Number(st.followerCount ?? st.follower_count ?? st.followers ?? 0) || 0,
      following: Number(st.followingCount ?? st.following_count ?? st.following ?? 0) || 0,
      likes: Number(st.heartCount ?? st.heart ?? st.diggCount ?? st.digg_count ?? st.likes ?? 0) || 0,
      videos: Number(st.videoCount ?? st.video_count ?? st.awemeCount ?? st.aweme_count ?? 0) || 0,
      views: 0,
      comments: 0,
      source: 'ssr',
    };

    const fromSsr = () => packList(detail?.itemList || detail?.postList || detail?.post?.itemList || userInfo.itemList || []);

    let items = fromSsr();
    const secUid = String(u.secUid || u.sec_uid || '').trim();
    // 翻页汇总公开视频播放/评论（最多约 100 条，足够小中号总量）
    if (secUid) {
      let cursor = '0';
      const merged = new Map(items.map((it) => [it.videoId, it]));
      for (let pageNo = 0; pageNo < 3; pageNo += 1) {
        try {
          const url = new URL(`${location.origin}/api/post/item_list/`);
          url.searchParams.set('aid', '1988');
          url.searchParams.set('count', '35');
          url.searchParams.set('cursor', cursor);
          url.searchParams.set('device_platform', 'web_pc');
          url.searchParams.set('secUid', secUid);
          url.searchParams.set('coverFormat', '2');
          const resp = await fetch(url.toString(), {
            credentials: 'include',
            headers: { accept: 'application/json, text/plain, */*', referer: location.href },
          });
          if (!resp.ok) break;
          const json = await resp.json();
          const list = json?.itemList || json?.item_list || [];
          const packed = packList(list);
          for (const it of packed) merged.set(it.videoId, it);
          cursor = String(json?.cursor ?? json?.maxCursor ?? json?.max_cursor ?? '');
          const hasMore = json?.hasMore ?? json?.has_more;
          if (!packed.length || hasMore === 0 || hasMore === false || !cursor) break;
        } catch {
          break;
        }
      }
      items = [...merged.values()];
    }

    // DOM 网格兜底：主页视频卡片常有封面图 + /video/ 链接
    if (!items.length) {
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        const href = a.href || '';
        const m = href.match(/\/video\/(\d{8,})/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const img = a.querySelector('img');
        let cover = img?.src || img?.getAttribute('data-src') || '';
        if (!cover) {
          const bg = (a.querySelector('[style*="background"]') || a).getAttribute('style') || '';
          const bm = bg.match(/url\(["']?(https?[^"')]+)/i);
          if (bm) cover = bm[1];
        }
        items.push({
          videoId: m[1],
          videoUrl: `https://www.tiktok.com/@${encodeURIComponent(uname)}/video/${m[1]}`,
          coverUrl: /^https?:\/\//i.test(cover) ? cover : '',
          title: (a.getAttribute('aria-label') || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          postedAt: '',
        });
      }
    }

    // DOM 计数兜底（SSR 缺字段时）
    const pickDom = (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const n = parseNum(el.getAttribute('title') || el.textContent || '');
        if (n != null) return n;
      }
      return null;
    };
    if (!ssrTotals.followers) {
      ssrTotals.followers = pickDom([
        '[data-e2e="followers-count"]',
        'strong[data-e2e="followers-count"]',
        'a[href*="/followers"] strong',
      ]) || 0;
    }
    if (!ssrTotals.following) {
      ssrTotals.following = pickDom([
        '[data-e2e="following-count"]',
        'strong[data-e2e="following-count"]',
        'a[href*="/following"] strong',
      ]) || 0;
    }
    if (!ssrTotals.likes) {
      ssrTotals.likes = pickDom([
        '[data-e2e="likes-count"]',
        'strong[data-e2e="likes-count"]',
        '[data-e2e="like-count"]',
      ]) || 0;
    }
    if (!ssrTotals.displayName) {
      ssrTotals.displayName = (document.querySelector('h1, [data-e2e="user-title"]')?.textContent || '').trim();
    }
    if (!ssrTotals.avatarUrl) {
      ssrTotals.avatarUrl = document.querySelector('[data-e2e="user-avatar"] img')?.getAttribute('src') || '';
    }
    if (!ssrTotals.videos) {
      ssrTotals.videos = items.length || 0;
    }

    let viewsSum = 0;
    let commentsSum = 0;
    let likesSum = 0;
    for (const it of items) {
      viewsSum += Number(it.views) || 0;
      commentsSum += Number(it.comments) || 0;
      likesSum += Number(it.likes) || 0;
    }
    ssrTotals.views = viewsSum;
    ssrTotals.comments = commentsSum;
    // 主页「获赞」是账号收到的赞；视频 digg 汇总仅作兜底
    if (!ssrTotals.likes && likesSum) ssrTotals.likes = likesSum;

    return {
      items: items.slice(0, 100),
      totals: ssrTotals,
    };
  }, user).catch(() => null);

  const payload = raw && typeof raw === 'object' ? raw : empty;
  const list = Array.isArray(payload.items) ? payload.items : [];
  const totals = { ...emptyProfileTotals(), ...(payload.totals || {}) };
  log(
    `主页总量：粉丝=${totals.followers} 关注=${totals.following} 获赞=${totals.likes} 视频=${totals.videos}`
    + ` 浏览≈${totals.views} 评论≈${totals.comments}；目录 ${list.length} 条（封面 ${list.filter((x) => x.coverUrl).length}）`
  );
  return { items: list, totals };
}

function emptyProfileTotals() {
  return {
    handle: '',
    displayName: '',
    bio: '',
    avatarUrl: '',
    followers: 0,
    following: 0,
    likes: 0,
    videos: 0,
    views: 0,
    comments: 0,
    source: '',
  };
}

/** 从内容行汇总播放/评论/点赞（主页缺量时兜底） */
function sumContentTotals(rows = []) {
  let views = 0;
  let comments = 0;
  let likes = 0;
  let videos = 0;
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(row.videoId || '') || `${row.title}|${row.views}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos += 1;
    views += Number(row.views) || 0;
    comments += Number(row.comments) || 0;
    likes += Number(row.likes) || 0;
  }
  return { views, comments, likes, videos };
}

/** 把主页目录 / API 元数据合并进 Content 行 */
function enrichContentWithCatalog(rows, catalog, username = '') {
  const user = String(username || '').replace(/^@/, '').trim();
  const pool = [...(catalog || [])];
  const used = new Set();
  const take = (pred) => {
    const idx = pool.findIndex((p, i) => !used.has(i) && pred(p));
    if (idx < 0) return null;
    used.add(idx);
    return pool[idx];
  };

  const enriched = (rows || []).map((row) => {
    let hit = null;
    if (row.videoId) {
      hit = take((p) => String(p.videoId) === String(row.videoId));
    }
    if (!hit && row.title) {
      hit = take((p) => titlesLooselyMatch(row.title, p.title));
    }
    if (!hit && (Number(row.views) || 0) > 0) {
      // Studio 播放量与公开页 playCount 常一致，标题对不上时用播放量兜底
      hit = take((p) => Number(p.views) === Number(row.views));
    }
    if (!hit) {
      if (row.videoId && !row.videoUrl) {
        row.videoUrl = user
          ? `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${row.videoId}`
          : `https://www.tiktok.com/video/${row.videoId}`;
      }
      return row;
    }
    return {
      ...row,
      videoId: row.videoId || hit.videoId,
      videoUrl: row.videoUrl || hit.videoUrl,
      coverUrl: row.coverUrl || hit.coverUrl,
      title: row.title || hit.title || '',
      // 公开页 item_list 的 playCount/diggCount/commentCount 为准，避免 Studio「Video」列误匹配污染
      views: preferCatalogStat(row.views, hit.views),
      likes: preferCatalogStat(row.likes, hit.likes),
      comments: preferCatalogStat(row.comments, hit.comments),
      shares: preferCatalogStat(row.shares, hit.shares),
    };
  });

  // 仍缺链接的行：按剩余目录顺序补齐（仅补空字段，不覆盖已有指标）
  for (let i = 0; i < enriched.length; i += 1) {
    const row = enriched[i];
    if (row.videoId && row.coverUrl && row.videoUrl) continue;
    if (row.videoId) continue; // 已有 ID 就别乱绑
    const leftover = take(() => true);
    if (!leftover) break;
    enriched[i] = {
      ...row,
      videoId: leftover.videoId,
      videoUrl: leftover.videoUrl,
      coverUrl: row.coverUrl || leftover.coverUrl,
      title: row.title || leftover.title || '',
      views: preferCatalogStat(row.views, leftover.views),
      likes: preferCatalogStat(row.likes, leftover.likes),
      comments: preferCatalogStat(row.comments, leftover.comments),
      shares: preferCatalogStat(row.shares, leftover.shares),
    };
  }

  if (!enriched.length && pool.length) {
    return pool.slice(0, 100);
  }
  return enriched;
}

/** 从监听的 Studio/item_list API 响应里提取视频元数据 */
function collectApiVideoMeta(apiHits, username = '') {
  const user = String(username || '').replace(/^@/, '').trim();
  const byId = new Map();
  const byTitle = new Map();
  for (const hit of apiHits || []) {
    let json = null;
    try {
      json = typeof hit.body === 'string' ? JSON.parse(hit.body) : hit.body;
    } catch {
      continue;
    }
    const walk = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        node.slice(0, 80).forEach((x) => walk(x, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      const id = String(node.id || node.aweme_id || node.awemeId || node.itemId || node.item_id || '').trim();
      if (/^\d{8,}$/.test(id)) {
        const cover = pickCoverUrl(node);
        const title = String(node.desc || node.title || node.description || node.caption || node.name || '').trim();
        const stats = node.stats || node.statistics || node.stat || {};
        const url = user
          ? `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${id}`
          : `https://www.tiktok.com/video/${id}`;
        const meta = {
          videoId: id,
          videoUrl: url,
          coverUrl: cover,
          title,
          views: Number(stats.playCount ?? stats.play_count ?? stats.views ?? node.videoViews ?? 0) || 0,
          likes: Number(stats.diggCount ?? stats.digg_count ?? stats.likes ?? 0) || 0,
          comments: Number(stats.commentCount ?? stats.comment_count ?? stats.comments ?? 0) || 0,
          shares: Number(stats.shareCount ?? stats.share_count ?? stats.shares ?? 0) || 0,
          postedAt: '',
        };
        if (!byId.has(id) || (!byId.get(id).coverUrl && meta.coverUrl)) {
          byId.set(id, meta);
        }
        const nk = normalizeContentTitle(title);
        if (nk) byTitle.set(nk, meta);
      }
      for (const k of ['itemList', 'item_list', 'posts', 'videos', 'list', 'data', 'items', 'video_list', 'videoList']) {
        if (node[k] != null) walk(node[k], depth + 1);
      }
    };
    walk(json);
  }
  return { byId, byTitle, items: [...byId.values()] };
}

/** 用 API 元数据补 DOM 行的 videoId / cover / 链接；DOM 为空时直接用 API 行 */
function enrichContentFromApi(rows, apiHits, username = '') {
  const user = String(username || '').replace(/^@/, '').trim();
  const { byId, byTitle, items } = collectApiVideoMeta(apiHits, username);
  const enriched = (rows || []).map((row) => {
    const titleKey = normalizeContentTitle(row.title);
    let hit = (row.videoId && byId.get(String(row.videoId))) || (titleKey && byTitle.get(titleKey)) || null;
    if (!hit && titleKey) {
      hit = items.find((it) => titlesLooselyMatch(row.title, it.title)) || null;
    }
    if (!hit) {
      if (row.videoId && !row.videoUrl) {
        row.videoUrl = user
          ? `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${row.videoId}`
          : `https://www.tiktok.com/video/${row.videoId}`;
      }
      return row;
    }
    return {
      ...row,
      videoId: row.videoId || hit.videoId,
      videoUrl: row.videoUrl || hit.videoUrl,
      coverUrl: row.coverUrl || hit.coverUrl,
      title: row.title || hit.title || '',
      views: preferCatalogStat(row.views, hit.views),
      likes: preferCatalogStat(row.likes, hit.likes),
      comments: preferCatalogStat(row.comments, hit.comments),
      shares: preferCatalogStat(row.shares, hit.shares),
    };
  });
  // DOM 没抓到行时，退回 API 列表
  if (!enriched.length && items.length) {
    return items.slice(0, 100);
  }
  return enriched;
}

function mergeContentRows(primary, fallback) {
  const out = [];
  const seen = new Set();
  for (const row of [...(primary || []), ...(fallback || [])]) {
    const key = String(row.videoId || '') || `${row.title}|${row.views}|${row.postedAt}`;
    if (seen.has(key)) {
      const idx = out.findIndex((r) => (String(r.videoId || '') || `${r.title}|${r.views}|${r.postedAt}`) === key);
      if (idx >= 0) {
        out[idx] = {
          ...out[idx],
          ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== '' && v != null && v !== 0)),
          views: Math.max(Number(out[idx].views) || 0, Number(row.views) || 0),
          likes: Math.max(Number(out[idx].likes) || 0, Number(row.likes) || 0),
          comments: Math.max(Number(out[idx].comments) || 0, Number(row.comments) || 0),
          shares: Math.max(Number(out[idx].shares) || 0, Number(row.shares) || 0),
          videoId: out[idx].videoId || row.videoId || '',
          videoUrl: out[idx].videoUrl || row.videoUrl || '',
          coverUrl: out[idx].coverUrl || row.coverUrl || '',
        };
      }
      continue;
    }
    seen.add(key);
    out.push({ ...row });
  }
  return out.slice(0, 100);
}

/**
 * 拉取 Studio 数据并入库（四个页签 + 28 天日序列）
 * 总任务 keepBrowser：复用已打开环境，禁止关窗再开。
 */
async function pullStudioStats(accountId, options = {}) {
  let account;
  try {
    account = await dataStore.getAccountBundle(accountId);
  } catch (e) {
    throw new Error(`读取账号包失败（GET /api/node/accounts/${accountId}/bundle）：${e.message}`);
  }
  if (!account) throw new Error('账号不存在');

  const logCtx = { accountId, ...(options.logContext || {}) };
  const log = (msg) => liveLog(`拉数据#${accountId}：${msg}`, 'info', logCtx);
  const { connectAccount, closeConnection } = require('./tiktok-actions');
  const analyticsUrl = options.analyticsUrl || ANALYTICS_URL;
  // 与发布/登录同路径：复用 activeConnection，forceRelaunch 由 keepBrowser 决定
  // keepBrowser 会话内 connectAccount 默认不重开；独立拉取仍可 forceRelaunch
  const connection = await connectAccount(accountId, analyticsUrl, 'sync', {
    saveTraffic: options.saveTraffic,
  });
  let page = connection.page;
  const apiHits = [];
  const daysMap = new Map();

  try {
    // 监听页面自己请求的分析接口：既是数据源也是排错线索
    page.on('response', async (res) => {
      try {
        if (apiHits.length >= 60) return;
        const url = res.url();
        if (!/insight|analytic|statistic|creator|studio\/api|data\/overview|key.?metric|item_list|video_list|content|post\/list|video\/list|aweme/i.test(url)) return;
        const ct = String(res.headers()['content-type'] || '');
        if (!/json/i.test(ct)) return;
        const json = await res.json().catch(() => null);
        if (!json) return;
        let body;
        try { body = JSON.stringify(json); } catch (_) { body = ''; }
        apiHits.push({ url, body: body.slice(0, 40000) });
        extractSeriesFromJson(json, { days: daysMap });
      } catch { /* ignore */ }
    });

    const session = await inspectTikTokSession(connection.ws, page).catch(() => null);
    if (session && session.loggedIn === false) {
      throw new Error('当前浏览器没有有效 TikTok 登录状态，请先到账号页登录后再拉取');
    }

    // 1) 打开 Analytics
    const diag = await gotoAnalytics(page, log, analyticsUrl);
    log(`页面：地址=${diag.url} 页签=${diag.tabs} 关键指标=${diag.hasKeyMetrics} 文本长度=${diag.textLen || 0}`);
    if (!diag.tabs && !diag.hasKeyMetrics) {
      log(`页面摘要：${String(diag.head || '').slice(0, 240)}`);
      throw new Error(`TikTok Studio 数据分析页没有加载出内容（当前页 ${diag.url}），请确认该浏览器环境已登录并能打开 tiktokstudio/analytics`);
    }

    // 2) 逐页签采集
    const tabList = await discoverTabs(page);
    log(`已发现页签：${tabList.map((t) => t.label).join(' / ') || '（无）'}`);
    const tabsData = [];
    const capture = async (tabLabel) => {
      // 滚动一下触发懒加载图表/列表，再等渲染
      await page.evaluate(() => window.scrollTo(0, Math.min(1200, document.body.scrollHeight))).catch(() => {});
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(600);
      // 每个页签都有自己的时间区间控件，必须先切到 28 天再抓
      const range = await ensureLast28Days(page, log);
      const cards = await scrapeCards(page);
      const pairs = await scrapeTextPairs(page);
      const metrics = normalizeMetrics(cards, pairs);
      const text = await scrapePageText(page);
      const tables = await scrapeTables(page);
      const key = tabKeyOf(tabLabel);
      // Content 页签额外抓链接 / 封面（表格文本 alone 不够）
      const contentItems = key === 'content' ? await scrapeContentItems(page) : [];
      const entry = {
        key,
        label: tabLabel,
        url: page.url(),
        range,
        text,
        metrics,
        tables,
        contentItems,
      };
      tabsData.push(entry);
      log(
        `页签 ${tabLabel}：范围=${range || '未知'} 指标 ${metrics.length} 个（卡片=${cards.length}，键值=${pairs.length}），文本=${text.length}`
        + (key === 'content' ? `，内容行=${contentItems.length}` : '')
      );
      return entry;
    };

    if (tabList.length === 0) {
      await capture('Overview');
    } else {
      // 先抓当前页签（通常是 Overview），再依次点其它页签
      await capture(tabList[0].label);
      for (const tab of tabList.slice(1)) {
        const ok = await activateTab(page, tab.label, log);
        if (!ok) continue;
        await capture(tab.label);
      }
    }

    const overviewTab = tabsData.find((t) => t.key === 'overview') || tabsData[0] || { metrics: [], text: '' };
    const contentTab = tabsData.find((t) => t.key === 'content');
    const followersTab = tabsData.find((t) => t.key === 'followers');
    const viewerTab = tabsData.find((t) => t.key === 'viewer');

    // 3) 28 天日序列
    const keys28 = last28DateKeys();
    const daily = keys28.map((dk) => {
      const hit = daysMap.get(dk);
      if (hit) return { ...emptyDay(dk), ...hit, metricDate: dk };
      return emptyDay(dk);
    });
    const hasSeries = [...daysMap.values()].some((d) => d.videoViews || d.likes || d.comments || d.shares || d.profileViews);

    // 4) 概览指标
    const m = (names) => {
      const hit = findMetric(overviewTab.metrics, names);
      return hit ? hit.value : 0;
    };
    const period = {
      videoViews: m(['video views', '视频播放', '播放量', 'views']),
      profileViews: m(['profile views', '主页浏览', 'profile view']),
      likes: m(['likes', '点赞']),
      comments: m(['comments', '评论']),
      shares: m(['shares', '分享', '转发']),
      estRewards: m(['est. rewards', 'estimated rewards', '预估收益', 'rewards']),
    };
    if (!hasSeries && (period.videoViews || period.likes || period.comments || period.shares)) {
      const last = daily[daily.length - 1];
      last.videoViews = period.videoViews;
      last.profileViews = period.profileViews;
      last.likes = period.likes;
      last.comments = period.comments;
      last.shares = period.shares;
      last.estRewards = period.estRewards;
      log('analytics: 没有拿到按日序列，已把 28 天汇总记在最后一天');
    }

    // Studio Overview 的 likes/comments 是「近 28 天」，不能当终身总量。
    // 终身粉丝/获赞/视频数等改从公开主页 SSR/DOM 拉取（下面 fetchProfileVideoCatalog）。
    const studioFollowersHint = m(['total followers', '总粉丝']);
    const studioVideosHint = m(['videos', '视频数', 'videos count', 'posted']);
    const studioTotalViewsHint = m(['total views', '总播放', '总浏览']);

    // 5) 内容页签逐条数据：DOM/表格 + 监听 API + 主页 item_list（封面/链接主来源）
    const username = account.username || account.handle || '';
    const fromDom = contentTab?.contentItems || [];
    const fromTables = parseContentRows([
      ...(contentTab ? contentTab.tables : []),
      ...tabsData.flatMap((t) => t.tables || []),
    ].slice(0, 5));
    let contentRows = mergeContentRows(fromDom, fromTables);
    contentRows = enrichContentFromApi(contentRows, apiHits, username);
    let profileCatalog = [];
    let profileTotals = emptyProfileTotals();
    try {
      const catalogResult = await fetchProfileVideoCatalog(page, username, log);
      profileCatalog = Array.isArray(catalogResult) ? catalogResult : (catalogResult.items || []);
      profileTotals = { ...emptyProfileTotals(), ...(catalogResult?.totals || {}) };
    } catch (e) {
      log(`主页总量/视频目录失败：${e.message || e}`);
    }
    contentRows = enrichContentWithCatalog(contentRows, profileCatalog, username);
    // 再扫一遍：公开目录有 videoId 命中时强制用 item_list 指标（防止 enrich 链路上遗漏）
    if (profileCatalog.length) {
      const byId = new Map(profileCatalog.map((p) => [String(p.videoId || ''), p]));
      contentRows = contentRows.map((row) => {
        const hit = row.videoId ? byId.get(String(row.videoId)) : null;
        if (!hit) return sanitizeContentMetrics(row);
        return sanitizeContentMetrics({
          ...row,
          views: preferCatalogStat(row.views, hit.views),
          likes: preferCatalogStat(row.likes, hit.likes),
          comments: preferCatalogStat(row.comments, hit.comments),
          shares: preferCatalogStat(row.shares, hit.shares),
        });
      });
    } else {
      contentRows = contentRows.map((row) => sanitizeContentMetrics(row));
    }
    const swapped = contentRows.filter((r) => r._metricsSwapped).length;
    if (swapped) {
      log(`内容指标纠错：已对 ${swapped} 条疑似「播放/评论」对调的数据进行校正`);
    }
    const contentSums = sumContentTotals(contentRows);
    const withLink = contentRows.filter((r) => r.videoUrl || r.videoId).length;
    const withCover = contentRows.filter((r) => r.coverUrl).length;
    log(`内容数据：${contentRows.length} 条（有链接/ID ${withLink}，有封面 ${withCover}，主页目录 ${profileCatalog.length}）`);

    const pickPositive = (...vals) => {
      for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 0;
    };
    const followersTotal = pickPositive(profileTotals.followers, studioFollowersHint, followersTab && findMetric(followersTab.metrics, ['total followers', 'followers', '粉丝'])?.value);
    const followingTotal = pickPositive(profileTotals.following);
    const likesTotal = pickPositive(profileTotals.likes); // 绝不用 Overview 的 28 天 likes
    const videosTotal = pickPositive(profileTotals.videos, studioVideosHint, contentSums.videos, profileCatalog.length);
    // 浏览/评论总量：优先公开主页 item_list 汇总，其次才是 Content 表（表头易错）
    const viewsTotal = pickPositive(profileTotals.views, contentSums.views, studioTotalViewsHint);
    const commentsTotal = pickPositive(profileTotals.comments, contentSums.comments);
    log(
      `账号总量：粉丝=${followersTotal} 关注=${followingTotal} 获赞=${likesTotal}`
      + ` 视频=${videosTotal} 浏览=${viewsTotal} 评论=${commentsTotal}`
      + `（来源=${profileTotals.source || 'fallback'}）`
    );

    const profile = {
      handle: String(profileTotals.handle || account.username || ''),
      displayName: String(profileTotals.displayName || account.nickname || ''),
      bio: String(profileTotals.bio || ''),
      avatarUrl: String(profileTotals.avatarUrl || ''),
      followers: followersTotal,
      following: followingTotal,
      likes: likesTotal,
      videos: videosTotal,
      views: viewsTotal,
      comments: commentsTotal,
      shares: 0, // 终身转发暂无公开入口；28 天仍写 periodShares
      periodVideoViews: period.videoViews,
      periodProfileViews: period.profileViews,
      periodLikes: period.likes,
      periodComments: period.comments,
      periodShares: period.shares,
      periodEstRewards: period.estRewards,
    };

    const tabsPayload = tabsData.map((t) => ({
      key: t.key,
      label: t.label,
      url: t.url,
      range: t.range || '',
      text: t.text,
      metrics: t.metrics,
      metricCount: t.metrics.length,
    }));

    const meta = {
      pageUrl: diag.url,
      tabCount: tabsData.length,
      tabs: tabsData.map((t) => t.label),
      ranges: tabsData.map((t) => `${t.label}:${t.range || '未知'}`),
      apiCount: apiHits.length,
      hasSeries,
      followersTabMetrics: followersTab ? followersTab.metrics.length : 0,
      viewerTabMetrics: viewerTab ? viewerTab.metrics.length : 0,
      capturedAt: nowChinaIso(),
    };

    try {
      await dataStore.tiktokAnalyticsSync(account.id, {
        profile,
        period,
        daily,
        rangeDays: 28,
        tabs: tabsPayload,
        content: contentRows,
        api: apiHits.slice(0, 10),
        meta,
      });
    } catch (e) {
      // 抓到了但存不进去（最常见是 PHP 侧权限/表结构），必须说清是哪个接口
      throw new Error(
        `保存 Studio 数据失败（POST /api/node/accounts/${account.id}/tiktok-analytics-sync）：${e.message}`
      );
    }

    const totalMetrics = tabsPayload.reduce((n, t) => n + t.metrics.length, 0);
    log(`已保存：页签=${tabsPayload.length} 指标=${totalMetrics} 内容=${contentRows.length} 日数据=${daily.length} 接口=${apiHits.length}`);

    // 6) 系统通知：抓通知内容 → PHP 按「时间+内容」排重入库 → 命中违规词由 AI 判定封停状态
    //    通知失败不影响统计数据（统计已入库），只记日志
    let notifySummary = null;
    try {
      const { pullStudioNotifications } = require('./tiktok-studio-notifications');
      const notify = await pullStudioNotifications(page, { log: (m) => log(`通知：${m}`) });
      if (notify.items.length) {
        const saved = await dataStore.accountNotificationsSync(account.id, {
          items: notify.items,
          source: 'studio',
          pageUrl: notify.pageUrl,
        });
        notifySummary = saved;
        log(
          `notify: 入库 收到=${saved.received ?? '-'} 建表=${saved.tableReady === false ? '失败' : 'ok'} `
          + `新增=${saved.inserted} 去重跳过=${saved.skipped} `
          + `疑似违规=${saved.violations} 新命中=${saved.newViolations}`
          + (saved.error ? ` 错误=${saved.error}` : '')
        );
        if (saved.ban) {
          log(`通知：AI 判定 ${JSON.stringify(saved.ban).slice(0, 800)}`);
        }
      } else {
        log(`通知：没有解析到通知（DOM=${notify.domCount} 接口=${notify.apiCount} 地址=${notify.pageUrl}）`);
      }
    } catch (e) {
      log(`通知：抓取/入库失败 ${e.message}`);
    }

    // 解析不到任何指标时别装成功——原文已入库，抛错让分任务明确失败并带上线索
    if (totalMetrics === 0) {
      throw new Error(
        `四个页签都没解析到指标（页面已打开：${diag.url}；页签 ${tabsPayload.length} 个：${tabsPayload.map((t) => t.label).join('/') || '无'}）。`
        + '原始页面文本已存入 tiktok_studio_tabs.raw_text，请把 PullStats 日志发我以便按实际结构解析'
      );
    }

    return {
      status: 'ok',
      accountId: Number(account.id),
      profile,
      period,
      dailyCount: daily.length,
      hasSeries,
      tabCount: tabsPayload.length,
      metricCount: totalMetrics,
      contentCount: contentRows.length,
      apiCount: apiHits.length,
      tabs: tabsPayload.map((t) => ({ key: t.key, label: t.label, range: t.range || '', metrics: t.metricCount })),
      notifyInserted: notifySummary ? Number(notifySummary.inserted || 0) : 0,
      notifySkipped: notifySummary ? Number(notifySummary.skipped || 0) : 0,
      notifyViolations: notifySummary ? Number(notifySummary.violations || 0) : 0,
      notifyBan: notifySummary ? (notifySummary.ban || null) : null,
      message: `Studio 数据已拉取：${tabsPayload.length} 个页签 / ${totalMetrics} 项指标 / ${contentRows.length} 条内容数据`
        + (notifySummary
          ? `；系统通知新增 ${notifySummary.inserted} 条（去重 ${notifySummary.skipped} 条，疑似违规 ${notifySummary.violations} 条）`
          : '；系统通知未取到（详见任务日志里的 notify: 行）'),
    };
  } catch (error) {
    // 失败也要把现场写回，前端「拉取现场」能看到原因
    try {
      await dataStore.tiktokAnalyticsSync(account.id, {
        error: String(error.message || error).slice(0, 1000),
        meta: {
          pageUrl: page ? page.url() : '',
          tabCount: 0,
          apiCount: apiHits.length,
          capturedAt: nowChinaIso(),
        },
      });
    } catch { /* ignore */ }
    log(`失败：${error.message}`);
    throw error;
  } finally {
    // keepBrowser 时 closeConnection 会保活 CDP，供后续分任务接着用
    await closeConnection(connection).catch(() => {});
  }
}

module.exports = { pullStudioStats, last28DateKeys, fetchProfileVideoCatalog };
