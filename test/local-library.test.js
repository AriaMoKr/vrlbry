// The local library (step 2): ZIM files opened in a browser, read by the shared core over a File
// with the browser's platform (fzstd, fflate, plain Uint8Arrays) in a worker (local-handler.js).
// Each archive is read twice, by the core on Node's platform from the file (as the server reads
// it) and by the local library's handler from a File on the browser's platform, and every answer
// must be the same: catalogue, books, reading metadata, chunks, images.

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { browserPlatform } from '../public/js/local/browser-platform.js';
import { idbStore } from '../public/js/local/idb-store.js';
import { createLocalLibraries } from '../public/js/local/local-handler.js';
import { png, writeGenericZim, writeGutenbergZim, writeOldGutenbergZim, writeWikipediaZim } from './helpers/zim-fixtures.js';
import { writeZim } from './helpers/zimwriter.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ZIM = path.join(REPO, 'gutenberg_en_lcc-pe_2026-03.zim');

const browser = { ...defaults, ...browserPlatform({ zstdDecompress, unzlibSync, inflateSync, Parser }) };
const utf8 = new TextDecoder();

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-local-')); });
after(() => {
  provide(nodePlatform);
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

async function sameAnswers(file, { limit, store = null } = {}) {
  const id = path.basename(file).replace(/\.zim$/i, '');
  const server = await serverAnswers(file, limit);
  const local = createLocalLibraries({ store });
  provide(browser);
  const opened = (await local.call('open', { file: asFile(file) })).value;
  assert.equal(opened.id, `~${id}`);
  const fromFile = asServer(await localAnswers(local, opened.id, limit), id);
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
    const { local, id } = await sameAnswers(file, { store });
    const opened = (await local.call('open', { file: asFile(file) })).value;
    assert.equal(opened.kind, 'wikipedia');
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
