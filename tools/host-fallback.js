'use strict';
// Host fallback increments 1-4 (draft). Does not touch C:\most\live. Does not run deploy.js.
// incr1: enter/leave/status/list + isolated MCP raise
// incr2: independent confirm channel + jobs list/stop via host
// incr3: Grok structured proposals -> actions (no shell, no who=claude)
// incr4: draft access client!==authority (peer not gate judge)
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const confirm = require('../common/user-confirm');
const proposed = require('../common/proposed-actions');
const accessDraft = require('../common/access');
const fallbackDetect = require('../common/fallback-detect');
const taskRoles = require('../common/task-roles');

const SERVERS = ['team', 'codex', 'antigravity', 'grok'];
const INCREMENT = 4;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

function nodeCommand() {
  const p = 'C:\\Program Files\\nodejs\\node.exe';
  return process.platform === 'win32' && fs.existsSync(p) ? p : process.execPath;
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const pth = path.resolve(parent);
  const rel = path.relative(pth, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafeFallbackDir(fallbackDir, workRoot, repo) {
  const abs = path.resolve(fallbackDir);
  const forbidden = [
    path.join(repo, 'live'),
    path.join(repo, 'state'),
    path.join(repo, 'rules'),
  ];
  for (const f of forbidden) {
    if (isInside(abs, f) || abs.toLowerCase() === path.resolve(f).toLowerCase()) {
      throw new Error('fallbackDir forbidden (live/shared state/rules): ' + abs);
    }
  }
  const allowedRoots = [
    path.join(workRoot, 'state'),
    path.join(workRoot, 'state-smoke'),
    path.join(workRoot, 'state-probe-test'),
    path.join(repo, '.work', '_grok_fallback_conductor', 'state'),
    path.join(repo, '.work', '_grok_fallback_conductor', 'state-smoke'),
    path.join('C:\\test-most', 'fallback-conductor', 'state'),
    path.join('C:\\test-most', 'fallback-conductor', 'state-smoke'),
  ];
  const ok = allowedRoots.some((r) => isInside(abs, r) || abs.toLowerCase() === path.resolve(r).toLowerCase());
  if (!ok) {
    throw new Error('fallbackDir not under allowed draft roots: ' + abs);
  }
  return abs;
}

function defaults(opts = {}) {
  const repo = path.resolve(opts.repo || process.env.MOST_REPO_ROOT || 'C:\\most');
  const workRoot = path.join(repo, '.work', '_grok_fallback_conductor');
  const raw = opts.fallbackDir || process.env.MOST_FALLBACK_DIR || path.join(workRoot, 'state');
  if (opts.sharedState) {
    throw new Error('shared state disabled in draft increments 1-4 (isolated state only)');
  }
  const fallbackDir = assertSafeFallbackDir(raw, workRoot, repo);
  process.env.MOST_FALLBACK_DIR = fallbackDir;
  return { repo, workRoot, fallbackDir, stateDir: fallbackDir, shared: false };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; }
}

function processImage(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000,
      }).trim();
      if (!out || /^INFO:/i.test(out)) return null;
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1].toLowerCase() : out.slice(0, 40);
    }
    return 'node';
  } catch { return null; }
}

function ownedByHost(marker, session) {
  if (!marker || !Number.isInteger(marker.pid)) return false;
  if (alive(marker.pid) !== true) return false;
  const img = processImage(marker.pid);
  if (!img) return false;
  if (process.platform === 'win32' && !/node/.test(img)) return false;
  const sess = session || null;
  if (sess && sess.token) {
    if (!marker.token || marker.token !== sess.token) return false;
    if (Number.isInteger(sess.generation) && marker.generation !== sess.generation) return false;
  }
  if (marker.generation && marker.expectedGeneration && marker.generation !== marker.expectedGeneration) return false;
  if (marker.token && marker.expectedToken && marker.token !== marker.expectedToken) return false;
  return true;
}

function readyAges(stateDir) {
  const dir = path.join(stateDir, 'ready');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => {
    const j = readJson(path.join(dir, n));
    const started = Date.parse(j && j.startedAt);
    return {
      name: n.replace(/\.json$/, ''),
      startedAt: j && j.startedAt,
      ageMin: Number.isFinite(started) ? Math.round((Date.now() - started) / 60000) : null,
      pid: j && j.pid,
      release: j && j.release,
      alive: alive(j && j.pid),
    };
  });
}

function hostReady(fallbackDir) {
  const dir = path.join(fallbackDir, 'host-ready');
  if (!fs.existsSync(dir)) return [];
  const session = readJson(path.join(fallbackDir, 'session.json'));
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => {
    const j = readJson(path.join(dir, n));
    const marker = {
      name: n.replace(/\.json$/, ''),
      startedAt: j && j.startedAt,
      pid: j && j.pid,
      client: j && j.client,
      serverPath: j && j.serverPath,
      generation: j && j.generation,
      token: j && j.token,
    };
    marker.alive = alive(marker.pid);
    marker.owned = ownedByHost(marker, session);
    return marker;
  });
}

async function withLock(fallbackDir, fn) {
  const lockPath = path.join(fallbackDir, 'host.lock');
  fs.mkdirSync(fallbackDir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      const stale = readJson(lockPath);
      if (stale && alive(stale.pid) === false) {
        try { fs.unlinkSync(lockPath); } catch {}
        fd = fs.openSync(lockPath, 'wx');
      } else {
        throw new Error('host locked by another enter/leave/jobs session (host.lock)');
      }
    } else throw e;
  }
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function currentGeneration(fallbackDir) {
  const session = readJson(path.join(fallbackDir, 'session.json')) || {};
  return Number.isInteger(session.generation) ? session.generation : 0;
}

function status(opts = {}) {
  const d = defaults(opts);
  const session = readJson(path.join(d.fallbackDir, 'session.json'));
  const supervisor = readJson(path.join(d.fallbackDir, 'supervisor.json'));
  return {
    increment: INCREMENT,
    repo: d.repo,
    stateDir: d.stateDir,
    fallbackDir: d.fallbackDir,
    sharedState: false,
    session,
    supervisor: supervisor && { ...supervisor, alive: alive(supervisor.pid), owned: ownedByHost(supervisor) },
    hostReady: hostReady(d.fallbackDir),
    desktopReady: readyAges(path.join(d.repo, 'state')),
    accessDraft: accessDraft.describe(),
    pendingConfirms: confirm.listPending(d.fallbackDir).length,
    pendingActions: proposed.listProposals(d.fallbackDir).filter((p) => p.status === 'pending').length,
    allowedToolsNote: 'host: status/list/confirm/jobs/actions; long-running servers MOST_CLIENT=codex (guest)',
    note: 'Draft incr1-4. Isolated state. Shared disabled. Live not touched.',
  };
}

function list(opts = {}) {
  const d = defaults(opts);
  const cache = readJson(path.join(d.fallbackDir, 'tools-cache.json'));
  const st = status(opts);
  return {
    increment: INCREMENT,
    mode: 'status/list + confirm + jobs + actions',
    hostCommands: [
      'status', 'list', 'enter', 'leave',
      'confirm-request', 'confirm-reveal', 'confirm-status',
      'jobs', 'jobs-list', 'jobs-stop', 'jobs-enqueue',
      'actions-ingest', 'actions-list', 'actions-apply',
      'access-describe',
    ],
    forbiddenNow: ['team_change', 'deploy', 'touch C:\\most\\live', 'shared state', 'forge who=claude', 'peer as gate judge'],
    toolsCache: cache,
    serversAlive: (st.hostReady || []).filter((x) => x.owned).map((x) => x.name),
    accessDraft: st.accessDraft,
  };
}

function serverEnv(d, client) {
  return {
    ...process.env,
    MOST_REPO_ROOT: d.repo,
    MOST_STATE_DIR: d.stateDir,
    MOST_CLIENT: client,
    MOST_CLAUDE_CONFIGS: '[]',
    MOST_CODEX_JOBS_DIR: path.join(d.stateDir, 'codex-jobs'),
    MOST_INPUT_DIR: path.join(d.stateDir, 'input'),
    MOST_JOURNAL: path.join(d.stateDir, 'antigravity.log'),
    MOST_CODEX_ARCHIVE_DIR: path.join(d.stateDir, 'archive'),
    TEMP: d.stateDir,
    TMP: d.stateDir,
  };
}

async function probeAll(d) {
  const probe = require(path.join(d.repo, 'common', 'probe.js')).probe;
  const out = { guest: {}, canStart: {} };
  for (const n of SERVERS) {
    const file = path.join(d.repo, 'servers', n, 'index.js');
    if (!fs.existsSync(file)) throw new Error('server missing: ' + file);
    const probeDir = path.join(d.fallbackDir, '.probe-' + randomUUID());
    fs.mkdirSync(probeDir, { recursive: true });
    try {
      const startEnv = {
        ...serverEnv({ ...d, stateDir: probeDir }, 'claude'),
        MOST_PROBE_ONLY: '1',
        MOST_TEST_KEEP: '1',
      };
      await probe(file, startEnv, 20000);
      out.canStart[n] = true;
      const guestClient = n === 'codex' ? 'antigravity' : 'codex';
      const guestEnv = serverEnv({ ...d, stateDir: probeDir }, guestClient);
      const result = await probe(file, guestEnv, 20000);
      out.guest[n] = { client: guestClient, tools: ((result && result.tools) || []).map((t) => t.name) };
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
    }
  }
  return out;
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, ok: false, reason: 'bad pid' };
  if (alive(pid) === false) return { pid, ok: true, alreadyDead: true };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, encoding: 'utf8', timeout: 15000,
      });
      const dead = alive(pid) === false;
      return { pid, ok: dead, status: r.status, stderr: (r.stderr || '').slice(0, 200) };
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && alive(pid) === true) { /* wait */ }
    if (alive(pid) === true) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return { pid, ok: alive(pid) === false };
  } catch (e) {
    return { pid, ok: alive(pid) === false, error: e.message };
  }
}

function stopSupervisor(fallbackDir, { forceWipe = false } = {}) {
  const session = readJson(path.join(fallbackDir, 'session.json'));
  const sup = readJson(path.join(fallbackDir, 'supervisor.json'));
  const markers = hostReady(fallbackDir);
  const targets = [];
  if (sup && Number.isInteger(sup.pid) && ownedByHost(sup, session)) targets.push({ kind: 'supervisor', pid: sup.pid, token: sup.token });
  for (const m of markers) {
    if (m.owned || ownedByHost(m, session)) targets.push({ kind: 'server', name: m.name, pid: m.pid, token: m.token });
  }
  // Children only if also owned host-ready marker (never stamp session token onto bare PID).
  if (sup && Array.isArray(sup.children) && ownedByHost(sup, session)) {
    for (const c of sup.children) {
      const marker = markers.find((m) => m.pid === c.pid);
      if (marker && (marker.owned || ownedByHost(marker, session)) && !targets.some((x) => x.pid === c.pid)) {
        targets.push({ kind: 'child', name: c.name || marker.name, pid: c.pid, token: marker.token });
      }
    }
  }
  const results = targets.map((t) => ({ ...t, ...killPid(t.pid) }));
  const allDead = results.every((r) => r.ok) && hostReady(fallbackDir).every((m) => !(m.owned || ownedByHost(m, session)));
  if (allDead || forceWipe) {
    try { fs.rmSync(path.join(fallbackDir, 'host-ready'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(fallbackDir, 'supervisor.json'), { force: true }); } catch {}
  } else {
    writeJson(path.join(fallbackDir, 'stop-failed.json'), {
      at: new Date().toISOString(),
      results,
      note: 'markers preserved for retry',
    });
  }
  return { results, allDead };
}

function startSupervisor(d, generation, token) {
  const candidates = [
    path.join(d.repo, 'tools', 'host-fallback.js'),
    path.join(d.workRoot, 'impl', 'tools', 'host-fallback.js'),
    __filename,
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  const child = spawn(nodeCommand(), [script, '_supervise', d.repo, d.stateDir, d.fallbackDir, String(generation), token], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MOST_REPO_ROOT: d.repo, MOST_STATE_DIR: d.stateDir },
  });
  child.unref();
  const meta = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    repo: d.repo,
    stateDir: d.stateDir,
    fallbackDir: d.fallbackDir,
    sharedState: false,
    generation,
    token,
  };
  writeJson(path.join(d.fallbackDir, 'supervisor.json'), meta);
  return meta;
}

function supervise(repo, stateDir, fallbackDir, generation, token) {
  const workRoot = path.join(path.resolve(repo), '.work', '_grok_fallback_conductor');
  fallbackDir = assertSafeFallbackDir(fallbackDir, workRoot, path.resolve(repo));
  stateDir = assertSafeFallbackDir(stateDir, workRoot, path.resolve(repo));
  fs.mkdirSync(path.join(fallbackDir, 'host-ready'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const d = { repo, stateDir, fallbackDir };
  const children = [];
  const gen = Number(generation) || 0;
  for (const n of SERVERS) {
    const serverPath = path.join(repo, 'servers', n, 'index.js');
    const child = spawn(nodeCommand(), [serverPath], {
      env: serverEnv(d, 'codex'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    children.push({ name: n, pid: child.pid, serverPath });
    writeJson(path.join(fallbackDir, 'host-ready', n + '.json'), {
      name: n,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      client: 'codex',
      serverPath,
      stateDir,
      generation: gen,
      token,
      note: 'host-owned marker; Desktop ready/*.json not used',
    });
  }
  const supPath = path.join(fallbackDir, 'supervisor.json');
  const prev = readJson(supPath) || {};
  writeJson(supPath, {
    ...prev,
    pid: process.pid,
    children,
    supervising: true,
    generation: gen,
    token,
    startedAt: new Date().toISOString(),
  });
  const stop = () => {
    for (const c of children) {
      try { process.kill(c.pid); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {
    for (const c of children) {
      if (alive(c.pid) === false) {
        writeJson(path.join(fallbackDir, 'host-ready', c.name + '.json'), {
          name: c.name,
          pid: c.pid,
          startedAt: null,
          exited: true,
          generation: gen,
          token,
          at: new Date().toISOString(),
        });
      }
    }
  }, 5000).unref();
}


function detect(opts = {}) {
  const d = defaults(opts);
  const sharedStateDir = opts.sharedStateDir || path.join(d.repo, 'state');
  return fallbackDetect.evaluate({
    repo: d.repo,
    sharedStateDir,
    fallbackDir: d.fallbackDir,
  });
}

function parseConfirmOpts(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  return {
    confirmId: get('--confirm-id'),
    confirmToken: get('--confirm-token'),
    legacyUserConfirm: argv.includes('--user-confirm'),
  };
}

function confirmRequest(opts = {}) {
  const d = defaults(opts);
  const action = opts.action;
  if (!action) throw new Error('confirm-request needs action');
  let generation = opts.generation;
  if (generation == null) {
    const cur = currentGeneration(d.fallbackDir);
    generation = action === 'enter' ? cur + 1 : cur;
  }
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  return confirm.createChallenge(d.fallbackDir, {
    action,
    generation,
    meta: opts.meta || null,
    targetHash: opts.targetHash || null,
  });
}

function confirmStatus(opts = {}) {
  const d = defaults(opts);
  if (opts.id) return confirm.publicView(confirm.load(d.fallbackDir, opts.id));
  return { pending: confirm.listPending(d.fallbackDir) };
}

function consumeFor(d, action, opts, metaCheck) {
  confirm.requireConfirmArgs(opts, action);
  const generation = opts.expectedGeneration != null ? opts.expectedGeneration : currentGeneration(d.fallbackDir);
  const used = confirm.consume(d.fallbackDir, {
    id: opts.confirmId,
    token: opts.confirmToken,
    action,
    generation,
    targetHash: opts.targetHash || null,
  });
  if (metaCheck) metaCheck(used);
  return used;
}

async function enter(opts = {}) {
  const d = defaults(opts);
  // incr2: require confirm channel bound to next generation
  const nextGen = currentGeneration(d.fallbackDir) + 1;
  opts.expectedGeneration = nextGen;
  if (opts.legacyUserConfirm && !opts.confirmId) {
    throw new Error('enter: --user-confirm alone is not enough (incr2). Use confirm-request enter, then --confirm-id/--confirm-token.');
  }
  const used = consumeFor(d, 'enter', opts);
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  return withLock(d.fallbackDir, async () => {
    fs.mkdirSync(d.fallbackDir, { recursive: true });
    fs.mkdirSync(d.stateDir, { recursive: true });
    const stop = stopSupervisor(d.fallbackDir);
    if (!stop.allDead && hostReady(d.fallbackDir).some((m) => m.owned)) {
      throw new Error('could not stop previous host: ' + JSON.stringify(stop.results));
    }
    const token = randomUUID();
    const generation = nextGen;
    if (used.generation !== generation) {
      throw new Error('enter: confirm generation drift');
    }
    const tools = await probeAll(d);
    writeJson(path.join(d.fallbackDir, 'tools-cache.json'), {
      at: new Date().toISOString(),
      longRunningClient: 'codex',
      tools,
    });
    const supervisor = startSupervisor(d, generation, token);
    const deadline = Date.now() + 8000;
    let ready = [];
    // After leave, session.json still holds the previous token; ownedByHost(session) would
    // reject the new markers. Match the enter generation/token + live node PID instead.
    const readyForEnter = (r) =>
      r && r.alive === true && r.generation === generation && r.token === token &&
      Number.isInteger(r.pid) && !!processImage(r.pid) &&
      (process.platform !== 'win32' || /node/.test(processImage(r.pid)));
    while (Date.now() < deadline) {
      ready = hostReady(d.fallbackDir);
      if (ready.length >= SERVERS.length && ready.every(readyForEnter)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const ok = ready.length >= SERVERS.length && ready.every(readyForEnter);
    if (!ok) {
      stopSupervisor(d.fallbackDir, { forceWipe: true });
      throw new Error('enter: long-lived servers did not confirm ownership (owned/generation/token)');
    }
    const session = {
      generation,
      token,
      mode: 'fallback',
      conductor: 'user+host',
      authority: 'user',
      advisor: 'grok',
      increment: INCREMENT,
      enteredAt: new Date().toISOString(),
      sharedState: false,
      stateDir: d.stateDir,
      supervisorPid: supervisor.pid,
      confirmId: used.id,
      note: 'incr1-4: isolated servers; confirm channel; jobs/actions; access draft',
    };
    writeJson(path.join(d.fallbackDir, 'session.json'), session);
    return { session, supervisor, tools, hostReady: ready, confirm: used, status: status(opts) };
  });
}

async function leave(opts = {}) {
  const d = defaults(opts);
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  opts.expectedGeneration = currentGeneration(d.fallbackDir);
  if (opts.legacyUserConfirm && !opts.confirmId) {
    throw new Error('leave: --user-confirm alone is not enough (incr2). Use confirm-request leave, then --confirm-id/--confirm-token.');
  }
  const used = consumeFor(d, 'leave', opts);
  return withLock(d.fallbackDir, async () => {
    const stop = stopSupervisor(d.fallbackDir);
    const prev = readJson(path.join(d.fallbackDir, 'session.json')) || {};
    if (!stop.allDead) {
      const session = {
        ...prev,
        mode: 'leave-failed',
        leaveAttemptAt: new Date().toISOString(),
        stop,
        confirmId: used.id,
      };
      writeJson(path.join(d.fallbackDir, 'session.json'), session);
      throw new Error('leave: not all processes stopped; markers kept. ' + JSON.stringify(stop.results));
    }
    const session = {
      ...prev,
      mode: 'left',
      authority: 'claude',
      generation: (prev.generation || 0) + 1,
      leftAt: new Date().toISOString(),
      nextConductor: 'claude',
      stop,
      confirmId: used.id,
      note: 'generation bumped on leave so prior confirms cannot apply',
    };
    writeJson(path.join(d.fallbackDir, 'session.json'), session);
    return session;
  });
}

// --- incr2 jobs ---
function jobDirs(stateDir) {
  return {
    codex: path.join(stateDir, 'codex-jobs'),
    antigravity: path.join(stateDir, 'jobs'),
    grok: path.join(stateDir, 'grok-jobs'),
  };
}

function listJobs(opts = {}) {
  const d = defaults(opts);
  const dirs = jobDirs(d.stateDir);
  const out = [];
  for (const who of Object.keys(dirs)) {
    const dir = dirs[who];
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const card = readJson(path.join(dir, name));
      if (!card) continue;
      out.push({
        who,
        id: card.id || name.replace(/\.json$/, ''),
        status: card.status,
        work: card.workName || card.work || null,
        owner: card.owner || null,
        from: card.from || null,
        file: path.join(dir, name),
        childPid: card.childPid || (card.stopUnconfirmed && card.stopUnconfirmed.pid) || null,
      });
    }
  }
  return { increment: 2, stateDir: d.stateDir, jobs: out };
}

async function stopJob(opts = {}) {
  const d = defaults(opts);
  const who = opts.who;
  const id = opts.id;
  if (!['codex', 'antigravity', 'grok'].includes(who)) throw new Error('jobs-stop: who=codex|antigravity|grok');
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('jobs-stop: bad id');
  opts.expectedGeneration = currentGeneration(d.fallbackDir);
  if (opts.legacyUserConfirm && !opts.confirmId) {
    throw new Error('jobs-stop: need confirm-request jobs.stop then --confirm-id/--confirm-token');
  }
  const used = consumeFor(d, 'jobs.stop', opts, (u) => {
    if (!u.meta || u.meta.who !== who || u.meta.id !== id) {
      throw new Error('confirm meta must bind exact who+id for jobs.stop');
    }
  });
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  return withLock(d.fallbackDir, () => {
    const dirs = jobDirs(d.stateDir);
    const file = path.join(dirs[who], id + '.json');
    // Isolation: only cards under our stateDir
    if (!isInside(file, d.stateDir)) throw new Error('jobs-stop: path escapes stateDir');
    const card = readJson(file);
    if (!card) throw new Error('jobs-stop: card not found in isolated state: ' + file);
    const prevStatus = card.status;
    const cancelable = ['running', 'queued', 'waiting_quota', 'cancelling', 'stop_unconfirmed', 'delivery_unclear'];
    if (!cancelable.includes(card.status) && card.status !== 'cancelled') {
      // still allow marking cancel request for draft visibility
    }
    // Write cancel side-file (antigravity pattern) + update card
    const cancelPath = path.join(path.dirname(file), id + '.cancel');
    fs.writeFileSync(cancelPath, new Date().toISOString() + '\n');
    if (who === 'antigravity') {
      const agyCancel = path.join(d.stateDir, 'input', id, 'cancel');
      try {
        fs.mkdirSync(path.dirname(agyCancel), { recursive: true });
        fs.writeFileSync(agyCancel, new Date().toISOString());
      } catch {}
    }
    card.status = ['queued', 'waiting_quota'].includes(card.status) ? 'cancelled' : 'cancelling';
    card.stopReason = 'host-fallback';
    card.hostStop = {
      at: new Date().toISOString(),
      confirmId: used.id,
      generation: used.generation,
      prevStatus,
    };
    // Never kill arbitrary PID from card. Kill only if pid is currently host-owned.
    let kill = null;
    const pid = Number(card.childPid || (card.stopUnconfirmed && card.stopUnconfirmed.pid));
    const session = readJson(path.join(d.fallbackDir, 'session.json'));
    const hostPids = new Set();
    for (const m of hostReady(d.fallbackDir)) if (m.owned) hostPids.add(m.pid);
    const sup = readJson(path.join(d.fallbackDir, 'supervisor.json'));
    if (sup && Array.isArray(sup.children)) {
      for (const c of sup.children) {
        if (Number.isInteger(c.pid) && ownedByHost({ pid: c.pid, generation: session && session.generation, token: session && session.token }, session)) {
          hostPids.add(c.pid);
        }
      }
    }
    if (Number.isInteger(pid) && pid > 0 && hostPids.has(pid)) {
      kill = killPid(pid);
      if (kill.ok) {
        card.status = 'cancelled';
        delete card.stopUnconfirmed;
      } else {
        card.status = 'stop_unconfirmed';
        card.stopUnconfirmed = { pid, at: new Date().toISOString(), via: 'host-fallback' };
      }
    } else if (Number.isInteger(pid) && pid > 0) {
      kill = { pid, ok: false, skipped: true, reason: 'pid not host-owned; cancel marker only' };
    }
    writeJson(file, card);
    return {
      increment: 2,
      who,
      id,
      file,
      prevStatus,
      status: card.status,
      kill,
      confirm: used,
      cancelPath,
      note: 'Stopped via host on isolated state only; live Desktop jobs untouched.',
    };
  });
}


// --- incr2 jobs enqueue ---
async function enqueueJob(opts = {}) {
  const d = defaults(opts);
  const who = opts.who;
  const task = opts.task || opts.text || '';
  if (!['codex', 'antigravity', 'grok'].includes(who)) throw new Error('jobs-enqueue: who=codex|antigravity|grok');
  if (!task || String(task).trim().length < 3) throw new Error('jobs-enqueue: task required');
  opts.expectedGeneration = currentGeneration(d.fallbackDir);
  const used = consumeFor(d, 'jobs.enqueue', opts, (u) => {
    if (!u.meta || u.meta.who !== who) throw new Error('confirm meta.who mismatch for enqueue');
  });
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  return withLock(d.fallbackDir, () => {
    const dirs = jobDirs(d.stateDir);
    fs.mkdirSync(dirs[who], { recursive: true });
    const id = (opts.id && /^[a-zA-Z0-9_-]{1,80}$/.test(opts.id)) ? opts.id : ('q' + Date.now().toString(36));
    const file = path.join(dirs[who], id + '.json');
    if (fs.existsSync(file)) throw new Error('jobs-enqueue: id exists');
    if (!isInside(file, d.stateDir)) throw new Error('jobs-enqueue: path escapes stateDir');
    const card = {
      id,
      who,
      status: 'queued',
      from: 'host-fallback',
      task: String(task).slice(0, 20000),
      workName: opts.work || null,
      createdAt: new Date().toISOString(),
      generation: used.generation,
      confirmId: used.id,
      note: 'queued by host on isolated state; guest servers do not auto-run write jobs',
    };
    writeJson(file, card);
    return { increment: 2, who, id, file, status: card.status, confirm: used };
  });
}

// --- incr3 actions ---
function actionsIngest(opts = {}) {
  const d = defaults(opts);
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  let text = opts.text;
  if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  if (!text) throw new Error('actions-ingest: need --text or --file');
  const proposal = proposed.parseProposal(text, { source: opts.source || 'grok' });
  const rec = proposed.storeProposal(d.fallbackDir, proposal, { rawText: text });
  return { increment: 3, stored: rec, note: 'Proposal stored; apply requires human confirm-request actions.apply' };
}

function actionsList(opts = {}) {
  const d = defaults(opts);
  return { increment: 3, proposals: proposed.listProposals(d.fallbackDir) };
}

async function actionsApply(opts = {}) {
  const d = defaults(opts);
  const id = opts.id;
  opts.expectedGeneration = currentGeneration(d.fallbackDir);
  if (opts.legacyUserConfirm && !opts.confirmId) {
    throw new Error('actions-apply: need confirm channel');
  }
  accessDraft.assertPeerNotJudge({ fallbackDir: d.fallbackDir });
  const rec = proposed.loadProposal(d.fallbackDir, id);
  if (!rec || rec.status !== 'pending') throw new Error('actions-apply: pending proposal not found');
  const contentHash = require('crypto').createHash('sha256')
    .update(JSON.stringify({ id: rec.id, actions: rec.actions, source: rec.source }), 'utf8').digest('hex');
  opts.targetHash = contentHash;
  const used = consumeFor(d, 'actions.apply', opts, (u) => {
    if (!u.meta || u.meta.id !== id) throw new Error('confirm meta.id mismatch');
    if (!u.targetHash || u.targetHash !== contentHash) throw new Error('proposal content changed after confirm');
  });
  const results = [];
  for (const a of rec.actions) {
    if (a.type === 'status') results.push({ type: a.type, result: status(opts) });
    else if (a.type === 'list') results.push({ type: a.type, result: list(opts) });
    else if (a.type === 'jobs.list') results.push({ type: a.type, result: listJobs(opts) });
    else if (a.type === 'jobs.stop') {
      // Nested stop needs its own confirm — refuse auto-chain without dedicated challenge
      results.push({
        type: a.type,
        error: 'jobs.stop inside apply requires separate confirm-request jobs.stop (not auto-chained)',
        who: a.who,
        id: a.id,
      });
    } else if (a.type === 'roles.propose') {
      const work = (a.args && a.args.work) || a.work;
      const kind = (a.args && a.args.kind) || a.kind || 'code';
      const by = (a.args && a.args.by) || a.by || 'grok';
      const st = status(opts);
      results.push({
        type: a.type,
        result: taskRoles.propose({
          repoRoot: defaults(opts).repo || 'C:\\most',
          worksRoot: path.join(defaults(opts).repo || 'C:\\most', 'works'),
          fallbackDir: defaults(opts).fallbackDir,
          work, kind, by,
          slots: (a.args && a.args.slots) || a.slots || undefined,
          generation: (st.session && st.session.generation) || 0,
        }),
      });
    } else if (a.type === 'confirm-request') {
      results.push({ type: a.type, result: confirmRequest({ ...opts, action: a.action, meta: a.args || null }) });
    } else {
      results.push({ type: a.type, error: 'unsupported in apply' });
    }
  }
  const saved = proposed.markApplied(d.fallbackDir, id, results);
  return { increment: 3, applied: saved, confirm: used, results };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const conf = parseConfirmOpts(argv);
  const shared = argv.includes('--i-understand-shared-state');
  const fallbackDir = argValue(argv, '--fallback-dir');
  const base = { sharedState: shared, fallbackDir: fallbackDir || undefined };

  if (cmd === '_supervise') {
    supervise(process.argv[3], process.argv[4], process.argv[5], process.argv[6], process.argv[7]);
    return;
  }
  try {
    if (cmd === 'status') console.log(JSON.stringify(status(base), null, 2));
    else if (cmd === 'detect') console.log(JSON.stringify(detect(base), null, 2));
    else if (cmd === 'list') console.log(JSON.stringify(list(base), null, 2));
    else if (cmd === 'access-describe') console.log(JSON.stringify(accessDraft.describe(), null, 2));
    else if (cmd === 'confirm-request') {
      const action = argv[1];
      const metaWho = argValue(argv, '--who');
      const metaId = argValue(argv, '--id');
      const meta = (metaWho || metaId) ? { who: metaWho, id: metaId } : null;
      let targetHash = null;
      if (action === 'actions.apply' && metaId) {
        const rec = proposed.loadProposal(defaults(base).fallbackDir, metaId);
        if (!rec) throw new Error('confirm-request: proposal not found for hash');
        targetHash = require('crypto').createHash('sha256')
          .update(JSON.stringify({ id: rec.id, actions: rec.actions, source: rec.source }), 'utf8').digest('hex');
      }
      console.log(JSON.stringify(confirmRequest({ ...base, action, meta, targetHash }), null, 2));
    } else if (cmd === 'confirm-status') {
      console.log(JSON.stringify(confirmStatus({ ...base, id: argv[1] }), null, 2));
    } else if (cmd === 'confirm-reveal') {
      console.log(JSON.stringify(confirm.revealToken(defaults(base).fallbackDir, argv[1]), null, 2));
    } else if (cmd === 'enter') {
      console.log(JSON.stringify(await enter({ ...base, ...conf }), null, 2));
    } else if (cmd === 'leave') {
      console.log(JSON.stringify(await leave({ ...base, ...conf }), null, 2));
    } else if (cmd === 'jobs' || cmd === 'jobs-list') {
      console.log(JSON.stringify(listJobs(base), null, 2));
    } else if (cmd === 'jobs-stop') {
      console.log(JSON.stringify(await stopJob({
        ...base, ...conf,
        who: argValue(argv, '--who'),
        id: argValue(argv, '--id'),
      }), null, 2));
    } else if (cmd === 'jobs-enqueue') {
      console.log(JSON.stringify(await enqueueJob({
        ...base, ...conf,
        who: argValue(argv, '--who'),
        id: argValue(argv, '--id'),
        task: argValue(argv, '--task'),
        work: argValue(argv, '--work'),
      }), null, 2));
    } else if (cmd === 'actions-ingest') {
      console.log(JSON.stringify(actionsIngest({
        ...base,
        file: argValue(argv, '--file'),
        text: argValue(argv, '--text'),
        source: argValue(argv, '--source') || 'grok',
      }), null, 2));
    } else if (cmd === 'actions-list') {
      console.log(JSON.stringify(actionsList(base), null, 2));
    } else if (cmd === 'actions-apply') {
      console.log(JSON.stringify(await actionsApply({
        ...base, ...conf,
        id: argValue(argv, '--id'),
      }), null, 2));

    } else if (cmd === 'roles-propose') {
      const work = argValue(argv, '--work');
      const kind = argValue(argv, '--kind') || 'code';
      const by = argValue(argv, '--by') || 'rules';
      const slots = argValue(argv, '--slots');
      const st = status(base);
      const rec = taskRoles.propose({
        repoRoot: defaults(base).repo || defaults(base).repoRoot || 'C:\\most',
        worksRoot: argValue(argv, '--works-root') || path.join((defaults(base).repo || 'C:\\most'), 'works'),
        fallbackDir: defaults(base).fallbackDir,
        work, kind, by, slots: slots || undefined,
        generation: (st.session && st.session.generation) || 0,
      });
      console.log(JSON.stringify({ ok: true, cmd: 'roles-propose', roles: rec }, null, 2));
    } else if (cmd === 'roles-get') {
      console.log(JSON.stringify({ ok: true, cmd: 'roles-get', ...taskRoles.get({
        repoRoot: defaults(base).repo || 'C:\\most',
        worksRoot: argValue(argv, '--works-root') || path.join((defaults(base).repo || 'C:\\most'), 'works'),
        work: argValue(argv, '--work'),
      }) }, null, 2));
    } else {
      throw new Error('commands: status|list|enter|leave|detect|confirm-request|confirm-status|jobs-list|jobs-stop|actions-ingest|actions-list|actions-apply|access-describe|roles-propose|roles-get');
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {
  status, list, enter, leave, detect, readyAges, hostReady, SERVERS, INCREMENT,
  confirmRequest, confirmStatus, listJobs, stopJob, enqueueJob,
  actionsIngest, actionsList, actionsApply, accessDraft,
};