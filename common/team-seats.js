'use strict';
// Места обязательных участников team_change (team-v18, К3): одна проверка для design, commit, verdict, merge и precheck.
// Место Codex или Antigravity закрывает собственное «ПРИНЯТО», замена Claude после двух отказов (design who=claude replaces)
// или «ПРИНЯТО» Grok на месте выпавшего — только по поручению grok_slot. «РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ» — пометка в истории.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const words = require('./user-word'), stores = require('./team-store');
const SEATS = ['codex', 'antigravity'];
const NAMES = { codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' };
const TEN_MIN = 600000;
const PENDING = ['queued', 'waiting_quota', 'running', 'cancelling', 'stop_unconfirmed'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function binding(c, phase, candidate = c.candidate) {
  return phase === 'design' ? { designHash: c.designHash } : { base: c.base, candidate };
}
const bound = (v, b) => Object.entries(b).every(([k, x]) => v[k] === x);
const records = (c, phase, b) => ((phase === 'design' ? c.designVotes : c.verdicts) || []).filter(v => bound(v, b));
// Поручения grok_slot этой фазы и редакции в порядке создания; без номера поручения слот не создан.
const slots = (c, phase, b) => (c.grokSlots || []).filter(s => s.phase === phase && s.job_id && bound(s, b));
// Grok занимает не больше одного обязательного места на хеш или пару: место первого созданного поручения grok_slot.
const grokSeat = (c, phase, b) => slots(c, phase, b)[0]?.seat || null;
function slotOf(c, phase, b, v) {
  const s = slots(c, phase, b).find(s => s.job_id === v.job_id && s.seat === v.replaces);
  return s && s.seat === grokSeat(c, phase, b) ? s : null;
}

function seat(c, who, phase, candidate = c.candidate) {
  const b = binding(c, phase, candidate), recs = records(c, phase, b);
  const own = recs.filter(v => v.who === who), lastOwn = own.at(-1);
  const claude = phase === 'design' ? recs.filter(v => v.who === 'claude' && v.replaces === who && v.decision === 'ПРИНЯТО') : [];
  const grok = []; // Старые замены не закрывают и не блокируют место.
  const base = { seat: who, phase, binding: b, closed: false, blocked: false, by: null, record: null, empty: !own.length && !claude.length && !grok.length };
  // Отказ Grok на месте выпавшего снимает только новая редакция: ни «Отклонено:», ни позднее «ПРИНЯТО» вернувшегося.
  const grokNo = grok.find(v => v.decision === 'НЕ ПРИНЯТО');
  if (grokNo) return { ...base, blocked: true, by: 'grok', record: grokNo, reason: 'НЕ ПРИНЯТО Grok на месте ' + NAMES[who] + ' (' + grokNo.job_id + ') — снимает только новая редакция' };
  // Собственный отказ снимает своё позднее «ПРИНЯТО» или замена Claude после двух отказов; «ПРИНЯТО» Grok — нет.
  if (lastOwn?.decision === 'НЕ ПРИНЯТО' && !claude.some(v => recs.indexOf(v) > recs.indexOf(lastOwn)))
    return { ...base, blocked: true, by: 'own', record: lastOwn, reason: 'НЕ ПРИНЯТО ' + NAMES[who] + (lastOwn.job_id ? ' (' + lastOwn.job_id + ')' : '') };
  if (lastOwn?.decision === 'ПРИНЯТО') return { ...base, closed: true, by: 'own', record: lastOwn };
  if (claude.length) return { ...base, closed: true, by: 'claude', record: claude.at(-1) };
  const yes = grok.find(v => v.decision === 'ПРИНЯТО');
  if (yes) return { ...base, closed: true, by: 'grok', record: yes, slot: slotOf(c, phase, b, yes) };
  return { ...base, reason: 'нет ПРИНЯТО ' + NAMES[who] };
}

// Кто недоступен по действующему слову; при двух выпавших проверить вместо них некому.
function down(now = Date.now()) { return require('./members').helpers.filter(w => words.active(w, now)); }
function waitReason(c, who) { return down().includes(who) ? 'Изменение ждёт: недоступен ' + NAMES[who] : null; }
function seatError(c, who, phase, candidate) {
  const st = seat(c, who, phase, candidate);
  if (st.closed) return null;
  return waitReason(c, who, phase, candidate) || ('Нет действующего принятия: ' + who + ' — ' + st.reason +
    (!st.blocked && words.active(who) ? '; изменение ждёт возвращения участника' : ''));
}

function hashIn(task, hash, prefix = false) {
  return new RegExp('(^|[^a-fA-F0-9])' + (prefix ? hash.slice(0, 12) + '(?:' + hash.slice(12) + ')?' : hash) + '([^a-fA-F0-9]|$)').test(task);
}
const taskText = j => j.task || j.poruchenie || '';
// Поручения-ревью участника по этому изменению (метка запроса); с b — только на эту редакцию.
function reviewJobs(c, who, b) {
  return stores.list(who, false).jobs.filter(j => {
    const task = taskText(j);
    if (!c.requestMark || !task.includes(c.requestMark)) return false;
    if (who === 'codex' ? (j.write || j.previous) : !['review', 'zamechaniya'].includes(j.mode || j.rezhim)) return false;
    if (!b) return true;
    return b.designHash ? hashIn(task, b.designHash, true) : hashIn(task, b.base) && hashIn(task, b.candidate);
  }).sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
}
// Поздний отказ: строка начинается с «НЕ ПРИНЯТО» без учёта регистра, после снятия разметки (**, __, `) и пробелов.
const refusal = line => /^не принято(?![\p{L}\p{N}])/iu.test(String(line || '').replace(/^[\s*_`]+/, ''));
const lastLine = text => (text.trim().split(/\r?\n/).at(-1) || '').trim().replace(/^(\*\*|\*|__|_)(.+)\1$/, '$2').trim();
// Готовый текст ответа поручения, даже если оно завершилось из «отмена идёт» состоянием «отменено» или «не удалось».
function answerText(who, j) {
  const dir = stores.roots()[who];
  try {
    if (who === 'antigravity') {
      const folder = path.dirname(j.cardFile), text = fs.readFileSync(path.join(folder, 'result.txt'), 'utf8');
      const meta = path.join(folder, 'meta.json');
      if (fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).hash !== sha(text)) return null;
      return text;
    }
    const file = stores.resultPath(j, dir);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch { return null; }
}
// Отказ участника по этой редакции в хранилище, даже незаписанный: его отказ не пропадает. Готовое поручение проверяется
// как голос; поздний ответ поручения, остановленного отменой или сбоем, с последней строкой «НЕ ПРИНЯТО» — тоже отказ.
function storeRefusal(c, who, phase, candidate = c.candidate) {
  const b = binding(c, phase, candidate);
  for (const j of reviewJobs(c, who, b)) {
    if (j.status === 'done') {
      try {
        stores.review(who, j.id, phase === 'design' ? null : c.base, phase === 'design' ? null : candidate, 'НЕ ПРИНЯТО', c.requestMark, phase === 'design' ? c.designHash : null);
        return j;
      } catch {}
      continue;
    }
    if (['queued', 'waiting_quota', 'running'].includes(j.status)) continue;
    // У неготового поручения отказ — последняя содержательная строка, начинающаяся с «НЕ ПРИНЯТО» (хвост любой).
    const text = answerText(who, j);
    if (text && refusal(lastLine(text))) return j;
  }
  return null;
}
// Поручения grok_slot этой редакции, ещё не в конечном состоянии (lost — конечное): пока Grok на месте читает, слияния нет.
function slotPending() { return []; }
// Завершённые «НЕ ПРИНЯТО» поручений grok_slot этой редакции — записанные или нет, на каком бы месте место ни закрылось.
function slotRefusals() { return []; }

const quotaConfirmed = (j, now) => j.retryKind === 'quota' && Number.isFinite(Date.parse(j.lastQuotaAt)) && Date.parse(j.nextAttemptAt) > now;
// Основание недоступности на момент now (К3 а): действующее слово; или — только после записанного и истёкшего слова —
// последнее поручение-ревью на эту редакцию, отправленное после истечения, в конечном состоянии сбоя.
function basis(c, phase, who, now, candidate = c.candidate) {
  const name = NAMES[who], checked_at = new Date(now).toISOString();
  const w = words.active(who, now);
  if (w) return { kind: 'слово', word_id: w.id, word_at: w.at, checked_at };
  const last = words.latest(who, now);
  if (!last) throw Error('Нет слова пользователя «' + name + ' отвалился»: без слова место не заменяется (team_word).');
  const from = Date.parse(last.at), expiry = from + words.DAY;
  const back = words.success(who, from, now);
  if (back) throw Error(name + ' отвечал после слова (поручение ' + back.id + '): без нового слова место не заменяется.');
  const job = reviewJobs(c, who, binding(c, phase, candidate)).at(-1);
  if (!job || !(Date.parse(job.startedAt) > expiry))
    throw Error('Слово о ' + name + ' истекло; поручения ему на текущую редакцию после истечения нет: нужно такое поручение или новое слово.');
  if (job.cancelled || job.cancel_requested || job.lateHash || !['lost', 'failed', 'waiting_quota'].includes(job.status))
    throw Error('Слово о ' + name + ' истекло; последнее поручение ' + job.id + ' (' + (require('./states')[job.status] || job.status) + ') недоступность не доказывает.');
  if (job.status === 'waiting_quota' && !quotaConfirmed(job, now)) throw Error('Нет подтверждённой нехватки квоты ' + name + ' (поручение ' + job.id + ').');
  return { kind: 'поручение', word_id: last.id, word_at: last.at, job_id: job.id, job_status: job.status, checked_at };
}

function headings(text) {
  return [...new Set(require('./precheck').plainLines(text).map(l => l.text.match(/^##\s+(.+?)\s*$/)?.[1]).filter(Boolean))];
}
function coverageLines(text) {
  const lines = text.split(/\r?\n/), start = lines.findIndex(l => /^##\s+Покрытие\s*$/.test(l.trim()));
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,6}\s/.test(l.trim())) break; out.push(l.trim()); }
  return out;
}
// Элемент покрыт, если в разделе «## Покрытие» есть пункт, начинающийся с него, с замечанием или «без замечаний».
function uncovered(text, elements) {
  const lines = coverageLines(text);
  if (!lines) return elements.slice();
  const items = lines.map(l => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^[`«"„“*]+/, '')).filter(Boolean);
  return elements.filter(el => !items.some(item => item.startsWith(el) &&
    /^[`»"“”*]*\s*(?::|—|–|-)\s*\S/.test(item.slice(el.length))));
}

function materialText({ c, phase, who, slotId, elements, content, b }) {
  return 'Материал места ' + NAMES[who] + ' (team_change grok_slot ' + slotId + '), изменение ' + c.name + ', фаза ' + (phase === 'design' ? 'замысел' : 'кандидат') + '\n' +
    'Метка запроса: ' + c.requestMark + '\n' +
    (phase === 'design' ? 'Замысел: ' + c.designFile + ', sha256 ' + b.designHash + '\n' : 'База: ' + b.base + '\nКандидат: ' + b.candidate + '\n') +
    'Элементы покрытия (' + elements.length + '):\n' + elements.map(e => '- ' + e).join('\n') + '\n' +
    '----- НАЧАЛО МАТЕРИАЛА -----\n' + content + (content.endsWith('\n') ? '' : '\n') + '----- КОНЕЦ МАТЕРИАЛА -----\n';
}
function slotTask({ c, phase, who, slotId, elements, b, materialSha }) {
  return 'Проверка на месте выпавшего обязательного участника ' + NAMES[who] + ' (team_change grok_slot ' + slotId + ', изменение ' + c.name + ').\n' +
    'Твой голос на этом месте обязательный (rules/common.md, ворота замысла, пункт «Недоступность»). Материал собрал сервер целиком (sha256 ' + materialSha + '); читай его частями до конца.\n' +
    'Запрос пользователя ' + c.requestMark + ':\n' + c.request + '\n' +
    (phase === 'design' ? 'Замысел sha256 ' + b.designHash + '\n' : 'Пара база→кандидат: ' + b.base + ' → ' + b.candidate + '\n') +
    'Сначала, до чтения материала, выпиши по дословному запросу: результат, признаки промаха, чего не просили; затем сверь материал со своими критериями: что пользователь увидит, что упущено, где риск или неработоспособность.\n' +
    'Замечания: [блокирующее]/[улучшение], [разовое]/[системное], П0–П3, «проверено по тексту» или «догадка».\n' +
    'Затем раздел «## Покрытие»: по пункту на каждый элемент списка ниже — «- <элемент>: <замечание>» или «- <элемент>: без замечаний». Раздел «## Покрытие» в предел слов не входит; без пункта по каждому элементу ответ не засчитывается.\n' +
    'Элементы покрытия (' + elements.length + '):\n' + elements.map(e => '- ' + e).join('\n') + '\n' +
    'Последняя строка — ПРИНЯТО или НЕ ПРИНЯТО: N блокирующих.';
}

// Основание недоступности на момент создания поручения Grok: от слова до создания у выпавшего нет успешного ответа ни
// по одной работе; слово-основание к созданию не истекло. Ответ после создания занятое место не отменяет.
function basisAtCreation(s) {
  const created = Date.parse(s.created_at), from = Date.parse(s.basis?.word_at);
  if (!Number.isFinite(created) || !Number.isFinite(from)) return 'нет времени создания поручения Grok или слова-основания';
  const back = words.success(s.seat, from, created);
  if (back) return NAMES[s.seat] + ' ответил до создания поручения Grok (поручение ' + back.id + ')';
  if (s.basis.kind === 'слово' && !(created - from < words.DAY)) return 'слово-основание истекло до создания поручения Grok';
  return null;
}
// Голос Grok на месте выпавшего засчитывается только при совпадении привязки, основания, материала и покрытия (К3, К4).
function verifySlot(c, phase, who, jobId, decision, { state, candidate = c.candidate } = {}) {
  const b = binding(c, phase, candidate);
  const s = (c.grokSlots || []).find(s => s.job_id === jobId);
  if (!s) throw Error('Поручение Grok ' + jobId + ' создано не через team_change grok_slot: место выпавшего оно не закрывает.');
  if (s.phase !== phase || s.seat !== who || !bound(s, b)) throw Error('Поручение grok_slot ' + jobId + ' относится к другому месту, фазе или редакции.');
  const used = grokSeat(c, phase, b);
  if (used !== who) throw Error('Grok уже назначен на место ' + NAMES[used] + ' этой редакции: одно место на хеш или пару; нужна новая редакция.');
  const stale = basisAtCreation(s);
  if (stale) throw Error('Основание недоступности не подтверждено на момент создания поручения Grok: ' + stale + '; место не заменяется.');
  let saved;
  try { saved = fs.readFileSync(path.join(state, 'changes', c.name, path.basename(s.materialFile))); }
  catch { throw Error('Сохранённый материал места не найден: ' + s.materialFile); }
  if (sha(saved) !== s.materialSha256) throw Error('Сохранённый материал места изменён: sha256 не совпадает.');
  const j = stores.list('grok', false).jobs.find(j => j.id === jobId);
  if (!j) throw Error('Поручение Grok ' + jobId + ' не найдено.');
  if (sha(j.text || '') !== s.materialSha256 || j.materialHash !== s.materialSha256 || !String(j.task || '').includes(s.id))
    throw Error('Материал в поручении Grok не совпадает с сохранённым (усечён или подменён).');
  const reviewed = stores.review('grok', jobId, phase === 'design' ? null : c.base, phase === 'design' ? null : candidate, decision, c.requestMark, phase === 'design' ? c.designHash : null);
  const missing = uncovered(reviewed.reviewText, s.coverage || []);
  if (missing.length) throw Error('В разделе «## Покрытие» ответа Grok нет: ' + missing.join(', ') + ' — ответ не засчитывается.');
  return { slot: s, text: reviewed.reviewText };
}
// Записанный голос Grok на месте выпавшего по текущей редакции (для совещательного запроса этой же фазы).
function grokSlotVote(c, phase, candidate = c.candidate) {
  const b = binding(c, phase, candidate);
  return records(c, phase, b).find(v => v.who === 'grok' && v.replaces && slotOf(c, phase, b, v)) || null;
}

module.exports = { SEATS, NAMES, TEN_MIN, PENDING, binding, bound, records, slots, grokSeat, seat, down, waitReason, seatError,
  reviewJobs, storeRefusal, slotPending, slotRefusals, basis, basisAtCreation, headings, uncovered, materialText, slotTask, verifySlot, grokSlotVote, hashIn, sha };
