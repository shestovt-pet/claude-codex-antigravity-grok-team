'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
let cached, inflight;
const closed = 'приложение Antigravity закрыто — остаток не виден';
function accountEmail() {
  try {
    const dir = process.env.MOST_AGY_LOG_DIR || path.join(os.homedir(), '.gemini/antigravity-cli/log');
    const files = fs.readdirSync(dir).filter(n => /^cli-.*\.log$/.test(n)).map(n => path.join(dir, n)).sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return [...fs.readFileSync(files[0], 'utf8').matchAll(/applyAuthResult: email=([^\s,]+)/g)].at(-1)?.[1];
  } catch { return null; }
}
function modelQuota(q) {
  if (!q || typeof q.resetTime !== 'string' || !Number.isFinite(Date.parse(q.resetTime))) return null;
  // Соглашение protobuf/JSON: ноль может не передаваться. Наблюдение 27.09.2026:
  // при исчерпании remainingFraction отсутствовал; это не гарантия Antigravity.
  const remainingFraction = Object.hasOwn(q, 'remainingFraction') ? q.remainingFraction : 0;
  if (!Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) return null;
  return { remainingFraction, resetTime: q.resetTime };
}
function parseQuota(data, email = accountEmail()) {
  const status = data?.userStatus, config = status?.cascadeModelConfigData, models = config?.clientModelConfigs;
  if (!Array.isArray(models) || !models.length) return 'формат ответа изменился';
  const groups = new Map(), invalid = [], defaultModel = config.defaultOverrideModelConfig?.modelOrAlias?.model;
  for (const m of models) {
    const q = modelQuota(m?.quotaInfo);
    if (!q || typeof m?.label !== 'string') { invalid.push((m?.label || 'неизвестная модель') + ': формат ответа изменился'); continue; }
    const key = q.remainingFraction + '|' + q.resetTime;
    if (!groups.has(key)) groups.set(key, { q, models: [] });
    groups.get(key).models.push({ label: m.label, explicit: /Gemini 3\.1 Pro.*High|Gemini 3\.8 Flash.*Medium/i.test(m.label) || (defaultModel && m.modelOrAlias?.model === defaultModel) });
  }
  return [...invalid, ...[...groups.values()].map(({q, models}) => {
    const named = models.filter(m => m.explicit);
    for (const m of models) { if (named.length >= 2) break; if (!named.includes(m)) named.push(m); }
    const reset = new Date(q.resetTime), today = reset.toDateString() === new Date().toDateString();
    return models.map(m => m.label + ' [семья ' + (require('./model-family').family(m.label) || 'не определена') + ']' + (require('./model-family').family(m.label) === 'anthropic' ? ' (та же семья, что ведущий — не проверяет работу Claude; расходует квоту Antigravity, а не лимит Claude пользователя)' : '')).join(', ') + (q.remainingFraction === 0 ? ': исчерпано (осталось 0 %)' : ': осталось ' + Math.round(q.remainingFraction * 100) + ' %') + ', сброс ' + (today ? '' : reset.toLocaleDateString('ru-RU') + ' ') + reset.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  })].join('; ') + ' · ' + (!email || !status.email ? 'аккаунт agy не удалось сверить' : email.toLowerCase() === status.email.toLowerCase() ? 'аккаунт agy совпадает' : 'аккаунт agy не совпадает');
}
function ps(code, deadline) {
  return new Promise((resolve, reject) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', code], {
    windowsHide: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 2e6, encoding: 'utf8',
  }, (e, out) => e ? reject(Error('нет доступа к процессам')) : resolve(out)));
}
function post(protocol, port, token, deadline) {
  return new Promise(resolve => {
    const req = require(protocol).request({ hostname: '127.0.0.1', port, path: '/exa.language_server_pb.LanguageServerService/GetUserStatus', method: 'POST',
      ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': token },
    }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
      res.on('end', () => { clearTimeout(timer); try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve({}); } });
      res.on('error', () => { clearTimeout(timer); resolve(null); });
    });
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, Math.max(1, Math.min(1200, deadline - Date.now())));
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    req.end(JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'ru' } }));
  });
}
const snapshot = data => { const email = accountEmail(); return { text: parseQuota(data, email) + ' · снимок ' + new Date().toISOString(), data, accountEmail: email, taken_at: new Date().toISOString() }; };
async function collectSnapshot() {
  if (process.env.MOST_AGY_QUOTA_FILE) {
    try { const data = JSON.parse(fs.readFileSync(process.env.MOST_AGY_QUOTA_FILE, 'utf8')); return data.closed ? closed : snapshot(data); }
    catch { return 'формат ответа изменился'; }
  }
  if (process.platform !== 'win32') return closed;
  const deadline = Date.now() + 7800;
  try {
    let procs = JSON.parse((await ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*.exe' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress", deadline)).trim() || '[]');
    procs = Array.isArray(procs) ? procs : [procs];
    if (!procs.length) return closed;
    for (const p of procs) {
      const token = p.CommandLine?.match(/--csrf_token[= ](?:"([^"\s]+)"|([^\s]+))/)?.slice(1).find(Boolean);
      if (!token || !Number.isInteger(p.ProcessId) || Date.now() >= deadline) continue;
      const ports = (await ps(`(Get-NetTCPConnection -OwningProcess ${p.ProcessId} -State Listen -ErrorAction SilentlyContinue).LocalPort -join ','`, deadline)).trim().split(',').map(Number).filter(n => n > 0 && n <= 65535);
      for (const port of new Set(ports)) for (const protocol of ['http', 'https']) {
        if (Date.now() >= deadline) break;
        const data = await post(protocol, port, token, deadline);
        if (data) return snapshot(data);
      }
    }
    return 'языковой сервер не ответил (нет доступного ответа)';
  } catch { return 'языковой сервер не ответил (нет доступа или истекло время ожидания)'; }
}
async function agySnapshot({ fresh = false } = {}) {
  const key = process.env.MOST_AGY_QUOTA_FILE || '';
  if (!fresh && cached?.key === key && Date.now() - cached.at < 60000) return cached.value;
  if (!inflight) inflight = collectSnapshot().then(result => {
    const value = typeof result === 'string' ? { text: result } : result;
    cached = { key, at: Date.now(), value }; return value;
  }).finally(() => { inflight = null; });
  return inflight;
}
async function agyQuota() { return (await agySnapshot()).text; }
async function collect() { const result = await collectSnapshot(); return typeof result === 'string' ? result : result.text; }
module.exports = { agyQuota, agySnapshot, parseQuota, collect, modelQuota };
