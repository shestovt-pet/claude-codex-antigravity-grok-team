#!/usr/bin/env node
// Поддельный agy для автотестов моста. Поведение задаётся метками [[FAKE:...]] в поручении.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
if (argv[0] === "models") { process.stdout.write("Available models:\ngemini-test-high  Gemini Test (High)\nclaude-test  Claude Test\n"); process.exit(0); }
if (argv[0] === "--version") { process.stdout.write("fake-agy 9.9.9\n"); process.exit(0); }

function arg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
let prompt = arg("--print") || "";
const addDir = arg("--add-dir");
let usedPoruchenieFile = false;
// файловый режим: поручение может лежать в файле
const pm = prompt.match(/файл (\S+poruchenie\.txt)/);
if (pm) { prompt = fs.readFileSync(pm[1], "utf8"); usedPoruchenieFile = true; }

function getWork() {
  const m = prompt.match(/=== ТЕКСТ ДЛЯ РАБОТЫ ===\n([\s\S]*?)\n=== КОНЕЦ ТЕКСТА ДЛЯ РАБОТЫ ===/);
  if (m) return m[1];
  const f = prompt.match(/Текст для работы: (.+)$/m);
  if (f) return fs.readFileSync(f[1].trim(), "utf8");
  return null;
}
const directives = [...prompt.matchAll(/\[\[FAKE:([^\]]*)\]\]/g)].map((m) => m[1]);
const has = (name) => directives.find((d) => d === name || d.startsWith(name + ":"));
const val = (name) => { const d = has(name); return d ? d.slice(name.length + 1) : null; };

function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

(async () => {
  if(process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG,JSON.stringify({cwd:process.cwd(),prompt,model:arg('--model')})+'\n');
  if(has('quota')) return out({status:'ERROR',error:{message:'RESOURCE_EXHAUSTED quota exceeded'}});
  if(has('transient')) return out({status:'ERROR',error:{message:'HTTP 429 Too many requests'}});
  if (has("pidfile")) fs.writeFileSync(val("pidfile"), String(process.pid));
  if (has("child")) {
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(val("child"), String(c.pid));
  }
  if (has("sleep")) await new Promise((r) => setTimeout(r, Number(val("sleep"))));
  if (has("hang")) { setInterval(() => {}, 1000); return; }

  let work = getWork();
  if (work != null && /^\d+\| /m.test(work)) work = work.split("\n").map((l) => l.replace(/^\d+\| /, "")).join("\n");
  let text = work != null ? work : "Новый текст.\nВторая строка нового текста.";

  if (has("replace")) { const [a, b] = val("replace").split("=>"); text = text.split(a).join(b); }
  if (has("upperall")) text = text.split("\n").map((l) => l.toUpperCase()).join("\n");
  if (has("prompt")) text = prompt;
  if (has("remarks")) text = "Строка 2: «вторая строка» — лишнее слово.\nСтрока 3: «третья» — опечатка.";
  if (has("literal")) text = Buffer.from(val("literal"), "base64").toString("utf8");
  if (has("intro")) text = "Вот исправленный текст:\n" + text;
  if (has("porcheck")) text = (usedPoruchenieFile ? "POR_FILE_OK" : "POR_FILE_NO") + "\n" + text;
  if (has("empty")) text = "";
  if (has("exitcode")) { out({ status: "SUCCESS", response: text }); process.exit(Number(val("exitcode"))); }

  if (has("ellipsis")) text = text.split("\n")[0] + "\n... (остальной текст без изменений) ...";
  if (has("noisyjson")) { process.stdout.write("думаю {план: да} ещё " + JSON.stringify({ status: "SUCCESS", response: text }) + "\n"); return; }
  if (has("mcptool")) return out({ status: "SUCCESS", response: text, tool_calls: [{ name: "call_mcp_tool", args: { server: "x" } }] });
  if (has("repeatremarks")) { const n = Number(val("repeatremarks")); text = Array.from({ length: n }, (_, i) => "Строка " + (i + 1) + ": «цитата» — замечание номер " + i + ".").join("\n"); }
  if (has("stderr")) process.stderr.write(val("stderr") + "\n");
  if (has("successerror")) return out({ status: "SUCCESS", response: text, error: "мелкая ошибка" });
  // послушная модель: если мост просит метки результата — выводит между ними
  const mk = prompt.match(/<<<РЕЗУЛЬТАТ-([0-9A-F]{6})>>>/);
  if (mk && !has("nomarkers")) {
    const S0 = "<<<РЕЗУЛЬТАТ-" + mk[1] + ">>>", E0 = "<<<КОНЕЦ-РЕЗУЛЬТАТА-" + mk[1] + ">>>";
    const S = has("boldmarks") ? "**" + S0 + "**" : S0, E = has("boldmarks") ? "**" + E0 + "**" : E0;
    let inner = text;
    if (has("fenced")) inner = "```markdown\n" + inner + "\n```";
    if (has("twoblocks")) inner = "```js\na()\n```\n\n```js\nb()\n```";
    text = (has("summary") ? "Приступаю к правке.\n" : "") + S + "\n" + inner + "\n" + E +
      (has("summary") ? "\n\nОтчёт: исправил всё, что нужно." : "") +
      (has("echomark") ? "\nЯ вывел текст перед " + E0 + " как просили." : "") +
      (has("dupmarks") ? "\n" + S0 + "\nещё раз\n" + E0 : "");
  } else if (has("fenced")) text = "```markdown\n" + text + "\n```";
  if (has("jsonlogafter")) { process.stdout.write(JSON.stringify({ status: "SUCCESS", response: text }) + "\n" + JSON.stringify({ event: "finished" }) + "\n"); return; }
  if (has("nonjson")) { process.stdout.write(text + "\n"); return; }
  if (has("nostatus")) return out({ response: text });
  if (has("status")) return out({ status: val("status"), response: "", error: "fake failure" });
  if (has("denied")) return out({ status: "SUCCESS", response: text, denied_actions: ["run_command: rm -rf"] });
  if (has("writetool")) return out({ status: "SUCCESS", response: text, tool_calls: [{ name: "view_file" }, { name: "write_to_file", args: { path: "x" } }] });
  out({ status: "SUCCESS", response: text, usage: { total_tokens: 123 }, tool_calls: [{ name: "view_file" }] });
})();
