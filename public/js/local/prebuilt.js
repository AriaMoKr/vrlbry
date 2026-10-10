// Prebuilt indexes for the local library (SPEC §2.6): a site can ship the index of a ZIM under
// indexes/<name> (the name the core gives it, with the ZIM's UUID: core/wikipedia.js and
// core/wikisource.js indexName; tools/build-pages.mjs --indexes writes them), so that opening
// that file skips the build, which takes a headset minutes for a big Wikipedia. withPrebuilt
// wraps a store: an index the store lacks is fetched, kept in the store, and read from there
// after. memoryStore is the store when IndexedDB is unavailable: for the session only.

/** Names of the indexes a site may ship (not checkpoints or anything else). */
const PREBUILT_NAME = /^wiki(?:pedia|source)-[0-9a-f]{32}\.v\d+\.json$/;

/**
 * @param {object} store the store (idb-store.js, memoryStore)
 * @param {(name: string) => Promise<string|null>} fetchIndex the index's text from the site, or
 *   null when the site has none (worker.js fetches indexes/<name> beside the app)
 * @returns {object} the same store, with that fallback on readText
 */
export function withPrebuilt(store, fetchIndex) {
  const pending = new Map(); // name → Promise<string|null>: one fetch per name at a time
  return {
    ...store,
    async readText(name) {
      const own = await store.readText(name);
      if (own !== null || !PREBUILT_NAME.test(name)) return own;
      let p = pending.get(name);
      if (!p) {
        p = (async () => {
          const text = await fetchIndex(name).catch(() => null);
          if (text) await store.writeText(name, text).catch(() => {}); // kept, if the store can
          return text || null;
        })();
        const done = () => pending.delete(name);
        p.then(done, done);
        pending.set(name, p);
      }
      return p;
    },
  };
}

/** A store in memory (the server's interface, server/cache-store.js): lost with the page. */
export function memoryStore() {
  const map = new Map(); // name → string | Uint8Array
  const bytes = (v) => (v == null ? null : v instanceof Uint8Array ? v : new TextEncoder().encode(v));
  return {
    readText: async (name) => { const v = map.get(name); return v == null ? null : typeof v === 'string' ? v : new TextDecoder().decode(v); },
    readBytes: async (name) => bytes(map.get(name)),
    writeText: async (name, text) => { map.set(name, String(text)); },
    writeBytes: async (name, b) => { map.set(name, new Uint8Array(b)); },
    appendBytes: async (name, b) => {
      const prior = bytes(map.get(name)) ?? new Uint8Array(0);
      const out = new Uint8Array(prior.length + b.length);
      out.set(prior);
      out.set(b, prior.length);
      map.set(name, out);
    },
    truncate: async (name, size) => {
      const prior = bytes(map.get(name));
      if (prior && prior.length > size) map.set(name, prior.slice(0, size));
    },
    remove: async (name) => { map.delete(name); },
    names: async () => [...map.keys()],
    close() {},
  };
}
