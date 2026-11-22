'use strict';
// Имена из источника запуска; неизвестные модели не угадываем.
function family(model) {
  if (typeof model !== 'string') return null;
  if (/^kimi-code\/(?:kimi-for-coding|k3|k3-256k|k3\.1-pro|k3\.1-pro-highspeed)$/.test(model)) return 'moonshot';
  if (/^deepseek(?:[- .]|$)/i.test(model)) return 'deepseek';
  if (/^(gemini)(?:[- .]|$)/i.test(model)) return 'google';
  if (/^(claude|opus|sonnet|haiku)(?:[- .]|$)/i.test(model)) return 'anthropic';
  if (/^(gpt|o[134])(?:[- .]|$)/i.test(model)) return 'openai';
  if (/^grok(?:[- .]|$)/i.test(model)) return 'xai';
  return null;
}
module.exports = { family };
