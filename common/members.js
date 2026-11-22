'use strict';
// Участник, адаптер и сервер — разные сущности. Адаптер claude-print — отдельный разовый сеанс Claude Code
// (исполнитель, не чат-дирижёр): он обслуживается сервером claude и получает поручения в папку claude-jobs.
const adapters = Object.freeze({ 'kimi-cli': { server: 'kimi', jobs: 'kimi-jobs' }, 'codex-cli': { server: 'codex', jobs: 'codex-jobs' }, 'agy-cli': { server: 'antigravity', jobs: 'jobs' }, 'dsh-headless': { server: 'deepseek', jobs: 'deepseek-jobs' }, 'claude-print': { server: 'claude', jobs: 'claude-jobs' } });
const store = () => require('./members-store').create();
const snapshot = () => store().read({ initialize: false });
const all = () => snapshot().members;
// Фаза установки: A — прежние права и ворота, B — DeepSeek действует (team-v31).
const phase = () => snapshot().phase || 'A';
// Пауза manual действует для Kimi в A/B/C; для прежних участников — в фазе B.
const pausedLive = m => !!m && (m.adapter === 'kimi-cli' || phase() === 'B') && m.state === 'paused' && m.pause?.kind === 'manual';
const paused = id => !!pausedLive(all().find(m => m.id === id));
// team-v48 Г5 (§13.B.5): получатель недоступен, если на ручной паузе реестра (B) ИЛИ по слову пользователя о недоступности.
// Очереди всех исполнителей держат карточку queued/waiting_quota, пока предикат истинен (не под переменной — класс (в)).
// team-v48e (ревью п.3): получатель определяется по адаптеру сервера через receiver() среди известных (включая
// приостановленных) — id участника может отличаться от имени сервера (напр. переименованный codex-cli), поэтому
// paused(server) по совпадению id==сервер был бы неверен (и TypeError при отсутствии участника в фазе B).
// team-v48e (ревью п.4): ручная пауза реестра держит карточку всегда; слово пользователя о недоступности держит, кроме
// восстановления по слову дирижёра запасного режима (fallbackWord) — иначе первый успех не снял бы слово (К2).
const recipientPaused = (server, fallbackWord) => {
  const m = receiver(server, known());
  if (!m) return false;
  if (paused(m.id)) return true;
  return !fallbackWord && !!require('./user-word').active(m.id);
};
// Одна формулировка паузы для сводки и списка участников (team-v44 П2).
function pauseNote(m) {
  if (!m?.pause) return '';
  if (m.adapter !== 'kimi-cli' && phase() !== 'B') return 'в А не влияет на исполнение';
  return pausedLive(m) ? 'исключён из кворума и приёма' : 'не действует в B';
}
// Пауза в А только отображается; в B — участник исключается из действующего состава.
const active = () => all().filter(m => m.state !== 'removed' && !pausedLive(m));
const get = id => active().find(m => m.id === id);
function effective(m) { return m ? effectiveAt(m, phase()) : null; }
function effectiveAt(m, currentPhase) {
  if (!m) return null;
  // В фазе A DeepSeek не действует: исполнительные и голосующие роли отключаются до установки фазы B.
  // team-v46: claude-print внесён в adapters с сервером claude — отдельной ветки «адаптер без сервера» больше нет.
  if (m.adapter === 'dsh-headless' && currentPhase !== 'B')
    return { ...m, roles: { ...m.roles, receives: false, sends: false, writer: false, voter: false } };
  return m;
}
// DeepSeek участвует в голосовании только после успешной пробы отказа записи установленной версии dsh.
const dshProbeOk = () => { try { return require('./dsh-probe').ok(); } catch { return false; } };
const voters = ({ excludeFamilies = [], external } = {}) => active().map(effective).filter(m => m.roles.voter &&
  !excludeFamilies.includes(m.family) && (external === undefined || m.external === external) &&
  !(m.adapter === 'dsh-headless' && !dshProbeOk()));
const canWrite = client => !!memberForClient(client)?.roles.writer;
// Отправитель может быть клиентом (например 'claude-print'), а не только id участника: исполнитель сопоставляется участнику.
const canSend = (from, to) => !!memberForClient(from)?.roles.sends && !!effective(get(to))?.roles.receives;
// team-v46: клиент claude-print — отдельный разовый сеанс Claude Code. Для отправки и паузы берётся участник claude,
// но роли дирижёра и запасного дирижёра не наследуются (запись и голос — как у участника claude: writer по реестру).
function memberForClient(client) {
  const m = effective(get(require('./job-identity').memberId(client)));
  if ((client === 'claude-print' || client === 'job') && m) return { ...m, roles: { ...m.roles, conductor: false, fallback_conductor: false } };
  return m;
}
// Подпись участника claude в team_status/team_members/строке квот: исполнитель — отдельный сеанс, не чат.
const executorTitle = m => m.id === 'claude' ? 'Claude-исполнитель (отдельный сеанс, не чат)' : m.title;
const adapterFor = id => { const m = get(id); return m ? { adapter: m.adapter, adapter_params: m.adapter_params } : null; };
// Адаптер по id, включая removed: история и карточки читаются после исключения.
const adapterOf = id => all().find(m => m.id === id)?.adapter || null;
// Семья участника по id (включая removed — история).
const familyOf = id => all().find(m => m.id === id)?.family || null;
// Сервер обслуживает адаптер, а идентификатор участника может быть другим.
function receiver(server, roster = active()) {
  // team-v48e Г4e: роль receives больше не условие существования получателя — находим по adapter.server и state!=='removed'
  // безусловно (тумблер MOST_STRICT_REGISTRY удалён, снятие безусловно). Пауза сохраняется: roster по умолчанию active()
  // (без paused), вызывающий код сверяет members.active/слово.
  return roster.find(m => m.state !== 'removed' && adapters[m.adapter]?.server === server);
}
function requiredVoters() {
  const current = voters({ external: true });
  // Прежний кворум базы: места Codex и Antigravity обязательны. В фазе B (team-v31)
  // обязательных имён нет — действуют все активные внешние голосующие (минимум 2 проверяется воротами).
  if (phase() !== 'B') {
    const required = { codex: 'openai', antigravity: 'google' };
    const missing = Object.entries(required).filter(([id, family]) => !current.some(c => c.id === id && c.family === family));
    if (missing.length) throw Error('Нет обязательных голосующих: изменение и этап ждёт восстановления состава (' + missing.map(([id]) => id).join(', ') + ').');
  }
  return current;
}
// Живые совместимые представления: импортировавший модуль не удерживает старый состав.
function dynamic(fn, array = false) {
  return new Proxy(array ? [] : {}, {
    get: (_, key) => { const value = fn(); const v = value[key]; return typeof v === 'function' ? v.bind(value) : v; },
    ownKeys: () => Reflect.ownKeys(fn()),
    getOwnPropertyDescriptor: (_, key) => key === 'length' && array ? { value: fn().length, writable: true, enumerable: false, configurable: false } : Object.getOwnPropertyDescriptor(fn(), key),
    has: (_, key) => key in fn(),
  });
}
// Схемы знают приостановленных; допуск проверяется по живому реестру при вызове.
const known = () => all().filter(m => m.state !== 'removed');
const knownVoters = () => known().map(effective).filter(m => m.roles.voter && m.external && !(m.adapter === 'dsh-headless' && !dshProbeOk()));
const knownIds = dynamic(() => known().map(m => m.id), true);
const knownSeatIds = dynamic(() => knownVoters().map(m => m.id), true);
const knownFallbackIds = dynamic(() => known().filter(m => effective(m).roles.fallback_conductor).map(m => m.id), true);
const knownVoterFamilies = dynamic(() => [...new Set(knownVoters().map(m => m.family))], true);
function assertAvailable(id) {
  const m = all().find(m => m.id === id && m.state !== 'removed');
  if (!m) throw Error('Неверный участник.');
  if (pausedLive(m)) throw Error('участник ' + id + ' на паузе: голос не принимается');
}
const ids = dynamic(() => active().map(m => m.id), true);
const servers = dynamic(() => ['team', ...new Set(active().filter(m => effective(m).roles.receives).map(m => adapters[m.adapter]?.server).filter(Boolean))], true);
// Состав установки не зависит от паузы; проба использует один снимок реестра.
function serversForInstall(roster = snapshot()) {
  return ['team', ...new Set(roster.members.filter(m => m.state !== 'removed' && effectiveAt(m, roster.phase || 'A').roles.receives).map(m => adapters[m.adapter]?.server).filter(Boolean))];
}
const installedServers = dynamic(() => serversForInstall(), true);
const installedClients = dynamic(() => require('./member-clients').all(all()), true);
const helpers = dynamic(() => active().filter(m => effective(m).roles.receives && adapters[m.adapter]).map(m => m.id), true);
// Для чтения поручений в воротах: получатели с адаптером, включая приостановленных (их отказы не исчезают), кроме удалённых.
const scanIds = dynamic(() => all().filter(m => m.state !== 'removed' && effective(m).roles.receives && adapters[m.adapter]).map(m => m.id), true);
const seats = dynamic(() => Object.fromEntries(voters({ external: true }).map(m => [m.id, m.family])));
const names = dynamic(() => ({ ...Object.fromEntries(all().map(m => [m.id, m.title])), grok: 'Grok' })); // история
const families = dynamic(() => [...new Set([...all().map(m => m.family), 'xai'])], true); // старое авторство
const seatIds = dynamic(() => Object.keys(seats), true);
const fallbackIds = dynamic(() => active().filter(m => effective(m).roles.fallback_conductor).map(m => m.id), true);
function describe(full = false) {
  try { const s = snapshot(); return 'Участники · rev ' + s.rev + ' · фаза ' + phase() + ': ' + s.members.filter(m => m.state !== 'removed').map(m => executorTitle(m) + ' (' + m.id + ')' + (full ? ' — ' + m.specialization + '; роли: ' + Object.entries(effective(m).roles).filter(([, on]) => on).map(([r]) => r).join(', ') : '') + (m.pause ? ' — пауза ' + m.pause.kind + ', ' + pauseNote(m) : '')).join(full ? '\n' : '; ') + (full ? '' : ' · специализации: full=true') + (s.warning ? '\nПредупреждение: ' + s.warning : ''); }
  catch (e) { return e.message; }
}
function rules() { return describe() + '\nУчастники и специализации — из team_status:\n' + active().map(m => m.title + ': ' + m.specialization).join('\n'); }
module.exports = { all, active, get, effective, voters, canWrite, canSend, adapterFor, adapterOf, familyOf, receiver, requiredVoters, rev: () => snapshot().rev, snapshot, store, adapters, dynamic, phase, paused, recipientPaused, memberForClient, executorTitle,
  knownIds, knownSeatIds, knownFallbackIds, knownVoterFamilies, assertAvailable, ids, servers, installedServers, installedClients, serversForInstall, helpers, scanIds, seats, seatIds, names, families, fallbackIds, describe, rules, pauseNote, grokDisabled: 'Grok выключен из связки (13.10.2026)' };
