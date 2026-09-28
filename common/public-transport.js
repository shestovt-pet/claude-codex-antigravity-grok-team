'use strict';

// Напоминание добавляется на границе протокола, в том числе к отказам проверки схемы SDK.
// Форматирование обычных ответов также работает при прямом вызове без транспорта.
function publicTransport(transport) {
  const { context, scope } = require('./request-context');
  const requests = new Map();
  let handler = transport.onmessage;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: value => {
      handler = value && ((message, ...args) => {
        const current = scope(message?.params?.arguments);
        if (message?.method === 'tools/call' && message.id != null) requests.set(message.id, current);
        return context.run(current, () => value(message, ...args));
      });
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message, ...options) => {
    const current = requests.get(message?.id) || context.getStore() || {};
    if (message?.result || message?.error) requests.delete(message.id);
    const content = message?.result?.content;
    if (Array.isArray(content)) {
      const warning = require('./work-owner').reminder(undefined, undefined, current);
      const first = content.find(item => item.type === 'text');
      if (first) {
        const body = first.text.replace(/^(?:⚠ Статус пользователю[^\n]*\n)+/, '');
        const text = (warning ? warning + '\n' : '') + body;
        message = { ...message, result: { ...message.result,
          content: content.map(item => item === first ? { ...item, text } : item) } };
      }
    }
    return send(message, ...options);
  };
  return transport;
}
module.exports = { publicTransport };
