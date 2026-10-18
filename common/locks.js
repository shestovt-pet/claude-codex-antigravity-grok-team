'use strict';
// Извлечено из моста 0.2.0: владение каналом ОС, а не проверка одного PID.
const fs = require('fs'),
  net = require('net'),
  path = require('path'),
  crypto = require('crypto');
const { stateDir: STATE_DIR } = require('./paths');
const { lockNames, channel } = require('./path-compat');
const isWindows = process.platform === 'win32',
  isLinux = process.platform === 'linux';
const INSTANCE = crypto.randomUUID(),
  STARTED_AT = new Date().toISOString(),
  PROBE_TIMEOUT_MS = 2000;
const nowIso = () => new Date().toISOString(),
  errText = (e) => String(e.message || e),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Прежняя формула доступна для совместимых клиентов; захват всегда через lockNames.
function pipeName(kind, key, state = STATE_DIR) { return channel(kind, key, state); }

// Спросить владельца канала, кто он. alive — ответил; hung — канал есть, но ответа нет; none — канала нет.
function probe(name) {
  return new Promise((resolve) => {
    let done = false,
      buf = '';
    const end = (r) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (e) {}
      resolve(r);
    };
    const sock = net.connect(name);
    const t = setTimeout(() => end({ state: 'hung' }), PROBE_TIMEOUT_MS);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
    });
    sock.on('end', () => {
      clearTimeout(t);
      let info = null;
      try {
        info = JSON.parse(buf);
      } catch (e) {}
      end({ state: 'alive', info });
    });
    sock.on('error', (e) => {
      clearTimeout(t);
      end({ state: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'none' : 'hung', code: e.code });
    });
  });
}

function listenPipe(name, infoFn) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      // Клиент пробы может закрыть канал до ответа; EPIPE приходит событием, вне try/catch.
      sock.on('error', () => sock.destroy());
      try {
        sock.end(JSON.stringify(infoFn()));
      } catch (e) {
        try {
          sock.destroy();
        } catch (e2) {}
      }
    });
    srv.on('error', (e) => resolve({ ok: false, code: e.code, error: errText(e) }));
    srv.listen(name, () => {
      srv.removeAllListeners('error');
      srv.on('error', () => {});
      srv.unref();
      resolve({ ok: true, srv });
    });
  });
}
// Захват замка. Занят — { ok:false, busy:true, owner, state: alive|hung }.
async function tryLock(kind, key, info, state = STATE_DIR) {
  const names = lockNames(kind, key, state), held = [];
  const owner = Object.assign({ kind, instance: INSTANCE, pid: process.pid, since: nowIso() }, info || {});
  const release = async () => {
    for (const { entry, srv } of held.splice(0).reverse()) {
      await new Promise(res => { try { srv.close(res); } catch { res(); } });
      try {
        const cur = JSON.parse(fs.readFileSync(entry.infoPath, 'utf8'));
        if (cur.instance === INSTANCE && cur.since === owner.since && !process.env.MOST_TEST_KEEP) fs.unlinkSync(entry.infoPath);
      } catch {}
    }
  };
  for (const entry of names) {
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await listenPipe(entry.name, () => owner);
      if (r.ok) break;
      if (r.code !== 'EADDRINUSE') { await release(); return { ok: false, error: r.error }; }
      const p = await probe(entry.name);
      if (p.state !== 'none') {
        let last;
        try { last = JSON.parse(fs.readFileSync(entry.infoPath, 'utf8')); } catch {}
        await release();
        return { ok: false, busy: true, owner: p.info || last || {}, state: p.state };
      }
      if (!isWindows && !isLinux) { try { fs.unlinkSync(entry.name); } catch {} }
    }
    if (!r.ok) { await release(); return { ok: false, busy: true, error: 'не удалось захватить замок' }; }
    held.push({ entry, srv: r.srv });
    try {
      fs.mkdirSync(path.dirname(entry.infoPath), { recursive: true });
      fs.writeFileSync(entry.infoPath, JSON.stringify(owner));
    } catch (e) { await release(); return { ok: false, error: errText(e) }; }
  }
  return { ok: true, owner, names: names.map(n => n.name), release };
}

async function waitLock(kind, key, info, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const l = await tryLock(kind, key, info);
    if (l.ok || !l.busy || Date.now() > until) return l;
    await sleep(60);
  }
}

function ownerReply(owner, p) {
  if (p.state === 'none') return 'dead';
  if (p.state !== 'alive' || !p.info || p.info.instance !== owner.instance ||
      (owner.pid && !p.info.pid) || (owner.startedAt && !p.info.startedAt)) return 'unknown';
  if ((owner.pid && p.info.pid !== owner.pid) || (owner.startedAt && owner.startedAt !== p.info.startedAt)) return 'dead';
  return 'alive';
}
async function probeOwner(owner, state = STATE_DIR) {
  const replies = await Promise.all(lockNames('instance', owner.instance, state).map(n => probe(n.name)));
  const live = replies.find(p => ownerReply(owner, p) === 'alive');
  return live || { state: replies.some(p => ownerReply(owner, p) === 'unknown') ? 'hung' : 'none' };
}
async function ownerState(owner, state = STATE_DIR) {
  if (!owner || !owner.instance) return 'unknown';
  if (owner.instance === INSTANCE) return 'self';
  const p = await probeOwner(owner, state);
  return p.state === 'alive' ? 'alive' : p.state === 'none' ? 'dead' : 'unknown';
}
async function startOwner(info = {}, state = STATE_DIR) {
  const held = [];
  const close = cb => {
    Promise.all(held.splice(0).map(srv => new Promise(res => { try { srv.close(res); } catch { res(); } }))).then(() => cb?.());
  };
  for (const entry of lockNames('instance', INSTANCE, state)) {
    const r = await listenPipe(entry.name, () => ({ ...(typeof info === 'function' ? info() : info), instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT }));
    if (!r.ok) { await new Promise(close); return r; }
    held.push(r.srv);
  }
  return { ok: true, srv: { close }, release: () => new Promise(close) };
}

function owner() {
  return { instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT };
}
module.exports = {
  INSTANCE,
  STARTED_AT,
  owner,
  startOwner,
  ownerState,
  pipeName,
  lockNames,
  probeOwner,
  ownerReply,
  probe,
  listenPipe,
  tryLock,
  waitLock,
};
