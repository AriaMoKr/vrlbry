import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { LRUCache } from '../server/util/lru.js';
import { ZimArchive, ZimError } from '../server/zim/reader.js';
import { writeZim } from './helpers/zimwriter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ZIM = path.join(HERE, '..', 'gutenberg_en_lcc-pe_2026-03.zim');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-zim-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
const tmpFile = (name) => path.join(tmp, name);

/** Deterministic pseudo-random bytes. */
function bytes(n, seed) {
  const out = Buffer.alloc(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    out[i] = a >>> 24;
  }
  return out;
}

/** Records the length of every positional read an archive makes. */
function spyReads(zim) {
  const reads = [];
  const orig = zim._read.bind(zim);
  zim._read = (pos, len) => {
    reads.push({ pos, len });
    return orig(pos, len);
  };
  return reads;
}

/** Counts cluster decompressions. */
function spyDecompress(zim) {
  const counter = { n: 0 };
  const orig = zim._decompress.bind(zim);
  zim._decompress = (...args) => {
    counter.n++;
    return orig(...args);
  };
  return counter;
}

const BIG = bytes(3 * 1024 * 1024, 1);
const LONG_URL = `long/${'x'.repeat(2000)}`;
const LONG_TITLE = `Long title ${'é'.repeat(700)}`;

function newSchemeEntries() {
  const entries = [
    { ns: 'C', url: 'index.html', title: 'Index', mime: 'text/html', content: '<h1>Hello</h1>' },
    { ns: 'C', url: 'a/b/c.txt', mime: 'text/plain', content: 'abc'.repeat(1000) },
    { ns: 'C', url: 'café', title: 'Café', mime: 'text/plain', content: 'coffee' },
    { ns: 'C', url: '\u{1F600}smile', mime: 'text/plain', content: 'astral' },
    { ns: 'C', url: 'private', mime: 'text/plain', content: 'pua' },
    { ns: 'C', url: '�repl', mime: 'text/plain', content: 'replacement' },
    { ns: 'C', url: 'z', mime: 'text/plain', content: 'zed' },
    { ns: 'C', url: 'empty-z.txt', mime: 'text/plain', content: '' },
    { ns: 'C', url: LONG_URL, title: LONG_TITLE, mime: 'text/plain', content: 'long one' },
    // Uncompressed cluster: a 3 MB blob between small ones.
    { ns: 'C', url: 'big.bin', mime: 'application/octet-stream', content: BIG, compression: 'none', cluster: 'raw1' },
    { ns: 'C', url: 'small.txt', mime: 'text/plain', content: 'small after big', compression: 'none', cluster: 'raw1' },
    { ns: 'C', url: 'empty.txt', mime: 'text/plain', content: '', compression: 'none', cluster: 'raw1' },
    { ns: 'C', url: 'img.png', mime: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), compression: 'none', cluster: 'raw1' },
    // One zstd cluster holding three entries (cache / dedupe tests).
    { ns: 'C', url: 'z1', mime: 'text/plain', content: 'one '.repeat(500), cluster: 'zc' },
    { ns: 'C', url: 'z2', mime: 'text/plain', content: 'two '.repeat(500), cluster: 'zc' },
    { ns: 'C', url: 'z3', mime: 'text/plain', content: 'three '.repeat(500), cluster: 'zc' },
    // Redirects.
    { ns: 'C', url: 'redir', title: 'Redirect', redirectTo: 'C/index.html' },
    { ns: 'C', url: 'chain1', redirectTo: 'C/chain2' },
    { ns: 'C', url: 'chain2', redirectTo: 'C/chain3' },
    { ns: 'C', url: 'chain3', redirectTo: 'C/index.html' },
    { ns: 'C', url: 'loopA', redirectTo: 'C/loopB' },
    { ns: 'C', url: 'loopB', redirectTo: 'C/loopA' },
    { ns: 'C', url: 'self', redirectTo: 'C/self' },
    { ns: 'C', url: 'bad-redirect', redirectIndex: 99999 },
    { ns: 'C', url: 'special', special: 0xfffe },
    { ns: 'A', url: 'legacy.html', mime: 'text/html', content: 'legacy' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Test ZIM' },
    { ns: 'M', url: 'Language', mime: 'text/plain', content: 'eng' },
    { ns: 'M', url: 'Description', mime: 'text/plain;charset=UTF-8', content: 'Synthetic – ünïcode' },
    { ns: 'M', url: 'Illustration_48x48@1', mime: 'image/png', content: Buffer.from([0x89, 0x50]) },
    { ns: 'W', url: 'mainPage', redirectTo: 'C/index.html' },
  ];
  for (let i = 0; i <= 20; i++) {
    entries.push({ ns: 'C', url: `long${i}`, redirectTo: i < 20 ? `C/long${i + 1}` : 'C/index.html' });
  }
  return entries;
}

describe('LRUCache', () => {
  it('stores, refreshes recency and evicts by entry count', () => {
    const c = new LRUCache({ maxEntries: 2 });
    c.set('a', 1).set('b', 2);
    assert.equal(c.get('a'), 1); // a is now most recent
    c.set('c', 3);
    assert.equal(c.has('b'), false);
    assert.deepEqual([...c.keys()], ['a', 'c']);
    assert.equal(c.size, 2);
    assert.equal(c.delete('a'), true);
    assert.equal(c.delete('a'), false);
    assert.equal(c.get('a'), undefined);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.bytes, 0);
  });

  it('evicts by byte budget and skips values larger than the budget', () => {
    const c = new LRUCache({ maxBytes: 10 });
    c.set('a', Buffer.alloc(4));
    c.set('b', Buffer.alloc(4));
    assert.equal(c.bytes, 8);
    c.set('c', Buffer.alloc(4));
    assert.equal(c.has('a'), false);
    assert.equal(c.bytes, 8);
    c.set('b', Buffer.alloc(6)); // replacing updates the size
    assert.equal(c.bytes, 10);
    c.set('huge', Buffer.alloc(11));
    assert.equal(c.has('huge'), false);
    assert.equal(c.bytes, 10);
    assert.equal(c.peek('c').length, 4);
  });

  it('uses a custom sizeOf', () => {
    const c = new LRUCache({ maxBytes: 100, sizeOf: (v) => v.n });
    c.set(1, { n: 60 });
    c.set(2, { n: 60 });
    assert.deepEqual([...c.keys()], [2]);
    assert.equal(c.bytes, 60);
  });
});

describe('ZimArchive: new namespace scheme (zstd + uncompressed clusters)', () => {
  let info;
  let zim;
  before(async () => {
    info = writeZim(tmpFile('new.zim'), { entries: newSchemeEntries(), mainPage: 'W/mainPage', blobsPerCluster: 3 });
    zim = await ZimArchive.open(info.filePath);
  });
  after(() => zim.close());

  it('reads the header and MIME list', () => {
    assert.equal(zim.header.major, 6);
    assert.equal(zim.header.minor, 1);
    assert.equal(zim.header.uuid, '00112233445566778899aabbccddeeff');
    assert.equal(zim.entryCount, info.entries.length);
    assert.equal(zim.header.entryCount, info.entries.length);
    assert.equal(zim.header.clusterCount, info.clusterCount);
    assert.equal(zim.header.mainPage, info.indexOf('W/mainPage'));
    assert.equal(zim.header.layoutPage, null);
    assert.equal(typeof zim.header.checksumPos, 'number');
    assert.deepEqual(zim.mimeTypes, info.mimeTypes);
    assert.equal(zim.newNamespaceScheme, true);
    assert.equal(zim.filePath, info.filePath);
  });

  it('finds entries by exact namespace + URL', async () => {
    const e = await zim.findEntry('C', 'index.html');
    assert.equal(e.index, info.indexOf('C/index.html'));
    assert.equal(e.path, 'C/index.html');
    assert.equal(e.title, 'Index');
    assert.equal(e.mime, 'text/html');
    assert.equal(e.isRedirect, false);
    assert.equal(e.redirectIndex, null);
    assert.equal(typeof e.cluster, 'number');
    assert.equal(typeof e.blob, 'number');
    assert.equal(e.mimeIndex, zim.mimeTypes.indexOf('text/html'));
    assert.equal((await zim.findEntry('C', 'a/b/c.txt')).title, 'a/b/c.txt', 'title falls back to url');
    assert.equal(await zim.findEntry('C', 'index.htm'), null);
    assert.equal(await zim.findEntry('C', 'index.html2'), null);
    assert.equal(await zim.findEntry('C', ''), null);
    assert.equal(await zim.findEntry('Z', 'index.html'), null);
    assert.equal(await zim.findEntry('A', 'index.html'), null);
  });

  it('finds every entry, including astral / private-use URLs sorted byte-wise', async () => {
    // Byte order differs from JS (UTF-16) order for these three; the archive uses byte order.
    const urls = ['\u{1F600}smile', 'private', '�repl'];
    assert.deepEqual([...urls].sort(), urls, 'JS order puts the astral char first');
    const idx = urls.map((u) => info.indexOf(`C/${u}`));
    assert.ok(idx[1] < idx[2] && idx[2] < idx[0], 'byte order puts the astral char last');
    for (const e of info.entries) {
      const found = await zim.findEntry(e.ns, e.url);
      assert.ok(found, `missing ${e.path}`);
      assert.equal(found.index, e.index, e.path);
      assert.equal(found.url, e.url);
    }
    assert.equal((await zim.getContent('C/\u{1F600}smile')).data.toString(), 'astral');
  });

  it('handles directory entries longer than the first read guess', async () => {
    const e = await zim.findEntry('C', LONG_URL);
    assert.equal(e.title, LONG_TITLE);
    assert.equal((await zim.getContent(e)).data.toString(), 'long one');
  });

  it('findPath / findContentPath', async () => {
    assert.equal((await zim.findPath('C/a/b/c.txt')).url, 'a/b/c.txt');
    assert.equal((await zim.findPath('M/Title')).ns, 'M');
    assert.equal((await zim.findPath('/C/index.html')).path, 'C/index.html');
    assert.equal(await zim.findPath('C/nope'), null);
    for (const bad of ['', 'C', 'Cindex.html', 'CC/index.html', '/', null, undefined, 42]) {
      assert.equal(await zim.findPath(bad), null, String(bad));
    }
    assert.equal((await zim.findContentPath('index.html')).path, 'C/index.html');
    assert.equal((await zim.findContentPath('legacy.html')).path, 'A/legacy.html');
    assert.equal((await zim.findContentPath('legacy.html', ['C'])), null);
    assert.equal(await zim.findContentPath('nothing.html'), null);
  });

  it('lowerBound matches a byte-wise linear scan', async () => {
    const keys = info.entries.map((e) => Buffer.concat([Buffer.from(e.ns), Buffer.from(e.url)]));
    const expectLB = (ns, prefix) => {
      const k = Buffer.concat([Buffer.from(ns), Buffer.from(prefix)]);
      const i = keys.findIndex((key) => Buffer.compare(key, k) >= 0);
      return i < 0 ? keys.length : i;
    };
    const probes = [['-', ''], ['A', ''], ['C', ''], ['C', 'a'], ['C', 'a/'], ['C', 'long'], ['C', 'z'],
      ['C', 'z2'], ['C', 'zz'], ['C', ''], ['C', '\u{1F600}'], ['C', '\u{1F601}'], ['M', ''],
      ['M', 'T'], ['N', ''], ['W', 'mainPage'], ['Z', ''], ['C', 'café'], ['C', 'cafe']];
    for (const e of info.entries) probes.push([e.ns, e.url], [e.ns, e.url.slice(0, 3)]);
    for (const [ns, prefix] of probes) {
      assert.equal(await zim.lowerBound(ns, prefix), expectLB(ns, prefix), `${ns}/${prefix}`);
    }
    assert.equal(await zim.lowerBound('Z', ''), zim.entryCount);
    await assert.rejects(zim.lowerBound('CC', ''), ZimError);
  });

  it('getEntryByIndex validates the index', async () => {
    assert.equal((await zim.getEntryByIndex(0)).index, 0);
    for (const bad of [-1, zim.entryCount, 1.5, NaN, '1']) {
      await assert.rejects(zim.getEntryByIndex(bad), ZimError, String(bad));
    }
  });

  it('entries() iterates in index order, with ranges', async () => {
    const all = [];
    for await (const e of zim.entries()) all.push(e);
    assert.equal(all.length, zim.entryCount);
    all.forEach((e, i) => {
      assert.equal(e.index, i);
      assert.equal(e.path, info.entries[i].path);
    });
    const part = [];
    for await (const e of zim.entries(2, 5)) part.push(e.index);
    assert.deepEqual(part, [2, 3, 4]);
    const none = [];
    for await (const e of zim.entries(5, 2)) none.push(e);
    assert.equal(none.length, 0);
    const clamped = [];
    for await (const e of zim.entries(zim.entryCount - 2, zim.entryCount + 10)) clamped.push(e.index);
    assert.deepEqual(clamped, [zim.entryCount - 2, zim.entryCount - 1]);
  });

  it('entries() works on a cold archive with a tiny entry cache', async () => {
    const cold = await ZimArchive.open(info.filePath, { direntCacheEntries: 3 });
    try {
      const reads = spyReads(cold);
      const paths = [];
      for await (const e of cold.entries()) paths.push(e.path);
      assert.deepEqual(paths, info.entries.map((e) => e.path));
      assert.ok(reads.length < 10, `batched reads expected, got ${reads.length}`);
    } finally {
      await cold.close();
    }
  });

  it('reads content from compressed and uncompressed clusters', async () => {
    const c = await zim.getContent('C/a/b/c.txt');
    assert.equal(c.mime, 'text/plain');
    assert.equal(c.data.toString(), 'abc'.repeat(1000));
    assert.equal(c.entry.path, 'C/a/b/c.txt');
    assert.equal((await zim.getContent('C/img.png')).data.toString('hex'), '89504e470102');
    assert.equal((await zim.getContent('C/empty.txt')).data.length, 0);
    assert.equal((await zim.getContent('C/empty-z.txt')).data.length, 0);
    assert.equal((await zim.getContent('C/z2')).data.toString(), 'two '.repeat(500));
    assert.equal(await zim.getContent('C/missing'), null);
    assert.equal(await zim.getContent(null), null);
  });

  it('reads uncompressed blobs without reading the whole cluster', async () => {
    const reads = spyReads(zim);
    const small = await zim.getContent('C/small.txt');
    assert.equal(small.data.toString(), 'small after big');
    assert.ok(reads.every((r) => r.len < 4096), JSON.stringify(reads));
    reads.length = 0;
    const big = await zim.getContent('C/big.bin');
    assert.ok(big.data.equals(BIG));
    assert.ok(reads.filter((r) => r.len > 4096).length === 1, 'exactly one large read (the blob)');
    assert.equal(Math.max(...reads.map((r) => r.len)), BIG.length);
    delete zim._read;
  });

  it('follows redirects', async () => {
    const r = await zim.findPath('C/redir');
    assert.equal(r.isRedirect, true);
    assert.equal(r.mime, null);
    assert.equal(r.cluster, null);
    assert.equal(r.blob, null);
    assert.equal(r.redirectIndex, info.indexOf('C/index.html'));
    assert.equal(r.title, 'Redirect');
    const target = await zim.resolveRedirect(r);
    assert.equal(target.path, 'C/index.html');
    const c = await zim.getContent('C/chain1');
    assert.equal(c.entry.path, 'C/index.html');
    assert.equal(c.data.toString(), '<h1>Hello</h1>');
    assert.equal((await zim.resolveRedirect(target)).path, 'C/index.html', 'non-redirects resolve to themselves');
  });

  it('detects redirect loops, long chains and bad targets', async () => {
    await assert.rejects(zim.getContent('C/loopA'), (err) => err instanceof ZimError && /loop/.test(err.message));
    await assert.rejects(zim.getContent('C/self'), /loop/);
    await assert.rejects(zim.getContent('C/long0'), (err) => err instanceof ZimError && /16 hops/.test(err.message));
    assert.equal((await zim.resolveRedirect(await zim.findPath('C/long0'), 32)).path, 'C/index.html');
    assert.equal((await zim.resolveRedirect(await zim.findPath('C/long5'))).path, 'C/index.html');
    await assert.rejects(zim.getContent('C/bad-redirect'), (err) => err instanceof ZimError && /invalid index/.test(err.message));
  });

  it('handles special (linktarget) entries', async () => {
    const s = await zim.findPath('C/special');
    assert.equal(s.mime, null);
    assert.equal(s.isRedirect, false);
    assert.equal(s.cluster, null);
    assert.equal(await zim.getContent(s), null);
    assert.equal(await zim.getBlobSize(s), null);
  });

  it('getMetadata returns the text/* M entries', async () => {
    const meta = await zim.getMetadata();
    assert.deepEqual(meta, { Description: 'Synthetic – ünïcode', Language: 'eng', Title: 'Test ZIM' });
    meta.Title = 'changed';
    assert.equal((await zim.getMetadata()).Title, 'Test ZIM');
  });

  it('getMainEntry resolves the main page redirect', async () => {
    assert.equal((await zim.getMainEntry()).path, 'C/index.html');
  });

  it('getBlobSize: cheap for uncompressed, needs the cluster for compressed', async () => {
    const fresh = await ZimArchive.open(info.filePath);
    try {
      const dec = spyDecompress(fresh);
      const big = await fresh.findPath('C/big.bin');
      const reads = spyReads(fresh);
      assert.equal(await fresh.getBlobSize(big, { cheapOnly: true }), BIG.length);
      assert.equal(await fresh.getBlobSize(big), BIG.length);
      assert.ok(reads.every((r) => r.len <= 16), 'only header/offset reads');
      const z1 = await fresh.findPath('C/z1');
      assert.equal(await fresh.getBlobSize(z1, { cheapOnly: true }), null);
      assert.equal(dec.n, 0);
      assert.equal(await fresh.getBlobSize(z1), 2000);
      assert.equal(dec.n, 1);
      const z3 = await fresh.findPath('C/z3');
      assert.equal(await fresh.getBlobSize(z3, { cheapOnly: true }), 3000, 'cluster now cached');
      assert.equal(dec.n, 1);
      assert.equal(await fresh.getBlobSize(await fresh.findPath('C/redir')), 14, 'follows redirects');
    } finally {
      await fresh.close();
    }
  });

  it('caches decompressed clusters and shares concurrent decompressions', async () => {
    const fresh = await ZimArchive.open(info.filePath);
    try {
      const dec = spyDecompress(fresh);
      const paths = ['C/z1', 'C/z2', 'C/z3', 'C/z1', 'C/z2', 'C/z3', 'C/z1', 'C/z2'];
      const results = await Promise.all(paths.map((p) => fresh.getContent(p)));
      assert.equal(dec.n, 1, 'one decompression for 8 concurrent reads of one cluster');
      assert.equal(results[2].data.toString(), 'three '.repeat(500));
      await fresh.getContent('C/z2');
      assert.equal(dec.n, 1, 'served from cache');
      // Returned data is a copy: modifying it does not corrupt the cache.
      results[0].data.fill(0);
      assert.equal((await fresh.getContent('C/z1')).data.toString(), 'one '.repeat(500));
    } finally {
      await fresh.close();
    }
  });

  it('respects the cluster cache byte budget', async () => {
    const tiny = await ZimArchive.open(info.filePath, { clusterCacheBytes: 100 });
    try {
      const dec = spyDecompress(tiny);
      await tiny.getContent('C/z1');
      await tiny.getContent('C/z2');
      assert.equal(dec.n, 2, 'cluster larger than the budget is not cached');
      assert.equal(await tiny.getBlobSize(await tiny.findPath('C/z1'), { cheapOnly: true }), null);
    } finally {
      await tiny.close();
    }
  });

  it('throws ZimError after close()', async () => {
    const z = await ZimArchive.open(info.filePath);
    await z.close();
    await z.close(); // idempotent
    await assert.rejects(z.getContent('C/z1'), (err) => err instanceof ZimError && /closed/.test(err.message));
  });
});

describe('ZimArchive: cluster variants', () => {
  const entries = () => [
    { ns: 'C', url: 'a', mime: 'text/plain', content: 'alpha '.repeat(100) },
    { ns: 'C', url: 'b', mime: 'text/plain', content: '' },
    { ns: 'C', url: 'c', mime: 'application/octet-stream', content: bytes(70000, 3) },
    { ns: 'C', url: 'd', mime: 'text/plain', content: 'delta' },
    { ns: 'C', url: 'e', mime: 'text/plain', content: 'echo', compression: 'none' },
    { ns: 'C', url: 'f', mime: 'application/octet-stream', content: bytes(5000, 4), compression: 'none' },
    { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Variant' },
  ];

  for (const [name, opts] of [
    ['zstd extended', { compression: 'zstd', extended: true }],
    ['uncompressed extended', { compression: 'none', extended: true }],
    ['zlib', { compression: 'zlib' }],
    ['xz (stored LZMA2 chunks)', { compression: 'xz' }],
    ['zstd, zimlib layout, no checksum', { compression: 'zstd', layout: 'zimlib', checksum: false }],
  ]) {
    it(`reads ${name}`, async () => {
      const info = writeZim(tmpFile(`variant-${name.replace(/\W+/g, '_')}.zim`), { entries: entries(), blobsPerCluster: 2, ...opts });
      const zim = await ZimArchive.open(info.filePath);
      try {
        for (const e of entries()) {
          const c = await zim.getContent(`${e.ns}/${e.url}`);
          const want = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content);
          assert.ok(c.data.equals(want), `${name}: ${e.url}`);
          assert.equal(await zim.getBlobSize(c.entry), want.length);
        }
        assert.equal((await zim.getMetadata()).Title, 'Variant');
      } finally {
        await zim.close();
      }
    });
  }

  it('reads a real LZMA-compressed xz cluster (liblzma fixture)', async () => {
    const fixture = fs.readFileSync(path.join(HERE, 'fixtures', 'xz', 'zim_cluster.xz'));
    const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'xz', 'zim_cluster.json'), 'utf8'));
    const info = writeZim(tmpFile('xz-real.zim'), {
      entries: [
        { ns: 'C', url: 'plain', mime: 'text/plain', content: 'plain zstd' },
        ...meta.blobsSha256.map((_, i) => ({ ns: 'C', url: `x${i}`, mime: 'text/plain', rawCluster: 0, blob: i })),
      ],
      // The raw cluster is the last cluster, followed by the dirents: its end is not exact.
      rawClusters: [{ compression: 4, data: fixture }],
    });
    for (const tailWindowBytes of [undefined, 64]) {
      const zim = await ZimArchive.open(info.filePath, tailWindowBytes ? { tailWindowBytes } : {});
      try {
        for (let i = 0; i < meta.blobsSha256.length; i++) {
          const c = await zim.getContent(`C/x${i}`);
          assert.equal(c.data.length, meta.blobLengths[i]);
          assert.equal(sha256(c.data), meta.blobsSha256[i]);
        }
        assert.equal((await zim.getContent('C/plain')).data.toString(), 'plain zstd');
      } finally {
        await zim.close();
      }
    }
  });

  for (const compression of ['zstd', 'zlib', 'xz']) {
    it(`reads a ${compression} last cluster without reading the trailing directory entries`, async () => {
      const ents = [{ ns: 'C', url: 'data', mime: 'text/plain', content: 'payload '.repeat(300) }];
      // ~400 KB of directory entries after the last (and only) cluster.
      for (let i = 0; i < 2000; i++) ents.push({ ns: 'C', url: `r/${i}/${'p'.repeat(150)}`, redirectTo: 'C/data' });
      const info = writeZim(tmpFile(`tail-${compression}.zim`), { entries: ents, compression });
      const zim = await ZimArchive.open(info.filePath, { tailWindowBytes: 256 });
      try {
        const reads = spyReads(zim);
        const c = await zim.getContent('C/data');
        assert.equal(c.data.toString(), 'payload '.repeat(300));
        assert.ok(Math.max(...reads.map((r) => r.len)) < 64 * 1024, JSON.stringify(reads.map((r) => r.len)));
      } finally {
        await zim.close();
      }
      // The default window also works (whole range fits in it).
      const zim2 = await ZimArchive.open(info.filePath);
      try {
        assert.equal((await zim2.getContent('C/r/7/' + 'p'.repeat(150))).data.toString(), 'payload '.repeat(300));
      } finally {
        await zim2.close();
      }
    });
  }

  it('refuses bzip2 clusters and corrupt clusters with ZimError', async () => {
    const zstdBadTable = zlib.zstdCompressSync(Buffer.from([12, 0, 0, 0, 4, 0, 0, 0]));
    const info = writeZim(tmpFile('bad-clusters.zim'), {
      entries: [
        { ns: 'C', url: 'bz', mime: 'text/plain', content: 'x', compression: 'bzip2' },
        { ns: 'C', url: 'ok', mime: 'text/plain', content: 'fine', compression: 'none' },
        { ns: 'C', url: 'garbage', mime: 'text/plain', rawCluster: 0, blob: 0 },
        { ns: 'C', url: 'badtable', mime: 'text/plain', rawCluster: 1, blob: 0 },
        { ns: 'C', url: 'badraw', mime: 'text/plain', rawCluster: 2, blob: 0 },
        { ns: 'C', url: 'blob-range', mime: 'text/plain', rawCluster: 3, blob: 5 },
        { ns: 'C', url: 'cluster-range', mime: 'text/plain', rawCluster: 99, blob: 0 },
        { ns: 'C', url: 'badcomp', mime: 'text/plain', rawCluster: 4, blob: 0 },
      ],
      rawClusters: [
        { compression: 5, data: bytes(300, 9) }, // not zstd at all
        { compression: 5, data: zstdBadTable }, // offsets beyond the data
        { compression: 1, data: Buffer.from([8, 0, 0, 0, 0xff, 0xff, 0, 0]) }, // blob end beyond cluster
        { compression: 1, data: Buffer.from([8, 0, 0, 0, 9, 0, 0, 0, 0x41]) }, // 1 blob
        { compression: 9, data: Buffer.alloc(8) }, // unknown compression type
      ],
    });
    const zim = await ZimArchive.open(info.filePath);
    try {
      assert.equal((await zim.getContent('C/ok')).data.toString(), 'fine');
      const expectZimError = (re) => (err) => err instanceof ZimError && re.test(err.message);
      await assert.rejects(zim.getContent('C/bz'), expectZimError(/bzip2/));
      await assert.rejects(zim.getContent('C/garbage'), expectZimError(/cluster/));
      await assert.rejects(zim.getContent('C/badtable'), expectZimError(/corrupt offset table/));
      await assert.rejects(zim.getContent('C/badraw'), expectZimError(/corrupt offset table/));
      await assert.rejects(zim.getContent('C/blob-range'), expectZimError(/blob 5 out of range/));
      await assert.rejects(zim.getContent('C/cluster-range'), expectZimError(/cluster \d+ out of range/));
      await assert.rejects(zim.getContent('C/badcomp'), expectZimError(/unknown compression/));
      await assert.rejects(zim.getBlobSize(await zim.findPath('C/blob-range')), ZimError);
    } finally {
      await zim.close();
    }
  });
});

describe('ZimArchive: old namespace scheme', () => {
  let info;
  let zim;
  before(async () => {
    info = writeZim(tmpFile('old.zim'), {
      scheme: 'old',
      major: 5,
      layout: 'zimlib',
      compression: 'zlib',
      mainPage: 'A/Main_Page',
      entries: [
        { ns: 'A', url: 'index.html', title: 'Welcome', mime: 'text/html', content: '<p>old</p>' },
        { ns: 'A', url: 'Main_Page', redirectTo: 'A/index.html' },
        { ns: 'I', url: 'logo.png', mime: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), compression: 'none' },
        { ns: '-', url: 'style.css', mime: 'text/css', content: 'body{}' },
        { ns: 'M', url: 'Title', mime: 'text/plain', content: 'Old ZIM' },
      ],
    });
    zim = await ZimArchive.open(info.filePath);
  });
  after(() => zim.close());

  it('detects the old scheme and resolves content across namespaces', async () => {
    assert.equal(zim.newNamespaceScheme, false);
    assert.equal(zim.header.major, 5);
    assert.equal(zim.header.minor, 0);
    assert.equal((await zim.findContentPath('logo.png')).path, 'I/logo.png');
    assert.equal((await zim.findContentPath('style.css')).path, '-/style.css');
    assert.equal((await zim.getContent('-/style.css')).data.toString(), 'body{}');
    assert.equal((await zim.getMainEntry()).path, 'A/index.html');
    assert.deepEqual(await zim.getMetadata(), { Title: 'Old ZIM' });
  });

  it('has no main entry when the header has none and there is no W/mainPage', async () => {
    const i2 = writeZim(tmpFile('nomain.zim'), { scheme: 'new', entries: [{ ns: 'C', url: 'x', mime: 'text/plain', content: 'x' }] });
    assert.throws(() => writeZim(tmpFile('never.zim'), { scheme: 'old', entries: [{ ns: 'C', url: 'x', mime: 'text/plain', content: 'x' }] }), /not allowed/);
    const z = await ZimArchive.open(i2.filePath);
    try {
      assert.equal(z.header.mainPage, null);
      assert.equal(await z.getMainEntry(), null);
      assert.equal(z.newNamespaceScheme, true);
    } finally {
      await z.close();
    }
  });
});

describe('ZimArchive: invalid files', () => {
  let good;
  before(() => {
    good = fs.readFileSync(writeZim(tmpFile('good.zim'), { entries: newSchemeEntries() }).filePath);
  });

  const write = (name, buf) => {
    fs.writeFileSync(tmpFile(name), buf);
    return tmpFile(name);
  };
  const rejectsZim = (p, re) => assert.rejects(ZimArchive.open(p), (err) => err instanceof ZimError && re.test(err.message));

  it('rejects missing, tiny, bad-magic and unsupported-version files', async () => {
    await rejectsZim(tmpFile('does-not-exist.zim'), /cannot open/);
    await rejectsZim(write('tiny.zim', good.subarray(0, 10)), /too small/);
    const badMagic = Buffer.from(good);
    badMagic[0] ^= 0xff;
    await rejectsZim(write('magic.zim', badMagic), /bad magic/);
    const v9 = Buffer.from(good);
    v9.writeUInt16LE(9, 4);
    await rejectsZim(write('v9.zim', v9), /unsupported ZIM version 9/);
    await rejectsZim(write('html.zim', Buffer.from('<html>'.repeat(40))), /bad magic/);
  });

  it('rejects truncated files', async () => {
    for (const n of [80, 200, good.length >> 1, good.length - 100, good.length - 1]) {
      await rejectsZim(write(`trunc-${n}.zim`, good.subarray(0, n)), /truncated|corrupt|end of file/);
    }
  });

  it('reports a truncated cluster at read time (no checksum, zimlib layout)', async () => {
    const info = writeZim(tmpFile('cut-src.zim'), {
      layout: 'zimlib',
      checksum: false,
      entries: [
        { ns: 'C', url: 'a', mime: 'text/plain', content: 'aaaa' },
        { ns: 'C', url: 'big', mime: 'application/octet-stream', content: bytes(100000, 5), compression: 'none' },
        { ns: 'C', url: 'z', mime: 'text/plain', content: bytes(50000, 6).toString('hex') },
      ],
    });
    const full = fs.readFileSync(info.filePath);
    const zim = await ZimArchive.open(write('cut.zim', full.subarray(0, full.length - 30000)));
    try {
      assert.equal((await zim.getContent('C/a')).data.toString(), 'aaaa');
      const results = await Promise.allSettled([zim.getContent('C/big'), zim.getContent('C/z')]);
      assert.ok(results.some((r) => r.status === 'rejected'), 'the cut cluster must fail');
      for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof ZimError, String(r.reason));
    } finally {
      await zim.close();
    }
  });
});

describe('ZimArchive: real Gutenberg ZIM', { skip: !fs.existsSync(REAL_ZIM) && 'real ZIM not present' }, () => {
  let zim;
  let openMs;
  before(async () => {
    const t0 = performance.now();
    zim = await ZimArchive.open(REAL_ZIM);
    openMs = performance.now() - t0;
  });
  after(() => zim?.close());

  it('opens quickly and reads the header', () => {
    assert.ok(openMs < 200, `open took ${openMs.toFixed(0)} ms`);
    assert.equal(zim.header.major, 6);
    assert.equal(zim.header.minor, 3);
    assert.equal(zim.entryCount, 6926);
    assert.equal(zim.header.clusterCount, 428);
    assert.equal(zim.header.uuid, '4b8589abfb15251dd741e756f9985324');
    assert.equal(zim.header.titlePtrPos, null);
    assert.equal(zim.mimeTypes.length, 19);
    assert.equal(zim.newNamespaceScheme, true);
  });

  it('reads metadata and the main page', async () => {
    const meta = await zim.getMetadata();
    assert.equal(meta.Title, 'Project Gutenberg Library');
    assert.equal(meta.Description, 'English language');
    assert.equal(meta.Language, 'eng');
    assert.equal(meta.Scraper, 'gutenberg2zim-3.0.1');
    assert.equal(meta.Date, '2026-03-05');
    assert.equal(meta.Creator, 'gutenberg.org');
    assert.equal(meta.Publisher, 'openZIM');
    assert.equal(meta.Name, 'gutenberg_en_lcc-pe');
    assert.equal(meta['Illustration_48x48@1'], undefined);
    assert.equal((await zim.getMainEntry()).path, 'C/Home');
    const ill = await zim.getContent('M/Illustration_48x48@1');
    assert.equal(ill.mime, 'image/png');
    assert.equal(ill.data.subarray(1, 4).toString(), 'PNG');
  });

  it('reads the book index and an uncompressed cover', async () => {
    const pop = await zim.getContent('C/full_by_popularity.js');
    assert.equal(pop.mime, 'text/javascript');
    assert.ok(pop.data.toString('utf8', 0, 20).startsWith('var json_data = [['));
    const cover = await zim.findPath('C/covers/37134_cover_image.jpg');
    const size = await zim.getBlobSize(cover, { cheapOnly: true });
    const c = await zim.getContent(cover);
    assert.equal(size, c.data.length);
    assert.equal(c.data.readUInt16BE(0), 0xffd8);
  });

  it("reads Webster's Unabridged Dictionary (30 MB, zstd)", async () => {
    const e = await zim.findPath("C/Webster's Unabridged Dictionary.29765");
    assert.equal(e.mime, 'text/html');
    const t0 = performance.now();
    const c = await zim.getContent(e);
    assert.equal(c.data.length, 30636463);
    assert.ok(performance.now() - t0 < 5000);
    assert.equal(await zim.getBlobSize(e, { cheapOnly: true }), 30636463);
  });

  it('reads every entry; C and M content matches python-libzim byte for byte', async () => {
    // Digest of `${path}\0${resolvedPath}\0${mime}\0${sha256(content)}\n` over all C and M entries
    // in index order, computed from python-libzim 3.13 (libzim 9.8.2) output.
    const LIBZIM_DIGEST = 'e386b27dada9a136a72100f800d1df3085bc092617a3a2ad3eaa8b74702549a3';
    const digest = crypto.createHash('sha256');
    let all = 0;
    let cm = 0;
    let redirects = 0;
    for await (const e of zim.entries()) {
      const c = await zim.getContent(e);
      assert.ok(c && Buffer.isBuffer(c.data), e.path);
      all++;
      if (e.isRedirect) redirects++;
      if (e.ns === 'C' || e.ns === 'M') {
        cm++;
        digest.update(`${e.path}\0${c.entry.path}\0${c.mime}\0${sha256(c.data)}\n`);
      }
    }
    assert.equal(all, 6926);
    assert.equal(cm, 6922);
    assert.ok(redirects >= 1);
    assert.equal(digest.digest('hex'), LIBZIM_DIGEST);
  });

  it('finds every entry by its path (binary search)', async () => {
    const cold = await ZimArchive.open(REAL_ZIM, { direntCacheEntries: 100 });
    try {
      let i = 0;
      for await (const e of zim.entries()) {
        const found = await cold.findEntry(e.ns, e.url);
        assert.equal(found?.index, i, e.path);
        i++;
      }
    } finally {
      await cold.close();
    }
  });
});
