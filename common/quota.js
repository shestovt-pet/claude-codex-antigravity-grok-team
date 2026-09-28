'use strict';
const fs = require('fs'),
  path = require('path'),
  os = require('os');
const { spawn } = require('child_process');
function resetTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{10,13}$/.test(value)) value = Number(value);
  const n = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(n) && n <= 8640000000000000 && n > Date.now() ? new Date(n).toISOString() : null;
}

function classifyAgy(res) {
  const error = res.agyError ?? res.error;
  const message = [typeof error === 'object' ? JSON.stringify(error) : error, res.agyStatus || res.status, res.stderr]
    .filter(Boolean)
    .join(' ');
  const quota = /RESOURCE_EXHAUSTED|quota[ _-]*(?:exceeded|exhausted)|usage limit/i.test(message);
  const rate = /\b429\b|too many requests|rate.?limit/i.test(message);
  // Без признака исчерпания голый 429 — ограничение частоты, не квота аккаунта.
  const resetsAt = resetTime(
    error?.resetsAt ||
      error?.resets_at ||
      res.resetsAt ||
      message.match(/(?:resetsAt|resets_at)["\s:=]+([^"\s,}]+)/i)?.[1],
  );
  return { kind: quota ? 'quota' : rate ? 'transient' : 'error', message, resetsAt };
}

function classifyCodex(event) {
  if (!event || !['turn.failed', 'error'].includes(event.type)) return { kind: 'none' };
  const error = event.error || event;
  const message = typeof error === 'string' ? error : JSON.stringify(error);
  const quota = /hit your usage limit|UsageLimitExceeded/i.test(message);
  const attempt = message.match(/Try again at ([^"\n]+?)(?:[.]?\s*(?:\\n|$|"))/i)?.[1];
  return {
    kind: quota ? 'quota' : 'error',
    message,
    resetsAt: resetTime(error.resetsAt || error.resets_at || attempt),
  };
}

function retryPlan(job, failure) {
  const quota = failure.kind === 'quota',
    count = quota ? job.quotaAttempts || 0 : job.transientAttempts || 0;
  const base = {
    retryKind: failure.kind,
    knownReset: !!resetTime(failure.resetsAt),
    error: failure.message,
    ...(quota ? { lastQuotaAt: new Date().toISOString() } : {}),
  };
  if (job.write) return { ...base, status: 'needs_decision', finishedAt: new Date().toISOString() };
  if (!(quota && base.knownReset) && count >= (quota ? 12 : 3))
    return {
      ...base,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      problems: [quota ? 'исчерпаны 12 попыток восстановления' : 'исчерпаны 3 повтора временной ошибки'],
      error: quota ? 'исчерпаны 12 попыток восстановления' : 'исчерпаны 3 повтора временной ошибки',
    };
  const delay = Number(process.env[quota ? 'MOST_QUOTA_RETRY_MS' : 'MOST_RATE_RETRY_MS'] || (quota ? 1800000 : 90000));
  return {
    ...base,
    status: quota ? 'waiting_quota' : 'queued',
    nextAttemptAt: resetTime(failure.resetsAt) || new Date(Date.now() + delay).toISOString(),
  };
}

function windows(snapshot) {
  const result = { five_hour: null, weekly: null, all: [], planType: snapshot?.planType };
  for (const w of [snapshot?.primary, snapshot?.secondary]) {
    if (!w) continue;
    const minutes = w.windowDurationMins ?? w.window_minutes;
    const key = minutes >= 295 && minutes <= 305 ? 'five_hour' : minutes === 10080 ? 'weekly' : null;
    result.all.push({ used_percent: w.usedPercent ?? w.used_percent, resets_at: resetTime(w.resetsAt ?? w.resets_at), minutes, limitId: snapshot.limitId || 'codex' });
    if (key)
      result[key] = {
        used_percent: w.usedPercent ?? w.used_percent,
        resets_at: resetTime(w.resetsAt ?? w.resets_at),
        minutes,
      };
  }
  return result;
}
function limitsSnapshot(response) {
  const limits = new Map(Object.entries(response.rateLimitsByLimitId || {}));
  if (response.rateLimits) limits.set(response.rateLimits.limitId || 'codex', response.rateLimits);
  if (!limits.size) throw Error('Источник не предоставил квоты.');
  const result = { five_hour: null, weekly: null, all: [], plans: [] };
  for (const [id, limit] of limits) {
    const w = windows({ ...limit, limitId: id });
    result.five_hour ||= w.five_hour; result.weekly ||= w.weekly;
    result.all.push(...w.all); result.plans.push({ id, planType: limit.planType || 'неизвестен', five_hour: !!w.five_hour });
  }
  return result;
}

function command(binary, args) {
  return /\.js$/i.test(binary) ? { bin: process.execPath, args: [binary, ...args] } : { bin: binary, args };
}

function appServer(binary, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const c = command(binary, ['app-server']),
      child = spawn(c.bin, c.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '',
      done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Источник квоты не ответил за 15 секунд.')), timeout);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error('Источник квоты закрыл соединение.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            if (msg.error) return finish(new Error('Ошибка инициализации источника квоты.'));
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
          }
          if (msg.id === 2) {
            if (msg.error) return finish(new Error('Источник квоты сообщил об ошибке: ' + JSON.stringify(msg.error)));
            try { finish(null, { ...limitsSnapshot(msg.result || {}), source: 'сервер приложения', taken_at: new Date().toISOString() }); }
            catch (e) { finish(e); }
          }
        } catch {}
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'most', version: '0.3.0' }, capabilities: {} },
    });
  });
}

function rollout(threadId, root = process.env.MOST_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions')) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && (!threadId || e.name.includes(threadId))) files.push(p);
    }
  }
  walk(root);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  let newest = null;
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      try {
        const e = JSON.parse(line);
        if (e.payload?.type === 'token_count' && e.payload.rate_limits) {
          const snap = { ...windows(e.payload.rate_limits), source: 'журнал сеанса', taken_at: e.timestamp };
          if (!newest || Date.parse(snap.taken_at) > Date.parse(newest.taken_at)) newest = snap;
        }
      } catch {}
    }
  }
  return newest;
}

async function codexQuota(binary, threadId, timeout) {
  try {
    return await appServer(binary, timeout);
  } catch (e) {
    return (
      rollout(threadId) || {
        five_hour: null,
        weekly: null,
        source: 'данные не предоставлены',
        taken_at: null,
        error: e.message,
      }
    );
  }
}

function quotaText(q) {
  if (q.all?.length) {
    const rows = q.all.map(w => (q.plans?.length > 1 ? w.limitId + ' ' : '') + (w.minutes >= 295 && w.minutes <= 305 ? '5 ч' : w.minutes === 10080 ? 'неделя' : w.minutes + ' мин') + ': использовано ' + w.used_percent + ' %, сброс ' + (w.resets_at ? new Date(w.resets_at).toLocaleString('ru-RU') : 'данные не предоставлены'));
    for (const p of q.plans || [{ planType: q.planType || 'неизвестен', five_hour: !!q.five_hour }])
      if (!p.five_hour) rows.unshift((q.plans?.length > 1 ? p.id + ' ' : '') + '5 ч: источник не возвращает это окно (тариф ' + p.planType + ', secondary отсутствует)');
    return rows.join(', ') + ' · источник ' + q.source;
  }
  return (
    [
      ['five_hour', '5 ч'],
      ['weekly', 'Неделя'],
    ]
      .map(
        ([k, label]) =>
          label +
          ': ' +
          (q[k]
            ? q[k].used_percent + ' % использовано; сброс ' + (q[k].resets_at || 'данные не предоставлены')
            : 'данные не предоставлены'),
      )
      .join('\n') +
    '\nИсточник: ' +
    q.source +
    '; снимок: ' +
    (q.taken_at || 'данные не предоставлены')
  );
}
module.exports = {
  resetTime,
  classifyAgy,
  classifyCodex,
  retryPlan,
  windows,
  limitsSnapshot,
  appServer,
  rollout,
  codexQuota,
  quotaText,
  command,
};
