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
function windowsAppsDir(env = process.env) {
  const base = env['ProgramFiles'] || (env.SystemDrive ? path.join(env.SystemDrive, 'Program Files') : 'C:\\Program Files');
  return path.join(base, 'WindowsApps');
}
// models-622: свежайший полный codex.exe, вложенный в установленный пакет приложения Codex
// (%ProgramFiles%\WindowsApps\OpenAI.Codex_<версия>_...\app\resources\codex.exe). Приложение обновляется
// отдельно от разложенного им в bin\<хеш> CLI: пока приложение после своего обновления не разложило новый CLI
// в bin, свежий бинарь доступен только внутри пакета. Выбор — по времени установки пакета (самый свежий полный),
// путь к конкретной версии не привязан. Каталог WindowsApps может быть закрыт ACL — тогда тихо пропускаем.
function findInWindowsApps(env = process.env) {
  try {
    const root = windowsAppsDir(env);
    return fs.readdirSync(root)
      .filter((n) => /^OpenAI\.Codex_/i.test(n))
      .map((n) => path.join(root, n, 'app', 'resources', 'codex.exe'))
      .filter((p) => complete(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}
// models-622: самый свежий полный codex.exe среди разложенных в bin\<хеш> и вложенных в пакет приложения.
// Путь не привязан к версии — на каждом разрешении выбирается самый свежий установленный (по времени файла).
function freshestManaged(env = process.env) {
  const candidates = [
    env.LOCALAPPDATA ? findInBin(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')) : null,
    findInWindowsApps(env),
  ].filter(Boolean);
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
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
  // models-622: запасной путь — самый свежий полный CLI из bin\<хеш> приложения ИЛИ из обновлённого пакета
  // приложения (когда приложение обновлено, но ещё не разложило CLI в bin). Версия не захардкожена.
  return freshestManaged(env);
}
module.exports = { complete, valid, findCli, findInBin, findInWindowsApps, freshestManaged };
