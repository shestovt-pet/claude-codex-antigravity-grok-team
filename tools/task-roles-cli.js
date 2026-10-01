'use strict';
// CLI for per-task roles. Human confirm tokens only when MOST_FALLBACK_HUMAN=1.
const path = require('path');
const fs = require('fs');

function resolveRepo() {
  if (process.env.MOST_REPO_ROOT) return process.env.MOST_REPO_ROOT;
  // scripts/roles.cmd -> tools/ -> repo root
  return path.resolve(__dirname, '..');
}

function loadRoles(repo) {
  const candidates = [
    path.join(repo, 'common', 'task-roles.js'),
    path.join(repo, '.work', '_grok_flexible_roles', 'impl', 'common', 'task-roles.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  throw new Error('task-roles.js not found');
}

function loadConfirm(repo) {
  const p = path.join(repo, 'common', 'user-confirm.js');
  if (fs.existsSync(p)) return require(p);
  return null;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function main() {
  const repo = resolveRepo();
  const roles = loadRoles(repo);
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const work = argValue(argv, '--work');
  const kind = argValue(argv, '--kind') || 'code';
  const by = argValue(argv, '--by') || 'rules';
  const reason = argValue(argv, '--reason');
  const slotsRaw = argValue(argv, '--slots');
  const worksRoot = argValue(argv, '--works-root') || path.join(repo, 'works');
  const fallbackDir = argValue(argv, '--fallback-dir') || null;
  const confirmId = argValue(argv, '--confirm-id');
  const confirmToken = argValue(argv, '--confirm-token');
  const generation = argValue(argv, '--generation');
  const genNum = generation != null ? Number(generation) : undefined;

  const base = { repoRoot: repo, worksRoot, fallbackDir, work, kind, by, reason, generation: genNum };

  if (cmd === 'propose' || cmd === 'roles-propose') {
    if (slotsRaw) base.slots = slotsRaw;
    const rec = roles.propose(base);
    console.log(JSON.stringify({ ok: true, cmd: 'propose', roles: rec }, null, 2));
    return;
  }
  if (cmd === 'get' || cmd === 'roles-get') {
    console.log(JSON.stringify({ ok: true, cmd: 'get', ...roles.get(base) }, null, 2));
    return;
  }
  if (cmd === 'confirm-request' || cmd === 'roles-confirm-request') {
    const confirm = loadConfirm(repo);
    if (!confirm) throw new Error('user-confirm.js missing');
    if (!work) throw new Error('--work required');
    const cur = roles.get(base);
    if (!cur.roles || cur.roles.status !== 'proposed') {
      throw new Error('no proposed roles; run propose first');
    }
    // Ensure roles.confirm is allowed — caller may have patched ACTIONS
    const fb = fallbackDir || path.join(repo, 'state', 'fallback');
    const challenge = confirm.createChallenge(fb, {
      action: 'roles.confirm',
      generation: cur.roles.generation || 0,
      meta: { work, contentHash: cur.roles.contentHash },
      targetHash: cur.roles.contentHash,
    });
    console.log(JSON.stringify({
      ok: true,
      cmd: 'confirm-request',
      id: challenge.id,
      action: challenge.action,
      generation: challenge.generation,
      expiresAt: challenge.expiresAt,
      meta: challenge.meta,
      note: 'Reveal token via: roles.cmd confirm-reveal ' + challenge.id + ' (human only)',
    }, null, 2));
    return;
  }
  if (cmd === 'confirm-reveal') {
    if (process.env.MOST_FALLBACK_HUMAN !== '1') {
      throw new Error('confirm-reveal requires MOST_FALLBACK_HUMAN=1 (use scripts/roles.cmd)');
    }
    const confirm = loadConfirm(repo);
    const fb = fallbackDir || path.join(repo, 'state', 'fallback');
    const id = argv[1] || argValue(argv, '--id');
    console.log(JSON.stringify(confirm.revealToken(fb, id), null, 2));
    return;
  }
  if (cmd === 'confirm' || cmd === 'roles-confirm') {
    const confirm = loadConfirm(repo);
    if (!confirm) throw new Error('user-confirm.js missing');
    if (!work || !confirmId || !confirmToken) {
      throw new Error('confirm needs --work --confirm-id --confirm-token');
    }
    const fb = fallbackDir || path.join(repo, 'state', 'fallback');
    const cur = roles.get(base);
    if (!cur.roles || cur.roles.status !== 'proposed') {
      throw new Error('no proposed roles');
    }
    const used = confirm.consume(fb, {
      id: confirmId,
      token: confirmToken,
      action: 'roles.confirm',
      generation: cur.roles.generation || 0,
      meta: { work, contentHash: cur.roles.contentHash },
      targetHash: cur.roles.contentHash,
    });
    const rec = roles.confirm({
      ...base,
      confirmId: used.id,
      contentHash: cur.roles.contentHash,
      generation: cur.roles.generation,
    });
    console.log(JSON.stringify({ ok: true, cmd: 'confirm', roles: rec, confirm: { id: used.id } }, null, 2));
    return;
  }
  if (cmd === 'clear' || cmd === 'roles-clear') {
    // clear also requires confirm in production; smoke may pass --force-test
    if (argv.includes('--force-test')) {
      if (process.env.MOST_ROLES_TEST !== '1') {
        throw new Error('clear --force-test requires MOST_ROLES_TEST=1 (tests only)');
      }
      console.log(JSON.stringify({ ok: true, cmd: 'clear', roles: roles.clear(base) }, null, 2));
      return;
    }
    const confirm = loadConfirm(repo);
    const fb = fallbackDir || path.join(repo, 'state', 'fallback');
    if (!confirmId || !confirmToken) throw new Error('clear needs confirm or --force-test');
    const cur = roles.get(base);
    const used = confirm.consume(fb, {
      id: confirmId,
      token: confirmToken,
      action: 'roles.clear',
      generation: (cur.roles && cur.roles.generation) || 0,
      meta: { work },
    });
    const rec = roles.clear({ ...base, reason: 'user-clear' });
    console.log(JSON.stringify({ ok: true, cmd: 'clear', roles: rec, confirm: { id: used.id } }, null, 2));
    return;
  }
  if (cmd === 'help' || cmd === '--help') {
    console.log(JSON.stringify({
      commands: [
        'propose --work NAME [--kind code|review|design|ops|fallback] [--slots JSON] [--by rules|grok|…]',
        'get --work NAME',
        'confirm-request --work NAME',
        'confirm-reveal ID',
        'confirm --work NAME --confirm-id ID --confirm-token TOKEN',
        'clear --work NAME --confirm-id ID --confirm-token TOKEN',
      ],
    }, null, 2));
    return;
  }
  throw new Error('unknown command: ' + cmd);
}

try {
  main();
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message, errors: e.errors || null }));
  process.exit(1);
}
