'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Team } = require('../../common/team'),
  { format } = require('../../common/format');
const server = new McpServer({ name: 'team', version: '0.5.9' }, require('../../common/server-instructions').options('team')),
  team = new Team();
const fromRegistry = fn => { try { const v = fn(); return Array.isArray(v) && v.length ? [...new Set(v)] : null; } catch { return null; } };
// Списки допустимых значений — ровно из реестра на момент старта; если реестр не читается,
// остаётся проверка по живому реестру, чтобы диагностика открывалась.
const list = (values, live, message) => values ? z.enum(values).describe(message) : z.string().refine(live, message);
const IDS = fromRegistry(() => require('../../common/members').knownIds);
const SEATS = fromRegistry(() => require('../../common/members').knownSeatIds);
const WORD_WHO = fromRegistry(() => [...require('../../common/members').knownSeatIds, ...require('../../common/members').knownFallbackIds, 'grok', 'claude']);
const AUTHORS = fromRegistry(() => [...require('../../common/members').knownVoterFamilies, 'xai']);
function register(name, title, description, inputSchema, fn) {
  if (!require('../../common/access').offered('team', name)) return;
  server.registerTool(name, { title, description, inputSchema: require('../../common/schema').compatible(inputSchema) }, async (a) => {
    try {
      // team-v62 (взгляд участников): обработчику нужно перенесённое состояние — дождёмся конца первичной миграции (с
      // пределом). initialize/tools/list сюда не попадают. По превышении — понятный текст с предложением повторить.
      const hold = await require('../../common/state-migration').awaitPrimary();
      if (hold) throw Error(hold);
      require('../../common/access').guard('team', name, a);
      // Один снимок и одна функция оболочки для измерения и отправки.
      const transport = require('../../common/public-transport');
      const current = require('../../common/request-context').context.getStore();
      if (name === 'team_status') transport.snapshot(current);
      const render = body => format('Команда', { status: 'done' }, body, 'Проверьте результат и выберите следующий шаг.');
      if (name === 'team_status' && !a.full) a.summaryBudget = 3000 - transport.decorate(render(''), current).length - 1;
      return {
        content: [
          {
            type: 'text',
            text: render(await fn(a)),
          },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: format(
              'Команда',
              { status: 'failed' },
              'Ошибка: ' + require('../../common/errors').errorText(e),
              'Исправьте причину и повторите запрос.',
            ),
          },
        ],
      };
    }
  });
}
register(
  'team_status',
  'Состояние команды',
  'Квоты, поручения, работы, правила и состояние развёртывания.',
  {
    full: z.boolean().optional().describe('Полная сводка; по умолчанию краткая.'),
    agy_model: z.string().optional().describe('Модель для новых поручений Antigravity; без метки — модель по умолчанию из источника квоты.'),
    notify_test: z.boolean().optional().describe('Показать пробное уведомление.'),
    claude_usage: z.object({ calls: z.number().nonnegative(), written: z.number().nonnegative(), reread: z.number().nonnegative(), window_h: z.number().positive(), taken_at: z.string(), source: z.string().min(1) }).optional().describe('Замер расхода сеанса Claude.'),
    claude_quota: z
      .object({
        percent: z.number().min(0).max(100).describe('Использованный процент.'),
        resets_at: z.string().optional().describe('Время сброса.'),
        source: z.string().min(1).describe('Источник снимка.'),
        taken_at: z.string().describe('Время снимка.'),
      })
      .optional(),
  },
  (a) => team.status(a.claude_quota, a.claude_usage, a.notify_test, a.full, a),
);
register(
  'team_rules',
  'Правила команды',
  'Получить правила из зафиксированной версии основной ветки.',
  { part: z.enum(['brief', 'common', 'claude', 'antigravity', 'grok', 'roles', 'fallback', 'all']).default('brief').describe('Часть правил.') },
  (a) => team.rules(a.part),
);
register('team_members', 'Участники связки', 'Список и управление реестром. Пауза Kimi действует в A/B/C; у остальных в A только отображается. add/remove требуют цитату пользователя.', {
  action: z.enum(['list', 'add', 'remove', 'pause', 'resume']),
  expected_rev: z.number().int().nonnegative().optional(),
  id: z.string().optional(), member: z.record(z.unknown()).optional(),
  quote: z.string().optional(), reason: z.string().optional(), until: z.string().optional(),
}, a => require('../../common/team-members').run(a));
register(
  'team_ask',
  'Спросить дирижёра',
  'Отправить запрос дирижёру (во входящие). Доступно гостям и поручениям; ответ — team_ask_result.',
  {
    text: z.string().min(1).describe('Текст запроса.'),
    refs: z.array(z.string()).optional().describe('Файлы только для справки.'),
    work: z.string().optional().describe('Связанная работа.'),
    ttl_min: z.number().int().positive().optional().describe('Срок в минутах; по умолчанию из поручения или 24 ч для чата.'),
  },
  async (a) => {
    const acc = require('../../common/access');
    if (!acc.guest()) throw Error('Запросы дирижёру отправляют гости и поручения, не сам дирижёр.');
    const inbox = require('../../common/inbox');
    const auth = inbox.author();
    if (auth.error) throw Error(auth.error);
    const id = require('crypto').randomUUID();
    inbox.save({
      id, at: new Date().toISOString(), status: 'open',
      text: a.text, refs: a.refs || [], work: a.work || null,
      author: auth.kind === 'job' ? { kind: 'job', id: auth.id, member: auth.job?.member, from: auth.job?.from } : { kind: 'chat', client: auth.client },
      deadline: inbox.askDeadline(a, auth),
    });
    inbox.notify(auth, a.text);
    return 'Запрос дирижёру ' + id + ' поставлен; ждите ответа через team_ask_result.';
  },
);
register(
  'team_ask_result',
  'Ответ дирижёра на запрос',
  'Получить состояние и ответ только своего запроса; чужой — «не найден».',
  {
    id: z.string().describe('Номер запроса.'),
    wait_sec: z.number().int().min(0).max(40).default(0).describe('Ожидание в секундах.'),
  },
  async ({ id, wait_sec }) => {
    const inbox = require('../../common/inbox');
    const auth = inbox.author();
    if (auth.error) throw Error(auth.error);
    const e = inbox.read(id);
    if (!e) return 'не найден';
    const same = auth.kind === 'job'
      ? e.author?.kind === 'job' && e.author.id === auth.id
      : e.author?.kind === 'chat' && e.author.client === auth.client;
    if (!same) return 'не найден';
    const end = Date.now() + wait_sec * 1000;
    let cur = e;
    while (cur.status === 'open' && Date.now() < end && !inbox.expired(cur)) {
      await new Promise(r => setTimeout(r, 100));
      cur = inbox.read(id);
    }
    if (cur.status === 'answered') return 'ответ: ' + cur.answer;
    if (cur.status === 'rejected') return 'отклонено: ' + (cur.reason || 'без причины');
    if (inbox.expired(cur)) return 'просрочен';
    return inbox.waitText(cur);
  },
);
register(
  'team_inbox',
  'Входящие дирижёру',
  'Список, ответ или отказ по запросам дирижёру. Доказанный чат любого участника связки.',
  {
    action: z.enum(['list', 'answer', 'reject']),
    id: z.string().optional().describe('Номер запроса (answer/reject).'),
    text: z.string().optional().describe('Ответ или причина отказа.'),
  },
  async (a) => {
    const acc = require('../../common/access');
    // team-v59: владелец управляет консилиумом из любого участника — входящие дирижёра доступны из ДОКАЗАННОГО чата любого
    // участника связки (прежде только клиент claude). Поручение и недоказанный сеанс — отказ (границу держит chatSession).
    if (!acc.chatSession()) throw Error('Входящие дирижёра доступны из доказанного чата участника связки.');
    const inbox = require('../../common/inbox');
    if (a.action === 'list') {
      const p = inbox.pending();
      return p.map(e => e.id + ' · ' + (e.work ? '[' + e.work + '] ' : '') + e.text.slice(0, 200) + ' · от ' + inbox.whoText(e.author) + ' · до ' + inbox.deadlineText(e)).join('\n') || 'Входящих нет.';
    }
    if (!a.id) throw Error('Нужен id запроса.');
    const e = inbox.read(a.id);
    if (!e) throw Error('Запрос не найден.');
    if (inbox.expired(e)) { e.status = 'rejected'; e.reason = 'просрочен'; inbox.save(e); return 'Запрос просрочен.'; }
    if (e.status !== 'open') throw Error('Запрос уже обработан.');
    if (a.action === 'answer') {
      if (!a.text) throw Error('Для ответа нужен text.');
      e.status = 'answered'; e.answer = a.text; e.answeredAt = new Date().toISOString(); inbox.save(e);
      return 'Ответ записан: ' + e.id;
    }
    e.status = 'rejected'; e.reason = a.text || ''; e.rejectedAt = new Date().toISOString(); inbox.save(e);
    return 'Запрос отклонён: ' + e.id;
  },
);
const stage = z.object({
  ...require('../../common/stage-schema').stage,
  title: z.string().min(1),
  weight: z.number().positive(),
  accept_criteria: z.string().min(1),
  closes: z.string().trim().min(1).optional().describe('Какой пункт запроса закрывает этап.'),
  state: z.enum(['план', 'идёт', 'принят', 'выдан без принятия']),
  evidence: z.string().optional(),
  version: z.string().optional(),
});
register(
  'team_work',
  'Работа и этапы',
  'Создать, прочитать или обновить работу с проверкой редакции. Процент растёт при принятии с доказательством.',
  {
    action: z.enum(['create', 'update', 'get', 'list', 'claim', 'close']),
    quote: z.string().optional().describe('close: слово пользователя дословно; закрыть оставшиеся этапы без принятия.'),
    title: z.string().trim().min(1).optional().describe('Русский заголовок работы.'),
    name: z.string().optional(),
    owner: z.string().trim().min(1).optional().describe('Метка сеанса владельца.'),
    expected_revision: z.number().int().nonnegative().optional().describe('Ожидаемая редакция; для создания 0.'),
    status_sent: z.boolean().optional().describe('Статус уже отправлен пользователю.'),
    folder: z.string().optional().describe('Необязательная абсолютная существующая папка материала работы; автоматически не подставляется, задаётся один раз.'),
    goal: z.string().optional(),
    done_criteria: z.string().optional(),
    stages: z.array(stage).optional(),
    next_step: z.string().optional(),
    plan_change: z.string().optional().describe('Пояснение изменения плана.'),
    reminders: z.array(z.string().min(1)).max(3).optional().describe('Идентификаторы напоминаний Claude.'),
    continue_stage: z.object({ id: z.string().min(1), author: z.object({ family: list(AUTHORS, v => [...require('../../common/members').voters({ external: true }).map(m => m.family), 'xai'].includes(v), 'Семья автора из team_status'), model: z.string().min(1) }),
      material: z.array(z.string()).optional() }).optional().describe('Запасной режим: этап-продолжение этапа Claude из снимка (rules/fallback.md).'),
  },
  (a) => team.work(a),
);
register(
  'team_change',
  'Изменение инструментария',
  'Участники и специализации — из team_status; обязательные голоса по прежнему кворуму, решение дирижёра; fast — малая правка с карточкой note; выпуск и откат.',
  {
    action: z.enum(['start', 'design', 'diff', 'precheck', 'commit', 'verdict', 'reconsider', 'merge', 'deploy', 'rollback', 'close', 'list', 'cleanup', 'grok_slot']),
    review_job_id: z.string().optional().describe('reconsider: поручение-подтверждение другой активной семьи (ПРИНЯТО на ту же пару, с номером исходного отказа и причиной в тексте).'),
    slot: list(SEATS, v => require('../../common/members').seatIds.includes(v), 'Место выпавшего из team_status').optional().describe('grok_slot: место выпавшего обязательного участника.'),
    phase: z.enum(['design', 'verdict']).optional().describe('grok_slot: замысел (design) или пара база→кандидат (verdict).'),
    apply: z.boolean().optional().describe('Уборка: удалить по-настоящему; без него — сухой прогон.'),
    cleanup: z.boolean().optional().describe('Установка: уборка после установки; по умолчанию да.'),
    fingerprint: z.string().optional().describe('Отпечаток кандидата из прогона тестов; commit откажет при несовпадении.'),
    title: z.string().trim().min(1).optional().describe('Русский заголовок изменения.'),
    unavailable: z.boolean().optional().describe('Записать проверенную недоступность моста Grok до создания поручения.'),
    name: z.string().optional(),
    owner: z.string().trim().min(1).optional().describe('Метка сеанса владельца.'),
    work: z.string().optional().describe('Связанная работа.'),
    request: z.string().min(20).optional().describe('Исходный запрос пользователя; обязателен для start.'),
    fast: z.boolean().default(false).describe('start: малая правка с карточкой note вместо замысла; границу проверяет сервер.'),
      design_file: z.string().optional().describe('Абсолютный путь замысла; обязателен для обычного start.'),
    note: z.string().optional().describe('Для start fast=true: симптом; что меняется; затронутые места; тест до/после; откат. Повтор start обновляет карточку и аннулирует принятия.'),
    restart_claude: z.boolean().default(false).describe('Перезапустить Claude после развёртывания.'),
    message: z.string().optional().describe('Сообщение коммита.'),
    from_char: z.number().int().nonnegative().default(0),
    who: list(IDS && [...IDS, 'grok', 'user'], v => [...require('../../common/members').ids, 'grok', 'user'].includes(v), 'Участник из team_status').optional(),
    base: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    candidate: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    job_id: z.string().optional(),
    decision: z.enum(['ПРИНЯТО', 'НЕ ПРИНЯТО', 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ']).optional(),
    replaces: list(IDS && [...IDS, 'all'], v => v === 'all' || require('../../common/members').ids.includes(v), 'Участник из team_status или all').optional().describe('Чьё место: замена Claude после двух отказов; решение владельца словом (replaces=<участник>|claude|all закрывает место(а)); Grok на месте выпавшего (по grok_slot).'),
    quote: z.string().optional().describe('Цитата слова пользователя; для reconsider — причина отклонения отказа дирижёром; для deploy — слово пользователя, перекрывающее проверку перед установкой (вместе с list_hash); для commit/merge — слово владельца: проходят без ворот замысла и без голосов (риск называется, цитата хранится в карточке).'),
    list_hash: z.string().optional().describe('deploy: отпечаток показанного списка установки из первого отказа (sha256). Передаётся вместе с quote; при изменении состояния сервер отвечает новым списком и слово нужно дать заново.'),
    commit: z.string().optional().describe('Принятый коммит или main.'),
  },
  (a) => team.change(a),
);
register(
  'team_word',
  'Слово пользователя',
  'Записать дословно слово пользователя «X отвалился» или показать записи. stop_confirm подтверждает остановку по job_ids и quote только из чата Claude в основном режиме. close закрывает карточки «нужно решение» словом пользователя (только чат Claude в основном режиме; изменения в папке поручения не откатываются). release_orphan снимает замок записи без карточки по точным lock_instance/job_ids/folder (только чат Claude в основном режиме, при отсутствии карточки и мёртвом владельце). Слово о помощнике — чат Claude; слово о Claude — чат Codex или Antigravity (запасной режим, rules/fallback.md); правок и удалений нет.',
  {
    action: z.enum(['record', 'list', 'return', 'handover', 'rebind', 'stop_confirm', 'close', 'release_orphan']),
    who_down: list(WORD_WHO, v => [...require('../../common/members').ids, 'grok'].includes(v), 'Выпавший из team_status').optional().describe('Кого пользователь назвал выпавшим.'),
    quote: z.string().optional().describe('Реплика пользователя дословно.'),
    job_ids: z.array(z.string().min(8)).min(1).optional().describe('stop_confirm, close и release_orphan: полные номера поручений или однозначные префиксы от 8 знаков (release_orphan — ровно один).'),
    owner: z.string().optional().describe('Метка сеанса дирижёра запасного режима (fallback-codex-<4 буквы>).'),
    lock_instance: z.string().optional().describe('release_orphan: точный instance осиротевшего замка записи из team_status/диагностики.'),
    folder: z.string().optional().describe('release_orphan: абсолютная папка осиротевшего замка записи.'),
    admission: z.string().optional().describe('release_orphan: идентификатор admission, если известен (необязательно).'),
  },
  (a) => team.word(a),
);
register(
  'team_scenario',
  'Сценарий (мост сам ведёт цикл)',
  'Запустить/вести многоходовый сценарий: мост сам шлёт поручения и по ответу «крючка» (внешней команды владельца) решает, что дальше — без участия чата. start | status | stop | list | resume. Крючок запускается с правами пользователя (риск называется в ответе start).',
  {
    action: z.enum(['start', 'status', 'stop', 'list', 'resume']),
    scenario_file: z.string().optional().describe('start: абсолютный путь JSON-файла сценария (рядом — крючок; cwd = папка сценария).'),
    hook: z.object({ interp: z.string(), script: z.string() }).optional().describe('start: крючок { interp, script } абсолютными путями, если не задан в файле сценария.'),
    parallel: z.number().int().positive().optional().describe('start: предел одновременных поручений (по умолчанию без предела).'),
    id: z.string().optional().describe('status/stop/resume: номер сценария.'),
  },
  (a) => require('../../common/scenario-manager').command(a),
);
if (require.main === module) {
  // team-v63 (п.18): взводим барьер первичной миграции СИНХРОННО до server.connect — чтобы вызов инструмента, пришедший
  // между connect() и .then(start()), не проскочил мимо барьера (started ещё не выставлен в start()).
  try { require('../../common/state-migration').arm(); } catch {}
  // team-v62 (task4): server.connect ПЕРВЫМ — ответ на initialize/tools/list не ждёт миграцию, чтение реестра и уборку
  // меток перезапуска. Прежде эти три шага шли ДО connect, и общий замок миграции держал подключение: поздние серверы
  // моста не попадали в первый проход привязки приложения и их инструменты появлялись минутами позже.
  server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()))
    .then(() => require('../../common/access').ready('team'))
    // team-v59 (task2): происхождение чата вычисляем в ФОНЕ после connect (не блокируя initialize/tools/list); первый guard
    // при незавершённом фоне посчитает синхронно. Фон не держит обработку инструментов.
    .then(() => { try { require('../../common/chat-origin').primeAsync(); } catch {} })
    // team-v62 (task4): миграция хранилища, чтение реестра участников и уборка меток перезапуска — в ФОНЕ после connect.
    .then(() => {
      require('../../common/state-migration').start(require('../../common/paths'))
        .then(() => { if (!require('../../common/access').guest() && process.env.MOST_PROBE_ONLY !== '1') {
          try { require('../../common/members').store().read(); } catch (e) { console.error(e.message); }
        } })
        .then(() => require('../../common/restart-hold').cleanup(require('../../common/paths').stateDir))
        .catch((e) => console.error(e));
    })
    // team-v10 Р5: новый сервер после установки с перезапуском сам выполняет уборку.
    .then(() => { setTimeout(() => team.afterDeploy(600000).catch(() => {}), 5000).unref(); })
    // team-v59 (часть 3, дополнение 2): авто-уборка конечных карточек старше недели — в фоне, после ответа на initialize,
    // не задерживая инструменты, не чаще раза в сутки. Проба установки записей не трогает.
    // team-v62 (взгляд участников): уборки читают перенесённое состояние (карточки, отметки процессов) — запускаем их
    // только ПОСЛЕ завершения первичной миграции (waitPrimary; при неприменимой миграции — сразу).
    .then(() => { if (process.env.MOST_PROBE_ONLY !== '1') setTimeout(() => { require('../../common/state-migration').waitPrimary().then(() => {
      try { require('../../common/cards-autocleanup').maybeRun({ stateDir: require('../../common/paths').stateDir, repoRoot: require('../../common/paths').repoRoot }); } catch {}
      // team-v61 (п.12): уборка устаревших отметок процессов (restart-servers/<pid>.json|.watch, ready/<server>.<pid>.json)
      // мёртвых процессов старше суток — в фоне, не на пути ответа сводки, не чаще раза в сутки.
      // team-v61 (часть 3): maybeRun асинхронна (снимок процессов через execFile, не блокируя событийный цикл) — .catch,
      // чтобы отклонённое обещание фоновой уборки не всплывало необработанным.
      try { require('../../common/restart-mark-cleanup').maybeRun({ stateDir: require('../../common/paths').stateDir }).catch(() => {}); } catch {}
      // team-v63 (п.4): незавершённые сценарии поднимаются сами с последнего шага (оборванные поручения шага переотправляются).
      try { if (!require('../../common/access').guest()) require('../../common/scenario-manager').resumeAll(require('../../common/paths').stateDir); } catch {}
    }); }, 7000).unref(); }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { server };
