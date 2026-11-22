'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const h = require('./fake-kimi'), f = h.setup(); f.active(); f.probe();
const launch = require('../common/kimi-launch'), material = require('../common/kimi-material'), review = require('../common/kimi-review');
const store = require('../common/team-store'), seats = require('../common/team-seats'); let seq = 0;
function evidence(task = '#12345678 base ' + 'a'.repeat(40) + ' candidate ' + 'b'.repeat(40), answer = 'ПРИНЯТО', fields = {}) {
  const id = 'vote-' + ++seq, bundle = path.join(f.state, 'kimi-jobs', id); fs.mkdirSync(bundle, { recursive: true });
  // team-v56 А1: профиль проверки, политика MCP none и ноль исходящих — часть доказательства независимого ревью.
  const reviewProfile = launch.profile({ role: 'проверка', write: false, fullAccess: false });
  const j = { id, folder: f.folder, task, model: launch.DEFAULT, requestedModel: launch.DEFAULT, launchModel: launch.DEFAULT, modelArgumentConfirmed: true, modelConfirmed: false, reportedModel: null,
    write: false, fullAccess: false, previous: null, role: 'проверка', status: 'done', exitCode: 0, stopConfirmed: { basis: 'test' }, executionIsolation: 'none', kimiVersion: '2.5.3',
    profileKind: 'review', profileSha256: reviewProfile.sha256, mcpPolicy: 'none', outgoingCount: 0, outgoingVerified: true,
    startedAt: new Date(Date.now() + seq * 1000).toISOString(), finishedAt: new Date(Date.now() + seq * 1000 + 1).toISOString(), ...review.eligibility(), ...fields };
  const p = material.prepare(j, bundle); Object.assign(j, p.fields); j.readOnlyCheck = { ...j.readOnlyCheck, ...material.verify(p, bundle) }; p.held.forEach(l => l.release());
  j.resultFile = path.join(bundle, id + '.result.txt'); fs.writeFileSync(j.resultFile, answer); j.resultSha256 = launch.sha(answer); j.provenance = require('../common/provenance').forJob(j, 'kimi');
  // team-v56 А1 (ревью Kimi №4/Codex №6): evidence() проверяет ФАКТИЧЕСКИЙ поток stream.ndjson (только read-инструменты,
  // полный финальный ответ). Пишем настоящий образец формата Kimi: версия, tool_calls=Read, результат tool, финальный ответ.
  fs.writeFileSync(path.join(bundle, 'stream.ndjson'),
    '{"role":"meta","type":"system.version","version":"2.5.3"}\n' +
    '{"role":"assistant","tool_calls":[{"type":"function","id":"t1","function":{"name":"Read"}}]}\n' +
    '{"role":"tool","tool_call_id":"t1","content":"материал"}\n' +
    JSON.stringify({ role: 'assistant', content: answer }) + '\n');
  fs.writeFileSync(path.join(bundle, 'card.json'), JSON.stringify(j)); return j;
}
function mergePaused(c) {
  // Выполняется точная ветка merge из боевого Team, не копия алгоритма в тесте.
  const source = fs.readFileSync(path.join(__dirname, '../common/team.js'), 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('          for (const m of members.all().filter(m => members.paused');
  const end = source.indexOf('\n        }\n\n        save', begin);
  assert(begin >= 0 && end > begin, 'Ветка merge найдена'); const code = source.slice(begin, end);
  // team-v59 (часть 1): ветка merge ссылается на ownerClosed (место, закрытое словом владельца) — он определён выше по функции,
  // вне извлечённого среза; в этих тестах слов владельца нет, поэтому передаём () => false.
  return new Function('c', 'phase', 'candidate', 'members', 'seats', 'ownerClosed', code)(c, 'verdict', c.candidate, require('../common/members'), seats, () => false);
}
const models = { anthropic: 'claude-sonnet-4', openai: 'gpt-6', google: 'gemini-4', deepseek: 'deepseek-v4', moonshot: launch.DEFAULT };
const peers = { openai: 'codex', google: 'antigravity', deepseek: 'deepseek', moonshot: 'kimi' };
function peer(family, fields, answer = 'ПРИНЯТО') {
  if (family === 'moonshot') return evidence(fields.task, answer, fields);
  const who = peers[family], id = 'peer-' + ++seq, dir = path.join(store.roots()[who], id); fs.mkdirSync(dir, { recursive: true });
  const j = { id, status: 'done', role: 'проверка', write: false, mode: 'review', model: models[family], profile: 'most-review', modelConfirmed: true, reportedModel: models[family], dshVersion: '1.0.0',
    startedAt: new Date(Date.now() + seq * 1000).toISOString(), finishedAt: new Date(Date.now() + seq * 1000 + 1).toISOString(), ...fields, resultFile: path.join(dir, id + '.result.txt') };
  fs.writeFileSync(j.resultFile, answer); if (who === 'antigravity') { fs.writeFileSync(path.join(dir, 'result.txt'), answer); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ hash: launch.sha(answer) })); }
  fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(j)); return j;
}
h.run([
  ['сохранённое доказательство и provenance moonshot/requested_only', () => { const j = evidence(); assert.equal(review.evidence(j), j); assert.equal(require('../common/provenance').reviewerInfo(j, 'kimi').family, 'moonshot'); assert.equal(store.review('kimi', j.id, 'a'.repeat(40), 'b'.repeat(40), 'ПРИНЯТО', '#12345678').id, j.id); }],
  ['отрицательные поля сеанса/модели/политики/хешей/манифеста отвергаются', () => {
    const j = evidence();
    assert.throws(() => review.evidence({ ...j, model: 'gpt-6' }));
    assert.throws(() => review.evidence({ ...j, provenance: { ...j.provenance, evidence_level: 'provider_reported' } }));
    for (const patch of [{ task: 'подмена' }, { scopeTask: 'v2' }, { stageId: 'другой' }, { work: 'другая' }, { role: 'совет' }, { write: true }, { fullAccess: true }, { previous: 'x' }, { continue_id: '' }, { parentJob: 'x' }, { mcpPolicy: 'proxy' }, { outgoingCount: 1 }, { sends: true }, { profileKind: 'writer' }, { profileSha256: '0'.repeat(64) }, { cancelled: true }, { lateResultFile: 'x' }, { stopUnconfirmed: {} }, { modelConfirmed: true }, { modelArgumentConfirmed: false }, { launchModel: 'kimi-code/unknown' }, { kimiVersion: 'new' }, { inputSha256: '0'.repeat(64) }, { resultSha256: '0'.repeat(64) }, { materialManifestHash: '0'.repeat(64) }, { reviewPolicyVersion: 'old' }, { launchEligibility: {} }, { compatibility: null }, { readOnlyCheck: { ...j.readOnlyCheck, excluded: {} } }, { readOnlyCheck: { ...j.readOnlyCheck, status: 'unknown' } }]) assert.throws(() => review.evidence({ ...j, ...patch }), /Голос Kimi/, JSON.stringify(patch));
  }],
  ['пауза запрещает новый зачёт, но сохраняет чтение доказательства и отказа', () => {
    const j = evidence(undefined, 'НЕ ПРИНЯТО: 1 блокирующих'); f.active(false);
    try { review.evidence(j); store.review('kimi', j.id, 'a'.repeat(40), 'b'.repeat(40), 'НЕ ПРИНЯТО', '#12345678'); assert.throws(() => review.eligibility(), /паузе/); assert.throws(() => require('../common/consilium-workflow').validateJob(j, 'kimi'), /паузе/); }
    finally { f.active(); }
  }],
  ['смена текущего CLI/пробы не отменяет историю, новый голос запрещён', () => {
    const j = evidence(), file = path.join(f.state, 'kimi-compatibility.json'), previous = fs.readFileSync(file); fs.writeFileSync(file, JSON.stringify({ status: 'passed', version: 'new' }));
    try { review.evidence(j); assert.throws(() => review.eligibility(), /совместимости/); assert.throws(() => require('../common/consilium-workflow').validateJob(j, 'kimi'), /совместимости/); }
    finally { fs.writeFileSync(file, previous); }
  }],
  ['незаписанный допустимый отказ → пауза → ветка merge запрещает слияние', () => {
    const mark = '#aaaaaaaa', c = { requestMark: mark, base: 'a'.repeat(40), candidate: 'b'.repeat(40), verdicts: [] };
    const j = evidence(mark + ' ' + c.base + ' ' + c.candidate, 'НЕ ПРИНЯТО: 1 блокирующих'); f.active(false);
    try { assert(seats.storeRefusals(c, 'kimi', 'verdict').some(x => x.id === j.id)); assert.throws(() => mergePaused(c), /Отказ приостановленного участника kimi/); } finally { f.active(); }
  }],
  ['записанный отказ → принято той же редакции → пауза → закрытый отказ не воскресает', () => {
    const mark = '#bbbbbbbb', c = { requestMark: mark, base: 'c'.repeat(40), candidate: 'd'.repeat(40), verdicts: [] }, task = mark + ' ' + c.base + ' ' + c.candidate;
    const no = evidence(task, 'НЕ ПРИНЯТО: 1 блокирующих'), yes = evidence(task);
    c.verdicts = [no, yes].map((j, i) => ({ who: 'kimi', job_id: j.id, base: c.base, candidate: c.candidate, decision: i ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО' })); f.active(false);
    try { store.review('kimi', yes.id, c.base, c.candidate, 'ПРИНЯТО', mark); assert(seats.seat(c, 'kimi', 'verdict').closed); assert.doesNotThrow(() => mergePaused(c)); }
    finally { f.active(); }
  }],
  ['поздний/failed отказ остаётся консервативным блокером, не голосом', () => {
    const c = { requestMark: '#cccccccc', base: 'e'.repeat(40), candidate: 'f'.repeat(40), verdicts: [] };
    const j = evidence(c.requestMark + ' ' + c.base + ' ' + c.candidate, 'НЕ ПРИНЯТО: 1 блокирующих', { status: 'failed' });
    assert.throws(() => review.evidence(j)); assert(seats.storeRefusals(c, 'kimi', 'verdict').some(x => x.id === j.id));
  }],
  ['локальный workflow требует доказательство и нынешний допуск', () => { const j = evidence(); require('../common/consilium-workflow').validateJob(j, 'kimi'); assert.throws(() => require('../common/consilium-workflow').validateJob({ ...j, previous: 'old' }, 'kimi')); }],
  ['ревью с вызовом вне чтения, неполным потоком или ошибкой обхода исходящих не голосует (Kimi №4/Codex №6)', () => {
    const j = evidence(); assert.equal(review.evidence(j), j, 'базовая карточка с потоком только из Read голосует');
    const sf = path.join(f.state, 'kimi-jobs', j.id, 'stream.ndjson'), good = fs.readFileSync(sf);
    // 1) Фактический вызов инструмента вне чтения в потоке (запись/Bash/Agent/MCP-делегация) — голос отвергается, даже
    // если поля карточки (mcpPolicy/outgoingCount) «чистые». Проверяется именно поток, не доверенное поле.
    for (const tool of ['Write', 'Edit', 'Bash', 'Agent', 'mcp__codex__codex_send']) {
      fs.writeFileSync(sf, '{"role":"meta","type":"system.version","version":"2.5.3"}\n' +
        JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', function: { name: tool } }] }) + '\n' +
        '{"role":"assistant","content":"ПРИНЯТО"}\n');
      assert.throws(() => review.evidence(j), /вне чтения/, tool);
    }
    // 2) Неполный/повреждённый/пустой поток — не голос.
    fs.writeFileSync(sf, '{"role":"meta","type":"system.version","version":"2.5.3"}\n{bad\n'); assert.throws(() => review.evidence(j), /поток Kimi/);
    fs.writeFileSync(sf, ''); assert.throws(() => review.evidence(j), /нет сохранённого потока/);
    fs.writeFileSync(sf, good); assert.equal(review.evidence(j), j, 'восстановленный поток снова голосует');
    // 3) Ошибка обхода дочерних карточек (outgoingVerified!==true) НЕ трактуется как ноль исходящих — голос отвергается;
    // подмена только outgoingCount=0 при неподтверждённом обходе не спасает.
    assert.throws(() => review.evidence({ ...j, outgoingVerified: false }), /исходящих/);
    assert.throws(() => review.evidence({ ...j, outgoingVerified: undefined }), /исходящих/);
  }],
  ['историческая карточка kimi-material-v1 читается старым reader (Codex №5): отсутствие новых полей не отменяет голос', () => {
    const j = evidence(undefined, 'НЕ ПРИНЯТО: 1 блокирующих');
    // Превращаем в подлинную старую карточку: версия политики/манифест/проба — v1; новых полей независимости
    // (mcpPolicy/profileKind/profileSha256/outgoingVerified) и сохранённого потока у неё нет.
    const mm = JSON.parse(fs.readFileSync(j.materialManifestFile, 'utf8')); mm.policy = launch.POLICY_V1;
    const ser = JSON.stringify(mm); fs.writeFileSync(j.materialManifestFile, ser); j.materialManifestHash = launch.sha(ser);
    j.reviewPolicyVersion = launch.POLICY_V1; j.compatibility = { ...j.compatibility, policy: launch.POLICY_V1 };
    delete j.mcpPolicy; delete j.profileKind; delete j.profileSha256; delete j.outgoingVerified;
    try { fs.unlinkSync(path.join(f.state, 'kimi-jobs', j.id, 'stream.ndjson')); } catch {}
    // Новый reader читает её по v1 и голос сохраняет (прежний кандидат требовал бы новые поля и отбросил бы карточку).
    assert.equal(review.evidence(j), j, 'историческая v1 карточка принята историческим reader');
    // Та же карточка, объявленная v2, строгой проверкой уже не проходит (нет потока/новых полей).
    assert.throws(() => review.evidence({ ...j, reviewPolicyVersion: launch.POLICY }), /Голос Kimi/);
    // Неизвестная версия политики голосом не становится.
    assert.throws(() => review.evidence({ ...j, reviewPolicyVersion: 'kimi-material-v9' }), /неизвестная версия/);
  }],
  ['team_work: автор moonshot принимается двумя другими семьями', async () => {
    const gate = require('../common/stage-gate');
    const w = { name: 'work-kimi', folder: fs.mkdtempSync(path.join(require('os').tmpdir(), 'kimi-vote-material-')), stages: [{ title: 'Итог', weight: 100, accept_criteria: 'Проверено', state: 'план', level: 'обычный', rules_version: 16, author: { family: 'moonshot', model: launch.DEFAULT }, version: 'v1' }] };
    gate.normalize(w, null); const s = w.stages[0];
    evidence('v1', 'Текст автора', { role: 'текст', work: w.name, stage: s.id, stageId: s.id });
    // Исторические фикстуры других семей с их штатными метаданными.
    for (const who of ['codex', 'antigravity']) {
      const id = 'peer-' + who, dir = store.roots()[who], j = { id, work: w.name, stage: s.id, role: 'проверка', status: 'done', task: 'v1', startedAt: new Date().toISOString(), model: who === 'codex' ? 'gpt-6' : 'gemini-4', write: false, mode: 'review' };
      fs.mkdirSync(path.join(dir, id), { recursive: true }); j.resultFile = path.join(dir, id, id + '.result.txt'); fs.writeFileSync(j.resultFile, 'ПРИНЯТО');
      if (who === 'antigravity') { fs.writeFileSync(path.join(dir, id, 'result.txt'), 'ПРИНЯТО'); fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify({ hash: launch.sha('ПРИНЯТО') })); }
      fs.writeFileSync(path.join(dir, id, 'card.json'), JSON.stringify(j));
    }
    s.state = 'принят'; s.reviews = ['peer-codex', 'peer-antigravity']; await gate.evaluate(w, s); assert.equal(s.state, 'принят'); assert.equal(s.gate.quorum[0].needed, 2); assert(!s.gate.quorum[0].families.includes('moonshot'));
  }],
  ['team_work: четыре внешние семьи, смешанное авторство, |E|=0/1', async () => {
    process.env.MOST_DSH_VERSION = '1.0.0'; require('../common/dsh-probe').record({ version: '1.0.0', writeDenied: true });
    f.store.update(f.store.read().rev, n => { Object.assign(n.members.find(m => m.id === 'deepseek').roles, { receives: true, sends: true, voter: true }); }, { action: 'test', who: 'claude', reason: 'четыре семьи' }, { phase: 'B' });
    const gate = require('../common/stage-gate');
    for (const [authors, reviews, wanted, error] of [
      [['anthropic'], ['openai', 'google'], 2, null],
      [['moonshot', 'openai'], ['google', 'deepseek'], 2, null],
      [['moonshot', 'openai', 'google'], ['deepseek'], 1, null],
      [['anthropic', 'moonshot', 'openai', 'google'], ['deepseek'], 2, /нет двух/],
      [['moonshot', 'openai', 'google', 'deepseek'], ['openai'], 0, /нет активной внешней/],
    ]) {
      const w = { name: 'quorum-' + ++seq, folder: fs.mkdtempSync(path.join(require('os').tmpdir(), 'kimi-quorum-material-')), stages: [{ title: 'Кворум', weight: 100, accept_criteria: 'Проверено', state: 'план', level: 'обычный', rules_version: 16, author: { authors: authors.map(family => ({ family, model: models[family] })) }, version: 'v1' }] };
      gate.normalize(w, null); const s = w.stages[0], fields = { task: 'v1', work: w.name, stage: s.id, stageId: s.id };
      for (const family of authors.filter(x => x !== 'anthropic')) peer(family, { ...fields, role: 'текст' }, 'Авторский материал');
      s.reviews = reviews.map(family => peer(family, fields).id); s.state = 'принят';
      if (error) await assert.rejects(() => gate.evaluate(w, s), error); else { await gate.evaluate(w, s); assert.equal(s.state, 'принят'); }
      assert.equal(s.gate.quorum[0].needed, wanted); if (authors.length === 1) assert.equal(s.gate.quorum[0].families.length, 4);
    }
  }],
  ['локальный workflow требует все четыре внешние семьи, а не два голоса', async () => {
    const snapshot = '9'.repeat(64), w = { work_id: 'wf-kimi' }, s = { id: 's', kind: 'result', level: 'обычный', author: { family: 'anthropic', model: models.anthropic }, reviews: [] };
    const task = 'workflow_work:wf-kimi\nworkflow_stage:s\nsnapshot_sha256:' + snapshot, answer = 'snapshot_sha256:' + snapshot + '\nПРИНЯТО';
    const jobs = Object.entries(peers).map(([family, who]) => ({ who, j: peer(family, { task, work: w.work_id, stage: s.id }, answer) }));
    let selected = jobs.slice(0, 2);
    const adapter = { list: async who => selected.filter(x => x.who === who).map(x => x.j), read: async (who, j) => ({ raw: answer, text: answer, provenance: require('../common/provenance').reviewerInfo(j, who) }) };
    const check = () => require('../common/consilium-workflow-v2').check({ ctx: {}, w, s, snapshot, adapter, usedJobs: new Set(), files: [] });
    await assert.rejects(check, /всех внешних семей/); selected = jobs; assert.equal((await check()).votes.length, 4);
  }],
]);
