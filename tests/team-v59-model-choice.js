'use strict';
// team-v59 часть 4 (task4): мост САМ выбирает модель и уровень по задаче — для любого чата (common/model-choice.js).
//  - простой вопрос каждому участнику → дешёвая конфигурация;
//  - проверка/голос → по таблице; литературный текст Antigravity → модель текста;
//  - явно названная модель/уровень не подменяются;
//  - выбор попадает в аргументы запуска адаптера (как их строит сервер) и в строку карточки/ответа.
const assert = require('assert');
const mc = require('../common/model-choice');
const tests = [];
const T = (n, f) => tests.push([n, f]);

// (1) Простой короткий вопрос без материала и записи → самая дешёвая/быстрая конфигурация участника.
T('простой вопрос каждому участнику → дешёвая конфигурация', () => {
  const q = { task: 'сколько будет 2+2' };
  assert.deepEqual(pick(mc.choose('antigravity', { ...q, rezhim: 'tekst' })), { class: 'simple', model: 'gemini-4-hydrogen-low', effort: null });
  assert.deepEqual(pick(mc.choose('codex', q)), { class: 'simple', model: 'gpt-6.2-sol', effort: 'low' });
  assert.deepEqual(pick(mc.choose('deepseek', { ...q, role: 'совет' })), { class: 'simple', model: 'deepseek-flash', effort: null });
  assert.deepEqual(pick(mc.choose('kimi', { ...q, role: 'совет' })), { class: 'simple', model: 'kimi-code/k3.1-pro-highspeed', effort: 'low' });
});

// (2) Проверка/голос → по таблице (обычный этап). Высокий этап НЕ-кода поднимает Antigravity до hydrogen-high.
// team-v61 (п.10): ревью НЕ-кода (прозаический текст/ответ, без код-файла и без код-темы) остаётся обычным review (low у
// Antigravity). team-v63 (п.б): ревью КОДА/дифа у Antigravity теперь neon-low (замер 20.11.2026) — отдельно в
// tests/team-v61-night.js и tests/team-v63-scenario.js.
T('проверка/голос не-кода → по таблице; высокий этап не-кода поднимает Antigravity', () => {
  assert.equal(mc.choose('antigravity', { poruchenie: 'дай замечания по тексту рассказа', rezhim: 'zamechaniya' }).model, 'gemini-4-hydrogen-low');
  assert.equal(mc.choose('antigravity', { poruchenie: 'ревью кандидата замысла', rezhim: 'zamechaniya', fayl: 'замысел.md', level: 'высокий' }).model, 'gemini-4-hydrogen-high');
  assert.deepEqual(pick(mc.choose('codex', { task: 'оцени ответ помощника', role: 'проверка' })), { class: 'review', model: 'gpt-6.2-sol', effort: 'high' });
  assert.equal(mc.choose('deepseek', { task: 'голос', role: 'проверка' }).model, 'deepseek-flash');
});

T('Codex — чтение, запись кода, запуск программ, ревью кода и голос по изменению связки', () => {
  const review = { task: 'проверь патч', role: 'проверка' };
  const cases = [
    [{ task: 'прочитай', files: ['report.md'] }, 'read', 'gpt-6.2-sol', 'high'],
    [{ task: 'запусти тесты', write: true, full_access: true }, 'run', 'gpt-6.2-sol', 'medium'],
    [{ task: 'Исправь код и запусти тесты', role: 'текст', write: true, full_access: true }, 'run', 'gpt-6.2-sol', 'medium'],
    [{ task: 'Выполни `npm test` после того, как исправишь код', role: 'совет', write: true, full_access: true }, 'run', 'gpt-6.2-sol', 'medium'],
    [{ task: 'Проверь правку кода. Выполни node tests/run.js', role: 'совет', write: true, full_access: true }, 'run', 'gpt-6.2-sol', 'medium'],
    [{ task: 'Запусти тесты для правки кода', write: true }, 'write', 'gpt-6.2-sol', 'high'],
    [{ task: 'Сохрани материалы отчёта', role: 'совет', write: true, full_access: true }, 'write', 'gpt-6.2-sol', 'high'],
    [{ task: 'подготовь отчёт', role: 'текст', write: true, full_access: true }, 'write', 'gpt-6.2-sol', 'high'],
    [{ task: 'напиши тесты', write: true, full_access: true }, 'write', 'gpt-6.2-sol', 'high'],
    [review, 'review_code', 'gpt-6.2-sol', 'high'],
    [{ ...review, stageLevel: 'высокий' }, 'review_high', 'gpt-6.2-astra', 'high'],
    [{ ...review, task: 'Голос #a1234567 ' + 'b'.repeat(40) }, 'review_high', 'gpt-6.2-astra', 'high'],
  ];
  for (const [args, cls, model, effort] of cases) assert.deepEqual(pick(mc.choose('codex', args)), { class: cls, model, effort });
});

T('Kimi — чтение low, совет с материалом high, проверка max', () => {
  const material = { role: 'совет', files: ['report.md'] };
  assert.equal(mc.choose('kimi', { ...material, task: 'Прочитай отчёт' }).effort, 'low');
  assert.equal(mc.choose('kimi', { ...material, task: 'Предложи правки' }).effort, 'high');
  assert.equal(mc.choose('kimi', { ...material, role: 'проверка', task: 'Оцени отчёт' }).effort, 'max');
});

// (2b) team-v59 (DeepSeek №1): правка СОДЕРЖИМОГО файла (rezhim=pravka) — класс write (hydrogen-high), а не дешёвое чтение.
T('Antigravity rezhim=pravka → write (hydrogen-high), не read/hydrogen-low', () => {
  const c = mc.choose('antigravity', { poruchenie: 'исправь функцию в файле', rezhim: 'pravka', fayl: 'x.js' });
  assert.equal(c.class, 'write'); assert.equal(c.model, 'gemini-4-hydrogen-high');
  // Короткое поручение (меньше 200 знаков) правку в simple не превращает — это запись, а не «простой вопрос».
  assert.equal(mc.classify('antigravity', { poruchenie: 'почини', rezhim: 'pravka', fayl: 'x.js' }), 'write');
});

// (3) Литературный текст Antigravity → модель текста (argon-high), даже коротким поручением, если роль «текст» или режим text с содержанием.
T('литературный текст Antigravity → модель текста (argon-high)', () => {
  assert.equal(mc.choose('antigravity', { poruchenie: 'напиши рассказ про осень', role: 'текст', rezhim: 'tekst' }).model, 'gemini-4-argon-high');
  // Содержательное (длинное) поручение в режиме text без явной роли — тоже литературный текст (длиннее «простого вопроса»).
  assert.equal(mc.choose('antigravity', { poruchenie: 'сочини развёрнутый лирический текст о зимнем утре: образность, настроение, ритм прозы; не меньше страницы; избегай штампов, держи единый тон и внутреннюю логику образа от первой до последней фразы, чтобы читалось как цельный отрывок', rezhim: 'tekst' }).class, 'text');
  assert.deepEqual(pick(mc.choose('codex', { task: 'напиши текст', role: 'текст' })), { class: 'text', model: 'gpt-6.2-sol', effort: 'high' });
});

// (4) Явно названная модель/уровень НЕ подменяются (слово вызывающего сильнее таблицы).
T('явно названные модель/уровень не подменяются', () => {
  const c = mc.choose('codex', { task: 'x', model: 'gpt-6-luna', effort: 'high' });
  assert.equal(c.named, true, 'named=true при явной модели');
  // Строка карточки показывает, что модель названа в поручении, а не выбрана мостом.
  assert.match(mc.line('codex', c, true, 'gpt-6-luna', 'high'), /названо в поручении/);
  assert.match(mc.line('codex', c, true, 'gpt-6-luna', 'high'), /gpt-6-luna high/);
  const a = mc.choose('antigravity', { poruchenie: 'y', model: 'gemini-4-argon-high' });
  assert.equal(a.named, true);
});

// (5) Выбор попадает в аргументы запуска адаптера: Codex строит -m/-c из job.model/effort, как в servers/codex/index.js.
T('выбор моста попадает в аргументы Codex (-m / model_reasoning_effort) и в строку карточки', () => {
  const chosen = mc.choose('codex', { task: 'сколько будет 2+2' });
  const job = { model: chosen.model, effort: chosen.effort };
  // Воспроизводим построение аргументов из servers/codex/index.js.
  const args = ['-a', 'never', 'exec'];
  if (job.model !== undefined) args.push('-m', job.model);
  if (job.effort !== undefined) args.push('-c', 'model_reasoning_effort="' + job.effort + '"');
  assert(args.includes('-m') && args.includes('gpt-6.2-sol'), 'модель в -m: ' + args.join(' '));
  assert(args.some(x => x === 'model_reasoning_effort="low"'), 'уровень в -c: ' + args.join(' '));
  const line = mc.line('codex', chosen);
  assert.match(line, /выбрал мост/);
  assert.match(line, /класс: simple/);
  assert.match(line, /gpt-6\.2-sol low/);
});

// (6) Antigravity: выбор доходит до --model (не остаётся моделью по умолчанию приложения). Когда модель не названа,
//     сервер подставляет chosen.model в переменную model, из которой строится --model (baseArgs.push("--model", m.id)).
T('выбор Antigravity доходит до --model', () => {
  const chosen = mc.choose('antigravity', { task: 'сколько будет 2+2', rezhim: 'tekst' });
  let model; // не названа
  if (model === undefined || model === null) model = chosen.model;
  const baseArgs = [];
  const m = { id: model || null };
  if (m.id) baseArgs.push('--model', m.id);
  assert(baseArgs.includes('--model') && baseArgs.includes('gemini-4-hydrogen-low'), 'модель в --model: ' + baseArgs.join(' '));
});

function pick(c) { return { class: c.class, model: c.model, effort: c.effort }; }

run();
async function run() {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('OK ' + n); }
    catch (e) { failed++; console.error('FAIL ' + n + '\n' + (e.stack || e.message)); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
