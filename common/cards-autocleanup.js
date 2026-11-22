'use strict';
// team-v59 (часть 3, дополнение 2): авто-уборка конечных карточек поручений. Те же правила, что в разовой уборке
// (E:\Codex\work\v59-cards-cleanup\build-plan.js): удаляем набор путей поручения, только если
//   1) статус конечный: done, applied, cancelled, failed, lost (ровно STABLE_STATUS);
//   2) самый свежий файл набора старше 7 суток;
//   3) нет ссылки на номер из ОТКРЫТЫХ работ (works/*.json, closed!=true) и ОТКРЫТЫХ изменений связки
//      (state/team/changes/*.json, статус не «слито/закрыто/закрыто без слияния»);
//   4) нет ссылки из замков (state/locks/**) и admission/reservation (state/admissions/*.json);
//   5) карточка читается и разбирается.
// Нечитаемые и незнакомые статусы НЕ трогаются. Запускается сервером team в фоне после ответа на initialize, не чаще раза
// в сутки (метка времени на диске). Пишет одну строку в журнал моста: «удалено N».
const fs = require('fs'), path = require('path');
const STABLE = new Set(['done', 'applied', 'cancelled', 'failed', 'lost']);
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const AGY = /\b[a-z0-9]{8}_[0-9a-f]{6}\b/g;
const STORES = ['codex-jobs', 'deepseek-jobs', 'grok-jobs', 'claude-jobs', 'kimi-jobs', 'jobs'];
const WEEK = 7 * 86400000;

function tokens(text, set) {
  for (const m of text.matchAll(UUID)) set.add(m[0].toLowerCase());
  for (const m of text.matchAll(AGY)) set.add(m[0]);
}
function walk(p, cb) {
  let st; try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory()) { let e; try { e = fs.readdirSync(p); } catch { return; } for (const n of e) walk(path.join(p, n), cb); }
  else cb(p, st);
}
function newestMtime(paths) { let m = 0; for (const p of paths) walk(p, (_, st) => { if (st.mtimeMs > m) m = st.mtimeMs; }); return m; }

function referenceSets(stateDir, repoRoot) {
  const refOpen = new Set(), lockRefs = new Set();
  const changes = path.join(stateDir, 'team', 'changes'), works = path.join(repoRoot, 'works');
  for (const n of safeReaddir(changes)) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(changes, n); let text, c;
    try { text = fs.readFileSync(f, 'utf8'); c = JSON.parse(text); } catch { continue; }
    if (!['слито', 'закрыто без слияния', 'закрыто'].includes(c.status)) tokens(text, refOpen);
  }
  for (const n of safeReaddir(works)) {
    if (!n.endsWith('.json') || n === 'status.md') continue;
    const f = path.join(works, n); let text, w;
    try { text = fs.readFileSync(f, 'utf8'); w = JSON.parse(text); } catch { continue; }
    if (w.closed !== true) tokens(text, refOpen);
  }
  walk(path.join(stateDir, 'locks'), f => { if (f.endsWith('.json')) try { tokens(fs.readFileSync(f, 'utf8'), lockRefs); } catch {} });
  walk(path.join(stateDir, 'admissions'), f => { if (f.endsWith('.json')) try { tokens(fs.readFileSync(f, 'utf8'), lockRefs); } catch {} });
  return { refOpen, lockRefs };
}
function safeReaddir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// Собирает набор удаляемых поручений по правилам; apply=false — только подсчёт/список (сухой прогон).
function plan(stateDir, repoRoot, now = Date.now()) {
  const cutoff = now - WEEK;
  const { refOpen, lockRefs } = referenceSets(stateDir, repoRoot);
  const result = { del: [], counts: { total: 0, del: 0, young: 0, nonfinal: 0, ref: 0, lock: 0, unreadable: 0 } };
  for (const store of STORES) {
    const dir = path.join(stateDir, store);
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const groups = new Map();
    for (const e of ents) {
      const name = e.name;
      if (/\.conflict-|^\./.test(name) || name.endsWith('.tmp')) continue;
      const id = e.isDirectory() ? name : name.split('.')[0];
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(name);
    }
    for (const [id, names] of groups) {
      const bundleCard = path.join(dir, id, 'card.json'), flatCard = path.join(dir, id + '.json');
      const cardFile = fs.existsSync(bundleCard) ? bundleCard : fs.existsSync(flatCard) ? flatCard : null;
      if (!cardFile) continue; // огрызок без карточки — не трогаем
      result.counts.total++;
      let card; try { card = JSON.parse(fs.readFileSync(cardFile, 'utf8').replace(/^﻿/, '')); if (!card || typeof card !== 'object') throw 0; }
      catch { result.counts.unreadable++; continue; } // нечитаемая — не трогаем
      if (!STABLE.has(card.status)) { result.counts.nonfinal++; continue; } // незнакомый/неконечный — не трогаем
      const paths = names.map(n => path.join(dir, n)), lid = id.toLowerCase();
      if (newestMtime(paths) >= cutoff) { result.counts.young++; continue; }
      if (refOpen.has(id) || refOpen.has(lid)) { result.counts.ref++; continue; }
      if (lockRefs.has(id) || lockRefs.has(lid)) { result.counts.lock++; continue; }
      result.del.push({ store, id, status: card.status, cardFile, paths });
      result.counts.del++;
    }
  }
  return result;
}

function removeSet(entry, stateDir, now = Date.now()) {
  const cutoff = now - WEEK;
  // Защитная перепроверка в момент удаления: статус ещё конечный, набор старше отсечки, пути внутри хранилища.
  let card; try { card = JSON.parse(fs.readFileSync(entry.cardFile, 'utf8').replace(/^﻿/, '')); } catch { return false; }
  if (!STABLE.has(card.status)) return false;
  if (newestMtime(entry.paths) >= cutoff) return false;
  const root = path.resolve(stateDir);
  for (const p of entry.paths) if (!path.resolve(p).startsWith(root + path.sep)) return false;
  for (const p of entry.paths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  return true;
}

function logLine(stateDir, n) {
  try {
    const f = path.join(stateDir, 'team', 'cleanup-log.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), kind: 'cards-autocleanup', removed: n }) + '\n');
  } catch {}
  // Одна строка в журнал моста (stderr сервера).
  console.error('team: авто-уборка карточек — удалено ' + n);
}

function run({ stateDir, repoRoot, now = Date.now(), apply = true } = {}) {
  const p = plan(stateDir, repoRoot, now);
  let removed = 0;
  if (apply) for (const entry of p.del) if (removeSet(entry, stateDir, now)) removed++;
  return { removed, planned: p.counts.del, counts: p.counts };
}

// Троттлинг: не чаще раза в сутки. Метка — <stateDir>/cards-autocleanup-last.json.
function marker(stateDir) { return path.join(stateDir, 'cards-autocleanup-last.json'); }
function due(stateDir, now = Date.now(), everyMs = 86400000) {
  try { const m = JSON.parse(fs.readFileSync(marker(stateDir), 'utf8')); return now - Date.parse(m.at) >= everyMs; } catch { return true; }
}
function maybeRun({ stateDir, repoRoot, now = Date.now(), everyMs = 86400000 } = {}) {
  if (!due(stateDir, now, everyMs)) return { skipped: true };
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(marker(stateDir), JSON.stringify({ at: new Date(now).toISOString() })); } catch {}
  const r = run({ stateDir, repoRoot, now });
  logLine(stateDir, r.removed);
  return r;
}

module.exports = { plan, run, maybeRun, due, STABLE, STORES };
