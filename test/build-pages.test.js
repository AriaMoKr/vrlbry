// The GitHub Pages build (tools/build-pages.mjs): the client without the Node server, under a path.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blockImages, importsOf, prerender, relativeUrls, staticPath } from '../tools/build-pages.mjs';
import { writeZim } from './helpers/zimwriter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let out;
before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-pages.mjs'), '--out', out], { cwd: ROOT });
});
after(() => fs.rmSync(out, { recursive: true, force: true }));

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000c80000012c00000000', 'hex'); // 200×300 header
const page = (title, body) => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

/** A ZIM without a Gutenberg index (its articles are the books), with an image whose path needs encoding. */
function writeDocsZim(file) {
  writeZim(file, {
    scheme: 'new',
    mainPage: 'C/index.html',
    entries: [
      { ns: 'C', url: 'index.html', title: 'Main Page', mime: 'text/html', content: page('Main', '<p>Welcome.</p>') },
      { ns: 'C', url: 'guide.html', title: 'A Guide', mime: 'text/html', content: page('A Guide', '<p>See <img src="img/a%20b.png" alt="ab"></p>') },
      { ns: 'C', url: 'img/a b.png', mime: 'image/png', content: png },
      { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Docs' },
    ],
  });
}

/** A miniature mwoffliner-like Wikipedia: articles with an image, one volume. */
function writeWikipediaZim(file) {
  const A = (url, title) => ({
    ns: 'C', url, title, mime: 'text/html',
    content: page(title, `<p>About ${title}.</p><figure><img src="./_assets_/pic.png" width="200" height="300"></figure>`).padEnd(1500, ' '),
  });
  writeZim(file, {
    scheme: 'new',
    mainPage: 'C/Main_Page',
    entries: [
      A('Main_Page', 'Main Page'), A('Banana', 'Banana'), A('Bandana', 'Bandana'), A('The_Band', 'The Band'), A('Apple', 'Apple'),
      { ns: 'C', url: '_assets_/pic.png', mime: 'image/png', content: png },
      { ns: 'M', url: 'Source', mime: 'text/plain', content: 'en.wikipedia.org' },
      { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Wikipedia Test' },
      { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: png },
    ],
  });
}

/** Every file under dir, relative, with forward slashes. */
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? files(path.join(dir, e.name), base)
    : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
}

describe('GitHub Pages build', () => {
  it('reads static, dynamic and re-exported imports, not those in comments', () => {
    const src = `import a from './a.js';\nimport './side.js';\nexport { b } from '../b.js';\nconst c = await import('./c.js');
      /* import { no } from './block.js'; */\n// import x from './line.js';\nimport * as THREE from 'three';`;
    assert.deepEqual(importsOf(src).sort(), ['../b.js', './a.js', './c.js', './side.js', 'three']);
  });

  it('builds the client, the vendor files it imports, and static API answers', () => {
    const all = files(out);
    assert.ok(all.includes('index.html') && all.includes('.nojekyll'));
    assert.ok(!all.some((f) => f.startsWith('dev/') || f === 'reader-test.html'), 'pages that need the server are left out');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'api', 'libraries'), 'utf8')), { generation: 0, libraries: [], static: true });
    const version = JSON.parse(fs.readFileSync(path.join(out, 'api', 'version'), 'utf8'));
    assert.equal(version.static, true);
    assert.ok(!Number.isNaN(Date.parse(version.changed)));
    for (const f of ['vendor/three/build/three.module.js', 'vendor/three/build/three.core.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js', 'vendor/iwer/iwer.module.js']) {
      assert.ok(all.includes(f), f);
    }
    // Under a path (https://<user>.github.io/vrlbry/), nothing may be addressed from the root.
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!/(?:href|src)="\//.test(html), 'no root-relative href/src');
    assert.ok(html.includes('"three":"./vendor/three/build/three.module.js"'));
    // Every relative import of every module resolves to a file that was built.
    for (const f of all.filter((x) => x.endsWith('.js'))) {
      for (const spec of importsOf(fs.readFileSync(path.join(out, f), 'utf8'))) {
        if (spec.startsWith('/')) assert.fail(`${f} imports ${spec} from the root`);
        if (!spec.startsWith('.')) continue;
        const target = path.relative(out, path.resolve(path.dirname(path.join(out, f)), spec)).split(path.sep).join('/');
        assert.ok(all.includes(target), `${f} → ${spec}`);
      }
    }
  });
});

describe('GitHub Pages build: pre-rendered ZIMs (--zims)', () => {
  let site;
  let zims;
  let stats;
  before(async () => {
    zims = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-zims-'));
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-site-'));
    writeDocsZim(path.join(zims, 'docs.zim'));
    writeWikipediaZim(path.join(zims, 'wp.zim'));
    stats = await prerender(zims, site, { log: () => {} });
  });
  after(() => {
    fs.rmSync(zims, { recursive: true, force: true });
    fs.rmSync(site, { recursive: true, force: true });
  });
  const read = (file) => fs.readFileSync(path.join(site, ...file.split('/')), 'utf8');
  const exists = (url) => fs.existsSync(path.join(site, ...url.split('/').map(decodeURIComponent)));

  it('maps server URLs to the static site’s', () => {
    assert.equal(staticPath('/zim/wp/C/_assets_/a%20b.png'), 'zim/wp/C/_assets_/a%20b.png');
    assert.equal(staticPath('/api/libraries/wp/books/v1'), 'api/library/wp/books/v1');
    assert.equal(relativeUrls('{"src":"/zim/x/C/a.png","u":"/api/libraries/x/books","t":"a /zim/ path in text"}'),
      '{"src":"zim/x/C/a.png","u":"api/library/x/books","t":"a /zim/ path in text"}');
    const blocks = [
      { t: 'img', src: '/zim/a.png' },
      { t: 'p', r: [['x', 0], ['￼', 0, { src: '/zim/f.svg', w: 2, h: 2 }]] },
      { t: 'tr', c: [[['￼', 0, { src: '/zim/cell.png', w: 1, h: 1 }]], [['y', 0]]] },
    ];
    assert.deepEqual([...blockImages(blocks)].sort(), ['/zim/a.png', '/zim/cell.png', '/zim/f.svg']);
  });

  it('saves every answer the client asks for, with relative URLs, and every image', () => {
    assert.equal(stats.libraries, 2);
    const catalogText = read('api/libraries');
    assert.ok(!catalogText.includes('"/'), 'no URL from the root');
    const catalog = JSON.parse(catalogText);
    assert.equal(catalog.static, true);
    assert.deepEqual(catalog.libraries.map((l) => [l.id, l.kind]).sort(), [['docs', 'generic'], ['wp', 'wikipedia']]);
    let chunks = 0;
    const images = new Set();
    for (const lib of catalog.libraries) {
      if (lib.illustration) images.add(lib.illustration);
      const { books } = JSON.parse(read(`api/library/${lib.id}/books.json`));
      assert.ok(books.length, lib.id);
      for (const b of books) {
        for (const u of [b.cover, b.emblem]) if (u) images.add(u);
        if (!b.readable) continue;
        const metaText = read(`api/library/${lib.id}/books/${b.id}/index.json`);
        assert.ok(!metaText.includes('"/zim/'), 'no URL from the root');
        for (let n = 0; n < JSON.parse(metaText).chunks.length; n++) {
          const text = read(`api/library/${lib.id}/books/${b.id}/chunks/${n}.json`);
          assert.ok(!text.includes('"/zim/'), 'no URL from the root');
          blockImages(JSON.parse(text).blocks, images);
          chunks++;
        }
      }
    }
    assert.equal(chunks, stats.chunks);
    assert.ok([...images].some((u) => u.includes('a%20b.png')), 'the encoded image path is referred to');
    assert.ok([...images].some((u) => u.includes('_assets_/pic.png')));
    for (const u of images) {
      assert.ok(u.startsWith('zim/'), u);
      assert.ok(exists(u), `${u} is saved (decoded, as Pages looks it up)`);
    }
    assert.deepEqual(JSON.parse(read('api/library/wp/titles.json')), {
      volumeSize: 1000, titles: ['Apple', 'Banana', 'The Band', 'Bandana'],
    });
    assert.ok(!fs.existsSync(path.join(site, 'api', 'library', 'docs', 'titles.json')), 'only Wikipedia has a title list');
  });

  it('serves the client in static mode: the same API, answered by files, and article search in the browser', async () => {
    const publicUrl = `${pathToFileURL(path.join(ROOT, 'public')).href}/`;
    const asked = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.ok(url.startsWith(publicUrl), url);
      const rel = url.slice(publicUrl.length);
      asked.push(rel);
      const file = path.join(site, ...rel.split('/').map(decodeURIComponent));
      if (!fs.existsSync(file)) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      const text = fs.readFileSync(file, 'utf8');
      return { ok: true, json: async () => JSON.parse(text), text: async () => text };
    };
    try {
      const api = await import('../public/js/api.js');
      const catalog = await api.getCatalog();
      assert.equal(catalog.static, true);
      const books = await api.getBooks('wp');
      assert.equal(books[0].id, 'v1');
      const meta = await api.getBookMeta('wp', 'v1');
      assert.deepEqual(meta.toc.map((t) => t.title), ['Apple', 'Banana', 'The Band', 'Bandana']);
      const blocks = await api.getChunk('wp', 'v1', 1);
      assert.deepEqual(blocks[0], { t: 'h', l: 1, r: [['Banana', 0]] });
      // Search by title key, like the server: "The" and case are ignored, and the position in the
      // title order gives the volume and article.
      assert.deepEqual(await api.searchArticles('wp', ' BAN ', 8), [
        { title: 'Banana', book: 'v1', n: 1 }, { title: 'The Band', book: 'v1', n: 2 }, { title: 'Bandana', book: 'v1', n: 3 },
      ]);
      assert.deepEqual((await api.searchArticles('wp', 'band', 8)).map((a) => a.title), ['The Band', 'Bandana']);
      assert.deepEqual((await api.searchArticles('wp', 'bandana', 1)).map((a) => a.title), ['Bandana']);
      assert.deepEqual(await api.searchArticles('wp', 'kiwi', 8), []);
      assert.deepEqual(asked, [
        'api/libraries', 'api/library/wp/books.json', 'api/library/wp/books/v1/index.json',
        'api/library/wp/books/v1/chunks/1.json', 'api/library/wp/titles.json',
      ], 'the title list is fetched once');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
