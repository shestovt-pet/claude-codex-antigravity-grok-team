'use strict';
const fs = require('fs'),
  path = require('path');
const { stateDir, repoRoot, canon } = require('./paths');
const { name, inside, git, repository, hash, clean, atomic } = require('./team-git');
const stores = require('./team-store'),
  deployer = require('./deploy');
const { format, duration } = require('./format');
const participants = ['claude', 'codex', 'antigravity'];
const sha = value => require('crypto').createHash('sha256').update(value).digest('hex');
const requestText = c => c.request ? 'Запрос пользователя ' + c.requestMark + ':\n' + c.request + '\nЗамысел: ' + c.designFile + ', sha256 ' + c.designHash + '\n' : 'запрос не сохранён (изменение начато до ворот запроса)\n';
function refreshDesign(c) {
  if (!c.request) return;
  const current = sha(fs.readFileSync(c.designFile));
  if (current !== c.designHash) {
    c.designHash = current;
    c.designVotes = (c.designVotes || []).filter(v => v.decision !== 'ПРИНЯТО');
  }
}
function systemic(c, who, id, text) {
  if (!text.includes('[системное]')) return;
  c.systemic ||= [];
  if (!c.systemic.some(v => v.who === who && v.job_id === id)) c.systemic.push({ who, job_id: id });
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');
function stageFailure(s, before, previous, error) {
  const unreadable = error.code === 'STAGE_READ_FAILED' || ['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'EIO'].includes(error.code);
  for (const key of Object.keys(s)) delete s[key];
  Object.assign(s, unreadable && ['принят', 'выдан без принятия'].includes(previous?.state) ? structuredClone(previous) : before);
  s.state = unreadable ? (previous?.state || 'план') : previous?.state === 'выдан без принятия' ? previous.state : 'идёт';
  const message = 'Этап [' + s.id + '] ' + (unreadable ? 'не удалось проверить; прежнее состояние сохранено: ' : 'не принят: ') + error.message;
  s.gate ||= { files: [], reasons: [] };
  if (unreadable) s.gate.warning = message;
  else { s.gate.message = message; delete s.gate.warning; }
  delete s.override; delete s.one_family; delete s.criterion_met; delete s.fresh_review_file;
  return message;
}
function percent(w) {
  return Math.round(w.stages.filter((s) => s.state === 'принят').reduce((n, s) => n + s.weight, 0) * 100) / 100;
}

// Краткий ответ на create/update (team-v9 Р3): полный вид — team_work get.
function workBrief(w) {
  const i = w.stages.findIndex((s) => s.state !== 'принят');
  return require('./summary').label(w) + ' · редакция ' + w.revision +
    '\nПринято ' + percent(w) + ' % плана · этап ' + (i < 0 ? w.stages.length : i + 1) + ' из ' + w.stages.length +
    ' — ' + (i < 0 ? 'все приняты' : w.stages[i].title) +
    '\nСледующий шаг: ' + w.next_step +
    '\nДля следующего обновления: expected_revision ' + w.revision + '; полный вид — team_work get.';
}
// Одно сообщение на все этапы, принятые одним обновлением (team-v9 Р3).
function acceptedMessage(w, accepted) {
  const n = w.stages.length,
    one = ({ s, i }) => 'этап ' + (i + 1) + ' из ' + n + ' — ' + s.title + ' · сделано: ' + s.evidence + ' · это закрывает: ' + (s.closes || s.accept_criteria);
  return 'Принято ' + percent(w) + ' % плана · ' +
    (accepted.length === 1 ? one(accepted[0]) : 'приняты этапы: ' + accepted.map(one).join('; ')) +
    ' · дальше: ' + w.next_step;
}

function workText(w) {
  if (w.error) return w.error;
  const i = w.stages.findIndex((s) => s.state !== 'принят');
  return (
    require('./summary').label(w) +
    ' · редакция ' +
    w.revision +
    '\nПринято ' +
    percent(w) +
    ' % плана · этап ' +
    (i < 0 ? w.stages.length : i + 1) +
    ' из ' +
    w.stages.length +
    ' — ' +
    (i < 0 ? 'все приняты' : w.stages[i].title) +
    '\nЭтапы: ' + w.stages.map(s => s.title + ' [' + (s.id || 'старый этап') + '] · ' + s.state + ' · version ' + (s.version || 'не задана') + '\n' + [s.gate?.message, s.gate?.warning].filter(Boolean).join('\n')).join('\n') +
    '\nЦель: ' +
    w.goal +
    '\nСделано: ' +
    (w.stages
      .filter((s) => s.state === 'принят')
      .map((s) => s.title + ': ' + s.evidence)
      .join('; ') || 'принятых этапов нет') +
    '\nКритерий завершения: ' +
    w.done_criteria +
    '\nСледующий шаг: ' +
    w.next_step +
    '\nНапоминания: ' +
    (w.reminders.join(', ') || 'нет')
  );
}
class Team {
  constructor(root = repoRoot, state = path.join(stateDir, 'team')) {
    this.root = fs.realpathSync(root);
    this.state = state;
    this.notices = [];
  }
  workFile(n) {
    return inside(this.root, 'works', name(n) + '.json');
  }
  changeFile(n) {
    name(n);
    return path.join(this.state, 'changes', n + '.json');
  }
  clone(n) {
    const folder = inside(this.root, '.work', name(n));
    repository(folder);
    return folder;
  }
  works() {
    const dir = inside(this.root, 'works');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => /^[a-z0-9-]{1,40}\.json$/.test(n))
      .flatMap((n) => {
        try { return [this.readWork(inside(this.root, 'works', n))]; }
        catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      });
  }
  readWork(file) {
    try {
      const w = read(file);
      workText(w);
      return w;
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
      return { error: 'карточка повреждена: ' + path.basename(file) };
    }
  }
  async refreshWork(file) {
    const w = this.readWork(file);
    if (w.error) return w;
    const before = JSON.stringify(w);
    for (const s of w.stages.filter(s => s.level && ['принят', 'выдан без принятия'].includes(s.state))) {
      const old = structuredClone(s);
      try { s.gate.message = await require('./stage-gate').evaluate(w, s, old); delete s.gate.warning; }
      catch (e) { stageFailure(s, old, old, e); }
    }
    if (w.closed && w.stages.some(s => !['принят', 'выдан без принятия'].includes(s.state))) w.closed = false;
    if (JSON.stringify(w) !== before) {
      if (JSON.stringify(w.stages.map(s => s.state)) !== JSON.stringify(JSON.parse(before).stages.map(s => s.state))) w.revision++;
      save(file, w);
    }
    return w;
  }
  async work(a) {
    require('./access').guard('team', 'team_work', a);
    if (a.action === 'create' && !a.owner?.trim()) throw Error('Для новой работы нужна метка владельца owner.');
    if (a.action === 'list') return deployer.locked(this.root, async () => {
      const works = await Promise.all(this.works().map(w => w.error ? w : this.refreshWork(this.workFile(w.name))));
      for (const w of works.filter(w => !w.error && w.previous_owners?.includes(a.owner))) {
        require('./work-owner').check(w, a.owner);
      }
      for (const w of works.filter(w => !w.error && (!w.owner || w.owner === a.owner))) {
        require('./work-owner').touch(w.name, a.owner, this.root);
      }
      return works.map(workText).join('\n\n') || 'Работ нет.';
    });
    const file = this.workFile(a.name);
    if (a.action === 'get') return deployer.locked(this.root, async () => {
      const current = await this.refreshWork(file);
      if (current.error) return workText(current);
      return workText(require('./work-owner').touch(a.name, a.owner, this.root));
    });
    return deployer.locked(this.root, async () => {
      const old = fs.existsSync(file) ? read(file) : null;
      if (old && a.action !== 'claim') require('./work-owner').check(old, a.owner);
      if (a.action === 'claim') {
        if (!old) throw Error('Работа не найдена.');
        if (!a.owner?.trim()) throw Error('Нужна метка нового владельца.');
        if (a.expected_revision !== old.revision) throw Error('Работу уже изменил другой чат.');
        for (const job of new (require('./grok').Grok)().list()) {
          await new (require('./grok').Grok)().refresh(job.id);
        }
        await require('./work-owner').reconcileJobs(a.name);
        const heartbeat = Date.parse(old.heartbeat_at || old.updated_at);
        if (!Number.isFinite(heartbeat) || Date.now() - heartbeat <= 3600000 ||
            require('./work-owner').hasLiveJobs(a.name)) {
          throw Error('Работа жива: передача владения запрещена.');
        }
        old.previous_owners = [...new Set([...(old.previous_owners || []), old.owner].filter(Boolean))];
        old.owner = a.owner;
        old.claimed_at = old.heartbeat_at = new Date().toISOString();
        old.revision++;
        save(file, old);
        return workText(old);
      }
      if (a.action === 'create' && old) throw Error('Работа уже существует.\n' + workText(old));
      if (a.action === 'update' && !old) throw Error('Работа не найдена.');
      if (a.expected_revision !== (old?.revision || 0))
        throw Error(
          'Работу уже изменил другой чат. Текущее состояние:\n' +
            (old ? workText(old) : 'Редакция 0: работа не создана.'),
        );
      const w = { ...old, stages: structuredClone(old?.stages), name: a.name, revision: (old?.revision || 0) + 1 };
      if (a.action === 'close') w.closed = true;
      if (!w.title && w.name === 'trio-v2') w.title = 'Связка четырёх: 8 пунктов запроса';
      w.created_at ||= old?.updated_at || new Date().toISOString();
      w.owner ||= a.owner || null;
      w.heartbeat_at = new Date().toISOString();
      if (a.status_sent === true) w.status_sent_at = w.heartbeat_at;
      for (const k of ['title', 'folder', 'goal', 'done_criteria', 'stages', 'next_step', 'reminders'])
        if (a[k] !== undefined) w[k] = structuredClone(a[k]);
      if (
        !w.goal?.trim() ||
        !w.done_criteria?.trim() ||
        !w.next_step?.trim() ||
        !Array.isArray(w.stages) ||
        !w.stages.length
      )
        throw Error('Укажите цель, критерий завершения, этапы и следующий шаг.');
      if (Math.abs(w.stages.reduce((n, s) => n + s.weight, 0) - 100) > 0.000001)
        throw Error('Сумма весов этапов должна быть 100.');
      if (a.folder !== undefined && (typeof a.folder !== 'string' || !path.isAbsolute(a.folder) || !fs.existsSync(a.folder) || !fs.statSync(a.folder).isDirectory()))
        throw Error('folder: нужна абсолютная существующая папка.');
      if (old?.folder && !require('./paths').samePath(w.folder, old.folder)) throw Error('Папку работы менять нельзя.');
      const gate = require('./stage-gate');
      gate.normalize(w, old, a.plan_change);
      const stageMessages = [], stageErrors = [];
      for (const s of w.stages) {
        const previous = old?.stages.find(p => p.id === s.id), before = structuredClone(s);
        let msg;
        try { msg = await gate.evaluate(w, s, previous); delete s.gate.warning; }
        catch (e) { msg = stageFailure(s, before, previous, e); stageErrors.push(msg); }
        if (msg) {
          if (!s.gate.warning) s.gate.message = msg;
          if (s.state !== previous?.state && (['принят', 'выдан без принятия'].includes(s.state) || previous?.state === 'принят'))
            stageMessages.push(s.title + ' [' + s.id + '] · ' + s.state + '\n' + msg);
        }
      }
      for (const s of w.stages) {
        if (
          !s.title?.trim() ||
          !s.accept_criteria?.trim() ||
          (s.closes !== undefined && (typeof s.closes !== 'string' || !s.closes.trim())) ||
          !Number.isFinite(s.weight) ||
          s.weight <= 0 ||
          !['план', 'идёт', 'принят', 'выдан без принятия'].includes(s.state)
        )
          throw Error('Некорректный этап.');
        if (s.state === 'принят' && (!s.evidence?.trim() || !s.version?.trim()))
          throw Error('Принятый этап требует доказательства проверки и версии.');
      }
      if (w.closed && w.stages.some(s => !['принят', 'выдан без принятия'].includes(s.state))) {
        if (a.action === 'close') throw Error('Закрыть можно работу только с принятыми или выданными без принятия этапами.');
        w.closed = false;
      }
      const structure = (stages) =>
        stages.map(({ title, weight, accept_criteria, closes }) => ({ title, weight, accept_criteria, closes }));
      const changed =
        old &&
        (JSON.stringify(structure(old.stages)) !== JSON.stringify(structure(w.stages)) ||
          old.goal !== w.goal ||
          old.done_criteria !== w.done_criteria ||
          (a.stages && old.stages.some(s => s.state === 'принят' && ['title', 'accept_criteria', 'version', 'evidence', 'state'].some(k => {
            const submitted = a.stages.find(p => p.id === s.id || (!p.id && p.title === s.title));
            return submitted?.[k] !== undefined && s[k] !== submitted[k] && !(k === 'version' && s.material?.length);
          }))));
      if (changed && !a.plan_change?.trim())
        throw Error('Изменение плана или принятого этапа требует пояснения plan_change.');
      w.plan_changes = [
        ...(old?.plan_changes || []),
        ...(a.plan_change
          ? [
              {
                revision: w.revision,
                reason: a.plan_change,
                at: new Date().toISOString(),
                previous_percent: old ? percent(old) : 0,
                percent: percent(w),
              },
            ]
          : []),
      ];
      w.reminders = [...new Set(w.reminders || [])];
      w.updated_at = new Date().toISOString();
      save(file, w);
      let warning = stageErrors.length ? '\n' + stageErrors.join('\n') : '';
      try {
        atomic(inside(this.root, 'works', 'status.md'), this.works().map(workText).join('\n\n') + '\n');
      } catch (e) {
        warning += '\nКарточка сохранена; представление status.md не обновлено: ' + e.message;
      }
      if (stageMessages.length) warning += '\nСообщение пользователю (передайте дословно):\n' + stageMessages.join('\n');
      const accepted = w.stages.map((s, i) => ({ s, i })).filter(({s}) => s.state === 'принят' && old?.stages.find(p => p.id === s.id)?.state !== 'принят');
      if (!accepted.length) return workBrief(w) + warning + w.stages.filter(s => s.state === 'выдан без принятия').map(s => '\n' + s.title + ': выдан без принятия; ' + (s.gate.reasons || []).join('; ')).join('');
      const message = acceptedMessage(w, accepted);
      await require('./notify').notify(require('./summary').title(w) + ': принято ' + percent(w) + ' % плана', message);
      return workBrief(w) + warning + '\nСообщение пользователю (отправьте в чат):\n' + message;
    });
  }
  rules(part = 'brief') {
    if (!['brief', 'common', 'claude', 'antigravity', 'grok', 'roles', 'fallback', 'all'].includes(part)) throw Error('Неизвестная часть правил.');
    repository(this.root);
    const commit = hash(this.root);
    // Зафиксированный хеш исключает смесь редакций, если main сменился между чтениями.
    return (
      'Версия правил (main): ' +
      commit +
      '\n' +
      (part === 'all' ? ['common', 'claude', 'antigravity', 'grok', 'roles', 'fallback'] : [part])
        .map((p) => {
          const file = 'rules/' + p + '.md';
          if (!git(this.root, ['ls-tree', '--name-only', commit, '--', file]).trim()) return p === 'brief' ? 'Памятка не найдена. Части: brief — памятка; common — общие правила; claude — дирижёр; antigravity — работа с текстом; roles — распределение ролей; fallback — режим без Claude Desktop; all — полные правила.' : 'в main нет ' + file;
          return '\nПравила ' + p + ':\n' + require('./paths').withRoot(git(this.root, ['show', commit + ':' + file]), this.root);
        })
        .join('\n')
    );
  }
  pair(n, restore = false) {
    const c = read(this.changeFile(n)),
      folder = this.clone(n);
    let candidate = git(folder, ['rev-parse', 'HEAD']).trim();
    const branch = git(folder, ['branch', '--show-current']).trim();
    if (branch !== 'change/' + n) {
      // team-v10 Р3: только commit/verdict/merge и только отсоединённый HEAD ровно на вершине своей локальной ветки,
      // при чистых отслеживаемых файлах и индексе и без незавершённой операции git. Файлы и индекс не меняются.
      const why = restore && c.status !== 'закрыто без слияния' ? this.restoreBlocker(folder, n, branch, candidate) : 'возврат не разрешён';
      if (why) throw Error('В рабочей копии выбрана другая ветка.' + (restore ? ' Автовозврат невозможен: ' + why + '.' : ''));
      const g = this.restoreGit || git;
      g(folder, ['symbolic-ref', 'HEAD', 'refs/heads/change/' + n]);
      const now = g(folder, ['rev-parse', 'HEAD']).trim();
      if (g(folder, ['branch', '--show-current']).trim() !== 'change/' + n || now !== candidate)
        throw Error('В рабочей копии выбрана другая ветка: возврат на change/' + n + ' не подтвердился.');
      this.notices.push('Рабочая копия была переключена на коммит ' + candidate.slice(0, 7) + ' без ветки; возвращена на ветку change/' + n + ', содержимое не менялось.');
    }
    return { c, folder, candidate };
  }
  // Причина, по которой отсоединённый HEAD нельзя вернуть на ветку (null — можно).
  restoreBlocker(folder, n, branch, head) {
    if (branch) return 'выбрана ветка ' + branch;
    let tip;
    try { tip = git(folder, ['rev-parse', '--verify', '--quiet', 'refs/heads/change/' + n]).trim(); } catch { return 'нет локальной ветки change/' + n; }
    if (!tip) return 'нет локальной ветки change/' + n;
    if (tip !== head) return 'HEAD ' + head.slice(0, 7) + ' не совпадает с вершиной ветки ' + tip.slice(0, 7);
    const dir = path.join(folder, '.git');
    for (const f of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'])
      if (fs.existsSync(path.join(dir, f))) return 'идёт незавершённая операция git (' + f + ')';
    if (git(folder, ['status', '--porcelain', '--untracked-files=no']).trim()) return 'есть незакоммиченные изменения отслеживаемых файлов или индекса';
    return null;
  }
  // Самопроверка будущего кандидата: рабочее дерево клона, включая незакоммиченное (team-v9 Р2).
  precheck(p) {
    const pc = require('./precheck');
    let diff = '';
    try { diff = git(p.folder, ['diff', '--no-ext-diff', '--no-textconv', '-U0', p.c.base, '--', 'lessons.md']); }
    catch (e) { return 'Самопроверка: уроки не проверены — ' + e.message; }
    let print;
    try { print = 'Отпечаток кандидата: ' + require('./fingerprint').fingerprint(p.folder); } catch (e) { print = 'Отпечаток кандидата не получен: ' + e.message.split('\n')[0]; }
    return pc.precheckText(pc.precheck({ folder: p.folder, designFile: p.c.designFile, lessonsDiff: diff, change: p.c })) + '\n' + print;
  }
  checkPair(a, p) {
    if (a.base !== p.c.base || a.candidate !== p.candidate || p.c.candidate !== p.candidate)
      throw Error('Вердикт относится к другой паре коммитов; сначала зафиксируйте кандидата.');
  }
  async change(a) {
    this.notices = [];
    let result;
    try { result = await this.changeInner(a); }
    catch (e) {
      // Возврат клона уже выполнен — ответ об отказе сообщает и о нём (Codex 7d8230cc).
      if (this.notices.length) e.message = this.notices.join('\n') + '\n' + e.message;
      throw e;
    }
    return this.notices.length && typeof result === 'string' ? this.notices.join('\n') + '\n' + result : result;
  }
  async changeInner(a) {
    require('./access').guard('team', 'team_change', a);
    if (a.name && ['commit', 'merge', 'deploy'].includes(a.action)) {
      const change = read(this.changeFile(a.name));
      if (change.work) require('./work-owner').check(read(this.workFile(change.work)), a.owner);
    }
    if (a.action === 'deploy') {
      const pending = require('./deploy-ops').list(this.root).find(op => !require('./deploy-ops').terminal.includes(op.status));
      if (pending) throw Error('Идёт установка ' + pending.id);
      const out = await deployer.locked(this.root, async () => {
        // Разрешение владельца раньше обслуживания замка Git и любых действий выпуска.
        const readOnlyGit = (root, args) => git(root, args, { recoverIndex: false });
        const commit = hash(this.root, a.commit || 'main', readOnlyGit);
        const dir = path.join(this.state, 'changes');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
        const linked = [];
        for (const file of files) {
          const change = read(path.join(dir, file));
          if (change.work && (change.name === a.name ||
              (change.status === 'слито' && change.candidate === commit))) {
            require('./work-owner').check(read(this.workFile(change.work)), a.owner);
            linked.push(change.work);
          }
        }
        for (const work of new Set(linked)) require('./work-owner').touch(work, a.owner, this.root);
        // Коммит должен уже находиться в принятой main.
        git(this.root, ['merge-base', '--is-ancestor', commit, 'main']);
        return deployer.deploy({ root: this.root, commit, external: true, restartClaude: a.restart_claude, cleanup: a.cleanup !== false }, { repoLocked: true });
      });
      // team-v10 Р5: без перезапуска уборку выполняет этот же вызов, уже отпустив замок установки;
      // с перезапуском — новый сервер после готовности.
      if (!a.restart_claude && /: завершено\./.test(out)) return out + '\n' + await this.afterDeploy();
      return out;
    }
    if (a.action === 'rollback') return deployer.rollback({ root: this.root });
    if (a.action === 'list') return this.changesText();
    if (a.action === 'cleanup') {
      if (!a.owner?.trim()) throw Error('Для уборки нужна метка владельца owner.');
      const c = require('./cleanup');
      return deployer.locked(this.root, async () => c.cleanupText(c.cleanup({ root: this.root, apply: a.apply === true, owner: a.owner }, this.cleanupDeps || {})));
    }
    name(a.name);
    if (a.action === 'diff') {
      repository(this.root);
      const p = this.pair(a.name),
        base = hash(this.root);
      // Показываем также незакоммиченные изменения, полезные после сбоя исполнителя.
      const text =
        requestText(p.c) + 'База изменения: ' +
        p.c.base +
        '\nТекущая main: ' +
        base +
        '\nКандидат: ' +
        p.candidate +
        '\n' +
        git(p.folder, ['diff', '--no-ext-diff', '--no-textconv', p.c.base + '...HEAD']) +
        '\nНезакоммиченные изменения:\n' +
        git(p.folder, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']) +
        '\nСостояние файлов:\n' +
        git(p.folder, ['status', '--short']);
      const from = a.from_char || 0;
      return (
        text.slice(from, from + 24000) +
        (from + 24000 < text.length ? '\nПродолжение: from_char=' + (from + 24000) : '')
      );
    }
    if (a.action === 'precheck') {
      repository(this.root);
      return this.precheck(this.pair(a.name));
    }
    return deployer.locked(this.root, async () => {
      if (['commit', 'merge'].includes(a.action)) {
        const change = read(this.changeFile(a.name));
        if (change.work) require('./work-owner').touch(change.work, a.owner, this.root);
      }
      repository(this.root);
      if (a.action === 'close') {
        const c = read(this.changeFile(a.name));
        if (!a.owner?.trim() || !a.note?.trim()) throw Error('Для закрытия нужны owner и причина note.');
        if (c.work) require('./work-owner').touch(c.work, a.owner, this.root);
        else if (c.owner && c.owner !== a.owner) throw Error('Изменение принадлежит другому владельцу.');
        if (c.status === 'слито') throw Error('Слитое изменение закрывать нельзя.');
        if (c.status === 'закрыто без слияния') return 'Уже закрыто без слияния: ' + a.name;
        c.status = 'закрыто без слияния'; c.closedAt = new Date().toISOString(); c.closedBy = a.owner; c.closeNote = a.note.trim();
        save(this.changeFile(a.name), c);
        return 'Закрыто без слияния: ' + a.name + '. Клон и история сохранены.';
      }
      if (a.action === 'start') {
        if (a.work) require('./work-owner').touch(a.work, a.owner, this.root);
        const request = a.request?.trim();
        if (!request || request.length < 20) throw Error('Нужен запрос пользователя: не менее 20 символов.');
        if (!path.isAbsolute(a.design_file || '') || !fs.statSync(a.design_file).isFile()) throw Error('Нужен абсолютный путь существующего файла замысла.');
        const design = { request, requestMark: '#' + sha(request).slice(0, 8), designFile: a.design_file, designHash: sha(fs.readFileSync(a.design_file)), designVotes: [] };
        const folder = inside(this.root, '.work', a.name),
          file = this.changeFile(a.name);
        if (fs.existsSync(folder) || fs.existsSync(file)) throw Error('Изменение с таким именем уже существует.');
        const base = hash(this.root);
        fs.mkdirSync(path.dirname(folder), { recursive: true });
        git(this.root, ['clone', '--no-hardlinks', '--no-local', '--branch', 'main', '--', this.root, folder]);
        git(folder, ['remote', 'set-url', 'origin', '../..']);
        git(folder, ['checkout', '-b', 'change/' + a.name, base]);
        save(file, { name: a.name, owner: a.owner, title: a.title, work: a.work, base, candidate: base, verdicts: [], status: 'открыто', ...design });
        return 'Создана рабочая копия: ' + folder + '\nБаза: ' + base + '\n' + requestText(design);
      }
      const p = this.pair(a.name, ['commit', 'verdict', 'merge'].includes(a.action)),
        { c, folder } = p;
      if (c.status === 'закрыто без слияния') throw Error('Изменение закрыто без слияния.');
      if (a.title !== undefined && ['design', 'verdict', 'commit'].includes(a.action)) c.title = a.title;
      if (['design', 'commit', 'merge'].includes(a.action) && c.request) { refreshDesign(c); save(this.changeFile(a.name), c); }
      if (['design', 'verdict'].includes(a.action) && a.who === 'grok') {
        if (a.action === 'verdict') {
          this.checkPair(a, p);
          if (!clean(folder)) throw Error('Рабочая копия грязная; сначала зафиксируйте изменения.');
        }
        const message = await require('./grok-gate').record(c, a.action, a);
        save(this.changeFile(a.name), c);
        return message;
      }
      if (a.action === 'design') {
        if (!c.request) throw Error('В старом изменении запрос и замысел не сохранены.');
        if (!['ПРИНЯТО', 'НЕ ПРИНЯТО'].includes(a.decision)) throw Error('Неизвестный вердикт замысла.');
        if (a.who === 'claude') {
          if (a.decision !== 'ПРИНЯТО' || !['codex', 'antigravity'].includes(a.replaces) || !a.note?.trim() ||
              (c.designVotes || []).filter(v => v.who === a.replaces && v.decision === 'НЕ ПРИНЯТО').length < 2)
            throw Error('Замена голоса требует двух отрицательных ревью этого помощника и пояснения по фактам.');
        } else {
          if (!['codex', 'antigravity', 'grok'].includes(a.who)) throw Error('Неверный участник.');
          if ((c.designVotes || []).some(v => v.who === a.who && v.job_id === a.job_id)) throw Error('Это ревью замысла уже записано.');
          const j = stores.review(a.who, a.job_id, null, null, a.decision, c.requestMark, c.designHash);
          systemic(c, a.who, a.job_id, j.reviewText);
        }
        c.designVotes ||= [];
        c.designVotes.push({ who: a.who, job_id: a.job_id, replaces: a.replaces, decision: a.decision, note: a.note, designHash: c.designHash });
        save(this.changeFile(a.name), c);
        return 'Голос по замыслу ' + c.designHash + ' записан: ' + a.decision;
      }
      if (a.action === 'commit') {
        if (c.request && ['codex', 'antigravity'].some(who => {
          const v = (c.designVotes || []).filter(v => (v.replaces || v.who) === who).at(-1);
          return v?.decision !== 'ПРИНЯТО' || v.designHash !== c.designHash;
        })) throw Error('Сначала ворота замысла: нужно ПРИНЯТО от Codex и Antigravity по замыслу ' + c.designHash +
          '\n' + require('./precheck').designVoteWarnings(c).map((w) => '- ' + w).join('\n'));
        if (!a.message?.trim()) throw Error('Нужно сообщение коммита.');
        const self = this.precheck(p);
        // Отпечаток прогона Grok (team-v9 Р1): кандидат должен совпасть с проверенным содержимым.
        if (a.fingerprint) {
          const now = require('./fingerprint').fingerprint(folder);
          if (now !== a.fingerprint.trim()) throw Error('Содержимое изменилось после прогона тестов: отпечаток ' + now + ', прогон был на ' + a.fingerprint.trim() + '. Повторите прогон.');
        }
        git(folder, ['add', '-A']);
        git(folder, ['-c', 'commit.gpgsign=false', 'commit', '-m', a.message]);
        c.candidate = git(folder, ['rev-parse', 'HEAD']).trim();
        c.candidateDesignHash = c.designHash;
        c.verdicts = [];
        c.status = 'ожидает ревью';
        save(this.changeFile(a.name), c);
        return 'Кандидат: ' + c.candidate + '\nБаза: ' + c.base + '\nПрежние вердикты аннулированы.\n' + self;
      }
      if (a.action === 'verdict') {
        this.checkPair(a, p);
        if (!clean(folder)) throw Error('Рабочая копия грязная; сначала зафиксируйте изменения.');
        if (!['ПРИНЯТО', 'НЕ ПРИНЯТО', 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ'].includes(a.decision))
          throw Error('Неизвестный вердикт.');
        if (a.who === 'user') {
          if (a.decision !== 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ' || !participants.includes(a.replaces) || !a.quote?.trim())
            throw Error('Решение пользователя требует точной цитаты и одного заменяемого участника.');
        } else {
          if (![...participants, 'grok'].includes(a.who) || a.decision === 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ')
            throw Error('Неверный участник или вид решения.');
          if (a.who !== 'claude') {
            const j = stores.review(a.who, a.job_id, a.base, a.candidate, a.decision, c.requestMark);
            systemic(c, a.who, a.job_id, j.reviewText);
          }
        }
        const target = a.who === 'user' ? a.replaces : a.who;
        c.verdicts = c.verdicts.filter((v) => (v.replaces || v.who) !== target);
        c.verdicts.push({
          who: a.who,
          base: a.base,
          candidate: a.candidate,
          decision: a.decision,
          job_id: a.job_id,
          replaces: a.replaces,
          quote: a.quote,
          note: a.note,
          at: new Date().toISOString(),
        });
        save(this.changeFile(a.name), c);
        return 'Вердикт записан для ' + target + ': ' + a.decision;
      }
      if (a.action === 'merge') {
        if (c.request && (c.candidateDesignHash !== c.designHash ||
          ['codex', 'antigravity'].some(who => {
            const vote = (c.designVotes || []).filter(v => (v.replaces || v.who) === who).at(-1);
            return vote?.decision !== 'ПРИНЯТО' || vote.designHash !== c.designHash;
          }))) throw Error('Замысел изменён или не принят: нужны новый commit и новые вердикты.');
        let lessonText = '';
        try { lessonText = git(folder, ['show', p.candidate + ':lessons.md']); } catch {}
        // Обновляем системные замечания завершившегося Grok до их проверки.
        for (const phase of ['design', 'verdict']) {
          const v = c[phase === 'design' ? 'grokDesign' : 'grokVerdict'];
          if (v?.job_id && require('./grok-gate').bound(v, c, phase))
            await require('./grok-gate').record(c, phase, { job_id: v.job_id });
        }
        save(this.changeFile(a.name), c);
        if (c.systemic?.length) {
          const diff = git(folder, ['diff', '--no-ext-diff', '--no-textconv', c.base, p.candidate, '--', 'lessons.md']);
          const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
          const files = git(folder, ['diff', '--name-only', c.base, p.candidate]);
          let open = false;
          for (const v of c.verdicts.filter(v => v.who === 'claude' && v.candidate === p.candidate)) {
            const n = v.note?.match(/системное — открыто в уроке (\d+)/)?.[1];
            if (n) { try { open ||= new RegExp('^## ' + n + '\\.', 'm').test(git(folder, ['show', p.candidate + ':lessons.md'])); } catch {} }
          }
          const unresolved = c.systemic.filter(v => !(v.who === 'grok' && require('./grok-gate').paragraph(lessonText, v.job_id.slice(0, 8), ['Отклонено:'])));
          const missing = unresolved.filter(v => v.who === 'grok'
            ? !require('./grok-gate').paragraph(lessonText, v.job_id.slice(0, 8), ['closed'])
            : !added.includes(v.job_id.slice(0, 8)));
          if (unresolved.length && !open && (missing.length || !(added.includes('Где закрыто:') && added.includes('Проверка') && /^(rules|skill|common|servers|tools|tests)\//m.test(files))))
            throw Error('Не закрыты системные замечания; задания без подтверждённого урока: ' + (missing.length ? missing : unresolved).map(v => v.who + ' ' + v.job_id).join(', '));
        }
        if (hash(this.root) !== c.base) throw Error('main ушёл вперёд: требуется новая база и новое ревью.');
        if (c.candidate !== p.candidate) throw Error('Кандидат изменён: прежние вердикты недействительны.');
        if (!clean(folder) || !clean(this.root, true)) throw Error('Рабочая копия или корень репозитория грязные.');
        if (git(this.root, ['branch', '--show-current']).trim() !== 'main')
          throw Error('В корне должна быть выбрана main.');
        for (const who of participants) {
          const v = c.verdicts.find(
            (v) =>
              v.base === c.base &&
              v.candidate === p.candidate &&
              ((v.who === who && v.decision === 'ПРИНЯТО') ||
                (v.who === 'user' && v.replaces === who && v.decision === 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ' && v.quote?.trim())),
          );
          if (!v) throw Error('Нет действующего принятия: ' + who);
          if (v.who !== 'user' && who !== 'claude') stores.review(who, v.job_id, c.base, p.candidate, 'ПРИНЯТО', c.requestMark);
        }
        await require('./grok-gate').check(c, lessonText);
        save(this.changeFile(a.name), c);
        git(this.root, ['fetch', '--no-tags', '--', folder, 'change/' + a.name]);
        if (
          git(this.root, ['rev-parse', 'FETCH_HEAD']).trim() !== p.candidate ||
          !clean(folder) ||
          hash(this.root) !== c.base
        )
          throw Error('Кандидат или база изменились во время проверки.');
        git(this.root, ['merge', '--ff-only', 'FETCH_HEAD']);
        c.status = 'слито';
        c.mergedAt = new Date().toISOString();
        save(this.changeFile(a.name), c);
        return 'Слито в main: ' + p.candidate;
      }
      throw Error('Неизвестное действие.');
    });
  }
  changesText() {
    const dir = inside(this.root, '.work');
    if (!fs.existsSync(dir)) return 'Открытых изменений нет.';
    return (
      fs
        .readdirSync(dir)
        .filter((n) => /^[a-z0-9-]{1,40}$/.test(n))
        .map((n) => {
          try {
            const folder = this.clone(n),
              candidate = git(folder, ['rev-parse', 'HEAD']).trim(),
              file = this.changeFile(n),
              c = fs.existsSync(file) ? read(file) : null;
            return (
              (c ? (c.title ? c.title + ' (' + c.name + ')' : c.name) : n) +
              ': ' +
              candidate +
              '; ' +
              (clean(folder) ? 'чисто' : 'есть изменения') +
              '; ' +
              (c?.status || 'нет карточки team') +
              '\n' + (c ? requestText(c) : '') + 'Grok: ' + (c ? require('./summary').grokText(c) : 'не запрошен') + '\nВердикты: ' +
              (c?.verdicts
                .map((v) => (v.replaces || v.who) + ': ' + v.decision + (v.candidate === candidate ? '' : ' (устарел)'))
                .join('; ') || 'нет')
            );
          } catch (e) {
            return n + ': ' + e.message;
          }
        })
        .join('\n') || 'Открытых изменений нет.'
    );
  }
  // Уборка после последней установки (team-v10 Р5): только основной сервер; MOST_AFTER_DEPLOY=off выключает (тесты).
  async afterDeploy(waitMs = 0) {
    if (require('./access').guest() || process.env.MOST_AFTER_DEPLOY === 'off') return 'уборка после установки: не на этом сервере';
    return require('./after-deploy').afterLatest({ root: this.root, waitMs });
  }
  async status(claudeQuota, claudeUsage, notifyTest, full = false, scope = {}) {
    require('./access').guard('team', 'team_status', { claude_quota: claudeQuota, claude_usage: claudeUsage, notify_test: notifyTest });
    // Повтор отложенной уборки после установки — без ожидания, сводка не задерживается.
    this.afterDeploy().catch(() => {});
    if (claudeUsage) {
      if (!['calls', 'written', 'reread', 'window_h'].every(k => Number.isFinite(claudeUsage[k]) && claudeUsage[k] >= 0) || !claudeUsage.window_h || !claudeUsage.source?.trim() || !Number.isFinite(Date.parse(claudeUsage.taken_at))) throw Error('Некорректный замер сеанса Claude.');
      claudeQuota = claudeUsage;
    }
    const rows = ['Хранилище состояния: ' + stateDir],
      seenOwners = new Set();
    const section = async (title, fn) => {
      rows.push(title + ':');
      try {
        await fn();
      } catch (e) {
        rows.push(title + ': ошибка: ' + require('./errors').errorText(e));
      }
    };
    const file = path.join(this.state, 'claude-quota.json');
    if (claudeQuota) {
      if (
        (claudeQuota.calls === undefined && !Number.isFinite(claudeQuota.percent)) ||
        claudeQuota.percent < 0 ||
        claudeQuota.percent > 100 ||
        !claudeQuota.source?.trim() ||
        !Number.isFinite(Date.parse(claudeQuota.taken_at)) ||
        (claudeQuota.resets_at && !Number.isFinite(Date.parse(claudeQuota.resets_at)))
      )
        throw Error('Некорректный снимок квоты Claude.');
      await section('Сохранение квоты Claude', () =>
        deployer.locked(this.root, async () => {
          const old = fs.existsSync(file) ? read(file) : null;
          if (!old || Date.parse(old.taken_at) <= Date.parse(claudeQuota.taken_at)) save(file, claudeQuota);
        }),
      );
    }
    await section('Проверка этапов', () => deployer.locked(this.root, async () => {
      for (const w of this.works().filter(w => !w.error)) await this.refreshWork(this.workFile(w.name));
    }));
    const quota = await require('./quota-line').quotaLine({ state: this.state, binary: process.env.CODEX_PATH || findCodex(), advice: !full, agyModel: scope.agy_model });
    const warning = [require('./server-instructions').read().warning, require('./work-owner').reminder(this.root, undefined, scope)].filter(Boolean).join('\n');
    if (!full) {
      const text = await require('./summary').compact(this, quota);
      return (warning ? warning + '\n' : '') + text + (notifyTest ? '\nПробное уведомление: ' + await require('./notify').notify('Связка: пробное уведомление', 'Уведомления команды работают.') : '');
    }
    rows.push(quota);
    if (warning) rows.unshift(warning);
    await section('Нагрузка', () => rows.push(require('./summary').loadLine(this.state, Object.fromEntries(['codex', 'antigravity', 'grok'].map(who => [who, stores.list(who).jobs])))));
    for (const who of ['codex', 'antigravity']) {
      await section('Поручения ' + who, async () => {
        const { jobs, errors } = stores.list(who),
          recent = jobs.filter((j) => !j.archived && Date.parse(j.startedAt) > Date.now() - 18000000);
        if (who === 'antigravity')
          rows.push(
            'Antigravity за 5 ч: ' +
              recent.length +
              ' поручений; токены: ' +
              recent.reduce((n, j) => n + (Number(j.usage?.total_tokens) || 0), 0) +
              '; последнее исчерпание: ' +
              (jobs
                .map((j) => j.lastQuotaAt)
                .filter(Boolean)
                .sort()
                .at(-1) || 'не зафиксировано'),
          );
        rows.push(who + ': карточек ' + jobs.length + ', архивных ' + jobs.filter((j) => j.archived).length + '.');
        for (const j of jobs) {
          const locks = require('./locks'),
            owner = await locks.ownerState(j.owner);
          if (j.owner?.instance && !seenOwners.has(j.owner.instance)) {
            seenOwners.add(j.owner.instance);
            const live = await locks.probe(locks.pipeName('instance', j.owner.instance));
            if (live.state === 'alive' && live.info?.version) {
              let disk = 'не установлена';
              try {
                if (live.info.file) disk = read(path.resolve(path.dirname(live.info.file), '../../package.json')).version;
              } catch {}
              rows.push(
                who +
                  ': версия процесса ' +
                  live.info.version +
                  '; на диске ' +
                  disk +
                  (disk === live.info.version ? '; совпадают' : '; требуется сверка и перезапуск'),
              );
            }
          }
          if (
            !['running', 'queued', 'waiting_quota', 'needs_decision', 'cancelling', 'stop_unconfirmed'].includes(j.status)
          )
            continue;
          rows.push(
            format(
              who === 'codex' ? 'Codex' : 'Antigravity',
              { ...j, status: j.archived ? 'lost' : owner === 'dead' && ['running', 'cancelling', 'stop_unconfirmed'].includes(j.status) ? (who === 'codex' && j.write ? 'needs_decision' : 'lost') : j.status },
              'Владелец: ' +
                { alive: 'отвечает', self: 'текущий процесс', dead: 'не отвечает', unknown: 'не подтверждён' }[owner] +
                (j.nextAttemptAt ? '; следующая проба: ' + j.nextAttemptAt : ''),
              'Проверьте состояние через адаптер.',
            ),
          );
        }
        rows.push(...jobs.filter(j => j.status === 'migration_conflict').map(j =>
          'ПЕРЕНОС: КОНФЛИКТ · ' + who + ' · ' + j.id));
        rows.push(...errors.map((e) => 'Ошибка чтения: ' + e));
      });
    }
    await section('Перенос хранилища', async () => {
      const log = path.join(stateDir, 'migration.log');
      if (fs.existsSync(log)) {
        const migration = read(log);
        for (const error of migration.errors || []) rows.push('Ошибка переноса · ' + (error.id || 'хранилище') + ' · ' + error.error);
        for (const conflict of migration.conflicts || []) {
          rows.push('ПЕРЕНОС: КОНФЛИКТ · ' + conflict.kind + ' · ' + conflict.id);
        }
      }
    });
    await section('Карантин переноса', async () => {
      const dir = path.join(stateDir, 'quarantine');
      if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) {
        try {
          const card = read(inside(stateDir, 'quarantine', id, 'card.json'));
          rows.push('ПЕРЕНОС: ПОВРЕЖДЁН · ' + card.id + ' · ' + (card.migration?.reason || 'Причина не указана'));
        } catch (error) { rows.push('Ошибка чтения карантина · ' + id + ' · ' + error.message); }
      }
      const failure = path.join(stateDir, 'migration-error.json');
      if (fs.existsSync(failure) && read(failure).error) rows.push('Ошибка сверки хранилища · ' + read(failure).error);
    });
    await section('Grok', async () => rows.push(await new (require('./grok').Grok)().status()));
    await section('Работы', async () => rows.push(...this.works().map(workText)));
    await section('Репозиторий', async () => {
      rows.push(
        'main / версия правил: ' + hash(this.root),
        'Корень: ' + (clean(this.root) ? 'чисто' : 'есть изменения'),
        this.changesText(),
      );
    });
    await section('Релизы', async () => {
      const marker = inside(this.root, 'live', 'deployed.json');
      rows.push('Последнее развёртывание: ' + (fs.existsSync(marker) ? [read(marker).commit, read(marker).at, read(marker).method || 'способ не записан'].join(' · ') : 'не записано'));
      const op = require('./deploy-ops').list(this.root).at(-1);
      if (op) rows.push(['Установка ' + op.id + ': ' + op.status, op.reason || op.message, op.restart, require('./deploy-ops').cleanupLine(op.cleanup)].filter(Boolean).join(' · '));
    });
    await section('Настройки', async () => {
      rows.push(require('./client-configs').status());
      for (const config of deployer.configPaths()) {
        if (!fs.existsSync(config)) {
          rows.push('Файл настроек отсутствует: ' + config);
          continue;
        }
        try {
          const s = deployer.snapshot(config);
          rows.push(
            'Файл настроек ' +
              config +
              ': ' +
              ['antigravity', 'codex', 'team', 'grok']
                .map((n) => n + ' → ' + (s.config.mcpServers?.[n]?.args?.join(' ') || 'не подключён'))
                .join('; '),
          );
        } catch (e) {
          rows.push('Настройки: ' + e.message);
        }
      }
    });
    await section('Версия team', async () => {
      rows.push(
        'team: версия процесса 0.5.8; версия на диске ' +
          read(path.join(__dirname, '../package.json')).version +
          '; файл процесса: ' +
          path.join(__dirname, '../servers/team/index.js'),
      );
      rows.push(
        'Версии помощников сверяются по доступным каналам владельцев поручений; без такого канала версия процесса не подтверждена. Дополнительная проверка: codex_status и antigravity_status.',
      );
    });
    if (notifyTest) rows.push('Пробное уведомление: ' + await require('./notify').notify('Связка: пробное уведомление', 'Уведомления команды работают.'));
    return rows.join('\n');
  }
}

function findCodex() {
  try {
    return require('child_process')
      .execFileSync(
        process.platform === 'win32' ? 'where.exe' : 'which',
        [process.platform === 'win32' ? 'codex.exe' : 'codex'],
        { encoding: 'utf8', windowsHide: true },
      )
      .trim()
      .split(/\r?\n/)[0];
  } catch {}
  try {
    const dir = path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin');
    return (
      fs
        .readdirSync(dir)
        .map((n) => path.join(dir, n, 'codex.exe'))
        .filter((f) => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
    );
  } catch {
    return null;
  }
}
module.exports = { Team, percent, workText, workBrief, acceptedMessage, findCodex };
