'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v6-'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'), MOST_AGY_CONFIG: path.join(RUN, 'absent-permissions.json'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent-mcp.json') });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, s) => write(f, JSON.stringify(s)), read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const tests = [], test = (label, fn) => tests.push({ label, fn });
const rules = require('../common/client-rules'), ops = require('../common/deploy-ops'), restart = require('../common/restart');
const files = ['codex', 'antigravity'].map(who => path.join(RUN, who, 'AGENTS.md'));
process.env.MOST_CODEX_RULES = files[0]; process.env.MOST_AGY_RULES = files[1];
function resetRules() { files.forEach((f, i) => write(f, fs.readFileSync(path.join(__dirname, 'fixtures/trio-v5', ['codex', 'antigravity'][i] + '-AGENTS.md')))); }
function checklist() {
  files.forEach((f, i) => {
    const s = fs.readFileSync(f, 'utf8');
    // Правила доставляются с корнем установки (team-v11 Р1): здесь корень — папка прогона.
    for (const text of ['Claude — дирижёр', 'Codex — критик логики и код', 'Antigravity — автор литературного текста', 'Grok — поиск, источники и термины', 'Все трое помощников участвуют в обсуждении замысла и итоговом ревью', 'Рутину делают сервер и скрипты', 'голос совещательный', 'Обязательные проверяющие — Codex и Antigravity', 'решение принимает Claude', ...['C:\\most\\AGENTS.md', 'C:\\most\\rules\\common.md', 'C:\\most\\lessons.md'].map(t => require('../common/paths').withRoot(t, process.env.MOST_REPO_ROOT)), '[блокирующее]/[улучшение]', '[разовое]/[системное]', 'последняя строка — «ПРИНЯТО» или «НЕ ПРИНЯТО: N блокирующих»', 'только с доказательством', 'не разрешение самостоятельно отправлять задания или менять настройки']) assert(s.includes(text), text);
    for (const text of i ? ['на диск не пишет', 'команд, меняющих файлы, не запускает', 'Результат переносит сервер по решению Claude'] : ['отдельного пользователя Windows без сети', '`.git` только для чтения', 'Удаления запрещены', 'перечисляй в отчёте']) assert(s.includes(text), text);
  });
}
function release() {
  const dir = path.join(RUN, 'live', 'a'.repeat(40));
  for (const n of ['team', 'codex', 'antigravity', 'grok']) write(path.join(dir, 'servers', n, 'index.js'), '');
  json(path.join(dir, 'probe-ok.json'), { root: RUN, commit: 'a'.repeat(40), at: new Date().toISOString(), servers: ['antigravity', 'codex', 'team', 'grok'] });
  return dir;
}
test('Р1: точные прежние структуры, обязательный смысл, внешние байты и повтор', async () => {
  resetRules(); const originals = files.map(f => fs.readFileSync(f, 'utf8'));
  await rules.configure({ files }); checklist();
  files.forEach((f, i) => { const next = fs.readFileSync(f, 'utf8'), range = rules.section(originals[i]); assert(next.startsWith(originals[i].slice(0, range.from))); assert(next.endsWith(originals[i].slice(range.to))); assert.equal(rules.replace(next, i ? 'antigravity' : 'codex'), next); assert.equal(fs.readFileSync(f + '.prev', 'utf8'), originals[i]); });
  await rules.configure({ files, rollback: true }); files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), originals[i]));
});
test('Р1: CLI операции доставляет правила, фиксирует факт доставки, повтор и общий откат', async () => {
  resetRules(); process.env.MOST_CODEX_RULES = files[0]; process.env.MOST_AGY_RULES = files[1];
  const dir = release(), config = path.join(RUN, 'claude.json'), result = path.join(RUN, 'state/deploy-ops/install.json');
  json(config, {}); json(result, { id: 'install', root: RUN, createdAt: new Date().toISOString() });
  await require('../tools/deploy').main(['--config-only', '--release', dir, '--config', config, '--result', result], { print: () => {} });
  checklist(); const evidence = read(result).rulesDelivery;
  assert.equal(evidence.length, 2); assert(evidence.every(e => e.operation === 'install' && e.deliveryPerformed && e.contentVerified && e.changed));
  await require('../tools/deploy').main(['--config-only', '--release', dir, '--config', config, '--result', result], { print: () => {} });
  assert(read(result).rulesDelivery.every(e => e.deliveryPerformed && !e.changed));
  resetRules(); json(config, {}); const before = files.map(f => fs.readFileSync(f, 'utf8'));
  await assert.rejects(require('../common/deploy').configure({ release: dir, configs: [config], method: 'из Claude через исполнителя вне пакета', result }, { hook: phase => { if (phase === 'config3') throw Error('сбой после правил'); } }), /Конфиги восстановлены/);
  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), before[i]));
});
test('Р2: числовой предел 8 МиБ, UTF-8; только последний result', () => {
  const a = require('../common/agy-input');
  assert.equal(JSON.parse(a.userEvent('я'.repeat(4194304))).message.content.length, 4194304);
  assert.throws(() => a.userEvent('я'.repeat(4194305)), /8388608/);
  assert.equal(a.parseResults('{"event":"step_update","step_update":{"text_delta":"мимо"}}').obj, null);
  assert.equal(a.parseResults('{"event":"result","result":{"status":"SUCCESS","response":"первый"}}\n{"event":"result","result":{"status":"ERROR","response":"последний"}}').obj.status, 'ERROR');
});
test('Р2: реальный дочерний процесс — весь длинный материал, EOF, последний result, отказ 0/ERROR и один повтор', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const log = path.join(RUN, 'stream.log'), transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')], env: { ...process.env, AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), MOST_AGY_INPUT_FORMAT: '', FAKE_STREAM_LOG: log }, stderr: 'pipe' });
  const client = new Client({ name: 'team-v6-test', version: '1' }); await client.connect(transport);
  try {
    for (const [n, directive, expected, attempts] of [[0, '', 'done', 1], [1, 'DENY_READ', 'failed', 2], [2, 'DENY_READ ERROR_STATUS', 'failed', 2], [3, 'DENY_OTHER', 'failed', 1], [4, 'DENY_READ ONLY_ONCE', 'done', 2], [5, 'NO_RESULT', 'failed', 1], [6, 'QUOTE_DENIAL', 'done', 1], [7, 'SERVICE_DENIAL', 'failed', 2]]) {
      const folder = path.join(RUN, 'material-' + n); fs.mkdirSync(folder);
      const material = 'Длинный материал '.repeat(5000) + 'КОНЕЦ_МАТЕРИАЛА'; const file = path.join(folder, 'source.txt'); write(file, material);
      const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
      const response = await client.callTool({ name: 'antigravity_send', arguments: { folder, file, mode: 'review', task: 'Проверь материал. ' + directive } });
      const text = response.content.map(c => c.text || '').join('\n'), id = /Задание (\S+) запущено/.exec(text)?.[1]; assert(id, text);
      for (let i = 0; i < 20; i++) { await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); const card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (!['running', 'queued'].includes(card.status)) break; }
      const dir = path.join(RUN, 'state/jobs', id), card = read(path.join(dir, 'card.json'));
      assert.equal(card.status, expected); assert.equal(!!card.materialReadRetry, attempts === 2); assert(!card.protocolFallback);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').slice(before).map(JSON.parse); assert.equal(calls.length, attempts);
      assert(calls.every(c => c.eof && c.event.event === 'user' && c.event.message.content.includes(material)));
      assert.equal(card.fileMode, false); assert(!card.retry.args.includes('--print'));
      if (expected === 'done') assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), directive === 'QUOTE_DENIAL' ? 'ПРИНЯТО\nПоле denied_actions обработано; цитата: read_file auto-denied; denied.' : 'Последний итог: ПРИНЯТО');
      else assert(card.problems.some(p => /разрешение|разрешения|result/.test(p)));
    }
  } finally { await client.close(); await transport.close(); }
});
test('Р2: прежний путь также распознаёт SUCCESS+stderr и сохраняет ровно один повтор', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const log = path.join(RUN, 'legacy.log'), transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')], env: { ...process.env, AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), MOST_AGY_INPUT_FORMAT: 'legacy', FAKE_STREAM_LOG: log }, stderr: 'pipe' });
  const client = new Client({ name: 'team-v6-legacy', version: '1' }); await client.connect(transport);
  try {
    const folder = path.join(RUN, 'legacy-material'); fs.mkdirSync(folder);
    const file = path.join(folder, 'source.txt'); write(file, 'Короткий материал');
    const r = await client.callTool({ name: 'antigravity_send', arguments: { folder, file, mode: 'review', task: 'DENY_READ' } });
    const text = r.content.map(c => c.text || '').join('\n'), id = /Задание (\S+) запущено/.exec(text)?.[1]; assert(id, text);
    let card;
    for (let i = 0; i < 20; i++) { await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (card.status !== 'running') break; }
    assert.equal(card.status, 'failed'); assert.equal(card.materialReadRetry.attempt, 1);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  } finally { await client.close(); await transport.close(); }
});
test('Р2: ошибка протокола — один запасной запуск, карточка и длинный материал с опорами', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const log = path.join(RUN, 'fallback.log'), transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')], env: { ...process.env, AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), MOST_AGY_INPUT_FORMAT: '', FAKE_STREAM_LOG: log }, stderr: 'pipe' });
  const client = new Client({ name: 'team-v6-fallback', version: '1' }); await client.connect(transport);
  try {
    for (const [n, directive, long, expected] of [[0, 'PROTOCOL_ERROR', false, 'done'], [1, 'PROTOCOL_ERROR', true, 'done'], [2, 'PROTOCOL_ERROR FAIL_LEGACY', false, 'failed'], [3, 'PROTOCOL_ERROR STDERR_PROTOCOL', false, 'done'], [4, 'PROTOCOL_ERROR LEGACY_DENIAL', false, 'failed'], [5, 'PROTOCOL_ERROR LEGACY_DENIAL LEGACY_ONCE', false, 'done'], [6, 'PROTOCOL_ERROR LEGACY_DENIAL LEGACY_ONCE', true, 'done'], [7, 'PROTOCOL_ERROR LEGACY_DENIAL', true, 'failed']]) {
      const folder = path.join(RUN, 'fallback-' + n); fs.mkdirSync(folder);
      const file = path.join(folder, 'source.txt'), ref = path.join(folder, 'reference.txt');
      const material = 'Материал '.repeat(long ? 10000 : 1), reference = 'Опора для проверки'; write(file, material); write(ref, reference);
      const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
      const r = await client.callTool({ name: 'antigravity_send', arguments: { folder, file, refs: [ref], mode: 'review', task: directive } });
      const text = r.content.map(c => c.text || '').join('\n'), id = /Задание (\S+) запущено/.exec(text)?.[1]; assert(id, text);
      let card;
      for (let i = 0; i < 20; i++) { await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (card.status !== 'running') break; }
      assert.equal(card.status, expected); assert.equal(card.protocolFallback.attempt, 1); assert.match(card.protocolFallback.reason, /missing/);
      assert.equal(card.protocolFallback.from, 'stream-json'); assert.equal(card.protocolFallback.to, 'legacy'); assert(card.protocolFallback.at);
      assert.equal(card.retry.stdin, undefined); assert(card.retry.args.includes('--print')); assert(!card.retry.args.includes('--input-format'));
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').slice(before).map(JSON.parse); assert.equal(calls.length, directive.includes('LEGACY_DENIAL') ? 3 : 2);
      assert.equal(calls.filter(c => !c.args.includes('--print')).length, 1);
      if (directive.includes('LEGACY_DENIAL')) { assert.equal(card.materialReadRetry.attempt, 1); assert(card.materialReadRetry.at); assert.match(card.materialReadRetry.reason, /прочитать/); assert.deepEqual(calls[2].args, calls[1].args); assert.deepEqual(calls[2].files, calls[1].files); }
      assert(calls[0].event.message.content.includes(material)); assert(calls[0].event.message.content.includes(reference));
      const delivered = [calls[1].event.message.content, ...calls[1].files].join('\n'); assert(delivered.includes(material)); assert(delivered.includes(reference));
      assert.equal(card.fileMode, long); assert.equal(!!card.materialReadRetry, directive.includes('LEGACY_DENIAL'));
      if (expected === 'done') assert.equal(fs.readFileSync(path.join(RUN, 'state/jobs', id, 'result.txt'), 'utf8'), 'Последний итог: ПРИНЯТО');
      else if (directive.includes('LEGACY_DENIAL')) assert(card.problems.some(p => /разрешени/.test(p)));
    }
  } finally { await client.close(); await transport.close(); }
});
test('Р2: запасной путь не обходит отказы, отмену, квоту и ошибки исполнения', () => {
  const { protocolError } = require('../common/agy-input');
  const error = 'stream input message is missing the "event" field';
  assert(protocolError({ agyError: error })); assert(protocolError({ stderr: 'unknown flag: --input-format' })); assert(protocolError({ stderr: 'flag provided but not defined: -input-format' })); assert(protocolError({ agyError: 'unsupported stream input event: user' }));
  for (const res of [{ output: error }, { agyError: 'RESOURCE_EXHAUSTED quota exceeded' }, { error: 'Не получено завершающее событие result.' }, { agyError: error, stderr: 'write_file auto-denied' }, { agyError: error, cancelled: true }, { agyError: error, timedOut: true }, { agyError: 'Пробная ошибка' }]) assert.equal(protocolError(res), null);
  const probe = read(path.join(__dirname, 'team-v6-agy-probe.json')); assert.equal(probe.materialBytes, 82139); assert.equal(probe.records[0].stdout.trim(), '1.2.12'); assert(require('./team-v6-agy-probe').validate(probe.records[2]).ok);
});
test('Р3: close проверяет владельца, сохраняет историю, повтор безопасен; заголовок изменения собственный', async () => {
  const { Team } = require('../common/team'), team = new Team(ROOT, path.join(RUN, 'team'));
  const file = team.changeFile('old-change'); json(file, { name: 'old-change', owner: 'session', status: 'открыто', verdicts: [{ old: true }] });
  await assert.rejects(team.change({ action: 'close', name: 'old-change', owner: 'other', note: 'устарело' }), /владельцу/);
  await assert.rejects(team.change({ action: 'close', name: 'old-change', owner: 'session' }), /причина/);
  assert.match(await team.change({ action: 'close', name: 'old-change', owner: 'session', note: 'устарело' }), /Клон и история сохранены/);
  const closed = fs.readFileSync(file, 'utf8'); await team.change({ action: 'close', name: 'old-change', owner: 'session', note: 'другая причина' }); assert.equal(fs.readFileSync(file, 'utf8'), closed);
  assert.equal(read(file).verdicts.length, 1); assert.equal(require('../common/summary').changeTitle({ name: 'trio-v2' }), 'trio-v2');
  const merged = team.changeFile('merged-change'); json(merged, { name: 'merged-change', owner: 'session', status: 'слито' });
  await assert.rejects(team.change({ action: 'close', name: 'merged-change', owner: 'session', note: 'проверка' }), /Слитое/);
  process.env.MOST_CLIENT = 'codex'; try { await assert.rejects(team.change({ action: 'close', name: 'old-change', owner: 'session', note: 'устарело' }), /Гостю/); } finally { process.env.MOST_CLIENT = 'claude'; }
  const summary = await require('../common/summary').compact({ root: RUN, state: team.state, works: () => [] }, 'Квоты');
  assert.match(summary, /закрыто: 1/); assert(!summary.includes('old-change'));
});
test('Р4: местные даты без ISO; язык правил', () => {
  const summary = require('../common/summary'); assert.match(summary.localTime('2026-09-27T10:55:00Z'), /^27\.09\.2026, \d\d:\d\d$/);
  assert(!summary.mergedLine(RUN, [{ name: 'test', candidate: 'a'.repeat(40), mergedAt: '2026-09-27T10:55:00Z' }]).includes('T10:55'));
  for (const f of fs.readdirSync(path.join(ROOT, 'rules'))) if (f.endsWith('.md')) assert(!/failed\/cancelled/.test(fs.readFileSync(path.join(ROOT, 'rules', f), 'utf8')));
});
test('Р6: уроки связаны с системными замечаниями, ограничения живой проверки явно названы', () => {
  const lessons = fs.readFileSync(path.join(ROOT, 'lessons.md'), 'utf8'), claude = fs.readFileSync(path.join(ROOT, 'rules/claude.md'), 'utf8');
  for (const id of ['2620cf64', 'mujpj61n', '9ff52a91', '517f3148', 'ba7d3e3c']) assert(require('../common/grok-gate').paragraph(lessons, id, ['closed']), id);
  for (let n = 35; n <= 39; n++) { const section = lessons.split('## ' + n + '.')[1]?.split('\n## ')[0]; assert(section?.includes('Где закрыто:') && section.includes('Проверка') && section.includes('Остаточное ограничение:')); }
  assert.match(claude, /описаний новым сеансом не проверено/); assert.match(claude, /Само наличие правильного текста не доказывает доставку/);
});
test('Р5: execute → restart → итог сценария; отказ готовности сохраняется отдельно от отказа запуска', async () => {
  for (const success of [true, false]) {
    const root = path.join(RUN, 'end-to-end-' + success), file = path.join(root, 'state/deploy-ops/operation.json');
    json(file, { id: 'operation', root, createdAt: new Date().toISOString() });
    const execute = () => ops.execute({ result: file, release: 'candidate-release', restartClaude: true }, async () => 'обновлено', {
      restart: options => restart.restart(options, { launch: async (_, info) => {
        assert.equal(read(file).status, 'перезапуск идёт');
        write(info.log, 'итог ' + info.runId + ' ' + (success ? 'True' : 'False') + '\n');
        json(info.result, { runId: info.runId, release: 'candidate-release', startedAt: '2026-09-27T10:00:00Z', finishedAt: '2026-09-27T10:01:00Z', success, reason: 'Пробный итог' });
        for (const name of ['team', 'codex', 'antigravity', 'grok']) json(path.join(root, 'state/ready', name + '.json'), { pid: process.pid, startedAt: '2026-09-27T10:00:30Z', release: 'candidate-release' });
      } }),
    });
    if (success) { await execute(); assert.equal(read(file).status, 'завершено'); assert.equal(read(file).restartEvidence.ready.length, 4); }
    else { await assert.rejects(execute(), /готовность нового Claude не подтверждена/); assert.equal(read(file).status, 'перезапуск не подтверждён'); assert.equal(read(file).restartEvidence, undefined); }
  }
});
test('Р5: завершено только после журнала и свежих живых четырёх серверов своего релиза; отказ/таймаут', async () => {
  const state = path.join(RUN, 'restart-state'), info = { runId: 'run', release: 'release', state, result: path.join(state, 'result.json'), log: path.join(state, 'restart.log') };
  let now = 0; await assert.rejects(restart.waitForCompletion(info, { now: () => now, sleep: async ms => { now += ms; }, completionMs: 500 }), /Истекло время/);
  json(info.result, { runId: 'run', release: 'release', success: false, reason: 'отказ' }); await assert.rejects(restart.waitForCompletion(info), /отказ/);
  const startedAt = '2026-09-27T10:00:00Z'; json(info.result, { runId: 'run', release: 'release', success: true, startedAt, finishedAt: '2026-09-27T10:01:00Z' });
  for (const name of ['team', 'codex', 'antigravity', 'grok']) json(path.join(state, 'ready', name + '.json'), { pid: process.pid, startedAt: '2026-09-27T10:00:30Z', release: 'release' });
  await assert.rejects(restart.waitForCompletion(info), /ENOENT/);
  write(info.log, 'итог run True\n');
  assert.equal((await restart.waitForCompletion(info)).ready.length, 4);
  await assert.rejects(restart.waitForCompletion(info, { alive: () => false }), /Готовность/);
  json(path.join(state, 'ready/grok.json'), { pid: process.pid, startedAt: '2026-09-27T10:00:30Z', release: 'old' }); await assert.rejects(restart.waitForCompletion(info), /Готовность/);
  json(path.join(state, 'ready/grok.json'), { pid: process.pid, startedAt, release: 'release' }); await assert.rejects(restart.waitForCompletion(info), /Готовность/);
  const file = path.join(RUN, 'restart-operation.json'); json(file, { root: RUN }); let complete;
  const pending = ops.execute({ result: file, release: 'release', restartClaude: true }, async () => 'обновлено', { restart: async () => { assert.equal(read(file).status, 'перезапуск идёт'); return await new Promise(r => { complete = r; }); } });
  while (!complete) await new Promise(r => setImmediate(r)); assert.notEqual(read(file).status, 'завершено'); complete({ success: true, message: 'готово', ready: [] }); await pending; assert.equal(read(file).status, 'завершено');
});

test('Круг 1 Р1: роли не зависят от порядка, одиночного файла и произвольного пути', async () => {
  resetRules(); await rules.configure({ files: [...files].reverse() }); checklist();
  resetRules(); await rules.configure({ files: [files[1]] });
  assert(fs.readFileSync(files[1], 'utf8').includes('на диск не пишет'));
  assert(rules.plans([files[1], files[0]])[0].next.includes('на диск не пишет'));
  const other = path.join(RUN, 'arbitrary/AGENTS.md'); write(other, '## Связка четырёх ИИ\nстарое\n');
  assert.throws(() => rules.plans([other]), /Укажите role/);
  assert.match((await rules.configure({ files: [other] })).join(''), /отказ:/);
  assert.equal(fs.readFileSync(other, 'utf8'), '## Связка четырёх ИИ\nстарое\n');
  await rules.configure({ files: [{ file: other, role: 'antigravity' }] });
  assert(fs.readFileSync(other, 'utf8').includes('на диск не пишет'));
  assert(!fs.readFileSync(other, 'utf8').includes('песочнице отдельного пользователя'));
  for (const role of ['codex', 'antigravity']) {
    const template = fs.readFileSync(path.join(ROOT, 'rules/helpers', role + '-section.md'), 'utf8');
    assert.equal(rules.body(role), require('../common/paths').withRoot(template.replace(/\r\n/g, '\n').trimEnd() + '\n', process.env.MOST_REPO_ROOT));
    assert(rules.replace('## Связка четырёх ИИ\nстарое\n', role).includes(rules.body(role)));
  }
  assert(!fs.readFileSync(path.join(ROOT, 'common/client-rules.js'), 'utf8').includes('Claude — дирижёр'));
});
test('Круг 1 Р2: запись живого agy 1.2.12 разбирается без подмены схемы', () => {
  const a = require('../common/agy-input');
  assert.deepEqual(JSON.parse(a.userEvent('материал')), { event: 'user', message: { content: 'материал' } });
  const parsed = a.parseResults(fs.readFileSync(path.join(__dirname, 'fixtures/team-v6/agy-1.2.12-error.ndjson'), 'utf8'));
  assert.equal(parsed.candidates, 1); assert.equal(parsed.obj.status, 'ERROR'); assert.equal(parsed.obj.response, '');
  assert.equal(parsed.obj.error, 'stream input message is missing the "event" field');
  assert.equal(parsed.obj.usage.total_tokens, 0);
  assert.equal(a.parseResults('{"type":"result","status":"SUCCESS","result":"мимо"}').obj, null);
});
test('Круг 1 Р2: диагностические поля отделены от цитат модели и вывода файлов', () => {
  const a = require('../common/agy-input');
  for (const output of ['denied', 'ПРИНЯТО\nПоле denied_actions обрабатывается правильно.', 'Цитата: read_file auto-denied']) assert.equal(a.permission({ output, stderr: '', agyStatus: 'SUCCESS' }), null);
  assert(a.permission({ stderr: 'read_file auto-denied', output: 'ПРИНЯТО' }).retryable);
  assert(a.permission({ agyError: 'read_file permission denied' }).retryable);
  assert.equal(a.permission({ denied: [] }), null);
  assert.equal(a.permission({ denied: [{ tool: 'write_file' }] }).retryable, false);
});
test('Круг 1 Р2: живая проба принимает только ожидаемый успешный итог без отказа', () => {
  const { validate, EXPECTED } = require('./team-v6-agy-probe');
  const record = result => ({ status: 0, stderr: '', stdout: JSON.stringify({ event: 'result', result }) });
  const good = record({ status: 'SUCCESS', response: EXPECTED + '\n' });
  assert(validate(good).ok);
  for (const invalid of [
    { status: 0, stderr: '', stdout: '' }, { status: 0, stdout: '{"event":"init"}' },
    record({ status: 'ERROR', response: EXPECTED }), record({ status: 'SUCCESS', response: '' }),
    record({ status: 'SUCCESS', response: 'чужой ответ' }), record({ status: 'SUCCESS', response: EXPECTED, error: 'ошибка' }),
    { ...good, status: 1 }, { ...good, error: { code: 'EPERM' } }, { ...good, signal: 'SIGTERM' },
    { ...good, stderr: 'read_file auto-denied' },
    { ...good, stdout: JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'read_file', error: { type: 'PERMISSION_DENIED' } } } }) + '\n' + good.stdout },
    { ...good, stdout: good.stdout + '\n' + JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '' } }) },
    record({ status: 'SUCCESS', response: EXPECTED, denied_actions: [{ tool: 'read_file' }] }),
  ]) assert.equal(validate(invalid).ok, false, JSON.stringify(invalid));
  const quoted = { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'read_file auto-denied' } };
  assert(validate({ ...good, stdout: JSON.stringify(quoted) + '\n' + good.stdout }).ok);
});
(async () => { let passed = 0, failed = 0; for (const { label, fn } of tests) { try { await fn(); passed++; console.log('ПРОЙДЕНО: ' + label); } catch (e) { failed++; console.error('ПРОВАЛЕНО: ' + label + '\n' + e.stack); } } console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`); process.exitCode = failed ? 1 : 0; })();
