// The edge proxy for ZIMs read from the web (milestone 3 step 7; tools/zim-proxy/worker.js, the
// HTTP source's `via`, zim-url.js zimProxyOf / proxiedUrl, build-pages --zim-proxy): the worker
// relays ranges from the nearest mirror that has the file, and the page reads through it while it
// works and the mirror directly when it does not (optional: never needed).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import '../server/platform-node.js';
import { ArchiveLibrary } from '../public/js/core/library.js';
import { HttpSource, HttpSourceError } from '../public/js/core/zim/http-source.js';
import { proxiedUrl, zimProxyOf } from '../public/js/local/zim-url.js';
import { zimProxyMeta } from '../tools/build-pages.mjs';
import worker, { allowOrigin, handle, MAX_RANGE_BYTES, MIRRORS, mirrorsFor } from '../tools/zim-proxy/worker.js';
import { startRangeServer } from './helpers/range-server.js';
import { writeGutenbergZim } from './helpers/zim-fixtures.js';

const ZIM = 'https://proxy.example/zim/wikipedia/wikipedia_en_x_2026-01.zim';
const LM = 'Fri, 01 May 2026 04:21:47 GMT';

/** A fake of the mirrors: per mirror key, a function of (url, init) → Response, or a status. */
function mirrors(by) {
  const asked = [];
  const fetch = async (url, init) => {
    const key = Object.keys(MIRRORS).find((k) => url.startsWith(MIRRORS[k]));
    asked.push(key);
    const how = by[key] ?? 404;
    if (typeof how === 'function') return how(url, init);
    if (how === 'down') throw new TypeError('fetch failed');
    if (how === 206) {
      return new Response('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/100', 'last-modified': LM, 'content-length': '4', 'x-other': 'no' } });
    }
    return new Response(how === 200 ? 'the whole file' : 'nope', { status: how });
  };
  return { fetch, asked };
}

const get = (url, headers = {}, method = 'GET') => new Request(url, { method, headers });

describe('the edge proxy (tools/zim-proxy/worker.js)', () => {
  it('answers a preflight, and refuses what is not a range of one of Kiwix\'s files', async () => {
    const { fetch, asked } = mirrors({});
    const pre = await handle(get(ZIM, {}, 'OPTIONS'), { fetch });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /Range/);
    const status = async (req) => (await handle(req, { fetch })).status;
    assert.equal(await status(get(ZIM)), 416, 'no Range: no whole files');
    assert.equal(await status(get(ZIM, { range: 'bytes=0-' })), 416, 'an open range');
    assert.equal(await status(get(ZIM, { range: `bytes=0-${MAX_RANGE_BYTES}` })), 416, 'too long');
    assert.equal(await status(get(ZIM, { range: 'bytes=9-3' })), 416);
    assert.equal(await status(get('https://proxy.example/zim/wikipedia/x.html', { range: 'bytes=0-3' })), 404);
    assert.equal(await status(get('https://proxy.example/zim/../etc/x.zim', { range: 'bytes=0-3' })), 404);
    assert.equal(await status(get('https://proxy.example/other/a/b.zim', { range: 'bytes=0-3' })), 404);
    assert.equal(await status(new Request(ZIM, { method: 'POST', body: 'x' })), 405);
    assert.equal(asked.length, 0, 'no mirror was asked');
    const refused = await handle(get(ZIM), { fetch });
    assert.equal(refused.headers.get('access-control-allow-origin'), '*', 'a page can read why');
  });

  it('serves only the pages of its own sites (ALLOWED_ORIGINS), so no other can spend its requests', async () => {
    const SITES = 'https://ariamokr.github.io, http://localhost:*, http://127.0.0.1:*';
    assert.equal(allowOrigin('https://ariamokr.github.io', SITES), 'https://ariamokr.github.io');
    assert.equal(allowOrigin('http://localhost:8080', SITES), 'http://localhost:8080', 'any port');
    assert.equal(allowOrigin('http://localhost', SITES), 'http://localhost');
    assert.equal(allowOrigin('http://127.0.0.1:8097', SITES), 'http://127.0.0.1:8097');
    assert.equal(allowOrigin('https://other.github.io', SITES), null);
    assert.equal(allowOrigin('https://ariamokr.github.io.evil.example', SITES), null);
    assert.equal(allowOrigin('http://localhost.evil.example:80', SITES), null);
    assert.equal(allowOrigin('http://localhost:80x', SITES), null);
    assert.equal(allowOrigin(null, SITES), null, 'no Origin: not a page');
    assert.equal(allowOrigin(null, '*'), '*');
    assert.equal(allowOrigin('https://any.example', '*'), '*');
    // In the Worker: refused before any mirror is asked; allowed, the answer names the page's origin.
    const { fetch, asked } = mirrors({ kiwix: 206 });
    const as = (origin, extra = {}) => handle(get(ZIM, { range: 'bytes=0-3', ...(origin ? { origin } : {}), ...extra }), {
      fetch, continent: 'EU', skipped: new Map(), origins: SITES,
    });
    const refused = await as('https://other.example');
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    assert.equal((await as(null)).status, 403);
    assert.equal(asked.length, 0);
    const ok = await as('https://ariamokr.github.io');
    assert.equal(ok.status, 206);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://ariamokr.github.io');
    assert.equal(ok.headers.get('vary'), 'Origin');
    const pre = await handle(get(ZIM, { origin: 'http://localhost:8080' }, 'OPTIONS'), { origins: SITES });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    // The deployed Worker takes the list from its environment (wrangler.toml [vars]).
    const toml = fs.readFileSync(new URL('../tools/zim-proxy/wrangler.toml', import.meta.url), 'utf8');
    const listed = /^ALLOWED_ORIGINS = "([^"]+)"$/m.exec(toml)?.[1];
    assert.ok(listed && allowOrigin('https://ariamokr.github.io', listed) && !allowOrigin('https://other.example', listed), listed);
    const fromEnv = await worker.fetch(get(ZIM, { range: 'bytes=0-3', origin: 'https://other.example' }), { ALLOWED_ORIGINS: listed });
    assert.equal(fromEnv.status, 403);
  });

  it('asks the mirrors nearest the visitor first', () => {
    assert.equal(mirrorsFor('NA')[0], 'driftlessWi');
    assert.equal(mirrorsFor('EU')[0], 'kiwix');
    assert.equal(mirrorsFor('AS')[0], 'mblibrary');
    assert.equal(mirrorsFor(undefined)[0], 'kiwix', 'unknown: Kiwix\'s own first');
    for (const c of ['NA', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN', undefined]) {
      assert.ok(mirrorsFor(c).includes('kiwix'), `${c}: Kiwix's own mirror, which holds everything, is always tried`);
      assert.ok(mirrorsFor(c).every((k) => MIRRORS[k]), c);
    }
  });

  it('relays a mirror\'s part with CORS headers, passing over mirrors without the file, failing or ignoring the range', async () => {
    let cancelled = 0;
    const whole = () => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024)), cancel: () => { cancelled++; } }), { status: 200 });
    const { fetch, asked } = mirrors({ driftlessWi: 404, driftlessNy: 'down', wikimedia: whole, yourOrg: 206 });
    const skipped = new Map();
    const res = await handle(get(ZIM, { range: 'bytes=0-3' }), { fetch, continent: 'NA', skipped });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), 'abcd');
    assert.deepEqual(asked, ['driftlessWi', 'driftlessNy', 'wikimedia', 'yourOrg']);
    assert.equal(cancelled, 1, 'the whole file was not read');
    assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
    assert.equal(res.headers.get('last-modified'), LM);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-expose-headers'), /Content-Range.*Last-Modified/);
    assert.equal(res.headers.get('x-mirror'), 'ftpmirror.your.org');
    assert.equal(res.headers.get('x-other'), null, 'only what a range read needs');
    // The next read of the file goes straight to the one that answered.
    asked.length = 0;
    await handle(get(ZIM, { range: 'bytes=4-7' }), { fetch, continent: 'NA', skipped });
    assert.deepEqual(asked, ['yourOrg']);
    // Another file is not affected.
    asked.length = 0;
    await handle(get(ZIM.replace('_x_', '_y_'), { range: 'bytes=0-3' }), { fetch, continent: 'NA', skipped });
    assert.equal(asked[0], 'driftlessWi');
    // Passed over only for a while.
    asked.length = 0;
    await handle(get(ZIM, { range: 'bytes=0-3' }), { fetch, continent: 'NA', skipped, now: () => Date.now() + 3600e3 });
    assert.equal(asked[0], 'driftlessWi');
  });

  it('tries a mirror that is too slow no longer than its time, and says when none answered', async () => {
    const slow = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timed out'))));
    const { fetch, asked } = mirrors({ kiwix: slow, nluug: 503 });
    const t = performance.now();
    const res = await handle(get(ZIM, { range: 'bytes=0-3' }), { fetch, continent: 'EU', timeoutMs: 50, skipped: new Map() });
    assert.equal(res.status, 502);
    assert.ok(performance.now() - t < 2000);
    assert.equal(asked.length, mirrorsFor('EU').length, 'every mirror was tried');
    assert.match(await res.text(), /no mirror answered/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('answers a HEAD with the file\'s headers', async () => {
    const { fetch } = mirrors({ kiwix: () => new Response(null, { status: 200, headers: { 'content-length': '100', 'last-modified': LM } }) });
    const res = await handle(get(ZIM, {}, 'HEAD'), { fetch, continent: 'EU', skipped: new Map() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '100');
  });
});

/** Runs the worker's handler as a local HTTP server, its mirrors all fetched from `toMirror`. */
async function startProxy(mirrorFetch) {
  const state = { failFrom: Infinity, seen: 0, mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    state.seen++;
    if (state.mode === 'hide-size' && req.method === 'HEAD') {
      res.writeHead(404);
      return res.end();
    }
    if (state.seen > state.failFrom || state.mode === 'error') {
      res.writeHead(500, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    const headers0 = req.headers.range ? { range: req.headers.range } : {};
    const answer = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: headers0 }), {
      fetch: mirrorFetch, continent: 'NA', skipped: new Map(),
    });
    const headers = Object.fromEntries(answer.headers);
    if (state.mode === 'hide-size') delete headers['content-range'];
    if (state.mode === 'whole') {
      res.writeHead(200, headers);
      return res.end('the whole file, supposedly');
    }
    res.writeHead(answer.status, headers);
    if (answer.body) Readable.fromWeb(answer.body).pipe(res);
    else res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

describe('reading through the proxy (HttpSource via)', () => {
  let tmp;
  let mirror;
  let proxy;
  let file;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-proxy-'));
    mirror = await startRangeServer();
    file = writeGutenbergZim(path.join(tmp, 'gutenberg.zim')).filePath;
    // Every mirror is the range server (its /zim/<n>/<file> paths look like Kiwix's).
    proxy = await startProxy((url, init) => globalThis.fetch(url.replace(/^https:\/\/[^/]+\/(?:.*?\/)?zim\//, `${mirror.base}/zim/`), init));
  });
  after(async () => {
    await proxy.close();
    await mirror.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const via = (url) => url.replace(mirror.base, proxy.base);

  it('reads an archive through it as directly, and stays the file\'s', async () => {
    const { url } = mirror.serve(file);
    proxy.state.mode = 'ok';
    const direct = await ArchiveLibrary.open(url, { log: () => {} });
    const through = await ArchiveLibrary.open(await HttpSource.open(url, { via: via(url) }), { log: () => {} });
    try {
      const src = through.archive._source;
      assert.equal(src.url, url, 'named by the file\'s own address');
      assert.equal(src.via, via(url));
      assert.deepEqual(await through.books(), await direct.books());
      for (const b of (await direct.books()).filter((x) => x.readable)) {
        assert.deepEqual((await through.content(b.id)).meta, (await direct.content(b.id)).meta);
      }
      assert.equal(src.stats.viaReads, src.stats.reads, 'every read went through it');
    } finally {
      await direct.close();
      await through.close();
    }
  });

  it('reads the file directly when the proxy cannot be reached, fails, ignores ranges or hides the size', async () => {
    const { url } = mirror.serve(file);
    const dead = await startProxy(() => null);
    await dead.close(); // a port nobody listens on
    const cases = [
      ['unreachable', via(url).replace(proxy.base, dead.base), 'ok'],
      ['an error', via(url), 'error'],
      ['the whole file', via(url), 'whole'],
      ['no size', via(url), 'hide-size'],
      ['not a file it serves', `${proxy.base}/zim/nowhere/x.zim`, 'ok'],
    ];
    for (const [what, through, mode] of cases) {
      proxy.state.mode = mode;
      const fell = [];
      const src = await HttpSource.open(url, { via: through, onFallback: (err) => fell.push(err.message), retries: 0 });
      assert.equal(src.via, null, what);
      assert.equal(fell.length, 1, `${what}: said once`);
      assert.ok(src.viaError, what);
      assert.equal(src.size, fs.statSync(file).size, what);
      assert.deepEqual(await src.read(0, 4), new Uint8Array(fs.readFileSync(file).subarray(0, 4)), what);
      await src.close();
    }
    proxy.state.mode = 'ok';
  });

  it('goes on directly when the proxy fails in the middle', async () => {
    const { url } = mirror.serve(file);
    proxy.state.mode = 'ok';
    proxy.state.seen = 0;
    proxy.state.failFrom = 1; // the open's first read, then errors
    const fell = [];
    const lib = await ArchiveLibrary.open(await HttpSource.open(url, { via: via(url), onFallback: (e) => fell.push(e) }), { log: () => {} });
    const direct = await ArchiveLibrary.open(file, { log: () => {} });
    try {
      assert.deepEqual(await lib.books(), await direct.books());
      for (const b of (await direct.books()).filter((x) => x.readable)) {
        assert.deepEqual((await lib.content(b.id)).meta, (await direct.content(b.id)).meta);
      }
      const src = lib.archive._source;
      assert.equal(src.via, null);
      assert.equal(fell.length, 1);
      assert.ok(src.stats.viaReads >= 1 && src.stats.reads > src.stats.viaReads, `${src.stats.viaReads} of ${src.stats.reads} through the proxy`);
    } finally {
      proxy.state.failFrom = Infinity;
      await lib.close();
      await direct.close();
    }
  });

  it('does not hide a file that changed: another edition is not the proxy\'s fault', async () => {
    const { url, route } = mirror.serve(file);
    proxy.state.mode = 'ok';
    const src = await HttpSource.open(url, { via: via(url) });
    route.lastModified = 'Sun, 11 Oct 2026 00:00:00 GMT';
    await assert.rejects(src.read(100, 10), (err) => err instanceof HttpSourceError && err.edition && /changed/.test(err.message));
    assert.equal(src.via, via(url), 'still through the proxy');
    await src.close();
  });
});

describe('naming the proxy (zim-url.js, build-pages --zim-proxy)', () => {
  const page = (href, meta) => ({
    location: new URL(href),
    document: { querySelector: (sel) => (meta && sel.includes('vrlbry-zim-proxy') ? { getAttribute: () => meta } : null) },
  });

  it('takes the site\'s meta tag, or the page address\'s ?zimproxy=', () => {
    assert.equal(zimProxyOf(page('https://site.example/app/')), null, 'none named');
    assert.equal(zimProxyOf(page('https://site.example/app/', 'https://p.example.workers.dev')), 'https://p.example.workers.dev/');
    assert.equal(zimProxyOf(page('https://site.example/app/', 'https://p.example/base')), 'https://p.example/base/');
    assert.equal(zimProxyOf(page('https://site.example/app/?zimproxy=https://q.example/', 'https://p.example/')), 'https://q.example/', 'the address\'s first');
    assert.equal(zimProxyOf(page('https://site.example/app/?zimproxy=off', 'https://p.example/')), null);
    assert.equal(zimProxyOf(page('https://site.example/app/', 'http://p.example/')), null, 'not over http');
    assert.equal(zimProxyOf(page('http://localhost:8080/?zimproxy=http://localhost:8090')), 'http://localhost:8090/', 'one on this machine, for trying');
    assert.equal(zimProxyOf(page('https://site.example/app/', 'proxy/')), 'https://site.example/app/proxy/', 'relative to the page');
    assert.equal(zimProxyOf(page('https://site.example/', 'https://[bad')), null);
    assert.equal(zimProxyOf({}), null, 'no page (a worker, Node)');
  });

  it('sends only Kiwix\'s files through it', () => {
    const base = 'https://p.example/';
    assert.equal(proxiedUrl('https://mirror.download.kiwix.org/zim/wikipedia/wikipedia_en_top1m_maxi_2026-04.zim', base),
      'https://p.example/zim/wikipedia/wikipedia_en_top1m_maxi_2026-04.zim');
    assert.equal(proxiedUrl('https://mirror.download.kiwix.org/zim/wikipedia/a.zim', 'https://p.example/sub/'), 'https://p.example/sub/zim/wikipedia/a.zim');
    assert.equal(proxiedUrl('https://example.org/zim/wikipedia/a.zim', base), null, 'another site');
    assert.equal(proxiedUrl('https://mirror.download.kiwix.org/other/a.zim', base), null);
    assert.equal(proxiedUrl('https://mirror.download.kiwix.org/zim/wikipedia/a.zim', null), null, 'no proxy');
  });

  it('writes the meta tag into the built page', () => {
    const html = '<!doctype html>\n<head>\n<title>x</title>\n</head>\n<body></body>';
    const once = zimProxyMeta(html, 'https://p.example.workers.dev');
    assert.match(once, /<meta name="vrlbry-zim-proxy" content="https:\/\/p\.example\.workers\.dev\/">\n<\/head>/);
    assert.equal(zimProxyMeta(once, 'https://q.example/a?b=1&c="2"').match(/vrlbry-zim-proxy/g).length, 1, 'replaced, not added');
    assert.match(zimProxyMeta(html, 'https://q.example/a?b=1&c="2"'), /content="https:\/\/q\.example\/a\?b=1&amp;c=%222%22"/);
    assert.throws(() => zimProxyMeta(html, 'http://p.example/'), /https/);
    assert.doesNotThrow(() => zimProxyMeta(html, 'http://localhost:8090/'));
  });
});
