// The local library's IndexedDB store (local/idb-store.js) under fake-indexeddb: the same
// interface as the server's folder store (server/cache-store.js), checked side by side.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { fileStore } from '../server/cache-store.js';
import { idbStore } from '../public/js/local/idb-store.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-store-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const bytes = (...b) => new Uint8Array(b);

/** What the core does with a store (core/wikipedia.js: an index, a checkpoint), on any store. */
async function exercise(store) {
  assert.equal(await store.readText('none.json'), null, 'absent text reads as null');
  assert.equal(await store.readBytes('none.bin'), null, 'absent bytes read as null');
  await store.writeText('index.json', '{"a":1}');
  assert.equal(await store.readText('index.json'), '{"a":1}');
  await store.writeText('index.json', '{"a":2}');
  assert.equal(await store.readText('index.json'), '{"a":2}', 'overwritten whole');
  await store.writeBytes('part.bin', new Uint8Array(0));
  assert.deepEqual([...(await store.readBytes('part.bin'))], []);
  await store.appendBytes('part.bin', bytes(1, 2, 3));
  await store.appendBytes('part.bin', bytes(4, 5));
  assert.deepEqual([...(await store.readBytes('part.bin'))], [1, 2, 3, 4, 5]);
  await store.truncate('part.bin', 4); // only ever shorter (a half-written checkpoint entry cut off)
  assert.deepEqual([...(await store.readBytes('part.bin'))], [1, 2, 3, 4]);
  // Appends at once never lose each other.
  await Promise.all([bytes(6), bytes(7), bytes(8)].map((b) => store.appendBytes('part.bin', b)));
  assert.deepEqual([...(await store.readBytes('part.bin'))].sort(), [1, 2, 3, 4, 6, 7, 8]);
  await store.remove('part.bin');
  await store.remove('never.bin');
  assert.equal(await store.readBytes('part.bin'), null);
  assert.equal(await store.readText('index.json'), '{"a":2}', 'other names untouched');
}

describe('derived-index stores', () => {
  it('the server\'s folder store', async () => {
    await exercise(fileStore(path.join(tmp, 'cache')));
  });

  it('the local library\'s IndexedDB store behaves the same', async () => {
    const factory = new IDBFactory();
    const store = idbStore('test', { indexedDB: factory });
    await exercise(store);
    assert.deepEqual(await store.names(), ['index.json']);
    // What was kept is there for the next page load (another store on the same database).
    store.close();
    const again = idbStore('test', { indexedDB: factory });
    assert.equal(await again.readText('index.json'), '{"a":2}');
    again.close();
  });

  it('wants IndexedDB', () => {
    assert.throws(() => idbStore('x', { indexedDB: undefined }), /IndexedDB is not available/);
  });
});
