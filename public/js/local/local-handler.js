// The local library: ZIM files someone opened in the browser (step 2, SPEC §2.6), read with the
// shared core over File.slice, or from a web address over range requests (milestone 3: Kiwix's
// mirror). worker.js runs this in a Web Worker; Node tests call it directly.
// Each method answers one request of local.js: { value, transfer } with the buffers to move.
//
// Library ids start with '~' (libraryIdFor never makes one), so they cannot clash with a server's.
// Their URLs are the core's (/zim/~id/…, /api/libraries/~id/books/…/res/…): the page asks for
// those images here (image()) instead of fetching them.

import { ArchiveLibrary, createContentCache, libraryIdFor } from '../core/library.js';
import { IndexQueue } from '../core/util/index-queue.js';
import { ZimArchive } from '../core/zim/reader.js';
import { HttpSource, HttpSourceError } from '../core/zim/http-source.js';
import { fileNameOf, URL_BOOK_LOOKUPS, URL_INDEX_BUILD_BYTES } from './zim-url.js';

/** Converted books kept for all local libraries: a headset has far less memory than a PC. */
const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
/** Decompressed clusters kept per archive. */
const CLUSTER_CACHE_BYTES = 32 * 1024 * 1024;
/** The block cache per file (ZimArchive blockCacheBytes): a 4.5 GB Gutenberg ZIM's whole directory is 1.7 MB. */
const BLOCK_CACHE_BYTES = 16 * 1024 * 1024;
/** Uncompressed clusters up to this big are read whole (ZimArchive wholeClusterBytes): a read costs the same however big. */
const WHOLE_CLUSTER_BYTES = 4 * 1024 * 1024;
/** How a File is read: a read costs about the same however big (~65 ms on a Quest). */
const FILE_ARCHIVE = {
  clusterCacheBytes: CLUSTER_CACHE_BYTES, blockCacheBytes: BLOCK_CACHE_BYTES, wholeClusterBytes: WHOLE_CLUSTER_BYTES,
  wholeCompressedBytes: WHOLE_CLUSTER_BYTES, // a compressed cluster in one read, not two
};
/**
 * How a web address is read, as measured from Kiwix's mirror (TODO, milestone 3 step 2): a round
 * trip costs 0.2-0.8 s and bytes cost time too, so small blocks (lookups touch scattered entries:
 * 8 KB was fastest), pictures one by one (a 4 MB cluster read whole took seconds), and a
 * compressed cluster in one read.
 */
const URL_ARCHIVE = {
  clusterCacheBytes: CLUSTER_CACHE_BYTES, blockCacheBytes: BLOCK_CACHE_BYTES, blockBytes: 8 * 1024,
  wholeClusterBytes: 0, wholeCompressedBytes: WHOLE_CLUSTER_BYTES,
};

export const LOCAL_PREFIX = '~';

/** A refusal or a problem with a file, with a message for the person who opened it. */
export class LocalError extends Error {}

/**
 * @param {{ log?: (msg: string) => void, warn?: (msg: string) => void, store?: object|null, onChange?: () => void,
 *   urlIndexBuildBytes?: number, urlBookLookups?: number, blockCache?: object|null }} [opts]
 *   store: where derived indexes are kept (idb-store.js; the server's shape, server/cache-store.js),
 *   or null: a Wikipedia's index is built every time and kept in memory only; onChange: called
 *   when a library's catalogue changes on its own (its index finished): the generation is new;
 *   onIndexing(id, info, fileName): a library's index build moved on ({ stage, progress },
 *   'failed' with `error`, or null once ready); fileName names it before the open answers;
 *   urlIndexBuildBytes, urlBookLookups: URL_INDEX_BUILD_BYTES, URL_BOOK_LOOKUPS (for tests); blockCache: block-cache.js's, which keeps
 *   what is read from the web (optional: without it every read goes to the network)
 */
export function createLocalLibraries({
  log = () => {}, warn = log, store = null, onChange = null, onIndexing = null, urlIndexBuildBytes = URL_INDEX_BUILD_BYTES,
  urlBookLookups = URL_BOOK_LOOKUPS, blockCache = null,
} = {}) {
  const libs = new Map(); // id → ArchiveLibrary
  const urls = new Map(); // id → the web address of a library read from one
  const sites = new Set(); // ids of libraries the site itself ships (open({ site }))
  const contentCache = createContentCache(CONTENT_CACHE_BYTES);
  // Index builds one at a time, the smallest first, whatever their size: they share the worker's
  // one thread, so at once each only ended later (six files opened together all waited for the
  // last), while in turn the first is on the shelves in seconds.
  const indexQueue = new IndexQueue({ smallBytes: 0 });
  let generation = 0;

  const lib = (id) => {
    const l = libs.get(id);
    if (!l) throw new LocalError(`no local library ${id}`);
    return l;
  };

  /** A local library's URL: [libId, ...path segments], or null when it is not one. */
  const parse = (url) => {
    const segs = String(url).replace(/^(\.?\/)+/, '').split(/[?#]/)[0].split('/').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    if (segs[0] === 'zim' && segs[1]?.startsWith(LOCAL_PREFIX)) return { id: segs[1], path: segs.slice(2).join('/') };
    if (segs[0] === 'api' && segs[1] === 'libraries' && segs[2]?.startsWith(LOCAL_PREFIX) && segs[3] === 'books' && segs[5] === 'res') {
      return { id: segs[2], book: segs[4], res: segs.slice(6).join('/') };
    }
    return null;
  };

  const methods = {
    /**
     * Opens a File (or Blob), or a ZIM at a web address (`url`, as zim-url.js makes it: the server
     * must allow range requests and, from another site, CORS): { id, title, kind, books, indexing,
     * url? }. A Wikipedia's or Wikisource's index is built in the background when none is found,
     * but from the web only up to URL_INDEX_BUILD_BYTES (it would read most of the file). `via`:
     * the same file through the site's edge proxy (zim-url.js proxiedUrl), read first while it
     * works; the library is still the file's (`url`). `site`: a ZIM the site itself ships (the
     * main site's demo set): its catalogue entry says so (`site: true`).
     */
    async open({ file, url, via = null, site = false }, { onProgress } = {}) {
      const t0 = performance.now();
      const remote = typeof url === 'string';
      const name = (remote ? fileNameOf(url) : file.name) || 'archive.zim';
      // From the web, through the block cache when there is one (it keeps what is read).
      const source = remote
        ? await HttpSource.open(url, {
          via,
          onFallback: (err) => warn(`${name}: the proxy failed (${err.message}): reading ${new URL(url).hostname} directly`),
        }).then((http) => blockCache?.wrap(http) ?? http, (err) => {
          throw new LocalError(err instanceof HttpSourceError ? err.message : `${name}: ${err.message}`);
        })
        : file;
      // Opened once: the library takes the archive over.
      const archive = await ZimArchive.open(source, remote ? URL_ARCHIVE : FILE_ARCHIVE).catch((err) => {
        // A server's refusal says what it is (no ranges, not found, unreachable or CORS).
        const refusal = err instanceof HttpSourceError ? err : err.cause instanceof HttpSourceError ? err.cause : null;
        if (refusal) throw new LocalError(refusal.message);
        throw new LocalError(`${name}: not a readable ZIM file (${err.message})`);
      });
      const base = LOCAL_PREFIX + libraryIdFor(name);
      let id = base;
      for (let n = 2; libs.has(id); n++) id = `${base}-${n}`;
      // Sizes estimated, not read: on a Quest they cost a read per cluster of books (8 s of the
      // 4.5 GB Gutenberg ZIM's open), for a thickness on the shelf. A Wikipedia or Wikisource
      // file is indexed in the background (its index kept in the store, so once per file) and
      // has no books until then: info().indexing says how far it is.
      const opened = await ArchiveLibrary.open(archive, {
        id, log, warn, contentCache, onProgress, estimateSizes: true, store, indexQueue,
        // From the web: a sized image is not looked up (each lookup costs round trips), and an
        // index is built only for a small archive.
        ...(remote ? { checkImages: false, maxIndexBuildBytes: urlIndexBuildBytes, bookLookups: urlBookLookups } : {}),
        onChange: () => {
          generation++;
          onChange?.();
        },
        onIndexing: (info) => onIndexing?.(id, info, name),
      });
      libs.set(id, opened);
      if (remote) urls.set(id, url);
      if (remote && site) sites.add(id);
      generation++;
      const info = await opened.info();
      const took = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
      log(info.indexing ? `${name}: ${opened.kind} library, indexing (${info.indexing.stage}) after ${took}`
        : `${name}: ${opened.kind} library, ${info.bookCount} book(s), opened in ${took}`);
      return { value: { id, title: info.title, kind: opened.kind, books: info.bookCount, indexing: info.indexing, ...(remote ? { url } : {}), ...(sites.has(id) ? { site: true } : {}) } };
    },

    /** The catalogue: { generation, libraries: [info, with `url` when read from the web] } in the order they were opened. */
    async catalog() {
      const libraries = await Promise.all([...libs].map(async ([id, l]) => {
        const info = await l.info();
        return urls.has(id) ? { ...info, url: urls.get(id), ...(sites.has(id) ? { site: true } : {}) } : info;
      }));
      return { value: { generation, libraries } };
    },

    async books({ lib: id }) {
      return { value: await lib(id).books() };
    },

    /** A Wikipedia's articles by title prefix, and by other names (redirects): as the server's route. */
    async articles({ lib: id, q, limit }) {
      return { value: await lib(id).searchArticles(q, limit) };
    },

    /** Where a link of a book leads (resolveLink): as the server's route; null when nowhere. */
    async link({ lib: id, book, href }) {
      return { value: await lib(id).resolveLink(book, href) };
    },

    async meta({ lib: id, book }, { onProgress } = {}) {
      const l = lib(id);
      if (!(await l.book(book))) throw new LocalError(`unknown book: ${book}`);
      return { value: (await l.content(book, { onProgress })).meta };
    },

    /** A chunk's JSON as bytes (a copy: the cached chunk keeps its own). */
    async chunk({ lib: id, book, n }) {
      const chunk = await lib(id).chunk(book, n);
      if (!chunk) throw new LocalError(`chunk ${n} of ${book} is out of range`);
      const json = chunk.json.slice();
      return { value: json, transfer: [json.buffer] };
    },

    /** The bytes and type of an image (or other resource) a local book refers to, or null. */
    async image({ url }) {
      const at = parse(url);
      const l = at && libs.get(at.id);
      if (!l) return { value: null };
      let found = null;
      if (at.res !== undefined) {
        found = await l.resource(at.book, at.res);
      } else {
        const entry = await l.archive.findPath(at.path);
        const target = entry && await l.archive.resolveRedirect(entry);
        const content = target && target.cluster !== null ? await l.archive.getContent(target) : null;
        if (content) found = { data: content.data, mime: content.mime };
      }
      if (!found) return { value: null };
      const bytes = found.data.slice();
      return { value: { bytes, mime: found.mime }, transfer: [bytes.buffer] };
    },

    /** Closes a library: also stops its index build, running or waiting (a cancel). */
    async close({ lib: id }) {
      const l = libs.get(id);
      if (l) {
        libs.delete(id);
        urls.delete(id);
        sites.delete(id);
        generation++;
        await l.close();
      }
      return { value: true };
    },

    /**
     * Starts no index build until release(): while a batch of files opens, so that the smallest
     * of them is indexed first rather than the first opened (IndexQueue.hold).
     */
    async hold() {
      indexQueue.hold();
      return { value: true };
    },

    async release() {
      indexQueue.release();
      return { value: true };
    },
  };

  return {
    /**
     * Runs one request: { value, transfer? }; throws LocalError (or the core's errors).
     * `onProgress(fraction)`: how far an open (its catalogue) or a meta (the book's conversion) is.
     */
    call(method, args = {}, { onProgress } = {}) {
      const fn = methods[method];
      if (!fn) throw new LocalError(`unknown request: ${method}`);
      return fn(args, { onProgress });
    },
    /** A local library's URL, parsed (for tests). */
    parse,
  };
}
