'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Team } = require('../../common/team'),
  { format } = require('../../common/format');
const server = new McpServer({ name: 'team', version: '0.5.9' }, require('../../common/server-instructions').options('team')),
  team = new Team();
function register(name, title, description, inputSchema, fn) {
  if (!require('../../common/access').allowed('team', name)) return;
  server.registerTool(name, { title, description, inputSchema: require('../../common/schema').compatible(inputSchema) }, async (a) => {
    try {
      require('../../common/access').guard('team', name, a);
      return {
        content: [
          {
            type: 'text',
            text: format('Команда', { status: 'done' }, await fn(a), 'Проверьте результат и выберите следующий шаг.'),
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
  { part: z.enum(['brief', 'common', 'claude', 'antigravity', 'grok', 'roles', 'all']).default('brief').describe('Часть правил.') },
  (a) => team.rules(a.part),
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
  },
  (a) => team.work(a),
);
register(
  'team_change',
  'Изменение инструментария',
  'Команда четырёх: обязательные голоса Codex и Antigravity, решение Claude, совещательный Grok; выпуск и откат.',
  {
    action: z.enum(['start', 'design', 'diff', 'precheck', 'commit', 'verdict', 'merge', 'deploy', 'rollback', 'close', 'list', 'cleanup']),
    apply: z.boolean().optional().describe('Уборка: удалить по-настоящему; без него — сухой прогон.'),
    cleanup: z.boolean().optional().describe('Установка: уборка после установки; по умолчанию да.'),
    fingerprint: z.string().optional().describe('Отпечаток кандидата из прогона тестов; commit откажет при несовпадении.'),
    title: z.string().trim().min(1).optional().describe('Русский заголовок изменения.'),
    unavailable: z.boolean().optional().describe('Записать проверенную недоступность моста Grok до создания поручения.'),
    name: z.string().optional(),
    owner: z.string().trim().min(1).optional().describe('Метка сеанса владельца.'),
    work: z.string().optional().describe('Связанная работа.'),
    request: z.string().min(20).optional().describe('Исходный запрос пользователя; обязателен для start.'),
    design_file: z.string().optional().describe('Абсолютный путь замысла; обязателен для start.'),
    note: z.string().optional().describe('Пояснение по фактам.'),
    restart_claude: z.boolean().default(false).describe('Перезапустить Claude после развёртывания.'),
    message: z.string().optional().describe('Сообщение коммита.'),
    from_char: z.number().int().nonnegative().default(0),
    who: z.enum(['claude', 'codex', 'antigravity', 'grok', 'user']).optional(),
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
    replaces: z.enum(['claude', 'codex', 'antigravity']).optional(),
    quote: z.string().optional(),
    commit: z.string().optional().describe('Принятый коммит или main.'),
  },
  (a) => team.change(a),
);
if (require.main === module)
  require('../../common/state-migration').start(require('../../common/paths'))
    .then(() => server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()))).then(() => require('../../common/access').ready('team'))
    // team-v10 Р5: новый сервер после установки с перезапуском сам выполняет уборку.
    .then(() => { setTimeout(() => team.afterDeploy(600000).catch(() => {}), 5000).unref(); }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = { server };
