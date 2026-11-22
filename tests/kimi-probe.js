'use strict';
// team-v58 §9: штатная проверка совместимости Kimi (tools/kimi-probe.js) на ПОДСТАВНОМ CLI (tests/fake-kimi.js) —
// живой kimi.exe НЕ запускается. Три подтверждены → запись launch.recordCompatibility создана; одна не подтверждена →
// записи нет. Отказы: MOST_PROBE_ONLY=1, MOST_JOB_ID, отсутствие CLI.
const fs = require('fs'), path = require('path');
const assert = require('assert/strict');
// setup() задаёт MOST_STATE_DIR ДО require модулей выпуска (paths.js фиксирует stateDir при загрузке) — поэтому состояние
// пробы изолировано в один каталог, а не берётся из реального state клона.
const h = require('./fake-kimi');
const f = h.setup();
const { probe } = require('../tools/kimi-probe');
const launch = require('../common/kimi-launch');
const FAKE = path.join(__dirname, 'fake-kimi.js');
const compatFile = path.join(f.state, 'kimi-compatibility.json');

// Подставной CLI запускается как `node fake-kimi.js <argv>` — prefixArgs кладёт путь к нему перед argv CLI.
const withEnv = (patch, fn) => {
  const save = {};
  for (const k of Object.keys(patch)) { save[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(save)) { if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; } });
};
const kimiPath = p => f.store.update(f.store.read().rev, n => { const m = n.members.find(m => m.id === 'kimi'); m.adapter_params.path = p; m.state = 'active'; m.pause = null; }, { action: 'test', who: 'claude', reason: 'путь CLI' });

h.run([
  ['Три проверки подтверждены подставным CLI → запись совместимости создана штатной функцией', async () => {
    f.active(); try { fs.unlinkSync(compatFile); } catch {}
    assert.equal(launch.binary(), fs.realpathSync(process.execPath), 'CLI из реестра — подставной node');
    const r = await withEnv({ MOST_PROBE_ONLY: undefined, MOST_JOB_ID: undefined }, () =>
      probe({ workRoot: path.join(f.root, 'probe-ok') }, { prefixArgs: [FAKE], timeoutMs: 60000 }));
    assert.equal(r.delivery, true, 'delivery подтверждена'); assert.equal(r.parsing, true, 'parsing подтверждена'); assert.equal(r.detection, true, 'detection подтверждена');
    assert.equal(r.recorded, true, 'запись создана');
    const compat = await withEnv({ MOST_PROBE_ONLY: undefined }, () => launch.compatibility());
    assert(compat, 'compatibility() вернула запись');
    assert.equal(compat.policy, launch.POLICY); assert.equal(compat.delivery, true); assert.equal(compat.parsing, true); assert.equal(compat.detection, true);
    assert.equal(compat.evidence.delivery, r.nonces.delivery, 'нонс доставки записан в evidence');
  }],
  ['Одна проверка не подтверждена (delivery) → записи нет', async () => {
    f.active(); try { fs.unlinkSync(compatFile); } catch {}
    // Подставному CLI через обёртку spawn передаём MOST_FAKE_PROBE_FAIL (cliEnv его бы отфильтровал) — он вернёт не ту метку.
    const cp = require('child_process');
    const spawn = (file, args, opts) => cp.spawn(file, args, { ...opts, env: { ...opts.env, MOST_FAKE_PROBE_FAIL: 'delivery' } });
    const r = await withEnv({ MOST_PROBE_ONLY: undefined, MOST_JOB_ID: undefined }, () =>
      probe({ workRoot: path.join(f.root, 'probe-fail') }, { prefixArgs: [FAKE], spawn, timeoutMs: 60000 }));
    assert.equal(r.delivery, false, 'delivery не подтверждена'); assert.equal(r.parsing, true, 'parsing при этом подтверждена');
    assert.equal(r.recorded, false, 'запись НЕ создана');
    assert(!fs.existsSync(compatFile), 'файл совместимости не записан');
    const compat = await withEnv({ MOST_PROBE_ONLY: undefined }, () => launch.compatibility());
    assert.equal(compat, null, 'compatibility() — null');
  }],
  ['Отказ: MOST_PROBE_ONLY=1 (техническая проба живой kimi.exe не запускает)', async () => {
    f.active();
    await assert.rejects(withEnv({ MOST_PROBE_ONLY: '1', MOST_JOB_ID: undefined }, () => probe({ workRoot: path.join(f.root, 'p1') }, { prefixArgs: [FAKE] })), /MOST_PROBE_ONLY/);
  }],
  ['Отказ: MOST_JOB_ID задан (запускает человек или дирижёр из чата, не поручение)', async () => {
    f.active();
    await assert.rejects(withEnv({ MOST_PROBE_ONLY: undefined, MOST_JOB_ID: 'job-1' }, () => probe({ workRoot: path.join(f.root, 'p2') }, { prefixArgs: [FAKE] })), /MOST_JOB_ID/);
  }],
  ['Отказ: CLI отсутствует (adapter_params.path не существует)', async () => {
    // Явно ставим несуществующий путь (не полагаемся на запасной C:\...\.kimi-code\bin\kimi.exe — живой kimi не трогаем).
    kimiPath(path.join(f.root, 'нет-такого-kimi.exe'));
    await assert.rejects(withEnv({ MOST_PROBE_ONLY: undefined, MOST_JOB_ID: undefined }, () => probe({ workRoot: path.join(f.root, 'p3') }, { prefixArgs: [FAKE] })), /CLI Kimi не найден/);
    f.active();
  }],
]);
