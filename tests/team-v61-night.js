'use strict';
// team-v61-night: ночная доводка моста, часть 2 — по одному случаю на каждый пункт задания.
//  1 quota: исчерпание квоты только по диагностике провайдера, слово «quota» в тексте ответа — не доказательство;
//  2 restart-hold: сбой снимка процессов → unknown, предупреждения не пропадают;
//  3 Kimi waiting_quota честно: доказательство на время окна, после окна — failed (без ложного автопродолжения);
//  4 summary: сохранённое gate.warning видно и в краткой сводке;  5 summary: успех Kimi снимает строку «лимит исчерпан»;
//  6 stop_confirm/close: сбой снимка процессов не блокирует слово владельца (решаемый отказ);
//  7/8 team_change merge/commit словом владельца — без ворот замысла, без голосов, при одной семье;
//  9 model-choice: короткое поручение про код — не simple;  10 Antigravity ревью кода → hydrogen-high;
//  11 scan-index: тяжёлые сырые поля (retry/writes) в индекс не попадают;  12 уборка отметок процессов;  13 квота DeepSeek.
// Часть 3 (добавлено): «1 (часть3)» уборка берёт снимок процессов асинхронно (не блокирует событийный цикл сервера team);
//  «2 (часть3)» кириллические границы в CODE_NOUN (\b не работает с кириллицей); «4 (часть3)» реальная диагностика лимита Kimi.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v61-'));
const STATE = path.join(RUN, 'state'), PROJECT = path.join(RUN, 'project');
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: STATE, MOST_CODEX_JOBS_DIR: path.join(STATE, 'codex-jobs'),
  MOST_CODEX_ARCHIVE_DIR: '', MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_CLAUDE_CONFIGS: '[]',
  NODE_ENV: 'test', MOST_TEST_CHAT_ORIGIN: 'proven', MOST_FALLBACK_DIR: path.join(RUN, 'fallback') });
delete process.env.MOST_AUTHORITY;
fs.mkdirSync(STATE, { recursive: true }); fs.mkdirSync(PROJECT, { recursive: true });

const quota = require('../common/quota');
const mc = require('../common/model-choice');
const restartHold = require('../common/restart-hold');
const stop = require('../common/stop-confirm');
const ts = require('../common/team-store');
const markCleanup = require('../common/restart-mark-cleanup');
const fallback = require('../common/fallback');

const inProc = [], T = (n, f) => inProc.push([n, f]);

// ---------- Пункт 1: признак квоты только из диагностики провайдера ----------
T('1 quota: исчерпание — только провайдерские признаки; слово «quota» в тексте не считается', () => {
  assert.equal(quota.quotaExhausted("You've reached your 5-hour usage limit."), true, 'usage limit');
  assert.equal(quota.quotaExhausted('error: quota exceeded'), true, 'quota exceeded');
  assert.equal(quota.quotaExhausted('RESOURCE_EXHAUSTED: ...'), true, 'RESOURCE_EXHAUSTED');
  assert.equal(quota.quotaExhausted('The quota column stores a number.'), false, 'голое «quota» в тексте — не квота');
  assert.equal(quota.quotaExhausted('429 Too Many Requests'), false, 'голый 429 — не квота');
  assert.equal(quota.quotaExhausted('rate limit reached'), false, 'rate limit — не квота');
  assert.equal(quota.quotaExhausted('too many requests'), false, 'too many requests — не квота');
  assert.equal(quota.quotaExhausted('internal error'), false, 'обычный сбой — не квота');
});

// ---------- Пункт 2: сбой снимка процессов → unknown (а не ложная смерть) ----------
T('2 restart-hold: сбой снимка процессов даёт unknown, предупреждение о сервере не пропадает', () => {
  // processState с бросающим fingerprint → unknown (а не dead).
  assert.equal(restartHold.processState({ pid: 123, startedAt: new Date().toISOString() }, { fingerprint: () => { throw Error('CIM недоступен'); } }), 'unknown');
  // warnings: живой сервер с ошибкой капчи; снимок процессов бросает → предупреждение остаётся (не глохнет на «dead»).
  const st = path.join(RUN, 'state2'); fs.mkdirSync(path.join(st, 'restart-servers'), { recursive: true });
  const self = { pid: process.pid, startedAt: new Date(Date.now() - 1000).toISOString(), name: 'node' };
  fs.writeFileSync(path.join(st, 'restart-servers', process.pid + '.json'), JSON.stringify({ name: 'kimi', error: 'не прочитана таблица процессов', process: self }));
  const orig = fallback.processTable;
  fallback.processTable = () => { throw Error('CIM завис'); };
  try {
    const lines = restartHold.warnings(st);
    assert.ok(lines.some(l => /цепочк[уи] предков сервера kimi/i.test(l)), 'предупреждение о сервере kimi осталось: ' + JSON.stringify(lines));
  } finally { fallback.processTable = orig; }
  // Контроль: при пустом снимке тоже не «dead» (то же unknown-поведение).
  fallback.processTable = () => [];
  try {
    const lines = restartHold.warnings(st);
    assert.ok(lines.some(l => /цепочк[уи] предков сервера kimi/i.test(l)), 'пустой снимок тоже не глушит предупреждение');
  } finally { fallback.processTable = orig; }
});

// ---------- Пункт 6: сбой снимка процессов не блокирует слово владельца ----------
T('6 stop_confirm: checkStopped при недоступном снимке даёт решаемый отказ (перекрывается словом)', async () => {
  const deadOwner = { instance: 'ffffffff-0000-0000-0000-000000000000', pid: 999001, startedAt: '2020-01-01T00:00:00.000Z' };
  const r = await stop.checkStopped({ status: 'failed', owner: deadOwner, observedPids: [999002], childPid: 999002 }, null);
  assert.ok(/снимок процессов недоступ/i.test(r.reason || ''), 'причина про недоступный снимок: ' + JSON.stringify(r));
  assert.equal(stop.overridable(r.reason), true, 'отказ решаемый — слово владельца его перекрывает');
});

// ---------- Пункт 9: короткое поручение про код — не simple ----------
T('9 model-choice: короткая просьба написать/исправить код — не simple; «2+2» — simple', () => {
  assert.equal(mc.classify('codex', { task: 'сколько будет 2+2' }), 'simple');
  assert.equal(mc.classify('codex', { task: 'напиши функцию факториала' }) !== 'simple', true, 'напиши функцию — не simple');
  assert.equal(mc.classify('codex', { task: 'исправь регулярку в парсере' }) !== 'simple', true, 'исправь регулярку — не simple');
  assert.equal(mc.classify('deepseek', { task: 'поправь SQL-запрос', role: 'совет' }) !== 'simple', true, 'поправь SQL — не simple');
  assert.equal(mc.classify('kimi', { task: 'напиши юнит-тест', role: 'совет' }) !== 'simple', true, 'напиши тест — не simple');
  // Простые вопросы остаются simple.
  assert.equal(mc.classify('codex', { task: 'напиши стихотворение про осень' }), 'simple', 'стих без код-предмета — simple');
  assert.equal(mc.classify('deepseek', { task: 'ответь на запрос вежливо', role: 'совет' }), 'simple', '«запрос» без глагола-кода — simple');
  assert.equal(mc.codeRequest('напиши функцию'), true);
  assert.equal(mc.codeRequest('сколько будет 2+2'), false);
});

// ---------- Пункт 10 (team-v63 п.б): Antigravity ревью кода → neon-low ----------
// team-v61 (п.10) поднимал ревью кода из дешёвого low до review_high. team-v63 (п.б): замер 20.11.2026 на diff v60 показал,
// что neon-low находит ошибок больше и быстрее hydrogen-high, поэтому ревью КОДА/дифа у Antigravity теперь neon-low.
T('10 model-choice: ревью кода у Antigravity → review_code (neon-low)', () => {
  const diff = mc.choose('antigravity', { poruchenie: 'дай замечания', rezhim: 'zamechaniya', fayl: 'patch.diff' });
  assert.equal(diff.model, 'gemini-4-neon-low', 'ревью дифа кода → neon-low');
  assert.equal(diff.class, 'review_code'); assert.equal(diff.fallback, 'gemini-4-hydrogen-high', 'откат — прежний hydrogen-high');
  assert.equal(mc.choose('antigravity', { poruchenie: 'проверь', rezhim: 'zamechaniya', fayl: 'common/team.js' }).model, 'gemini-4-neon-low', 'ревью .js → neon-low');
  assert.equal(mc.choose('antigravity', { poruchenie: 'проверь рефакторинг кода', rezhim: 'zamechaniya' }).model, 'gemini-4-neon-low', 'ревью по тексту про код → neon-low');
  // Ревью НЕ-кода остаётся low; высокий этап не-кода — hydrogen-high.
  assert.equal(mc.choose('antigravity', { poruchenie: 'замечания по тексту рассказа', rezhim: 'zamechaniya' }).model, 'gemini-4-hydrogen-low', 'ревью прозы → low');
  assert.equal(mc.choose('antigravity', { poruchenie: 'ревью замысла', rezhim: 'zamechaniya', level: 'высокий' }).model, 'gemini-4-hydrogen-high', 'высокий этап не-кода → hydrogen-high');
  // Прочие участники ревью кода не меняют: у codex остаётся astra/high.
  assert.deepEqual(['model', 'effort'].map(k => mc.choose('codex', { task: 'проверь метод', role: 'проверка' })[k]), ['gpt-6.2-sol', 'high'], 'обычное ревью кода Codex');
  assert.equal(mc.codeReview({ fayl: 'x.py' }), true);
  assert.equal(mc.codeReview({ poruchenie: 'оцени рассказ' }), false);
});

// ---------- Пункт 11: scan-index — тяжёлые сырые поля в индекс не попадают ----------
T('11 team-store.trimForIndex: retry убирается всегда; writes — у всех, кроме codex', () => {
  const full = { id: 'x', status: 'applied', task: 'тело', retry: { stdin: 'огромный', args: [] }, writes: [{ path: 'a', sha256: 'h' }], owner: { pid: 1 } };
  const nonCodex = ts.trimForIndex(full, false);
  assert.equal('retry' in nonCodex, false, 'retry убран');
  assert.equal('writes' in nonCodex, false, 'writes убран у не-codex');
  assert.equal(nonCodex.task, 'тело', 'лёгкие поля на месте');
  assert.deepEqual(nonCodex.owner, { pid: 1 }, 'owner сохранён');
  const codex = ts.trimForIndex(full, true);
  assert.equal('retry' in codex, false, 'retry убран и у codex');
  assert.deepEqual(codex.writes, [{ path: 'a', sha256: 'h' }], 'writes у codex сохранён (нужен fallback-атрибуции)');
  // Нет тяжёлых полей — объект не копируется зря (та же ссылка), поведение не меняется.
  const light = { id: 'y', status: 'done' };
  assert.equal(ts.trimForIndex(light, false), light, 'без тяжёлых полей — тот же объект');
});

// ---------- Пункт 12: уборка устаревших отметок процессов ----------
T('12 restart-mark-cleanup: мёртвые отметки старше суток удаляются, живые и свежие — нет', async () => {
  const st = path.join(RUN, 'state12');
  fs.mkdirSync(path.join(st, 'restart-servers'), { recursive: true });
  fs.mkdirSync(path.join(st, 'ready'), { recursive: true });
  const dead = 999123, live = process.pid, old = Date.now() - 3 * 86400000, oldSec = old / 1000;
  const mk = (p, t) => { fs.writeFileSync(p, '{}'); if (t) fs.utimesSync(p, oldSec, oldSec); };
  mk(path.join(st, 'restart-servers', dead + '.json'), true);          // мёртвый, старый → удалить
  mk(path.join(st, 'restart-servers', dead + '.watch'), true);          // мёртвый, старый → удалить
  mk(path.join(st, 'restart-servers', live + '.json'), true);           // живой → оставить
  mk(path.join(st, 'restart-servers', (dead + 1) + '.json'), false);    // мёртвый, но свежий → оставить
  mk(path.join(st, 'ready', 'team.' + dead + '.json'), true);           // мёртвый экземпляр, старый → удалить
  mk(path.join(st, 'ready', 'team.json'), true);                        // общий (без pid) → оставить
  // team-v61 (часть 3): снимок внедряется через tableFn (run асинхронна). Живым считается только текущий процесс.
  const table = () => Promise.resolve([{ pid: process.pid, ppid: 1 }]);
  const r = await markCleanup.run({ stateDir: st, tableFn: table });
  assert.equal(r.removed, 3, 'удалено ровно 3 мёртвых старых: ' + JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(st, 'restart-servers', dead + '.json')), 'мёртвый .json удалён');
  assert.ok(!fs.existsSync(path.join(st, 'restart-servers', dead + '.watch')), 'мёртвый .watch удалён');
  assert.ok(fs.existsSync(path.join(st, 'restart-servers', live + '.json')), 'живой оставлен');
  assert.ok(fs.existsSync(path.join(st, 'restart-servers', (dead + 1) + '.json')), 'свежий оставлен');
  assert.ok(!fs.existsSync(path.join(st, 'ready', 'team.' + dead + '.json')), 'мёртвый экземпляр готовности удалён');
  assert.ok(fs.existsSync(path.join(st, 'ready', 'team.json')), 'общий файл готовности оставлен');
  // Сбой снимка — ничего не удаляем.
  const bad = () => Promise.reject(Error('CIM недоступен'));
  assert.equal((await markCleanup.run({ stateDir: st, tableFn: bad })).removed, 0, 'при сбое снимка не удаляем');
});

// ---------- Пункт 1 (часть 3): уборка отметок не блокирует событийный цикл (снимок асинхронный) ----------
T('1 (часть3) restart-mark-cleanup: медленный снимок берётся асинхронно, цикл не блокируется; по умолчанию — chat-origin', async () => {
  const st = path.join(RUN, 'state1c3');
  fs.mkdirSync(path.join(st, 'restart-servers'), { recursive: true });
  // Медленный снимок через внедрённый tableFn: пока он считается, поставленный ПОСЛЕ старта таймер успевает сработать —
  // значит run не держит событийный цикл синхронно (прежний execFileSync держал бы до 120 с).
  let ticked = false;
  const slow = () => new Promise(res => setTimeout(() => res([{ pid: process.pid, ppid: 1 }]), 60));
  const p = markCleanup.run({ stateDir: st, tableFn: slow });
  const tk = setTimeout(() => { ticked = true; }, 5);
  const r = await p; clearTimeout(tk);
  assert.equal(ticked, true, 'событийный цикл работал, пока уборка ждала снимок — снимок асинхронный');
  assert.equal(r.removed, 0, 'старых мёртвых отметок нет — удалять нечего');
  // По умолчанию (без tableFn) на Windows снимок идёт через асинхронный chat-origin.liveTableAsync, НЕ через синхронный
  // fallback.processTable (его execFileSync блокировал бы сервер team). Проверяем прямой подменой обеих точек.
  const co = require('../common/chat-origin');
  const origAsync = co.liveTableAsync, origSync = fallback.processTable;
  let asyncCalled = false, syncCalled = false;
  co.liveTableAsync = () => { asyncCalled = true; return Promise.resolve([{ pid: process.pid, ppid: 1 }]); };
  fallback.processTable = () => { syncCalled = true; throw Error('синхронный снимок на сервере team запрещён'); };
  try { await markCleanup.run({ stateDir: st }); }
  finally { co.liveTableAsync = origAsync; fallback.processTable = origSync; }
  if (process.platform === 'win32') {
    assert.equal(asyncCalled, true, 'снимок взят через chat-origin.liveTableAsync');
    assert.equal(syncCalled, false, 'синхронный fallback.processTable на сервере team не вызывался');
  }
});

// ---------- Пункт 2 (часть 3): кириллические границы в CODE_NOUN (\b не работает с кириллицей) ----------
T('2 (часть3) model-choice: «почини баг»/«напиши метод» — не simple; «проверь метод» → review_code; «2+2» — simple', () => {
  assert.equal(mc.codeRequest('почини баг'), true, '«почини баг» — код-просьба (CODE_NOUN поймал «баг»)');
  assert.equal(mc.codeRequest('напиши метод'), true, '«напиши метод» — код-просьба (CODE_NOUN поймал «метод»)');
  assert.notEqual(mc.classify('codex', { task: 'почини баг' }), 'simple', '«почини баг» не simple');
  assert.notEqual(mc.classify('codex', { task: 'напиши метод' }), 'simple', '«напиши метод» не simple');
  // Предмет «метод» делает ревью кодовым при роли «проверка».
  assert.equal(mc.codeReview({ task: 'проверь метод' }), true, 'ревью «проверь метод» — кодовое');
  assert.equal(mc.classify('codex', { task: 'проверь метод', role: 'проверка' }), 'review_code', '«проверь метод» с ролью проверка → review_code');
  assert.equal(mc.codeReview({ task: 'найди баг' }), true, 'ревью «найди баг» — кодовое');
  // «2+2» — simple; а похожие, но ДРУГИЕ слова граница слова не ловит (не «методология», не «багаж»).
  assert.equal(mc.classify('codex', { task: 'сколько будет 2+2' }), 'simple', '«2+2» — simple');
  assert.equal(mc.codeReview({ task: 'опиши методологию исследования' }), false, '«методология» — не «метод» (граница слова)');
  assert.equal(mc.codeReview({ task: 'уложи вещи в багаж' }), false, '«багаж» — не «баг» (граница слова)');
});

// ---------- Пункт 4 (часть 3): реальная диагностика лимита Kimi распознаётся новым quotaExhausted/providerLine ----------
T('4 (часть3) Kimi: реальная диагностика «5-hour usage limit» → quotaExhausted; providerLine без ссылок/путей', () => {
  // Дословный stderr провайдера из упавшего во втором взгляде поручения Kimi (cd029a26…): это лимит провайдера, не сбой моста.
  const diag = "error: failed to run prompt: provider.api_error: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/settings/subscription?tab=quota\nSee log: C:\\Users\\x\\.kimi\\logs\\run.log";
  assert.equal(quota.quotaExhausted(diag), true, 'реальный лимит Kimi распознан как исчерпание квоты (servers/kimi terminal → waiting_quota)');
  const provider = quota.providerLine(diag);
  assert.ok(/usage limit/i.test(provider), 'суть провайдера сохранена: ' + provider);
  assert.ok(!/https?:\/\//.test(provider), 'ссылка убрана: ' + provider);
  assert.ok(!/C:\\/.test(provider), 'локальный путь убран: ' + provider);
});

// ---------- Пункт 13: исчерпание квоты DeepSeek — понятный текст тем же общим модулем ----------
T('13 deepseek quota: распознаётся по диагностике провайдера, строка провайдера без путей/ссылок', () => {
  // Та же логика, что в servers/deepseek/index.js finish(): gate по quotaExhausted + providerLine.
  const diag = "error: You have reached your usage limit. See https://x/y and C:\\keys\\token.txt";
  assert.equal(quota.quotaExhausted(diag), true, 'usage limit распознан из диагностики');
  const provider = quota.providerLine(diag);
  assert.ok(/usage limit/i.test(provider), 'суть провайдера сохранена');
  assert.ok(!/https?:\/\//.test(provider) && !/C:\\/.test(provider), 'ссылки и пути убраны: ' + provider);
  const msg = 'Лимит DeepSeek исчерпан (подписочная квота)' + (provider ? ' (' + provider + ')' : '') + '. Повторите позже или отдайте работу другой семье.';
  assert.ok(/Лимит DeepSeek исчерпан/.test(msg) && /usage limit/i.test(msg), 'понятное сообщение владельцу');
  // Обычный сбой DeepSeek квотой не помечается.
  assert.equal(quota.quotaExhausted('deepseek: internal error, exit 1'), false, 'обычный сбой — не квота');
});

// ---------- Пункты 4 и 5: краткая сводка ----------
function initMembers() { require('../common/members-store').create(STATE).read(); }
async function compactText(works) {
  const team = { state: path.join(STATE, 'team'), root: RUN, works: () => works };
  return require('../common/summary').compact(team, 'QUOTA', require('../common/job-snapshot').create(), { budget: 1e6 });
}
T('4 summary: сохранённое gate.warning этапа видно в краткой сводке', async () => {
  initMembers();
  const work = { name: 'w4', title: 'Работа-4', folder: PROJECT, next_step: 'дальше', updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    stages: [{ title: 'Э1', weight: 50, state: 'принят', gate: { warning: 'этап не удалось проверить (ENOENT: нет материала)' } }, { title: 'Э2', weight: 50, state: 'план' }] };
  const out = await compactText([work]);
  assert.ok(/ENOENT: нет материала/.test(out), 'сохранённое предупуждение этапа в сводке: ' + out.slice(0, 600));
});
T('5 summary: успешное поручение Kimi снимает строку «лимит исчерпан»', async () => {
  initMembers();
  const dir = path.join(STATE, 'kimi-jobs'); fs.mkdirSync(dir, { recursive: true });
  const card = (id, j) => { fs.mkdirSync(path.join(dir, id), { recursive: true }); fs.writeFileSync(path.join(dir, id, 'card.json'), JSON.stringify({ id, ...j })); };
  const t1 = new Date(Date.now() - 3600000).toISOString();
  card('kq1', { status: 'failed', retryKind: 'quota', lastQuotaAt: t1, startedAt: t1, finishedAt: t1 });
  let out = await compactText([]);
  assert.ok(/лимит исчерпан/.test(out), 'пока нет успеха — строка есть: ' + out.slice(0, 400));
  // Более позднее успешное поручение Kimi снимает строку.
  const t2 = new Date().toISOString();
  card('kok', { status: 'done', startedAt: t2, finishedAt: t2 });
  out = await compactText([]);
  assert.ok(!/Kimi[^\n]*лимит исчерпан/.test(out), 'после успеха строка снята: ' + out.slice(0, 400));
});

// ---------- Пункты 7 и 8: merge/commit словом владельца ----------
async function gitChange(label) {
  const g = require('../common/team-git'), { Team } = require('../common/team');
  const root = path.join(RUN, 'repo-' + label); fs.mkdirSync(root);
  g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.email', 't@e.invalid']); g.git(root, ['config', 'user.name', 'Т']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.work/\nstate/\nworks/\n'); fs.writeFileSync(path.join(root, 'file.txt'), 'база\n'); fs.writeFileSync(path.join(root, 'lessons.md'), '# Уроки\n');
  g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'База']);
  const design = path.join(RUN, 'design-' + label + '.md');
  fs.writeFileSync(design, '# Замысел\n\n## Запрос\nСлово.\n\n## Код\nК1.\n\n## Опасные случаи\n1. Отказ.\n\n## Живая проверка\nНе нужна.\n');
  const team = new Team(root), name = 'ch-' + label;
  await team.change({ action: 'start', name, request: 'Моего слова достаточно (' + label + ').', design_file: design });
  const folder = team.clone(name);
  g.git(folder, ['config', 'user.email', 't@e.invalid']); g.git(folder, ['config', 'user.name', 'Т']);
  return { g, team, root, folder, name, card: () => JSON.parse(fs.readFileSync(team.changeFile(name), 'utf8')), change: a => team.change({ name, ...a }) };
}
T('8 commit словом владельца — без ворот замысла, слово и вердикт в карточке', async () => {
  initMembers();
  const x = await gitChange('commit');
  fs.writeFileSync(path.join(x.folder, 'file.txt'), 'кандидат словом\n');
  const out = await x.change({ action: 'commit', message: 'кандидат словом', quote: 'сливай моим словом, замысел не нужен' });
  assert.ok(/Кандидат:/.test(out) && /словом владельца/i.test(out), 'commit прошёл словом: ' + out.slice(0, 300));
  const c = x.card();
  assert.ok((c.decisions || []).some(d => d.kind === 'owner_word' && d.phase === 'verdict' && d.replaces === 'all'), 'owner_word записан');
  assert.ok((c.verdicts || []).some(v => v.who === 'user' && v.quote === 'сливай моим словом, замысел не нужен'), 'дословная цитата в карточке');
});
T('7/8 merge словом владельца — без замысла и голосов проходит', async () => {
  initMembers();
  const x = await gitChange('merge');
  fs.writeFileSync(path.join(x.folder, 'file.txt'), 'кандидат\n');
  await x.change({ action: 'commit', message: 'кандидат словом', quote: 'сливай всё моим словом' });
  const out = await x.change({ action: 'merge', message: 'слияние', quote: 'сливай всё моим словом' });
  assert.ok(/Слито в main/.test(out), 'слияние прошло словом: ' + out.slice(0, 400));
  assert.ok(/словом владельца/i.test(out), 'в ответе названо слово владельца и риск: ' + out.slice(0, 400));
  assert.equal(x.card().status, 'слито', 'карточка помечена слито');
});

// ---------- Интеграция Kimi (пункты 1 и 3) — отдельным процессом-сервером, в конце ----------
const kimiTests = [];
const KT = (n, f) => kimiTests.push([n, f]);
KT('1 (интеграция) слово «quota» в ТЕКСТЕ ответа + обычный сбой → failed, не waiting_quota', async () => {
  const h = require('./fake-kimi'); const f = h.setup(); f.active(); f.probe();
  const c = await h.client(f);
  const send = async task => { const before = new Set(h.cards(f).map(j => j.id)); const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task, role: 'проверка' } });
    assert(!r.isError, h.text(r)); const j = h.cards(f).find(j => !before.has(j.id)); return h.wait(f, j.id); };
  try {
    const j = await send('FAKE:text-quota');
    assert.equal(j.status, 'failed', 'текст со словом quota при обычном сбое — failed: ' + JSON.stringify(j.status));
    assert.notEqual(j.retryKind, 'quota', 'квотой не помечено');
    // Контроль: провайдерский stderr «usage limit» → waiting_quota (как и было).
    const q = await send('FAKE:quota');
    assert.equal(q.status, 'waiting_quota', 'провайдерский признак → waiting_quota');
  } finally { try { await c.close(); } catch {} try { fs.rmSync(f.root, { recursive: true, force: true }); } catch {} }
});
KT('3 (интеграция) Kimi waiting_quota: доказательство на окно; после окна — failed, без автопродолжения', async () => {
  const h = require('./fake-kimi'); const f = h.setup(); f.active(); f.probe();
  const c = await h.client(f);
  try {
    let before = new Set(h.cards(f).map(j => j.id));
    let r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:quota', role: 'проверка' } });
    assert(!r.isError, h.text(r)); const id = h.cards(f).find(j => !before.has(j.id)).id;
    const j = await h.wait(f, id);
    assert.equal(j.status, 'waiting_quota'); assert.equal(j.retryKind, 'quota');
    assert.ok(Number.isFinite(Date.parse(j.lastQuotaAt)) && Date.parse(j.nextAttemptAt) > Date.now(), 'доказательство действует до конца окна (nextAttemptAt в будущем)');
    assert.equal(require('../common/team-seats').PENDING.includes('waiting_quota'), true, 'статус квоты учитывается как доказательство недоступности');
    // Истекло окно → очередь переводит в failed с ясной просьбой повторить (а не «ждёт автопродолжения»).
    const file = path.join(f.state, 'kimi-jobs', id, 'card.json');
    const card = JSON.parse(fs.readFileSync(file, 'utf8')); card.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(card, null, 2));
    // Любая новая отправка прогоняет очередь — она и подхватит истёкший waiting_quota.
    // team-v63 (п.5): force — отправка через действующую waiting_quota (иначе мост её не запустит и очередь не прогонит).
    await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task: 'FAKE:fail-code', role: 'проверка', force: true } });
    const end = Date.now() + 10000; let after;
    do { after = JSON.parse(fs.readFileSync(file, 'utf8')); if (after.status === 'failed') break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < end);
    assert.equal(after.status, 'failed', 'после окна карточка стала failed (без ложного автопродолжения)');
    assert.ok(/Окно закончилось|повторите/i.test(after.error || ''), 'в ответе — ясный ручной повтор: ' + after.error);
  } finally { try { await c.close(); } catch {} try { fs.rmSync(f.root, { recursive: true, force: true }); } catch {} }
});

(async () => {
  let passed = 0, failed = 0;
  for (const [n, f] of inProc) { try { await f(); console.log('OK ' + n); passed++; } catch (e) { console.log('FAIL ' + n + '\n' + (e.stack || e.message)); failed++; } }
  for (const [n, f] of kimiTests) { try { await f(); console.log('OK ' + n); passed++; } catch (e) { console.log('FAIL ' + n + '\n' + (e.stack || e.message)); failed++; } }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch {}
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  if (failed) process.exitCode = 1;
})();
