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
import { fileStore } from '../server/cache-store.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import { isWikipedia, buildIndex, volumeTitle, removeCheckpoint } from '../public/js/core/wikipedia.js';
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

/** @param {number} [padding] bytes of an extra (uncompressed) file, to make the archive bigger */
function writeWikipediaZim(file, padding = 0) {
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
    { ns: 'C', url: '_assets_/pic.png', mime: 'image/png', content: png },
    { ns: 'C', url: '_assets_/style.css', mime: 'text/css', content: 'body{}' },
    { ns: 'C', url: '_assets_/f.svg', mime: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="2ex" height="2ex"/>' },
    { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikipedia Test' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    { ns: 'M', url: 'Creator', mime: 'text/plain', content: 'Wikipedia' },
    { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: png },
  ];
  if (padding) entries.push({ ns: 'C', url: '_assets_/pad.bin', mime: 'application/octet-stream', content: Buffer.alloc(padding, 7), compression: 'none' });
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

  it('reads blob sizes and their first bytes a cluster at a time (compressed or not)', async () => {
    const file = path.join(tmp, 'blobs.zim');
    writeZim(file, {
      scheme: 'new',
      entries: [
        { ns: 'C', url: 'a', mime: 'text/html', content: 'x'.repeat(10) },
        { ns: 'C', url: 'b', mime: 'text/html', content: 'y'.repeat(3000) },
        { ns: 'C', url: 'c', mime: 'image/png', content: Buffer.alloc(700, 1), compression: 'none' },
        { ns: 'C', url: 'd', mime: 'image/png', content: Buffer.alloc(5000, 2), compression: 'none' },
      ],
    });
    const z = await ZimArchive.open(file);
    try {
      for (const url of ['a', 'b', 'c', 'd']) {
        const e = await z.findPath(`C/${url}`);
        const [got] = await z.clusterBlobs(e.cluster, [e.blob], { head: 1024, cache: false });
        assert.equal(got.size, await z.getBlobSize(e), url);
        const content = (await z.getContent(e)).data;
        assert.deepEqual(Buffer.from(got.data), content.subarray(0, 1024), `${url}: the first 1024 bytes, or all`);
        const [bare] = await z.clusterBlobs(e.cluster, [e.blob], { cache: false });
        assert.deepEqual(bare, { size: got.size, data: null }, `${url}: sizes only`);
      }
    } finally {
      await z.close();
    }
  });

  it('leaves out what is not an article: other namespaces, mwoffliner pages, placeholders', async () => {
    // Newer mwoffliner (the full English Wikipedia of 2026-08) adds Category and Portal pages and
    // marks every page's namespace in its settings.
    const page = (title, ns) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<script>RLCONF = {"wgBreakFrames":false,"wgNamespaceNumber":${ns},"wgPageName":"${title}"};</script></head>
<body class="mediawiki ns-${ns} ns-subject"><p>${title} text.</p></body></html>`.padEnd(3000, ' ');
    const P = (url, title, ns) => ({ ns: 'C', url, title, mime: 'text/html', content: page(title, ns) });
    const file = path.join(tmp, 'kinds.zim');
    writeZim(file, {
      scheme: 'new',
      mainPage: 'C/Main_Page',
      entries: [
        P('Main_Page', 'Main Page', 0),
        P('Ant', 'Ant', 0),
        P('Category:Insects', 'Category:Insects', 14),
        P('Portal:Insects/Selected_article/1', 'Portal:Insects/Selected article/1', 100),
        P('Survivor:_Borneo', 'Survivor: Borneo', 0), // an article with a colon
        { ns: 'C', url: 'Old_style', title: 'Old style', mime: 'text/html', content: article('Old style', 'No mark.') },
        { ns: 'C', url: '_categories_partials_Category:Insects_pages_2', mime: 'text/html',
          content: '<div id="mw-pages"><h2>Pages in category "Insects"</h2><a href="./Ant">Ant</a></div>' },
        { ns: 'C', url: 'Lost_page', title: 'Lost page', mime: 'text/html',
          content: '<!doctype html><html><head><link type="text/css" href="./download_error_placeholder.css" rel="stylesheet" /></head><body><h1>Oops. Page not found.</h1></body></html>' },
        { ns: 'C', url: 'Ants', title: 'Ants', mime: 'text/html', content: redirectPage('Ants', 'Ant#Kinds') },
        { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
      ],
    });
    const z = await ZimArchive.open(file);
    try {
      const logs = [];
      const idx = await buildIndex(z, { log: (m) => logs.push(m) });
      const titles = [];
      for (const i of idx.order) titles.push((await z.getEntryByIndex(i)).title);
      assert.deepEqual(titles, ['Ant', 'Old style', 'Survivor: Borneo']);
      assert.match(logs.join('\n'), /3 articles \(skipped: 1 redirect pages, 3 pages of other namespaces or not downloaded, 1 of mwoffliner's own\)/);
    } finally {
      await z.close();
    }
  });

  it('reports the size pass\'s progress in clusters, not pages', async () => {
    // One cluster of six small pages, then two of one page each: by pages the first cluster would
    // be 75 % of the work; it is one decompression of three.
    const P = (url, cluster) => ({ ns: 'C', url, title: url, mime: 'text/html', cluster, content: article(url, 'Text.') });
    const file = path.join(tmp, 'progress.zim');
    writeZim(file, {
      scheme: 'new',
      entries: [
        ...['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((u) => P(u, 'many')),
        P('B', 'b'),
        P('C', 'c'),
      ],
    });
    const z = await ZimArchive.open(file);
    try {
      const steps = [];
      await buildIndex(z, { lanes: 1, onProgress: (stage, f) => { if (stage === 'sizes') steps.push(Math.round(f * 100)); } });
      assert.deepEqual(steps, [33, 67, 100, 100]);
    } finally {
      await z.close();
    }
  });

  it('resumes an interrupted index build from its checkpoint, and ignores one of another scan', async () => {
    const file = path.join(tmp, 'wp-resume.zim');
    writeWikipediaZim(file);
    const store = fileStore(path.join(tmp, 'resume-cache'));
    const name = 'wp.part';
    const base = path.join(store.dir, name); // its files, for the checks
    const plain = (idx) => ({ ...idx, order: [...idx.order], sizes: [...idx.sizes] });
    let z = await ZimArchive.open(file);
    const clean = plain(await buildIndex(z, { volumeSize: 3 }));
    await z.close();

    // Interrupted after two clusters (as when the server stops): their pages are in the checkpoint.
    z = await ZimArchive.open(file);
    const read = z.clusterBlobs.bind(z);
    let calls = 0;
    z.clusterBlobs = async (...args) => {
      if (++calls > 2) throw new Error('interrupted');
      return read(...args);
    };
    await assert.rejects(buildIndex(z, { volumeSize: 3, store, checkpoint: name, checkpointEvery: 1, lanes: 1 }), /interrupted/);
    await z.close();
    const kept = fs.statSync(`${base}.bin`).size / 4;
    assert.ok(kept >= 2, `sizes were checkpointed (${kept})`);

    // The next build resumes: it reads only the clusters still to do, and the index is the same.
    z = await ZimArchive.open(file);
    const read2 = z.clusterBlobs.bind(z);
    const clusters = [];
    z.clusterBlobs = async (c, ...args) => {
      clusters.push(c);
      return read2(c, ...args);
    };
    const logs = [];
    const resumed = plain(await buildIndex(z, { volumeSize: 3, store, checkpoint: name, checkpointEvery: 1, lanes: 2, log: (m) => logs.push(m) }));
    await z.close();
    assert.match(logs.join('\n'), new RegExp(`resuming: ${kept} of \\d+ page sizes`));
    assert.equal(calls, 3, 'the interrupted build read two clusters, the third failed');
    assert.ok(clusters.length < calls + clusters.length && clusters.length > 0);
    assert.deepEqual(resumed, clean);

    // A checkpoint made for a different scan starts afresh, with the same result.
    const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    fs.writeFileSync(`${base}.json`, JSON.stringify({ ...meta, fingerprint: 'other' }));
    z = await ZimArchive.open(file);
    const logs2 = [];
    const fresh = plain(await buildIndex(z, { volumeSize: 3, store, checkpoint: name, log: (m) => logs2.push(m) }));
    await z.close();
    assert.ok(!logs2.some((m) => m.includes('resuming')), 'not resumed');
    assert.deepEqual(fresh, clean);
    assert.equal(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')).fingerprint, meta.fingerprint, 'rewritten for this scan');
    await removeCheckpoint(store, name);
    assert.ok(!fs.existsSync(`${base}.json`) && !fs.existsSync(`${base}.bin`));
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

      // A static build converts every article in the order the ZIM stores them (each cluster once).
      const stored = await lib.articlesInStorageOrder();
      const titleOrder = ['v1:0', 'v1:1', 'v1:2', 'v2:0', 'v2:1', 'v2:2', 'v3:0'];
      assert.deepEqual(stored.map(([v, n]) => `${v}:${n}`).sort(), titleOrder, 'every article once');
      const places = [];
      for (const [v, n] of stored) {
        const e = await lib.archive.getEntryByIndex(lib._wikipedia.order[(Number(v.slice(1)) - 1) * 3 + n]);
        places.push([e.cluster, e.blob]);
      }
      assert.deepEqual(places, [...places].sort((a, b) => a[0] - b[0] || a[1] - b[1]), 'by cluster, then blob');
      assert.notDeepEqual(stored.map(([v, n]) => `${v}:${n}`), titleOrder);

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
      // Other names (ZIM redirects): typed as written or not, never twice, never a non-article.
      assert.deepEqual(await lib.searchArticles('yellow f'), [{ title: 'Banana', book: 'v2', n: 0, from: 'Yellow fruit' }]);
      assert.deepEqual((await lib.searchArticles('beatles')).map((a) => [a.title, a.from]), [['The Beatles', 'Beatles']], 'the name typed in full leads');
      assert.deepEqual(await lib.searchArticles('apple s'), [], 'a redirect to a redirect page is not an article');
      await lib.close();

      // Reopened: the cached index is used at once.
      lib = await ArchiveLibrary.open(file, { cacheDir, volumeSize: 3, log: (m) => logs.push(m) });
      assert.equal((await lib.books()).length, 3);
      assert.equal(logs.filter((m) => /indexing Wikipedia/.test(m)).length, 1, 'indexed only once');
    } finally {
      await lib.close();
    }
  });

  it('indexes a folder\'s big archives one at a time, the smallest first', async () => {
    const dir = path.join(tmp, 'queue');
    fs.mkdirSync(dir);
    writeWikipediaZim(path.join(dir, 'a_big.zim'), 300000); // opened first (name order), indexed last
    writeWikipediaZim(path.join(dir, 'b_small.zim'));
    const logs = [];
    const library = await Library.scan(dir, { log: (m) => logs.push(m), cacheDir: path.join(tmp, 'queue-cache'), indexQueue: { smallBytes: 0 } });
    try {
      // Read at once: info() reads the archive, and meanwhile the small index can be finished.
      const big = library.get('a_big');
      assert.deepEqual(big._indexing, { stage: 'queued', progress: 0 }, 'waits for its turn');
      await waitForBooks(big);
      await waitForBooks(library.get('b_small'));
      const started = logs.filter((m) => /indexing Wikipedia articles/.test(m)).map((m) => m.split(':')[0]);
      assert.deepEqual(started, ['b_small.zim', 'a_big.zim']);
      const ready = logs.filter((m) => /index ready/.test(m)).map((m) => m.split(':')[0]);
      assert.deepEqual(ready, ['b_small.zim', 'a_big.zim'], 'one after the other');
      assert.ok(logs.some((m) => /a_big\.zim: waiting to index Wikipedia articles/.test(m)));
    } finally {
      await library.close();
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
