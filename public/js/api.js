// Thin client for the vrlbry HTTP API (see SPEC.md §4). All functions throw on HTTP errors.

const chunkCache = new Map(); // `${lib}\n${id}\n${n}` -> Promise<blocks[]>
const metaCache = new Map(); // `${lib}\n${id}` -> Promise<meta>

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(`GET ${url}: ${msg}`);
  }
  return res.json();
}

const enc = encodeURIComponent;

/** @returns {Promise<Array<object>>} library descriptors */
export async function getLibraries() {
  return (await getJSON('/api/libraries')).libraries;
}

/** @returns {Promise<Array<object>>} book descriptors for one library */
export async function getBooks(libId) {
  return (await getJSON(`/api/libraries/${enc(libId)}/books`)).books;
}

/** Book reading metadata: chunks, toc, totals. Cached. */
export function getBookMeta(libId, bookId) {
  const key = `${libId}\n${bookId}`;
  if (!metaCache.has(key)) {
    const p = getJSON(`/api/libraries/${enc(libId)}/books/${enc(bookId)}`);
    p.catch(() => metaCache.delete(key));
    metaCache.set(key, p);
  }
  return metaCache.get(key);
}

/** Blocks of chunk `n`. Cached; concurrent calls share one request. */
export function getChunk(libId, bookId, n) {
  const key = `${libId}\n${bookId}\n${n}`;
  if (!chunkCache.has(key)) {
    const p = getJSON(`/api/libraries/${enc(libId)}/books/${enc(bookId)}/chunks/${n}`).then((r) => r.blocks);
    p.catch(() => chunkCache.delete(key));
    chunkCache.set(key, p);
  }
  return chunkCache.get(key);
}

/** Drop cached chunks for a book (e.g. after closing it, to free memory). */
export function forgetBook(libId, bookId) {
  const prefix = `${libId}\n${bookId}\n`;
  for (const k of chunkCache.keys()) if (k.startsWith(prefix)) chunkCache.delete(k);
}
