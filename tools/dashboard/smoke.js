'use strict';
/**
 * Smoke: GET read paths + POST intent draft→confirm→enqueue (collegium-hub only).
 * Does not touch other works. Leaves one smoke intent file under _handoff/intents/.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.MOST_DASH_PORT || 3847);
const HOST = '127.0.0.1';

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const raw = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method,
      timeout: 20000,
      headers: raw
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
        : {},
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
}


/** Hour-3 L2: programmatic bind allowlist checks (no phone required). */
function runBindProbe(host, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      env: { ...process.env, MOST_DASH_PORT: String(port), MOST_DASH_HOST: host },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve(result);
    };
    child.stdout.on('data', (d) => { out += String(d); if (/MOST dashboard/.test(out)) finish({ code: 0, out, err, booted: true }); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('exit', (code) => finish({ code: code == null ? 1 : code, out, err, booted: /MOST dashboard/.test(out) }));
    setTimeout(() => finish({ code: child.exitCode == null ? -1 : child.exitCode, out, err, booted: /MOST dashboard/.test(out), timeout: true }), 8000);
  });
}

async function smokeLanBind() {
  const wan = await runBindProbe('8.8.8.8', PORT + 17);
  if (wan.booted) throw new Error('L2: WAN host 8.8.8.8 must not boot');
  if (wan.code === 0) throw new Error('L2: WAN host 8.8.8.8 must exit non-zero');
  if (!/Refusing to bind/i.test(wan.err + wan.out)) throw new Error('L2: WAN refuse message missing');

  const lanPort = PORT + 19;
  const lan = await runBindProbe('0.0.0.0', lanPort);
  if (!lan.booted) throw new Error('L2: MOST_DASH_HOST=0.0.0.0 must boot; got code=' + lan.code + ' err=' + (lan.err || '').slice(0, 200));
  if (!/ВНИМАНИЕ|NO AUTH|не пробрасывать|WAN/i.test(lan.err + lan.out)) {
    throw new Error('L2: loud LAN warning missing in console output');
  }
  console.log('L2 bind probes OK (refuse 8.8.8.8; allow 0.0.0.0 + warn)');
}


// === PCT home assert (DISCUSSION-pct A1/D1) ===
async function smokeScenariosHtml() {
  const r = await req('GET', '/');
  if (r.status !== 200) throw new Error('GET / failed ' + r.status);
  const html = r.body;
  const need = [
    'id="treeToggle"',
    'Каталог',
    'id="explorerTree"',
    'id="treePane"',
    'id="contentPane"',
    'id="pane-welcome"',
    'id="pane-project"',
    'id="pane-chat"',
    'id="thread"',
    'Мои дела',
    'btn-primary',
  ];
  for (const s of need) {
    if (!html.includes(s)) throw new Error('TREE HTML missing: ' + s);
  }
  if (/id="projectsGrid"|id="multiTaskBoard"|data-tab="directives"|id="mainTabs"/.test(html)) {
    throw new Error('TREE HTML still looks like card-grid/ops board home');
  }
  if (/\b(enqueued|confirmId|waiting_quota)\b/.test(html)) {
    throw new Error('TREE HTML leaks technical enums on page shell');
  }
  console.log('TREE HTML explorer tree/pane: OK');
}

async function smokeTreeApi() {
  const r = await req('GET', '/api/tree');
  if (r.status !== 200) throw new Error('GET /api/tree ' + r.status);
  const j = JSON.parse(r.body);
  if (!j.root_label || !Array.isArray(j.nodes)) throw new Error('tree shape bad');
  function findId(nodes, id) {
    for (const n of nodes || []) {
      if (n.id === id) return n;
      const hit = findId(n.children, id);
      if (hit) return hit;
    }
    return null;
  }
  const rubrics = (j.nodes || []).filter((n) => n.kind === 'folder' && /^rubric:/.test(n.id));
  if (rubrics.length < 1) throw new Error('HOUR9 rubric folders missing at root');
  const titles = rubrics.map((n) => n.title).join('|');
  if (!/В работе/.test(titles) && !/Завершённые/.test(titles)) {
    throw new Error('HOUR9 rubric titles missing: ' + titles);
  }
  const hub = findId(j.nodes, 'collegium-hub');
  if (!hub) throw new Error('collegium-hub missing in tree');
  if (!Array.isArray(hub.children)) throw new Error('hub.children missing');
  const smokeFolder = (hub.children || []).find((c) => c.id === 'collegium-hub:smoke' || (c.kind === 'folder' && /Проверки моста/.test(c.title || '')));
  if (!smokeFolder) throw new Error('HOUR9 smoke folder missing under hub');
  console.log('TREE API OK rootFolders=' + j.nodes.length + ' rubrics=' + rubrics.length + ' hubChildren=' + hub.children.length + ' smokeKids=' + (smokeFolder.children || []).length);
  // Hour-10 Q+E-lite: live chats folder + cascade to thread
  const liveDraft = await req('POST', '/api/intents', {
    work: 'collegium-hub',
    who: 'grok',
    task: 'Кратко опишите, что видно в дереве дел справа от рубрик — обычный рабочий разговор.',
  });
  if (liveDraft.status !== 201) throw new Error('HOUR10 live draft failed ' + liveDraft.status);
  const liveId = JSON.parse(liveDraft.body).intent.id;
  const tree2 = JSON.parse((await req('GET', '/api/tree')).body);
  function findId2(nodes, id) {
    for (const n of nodes || []) {
      if (n.id === id) return n;
      const hit = findId2(n.children, id);
      if (hit) return hit;
    }
    return null;
  }
  const hub2 = findId2(tree2.nodes, 'collegium-hub');
  if (!hub2) throw new Error('HOUR10 hub missing after live draft');
  const chatsFolder = (hub2.children || []).find((c) => c.kind === 'chats-folder' || c.id === 'collegium-hub:chats' || /Разговоры/.test(c.title || ''));
  if (!chatsFolder) throw new Error('HOUR10 chats-folder Разговоры missing');
  const liveNode = (chatsFolder.children || []).find((c) => c.id === liveId);
  if (!liveNode) throw new Error('HOUR10 live chat not under Разговоры');
  if (liveNode.kind !== 'chat') throw new Error('HOUR10 live node kind not chat');
  const smokeStill = (hub2.children || []).find((c) => c.id === 'collegium-hub:smoke' || /Проверки моста/.test(c.title || ''));
  if (!smokeStill) throw new Error('HOUR10 smoke folder missing after live');
  if ((smokeStill.children || []).some((c) => c.id === liveId)) {
    throw new Error('HOUR10 live chat wrongly under Проверки моста');
  }
  const thLive = await req('GET', '/api/projects/collegium-hub/chats/' + encodeURIComponent(liveId));
  if (thLive.status !== 200) throw new Error('HOUR10 live thread ' + thLive.status);
  const thj = JSON.parse(thLive.body);
  if (!Array.isArray(thj.messages) || !thj.messages.length) throw new Error('HOUR10 live thread empty');
  console.log('HOUR10 E2E OK live=' + liveId + ' chatsKids=' + (chatsFolder.children || []).length + ' smokeKids=' + (smokeStill.children || []).length);

}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, MOST_DASH_PORT: String(PORT), MOST_DASH_HOST: HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let booted = false;
  child.stdout.on('data', (d) => {
    const s = String(d);
    process.stdout.write('[server] ' + s);
    if (/MOST dashboard/.test(s)) booted = true;
  });
  child.stderr.on('data', (d) => process.stderr.write('[server.err] ' + d));

  const deadline = Date.now() + 15000;
  while (!booted && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!booted) await new Promise((r) => setTimeout(r, 500));

  let smokeId = null;
  try {
    await smokeLanBind();
    await smokeScenariosHtml();
    await smokeTreeApi();
    const gets = [
      '/api/health',
      '/api/ready',
      '/api/works',
      '/api/works/collegium-hub',
      '/api/drafts?work=collegium-hub',
      '/api/consilium?work=collegium-hub',
      '/api/intents?work=collegium-hub',
      '/api/jobs?source=host',
      '/',
    ];
    for (const pathName of gets) {
      const r = await req('GET', pathName);
      console.log('GET', pathName, r.status, r.body.slice(0, 100).replace(/\s+/g, ' '));
      if (r.status !== 200) throw new Error(pathName + ' failed: ' + r.status);
    }
    const health = JSON.parse((await req('GET', '/api/health')).body);
    // Hour-4 C4: consilium strip read-only
    const consiliumRes = await req('GET', '/api/consilium?work=collegium-hub');
    if (consiliumRes.status !== 200) throw new Error('consilium status ' + consiliumRes.status);
    const consilium = JSON.parse(consiliumRes.body);
    if (!consilium.work || consilium.work !== 'collegium-hub') throw new Error('consilium work mismatch');
    if (!Array.isArray(consilium.rounds) || consilium.rounds.length < 1) throw new Error('consilium rounds empty');
    if (!Array.isArray(consilium.discussions) || consilium.discussions.length < 1) throw new Error('consilium discussions empty');
    if (!Array.isArray(consilium.proposals) || consilium.proposals.length < 1) throw new Error('consilium proposals empty');
    console.log('GET /api/consilium OK rounds=' + consilium.rounds.length + ' total=' + consilium.total);
    if (!health.banner_ru && !(health.fallback && health.fallback.banner_ru)) {
      throw new Error('health missing banner');
    }
    if (health.write_bridge !== 'intents') throw new Error('health.write_bridge missing');
    // Hour-5 honesty: channels + never absolute panic while bridge ok
    if (!health.channels || !health.channels.write_bridge || health.channels.write_bridge.ok !== true) {
      throw new Error('health.channels.write_bridge missing/false');
    }
    if (!health.channels.desktop_mcp || typeof health.channels.desktop_mcp.ok !== 'boolean') {
      throw new Error('health.channels.desktop_mcp missing');
    }
    const br = String(health.banner_ru || '');
    const panic = /^(?:ИИ не подключены|Все AI мертвы|Все ИИ отключены)/i.test(br.trim());
    if (panic && health.write_bridge === 'intents') {
      throw new Error('banner absolute panic while write_bridge alive: ' + br.slice(0, 160));
    }
    if (health.write_bridge === 'intents' && !(health.desktopAlive && health.mcpAlive)) {
      if (!/Мост указаний активен/i.test(br)) {
        throw new Error('banner should state bridge is active when Desktop/MCP down: ' + br.slice(0, 160));
      }
    }
    console.log('Hour-5 honesty: channels OK bridge=' + health.channels.write_bridge.kind
      + ' desktop_mcp=' + health.channels.desktop_mcp.ok
      + ' webhook_cfg=' + !!(health.channels.grok_webhook && health.channels.grok_webhook.configured));
    if (!health.network || health.network.host !== HOST || health.network.lan !== false) {
      throw new Error('health.network missing or unexpected for localhost: ' + JSON.stringify(health.network));
    }

    const draft = await req('POST', '/api/intents', {
      work: 'collegium-hub',
      who: 'grok',
      task: 'SMOKE write-bridge ' + new Date().toISOString() + ' — do not execute; dashboard intent path check',
    });
    console.log('POST draft', draft.status, draft.body.slice(0, 160).replace(/\s+/g, ' '));
    if (draft.status !== 201) throw new Error('draft failed: ' + draft.status + ' ' + draft.body);
    const draftJ = JSON.parse(draft.body);
    smokeId = draftJ.intent.id;
    if (draftJ.intent.status !== 'draft') throw new Error('expected draft');

    const conf = await req('POST', '/api/intents/collegium-hub/' + smokeId + '/confirm', {});
    console.log('POST confirm', conf.status, conf.body.slice(0, 160).replace(/\s+/g, ' '));
    if (conf.status !== 200) throw new Error('confirm failed');
    const confJ = JSON.parse(conf.body);
    if (confJ.intent.status !== 'confirmed') throw new Error('expected confirmed');

    const enq = await req('POST', '/api/intents/collegium-hub/' + smokeId + '/enqueue', {});
    console.log('POST enqueue', enq.status, enq.body.slice(0, 220).replace(/\s+/g, ' '));
    if (enq.status !== 200) throw new Error('enqueue failed: ' + enq.body);
    const enqJ = JSON.parse(enq.body);
    if (enqJ.intent.status !== 'enqueued') throw new Error('expected enqueued');
    const ds = enqJ.dispatchStatus || (enqJ.intent && enqJ.intent.dispatchStatus);
    if (!ds) throw new Error('dispatchStatus missing');
    console.log('dispatchStatus', ds);
    if (!Array.isArray(enqJ.cli_fallback) || !enqJ.cli_fallback.length) {
      throw new Error('cli_fallback missing');
    }

    const file = path.join('C:/most/works/collegium-hub/_handoff/intents', smokeId + '.json');
    if (!fs.existsSync(file)) throw new Error('intent file missing: ' + file);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (disk.status !== 'enqueued') throw new Error('disk status not enqueued');

    // Ensure we did not write into other works
    const worksRoot = 'C:/most/works';
    for (const name of fs.readdirSync(worksRoot)) {
      if (name === 'collegium-hub') continue;
      const alien = path.join(worksRoot, name, '_handoff', 'intents');
      if (fs.existsSync(alien)) {
        const smokeAliens = fs.readdirSync(alien).filter((n) => n.includes(smokeId));
        if (smokeAliens.length) throw new Error('smoke leaked into ' + name);
      }
    }

    const listed = JSON.parse((await req('GET', '/api/intents?work=collegium-hub')).body);
    if (!listed.intents.some((i) => i.id === smokeId)) throw new Error('intent not listed');
    const listedOne = listed.intents.find((i) => i.id === smokeId);
    for (const key of ['jobStatus', 'jobSource', 'jobUpdatedAt', 'derivedStatus', 'result']) {
      if (!(key in listedOne)) throw new Error('list enrich missing key: ' + key);
    }
    if (!listedOne.derivedStatus) throw new Error('derivedStatus empty on enqueued intent');
    if (!listedOne.result || !listedOne.result.kind) throw new Error('result.kind missing');

    const detail = JSON.parse((await req('GET', '/api/intents/collegium-hub/' + smokeId)).body);
    for (const key of ['jobStatus', 'jobSource', 'jobUpdatedAt', 'derivedStatus', 'result']) {
      if (!(key in detail)) throw new Error('detail enrich missing key: ' + key);
    }
    if (detail.derivedStatus !== listedOne.derivedStatus) {
      throw new Error('list/detail derivedStatus mismatch: ' + listedOne.derivedStatus + ' vs ' + detail.derivedStatus);
    }

    // H4: GET enrich must not mutate SoT mtime/content
    const before = fs.readFileSync(file);
    const mtimeBefore = fs.statSync(file).mtimeMs;
    await req('GET', '/api/intents?work=collegium-hub');
    await req('GET', '/api/intents/collegium-hub/' + smokeId);
    const after = fs.readFileSync(file);
    const mtimeAfter = fs.statSync(file).mtimeMs;
    if (!before.equals(after)) throw new Error('SoT intent mutated by GET enrich');
    if (mtimeAfter !== mtimeBefore) throw new Error('SoT intent mtime changed by GET enrich');

    const jobsAll = await req('GET', '/api/jobs?source=all');
    console.log('GET /api/jobs?source=all', jobsAll.status);
    if (jobsAll.status !== 200) throw new Error('jobs source=all failed');
    // TREE static UI + API (DISCUSSION-tree)
    {
      const cssRes = await req('GET', '/style.css');
      if (cssRes.status !== 200) throw new Error('style.css fetch failed');
      if (!/@media\s*\(max-width:\s*800px\)/.test(cssRes.body)) throw new Error('style.css missing 800px media');
      if (!/min-height:\s*44px/.test(cssRes.body)) throw new Error('style.css missing 44px touch targets');
      if (!/\.thread/.test(cssRes.body) || !/\.explorer-tree/.test(cssRes.body) || !/\.tree-pane/.test(cssRes.body)) {
        throw new Error('style.css missing explorer/thread classes');
      }
      if (/\.projects-grid\s*\{/.test(cssRes.body) && /\.project-card\s*\{/.test(cssRes.body) && !/\.explorer-tree/.test(cssRes.body)) {
        throw new Error('style.css still primary card-grid without explorer');
      }
      const appRes = await req('GET', '/app.js');
      if (appRes.status !== 200) throw new Error('app.js fetch failed');
      if (!/(?:async\s+)?function refreshAll\s*\(/.test(appRes.body)) throw new Error('app.js missing refreshAll');
      if (!/(?:async\s+)?function loadTree\s*\(/.test(appRes.body)) throw new Error('app.js missing loadTree');
      if (!/(?:async\s+)?function loadChatPane\s*\(/.test(appRes.body)) throw new Error('app.js missing loadChatPane');
      if (!/(?:async\s+)?function renderTree\s*\(/.test(appRes.body)) throw new Error('app.js missing renderTree');
      if (!/chats-folder/.test(appRes.body)) throw new Error('app.js missing chats-folder');
      if (!/Разговоры/.test(appRes.body)) throw new Error('app.js missing Разговоры label');
      if (!/next_step_ru/.test(appRes.body)) {
        throw new Error('app.js missing next-step Russian path');
      }
      const htmlShell = (await req('GET', '/')).body;
      if (!/id="treeToggle"/.test(htmlShell) || !/Каталог/.test(htmlShell)) {
        throw new Error('HOUR11 HTML treeToggle/Каталог missing');
      }
      if (!/btn-tree-toggle|tree-open|safe-area-inset/.test(cssRes.body)) {
        throw new Error('HOUR11 CSS missing drawer/safe-area');
      }
      if (!/treeToggle|openTreeDrawer|Закрыть каталог/.test(appRes.body)) {
        throw new Error('HOUR11 app.js missing catalog drawer');
      }
      console.log('TREE static UI checks OK');
      console.log('HOUR11 drawer static OK');
      // Hour-12: Консилиум folder + rounds + details UI
      {
        const tree12 = await req('GET', '/api/tree');
        if (tree12.status !== 200) throw new Error('HOUR12 tree ' + tree12.status);
        const tj12 = JSON.parse(tree12.body);
        function findId(nodes, id) {
          for (const n of nodes || []) {
            if (n.id === id) return n;
            const hit = findId(n.children || [], id);
            if (hit) return hit;
          }
          return null;
        }
        const hubNode = findId(tj12.nodes || [], 'collegium-hub');
        if (!hubNode) throw new Error('HOUR12 collegium-hub missing');
        const consFolder = (hubNode.children || []).find((c) => c.kind === 'consilium-folder' || /Консилиум/.test(c.title || ''));
        if (!consFolder) throw new Error('HOUR12 Консилиум folder missing');
        if (consFolder.kind !== 'consilium-folder') throw new Error('HOUR12 consilium-folder kind wrong: ' + consFolder.kind);
        const rounds = consFolder.children || [];
        if (!rounds.length) throw new Error('HOUR12 consilium rounds empty');
        if (!rounds.some((r) => r.kind === 'consilium-round')) throw new Error('HOUR12 no consilium-round child');
        const mats = (hubNode.children || []).find((c) => c.kind === 'materials-folder');
        if (mats) throw new Error('HOUR12 materials-folder should be replaced by Консилиум');
        const consApi = await req('GET', '/api/consilium?work=collegium-hub');
        if (consApi.status !== 200) throw new Error('HOUR12 consilium API ' + consApi.status);
        const cj = JSON.parse(consApi.body);
        if (!Array.isArray(cj.rounds) || cj.rounds.length < 1) throw new Error('HOUR12 consilium rounds API empty');
        if (!/consilium-folder|consilium-round/.test(appRes.body)) {
          throw new Error('HOUR12 app.js missing consilium kinds');
        }
        if (!/Задача/.test(appRes.body) || !/Проверки/.test(appRes.body)) {
          throw new Error('HOUR12 app.js missing Задача/Проверки details');
        }
        const html12 = (await req('GET', '/')).body;
        const css12 = (await req('GET', '/style.css')).body;
        if (!/materialSummary/.test(html12) || !/round-summary|material-summary/.test(css12 + appRes.body)) {
          throw new Error('HOUR12 static missing materialSummary/round-summary');
        }
        console.log('HOUR12 OK consiliumRounds=' + rounds.length + ' apiRounds=' + cj.rounds.length);
        // Hour-13: E2E cascade attrs must reach onSelect (сказал → видно)
        {
          const round = rounds.find((r) => r.kind === 'consilium-round' && (r.smoke_count != null || r.excerpt));
          if (!round) throw new Error('HOUR13 no round with smoke_count/excerpt');
          if (!round.round_id) throw new Error('HOUR13 round_id missing on tree node');
          if (round.smoke_count == null) throw new Error('HOUR13 smoke_count missing on tree node');
          if (!round.excerpt && !round.first_line) throw new Error('HOUR13 excerpt/first_line missing');
          const appBody = appRes.body;
          if (!/data-round-id/.test(appBody) || !/data-round-node/.test(appBody) || !/data-smoke-count/.test(appBody)) {
            throw new Error('HOUR13 app.js missing data-round-* attrs on render');
          }
          if (!/const roundId = row\.getAttribute\("data-round-id"\)/.test(appBody) &&
              !/getAttribute\("data-round-id"\)/.test(appBody)) {
            throw new Error('HOUR13 click handler does not read data-round-id');
          }
          if (!/getAttribute\("data-smoke-count"\)/.test(appBody)) {
            throw new Error('HOUR13 click handler does not read data-smoke-count');
          }
          if (!/getAttribute\("data-round-node"\)/.test(appBody)) {
            throw new Error('HOUR13 click handler does not read data-round-node');
          }
          if (!/getAttribute\("data-judge-excerpt"\)/.test(appBody)) {
            throw new Error('HOUR13 click handler does not read data-judge-excerpt');
          }
          if (!/smokeCount/.test(appBody) || !/roundNodeId/.test(appBody)) {
            throw new Error('HOUR13 onSelect payload missing smokeCount/roundNodeId');
          }
          // Cascade path: rubric → hub → chats/smoke/consilium → round
          const rubric = (tj12.nodes || []).find((n) => n.kind === 'folder' && n.id === 'rubric:active');
          if (!rubric) throw new Error('HOUR13 rubric:active missing');
          const hubUnder = (rubric.children || []).find((c) => c.id === 'collegium-hub');
          if (!hubUnder) throw new Error('HOUR13 hub not under В работе');
          const chats = (hubUnder.children || []).find((c) => c.kind === 'chats-folder' || /Разговоры/.test(c.title || ''));
          const smokeF = (hubUnder.children || []).find((c) => c.id === 'collegium-hub:smoke' || /Проверки моста/.test(c.title || ''));
          if (!chats) throw new Error('HOUR13 Разговоры missing in cascade');
          if (!smokeF) throw new Error('HOUR13 Проверки моста missing in cascade');
          if (!consFolder) throw new Error('HOUR13 Консилиум missing in cascade');
          // Live chat → thread still works (сказал → видно)
          const liveChat = (chats.children || [])[0];
          if (liveChat) {
            const th = await req('GET', '/api/projects/collegium-hub/chats/' + encodeURIComponent(liveChat.id));
            if (th.status !== 200) throw new Error('HOUR13 chat thread ' + th.status);
            const thj = JSON.parse(th.body);
            if (!Array.isArray(thj.messages) || !thj.messages.length) throw new Error('HOUR13 thread empty');
          }
          // Drawer still present
          const html13 = (await req('GET', '/')).body;
          if (!/id="treeToggle"/.test(html13) || !/Каталог/.test(html13)) {
            throw new Error('HOUR13 Каталог drawer missing');
          }
          console.log('HOUR13 cascade OK round=' + round.round_id + ' smoke_count=' + round.smoke_count + ' chats=' + (chats.children || []).length);

          // HOUR14: Archive-lite under Проверки моста («Ранее»)
          // HOUR15: day-folders under «Ранее» (D-lite)
          {
            function countSmokeLeaves(nodes) {
              let n = 0;
              for (const c of nodes || []) {
                if (c.kind === 'chat') n += 1;
                else if (c.children && c.children.length)
                  n += countSmokeLeaves(c.children);
              }
              return n;
            }
            function isDayFolder(node) {
              if (!node || node.kind !== 'folder') return false;
              if (node.day_key) return true;
              if (/:day:\d{4}-\d{2}-\d{2}/.test(node.id || '')) return true;
              // literary Russian day label: «2 октября»
              return /^\d{1,2}\s+[а-яё]+$/i.test(String(node.title || '').trim());
            }
            const smokeKids = smokeF.children || [];
            const earlierFolder = smokeKids.find(
              (c) =>
                c.id === 'collegium-hub:smoke:earlier' ||
                (c.kind === 'folder' && /Ранее/.test(c.title || ''))
            );
            const topChatKids = smokeKids.filter((c) => c.kind === 'chat');
            const earlierKids = earlierFolder ? earlierFolder.children || [] : [];
            const earlierLeafCount = countSmokeLeaves(earlierKids);
            const totalListed = topChatKids.length + earlierLeafCount;
            const statusTotal = parseInt(String(smokeF.status_ru || '0'), 10) || 0;
            if (statusTotal < 1 && smokeKids.length < 1) {
              throw new Error('HOUR14 Проверки моста empty unexpectedly');
            }
            if (statusTotal > 6) {
              if (!earlierFolder) {
                throw new Error('HOUR14 «Ранее» missing when smoke total > 6');
              }
              if (topChatKids.length > 6) {
                throw new Error(
                  'HOUR14 top-level smoke chats still > 6: ' + topChatKids.length
                );
              }
              if (!earlierKids.length) {
                throw new Error('HOUR14 «Ранее» has no children');
              }
              if (totalListed !== statusTotal) {
                throw new Error(
                  'HOUR14 status_ru=' +
                    statusTotal +
                    ' != listed ' +
                    totalListed +
                    ' (top=' +
                    topChatKids.length +
                    ' + earlierLeaves=' +
                    earlierLeafCount +
                    ')'
                );
              }
            }
            console.log(
              'HOUR14 archive-lite OK topChats=' +
                topChatKids.length +
                ' earlierLeaves=' +
                earlierLeafCount +
                ' status=' +
                statusTotal +
                (earlierFolder ? ' folder=Ранее' : ' (no archive needed)')
            );

            // HOUR15 D-lite day grouping
            if (statusTotal > 6 && earlierFolder) {
              const dayFolders = earlierKids.filter(isDayFolder);
              if (dayFolders.length < 1) {
                throw new Error(
                  'HOUR15 «Ранее» has no day-folders (still flat? kids=' +
                    earlierKids.length +
                    ')'
                );
              }
              // under «Ранее» should be day-folders, not a flat list of chats
              const flatChats = earlierKids.filter((c) => c.kind === 'chat');
              if (flatChats.length > 0 && dayFolders.length === 0) {
                throw new Error('HOUR15 flat SMOKE still directly under «Ранее»');
              }
              if (flatChats.length === earlierKids.length) {
                throw new Error(
                  'HOUR15 «Ранее» still flat list of ' + flatChats.length
                );
              }
              let dayLeafTotal = 0;
              for (const df of dayFolders) {
                const title = String(df.title || '');
                if (!/^\d{1,2}\s+[а-яё]+$/i.test(title.trim())) {
                  throw new Error(
                    'HOUR15 day label not literary Russian: ' + JSON.stringify(title)
                  );
                }
                const leaves = (df.children || []).filter((c) => c.kind === 'chat');
                if (leaves.length < 1) {
                  throw new Error(
                    'HOUR15 day-folder «' + title + '» has no SMOKE leaves'
                  );
                }
                dayLeafTotal += leaves.length;
              }
              if (dayLeafTotal !== earlierLeafCount) {
                throw new Error(
                  'HOUR15 day leaf sum ' +
                    dayLeafTotal +
                    ' != earlierLeaves ' +
                    earlierLeafCount
                );
              }
              if (topChatKids.length > 6) {
                throw new Error('HOUR15 top fresh SMOKE regress >6');
              }
              console.log(
                'HOUR15 day-group OK days=' +
                  dayFolders.length +
                  ' labels=' +
                  dayFolders.map((d) => d.title).join('|') +
                  ' earlierLeaves=' +
                  earlierLeafCount +
                  ' topFresh=' +
                  topChatKids.length +
                  ' status=' +
                  statusTotal
              );
            } else {
              console.log('HOUR15 day-group skipped (no archive needed)');
            }
          }
        }
      }
    }

    // Board API still healthy (not home UI)
    {
      const br = await req('GET', '/api/board?limit=7');
      if (br.status !== 200) throw new Error('board status ' + br.status);
      const bj = JSON.parse(br.body);
      if (!Array.isArray(bj.items)) throw new Error('board.items not array');
      if (bj.items.length > 7) throw new Error('board returned >7 items');
      for (const it of bj.items) {
        if (!it.owner_label) throw new Error('board item missing owner_label: ' + it.id);
        if (it.kind === 'work') {
          const st = String(it.status || '');
          const lab = String(it.status_label || '');
          if (st === 'принят' || lab === '100%' || /принят/i.test(st)) {
            throw new Error('board F2 fail: closed work on board ' + it.id);
          }
        }
      }
      const wr = await req('GET', '/api/works');
      const wj = JSON.parse(wr.body);
      for (const w of wj.works || []) {
        if (w.error) continue;
        if (typeof w.owner_label !== 'string' || !w.owner_label) {
          throw new Error('work ' + w.name + ' missing owner_label string');
        }
      }
      console.log('board API OK items=' + bj.items.length);
    }

    // PCT projects API + thread
    {
      const pr = await req('GET', '/api/projects');
      if (pr.status !== 200) throw new Error('projects status ' + pr.status);
      const pj = JSON.parse(pr.body);
      if (!Array.isArray(pj.projects) || !pj.projects.length) throw new Error('projects empty');
      const hub = pj.projects.find((p) => p.id === 'collegium-hub') || pj.projects[0];
      if (!hub.title || hub.title === hub.id) {
        // title may equal id only if missing — collegium must have RU title
        if (hub.id === 'collegium-hub' && (!hub.title || /collegium-hub/i.test(hub.title) && hub.title === 'collegium-hub')) {
          throw new Error('collegium-hub project missing human title');
        }
      }
      if (!hub.status_ru || /\b(enqueued|draft|confirmed)\b/i.test(hub.status_ru)) {
        throw new Error('project status_ru missing or technical: ' + hub.status_ru);
      }
      const det = await req('GET', '/api/projects/' + encodeURIComponent(hub.id));
      if (det.status !== 200) throw new Error('project detail ' + det.status);
      const dj = JSON.parse(det.body);
      if (!Array.isArray(dj.chats)) throw new Error('project.chats not array');
      if (smokeId) {
        const chat = dj.chats.find((c) => c.id === smokeId);
        if (!chat) throw new Error('smoke chat not listed in project');
        if (/\b(enqueued|draft|confirmed)\b/i.test(chat.status_ru || '')) {
          throw new Error('chat status_ru technical: ' + chat.status_ru);
        }
        const th = await req('GET', '/api/projects/' + encodeURIComponent(hub.id) + '/chats/' + encodeURIComponent(smokeId));
        if (th.status !== 200) throw new Error('chat thread ' + th.status);
        const tj = JSON.parse(th.body);
        if (!Array.isArray(tj.messages) || !tj.messages.length) throw new Error('thread messages empty');
        if (!tj.next_step_ru || !/Дальше:/.test(tj.next_step_ru)) throw new Error('thread missing Дальше');
        if (!tj.messages.some((m) => m.role === 'user')) throw new Error('thread missing user message');
        console.log('TREE projects+thread OK project=' + hub.id + ' chat=' + smokeId + ' msgs=' + tj.messages.length);
      } else {
        console.log('TREE projects OK (no smokeId yet) count=' + pj.projects.length);
      }
      const html = await req('GET', '/');
      if (!/Мои дела/.test(html.body) || !/explorerTree/.test(html.body) || !/treePane/.test(html.body)) {
        throw new Error('index missing explorer tree home');
      }
      if (/multiTaskBoard|Дать указание|data-tab="directives"/.test(html.body)) {
        throw new Error('index still ops-home');
      }
    }


    // HOUR-usable (DISCUSSION-usable-flight X=B)
    {
      const htmlU = (await req('GET', '/')).body;
      if (!/id="btnNewProject"/.test(htmlU) || !/Новое дело/.test(htmlU)) {
        throw new Error('USABLE HTML missing Новое дело');
      }
      if (!/id="btnNewChat"/.test(htmlU) || !/Новый разговор/.test(htmlU)) {
        throw new Error('USABLE HTML missing Новый разговор');
      }
      const appU = (await req('GET', '/app.js')).body;
      if (!/createNewProject/.test(appU) || !/createNewChat/.test(appU)) {
        throw new Error('USABLE app.js missing create helpers');
      }
      const treeU = JSON.parse((await req('GET', '/api/tree')).body);
      function walk(nodes, fn) {
        for (const n of nodes || []) {
          fn(n);
          if (n.children) walk(n.children, fn);
        }
      }
      let rawSmoke = 0;
      let checkHuman = 0;
      walk(treeU.nodes, (n) => {
        if (n.kind !== 'chat') return;
        const t = String(n.title || '');
        if (/SMOKE write-bridge/i.test(t) || /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(t)) {
          rawSmoke += 1;
        }
        if (/^Проверка записи\b/.test(t) || /^Пробный разговор\b/.test(t)) checkHuman += 1;
      });
      if (rawSmoke > 0) throw new Error('USABLE U1 raw SMOKE titles still visible: ' + rawSmoke);
      // After smoke draft above, at least one humanized check title should appear
      const hubU = (function find(nodes, id) {
        for (const n of nodes || []) {
          if (n.id === id) return n;
          const h = find(n.children, id);
          if (h) return h;
        }
        return null;
      })(treeU.nodes, 'collegium-hub');
      if (!hubU) throw new Error('USABLE hub missing');
      const smokeFolder = (hubU.children || []).find((c) => c.id === 'collegium-hub:smoke' || /Проверки моста/.test(c.title || ''));
      if (!smokeFolder) throw new Error('USABLE Проверки моста missing');
      function firstCheckTitle(nodes) {
        for (const c of nodes || []) {
          if (c.kind === 'chat') return c.title;
          const deep = firstCheckTitle(c.children);
          if (deep) return deep;
        }
        return null;
      }
      const sampleTitle = firstCheckTitle(smokeFolder.children);
      if (!sampleTitle || !/^(Проверка записи|Пробный разговор)/.test(sampleTitle)) {
        throw new Error('USABLE U1 sample check title not literary: ' + JSON.stringify(sampleTitle));
      }
      // U2 create project
      const created = await req('POST', '/api/projects', { title: 'Посадочное дело usable' });
      if (created.status !== 201) throw new Error('USABLE create project ' + created.status + ' ' + created.body.slice(0, 200));
      const cj = JSON.parse(created.body);
      const newId = cj.project && cj.project.id;
      if (!newId) throw new Error('USABLE create project missing id');
      if (!/в работе/i.test(String(cj.project.status_ru || ''))) {
        throw new Error('USABLE create status_ru not в работе: ' + cj.project.status_ru);
      }
      const treeAfter = JSON.parse((await req('GET', '/api/tree')).body);
      const found = (function find(nodes, id) {
        for (const n of nodes || []) {
          if (n.id === id) return n;
          const h = find(n.children, id);
          if (h) return h;
        }
        return null;
      })(treeAfter.nodes, newId);
      if (!found || found.kind !== 'project') throw new Error('USABLE new project not in tree');
      if (!/^в работе$|^ждёт$|^готово$/.test(String(found.status_ru || '').trim())) {
        throw new Error('USABLE U4 project status not triad: ' + found.status_ru);
      }
      // U3 comment/chat under new project
      const chatDraft = await req('POST', '/api/intents', {
        work: newId,
        who: 'grok',
        task: 'Комментарий с посадки: проверить, что нить сохраняется.',
      });
      if (chatDraft.status !== 201) throw new Error('USABLE chat draft ' + chatDraft.status);
      const chatId = JSON.parse(chatDraft.body).intent.id;
      const th = await req('GET', '/api/projects/' + encodeURIComponent(newId) + '/chats/' + encodeURIComponent(chatId));
      if (th.status !== 200) throw new Error('USABLE thread ' + th.status);
      const thj = JSON.parse(th.body);
      if (!Array.isArray(thj.messages) || !thj.messages.length) throw new Error('USABLE thread empty');
      if (!thj.messages.some((m) => /Комментарий с посадки/.test(m.text || ''))) {
        throw new Error('USABLE comment text missing in thread');
      }
      const intentFile = path.join('C:/most/works', newId, '_handoff', 'intents', chatId + '.json');
      if (!fs.existsSync(intentFile)) throw new Error('USABLE intent file missing on disk');
      // human chats folder should hold the new chat (not smoke)
      const tree3 = JSON.parse((await req('GET', '/api/tree')).body);
      const proj3 = (function find(nodes, id) {
        for (const n of nodes || []) {
          if (n.id === id) return n;
          const h = find(n.children, id);
          if (h) return h;
        }
        return null;
      })(tree3.nodes, newId);
      const chatsF = (proj3.children || []).find((c) => c.kind === 'chats-folder' || /Разговоры/.test(c.title || ''));
      if (!chatsF || !(chatsF.children || []).some((c) => c.id === chatId)) {
        throw new Error('USABLE new chat not under Разговоры');
      }
      console.log('HOUR-usable OK project=' + newId + ' chat=' + chatId + ' checkTitle=' + sampleTitle);
    }


    // HOUR16 Q-lite + H-lite
    {
      const tree16 = JSON.parse((await req('GET', '/api/tree')).body);
      const active = (tree16.nodes || []).find((n) => n.id === 'rubric:active' || n.title === 'В работе');
      if (!active) throw new Error('HOUR16 missing В работе');
      const directKids = active.children || [];
      const probesFolder = directKids.find((c) => c.id === 'folder:probes' || c.title === 'Пробы');
      const probeTitleRe = /посадоч|usable|тест\s*создан|\bSMOKE\b|\bsmoke\b|^проба\b/i;
      const badDirect = directKids.filter((c) => c.kind === 'project' && probeTitleRe.test(String(c.title || '')));
      if (badDirect.length) {
        throw new Error('HOUR16 probe titles still direct under В работе: ' + badDirect.map((x) => x.title).join('; '));
      }
      // also catch known demo ids at active root
      const badIds = directKids.filter((c) => c.kind === 'project' && /^(posadochnoe-delo-usable|test-)|-usable$/i.test(String(c.id || '')));
      if (badIds.length) {
        throw new Error('HOUR16 probe ids still direct under В работе: ' + badIds.map((x) => x.id).join('; '));
      }
      if (probesFolder) {
        if (probesFolder.kind !== 'folder') throw new Error('HOUR16 Пробы not folder');
        const leaves = probesFolder.children || [];
        if (!leaves.length) throw new Error('HOUR16 Пробы empty but present');
        const stillOutside = leaves.filter((c) => c.kind === 'project');
        if (!stillOutside.length) throw new Error('HOUR16 Пробы has no projects');
        // day folders label check (optional soft): find any day folder
      }
      // L1: day folders expose label
      function walk(nodes, fn) {
        for (const n of nodes || []) {
          fn(n);
          if (n.children) walk(n.children, fn);
        }
      }
      let dayOk = 0;
      walk(tree16.nodes, (n) => {
        if (n && n.day_key && n.kind === 'folder') {
          if (!n.label || String(n.label).length < 2) {
            throw new Error('HOUR16 day folder missing label: ' + n.id);
          }
          dayOk += 1;
        }
      });
      // H-lite static hooks
      const html16 = (await req('GET', '/')).body;
      const css16 = (await req('GET', '/style.css')).body;
      const app16 = (await req('GET', '/app.js')).body;
      const stickyHook =
        /h16-sticky/.test(html16) ||
        /actions-sticky/.test(html16) ||
        /h16-sticky/.test(css16) ||
        /actions-sticky/.test(css16) ||
        /syncH16Sticky/.test(app16);
      if (!stickyHook) throw new Error('HOUR16 missing h16-sticky / actions-sticky hook');
      console.log(
        'HOUR16 Q+H OK probesFolder=' +
          (probesFolder ? probesFolder.status_ru : 'none') +
          ' dayLabels=' +
          dayOk +
          ' sticky=1'
      );
    }


    console.log('SMOKE OK intent=' + smokeId + ' channel=' + enqJ.intent.channel
      + ' derived=' + detail.derivedStatus
      + ' result.kind=' + (detail.result && detail.result.kind)
      + ' mcp_hint=' + !!enqJ.mcp_dead_hint
      + ' banner_level=' + (health.banner_level || health.fallback?.level));
  } finally {
    child.kill();
    setTimeout(() => process.exit(0), 500).unref();
  }
}

main().catch((e) => {
  console.error('SMOKE FAIL', e);
  process.exit(1);
});