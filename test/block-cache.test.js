// The cache of what is read from the web (public/js/local/block-cache.js, milestone 3 step 4),
// under fake-indexeddb: read-through, kept per edition, within a budget, and standing aside when
// IndexedDB fails. Optional: a source reads the same without it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { blockCache } from '../public/js/local/block-cache.js';

/** A web source over some bytes that counts its reads (as HttpSource: url, size, lastModified). */
function fakeSource(bytes, { url = 'https://example.org/a.zim', lastModified = 'Sat, 10 Oct 2026 00:00:00 GMT' } = {}) {
  const src = {
    name: 'a.zim', url, size: bytes.length, lastModified, reads: 0, stats: { reads: 0, bytes: 0 }, closed: false,
    async read(position, length) {
      src.reads++;
      const out = bytes.slice(position, Math.min(bytes.length, position + length));
      src.stats.reads++;
      src.stats.bytes += out.length;
      return out;
    },
    async close() { src.closed = true; },
  };
  return src;
}

const data = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
/** Writes are kept in the background: wait for them. */
const settled = () => new Promise((r) => setTimeout(r, 30));

describe('block cache (what is read from the web, kept in IndexedDB)', () => {
  it('reads through: a read made once comes from the cache the next time, after a reload too', async () => {
    const indexedDB = new IDBFactory();
    const bytes = data(100000);
    const cache = blockCache({ indexedDB });
    const src = fakeSource(bytes);
    const kept = cache.wrap(src);
    assert.equal(kept.size, bytes.length);
    assert.deepEqual(await kept.read(1000, 500), bytes.slice(1000, 1500));
    assert.deepEqual(await kept.read(99990, 100), bytes.slice(99990), 'fewer at the end, as the source');
    await settled();
    assert.deepEqual(await kept.read(1000, 500), bytes.slice(1000, 1500));
    assert.equal(src.reads, 2, 'the second read of the same bytes was the cache\'s');
    assert.deepEqual(cache.stats, { hits: 1, misses: 2, hitBytes: 500, failures: 0 });
    assert.deepEqual(await cache.usage(), { bytes: 510, entries: 2 });
    await kept.close();
    assert.ok(src.closed, 'closing closes the source');
    cache.close();
    // Another page (a reload): the same database.
    const again = blockCache({ indexedDB });
    const src2 = fakeSource(bytes);
    assert.deepEqual(await again.wrap(src2).read(99990, 100), bytes.slice(99990));
    assert.equal(src2.reads, 0);
    // Another range of the same bytes is another read (reads repeat exactly: no need for more).
    await again.wrap(src2).read(1000, 400);
    assert.equal(src2.reads, 1);
    again.close();
  });

  it('keeps editions apart, and leaves a source without Last-Modified alone', async () => {
    const indexedDB = new IDBFactory();
    const cache = blockCache({ indexedDB });
    const old = fakeSource(data(5000, 1));
    await cache.wrap(old).read(0, 100);
    await settled();
    // A new edition at the same address (another Last-Modified, or size): not the old bytes.
    const renewed = fakeSource(data(5000, 2), { lastModified: 'Sun, 11 Oct 2026 00:00:00 GMT' });
    assert.deepEqual(await cache.wrap(renewed).read(0, 100), data(5000, 2).slice(0, 100));
    assert.equal(renewed.reads, 1);
    const resized = fakeSource(data(6000, 3));
    assert.deepEqual(await cache.wrap(resized).read(0, 100), data(6000, 3).slice(0, 100));
    assert.equal(resized.reads, 1);
    const unknown = fakeSource(data(100), { lastModified: null });
    assert.equal(cache.wrap(unknown), unknown, 'no Last-Modified: its edition is unknown, not kept');
    cache.close();
  });

  it('stays within its budget, the oldest written going first', async () => {
    const indexedDB = new IDBFactory();
    const cache = blockCache({ indexedDB, budgetBytes: 10000 });
    const src = fakeSource(data(50000));
    const kept = cache.wrap(src);
    for (let i = 0; i < 6; i++) {
      await kept.read(i * 4000, 3000);
      await settled();
    }
    const { bytes, entries } = await cache.usage();
    assert.ok(bytes <= 10000, `${bytes} bytes kept`);
    assert.equal(entries, 3, 'evicted down to 90 % of the budget');
    const before = src.reads;
    await kept.read(5 * 4000, 3000); // the newest: kept
    assert.equal(src.reads, before);
    await kept.read(0, 3000); // the oldest: gone
    assert.equal(src.reads, before + 1);
    await cache.clear();
    assert.deepEqual(await cache.usage(), { bytes: 0, entries: 0 });
    cache.close();
  });

  it('makes its stores in a database of its name that lacks them', async () => {
    const indexedDB = new IDBFactory();
    // Something else opened (and so made) the database first, empty.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('vrlbry-blocks');
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    const cache = blockCache({ indexedDB });
    const src = fakeSource(data(1000));
    const kept = cache.wrap(src);
    await kept.read(0, 100);
    await settled();
    await kept.read(0, 100);
    assert.equal(src.reads, 1, 'kept');
    assert.equal(cache.stats.failures, 0);
    cache.close();
  });

  it('stands aside when IndexedDB fails: every read from the source', async () => {
    assert.equal(blockCache({ indexedDB: null }), null, 'no IndexedDB: no cache');
    const broken = { open() { throw new Error('IndexedDB is broken here'); } };
    const cache = blockCache({ indexedDB: broken });
    const bytes = data(20000);
    const src = fakeSource(bytes);
    const kept = cache.wrap(src);
    for (let i = 0; i < 8; i++) assert.deepEqual(await kept.read(i * 100, 50), bytes.slice(i * 100, i * 100 + 50));
    await settled();
    assert.equal(src.reads, 8);
    assert.ok(cache.stats.failures >= 5, `failures counted: ${cache.stats.failures}`);
    // After a few failures in a row it no longer tries.
    const tried = cache.stats.failures;
    await kept.read(0, 50);
    await settled();
    assert.equal(cache.stats.failures, tried);
    assert.equal(src.reads, 9);
  });
});
