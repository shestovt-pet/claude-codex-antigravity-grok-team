'use strict';
// team-v58-any-chat (часть Б): чат ЛЮБОГО участника связки = полный набор дирижёра; поручение (MOST_JOB_ID/job/claude-print)
// — отказ по каждому праву чата; слово из любого чата пишется с источником chat-<клиент>; запасной режим чат не ограничивает;
// профиль ПОРУЧЕНИЙ Kimi (RECIPIENTS) — все участники, без инструментов дирижёра. «Опасный случай 1» (поручение выдаёт себя
// за чат подменой MOST_CLIENT) закрыт проверкой jobSession. Случаи 3 (owner пары чатов) и 6 (посторонние настройки клиентов)
// покрыты team-v22-full-access/team-v25 (владение работой) и trio-v2 E3 / team-v30 (client-configs: посторонние байты, откат).
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { run, root: REPO, project: PROJECT } = require('./team-v16-fixture');
const access = require('../common/access');
const words = require('../common/user-word');
const kimiMcp = require('../common/kimi-mcp');
const members = require('../common/members');

function withEnv(env, fn) {
  const save = {};
  for (const k of Object.keys(env)) { save[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(save)) { if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; } }
}

// Полный набор дирижёра на сервере team (все девять инструментов).
const TEAM_FULL = ['team_status', 'team_rules', 'team_members', 'team_change', 'team_word', 'team_work', 'team_inbox', 'team_ask', 'team_ask_result', 'team_scenario'];
// Участники-чаты по полному реестру (включая участника на паузе).
const CHAT_CLIENTS = members.all().filter(m => m.state !== 'removed').map(m => m.id);

run([
  ['Чат каждого участника связки получает полный набор дирижёра', () => {
    assert(CHAT_CLIENTS.length >= 3, 'в реестре фикстуры есть участники');
    for (const c of CHAT_CLIENTS) withEnv({ MOST_CLIENT: c, MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () => {
      assert.equal(access.jobSession(), false, c + ': не поручение');
      // team-сервер: все девять инструментов (claude — non-guest дирижёр, остальные — chatSession-гости; набор один).
      assert.deepEqual(access.guestTools('team', c).sort(), [...TEAM_FULL].sort(), 'team-набор для ' + c);
      for (const t of TEAM_FULL) assert.equal(access.allowed('team', t), true, c + ' → ' + t);
      // серверы участников: status/send/result/cancel (+antigravity_apply).
      for (const s of ['codex', 'antigravity', 'deepseek', 'claude']) {
        const set = access.guestTools(s, c);
        for (const suf of ['_status', '_send', '_result', '_cancel']) assert(set.includes(s + suf), c + ' → ' + s + suf);
        if (s === 'antigravity') assert(set.includes('antigravity_apply'), c + ' → antigravity_apply');
      }
    });
  }],
  ['Пауза участника не сужает его чат (полный набор дирижёра)', () => {
    const paused = members.all().find(m => m.state === 'paused');
    if (!paused) return; // в этой фикстуре никто не на паузе — участник на паузе проверяется в kimi-deploy
    withEnv({ MOST_CLIENT: paused.id, MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () =>
      assert.deepEqual(access.guestTools('team', paused.id).sort(), [...TEAM_FULL].sort(), paused.id + ' на паузе'));
  }],
  ['Опасный случай 1: из поручения (MOST_JOB_ID / job / claude-print) каждое право чата — отказ, даже при подмене MOST_CLIENT', () => {
    for (const env of [{ MOST_CLIENT: 'codex', MOST_JOB_ID: 'job-1' }, { MOST_CLIENT: 'job', MOST_JOB_ID: undefined }, { MOST_CLIENT: 'claude-print', MOST_JOB_ID: undefined }])
      withEnv({ ...env, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () => {
        const tag = JSON.stringify(env);
        assert.equal(access.jobSession(), true, tag + ': признак поручения');
        assert.equal(access.chatSession(), false, tag + ': не чат');
        // team_change/team_members/team_inbox — не в наборе исполнителя: закрыты уже на регистрации (allowed=false).
        for (const t of ['team_change', 'team_members', 'team_inbox'])
          assert.equal(access.allowed('team', t), false, tag + ' → ' + t + ' закрыт (allowed)');
        // Каждое право чата из поручения отказано guard: team_word (у мест-дирижёров формально в наборе исполнителя) — по
        // jobProof; team_change/члены/вход — по регистрации; диагностика team_status — доп-ограничением гостя-поручения.
        const argsOf = t => t === 'team_word' ? { action: 'stop_confirm' } : t === 'team_status' ? { claude_quota: true } : { action: 'deploy' };
        for (const t of ['team_change', 'team_word', 'team_members', 'team_inbox', 'team_status'])
          assert.throws(() => access.guard('team', t, argsOf(t)), /запрещено|поручени|чат/, tag + ' → guard ' + t);
      });
  }],
  ['Слово из чата любого участника пишется с источником chat-<клиент>; из поручения — отказ', async () => {
    // kimi включён явно (часть Д): чат приложения Kimi — такой же дирижёр, слово пишется с источником chat-kimi (участник на паузе).
    for (const c of ['codex', 'antigravity', 'deepseek', 'claude', 'kimi']) {
      const rec = await withEnv({ MOST_CLIENT: c, MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined }, () =>
        words.recordStopConfirmation(['job-' + c + '-0001'], 'снять ' + c, async r => r));
      assert.equal(rec.source, 'chat-' + c, 'source для ' + c);
      assert.equal(rec.recorded_by, c, 'recorded_by для ' + c);
    }
    await withEnv({ MOST_CLIENT: 'claude', MOST_JOB_ID: 'job-1' }, async () =>
      assert.rejects(words.recordStopConfirmation(['job-xx-0001'], 'из поручения'), /из поручения запрещено/));
  }],
  ['Запасной режим не отказывает чату участника (team_change в активном режиме открыт)', () => {
    withEnv({ MOST_CLIENT: 'codex', MOST_AUTHORITY: 'user', MOST_JOB_ID: undefined, MOST_PROBE_ONLY: undefined }, () => {
      assert.equal(access.chatSession(), true, 'authority=user: codex всё ещё чат участника');
      assert.doesNotThrow(() => access.guard('team', 'team_change', { action: 'merge' }), 'team_change merge открыт чату в запасном режиме');
    });
  }],
  ['lineage: X_send из чата X зарегистрирован (свой сервер); цикл внутри цепочки поручений ловит job-chain', () => {
    withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined }, () =>
      assert(access.guestTools('codex', 'codex').includes('codex_send'), 'codex_send из чата codex зарегистрирован'));
    // Цикл «сам себе» внутри цепочки поручений запрещается общим job-chain при вызове (покрыто team-v36); здесь — наличие защиты.
    assert.equal(typeof require('../common/job-chain').admit, 'function', 'job-chain.admit — защита цикла цепочки поручений');
  }],
  ['Профиль ПОРУЧЕНИЙ Kimi (RECIPIENTS): все участники связки, набор исполнителя, без инструментов дирижёра', () => {
    const r = kimiMcp.RECIPIENTS;
    for (const p of ['claude', 'codex', 'antigravity', 'deepseek', 'team']) assert(Array.isArray(r[p]) && r[p].length, 'получатель ' + p + ' есть');
    assert(!('kimi' in r), 'Kimi → Kimi недопустим — kimi среди получателей нет');
    const all = kimiMcp.profileTools();
    for (const t of ['team_change', 'team_word', 'team_members', 'team_inbox', 'antigravity_apply'])
      assert(!all.some(x => x.endsWith('__' + t)), 'в профиле поручений НЕТ инструмента дирижёра ' + t);
    // Набор исполнителя: send/result/status/cancel у участников; team_ask/team_status/team_rules/team_work у team.
    for (const t of ['mcp__codex__codex_send', 'mcp__claude__claude_send', 'mcp__deepseek__deepseek_result', 'mcp__antigravity__antigravity_status',
      'mcp__team__team_ask', 'mcp__team__team_status', 'mcp__team__team_rules', 'mcp__team__team_work']) assert(all.includes(t), 'в профиле есть ' + t);
  }],
  ['Опасный случай 3: пару чат codex / чат claude разводит владение работой (второй — отказ по владению, не по режиму)', async () => {
    const { Team } = require('../common/team');
    const team = () => { const t = new Team(REPO); t.fallbackDeps = { evaluate: () => ({ desktopAlive: true }), restart: async () => { throw Error('запуск не ожидался'); } }; return t; };
    const workArgs = { goal: 'цель', done_criteria: 'готово', next_step: 'дальше', folder: PROJECT };
    const stages = [{ title: 'Итог', weight: 100, state: 'идёт', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, version: 'v1' }];
    // Чат Codex создаёт и ведёт работу с меткой codex-sess.
    await withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () =>
      team().work({ action: 'create', name: 'two-chats', owner: 'codex-sess', expected_revision: 0, ...workArgs, stages }));
    const w = JSON.parse(fs.readFileSync(team().workFile('two-chats'), 'utf8'));
    // Чат Claude (второй участник) пытается вести ту же работу своей меткой — отказ по владению (owner), а не по режиму.
    await withEnv({ MOST_CLIENT: 'claude', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () =>
      assert.rejects(team().work({ action: 'update', name: 'two-chats', owner: 'claude-sess', expected_revision: w.revision, next_step: 'из чата Claude' }),
        /владени|Работа жив|передан/i, 'второй чат получает отказ по владению'));
    // Владелец (чат Codex) своей меткой продолжает — доступ есть (владение не блокирует своего).
    await withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () =>
      team().work({ action: 'update', name: 'two-chats', owner: 'codex-sess', expected_revision: w.revision, next_step: 'владелец продолжает' }));
  }],
  ['Опасный случай 6: запись всех серверов связки сохраняет посторонние настройки клиентов (Codex, Antigravity, DeepSeek, Kimi)', () => {
    const cc = require('../common/client-configs'), dsh = require('../common/dsh-config'), kimi = require('../common/kimi-mcp');
    const bundle = [...members.installedServers];
    assert(bundle.length >= 3, 'в связке есть серверы');
    const release = path.join(REPO, 'live', 'a'.repeat(40)), node = process.execPath;
    // Codex (TOML): посторонний ключ и BOM/CRLF сохраняются; все серверы связки записаны в служебный блок.
    const codexOut = cc.toml('﻿# чужой текст\r\napproval_policy = "never"\r\n', release, REPO, path.join(REPO, 'state'), node);
    assert(codexOut.includes('approval_policy = "never"'), 'Codex: посторонний ключ сохранён');
    assert(codexOut.includes('# чужой текст'), 'Codex: посторонний комментарий сохранён');
    for (const n of bundle) assert(codexOut.includes('[mcp_servers.' + n + ']'), 'Codex: сервер связки ' + n);
    // Antigravity (JSON): чужой раздел и чужой mcpServers сохранены; все серверы связки добавлены.
    const agyOut = cc.jsonConfig({ foreign: { secret: 'KEEP' }, mcpServers: { other: { command: 'keep' } } }, 'agy', release, REPO, path.join(REPO, 'state'), node);
    assert.equal(agyOut.foreign.secret, 'KEEP', 'Antigravity: чужой раздел сохранён');
    assert(agyOut.mcpServers.other, 'Antigravity: чужой сервер сохранён');
    for (const n of bundle) assert(agyOut.mcpServers[n], 'Antigravity: сервер связки ' + n);
    // DeepSeek (YAML): чужая запись сохранена; все серверы связки добавлены как mcp-most-<n>.
    const dshOut = dsh.render('- id: personal\n  name: "@x/y"\n', release, REPO, node);
    assert(dshOut.includes('id: personal'), 'DeepSeek: чужая запись сохранена');
    for (const n of bundle) assert(dshOut.includes('mcp-most-' + n), 'DeepSeek: сервер связки ' + n);
    // Kimi: служебный .kimi-code/mcp.json пишется в executionFolder (не в проект пользователя); посторонний сервер — отказ
    // (записи не объединяются, посторонние настройки проекта не затираются).
    const built = kimi.build({ job: { role: 'совет' }, sends: true, newJobId: 'job-k6', executionFolder: path.join(REPO, 'exec'),
      serversDir: path.join(release, 'servers'), node, root: REPO, state: path.join(REPO, 'state'), tempFolder: path.join(REPO, 'tmp') });
    assert.equal(built.policy, 'project'); for (const n of Object.keys(kimi.RECIPIENTS)) assert(built.content.mcpServers[n], 'Kimi: сервер связки ' + n);
    const exec = path.join(REPO, 'exec-foreign'); fs.mkdirSync(path.join(exec, '.kimi-code'), { recursive: true });
    fs.writeFileSync(path.join(exec, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: { foreignUser: { command: 'x' } } }));
    assert.throws(() => kimi.assertNoForeign(exec, built.content), /посторонний MCP-сервер/, 'Kimi: посторонняя запись пользователя не затирается — отказ');
  }],
]);
