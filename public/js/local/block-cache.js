// A persistent cache of what was read from the web (milestone 3, step 4; optional): every read of
// a remote ZIM kept in IndexedDB, so a library, book or search read once costs no network again,
// after a reload too. The browser's own HTTP cache already serves reads made one at a time on a
// second visit, but reads made together it only queues (HttpSource asks for no-store then): this
// covers those (a search, a volume's titles, a book's pictures). Read-through: a miss, an
// IndexedDB error, a full disk or no IndexedDB at all just read from the source.
//
// A read is kept under the file's edition (its address, size and Last-Modified, from HttpSource's
// probe: a new edition at the same address never meets the old one's bytes) and its position and
// length. ZimArchive's reads repeat exactly on a second visit (aligned blocks, whole clusters,
// blob ranges), so that is enough. Within a budget, the oldest written go first.

const BLOCKS = 'blocks'; // key → bytes
const SIZES = 'sizes'; // key → { n: bytes, t: when written } (index 't': oldest first)
const META = 'meta'; // 'total' → bytes kept

/** What is kept at most: a headset has room, but the cache is only a speed-up. */
export const BLOCK_CACHE_BYTES = 256 * 1024 * 1024;
/** Reads bigger than this are not kept (clusters are a few MB at most). */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** Eviction stops at this share of the budget, so it does not run on every write. */
const LOW_WATER = 0.9;
/** After this many failures in a row the cache stands aside (a broken or full database). */
const MAX_FAILURES = 5;

const settle = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
});

/**
 * @param {{ indexedDB?: IDBFactory, dbName?: string, budgetBytes?: number }} [opts]
 * @returns {null | { wrap(source: object): object, usage(): Promise<{ bytes: number, entries: number }>,
 *   clear(): Promise<void>, close(): void, stats: { hits: number, misses: number, hitBytes: number, failures: number } }}
 *   null without IndexedDB; wrap(source) gives the source back unchanged when it cannot be kept
 *   (no Last-Modified: its edition would be unknown)
 */
export function blockCache({ indexedDB: factory = globalThis.indexedDB, dbName = 'vrlbry-blocks', budgetBytes = BLOCK_CACHE_BYTES } = {}) {
  if (!factory) return null;
  const stats = { hits: 0, misses: 0, hitBytes: 0, failures: 0 };
  let failuresInARow = 0;
  let seq = 0;
  /** When a read was written: the time, then a counter (several are written in the same millisecond). */
  const stamp = () => Date.now() * 1024 + (seq++ & 1023);
  let broken = false;
  let opening = null;
  const STORES = [BLOCKS, SIZES, META];
  /** Opens the database at `version` (any when omitted), its stores made where missing. */
  const openAt = (version) => new Promise((resolve, reject) => {
    const req = version ? factory.open(dbName, version) : factory.open(dbName);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOCKS)) db.createObjectStore(BLOCKS);
      if (!db.objectStoreNames.contains(SIZES)) db.createObjectStore(SIZES).createIndex('t', 't');
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`cannot open IndexedDB ${dbName}`));
    req.onblocked = () => reject(new Error(`IndexedDB ${dbName} is blocked by another page`));
  });
  const open = () => {
    if (!opening) {
      opening = (async () => {
        let db = await openAt();
        // A database of that name without the stores (made by something else, or emptied): one
        // version up makes them.
        if (!STORES.every((s) => db.objectStoreNames.contains(s))) {
          const next = db.version + 1;
          db.close();
          db = await openAt(next);
        }
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        return db;
      })();
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  /** Runs fn(stores) in one transaction over `names`; resolves with fn's result once it completes. */
  const transact = async (names, mode, fn) => {
    const db = await open();
    const tx = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const result = fn(Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])));
    await done;
    return result;
  };
  const ok = () => { failuresInARow = 0; };
  const failed = () => {
    stats.failures++;
    if (++failuresInARow >= MAX_FAILURES) broken = true;
  };

  async function get(key) {
    const v = await transact([BLOCKS], 'readonly', (s) => settle(s[BLOCKS].get(key)));
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  }

  async function put(key, bytes) {
    let total = 0;
    await transact([BLOCKS, SIZES, META], 'readwrite', async (s) => {
      const prior = await settle(s[SIZES].get(key)); // the same read missed twice at once
      total = ((await settle(s[META].get('total'))) ?? 0) - (prior?.n ?? 0) + bytes.length;
      s[BLOCKS].put(bytes, key);
      s[SIZES].put({ n: bytes.length, t: stamp() }, key);
      s[META].put(total, 'total');
    });
    if (total > budgetBytes) await evict();
  }

  /** Deletes the oldest reads until the total is under LOW_WATER of the budget. */
  async function evict() {
    await transact([BLOCKS, SIZES, META], 'readwrite', async (s) => {
      let total = (await settle(s[META].get('total'))) ?? 0;
      const target = budgetBytes * LOW_WATER;
      await new Promise((resolve, reject) => {
        const req = s[SIZES].index('t').openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || total <= target) return resolve();
          total -= cursor.value.n;
          s[BLOCKS].delete(cursor.primaryKey);
          cursor.delete();
          cursor.continue();
        };
      });
      s[META].put(Math.max(0, total), 'total');
    });
  }

  return {
    stats,
    /**
     * The source with its reads kept: { name, size, read, close, stats (the source's: what the
     * network gave), cache: this one's stats }.
     */
    wrap(source) {
      if (!source?.url || !source.size || !source.lastModified) return source;
      const edition = `${source.url}\n${source.size}\n${source.lastModified}\n`;
      return {
        name: source.name,
        size: source.size,
        url: source.url,
        lastModified: source.lastModified,
        get stats() { return source.stats; },
        cache: stats,
        async read(position, length) {
          const key = `${edition}${position}+${length}`;
          if (!broken) {
            const hit = await get(key).then((v) => { ok(); return v; }, () => { failed(); return null; });
            if (hit) {
              stats.hits++;
              stats.hitBytes += hit.length;
              return hit;
            }
          }
          const bytes = await source.read(position, length);
          stats.misses++;
          // Kept in the background, as a copy: the caller may hand its bytes on (a transfer).
          if (!broken && bytes.length <= MAX_ENTRY_BYTES) put(key, bytes.slice()).then(ok, failed);
          return bytes;
        },
        close: () => source.close(),
      };
    },
    /** What is kept: { bytes, entries }. */
    async usage() {
      return transact([SIZES, META], 'readonly', async (s) => ({
        bytes: (await settle(s[META].get('total'))) ?? 0,
        entries: await settle(s[SIZES].count()),
      }));
    },
    async clear() {
      await transact([BLOCKS, SIZES, META], 'readwrite', (s) => {
        s[BLOCKS].clear();
        s[SIZES].clear();
        s[META].clear();
      });
    },
    close() {
      opening?.then((db) => db.close()).catch(() => {});
      opening = null;
    },
  };
}
