'use strict';
// Версия 15 изолирована от таблицы и правил замены версии 14.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const stores = require('./team-store');
const g = () => require('./stage-gate');
const families = ['anthropic', 'openai', 'google', 'xai'];
const seats = require('./members').seats;
const fold = s => s.trim().toLowerCase().replace(/ё/g, 'е');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function parts(s) {
  const rows = Array.isArray(s.author) ? s.author : [{ ...s.author, part: '' }];
  if (!rows.length) throw Error('Укажите author.');
  const names = new Set();
  return rows.map(p => {
    const authors = p.authors || [{ family: p.family, model: p.model }];
    if (!Array.isArray(authors) || !authors.length || authors.some(a => !families.includes(a.family) || !a.model?.trim()) ||
        new Set(authors.map(a => a.family)).size !== authors.length ||
        (Array.isArray(s.author) && !p.part?.trim()) || names.has(fold(p.part || '')))
      throw Error('Укажите author: уникальные названия частей, семьи и модели авторов.');
    names.add(fold(p.part || ''));
    return { ...p, family: authors[0].family, authors, families: authors.map(a => a.family) };
  });
}
function covers(j, p, ps) {
  const ns = g().named(j.who === 'fresh' ? j.reviewText : g().task(j), ps);
  return !ns.length || ns.some(n => n.part === p.part);
}
// Время остановки поручения — самая ранняя из отметок (запрос отмены, «отмена идёт», завершение, потеря, перенос);
// без отметок время не доказано (NaN).
function stopped(j) {
  const marks = [j.cancel_requested?.at, j.cancellingAt, j.finishedAt, j.lostAt, j.appliedAt].map(v => Date.parse(v || '')).filter(Number.isFinite);
  return marks.length ? Math.min(...marks) : NaN;
}
// team-v18 К8: частичный результат выпавшего — подтверждение семьи автора без готового поручения.
function partial(w, s, jobs, ps, seen) {
  const rows = s.partial_sources || [], notes = [];
  if (!Array.isArray(rows)) throw Error('partial_sources должен быть списком.');
  for (const r of rows) {
    const label = (r?.job_id || 'без номера') + ': частичный источник';
    const j = jobs.find(j => j.id === r?.job_id);
    if (!j || (j.workName || j.work) !== w.name) throw Error(label + ' — нужно поручение этой работы.');
    if (j.role !== 'текст') throw Error(label + ' — нужна авторская роль «текст».');
    if (!['cancelled', 'failed', 'lost'].includes(j.status)) throw Error(label + ' — только отменённое, неудачное или потерянное поручение; готовое — через source_jobs.');
    const family = g().reviewerFamily(j);
    if (r.family !== family) throw Error(label + ' — семья ' + r.family + ' не совпадает с маршрутом поручения (' + family + ').');
    let targets = ps;
    if (Array.isArray(s.author)) {
      const p = ps.find(p => r.part?.trim() && fold(p.part) === fold(r.part));
      if (!p) throw Error(label + ' — для составного этапа укажите часть (part).');
      targets = [p];
    }
    if (!w.folder) throw Error(label + ' — нужна папка работы (folder).');
    const file = path.resolve(w.folder, r.file || '');
    if (!require('./paths').isInsideReal(file, w.folder)) throw Error(label + ' — файл вне папки работы.');
    const listed = list => (list || []).some(f => require('./paths').samePath(path.resolve(w.folder, f), file));
    for (const p of targets) {
      if (!listed(s.material) || (p.material && !listed(p.material))) throw Error(label + ' — файл не входит в material ' + (p.part ? 'части ' + p.part : 'этапа') + '.');
      if (!p.families.includes(family)) throw Error(label + ' — семья ' + family + ' не входит в author ' + (p.part || 'этапа') + '.');
    }
    if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== r.sha256) throw Error(label + ' — sha256 файла не совпадает.');
    // Слово пользователя о выпавшем — записано до отмены поручения.
    const word = r.word_id ? require('./user-word').byId(r.word_id) : null;
    if (!word || word.who_down !== j.who) throw Error(label + ' — нужен word_id слова пользователя о выпавшем ' + j.who + '.');
    if (!Number.isFinite(stopped(j))) throw Error(label + ' — у поручения нет отметки времени остановки: не доказано, что слово записано до отмены.');
    if (Date.parse(word.at) > stopped(j)) throw Error(label + ' — слово записано после отмены поручения.');
    for (const p of targets) seen.add((p.part || '') + '/' + family);
    notes.push('частичный результат ' + j.who + ', поручение ' + j.id);
  }
  return notes;
}
function sources(w, s, jobs, ps, snapshot) {
  const explicit = s.source_jobs || [];
  if (new Set(explicit).size !== explicit.length) throw Error('Повтор source_jobs.');
  const found = jobs.filter(j => g().belongs(j, w, s) && j.role === 'текст' && ['done', 'applied'].includes(j.status) && !j.cancelled);
  // team-v19 К4а: часть этапа-продолжения с source_job привязана к поручениям помощников, записавших её файл.
  const bound = ps.filter(p => p.source_job), free = ps.filter(p => !p.source_job), ids = p => [].concat(p.source_job || []);
  for (const id of [...explicit, ...new Set(bound.flatMap(ids))].filter((id, i, all) => all.indexOf(id) === i)) {
    const j = jobs.find(j => j.id === id);
    if (!j || (j.workName || j.work) !== w.name || j.role !== 'текст' || !['done', 'applied'].includes(j.status) || j.cancelled)
      throw Error(id + ': source_jobs требует готовый текст этой работы.');
    if (!found.includes(j)) found.push(j);
  }
  const seen = new Set();
  for (const j of found) {
    stores.source(j.who, j.id, snapshot);
    const family = g().reviewerFamily(j), own = bound.filter(p => ids(p).includes(j.id));
    let ns = own.length ? own : g().named(j.task || j.poruchenie || '', bound.length ? free : ps);
    if (!ns.length && bound.length && free.length === 1) ns = free;
    if (!ns.length && ps.length > 1) throw Error(j.id + ': назовите часть.');
    for (const p of ns.length ? ns : ps) {
      if (!p.families.includes(family)) throw Error(j.id + ': семья текста не совпадает с author части ' + p.part);
      seen.add((p.part || '') + '/' + family);
    }
  }
  const notes = partial(w, s, jobs, ps, seen);
  for (const p of ps) for (const f of p.families)
    if (f !== 'anthropic' && !seen.has((p.part || '') + '/' + f))
      throw Error('Автор без поручения «текст»: ' + (p.part || 'этап') + '/' + f);
  return notes;
}
function marker(text, names) {
  const lines = text.split(/\r?\n/).filter(l => names.some(n => l.startsWith(n + ':')));
  return lines.length === 1 ? lines[0].slice(lines[0].indexOf(':') + 1).trim() : null;
}
function fresh(row) {
  const family = marker(row.reviewText, ['family', 'семья']);
  const model = marker(row.reviewText, ['model', 'модель']);
  if (family !== 'anthropic' || !model || !/sonnet/i.test(model)) throw Error('Помощник: нужны семья anthropic и модель агента Sonnet.');
  const who = marker(row.reviewText, ['replacement', 'замена']);
  const evidence = marker(row.reviewText, ['evidence', 'доказательство']);
  if (who && !seats[who] && who !== 'mixed') throw Error('Неизвестное место замены помощника.');
  return { ...row, family, model, replacement: who, evidence };
}
function latestSent(rows) {
  if (!rows.length) return null;
  const ordered = rows.slice().sort((a, b) => g().at(a) - g().at(b) || (a.gateOrder || 0) - (b.gateOrder || 0));
  if (ordered.some(j => !Number.isFinite(g().at(j)))) throw Error('Неизвестен порядок поручений.');
  const last = ordered.at(-1), prev = ordered.at(-2);
  if (prev && g().at(prev) === g().at(last) && (prev.gateOrder || 0) === (last.gateOrder || 0)) throw Error('Неоднозначный порядок поручений.');
  return last;
}
function unavailable(w, s, who, evidence, jobs, dismissals = [], at = Date.now(), fams = []) {
  at = require('./user-word').ms(at);
  // team-v18 К5: действующее слово пользователя — доказательство наравне с поручением в конечном состоянии. Оно не заменяет
  // поручение на пересмотр после отклонения и не снимает отказ, поданный до слова (такой отказ снимает только пересмотр).
  if (/^word-/.test(evidence || '')) {
    const words = require('./user-word'), word = words.byId(evidence);
    if (dismissals.some(d => jobs.find(j => j.id === d.job_id)?.who === who)) throw Error('Нужно недоступное поручение на пересмотр с причиной отклонения.');
    if (!word || word.who_down !== who || !words.holds(word, at)) throw Error('Нет действующего слова пользователя о недоступности ' + who + ': ' + evidence);
    // team-v19 К4 (в): слово, записанное дирижёром, не доказывает недоступность по части, где его семья среди авторов.
    const by = require('./fallback').FAMILY[word.recorded_by];
    if (word.source && word.source !== 'chat-claude' && fams.includes(by))
      throw Error('Слово записал дирижёр ' + word.recorded_by + ', а его семья ' + by + ' среди авторов части: нужно доказательство поручением.');
    return { id: evidence, word };
  }
  const last = latestSent(jobs.filter(j => g().belongs(j, w, s) && j.who === who && j.role === 'проверка' && g().hasVersion(g().task(j), s.version)));
  if (!last || last.id !== evidence || last.cancelled || last.cancel_requested || last.lateHash ||
      !['lost', 'failed', 'waiting_quota'].includes(last.status)) throw Error('Нет подтверждённой недоступности последнего поручения ' + who);
  if (last.status === 'waiting_quota' && !(last.retryKind === 'quota' && Number.isFinite(Date.parse(last.lastQuotaAt)) && Date.parse(last.nextAttemptAt) > Date.now()))
    throw Error('Нет подтверждённой нехватки квоты ' + who);
  for (const d of dismissals) {
    const original = jobs.find(j => j.id === d.job_id);
    if (!original || original.who !== who) continue;
    if (g().at(last) <= Date.parse(d.at) || !g().task(last).includes(d.job_id) || !g().task(last).includes(d.reason))
      throw Error('Нужно недоступное поручение на пересмотр с причиной отклонения.');
  }
  return last;
}
function decisions(s, old, rows) {
  const previous = old?.decisions || [];
  const entries = s.decisions || [];
  if (!Array.isArray(entries) || entries.length < previous.length || previous.some((d, i) => !g().sameDecision(d, entries[i])))
    throw Error('Журнал решений неизменяем: допускается только добавление.');
  for (let i = 0; i < entries.length; i++) {
    const d = entries[i];
    if (!['dismiss', 'reconsider', 'replace'].includes(d.kind) || !d.version || !d.reason?.trim()) throw Error('Некорректная запись журнала решений.');
    if (d.version !== s.version || d.replacement === 'grok' || (s.gate?.historicGrokIds || []).includes(d.job_id)) continue;
    if (d.kind === 'dismiss') {
      const row = rows.find(j => j.id === d.job_id && j.count);
      if (!row) throw Error('Отклонение без проверенного отказа: ' + d.job_id);
    }
    if (d.kind === 'replace') {
      const row = rows.find(j => j.who === 'fresh' && j.hash === d.file_hash);
      if (!row || row.replacement !== d.replacement || (row.evidence || undefined) !== d.evidence || row.family !== d.family || row.model !== d.model)
        throw Error('Запись замены не совпадает с зарегистрированным файлом помощника.');
    }
    if (d.kind === 'reconsider') {
      const original = rows.find(j => j.id === d.job_id && j.count), next = rows.find(j => j.id === d.review_job_id);
      const dismissal = entries.find(x => x.kind === 'dismiss' && x.version === d.version && x.job_id === d.job_id);
      if (!original || !next || !dismissal || next.who !== original.who || g().at(next) <= Date.parse(dismissal.at) ||
          !g().task(next).includes(original.id) || !g().task(next).includes(dismissal.reason) ||
          d.outcome !== (next.count ? 'повторный блокирующий отказ' : 'пересмотрено и принято'))
        throw Error('Пересмотр не подтверждён поручением того же проверяющего с причиной.');
    }
    if (i >= previous.length && !d.at) d.at = new Date().toISOString();
    if (!Number.isFinite(Date.parse(d.at))) throw Error('Нет времени решения.');
  }
  return entries.filter(d => d.version === s.version && d.kind === 'dismiss' && rows.some(j => j.id === d.job_id));
}
function materialSeen(w, s, p, j) {
  if (j.who !== 'grok' || !s.material?.length) return true;
  const files = p.material || s.material;
  if (files.some(f => !s.material.includes(f))) throw Error('Файл части должен входить в material этапа.');
  return files.every(f => {
    const hash = sha(fs.readFileSync(path.resolve(w.folder || require('./paths').repoRoot, f)));
    return new RegExp('(^|[^a-fA-F0-9])' + hash + '([^a-fA-F0-9]|$)', 'i').test(g().task(j));
  });
}
async function evaluate(w, s, old, jobs, snapshot) {
  const messages = [], wantsAccept = s.state === 'принят' || !!s.criterion_met;
  const action = wantsAccept || s.state === 'выдан без принятия' || s.fresh_review_file || s.override || s.one_family || s.decisions?.length;
  if (!s.level || !s.author) { if (action) throw Error('Нужны level и author.'); return ''; }
  if (!['мелочь', 'обычный', 'высокий'].includes(s.level)) throw Error('Неизвестный level.');
  jobs = jobs.filter(j => j.who !== 'grok');
  const ps = parts(s), v = g().version(w, s);
  s.gate ||= { files: [], reasons: [] };
  // Принадлежность старых решений переживает обновление текущих голосов.
  s.gate.historicGrokIds = [...new Set([...(old?.gate?.historicGrokIds || []), ...(s.gate.historicGrokIds || []),
    ...[...(old?.gate?.votes || []), ...(s.gate.votes || [])].filter(v => v.who === 'grok').map(v => v.id)])];
  const changed = old?.state === 'принят' && (old.version !== v || ['title', 'accept_criteria', 'source_jobs', 'partial_sources', 'author', 'material', 'artifact_manifest'].some(k => JSON.stringify(old[k]) !== JSON.stringify(s[k])));
  s.version = v;
  const linked = jobs.filter(j => g().belongs(j, w, s));
  if (linked.some(j => j.role === 'проверка')) s.gate.locked = true;
  if (s.fresh_review_file) {
    messages.push(g().registerFile(w, s, s.fresh_review_file, v));
    delete s.fresh_review_file;
  }
  if (changed) { s.state = 'идёт'; return 'Этап изменён после «принят» — снова не принят.'; }
  if (!action) return messages.join('\n');
  const partialNotes = sources(w, s, jobs, ps, snapshot);
  messages.push(...partialNotes);
  // Частичный результат готовым не объявляется: в evidence принятого этапа — «частичный результат <кто>, поручение <номер>».
  if (wantsAccept && partialNotes.some(n => !String(s.evidence || '').includes(n)))
    throw Error('В evidence укажите: ' + partialNotes.filter(n => !String(s.evidence || '').includes(n)).join('; ') + '.');
  if (ps.some(p => p.families.includes('anthropic'))) messages.push(s.continuation ? 'авторство anthropic — по снимку запасного режима' : 'авторство anthropic заявлено Claude');
  // team-v19 К4 (б), К4 «высокий» — в common/stage-gate.js до выбора версии правил (Codex 1c35bf39 п. 5).
  // К4 (а′): отклонение без пересмотра на части, где все авторы anthropic, — «особое мнение» только у Claude вне режима:
  // вызов не от дирижёра и решение записано вне режима (время нового решения ставит сервер — normalize).
  const byConductor = !!require('./fallback').caller();
  const lenient = (p, d) => p.families.every(f => f === 'anthropic') && !byConductor && !require('./user-word').mode(Date.parse(d.at)).active;
  const history = [];
  for (const j of linked.filter(j => j.role === 'проверка' && j.status === 'done' && !j.cancelled && !g().hasVersion(g().task(j), v))) {
    try { history.push(g().reviewed(j, false, snapshot)); }
    catch (e) { messages.push(j.id + ': прошлая проверка пропущена: ' + e.message); }
  }
  const historicIds = new Set(s.gate.historicGrokIds);
  const ids = (s.reviews || []).filter(id => !historicIds.has(id));
  if (new Set(ids).size !== ids.length) throw Error('Одно поручение дважды в reviews.');
  for (const id of ids) if (jobs.some(j => j.id === id) && !linked.some(j => j.id === id)) throw Error(id + ': поручение другой работы или этапа.');
  const rows = g().currentRows(w, s, jobs, v, ids, snapshot).filter(j => j.who !== 'fresh' || !/^(?:replacement|замена):\s*grok\s*$/m.test(j.reviewText)).map(j => j.who === 'fresh' ? fresh(j) : j);
  if (wantsAccept && !rows.length) throw Error('Принятие требует reviews — готовые поручения проверки.');
  if (rows.some(j => j.who !== 'fresh' && j.replaces)) throw Error('В версии 15 замена — только помощник с чистой памятью.');
  const dismissals = decisions(s, old, rows), missing = [], negatives = [], unfilled = [];
  s.gate.availability = Object.keys(seats).flatMap(who => {
    const last = latestSent(linked.filter(j => j.who === who && j.role === 'проверка' && g().hasVersion(g().task(j), v)));
    if (!last) return [];
    if (last.status !== 'done') messages.push(who + ': ' + (require('./states')[last.status] || last.status) + ' · поручение ' + last.id);
    return [{ who, job_id: last.id, status: last.status }];
  });
  for (const p of ps) {
    const label = p.part || 'этап';
    const candidates = Object.values(seats).filter(f => !p.families.includes(f));
    const needed = Math.max(1, candidates.length);
    const mixedSeat = false;
    const applicable = rows.filter(j => covers(j, p, ps));
    const regular = applicable.filter(j => j.who !== 'fresh' && j.role === 'проверка' && seats[j.who] === j.family && candidates.includes(j.family) && materialSeen(w, s, p, j));
    for (const j of applicable.filter(j => j.who === 'grok' && !materialSeen(w, s, p, j))) messages.push(label + ': Grok совещательный — в поручении нет sha256 каждого файла части');
    const latest = new Map();
    for (const j of regular) latest.set(j.family, j);
    const savedHelpers = applicable.filter(j => j.who === 'fresh');
    const helpers = byConductor ? [] : savedHelpers;
    const replacements = [];
    const latestHelpers = new Map();
    for (const h of helpers.filter(h => h.replacement)) latestHelpers.set(h.replacement, h);
    for (const h of latestHelpers.values()) {

      if (mixedSeat && h.replacement === 'mixed') { replacements.push(h); messages.push(label + ': помощник по смешанному авторству'); continue; }
      if (p.families.includes('anthropic') || candidates.length !== 1 || !candidates.includes(seats[h.replacement]))
        throw Error('Помощник не может занять это место замены: ' + label);
      const lastJob = latestSent(linked.filter(j => j.who === h.replacement && j.role === 'проверка' && g().hasVersion(g().task(j), v)));
      if (lastJob?.status === 'done' && regular.some(j => j.id === lastJob.id)) {
        messages.push(label + ': заменённый проверяющий вернулся: ' + h.replacement);
        continue;
      }
      unavailable(w, s, h.replacement, h.evidence, jobs, dismissals, require('./user-word').ms(h.at), p.families);
      replacements.push(h); messages.push(label + ': замена ' + h.replacement + ', доказательство ' + (/^word-/.test(h.evidence || '') ? 'слово пользователя ' : '') + h.evidence);
    }
    if (replacements.length > 1) throw Error('Помощники одной семьи не заполняют два обязательных места.');
    // Отказ снимает только следующий положительный ответ того же участника.
    const unresolved = regular.filter(j => j.count && !regular.some(n => n.who === j.who && !n.count && g().compare(n, j) > 0));
    for (const j of unresolved) {
      const d = dismissals.find(d => d.job_id === j.id);
      const reconsidered = d && regular.some(n => n.who === j.who && !n.count && g().at(n) > Date.parse(d.at) &&
        g().task(n).includes(d.job_id) && g().task(n).includes(d.reason));
      const replaced = d && replacements.some(h => h.replacement === j.who && !h.count);
      if (d && lenient(p, d)) messages.push('особое мнение: отклонено с причиной ' + j.who + ': ' + d.reason);
      else if (!reconsidered && !replaced) negatives.push({ j, label, reason: d ? 'отклонено, ждёт пересмотра' : 'открыто' });
    }
    // Если отказ отклонён, положительный ответ без причины в поручении не считается пересмотром.
    for (const d of dismissals) {
      const j = regular.find(j => j.id === d.job_id);
      if (!j || lenient(p, d)) continue;
      if (!regular.some(n => n.who === j.who && !n.count && g().at(n) > Date.parse(d.at) && g().task(n).includes(j.id) && g().task(n).includes(d.reason)) &&
          !replacements.some(h => h.replacement === j.who && !h.count) && !negatives.some(n => n.j.id === j.id))
        negatives.push({ j, label, reason: 'отклонено, ждёт пересмотра' });
    }
    const approved = new Set([...latest.values()].filter(j => !j.count).map(j => j.family));
    const replacement = replacements.at(-1);
    if (candidates.length + (mixedSeat ? 1 : 0) < needed || latest.size + (replacement ? 1 : 0) < needed) unfilled.push(label);
    if (replacement && !replacement.count) approved.add('anthropic');
    if (candidates.length + (mixedSeat ? 1 : 0) < needed) missing.push(label + (needed === 1 ? ': нет проверяющего другой семьи' : ': нет двух проверяющих другой семьи'));
    else if (approved.size < needed) missing.push(label + (needed === 1 ? ': нужно ПРИНЯТО другой семьи' : ': нужны два ПРИНЯТО разных семей'));
    if (replacement?.count) negatives.push({ j: replacement, label, reason: 'отказ помощника на месте замены' });
    if (s.level === 'высокий') {
      const extra = savedHelpers.filter(h => !h.replacement && h.hash !== replacement?.hash).at(-1);
      if (!extra || byConductor) missing.push(label + ': нужен дополнительный отдельный файл помощника');
      // В запасном режиме помощник не заполняет место, но сохранённый отказ действует.
      if (extra?.count) negatives.push({ j: extra, label, reason: 'отказ дополнительного помощника' });
    }
    for (const previous of history) {
      if (previous.count && candidates.includes(previous.family) && covers(previous, p, ps) &&
          !regular.some(n => n.who === previous.who && !n.count) &&
          (p.families.every(f => f === 'anthropic') || replacements.some(h => h.replacement === previous.who && !h.count)))
        messages.push('особое мнение: исправлено без подтверждения ' + previous.who + ', ' + previous.id);
    }
  }
  const problems = [...missing, ...negatives.map(n => n.label + ': НЕ ПРИНЯТО ' + n.j.who + ' — ' + n.reason)];
  if (s.level === 'высокий' && negatives.some(n => n.j.who === 'fresh' && !n.j.replacement) &&
      (s.override || s.one_family || s.state === 'выдан без принятия'))
    throw Error('Высокий риск: отказ дополнительного помощника останавливает выдачу.');
  if (s.override || s.one_family || (s.state === 'выдан без принятия' && old?.state !== 'выдан без принятия')) {
    const o = s.override;
    if (o?.by === 'claude' && o.reason?.trim() && o.criterion && !problems.length) {
      s.gate.criterion = o.reason;
    } else if (o?.by === 'claude' && o.reason?.trim() && !unfilled.length && negatives.length) {
      const allReviews = [...history, ...rows.filter(j => j.who !== 'fresh' && j.role === 'проверка')];
      if (negatives.some(n => allReviews.filter(j => j.who === n.j.who && j.count).length < 2)) throw Error('Выдача Claude требует двух отрицательных ответов обязательного проверяющего.');
    } else if (o?.by !== 'user' || !o.quote?.trim()) throw Error('Выдан без принятия требует решения пользователя с цитатой.');
    s.state = 'выдан без принятия';
    s.gate.issued = 'выдан без принятия: ' + (o.by === 'user' ? o.quote + ' — заявлено Claude' : o.reason);
    messages.push(s.gate.issued);
  } else if (problems.length) {
    if (old?.state === 'принят' && negatives.length) {
      s.state = 'идёт'; messages.push('запоздалый отказ: ' + [...new Set(negatives.map(n => n.j.who))].join(', '));
    } else if (wantsAccept) throw Error('Этап не принят: ' + problems.join('; '));
  } else if (wantsAccept || (old?.state === 'идёт' && old.gate?.lateVersion === v)) {
    if (s.gate.criterion && !s.criterion_met) s.state = 'выдан без принятия';
    else s.state = 'принят';
  }
  if (old?.state === 'принят' && negatives.length) s.gate.lateVersion = v;
  if (s.criterion_met) {
    if (!s.criterion_met.reason?.trim() || problems.length) throw Error('criterion_met требует причину и все текущие ПРИНЯТО.');
    delete s.gate.criterion;
  }
  if (s.artifact_manifest && s.state === 'принят') s.artifact_verification = g().checkArtifacts(w, s);
  s.gate.reasons = problems;
  if (s.state === 'выдан без принятия' && s.gate.issued) s.gate.reasons.push(s.gate.issued);
  for (const h of rows.filter(j => j.who === 'fresh' && j.replacement)) {
    if (!(s.decisions || []).some(d => d.kind === 'replace' && d.file_hash === h.hash))
      (s.decisions ||= []).push({ kind: 'replace', version: v, reason: h.replacement === 'mixed' ? 'смешанное авторство'
        : /^word-/.test(h.evidence || '') ? 'недоступность по слову пользователя' : 'недоступность по хранилищу',
        replacement: h.replacement, ...(h.evidence ? { evidence: h.evidence } : {}), ...(/^word-/.test(h.evidence || '') ? { word_id: h.evidence } : {}),
        family: h.family, model: h.model, file_hash: h.hash, at: new Date().toISOString() });
  }
  for (const d of dismissals) {
    const original = rows.find(j => j.id === d.job_id);
    for (const r of rows.filter(j => j.who === original.who && j.id !== original.id && g().at(j) > Date.parse(d.at) &&
        g().task(j).includes(d.job_id) && g().task(j).includes(d.reason))) {
      if (!(s.decisions || []).some(x => x.kind === 'reconsider' && x.review_job_id === r.id))
        (s.decisions ||= []).push({ kind: 'reconsider', version: v, job_id: d.job_id, review_job_id: r.id,
          reason: d.reason, outcome: r.count ? 'повторный блокирующий отказ' : 'пересмотрено и принято', at: new Date().toISOString() });
    }
  }
  s.gate.votes = rows.map(j => ({ id: j.id, who: j.who, family: j.family, model: j.model, count: j.count, version: v }));
  messages.push(...problems);
  if (rows.some(j => j.who === 'fresh')) messages.push('место помощника с чистой памятью заполнено файлом Claude; сервер его не проверял');
  if (!s.material?.length) messages.push('версия заявлена Claude; сервер её не вычислял');
  delete s.override; delete s.one_family; delete s.criterion_met;
  return messages.join('\n');
}
module.exports = { parts, sources, fresh, latestSent, unavailable, decisions, evaluate };
