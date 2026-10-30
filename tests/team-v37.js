'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), crypto = require('crypto');
const scratch = path.resolve(__dirname, '../.work'); fs.mkdirSync(scratch, { recursive: true });
const run = fs.mkdtempSync(path.join(scratch, 'v37-')), root = path.join(run, 'repo'), project = path.join(run, 'project');
fs.mkdirSync(root); fs.mkdirSync(project);
Object.assign(process.env, { TEMP: run, TMP: run, TMPDIR: run, MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state'),
  MOST_CODEX_JOBS_DIR: path.join(root, 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '', MOST_CLIENT: 'claude', MOST_NOTIFY: 'off',
  MOST_AFTER_DEPLOY: 'off', MOST_CLAUDE_CONFIGS: '[]', MOST_DSH_VERSION: '0.2.1-rc.2', MOST_FALLBACK_DIR: path.join(run, 'fallback'),
  MOST_AGY_CLI_SETTINGS: path.join(run, 'agy-settings.json'), MOST_DSH_RULES: path.join(run, 'missing-dsh.md'),
  MOST_DSH_CONFIG: path.join(run, 'missing-dsh.yml'), MOST_AGY_MCP_CONFIG: path.join(run, 'missing-agy.json'),
  MOST_AGY_CONFIG: path.join(run, 'missing-permissions.json'), MOST_CODEX_CONFIG: path.join(run, 'missing-codex.toml'), MOST_QUOTA_CACHE: path.join(run, 'missing-quota.json') });
delete process.env.MOST_AUTHORITY;
const gate = require('../common/stage-gate'), members = require('../common/members'), stores = require('../common/team-store');
const { Team, percent, workText, workBrief, acceptedMessage } = require('../common/team'), acceptance = require('../common/acceptance');
const team = new Team(root, path.join(root, 'state/team'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, value); };
const json = (f, value) => write(f, JSON.stringify(value, null, 2) + '\n');
const copy = x => structuredClone(x);
const meta = { action: 'test', who: 'claude', reason: 'проверка', quote: 'тест' };
const store = require('../common/members-store').create();
function composition(phase = 'A', state = null) {
  const current = store.read();
  store.update(current.rev, n => {
    for (const m of n.members) { m.state = 'active'; m.pause = null; }
    const d = n.members.find(m => m.id === 'deepseek'); d.roles.voter = phase === 'B'; d.roles.receives = phase === 'B';
    if (state) {
      const m = n.members.find(m => m.id === 'antigravity'); m.state = state;
      if (state === 'paused') m.pause = { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null };
    }
  }, meta, { phase });
  require('../common/dsh-probe').record({ version: '0.2.1-rc.2', writeDenied: true });
}
let seq = 0;
function fixture(version = 15) {
  const name = 'work-' + (++seq), file = name + '.txt'; write(path.join(project, file), 'V1 ' + name);
  const w = { name, title: name, folder: project, revision: 1, goal: 'цель', done_criteria: 'итог', next_step: 'дальше', reminders: [], owner: 'owner',
    heartbeat_at: '2026-01-01T00:00:00Z', stages: [{ title: 'Итог ' + name, weight: 100, accept_criteria: 'проверено', level: 'обычный',
      author: { family: 'anthropic', model: 'claude' }, material: [file], state: 'план', rules_version: version, evidence: 'проверено' }] };
  gate.normalize(w, null); const s = w.stages[0]; s.version = gate.version(w, s); return { w, s };
}
function job(f, who = 'codex', count = 0, text) {
  const id = 'job-' + (++seq), dir = stores.roots()[who];
  text ||= 'Ответ\n' + (count ? 'НЕ ПРИНЯТО: 1 блокирующее' : 'ПРИНЯТО');
  const j = { id, work: f.w.name, stageId: f.s.id, role: 'проверка', status: 'done', task: 'version: ' + f.s.version,
    model: who === 'antigravity' ? 'gemini-3.8-flash-high' : 'gpt-6', startedAt: new Date(Date.now() + seq * 1000).toISOString(), finishedAt: new Date(Date.now() + seq * 1000 + 1).toISOString() };
  if (who === 'antigravity') { j.workName = j.work; json(path.join(dir, id, 'card.json'), j); write(path.join(dir, id, 'result.txt'), text); json(path.join(dir, id, 'meta.json'), { hash: sha(text) }); }
  else { j.resultFile = id + '.result.txt'; json(path.join(dir, id + '.json'), j); write(path.join(dir, j.resultFile), text); }
  return id;
}
async function accept(f, old) {
  f.s.version = gate.version(f.w, f.s); f.s.state = 'принят'; f.s.reviews = [job(f), job(f, 'antigravity')];
  await gate.evaluate(f.w, f.s, old); assert.equal(f.s.state, 'принят'); return f;
}
const save = f => json(team.workFile(f.w.name), f.w);
const disk = f => JSON.parse(fs.readFileSync(team.workFile(f.w.name)));
async function refresh(f) { return team.refreshWork(team.workFile(f.w.name), { readOnly: true }); }
async function update(f) {
  const w = disk(f); await team.work({ action: 'update', name: w.name, owner: 'owner', expected_revision: w.revision, next_step: 'ещё шаг' });
  return disk(f);
}
async function notify(f) { await require('../common/notify').notify(f.w.title + ': принято 100 % плана', acceptedMessage(f.w, [{ s: f.s, i: 0 }])); }
const tests = [], test = (name, fn) => tests.push([name, fn]);
for (const version of [15, 16]) test('Р10: v' + version + ', добавление DeepSeek, пауза/удаление, чтение и update', async () => {
  composition(version === 16 ? 'B' : 'A'); const f = await accept(fixture(version)); const snapshot = copy(f.s.acceptance); save(f);
  composition('B');
  if (version === 15) await assert.rejects(gate.evaluateCurrent(f.w, copy(f.s), copy(f.s)), /нужны 3 ПРИНЯТО/);
  for (const state of [null, 'paused', 'removed']) {
    composition('B', state);
    const read = await refresh(f); assert.equal(percent(read), 100); assert.deepEqual(read.stages[0].acceptance, snapshot);
    const changed = await update(f); assert.equal(percent(changed), 100); assert.deepEqual(changed.stages[0].acceptance, snapshot);
  }
});
test('Р10: фаза A без обязательного участника не пересуживает приёмку', async () => {
  composition(); const f = await accept(fixture()); save(f); composition('A', 'removed');
  assert.throws(() => members.requiredVoters()); assert.equal(percent(await refresh(f)), 100); assert.equal(percent(await update(f)), 100);
});
test('Р10: v14 legacy с Grok сохраняет доказательство без новых прав', async () => {
  composition(); const f = fixture(14); f.s.state = 'принят'; f.s.gate.votes = [{ id: 'historic', who: 'grok', family: 'xai', count: 0, version: f.s.version }]; save(f);
  const before = fs.readFileSync(team.workFile(f.w.name)); const w = await refresh(f);
  assert.equal(percent(w), 100); assert.equal(w.stages[0].acceptance.votes[0].who, 'grok'); assert(w.stages[0].acceptance.legacy);
  assert.equal(w.stages[0].acceptance.at, null); assert.equal(w.stages[0].acceptance.materials, null);
  assert.deepEqual(fs.readFileSync(team.workFile(f.w.name)), before); assert(!members.canSend('claude', 'grok'));
  assert.equal((await update(f)).stages[0].acceptance.votes[0].who, 'grok');
});
test('Р10/Р13: V1 → V2 → приёмка V2 → смена состава; даты fs.stat, единый показ', async () => {
  composition(); const f = await accept(fixture()), a1 = copy(f.s.acceptance); save(f);
  const file = path.join(project, f.s.material[0]); write(file, 'V2'); fs.utimesSync(file, new Date('2026-10-22T10:11:00'), new Date('2026-10-22T10:11:00'));
  const w = await refresh(f), s = w.stages[0]; assert.equal(s.state, 'идёт'); assert.equal(percent(w), 0);
  assert.equal(acceptance.presentation(w).previous, 100); assert.deepEqual(s.acceptance, a1);
  for (const text of [workText(w), workBrief(w), acceptedMessage(w, [])]) {
    assert(text.includes(a1.version)); assert(text.includes('22.10 10:11')); assert(text.includes('ещё 100 % было принято'));
  }
  assert(workText(w).includes(s.version));
  fs.utimesSync(file, new Date('2026-10-22T12:13:00'), new Date('2026-10-22T12:13:00')); assert(workText(w).includes('22.10 12:13'));
  const after = await update(f); f.w = after; f.s = after.stages[0]; const old = copy(f.s);
  await accept(f, old); assert.notEqual(f.s.acceptance.version, a1.version); assert.deepEqual(f.s.acceptance_history, [a1]); save(f);
  composition('B', 'removed'); const final = await update(f); assert.equal(percent(final), 100); assert.equal(acceptance.presentation(final).previous, 0);
  assert.deepEqual(final.stages[0].acceptance_history, [a1]); assert.equal(final.stages[0].acceptance.version, f.s.version);
});
for (const key of ['accept_criteria', 'level', 'author']) test('Р10: изменён ' + key + ', повторная оценка', async () => {
  composition(); const f = await accept(fixture()), old = copy(f.s);
  f.s[key] = key === 'author' ? { family: 'openai', model: 'gpt-6' } : key === 'level' ? 'высокий' : 'новый критерий';
  await gate.evaluate(f.w, f.s, old); assert.equal(f.s.state, 'идёт'); assert.deepEqual(f.s.acceptance, old.acceptance);
});
test('Р10: новый отрицательный отзыв, история сохраняется', async () => {
  composition(); const f = await accept(fixture()), old = copy(f.s); job(f, 'codex', 1);
  await gate.evaluate(f.w, f.s, old); assert.equal(f.s.state, 'идёт'); assert.deepEqual(f.s.acceptance, old.acceptance);
});
test('Р10: поддельные acceptance/history отброшены, state без голосов не принимается', async () => {
  composition(); const f = fixture(), old = copy(f.w);
  f.s.state = 'принят'; f.s.acceptance = { version: f.s.version }; f.s.acceptance_history = [{ version: 'fake' }];
  gate.normalize(f.w, old); assert.equal(f.w.stages[0].acceptance, undefined); assert.equal(f.w.stages[0].acceptance_history, undefined);
  await assert.rejects(gate.evaluate(f.w, f.w.stages[0], old.stages[0]), /reviews/);
  save({ w: old }); const output = await team.work({ action: 'update', name: old.name, owner: 'owner', expected_revision: 1, stages: f.w.stages });
  assert.match(output, /не принят/); assert.equal(percent(disk(f)), 0);
});
test('Р10: вердикт внутри абзаца (США) не принимается', async () => {
  composition(); const f = fixture(); f.s.state = 'принят'; f.s.reviews = [job(f, 'codex', 0, 'В целом ПРИНЯТО, но это абзац.'), job(f, 'antigravity')];
  await assert.rejects(gate.evaluate(f.w, f.s), /Последняя строка/); assert.equal(f.s.acceptance, undefined);
});
test('Р10: артефакт изменён при неизменном манифесте', async () => {
  composition(); const f = fixture();
  const b = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f001234ffd9', 'hex'), file = f.w.name + '.jpg'; write(path.join(project, file), b);
  const manifest = f.w.name + '.json'; json(path.join(project, manifest), { schemaVersion: 1, order: { ids: ['one'], operators: ['codex'], aspectRatio: [1, 1] }, artifacts: [
    { id: 'one', operator: 'codex', job: 'j', parentJob: 'unknown', generatorService: 'unknown', providerReportedArtifactModel: 'unknown', promptSha256: sha('x'), iterations: [], path: file,
      delivery: { status: 'delivered', method: 'local copy' }, mime: 'image/jpeg', width: 1, height: 1, sha256: sha(b), visualReview: { status: 'accepted', author: 'test' } }] });
  f.s.material = [manifest]; f.s.artifact_manifest = manifest; await accept(f); const old = copy(f.s), v = f.s.version;
  write(path.join(project, file), 'broken'); await gate.evaluate(f.w, f.s, old);
  assert.equal(f.s.version, v); assert.equal(f.s.state, 'идёт'); assert.deepEqual(f.s.acceptance, old.acceptance);
});
test('Р11: старый пересчёт сохранил сброс; восстановление по журналу', async () => {
  composition(); const f = await accept(fixture()); delete f.s.acceptance; await notify(f); composition('B');
  try { await gate.evaluateCurrent(f.w, f.s, copy(f.s)); } catch { f.s.state = 'идёт'; } save(f);
  assert.equal(f.s.state, 'идёт'); const before = fs.readFileSync(team.workFile(f.w.name)); const restored = await refresh(f);
  assert.equal(percent(restored), 100); assert.match(restored.stages[0].acceptance.restored_from, /^notify.log /);
  assert.deepEqual(fs.readFileSync(team.workFile(f.w.name)), before); assert.equal(percent(await update(f)), 100);
});
for (const change of ['material', 'human', 'negative', 'votes', 'artifact', 'removed', 'v1v2', 'criteria']) test('Р11: отказ восстановления — ' + change, async () => {
  composition(); const f = await accept(fixture()); delete f.s.acceptance; await notify(f); f.s.state = 'идёт';
  if (change === 'material') write(path.join(project, f.s.material[0]), 'V2');
  if (change === 'human') { f.s.state = 'выдан без принятия'; f.s.gate.issued = 'решение пользователя'; }
  if (change === 'negative') job(f, 'codex', 1);
  if (change === 'votes') f.s.gate.votes = [];
  if (change === 'artifact') f.s.artifact_manifest = 'missing.json';
  if (change === 'removed') f.w.removed_stages = [copy(f.s)];
  // Р14: старый код при смене материала записал s.version = V2, а голоса остались за V1.
  if (change === 'v1v2') { write(path.join(project, f.s.material[0]), 'V2'); f.s.version = gate.version(f.w, f.s); }
  // Р16: критерий изменён после приёмки, сброс сохранён старым кодом.
  if (change === 'criteria') f.s.accept_criteria = 'другой критерий';
  save(f); const w = await refresh(f); assert.equal(percent(w), 0); assert.equal(w.stages[0].acceptance, undefined);
  // Решение человека (выдача без принятия, удаление этапа) — не «сброс старым кодом»: строки нет.
  if (['human', 'removed', 'negative'].includes(change)) assert.doesNotMatch(workText(w), /восстановить нельзя:/); else assert.match(workText(w), /восстановить нельзя:/);
});
test('Р11: пакетная приёмка (несколько этапов одним сообщением) — первый этап находится, критерий соседнего не подходит', async () => {
  const a = require('../common/acceptance');
  const text = 'Принято 100 % плана · приняты этапы: этап 1 из 2 — Первый · сделано: x · это закрывает: К1; этап 2 из 2 — Второй · сделано: y · это закрывает: К2 · дальше: z';
  const n = { text };
  assert.equal(a.__segment(text, 'Первый'), 'приняты этапы: этап 1 из 2 — Первый · сделано: x · это закрывает: К1');
  assert(a.__closesMatch(n, { title: 'Первый', accept_criteria: 'К1' })); assert(!a.__closesMatch(n, { title: 'Первый', accept_criteria: 'К2' }));
  assert(a.__closesMatch(n, { title: 'Второй', accept_criteria: 'К2' }));
});
test('Р11: чтение не принимает этап «план/идёт» по текущим отзывам и не переводит «план» в «идёт»', async () => {
  composition(); const f = fixture(); f.s.state = 'план'; save(f);
  const before = fs.readFileSync(team.workFile(f.w.name)); const w = await refresh(f);
  assert.equal(w.stages[0].state, 'план'); assert.deepEqual(fs.readFileSync(team.workFile(f.w.name)), before);
});
test('Р17(г): признак приёмки без записи в журнале — строка без даты', async () => {
  composition(); const f = await accept(fixture()); delete f.s.acceptance; f.s.state = 'идёт'; f.s.evidence = 'файл: Codex x ПРИНЯТО, Antigravity y ПРИНЯТО'; save(f);
  const w = await refresh(f); assert.equal(percent(w), 0); assert.match(workText(w), /Приёмка в журнале не найдена — восстановить нельзя/);
});
test('Р11: похожее название и обычное уведомление не доказательство', async () => {
  composition(); const f = fixture(); f.s.state = 'идёт'; f.s.gate.votes = [{ id: 'x', count: 0 }];
  await require('../common/notify').notify('Работа идёт: ' + f.w.title, acceptedMessage(f.w, [{ s: f.s, i: 0 }]));
  await require('../common/notify').notify(f.w.title + ': принято 100 % плана', 'Принято 100 % плана · этап 1 из 1 — ' + f.s.title + ' другой · сделано: текст');
  save(f); assert.equal(percent(await refresh(f)), 0);
});
for (const owner of [true, false]) test('Р12: get/list, владелец ' + owner + ', без метки неизменно', async () => {
  composition(); const f = await accept(fixture()); if (!owner) delete f.w.owner; save(f);
  let before = fs.readFileSync(team.workFile(f.w.name));
  await team.work({ action: 'get', name: f.w.name }); await team.work({ action: 'list' });
  assert.deepEqual(fs.readFileSync(team.workFile(f.w.name)), before);
  for (const action of ['get', 'list']) {
    const old = disk(f); await team.work({ action, name: f.w.name, owner: 'owner' }); const next = disk(f);
    assert.equal(next.owner, 'owner'); assert.notEqual(next.heartbeat_at, old.heartbeat_at);
    delete next.heartbeat_at; delete old.heartbeat_at; if (!old.owner) delete next.owner;
    assert.deepEqual(next, old); await new Promise(resolve => setTimeout(resolve, 2));
  }
});
test('Р12: team_status не меняет карточки; сводка показывает причину', async () => {
  composition(); const f = await accept(fixture()); save(f); write(path.join(project, f.s.material[0]), 'changed');
  const files = fs.readdirSync(path.join(root, 'works')).filter(n => n.endsWith('.json'));
  const before = files.map(n => fs.readFileSync(path.join(root, 'works', n)));
  const output = await team.status(null, null, false, true); assert(output.includes(f.s.acceptance.version));
  files.forEach((n, i) => assert.deepEqual(fs.readFileSync(path.join(root, 'works', n)), before[i]));
});
test('Р10: plans установки создаёт .dsh/AGENTS.md; configure; чужой текст сохранён', async () => {
  composition('B'); const dir = path.join(run, '.dsh'); fs.mkdirSync(dir); const file = path.join(dir, 'AGENTS.md');
  const rules = require('../common/client-rules'), value = { file, role: 'deepseek' }, plans = rules.plans([value]);
  assert.equal(plans.length, 1); assert.equal(plans[0].exists, false); assert.equal(fs.existsSync(file), false);
  await require('../common/deploy').switchConfigs(plans); assert(rules.evidence(plans)[0].contentVerified); assert(fs.readFileSync(file, 'utf8').includes('<!-- most:begin -->'));
  const file2 = path.join(dir, 'SECOND.md'); assert.match((await rules.configure({ files: [{ file: file2, role: 'deepseek' }] })).join('\n'), /создан/);
  write(file, 'Личные правила\n' + fs.readFileSync(file, 'utf8') + '\nКонец личных правил');
  await rules.configure({ files: [value] }); const text = fs.readFileSync(file, 'utf8'); assert(text.startsWith('Личные правила\n')); assert(text.endsWith('Конец личных правил'));
});
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) try { await fn(); console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed); console.log('Временные данные: ' + run); process.exitCode = failed ? 1 : 0;
})();
