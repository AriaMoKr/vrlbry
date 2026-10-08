// Wikisource mode: category → genre rules, page parsing, the works index, work assembly, and the
// ArchiveLibrary integration (background indexing, on-disk cache), on a miniature mwoffliner-like
// archive.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Library } from '../server/library.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import {
  isWikisource, genreOf, yearOf, cleanCategories, pageCategories, coverOf, contentLinks, partTitle,
  buildIndex, collectWork, OTHER_GENRE,
} from '../public/js/core/wikisource.js';
import { page, WS_PNG, writeWikisourceZim } from './helpers/zim-fixtures.js';
import { writeZim } from './helpers/zimwriter.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-ws-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const png = WS_PNG; // 400×600 header

describe('wikisource helpers', () => {
  it('detects Wikisource archives by metadata', () => {
    assert.equal(isWikisource({ Source: 'en.wikisource.org' }), true);
    assert.equal(isWikisource({ Tags: 'wikisource;_category:wikisource;_pictures:yes' }), true);
    assert.equal(isWikisource({ Source: 'en.wikipedia.org', Tags: 'wikipedia' }), false);
    assert.equal(isWikisource({}), false);
  });

  it('maps categories to genres and years, ignoring maintenance categories', () => {
    assert.equal(genreOf(['1926 works', 'Novels', 'American novels']), 'Novels');
    assert.equal(genreOf(['Collections of short stories']), 'Short stories');
    assert.equal(genreOf(['Scottish poetry', 'Pamphlets']), 'Poetry');
    assert.equal(genreOf(['United States Supreme Court decisions', '1948 court decisions']), 'Court decisions');
    assert.equal(genreOf(['Treaties']), 'Law & politics');
    assert.equal(genreOf(['1905 works']), OTHER_GENRE);
    assert.equal(genreOf([]), OTHER_GENRE);
    assert.equal(yearOf(['Novels', '1926 works']), 1926);
    assert.equal(yearOf(['Novels']), null);
    assert.deepEqual(cleanCategories(['PD-old', 'Main pages with authority control data', 'Novels', 'Case missing lower court']), ['Novels']);
  });

  it('reads categories, cover and links from an mwoffliner page', () => {
    const html = page('W', '<p><img src="./_assets_/h/logo.svg.png" width="300"><img src="./_assets_/h/tiny.jpg" width="40"><img src="./_assets_/h/Real_cover.jpg" width="250"></p><a href="W/Chapter_1">1</a> <a href="./W/Chapter_2#x">2</a> <a href="https://example.org/">ext</a> <a href="W/Chapter_1">again</a>', ['Novels', 'PD-old-70']);
    assert.deepEqual(pageCategories(html), ['Novels']);
    assert.equal(coverOf(html, 'C/W'), 'C/_assets_/h/Real_cover.jpg');
    assert.equal(coverOf(page('X', '<p>No pictures</p>'), 'C/X'), null, 'the licence banner icon is not a cover');
    assert.deepEqual(contentLinks(html, 'C/W'), ['W/Chapter_1', 'W/Chapter_2']);
    assert.equal(partTitle('Work/Volume_I/Chapter_IV'), 'Chapter IV');
  });
});

describe('wikisource index and assembly', () => {
  let file;
  before(() => {
    file = path.join(tmp, 'ws-index.zim');
    writeWikisourceZim(file);
  });

  it('indexes multi-part works with genre, year, cover and author', async () => {
    const z = await ZimArchive.open(file);
    try {
      const stages = new Set();
      const idx = await buildIndex(z, { onProgress: (s) => stages.add(s) });
      assert.equal(idx.uuid, z.header.uuid);
      const byUrl = new Map(idx.works.map((w) => [w[0], w]));
      assert.deepEqual([...byUrl.keys()].sort(), ['Songs_of_Dusk', 'The_Grey_House']);
      const [, title, , parts, cover, year, cats, author] = byUrl.get('The_Grey_House');
      assert.equal(title, 'The Grey House');
      assert.equal(parts, 3);
      assert.equal(cover, 'C/_assets_/h/Grey_House_cover.jpg');
      assert.equal(year, 1901);
      assert.deepEqual(cats, ['1901 works', 'Novels']);
      // Credited by two author pages (author and translator): the one named on the work's own
      // page wins.
      assert.equal(author, 'Ann Example');
      assert.equal(byUrl.get('Songs_of_Dusk')[7], 'Tom Translator', 'a link to one of its parts credits the work');
      assert.ok(stages.has('done'));
    } finally {
      await z.close();
    }
  });

  it('assembles a work in contents order, depth-first, with a natural-order fallback', async () => {
    const z = await ZimArchive.open(file);
    try {
      const novel = await collectWork(z, 'The_Grey_House', { expectedParts: 3 });
      assert.deepEqual(novel.parts.map((p) => p.url), ['The_Grey_House', 'The_Grey_House/Chapter_1', 'The_Grey_House/Chapter_2', 'The_Grey_House/Chapter_10'],
        'the link from chapter 1 to chapter 10 does not reorder the book');
      assert.equal(novel.truncated, false);
      const songs = await collectWork(z, 'Songs_of_Dusk', { expectedParts: 3 });
      assert.deepEqual(songs.parts.map((p) => p.url), ['Songs_of_Dusk', 'Songs_of_Dusk/Song_1', 'Songs_of_Dusk/Song_2', 'Songs_of_Dusk/Song_11']);
      const capped = await collectWork(z, 'The_Grey_House', { expectedParts: 3, maxParts: 2 });
      assert.equal(capped.parts.length, 2);
      assert.equal(capped.truncated, true);
    } finally {
      await z.close();
    }
  });

  it('serves works through ArchiveLibrary: background index, generation bump, cache, reading', async () => {
    const dir = path.join(tmp, 'lib');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(dir);
    fs.copyFileSync(file, path.join(dir, 'wikisource_test.zim'));
    let library = await Library.scan(dir, { log: () => {}, cacheDir });
    try {
      const lib = library.get('wikisource_test');
      assert.equal(lib.kind, 'wikisource');
      // First open: empty while the index is built, then the catalogue changes on its own.
      const gen0 = library.generation;
      const t0 = Date.now();
      while (library.generation === gen0) {
        assert.ok(Date.now() - t0 < 10000, 'index finished');
        await new Promise((r) => setTimeout(r, 20));
      }
      const info = await lib.info();
      assert.equal(info.indexing, null);
      assert.equal(info.bookCount, 2);
      assert.deepEqual(info.genres.map((g) => g.name).sort(), ['Novels', 'Poetry']);
      const books = await lib.books();
      const novel = books.find((b) => b.title === 'The Grey House');
      assert.equal(novel.genre, 'Novels');
      assert.equal(novel.author, 'Ann Example');
      assert.equal(novel.year, 1901);
      assert.equal(novel.parts, 3);
      assert.match(novel.cover, /^\/zim\/wikisource_test\/C\/_assets_\/h\/Grey_House_cover\.jpg$/);

      const { meta, chunks } = await lib.content(novel.id);
      const blocks = chunks.flatMap((c) => c.blocks);
      const heads = blocks.filter((b) => b.t === 'h').map((b) => b.r[0][0]);
      assert.deepEqual(heads, ['The Grey House', 'Chapter 1', 'Chapter 2', 'Chapter 10']);
      const text = blocks.filter((b) => b.r).map((b) => b.r.map((r) => r[0]).join('')).join('\n');
      assert.match(text, /It was a dark night/);
      assert.match(text, /The end\./);
      assert.doesNotMatch(text, /Navigation|public domain|Categories:|mwoffliner|< Parent/, 'MediaWiki chrome is stripped');
      assert.equal(meta.toc.length, 4);
      assert.ok(fs.readdirSync(cacheDir).some((f) => /^wikisource-.*\.json$/.test(f)), 'index cached on disk');
    } finally {
      await library.close();
    }
    // Second open: straight from the cache, no indexing.
    library = await Library.scan(dir, { log: () => {}, cacheDir });
    try {
      const lib = library.get('wikisource_test');
      assert.equal((await lib.books()).length, 2);
      assert.equal((await lib.info()).indexing, null);
    } finally {
      await library.close();
    }
  });
});
