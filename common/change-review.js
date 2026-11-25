'use strict';
// Голос по изменению связки (поле change в codex_send / kimi_send / deepseek_send). Сервер по открытой карточке team_change
// заполняет changeReview { name, base, candidate } — по нему поручение классифицируется как review_high (model-choice) и
// карточка несёт привязку к кандидату. Требования одни для всех участников (перенесено из servers/codex, cache-622 Б2):
// новое поручение (без continue_id), роль «проверка», без записи; карточка изменения существует, открыта и имеет base/candidate.
const fs = require('fs');

function resolve(a, stateDir, who = 'Codex') {
  if (a.change === undefined) return undefined;
  if (a.role !== 'проверка' || a.write || a.continue_id)
    throw Error('Параметр change допустим для нового поручения ' + who + ' с ролью «проверка» и без записи.');
  const { inside, name } = require('./team-git');
  const id = name(a.change);
  const file = inside(stateDir, 'changes', id + '.json');
  let card;
  try { card = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw Error('Изменение связки не найдено: ' + id); throw e; }
  if (card?.name !== id || !card.base || !card.candidate || ['слито', 'закрыто без слияния'].includes(card.status))
    throw Error('Нужна открытая карточка изменения связки: ' + id);
  return { name: id, base: card.base, candidate: card.candidate };
}

module.exports = { resolve };
