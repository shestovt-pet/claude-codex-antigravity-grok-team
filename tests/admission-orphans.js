'use strict';
// team-v56 Б0: admission/request_id и снятие осиротевшего замка. Модульные границы admission (четыре адаптера через
// общий модуль), выбор замка внешней отмены по адаптеру, снятие замка по точному instance и сквозной request_id у
// основного kimi_send: повтор — тот же номер, конфликт параметров — REQUEST_ID_CONFLICT без следов на диске.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const h = require('./fake-kimi'), f = h.setup(); f.active(); f.probe();
let c;

const tests = [
  ['job-admission: reserve/дедуп/конфликт без следов/commit/releaseUnpublished; принципал разделяет область', async () => {
    const adm = require('../common/job-admission');
    const st = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const h1 = adm.requestHash([['folder', '/x'], ['task', 'a'], ['text', undefined]]);
    const h2 = adm.requestHash([['folder', '/x'], ['task', 'b'], ['text', undefined]]);
    const base = { state: st, adapter: 'kimi-cli', principal: 'chat:claude', requestId: 'r1' };
    const r1 = await adm.reserve({ ...base, hash: h1, newJobId: 'job-A' });
    assert.equal(r1.duplicate, false); assert.equal(r1.jobId, 'job-A');
    const r2 = await adm.reserve({ ...base, hash: h1, newJobId: 'job-B' });
    assert.equal(r2.duplicate, true); assert.equal(r2.jobId, 'job-A');
    const n = fs.readdirSync(adm.dir(st)).length;
    await assert.rejects(adm.reserve({ ...base, hash: h2, newJobId: 'job-C' }), /REQUEST_ID_CONFLICT/);
    assert.equal(fs.readdirSync(adm.dir(st)).length, n, 'конфликт не оставляет следов');
    // Другой принципал — отдельная область уникальности.
    const r3 = await adm.reserve({ ...base, principal: 'chat:codex', hash: h2, newJobId: 'job-D' });
    assert.equal(r3.duplicate, false); assert.equal(r3.jobId, 'job-D');
    adm.commit(st, r1.admissionId, { instance: 'inst-1' });
    assert.equal(adm.read(st, r1.admissionId).committed, true);
    assert.equal(adm.read(st, r1.admissionId).lockInstance, 'inst-1');
    assert.equal(adm.releaseUnpublished(st, r1.admissionId).released, false, 'коммит не откатывается узким путём');
    // Незакоммиченную запись узкий откат снимает; чужой instance не трогает.
    const r4 = await adm.reserve({ state: st, adapter: 'codex-cli', principal: 'chat:claude', requestId: 'r9', hash: h1, newJobId: 'job-E' });
    assert.equal(adm.releaseUnpublished(st, r4.admissionId, { instance: 'не-тот' }).released, false, 'чужой instance не снимает');
    assert.equal(adm.releaseUnpublished(st, r4.admissionId).released, true);
    assert.equal(adm.read(st, r4.admissionId), null);
    // team-v56 Б0 п.3: releaseUnpublished с lock снимает И admission, И ровно тот замок по instance (узкий откат без
    // обхода чужих карточек). Берём реальный write-lock и откатываем его вместе с незакоммиченной записью. team-v56 Н4:
    // write-lock и admission — в одном (рабочем) state, как в бою (releaseOrphan снимает замок именно в этом state).
    const wl = require('../common/write-lock'), { stateDir } = require('../common/paths');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-rb-'));
    const lk = await wl.acquire(d, { jobId: 'rb-job' }); assert(lk.ok);
    const r5 = await adm.reserve({ adapter: 'kimi-cli', principal: 'chat:claude', requestId: 'r-rb', hash: h1, newJobId: 'rb-job' });
    const out = adm.releaseUnpublished(stateDir, r5.admissionId, { lock: { instance: lk.owner.instance, folder: d, jobId: 'rb-job' } });
    assert.equal(out.released, true, 'узкий откат снял admission');
    assert.equal(adm.read(stateDir, r5.admissionId), null, 'admission удалена откатом');
    assert(!wl.entries().some(e => e.entry.instance === lk.owner.instance), 'точный замок снят по instance');
  }],

  ['job-cancel: замок карточки внешней отмены выбирается по адаптеру (Б0)', () => {
    const jc = require('../common/job-cancel');
    assert.equal(jc.jobLock('codex-cli'), 'codex_job');
    assert.equal(jc.jobLock('kimi-cli'), 'kimi_job');
    assert.equal(jc.jobLock('dsh-headless'), 'deepseek_job');
    assert.equal(jc.jobLock('claude-print'), 'claude_job');
    assert.equal(jc.jobLock('agy-cli'), 'job');
    assert.equal(jc.jobLock('неизвестный'), 'job');
  }],

  ['write-lock: снятие осиротевшего замка по точному instance; чужой новый замок не трогаем; повтор идемпотентен', () => {
    const wl = require('../common/write-lock'), paths = require('../common/paths');
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wl1-')), d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wl2-'));
    const cf1 = paths.canon(fs.realpathSync(d1)), cf2 = paths.canon(fs.realpathSync(d2));
    fs.mkdirSync(wl.dir(), { recursive: true });
    const i1 = 'inst-aaaa', i2 = 'inst-bbbb';
    fs.writeFileSync(wl.entryFile(cf1), JSON.stringify({ folder: cf1, jobId: 'j1', instance: i1, pid: 1, since: new Date().toISOString() }));
    fs.writeFileSync(wl.entryFile(cf2), JSON.stringify({ folder: cf2, jobId: 'j2', instance: i2, pid: 1, since: new Date().toISOString() }));
    assert(wl.entries().some(e => e.entry.instance === i1));
    assert.throws(() => wl.releaseOrphan({ instance: i1, folder: d2, jobId: 'j1' }), /Папка не совпадает/);
    assert.throws(() => wl.releaseOrphan({ instance: i1, folder: d1, jobId: 'другой' }), /Номер поручения не совпадает/);
    const r = wl.releaseOrphan({ instance: i1, folder: d1, jobId: 'j1' });
    assert.equal(r.released, true);
    assert(!wl.entries().some(e => e.entry.instance === i1), 'i1 снят');
    assert(wl.entries().some(e => e.entry.instance === i2), 'i2 (чужой) сохранён');
    assert.equal(wl.releaseOrphan({ instance: i1 }).absent, true, 'повтор — absent');
    fs.unlinkSync(wl.entryFile(cf2));
  }],

  ['kimi_send request_id: повтор — тот же номер; конфликт параметров — REQUEST_ID_CONFLICT без следов; без request_id контракт не меняется', async () => {
    c = await h.client(f);
    const admDir = path.join(f.state, 'admissions'), jobsDir = path.join(f.state, 'kimi-jobs');
    const admFiles = () => fs.existsSync(admDir) ? fs.readdirSync(admDir) : [];
    const jobDirs = () => fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).length : 0;
    const diff = 'diff --git a/data.txt b/data.txt\n-base\n+candidate';
    const call = args => c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, role: 'проверка', text: diff, ...args } });

    // 1) Первый запрос с request_id: карточка создана, admission закоммичена.
    const before1 = new Set(h.cards(f).map(j => j.id));
    const r1 = await call({ task: 'FAKE:success', request_id: 'req-A' });
    assert(!r1.isError, h.text(r1));
    const j1 = h.cards(f).find(j => !before1.has(j.id)); assert(j1, 'карточка создана');
    assert.equal(admFiles().length, 1, 'одна admission-запись');
    const adm1 = JSON.parse(fs.readFileSync(path.join(admDir, admFiles()[0]), 'utf8'));
    assert.equal(adm1.committed, true); assert.equal(adm1.jobId, j1.id); assert.equal(adm1.requestId, 'req-A'); assert.equal(adm1.adapter, 'kimi-cli');

    // 2) Повтор того же запроса — та же карточка, без новой admission.
    const cardsBefore = h.cards(f).length;
    const r2 = await call({ task: 'FAKE:success', request_id: 'req-A' });
    assert(!r2.isError, h.text(r2));
    assert.equal(h.cards(f).length, cardsBefore, 'новая карточка не создана');
    assert.equal(admFiles().length, 1, 'новой admission нет');

    // 3) Конфликт: тот же request_id, другой task — REQUEST_ID_CONFLICT без следов на диске.
    const dirsBefore = jobDirs();
    const r3 = await call({ task: 'FAKE:changed', request_id: 'req-A' });
    assert(r3.isError, 'конфликт — ошибка');
    assert.match(h.text(r3), /REQUEST_ID_CONFLICT/);
    assert.equal(jobDirs(), dirsBefore, 'нет нового каталога карточки');
    assert.equal(admFiles().length, 1, 'нет новой admission');
    assert.equal(h.cards(f).find(j => j.id === j1.id).task, 'FAKE:success', 'прежняя карточка не изменена');

    // 4) Без request_id (этап 2): admission ВСЕГДА; сервер выдаёт новый ID и показывает его в ответе.
    const before4 = new Set(h.cards(f).map(j => j.id));
    const r4 = await call({ task: 'FAKE:success' });
    assert(!r4.isError, h.text(r4));
    const j4 = h.cards(f).find(j => !before4.has(j.id)); assert(j4, 'карточка без request_id создана');
    assert.equal(admFiles().length, 2, 'без request_id admission создаётся автоматически');
    assert.match(String(j4.requestId), /^auto-/, 'авто-request_id сохранён в карточке');
    assert.match(h.text(r4), /ID запроса \(для повтора\)/, 'ID запроса показан в ответе');
    const adm4 = admFiles().map(fn => JSON.parse(fs.readFileSync(path.join(admDir, fn), 'utf8'))).find(r => r.jobId === j4.id);
    assert(adm4 && adm4.committed === true && adm4.requestId === j4.requestId, 'авто-admission закоммичена и привязана');

    // 5) Повтор с показанным авто-ID — тот же номер (дедупликация гарантируется повтором этого ID).
    const cardsBefore5 = h.cards(f).length;
    const r5 = await call({ task: 'FAKE:success', request_id: j4.requestId });
    assert(!r5.isError, h.text(r5));
    assert.equal(h.cards(f).length, cardsBefore5, 'повтор авто-ID не создаёт карточку');
    assert.match(h.text(r5), new RegExp(j4.id.slice(0, 8)), 'повтор вернул тот же номер');

    // 6) team-v56 (ревью Kimi №9): хеш request_id охватывает и не-task поля. Тот же request_id, тот же task, но другой
    // owner → REQUEST_ID_CONFLICT без новой карточки.
    const r6a = await call({ task: 'FAKE:success', request_id: 'req-S', owner: 'влад-A' });
    assert(!r6a.isError, h.text(r6a));
    const dirs6 = jobDirs();
    const r6b = await call({ task: 'FAKE:success', request_id: 'req-S', owner: 'влад-B' });
    assert(r6b.isError && /REQUEST_ID_CONFLICT/.test(h.text(r6b)), 'другой owner при том же request_id → конфликт');
    assert.equal(jobDirs(), dirs6, 'конфликт по не-task полю не создаёт каталог карточки');
  }],

  ['release_orphan/revokeByJob: отзыв незавершённой постановки снимает блокировку установочного барьера (Б0 п.5)', async () => {
    const adm = require('../common/job-admission'), migration = require('../common/members-kimi');
    const st = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-rev-'));
    const h1 = adm.requestHash([['folder', '/x']]);
    // Незавершённая постановка (committed:false) + session-reservation одного осиротевшего поручения.
    const a1 = await adm.reserve({ state: st, adapter: 'codex-cli', principal: 'chat:claude', requestId: 'r-orph', hash: h1, newJobId: 'orph-job' });
    const skey = adm.sessionKey('cli-sha', 'sess-1', st);
    adm.reserveSession(st, skey, { jobId: 'orph-job' });
    // Чужая завершённая постановка (committed) другого поручения — её не трогаем.
    const a2 = await adm.reserve({ state: st, adapter: 'codex-cli', principal: 'chat:codex', requestId: 'r-keep', hash: h1, newJobId: 'keep-job' });
    adm.commit(st, a2.admissionId);
    // install-gate-simple (24.11.2026): ворота установки видят только живые процессы — незавершённая постановка без процесса
    // установку не держит и не выводится.
    { const b = migration.installationBlockers(st); assert(!b.running.length && !b.blockers.length, 'незавершённая постановка ворота не держит: ' + JSON.stringify(b)); }
    // Отзыв по jobId снимает admission и reservation осиротевшего поручения; чужую committed-запись сохраняет.
    const revoked = adm.revokeByJob(st, 'orph-job').removed;
    assert(revoked.length >= 2, 'сняты admission и reservation: ' + revoked.join(','));
    assert.equal(adm.read(st, a1.admissionId), null, 'незавершённая admission снята');
    assert.equal(adm.readSession(st, skey), null, 'reservation снята');
    assert(adm.read(st, a2.admissionId) && adm.read(st, a2.admissionId).committed === true, 'чужая committed-запись сохранена');
    assert(!migration.installationBlockers(st).blockers.some(x => x.includes('orph-job')), 'после отзыва барьер не блокируется этой записью');
  }],

  ['team-v56 Н5 (ревью Kimi 6): опубликованная карточка + committed:false не блокирует барьер; releaseUnpublished после публикации — no-op', async () => {
    const adm = require('../common/job-admission'), migration = require('../common/members-kimi'), wl = require('../common/write-lock');
    const st = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-n5-'));
    // 1) Карточка опубликована (на диске), admission ещё committed:false (запоздавший/оборванный commit) → барьер НЕ
    // блокирует этой записью (публикация состоялась).
    const jobId = 'pub-job';
    const a1 = await adm.reserve({ state: st, adapter: 'kimi-cli', principal: 'chat:claude', requestId: 'n5-1', hash: adm.requestHash([['folder', '/x']]), newJobId: jobId });
    const cdir = path.join(st, 'kimi-jobs', jobId); fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'card.json'), JSON.stringify({ id: jobId, status: 'done', threadId: 't', finishedAt: new Date().toISOString(), exitCode: 0 }));
    assert.equal(adm.read(st, a1.admissionId).committed, false, 'commit ещё не прошёл');
    assert(!migration.installationBlockers(st).blockers.some(x => x.includes(jobId) && x.includes('постановка не завершена')), 'опубликованная карточка снимает блокировку незакоммиченной admission');
    // 2) releaseUnpublished после публикации — no-op: admission и замок не трогаются.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-n5-'));
    const lk = await wl.acquire(d, { jobId }); assert(lk.ok);
    const out = adm.releaseUnpublished(st, a1.admissionId, { lock: { instance: lk.owner.instance, folder: d, jobId }, published: true });
    assert.equal(out.released, false, 'после публикации releaseUnpublished — no-op');
    assert(adm.read(st, a1.admissionId), 'admission не удалена'); assert(wl.entries().some(e => e.entry.instance === lk.owner.instance), 'замок не снят');
    lk.release();
  }],

  ['два параллельных continue_id одного сеанса (А2): запускается ровно один, второй — SESSION_BUSY', async () => {
    if (!c) c = await h.client(f);
    f.roles({ writer: true });
    const folder = path.join(f.root, 'cont-parallel'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'data.txt'), 'x');
    // Исходный писатель → needs_decision + sessionId.
    const b0 = new Set(h.cards(f).map(j => j.id));
    const r0 = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write-quota', role: 'текст', write: true } });
    assert(!r0.isError, h.text(r0));
    const prior = await h.wait(f, h.cards(f).find(j => !b0.has(j.id)).id);
    assert.equal(prior.status, 'needs_decision', JSON.stringify(prior)); assert.equal(prior.sessionId, 'session_fixture');
    // Два параллельных продолжения (FAKE:wait — держатся running), сериализуются общим kimi_queue/all + reservation.
    const mk = () => c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:wait', role: 'текст', write: true, continue_id: prior.id } }).then(v => ({ v }), e => ({ e }));
    const res = await Promise.all([mk(), mk()]);
    const ok = res.filter(x => x.v && !x.v.isError), busy = res.filter(x => x.v && x.v.isError);
    assert.equal(ok.length, 1, 'ровно одно продолжение принято: ' + JSON.stringify(res.map(x => x.v && h.text(x.v))));
    assert.equal(busy.length, 1, 'второе продолжение отвергнуто');
    assert.match(h.text(busy[0].v), /SESSION_BUSY|уже выполняется|уже продолжено|завершённая карточка|больше не допускает продолжение/);
    // На диске ровно одна карточка-продолжение; передана вершина цепочки.
    const conts = h.cards(f).filter(j => j.previous === prior.id);
    assert.equal(conts.length, 1, 'на диске одна карточка-продолжение'); const cont = conts[0];
    assert.equal(cont.sessionId, 'session_fixture'); assert(cont.cliIdentity && cont.cliIdentity.sha256); assert(cont.sessionKey);
    const priorAfter = h.cards(f).find(j => j.id === prior.id);
    assert.equal(priorAfter.status, 'failed'); assert.equal(priorAfter.decision, 'continued'); assert.equal(priorAfter.continuedBy, cont.id);
    // Запущен именно один CLI: --session использован, профиль не передан.
    for (let i = 0; i < 300 && !fs.existsSync(path.join(cont.tempFolder, 'observed.json')); i++) await new Promise(r => setTimeout(r, 50));
    const obs = JSON.parse(fs.readFileSync(path.join(cont.tempFolder, 'observed.json')));
    assert(obs.argv.includes('--session')); assert.equal(obs.argv[obs.argv.indexOf('--session') + 1], 'session_fixture');
    assert(!obs.argv.includes('--agent-file'), 'продолжение не передаёт профиль');
    // Уборка: отменить работающее продолжение.
    await c.callTool({ name: 'kimi_cancel', arguments: { id: cont.id } }); await h.wait(f, cont.id);
    await c.close(); c = null;
  }],

  ['продолжение завершённой (done) карточки: повтор request_id — прежний jobId; повторно продолжить нельзя (Codex №4)', async () => {
    if (!c) c = await h.client(f);
    f.roles({ writer: true });
    const folder = path.join(f.root, 'cont-done'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'data.txt'), 'x');
    const b0 = new Set(h.cards(f).map(j => j.id));
    const r0 = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true } });
    assert(!r0.isError, h.text(r0));
    const prior = await h.wait(f, h.cards(f).find(j => !b0.has(j.id)).id);
    assert.equal(prior.status, 'done', JSON.stringify(prior)); assert.equal(prior.sessionId, 'session_fixture');
    // Продолжение done с явным request_id.
    const r1 = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id, request_id: 'cont-req-1' } });
    assert(!r1.isError, h.text(r1));
    const cont = h.cards(f).find(j => j.previous === prior.id); assert(cont, 'карточка-продолжение создана'); await h.wait(f, cont.id);
    // Исходная done помечена continuedBy и остаётся done (не терминально-негативна, частичного результата нет).
    const priorAfter = h.cards(f).find(j => j.id === prior.id);
    assert.equal(priorAfter.continuedBy, cont.id, 'вершина передана'); assert.equal(priorAfter.status, 'done', 'done остаётся done');
    // Повтор ТОГО ЖЕ request_id — прежний jobId продолжения, без новой карточки и без «уже продолжено» (идемпотентность).
    const cntBefore = h.cards(f).length;
    const r1b = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id, request_id: 'cont-req-1' } });
    assert(!r1b.isError, 'повтор продолжения не ошибка: ' + h.text(r1b));
    assert.match(h.text(r1b), new RegExp(cont.id.slice(0, 8)), 'повтор вернул прежний jobId продолжения');
    assert.equal(h.cards(f).length, cntBefore, 'повтор не создаёт новую карточку');
    // Другой request_id, продолжающий уже продолженную done — отказ «уже продолжено», без следов на диске.
    const r2 = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id, request_id: 'cont-req-2' } });
    assert(r2.isError && /уже продолжено/.test(h.text(r2)), 'повторное продолжение завершённой карточки запрещено: ' + h.text(r2));
    assert.equal(h.cards(f).length, cntBefore, 'отказ продолжения не оставляет карточку');
    await c.close(); c = null;
  }],

  ['job-cancel из отдельного процесса: общий замок адаптера; отмена queued запрещает spawn; занятый claim не даёт ложного cancelled (Kimi/Claude/DeepSeek)', async () => {
    const locks = require('../common/locks'), jc = require('../common/job-cancel');
    // Включить receives у claude/deepseek — без этого они не helpers и job-cancel их не примет; dsh действует только в фазе B.
    f.store.update(f.store.read().rev, n => { for (const id of ['claude', 'deepseek']) n.members.find(m => m.id === id).roles.receives = true; }, { action: 'test', who: 'claude', reason: 'очередь для отмены' }, { phase: 'B' });
    const roots = require('../common/team-store').roots();
    const cardFile = (who, id) => who === 'kimi' ? path.join(roots[who], id, 'card.json') : path.join(roots[who], id + '.json');
    const writeCard = (who, id, card) => { const dir = roots[who]; if (who === 'kimi') fs.mkdirSync(path.join(dir, id), { recursive: true }); else fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cardFile(who, id), JSON.stringify(card, null, 2)); };
    const readCard = (who, id) => JSON.parse(fs.readFileSync(cardFile(who, id), 'utf8'));
    // Отдельный процесс реально вызывает common/job-cancel.cancel.
    const cancelInChild = (who, id) => new Promise(resolve => {
      const child = require('child_process').spawn(process.execPath, ['-e',
        'require(process.env.JC).cancel(process.argv[1], process.argv[2]).then(j => { process.stdout.write(JSON.stringify({ status: j.status, launch: j.launch || null })); process.exit(0); }).catch(e => { process.stderr.write(String(e.message)); process.exit(2); });',
        who, id], { env: { ...process.env, JC: require.resolve('../common/job-cancel') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
      child.on('close', code => resolve({ code, out, err }));
    });
    const adapters = { kimi: 'kimi-cli', claude: 'claude-print', deepseek: 'dsh-headless' };
    for (const who of ['kimi', 'claude', 'deepseek']) {
      const adapter = adapters[who];
      // (1) Общий с сервером замок: держим jobLock адаптера — дочерняя отмена не завершает карточку, пока держим.
      const qid = 'cancel-queued-' + who + '-' + Math.random().toString(36).slice(2, 8);
      writeCard(who, qid, { id: qid, status: 'queued', role: 'совет', startedAt: new Date().toISOString() });
      const held = await locks.waitLock(jc.jobLock(adapter), qid, { jobId: qid }, 8000); assert(held.ok, who);
      const pending = cancelInChild(who, qid);
      await new Promise(r => setTimeout(r, 800));
      assert.equal(readCard(who, qid).status, 'queued', who + ': отмена не прошла, пока держим общий замок карточки');
      await held.release();
      const r1 = await pending; assert.equal(r1.code, 0, who + ': ' + r1.err);
      const after = readCard(who, qid);
      assert.equal(after.status, 'cancelled', who + ': выигравшая отмена queued');
      if (who === 'kimi') { assert.equal(after.launch, 'forbidden', 'kimi: отмена queued запрещает spawn'); assert.equal(JSON.parse(r1.out).launch, 'forbidden'); }
      // (2) Занятый claim: running карточка — отмена отдаёт актуальный статус без ложного cancelled и не перезаписывает её.
      const rid = 'cancel-run-' + who + '-' + Math.random().toString(36).slice(2, 8);
      writeCard(who, rid, { id: rid, status: 'running', role: 'совет', startedAt: new Date().toISOString(), owner: { instance: 'srv' } });
      const r2 = await cancelInChild(who, rid); assert.equal(r2.code, 0, who + ': ' + r2.err);
      assert.equal(JSON.parse(r2.out).status, 'running', who + ': running не отменяется ложно');
      assert.equal(readCard(who, rid).status, 'running', who + ': свежая карточка не перезаписана');
    }
  }],
];
h.run(tests).finally(async () => { if (c) await c.close(); });
