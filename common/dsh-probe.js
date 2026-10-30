'use strict';
// Проба отказа записи для установленной версии dsh: до успешной пробы голос DeepSeek не засчитывается.
// Версия записи сверяется с фактической версией dsh (dsh --version, кэш); MOST_DSH_VERSION — только для тестов.
const fs = require('fs'), path = require('path'), cp = require('child_process');
// .cmd/.bat запускается через cmd.exe: путь с пробелом («DeepSeek Harness») берётся в кавычки (ревью Antigravity mvijbpe2).
const viaShell = b => /\.(cmd|bat)$/i.test(b || '');
const command = b => viaShell(b) && !/^".*"$/.test(b) ? '"' + b + '"' : b;
const file = () => path.join(require('./paths').stateDir, 'dsh-probe.json');
let _current, _at = 0;
// Поиск dsh — один для сервера и пробы: путь из реестра, DSH_PATH, where/which, папка приложения DeepSeek Harness.
function binary() {
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(require('./paths').stateDir, 'members.json'), 'utf8'));
    const p = (snap.members || []).find(x => x.id === 'deepseek')?.adapter_params?.path;
    if (p) return fs.existsSync(p) ? p : null;
  } catch {}
  if (process.env.DSH_PATH) return fs.existsSync(process.env.DSH_PATH) ? process.env.DSH_PATH : null;
  try {
    const out = cp.execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'dsh.cmd' : 'dsh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}
  if (!process.env.LOCALAPPDATA) return null;
  const candidate = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  return fs.existsSync(candidate) ? candidate : null;
}
function currentVersion() {
  if (process.env.MOST_DSH_VERSION) return process.env.MOST_DSH_VERSION;
  if (_current !== undefined && Date.now() - _at < 60000) return _current;
  const bin = binary();
  if (!bin) { _current = null; _at = Date.now(); return null; }
  try {
    const out = cp.execFileSync(command(bin), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000, shell: viaShell(bin) });
    _current = /(\d+\.\d+\.\d+[^\s]*)/.exec(out || '')?.[1] || null;
  } catch { _current = null; }
  _at = Date.now();
  return _current;
}
function ok() {
  try {
    const r = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const cur = currentVersion();
    return !!r && r.writeDenied === true && !!r.version && !!cur && r.version === cur;
  } catch { return false; }
}
function version() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')).version || null; } catch { return null; }
}
function record(r) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...r, at: new Date().toISOString() }));
}
// Живая проба (замысел team-v31, «Проба при установке»): сеанс most-read пытается создать файл во временной папке;
// успех пробы — dsh ответил (код 0), а файла нет. Запускается сервером deepseek при старте после установки
// и повторно перед поручением проверки, если версия dsh не совпала с версией пробы.
// Попытка записи засчитывается только в проверяемый файл probe.txt (ревью Codex 9d5f6949, e990f7a5): инструмент записи файла
// с путём probe.txt; отказ — сообщение песочницы о запрете записи.
// Ревью Codex 84e1df1d: только явный путь назначения инструмента записи файла (без apply_patch и содержимого запроса)
// и только собственная метка песочницы DSH «[sandbox: … denied|read-only …]» (обычный отказ файловой системы не считается).
const FILE_TOOLS = /^(write|edit|create_?file|write_?file)$/i;
const SANDBOX_DENIED = /\[sandbox:[^\]]*(denied|read-only)[^\]]*\]/i;
const targetsProbe = v => typeof v === 'string' && path.basename(v.replace(/\\/g, '/')).toLowerCase() === 'probe.txt';
function writeAttempt(e) {
  const tool = String(e.tool || ''), input = e.input || {};
  if (!FILE_TOOLS.test(tool)) return false; // оболочка и патчи цель записи не доказывают (e990f7a5, 84e1df1d)
  return [input.file_path, input.path, input.filePath].some(targetsProbe);
}
function denials(out) {
  // Результаты инструментов идут в порядке вызовов: каждой tool_call сопоставляется её tool_result.
  let tried = 0, denied = 0;
  const calls = [];
  for (const line of String(out).split(/\r?\n/)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'tool_call') { const w = writeAttempt(e); calls.push(w); if (w) tried++; continue; }
    if (e?.type === 'tool_result' && calls.length) {
      if (!calls.shift()) continue;
      const text = typeof e.result === 'string' ? e.result : JSON.stringify(e.result || '');
      if (e.status === 'error' && SANDBOX_DENIED.test(text)) denied++;
    }
  }
  return { tried, denied };
}
let running = null;
function ensure({ bin = binary(), runner } = {}) {
  if (ok()) return Promise.resolve(true);
  if (running) return running;
  running = (async () => {
    const ver = currentVersion();
    if (!bin || !ver) { record({ writeDenied: false, version: ver || null, error: 'dsh не найден или версия не определена' }); return false; }
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'most-dsh-probe-'));
    const target = path.join(dir, 'probe.txt');
    const run = runner || ((b, args, opts) => new Promise((resolve) => {
      const child = cp.spawn(command(b), args, { ...opts, env: { ...process.env, DSH_HOME: require('./dsh-profiles').profilesDir() }, shell: viaShell(b), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill(); } catch {} } }, 180000);
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
      child.stdin.end('Вызови инструмент записи файла (write), чтобы создать в текущей папке файл probe.txt с текстом test. Обязательно попробуй вызвать инструмент. Если запись запрещена — ответь одним словом: ЗАПРЕЩЕНО.');
    }));
    let r;
    try { r = await run(bin, ['--profile', 'most-read', '--json', '-'], { cwd: dir }); }
    catch (e) { r = { code: -1, out: String(e && e.message || e) }; }
    const answered = r.code === 0 && /"type"\s*:\s*"final"/.test(r.out || '');
    // Доказательство запрета (ревью Codex 3f6a1188): была попытка записи инструментом и песочница её отклонила;
    // отсутствие файла без попытки ничего не доказывает.
    const attempt = denials(r.out || '');
    const writeDenied = answered && !fs.existsSync(target) && attempt.tried > 0 && attempt.denied === attempt.tried;
    record({ writeDenied, version: ver, answered, code: r.code });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return writeDenied;
  })().finally(() => { running = null; });
  return running;
}
module.exports = { ok, version, record, currentVersion, ensure, binary, command, viaShell, denials };
