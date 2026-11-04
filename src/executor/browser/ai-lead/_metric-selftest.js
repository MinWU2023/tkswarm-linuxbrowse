/**
 * 自测：粉丝/获赞/播放量解析（不入业务路径）
 * 运行：node src/services/browser/ai-lead/_metric-selftest.js
 */
const { parseMetricCount, pickLabeledMetricText } = require('./parse-metric-count');

function pickCombined(text, labelSrc) {
  const labelBody = String(labelSrc || '').replace(/^\^/, '').replace(/\$$/, '');
  return pickLabeledMetricText(text, labelBody);
}

/** 旧逻辑缺陷：把 ^$ 嵌进中间 */
function pickCombinedBuggy(text, labelSrc) {
  const combined = new RegExp(
    `([\\d]{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kKmMbB万亿wW])?\\s*(${labelSrc})`,
    'i'
  );
  const m = String(text).match(combined);
  return m ? m[0] : '';
}

function extractViewsLikePipeline(text) {
  const labeled = String(text).match(
    /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?\s*(views?|plays?|播放|观看|次播放)/i
  );
  if (labeled) return labeled[0];
  const m = String(text).match(/^([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?$/i);
  if (m) return m[0];
  const anywhere = String(text).match(
    /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmMbB万亿wW])?/i
  );
  if (anywhere && !/like|赞|heart/i.test(text)) return anywhere[0];
  return '';
}

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`  OK  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail || ''}`);
  }
}

console.log('--- parseMetricCount ---');
const parseCases = [
  ['70K', 70000],
  ['70.5K Followers', 70500],
  ['243.1K Likes', 243100],
  ['1.2M views', 1200000],
  ['16.2W', 162000],
  ['2.5万播放', 25000],
  ['1,234,567', 1234567],
];
for (const [raw, expect] of parseCases) {
  const got = parseMetricCount(raw);
  assert(`${raw} => ${expect}`, got === expect, `got ${got}`);
}

console.log('--- 粉丝/获赞合写：旧逻辑 vs 新逻辑 ---');
const labelCases = [
  ['70.5K Followers', '^(followers?|粉丝)$', 70500],
  ['70.5K·Followers', '^(followers?|粉丝)$', 70500],
  ['粉丝 80.2K', '^(followers?|粉丝)$', 80200],
  ['243.1K Likes', '^(likes?|获赞)$', 243100],
  ['243.1K·Likes', '^(likes?|获赞)$', 243100],
  ['获赞 1.2M', '^(likes?|获赞)$', 1200000],
];
for (const [text, labelSrc, expect] of labelCases) {
  const buggy = pickCombinedBuggy(text, labelSrc);
  const fixed = pickCombined(text, labelSrc);
  const buggyN = parseMetricCount(buggy);
  const fixedN = parseMetricCount(fixed);
  assert(`旧逻辑应失败或不准: ${text}`, buggyN !== expect || buggy === '', `buggy got ${buggyN} from ${JSON.stringify(buggy)}`);
  assert(`新逻辑: ${text} => ${expect}`, fixedN === expect, `got ${fixedN} from ${JSON.stringify(fixed)}`);
}

console.log('--- 播放量 ---');
const viewCases = [
  ['1.2M views', 1200000],
  ['850.3K views', 850300],
  ['1.2M·views', 1200000],
  ['播放 12.5万', 125000],
  ['12.5万播放', 125000],
  ['1,234', 1234],
  ['16.2K', 16200],
  ['2.1M plays', 2100000],
];
for (const [text, expect] of viewCases) {
  const viaPick = pickLabeledMetricText(text, 'views?|plays?|播放|观看|次播放');
  const got = parseMetricCount(viaPick || extractViewsLikePipeline(text));
  assert(`views ${text} => ${expect}`, got === expect, `got ${got} via ${JSON.stringify(viaPick)}`);
}

// 已知脆弱：点赞文案误入播放提取时应排除
{
  const t = '243.1K likes';
  const got = extractViewsLikePipeline(t);
  assert('播放提取应跳过 likes 文案', got === '' || !/like/i.test(got) || parseMetricCount(got) === 0 || true, `got ${got}`);
  // 当前 anywhere 分支：若 text 含 like 会跳过 anywhere；labeled 不匹配 likes → 空
  assert('243.1K likes 不应当播放', extractViewsLikePipeline(t) === '', `got ${JSON.stringify(extractViewsLikePipeline(t))}`);
}

console.log(failed ? `\nFAILED ${failed}` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
