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
import { decompress as zstdDecompress } from 'fzstd';
import { inflateSync, unzlibSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { nodePlatform } from '../server/platform-node.js';
import { ArchiveLibrary } from '../public/js/core/library.js';
import { defaults, provide } from '../public/js/core/platform.js';
import { browserPlatform } from '../public/js/local/browser-platform.js';
import { createLocalLibraries } from '../public/js/local/local-handler.js';
import { png, writeGenericZim, writeGutenbergZim, writeOldGutenbergZim } from './helpers/zim-fixtures.js';
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
async function serverAnswers(file, limit = Infinity) {
  provide(nodePlatform);
  const lib = await ArchiveLibrary.open(file, { log: () => {} });
  try {
    const out = { info: await lib.info(), books: await lib.books(), byBook: {} };
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
  const { value: catalog } = await local.call('catalog');
  const out = { info: catalog.libraries.find((l) => l.id === id), books: (await local.call('books', { lib: id })).value, byBook: {} };
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

async function sameAnswers(file, { limit } = {}) {
  const id = path.basename(file).replace(/\.zim$/i, '');
  const server = await serverAnswers(file, limit);
  const local = createLocalLibraries();
  provide(browser);
  const opened = (await local.call('open', { file: asFile(file) })).value;
  assert.equal(opened.id, `~${id}`);
  const fromFile = asServer(await localAnswers(local, opened.id, limit), id);
  assert.deepEqual(fromFile.info, server.info, 'catalogue entry');
  assert.deepEqual(fromFile.books, server.books, 'books');
  for (const book of Object.keys(server.byBook)) assert.deepEqual(fromFile.byBook[book], server.byBook[book], `book ${book}`);
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

  it('refuses Wikipedia and Wikisource ZIMs, and keeps ids apart', async () => {
    provide(browser);
    const local = createLocalLibraries();
    const wiki = writeZim(path.join(tmp, 'wikipedia_test.zim'), {
      scheme: 'new',
      entries: [
        { ns: 'C', url: 'A', title: 'A', mime: 'text/html', content: '<p>a</p>' },
        { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
      ],
    });
    await assert.rejects(local.call('open', { file: asFile(wiki.filePath) }), /Wikipedia ZIMs need the vrlbry server/);
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
