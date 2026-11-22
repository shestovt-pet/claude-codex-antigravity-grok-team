'use strict';
// team-v59, часть 4: мост САМ выбирает модель и уровень рассуждения по задаче — для ЛЮБОГО чата (не только дирижёра-Claude).
// До v58 раскладка «модель и уровень по задаче» жила только текстом в правилах для дирижёра (rules/claude.md «Модели по
// задачам», rules/brief.md «Модель по задаче»), и её исполнял Claude, называя model/effort в каждом поручении. После v58
// поручать может любой чат (Kimi/Codex/Antigravity/DeepSeek); если он не называет модель, прежде бралась модель по умолчанию
// приложения (из чата Kimi «сколько будет 2+2» ушло в Antigravity на Gemini 4 Neon High). Поэтому выбор обязан делать мост.
//
// Здесь — единая таблица «участник × класс задачи → модель и уровень». Значения взяты из ДЕЙСТВУЮЩИХ правил клона
// (rules/claude.md, rules/brief.md) и замера docs/model-bench-2026-11.md; моделей не выдумываем. Класс задачи определяет
// САМ мост по признакам поручения (роль, режим Antigravity, запись/полный доступ, размер материала, «простой вопрос»).
// Вызывающий класс не называет. Если вызывающий назвал model и/или effort — таблица НЕ применяется (слово вызывающего и
// владельца сильнее таблицы). Эскалация (подъём по правилам) здесь НЕ делается — только начальный выбор (task4 п.4).

// Короткий вопрос считается «простым» (самая дешёвая/быстрая конфигурация участника), если в нём нет материала и записи.
const SIMPLE_TASK_CHARS = 200;

// team-v61 (DeepSeek №2): даже короткое поручение с ЯВНОЙ просьбой написать/исправить код, скрипт, функцию, тест,
// регулярку, SQL и т.п. — не «простой вопрос» (дешёвая конфигурация ему не подходит). Требуются ОБА признака: глагол-
// действие над кодом И предмет из кода — чтобы «сколько будет 2+2», «напиши стих», «ответь на запрос» остались simple.
// team-v61 (часть 3, Gemini): границы кириллических слов задаём ЯВНЫМИ классами символов, а не \b — в JS RegExp граница
// слова \b опознаётся только у ASCII [A-Za-z0-9_], а кириллица для неё «не-слово», поэтому «метод\b» и «\bбаг\b» не ловили
// «напиши метод», «проверь метод», «почини баг» (слово перед пробелом/знаком/концом строки). Класс-слово = [а-яёa-z0-9_]
// (с /i покрывает оба регистра и латиницу); лукахед/лукбехайнд хранят прежний смысл «ровно это слово» (не «методология»,
// не «багаж»). Кириллические приставки без \b (напиш/функци/регуляр/парсер…) работали и работают как подстроки — их не трогаем.
const CODE_VERB = /(напиш|напис|исправ|поправ|почин|перепиш|допиш|доработ|реализ|отрефактор|отладь|отлад|сверст|refactor|implement|debug|\bfix\b|\bwrite\b|\bcode\b)/i;
const CODE_NOUN = /(код|скрипт|функци|метод(?![а-яёa-z0-9_])|класс|юнит|тест|регуляр|regexp?|\bsql\b|sql[ -]?запрос|патч|\bdiff\b|(?<![а-яёa-z0-9_])баг(?![а-яёa-z0-9_])|\bbug\b|парсер|script|function|method|class|unit test|query)/i;
function codeRequest(task) { const t = String(task || ''); return CODE_VERB.test(t) && CODE_NOUN.test(t); }

// team-v61 (п.10): ревью КОДА (mode=review/zamechaniya или role=проверка) над файлом-кодом/дифом или с текстом поручения про
// код — сильная конфигурация проверки (review_high → у Antigravity gemini-4-hydrogen-high), а не самая дешёвая low. Признак:
// расширение приложенного файла/справки (.diff/.patch/.js/.ts/.py и т.п.) ИЛИ код-тема в тексте поручения.
const CODE_FILE = /\.(diff|patch|js|mjs|cjs|ts|tsx|jsx|py|pyi|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|sql|sh|ps1|psm1|bash|swift|scala|lua|pl|pm|r|m|vue|svelte|json|ya?ml|toml)$/i;
function codeReview(a = {}) {
  const files = [a.file, a.fayl, ...(Array.isArray(a.refs) ? a.refs : []), ...(Array.isArray(a.opora) ? a.opora : []),
    ...(Array.isArray(a.material) ? a.material.map(m => typeof m === 'string' ? m : m && (m.path || m.file)) : [])].filter(v => typeof v === 'string');
  if (files.some(f => CODE_FILE.test(f.trim()))) return true;
  const task = String(a.task || a.poruchenie || '');
  return codeRequest(task) || CODE_NOUN.test(task) || /(диф|дифф|\bdiff\b|патч|\bpatch\b|рефактор|стек[ -]?трейс|traceback|компил|линтер|lint)/i.test(task);
}

// Классы задач (общий набор; у каждого участника — своя строка таблицы):
//  simple      — простой вопрос: короткий task, без материала и без записи → самая дешёвая/быстрая конфигурация.
//  read        — чтение/пересказ больших материалов.
//  review      — проверка/голос на этапах «мелочь»/«обычный».
//  review_high — ревью замысла/кандидата изменения связки, голос на «высоком» этапе, консилиум по решению.
//  text        — литературный текст / суждение о стиле (Antigravity → модель текста из правил).
//  write       — запись/правка (write) → сильная конфигурация.
//  run         — запуск названных программ (full_access без суждения) → дешёвый уровень.
const CLASSES = ['simple', 'read', 'advice', 'review', 'review_high', 'review_code', 'text', 'write', 'run'];

const CODEX_SOL = 'gpt-6.2-sol';
const CODEX_ASTRA = 'gpt-6.2-astra';
const DEEPSEEK_FLASH = 'deepseek-flash';
const DEEPSEEK_PRO = 'deepseek-v4-pro';
const KIMI_MODEL = require('./kimi-launch').DEFAULT;

// Таблица: участник → класс → { model, effort }. У Antigravity уровень в id модели, у DeepSeek отдельного effort нет.
const TABLE = {
  // Antigravity: уровень вшит в id модели, отдельный effort не передаётся.
  antigravity: {
    simple:      { model: 'gemini-4-hydrogen-low' },   // rules: чтение/проверки «мелочь»/«обычный» — hydrogen-low (на наборах все уровни Hydrogen точны, low самый быстрый)
    read:        { model: 'gemini-4-hydrogen-low' },   // rules: чтение и пересказ материалов — hydrogen-low
    review:      { model: 'gemini-4-hydrogen-low' },   // rules: проверки и голос «мелочь»/«обычный» — hydrogen-low
    review_high: { model: 'gemini-4-hydrogen-high' },  // rules: ревью замысла/кандидата, «высокий», консилиум — hydrogen-high
    // team-v63 (п.б): ревью КОДА/дифа — neon-low (замер 20.11.2026 на diff v60 с 6 настоящими ошибками: neon-low нашёл 3/6 за
    // 56 с, hydrogen-high — 1/6 за 100 с; старшие уровни находят столько же, но в 2–9 раз дольше). Если neon-low нет в списке
    // моделей аккаунта на момент выбора — прежний выбор hydrogen-high (fallback), без отказа. Для прочих участников класс кода
    // отдельно выделен только у Codex.
    review_code: { model: 'gemini-4-neon-low', fallback: 'gemini-4-hydrogen-high' },
    text:        { model: 'gemini-4-argon-high' },     // rules/brief: текст и стиль — argon-high (слепое сравнение пользователя 14.11.2026)
    write:       { model: 'gemini-4-hydrogen-high' },  // правка содержимого — сильнее обычного чтения
    run:         { model: 'gemini-4-hydrogen-low' },
  },
  codex: {
    simple:      { model: CODEX_SOL, effort: 'low' },
    read:        { model: CODEX_SOL, effort: 'high' },
    review:      { model: CODEX_SOL, effort: 'high' },
    review_code: { model: CODEX_SOL, effort: 'high' },
    review_high: { model: CODEX_ASTRA, effort: 'high' },
    text:        { model: CODEX_SOL, effort: 'high' },
    write:       { model: CODEX_SOL, effort: 'high' },
    run:         { model: CODEX_SOL, effort: 'medium' },
  },
  // Профиль DeepSeek задаёт права, а модель по умолчанию одинакова для всех профилей.
  deepseek: {
    simple:      { model: DEEPSEEK_FLASH },
    read:        { model: DEEPSEEK_FLASH },
    review:      { model: DEEPSEEK_FLASH },
    review_high: { model: DEEPSEEK_FLASH },
    text:        { model: DEEPSEEK_FLASH },
    write:       { model: DEEPSEEK_FLASH },
    run:         { model: DEEPSEEK_FLASH },
  },
  kimi: {
    simple:      { model: KIMI_MODEL, effort: 'low' },
    read:        { model: KIMI_MODEL, effort: 'low' },
    advice:      { model: KIMI_MODEL, effort: 'high' },
    review:      { model: KIMI_MODEL, effort: 'max' },
    review_high: { model: KIMI_MODEL, effort: 'max' },
    text:        { model: KIMI_MODEL, effort: 'high' },
    write:       { model: KIMI_MODEL, effort: 'high' },
    run:         { model: KIMI_MODEL, effort: 'high' },
  },
};

// team-v63 (п.3): прямой уровень модели по поручению. Параметр *_send `level`: fast | normal | strong — задаёт уровень, не
// меняя роль и права. Таблица «участник × уровень → модель и уровень» рядом с классами. Без `level` поведение прежнее;
// явная модель или уровень рассуждения могут переопределить выбор на стороне адаптера.
const LEVELS = {
  codex: {
    fast: { model: CODEX_SOL, effort: 'medium' },
    normal: { model: CODEX_SOL, effort: 'high' },
    strong: { model: CODEX_ASTRA, effort: 'high' },
  },
  antigravity: { // уровень вшит в id модели
    fast: { model: 'gemini-4-hydrogen-low' },
    normal: { model: 'gemini-4-hydrogen-high' },
    strong: { model: 'gemini-4-hydrogen-high' },
  },
  deepseek: {
    fast: { model: DEEPSEEK_FLASH },
    normal: { model: DEEPSEEK_FLASH },
    strong: { model: DEEPSEEK_PRO },
  },
  kimi: {
    fast: { model: KIMI_MODEL, effort: 'low' },
    normal: { model: KIMI_MODEL, effort: 'high' },
    strong: { model: KIMI_MODEL, effort: 'max' },
  },
};
const LEVEL_NAMES = ['fast', 'normal', 'strong'];
function levelOf(a) { return LEVEL_NAMES.includes(a.level) ? a.level : null; }

// Признак команды запуска в полном доступе. Упоминание кода в том же поручении выбор не меняет.
const PROGRAM_RUN = /(?:^|[.!?;:\r\n]|\s(?:затем|потом|и|then|and)\s+)\s*(?:запусти(?:те|ть)?|прогони(?:те)?|собери(?:те)?(?=\s+(?:выпуск|релиз|проект))|выполни(?:те|ть)?(?=\s+(?:команд[уы]|скрипт|сценарий|программу|тесты|[`"«]|(?:npm|node|git|py|python|pwsh|powershell)(?:\s|$)|\w+(?:\.exe|\.cmd|\.ps1)))|run|execute)(?=$|[^\p{L}\p{N}_])/iu;

// Высокий риск/этап: уровень работы «высокий», или кандидат изменения связки (replaces/replacementEvidence). Прямой уровень
// модели (fast/normal/strong) сюда НЕ попадает — он не про риск этапа (значения не пересекаются с «высокий»).
function isHigh(a) {
  const lvl = a.workLevel || a.stageLevel || (a.level !== undefined && !LEVEL_NAMES.includes(a.level) ? a.level : null);
  if (lvl === 'высокий') return true;
  if (a.replaces || a.replacementEvidence) return true;
  return false;
}

// Класс задачи по признакам поручения (без участия вызывающего). a — аргументы *_send (у Antigravity поля иные: poruchenie/rezhim/fayl/opora).
function classify(participant, a = {}) {
  const role = a.role;
  const full = a.full_access === true || a.fullAccess === true;
  const mode = a.rezhim || a.mode;                       // Antigravity: pravka | zamechaniya | tekst
  const task = String(a.task || a.poruchenie || '').trim();
  const hasMaterial = !!(a.text || a.file || a.fayl || (Array.isArray(a.material) && a.material.length) ||
    (Array.isArray(a.opora) && a.opora.length) || (Array.isArray(a.refs) && a.refs.length) || a.continue_id ||
    (['codex', 'kimi'].includes(participant) && Array.isArray(a.files) && a.files.length));
  const high = isHigh(a);
  if (participant === 'codex' && full && PROGRAM_RUN.test(task)) return 'run';
  if (a.write === true) return 'write';
  if (full) return 'run';
  // Явная роль сильнее эвристики «простого вопроса»: литературный текст/стиль — всегда text, проверка/голос — review.
  if (role === 'текст') return 'text';
  if (role === 'проверка' || mode === 'zamechaniya') {
    if (participant === 'codex') {
      // changeReview заполняет сервер по карточке team_change. Для старых вызовов распознаём метку и хеш в тексте.
      if (high || a.changeReview || /#[a-f0-9]{8}\b/i.test(task) && /\b(?:[a-f0-9]{12}|[a-f0-9]{40}|[a-f0-9]{64})\b/i.test(task)) return 'review_high';
      const files = Array.isArray(a.files) ? a.files.map(f => typeof f === 'string' ? f : f?.path) : [];
      return codeReview(a) || files.some(f => CODE_FILE.test(String(f || ''))) ? 'review_code' : 'review';
    }
    return (high || codeReview(a)) ? 'review_high' : 'review';
  }
  // team-v59 (DeepSeek №1): режим pravka у Antigravity — правка СОДЕРЖИМОГО файла; это запись, сильная конфигурация (write),
  // а не дешёвое чтение. Без этой ветки правка с файлом проваливалась в hasMaterial→'read' (hydrogen-low), строка write была
  // недостижима. Явная роль «текст»/«проверка» выше по приоритету (литературная правка/голос сохраняют свой класс).
  if (mode === 'pravka') return 'write';
  if (participant === 'kimi' && /^(?:посоветуй|дай совет|порекомендуй|предложи|разбери)(?:[\s,.!?]|$)/i.test(task)) return 'advice';
  // Простой короткий вопрос без материала и без явной роли — дешёвая конфигурация, ДАЖЕ в режиме text у Antigravity
  // (иначе «2+2» без файла в режиме text ушёл бы на argon — именно это и жаловался владелец).
  if (task.length > 0 && task.length <= SIMPLE_TASK_CHARS && !hasMaterial && !high && !codeRequest(task)) return 'simple';
  if (mode === 'tekst') return 'text';                         // режим text Antigravity с содержательным заданием — литературный текст
  if (participant === 'kimi') return hasMaterial ? 'read' : 'advice';
  if (hasMaterial) return high ? 'review_high' : 'read';
  return high ? 'review_high' : 'review';
}

// Выбор моста. Если вызывающий назвал model и/или effort — named=true, таблица не применяется. Возвращает выбранную строку
// и класс; применение к аргументам — у сервера (model/effort подставляются только когда named=false).
function choose(participant, a = {}) {
  const named = a.model !== undefined && a.model !== null || a.effort !== undefined && a.effort !== null;
  const lvl = levelOf(a);
  // team-v63 (п.3): прямой уровень сильнее класса, но слабее явной model/effort.
  if (!named && lvl) {
    const row = (LEVELS[participant] || {})[lvl] || {};
    return { participant, class: 'уровень ' + lvl, level: lvl, byLevel: true, model: row.model ?? null, effort: row.effort ?? null, named };
  }
  let cls = classify(participant, a);
  let row = (TABLE[participant] || {})[cls] || (TABLE[participant] || {}).review || {};
  // team-v63 (п.б): у Antigravity ревью КОДА/дифа (review_high, полученный из-за code-файла/код-темы) — neon-low, а не
  // hydrogen-high. Срабатывает только когда класс уже review_high И поручение — ревью кода; нелитературный высокий этап без
  // кода остаётся hydrogen-high. Прочие участники не затронуты (у них отдельного класса кода нет).
  if (participant === 'antigravity' && cls === 'review_high' && codeReview(a) && TABLE.antigravity.review_code) {
    cls = 'review_code';
    row = TABLE.antigravity.review_code;
  }
  return { participant, class: cls, model: row.model ?? null, effort: row.effort ?? null, fallback: row.fallback ?? null, named };
}

// Строка для карточки и ответа *_send.
function line(participant, chosen, named = chosen.named, namedModel, namedEffort) {
  if (named) {
    const what = [namedModel, namedEffort].filter(Boolean).join(' ') || 'по поручению';
    return 'модель и уровень: ' + what + ' — названо в поручении';
  }
  const what = [chosen.model, chosen.effort].filter(Boolean).join(' ') || 'по умолчанию участника';
  if (chosen.byLevel) return 'модель и уровень: ' + what + ' — уровень задан поручением (' + chosen.level + ')';
  return 'модель и уровень: ' + what + ' — выбрал мост (класс: ' + chosen.class + ')';
}

module.exports = { choose, classify, line, codeRequest, codeReview, TABLE, CLASSES, SIMPLE_TASK_CHARS, LEVELS, LEVEL_NAMES, levelOf };
