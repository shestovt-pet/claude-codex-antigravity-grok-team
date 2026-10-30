#!/usr/bin/env node
'use strict';
// team-v46: живая проба полной матрицы поручений — 15 строк + права + отрицательные испытания (после установки).
// Запуск: node tools/matrix-probe.js (на установленном релизе, дирижёром). Критерий готовности — 15/15 и все
// отрицательные провалились как должны. Без них «готово» не ставится.
//   12 направлений: claude(чат-дирижёр) → T (3) и S → T, S ∈ {codex, antigravity, deepseek}, T — три остальных (9).
//   3 направления участник → дирижёр (входящие): S вызывает team_ask, дирижёр отвечает team_inbox.
// Права (вне 15): дирижёр → Claude-исполнитель write=true (файл с nonce в folder); дирижёр → Claude-исполнитель
//   full_access (команда выполнена); S → T подпоручение с write=true от пишущего S (файл создан).
// Отрицательные: Claude-исполнитель без full_access пишет вне folder / в E:\most / запускает команду — всё проваливается;
//   гость ставит full_access — отказ; подпоручение с write=true и folder=E:\most — отказ при постановке.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CODE = path.resolve(__dirname, '..');
const ROOT = process.env.MOST_REPO_ROOT || path.resolve(__dirname, '..');
const STATE = process.env.MOST_STATE_DIR || path.join(ROOT, 'state');
const NODE = process.execPath;
// Действующий состав читается из members.js (не вписан списком): линтер и установленный реестр — один источник.
const SERVERS = require(path.join(CODE, 'common/members')).installedServers.filter(s => s !== 'team');
let RUN;
const matrixRows = [...['codex', 'antigravity', 'deepseek'].map(t => 'claude → ' + t), ...['codex', 'antigravity', 'deepseek'].flatMap(s => ['claude', 'codex', 'antigravity', 'deepseek'].filter(t => t !== s).map(t => s + ' → ' + t)), ...['codex', 'antigravity', 'deepseek'].map(s => s + ' → дирижёр')];
const rightsRows = ['дирижёр → Claude write=true', 'дирижёр → Claude full_access', 'пишущее подпоручение'];
const negativeRows = ['запись через ..', 'запись по абсолютному пути', 'запись через junction', 'запись в корень связки', 'Bash без полного доступа', 'full_access от гостя', 'подпоручение в корень связки', 'подпоручение через junction в корень'];
const requiredRows = [...matrixRows, ...rightsRows, ...negativeRows];
function idOf(value) { return /^Номер поручения: ([a-zA-Z0-9_-]{1,80})\s*$/m.exec(String(value || ''))?.[1] || null; }
function ready(lines) { return lines.length === requiredRows.length && requiredRows.every(name => { const hits = lines.filter(r => r[0] === name); return hits.length === 1 && hits[0][1] === true; }); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nonceFile(s, t) {
  const dir = path.join(RUN, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe-' + s + '-' + t + '.txt');
  const nonce = 'probe-' + s + '-' + t + '-' + crypto.randomUUID();
  fs.writeFileSync(file, nonce);
  return { file, nonce };
}
async function connect(server, client, env = {}) {
  const transport = new StdioClientTransport({ command: NODE,
    args: [path.join(CODE, 'servers', server, 'index.js')], stderr: 'pipe',
    env: { ...process.env, MOST_CLIENT: client, MOST_JOB_ID: '', MOST_PROBE_ONLY: '1', MOST_PROBE_GUEST: 'full', MOST_MATRIX_PROBE: '1',
      MOST_AGY_INPUT_FORMAT: 'legacy', MOST_DSH_NO_PROFILES: '1', ...env } });
  const c = new Client({ name: 'matrix-probe', version: '1' });
  await c.connect(transport);
  return c;
}
const text = r => (r.content || []).map(x => x.text || '').join('\n');
function childCard(id) {
  const store = require(path.join(CODE, 'common/team-store'));
  for (const who of SERVERS) {
    const { jobs } = store.list(who, false);
    const j = jobs.find(x => x.id === id);
    if (j) return { ...j, member: who };
  }
  return null;
}
function savedResult(j) {
  if (!j) return null;
  const store = require(path.join(CODE, 'common/team-store'));
  try { return fs.readFileSync(store.resultPath(j, store.roots()[j.member]), 'utf8'); } catch { return null; }
}
function audit(server) {
  try { return fs.readFileSync(path.join(STATE, 'server-log-' + server + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; }
}
function logMentions(server, childId, parentId) {
  return audit(server).some(e => e.tool === server + '_result' && e.id === childId && e.parentJob === parentId && !e.isError);
}
async function conductorToT(t, lines) {
  const { file, nonce } = nonceFile('claude', t);
  const c = await connect(t, 'claude');
  try {
    const send = await c.callTool({ name: t + '_send', arguments: t === 'antigravity'
      ? { folder: RUN, task: 'прочитай файл ' + file + ' и верни его содержимое дословно', mode: 'review', role: 'совет', text: 'Выполни поручение и верни требуемую строку.' }
      : { folder: RUN, task: 'прочитай файл ' + file + ' и верни его содержимое дословно', role: 'совет' } });
    const id = idOf(text(send));
    if (!id) { lines.push(['claude → ' + t, false, 'нет номера поручения']); return; }
    let done = false, res = null;
    for (let i = 0; i < 120 && !done; i++) {
      res = await c.callTool({ name: t + '_result', arguments: { id } });
      done = /ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|ОТМЕНЕНО|НУЖНО РЕШЕНИЕ|ПОТЕРЯНО/.test(text(res));
      if (!done) await sleep(5000);
    }
    const card = childCard(id);
    const ok = card?.status === 'done' && (savedResult(card) || '').trim() === nonce;
    lines.push(['claude → ' + t, ok, text(res).slice(0, 80)]);
  } finally { await c.close(); }
}
async function sToT(s, t, lines) {
  const { file, nonce } = nonceFile(s, t);
  const cs = await connect(s, 'claude');
  try {
    const task = 'Вызови ' + t + '_send с заданием «прочитай файл ' + file + ' и верни его содержимое дословно», дождись ' +
      t + '_result до конечного состояния, верни ответ дословно, затем отдельной строкой «Номер поручения: <id ребёнка>». Сам файл не читай.';
    const send = await cs.callTool({ name: s + '_send', arguments: s === 'antigravity'
      ? { folder: RUN, task: task, mode: 'review', role: 'совет', text: 'Выполни поручение и верни требуемую строку.' }
      : { folder: RUN, task, role: 'совет' } });
    const parentId = idOf(text(send));
    if (!parentId) { lines.push([s + ' → ' + t, false, 'нет номера поручения S']); return; }
    let done = false, res = null;
    for (let i = 0; i < 120 && !done; i++) {
      res = await cs.callTool({ name: s + '_result', arguments: { id: parentId } });
      done = /ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|ОТМЕНЕНО|НУЖНО РЕШЕНИЕ|ПОТЕРЯНО/.test(text(res));
      if (!done) await sleep(5000);
    }
    const parentResult = savedResult(childCard(parentId)) || '';
    const childId = idOf(parentResult);
    const card = childCard(childId);
    const saved = card && savedResult(card);
    const a = !!card && card.status === 'done';
    const b = !!saved && saved.includes(nonce);
    const c = !!saved && parentResult.replace(/^Номер поручения: [a-zA-Z0-9_-]+\s*$/m, '').trim() === saved.trim();
    const d = !!card && card.from === s && card.parentJob === parentId;
    const e = logMentions(t, childId || '', parentId);
    const ok = a && b && c && d && e;
    lines.push([s + ' → ' + t, ok, [a, b, c, d, e].map((x, i) => 'абвгде'[i] + (x ? '+' : '−')).join(' ')]);
  } finally { await cs.close(); }
}
async function sToConductor(s, lines) {
  const { file, nonce } = nonceFile('ask', s);
  const cs = await connect(s, 'claude');
  try {
    const task = 'Прочитай файл ' + file + ', вызови team_ask с его содержимым в text, дождись team_ask_result, верни ответ дословно и номер запроса.';
    const send = await cs.callTool({ name: s + '_send', arguments: s === 'antigravity'
      ? { folder: RUN, task: task, mode: 'review', role: 'совет', text: 'Выполни поручение и верни требуемую строку.' }
      : { folder: RUN, task, role: 'совет' } });
    const parentId = idOf(text(send));
    if (!parentId) { lines.push([s + ' → дирижёр', false, 'нет номера поручения S']); return; }
    // Дирижёр отвечает через team_inbox строкой-nonce.
    const inbox = await connect('team', 'claude');
    let answered = false, requestId = null;
    try {
      for (let i = 0; i < 40 && !answered; i++) {
        const list = await inbox.callTool({ name: 'team_inbox', arguments: { action: 'list' } });
        const row = require(path.join(CODE, 'common/inbox')).pending().find(e => e.author?.id === parentId && e.text.includes(nonce));
        const id = row?.id;
        if (id && text(list).includes(nonce)) {
          await inbox.callTool({ name: 'team_inbox', arguments: { action: 'answer', id, text: 'ответ-' + nonce } });
          answered = true; requestId = id;
        }
        if (!answered) await sleep(3000);
      }
    } finally { await inbox.close(); }
    let res = null;
    for (let i = 0; i < 40; i++) {
      res = await cs.callTool({ name: s + '_result', arguments: { id: parentId } });
      if (/ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|ОТМЕНЕНО/.test(text(res))) break;
      await sleep(3000);
    }
    const entry = requestId && require(path.join(CODE, 'common/inbox')).read(requestId);
    const observed = audit('team').some(e => e.tool === 'team_ask_result' && e.id === requestId && e.parentJob === parentId && !e.isError);
    const answer = savedResult(childCard(parentId)) || '';
    const ok = answered && entry?.author?.id === parentId && entry.text.includes(nonce) && observed && answer.includes(entry.answer);
    lines.push([s + ' → дирижёр', ok, text(res).slice(0, 80)]);
  } finally { await cs.close(); }
}
// Права и отрицательные испытания (вне 15, обязательны).
async function rights(lines) {
  // Дирижёр → Claude-исполнитель write=true: файл с nonce создан в folder.
  const folder = fs.mkdtempSync(path.join(RUN, 'claude-write-'));
  const nonce = 'claude-write-' + crypto.randomUUID();
  const cc = await connect('claude', 'claude');
  try {
    const send = await cc.callTool({ name: 'claude_send', arguments: { folder, write: true, role: 'текст', task: 'создай файл nonce.txt с содержимым ' + nonce } });
    const id = idOf(text(send));
    let res = null;
    for (let i = 0; i < 120; i++) {
      res = await cc.callTool({ name: 'claude_result', arguments: { id } });
      if (/ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|ОТМЕНЕНО/.test(text(res))) break;
      await sleep(5000);
    }
    const created = childCard(id)?.status === 'done' && fileEquals(path.join(folder, 'nonce.txt'), nonce);
    lines.push(['дирижёр → Claude write=true', created, text(res).slice(0, 60)]);
    // Полный доступ: команда выполнена.
    const send2 = await cc.callTool({ name: 'claude_send', arguments: { folder, write: true, full_access: true, role: 'совет', task: 'выполни команду echo ' + nonce + ' > command.txt в папке поручения и верни вывод' } });
    const id2 = idOf(text(send2));
    let res2 = null;
    for (let i = 0; i < 120; i++) {
      res2 = await cc.callTool({ name: 'claude_result', arguments: { id: id2 } });
      if (/ОТВЕТ ПОЛУЧЕН|НЕ УДАЛОСЬ|ОТМЕНЕНО/.test(text(res2))) break;
      await sleep(5000);
    }
    lines.push(['дирижёр → Claude full_access', childCard(id2)?.fullAccessApplied === true && fileEquals(path.join(folder, 'command.txt'), nonce), 'id=' + id2 + '; nonce=' + nonce]);
  } finally { await cc.close(); }
}
function fileEquals(file, expected) { try { return fs.readFileSync(file, 'utf8').trim() === expected; } catch { return false; } }
async function waitFor(c, who, id) {
  if (!id) return null;
  for (let i = 0; i < 120; i++) {
    const r = await c.callTool({ name: who + '_result', arguments: { id, wait_sec: 5 } });
    const card = childCard(id);
    if (card && !['running', 'queued', 'waiting_quota', 'cancelling'].includes(card.status)) return card;
    if (r.isError) return null;
    await sleep(1000);
  }
  return null;
}
async function writingChild(lines) {
  const parentFolder = path.join(RUN, 'writing-parent'), childFolder = path.join(RUN, 'writing-child');
  for (const d of [parentFolder, childFolder]) fs.mkdirSync(d, { recursive: true });
  const nonce = crypto.randomUUID(), c = await connect('codex', 'claude');
  try {
    const r = await c.callTool({ name: 'codex_send', arguments: { folder: parentFolder, write: true, role: 'совет', task:
      'Вызови deepseek_send с folder=' + childFolder + ', write=true, role=текст, task=создай nonce.txt с содержимым ' + nonce +
      '. Дождись deepseek_result. Сам в папку ребёнка не пиши. Верни отдельной строкой «Номер поручения: <id ребёнка>».' } });
    const id = idOf(text(r)), p = await waitFor(c, 'codex', id), child = childCard(idOf(savedResult(p)));
    const ok = p?.status === 'done' && child?.status === 'done' && child.write === true && child.parentJob === id && child.from === 'codex' &&
      logMentions('deepseek', child.id, id) && fileEquals(path.join(childFolder, 'nonce.txt'), nonce);
    lines.push(['пишущее подпоручение', !!ok, 'parent=' + id + '; child=' + child?.id + '; nonce=' + nonce]);
  } finally { await c.close(); }
}
async function negativeTrials(lines) {
  const folder = path.join(RUN, 'negative-writer'), external = path.join(RUN, 'negative-outside');
  for (const d of [folder, external]) fs.mkdirSync(d, { recursive: true });
  const junction = path.join(folder, 'outside-link'); fs.symlinkSync(external, junction, 'junction');
  const rootLink = path.join(folder, 'root-link'); fs.symlinkSync(ROOT, rootLink, 'junction');
  const cases = [
    ['запись через ..', path.join(external, 'relative.txt'), '../negative-outside/relative.txt'],
    ['запись по абсолютному пути', path.join(external, 'absolute.txt'), path.join(external, 'absolute.txt')],
    ['запись через junction', path.join(external, 'junction.txt'), path.join(junction, 'junction.txt')],
    ['запись в корень связки', path.join(ROOT, 'matrix-denied-' + crypto.randomUUID() + '.txt')],
  ];
  const c = await connect('claude', 'claude');
  try {
    for (const [name, target, requested = target] of cases) {
      // Существующие контрольные файлы вне связки; внутри связки проверяется только новое уникальное имя.
      const sentinel = 'before-' + crypto.randomUUID();
      if (name !== 'запись в корень связки') fs.writeFileSync(target, sentinel);
      const r = await c.callTool({ name: 'claude_send', arguments: { folder, write: true, role: 'совет',
        task: 'Отрицательная проба разрешений: попытайся через Edit изменить файл ' + requested + ' на DENIED-PROBE. Не обходи отказ другим способом. Сообщи результат инструмента.' } });
      const id = idOf(text(r)), card = await waitFor(c, 'claude', id);
      const denied = card?.permissionDenials?.some(d => ['Edit', 'Write'].includes(d.tool_name || d.tool) &&
        [requested, target].includes(d.tool_input?.file_path || d.input?.file_path));
      const unchanged = name === 'запись в корень связки' ? !fs.existsSync(target) : fileEquals(target, sentinel);
      lines.push([name, !!(card?.status === 'done' && denied && unchanged), 'id=' + id + '; путь=' + requested + '; подтверждённый отказ=' + !!denied]);
    }
    const marker = path.join(folder, 'bash.txt');
    const r = await c.callTool({ name: 'claude_send', arguments: { folder, write: true, role: 'совет', task: 'Попытайся вызвать Bash с командой echo denied > bash.txt. Другие инструменты для записи не используй.' } });
    const id = idOf(text(r)), card = await waitFor(c, 'claude', id);
    lines.push(['Bash без полного доступа', !!(card?.status === 'done' && Array.isArray(card.enabledTools) && !card.enabledTools.includes('Bash') && !fs.existsSync(marker)), 'id=' + id]);
  } finally { await c.close(); }
  const guest = await connect('claude', 'codex');
  try {
    const r = await guest.callTool({ name: 'claude_send', arguments: { folder, write: true, full_access: true, role: 'совет', task: 'Отрицательная проба полного доступа' } });
    lines.push(['full_access от гостя', r.isError === true && /полный доступ/.test(text(r)), text(r).slice(0, 180)]);
  } finally { await guest.close(); }
  const parent = await connect('codex', 'claude');
  try {
    for (const [name, target] of [['подпоручение в корень связки', ROOT], ['подпоручение через junction в корень', rootLink]]) {
      const r = await parent.callTool({ name: 'codex_send', arguments: { folder: external, write: true, role: 'совет', task:
        'Отрицательная проба: вызови claude_send с folder=' + target + ', write=true, role=совет, task=проба записи. Не обходи отказ. Верни текст отказа.' } });
      const id = idOf(text(r)); await waitFor(parent, 'codex', id);
      const refusal = audit('claude').some(e => e.parentJob === id && e.tool === 'claude_send' && e.folder === target && e.write === true && e.isError && /Запись запрещена/.test(e.response || ''));
      lines.push([name, refusal, 'id=' + id + '; folder=' + target]);
    }
  } finally { await parent.close(); }
}
async function main() {
  RUN = fs.mkdtempSync(path.join(require('os').tmpdir(), 'matrix-probe-'));
  const lines = [];
  for (const t of ['codex', 'antigravity', 'deepseek']) await conductorToT(t, lines);
  for (const s of ['codex', 'antigravity', 'deepseek']) for (const t of ['claude', 'codex', 'antigravity', 'deepseek']) {
    if (s !== t) await sToT(s, t, lines);
  }
  for (const s of ['codex', 'antigravity', 'deepseek']) await sToConductor(s, lines);
  await rights(lines); await writingChild(lines); await negativeTrials(lines);
  for (const [name, ok, note] of lines) console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + ' · ' + note);
  const ok = ready(lines);
  fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify({ at: new Date().toISOString(), ok, lines }, null, 2));
  console.log('Итог: ' + (ok ? 'готово' : 'не готово') + '; пройдено ' + lines.filter(l => l[1]).length + '/' + requiredRows.length + '; отчёт: ' + RUN);
  return ok ? 0 : 1;
}
module.exports = { idOf, ready, requiredRows, matrixRows, rightsRows, negativeRows, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error('Проба прервана: ' + e.message); process.exitCode = 2; });
