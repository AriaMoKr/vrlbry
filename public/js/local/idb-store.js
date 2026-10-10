// The local library's store for derived indexes (core/library.js `store`: Wikisource works,
// Wikipedia articles and its checkpoint), in IndexedDB, so a file's index is built once and
// found again after a reload: names carry the ZIM's UUID (core/wikipedia.js indexName), which
// identifies the file whatever it is called or where it is picked from. The same interface as
// the server's folder (server/cache-store.js): one object store, name → string or Uint8Array.
// Works in a worker (IndexedDB is available there) and under fake-indexeddb in Node tests.

const OBJECT_STORE = 'files';

const settle = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
});

/**
 * @param {string} [dbName]
 * @param {{ indexedDB?: IDBFactory }} [opts] the factory (tests pass fake-indexeddb's)
 * @returns {{ readText(name: string): Promise<string|null>, readBytes(name: string): Promise<Uint8Array|null>,
 *   writeText(name: string, text: string): Promise<void>, writeBytes(name: string, bytes: Uint8Array): Promise<void>,
 *   appendBytes(name: string, bytes: Uint8Array): Promise<void>, truncate(name: string, size: number): Promise<void>,
 *   remove(name: string): Promise<void>, names(): Promise<string[]>, close(): void }}
 */
export function idbStore(dbName = 'vrlbry-local', { indexedDB: factory = globalThis.indexedDB } = {}) {
  if (!factory) throw new Error('IndexedDB is not available');
  let opening = null;
  const open = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(OBJECT_STORE);
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { // another page upgrades or deletes it: let go
            db.close();
            opening = null;
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error(`cannot open IndexedDB ${dbName}`));
        req.onblocked = () => reject(new Error(`IndexedDB ${dbName} is blocked by another page`));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  /** Runs fn(objectStore) in one transaction (its requests settle before it completes). */
  const transact = async (mode, fn) => {
    const db = await open();
    const tx = db.transaction(OBJECT_STORE, mode);
    const result = fn(tx.objectStore(OBJECT_STORE));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    return result;
  };
  const asBytes = (v) => (v == null ? null : v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new TextEncoder().encode(String(v)));

  return {
    readText: (name) => transact('readonly', (os) => settle(os.get(name))).then((v) => (v == null ? null : typeof v === 'string' ? v : new TextDecoder().decode(asBytes(v)))),
    readBytes: (name) => transact('readonly', (os) => settle(os.get(name))).then(asBytes),
    /** One put: a reader sees the old index or the new one, never half. */
    writeText: (name, text) => transact('readwrite', (os) => settle(os.put(String(text), name))).then(() => {}),
    writeBytes: (name, bytes) => transact('readwrite', (os) => settle(os.put(new Uint8Array(bytes), name))).then(() => {}),
    /** Read and written back in one transaction, so appends never interleave. */
    appendBytes: (name, bytes) => transact('readwrite', async (os) => {
      const prior = asBytes(await settle(os.get(name))) ?? new Uint8Array(0);
      const out = new Uint8Array(prior.length + bytes.length);
      out.set(prior);
      out.set(bytes, prior.length);
      await settle(os.put(out, name));
    }).then(() => {}),
    truncate: (name, size) => transact('readwrite', async (os) => {
      const prior = asBytes(await settle(os.get(name)));
      if (prior && prior.length > size) await settle(os.put(prior.slice(0, size), name));
    }).then(() => {}),
    remove: (name) => transact('readwrite', (os) => settle(os.delete(name))).then(() => {}),
    /** Every name kept (diagnostics, tests). */
    names: () => transact('readonly', (os) => settle(os.getAllKeys())).then((keys) => keys.map(String)),
    close() {
      opening?.then((db) => db.close()).catch(() => {});
      opening = null;
    },
  };
}
