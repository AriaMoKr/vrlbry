import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { blockChars } from '../server/content/html.js';
import {
  ArchiveLibrary, Library, LibraryError, gutenbergBase, libraryIdFor, parseIndexScript, splitTitle, zimUrl,
} from '../server/library.js';
import { writeZim } from './helpers/zimwriter.js';

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

// ---------------------------------------------------------------------------------------------
// Fixture helpers

/** A PNG header that imageSize() can read (not a decodable image; the server never decodes). */
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

/** Stored (uncompressed) ZIP archive. */
function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function makeEpub({ title, author }) {
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="fig" href="images/fig%201.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const doc = (body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
  return zipStore([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', opf],
    ['OEBPS/text/ch1.xhtml', doc('<h1>Chapter One</h1><p>First chapter text.</p><img src="../images/fig%201.png" alt="Figure"/>')],
    ['OEBPS/text/ch2.xhtml', doc('<h1>Chapter Two</h1><p>Second chapter text.</p><img src="../images/none.png" alt="Lost figure"/>')],
    ['OEBPS/images/fig 1.png', png(300, 150)],
  ]);
}

const js = (name, value, tail = ';\n') => `var ${name} = ${JSON.stringify(value)}${tail}`;

const LONG_TITLE = 'L'.repeat(240);
const GUTENBERG_ROWS = [
  ['Alpha/Beta/Gamma', 'Ann Author', '110', 101, 'PE'],
  ['One/Two/Three', 'Ann Author', '100', 102, 'PE'],
  ['The slang dictionary : $b Etymological, historical', 'Bob  Writer', '110', 103, 'PR'],
  [LONG_TITLE, 'Ann Author', '100', 104, 'PE'],
  ['Epub Only Book', 'Cy Penman', '010', 105, 'PE'],
  ['Images Book', 'Ann Author', '100', 106, 'PE'],
  ['Ghost Book', 'Ann Author', '110', 107, 'PE'],
  ['Alpha/Beta/Gamma (duplicate row)', 'Ann Author', '110', 101, 'PE'],
  ['Orphan Author Book', 'Nobody Listed', '100', 108, ''],
];

const IMAGES_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Images Book</title></head><body>
<h1>Images Book</h1>
<p>Intro text.</p>
<img src="106_logo.png" alt="Logo">
<h2 id="c1">Chapter 1</h2>
<p>Text with an image <img src="img/pic.png" alt="Pic" width="50"> inside.</p>
<img src="missing.png" alt="Missing figure">
<img src="gone.png">
<img src="106_page.html" alt="Not an image">
<img src="data:image/png;base64,${png(7, 9).toString('base64')}">
<h2>Chapter 2</h2>
<p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p>
</body></html>`;

function bookHtml(title, body = `<p>Body of ${title}.</p>`) {
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

/** New-scheme gutenberg2zim-like archive exercising the catalog rules. */
function writeGutenbergZim(file) {
  const entries = [
    { ns: 'C', url: 'full_by_popularity.js', mime: 'text/javascript', content: '﻿' + js('json_data', GUTENBERG_ROWS, ';;  \n\n') },
    { ns: 'C', url: 'authors.js', mime: 'text/javascript', content: js('authors_json_data', [['Ann Author', '7'], ['Bob Writer', '8'], ['Cy Penman', 9]]) },
    { ns: 'C', url: 'languages.js', mime: 'text/javascript', content: js('languages_json_data', [['English', 'en', 8]]) },
    { ns: 'C', url: 'lcc_shelves.js', mime: 'text/javascript', content: js('lcc_shelves_json_data', ['PE', 'PR']) },
    // 101: JS semantics, only the first '/' becomes '-'.
    { ns: 'C', url: 'Alpha-Beta/Gamma.101', mime: 'text/html', content: bookHtml('Alpha') },
    // libzim stores already-compressed formats (EPUB, JPEG…) in uncompressed clusters.
    { ns: 'C', url: 'Alpha-Beta/Gamma.101.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Alpha', author: 'Ann' }), compression: 'none' },
    { ns: 'C', url: 'covers/101_cover_image.jpg', mime: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    // 102: only the scraper's (Python) form exists: every '/' replaced.
    { ns: 'C', url: 'One-Two-Three.102', mime: 'text/html', content: bookHtml('One Two Three') },
    { ns: 'C', url: 'The slang dictionary : $b Etymological, historical.103', mime: 'text/html', content: bookHtml('Slang') },
    { ns: 'C', url: 'The slang dictionary : $b Etymological, historical.103.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Slang', author: 'Bob' }) },
    { ns: 'C', url: `${'L'.repeat(230)}.104`, mime: 'text/html', content: bookHtml('Long') },
    { ns: 'C', url: 'Epub Only Book.105.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Epub Only Book', author: 'Cy Penman' }) },
    { ns: 'C', url: 'covers/105_cover_image.jpg', mime: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { ns: 'C', url: 'Images Book.106', mime: 'text/html', content: IMAGES_HTML },
    { ns: 'C', url: '106_logo.png', mime: 'image/png', content: png(120, 60), compression: 'none' },
    { ns: 'C', url: '106_pic.png', mime: 'image/png', content: png(200, 100) },
    { ns: 'C', url: '106_page.html', mime: 'text/html', content: '<p>not an image</p>' },
    { ns: 'C', url: 'Orphan Author Book.108', mime: 'text/html', content: bookHtml('Orphan') },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Synthetic Gutenberg' },
    { ns: 'M', url: 'Description', mime: 'text/plain', content: 'Test library' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    { ns: 'M', url: 'Creator', mime: 'text/plain', content: 'gutenberg.org' },
    { ns: 'M', url: 'Publisher', mime: 'text/plain', content: 'openZIM' },
    { ns: 'M', url: 'Date', mime: 'text/plain', content: '2026-01-02' },
    { ns: 'M', url: 'Name', mime: 'text/plain', content: 'synthetic_gutenberg' },
    { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: png(48, 48) },
  ];
  return writeZim(file, { entries, scheme: 'new' });
}

/** Old-scheme (gutenberg2zim 2.x-like) archive: index under -/js/, HTML in A, covers in I. */
function writeOldGutenbergZim(file) {
  const rows = [['Old Book', 'Ann Author', '110', 201, 'PE'], ['Zweites Buch', 'Hans Autor', '100', 202, 'PT']];
  const entries = [
    { ns: '-', url: 'js/full_by_popularity.js', mime: 'text/javascript', content: js('json_data', rows) },
    { ns: '-', url: 'js/authors.js', mime: 'text/javascript', content: js('authors_json_data', [['Ann Author', '7']]) },
    { ns: '-', url: 'js/languages.js', mime: 'text/javascript', content: js('languages_json_data', [['English', 'en', 1], ['Deutsch', 'de', 1]]) },
    { ns: '-', url: 'js/lang_en_by_popularity.js', mime: 'text/javascript', content: js('json_data', [rows[0]]) },
    { ns: '-', url: 'js/lang_de_by_popularity.js', mime: 'text/javascript', content: js('json_data', [rows[1]]) },
    { ns: 'A', url: 'Old Book.201.html', mime: 'text/html', content: bookHtml('Old Book', '<p>Old text.</p><img src="../I/201_fig.png" alt="Fig">') },
    { ns: '-', url: 'Old Book.201.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Old', author: 'Ann' }) },
    { ns: 'I', url: '201_fig.png', mime: 'image/png', content: png(10, 20) },
    { ns: 'I', url: 'covers/201_cover.jpg', mime: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { ns: 'A', url: 'Zweites Buch.202', mime: 'text/html', content: bookHtml('Zweites Buch') },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Old Gutenberg' },
  ];
  return writeZim(file, { entries, scheme: 'old', compression: 'zlib' });
}

/** A ZIM without a Gutenberg index: its HTML articles are the books. */
function writeGenericZim(file, { creator = 'Wiki Folk' } = {}) {
  const entries = [
    { ns: 'C', url: 'index.html', title: 'Main Page', mime: 'text/html', content: bookHtml('Main') },
    { ns: 'C', url: 'a.html', title: 'Article  A', mime: 'text/html', content: bookHtml('A', '<p>See <img src="img/x.png" alt="x"></p>') },
    { ns: 'C', url: 'b.html', title: 'Article B', mime: 'text/html', content: bookHtml('B') },
    { ns: 'C', url: 'img/x.png', mime: 'image/png', content: png(64, 32) },
    { ns: 'C', url: 'style.css', mime: 'text/css', content: 'p{}' },
    { ns: 'C', url: 'alias.html', redirectTo: 'C/a.html' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'fra,eng' },
    ...(creator ? [{ ns: 'M', url: 'Creator', mime: 'text/plain', content: creator }] : []),
  ];
  return writeZim(file, { entries, scheme: 'new', mainPage: 'C/index.html' });
}

const quietLog = () => {};
function collectLog() {
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.lines = lines;
  return log;
}

// ---------------------------------------------------------------------------------------------

describe('library helpers', () => {
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
      description: 'Test library',
      longDescription: null,
      language: 'eng',
      date: '2026-01-02',
      creator: 'gutenberg.org',
      publisher: 'openZIM',
      name: 'synthetic_gutenberg',
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
      title: 'Project Gutenberg Library',
      description: 'English language',
      longDescription: 'English language studies, grammar, etymology, dialects, linguistics, philology, and the history of the English language.',
      language: 'eng',
      date: '2026-03-05',
      creator: 'gutenberg.org',
      publisher: 'openZIM',
      name: 'gutenberg_en_lcc-pe',
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
