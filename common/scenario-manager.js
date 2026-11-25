'use strict';
// team-v63 (п.4): управление сценариями поверх движка common/scenario.js. Держит идущие циклы (drive) в памяти сервера team,
// поднимает незавершённые сценарии при старте сервера (оборванные поручения шага переотправляются тем же ключом), разводит
// действия инструмента team_scenario (start | status | stop | list | resume) и строит производственный «раннер» поручений.
const scenario = require('./scenario');

const active = new Map(); // id → { stop:boolean, runner, done:Promise, hookChild }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ───────── Производственный раннер: НАСТОЯЩИЙ путь отправки для ВСЕХ участников ─────────
// team-v63 (А): подделки гостевых карточек больше нет. Раннер шлёт поручения тем же кодом, что инструмент *_send — через
// дочерние MCP-подключения к серверам участников ЭТОГО выпуска (common/scenario-senders). Поэтому поручение проходит все
// проверки, замки, профили, сеансы, вложения files/level/continue_id, отметку лимита и учёт объёма. Раннер опрашивает
// НАСТОЯЩУЮ карточку участника на диске; происхождение помечается scenario/scenarioKey/scenarioBy.
function productionDeps(stateDir, S, by) {
  return {
    runner: require('./scenario-senders').senderRunner(stateDir, S),
    // team-v63 (п.6): onChild даёт ведущему циклу ссылку на процесс крючка, чтобы stop снял его дерево процессов.
    invokeHook: (St, payload, onChild) => scenario.spawnHook(St, payload, { onChild }),
    now: () => Date.now(), nowIso: scenario.nowIso, sleep,
    tickMs: Number(process.env.MOST_SCENARIO_TICK_MS || 500),
    by,
  };
}

// Запуск цикла в фоне (не блокирует ответ инструмента). Переживает отдельные сбои тика. Возвращает промис завершения цикла.
// team-v63 (п.7): повторный launch того же id не плодит второй цикл — возвращает промис уже идущего (resume дожидается его).
// team-v63 (Б2): ЗАМОК берётся ДО любой записи состояния. Подготовка (prep: repend / перевод в running) идёт ТОЛЬКО под
// замком — процесс без замка состояние не трогает. Сбой взятия замка — сценарий НЕ ведётся «без замка»: ошибка записана
// (видна в status/list), цикл не идёт.
function launch(stateDir, id, deps, opts = {}) {
  if (active.has(id)) return active.get(id).done;
  const token = { stop: false, runner: deps.runner, hookChild: null };
  let resolveDone; token.done = new Promise(r => (resolveDone = r));
  // Ведущему циклу подменяем invokeHook (перехват процесса крючка для снятия дерева по stop) и даём проверку остановки
  // (token.stop) — её движок передаёт раннеру прямо перед отправкой (Б1).
  const driveDeps = { ...deps, stopped: () => token.stop,
    invokeHook: (St, payload) => deps.invokeHook(St, payload, child => { token.hookChild = child; }) };
  active.set(id, token);
  (async () => {
    // team-v63 (п.8): межпроцессный замок владельца сценария. Один сервер team ведёт цикл, остальные (другие экземпляры на том
    // же состоянии) не трогают. Замок — named-pipe с признаком живого владельца: после смерти владельца пайп закрывается и
    // сценарий поднимет другой сервер.
    let lock = null;
    try { lock = await require('./locks').tryLock('scenario', id, { scenario: id }, stateDir); }
    catch (e) {
      // Б2: сбой взятия замка — НЕ ведём без замка. Ошибку записываем на сценарий (видна в status/list) и выходим.
      active.delete(id);
      try { const S = scenario.loadState(stateDir, id); S.error = 'замок сценария: ' + e.message; scenario.saveState(stateDir, S); } catch {}
      try { await deps.runner.close?.(); } catch {}
      resolveDone(); return;
    }
    if (!lock.ok) { active.delete(id); try { await deps.runner.close?.(); } catch {} resolveDone(); return; } // другой живой владелец
    try {
      // Б2: подготовка состояния — под замком, ДО первого тика. Не взяли замок — сюда не дошли, состояние не тронуто.
      if (opts.prep) { const S = scenario.loadState(stateDir, id); opts.prep(S); scenario.saveState(stateDir, S); }
      while (!token.stop) {
        const S = await scenario.tick(stateDir, id, driveDeps);
        if (S.status !== 'running') break;
        const hasRunning = Object.values(S.jobs || {}).some(j => ['running', 'sending'].includes(j.status));
        await deps.sleep(hasRunning ? (deps.tickMs ?? 500) : 20);
      }
    } catch (e) {
      try { const S = scenario.loadState(stateDir, id); if (S.status === 'running') { S.status = 'failed'; S.error = 'цикл: ' + e.message; scenario.saveState(stateDir, S); } } catch {}
    } finally {
      active.delete(id);
      try { await deps.runner.close?.(); } catch {}
      if (lock && lock.ok) { try { await lock.release(); } catch {} }
      resolveDone();
    }
  })();
  return token.done;
}

// team-v63 (п.9/Б6): подъём оборванных поручений шага. Идущие И отправляемые (running/sending) → снова pending с сохранёнными
// member/requestId и пометкой resuming. dispatch переотправит ТОМУ ЖЕ участнику тем же request_id (повтор admission вернёт
// прежнюю карточку: готово — возьмём; идёт и жив владелец — дождёмся; отменена при stop / осиротела — pollRound повторит тому
// же участнику НОВОЙ попыткой). Единый путь и для crash-restart (resumeAll), и для resume после stop: конечную карточку прежней
// попытки распознаёт poll по состоянию/владельцу, а не догадка менеджера (прежний fresh:true плодил второе поручение — Б7).
function repend(S) {
  for (const j of Object.values(S.jobs || {})) if (j.status === 'running' || j.status === 'sending') {
    j.status = 'pending';
    if (j.member && j.requestId) { j.resume = true; j.resuming = true; }
    else { j.resume = false; j.jobId = null; j.attempts = (j.attempts || 0) + 1; }
  }
}

// ───────── Действия инструмента team_scenario ─────────
// quota-622: resume сценария, вставшего на паузу «нет денег», — это слово пользователя (счёт пополнен): шаг, ждавший
// участника, идёт одной попыткой в обход отметки (force). Не пополнен — отказ провайдера снова поставит на паузу.
function unpauseBalance(S) {
  for (const j of Object.values(S.jobs || {})) if (j.balancePaused) { j.balancePaused = false; j.forceOnce = true; }
  delete S.pauseReason;
}
function requireChat() {
  const acc = require('./access');
  // Права: start/stop/resume — любой доказанный чат (или дирижёр). Поручение-исполнитель (гость, но не чат) — отказ.
  if (!acc.chatSession() && acc.guest()) throw Error('Сценарии запускает и ведёт доказанный чат участника связки, не поручение-исполнитель.');
}

async function command(a, opts = {}) {
  const stateDir = opts.stateDir || require('./paths').stateDir;
  const action = a.action;
  if (['start', 'stop', 'resume'].includes(action)) requireChat();
  if (action === 'list') {
    const ids = scenario.listIds(stateDir);
    if (!ids.length) return 'Сценариев нет.';
    return ids.map(id => { try { return scenario.statusLine(scenario.loadState(stateDir, id)); } catch (e) { return id + ': ошибка чтения (' + e.message + ')'; } }).join('\n');
  }
  if (action === 'status') {
    const id = scenario.assertId(a.id); // team-v63 (п.13): та же проверка id, что в create (без `..\..`).
    return scenario.statusLine(scenario.loadState(stateDir, id));
  }
  if (action === 'start') {
    // team-v63 (А): происхождение — доказанный чат, запустивший сценарий (в карточках поручений scenarioBy).
    let by; try { by = require('./access').client(); } catch {}
    const S = scenario.create(stateDir, { scenarioFile: a.scenario_file, hook: a.hook, parallel: a.parallel, by });
    launch(stateDir, S.id, opts.deps || productionDeps(stateDir, S, by));
    return 'Сценарий ' + S.id + ' запущен. РИСК: ' + scenario.riskLine(S) + '\n' + scenario.statusLine(S) + '\nСостояние: ' + scenario.dirOf(stateDir, S.id);
  }
  if (action === 'stop') {
    const id = scenario.assertId(a.id);
    const token = active.get(id);
    // team-v63 (Б1/DeepSeek-2): остановка СНАЧАЛА пишет на диск `stopped` (и взводит token.stop), ПОТОМ отменяет. Так гвард
    // отправки (notStopped: token.stop или диск) перекрывает уже начатую отправку, а не теряет поручение во время await-отмены.
    if (token) { token.stop = true; if (token.hookChild) { try { scenario.killTree(token.hookChild); } catch {} } }
    let S0; try { S0 = scenario.loadState(stateDir, id); } catch { return 'Сценарий ' + id + ' не найден.'; }
    if (['done', 'failed'].includes(S0.status)) return 'Сценарий ' + id + ' уже ' + S0.status + '.\n' + scenario.statusLine(S0);
    S0.status = 'stopped'; scenario.saveState(stateDir, S0);
    // Б1: дождаться выхода цикла тика ЭТОГО процесса (его раннер закроется в finally), затем ПЕРЕЧИТАТЬ состояние. Снимок до
    // ожидания для записи/отмены не используем — после ожидания на диске актуальные jobId/requestId (в т.ч. успевшие 'running').
    if (token) { try { await token.done; } catch {} }
    const S = scenario.loadState(stateDir, id);
    // Отменяем все поручения шага, у которых есть jobId или requestId (в т.ч. 'sending' — по requestId находим карточку).
    const toCancel = Object.values(S.jobs || {}).filter(j => (j.jobId || j.requestId) && ['running', 'sending', 'pending'].includes(j.status));
    // Б1/п.5: отмену делает ВЫЗВАВШИЙ процесс через собственный раннер (создать — отменить — закрыть); раннер цикла уже закрыт.
    let runner = opts.deps && opts.deps.runner, ownRunner = false;
    if (!runner && toCancel.length) { runner = productionDeps(stateDir, S, S.by).runner; ownRunner = true; }
    const unconfirmed = [];
    if (runner) for (const j of toCancel) {
      const spec = j.jobId || { member: j.member, requestId: j.requestId };
      let res; try { res = await runner.cancel(spec, j.member); } catch {}
      if (res && res.confirmed === false) unconfirmed.push((res.id || j.jobId || j.requestId) + ' (' + j.member + ')');
    }
    if (ownRunner) { try { await runner.close?.(); } catch {} }
    // Ответ честен: «отменены» — только если отмены вызваны и подтверждены; иначе называем, что не подтверждено.
    const tail = unconfirmed.length
      ? 'остановлен; отмена НЕ подтверждена: ' + unconfirmed.join(', ') + ' — возможен двойной расход.'
      : 'остановлен (идущие поручения отменены).';
    return 'Сценарий ' + id + ' ' + tail + '\n' + scenario.statusLine(scenario.loadState(stateDir, id));
  }
  if (action === 'resume') {
    const id = scenario.assertId(a.id);
    const S = scenario.loadState(stateDir, id);
    if (S.status === 'done') return 'Сценарий ' + id + ' уже завершён.';
    // team-v63 (Б7): если сценарий уже ведётся (этот процесс ведёт — есть token; или жив внешний владелец замка) — ответ
    // «уже идёт», НИЧЕГО не меняем (без новой попытки/записи).
    if (active.has(id)) return 'Сценарий ' + id + ' уже идёт.\n' + scenario.statusLine(S);
    if (S.status === 'running') {
      let probe = null; try { probe = await require('./locks').tryLock('scenario', id, { scenario: id }, stateDir); } catch { probe = null; }
      if (probe && !probe.ok) return 'Сценарий ' + id + ' уже идёт (ведёт другой сервер).\n' + scenario.statusLine(S);
      if (probe && probe.ok) { try { await probe.release(); } catch {} } // свободен → прежний владелец мёртв, поднимаем
    }
    // stopped (или running без живого владельца): поднимаем. Подготовка (repend + running) — ТОЛЬКО под замком внутри launch
    // (Б2). repend переотправляет тем же request_id; конечную карточку прежней попытки (отменена/осиротела) распознаёт poll и
    // повторяет ТОМУ ЖЕ участнику новой попыткой — fresh наугад больше не ставим (Б7).
    let by; try { by = require('./access').client(); } catch {}
    launch(stateDir, id, opts.deps || productionDeps(stateDir, S, by), { prep: St => { repend(St); unpauseBalance(St); St.status = 'running'; delete St.error; delete St.warnings; } });
    return 'Сценарий ' + id + ' возобновлён.\n' + scenario.statusLine(scenario.loadState(stateDir, id));
  }
  throw Error('Неизвестное действие сценария: ' + action);
}

// Подъём незавершённых сценариев при старте сервера team. team-v63 (п.15): ошибки подъёма НЕ роняют процесс и НЕ теряются —
// они записываются на сценарий (S.error, видно в team_scenario status/list и в краткой сводке) и возвращаются списком.
function resumeAll(stateDir = require('./paths').stateDir) {
  const errors = [];
  for (const id of scenario.listIds(stateDir)) {
    try {
      let S; try { S = scenario.loadState(stateDir, id); } catch (e) { errors.push(id + ': не прочитан (' + e.message + ')'); continue; }
      if (S.status !== 'running') continue;
      // team-v63 (Б2): repend/запись — под замком внутри launch (prep). Без замка состояние НЕ трогаем.
      launch(stateDir, id, productionDeps(stateDir, S, S.by), { prep: St => repend(St) });
    } catch (e) {
      errors.push(id + ': ' + e.message);
      try { const S = scenario.loadState(stateDir, id); S.error = 'подъём: ' + e.message; scenario.saveState(stateDir, S); } catch {}
      try { console.error('Сценарии: подъём ' + id + ' не удался: ' + e.message); } catch {}
    }
  }
  return errors;
}

module.exports = { command, resumeAll, launch, productionDeps, repend, unpauseBalance, active };
