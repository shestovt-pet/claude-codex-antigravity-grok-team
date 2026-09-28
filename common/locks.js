'use strict';
// Извлечено из моста 0.2.0: владение каналом ОС, а не проверка одного PID.
const fs = require('fs'),
  net = require('net'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto');
const { stateDir: STATE_DIR } = require('./paths');
const isWindows = process.platform === 'win32',
  isLinux = process.platform === 'linux';
const INSTANCE = crypto.randomUUID(),
  STARTED_AT = new Date().toISOString(),
  PROBE_TIMEOUT_MS = 2000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex'),
  nowIso = () => new Date().toISOString(),
  errText = (e) => String(e.message || e),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pipeName(kind, key, state = STATE_DIR) {
  // Одна папка не должна получить два замка из-за разных --state-dir.
  const scope = kind === 'team_repo' ? 'team_repo' : state;
  const h = sha(scope + '|' + kind + '|' + key).slice(0, 32);
  if (isWindows) return '\\\\.\\pipe\\most-' + h;
  if (isLinux) return '\0most-' + h;
  return path.join(os.tmpdir(), 'most-' + h + '.sock');
}

function lockInfoPath(kind, key, state = STATE_DIR) {
  return path.join(state, 'locks', kind + '-' + sha(state + '|' + kind + '|' + key).slice(0, 20) + '.json');
}

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
  fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
  const name = pipeName(kind, key, state);
  const owner = Object.assign({ kind, instance: INSTANCE, pid: process.pid, since: nowIso() }, info || {});
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await listenPipe(name, () => owner);
    if (r.ok) {
      try {
        fs.writeFileSync(lockInfoPath(kind, key, state), JSON.stringify(owner));
      } catch (e) {}
      return {
        ok: true,
        owner,
        release: () =>
          new Promise((res) => {
            try {
              r.srv.close(() => res());
            } catch (e) {
              res();
            }
            try {
              const p = lockInfoPath(kind, key, state);
              const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
              if (cur.instance === INSTANCE && cur.since === owner.since)
                if (!process.env.MOST_TEST_KEEP) fs.unlinkSync(p);
            } catch (e) {}
          }),
      };
    }
    if (r.code !== 'EADDRINUSE') return { ok: false, error: r.error };
    const p = await probe(name);
    if (p.state === 'alive') return { ok: false, busy: true, owner: p.info || {}, state: 'alive' };
    if (p.state === 'hung') {
      let last = null;
      try {
        last = JSON.parse(fs.readFileSync(lockInfoPath(kind, key, state), 'utf8'));
      } catch (e) {}
      return { ok: false, busy: true, owner: last || {}, state: 'hung' };
    }
    // канала уже нет (гонка) или остался файл сокета (не Windows/Linux) — пробуем ещё раз
    if (!isWindows && !isLinux) {
      try {
        fs.unlinkSync(name);
      } catch (e) {}
    }
  }
  return { ok: false, error: 'не удалось захватить замок' };
}

async function waitLock(kind, key, info, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const l = await tryLock(kind, key, info);
    if (l.ok || !l.busy || Date.now() > until) return l;
    await sleep(60);
  }
}

async function ownerState(owner) {
  if (!owner || !owner.instance) return 'unknown';
  if (owner.instance === INSTANCE) return 'self';
  const p = await probe(pipeName('instance', owner.instance));
  if (p.state === 'alive') {
    if (!p.info || p.info.instance !== owner.instance) return 'unknown';
    if (owner.pid && !p.info.pid) return 'unknown';
    if (owner.pid && p.info.pid !== owner.pid) return 'dead';
    if (owner.startedAt && p.info.startedAt && owner.startedAt !== p.info.startedAt) return 'dead';
    return 'alive';
  }
  if (p.state === 'none') return 'dead';
  return 'unknown';
}

async function startOwner(info = {}) {
  return listenPipe(pipeName('instance', INSTANCE), () => ({
    ...info,
    instance: INSTANCE,
    pid: process.pid,
    startedAt: STARTED_AT,
  }));
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
  probe,
  listenPipe,
  tryLock,
  waitLock,
};
