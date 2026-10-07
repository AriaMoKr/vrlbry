// Synthetic ZIMs shared by tests: a gutenberg2zim-like archive exercising the catalogue rules (new
// and old namespace scheme), a generic one, and the pieces they are made of (PNG headers, stored
// ZIPs, EPUBs). Used by library.test.js and by the browser parity test.

import zlib from 'node:zlib';
import { writeZim } from './zimwriter.js';

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
