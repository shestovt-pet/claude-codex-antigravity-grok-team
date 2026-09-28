'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  { randomUUID } = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { stateDir, canon } = require('../../common/paths'),
  locks = require('../../common/locks');
const { format } = require('../../common/format');
const { classifyCodex, retryPlan, codexQuota, quotaText, command } = require('../../common/quota');
const { readCard, logFailure, guarded } = require('../../common/cards');
const access = require('../../common/access');
const VERSION = '0.5.6',
  dir = path.resolve(process.env.MOST_CODEX_JOBS_DIR || path.join(stateDir, 'codex-jobs'));
const archive =
  process.env.MOST_CODEX_ARCHIVE_DIR ||
  path.join(os.homedir(), 'Documents', 'Codex', '2026-09-26', 'new-chat', 'outputs', 'claude-codex', 'jobs');
fs.mkdirSync(dir, { recursive: true });
const active = new Map(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let closing = false,
  scanning = false;
function findCli() {
  if (process.env.CODEX_PATH) return fs.existsSync(process.env.CODEX_PATH) ? process.env.CODEX_PATH : null;
  try {
    return execFileSync(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [process.platform === 'win32' ? 'codex.exe' : 'codex'],
      { encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split(/\r?\n/)[0];
  } catch {}
  try {
    const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    return fs
      .readdirSync(root)
      .map((n) => path.join(root, n, 'codex.exe'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}
const binary = findCli();
function file(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('Некорректный номер поручения.');
  const bundle = path.join(dir, id, 'card.json');
  return fs.existsSync(bundle) ? bundle : path.join(dir, id + '.json');
}

function save(j) {
  const p = file(j.id),
    tmp = p + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(j, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, p);
        break;
      } catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function load(id) {
  try {
    const job = readCard(file(id));
    if (job.resultFile) job.resultFile = require('../../common/team-store').resultPath(job, dir);
    return job;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    return { ...readCard(path.join(archive, id + '.json')), archived: true };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  throw Object.assign(Error('Поручение не найдено.'), { code: 'ENOENT' });
}

function list() {
  return require('../../common/team-store').list('codex', false).jobs;
}

async function mutate(id, fn) {
  const l = await locks.waitLock('codex_job', id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка занята.');
  try {
    const j = load(id);
    if (j.archived) throw Error('Архив доступен только для чтения.');
    const before = { ...j };
    if ((await fn(j)) !== false) { save(j); require('../../common/notify').transition('Codex', before, j); }
    return j;
  } finally {
    await l.release();
  }
}

async function normalized(id) {
  let j = load(id);
  if (access.guest()) return j;
  if (
    !j.archived &&
    ['running', 'cancelling', 'stop_unconfirmed'].includes(j.status) &&
    (await locks.ownerState(j.owner)) === 'dead'
  )
    j = await mutate(id, async (c) => {
      if (
        !['running', 'cancelling', 'stop_unconfirmed'].includes(c.status) ||
        (await locks.ownerState(c.owner)) !== 'dead'
      )
        return false;
      c.status = c.write ? 'needs_decision' : 'lost';
      c.error = 'Владелец завершился. Проверьте частичный результат; остановка исполнителя не подтверждена.';
      c.stopUnconfirmed = { pid: c.childPid };
    });
  return j;
}

function reply(j, body, next = 'Проверьте результат.', error = false) {
  return { content: [{ type: 'text', text: format('Codex', j, body, next) }], ...(error ? { isError: true } : {}) };
}

function view(j, offset = 0) {
  let body = j.error || '';
  if (j.status === 'queued') body = access.queued;
  if (j.archived) {
    body = 'Архивное поручение (только чтение).\n' + body;
    if (['running', 'interrupted'].includes(j.status)) j = { ...j, status: 'lost' };
  }
  if (j.status === 'done' && (!j.resultFile || !fs.existsSync(j.resultFile)))
    throw Error('Файл подтверждённого результата недоступен.');
  if (j.resultFile && fs.existsSync(j.resultFile)) {
    const s = fs.readFileSync(j.resultFile, 'utf8');
    body += '\n' + s.slice(offset, offset + 24000);
    if (offset + 24000 < s.length)
      return reply(j, body, 'Вызовите codex_result: id ' + j.id + ', from_char ' + (offset + 24000) + '.');
  }
  if (j.status === 'waiting_quota')
    body += '\nСледующая проба: ' + j.nextAttemptAt + '; попыток: ' + (j.quotaAttempts || 0) + '.';
  return reply(
    j,
    body,
    j.status === 'needs_decision'
      ? 'Проверьте изменения и решите, продолжать ли через continue_id.'
      : j.status === 'running'
        ? 'Запросите codex_result с id ' + j.id + '.'
        : j.status === 'waiting_quota'
          ? 'Дождитесь квоты или отмените поручение.'
          : 'Проверьте результат.',
  );
}

async function execute(job, folderLock) {
  const execution = await locks.tryLock('codex_execution', job.id, { jobId: job.id });
  if (!execution.ok) {
    if (folderLock) await folderLock.release();
    throw Error('Поручение уже выполняется.');
  }
  let child,
    buffer = '',
    errors = '',
    completed = false,
    failure = null,
    done = false,
    timer,
    poll;
  function line(s) {
    try {
      const e = JSON.parse(s);
      if (e.type === 'thread.started') {
        job.threadId = e.thread_id;
        mutate(job.id, (c) => {
          c.threadId = e.thread_id;
        }).catch(logFailure);
      }
      if (e.type === 'turn.completed') completed = true;
      const f = classifyCodex(e);
      if (f.kind !== 'none') failure = f;
    } catch {}
  }
  async function finish(code, error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (buffer.trim()) line(buffer);
    if (!failure && (error || code !== 0)) {
      const f = classifyCodex({ type: 'error', error: { message: error || errors } });
      if (f.kind !== 'none') failure = f;
    }
    try {
      await mutate(job.id, (c) => {
        c.threadId = job.threadId;
        c.finishedAt = new Date().toISOString();
        c.exitCode = code;
        if (c.status === 'cancelling') {
          c.status = c.stopReason === 'cancel' ? 'cancelled' : c.write ? 'needs_decision' : 'failed';
          c.error =
            c.stopReason === 'timeout'
              ? 'Истёк предел времени. Проверьте частичный результат.'
              : c.stopReason === 'shutdown'
                ? 'Сервер остановлен. Проверьте частичный результат.'
                : 'Выполнение остановлено. Уже внесённые изменения сохраняются.';
        } else if (failure?.kind === 'quota') {
          Object.assign(c, retryPlan(c, failure));
          if (!c.write && !c.threadId) {
            c.status = 'failed';
            c.error = 'Квота исчерпана, но threadId не получен; автоматическое продолжение невозможно.';
          }
        } else if (!error && code === 0 && completed && !failure && fs.existsSync(c.resultFile)) {
          c.status = 'done';
          delete c.error;
        } else {
          c.status = c.write ? 'needs_decision' : 'failed';
          c.error =
            'Codex не завершил поручение: ' + (error || failure?.message || errors || 'нет подтверждённого результата');
        }
        if (!c.treeWarning) delete c.stopUnconfirmed;
      });
    } finally {
      active.delete(job.id);
      await execution.release();
      if (sessionLock?.ok) await sessionLock.release();
      if (folderLock) await folderLock.release();
    }
  }
  let sessionLock = null;
  if (job.threadId) {
    sessionLock = await locks.tryLock('codex_session', job.threadId, { jobId: job.id });
    if (!sessionLock.ok) {
      await finish(null, 'Этот сеанс уже продолжается другим поручением.');
      return;
    }
  }
  const args = ['-a', 'never', '-s', job.write ? 'workspace-write' : 'read-only', 'exec'];
  if (job.threadId) args.push('resume');
  else args.push('--cd', job.folder, '--color', 'never');
  job.resultFile = path.join(path.dirname(file(job.id)),
    job.id + '.attempt-' + (job.quotaAttempts || 0) + '.result.txt');
  args.push('--skip-git-repo-check', '--json', '--output-last-message', job.resultFile);
  if (job.threadId) args.push(job.threadId);
  args.push('-');
  try {
    await mutate(job.id, (c) => {
      c.resultFile = job.resultFile;
    });
    const c = command(binary, args);
    child = spawn(c.bin, c.args, {
      cwd: job.folder,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.set(job.id, { child, job });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on(
      'data',
      guarded((d) => {
        buffer += d;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          line(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      }),
    );
    child.stderr.on(
      'data',
      guarded((d) => (errors = (errors + d).slice(-6000))),
    );
    child.stdin.on('error', () => {});
    child.on(
      'error',
      guarded((e) => finish(null, e.message)),
    );
    child.on(
      'close',
      guarded((code) => finish(code)),
    );
    await mutate(job.id, (c) => {
      c.childPid = child.pid;
    });
    if (done) return;
    timer = setTimeout(
      guarded(() => stop(job.id, 'timeout')),
      Number(process.env.MOST_CODEX_TIMEOUT_MS || 3600000),
    );
    poll = setInterval(
      guarded(function pollJob() {
        const j = load(job.id);
        if (j.status === 'cancelling') stop(job.id).catch(logFailure);
        else if (job.threadId && j.threadId !== job.threadId)
          mutate(job.id, (c) => {
            c.threadId = job.threadId;
          }).catch(logFailure);
      }),
      200,
    );
    child.stdin.end(
      [
        'Это отдельное поручение пользователя через Claude. Не считай, что знаешь другие чаты.',
        job.write
          ? 'Изменения разрешены только в рамках поручения. Перечисли файлы и проверки.'
          : 'Только чтение. Не изменяй файлы.',
        'Не обходи ограничения. Отвечай по-русски.',
        job.task,
        job.textFile ? 'Материал в файле: ' + job.textFile : '',
      ].join('\n'),
    );
  } catch (e) {
    await finish(null, e.message);
  }
}

async function stop(id, reason = 'cancel') {
  const e = active.get(id);
  if (!e || e.stopping) return;
  e.stopping = true;
  let requested = false;
  try {
    await mutate(id, (c) => {
      if (!['running', 'cancelling', 'stop_unconfirmed'].includes(c.status)) return false;
      c.status = 'cancelling';
      c.stopReason = reason;
      requested = true;
    });
  } catch (error) {
    e.stopping = false;
    throw error;
  }
  if (!requested) {
    e.stopping = false;
    return;
  }
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill.exe', ['/PID', String(e.child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10000,
        stdio: 'pipe',
      });
    else process.kill(-e.child.pid, 'SIGKILL');
  } catch (err) {
    await mutate(id, (c) => {
      c.treeWarning = 'Остановка дерева процессов не подтверждена: ' + err.message;
      c.stopUnconfirmed = { pid: e.child.pid };
    });
    try {
      e.child.kill('SIGKILL');
    } catch {}
  }
  setTimeout(
    guarded(() => {
      if (active.has(id))
        mutate(id, (c) => {
          c.status = 'stop_unconfirmed';
          c.stopUnconfirmed = { pid: e.child.pid };
        }).catch(logFailure);
    }),
    3000,
  ).unref();
}

async function send(a) {
  access.guard('codex', 'codex_send', a);
  if (!binary && !access.guest()) throw Error('Исполнитель Codex не найден. Укажите CODEX_PATH.');
  if (closing) throw Error('Сервер останавливается.');
  if (!path.isAbsolute(a.folder) || !fs.statSync(a.folder).isDirectory())
    throw Error('Нужна абсолютная существующая папка.');
  if (a.work && !a.stage) throw Error('Для работы укажите этап.');
  const folder = fs.realpathSync(a.folder),
    id = randomUUID();
  let prior = null,
    priorLock = null,
    folderLock = null;
  try {
    if (a.continue_id) {
      priorLock = await locks.tryLock('codex_queue', a.continue_id, { jobId: id });
      if (!priorLock.ok) throw Error('Предыдущее поручение возобновляется.');
      prior = await normalized(a.continue_id);
      if (
        prior.archived ||
        !['done', 'waiting_quota', 'failed', 'needs_decision'].includes(prior.status) ||
        !prior.threadId ||
        prior.stopUnconfirmed
      )
        throw Error('Продолжение недоступно: нужен сеанс с threadId и подтверждённой остановкой.');
      if (canon(prior.folder) !== canon(folder) || prior.write !== a.write)
        throw Error('Сохраните папку и режим записи предыдущего поручения.');
    }
    if (a.write) {
      folderLock = await locks.tryLock('codex_folder', canon(folder), { jobId: id });
      if (!folderLock.ok) throw Error('В этой папке уже идёт поручение с записью.');
      for (const old of list()) {
        if (old.write && old.folder && fs.existsSync(old.folder) && canon(old.folder) === canon(folder)) {
          const current = await normalized(old.id);
          if (current.stopUnconfirmed)
            throw Error(
              'В этой папке есть поручение с неподтверждённой остановкой. Проверьте исполнителя перед новой записью.',
            );
        }
      }
    }
    const job = {
      id,
      folder,
      write: a.write,
      task: a.task,
      stage: a.stage,
      work: a.work,
      from: access.client(),
      status: access.guest() ? 'queued' : 'running',
      startedAt: new Date().toISOString(),
      owner: access.guest() ? null : locks.owner(),
      threadId: prior?.threadId || null,
      previous: prior?.id || null,
      quotaAttempts: 0,
    };
    if (a.text !== undefined) {
      job.textFile = path.join(dir, id + '.input.txt');
      fs.writeFileSync(job.textFile, a.text);
    }
    save(job);
    if (prior?.status === 'waiting_quota')
      await mutate(prior.id, (c) => {
        if (c.status === 'waiting_quota') {
          c.status = 'cancelled';
          c.error = 'Ожидание заменено явным продолжением ' + id;
        }
      });
    if (access.guest()) return reply(job, access.queued);
    execute(job, folderLock).catch(logFailure);
    folderLock = null;
    return view(job);
  } finally {
    if (priorLock?.ok) await priorLock.release();
    if (folderLock?.ok) await folderLock.release();
  }
}

async function queue() {
  if (access.guest() || !binary || scanning || closing) return;
  scanning = true;
  try {
    await require('../../common/progress').longRunning('Codex', list(), mutate);
    for (const j of list()) {
      if (!['queued', 'waiting_quota'].includes(j.status) || j.write || Date.parse(j.nextAttemptAt) > Date.now()) continue;
      if (j.status !== 'queued' && !['self', 'dead'].includes(await locks.ownerState(j.owner))) continue;
      const l = await locks.tryLock('codex_queue', j.id, { jobId: j.id });
      if (!l.ok) continue;
      try {
        let claimed = false;
        const c = await mutate(j.id, (c) => {
          if (!['queued', 'waiting_quota'].includes(c.status) || Date.parse(c.nextAttemptAt) > Date.now()) return false;
          c.status = 'running';
          c.owner = locks.owner();
          if (c.retryKind === 'quota' && !c.knownReset) c.quotaAttempts = (c.quotaAttempts || 0) + 1;
          delete c.finishedAt;
          claimed = true;
        });
        if (claimed) await execute(c, null);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      } finally {
        await l.release();
      }
    }
  } finally {
    scanning = false;
  }
}
const server = new McpServer({ name: 'codex', version: VERSION });
function register(name, title, description, inputSchema, fn) {
  if (!access.allowed('codex', name)) return;
  server.registerTool(name, { title, description, inputSchema: require('../../common/schema').compatible(inputSchema) }, async (a) => {
    try {
      access.guard('codex', name, a);
      return name === 'codex_send'
        ? await require('../../common/work-owner').withWork(a, () => fn(a)) : await fn(a);
    } catch (e) {
      let j = { id: a.id, status: 'failed' };
      try {
        if (a.id) j = { ...load(a.id), status: 'failed' };
      } catch {}
      return reply(j, 'Ошибка: ' + require('../../common/errors').errorText(e), 'Исправьте причину и повторите запрос.', true);
    }
  });
}
register(
  'codex_send',
  'Поручить Codex',
  'Начать отдельное поручение или явно продолжить сеанс.',
  {
    folder: z.string().describe('Абсолютная папка проекта.'),
    task: z.string().min(1).describe('Поручение.'),
    text: z.string().optional().describe('Материал для работы.'),
    write: z.boolean().default(false).describe('Разрешить изменения по поручению.'),
    continue_id: z.string().optional().describe('Номер предыдущего поручения.'),
    stage: z.string().optional().describe('Этап.'),
    owner: z.string().optional().describe('Метка сеанса владельца работы.'),
    work: z.string().optional().describe('Работа.'),
  },
  send,
);
register(
  'codex_result',
  'Результат Codex',
  'Получить состояние и ответ, при необходимости частями.',
  {
    id: z.string().describe('Номер поручения.'),
    wait_sec: z.number().int().min(0).max(40).default(0).describe('Ожидание в секундах.'),
    from_char: z.number().int().min(0).default(0).describe('Начальный символ.'),
  },
  async ({ id, wait_sec, from_char }) => {
    const end = Date.now() + wait_sec * 1000;
    let j = await normalized(id);
    while (j.status === 'running' && Date.now() < end) {
      await sleep(100);
      j = await normalized(id);
    }
    return view(j, from_char);
  },
);
register(
  'codex_cancel',
  'Отменить Codex',
  'Остановить поручение или отменить ожидание квоты.',
  { id: z.string().describe('Номер поручения.') },
  async ({ id }) => {
    const j = await mutate(id, (c) => {
      if (['waiting_quota', 'queued'].includes(c.status)) {
        c.status = 'cancelled';
        c.finishedAt = new Date().toISOString();
      } else if (c.status === 'running') c.status = 'cancelling';
    });
    if (active.has(id)) await stop(id);
    return view(j);
  },
);
register(
  'codex_status',
  'Состояние Codex',
  'Проверить версии, поручения и квоты с источником и временем снимка.',
  {},
  async () => {
    const rows = [];
    for (const j of list()) {
      try {
        const c = await normalized(j.id);
        if (['queued', 'running', 'waiting_quota', 'needs_decision', 'cancelling', 'stop_unconfirmed', 'lost'].includes(c.status))
          rows.push(format('Codex', c, c.error || '', 'Запросите результат.'));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const q = binary ? await codexQuota(binary) : { source: 'данные не предоставлены' };
    return reply(
      { status: 'done' },
      'Версия процесса: ' +
        VERSION +
        '; на диске: ' +
        JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version +
        '\nCodex: ' +
        (binary || 'не найден') +
        '\n' +
        (rows.join('\n') || 'Идущих и ожидающих поручений нет.') + '\n' +
        await require('../../common/quota-line').quotaLine({ codex: q }),
      'Выберите поручение или начните новое.',
    );
  },
);
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.all([...active.keys()].map((id) => stop(id, 'shutdown').catch(logFailure)));
  const end = Date.now() + 5000;
  while (active.size && Date.now() < end) await sleep(100);
  process.exit(0);
}

(async () => {
  await require('../../common/state-migration').start(require('../../common/paths'));
  const owner = await locks.startOwner({ version: VERSION, file: __filename });
  if (!owner.ok) throw Error('Не удалось открыть канал владельца.');
  process.stdin.on('end', guarded(shutdown));
  process.on('SIGINT', guarded(shutdown));
  process.on('SIGTERM', guarded(shutdown));
  server.server.onclose = guarded(shutdown);
  await server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()));
  access.ready('codex');
  if (!access.guest() && process.env.MOST_PROBE_ONLY !== '1') {
    await queue().catch(logFailure);
    setInterval(guarded(queue), Math.min(30000, Number(process.env.MOST_QUEUE_TICK_MS || 1000))).unref();
  }
})().catch((e) => {
  logFailure(e);
  process.exit(1);
});
