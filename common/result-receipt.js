'use strict';
// team-v56 Л2 (ревью круг 5, М1): доказуемый след ВЫДАЧИ готового результата потомка его родителю. Пишет сервер-получатель
// (codex/deepseek/kimi — те, кому поручают исходящие): когда обработчик *_result выдаёт результат ЗАВЕРШЁННОГО поручения-
// потомка его родителю (parentJob потомка == текущее поручение вызывающего, job-identity.currentJob), он отмечает в карточке
// ПОТОМКА факт выдачи: кому (номер родителя), когда (at) и sha256 выданного результата. Прежний след (resultsReceived из
// stream.ndjson родителя) засчитывал ЛЮБОЙ ответ на вызов *_result — в том числе «ещё работает»/ошибку: родитель мог
// получить «ещё идёт», потомок завершался позже, и приёмка проходила без фактического получения готового результата.
// Отметка пишется только для done/applied с читаемым результатом и только тому, кто является родителем потомка, поэтому
// «ещё работает»/ошибка/выдача другому вызывающему отметки не создают. acceptanceJobs (members-kimi) проверяет: выдано
// именно этому родителю, после finishedAt потомка, sha совпадает с текущим результатом карточки.
const fs = require('fs'), crypto = require('crypto');
const TERMINAL_OK = ['done', 'applied'];
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
// Нужная отметка выдачи или null (не применимо/уже записана). Идемпотентно по паре родитель+sha: повторная выдача того же
// результата тому же родителю отметку не дублирует.
function deliveryMark(card, callerJobId, resultText) {
  if (!card || typeof card !== 'object' || typeof resultText !== 'string') return null;
  if (!callerJobId || !card.parentJob || card.parentJob !== callerJobId) return null;
  if (!TERMINAL_OK.includes(card.status) || !Number.isFinite(Date.parse(card.finishedAt))) return null;
  const sha = sha256(resultText);
  const have = Array.isArray(card.resultDeliveries) ? card.resultDeliveries : [];
  if (have.some(d => d && d.to === callerJobId && d.sha256 === sha)) return null;
  return { to: callerJobId, at: new Date().toISOString(), sha256: sha };
}
function append(card, mark) {
  if (!mark) return false;
  card.resultDeliveries = [...(Array.isArray(card.resultDeliveries) ? card.resultDeliveries : []), mark];
  return true;
}
// Вызывается из обработчика *_result после разрешения карточки. mutate(id,fn) — хранилище сервера-получателя (карточка
// потомка, resultFile уже разрешён в абсолютный путь). Отметка пишется только о том, что РЕАЛЬНО возвращено вызывающему:
// ответ строится обработчиком по снимку `snapshot` (тот же j, что уходит в view), поэтому отметку строим по НЕМУ, а не по
// самостоятельно перечитанной карточке — иначе была бы гонка (круг 6, М1): снимок running, но карточка к моменту record()
// уже done, отметка писалась бы о невыданном результате. Любая ошибка молча проглатывается: это служебный след, он не
// должен ломать выдачу результата вызывающему.
async function record({ load, mutate, id, snapshot, fromChar = 0 }) {
  try {
    // from_char>0 — постраничное продолжение: view отдаёт не начало результата, значит «выдано начало готового результата»
    // ещё не доказано этим вызовом (начало выдаётся при from_char==0 и тогда же пишется отметка). Отметки нет.
    if (fromChar) return;
    const snap = snapshot;
    // Снимок, по которому формируется ответ: только терминальный успех с читаемым результатом и настоящим родителем.
    // Иначе вызывающему возвращается неготовый ответ — отметки нет, карточку даже не перечитываем.
    if (!snap || typeof snap !== 'object' || snap.archived || !TERMINAL_OK.includes(snap.status) ||
        !snap.parentJob || !snap.resultFile || !fs.existsSync(snap.resultFile)) return;
    const caller = require('./job-identity').currentJob();
    if (!caller || caller.id !== snap.parentJob) return;
    let snapText; try { snapText = fs.readFileSync(snap.resultFile, 'utf8'); } catch { return; }
    if (!deliveryMark(snap, caller.id, snapText)) return;
    const snapSha = sha256(snapText);
    await mutate(id, c => {
      // Отметка — только если текущая карточка та же завершённая редакция, что в снимке (совпали status, finishedAt,
      // resultFile), и sha того же файла результата совпадает со снимком. Другая редакция/другой результат → строже: нет.
      if (c.archived || !TERMINAL_OK.includes(c.status) || c.parentJob !== caller.id) return false;
      if (c.status !== snap.status || c.finishedAt !== snap.finishedAt || c.resultFile !== snap.resultFile) return false;
      if (!c.resultFile || !fs.existsSync(c.resultFile)) return false;
      let curText; try { curText = fs.readFileSync(c.resultFile, 'utf8'); } catch { return false; }
      if (sha256(curText) !== snapSha) return false;
      const mark = deliveryMark(c, caller.id, curText);
      if (!mark) return false;
      append(c, mark);
    });
  } catch {}
}
module.exports = { TERMINAL_OK, sha256, deliveryMark, append, record };
