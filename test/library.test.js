import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { blockChars } from '../public/js/core/content/html.js';
import {
  ArchiveLibrary, Library, LibraryError, gutenbergBase, libraryIdFor, libraryTitle, parseIndexScript, splitTitle, zimUrl,
} from '../server/library.js';
import {
  LONG_TITLE, png, writeGenericZim, writeGutenbergZim, writeOldGutenbergZim, writePapersGutenbergZim,
} from './helpers/zim-fixtures.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const REAL_ZIM = path.join(REPO, 'gutenberg_en_lcc-pe_2026-03.zim');
const REAL_ID = 'gutenberg_en_lcc-pe_2026-03';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-lib-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const quietLog = () => {};
function collectLog() {
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.lines = lines;
  return log;
}

// ---------------------------------------------------------------------------------------------

describe('library helpers', () => {
  it('names the Gutenberg ZIMs of one LCC class by their class', () => {
    const lcc = { kind: 'gutenberg', title: 'Project Gutenberg Library', description: 'Slavic, Baltic and Albanian languages', name: 'gutenberg_en_lcc-pg' };
    assert.equal(libraryTitle(lcc), 'Gutenberg · Slavic, Baltic and Albanian languages (PG)');
    assert.equal(libraryTitle({ ...lcc, description: null }), 'Project Gutenberg Library', 'no class name: the ZIM’s title');
    assert.equal(libraryTitle({ ...lcc, name: 'gutenberg_en_all' }), 'Gutenberg · every book (EN)', 'a whole collection, by its language');
    assert.equal(libraryTitle({ ...lcc, name: 'gutenberg_mul_all' }), 'Gutenberg · every book in every language');
    assert.equal(libraryTitle({ ...lcc, name: 'gutenberg_en_other' }), 'Project Gutenberg Library', 'neither: the ZIM’s title');
    assert.equal(libraryTitle({ ...lcc, kind: 'generic' }), 'Project Gutenberg Library');
    // Wikipedia editions of one topic share a title: the mini and nopic ones say what they are.
    const wp = { kind: 'wikipedia', title: 'Climate change by Wikipedia', description: 'x', name: 'wikipedia_en_climate-change' };
    assert.equal(libraryTitle({ ...wp, flavour: 'mini' }), 'Climate change by Wikipedia (introductions)');
    assert.equal(libraryTitle({ ...wp, flavour: 'nopic' }), 'Climate change by Wikipedia (no pictures)');
    assert.equal(libraryTitle({ ...wp, flavour: 'maxi' }), 'Climate change by Wikipedia');
    assert.equal(libraryTitle({ ...wp, flavour: null }), 'Climate change by Wikipedia');
  });

  it('libraryIdFor makes URL-safe ids and keeps case', () => {
    assert.equal(libraryIdFor('gutenberg_en_lcc-pe_2026-03.zim'), 'gutenberg_en_lcc-pe_2026-03');
    assert.equal(libraryIdFor('/some/dir/My Library (2024).ZIM'), 'My-Library--2024-');
    assert.equal(libraryIdFor('wikipédia_fr.zim'), 'wikip-dia_fr');
    assert.equal(libraryIdFor('a.b.zim'), 'a.b');
    assert.notEqual(libraryIdFor('...zim'), '..');
    assert.notEqual(libraryIdFor('.zim'), '');
  });

  it('splitTitle splits MARC $b subtitles', () => {
    assert.deepEqual(splitTitle('The slang dictionary : $b Etymological, historical and anecdotal'), {
      title: 'The slang dictionary',
      subtitle: 'Etymological, historical and anecdotal',
      fullTitle: 'The slang dictionary: Etymological, historical and anecdotal',
    });
    assert.deepEqual(splitTitle('The Elements of Style'), {
      title: 'The Elements of Style', subtitle: null, fullTitle: 'The Elements of Style',
    });
    assert.equal(splitTitle('Stories That  Words Tell Us').title, 'Stories That Words Tell Us');
    const o = splitTitle('Orthography : $b as outlined in the state course : seventh and eighth years');
    assert.equal(o.title, 'Orthography');
    assert.equal(o.subtitle, 'as outlined in the state course : seventh and eighth years');
    assert.deepEqual(splitTitle('Title / $c Someone'), { title: 'Title', subtitle: null, fullTitle: 'Title' });
    assert.equal(splitTitle('Main : $b sub / $c by X').fullTitle, 'Main: sub');
    assert.equal(splitTitle('$b only a subtitle').title, 'only a subtitle');
  });

  it('gutenbergBase mirrors the JS of the ZIM (first "/" only, UTF-16 substring)', () => {
    assert.equal(gutenbergBase('The Elements of Style', 37134), 'The Elements of Style.37134');
    assert.equal(gutenbergBase('a/b/c', 1), 'a-b/c.1');
    assert.equal(gutenbergBase('x'.repeat(300), 2), 'x'.repeat(230) + '.2');
    // An astral character straddling the cut is split exactly like JS substring does.
    const t = 'y'.repeat(229) + '\u{1D518}z';
    assert.equal(gutenbergBase(t, 3), 'y'.repeat(229) + '\uD835' + '.3');
  });

  it('parseIndexScript tolerates wrappers, BOM, semicolons and whitespace', () => {
    assert.deepEqual(parseIndexScript('var json_data = [[1, "a]"]];;\n  \n'), [[1, 'a]']]);
    assert.deepEqual(parseIndexScript(Buffer.from('﻿var x=["PE"]')), ['PE']);
    assert.throws(() => parseIndexScript('var x = 1;'));
    assert.throws(() => parseIndexScript('var x = [1, 2'));
  });

  it('zimUrl percent-encodes each segment', () => {
    assert.equal(zimUrl('lib', 'M/Illustration_48x48@1'), '/zim/lib/M/Illustration_48x48%401');
    assert.equal(zimUrl('lib', "C/covers/x y'é#?.jpg"), "/zim/lib/C/covers/x%20y'%C3%A9%23%3F.jpg");
  });
});

describe('ArchiveLibrary: synthetic Gutenberg archive', () => {
  let lib;
  let file;
  before(async () => {
    file = path.join(tmp, 'synthetic-gutenberg.zim');
    writeGutenbergZim(file);
    lib = await ArchiveLibrary.open(file, { log: quietLog });
  });
  after(async () => {
    await lib?.close();
  });

  it('is a gutenberg library with the documented info()', async () => {
    assert.equal(lib.kind, 'gutenberg');
    assert.equal(lib.id, 'synthetic-gutenberg');
    assert.equal(lib.file, 'synthetic-gutenberg.zim');
    assert.deepEqual(await lib.info(), {
      id: 'synthetic-gutenberg',
      file: 'synthetic-gutenberg.zim',
      kind: 'gutenberg',
      title: 'Synthetic Gutenberg',
      zimTitle: 'Synthetic Gutenberg',
      description: 'Test library',
      longDescription: null,
      language: 'eng',
      date: '2026-01-02',
      creator: 'gutenberg.org',
      publisher: 'openZIM',
      name: 'synthetic_gutenberg',
      flavour: null,
      bookCount: 8,
      illustration: '/zim/synthetic-gutenberg/M/Illustration_48x48%401',
      shelves: ['PE', 'PR'],
    });
  });

  it('lists books in index order, de-duplicated, with ranks and string ids', async () => {
    const books = await lib.books();
    assert.deepEqual(books.map((b) => b.id), ['101', '102', '103', '104', '105', '106', '107', '108']);
    assert.deepEqual(books.map((b) => b.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const b of books) {
      assert.deepEqual(Object.keys(b), ['id', 'title', 'subtitle', 'fullTitle', 'author', 'authorId', 'rank',
        'shelf', 'language', 'formats', 'readable', 'cover', 'epub', 'size']);
      assert.equal(typeof b.id, 'string');
    }
  });

  it('resolves entries with JS semantics, falling back to the scraper\'s form', async () => {
    const b101 = await lib.book('101');
    assert.equal(b101.title, 'Alpha/Beta/Gamma');
    assert.deepEqual(b101.formats, { html: true, epub: true, pdf: false });
    assert.equal(b101.epub, '/zim/synthetic-gutenberg/C/Alpha-Beta/Gamma.101.epub');
    assert.equal(b101.cover, '/zim/synthetic-gutenberg/C/covers/101_cover_image.jpg');
    assert.equal(b101.authorId, '7');
    assert.equal(b101.language, 'en');
    assert.equal(b101.shelf, 'PE');
    assert.equal(b101.size, (await lib.archive.getContent('C/Alpha-Beta/Gamma.101.epub')).data.length, 'EPUB size');
    const b102 = await lib.book('102');
    assert.equal(b102.readable, true);
    assert.equal(b102.formats.html, true);
    assert.equal(b102.cover, null);
    assert.equal(b102.epub, null);
    assert.equal(b102.size, null, 'HTML in a compressed cluster: size unknown without decompressing');
    const b104 = await lib.book(104);
    assert.equal(b104.readable, true, 'title cut at 230 UTF-16 units');
    assert.equal(b104.title, LONG_TITLE);
  });

  it('splits MARC subtitles, normalizes authors and keeps unknown fields null', async () => {
    const b = await lib.book('103');
    assert.equal(b.title, 'The slang dictionary');
    assert.equal(b.subtitle, 'Etymological, historical');
    assert.equal(b.fullTitle, 'The slang dictionary: Etymological, historical');
    assert.equal(b.author, 'Bob Writer');
    assert.equal(b.authorId, '8');
    assert.equal(b.shelf, 'PR');
    assert.match(b.epub, /The%20slang%20dictionary%20%3A%20%24b%20Etymological%2C%20historical\.103\.epub$/);
    const orphan = await lib.book('108');
    assert.equal(orphan.authorId, null);
    assert.equal(orphan.shelf, null);
    const ghost = await lib.book('107');
    assert.equal(ghost.readable, false);
    assert.deepEqual(ghost.formats, { html: false, epub: false, pdf: false });
    assert.equal(ghost.size, null);
  });

  it('converts HTML books: image sizes, src rewriting, missing images, chunks and TOC', async () => {
    const { meta, chunks } = await lib.content('106');
    assert.equal(meta.source, 'html');
    assert.equal(meta.library, 'synthetic-gutenberg');
    assert.equal(meta.id, '106');
    assert.equal(meta.title, 'Images Book');
    assert.equal(meta.author, 'Ann Author');
    assert.equal(meta.cover, null);
    assert.equal(meta.tocTruncated, false);
    assert.deepEqual(meta.chunks, chunks.map((c) => ({ start: c.start, chars: c.chars, blocks: c.blockCount })));
    const blocks = chunks.flatMap((c) => c.blocks);
    assert.equal(meta.totalChars, blocks.reduce((n, b) => n + blockChars(b), 0));
    const imgs = blocks.filter((b) => b.t === 'img');
    assert.deepEqual(imgs.find((b) => b.alt === 'Logo'), {
      t: 'img', src: '/zim/synthetic-gutenberg/C/106_logo.png', w: 120, h: 60, alt: 'Logo',
    });
    // img/pic.png is not in the archive; gutenberg2zim stored it as 106_pic.png.
    const pic = imgs.find((b) => b.alt === 'Pic');
    assert.equal(pic.src, '/zim/synthetic-gutenberg/C/106_pic.png');
    assert.equal(pic.w, 50);
    assert.equal(pic.h, 25, 'height completed from the aspect ratio');
    const data = imgs.find((b) => b.src.startsWith('data:'));
    assert.deepEqual([data.w, data.h], [7, 9]);
    assert.equal(imgs.length, 3);
    const texts = blocks.filter((b) => b.t === 'p').map((b) => b.r);
    assert.ok(texts.some((r) => r.length === 1 && r[0][0] === 'Missing figure' && r[0][1] === 1), 'alt text replaces a missing image');
    assert.ok(texts.some((r) => r[0][0] === 'Not an image'), 'a non-image target counts as missing');
    assert.deepEqual(meta.toc.map((t) => t.title), ['Images Book', 'Chapter 1', 'Chapter 2']);
    for (const t of meta.toc) {
      const b = chunks[t.c].blocks[t.b];
      assert.equal(b.t, 'h');
      assert.equal(b.l, t.level);
    }
  });

  it('reads EPUB-only books through the EPUB, with /res/ image URLs', async () => {
    const book = await lib.book('105');
    assert.deepEqual(book.formats, { html: false, epub: true, pdf: false });
    assert.equal(book.readable, true);
    const { meta, chunks } = await lib.content('105');
    assert.equal(meta.source, 'epub');
    assert.equal(meta.cover, '/zim/synthetic-gutenberg/C/covers/105_cover_image.jpg');
    const blocks = chunks.flatMap((c) => c.blocks);
    assert.deepEqual(blocks.filter((b) => b.t === 'h').map((b) => b.r[0][0]), ['Chapter One', 'Chapter Two']);
    const img = blocks.find((b) => b.t === 'img');
    assert.deepEqual(img, {
      t: 'img', src: '/api/libraries/synthetic-gutenberg/books/105/res/OEBPS/images/fig%201.png', w: 300, h: 150, alt: 'Figure',
    });
    assert.ok(blocks.some((b) => b.t === 'p' && b.r[0][0] === 'Lost figure'));
    const res = await lib.resource('105', 'OEBPS/images/fig 1.png');
    assert.equal(res.mime, 'image/png');
    assert.deepEqual(res.data, png(300, 150));
    assert.equal(await lib.resource('105', 'OEBPS/nothing.png'), null);
    assert.equal(await lib.resource('102', 'OEBPS/images/fig 1.png'), null, 'book without EPUB');
    assert.equal(await lib.resource('999', 'x'), null);
  });

  it('returns undefined for unknown books and a 404 LibraryError for unreadable ones', async () => {
    assert.equal(await lib.content('999'), undefined);
    assert.equal(await lib.book('999'), undefined);
    await assert.rejects(lib.content('107'), (err) => err instanceof LibraryError && err.status === 404);
  });

  it('shares one conversion between concurrent calls and caches the result', async () => {
    const before = lib.conversions;
    const [a, b] = await Promise.all([lib.content('101'), lib.content('101')]);
    assert.equal(a, b);
    assert.equal(lib.conversions, before + 1);
    assert.equal(await lib.content('101'), a);
    assert.equal(lib.conversions, before + 1);
  });

  it('evicts converted books beyond the byte budget', async () => {
    const small = await ArchiveLibrary.open(file, { log: quietLog, contentCacheBytes: 100 });
    try {
      await small.content('106');
      await small.content('106');
      assert.equal(small.conversions, 2, 'nothing fits in 100 bytes');
    } finally {
      await small.close();
    }
  });

  it('serves gzip of a chunk and keeps the JSON as the source of truth', async () => {
    const { chunks } = await lib.content('106');
    const gz = await chunks[0].gzip();
    assert.deepEqual(zlib.gunzipSync(gz), chunks[0].json);
    assert.equal(await chunks[0].gzip(), gz, 'computed once');
    assert.deepEqual(JSON.parse(chunks[0].json), { index: 0, blocks: chunks[0].blocks });
  });
});

describe('ArchiveLibrary: a Gutenberg list longer than bookLookups (as from the web)', () => {
  let eager;
  let lazy;
  let found;
  /** Opens the file with bookLookups 0, counting the archive's lookups. */
  const openLazy = async (file, id) => {
    const archive = await ZimArchive.open(file);
    const counted = [];
    const find = archive.findEntry.bind(archive);
    archive.findEntry = (ns, url) => { counted.push(`${ns}/${url}`); return find(ns, url); };
    const lib = await ArchiveLibrary.open(archive, { log: quietLog, bookLookups: 0, id });
    return { lib, counted };
  };
  before(async () => {
    const file = path.join(tmp, 'lazy-gutenberg.zim');
    writeGutenbergZim(file);
    eager = await ArchiveLibrary.open(file, { log: quietLog, id: 'lazy-gutenberg' });
    ({ lib: lazy, counted: found } = await openLazy(file, 'lazy-gutenberg'));
  });
  after(async () => {
    await eager?.close();
    await lazy?.close();
  });

  it('makes its books from the list alone: no book is looked up as it opens', async () => {
    const [a, b] = [await eager.books(), await lazy.books()];
    const listed = (x) => ({ id: x.id, title: x.title, subtitle: x.subtitle, fullTitle: x.fullTitle, author: x.author, authorId: x.authorId,
      rank: x.rank, shelf: x.shelf, language: x.language });
    assert.deepEqual(b.map(listed), a.map(listed));
    assert.deepEqual(Object.keys(b[0]), Object.keys(a[0]), 'the same fields');
    assert.deepEqual(found.filter((p) => /covers\/|\.\d{3}(\.html|\.epub)?$/.test(p)), [], `no book's files looked up: ${found.join(', ')}`);
    // What the list says, not what is there.
    const by = Object.fromEntries(b.map((x) => [x.id, x]));
    assert.deepEqual(by['105'].formats, { html: false, epub: true, pdf: false });
    assert.equal(by['107'].readable, true, 'the Ghost Book\'s list says it has HTML and an EPUB');
    assert.equal(by['101'].cover, '/zim/lazy-gutenberg/C/covers/101_cover_image.jpg');
    assert.equal(by['102'].cover, '/zim/lazy-gutenberg/C/covers/102_cover_image.jpg', 'its usual name, though it has none');
    assert.equal(by['101'].epub, null, 'until it is opened');
    assert.ok(b.every((x) => x.size === null), 'sizes unknown (a thickness from the id)');
    assert.deepEqual((await lazy.info()).shelves, (await eager.info()).shelves);
  });

  it('looks a book\'s files up when it is first opened, and reads it as when all were looked up', async () => {
    for (const id of ['101', '102', '103', '104', '105', '106', '108']) {
      const [x, y] = [await eager.content(id), await lazy.content(id)];
      assert.deepEqual(y.meta, { ...x.meta, cover: y.meta.cover }, id);
      assert.deepEqual(y.chunks.map((c) => c.json.toString()), x.chunks.map((c) => c.json.toString()), id);
    }
    const [a, b] = [await eager.book('101'), await lazy.book('101')];
    assert.equal(b.epub, a.epub, 'its EPUB found');
    assert.deepEqual(b.formats, a.formats);
    // A file the list promised but the archive lacks: unreadable once looked up, as before.
    await assert.rejects(lazy.content('107'), (err) => err instanceof LibraryError && err.status === 404);
    assert.equal((await lazy.book('107')).readable, false);
  });

  it('looks up once however many ask at once, and serves an EPUB\'s files before its text', async () => {
    const file = path.join(tmp, 'lazy-gutenberg-2.zim');
    writeGutenbergZim(file);
    const { lib, counted } = await openLazy(file, 'lazy-2');
    try {
      const before = counted.length;
      await Promise.all([lib.content('103'), lib.content('103'), lib.resource('103', 'OEBPS/content.opf')]);
      assert.equal(counted.filter((p, i) => i >= before && /\.103/.test(p)).length, 2, 'its HTML and its EPUB, once each');
      const epub = await eager.resource('105', 'OEBPS/content.opf');
      assert.deepEqual(await lib.resource('105', 'OEBPS/content.opf'), epub, 'an EPUB-only book\'s files, never opened');
    } finally {
      await lib.close();
    }
  });

  it('names an old-scheme archive\'s covers as gutenberg2zim 2.x did', async () => {
    const file = path.join(tmp, 'lazy-old.zim');
    writeOldGutenbergZim(file);
    const { lib } = await openLazy(file, 'lazy-old');
    try {
      const [old] = await lib.books();
      assert.equal(old.cover, '/zim/lazy-old/I/covers/201_cover.jpg');
      assert.ok(await lib.archive.findPath('I/covers/201_cover.jpg'), 'there');
      assert.equal((await lib.content('201')).meta.source, 'html');
      assert.equal((await lib.book('201')).epub, '/zim/lazy-old/-/Old%20Book.201.epub');
    } finally {
      await lib.close();
    }
  });
});

describe('ArchiveLibrary: old namespace scheme', () => {
  let lib;
  before(async () => {
    const file = path.join(tmp, 'old-scheme.zim');
    writeOldGutenbergZim(file);
    lib = await ArchiveLibrary.open(file, { log: quietLog });
  });
  after(async () => {
    await lib?.close();
  });

  it('finds the index under -/js/, HTML in A (.html suffix), covers and EPUBs', async () => {
    assert.equal(lib.archive.newNamespaceScheme, false);
    assert.equal(lib.kind, 'gutenberg');
    const [old, de] = await lib.books();
    assert.equal(old.id, '201');
    assert.deepEqual(old.formats, { html: true, epub: true, pdf: false });
    assert.equal(old.cover, '/zim/old-scheme/I/covers/201_cover.jpg');
    assert.equal(old.epub, '/zim/old-scheme/-/Old%20Book.201.epub');
    assert.equal(old.language, 'en');
    assert.equal(de.language, 'de', 'per-book language from lang_<code> lists');
    assert.equal(de.readable, true);
    assert.deepEqual((await lib.info()).shelves, ['PE', 'PT'], 'shelves derived from books without lcc_shelves.js');
  });

  it('converts old-scheme HTML and resolves ../I/ images', async () => {
    const { meta, chunks } = await lib.content('201');
    assert.equal(meta.source, 'html');
    const img = chunks[0].blocks.find((b) => b.t === 'img');
    assert.deepEqual(img, { t: 'img', src: '/zim/old-scheme/I/201_fig.png', w: 10, h: 20, alt: 'Fig' });
  });
});

describe('ArchiveLibrary: Kiwix\'s newer Gutenberg files (papers2zim, §2.2)', () => {
  const ID = 'gutenberg_af_all_2026-11';
  let lib;
  let file;
  /** Opens the file with bookLookups 0 (as a long list from the web), counting the archive's lookups. */
  const openLazy = async (id) => {
    const archive = await ZimArchive.open(file);
    const counted = [];
    const find = archive.findEntry.bind(archive);
    archive.findEntry = (ns, url) => { counted.push(`${ns}/${url}`); return find(ns, url); };
    return { lib: await ArchiveLibrary.open(archive, { log: quietLog, bookLookups: 0, id }), counted };
  };
  before(async () => {
    file = path.join(tmp, `${ID}.zim`);
    writePapersGutenbergZim(file);
    lib = await ArchiveLibrary.open(file, { log: quietLog });
  });
  after(async () => {
    await lib?.close();
  });

  it('is a Gutenberg library of the books its lists give, and of nothing else in the file', async () => {
    assert.equal(lib.kind, 'gutenberg');
    const info = await lib.info();
    assert.equal(info.title, 'Gutenberg · every book (AF)');
    assert.equal(info.bookCount, 5);
    assert.deepEqual(info.shelves, ['CDEF', 'G', 'P']);
    const books = await lib.books();
    // Each by its Gutenberg number (from its cover's name), in popularity order over both pages of
    // the list; the second 301 left out; a book without a cover keeps its slug.
    assert.deepEqual(books.map((b) => b.id), ['301', '302', '303', '305', 'coverless']);
    assert.deepEqual(books.map((b) => b.rank), [1, 2, 3, 4, 5]);
    assert.deepEqual(books.map((b) => b.author), ['Ann Author', 'Bob Writer', 'Ann Author', 'Cy Penman', null]);
    assert.deepEqual(books.map((b) => b.authorId), ['ann-author', 'bob-writer', 'ann-author', 'cy-penman', null]);
    assert.deepEqual(books.map((b) => b.language), ['af', 'af', 'af', 'af', null]);
    assert.deepEqual(books.map((b) => b.shelf), ['P', 'CDEF', 'G', null, 'P']);
    for (const b of books) {
      assert.deepEqual(Object.keys(b), ['id', 'title', 'subtitle', 'fullTitle', 'author', 'authorId', 'rank',
        'shelf', 'language', 'formats', 'readable', 'cover', 'epub', 'size']);
    }
    assert.ok(books.every((b) => b.readable));
  });

  it('gives each book its title, cover and files, by its title and number or by its own JSON', async () => {
    const trek = await lib.book('301');
    assert.deepEqual([trek.title, trek.subtitle, trek.fullTitle], ['Trek Tale', null, 'Trek Tale']);
    assert.deepEqual(trek.formats, { html: true, epub: true, pdf: false });
    assert.equal(trek.cover, `/zim/${ID}/C/covers/301_cover_image.webp`);
    assert.equal(trek.epub, `/zim/${ID}/C/Trek%20Tale.301.epub`);
    assert.equal(trek.size, (await lib.archive.getContent('C/Trek Tale.301.epub')).data.length, 'its EPUB\'s size');
    // The spaced colon papers2zim leaves where MARC's $b was: split as in gutenberg2zim's files.
    const delwerye = await lib.book('302');
    assert.deepEqual([delwerye.title, delwerye.subtitle, delwerye.fullTitle], ['Op die delwerye', 'Vyf sketse', 'Op die delwerye: Vyf sketse']);
    assert.deepEqual(delwerye.formats, { html: true, epub: false, pdf: false });
    const epubOnly = await lib.book('303');
    assert.deepEqual(epubOnly.formats, { html: false, epub: true, pdf: false });
    assert.equal(epubOnly.cover, null, 'a cover its list names but the file lacks');
    const renamed = await lib.book('305');
    assert.deepEqual(renamed.formats, { html: true, epub: false, pdf: false }, 'found by its own JSON');
    assert.equal(renamed.cover, `/zim/${ID}/C/covers/305_cover_image.webp`);
    assert.equal((await lib.book('coverless')).cover, null);
  });

  it('reads a book from its title page on, without papers2zim\'s controls, with its WebP pictures', async () => {
    const { meta, chunks } = await lib.content('301');
    assert.equal(meta.source, 'html');
    assert.equal(meta.cover, `/zim/${ID}/C/covers/301_cover_image.webp`);
    const blocks = chunks.flatMap((c) => c.blocks);
    assert.deepEqual(blocks[0], { t: 'h', l: 1, r: [['Ann Author', 0]] }, 'the title page first');
    const all = JSON.stringify(blocks);
    assert.doesNotMatch(all, /icons\/|Scroll to top|View book cover|Download EPUB/, 'no controls');
    assert.deepEqual(blocks.filter((b) => b.t === 'img'), [
      { t: 'img', src: `/zim/${ID}/C/301/images/front.jpg.webp`, w: 249, h: 400, alt: 'Front', id: 'img_images_front.jpg' },
      { t: 'img', src: `/zim/${ID}/C/301/images/unsized.png.webp`, w: 120, h: 80, alt: 'Unsized' },
    ], 'one sized by its page, one by its WebP header');
    const link = blocks.flatMap((b) => b.r ?? []).find((r) => r[0] === 'the start');
    const one = blocks.findIndex((b) => b.id === 'one');
    assert.deepEqual(link[2], { at: [0, one] }, 'a link within the book');
    assert.deepEqual(meta.toc.map((t) => t.title), ['Ann Author', 'Trek Tale', 'One']);
  });

  it('reads the book found by its own JSON and the EPUB-only one, and places a book\'s page', async () => {
    const renamed = (await lib.content('305')).chunks.flatMap((c) => c.blocks);
    assert.deepEqual(renamed.map((b) => b.r?.[0][0]), ['Renamed Book', 'Found by its own JSON.']);
    assert.equal((await lib.content('303')).meta.source, 'epub');
    assert.equal((await lib.content('coverless')).chunks[0].blocks[0].r[0][0], 'Coverless');
    assert.deepEqual(await lib.placeOf('C/Trek Tale.301#one'), { book: '301', c: 0, b: 0, f: 'one' });
    assert.equal(await lib.placeOf('C/noscript/book_trek-tale.html'), null, 'the scraper\'s own pages lead to no book');
    assert.equal(await lib.placeOf('C/index/book_301'), null);
  });

  it('makes a long list\'s books from the list alone, and finds a book\'s files when it is first opened', async () => {
    const { lib: lazy, counted } = await openLazy('lazy-papers');
    try {
      const [a, b] = [await lib.books(), await lazy.books()];
      const listed = (x) => ({ id: x.id, title: x.title, subtitle: x.subtitle, author: x.author, authorId: x.authorId, rank: x.rank, shelf: x.shelf, language: x.language });
      assert.deepEqual(b.map(listed), a.map(listed));
      assert.deepEqual(counted.filter((p) => /\.30\d|covers\//.test(p)), [], `no book's files looked up: ${counted.join(', ')}`);
      assert.deepEqual(counted.filter((p) => /full_by_popularity/.test(p)), [], 'no gutenberg2zim index looked for: papers2zim made it');
      const by = Object.fromEntries(b.map((x) => [x.id, x]));
      assert.equal(by['303'].cover, '/zim/lazy-papers/C/covers/303_cover_image.webp', 'its cover as its list names it');
      assert.deepEqual(by['303'].formats, { html: false, epub: true, pdf: false }, 'its formats as its list names them');
      assert.equal(by['301'].epub, null, 'until it is opened');
      assert.ok(b.every((x) => x.size === null));
      for (const id of ['301', '302', '303', '305', 'coverless']) {
        const [x, y] = [await lib.content(id), await lazy.content(id)];
        assert.deepEqual(y.meta, { ...x.meta, library: y.meta.library, cover: y.meta.cover }, id);
        assert.deepEqual(y.chunks.map((c) => c.json.toString().split('lazy-papers').join(ID)), x.chunks.map((c) => c.json.toString()), id);
      }
      assert.equal(by['301'].epub, `/zim/lazy-papers/C/Trek%20Tale.301.epub`, 'its EPUB found');
      assert.deepEqual(by['305'].formats, { html: true, epub: false, pdf: false });
    } finally {
      await lazy.close();
    }
  });

  it('stays generic when its config.json names another source', async () => {
    const other = path.join(tmp, 'papers-other.zim');
    writePapersGutenbergZim(other, { source: 'arxiv' });
    const generic = await ArchiveLibrary.open(other, { log: quietLog });
    try {
      assert.equal(generic.kind, 'generic');
      const titles = (await generic.books()).map((b) => b.title);
      assert.ok(titles.includes('index.html') && titles.includes('Trek Tale'), titles.join(', '));
    } finally {
      await generic.close();
    }
  });

  it('knows the file by its config.json alone, whatever made it', async () => {
    const unsigned = path.join(tmp, 'papers-unsigned.zim');
    writePapersGutenbergZim(unsigned, { scraper: null });
    const again = await ArchiveLibrary.open(unsigned, { log: quietLog });
    try {
      assert.equal(again.kind, 'gutenberg');
      assert.deepEqual((await again.books()).map((b) => b.id), (await lib.books()).map((b) => b.id));
    } finally {
      await again.close();
    }
  });
});

describe('ArchiveLibrary: generic archive (§2.3)', () => {
  it('lists HTML articles (no redirects) in URL order with e<index> ids', async () => {
    const file = path.join(tmp, 'generic.zim');
    const written = writeGenericZim(file);
    const lib = await ArchiveLibrary.open(file, { log: quietLog });
    try {
      assert.equal(lib.kind, 'generic');
      const books = await lib.books();
      assert.deepEqual(books.map((b) => b.title), ['Article A', 'Article B', 'Main Page']);
      assert.deepEqual(books.map((b) => b.id), ['C/a.html', 'C/b.html', 'C/index.html'].map((p) => `e${written.indexOf(p)}`));
      assert.deepEqual(books.map((b) => b.rank), [1, 2, 3]);
      const a = books[0];
      assert.equal(a.author, 'Wiki Folk');
      assert.equal(a.shelf, null);
      assert.equal(a.cover, null);
      assert.equal(a.epub, null);
      assert.equal(a.language, 'fra');
      assert.deepEqual(a.formats, { html: true, epub: false, pdf: false });
      assert.equal(a.size, null, 'compressed cluster, not decompressed for the catalog');
      const info = await lib.info();
      assert.equal(info.kind, 'generic');
      assert.equal(info.title, 'generic', 'falls back to the file name');
      assert.equal(info.illustration, null);
      assert.deepEqual(info.shelves, []);
      const { meta, chunks } = await lib.content(a.id);
      assert.equal(meta.source, 'html');
      const img = chunks[0].blocks.find((b) => b.t === 'img');
      assert.deepEqual(img, { t: 'img', src: '/zim/generic/C/img/x.png', w: 64, h: 32, alt: 'x' });
    } finally {
      await lib.close();
    }
  });

  it('caps the list at maxGenericBooks and logs it', async () => {
    const file = path.join(tmp, 'generic-capped.zim');
    writeGenericZim(file, { creator: null });
    const log = collectLog();
    const lib = await ArchiveLibrary.open(file, { log, maxGenericBooks: 2 });
    try {
      const books = await lib.books();
      assert.equal(books.length, 2);
      assert.equal(books[0].author, null);
      assert.ok(log.lines.some((l) => /more than 2 HTML articles/.test(l)), log.lines.join('\n'));
    } finally {
      await lib.close();
    }
  });
});

describe('Library.scan', () => {
  it('opens *.zim files, skips broken ones, reports split archives, de-duplicates ids', async () => {
    const dir = path.join(tmp, 'scan');
    fs.mkdirSync(dir);
    writeGutenbergZim(path.join(dir, 'lib one.zim'));
    writeGenericZim(path.join(dir, 'lib-one.zim'));
    writeGenericZim(path.join(dir, 'UPPER.ZIM'));
    fs.writeFileSync(path.join(dir, 'broken.zim'), Buffer.alloc(200, 7));
    fs.writeFileSync(path.join(dir, 'parts.zimaa'), 'x');
    fs.writeFileSync(path.join(dir, 'parts.zimab'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'sub.zim'));
    const log = collectLog();
    const warn = collectLog();
    const library = await Library.scan(dir, { log, warn });
    try {
      assert.equal(library.dir, path.resolve(dir));
      assert.deepEqual(library.list().map((l) => [l.file, l.id, l.kind]), [
        ['UPPER.ZIM', 'UPPER', 'generic'],
        ['lib one.zim', 'lib-one', 'gutenberg'],
        ['lib-one.zim', 'lib-one-2', 'generic'],
      ]);
      assert.equal(library.get('lib-one-2').file, 'lib-one.zim');
      assert.equal(library.get('nope'), undefined);
      // Problems go to `warn`, progress to `log`.
      assert.ok(warn.lines.some((l) => /broken\.zim: skipped/.test(l)), warn.lines.join('\n'));
      assert.equal(warn.lines.filter((l) => /parts\.zimaa.*not supported/.test(l)).length, 1);
      assert.ok(warn.lines.some((l) => /lib one\.zim: 1 book\(s\) have neither HTML nor EPUB/.test(l)), warn.lines.join('\n'));
      assert.ok(log.lines.some((l) => /lib one\.zim: gutenberg library, 8 book\(s\)/.test(l)), log.lines.join('\n'));
      assert.ok(!log.lines.some((l) => /skipped|not supported|neither/.test(l)), log.lines.join('\n'));
      assert.ok(![...log.lines, ...warn.lines].some((l) => /notes\.txt/.test(l)));
    } finally {
      await library.close();
    }
  });

  it('sends warnings to `log` when no `warn` is given', async () => {
    const dir = path.join(tmp, 'scan-log-only');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'broken.zim'), Buffer.alloc(200, 7));
    const log = collectLog();
    const library = await Library.scan(dir, { log });
    try {
      assert.equal(library.list().length, 0);
      assert.ok(log.lines.some((l) => /broken\.zim: skipped/.test(l)), log.lines.join('\n'));
    } finally {
      await library.close();
    }
  });

  it('shares one content cache between the archives of a library', async () => {
    const dir = path.join(tmp, 'scan2');
    fs.mkdirSync(dir);
    writeGutenbergZim(path.join(dir, 'g.zim'));
    const library = await Library.scan(dir, { log: quietLog });
    try {
      await library.get('g').content('106');
      assert.equal(library.contentCache.size, 1);
      assert.ok(library.contentCache.bytes > 0);
    } finally {
      await library.close();
    }
    assert.equal(library.contentCache.size, 0);
  });
});

describe('ArchiveLibrary: real Gutenberg ZIM', { skip: !fs.existsSync(REAL_ZIM) && 'real ZIM not present' }, () => {
  let lib;
  let openMs;
  before(async () => {
    const t0 = performance.now();
    lib = await ArchiveLibrary.open(REAL_ZIM, { log: quietLog });
    openMs = performance.now() - t0;
  });
  after(async () => {
    await lib?.close();
  });

  it('catalogs all 258 books quickly', async () => {
    assert.ok(openMs < 1000, `open + catalog took ${openMs.toFixed(0)} ms`);
    assert.equal(lib.id, REAL_ID);
    assert.equal(lib.kind, 'gutenberg');
    const books = await lib.books();
    assert.equal(books.length, 258);
    assert.deepEqual(books.map((b) => b.rank), books.map((_, i) => i + 1));
    assert.equal(new Set(books.map((b) => b.id)).size, 258);
    assert.equal(books[0].id, '37683');
    assert.equal(books[0].title, "Chambers's Twentieth Century Dictionary (part 1 of 4: A-D)");
    assert.equal(books.filter((b) => b.formats.html).length, 256);
    assert.equal(books.filter((b) => b.formats.epub).length, 258);
    assert.ok(books.every((b) => b.readable && b.cover && b.epub && b.language === 'en' && b.shelf === 'PE'));
    assert.ok(books.every((b) => b.authorId !== null && b.size > 0));
  });

  it('describes the library from its metadata', async () => {
    assert.deepEqual(await lib.info(), {
      id: REAL_ID,
      file: `${REAL_ID}.zim`,
      kind: 'gutenberg',
      title: 'Gutenberg · English language (PE)', // every LCC ZIM's own title is "Project Gutenberg Library"
      zimTitle: 'Project Gutenberg Library',
      description: 'English language',
      longDescription: 'English language studies, grammar, etymology, dialects, linguistics, philology, and the history of the English language.',
      language: 'eng',
      date: '2026-03-05',
      creator: 'gutenberg.org',
      publisher: 'openZIM',
      name: 'gutenberg_en_lcc-pe',
      flavour: null,
      bookCount: 258,
      illustration: `/zim/${REAL_ID}/M/Illustration_48x48%401`,
      shelves: ['PE'],
    });
  });

  it('knows The Elements of Style (37134)', async () => {
    const b = await lib.book('37134');
    assert.deepEqual(b, {
      id: '37134',
      title: 'The Elements of Style',
      subtitle: null,
      fullTitle: 'The Elements of Style',
      author: 'William Strunk',
      authorId: b.authorId,
      rank: 3,
      shelf: 'PE',
      language: 'en',
      formats: { html: true, epub: true, pdf: false },
      readable: true,
      cover: `/zim/${REAL_ID}/C/covers/37134_cover_image.jpg`,
      epub: `/zim/${REAL_ID}/C/The%20Elements%20of%20Style.37134.epub`,
      size: b.size,
    });
    assert.match(b.authorId, /^\d+$/);
    assert.ok(b.size > 50000, 'EPUB size');
    const { meta, chunks } = await lib.content('37134');
    assert.equal(meta.source, 'html');
    assert.ok(meta.toc.some((t) => t.title === 'CONTENTS'));
    const logo = chunks.flatMap((c) => c.blocks).find((x) => x.t === 'img');
    assert.equal(logo.src, `/zim/${REAL_ID}/C/37134_logo.png`);
    assert.deepEqual([logo.w, logo.h], [80, 74]);
  });

  it('splits the MARC subtitle of 42108', async () => {
    const b = await lib.book('42108');
    assert.equal(b.title, 'The slang dictionary');
    assert.equal(b.subtitle, 'Etymological, historical and anecdotal');
    assert.equal(b.fullTitle, 'The slang dictionary: Etymological, historical and anecdotal');
    assert.equal(b.rank, 6);
    assert.equal(b.formats.html, true);
  });

  for (const [id, heading] of [['26577', 'How to Speak and Write Correctly'], ['28909', 'The Philosophy of Style']]) {
    it(`reads EPUB-only book ${id} through its EPUB`, async () => {
      const b = await lib.book(id);
      assert.deepEqual(b.formats, { html: false, epub: true, pdf: false });
      assert.equal(b.readable, true);
      const { meta, chunks } = await lib.content(id);
      assert.equal(meta.source, 'epub');
      assert.ok(meta.totalChars > 1000);
      assert.equal(chunks[0].blocks[0].t, 'h');
      assert.equal(chunks[0].blocks[0].r[0][0], heading);
    });
  }

  it('recovers images that a book links as img/<name> (stored as <id>_<name>)', async () => {
    const { chunks } = await lib.content('11921');
    const imgs = chunks.flatMap((c) => c.blocks).filter((b) => b.t === 'img');
    assert.ok(imgs.length > 200, `${imgs.length} images`);
    assert.ok(imgs.every((b) => b.src.startsWith(`/zim/${REAL_ID}/C/11921_`) && b.w > 0 && b.h > 0));
  });

  it('converts the 30 MB Webster\'s in a few seconds and caches it', async () => {
    const t0 = performance.now();
    const { meta } = await lib.content('29765');
    const ms = performance.now() - t0;
    assert.ok(ms < 10000, `took ${ms.toFixed(0)} ms`);
    assert.ok(meta.chunks.length > 300);
    assert.equal(meta.totalChars, meta.chunks.reduce((n, c) => n + c.chars, 0));
    const t1 = performance.now();
    await lib.content('29765');
    assert.ok(performance.now() - t1 < 50, 'cached');
  });
});

describe('Library.rescan / watch', () => {
  const waitFor = async (cond, ms = 8000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('adds, removes and reopens archives, keeping ids and bumping the generation', async () => {
    const dir = path.join(tmp, 'rescan');
    fs.mkdirSync(dir);
    writeGutenbergZim(path.join(dir, 'a.zim'));
    const log = collectLog();
    const warn = collectLog();
    const library = await Library.scan(dir, { log, warn });
    try {
      assert.equal(library.generation, 1);
      assert.deepEqual(library.list().map((l) => l.id), ['a']);

      // Nothing changed: same generation, nothing reported.
      let r = await library.rescan();
      assert.deepEqual([r.added, r.removed, r.reopened, r.failed], [[], [], [], []]);
      assert.equal(library.generation, 1);

      writeGenericZim(path.join(dir, '0-first.zim'));
      r = await library.rescan();
      assert.deepEqual(r.added, ['0-first']);
      assert.equal(r.generation, 2);
      assert.deepEqual(library.list().map((l) => l.id), ['0-first', 'a'], 'file-name order');
      assert.equal((await library.get('0-first').books()).length > 0, true);

      // Replaced file (different size/mtime): reopened under the same id.
      const old = library.get('a');
      writeGenericZim(path.join(dir, 'a.zim'));
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(dir, 'a.zim'), later, later);
      r = await library.rescan();
      assert.deepEqual(r.reopened, ['a']);
      assert.notEqual(library.get('a'), old);
      assert.equal(library.get('a').kind, 'generic');
      assert.equal(library.generation, 3);

      fs.rmSync(path.join(dir, '0-first.zim'));
      r = await library.rescan();
      assert.deepEqual(r.removed, ['0-first']);
      assert.equal(library.get('0-first'), undefined);
      assert.deepEqual(library.list().map((l) => l.id), ['a']);
      assert.ok(log.lines.some((l) => /0-first\.zim: removed/.test(l)));
    } finally {
      await library.close();
    }
  });

  it('retries a half-written file only after it changes', async () => {
    const dir = path.join(tmp, 'rescan-partial');
    fs.mkdirSync(dir);
    const full = path.join(tmp, 'full-generic.zim');
    writeGenericZim(full);
    const bytes = fs.readFileSync(full);
    const target = path.join(dir, 'growing.zim');
    fs.writeFileSync(target, bytes.subarray(0, 100));
    const warn = collectLog();
    const library = await Library.scan(dir, { log: quietLog, warn });
    try {
      assert.equal(library.list().length, 0);
      assert.equal(warn.lines.filter((l) => /growing\.zim: skipped/.test(l)).length, 1);
      await library.rescan();
      assert.equal(warn.lines.filter((l) => /growing\.zim: skipped/.test(l)).length, 1, 'unchanged file is not retried');
      fs.writeFileSync(target, bytes);
      const r = await library.rescan();
      assert.deepEqual(r.added, ['growing']);
    } finally {
      await library.close();
    }
  });

  it('shares one scan between concurrent calls', async () => {
    const dir = path.join(tmp, 'rescan-concurrent');
    fs.mkdirSync(dir);
    writeGenericZim(path.join(dir, 'x.zim'));
    const library = await Library.scan(dir, { log: quietLog });
    try {
      writeGenericZim(path.join(dir, 'y.zim'));
      const [r1, r2] = await Promise.all([library.rescan(), library.rescan()]);
      assert.equal(r1, r2);
      assert.deepEqual(r1.added, ['y']);
      assert.equal(library.list().length, 2);
    } finally {
      await library.close();
    }
  });

  it('watch() picks up a new archive on its own', async () => {
    const dir = path.join(tmp, 'rescan-watch');
    fs.mkdirSync(dir);
    const library = await Library.scan(dir, { log: quietLog });
    try {
      library.watch({ debounceMs: 100, intervalMs: 1000 });
      const src = path.join(tmp, 'watch-src.zim');
      writeGenericZim(src);
      // Like a finished browser download: written under another name, then renamed.
      fs.copyFileSync(src, path.join(dir, 'w.zim.crdownload'));
      fs.renameSync(path.join(dir, 'w.zim.crdownload'), path.join(dir, 'w.zim'));
      await waitFor(() => library.get('w'));
      assert.equal(library.generation, 2);
    } finally {
      await library.close();
    }
  });
});
