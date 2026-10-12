'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const MAX_BYTES = 64 * 1024 * 1024;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
// Reject every link component, including in-root links, before opening a bounded regular file.
function readLocal(root, relative, limit = MAX_BYTES) {
  if (!text(root) || !path.isAbsolute(root)) throw Error('Нужна абсолютная папка заказа');
  if (!text(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /[:\0]/.test(relative)) throw Error('Нужен относительный путь файла');
  const base = fs.realpathSync(root), target = path.resolve(base, relative);
  if (!inside(base, target)) throw Error('Путь выходит за папку заказа');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Ссылки в пути запрещены');
  }
  if (!inside(base, fs.realpathSync(target))) throw Error('Файл выходит за папку заказа');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > limit) throw Error('Нужен непустой обычный файл допустимого размера');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw Error('Файл изменился при чтении');
      offset += n;
    }
    const after = fs.fstatSync(fd), named = fs.statSync(target);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== named.ino || before.dev !== named.dev || !inside(base, fs.realpathSync(target))) throw Error('Файл изменился при чтении');
    return { path: target, bytes };
  } finally { fs.closeSync(fd); }
}
function imageInfo(b) {
  if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    let p = 8, width, height, header, end = false;
    const data = [];
    while (p + 12 <= b.length) {
      const n = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
      if (n > b.length - p - 12) throw Error('Оборванный PNG');
      if (crc32(b.subarray(p + 4, p + 8 + n)) !== b.readUInt32BE(p + 8 + n)) throw Error('Неверный CRC PNG');
      if (p === 8 && (type !== 'IHDR' || n !== 13)) throw Error('Нет заголовка PNG');
      if (type === 'IHDR') { if (width !== undefined) throw Error('Повторный IHDR'); width = b.readUInt32BE(p + 8); height = b.readUInt32BE(p + 12); header = b.subarray(p + 8, p + 21); }
      if (type === 'IDAT' && n) data.push(b.subarray(p + 8, p + 8 + n));
      p += n + 12;
      if (type === 'IEND') { end = n === 0 && p === b.length; break; }
    }
    if (!width || !height || !data.length || !end) throw Error('Неполный PNG');
    const bits = header[8], color = header[9], channels = {0:1,2:3,3:1,4:2,6:4}[color];
    const allowedBits = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if (!channels || !allowedBits[color].includes(bits) || header[10] || header[11] || header[12] > 1) throw Error('Неверный формат пикселей PNG');
    const pixels = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: MAX_BYTES });
    if (header[12] === 0) {
      const stride = Math.ceil(width * channels * bits / 8) + 1;
      if (pixels.length !== stride * height) throw Error('Неверный объём пикселей PNG');
      for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw Error('Неверный фильтр PNG');
    }
    return { mime: 'image/png', width, height };
  }
  if (b.length >= 12 && b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217) {
    let p = 2, dimensions;
    while (p < b.length - 2) {
      if (b[p++] !== 255) throw Error('Повреждённый маркер JPEG');
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0 || marker === 216 || marker === 217) throw Error('Неверный маркер JPEG');
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) break;
      const n = b.readUInt16BE(p);
      if (n < 2 || p + n > b.length - 2) throw Error('Оборванный JPEG');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (n < 8 || n !== 8 + 3 * b[p + 7]) throw Error('Неверный SOF JPEG');
        dimensions = { mime: 'image/jpeg', width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3) };
      }
      if (marker === 218) {
        if (!dimensions?.width || !dimensions.height || p + n >= b.length - 2) throw Error('Нет данных JPEG');
        return dimensions;
      }
      p += n;
    }
  }
  throw Error('Файл не является полным контейнером PNG/JPEG');
}
function validateManifest(manifest, root) {
  const errors = [], artifacts = [];
  if (!object(manifest) || manifest.schemaVersion !== 1 || !object(manifest.order) || !Array.isArray(manifest.artifacts)) return { ready: false, errors: ['Неверная схема манифеста'], artifacts };
  const order = manifest.order;
  for (const field of ['ids', 'operators']) {
    const a = order[field];
    if (!Array.isArray(a) || !a.length || a.length > 1000 || a.some(v => !text(v) || v !== v.trim()) || new Set(a).size !== a.length) errors.push('Неверный список order.' + field);
  }
  if (errors.length) return { ready: false, errors, artifacts };
  if (order.ids.length * order.operators.length > 10000 || manifest.artifacts.length > 10000) return { ready: false, errors: ['Матрица слишком велика'], artifacts };
  if (order.aspectRatio !== undefined && (!Array.isArray(order.aspectRatio) || order.aspectRatio.length !== 2 || order.aspectRatio.some(n => !Number.isSafeInteger(n) || n <= 0))) errors.push('Неверное order.aspectRatio');
  const ratioValid = Array.isArray(order.aspectRatio) && order.aspectRatio.length === 2 && order.aspectRatio.every(n => Number.isSafeInteger(n) && n > 0);
  const expected = new Set(order.ids.flatMap(id => order.operators.map(op => JSON.stringify([id, op]))));
  const seen = new Set(), hashes = new Set();
  for (const [i, a] of manifest.artifacts.entries()) {
    const prefix = 'artifacts[' + i + ']: ';
    const fail = s => errors.push(prefix + s);
    if (!object(a)) { fail('не объект'); continue; }
    const key = JSON.stringify([a.id, a.operator]);
    if (!expected.has(key)) fail('лишний идентификатор/оператор');
    if (seen.has(key)) fail('дубликат ячейки заказа');
    seen.add(key);
    for (const field of ['job', 'parentJob', 'operator', 'generatorService', 'providerReportedArtifactModel']) if (!text(a[field])) fail('нет ' + field + ' (допустимо unknown)');
    if (!digest(a.promptSha256)) fail('нет SHA256 исходного промпта');
    if (!Array.isArray(a.iterations) || a.iterations.some(v => !object(v) || !Number.isSafeInteger(v.iteration) || v.iteration < 0 || typeof v.instructions !== 'string')) fail('неверная история итераций');
    if (!object(a.delivery) || a.delivery.status !== 'delivered' || !text(a.delivery.method)) fail('нет подтверждённой локальной доставки');
    if (!object(a.visualReview) || a.visualReview.status !== 'accepted' || !text(a.visualReview.author)) fail('нет принятого визуального ревью с автором');
    try {
      const file = readLocal(root, a.path), info = imageInfo(file.bytes), hash = sha(file.bytes);
      const ext = path.extname(file.path).toLowerCase();
      if (!(info.mime === 'image/png' ? ext === '.png' : ['.jpg', '.jpeg'].includes(ext))) fail('расширение не соответствует байтам');
      if (a.mime !== info.mime || a.width !== info.width || a.height !== info.height) fail('заявленные MIME/размеры не соответствуют файлу');
      if (!digest(a.sha256) || a.sha256.toLowerCase() !== hash) fail('SHA256 файла не совпадает');
      if (hashes.has(hash)) fail('повтор одних байтов вместо отдельной версии');
      hashes.add(hash);
      if (ratioValid && BigInt(info.width) * BigInt(order.aspectRatio[1]) !== BigInt(info.height) * BigInt(order.aspectRatio[0])) fail('соотношение сторон не соответствует заказу');
      const claims = object(a.metadataClaims) ? a.metadataClaims : {};
      artifacts.push({ id: a.id, operator: a.operator, job: a.job, parentJob: a.parentJob,
        generatorService: a.generatorService, providerReportedArtifactModel: a.providerReportedArtifactModel,
        promptSha256: a.promptSha256, iterations: Array.isArray(a.iterations) ? a.iterations.filter(object).map(v => ({ iteration: v.iteration, instructions: v.instructions })) : [],
        delivery: { status: a.delivery?.status, method: a.delivery?.method }, visualReview: { status: a.visualReview?.status, author: a.visualReview?.author },
        path: file.path, ...info, sha256: hash, evidenceLevel: 'locally_observed_artifact',
        modelEvidence: a.providerReportedArtifactModel === 'unknown' ? 'unknown' : 'manifest_claim',
        metadataClaims: { declaredGenerator: text(claims.declaredGenerator) ? claims.declaredGenerator : 'unknown', declaredModel: text(claims.declaredModel) ? claims.declaredModel : 'unknown',
          metadataSource: text(claims.metadataSource) ? claims.metadataSource : 'unknown', evidenceLevel: 'metadata_claim', signatureValidation: 'not_checked', trustValidation: 'not_checked' },
        containerValidation: info.mime === 'image/png' ? 'structure_crc_inflate' : 'header_and_structure_only' });
    } catch (e) { fail(e.message); }
  }
  for (const key of expected) if (!seen.has(key)) errors.push('Не доставлена ячейка ' + key);
  return { ready: errors.length === 0, errors, artifacts };
}
module.exports = { validateManifest, readLocal, imageInfo, MAX_BYTES };
