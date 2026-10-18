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
const requestText = c => c.request ? 'Запрос пользователя ' + c.requestMark + ':\n' + c.request + (c.fast ? '\nМалая правка, карточка sha256 ' + c.cardHash + ':\n' + c.note + '\nМалая ли правка — обязательный вопрос ревью.\n' : '\nЗамысел: ' + c.designFile + ', sha256 ' + c.designHash + '\n') : 'запрос не сохранён (изменение начато до ворот запроса)\n';
function refreshDesign(c) {
  if (!c.request || c.fast) return;
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
  async refreshWork(file, { readOnly = false, snapshot } = {}) {
    const w = this.readWork(file);
    if (w.error) return w;
    const before = JSON.stringify(w);
    for (const s of w.stages.filter(s => s.level && ['принят', 'выдан без принятия'].includes(s.state))) {
      const old = structuredClone(s);
      try { s.gate.message = await require('./stage-gate').evaluate(w, s, old, undefined, snapshot); delete s.gate.warning; }
      catch (e) { stageFailure(s, old, old, e); }
    }
    if (w.closed && w.stages.some(s => !['принят', 'выдан без принятия'].includes(s.state))) w.closed = false;
    if (!readOnly && JSON.stringify(w) !== before) {
      if (JSON.stringify(w.stages.map(s => s.state)) !== JSON.stringify(JSON.parse(before).stages.map(s => s.state))) w.revision++;
      save(file, w);
    }
    return w;
  }
  async work(a) {
    require('./access').guard('team', 'team_work', a);
    if (a.action === 'create' && !a.owner?.trim()) throw Error('Для новой работы нужна метка владельца owner.');
    if (a.action === 'list') return deployer.locked(this.root, async () => {
      const snapshot = require('./job-snapshot').create();
      const works = await Promise.all(this.works().map(w => w.error ? w : this.refreshWork(this.workFile(w.name), { snapshot })));
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
      const snapshot = require('./job-snapshot').create();
      const current = await this.refreshWork(file, { snapshot });
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

        await require('./work-owner').reconcileJobs(a.name);
        const heartbeat = Date.parse(old.heartbeat_at || old.updated_at);
        const mode = require('./user-word').mode(), conductor = require('./fallback').session(a);
        if (conductor?.active) {
          // team-v19 К3: дирижёр запасного режима забирает работу без 60 минут тишины и при живых поручениях.
        } else if (!require('./access').guest() && mode.returned && old.owner && old.owner === mode.owner) {
          // После возврата Claude забирает работу, когда дирижёр остановился (handover) или 15 минут не вызывал ничего по ней.
          if (!mode.handover && Number.isFinite(heartbeat) && Date.now() - heartbeat < 900000)
            throw Error('Дирижёр ещё работает (последний вызов ' + new Date(heartbeat).toTimeString().slice(0, 5) + '): claim — после его team_word handover или 15 минут тишины.');
        } else if (!Number.isFinite(heartbeat) || Date.now() - heartbeat <= 3600000 ||
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
      // team-v19 К4 (г), К4а: поле continuation ставит только сервер; дирижёр не добавляет anthropic в author.
      const fallback = require('./fallback'), conductor = require('./access').guest() ? fallback.session(a) : null;
      if (a.stages !== undefined) for (const s of w.stages) delete s.continuation;
      // Порядок ключей не важен: схема zod переставляет их в ответе через MCP (помощник с чистой памятью, Б2).
      const same = require('./client-configs').equal;
      if (conductor?.active && a.stages) for (const s of a.stages) {
        const prev = s.id ? old?.stages.find(p => p.id === s.id) : old?.stages.find(p => p.title === s.title);
        if (fallback.hasAnthropic(s.author ?? prev?.author) && (!prev || !same(prev.author ?? null, s.author ?? prev.author ?? null)))
          throw Error('Запасной режим: дирижёр не добавляет anthropic в author; этап, начатый Claude, — continue_stage.');
        // Этап Claude (anthropic в author, не продолжение) дирижёр не дописывает и принимает только с material, равным снимку
        // (Grok cfb0705b Б1, помощник Б1); иначе — continue_stage.
        if (!prev || !fallback.hasAnthropic(prev.author) || prev.continuation) continue;
        for (const k of ['material', 'version', 'source_jobs', 'partial_sources', 'accept_criteria', 'artifact_manifest'])
          if (s[k] !== undefined && !same(s[k], prev[k] ?? null))
            throw Error('Запасной режим: этап Claude «' + prev.title + '» дирижёр не дописывает — ' + k + ' не меняется; продолжение — continue_stage.');
        if ((s.state === 'принят' || s.criterion_met) && prev.state !== 'принят') {
          const snap = fallback.readSnapshot(conductor.word.id), from = snap?.works?.find(x => x.name === old.name)?.stages?.find(x => x.id === prev.id);
          const root = old.folder || require('./paths').repoRoot, hash = f => { try { return sha(fs.readFileSync(path.resolve(root, f))); } catch { return null; } };
          const equalToSnapshot = from && same((prev.material || []).slice().sort(), from.material.map(m => m.path).sort()) && from.material.every(m => m.sha256 && hash(m.path) === m.sha256);
          if (!equalToSnapshot) throw Error('Запасной режим: этап Claude «' + prev.title + '» принимается только с material, равным снимку ' + conductor.word.id + '; иначе — continue_stage.');
        }
      }
      if (a.continue_stage !== undefined) {
        if (!old) throw Error('continue_stage — только для существующей работы.');
        const plan = fallback.continuation(w, old, a);
        w.stages = plan.stages;
        a.plan_change = a.plan_change ? a.plan_change + '; ' + plan.plan_change : plan.plan_change;
      }
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
        // team-v19 К4: замок этапа знает, что вызов — от дирижёра запасного режима.
        const ctx = require('./request-context').context;
        try { msg = await ctx.run({ ...(ctx.getStore() || {}), fallbackConductor: conductor?.active ? conductor : null }, () => gate.evaluate(w, s, previous)); delete s.gate.warning; }
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
          if (!git(this.root, ['ls-tree', '--name-only', commit, '--', file]).trim()) return p === 'brief' ? 'Памятка не найдена. Части: brief — памятка; common — общие правила; claude — дирижёр; antigravity — работа с текстом; roles — распределение ролей; fallback — запасной режим, когда Claude отвалился; all — полные правила.' : 'в main нет ' + file;
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
    if (a.who === 'grok' || a.action === 'grok_slot') throw Error(require('./members').grokDisabled);
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
      if (a.restart_claude) {
        const live = await require('./live-jobs').running({ stateDir: path.dirname(this.state) });
        if (live.length) throw Error('Установка с перезапуском Claude не начата: перезапуск оборвёт идущие поручения — ' + require('./live-jobs').describe(live) + '. Дождитесь их окончания и повторите. Без перезапуска (restart_claude=false) настройки переключатся, а новые серверы заработают после следующего перезапуска Claude.');
      }
      const pending = require('./deploy-ops').list(this.root).find(op => !require('./deploy-ops').terminal.includes(op.status));
      if (pending) throw Error('Идёт установка ' + pending.id);
      let deployedCommit = null;
      const deployed = await deployer.locked(this.root, async () => {
        // Разрешение владельца раньше обслуживания замка Git и любых действий выпуска.
        const readOnlyGit = (root, args) => git(root, args, { recoverIndex: false });
        const commit = hash(this.root, a.commit || 'main', readOnlyGit);
        deployedCommit = commit;
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
      // team-v19 К12: гости старых релизов в открытых Codex и Antigravity — одной строкой отчёта.
      let stale = '';
      try { stale = require('./client-configs').staleGuests({ root: this.root, release: deployedCommit }, this.staleDeps || {}); } catch {}
      const out = deployed + (stale ? '\n' + stale : '');
      // team-v10 Р5: без перезапуска уборку выполняет этот же вызов, уже отпустив замок установки;
      // с перезапуском — новый сервер после готовности.
      if (!a.restart_claude && /: завершено\./.test(out)) return out + '\n' + await this.afterDeploy();
      return out;
    }
    if (a.action === 'rollback') return deployer.rollback({ root: this.root });
    if (a.action === 'list') return this.changesText();
    if (a.action === 'cleanup') {
      if (!a.owner?.trim()) throw Error('Для уборки нужна метка владельца owner.');
      if (a.apply === true) await require('./restart-hold').cleanup(path.dirname(this.state));
      const c = require('./cleanup');
      const run = () => c.cleanupText(c.cleanup({ root: this.root, apply: a.apply === true, owner: a.owner }, this.cleanupDeps || {}));
      return a.apply === true ? deployer.locked(this.root, run) : run();
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
        if (!a.fast && (!path.isAbsolute(a.design_file || '') || !fs.statSync(a.design_file).isFile())) throw Error('Нужен абсолютный путь существующего файла замысла.');
        const design = { request, requestMark: '#' + sha(request).slice(0, 8), ...(a.fast ? { fast: true, note: require('./precheck').fastNote(a.note), cardHash: sha(a.note.trim()) } : { designFile: a.design_file, designHash: sha(fs.readFileSync(a.design_file)), designVotes: [] }) };
        const folder = inside(this.root, '.work', a.name),
          file = this.changeFile(a.name);
        if (fs.existsSync(file) && a.fast) {
          const prior = read(file);
          if (!prior.fast || ['слито', 'закрыто без слияния'].includes(prior.status)) throw Error('Нельзя менять режим или закрытое изменение.');
          if (prior.work) require('./work-owner').touch(prior.work, a.owner, this.root);
          else if (prior.owner && prior.owner !== a.owner) throw Error('Изменение принадлежит другому владельцу.');
          if (prior.note !== design.note || prior.request !== request) {
            Object.assign(prior, design, { verdicts: [], status: 'карточка изменена' });
            delete prior.candidateCardHash;
            save(file, prior);
          }
          return 'Карточка малой правки сохранена; при изменении прежние принятия аннулированы.\n' + requestText(prior);
        }
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
      if (c.fast) {
        require('./precheck').fastNote(c.note);
        const currentCard = sha(c.note.trim());
        if (c.cardHash !== currentCard) { c.cardHash = currentCard; c.verdicts = []; delete c.candidateCardHash; save(this.changeFile(a.name), c); }
        if (a.action === 'design') throw Error('У малой правки нет ворот замысла; карточка меняется повторным start fast=true.');
        if (['verdict', 'merge'].includes(a.action) && c.candidateCardHash !== c.cardHash) {
          c.verdicts = []; save(this.changeFile(a.name), c);
          throw Error('Карточка изменена: нужны новый commit и новые вердикты.');
        }
      }
      if (a.title !== undefined && ['design', 'verdict', 'commit'].includes(a.action)) c.title = a.title;
      if ((['design', 'commit', 'merge'].includes(a.action) || (a.action === 'grok_slot' && a.phase === 'design')) && c.request) { refreshDesign(c); save(this.changeFile(a.name), c); }
      if (a.action === 'grok_slot') return this.grokSlot(a, p);
      // team-v18 К4: голос Grok на месте выпавшего — только по поручению grok_slot.
      if (['design', 'verdict'].includes(a.action) && a.who === 'grok' && a.replaces) return this.grokSlotVote(a, p);
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
          if (!require('./members').helpers.includes(a.who)) throw Error('Неверный участник.');
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
        // team-v18 К3: места Codex и Antigravity — одной функцией с verdict, merge и precheck.
        const seats = require('./team-seats');
        if (!c.fast && c.request && seats.SEATS.some(who => !seats.seat(c, who, 'design').closed)) throw Error('Сначала ворота замысла: нужно ПРИНЯТО от Codex и Antigravity по замыслу ' + c.designHash +
          '\n' + require('./precheck').designVoteWarnings(c).map((w) => '- ' + w).join('\n'));
        if (!a.message?.trim()) throw Error('Нужно сообщение коммита.');
        const fastTree = c.fast ? require('./precheck').checkFast(folder, c.base, undefined, true).tree : null;
        const self = this.precheck(p);
        // Отпечаток прогона Grok (team-v9 Р1): кандидат должен совпасть с проверенным содержимым.
        if (a.fingerprint) {
          const now = require('./fingerprint').fingerprint(folder);
          if (now !== a.fingerprint.trim()) throw Error('Содержимое изменилось после прогона тестов: отпечаток ' + now + ', прогон был на ' + a.fingerprint.trim() + '. Повторите прогон.');
        }
        git(folder, ['add', '-A']);
        if (fastTree && git(folder, ['write-tree']).trim() !== fastTree) throw Error('Содержимое изменилось во время проверки малой правки; повторите commit.');
        git(folder, ['-c', 'commit.gpgsign=false', 'commit', ...(c.fast && c.candidateCardHash !== c.cardHash ? ['--allow-empty'] : []), '-m', a.message]);
        c.candidate = git(folder, ['rev-parse', 'HEAD']).trim();
        if (c.fast) c.candidateCardHash = c.cardHash;
        else c.candidateDesignHash = c.designHash;
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
            if (c.fast && !(j.task || j.poruchenie || '').includes(c.cardHash)) throw Error('В поручении ревью нужен sha256 карточки малой правки.');
            systemic(c, a.who, a.job_id, j.reviewText);
          }
        }
        const target = a.who === 'user' ? a.replaces : a.who;
        // team-v18 К3: история записей места хранится целиком; новая запись прежнюю не удаляет.
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
        if (a.who === 'user') return 'Решение пользователя записано в историю для ' + target + ': место им не закрывается — нужно ПРИНЯТО участника.';
        return 'Вердикт записан для ' + target + ': ' + a.decision;
      }
      if (a.action === 'merge') {
        const seats = require('./team-seats');
        if (c.fast) {
          require('./precheck').checkFast(folder, c.base, p.candidate);
          for (const v of c.verdicts.filter(v => ['codex', 'antigravity'].includes(v.who) && v.base === c.base && v.candidate === p.candidate)) {
            const j = stores.review(v.who, v.job_id, c.base, p.candidate, v.decision, c.requestMark);
            if (/\[блокирующее\][^\r\n]*не малая/i.test(j.reviewText)) throw Error('не малая правка — нужен замысел; team_change start без fast.');
          }
        }
        if (!c.fast && c.request && (c.candidateDesignHash !== c.designHash || seats.SEATS.some(who => !seats.seat(c, who, 'design').closed)))
          throw Error('Замысел изменён или не принят: нужны новый commit и новые вердикты.' +
            seats.SEATS.map(who => seats.seatError(c, who, 'design')).filter(Boolean).map(e => '\n' + e).join(''));
        let lessonText = '';
        try { lessonText = git(folder, ['show', p.candidate + ':lessons.md']); } catch {}

        if (c.systemic?.length) {
          const diff = git(folder, ['diff', '--no-ext-diff', '--no-textconv', c.base, p.candidate, '--', 'lessons.md']);
          const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
          const files = git(folder, ['diff', '--name-only', c.base, p.candidate]);
          let open = false;
          for (const v of c.verdicts.filter(v => v.who === 'claude' && v.candidate === p.candidate)) {
            const n = v.note?.match(/системное — открыто в уроке (\d+)/)?.[1];
            if (n) { try { open ||= new RegExp('^## ' + n + '\\.', 'm').test(git(folder, ['show', p.candidate + ':lessons.md'])); } catch {} }
          }
          const unresolved = c.systemic.filter(v => v.who !== 'grok');
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
        // team-v18 К3: решение Claude и по каждому обязательному месту — ПРИНЯТО участника или Grok на месте выпавшего;
        // «РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ» место не закрывает.
        const decision = c.verdicts.filter(v => v.who === 'claude' && v.base === c.base && v.candidate === p.candidate).at(-1);
        if (decision?.decision !== 'ПРИНЯТО') throw Error('Нет действующего принятия: claude');
        for (const [phase, candidate] of [['verdict', p.candidate], ['design', c.candidate]]) {
          if (phase === 'design' && (!c.request || c.fast)) continue;
          for (const who of seats.SEATS) {
            const error = seats.seatError(c, who, phase, candidate);
            if (error) throw Error(error);
            const st = seats.seat(c, who, phase, candidate);
            if (st.by === 'grok') {
              seats.verifySlot(c, phase, who, st.record.job_id, 'ПРИНЯТО', { state: this.state, candidate });
              const late = seats.storeRefusal(c, who, phase, candidate);
              if (late) throw Error('Позднее «НЕ ПРИНЯТО» ' + who + ' (' + late.id + ') по этой редакции: слияние остановлено до разбора.');
            } else if (phase === 'verdict') stores.review(who, st.record.job_id, c.base, p.candidate, 'ПРИНЯТО', c.requestMark);
          }
        }

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
  // team-v18 К2: слово пользователя «X отвалился» — запись дословно и список. Писать может только клиент claude.
  async word(a) {
    require('./access').guard('team', 'team_word', a);
    const words = require('./user-word'), fallback = require('./fallback');
    if (a.action === 'list') return words.listText();
    // team-v19: слово о Claude, возврат, остановка дирижёра и перепривязка — запасной режим (К1, К2).
    if (a.action !== 'record' || a.who_down === 'claude') return fallback.word(a, this.fallbackDeps || {});
    const guestWord = await fallback.helperWord(a);
    if (guestWord) return guestWord;
    const { text } = await words.record(a);
    const down = require('./team-seats').down();
    return text + (down.length >= 2 ? '\nНедоступны двое: ' + down.map(w => words.NAMES[w]).join(', ') +
      ' — изменение связки ждёт возврата одного из них; обычные работы идут, если доступны два проверяющих других семей.' : '');
  }
  // team-v18 К4: Grok на место выпавшего Codex или Antigravity. Поручение создаёт сервер по собранному им материалу.
  async grokSlot(a, p) {
    const seats = require('./team-seats'), words = require('./user-word'), gate = require('./grok-gate');
    const { c, folder } = p, phase = a.phase, who = a.slot, name = seats.NAMES[who], file = this.changeFile(a.name);
    if (!c.request) throw Error('В старом изменении запрос и замысел не сохранены.');
    if (!['design', 'verdict'].includes(phase)) throw Error('Укажите phase: design или verdict.');
    if (!seats.SEATS.includes(who)) throw Error('Место (slot): codex или antigravity.');
    if (phase === 'verdict') {
      if (c.candidate !== p.candidate || c.candidate === c.base) throw Error('Сначала зафиксируйте кандидата (commit).');
      if (!clean(folder)) throw Error('Рабочая копия грязная; сначала зафиксируйте изменения.');
    }
    const b = seats.binding(c, phase), st = seats.seat(c, who, phase);
    if (st.closed) throw Error('Место ' + name + ' по этой редакции уже закрыто.');
    // (б) Отказ выпавшего по этой редакции в силе — записанный или найденный в хранилище.
    const refusal = st.blocked && st.by === 'own' ? (st.record.job_id || 'записан') : seats.storeRefusal(c, who, phase)?.id;
    if (refusal) throw Error(name + ' уже сказал «НЕ ПРИНЯТО» по этой редакции (' + refusal + '): отказ в силе — новая редакция или design who=claude replaces после двух отказов.');
    if (st.blocked) throw Error(st.reason);
    // Совещательный отказ Grok по этой редакции: повторной попытки «пока не согласится» нет.
    const field = phase === 'design' ? 'grokDesign' : 'grokVerdict';
    if (c[field]?.job_id && gate.bound(c[field], c, phase) && ['running', 'queued', 'delivery_unclear'].includes(c[field].status)) {
      await gate.record(c, phase, { job_id: c[field].job_id });
      save(file, c);
    }
    if (c[field] && gate.bound(c[field], c, phase) && c[field].decision === 'НЕ ПРИНЯТО')
      throw Error('Grok уже сказал «НЕ ПРИНЯТО» по этой редакции обычным запросом (' + c[field].job_id + '): повторной попытки нет.');
    // Один Grok — одно место; выпали двое — изменение ждёт.
    if (words.active('grok')) throw Error('Изменение ждёт: недоступны ' + name + ', Grok; проверить вместо двоих некому.');
    const existing = seats.slots(c, phase, b), other = existing.find(s => s.seat !== who);
    if (other) throw Error('Grok уже назначен на место ' + seats.NAMES[other.seat] + ' этой редакции (поручение ' + other.job_id +
      '): второе место он не займёт, нужна новая редакция или возврат ' + name + '. Изменение ждёт: недоступны Codex, Antigravity; проверить вместо двоих некому.');
    for (const s of existing) {
      const j = stores.list('grok', false).jobs.find(j => j.id === s.job_id);
      if (!j || !['failed', 'lost', 'cancelled', 'stop_unconfirmed'].includes(j.status))
        throw Error('Grok уже на месте ' + name + ': поручение ' + s.job_id + ' (' + (require('./states')[j?.status] || j?.status || 'нет карточки') + ').');
    }
    // (а) Основание на момент проверки сохраняется до отмены поручений выпавшего.
    const basis = seats.basis(c, phase, who, Date.now());
    const slot = { id: 'slot-' + require('crypto').randomUUID().slice(0, 8), phase, seat: who, ...b, basis, word_id: basis.word_id,
      state: 'основание сохранено', at: new Date().toISOString() };
    (c.grokSlots ||= []).push(slot);
    save(file, c);
    const fail = message => { slot.state = 'не создано: ' + message; save(file, c); return Error(message); };
    const cancelled = [], waited = [];
    for (const j of seats.reviewJobs(c, who).filter(j => seats.PENDING.includes(j.status))) {
      if (j.status === 'running') throw fail(name + ' сейчас отвечает: поручение ' + j.id + ' идёт. Дождитесь ответа; зависшее отмените по прежним правилам и вызовите grok_slot снова.');
      if (['cancelling', 'stop_unconfirmed'].includes(j.status)) {
        let since = Date.parse(j.cancellingAt);
        if (!Number.isFinite(since)) try { since = fs.statSync(j.cardFile).mtimeMs; } catch { since = Date.now(); }
        if (Date.now() - since < seats.TEN_MIN) throw fail('Отмена идёт: поручение ' + j.id + ' (' + name + '); повторите grok_slot позже.');
        // Поручение-ревью только читает: отмена дольше 10 минут считается отменой; его поздний ответ — данные.
        waited.push(j.id);
        continue;
      }
      let after;
      try { after = await require('./job-cancel').cancel(who, j.id); }
      catch (e) { throw fail('Отмена поручения ' + j.id + ' не подтверждена: ' + e.message); }
      if (after.status !== 'cancelled') throw fail(after.status === 'running' ? name + ' сейчас отвечает: поручение ' + j.id + ' идёт.'
        : 'Отмена поручения ' + j.id + ' не подтверждена: ' + (require('./states')[after.status] || after.status) + '.');
      cancelled.push(j.id);
    }
    // (а) От слова до создания поручения Grok, включая ожидание отмены, у выпавшего нет успешного ответа ни по одной работе.
    const back = words.success(who, Date.parse(basis.word_at), Date.now());
    if (back) throw fail(name + ' ответил после слова (поручение ' + back.id + '): место не заменяется.');
    let content, elements;
    try {
      if (phase === 'design') {
        const bytes = fs.readFileSync(c.designFile);
        if (sha(bytes) !== c.designHash) throw Error('файл замысла изменён после записи хеша — повторите grok_slot');
        content = bytes.toString('utf8');
        elements = seats.headings(content);
      } else {
        // Полный дифф закреплённой пары, а не экранный diff с обрезкой.
        content = git(folder, ['diff', '--binary', '--no-ext-diff', '--no-textconv', c.base, c.candidate]);
        elements = git(folder, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', c.base, c.candidate]).split(/\r?\n/).filter(Boolean);
      }
    } catch (e) { throw fail('Материал не собран: ' + e.message.split('\n')[0]); }
    if (!elements.length) throw fail('Нет элементов покрытия: ' + (phase === 'design' ? 'в замысле нет разделов «##»' : 'дифф пуст') + '.');
    const text = seats.materialText({ c, phase, who, slotId: slot.id, elements, content, b }), materialSha = sha(text);
    const materialFile = path.join(this.state, 'changes', a.name, 'grok-slot-' + phase + '-' + who + '-' + slot.id + '.txt');
    atomic(materialFile, text);
    atomic(materialFile.replace(/\.txt$/, '.json'), JSON.stringify({ change: a.name, phase, seat: who, ...b, basis, word_id: basis.word_id,
      sha256: materialSha, coverage: elements, cancelled, waited }, null, 2) + '\n');
    Object.assign(slot, { materialFile, materialSha256: materialSha, coverage: elements, cancelled, waited });
    save(file, c);
    let job;
    const grok = new (require('./grok').Grok)();
    try { job = await grok.send({ task: seats.slotTask({ c, phase, who, slotId: slot.id, elements, b, materialSha }), text, role: 'проверка', opora: false }); }
    catch (e) { throw fail('Поручение Grok не создано: ' + e.message); }
    // Основание — на момент фактического создания поручения Grok: успешный ответ выпавшего в окне от проверки до создания
    // отменяет поручение Grok, место не заменяется.
    const stale = seats.basisAtCreation({ seat: who, basis, created_at: job.startedAt });
    if (stale) {
      try { await grok.cancel(job.id); } catch {}
      Object.assign(slot, { cancelled_job: job.id, created_at: job.startedAt });
      throw fail(stale + ': поручение Grok ' + job.id + ' отменено, место не заменяется.');
    }
    Object.assign(slot, { job_id: job.id, created_at: job.startedAt, state: 'создано' });
    save(file, c);
    return 'Grok на месте ' + name + ' (' + (phase === 'design' ? 'замысел ' + c.designHash.slice(0, 8) : 'пара ' + c.base.slice(0, 8) + '→' + c.candidate.slice(0, 8)) +
      '): поручение ' + job.id + ' — ' + (require('./states')[job.status] || job.status) + (job.reason ? ' (' + job.reason + ')' : '') + '.\n' +
      'Основание: ' + (basis.kind === 'слово' ? 'слово пользователя ' + basis.word_id : 'истёкшее слово ' + basis.word_id + ' и поручение ' + basis.job_id + ' (' + basis.job_status + ')') +
      ', проверено ' + basis.checked_at + '.\nМатериал: ' + materialFile + ', sha256 ' + materialSha + '; элементов покрытия: ' + elements.length + '.' +
      (cancelled.length ? '\nОтменены поручения ' + name + ': ' + cancelled.join(', ') + '.' : '') +
      (waited.length ? '\nОтмена дольше 10 минут считается отменой: ' + waited.join(', ') + '.' : '') +
      '\nПосле ответа: team_change ' + phase + ' who=grok replaces=' + who + ' job_id=' + job.id + ' decision=<вердикт>' + (phase === 'verdict' ? ' base candidate' : '') + '.';
  }
  // Голос Grok на месте выпавшего: привязка к grok_slot, сохранённый материал и раздел «## Покрытие».
  async grokSlotVote(a, p) {
    const seats = require('./team-seats'), { c, folder } = p, phase = a.action, who = a.replaces;
    if (!c.request) throw Error('В старом изменении запрос и замысел не сохранены.');
    if (!seats.SEATS.includes(who)) throw Error('Grok занимает только место codex или antigravity.');
    if (!['ПРИНЯТО', 'НЕ ПРИНЯТО'].includes(a.decision)) throw Error('Неизвестный вердикт.');
    if (phase === 'verdict') {
      this.checkPair(a, p);
      if (!clean(folder)) throw Error('Рабочая копия грязная; сначала зафиксируйте изменения.');
    }
    const list = phase === 'design' ? (c.designVotes ||= []) : (c.verdicts ||= []);
    if (list.some(v => v.who === 'grok' && v.job_id === a.job_id)) throw Error('Этот ответ Grok уже записан.');
    const grok = new (require('./grok').Grok)();
    if (!grok.has(a.job_id || '')) throw Error('Поручение Grok не найдено.');
    const current = await grok.refresh(a.job_id);
    if (current.status !== 'done') throw Error('Grok ещё не ответил (' + (require('./states')[current.status] || current.status) + '): голос записывается после ответа.');
    const { slot, text } = seats.verifySlot(c, phase, who, a.job_id, a.decision, { state: this.state, candidate: p.candidate });
    systemic(c, 'grok', a.job_id, text);
    list.push({ who: 'grok', replaces: who, job_id: a.job_id, decision: a.decision, slot: slot.id, ...seats.binding(c, phase, p.candidate), note: a.note, at: new Date().toISOString() });
    save(this.changeFile(a.name), c);
    return 'Голос Grok на месте ' + seats.NAMES[who] + ' записан: ' + a.decision + (a.decision === 'НЕ ПРИНЯТО' ? ' — слияние остановлено до новой редакции.' : '.');
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
              '\n' + (c ? requestText(c) : '') + '\nВердикты: ' +
              (c?.verdicts
                .map((v) => (v.who === 'grok' && v.replaces ? 'grok на месте ' + v.replaces : v.who === 'user' ? 'пользователь за ' + v.replaces : (v.replaces || v.who)) +
                  ': ' + v.decision + (v.candidate === candidate ? '' : ' (устарел)'))
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
    await require('./restart-hold').cleanup(path.dirname(this.state));
    return require('./after-deploy').afterLatest({ root: this.root, waitMs });
  }
  async status(claudeQuota, claudeUsage, notifyTest, full = false, scope = {}) {
    require('./access').guard('team', 'team_status', { claude_quota: claudeQuota, claude_usage: claudeUsage, notify_test: notifyTest });
    const snapshot = require('./job-snapshot').create();
    // Обычная сводка только читает. Уборку запускают установка и старт сервера.
    if (claudeUsage) {
      if (!['calls', 'written', 'reread', 'window_h'].every(k => Number.isFinite(claudeUsage[k]) && claudeUsage[k] >= 0) || !claudeUsage.window_h || !claudeUsage.source?.trim() || !Number.isFinite(Date.parse(claudeUsage.taken_at))) throw Error('Некорректный замер сеанса Claude.');
      claudeQuota = claudeUsage;
    }
    const rows = ['Хранилище состояния: ' + stateDir],
      seenOwners = new Set();
    // team-v19 К12: гость показывает коммит своего релиза (расхождение с live\deployed.json — в баннере).
    if (require('./access').guest()) rows.push('Гость ' + require('./access').client() + ': релиз ' + path.basename(path.resolve(__dirname, '..')).slice(0, 8));
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
    let statusWorks = [], statusWorksError;
    await section('Проверка этапов', async () => {
      try { statusWorks = await Promise.all(this.works().map(w => w.error ? w : this.refreshWork(this.workFile(w.name), { readOnly: true, snapshot }))); }
      catch (e) { statusWorksError = e; throw e; }
    });
    const readStatusWorks = () => { if (statusWorksError) throw statusWorksError; return statusWorks; };
    const quota = await require('./quota-line').quotaLine({ state: this.state, binary: process.env.CODEX_PATH || findCodex(), advice: !full, agyModel: scope.agy_model });
    const current = require('./request-context').context.getStore();
    const reminder = current?.publicSnapshot?.warning ?? require('./work-owner').reminder(this.root, undefined, scope);
    const rulesWarning = require('./server-instructions').read().warning;
    const warning = [rulesWarning, reminder].filter(Boolean).join('\n');
    if (!full) {
      const notification = notifyTest ? 'Пробное уведомление: ' + await require('./notify').notify('Связка: пробное уведомление', 'Уведомления команды работают.') : '';
      // Прямые вызовы тоже учитывают стандартную оболочку; MCP передаёт точный бюджет.
      const budget = scope.summaryBudget ?? (3000 - format('Команда', { status: 'done' }, '', 'Проверьте результат и выберите следующий шаг.').length - 1);
      const prefix = !current?.publicSnapshot && reminder ? reminder + '\n' : '';
      const required = [rulesWarning, notification].filter(Boolean);
      return prefix + await require('./summary').compact({ root: this.root, state: this.state, works: readStatusWorks }, quota, snapshot, { budget: budget - prefix.length, required });
    }
    rows.push(quota, ...require('./restart-hold').warnings(path.dirname(this.state)));
    await section('Расхождение версий', () => rows.push(...require('./release-drift').lines(this.root, stateDir)));
    if (warning) rows.unshift(warning);
    await section('Нагрузка', () => rows.push(require('./summary').loadLine(this.state, Object.fromEntries(require('./members').helpers.map(who => [who, stores.list(who, true, snapshot).jobs])))));
    for (const who of ['codex', 'antigravity']) {
      await section('Поручения ' + who, async () => {
        const { jobs, errors } = stores.list(who, true, snapshot),
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
          const locks = require('./locks');
          if (j.owner?.instance && !seenOwners.has(j.owner.instance)) {
            seenOwners.add(j.owner.instance);
            const live = await locks.probeOwner(j.owner);
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
            !j.stopUnconfirmed && !['running', 'queued', 'waiting_quota', 'needs_decision', 'cancelling', 'cancel_requested', 'delivery_unclear', 'applying', 'stop_unconfirmed'].includes(j.status)
          )
            continue;
          const owner = await snapshot.ownerState(j.owner);
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

    await section('Работы', async () => rows.push(...readStatusWorks().map(workText)));
    await section('Репозиторий', async () => {
      rows.push(
        'main / версия правил: ' + hash(this.root, 'main', (r, args) => git(r, args, { skipIndexLock: true })),
        'Корень: ' + (git(this.root, ['status', '--porcelain', '-uall'], { skipIndexLock: true }).trim() ? 'есть изменения' : 'чисто'),
        this.changesText(),
      );
    });
    await section('Релизы', async () => {
      const marker = inside(this.root, 'live', 'deployed.json');
      rows.push('Последнее развёртывание: ' + (fs.existsSync(marker) ? [read(marker).commit, read(marker).at, read(marker).method || 'способ не записан'].join(' · ') : 'не записано'));
      const op = require('./deploy-ops').list(this.root, { reconcile: false }).at(-1);
      if (op) rows.push(['Установка ' + op.id + ': ' + op.status, op.reason || op.message, op.restart, op.oldCode && !(op.reason || op.message || '').includes(require('./deploy-ops').oldCodeLine) ? require('./deploy-ops').oldCodeLine : require('./deploy-ops').cleanupLine(op.cleanup)].filter(Boolean).join(' · '));
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
              require('./members').servers
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
