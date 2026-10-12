const fs = require("fs");
const path = require("path");
const work = process.argv[2];
const label = process.argv[3] || "round";
if (!work) { console.error("usage: assemble.js WORKDIR [label]"); process.exit(2); }
const prop = path.join(work, "proposals");
if (!fs.existsSync(path.join(prop, "agy.exit")) || !fs.existsSync(path.join(prop, "codex.exit"))) {
  console.error("assemble: need agy.exit and codex.exit");
  process.exit(3);
}
function pick(names) {
  for (const n of names) {
    const p = path.join(prop, n);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return { name: n, text: fs.readFileSync(p, "utf8") };
  }
  return { name: "(missing)", text: "" };
}
function incomplete(text) {
  if (!text || text.trim().length < 400) return true;
  if (/root agent idle|waiting up to/i.test(text)) return true;
  return false;
}
const labeled = label && label !== "round";
const agy = pick(labeled ? ["agy-" + label + ".log"] : ["agy-raw.log", "antigravity.md", "agy-r3.log", "agy-r2.log"]);
const codex = pick(labeled ? ["codex-" + label + ".log"] : ["codex-raw.log", "codex.md", "codex-r3.log", "codex-r2.log"]);
const grok = pick(labeled ? ["grok-" + label + ".md", "grok.md"] : ["grok.md", "grok-r3.md", "grok-r2.md"]);
const agyBad = incomplete(agy.text);
const codexBad = incomplete(codex.text);
const discPath = path.join(work, "DISCUSSION-" + label + ".md");
const note = (agyBad || codexBad)
  ? "Peer log incomplete. Discussion only; no acceptance and no substituted judge. Do not copy a short/idle log over proposals."
  : "Peer files collected. This is not verified participation or a gate decision; inspect provenance and exact revision reviews. Judge authority cannot come from a model name or prompt.";
const body = [
  "# DISCUSSION " + label,
  "",
  note,
  "",
  "Grok file: " + grok.name + " (" + grok.text.length + ")",
  "Agy file: " + agy.name + " (" + agy.text.length + ")" + (agyBad ? " INCOMPLETE" : ""),
  "Codex file: " + codex.name + " (" + codex.text.length + ")" + (codexBad ? " INCOMPLETE" : ""),
  "",
  "## Antigravity",
  "",
  agy.text.slice(0, 50000),
  "",
  "## Codex",
  "",
  codex.text.slice(0, 50000),
  "",
  "## Grok",
  "",
  grok.text.slice(0, 20000),
  ""
].join("\n");
fs.writeFileSync(discPath, body, "utf8");
function publish(dest, src) {
  if (labeled || !src.text || incomplete(src.text)) {
    console.log("keep", dest);
    return;
  }
  fs.writeFileSync(path.join(prop, dest), src.text, "utf8");
}
publish("antigravity.md", agy);
publish("codex.md", codex);
console.log("assembled", discPath);
