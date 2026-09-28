'use strict';
// Этот набор проверяет запасной путь и прежний тестовый agy.
process.env.MOST_AGY_INPUT_FORMAT = 'legacy';
const fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const ROOT = path.resolve(__dirname, '..'),
  RUN = path.join(__dirname, '.tmp-part1-' + Date.now());
fs.mkdirSync(RUN, { recursive: true });
process.env.MOST_STATE_DIR = path.join(RUN, 'unit-state');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_REPO_ROOT = RUN;
fs.mkdirSync(path.join(RUN, 'works'));
fs.writeFileSync(path.join(RUN, 'works/bridge.json'), JSON.stringify({name:'bridge', revision:1,
  goal:'Проверка', done_criteria:'Проверено', next_step:'Проверка', reminders:[],
  stages:[{title:'Ревью',weight:100,state:'идёт',accept_criteria:'Проверено'}]}));
const q = require('../common/quota'),
  { format } = require('../common/format'),
  states = require('../common/states'),
  locks = require('../common/locks'),
  { probe } = require('../common/probe');
let passed = 0,
  failed = 0;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(c, m) {
  if (c) {
    passed++;
  } else {
    failed++;
    console.log('ПРОВАЛ: ' + m);
  }
}
const env = {
  ...process.env,
  MOST_STATE_DIR: path.join(RUN, 'state'),
  MOST_TEST_KEEP: '1',
  MOST_QUEUE_TICK_MS: '40',
  MOST_QUOTA_RETRY_MS: '100',
  MOST_RATE_RETRY_MS: '100',
  CODEX_PATH: path.join(__dirname, 'fake-codex.js'),
  AGY_PATH: path.join(__dirname, 'fake-agy.js'),
  MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
  MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'),
  FAKE_CODEX_LOG: path.join(RUN, 'codex.jsonl'),
  FAKE_AGY_LOG: path.join(RUN, 'agy.jsonl'),
};
async function start(kind, extra = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'servers', kind, 'index.js')],
    env: { ...env, ...extra },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'part1_test', version: '1.0.0' });
  await client.connect(transport);
  const b = { client, transport, kind, errors: '' };
  transport.stderr.on('data', (d) => {
    b.errors += d;
  });
  clients.push(b);
  return b;
}
async function call(b, name, args = {}) {
  const r = await b.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  return { text: r.content.map((c) => c.text || '').join('\n'), error: r.isError };
}
function id(r) {
  return r.text.match(/Номер поручения: ([\w-]+)/)?.[1] || r.text.match(/поручение ([\w-]+)/)?.[1];
}
async function result(b, j, predicate = /ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|НУЖНО РЕШЕНИЕ/, ms = 10000) {
  let r;
  const end = Date.now() + ms;
  do {
    r = await call(b, b.kind + '_result', { id: j, wait_sec: 0, ...(b.kind === 'antigravity' ? { full: true } : {}) });
    if (predicate.test(r.text.split('\n')[0])) return r;
    await sleep(80);
  } while (Date.now() < end);
  throw Error('Не дождались ' + j + ': ' + r.text + '\n' + b.errors);
}
function project() {
  const d = path.join(RUN, 'project-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(d);
  return d;
}
async function test(name, fn) {
  try {
    await fn();
    console.log('✓ ' + name);
  } catch (e) {
    failed++;
    console.log('ПРОВАЛ ' + name + ': ' + e.stack);
  }
}
(async () => {
  console.log('Дополнительные тесты: ' + process.platform + ' ' + process.version + '; ' + RUN);
  await test('Codex: защита обработчиков и уборка временной записи', async () => {
    const { guarded } = require('../common/cards');
    const original = console.error,
      messages = [];
    console.error = (message) => messages.push(message);
    try {
      await guarded(() => {
        throw Object.assign(Error('SECRET'), { code: 'EBUSY' });
      })();
      await guarded(async () => {
        throw Error('SECRET');
      })();
    } finally {
      console.error = original;
    }
    ok(
      messages.length === 2 && messages.every((m) => !m.includes('SECRET')),
      'синхронный и асинхронный сбой перехвачены',
    );
    const source = fs.readFileSync(path.join(ROOT, 'servers/codex/index.js'), 'utf8');
    const save = source.slice(source.indexOf('function save('), source.indexOf('function load('));
    let renamed = 0,
      removed = 0;
    const failure = Object.assign(Error('busy'), { code: 'EBUSY' });
    const context = {
      file: () => '/virtual/card.json',
      randomUUID: () => 'temp',
      fs: {
        openSync: () => 1,
        writeFileSync: () => {},
        fsyncSync: () => {},
        closeSync: () => {},
        renameSync: () => {
          renamed++;
          throw failure;
        },
        unlinkSync: () => {
          removed++;
          throw Error('cleanup denied');
        },
      },
      Atomics: { wait: () => {} },
      Int32Array,
      SharedArrayBuffer,
    };
    const attempt = require('vm').runInNewContext(save + ';save', context);
    assert.throws(
      () => attempt({ id: 'job' }),
      (e) => e === failure,
    );
    ok(
      renamed === 9 && removed === 1,
      'после окончательного сбоя переименования предпринята уборка; её ошибка подавлена',
    );
  });
  await test('формат и словарь', async () => {
    for (const st of Object.keys(states)) {
      const s = format(
        'Codex',
        { id: 'abcd', status: st, durationSec: 130, stage: 'Проверка', work: 'bridge' },
        'Текст',
        'Продолжить.',
      );
      ok(s.startsWith('Codex · поручение abcd · ' + states[st] + ' · 2 мин 10 с'), 'заголовок ' + st);
      ok(s.includes('Этап: Проверка (работа bridge)') && s.endsWith('Дальше: Продолжить.'), 'этап/дальше ' + st);
    }
  });
  await test('классификаторы и пределы', async () => {
    ok(
      q.classifyAgy({ agyStatus: 'SUCCESS', output: 'RESOURCE_EXHAUSTED quota exceeded 429' }).kind === 'error',
      'ответ модели не квота',
    );
    ok(q.classifyAgy({ agyStatus: 'ERROR', agyError: 'RESOURCE_EXHAUSTED' }).kind === 'quota', 'agy квота');
    ok(q.classifyAgy({ stderr: '429 Too many requests' }).kind === 'transient', 'временный 429');
    for (const apostrophe of ["'", '’'])
      ok(
        q.classifyCodex({ type: 'turn.failed', error: { message: 'You' + apostrophe + 've hit your usage limit' } })
          .kind === 'quota',
        'апостроф ' + apostrophe,
      );
    ok(
      q.classifyCodex({ type: 'item.completed', item: { text: 'You’ve hit your usage limit' } }).kind === 'none',
      'цитата не квота',
    );
    ok(
      q.classifyCodex({ type: 'turn.failed', error: { codexErrorInfo: 'UsageLimitExceeded' } }).kind === 'quota',
      'код квоты',
    );
    ok(q.resetTime('завтра') === null && q.resetTime('2000-01-01') === null, 'неверная/прошедшая дата');
    ok(q.retryPlan({ quotaAttempts: 12 }, { kind: 'quota' }).status === 'failed', '12 проб');
    ok(q.retryPlan({ transientAttempts: 3 }, { kind: 'transient' }).status === 'failed', '3 повтора');
    ok(q.retryPlan({ write: true }, { kind: 'quota' }).status === 'needs_decision', 'запись не повторяется');
    ok(q.windows({ primary: { windowDurationMins: 123 } }).five_hour === null, 'неизвестное окно');
  });
  await test('app-server и резервный журнал', async () => {
    const s = await q.appServer(env.CODEX_PATH, 2000);
    ok(s.five_hour.used_percent === 12 && s.weekly.used_percent === 23, 'окна определены длительностью');
    const d = env.MOST_CODEX_SESSIONS;
    fs.mkdirSync(d);
    fs.writeFileSync(
      path.join(d, 'rollout-thread-1.jsonl'),
      JSON.stringify({
        timestamp: '2026-09-26T12:00:00Z',
        payload: { type: 'token_count', rate_limits: { primary: { window_minutes: 10080, used_percent: 45 } } },
      }) + '\n',
    );
    const r = q.rollout('thread-1', d);
    ok(
      r.weekly.used_percent === 45 && r.five_hour === null && r.taken_at === '2026-09-26T12:00:00Z',
      'журнал и время снимка',
    );
  });
  await test('каналы и повтор PID', async () => {
    const owner = await locks.startOwner();
    ok(owner.ok, 'канал владельца');
    ok(
      (await locks.ownerState({ instance: 'dead-instance', pid: process.pid })) === 'dead',
      'живой PID другого экземпляра не означает живого владельца',
    );
    const l = await locks.tryLock('test', 'same', {}),
      l2 = await locks.tryLock('test', 'same', {});
    ok(l.ok && !l2.ok && l2.busy, 'двойной захват исключён');
    await l.release();
    const l3 = await locks.tryLock('test', 'same', {});
    ok(l3.ok, 'освобождение');
    await l3.release();
    await new Promise((r) => owner.srv.close(r));
  });
  for (const kind of ['antigravity', 'codex'])
    await test('пробный запуск ' + kind, async () => {
      const t = await probe(path.join(ROOT, 'servers', kind, 'index.js'), env);
      ok(t.tools.length === (kind === 'codex' ? 4 : 5), 'число инструментов');
      for (const tool of t.tools) {
        ok(/[А-Яа-яЁё]/.test(tool.title), 'русский title');
        ok(
          !/most_|poruch|itog|perenesti|papka|rezhim|fayl|stroki|opora|zamechaniya|pravka|tekst|kuda|polno|zhdat|chernovik/.test(
            JSON.stringify(tool),
          ),
          'нет транслита ' + tool.name,
        );
      }
    });
  const a = await start('antigravity'),
    c = await start('codex'),
    c2 = await start('codex');

  await test('Antigravity: успешный ответ со словами квоты в stderr', async () => {
    for (const word of ['429', 'rate limit', 'RESOURCE_EXHAUSTED']) {
      const r = await call(a, 'antigravity_send', {
        folder: project(),
        task: '[[FAKE:stderr:' + word + ']]',
        mode: 'text',
      });
      ok((await result(a, id(r))).text.includes('ОТВЕТ ПОЛУЧЕН'), 'успех при stderr ' + word);
    }
  });
  await test('Codex: CLI по указанному пути отсутствует', async () => {
    const b = await start('codex', { CODEX_PATH: path.join(RUN, 'absent.exe') });
    const r = await call(b, 'codex_send', { folder: project(), task: 'OK' });
    ok(r.error && r.text.includes('Исполнитель Codex не найден'), 'понятный отказ до spawn');
  });
  await test('Codex: повторы чтения, таймер, ожидание результата и очередь', async () => {
    const control = path.join(RUN, 'read-fault.json'),
      state = path.join(RUN, 'fault-state');
    fs.writeFileSync(control, '{}');
    const b = await start('codex', {
      MOST_STATE_DIR: state,
      MOST_QUOTA_RETRY_MS: '1000',
      FAULT_CONTROL: control,
      NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'read-fault.js')),
    });
    const fault = (target, count, code = 'EBUSY', scope) =>
      fs.writeFileSync(control, JSON.stringify({ target, count, code, scope }));
    const r = await call(b, 'codex_send', { folder: project(), task: 'SLOW' }),
      j = id(r);
    fault(j, 3);
    ok((await call(b, 'codex_result', { id: j, wait_sec: 10 })).text.includes('ОТВЕТ ПОЛУЧЕН'), 'ожидание после EBUSY');
    const r2 = await call(b, 'codex_send', { folder: project(), task: 'SLOW' }),
      j2 = id(r2);
    await sleep(100);
    fault(j2, 9, 'EBUSY', 'pollJob');
    await sleep(2500);
    ok((await result(b, j2)).text.includes('ОТВЕТ ПОЛУЧЕН'), 'процесс жив после сбоя таймера');
    ok(b.errors.includes('EBUSY') && !b.errors.includes('SECRET'), 'журнал без текста ошибки');
    fault(j, 3, 'PARTIAL');
    ok((await call(b, 'codex_result', { id: j })).text.includes('ОТВЕТ ПОЛУЧЕН'), 'неполный JSON перечитан');
    for (const code of ['EPERM', 'EACCES']) {
      fault(j, 2, code);
      ok((await call(b, 'codex_result', { id: j })).text.includes('ОТВЕТ ПОЛУЧЕН'), 'повтор ' + code);
    }
    fault(j, 100, 'EBUSY');
    const bad = await call(b, 'codex_result', { id: j });
    ok(bad.error, 'устойчивый сбой возвращает ошибку инструмента');
    fault(j, 0);
    ok((await call(b, 'codex_result', { id: j })).text.includes('ОТВЕТ ПОЛУЧЕН'), 'сервер доступен после ошибки');
    const queued = await call(b, 'codex_send', { folder: project(), task: 'QUOTA' });
    await result(b, id(queued), /ЖДЁТ КВОТУ/);
    fault(id(queued), 3, 'EBUSY', 'list');
    await sleep(2500);
    ok(JSON.parse(fs.readFileSync(control, 'utf8')).count === 0, 'очередь перечитала занятую карточку');
    ok((await result(b, id(queued), /ОТВЕТ ПОЛУЧЕН/)).text.includes('ПРОДОЛЖЕНО'), 'очередь продолжает работу');
  });

  await test('вердикты, text, этап, cwd Antigravity', async () => {
    for (const verdict of ['ПРИНЯТО', 'НЕ ПРИНЯТО: 2 замечания']) {
      const folder = project();
      const r = await call(a, 'antigravity_send', {
        folder,
        task: '[[FAKE:literal:' + Buffer.from(verdict).toString('base64') + ']]',
        text: 'Проверить',
        stage: 'Ревью',
        work: 'bridge',
      });
      const done = await result(a, id(r));
      ok(!done.text.includes('со вступления'), 'вердикт без предупреждения');
      ok(done.text.includes('Этап: Ревью (работа bridge)'), 'этап сохранён');
      const refused = await call(a, 'antigravity_apply', { id: id(r) });
      ok(refused.error, 'текст не переносится в исходник');
      const log = fs.readFileSync(env.FAKE_AGY_LOG, 'utf8');
      ok(log.includes(JSON.stringify(folder).slice(1, -1)), 'cwd проекта');
    }
  });
  await test('Antigravity: цитата, квота и 12 проб', async () => {
    let r = await call(a, 'antigravity_send', {
      folder: project(),
      task: '[[FAKE:literal:' + Buffer.from('Цитата: quota exceeded RESOURCE_EXHAUSTED').toString('base64') + ']]',
      mode: 'text',
    });
    ok((await result(a, id(r))).text.includes('ОТВЕТ ПОЛУЧЕН'), 'цитата не ошибка');
    r = await call(a, 'antigravity_send', { folder: project(), task: '[[FAKE:quota]]' });
    const j = id(r);
    const done = await result(a, j, /НЕ УДАЛОСЬ/, 15000);
    ok(done.text.includes('исчерпаны 12 попыток восстановления'), '12 восстановлений');
    const card = JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'jobs', j, 'card.json'), 'utf8'));
    ok(card.quotaAttempts === 12, 'счётчик 12');
  });
  await test('Antigravity: временный 429', async () => {
    const r = await call(a, 'antigravity_send', { folder: project(), task: '[[FAKE:transient]]' });
    const done = await result(a, id(r), /НЕ УДАЛОСЬ/);
    ok(done.text.includes('3 повтора'), 'три временных повтора');
  });
  await test('Codex: ответ, продолжение, страницы и архив', async () => {
    const folder = project();
    const r = await call(c, 'codex_send', { folder, task: 'OK', text: 'материал', stage: 'Код', work: 'bridge' });
    const done = await result(c, id(r));
    ok(done.text.includes('ПРИНЯТО') && done.text.includes('Этап: Код (работа bridge)'), 'ответ/этап');
    const r2 = await call(c, 'codex_send', { folder, task: 'Продолжить', continue_id: id(r) });
    const previous = JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'codex-jobs', id(r) + '.json'), 'utf8'));
    ok((await result(c, id(r2))).text.includes('ПРОДОЛЖЕНО ' + previous.threadId), 'точный threadId передан');
    const wrong = await call(c, 'codex_send', { folder: project(), task: 'Продолжить', continue_id: id(r) });
    ok(wrong.error, 'другая папка запрещена');
    const missing = await call(c, 'codex_send', { folder, task: 'MISSING', continue_id: id(r) });
    ok((await result(c, id(missing))).text.includes('НЕ УДАЛОСЬ'), 'недоступный сеанс');
    const large = await call(c, 'codex_send', { folder, task: 'LARGE' });
    await result(c, id(large));
    const page = await call(c, 'codex_result', { id: id(large), from_char: 24000 });
    ok(page.text.includes('КОНЕЦ'), 'вторая страница');
    fs.mkdirSync(env.MOST_CODEX_ARCHIVE_DIR, { recursive: true });
    const resultFile = path.join(env.MOST_CODEX_ARCHIVE_DIR, 'old.result.txt');
    fs.writeFileSync(resultFile, 'Старый ответ');
    fs.writeFileSync(
      path.join(env.MOST_CODEX_ARCHIVE_DIR, 'old.json'),
      JSON.stringify({ id: 'old', status: 'done', resultFile }),
    );
    const old = await call(c, 'codex_result', { id: 'old' });
    ok(old.text.includes('Архивное') && old.text.includes('Старый ответ'), 'чтение архива');
    ok((await call(c, 'codex_cancel', { id: 'old' })).error, 'архив не изменяется');
  });
  await test('Codex: межпроцессная запись и параллельное чтение', async () => {
    const folder = project();
    const both = await Promise.all([
      call(c, 'codex_send', { folder, task: 'SLOW', write: true }),
      call(c2, 'codex_send', { folder, task: 'SLOW', write: true }),
    ]);
    ok(both.filter((r) => r.error).length === 1, 'один писатель');
    const read = await call(c2, 'codex_send', { folder, task: 'OK' });
    ok(!read.error, 'чтение параллельно записи');
    await result(c2, id(read));
    await result(c, id(both.find((r) => !r.error)));
  });
  await test('Codex: квота, resume и запись после квоты', async () => {
    const r = await call(c, 'codex_send', { folder: project(), task: 'QUOTA' });
    const done = await result(c, id(r), /ОТВЕТ ПОЛУЧЕН/);
    ok(done.text.includes('ПРОДОЛЖЕНО'), 'автоматическое resume');
    const folder = project(),
      w = await call(c, 'codex_send', { folder, task: 'QUOTA', write: true });
    ok((await result(c, id(w))).text.includes('НУЖНО РЕШЕНИЕ'), 'запись требует решения');
    const card = JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'codex-jobs', id(w) + '.json'), 'utf8'));
    ok(card.quotaAttempts === 0, 'запись не повторяется');
    const resumed = await call(c, 'codex_send', { folder, task: 'Продолжить', write: true, continue_id: id(w) });
    ok((await result(c, id(resumed))).text.includes('ИЗМЕНЕНИЯ УЖЕ ВНЕСЕНЫ'), 'явное продолжение записи');
    const quote = await call(c, 'codex_send', { folder: project(), task: 'QUOTE' });
    ok((await result(c, id(quote))).text.includes('ОТВЕТ ПОЛУЧЕН'), 'цитата не квота');
  });
  await test('Codex: 12 проб', async () => {
    const r = await call(c, 'codex_send', { folder: project(), task: 'QUOTA ALWAYS' });
    ok(
      (await result(c, id(r), /НЕ УДАЛОСЬ/, 15000)).text.includes('исчерпаны 12 попыток восстановления'),
      'предел реальной очереди',
    );
  });
  await test('отмена ожидания и перезапуск двух владельцев', async () => {
    const state = path.join(RUN, 'restart');
    const slow = { MOST_STATE_DIR: state, MOST_QUOTA_RETRY_MS: '2000' };
    const b = await start('codex', slow);
    const folder = project();
    let r = await call(b, 'codex_send', { folder, task: 'QUOTA' });
    await result(b, id(r), /ЖДЁТ КВОТУ/);
    ok((await call(b, 'codex_cancel', { id: id(r) })).text.includes('ОТМЕНЕНО'), 'отмена ожидания');
    r = await call(b, 'codex_send', { folder, task: 'QUOTA' });
    await result(b, id(r), /ЖДЁТ КВОТУ/);
    await b.client.close();
    const p = path.join(state, 'codex-jobs', id(r) + '.json'),
      card = JSON.parse(fs.readFileSync(p, 'utf8'));
    card.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    card.owner = { pid: process.pid, instance: 'dead-reused-pid', startedAt: '2000-01-01' };
    fs.writeFileSync(p, JSON.stringify(card));
    const pair = await Promise.all([start('codex', slow), start('codex', slow)]);
    const done = await result(pair[0], id(r), /ОТВЕТ ПОЛУЧЕН/);
    ok(done.text.includes('ПРОДОЛЖЕНО'), 'очередь поднята');
    const fresh = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(fresh.quotaAttempts === 1, 'нет двойного запуска');
  });
  await test('дата сброса, резервный источник и таймаут', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    ok(
      q.classifyCodex({
        type: 'turn.failed',
        error: { message: 'You have hit your usage limit. Try again at ' + future },
      }).resetsAt === future,
      'дата из ошибки Codex',
    );
    ok(
      q.classifyAgy({ agyError: JSON.stringify({ message: 'RESOURCE_EXHAUSTED', resetsAt: future }) }).resetsAt ===
        future,
      'дата agy',
    );
    const hang = path.join(RUN, 'hang.js');
    fs.writeFileSync(hang, 'setInterval(()=>{},1000)');
    const before = Date.now();
    let rejected = false;
    try {
      await q.appServer(hang, 100);
    } catch {
      rejected = true;
    }
    ok(rejected && Date.now() - before < 3000, 'таймаут app-server');
    process.env.MOST_CODEX_SESSIONS = env.MOST_CODEX_SESSIONS;
    const fallback = await q.codexQuota(path.join(RUN, 'missing.exe'));
    ok(fallback.source === 'журнал сеанса' && fallback.weekly.used_percent === 45, 'резервный источник при сбое');
  });
  await test('Antigravity: отмена квоты и перезапуск двух процессов', async () => {
    const state = path.join(RUN, 'agy-restart'),
      e = { MOST_STATE_DIR: state, MOST_QUOTA_RETRY_MS: '10000' };
    const b = await start('antigravity', e);
    const r = await call(b, 'antigravity_send', { folder: project(), task: '[[FAKE:quota]]' });
    await result(b, id(r), /ЖДЁТ КВОТУ/);
    ok((await call(b, 'antigravity_cancel', { id: id(r) })).text.includes('ОТМЕНЕНО'), 'отмена ожидания agy');
    const r2 = await call(b, 'antigravity_send', { folder: project(), task: '[[FAKE:quota]]' });
    await result(b, id(r2), /ЖДЁТ КВОТУ/);
    await b.client.close();
    const p = path.join(state, 'jobs', id(r2), 'card.json'),
      card = JSON.parse(fs.readFileSync(p, 'utf8'));
    card.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    card.owner = { pid: process.pid, instance: 'dead-agy' };
    fs.writeFileSync(p, JSON.stringify(card));
    const pair = await Promise.all([start('antigravity', e), start('antigravity', e)]);
    await result(pair[0], id(r2), /ЖДЁТ КВОТУ/);
    await sleep(300);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(after.quotaAttempts === 1, 'одна проба agy после перезапуска');
    await call(pair[0], 'antigravity_cancel', { id: id(r2) });
  });
  await test('ответ модели не переводится; вступление всё ещё распознаётся', async () => {
    const text = 'ПРИНЯТО\nmost_itog fayl poruchenie pravka';
    const r = await call(a, 'antigravity_send', {
      folder: project(),
      task: '[[FAKE:literal:' + Buffer.from(text).toString('base64') + ']]',
      mode: 'text',
    });
    const done = await result(a, id(r));
    ok(done.text.includes(text), 'точный ответ без подмены идентификаторов');
    const intro = await call(a, 'antigravity_send', { folder: project(), task: '[[FAKE:intro]]' });
    ok((await result(a, id(intro))).text.includes('со вступления'), 'настоящее вступление');
  });
  await test('Codex: потерянный владелец записи блокирует новую запись', async () => {
    const folder = project(),
      p = path.join(env.MOST_STATE_DIR, 'codex-jobs', 'orphan.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        id: 'orphan',
        folder,
        write: true,
        status: 'running',
        owner: { instance: 'missing', pid: process.pid },
        childPid: 12345,
      }),
    );
    const r = await call(c, 'codex_send', { folder, task: 'OK', write: true });
    ok(r.error && r.text.includes('неподтверждённой'), 'запись заблокирована');
    const card = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(card.status === 'needs_decision', 'потеря владельца требует решения');
  });
  await test('сводки серверов', async () => {
    const cr = await call(c, 'codex_status');
    ok(cr.text.includes('5 ч: использовано 12 %') && cr.text.includes('неделя: использовано 23 %'), 'квоты в статусе');
    const ar = await call(a, 'antigravity_status');
    ok(
      ar.text.includes('Версия на диске: ' + require('../package.json').version) &&
        ar.text.includes('Последнее исчерпание:') &&
        ar.text.includes('За 5 ч:'),
      'активность и версии agy',
    );
  });
  await test('Codex: отмена из другого процесса и таймаут записи', async () => {
    const r = await call(c, 'codex_send', { folder: project(), task: 'SLOW' });
    await sleep(200);
    await call(c2, 'codex_cancel', { id: id(r) });
    let card;
    const cancelLimit = Date.now() + 15000;
    do {
      await sleep(100);
      card = JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'codex-jobs', id(r) + '.json'), 'utf8'));
    } while (['running', 'cancelling'].includes(card.status) && Date.now() < cancelLimit);
    ok(['cancelled', 'stop_unconfirmed'].includes(card.status), 'межпроцессная отмена');
    const b = await start('codex', { MOST_CODEX_TIMEOUT_MS: '150' });
    const w = await call(b, 'codex_send', { folder: project(), task: 'HANG', write: true });
    let wc;
    const limit = Date.now() + 15000;
    do {
      await sleep(100);
      wc = JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'codex-jobs', id(w) + '.json'), 'utf8'));
    } while (['running', 'cancelling'].includes(wc.status) && Date.now() < limit);
    ok(
      wc.status === 'needs_decision' && wc.error.includes('предел времени'),
      'таймаут записи требует решения: ' + JSON.stringify(wc),
    );
  });

  await test('Очистка: двухдневная квота с файлами переживает очистку и повтор', async () => {
    const state = path.join(RUN, 'prune-quota');
    const e = { MOST_STATE_DIR: state, MOST_INPUT_DIR: path.join(state, 'input'), MOST_QUOTA_RETRY_MS: '3600000' };
    const b = await start('antigravity', e);
    const r = await call(b, 'antigravity_send', { folder: project(), task: '[[FAKE:quota]] ' + 'материал '.repeat(4000) });
    await result(b, id(r), /ЖДЁТ КВОТУ/);
    await b.client.close();
    const jobs = path.join(state, 'jobs'), inputs = path.join(state, 'input');
    const file = path.join(jobs, id(r), 'card.json'), card = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(card.retry.inputDir && card.poruchenieFile);
    const materials = fs.readdirSync(card.retry.inputDir).map(n => [n, fs.readFileSync(path.join(card.retry.inputDir, n))]);
    const old = new Date(Date.now() - 2 * 86400000), ancient = new Date(Date.now() - 31 * 86400000);
    card.startedAt = old.toISOString(); card.nextAttemptAt = new Date(0).toISOString();
    card.owner = { instance: 'dead-prune', pid: 1 };
    fs.writeFileSync(file, JSON.stringify(card)); fs.utimesSync(file, ancient, ancient);
    fs.utimesSync(card.retry.inputDir, old, old);
    const removed = [];
    for (const status of ['queued', 'running', 'waiting_quota', 'needs_decision', 'cancelling', 'stop_unconfirmed', 'applying', 'apply_unclear', 'unknown', 'done', 'applied', 'failed', 'cancelled', 'lost']) {
      const dir = path.join(jobs, 'state-' + status), input = path.join(inputs, 'state-' + status);
      fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(input, { recursive: true });
      const f = path.join(dir, 'card.json'); fs.writeFileSync(f, JSON.stringify({ id: 'state-' + status, status }));
      fs.utimesSync(f, ancient, ancient); fs.utimesSync(input, old, old);
    }
    const source = fs.readFileSync(path.join(ROOT, 'servers/antigravity/index.js'), 'utf8');
    const body = source.slice(source.indexOf('function isFinalJob('), source.indexOf('// ---------- восстановление состояния'));
    const prune = new Function('fs', 'path', 'JOBS_DIR', 'LOCKS_DIR', 'INPUT_DIR', 'KEEP_JOBS_DAYS', 'loadJob', 'keepRm', body + '; return pruneOld;')(
      fs, path, jobs, path.join(state, 'locks'), inputs, 30,
      n => { try { return JSON.parse(fs.readFileSync(path.join(jobs, n, 'card.json'), 'utf8')); } catch { return null; } },
      p => removed.push(p));
    prune();
    assert(!removed.includes(path.dirname(file))); assert(!removed.includes(card.retry.inputDir));
    for (const status of ['queued', 'running', 'waiting_quota', 'needs_decision', 'cancelling', 'stop_unconfirmed', 'applying', 'apply_unclear', 'unknown']) {
      assert(!removed.includes(path.join(jobs, 'state-' + status)));
      assert(!removed.includes(path.join(inputs, 'state-' + status)));
    }
    for (const status of ['done', 'applied', 'failed', 'cancelled', 'lost']) {
      assert(removed.includes(path.join(jobs, 'state-' + status)));
      assert(removed.includes(path.join(inputs, 'state-' + status)));
    }
    const restarted = await start('antigravity', e);
    const limit = Date.now() + 15000;
    let after;
    do { await sleep(100); after = JSON.parse(fs.readFileSync(file, 'utf8')); }
    while ((!after.quotaAttempts || after.status !== 'waiting_quota') && Date.now() < limit);
    assert.equal(after.quotaAttempts, 1); assert.equal(after.status, 'waiting_quota');
    for (const [n, bytes] of materials) assert.deepEqual(fs.readFileSync(path.join(card.retry.inputDir, n)), bytes);
    ok(true, 'очистка сохраняет все незавершённые состояния и материалы повторного запуска');
    await call(restarted, 'antigravity_cancel', { id: id(r) });
  });
  await test('Codex: исчезнувшая карточка не мешает очереди и статусу; мёртвый владелец', async () => {
    const state = path.join(RUN, 'codex-gone'), folder = project();
    const control = path.join(RUN, 'gone-control.json');
    fs.writeFileSync(control, JSON.stringify({ target: 'vanished', count: 100000, code: 'ENOENT' }));
    const dir = path.join(state, 'codex-jobs'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'vanished.json'), '{}');
    const extra = { MOST_STATE_DIR: state, MOST_QUOTA_RETRY_MS: '3600000',
      NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'read-fault.js')), FAULT_CONTROL: control };
    const b = await start('codex', extra);
    for (const status of ['running', 'cancelling', 'stop_unconfirmed']) for (const write of [true, false]) {
      const id = status + '-' + write;
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, status, write, owner: { instance: 'dead-status', pid: 1 } }));
    }
    const out = await call(b, 'codex_status'); assert(!out.error, out.text);
    assert.match(out.text, /ПОТЕРЯНО/); assert.match(out.text, /НУЖНО РЕШЕНИЕ/);
    for (const status of ['running', 'cancelling', 'stop_unconfirmed']) for (const write of [true, false]) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, status + '-' + write + '.json'), 'utf8'));
      assert.equal(c.status, write ? 'needs_decision' : 'lost');
    }
    const r = await call(b, 'codex_send', { folder, task: 'QUOTA', text: 'сохранённый материал' });
    await result(b, id(r), /ЖДЁТ КВОТУ/);
    await b.client.close();
    const file = path.join(dir, id(r) + '.json');
    const card = JSON.parse(fs.readFileSync(file, 'utf8'));
    const old = new Date(Date.now() - 2 * 86400000);
    card.startedAt = old.toISOString(); card.nextAttemptAt = new Date(0).toISOString();
    card.owner = { instance: 'dead-aged-codex', pid: 1 };
    fs.writeFileSync(file, JSON.stringify(card)); fs.utimesSync(file, old, old); fs.utimesSync(card.textFile, old, old);
    const restarted = await start('codex', extra);
    await result(restarted, id(r), /ОТВЕТ ПОЛУЧЕН/);
    assert.equal(fs.readFileSync(card.textFile, 'utf8'), 'сохранённый материал');
    ok(true, 'исчезнувшая карточка пропущена; очередь и normalized работают');
  });
  for (const b of clients) {
    try {
      await b.client.close();
    } catch {}
  }
  console.log('Итого дополнительно: пройдено ' + passed + ', провалено ' + failed + '.');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
