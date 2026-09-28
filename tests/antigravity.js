#!/usr/bin/env node
// Автотесты моста most 0.2.0 с поддельным agy. Запуск: node test/run.js  (из папки моста)
"use strict";
// Этот набор проверяет запасной путь и прежний тестовый agy.
process.env.MOST_AGY_INPUT_FORMAT = 'legacy';
process.env.MOST_TEST_KEEP="1";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const isWindows = process.platform === "win32";
const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "servers/antigravity/index.js");
const FAKE = path.join(__dirname, "fake-agy.js");
const RUN = path.join(__dirname, ".tmp-run-" + Date.now().toString(36));
const STATE = path.join(RUN, "state");
const JOURNAL = path.join(RUN, "zhurnal.txt");
fs.mkdirSync(STATE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg + (extra ? "\n      " + String(extra).slice(0, 600).replace(/\n/g, "\n      ") : "")); console.log("   ✗ " + msg); }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
// Уборка за тестом: возвращает, удалось ли остановить процесс.
function hardKill(pid) {
  if (!pid || !pidAlive(pid)) return true;
  if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(pid, "SIGKILL"); } catch (e) {} }
  if (pidAlive(pid)) { try { process.kill(pid); } catch (e) {} }
  return !pidAlive(pid);
}
let skipped = 0;
const skips = [];
function skip(msg) { skipped++; skips.push(msg); console.log("   ○ пропуск: " + msg); }
function pipeNameFor(kind, key) {
  const h = require("crypto").createHash("sha256").update(path.resolve(STATE) + "|" + kind + "|" + key).digest("hex").slice(0, 32);
  if (isWindows) return "\\\\.\\pipe\\most-" + h;
  if (process.platform === "linux") return "\0most-" + h;
  return path.join(os.tmpdir(), "most-" + h + ".sock");
}
// Может ли среда останавливать дерево процессов (в песочнице taskkill бывает запрещён)
let TREE_KILL_OK = true;
async function probeTreeKill() {
  if (!isWindows) return true;
  const pf = path.join(RUN, "probe-grandchild.pid");
  const c = spawn(process.execPath, ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(" + JSON.stringify(pf) + ",String(c.pid));setInterval(()=>{},1000)"], { stdio: "ignore" });
  for (let i = 0; i < 50 && !fs.existsSync(pf); i++) await sleep(100);
  const gc = Number(fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : 0);
  spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
  await sleep(500);
  const ok = gc && !pidAlive(gc);
  try { c.kill(); } catch (e) {}
  if (gc && pidAlive(gc)) { try { process.kill(gc); } catch (e) {} }
  return !!ok;
}

async function startBridge(extraEnv) {
  const env = Object.assign({}, process.env, {
    AGY_PATH: FAKE, MOST_STATE_DIR: STATE, MOST_JOURNAL: JOURNAL, MOST_HEARTBEAT_MS: "500",
  }, extraEnv || {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [INDEX], env, stderr: "pipe" });
  const client = new Client({ name: "most-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid };
}
async function call(b, name, args) {
  const r = await b.client.callTool({ name, arguments: args || {} }, undefined, { timeout: 120000 });
  const text = (r.content || []).map((c) => c.text || "").join("\n");
  return { text, isError: !!r.isError };
}
function jobId(text) { const m = text.match(/Задание (\S+) запущено/); return m ? m[1] : null; }
async function waitDone(b, id, maxSec = 60) {
  const until = Date.now() + maxSec * 1000;
  let r;
  do { r = await call(b, "antigravity_result", { id: id, wait_sec: 5 }); } while (/ещё идёт|сейчас переносится/.test(r.text) && Date.now() < until);
  return r;
}
let projN = 0;
function project(files) {
  const dir = path.join(RUN, "p" + (++projN));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
async function poruchit(b, args) {
  const r = await call(b, "antigravity_send", args);
  return { r, id: jobId(r.text) };
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const tests = [];
function test(name, fn, opts) { tests.push({ name, fn, opts: opts || {} }); }

let B; // основной экземпляр моста

test("здоровье", async () => {
  const r = await call(B, "antigravity_status");
  ok(!r.isError && r.text.includes('Мост ' + require('../package.json').version), "текущая версия в antigravity_status", r.text);
  ok(/gemini-test-high/.test(r.text), "список моделей", r.text);
  ok(/fake-agy 9\.9\.9/.test(r.text), "версия agy", r.text);
});

test("правка всего файла: BOM и CRLF сохраняются, повторный перенос запрещён", async () => {
  const src = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("первая\r\nвторая строка\r\nтретья\r\n", "utf8")]);
  const dir = project({ "a.txt": src });
  const f = path.join(dir, "a.txt");
  const { r, id } = await poruchit(B, { folder: dir, file: f, task: "исправь [[FAKE:replace:вторая=>2-я]]" });
  ok(id, "задание запущено", r.text);
  const it = await waitDone(B, id);
  ok(/Изменённых мест: 1/.test(it.text) && /#1 строка 2/.test(it.text), "итог показывает одно место в строке 2", it.text);
  ok(/Это все места/.test(it.text), "итог говорит, что это все места", it.text);
  ok(/сейчас содержит результат этого задания/.test(it.text), "общий черновик совпадает", it.text);
  const p = await call(B, "antigravity_apply", { id: id });
  ok(!p.isError && /Перенесено/.test(p.text), "перенос выполнен", p.text);
  const after = fs.readFileSync(f);
  const expect = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("первая\r\n2-я строка\r\nтретья\r\n", "utf8")]);
  ok(after.equals(expect), "BOM, CRLF и конечный перевод строки сохранены", JSON.stringify(after.toString("utf8")));
  const p2 = await call(B, "antigravity_apply", { id: id });
  ok(p2.isError && /уже перенесено/.test(p2.text), "повторный перенос запрещён", p2.text);
  const it2 = await call(B, "antigravity_result", { id: id });
  ok(/УЖЕ ПЕРЕНЕСЕНО/.test(it2.text), "итог после переноса", it2.text);
  if (process.env.MOST_TEST_KEEP) skip("Очистка временных файлов отключена: запрет удалений."); else ok(fs.readdirSync(dir).every((n) => !n.startsWith(".~most-")), "временных файлов не осталось", fs.readdirSync(dir).join(","));
});

test("правка диапазона: байты вне диапазона не меняются", async () => {
  const dir = project({ "b.txt": "один\nдва\nтри\nчетыре\nпять" });
  const f = path.join(dir, "b.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, lines: "2-3", task: "[[FAKE:replace:три=>3]]" });
  const it = await waitDone(B, id);
  ok(/строка 3/.test(it.text), "номер строки считается от начала файла", it.text);
  const p = await call(B, "antigravity_apply", { id: id });
  ok(/заменены строки 2–3/.test(p.text), "перенос диапазона", p.text);
  ok(fs.readFileSync(f, "utf8") === "один\nдва\n3\nчетыре\nпять", "остальное без изменений, без конечного перевода строки", JSON.stringify(fs.readFileSync(f, "utf8")));
});

test("свой результат у каждого задания: перенос старого после нового", async () => {
  const dir = project({ "c.txt": "x y z\n" });
  const f = path.join(dir, "c.txt");
  const a = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:y=>A]]" });
  await waitDone(B, a.id);
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:y=>B]]" });
  await waitDone(B, b.id);
  ok(fs.readFileSync(path.join(dir, "_antigravity_result.txt"), "utf8") === "x B z", "общий черновик — от последнего задания");
  const itA = await call(B, "antigravity_result", { id: a.id });
  ok(/ДРУГОЙ текст/.test(itA.text) && /стало: x A z/.test(itA.text), "итог A показывает правку A и предупреждает о черновике", itA.text);
  const p = await call(B, "antigravity_apply", { id: a.id });
  ok(!p.isError, "перенос A разрешён", p.text);
  ok(fs.readFileSync(f, "utf8") === "x A z\n", "в файле — правка A");
  const pb = await call(B, "antigravity_apply", { id: b.id });
  ok(pb.isError && /изменился после отправки/.test(pb.text), "перенос B после A — отказ (файл изменился)", pb.text);
});

test("одно идущее задание на папку; отмена своего задания с потомками", async () => {
  const dir = project({ "d.txt": "текст\n" });
  const f = path.join(dir, "d.txt");
  const childPidFile = path.join(RUN, "child-" + projN + ".pid");
  const a = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:child:" + childPidFile + "]] [[FAKE:hang]]" });
  ok(a.id, "первое задание запущено", a.r.text);
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:т=>Т]]" });
  ok(b.r.isError && /уже идёт задание/.test(b.r.text), "второе в той же папке — отказ", b.r.text);
  await sleep(1200);
  const childPid = Number(fs.existsSync(childPidFile) ? fs.readFileSync(childPidFile, "utf8") : 0);
  const c = await call(B, "antigravity_cancel", { id: a.id });
  ok(/отменено/.test(c.text), "отмена подтверждена", c.text);
  await sleep(1500);
  if (TREE_KILL_OK) ok(childPid && !pidAlive(childPid), "дочерний процесс agy тоже остановлен", "pid " + childPid);
  else skip("остановка потомков agy: среда запрещает taskkill /T (проверка дерева процессов невозможна здесь)");
  if (childPid && pidAlive(childPid)) hardKill(childPid);
  const it = await call(B, "antigravity_result", { id: a.id });
  ok(/отменено/.test(it.text), "итог: отменено", it.text);
  const d = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:т=>Т]]" });
  ok(d.id, "после отмены папка свободна", d.r.text);
  await waitDone(B, d.id);
});

test("исходник изменён после отправки → отказ; правленый черновик не мешает", async () => {
  const dir = project({ "e.txt": "альфа бета\n" });
  const f = path.join(dir, "e.txt");
  const a = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:бета=>гамма]]" });
  await waitDone(B, a.id);
  fs.writeFileSync(path.join(dir, "_antigravity_result.txt"), "мусор руками");
  const it = await call(B, "antigravity_result", { id: a.id });
  ok(/ДРУГОЙ текст/.test(it.text), "итог видит, что черновик правлен", it.text);
  const p = await call(B, "antigravity_apply", { id: a.id });
  ok(!p.isError && fs.readFileSync(f, "utf8") === "альфа гамма\n", "переносится результат задания, а не черновик", p.text);
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:альфа=>омега]]" });
  await waitDone(B, b.id);
  fs.appendFileSync(f, "новая строка\n");
  const pb = await call(B, "antigravity_apply", { id: b.id });
  ok(pb.isError && /изменился после отправки/.test(pb.text), "изменённый исходник — отказ", pb.text);
  ok(fs.readFileSync(f, "utf8") === "альфа гамма\nновая строка\n", "файл не тронут");
});

test("сбои: статус, отказ действий, инструмент записи, пустой ответ, код выхода; черновик не трогается", async () => {
  const dir = project({ "f.txt": "строка\n", "_antigravity_result.txt": "СТАРЫЙ" });
  const f = path.join(dir, "f.txt");
  const cases = [
    ["[[FAKE:status:ERROR]]", /НЕ УДАЛОСЬ[\s\S]*состояние: ошибка[\s\S]*fake failure/],
    ["[[FAKE:denied]]", /НЕ УДАЛОСЬ[\s\S]*запрещённое/],
    ["[[FAKE:writetool]]", /НЕ УДАЛОСЬ[\s\S]*write_to_file/],
    ["[[FAKE:empty]]", /НЕ УДАЛОСЬ[\s\S]*пустой ответ/],
    ["[[FAKE:exitcode:3]]", /НЕ УДАЛОСЬ[\s\S]*кодом 3/],
    ["[[FAKE:mcptool]]", /НЕ УДАЛОСЬ[\s\S]*call_mcp_tool/],
  ];
  for (const [por, re] of cases) {
    const { id, r } = await poruchit(B, { folder: dir, file: f, task: por });
    const it = await waitDone(B, id);
    ok(re.test(it.text), "сбой распознан: " + por, it.text || r.text);
    const p = await call(B, "antigravity_apply", { id: id });
    ok(p.isError, "перенос сбойного задания запрещён: " + por, p.text);
  }
  ok(fs.readFileSync(path.join(dir, "_antigravity_result.txt"), "utf8") === "СТАРЫЙ", "черновик после сбоев не тронут");
});

test("предупреждения: не json, без status, вступление по-русски", async () => {
  const dir = project({ "g.txt": "строка текста\n" });
  const f = path.join(dir, "g.txt");
  const cases = [["[[FAKE:nonjson]]", /без структурированной формы/], ["[[FAKE:nostatus]]", /нет поля состояния status/], ["[[FAKE:intro]]", /вступления: «Вот исправленный текст:»/],
    ["[[FAKE:ellipsis]]", /похоже на сокращение текста/]];
  for (const [por, re] of cases) {
    const { id } = await poruchit(B, { folder: dir, file: f, task: por });
    const it = await waitDone(B, id);
    ok(/готово/.test(it.text) && re.test(it.text), "предупреждение: " + por, it.text);
  }
});

test("JSON после строки с логами распознаётся", async () => {
  const dir = project({ "g2.txt": "строка\n" });
  const { id } = await poruchit(B, { folder: dir, file: path.join(dir, "g2.txt"), task: "[[FAKE:noisyjson]] [[FAKE:replace:строка=>СТРОКА]]" });
  const it = await waitDone(B, id);
  ok(/готово/.test(it.text) && !/без структурированной формы/.test(it.text) && /стало: СТРОКА/.test(it.text), "ответ разобран как JSON", it.text);
});

test("страницы правок: 100 мест", async () => {
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push("keep " + i, "chg " + i);
  const dir = project({ "h.txt": lines.join("\n") + "\n" });
  const f = path.join(dir, "h.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:chg=>CHG]]" });
  const it = await waitDone(B, id);
  ok(/Изменённых мест: 100/.test(it.text) && /Показаны места 1–40 из 100/.test(it.text) && /from_change=41/.test(it.text), "первая страница", it.text.slice(0, 800));
  const it3 = await call(B, "antigravity_result", { id: id, from_change: 81 });
  ok(/Показаны места 81–100 из 100/.test(it3.text) && /Это все места/.test(it3.text) && /#100 строка 200/.test(it3.text), "последняя страница", it3.text.slice(0, 800));
});

test("длинная строка: сокращение и full", async () => {
  const long = "а".repeat(1000) + " СЕРЕДИНА " + "б".repeat(1000);
  const dir = project({ "i.txt": long + "\n" });
  const f = path.join(dir, "i.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:СЕРЕДИНА=>ЦЕНТР]]" });
  const it = await waitDone(B, id);
  ok(/ЦЕНТР/.test(it.text) && it.text.length < 3000, "по умолчанию показано место правки с контекстом", it.text.length);
  const full = await call(B, "antigravity_result", { id: id, full: true });
  ok(full.text.includes("б".repeat(1000)), "full показывает строку целиком", full.text.length);
});

test("замечания: нумерация, правила, сохранение только новым файлом", async () => {
  const dir = project({ "j.txt": "первая\nвторая строка\nтретья\n", "exist.txt": "есть" });
  const f = path.join(dir, "j.txt");
  const pr = await poruchit(B, { folder: dir, file: f, mode: "review", task: "разбери [[FAKE:prompt]]" });
  const it = await waitDone(B, pr.id);
  ok(/2\| вторая строка/.test(it.text), "строки пронумерованы", it.text.slice(0, 1500));
  ok(/Дай только замечания/.test(it.text) && !/верни дословно/.test(it.text), "правила режима замечаний", it.text.slice(0, 1500));
  const { id } = await poruchit(B, { folder: dir, file: f, lines: "2-3", mode: "review", task: "разбери [[FAKE:remarks]]" });
  const it2 = await waitDone(B, id);
  ok(/Замечания Antigravity \(полностью/.test(it2.text) && /Строка 3: «третья»/.test(it2.text), "итог показывает замечания целиком", it2.text);
  const p1 = await call(B, "antigravity_apply", { id: id });
  ok(p1.isError && /только новым файлом/.test(p1.text), "без to — отказ", p1.text);
  const p2 = await call(B, "antigravity_apply", { id: id, to: f });
  ok(p2.isError && /исходный файл/.test(p2.text), "в исходник — отказ", p2.text);
  const p3 = await call(B, "antigravity_apply", { id: id, to: path.join(dir, "exist.txt"), overwrite: true });
  ok(p3.isError && /overwrite для них не разрешён/.test(p3.text), "overwrite — отказ", p3.text);
  const p4 = await call(B, "antigravity_apply", { id: id, to: path.join(dir, "review.txt") });
  ok(!p4.isError && /Строка 2/.test(fs.readFileSync(path.join(dir, "review.txt"), "utf8")), "новый файл с замечаниями", p4.text);
  ok(fs.readFileSync(f, "utf8") === "первая\nвторая строка\nтретья\n", "исходник не тронут");
});

test("новый текст: full, to, overwrite, подпапка", async () => {
  const dir = project({ "old.txt": "старое" });
  const { id } = await poruchit(B, { folder: dir, task: "напиши [[FAKE:literal:" + b64("Строка один.\nСтрока два.") + "]]" });
  const it = await waitDone(B, id);
  ok(/Начало: «Строка один/.test(it.text), "начало и конец", it.text);
  const full = await call(B, "antigravity_result", { id: id, full: true });
  ok(/Весь текст:\n\nСтрока один\.\nСтрока два\./.test(full.text), "full — весь текст", full.text);
  const p1 = await call(B, "antigravity_apply", { id: id, to: path.join(dir, "old.txt") });
  ok(p1.isError && /overwrite: true/.test(p1.text), "существующий без overwrite — отказ", p1.text);
  const p0 = await call(B, "antigravity_apply", { id: id });
  ok(p0.isError && /укажи to/.test(p0.text), "без to — отказ", p0.text);
  const p2 = await call(B, "antigravity_apply", { id: id, to: path.join(dir, "sub", "novoe.txt") });
  ok(!p2.isError && fs.readFileSync(path.join(dir, "sub", "novoe.txt"), "utf8") === "Строка один.\nСтрока два.", "новый файл в подпапке", p2.text);
  const { id: id2 } = await poruchit(B, { folder: dir, task: "[[FAKE:literal:" + b64("Замена") + "]]" });
  await waitDone(B, id2);
  const p3 = await call(B, "antigravity_apply", { id: id2, to: path.join(dir, "old.txt"), overwrite: true });
  ok(!p3.isError && fs.readFileSync(path.join(dir, "old.txt"), "utf8") === "Замена", "overwrite заменяет", p3.text);
});

test("проверки параметров и путей", async () => {
  const outside = project({ "out.txt": "снаружи\n" });
  const dir = project({ "k.txt": "текст\n", "bad.txt": Buffer.from([0xff, 0xfe, 0x41, 0x00]) });
  const f = path.join(dir, "k.txt");
  const cases = [
    [{ folder: dir, task: "x", lines: "1-2" }, /lines указываются только вместе с file/],
    [{ folder: dir, task: "x", file: f, mode: "text" }, /для нового текста file не указывай/],
    [{ folder: dir, task: "x", mode: "edit" }, /нужен file/],
    [{ folder: dir, task: "x", file: path.join(outside, "out.txt") }, /внутри папки проекта/],
    [{ folder: dir, task: "x", file: path.join(dir, "bad.txt") }, /не в кодировке UTF-8/],
    [{ folder: dir, task: "x", file: f, lines: "5-9" }, /вне файла/],
    [{ folder: dir, task: "x", model: "nope" }, /нет в списке/],
    [{ folder: path.join(dir, "нет"), task: "x" }, /папки проекта нет/],
  ];
  for (const [args, re] of cases) {
    const r = await call(B, "antigravity_send", args);
    ok(r.isError && re.test(r.text), "отказ: " + re, r.text);
  }
  fs.writeFileSync(path.join(dir, "_antigravity_result.txt"), "ч");
  const r = await call(B, "antigravity_send", { folder: dir, task: "x", file: path.join(dir, "_antigravity_result.txt") });
  ok(r.isError && /общий черновик нельзя/.test(r.text), "черновик как file — отказ", r.text);
});

test("ссылки и junction не выводят за пределы проекта", async () => {
  const outside = project({ "secret.txt": "секрет\n" });
  const dir = project({ "l.txt": "текст\n" });
  const link = path.join(dir, "vnutri");
  try { fs.symlinkSync(outside, link, isWindows ? "junction" : "dir"); }
  catch (e) { skip("ссылку/junction создать нельзя: " + e.code); return; }
  const r = await call(B, "antigravity_send", { folder: dir, task: "x", file: path.join(link, "secret.txt") });
  ok(r.isError && /внутри папки проекта/.test(r.text), "file через ссылку наружу — отказ", r.text);
  const { id } = await poruchit(B, { folder: dir, task: "[[FAKE:literal:" + b64("т") + "]]" });
  await waitDone(B, id);
  const p = await call(B, "antigravity_apply", { id: id, to: path.join(link, "novyi.txt") });
  ok(p.isError && /внутри папки проекта/.test(p.text), "to через ссылку наружу — отказ", p.text);
  ok(!fs.existsSync(path.join(outside, "novyi.txt")), "снаружи ничего не создано");
});

test("длинный текст и длинное поручение — файлами; временные копии удаляются", async () => {
  const big = Array.from({ length: 600 }, (_, i) => "Строка номер " + i + " с текстом для проверки файлового режима.").join("\n") + "\n";
  const dir = project({ "m.txt": big });
  const f = path.join(dir, "m.txt");
  const longPor = "Поручение. " + "очень длинное поручение ".repeat(400) + " [[FAKE:porcheck]] [[FAKE:replace:номер 5 =>НОМЕР 5 ]]";
  const { id, r } = await poruchit(B, { folder: dir, file: f, task: longPor });
  ok(/файлами/.test(r.text) && /поручение — тоже файлом/.test(r.text), "файловый режим с поручением в файле", r.text);
  const it = await waitDone(B, id);
  ok(/готово/.test(it.text) && /POR_FILE_OK/.test(it.text), "поддельный agy прочитал поручение из файла", it.text.slice(0, 1200));
  if (process.env.MOST_TEST_KEEP) skip("Удаление входных копий отключено: запрет удалений."); else ok(!fs.existsSync(path.join(STATE, "input", id)), "временная папка с копиями удалена");
});

test("большой файл: сравнение с общим началом и концом", async () => {
  const lines = Array.from({ length: 20000 }, (_, i) => "line " + i);
  const dir = project({ "n.txt": lines.join("\n") + "\n" });
  const f = path.join(dir, "n.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:line 10000\n=>LINE 10000\n]]" });
  const it = await waitDone(B, id);
  ok(/Изменённых мест: 1/.test(it.text) && /строка 10001/.test(it.text), "одна правка в большом файле найдена", it.text.slice(0, 600));
});

test("отмена из другого экземпляра моста; здоровье видит чужое задание", async () => {
  const B2 = await startBridge();
  try {
    const dir = project({ "o.txt": "т\n" });
    const pidFile = path.join(RUN, "agy-o.pid");
    const { id } = await poruchit(B, { folder: dir, file: path.join(dir, "o.txt"), task: "[[FAKE:pidfile:" + pidFile + "]] [[FAKE:hang]]" });
    await sleep(1500);
    const h = await call(B2, "antigravity_status");
    ok(h.text.includes(id) && /другой экземпляр моста \(работает\)/.test(h.text), "здоровье второго экземпляра видит задание первого", h.text);
    const c = await call(B2, "antigravity_cancel", { id: id });
    ok(/отменено \(другим экземпляром моста\)/.test(c.text), "отмена через второй экземпляр", c.text);
    await sleep(1000);
    const agyPid = Number(fs.readFileSync(pidFile, "utf8"));
    ok(!pidAlive(agyPid), "процесс agy остановлен владельцем", agyPid);
    if (pidAlive(agyPid)) hardKill(agyPid);
  } finally { await B2.client.close(); }
});

test("владелец погиб: задание потеряно; при сохранённом результате — восстановлено", async () => {
  const B3 = await startBridge();
  const dir = project({ "q.txt": "т\n" });
  const pidFile = path.join(RUN, "agy-q.pid");
  const { id } = await poruchit(B3, { folder: dir, file: path.join(dir, "q.txt"), task: "[[FAKE:pidfile:" + pidFile + "]] [[FAKE:hang]]" });
  await sleep(1500);
  // жёстко убиваем процесс моста через его дескриптор (без штатного shutdown)
  B3.transport._process.kill("SIGKILL");
  await sleep(1500);
  const it = await call(B, "antigravity_result", { id: id, wait_sec: 0 });
  ok(/ПОТЕРЯНО/.test(it.text), "задание погибшего владельца — потеряно", it.text);
  const orphan = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
  if (orphan && pidAlive(orphan)) hardKill(orphan);
  const again = await poruchit(B, { folder: dir, file: path.join(dir, "q.txt"), task: "[[FAKE:replace:т=>Т]]" });
  ok(again.id, "папка освобождена от замка погибшего владельца", again.r.text);
  await waitDone(B, again.id);

  // восстановление: результат записан, карточка не обновилась
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout);
  const rid = "recover_" + Date.now().toString(36);
  const jd = path.join(STATE, "jobs", rid);
  fs.mkdirSync(jd, { recursive: true });
  const f = path.join(dir, "q.txt");
  const srcHash = require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const resText = "ВОССТАНОВЛЕНО";
  const h = require("crypto").createHash("sha256").update(resText).digest("hex");
  fs.writeFileSync(path.join(jd, "result.txt"), resText);
  fs.writeFileSync(path.join(jd, "meta.json"), JSON.stringify({ hash: h, words: 1, warnings: [], finishedAt: new Date().toISOString(), durationSec: 1 }));
  fs.writeFileSync(path.join(jd, "card.json"), JSON.stringify({ id: rid, version: "0.2.0", status: "running", startedAt: new Date().toISOString(), rezhim: "pravka",
    papka: dir, papkaCanon: fs.realpathSync.native(dir), draftPath: path.join(dir, "_antigravity_result.txt"),
    work: { path: f, range: null, fileHash: srcHash, bom: false, text: "Т" }, model: "по умолчанию", owner: { instance: "dead-inst-" + rid, pid: deadPid } }));
  const it2 = await call(B, "antigravity_result", { id: rid, wait_sec: 0 });
  ok(/готово/.test(it2.text) && /Восстановлено/.test(it2.text), "результат восстановлен", it2.text);
  const p = await call(B, "antigravity_apply", { id: rid });
  ok(!p.isError && fs.readFileSync(f, "utf8") === "ВОССТАНОВЛЕНО\n", "восстановленный результат переносится", p.text);
});

test("прерванный перенос распознаётся по файлу", async () => {
  const dir = project({ "r.txt": "новое\n" });
  const f = path.join(dir, "r.txt");
  const crypto = require("crypto");
  const cur = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const rid = "applying_" + Date.now().toString(36);
  const jd = path.join(STATE, "jobs", rid);
  fs.mkdirSync(jd, { recursive: true });
  const resText = "новое";
  fs.writeFileSync(path.join(jd, "result.txt"), resText);
  fs.writeFileSync(path.join(jd, "card.json"), JSON.stringify({ id: rid, status: "applying", startedAt: new Date().toISOString(), rezhim: "pravka", durationSec: 1, words: 1,
    papka: dir, draftPath: path.join(dir, "_antigravity_result.txt"), resultHash: crypto.createHash("sha256").update(resText).digest("hex"),
    work: { path: f, range: null, fileHash: "old", bom: false, text: "старое" }, model: "x",
    apply: { target: f, expectedHash: "old", newHash: cur, owner: { instance: "dead-inst-" + rid, pid: Number(dead.stdout) } } }));
  const it = await call(B, "antigravity_result", { id: rid, wait_sec: 0 });
  ok(/УЖЕ ПЕРЕНЕСЕНО/.test(it.text) && /восстановлено по файлу/.test(it.text), "перенос признан завершённым по файлу", it.text);
});

test("владелец не отвечает: ручная отмена освобождает папку", async () => {
  const dir = project({ "s.txt": "т\n" });
  const rid = "unknown_" + Date.now().toString(36);
  const jd = path.join(STATE, "jobs", rid);
  fs.mkdirSync(jd, { recursive: true });
  // «владелец» держит канал экземпляра, но не отвечает
  const inst = "silent-inst-" + rid;
  const silent = require("net").createServer(() => {});
  await new Promise((r) => silent.listen(pipeNameFor("instance", inst), r));
  fs.writeFileSync(path.join(jd, "card.json"), JSON.stringify({ id: rid, status: "running", startedAt: new Date().toISOString(), rezhim: "tekst",
    papka: dir, papkaCanon: fs.realpathSync.native(dir), draftPath: path.join(dir, "_antigravity_result.txt"), work: null, model: "x",
    owner: { instance: inst, pid: process.pid } }));
  const it = await call(B, "antigravity_result", { id: rid, wait_sec: 0 });
  ok(/не отвечает/.test(it.text), "итог сообщает, что владелец не отвечает", it.text);
  const c = await call(B, "antigravity_cancel", { id: rid });
  ok(/помечено как потерянное/.test(c.text), "ручная отмена", c.text);
  silent.close();
});

test("закрытие связи Claude: мост останавливает agy и помечает задание", async () => {
  const B4 = await startBridge();
  const dir = project({ "t.txt": "т\n" });
  const pidFile = path.join(RUN, "agy-t.pid");
  const { id } = await poruchit(B4, { folder: dir, file: path.join(dir, "t.txt"), task: "[[FAKE:pidfile:" + pidFile + "]] [[FAKE:hang]]" });
  await sleep(1500);
  await B4.client.close();
  await sleep(3000);
  const agyPid = Number(fs.readFileSync(pidFile, "utf8"));
  ok(!pidAlive(agyPid), "agy остановлен при закрытии связи", agyPid);
  if (pidAlive(agyPid)) hardKill(agyPid);
  const it = await call(B, "antigravity_result", { id: id, wait_sec: 0 });
  ok(/НЕ УДАЛОСЬ[\s\S]*мост остановлен/.test(it.text), "задание помечено", it.text);
});

test("предел времени", async () => {
  const B5 = await startBridge({ MOST_WATCHDOG_MS: "1500" });
  try {
    const dir = project({ "u.txt": "т\n" });
    const pidFile = path.join(RUN, "agy-u.pid");
    const { id } = await poruchit(B5, { folder: dir, file: path.join(dir, "u.txt"), task: "[[FAKE:pidfile:" + pidFile + "]] [[FAKE:hang]]" });
    const it = await waitDone(B5, id, 30);
    ok(/НЕ УДАЛОСЬ[\s\S]*не уложилось/.test(it.text), "задание остановлено по пределу", it.text);
    const agyPid = Number(fs.readFileSync(pidFile, "utf8"));
    ok(!pidAlive(agyPid), "agy остановлен по пределу", agyPid);
    if (pidAlive(agyPid)) hardKill(agyPid);
  } finally { await B5.client.close(); }
});

test("Windows: занятый файл — отказ без порчи, повтор после освобождения", async () => {
  let holdN = 0;
  async function holdFile(f, share, seconds) {
    const marker = path.join(RUN, "held-" + (++holdN) + "-" + Date.now() + ".marker");
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      "$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open('" + f.replace(/'/g, "''") + "','Open','Read','" + share + "'); Set-Content -LiteralPath '" + marker.replace(/'/g, "''") + "' -Value 1; Start-Sleep -Seconds " + seconds + "; $f.Close()"],
      { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await sleep(100);
    if (!fs.existsSync(marker)) { try { ps.kill(); } catch (e) {} return null; }
    return { done: new Promise((r) => ps.on("exit", r)) };
  }
  // 1) файл открыт с запретом любого совместного доступа: мост не может даже прочитать
  const dir = project({ "w.txt": "занято\n" });
  const f = path.join(dir, "w.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:занято=>свободно]]" });
  await waitDone(B, id);
  let h = await holdFile(f, "None", 6);
  if (!h) { skip("PowerShell не смог открыть файл — проверка занятого файла невозможна"); return; }
  const p = await call(B, "antigravity_apply", { id: id });
  ok(p.isError && /занят другой программой/.test(p.text), "понятный отказ при запрете чтения", p.text);
  await h.done;
  ok(fs.readFileSync(f, "utf8") === "занято\n", "файл цел после отказа");
  // 2) чтение разрешено, замена запрещена: мост повторяет попытки ~5 с и отказывает
  h = await holdFile(f, "Read", 9);
  if (!h) { skip("PowerShell не смог открыть файл во втором варианте"); return; }
  const t0 = Date.now();
  const p2 = await call(B, "antigravity_apply", { id: id });
  ok(p2.isError && /занят другой программой|нет прав на замену/.test(p2.text) && Date.now() - t0 >= 3000, "повторы замены и понятный отказ", p2.text);
  await h.done;
  ok(fs.readFileSync(f, "utf8") === "занято\n", "файл цел после неудачных повторов");
  if (process.env.MOST_TEST_KEEP) skip("Очистка временных файлов отключена: запрет удалений."); else ok(fs.readdirSync(dir).every((n) => !n.startsWith(".~most-")), "временных файлов не осталось", fs.readdirSync(dir).join(","));
  const it = await call(B, "antigravity_result", { id: id });
  ok(/готово/.test(it.text) && !/УЖЕ ПЕРЕНЕСЕНО/.test(it.text), "задание снова готово к переносу", it.text.slice(0, 300));
  // 3) освобождение — перенос проходит
  const p3 = await call(B, "antigravity_apply", { id: id });
  ok(!p3.isError && fs.readFileSync(f, "utf8") === "свободно\n", "перенос после освобождения", p3.text);
}, { windowsOnly: true });


test("смешанные концы строк: без правок байты не меняются, у неизменённых строк окончания сохраняются", async () => {
  const dir = project({ "mix.txt": "a\r\nb\nc\r\n" });
  const f = path.join(dir, "mix.txt");
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:zzz=>y]]" });
  const it = await waitDone(B, id);
  ok(/Изменений нет/.test(it.text), "итог: изменений нет", it.text);
  const p = await call(B, "antigravity_apply", { id: id });
  ok(/не тронут/.test(p.text) && fs.readFileSync(f).equals(Buffer.from("a\r\nb\nc\r\n")), "файл побайтово тот же", p.text);
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:b=>B]]" });
  await waitDone(B, b.id);
  await call(B, "antigravity_apply", { id: b.id });
  ok(fs.readFileSync(f).equals(Buffer.from("a\r\nB\nc\r\n")), "окончания строк сохранены", JSON.stringify(fs.readFileSync(f, "utf8")));
});

test("диапазон на первой и последней строке", async () => {
  const dir = project({ "fl.txt": "один\nдва\nтри" });
  const f = path.join(dir, "fl.txt");
  const a = await poruchit(B, { folder: dir, file: f, lines: "1", task: "[[FAKE:replace:один=>1]]" });
  await waitDone(B, a.id); await call(B, "antigravity_apply", { id: a.id });
  const b = await poruchit(B, { folder: dir, file: f, lines: "3", task: "[[FAKE:replace:три=>3]]" });
  await waitDone(B, b.id); await call(B, "antigravity_apply", { id: b.id });
  ok(fs.readFileSync(f, "utf8") === "1\nдва\n3", "первая и последняя строки заменены, конца строки не появилось", JSON.stringify(fs.readFileSync(f, "utf8")));
});

test("папка с пробелами, кириллицей и апострофом", async () => {
  const dir = path.join(RUN, "папка с пробелом и ' апостроф");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "файл 1.txt");
  fs.writeFileSync(f, "слово\n");
  const { id, r } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:слово=>СЛОВО]]" });
  ok(id, "задание запущено", r.text);
  await waitDone(B, id);
  const p = await call(B, "antigravity_apply", { id: id });
  ok(!p.isError && fs.readFileSync(f, "utf8") === "СЛОВО\n", "перенос прошёл", p.text);
});

test("поручение с кавычками и обратными слешами — длина считается с экранированием", async () => {
  const dir = project({ "q2.txt": "т\n" });
  const por = "\"\\".repeat(4500) + " [[FAKE:replace:т=>Т]]";
  const { id, r } = await poruchit(B, { folder: dir, file: path.join(dir, "q2.txt"), task: por });
  ok(/файлами/.test(r.text), "выбран файловый режим", r.text);
  const it = await waitDone(B, id);
  ok(/готово/.test(it.text), "задание выполнено", it.text.slice(0, 300));
});

test("статусы CANCELLED, MAX_STEPS_REACHED — сбой; SUCCESS с error — предупреждение", async () => {
  const dir = project({ "st.txt": "т\n" });
  const f = path.join(dir, "st.txt");
  for (const stt of ["CANCELLED", "MAX_STEPS_REACHED"]) {
    const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:status:" + stt + "]]" });
    const it = await waitDone(B, id);
    ok(/НЕ УДАЛОСЬ/.test(it.text) && it.text.includes(stt === 'CANCELLED' ? 'отменено' : 'достигнут предел шагов'), "сбой: " + stt, it.text);
  }
  const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:successerror]]" });
  const it = await waitDone(B, id);
  ok(/готово/.test(it.text) && /сообщил ошибку: мелкая ошибка/.test(it.text), "предупреждение при SUCCESS с error", it.text);
});

test("длинные замечания читаются частями (from_char)", async () => {
  const dir = project({ "rr.txt": "т\n" });
  const { id } = await poruchit(B, { folder: dir, file: path.join(dir, "rr.txt"), mode: "review", task: "[[FAKE:repeatremarks:2000]]" });
  const it = await waitDone(B, id);
  ok(/from_char=40000/.test(it.text), "первая часть и указатель продолжения", it.text.slice(-300));
  const it2 = await call(B, "antigravity_result", { id: id, from_char: 40000 });
  ok(/продолжение с символа 40000/.test(it2.text) && /from_char=80000/.test(it2.text), "вторая часть", it2.text.slice(-300));
  const it3 = await call(B, "antigravity_result", { id: id, from_char: 80000 });
  ok(/номер 1999\./.test(it3.text) && !/Продолжение: antigravity_result/.test(it3.text), "последняя часть без указателя", it3.text.slice(-300));
});

test("одновременный запуск из двух экземпляров в одной папке — проходит один", async () => {
  const B2 = await startBridge();
  try {
    const dir = project({ "cc.txt": "т\n" });
    const f = path.join(dir, "cc.txt");
    const [a, b] = await Promise.all([
      poruchit(B, { folder: dir, file: f, task: "[[FAKE:sleep:1500]]" }),
      poruchit(B2, { folder: dir, file: f, task: "[[FAKE:sleep:1500]]" }),
    ]);
    ok((a.id ? 1 : 0) + (b.id ? 1 : 0) === 1, "запущено ровно одно задание", a.r.text + " | " + b.r.text);
    const loser = a.id ? b : a;
    ok(/уже идёт задание/.test(loser.r.text), "второй получил отказ", loser.r.text);
    await waitDone(a.id ? B : B2, a.id || b.id);
  } finally { await B2.client.close(); }
});

test("одновременный перенос одного задания из двух экземпляров — выполняется один", async () => {
  const B2 = await startBridge();
  try {
    const dir = project({ "cp.txt": "раз\n" });
    const f = path.join(dir, "cp.txt");
    const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:replace:раз=>два]]" });
    await waitDone(B, id);
    const [p1, p2] = await Promise.all([call(B, "antigravity_apply", { id: id }), call(B2, "antigravity_apply", { id: id })]);
    ok([p1, p2].filter((x) => !x.isError).length === 1, "перенесено ровно один раз", p1.text + " | " + p2.text);
    ok(fs.readFileSync(f, "utf8") === "два\n", "файл верный");
  } finally { await B2.client.close(); }
});

test("перенос из другого экземпляра, пока владелец дописывает черновик, не откатывается", async () => {
  const B6 = await startBridge({ MOST_TEST_DRAFT_DELAY_MS: "2500" });
  try {
    const dir = project({ "rc.txt": "раз\n" });
    const f = path.join(dir, "rc.txt");
    const { id } = await poruchit(B6, { folder: dir, file: f, task: "[[FAKE:replace:раз=>два]]" });
    const it = await waitDone(B, id);
    ok(/готово/.test(it.text), "готово до записи черновика", it.text.slice(0, 200));
    const p = await call(B, "antigravity_apply", { id: id });
    ok(!p.isError, "перенос другим экземпляром", p.text);
    await sleep(3500);
    const it2 = await call(B, "antigravity_result", { id: id });
    ok(/УЖЕ ПЕРЕНЕСЕНО/.test(it2.text), "статус «перенесено» не затёрт владельцем", it2.text.slice(0, 400));
    const p2 = await call(B, "antigravity_apply", { id: id });
    ok(p2.isError && /уже перенесено/.test(p2.text), "повторный перенос запрещён", p2.text);
  } finally { await B6.client.close(); }
});

test("новый файл появился в последний момент — не перезаписывается", async () => {
  const B7 = await startBridge({ MOST_TEST_PUBLISH_DELAY_MS: "1500" });
  try {
    const dir = project({});
    const { id } = await poruchit(B7, { folder: dir, task: "[[FAKE:literal:" + b64("НАШ ТЕКСТ") + "]]" });
    await waitDone(B7, id);
    const target = path.join(dir, "gonka.txt");
    const pending = call(B7, "antigravity_apply", { id: id, to: target });
    await sleep(600);
    fs.writeFileSync(target, "ЧУЖОЕ");
    const p = await pending;
    ok(p.isError && /появился/.test(p.text), "отказ: файл появился", p.text);
    ok(fs.readFileSync(target, "utf8") === "ЧУЖОЕ", "чужой файл не перезаписан");
  } finally { await B7.client.close(); }
});

test("в журнал не попадают тексты ответа, stderr и ошибки", async () => {
  const dir = project({ "sec.txt": "т\n" });
  const f = path.join(dir, "sec.txt");
  const cases = ["[[FAKE:literal:" + b64("МАРКЕР-ОТВЕТА-7731 quota") + "]]", "[[FAKE:stderr:МАРКЕР-STDERR-7732]] [[FAKE:exitcode:2]]", "[[FAKE:status:ERROR]]"];
  for (const c of cases) { const { id } = await poruchit(B, { folder: dir, file: f, task: "МАРКЕР-ПОРУЧЕНИЯ-7733 " + c }); await waitDone(B, id); }
  const j = fs.readFileSync(JOURNAL, "utf8");
  ok(!/МАРКЕР-/.test(j) && !/fake failure/.test(j), "маркеров в журнале нет", j.split("\n").filter((l) => /МАРКЕР|fake failure/.test(l)).join("\n"));
});

test("дописывание строк в конец файла без конечного перевода строки", async () => {
  const cases = [["a", "a\nb", "a\nb"], ["a\nb", "a\nb\nc", "a\nb\nc"], ["a\r\nb", "a\nb\nc", "a\r\nb\r\nc"], ["a\nb\n", "a\nb\nc", "a\nb\nc\n"], ["x\ny", "y", "y"]];
  for (const [src, res, expect] of cases) {
    const dir = project({ "eof.txt": src });
    const f = path.join(dir, "eof.txt");
    const { id } = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:literal:" + b64(res) + "]]" });
    await waitDone(B, id);
    const p = await call(B, "antigravity_apply", { id: id });
    ok(!p.isError && fs.readFileSync(f, "utf8") === expect, "перенос " + JSON.stringify(src) + " → " + JSON.stringify(res), JSON.stringify(fs.readFileSync(f, "utf8")) + " | " + p.text);
  }
});

test("сбой сохранения карточки «готово» не превращает результат в ошибку", async () => {
  const B8 = await startBridge({ MOST_TEST_FAIL_SAVE_DONE: "1" });
  try {
    const dir = project({ "fs.txt": "раз\n" });
    const f = path.join(dir, "fs.txt");
    const { id } = await poruchit(B8, { folder: dir, file: f, task: "[[FAKE:replace:раз=>два]]" });
    const it = await waitDone(B8, id);
    ok(/готово/.test(it.text) && /Восстановлено/.test(it.text), "задание готово, результат восстановлен", it.text.slice(0, 400));
    const p = await call(B8, "antigravity_apply", { id: id });
    ok(!p.isError && fs.readFileSync(f, "utf8") === "два\n", "результат переносится", p.text);
  } finally { await B8.client.close(); }
});

test("неизвестный статус не попадает в журнал текстом", async () => {
  const dir = project({ "us.txt": "т\n" });
  const { id } = await poruchit(B, { folder: dir, file: path.join(dir, "us.txt"), task: "[[FAKE:status:ТАЙНЫЙ_СТАТУС_991]]" });
  const it = await waitDone(B, id);
  ok(/НЕ УДАЛОСЬ/.test(it.text) && /ТАЙНЫЙ_СТАТУС_991/.test(it.text), "в ответе Claude статус виден", it.text);
  const j = fs.readFileSync(JOURNAL, "utf8");
  ok(!/ТАЙНЫЙ_СТАТУС_991/.test(j) && /status:UNKNOWN/.test(j), "в журнале — только status:UNKNOWN");
});

test("живой перенос другого экземпляра не «восстанавливается»", async () => {
  const dir = project({ "la.txt": "т\n" });
  const rid = "liveapply_" + Date.now().toString(36);
  const jd = path.join(STATE, "jobs", rid);
  fs.mkdirSync(jd, { recursive: true });
  const inst = "live-inst-" + rid;
  const live = require("net").createServer((sock) => sock.end(JSON.stringify({ instance: inst, pid: process.pid })));
  await new Promise((r) => live.listen(pipeNameFor("instance", inst), r));
  try {
    fs.writeFileSync(path.join(jd, "result.txt"), "Т");
    fs.writeFileSync(path.join(jd, "card.json"), JSON.stringify({ id: rid, status: "applying", startedAt: new Date().toISOString(), rezhim: "pravka", durationSec: 1, words: 1,
      papka: dir, draftPath: path.join(dir, "_antigravity_result.txt"), work: { path: path.join(dir, "la.txt"), range: null, fileHash: "x", bom: false, text: "т" }, model: "x",
      apply: { target: path.join(dir, "la.txt"), expectedHash: "x", newHash: "y", attempt: "a1", owner: { instance: inst, pid: process.pid } } }));
    const it = await call(B, "antigravity_result", { id: rid, wait_sec: 0 });
    ok(/сейчас переносится/.test(it.text), "итог: переносится (владелец жив)", it.text);
    const card = JSON.parse(fs.readFileSync(path.join(jd, "card.json"), "utf8"));
    ok(card.status === "applying" && card.apply && card.apply.attempt === "a1", "карточка живого переноса не тронута", JSON.stringify(card).slice(0, 300));
  } finally { live.close(); }
});

test("метки результата: отчёт вне меток отбрасывается, обёртка ``` не снимается (только предупреждение), без меток — предупреждение", async () => {
  const dir = project({ "mk.txt": "раз\nдва\n" });
  const f = path.join(dir, "mk.txt");
  const a = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:summary]] [[FAKE:replace:два=>2]]" });
  const ia = await waitDone(B, a.id);
  ok(/вне меток результата был текст/.test(ia.text) && /Изменённых мест: 1/.test(ia.text), "отчёт отброшен, правка одна", ia.text);
  await call(B, "antigravity_apply", { id: a.id });
  ok(fs.readFileSync(f, "utf8") === "раз\n2\n", "в файл попал только результат", JSON.stringify(fs.readFileSync(f, "utf8")));
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:fenced]] [[FAKE:replace:раз=>1]]" });
  const ib = await waitDone(B, b.id);
  ok(/не лишняя ли это обёртка \(мост её не снимает\)/.test(ib.text), "обёртка не снимается, только предупреждение", ib.text);
  const d = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:echomark]] [[FAKE:boldmarks]] [[FAKE:replace:раз=>один]]" });
  const id2 = await waitDone(B, d.id);
  ok(/Изменённых мест: 1/.test(id2.text) && !/Я вывел текст/.test(id2.text.split("Изменённых мест")[1] || ""), "упоминание метки в отчёте и оформленные метки не портят результат", id2.text);
  await call(B, "antigravity_apply", { id: d.id });
  ok(fs.readFileSync(f, "utf8") === "один\n2\n", "в файле только результат", JSON.stringify(fs.readFileSync(f, "utf8")));
  const c = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:nomarkers]]" });
  const ic = await waitDone(B, c.id);
  ok(/метки результата не найдены/.test(ic.text), "без меток — предупреждение", ic.text);
});

test("восстановление не трогает новую попытку переноса, начатую пока решали", async () => {
  const B9 = await startBridge({ MOST_TEST_NORMALIZE_DELAY_MS: "1500" });
  const inst = "live2-inst-" + Date.now().toString(36);
  const live = require("net").createServer((sock) => sock.end(JSON.stringify({ instance: inst })));
  await new Promise((r) => live.listen(pipeNameFor("instance", inst), r));
  try {
    const dir = project({ "na.txt": "т\n" });
    const rid = "newattempt_" + Date.now().toString(36);
    const jd = path.join(STATE, "jobs", rid);
    fs.mkdirSync(jd, { recursive: true });
    fs.writeFileSync(path.join(jd, "result.txt"), "Т");
    const base = { id: rid, status: "applying", startedAt: new Date().toISOString(), rezhim: "pravka", durationSec: 1, words: 1,
      papka: dir, draftPath: path.join(dir, "_antigravity_result.txt"), work: { path: path.join(dir, "na.txt"), range: null, fileHash: "x", bom: false, text: "т" }, model: "x" };
    const cardFile = path.join(jd, "card.json");
    fs.writeFileSync(cardFile, JSON.stringify(Object.assign({}, base, { apply: { target: path.join(dir, "na.txt"), expectedHash: "x", newHash: "y", attempt: "old", owner: { instance: "dead-" + rid, pid: 1 } } })));
    const pending = call(B9, "antigravity_result", { id: rid, wait_sec: 0 });
    await sleep(700);
    // пока мост решает судьбу старой попытки, начинается новая — с живым владельцем
    fs.writeFileSync(cardFile, JSON.stringify(Object.assign({}, base, { apply: { target: path.join(dir, "na.txt"), expectedHash: "x", newHash: "y", attempt: "new", owner: { instance: inst, pid: process.pid } } })));
    await pending;
    const card = JSON.parse(fs.readFileSync(cardFile, "utf8"));
    ok(card.status === "applying" && card.apply && card.apply.attempt === "new", "новая попытка не тронута", JSON.stringify(card).slice(0, 300));
  } finally { live.close(); await B9.client.close(); }
});

test("метки: две пары — неоднозначно, перенос невозможен; два блока ``` и новый текст в ``` не срезаются; без меток ``` не трогаются", async () => {
  const dir = project({ "m2.txt": "раз\n" });
  const f = path.join(dir, "m2.txt");
  const a = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:dupmarks]]" });
  const ia = await waitDone(B, a.id);
  ok(/НЕ УДАЛОСЬ/.test(ia.text) && /неоднозначна/.test(ia.text), "две пары меток — сбой", ia.text);
  ok(fs.existsSync(path.join(STATE, "jobs", a.id, "raw.txt")) && /полный ответ Antigravity сохранён/.test(ia.text), "полный ответ сохранён в raw.txt и путь назван");
  const b = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:twoblocks]]" });
  const ib = await waitDone(B, b.id);
  ok(/проверь, не лишняя ли это обёртка/.test(ib.text) && /b\(\)/.test((await call(B, "antigravity_result", { id: b.id, full: true })).text), "два блока ``` не срезаны", ib.text);
  const c = await poruchit(B, { folder: dir, task: "[[FAKE:fenced]] [[FAKE:literal:" + b64("код") + "]]" });
  const ic = await waitDone(B, c.id);
  const full = await call(B, "antigravity_result", { id: c.id, full: true });
  ok(/проверь, не лишняя ли это обёртка/.test(ic.text) && /```markdown/.test(full.text), "в новом тексте ``` не срезается", full.text);
  const d = await poruchit(B, { folder: dir, file: f, task: "[[FAKE:nomarkers]] [[FAKE:fenced]]" });
  const id2 = await waitDone(B, d.id);
  ok(/метки результата не найдены/.test(id2.text), "без меток — предупреждение", id2.text);
  // намеренно добавленный одиночный блок ``` должен дойти до файла
  const dir2 = project({ "example.md": "console.log(1);\n" });
  const f2 = path.join(dir2, "example.md");
  const e = await poruchit(B, { folder: dir2, file: f2, task: "оформи как блок кода [[FAKE:literal:" + b64("```js\nconsole.log(1);\n```") + "]]" });
  await waitDone(B, e.id);
  const pe = await call(B, "antigravity_apply", { id: e.id });
  ok(!pe.isError && fs.readFileSync(f2, "utf8") === "```js\nconsole.log(1);\n```\n", "порученная обёртка ``` сохранена в файле", JSON.stringify(fs.readFileSync(f2, "utf8")) + " | " + pe.text);
});

test("строка журнала {\"event\":…} после ответа не подменяет ответ", async () => {
  const dir = project({ "jl.txt": "раз\n" });
  const { id } = await poruchit(B, { folder: dir, file: path.join(dir, "jl.txt"), task: "[[FAKE:jsonlogafter]] [[FAKE:replace:раз=>два]]" });
  const it = await waitDone(B, id);
  ok(/готово/.test(it.text) && /стало: два/.test(it.text), "ответ взят из правильного объекта", it.text);
});

test("закрытие связи во время зависшей отмены: agy всё равно останавливается", async () => {
  const B10 = await startBridge({ MOST_TEST_KILLTREE_HANG: "1" });
  const dir = project({ "sh.txt": "т\n" });
  const pidFile = path.join(RUN, "agy-sh.pid");
  const { id } = await poruchit(B10, { folder: dir, file: path.join(dir, "sh.txt"), task: "[[FAKE:pidfile:" + pidFile + "]] [[FAKE:hang]]" });
  await sleep(1500);
  call(B10, "antigravity_cancel", { id: id }).catch(() => {}); // остановка «зависает» на taskkill
  await sleep(1500);
  await B10.client.close();
  await sleep(6000);
  const agyPid = Number(fs.readFileSync(pidFile, "utf8"));
  ok(!pidAlive(agyPid), "agy остановлен запасным путём при закрытии моста", agyPid);
  if (pidAlive(agyPid)) hardKill(agyPid);
  const it = await call(B, "antigravity_result", { id: id, wait_sec: 0 });
  ok(/НЕ УДАЛОСЬ[\s\S]*мост остановлен/.test(it.text), "задание помечено", it.text);
});

test("закрытие моста с несколькими заданиями: все agy остановлены быстро", async () => {
  const B11 = await startBridge();
  const pids = [];
  for (let k = 0; k < 3; k++) {
    const dir = project({ "m.txt": "т\n" });
    const pf = path.join(RUN, "agy-multi-" + k + ".pid");
    pids.push(pf);
    await poruchit(B11, { folder: dir, file: path.join(dir, "m.txt"), task: "[[FAKE:pidfile:" + pf + "]] [[FAKE:hang]]" });
  }
  await sleep(1500);
  const t0 = Date.now();
  await B11.client.close();
  await sleep(1000);
  const alive = pids.map((pf) => Number(fs.readFileSync(pf, "utf8"))).filter((p) => pidAlive(p));
  ok(alive.length === 0, "все три agy остановлены к моменту закрытия (" + (Date.now() - t0) + " мс)", alive.join(","));
  for (const p of alive) hardKill(p);
});

test("журнал", async () => {
  const j = fs.readFileSync(JOURNAL, "utf8");
  ok(j.includes('мост ' + require('../package.json').version + ' запущен') && /: done/.test(j) && /перенесено \(pravka/.test(j), "журнал пишет запуск, итоги и переносы", j.slice(-800));
  ok(!/2-я строка/.test(j), "тексты в журнал не попадают");
});

(async () => {
  console.log("Мост: " + INDEX + "\nNode " + process.version + ", " + process.platform + "\nПапка прогона: " + RUN + "\n");
  TREE_KILL_OK = await probeTreeKill();
  if (!TREE_KILL_OK) console.log("Среда не даёт taskkill /T останавливать дерево процессов — проверки потомков будут пропущены.\n");
  B = await startBridge();
  for (const t of tests) {
    if (t.opts.windowsOnly && !isWindows) { console.log("○ " + t.name + " — только на Windows, пропуск"); continue; }
    const before = failed;
    const t0 = Date.now();
    try { await t.fn(); }
    catch (e) { ok(false, "исключение: " + (e && e.stack ? e.stack : e)); }
    console.log((failed === before ? "✓ " : "✗ ") + t.name + " (" + (Date.now() - t0) + " мс)");
  }
  try { await B.client.close(); } catch (e) {}
  console.log("\nИтого: проверок пройдено " + passed + ", провалено " + failed + ", пропущено " + skipped + ".");
  if (skips.length) console.log("Пропуски:\n - " + skips.join("\n - "));
  if (failures.length) console.log("\nПровалы:\n - " + failures.join("\n - "));
  if (!failed && !process.env.MOST_TEST_KEEP) { try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (e) {} }
  process.exit(failed ? 1 : 0);
})();
