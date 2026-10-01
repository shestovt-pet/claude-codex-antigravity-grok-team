'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
module.exports = ({ test, fixture, job, file, fresh, accept, gate, Team, root, project, json, write, sha }) => {
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const source = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  function saveWork(f) {
    const team = new Team(root);
    Object.assign(f.w, { owner: 'test', revision: 1, goal: 'цель', done_criteria: 'готово', next_step: 'проверка', reminders: [] });
    json(team.workFile(f.w.name), f.w); return team;
  }
  function updateCard(id, who, change) {
    const j = require('../common/team-store').list(who, false).jobs.find(j => j.id === id);
    json(j.cardFile, { ...j, ...change });
  }
  test('КР2 К1: окончательные места разных семей по каждой части', async () => {
    for (const author of [{ family: 'anthropic', model: 'claude' }, ['Альфа', 'Бета'].map(part => ({ part, family: 'anthropic', model: 'claude' }))]) {
      const f = fixture({ author });
      job(f, 'antigravity', 0, { replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
      job(f, 'antigravity'); await assert.rejects(accept(f), /разные семьи/);
      await accept(f, { one_family: true, reason: 'выдать с одной семьёй' }); assert.equal(f.s.state, 'выдан без принятия');
    }
  });
  for (const count of [0, 1]) test('КР2 К2: ожидавший ответ завершился после замены, отказов=' + count, async () => {
    const f = fixture(), t = Date.now() - 5000, iso = n => new Date(t + n).toISOString();
    job(f, 'codex', 0, { gateOrder: 1, startedAt: iso(0), finishedAt: iso(10) });
    const no = job(f, 'antigravity', 1, { gateOrder: 2, startedAt: iso(20), finishedAt: iso(30) });
    const late = job(f, 'antigravity', count, { gateOrder: 3, startedAt: iso(40), status: 'waiting_quota' });
    job(f, 'antigravity', 0, { gateOrder: 4, startedAt: iso(50), status: 'waiting_quota' });
    f.s.gate.order = 4; f.s.evidence = 'проверено'; const team = saveWork(f);
    const a = { work: f.w.name, stage: f.s.id, task: f.s.version, role: 'проверка', owner: 'test', replaces: { who: 'antigravity', reason: 'авария', after_job: [no] } };
    await gate.prepareJob(a, 'grok', root); Object.assign(f.s, read(team.workFile(f.w.name)).stages[0]);
    const sent = Date.now();
    job(f, 'grok', 0, { ...a, startedAt: new Date(sent).toISOString(), finishedAt: new Date(sent + 10).toISOString() });
    await accept(f); const old = structuredClone(f.s); saveWork(f);
    updateCard(late, 'antigravity', { status: 'done', finishedAt: new Date(sent + 20).toISOString() });
    const out = await gate.evaluate(f.w, f.s, old);
    assert.equal(f.s.state, count ? 'выдан без принятия' : 'принят');
    if (count) assert.match(out, /после замены не принял antigravity/);
    const updated = await team.work({ action: 'update', owner: 'test', name: f.w.name, expected_revision: 1, next_step: 'работа продолжается' });
    assert.equal(read(team.workFile(f.w.name)).stages[0].state, count ? 'выдан без принятия' : 'принят');
    if (count) assert.match(updated, /Сообщение пользователю[\s\S]*после замены не принял antigravity/);
    if (count) { await accept(f, { override: { by: 'user', quote: 'выдать с замечаниями' } }); assert.equal(f.s.state, 'выдан без принятия'); }
  });
  test('КР2 К2: ошибка одного этапа не прерывает update работы', async () => {
    const f = fixture({ state: 'принят', evidence: 'проверено', reviews: ['нет-поручения'] }), team = saveWork(f);
    const out = await team.work({ action: 'update', owner: 'test', name: f.w.name, expected_revision: 1, next_step: 'исправить этап' });
    assert.match(out, /нет-поручения/); const w = read(team.workFile(f.w.name)); assert.equal(w.next_step, 'исправить этап'); assert.equal(w.stages[0].state, 'идёт');
  });
  test('КР2 К3: совет Codex с продолжением не блокирует этап', async () => {
    const f = fixture(); job(f); job(f, 'antigravity'); saveWork(f);
    const a = { work: f.w.name, stage: f.s.id, task: f.s.version, role: 'совет', owner: 'test', continue_id: 'old-session' };
    await gate.prepareJob(a, 'codex', root); job(f, 'codex', 1, { ...a, previous: 'old-session' });
    assert.match(await accept(f), /совещательно не принял codex/); assert.equal(f.s.state, 'принят');
    await assert.rejects(gate.prepareJob({ ...a, role: 'проверка' }, 'codex', root), /новым сеансом только для чтения/);
  });
  test('КР2 К4: копия отказа после принятия другой части по прежнему пути', async () => {
    const f = fixture({ author: ['Альфа', 'Бета'].map(part => ({ part, family: 'google', model: 'gemini' })) });
    const p = await fresh(f, 1, 'Альфа'), rejected = fs.readFileSync(p, 'utf8');
    write(p, f.s.version + '\nБета\nПРИНЯТО'); gate.registerFile(f.w, f.s, p, f.s.version);
    const before = JSON.stringify(f.s.gate.files), team = saveWork(f), copy = path.join(path.dirname(p), 'copy-' + path.basename(p)); write(copy, rejected);
    const a = { work: f.w.name, stage: f.s.id, task: f.s.version + ' Альфа', role: 'проверка', owner: 'test', replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [copy] } };
    await gate.prepareJob(a, 'grok', root);
    assert.equal(JSON.stringify(read(team.workFile(f.w.name)).stages[0].gate.files), before);
    assert(a.task.includes(rejected)); assert.equal(a.replacementEvidence.files[0].hash, sha(rejected));
  });
  test('КР2 М1: ошибка повторного чтения автора сохраняет принятие', async () => {
    const f = fixture({ level: 'мелочь', author: { family: 'google', model: 'gemini' } });
    const id = job(f, 'antigravity', 0, { role: 'текст' }); job(f); await accept(f); const team = saveWork(f);
    const card = require('../common/team-store').list('antigravity', false).jobs.find(j => j.id === id).cardFile;
    const original = fs.readFileSync; let reads = 0;
    fs.readFileSync = (p, ...args) => {
      if (String(p) === card && ++reads > 1) throw Object.assign(Error(id + ': EACCES'), { code: 'EACCES' });
      return original(p, ...args);
    };
    try { const w = await team.refreshWork(team.workFile(f.w.name)); assert.equal(w.stages[0].state, 'принят'); assert(w.stages[0].gate.warning.includes(id)); }
    finally { fs.readFileSync = original; }
  });
  test('КР2 М2: возврат по порядку при одинаковом времени создания', async () => {
    const f = fixture(), stamp = new Date().toISOString(); job(f, 'antigravity', 0, { gateOrder: 1, startedAt: stamp });
    job(f, 'grok', 0, { gateOrder: 2, startedAt: stamp, replaces: { who: 'codex', reason: 'авария' }, replacementEvidence: { note: 'авария' } });
    await accept(f); const old = structuredClone(f.s); job(f, 'codex', 1, { gateOrder: 3, startedAt: stamp });
    assert.match(await gate.evaluate(f.w, f.s, old), /после замены не принял codex/); assert.equal(f.s.state, 'выдан без принятия');
  });
  test('КР2 М3: составные и неоднозначные версии требуют одного указания', async () => {
    for (const [v, text] of [['ред. 1', 'ред. 1.2'], ['v2', 'v2.0'], ['ред. 1', 'сравни ред. 12 с ред. 1'], ['ред. 1', 'version: ред. 1\nversion: ред. 12']]) {
      const f = fixture({ version: v }), id = job(f, 'codex', 0, { task: text }); job(f, 'antigravity');
      await assert.rejects(accept(f, { reviews: [id] }), /текущей version/);
      const p = file(f); write(p, text + '\nПРИНЯТО'); assert.throws(() => gate.registerFile(f.w, f.s, p, v), /version/);
    }
    const f = fixture({ version: 'ред. 1' }); job(f, 'codex', 0, { task: 'version: ред. 1\nСравни ред. 12 с ред. 1' }); job(f, 'antigravity'); await accept(f);
  });
  test('КР2 М4: отчёт разделяет прогоны и отмечает выполненный Н14', () => {
    const text = source('docs/team-v14-report.md');
    assert.match(text, /Codex[^\n]*607[^\n]*0[^\n]*5/); assert.match(text, /Grok 5a117a5a[^\n]*608[^\n]*0[^\n]*4/);
    assert.match(text, /Grok e691c42f[^\n]*632[^\n]*0[^\n]*4/); assert.match(text, /Н14 выполнен/); assert(!text.includes('по умолчанию корень связки'));
  });
  test('КР2 М5: правила различают известный и новый хеш after_file', () => {
    const text = source('rules/common.md'); assert(!text.includes('after_file ссылается на регистрацию, а не создаёт новую'));
    assert(text.includes('копию') && text.includes('новый хеш'));
  });
  test('КР2 М6: folder только абсолютная существующая папка', async () => {
    const team = new Team(root), plain = path.join(project, 'not-a-folder'); write(plain, 'файл');
    for (const folder of ['', 'relative-folder', path.join(project, 'missing-folder'), plain]) {
      const f = fixture();
      await assert.rejects(team.work({ action: 'create', name: f.w.name, owner: 'test', expected_revision: 0, folder, goal: 'цель', done_criteria: 'готово', next_step: 'проверка', stages: [{ ...f.s, id: undefined }] }), /folder: нужна абсолютная существующая папка/);
      assert(!fs.existsSync(team.workFile(f.w.name)));
    }
    assert(!source('servers/team/index.js').includes('по умолчанию корень связки'));
  });
  test('КР2 М7: одинаковые после нормализации части запрещены при создании', () => {
    for (const names of [['Зачёт', 'зачет'], ['БЕТА', 'Бета']]) assert.throws(() => fixture({ author: names.map(part => ({ part, family: 'anthropic', model: 'claude' })) }), /уникальные названия частей/);
  });
  test('КР2 М8: правило квот не требует выдумывать окно', () => {
    const text = source('rules/instructions.md'); assert(text.includes('окно, только если сервер его дал')); assert(text.includes('иначе время сброса')); assert([...text].length <= 1200);
  });
  test('КР2 М9: отсутствующий material не мешает плану и update', async () => {
    const team = new Team(root), n = 'missing-material-r2', material = path.join(project, 'not-created.txt');
    const out = await team.work({ action: 'create', owner: 'test', name: n, expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'создать материал', stages: [{ title: 'Итог', weight: 100, state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, accept_criteria: 'проверен', material: [material] }] });
    assert.match(out, /not-created.txt/);
    await team.work({ action: 'update', owner: 'test', name: n, expected_revision: 1, next_step: 'продолжить' });
    const w = read(team.workFile(n)); assert.equal(w.stages[0].state, 'план'); assert(w.stages[0].gate.warning);
    // Исчезновение принятого материала воспроизводим без удаления файла.
    const material2 = path.join(project, 'accepted-material-r2.txt'); write(material2, 'готово');
    const f = fixture({ material: [material2], evidence: 'проверено' }); job(f); job(f, 'antigravity'); await accept(f); saveWork(f);
    const original = fs.readFileSync;
    fs.readFileSync = (p, ...args) => {
      if (String(p) === material2) throw Object.assign(Error(material2 + ': ENOENT'), { code: 'ENOENT' });
      return original(p, ...args);
    };
    try {
      const refreshed = await team.refreshWork(team.workFile(f.w.name));
      assert.equal(refreshed.stages[0].state, 'принят');
      assert((await require('../common/summary').compact(team, 'квоты не проверялись')).includes('ENOENT'));
      const submitted = { ...refreshed.stages[0], source_jobs: ['unverified-source'] };
      await team.work({ action: 'update', owner: 'test', name: f.w.name, expected_revision: 1, stages: [submitted] });
      const kept = read(team.workFile(f.w.name)); assert.equal(kept.stages[0].state, 'принят'); assert.deepEqual(kept.stages[0].source_jobs, f.s.source_jobs);
    } finally { fs.readFileSync = original; }
  });
  test('КР2 М9: временная ошибка вердикта не поглощается повторным чтением', async () => {
    const f = fixture(); job(f); job(f, 'antigravity'); await accept(f); const team = saveWork(f);
    const stores = require('../common/team-store'), original = stores.review; let reads = 0;
    stores.review = (...args) => { if (++reads === 1) throw Object.assign(Error('job-temporary: EACCES'), { code: 'STAGE_READ_FAILED' }); return original(...args); };
    try { const w = await team.refreshWork(team.workFile(f.w.name)); assert.equal(reads, 1); assert.equal(w.stages[0].state, 'принят'); assert.match(w.stages[0].gate.warning, /job-temporary/); }
    finally { stores.review = original; }
  });
  test('КР2 М10: выдача без принятия даёт сообщение одновременно с принятием', async () => {
    const f = fixture(), g = fixture(), team = saveWork(f);
    f.s.weight = 50; g.s.weight = 50; g.s.title = 'Второй'; f.w.stages.push(g.s); json(team.workFile(f.w.name), f.w);
    const ids = [job(f), job(f, 'antigravity')], only = job({ w: f.w, s: g.s });
    const out = await team.work({ action: 'update', owner: 'test', name: f.w.name, expected_revision: 1, stages: [{ ...f.s, state: 'принят', evidence: 'готово', reviews: ids }, { ...g.s, state: 'принят', reviews: [only], one_family: true, reason: 'нет другой семьи' }] });
    assert.match(out, /Сообщение пользователю[\s\S]*Второй[^\n]*выдан без принятия/);
    const repeated = await team.work({ action: 'update', owner: 'test', name: f.w.name, expected_revision: 2, status_sent: true }); assert(!repeated.includes('Сообщение пользователю'));
  });
};
