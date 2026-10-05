// Wikipedia mode (§2.5): detection, the titles-only article index (app title order, redirect
// pages skipped), volumes as books, articles converted one by one, and the HTTP chunk route, on a
// miniature mwoffliner-like archive.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveLibrary, Library } from '../server/library.js';
import { createApp } from '../server/http.js';
import { ZimArchive } from '../server/zim/reader.js';
import { isWikipedia, buildIndex, volumeTitle } from '../server/wikipedia.js';
import { writeZim } from './helpers/zimwriter.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-wp-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * An mwoffliner 2-shaped article: first heading (chrome), a sidebar, an infobox, a lead with a
 * formula, a collapsible section, an image.
 */
function article(title, lead) {
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
const redirectPage = (title, target) => `<html><head><title>${title}</title><meta http-equiv="refresh" content="0;URL='./${target}'" /></head><body><a href="./${target}">${title}</a></body></html>`;

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000c80000012c00000000', 'hex'); // 200×300 header

function writeWikipediaZim(file) {
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
    { ns: 'C', url: 'Apples', title: 'Apples', mime: 'text/html', content: redirectPage('Apples', 'Apple#History') },
    { ns: 'C', url: 'Zebra_stripes', title: 'Zebra stripes', mime: 'text/html', content: redirectPage('Zebra stripes', 'Zebra#History') },
    { ns: 'C', url: '_assets_/pic.png', mime: 'image/png', content: png },
    { ns: 'C', url: '_assets_/style.css', mime: 'text/css', content: 'body{}' },
    { ns: 'C', url: '_assets_/f.svg', mime: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="2ex" height="2ex"/>' },
    { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikipedia Test' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    { ns: 'M', url: 'Creator', mime: 'text/plain', content: 'Wikipedia' },
    { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: png },
  ];
  return writeZim(file, { entries, scheme: 'new', mainPage: 'C/Main_Page' });
}

/** The articles in the app's title order (digits first; "The" and case and accents ignored). */
const ORDER = ['2001: A Space Odyssey', 'Ant', 'apple', 'Banana', 'The Beatles', 'Éclair', 'Zebra'];

async function waitForBooks(lib) {
  for (let i = 0; i < 200; i++) {
    const books = await lib.books();
    if (books.length) return books;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the Wikipedia index was not built');
}

describe('wikipedia', () => {
  it('detects Wikipedia archives by metadata', () => {
    assert.equal(isWikipedia({ Source: 'en.wikipedia.org' }), true);
    assert.equal(isWikipedia({ Source: 'simple.wikipedia.org' }), true);
    assert.equal(isWikipedia({ Tags: 'wikipedia;_category:wikipedia;_pictures:yes' }), true);
    assert.equal(isWikipedia({ Source: 'en.wikisource.org', Tags: 'wikisource' }), false);
    assert.equal(isWikipedia({}), false);
    assert.equal(volumeTitle(['Ant', 'Zebra']), 'Ant – Zebra');
    assert.equal(volumeTitle(['Zebra', 'Zebra']), 'Zebra');
  });

  it('indexes articles only, in title order, cut into volumes', async () => {
    const file = path.join(tmp, 'index.zim');
    writeWikipediaZim(file);
    const z = await ZimArchive.open(file);
    try {
      const idx = await buildIndex(z, { volumeSize: 3 });
      assert.equal(idx.count, 7, 'no main page, ZIM redirect, redirect pages, images or CSS');
      const titles = [];
      for (const i of idx.order) titles.push((await z.getEntryByIndex(i)).title);
      assert.deepEqual(titles, ORDER);
      assert.deepEqual(idx.volumes, [['2001: A Space Odyssey', 'apple'], ['Banana', 'Éclair'], ['Zebra', 'Zebra']]);
      assert.equal(idx.sizes.length, 7);
      assert.ok([...idx.sizes].every((n) => n >= 1500), 'each article’s HTML size, for page estimates');
    } finally {
      await z.close();
    }
  });

  it('shelves volumes, builds the index in the background once, and converts articles on demand', async () => {
    const file = path.join(tmp, 'wp.zim');
    writeWikipediaZim(file);
    const cacheDir = path.join(tmp, 'cache');
    const logs = [];
    let changed = 0;
    let lib = await ArchiveLibrary.open(file, { cacheDir, volumeSize: 3, log: (m) => logs.push(m), onChange: () => changed++ });
    try {
      assert.equal(lib.kind, 'wikipedia');
      const books = await waitForBooks(lib);
      assert.equal(changed, 1, 'the new catalogue is announced');
      assert.deepEqual(books.map((b) => [b.id, b.title, b.subtitle, b.articles]), [
        ['v1', '2001: A Space Odyssey – apple', 'Volume 1 of 3', 3],
        ['v2', 'Banana – Éclair', 'Volume 2 of 3', 3],
        ['v3', 'Zebra', 'Volume 3 of 3', 1],
      ]);
      const v1 = books[0];
      assert.deepEqual([v1.volume, v1.volumes, v1.rank, v1.author, v1.readable], [1, 3, 1, 'Wikipedia', true]);
      assert.deepEqual(v1.range, ['2001: A Space Odyssey', 'apple']);
      assert.match(v1.emblem, /^\/zim\/wp\/M\/Illustration_48x48%401$/);
      const info = await lib.info();
      assert.deepEqual([info.kind, info.bookCount, info.articles, info.indexing], ['wikipedia', 3, 7, null]);

      // Reading metadata: one chunk per article, the article titles as contents.
      const { meta } = await lib.content('v2');
      assert.equal(meta.lazy, true);
      assert.equal(meta.chunks.length, 3);
      assert.ok(meta.chunks.every((c) => c.chars >= 200), 'sizes estimated from the HTML');
      assert.equal(meta.chunks[1].start, meta.chunks[0].chars);
      assert.equal(meta.totalChars, meta.chunks.reduce((n, c) => n + c.chars, 0));
      assert.deepEqual(meta.toc.map((t) => [t.title, t.c, t.b]), [['Banana', 0, 0], ['The Beatles', 1, 0], ['Éclair', 2, 0]]);
      assert.equal(lib.conversions, 0, 'no article converted yet');

      // An article: its title as the first heading (the page's own is chrome), sections, images.
      const chunk = await lib.chunk('v2', 1);
      const blocks = chunk.blocks;
      assert.deepEqual(blocks[0], { t: 'h', l: 1, r: [['The Beatles', 0]] });
      assert.equal(blocks.filter((b) => b.t === 'h' && b.r[0][0] === 'The Beatles').length, 1);
      assert.ok(blocks.some((b) => b.t === 'h' && b.r[0][0] === 'History'), 'the collapsible section heading');
      const img = blocks.find((b) => b.t === 'img');
      assert.equal(img.src, '/zim/wp/C/_assets_/pic.png');
      assert.deepEqual([img.w, img.h], [200, 300]);
      assert.ok(!JSON.stringify(blocks).includes('Navigation box'));
      assert.ok(!JSON.stringify(blocks).includes('Series box'), 'sidebars are dropped');
      // The infobox image opens the article, the facts follow the lead, the formula stays inline.
      assert.deepEqual(blocks.slice(0, 4).map((b) => b.t === 'h' ? 'h:' + b.r[0][0] : b.t), ['h:The Beatles', 'img', 'p', 'h:Quick facts']);
      const formula = blocks[2].r.find((r) => r.length > 2)[2];
      assert.deepEqual(formula, { src: '/zim/wp/C/_assets_/f.svg', w: 16, h: 16, va: -4, alt: 'x', inv: 1 });
      assert.equal(lib.conversions, 1);
      assert.equal(await lib.chunk('v2', 1), chunk, 'cached');
      assert.equal(await lib.chunk('v2', 3), null, 'out of range');
      assert.equal(await lib.chunk('v9', 0), undefined, 'unknown volume');
      // Article search: title prefixes in the index's own terms, with the volume and chunk.
      assert.deepEqual(await lib.searchArticles('a'), [{ title: 'Ant', book: 'v1', n: 1 }, { title: 'apple', book: 'v1', n: 2 }]);
      assert.deepEqual(await lib.searchArticles('APPLE'), [{ title: 'apple', book: 'v1', n: 2 }]);
      assert.deepEqual(await lib.searchArticles('the beat'), [{ title: 'The Beatles', book: 'v2', n: 1 }], 'a leading The is ignored');
      assert.deepEqual(await lib.searchArticles('ecl'), [{ title: 'Éclair', book: 'v2', n: 2 }], 'accents are ignored');
      assert.deepEqual(await lib.searchArticles('zeb'), [{ title: 'Zebra', book: 'v3', n: 0 }]);
      assert.deepEqual(await lib.searchArticles('apples'), [], 'redirect pages are not articles');
      assert.deepEqual(await lib.searchArticles('  '), []);
      assert.equal((await lib.searchArticles('', 3)).length, 0);
      assert.deepEqual((await lib.searchArticles('2001')).map((a) => a.title), ['2001: A Space Odyssey']);
      await lib.close();

      // Reopened: the cached index is used at once.
      lib = await ArchiveLibrary.open(file, { cacheDir, volumeSize: 3, log: (m) => logs.push(m) });
      assert.equal((await lib.books()).length, 3);
      assert.equal(logs.filter((m) => /indexing Wikipedia/.test(m)).length, 1, 'indexed only once');
    } finally {
      await lib.close();
    }
  });

  it('serves volume articles through the chunk route', async () => {
    const dir = path.join(tmp, 'served');
    fs.mkdirSync(dir);
    writeWikipediaZim(path.join(dir, 'wiki.zim'));
    const library = await Library.scan(dir, { log: () => {}, cacheDir: path.join(tmp, 'cache2') });
    const server = http.createServer(createApp(library, { log: () => {} }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await waitForBooks(library.get('wiki'));
      const base = `http://127.0.0.1:${server.address().port}/api/libraries/wiki/books/v1`;
      const meta = await (await fetch(base)).json();
      assert.equal(meta.chunks.length, 7, 'one volume of all seven articles');
      const res = await fetch(`${base}/chunks/6`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.index, 6);
      assert.deepEqual(body.blocks[0].r, [['Zebra', 0]]);
      assert.equal((await fetch(`${base}/chunks/7`)).status, 404);
      const search = `http://127.0.0.1:${server.address().port}/api/libraries/wiki/articles`;
      const found = await (await fetch(`${search}?q=ban&limit=5`)).json();
      assert.deepEqual(found, { library: 'wiki', articles: [{ title: 'Banana', book: 'v1', n: 3 }] });
      assert.deepEqual((await (await fetch(`${search}?q=`)).json()).articles, []);
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/libraries/nope/articles?q=a`)).status, 404);
    } finally {
      server.close();
      await library.close();
    }
  });
});
