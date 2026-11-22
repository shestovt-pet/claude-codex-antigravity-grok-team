'use strict';
// team-v63 (п.7): ОБРАЗЕЦ крючка сценария «стол: ведущий и три игрока» (общий, без правил конкретной игры).
// Мост сам ведёт цикл и на каждом шаге запускает этот скрипт: подаёт JSON на stdin, читает JSON со stdout.
//   вход:  { event: 'start'|'results', scenario, state, results:[{key,member,status,text,resultFile,seconds,chars_in,chars_out}] }
//   выход: { state, send:[{key,member|members,level,role,task,files,session,fresh,memory_file,timeout_sec}], done, note }
// Крючок сам хранит свои файлы (журнал, реплики) в папке сценария — мост в них не лезет.
//
// Что показывает образец (всё — забота КРЮЧКА, не моста):
//  • ведущий (level strong, сеанс «gm»): постоянный материал вкладывается ТОЛЬКО на первом ходу сеанса, дальше — лишь новые
//    ходы игроков; длина хода ограничена подсказкой;
//  • три игрока (level fast, сеансы p1/p2/p3): каждому — только то, что ему положено слышать (нарратив ведущего);
//  • каждые N ходов ведущего просим написать сжатую сводку для себя и начинаем сеанс заново с ней (fresh + memory_file) —
//    защита от переполнения контекста;
//  • участник с запасом: ведущему members:['deepseek','kimi','codex'] — мост возьмёт доступного, при отказе по лимиту обойдёт.

const fs = require('fs');
const path = require('path');

const RAW = fs.readFileSync(0, 'utf8');
const IN = JSON.parse(RAW || '{}');

// Папка сценария = cwd (мост так запускает крючок). Свои файлы держим в work/.
const WORK = path.join(process.cwd(), 'work');
fs.mkdirSync(WORK, { recursive: true });
const SC = IN.scenario || {};
// Секретное слово (если задано сценарием) — вкладывается только в постоянный материал (первый ход сеанса). В ходах 2+
// участника просят повторить его ПО ПАМЯТИ (во вложениях его уже нет): так видно, держится ли память сеанса или сработала
// эмуляция памяти вложением (memory_file). Без secret образец работает как прежде.
const SECRET = SC.secret || null;
const CONST_MATERIAL = path.join(WORK, 'ведущий-материал.txt'); // постоянный материал ведущего (создаём, если нет)
if (!fs.existsSync(CONST_MATERIAL)) {
  const base = SC.material || 'Постоянный материал ведущего (мир, правила, персонажи).\n'.repeat(20);
  fs.writeFileSync(CONST_MATERIAL, base + (SECRET ? '\n\nСЕКРЕТНОЕ СЛОВО: ' + SECRET + ' (запомни его на всю игру).\n' : ''), 'utf8');
}

const CFG = {
  maxTurns: SC.turns || 3, // сколько ходов стола сыграть
  players: SC.players || ['p1', 'p2', 'p3'],
  gmMembers: SC.gm_members || ['deepseek', 'kimi', 'codex'],
  playerMembers: SC.player_members || ['kimi', 'codex'],
  summaryEvery: SC.summary_every || 4, // каждые N ходов — сводка и рестарт сеанса ведущего
  gmLimit: 'Пиши нарратив коротко: не длиннее 1200 знаков.',
};
const recall = turn => (SECRET && turn >= 2) ? ' В САМОМ НАЧАЛЕ ответа повтори секретное слово из материала первого хода (по памяти — здесь его нет).' : '';

function writeMsg(name, text) { const p = path.join(WORK, name); fs.writeFileSync(p, text, 'utf8'); return p; }
function journalPush(entry) { fs.appendFileSync(path.join(WORK, 'журнал.jsonl'), JSON.stringify(entry) + '\n'); }
function resultText(results, key) { const r = (results || []).find(x => x.key === key); if (!r) return ''; if (r.text != null) return r.text; try { return r.resultFile ? fs.readFileSync(r.resultFile, 'utf8') : ''; } catch { return ''; } }

let S = IN.state || { turn: 0, phase: null, gmSessionTurn: 0 };

function sendGm(turn) {
  S.gmSessionTurn += 1;
  const firstInSession = S.gmSessionTurn === 1;
  const files = [];
  // Постоянный материал — только на первом ходу сеанса; дальше только новые ходы игроков.
  if (firstInSession) files.push(CONST_MATERIAL);
  if (S.lastPlayerMovesFile) files.push(S.lastPlayerMovesFile);
  const memoryFile = S.gmSummaryFile || undefined; // при рестарте сеанса — сжатая сводка как «память»
  return { key: 'gm', members: CFG.gmMembers, session: 'gm', level: 'strong', role: 'совет',
    task: 'Ход ' + turn + '. Веди игру как ведущий. ' + CFG.gmLimit + (firstInSession ? ' Материал вложен.' : ' Учитывай только новые ходы игроков (вложены ниже).') + recall(turn),
    files: files.length ? files : undefined, fresh: firstInSession && !!S.gmSummaryFile, memory_file: memoryFile, timeout_sec: 600 };
}

function sendPlayers(gmNarration) {
  const narrFile = writeMsg('нарратив-ход-' + S.turn + '.txt', gmNarration);
  // Память игрока: на первом ходу сообщаем секрет (вложен ниже), в ходах 2+ просим повторить его по памяти.
  const secretFirst = SECRET && S.turn === 1 ? ' Запомни секретное слово на всю игру: ' + SECRET + '.' : '';
  return CFG.players.map(key => {
    // «Память сценария» для ЭМУЛЯЦИИ при рестарте сеанса: файл должен СУЩЕСТВОВАТЬ (мост вкладывает его целиком, когда сеанс
    // начинается заново). Накапливаем сюда всё, что игрок слышал, включая секрет первого хода. Без этого мост не смог бы
    // прочитать несуществующий memory_file и поручение упало бы.
    const memFile = path.join(WORK, 'память-' + key + '.txt');
    fs.appendFileSync(memFile, 'Ход ' + S.turn + ' — нарратив ведущего:\n' + gmNarration + '\n' + (secretFirst ? secretFirst + '\n' : '') + '\n');
    return { key, members: CFG.playerMembers, session: key, level: 'fast', role: 'совет',
      task: 'Ты игрок ' + key + '. Ответь на ситуацию коротко (одно действие). Слышишь только нарратив ведущего (вложен).' + secretFirst + recall(S.turn),
      files: [narrFile], memory_file: memFile, timeout_sec: 300 };
  });
}

let out;
if (IN.event === 'start') {
  S.turn = 1; S.phase = 'gm';
  out = { state: S, send: [sendGm(1)], note: 'ход 1: ведущий' };
} else { // results
  if (S.phase === 'gm') {
    const narr = resultText(IN.results, 'gm');
    journalPush({ turn: S.turn, who: 'gm', text: narr.slice(0, 4000) });
    S.phase = 'players';
    out = { state: S, send: sendPlayers(narr), note: 'ход ' + S.turn + ': игроки' };
  } else { // были игроки
    const moves = CFG.players.map(k => k + ': ' + resultText(IN.results, k).slice(0, 1200)).join('\n');
    journalPush({ turn: S.turn, who: 'players', text: moves });
    S.lastPlayerMovesFile = writeMsg('ходы-игроков-' + S.turn + '.txt', moves);
    if (S.turn >= CFG.maxTurns) { out = { state: S, done: true, note: 'стол завершён за ' + S.turn + ' ходов' }; }
    else {
      S.turn += 1; S.phase = 'gm';
      // Каждые N ходов — просим ведущего сводку и начинаем его сеанс заново с ней (защита от переполнения).
      if (S.gmSessionTurn >= CFG.summaryEvery) {
        // Запросим сводку отдельным ходом того же сеанса, затем сбросим счётчик (упрощённо: берём журнал как память).
        S.gmSummaryFile = path.join(WORK, 'журнал.jsonl');
        S.gmSessionTurn = 0;
      }
      out = { state: S, send: [sendGm(S.turn)], note: 'ход ' + S.turn + ': ведущий' };
    }
  }
}
process.stdout.write(JSON.stringify(out));
