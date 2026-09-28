'use strict';
// Этот набор проверяет запасной путь и прежний тестовый agy.
process.env.MOST_AGY_INPUT_FORMAT = 'legacy';
const fs = require('fs'), path = require('path'), assert = require('assert');
const crypto = require('crypto'), http = require('http'), { spawn } = require('child_process');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v4-'));
process.env.MOST_REPO_ROOT = RUN;
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_NOTIFY = 'file:' + path.join(RUN, 'notifications.jsonl');
process.env.MOST_CODEX_JOBS_DIR = path.join(RUN, 'state/codex-jobs');
process.env.MOST_CODEX_ARCHIVE_DIR = path.join(RUN, 'archive');
process.env.NODE_ENV = 'test';
const { Grok, sha, parseReply } = require('../common/grok');
const { Team } = require('../common/team');
const g = require('../common/team-git'), ownership = require('../common/work-owner');
const { migrate, marker } = require('../common/state-migration');
const state = process.env.MOST_STATE_DIR;
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const json = (p, value) => write(p, JSON.stringify(value));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let passed = 0, failed = 0, skipped = 0;
const secretKey = 'crsr_FAKE_TEST_PRIVATE_VALUE';
let webhook, url, mode = 'ok', calls = [], captured = new Map();
const grok = new Grok(state, { timeoutMs: 150 });
async function setupWebhook() {
  webhook = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    calls.push(data.id); captured.set(data.id, data);
    assert.equal(req.headers.authorization, 'Bearer ' + secretKey);
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: url }); res.end(); return; }
    if (['401', '404'].includes(mode)) {
      res.writeHead(Number(mode)); res.end('Authorization: Bearer ' + secretKey); return;
    }
    if (mode === 'broken') { res.end('{ Authorization: Bearer ' + secretKey); return; }
    res.end(JSON.stringify(mode === 'false' ? { success: false } : mode === 'missing' ? { success: true }
      : { success: true, runUuid: 'run-' + data.id }));
  });
  await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + webhook.address().port + '/hook';
  process.env.MOST_GROK_TEST_URL = url;
  json(path.join(state, 'grok-webhook.json'), { url, key: secretKey });
}
function signed(job, body = 'ПРИНЯТО', key = captured.get(job.id).secret_hex, eol = '\n') {
  const payload = Buffer.from('Ответ на ' + job.id + ', материал ' + job.materialHash + eol + body + eol);
  const signature = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex');
  return Buffer.concat([payload, Buffer.from('КОНТРОЛЬ ' + signature + eol + 'КОНЕЦ ОТВЕТА' + eol)]);
}
const send = async () => grok.send({ task: '#2bbf4317 Проверка материала', text: 'Материал для проверки' });

test('Grok: карточка и неизменяемый бриф существуют до POST, успех и секрет вне брифа', async () => {
  await setupWebhook();
  const job = await send();
  assert.equal(job.status, 'running');
  const payload = captured.get(job.id);
  assert.equal(payload.brief_path, path.join(state, 'grok/briefs', job.id + '.md'));
  const brief = fs.readFileSync(payload.brief_path, 'utf8');
  assert(brief.includes('#2bbf4317') && brief.includes(job.materialHash) && brief.includes('HMACSHA256'));
  assert(!brief.includes(payload.secret_hex) && !JSON.stringify(job).includes(payload.secret_hex));
  assert.equal(fs.statSync(grok.file('jobs', job.id, '.key')).size, 32);
  assert.equal(sha(brief), job.briefHash);
});
for (const [reply, expected] of [['401', 'failed'], ['404', 'failed'], ['false', 'delivery_unclear'],
  ['missing', 'delivery_unclear'], ['broken', 'delivery_unclear'], ['redirect', 'delivery_unclear'],
  ['disconnect', 'delivery_unclear'], ['timeout', 'delivery_unclear']]) {
  test('Grok: доставка ' + reply + ', без повтора и утечки', async () => {
    mode = reply;
    const before = calls.length, job = await send();
    assert.equal(job.status, expected);
    assert.equal(calls.length, before + 1);
    assert(!JSON.stringify(job).includes(secretKey));
    await new Grok(state).refresh(job.id);
    assert.equal(calls.length, before + 1);
    mode = 'ok';
  });
}
test('Grok: неверный адрес, отсутствующая и повреждённая настройка не отправляют ключ', async () => {
  const isolated = path.join(RUN, 'bad-config'), bridge = new Grok(isolated);
  await assert.rejects(bridge.send({ task: 'Проверка' }), /нет файла/);
  const file = path.join(isolated, 'grok-webhook.json');
  for (const address of ['https://api2.cursor.sh.evil/automations/webhook/x',
    'https://user:pass@api2.cursor.sh/automations/webhook/x', 'http://api2.cursor.sh/automations/webhook/x']) {
    json(file, { url: address, key: secretKey });
    await assert.rejects(bridge.send({ task: 'Проверка' }), /адрес вебхука/);
  }
  write(file, '{' + secretKey);
  await assert.rejects(bridge.send({ task: 'Проверка' }), e =>
    /повреждён/.test(e.message) && !e.message.includes(secretKey));
});
test('Grok: временный файл не готов; CRLF, подпись и снимок переживают перезапуск', async () => {
  const job = await send(), payload = captured.get(job.id), answer = signed(job, 'КОНТРОЛЬ внутри\r\nПРИНЯТО',
    payload.secret_hex, '\r\n');
  write(payload.reply_path + '.tmp', answer);
  assert.equal((await grok.refresh(job.id)).status, 'running');
  write(payload.reply_path, answer);
  const restarted = new Grok(state), done = await restarted.refresh(job.id);
  assert.equal(done.status, 'done'); assert.equal(done.verdict, 'ПРИНЯТО');
  assert.equal(fs.statSync(grok.file('jobs', job.id, '.key')).size, 0);
  write(payload.reply_path, 'Подменён после принятия');
  assert(restarted.resultText(await restarted.refresh(job.id)).includes('ПРИНЯТО'));
  assert(fs.readFileSync(grok.file('jobs', job.id, '.result.txt')).equals(answer));
});
test('Grok: чужой номер и материал, нет подписи, подмена до принятия и чужой ключ', async () => {
  const job = await send(), other = await send(), file = captured.get(job.id).reply_path;
  for (const answer of [signed(other), Buffer.from('Ответ на ' + job.id + '\nПРИНЯТО\nКОНЕЦ ОТВЕТА'),
    Buffer.from(signed(job).toString().replace('ПРИНЯТО', 'НЕ ПРИНЯТО: 1 блокирующих')),
    signed(job, 'ПРИНЯТО', captured.get(other.id).secret_hex)]) {
    write(file, answer);
    const current = await grok.refresh(job.id);
    assert.equal(current.status, 'running');
    assert.match(current.reason, /устаревший|подложный/);
  }
  write(file, signed(job)); assert.equal((await grok.refresh(job.id)).status, 'done');
});
// team-v13 Р1, случаи 1–4: метка подписи в любом регистре, hex в любом регистре; подлинность — только HMAC.
test('Grok: «Контроль» и «контроль» с верным HMAC приняты, с неверным — нет; hex заглавными; неполная строка', async () => {
  const relabel = (buf, label, upper = false) => Buffer.from(buf.toString('utf8').replace(/КОНТРОЛЬ ([0-9a-f]{64})/, (m, h) => label + ' ' + (upper ? h.toUpperCase() : h)));
  for (const [label, upper, body, eol] of [['Контроль', false], ['контроль', false], ['КОНТРОЛЬ', true], ['кОнТрОлЬ', false, 'Ёж и 😀 вне BMP\r\nПРИНЯТО', '\r\n']]) {
    const job = await send(), p = captured.get(job.id);
    write(p.reply_path, relabel(signed(job, body, p.secret_hex, eol), label, upper));
    const done = await grok.refresh(job.id);
    assert.equal(done.status, 'done', label); assert.equal(done.verdict, 'ПРИНЯТО');
  }
  const job = await send(), other = await send(), p = captured.get(job.id);
  for (const answer of [relabel(signed(job, 'ПРИНЯТО', captured.get(other.id).secret_hex), 'контроль'),
    Buffer.from(signed(job).toString('utf8').replace(/КОНТРОЛЬ ([0-9a-f]{64})/, (m, h) => 'Контроль ' + h.slice(1))),
    Buffer.from(signed(job).toString('utf8').replace(/КОНТРОЛЬ ([0-9a-f]{64})/, (m, h) => 'Контроль ' + h.slice(1) + 'z')),
    relabel(Buffer.from(signed(job).toString('utf8').replace('ПРИНЯТО', 'ПРИНЯТ0')), 'контроль')]) {
    write(p.reply_path, answer);
    const current = await grok.refresh(job.id);
    assert.equal(current.status, 'running'); assert.match(current.reason, /подложный/);
  }
  write(p.reply_path, Buffer.from(signed(job).toString('utf8').replace('КОНЕЦ ОТВЕТА', '')));
  assert.equal((await grok.refresh(job.id)).status, 'running', 'без «КОНЕЦ ОТВЕТА» — ещё пишется');
  write(p.reply_path, signed(job)); assert.equal((await grok.refresh(job.id)).status, 'done');
});
test('Grok: изменённый бриф и секрет в ответе не принимаются', async () => {
  const job = await send(), p = captured.get(job.id);
  write(p.reply_path, signed(job, p.secret_hex + '\nПРИНЯТО'));
  assert.match((await grok.refresh(job.id)).reason, /содержит секрет/);
  write(p.reply_path, signed(job));
  fs.appendFileSync(p.brief_path, '\nПодмена');
  assert.match((await grok.refresh(job.id)).reason, /бриф изменён/);
});
test('Grok: готовая команда PowerShell действительно подписывает ответ на Windows', async () => {
  const job = await send(), p = captured.get(job.id), answer = p.reply_path + '.tmp';
  write(answer, 'Ответ на ' + job.id + ', материал ' + job.materialHash + '\r\nПРИНЯТО\r\n');
  const brief = fs.readFileSync(p.brief_path, 'utf8');
  const script = brief.match(/```powershell\n([\s\S]+?)\n```/)[1]
    .replaceAll('<reply_path>', p.reply_path).replace('<secret_hex из вебхука>', p.secret_hex);
  const command = Buffer.from('$ErrorActionPreference = "Stop"\n' + script, 'utf16le').toString('base64');
  const result = require('child_process').spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await grok.refresh(job.id)).status, 'done');
});
test('Grok: ссылка на чужой файл ответа отклоняется по реальному пути', async () => {
  const job = await send(), outside = path.join(RUN, 'outside'); fs.mkdirSync(outside);
  const real = path.join(outside, 'answer.md'); write(real, signed(job));
  try { fs.symlinkSync(real, captured.get(job.id).reply_path); }
  catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) return { skip: 'Windows запрещает создание ссылки на файл.' };
    throw e;
  }
  await assert.rejects(grok.refresh(job.id), /Путь Grok/);
  // Карточку помечаем отдельно: последующие общие статусы не должны обходить запрет ссылки.
  job.status = 'done'; grok.save(job);
});
test('Grok: переход каталога отклоняется по реальному пути', () => {
  const outside = path.join(RUN, 'outside');
  const isolated = path.join(RUN, 'junction-state'); fs.mkdirSync(isolated);
  fs.mkdirSync(path.join(isolated, 'grok'));
  fs.symlinkSync(outside, path.join(isolated, 'grok/briefs'), 'junction');
  assert.throws(() => new Grok(isolated).file('briefs', 'id'), /Путь|пределы|Ссылки/);
});
test('Grok: 60 минут, поздние данные, отмена и явный повтор с новым номером', async () => {
  for (const delivery of ['ok', 'false']) {
    mode = delivery;
    const job = await send(), answer = signed(job);
    job.startedAt = new Date(Date.now() - 3600001).toISOString(); grok.save(job);
    const lost = await grok.refresh(job.id); assert.equal(lost.status, 'lost');
    assert.equal(fs.statSync(grok.file('jobs', job.id, '.key')).size, 0);
    write(captured.get(job.id).reply_path, answer);
    assert.match((await grok.refresh(job.id)).reason, /поздний ответ/);
    assert.throws(() => require('../common/team-store').review('grok', job.id, null, null), /завершённое/);
  }
  mode = 'ok';
  const job = await send(), answer = signed(job);
  assert.match((await grok.cancel(job.id)).reason, /остановить рутину/);
  write(captured.get(job.id).reply_path, answer);
  assert.equal((await grok.refresh(job.id)).status, 'cancelled');
  const retry = await grok.send({ task: job.task, retry_of: job.id });
  assert.notEqual(retry.id, job.id);
  assert(fs.readFileSync(captured.get(retry.id).brief_path, 'utf8').includes('повтор ' + job.id));
});
test('Grok: подтверждение не сохранено после POST — ожидание по прежнему номеру', async () => {
  const job = await send(), count = calls.length;
  job.status = 'delivery_unclear'; delete job.runUuid; grok.save(job);
  write(captured.get(job.id).reply_path, signed(job));
  assert.equal((await new Grok(state).refresh(job.id)).status, 'done');
  assert.equal(calls.length, count);
});
test('Grok: проверенный голос и постраничное чтение', async () => {
  const hash = sha('замысел'), task = '#2bbf4317 ' + hash;
  const job = await grok.send({ task, text: 'Материал' });
  write(captured.get(job.id).reply_path, signed(job, 'А'.repeat(25000) + '\nПРИНЯТО'));
  const done = await grok.refresh(job.id);
  assert.match(grok.resultText(done), /from_char=24000/);
  assert(grok.resultText(done, 24000).includes('ПРИНЯТО'));
  const review = require('../common/team-store').review('grok', job.id, null, null,
    'ПРИНЯТО', '#2bbf4317', hash);
  assert.equal(review.verdict, 'ПРИНЯТО');
  assert.throws(() => require('../common/team-store').review('grok', job.id, null, null,
    'ПРИНЯТО', '#00000000', hash), /метки запроса/);
  assert.equal(parseReply(Buffer.from('Пишется')), null);
});

const team = new Team(RUN, path.join(state, 'team'));
const stages = [{ title: 'Проверка', weight: 100, accept_criteria: 'Есть проверка', state: 'идёт' }];
test('Владение: живая работа не передаётся, два претендента — один, старый владелец остановлен', async () => {
  await assert.rejects(team.work({ action: 'create', name: 'no-owner', expected_revision: 0 }), /метка владельца/);
  await team.work({ action: 'create', name: 'owned', owner: 'first', expected_revision: 0,
    goal: 'Проверить владение', done_criteria: 'Нет гонок', next_step: 'Проверить', stages });
  await assert.rejects(team.work({ action: 'claim', name: 'owned', owner: 'second', expected_revision: 1 }),
    /Работа жива/);
  const file = team.workFile('owned'), work = read(file);
  work.heartbeat_at = new Date(Date.now() - 3601000).toISOString(); json(file, work);
  const results = await Promise.allSettled(['second', 'third'].map(owner =>
    team.work({ action: 'claim', name: 'owned', owner, expected_revision: 1 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(team.work({ action: 'get', name: 'owned', owner: 'first' }), /владение передано/);
  await assert.rejects(team.work({ action: 'list', owner: 'first' }), /владение передано/);
  const before = grok.list().length;
  await assert.rejects(grok.send({ task: 'Проверка', work: 'owned', stage: 'Проверка', owner: 'first' }),
    /владение передано/);
  assert.equal(grok.list().length, before);
});
test('Владение: живое поручение старше часа блокирует передачу, send обновляет heartbeat', async () => {
  const file = team.workFile('owned'), work = read(file);
  work.heartbeat_at = new Date(Date.now() - 7200000).toISOString(); json(file, work);
  const jobFile = path.join(state, 'codex-jobs/live.json');
  for (const status of ['running', 'queued', 'waiting_quota', 'delivery_unclear']) {
    json(jobFile, { id: 'live', work: 'owned', status, startedAt: work.heartbeat_at });
    await assert.rejects(team.work({ action: 'claim', name: 'owned', owner: 'fourth',
      expected_revision: work.revision }), /Работа жива/);
  }
  json(jobFile, { id: 'live', work: 'owned', status: 'done' });
  await grok.send({ task: 'Проверка', work: 'owned', stage: 'Проверка', owner: work.owner });
  assert(Date.now() - Date.parse(read(file).heartbeat_at) < 5000);
});
test('Статус: 15 минут, первая строка всех ответов, status_sent и завершённая работа', async () => {
  const file = team.workFile('owned'), work = read(file);
  work.created_at = new Date(Date.now() - 16 * 60000).toISOString(); json(file, work);
  for (const who of ['Команда', 'Codex', 'Antigravity', 'Grok']) {
    assert(require('../common/format').format(who, { status: 'failed' }, 'Проверка')
      .startsWith('⚠ Статус пользователю не отправлялся 16 мин'));
  }
  await team.work({ action: 'update', name: 'owned', owner: work.owner,
    expected_revision: work.revision, status_sent: true });
  assert.equal(ownership.reminder(), '');
  const current = read(file);
  current.stages[0].state = 'принят'; current.status_sent_at = work.created_at; json(file, current);
  assert.equal(ownership.reminder(), '');
});

function oldJob(source, id, text = 'ПРИНЯТО', kind = 'jobs') {
  const dir = path.join(source, kind, ...(kind === 'jobs' ? [id] : []));
  const result = path.join(dir, kind === 'jobs' ? 'result.txt' : id + '.attempt-0.result.txt');
  write(result, text);
  json(path.join(dir, kind === 'jobs' ? 'meta.json' : id + '.meta.json'), { hash: sha(text) });
  json(path.join(dir, kind === 'jobs' ? 'card.json' : id + '.json'), {
    id, status: 'done', task: '#2bbf4317 ' + sha('замысел'), mode: 'review', resultFile: result,
    ...(kind === 'jobs' ? {} : { metaFile: path.join(dir, id + '.meta.json') }),
  });
}
test('Перенос: разные комплекты сохранены, конфликт блокирует ревью', async () => {
  const root = path.join(RUN, 'migration-conflict'), target = path.join(root, 'state');
  const sources = [path.join(root, 'first'), path.join(root, 'second')];
  for (const kind of ['jobs', 'codex-jobs']) {
    oldJob(sources[0], 'same', 'ПРИНЯТО', kind);
    oldJob(sources[1], 'same', 'НЕ ПРИНЯТО: 1 блокирующих', kind);
  }
  const result = await migrate({ root, state: target, sources });
  assert.equal(result.conflicts.length, 2); assert(fs.existsSync(marker(target)));
  for (const kind of ['jobs', 'codex-jobs']) {
    const card = read(path.join(target, kind, 'same/card.json'));
    assert.equal(card.status, 'migration_conflict');
    assert.equal(fs.readdirSync(path.join(target, kind)).filter(n => n.includes('.conflict-')).length, 1);
    assert(card.resultFile.startsWith(path.join(target, kind)));
  }
});
test('Перенос: обрыв до публикации не оставляет половины; повтор завершает перенос', async () => {
  const root = path.join(RUN, 'migration-interrupt'), target = path.join(root, 'state');
  const source = path.join(root, 'source'); oldJob(source, 'old');
  await assert.rejects(migrate({ root, state: target, sources: [source],
    hook: async phase => { if (phase === 'before_publish') throw Error('Обрыв'); } }), /Обрыв/);
  assert(!fs.existsSync(marker(target))); assert(!fs.existsSync(path.join(target, 'jobs/old')));
  await migrate({ root, state: target, sources: [source] });
  assert.equal(read(path.join(target, 'jobs/old/card.json')).status, 'done');
  assert.equal(fs.readFileSync(path.join(target, 'jobs/old/result.txt'), 'utf8'), 'ПРИНЯТО');
});
test('Перенос: повреждённый результат изолирован, готовность установлена', async () => {
  const root = path.join(RUN, 'migration-incomplete'), target = path.join(root, 'state');
  const source = path.join(root, 'source'); oldJob(source, 'bad');
  write(path.join(source, 'jobs/bad/result.txt'), 'Подмена');
  await migrate({ root, state: target, sources: [source] });
  assert(fs.existsSync(marker(target)));
  assert.equal(read(path.join(target, 'quarantine/bad/card.json')).status, 'migration_damaged');
  assert(!fs.existsSync(path.join(target, 'jobs/bad')));
});
test('Перенос: входные файлы ожидающего задания и пути повтора переезжают вместе', async () => {
  const root = path.join(RUN, 'migration-input'), target = path.join(root, 'state');
  const source = path.join(root, 'source'), input = path.join(source, 'input/queued');
  write(path.join(input, 'material.txt'), 'Материал для повторной попытки');
  json(path.join(source, 'jobs/queued/card.json'), { id: 'queued', status: 'waiting_quota',
    retry: { inputDir: input, args: ['--add-dir', input, '--print', 'Читайте ' + path.join(input, 'material.txt')] } });
  await migrate({ root, state: target, sources: [source] });
  const card = read(path.join(target, 'jobs/queued/card.json'));
  assert.equal(card.retry.inputDir, path.join(target, 'jobs/queued/input'));
  assert(!card.retry.args.join(' ').includes(source));
  assert.equal(fs.readFileSync(path.join(card.retry.inputDir, 'material.txt'), 'utf8'),
    'Материал для повторной попытки');
});
function child(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { output += b; });
    p.on('error', reject); p.on('close', code => code ? reject(Error(output)) : resolve(output));
  });
}
test('Перенос: три одновременных процесса, один опубликованный комплект', async () => {
  const root = path.join(RUN, 'migration-processes'), target = path.join(root, 'state');
  const source = path.join(root, 'source'); oldJob(source, 'old');
  const modulePath = path.resolve(__dirname, '../common/state-migration.js');
  const code = `require(${JSON.stringify(modulePath)}).migrate(${JSON.stringify({ root, state: target,
    sources: [source] })}).catch(e=>{console.error(e);process.exitCode=1})`;
  await Promise.all([0, 1, 2].map(() => child(['-e', code], { MOST_STATE_DIR: target })));
  assert(fs.existsSync(marker(target)));
  assert.equal(read(path.join(target, 'migration.log')).copied, 1);
});
test('Перенос: одновременно запущенные team, codex и antigravity ждут общую метку', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const root = path.join(RUN, 'migration-servers'), target = path.join(root, 'state');
  const local = path.join(root, 'local'); oldJob(path.join(local, 'most'), 'review');
  const clients = ['team', 'codex', 'antigravity'].map(who => {
    const client = new Client({ name: 'test', version: '1' });
    const env = { ...process.env, LOCALAPPDATA: local, MOST_CLIENT: 'claude', MOST_PROBE_ONLY: '0',
      MOST_REPO_ROOT: root, MOST_STATE_DIR: target, MOST_CODEX_JOBS_DIR: path.join(target, 'codex-jobs'),
      MOST_INPUT_DIR: path.join(target, 'input'), MOST_JOURNAL: path.join(target, 'journal.txt'),
      CODEX_PATH: path.join(__dirname, 'fake-codex.js'), AGY_PATH: path.join(__dirname, 'fake-agy.js') };
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, '../servers', who, 'index.js')], env, stderr: 'pipe' });
    return { client, transport, who };
  });
  try {
    await Promise.all(clients.map(async ({ client, transport }) => {
      await client.connect(transport); assert(fs.existsSync(marker(target)));
    }));
    assert.equal(read(path.join(target, 'migration.log')).copied, 1);
    assert.equal(read(path.join(target, 'jobs/review/card.json')).status, 'done');
  } finally { await Promise.all(clients.map(({ client }) => client.close())); }
});

test('Git: живой процесс и свежий замок — отказ; старый замок сохранён', () => {
  const root = path.join(RUN, 'lock-test'), lock = path.join(root, '.git/index.lock');
  write(lock, 'Сохранить');
  assert.throws(() => g.checkIndexLock(root, { processes: () => '' }), /git занят/);
  const date = new Date(Date.now() - 121000); fs.utimesSync(lock, date, date);
  assert.throws(() => g.checkIndexLock(root, { processes: () => '"git.exe","123"' }), /git занят/);
  g.checkIndexLock(root, { processes: () => '' });
  assert(!fs.existsSync(lock));
  const renamed = fs.readdirSync(path.dirname(lock)).find(n => n.startsWith('index.lock.stale-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(lock), renamed), 'utf8'), 'Сохранить');
});
test('Сквозная проверка: старое ревью → перенос → голоса → commit; замысел изменён → merge отказ', async () => {
  const root = path.join(RUN, 'gates'); fs.mkdirSync(root);
  g.git(root, ['init', '-b', 'main']);
  for (const dir of [root]) {
    g.git(dir, ['config', 'user.name', 'Тест']); g.git(dir, ['config', 'user.email', 'test@example.invalid']);
  }
  write(path.join(root, '.gitignore'), '.work/\nworks/\nstate/\n');
  write(path.join(root, 'source.txt'), 'База');
  g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'База проверки']);
  const team = new Team(root, path.join(state, 'team-gates'));
  const design = path.join(root, 'design.md'); write(design, 'Замысел для проверки');
  await team.change({ action: 'start', name: 'gate', request: 'Проверить полный перенос старого ревью',
    design_file: design });
  const card = read(team.changeFile('gate')), source = path.join(RUN, 'old-reviews');
  const ids = { codex: crypto.randomUUID(), antigravity: crypto.randomUUID() };
  for (const [who, id] of Object.entries(ids)) {
    const kind = who === 'codex' ? 'codex-jobs' : 'jobs'; oldJob(source, id, 'ПРИНЯТО', kind);
    const file = path.join(source, kind, who === 'codex' ? id + '.json' : id + '/card.json');
    const job = read(file); job.task = card.requestMark + ' ' + card.designHash; json(file, job);
  }
  await migrate({ root: RUN, state, sources: [source] });
  for (const [who, id] of Object.entries(ids)) {
    const jobs = require('../common/team-store').list(who, false).jobs;
    assert(jobs.find(j => j.id === id).resultFile.startsWith(state));
    await team.change({ action: 'design', name: 'gate', who, job_id: id, decision: 'ПРИНЯТО' });
  }
  const clone = team.clone('gate');
  g.git(clone, ['config', 'user.name', 'Тест']); g.git(clone, ['config', 'user.email', 'test@example.invalid']);
  write(path.join(clone, 'source.txt'), 'Кандидат');
  await team.change({ action: 'commit', name: 'gate', message: 'Кандидат проверки' });
  const candidate = read(team.changeFile('gate'));
  assert.equal(candidate.candidateDesignHash, card.designHash);
  for (const who of ['claude', 'codex', 'antigravity']) {
    let id;
    if (who !== 'claude') {
      id = crypto.randomUUID();
      const dir = path.join(state, who === 'codex' ? 'codex-jobs' : 'jobs/' + id);
      const result = path.join(dir, who === 'codex' ? id + '.txt' : 'result.txt');
      write(result, 'ПРИНЯТО');
      json(path.join(dir, who === 'codex' ? id + '.json' : 'card.json'), {
        id, status: 'done', mode: 'review', resultFile: result,
        task: candidate.requestMark + ' ' + candidate.base + ' ' + candidate.candidate,
      });
      if (who === 'antigravity') json(path.join(dir, 'meta.json'), { hash: sha('ПРИНЯТО') });
    }
    await team.change({ action: 'verdict', name: 'gate', who, job_id: id, base: candidate.base,
      candidate: candidate.candidate, decision: 'ПРИНЯТО' });
  }
  write(design, 'Замысел изменён после принятия кандидата');
  await assert.rejects(team.change({ action: 'merge', name: 'gate' }), /Замысел изменён/);
  assert.equal(g.hash(root), candidate.base);
  assert.equal(read(team.changeFile('gate')).designVotes.length, 0);
});
test('Владение: commit, merge и deploy от старого владельца не меняют репозиторий', async () => {
  const root = path.join(RUN, 'gates'), team = new Team(root, path.join(state, 'team-gates'));
  const file = team.changeFile('gate'), card = read(file);
  card.work = 'owned'; json(file, card);
  json(path.join(root, 'works/owned.json'), { name: 'owned', owner: 'new-owner', claimed_at: 'сейчас',
    revision: 2, stages, reminders: [], goal: 'Цель', next_step: 'Далее', done_criteria: 'Проверка' });
  const candidate = g.hash(team.clone('gate'), card.candidate);
  for (const action of ['commit', 'merge']) {
    await assert.rejects(team.change({ action, name: 'gate', owner: 'old-owner', message: 'Не выполнять' }),
      /владение передано/);
    assert.equal(g.hash(team.clone('gate'), card.candidate), candidate);
  }
  // Карточка изменения уже слитого коммита тоже обязана проверяться до публикации релиза.
  card.candidate = g.hash(root); json(file, card);
  await assert.rejects(team.change({ action: 'deploy', name: 'gate', owner: 'old-owner' }), /владение передано/);
  assert(!fs.existsSync(path.join(root, 'live', card.candidate)));
  assert(!fs.existsSync(path.join(root, 'live/deployed.json')));
});
test('MCP: все send отклоняют прежнего владельца до создания поручения и входных файлов', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  for (const who of ['codex', 'antigravity', 'grok']) {
    const isolated = path.join(RUN, 'stale-' + who);
    const env = { ...process.env, MOST_REPO_ROOT: RUN, MOST_STATE_DIR: isolated,
      MOST_CODEX_JOBS_DIR: path.join(isolated, 'codex-jobs'), MOST_INPUT_DIR: path.join(isolated, 'input'),
      MOST_JOURNAL: path.join(isolated, 'journal.txt'), CODEX_PATH: path.join(__dirname, 'fake-codex.js'),
      AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_PROBE_ONLY: '1', MOST_CLIENT: 'claude' };
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, '../servers', who, 'index.js')], env, stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    try {
      const response = await client.callTool({ name: who + '_send', arguments: {
        task: 'Не выполнять', folder: RUN, text: 'Не записывать', work: 'owned', stage: 'Проверка', owner: 'first',
      } });
      assert(response.isError); assert.match(response.content[0].text, /владение передано/);
      for (const folder of ['codex-jobs', 'jobs', 'grok-jobs', 'input']) {
        const dir = path.join(isolated, folder);
        assert(!fs.existsSync(dir) || !fs.readdirSync(dir).length);
      }
    } finally { await client.close(); }
  }
});
test('MCP: все инструменты — напоминание первой строкой и проверка видимого словаря', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const file = team.workFile('owned'), work = read(file);
  work.stages[0].state = 'идёт';
  work.status_sent_at = new Date(Date.now() - 16 * 60000).toISOString(); json(file, work);
  for (const who of ['team', 'codex', 'antigravity', 'grok']) {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, '../servers', who, 'index.js')], stderr: 'pipe',
      env: { ...process.env, MOST_CLIENT: 'claude', MOST_PROBE_ONLY: '1',
        CODEX_PATH: path.join(__dirname, 'fake-codex.js'),
        MOST_CODEX_CONFIG: path.join(RUN, 'missing.toml'), AGY_PATH: path.join(__dirname, 'fake-agy.js'),
        MOST_INPUT_DIR: path.join(state, 'input'), MOST_JOURNAL: path.join(state, 'journal.txt') } });
    try {
      await client.connect(transport);
      const forbidden = /\b(?:RUNNING|WAITING_QUOTA|DELIVERY_UNCLEAR|CANCELLED|FAILED|QUEUED|DONE)\b/;
      const translit = /\b(?:most_itog|most_poruchit|grok_itog|zhdat_sek|papka_proekta|sostoyanie)\b/;
      for (const tool of (await client.listTools()).tools) {
        assert(!translit.test(JSON.stringify(tool)));
        const result = await client.callTool({ name: tool.name, arguments: {} });
        const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        assert(text.startsWith('⚠ Статус пользователю не отправлялся 16 мин'), tool.name + ': ' + text);
        assert(!forbidden.test(text) && !translit.test(text), tool.name + ': ' + text);
      }
    } finally { await client.close(); }
  }
  work.stages[0].state = 'принят'; json(file, work);
});
test('Подключения: Grok в Claude и гостях, запрет отмены гостям', async () => {
  const deploy = require('../common/deploy'), cc = require('../common/client-configs');
  const config = deploy.configFor({}, RUN, RUN);
  assert(config.mcpServers.grok);
  assert(cc.toml('', RUN, RUN, state, process.execPath).includes('[mcp_servers.grok]'));
  for (const client of ['codex', 'antigravity', 'claude']) {
    const tools = await require('../common/probe').probe(path.join(__dirname, '../servers/grok/index.js'),
      { ...process.env, MOST_CLIENT: client, MOST_PROBE_ONLY: '1' });
    assert.equal(tools.tools.length, client === 'claude' ? 4 : 3);
    assert.equal(tools.tools.some(t => t.name === 'grok_cancel'), client === 'claude');
  }
});
test('Тексты: словарь состояний русский, нет прежних имён инструментов Grok', () => {
  const values = Object.values(require('../common/states'));
  assert(values.includes('ДОСТАВКА НЕЯСНА') && values.includes('ПЕРЕНОС: КОНФЛИКТ'));
  assert(values.every(s => !/[a-z]/i.test(s)));
  for (const who of ['Команда', 'Codex', 'Antigravity', 'Grok']) {
    assert(require('../common/format').format(who, { status: 'done' }).startsWith('Команда · сводка · '));
  }
  const rules = fs.readFileSync(path.join(__dirname, '../rules/grok.md'), 'utf8');
  for (const forbidden of ['grok_itog', 'grok_poruchit', 'zhdat_sek', 'nomer']) {
    assert(!rules.includes(forbidden));
  }
});

(async () => {
  try {
    for (const { name, fn } of tests) {
      try {
        const outcome = await fn();
        if (outcome?.skip) { skipped++; console.log('○ ' + name + ': ' + outcome.skip); }
        else { passed++; console.log('✓ ' + name); }
      }
      catch (e) { failed++; console.error('ПРОВАЛ ' + name + '\n' + e.stack); }
    }
  } finally {
    webhook?.closeAllConnections();
    if (webhook) await new Promise(resolve => webhook.close(resolve));
  }
  console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено ${skipped}`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
