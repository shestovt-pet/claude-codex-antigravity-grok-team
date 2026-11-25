'use strict';
// team-v63 (А): исполнитель сценариев шлёт поручения НАСТОЯЩИМ путём — тем же кодом, что инструмент *_send, для ВСЕХ
// участников (codex, deepseek, kimi, antigravity, claude). Подделки гостевых карточек больше нет: сервер team держит
// дочерние MCP-подключения к серверам участников ЭТОГО выпуска (process.execPath servers/<member>/index.js) в контексте
// дирижёра (не гость), поэтому их *_send проходит все проверки, замки, профили, сеансы, вложения files, level, continue_id,
// отметку лимита и учёт объёма — и для codex/deepseek/kimi/claude выполняется синхронно, а для antigravity отрабатывает
// своим фоновым runJob; раннер опрашивает НАСТОЯЩУЮ карточку участника на диске (по сохранённому request_id / номеру).
//
// Происхождение: поручение помечается на карточке scenario=<id>, scenarioKey, scenarioBy (доказанный чат, запустивший
// сценарий). Права — как у запустившего чата (дочерний сервер поднят в контексте дирижёра на состоянии сценария).
// Идемпотентность/подъём: request_id стабилен по (шаг, ключ, попытка). Переотправка с тем же request_id возвращает уже
// существующую карточку (повтор admission), поэтому завершённое поручение шага при подъёме НЕ выполняется заново.
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = { codex: 'codex', deepseek: 'deepseek', kimi: 'kimi', antigravity: 'antigravity', claude: 'claude' };
// team-v63 (п.2): папка карточек участника. У всех — `<state>/<member>-jobs`, а у Antigravity — `<state>/jobs` (комплект
// <id>/card.json). Прежде раннер искал несуществующую `antigravity-jobs` и НИКОГДА не находил карточку Antigravity.
const JOBS_DIRNAME = { codex: 'codex-jobs', deepseek: 'deepseek-jobs', kimi: 'kimi-jobs', antigravity: 'jobs', claude: 'claude-jobs' };
const sendTool = m => m + '_send';
const cancelTool = m => (m === 'antigravity' ? 'antigravity_cancel' : m + '_cancel');
// team-v63 (п.5/п.6): «cancelling»/«cancel_requested»/«stop_unconfirmed» — тоже КОНЕЦ для сценария: отменённая (на stop или
// при передаче другому) карточка может застрять в «cancelling», и её нельзя ждать вечно. Их движок считает провалом/отменой
// и идёт дальше (обход/повтор).
const TERMINAL = ['done', 'applied', 'failed', 'cancelled', 'needs_decision', 'waiting_quota', 'cancelling', 'cancel_requested', 'stop_unconfirmed'];
// team-v63 (п.3): предел вызова client.callTool не меньше предела самого поручения (codex/deepseek/kimi/claude *_send идут
// дольше минуты, а у SDK по умолчанию 60 с → обрыв). Берём с большим запасом; при timeout_sec поручения — ещё больше.
const CALL_TIMEOUT_MS = Number(process.env.MOST_SCENARIO_CALL_TIMEOUT_MS) || 30 * 60 * 1000;

function textOf(res) { return (res && res.content || []).map(c => c.text || '').join('\n'); }
// team-v63 (п.2): номер поручения из ответа *_send. У codex/deepseek/kimi/claude — «Номер поручения: <id>», у Antigravity —
// «Задание <id> запущено» (а при идемпотентном повторе — «повтор … поручение <id>»).
function parseJobId(text) {
  const m = /Номер поручения:\s*(\S+)/.exec(text || '') || /Задание\s+(\S+)\s+запущено/.exec(text || '') || /поручение\s+(\S+)/.exec(text || '');
  return m ? m[1] : null;
}

// Карточку участника читаем прямо из состояния сценария (по переданному stateDir, а не по кэшированному paths.stateDir:
// движок может крутиться в процессе с иным состоянием). Папка участника — <state>/<member>-jobs; формат — плоский <id>.json
// или комплект <id>/card.json (antigravity). Служебные JSON (settings/mcp-config и т.п.) карточками не считаем — без поля id.
function memberJobsDir(stateDir, member) { return path.join(stateDir, JOBS_DIRNAME[member] || (member + '-jobs')); }
function memberJobs(stateDir, member) {
  const dir = memberJobsDir(stateDir, member);
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const full = path.join(dir, n);
      let file;
      if (n.endsWith('.json') && !n.endsWith('.tmp')) file = full;
      else if (fs.existsSync(path.join(full, 'card.json'))) file = path.join(full, 'card.json');
      else continue;
      const c = require('./cards').readCard(file);
      if (c && c.id) out.push(c);
    } catch {}
  }
  return out;
}
function findCard(stateDir, member, rid, jobId) {
  const jobs = memberJobs(stateDir, member);
  if (jobId) { const byId = jobs.find(j => j.id === jobId); if (byId) return byId; }
  return jobs.find(j => j.requestId === rid) || null;
}

// Текстовый ответ без карточки: отметка лимита (quota-mark) отвечает waiting_quota БЕЗ карточки — это «обход по лимиту».
// quota-622: отказ отметки «на счёте нет денег» — 'balance' (недоступность участника, не провал игрока).
function statusFromText(text, isError) {
  if (/нет денег/i.test(text || '')) return 'balance';
  if (/Лимит .* исчерпан|waiting_quota|повторите после сброса/i.test(text || '')) return 'quota';
  return isError ? 'failed' : 'failed';
}

function senderRunner(stateDir, S, opts = {}) {
  const env = opts.env || process.env;
  const clients = new Map();   // member → Promise<{ client, transport, pid, dead }>
  const connRecs = new Map();  // member → resolved connection record (для проверки dead в poll)
  const inflight = new Map();  // handle → { member, rid, jobId, settled, text, isError, error }

  function clientFor(member) {
    // Одно подключение на участника. Храним ПРОМИС сразу (а не после connect), иначе два параллельных поручения одному
    // участнику завели бы два дочерних сервера (гонка) и один остался бы висеть процессом.
    if (clients.has(member)) return clients.get(member);
    if (!SERVER_DIR[member]) return Promise.reject(Error('Сценарий: неизвестный участник ' + member + '.'));
    const rec = { dead: false };
    const p = (async () => {
      // Точка внедрения для тестов: фабрика клиента вместо дочернего сервера (фейковый CLI/сервер).
      if (opts.clientFactory) { const client = await opts.clientFactory(member, { stateDir, env }); return Object.assign(rec, { client, transport: { close() {} }, pid: null }); }
      const file = path.join(ROOT, 'servers', SERVER_DIR[member], 'index.js');
      // team-v63 (п.17): дочерний сервер идёт от имени ЗАПУСТИВШЕГО сценарий чата, а не жёстко от claude. Иначе сценарий
      // чата codex/antigravity слал бы с правами claude и первичную миграцию запускал бы клиент claude на общем состоянии.
      const asClient = (opts.asClient || (S && S.by) || 'claude');
      const childEnv = { ...env, MOST_CLIENT: asClient, MOST_JOB_ID: '', MOST_STATE_DIR: stateDir, MOST_REPO_ROOT: ROOT, MOST_SCENARIO_CHILD: '1' };
      delete childEnv.MOST_AUTHORITY; delete childEnv.MOST_FALLBACK_DIR;
      const transport = new StdioClientTransport({ command: process.execPath, args: [file], env: childEnv, stderr: 'pipe' });
      const client = new Client({ name: 'scenario-sender', version: '1' });
      // team-v63 (п.4): непрочитанный stderr дочернего сервера переполнял бы буфер и подвешивал его — сливаем (последние
      // строки оставляем для диагностики). team-v63 (п.5): смерть дочернего сервера помечаем — poll по ней выйдет, а не ждёт вечно.
      try {
        await client.connect(transport);
      } catch (e) {
        // team-v63 (п.4): при ошибке connect закрываем транспорт, не оставляя процесс.
        try { await transport.close(); } catch {}
        throw e;
      }
      try { const se = transport.stderr; if (se) { se.setEncoding('utf8'); se.on('data', d => { rec.stderrTail = ((rec.stderrTail || '') + d).slice(-4000); }); } } catch {}
      const markDead = () => { rec.dead = true; };
      try { transport.onclose = markDead; transport.onerror = markDead; } catch {}
      // Негостевой сервер снимает дерево процессов асинхронно (restart-hold.serverAsync); до готовности admit отвечает
      // «сервер ещё готовится». Ждём маркер restart-servers/<pid>.json, чтобы первое поручение не упёрлось в это.
      await awaitServerReady(stateDir, transport.pid).catch(() => {});
      return Object.assign(rec, { client, transport, pid: transport.pid });
    })();
    clients.set(member, p);
    p.then(c => connRecs.set(member, c)).catch(() => clients.delete(member)); // неудачное подключение не кэшируем; dead читаем из connRecs
    return p;
  }

  async function start({ key, member, role, level, task, files, continueId, timeout_sec, requestId, resuming, notStopped, force }) {
    const rid = requestId || ('sc-' + S.id + '-' + randomUUID().slice(0, 8));
    const handle = member + ':' + rid;
    const args = { folder: S.folder, task, request_id: rid };
    if (role) args.role = role;
    if (level) args.level = level;
    if (files && files.length) args.files = files;
    if (continueId) args.continue_id = continueId;
    // quota-622: resume сценария, вставшего на паузу «нет денег», — слово пользователя: отметку обходим одной попыткой.
    if (force === true) args.force = true;
    if (Number.isFinite(timeout_sec) && timeout_sec > 0) args.timeout_sec = timeout_sec;
    const rec = { member, rid, key, settled: false, resuming: !!resuming };
    inflight.set(handle, rec);
    const { client } = await clientFor(member);
    // team-v63 (Б1): остановка проверяется ПОСЛЕ всех await (включая clientFor), непосредственно перед client.callTool —
    // при остановке вызов НЕ делается (отправка после stop не происходит). Проверку даёт движок (token.stop или диск).
    if (notStopped && !notStopped()) { rec.stopped = true; rec.settled = true; return { jobId: handle, stopped: true }; }
    // Негостевой сервер после запуска снимает дерево процессов (restart-hold.serverAsync); пока снимок не готов, admit
    // отвечает «сервер ещё готовится» — это транзиентно. Повторяем отправку тем же request_id (идемпотентно), пока не примут.
    // team-v63 (п.3): предел вызова не меньше предела поручения — иначе SDK оборвёт синхронный *_send через 60 с.
    const callTimeout = Math.max(CALL_TIMEOUT_MS, (Number.isFinite(timeout_sec) && timeout_sec > 0) ? timeout_sec * 1000 + 60000 : 0);
    const callOpts = { timeout: callTimeout, maxTotalTimeout: callTimeout, resetTimeoutOnProgress: true };
    rec.promise = (async () => {
      for (let i = 0; i < 40; i++) {
        // Б1: остановка во время ожидания готовности сервера тоже перехватывает отправку до вызова.
        if (notStopped && !notStopped()) { rec.stopped = true; rec.settled = true; return; }
        let r; try { r = await client.callTool({ name: sendTool(member), arguments: args }, undefined, callOpts); }
        catch (e) { rec.error = e.message; rec.settled = true; return; }
        const text = textOf(r);
        if (/ещё готовится|готовится после запуска/i.test(text)) { await new Promise(z => setTimeout(z, 1000)); continue; }
        rec.text = text; rec.jobId = parseJobId(text); rec.isError = !!r.isError; rec.settled = true; return;
      }
      rec.error = 'сервер участника не подготовился'; rec.settled = true;
    })();
    return { jobId: handle };
  }

  function result(member, card, key) {
    // Пометка происхождения на НАСТОЯЩЕЙ карточке участника (from уже = клиент дирижёра): scenario/scenarioKey/scenarioBy.
    patchOrigin(stateDir, member, card, S, key);
    const map = { done: 'done', applied: 'done', waiting_quota: 'quota', cancelled: 'cancelled',
      cancelling: 'cancelled', cancel_requested: 'cancelled', stop_unconfirmed: 'cancelled' };
    // quota-622: карточка «на счёте нет денег» (errorKind/quotaReason 'balance') — недоступность участника, а не провал.
    const status = (card.quotaReason === 'balance' || card.errorKind === 'balance') && card.status !== 'done' ? 'balance'
      : map[card.status] || (card.status === 'needs_decision' ? 'done' : 'failed');
    // team-v63 (п.2): результат участника. У большинства — card.resultFile; у Antigravity его в карточке нет, а результат
    // лежит комплектом <member-jobs>/<id>/result.txt. Читаем и его.
    let text, resultFile = card.resultFile;
    try { if (card.resultFile && fs.existsSync(card.resultFile)) text = fs.readFileSync(card.resultFile, 'utf8'); } catch {}
    if (text === undefined) {
      try { const alt = path.join(memberJobsDir(stateDir, member), card.id, 'result.txt');
        if (fs.existsSync(alt)) { text = fs.readFileSync(alt, 'utf8'); resultFile = alt; } } catch {}
    }
    return { terminal: true, status, text, resultFile, error: card.error,
      seconds: card.seconds, chars_in: card.chars_in, chars_out: card.chars_out, tokens: card.tokens,
      memberJobId: card.id };
  }

  async function poll(handle) {
    const rec = inflight.get(handle);
    if (!rec) return { terminal: true, status: 'lost', error: 'нет записи поручения сценария' };
    const card = findCard(stateDir, rec.member, rec.rid, rec.jobId);
    // team-v63 (п.22): метку происхождения (scenario/scenarioKey/scenarioBy) ставим на ИДУЩУЮ карточку, как только она
    // появилась, а не только на готовой — чтобы идущие сценарные поручения не попадали в краткую сводку как «ничьи».
    if (card) { try { patchOrigin(stateDir, rec.member, card, S, rec.key); } catch {} }
    if (card && TERMINAL.includes(card.status)) return result(rec.member, card, rec.key);
    // team-v63 (п.5): смерть дочернего сервера участника при не финальной карточке — поручение считается упавшим (не ждём
    // вечно). Статус lost/failed — не из TERMINAL набора карточки, поэтому движок обойдёт/повторит по правилам.
    const conn = connRecs.get(rec.member), dead = conn && conn.dead;
    const deadErr = () => 'сервер участника ' + rec.member + ' завершился' + (conn && conn.stderrTail ? ': ' + firstLine(conn.stderrTail) : '');
    if (!rec.settled) {                                     // синхронное поручение ещё идёт — ждём ответа *_send
      if (dead) return { terminal: true, status: 'failed', error: deadErr() + ' до ответа' };
      return { terminal: false };
    }
    if (card) {                                             // карточка есть, но ещё не финальна (antigravity; подъём по requestId)
      // team-v63 (Б4): осиротевшая карточка после перезапуска. Проверяем ВЛАДЕЛЬЦА карточки тем же способом, что мост для
      // обычных поручений (locks.ownerState → live-jobs.effectiveStatus). Владелец мёртв → lost / нужно решение — попытка
      // упала (pollRound повторит тому же участнику новой попыткой), а не вечное terminal:false. Владелец жив — ждём.
      let ownerState = 'unknown';
      try { ownerState = await require('./locks').ownerState(card.owner, stateDir); } catch {}
      const eff = require('./live-jobs').effectiveStatus(card, ownerState);
      if (eff === 'lost') return { terminal: true, status: 'lost', error: 'владелец карточки ' + card.id + ' завершился (осиротело)' + (rec.error ? '; ' + rec.error : '') };
      if (eff === 'needs_decision') return { terminal: true, status: 'needs_decision', error: 'карточка ' + card.id + ' требует решения' };
      if (dead) return { terminal: true, status: 'failed', error: deadErr() + ', карточка ' + card.id + ' не финальна' + (rec.error ? '; ' + rec.error : '') };
      return { terminal: false };
    }
    if (rec.error) return { terminal: true, status: 'failed', error: rec.error };
    // Ответ без карточки (например, отметка лимита вернула waiting_quota без постановки) — обход по лимиту/отказ.
    return { terminal: true, status: statusFromText(rec.text, rec.isError), error: firstLine(rec.text) };
  }

  // team-v63 (п.5): отмена С ПОДТВЕРЖДЕНИЕМ. Принимает handle (из inflight или `member:rid`) ИЛИ { member, requestId, jobId }
  // — чтобы отменять и из свежего раннера (stop из процесса, цикл которого уже закрыт: карточку находим по requestId).
  // `cancelling`/`cancel_requested`/`stop_unconfirmed` НЕ считаем «отменено»: ждём подтверждённого конечного состояния
  // (опрос карточки). Нет подтверждения за срок (по умолчанию 60 с) → confirmed:false (движок продолжит, но предупредит).
  const CANCEL_CONFIRMED = ['cancelled', 'done', 'applied', 'failed', 'stop_confirmed'];
  async function cancel(handleOrSpec, member, copts = {}) {
    let m = member, rid, jobId;
    if (typeof handleOrSpec === 'string') {
      const rec = inflight.get(handleOrSpec);
      if (rec) { m = rec.member; rid = rec.rid; jobId = rec.jobId; }
      else { const i = handleOrSpec.indexOf(':'); if (i > 0) { m = handleOrSpec.slice(0, i); rid = handleOrSpec.slice(i + 1); } }
    } else if (handleOrSpec && typeof handleOrSpec === 'object') {
      m = handleOrSpec.member || member; rid = handleOrSpec.requestId; jobId = handleOrSpec.jobId;
    }
    if (!m) return { confirmed: true, status: 'none' };
    let card = findCard(stateDir, m, rid, jobId);
    const id = jobId || (card && card.id);
    if (!id) return { confirmed: true, status: 'none' };              // карточки нет — поручение не ушло, отменять нечего
    if (card && CANCEL_CONFIRMED.includes(card.status)) return { confirmed: true, status: card.status, id };
    // team-v63 (п.5): мёртвое подключение к серверу участника — поднять новое и отменить через него.
    const conn = connRecs.get(m); if (conn && conn.dead) { clients.delete(m); connRecs.delete(m); }
    try { const { client } = await clientFor(m); await client.callTool({ name: cancelTool(m), arguments: { id } }, undefined, { timeout: 120000 }); } catch {}
    const confirmMs = Number(copts.confirmMs) || Number(opts.cancelConfirmMs) || Number(process.env.MOST_SCENARIO_CANCEL_MS) ||
      (S && S.scenario && Number(S.scenario.cancelConfirmMs)) || 60000;
    const end = Date.now() + confirmMs;
    for (;;) {
      card = findCard(stateDir, m, rid, jobId);
      if (!card) return { confirmed: true, status: 'none', id };
      if (CANCEL_CONFIRMED.includes(card.status)) return { confirmed: true, status: card.status, id };
      let os = 'unknown'; try { os = await require('./locks').ownerState(card.owner, stateDir); } catch {}
      if (require('./live-jobs').effectiveStatus(card, os) === 'lost') return { confirmed: true, status: 'lost', id }; // осиротело — исполнения нет
      if (Date.now() >= end) return { confirmed: false, status: card.status, id };
      await new Promise(z => setTimeout(z, 200));
    }
  }

  async function close() {
    for (const p of clients.values()) {
      let rec; try { rec = await p; } catch { continue; }
      try { await rec.client.close(); } catch {}
      try { await rec.transport.close(); } catch {}
    }
    clients.clear();
  }

  return {
    quotaBlocked(member) { try { return require('./quota-mark').blocked(memberJobs(stateDir, member)).blocked; } catch { return false; } },
    paused(member) { try { return require('./members').recipientPaused(member); } catch { return false; } },
    start, poll, cancel, close, _clients: clients, _inflight: inflight,
  };
}

function firstLine(text) { return String(text || '').split('\n').find(l => l.trim()) || undefined; }

// Пометка происхождения на карточке участника (атомарно, тем же приёмом, что серверы). Карточка уже терминальна.
function patchOrigin(stateDir, member, card, S, key) {
  if (card.scenario === S.id && card.scenarioKey === key && (card.scenarioBy === S.by || !S.by)) return;
  try {
    const base = memberJobsDir(stateDir, member);
    const bundle = path.join(base, card.id, 'card.json'), flat = path.join(base, card.id + '.json');
    const p = fs.existsSync(bundle) ? bundle : flat;
    if (!fs.existsSync(p)) return;
    const c = require('./cards').readCard(p);
    c.scenario = S.id; if (key) c.scenarioKey = key; if (S.by) c.scenarioBy = S.by;
    const tmp = p + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2)); fs.renameSync(tmp, p);
    card.scenario = S.id; card.scenarioKey = key; card.scenarioBy = S.by;
  } catch {}
}

async function awaitServerReady(stateDir, pid, ms = 60000) {
  if (!pid) return;
  const file = path.join(stateDir, 'restart-servers', pid + '.json');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fs.existsSync(file)) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
}

module.exports = { senderRunner };
