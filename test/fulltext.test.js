// Full-text search through kiwix-serve (§4): finding a hit in a book's blocks (content/find.js),
// reading kiwix-serve's answers (server/kiwix-serve.js), placing hits (ArchiveLibrary.placeOf) and
// the HTTP routes (text, find) with a stand-in for kiwix-serve.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import '../server/platform-node.js';
import { blockText, findInBlocks, snippetTarget, textWords, topScore } from '../public/js/core/content/find.js';
import { createApp } from '../server/http.js';
import { dashedUuid, decodeEntities, kiwixServe, parseSearchXml, snippetParts } from '../server/kiwix-serve.js';
import { Library } from '../server/library.js';
import { writeGutenbergZim, writeWikisourceZim } from './helpers/zim-fixtures.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-fulltext-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const p = (text) => ({ t: 'p', r: [[text, 0]] });

/** Waits for a library's background index (Wikisource's works). */
async function ready(lib) {
  for (let i = 0; i < 1500; i++) { // up to 30 s: the suite's files run at once
    if ((await lib.books()).length && !(await lib.info()).indexing) return lib;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the index was not built');
}

describe('finding a hit in blocks (content/find.js)', () => {
  it('reads words without case, accents or punctuation', () => {
    assert.deepEqual(textWords('Éclair, “WHALE”-ship; 1851!'), ['eclair', 'whale', 'ship', '1851']);
    assert.deepEqual(textWords(''), []);
  });

  it('takes a block\'s text from its runs, cells or preformatted text', () => {
    assert.equal(blockText({ t: 'p', r: [['Mo', 0], ['by', 1], ['￼', 0, { src: 'x' }], ['Dick', 2]] }), 'Moby Dick');
    assert.equal(blockText({ t: 'tr', c: [[['a', 0]], [['b', 0]]] }), 'a b');
    assert.equal(blockText({ t: 'pre', x: 'code here' }), 'code here');
    assert.equal(blockText({ t: 'hr' }), '');
  });

  it('takes the words around the first hit, the hit words and the query\'s', () => {
    const parts = [['...the unaccompanied, secluded ', 0], ['White', 1], [' ', 0], ['Whale', 1], [' had haunted those uncivilized seas mostly...', 0]];
    assert.deepEqual(snippetTarget(parts, 'white whale'), {
      words: ['secluded', 'white', 'whale', 'had', 'haunted', 'those'],
      hits: ['white', 'whale'],
      terms: ['white', 'whale'],
    });
    // The hit near the end of its piece: the words before it fill the window.
    const late = snippetTarget([['one two three four five six seven ', 0], ['whale', 1], ['...more', 0]]);
    assert.deepEqual(late.words, ['three', 'four', 'five', 'six', 'seven', 'whale']);
    assert.deepEqual(snippetTarget([], 'q').words, []);
  });

  it('prefers the block with the query\'s words over the snippet\'s place in a contents list', () => {
    const blocks = [
      p('CHAPTER 3. The Spouter-Inn. CHAPTER 110. Queequeg in His Coffin. CHAPTER 111.'),
      p('He took up his harpoon, and shaved with it as with a razor; Queequeg was at home.'),
      p('Queequeg again.'),
    ];
    const target = snippetTarget([['...110. ', 0], ['Queequeg', 1], [' in His Coffin. CHAPTER 111...', 0]], 'Queequeg harpoon razor');
    assert.deepEqual(findInBlocks(blocks, target), { b: 1, exact: false, score: 31 });
    // Without the query, the snippet's words in a row decide.
    assert.equal(findInBlocks(blocks, { ...target, terms: [] }).b, 0);
    assert.equal(topScore(target), 36);
  });

  it('allows other endings of a query word, starts at `from` and gives null for no match', () => {
    const blocks = [p('Harpooneers and whales.'), p('Nothing here.'), p('The harpoons were sharp.')];
    assert.equal(findInBlocks(blocks, { words: [], hits: [], terms: ['harpoon'] }).b, 0);
    assert.equal(findInBlocks(blocks, { words: [], hits: [], terms: ['harpoon'] }, 1).b, 2);
    assert.equal(findInBlocks(blocks, { words: ['no', 'such'], hits: ['zebra'], terms: ['zebra'] }), null);
  });
});

const SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <channel>
    <title>Search: white whale</title>
    <link>/search?pattern=white%20whale&amp;books.id=x&amp;format=xml</link>
    <description>Search result for white whale</description>
    <opensearch:totalResults>4,000</opensearch:totalResults>
    <item>
      <title>Moby-Dick (1851) US edition/Chapter 41</title>
      <link>/content/wikisource_en_all_maxi_2026-09/Moby-Dick_(1851)_US_edition/Chapter_41</link>
      <description>...secluded <b>White</b> <b>Whale</b> had haunted those &lt;uncivilized&gt; seas...</description>
      <book><title>Wikisource</title></book>
      <wordCount>3,776</wordCount>
    </item>
    <item>
      <title>Moby-Dick; or, The Whale.15.html</title>
      <link>/content/gutenberg_en_all/Moby-Dick%3B%20or%2C%20The%20Whale.15.html</link>
      <description><b>WHALE</b>. by Herman Melville</description>
      <wordCount>212,656</wordCount>
    </item>
  </channel>
</rss>`;

describe('kiwix-serve answers (server/kiwix-serve.js)', () => {
  it('decodes entities, dashes UUIDs and splits snippets at their hits', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#233; &#x2014; &apos;q&apos; &bogus;'), "a & b <c> é — 'q' &bogus;");
    assert.equal(dashedUuid('e291b2f152cd92a14cdcc955aed4a954'), 'e291b2f1-52cd-92a1-4cdc-c955aed4a954');
    assert.deepEqual(snippetParts('...a <b>White</b>  <i>Whale</i> &amp; <B>more</B>'), [['...a ', 0], ['White', 1], [' Whale & ', 0], ['more', 1]]);
  });

  it('reads a search answer: total, titles, ZIM paths, snippets and word counts', () => {
    const { total, results } = parseSearchXml(SEARCH_XML);
    assert.equal(total, 4000, 'kiwix-serve writes it with thousands separators');
    assert.deepEqual(results.map((r) => [r.title, r.path, r.words]), [
      ['Moby-Dick (1851) US edition/Chapter 41', 'Moby-Dick_(1851)_US_edition/Chapter_41', 3776],
      ['Moby-Dick; or, The Whale.15.html', 'Moby-Dick; or, The Whale.15.html', 212656],
    ]);
    assert.deepEqual(results[0].snippet, [['...secluded ', 0], ['White', 1], [' ', 0], ['Whale', 1], [' had haunted those <uncivilized> seas...', 0]]);
  });

  it('asks for the books it serves once a minute and searches one by its UUID', async () => {
    const asked = [];
    const fetch = async (url) => {
      asked.push(url);
      if (url.includes('/catalog/')) return new Response('<feed><entry><id>urn:uuid:e291b2f1-52cd-92a1-4cdc-c955aed4a954</id></entry></feed>');
      return new Response(SEARCH_XML);
    };
    const k = kiwixServe('http://pi:8095', { fetch });
    assert.equal(k.url, 'http://pi:8095/');
    assert.deepEqual([...await k.books()], ['e291b2f152cd92a14cdcc955aed4a954']);
    await k.books();
    assert.equal(asked.length, 1, 'the list is kept');
    const found = await k.search('e291b2f152cd92a14cdcc955aed4a954', 'white whale', { start: 5, limit: 3 });
    assert.equal(found.results.length, 2);
    assert.equal(asked[1], 'http://pi:8095/search?books.id=e291b2f1-52cd-92a1-4cdc-c955aed4a954&pattern=white%20whale&format=xml&start=5&pageLength=3');
    const down = kiwixServe('http://pi:8095/', { fetch: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal((await down.books()).size, 0, 'unreachable: no books, not an error');
  });
});

/** Requests over HTTP: { status, json }. */
function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject);
  });
}

describe('full-text routes with kiwix-serve (HTTP)', () => {
  let library;
  let server;
  let port;
  const searches = [];
  before(async () => {
    const dir = path.join(tmp, 'zims');
    fs.mkdirSync(dir);
    writeGutenbergZim(path.join(dir, 'gutenberg.zim'));
    writeWikisourceZim(path.join(dir, 'wikisource.zim'));
    library = await Library.scan(dir, { log: () => {}, cacheDir: path.join(tmp, 'cache') });
    const gutenberg = library.get('gutenberg');
    const wikisource = library.get('wikisource');
    await gutenberg.books();
    await ready(wikisource);
    // A stand-in for kiwix-serve: it serves the Gutenberg and Wikisource files, with fixed hits.
    const answers = new Map([
      [gutenberg.archive.header.uuid, { total: 2, results: [
        { title: 'Gamma.101', path: 'Alpha-Beta/Gamma.101', snippet: [['Body of ', 0], ['Alpha', 1]], words: 4 },
        { title: 'nothing', path: 'covers/101_cover_image.jpg', snippet: [], words: null },
      ] }],
      [wikisource.archive.header.uuid, { total: 1, results: [
        { title: 'The Grey House/Chapter 2', path: 'The_Grey_House/Chapter_2', snippet: [['The ', 0], ['morning', 1], [' came.', 0]], words: 3 },
      ] }],
    ]);
    const kiwix = {
      url: 'http://kiwix/',
      books: async () => new Set(answers.keys()),
      search: async (uuid, q, opts) => {
        searches.push({ uuid, q, opts });
        return answers.get(uuid);
      },
    };
    server = http.createServer(createApp(library, { log: () => {}, kiwix }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await library?.close();
  });

  it('marks the libraries kiwix-serve also serves', async () => {
    const { json } = await getJSON(port, '/api/libraries');
    assert.deepEqual(json.libraries.map((l) => [l.id, l.fulltext ?? false]).sort(), [['gutenberg', true], ['wikisource', true]]);
  });

  it('lists hits with their book, snippet and what to look for; drops what is no book', async () => {
    const { status, json } = await getJSON(port, '/api/libraries/gutenberg/text?q=alpha&limit=99');
    assert.equal(status, 200);
    assert.equal(searches.at(-1).opts.limit, 50, 'at most 50');
    assert.equal(json.total, 2);
    assert.equal(json.unplaced, 1, 'a cover is no book');
    const [hit] = json.results;
    assert.equal(hit.title, 'Alpha/Beta/Gamma', 'the book\'s title, not the file name');
    assert.equal(hit.author, 'Ann Author');
    assert.deepEqual(hit.to, { book: '101', c: 0, b: 0 });
    assert.equal(hit.path, 'C/Alpha-Beta/Gamma.101');
    assert.deepEqual(hit.find, { words: ['body', 'of', 'alpha'], hits: ['alpha'], terms: ['alpha'] });
  });

  it('finds the block of a hit, from a Wikisource part', async () => {
    const { json: list } = await getJSON(port, '/api/libraries/wikisource/text?q=morning');
    const [hit] = list.results;
    assert.equal(hit.to.c, 0, 'the work, its part placed when opened');
    const q = `path=${encodeURIComponent(hit.path)}&t=morning&w=the%20morning%20came&h=morning`;
    const { status, json } = await getJSON(port, `/api/libraries/wikisource/books/${encodeURIComponent(hit.to.book)}/find?${q}`);
    assert.equal(status, 200);
    assert.equal(json.at.exact, true);
    const lib = library.get('wikisource');
    const blocks = (await lib.chunk(hit.to.book, json.at.c)).blocks;
    assert.match(blockText(blocks[json.at.b]), /The morning came/);
    // A Gutenberg book is read from its start.
    const { json: g } = await getJSON(port, '/api/libraries/gutenberg/books/101/find?t=alpha&w=body%20of%20alpha&h=alpha');
    assert.deepEqual(g.at, { c: 0, b: 1, exact: true });
  });

  it('says why when there is no full-text search', async () => {
    const plain = http.createServer(createApp(library, { log: () => {} }));
    await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
    try {
      const { status, json } = await getJSON(plain.address().port, '/api/libraries/gutenberg/text?q=x');
      assert.equal(status, 404);
      assert.match(json.error, /--kiwix-serve/);
      const { json: libs } = await getJSON(plain.address().port, '/api/libraries');
      assert.ok(libs.libraries.every((l) => !('fulltext' in l)));
    } finally {
      plain.closeAllConnections();
      await new Promise((resolve) => plain.close(resolve));
    }
  });
});

describe('placing a page (ArchiveLibrary.placeOf)', () => {
  it('places Gutenberg pages by their number, and Wikisource parts exactly or by their work', async () => {
    const dir = path.join(tmp, 'place');
    fs.mkdirSync(dir);
    writeGutenbergZim(path.join(dir, 'g.zim'));
    writeWikisourceZim(path.join(dir, 'w.zim'));
    const library = await Library.scan(dir, { log: () => {}, cacheDir: path.join(tmp, 'cache2') });
    try {
      const g = library.get('g');
      assert.deepEqual(await g.placeOf('C/Alpha-Beta/Gamma.101'), { book: '101', c: 0, b: 0 });
      assert.deepEqual(await g.placeOf('C/Whatever.102.html'), { book: '102', c: 0, b: 0 });
      assert.equal(await g.placeOf('C/Alpha-Beta/Gamma.101.epub'), null);
      assert.equal(await g.placeOf('C/Unknown.999'), null);
      const w = library.get('w');
      await ready(w);
      const coarse = await w.placeOf('C/The_Grey_House/Chapter_2', { exact: false });
      assert.deepEqual({ c: coarse.c, b: coarse.b }, { c: 0, b: 0 });
      const exact = await w.placeOf('C/The_Grey_House/Chapter_2');
      assert.equal(exact.book, coarse.book);
      assert.ok(exact.b > 0, 'the part, not the work\'s start');
    } finally {
      await library.close();
    }
  });
});
