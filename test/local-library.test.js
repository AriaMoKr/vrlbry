// The local library (step 2): ZIM files opened in a browser, read by the shared core over a File
// with the browser's platform (fzstd, fflate, plain Uint8Arrays) in a worker (local-handler.js).
// Each archive is read twice, by the core on Node's platform from the file (as the server reads
// it) and by the local library's handler from a File on the browser's platform, and every answer
// must be the same: catalogue, books, reading metadata, chunks, images. Read from a web address
// (milestone 3: range requests, as from Kiwix's mirror) too.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { decompress as zstdDecompress } from 'fzstd';
import { inflateSync, unzlibSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { nodePlatform } from '../server/platform-node.js';
import { ArchiveLibrary } from '../public/js/core/library.js';
import { defaults, provide } from '../public/js/core/platform.js';
import { blockCache } from '../public/js/local/block-cache.js';
import { browserPlatform } from '../public/js/local/browser-platform.js';
import { idbStore } from '../public/js/local/idb-store.js';
import { createLocalLibraries } from '../public/js/local/local-handler.js';
import { memoryStore, withPrebuilt } from '../public/js/local/prebuilt.js';
import { fileStore } from '../server/cache-store.js';
import { png, writeGenericZim, writeGutenbergZim, writeOldGutenbergZim, writeWikipediaZim, writeWikisourceZim } from './helpers/zim-fixtures.js';
import { writeZim } from './helpers/zimwriter.js';
import { startRangeServer } from './helpers/range-server.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ZIM = path.join(REPO, 'gutenberg_en_lcc-pe_2026-03.zim');

const browser = { ...defaults, ...browserPlatform({ zstdDecompress, unzlibSync, inflateSync, Parser }) };
const utf8 = new TextDecoder();

let tmp;
let web; // a server of range requests, for ZIMs opened from a web address
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-local-'));
  web = await startRangeServer();
});
after(async () => {
  provide(nodePlatform);
  await web.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A file on disk as the File a browser's picker gives. */
const asFile = (file) => new File([fs.readFileSync(file)], path.basename(file));

/**
 * What the server's core answers for an archive (Node's platform, from the file): the catalogue,
 * books, and per book (up to `limit`) its metadata, every chunk's JSON and its cover's bytes.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Article searches compared for a Wikipedia: a title prefix, a title key ("the"), another name (a redirect), nothing. */
const SEARCHES = ['ap', 'beatles', 'yellow', 'zz'];

/** Waits while `indexing()` reports a Wikipedia's index being built (a test archive: milliseconds). */
async function indexed(indexing) {
  for (let i = 0; i < 500; i++) {
    if (!(await indexing())) return;
    await sleep(20);
  }
  throw new Error('the index was not built');
}

async function serverAnswers(file, limit = Infinity) {
  provide(nodePlatform);
  const lib = await ArchiveLibrary.open(file, { log: () => {} });
  try {
    await indexed(async () => (await lib.info()).indexing);
    const out = { info: await lib.info(), books: await lib.books(), byBook: {} };
    if (out.info.kind === 'wikipedia') out.search = await Promise.all(SEARCHES.map((q) => lib.searchArticles(q, 8)));
    for (const book of out.books.slice(0, limit)) {
      const { meta } = await lib.content(book.id).catch((err) => ({ meta: { error: err.message } }));
      const chunks = [];
      for (let n = 0; n < (meta.chunks?.length ?? 0); n++) chunks.push(utf8.decode((await lib.chunk(book.id, n)).json));
      const cover = book.cover ? await lib.archive.getContent(decodeURIComponent(book.cover.split('/').slice(3).join('/'))) : null;
      out.byBook[book.id] = { meta, chunks, cover: cover && Buffer.from(cover.data).toString('base64') };
    }
    return out;
  } finally {
    await lib.close();
  }
}

/** The same, from the local library's handler (the browser's platform, from a File). */
async function localAnswers(local, id, limit = Infinity) {
  provide(browser);
  await indexed(async () => (await local.call('catalog')).value.libraries.find((l) => l.id === id).indexing);
  const { value: catalog } = await local.call('catalog');
  const out = { info: catalog.libraries.find((l) => l.id === id), books: (await local.call('books', { lib: id })).value, byBook: {} };
  if (out.info.kind === 'wikipedia') out.search = await Promise.all(SEARCHES.map((q) => local.call('articles', { lib: id, q, limit: 8 }).then((r) => r.value)));
  for (const book of out.books.slice(0, limit)) {
    const meta = await local.call('meta', { lib: id, book: book.id }).then((r) => r.value, (err) => ({ error: err.message }));
    const chunks = [];
    for (let n = 0; n < (meta.chunks?.length ?? 0); n++) chunks.push(utf8.decode((await local.call('chunk', { lib: id, book: book.id, n })).value));
    const cover = book.cover ? (await local.call('image', { url: book.cover })).value : null;
    out.byBook[book.id] = { meta, chunks, cover: cover && Buffer.from(cover.bytes).toString('base64') };
  }
  return out;
}

/** Answers with the local library's id ('~x') written as the server's ('x'). */
const asServer = (answers, id) => JSON.parse(JSON.stringify(answers).split(`~${id}`).join(id));

/**
 * Opens `file` in the local library, from a File or (via 'url') from a web address, and compares
 * every answer with the server's.
 */
async function sameAnswers(file, { limit, store = null, onIndexing = null, via = 'file' } = {}) {
  const id = path.basename(file).replace(/\.zim$/i, '');
  const server = await serverAnswers(file, limit);
  const local = createLocalLibraries({ store, onIndexing });
  provide(browser);
  const url = via === 'url' ? web.serve(file).url : null;
  const opened = (await local.call('open', url ? { url } : { file: asFile(file) })).value;
  assert.equal(opened.id, `~${id}`);
  assert.equal(opened.url, url ?? undefined, 'a web address is given back');
  const fromFile = asServer(await localAnswers(local, opened.id, limit), id);
  if (url) {
    assert.equal(fromFile.info.url, url, 'the catalogue entry says where it is read from');
    delete fromFile.info.url;
  }
  assert.deepEqual(fromFile.info, server.info, 'catalogue entry');
  // The browser estimates sizes rather than reading them (for the thickness on the shelf, which
  // grows with the logarithm): within an order of magnitude of what the server reads.
  const sized = (books) => books.map(({ size, ...b }) => b);
  assert.deepEqual(sized(fromFile.books), sized(server.books), 'books');
  // (A small book sharing a cluster with big ones gets their average: the reference ZIM has a few
  // at 35×, which is still at most half again as thick.)
  const ratios = server.books.map((b, i) => (b.size ? fromFile.books[i].size / b.size : null)).filter((r) => r !== null);
  if (ratios.length) {
    const show = ratios.map((r) => r.toFixed(2)).join(' ');
    assert.ok(ratios.every((r) => r > 0.01 && r < 100), `every estimate within 100×: ${show}`);
    assert.ok(ratios.filter((r) => r > 0.1 && r < 10).length >= 0.9 * ratios.length, `9 in 10 within 10×: ${show}`);
  }
  for (const book of Object.keys(server.byBook)) assert.deepEqual(fromFile.byBook[book], server.byBook[book], `book ${book}`);
  if (server.search) {
    assert.deepEqual(fromFile.search, server.search, 'article search');
    assert.ok(server.search[0].some((a) => a.title === 'apple') && server.search[1].some((a) => a.title === 'The Beatles') && server.search[2].some((a) => a.title === 'Banana') && !server.search[3].length, JSON.stringify(server.search));
  }
  assert.ok(Object.values(server.byBook).some((b) => b.chunks.length), 'some text was compared');
  return { local, id: opened.id, server };
}

describe('local library (ZIM files read in the browser)', () => {
  it('answers like the server for a Gutenberg ZIM (zstd clusters, EPUB-only books, images)', async () => {
    const { local, id, server } = await sameAnswers(writeGutenbergZim(path.join(tmp, 'gutenberg.zim')).filePath);
    provide(browser);
    // An EPUB's own image (/res/ URL) and a page image, as the reader asks for them.
    const epub = server.byBook['105'].chunks.join('');
    const res = /"(\/api\/libraries\/[^"]+\/res\/[^"]+)"/.exec(epub)[1].replace('/gutenberg/', `/${id}/`);
    const fig = (await local.call('image', { url: res })).value;
    assert.equal(fig.mime, 'image/png');
    assert.deepEqual(Buffer.from(fig.bytes), png(300, 150));
    const logo = (await local.call('image', { url: `/zim/${id}/C/106_logo.png` })).value;
    assert.deepEqual(Buffer.from(logo.bytes), png(120, 60));
    assert.equal((await local.call('image', { url: `/zim/${id}/C/nothing.png` })).value, null);
    assert.equal((await local.call('image', { url: '/zim/gutenberg/C/106_logo.png' })).value, null, 'not a local library');
  });

  it('answers like the server for an old-scheme Gutenberg ZIM (zlib clusters)', async () => {
    await sameAnswers(writeOldGutenbergZim(path.join(tmp, 'old.zim')).filePath);
  });

  it('answers like the server for a generic ZIM, with zstd or xz clusters', async () => {
    await sameAnswers(writeGenericZim(path.join(tmp, 'generic.zim')).filePath);
    const html = (t) => `<html><head><title>${t}</title></head><body><h1>${t}</h1><p>${'Words of the page. '.repeat(50)}</p></body></html>`;
    const xz = writeZim(path.join(tmp, 'generic-xz.zim'), {
      scheme: 'new', compression: 'xz', mainPage: 'C/index.html',
      entries: [
        { ns: 'C', url: 'index.html', title: 'Main', mime: 'text/html', content: html('Main') },
        { ns: 'C', url: 'one.html', title: 'One', mime: 'text/html', content: html('One') },
        { ns: 'C', url: 'two.html', title: 'Two', mime: 'text/html', content: html('Two') },
      ],
    });
    await sameAnswers(xz.filePath);
  });

  it('answers like the server for the reference Gutenberg ZIM', { skip: !fs.existsSync(REAL_ZIM) && 'reference ZIM absent' }, async () => {
    await sameAnswers(REAL_ZIM, { limit: 12 });
  });

  it('reports progress while a file opens and while a book is prepared', async () => {
    provide(browser);
    const local = createLocalLibraries();
    const climbs = (values, what) => {
      assert.ok(values.length, `${what}: some progress`);
      assert.ok(values.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= values[i - 1])), `${what}: from 0 to 1, never back: ${values}`);
      assert.equal(values.at(-1), 1, `${what}: ends at 1`);
    };
    const opening = [];
    const { id } = (await local.call('open', { file: asFile(writeGutenbergZim(path.join(tmp, 'progress.zim')).filePath) }, { onProgress: (f) => opening.push(f) })).value;
    climbs(opening, 'Gutenberg catalogue');
    const generic = [];
    await local.call('open', { file: asFile(writeGenericZim(path.join(tmp, 'progress-generic.zim')).filePath) }, { onProgress: (f) => generic.push(f) });
    climbs(generic, 'generic catalogue');
    // A book with images (two requests at once share one conversion, and both hear of it) and one without.
    const [a, b] = [[], []];
    await Promise.all([
      local.call('meta', { lib: id, book: '106' }, { onProgress: (f) => a.push(f) }),
      local.call('meta', { lib: id, book: '106' }, { onProgress: (f) => b.push(f) }),
    ]);
    climbs(a, 'images book');
    climbs(b, 'images book, second request');
    assert.ok(a.length > 3, `one step per image: ${a}`);
    const plain = [];
    await local.call('meta', { lib: id, book: '102' }, { onProgress: (f) => plain.push(f) });
    climbs(plain, 'book without images');
    const cached = [];
    await local.call('meta', { lib: id, book: '102' }, { onProgress: (f) => cached.push(f) });
    assert.deepEqual(cached, [], 'nothing to report for a converted book');
  });

  it('indexes a Wikipedia ZIM in the background, once: the index is kept in the store', async () => {
    const file = writeWikipediaZim(path.join(tmp, 'wikipedia_test.zim')).filePath;
    const factory = new IDBFactory();
    const store = idbStore('local', { indexedDB: factory });
    // Opened: indexing, no books yet; then the same volume, articles and images as the server.
    const events = [];
    const { local, id } = await sameAnswers(file, { store, onIndexing: (libId, info) => events.push({ libId, info }) });
    const opened = (await local.call('open', { file: asFile(file) })).value;
    assert.equal(opened.kind, 'wikipedia');
    // The build's progress was reported as it went: the stages in order, then null once ready.
    assert.ok(events.length >= 4 && events.every((e) => e.libId === id), `${events.length} events for ${id}`);
    const stages = [...new Set(events.map((e) => e.info?.stage ?? 'ready'))];
    assert.deepEqual(stages, ['queued', 'scan', 'sizes', 'sort', 'ready'], stages.join(' '));
    assert.ok(events.slice(0, -1).every((e, k) => k === 0 || e.info.progress >= events[k - 1].info.progress), 'progress never falls');
    assert.equal(events.at(-1).info, null);
    assert.deepEqual([...new Set((await store.names()).map((n) => n.replace(/-[0-9a-f]{32}\./, '-<uuid>.')))], ['wikipedia-<uuid>.v4.json'], 'the index, no checkpoint left');
    // Opened again (another page load): the index is found by the ZIM's UUID, nothing is built.
    const again = createLocalLibraries({ store });
    provide(browser);
    const back = (await again.call('open', { file: asFile(file) })).value;
    assert.equal(back.indexing, null, 'not indexing');
    assert.equal(back.books, 1, 'one volume');
    const books = (await again.call('books', { lib: back.id })).value;
    assert.equal(books[0].title, (await local.call('books', { lib: id })).value[0].title);
    store.close();
  });

  it('indexes files opened together one at a time, the smallest first; closing one stops its build', async () => {
    provide(browser);
    // Three Wikipedias of different sizes (padding), opened as a batch (local.js holds the queue).
    const files = [['big', 3_000_000], ['small', 0], ['middle', 1_500_000], ['dropped', 500_000]]
      .map(([name, pad]) => asFile(writeWikipediaZim(path.join(tmp, `wikipedia_${name}.zim`), pad).filePath));
    const events = [];
    const local = createLocalLibraries({ onIndexing: (id, info) => events.push({ id, stage: info?.stage ?? 'ready' }) });
    await local.call('hold');
    const ids = [];
    for (const file of files) ids.push((await local.call('open', { file })).value.id);
    assert.ok(events.every((e) => e.stage === 'queued'), 'nothing built while the batch opens');
    // One closed while it waits: its build never starts.
    await local.call('close', { lib: ids[3] });
    await local.call('release');
    await indexed(async () => (await local.call('catalog')).value.libraries.some((l) => l.indexing));
    // In turn: each build ends before the next starts, the smallest first.
    const started = [];
    const active = new Set();
    for (const e of events) {
      if (e.stage === 'queued') continue;
      if (e.stage === 'ready') active.delete(e.id);
      else {
        if (!active.has(e.id)) started.push(e.id);
        active.add(e.id);
      }
      assert.ok(active.size <= 1, `two builds at once: ${[...active]}`);
    }
    assert.deepEqual(started, [ids[1], ids[2], ids[0]], 'small, middle, big');
    assert.equal(events.some((e) => e.id === ids[3] && e.stage !== 'queued'), false, 'the closed one never built');
    const libs = (await local.call('catalog')).value.libraries;
    assert.deepEqual(libs.map((l) => l.id), ids.slice(0, 3));
    assert.ok(libs.every((l) => l.bookCount === 1 && !l.indexing));
    // Closed while its build runs: no word from it after the close.
    const runner = asFile(writeWikipediaZim(path.join(tmp, 'wikipedia_runner.zim'), 4_000_000).filePath);
    const { id } = (await local.call('open', { file: runner })).value;
    const before = events.length;
    await local.call('close', { lib: id });
    await sleep(300);
    assert.deepEqual(events.slice(before).filter((e) => e.id === id), [], 'silent once closed');
    assert.equal((await local.call('catalog')).value.libraries.some((l) => l.id === id), false);
  });

  it('skips the build when the site ships the index (prebuilt.js)', async () => {
    const file = writeWikipediaZim(path.join(tmp, 'wikipedia_prebuilt.zim')).filePath;
    // The index as the server (or tools/build-pages.mjs --indexes) builds it, in a folder.
    provide(nodePlatform);
    const built = path.join(tmp, 'prebuilt');
    const lib = await ArchiveLibrary.open(file, { log: () => {}, store: fileStore(built) });
    await indexed(async () => (await lib.info()).indexing);
    await lib.close();
    const [name] = fs.readdirSync(built);
    assert.match(name, /^wikipedia-[0-9a-f]{32}\.v\d+\.json$/);
    // The local library asks the site for an index it lacks: no build, the volume at once.
    const asked = [];
    const site = withPrebuilt(memoryStore(), async (n) => { asked.push(n); return fs.existsSync(path.join(built, n)) ? fs.readFileSync(path.join(built, n), 'utf8') : null; });
    const events = [];
    const local = createLocalLibraries({ store: site, onIndexing: (id, info) => events.push(info) });
    provide(browser);
    const opened = (await local.call('open', { file: asFile(file) })).value;
    assert.deepEqual({ kind: opened.kind, books: opened.books, indexing: opened.indexing }, { kind: 'wikipedia', books: 1, indexing: null });
    assert.deepEqual(asked, [name]);
    assert.deepEqual(events, [], 'nothing was built');
    assert.deepEqual(await site.names(), [name], 'kept in the store');
    assert.equal((await local.call('books', { lib: opened.id })).value[0].title, '2001: A Space Odyssey – Zebra');
  });

  it('answers like the server for a Wikisource ZIM, its works indexed in the worker and kept in the store', async () => {
    const file = writeWikisourceZim(path.join(tmp, 'wikisource_test.zim')).filePath;
    const factory = new IDBFactory();
    const store = idbStore('local', { indexedDB: factory });
    const { local, id, server } = await sameAnswers(file, { store });
    assert.equal(server.info.kind, 'wikisource');
    assert.deepEqual(server.books.map((b) => b.title), ['Songs of Dusk', 'The Grey House']);
    assert.ok(Object.values(server.byBook).every((b) => b.chunks.length), 'every work read');
    assert.ok((await store.names()).some((n) => /^wikisource-[0-9a-f]{32}\.v\d+\.json$/.test(n)), 'the works index is in the store');
    // Opened again: from the store, at once.
    const again = createLocalLibraries({ store });
    provide(browser);
    const back = (await again.call('open', { file: asFile(file) })).value;
    assert.equal(back.indexing, null);
    assert.equal(back.books, 2);
    assert.equal((await local.call('catalog')).value.libraries.find((l) => l.id === id).kind, 'wikisource');
    store.close();
  });

  it('answers like the server for ZIMs read from a web address (range requests)', async () => {
    const before = web.requests.length;
    for (const write of [writeGutenbergZim, writeOldGutenbergZim, writeGenericZim, writeWikipediaZim, writeWikisourceZim]) {
      const file = write(path.join(tmp, `web-${write.name.replace(/^write|Zim$/g, '').toLowerCase()}.zim`)).filePath;
      await sameAnswers(file, { via: 'url' });
    }
    const asked = web.requests.slice(before);
    assert.ok(asked.length >= 10, `read over HTTP, a probe and reads for each: ${asked.length} requests`);
    assert.ok(asked.every((r) => r.method === 'GET' && /^bytes=\d+-\d+$/.test(r.range)), 'only range requests');
  });

  it('keeps what it read from the web (block cache): read again, a ZIM costs only its probe', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'web-kept.zim')).filePath;
    const { url } = web.serve(file);
    const indexedDB = new IDBFactory();
    /** Opens the ZIM from its address in a new local library (a page) and reads every book. */
    const readAll = async () => {
      const blocks = blockCache({ indexedDB });
      const local = createLocalLibraries({ blockCache: blocks });
      provide(browser);
      const before = web.requests.length;
      const { id } = (await local.call('open', { url })).value;
      const answers = await localAnswers(local, id);
      await local.call('close', { lib: id });
      await new Promise((r) => setTimeout(r, 50)); // writes are kept in the background
      blocks.close();
      return { answers, requests: web.requests.slice(before), stats: { ...blocks.stats } };
    };
    const first = await readAll();
    const second = await readAll();
    assert.deepEqual(second.answers, first.answers, 'the same answers from the cache');
    assert.ok(first.requests.length > 1 && first.stats.misses > 0);
    assert.deepEqual(second.requests.map((r) => r.range), ['bytes=0-79'], 'only the probe (the edition) went to the server');
    assert.equal(second.stats.misses, 0);
    assert.ok(second.stats.hits > 0);
  });

  it('reads a web address through the site\'s proxy while it works, and the file\'s own address otherwise', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'web-proxied.zim')).filePath;
    const { url } = web.serve(file);
    // A proxy that passes every request on to the file's server, counting them.
    let relayed = 0;
    const relay = http.createServer(async (req, res) => {
      relayed++;
      const answer = await fetch(web.base + req.url, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise((r) => relay.listen(0, '127.0.0.1', r));
    const via = url.replace(web.base, `http://127.0.0.1:${relay.address().port}`);
    const indexedDB = new IDBFactory();
    provide(browser);
    try {
      const blocks = blockCache({ indexedDB });
      const local = createLocalLibraries({ blockCache: blocks });
      const before = web.requests.length;
      const opened = (await local.call('open', { url, via })).value;
      assert.equal(opened.url, url, 'the library is the file\'s, not the proxy\'s');
      assert.equal((await local.call('catalog')).value.libraries[0].url, url);
      const answers = await localAnswers(local, opened.id);
      assert.ok(relayed > 1 && web.requests.length - before === relayed, 'every read went through the proxy');
      await local.call('close', { lib: opened.id });
      await new Promise((r) => setTimeout(r, 50));
      blocks.close();
      // Kept under the file's address: read directly next time, from the cache.
      const blocks2 = blockCache({ indexedDB });
      const direct = createLocalLibraries({ blockCache: blocks2 });
      const before2 = web.requests.length;
      const again = (await direct.call('open', { url })).value;
      assert.deepEqual(await localAnswers(direct, again.id), answers);
      assert.deepEqual(web.requests.slice(before2).map((r) => r.range), ['bytes=0-79'], 'only the probe');
      blocks2.close();
      // A proxy that is down: the file is read directly, and the worker says so.
      await new Promise((r) => relay.close(r));
      const warned = [];
      const down = createLocalLibraries({ warn: (m) => warned.push(m) });
      const third = (await down.call('open', { url, via })).value;
      assert.deepEqual(await localAnswers(down, third.id), answers);
      assert.equal(warned.filter((m) => /the proxy failed .*reading 127\.0\.0\.1 directly/.test(m)).length, 1, warned.join('\n'));
    } finally {
      relay.close();
    }
  });

  it('says why a web address cannot be read: not found, no ranges, not a ZIM', async () => {
    provide(browser);
    const local = createLocalLibraries();
    await assert.rejects(local.call('open', { url: `${web.base}/zim/gone.zim` }), /gone\.zim: HTTP 404 \(not found\)/);
    const file = writeGutenbergZim(path.join(tmp, 'whole.zim')).filePath;
    await assert.rejects(local.call('open', { url: web.serve(file, { mode: 'no-ranges' }).url }), /whole\.zim: the server does not serve parts of the file/);
    const junk = path.join(tmp, 'junk-web.zim');
    fs.writeFileSync(junk, 'not a zim file at all, really, not at all');
    await assert.rejects(local.call('open', { url: web.serve(junk).url }), /junk-web\.zim: not a readable ZIM file/);
    assert.deepEqual((await local.call('catalog')).value.libraries, []);
  });

  it('builds a remote Wikipedia\'s index only when it is small, and says why not', async () => {
    const file = writeWikipediaZim(path.join(tmp, 'web-big.zim')).filePath;
    const { url } = web.serve(file);
    const said = [];
    provide(browser);
    // A limit under the file's size: no build, and the library says why.
    const local = createLocalLibraries({ urlIndexBuildBytes: 1000, onIndexing: (id, info) => said.push(info) });
    const opened = (await local.call('open', { url })).value;
    assert.equal(opened.indexing.stage, 'failed');
    assert.match(opened.indexing.error, /no index was found for it.*download the file and open it from this device/);
    assert.deepEqual((await local.call('books', { lib: opened.id })).value, []);
    assert.equal(said.filter((i) => i?.stage === 'failed').length, 1, 'said once');
    assert.ok(!said.some((i) => i && i.stage !== 'failed'), 'no build started');
    // With the index in the store (or the site's indexes/), the limit does not matter.
    const store = memoryStore();
    const built = createLocalLibraries({ store });
    const first = (await built.call('open', { file: asFile(file) })).value;
    await indexed(async () => (await built.call('catalog')).value.libraries.find((l) => l.id === first.id).indexing);
    const again = createLocalLibraries({ store, urlIndexBuildBytes: 1000 });
    const back = (await again.call('open', { url })).value;
    assert.equal(back.indexing, null);
    assert.ok(back.books > 0);
    assert.equal((await again.call('articles', { lib: back.id, q: 'ap', limit: 3 })).value[0].title, 'apple');
  });

  it('rejects what is not a ZIM file, and keeps ids apart', async () => {
    provide(browser);
    const local = createLocalLibraries();
    await assert.rejects(local.call('open', { file: new File([Buffer.from('not a zim file at all, really')], 'junk.zim') }), /junk\.zim: not a readable ZIM file/);
    const file = writeGenericZim(path.join(tmp, 'twice.zim')).filePath;
    const a = (await local.call('open', { file: asFile(file) })).value;
    const b = (await local.call('open', { file: asFile(file) })).value;
    assert.deepEqual([a.id, b.id], ['~twice', '~twice-2']);
    assert.equal(a.kind, 'generic');
    const { value: catalog } = await local.call('catalog');
    assert.deepEqual(catalog.libraries.map((l) => l.id), ['~twice', '~twice-2']);
    await local.call('close', { lib: '~twice' });
    assert.deepEqual((await local.call('catalog')).value.libraries.map((l) => l.id), ['~twice-2']);
    await assert.rejects(local.call('books', { lib: '~twice' }), /no local library/);
    assert.deepEqual(local.parse('zim/~twice-2/C/img/x.png'), { id: '~twice-2', path: 'C/img/x.png' });
  });
});
