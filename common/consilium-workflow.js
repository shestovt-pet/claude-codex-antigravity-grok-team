'use strict';
// Local workflow evidence checker. This is not an authority or an authentication service.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const LIMITS = Object.freeze({ json: 8 * 1024 ** 2, text: 16 * 1024 ** 2,
  count: 4096, file: 512 * 1024 ** 2, total: 32 * 1024 ** 3, chunk: 1024 ** 2 });
const QUORUM = ['codex', 'grok', 'antigravity'];
const HEX = /^[a-f0-9]{64}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = x => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; }
function fail(message, code = 2) { throw Object.assign(Error(message), { workflowCode: code }); }
function need(condition, message, code) { if (!condition) fail(message, code); }
function unique(xs) { return new Set(xs).size === xs.length; }
function exactQuorum(xs) { return Array.isArray(xs) && xs.length === 3 && unique(xs) && QUORUM.every(x => xs.includes(x)); }
function marker(text, key) {
  const rows = String(text).split(/\r?\n/).filter(x => x.startsWith(key + ':'));
  return rows.length === 1 ? rows[0].slice(key.length + 1).trim() : null;
}
function verdict(text) {
  const last = String(text).trimEnd().split(/\r?\n/).at(-1).trim();
  if (last === 'ПРИНЯТО') return true;
  if (/^НЕ ПРИНЯТО: [1-9]\d* блокирующих$/.test(last)) return false;
  fail('Последняя непустая строка не является точным вердиктом.');
}
function matches(text, work, stage, snapshot) {
  return marker(text, 'workflow_work') === work && marker(text, 'workflow_stage') === stage &&
    marker(text, 'snapshot_sha256') === snapshot;
}
function within(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function context(root) { return { root: fs.realpathSync(root), refs: 0, bytes: 0, files: new Map() }; }
async function readFile(ctx, ref, limit = LIMITS.file, text = false) {
  need(ref && typeof ref.path === 'string' && ref.path && !path.isAbsolute(ref.path), 'Нужен относительный путь файла.', 3);
  need(++ctx.refs <= LIMITS.count, 'Превышен лимит числа ссылок на файлы.');
  const logical = path.resolve(ctx.root, ref.path), real = fs.realpathSync(logical);
  need(within(ctx.root, logical) && within(ctx.root, real), 'Файл выходит за корень работы: ' + ref.path);
  const before = fs.statSync(real);
  need(before.isFile(), 'Нужен обычный файл: ' + ref.path, 3);
  need(before.size <= limit, 'Превышен лимит размера файла: ' + ref.path);
  if (!ctx.files.has(real)) {
    ctx.bytes += before.size;
    need(ctx.bytes <= LIMITS.total, 'Превышен суммарный лимит материалов.');
    ctx.files.set(real, before.size);
  }
  const hash = crypto.createHash('sha256'), chunks = []; let bytes = 0;
  for await (const chunk of fs.createReadStream(real, { highWaterMark: LIMITS.chunk })) {
    bytes += chunk.length;
    need(bytes <= limit, 'Файл вырос сверх лимита: ' + ref.path);
    hash.update(chunk); if (text) chunks.push(chunk);
  }
  const after = fs.statSync(real);
  need(fs.realpathSync(logical) === real && before.size === bytes && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino,
  'Файл изменился во время проверки: ' + ref.path);
  const digest = hash.digest('hex');
  if (ref.sha256 !== undefined) need(HEX.test(ref.sha256) && ref.sha256 === digest, 'Хеш файла изменился: ' + ref.path);
  let value;
  if (text) { const buffer = Buffer.concat(chunks); value = buffer.toString('utf8');
    need(Buffer.from(value, 'utf8').equals(buffer), 'Файл не UTF-8: ' + ref.path, 3); }
  return { path: ref.path.replaceAll('\\', '/'), sha256: digest, real, size: bytes, text: value };
}
function taskText(j) { return j.scopeTask || ((j.task || j.poruchenie || '') + '\n' + (j.text || '')); }
function time(j) { const n = Date.parse(j.finishedAt); need(Number.isFinite(n), 'Неизвестно время готовности: ' + j.id); return n; }
function observedTime(j) {
  // Completion orders votes. Pending/cancelled/late jobs also stay in the observed sequence.
  // These are the real card fields in the bridges; a job without an order is never silently dropped.
  const values = [j.startedAt, j.createdAt, j.created_at, j.finishedAt,
    j.cancel_requested?.at, j.late_result?.receivedAt].filter(x => x !== undefined && x !== null);
  if (j.status === 'done') time(j);
  const times = values.map(x => Date.parse(x));
  need(times.length && times.every(Number.isFinite), 'Неизвестен порядок поручения: ' + j.id);
  return Math.max(...times);
}
function latest(rows) {
  need(rows.length, 'Нет наблюдаемого ревью.');
  const ordered = rows.map(j => ({ j, at: observedTime(j) }));
  return ordered.sort((a, b) => {
    const delta = a.at - b.at; if (delta) return delta;
    need(a.j.id === b.j.id || (Number.isSafeInteger(a.j.gateOrder) && Number.isSafeInteger(b.j.gateOrder) &&
      a.j.gateOrder !== b.j.gateOrder), 'Неизвестен порядок одновременных ревью.');
    return (a.j.gateOrder || 0) - (b.j.gateOrder || 0);
  }).at(-1).j;
}
// The existing store verifies AGY metadata / Grok delivery hash. No keys are read here.
function bridgeAdapter() {
  const store = require('./team-store');
  return {
    list(who) { const r = store.list(who, false); need(!r.errors.length, 'Не удалось прочитать журнал: ' + r.errors.join('; '), 3); return r.jobs; },
    read(who, j) {
      const roots = store.roots(), file = who === 'antigravity' ? path.join(path.dirname(j.cardFile), 'result.txt')
        : who === 'grok' ? path.join(roots[who], j.id + '.result.txt') : store.resultPath(j, roots[who]);
      need(fs.statSync(file).size <= LIMITS.text, 'Ответ моста превышает лимит текста.');
      const raw = store.source(who, j.id);
      const payload = who === 'grok' ? require('./grok').parseReply(Buffer.from(raw))?.payload.toString('utf8') : raw;
      need(typeof payload === 'string', 'Не разобран служебный конверт Grok.');
      return { raw, text: payload, provenance: require('./provenance').reviewerInfo(j, who) };
    }
  };
}
function validateJob(j, who) {
  need(j.status === 'done' && !j.cancelled && !j.cancel_requested && !j.lateHash && !j.archived, 'Нет действующего завершённого голоса: ' + j.id);
  need(j.role === 'проверка', 'У поручения нет роли проверка: ' + j.id);
  if (who === 'codex') need(!j.write && !j.previous && !j.continue_id, 'Codex-ревью должно быть новым и без записи.');
  time(j);
}
async function bridgeVote(adapter, who, ref, work, stage, snapshot) {
  const rows = await adapter.list(who);
  const observed = rows.filter(j => matches(taskText(j), work, stage, snapshot));
  // A cancelled/late newest result is never a vote; keep it visible rather than resurrecting an old approval.
  const j = latest(observed); validateJob(j, who);
  need(j.id === ref.job_id, 'Указан не последний ответ ' + who + ': требуется ' + j.id);
  const task = taskText(j); need(Buffer.byteLength(task) <= LIMITS.text, 'Поручение превышает лимит текста.');
  const result = await adapter.read(who, j);
  need(sha(task) === ref.task_sha256 && sha(result.raw) === ref.response_sha256, 'Хеш поручения/ответа не совпадает: ' + j.id);
  need(!result.provenance.mismatch && result.provenance.family, 'Не подтверждён маршрут/семья: ' + j.id);
  need(marker(result.text, 'snapshot_sha256') === snapshot, 'В самом ответе нет единственного текущего snapshot_sha256: ' + j.id);
  return { participant: who, job_id: j.id, accepted: verdict(result.text), provenance: result.provenance,
    task_sha256: sha(task), response_sha256: sha(result.raw), finishedAt: j.finishedAt };
}
// Import is an explicit local evidence convention, never authenticated bridge participation.
async function importPolicy(ctx, policyRef) {
  need(policyRef, 'Импорт нативного Codex по умолчанию запрещён: нет согласованной политики.');
  need(HEX.test(policyRef.sha256 || ''), 'Нужен закреплённый хеш политики импорта.');
  const file = await readFile(ctx, policyRef, LIMITS.json, true), p = JSON.parse(file.text);
  need(p.schema_version === 1 && p.mode === 'recorded_response_not_independently_authenticated' &&
    p.scope === 'native_codex_only' && p.enabled === true, 'Политика импорта не включена или неизвестна.');
  need(typeof p.trust_boundary === 'string' && p.trust_boundary.length >= 40, 'Не описана граница доверия импорта.');
  need(exactQuorum(p.agreement?.map(x => x.participant)), 'Политика не содержит соглашения всех троих.');
  need(typeof p.policy_id === 'string' && p.policy_id, 'Нет policy_id.');
  const policyHash = sha(canonical({ schema_version: p.schema_version, policy_id: p.policy_id, mode: p.mode,
    scope: p.scope, enabled: p.enabled, trust_boundary: p.trust_boundary }));
  for (const a of p.agreement) {
    need(a.job_id && a.source_record && HEX.test(a.response?.sha256 || ''), 'Не зафиксирован источник согласования политики.');
    const r = await readFile(ctx, a.response, LIMITS.text, true);
    let text = r.text;
    if (a.participant === 'grok' && text.trimEnd().endsWith('КОНЕЦ ОТВЕТА')) {
      const parsed = require('./grok').parseReply(Buffer.from(text));
      need(parsed, 'Повреждён служебный конверт соглашения Grok.'); text = parsed.payload.toString('utf8');
    }
    need(marker(text, 'import_policy_id') === p.policy_id && marker(text, 'import_policy_sha256') === policyHash &&
      verdict(text), 'Нет явного принятия точной редакции политики.');
  }
  return { sha256: file.sha256, mode: p.mode,
    warning: 'Соглашение об импорте и нативный ответ зарегистрированы локально; авторство и полнота журнала не аутентифицированы.' };
}
async function importedVote(ctx, ref, work, stage, snapshot, policy) {
  need(policy && ref.participant === 'codex', 'Этот импорт допускается только для Codex и согласованной политики.');
  need(ref.agent_id && ref.thread_id && ref.source_record && ref.finishedAt && ref.job_id,
    'Нужны реальные agent/thread/job IDs, источник записи и время импортированного ответа.');
  need(HEX.test(ref.task?.sha256 || '') && HEX.test(ref.response?.sha256 || ''), 'Хеши импортированных поручения/ответа обязательны.');
  time(ref);
  const task = await readFile(ctx, ref.task, LIMITS.text, true), response = await readFile(ctx, ref.response, LIMITS.text, true);
  need(matches(task.text, work, stage, snapshot), 'Импортированное поручение относится к другому снимку.');
  need(marker(response.text, 'snapshot_sha256') === snapshot, 'В самом импортированном ответе нет текущего snapshot_sha256.');
  return { participant: 'codex', job_id: ref.job_id, accepted: verdict(response.text), provenance: {
    family: 'openai', family_evidence: 'configured_route', evidence_level: policy.mode,
    agent_instance: ref.agent_id, thread_id: ref.thread_id }, warning: policy.warning };
}
function schema(w) {
  need([1, 2].includes(w.schema_version) && typeof w.work_id === 'string' && w.work_id && exactQuorum(w.quorum), 'Неверная схема/кворум работы.', 3);
  need(w.request && HEX.test(w.request.sha256 || ''), 'Запрос должен иметь закреплённый SHA-256.', 3);
  need(Array.isArray(w.requirements) && w.requirements.length && unique(w.requirements.map(x => x.id)), 'Нет уникального реестра требований.', 3);
  need(Array.isArray(w.stages) && w.stages.length >= 3 && unique(w.stages.map(s => s.id)), 'Нет уникальных этапов.', 3);
  need(w.stages[0].kind === 'discussion' && w.stages[1].kind === 'plan' && w.stages.at(-1).kind === 'final', 'Нужен порядок discussion → plan → execution → final.', 3);
  need(w.stages.slice(2, -1).length && w.stages.slice(2, -1).every(s => s.kind === 'execution'), 'Нужен хотя бы один последовательный этап execution.', 3);
  for (const [i, s] of w.stages.entries()) {
    if (w.schema_version === 2) require('./consilium-workflow-v2').author(s);
    need(typeof s.id === 'string' && s.id && Array.isArray(s.material) && s.material.length &&
      Array.isArray(s.criteria) && s.criteria.length && s.criteria.every(x => typeof x === 'string' && x.trim()), 'Нет материала/критериев этапа: ' + s.id, 3);
    need(Array.isArray(s.addresses) && s.addresses.length && unique(s.addresses) && s.addresses.every(id => w.requirements.some(r => r.id === id)), 'Неверные требования этапа: ' + s.id, 3);
    need(Array.isArray(s.depends_on) && canonical(s.depends_on) === canonical(i ? [w.stages[i - 1].id] : []), 'Этапы должны образовывать последовательную цепь.', 3);
    need(Array.isArray(s.reviews), 'Нет массива reviews.', 3);
  }
}
async function run(file, options = {}) {
  const ctx = context(path.dirname(path.resolve(file)));
  const doc = await readFile(ctx, { path: path.basename(file) }, LIMITS.json, true), w = JSON.parse(doc.text); schema(w);
  const request = await readFile(ctx, w.request, LIMITS.text, true);
  need(request.text.trim(), 'Исходный запрос пуст.');
  for (const r of w.requirements) need(typeof r.id === 'string' && r.id && typeof r.quote === 'string' && r.quote.trim() &&
    request.text.includes(r.quote) && typeof r.evidence_needed === 'string' && r.evidence_needed.trim(), 'Требование не связано с дословным запросом: ' + r.id);
  const intent = options.intent || 'accept', targetIndex = intent === 'deliver' ? w.stages.length - 1 : w.stages.findIndex(s => s.id === options.stage);
  need(targetIndex >= 0 && ['snapshot', 'start', 'accept', 'deliver'].includes(intent), 'Неизвестный этап/intent.', 3);
  const adapter = options.adapter || bridgeAdapter(), snapshots = [], receipts = [], usedJobs = new Set(); let policy;
  for (let i = 0; i <= targetIndex; i++) {
    const s = w.stages[i], files = [];
    if (i === targetIndex && intent === 'start') {
      need((s.accepted_plan_sha256 ?? null) === (i >= 2 ? snapshots[1] : null), 'Устарел accepted_plan_sha256: ' + s.id);
      return { ready: true, action: 'start', stage: s.id, accepted_predecessors: receipts,
        warning: 'Разрешён только старт данного этапа; выходные материалы ещё не приняты.' };
    }
    for (const ref of s.material) files.push(await readFile(ctx, ref));
    need(unique(files.map(x => x.real)), 'Материал этапа содержит повтор одного resolved-файла.');
    const planHash = i >= 2 ? snapshots[1] : null;
    need((s.accepted_plan_sha256 ?? null) === planHash, 'Устарел accepted_plan_sha256: ' + s.id);
    const payload = { schema_version: w.schema_version, work_id: w.work_id, request_sha256: request.sha256,
      requirements: w.requirements, stage_id: s.id, kind: s.kind, criteria: s.criteria, addresses: s.addresses,
      accepted_plan_sha256: planHash, predecessors: i ? [{ id: w.stages[i - 1].id, sha256: snapshots[i - 1] }] : [],
      material: files.map(({ path: p, sha256 }) => ({ path: p, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
      coverage: s.kind === 'final' ? s.coverage : null, import_policy: w.import_policy || null };
    if (w.schema_version === 2) { payload.author = s.author; payload.level = s.level || 'обычный'; }
    // Plan commits to the entire declared sequence, not just the prose file called "plan".
    if (s.kind === 'plan') payload.sequence = w.stages.map(({ id, kind, depends_on, addresses, criteria }) => ({ id, kind, depends_on, addresses, criteria }));
    const snapshot = sha(canonical(payload)); snapshots.push(snapshot);
    const mustAccept = intent !== 'snapshot' && (i < targetIndex || ['accept', 'deliver'].includes(intent));
    if (i === targetIndex && intent === 'snapshot') return { ready: false, action: 'snapshot', stage: s.id,
      snapshot_sha256: snapshot, packet: payload, request: request.text, warning: 'Снимок не является приёмкой.' };
    if (mustAccept) {
      need(s.snapshot_sha256 === snapshot, 'Нет текущего закреплённого снимка: ' + s.id);
      if (w.schema_version === 2) {
        receipts.push(await require('./consilium-workflow-v2').check({ ctx, w, s, snapshot, adapter, usedJobs, files }));
      } else {
      need(exactQuorum(s.reviews.map(r => r.participant)), 'Нужно ровно три разных голоса: ' + s.id);
      const votes = [];
      for (const ref of s.reviews) {
        need(ref.job_id && !usedJobs.has(ref.job_id), 'Повтор/отсутствие job_id.'); usedJobs.add(ref.job_id);
        let vote;
        if (ref.source === 'bridge') vote = await bridgeVote(adapter, ref.participant, ref, w.work_id, s.id, snapshot);
        else if (ref.source === 'native_codex_import') {
          policy ||= await importPolicy(ctx, w.import_policy);
          vote = await importedVote(ctx, ref, w.work_id, s.id, snapshot, policy);
        } else fail('Неизвестный источник голоса: ' + ref.source);
        votes.push(vote);
      }
      need(unique(votes.map(v => v.provenance.family)), 'Одной семьёй заполнены несколько мест.');
      // Discussion records positions; approval becomes mandatory on the plan and every subsequent stage.
      if (s.kind !== 'discussion') need(votes.every(v => v.accepted), 'Есть НЕ ПРИНЯТО: ' + s.id);
      receipts.push({ stage: s.id, snapshot_sha256: snapshot, votes });
      }
    }
    if (s.kind === 'final') {
      need(Array.isArray(s.coverage) && s.coverage.length === w.requirements.length && unique(s.coverage.map(r => r.requirement_id)) &&
        w.requirements.every(r => s.coverage.some(c => c.requirement_id === r.id)), 'Итог не покрывает все исходные требования.');
      for (const c of s.coverage) need(c.result === 'met' && Array.isArray(c.evidence_refs) && c.evidence_refs.length &&
        c.evidence_refs.every(p => files.some(f => f.path === p)) && typeof c.limitations === 'string', 'Нет выполненного требования с фактическим доказательством: ' + c.requirement_id);
    }
  }
  return { ready: true, action: intent, work_id: w.work_id, stage: w.stages[targetIndex].id,
    snapshot_sha256: snapshots.at(-1), accepted: receipts,
    limitations: ['Смысловая полнота проверяется консилиумом, не SHA.', 'Проверка не блокирует прямые вызовы инструментов и не создаёт полномочий.'] };
}
module.exports = { LIMITS, QUORUM, sha, canonical, marker, verdict, matches, context, readFile, latest,
  taskText, bridgeAdapter, bridgeVote, importedVote, importPolicy, schema, run, validateJob };
