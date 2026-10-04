// Tests for server/content/epub.js (SPEC §3.4).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { readZip, parseEpub } from '../server/content/epub.js';
import { htmlToBlocks } from '../server/content/html.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'content');

// --- a tiny ZIP writer for synthetic archives --------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds a ZIP archive. entries: [{ name, data, method = 8, descriptor = false, utf8Flag = true }].
 * `descriptor` writes zero sizes/CRC in the local header followed by a data descriptor, like
 * streaming zip writers do.
 */
function makeZip(entries, { prefix = Buffer.alloc(0), comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = prefix.length;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const flags = (e.utf8Flag === false ? 0 : 0x800) | (e.descriptor ? 0x8 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    lh.writeUInt32LE(e.descriptor ? 0 : comp.length, 18);
    lh.writeUInt32LE(e.descriptor ? 0 : data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const extra = Buffer.from([0xfe, 0xca, 0, 0]); // an (empty) extra field, to be skipped
    lh.writeUInt16LE(extra.length, 28);
    const parts = [lh, name, extra, comp];
    if (e.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(comp.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const local = Buffer.concat(parts);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const c = Buffer.from(comment, 'latin1');
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([prefix, ...locals, cd, eocd, c]);
}

describe('readZip', () => {
  const text = 'Hello, ZIP! '.repeat(200);
  const binary = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) & 0xff));

  test('reads stored and deflated entries, skips directories', () => {
    const zip = readZip(makeZip([
      { name: 'mimetype', data: 'application/epub+zip', method: 0 },
      { name: 'dir/', data: '', method: 0 },
      { name: 'dir/text.txt', data: text },
      { name: 'dir/bin.dat', data: binary, method: 0 },
      { name: 'empty.txt', data: '' },
    ]));
    assert.deepEqual(zip.names, ['mimetype', 'dir/text.txt', 'dir/bin.dat', 'empty.txt']);
    assert.equal(zip.get('mimetype').toString(), 'application/epub+zip');
    assert.equal(zip.get('dir/text.txt').toString(), text);
    assert.deepEqual(zip.get('dir/bin.dat'), binary);
    assert.equal(zip.get('empty.txt').length, 0);
    assert.equal(zip.has('dir/text.txt'), true);
    assert.equal(zip.has('dir/'), false);
    assert.equal(zip.has('missing'), false);
    assert.equal(zip.get('missing'), null);
  });

  test('handles data descriptors, archive comments, prepended data and non-UTF-8-flagged names', () => {
    const zip = readZip(makeZip([
      { name: 'streamed.txt', data: text, descriptor: true },
      { name: 'caf\u00e9/na\u00efve.txt', data: 'x', utf8Flag: false },
    ], { prefix: Buffer.from('#!/bin/sh self-extractor stub\n'), comment: 'archive comment' }));
    assert.equal(zip.get('streamed.txt').toString(), text);
    assert.equal(zip.get('caf\u00e9/na\u00efve.txt').toString(), 'x');
  });

  test('accepts Uint8Array input', () => {
    const buf = makeZip([{ name: 'a', data: 'b' }]);
    const zip = readZip(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    assert.equal(zip.get('a').toString(), 'b');
  });

  test('clear errors for non-zips and unsupported features', () => {
    assert.throws(() => readZip(Buffer.from('definitely not a zip file at all, sorry')), /Not a ZIP/);
    assert.throws(() => readZip(Buffer.alloc(5)), /Not a ZIP/);
    const unsupported = makeZip([{ name: 'x', data: 'abc', method: 0 }]);
    unsupported.writeUInt16LE(12, unsupported.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10); // bzip2 in the central dir
    assert.throws(() => readZip(unsupported).get('x'), /compression method 12/);
    const z64 = makeZip([{ name: 'x', data: 'abc' }]);
    z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
    assert.throws(() => readZip(z64), /ZIP64/);
  });
});

// --- EPUB ----------------------------------------------------------------------------------------

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>  A  Synthetic
      Book </dc:title>
    <dc:creator id="ill">Ivy Illustrator</dc:creator>
    <meta refines="#ill" property="role" scheme="marc:relators">ill</meta>
    <dc:creator id="a1">Ann Author</dc:creator>
    <meta refines="#a1" property="role" scheme="marc:relators">aut</meta>
    <dc:language>en-GB</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="wrap0000.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/fig%201.png" media-type="image/png"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="gone" href="text/missing.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="c1"/>
    <itemref idref="gone"/>
    <itemref idref="c2"/>
    <itemref idref="css"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>`;

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

function syntheticEpub(overrides = {}) {
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': OPF,
    'OEBPS/nav.xhtml': xhtml('Nav', '<nav><ol><li>x</li></ol></nav>'),
    'OEBPS/wrap0000.xhtml': xhtml('Cover', '<div><svg xmlns="http://www.w3.org/2000/svg"><image href="c.jpg"/></svg></div>'),
    'OEBPS/text/ch1.xhtml': xhtml('One', '<h1>Chapter One</h1><p>It was a <i>dark</i> night.<br/>Really.</p><p><img src="../images/fig%201.png" alt="Figure"/></p>'),
    'OEBPS/text/chapter 2.xhtml': xhtml('Two', '<h1>Chapter Two</h1><p>Caf\u00e9 au lait.</p>'),
    'OEBPS/text/notes.xhtml': xhtml('Notes', '<p>A note.</p>'),
    'OEBPS/images/fig 1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
    'OEBPS/style.css': 'p { margin: 0 }',
    ...overrides,
  };
  return makeZip(Object.entries(files).filter(([, v]) => v !== null).map(([name, data]) => ({ name, data, method: name === 'mimetype' ? 0 : 8 })));
}

describe('parseEpub', () => {
  test('metadata, spine order, XHTML only, cover wrapper and missing docs skipped', () => {
    const epub = parseEpub(syntheticEpub());
    assert.equal(epub.title, 'A Synthetic Book');
    assert.equal(epub.author, 'Ann Author'); // the illustrator is not an author
    assert.equal(epub.language, 'en-GB');
    assert.deepEqual(epub.docs.map((d) => d.path), ['OEBPS/text/ch1.xhtml', 'OEBPS/text/chapter 2.xhtml']);
    assert.ok(epub.docs[1].html.includes('Caf\u00e9 au lait'));
  });

  test('documents convert with images resolved to zip paths that getFile returns', () => {
    const epub = parseEpub(syntheticEpub());
    const { title, blocks } = htmlToBlocks(epub.docs[0].html, { docPath: epub.docs[0].path });
    assert.equal(title, 'One');
    assert.deepEqual(blocks, [
      { t: 'h', l: 1, r: [['Chapter One', 0]] },
      { t: 'p', r: [['It was a ', 0], ['dark', 1], [' night.\nReally.', 0]] },
      { t: 'img', src: 'OEBPS/images/fig 1.png', alt: 'Figure' },
    ]);
    const png = epub.getFile(blocks[2].src);
    assert.ok(Buffer.isBuffer(png));
    assert.equal(png[1], 0x50);
    assert.equal(epub.mimeOf(blocks[2].src), 'image/png');
  });

  test('getFile and mimeOf: normalization, percent-encoding, case, fallbacks', () => {
    const epub = parseEpub(syntheticEpub());
    assert.equal(epub.getFile('OEBPS/style.css').toString(), 'p { margin: 0 }');
    assert.equal(epub.getFile('/OEBPS/style.css').toString(), 'p { margin: 0 }');
    assert.ok(epub.getFile('OEBPS/images/fig%201.png'));
    assert.ok(epub.getFile('oebps/STYLE.css'));
    assert.equal(epub.getFile('OEBPS/nope.css'), null);
    assert.equal(epub.getFile(undefined), null);
    assert.equal(epub.mimeOf('OEBPS/style.css'), 'text/css');
    assert.equal(epub.mimeOf('OEBPS/text/ch1.xhtml'), 'application/xhtml+xml');
    assert.equal(epub.mimeOf('somewhere/else.JPG'), 'image/jpeg');
    assert.equal(epub.mimeOf('font.woff2'), 'font/woff2');
    assert.equal(epub.mimeOf('unknown.bin'), 'application/octet-stream');
  });

  test('without container.xml the first .opf is used; missing metadata gives nulls', () => {
    const opf = '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="a" href="a.html" media-type="text/html"/></manifest><spine><itemref idref="a"/></spine></package>';
    const buf = makeZip([
      { name: 'book/package.opf', data: opf },
      { name: 'book/a.html', data: '<p>Only</p>' },
    ]);
    const epub = parseEpub(buf);
    assert.equal(epub.title, null);
    assert.equal(epub.author, null);
    assert.equal(epub.language, null);
    assert.deepEqual(epub.docs, [{ path: 'book/a.html', html: '<p>Only</p>' }]);
  });

  test('a spine made only of non-linear items is still read', () => {
    const opf = '<package><metadata><dc:title xmlns:dc="x">T</dc:title><dc:creator xmlns:dc="x">One</dc:creator><dc:creator xmlns:dc="x">Two</dc:creator></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a" linear="no"/></spine></package>';
    const epub = parseEpub(makeZip([{ name: 'content.opf', data: opf }, { name: 'a.xhtml', data: '<p>x</p>' }]));
    assert.equal(epub.docs.length, 1);
    assert.equal(epub.author, 'One, Two');
  });

  test('text encodings: BOM, UTF-16, declared legacy charset', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>\u00e9t\u00e9</p>', 'utf16le')]);
    const latin1 = Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><p>\u00e9t\u00e9</p>', 'latin1');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>\u00e9t\u00e9</p>')]);
    const opf = '<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>';
    const epub = parseEpub(makeZip([{ name: 'p.opf', data: opf }, { name: 'a.xhtml', data: utf16 }, { name: 'b.xhtml', data: latin1 }, { name: 'c.xhtml', data: bom }]));
    for (const d of epub.docs) assert.ok(d.html.endsWith('<p>\u00e9t\u00e9</p>'), d.path);
  });

  test('throws a clear error on a non-zip or a zip without OPF', () => {
    assert.throws(() => parseEpub(Buffer.from('not a zip')), /Not a ZIP/);
    assert.throws(() => parseEpub(makeZip([{ name: 'readme.txt', data: 'hi' }])), /no OPF/);
    assert.throws(() => parseEpub(syntheticEpub({ 'OEBPS/content.opf': null })), /no OPF/);
  });

  test('real EPUB from the ZIM: "The Philosophy of Style" (28909, EPUB-only book)', () => {
    const epub = parseEpub(fs.readFileSync(path.join(FIXTURES, 'philosophy-of-style.28909.epub')));
    assert.equal(epub.title, 'The Philosophy of Style');
    assert.equal(epub.author, 'Herbert Spencer');
    assert.equal(epub.language, 'en');
    assert.deepEqual(epub.docs.map((d) => d.path), ['28909/0.html']);
    assert.equal(epub.mimeOf('28909/0.html'), 'application/xhtml+xml');
    assert.ok(epub.getFile('28909/toc.ncx'));
    const { title, blocks } = htmlToBlocks(epub.docs[0].html, { docPath: epub.docs[0].path });
    assert.equal(title, 'The Philosophy of Style');
    assert.deepEqual(blocks[0], { t: 'h', l: 1, r: [['The Philosophy of Style', 0]], a: 'c', id: 'pgepubid00000' });
    assert.deepEqual(blocks[1], { t: 'h', l: 2, r: [['Herbert Spencer', 0]], a: 'c', id: 'pgepubid00001' });
    const items = blocks.filter((b) => b.t === 'li');
    assert.equal(items.length, 15);
    assert.deepEqual(items[1], { t: 'li', r: [['28909-01.mp3', 0]], d: 2, m: '\u2022' });
    // the PG license lives in an HTML comment and must not leak into the text
    assert.ok(!blocks.some((b) => b.r && b.r.some((r) => r[0].includes('Project Gutenberg-tm'))));
  });
});
