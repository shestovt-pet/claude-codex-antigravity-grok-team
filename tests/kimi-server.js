'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const h = require('./fake-kimi'), f = h.setup(); f.active(); f.probe();
const launch = require('../common/kimi-launch'); let c;
async function send(task, extra = {}) {
  const before = new Set(h.cards(f).map(j => j.id)); const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task, ...extra } });
  assert(!r.isError, h.text(r)); const j = h.cards(f).find(j => !before.has(j.id)); assert(j, h.text(r)); return h.wait(f, j.id);
}
async function waitFile(file) {
  const end = Date.now() + 15000;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert(fs.existsSync(file), 'не появился файл ' + file); return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const tests = [
  ['поток живой пробы: UTF-8 по одному байту, только последний assistant', () => {
    const p = launch.parser(); for (const b of fs.readFileSync(path.join(__dirname, 'fixtures/kimi/success.ndjson'))) p.push(Buffer.from([b]));
    const r = p.finish(0); assert(r.ok); assert.equal(r.text, 'Число: 42\nПРИНЯТО');
    const q = launch.parser(); q.push('{"role":"meta","type":"system.version","version":"2.5.3"}\n{"role":"assistant","content":"ПРИНЯТО"}\n{"role":"assistant","content":"НЕ ПРИНЯТО: 1 блокирующих"}'); assert.match(q.finish(0).text, /^НЕ ПРИНЯТО/);
  }],
  ['профиль агента — валидный YAML (description в кавычках), парсер сохраняет tool_calls (Kimi №1/№4)', () => {
    const yaml = require('yaml');
    for (const job of [{ role: 'проверка', write: false, fullAccess: false }, { role: 'совет', write: false, fullAccess: false }, { role: 'совет', write: true, fullAccess: false }, { role: 'совет', write: true, fullAccess: true }]) {
      const prof = launch.profile(job, ['mcp__codex__codex_send']);
      // На прежнем коде «description: мост team-v56: …» с неэкранированным вторым двоеточием ломает разбор frontmatter.
      const meta = yaml.parse(prof.text.split('---')[1]);
      assert.match(meta.description, /^мост team-v56: /, JSON.stringify(meta));
      assert.deepEqual(meta.tools, prof.tools); assert.deepEqual(meta.subagents, []);
      assert.equal(meta.name, prof.name.replace(/\.md$/, ''));
    }
    // Парсер не отбрасывает вызовы инструментов: сохраняет их имена и считает результаты tool; ответ — последний assistant.
    const p = launch.parser();
    p.push('{"role":"meta","type":"system.version","version":"2.5.3"}\n');
    p.push('{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"Read"}},{"type":"function","function":{"name":"Bash"}}]}\n');
    p.push('{"role":"tool","tool_call_id":"t1","content":"x"}\n{"role":"assistant","content":"ПРИНЯТО"}\n');
    const r = p.finish(0); assert.deepEqual(r.toolCalls, ['Read', 'Bash']); assert.equal(r.toolResults, 1); assert.equal(r.text, 'ПРИНЯТО');
  }],
  ['Л2 (круг 5, М1): отметка выдачи — только родителю готового результата; «ещё работает»/ошибка/другой родитель не дают отметки', () => {
    const rr = require('../common/result-receipt');
    const text = 'итог потомка', sha = rr.sha256(text);
    const base = { id: 'ch', status: 'done', parentJob: 'P', finishedAt: new Date().toISOString() };
    // Готовый результат, вызывающий — родитель (parentJob) → отметка: кому/когда/sha.
    const m = rr.deliveryMark(base, 'P', text); assert(m && m.to === 'P' && m.sha256 === sha && Number.isFinite(Date.parse(m.at)));
    // Ещё работает (не done) → нет отметки; ошибка (failed) → нет отметки; нет finishedAt → нет отметки.
    assert.equal(rr.deliveryMark({ ...base, status: 'running' }, 'P', text), null);
    assert.equal(rr.deliveryMark({ ...base, status: 'failed' }, 'P', text), null);
    assert.equal(rr.deliveryMark({ ...base, finishedAt: 'нет' }, 'P', text), null);
    // Выдача другому вызывающему (не родителю) и отсутствие parentJob → нет отметки.
    assert.equal(rr.deliveryMark(base, 'ДРУГОЙ', text), null);
    assert.equal(rr.deliveryMark({ ...base, parentJob: undefined }, 'P', text), null);
    // Идемпотентно: та же пара родитель+sha уже есть → null; другой результат (sha) → новая отметка.
    const withMark = { ...base, resultDeliveries: [{ to: 'P', at: base.finishedAt, sha256: sha }] };
    assert.equal(rr.deliveryMark(withMark, 'P', text), null);
    assert(rr.deliveryMark(withMark, 'P', 'заменённый результат'));
  }],
  ['Л2 (круг 6, М1): record() пишет отметку только по снимку, что возвращён вызывающему (гонка снимок/карточка)', async () => {
    // Исполняемый путь result-receipt.record: обработчик строит ответ view(j,...) по снимку j; отметку строим по НЕМУ.
    const rr = require('../common/result-receipt');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rr-race-'));
    const id = 'child-race', parentId = 'parent-race-P', text = 'готовый результат потомка';
    const resultFile = path.join(dir, id + '.result.txt'); fs.writeFileSync(resultFile, text);
    const cardFile = path.join(dir, id + '.json'), fin = new Date().toISOString();
    const doneCard = { id, status: 'done', parentJob: parentId, finishedAt: fin, resultFile };
    const writeCard = card => fs.writeFileSync(cardFile, JSON.stringify(card));
    const load = () => JSON.parse(fs.readFileSync(cardFile, 'utf8'));
    const mutate = async (i, fn) => { const card = load(); if ((await fn(card)) !== false) writeCard(card); return card; };
    const dels = () => load().resultDeliveries;
    // Родитель-вызывающий: карточка в сторе (currentJob ищет ровно одну) + MOST_JOB_ID.
    const pj = path.join(f.state, 'kimi-jobs', parentId); fs.mkdirSync(pj, { recursive: true });
    fs.writeFileSync(path.join(pj, 'card.json'), JSON.stringify({ id: parentId, status: 'running' }));
    const prevJob = process.env.MOST_JOB_ID; process.env.MOST_JOB_ID = parentId;
    try {
      // Отрицательный: снимок running, но карточка к моменту record() уже done с результатом → отметки НЕТ.
      writeCard(doneCard);
      await rr.record({ mutate, id, snapshot: { id, status: 'running', parentJob: parentId }, fromChar: 0 });
      assert.equal(dels(), undefined, 'снимок running при уже done-карточке: отметки нет');
      // Положительный: снимок done той же редакции → отметка есть (кому/sha).
      await rr.record({ mutate, id, snapshot: doneCard, fromChar: 0 });
      const d = dels(); assert(Array.isArray(d) && d.length === 1 && d[0].to === parentId && d[0].sha256 === rr.sha256(text), 'снимок done: отметка выдачи записана');
      // Идемпотентно по (to, sha): повторная выдача того же результата отметку не дублирует.
      await rr.record({ mutate, id, snapshot: doneCard, fromChar: 0 });
      assert.equal(dels().length, 1, 'повтор того же результата: без дубля');
      // from_char>0 — выдано не начало результата → отметки нет.
      writeCard(doneCard);
      await rr.record({ mutate, id, snapshot: doneCard, fromChar: 24000 });
      assert.equal(dels(), undefined, 'from_char>0: отметки нет');
      // Снимок done, но карточка под замком — уже другая редакция (другой finishedAt/resultFile) → отметки нет (строже).
      const otherFile = path.join(dir, id + '.v2.result.txt'); fs.writeFileSync(otherFile, 'новый результат');
      writeCard({ ...doneCard, finishedAt: new Date(Date.parse(fin) + 1000).toISOString(), resultFile: otherFile });
      await rr.record({ mutate, id, snapshot: doneCard, fromChar: 0 });
      assert.equal(dels(), undefined, 'другая редакция карточки под замком: отметки нет');
      // Выдача не родителю (другой MOST_JOB_ID) → отметки нет.
      writeCard(doneCard); process.env.MOST_JOB_ID = parentId + '-other';
      const op = path.join(f.state, 'kimi-jobs', parentId + '-other'); fs.mkdirSync(op, { recursive: true });
      fs.writeFileSync(path.join(op, 'card.json'), JSON.stringify({ id: parentId + '-other', status: 'running' }));
      await rr.record({ mutate, id, snapshot: doneCard, fromChar: 0 });
      assert.equal(dels(), undefined, 'вызывающий не родитель: отметки нет');
    } finally {
      if (prevJob === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = prevJob;
      fs.rmSync(pj, { recursive: true, force: true }); fs.rmSync(path.join(f.state, 'kimi-jobs', parentId + '-other'), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['неизвестный поток/пустой ответ/ненулевой код и подтверждённая ошибка модели', () => {
    for (const input of ['', '{}', 'bad']) { const p = launch.parser(); p.push(input); assert.equal(p.finish(0).ok, false); }
    const p = launch.parser(); p.push(fs.readFileSync(path.join(__dirname, 'fixtures/kimi/model-error.ndjson'))); assert.equal(p.finish(-1073740791, fs.readFileSync(path.join(__dirname, 'fixtures/kimi/model-error.stderr.txt'), 'utf8')).errorKind, 'model_not_configured');
    const q = launch.parser(); q.push(fs.readFileSync(path.join(__dirname, 'fixtures/kimi/success.ndjson'))); assert.equal(q.finish(9).ok, false);
  }],
  ['MCP: четыре инструмента', async () => { c = await h.client(f); assert.deepEqual((await c.listTools()).tools.map(t => t.name).sort(), ['kimi_cancel', 'kimi_result', 'kimi_send', 'kimi_status']); }],
  ['служебные version/help и запись пробы: только явно; MOST_PROBE_ONLY не вызывает CLI', () => {
    assert(launch.inspect({ file: 'missing' }).skipped);
    const prev = process.env.MOST_PROBE_ONLY; process.env.MOST_PROBE_ONLY = '0';
    try {
      const info = launch.inspect({ file: process.execPath, prefixArgs: [require.resolve('./fake-kimi')], cwd: f.root, tempFolder: f.root }); assert.equal(info.version, '2.5.3');
      assert.throws(() => launch.recordCompatibility(info), /полного результата/);
      launch.recordCompatibility({ ...info, delivery: true, parsing: true, detection: true }); assert(launch.compatibility(process.execPath));
    } finally { process.env.MOST_PROBE_ONLY = prev; }
  }],
  ['запрещённые параметры до карточки/копии/замка; проверка — только чтение; неизвестная модель (А1)', async () => {
    // Для всех ролей: full_access без write, continue_id (А2 не включено) и неизвестная модель отвергаются до карточки.
    for (const role of ['совет', 'текст', 'проверка']) for (const extra of [{ full_access: true }, { continue_id: '' }, { continue_id: 'old' }, { model: 'unknown' }]) {
      const before = h.cards(f).length; const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'отказ', role, ...extra } }); assert(r.isError); assert.equal(h.cards(f).length, before);
    }
    // Роль «проверка» остаётся только для чтения: write/full_access отвергаются до карточки.
    for (const extra of [{ write: true }, { write: true, full_access: true }]) {
      const before = h.cards(f).length; const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'отказ', role: 'проверка', ...extra } }); assert(r.isError); assert.equal(h.cards(f).length, before);
    }
    assert(!fs.existsSync(process.env.MOST_KIMI_WORK_ROOT));
  }],
  ['файл >128 КиБ: весь task/text, кириллица, кавычки, CRLF/LF, argv и хвост', async () => {
    const j = await send('FAKE:success\n' + 'Кириллица «кавычки»\r\nстрока\n'.repeat(6000) + 'КОНТРОЛЬНЫЙ ХВОСТ', { text: 'diff --git a/data.txt b/data.txt\n-base\n+candidate', role: 'проверка' });
    assert.equal(j.status, 'done', j.error); const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json')));
    assert(obs.bytes > 128 * 1024 && obs.tail); assert.equal(obs.inputSha256, j.inputSha256); assert.equal(obs.argv[1], launch.DEFAULT);
    // Большой текст в файле, не в argv: хвост не встроен, argv остаётся коротким (с учётом абсолютного пути профиля).
    assert(!obs.argv.join(' ').includes('КОНТРОЛЬНЫЙ ХВОСТ')); assert(obs.argv.join(' ').length < 1500);
    // А1: профиль проверки передан через --agent-file и совпал с сохранённым в карточке; инструменты — только чтение.
    assert.equal(obs.agentFile, j.profileFile); assert.equal(obs.agentSha256, j.profileSha256); assert.equal(j.profileKind, 'review');
    assert.deepEqual(obs.tools.sort(), ['Glob', 'Grep', 'Read']); assert.equal(obs.argv[obs.argv.indexOf('--agent-file') + 1], j.profileFile);
    assert.equal(obs.cwd, j.executionFolder); assert.equal(obs.env.TEMP, obs.env.TMPDIR);
    assert.equal(j.provenance.evidence_level, 'requested_only'); assert.equal(j.modelConfirmed, false); require('../common/kimi-review').evidence(j);
    assert.equal(j.voteEligible, true, 'проверка с полным evidence голосует (А1/Б4)');
    const r = await c.callTool({ name: 'kimi_result', arguments: { id: j.id } }); assert.match(h.text(r), /Число: 42/); assert.match(h.text(r), /Обнаружение, не запрет/);
  }],
  ['явный -m и effort в среде CLI для каждой роли и уровня', async () => {
    const expectedModel = 'kimi-code/k3.1-pro-highspeed';
    async function check(args, effort, model = expectedModel) {
      const j = await send('FAKE:success', args);
      assert.equal(j.status, 'done', j.error);
      const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json')));
      assert.deepEqual(obs.argv.slice(0, 2), ['-m', model]);
      assert.equal(obs.effort, effort);
      assert.equal(j.effort, effort);
      assert(j.modelChoiceLine.includes(model + ' ' + effort));
      assert.equal(j.previous, null);
      return j;
    }
    for (const [role, effort] of [['совет', 'low'], ['текст', 'high'], ['проверка', 'max']]) {
      const j = await check({ role }, effort);
      if (role !== 'проверка') { assert.equal(j.voteEligible, false, 'совет/текст: done, но не голос (А1/Б4)'); assert(j.voteIneligibleReason, 'причина неголосования сохранена'); }
    }
    for (const [level, effort] of [['fast', 'low'], ['normal', 'high'], ['strong', 'max']]) await check({ role: 'совет', level }, effort);
    await check({ role: 'проверка', level: 'strong', effort: 'low' }, 'low');
    await check({ role: 'совет', level: 'fast', effort: 'high' }, 'high');
    await check({ role: 'совет', level: 'normal', effort: 'max' }, 'max');
    await check({ role: 'совет', model: 'kimi-code/k3', effort: 'max' }, 'max', 'kimi-code/k3');
  }],
  ['ошибки, поздний отказ и нарушение копии не становятся голосом', async () => {
    for (const scenario of ['empty', 'broken', 'exit', 'model-error', 'change']) { const j = await send('FAKE:' + scenario); assert.equal(j.status, 'failed', JSON.stringify(j)); assert.equal(j.voteEligible, false); }
    const j = await send('FAKE:refuse'); assert.equal(j.status, 'done'); assert.match(fs.readFileSync(j.resultFile, 'utf8'), /^НЕ ПРИНЯТО/);
  }],
  ['нет обычного срока; явный срок и срок родителя остаются штатными', () => { assert.equal(require('../common/chain-deadline').normalTimeoutMs('kimi'), null); assert(require('../common/chain-deadline').deadlinePassed({ deadline: new Date(0).toISOString() })); }],
  ['отмена после захвата во время подготовки: нет запуска, отмена сохранена, замок отпущен', async () => {
    const barrier = path.join(f.root, 'prepare-barrier.json'), controller = await h.client(f);
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_PREPARE_BARRIER: barrier });
    const pending = c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:success', role: 'проверка' } });
    // Отказ send тоже наблюдается после освобождения барьера, без unhandled rejection.
    const response = pending.then(value => ({ value }), error => ({ error }));
    let prepared;
    try {
      for (let i = 0; i < 300 && !fs.existsSync(barrier); i++) await new Promise(r => setTimeout(r, 50));
      assert(fs.existsSync(barrier), 'сервер не дошёл до подготовки'); prepared = JSON.parse(fs.readFileSync(barrier));
      const claimed = h.cards(f).find(j => j.id === prepared.id); assert.equal(claimed.status, 'running'); assert(!claimed.childPid);
      { const dl = require('../common/write-lock').acquire(f.folder); assert.equal(dl.ok, true, 'A4: чтение не держит материал — идёт параллельно'); dl.release(); }
      const cancelled = await controller.callTool({ name: 'kimi_cancel', arguments: { id: prepared.id } }); assert(!cancelled.isError, h.text(cancelled));
      const card = h.cards(f).find(j => j.id === prepared.id); assert.equal(card.status, 'cancelling'); assert.equal(card.stopReason, 'cancel');
    } finally { fs.writeFileSync(barrier + '.release', 'release'); await controller.close(); }
    const reply = await response; if (reply.error) throw reply.error; assert(!reply.value.isError, h.text(reply.value));
    const ended = await h.wait(f, prepared.id); assert.equal(ended.status, 'cancelled', ended.error); assert.equal(ended.stopReason, 'cancel');
    assert(ended.stopConfirmed); assert.equal(ended.readOnlyCheck.status, 'passed'); assert(!ended.childPid); assert.equal(ended.modelArgumentConfirmed, false);
    assert(!fs.existsSync(path.join(prepared.tempFolder, 'observed.json')), 'подставной CLI не должен стартовать');
    assert(!ended.resultFile); assert(!ended.voteEligible); const lock = require('../common/write-lock').acquire(f.folder); assert(lock.ok); lock.release();
    await c.close(); c = await h.client(f);
  }],
  ['отмена на границе spawn ждёт kimi_job, видит PID и останавливает запущенный процесс', async () => {
    const barrier = path.join(f.root, 'spawn-barrier.json'), trace = path.join(f.root, 'cancel-lock');
    const controller = await h.client(f, 'claude', { MOST_FAKE_CANCEL_LOCK_TRACE: trace });
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_SPAWN_BARRIER: barrier });
    const response = c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:wait', role: 'проверка' } }).then(value => ({ value }), error => ({ error }));
    let atSpawn, cancellation;
    try {
      try {
        atSpawn = await waitFile(barrier);
        cancellation = controller.callTool({ name: 'kimi_cancel', arguments: { id: atSpawn.id } }).then(value => ({ value }), error => ({ error }));
        const attempt = await waitFile(trace + '.attempt');
        assert.equal(attempt.ok, false, 'kimi_cancel не должен получить замок между последней проверкой и spawn'); assert(attempt.busy);
        assert(!fs.existsSync(trace + '.acquired'));
        assert.equal(h.cards(f).find(j => j.id === atSpawn.id).status, 'running');
      } finally { fs.writeFileSync(barrier + '.release', 'release'); }
      const sent = await response; if (sent.error) throw sent.error; assert(!sent.value.isError, h.text(sent.value));
      const cancelled = await cancellation; if (cancelled.error) throw cancelled.error; assert(!cancelled.value.isError, h.text(cancelled.value));
      const acquired = await waitFile(trace + '.acquired'); assert(acquired.childPid, 'отмена после spawn должна увидеть опубликованный PID');
      const ended = await h.wait(f, atSpawn.id); assert.equal(ended.status, 'cancelled', ended.error); assert(ended.stopConfirmed); assert(!ended.voteEligible);
      assert.throws(() => process.kill(acquired.childPid, 0), 'исполнитель должен завершиться');
      const lock = require('../common/write-lock').acquire(f.folder); assert(lock.ok); lock.release();
    } finally { await controller.close(); await c.close(); c = await h.client(f); }
  }],
  ['сбой записи stop не мешает остановке дерева; неудачная остановка повторяется', async () => {
    for (const fault of ['card-1', 'card-2', 'retry']) {
      const trace = path.join(f.root, 'stop-' + fault + '.jsonl');
      await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_STOP_FAULT: fault, MOST_FAKE_STOP_TRACE: trace });
      const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:child', role: 'проверка' } }); assert(!r.isError, h.text(r));
      const job = h.cards(f).find(j => j.status === 'running'); assert(job?.childPid);
      const descendant = await waitFile(path.join(job.tempFolder, 'child.json'));
      const result = await c.callTool({ name: 'kimi_cancel', arguments: { id: job.id } }); assert(!result.isError, h.text(result));
      const ended = await h.wait(f, job.id); assert.equal(ended.status, 'cancelled', fault + ': ' + ended.error); assert(ended.stopConfirmed);
      assert(!ended.voteEligible); assert.equal(ended.stopReason, 'cancel'); assert.throws(() => require('../common/kimi-review').evidence(ended));
      for (const pid of [job.childPid, descendant.pid]) assert.throws(() => process.kill(pid, 0), 'процесс ' + pid + ' должен завершиться');
      const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(e => e.name === 'write-failed').length, 1, fault);
      const kills = events.filter(e => e.name === 'taskkill'); assert(kills.length >= (fault === 'retry' ? 2 : 1), JSON.stringify(events));
      if (fault === 'retry') assert(events.some(e => e.name === 'fallback-kill' && e.attempt === 1));
      const lock = require('../common/write-lock').acquire(f.folder); assert(lock.ok); lock.release();
    }
    await c.close(); c = await h.client(f);
  }],
  ['stopReason останавливает ребёнка даже с running в карточке', async () => {
    const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:wait' } }); assert(!r.isError, h.text(r));
    const j = h.cards(f).find(j => j.status === 'running'); assert(j?.childPid);
    const locks = require('../common/locks'), lock = await locks.waitLock('kimi_job', j.id, { jobId: j.id }, 8000); assert(lock.ok);
    try { const file = path.join(f.state, 'kimi-jobs', j.id, 'card.json'), card = JSON.parse(fs.readFileSync(file)); card.stopReason = 'cancel'; fs.writeFileSync(file, JSON.stringify(card)); }
    finally { await lock.release(); }
    const ended = await h.wait(f, j.id); assert.equal(ended.status, 'cancelled', ended.error); assert(ended.stopConfirmed);
  }],
  ['material этапа: строки и path/file; неверный тип — понятный отказ до карточки', async () => {
    const work = path.join(f.root, 'works/material-types.json'); fs.mkdirSync(path.dirname(work), { recursive: true });
    const external = path.join(f.root, 'extra.txt'); fs.writeFileSync(external, 'внешний материал');
    for (const entry of ['extra.txt', { path: 'extra.txt' }, { file: 'extra.txt' }, null, 42, [], {}, { path: 42 }, '']) {
      fs.writeFileSync(work, JSON.stringify({ name: 'material-types', folder: f.root, stages: [{ id: 'stage', title: 'материал', material: [entry] }] }));
      const before = new Set(h.cards(f).map(j => j.id)), r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:success', work: 'material-types', stage: 'stage', role: 'совет' } });
      if (typeof entry === 'string' && entry || entry?.path === 'extra.txt' || entry?.file === 'extra.txt') {
        assert(!r.isError, h.text(r)); const card = h.cards(f).find(j => !before.has(j.id)), ended = await h.wait(f, card.id);
        assert.equal(ended.status, 'done', ended.error); assert.deepEqual(ended.material, [external]); assert(ended.readOnlyCheck.coveredRoots.includes(fs.realpathSync(external)));
      } else { assert(r.isError); assert.match(h.text(r), /material\[0\].*path\/file/); assert.equal(h.cards(f).length, before.size); }
    }
  }],
  ['отмена дерева: дочерний процесс завершён, замок отпущен', async () => {
    const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:child' } }); assert(!r.isError, h.text(r));
    const j = h.cards(f).find(j => j.status === 'running'); assert(j);
    const childFile = path.join(j.tempFolder, 'child.json'); for (let i = 0; i < 100 && !fs.existsSync(childFile); i++) await new Promise(r => setTimeout(r, 50)); assert(fs.existsSync(childFile));
    await c.callTool({ name: 'kimi_cancel', arguments: { id: j.id } }); const ended = await h.wait(f, j.id); assert.equal(ended.status, 'cancelled', ended.error); assert(ended.stopConfirmed);
    const lock = require('../common/write-lock').acquire(f.folder); assert(lock.ok); lock.release();
  }],
  ['отмена и явный deadline имеют приоритет над текстом отказа; поздний ответ отдельный', async () => {
    for (const cause of ['cancel', 'deadline']) {
      const before = new Set(h.cards(f).map(j => j.id));
      const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:late', role: 'проверка' } }); assert(!r.isError, h.text(r));
      const j = h.cards(f).find(j => !before.has(j.id)), stream = path.join(f.state, 'kimi-jobs', j.id, 'stream.ndjson');
      for (let i = 0; i < 100 && (!fs.existsSync(stream) || !fs.readFileSync(stream, 'utf8').includes('assistant')); i++) await new Promise(r => setTimeout(r, 50));
      assert(fs.readFileSync(stream, 'utf8').includes('assistant'));
      if (cause === 'cancel') await c.callTool({ name: 'kimi_cancel', arguments: { id: j.id } });
      else { const file = path.join(f.state, 'kimi-jobs', j.id, 'card.json'), card = JSON.parse(fs.readFileSync(file)); card.deadline = new Date(Date.now() - 1).toISOString(); fs.writeFileSync(file, JSON.stringify(card)); }
      const end = await h.wait(f, j.id); assert.equal(end.status, cause === 'cancel' ? 'cancelled' : 'failed'); assert(end.stopConfirmed); assert(end.lateResultFile); assert(!end.voteEligible);
      assert.match(fs.readFileSync(end.lateResultFile, 'utf8'), /^НЕ ПРИНЯТО/); assert.throws(() => require('../common/kimi-review').evidence(end));
    }
  }],
  ['пять входящих контекстов видят send/result; Kimi — отправитель при А3, чат-клиент только при А4 (одно не выводит другого)', () => {
    const access = require('../common/access'), members = require('../common/members');
    // team-v56 А3/А5: включаем исходящие Kimi (sends) и получателя-кодекс. team-v56 А4 (чат-клиент) при этом не появляется.
    f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').roles.sends = true; const d = n.members.find(m => m.id === 'deepseek'); d.roles.sends = true; n.members.find(m => m.id === 'claude').roles.receives = true; }, { action: 'test', who: 'claude', reason: 'проверка' }, { phase: 'B' });
    for (const from of ['claude', 'codex', 'antigravity', 'deepseek', 'claude-print']) assert(access.guestTools('kimi', from).includes('kimi_send'), from);
    // А3: Kimi теперь полноправный отправитель (sends=true) существующему получателю. Запрет Kimi → Kimi/цикла — правило
    // job-chain получателя, не этой регистровой проверки; здесь важно, что способность исходящих у места включена.
    assert(members.canSend('kimi', 'codex'));
    // А4: чат-клиента Kimi по-прежнему нет — способность исходящих (А3) не создаёт клиентского профиля (А4).
    assert(!require('../common/member-clients').all().some(c => c.id === 'kimi'));
  }],
  ['входящие MCP из Codex/Antigravity/DeepSeek и Claude-исполнителя: очередь → карточка → ответ', async () => {
    await c.close();
    const at = new Date().toISOString(), tree = JSON.stringify([{ pid: 'self', ppid: 7001, startedAt: at }, { pid: 7001, ppid: 1, name: 'test-client', startedAt: at }]);
    fs.mkdirSync(path.join(f.state, 'ready'), { recursive: true }); fs.writeFileSync(path.join(f.state, 'ready/team.json'), JSON.stringify({ pid: 8002, startedAt: at }));
    c = await h.client(f, 'claude', { MOST_PROBE_ONLY: '0', MOST_TEST_PROCESS_TREE: tree });
    for (const from of ['codex', 'antigravity', 'deepseek', 'claude-print']) {
      const parentId = 'incoming-parent';
      if (from === 'claude-print') {
        fs.mkdirSync(path.join(f.state, 'claude-jobs'), { recursive: true });
        fs.writeFileSync(path.join(f.state, 'claude-jobs', parentId + '.json'), JSON.stringify({ id: parentId, status: 'running', role: 'совет', childPid: 7001, childStartedAt: at, startedAt: at, deadline: new Date(Date.now() + 600000).toISOString() }));
      }
      const env = { MOST_TEST_PROCESS_TREE: tree, ...(from === 'claude-print' ? require('../common/fallback').jobEnv(parentId, {}) : {}) };
      const guest = await h.client(f, from, env);
      try {
        const toolNames = (await guest.listTools()).tools.map(t => t.name); assert(toolNames.includes('kimi_send'), from + ': ' + toolNames.join(','));
        const before = new Set(h.cards(f).map(j => j.id)); const r = await guest.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:success', role: 'проверка' } }); assert(!r.isError, from + ': ' + h.text(r));
        const queued = h.cards(f).find(j => !before.has(j.id)); assert(queued); const j = await h.wait(f, queued.id); assert.equal(j.status, 'done', from + ': ' + j.error); assert.equal(j.from, from === 'claude-print' ? 'claude' : from);
        const answer = await guest.callTool({ name: 'kimi_result', arguments: { id: j.id } }); assert.match(h.text(answer), /Число: 42/);
        const afterResult = h.cards(f).find(x => x.id === j.id);
        if (from === 'claude-print') {
          assert.equal(j.parentJob, parentId); assert(j.deadline); assert.throws(() => require('../common/kimi-review').evidence(j), /независимый/);
          // team-v56 Л2 (круг 5, М1): сервер-получатель записал отметку ВЫДАЧИ готового результата потомка его родителю —
          // именно этот путь кода исполняется здесь (не фикстура). Отметка: кому (parentJob), когда (≥ finishedAt), sha результата.
          const dels = afterResult.resultDeliveries; assert(Array.isArray(dels) && dels.length === 1, 'отметка выдачи записана: ' + JSON.stringify(dels));
          const rf = afterResult.resultFile, abs = path.isAbsolute(rf) ? rf : path.join(f.state, 'kimi-jobs', j.id, rf);
          const sha = launch.sha(fs.readFileSync(abs, 'utf8'));
          assert.equal(dels[0].to, parentId, 'отметка выдачи — именно этому родителю');
          assert.equal(dels[0].sha256, sha, 'sha отметки = sha выданного результата');
          assert(Date.parse(dels[0].at) >= Date.parse(afterResult.finishedAt), 'момент выдачи не раньше finishedAt потомка');
          // Повторный запрос тем же родителем отметку не дублирует (идемпотентно).
          await guest.callTool({ name: 'kimi_result', arguments: { id: j.id } });
          assert.equal(h.cards(f).find(x => x.id === j.id).resultDeliveries.length, 1, 'повторная выдача того же результата отметку не дублирует');
        } else {
          // Вызывающий без собственного поручения-родителя (нет MOST_JOB_ID) — отметки выдачи нет.
          assert.equal(afterResult.resultDeliveries, undefined, from + ': без родителя отметки выдачи нет');
        }
      } catch (e) { throw Error(from + ': ' + e.message); } finally { await guest.close(); }
    }
  }],
  ['неполный снимок остановки: stop_unconfirmed, без голоса, замок сохранён', async () => {
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_INCOMPLETE_TREE: '1' });
    const folder = path.join(f.root, 'uncertain'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'x'), 'x');
    const j = await send('FAKE:success', { folder, role: 'проверка' }); assert.equal(j.status, 'stop_unconfirmed'); assert(j.stopUnconfirmed); assert(!j.voteEligible);
    // team-v59 (A4): чтение не держит замок папки даже при неподтверждённой остановке — продолжение всё равно запрещено по
    // stopUnconfirmed/treeWarning, а не по замку папки (защита «два писателя» к читателю не относится).
    assert.throws(() => require('../common/kimi-review').evidence(j)); { const dl = require('../common/write-lock').acquire(folder); assert.equal(dl.ok, true, 'A4: чтение не держит папку'); dl.release(); }
    const card = path.join(f.state, 'kimi-jobs', j.id, 'card.json'); j.owner = { instance: 'nonexistent-owner', pid: 2147483647 }; j.status = 'running'; fs.writeFileSync(card, JSON.stringify(j));
    await c.callTool({ name: 'kimi_result', arguments: { id: j.id } }); assert.equal(h.cards(f).find(x => x.id === j.id).status, 'lost');
    { const dl = require('../common/write-lock').acquire(folder); assert.equal(dl.ok, true, 'A4: чтение не держит папку и после lost'); dl.release(); }
  }],
  ['снимок показывает пережившего родителя ребёнка: PID сохраняется для запрета stop_confirm', async () => {
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_ORPHAN_PID: String(process.pid) });
    const folder = path.join(f.root, 'orphan-material'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'x'), 'x');
    const j = await send('FAKE:orphan', { folder, role: 'проверка' });
    const child = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'child.json')));
    assert.equal(child.pid, process.pid); assert.equal(j.status, 'stop_unconfirmed'); assert(j.observedPids.includes(child.pid)); assert(require('../common/live-jobs').cardPids(j).includes(child.pid));
    { const dl = require('../common/write-lock').acquire(folder); assert.equal(dl.ok, true, 'A4: чтение не держит папку'); dl.release(); } assert.throws(() => require('../common/kimi-review').evidence(j));
  }],
];
h.run(tests).finally(async () => { if (c) await c.close(); });
