// ZIMs over HTTP range requests (core/zim/http-source.js, milestone 3): the same archive read
// from a local server as from the file, and what a source does when the server does not serve
// ranges, fails for a while, or the file changes under it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import '../server/platform-node.js';
import { ArchiveLibrary } from '../public/js/core/library.js';
import { HttpSource, HttpSourceError } from '../public/js/core/zim/http-source.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import { startRangeServer } from './helpers/range-server.js';
import { writeGutenbergZim, writeWikipediaZim } from './helpers/zim-fixtures.js';

let tmp;
let server;
let base;
let requests;
/** Serves a file at a new path: { url, route } (helpers/range-server.js). */
const serve = (file, opts) => server.serve(file, opts);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-http-'));
  server = await startRangeServer();
  ({ base, requests } = server);
});

after(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ZIMs over HTTP (HttpSource)', () => {
  it('reads an archive through range requests as from the file', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'gutenberg.zim')).filePath;
    const { url } = serve(file);
    const fromFile = await ArchiveLibrary.open(file, { log: () => {} });
    const fromUrl = await ArchiveLibrary.open(url, { log: () => {} });
    try {
      assert.equal(fromUrl.archive.fileSize, fs.statSync(file).size);
      assert.equal(fromUrl.archive.filePath, 'gutenberg.zim', 'named by the URL\'s file name');
      assert.deepEqual(await fromUrl.books(), await fromFile.books());
      for (const b of await fromFile.books()) {
        if (!b.readable) continue;
        const [x, y] = [await fromFile.content(b.id), await fromUrl.content(b.id)];
        assert.deepEqual(y.meta, x.meta, b.id);
        for (let c = 0; c < x.meta.chunks.length; c++) {
          assert.deepEqual(Buffer.from((await fromUrl.chunk(b.id, c)).json), Buffer.from((await fromFile.chunk(b.id, c)).json));
        }
      }
      const stats = fromUrl.archive._source.stats;
      assert.ok(stats.reads > 0 && stats.bytes < fs.statSync(file).size * 2, `${stats.reads} reads, ${stats.bytes} bytes`);
    } finally {
      await fromFile.close();
      await fromUrl.close();
    }
  });

  it('indexes a Wikipedia over HTTP, with a bigger block size', async () => {
    const file = writeWikipediaZim(path.join(tmp, 'wikipedia.zim')).filePath;
    const { url } = serve(file);
    const lib = await ArchiveLibrary.open(url, { log: () => {}, archiveOptions: { blockBytes: 256 * 1024 } });
    try {
      for (let i = 0; i < 500 && (await lib.info()).indexing; i++) await new Promise((r) => setTimeout(r, 10));
      const books = await lib.books();
      assert.equal(books.length, 1);
      assert.equal((await lib.searchArticles('ap', 3))[0].title, 'apple');
      assert.match(new TextDecoder().decode((await lib.chunk('v1', 1)).json), /A small insect/);
    } finally {
      await lib.close();
    }
  });

  it('calls fetch as a browser allows: not as a method of the source', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g0.zim')).filePath;
    const { url } = serve(file);
    const nodeFetch = globalThis.fetch;
    // A browser's fetch throws "Illegal invocation" when `this` is another object.
    globalThis.fetch = function (input, init) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return nodeFetch(input, init);
    };
    try {
      const src = await HttpSource.open(url);
      assert.equal((await src.read(0, 4)).length, 4);
      await src.close();
    } finally {
      globalThis.fetch = nodeFetch;
    }
  });

  it('uses the browser cache for a read on its own, not for reads made together (it would queue them) nor the probe', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g7.zim')).filePath;
    const { url } = serve(file);
    const modes = [];
    const recording = (u, init) => {
      modes.push(init?.cache ?? 'default');
      return fetch(u, init);
    };
    const src = await HttpSource.open(url, { fetch: recording });
    await src.read(0, 10);
    await src.read(100, 10);
    assert.deepEqual(modes, ['no-store', 'default', 'default'], 'the probe (it decides the edition), then two reads one after another');
    modes.length = 0;
    await Promise.all([0, 1, 2, 3].map((k) => src.read(k * 1000, 10)));
    assert.deepEqual(modes, ['no-store', 'no-store', 'no-store', 'no-store']);
    modes.length = 0;
    await src.read(5000, 10);
    assert.deepEqual(modes, ['default'], 'alone again');
    await src.close();
  });

  it('asks again past the browser cache when it answers a changed file\'s whole, or a short part', async () => {
    // Chrome completes a range it holds part of with If-Range and the old version's tag; once the
    // file changed (a deploy re-uploads the site's ZIMs) the server sends the whole file (200), or
    // Chrome answers a 206 with fewer bytes than it says. Past the cache (no-store) all is well.
    const file = writeGutenbergZim(path.join(tmp, 'g8.zim')).filePath;
    const { url } = serve(file);
    const data = fs.readFileSync(file);
    const modes = [];
    let cached = 'whole'; // what the "browser cache" does to a default-mode request
    const browser = async (u, init) => {
      modes.push(init?.cache ?? 'default');
      if (init?.cache === 'no-store' || init?.method === 'HEAD') return fetch(u, init);
      const [a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).slice(1).map(Number);
      if (cached === 'whole') return new Response(data, { status: 200 });
      return new Response(data.subarray(a, a + Math.floor((b - a + 1) / 2)), { // half of it
        status: 206, headers: { 'content-range': `bytes ${a}-${b}/${data.length}` },
      });
    };
    const src = await HttpSource.open(url, { fetch: browser });
    assert.deepEqual(modes, ['no-store'], 'the probe, past the cache: it decides the edition');
    modes.length = 0;
    assert.deepEqual(await src.read(100, 50), new Uint8Array(data.subarray(100, 150)));
    cached = 'short';
    assert.deepEqual(await src.read(300, 40), new Uint8Array(data.subarray(300, 340)), 'not the short answer');
    assert.deepEqual(modes, ['default', 'no-store', 'default', 'no-store']);
    assert.equal(src.stats.uncached, 2);
    // An answer of the edition before, from the cache (fresh there for minutes): asked past it.
    cached = 'old';
    const old = (u, init) => (init?.cache === 'no-store' ? browser(u, init)
      : fetch(u, init).then((r) => new Response(r.body, { status: r.status, headers: { 'content-range': r.headers.get('content-range'), 'last-modified': 'Sat, 01 Jan 2000 00:00:00 GMT' } })));
    src._fetch = old;
    modes.length = 0;
    assert.deepEqual(await src.read(500, 20), new Uint8Array(data.subarray(500, 520)));
    assert.equal(src.stats.uncached, 3);
    await src.close();
    // A server that really sends whole files still says so.
    const whole = await HttpSource.open(url, { fetch: async () => new Response(data, { status: 200 }) }).catch((err) => err);
    assert.match(whole.message, /does not serve parts of the file/);
  });

  it('finds the size with a HEAD when Content-Range cannot be read', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g2.zim')).filePath;
    const { url } = serve(file, { mode: 'no-content-range' });
    const src = await HttpSource.open(url);
    assert.equal(src.size, fs.statSync(file).size);
    assert.ok(requests.some((r) => r.method === 'HEAD' && r.url.endsWith('/g2.zim')));
    const zim = await ZimArchive.open(src);
    assert.ok(zim.entryCount > 0);
    await zim.close();
  });

  it('refuses a server that does not serve ranges, and a missing file', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g3.zim')).filePath;
    await assert.rejects(HttpSource.open(serve(file, { mode: 'no-ranges' }).url), (err) => err instanceof HttpSourceError && /does not serve parts of the file/.test(err.message));
    await assert.rejects(HttpSource.open(`${base}/nowhere.zim`), (err) => err.status === 404 && /HTTP 404 \(not found\)/.test(err.message));
    await assert.rejects(ZimArchive.open(`${base}/nowhere.zim`), /cannot open .*nowhere\.zim: .*404/);
  });

  it('tries again while the server fails for a while, and gives up after its retries', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g4.zim')).filePath;
    const busy = serve(file, { failures: 2 });
    const src = await HttpSource.open(busy.url, { retries: 3 });
    assert.equal(src.stats.retries, 2);
    const down = serve(file, { failures: 99 });
    await assert.rejects(HttpSource.open(down.url, { retries: 1 }), (err) => err.status === 503);
  });

  it('notices a file replaced on the server (a new edition at the same URL)', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g5.zim')).filePath;
    const { url, route } = serve(file);
    const src = await HttpSource.open(url);
    assert.equal((await src.read(0, 4)).length, 4);
    route.lastModified = 'Sun, 11 Oct 2026 00:00:00 GMT';
    await assert.rejects(src.read(100, 10), /the file changed on the server/);
    // A different size says so too.
    const other = writeWikipediaZim(path.join(tmp, 'g5b.zim')).filePath;
    route.lastModified = 'Sat, 10 Oct 2026 00:00:00 GMT';
    const src2 = await HttpSource.open(url);
    route.file = other;
    await assert.rejects(src2.read(0, 10), /its size is now/);
  });

  it('keeps to its limit of requests at once, and stops on close', async () => {
    const file = writeGutenbergZim(path.join(tmp, 'g6.zim')).filePath;
    const { url } = serve(file);
    let inFlight = 0;
    let most = 0;
    const counting = async (u, init) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await fetch(u, init);
      } finally {
        inFlight--;
      }
    };
    const src = await HttpSource.open(url, { fetch: counting, maxInFlight: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => src.read(i * 100, 50)));
    assert.equal(most, 2);
    const pending = src.read(0, 10);
    await src.close();
    await assert.rejects(pending, /closed/);
    await assert.rejects(src.read(0, 10), /closed/);
  });
});
