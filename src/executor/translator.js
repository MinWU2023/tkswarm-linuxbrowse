const dataStore = require('./data-store');

async function translationConfig() {
  return {
    translationMode: await dataStore.getSetting('translationMode', 'off'),
    translationApiUrl: await dataStore.getSetting('translationApiUrl', ''),
    translationApiKey: await dataStore.getSetting('translationApiKey', ''),
    translationQuota: Number(await dataStore.getSetting('translationQuota', 0)) || 0,
    translationUsed: Number(await dataStore.getSetting('translationUsed', 0)) || 0,
    translationTarget: await dataStore.getSetting('translationTarget', 'zh'),
    translationModelId: await dataStore.getSetting('translationModelId', 'gpt-3.5-turbo'),
  };
}

async function translateText(text, { from = 'auto', to = 'zh' } = {}) {
  const cfg = await translationConfig();
  const mode = cfg.translationMode || 'off';
  if (mode === 'off') throw new Error('翻译未启用，请在系统设置中开启');
  if (cfg.translationQuota > 0 && cfg.translationUsed >= cfg.translationQuota) {
    throw new Error('翻译配额已用尽');
  }
  const source = String(text || '').trim();
  if (!source) throw new Error('翻译内容为空');

  let result;
  let provider = mode;
  if (mode === 'basic') {
    if (!cfg.translationApiUrl) throw new Error('普通翻译未配置接口地址');
    const url = new URL(cfg.translationApiUrl);
    url.searchParams.set('q', source);
    url.searchParams.set('langpair', `${from === 'auto' ? 'autodetect' : from}|${to}`);
    const response = await fetch(url, { headers: cfg.translationApiKey ? { Authorization: `Bearer ${cfg.translationApiKey}` } : {} });
    if (!response.ok) throw new Error(`翻译接口失败 ${response.status}`);
    const data = await response.json();
    result = data?.responseData?.translatedText || data?.translatedText || data?.data?.translations?.[0]?.translatedText;
    if (!result) throw new Error('翻译接口未返回有效文本');
    provider = 'basic';
  } else if (mode === 'ai') {
    if (!cfg.translationApiUrl || !cfg.translationApiKey) throw new Error('智能翻译需配置 API 地址与密钥');
    const endpoint = cfg.translationApiUrl.replace(/\/$/, '') + '/chat/completions';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.translationApiKey}` },
      body: JSON.stringify({
        model: cfg.translationModelId || 'gpt-3.5-turbo',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `You are a translator. Translate the user text into ${to}. Return only the translation.` },
          { role: 'user', content: source },
        ],
      }),
    });
    if (!response.ok) throw new Error(`智能翻译失败 ${response.status}`);
    const data = await response.json();
    result = data?.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error('智能翻译未返回有效文本');
    provider = 'ai';
  } else {
    throw new Error('未知翻译模式');
  }

  await dataStore.setSetting('translationUsed', Number(cfg.translationUsed || 0) + 1);
  return { text: result, provider, remaining: cfg.translationQuota > 0 ? Math.max(0, cfg.translationQuota - cfg.translationUsed - 1) : null };
}

/**
 * 强制翻译：不看「翻译模式」开关，只要配置了接口地址就直接翻。
 * 客服私信发送用这个——系统设置里已经把翻译接口对接好了，不该因为模式是 off 就发不出去。
 * 顺序：有密钥走 AI（OpenAI 兼容），否则走普通翻译接口。
 */
async function translateForced(text, { from = 'zh', to = 'en' } = {}) {
  const cfg = await translationConfig();
  const source = String(text || '').trim();
  if (!source) throw new Error('翻译内容为空');
  if (cfg.translationQuota > 0 && cfg.translationUsed >= cfg.translationQuota) {
    throw new Error('翻译配额已用尽');
  }
  const apiUrl = String(cfg.translationApiUrl || '').trim();
  if (!apiUrl) {
    throw new Error('未配置翻译接口：请在系统设置填写「翻译 API」');
  }
  const apiKey = String(cfg.translationApiKey || '').trim();
  // 模式是 ai，或有密钥，按 OpenAI 兼容接口处理
  const useAi = String(cfg.translationMode || '') === 'ai' || apiKey !== '';
  let result;
  let provider;
  if (useAi) {
    if (!apiKey) throw new Error('智能翻译未配置密钥：请在系统设置填写「翻译 API Key」');
    const endpoint = apiUrl.replace(/\/$/, '') + '/chat/completions';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: cfg.translationModelId || 'gpt-3.5-turbo',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `You are a translator. Translate the user text into ${to}. Return only the translation, no explanation.` },
          { role: 'user', content: source },
        ],
      }),
    });
    if (!response.ok) throw new Error(`翻译接口失败 ${response.status}`);
    const data = await response.json();
    result = data?.choices?.[0]?.message?.content?.trim();
    provider = 'ai-forced';
  } else {
    const url = new URL(apiUrl);
    url.searchParams.set('q', source);
    url.searchParams.set('langpair', `${from}|${to}`);
    const response = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!response.ok) throw new Error(`翻译接口失败 ${response.status}`);
    const data = await response.json();
    result = data?.responseData?.translatedText || data?.translatedText || data?.data?.translations?.[0]?.translatedText;
    provider = 'basic-forced';
  }
  const out = String(result || '').trim();
  if (!out) throw new Error('翻译接口未返回有效文本');
  await dataStore.setSetting('translationUsed', Number(cfg.translationUsed || 0) + 1);
  return { text: out, provider };
}

function heuristicLang(text) {
  const s = String(text || '');
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  if (/[\uac00-\ud7af]/.test(s)) return 'ko';
  if (/[а-яА-ЯёЁ]/.test(s)) return 'ru';
  if (/[àâäéèêëïîôùûüÿç]/i.test(s)) return 'fr';
  return 'en';
}

async function detectLanguage(text) {
  const cfg = await translationConfig();
  const mode = cfg.translationMode || 'off';
  if (mode === 'off') throw new Error('翻译未启用，请先在系统设置开启翻译后再自动检测');
  const source = String(text || '').trim();
  if (!source) throw new Error('没有可检测的文本，请先有对方发来的消息');
  return { language: heuristicLang(source), provider: 'heuristic' };
}

module.exports = { translateText, translateForced, detectLanguage, translationConfig };
