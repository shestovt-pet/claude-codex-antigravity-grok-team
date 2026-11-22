'use strict';
// Штатная проверка совместимости Kimi на УСТАНОВЛЕННОМ выпуске (team-v58 §9). Три живые проверки настоящим kimi.exe на
// СВОЕЙ временной копии материала и запись launch.recordCompatibility ТОЛЬКО при трёх подтверждённых:
//   delivery  — живой запуск kimi.exe на длинном файле-поручении (>128 КиБ) с уникальной меткой в последней строке; метка
//               должна вернуться дословно в финальном ответе (доставка длинного ввода);
//   parsing   — разбор сохранённого потока launch.analyze: поток валиден, версия есть, финальный текст непуст;
//   detection — kimi-material.snapshot/diff на своей копии материала: без правки ложной разницы нет, внесённая правка
//               (её делает сценарий, не Kimi) обнаруживается.
// Отказывает: при MOST_PROBE_ONLY=1 (техническая проба CLI не запускает живой kimi.exe), при MOST_JOB_ID (живую проверку
// запускает человек или дирижёр из ЧАТА, не поручение) и при отсутствии CLI (adapter_params.path). Модули берутся из
// соседнего каталога выпуска (require('../common/...')). Образец сценария: E:\Codex\work\v58-kimi-run\run1\{probe,record}.js.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

function assertAllowed() {
  if (process.env.MOST_PROBE_ONLY === '1') throw Error('kimi-probe: MOST_PROBE_ONLY=1 — техническая проба не запускает живой kimi.exe.');
  if (process.env.MOST_JOB_ID) throw Error('kimi-probe: задан MOST_JOB_ID — живую проверку запускает человек или дирижёр из чата, не поручение.');
}

// Запуск дочернего CLI тем же конвейером, что сервер: собираем весь stream.ndjson в память, таймаут завершает дерево.
function runChild(spawn, file, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stream = Buffer.alloc(0), timedOut = false;
    const child = spawn(file, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killer = setTimeout(() => {
      timedOut = true;
      try { require('child_process').execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 30000 }); } catch {}
    }, timeoutMs);
    child.stdout.on('data', d => { stream = Buffer.concat([stream, d]); });
    child.stderr.on('data', () => {});
    child.on('error', e => { clearTimeout(killer); reject(e); });
    child.on('close', code => { clearTimeout(killer); resolve({ code, stream, timedOut }); });
  });
}

async function probe(opts = {}, deps = {}) {
  assertAllowed();
  const launch = deps.launch || require('../common/kimi-launch');
  const material = deps.material || require('../common/kimi-material');
  const spawn = deps.spawn || require('child_process').spawn;
  const prefixArgs = deps.prefixArgs || [];      // в бою пусто; в тестах — [путь к подставному CLI] перед argv
  const log = opts.log || (() => {});
  const bin = launch.binary();
  if (!bin) throw Error('kimi-probe: CLI Kimi не найден (adapter_params.path) — проверка невозможна.');

  const work = opts.workRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-probe-'));
  const dir = s => { const p = path.join(work, s); fs.mkdirSync(p, { recursive: true }); return p; };
  const nonces = { delivery: crypto.randomUUID(), parsing: crypto.randomUUID(), detection: crypto.randomUUID() };

  // inspect: --version/--help настоящего CLI (path, sha256, version, helpSha256).
  const info = launch.inspect({ file: bin, cwd: dir('inspect'), tempFolder: dir('inspect-tmp'), prefixArgs });
  if (info.skipped) throw Error('kimi-probe: проверка пропущена (' + info.reason + ').');
  log('inspect: version=' + info.version + ' sha256=' + info.sha256);

  // delivery — живой запуск CLI на длинном файле-поручении; метка в самом конце.
  const jobId = 'v58probe' + Date.now().toString(36).slice(-6);
  const execFolder = dir('exec'), tempFolder = dir('temp');
  const prof = launch.profile({ role: 'проверка' });
  const profileFile = path.join(execFolder, prof.name); fs.writeFileSync(profileFile, prof.text, 'utf8');
  const head = [
    'Поручение-проверка доставки длинного файла (мост, роль «проверка», только чтение).',
    'Этот файл длиннее 128 КиБ. В самой последней строке файла записана уникальная метка вида',
    '«МЕТКА-ДОСТАВКИ: <код>». Прочитай файл целиком, найди эту метку в конце и верни её код',
    'дословно в ответе отдельной строкой. Ответ дай по-русски. Ничего не изменяй.',
    '', '--- наполнение (игнорируй, читай до самого конца) ---', ''
  ].join('\n');
  let body = head;
  const filler = 'Строка наполнения с кириллицей «кавычки» и CRLF.\r\nещё строка.\n';
  while (Buffer.byteLength(body, 'utf8') < 150 * 1024) body += filler;
  body += '\n--- конец наполнения ---\nМЕТКА-ДОСТАВКИ: ' + nonces.delivery + '\n';
  const inputFile = path.join(execFolder, 'most-kimi-task-' + jobId + '.md');
  fs.writeFileSync(inputFile, body, 'utf8');
  const inputBytes = Buffer.byteLength(body, 'utf8');
  const argv = launch.args({ jobId, inputFile, profileFile });
  const { code, stream, timedOut } = await runChild(spawn, bin, [...prefixArgs, ...argv], { cwd: execFolder, env: launch.cliEnv({ tempFolder }) }, deps.timeoutMs ?? 300000);

  // parsing — разбор сохранённого потока.
  const parsed = launch.analyze(stream, { code });
  const markerPresent = typeof parsed.text === 'string' && parsed.text.includes(nonces.delivery);
  const deliveryOk = code === 0 && !timedOut && inputBytes > 128 * 1024 && markerPresent;
  const parsingOk = parsed.ok === true && parsed.bad === false && typeof parsed.text === 'string' && parsed.text.trim().length > 0;
  log('delivery: ' + (deliveryOk ? 'ПОДТВЕРЖДЕНО' : 'нет') + ' (exit=' + code + ', метка=' + markerPresent + '); parsing: ' + (parsingOk ? 'ПОДТВЕРЖДЕНО' : 'нет'));

  // detection — snapshot/diff на своей копии материала (правку вносит сценарий, не Kimi).
  const matRoot = dir('material');
  fs.writeFileSync(path.join(matRoot, 'data.txt'), 'Исходный материал пробы доставки.\nСтрока два.\n', 'utf8');
  fs.writeFileSync(path.join(matRoot, 'most-kimi-task-probe.md'), 'Пробный материал team-v58 §9.\n', 'utf8');
  const snap0 = material.snapshot(matRoot);
  const cleanDiff = material.diff(snap0, material.snapshot(matRoot));
  const editTarget = path.join(matRoot, 'data.txt');
  fs.appendFileSync(editTarget, '\nПРАВКА-ОБНАРУЖЕНИЯ: ' + nonces.detection + '\n');
  const dirtyDiff = material.diff(snap0, material.snapshot(matRoot));
  const detectsEdit = dirtyDiff.some(p => path.resolve(p).toLowerCase() === path.resolve(editTarget).toLowerCase());
  const detectionOk = cleanDiff.length === 0 && dirtyDiff.length > 0 && detectsEdit;
  log('detection: ' + (detectionOk ? 'ПОДТВЕРЖДЕНО' : 'нет'));

  const result = { info, delivery: deliveryOk, parsing: parsingOk, detection: detectionOk, nonces, inputBytes, exitCode: code, timedOut, workRoot: work };
  // Запись штатной функцией — ТОЛЬКО при трёх подтверждённых; иначе ничего не записываем.
  if (!(deliveryOk && parsingOk && detectionOk)) { result.recorded = false; return result; }
  result.record = launch.recordCompatibility({ ...info, delivery: true, parsing: true, detection: true,
    evidence: { delivery: nonces.delivery, parsing: nonces.parsing, detection: nonces.detection } });
  result.recorded = true;
  return result;
}

module.exports = { probe, runChild, assertAllowed };

if (require.main === module) {
  probe({ log: console.log }).then(r => {
    console.log(r.recorded ? 'Записано: совместимость Kimi подтверждена (три проверки).'
      : 'Не записано: подтверждены не все проверки (delivery=' + r.delivery + ', parsing=' + r.parsing + ', detection=' + r.detection + ').');
    process.exit(r.recorded ? 0 : 2);
  }).catch(e => { console.error(e.message); process.exit(2); });
}
