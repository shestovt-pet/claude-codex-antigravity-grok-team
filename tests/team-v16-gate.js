'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { gate, stores, sha, project, write, json, fixture, job, fresh, dismiss, accept, run } = require('./team-v16-fixture');
const tests = [], test = (n, f) => tests.push([n, f]);
function google(opts = {}) {
  const f = fixture({ author: { family: 'google', model: 'gemini' }, ...opts });
  job(f, 'antigravity', 0, { role: 'текст' }); job(f); return f;
}
function helper(f, id, who = 'grok') { return fresh(f, 'замена: ' + who + '\nдоказательство: ' + id); }
test('1, 2, 14, 16: невнесённый отказ блокирует; причина сохраняет хеш и положительные голоса', async () => {
  const f = fixture(), a = job(f), b = job(f, 'antigravity'), no = job(f, 'grok', 1);
  const version = f.s.version;
  await assert.rejects(accept(f, { reviews: [a, b] }), /НЕ ПРИНЯТО grok/);
  dismiss(f, no);
  assert.match(await accept(f, { reviews: [a, b] }), /особое мнение/);
  assert.equal(f.s.version, version); assert.equal(f.s.state, 'принят');
});
test('3, 6, 9: одно принятие, помощник при авторе Claude и две сессии одной семьи', async () => {
  const f = fixture(); job(f, 'antigravity'); job(f, 'antigravity'); fresh(f);
  await assert.rejects(accept(f), /два ПРИНЯТО/);
  const lost = job(f, 'grok', 0, { status: 'lost' }); helper(f, lost);
  await assert.rejects(accept(f), /не может занять/);
});
test('4: один lost Grok и помощник принимают работу Gemini', async () => {
  const f = google(), lost = job(f, 'grok', 0, { status: 'lost' }); helper(f, lost);
  assert.match(await accept(f), /замена grok/); assert.equal(f.s.state, 'принят');
});
test('5: отклонённый отказ ждёт пересмотра того же проверяющего с причиной', async () => {
  const f = google(), no = job(f, 'grok', 1), d = dismiss(f, no);
  await assert.rejects(accept(f), /ждёт пересмотра/);
  job(f, 'grok'); await assert.rejects(accept(f), /ждёт пересмотра/);
  job(f, 'grok', 0, { task: f.s.version + '\n' + no + '\n' + d.reason });
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('5б: повторный блокирующий отказ не принимается', async () => {
  const f = google(), no = job(f, 'grok', 1), d = dismiss(f, no);
  job(f, 'grok', 1, { task: f.s.version + '\n' + no + '\n' + d.reason });
  await assert.rejects(accept(f), /НЕ ПРИНЯТО/);
});
test('5в: потерян пересмотр — помощник занимает место', async () => {
  const f = google(), no = job(f, 'grok', 1), d = dismiss(f, no);
  const lost = job(f, 'grok', 0, { status: 'lost', task: f.s.version + '\n' + no + '\n' + d.reason });
  helper(f, lost); assert.match(await accept(f), /замена grok/);
});
test('7: запоздалый отказ у Claude снимает принятие; отклонение возвращает без повторных голосов', async () => {
  const f = fixture(); job(f); job(f, 'antigravity'); await accept(f); const old = structuredClone(f.s);
  const no = job(f, 'grok', 1); assert.match(await gate.evaluate(f.w, f.s, old), /запоздалый отказ/); assert.equal(f.s.state, 'идёт');
  const pending = structuredClone(f.s); dismiss(f, no);
  await gate.evaluate(f.w, f.s, pending); assert.equal(f.s.state, 'принят');
});
test('7б: запоздалый отказ у Gemini остаётся отказом после отклонения', async () => {
  const f = google(); job(f, 'grok'); await accept(f); const old = structuredClone(f.s);
  const no = job(f, 'grok', 1); await gate.evaluate(f.w, f.s, old); assert.equal(f.s.state, 'идёт');
  dismiss(f, no); await assert.rejects(accept(f), /ждёт пересмотра/);
});
test('8: высокий риск требует другой файл дополнительного помощника', async () => {
  const material = path.join(project, 'high.txt'); write(material, 'материал');
  const f = google({ level: 'высокий', material: [material] });
  const lost = job(f, 'grok', 0, { status: 'lost' }), file = helper(f, lost);
  await assert.rejects(accept(f), /дополнительный/);
  assert.throws(() => gate.registerFile(f.w, f.s, file, f.s.version), /уже зарегистрирован/);
  fresh(f); await accept(f); assert.equal(f.s.state, 'принят');
});
test('13: замена без доказательства, неверной семьи или модели не засчитывается', async () => {
  for (const field of ['none', 'family', 'model']) {
    const f = google(); job(f, 'grok', 0, { status: 'running' });
    const p = path.join(project, '.most/reviews', f.w.name + '.txt');
    write(p, 'version: ' + f.s.version + '\nсемья: ' + (field === 'family' ? 'openai' : 'anthropic') + '\n' +
      (field === 'model' ? '' : 'модель: claude-opus-4.6\n') + 'замена: grok\nдоказательство: missing\nПРИНЯТО');
    gate.registerFile(f.w, f.s, p, f.s.version);
    await assert.rejects(accept(f), /недоступности|семья anthropic/);
  }
});
test('15: отказ прошлой version найден без reviews, исправлено без подтверждения', async () => {
  const f = fixture(); job(f, 'grok', 1); f.s.version += '-new'; job(f); job(f, 'antigravity');
  assert.match(await accept(f), /исправлено без подтверждения grok/);
});
test('17: старый lost, затем отказ и отклонение — старый lost не доказательство', async () => {
  const f = google(), lost = job(f, 'grok', 0, { status: 'lost' }), no = job(f, 'grok', 1);
  dismiss(f, no); helper(f, lost); await assert.rejects(accept(f), /недоступности|ждёт пересмотра/);
});
for (const status of ['cancelled', 'delivery_unclear', 'running', 'stop_unconfirmed', 'unexpected']) test('18: ' + status + ' не недоступность', async () => {
  const f = google(), id = job(f, 'grok', 0, { status }); helper(f, id); await assert.rejects(accept(f), /недоступности/);
});
test('дополнение: старый сбой при более новом идущем поручении', async () => {
  const f = google(), lost = job(f, 'grok', 0, { status: 'failed' }); job(f, 'grok', 0, { status: 'running' }); helper(f, lost);
  await assert.rejects(accept(f), /недоступности/);
});
function mixed(fs, confirmed = true) {
  const f = fixture({ author: [{ part: 'Общая часть', authors: fs.map(family => ({ family, model: family })) }] });
  if (confirmed) for (const family of fs.filter(f => f !== 'anthropic')) job(f, ({ openai: 'codex', google: 'antigravity', xai: 'grok' })[family], 0,
    { role: 'текст', task: 'Общая часть' });
  return f;
}
test('19: Claude + Codex принимают Gemini и Grok', async () => {
  const f = mixed(['anthropic', 'openai']); job(f, 'antigravity'); job(f, 'grok'); assert.match(await accept(f), /авторство anthropic заявлено Claude/);
});
test('20: Claude + двое и ни одного кандидата — только решение пользователя', async () => {
  for (const authors of [['anthropic', 'openai', 'google'], ['openai', 'google', 'xai']]) {
    const f = mixed(authors); job(f, 'grok'); fresh(f);
    await assert.rejects(accept(f), /нет двух проверяющих/);
    await assert.rejects(accept(f, { one_family: true, reason: 'нет' }), /решения пользователя/);
    await accept(f, { override: { by: 'user', quote: 'Выдать без принятия' } }); assert.equal(f.s.state, 'выдан без принятия');
  }
});
test('дополнение: смешанная Codex + Grok с помощником без аварии', async () => {
  const f = mixed(['openai', 'xai']); job(f, 'antigravity'); fresh(f, 'замена: mixed');
  assert.match(await accept(f), /смешанному авторству/);
  const old = structuredClone(f.w);
  Object.assign(f.s, require('zod').z.object(require('../common/stage-schema').stage).parse(f.s));
  gate.normalize(f.w, old); f.s = f.w.stages[0];
  await gate.evaluate(f.w, f.s, old.stages[0]); assert.equal(f.s.state, 'принят');
});
test('дополнение: заявление смешанного авторства без источников места не даёт', async () => {
  const f = mixed(['openai', 'xai'], false); job(f, 'antigravity'); fresh(f, 'замена: mixed');
  await assert.rejects(accept(f), /без поручения/);
});
test('21: поздний принятый сервером ответ после lost; поздний отказ после принятия', async () => {
  const f = google(), id = job(f, 'grok', 0, { status: 'lost' });
  const p = path.join(stores.roots().grok, id + '.json'), j = JSON.parse(fs.readFileSync(p));
  json(p, { ...j, status: 'done' }); await accept(f); const old = structuredClone(f.s);
  job(f, 'grok', 1); assert.match(await gate.evaluate(f.w, f.s, old), /запоздалый отказ/);
});
test('дополнение: Grok по material только с sha256 всех файлов части', async () => {
  const material = ['a.txt', 'b.txt'].map(n => path.join(project, n)); material.forEach(f => write(f, f));
  const f = fixture({ material }); job(f); job(f, 'grok');
  await assert.rejects(accept(f), /два ПРИНЯТО/);
  job(f, 'grok', 0, { task: 'version: ' + f.s.version + '\n' + material.map(f => sha(fs.readFileSync(f))).join('\n') });
  await accept(f);
});
test('дополнение: недоступность квоты проверяется по карточке retryPlan', async () => {
  const f = google(); const plan = require('../common/quota').retryPlan({}, { kind: 'quota', message: 'quota', resetsAt: new Date(Date.now() + 7200000).toISOString() });
  const id = job(f, 'grok', 0, plan); helper(f, id); await accept(f);
});
test('21б: вернувшийся заменённый Grok освобождает место; поздний отказ снимает принятие', async () => {
  for (const count of [0, 1]) {
    const f = google(), id = job(f, 'grok', count, { status: 'lost' }); helper(f, id); await accept(f);
    const old = structuredClone(f.s), p = path.join(stores.roots().grok, id + '.json'), card = JSON.parse(fs.readFileSync(p));
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
  const no = job(f, 'grok', 1); w = await team.refreshWork(team.workFile(name)); assert.equal(w.stages[0].state, 'идёт');
  s = w.stages[0]; const version = s.version;
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
  for (const authors of [['openai', 'google'], ['google', 'openai']]) {
    const f = mixed(authors); f.s.level = 'мелочь';
    job(f, authors[1] === 'google' ? 'antigravity' : 'codex');
    await assert.rejects(accept(f), /ПРИНЯТО другой семьи/);
    job(f, 'grok'); await accept(f); assert.equal(f.s.state, 'принят');
  }
});
test('Б2: непригодные старые отзывы не мешают принятию и выдаче, номер указан', async () => {
  for (const bad of ['verdict', 'family']) for (const issued of [false, true]) {
    const f = fixture(), id = job(f, 'antigravity', 0, bad === 'family' ? {model: 'unknown-model'} : {});
    if (bad === 'verdict') {
      const dir = path.join(stores.roots().antigravity, id), text = 'Нестрогий итог';
      write(path.join(dir, 'result.txt'), text); json(path.join(dir, 'meta.json'), {hash: sha(text)});
    }
    f.s.version += '-next'; job(f); job(f, 'grok');
    const message = await accept(f, issued ? {override: {by: 'user', quote: 'Выдать без принятия'}} : {});
    assert(message.includes(id + ': прошлая проверка пропущена:'));
    assert.equal(f.s.state, issued ? 'выдан без принятия' : 'принят');
  }
});
test('Б3: заявление Claude не освобождает соавтора от подтверждения текстом', async () => {
  const f = mixed(['anthropic', 'openai'], false); job(f, 'antigravity'); job(f, 'grok');
  await assert.rejects(accept(f), /без поручения.*openai/);
});
test('Н1: prepareJob запрещает replaces на мелочи v15 до отправки', async () => {
  const {root} = require('./team-v16-fixture'), f = fixture({level: 'мелочь'});
  f.w.owner = 'test'; json(path.join(root, 'works', f.w.name + '.json'), f.w);
  await assert.rejects(gate.prepareJob({work: f.w.name, stage: f.s.id, owner: 'test', role: 'проверка',
    task: f.s.version, replaces: {who: 'codex', reason: 'авария'}}, 'grok', root), /В версии 15 место замены/);
  job(f); await accept(f); assert.equal(f.s.state, 'принят');
});
test('Н2: неучтённая замена помощником на мелочи не попадает в журнал', async () => {
  const f = fixture({level: 'мелочь'}); job(f); fresh(f, 'замена: grok\nдоказательство: missing');
  await accept(f); assert(!(f.s.decisions || []).some(d => d.kind === 'replace'));
});
test('Н4: отрицательный совет не является вторым отказом для выдачи Claude', async () => {
  const f = fixture(); job(f, 'codex', 1); job(f, 'codex', 1, {role: 'совет'}); job(f, 'antigravity');
  await assert.rejects(accept(f, {override: {by: 'claude', reason: 'выдать'}}), /двух отрицательных/);
  job(f, 'codex', 1);
  await accept(f, {override: {by: 'claude', reason: 'выдать'}}); assert.equal(f.s.state, 'выдан без принятия');
});

run(tests);
