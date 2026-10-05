// Thin client for the vrlbry HTTP API (see SPEC.md §4). All functions throw on HTTP errors.

import { perf } from './perf.js';

// The site's root, from this module's own URL (js/api.js): the API is found whether the app is
// served at / (the Node server) or under a path (GitHub Pages, /vrlbry/).
const ROOT = new URL('../', import.meta.url);
const api = (path) => new URL(path, ROOT).href;

const chunkCache = new Map(); // `${lib}\n${id}\n${n}` -> Promise<blocks[]>
const metaCache = new Map(); // `${lib}\n${id}` -> Promise<meta>

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(`GET ${url}: ${msg}`);
  }
  if (!perf.enabled) return res.json();
  // Parsing happens on the main thread: a long Wikipedia article is ~200 KB of JSON.
  const text = await res.text();
  const t0 = performance.now();
  const value = JSON.parse(text);
  perf.event('json', { t: t0, ms: performance.now() - t0, kb: Math.round(text.length / 1024), url: url.slice(0, 120) });
  return value;
}

const enc = encodeURIComponent;

/** @returns {Promise<Array<object>>} library descriptors */
export async function getLibraries() {
  return (await getJSON(api('api/libraries'))).libraries;
}

/** @returns {Promise<{ generation: number, libraries: object[] }>} libraries + change counter */
export async function getCatalog() {
  const r = await getJSON(api('api/libraries'));
  // static: a build without a server (GitHub Pages): no rescans, nothing to index.
  return { generation: r.generation ?? 0, libraries: r.libraries, static: !!r.static };
}

/** @returns {Promise<{ changed: string|null, file: string|null }>} when the website's files last changed */
export async function getVersion() {
  return getJSON(api('api/version'));
}

/** Asks the server to re-read its ZIM folder now. */
export async function rescan() {
  const res = await fetch(api('api/rescan'), { method: 'POST' });
  if (!res.ok) throw new Error(`rescan: ${res.status} ${res.statusText}`);
  return res.json(); // { generation, added, removed, reopened, failed, libraries }
}

/** @returns {Promise<Array<object>>} book descriptors for one library */
export async function getBooks(libId) {
  return (await getJSON(api(`api/libraries/${enc(libId)}/books`))).books;
}

/** Wikipedia articles whose titles start with `q` (SPEC §2.5): [{ title, book, n }]. */
export async function searchArticles(libId, q, limit = 8) {
  return (await getJSON(api(`api/libraries/${enc(libId)}/articles?q=${enc(q)}&limit=${limit}`))).articles;
}

/** Book reading metadata: chunks, toc, totals. Cached. */
export function getBookMeta(libId, bookId) {
  const key = `${libId}\n${bookId}`;
  if (!metaCache.has(key)) {
    const p = getJSON(api(`api/libraries/${enc(libId)}/books/${enc(bookId)}`));
    p.catch(() => metaCache.delete(key));
    metaCache.set(key, p);
  }
  return metaCache.get(key);
}

/** Blocks of chunk `n`. Cached; concurrent calls share one request. */
export function getChunk(libId, bookId, n) {
  const key = `${libId}\n${bookId}\n${n}`;
  if (!chunkCache.has(key)) {
    const p = getJSON(api(`api/libraries/${enc(libId)}/books/${enc(bookId)}/chunks/${n}`)).then((r) => r.blocks);
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
