/**
 * One ZIM file's catalog and book content (SPEC §2.2, §2.3, §3.6), shared by the server and the
 * browser (core/platform.js). The server's `Library` (server/library.js) is the set of ZIM files
 * found in one directory; the browser opens files someone picks.
 *
 * A Gutenberg ZIM (gutenberg2zim) is catalogued from its own JSON index, a Wikisource ZIM from
 * its works, a Wikipedia ZIM as volumes of 1,000 articles (§2.5); any other ZIM becomes a
 * "generic" library whose books are its HTML articles. Book content is converted on demand
 * (HTML or EPUB → blocks → chunks), serialized once and kept in a byte-budgeted LRU shared by all
 * archives, so the HTTP layer can send cached bytes without re-serializing.
 */
import { parseEpub } from './content/epub.js';
import { blockChars, chunkBlocks, htmlToBlocks, imageSize } from './content/html.js';
import { platform } from './platform.js';
import { LRUCache } from './util/lru.js';
import * as wikipedia from './wikipedia.js';
import {
  isWikisource, buildIndex, indexName, loadIndex, saveIndex, collectWork, partTitle, genreOf, cleanCategories,
} from './wikisource.js';
import { ZimArchive } from './zim/reader.js';

/** Default byte budget for converted books, shared by all archives of a Library. */
export const CONTENT_CACHE_BYTES = 300 * 1024 * 1024;
/**
 * Decompressed-cluster budget per archive. Smaller than ZimArchive's own default (256 MB): a
 * book's HTML cluster is needed once per conversion and the result is cached above, so a big
 * cluster cache mostly holds dead text (measured on the reference ZIM: ~200 MB less RSS after
 * converting every book, same conversion time).
 */
const ARCHIVE_CLUSTER_CACHE_BYTES = 64 * 1024 * 1024;
/** Parsed EPUBs (zip buffer + decoded documents) kept for /res/ requests. */
const EPUB_CACHE_BYTES = 96 * 1024 * 1024;
/** Concurrent image reads while filling in image sizes. */
const IMAGE_PROBE_CONCURRENCY = 8;
/** Room reserved next to each chunk's JSON for its gzip variant (JSON compresses ~4×). */
const GZIP_RESERVE = 0.35;

const INDEX_FILE = 'full_by_popularity.js';
const INDEX_NAMESPACES = ['C', 'A', '-', 'J'];
const INDEX_PREFIXES = ['', 'js/'];
const METADATA_FIELDS = {
  title: 'Title', description: 'Description', longDescription: 'LongDescription', language: 'Language',
  date: 'Date', creator: 'Creator', publisher: 'Publisher', name: 'Name', flavour: 'Flavour',
};

/** An error that maps to an HTTP status (used for "book exists but cannot be read"). */
export class LibraryError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=404]
   */
  constructor(message, status = 404) {
    super(message);
    this.name = 'LibraryError';
    this.status = status;
  }
}

/**
 * URL-safe library id from a ZIM file name (§3.6): the name without `.zim`, with every
 * character outside [A-Za-z0-9._-] replaced by '-'. Case is kept.
 * @param {string} file basename, e.g. 'gutenberg_en_lcc-pe_2026-03.zim'
 * @returns {string}
 */
export function libraryIdFor(file) {
  let id = baseName(file).replace(/\.zim$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
  // '' / '.' / '..' would be unusable (or dangerous) as a URL segment.
  if (/^\.*$/.test(id)) id = `lib${id.length ? '-' + id.length : ''}`;
  return id;
}

/** The last segment of a path, with either separator (path.basename, without Node). */
function baseName(file) {
  return String(file).split(/[\\/]/).pop();
}

/**
 * The title a library is shown by (§4), so that a folder of ZIMs can be told apart. The ZIM's own
 * title, except:
 * - Kiwix's Gutenberg ZIMs of one Library of Congress class (name `gutenberg_<lang>_lcc-<code>`)
 *   all say "Project Gutenberg Library": they are named by their class (the ZIM's description) and
 *   its code, e.g. "Gutenberg · English language (PE)";
 * - a Wikipedia topic comes in editions with one title: the mini one (each article's introduction)
 *   and the nopic one say so, e.g. "Physics by Wikipedia (introductions)"; the full one (maxi)
 *   keeps the plain title.
 * @param {{ kind: string, title: string, description: string|null, name: string|null, flavour?: string|null }} info
 * @returns {string}
 */
export function libraryTitle({ kind, title, description, name, flavour = null }) {
  const lcc = kind === 'gutenberg' && description && /^gutenberg_[a-z-]+_lcc-([a-z]+)$/i.exec(name ?? '');
  if (lcc) return `Gutenberg · ${description} (${lcc[1].toUpperCase()})`;
  const edition = kind === 'wikipedia' && { mini: 'introductions', nopic: 'no pictures' }[String(flavour ?? '').toLowerCase()];
  return edition ? `${title} (${edition})` : title;
}

/**
 * Archive path → client URL `/zim/<libId>/<segments, each percent-encoded>` (§3.6, §4).
 * @param {string} libId
 * @param {string} archivePath e.g. 'C/covers/37134_cover_image.jpg'
 * @returns {string}
 */
export function zimUrl(libId, archivePath) {
  return `/zim/${encodeURIComponent(libId)}/${encodePath(archivePath)}`;
}

/** Percent-encodes each '/'-separated segment of a path. */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Splits a Gutenberg (MARC-derived) title such as "The slang dictionary : $b Etymological…"
 * into title and subtitle (§2.2). Whitespace is collapsed; a `$c` statement of responsibility
 * and other `$x` subfield markers are dropped.
 * @param {string} raw
 * @returns {{ title: string, subtitle: string|null, fullTitle: string }}
 */
export function splitTitle(raw) {
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  // A statement of responsibility ("/ $c by …") is not part of the title.
  const text = String(raw ?? '').replace(/\s*\/?\s*\$c[\s\S]*$/, '');
  const m = /\s*:?\s*\$b\s*/.exec(text);
  let title = m ? text.slice(0, m.index) : text;
  let subtitle = m ? text.slice(m.index + m[0].length) : '';
  // Any other MARC subfield marker is not display text.
  const dropMarkers = (s) => s.replace(/\s*\$[a-z]\s*/g, ' ');
  title = clean(dropMarkers(title)).replace(/\s*[:;,/]$/, '');
  subtitle = clean(dropMarkers(subtitle)).replace(/\s*[:;,/]$/, '');
  if (!title) {
    title = subtitle || clean(text);
    subtitle = '';
  }
  return { title, subtitle: subtitle || null, fullTitle: subtitle ? `${title}: ${subtitle}` : title };
}

/**
 * Entry URL base of a Gutenberg book, exactly as the ZIM's own js/tools.js computes it:
 * `title.replace("/", "-").substring(0, 230) + "." + id` — JS String.replace with a string
 * pattern replaces only the first '/', and substring counts UTF-16 code units.
 * @param {string} rawTitle the title as stored in the JSON index (MARC markers included)
 * @param {string|number} bookId
 * @returns {string}
 */
export function gutenbergBase(rawTitle, bookId) {
  return String(rawTitle).replace('/', '-').substring(0, 230) + '.' + bookId;
}

/**
 * The scraper itself (Python) replaces every '/' and slices by code points; when a title has two
 * slashes or an astral character near the cut, the JS-derived URL misses. Tried as a fallback.
 */
function pythonBase(rawTitle, bookId) {
  return Array.from(String(rawTitle).replaceAll('/', '-')).slice(0, 230).join('') + '.' + bookId;
}

/**
 * Extracts the array literal from a gutenberg2zim index script (`var json_data = [...];`).
 * @param {Uint8Array|string} data
 * @returns {any[]}
 * @throws {Error} when there is no parseable array
 */
export function parseIndexScript(data) {
  const text = typeof data === 'string' ? data : platform.utf8(data);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no JSON array found');
  const value = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(value)) throw new Error('index is not an array');
  return value;
}

/** Decodes HTML bytes: BOM, then a declared charset, else UTF-8. */
function decodeHtml(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return platform.utf8(buf, 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = platform.latin1(buf, 0, Math.min(buf.length, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head) ||
    /<\?xml[^>]+encoding\s*=\s*["']([A-Za-z0-9._:-]+)/i.exec(head);
  const declared = m ? m[1].toLowerCase() : 'utf-8';
  if (declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(buf);
    } catch {
      // unknown label: fall through to UTF-8
    }
  }
  return platform.utf8(buf);
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One converted chunk. Only the serialized JSON (`{"index":n,"blocks":[…]}`) is kept: as UTF-8
 * bytes it is several times smaller than the block objects (Webster's: 34 MB vs ~134 MB of heap)
 * and the HTTP layer sends it as-is (gzip and ETag from the platform: the server's).
 */
class Chunk {
  constructor(index, start, chars, blocks) {
    this.index = index;
    this.start = start;
    this.chars = chars;
    this.blockCount = blocks.length;
    /** @type {Uint8Array} */
    this.json = platform.encodeUtf8(JSON.stringify({ index, blocks }));
    this._gzip = null;
    this._etag = null;
  }

  /** The chunk's blocks (parsed from the cached JSON; for tests and internal use). */
  get blocks() {
    return JSON.parse(platform.utf8(this.json)).blocks;
  }

  /** gzip of `json`, computed once (off the main thread) and kept. */
  gzip() {
    if (!this._gzip) {
      this._gzip = platform.gzip(this.json);
      this._gzip.catch(() => { this._gzip = null; });
    }
    return this._gzip;
  }

  /** Strong validator of the JSON body. */
  get etag() {
    this._etag ??= platform.etag(this.json);
    return this._etag;
  }
}

/**
 * One ZIM file: its catalog and its books' content.
 * Create with `ArchiveLibrary.open()` (or through the server's `Library.scan()`).
 */
export class ArchiveLibrary {
  /** @private */
  constructor({ id, filePath, archive, log, warn, maxGenericBooks, contentCache, store = null, onChange = null, volumeSize = null, indexQueue = null }) {
    /** URL-safe id (§3.6). */
    this.id = id;
    /** Basename of the ZIM file. */
    this.file = baseName(filePath);
    this.filePath = filePath;
    /** @type {ZimArchive} */
    this.archive = archive;
    /** @type {'gutenberg'|'wikisource'|'wikipedia'|'generic'} */
    this.kind = 'generic';
    this._log = log;
    this._warn = warn;
    this._maxGenericBooks = maxGenericBooks;
    this._contentCache = contentCache;
    this._inflight = new Map(); // bookId → Promise<content>
    this._inflightProgress = new Map(); // bookId → Set of content()'s onProgress, while converting
    this._catalogProgress = null; // open()'s onProgress, while the catalogue is first built
    this._epubCache = new LRUCache({ maxBytes: EPUB_CACHE_BYTES, sizeOf: (e) => e.bytes });
    this._epubInflight = new Map();
    this._imageInfo = new LRUCache({ maxEntries: 100000 }); // archive path → { ok, w, h }
    this._books = null; // Promise<Book[]>
    this._byId = new Map(); // bookId → { book, html, epub, cover } (entries)
    this._info = null;
    this._index = null; // { ns, prefix } of the Gutenberg JSON index
    this._shelves = [];
    this._meta = {};
    this._conversions = 0;
    this._store = store; // where derived indexes are kept (server/cache-store.js), or null: not kept
    this._onChange = onChange; // called when the catalogue changes on its own (index finished)
    this._indexing = null; // { stage, progress } while a Wikisource/Wikipedia index is being built (or 'queued')
    this._indexQueue = indexQueue; // IndexQueue shared by a folder's libraries, or null: build at once
    this._wikipedia = null; // the Wikipedia article index (order + volumes)
    this._built = null; // an index just built, until the catalogue is rebuilt from it
    this._volumeSize = volumeSize;
    this._indexTask = null;
    this._closed = false;
  }

  /**
   * Opens a ZIM file and builds its catalog.
   * @param {string|Blob} input a file path (Node) or a Blob/File (ZimArchive.open)
   * @param {object} [opts]
   * @param {string} [opts.id] library id (default: from the file name)
   * @param {number} [opts.maxGenericBooks=2000]
   * @param {(msg: string) => void} [opts.log=console.log] progress / information
   * @param {(msg: string) => void} [opts.warn=log] problems with the archive's data
   * @param {LRUCache} [opts.contentCache] shared converted-book cache (default: a private one)
   * @param {number} [opts.contentCacheBytes] budget of the private cache (default 300 MB)
   * @param {object} [opts.archiveOptions] passed to ZimArchive.open (default cluster cache 64 MB)
   * @param {object} [opts.store] where derived indexes are kept (server/cache-store.js; default
   *   none: built on every open)
   * @param {() => void} [opts.onChange] called when the catalogue changes later (index built)
   * @param {IndexQueue} [opts.indexQueue] runs the background index build in turn (default: at once)
   * @returns {Promise<ArchiveLibrary>}
   */
  static async open(input, {
    id = libraryIdFor(typeof input === 'string' ? input : input.name ?? 'archive'),
    maxGenericBooks = 2000,
    log = console.log,
    warn = log,
    contentCache,
    contentCacheBytes = CONTENT_CACHE_BYTES,
    archiveOptions,
    store = null,
    onChange,
    volumeSize, // articles per Wikipedia volume (tests use small volumes)
    indexQueue,
    onProgress, // (fraction) as the catalogue is built: Gutenberg books looked up, generic entries scanned
  } = {}) {
    const archive = await ZimArchive.open(input, { clusterCacheBytes: ARCHIVE_CLUSTER_CACHE_BYTES, ...archiveOptions });
    try {
      const lib = new this({
        id, filePath: archive.filePath, archive, log, warn, maxGenericBooks, store, onChange, volumeSize, indexQueue,
        contentCache: contentCache ?? createContentCache(contentCacheBytes),
      });
      lib._catalogProgress = onProgress ?? null;
      try {
        await lib.books(); // catalog now: `kind` is final and errors surface at scan time
      } finally {
        lib._catalogProgress = null;
      }
      return lib;
    } catch (err) {
      await archive.close().catch(() => {});
      throw err;
    }
  }

  /** Number of books converted so far (diagnostics/tests). */
  get conversions() {
    return this._conversions;
  }

  /**
   * Library description (§4 shape), cached.
   * @returns {Promise<object>}
   */
  async info() {
    const base = await this._baseInfo();
    // Indexing progress is live; everything else is cached until the catalogue changes.
    return this.kind === 'wikisource' || this.kind === 'wikipedia' ? { ...base, indexing: this._indexing ? { ...this._indexing } : null } : base;
  }

  _baseInfo() {
    if (!this._info) {
      this._info = (async () => {
        const books = await this.books();
        const m = this._meta;
        const field = (k) => {
          const v = m[METADATA_FIELDS[k]];
          return typeof v === 'string' && v.trim() ? v.trim() : null;
        };
        const illustration = await this._findIllustration();
        // The client needs something to show; the metadata title is optional in ZIM files.
        const zimTitle = field('title') ?? this.file.replace(/\.zim$/i, '');
        return {
          id: this.id,
          file: this.file,
          kind: this.kind,
          title: libraryTitle({ kind: this.kind, title: zimTitle, description: field('description'), name: field('name'), flavour: field('flavour') }),
          zimTitle,
          description: field('description'),
          longDescription: field('longDescription'),
          language: field('language'),
          date: field('date'),
          creator: field('creator'),
          publisher: field('publisher'),
          name: field('name'),
          flavour: field('flavour'),
          bookCount: books.length,
          illustration: illustration ? zimUrl(this.id, illustration.path) : null,
          shelves: this._shelves.slice(),
          ...(this.kind === 'wikisource' ? { genres: this._genres ?? [] } : {}),
          ...(this.kind === 'wikipedia' ? { articles: this._wikipedia?.count ?? 0 } : {}),
        };
      })();
      this._info.catch(() => { this._info = null; });
    }
    return this._info;
  }

  /**
   * All books (§4 shape), in popularity order (Gutenberg) or URL order (generic). Cached; the
   * returned array and objects are shared: do not modify them.
   * @returns {Promise<object[]>}
   */
  books() {
    if (!this._books) {
      this._books = this._buildCatalog();
      this._books.catch(() => { this._books = null; });
    }
    return this._books;
  }

  /**
   * @param {string} bookId
   * @returns {Promise<object|undefined>}
   */
  async book(bookId) {
    await this.books();
    return this._byId.get(String(bookId))?.book;
  }

  /**
   * Converted book content (§3.6): `meta` is the §4 reading-metadata object, `chunks` the
   * serialized chunks (`json` bytes, `gzip()`, `blocks` getter). Converted once, cached in the
   * shared byte-budgeted LRU; concurrent calls share one conversion.
   * @param {string} bookId
   * @param {{ onProgress?: (fraction: number) => void }} [opts] onProgress: how far the conversion
   *   is (mostly its images, each looked up and sized: a book of 362 took half a minute on a
   *   Quest), also when joining one under way; not called for a cached book
   * @returns {Promise<{ meta: object, chunks: Chunk[] } | undefined>} undefined for an unknown book
   * @throws {LibraryError} (status 404) when the book has nothing readable
   */
  async content(bookId, { onProgress } = {}) {
    const id = String(bookId);
    await this.books();
    const rec = this._byId.get(id);
    if (!rec) return undefined;
    const key = this._cacheKey(id);
    const cached = this._contentCache.get(key);
    if (cached) return cached;
    let pending = this._inflight.get(id);
    if (!pending) {
      const listeners = new Set();
      this._inflightProgress.set(id, listeners);
      const progress = (f) => { for (const fn of listeners) fn(f); };
      pending = (async () => {
        const content = rec.kind === 'wikipedia' ? await this._volumeMeta(rec) : await this._convert(rec, progress);
        this._contentCache.set(key, content);
        return content;
      })();
      const done = () => {
        this._inflight.delete(id);
        this._inflightProgress.delete(id);
      };
      pending.then(done, done);
      this._inflight.set(id, pending);
    }
    if (onProgress) this._inflightProgress.get(id)?.add(onProgress);
    return pending;
  }

  /**
   * Wikipedia articles whose titles start with `query` (§2.5), in title order: each with its
   * volume's book id and its chunk in that volume. Empty for other libraries and while indexing.
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<Array<{ title: string, book: string, n: number }>>}
   */
  async searchArticles(query, limit) {
    const idx = this._wikipedia;
    if (!idx) return [];
    limit = Math.max(1, Math.min(wikipedia.SEARCH_LIMIT, limit | 0 || 12));
    const [titles, aliases] = await Promise.all([
      wikipedia.searchIndex(this.archive, idx, query, limit),
      wikipedia.searchRedirects(this.archive, idx, query, limit),
    ]);
    // Titles first, except that another name typed in full ("NYC") leads; never one article twice.
    const typed = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const exactTitle = titles[0]?.title.toLowerCase() === typed;
    const exactAliases = exactTitle ? [] : aliases.filter((a) => a.from.toLowerCase() === typed);
    const out = [];
    const seen = new Set();
    for (const a of [...exactAliases, ...titles, ...aliases]) {
      if (out.length >= limit || seen.has(a.position)) continue;
      seen.add(a.position);
      const hit = { title: a.title, book: `v${Math.floor(a.position / idx.volumeSize) + 1}`, n: a.position % idx.volumeSize };
      if (a.from) hit.from = a.from;
      out.push(hit);
    }
    return out;
  }

  /**
   * Every article title of a Wikipedia in title order, with the volume size (§2.5): what a static
   * build (tools/build-pages.mjs) needs to search articles in the browser. Null for other libraries
   * and while indexing.
   * @returns {Promise<{ volumeSize: number, titles: string[] } | null>}
   */
  async articleTitles() {
    const idx = this._wikipedia;
    if (!idx) return null;
    const titles = new Array(idx.count);
    await mapLimit(titles, 32, async (_, i) => {
      const e = await this.archive.getEntryByIndex(idx.order[i]);
      titles[i] = (e.title || e.url).replace(/\s+/g, ' ').trim();
    });
    return { volumeSize: idx.volumeSize, titles };
  }

  /**
   * Every article of a Wikipedia as [volume id, n], in the order the ZIM stores them (cluster,
   * then blob). Converting all articles in title order decompresses a cluster for nearly every
   * article (Medicine mini: 30 min); in this order each cluster once (24 s). For a static build
   * (tools/build-pages.mjs). Null for other libraries and while indexing.
   * @returns {Promise<Array<[string, number]> | null>}
   */
  async articlesInStorageOrder() {
    const idx = this._wikipedia;
    if (!idx) return null;
    const where = new Array(idx.count);
    await mapLimit(where, 32, async (_, i) => {
      const e = await this.archive.getEntryByIndex(idx.order[i]);
      where[i] = { i, cluster: e.cluster ?? -1, blob: e.blob ?? -1 };
    });
    where.sort((a, b) => a.cluster - b.cluster || a.blob - b.blob || a.i - b.i);
    return where.map(({ i }) => [`v${Math.floor(i / idx.volumeSize) + 1}`, i % idx.volumeSize]);
  }

  /**
   * One chunk of a book's content (§3.6). Most books are converted whole by content(); the
   * articles of a Wikipedia volume are converted one by one, when first asked for, and cached
   * in the same LRU.
   * @param {string} bookId
   * @param {number} n
   * @returns {Promise<Chunk|null|undefined>} undefined for an unknown book, null when out of range
   */
  async chunk(bookId, n) {
    const id = String(bookId);
    const content = await this.content(id);
    if (!content) return undefined;
    if (!content.meta.lazy) return content.chunks[n] ?? null;
    if (!Number.isInteger(n) || n < 0 || n >= content.meta.chunks.length) return null;
    const key = `${this._cacheKey(id)}\n#${n}`;
    const cached = this._contentCache.get(key);
    if (cached) return cached.chunk;
    let pending = this._inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const out = await this._convertArticle(this._byId.get(id), n, content.meta);
        this._contentCache.set(key, out);
        return out.chunk;
      })();
      const done = () => this._inflight.delete(key);
      pending.then(done, done);
      this._inflight.set(key, pending);
    }
    return pending;
  }

  /**
   * A file inside a book's EPUB (images and other resources of EPUB-only books).
   * @param {string} bookId
   * @param {string} filePath zip-root-relative path, e.g. 'OEBPS/images/fig1.png'
   * @returns {Promise<{ data: Uint8Array, mime: string } | null>}
   */
  async resource(bookId, filePath) {
    await this.books();
    const rec = this._byId.get(String(bookId));
    if (!rec || !rec.epub || typeof filePath !== 'string' || !filePath) return null;
    const epub = await this._epub(rec);
    const data = epub.getFile(filePath);
    if (!data) return null;
    return { data, mime: epub.mimeOf(filePath) };
  }

  /** Closes the archive. */
  async close() {
    this._closed = true;
    for (const key of [...this._contentCache.keys()]) {
      if (key.startsWith(this._cacheKey(''))) this._contentCache.delete(key);
    }
    this._epubCache.clear();
    await this.archive.close();
  }

  _cacheKey(bookId) {
    // The archive uuid keeps two Library instances over one cache from mixing books up.
    return `${this.id}\n${this.archive.header.uuid}\n${bookId}`;
  }

  // ------------------------------------------------------------------------------------------
  // Catalog

  async _buildCatalog() {
    this._byId.clear(); // a retry after a failed build starts clean
    this._meta = await this.archive.getMetadata().catch((err) => {
      this._warn(`${this.file}: cannot read metadata: ${err.message}`);
      return {};
    });
    const index = await this._findIndex();
    if (index) {
      try {
        const books = await this._gutenbergCatalog(index);
        this.kind = 'gutenberg';
        return books;
      } catch (err) {
        this._warn(`${this.file}: Gutenberg index ${index.entry.path} is unusable (${err.message}); listing HTML articles instead`);
        this._byId.clear();
      }
    }
    if (isWikisource(this._meta)) {
      this.kind = 'wikisource';
      return this._wikisourceCatalog();
    }
    if (wikipedia.isWikipedia(this._meta)) {
      this.kind = 'wikipedia';
      return this._wikipediaCatalog();
    }
    this.kind = 'generic';
    return this._genericCatalog();
  }

  // ------------------------------------------------------------------------------------------
  // Wikisource: multi-part works from a cached index (built in the background on first open)

  async _wikisourceCatalog() {
    const name = indexName(this.archive);
    const idx = this._built ?? (this._store ? await loadIndex(this._store, name, this.archive) : null);
    if (idx) {
      this._indexing = null;
      return this._booksFromIndex(idx);
    }
    // No index yet: serve an empty shelf while it is built, then announce the new catalogue.
    this._startIndexing({
      what: 'Wikisource works', unit: 'works', build: (opts) => buildIndex(this.archive, opts),
      save: this._store && ((built) => saveIndex(this._store, name, built)),
      weights: { scan: [0, 0.25], works: [0.25, 0.3], authors: [0.55, 0.45], done: [1, 0] },
    });
    this._shelves = [];
    this._genres = [];
    return [];
  }

  /**
   * Builds a derived index in the background (first open only), keeps it (`save`, when there is
   * a store), then rebuilds the catalogue and announces it (onChange). Meanwhile books() is empty
   * and info().indexing reports progress, weighted per stage ('queued' while a big archive waits
   * its turn in the folder's IndexQueue).
   */
  _startIndexing({ what, unit, build, save = null, weights, saved = null }) {
    if (this._indexTask) return;
    const queue = this._indexQueue;
    const bytes = this.archive.fileSize;
    this._indexing = { stage: 'queued', progress: 0 };
    if (queue?.queues(bytes)) this._log(`${this.file}: waiting to index ${what} (big archives one at a time, smallest first)…`);
    let t0;
    const task = () => {
      this._indexing = { stage: 'scan', progress: 0 };
      this._log(`${this.file}: indexing ${what} in the background (first open only)…`);
      t0 = performance.now();
      return build({
        onProgress: (stage, f) => {
          const [base, span] = weights[stage] ?? [0, 0];
          this._indexing = { stage, progress: Math.min(1, base + span * f) };
        },
        log: (m) => this._log(`${this.file}:${m}`),
      });
    };
    this._indexTask = (queue ? queue.run(bytes, task, { cancelled: () => this._closed }) : task()).then(async (idx) => {
      if (this._closed) return;
      const ok = save && await save(idx).then(() => true, (err) => {
        this._warn(`${this.file}: cannot cache the ${what} index (${err.message})`);
        return false;
      });
      if (ok) await saved?.().catch(() => {});
      this._indexing = null;
      this._books = null;
      this._info = null;
      this._byId.clear();
      this._built = idx; // the catalogue is rebuilt from it, not re-read (there may be no store)
      const books = await this.books();
      if (ok) this._built = null; // in the store: no need to hold it twice
      this._log(`${this.file}: ${what} index ready: ${books.length} ${unit} (${Math.round((performance.now() - t0) / 1000)} s)`);
      this._onChange?.();
    }).catch((err) => {
      if (this._closed) return;
      this._indexing = { stage: 'failed', progress: 0, error: err.message };
      this._warn(`${this.file}: ${what} indexing failed: ${err.message}`);
    }).finally(() => {
      this._indexTask = null;
    });
  }

  // ------------------------------------------------------------------------------------------
  // Wikipedia: volumes of 1,000 articles in title order, from a cached titles-only index

  async _wikipediaCatalog() {
    const name = wikipedia.indexName(this.archive);
    const store = this._store;
    const idx = this._built ?? (store ? await wikipedia.loadIndex(store, name, this.archive) : null);
    this._shelves = [];
    if (idx) {
      this._indexing = null;
      return this._volumesFromIndex(idx);
    }
    // The sizes pass keeps its progress in a checkpoint, so a restart resumes it (after a new scan);
    // it is deleted once the index is saved.
    const checkpoint = wikipedia.checkpointName(this.archive);
    this._startIndexing({
      what: 'Wikipedia articles', unit: 'volumes',
      build: (opts) => wikipedia.buildIndex(this.archive, {
        ...opts, volumeSize: this._volumeSize ?? wikipedia.VOLUME_SIZE, store, checkpoint,
      }),
      save: store && ((built) => wikipedia.saveIndex(store, name, built)),
      saved: () => wikipedia.removeCheckpoint(store, checkpoint),
      // Full English Wikipedia (2026-10-06): scan 11½ min, sizes 16 min, sort 17 s.
      weights: { scan: [0, 0.4], sizes: [0.4, 0.58], sort: [0.98, 0.02], done: [1, 0] },
    });
    return [];
  }

  async _volumesFromIndex(idx) {
    this._wikipedia = idx;
    const m = this._meta;
    const language = typeof m.Language === 'string' && m.Language.trim() ? m.Language.split(',')[0].trim() : null;
    const author = [m.Creator, m.Publisher].find((v) => typeof v === 'string' && v.trim())?.trim() ?? 'Wikipedia';
    const illustration = await this._findIllustration();
    const emblem = illustration ? zimUrl(this.id, illustration.path) : null;
    const n = idx.volumes.length;
    return idx.volumes.map((range, v) => {
      const id = `v${v + 1}`;
      const from = v * idx.volumeSize;
      const to = Math.min(idx.count, from + idx.volumeSize);
      const title = wikipedia.volumeTitle(range);
      const book = {
        id, title, subtitle: `Volume ${v + 1} of ${n}`, fullTitle: title, author, authorId: null, rank: v + 1,
        shelf: null, language, formats: { html: true, epub: false, pdf: false }, readable: true,
        cover: null, epub: null, size: null,
        // An encyclopedia volume (§2.5): uniform binding and size, spine with number and range.
        volume: v + 1, volumes: n, range: [range[0], range[1]], articles: to - from, emblem,
      };
      this._byId.set(id, { book, kind: 'wikipedia', from, to });
      return book;
    });
  }

  /** Reading metadata of a volume: one chunk per article (sizes estimated), contents = titles. */
  async _volumeMeta(rec) {
    const { book, from, to } = rec;
    const order = this._wikipedia.order;
    const titles = new Array(to - from);
    await mapLimit(titles, 16, async (_, i) => {
      const e = await this.archive.getEntryByIndex(order[from + i]);
      titles[i] = (e.title || e.url).replace(/\s+/g, ' ').trim();
    });
    // Sizes estimated from each article's HTML size (the reader corrects them once loaded).
    const chunks = [];
    let start = 0;
    for (let i = 0; i < titles.length; i++) {
      const chars = wikipedia.articleChars(this._wikipedia.sizes[from + i]);
      chunks.push({ start, chars, blocks: 1 });
      start += chars;
    }
    const meta = {
      library: this.id, id: book.id, title: book.title, subtitle: book.subtitle, author: book.author, cover: null,
      source: 'html', totalChars: start, chunks,
      toc: titles.map((title, i) => ({ title, level: 1, c: i, b: 0 })),
      tocTruncated: false,
      // Chunks are articles, converted when first asked for (chunk()); their sizes are estimates.
      lazy: true,
    };
    return { meta, chunks: [], bytes: 1024 + JSON.stringify(meta).length };
  }

  /** One article of a volume as a chunk: its title as a heading, then the converted article. */
  async _convertArticle(rec, n, meta) {
    const entry = await this.archive.getEntryByIndex(this._wikipedia.order[rec.from + n]);
    const content = await this.archive.getContent(entry);
    if (!content) throw new LibraryError(`book ${rec.book.id}: article ${entry.path} has no content`);
    const title = (entry.title || entry.url).replace(/\s+/g, ' ').trim();
    const blocks = [{ t: 'h', l: 1, r: [[title, 0]] }, ...htmlToBlocks(decodeHtml(content.data), { docPath: content.entry.path }).blocks];
    await this._fixImages(blocks, { lookup: (p, opts) => this._zimImage(p, opts), fallback: null, url: (p) => zimUrl(this.id, p) });
    const chars = blocks.reduce((s, b) => s + blockChars(b), 0);
    const chunk = new Chunk(n, meta.chunks[n].start, chars, blocks);
    this._conversions++;
    return { chunk, bytes: Math.ceil(chunk.json.length * (1 + GZIP_RESERVE)) + 128 };
  }

  _booksFromIndex(idx) {
    const m = this._meta;
    const language = typeof m.Language === 'string' && m.Language.trim() ? m.Language.split(',')[0].trim() : null;
    const books = [];
    const counts = new Map();
    for (const [url, title, index, parts, cover, year, cats, author] of idx.works) {
      const id = `w${index}`;
      const genre = genreOf(cleanCategories(cats ?? []));
      counts.set(genre, (counts.get(genre) || 0) + 1);
      const book = {
        id, title, subtitle: null, fullTitle: title, author: author ?? null, authorId: null, rank: null,
        shelf: genre, language, formats: { html: true, epub: false, pdf: false }, readable: true,
        cover: cover ? zimUrl(this.id, cover) : null, epub: null,
        // Thickness on the shelf follows length: ~30 KB of HTML per part.
        size: (parts + 1) * 30000,
        genre, year: year ?? null, parts,
      };
      books.push(book);
      this._byId.set(id, { book, kind: 'wikisource', url, parts });
    }
    this._genres = [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    this._shelves = this._genres.map((g) => g.name);
    return books;
  }

  /** Finds the gutenberg2zim JSON index (§2.2: namespaces C, A, -, J, optionally under js/). */
  async _findIndex() {
    const namespaces = this.archive.newNamespaceScheme ?
      ['C', ...INDEX_NAMESPACES.filter((n) => n !== 'C')] : INDEX_NAMESPACES;
    for (const ns of namespaces) {
      for (const prefix of INDEX_PREFIXES) {
        const entry = await this.archive.findEntry(ns, prefix + INDEX_FILE);
        if (entry) return { ns, prefix, entry };
      }
    }
    return null;
  }

  /** Reads one of the index's sibling scripts (authors.js, …); null when absent or unparseable. */
  async _indexSibling(name) {
    const { ns, prefix } = this._index;
    const candidates = [[ns, prefix + name], ...INDEX_NAMESPACES.flatMap((n) => INDEX_PREFIXES.map((p) => [n, p + name]))];
    for (const [n, url] of candidates) {
      const entry = await this.archive.findEntry(n, url);
      if (!entry) continue;
      try {
        const content = await this.archive.getContent(entry);
        return content ? parseIndexScript(content.data) : null;
      } catch (err) {
        this._warn(`${this.file}: cannot parse ${entry.path}: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  async _gutenbergCatalog(index) {
    this._index = index;
    const content = await this.archive.getContent(index.entry);
    if (!content) throw new Error('index has no content');
    const rows = parseIndexScript(content.data);

    const authorIds = new Map();
    for (const row of (await this._indexSibling('authors.js')) ?? []) {
      if (Array.isArray(row) && typeof row[0] === 'string' && row[1] != null && !authorIds.has(row[0])) {
        authorIds.set(row[0], String(row[1]));
      }
    }
    const languageOf = await this._bookLanguages();
    const shelves = await this._indexSibling('lcc_shelves.js');

    // Old-scheme (gutenberg2zim 2.x) files keep articles in A and images in I.
    const nsHtml = this.archive.newNamespaceScheme ? ['C'] : ['C', 'A'];
    const nsCover = this.archive.newNamespaceScheme ? ['C'] : ['C', 'I'];
    const nsEpub = this.archive.newNamespaceScheme ? ['C'] : ['C', 'A', 'I', '-'];

    const parsed = [];
    const seen = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const id = String(row[3] ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      parsed.push(row);
    }

    const recs = new Array(parsed.length);
    let looked = 0;
    // Lookups are independent binary searches over cached directory entries: run them together.
    await mapLimit(parsed, 16, async (row, i) => {
      const rawTitle = typeof row[0] === 'string' ? row[0] : String(row[0] ?? '');
      const author = typeof row[1] === 'string' && row[1].trim() ? row[1].replace(/\s+/g, ' ').trim() : null;
      const flags = typeof row[2] === 'string' && /^[01]{3}$/.test(row[2]) ? row[2] : null;
      const id = String(row[3]).trim();
      const shelf = typeof row[4] === 'string' && row[4].trim() ? row[4].trim() : null;
      const { title, subtitle, fullTitle } = splitTitle(rawTitle);

      const bases = [gutenbergBase(rawTitle, id)];
      const alt = pythonBase(rawTitle, id);
      if (alt !== bases[0]) bases.push(alt);
      // Trust the format flags to skip lookups of files that are not there; without valid flags,
      // look everything up.
      const want = (k) => !flags || flags[k] === '1';
      const html = want(0) ? await this._firstOf(nsHtml, bases.flatMap((b) => [b, b + '.html'])) : null;
      const epub = want(1) ? await this._firstOf(nsEpub, bases.map((b) => b + '.epub')) : null;
      const pdf = flags?.[2] === '1' ? await this._firstOf(nsEpub, bases.map((b) => b + '.pdf')) : null;
      const cover = await this._firstOf(nsCover, [`covers/${id}_cover_image.jpg`, `covers/${id}_cover.jpg`]);
      const sizeEntry = epub ?? html;
      const size = sizeEntry ? await this.archive.getBlobSize(sizeEntry, { cheapOnly: true }).catch(() => null) : null;

      const book = {
        id,
        title,
        subtitle,
        fullTitle,
        author,
        authorId: author !== null ? authorIds.get(row[1]) ?? authorIds.get(author) ?? null : null,
        rank: i + 1,
        shelf,
        language: languageOf(id),
        formats: { html: !!html, epub: !!epub, pdf: !!pdf },
        readable: !!(html || epub),
        cover: cover ? zimUrl(this.id, cover.path) : null,
        epub: epub ? zimUrl(this.id, epub.path) : null,
        size,
      };
      recs[i] = { book, html, epub, kind: 'gutenberg' };
      this._catalogProgress?.(++looked / parsed.length);
    });
    // Registered in rank order so iteration over the id map is deterministic.
    for (const rec of recs) this._byId.set(rec.book.id, rec);
    const unreadable = recs.filter((r) => !r.book.readable).length;
    if (unreadable) this._warn(`${this.file}: ${unreadable} book(s) have neither HTML nor EPUB in the archive`);

    const books = recs.map((r) => r.book);
    if (Array.isArray(shelves)) {
      this._shelves = shelves.filter((s) => typeof s === 'string' && s);
    } else {
      this._shelves = [...new Set(books.map((b) => b.shelf).filter(Boolean))];
    }
    return books;
  }

  /** bookId → language code: languages.js when it names one language, else lang_<code> lists. */
  async _bookLanguages() {
    const map = new Map();
    const lookup = (id) => map.get(id) ?? null;
    const langs = await this._indexSibling('languages.js');
    if (!Array.isArray(langs)) return lookup;
    const codes = langs.map((l) => (Array.isArray(l) ? l[1] : null)).filter((c) => typeof c === 'string' && c);
    if (codes.length === 1) return () => codes[0];
    for (const code of codes) {
      const rows = await this._indexSibling(`lang_${code}_by_popularity.js`);
      for (const row of rows ?? []) {
        if (Array.isArray(row) && row[3] != null && !map.has(String(row[3]))) map.set(String(row[3]), code);
      }
    }
    return lookup;
  }

  async _firstOf(namespaces, urls) {
    for (const url of urls) {
      for (const ns of namespaces) {
        const entry = await this.archive.findEntry(ns, url);
        if (entry) return entry;
      }
    }
    return null;
  }

  /** §2.3: HTML articles in C or A (no redirects), URL order, capped. */
  async _genericCatalog() {
    const max = this._maxGenericBooks;
    const m = this._meta;
    const author = [m.Creator, m.Publisher].find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
    const language = typeof m.Language === 'string' && m.Language.trim() ? m.Language.split(',')[0].trim() : null;
    const books = [];
    let more = false;
    for (const ns of ['A', 'C']) {
      const start = await this.archive.lowerBound(ns, '');
      const end = await this.archive.lowerBound(String.fromCharCode(ns.charCodeAt(0) + 1), '');
      for await (const entry of this.archive.entries(start, end)) {
        this._catalogProgress?.(Math.max(books.length / max, (entry.index - start + 1) / (end - start)));
        if (entry.isRedirect || !entry.mime || !/^(text\/html|application\/xhtml\+xml)\b/i.test(entry.mime)) continue;
        if (books.length >= max) {
          more = true;
          break;
        }
        const id = `e${entry.index}`;
        const book = {
          id,
          title: entry.title.replace(/\s+/g, ' ').trim() || entry.url,
          subtitle: null,
          fullTitle: entry.title.replace(/\s+/g, ' ').trim() || entry.url,
          author,
          authorId: null,
          rank: books.length + 1,
          shelf: null,
          language,
          formats: { html: true, epub: false, pdf: false },
          readable: true,
          cover: null,
          epub: null,
          size: await this.archive.getBlobSize(entry, { cheapOnly: true }).catch(() => null),
        };
        books.push(book);
        this._byId.set(id, { book, html: entry, epub: null, kind: 'generic' });
      }
      if (more) break;
    }
    if (more) {
      this._log(`${this.file}: more than ${max} HTML articles; only the first ${max} (in URL order) are listed (--max-generic)`);
    }
    this._shelves = [];
    return books;
  }

  async _findIllustration() {
    for (const p of ['M/Illustration_48x48@1', 'M/Illustration_96x96@1', '-/favicon', 'I/favicon.png']) {
      const entry = await this.archive.findPath(p);
      if (entry) return entry;
    }
    // Any other size the ZIM may carry.
    const start = await this.archive.lowerBound('M', 'Illustration_');
    if (start < this.archive.entryCount) {
      const entry = await this.archive.getEntryByIndex(start);
      if (entry.ns === 'M' && entry.url.startsWith('Illustration_')) return entry;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // Content

  async _epub(rec) {
    const key = rec.book.id;
    const cached = this._epubCache.get(key);
    if (cached) return cached.epub;
    let pending = this._epubInflight.get(key);
    if (!pending) {
      pending = (async () => {
        const content = await this.archive.getContent(rec.epub);
        if (!content) throw new LibraryError(`EPUB of book ${key} has no content`);
        const epub = parseEpub(content.data);
        let bytes = content.data.length;
        for (const doc of epub.docs) bytes += doc.html.length * 2;
        this._epubCache.set(key, { epub, bytes });
        return epub;
      })();
      const done = () => this._epubInflight.delete(key);
      pending.then(done, done);
      this._epubInflight.set(key, pending);
    }
    return pending;
  }

  /**
   * Converts a book (content()). `progress(fraction)`: a tenth for its text, read and parsed, the
   * rest as its images are looked up and sized (_fixImages).
   */
  async _convert(rec, progress = () => {}) {
    const { book } = rec;
    let blocks;
    let source;
    const images = (f) => progress(0.1 + 0.9 * f);
    const epubRes = (p) => `/api/libraries/${encodeURIComponent(this.id)}/books/${encodeURIComponent(book.id)}/res/${encodePath(p)}`;
    if (rec.kind === 'wikisource') {
      // A work = its main page + subpages in contents order, each part under its own heading.
      const { parts, truncated, total } = await collectWork(this.archive, rec.url, { expectedParts: rec.parts });
      if (!parts.length) throw new LibraryError(`book ${book.id}: the work's pages are missing from the archive`);
      blocks = [];
      for (const part of parts) {
        const title = part.depth === 0 ? book.title : partTitle(part.url);
        blocks.push({ t: 'h', l: Math.min(3, part.depth + 1), r: [[title, 0]] });
        const out = htmlToBlocks(part.html, { docPath: part.path }).blocks;
        for (const b of out) blocks.push(b);
        part.html = null;
      }
      if (truncated) {
        blocks.push({ t: 'hr' }, { t: 'p', a: 'c', r: [[`This edition includes the first ${parts.length} of ${total} parts of the work.`, 1]] });
      }
      source = 'html';
      images(0);
      await this._fixImages(blocks, {
        lookup: (p) => this._zimImage(p),
        fallback: null,
        url: (p) => zimUrl(this.id, p),
        onProgress: images,
      });
    } else if (rec.html) {
      const content = await this.archive.getContent(rec.html);
      if (!content) throw new LibraryError(`book ${book.id}: HTML entry has no content`);
      // Relative links resolve against the entry that actually holds the HTML (after redirects).
      ({ blocks } = htmlToBlocks(decodeHtml(content.data), { docPath: content.entry.path }));
      source = 'html';
      images(0);
      await this._fixImages(blocks, {
        onProgress: images,
        lookup: (p) => this._zimImage(p),
        // gutenberg2zim flattens a book's images to '<id>_<name>' (some books still say img/<name>).
        fallback: rec.kind === 'gutenberg' ? (p) => {
          const slash = p.indexOf('/');
          return slash > 0 ? `${p.slice(0, slash)}/${book.id}_${p.slice(p.lastIndexOf('/') + 1)}` : null;
        } : null,
        url: (p) => zimUrl(this.id, p),
      });
    } else if (rec.epub) {
      const epub = await this._epub(rec);
      blocks = [];
      for (const doc of epub.docs) {
        const out = htmlToBlocks(doc.html, { docPath: doc.path }).blocks;
        for (const b of out) blocks.push(b);
      }
      source = 'epub';
      images(0);
      await this._fixImages(blocks, {
        onProgress: images,
        lookup: async (p) => {
          const data = epub.getFile(p);
          if (!data || !/^image\//.test(epub.mimeOf(p))) return { ok: false };
          return { ok: true, ...(imageSize(data) ?? {}) };
        },
        fallback: null,
        url: epubRes,
      });
    } else {
      throw new LibraryError(`book ${book.id} has no readable content in this archive`);
    }

    const { chunks, toc, totalChars, tocTruncated } = chunkBlocks(blocks);
    blocks = null;
    const out = chunks.map((c, i) => new Chunk(i, c.start, c.chars, c.blocks));
    chunks.length = 0;
    const meta = {
      library: this.id,
      id: book.id,
      title: book.title,
      subtitle: book.subtitle,
      author: book.author,
      cover: book.cover,
      source,
      totalChars,
      chunks: out.map((c) => ({ start: c.start, chars: c.chars, blocks: c.blockCount })),
      toc,
      tocTruncated: !!tocTruncated,
    };
    let bytes = 1024 + JSON.stringify(meta).length;
    for (const c of out) bytes += Math.ceil(c.json.length * (1 + GZIP_RESERVE)) + 128;
    this._conversions++;
    return { meta, chunks: out, bytes };
  }

  /**
   * Image facts for an archive path: exists (and is an image), natural size if sniffable. With
   * `size: false` (the page already gives width and height) the image is not read.
   */
  async _zimImage(archivePath, { size = true } = {}) {
    const cached = this._imageInfo.get(archivePath);
    if (cached && (cached.sized || !size || !cached.ok)) return cached;
    let info = { ok: false };
    const entry = await this.archive.findPath(archivePath);
    if (entry) {
      const target = await this.archive.resolveRedirect(entry).catch(() => null);
      if (target && target.mime && /^image\//i.test(target.mime)) {
        if (!size) info = { ok: true, sized: false };
        else {
          const content = await this.archive.getContent(target).catch(() => null);
          if (content) info = { ok: true, sized: true, ...(imageSize(content.data) ?? {}) };
        }
      }
    }
    this._imageInfo.set(archivePath, info);
    return info;
  }

  /**
   * Checks every image block: fills missing w/h from the image bytes, rewrites `src` to a client
   * URL, and replaces images that are not in the archive with their alt text (or drops them).
   * Works in place on `blocks`. `onProgress(fraction)` as images are done (1 when none).
   */
  async _fixImages(blocks, { lookup, fallback, url, onProgress = () => {} }) {
    const imgs = [];
    const inline = []; // image runs (SPEC §3.5): their size is known, only the path is resolved
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.t === 'img') imgs.push(i);
      else if (b.r) {
        for (const run of b.r) if (run.length > 2) inline.push(run);
      } else if (b.c) {
        for (const cell of b.c) for (const run of cell) if (run.length > 2) inline.push(run);
      }
    }
    if (!imgs.length && !inline.length) return onProgress(1);
    let done = 0;
    const counted = (fn) => async (x) => {
      try {
        await fn(x);
      } finally {
        onProgress(++done / (imgs.length + inline.length));
      }
    };
    const resolved = new Map(); // src → { path, info } (books repeat decorative images)
    const resolve = async (src, size) => {
      const key = `${size ? 1 : 0}${src}`;
      let r = resolved.get(key);
      if (!r) {
        r = (async () => {
          let info = await lookup(src, { size });
          let p = src;
          if (!info.ok && fallback) {
            const alt = fallback(src);
            if (alt && alt !== src) {
              const altInfo = await lookup(alt, { size });
              if (altInfo.ok) {
                info = altInfo;
                p = alt;
              }
            }
          }
          return { path: p, info };
        })();
        resolved.set(key, r);
      }
      return r;
    };
    const drop = new Set();
    await mapLimit(imgs, IMAGE_PROBE_CONCURRENCY, counted(async (i) => {
      const blk = blocks[i];
      if (blk.src.startsWith('data:')) {
        if (!(blk.w && blk.h)) {
          const size = dataUriSize(blk.src);
          if (size) Object.assign(blk, fillSize(blk, size));
        }
        return;
      }
      const { path: p, info } = await resolve(blk.src, !(blk.w && blk.h));
      if (!info.ok) {
        if (blk.alt) {
          const para = { t: 'p', r: [[blk.alt, 1]] };
          if (blk.q) para.q = blk.q;
          if (blk.id) para.id = blk.id;
          blocks[i] = para;
        } else {
          drop.add(i);
        }
        return;
      }
      if (info.w && info.h) Object.assign(blk, fillSize(blk, info));
      blk.src = url(p);
    }));
    await mapLimit(inline, IMAGE_PROBE_CONCURRENCY, counted(async (run) => {
      const img = run[2];
      if (img.src.startsWith('data:')) return;
      const { path: p, info } = await resolve(img.src, false);
      if (info.ok) {
        img.src = url(p);
      } else {
        // Missing: its alt text in italics, as for block images.
        run.length = 2;
        run[0] = img.alt || '';
        run[1] |= 1;
      }
    }));
    if (drop.size) {
      let w = 0;
      for (let r = 0; r < blocks.length; r++) if (!drop.has(r)) blocks[w++] = blocks[r];
      blocks.length = w;
    }
  }
}

/** w/h for an image block: keeps the author's dimensions, completing a missing one by aspect. */
function fillSize(blk, natural) {
  if (blk.w && blk.h) return {};
  if (blk.w) return { h: Math.max(1, Math.round((blk.w * natural.h) / natural.w)) };
  if (blk.h) return { w: Math.max(1, Math.round((blk.h * natural.w) / natural.h)) };
  return { w: natural.w, h: natural.h };
}

function dataUriSize(uri) {
  const m = /^data:[^,]*?(;base64)?,/i.exec(uri);
  if (!m) return null;
  const body = uri.slice(m[0].length);
  try {
    const buf = m[1] ? platform.fromBase64(body) : platform.encodeUtf8(decodeURIComponent(body));
    return imageSize(buf);
  } catch {
    return null;
  }
}

/**
 * The byte-budgeted LRU of converted books (one per Library, shared by its archives).
 * @param {number} [maxBytes=300 MB]
 * @returns {LRUCache}
 */
export function createContentCache(maxBytes = CONTENT_CACHE_BYTES) {
  return new LRUCache({ maxBytes, sizeOf: (c) => c.bytes });
}
