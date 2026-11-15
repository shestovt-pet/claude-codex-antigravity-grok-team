'use strict';
// team-v48 (Г1): Claude-исполнитель без навязанного предела ходов и с инструментом Write при записи.
// Проверяет ровно новое поведение claude-args.js: --max-turns по умолчанию не добавляется (даже если
// справка его поддерживает); Write попадает в --tools при write/fullAccessApplied; правило папки — Edit(//e/…/**).
const assert = require('assert');
const ca = require('../common/claude-args');
const tests = [], test = (name, fn) => tests.push([name, fn]);
const files = { mcpConfig: 'm', settings: 's' };
const helpWithTurns = ca.REQUIRED_FLAGS.join(' ') + ' --max-turns --no-session-persistence --setting-sources --settings';

test('Г1: --max-turns по умолчанию не навязывается даже при поддержке флага справкой', () => {
  const saved = process.env.MOST_CLAUDE_MAX_TURNS; delete process.env.MOST_CLAUDE_MAX_TURNS;
  try {
    const args = ca.buildArgs(files, {}, {}, helpWithTurns);
    assert.ok(!args.includes('--max-turns'), 'по умолчанию флага --max-turns нет');
  } finally { if (saved === undefined) delete process.env.MOST_CLAUDE_MAX_TURNS; else process.env.MOST_CLAUDE_MAX_TURNS = saved; }
});

test('Г1: явный params.max_turns>0 добавляет флаг (прежнее поведение явной настройки)', () => {
  const saved = process.env.MOST_CLAUDE_MAX_TURNS; delete process.env.MOST_CLAUDE_MAX_TURNS;
  try {
  const args = ca.buildArgs(files, { max_turns: 7 }, {}, helpWithTurns);
  assert.equal(args[args.indexOf('--max-turns') + 1], '7');
  // params.max_turns<=0 и нецелое — флаг не добавляется
  assert.ok(!ca.buildArgs(files, { max_turns: 0 }, {}, helpWithTurns).includes('--max-turns'));
  assert.ok(!ca.buildArgs(files, { max_turns: 2.5 }, {}, helpWithTurns).includes('--max-turns'));
  } finally { if (saved === undefined) delete process.env.MOST_CLAUDE_MAX_TURNS; else process.env.MOST_CLAUDE_MAX_TURNS = saved; }
});

test('team-v48e §2.6 Г1: MOST_CLAUDE_MAX_TURNS удалён — даже при выставленной переменной предела ходов нет (без явного params)', () => {
  const saved = process.env.MOST_CLAUDE_MAX_TURNS;
  try {
    process.env.MOST_CLAUDE_MAX_TURNS = '30';
    const args = ca.buildArgs(files, {}, {}, helpWithTurns);
    assert.ok(!args.includes('--max-turns'), 'MOST_CLAUDE_MAX_TURNS не навязывает предел (тумблер удалён)');
    // явный params.max_turns сохраняется и при выставленной переменной
    const over = ca.buildArgs(files, { max_turns: 5 }, {}, helpWithTurns);
    assert.equal(over[over.indexOf('--max-turns') + 1], '5');
  } finally { if (saved === undefined) delete process.env.MOST_CLAUDE_MAX_TURNS; else process.env.MOST_CLAUDE_MAX_TURNS = saved; }
});

test('Г1: флаг не добавляется, если справка его не поддерживает (запуск не блокируется)', () => {
  const help = ca.REQUIRED_FLAGS.join(' '); // без --max-turns
  assert.ok(!ca.buildArgs(files, { max_turns: 9 }, {}, help).includes('--max-turns'));
});

test('Г1: Write в --tools при write и fullAccessApplied, но не в чтении', () => {
  const read = ca.buildArgs(files, {}, {});
  const readTools = read[read.indexOf('--tools') + 1].split(',');
  assert.ok(!readTools.includes('Write'), 'без записи Write отсутствует');
  assert.ok(!readTools.includes('Edit'), 'без записи Edit отсутствует');
  const w = ca.buildArgs(files, {}, { write: true, folder: 'E:\\work\\dir' });
  const wTools = w[w.indexOf('--tools') + 1].split(',');
  assert.ok(wTools.includes('Write') && wTools.includes('Edit'), 'при write есть Write и Edit');
  assert.ok(!wTools.includes('Bash'), 'при write нет Bash');
  const full = ca.buildArgs(files, {}, { fullAccessApplied: true, folder: 'E:\\work\\dir' });
  const fTools = full[full.indexOf('--tools') + 1].split(',');
  assert.ok(fTools.includes('Write') && fTools.includes('Edit') && fTools.includes('Bash'), 'при полном доступе есть Write/Edit/Bash');
});

test('team-v48b: правило записи — Edit(//e/путь/**), Write-правил с путём нет (их Claude Code не сопоставляет)', () => {
  assert.equal(ca.editRule('E:\\work\\dir'), 'Edit(//e/work/dir/**)');
  assert.equal(ca.editRule('E:\\Codex\\work\\probe\\'), 'Edit(//e/Codex/work/probe/**)');
  assert.equal(ca.editRule('e:\\a\\..\\work'), 'Edit(//e/work/**)');
  assert.equal(ca.writeRule, undefined, 'writeRule убран');
  const allowed = ca.allowedTools({ write: true, folder: 'E:\\work\\dir' });
  assert.deepEqual(allowed, ['Edit(//e/work/dir/**)']);
  assert.ok(!allowed.some(a => /^Write\(/.test(a)), 'Write(путь) не выдаётся');
  // settings: при write Write не в deny; без записи — в deny
  assert.ok(!(ca.settings({ write: true }).permissions.deny || []).includes('Write'));
  assert.ok((ca.settings({}).permissions.deny || []).includes('Write'));
});

// --- Г2a: единое представление «нет срока» (chain-deadline, inbox) ---
const dl = require('../common/chain-deadline');
const inbox = require('../common/inbox');
const TIMER_ENV = ['MOST_CODEX_TIMEOUT_MS', 'MOST_CLAUDE_TIMEOUT_MS', 'MOST_DEEPSEEK_TIMEOUT_MS', 'MOST_PRINT_TIMEOUT', 'MOST_WATCHDOG_MS'];
function withoutTimers(fn) {
  const saved = {}; for (const k of TIMER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); } finally { for (const k of TIMER_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
function withEnv(env, fn) {
  const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('Г2: normalTimeoutMs по умолчанию null для всех исполнителей', () => {
  withoutTimers(() => {
    for (const s of ['codex', 'claude', 'deepseek', 'antigravity']) assert.equal(dl.normalTimeoutMs(s), null, s + ' без MOST_* → null');
  });
});

test('team-v48e §2.6 Г2: сроковые тумблеры удалены — normalTimeoutMs остаётся null даже при выставленных прежних переменных', () => {
  withEnv({ MOST_CODEX_TIMEOUT_MS: '600000' }, () => assert.equal(dl.normalTimeoutMs('codex'), null));
  withEnv({ MOST_CLAUDE_TIMEOUT_MS: '700000' }, () => assert.equal(dl.normalTimeoutMs('claude'), null));
  withEnv({ MOST_DEEPSEEK_TIMEOUT_MS: '800000' }, () => assert.equal(dl.normalTimeoutMs('deepseek'), null));
  withEnv({ MOST_PRINT_TIMEOUT: '5m' }, () => assert.equal(dl.normalTimeoutMs('antigravity'), null));
  withEnv({ MOST_WATCHDOG_MS: '120000' }, () => assert.equal(dl.normalTimeoutMs('antigravity'), null));
});

test('Г2: runtimeBudget — три случая остатка (null / >0 / <=0)', () => {
  withoutTimers(() => {
    // случай 1: карточка без deadline и без MOST_* → null (таймер-убийца не создаётся)
    assert.equal(dl.runtimeBudget({}, 'codex'), null);
    // случай 2: конечный будущий deadline → положительный остаток
    const future = dl.runtimeBudget({ deadline: new Date(Date.now() + 5 * 60000).toISOString() }, 'codex');
    assert.ok(Number.isFinite(future) && future > 0);
    // случай 3: конечный прошедший deadline → 0 (немедленная остановка, не пропуск)
    assert.equal(dl.runtimeBudget({ deadline: new Date(Date.now() - 1000).toISOString() }, 'codex'), 0);
  });
  // team-v48e §2.6: прежняя переменная срока удалена — без deadline карточки остаток остаётся null даже при её выставлении
  withEnv({ MOST_CODEX_TIMEOUT_MS: '600000' }, () => assert.equal(dl.runtimeBudget({}, 'codex'), null));
});

test('Г2: parentRemainingMs/childDeadline без срока → null (нет отказа «≤ 3 мин»)', () => {
  withoutTimers(() => {
    const now = Date.now();
    assert.equal(dl.parentRemainingMs({ startedAt: new Date(now - 60000).toISOString() }, 'codex', now), null);
    const r = dl.childDeadline({ startedAt: new Date(now - 60000).toISOString() }, 'codex', 'claude', now);
    assert.equal(r.deadline, null); assert.equal(r.error, null);
    // старая карточка с конечным deadline работает как раньше даже без MOST_*
    const r2 = dl.childDeadline({ deadline: new Date(now + 10 * 60000).toISOString() }, 'codex', 'claude', now);
    assert.ok(Date.parse(r2.deadline) <= now + 7 * 60000);
  });
});

test('Г2: inbox.askDeadline без срока родителя → null (или только ttl_min)', () => {
  withoutTimers(() => {
    const job = { member: 'codex', startedAt: new Date(Date.now() - 60000).toISOString() };
    assert.equal(inbox.askDeadline({}, { kind: 'job', job }), null, 'нет ни родительского срока, ни ttl → без срока');
    const d = inbox.askDeadline({ ttl_min: 30 }, { kind: 'job', job });
    assert.ok(Date.parse(d) - Date.now() <= 30 * 60000 + 1000 && Date.parse(d) - Date.now() > 29 * 60000, 'только ttl_min');
    // запись без срока не считается просроченной
    assert.equal(inbox.expired({ deadline: null }), false);
  });
});

test('team-v48c: вывод срока запроса дирижёру — без срока, ttl_min и старый конечный срок', () => {
  const inbox = require('../common/inbox');
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  // бессрочный (поручение без срока, без ttl_min)
  assert.equal(inbox.deadlineText({ deadline: null }), 'без срока');
  assert.equal(inbox.waitText({ deadline: null }, now), 'ждёт дирижёра, без срока');
  assert.ok(!/NaN|null/.test(inbox.waitText({}, now) + inbox.deadlineText({})), 'нет NaN/null в выводе');
  // ttl_min = 30 у бессрочного поручения
  const ttl = { deadline: new Date(now + 30 * 60000).toISOString() };
  assert.equal(inbox.waitText(ttl, now), 'ждёт дирижёра 30 мин');
  assert.equal(inbox.deadlineText(ttl), ttl.deadline);
  // старый конечный срок (уже прошёл) — 0 мин, просрочен по expired
  const old = { deadline: new Date(now - 5 * 60000).toISOString() };
  assert.equal(inbox.waitText(old, now), 'ждёт дирижёра 0 мин');
  assert.equal(inbox.expired(old, now), true);
  assert.equal(inbox.expired({ deadline: null }, now), false, 'бессрочный не просрочен');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ДА: ' + name); }
    catch (e) { failed++; console.log('ПРОВАЛ: ' + name + '\n' + (e && e.stack || e)); }
  }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  process.exitCode = failed ? 1 : 0;
})();
