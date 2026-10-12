'use strict';
/**
 * MOST collegium dashboard — read + intentional write bridge (intents).
 * Usage: npm start   (or node server.js)
 * Env: MOST_DASH_PORT=3847  MOST_DASH_HOST=127.0.0.1
 * JUDGE-write 2026-10-02: POST only for draft→confirm→enqueue intents bridge.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const data = require('./lib/data');
const intents = require('./lib/intents');

const HOST = process.env.MOST_DASH_HOST || '127.0.0.1';
const PORT = Number(process.env.MOST_DASH_PORT || 3847);
const PUBLIC = path.join(__dirname, 'public');
const POLL_MS = Number(process.env.MOST_DASH_POLL_MS || 1500);
const BODY_MAX = 64 * 1024;

/** Hour-3 L1: allowlist bind (loopback / all-ifaces / RFC1918). Default remains 127.0.0.1. */
function isLoopbackHost(h) {
  const x = String(h || '').toLowerCase();
  return x === '127.0.0.1' || x === 'localhost' || x === '::1';
}
function isAllInterfacesHost(h) {
  return h === '0.0.0.0' || h === '::';
}
function isRfc1918Ipv4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(h || ''));
  if (!m) return false;
  const a = m.slice(1).map(Number);
  if (a.some((n) => n > 255)) return false;
  if (a[0] === 10) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  return false;
}
function isAllowedBindHost(h) {
  if (isLoopbackHost(h) || isAllInterfacesHost(h) || isRfc1918Ipv4(h)) return true;
  return false;
}
function isLanBind(h) {
  return !isLoopbackHost(h);
}
function hostnameFromHeader(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : v;
  }
  const idx = v.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(v.slice(idx + 1))) return v.slice(0, idx);
  return v;
}
function isTrustedRequestHost(h) {
  const x = String(h || '').toLowerCase();
  if (!x) return false;
  if (isLoopbackHost(x) || isRfc1918Ipv4(x)) return true;
  return false;
}
function assertLanPostAllowed(req) {
  if (!isLanBind(HOST)) return;
  const hostHdr = hostnameFromHeader(req.headers.host);
  if (!isTrustedRequestHost(hostHdr)) {
    const err = new Error('LAN mode: refusing POST with untrusted Host: ' + (req.headers.host || ''));
    err.status = 403;
    throw err;
  }
  const origin = req.headers.origin;
  if (origin) {
    let oh = '';
    try {
      oh = hostnameFromHeader(new URL(origin).host);
    } catch (_) {
      const err = new Error('LAN mode: refusing POST with bad Origin');
      err.status = 403;
      throw err;
    }
    if (!isTrustedRequestHost(oh)) {
      const err = new Error('LAN mode: refusing POST with untrusted Origin: ' + origin);
      err.status = 403;
      throw err;
    }
  }
}

if (!isAllowedBindHost(HOST)) {
  console.error('Refusing to bind non-private / WAN host:', HOST);
  process.exit(1);
}
if (isLanBind(HOST)) {
  console.warn('========================================================');
  console.warn('[ВНИМАНИЕ] MOST Dashboard слушает интерфейс: ' + HOST + ':' + PORT);
  console.warn('АУТЕНТИФИКАЦИЯ ОТСУТСТВУЕТ (NO AUTH).');
  console.warn('Любое устройство в локальной сети имеет доступ к директивам!');
  console.warn('Категорически запрещено пробрасывать этот порт в WAN/Интернет.');
  console.warn('Opt-in only via MOST_DASH_HOST; default remains 127.0.0.1.');
  console.warn('========================================================');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const raw = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(raw);
}

function sendError(res, err) {
  const status = err.status || 500;
  sendJson(res, status, { error: err.message || String(err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApiGet(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    const h = data.health();
    h.bind = HOST;
    h.network = { host: HOST, lan: isLanBind(HOST) };
    return sendJson(res, 200, h);
  }
  if (p === '/api/ready') return sendJson(res, 200, data.getReady());
  if (p === '/api/quotas') return sendJson(res, 200, await data.getQuotas());
  if (p === '/api/board') {
    const limit = q.get('limit') || 7;
    return sendJson(res, 200, data.getBoard({ limit }));
  }
    if (p === '/api/tree') {
    try {
      return sendJson(res, 200, data.getTree({ limit: q.get('limit') || undefined }));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
  }
  if (p === '/api/projects') {
    try {
      return sendJson(res, 200, data.getProjects({ limit: q.get('limit') || undefined }));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
  }
  if (p.startsWith('/api/projects/')) {
    try {
      const parts = p.slice('/api/projects/'.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.length === 1) {
        return sendJson(res, 200, data.getProjectDetail(parts[0]));
      }
      if (parts.length === 3 && parts[1] === 'chats') {
        return sendJson(res, 200, data.getChatThread(parts[0], parts[2]));
      }
      return sendJson(res, 400, { error: 'ожидается /api/projects/:name или /api/projects/:name/chats/:id' });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
  }

  if (p === '/api/works') return sendJson(res, 200, { works: data.getWorks() });
  if (p.startsWith('/api/works/')) {
    const name = decodeURIComponent(p.slice('/api/works/'.length).split('/')[0]);
    return sendJson(res, 200, data.getWork(name));
  }
  if (p === '/api/jobs') {
    const source = (q.get('source') || 'live').toLowerCase();
    const common = {
      agent: q.get('agent') || undefined,
      status: q.get('status') || undefined,
      limit: q.get('limit') || undefined,
      includeArchive: q.get('archive') === '1',
    };
    if (source === 'host') {
      return sendJson(res, 200, data.getHostJobs(common));
    }
    if (source === 'all') {
      const live = data.getJobs(common);
      const host = data.getHostJobs(common);
      return sendJson(res, 200, {
        source: 'all',
        live,
        host,
        note: 'live = Desktop/team-store; host = isolated host-fallback queue (DISCUSSION-gap G5)',
      });
    }
    return sendJson(res, 200, data.getJobs(common));
  }
  if (p.startsWith('/api/jobs/')) {
    const parts = p.slice('/api/jobs/'.length).split('/').filter(Boolean);
    if (parts.length !== 2) {
      return sendJson(res, 400, { error: 'use /api/jobs/:agent/:id' });
    }
    return sendJson(res, 200, data.getJob(parts[0], decodeURIComponent(parts[1])));
  }
  if (p === '/api/feed') {
    return sendJson(res, 200, data.getFeed({
      notifyLimit: Number(q.get('notify') || 40),
      jobsLimit: Number(q.get('jobs') || 30),
    }));
  }
  if (p === '/api/consilium') {
    // DISCUSSION-hour4 C2: read-only consilium strip
    try {
      return sendJson(res, 200, data.listWorkConsilium(q.get('work') || 'collegium-hub', {
        limit: q.get('limit') || undefined,
      }));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
  }
  if (p === '/api/drafts') {
    return sendJson(res, 200, data.listAllDrafts({
      work: q.get('work') || undefined,
      limit: q.get('limit') || undefined,
      includeReplies: q.get('replies') === '1',
    }));
  }
  if (p.startsWith('/api/drafts/')) {
    const parts = p.slice('/api/drafts/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === '_replies' && parts.length === 2) {
      return sendJson(res, 200, data.getDraftPreview({ kind: 'grok-replies', name: parts[1] }));
    }
    if (parts.length !== 3) {
      return sendJson(res, 400, { error: 'use /api/drafts/:work/:kind/:name' });
    }
    return sendJson(res, 200, data.getDraftPreview({ work: parts[0], kind: parts[1], name: parts[2] }));
  }
  if (p === '/api/intents') {
    const listed = intents.listIntents({
      work: q.get('work') || undefined,
      status: q.get('status') || undefined,
      limit: q.get('limit') || undefined,
    });
    // DISCUSSION-hour1 H1: enrich in-memory; never mutate SoT
    listed.intents = (listed.intents || []).map((it) => {
      try {
        const full = intents.readIntent(it.work, it.id);
        return data.enrichIntentWithJob(full);
      } catch {
        return data.enrichIntentWithJob(it);
      }
    }).map((it) => ({
      id: it.id,
      work: it.work,
      who: it.who,
      status: it.status,
      task_preview: it.task_preview || String(it.task || '').slice(0, 140),
      createdAt: it.createdAt,
      confirmedAt: it.confirmedAt || null,
      enqueuedAt: it.enqueuedAt || null,
      jobId: it.jobId || null,
      channel: it.channel || null,
      dispatchStatus: it.dispatchStatus || null,
      needsToken: !!it.needsToken,
      jobStatus: it.jobStatus || null,
      jobSource: it.jobSource || null,
      jobUpdatedAt: it.jobUpdatedAt || null,
      derivedStatus: it.derivedStatus || null,
      resultAvailable: !!it.resultAvailable,
      result: it.result || null,
      path: it.path || null,
    }));
    return sendJson(res, 200, listed);
  }
  if (p.startsWith('/api/intents/')) {
    const parts = p.slice('/api/intents/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2) {
      return sendJson(res, 400, { error: 'use /api/intents/:work/:id' });
    }
    const rec = intents.readIntent(parts[0], parts[1]);
    // DISCUSSION-hour1 H1/H2: in-memory enrich only
    const enriched = typeof data.enrichIntentWithJob === 'function'
      ? data.enrichIntentWithJob(rec)
      : rec;
    return sendJson(res, 200, enriched);
  }
  if (p === '/api/events') return handleSse(req, res);

  sendJson(res, 404, { error: 'unknown api route' });
}

async function handleApiPost(req, res, url) {
  const p = url.pathname;
  const body = await readBody(req);

  // Usable-flight: create дело (local card + folder; remote deferred)
  if (p === '/api/projects') {
    try {
      const created = data.createProject({
        title: body.title || body.name || body.label,
        goal: body.goal || body.description || undefined,
      });
      broadcast('update', { at: new Date().toISOString(), reason: 'project-create', id: created.id });
      return sendJson(res, 201, { ok: true, project: created });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
  }

  // Intentional write bridge only (JUDGE-write W5). No mass writes.
  if (p === '/api/intents') {
    const rec = intents.createDraft({
      work: body.work,
      who: body.who,
      task: body.task || body.text || body.instruction,
    });
    broadcast('update', { at: new Date().toISOString(), reason: 'intent-draft', id: rec.id, work: rec.work });
    return sendJson(res, 201, { ok: true, intent: rec });
  }

  if (p.startsWith('/api/intents/')) {
    const parts = p.slice('/api/intents/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    // /api/intents/:work/:id/confirm  or  /api/intents/:work/:id/enqueue
    if (parts.length === 3 && parts[2] === 'confirm') {
      const rec = intents.confirmIntent(parts[0], parts[1]);
      broadcast('update', { at: new Date().toISOString(), reason: 'intent-confirm', id: rec.id, work: rec.work });
      return sendJson(res, 200, { ok: true, intent: rec });
    }
    if (parts.length === 3 && parts[2] === 'enqueue') {
      const out = await intents.enqueueIntent(parts[0], parts[1], {
        confirmId: body.confirmId || body.confirm_id || undefined,
        confirmToken: body.confirmToken || body.confirm_token || undefined,
      });
      broadcast('update', {
        at: new Date().toISOString(),
        reason: 'intent-enqueue',
        id: out.intent.id,
        work: out.intent.work,
        channel: out.intent.channel,
      });
      return sendJson(res, 200, { ok: true, ...out });
    }
    return sendJson(res, 404, { error: 'unknown intents POST; use /api/intents or .../confirm or .../enqueue' });
  }

  return sendJson(res, 404, { error: 'POST only allowed for /api/projects or /api/intents bridge' });
}

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
let lastFeedSig = '';
let pollTimer = null;

function feedSignature() {
  const { stateDir, repoRoot } = require('../../common/paths');
  const bits = [];
  for (const f of [
    path.join(stateDir, 'notify.log'),
    path.join(repoRoot, 'live', 'deployed.json'),
    ...['antigravity', 'codex', 'grok', 'team'].map((n) => path.join(stateDir, 'ready', n + '.json')),
  ]) {
    try {
      const st = fs.statSync(f);
      bits.push(f + ':' + st.mtimeMs + ':' + st.size);
    } catch {
      bits.push(f + ':0');
    }
  }
  for (const d of ['jobs', 'codex-jobs', 'grok-jobs']) {
    try {
      const st = fs.statSync(path.join(stateDir, d));
      bits.push(d + ':' + st.mtimeMs);
    } catch {
      bits.push(d + ':0');
    }
  }
  // Intent dirs under works/*/ _handoff/intents
  try {
    const worksRoot = path.join(repoRoot, 'works');
    for (const name of fs.readdirSync(worksRoot)) {
      const idir = path.join(worksRoot, name, '_handoff', 'intents');
      try {
        const st = fs.statSync(idir);
        bits.push('intents:' + name + ':' + st.mtimeMs);
      } catch { /* none */ }
    }
  } catch { /* ignore */ }
  return bits.join('|');
}

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

function startPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!sseClients.size) return;
    try {
      const sig = feedSignature();
      if (sig !== lastFeedSig) {
        lastFeedSig = sig;
        broadcast('update', { at: new Date().toISOString(), reason: 'fs-change' });
      } else {
        broadcast('ping', { at: new Date().toISOString() });
      }
    } catch (e) {
      broadcast('error', { message: e.message });
    }
  }, POLL_MS);
  const { stateDir, repoRoot } = require('../../common/paths');
  const watchTargets = [
    path.join(stateDir, 'notify.log'),
    path.join(stateDir, 'ready'),
    path.join(stateDir, 'jobs'),
    path.join(stateDir, 'codex-jobs'),
    path.join(stateDir, 'grok-jobs'),
    path.join(repoRoot, 'live'),
    path.join(repoRoot, 'works'),
  ];
  for (const target of watchTargets) {
    try {
      fs.watch(target, { recursive: true }, () => {
        lastFeedSig = '';
      });
    } catch {
      /* watch optional */
    }
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  startPoller();
  req.on('close', () => {
    sseClients.delete(res);
  });
}

function safePublicPath(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('..')) return null;
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) return null;
  return full;
}

function serveStatic(req, res, url) {
  const file = safePublicPath(url.pathname);
  if (!file) {
    res.writeHead(400);
    return res.end('bad path');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const method = req.method || 'GET';
    if (/\.key$/i.test(url.pathname) || /grok-webhook/i.test(url.pathname)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (method === 'GET' || method === 'HEAD') {
        return await handleApiGet(req, res, url);
      }
      if (method === 'POST') {
        assertLanPostAllowed(req);
        return await handleApiPost(req, res, url);
      }
      return sendJson(res, 405, { error: 'method not allowed; GET or POST /api/projects|/api/intents only' });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'static is GET only' });
    }
    return serveStatic(req, res, url);
  } catch (e) {
    sendError(res, e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MOST dashboard http://${HOST}:${PORT}`);
  console.log('API GET: /api/health /api/ready /api/quotas /api/board /api/tree /api/projects /api/works /api/jobs /api/feed /api/drafts /api/consilium /api/intents /api/events');
  console.log('API POST (write bridge): /api/intents  /api/intents/:work/:id/confirm  /api/intents/:work/:id/enqueue');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);