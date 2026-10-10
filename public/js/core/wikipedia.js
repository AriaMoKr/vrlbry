// Wikipedia ZIMs (mwoffliner) as a room of encyclopedia volumes (SPEC §2.5): the articles in the
// app's title order, cut into volumes of VOLUME_SIZE consecutive articles. The index needs titles
// only (no article is read), so building it is a scan of the directory plus one sort; it is built
// in the background on first open and kept in a store (the server's .cache/, server/cache-store.js)
// like the Wikisource index.

import { titleKey } from '../util/books.js';
import { platform } from './platform.js';
import { WIKIPEDIA_INDEX_VERSION } from './index-versions.js';

/** Bump it (core/index-versions.js) when the index format or what counts as an article changes. */
export const INDEX_VERSION = WIKIPEDIA_INDEX_VERSION;
/** Articles per volume. */
export const VOLUME_SIZE = 1000;
/**
 * Estimated text characters per byte of an article's HTML (mwoffliner pages carry markup,
 * references and styles): the reader estimates page numbers from it until an article is loaded.
 */
export const CHARS_PER_HTML_BYTE = 0.15;

/** Estimated characters of an article from its HTML size. */
export function articleChars(htmlBytes) {
  return Math.max(200, Math.round((htmlBytes || 0) * CHARS_PER_HTML_BYTE));
}

const HTML_MIME = /^(text\/html|application\/xhtml\+xml)\b/i;

/** True for a Wikipedia ZIM: Source "*.wikipedia.org", or a "wikipedia" tag. */
export function isWikipedia(meta) {
  const src = String(meta?.Source ?? '');
  const tags = String(meta?.Tags ?? '');
  return /(^|\.)wikipedia\.org$/i.test(src) || /(^|;)\s*wikipedia\s*(;|$)/i.test(tags);
}

/** The same order as util/books.js sorts book titles (titleKey, then a default Intl.Collator). */
const collator = new Intl.Collator();

/**
 * Builds the article index: the HTML entries of the article namespace but redirects, the main
 * page, mwoffliner's own pages and the pages that sizePages finds are not articles, in title
 * order, and the volumes cut from it.
 * @param {import('./zim/reader.js').ZimArchive} archive
 * Stages: 'scan' (the directory), 'sizes' (sizePages: resumable with `checkpoint`), 'sort'.
 * @param {{ volumeSize?: number, onProgress?: (stage: string, fraction: number) => void, log?: (msg: string) => void,
 *   store?: object|null, checkpoint?: string|null, checkpointEvery?: number, lanes?: number }} [opts] checkpoint:
 *   base name in `store` (checkpointName) where the sizes pass keeps its progress; lanes: clusters
 *   decompressed at once
 * @returns {Promise<{ version, uuid, ns, volumeSize, count, order: Uint32Array, sizes: Uint32Array, volumes: Array<[string, string]> }>}
 *   order: entry indices in title order; sizes: their HTML bytes; volumes: [first title, last title]
 */
export async function buildIndex(archive, {
  volumeSize = VOLUME_SIZE, onProgress = () => {}, log = () => {},
  store = null, checkpoint = null, checkpointEvery = CHECKPOINT_EVERY, lanes = SIZE_LANES,
} = {}) {
  const ns = archive.newNamespaceScheme ? 'C' : 'A';
  const start = await archive.lowerBound(ns, '');
  const end = await archive.lowerBound(String.fromCharCode(ns.charCodeAt(0) + 1), '');
  const main = await archive.getMainEntry().catch(() => null);
  // 1. Scan: the candidates (non-redirect HTML entries but the main page), in typed arrays: the
  // full English Wikipedia has over 10 million, and an object each cost about a gigabyte more.
  let index = new Uint32Array(1 << 16);
  let cluster = new Uint32Array(1 << 16);
  let blob = new Uint32Array(1 << 16);
  const titles = [];
  let n = 0;
  let own = 0;
  const total = Math.max(1, end - start);
  let seen = 0;
  for await (const e of archive.entries(start, end)) {
    if (++seen % 20000 === 0) onProgress('scan', seen / total);
    if (e.isRedirect || !e.mime || !HTML_MIME.test(e.mime)) continue;
    if (main && e.index === main.index) continue;
    if (e.url.startsWith('_')) { // mwoffliner's own pages (a category's list in parts); no title starts with "_"
      own++;
      continue;
    }
    if (n === index.length) {
      index = grown(index);
      cluster = grown(cluster);
      blob = grown(blob);
    }
    index[n] = e.index;
    cluster[n] = e.cluster ?? NO_CLUSTER;
    blob[n] = e.blob ?? 0;
    titles.push(e.title || e.url);
    n++;
  }
  onProgress('scan', 1);
  // 2. Sizes (sizePages): they estimate article lengths, and each page's first bytes give away
  // mwoffliner's redirect pages and the pages that are not articles.
  const sizes = await sizePages(archive, {
    n, index, cluster, blob, onProgress, log, checkpoint: store && checkpoint ? { store, base: checkpoint } : null, checkpointEvery, lanes,
  });
  // 3. The articles in title order (ties: the entry index, so the order is always the same).
  let articles = 0;
  let redirects = 0;
  for (let i = 0; i < n; i++) {
    if (sizes[i] === REDIRECT_PAGE) redirects++;
    else if (sizes[i] !== OTHER_PAGE) articles++;
  }
  const pick = new Uint32Array(articles);
  for (let i = 0, k = 0; i < n; i++) if (sizes[i] < OTHER_PAGE) pick[k++] = i;
  log(` ${articles} articles (skipped: ${redirects} redirect pages, ${n - articles - redirects} pages of other namespaces`
    + ` or not downloaded, ${own} of mwoffliner's own); sorting titles…`);
  const keys = new Array(articles);
  for (let j = 0; j < articles; j++) keys[j] = titleKey(titles[pick[j]]);
  const perm = new Uint32Array(articles);
  for (let j = 0; j < articles; j++) perm[j] = j;
  perm.sort((a, b) => collator.compare(keys[a], keys[b]) || collator.compare(titles[pick[a]], titles[pick[b]])
    || index[pick[a]] - index[pick[b]]);
  onProgress('sort', 1);
  const order = new Uint32Array(articles);
  const articleSizes = new Uint32Array(articles);
  for (let j = 0; j < articles; j++) {
    order[j] = index[pick[perm[j]]];
    articleSizes[j] = sizes[pick[perm[j]]];
  }
  const volumes = [];
  for (let from = 0; from < articles; from += volumeSize) {
    const to = Math.min(articles, from + volumeSize);
    volumes.push([titles[pick[perm[from]]], titles[pick[perm[to - 1]]]]);
  }
  return { version: INDEX_VERSION, uuid: archive.header.uuid, ns, volumeSize, count: articles, order, sizes: articleSizes, volumes };
}

/** Clusters decompressed at once while sizing pages (zstd runs on the libuv thread pool). */
const SIZE_LANES = 6;
/** Finished page sizes are appended to the checkpoint whenever this many more are done. */
const CHECKPOINT_EVERY = 100000;
const CHECKPOINT_VERSION = 1;
/** A page's size slot when it is a mwoffliner redirect page (in sizePages and its checkpoint). */
const REDIRECT_PAGE = 0xffffffff;
/** … when it is not an article (pageKind). Real sizes stay below both. */
const OTHER_PAGE = 0xfffffffe;
/** The cluster of an entry without content: sized 0. */
const NO_CLUSTER = 0xffffffff;

const grown = (a) => {
  const b = new Uint32Array(a.length * 2);
  b.set(a);
  return b;
};

/**
 * The HTML size of every candidate (by scan position), or what its first bytes say it is instead
 * (pageKind). In cluster order, so that each cluster is decompressed once, using the scan's
 * cluster and blob (re-reading each entry made the full English Wikipedia take ~7 hours), and
 * `lanes` clusters at once. With `checkpoint` ({ store, base }) the sizes done are appended to
 * <base>.bin in the store as they finish, so an interrupted build resumes here after a new scan.
 */
async function sizePages(archive, { n, index, cluster, blob, onProgress, log, checkpoint, checkpointEvery, lanes }) {
  const byCluster = new Uint32Array(n);
  for (let i = 0; i < n; i++) byCluster[i] = i;
  byCluster.sort((a, b) => cluster[a] - cluster[b] || blob[a] - blob[b]);
  const sizes = new Uint32Array(n);
  const ck = checkpoint ? await openCheckpoint(checkpoint.store, checkpoint.base, { n, fingerprint: scanFingerprint(n, byCluster, index) }) : null;
  const done = ck?.done ?? 0;
  for (let p = 0; p < done; p++) sizes[byCluster[p]] = ck.prior[p];
  if (done) log(` resuming: ${done} of ${n} page sizes from the checkpoint`);
  const finished = new Uint8Array(n);
  finished.fill(1, 0, done);
  // Progress counts clusters, not pages: each costs about one decompression, while the pages in
  // one vary (mwoffliner's redirect pages are tiny and stored together at the end, so counted in
  // pages the top 1M's second half took 19 s of 115).
  const runStart = (p) => p === 0 || cluster[byCluster[p]] !== cluster[byCluster[p - 1]];
  let runsBefore = 0;
  for (let p = 0; p < done; p++) if (runStart(p)) runsBefore++;
  let runs = 0;
  for (let p = done; p < n; p++) if (p === done || runStart(p)) runs++;
  let runsDone = 0;
  let next = done; // next position (in cluster order) to hand out
  let flushed = done; // positions before this are in the checkpoint
  let writing = Promise.resolve();
  const flush = (all) => {
    let to = flushed;
    while (to < n && finished[to]) to++;
    if (to === flushed || (!all && to - flushed < checkpointEvery)) return;
    const part = new Uint32Array(to - flushed);
    for (let p = flushed; p < to; p++) part[p - flushed] = sizes[byCluster[p]];
    flushed = to;
    writing = writing.then(() => ck.append(part));
  };
  let failure = null; // the first lane's error stops the others
  const lane = async () => {
    while (!failure && next < n) {
      // A run of pages in one cluster (claimed before any await, so lanes never share one).
      const from = next;
      const c = cluster[byCluster[from]];
      let to = from + 1;
      while (to < n && cluster[byCluster[to]] === c) to++;
      next = to;
      if (c !== NO_CLUSTER) {
        const blobs = [];
        for (let p = from; p < to; p++) blobs.push(blob[byCluster[p]]);
        const out = await archive.clusterBlobs(c, blobs, { head: PAGE_HEAD, cache: false, compressed: true }); // HTML: compressed
        for (let k = 0; k < out.length; k++) sizes[byCluster[from + k]] = pageKind(out[k].size, out[k].data);
      }
      finished.fill(1, from, to);
      onProgress('sizes', (runsBefore + ++runsDone) / (runsBefore + runs));
      if (ck) flush(false);
    }
  };
  // Every lane settles before this returns (no work left running after a failure), and what is
  // finished is kept for the next build either way.
  await Promise.all(Array.from({ length: lanes }, () => lane().catch((err) => {
    failure ??= err;
  })));
  if (ck) {
    flush(true);
    await writing;
  }
  if (failure) throw failure;
  onProgress('sizes', 1);
  return sizes;
}

/** A page whose content says it is a mwoffliner redirect page. */
const REFRESH = /<meta[^>]+http-equiv=["']?refresh/i;
/** Pages at most this big are checked for being a redirect page (real articles are far bigger). */
const REDIRECT_PAGE_MAX = 1024;
/** Bytes read from the start of each page for pageKind (mwoffliner's marks are within ~1.3 KB). */
const PAGE_HEAD = 4096;
const NAMESPACE = new TextEncoder().encode('"wgNamespaceNumber":');
const PLACEHOLDER = new TextEncoder().encode('download_error_placeholder');

/**
 * A page's size, or REDIRECT_PAGE for a mwoffliner redirect page (a redirect to a section stored
 * as a tiny page with a meta refresh), or OTHER_PAGE for a page of another Wikipedia namespace
 * (categories, portals: newer mwoffliner includes them, and writes every page's namespace number
 * into its settings, `"wgNamespaceNumber":14`) or a placeholder for a page it could not download
 * ("Oops. Page not found"). Only the content gives these away. A page without the namespace mark
 * (older ZIMs, which have no such pages) counts as an article.
 * @param {number} size
 * @param {Uint8Array|null} head the page's first PAGE_HEAD bytes
 */
function pageKind(size, head) {
  if (!head) return Math.min(size, OTHER_PAGE - 1);
  if (size <= REDIRECT_PAGE_MAX && REFRESH.test(platform.utf8(head))) return REDIRECT_PAGE;
  const at = platform.indexOf(head, NAMESPACE);
  if (at >= 0) {
    const ns = /^\s*(-?\d+)/.exec(platform.latin1(head, at + NAMESPACE.length, Math.min(head.length, at + NAMESPACE.length + 12)));
    if (ns && ns[1] !== '0') return OTHER_PAGE;
  }
  if (platform.indexOf(head, PLACEHOLDER) >= 0) return OTHER_PAGE;
  return Math.min(size, OTHER_PAGE - 1);
}

/** Identifies a scan's candidates in cluster order (a checkpoint only fits the same scan). */
function scanFingerprint(n, byCluster, index) {
  let h = 2166136261;
  for (let p = 0; p < n; p++) {
    h ^= index[byCluster[p]];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/**
 * The base name under which a Wikipedia index being built keeps its progress in a store:
 * <base>.json (what for) and <base>.bin (the sizes).
 */
export function checkpointName(archive) {
  return `wikipedia-${archive.header.uuid}.v${INDEX_VERSION}.part`;
}

/**
 * Opens a checkpoint: the sizes it holds when it was made for this scan (count and fingerprint),
 * else a fresh one. A partly written last size is cut off.
 */
async function openCheckpoint(store, base, { n, fingerprint }) {
  const meta = `${base}.json`;
  const bin = `${base}.bin`;
  let done = 0;
  let prior = null;
  try {
    const m = JSON.parse((await store.readText(meta)) ?? 'null');
    if (m?.version === CHECKPOINT_VERSION && m.count === n && m.fingerprint === fingerprint) {
      const buf = await store.readBytes(bin);
      done = buf ? Math.min(n, Math.floor(buf.length / 4)) : 0;
      if (done) prior = new Uint32Array(new Uint8Array(buf.subarray(0, done * 4)).buffer); // copied: aligned
      if (buf && buf.length !== done * 4) await store.truncate(bin, done * 4);
    }
  } catch {
    done = 0; // unreadable: start afresh
  }
  if (!done) {
    await store.writeText(meta, JSON.stringify({ version: CHECKPOINT_VERSION, count: n, fingerprint }));
    await store.writeBytes(bin, new Uint8Array(0));
  }
  return { done, prior, append: (u32) => store.appendBytes(bin, new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength)) };
}

/** Deletes a checkpoint (once the index it was for is saved). */
export async function removeCheckpoint(store, base) {
  await Promise.all([store.remove(`${base}.json`), store.remove(`${base}.bin`)]);
}

/** Most results a search returns. */
export const SEARCH_LIMIT = 50;

/**
 * Articles whose title starts with `query`, in title order. Matching uses the index's own key
 * (titleKey: case, accents, a leading "The" and punctuation are ignored), so a binary search over
 * the sorted index finds the first match after reading ~log2(count) directory entries.
 * @param {import('./zim/reader.js').ZimArchive} archive
 * @param {{ order: Uint32Array, count: number }} idx
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{ title: string, position: number }>>} position: index in title order
 */
export async function searchIndex(archive, idx, query, limit = 12) {
  const qk = titleKey(String(query ?? '').replace(/\s+/g, ' ').trim());
  if (!qk) return [];
  limit = Math.max(1, Math.min(SEARCH_LIMIT, limit | 0 || 12));
  const out = [];
  // The first `limit` titles from the bound, read together (getEntriesByIndex), not one by one.
  const from = await lowerBoundKey(archive, idx, qk);
  const entries = await archive.getEntriesByIndex(Array.from(idx.order.subarray(from, Math.min(idx.count, from + limit))));
  for (let k = 0; k < entries.length; k++) {
    const title = entries[k].title || entries[k].url;
    if (!titleKey(title).startsWith(qk)) break;
    out.push({ title: title.replace(/\s+/g, ' ').trim(), position: from + k });
  }
  // The article titled exactly as typed comes first ("Paris" before ".paris").
  const typed = String(query).replace(/\s+/g, ' ').trim().toLowerCase();
  const exact = out.findIndex((a) => a.title.toLowerCase() === typed);
  if (exact > 0) out.unshift(...out.splice(exact, 1));
  return out;
}

/** The title of the article at `position` in title order. */
async function titleAt(archive, idx, position) {
  const e = await archive.getEntryByIndex(idx.order[position]);
  return e.title || e.url;
}

/**
 * First position in title order whose title key is not before `key` (binary search), within the
 * volume that the volumes' first and last titles (in memory) say it is in: a million articles
 * then cost the reads of 10 steps instead of 20 (each a round trip over the network).
 */
async function lowerBoundKey(archive, idx, key) {
  let [lo, hi] = volumeBounds(idx, key);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (collator.compare(titleKey(await titleAt(archive, idx, mid)), key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The positions [lo, hi] that hold `key`'s lower bound, from the volumes' titles alone. */
function volumeBounds(idx, key) {
  const vols = idx.volumes;
  if (!vols?.length || !idx.volumeSize) return [0, idx.count];
  const before = (title) => collator.compare(titleKey(title), key) < 0;
  // Volumes [0, a) end before the key: their articles all do.
  let a = 0;
  for (let b = vols.length; a < b;) {
    const m = (a + b) >>> 1;
    if (before(vols[m][1])) a = m + 1;
    else b = m;
  }
  // From volume c on, volumes begin at or after it: the bound is at most c's first position.
  let c = a;
  for (let d = vols.length; c < d;) {
    const m = (c + d) >>> 1;
    if (before(vols[m][0])) c = m + 1;
    else d = m;
  }
  const lo = Math.min(idx.count, a * idx.volumeSize);
  return [lo, Math.max(lo, Math.min(idx.count, c * idx.volumeSize))];
}

/** Position of an article entry in title order, or -1 when it is not an article of the index. */
async function positionOf(archive, idx, entry) {
  const key = titleKey(entry.title || entry.url);
  for (let i = await lowerBoundKey(archive, idx, key), n = 0; i < idx.count && n < 64; i++, n++) {
    if (idx.order[i] === entry.index) return i;
    if (titleKey(await titleAt(archive, idx, i)) !== key) break;
  }
  return -1;
}

/** Most URL-index entries looked at per spelling of a redirect search. */
const REDIRECT_SCAN = 400;
/** Redirects of a spelling resolved at once (each a search of the title order). */
const RESOLVE_AT_ONCE = 8;

/**
 * Redirects whose titles start with `query` ("NYC" → "New York City"): the other names of
 * articles. ZIM redirects are entries of the URL index, and Wikipedia URLs are titles with "_"
 * for spaces, so a prefix search over URLs finds them. URLs are case-sensitive, so the query is
 * tried as typed, with a capital first letter, in capitals and in title case.
 * @returns {Promise<Array<{ from: string, title: string, position: number }>>} position: of the
 *   target article in title order
 */
export async function searchRedirects(archive, idx, query, limit = 12) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return [];
  limit = Math.max(1, Math.min(SEARCH_LIMIT, limit | 0 || 12));
  const spellings = [...new Set([
    q, q.charAt(0).toUpperCase() + q.slice(1), q.toUpperCase(),
    q.replace(/(^|\s)(\S)/g, (m, s, c) => s + c.toUpperCase()),
  ])];
  // The spellings are searched at once (each a binary search: round trips over the network), and
  // a spelling's redirects resolved a few at a time; the results keep the spellings' order.
  const found = await Promise.all(spellings.map(async (s) => {
    const prefix = s.replace(/ /g, '_');
    const start = await archive.lowerBound(idx.ns, prefix);
    const redirects = [];
    let n = 0;
    for await (const e of archive.entries(start, archive.entryCount)) {
      if (e.ns !== idx.ns || !e.url.startsWith(prefix) || ++n > REDIRECT_SCAN) break;
      if (e.isRedirect) redirects.push(e);
    }
    const hits = [];
    for (let i = 0; i < redirects.length && hits.length < limit; i += RESOLVE_AT_ONCE) {
      const batch = await Promise.all(redirects.slice(i, i + RESOLVE_AT_ONCE).map(async (e) => {
        const target = await archive.resolveRedirect(e).catch(() => null);
        if (!target || target.isRedirect) return null;
        const position = await positionOf(archive, idx, target);
        if (position < 0) return null; // not an article (e.g. a file)
        return { index: e.index, from: (e.title || e.url).replace(/\s+/g, ' ').trim(), title: (target.title || target.url).replace(/\s+/g, ' ').trim(), position };
      }));
      for (const hit of batch) if (hit) hits.push(hit);
    }
    return hits;
  }));
  const out = [];
  const seen = new Set();
  for (const { index, ...hit } of found.flat()) {
    if (out.length >= limit) break;
    if (seen.has(index)) continue;
    seen.add(index);
    out.push(hit);
  }
  return out;
}

/** The name of an archive's index in a store. */
export function indexName(archive) {
  return `wikipedia-${archive.header.uuid}.v${INDEX_VERSION}.json`;
}

/** Loads a stored index (order decoded to a Uint32Array), or null when absent/stale/corrupt. */
export async function loadIndex(store, name, archive) {
  try {
    const raw = JSON.parse((await store.readText(name)) ?? 'null');
    if (raw?.version !== INDEX_VERSION || raw.uuid !== archive.header.uuid || !Array.isArray(raw.volumes)) return null;
    // Copied out of the decoded bytes: their offsets may be unaligned for a Uint32Array.
    const u32 = (b64) => new Uint32Array(new Uint8Array(platform.fromBase64(b64)).buffer);
    const order = u32(raw.order);
    const sizes = u32(raw.sizes);
    if (order.length !== raw.count || sizes.length !== raw.count) return null;
    return { ...raw, order, sizes };
  } catch {
    return null;
  }
}

/** Saves an index in a store; `order` and `sizes` are stored as base64. */
export async function saveIndex(store, name, idx) {
  const b64 = (a) => platform.toBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  await store.writeText(name, JSON.stringify({ ...idx, order: b64(idx.order), sizes: b64(idx.sizes) }));
}

/** The title of a volume: its range ("Aachen – Abbey"), or the one title of a one-article volume. */
export function volumeTitle([first, last]) {
  return first === last ? first : `${first} – ${last}`;
}
