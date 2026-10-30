'use strict';

// Напоминание добавляется на границе протокола, в том числе к отказам проверки схемы SDK.
// Форматирование обычных ответов также работает при прямом вызове без транспорта.
function snapshot(current = require('./request-context').context.getStore(), root) {
  if (current?.publicSnapshot) return current.publicSnapshot;
  const tool = current?.tool;
  const warning = (tool === 'team_status' || tool === 'team_work')
    ? require('./work-owner').reminder(root, undefined, current || {})
    : '';
  let banner = '';
  try { banner = require('./fallback').banner(current || {}); } catch {}
  const value = { warning, banner };
  if (current) current.publicSnapshot = value;
  return value;
}
function decorate(text, current) {
  const { warning, banner } = snapshot(current);
  const body = text.replace(/^(?:⚠ Статус пользователю[^\n]*\n)+/, '');
  // team-v46 п.7: строка «Входящие дирижёру» — только клиенту claude (не гостю), первой строкой; в сохранённый
  // результат поручения не попадает (сохранение идёт отдельно, мимо этой обёртки).
  let inbox = '';
  try {
    const acc = require('./access');
    if (acc.client() === 'claude' && !acc.guest()) inbox = require('./inbox').banner();
  } catch {}
  return (inbox ? inbox + '\n' : '') + (banner ? banner + '\n' : '') + (warning ? warning + '\n' : '') + body;
}
function publicTransport(transport) {
  const { context, scope } = require('./request-context');
  const requests = new Map();
  let handler = transport.onmessage;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: value => {
      handler = value && ((message, ...args) => {
        const current = scope(message?.params);
        if (process.env.MOST_MATRIX_PROBE === '1') current.probeArgs = message?.params?.arguments;
        if (message?.method === 'tools/call' && message.id != null) requests.set(message.id, current);
        return context.run(current, () => value(message, ...args));
      });
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message, ...options) => {
    const current = requests.get(message?.id) || context.getStore() || {};
    if (message?.result || message?.error) requests.delete(message.id);
    if (message?.result || message?.error) {
      try { require('./matrix-audit').record(current, message); } catch (e) { console.error('Журнал пробы: ' + e.message); }
    }
    const content = message?.result?.content;
    if (Array.isArray(content)) {
      const first = content.find(item => item.type === 'text');
      if (first) {
        const text = decorate(first.text, current);
        message = { ...message, result: { ...message.result,
          content: content.map(item => item === first ? { ...item, text } : item) } };
      }
    }
    return send(message, ...options);
  };
  return transport;
}
module.exports = { publicTransport, snapshot, decorate };
