// Thin client for the vrlbry HTTP API (see SPEC.md §4). All functions throw on HTTP errors.
// Libraries opened in this browser (ids starting with '~', step 2) are answered by the local
// library instead (local/local.js), and their images come from there (imageSource).

import * as local from './local/local.js';
import { perf } from './perf.js';
import { titleKey } from './util/books.js';
import { fileName } from './util/file-names.js';

// The site's root, from this module's own URL (js/api.js): the API is found whether the app is
// served at / (the Node server) or under a path (GitHub Pages, /vrlbry/).
const ROOT = new URL('../', import.meta.url);
const api = (path) => new URL(path, ROOT).href;

// A static build (GitHub Pages, tools/build-pages.mjs) answers with files, and a path cannot be both
// a file and a folder: the catalogue is the file api/libraries, so a library's files are under
// api/library/<id>/ (books.json, books/<id>/index.json, books/<id>/chunks/<n>.json, titles.json),
// with ids as the build names their folders (fileName). Set by getCatalog().
let staticSite = false;
const seg = (id) => enc(staticSite ? fileName(id) : id);
const lib = (id) => `${staticSite ? 'api/library' : 'api/libraries'}/${seg(id)}`;
const paths = {
  books: (id) => `${lib(id)}/books${staticSite ? '.json' : ''}`,
  meta: (id, book) => `${lib(id)}/books/${seg(book)}${staticSite ? '/index.json' : ''}`,
  chunk: (id, book, n) => `${lib(id)}/books/${seg(book)}/chunks/${n}${staticSite ? '.json' : ''}`,
  titles: (id) => `${lib(id)}/titles.json`,
};

const chunkCache = new Map(); // `${lib}\n${id}\n${n}` -> Promise<blocks[]>
const metaCache = new Map(); // `${lib}\n${id}` -> Promise<meta>

async function getJSON(url, init) {
  const res = await fetch(url, init);
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

// What says which libraries and which version of the site there are is always checked with the
// server (a 304 when unchanged): GitHub Pages lets browsers reuse any file for 10 minutes, and a
// reload would otherwise keep showing the libraries of the previous deploy.
const FRESH = { cache: 'no-cache' };

/** @returns {Promise<Array<object>>} library descriptors */
export async function getLibraries() {
  return (await getJSON(api('api/libraries'), FRESH)).libraries;
}

/**
 * The server's (or static site's) libraries, then the local ones.
 * @param {{ generation?: number, libraries: object[] }} r the server's answer
 * @returns {Promise<{ generation: number|string, libraries: object[] }>} generation: a value that
 *   changes when either changes (the server's alone while nothing is open locally)
 */
async function withLocal(r) {
  const own = await local.catalog();
  if (!own.libraries.length) return { generation: r.generation ?? 0, libraries: r.libraries };
  return { generation: `${r.generation ?? 0}+${own.generation}`, libraries: [...r.libraries, ...own.libraries] };
}

/** @returns {Promise<{ generation: number|string, libraries: object[] }>} libraries + change counter */
export async function getCatalog() {
  const r = await getJSON(api('api/libraries'), FRESH);
  // static: a build without a server (GitHub Pages): no rescans, answers are files.
  staticSite = !!r.static;
  return { ...(await withLocal(r)), static: staticSite };
}

/** @returns {Promise<{ changed: string|null, file: string|null }>} when the website's files last changed */
export async function getVersion() {
  return getJSON(api('api/version'), FRESH);
}

/** Asks the server to re-read its ZIM folder now. */
export async function rescan() {
  const res = await fetch(api('api/rescan'), { method: 'POST' });
  if (!res.ok) throw new Error(`rescan: ${res.status} ${res.statusText}`);
  const r = await res.json(); // { generation, added, removed, reopened, failed, libraries }
  return { ...r, ...(await withLocal(r)) };
}

/** @returns {Promise<Array<object>>} book descriptors for one library */
export async function getBooks(libId) {
  if (local.isLocal(libId)) return local.books(libId);
  return (await getJSON(api(paths.books(libId)))).books;
}

/** Wikipedia articles whose titles start with `q` (SPEC §2.5): [{ title, book, n, from? }]. */
export async function searchArticles(libId, q, limit = 8) {
  if (local.isLocal(libId)) return []; // a local Wikipedia is not supported yet
  if (staticSite) return searchTitles(libId, q, limit);
  return (await getJSON(api(`api/libraries/${enc(libId)}/articles?q=${enc(q)}&limit=${limit}`))).articles;
}

const collator = new Intl.Collator(); // the server's title order (wikipedia.js), as util/books.js sorts
const titleLists = new Map(); // libId -> Promise<{ volumeSize, titles, keys }>

/**
 * The server's article search, in the browser of a static build: a prefix search over the sorted
 * title list (titles.json), by title key like the server (no other names: redirects are not there).
 */
async function searchTitles(libId, q, limit) {
  const qk = titleKey(String(q ?? '').replace(/\s+/g, ' ').trim());
  if (!qk) return [];
  if (!titleLists.has(libId)) {
    const p = getJSON(api(paths.titles(libId))).then((t) => ({ ...t, keys: t.titles.map(titleKey) }));
    p.catch(() => titleLists.delete(libId));
    titleLists.set(libId, p);
  }
  const { volumeSize, titles, keys } = await titleLists.get(libId);
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (collator.compare(keys[mid], qk) < 0) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < keys.length && out.length < limit && keys[i].startsWith(qk); i++) {
    out.push({ title: titles[i], book: `v${Math.floor(i / volumeSize) + 1}`, n: i % volumeSize });
  }
  const typed = String(q).replace(/\s+/g, ' ').trim().toLowerCase();
  const exact = out.findIndex((a) => a.title.toLowerCase() === typed);
  if (exact > 0) out.unshift(...out.splice(exact, 1));
  return out;
}

/**
 * Book reading metadata: chunks, toc, totals. Cached. `onProgress(fraction)` while a local book
 * is converted (the request that starts it).
 */
export function getBookMeta(libId, bookId, { onProgress } = {}) {
  const key = `${libId}\n${bookId}`;
  if (!metaCache.has(key)) {
    // Only a local book reports how far its conversion is (the server's answer just arrives).
    const p = local.isLocal(libId) ? local.meta(libId, bookId, { onProgress }) : getJSON(api(paths.meta(libId, bookId)));
    p.catch(() => metaCache.delete(key));
    metaCache.set(key, p);
  }
  return metaCache.get(key);
}

/** Blocks of chunk `n`. Cached; concurrent calls share one request. */
export function getChunk(libId, bookId, n) {
  const key = `${libId}\n${bookId}\n${n}`;
  if (!chunkCache.has(key)) {
    const p = (local.isLocal(libId) ? local.chunk(libId, bookId, n).then(parseLocal) : getJSON(api(paths.chunk(libId, bookId, n))))
      .then((r) => r.blocks);
    p.catch(() => chunkCache.delete(key));
    chunkCache.set(key, p);
  }
  return chunkCache.get(key);
}

const utf8 = new TextDecoder();

/** A local chunk's JSON bytes, parsed (timed like a fetched one under ?perf). */
function parseLocal(bytes) {
  const t0 = performance.now();
  const value = JSON.parse(utf8.decode(bytes));
  if (perf.enabled) perf.event('json', { t: t0, ms: performance.now() - t0, kb: Math.round(bytes.length / 1024), url: 'local' });
  return value;
}

/**
 * Where to load an image from: a local library's image becomes a blob URL (call release() once it
 * has loaded: the decoded image stays), any other URL is used as it is. url is null when a local
 * image is not there.
 * @param {string} url
 * @returns {Promise<{ url: string|null, release: () => void }>}
 */
export async function imageSource(url) {
  if (!local.isLocalUrl(url)) return { url, release() {} };
  const found = await local.image(url).catch(() => null);
  if (!found) return { url: null, release() {} };
  const blobUrl = URL.createObjectURL(new Blob([found.bytes], { type: found.mime }));
  return { url: blobUrl, release: () => URL.revokeObjectURL(blobUrl) };
}

/** Drop cached chunks for a book (e.g. after closing it, to free memory). */
export function forgetBook(libId, bookId) {
  const prefix = `${libId}\n${bookId}\n`;
  for (const k of chunkCache.keys()) if (k.startsWith(prefix)) chunkCache.delete(k);
}
