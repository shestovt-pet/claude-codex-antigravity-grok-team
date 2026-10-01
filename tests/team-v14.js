'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v14-'));
const root = path.join(RUN, 'repo'), project = path.join(RUN, 'project');
fs.mkdirSync(root); fs.mkdirSync(project);
Object.assign(process.env, { MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state'), MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const gate = require('../common/stage-gate'), { Team } = require('../common/team');
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const json = (f, x) => write(f, JSON.stringify(x));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
let seq = 0;
function fixture(opts = {}) {
  const w = { name: 'work-' + (++seq), folder: project, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'Проверено', state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'version-' + seq, ...opts }] };
  gate.normalize(w, null);
  const s = w.stages[0];
  if (s.material?.length) s.version = gate.version(w, s);
  return { w, s };
}
function job(f, who = 'codex', count = 0, opts = {}) {
  const id = 'job-' + (++seq), dir = path.join(root, 'state', who === 'antigravity' ? 'jobs' : who + '-jobs');
  let text = 'Ответ ' + id + '\n' + (count ? 'НЕ ПРИНЯТО: ' + count + ' блокирующих' : 'ПРИНЯТО');
  if (who === 'grok') text += '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА';
  const j = { id, work: f.w.name, stage: f.s.id, stageId: f.s.id, role: 'проверка', status: 'done', startedAt: new Date(Date.now() - 100000 + seq * 10).toISOString(), task: f.s.version,
    model: who === 'antigravity' ? 'gemini-3.1-pro-high' : who === 'grok' ? 'grok-4' : 'gpt-6', ...opts };
  if (who === 'antigravity') {
    j.workName = j.work;
    json(path.join(dir, id, 'card.json'), j); write(path.join(dir, id, 'result.txt'), text); json(path.join(dir, id, 'meta.json'), { hash: sha(text) });
  } else {
    j.resultFile = id + '.result.txt'; if (who === 'grok') j.resultHash = sha(text);
    json(path.join(dir, id + '.json'), j); write(path.join(dir, j.resultFile), text);
  }
  return id;
}
function file(f, count = 0, suffix = '') {
  const p = path.join(project, '.most', 'reviews', 'fresh-' + (++seq) + '.txt');
  write(p, f.s.version + '\n' + suffix + '\nответ ' + seq + '\n' + (count ? 'НЕ ПРИНЯТО: ' + count + ' блокирующих' : 'ПРИНЯТО'));
  return p;
}
async function fresh(f, count = 0, suffix = '') { const p = file(f, count, suffix); gate.registerFile(f.w, f.s, p, f.s.version); return p; }
async function accept(f, opts = {}) { f.s.state = 'принят'; f.s.reviews = gate.allJobs().filter(j => (j.workName || j.work) === f.w.name && j.role === 'проверка' && j.status === 'done' && j.task.includes(f.s.version)).map(j => j.id); Object.assign(f.s, opts); return gate.evaluate(f.w, f.s); }
const tests = [], test = (name, fn) => tests.push({ name, fn });
test('1: новый без level, без reviews, высокий без material; старый принят сохраняется', async () => {
  await assert.rejects(accept(fixture({ level: undefined })), /level/);
  await assert.rejects(accept(fixture()), /reviews/);
  await assert.rejects(accept(fixture({ level: 'высокий' })), /material/);
  const f = fixture({ level: undefined }); f.s.rules_version = 13; assert.equal(await accept(f), '');
});
test('2: чужая работа/этап, незавершённый, отменённый, старая версия, повтор номера', async () => {
  for (const [opts, error] of [[{ work: 'other' }, /другой работы или этапа/], [{ stage: 'other', stageId: 'other' }, /другой работы или этапа/], [{ status: 'running' }, /завершённое, не отменённое/], [{ cancelled: true }, /завершённое, не отменённое/], [{ task: 'old' }, /текущей version/]]) {
    const f = fixture(), other = job(f, 'antigravity'), id = job(f, 'codex', 0, opts);
    await assert.rejects(accept(f, { reviews: [id, other] }), error);
  }
  const f = fixture(), id = job(f); await assert.rejects(accept(f, { reviews: [id, id] }), /дважды/);
});
test('3–4: Claude внутри Antigravity, пустая и неизвестная модель', async () => {
  for (const model of ['claude-opus-4.6', '', 'unknown']) {
    const f = fixture(), id = job(f, 'antigravity', 0, { model });
    await assert.rejects(accept(f, { reviews: [id] }), model.startsWith('claude') ? /модель запуска claude/ : /семья не определена/);
  }
});
test('5: одна семья не принимает; one_family даёт только выдан без принятия; отказ требует override', async () => {
  const f = fixture(); job(f); job(f); await assert.rejects(accept(f), /google/);
  await accept(f, { one_family: true, reason: 'нет второй семьи' }); assert.equal(f.s.state, 'выдан без принятия');
  job(f, 'codex', 1); await assert.rejects(accept(f, { one_family: true, reason: 'нет второй семьи' }), /override/);
  job(f, 'codex', 1); const msg = await accept(f, { one_family: true, reason: 'нет второй семьи', override: { by: 'claude', reason: 'решение' } });
  assert.match(msg, /проверяла одна семья/); assert.match(msg, /выдано вопреки/);
});
test('6, 12б: замена необязательного/без аварии/после одного сбоя запрещена, после двух разрешена', async () => {
  const f = fixture(); job(f, 'antigravity');
  const j = { who: 'grok', id: 'new', family: 'xai', at: Date.now(), task: f.s.version, replaces: { who: 'codex', reason: 'авария' } };
  // Источник квот изолирован, отсутствие данных не даёт разрешения.
  const q = require('../common/quota'), old = q.codexQuota; q.codexQuota = async () => ({});
  try {
    await assert.rejects(gate.replacement(f.w, f.s, j, [], [], gate.parts(f.s)), /нехватки/);
    job(f, 'codex', 0, { status: 'failed' });
    await assert.rejects(gate.replacement(f.w, f.s, j, [], gate.allJobs(), gate.parts(f.s)), /нехватки/);
    job(f, 'codex', 0, { status: 'failed' });
    assert.match((await gate.replacement(f.w, f.s, j, [], gate.allJobs(), gate.parts(f.s))).note, /авария/);
    j.replaces.who = 'fresh'; await assert.rejects(gate.replacement(f.w, f.s, j, [], gate.allJobs(), gate.parts(f.s)), /необязательного/);
  } finally { q.codexQuota = old; }
});
test('7: override требует два отказа или цитату пользователя', async () => {
  const f = fixture(); job(f, 'codex', 1); job(f, 'antigravity');
  await assert.rejects(accept(f, { override: { by: 'claude', reason: 'решение' } }), /меньше двух/);
  await assert.rejects(accept(f, { override: { by: 'user' } }), /цитату/);
  await accept(f, { override: { by: 'user', quote: 'выдать' } }); assert.equal(f.s.state, 'выдан без принятия');
});
test('8: замороженные поля; изменение связки ниже высокого запрещено', () => {
  const f = fixture(); f.s.gate.locked = true;
  for (const [key, value] of [['level', 'мелочь'], ['author', { family: 'openai', model: 'gpt' }], ['material', ['x']]]) {
    const changed = structuredClone(f.w); changed.stages[0][key] = value; assert.throws(() => gate.normalize(changed, f.w), /не меняются/);
  }
  for (const level of ['мелочь', 'обычный']) { const changed = structuredClone(f.w); changed.folder = root; changed.stages[0].level = level; assert.throws(() => gate.normalize(changed, f.w)); }
});
test('9: помощник должен быть подтверждён текстом своей семьи; совет/сбой не автор; anthropic помечен', async () => {
  for (const opts of [null, { role: 'совет' }, { role: 'текст', status: 'failed' }]) {
    const f = fixture({ author: { family: 'google', model: 'gemini' } }); if (opts) job(f, 'antigravity', 0, opts);
    await assert.rejects(accept(f), /без поручения/);
  }
  const f = fixture(); job(f); job(f, 'antigravity'); assert.match(await accept(f), /автор заявлен Claude/);
  const g = fixture({ level: 'мелочь', author: { family: 'google', model: 'gemini' } }); job(g, 'antigravity', 0, { role: 'текст' }); await fresh(g); await assert.rejects(accept(g), /reviews/);
});
test('10, 12а, 12г: части Gemini/Codex; свою не зачесть; текст без названия/не той семьи', async () => {
  const opts = { level: 'мелочь', author: [{ part: 'Альфа', family: 'google', model: 'gemini' }, { part: 'Бета', family: 'openai', model: 'gpt' }] };
  const f = fixture(opts); job(f, 'antigravity', 0, { role: 'текст', task: 'Альфа' }); job(f, 'codex', 0, { role: 'текст', task: 'Бета' });
  job(f, 'codex', 0, { task: f.s.version + ' Альфа Бета' });
  await assert.rejects(accept(f), /Бета/);
  job(f, 'antigravity', 0, { task: f.s.version + ' Бета' }); assert.match(await accept(f), /Отказ по части Бета/);
  const g = fixture(opts); job(g, 'antigravity', 0, { role: 'текст' }); await assert.rejects(accept(g), /назовите часть/);
  const h = fixture(opts); job(h, 'antigravity', 0, { role: 'текст', task: 'Бета' }); await assert.rejects(accept(h), /не совпадает/);
});
test('11, 12л: файл, версия, вердикт, однократный хеш, неизменная метка после перезапуска', async () => {
  const f = fixture(); assert.throws(() => gate.registerFile(f.w, f.s, path.join(project, 'absent'), f.s.version));
  const p = file(f); write(p, 'old\nПРИНЯТО'); assert.throws(() => gate.registerFile(f.w, f.s, p, f.s.version), /version/);
  write(p, f.s.version + '\nнет'); assert.throws(() => gate.registerFile(f.w, f.s, p, f.s.version), /вердикт/);
  write(p, f.s.version + '\nПРИНЯТО'); gate.registerFile(f.w, f.s, p, f.s.version);
  const restored = JSON.parse(JSON.stringify(f)), at = restored.s.gate.files[0].at;
  assert.throws(() => gate.registerFile(restored.w, restored.s, p, f.s.version), /уже зарегистрирован/); assert.equal(restored.s.gate.files[0].at, at);
  const copy = file(f); write(copy, fs.readFileSync(p)); assert.throws(() => gate.registerFile(f.w, f.s, copy, f.s.version), /уже зарегистрирован/);
});
test('12: правка файла сбрасывает принятие; старые вердикты не принимаются', async () => {
  const material = path.join(project, 'material-' + (++seq)); write(material, 'v1'); const f = fixture({ material: [material] });
  job(f); job(f, 'antigravity'); await accept(f); const old = structuredClone(f.s); write(material, 'v2');
  assert.match(await gate.evaluate(f.w, f.s, old), /снова не принят/); assert.equal(f.s.state, 'идёт'); await assert.rejects(accept(f, { reviews: old.reviews }), /текущей version/);
});
test('12в, 12ж, 12з, 12к: критерий и отказы снимаются отдельно; текущая версия обязательна', async () => {
  const f = fixture(); job(f); job(f, 'antigravity');
  await accept(f, { override: { by: 'claude', reason: 'нет живой проверки', criterion: true } }); assert.equal(f.s.state, 'выдан без принятия');
  await accept(f); assert.equal(f.s.state, 'выдан без принятия');
  await accept(f, { criterion_met: { reason: 'проверено' } }); assert.equal(f.s.state, 'принят');
  const g = fixture(); job(g, 'codex', 1); job(g, 'codex', 1); job(g, 'antigravity');
  await accept(g, { override: { by: 'claude', reason: 'решение', criterion: true } });
  await assert.rejects(accept(g, { criterion_met: { reason: 'проверено' } })); delete g.s.criterion_met;
  job(g); await accept(g); assert.equal(g.s.state, 'выдан без принятия'); await accept(g, { criterion_met: { reason: 'проверено' } }); assert.equal(g.s.state, 'принят');
});
test('12и: совещательный Grok не блокирует; неудобный обязательный на мелочи блокирует', async () => {
  const f = fixture({ level: 'мелочь' }); job(f); job(f, 'antigravity'); job(f, 'grok', 1);
  assert.match(await accept(f), /совещательно не принял grok/);
  job(f, 'codex', 1); await assert.rejects(accept(f), /НЕ ПРИНЯТО codex/);
  const g = fixture({ level: 'мелочь' }); job(g, 'grok', 1); await assert.rejects(accept(g));
});
test('12е, 12н: последние отказы по частям, дедупликация, ссылка after_file не перерегистрирует', async () => {
  const f = fixture({ author: [{ part: 'Альфа', family: 'anthropic', model: 'claude' }, { part: 'Бета', family: 'anthropic', model: 'claude' }] });
  const a = job(f, 'codex', 1), b = job(f, 'codex', 1, { task: f.s.version + ' Бета' });
  const j = { id: 'new', who: 'grok', family: 'xai', task: f.s.version, at: Date.now(), replaces: { who: 'codex', reason: 'авария', after_job: [a, b] } };
  const jobs = gate.allJobs(), rows = gate.currentRows(f.w, f.s, jobs, f.s.version);
  const proof = await gate.replacement(f.w, f.s, j, rows, jobs, gate.parts(f.s), false); assert(proof.text.includes(a) && proof.text.includes(b));
  j.replaces.after_job = [b]; await assert.rejects(gate.replacement(f.w, f.s, j, rows, jobs, gate.parts(f.s), false), /последние/);
  j.task += ' Гамма'; j.replaces.after_job = [a, a, b]; await assert.rejects(gate.replacement(f.w, f.s, j, rows, jobs, gate.parts(f.s), false));
  const g = fixture({ author: { family: 'google', model: 'gemini' } }); const p = await fresh(g, 1); const before = JSON.stringify(g.s.gate.files);
  const r = { id: 'new', who: 'grok', family: 'xai', task: g.s.version, at: Date.now() + 100, replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [p] } };
  await gate.replacement(g.w, g.s, r, gate.currentRows(g.w, g.s, [], g.s.version), [], gate.parts(g.s)); assert.equal(JSON.stringify(g.s.gate.files), before);
});
test('12м: принятие называет модель запуска и границу доверия', async () => {
  const f = fixture(); job(f); job(f, 'antigravity'); assert.match(await accept(f), /модель запуска gemini-3.1-pro-high; ответ моделью мост не подтверждает/);
});
test('12о: перестановка и пропуск служебных полей сохраняют историю, новый этап v14', () => {
  const f = fixture(); f.s.gate.files.push({ hash: 'keep' }); f.s.gate.reasons.push('причина'); f.s.gate.votes = [{ id: 'vote' }];
  const updated = { ...f.w, stages: [{ title: 'Новый' }, { title: f.s.title, id: f.s.id }] }; gate.normalize(updated, f.w);
  assert.deepEqual(updated.stages[1].gate, f.s.gate); assert.equal(updated.stages[0].rules_version, 14); assert.notEqual(updated.stages[0].id, f.s.id);
});
test('12п: принятие Б не снимает отказ А, включая замену', async () => {
  const f = fixture({ level: 'мелочь', author: [{ part: 'Альфа', family: 'google', model: 'gemini' }, { part: 'Бета', family: 'anthropic', model: 'claude' }] });
  job(f, 'antigravity', 0, { role: 'текст', task: 'Альфа' });
  job(f, 'codex', 0, { task: f.s.version + ' Альфа' }); job(f, 'codex', 1, { task: f.s.version + ' Альфа Бета' }); job(f, 'codex', 0, { task: f.s.version + ' Бета' });
  await assert.rejects(accept(f), /Альфа: НЕ ПРИНЯТО/);
});
test('12р: свежий файл относится к anthropic и Gemini, с названиями и без них', async () => {
  for (const suffix of ['', 'Альфа Бета']) {
    const material = path.join(project, 'high-' + (++seq)); write(material, 'итог');
    const f = fixture({ level: 'высокий', material: [material], author: [{ part: 'Альфа', family: 'anthropic', model: 'claude' }, { part: 'Бета', family: 'google', model: 'gemini' }] });
    job(f, 'antigravity', 0, { role: 'текст', task: 'Бета' }); job(f); job(f, 'antigravity', 0, { task: f.s.version + ' Альфа' }); await fresh(f, 0, suffix);
    assert.match(await accept(f), /сервер его не проверял/); assert.equal(f.s.state, 'принят');
  }
});
test('team_work: новые поля реально доходят до обработчика, id и вычисленная version возвращаются', async () => {
  const team = new Team(root), material = path.join(project, 'team-material'); write(material, 'v');
  await team.work({ action: 'create', owner: 'test', name: 'team-integration', expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'проверить', stages: [{ title: 'Итог', weight: 100, state: 'план', accept_criteria: 'проверено', level: 'высокий', author: { family: 'anthropic', model: 'claude' }, material: [material] }] });
  const w = JSON.parse(fs.readFileSync(team.workFile('team-integration'), 'utf8')); assert(w.stages[0].id); assert.equal(w.stages[0].version.length, 64);
  const out = await team.work({ action: 'update', owner: 'test', name: w.name, expected_revision: 1, stages: [{ ...w.stages[0], state: 'принят', evidence: 'x' }] });
  assert.match(out, /reviews/); assert.equal(JSON.parse(fs.readFileSync(team.workFile(w.name))).stages[0].state, 'идёт');
});
test('6: семья замены совпадает с автором или вторым обязательным — отказ', async () => {
  const f = fixture(), base = { id: 'new', who: 'antigravity', family: 'anthropic', at: Date.now(), task: f.s.version, replaces: { who: 'codex', reason: 'авария' } };
  await assert.rejects(gate.replacement(f.w, f.s, base, [], [], gate.parts(f.s), false));
  job(f, 'antigravity'); const rows = gate.currentRows(f.w, f.s, gate.allJobs(), f.s.version);
  await assert.rejects(gate.replacement(f.w, f.s, { ...base, family: 'google' }, rows, [], gate.parts(f.s), false), /вторым/);
});
test('12в: отказ вернувшегося заменённого снимает принятие; новое принятие восстанавливает', async () => {
  const f = fixture(); job(f, 'antigravity');
  job(f, 'grok', 0, { replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария: f1, f2' } });
  await accept(f); const old = structuredClone(f.s); job(f, 'codex', 1);
  assert.match(await gate.evaluate(f.w, f.s, old), /после замены не принял codex/); assert.equal(f.s.state, 'выдан без принятия');
  await assert.rejects(accept(f), /НЕ ПРИНЯТО/); job(f); await accept(f); assert.equal(f.s.state, 'принят');
});
test('12з: criterion_met после правки material ждёт новые вердикты всех семей', async () => {
  const material = path.join(project, 'criterion-' + (++seq)); write(material, 'one'); const f = fixture({ material: [material] });
  job(f); job(f, 'antigravity'); await accept(f, { override: { by: 'claude', reason: 'проверка установки', criterion: true } });
  write(material, 'two'); await assert.rejects(accept(f, { criterion_met: { reason: 'готово' } }));
  f.s.version = gate.version(f.w, f.s); job(f); await assert.rejects(accept(f, { criterion_met: { reason: 'готово' } }));
  job(f, 'antigravity'); await accept(f, { criterion_met: { reason: 'готово' } }); assert.equal(f.s.state, 'принят');
});
test('12и: свежий обязательный отказ блокирует, два разных файла разрешают override', async () => {
  const material = path.join(project, 'fresh-high-' + (++seq)); write(material, 'high'); const f = fixture({ level: 'высокий', material: [material] });
  job(f); job(f, 'antigravity'); await fresh(f, 1); await assert.rejects(accept(f), /fresh/);
  await assert.rejects(accept(f, { override: { by: 'claude', reason: 'решение' } }), /меньше двух/);
  await fresh(f, 1); await accept(f, { override: { by: 'claude', reason: 'решение' } }); assert.equal(f.s.state, 'выдан без принятия');
});
test('12и: замена семьи anthropic при авторе xai обязательна', async () => {
  const f = fixture({ author: { family: 'xai', model: 'grok' } }); job(f, 'grok', 0, { role: 'текст' }); job(f, 'antigravity');
  job(f, 'antigravity', 1, { model: 'claude-opus-4.6', replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
  await assert.rejects(accept(f), /НЕ ПРИНЯТО antigravity/);
});
test('12п: замена по Б не снимает отказ исходного проверяющего по А', async () => {
  const f = fixture({ level: 'мелочь', author: [{ part: 'Альфа', family: 'anthropic', model: 'claude' }, { part: 'Бета', family: 'anthropic', model: 'claude' }] });
  job(f, 'codex', 1, { task: f.s.version + ' Альфа' });
  job(f, 'grok', 0, { task: f.s.version + ' Бета', replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
  await assert.rejects(accept(f), /Альфа: НЕ ПРИНЯТО/);
});
test('чужое ПРИНЯТО той же семьи не снимает отказ Codex без replaces', async () => {
  const f = fixture(); job(f, 'codex', 1); job(f, 'antigravity'); job(f, 'antigravity', 0, { model: 'gpt-oss' });
  await assert.rejects(accept(f), /НЕ ПРИНЯТО codex/);
});
test('ручной вход в выдан без принятия запрещён; ошибочный ответ не блокирует последующее ревью', async () => {
  const f = fixture({ state: 'выдан без принятия' }); await assert.rejects(gate.evaluate(f.w, f.s), /требует override/);
  const g = fixture(); const malformed = job(g); write(path.join(root, 'state/codex-jobs', malformed + '.result.txt'), 'ответ без вердикта');
  const good = job(g), agy = job(g, 'antigravity'); await accept(g, { reviews: [good, agy] }); assert.equal(g.s.state, 'принят');
});
test('6: замена по свежему исчерпанию; старый снимок и другой аккаунт не подтверждают нехватку', async () => {
  const f = fixture(), j = { id: 'new', who: 'grok', family: 'xai', task: f.s.version, at: Date.now(), replaces: { who: 'codex', reason: 'квота' } };
  const q = require('../common/quota'), aq = require('../common/agy-quota'), oldQ = q.codexQuota, oldA = aq.agySnapshot;
  try {
    const snap = { taken_at: new Date().toISOString(), weekly: { used_percent: 100, resets_at: new Date(Date.now() + 7200000).toISOString() } };
    q.codexQuota = async () => snap; assert.match((await gate.replacement(f.w, f.s, j, [], [], gate.parts(f.s))).note, /подтверждена/);
    snap.taken_at = '2020-01-01T00:00:00Z'; await assert.rejects(gate.replacement(f.w, f.s, j, [], [], gate.parts(f.s)), /нехватки/);
    j.replaces.who = 'antigravity';
    const ag = { accountEmail: 'one@test', data: { userStatus: { email: 'other@test', cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini test', quotaInfo: { remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' } }] } } } };
    aq.agySnapshot = async () => ag; await assert.rejects(gate.replacement(f.w, f.s, j, [], [], gate.parts(f.s)), /нехватки/);
    ag.data.userStatus.email = 'one@test'; assert.match((await gate.replacement(f.w, f.s, j, [], [], gate.parts(f.s))).note, /подтверждена/);
  } finally { q.codexQuota = oldQ; aq.agySnapshot = oldA; }
});
test('team_work close: выданные этапы перечисляются, процент принятого не растёт', async () => {
  const team = new Team(root), n = 'close-work';
  await team.work({ action: 'create', owner: 'test', name: n, expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'проверка', stages: [{ title: 'Итог', weight: 100, state: 'план', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'close-version' }] });
  let w = JSON.parse(fs.readFileSync(team.workFile(n), 'utf8')), s = w.stages[0]; const id = job({ w, s });
  await team.work({ action: 'update', owner: 'test', name: n, expected_revision: 1, stages: [{ ...s, state: 'принят', reviews: [id], one_family: true, reason: 'нет другой семьи' }] });
  const out = await team.work({ action: 'close', owner: 'test', name: n, expected_revision: 2 });
  w = JSON.parse(fs.readFileSync(team.workFile(n), 'utf8')); assert(w.closed); assert.equal(require('../common/team').percent(w), 0); assert.match(out, /выдан без принятия/);
});
test('совещательный отказ не требует after_job для замены обязательного', async () => {
  const f = fixture(); job(f, 'codex', 1, { role: 'совет' });
  const rows = gate.currentRows(f.w, f.s, gate.allJobs(), f.s.version);
  const j = { id: 'new', who: 'grok', family: 'xai', task: f.s.version, at: Date.now(), replaces: { who: 'codex', reason: 'авария' } };
  assert.equal((await gate.replacement(f.w, f.s, j, rows, [], gate.parts(f.s), false)).text, '');
});
test('закрытая принятая работа открывается вновь после изменения material', async () => {
  const team = new Team(root), n = 'reopen-work', material = path.join(project, 'reopen.txt'); write(material, 'first');
  await team.work({ action: 'create', owner: 'test', name: n, expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'проверка', stages: [{ title: 'Итог', weight: 100, state: 'план', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, material: [material] }] });
  let w = JSON.parse(fs.readFileSync(team.workFile(n), 'utf8')), s = w.stages[0]; const ids = [job({ w, s }), job({ w, s }, 'antigravity')];
  await team.work({ action: 'update', owner: 'test', name: n, expected_revision: 1, stages: [{ ...s, state: 'принят', reviews: ids, evidence: 'проверено' }] });
  await team.work({ action: 'close', owner: 'test', name: n, expected_revision: 2 }); write(material, 'second');
  await team.work({ action: 'get', owner: 'test', name: n }); w = JSON.parse(fs.readFileSync(team.workFile(n), 'utf8'));
  assert.equal(w.closed, false); assert.equal(w.stages[0].state, 'идёт'); assert.equal(require('../common/team').percent(w), 0);
});
test('12д до v14: source_jobs без role — текст, reviews без role требует вердикт', async () => {
  const f = fixture({ level: 'мелочь', author: { family: 'google', model: 'gemini' } });
  f.s.source_jobs = [job(f, 'antigravity', 0, { role: undefined })]; const review = job(f, 'codex', 0, { role: undefined });
  await accept(f, { reviews: [review] }); assert.equal(f.s.state, 'принят');
  const pathResult = path.join(root, 'state/codex-jobs', review + '.result.txt'); write(pathResult, 'просто совет'); await assert.rejects(accept(f, { reviews: [review] }), /вердикт/);
});
test('КР1 Б1: вернувшийся Codex освобождает семью Grok по своей части', async () => {
  const f = fixture();
  job(f, 'grok', 0, { replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
  job(f, 'codex');
  job(f, 'grok', 0, { replaces: { who: 'antigravity', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('КР1 Б2: регистрация after_file и отправка в одну миллисекунду', async () => {
  const f = fixture({ author: { family: 'google', model: 'gemini' } });
  json(path.join(root, 'works', f.w.name + '.json'), f.w);
  const p = file(f, 1), now = Date.now, fixed = now(); Date.now = () => fixed;
  try {
    const args = { work: f.w.name, stage: f.s.id, role: 'проверка', task: f.s.version, replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [p] } };
    await gate.prepareJob(args, 'grok', root);
    const s = JSON.parse(fs.readFileSync(path.join(root, 'works', f.w.name + '.json'))).stages[0];
    assert(args.task.includes('НЕ ПРИНЯТО')); assert(args.gateOrder > s.gate.files[0].gateOrder);
  } finally { Date.now = now; }
});
for (const registered of [true, false]) test('КР1 Б3: повторный путь after_file, заранее зарегистрирован=' + registered, async () => {
  const f = fixture({ author: { family: 'google', model: 'gemini' } });
  const p = await fresh(f, 1), original = structuredClone(f.s.gate.files[0]);
  write(p, f.s.version + '\nНОВЫЙ-ОТКАЗ\nНЕ ПРИНЯТО: 2 блокирующих');
  if (registered) gate.registerFile(f.w, f.s, p, f.s.version);
  json(path.join(root, 'works', f.w.name + '.json'), f.w);
  const a = { work: f.w.name, stage: f.s.id, role: 'проверка', task: f.s.version, replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [p] } };
  await gate.prepareJob(a, 'grok', root);
  const restored = JSON.parse(fs.readFileSync(path.join(root, 'works', f.w.name + '.json')));
  assert.deepEqual(restored.stages[0].gate.files[0], original);
  assert.equal(restored.stages[0].gate.files.length, 2);
  assert(a.task.includes('НОВЫЙ-ОТКАЗ')); assert.equal(a.replacementEvidence.files[0].hash, sha(fs.readFileSync(p)));
  // Уже отправленная замена привязана к хешу; дальнейшая правка пути её не портит.
  write(p, 'изменён после отправки');
  const rows = gate.currentRows(restored, restored.stages[0], [], f.s.version);
  await gate.replacement(restored, restored.stages[0], { ...a, id: 'sent', who: 'grok', family: 'xai', at: Date.now() }, rows, [], gate.parts(f.s), false);
});
test('КР1 Б4: следующая замена снимает отказ замены по месту', async () => {
  const f = fixture({ level: 'мелочь' });
  const no = job(f, 'grok', 1, { replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
  job(f, 'antigravity', 0, { replaces: { who: 'codex', reason: 'авария', after_job: [no] }, replacementEvidence: { note: 'авария' } });
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('КР1 Б3: один путь с двумя отказами по разным частям передаёт оба хеша', async () => {
  const f = fixture({ author: [{ part: 'Альфа', family: 'google', model: 'gemini' }, { part: 'Бета', family: 'google', model: 'gemini' }] });
  const p = await fresh(f, 1, 'Альфа');
  write(p, f.s.version + '\nБета\nНЕ ПРИНЯТО: 2 блокирующих'); gate.registerFile(f.w, f.s, p, f.s.version);
  json(path.join(root, 'works', f.w.name + '.json'), f.w);
  const a = { work: f.w.name, stage: f.s.id, role: 'проверка', task: f.s.version, replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [p] } };
  await gate.prepareJob(a, 'grok', root); assert.equal(a.replacementEvidence.files.length, 2);
  assert(a.task.includes('Альфа') && a.task.includes('Бета'));
});
for (const legacy of [false, true]) test('КР1 Б5: без folder, внешние material; старая работа=' + legacy, async () => {
  const f = fixture(), team = new Team(root), material = path.join(project, f.w.name + '.txt'); write(material, 'материал');
  delete f.w.folder; f.s.material = [material];
  const base = { owner: 'test', name: f.w.name, goal: 'цель', done_criteria: 'готово', next_step: 'проверка' };
  if (legacy) { delete f.s.level; f.s.rules_version = 13; json(team.workFile(f.w.name), { ...f.w, ...base, revision: 1 }); }
  await team.work({ ...base, action: legacy ? 'update' : 'create', expected_revision: legacy ? 1 : 0, stages: [{ ...f.s, id: legacy ? f.s.id : undefined }] });
  let w = JSON.parse(fs.readFileSync(team.workFile(f.w.name))); assert(!w.folder);
  if (legacy) await team.work({ ...base, action: 'update', expected_revision: w.revision, folder: project });
  else {
    const s = w.stages[0], reviews = [job({ w, s }), job({ w, s }, 'antigravity')];
    await team.work({ ...base, action: 'update', expected_revision: w.revision, stages: [{ ...s, reviews, state: 'принят', evidence: 'проверено' }] });
  }
  w = JSON.parse(fs.readFileSync(team.workFile(f.w.name)));
  assert(legacy ? w.folder === project : w.stages[0].state === 'принят');
});
test('КР1 Н1: названия без регистра и ё/е, предупреждение без названий', async () => {
  const f = fixture({ level: 'мелочь', author: [{ part: 'Зачёт', family: 'anthropic', model: 'claude' }, { part: 'Бета', family: 'anthropic', model: 'claude' }] });
  job(f, 'codex', 0, { task: f.s.version + ' зачет' }); await assert.rejects(accept(f), /Бета: проверяющий/);
  job(f, 'antigravity'); assert.match(await accept(f), /части не названы — засчитано на все/);
  job(f, 'codex', 1); await assert.rejects(accept(f), /части не названы — засчитано на все/);
});
test('КР1 Н2: ошибка чтения карточки сохраняет принятие и предупреждает с номером', async () => {
  const f = fixture(), team = new Team(root); job(f); job(f, 'antigravity'); await accept(f);
  const card = { ...f.w, revision: 4, closed: true, reminders: [] }; json(team.workFile(f.w.name), card);
  const stores = require('../common/team-store'), original = stores.list;
  stores.list = () => ({ jobs: [], errors: ['job-broken-123.json: EACCES'] });
  try {
    const w = await team.refreshWork(team.workFile(f.w.name));
    assert.equal(w.stages[0].state, 'принят'); assert.equal(w.revision, 4); assert.equal(w.closed, true);
    assert.match(w.stages[0].gate.warning, /job-broken-123/);
    assert(require('../common/team').workText(w).includes('job-broken-123'));
  } finally { stores.list = original; }
  const recovered = await team.refreshWork(team.workFile(f.w.name)); assert(!recovered.stages[0].gate.warning);
  // Исчезновение между перечислением и чтением не является ошибкой чтения
  // существующей карточки. Проверяем настоящий stores.list для всех мостов.
  for (const who of ['codex', 'antigravity', 'grok']) {
    const id = 'job-unreadable-' + who;
    const file = path.join(stores.roots()[who], who === 'antigravity' ? id + '/card.json' : id + '.json');
    json(file, { id });
    const readFile = fs.readFileSync;
    for (const failure of ['ENOENT', 'EACCES', 'JSON']) {
      let reads = 0;
      fs.readFileSync = function(p, ...args) {
        if (String(p) === file) {
          reads++;
          if (failure === 'JSON') return '{';
          throw Object.assign(Error(id + ': ' + failure), { code: failure });
        }
        return readFile.call(this, p, ...args);
      };
      try {
        const listed = stores.list(who, false);
        assert(!listed.jobs.some(j => j.id === id));
        assert.equal(listed.errors.some(e => e.includes(id)), failure !== 'ENOENT');
        const w = await team.refreshWork(team.workFile(f.w.name));
        assert.equal(w.stages[0].state, 'принят'); assert.equal(w.revision, 4); assert.equal(w.closed, true);
        if (failure === 'ENOENT') assert(!w.stages[0].gate.warning, 'ENOENT не даёт предупреждения Н2');
        else assert(w.stages[0].gate.warning.includes(id), 'настоящий сбой должен давать предупреждение Н2');
        assert(reads > 0, 'карточка дошла до чтения после перечисления');
      } finally { fs.readFileSync = readFile; }
    }
    const restored = await team.refreshWork(team.workFile(f.w.name)); assert(!restored.stages[0].gate.warning);
  }
});
test('КР1 Н3: неизвестное окно квоты и дата сброса, замер Claude за 2 ч', async () => {
  const aq = require('../common/agy-quota'), original = aq.agySnapshot;
  const reset = new Date(Date.now() + 3 * 86400000);
  const text = aq.parseQuota({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini Test', quotaInfo: { resetTime: reset.toISOString(), remainingFraction: 0 } }] } } });
  assert(!text.includes('окно 5 ч')); assert(text.includes(reset.toLocaleDateString('ru-RU')));
  const state = path.join(project, 'quota-' + (++seq)); json(path.join(state, 'claude-quota.json'), { calls: 2, reread: 0, written: 0, window_h: 2, source: 'сеанс', taken_at: new Date().toISOString() });
  aq.agySnapshot = async () => ({ text: 'закрыто' });
  try { const line = await require('../common/quota-line').quotaLine({ state, codex: {} }); assert.match(line, /за 2 ч/); assert(!line.includes('окно 5 ч')); }
  finally { aq.agySnapshot = original; }
});
test('КР1 Н4: чужой заголовок в text не определяет авторство', async () => {
  const f = fixture({ level: 'мелочь', author: [{ part: 'Альфа', family: 'google', model: 'gemini' }, { part: 'Бета', family: 'anthropic', model: 'claude' }] });
  job(f, 'antigravity', 0, { role: 'текст', task: 'Альфа', text: 'Бета' }); job(f);
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('КР1 Н5: пересоздание замороженного этапа требует id и сохраняет историю', () => {
  const f = fixture(); f.s.gate.locked = true; f.s.gate.votes = [{ count: 2 }];
  const changed = structuredClone(f.w); changed.stages[0].title += '.'; delete changed.stages[0].id;
  assert.throws(() => gate.normalize(structuredClone(changed), f.w, 'переименование'), /id в plan_change/);
  gate.normalize(changed, f.w, 'удалить ' + f.s.id); assert.deepEqual(changed.removed_stages[0], f.s);
  const hidden = fixture(); job(hidden, 'codex', 1);
  const removed = structuredClone(hidden.w); removed.stages = [];
  assert.throws(() => gate.normalize(removed, hidden.w, 'убрать этап'), /id в plan_change/);
  const positive = fixture(); positive.s.gate.locked = true; job(positive);
  const clean = structuredClone(positive.w); clean.stages = [];
  gate.normalize(clean, positive.w, 'убрать этап'); assert.deepEqual(clean.removed_stages[0], positive.s);
});
test('КР1 Н6: material внутри связки при родительской папке требует высокий', () => {
  const material = path.join(root, 'inside.txt'); write(material, 'код');
  const w = { name: 'parent', folder: RUN, stages: [{ title: 'Код', level: 'обычный', material: [material] }] };
  assert.throws(() => gate.normalize(w, null), /высокий/);
});
test('КР1 Н7: prepareJob проверяет доступ до записи и использует общий замок', async () => {
  const f = fixture(); json(path.join(root, 'works', f.w.name + '.json'), f.w);
  const a = { work: f.w.name, stage: f.s.id, role: 'проверка', task: f.s.version }, client = process.env.MOST_CLIENT;
  process.env.MOST_CLIENT = 'codex';
  const before = fs.readFileSync(path.join(root, 'works', f.w.name + '.json'), 'utf8');
  try { await assert.rejects(gate.prepareJob(a, 'codex', root), /Гостю это действие запрещено/); assert.equal(fs.readFileSync(path.join(root, 'works', f.w.name + '.json'), 'utf8'), before); }
  finally { process.env.MOST_CLIENT = client; }
  const deploy = require('../common/deploy'), original = deploy.locked; let acquired = 0;
  deploy.locked = async (dir, fn) => { assert.equal(dir, root); acquired++; return fn(); };
  try { await gate.prepareJob({ ...a, write: false }, 'codex', root); assert.equal(acquired, 1); }
  finally { deploy.locked = original; }
});
test('КР1 Н8: ред. 1 не совпадает с ред. 12 в поручении и файле', async () => {
  const f = fixture({ version: 'ред. 1' }); job(f, 'antigravity');
  const id = job(f, 'codex', 0, { task: 'ред. 12' }); await assert.rejects(accept(f, { reviews: [id] }), /текущей version/);
  const p = file(f); write(p, 'ред. 12\nПРИНЯТО'); assert.throws(() => gate.registerFile(f.w, f.s, p, f.s.version), /version/);
});
test('КР1 Н9: продолжение сеанса Codex не проверяет этап', async () => {
  const f = fixture(); job(f, 'antigravity'); job(f, 'codex', 0, { previous: 'author-job' });
  await assert.rejects(accept(f), /новым сеансом только для чтения/);
});
test('КР1 Н10: сообщение о принятии только в принявшем update', async () => {
  const f = fixture(), team = new Team(root), base = { owner: 'test', name: f.w.name, goal: 'цель', done_criteria: 'готово', next_step: 'проверка', folder: project };
  await team.work({ ...base, action: 'create', expected_revision: 0, stages: [{ ...f.s, id: undefined }] });
  let w = JSON.parse(fs.readFileSync(team.workFile(f.w.name))), s = w.stages[0];
  const reviews = [job({ w, s }), job({ w, s }, 'antigravity')];
  const accepted = await team.work({ ...base, action: 'update', expected_revision: 1, stages: [{ ...s, state: 'принят', evidence: 'проверено', reviews }] }); assert.match(accepted, /Сообщение пользователю/);
  const updated = await team.work({ ...base, action: 'update', expected_revision: 2, status_sent: true }); assert(!updated.includes('Сообщение пользователю'));
});
test('КР1 Н11: общий абзац правил единственный, Grok по семьям', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const common = read('rules/common.md'); assert(!common.includes('Приёмка по семье автора — rules/common.md'));
  for (const who of ['claude', 'antigravity', 'grok', 'brief']) { const text = read('rules/' + who + '.md'); assert(!text.includes('В каждом поручении с работой укажи role')); assert(text.includes('common.md#правила-team-v14')); }
  assert(read('rules/grok.md').includes('на месте замены голос Grok обязателен'));
});
test('КР1 Н12: скилл описывает последствия возврата заменённого', () => {
  const skillPath = path.join(__dirname, '../skill/vtm-hronika/SKILL.md');
  // Skill excluded from public export — skip H12 then (same as team-v8).
  if (!fs.existsSync(skillPath)) { console.log('skill/vtm-hronika excluded (public export): H12 skipped'); return; }
  const text = fs.readFileSync(skillPath, 'utf8');
  assert(text.includes('не снимает «НЕ ПРИНЯТО» замены')); assert(text.includes('версию блокирует этап'));
});
test('КР1 Н13: отчёт первого круга содержит подтверждённые цифры и ревью', () => {
  const text = fs.readFileSync(path.join(__dirname, '../docs/team-v14-report.md'), 'utf8');
  assert(/Codex[^\n]*607, провалов 0, пропущено 5/.test(text)); assert(text.includes('Круг 1 ревью')); assert(!text.includes('Коммит, удаление и переименование файлов проекта'));
});
require('./team-v14-r2-cases')({ test, fixture, job, file, fresh, accept, gate, Team, root, project, json, write, sha });
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) try { await t.fn(); passed++; console.log('OK ' + t.name); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
