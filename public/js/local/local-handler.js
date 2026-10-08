// The local library: ZIM files someone opened in the browser (step 2, SPEC §2.6), read with the
// shared core over File.slice. worker.js runs this in a Web Worker; Node tests call it directly.
// Each method answers one request of local.js: { value, transfer } with the buffers to move.
//
// Library ids start with '~' (libraryIdFor never makes one), so they cannot clash with a server's.
// Their URLs are the core's (/zim/~id/…, /api/libraries/~id/books/…/res/…): the page asks for
// those images here (image()) instead of fetching them.

import { ArchiveLibrary, createContentCache, libraryIdFor } from '../core/library.js';
import { isWikipedia } from '../core/wikipedia.js';
import { isWikisource } from '../core/wikisource.js';
import { ZimArchive } from '../core/zim/reader.js';

/** Converted books kept for all local libraries: a headset has far less memory than a PC. */
const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
/** Decompressed clusters kept per archive. */
const CLUSTER_CACHE_BYTES = 32 * 1024 * 1024;
/** The directory block cache per file (ZimArchive dirCacheBytes): a 4.5 GB Gutenberg ZIM's whole directory is 1.7 MB. */
const DIR_CACHE_BYTES = 16 * 1024 * 1024;

export const LOCAL_PREFIX = '~';

/** A refusal or a problem with a file, with a message for the person who opened it. */
export class LocalError extends Error {}

/**
 * @param {{ log?: (msg: string) => void, warn?: (msg: string) => void }} [opts]
 */
export function createLocalLibraries({ log = () => {}, warn = log } = {}) {
  const libs = new Map(); // id → ArchiveLibrary
  const contentCache = createContentCache(CONTENT_CACHE_BYTES);
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
    /** Opens a File (or Blob): { id, title }. Wikipedia and Wikisource need the server for now. */
    async open({ file }, { onProgress } = {}) {
      const t0 = performance.now();
      const probe = await ZimArchive.open(file).catch((err) => {
        throw new LocalError(`${file.name}: not a readable ZIM file (${err.message})`);
      });
      let meta;
      try {
        meta = await probe.getMetadata();
      } finally {
        await probe.close();
      }
      if (isWikipedia(meta) || isWikisource(meta)) {
        throw new LocalError(`${file.name}: ${isWikipedia(meta) ? 'Wikipedia' : 'Wikisource'} ZIMs need the vrlbry server for now (they are indexed first)`);
      }
      const base = LOCAL_PREFIX + libraryIdFor(file.name || 'archive.zim');
      let id = base;
      for (let n = 2; libs.has(id); n++) id = `${base}-${n}`;
      const opened = await ArchiveLibrary.open(file, {
        id, log, warn, contentCache, archiveOptions: { clusterCacheBytes: CLUSTER_CACHE_BYTES, dirCacheBytes: DIR_CACHE_BYTES }, onProgress,
      });
      libs.set(id, opened);
      generation++;
      const info = await opened.info();
      log(`${file.name}: ${opened.kind} library, ${info.bookCount} book(s), opened in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return { value: { id, title: info.title, kind: opened.kind, books: info.bookCount } };
    },

    /** The catalogue: { generation, libraries: [info] } in the order they were opened. */
    async catalog() {
      const libraries = await Promise.all([...libs.values()].map((l) => l.info()));
      return { value: { generation, libraries } };
    },

    async books({ lib: id }) {
      return { value: await lib(id).books() };
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

    async close({ lib: id }) {
      const l = libs.get(id);
      if (l) {
        libs.delete(id);
        generation++;
        await l.close();
      }
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
