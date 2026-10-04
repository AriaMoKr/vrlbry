import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createApp } from '../server/http.js';
import { loadCertificate, main, parseCliArgs } from '../server/index.js';
import { Library } from '../server/library.js';
import { writeZim } from './helpers/zimwriter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const REAL_ZIM = path.join(REPO, 'gutenberg_en_lcc-pe_2026-03.zim');
const REAL_ID = 'gutenberg_en_lcc-pe_2026-03';
const JSON_TYPE = 'application/json; charset=utf-8';
const PKG_MARKER = '"name": "vrlbry"';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-api-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Fixtures

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  b.writeUInt32BE(zlib.crc32(b.subarray(12, 29)), 29);
  return b;
}

/** Stored (uncompressed) ZIP. */
function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const FIG = png(320, 200);
function epub(title) {
  return zipStore([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'],
    ['OPS/book.opf', `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata>
      <manifest><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/><item id="f" href="img/fig é.png" media-type="image/png"/></manifest>
      <spine><itemref idref="t"/></spine></package>`],
    ['OPS/t.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${title}</h1><p>EPUB text.</p><img src="img/fig%20%C3%A9.png" alt="fig"/></body></html>`],
    ['OPS/img/fig é.png', FIG],
  ]);
}

const UNICODE_TITLE = "Café l'été: ünï 𝔘 #1? 100%";
const SOUND = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff));
const LONG_TEXT = Array.from({ length: 120 }, (_, i) => `<h2>Section ${i}</h2><p>${`Paragraph ${i} words words words. `.repeat(30)}</p>`).join('\n');

function writeFixture(file) {
  const rows = [
    ['Plain Book', 'Ann Author', '110', 1, 'PE'],
    [UNICODE_TITLE, 'Bé Author', '100', 2, 'PE'],
    ['Epub Only', 'Cy Author', '010', 3, 'PE'],
    ['Broken Epub', 'Cy Author', '010', 4, 'PE'],
    ['Ghost', 'Cy Author', '110', 5, 'PE'],
  ];
  const html = (t, body) => `<html><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`;
  writeZim(file, {
    scheme: 'new',
    entries: [
      { ns: 'C', url: 'full_by_popularity.js', mime: 'text/javascript', content: `var json_data = ${JSON.stringify(rows)};\n` },
      { ns: 'C', url: 'authors.js', mime: 'text/javascript', content: 'var authors_json_data = [["Ann Author", "1"]];' },
      { ns: 'C', url: 'languages.js', mime: 'text/javascript', content: 'var languages_json_data = [["English", "en", 5]];' },
      { ns: 'C', url: 'Plain Book.1', mime: 'text/html', content: html('Plain Book', `<p><img src="1_fig.png" alt="Fig"></p>${LONG_TEXT}`) },
      { ns: 'C', url: 'Plain Book.1.epub', mime: 'application/epub+zip', content: epub('Plain Book'), compression: 'none' },
      { ns: 'C', url: '1_fig.png', mime: 'image/png', content: FIG, compression: 'none' },
      { ns: 'C', url: 'covers/1_cover_image.jpg', mime: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      { ns: 'C', url: `${UNICODE_TITLE.replace('/', '-')}.2`, mime: 'text/html', content: html('Unicode', '<p>Unicode book.</p>') },
      { ns: 'C', url: 'Epub Only.3.epub', mime: 'application/epub+zip', content: epub('Epub Only'), compression: 'none' },
      { ns: 'C', url: 'Broken Epub.4.epub', mime: 'application/epub+zip', content: Buffer.from('this is not a zip file at all'), compression: 'none' },
      { ns: 'C', url: 'sound.mp3', mime: 'audio/mpeg', content: SOUND, compression: 'none' },
      { ns: 'C', url: 'alias.mp3', redirectTo: 'C/sound.mp3' },
      { ns: 'C', url: 'notes.txt', mime: 'text/plain', content: 'plain text ✓' },
      { ns: 'C', url: 'page.html', mime: 'text/html', content: '<script>alert(1)</script>' },
      { ns: 'C', url: 'dir/sub dir/file name (1).css', mime: 'text/css; charset=iso-8859-1', content: 'p{}' },
      { ns: 'M', url: 'Title', mime: 'text/plain', content: 'API Fixture' },
      { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: png(48, 48) },
    ],
  });
}

function writePublic(dir) {
  const files = {
    'index.html': '<!doctype html><title>vrlbry</title>',
    'js/app.js': 'export const x = 1;',
    'js/mod.mjs': 'export {};',
    'css/style.css': 'body{}',
    'img/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    'data/x.json': '{"a":1}',
    'fonts/f.woff2': 'wOF2',
    'models/m.glb': 'glTF',
    'env/sky.hdr': '#?RADIANCE',
    'wasm/a.wasm': '\0asm',
    'favicon.ico': 'ico',
    'blob.unknownext': 'x',
    '.secret': 'secret',
    'sub/index.html': '<p>sub</p>',
    'big.txt': 'abcdefghijklmnopqrstuvwxyz',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers

/** Raw request: the path is sent exactly as given (no normalization), no automatic gunzip. */
function request(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const enc = (archivePath) => archivePath.split('/').map(encodeURIComponent).join('/');

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// ---------------------------------------------------------------------------------------------

describe('HTTP API (synthetic library)', () => {
  let library;
  let server;
  let port;
  const errors = [];
  let get;
  let lib;
  before(async () => {
    const zimDir = path.join(tmp, 'zims');
    const pub = path.join(tmp, 'public');
    fs.mkdirSync(zimDir);
    fs.mkdirSync(pub);
    writeFixture(path.join(zimDir, 'api fixture.zim'));
    writePublic(pub);
    library = await Library.scan(zimDir, { log: () => {} });
    lib = library.get('api-fixture');
    server = await startServer(createApp(library, { publicDir: pub, log: (m) => errors.push(m) }));
    port = server.address().port;
    get = (p, opts) => request(port, p, opts);
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await library?.close();
  });

  const json = (r) => {
    assert.equal(r.headers['content-type'], JSON_TYPE);
    return JSON.parse(r.body.toString('utf8'));
  };

  it('GET /api/libraries', async () => {
    const r = await get('/api/libraries');
    assert.equal(r.status, 200);
    assert.deepEqual(json(r), {
      generation: 1,
      libraries: [{
        id: 'api-fixture', file: 'api fixture.zim', kind: 'gutenberg', title: 'API Fixture', description: null,
        longDescription: null, language: null, date: null, creator: null, publisher: null, name: null,
        bookCount: 5, illustration: '/zim/api-fixture/M/Illustration_48x48%401', shelves: ['PE'],
      }],
    });
    const ill = await get('/zim/api-fixture/M/Illustration_48x48%401');
    assert.equal(ill.status, 200);
    assert.equal(ill.headers['content-type'], 'image/png');
    assert.deepEqual(ill.body, png(48, 48));
  });

  it('POST /api/rescan picks up added and removed archives', async () => {
    const extra = path.join(tmp, 'zims', 'second.zim');
    writeFixture(extra);
    try {
      const r = await get('/api/rescan', { method: 'POST' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], JSON_TYPE);
      const body = json(r);
      assert.deepEqual(body.added, ['second']);
      assert.deepEqual(body.removed, []);
      assert.equal(body.generation, 2);
      assert.deepEqual(body.libraries.map((l) => l.id), ['api-fixture', 'second']);
      const list = json(await get('/api/libraries'));
      assert.equal(list.generation, 2);
      assert.equal((await get('/api/libraries/second/books')).status, 200);
    } finally {
      fs.rmSync(extra);
    }
    const r2 = json(await get('/api/rescan', { method: 'POST' }));
    assert.deepEqual(r2.removed, ['second']);
    assert.equal(r2.generation, 3);
    assert.equal((await get('/api/libraries/second/books')).status, 404);
    const wrong = await get('/api/rescan');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'POST');
  });

  it('GET /api/libraries/:lib/books', async () => {
    const r = await get('/api/libraries/api-fixture/books');
    assert.equal(r.status, 200);
    const body = json(r);
    assert.equal(body.library, 'api-fixture');
    assert.deepEqual(body.books.map((b) => b.id), ['1', '2', '3', '4', '5']);
    const [plain, uni] = body.books;
    assert.equal(plain.cover, '/zim/api-fixture/C/covers/1_cover_image.jpg');
    assert.equal(plain.epub, '/zim/api-fixture/C/Plain%20Book.1.epub');
    assert.equal(plain.authorId, '1');
    assert.equal(plain.language, 'en');
    assert.equal(uni.title, UNICODE_TITLE);
    assert.equal(body.books[4].readable, false);
    assert.equal((await get('/api/libraries/nope/books')).status, 404);
    assert.deepEqual(json(await get('/api/libraries/nope/books')), { error: 'unknown library: nope' });
  });

  it('GET /api/libraries/:lib/books/:id (reading metadata)', async () => {
    const r = await get('/api/libraries/api-fixture/books/1');
    assert.equal(r.status, 200);
    const meta = json(r);
    assert.deepEqual(Object.keys(meta), ['library', 'id', 'title', 'subtitle', 'author', 'cover', 'source',
      'totalChars', 'chunks', 'toc', 'tocTruncated']);
    assert.equal(meta.source, 'html');
    assert.ok(meta.chunks.length >= 2, 'long book → several chunks');
    assert.equal(meta.totalChars, meta.chunks.reduce((n, c) => n + c.chars, 0));
    assert.equal(meta.toc.length, 121);
    const epubOnly = json(await get('/api/libraries/api-fixture/books/3'));
    assert.equal(epubOnly.source, 'epub');
    assert.equal((await get('/api/libraries/api-fixture/books/999')).status, 404);
    const ghost = await get('/api/libraries/api-fixture/books/5');
    assert.equal(ghost.status, 404);
    assert.match(json(ghost).error, /no readable content/);
  });

  it('GET …/chunks/:n with validation, gzip, ETag/304 and HEAD', async () => {
    const base = '/api/libraries/api-fixture/books/1/chunks';
    const plain = await get(`${base}/0`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    const body = json(plain);
    assert.equal(body.index, 0);
    assert.ok(Array.isArray(body.blocks) && body.blocks.length > 0);
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    const img = body.blocks.find((b) => b.t === 'img');
    assert.deepEqual(img, { t: 'img', src: '/zim/api-fixture/C/1_fig.png', w: 320, h: 200, alt: 'Fig' });

    const gz = await get(`${base}/0`, { headers: { 'accept-encoding': 'br, gzip;q=0.8' } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
    assert.ok(gz.body.length * 2 < plain.body.length, 'compresses');
    assert.equal((await get(`${base}/0`, { headers: { 'accept-encoding': 'gzip;q=0' } })).headers['content-encoding'], undefined);
    assert.equal((await get(`${base}/0`, { headers: { 'accept-encoding': '*' } })).headers['content-encoding'], 'gzip');

    const etag = plain.headers.etag;
    assert.ok(etag);
    const nm = await get(`${base}/0`, { headers: { 'if-none-match': etag } });
    assert.equal(nm.status, 304);
    assert.equal(nm.body.length, 0);
    const head = await get(`${base}/0`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], plain.headers['content-length']);

    for (const bad of ['abc', '-1', '1.5', '01x', '1e3', '%20', '99999999999']) {
      const r = await get(`${base}/${bad}`);
      assert.equal(r.status, 400, bad);
      assert.match(json(r).error, /invalid chunk index/);
    }
    const out = await get(`${base}/999`);
    assert.equal(out.status, 404);
    assert.match(json(out).error, /out of range/);
    assert.equal((await get('/api/libraries/api-fixture/books/999/chunks/0')).status, 404);
  });

  it('serves every chunk of the EPUB-only book and its /res/ images', async () => {
    const meta = json(await get('/api/libraries/api-fixture/books/3'));
    const blocks = [];
    for (let n = 0; n < meta.chunks.length; n++) blocks.push(...json(await get(`/api/libraries/api-fixture/books/3/chunks/${n}`)).blocks);
    const img = blocks.find((b) => b.t === 'img');
    assert.equal(img.src, '/api/libraries/api-fixture/books/3/res/OPS/img/fig%20%C3%A9.png');
    assert.deepEqual([img.w, img.h], [320, 200]);
    const r = await get(img.src);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.body, FIG);
    assert.ok(r.headers.etag);
    assert.equal((await get(img.src, { headers: { 'if-none-match': r.headers.etag } })).status, 304);
    assert.equal((await get('/api/libraries/api-fixture/books/3/res/OPS/none.png')).status, 404);
    assert.equal((await get('/api/libraries/api-fixture/books/2/res/OPS/t.xhtml')).status, 404, 'no EPUB');
  });

  it('answers 500 JSON when a conversion fails, and keeps serving', async () => {
    const r = await get('/api/libraries/api-fixture/books/4');
    assert.equal(r.status, 500);
    assert.match(json(r).error, /^internal error: /);
    assert.ok(errors.some((e) => /books\/4/.test(e)), 'logged');
    assert.equal((await get('/api/libraries')).status, 200);
  });

  it('404s unknown /api paths and rejects other methods', async () => {
    for (const p of ['/api', '/api/', '/api/nope', '/api/libraries/api-fixture', '/api/libraries/api-fixture/x',
      '/api/libraries/api-fixture/books/1/nope', '/api/libraries/api-fixture/books/1/chunks']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.ok(json(r).error, p);
    }
    const post = await get('/api/libraries', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal(json(post).error, 'method not allowed');
    const bad = await get('/api/libraries/%E0%A4%A');
    assert.equal(bad.status, 400);
    assert.match(json(bad).error, /percent-encoding/);
  });

  it('GET /zim/:lib/<path> with per-segment encoding, headers and redirects', async () => {
    const book = await get(`/zim/api-fixture/C/${encodeURIComponent(`${UNICODE_TITLE}.2`)}`);
    assert.equal(book.status, 200);
    assert.equal(book.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(book.headers['content-security-policy'], 'sandbox');
    const css = await get(`/zim/api-fixture/${enc('C/dir/sub dir/file name (1).css')}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=iso-8859-1', 'existing charset kept');
    const txt = await get('/zim/api-fixture/C/notes.txt');
    assert.equal(txt.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(txt.body.toString('utf8'), 'plain text ✓');

    const snd = await get('/zim/api-fixture/C/sound.mp3');
    assert.equal(snd.status, 200);
    assert.equal(snd.headers['content-type'], 'audio/mpeg');
    assert.equal(snd.headers['content-length'], '5000');
    assert.equal(snd.headers['cache-control'], 'public, max-age=86400');
    assert.equal(snd.headers['accept-ranges'], 'bytes');
    const index = (await lib.archive.findPath('C/sound.mp3')).index;
    assert.equal(snd.headers.etag, `"${lib.archive.header.uuid}-${index}"`);
    assert.deepEqual(snd.body, SOUND);
    const alias = await get('/zim/api-fixture/C/alias.mp3');
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.etag, snd.headers.etag, 'redirect served as its target');
    assert.deepEqual(alias.body, SOUND);

    assert.equal((await get('/zim/api-fixture/C/sound.mp3', { headers: { 'if-none-match': snd.headers.etag } })).status, 304);
    assert.equal((await get('/zim/api-fixture/C/sound.mp3', { headers: { 'if-none-match': `"x", W/${snd.headers.etag}` } })).status, 304);
    const head = await get('/zim/api-fixture/C/sound.mp3', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '5000');
    assert.equal(head.body.length, 0);

    for (const p of ['/zim/api-fixture/C/missing', '/zim/api-fixture/C', '/zim/api-fixture', '/zim/nope/C/sound.mp3',
      '/zim/api-fixture/C/sound.mp3/', '/zim/api-fixture/X/sound.mp3', '/zim/api-fixture/../../package.json']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.ok(json(r).error);
    }
    assert.equal((await get('/zim/api-fixture/C/%ZZ')).status, 400);
  });

  it('honours single byte ranges (206/416)', async () => {
    const url = '/zim/api-fixture/C/sound.mp3';
    const r = await get(url, { headers: { range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 100-199/5000');
    assert.equal(r.headers['content-length'], '100');
    assert.deepEqual(r.body, SOUND.subarray(100, 200));
    const open = await get(url, { headers: { range: 'bytes=4990-' } });
    assert.equal(open.status, 206);
    assert.deepEqual(open.body, SOUND.subarray(4990));
    const suffix = await get(url, { headers: { range: 'bytes=-10' } });
    assert.equal(suffix.headers['content-range'], 'bytes 4990-4999/5000');
    const clamp = await get(url, { headers: { range: 'bytes=4000-999999' } });
    assert.equal(clamp.headers['content-range'], 'bytes 4000-4999/5000');
    const bad = await get(url, { headers: { range: 'bytes=5000-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], 'bytes */5000');
    assert.equal((await get(url, { headers: { range: 'bytes=0-1,5-6' } })).status, 200, 'multi-range → full body');
    assert.equal((await get(url, { headers: { range: 'items=0-1' } })).status, 200);
    const etag = r.headers.etag;
    assert.equal((await get(url, { headers: { range: 'bytes=0-9', 'if-range': etag } })).status, 206);
    assert.equal((await get(url, { headers: { range: 'bytes=0-9', 'if-range': '"other"' } })).status, 200);
  });

  it('serves public/ files with MIME types and no-cache', async () => {
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(root.headers['cache-control'], 'no-cache');
    assert.equal(root.body.toString(), '<!doctype html><title>vrlbry</title>');
    const types = {
      '/js/app.js': 'text/javascript; charset=utf-8',
      '/js/mod.mjs': 'text/javascript; charset=utf-8',
      '/css/style.css': 'text/css; charset=utf-8',
      '/img/icon.svg': 'image/svg+xml',
      '/data/x.json': 'application/json; charset=utf-8',
      '/fonts/f.woff2': 'font/woff2',
      '/models/m.glb': 'model/gltf-binary',
      '/env/sky.hdr': 'image/vnd.radiance',
      '/wasm/a.wasm': 'application/wasm',
      '/favicon.ico': 'image/x-icon',
      '/blob.unknownext': 'application/octet-stream',
      '/index.html': 'text/html; charset=utf-8',
      '/sub/': 'text/html; charset=utf-8',
    };
    for (const [p, type] of Object.entries(types)) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['cache-control'], 'no-cache', p);
    }
    // A folder without its trailing slash is redirected, so relative links inside it resolve.
    const redirects = {
      '/sub': '/sub/',
      '/sub?x=1&y=%20': '/sub/?x=1&y=%20',
      '//sub': '/sub/', // never '//sub/' (protocol-relative: an open redirect)
      '/vendor/three/build': '/vendor/three/build/',
    };
    for (const [p, location] of Object.entries(redirects)) {
      const r = await get(p);
      assert.equal(r.status, 301, p);
      assert.equal(r.headers.location, location, p);
    }
    const etag = root.headers.etag;
    assert.equal((await get('/', { headers: { 'if-none-match': etag } })).status, 304);
    const part = await get('/big.txt', { headers: { range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), 'cde');
    for (const p of ['/missing.js', '/.secret', '/js/missing/x.js']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    }
  });

  it('maps /vendor/three and /vendor/iwer to node_modules with a long cache', async () => {
    const three = await get('/vendor/three/build/three.module.js', { method: 'HEAD' });
    assert.equal(three.status, 200);
    assert.equal(three.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(three.headers['cache-control'], /^public, max-age=\d{6,}$/);
    assert.equal(Number(three.headers['content-length']), fs.statSync(path.join(REPO, 'node_modules/three/build/three.module.js')).size);
    const addon = await get('/vendor/three/examples/jsm/controls/OrbitControls.js', { method: 'HEAD' });
    assert.equal(addon.status, 200);
    const iwer = await get('/vendor/iwer/iwer.module.js', { method: 'HEAD' });
    assert.equal(iwer.status, 200);
    assert.equal(iwer.headers['content-type'], 'text/javascript; charset=utf-8');
    for (const p of ['/vendor/three', '/vendor/nope/x.js', '/vendor/three/build/missing.js']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  it('rejects path traversal and never serves files outside the roots', async () => {
    const attempts = [
      '/..%2f..%2fpackage.json',
      '/../package.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/js/../../package.json',
      '/vendor/three/../../package.json',
      '/vendor/three/../../../package.json',
      '/vendor/three/%2e%2e/%2e%2e/package.json',
      '/vendor/three/..%2f..%2fpackage.json',
      '/vendor/three/..%5c..%5cpackage.json',
      '/vendor/iwer/..%2f..%2f..%2fpackage.json',
      '/..%5c..%5cpackage.json',
      '/js%2f..%2f..%2fpackage.json',
      '/C:%5cWindows%5cwin.ini',
      '/index.html%00.js',
      '/index.html::$DATA',
      `/${encodeURIComponent(REPO)}%2fpackage.json`,
      '//etc/passwd',
    ];
    for (const p of attempts) {
      const r = await get(p);
      assert.ok(r.status === 400 || r.status === 404, `${p} → ${r.status}`);
      assert.ok(!r.body.toString().includes(PKG_MARKER), p);
    }
  });

  it('answers / with a plain 404 when public/index.html does not exist', async () => {
    const empty = path.join(tmp, 'empty-public');
    fs.mkdirSync(empty);
    const s = await startServer(createApp(library, { publicDir: empty, log: () => {} }));
    try {
      const r = await request(s.address().port, '/');
      assert.equal(r.status, 404);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
      assert.match(r.body.toString(), /index\.html/);
    } finally {
      s.close();
    }
  });

  it('logged nothing unexpected', () => {
    assert.ok(errors.every((e) => /books\/4/.test(e)), errors.join('\n'));
  });
});

describe('HTTP API (real Gutenberg ZIM)', { skip: !fs.existsSync(REAL_ZIM) && 'real ZIM not present' }, () => {
  let library;
  let server;
  let get;
  before(async () => {
    library = await Library.scan(REPO, { log: () => {} });
    server = await startServer(createApp(library, { log: () => {} }));
    get = (p, opts) => request(server.address().port, p, opts);
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await library?.close();
  });

  it('lists the library and its 258 books', async () => {
    const libs = JSON.parse((await get('/api/libraries')).body).libraries;
    const real = libs.find((l) => l.id === REAL_ID);
    assert.equal(real.bookCount, 258);
    assert.equal(real.title, 'Project Gutenberg Library');
    const ill = await get(real.illustration);
    assert.equal(ill.status, 200);
    assert.equal(ill.headers['content-type'], 'image/png');
    const t0 = performance.now();
    const r = await get(`/api/libraries/${REAL_ID}/books`, { headers: { 'accept-encoding': 'gzip' } });
    assert.ok(performance.now() - t0 < 1000);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const { books } = JSON.parse(zlib.gunzipSync(r.body));
    assert.equal(books.length, 258);
    const cover = await get(books[0].cover, { method: 'HEAD' });
    assert.equal(cover.status, 200);
    assert.equal(cover.headers['content-type'], 'image/jpeg');
  });

  for (const id of ['37134', '26577', '28909']) {
    it(`serves meta and every chunk of ${id}, with resolvable images`, async () => {
      const meta = JSON.parse((await get(`/api/libraries/${REAL_ID}/books/${id}`)).body);
      assert.equal(meta.source, id === '37134' ? 'html' : 'epub');
      let chars = 0;
      for (let n = 0; n < meta.chunks.length; n++) {
        const r = await get(`/api/libraries/${REAL_ID}/books/${id}/chunks/${n}`, { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);
        assert.equal(body.index, n);
        assert.equal(body.blocks.length, meta.chunks[n].blocks);
        chars += meta.chunks[n].chars;
        for (const b of body.blocks.filter((x) => x.t === 'img')) {
          const img = await get(b.src, { method: 'HEAD' });
          assert.equal(img.status, 200, b.src);
          assert.match(img.headers['content-type'], /^image\//);
        }
      }
      assert.equal(chars, meta.totalChars);
    });
  }

  it('serves raw entries whose URLs have spaces, quotes, colons and accents', async () => {
    for (const p of ["C/Away to school: 'Ólta'góó.56199", 'C/"Stops", Or How to Punctuate.20938',
      "C/'Round the Year in Myth and Song.44765.epub", 'M/Illustration_48x48@1']) {
      const r = await get(`/zim/${REAL_ID}/${enc(p)}`, { method: 'HEAD' });
      assert.equal(r.status, 200, p);
      assert.ok(Number(r.headers['content-length']) > 0, p);
    }
    const epub = await get(`/zim/${REAL_ID}/${enc('C/The Elements of Style.37134.epub')}`, { headers: { range: 'bytes=0-3' } });
    assert.equal(epub.status, 206);
    assert.equal(epub.headers['content-type'], 'application/epub+zip');
    assert.deepEqual(epub.body, Buffer.from('PK\x03\x04', 'latin1'));
    const mp3 = await get(`/zim/${REAL_ID}/C/69072_music01.mp3`, { headers: { range: 'bytes=1000-1999' } });
    assert.equal(mp3.status, 206);
    assert.equal(mp3.body.length, 1000);
  });
});

describe('CLI (server/index.js)', () => {
  it('parses arguments', () => {
    const d = parseCliArgs([]);
    assert.equal(d.dir, process.cwd());
    assert.equal(d.port, 8080);
    assert.equal(d.host, undefined);
    assert.equal(d.https, false);
    assert.equal(d.maxGeneric, 2000);
    assert.equal(d.quiet, false);
    const o = parseCliArgs(['--dir', 'x', '--port=9000', '--host', '127.0.0.1', '--https', '--max-generic', '5', '--quiet']);
    assert.equal(o.dir, path.resolve('x'));
    assert.equal(o.port, 9000);
    assert.equal(o.host, '127.0.0.1');
    assert.equal(o.https, true);
    assert.equal(o.maxGeneric, 5);
    assert.equal(o.quiet, true);
    assert.equal(parseCliArgs(['--cert', 'c.pem', '--key', 'k.pem']).https, true);
    assert.equal(parseCliArgs(['-h']).help, true);
    assert.throws(() => parseCliArgs(['--port', 'abc']), /--port/);
    assert.throws(() => parseCliArgs(['--port', '70000']), /--port/);
    assert.throws(() => parseCliArgs(['--max-generic', '0']), /--max-generic/);
    assert.throws(() => parseCliArgs(['--cert', 'c.pem']), /together/);
    assert.throws(() => parseCliArgs(['--bogus']));
    assert.throws(() => parseCliArgs(['stray']), /unexpected argument/);
  });

  it('starts, serves, falls back to the next port when busy, and shuts down', async () => {
    const dir = path.join(tmp, 'cli');
    fs.mkdirSync(dir);
    writeFixture(path.join(dir, 'cli.zim'));
    // Occupy a port so the CLI has to move on to the next one.
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busy = blocker.address().port;
    const out = [];
    let app;
    try {
      app = await main(['--dir', dir, '--port', String(busy), '--host', '127.0.0.1'], {
        out: (m) => out.push(m), err: (m) => out.push(m), handleSignals: false,
      });
      assert.equal(app.port, busy + 1);
      assert.deepEqual(app.urls, [`http://127.0.0.1:${busy + 1}`]);
      const text = out.join('\n');
      assert.match(text, new RegExp(`Port ${busy} is in use`));
      assert.match(text, /cli\.zim\s+—\s+API Fixture\s+\(5 books, gutenberg\)/);
      assert.match(text, /HTTPS/);
      const r = await fetch(`${app.urls[0]}/api/libraries`);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).libraries[0].id, 'cli');
    } finally {
      await app?.close();
      blocker.close();
    }
    await assert.rejects(fetch(`http://127.0.0.1:${busy + 1}/api/libraries`));
  });

  it('prints only the URL with --quiet and returns null for --help', async () => {
    const out = [];
    const err = [];
    const app = await main(['--dir', path.join(tmp, 'cli'), '--port', '0', '--host', '127.0.0.1', '--quiet'], {
      out: (m) => out.push(m), err: (m) => err.push(m), handleSignals: false,
    });
    try {
      assert.deepEqual(out, [`vrlbry listening on ${app.urls[0]}`]);
      assert.deepEqual(err, ['cli.zim: 1 book(s) have neither HTML nor EPUB in the archive'], 'the fixture\'s "Ghost" book');
    } finally {
      await app.close();
    }
    const help = [];
    assert.equal(await main(['--help'], { out: (m) => help.push(m), handleSignals: false }), null);
    assert.match(help.join(''), /--max-generic/);
    await assert.rejects(main(['--dir', path.join(tmp, 'does-not-exist'), '--port', '0'], {
      out: () => {}, err: () => {}, handleSignals: false,
    }), /not a directory/);
  });

  it('generates, caches and serves a self-signed certificate for --https', async () => {
    const certDir = path.join(tmp, 'cert');
    const first = await loadCertificate({ certDir });
    assert.equal(first.generated, true);
    assert.ok(fs.existsSync(path.join(certDir, 'cert.pem')) && fs.existsSync(path.join(certDir, 'key.pem')));
    const second = await loadCertificate({ certDir });
    assert.equal(second.generated, false, 'cached');
    assert.equal(second.cert, first.cert);
    const x = new crypto.X509Certificate(first.cert);
    assert.match(x.subjectAltName, /DNS:localhost/);
    assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);
    for (const ip of first.names.ips) assert.ok(x.subjectAltName.includes(`IP Address:${ip}`), ip);
    assert.ok(Date.parse(x.validTo) - Date.now() > 300 * 86400e3);

    // A certificate for other names is replaced.
    const { default: selfsigned } = await import('selfsigned');
    const other = await selfsigned.generate([{ name: 'commonName', value: 'other' }], { keyType: 'ec', algorithm: 'sha256' });
    fs.writeFileSync(path.join(certDir, 'cert.pem'), other.cert);
    fs.writeFileSync(path.join(certDir, 'key.pem'), other.private);
    const third = await loadCertificate({ certDir });
    assert.equal(third.generated, true);

    // And it actually works for TLS.
    const server = https.createServer({ key: third.key, cert: third.cert }, (req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, path: '/', rejectUnauthorized: false, agent: false }, (res) => {
          let s = '';
          res.on('data', (c) => { s += c; });
          res.on('end', () => resolve(s));
        }).on('error', reject);
      });
      assert.equal(body, 'ok');
    } finally {
      server.close();
    }
    // Given files are used as-is.
    const given = await loadCertificate({ certFile: path.join(certDir, 'cert.pem'), keyFile: path.join(certDir, 'key.pem') });
    assert.equal(given.generated, false);
    assert.equal(given.cert, third.cert);
  });

  it('still serves HTTPS when the certificate cannot be cached', async () => {
    const blocker = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const logged = [];
    const r = await loadCertificate({ certDir: path.join(blocker, 'cert'), log: (m) => logged.push(m) });
    assert.equal(r.generated, true);
    assert.equal(r.cached, false);
    assert.ok(new crypto.X509Certificate(r.cert).checkPrivateKey(crypto.createPrivateKey(r.key)), 'key matches certificate');
    assert.match(logged.join('\n'), /Cannot cache the HTTPS certificate/);
  });

  it('reports skipped archives on stderr even with --quiet', async () => {
    const dir = path.join(tmp, 'cli-quiet');
    fs.mkdirSync(dir);
    writeFixture(path.join(dir, 'good.zim'));
    fs.writeFileSync(path.join(dir, 'bad.zim'), 'not a zim');
    const out = [];
    const err = [];
    const app = await main(['--dir', dir, '--port', '0', '--host', '127.0.0.1', '--quiet'], {
      out: (m) => out.push(m), err: (m) => err.push(m), handleSignals: false,
    });
    try {
      assert.deepEqual(out, [`vrlbry listening on ${app.urls[0]}`]);
      assert.equal(err.length, 2, err.join('\n'));
      assert.match(err[0], /^bad\.zim: skipped, cannot open/);
      assert.equal(err[1], 'good.zim: 1 book(s) have neither HTML nor EPUB in the archive');
    } finally {
      await app.close();
    }
  });
});
