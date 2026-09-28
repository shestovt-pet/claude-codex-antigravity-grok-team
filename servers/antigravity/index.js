#!/usr/bin/env node
// Мост: Cowork ↔ Antigravity, версия 0.5.7.
//
// Файлы между диском и Antigravity возит мост, а не Claude:
//   most_poruchit  — мост сам читает файл, сам отдаёт текст Antigravity;
//   most_itog      — мост проверяет ответ, хранит результат задания отдельно
//                    и показывает список изменений (постранично) или замечания;
//   most_perenesti — мост сам переносит результат ЭТОГО задания в рабочий файл;
//   most_otmenit   — остановить задание (в том числе запущенное другим экземпляром моста);
//   most_zdorovie  — проверка моста, моделей и идущих заданий.
//
// Мост не передаёт Antigravity флагов, разрешающих запись, и запрещает запись
// текстом поручения. Технической изоляции мост не устанавливает.
//
// Межпроцессные замки — именованные каналы ОС (Windows: \\.\pipe\…, Linux:
// абстрактные сокеты): ОС сама освобождает их, когда процесс-владелец умирает.
//
// Поиск agy на диске взят из mcp-server-google-antigravity
// (MIT License, © Türker Yakup Altınsoy).

"use strict";


const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { spawn, execSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const keepUnlink=(...a)=>{if(!process.env.MOST_TEST_KEEP) fs.unlinkSync(...a);};
const keepRm=(...a)=>{if(!process.env.MOST_TEST_KEEP) fs.rmSync(...a);};
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const access = require('../../common/access');
const VERSION = "0.5.7";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

// ---------- настройки ----------
const agyInput = require('../../common/agy-input');
// До живой проверки 1.2.12 прежний путь сохраняется; stream-json включается явно.
const STREAM_INPUT = process.env.MOST_AGY_INPUT_FORMAT !== 'legacy';
const PRINT_TIMEOUT = process.env.MOST_PRINT_TIMEOUT || "15m";
const WATCHDOG_MS = Number(process.env.MOST_WATCHDOG_MS || 16 * 60 * 1000);
const MAX_INLINE_CHARS = Number(process.env.MOST_MAX_INLINE || "24000");   // предел командной строки для обычного режима (с учётом экранирования)
const PORUCHENIE_FILE_THRESHOLD = 6000;                                    // длинное поручение в файловом режиме — тоже файлом
const MAX_CMDLINE_CHARS = 30000;                                           // жёсткий предел (Windows: 32767)
const MAX_SOURCE_BYTES = Number(process.env.MOST_MAX_SOURCE_BYTES || 8 * 1024 * 1024);
const DRAFT_NAME = "_antigravity_result.txt";
const STATE_DIR = require('../../common/paths').stateDir;
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const LOCKS_DIR = path.join(STATE_DIR, "locks");
const INPUT_DIR = path.resolve(process.env.MOST_INPUT_DIR || path.join(STATE_DIR, "input"));
const LEGACY_JOBS_DIR = path.join(os.tmpdir(), "most_jobs");
const JOURNAL = process.env.MOST_JOURNAL || path.join(STATE_DIR, "antigravity.log");
const CANCEL_POLL_MS = 1000;
const STOP_CONFIRM_MS = 10000;
const PROBE_TIMEOUT_MS = 2000;
const PAGE_BLOCKS = 40;
const PAGE_CHARS = 40000;
const MAX_LINE_SHOW = 300;
const DIFF_MAX_CELLS = 16 * 1000 * 1000;
const KEEP_JOBS_DAYS = 30;
// только для автотестов
const TEST_DRAFT_DELAY_MS = Number(process.env.MOST_TEST_DRAFT_DELAY_MS || 0);
const TEST_PUBLISH_DELAY_MS = Number(process.env.MOST_TEST_PUBLISH_DELAY_MS || 0);
const TEST_NORMALIZE_DELAY_MS = Number(process.env.MOST_TEST_NORMALIZE_DELAY_MS || 0);

for (const d of [JOBS_DIR, LOCKS_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

const { INSTANCE, STARTED_AT } = require("../../common/locks");

const RUNNING = new Map();   // jobId -> { proc, stopping, reason, unconfirmed }
const ACTIVE = new Set();    // задания, чей runJob ещё не закончил работу в этом экземпляре
const APPLYING = new Set();  // задания, которые этот экземпляр сейчас переносит
let shuttingDown = false;
let instanceServer = null;
let instancePipeOk = false;

// ---------- мелочи ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function words(text) { return (String(text).match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length; }
function nowIso() { return new Date().toISOString(); }
function errText(e) { return require('../../common/errors').errorText(e); }
function execFileP(bin, args, opts) {
  return new Promise((resolve) => {
    execFile(bin, args, Object.assign({ encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, opts || {}), (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

// ---------- журнал (без текстов пользователя) ----------
function rotateJournal() {
  try {
    const st = fs.statSync(JOURNAL);
    if (st.size > 1024 * 1024) fs.renameSync(JOURNAL, JOURNAL.replace(/\.txt$/i, "") + ".old.txt");
  } catch (e) {}
}
function log(msg) {
  try { fs.appendFileSync(JOURNAL, nowIso() + " [pid " + process.pid + "] " + msg + "\n", "utf8"); } catch (e) {}
}

// ---------- поиск agy (из mcp-server-google-antigravity) ----------
function shortPathWin(p) {
  try {
    const out = execSync('for %I in ("' + p + '") do @echo %~sI', { encoding: "utf8", windowsHide: true })
      .trim().split(/\r?\n/).filter(Boolean)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}
  return p;
}

function findAgy() {
  const custom = process.env.AGY_PATH;
  if (custom) {
    // для автотестов: поддельный agy в виде .js запускается через node
    if (/\.(c?js|mjs)$/i.test(custom)) return { bin: process.execPath, pre: [path.resolve(custom)], shown: custom };
    return { bin: isWindows ? shortPathWin(custom) : custom, pre: [], shown: custom };
  }
  if (isWindows) {
    try {
      const out = execSync('for /f "delims=" %I in (\'where agy\') do @echo %~sI', { encoding: "utf8", windowsHide: true })
        .trim().split(/\r?\n/).filter(Boolean)[0];
      if (out && fs.existsSync(out)) return { bin: out, pre: [], shown: out };
    } catch (e) {}
    const guess = path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe");
    if (fs.existsSync(guess)) return { bin: shortPathWin(guess), pre: [], shown: guess };
  }
  try {
    const p = execSync(isWindows ? "where agy" : "which agy", { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
    return p ? { bin: p, pre: [], shown: p } : null;
  } catch (e) { return null; }
}
const AGY = findAgy();

// ---------- очистка вывода терминала (из mcp-server-google-antigravity) ----------
function stripAnsi(str) {
  return String(str || "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

// Оценка длины командной строки Windows после экранирования аргументов.
function cmdlineLength(bin, args) {
  let n = String(bin).length + 3;
  for (const a of args) {
    const s = String(a);
    n += s.length + 3 + (s.match(/["\\]/g) || []).length * 2;
  }
  return n;
}

// ---------- процессы ----------
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return "yes"; }
  catch (e) { return e.code === "ESRCH" ? "no" : (e.code === "EPERM" ? "yes" : "unknown"); }
}
// Останавливает процесс agy вместе с потомками. Только собственный процесс (есть proc).
async function killTree(proc, taskkillTimeoutMs) {
  const pid = proc && proc.pid;
  if (process.env.MOST_TEST_KILLTREE_HANG === "1") return new Promise(() => {}); // только для автотестов: «завис taskkill»
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, note: "нет номера процесса" };
  if (isWindows) {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const r = await execFileP(fs.existsSync(taskkill) ? taskkill : "taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: taskkillTimeoutMs || 15000, encoding: "buffer" });
    if (!r.err) return { ok: true, tree: true };
    // taskkill не смог (например, нет прав на открытие по номеру) — останавливаем хотя бы сам процесс через свой дескриптор
    try { proc.kill(); } catch (e) {}
    return { ok: true, tree: false, note: "taskkill завершился с кодом " + (r.err.code != null ? r.err.code : "?") + "; остановлен только основной процесс agy, его потомки могли остаться" };
  }
  try { process.kill(-pid, "SIGKILL"); return { ok: true, tree: true }; } catch (e) {}
  try { proc.kill("SIGKILL"); return { ok: true, tree: false, note: "группа процессов недоступна; остановлен только основной процесс" }; }
  catch (e) { return { ok: false, note: errText(e) }; }
}

// Немедленная остановка собственного процесса через его дескриптор (без taskkill).
function hardKillOwn(proc) {
  if (!proc || !proc.pid) return;
  if (!isWindows) { try { process.kill(-proc.pid, "SIGKILL"); return; } catch (e) {} }
  try { proc.kill("SIGKILL"); } catch (e) {}
}

// ---------- межпроцессные замки на именованных каналах ----------
const { pipeName, probe, listenPipe, tryLock, waitLock, ownerState } = require("../../common/locks");
// Карточку задания меняем только под замком задания: прочитать свежую → изменить → сохранить.
async function updateJob(id, mutator, waitMs) {
  const l = await waitLock("job", id, { jobId: id }, waitMs == null ? 8000 : waitMs);
  if (!l.ok) throw new Error(l.busy ? "карточка задания занята другим процессом" : ("замок задания: " + l.error));
  try {
    const cur = loadJob(id);
    if (!cur || cur.corrupt) throw new Error(cur ? "карточка повреждена: " + cur.error : "карточки задания нет");
    const before = { ...cur };
    const res = await mutator(cur);
    if (res !== false) { saveJob(cur); require('../../common/notify').transition('Antigravity', before, cur); }
    return cur;
  } finally { await l.release(); }
}

// Состояние экземпляра моста-владельца: self | alive | dead | unknown (канал есть, но не отвечает).
const OWNER_WORDS = { self: "этот экземпляр моста", alive: "другой экземпляр моста (работает)", dead: "экземпляр моста, которого уже нет", unknown: "экземпляр моста, который не отвечает" };

// ---------- файлы: чтение ----------
const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
function friendlyFsError(e, target, verb) {
  if (e && BUSY_CODES.has(e.code)) {
    const x = new Error("файл занят другой программой или нет прав на " + (verb || "доступ") + " (" + e.code + "): " + target);
    x.code = e.code;
    return x;
  }
  return e;
}
// Читает исходник как байты: хеш — по байтам, текст — без BOM. Не UTF-8 — отказ.
function readSource(p) {
  let st, bytes;
  try { st = fs.statSync(p); } catch (e) { throw friendlyFsError(e, p, "чтение"); }
  if (!st.isFile()) throw new Error("это не файл: " + p);
  if (st.size > MAX_SOURCE_BYTES) throw new Error("файл слишком большой для моста (" + Math.round(st.size / 1024) + " КБ): " + p);
  try { bytes = fs.readFileSync(p); } catch (e) { throw friendlyFsError(e, p, "чтение"); }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  const text = body.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(body)) throw new Error("файл не в кодировке UTF-8 (мост работает только с обычным текстом UTF-8): " + p);
  return { bytes, hash: sha(bytes), bom, text };
}
function readTextLoose(p) {
  let t;
  try { t = fs.readFileSync(p, "utf8"); } catch (e) { throw friendlyFsError(e, p, "чтение"); }
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}
// Хеш файла: { hash } | { missing: true } | { error }.
function hashFile(p) {
  try { return { hash: sha(fs.readFileSync(p)) }; }
  catch (e) { return e.code === "ENOENT" ? { missing: true } : { error: friendlyFsError(e, p, "чтение").message }; }
}

// Строки вместе с их окончаниями: ["a\r\n", "b\n", "c"].
function splitKeep(text) {
  const out = [];
  const re = /[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g;
  let m;
  while ((m = re.exec(text)) !== null) { if (m[0] === "") break; out.push(m[0]); }
  return out;
}
function lineBody(l) { return l.replace(/(\r\n|\n|\r)$/, ""); }
function lineEnd(l) { const m = String(l || "").match(/(\r\n|\n|\r)$/); return m ? m[1] : ""; }
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf) return "\r";
  return "\n";
}
function splitLines(text) { return text.replace(/\r\n?/g, "\n").split("\n"); }

// ---------- пути: «внутри проекта» по реальным путям ----------
// Защищает от уже существующих ссылок и junction; не защищает от одновременной злонамеренной подмены папок.
const { canon, canonMaybe, isInsideReal, samePath } = require("../../common/paths");
// ---------- файлы: безопасная запись ----------
function tmpNameFor(target) {
  return path.join(path.dirname(target), ".~most-" + path.basename(target) + "-" + crypto.randomBytes(4).toString("hex") + ".tmp");
}
function writeAll(fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error("запись на диск не продвигается");
    off += n;
  }
}
// Временный файл рядом с целью: полная запись + fsync; при ошибке временный файл удаляется.
function writeTmp(target, data) {
  const tmp = tmpNameFor(target);
  let fd;
  try { fd = fs.openSync(tmp, "wx"); } catch (e) { throw friendlyFsError(e, target, "запись в эту папку"); }
  try { writeAll(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; return tmp; }
  catch (e) {
    try { if (fd != null) fs.closeSync(fd); } catch (e2) {}
    try { keepUnlink(tmp); } catch (e3) {}
    throw e;
  }
}
// Заменить (или создать) файл целиком: временный файл + rename; verify() — перед каждой попыткой.
async function replaceFileAtomic(target, data, verify) {
  const tmp = writeTmp(target, data);
  let delay = 100;
  const deadline = Date.now() + 5000;
  try {
    for (;;) {
      if (verify) { const v = verify(); if (v !== true) { const e = new Error(v || "проверка перед записью не прошла"); e.code = "EVERIFY"; throw e; } }
      try { fs.renameSync(tmp, target); return; }
      catch (e) {
        if (!BUSY_CODES.has(e.code) || Date.now() + delay > deadline) throw friendlyFsError(e, target, "замену");
        await sleep(delay); delay = Math.min(delay * 2, 1000);
      }
    }
  } finally { try { if (fs.existsSync(tmp)) keepUnlink(tmp); } catch (e) {} }
}
// Синхронный вариант для служебных файлов (карточки, результаты).
function replaceFileAtomicSync(target, data) {
  const tmp = writeTmp(target, data);
  try {
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, target); return; }
      catch (e) {
        if (!BUSY_CODES.has(e.code) || i >= 8) throw friendlyFsError(e, target, "замену");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
      }
    }
  } finally { try { if (fs.existsSync(tmp)) keepUnlink(tmp); } catch (e) {} }
}
// Создать НОВЫЙ файл, не перезаписывая существующий (даже появившийся в последний момент).
function publishNewFile(target, data) {
  const tmp = writeTmp(target, data);
  const exists = () => { const x = new Error("файл уже есть: " + target); x.code = "EEXIST"; return x; };
  try {
    try { fs.linkSync(tmp, target); return "link"; }
    catch (e) {
      if (e.code === "EEXIST") throw exists();
      // файловая система без жёстких ссылок — создаём с флагом «только новый»
      let fd;
      try { fd = fs.openSync(target, "wx"); }
      catch (e2) { if (e2.code === "EEXIST") throw exists(); throw friendlyFsError(e2, target, "создание файла"); }
      try { writeAll(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; }
      catch (e3) { try { if (fd != null) fs.closeSync(fd); } catch (e4) {} try { keepUnlink(target); } catch (e5) {} throw e3; }
      return "exclusive";
    }
  } finally { try { if (fs.existsSync(tmp)) keepUnlink(tmp); } catch (e) {} }
}
function withBom(text, bom) {
  const b = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b;
}

// ---------- задания: хранение ----------
function newJobId() { return Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"); }
function jobDir(id) { return path.join(JOBS_DIR, String(id).replace(/[^\w.-]/g, "_")); }
function cardPath(id) { return path.join(jobDir(id), "card.json"); }
function resultPath(id) { return path.join(jobDir(id), "result.txt"); }
function metaPath(id) { return path.join(jobDir(id), "meta.json"); }
function cancelPath(id) { return path.join(jobDir(id), "cancel"); }
let testFailSaveDone = process.env.MOST_TEST_FAIL_SAVE_DONE === "1"; // только для автотестов: один сбой сохранения «готово»
function saveJob(job) {
  if (testFailSaveDone && job.status === "done") { testFailSaveDone = false; throw new Error("тестовый сбой сохранения карточки"); }
  replaceFileAtomicSync(cardPath(job.id), JSON.stringify(job, null, 1));
}
// Результат уже зафиксирован (result.txt + meta.json совпадают)? Тогда задание — готово.
function committedMeta(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
    const t = fs.readFileSync(resultPath(id), "utf8");
    return sha(t) === meta.hash ? meta : null;
  } catch (e) { return null; }
}
function loadJob(id) {
  const p = cardPath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return { id, corrupt: true, error: errText(e) }; }
}
function listJobs() {
  const out = [];
  try { for (const d of fs.readdirSync(JOBS_DIR)) { const j = loadJob(d); if (j && !j.corrupt) out.push(j); } } catch (e) {}
  return out;
}
function readResult(job) {
  const p = resultPath(job.id);
  if (!fs.existsSync(p)) return { error: "файла результата нет: " + p };
  let t;
  try { t = fs.readFileSync(p, "utf8"); } catch (e) { return { error: friendlyFsError(e, p, "чтение").message }; }
  if (job.resultHash && sha(t) !== job.resultHash) return { error: "файл результата не совпадает с сохранённым хешем (повреждён или правлен): " + p };
  return { text: t };
}
// Незнакомое или повреждённое состояние сохраняем: завершение не доказано.
function isFinalJob(job) {
  return job && !job.corrupt && ['done', 'applied', 'failed', 'cancelled', 'lost'].includes(job.status);
}
function pruneOld() {
  const cutoff = Date.now() - KEEP_JOBS_DAYS * 24 * 3600 * 1000;
  try {
    for (const d of fs.readdirSync(JOBS_DIR)) {
      const p = path.join(JOBS_DIR, d);
      try {
        const c = path.join(p, "card.json");
        const st = fs.statSync(fs.existsSync(c) ? c : p);
        const j = loadJob(d);
        if (st.mtimeMs < cutoff && (!j || isFinalJob(j))) keepRm(p, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (e) {}
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(LOCKS_DIR)) {
      const p = path.join(LOCKS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < dayAgo) keepRm(p, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
  try {
    if (fs.existsSync(INPUT_DIR)) for (const d of fs.readdirSync(INPUT_DIR)) {
      const p = path.join(INPUT_DIR, d);
      try {
        const job = loadJob(d);
        if (fs.statSync(p).mtimeMs < dayAgo && (!job || isFinalJob(job))) keepRm(p, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (e) {}
}

// ---------- восстановление состояния заданий ----------
// Приводит карточку в соответствие с реальностью (потерянный владелец, прерванный перенос). Под замком задания.
async function normalizeJob(job) {
  if (access.guest()) return job;
  if (!job || job.corrupt) return job;
  if (job.status === "running") {
    const st = await ownerState(job.owner);
    if (st === "alive" || st === "unknown" || (st === "self" && ACTIVE.has(job.id))) return job;
    try {
      return await updateJob(job.id, async (cur) => {
        if (cur.status !== "running") return false; // пока мы решали, карточку уже обновили
        const st2 = await ownerState(cur.owner);
        if (st2 === "alive" || st2 === "unknown" || (st2 === "self" && ACTIVE.has(cur.id))) return false;
        let meta = null, resText = null;
        try { meta = JSON.parse(fs.readFileSync(metaPath(job.id), "utf8")); } catch (e) {}
        try { resText = fs.readFileSync(resultPath(job.id), "utf8"); } catch (e) {}
        if (meta && resText != null && sha(resText) === meta.hash) {
          Object.assign(cur, { status: "done", resultHash: meta.hash, words: meta.words, warnings: meta.warnings || [], problems: [],
            finishedAt: meta.finishedAt, durationSec: meta.durationSec, usage: meta.usage || null, draftStatus: "not_attempted",
            recovered: "результат был зафиксирован, но владелец задания завершился до обновления карточки" });
        } else {
          Object.assign(cur, { status: "lost", finishedAt: nowIso(),
            problems: ["связь с владельцем задания потеряна (" + OWNER_WORDS.dead + "); подтверждённого готового результата нет"] });
        }
        log("задание " + job.id + ": владелец потерян → " + cur.status);
      });
    } catch (e) { return job; }
  }
  if (job.status === "applying" && job.apply) {
    const st = await ownerState(job.apply.owner);
    if (st === "alive" || st === "unknown" || (st === "self" && APPLYING.has(job.id))) return job;
    if (TEST_NORMALIZE_DELAY_MS) await sleep(TEST_NORMALIZE_DELAY_MS);
    try {
      return await updateJob(job.id, async (cur) => {
        if (cur.status !== "applying" || !cur.apply) return false;
        if (cur.apply.attempt !== job.apply.attempt) return false; // это уже другая попытка переноса
        const st2 = await ownerState(cur.apply.owner);
        if (st2 === "alive" || st2 === "unknown" || (st2 === "self" && APPLYING.has(cur.id))) return false;
        const f = hashFile(cur.apply.target);
        if (f.error) { cur.status = "apply_unclear"; cur.applyNote = "перенос прервался, а файл сейчас не читается: " + f.error; }
        else if (f.hash && f.hash === cur.apply.newHash) { cur.status = "applied"; cur.appliedAt = cur.appliedAt || nowIso(); cur.appliedTo = cur.apply.target; cur.applyNote = "перенос завершился, но карточка не была обновлена — восстановлено по файлу"; }
        else if ((f.missing && cur.apply.expectedHash == null) || (f.hash && f.hash === cur.apply.expectedHash)) { cur.status = "done"; cur.applyNote = "прошлая попытка переноса прервалась до замены файла; файл не изменён"; delete cur.apply; }
        else { cur.status = "apply_unclear"; cur.applyNote = "перенос прервался, и файл теперь не совпадает ни с прежним, ни с результатом: " + cur.apply.target; }
        log("задание " + job.id + ": прерванный перенос → " + cur.status);
      });
    } catch (e) { return job; }
  }
  return job;
}

// ---------- проверка ответа ----------
const HARD_FAIL = [
  /^\s*jetski:/im, /AGY_ERROR/, /no output produced/i, /auto-denied/i,
  /timeout waiting for response/i, /RESOURCE_EXHAUSTED/i,
];
const SOFT_FAIL_SHORT = [/quota/i, /rate.?limit/i, /permission denied/i, /not authenticated|sign in/i];
// инструменты Antigravity, которые могут менять файлы, запускать команды или передавать работу дальше
const WRITE_TOOLS = /\b(write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file|delete_file|move_file|rename_file|run_command|run_terminal|execute_command|shell|call_mcp_tool|invoke_subagent|define_subagent|manage_task)\b/i;
const INTRO_WORDS = "вот|ниже|конечно|разумеется|готово|итак|приступаю|давайте|хорошо|ок(?:ей)?|исправленн\\p{L}*|я\\s+проанализировал\\p{L}*|понял\\p{L}*|сделал\\p{L}*|держи|результат|внесены\\s+изменения|ознакомил\\p{L}*|принято|here is|here's|sure|certainly|okay";
const INTRO = new RegExp("^\\s*(" + INTRO_WORDS + "|замечания)(?![\\p{L}\\p{N}])", "iu");
const INTRO_REMARKS = new RegExp("^\\s*(" + INTRO_WORDS + ")(?![\\p{L}\\p{N}])", "iu");
// Результат правки и нового текста Antigravity выводит между метками; всё вне меток (вступления, отчёты) мост отбрасывает.
// Метки у каждого задания свои (со случайным кодом), распознаются только как отдельные строки.
function makeMarkers() {
  const t = crypto.randomBytes(3).toString("hex").toUpperCase();
  return { start: "<<<РЕЗУЛЬТАТ-" + t + ">>>", end: "<<<КОНЕЦ-РЕЗУЛЬТАТА-" + t + ">>>" };
}
// Строка — метка, если после снятия оформления (**, `, пробелы) она равна метке целиком.
function isMarkerLine(line, marker) {
  const i = line.indexOf(marker);
  if (i < 0) return false;
  return /^[\s*_`~#>]*$/.test(line.slice(0, i) + line.slice(i + marker.length));
}
// { text, warnings } — результат; { ambiguous } — разметка неоднозначна, автоматически брать нельзя.
function extractResult(out, work, markers, rezhim) {
  const warnings = [];
  const lines = splitLines(out);
  const S = [], E = [];
  lines.forEach((l, i) => { if (isMarkerLine(l, markers.start)) S.push(i); else if (isMarkerLine(l, markers.end)) E.push(i); });
  let text;
  if (!S.length && !E.length) {
    text = out;
    warnings.push("метки результата не найдены — взят весь ответ; проверь начало и конец на пояснения и отчёты");
  } else if (S.length === 1 && E.length === 1 && E[0] > S[0]) {
    text = lines.slice(S[0] + 1, E[0]).join("\n");
    const outside = lines.slice(0, S[0]).concat(lines.slice(E[0] + 1)).join(" ").trim();
    if (outside) warnings.push("вне меток результата был текст (" + outside.length + " симв.), он отброшен: «" + outside.replace(/\s+/g, " ").slice(0, 100) + "»");
  } else {
    return { ambiguous: "разметка результата неоднозначна (открывающих меток: " + S.length + ", закрывающих: " + E.length + (S.length === 1 && E.length === 1 ? ", закрывающая раньше открывающей" : "") + ") — автоматически взять результат нельзя" };
  }
  text = text.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "").trim();
  // обёртку ``` мост не снимает никогда: она может быть частью текста или порученной правки — только предупреждает
  const tl = splitLines(text);
  if (tl.length >= 2 && /^\s*```/.test(tl[0]) && /^\s*```\s*$/.test(tl[tl.length - 1]) && !(work && /^\s*```/.test(splitLines(work.text)[0] || "")))
    warnings.push("результат начинается и заканчивается строкой ``` — проверь, не лишняя ли это обёртка (мост её не снимает)");
  return { text, warnings };
}
const KNOWN_STATUSES = new Set(["SUCCESS", "ERROR", "CANCELLED", "MAX_STEPS_REACHED"]);
const ELLIPSIS_PLACEHOLDER = /(\.\.\.|…)\s*[(\[]?\s*(остальн|далее без изменений|без изменений|и так далее|rest of|unchanged)/i;

// problems/warnings — подробно (для карточки и Claude); codes — коротко, без текстов (для журнала).
function checkOutput(res, rezhim, work, markers) {
  let out = String(res.output || "").trim();
  const problems = [], warnings = [], codes = [];
  const P0 = (code, msg) => { codes.push(code); problems.push(msg); };
  if (rezhim !== "zamechaniya" && out && markers) {
    const ex = extractResult(out, work, markers, rezhim);
    if (ex.ambiguous) { P0("markers", ex.ambiguous); out = "(разметка неоднозначна)"; }
    else { out = ex.text; warnings.push(...ex.warnings); }
  }
  if (res.jsonCandidates > 1) warnings.push("в выводе agy несколько JSON-ответов (" + res.jsonCandidates + ") — взят последний с полем response; проверь результат");
  const P = (code, msg) => { codes.push(code); problems.push(msg); };
  const permission = agyInput.permission(res);
  if (permission) P('permission', permission.reason);
  if (res.error) P(res.timedOut ? "watchdog" : (res.cancelled ? "cancelled" : "run_error"), res.error);
  if (res.json) {
    if (res.agyStatus && res.agyStatus !== "SUCCESS") P("status:" + (KNOWN_STATUSES.has(res.agyStatus) ? res.agyStatus : "UNKNOWN"), "Antigravity вернул состояние: " + ({ERROR:"ошибка",CANCELLED:"отменено",MAX_STEPS_REACHED:"достигнут предел шагов"}[res.agyStatus] || ("неизвестное (код " + res.agyStatus + ")")) + (res.agyError ? ": " + String(res.agyError).slice(0, 300) : ""));
    if (!res.agyStatus) warnings.push("в ответе Antigravity нет поля состояния status — успешность отдельно не подтверждена");
    if (res.agyError && res.agyStatus === "SUCCESS") warnings.push("при успешном состоянии Antigravity сообщил ошибку: " + String(res.agyError).slice(0, 200));
  } else warnings.push("ответ получен без структурированной формы — проверь весь текст на служебные сообщения и мусор");
  if (res.denied) P("denied", "Antigravity пытался сделать запрещённое и получил отказ: " + JSON.stringify(res.denied).slice(0, 300));
  if (res.toolCalls) {
    const m = require('../../common/agy-tools').forbidden(res.toolCalls) ? (JSON.stringify(res.toolCalls).match(WRITE_TOOLS) || [null, 'запрещённый вызов']) : null;
    if (m) P("write_tool:" + m[1], "Antigravity вызывал инструмент изменения файлов или команд (" + m[1] + ") — это запрещено; результат не принят");
  }
  if (res.exitCode !== 0 && !res.error) P("exit:" + res.exitCode, "agy завершился с кодом " + res.exitCode + (res.stderr ? ": " + res.stderr.slice(0, 400) : ""));
  if (!out) P("empty", "пустой ответ");
  const head = out.slice(0, 800);
  for (const re of (res.json && res.agyStatus === "SUCCESS" ? [] : HARD_FAIL)) if (re.test(head)) { P("error_text", "в ответе сообщение об ошибке: «" + head.slice(0, 300) + "»"); break; }
  if (!(res.json && res.agyStatus === "SUCCESS") && out.length < 400) for (const re of SOFT_FAIL_SHORT) if (re.test(out)) { P("short_error", "короткий ответ похож на ошибку: «" + out + "»"); break; }
  if (/^```/.test(out) || /```\s*$/.test(out)) warnings.push("ответ обёрнут в ``` — возможно, обёртку надо срезать");
  if (
    !/^(?:ПРИНЯТО$|НЕ ПРИНЯТО:)/.test(out.split(/\r?\n/)[0].trim()) &&
    (rezhim === 'zamechaniya' ? INTRO_REMARKS : INTRO).test(out)
  )
    warnings.push('ответ начинается со вступления: «' + out.split('\n')[0].slice(0, 120) + '»');
  if (rezhim === "pravka" && ELLIPSIS_PLACEHOLDER.test(out)) warnings.push("в ответе похоже на сокращение текста («…остальное без изменений») — проверь, не потерян ли текст");
  if (rezhim !== "zamechaniya" && /^[«"„“].*[»"“”]$/s.test(out) && out.length < 2000) warnings.push("ответ целиком в кавычках");
  return { ok: problems.length === 0, problems, warnings, codes, text: out };
}
// ---------- сравнение по строкам ----------
function diffLines(a, b) {
  // общее начало и конец — сразу, чтобы большие файлы с местными правками сравнивались быстро
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  if (n * m > DIFF_MAX_CELLS) return null;
  const W = m + 1;
  const dp = (Math.min(n, m) < 65535) ? new Uint16Array((n + 1) * W) : new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const blocks = [];
  let cur = null, i = 0, j = 0;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  const open = () => { if (!cur) cur = { at: pre + i, atNew: pre + j, old: [], new: [] }; };
  while (i < n && j < m) {
    if (A[i] === B[j]) { flush(); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { open(); cur.old.push(A[i]); i++; }
    else { open(); cur.new.push(B[j]); j++; }
  }
  while (i < n) { open(); cur.old.push(A[i]); i++; }
  while (j < m) { open(); cur.new.push(B[j]); j++; }
  flush();
  return blocks;
}

function tokens(s) { return String(s).split(/\s+/).filter(Boolean); }
function wordChanges(x, y) {
  const n = x.length, m = y.length;
  if (!n || !m) return Math.max(n, m);
  if (n * m > 50000000) return Math.max(n, m);
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return Math.max(n, m) - prev[m];
}

function cutStr(s, full) { s = String(s); return !full && s.length > MAX_LINE_SHOW ? s.slice(0, MAX_LINE_SHOW) + "…[сокращено]" : s; }

// Место правки с кусочком текста вокруг.
function around(oldStr, newStr, full, ctx = 70) {
  let p = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (p < minLen && oldStr[p] === newStr[p]) p++;
  let q = 0;
  while (q < minLen - p && oldStr[oldStr.length - 1 - q] === newStr[newStr.length - 1 - q]) q++;
  const from = full ? 0 : Math.max(0, p - ctx);
  const show = (str) => {
    const to = full ? str.length : Math.min(str.length, str.length - q + ctx);
    let piece = str.slice(from, to);
    if (!full && piece.length > 2 * MAX_LINE_SHOW) piece = piece.slice(0, MAX_LINE_SHOW) + " …[середина скрыта, full: true]… " + piece.slice(-MAX_LINE_SHOW);
    return (from > 0 ? "…" : "") + piece.replace(/\n/g, " ⏎ ") + (to < str.length ? "…" : "");
  };
  return { old: show(oldStr), new: show(newStr) };
}

function analyzeDiff(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText);
  const blocks = diffLines(a, b);
  const totalWords = tokens(a.join(" ")).length;
  if (!blocks) return { blocks: null, aLen: a.length, bLen: b.length, totalWords };
  let changedWords = 0;
  for (const bl of blocks) changedWords += wordChanges(tokens(bl.old.join(" ")), tokens(bl.new.join(" ")));
  const pct = totalWords ? Math.round(100 * changedWords / totalWords) : 0;
  const changedOld = blocks.reduce((s, bl) => s + bl.old.length, 0);
  return { blocks, aLen: a.length, bLen: b.length, totalWords, pct, changedOld };
}

function renderBlock(bl, k, lineOffset, full) {
  const o1 = bl.at + 1 + lineOffset, o2 = bl.at + bl.old.length + lineOffset;
  const n1 = bl.atNew + 1, n2 = bl.atNew + bl.new.length;
  const where = bl.old.length
    ? (bl.old.length > 1 ? "строки " + o1 + "–" + o2 : "строка " + o1)
    : "вставка после строки " + (bl.at + lineOffset);
  const inNew = bl.new.length ? " [в результате: " + (bl.new.length > 1 ? "строки " + n1 + "–" + n2 : "строка " + n1) + "]" : " [в результате: удалено]";
  const extra = bl.old.length !== bl.new.length ? " (строк было " + bl.old.length + ", стало " + bl.new.length + ")" : "";
  const head = "#" + k + " " + where + inNew + extra + ":";
  if (!bl.old.length) return head + "\n  вставлено: " + bl.new.map((x) => cutStr(x, full)).join(" ⏎ ");
  if (!bl.new.length) return head + "\n  удалено: " + bl.old.map((x) => cutStr(x, full)).join(" ⏎ ");
  const w = around(bl.old.join("\n"), bl.new.join("\n"), full);
  return head + "\n  было:  " + w.old + "\n  стало: " + w.new;
}

// ---------- поручение ----------
function numberLines(text, offset) {
  return splitLines(text).map((l, i) => (i + 1 + offset) + "| " + l).join("\n");
}
function buildRules(rezhim, work, opora, markers) {
  const r = ["ПРАВИЛА ОТВЕТА:",
    "- Не вызывай инструменты изменения файлов (write_to_file, replace_file_content и любые подобные) и не запускай команды (run_command): это запрещено. Всё нужное уже есть в поручении."];
  r.push("- Можно вызывать только team_status, team_rules, team_work (get/list), codex_status, codex_result, codex_send, если поручение этого просит.");
  if (rezhim === "zamechaniya") {
    r.push("- Дай только замечания по ТЕКСТУ ДЛЯ РАБОТЫ. Не переписывай текст и не возвращай исправленную версию.");
    r.push("- Строки текста пронумерованы («12| …»); это номера строк исходного файла.");
    r.push("- Формат каждого замечания: «Строка 12: «короткая дословная цитата» — суть замечания». Цитата — только сам текст, дословно, не длиннее 15 слов, БЕЗ префикса с номером (без «12| »). Не нумеруй замечания списком: каждое начинается прямо со слова «Строка».");
    r.push("- Без приветствий, вступлений и заключения: сразу первое замечание.");
    if (opora.length) r.push("- ОПОРА дана для справки: на неё можно ссылаться; короткие цитаты из неё допустимы с пометкой «(опора: имя файла)».");
  } else {
    r.push("- Выведи результат строго между двумя служебными строками: сначала отдельной строкой (вне блоков кода) " + markers.start + ", затем сам текст, затем отдельной строкой (вне блоков кода) " + markers.end + ". Внутри меток — только сам текст: без приветствий, вступлений, пояснений, отчётов, кавычек вокруг и без markdown-обёртки ```. Всё, что окажется вне этих строк, мост отбросит — ничего нужного вне них не пиши, а сами метки никак не форматируй и в отчёте не повторяй.");
    if (work) r.push("- Меняй в тексте только то, о чём просит поручение. Всё остальное верни дословно, строка в строку, не склеивая строки. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать «…остальной текст без изменений…» или как-либо сокращать текст.");
    if (opora.length) r.push("- ОПОРА дана только для справки: не переписывай и не цитируй её в ответе.");
  }
  return r.join("\n");
}
function workShown(rezhim, work) { return rezhim === "zamechaniya" ? numberLines(work.text, work.range ? work.range.from - 1 : 0) : work.text; }

function buildInlinePrompt(poruchenie, rezhim, work, opora, markers) {
  const parts = [poruchenie.trim(), "", buildRules(rezhim, work, opora, markers)];
  if (work) parts.push("", "=== ТЕКСТ ДЛЯ РАБОТЫ ===", workShown(rezhim, work), "=== КОНЕЦ ТЕКСТА ДЛЯ РАБОТЫ ===");
  for (const o of opora) parts.push("", "=== ОПОРА (только для справки): " + o.label + " ===", o.text, "=== КОНЕЦ ОПОРЫ ===");
  return parts.join("\n");
}
// Файловый режим: тексты (а при длинном поручении — и оно само) лежат во временной папке.
function buildFilePrompt(poruchenie, rezhim, work, opora, inputDir, markers) {
  const files = [];
  if (work) { fs.writeFileSync(path.join(inputDir, work.copyName), workShown(rezhim, work), "utf8"); files.push("Текст для работы: " + path.join(inputDir, work.copyName)); }
  for (const o of opora) { fs.writeFileSync(path.join(inputDir, o.copyName), o.text, "utf8"); files.push("ОПОРА (только для справки): " + path.join(inputDir, o.copyName)); }
  const readHow = "Прочитай эти файлы инструментом просмотра файлов (view_file) по абсолютным путям. Терминал не используй.";
  const body = [poruchenie.trim(), "", buildRules(rezhim, work, opora, markers), "", "Тексты лежат файлами. " + readHow, ...files].join("\n");
  if (poruchenie.length <= PORUCHENIE_FILE_THRESHOLD && cmdlineLength(AGY.bin, AGY.pre.concat(["--print", body])) <= MAX_INLINE_CHARS) return { prompt: body, poruchenieFile: false };
  const pf = path.join(inputDir, "poruchenie.txt");
  fs.writeFileSync(pf, body, "utf8");
  const stub = ["Твоё поручение, правила ответа и тексты лежат файлами.",
    "Сначала прочитай инструментом просмотра файлов (view_file) файл " + pf + ".",
    "Затем прочитай файлы с текстами, указанные в нём, и выполни поручение.",
    "В финальном ответе дай ТОЛЬКО то, что требует поручение: никаких отчётов о прочитанном, вступлений, кавычек или markdown-блоков. Не вызывай инструменты записи и не запускай команды."].join("\n");
  return { prompt: stub, poruchenieFile: true };
}

// ---------- запуск agy ----------
// Разбор вывода agy: принимается только объект с полем response или status (строки журнала вида {"event":…} пропускаются).
function parseAgyJson(text) {
  const t = String(text || "").trim();
  const tryParse = (x) => { try { const o = JSON.parse(x); return o && typeof o === "object" && !Array.isArray(o) && ("response" in o || "status" in o || "error" in o) ? o : null; } catch (e) { return null; } };
  let o = tryParse(t);
  if (o) return { obj: o, candidates: 1 };
  // построчно: собираем все подходящие объекты
  const found = [];
  for (const l of t.split(/\r?\n/)) { if (l.trim().startsWith("{")) { const c = tryParse(l.trim()); if (c) found.push(c); } }
  if (found.length) {
    const withResp = found.filter((c) => typeof c.response === "string");
    return { obj: (withResp.length ? withResp : found)[(withResp.length ? withResp : found).length - 1], candidates: found.length };
  }
  // до и после JSON могут быть логи со своими скобками: перебираем начала и концы (с ограничением попыток)
  let start = t.indexOf("{"), tries = 0;
  while (start >= 0 && tries < 400) {
    let end = t.lastIndexOf("}");
    while (end > start && tries < 400) {
      o = tryParse(t.slice(start, end + 1));
      if (o) return { obj: o, candidates: 1 };
      end = t.lastIndexOf("}", end - 1);
      tries++;
    }
    start = t.indexOf("{", start + 1);
    tries++;
  }
  return { obj: null, candidates: 0 };
}


// ---------- сборка файла при переносе ----------
// Заменяет текст (весь или диапазон строк), сохраняя окончания строк у неизменённых строк
// и точные байты вне диапазона. Новые строки получают окончание заменяемой строки или преобладающее.
function rebuildSegment(segText, result, defaultEol) {
  const parts = splitKeep(segText);
  const oldBodies = parts.map(lineBody);
  const newBodies = splitLines(result);
  if (oldBodies.length === newBodies.length && oldBodies.every((b, i) => b === newBodies[i])) return segText; // по сути без изменений
  const origFinal = parts.length ? lineEnd(parts[parts.length - 1]) : "";
  const blocks = diffLines(oldBodies, newBodies);
  // строки как пары «текст + окончание»; разделители расставляются отдельно
  const items = [];
  if (!blocks) for (const nb of newBodies) items.push({ b: nb, t: defaultEol });
  else {
    let i = 0;
    for (const bl of blocks) {
      for (; i < bl.at; i++) items.push({ b: oldBodies[i], t: lineEnd(parts[i]) });
      const eol = (bl.old.length && lineEnd(parts[bl.at])) || defaultEol;
      for (const nb of bl.new) items.push({ b: nb, t: eol });
      i = bl.at + bl.old.length;
    }
    for (; i < parts.length; i++) items.push({ b: oldBodies[i], t: lineEnd(parts[i]) });
  }
  if (!items.length) return "";
  // у каждой строки, после которой есть следующая, должен быть разделитель
  for (let k = 0; k < items.length - 1; k++) if (!items[k].t) items[k].t = defaultEol;
  // конец сегмента — как в исходнике: был перевод строки — остаётся, не было — не появляется
  const last = items[items.length - 1];
  last.t = origFinal ? (last.t || origFinal) : "";
  return items.map((x) => x.b + x.t).join("");
}
function composeEdit(srcText, range, result) {
  const defaultEol = dominantEol(srcText);
  if (range) {
    const parts = splitKeep(srcText);
    const prefix = parts.slice(0, range.from - 1).join("");
    const seg = parts.slice(range.from - 1, range.to).join("");
    const suffix = parts.slice(range.to).join("");
    return prefix + rebuildSegment(seg, result, lineEnd(parts[range.from - 1]) || defaultEol) + suffix;
  }
  return rebuildSegment(srcText, result, defaultEol);
}

// ---------- запуск agy ----------
function runAgy(args, jobId, onSpawn, cwd, stdin) {
  return new Promise((resolve) => {
    const outChunks = [], errChunks = [];
    let done = false, proc = null, timedOut = false, inputError = null;
    const entry = { proc: null, stopping: false, reason: null, unconfirmed: false };
    const finish = (exitCode, errTextMsg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      RUNNING.delete(jobId);
      if (timedOut) { exitCode = 124; errTextMsg = "задание не уложилось в " + Math.round(WATCHDOG_MS / 60000 * 10) / 10 + " мин и было остановлено"; }
      else if (entry.reason === "отмена") { errTextMsg = "задание отменено"; }
      const raw = Buffer.concat(outChunks).toString("utf8");
      const stderr = stripAnsi(Buffer.concat(errChunks).toString("utf8"));
      const parsed = stdin != null ? agyInput.parseResults(raw) : parseAgyJson(raw);
      const obj = parsed.obj;
      const base = { stderr, diagnostics: parsed.diagnostics || [], exitCode, error: errTextMsg || inputError || (stdin != null && !obj ? 'Не получено завершающее событие result.' : null), cancelled: entry.reason === "отмена", timedOut, jsonCandidates: parsed.candidates };
      if (obj) {
        const denied = parsed.denied?.length ? parsed.denied : obj.denied_actions || obj.deniedActions || null;
        resolve(Object.assign(base, {
          output: typeof obj.response === "string" ? obj.response : "",
          agyStatus: obj.status != null ? String(obj.status) : "", agyError: obj.error ? (typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error)) : null,
          denied: denied && (Array.isArray(denied) ? denied.length : true) ? denied : null,
          toolCalls: obj.tool_calls || obj.toolCalls || null,
          usage: obj.usage || null, json: true,
        }));
      } else resolve(Object.assign(base, { output: stripAnsi(raw), json: false }));
    };
    const timer = setTimeout(() => { timedOut = true; requestStop(jobId, "предел времени"); }, WATCHDOG_MS);
    // запрос отмены из любого экземпляра моста — файлом-флагом
    const poll = setInterval(() => { if (!entry.stopping && fs.existsSync(cancelPath(jobId))) requestStop(jobId, "отмена"); }, CANCEL_POLL_MS);
    try {
      proc = spawn(AGY.bin, AGY.pre.concat(args), { cwd, stdio: [stdin != null ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true, detached: !isWindows });
      entry.proc = proc;
      RUNNING.set(jobId, entry);
      if (onSpawn) onSpawn(proc.pid);
      proc.stdout.on("data", (d) => outChunks.push(Buffer.from(d)));
      proc.stderr.on("data", (d) => errChunks.push(Buffer.from(d)));
      proc.on("error", (e) => finish(1, "не удалось запустить agy: " + errText(e)));
      proc.on("close", (code) => finish(code == null ? 1 : code));
      if (stdin != null) {
        proc.stdin.on('error', e => { inputError = 'Ошибка передачи поручения: ' + e.message; });
        proc.stdin.end(stdin, 'utf8');
      }
    } catch (e) {
      finish(1, "не удалось запустить agy: " + errText(e));
    }
  });
}
// Единая остановка задания (отмена, предел времени, закрытие моста). Итог публикуется только после
// фактического завершения процесса; если он не завершился — это записывается в карточку честно.
async function requestStop(jobId, reason, opts) {
  const entry = RUNNING.get(jobId);
  if (!entry || !entry.proc) return { none: true };
  if (entry.stopping) return entry.stopping; // уже останавливается — ждём тот же итог
  entry.reason = reason;
  entry.stopping = (async () => {
    const closedP = new Promise((res) => { if (!RUNNING.has(jobId)) return res(true); entry.proc.once("close", () => res(true)); });
    const r = await killTree(entry.proc, (opts && opts.taskkillTimeoutMs) || 15000);
    if (r.note) {
      entry.treeNote = r.note;
      log("задание " + jobId + ": остановка (" + reason + "): потомки могли остаться");
      // предупреждение — в карточку, чтобы его видели итог и отмена
      try { await updateJob(jobId, (c) => { c.stopNote = r.note; }, 2000); } catch (e) {}
    }
    const waitMs = (opts && opts.confirmMs) || STOP_CONFIRM_MS;
    const closed = await Promise.race([closedP, sleep(waitMs).then(() => false)]);
    if (!closed) {
      entry.unconfirmed = true;
      log("задание " + jobId + ": остановка agy не подтверждена (" + reason + ")");
      try { await updateJob(jobId, (c) => { c.stopUnconfirmed = { pid: entry.proc.pid, reason, at: nowIso() }; }, 2000); } catch (e) {}
    }
    return { closed, treeNote: r.note || null, pid: entry.proc.pid };
  })();
  return entry.stopping;
}

// ---------- выполнение задания ----------
async function runJob(job, args, inputDir, papkaCanon, genLock) {
  ACTIVE.add(job.id);
  try {
    if (job.modelSelectionPending) {
      const selection = await resolveModel(job.requestedModel);
      if (selection.error) throw Error(selection.error);
      args = args.filter((v, i) => v !== '--model' && args[i - 1] !== '--model');
      if (selection.id) args.push('--model', selection.id);
      Object.assign(job, modelFields(selection), { modelSelectionPending: false });
      job.retry.args = args;
      await updateJob(job.id, c => { Object.assign(c, modelFields(selection), { modelSelectionPending: false }); c.retry.args = args; });
    }
    const run = () => runAgy(args, job.id, pid => { updateJob(job.id, c => { c.agyPid = pid; }).catch(() => {}); }, job.papka, job.retry?.stdin);
    let res = await run();
    const protocolReason = !agyInput.outputLimit(res) && job.retry?.stdin != null && agyInput.protocolError(res);
    if (protocolReason && !job.protocolFallback && !shuttingDown && !fs.existsSync(cancelPath(job.id))) {
      const legacyArgs = args.filter((value, i) => value !== '--input-format' && args[i - 1] !== '--input-format');
      legacyArgs[legacyArgs.indexOf('--output-format') + 1] = 'json';
      let prompt = buildInlinePrompt(job.poruchenie, job.rezhim, job.work, job.retry.refs || [], job.markers), fileMode = false, poruchenieFile = false;
      if (cmdlineLength(AGY.bin, AGY.pre.concat(legacyArgs, ['--print', prompt])) > MAX_INLINE_CHARS) {
        fileMode = true;
        inputDir = path.join(INPUT_DIR, job.id);
        fs.mkdirSync(inputDir, { recursive: true });
        const fp = buildFilePrompt(job.poruchenie, job.rezhim, job.work ? { ...job.work, copyName: "tekst_dlya_raboty.txt" } : null, job.retry.refs || [], inputDir, job.markers);
        prompt = fp.prompt; poruchenieFile = fp.poruchenieFile;
        legacyArgs.push('--add-dir', inputDir);
      }
      legacyArgs.push('--print', prompt);
      if (cmdlineLength(AGY.bin, AGY.pre.concat(legacyArgs)) > MAX_CMDLINE_CHARS) throw Error('Запасное поручение превышает предел командной строки.');
      const fallback = { at: nowIso(), reason: protocolReason, attempt: 1, from: 'stream-json', to: 'legacy' };
      let switched = false;
      await updateJob(job.id, c => {
        if (c.status !== 'running' || c.protocolFallback || fs.existsSync(cancelPath(job.id))) return false;
        c.protocolFallback = fallback;
        c.retry = { args: legacyArgs, inputDir };
        c.fileMode = fileMode; c.poruchenieFile = poruchenieFile;
        switched = true;
      });
      if (switched) {
        args = legacyArgs; job.retry = { args, inputDir }; job.protocolFallback = fallback;
        res = await run();
      }
    }
    const denial = agyInput.permission(res);
    if (denial?.retryable && !agyInput.outputLimit(res) && !job.materialReadRetry && !res.cancelled && !shuttingDown && !fs.existsSync(cancelPath(job.id))) {
      await updateJob(job.id, c => { c.materialReadRetry = { at: nowIso(), reason: denial.reason, attempt: 1 }; });
      job.materialReadRetry = { attempt: 1 };
      res = await run();
    }
    if (shuttingDown) return; // карточку пометил shutdown
    const unsuccessful = res.exitCode !== 0 || res.agyStatus !== 'SUCCESS' ||
      res.agyError || res.error || !String(res.output || '').trim();
    if (unsuccessful && !agyInput.outputLimit(res) && !agyInput.permission(res) && !res.cancelled && !fs.existsSync(cancelPath(job.id))) {
      const classified=classifyAgy(res);
      if(classified.kind==='quota' || classified.kind==='transient') {
        const [snapshot, modelList] = classified.kind === 'quota'
          ? await Promise.all([agySnapshot({ fresh: true }), loadModels()]) : [null, []];
        await updateJob(job.id, (c) => {
          if (c.status !== 'running') return false;
          if (fs.existsSync(cancelPath(c.id))) {
            c.status = 'cancelled';
            c.finishedAt = nowIso();
            return;
          }
          const plan = classified.kind === 'quota' ? quotaRetry(c, classified, snapshot, modelList) : retryPlan(c, classified);
          Object.assign(c, plan, { usage: res.usage || null });
          if (res.output) replaceFileAtomicSync(path.join(jobDir(c.id), 'partial.txt'), res.output);
        });
        return;
      }
    }
    const check = checkOutput(res, job.rezhim, job.work, job.markers);
    const limit = agyInput.outputLimit(res, job.work?.text || job.poruchenie);
    if (limit) { check.ok = false; check.problems.unshift(limit); check.codes.push('output_limit'); }
    if (check.codes.includes("markers")) {
      const rawP = path.join(jobDir(job.id), "raw.txt");
      try { replaceFileAtomicSync(rawP, String(res.output || "")); check.problems.push("полный ответ Antigravity сохранён: " + rawP); }
      catch (e) { check.problems.push("полный ответ сохранить не удалось: " + errText(e)); }
    }
    let committed = null;
    await updateJob(job.id, (cur) => {
      if (cur.status !== "running") { committed = cur.status; return false; } // например, помечено вручную
      const finishedAt = nowIso();
      cur.finishedAt = finishedAt;
      cur.durationSec = Math.round((Date.parse(finishedAt) - Date.parse(cur.startedAt)) / 1000);
      cur.usage = res.usage || null;
      delete cur.stopUnconfirmed;
      if (res.cancelled || fs.existsSync(cancelPath(job.id))) {
        Object.assign(cur, { status: "cancelled", draftStatus: "not_attempted", problems: ["задание отменено"] });
        committed = "cancelled"; return;
      }
      cur.problems = check.problems;
      cur.warnings = check.warnings;
      if (!check.ok) {
        Object.assign(cur, { status: "failed", draftStatus: "not_attempted", rawTail: String(res.output || res.stderr || "").slice(-600) });
        committed = "failed"; return;
      }
      // 1) свой результат задания; 2) meta для восстановления; 3) карточка «готово»
      const text = check.text, hash = sha(text);
      try {
        replaceFileAtomicSync(resultPath(job.id), text);
        replaceFileAtomicSync(metaPath(job.id), JSON.stringify({ hash, words: words(text), warnings: check.warnings, finishedAt, durationSec: cur.durationSec, usage: cur.usage }));
      } catch (e) {
        Object.assign(cur, { status: "failed", draftStatus: "not_attempted" });
        cur.problems.push("не удалось сохранить результат задания: " + errText(e));
        check.codes.push("result_save");
        committed = "failed"; return;
      }
      Object.assign(cur, { status: "done", resultHash: hash, words: words(text), draftStatus: "pending" });
      committed = "done";
    });
    log("задание " + job.id + ": " + committed + (check.codes.length ? " [" + check.codes.join(", ") + "]" : ""));
    if (committed !== "done") return;
    if (job.from && job.from !== 'claude') {
      await updateJob(job.id, c => { c.draftStatus = 'not_attempted'; });
      return;
    }
    // 4) общий черновик — удобная копия; его сбой не отменяет готовность. Карточку меняем точечно, не трогая статус.
    if (TEST_DRAFT_DELAY_MS) await sleep(TEST_DRAFT_DELAY_MS);
    let draftStatus = "written", draftWarn = null;
    try {
      const j = loadJob(job.id);
      if (!isInsideReal(j.draftPath, papkaCanon)) throw new Error("путь черновика ведёт за пределы папки проекта");
      replaceFileAtomicSync(j.draftPath, check.text);
    } catch (e) { draftStatus = "failed"; draftWarn = "общий черновик не обновлён: " + errText(e) + " (результат задания сохранён отдельно)"; }
    try { await updateJob(job.id, (c) => { c.draftStatus = draftStatus; if (draftWarn) c.warnings = (c.warnings || []).concat([draftWarn]); }); }
    catch (e) { log("задание " + job.id + ": не удалось отметить черновик в карточке: " + errText(e)); }
  } catch (e) {
    log("задание " + job.id + ": сбой моста при фиксации итога");
    try {
      await updateJob(job.id, (c) => {
        if (c.status !== "running") return false;
        const meta = committedMeta(job.id);
        if (meta) {
          // результат уже зафиксирован — не превращаем его в «ошибку»
          Object.assign(c, { status: "done", resultHash: meta.hash, words: meta.words, warnings: meta.warnings || [], problems: [], finishedAt: meta.finishedAt,
            durationSec: meta.durationSec, usage: meta.usage || null, draftStatus: "not_attempted", recovered: "карточка не сохранилась с первого раза; результат восстановлен" });
        } else {
          Object.assign(c, { status: "failed", draftStatus: "not_attempted" });
          c.problems = (c.problems || []).concat(["сбой моста: " + errText(e)]);
        }
      });
    } catch (e2) { /* останется running; восстановление по meta сработает при следующем обращении */ }
  } finally {
    const terminal=loadJob(job.id);
    if (inputDir && isFinalJob(terminal)) {
      try {
        keepRm(inputDir, { recursive: true, force: true });
      } catch {}
    }
    ACTIVE.delete(job.id);
    try { if (fs.existsSync(cancelPath(job.id))) keepUnlink(cancelPath(job.id)); } catch (e) {}
    if (genLock && !(RUNNING.get(job.id) || {}).unconfirmed) await genLock.release();
  }
}

// ---------- модели ----------
function parseModels(out) {
  const list = [];
  for (const row of stripAnsi(out).split(/\n/).map((r) => r.trim()).filter(Boolean)) {
    if (/:$/.test(row)) continue;
    const m = row.match(/^([a-z0-9][\w.\-]*)\s+(.+)$/i);
    if (m) list.push({ id: m[1].trim(), name: m[2].trim() });
    else if (/^[a-z0-9][\w.\-]*$/i.test(row)) list.push({ id: row, name: row });
  }
  return list;
}
async function loadModels() {
  if (!AGY) return [];
  const r = await execFileP(AGY.bin, AGY.pre.concat(["models"]), { timeout: 30000 });
  return !r.err ? parseModels(r.stdout) : [];
}
async function resolveModel(requested) {
  const [snapshot, list] = await Promise.all([agySnapshot({ fresh: true }), loadModels()]);
  return selectModel(requested, snapshot, list);
}

// ---------- MCP ----------
const { format } = require('../../common/format');
const { classifyAgy, retryPlan } = require('../../common/quota');
const { agySnapshot } = require('../../common/agy-quota');
const { selectModel, modelFields, quotaRetry } = require('../../common/agy-model-quota');
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
const publicNames = {
  most_zdorovie: 'antigravity_status',
  most_poruchit: 'antigravity_send',
  most_itog: 'antigravity_result',
  most_perenesti: 'antigravity_apply',
  most_otmenit: 'antigravity_cancel',
};
const argNames = {
  papka_proekta: 'folder',
  poruchenie: 'task',
  fayl: 'file',
  stroki: 'lines',
  opora: 'refs',
  rezhim: 'mode',
  nomer: 'id',
  zhdat_sek: 'wait_sec',
  s_pravki: 'from_change',
  polno: 'full',
  s_simvola: 'from_char',
  kuda: 'to',
  perezapisat: 'overwrite',
};
const modeNames = { pravka: 'edit', zamechaniya: 'review', tekst: 'text' };
function publicText(s) {
  for (const [a, b] of Object.entries({ ...publicNames, ...argNames, ...modeNames })) s = s.replaceAll(a, b);
  return s;
}
function register(oldName, description, schema, fn) {
  if (!access.allowed('antigravity', publicNames[oldName])) return;
  const inputSchema = {};
  for (const [key, val] of Object.entries(schema))
    inputSchema[argNames[key] || key] =
      key === 'rezhim'
        ? z.enum(['edit', 'review', 'text']).optional().describe('Исправление, замечания или новый текст.')
        : val.describe(publicText(val.description || ''));
  if (oldName === 'most_poruchit')
    Object.assign(inputSchema, {
      text: z.string().optional().describe('Текст для проверки или опоры.'),
      stage: z.string().optional().describe('Этап работы.'),
      owner: z.string().optional().describe('Метка сеанса владельца работы.'),
      work: z.string().optional().describe('Название работы.'),
    });
  const titles = {
    most_zdorovie: 'Состояние Antigravity',
    most_poruchit: 'Поручить Antigravity',
    most_itog: 'Результат Antigravity',
    most_perenesti: 'Перенести результат',
    most_otmenit: 'Отменить поручение',
  };
  server.registerTool(
    publicNames[oldName],
    { title: titles[oldName], description: publicText(description), inputSchema: require('../../common/schema').compatible(inputSchema) },
    async (args) =>
      context.run({ args }, async () => {
        const perform = async () => {
        try {
          access.guard('antigravity', publicNames[oldName], args);
          // Этап нужен только при постановке поручения; чтение, перенос и отмена обходятся без него (team-v9 Р7).
          if (oldName === 'most_poruchit' && args.work && !args.stage) return fail('Для зарегистрированной работы укажите этап.');
          const old = { ...args };
          for (const [a, b] of Object.entries(argNames)) if (b in args) old[a] = args[b];
          if (args.mode) old.rezhim = Object.keys(modeNames).find((k) => modeNames[k] === args.mode);
          if (oldName === 'most_poruchit' && args.text !== undefined) {
            if (args.file) return fail('Укажите либо файл, либо текст.');
            const d = path.join(INPUT_DIR, newJobId());
            fs.mkdirSync(d, { recursive: true });
            old.fayl = path.join(d, 'text.txt');
            fs.writeFileSync(old.fayl, args.text);
            context.getStore().textFile = old.fayl;
            old.rezhim = old.rezhim || 'zamechaniya';
            if (old.rezhim === 'tekst') {
              old.poruchenie += '\nМатериал:\n' + args.text;
              old.fayl = undefined;
            }
          }
          const result = await fn(old);
          if (oldName === 'most_zdorovie') {
            const quota = await require('../../common/quota-line').quotaLine({ binary: process.env.CODEX_PATH || require('../../common/team').findCodex() });
            for (const c of result.content || []) if (c.type === 'text') c.text = c.text.replace(/\nДальше:/, '\n' + quota + '\nДальше:');
          }
          return result;
        } catch (e) {
          return fail('Ошибка моста: ' + errText(e));
        }
        };
        try {
          return oldName === 'most_poruchit'
            ? await require('../../common/work-owner').withWork(args, perform) : await perform();
        } catch (e) { return fail(errText(e)); }
      }),
  );
}
const server = new McpServer({ name: 'antigravity', version: VERSION });
function reply(text) {
  const ctx = context.getStore() || {},
    args = ctx.args || {};
  const match = String(text).match(/Задание (\S+) запущено/);
  const job = loadJob(args.id || ctx.jobId || (match && match[1]) || '') || { status: ctx.failed ? 'failed' : 'done' };
  const next =
    job.status === 'waiting_quota'
      ? 'Дождитесь восстановления квоты или отмените поручение.'
      : job.status === 'running'
        ? 'Запросите antigravity_result с id ' + job.id + '.'
        : access.guest() ? 'Проверьте результат.' : 'Проверьте результат; перенос требует отдельного вызова antigravity_apply.';
  return {
    content: [
      {
        type: 'text',
        text: format('Antigravity', { ...job, status: ctx.failed ? 'failed' : job.status }, String(text) + (job.status === 'waiting_quota' && job.quotaAdvice ? '\n' + job.quotaAdvice : ''), next),
      },
    ],
  };
}
function fail(text) {
  const ctx = context.getStore();
  if (ctx) ctx.failed = true;
  return { ...reply('ОТКАЗ: ' + text), isError: true };
}
function legacyNote(nomer) {
  return fs.existsSync(path.join(LEGACY_JOBS_DIR, String(nomer) + ".json"))
    ? " Это задание создано старой версией моста (0.1.x); новая версия его не переносит — повторите поручение." : "";
}
async function loadNorm(nomer) {
  const j = loadJob(nomer);
  if (!j || j.corrupt) return j;
  return normalizeJob(j);
}
async function runningJobsText() {
  const rows = [];
  for (const j0 of listJobs()) {
    if (!['running', 'applying', 'queued', 'waiting_quota'].includes(j0.status)) continue;
    const j = await normalizeJob(j0);
    if (!['running', 'applying', 'queued', 'waiting_quota'].includes(j.status)) continue;
    if (['queued', 'waiting_quota'].includes(j.status)) {
      rows.push(format('Antigravity', j, j.nextAttemptAt ? 'Продолжение: ' + j.nextAttemptAt : access.queued));
      continue;
    }
    const st = await ownerState(j.status === "running" ? j.owner : (j.apply && j.apply.owner));
    const sec = Math.round((Date.now() - Date.parse(j.startedAt)) / 1000);
    rows.push("  " + j.id + " — " + (j.status === "running" ? "идёт" : "переносится") + " " + sec + " с, папка " + j.papka + "; владелец: " + OWNER_WORDS[st] + (j.owner && j.owner.pid ? " (процесс " + j.owner.pid + ")" : "") +
      (j.stopUnconfirmed ? "; ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА, процесс Antigravity, номер " + j.stopUnconfirmed.pid : "") + '\n' + require('../../common/progress').progress(j) + '\nОтправитель: ' + (j.from || 'claude'));
  }
  return rows;
}

register(
  "most_zdorovie",
  "Проверить мост: версия, найден ли Antigravity (agy), список моделей, идущие задания (во всех экземплярах моста), где лежат результаты и журнал. Запускай первым, если что-то не работает.",
  {},
  async () => {
    if (!AGY) return fail("agy не найден. Нужно установить командный интерфейс Antigravity или указать путь в переменной AGY_PATH.");
    const [v, models, rows] = await Promise.all([
      execFileP(AGY.bin, AGY.pre.concat(["--version"]), { timeout: 20000 }),
      loadModels(),
      runningJobsText(),
    ]);
    const ver = v.err ? "не удалось узнать (" + (v.err.code != null ? "код " + v.err.code : "ошибка запуска") + ")" : stripAnsi(v.stdout);
    return reply([
      "Версия на диске: " + JSON.parse(fs.readFileSync(path.join(__dirname,"../../package.json"),"utf8")).version + "; версия процесса: " + VERSION + "\nМост " + VERSION + " (процесс " + process.pid + ", запущен " + STARTED_AT + "), agy: " + AGY.shown,
      "Версия agy: " + ver,
      "Приём ответа: напрямую, без экрана терминала",
      "Моделей: " + models.length + (models.length ? "\n" + models.map((m) => "  " + m.id + " — " + m.name).join("\n") : " (список не получен)"),
      "Заданий идёт в этом экземпляре: " + RUNNING.size,
      "Идущие задания во всех экземплярах: " + (rows.length ? "\n" + rows.join("\n") : "нет"),
      activityText(),
      "Результаты заданий: " + JOBS_DIR,
      "Журнал: " + JOURNAL,
      instancePipeOk ? "" : "ВНИМАНИЕ: канал экземпляра не открыт — другие экземпляры не видят этот мост; новые задания не принимаются.",
      "Проверка моста не доказывает, что Antigravity сейчас отвечает: это видно только по заданию.",
    ].filter(Boolean).join("\n"));
  }
);

register(
  "most_poruchit",
  "Отдать поручение Antigravity. Мост сам читает файлы и передаёт текст; результат хранится у задания отдельно и копируется в общий черновик _antigravity_result.txt в папке проекта. " +
  "Режимы: edit — исправить файл (нужен file); review — только замечания по файлу с короткими цитатами (нужен file); text — новый текст (без file). " +
  "В одной папке проекта одновременно идёт только одно задание. Возвращает номер сразу; результат — через antigravity_result.",
  {
    papka_proekta: z.string().describe("Полный путь к папке проекта. Туда ляжет общий черновик."),
    poruchenie: z.string().describe("Что сделать. Пиши по-человечески, правила ответа мост добавит сам."),
    fayl: z.string().optional().describe("Файл для правки или замечаний (полный путь, внутри папки проекта). Для нового текста не указывай."),
    stroki: z.string().optional().describe("Только вместе с file: какие строки отдать, например «10-40» или «12» (счёт с 1, включительно). Не указывай — весь файл."),
    opora: z.array(z.string()).optional().describe("Файлы только для справки (список полных путей)."),
    model: z.string().optional().describe("Модель: код или имя из antigravity_status, например gemini-3.1-pro-high. Не указывай — модель по умолчанию."),
    rezhim: z.enum(["pravka", "zamechaniya", "tekst"]).optional().describe("edit (по умолчанию при file), review (нужен file), text (по умолчанию без file)."),
  },
  async ({ papka_proekta, poruchenie, fayl, stroki, opora, model, rezhim }) => {
    if (shuttingDown) return fail("мост останавливается");
    if (!AGY) return fail("agy не найден.");
    if (!instancePipeOk) return fail("канал экземпляра моста не открыт — задания не принимаются (см. журнал). Перезапусти Claude.");
    if (!papka_proekta || !fs.existsSync(papka_proekta) || !fs.statSync(papka_proekta).isDirectory()) return fail("папки проекта нет: " + papka_proekta);
    if (!poruchenie || !poruchenie.trim()) return fail("пустое поручение");
    rezhim = rezhim || (fayl ? "pravka" : "tekst");
    if ((rezhim === "pravka" || rezhim === "zamechaniya") && !fayl) return fail("для режима " + modeNames[rezhim] + " нужен file");
    if (rezhim === "tekst" && fayl) return fail("для нового текста file не указывай; исходные материалы передай через refs (или выбери режим edit / review)");
    if (stroki && !fayl) return fail("lines указываются только вместе с file");

    let papkaCanon;
    try { papkaCanon = canon(papka_proekta); } catch (e) { return fail("не удалось проверить папку проекта: " + errText(e)); }
    const papka = path.resolve(papka_proekta);
    const draftPath = path.join(papka, DRAFT_NAME);

    const m = access.guest() ? { id: model || null } : await resolveModel(model);
    if (m.error) return fail(m.error);

    let work = null;
    try {
      if (fayl) {
        if (!fs.existsSync(fayl)) return fail("файла нет: " + fayl);
        if (!(context.getStore() || {}).textFile && !isInsideReal(fayl, papka)) return fail("файл должен лежать внутри папки проекта (с учётом ссылок): " + fayl);
        if (samePath(fayl, draftPath)) return fail("общий черновик нельзя отдавать как file — отдай исходный файл");
        const src = readSource(fayl);
        const lines = splitLines(src.text);
        const total = (lines.length > 1 && lines[lines.length - 1] === "") ? lines.length - 1 : lines.length;
        let range = null;
        if (stroki) {
          const mm = String(stroki).trim().match(/^(\d+)\s*[-–—:]\s*(\d+)$/) || String(stroki).trim().match(/^(\d+)$/);
          if (!mm) return fail("строки указываются так: «10-40» или «12»");
          const a = Number(mm[1]), b = Number(mm[2] || mm[1]);
          if (a < 1 || b < a || b > total) return fail("строки " + stroki + " вне файла: в нём " + total + " строк");
          range = { from: a, to: b };
        }
        const text = range ? lines.slice(range.from - 1, range.to).join("\n") : lines.slice(0, total).join("\n");
        work = { path: path.resolve(fayl), range, text, fileHash: src.hash, bom: src.bom, copyName: "tekst_dlya_raboty.txt" };
      }
    } catch (e) { return fail(errText(e)); }

    const opList = [];
    for (const [k, p] of (opora || []).entries()) {
      try {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return fail("файла опоры нет: " + p);
        if (fs.statSync(p).size > MAX_SOURCE_BYTES) return fail("файл опоры слишком большой: " + p);
        opList.push({ label: path.basename(p), text: readTextLoose(p), copyName: "opora_" + (k + 1) + "_" + path.basename(p).replace(/[^\w.\-]/g, "_") });
      } catch (e) { return fail("не удалось прочитать опору " + p + ": " + errText(e)); }
    }

    const id = newJobId();
    const lock = access.guest() ? { ok: true, release: async () => {} } : await tryLock("gen", papkaCanon, { jobId: id, papka });
    if (!lock.ok) {
      if (lock.busy) return fail("в этой папке уже идёт задание " + (lock.owner.jobId || "?") + (lock.state === "hung"
        ? " — его держит экземпляр моста, который не отвечает" + (lock.owner.pid ? " (процесс " + lock.owner.pid + ")" : "") + ". Если это не проходит, перезапусти Claude."
        : ". Дождись его итога (antigravity_result) или отмени (antigravity_cancel)."));
      return fail("не удалось захватить папку проекта: " + lock.error);
    }

    let prompt, fileMode = false, poruchenieFile = false, inputDir = null;
    const markers = rezhim === "zamechaniya" ? null : makeMarkers();
    const baseArgs = [];
    if (m.id) baseArgs.push("--model", m.id);
    baseArgs.push("--print-timeout", PRINT_TIMEOUT, "--output-format", STREAM_INPUT ? "stream-json" : "json");
    if (STREAM_INPUT) baseArgs.push("--input-format", "stream-json");
    let stdin;
    try {
      prompt = buildInlinePrompt(poruchenie, rezhim, work, opList, markers);
      if (STREAM_INPUT) prompt = agyInput.INLINE_NOTICE + '\n' + prompt;
      const event = agyInput.userEvent(prompt);
      if (STREAM_INPUT) stdin = event;
      if (!STREAM_INPUT && cmdlineLength(AGY.bin, AGY.pre.concat(baseArgs, ["--print", prompt])) > MAX_INLINE_CHARS) {
        fileMode = true;
        inputDir = path.join(INPUT_DIR, id);
        fs.mkdirSync(inputDir, { recursive: true });
        const fp = buildFilePrompt(poruchenie, rezhim, work, opList, inputDir, markers);
        prompt = fp.prompt; poruchenieFile = fp.poruchenieFile;
      }
      const args0 = STREAM_INPUT ? baseArgs : baseArgs.concat(fileMode ? ["--add-dir", inputDir] : [], ["--print", prompt]);
      if (cmdlineLength(AGY.bin, AGY.pre.concat(args0)) > MAX_CMDLINE_CHARS) throw new Error("поручение слишком длинное даже после выноса текстов в файлы");
    } catch (e) {
      await lock.release();
      if (inputDir) { try { keepRm(inputDir, { recursive: true, force: true }); } catch (e2) {} }
      return fail(errText(e));
    }
    const args = STREAM_INPUT ? baseArgs : baseArgs.concat(fileMode ? ["--add-dir", inputDir] : [], ["--print", prompt]);

    const job = {
      id, stage: context.getStore()?.args.stage, workName: context.getStore()?.args.work, textInput: !!context.getStore()?.textFile, retry: { args, inputDir, stdin, ...(STREAM_INPUT ? { refs: opList } : {}) }, version: VERSION, from: access.client(), status: access.guest() ? "queued" : "running", startedAt: nowIso(), rezhim,
      papka, papkaCanon, draftPath,
      work: work ? { path: work.path, range: work.range, fileHash: work.fileHash, bom: work.bom, text: work.text } : null,
      ...modelFields(m), modelSelectionPending: access.guest(), requestedModel: model || null,
      fileMode, poruchenieFile, promptChars: prompt.length, markers,
      poruchenie, task: poruchenie,
      owner: { instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT },
    };
    try { fs.mkdirSync(jobDir(id), { recursive: true }); saveJob(job); }
    catch (e) {
      await lock.release();
      if (inputDir) { try { keepRm(inputDir, { recursive: true, force: true }); } catch (e2) {} }
      return fail("не удалось сохранить карточку задания: " + errText(e));
    }
    log("задание " + id + " запущено: режим " + rezhim + ", модель " + job.model + ", " +
      (work ? (work.range ? "строки " + work.range.from + "–" + work.range.to : "весь файл") : "новый текст") +
      (fileMode ? ", текст файлами" + (poruchenieFile ? " (и поручение)" : "") : "") + ", опор: " + opList.length);
    if (!access.guest()) runJob(job, args, inputDir, papkaCanon, lock);

    context.getStore().jobId = id;
    return reply([
      "Задание " + id + (access.guest() ? " в очереди. Режим: " : " запущено. Режим: ") + modeNames[rezhim] + ".",
      access.guest() ? access.queued : "",
      "Модель: " + job.model + (job.modelWarning ? " — " + job.modelWarning : ""),
      work ? "Исходник: " + work.path + (work.range ? ", строки " + work.range.from + "–" + work.range.to : ", весь файл") : "Новый текст.",
      fileMode ? "Текст длинный: Antigravity получит его файлами во временной папке" + (poruchenieFile ? " (поручение — тоже файлом)" : "") + "." : "Текст передан прямо в поручении.",
      "Результат: antigravity_result с номером " + id + ".",
    ].join("\n"));
  }
);

// ---------- итог ----------
function draftLine(job) {
  try {
    if (fs.existsSync(job.draftPath) && job.resultHash && sha(fs.readFileSync(job.draftPath, "utf8")) === job.resultHash)
      return "Общий черновик " + job.draftPath + " сейчас содержит результат этого задания.";
  } catch (e) {}
  if (job.draftStatus === "failed") return "Общий черновик не обновлён (см. предупреждения); результат задания сохранён отдельно.";
  return "Общий черновик " + job.draftPath + " сейчас содержит ДРУГОЙ текст (другое задание или правка руками). Переносится результат этого задания, а не черновик.";
}
function paginate(body, s, hint) {
  s = Math.max(0, s || 0);
  if (s >= body.length && body.length) return { text: "(дальше текста нет: всего " + body.length + " символов)", more: false };
  const chunk = body.slice(s, s + PAGE_CHARS);
  const more = s + PAGE_CHARS < body.length;
  return { text: (s > 0 ? "…[продолжение с символа " + s + "]\n" : "") + chunk + (more ? "\n…[ответ длинный, показано до символа " + (s + PAGE_CHARS) + " из " + body.length + ". Продолжение: antigravity_result с from_char=" + (s + PAGE_CHARS) + hint + "]" : ""), more };
}

register(
  "most_itog",
  "Узнать результат задания. Пока идёт — скажет, сколько прошло. Готово — сводка и список изменений постранично (from_change), для замечаний и нового текста — сам текст. Длинный ответ продолжается через from_char. Ждёт до 50 секунд.",
  {
    nomer: z.string().describe("Номер задания из antigravity_send."),
    zhdat_sek: z.number().optional().describe("Сколько секунд подождать готовности, до 50. По умолчанию 40."),
    s_pravki: z.number().int().min(1).optional().describe("С какого изменённого места показывать список правок (по 40 мест). По умолчанию 1."),
    polno: z.boolean().optional().describe("Показывать правки без сокращения длинных строк; для нового текста — весь текст."),
    s_simvola: z.number().int().min(0).optional().describe("Продолжение длинного ответа с этого символа (номер даёт сам мост)."),
  },
  async ({ nomer, zhdat_sek, s_pravki, polno, s_simvola }) => {
    const wait = Math.max(0, Math.min(50, zhdat_sek == null ? 40 : zhdat_sek)) * 1000;
    const until = Date.now() + wait;
    let job = await loadNorm(nomer);
    if (!job) return fail("задания " + nomer + " нет." + legacyNote(nomer));
    if (job.corrupt) return fail("карточка задания повреждена: " + job.error);
    while ((job.status === "running" || job.status === "applying") && Date.now() < until) {
      await sleep(1000);
      job = (await loadNorm(nomer)) || job;
    }
    const sec = Math.round((Date.now() - Date.parse(job.startedAt)) / 1000);
    if (job.status === "running") {
      const st = await ownerState(job.owner);
      return reply("Задание " + nomer + " ещё идёт: " + sec + " с (владелец: " + OWNER_WORDS[st] + "). Спроси antigravity_result ещё раз." +
        (job.stopUnconfirmed ? " ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА (" + job.stopUnconfirmed.reason + "): процесс Antigravity, номер " + job.stopUnconfirmed.pid + " может продолжать работу." : "") +
        (st === "unknown" ? " Владелец задания не отвечает — возможно, мост завис; результат может не прийти. Остановить: antigravity_cancel." : ""));
    }
    if (job.status === "applying") return reply("Задание " + nomer + " сейчас переносится (" + OWNER_WORDS[await ownerState(job.apply && job.apply.owner)] + "). Спроси ещё раз.");
    if (job.status === 'queued' && !job.nextAttemptAt) return reply(access.queued);
    if (job.status === 'waiting_quota' || job.status === 'queued')
      return reply('Повтор после ' + job.nextAttemptAt + '. Попыток восстановления: ' + (job.quotaAttempts || 0) + '.');
    const stopWarn = (job.stopNote ? " ВНИМАНИЕ: " + job.stopNote + "." : "") + (job.stopUnconfirmed ? " ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА: процесс Antigravity, номер " + job.stopUnconfirmed.pid + " мог остаться работать." : "");
    if (job.status === "cancelled") return reply("Задание " + nomer + " отменено. Результата нет, общий черновик не трогали." + stopWarn);
    if (job.status === "lost") return reply("Задание " + nomer + " ПОТЕРЯНО: " + (job.problems || []).join("; ") + ". Общий черновик этим заданием не записывался. При необходимости повтори поручение.");
    if (job.status === "failed") {
      return reply([
        "Задание " + nomer + " НЕ УДАЛОСЬ (" + (job.durationSec ?? "?") + " с). Результата нет; общий черновик этим заданием не записывался.",
        "Причины: " + (job.problems || []).join("; ") + stopWarn,
        job.rawTail ? "Хвост вывода: " + job.rawTail : "",
      ].filter(Boolean).join("\n"));
    }
    if (job.status === "apply_unclear") return reply("Задание " + nomer + ": ПЕРЕНОС ПРЕРВАЛСЯ, СОСТОЯНИЕ НЕЯСНО. " + (job.applyNote || "") + " Проверь файл сам; повторно не переноси.");

    const r = readResult(job);
    const head = [
      "Задание " + nomer + " готово за " + job.durationSec + " с. Режим: " + (modeNames[job.rezhim] || "edit") + ". Модель: " + job.model + "." + (job.modelWarning ? " (" + job.modelWarning + ")" : ""),
    ];
    if (job.recovered) head.push("Восстановлено: " + job.recovered + ".");
    if (r.error) return fail("Задание " + nomer + ": " + r.error);
    head.push("Результат задания: " + resultPath(nomer) + " — " + job.words + " слов.");
    head.push(draftLine(job));
    if (job.usage && job.usage.total_tokens) head.push("Расход: " + job.usage.total_tokens + " токенов.");
    if (job.warnings && job.warnings.length) head.push("Предупреждения: " + job.warnings.join("; "));
    if (job.status === "applied") head.push("УЖЕ ПЕРЕНЕСЕНО: " + (job.appliedTo || "?") + " (" + (job.appliedAt || "?") + ")." + (job.applyNote ? " " + job.applyNote : ""));
    if (job.applyNote && job.status === "done") head.push(job.applyNote);

    let body = "";
    const hintBase = (s_pravki ? ", from_change=" + s_pravki : "") + (polno ? ", full=true" : "");
    const rezhim = job.rezhim || (job.work ? "pravka" : "tekst");
    if (rezhim === "pravka" && job.work) {
      const offset = job.work.range ? job.work.range.from - 1 : 0;
      const d = analyzeDiff(job.work.text, r.text);
      if (!d.blocks) {
        body = "СРАВНЕНИЯ НЕТ: текст слишком большой для построчного сравнения (было " + d.aLen + " строк, стало " + d.bLen + "). Сравни файлы сам: исходник " + job.work.path + (job.work.range ? " (строки " + job.work.range.from + "–" + job.work.range.to + ")" : "") + " и результат " + resultPath(nomer) + ".";
      } else if (!d.blocks.length) {
        body = "Изменений нет: ответ совпадает с исходным текстом.";
      } else {
        const K = d.blocks.length;
        const start = Math.min(Math.max(1, s_pravki || 1), K);
        const end = Math.min(K, start + PAGE_BLOCKS - 1);
        const lines = ["Изменённых мест: " + K + " (затронуто строк исходника: " + d.changedOld + " из " + d.aLen + "; изменено слов: около " + d.pct + "%)."];
        if (d.totalWords >= 20 && d.pct > 30) lines.push("Внимание: переписано больше 30% слов — проверь, не вышел ли Antigravity за рамки поручения.");
        lines.push("Показаны места " + start + "–" + end + " из " + K + "." + (end < K ? " ЕСТЬ ЕЩЁ: antigravity_result с from_change=" + (end + 1) + (polno ? ", full=true" : "") + "." : " Это все места.") + (polno ? "" : " Длинные строки сокращены — полностью: full=true."));
        lines.push("");
        for (let k = start; k <= end; k++) lines.push(renderBlock(d.blocks[k - 1], k, offset, !!polno), "");
        body = lines.join("\n");
      }
      if (job.status === "done") body += "\nПеренести в " + job.work.path + ": antigravity_apply с номером " + nomer + ".";
    } else if (rezhim === "zamechaniya") {
      body = "Замечания Antigravity (полностью" + (job.work ? ", по файлу " + job.work.path + (job.work.range ? ", строки " + job.work.range.from + "–" + job.work.range.to : "") : "") + "):\n\n" + r.text +
        (job.status === "done" ? "\n\nПеренос в исходный файл невозможен. Сохранить замечания новым файлом: antigravity_apply с номером " + nomer + " и to." : "");
    } else {
      if (polno) body = "Весь текст:\n\n" + r.text;
      else {
        const flat = r.text.replace(/\s+/g, " ");
        body = "Начало: «" + cutStr(flat.slice(0, 300)) + "»\nКонец: «" + flat.slice(-300) + "»\nВесь текст: antigravity_result с full=true (постранично) или файл результата.";
      }
      if (job.status === "done") body += "\n\nСохранить в файл: antigravity_apply с номером " + nomer + " и to.";
    }
    const pg = paginate(body, s_simvola, hintBase);
    return reply(head.join("\n") + "\n\n" + pg.text);
  }
);

// ---------- перенос ----------
register(
  "most_perenesti",
  "Перенести проверенный результат ЭТОГО задания. Правка (edit) — только в исходный файл, заменяются ровно отданные строки. Новый текст (text) и замечания (review) — новым файлом через to. " +
  "Откажет, если задание не готово, уже перенесено, рабочий файл менялся после отправки или файл занят.",
  {
    nomer: z.string().describe("Номер задания."),
    kuda: z.string().optional().describe("Для нового текста и замечаний: полный путь файла внутри папки проекта."),
    perezapisat: z.boolean().optional().describe("Только для нового текста (text): разрешить заменить существующий файл to."),
  },
  async ({ nomer, kuda, perezapisat }) => {
    if (shuttingDown) return fail("мост останавливается");
    let job = await loadNorm(nomer);
    if (!job) return fail("задания " + nomer + " нет." + legacyNote(nomer));
    if (job.from && job.from !== 'claude') return fail('Перенос гостевого поручения запрещён: результат хранится только в хранилище поручений.');
    if (job.textInput && (job.rezhim === 'pravka' || !kuda))
      return fail('Перенос в исходник для переданного текстом материала запрещён; сохраните результат отдельно.');
    if (job.corrupt) return fail("карточка задания повреждена: " + job.error);
    const why = (j) => ({ running: "задание ещё идёт", applying: "задание уже переносится", applied: "задание уже перенесено: " + (j.appliedTo || "?"),
      failed: "задание не удалось — переносить нечего", cancelled: "задание отменено — переносить нечего", lost: "задание потеряно — переносить нечего",
      apply_unclear: "прошлый перенос прервался, состояние неясно: " + (j.applyNote || "") + " Проверь файл сам." }[j.status] || ("задание в состоянии " + j.status));
    if (job.status !== "done") return fail(why(job));
    const r = readResult(job);
    if (r.error) return fail(r.error);
    const rezhim = job.rezhim || (job.work ? "pravka" : "tekst");

    // куда пишем
    let target, exists = false;
    if (rezhim === "pravka") {
      if (kuda && !samePath(kuda, job.work.path)) return fail("это задание правило " + job.work.path + "; правку можно перенести только в исходный файл");
      target = job.work.path;
    } else {
      if (!kuda) return fail(rezhim === "zamechaniya" ? "замечания сохраняются только новым файлом: укажи to — полный путь внутри папки проекта" : "для нового текста укажи to — полный путь файла внутри папки проекта");
      target = path.resolve(kuda);
      if (rezhim === "zamechaniya" && perezapisat) return fail("замечания сохраняются только новым файлом; overwrite для них не разрешён");
    }
    try {
      if (!fs.existsSync(job.papka)) return fail("папка проекта недоступна: " + job.papka);
      if (!isInsideReal(target, job.papka)) return fail("файл должен лежать внутри папки проекта " + job.papka + " (с учётом ссылок)");
    } catch (e) { return fail("не удалось проверить путь: " + errText(e)); }
    if (samePath(target, job.draftPath)) return fail("нельзя сохранять в сам общий черновик");
    if (rezhim === "zamechaniya" && job.work && samePath(target, job.work.path)) return fail("нельзя записать замечания в исходный файл");

    // один перенос в один физический файл за раз — замок по реальному пути цели
    let targetKey;
    try { targetKey = canonMaybe(target); } catch (e) { return fail("не удалось проверить путь: " + errText(e)); }
    const lock = await waitLock("apply", targetKey, { jobId: nomer }, 10000);
    if (!lock.ok) return fail(lock.busy ? "в этот файл сейчас переносится другое задание (" + (lock.owner.jobId || "?") + "); попробуй чуть позже" : "не удалось захватить файл: " + lock.error);
    APPLYING.add(nomer);
    const owner = { instance: INSTANCE, pid: process.pid };
    const attempt = crypto.randomBytes(6).toString("hex");
    try {
      let bytes, expectedHash, rangeTxt = null, noChange = false, verify;
      if (rezhim === "pravka") {
        const w = job.work;
        let src;
        try { src = readSource(w.path); } catch (e) { return fail("не удалось прочитать рабочий файл: " + errText(e)); }
        if (src.hash !== w.fileHash) return fail("рабочий файл изменился после отправки задания — перенос отменён, чтобы не затереть свежие правки. Отдай поручение заново по свежему файлу.");
        bytes = withBom(composeEdit(src.text, w.range, r.text), w.bom);
        expectedHash = src.hash;
        noChange = sha(bytes) === src.hash;
        rangeTxt = w.range ? "заменены строки " + w.range.from + "–" + w.range.to + " (было строк: " + (w.range.to - w.range.from + 1) + ", стало: " + splitLines(r.text).length + ")" : "файл заменён целиком";
      } else {
        exists = fs.existsSync(target);
        if (exists && fs.statSync(target).isDirectory()) return fail("по этому пути папка, а не файл: " + target);
        if (exists && !perezapisat) return fail("файл уже есть: " + target + ". " + (rezhim === "tekst" ? "Перезаписать можно только с overwrite: true (если пользователь разрешил заменить именно этот файл)." : "Выбери другое имя."));
        if (exists) { const h = hashFile(target); if (h.error) return fail("не удалось прочитать существующий файл: " + h.error); expectedHash = h.hash || null; }
        else expectedHash = null;
        bytes = Buffer.from(r.text, "utf8");
      }
      const newHash = sha(bytes);
      // фиксируем намерение в карточке (под замком задания, со свежей проверкой статуса)
      let refused = null;
      await updateJob(nomer, (c) => {
        if (c.status !== "done") { refused = why(c); return false; }
        if (noChange) { Object.assign(c, { status: "applied", appliedAt: nowIso(), appliedTo: target, applyNote: "изменений не было — файл не трогали" }); return; }
        c.status = "applying"; c.apply = { target, expectedHash, newHash, owner, attempt, at: nowIso() };
      }).catch((e) => { refused = "не удалось сохранить карточку перед переносом: " + errText(e) + ". Файл не изменён."; });
      if (refused) return fail(refused);
      if (noChange) return reply("Изменений нет — " + target + " не тронут.");

      const stillFresh = () => {
        try {
          if (!isInsideReal(target, job.papka)) return "путь теперь ведёт за пределы папки проекта";
          const h = hashFile(target);
          if (h.error) return h.error;
          if (expectedHash == null) return h.missing ? true : "файл появился, пока шло сохранение";
          return h.hash === expectedHash ? true : "файл изменился во время переноса — перенос отменён";
        } catch (e) { return errText(e); }
      };
      try {
        if (rezhim !== "pravka") fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!isInsideReal(target, job.papka)) throw new Error("путь после создания папок ведёт за пределы проекта");
        if (expectedHash == null) { if (TEST_PUBLISH_DELAY_MS) await sleep(TEST_PUBLISH_DELAY_MS); publishNewFile(target, bytes); }
        else await replaceFileAtomic(target, bytes, stillFresh);
      } catch (e) {
        await updateJob(nomer, (c) => { if (c.status !== "applying" || !c.apply || c.apply.attempt !== attempt) return false; c.status = "done"; delete c.apply; }).catch(() => {});
        log("задание " + nomer + ": перенос не выполнен (" + (e.code || "ошибка") + ")");
        return fail((e.code === "EEXIST" ? "файл появился, пока шло сохранение: " + target + ". Ничего не перезаписано" : errText(e)) + ". Файл не изменён.");
      }
      let se = null;
      await updateJob(nomer, (c) => {
        if (!(c.status === "applying" && c.apply && c.apply.attempt === attempt) && !(c.status === "applied" && c.appliedTo === target)) { se = "карточка в неожиданном состоянии: " + c.status; return false; }
        Object.assign(c, { status: "applied", appliedAt: c.appliedAt || nowIso(), appliedTo: target });
      }).catch((e) => { se = errText(e); });
      log("задание " + nomer + ": перенесено (" + rezhim + (exists ? ", перезапись" : "") + ")" + (se ? "; карточка не обновилась" : ""));
      const warn = se ? " ВНИМАНИЕ: файл записан, но карточка задания не обновилась (" + se + "). Повторно не переноси." : "";
      if (rezhim === "pravka") return reply("Перенесено в " + target + ": " + rangeTxt + "." + warn);
      return reply("Сохранено: " + target + " (" + words(r.text) + " слов" + (exists ? ", существующий файл заменён" : "") + ")." + warn);
    } catch (e) {
      log("задание " + nomer + ": сбой переноса: " + errText(e));
      return fail("сбой переноса: " + errText(e));
    } finally {
      APPLYING.delete(nomer);
      await lock.release();
    }
  }
);

// ---------- отмена ----------
register(
  "most_otmenit",
  "Остановить идущее задание — в этом или в другом экземпляре моста. Уже перенесённое не откатывается.",
  { nomer: z.string().describe("Номер задания.") },
  async ({ nomer }) => {
    const job = await loadNorm(nomer);
    if (!job) return fail("задания " + nomer + " нет." + legacyNote(nomer));
    if (job.corrupt) return fail("карточка задания повреждена: " + job.error);
    if (job.status === 'waiting_quota' || job.status === 'queued') {
      await updateJob(nomer, (c) => {
        if (['waiting_quota', 'queued'].includes(c.status)) {
          c.status = 'cancelled';
          c.finishedAt = nowIso();
        }
      });
      return reply('Ожидание отменено.');
    }
    if (job.status !== "running") {
      const W = { done: "уже готово — результат сохранён, отменять нечего", applied: "уже перенесено", failed: "не удалось раньше", cancelled: "уже отменено", lost: "потеряно" };
      return reply("Задание " + nomer + ": " + (W[job.status] || job.status) + "." + (job.stopNote ? " ВНИМАНИЕ: " + job.stopNote + "." : "") + (job.stopUnconfirmed ? " ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА: процесс Antigravity, номер " + job.stopUnconfirmed.pid + " мог остаться работать." : ""));
    }
    try { fs.writeFileSync(cancelPath(nomer), nowIso()); } catch (e) { return fail("не удалось записать запрос отмены: " + errText(e)); }
    const st = await ownerState(job.owner);
    if (st === "unknown") {
      let outcome = null, errMsg = null;
      await updateJob(nomer, (c) => {
        if (c.status !== "running") { outcome = c.status; return false; }
        Object.assign(c, { status: "lost", finishedAt: nowIso(), problems: ["помечено вручную: владелец задания не отвечал" + (c.agyPid ? "; процесс agy (процесс " + c.agyPid + ") мог остаться работать" : "")] });
        outcome = "lost";
      }, 3000).catch((e) => { errMsg = errText(e); });
      if (errMsg) return reply("Запрос отмены задания " + nomer + " записан, но пометить карточку не удалось (" + errMsg + "). Владелец задания не отвечает; результат может не прийти.");
      if (outcome !== "lost") return reply("Задание " + nomer + " успело перейти в состояние «" + (require("../../common/states")[outcome] || "неизвестно") + "» — помечать его потерянным не нужно. Проверь antigravity_result.");
      log("задание " + nomer + ": помечено потерянным вручную (владелец не отвечает)");
      return reply("Задание " + nomer + " помечено как потерянное: владелец не отвечал. Результата не будет." +
        (job.agyPid ? " Процесс agy (процесс " + job.agyPid + ") мог остаться — мост не останавливает чужие процессы." : "") +
        " Папку проекта держит зависший экземпляр моста; если новое задание в ней не запускается, перезапусти Claude.");
    }
    if (st === "self") requestStop(nomer, "отмена");
    const until = Date.now() + STOP_CONFIRM_MS + 5000;
    while (Date.now() < until) {
      await sleep(500);
      const j = loadJob(nomer);
      if (j && j.status !== "running") {
        if (j.status === "cancelled") return reply("Задание " + nomer + " отменено" + (st === "alive" ? " (другим экземпляром моста)" : "") + "." + (j.stopNote ? " ВНИМАНИЕ: " + j.stopNote + "." : ""));
        return reply("Задание " + nomer + " успело завершиться до отмены: " + (require("../../common/states")[j.status] || "неизвестно") + ". Проверь antigravity_result.");
      }
      if (j && j.stopUnconfirmed) return reply("Отмена задания " + nomer + " запрошена, но ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА: процесс Antigravity, номер " + j.stopUnconfirmed.pid + " может продолжать работу. Проверь antigravity_result позже.");
    }
    return reply("Отмена задания " + nomer + " запрошена" + (st === "alive" ? " у другого экземпляра моста" : "") + ", но остановка пока не подтверждена. Проверь antigravity_result позже.");
  }
);

// ---------- остановка моста ----------
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("мост останавливается: " + reason + "; заданий идёт: " + RUNNING.size);
  const ids = [...RUNNING.keys()];
  const withDeadline = (p, ms) => Promise.race([p.catch(() => {}), sleep(ms)]);
  // 1) честная пометка «мост остановлен, остановка процесса не подтверждена» — параллельно и с общим сроком
  await withDeadline(Promise.all(ids.map((id) => {
    const e = RUNNING.get(id);
    return updateJob(id, (c) => {
      if (c.status !== "running") return false;
      Object.assign(c, { status: "failed", draftStatus: "not_attempted", finishedAt: nowIso(), problems: ["мост остановлен во время задания (" + reason + ")"],
        stopUnconfirmed: { pid: e && e.proc ? e.proc.pid : null, reason: "закрытие моста", at: nowIso() } });
    }, 400).catch(() => {});
  })), 700);
  // 2) остановка — независимо от того, успели ли записаться карточки
  const TREE_NOTE_OWN = "остановлен только основной процесс agy (без taskkill), его потомки могли остаться";
  const results = await Promise.all(ids.map((id) => {
    const entry = RUNNING.get(id);
    if (!entry) return Promise.resolve({ id, r: { closed: true } });
    let note = null;
    const own = () => { if (RUNNING.has(id)) { hardKillOwn(entry.proc); if (isWindows) note = TREE_NOTE_OWN; } };
    if (entry.stopping) own(); // остановка уже идёт (отмена, предел) — сразу запасной путь
    const closedP = new Promise((res) => { if (!RUNNING.has(id)) return res(true); entry.proc.once("close", () => res(true)); });
    const stopP = entry.stopping ? Promise.resolve(null) : requestStop(id, "закрытие моста", { taskkillTimeoutMs: 1500, confirmMs: 1000 });
    return Promise.race([
      Promise.all([closedP, stopP]).then(([c, r]) => ({ closed: c, treeNote: (r && r.treeNote) || note })),
      sleep(2000).then(() => { own(); return Promise.race([closedP, sleep(800).then(() => false)]).then((c) => ({ closed: c, treeNote: note })); }),
    ]).then((r) => ({ id, r }));
  }));
  // 3) подтверждённую остановку основного процесса отмечаем; предупреждение о потомках сохраняем
  await withDeadline(Promise.all(results.map(({ id, r }) => updateJob(id, (c) => {
    if (c.status !== "failed" || !c.stopUnconfirmed || c.stopUnconfirmed.reason !== "закрытие моста") return false;
    if (r && r.treeNote) c.stopNote = r.treeNote;
    if (r && r.closed) delete c.stopUnconfirmed;
  }, 300).catch(() => {}))), 600);
  try { if (instanceServer) instanceServer.close(); } catch (e) {}
  log("мост остановлен");
  process.exit(0);
}

function activityText() {
  const jobs = listJobs(),
    recent = jobs.filter((j) => Date.parse(j.startedAt) > Date.now() - 5 * 3600000),
    waiting = jobs.filter((j) => ['waiting_quota', 'queued'].includes(j.status));
  const last = jobs
    .filter((j) => j.lastQuotaAt)
    .sort((a, b) => Date.parse(b.lastQuotaAt) - Date.parse(a.lastQuotaAt))[0];
  return (
    'За 5 ч: ' +
    recent.length +
    ' поручений; токены: ' +
    recent.reduce((n, j) => n + (Number(j.usage?.total_tokens) || 0), 0) +
    '\nОжидают: ' +
    (waiting.map((j) => j.id + ' до ' + j.nextAttemptAt).join(', ') || 'нет') +
    '\nПоследнее исчерпание: ' +
    (last?.lastQuotaAt || 'не зафиксировано')
  );
}
let scanning = false;
async function resumeQueue() {
  if (access.guest() || scanning || shuttingDown || !instancePipeOk) return;
  scanning = true;
  try {
    await require('../../common/progress').longRunning('Antigravity', listJobs(), updateJob);
    for (const j of listJobs()) {
      if (!['waiting_quota', 'queued'].includes(j.status) || Date.parse(j.nextAttemptAt) > Date.now() || !j.retry)
        continue;
      const st = await ownerState(j.owner);
      if (j.status !== 'queued' && !['self', 'dead'].includes(st)) continue;
      const lock = await tryLock('gen', j.papkaCanon, { jobId: j.id, papka: j.papka });
      if (!lock.ok) continue;
      let claimed = false,
        cur;
      try {
        cur = await updateJob(j.id, async (c) => {
          if (
            !['waiting_quota', 'queued'].includes(c.status) ||
            Date.parse(c.nextAttemptAt) > Date.now() ||
            (c.status !== 'queued' && !['self', 'dead'].includes(await ownerState(c.owner)))
          )
            return false;
          c.status = 'running';
          c.owner = { instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT };
          if (c.retryKind === 'quota' && !c.knownReset) c.quotaAttempts = (c.quotaAttempts || 0) + 1;
          else if (c.retryKind === 'transient') c.transientAttempts = (c.transientAttempts || 0) + 1;
          claimed = true;
        });
      } catch (e) {
        log('Не удалось возобновить: ' + errText(e));
      }
      if (claimed) runJob(cur, cur.retry.args, cur.retry.inputDir, cur.papkaCanon, lock);
      else await lock.release();
    }
  } finally {
    scanning = false;
  }
}
// ---------- запуск ----------
(async () => {
  await require('../../common/state-migration').start(require('../../common/paths'));
  rotateJournal();
  if (!access.guest() && !process.env.MOST_TEST_KEEP) pruneOld();
  // канал экземпляра: по нему другие экземпляры моста узнают, жив ли этот
  const ip = await listenPipe(pipeName("instance", INSTANCE), () => ({ instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT, version: VERSION, file: __filename, running: [...RUNNING.keys()] }));
  if (ip.ok) { instanceServer = ip.srv; instancePipeOk = true; }
  else log("не удалось открыть канал экземпляра: " + ip.error);
  log("мост " + VERSION + " запущен; agy: " + (AGY ? AGY.shown : "не найден") + "; хранилище: " + STATE_DIR);
  if (!access.guest() && AGY && process.env.MOST_PROBE_ONLY !== '1') {
    loadModels().catch(() => {});
    setInterval(
      () => resumeQueue().catch((e) => log(errText(e))),
      Math.min(30000, Number(process.env.MOST_QUEUE_TICK_MS || 1000)),
    ).unref();
    await resumeQueue();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (!isWindows) process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.stdin.on("end", () => shutdown("Claude закрыл связь с мостом (stdin закрыт)"));
  process.stdin.on("close", () => shutdown("Claude закрыл связь с мостом (stdin закрыт)"));
  process.on("uncaughtException", (e) => { log("необработанная ошибка: " + (e && e.stack ? e.stack : errText(e)).slice(0, 2000)); });
  process.on("unhandledRejection", (e) => { log("необработанный отказ: " + (e && e.stack ? e.stack : errText(e)).slice(0, 2000)); });
  const transport = require('../../common/public-transport').publicTransport(new StdioServerTransport());
  server.server.onclose = () => shutdown("связь MCP закрыта");
  await server.connect(transport);
  access.ready('antigravity');
})();
