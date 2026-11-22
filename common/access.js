'use strict';
// Increment 4 live: client !== authority. Empty MOST_CLIENT => unknown (not claude).
// Peer never gate judge. Active fallback session authority=user wins over MOST_AUTHORITY spoof.
// Preserves ready() + queued + Russian guest errors so Claude Desktop path stays intact when MOST_CLIENT=claude and no fallback session.
const fs = require('fs');
const path = require('path');

function client() {
  const c0 = process.env.MOST_CLIENT;
  let c;
  if (!c0 || !String(c0).trim()) {
    // Under active fallback (authority=user): empty is unknown — never forge claude.
    // Outside fallback: historic default 'claude' so Desktop/tests without env stay conductor.
    if (authority() === 'user') return 'unknown';
    c = 'claude';
  } else c = String(c0).trim();
  if (c === 'job' && require('./job-identity').currentJob()?.member === 'claude') return 'claude-print';
  return c;
}

function readSessionAuthority(fallbackDir) {
  if (!fallbackDir) {
    if (process.env.MOST_FALLBACK_DIR) fallbackDir = process.env.MOST_FALLBACK_DIR;
    else return null;
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(fallbackDir, 'session.json'), 'utf8'));
    if (s && s.authority) return s.authority;
    if (s && s.mode === 'fallback' && s.conductor) return 'user';
    if (s && s.mode === 'left') return 'claude';
  } catch {}
  return null;
}

function authority(opts = {}) {
  const fromSession = readSessionAuthority(opts.fallbackDir);
  // Active fallback session cannot be overridden by env spoof.
  if (fromSession === 'user') return 'user';
  if (process.env.MOST_AUTHORITY && String(process.env.MOST_AUTHORITY).trim()) {
    return String(process.env.MOST_AUTHORITY).trim();
  }
  if (fromSession) return fromSession;
  return null;
}

function guest(opts = {}) {
  const c = client();
  // team-v46: claude-print всегда гость (исполнитель не наследует роли дирижёра); сопоставление — memberForClient.
  try { if (!require('./members').memberForClient(c)?.roles.conductor) return true; }
  catch { if (c !== 'claude') return true; } // Повреждение: прежний основной клиент сохраняет доступ к диагностике; записи ниже закрыты.
  const a = authority(opts);
  if (a === 'user') return true;
  if (a == null && process.env.MOST_FALLBACK_DIR) {
    const a2 = authority({ fallbackDir: process.env.MOST_FALLBACK_DIR, ...opts });
    if (a2 === 'user') return true;
  }
  return false;
}

function isGateJudge(role) {
  return role === 'user' || role === 'claude';
}

// team-v48e Г4b/Г4e: гостю безусловно доступен полный набор инструментов, свой сервер и запись/полный доступ, ролевой фильтр
// реестра снят (тумблеры MOST_GUEST_STRICT/MOST_STRICT_REGISTRY удалены). Подлинность (существование получателя, jobProof,
// пауза) и серверные проверки карточки — всегда.

function peerIsAuthority(opts = {}) {
  const a = authority(opts);
  if (!a) return false;
  return !isGateJudge(a);
}

function assertPeerNotJudge(opts = {}) {
  const a = authority(opts);
  if (a && !isGateJudge(a)) {
    throw new Error('access: peer/authority "' + a + '" cannot be gate judge (client=' + client() + ')');
  }
  if (peerIsAuthority(opts)) {
    throw new Error('access: peer must not be authority');
  }
}

// Сеанс-поручение: в нём человека нет (пишет помощник), поэтому к воротам установки он не допускается.
function jobSession() {
  const c = client();
  return !!process.env.MOST_JOB_ID || c === 'job' || c === 'claude-print';
}

// team-v58: чат участника — клиент зарегистрированного участника связки (по полному реестру, включая участника на паузе),
// НЕ поручение-сеанс И с ДОКАЗАННЫМ происхождением сервера от приложения-клиента (часть Г, замысел §1 — common/chat-origin.js).
// В таком чате может быть пользователь, и он получает полный набор дирижёра (§1–2). Признак поручения проверяется первым
// (jobSession): из поручения права не расширяются. Имя клиента (MOST_CLIENT) задаётся окружением и само прав чата не даёт —
// нужна доказанная цепочка предков. Исторический Grok и неизвестный клиент чатом не считаются.
function chatSession() {
  return !jobSession() && registeredMember(client()) && require('./chat-origin').ok();
}

function allowed(server, tool, opts = {}) {
  assertPeerNotJudge(opts);
  const changeTool = tool === 'team_change' || /deploy/i.test(tool);
  // Установщик прежнего релиза проверяет список прежним набором (legacyTools); установщик team-v19+ просит полный (MOST_PROBE_GUEST=full).
  const legacyProbe = process.env.MOST_PROBE_ONLY === '1' && process.env.MOST_PROBE_GUEST !== 'full';
  const bySet = () => legacyProbe ? legacyTools(server, client()).includes(tool) : guestTools(server, client()).includes(tool);
  // team-v58: признак поручения проверяется ПЕРВЫМ. В поручении-сеансе человека нет — права исполнителя как прежде, к воротам
  // установки (team_change/deploy) он не допускается никогда.
  if (jobSession()) {
    if (changeTool) return false;
    return bySet();
  }
  // team-v58 Г: права чата/дирижёра — ТОЛЬКО по доказанному происхождению (chatSession включает chat-origin). Происхождение
  // не доказано (оборванная/неоднозначная/нечитаемая цепочка, предок-сервер или предок-исполнитель) — прав чата нет, даже под
  // именем зарегистрированного участника: ворота установки закрыты, остальное — прежний набор исполнителя/совместимости.
  if (!chatSession()) {
    if (changeTool) return false;
    return legacyProbe ? legacyTools(server, client()).includes(tool) : jobTools(server, client()).includes(tool);
  }
  // Дирижёр Claude в основном режиме — полный доступ напрямую (проба релиза его набор не ограничивает, как прежде);
  // посторонний authority (не claude/user) воротами связки не управляет. Происхождение к этому шагу уже доказано.
  if (!guest(opts)) {
    if (changeTool) {
      const a = authority(opts);
      if (a != null && a !== 'claude' && a !== 'user') return false;
    }
    return true;
  }
  // team-v58: чат любого зарегистрированного участника-гостя (codex/antigravity/deepseek/kimi) с доказанным происхождением
  // получает полный набор дирижёра (включая team_change/team_word/team_members и диагностику) — он объявлен в guestTools.
  // Действия внутри team_change/team_word разграничивает guard по роли сеанса.
  return bySet();
}
function legacyTools(server, c) {
  const member = require('./members').memberForClient(c);
  if (!member && c !== 'grok') return []; // Grok: совместимость прежней пробы
  if (member && !member.roles.sends) return server === 'team' ? ['team_status', 'team_rules', 'team_work'] : [server + '_status', server + '_result'];
  if (server === 'team') return ['team_status', 'team_rules', 'team_work'];
  return (c === 'claude' ? 'codex' : c) === server ? [] : [server + '_status', server + '_send', server + '_result'];
}

// Инструменты гостя при старте (team-v19, К2): у гостей codex и antigravity — team_word и сервер своей семьи; право
// пользоваться ими проверяет guard при вызове; чат Codex получает свой сервер и вне запасного режима (team-v25).
// team-v57 (ред.8): клиент сопоставлен ЗАРЕГИСТРИРОВАННОМУ участнику связки (в полном реестре all(), в т.ч. на паузе и в
// неактивной фазе) — из его чата принимается слово владельца для установки. Поручение-исполнитель (claude-print/job) и
// исторический Grok участниками-чатами не считаются. По полному реестру (а не по действующему составу), чтобы ворота
// установки не зависели от паузы/фазы участника и чтобы access.allowed, guestTools и проба установки совпадали.
function registeredMember(c) {
  if (c === 'grok' || c === 'claude-print' || c === 'job') return false;
  try { const id = require('./job-identity').memberId(c); return !!id && require('./members').all().some(m => m.id === id && m.state !== 'removed'); }
  catch { return false; }
}
// team-v58: полный набор дирижёра для сервера — ровно те инструменты, которые сервер объявляет (register) и которые у дирижёра
// Claude регистрируются целиком. Чат любого зарегистрированного участника получает этот набор; действия внутри
// team_change/team_word разграничивает guard, цикл «сам себе» на *_send ловит lineage при вызове (не на регистрации).
function fullChatTools(server) {
  if (server === 'team') return ['team_status', 'team_rules', 'team_members', 'team_change', 'team_word', 'team_work', 'team_inbox', 'team_ask', 'team_ask_result', 'team_scenario'];
  if (server === 'antigravity') return ['antigravity_status', 'antigravity_send', 'antigravity_result', 'antigravity_apply', 'antigravity_cancel'];
  return [server + '_status', server + '_send', server + '_result', server + '_cancel'];
}
function guestTools(server, c) {
  // team-v58: объявленный (offered) набор чата зарегистрированного участника связки (по полному реестру, в т.ч. на паузе) —
  // полный набор дирижёра. Это набор ДЛЯ ГРАНТОВ в настройках клиента (client-configs.grantsFor) и регистрации; боевое право
  // пользоваться им выдаёт allowed/guard ТОЛЬКО по доказанному происхождению (chat-origin). Поручение обычно приходит под
  // клиентом job/claude-print, но «Опасный случай 1» (подмена MOST_CLIENT именем участника) закрывает проверка jobSession.
  // Grok и неизвестный клиент участниками-чатами не считаются (jobTools — прежние наборы поручения/совместимости).
  if (registeredMember(c) && !jobSession()) return fullChatTools(server);
  return jobTools(server, c);
}
// Набор исполнителя/совместимости: поручение-сеанс, исторический Grok, неизвестный клиент, а также зарегистрированный
// участник БЕЗ доказанного происхождения (allowed при недоказанном chat-origin отдаёт именно его).
function jobTools(server, c) {
  const member = require('./members').memberForClient(c);
  // Участник на паузе/в неактивной фазе ловится registeredMember выше; сюда попадают job/claude-print, grok, неизвестный.
  if (!member && c !== 'grok') return [];
  // team-v48e Г4b: свой сервер claude исполнителю claude-print доступен безусловно (цикл claude→claude ловит lineageRefusal
  // при вызове, §D); прежнее исключение снято (тумблер MOST_GUEST_STRICT удалён).
  if (member && !member.roles.sends) return server === 'team' ? ['team_status', 'team_rules', 'team_work'] : [server + '_status', server + '_result'];
  const seat = !!member?.roles.fallback_conductor;
  if (server === 'team') return ['team_status', 'team_rules', 'team_work', 'team_ask', 'team_ask_result', ...(seat ? ['team_word'] : [])];
  const base = [server + '_status', server + '_send', server + '_result'];
  if (seat && c === server) return [...base, ...(server === 'antigravity' ? ['antigravity_apply', 'antigravity_cancel'] : ['codex_cancel'])];
  const peer = c === 'claude' ? 'codex' : c;
  // team-v48e Г4b: свой сервер подпоручению допустим безусловно (цикл A→A ловит lineageRefusal при вызове, §D).
  if (peer === server) return [...base, ...(server === 'antigravity' ? ['antigravity_apply', 'antigravity_cancel'] : [server + '_cancel'])];
  // team-v48 Г4d (§D.3): поручение-сеанс отменяет свои потомки на сервере-пире (guard assertDescendant ограничивает их потомками вызывающего).
  // team-v48e Г4d (04be41a): Claude-исполнитель (клиент claude-print) отменяет свои codex/deepseek/antigravity-потомки; свой сервер claude исключён (своих claude-потомков нет, claude→claude ловит lineageRefusal).
  const jobCancel = (c === 'job' || (c === 'claude-print' && server !== 'claude')) ? [server === 'antigravity' ? 'antigravity_cancel' : server + '_cancel'] : [];
  return [...base, ...jobCancel, ...(seat && server === 'antigravity' ? ['antigravity_apply'] : [])];
}

// team-v58 Г: набор инструментов для РЕГИСТРАЦИИ (listTools) сервера — отдельно от боевого права пользоваться ими (allowed/guard).
// Серверы регистрируют инструмент через offered(), а guard при вызове по-прежнему проверяет allowed() и доказанное происхождение
// (chat-origin). Проба установки (MOST_PROBE_ONLY=1) запускает серверы из процесса node установщика, а НЕ из приложения-клиента,
// поэтому прав чата у них нет и allowed() отдаёт лишь набор исполнителя/совместимости (у собственного сервера участника он пуст —
// тогда сервер вообще не объявляет инструментов и listTools отвечает -32601). Но установщик должен увидеть ОБЪЯВЛЯЕМЫЙ набор
// (guestTools — он же идёт в гранты настроек client-configs.grantsFor), чтобы сверить его с релизом. Поэтому под пробой offered()
// возвращает объявляемый набор. Границу это НЕ ослабляет и прав чата проба НЕ получает: offered() влияет ТОЛЬКО на список
// инструментов (listTools), а право ВЫЗВАТЬ любой из них выдаёт guard()→allowed() строго по доказанному происхождению; признак
// MOST_PROBE_ONLY сам по себе правом не является (в боевом сеансе он не выставлен, а guard остаётся прежним). Так замысел и
// называет guestTools — набор «для грантов и регистрации», тогда как боевое право — только по chat-origin.
// team-v58 (task10 е): подмена набора под пробой нужна ТОЛЬКО когда у сервера нет прав чата (chatSession=false) — именно такой
// сервер пробы (запущен установщиком, не приложением-клиента) отдал бы пустой/урезанный набор и уронил бы listTools (-32601) или
// сверку. Если же происхождение чата доказано (chatSession=true, напр. тестовый сервер под MOST_PROBE_ONLY с доказанным origin),
// offered()=allowed() — набор определяет обычное разграничение (под legacyProbe — набор совместимости, как и прежде), а не
// безусловный guestTools. Так проба установки (боевой сервер без прав чата) видит объявляемый набор, а наборы с доказанным
// origin (team-v18-word и др.) не получают расширенного списка из-за одного лишь флага MOST_PROBE_ONLY.
function offered(server, tool) {
  // Проба установки (MOST_PROBE_ONLY) — прежняя логика без изменений: установщик сверяет ОБЪЯВЛЯЕМЫЙ набор (guestTools) у
  // сервера без прав чата, а сервер с доказанным происхождением под пробой — по обычному разграничению (allowed). Это
  // install-time путь (установщик, последовательно), НЕ рукопожатие 6 серверов под дедлайном клиента, поэтому снимок здесь
  // допустим и границу пробы сохраняет (team-v58, грант/сверка релиза; исторический Grok не отдаёт отмену гостю).
  if (process.env.MOST_PROBE_ONLY === '1') {
    if (!chatSession()) return guestTools(server, client()).includes(tool);
    return allowed(server, tool);
  }
  // team-v59 (task2): ВНЕ пробы регистрация инструментов (listTools/initialize) НЕ снимает таблицу процессов (chat-origin),
  // иначе handshake упирается в startup_timeout клиента (Codex терял все инструменты — codex-diagnosis.md). Объявляемый набор
  // определяется ДЕШЁВЫМИ признаками (имя клиента, MOST_JOB_ID, реестр): зарегистрированный участник-чат видит полный набор
  // дирижёра (guestTools→fullChatTools), поручение-сеанс — набор поручения, прочие — набор совместимости. Границу это НЕ
  // ослабляет: право ВЫЗВАТЬ каждый инструмент по-прежнему выдаёт guard()→allowed() строго по ДОКАЗАННОМУ происхождению —
  // поручение и недоказанный сеанс видят список, но вызвать инструмент чата не могут (отказ guard с понятным текстом).
  return guestTools(server, client()).includes(tool);
}

function guard(server, tool, a = {}, opts = {}) {
  const readOnly = /_(?:result|status)$/.test(tool) && !(tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    tool === 'team_rules' || tool === 'team_work' && ['get', 'list'].includes(a.action) || tool === 'team_word' && a.action === 'list';
  if (!readOnly) require('./members').snapshot();
  // team-v48e Г4b: полный доступ гостю и блок изменений гостю сняты безусловно (тумблер MOST_GUEST_STRICT удалён) — серверные
  // проверки карточки (Г4c) остаются. team-v57 (ред.8): team_change deploy (установка по слову пользователя) открыт чату любого
  // участника и в запасном режиме — гостю запрещены лишь ПРОЧИЕ действия team_change; поручение-сеанс отсекает allowed().
  // team_status-диагностика (quota/usage/notify) — всегда у дирижёра. jobProof/пауза/существование получателя — всегда.
  const fallback = require('./fallback');
  const deployChange = tool === 'team_change' && a.action === 'deploy';
  // team-v58: чат любого участника с ДОКАЗАННЫМ происхождением получает полный набор дирижёра — ограничения «диагностика/прочие
  // team_change запрещены» снимаются для chatSession. Они остаются для поручения-исполнителя, исторического Grok/неизвестного И
  // для сеанса под именем участника без доказанного происхождения (часть Г): условие по `!chatSession()`, а не по `guest()` —
  // иначе недоказанный «дирижёр Claude» (поручение сбросило MOST_JOB_ID) сохранил бы диагностику. Установка (deploy) и так
  // закрыта в allowed() при недоказанном происхождении.
  if (!allowed(server, tool, opts) || (!chatSession() && (
    (tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    (tool === 'team_change' && !deployChange)
  ))) {
    throw Error('Гостю это действие запрещено; изменения не выполнены.');
  }
  if (/_send$/.test(tool) && server !== 'grok') {
    const members = require('./members'), recipient = members.receiver(server);
    // team-v48e Г4e: получатель должен существовать — всегда (подлинность реестра); ролевой фильтр (sends/receives/writer)
    // снят безусловно (тумблер MOST_STRICT_REGISTRY удалён). Пауза получателя проверяется отдельно (members.active/слово).
    if (!recipient) throw Error('Реестр участников запрещает отправку этому получателю.');
  }
  fallback.guard(server, tool, a);
}

const queued = 'Поручение поставлено в очередь; выполнит основной сервер (Claude Desktop должен быть открыт)';

const readyCleanups = new Set();
function registerReadyCleanup(file) {
  if (readyCleanups.has(file)) return;
  readyCleanups.add(file);
  if (readyCleanups.size === 1)
    // Запись на экземпляр удаляется при собственном выходе; аварийный выход/сигнал покрывает чистка устаревших при чтении
    // (chat-origin.serverRecords). Поэтому берём только синхронный 'exit', не переопределяя обработку сигналов сервера.
    process.on('exit', () => { for (const f of readyCleanups) { try { fs.unlinkSync(f); } catch {} } });
}
function ready(server) {
  // team-v58 (task10 г): запись готовности пишет КАЖДЫЙ сервер моста, кем бы он ни был запущен (чат Claude, Codex, Antigravity,
  // DeepSeek, Kimi — все не-Claude клиенты тоже), чтобы (1) исполнитель, запущенный сервером не-Claude клиента, нашёл предка-
  // сервера по записи на экземпляр, и (2) путь настроек чата Kimi запоминался и у серверов не-Claude чатов. Прежний гейт guest()
  // этого не давал. Проба установки (MOST_PROBE_ONLY) записей по-прежнему не пишет.
  if (process.env.MOST_PROBE_ONLY === '1') return;
  const dir = path.join(require('./paths').stateDir, 'ready');
  const record = JSON.stringify({ release: path.resolve(__dirname, '..'), pid: process.pid, startedAt: new Date().toISOString() });
  const atomic = require('./team-git').atomic;
  // Прежний общий файл <server>.json — для совместимости с тем, что его читает.
  atomic(path.join(dir, server + '.json'), record);
  // team-v58 (дирижёр п.5): запись на ЭКЗЕМПЛЯР — каждый клиент запускает свои серверы моста; общий файл затирается последним,
  // и исполнитель, запущенный сервером другого клиента, не нашёл бы предка-сервера. Пишется синхронно до обработки инструментов.
  const instance = path.join(dir, server + '.' + process.pid + '.json');
  atomic(instance, record);
  registerReadyCleanup(instance);
  // team-v58-any-chat (часть Д, task7 п.2а): при готовности основного сервера моста (любого клиента) путь настроек чата Kimi
  // находится сам по живой таблице процессов (когда настольный Kimi виден) и ЗАПОМИНАЕТСЯ в state\kimi-client.json, чтобы
  // пережить закрытие приложения Kimi к моменту установки. В фоне, не блокируя старт; ошибки проглатываются. Живую таблицу
  // процессов kimi-client.capture сканирует только у боевого моста (каталог состояния не временный) — тесты не затрагивает.
  if (server === 'team') setTimeout(() => { try { require('./kimi-client').capture(); } catch {} }, 0).unref();
}

function describe(opts = {}) {
  return {
    increment: 4,
    client: client(),
    guest: guest(opts),
    authority: authority(opts),
    emptyClientDefaultsToClaude: false, // never under authority=user; outside fallback empty still maps to claude for Desktop compat
    emptyOutsideFallbackDefaultsToClaude: true,
    peerCanBeGateJudge: false,
    claudeClientIgnoresAuthority: false,
    note: 'Live access.js incr4: client!==authority; ready/queued preserved; Claude Desktop path when MOST_CLIENT=claude and no fallback session.',
  };
}

// team-v58 Г: причина, по которой сеансу не выданы права чата (для team_status и диагностики). Пусто — происхождение доказано.
function chatOriginReason() { try { return require('./chat-origin').reason(); } catch { return 'происхождение не проверено'; } }
function chatOriginOk() { try { return require('./chat-origin').ok(); } catch { return false; } }

module.exports = {
  client, guest, authority, isGateJudge, peerIsAuthority, assertPeerNotJudge,
  allowed, guestTools, offered, guard, ready, queued, describe, readSessionAuthority, jobSession, chatSession,
  registeredMember, chatOriginReason, chatOriginOk,
};
