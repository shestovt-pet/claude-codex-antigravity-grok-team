'use strict';
// Профили DeepSeek Harness для поручений моста: создаются установкой из adapter_params реестра.
// MCP моста: в most-read, most-write и most-full — гостевые серверы для подпоручений (team-v36), в most-review нет; авторизация аккаунта включена (ключ API не нужен); модель задаётся профилем
// (у headless нет флага модели): most-read — flash, most-review — pro (единственный для голоса),
// most-write — pro, most-full — pro. most-review в песочнице read-only и без оболочки.
const fs = require('fs'), path = require('path'), os = require('os');

function profilesDir() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
}
function modelFor(job, params) {
  return profileModel(profileName(job), params);
}
function profileName(job) {
  // Проверка — всегда most-review (read-only): write/fullAccessApplied на проверку не распространяются.
  if (job.role === 'проверка') return 'most-review';
  if (job.fullAccessApplied) return 'most-full';
  if (job.write) return 'most-write';
  return 'most-read';
}
function profileModel(name, params) {
  const models = params?.models || {};
  return name === 'most-read' ? (models.read || 'deepseek-v4-flash') : (models.review || 'deepseek-v4-pro');
}
function cordisYml() { return '# dsh profile root — an empty entry list.\n[]\n'; }
function packageJson(name) {
  return JSON.stringify({ name: 'dsh-profile-' + name, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }, null, 2) + '\n';
}
function workspaceYml() { return 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'; }
const auth = (model) => [
  '- id: credentials', '  disabled: false',
  '- id: deepseek-account', '  disabled: false',
  '- id: authorization', '  disabled: false',
  '- id: agent-default-model', '  config:', '    provider: deepseek-account', '    model: ' + model,
];
function patch(name, model, bridge) {
  const mode = name === 'most-read' || name === 'most-review' ? 'read-only' : name === 'most-write' ? 'workspace-write' : 'danger-full-access';
  const preset = name === 'most-full' ? 'danger-full-access' : mode + '-never';
  const lines = [
    '# Профиль поручений моста ' + name + ': ' + (name === 'most-full' ? 'полный доступ' : name === 'most-write' ? 'запись в папке поручения' : 'только чтение') + '; MCP моста ' + (bridge && name !== 'most-review' ? 'есть' : 'нет') + '; оболочка ' + (name === 'most-full' ? 'разрешена' : 'отключена') + '.',
    ...auth(model),
    '- id: sandbox-policy', '  config:', '    mode: ' + mode, '    workspaceRoot: !!js process.cwd()',
    '- id: approval', '  config:', '    policy: never',
    '- id: permission', '  config:', '    presets:',
    '      read-only-never: { sandbox: read-only, approval: never }',
    '      workspace-write-never: { sandbox: workspace-write, approval: never }',
    '      read-only: { sandbox: read-only, approval: ask }',
    '      workspace-write: { sandbox: workspace-write, approval: ask }',
    '      danger-full-access: { sandbox: danger-full-access, approval: never }',
    '    defaultPreset: ' + preset,
  ];
  if (name !== 'most-full') {
    lines.push('- id: tool-pwsh', '  disabled: true', '- id: tool-bash', '  disabled: true');
  }
  // team-v36: подпоручения из поручения — гостевые серверы моста в most-read, most-write и most-full (не в most-review: голос без MCP).
  if (bridge && name !== 'most-review') lines.push(...mcpLines(bridge));
  return lines.join('\n') + '\n';
}
// Гостевые серверы моста для поручения DeepSeek: MOST_JOB_ID берётся из окружения поручения (fallback.jobEnv).
function mcpLines({ release, root, node }) {
  const servers = require('./members').servers.filter(n => n !== 'deepseek');
  if (!servers.length) return [];
  const q = s => JSON.stringify(String(s));
  return ['- insert:', ...servers.flatMap(n => [
    '    - id: mcp-most-' + n, '      name: "@deepseek-ai/dsh-mcp-client"', '      config:',
    '        serverName: ' + n, '        transport: stdio', '        command: ' + q(node),
    '        args: [' + q(path.join(release, 'servers', n, 'index.js')) + ']',
    '        env:', '          MOST_CLIENT: deepseek', '          MOST_REPO_ROOT: ' + q(root),
    '          MOST_STATE_DIR: ' + q(path.join(root, 'state')), '          MOST_JOB_ID: !!js process.env.MOST_JOB_ID || ""',
    '        failOnStartupError: false',
  ])];
}
function generate(params, dir = profilesDir(), bridge = null) {
  const names = ['most-read', 'most-review', 'most-write', 'most-full'];
  for (const name of names) {
    const profile = path.join(dir, 'profiles', name);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'cordis.yml'), cordisYml());
    fs.writeFileSync(path.join(profile, 'package.json'), packageJson(name));
    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), workspaceYml());
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch(name, profileModel(name, params), bridge));
  }
  return names;
}
// Доказательство модели сеанса для зачёта голоса (team-v35). dsh не сохраняет модель ответа поставщика:
// replayState.response.model — это запрошенная модель (ревью DeepSeek 648c40d6 по исходникам deepseek-harness).
// Доказуем маршрут: у всех ответов модели одинаковые source.provider (маршрут DeepSeek) и source.model.
// Возвращает { model, evidence } или null. Поле model проекции (если появится) — приоритетно, evidence 'projection'.
const DEEPSEEK_ROUTES = ['deepseek-account', 'deepseek-official'];
function sessionEvidence(sessionId, dir = profilesDir()) {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) return null;
  try {
    const file = path.join(dir, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
    const model = JSON.parse(fs.readFileSync(file, 'utf8')).model;
    if (typeof model === 'string' && model) return { model, evidence: 'projection' };
  } catch {}
  return journalEvidence(sessionId, dir);
}
function sessionModel(sessionId, dir = profilesDir()) { return sessionEvidence(sessionId, dir)?.model || null; }
// Журнал сеанса — последовательность кадров zstd (и, возможно, пропускаемых кадров). Границы кадров находятся
// разбором заголовков кадра и блоков по формату zstd (RFC 8878); любая несостыковка, неизвестный кадр,
// неполный хвост или ошибка распаковки — null для всего журнала (ревью Codex 2f1f3a8c).
function zstdFrames(buf) {
  const zlib = require('zlib');
  if (typeof zlib.zstdDecompressSync !== 'function') return null;
  let off = 0, text = '';
  while (off < buf.length) {
    if (off + 4 > buf.length) return null;
    const magic = buf.readUInt32LE(off);
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { // пропускаемый кадр: магия + 4 байта длины + данные
      if (off + 8 > buf.length) return null;
      const n = buf.readUInt32LE(off + 4);
      off += 8 + n; if (off > buf.length) return null; continue;
    }
    if (magic !== 0xFD2FB528) return null;
    let p = off + 4; if (p >= buf.length) return null;
    const fhd = buf[p++], fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
    if ((fhd >> 3) & 1) return null; // зарезервированный бит
    p += (single ? 0 : 1) + [0, 1, 2, 4][didFlag] + (fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]);
    for (;;) {
      if (p + 3 > buf.length) return null;
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
      if (type === 3) return null;
      p += 3 + (type === 1 ? 1 : size);
      if (p > buf.length) return null;
      if (last) break;
    }
    if (checksum) p += 4;
    if (p > buf.length) return null;
    try { text += zlib.zstdDecompressSync(buf.subarray(off, p)).toString('utf8'); } catch { return null; }
    off = p;
  }
  return text;
}
// Маршрут и модель из журнала: все assistant/message с source.kind = model; одинаковые provider и model,
// provider — маршрут DeepSeek; иначе null. Повреждённый журнал — null (строгий разбор кадров).
function journalEvidence(sessionId, dir = profilesDir()) {
  try {
    const root = path.join(dir, 'sessions');
    const holder = fs.readdirSync(root).find(n => fs.existsSync(path.join(root, n, sessionId, 'session.v4.jsonl.zstd')));
    if (!holder) return null;
    const text = zstdFrames(fs.readFileSync(path.join(root, holder, sessionId, 'session.v4.jsonl.zstd')));
    if (text === null) return null;
    const pairs = new Set();
    let answers = 0, provider = null, model = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('assistant/message')) continue;
      let e; try { e = JSON.parse(line); } catch { return null; }
      if (e?.type !== 'assistant/message') continue;
      const source = e.data?.message?.source;
      if (source?.kind !== 'model') continue;
      answers++;
      if (typeof source.provider !== 'string' || typeof source.model !== 'string' || !source.provider || !source.model) return null;
      provider = source.provider; model = source.model; pairs.add(provider + '\u0000' + model);
    }
    if (!answers || pairs.size !== 1 || !DEEPSEEK_ROUTES.includes(provider)) return null;
    return { model, evidence: 'provider_route:' + provider + ' (requested model)' };
  } catch { return null; }
}
const journalModel = (id, dir) => journalEvidence(id, dir)?.model || null;
module.exports = { profilesDir, generate, profileName, profileModel, modelFor, sessionModel, sessionEvidence, journalModel, journalEvidence, zstdFrames, DEEPSEEK_ROUTES };
