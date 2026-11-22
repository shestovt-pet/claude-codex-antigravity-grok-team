'use strict';
// team-v59: слово владельца моста перекрывает правило-отказ в перечисленных действиях (замысел §4). Доказанный чат любого
// участника (common/chat-origin, как в v58) + непустая дословная цитата → запись в журнал слов (тем же хранилищем, что
// common/user-word.js: source chat-<клиент>, recorded_by, quote, overrides: <имя правила>, детали) и разрешение. Из
// поручения и из сеанса с недоказанным происхождением слово не принимается (граница v58 сохраняется). Каждая точка (голоса
// team_change, проверка остановки, входящие, закрытие, запись слова) зовёт override/assertOwner — следующее правило
// подключается одной строкой.
const words = require('./user-word');
const access = require('./access');

// Проверка права владельца дать слово: не поручение, доказанный чат, непустая цитата. Общая для всех точек.
function assertOwner(quote) {
  if (access.jobSession()) throw Error('Слово владельца принимает чат участника; из поручения запрещено.');
  if (!access.chatSession()) throw Error('Слово владельца принимает доказанный чат участника; происхождение чата не доказано: ' + access.chatOriginReason() + '.');
  if (typeof quote !== 'string' || !quote.trim()) throw Error('Нужно слово пользователя дословно (quote).');
}

// override(rule, quote, ctx): проверяет право, пишет запись в журнал слов и возвращает её. ctx — детали (replaces, phase,
// job_ids…), они идут в запись рядом с overrides=<имя правила>. Запись пишется тем же append под замком журнала, что и
// слово о помощнике; прежние читатели журнала её пропускают (кид owner_override им неизвестен).
async function override(rule, quote, ctx = {}) {
  assertOwner(quote);
  const client = access.client();
  return words.append({ kind: 'owner_override', overrides: rule, quote, source: 'chat-' + client, recorded_by: client, ...ctx });
}

// Строка риска одной фразой для ответа: мост предупреждает и выполняет (замысел §Принцип).
function riskLine(text) { return 'Слово владельца перекрывает правило моста: ' + text + ' Риск принят вами.'; }

module.exports = { assertOwner, override, riskLine };
