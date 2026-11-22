'use strict';
const fs = require('fs'), path = require('path');
const launch = require('./kimi-launch'), material = require('./kimi-material');
const need = (ok, why) => { if (!ok) throw Error('Голос Kimi: ' + why); };
const needExec = (ok, why) => { if (!ok) throw Error('Исполнение Kimi: ' + why); };
// team-v56 А1: допуск именно к ГОЛОСУ. Глобальный запрет writer/sends снят — способность писать/отправлять больше не
// исключает место из кворума; требования к голосу (voter/receives/adapter/family/CLI/совместимость) сохранены. Отказ этой
// проверки оставляет voteEligible=false, но сам по себе не запрещает разрешённое исполнение не-голосующего (см. executionEligibility).
function eligibility(who = 'kimi', { requireProbe = true } = {}) {
  const members = require('./members'); members.assertAvailable(who);
  const m = members.get(who);
  need(m?.adapter === 'kimi-cli' && m.family === 'moonshot' && m.external && m.roles.voter && m.roles.receives, 'нет активного голосующего места');
  const cli = launch.identity(), probe = launch.compatibility(cli.path);
  if (requireProbe) need(probe, 'нет проверки совместимости текущего CLI; это проверка доставки и обнаружения, не запрет записи');
  return { launchRegistryRev: members.rev(), launchEligibility: { id: m.id, family: m.family, adapter: m.adapter, external: m.external, state: m.state, paused: false, roles: { ...m.roles } }, cli, compatibility: probe };
}
// team-v56 А1: допуск к ОБЫЧНОМУ ИСПОЛНЕНИЮ, отдельно от голоса. voter не является условием исполнения. Проверяет
// активность/паузу, receives, адаптер/family, CLI и совместимость; при write=true требует роль писателя; sends — только
// при включённом А3 (в А1 всегда выключено). Отказ запрещает запуск; снимок хранится отдельно от допуска голоса.
function executionEligibility(job = {}, who = 'kimi', { requireProbe = false } = {}) {
  const members = require('./members'); members.assertAvailable(who);
  const m = members.get(who);
  needExec(m?.adapter === 'kimi-cli' && m.family === 'moonshot' && m.external && m.roles.receives, 'нет активного места исполнителя Kimi');
  needExec(!members.recipientPaused(who, job.fallbackWord), 'исполнитель Kimi на паузе');
  if (job.write === true || job.fullAccess === true) needExec(m.roles.writer, 'запись/полный доступ запрошены, но роль писателя не включена');
  if (job.sends === true) needExec(m.roles.sends, 'исходящие (А3) не включены для этого участника');
  const cli = launch.identity(), probe = launch.compatibility(cli.path);
  if (requireProbe) needExec(probe, 'нет проверки совместимости текущего CLI');
  return { launchRegistryRev: members.rev(), launchExecutionEligibility: { id: m.id, family: m.family, adapter: m.adapter, external: m.external, state: m.state, paused: false, write: !!job.write, fullAccess: !!job.fullAccess, sends: !!job.sends, roles: { ...m.roles } }, cli, compatibility: probe };
}
// Общий «хвост» доказательства материала (вход/копии/манифесты), одинаковый для исторической и новой версий. policy —
// версия, под которой писалась карточка: именно с ней сверяются манифест и привязка пробы.
function materialEvidence(j, policy) {
  const bundle = path.join(require('./paths').stateDir, 'kimi-jobs', j.id);
  function checked(file, hash, within) {
    need(typeof file === 'string' && /^[a-f0-9]{64}$/.test(hash || ''), 'нет файла/хеша');
    need(material.inside(fs.realpathSync(within), fs.realpathSync(file)), 'доказательство вне своей папки');
    const data = fs.readFileSync(file); need(launch.sha(data) === hash, 'хеш доказательства изменился'); return data;
  }
  checked(j.resultFile, j.resultSha256, bundle);
  const before = JSON.parse(checked(j.materialManifestFile, j.materialManifestHash, bundle));
  const after = JSON.parse(checked(j.readOnlyCheck.manifestFile, j.readOnlyCheck.manifestHash, bundle));
  checked(j.inputFile, j.inputSha256, j.executionFolder);
  need(before.taskSha256 === launch.sha(j.task || '') && before.textSha256 === launch.sha(j.textFile ? fs.readFileSync(j.textFile) : ''), 'поручение/материал карточки расходятся с проверенным входом');
  need(JSON.stringify(before.binding) === JSON.stringify(material.binding(j)), 'редакция/работа/этап не совпадают с проверенным поручением');
  need(JSON.stringify(j.readOnlyCheck.excluded.paths) === JSON.stringify(before.before.flatMap(s => [...s.snapshot.excluded, ...(s.git?.excluded || [])])), 'утрачены фактические исключения');
  need(before.policy === policy && before.inputSha256 === j.inputSha256 && before.executionFolder === j.executionFolder && JSON.stringify(before.coveredRoots) === JSON.stringify(j.readOnlyCheck.coveredRoots) && before.before?.length === before.coveredRoots.length && after.after?.length === before.before.length && after.differences?.length === 0 && after.errors?.length === 0, 'манифест не доказывает полную сверку');
  for (let i = 0; i < before.before.length; i++) need(material.diff(before.before[i].snapshot, after.after[i].snapshot).length === 0 && JSON.stringify(before.before[i].snapshot.identity) === JSON.stringify(after.after[i].snapshot.identity) && JSON.stringify(before.before[i].git) === JSON.stringify(after.after[i].git), 'снимки оригинала расходятся');
  need(after.executionAfter && material.diff(before.executionBefore, after.executionAfter).length === 0, 'снимки копии расходятся');
  // Привязку request/design/base/candidate либо work/stage/version дополнительно проверяют сами ворота.
  need(typeof j.task === 'string' && j.task.trim(), 'утрачено полное поручение');
  return bundle;
}
// Общие для обеих версий проверки карточки (сеанс/модель/происхождение/проба/сверка исключений) под нужной версией политики.
function commonEvidence(j, policy) {
  need(j.status === 'done' && j.role === 'проверка' && j.write === false && j.fullAccess === false && j.previous === null && !Object.hasOwn(j, 'continue_id') && !j.parentJob, 'нужен новый независимый сеанс проверки без записи');
  need(!j.cancelled && !j.cancel_requested && !j.cancellation && !j.lateHash && !j.lateResultFile && !j.stopUnconfirmed && !j.treeWarning && !j.stopReason && j.exitCode === 0 && j.stopConfirmed, 'остановка/отмена/поздний ответ');
  const e = j.launchEligibility, p = j.compatibility;
  need(launch.MODELS.includes(j.launchModel) && j.model === j.launchModel && j.requestedModel === j.launchModel && j.modelArgumentConfirmed === true && j.modelConfirmed === false && j.reportedModel === null, 'модель запуска не подтверждена argv или расходится');
  need(j.provenance?.evidence_level === 'requested_only' && j.provenance.requested_text_model === j.launchModel && j.provenance.provider_reported_text_model === 'unknown', 'происхождение модели расходится с requested_only');
  need(p?.status === 'passed' && p.policy === policy && p.sha256 === j.cli?.sha256 && p.path === j.cli?.path && p.version === j.kimiVersion && p.delivery === true && p.parsing === true && p.detection === true, 'нет привязки пробы к CLI');
  need(j.reviewPolicyVersion === policy && j.executionIsolation === 'none' && j.readOnlyCheck?.status === 'passed' && Array.isArray(j.readOnlyCheck.coveredRoots) && j.readOnlyCheck.coveredRoots.length && JSON.stringify(j.readOnlyCheck.excluded?.rules) === JSON.stringify(material.RULES) && Array.isArray(j.readOnlyCheck.excluded.paths), 'неполная сверка или неверная политика исключений');
  return { e, p };
}
// Историческое доказательство kimi-material-v1 (карточки базы): тогда роли места были ограничены (writer/sends запрещены
// глобально), новых полей mcpPolicy/profileKind/потока у карточки нет. Читается как есть — чтобы старые голоса/отказы не
// обнулялись сменой роли (ревью Codex №5). Новые карточки эту ветку не используют (они пишутся под v2).
function evidenceV1(j) {
  const { e } = commonEvidence(j, launch.POLICY_V1);
  need(Number.isSafeInteger(j.launchRegistryRev) && e?.adapter === 'kimi-cli' && e.family === 'moonshot' && e.external && e.state === 'active' && e.paused === false && e.roles?.voter && e.roles.receives && !e.roles.writer && !e.roles.sends, 'нет сохранённого допуска запуска');
  materialEvidence(j, launch.POLICY_V1);
  return j;
}
// team-v56 А1: новое доказательство v56 (kimi-material-v2). Ограничения проверяются на КОНКРЕТНОМ поручении (новый
// независимый сеанс без записи/исходящих), а не глобальным запретом возможностей места; профиль проверки нужного хеша; и —
// главное (ревью Kimi №4/Codex №6) — ФАКТИЧЕСКИЕ вызовы инструментов из сохранённого потока, не доверенное поле карточки.
function evidenceV2(j) {
  need(j.mcpPolicy === 'none' && (j.outgoingCount === 0 || j.outgoingCount === undefined) && !j.sends, 'ревью не должно иметь MCP/исходящих делегаций');
  need(j.profileKind === 'review' && j.profileSha256 === launch.profile({ role: 'проверка', write: false, fullAccess: false }).sha256, 'профиль запуска — не профиль проверки нужного хеша');
  const { e } = commonEvidence(j, launch.POLICY);
  need(Number.isSafeInteger(j.launchRegistryRev) && e?.adapter === 'kimi-cli' && e.family === 'moonshot' && e.external && e.state === 'active' && e.paused === false && e.roles?.voter && e.roles.receives, 'нет сохранённого допуска запуска');
  const bundle = materialEvidence(j, launch.POLICY);
  // Независимость — по ФАКТИЧЕСКОМУ потоку stream.ndjson: допустимы только read-инструменты; финальный ответ —
  // assistant.content; события полны (версия, без повреждённых строк). Пустой/нечитаемый/неполный поток или вызов
  // Write/Edit/Bash/Agent/mcp__… — голос не принимается. Делегации учитываются отдельно: ошибка обхода (outgoingVerified
  // !== true) НЕ трактуется как ноль, иначе сбой доказательства выглядел бы как отсутствие исходящих.
  let streamData; try { streamData = fs.readFileSync(path.join(bundle, 'stream.ndjson')); } catch { streamData = null; }
  need(streamData && streamData.length, 'нет сохранённого потока stream.ndjson для проверки вызовов инструментов');
  const an = launch.analyze(streamData, { code: 0 });
  need(an.ok && typeof an.text === 'string' && an.text.trim() && !an.bad, 'поток Kimi неполон, повреждён или без финального ответа ассистента');
  const foreign = [...new Set(an.toolCalls.filter(n => !launch.READ_TOOLS.includes(n)))];
  need(foreign.length === 0, 'ревью использовало инструмент вне чтения (запись/Bash/Agent/MCP/делегация): ' + foreign.join(', '));
  // team-v56 Н3 (ревью Kimi 7/Gemini-А): финальный текст сохранённого потока обязан совпасть с результатом карточки
  // (resultSha256). Подмена финального текста потока при неизменном файле результата (и наоборот — через materialEvidence) отвергается.
  need(launch.sha(an.text) === j.resultSha256, 'финальный текст потока расходится с результатом карточки');
  need(j.outgoingVerified === true && j.outgoingCount === 0, 'не подтверждён нулевой учёт исходящих делегаций (ошибка обхода не равна нулю)');
  return j;
}
function evidence(j) {
  // team-v56 А1 (ревью Codex №5): версия доказательства определяется самой карточкой. Новая v56 — строгая v2 с проверкой
  // фактического потока; историческая v1 — прежний reader; неизвестная версия голосом не становится.
  if (j.reviewPolicyVersion === launch.POLICY) return evidenceV2(j);
  if (j.reviewPolicyVersion === launch.POLICY_V1) return evidenceV1(j);
  need(false, 'неизвестная версия политики доказательства Kimi: ' + j.reviewPolicyVersion);
}
module.exports = { eligibility, executionEligibility, evidence };
