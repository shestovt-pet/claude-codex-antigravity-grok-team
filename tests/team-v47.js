'use strict';
// team-v47: регрессия на боевые правки этого изменения (замысел design-team-v47.md, разд. 13).
// Проверяет ровно новое поведение кода, добавленное в коммите: выбор системного tar, сохранение
// блока самой свежей работы при переполнении статуса, несброс приёмки в «принят» при явном сбросе этапа,
// переоткрытие правкой работы, закрытой принятием (но не словом пользователя).
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
// Сквозная проверка приёмки идёт через Team — настройки изолируем до первого require модулей связки (как part2.js).
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v47-'));
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_CLAUDE_CONFIGS = '[]';
const tests = [], test = (name, fn) => tests.push([name, fn]);

test('systemTar: на Windows — System32/tar.exe (bsdtar); при отсутствии — понятная ошибка по-русски (разд. 13.7)', () => {
  const paths = require('../common/paths');
  const tar = paths.systemTar();
  if (process.platform === 'win32') {
    assert.match(tar, /[\\/]System32[\\/]tar\.exe$/i, 'на Windows выбирается встроенный tar из System32');
    assert(fs.existsSync(tar), 'выбранный системный tar существует: ' + tar);
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    try {
      process.env.SystemRoot = path.join(ROOT, 'нет-такой-системной-папки-' + Date.now());
      delete process.env.windir;
      assert.throws(() => paths.systemTar(), /Нет системного tar Windows \(bsdtar\)/, 'при отсутствии системного tar.exe — ошибка до запуска');
    } finally { for (const k of ['SystemRoot', 'windir']) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; }
  } else assert.equal(tar, 'tar', 'на прочих платформах — прежний tar из PATH');
});

test('systemTar используется распаковкой релиза и выгрузки, а не любым tar из PATH (разд. 13.7)', () => {
  const deploy = fs.readFileSync(path.join(ROOT, 'common/deploy.js'), 'utf8');
  const exportPub = fs.readFileSync(path.join(ROOT, 'tools/export-public.js'), 'utf8');
  const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/team-v43/fixture.js'), 'utf8');
  for (const [name, src] of [['deploy.js', deploy], ['export-public.js', exportPub], ['fixture.js', fixture]]) {
    assert.match(src, /systemTar\(\)/, name + ' вызывает systemTar()');
    assert(!/execFileSync\(\s*['"]tar['"]/.test(src), name + ' не зовёт голый tar из PATH');
  }
  const setup = fs.readFileSync(path.join(ROOT, 'tools/setup.js'), 'utf8');
  assert.match(setup, /System32[^\n]*tar\.exe/, 'setup проверяет именно системный tar Windows');
});

test('summary.fit: при переполнении блок самой свежей работы вытесняется последним (О10, решение пользователя)', () => {
  const { fit } = require('../common/summary');
  const long = 'x'.repeat(200);
  const rows = [
    { text: 'ОБЯЗАТЕЛЬНАЯ-СТРОКА' },                                 // без priority — не снимается никогда
    { text: 'НАПОЛНИТЕЛЬ ' + long, priority: 1, updated: 10 },
    { text: 'СТАРАЯ-РАБОТА ' + long, priority: 1, updated: 50, work: true },
    { text: 'СВЕЖАЯ-РАБОТА ' + long, priority: 1, updated: 100, work: true },
  ];
  const out = fit(rows, 450);
  assert(out.length <= 450, 'итог уложен в бюджет: ' + out.length);
  assert(out.includes('СВЕЖАЯ-РАБОТА'), 'самая свежая работа (наибольший updated) сохранена');
  assert(out.includes('ОБЯЗАТЕЛЬНАЯ-СТРОКА'), 'обязательная строка не снимается');
  assert(!out.includes('СТАРАЯ-РАБОТА'), 'более старая работа вытеснена раньше свежей');
  assert(!out.includes('НАПОЛНИТЕЛЬ'), 'необязательный наполнитель вытеснен');
  // Без свежей работы бюджет позволяет уместить обе необязательные строки — значит дело именно в приоритете свежей.
  const control = fit([rows[0], rows[1], rows[2]], 450);
  assert(control.includes('СТАРАЯ-РАБОТА') && control.includes('НАПОЛНИТЕЛЬ'), 'контроль: без свежей работы прочие умещаются');
});

test('acceptance: явный сброс принятого этапа (с plan_change) сбрасывает в «Принято 0 %» и сохраняет acceptance_history; без plan_change — отказ (разд. 13.5)', async () => {
  const { Team } = require('../common/team');
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const simple = path.join(RUN, 'reset-root');
  fs.mkdirSync(simple);
  const team = new Team(simple, path.join(RUN, 'reset-state'));
  const stages = [
    { title: 'Первый', weight: 40, accept_criteria: 'проверка', state: 'план' },
    { title: 'Второй', weight: 60, accept_criteria: 'проверка', state: 'план' },
  ];
  await team.work({ owner: 'test-owner', action: 'create', name: 'work', expected_revision: 0,
    goal: 'Цель', done_criteria: 'Итог', stages, next_step: 'Начать' });
  require('./legacy-work')(team, 'work');
  // Принимаем первый этап: Принято 40 %.
  const accepted = structuredClone(stages);
  accepted[0] = { ...accepted[0], state: 'принят', evidence: 'Тест выполнен', version: 'v1' };
  await team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: 1, stages: accepted });
  const file = team.workFile('work');
  let w = read(file);
  assert.equal(w.stages[0].state, 'принят', 'первый этап принят');
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'work' }), /Принято 40 %/);
  // Сервер уже хранил историю прошлых приёмок этого этапа — её сброс стирать не должен.
  const history = [{ version: 'v0', at: '2026-01-01T00:00:00.000Z', note: 'прежняя приёмка' }];
  w.stages[0].acceptance_history = history;
  fs.writeFileSync(file, JSON.stringify(w));
  const rev = w.revision;
  // Сброс принятого этапа без пояснения запрещён (как part2.js: /пояснения/).
  await assert.rejects(() => team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: rev, stages }), /пояснения/);
  assert.deepEqual(read(file).stages[0].acceptance_history, history, 'отклонённый сброс ничего не меняет');
  // Сброс с plan_change реально сбрасывает этап: Принято 0 %.
  await team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: rev, stages, plan_change: 'Нужна повторная проверка' });
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'work' }), /Принято 0 %/);
  w = read(file);
  assert.notEqual(w.stages[0].state, 'принят', 'этап сброшен из «принят»');
  // …но серверная история прошлых приёмок сохранена (регрессия: delete + ранний выход её стирал).
  assert.deepEqual(w.stages[0].acceptance_history, history, 'acceptance_history не стёрт при сбросе этапа');
});

test('team.js: правкой переоткрывается работа, закрытая принятием, но не закрытая словом пользователя (разд. 13.6)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'common/team.js'), 'utf8');
  // Запрет обновления — только для работы, закрытой словом; обычное закрытие принятием правка переоткрывает.
  assert.match(src, /old\?\.closed && old\?\.closedByWord.*Закрытую работу не обновляют/,
    'update блокируется лишь при closedByWord, а не при любом closed');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ДА: ' + name); }
    catch (e) { failed++; console.log('ПРОВАЛ: ' + name + '\n' + (e && e.stack || e)); }
  }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  process.exitCode = failed ? 1 : 0;
})();
