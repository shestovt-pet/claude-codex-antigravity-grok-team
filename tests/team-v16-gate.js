'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { gate, stores, sha, project, write, json, fixture, job, fresh, dismiss, accept, run } = require('./team-v16-fixture');
const tests = [], test = (n, f) => tests.push([n, f]);
function google(opts = {}) {
  const f = fixture({ author: { family: 'google', model: 'gemini' }, ...opts });
  job(f, 'antigravity', 0, { role: 'текст' }); return f;
}
function helper(f, id, who = 'codex') { return fresh(f, 'замена: ' + who + '\nдоказательство: ' + id); }
// team-v18 К5, К8 (случаи 19, 20): слово пользователя как доказательство недоступности и частичный результат выпавшего.
// Стоят первыми: окно «после слова» не должно задеть поручения прошлых испытаний с отметками времени в будущем.
const words = require('../common/user-word');
const wordFor = async who => (await words.record({ who_down: who, quote: who + ' отвалился' })).record;
for (const [who, author, text, reviewer] of [['codex', 'google', 'antigravity', 'antigravity'], ['antigravity', 'openai', 'codex', 'codex']])
  test('К5, В5 ' + who + ': действующее слово — доказательство недоступности для помощника на месте замены; id слова в журнале решений', async () => {
    const f = fixture({ author: { family: author, model: author } });
    job(f, text, 0, { role: 'текст' }); job(f, reviewer);
    const w = await wordFor(who); helper(f, w.id, who);
    assert.match(await accept(f), new RegExp('замена ' + who + ', доказательство слово пользователя ' + w.id));
    assert.equal(f.s.state, 'принят');
    const d = f.s.decisions.find(d => d.kind === 'replace');
    assert.equal(d.word_id, w.id); assert.equal(d.evidence, w.id); assert.equal(d.reason, 'недоступность по слову пользователя');
  });
test('К5: слово, записанное после файла помощника или истёкшее к его регистрации, недоступность не доказывает', async () => {
  const f = google(), file = helper(f, 'word-pending');
  await new Promise(r => setTimeout(r, 20));
  const late = await wordFor('codex');
  const s = f.s.gate.files.find(x => x.path === fs.realpathSync(file));
  s.reviewText = s.reviewText.replace('word-pending', late.id); s.hash = sha(s.reviewText);
  await assert.rejects(accept(f), /Нет действующего слова/);
  const g = google(), old = { id: 'word-' + require('crypto').randomUUID(), at: new Date(Date.now() - 25 * 3600000).toISOString(), who_down: 'codex', quote: 'старое', source: 'chat-claude', recorded_by: 'claude' };
  fs.appendFileSync(words.file(), JSON.stringify(old) + '\n');
  helper(g, old.id); await assert.rejects(accept(g), /Нет действующего слова/);
});
test('Antigravity mv5y4jpo п. 1–2: слово, записанное через team_word (другая папка карточек Team), находят ворота этапа; время решения ISO-строкой', async () => {
  const { Team } = require('../common/team'), fx = require('./team-v16-fixture');
  await new Team(fx.root, path.join(fx.RUN, 'cards-elsewhere')).word({ action: 'record', who_down: 'codex', quote: 'грок отвалился' });
  const w = words.read().at(-1);
  assert(w && w.quote === 'грок отвалился', 'журнал один для team_word и ворот');
  const f = google(); helper(f, w.id);
  assert.match(await accept(f), new RegExp('доказательство слово пользователя ' + w.id));
  const v15 = require('../common/stage-gate-v15');
  assert.equal(v15.unavailable(f.w, f.s, 'codex', w.id, gate.allJobs(), [], new Date(Date.parse(w.at) + 10).toISOString()).id, w.id);
});
test('19, К5: после отклонённого замечания слово о том же проверяющем не доказывает недоступность; отказ до слова в силе', async () => {
  const f = google(), no = job(f, 'codex', 1); dismiss(f, no);
  helper(f, (await wordFor('codex')).id);
  await assert.rejects(accept(f), /пересмотр/);
  const g = google(); job(g, 'codex', 1);
  helper(g, (await wordFor('codex')).id);
  await assert.rejects(accept(g), /НЕ ПРИНЯТО codex/);
});
for (const [who, family, reviewers] of [['codex', 'openai', ['antigravity', 'codex']], ['antigravity', 'google', ['codex', 'codex']]])
  test('20, К8, В5 ' + who + ': частичный результат выпавшего — авторы ' + family + ' и anthropic подтверждены, проверяет внешняя семья; ошибки — отказ', async () => {
    const file = path.join(project, 'partial-' + who + '.txt'), extra = path.join(project, 'partial-extra-' + who + '.txt');
    write(file, 'частичный текст ' + who); write(extra, 'другой файл');
    const authors = [{ family, model: family }, { family: 'anthropic', model: 'claude' }];
    const f = fixture({ author: [{ part: 'Глава', authors }], material: [file] });
    const w = await wordFor(who);
    const cancelled = job(f, who, 0, { role: 'текст', status: 'cancelled', task: 'Глава' });
    for (const r of reviewers) job(f, r, 0, { task: 'version: ' + f.s.version + '\n' + sha(fs.readFileSync(file)) });
    const good = { job_id: cancelled, family, file, sha256: sha(fs.readFileSync(file)), word_id: w.id, part: 'Глава' };
    const note = 'частичный результат ' + who + ', поручение ' + cancelled;
    const reject = async (entry, pattern, evidence = note) => { f.s.state = 'план'; await assert.rejects(accept(f, { partial_sources: [entry], evidence }), pattern); };
    await reject({ ...good, sha256: 'f'.repeat(64) }, /sha256/);
    await reject({ ...good, family: family === 'openai' ? 'google' : 'openai' }, /семья/);
    await reject({ ...good, file: path.join(require('./team-v16-fixture').RUN, 'outside.txt') }, /вне папки работы/);
    await reject({ ...good, file: extra, sha256: sha(fs.readFileSync(extra)) }, /не входит в material/);
    await reject({ ...good, job_id: job(f, who, 0, { role: 'текст', task: 'Глава' }) }, /только отменённое/);
    await reject({ ...good, job_id: job({ w: { name: 'other-work' }, s: f.s }, who, 0, { role: 'текст', status: 'cancelled', task: 'Глава' }) }, /этой работы/);
    await reject({ ...good, job_id: job(f, who, 0, { role: 'проверка', status: 'cancelled', task: 'Глава' }) }, /авторская роль/);
    await reject({ ...good, word_id: undefined }, /word_id/);
    await reject({ ...good, job_id: job(f, who, 0, { role: 'текст', status: 'cancelled', task: 'Глава', finishedAt: new Date(Date.now() - 60000).toISOString() }) }, /после отмены/);
    await reject({ ...good, part: undefined }, /укажите часть/);
    await reject(good, /В evidence укажите/, 'готово');
    // Codex f1d4ae25, Codex 59418d74 п. 2: время остановки — самая ранняя отметка; без отметок время не доказано.
    const untimed = job(f, who, 0, { role: 'текст', status: 'cancelled', task: 'Глава', finishedAt: undefined });
    await reject({ ...good, job_id: untimed }, /нет отметки времени остановки/);
    const between = job(f, who, 0, { role: 'текст', status: 'cancelled', task: 'Глава', cancellingAt: new Date(Date.parse(w.at) - 1000).toISOString(),
      finishedAt: new Date(Date.parse(w.at) + 1000).toISOString() });
    await reject({ ...good, job_id: between }, /слово записано после отмены/);
    const lost = job(f, who, 0, { role: 'текст', status: 'lost', task: 'Глава', finishedAt: undefined, lostAt: new Date(Date.parse(w.at) + 1000).toISOString() });
    const second = { ...good, job_id: lost }, note2 = 'частичный результат ' + who + ', поручение ' + lost;
    f.s.state = 'план';
    const message = await accept(f, { partial_sources: [good, second], evidence: 'проверено; ' + note + '; ' + note2 });
    assert.equal(f.s.state, 'принят'); assert(message.includes(note) && message.includes(note2), message);
    const parsed = require('zod').z.object(require('../common/stage-schema').stage).parse({ partial_sources: [good] });
    assert.deepEqual(parsed.partial_sources, [good]);
    assert.throws(() => require('zod').z.object(require('../common/stage-schema').stage).parse({ partial_sources: [{ ...good, word_id: undefined }] }));
  });
test('1, 2, 14, 16: невнесённый отказ блокирует; причина сохраняет хеш и положительные голоса', async () => {
  const f = fixture(), a = job(f), b = job(f, 'antigravity'), no = job(f, 'codex', 1);
  const version = f.s.version;
  await assert.rejects(accept(f, { reviews: [a, b] }), /НЕ ПРИНЯТО codex/);
  dismiss(f, no); job(f, 'codex');
  await accept(f, { reviews: [a, b] });
  assert.equal(f.s.version, version); assert.equal(f.s.state, 'принят');
});
test('3, 6, 9: одно принятие, помощник при авторе Claude и две сессии одной семьи', async () => {
  const f = fixture(); job(f, 'antigravity'); job(f, 'antigravity'); fresh(f);
  await assert.rejects(accept(f), /два ПРИНЯТО/);
  const lost = job(f, 'codex', 0, { status: 'lost' }); helper(f, lost);
  await assert.rejects(accept(f), /не может занять/);
});
test('4: один lost Codex и помощник принимают работу Gemini', async () => {
  const f = google(), lost = job(f, 'codex', 0, { status: 'lost' }); helper(f, lost);
  assert.match(await accept(f), /замена codex/); assert.equal(f.s.state, 'принят');
});
test('5: отклонённый отказ ждёт пересмотра того же проверяющего с причиной', async () => {
  const f = google(), no = job(f, 'codex', 1), d = dismiss(f, no);
  await assert.rejects(accept(f), /ждёт пересмотра/);
  job(f, 'codex'); await assert.rejects(accept(f), /ждёт пересмотра/);
  job(f, 'codex', 0, { task: f.s.version + '\n' + no + '\n' + d.reason });
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('5б: повторный блокирующий отказ не принимается', async () => {
  const f = google(), no = job(f, 'codex', 1), d = dismiss(f, no);
  job(f, 'codex', 1, { task: f.s.version + '\n' + no + '\n' + d.reason });
  await assert.rejects(accept(f), /НЕ ПРИНЯТО/);
});
test('5в: потерян пересмотр — помощник занимает место', async () => {
  const f = google(), no = job(f, 'codex', 1), d = dismiss(f, no);
  const lost = job(f, 'codex', 0, { status: 'lost', task: f.s.version + '\n' + no + '\n' + d.reason });
  helper(f, lost); assert.match(await accept(f), /замена codex/);
});
test('7: запоздалый отказ у Claude снимает принятие; отклонение возвращает без повторных голосов', async () => {
  const f = fixture(); job(f); job(f, 'antigravity'); await accept(f); const old = structuredClone(f.s);
  const no = job(f, 'codex', 1); assert.match(await gate.evaluate(f.w, f.s, old), /запоздалый отказ/); assert.equal(f.s.state, 'идёт');
  const pending = structuredClone(f.s); dismiss(f, no); job(f, 'codex');
  await gate.evaluate(f.w, f.s, pending); assert.equal(f.s.state, 'принят');
});
test('7б: запоздалый отказ у Gemini остаётся отказом после отклонения', async () => {
  const f = google(); job(f, 'codex'); await accept(f); const old = structuredClone(f.s);
  const no = job(f, 'codex', 1); await gate.evaluate(f.w, f.s, old); assert.equal(f.s.state, 'идёт');
  dismiss(f, no); await assert.rejects(accept(f), /ждёт пересмотра/);
});
test('8: высокий риск требует другой файл дополнительного помощника', async () => {
  const material = path.join(project, 'high.txt'); write(material, 'материал');
  const f = google({ level: 'высокий', material: [material] });
  const lost = job(f, 'codex', 0, { status: 'lost' }), file = helper(f, lost);
  await assert.rejects(accept(f), /дополнительный/);
  assert.throws(() => gate.registerFile(f.w, f.s, file, f.s.version), /уже зарегистрирован/);
  fresh(f); await accept(f); assert.equal(f.s.state, 'принят');
});
test('13: замена без доказательства, неверной семьи или модели не засчитывается', async () => {
  for (const field of ['none', 'family', 'model']) {
    const f = google(); job(f, 'codex', 0, { status: 'running' });
    const p = path.join(project, '.most/reviews', f.w.name + '.txt');
    write(p, 'version: ' + f.s.version + '\nсемья: ' + (field === 'family' ? 'openai' : 'anthropic') + '\n' +
      (field === 'model' ? '' : 'модель: claude-sonnet-4.6\n') + 'замена: codex\nдоказательство: missing\nПРИНЯТО');
    gate.registerFile(f.w, f.s, p, f.s.version);
    await assert.rejects(accept(f), /недоступности|семья anthropic/);
  }
});
test('15: отказ прошлой version найден без reviews, исправлено без подтверждения', async () => {
  const f = fixture(); job(f, 'codex', 1); f.s.version += '-new'; job(f); job(f, 'antigravity');
  assert(!(await accept(f)).includes('исправлено без подтверждения codex'));
});
test('17: старый lost, затем отказ и отклонение — старый lost не доказательство', async () => {
  const f = google(), lost = job(f, 'codex', 0, { status: 'lost' }), no = job(f, 'codex', 1);
  dismiss(f, no); helper(f, lost); await assert.rejects(accept(f), /недоступности|ждёт пересмотра/);
});
for (const status of ['cancelled', 'delivery_unclear', 'running', 'stop_unconfirmed', 'unexpected']) test('18: ' + status + ' не недоступность', async () => {
  const f = google(), id = job(f, 'codex', 0, { status }); helper(f, id); await assert.rejects(accept(f), /недоступности/);
});
test('дополнение: старый сбой при более новом идущем поручении', async () => {
  const f = google(), lost = job(f, 'codex', 0, { status: 'failed' }); job(f, 'codex', 0, { status: 'running' }); helper(f, lost);
  await assert.rejects(accept(f), /недоступности/);
});
function mixed(fs, confirmed = true) {
  const f = fixture({ author: [{ part: 'Общая часть', authors: fs.map(family => ({ family, model: family })) }] });
  if (confirmed) for (const family of fs.filter(f => f !== 'anthropic')) job(f, ({ openai: 'codex', google: 'antigravity', xai: 'codex' })[family], 0,
    { role: 'текст', task: 'Общая часть' });
  return f;
}
test('19: Claude + Codex принимает Gemini', async () => {
  const f = mixed(['anthropic', 'openai']); job(f, 'antigravity'); job(f, 'codex'); assert.match(await accept(f), /авторство anthropic заявлено Claude/);
});
test('20: Claude + двое и ни одного кандидата — только решение пользователя', async () => {
  for (const authors of [['anthropic', 'openai', 'google'], ['openai', 'google']]) {
    const f = mixed(authors); job(f, 'codex'); fresh(f);
    await assert.rejects(accept(f), /нет проверяющего другой семьи/);
    await assert.rejects(accept(f, { one_family: true, reason: 'нет' }), /решения пользователя/);
    await accept(f, { override: { by: 'user', quote: 'Выдать без принятия' } }); assert.equal(f.s.state, 'выдан без принятия');
  }
});
test('дополнение: смешанная Claude + Codex требует только Gemini', async () => {
  const f = mixed(['anthropic', 'openai']); job(f, 'antigravity');
  await accept(f); assert.equal(f.s.state, 'принят');
  const old = structuredClone(f.w);
  Object.assign(f.s, require('zod').z.object(require('../common/stage-schema').stage).parse(f.s));
  gate.normalize(f.w, old); f.s = f.w.stages[0];
  await gate.evaluate(f.w, f.s, old.stages[0]); assert.equal(f.s.state, 'принят');
});
test('дополнение: заявление смешанного авторства без источников места не даёт', async () => {
  const f = mixed(['anthropic', 'openai'], false); job(f, 'antigravity'); fresh(f, 'замена: mixed');
  await assert.rejects(accept(f), /без поручения/);
});
test('21: поздний принятый сервером ответ после lost; поздний отказ после принятия', async () => {
  const f = google(), id = job(f, 'codex', 0, { status: 'lost' });
  const p = path.join(stores.roots().codex, id + '.json'), j = JSON.parse(fs.readFileSync(p));
  json(p, { ...j, status: 'done' }); await accept(f); const old = structuredClone(f.s);
  job(f, 'codex', 1); assert.match(await gate.evaluate(f.w, f.s, old), /запоздалый отказ/);
});
test('дополнение: Две внешние семьи проверяют материал', async () => {
  const material = ['a.txt', 'b.txt'].map(n => path.join(project, n)); material.forEach(f => write(f, f));
  const f = fixture({ material }); job(f); job(f, 'codex');
  await assert.rejects(accept(f), /два ПРИНЯТО/);
  job(f, 'antigravity', 0, { task: 'version: ' + f.s.version + '\n' + material.map(f => sha(fs.readFileSync(f))).join('\n') });
  await accept(f);
});
test('дополнение: недоступность квоты проверяется по карточке retryPlan', async () => {
  const f = google(); const plan = require('../common/quota').retryPlan({}, { kind: 'quota', message: 'quota', resetsAt: new Date(Date.now() + 7200000).toISOString() });
  const id = job(f, 'codex', 0, plan); helper(f, id); await accept(f);
});
test('21б: вернувшийся заменённый Codex освобождает место; поздний отказ снимает принятие', async () => {
  for (const count of [0, 1]) {
    const f = google(), id = job(f, 'codex', count, { status: 'lost' }); helper(f, id); await accept(f);
    const old = structuredClone(f.s), p = path.join(stores.roots().codex, id + '.json'), card = JSON.parse(fs.readFileSync(p));
    json(p, { ...card, status: 'done', finishedAt: new Date(Date.now() + 1000000).toISOString() });
    const text = await gate.evaluate(f.w, f.s, old);
    assert.equal(f.s.state, count ? 'идёт' : 'принят'); if (count) assert.match(text, /запоздалый отказ/);
  }
});
test('журнал v15 через team_work: запись причины восстанавливает принятие, история неизменна', async () => {
  const { Team } = require('../common/team'), { root } = require('./team-v16-fixture');
  const team = new Team(root), name = 'v15-integration';
  await team.work({ action: 'create', name, owner: 'test', expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'проверить',
    stages: [{ title: 'Итог', weight: 100, state: 'план', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'integration-v15' }] });
  let w = JSON.parse(fs.readFileSync(team.workFile(name))), s = w.stages[0]; const f = { w, s };
  const ids = [job(f), job(f, 'antigravity')];
  await team.work({ action: 'update', name, owner: 'test', expected_revision: w.revision, stages: [{ ...s, state: 'принят', evidence: 'проверено', reviews: ids }] });
  w = JSON.parse(fs.readFileSync(team.workFile(name))); assert.equal(w.stages[0].state, 'принят');
  const no = job(f, 'codex', 1); w = await team.refreshWork(team.workFile(name)); assert.equal(w.stages[0].state, 'идёт');
  s = w.stages[0]; const version = s.version; job(f, 'codex');
  const parsed = require('zod').z.object(require('../common/stage-schema').stage).parse({ ...s,
    decisions: [{ kind: 'dismiss', version, job_id: no, reason: 'проверено' }] });
  await team.work({ action: 'update', name, owner: 'test', expected_revision: w.revision, stages: [{ ...s, ...parsed }] });
  w = JSON.parse(fs.readFileSync(team.workFile(name))); s = w.stages[0];
  assert.equal(s.state, 'принят'); assert.equal(s.version, version); assert.deepEqual(s.reviews, ids);
  const roundTrip = require('zod').z.object(require('../common/stage-schema').stage).parse(s);
  await team.work({ action: 'update', name, owner: 'test', expected_revision: w.revision, stages: [{ ...s, ...roundTrip }] });
  w = JSON.parse(fs.readFileSync(team.workFile(name))); s = w.stages[0]; assert.equal(s.state, 'принят');
  await assert.rejects(team.work({ action: 'update', name, owner: 'test', expected_revision: w.revision,
    stages: [{ ...s, decisions: [] }] }), /Журнал решений неизменяем/);
});
test('выдача и критерий не превращаются в принятие при повторном чтении', async () => {
  const f = fixture(); job(f); job(f, 'antigravity');
  await accept(f, { override: { by: 'claude', criterion: true, reason: 'не проведена живая проверка' } });
  assert.equal(f.s.state, 'выдан без принятия');
  await gate.evaluate(f.w, f.s, structuredClone(f.s)); assert.equal(f.s.state, 'выдан без принятия');
  await accept(f); assert.equal(f.s.state, 'выдан без принятия');
  await accept(f, { criterion_met: { reason: 'проверено' } }); assert.equal(f.s.state, 'принят');
});
test('Б1: мелочь исключает каждую семью соавтора, одной внешней достаточно', async () => {
  for (const authors of [['anthropic', 'google'], ['anthropic', 'openai']]) {
    const f = mixed(authors); f.s.level = 'мелочь';
    job(f, authors[1] === 'google' ? 'antigravity' : 'codex');
    await assert.rejects(accept(f), /ПРИНЯТО другой семьи/);
    job(f, authors[1] === 'google' ? 'codex' : 'antigravity'); await accept(f); assert.equal(f.s.state, 'принят');
  }
});
test('Б2: непригодные старые отзывы не мешают принятию и выдаче, номер указан', async () => {
  for (const bad of ['verdict', 'family']) for (const issued of [false, true]) {
    const f = fixture(), id = job(f, 'antigravity', 0, bad === 'family' ? {model: 'unknown-model'} : {});
    if (bad === 'verdict') {
      const dir = path.join(stores.roots().antigravity, id), text = 'Нестрогий итог';
      write(path.join(dir, 'result.txt'), text); json(path.join(dir, 'meta.json'), {hash: sha(text)});
    }
    f.s.version += '-next'; job(f); job(f, 'antigravity');
    const message = await accept(f, issued ? {override: {by: 'user', quote: 'Выдать без принятия'}} : {});
    assert(message.includes(id + ': прошлая проверка пропущена:'));
    assert.equal(f.s.state, issued ? 'выдан без принятия' : 'принят');
  }
});
test('Б3: заявление Claude не освобождает соавтора от подтверждения текстом', async () => {
  const f = mixed(['anthropic', 'openai'], false); job(f, 'antigravity'); job(f, 'codex');
  await assert.rejects(accept(f), /без поручения.*openai/);
});
test('Н1: prepareJob запрещает replaces на мелочи v15 до отправки', async () => {
  const {root} = require('./team-v16-fixture'), f = fixture({level: 'мелочь'});
  f.w.owner = 'test'; json(path.join(root, 'works', f.w.name + '.json'), f.w);
  await assert.rejects(gate.prepareJob({work: f.w.name, stage: f.s.id, owner: 'test', role: 'проверка',
    task: f.s.version, replaces: {who: 'codex', reason: 'авария'}}, 'codex', root), /В версии 15 место замены/);
  job(f); job(f, 'antigravity'); await accept(f); assert.equal(f.s.state, 'принят');
});
test('Н2: неучтённая замена помощником на мелочи не попадает в журнал', async () => {
  const f = fixture({level: 'мелочь'}); job(f); job(f, 'antigravity'); fresh(f, 'замена: grok\nдоказательство: missing');
  await accept(f); assert(!(f.s.decisions || []).some(d => d.kind === 'replace'));
});
test('Н4: отрицательный совет не является вторым отказом для выдачи Claude', async () => {
  const f = fixture(); job(f, 'codex', 1); job(f, 'codex', 1, {role: 'совет'}); job(f, 'antigravity');
  await assert.rejects(accept(f, {override: {by: 'claude', reason: 'выдать'}}), /двух отрицательных/);
  job(f, 'codex', 1);
  await accept(f, {override: {by: 'claude', reason: 'выдать'}}); assert.equal(f.s.state, 'выдан без принятия');
});

run(tests);
