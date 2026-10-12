'use strict';
/**
 * Read-only data layer for the collegium dashboard.
 * Reuses common/* — never writes to state/, never sends jobs, never exposes webhook keys.
 */
const fs = require('fs');
const path = require('path');
const { stateDir, repoRoot } = require('../../../common/paths');
const states = require('../../../common/states');
const stores = require('../../../common/team-store');
const { Team, percent } = require('../../../common/team');
const { title, label } = require('../../../common/summary');
const { parseReply } = require('../../../common/grok');

const PREVIEW_LINES = Number(process.env.MOST_DASH_PREVIEW_LINES || 40);
const JOB_LIST_LIMIT = Number(process.env.MOST_DASH_JOB_LIMIT || 200);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonSafe(file) {
  try {
    return { ok: true, value: readJson(file) };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'missing' : e.message };
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseCommit(releasePath) {
  if (!releasePath) return null;
  const m = String(releasePath).match(/[\\/]([a-f0-9]{40})(?:[\\/]|$)/i);
  return m ? m[1].toLowerCase() : null;
}


function getFallbackStatus() {
  try {
    const detect = require('../../../common/fallback-detect');
    const r = detect.evaluate({ repo: repoRoot, sharedStateDir: stateDir });
    const desktopAlive = !!r.desktopAlive;
    const mcpAlive = !!r.mcpAlive;
    const degraded = !desktopAlive || !mcpAlive || r.advice === 'advise_enter' || r.advice === 'hold_fallback';
    let level = 'ok';
    let bannerRu = 'Claude Desktop и MCP выглядят доступными.';
    if (!desktopAlive && !mcpAlive) {
      level = 'bad';
      bannerRu = 'Claude Desktop / MCP недоступны: процесс Desktop не найден, state/ready/team мёртв. Most MCP (antigravity_send / codex_send / team_work) из Desktop недоступен.';
    } else if (!desktopAlive || !mcpAlive) {
      level = 'warn';
      bannerRu = !desktopAlive
        ? 'Claude Desktop не найден; MCP/ready могут быть устаревшими.'
        : 'MCP/team ready мёртв при живом Desktop — состояние неоднозначное.';
    } else if (degraded) {
      level = 'warn';
      bannerRu = 'Fallback detect: ' + (r.reason || r.advice || 'деградация');
    }
    return {
      desktopAlive,
      mcpAlive,
      advice: r.advice || null,
      reason: r.reason || null,
      degraded,
      level,
      banner_ru: bannerRu,
      enterSignals: (r.enterSignals || []).slice(0, 8).map((s) => ({
        id: s.id, weight: s.weight, detail: s.detail,
      })),
      leaveSignals: (r.leaveSignals || []).slice(0, 8).map((s) => ({
        id: s.id, weight: s.weight, detail: s.detail,
      })),
    };
  } catch (e) {
    return {
      desktopAlive: null,
      mcpAlive: null,
      advice: null,
      reason: 'fallback-detect failed: ' + e.message,
      degraded: true,
      level: 'warn',
      banner_ru: 'Не удалось проверить Desktop/MCP: ' + e.message,
      enterSignals: [],
      leaveSignals: [],
      error: e.message,
    };
  }
}

function getReady() {
  const readyDir = path.join(stateDir, 'ready');
  const names = ['antigravity', 'codex', 'grok', 'team'];
  const servers = {};
  for (const name of names) {
    const file = path.join(readyDir, name + '.json');
    const r = readJsonSafe(file);
    if (!r.ok) {
      servers[name] = { present: false, alive: false, error: r.error };
      continue;
    }
    const v = r.value;
    const alive = pidAlive(v.pid);
    servers[name] = {
      present: true,
      alive,
      pid: v.pid,
      startedAt: v.startedAt || null,
      release: v.release || null,
      releaseCommit: releaseCommit(v.release),
    };
  }

  const deployedFile = path.join(repoRoot, 'live', 'deployed.json');
  const dep = readJsonSafe(deployedFile);
  let deployed = null;
  if (dep.ok) {
    deployed = {
      commit: dep.value.commit || null,
      release: dep.value.release || null,
      at: dep.value.at || null,
      method: dep.value.method || null,
    };
  }

  const readyCommits = [...new Set(Object.values(servers).map((s) => s.releaseCommit).filter(Boolean))];
  const deployedCommit = deployed?.commit ? String(deployed.commit).toLowerCase() : null;
  const mismatch =
    deployedCommit && readyCommits.length
      ? !readyCommits.every((c) => c === deployedCommit) || readyCommits.length > 1
      : readyCommits.length > 1;

  return {
    servers,
    deployed,
    mismatch,
    note: mismatch
      ? 'deployed.json и state/ready/*.json указывают на разные релизы (или ready между собой расходятся)'
      : null,
    checkedAt: new Date().toISOString(),
    fallback: getFallbackStatus(),
  };
}

async function getQuotas() {
  const teamState = path.join(stateDir, 'team');
  const snapshotPath = path.join(teamState, 'claude-quota.json');
  const snap = readJsonSafe(snapshotPath);

  let line = null;
  let liveError = null;
  let agy = null;
  let codex = null;

  try {
    const { quotaLine, claudeText } = require('../../../common/quota-line');
    line = await quotaLine({ state: teamState, advice: false });
    try {
      agy = await require('../../../common/agy-quota').agySnapshot();
    } catch (e) {
      agy = { text: 'ошибка: ' + e.message };
    }
    try {
      const q = require('../../../common/quota');
      codex = await q.codexQuota();
    } catch (e) {
      try {
        codex = require('../../../common/quota').rollout() || { error: e.message };
      } catch (e2) {
        codex = { error: e.message };
      }
    }
    return {
      live: true,
      line,
      claude: snap.ok
        ? { ...snap.value, text: claudeText(snap.value), snapshot: true }
        : { error: snap.error, text: claudeText(null) },
      antigravity: sanitizeQuota(agy),
      codex: sanitizeQuota(codex),
      taken_at: new Date().toISOString(),
    };
  } catch (e) {
    liveError = e.message;
    const { claudeText } = require('../../../common/quota-line');
    return {
      live: false,
      liveError,
      line: null,
      claude: snap.ok
        ? { ...snap.value, text: claudeText(snap.value), snapshot: true }
        : { error: snap.error },
      antigravity: null,
      codex: null,
      fallback: 'team/claude-quota.json snapshot (live quota helpers failed)',
      taken_at: new Date().toISOString(),
    };
  }
}

function sanitizeQuota(q) {
  if (!q || typeof q !== 'object') return q;
  // Drop raw Connect/CSRF-ish blobs; keep display text + window stats.
  const out = {
    text: q.text || null,
    taken_at: q.taken_at || null,
    source: q.source || null,
    five_hour: q.five_hour || null,
    weekly: q.weekly || null,
    all: q.all || null,
    plans: q.plans || null,
    error: q.error || null,
    accountEmail: q.accountEmail ? maskEmail(q.accountEmail) : undefined,
  };
  if (q.data && !out.text) {
    try {
      out.text = require('../../../common/agy-quota').parseQuota(q.data, q.accountEmail);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function maskEmail(email) {
  const s = String(email);
  const i = s.indexOf('@');
  if (i < 2) return '***';
  return s[0] + '***' + s.slice(i);
}

function rolesPath(workName) {
  return path.join(repoRoot, 'works', workName, 'roles.json');
}

function formatOwnerLabel(raw, context) {
  if (raw == null || raw === '') return 'не указан';
  if (typeof raw === 'object') {
    if (raw.instance || raw.pid) {
      const agent = context && context.agent ? String(context.agent) : null;
      return agent ? ('агент ' + agent) : 'процесс (не человек)';
    }
    if (raw.name) return formatOwnerLabel(raw.name, context);
    return 'не указан';
  }
  const s = String(raw);
  if (/^user$/i.test(s)) return 'пользователь';
  if (/^grok-collegium/i.test(s)) return 'коллегия (Grok)';
  if (/^cowork-/i.test(s)) return 'группа ' + s.slice(0, 18);
  if (/^(antigravity|codex|grok|claude)$/i.test(s)) return 'агент ' + s.toLowerCase();
  if (s.length > 40) return s.slice(0, 37) + '…';
  return s;
}

function ownerFields(raw, context) {
  const owner = raw == null || raw === '' ? null : (typeof raw === 'object' ? null : String(raw));
  const owner_label = formatOwnerLabel(raw, context);
  return { owner, owner_label };
}

function getWorks() {
  const team = new Team();
  const works = team.works();
  return works.map((w) => {
    if (w.error) return { error: w.error };
    const openIdx = w.stages.findIndex((s) => s.state !== 'принят');
    const roles = readJsonSafe(rolesPath(w.name));
    return {
      name: w.name,
      title: title(w),
      label: label(w),
      revision: w.revision,
      percent: percent(w),
      next_step: w.next_step,
      updated_at: w.updated_at || null,
      heartbeat_at: w.heartbeat_at || null,
      closed: !!w.closed,
      stages_total: w.stages.length,
      stages_done: w.stages.filter((s) => s.state === 'принят').length,
      current_stage:
        openIdx < 0
          ? null
          : { index: openIdx + 1, title: w.stages[openIdx].title, state: w.stages[openIdx].state },
      has_roles: roles.ok,
      roles_status: roles.ok ? roles.value.status : null,
      ...ownerFields(w.owner, { kind: 'work' }),
    };
  });
}

function getWork(name) {
  if (!/^[a-z0-9-]{1,40}$/.test(name || '')) throw Object.assign(new Error('bad work name'), { status: 400 });
  const team = new Team();
  let w;
  try {
    w = team.readWork(team.workFile(name));
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('work not found'), { status: 404 });
    throw e;
  }
  const roles = readJsonSafe(rolesPath(name));
  const openIdx = w.stages.findIndex((s) => s.state !== 'принят');
  return {
    name: w.name,
    title: title(w),
    label: label(w),
    revision: w.revision,
    percent: percent(w),
    goal: w.goal,
    done_criteria: w.done_criteria,
    next_step: w.next_step,
    reminders: w.reminders || [],
    updated_at: w.updated_at || null,
    heartbeat_at: w.heartbeat_at || null,
    owner: w.owner || null,
    stages: (w.stages || []).map((s, idx) => ({
      index: idx + 1,
      id: s.id || null,
      title: s.title,
      state: s.state,
      weight: s.weight,
      evidence: s.evidence || null,
      version: s.version || null,
      gate: s.gate
        ? {
            message: s.gate.message || null,
            warning: s.gate.warning || null,
            reasons: s.gate.reasons || [],
            files_count: (s.gate.files || []).length,
          }
        : null,
    })),
    current_stage: openIdx < 0 ? null : openIdx + 1,
    roles: roles.ok ? roles.value : null,
    roles_error: roles.ok ? null : roles.error,
    roles_confirmed: !!(roles.ok && roles.value && roles.value.status === 'confirmed'),
    related_paths: listWorkRelatedPaths(name),
    drafts_summary: listWorkDrafts(name, { limit: 30 }),
  };
}


function workRef(j) {
  const w = j.work;
  if (w == null) return null;
  if (typeof w === 'string') return w;
  if (typeof w === 'object') return w.path || w.name || null;
  return String(w);
}

const AGENT_ALIASES = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  codex: 'codex',
  grok: 'grok',
};

function normalizeAgent(a) {
  const k = String(a || '').toLowerCase();
  return AGENT_ALIASES[k] || null;
}

function jobSummary(who, j) {
  const task = j.task || j.poruchenie || j.text || '';
  const of = ownerFields(j.owner || who, { kind: 'job', agent: who });
  return {
    agent: who,
    id: j.id,
    status: j.stopUnconfirmed ? 'stop_unconfirmed' : j.status,
    local_status: j.status,
    status_label: j.stopUnconfirmed ? states.stop_unconfirmed : states[j.status] || j.status,
    owner: of.owner,
    owner_label: of.owner_label,
    startedAt: j.startedAt || null,
    finishedAt: j.finishedAt || null,
    nextAttemptAt: j.nextAttemptAt || null,
    stage: j.stage || null,
    work: workRef(j),
    mode: j.mode || j.rezhim || null,
    model: typeof j.model === 'string' ? j.model : j.modelId || null, // legacy requested model
    provenance: require('../../../common/provenance').forJob(j, who),
    provenance_label: require('../../../common/provenance').format(j, who),
    write: !!j.write,
    archived: !!j.archived,
    task_preview: String(task).replace(/\s+/g, ' ').slice(0, 160),
  };
}

function getJobs({ agent, status, limit = JOB_LIST_LIMIT, includeArchive = false } = {}) {
  const agents = agent ? [normalizeAgent(agent)].filter(Boolean) : ['antigravity', 'codex', 'grok'];
  if (agent && !agents.length) throw Object.assign(new Error('unknown agent'), { status: 400 });
  const out = [];
  const errors = [];
  for (const who of agents) {
    const listed = stores.list(who, includeArchive);
    errors.push(...listed.errors.map((e) => who + ': ' + e));
    for (const j of listed.jobs) {
      if (status && (j.stopUnconfirmed ? 'stop_unconfirmed' : j.status) !== status) continue;
      out.push(jobSummary(who, j));
    }
  }
  out.sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
  const lim = Math.min(Math.max(Number(limit) || JOB_LIST_LIMIT, 1), 1000);
  return {
    total_matched: out.length,
    returned: Math.min(out.length, lim),
    jobs: out.slice(0, lim),
    errors,
  };
}

function stripSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const banned = /^(key|token|csrf|secret|password|authorization|webhook)/i;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (banned.test(k)) continue;
    if (k === 'markers') continue;
    if (k === 'work' && v && typeof v === 'object') {
      out[k] = {
        path: v.path || null,
        name: v.name || null,
        range: v.range || null,
        fileHash: v.fileHash || null,
        text_chars: v.text != null ? String(v.text).length : 0,
      };
      continue;
    }
    if (typeof v === 'string' && v.length > 4000 && (k === 'poruchenie' || k === 'task' || k === 'text')) {
      out[k] = v.slice(0, 500) + '…';
      out[k + '_truncated'] = true;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function previewText(text, extra = {}) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const n = PREVIEW_LINES;
  return {
    verdict: extra.verdict || null,
    lines: lines.slice(0, n),
    truncated: lines.length > n || raw.length > 20000,
    total_lines: lines.length,
    total_chars: raw.length,
    ...extra.meta,
  };
}

function readResultPreview(who, job) {
  const roots = stores.roots();
  const dir = roots[who];
  try {
    let file;
    if (who === 'antigravity') {
      file = path.join(path.dirname(job.cardFile), 'result.txt');
    } else if (who === 'grok') {
      file = path.join(dir, job.id + '.result.txt');
    } else {
      file = stores.resultPath(job, dir);
    }
    if (!file || !fs.existsSync(file)) {
      return { available: false, reason: 'result file missing' };
    }
    // Refuse to follow paths outside job roots (team-store already guards; double-check basename).
    const text = fs.readFileSync(file, 'utf8');
    if (who === 'grok') {
      const parsed = parseReply(Buffer.from(text));
      if (parsed) {
        return {
          available: true,
          ...previewText(parsed.text || text, { verdict: parsed.verdict }),
        };
      }
    }
    // Codex / AGY: last non-empty line often holds the verdict.
    const nonempty = text.trim().split(/\r?\n/).filter((l) => l.trim());
    const last = nonempty.at(-1) || null;
    let verdict = null;
    if (last && /^(принят|не принят|ПРИНЯТО|ОТКЛОНЕНО|OK|FAIL)/i.test(last.replace(/^(\*\*|\*|__|_)(.+)\1$/, '$2').trim())) {
      verdict = last.replace(/^(\*\*|\*|__|_)(.+)\1$/, '$2').trim().slice(0, 200);
    }
    return { available: true, ...previewText(text, { verdict }) };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

function getJob(agent, id) {
  const who = normalizeAgent(agent);
  if (!who) throw Object.assign(new Error('unknown agent'), { status: 400 });
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw Object.assign(new Error('bad id'), { status: 400 });
  const listed = stores.list(who, true);
  const job = listed.jobs.find((j) => j.id === id);
  if (!job) throw Object.assign(new Error('job not found'), { status: 404 });
  const summary = jobSummary(who, job);
  const card = stripSensitive({ ...job });
  delete card.cardFile;
  delete card.archived;
  const preview = readResultPreview(who, job);
  return { ...summary, card, preview };
}

function tailNotify(limit = 40) {
  const file = path.join(stateDir, 'notify.log');
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      out.push({
        at: ev.at || null,
        title: ev.title || null,
        text: String(ev.text || '').slice(0, 400),
        result: ev.result || null,
      });
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function recentJobChanges(limit = 30) {
  // Lightweight: scan mtimes of card files / json — avoid full parse of all 900.
  const items = [];
  const roots = stores.roots();
  for (const who of ['antigravity', 'codex', 'grok']) {
    const dir = roots[who];
    if (!fs.existsSync(dir)) continue;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes('.conflict-') || name.startsWith('.') || name.endsWith('.key')) continue;
      let file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isDirectory()) {
          file = path.join(file, 'card.json');
          if (!fs.existsSync(file)) continue;
        } else if (!name.endsWith('.json')) continue;
        const mtime = fs.statSync(file).mtimeMs;
        items.push({ who, file, mtime, id: name.replace(/\.json$/, '') });
      } catch {
        /* skip */
      }
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  const top = items.slice(0, limit);
  const out = [];
  for (const it of top) {
    try {
      const j = readJson(it.file);
      out.push({
        at: new Date(it.mtime).toISOString(),
        agent: it.who,
        id: j.id || it.id,
        status: j.status,
        status_label: states[j.status] || j.status,
        stage: j.stage || null,
        work: workRef(j),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

function getFeed({ notifyLimit = 40, jobsLimit = 30 } = {}) {
  return {
    notify: tailNotify(notifyLimit),
    jobs: recentJobChanges(jobsLimit),
    at: new Date().toISOString(),
  };
}


function listDirFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (exts && !exts.some((e) => name.toLowerCase().endsWith(e))) continue;
    out.push({ name, full, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

function previewFileHead(full, maxChars = 900) {
  try {
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split(/\r?\n/);
    const head = raw.slice(0, maxChars);
    return {
      available: true,
      preview: head + (raw.length > maxChars ? '…' : ''),
      truncated: raw.length > maxChars,
      total_chars: raw.length,
      total_lines: lines.length,
      first_line: (lines.find((l) => l.trim()) || '').slice(0, 160),
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

function listWorkRelatedPaths(workName) {
  const base = path.join(repoRoot, 'works', workName);
  const card = path.join(repoRoot, 'works', workName + '.json');
  const items = [
    { kind: 'card', path: card, exists: fs.existsSync(card) },
    { kind: 'roles', path: path.join(base, 'roles.json'), exists: fs.existsSync(path.join(base, 'roles.json')) },
    { kind: 'discussion', path: path.join(base, 'DISCUSSION.md'), exists: fs.existsSync(path.join(base, 'DISCUSSION.md')) },
    { kind: 'judge', path: path.join(base, 'JUDGE.md'), exists: fs.existsSync(path.join(base, 'JUDGE.md')) },
  ];
  for (const sub of ['briefs', 'proposals', '_handoff', path.join('_handoff','intents')]) {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of listDirFiles(dir, ['.md', '.txt', '.json'])) {
      items.push({
        kind: sub,
        path: f.full,
        name: f.name,
        exists: true,
        mtime: new Date(f.mtimeMs).toISOString(),
        size: f.size,
      });
    }
  }
  return items;
}

function listWorkDrafts(workName, { limit = 40 } = {}) {
  const base = path.join(repoRoot, 'works', workName);
  const items = [];
  for (const kind of ['proposals', 'briefs', 'proposals-write', 'briefs-write']) {
    const dir = path.join(base, kind);
    for (const f of listDirFiles(dir, ['.md', '.txt'])) {
      const prev = previewFileHead(f.full, 400);
      items.push({
        work: workName,
        kind,
        name: f.name,
        path: f.full,
        mtime: new Date(f.mtimeMs).toISOString(),
        size: f.size,
        first_line: prev.first_line || null,
        preview: prev.preview || null,
        truncated: !!prev.truncated,
      });
    }
  }
  for (const doc of ['DISCUSSION.md', 'JUDGE.md', 'DISCUSSION-write.md', 'JUDGE-write.md']) {
    const full = path.join(base, doc);
    if (!fs.existsSync(full)) continue;
    const st = fs.statSync(full);
    const prev = previewFileHead(full, 400);
    items.push({
      work: workName,
      kind: 'docs',
      name: doc,
      path: full,
      mtime: new Date(st.mtimeMs).toISOString(),
      size: st.size,
      first_line: prev.first_line || null,
      preview: prev.preview || null,
      truncated: !!prev.truncated,
    });
  }
  items.sort((a, b) => Date.parse(b.mtime || 0) - Date.parse(a.mtime || 0));
  return { work: workName, total: items.length, drafts: items.slice(0, limit) };
}

function listAllDrafts({ work, limit = 60, includeReplies = false } = {}) {
  const worksRoot = path.join(repoRoot, 'works');
  let workNames = [];
  if (work) {
    if (!/^[a-z0-9-]{1,40}$/.test(work)) throw Object.assign(new Error('bad work name'), { status: 400 });
    workNames = [work];
  } else {
    try {
      workNames = fs.readdirSync(worksRoot).filter((n) => {
        try { return fs.statSync(path.join(worksRoot, n)).isDirectory(); } catch { return false; }
      });
    } catch {
      workNames = [];
    }
  }
  const all = [];
  for (const w of workNames) {
    const part = listWorkDrafts(w, { limit: 100 });
    all.push(...part.drafts);
  }
  if (includeReplies) {
    const repliesDir = path.join(stateDir, 'grok', 'replies');
    for (const f of listDirFiles(repliesDir, ['.md', '.txt']).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 25)) {
      const prev = previewFileHead(f.full, 350);
      all.push({
        work: null,
        kind: 'grok-replies',
        name: f.name,
        path: f.full,
        mtime: new Date(f.mtimeMs).toISOString(),
        size: f.size,
        first_line: prev.first_line || null,
        preview: prev.preview || null,
        truncated: !!prev.truncated,
      });
    }
  }
  all.sort((a, b) => Date.parse(b.mtime || 0) - Date.parse(a.mtime || 0));
  const lim = Math.min(Math.max(Number(limit) || 60, 1), 200);
  return { total_matched: all.length, returned: Math.min(all.length, lim), drafts: all.slice(0, lim) };
}

function getDraftPreview({ work, kind, name } = {}) {
  if (kind === 'grok-replies') {
    if (!name || !/^[a-zA-Z0-9._-]{1,120}$/.test(name) || name.includes('..')) {
      throw Object.assign(new Error('bad file name'), { status: 400 });
    }
    const resolved = path.resolve(path.join(stateDir, 'grok', 'replies', name));
    const root = path.resolve(path.join(stateDir, 'grok', 'replies'));
    if (!(resolved === root || resolved.startsWith(root + path.sep))) {
      throw Object.assign(new Error('path outside allowlist'), { status: 403 });
    }
    if (!fs.existsSync(resolved)) throw Object.assign(new Error('draft not found'), { status: 404 });
    const st = fs.statSync(resolved);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
    const prev = previewFileHead(resolved, Number(process.env.MOST_DASH_DRAFT_CHARS || 6000));
    return { work: null, kind, name, path: resolved, mtime: st.mtime.toISOString(), size: st.size, ...prev };
  }
  if (!work || !/^[a-z0-9-]{1,40}$/.test(work)) throw Object.assign(new Error('bad work name'), { status: 400 });
  if (!kind || !/^[a-z0-9_-]{1,40}$/.test(kind)) throw Object.assign(new Error('bad kind'), { status: 400 });
  if (!name || !/^[a-zA-Z0-9._-]{1,120}$/.test(name) || name.includes('..')) {
    throw Object.assign(new Error('bad file name'), { status: 400 });
  }
  let full;
  if (kind === 'docs') {
    full = path.join(repoRoot, 'works', work, name);
  } else {
    full = path.join(repoRoot, 'works', work, kind, name);
  }
  const resolved = path.resolve(full);
  const workRoot = path.resolve(path.join(repoRoot, 'works', work));
  if (!(resolved === workRoot || resolved.startsWith(workRoot + path.sep))) {
    throw Object.assign(new Error('path outside allowlist'), { status: 403 });
  }
  if (!fs.existsSync(resolved)) throw Object.assign(new Error('draft not found'), { status: 404 });
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
  const prev = previewFileHead(resolved, Number(process.env.MOST_DASH_DRAFT_CHARS || 6000));
  return {
    work,
    kind,
    name,
    path: resolved,
    mtime: st.mtime.toISOString(),
    size: st.size,
    ...prev,
  };
}

function health() {
  const ready = getReady();
  const fb = ready.fallback || getFallbackStatus();
  // Hour-5 U1: separate channels — Desktop/MCP ≠ write-bridge ≠ webhook file
  let webhookConfigured = false;
  let webhookCheckedAt = null;
  try {
    const wp = path.join(stateDir, 'grok-webhook.json');
    webhookConfigured = fs.existsSync(wp);
    webhookCheckedAt = new Date().toISOString();
  } catch (_) {}
  const bridgeOk = true; // this process serves the intents write-bridge
  const desktopOk = !!(fb.desktopAlive && fb.mcpAlive);
  // Honest banner: never claim all AI dead when bridge works
  let banner_ru = fb.banner_ru;
  let banner_level = fb.level;
  if (bridgeOk && !desktopOk) {
    banner_level = 'warn';
    banner_ru =
      'Мост указаний активен — можно сохранять и подтверждать указания. Claude Desktop / MCP на паузе: для постановки в очередь most может понадобиться CLI или human token. Остальные каналы (мост, CLI) при этом могут работать.';
  }
  return {
    ok: true,
    service: 'most-dashboard',
    read_only: false,
    write_bridge: 'intents',
    write_routes: ['POST /api/intents','POST /api/intents/:work/:id/confirm','POST /api/intents/:work/:id/enqueue'],
    bind: '127.0.0.1',
    repoRoot,
    stateDir,
    ready_alive: Object.fromEntries(
      Object.entries(ready.servers).map(([k, v]) => [k, !!v.alive]),
    ),
    mismatch: ready.mismatch,
    fallback: fb,
    desktopAlive: fb.desktopAlive,
    mcpAlive: fb.mcpAlive,
    banner_ru,
    banner_level,
    channels: {
      desktop_mcp: {
        ok: desktopOk,
        desktopAlive: !!fb.desktopAlive,
        mcpAlive: !!fb.mcpAlive,
        label_ru: 'Claude Desktop / MCP',
      },
      write_bridge: {
        ok: bridgeOk,
        kind: 'intents',
        label_ru: 'Мост указаний',
      },
      grok_webhook: {
        configured: webhookConfigured,
        checkedAt: webhookCheckedAt,
        label_ru: 'Grok webhook (файл)',
        note_ru: webhookConfigured
          ? 'Файл настроек найден — доступность живого webhook отдельно не проверялась'
          : 'Файл настроек не найден',
      },
    },
    now: new Date().toISOString(),
  };
}


/** Host-fallback isolated queue (DISCUSSION-gap G5). Not Desktop live state. */
function getHostJobs({ agent, status, limit = JOB_LIST_LIMIT } = {}) {
  let host;
  try {
    host = require('../../../tools/host-fallback');
  } catch (e) {
    return { source: 'host-fallback', total_matched: 0, returned: 0, jobs: [], error: e.message, note: 'host-fallback module unavailable' };
  }
  try {
    const listed = host.listJobs ? host.listJobs({}) : { jobs: [] };
    const raw = listed.jobs || listed || [];
    const agents = agent ? [String(agent)] : null;
    const out = [];
    for (const j of raw) {
      const who = j.who || j.agent || null;
      const stored = j.file ? readJsonSafe(j.file) : null;
      const card = stored?.ok ? stored.value : j;
      const localStatus = card.status || j.status;
      const effectiveStatus = (card.stopUnconfirmed || j.stopUnconfirmed) ? 'stop_unconfirmed' : localStatus;
      if (agents && !agents.includes(who)) continue;
      if (status && effectiveStatus !== status) continue;
      out.push({
        agent: who,
        id: j.id,
        status: effectiveStatus,
        local_status: localStatus,
        status_label: states[effectiveStatus] || effectiveStatus,
        work: j.workName || j.work || null,
        startedAt: j.createdAt || j.startedAt || null,
        task: String(j.task || '').slice(0, 160),
        from: 'host-fallback',
        provenance: require('../../../common/provenance').forJob(card, who),
        source: 'host-fallback',
        note: j.note || null,
      });
    }
    out.sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
    const lim = Math.min(Math.max(Number(limit) || JOB_LIST_LIMIT, 1), 1000);
    return {
      source: 'host-fallback',
      stateDir: listed.stateDir || null,
      total_matched: out.length,
      returned: Math.min(out.length, lim),
      jobs: out.slice(0, lim),
      note: 'Isolated host-fallback queue (.work/_grok_fallback_conductor/state). Guest Desktop servers do not auto-run these cards.',
    };
  } catch (e) {
    return { source: 'host-fallback', total_matched: 0, returned: 0, jobs: [], error: e.message };
  }
}

/** Find host job by id without list truncation (DISCUSSION-hour1 H1). */
function findHostJobById(agent, id) {
  let host;
  try { host = require('../../../tools/host-fallback'); } catch { return null; }
  try {
    const listed = host.listJobs ? host.listJobs({}) : { jobs: [] };
    const raw = listed.jobs || [];
    const hit = raw.find((j) => j.id === id && (!agent || j.who === agent || j.agent === agent));
    if (!hit) return null;
    let card = null;
    if (hit.file && fs.existsSync(hit.file)) {
      try { card = JSON.parse(fs.readFileSync(hit.file, 'utf8')); } catch { /* ignore */ }
    }
    const status = card?.stopUnconfirmed ? 'stop_unconfirmed' : (card && card.status) || hit.status || null;
    const updatedAt = (card && (card.updatedAt || card.finishedAt || card.endedAt || card.startedAt || card.createdAt))
      || hit.startedAt || null;
    let preview = null;
    if (card) {
      const excerpt = card.resultPreview || card.result_preview || card.reply_preview
        || (typeof card.result === 'string' ? card.result.slice(0, 500) : null)
        || (typeof card.note === 'string' && /done|fail|result/i.test(card.status || '') ? card.note.slice(0, 400) : null);
      if (excerpt) {
        preview = { available: true, preview: String(excerpt).slice(0, 600), path: hit.file || null };
      } else if (hit.file) {
        preview = { available: false, reason: 'host card has no result text', path: hit.file };
      }
    }
    return {
      source: 'host-fallback',
      status,
      updatedAt,
      job: {
        id: hit.id,
        agent: hit.who || agent,
        status,
        work: hit.work || (card && (card.workName || card.work)) || null,
        startedAt: (card && (card.startedAt || card.createdAt)) || null,
        finishedAt: (card && (card.finishedAt || card.endedAt)) || null,
        task_preview: card ? String(card.task || '').slice(0, 160) : null,
        preview,
        from: 'host-fallback',
        provenance: require('../../../common/provenance').forJob(card || {}, agent),
      },
      preview,
    };
  } catch { return null; }
}

function findLiveJobById(agent, id) {
  try {
    const live = getJob(agent, id);
    if (!live || live.error) return null;
    const status = live.status || (live.card && live.card.status) || null;
    const updatedAt = live.finishedAt || live.startedAt
      || (live.card && (live.card.finishedAt || live.card.updatedAt || live.card.startedAt)) || null;
    const preview = live.preview || null;
    return { source: 'live', status, updatedAt, job: live, preview };
  } catch { return null; }
}

/**
 * Unified job resolver (DISCUSSION-hour1 H1).
 * preferredSource: 'host-fallback' | 'live' | null (from intent.channel).
 */
function findJobStatus(agent, id, preferredSource) {
  if (!agent || !id) return null;
  const preferHost = preferredSource === 'host-fallback';
  const preferLive = preferredSource === 'live' || preferredSource === 'team-store';
  const tryHost = () => findHostJobById(agent, id);
  const tryLive = () => findLiveJobById(agent, id);
  if (preferHost) {
    return tryHost() || tryLive() || null;
  }
  if (preferLive) {
    return tryLive() || tryHost() || null;
  }
  // No channel: live first, then host; flag ambiguity if both differ
  const live = tryLive();
  const host = tryHost();
  if (live && host && live.status && host.status && live.status !== host.status) {
    return { ...live, ambiguous: true, otherSource: host.source, otherStatus: host.status };
  }
  return live || host || null;
}

const TERMINAL_DONE = new Set(['done', 'applied', 'completed', 'success']);
const TERMINAL_FAIL = new Set(['failed', 'error', 'dead']);
const TERMINAL_CANCEL = new Set(['cancelled', 'canceled', 'stopped']);
const RUNNING = new Set(['running', 'active', 'working', 'in_progress']);
const QUEUED = new Set(['queued', 'pending', 'scheduled', 'waiting']);

function deriveStatus(rec, jobInfo) {
  if (jobInfo && jobInfo.status) {
    const s = String(jobInfo.status);
    if (TERMINAL_DONE.has(s)) return 'done';
    if (TERMINAL_FAIL.has(s)) return 'failed';
    if (TERMINAL_CANCEL.has(s)) return 'cancelled';
    if (RUNNING.has(s)) return 'running';
    if (QUEUED.has(s)) return 'queued';
    return s;
  }
  if (rec.dispatchStatus === 'intent_only' || rec.needsToken) return 'waiting_token';
  if (rec.dispatchStatus === 'host_error') return 'host_error';
  if (rec.status === 'enqueued' && !rec.jobId) return 'enqueued_no_job';
  if (rec.status === 'enqueued' && rec.jobId) return 'job_missing';
  return null;
}

function buildProvenResult(jobInfo) {
  if (!jobInfo) return null;
  const prev = jobInfo.preview || (jobInfo.job && jobInfo.job.preview) || null;
  if (!prev) return null;
  if (prev.available === false) return null;
  const text = prev.preview || prev.text || prev.excerpt || null;
  if (!text && !prev.path) return null;
  return {
    kind: 'proven',
    available: true,
    source: jobInfo.source || null,
    path: prev.path || prev.file || null,
    excerpt: text ? String(text).slice(0, 600) : null,
    verdict: prev.verdict || null,
    note: 'Результат привязан к job (проверяемая связь)',
  };
}

function listUnconfirmedMaterials(work, enqueuedAt) {
  if (!work) return [];
  try {
    const listed = listWorkDrafts(work, { limit: 40 });
    const drafts = (listed && listed.drafts) || [];
    const after = enqueuedAt ? Date.parse(enqueuedAt) : 0;
    const skipKind = /^(briefs|briefs-|docs)$/i;
    const skipName = /^(DISCUSSION|JUDGE|SHARED)/i;
    return drafts
      .filter((d) => {
        if (skipKind.test(String(d.kind || ''))) return false;
        if (String(d.kind || '').startsWith('briefs')) return false;
        if (skipName.test(String(d.name || ''))) return false;
        if (after && d.mtime && Date.parse(d.mtime) < after) return false;
        return true;
      })
      .slice(0, 3)
      .map((d) => ({
        kind: 'unconfirmed_material',
        name: d.name,
        path: d.path,
        mtime: d.mtime,
        first_line: d.first_line || null,
        note: 'Материалы работы — связь с данным указанием не подтверждена',
      }));
  } catch {
    return [];
  }
}

/**
 * In-memory enrich only — NEVER writes intent SoT (DISCUSSION-hour1 H1/H2/H4).
 */
function enrichIntentWithJob(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  let preferred = null;
  if (rec.channel === 'host-fallback') preferred = 'host-fallback';
  else if (rec.channel && rec.channel !== 'intent-file+cli') preferred = 'live';

  let jobInfo = null;
  if (rec.jobId && rec.who) {
    jobInfo = findJobStatus(rec.who, rec.jobId, preferred);
  }

  out.provenance = require('../../../common/provenance').forJob(jobInfo?.job || {}, rec.who);
  out.provenance_label = require('../../../common/provenance').format(jobInfo?.job || {}, rec.who);
  out.jobStatus = jobInfo ? (jobInfo.status || null) : null;
  out.jobSource = jobInfo ? (jobInfo.source || null) : null;
  out.jobUpdatedAt = jobInfo ? (jobInfo.updatedAt || null) : null;
  out.jobAmbiguous = !!(jobInfo && jobInfo.ambiguous);
  out.derivedStatus = deriveStatus(rec, jobInfo);

  let workOwner = null;
  try {
    if (rec.work) {
      const card = readJsonSafe(path.join(repoRoot, 'works', rec.work + '.json'));
      if (card.ok) workOwner = card.value.owner || null;
    }
  } catch { /* ignore */ }
  const of = ownerFields(workOwner || rec.who || null, { kind: 'intent', agent: rec.who });
  out.owner = of.owner;
  out.owner_label = of.owner_label;

  const proven = buildProvenResult(jobInfo);
  const materials = (!proven && rec.work) ? listUnconfirmedMaterials(rec.work, rec.enqueuedAt) : [];

  if (proven) {
    out.result = proven;
    out.resultAvailable = true;
  } else if (materials.length) {
    out.result = {
      kind: 'unconfirmed',
      available: false,
      materials,
      hint: 'Связанный результат не найден; есть материалы работы без доказанной связи с указанием',
    };
    out.resultAvailable = false;
  } else {
    let hint = 'Результат ещё не сформирован';
    if (out.derivedStatus === 'waiting_token') hint = 'Most job ещё не поставлен — нужен token/CLI';
    else if (out.derivedStatus === 'running' || out.derivedStatus === 'queued') hint = 'Задача в процессе — результата пока нет';
    else if (out.derivedStatus === 'job_missing') hint = 'jobId указан, но карточка не найдена в live/host';
    else if (out.derivedStatus === 'done') hint = 'Job terminal, но текст результата недоступен';
    else if (!rec.jobId && rec.status === 'enqueued') hint = 'Нет jobId — назначение не дошло до most job';
    out.result = { kind: 'none', available: false, hint };
    out.resultAvailable = false;
  }
  return out;
}


/**
 * Read-only consilium artifacts for a work (DISCUSSION-hour4 C1).
 * Groups DISCUSSION/JUDGE files plus briefs and proposals dirs by suffix round.
 * Never writes. Caps count and excerpt size.
 */

/** Hour-12: human Russian label for a consilium round id */
function roundLabelRu(id) {
  const key = String(id || 'root').toLowerCase();
  if (key === 'root') return 'Основной';
  const hour = key.match(/^hour(\d+)$/i);
  if (hour) return 'Час ' + hour[1];
  const known = {
    write: 'Запись',
    remote: 'Удалённый доступ',
    tree: 'Дерево',
    pct: 'Проекты и чаты',
    gap: 'Пробел',
    scenarios: 'Сценарии',
    'why-worse': 'Почему хуже',
  };
  if (known[key]) return known[key];
  return key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function listWorkConsilium(workName, { limit = 80, excerptChars = 1200 } = {}) {
  if (!workName || !/^[a-z0-9-]{1,40}$/.test(workName)) {
    throw Object.assign(new Error('bad work name'), { status: 400 });
  }
  const base = path.join(repoRoot, 'works', workName);
  const baseResolved = path.resolve(base);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    return {
      work: workName,
      rounds: [],
      discussions: [],
      proposals: [],
      briefs: [],
      judges: [],
      total: 0,
      note: 'work directory missing',
    };
  }

  const underWork = (full) => {
    const resolved = path.resolve(full);
    return resolved === baseResolved || resolved.startsWith(baseResolved + path.sep);
  };

  const isBackup = (name) => /\.bak/i.test(name) || name.endsWith('~');

  const roundKeyFromName = (name) => {
    // DISCUSSION-hour3.md → hour3; JUDGE-write.md → write; DISCUSSION.md → root
    const m = String(name).match(/^(?:DISCUSSION|JUDGE)(?:-(.+))?\.md$/i);
    if (m) return m[1] ? m[1].toLowerCase() : 'root';
    return 'root';
  };

  const roundKeyFromDir = (dirName) => {
    // proposals-hour3 → hour3; briefs → root; proposals-write → write
    const m = String(dirName).match(/^(?:briefs|proposals)(?:-(.+))?$/i);
    if (m) return m[1] ? m[1].toLowerCase() : 'root';
    return dirName.toLowerCase();
  };

  const makeItem = (full, meta) => {
    if (!underWork(full)) return null;
    if (isBackup(meta.name)) return null;
    let st;
    try { st = fs.statSync(full); } catch (e) {
      return {
        ...meta,
        path: full,
        error: e.message,
        first_line: null,
        excerpt: null,
        truncated: false,
      };
    }
    if (!st.isFile()) return null;
    const prev = previewFileHead(full, excerptChars);
    return {
      ...meta,
      path: full,
      mtime: new Date(st.mtimeMs).toISOString(),
      size: st.size,
      first_line: prev.first_line || null,
      excerpt: prev.preview || null,
      truncated: !!prev.truncated,
      available: !!prev.available,
      ...(prev.available ? {} : { error: prev.reason || 'unreadable' }),
    };
  };

  const discussions = [];
  const judges = [];
  const proposals = [];
  const briefs = [];

  let names;
  try { names = fs.readdirSync(base); } catch (e) {
    return {
      work: workName,
      rounds: [],
      discussions: [],
      proposals: [],
      briefs: [],
      judges: [],
      total: 0,
      error: e.message,
    };
  }

  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (isBackup(name)) continue;
    const full = path.join(base, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile()) {
      if (/^DISCUSSION.*\.md$/i.test(name)) {
        const item = makeItem(full, {
          work: workName,
          kind: 'discussion',
          name,
          dir: '.',
          round: roundKeyFromName(name),
        });
        if (item) discussions.push(item);
      } else if (/^JUDGE.*\.md$/i.test(name)) {
        const item = makeItem(full, {
          work: workName,
          kind: 'judge',
          name,
          dir: '.',
          round: roundKeyFromName(name),
        });
        if (item) judges.push(item);
      }
      continue;
    }
    if (!st.isDirectory()) continue;
    const isBriefs = /^briefs/i.test(name);
    const isProps = /^proposals/i.test(name);
    if (!isBriefs && !isProps) continue;
    const round = roundKeyFromDir(name);
    const files = listDirFiles(full, ['.md', '.txt']);
    for (const f of files) {
      if (isBackup(f.name)) continue;
      // skip runner/noise scripts disguised as md? keep md/txt only already
      if (/^_/.test(f.name)) continue;
      if (/\.(raw|err)\.txt$/i.test(f.name)) continue;
      if (/\.(exit|pid)$/i.test(f.name)) continue;
      const item = makeItem(f.full, {
        work: workName,
        kind: isBriefs ? 'brief' : 'proposal',
        name: f.name,
        dir: name,
        round,
      });
      if (!item) continue;
      if (isBriefs) briefs.push(item);
      else proposals.push(item);
    }
  }

  const byMtime = (a, b) => Date.parse(b.mtime || 0) - Date.parse(a.mtime || 0);
  discussions.sort(byMtime);
  judges.sort(byMtime);
  proposals.sort(byMtime);
  briefs.sort(byMtime);

  const roundMap = new Map();
  const ensure = (key) => {
    if (!roundMap.has(key)) {
      roundMap.set(key, {
        id: key,
        label: key === 'root' ? 'root / init' : key,
        discussions: [],
        judges: [],
        proposals: [],
        briefs: [],
        latest_mtime: null,
      });
    }
    return roundMap.get(key);
  };

  for (const d of discussions) {
    const r = ensure(d.round || 'root');
    r.discussions.push(d);
    if (!r.latest_mtime || Date.parse(d.mtime) > Date.parse(r.latest_mtime)) r.latest_mtime = d.mtime;
  }
  for (const j of judges) {
    const r = ensure(j.round || 'root');
    r.judges.push(j);
    if (!r.latest_mtime || Date.parse(j.mtime) > Date.parse(r.latest_mtime)) r.latest_mtime = j.mtime;
  }
  for (const p of proposals) {
    const r = ensure(p.round || 'root');
    r.proposals.push(p);
    if (!r.latest_mtime || Date.parse(p.mtime) > Date.parse(r.latest_mtime)) r.latest_mtime = p.mtime;
  }
  for (const b of briefs) {
    const r = ensure(b.round || 'root');
    r.briefs.push(b);
    if (!r.latest_mtime || Date.parse(b.mtime) > Date.parse(r.latest_mtime)) r.latest_mtime = b.mtime;
  }

  const rounds = Array.from(roundMap.values()).sort(
    (a, b) => Date.parse(b.latest_mtime || 0) - Date.parse(a.latest_mtime || 0)
  );

  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const trimList = (arr) => arr.slice(0, lim);

  return {
    work: workName,
    rounds,
    discussions: trimList(discussions),
    proposals: trimList(proposals),
    briefs: trimList(briefs),
    judges: trimList(judges),
    total: discussions.length + proposals.length + briefs.length + judges.length,
    note: 'read-only consilium strip; Agent done ≠ judge accept; excerpts are quotes not auto-status',
  };
}


﻿/**
 * Unified multi-task board feed (Hour-6 A+B+C + Hour-7 F filter).
 * Cap 7. Active-only works; closed/принят/100% excluded while actives exist.
 * Group chats: none on disk — meta.group_chats.
 */
function isWorkClosedForBoard(w) {
  if (!w || w.error) return true;
  if (w.closed) return true;
  if (typeof w.percent === 'number' && w.percent >= 100) return true;
  if (w.stages_total > 0 && !w.current_stage) return true;
  return false;
}

function getBoard({ limit = 7 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 7, 1), 7);
  const items = [];
  const errors = [];
  let closedWorksSkipped = 0;

  try {
    for (const w of getWorks()) {
      if (w.error) continue;
      if (isWorkClosedForBoard(w)) {
        closedWorksSkipped += 1;
        continue; // Hour-7 F1: never candidate while we prefer live; empty handled below
      }
      items.push({
        id: 'work:' + w.name,
        kind: 'work',
        title: w.title || w.name,
        owner: w.owner,
        owner_label: w.owner_label || formatOwnerLabel(w.owner, { kind: 'work' }),
        status: w.current_stage ? w.current_stage.state : 'open',
        status_label: w.current_stage
          ? ('этап: ' + (w.current_stage.title || w.current_stage.state))
          : (w.percent + '%'),
        updated_at: w.updated_at || w.heartbeat_at || null,
        work: w.name,
        href: { type: 'work', name: w.name },
      });
    }
  } catch (e) {
    errors.push({ source: 'works', error: e.message });
  }

  try {
    const intents = require('./intents');
    const listed = intents.listIntents({ limit: 40 });
    for (const it of listed.intents || []) {
      if (!['draft', 'confirmed', 'enqueued'].includes(it.status)) continue;
      let full = it;
      try { full = intents.readIntent(it.work, it.id); } catch { /* */ }
      const en = enrichIntentWithJob(full);
      const titleSrc = en.text || en.body || en.prompt || ('указание ' + en.id);
      const status_label = en.dispatchStatus === 'intent_only'
        ? 'сохранено · не у исполнителя'
        : ({
            draft: 'черновик',
            confirmed: 'подтверждено',
            enqueued: 'в очереди',
          }[en.status] || en.status || '—');
      items.push({
        id: 'intent:' + en.id,
        kind: 'intent',
        title: String(titleSrc).replace(/\s+/g, ' ').slice(0, 80),
        owner: en.owner,
        owner_label: en.owner_label || formatOwnerLabel(en.who, { kind: 'intent', agent: en.who }),
        status: en.status,
        status_label,
        updated_at: en.updatedAt || en.confirmedAt || en.enqueuedAt || en.createdAt || null,
        work: en.work,
        who: en.who,
        href: { type: 'intent', work: en.work, id: en.id },
      });
    }
  } catch (e) {
    errors.push({ source: 'intents', error: e.message });
  }

  try {
    const active = new Set(['running', 'queued', 'waiting_quota', 'delivery_unclear', 'cancelling', 'cancel_requested', 'stop_unconfirmed']);
    const jobs = getJobs({ limit: 80, includeArchive: false });
    for (const j of jobs.jobs || []) {
      if (!active.has(j.status)) continue;
      items.push({
        id: 'job:' + j.agent + ':' + j.id,
        kind: 'job',
        title: (j.task_preview || ('job ' + j.id)).slice(0, 80),
        owner: j.owner,
        owner_label: j.owner_label || formatOwnerLabel(j.agent, { kind: 'job', agent: j.agent }),
        status: j.status,
        status_label: j.status_label || j.status,
        updated_at: j.finishedAt || j.startedAt || null,
        work: (j.work && (j.work.name || j.work)) || null,
        who: j.agent,
        href: { type: 'job', agent: j.agent, id: j.id },
      });
    }
  } catch (e) {
    errors.push({ source: 'jobs', error: e.message });
  }

  items.sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });

  // Hour-7 F3: one representative per work key — prefer job > intent > open work.
  // No "reserve 4 works" pass (that crowded out live intents).
  const kindRank = { job: 0, intent: 1, work: 2 };
  const byWork = new Map();
  const orphans = [];
  for (const it of items) {
    const key = it.work ? String(it.work) : null;
    if (!key) {
      orphans.push(it);
      continue;
    }
    const prev = byWork.get(key);
    if (!prev) {
      byWork.set(key, it);
      continue;
    }
    const pr = kindRank[prev.kind] ?? 9;
    const ir = kindRank[it.kind] ?? 9;
    if (ir < pr) byWork.set(key, it);
    else if (ir === pr) {
      const tp = Date.parse(prev.updated_at || '') || 0;
      const ti = Date.parse(it.updated_at || '') || 0;
      if (ti > tp) byWork.set(key, it);
    }
  }
  const reps = [...byWork.values(), ...orphans];
  reps.sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });
  const sliced = reps.slice(0, lim);

  return {
    ok: errors.length === 0,
    limit: lim,
    total_candidates: items.length,
    returned: sliced.length,
    items: sliced,
    meta: {
      group_chats: 'не найдены на диске (N/A)',
      sources: ['works/*.json', 'works/*/\_handoff/intents', 'state/jobs|codex-jobs|grok-jobs'],
      ownership_rule: 'work.owner → agent who → «не указан»; PID/instance ≠ человек',
      filter: 'active-only (Hour-7 F); closed/принят/100% works excluded',
      closed_works_skipped: closedWorksSkipped,
      incomplete: errors.length ? true : false,
      errors,
    },
  };
}



/* ===== PCT: Projects → Chats → Thread (DISCUSSION-pct) ===== */

const AGENT_TITLE_RU = {
  grok: 'Грок',
  codex: 'Кодекс',
  antigravity: 'Антигравити',
  claude: 'Клод',
};

function agentTitleRu(who) {
  const k = String(who || '').toLowerCase();
  return AGENT_TITLE_RU[k] || (who ? String(who) : 'помощник');
}

function projectStatusRu(w) {
  if (!w) return 'ждёт';
  if (w.closed) return 'готово';
  if (typeof w.percent === 'number' && w.percent >= 100) return 'готово';
  const st = w.current_stage && w.current_stage.state;
  if (st === 'принят') return 'готово';
  if (!w.current_stage && w.stages_total > 0 && w.stages_done === w.stages_total) return 'готово';
  if (st === 'идёт') return 'в работе';
  if (!w.current_stage) return 'ждёт';
  return 'в работе';
}

function intentStatusRu(en) {
  if (!en) return 'состояние неизвестно';
  const d = en.derivedStatus;
  if (d === 'cancel_requested' || d === 'cancelling') return 'отмена запрошена';
  if (d === 'stop_unconfirmed') return 'остановка не подтверждена';
  if (d === 'stop_confirmed') return 'остановка подтверждена';
  if (d === 'cancelled') return 'отменено локально';
  if (d === 'waiting_token') return 'сохранено, ждёт передачи помощнику';
  if (d === 'running' || d === 'queued') return 'помощник работает';
  if (d === 'waiting_quota') return 'помощник ждёт доступ';
  if (d === 'done') return 'ответ получен';
  if (d === 'failed') return 'не удалось выполнить';
  if (d === 'needs_decision') return 'нужно ваше решение';
  if (d === 'host_error') return 'не удалось передать помощнику';
  if (d === 'job_missing' || d === 'enqueued_no_job') return 'сохранено, исполнитель ещё не назначен';
  const s = en.status;
  if (s === 'draft') return 'черновик';
  if (s === 'confirmed') return 'подтверждено вами';
  if (s === 'enqueued') {
    if (en.dispatchStatus === 'intent_only') return 'сохранено, ожидает исполнителя';
    return 'передано в работу';
  }
  if (s === 'failed') return 'не удалось';
  return 'состояние уточняется';
}

function nextStepRu(en) {
  if (!en) return 'Откройте чат, чтобы продолжить.';
  const d = en.derivedStatus;
  const s = en.status;
  if (d === 'stop_unconfirmed' || d === 'cancel_requested' || d === 'cancelling') return 'Дальше: нужна проверка остановки удалённого исполнителя; поздний ответ не является голосом.';
  if (d === 'stop_confirmed' || d === 'cancelled') return 'Дальше: проверьте сохранённые результаты; остановка вложенных исполнителей отдельно не подтверждена.';
  if (s === 'draft') return 'Дальше: подтвердите сообщение, если текст верен.';
  if (s === 'confirmed') return 'Дальше: передайте сообщение помощнику.';
  if (d === 'waiting_token' || d === 'enqueued_no_job') {
    return 'Дальше: передача помощнику пока не завершена — при необходимости откройте «Нужен ключ подтверждения».';
  }
  if (d === 'running' || d === 'queued' || d === 'waiting_quota') {
    return 'Дальше: подождите — ответ появится в этой переписке.';
  }
  if (d === 'done' || (en.result && en.result.available)) {
    return 'Дальше: прочитайте ответ; при желании напишите следующее сообщение.';
  }
  if (d === 'failed' || s === 'failed') return 'Дальше: посмотрите, что помешало, и напишите новое поручение.';
  if (d === 'needs_decision') return 'Дальше: нужно ваше решение по ходу работы.';
  return 'Дальше: откройте переписку или напишите новое сообщение в проекте.';
}


function isCheckTask(task) {
  const t = String(task || '');
  if (/^SMOKE\b/i.test(t.trim()) || /SMOKE write-bridge/i.test(t)) return true;
  if (/Живой разговор Hour-\d+/i.test(t)) return true;
  if (/do not execute;\s*dashboard intent path check/i.test(t)) return true;
  if (/^Проверка записи/i.test(t.trim())) return true;
  if (/^Пробный разговор/i.test(t.trim())) return true;
  return false;
}

function formatWhenRu(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Nicosia',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((x) => x.type === t) || {}).value || '';
  const dayNum = parseInt(get('day'), 10);
  const monthIdx = parseInt(get('month'), 10) - 1;
  const hh = get('hour');
  const mm = get('minute');
  if (!dayNum || monthIdx < 0 || monthIdx > 11) return '';
  return dayNum + ' ' + MONTHS[monthIdx] + ', ' + hh + ':' + mm;
}

function humanCheckTitleRu(task, updatedAt) {
  const when = formatWhenRu(updatedAt);
  const t = String(task || '');
  if (/SMOKE write-bridge/i.test(t) || /^SMOKE\b/i.test(t.trim()) || /^Проверка записи/i.test(t.trim())) {
    return when ? ('Проверка записи · ' + when) : 'Проверка записи моста';
  }
  if (/Живой разговор Hour/i.test(t) || /^Пробный разговор/i.test(t.trim())) {
    return when ? ('Пробный разговор · ' + when) : 'Пробный разговор';
  }
  return null;
}

function chatTitleFromTask(task, updatedAt) {
  const human = humanCheckTitleRu(task, updatedAt);
  if (human) return human;
  const t = String(task || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Разговор без названия';
  if (t.length <= 72) return t;
  return t.slice(0, 69) + '…';
}

function listIntentsForWork(workName) {
  const intentsMod = require('./intents');
  try {
    const listed = intentsMod.listIntents({ work: workName, limit: 120 });
    return (listed.intents || []).map((it) => {
      try {
        const full = intentsMod.readIntent(it.work || workName, it.id);
        return enrichIntentWithJob(full);
      } catch {
        return enrichIntentWithJob(it);
      }
    });
  } catch {
    return [];
  }
}

function buildProvenResultFull(jobInfo) {
  const base = buildProvenResult(jobInfo);
  if (!base) return null;
  // Prefer longer excerpt for thread reading (Codex C1/C2)
  let full = base.excerpt;
  try {
    const prev = jobInfo.preview || (jobInfo.job && jobInfo.job.preview) || {};
    const longer = prev.preview || prev.text || prev.excerpt || null;
    if (longer) full = String(longer).slice(0, 12000);
    if ((!full || full.length < 200) && (prev.path || base.path)) {
      const p = prev.path || base.path;
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const raw = fs.readFileSync(p, 'utf8');
        full = String(raw).slice(0, 12000);
      }
    }
  } catch { /* keep excerpt */ }
  const truncated = full && full.length >= 12000;
  return {
    ...base,
    excerpt: full ? String(full).slice(0, 600) : base.excerpt,
    text: full || base.excerpt,
    truncated: !!truncated,
    note: truncated
      ? 'Показана часть ответа; полный текст длиннее и обрезан для экрана'
      : (base.note || 'Ответ связан с этим поручением'),
  };
}

function enrichIntentForChat(en) {
  const out = { ...en };
  if (en.jobId && en.who) {
    let preferred = null;
    if (en.channel === 'host-fallback') preferred = 'host-fallback';
    else if (en.channel && en.channel !== 'intent-file+cli') preferred = 'live';
    const jobInfo = findJobStatus(en.who, en.jobId, preferred);
    const full = buildProvenResultFull(jobInfo);
    if (full) {
      out.result = full;
      out.resultAvailable = true;
    }
  }
  return out;
}

function chatSummaryFromIntent(en) {
  const updated =
    (en.result && en.result.available && en.jobUpdatedAt) ||
    en.enqueuedAt ||
    en.confirmedAt ||
    en.createdAt ||
    null;
  const rawTask = en.task || en.task_preview || '';
  return {
    id: en.id,
    project: en.work,
    title: chatTitleFromTask(rawTask, updated),
    agent: en.who,
    agent_label: agentTitleRu(en.who),
    provenance: en.provenance || null,
    provenance_label: en.provenance_label || 'Происхождение ответа не сохранено',
    status_ru: intentStatusRu(en),
    next_step_ru: nextStepRu(en),
    owner_label: en.owner_label || formatOwnerLabel(en.who, { kind: 'intent', agent: en.who }),
    updated_at: updated,
    has_reply: !!(en.result && en.result.available),
    is_check: isCheckTask(rawTask),
    result_preview: en.result && en.result.available
      ? String(en.result.excerpt || en.result.text || '').slice(0, 180)
      : null,
  };
}

function getProjects({ limit = 80 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const works = getWorks().filter((w) => w && !w.error);
  const items = works.map((w) => {
    const titleRu = (w.title && String(w.title).trim()) || 'Проект без названия';
    const chats = listIntentsForWork(w.name);
    const openChats = chats.filter((c) => c.status === 'draft' || c.status === 'confirmed' || c.status === 'enqueued');
    const latest = chats
      .map((c) => c.enqueuedAt || c.confirmedAt || c.createdAt || null)
      .filter(Boolean)
      .sort()
      .reverse()[0] || w.updated_at || null;
    return {
      id: w.name,
      title: titleRu,
      status_ru: projectStatusRu(w),
      owner_label: w.owner_label || 'не указан',
      goal_preview: null,
      chats_total: chats.length,
      chats_active: openChats.length,
      updated_at: latest,
      closed: !!w.closed,
      percent: typeof w.percent === 'number' ? w.percent : null,
    };
  });
  // Active / non-closed first, then by updated_at
  items.sort((a, b) => {
    if (!!a.closed !== !!b.closed) return a.closed ? 1 : -1;
    const ta = Date.parse(a.updated_at || 0) || 0;
    const tb = Date.parse(b.updated_at || 0) || 0;
    return tb - ta;
  });
  return {
    projects: items.slice(0, lim),
    total: items.length,
    note: 'Проекты собраны из дел most; технические имена папок не являются заголовками',
  };
}

function getProjectDetail(name) {
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) {
    throw Object.assign(new Error('проект не найден'), { status: 400 });
  }
  let w;
  try {
    w = getWork(name);
  } catch (e) {
    throw Object.assign(new Error('проект не найден'), { status: e.status || 404 });
  }
  const titleRu = (w.title && String(w.title).trim()) || 'Проект без названия';
  const intents = listIntentsForWork(name).map(enrichIntentForChat);
  const chats = intents
    .map(chatSummaryFromIntent)
    .sort((a, b) => (Date.parse(b.updated_at || 0) || 0) - (Date.parse(a.updated_at || 0) || 0));

  let materials = [];
  let consilium_rounds = [];
  try {
    const cons = listWorkConsilium(name, { limit: 24, excerptChars: 400 });
    consilium_rounds = (cons.rounds || []).slice(0, 24).map((r) => {
      const disc = (r.discussions || [])[0] || null;
      const judge = (r.judges || [])[0] || null;
      return {
        id: r.id,
        title: roundLabelRu(r.id),
        label: r.label || r.id,
        excerpt: (disc && (disc.excerpt || disc.first_line)) || null,
        first_line: (disc && disc.first_line) || null,
        judge_excerpt: (judge && (judge.excerpt || judge.first_line)) || null,
        discussions_count: (r.discussions || []).length,
        judges_count: (r.judges || []).length,
        proposals_count: (r.proposals || []).length,
        updated_at: r.latest_mtime || null,
      };
    });
    materials = [];
  } catch { materials = []; consilium_rounds = []; }

  return {
    id: name,
    title: titleRu,
    status_ru: projectStatusRu({
      closed: false,
      percent: w.percent,
      current_stage: w.current_stage
        ? { state: (w.stages || []).find((s) => s.index === w.current_stage)?.state || 'идёт' }
        : null,
      stages_total: (w.stages || []).length,
      stages_done: (w.stages || []).filter((s) => s.state === 'принят').length,
    }),
    goal: w.goal || null,
    next_step: w.next_step || null,
    owner_label: formatOwnerLabel(w.owner, { kind: 'work' }),
    stages: (w.stages || []).map((s) => ({
      index: s.index,
      title: s.title,
      state_ru: s.state === 'принят' ? 'принят' : (s.state === 'идёт' ? 'идёт' : String(s.state || '—')),
    })),
    chats,
    consilium_rounds,
    materials,
    note: 'Чаты собраны из указаний этого проекта; ответ показывается только при подтверждённой связи',
  };
}

function getChatThread(projectId, chatId) {
  if (!projectId || !/^[a-z0-9-]{1,40}$/.test(projectId)) {
    throw Object.assign(new Error('проект не найден'), { status: 400 });
  }
  if (!chatId || !/^[a-zA-Z0-9_-]{1,80}$/.test(chatId)) {
    throw Object.assign(new Error('чат не найден'), { status: 400 });
  }
  const intentsMod = require('./intents');
  let rec;
  try {
    rec = intentsMod.readIntent(projectId, chatId);
  } catch (e) {
    throw Object.assign(new Error('чат не найден'), { status: e.status || 404 });
  }
  let en = enrichIntentWithJob(rec);
  en = enrichIntentForChat(en);

  const messages = [];
  messages.push({
    id: 'm-user-' + en.id,
    role: 'user',
    role_label: 'Вы',
    text: String(en.task || ''),
    at: en.createdAt || null,
  });

  if (en.result && en.result.available && (en.result.text || en.result.excerpt)) {
    messages.push({
      id: 'm-agent-' + en.id,
      role: 'assistant',
      role_label: agentTitleRu(en.who),
      text: String(en.result.text || en.result.excerpt || ''),
      at: en.jobUpdatedAt || en.enqueuedAt || null,
      truncated: !!en.result.truncated,
      note: en.result.note || null,
    });
  } else if (en.result && en.result.hint) {
    messages.push({
      id: 'm-system-' + en.id,
      role: 'system',
      role_label: 'Состояние',
      text: String(en.result.hint),
      at: en.enqueuedAt || en.confirmedAt || null,
    });
  }

  // Related: unconfirmed materials as project notes, not as assistant reply
  const related = [];
  if (en.result && en.result.materials && en.result.materials.length) {
    for (const m of en.result.materials.slice(0, 5)) {
      related.push({
        title: m.name || 'материал',
        reason: 'Материал проекта без доказанной связи с этим чатом',
        preview: m.first_line || null,
      });
    }
  }

  let projectTitle = projectId;
  try {
    const w = getWork(projectId);
    projectTitle = (w.title && String(w.title).trim()) || projectId;
  } catch { /* keep id */ }

  return {
    id: en.id,
    project: projectId,
    project_title: projectTitle,
    title: chatTitleFromTask(en.task, en.createdAt || en.enqueuedAt),
    agent: en.who,
    agent_label: agentTitleRu(en.who),
    provenance: en.provenance || null,
    provenance_label: en.provenance_label || 'Происхождение ответа не сохранено',
    status_ru: intentStatusRu(en),
    next_step_ru: nextStepRu(en),
    owner_label: en.owner_label || formatOwnerLabel(en.who, { kind: 'intent', agent: en.who }),
    messages,
    related,
    actions: {
      can_confirm: en.status === 'draft',
      can_enqueue: en.status === 'confirmed' || en.status === 'enqueued',
      needs_key: en.derivedStatus === 'waiting_token' || (!en.jobId && en.status === 'enqueued'),
      judge_note: 'Ответ помощника не означает, что итог принят вами',
    },
    // Internal fields for write-bridge buttons (not for raw display)
    _bridge: {
      work: en.work,
      id: en.id,
      status: en.status,
      fallbackConfirmId: en.fallbackConfirmId || null,
      cli_fallback: en.cli_fallback || null,
    },
  };
}


function getTree({ limit = 80 } = {}) {
  const projects = getProjects({ limit }).projects || [];
  const projectNodes = projects.map((p) => {
    let chats = [];
    let consiliumRounds = [];
    let goal = null;
    try {
      const detail = getProjectDetail(p.id);
      goal = detail.goal || null;
      chats = (detail.chats || []).map((c) => ({
        id: c.id,
        kind: 'chat',
        title: c.title || 'Разговор',
        status_ru: c.status_ru || '',
        agent_label: c.agent_label || '',
        updated_at: c.updated_at || null,
        has_reply: !!c.has_reply,
        is_check: !!c.is_check,
        children: c.has_reply
          ? [{ id: c.id + ':reply', kind: 'reply', title: 'Ответ помощника', parent_chat: c.id }]
          : [],
      }));
      consiliumRounds = (detail.consilium_rounds || []).slice(0, 24);
    } catch (e) {
      chats = [];
      consiliumRounds = [];
    }

    const human = [];
    const smoke = [];
    for (const c of chats) {
      const title = String(c.title || '');
      const isCheck = !!c.is_check
        || /^SMOKE\b/i.test(title.trim())
        || /SMOKE write-bridge/i.test(title)
        || /^Проверка записи/i.test(title.trim())
        || /^Пробный разговор/i.test(title.trim())
        || /Живой разговор Hour-\d+/i.test(title);
      if (isCheck) smoke.push(c);
      else human.push(c);
    }

    const children = [];
    if (human.length) {
      children.push({
        id: p.id + ':chats',
        kind: 'chats-folder',
        title: 'Разговоры',
        status_ru: String(human.length),
        children: human,
      });
    }
    if (smoke.length) {
      // Hour-14 A-lite: keep recent SMOKE at top level; nest older under «Ранее»
      // Hour-15 D-lite: under «Ранее» group by local day into Explorer day-folders
      const KEEP_RECENT_SMOKE = 6;
      const MONTHS_GEN_RU = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
      ];
      function dayKeyNicosia(iso) {
        const d = new Date(iso || '');
        if (Number.isNaN(d.getTime())) return 'unknown';
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Nicosia',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d);
        const get = (t) => (parts.find((x) => x.type === t) || {}).value || '00';
        return get('year') + '-' + get('month') + '-' + get('day');
      }
      function literaryDayRu(dayKey) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
        if (!m) return dayKey;
        const dayNum = parseInt(m[3], 10);
        const monthIdx = parseInt(m[2], 10) - 1;
        if (monthIdx < 0 || monthIdx > 11) return dayKey;
        return dayNum + ' ' + MONTHS_GEN_RU[monthIdx];
      }
      function groupEarlierByDay(earlierLeaves, earlierId) {
        const buckets = new Map();
        for (const leaf of earlierLeaves) {
          const key = dayKeyNicosia(leaf.updated_at || '');
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(leaf);
        }
        const keys = Array.from(buckets.keys()).sort((a, b) => b.localeCompare(a));
        return keys.map((key) => ({
          id: earlierId + ':day:' + key,
          kind: 'folder',
          title: literaryDayRu(key),
          label: literaryDayRu(key),
          status_ru: String(buckets.get(key).length),
          day_key: key,
          children: buckets.get(key),
        }));
      }
      const smokeSorted = smoke.slice().sort((a, b) => {
        const ta = Date.parse(a.updated_at || '') || 0;
        const tb = Date.parse(b.updated_at || '') || 0;
        return tb - ta;
      });
      let smokeChildren;
      if (smokeSorted.length > KEEP_RECENT_SMOKE) {
        const recent = smokeSorted.slice(0, KEEP_RECENT_SMOKE);
        const earlier = smokeSorted.slice(KEEP_RECENT_SMOKE);
        const earlierId = p.id + ':smoke:earlier';
        const dayFolders = groupEarlierByDay(earlier, earlierId);
        smokeChildren = recent.concat([
          {
            id: earlierId,
            kind: 'folder',
            title: 'Ранее',
            status_ru: String(earlier.length),
            children: dayFolders,
          },
        ]);
      } else {
        smokeChildren = smokeSorted;
      }
      children.push({
        id: p.id + ':smoke',
        kind: 'folder',
        title: 'Проверки моста',
        status_ru: String(smoke.length),
        children: smokeChildren,
      });
    }
    if (consiliumRounds.length) {
      const roundNodes = consiliumRounds.map((r) => ({
        id: p.id + ':consilium:' + r.id,
        kind: 'consilium-round',
        title: r.title || roundLabelRu(r.id),
        round_id: r.id,
        excerpt: r.excerpt || null,
        first_line: r.first_line || null,
        judge_excerpt: r.judge_excerpt || null,
        smoke_count: smoke.length,
        discussions_count: r.discussions_count || 0,
        judges_count: r.judges_count || 0,
        proposals_count: r.proposals_count || 0,
        updated_at: r.updated_at || null,
        children: [],
      }));
      children.push({
        id: p.id + ':consilium',
        kind: 'consilium-folder',
        title: 'Консилиум',
        status_ru: String(roundNodes.length),
        children: roundNodes,
      });
    }
    return {
      id: p.id,
      kind: 'project',
      title: p.title,
      status_ru: p.status_ru,
      owner_label: p.owner_label,
      updated_at: p.updated_at,
      chats_total: p.chats_total,
      chats_active: p.chats_active,
      closed: !!p.closed,
      goal,
      children,
    };
  });

  const active = [];
  const done = [];
  for (const n of projectNodes) {
    const st = String(n.status_ru || '');
    const isDone = !!n.closed || /заверш/i.test(st) || /закрыт/i.test(st) || /^готово$/i.test(String(st).trim());
    (isDone ? done : active).push(n);
  }

  // Hour-16 Q-lite: quarantine demo/probe projects under «Пробы»
  function isProtectedRealWork(n) {
    const id = String(n.id || '');
    const title = String(n.title || '');
    if (id === 'collegium-hub') return true;
    if (/коллегия[-\s]?хаб/i.test(title)) return true;
    if (/^team-v\d/i.test(id)) return true;
    if (/\bteam-v\d/i.test(title)) return true;
    return false;
  }
  function isProbeProject(n) {
    if (isProtectedRealWork(n)) return false;
    const id = String(n.id || '').toLowerCase();
    const title = String(n.title || '');
    const titleLc = title.toLowerCase();
    if (id === 'posadochnoe-delo-usable') return true;
    if (/^test-/.test(id)) return true;
    if (/-usable$/.test(id)) return true;
    if (/\busable\b/i.test(title)) return true;
    if (/posadochnoe/i.test(titleLc) || /посадоч/i.test(title)) return true;
    if (/тест\s*создан/i.test(title)) return true;
    if (/\bSMOKE\b/i.test(title) || /\bsmoke\b/i.test(titleLc)) return true;
    if (/^проба\b/i.test(title.trim()) || /\bпроба\b/i.test(title)) return true;
    if (/\btest\b/i.test(titleLc) && /создан/i.test(title)) return true;
    return false;
  }
  const probes = [];
  const activeReal = [];
  for (const n of active) {
    (isProbeProject(n) ? probes : activeReal).push(n);
  }
  let activeChildren = activeReal.slice();
  if (probes.length) {
    activeChildren.push({
      id: 'folder:probes',
      kind: 'folder',
      title: 'Пробы',
      status_ru: String(probes.length),
      children: probes,
    });
  }
  const activeCount = activeReal.length + probes.length;

  const nodes = [];
  if (activeCount) {
    nodes.push({
      id: 'rubric:active',
      kind: 'folder',
      title: 'В работе',
      status_ru: String(activeCount),
      children: activeChildren,
    });
  }
  if (done.length) {
    nodes.push({
      id: 'rubric:done',
      kind: 'folder',
      title: 'Завершённые',
      status_ru: String(done.length),
      children: done,
    });
  }

  return {
    root_label: 'Мои дела',
    nodes,
    total: projectNodes.length,
    note: 'Проводник: рубрика → дело → Разговоры → материалы',
  };
}


function slugifyTitle(title) {
  const map = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',
    о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  let s0 = String(title || '').toLowerCase().trim();
  let out = '';
  for (const ch of s0) {
    if (map[ch] !== undefined) out += map[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/[\s_]+/.test(ch) || ch === '-') out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  if (!out || out.length < 2) out = 'delo';
  return out;
}

function createProject({ title, goal } = {}) {
  const titleRu = String(title || '').replace(/\s+/g, ' ').trim();
  if (titleRu.length < 2) {
    throw Object.assign(new Error('нужно название дела (хотя бы 2 символа)'), { status: 400 });
  }
  if (titleRu.length > 120) {
    throw Object.assign(new Error('название слишком длинное'), { status: 400 });
  }
  const worksDir = path.join(repoRoot, 'works');
  let base = slugifyTitle(titleRu);
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(worksDir, name + '.json')) || fs.existsSync(path.join(worksDir, name))) {
    const suffix = '-' + n;
    name = (base.slice(0, Math.max(1, 40 - suffix.length)) + suffix).replace(/-+$/g, '');
    n += 1;
    if (n > 99) throw Object.assign(new Error('не удалось подобрать имя дела'), { status: 500 });
  }
  if (!/^[a-z0-9-]{1,40}$/.test(name)) {
    throw Object.assign(new Error('внутреннее имя дела недопустимо'), { status: 500 });
  }
  const folder = path.join(worksDir, name);
  const cardPath = path.join(worksDir, name + '.json');
  const now = new Date().toISOString();
  const goalText = String(goal || '').trim() || ('Кратко: ' + titleRu);
  const card = {
    name,
    revision: 1,
    title: titleRu,
    folder,
    goal: goalText,
    done_criteria: 'Дело можно считать готовым, когда пользователь отметит результат или закроет его.',
    next_step: 'Откройте дело в дереве и напишите первый разговор или комментарий.',
    owner: 'user',
    created_at: now,
    updated_at: now,
    heartbeat_at: now,
    closed: false,
    stages: [
      {
        title: 'В работе',
        weight: 100,
        accept_criteria: 'Есть понятный результат или решение закрыть дело.',
        state: 'идёт',
        closes: 'Первый этап дела',
        id: 'stage-main',
        gate: { files: [], reasons: [] },
      },
    ],
    reminders: [],
    source: 'dashboard-usable-create',
  };
  fs.mkdirSync(path.join(folder, '_handoff', 'intents'), { recursive: true });
  const tmp = cardPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(card, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, cardPath);
  return {
    id: name,
    name,
    title: titleRu,
    status_ru: 'в работе',
    owner_label: formatOwnerLabel('user', { kind: 'work' }),
    goal: goalText,
    created: true,
  };
}


module.exports = {
  health,
  getBoard,
  formatOwnerLabel,
  getReady,
  getQuotas,
  getWorks,
  getWork,
  getJobs,
  getJob,
  getHostJobs,
  findJobStatus,
  findHostJobById,
  enrichIntentWithJob,
  getFeed,
  getFallbackStatus,
  listAllDrafts,
  listWorkDrafts,
  getDraftPreview,
  listWorkConsilium,
  roundLabelRu,
  getProjects,
  getProjectDetail,
  getChatThread,
  getTree,
  agentTitleRu,
  createProject,
  isCheckTask,
  humanCheckTitleRu,
  formatWhenRu,
  intentStatusRu,
  nextStepRu,
  PREVIEW_LINES,
};
