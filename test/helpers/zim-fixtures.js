// Synthetic ZIMs shared by tests: a gutenberg2zim-like archive exercising the catalogue rules (new
// and old namespace scheme), a papers2zim-like one (Kiwix's newer Gutenberg files), a generic one,
// and the pieces they are made of (PNG and WebP headers, stored ZIPs, EPUBs). Used by
// library.test.js and by the browser parity test.

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { writeZim } from './zimwriter.js';

/**
 * A fixture's UUID from its file name: each ZIM has its own, as real ones do (Wikipedia and
 * Wikisource indexes are named by it; two fixtures sharing one shared their index and checkpoint
 * in a test's store).
 */
const uuidOf = (file) => crypto.createHash('md5').update(path.basename(file)).digest();

/** A PNG header that imageSize() can read (not a decodable image; the server never decodes). */
export function png(w, h) {
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
export function zipStore(files) {
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

export function makeEpub({ title, author }) {
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

export const js = (name, value, tail = ';\n') => `var ${name} = ${JSON.stringify(value)}${tail}`;

export const LONG_TITLE = 'L'.repeat(240);
export const GUTENBERG_ROWS = [
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

export const IMAGES_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Images Book</title></head><body>
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

export function bookHtml(title, body = `<p>Body of ${title}.</p>`) {
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

/** New-scheme gutenberg2zim-like archive exercising the catalog rules. */
export function writeGutenbergZim(file) {
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
export function writeOldGutenbergZim(file) {
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

/** A WebP (VP8X) header that imageSize() can read: papers2zim's pictures and covers are WebP. */
export function webp(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** A papers2zim book page (§2.2): its controls before the text, its script after it. */
export function papersPage(title, n, body) {
  return `<!DOCTYPE html>
<html lang="af"><head><meta content="text/html; charset=utf-8" http-equiv="Content-Type"/>
<title>${title}</title><link href="css/html-reader-controls.css" rel="stylesheet"/></head>
<body><div id="html-reader-controls">
<a aria-label="View book cover and information" class="html-reader-btn html-reader-btn-info" href="./index.html#/book/${n}" title="View book cover and information">
<img alt="Info" height="24" src="icons/info.svg" width="24"/>
</a>
<a aria-label="Download EPUB format" class="html-reader-btn html-reader-btn-epub" href="${title}.${n}.epub" title="Download EPUB format">
<img alt="EPUB" height="24" src="icons/epub.svg" width="24"/>
</a>
<a aria-label="Scroll to top" class="html-reader-btn html-reader-btn-up hidden" href="#" id="scroll-to-top" title="Scroll to top">
<img alt="Scroll to top" height="24" src="icons/scroll-up.svg" width="24"/>
</a>
</div><pre></pre>
${body}
<div style="text-align:center"></div><script src="js/html-reader-controls.js" type="text/javascript"></script></body></html>`;
}

/**
 * The books of PAPERS_BOOKS' file as its lists give them, in popularity order. 305 is named after
 * another title than its list's (its own JSON says where it is), 306 has no cover (so no number:
 * its slug is its id), 301 is listed twice.
 */
export const PAPERS_BOOKS = [
  { id: 'trek-tale', title: 'Trek Tale', author: { id: 'ann-author', displayName: 'Ann  Author', sortName: 'Author' }, languages: ['af'], popularity: 900, coverPath: 'covers/301_cover_image.webp', primaryCollection: 'P', availableFormats: ['epub', 'html'] },
  { id: 'op-die-delwerye-vyf-sketse', title: 'Op die delwerye : Vyf sketse', author: { id: 'bob-writer', displayName: 'Bob Writer', sortName: 'Writer' }, languages: ['af', 'nl'], popularity: 800, coverPath: 'covers/302_cover_image.webp', primaryCollection: 'CDEF', availableFormats: ['html'] },
  { id: 'epub-only', title: 'Epub Only', author: { id: 'ann-author', displayName: 'Ann Author', sortName: 'Author' }, languages: ['af'], popularity: 700, coverPath: 'covers/303_cover_image.webp', primaryCollection: 'G', availableFormats: ['epub'] },
  { id: 'trek-tale', title: 'Trek Tale', author: { id: 'ann-author', displayName: 'Ann Author', sortName: 'Author' }, languages: ['af'], popularity: 650, coverPath: 'covers/301_cover_image.webp', primaryCollection: 'P', availableFormats: ['epub', 'html'] },
  { id: 'renamed-book', title: 'Renamed Book', author: { id: 'cy-penman', displayName: 'Cy Penman', sortName: 'Penman' }, languages: ['af'], popularity: 600, coverPath: 'covers/305_cover_image.webp', primaryCollection: '', availableFormats: ['html'] },
  { id: 'coverless', title: 'Coverless', author: null, popularity: 500, coverPath: null, primaryCollection: 'P', availableFormats: ['html'] },
];

/**
 * A papers2zim-like Gutenberg archive (§2.2, Kiwix's newer files): config.json naming the source
 * (`source`), books.json, the books listed in two pages of books-pages/popularity/ (and one of
 * title/), each book's own JSON, its page with papers2zim's controls, its EPUB, its WebP cover and
 * pictures, and the scraper's other pages (an app, author pages), none of them a book. `scraper`:
 * its M/Scraper, or null for none. Its config.json starts with a byte-order mark, as some JSON
 * writers put one (Kiwix's has none): it is read past.
 */
export function writePapersGutenbergZim(file, { source = 'gutenberg', scraper = 'papers2zim-1.1.0' } = {}) {
  const page = (books) => JSON.stringify({ books });
  const own = (b, formats) => JSON.stringify({ ...b, availableFormats: [], subtitle: '', formats });
  const [trek, delwerye, epubOnly, , renamed, coverless] = PAPERS_BOOKS;
  const at = (format, path) => ({ format, path, available: !!path });
  const entries = [
    { ns: 'C', url: 'config.json', mime: 'application/json', content: '﻿' + JSON.stringify({ title: 'Projek Gutenberg-biblioteek', source: { slug: source, name: 'Project Gutenberg' }, zimName: 'gutenberg_af_all' }) },
    { ns: 'C', url: 'books.json', mime: 'application/json', content: JSON.stringify({ totalCount: 6, pageSize: 3, totalPages: 2 }) },
    { ns: 'C', url: 'books-pages/popularity/0.json', mime: 'application/json', content: page(PAPERS_BOOKS.slice(0, 3)) },
    { ns: 'C', url: 'books-pages/popularity/1.json', mime: 'application/json', content: page(PAPERS_BOOKS.slice(3)) },
    { ns: 'C', url: 'books-pages/title/0.json', mime: 'application/json', content: page([...PAPERS_BOOKS].reverse()) },
    { ns: 'C', url: 'books/301.json', mime: 'application/json', content: own(trek, [at('epub', 'Trek Tale.301.epub'), at('html', 'Trek Tale.301'), at('pdf', '')]) },
    { ns: 'C', url: 'books/trek-tale.json', mime: 'application/json', content: own(trek, [at('epub', 'Trek Tale.301.epub'), at('html', 'Trek Tale.301'), at('pdf', '')]) },
    { ns: 'C', url: 'books/op-die-delwerye-vyf-sketse.json', mime: 'application/json', content: own(delwerye, [at('html', 'Op die delwerye : Vyf sketse.302')]) },
    { ns: 'C', url: 'books/epub-only.json', mime: 'application/json', content: own(epubOnly, [at('epub', 'Epub Only.303.epub')]) },
    { ns: 'C', url: 'books/renamed-book.json', mime: 'application/json', content: own(renamed, [at('html', 'Another Name.305')]) },
    { ns: 'C', url: 'books/coverless.json', mime: 'application/json', content: own(coverless, [at('html', 'Coverless.306')]) },
    { ns: 'C', url: 'Trek Tale.301', mime: 'text/html', title: 'Trek Tale', content: papersPage('Trek Tale', 301, `<h1>Ann Author</h1>
<h1>Trek Tale</h1>
<div class="figcenter" style="width: 249px;"><img alt="Front" height="400" id="img_images_front.jpg" src="301/images/front.jpg.webp" title="" width="249"/></div>
<h2 id="one">One</h2>
<p>The trek begins.</p>
<img alt="Unsized" src="301/images/unsized.png.webp"/>
<p>See <a class="pginternal" href="#one">the start</a>.</p>`) },
    { ns: 'C', url: 'Trek Tale.301.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Trek Tale', author: 'Ann' }), compression: 'none' },
    { ns: 'C', url: '301/images/front.jpg.webp', mime: 'image/webp', content: webp(249, 400), compression: 'none' },
    { ns: 'C', url: '301/images/unsized.png.webp', mime: 'image/webp', content: webp(120, 80), compression: 'none' },
    { ns: 'C', url: 'covers/301_cover_image.webp', mime: 'image/webp', content: webp(300, 450), compression: 'none' },
    { ns: 'C', url: 'Op die delwerye : Vyf sketse.302', mime: 'text/html', title: 'Op die delwerye : Vyf sketse', content: papersPage('Op die delwerye : Vyf sketse', 302, '<h1>Op die delwerye</h1><p>Sketse.</p>') },
    { ns: 'C', url: 'covers/302_cover_image.webp', mime: 'image/webp', content: webp(300, 450), compression: 'none' },
    { ns: 'C', url: 'Epub Only.303.epub', mime: 'application/epub+zip', content: makeEpub({ title: 'Epub Only', author: 'Ann' }) },
    // 303's cover is missing; 305's page has another name than its title and number give.
    { ns: 'C', url: 'Another Name.305', mime: 'text/html', title: 'Renamed Book', content: papersPage('Another Name', 305, '<h1>Renamed Book</h1><p>Found by its own JSON.</p>') },
    { ns: 'C', url: 'covers/305_cover_image.webp', mime: 'image/webp', content: webp(300, 450), compression: 'none' },
    { ns: 'C', url: 'Coverless.306', mime: 'text/html', title: 'Coverless', content: papersPage('Coverless', 306, '<h1>Coverless</h1><p>No cover.</p>') },
    // The scraper's own pages: none of them is a book.
    { ns: 'C', url: 'index.html', mime: 'text/html', title: 'index.html', content: '<!doctype html><html><head><title>Projek Gutenberg-biblioteek</title></head><body><div id="app"></div></body></html>' },
    { ns: 'C', url: 'index/author_ann-author', mime: 'text/html', title: 'Ann Author', content: bookHtml('Ann Author') },
    { ns: 'C', url: 'noscript/book_trek-tale.html', mime: 'text/html', title: 'Trek Tale', content: bookHtml('Trek Tale - Project Gutenberg') },
    { ns: 'C', url: 'authors.json', mime: 'application/json', content: JSON.stringify({ authors: [{ id: 'ann-author', displayName: 'Ann Author', portraitPath: 'authors/7.webp' }] }) },
    { ns: 'C', url: 'collections.json', mime: 'application/json', content: JSON.stringify({ collections: [{ id: 'CDEF' }, { id: 'G' }, { id: 'P' }], totalCount: 3 }) },
    { ns: 'C', url: 'js/html-reader-controls.js', mime: 'text/javascript', content: '(function() {})();' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Projek Gutenberg-biblioteek' },
    { ns: 'M', url: 'Description', mime: 'text/plain', content: 'Alle boeke in Afrikaans' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'afr' },
    { ns: 'M', url: 'Creator', mime: 'text/plain', content: 'gutenberg.org' },
    { ns: 'M', url: 'Publisher', mime: 'text/plain', content: 'openZIM' },
    { ns: 'M', url: 'Name', mime: 'text/plain', content: 'gutenberg_af_all' },
    ...(scraper ? [{ ns: 'M', url: 'Scraper', mime: 'text/plain', content: scraper }] : []),
  ];
  return writeZim(file, { entries, scheme: 'new', mainPage: 'C/index.html' });
}

/** A ZIM without a Gutenberg index: its HTML articles are the books. */
export function writeGenericZim(file, { creator = 'Wiki Folk' } = {}) {
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

// ---------------------------------------------------------------------------------------------
// A miniature mwoffliner-like Wikipedia (test/wikipedia.test.js, test/local-library.test.js)

/**
 * An mwoffliner 2-shaped article: first heading (chrome), a sidebar, an infobox, a lead with a
 * formula, a collapsible section, an image.
 */
export function article(title, lead) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body>
<div class="mw-body"><h1 id="firstHeading">${title}</h1><div id="mw-content-text"><div class="mw-parser-output">
<table class="sidebar nomobile"><tr><td>Series box</td></tr></table>
<table class="infobox"><tr><td colspan="2"><img src="./_assets_/pic.png" width="200" height="300"></td></tr><tr><th>Kind</th><td>Thing</td></tr></table>
<p>${lead} <span class="mwe-math-element"><img src="./_assets_/f.svg" class="mwe-math-fallback-image-inline mw-invert" style="vertical-align: -0.5ex; width:2ex; height:2ex;" alt="x"></span>.</p>
<details data-level="2" open><summary class="section-heading"><h2 id="History">History</h2></summary>
<p>The history of ${title}.</p><figure><img src="./_assets_/pic.png" width="200" height="300" alt="A picture"></figure></details>
<div class="navbox">Navigation box</div>
</div></div></div></body></html>`.padEnd(1500, ' ');
}

/** mwoffliner's redirect to a section: a tiny HTML page with a meta refresh. */
export const redirectPage = (title, target) => `<html><head><title>${title}</title><meta http-equiv="refresh" content="0;URL='./${target}'" /></head><body><a href="./${target}">${title}</a></body></html>`;

/** A 200×300 PNG header (enough for the size sniffer). */
export const WIKI_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000c80000012c00000000', 'hex');

/** @param {number} [padding] bytes of an extra (uncompressed) file, to make the archive bigger */
export function writeWikipediaZim(file, padding = 0) {
  const A = (url, title, lead) => ({ ns: 'C', url, title, mime: 'text/html', content: article(title, lead) });
  const entries = [
    A('Main_Page', 'Main Page', 'Welcome to Wikipedia.'),
    A('Zebra', 'Zebra', 'Zebras are striped.'),
    A('The_Beatles', 'The Beatles', 'A band from Liverpool.'),
    A('Apple', 'apple', 'A fruit.'),
    A('Éclair', 'Éclair', 'A pastry.'),
    A('Banana', 'Banana', 'A yellow fruit.'),
    A('2001:_A_Space_Odyssey', '2001: A Space Odyssey', 'A film.'),
    A('Ant', 'Ant', 'A small insect.'),
    { ns: 'C', url: 'Beatles', redirectTo: 'C/The_Beatles' },
    { ns: 'C', url: 'Yellow_fruit', title: 'Yellow fruit', redirectTo: 'C/Banana' },
    { ns: 'C', url: 'Apple_story', title: 'Apple story', redirectTo: 'C/Apples' }, // to a redirect page
    { ns: 'C', url: 'Apples', title: 'Apples', mime: 'text/html', content: redirectPage('Apples', 'Apple#History') },
    { ns: 'C', url: 'Zebra_stripes', title: 'Zebra stripes', mime: 'text/html', content: redirectPage('Zebra stripes', 'Zebra#History') },
    { ns: 'C', url: '_assets_/pic.png', mime: 'image/png', content: WIKI_PNG },
    { ns: 'C', url: '_assets_/style.css', mime: 'text/css', content: 'body{}' },
    { ns: 'C', url: '_assets_/f.svg', mime: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="2ex" height="2ex"/>' },
    { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikipedia Test' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    { ns: 'M', url: 'Creator', mime: 'text/plain', content: 'Wikipedia' },
    { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: WIKI_PNG },
  ];
  if (padding) entries.push({ ns: 'C', url: '_assets_/pad.bin', mime: 'application/octet-stream', content: Buffer.alloc(padding, 7), compression: 'none' });
  return writeZim(file, { entries, scheme: 'new', mainPage: 'C/Main_Page', uuid: uuidOf(file) });
}

// ---------------------------------------------------------------------------------------------
// A miniature mwoffliner-like Wikisource (test/wikisource.test.js, test/local-library.test.js)

/** An mwoffliner-shaped page: skin chrome, RLCONF categories, content area, catlinks, footer. */
export function page(title, body, cats = []) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<script>RLCONF = {"wgTitle":"${title}","wgCategories":${JSON.stringify(cats)},"wgIsArticle":true};</script></head>
<body><div class="mw-page-container"><main id="content"><header class="mw-body-header"><h1 id="firstHeading">${title}</h1></header>
<div id="bodyContent"><div id="contentSub"><div class="subpages">&lt; Parent</div></div>
<div id="mw-content-text"><div class="mw-parser-output"><div class="ws-noexport">Navigation ‹ prev next ›</div>
${body}
<div class="licenseContainer licenseBanner"><img src="./_assets_/h/PD-icon.svg.png" width="200"><p>This work is in the public domain.</p></div>
</div></div><div id="catlinks" class="catlinks">Categories: ${cats.join(', ')}</div><div class="zim-footer">Made with mwoffliner</div></div></main></div></body></html>`;
}

/** A 400×600 PNG header (enough for the size sniffer). */
export const WS_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000001900000025800000000', 'hex');

export function writeWikisourceZim(file) {
  const C = (url, html, extra = {}) => ({ ns: 'C', url, title: url.replace(/_/g, ' '), mime: 'text/html', content: html, ...extra });
  const entries = [
    C('Main_Page', page('Main Page', '<p>Welcome</p>')),
    // A novel whose contents list links chapters out of URL order (10 before 2 would be wrong).
    C('The_Grey_House', page('The Grey House', `<p><img src="./_assets_/h/Grey_House_cover.jpg" width="250" data-file-width="1400"></p>
      <ul><li><a href="The_Grey_House/Chapter_1">Chapter 1</a></li><li><a href="The_Grey_House/Chapter_2">Chapter 2</a></li>
      <li><a href="The_Grey_House/Chapter_10">Chapter 10</a></li><li><a href="Author:Ann_Example">Ann Example</a></li></ul>`,
    ['1901 works', 'Novels', 'PD-old-80', 'Main pages with authority control data'])),
    C('The_Grey_House/Chapter_1', page('The Grey House/Chapter 1', '<p>It was a dark night. See <a href="../The_Grey_House/Chapter_10">the end</a>.</p>')),
    C('The_Grey_House/Chapter_2', page('The Grey House/Chapter 2', '<p>The morning came.</p>')),
    C('The_Grey_House/Chapter_10', page('The Grey House/Chapter 10', '<p>The end.</p>')),
    // A poetry collection with no links to its parts: natural-order fallback.
    C('Songs_of_Dusk', page('Songs of Dusk', '<p>A collection.</p>', ['Collections of poetry', '1880 works'])),
    C('Songs_of_Dusk/Song_2', page('Songs of Dusk/Song 2', '<p>Second song</p>')),
    C('Songs_of_Dusk/Song_1', page('Songs of Dusk/Song 1', '<p>First song</p>')),
    C('Songs_of_Dusk/Song_11', page('Songs of Dusk/Song 11', '<p>Eleventh song</p>')),
    // Not works: a single page, a namespaced page, an author page, a redirect.
    C('A_Single_Poem', page('A Single Poem', '<p>Alone.</p>', ['Poems'])),
    C('Portal:Poetry', page('Portal:Poetry', '<p>Portal</p>')),
    C('Author:Ann_Example', page('Author:Ann Example', '<ul><li><a href="The_Grey_House">The Grey House</a> (1901)</li></ul>')),
    C('Author:Tom_Translator', page('Author:Tom Translator', '<ul><li><a href="The_Grey_House">The Grey House</a> (translated)</li><li><a href="Songs_of_Dusk/Song_1">Song 1</a></li></ul>')),
    { ns: 'C', url: 'Grey_House', redirectTo: 'C/The_Grey_House' },
    { ns: 'C', url: '_assets_/h/Grey_House_cover.jpg', mime: 'image/png', content: WS_PNG },
    { ns: 'C', url: '_assets_/h/PD-icon.svg.png', mime: 'image/png', content: WS_PNG },
    { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikisource.org' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikisource' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
  ];
  return writeZim(file, { entries, scheme: 'new', mainPage: 'C/Main_Page', uuid: uuidOf(file) });
}
