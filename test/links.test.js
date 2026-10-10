// Links in books (SPEC §3.5): a Wikipedia's links to its own places (references, sections) and to
// other articles, resolved when followed (resolveLink, the HTTP link route) through ZIM redirects
// and mwoffliner's redirects to a section; a Wikisource work's links to its parts and to other
// works; and the static build, which resolves them all beforehand.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveLibrary, Library } from '../server/library.js';
import { createApp } from '../server/http.js';
import { resolveLinks } from '../tools/build-pages.mjs';
import { redirectPage, writeWikisourceZim } from './helpers/zim-fixtures.js';
import { writeZim } from './helpers/zimwriter.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-links-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** An mwoffliner-like article, padded so that the index takes it for one (not a redirect page). */
const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body>
<div id="mw-content-text"><div class="mw-parser-output">${body}</div></div></body></html>`.padEnd(1500, ' ');

/**
 * Ant links to an article (Insect), a ZIM redirect (Beetles → Beetle), a redirect to a section
 * (Bee_stripes → Bee#Stripes), its own reference and section, itself, a page that is not there
 * and the web. Volumes of two: v1 = Ant, Bee; v2 = Beetle, Insect.
 */
function writeLinksZim(file) {
  const A = (url, body) => ({ ns: 'C', url, title: url.replace(/_/g, ' '), mime: 'text/html', content: page(url, body) });
  return writeZim(file, {
    scheme: 'new', mainPage: 'C/Main_Page',
    entries: [
      A('Main_Page', '<p>Welcome.</p>'),
      A('Ant', `<p>Ants are <a href="Insect" title="Insect">insects</a> like <a href="Beetles" class="mw-redirect">beetles</a>
        and <a href="Bee_stripes">striped bees</a>.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>
        See <a href="#Notes">the notes</a>, not <a href="Ant" class="mw-selflink">itself</a>, <a href="Missing">a missing page</a>
        or <a href="https://example.org/" class="external">the web</a>.</p>
        <section id="mwAg"><h2 id="Notes">Notes</h2><ol class="references"><li id="cite_note-1">A note.</li></ol></section>`),
      A('Bee', '<p>Bees fly.</p><h2 id="Stripes">Stripes</h2><p>Black and yellow.</p>'),
      A('Beetle', '<p>Beetles crawl.</p>'),
      A('Insect', '<p>Six legs.</p>'),
      { ns: 'C', url: 'Beetles', redirectTo: 'C/Beetle' },
      { ns: 'C', url: 'Bee_stripes', title: 'Bee stripes', mime: 'text/html', content: redirectPage('Bee stripes', 'Bee#Stripes') },
      { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
      { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikipedia Links' },
      { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    ],
  });
}

async function ready(lib) {
  for (let i = 0; i < 1500; i++) { // up to 30 s: the suite's files run at once
    if ((await lib.books()).length && !(await lib.info()).indexing) return lib;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the index was not built');
}

const text = (b) => (b.r ?? []).map((r) => r[0]).join('');
/** The link object of the run with this text, or undefined (a plain run: none). */
const linkOf = (blocks, words) => blocks.flatMap((b) => b.r ?? []).find((r) => r[0] === words)?.[2];

describe('links in a Wikipedia', () => {
  let lib;
  before(async () => {
    const file = path.join(tmp, 'links.zim');
    writeLinksZim(file);
    lib = await ready(await ArchiveLibrary.open(file, { id: 'wl', cacheDir: path.join(tmp, 'cache'), volumeSize: 2, log: () => {} }));
  });
  after(() => lib?.close());

  it('converts an article\'s own places to at: [chunk, block] and keeps its links to other pages', async () => {
    assert.deepEqual((await lib.books()).map((b) => [b.id, b.articles]), [['v1', 2], ['v2', 2]]);
    const { blocks } = await lib.chunk('v1', 0); // Ant
    assert.equal(text(blocks[0]), 'Ant');
    const block = (at) => (assert.equal(at[0], 0, 'in the article\'s own chunk'), blocks[at[1]]);
    assert.equal(text(block(linkOf(blocks, '[1]').at)), 'A note.', 'a reference');
    assert.equal(text(block(linkOf(blocks, 'the notes').at)), 'Notes', 'a section');
    assert.deepEqual(linkOf(blocks, 'insects'), { href: 'C/Insect' }, 'resolved when followed');
    assert.deepEqual(linkOf(blocks, 'beetles'), { href: 'C/Beetles' });
    assert.deepEqual(linkOf(blocks, 'striped bees'), { href: 'C/Bee_stripes' });
    assert.deepEqual(linkOf(blocks, 'a missing page'), { href: 'C/Missing' }, 'only following it can tell');
    const plain = blocks.flatMap((b) => b.r ?? []).filter((r) => /itself|the web/.test(r[0]));
    assert.ok(plain.length && plain.every((r) => r.length === 2), 'no link to the article itself or to the web');
  });

  it('resolves links when followed: articles, redirects, redirects to a section; nothing else', async () => {
    assert.deepEqual(await lib.resolveLink('v1', 'C/Insect'), { book: 'v2', c: 1 });
    assert.deepEqual(await lib.resolveLink('v1', 'C/Beetles'), { book: 'v2', c: 0 }, 'a ZIM redirect');
    assert.deepEqual(await lib.resolveLink('v1', 'C/Bee_stripes'), { book: 'v1', c: 1, f: 'Stripes' }, 'mwoffliner\'s redirect to a section');
    assert.deepEqual(await lib.resolveLink('v2', 'C/Bee#Stripes'), { book: 'v1', c: 1, f: 'Stripes' });
    for (const href of ['C/Missing', 'C/Main_Page', '#Notes', '', 'X/Ant']) assert.equal(await lib.resolveLink('v1', href), null, href);
    assert.equal(await lib.resolveLink('v9', 'C/Insect'), null, 'an unknown book');
    // The section the link names is a heading's id in the chunk it leads to (what the reader looks for).
    const { blocks } = await lib.chunk('v1', 1);
    assert.equal(text(blocks.find((b) => b.id === 'Stripes')), 'Stripes');
  });

  it('answers the link route (§4): where a link leads, 404 when it leads nowhere', async () => {
    const dir = path.join(tmp, 'served');
    fs.mkdirSync(dir);
    writeLinksZim(path.join(dir, 'wl.zim'));
    const library = await Library.scan(dir, { log: () => {}, cacheDir: path.join(tmp, 'served-cache') });
    const server = http.createServer(createApp(library, { log: () => {} }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await ready(library.get('wl'));
      const route = (book, to) => fetch(`http://127.0.0.1:${server.address().port}/api/libraries/wl/books/${book}/link?to=${encodeURIComponent(to)}`);
      const res = await route('v1', 'C/Bee_stripes');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { library: 'wl', to: { book: 'v1', c: 1, f: 'Stripes' } });
      assert.equal((await route('v1', 'C/Missing')).status, 404);
      assert.equal((await route('v7', 'C/Insect')).status, 404, 'an unknown book');
    } finally {
      server.close();
      await library.close();
    }
  });
});

describe('links in a Wikisource', () => {
  let lib;
  let byTitle;
  before(async () => {
    const file = path.join(tmp, 'ws.zim');
    writeWikisourceZim(file);
    lib = await ready(await ArchiveLibrary.open(file, { id: 'ws', cacheDir: path.join(tmp, 'ws-cache'), log: () => {} }));
    byTitle = new Map((await lib.books()).map((b) => [b.title, b.id]));
  });
  after(() => lib?.close());

  it('links between a work\'s parts lead to the part; others are kept', async () => {
    const grey = byTitle.get('The Grey House');
    const { chunks } = await lib.content(grey);
    const blocks = chunks.flatMap((c) => c.blocks);
    const block = ([c, b]) => chunks[c].blocks[b];
    assert.equal(text(block(linkOf(blocks, 'Chapter 2').at)), 'Chapter 2', 'the contents lead to the part\'s heading');
    assert.equal(text(block(linkOf(blocks, 'the end').at)), 'Chapter 10', 'a part leads to another');
    // "Author:Ann_Example" reads as a URL with a scheme (mwoffliner leaves such links out anyway).
    assert.equal(linkOf(blocks, 'Ann Example'), undefined);
  });

  it('resolves a link to another work, to one of its parts, through a redirect; an author is no work', async () => {
    const grey = byTitle.get('The Grey House');
    const songs = byTitle.get('Songs of Dusk');
    assert.deepEqual(await lib.resolveLink(songs, 'C/The_Grey_House'), { book: grey, c: 0, b: 0 });
    assert.deepEqual(await lib.resolveLink(songs, 'C/Grey_House'), { book: grey, c: 0, b: 0 }, 'a redirect');
    const to = await lib.resolveLink(songs, 'C/The_Grey_House/Chapter_2');
    assert.equal(to.book, grey);
    const { chunks } = await lib.content(grey);
    assert.equal(text(chunks[to.c].blocks[to.b]), 'Chapter 2', 'the part\'s heading');
    assert.equal(await lib.resolveLink(songs, 'C/Author:Ann_Example'), null);
  });
});

describe('static build', () => {
  it('resolves the links a reader would ask about (to), drops those that lead nowhere', async () => {
    const blocks = [
      { t: 'p', r: [['See ', 0], ['Insect', 0, { href: 'C/Insect' }], [' and ', 0], ['Missing', 0, { href: 'C/Missing' }], ['.', 0], ['[1]', 8, { at: [0, 3] }]] },
      { t: 'tr', g: 1, c: [[['￼', 0, { src: '/zim/wl/C/flag.png', w: 20, h: 12, href: 'C/Gone' }]], [['Bee', 0, { href: 'C/Bee' }]]] },
    ];
    const asked = [];
    const changed = await resolveLinks(blocks, async (href) => {
      asked.push(href);
      return { 'C/Insect': { book: 'v2', c: 1 }, 'C/Bee': { book: 'v1', c: 1 } }[href] ?? null;
    });
    assert.equal(changed, true);
    assert.deepEqual(asked, ['C/Insect', 'C/Missing', 'C/Gone', 'C/Bee']);
    assert.deepEqual(blocks[0].r, [['See ', 0], ['Insect', 0, { to: { book: 'v2', c: 1 } }], [' and Missing.', 0], ['[1]', 8, { at: [0, 3] }]]);
    assert.deepEqual(blocks[1].c, [[['￼', 0, { src: '/zim/wl/C/flag.png', w: 20, h: 12 }]], [['Bee', 0, { to: { book: 'v1', c: 1 } }]]]);
    assert.equal(await resolveLinks([{ t: 'p', r: [['x', 0]] }], () => null), false, 'nothing to resolve');
  });
});
