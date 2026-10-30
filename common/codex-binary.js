'use strict';
// team-v46 п.8: проверка полной папки (рядом с codex.exe лежит codex-code-mode-host.exe) применяется
// только к раскладке приложения %LOCALAPPDATA%\OpenAI\Codex\bin\<хеш>. Явный CODEX_PATH и codex,
// найденный в PATH вне этой раскладки, принимаются как есть (замысел п.10).
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
function complete(bin) {
  if (!bin) return false;
  try { return fs.existsSync(bin) && fs.existsSync(path.join(path.dirname(bin), 'codex-code-mode-host.exe')); }
  catch { return false; }
}
function valid(bin, env = process.env) {
  if (!bin || !fs.existsSync(bin) || !fs.statSync(bin).isFile()) return false;
  const local = env.LOCALAPPDATA;
  if (!local) return true;
  const rel = path.relative(path.resolve(local, 'OpenAI', 'Codex', 'bin'), path.resolve(bin));
  const parts = rel.split(path.sep);
  const appLayout = parts.length === 2 && parts[0] !== '..' && !path.isAbsolute(rel) && /^codex\.exe$/i.test(parts[1]);
  return !appLayout || complete(bin);
}
function findInBin(root) {
  try {
    // Только полные папки bin\<хеш>; при выборе — самая свежая полная.
    return fs.readdirSync(root)
      .map((n) => path.join(root, n, 'codex.exe'))
      .filter((p) => complete(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}
function findCli(env = process.env) {
  // Явный CODEX_PATH принимается как есть (без проверки полной папки).
  if (env.CODEX_PATH) { const p = env.CODEX_PATH; return valid(p, env) ? p : null; }
  try {
    const first = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'codex.exe' : 'codex'], { encoding: 'utf8', windowsHide: true, env })
      .trim().split(/\r?\n/).find(p => valid(p, env));
    // codex из PATH вне раскладки приложения — как есть.
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return env.LOCALAPPDATA ? findInBin(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')) : null;
}
module.exports = { complete, valid, findCli, findInBin };
