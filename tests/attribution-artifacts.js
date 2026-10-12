'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { validateManifest, readLocal, imageInfo, MAX_BYTES } = require('../common/artifact-manifest');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'most-artifacts-'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function crc(b) { let c = 0xffffffff; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, b) { const out = Buffer.alloc(b.length + 12); out.writeUInt32BE(b.length); out.write(type, 4); b.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, b.length + 8)), b.length + 8); return out; }
function png(color, width = 1, height = 1) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1), color); for (let r = 0; r < height; r++) raw[r * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const manifest = { schemaVersion: 1, order: { ids: Array.from({ length: 19 }, (_, i) => 'art-' + i), operators: ['grok','codex','antigravity'], aspectRatio: [1,1] }, artifacts: [] };
for (const id of manifest.order.ids) for (const operator of manifest.order.operators) {
  const i = manifest.artifacts.length, bytes = png(i), file = id + '-' + operator + '.png'; fs.writeFileSync(path.join(root, file), bytes);
  manifest.artifacts.push({ id, operator, job: 'job-' + i, parentJob: 'unknown', generatorService: 'unknown', providerReportedArtifactModel: 'unknown', promptSha256: hash(Buffer.from(id)), iterations: [], path: file, delivery: {status:'delivered',method:'local copy'}, mime:'image/png', width:1,height:1,sha256:hash(bytes),visualReview:{status:'accepted',author:'test-reviewer'} });
}
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('OK ' + name); } catch(e) { failed++; console.error('FAIL ' + name + ': ' + e.stack); } }
const copy = () => JSON.parse(JSON.stringify(manifest));
function rejects(m, phrase) { const r = validateManifest(m,root); assert.equal(r.ready,false); assert(r.errors.some(e => e.includes(phrase)), r.errors.join('\n')); }
test('полные 19 × 3 с файлами принимаются', () => { const r = validateManifest(manifest,root); assert.deepEqual(r.errors,[]); assert.equal(r.artifacts.length,57); assert(r.ready); });
test('18 × 3 не готовы', () => { const m = copy(); m.artifacts.splice(54); rejects(m,'Не доставлена ячейка'); });
test('Claude не добавляется из ролей консилиума', () => { const m = copy(); m.artifacts.push({...m.artifacts[0],operator:'claude'}); rejects(m,'лишний'); });
test('дубликат ячейки', () => { const m=copy(); m.artifacts[1]={...m.artifacts[0]}; rejects(m,'дубликат'); });
test('копия байтов не считается новой версией', () => { const m=copy(); m.artifacts[1]={...m.artifacts[1],path:m.artifacts[0].path,sha256:m.artifacts[0].sha256}; rejects(m,'повтор одних байтов'); });
test('не доставленный файл', () => { const m=copy(); m.artifacts[0].path='absent.png'; rejects(m,'ENOENT'); });
test('доставка и визуальное ревью обязательны', () => { const m=copy(); m.artifacts[0].delivery.status='pending'; m.artifacts[1].visualReview.author=''; rejects(m,'доставки'); rejects(m,'ревью'); });
test('хеш и фактические размеры проверяются', () => { const m=copy(); m.artifacts[0].sha256='a'.repeat(64); m.artifacts[1].width=100; rejects(m,'SHA256 файла'); rejects(m,'размеры'); });
test('соотношение 16:9 вместо 1:1', () => { const m=copy(), b=png(250,16,9); fs.writeFileSync(path.join(root,'wide.png'),b); Object.assign(m.artifacts[0],{path:'wide.png',width:16,height:9,sha256:hash(b)}); rejects(m,'соотношение'); });
test('PNG с неверным расширением', () => { const m=copy(); fs.writeFileSync(path.join(root,'wrong.jpg'),png(0)); m.artifacts[0].path='wrong.jpg'; rejects(m,'расширение'); });
test('строка вместо картинки не проходит', () => { const m=copy(), b=Buffer.from('I generated a PNG image'); fs.writeFileSync(path.join(root,'fake.png'),b); Object.assign(m.artifacts[0],{path:'fake.png',sha256:hash(b)}); rejects(m,'PNG/JPEG'); });
test('повреждённые байты PNG и CRC не проходят', () => { const b=png(0); b[45]^=1; assert.throws(()=>imageInfo(b), /CRC/); assert.throws(()=>imageInfo(png(0).subarray(0,35))); });
test('JPEG размеры из SOF, не имени', () => {
  // Minimal structural fixture; intentionally not a full codec/decode test.
  const b=Buffer.from('ffd8ffc0000b0802d0050001011100ffda0008010100003f001234ffd9','hex');
  assert.deepEqual(imageInfo(b),{mime:'image/jpeg',width:1280,height:720});
  const m=copy(); fs.writeFileSync(path.join(root,'jpeg-as-png.png'),b); Object.assign(m.artifacts[0],{path:'jpeg-as-png.png',sha256:hash(b),mime:'image/jpeg',width:1280,height:720}); rejects(m,'расширение'); rejects(m,'соотношение');
});
test('метаданные не повышают доказательство модели', () => { const m=copy(); m.artifacts[0].providerReportedArtifactModel='Grok Imagine'; m.artifacts[0].metadataClaims={declaredModel:'Grok Imagine',signatureValidation:'verified',trustValidation:'trusted'}; const a=validateManifest(m,root).artifacts[0]; assert.equal(a.modelEvidence,'manifest_claim'); assert.equal(a.metadataClaims.trustValidation,'not_checked'); });
test('выход из корня, абсолютный путь, ADS, каталог отвергаются', () => { for(const p of ['../escape.png',path.join(root,'art-0-grok.png'),'art-0-grok.png:secret','.']) assert.throws(()=>readLocal(root,p)); });
test('предел размера соблюдается до чтения', () => assert.throws(()=>readLocal(root,'art-0-grok.png',1), /размера/));
test('junction наружу отвергается', () => { const outside=fs.mkdtempSync(path.join(os.tmpdir(),'most-artifacts-out-')); const link=path.join(root,'outside'); fs.symlinkSync(outside,link,'junction'); fs.writeFileSync(path.join(outside,'x.png'),png(4)); assert.throws(()=>readLocal(root,'outside/x.png'), /Ссылки/); });
test('неверные типы схемы не приводят к готовности', () => { for(const m of [null,{}, {...copy(),order:{ids:['a'],operators:[]}}, {...copy(),order:{ids:['a','a'],operators:['grok']}}]) assert.equal(validateManifest(m,root).ready,false); });
test('CLI 0 только готовому, 1 неполному заказу', () => { fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest)); const cli=path.join(__dirname,'../tools/verify-artifacts.js'); const ok=spawnSync(process.execPath,[cli,root,'manifest.json'],{encoding:'utf8'}); assert.equal(ok.status,0,ok.stdout); const m=copy(); m.artifacts.pop(); fs.writeFileSync(path.join(root,'incomplete.json'),JSON.stringify(m)); const no=spawnSync(process.execPath,[cli,root,'incomplete.json'],{encoding:'utf8'}); assert.equal(no.status,1); assert.equal(JSON.parse(no.stdout).ready,false); });
console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`);
process.exitCode = failed ? 1 : 0;
// Fixtures are retained: this review task does not authorize deletion.
