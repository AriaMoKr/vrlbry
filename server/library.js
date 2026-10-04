/**
 * Library catalog and book content (SPEC §2.2, §2.3, §3.6).
 *
 * A `Library` is the set of ZIM files found in one directory; each file is an `ArchiveLibrary`.
 * A Gutenberg ZIM (gutenberg2zim) is catalogued from its own JSON index; any other ZIM becomes a
 * "generic" library whose books are its HTML articles. Book content is converted on demand
 * (HTML or EPUB → blocks → chunks), serialized once and kept in a byte-budgeted LRU shared by all
 * archives, so the HTTP layer can send cached bytes without re-serializing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { parseEpub } from './content/epub.js';
import { chunkBlocks, htmlToBlocks, imageSize } from './content/html.js';
import { LRUCache } from './util/lru.js';
import { ZimArchive } from './zim/reader.js';
import {
  isWikisource, buildIndex, indexPath, loadIndex, saveIndex, collectWork, partTitle, genreOf, cleanCategories,
} from './wikisource.js';

const gzipAsync = promisify(zlib.gzip);

/** Where derived indexes (Wikisource works) are cached: <project>/.cache. */
export const DEFAULT_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');
/** Default byte budget for converted books, shared by all archives of a Library. */
const CONTENT_CACHE_BYTES = 300 * 1024 * 1024;
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
  date: 'Date', creator: 'Creator', publisher: 'Publisher', name: 'Name',
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
  let id = path.basename(file).replace(/\.zim$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
  // '' / '.' / '..' would be unusable (or dangerous) as a URL segment.
  if (/^\.*$/.test(id)) id = `lib${id.length ? '-' + id.length : ''}`;
  return id;
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
 * @param {Buffer|string} data
 * @returns {any[]}
 * @throws {Error} when there is no parseable array
 */
export function parseIndexScript(data) {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no JSON array found');
  const value = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(value)) throw new Error('index is not an array');
  return value;
}

/** Decodes HTML bytes: BOM, then a declared charset, else UTF-8. */
function decodeHtml(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
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
  return buf.toString('utf8');
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
 * and the HTTP layer sends it as-is.
 */
class Chunk {
  constructor(index, start, chars, blocks) {
    this.index = index;
    this.start = start;
    this.chars = chars;
    this.blockCount = blocks.length;
    /** @type {Buffer} */
    this.json = Buffer.from(JSON.stringify({ index, blocks }), 'utf8');
    this._gzip = null;
    this._etag = null;
  }

  /** The chunk's blocks (parsed from the cached JSON; for tests and internal use). */
  get blocks() {
    return JSON.parse(this.json.toString('utf8')).blocks;
  }

  /** gzip of `json`, computed once (off the main thread) and kept. */
  gzip() {
    if (!this._gzip) {
      this._gzip = gzipAsync(this.json, { level: 6 });
      this._gzip.catch(() => { this._gzip = null; });
    }
    return this._gzip;
  }

  /** Strong validator of the JSON body. */
  get etag() {
    this._etag ??= `"${crypto.createHash('sha1').update(this.json).digest('base64url')}"`;
    return this._etag;
  }
}

/**
 * One ZIM file: its catalog and its books' content.
 * Create with `ArchiveLibrary.open()` (or through `Library.scan()`).
 */
export class ArchiveLibrary {
  /** @private */
  constructor({ id, filePath, archive, log, warn, maxGenericBooks, contentCache, cacheDir = DEFAULT_CACHE_DIR, onChange = null }) {
    /** URL-safe id (§3.6). */
    this.id = id;
    /** Basename of the ZIM file. */
    this.file = path.basename(filePath);
    this.filePath = filePath;
    /** @type {ZimArchive} */
    this.archive = archive;
    /** @type {'gutenberg'|'wikisource'|'generic'} */
    this.kind = 'generic';
    this._log = log;
    this._warn = warn;
    this._maxGenericBooks = maxGenericBooks;
    this._contentCache = contentCache;
    this._inflight = new Map(); // bookId → Promise<content>
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
    this._cacheDir = cacheDir;
    this._onChange = onChange; // called when the catalogue changes on its own (index finished)
    this._indexing = null; // { stage, progress } while a Wikisource index is being built
    this._indexTask = null;
    this._closed = false;
  }

  /**
   * Opens a ZIM file and builds its catalog.
   * @param {string} filePath
   * @param {object} [opts]
   * @param {string} [opts.id] library id (default: from the file name)
   * @param {number} [opts.maxGenericBooks=2000]
   * @param {(msg: string) => void} [opts.log=console.log] progress / information
   * @param {(msg: string) => void} [opts.warn=log] problems with the archive's data
   * @param {LRUCache} [opts.contentCache] shared converted-book cache (default: a private one)
   * @param {number} [opts.contentCacheBytes] budget of the private cache (default 300 MB)
   * @param {object} [opts.archiveOptions] passed to ZimArchive.open (default cluster cache 64 MB)
   * @param {string} [opts.cacheDir] where derived indexes are cached (default <project>/.cache)
   * @param {() => void} [opts.onChange] called when the catalogue changes later (index built)
   * @returns {Promise<ArchiveLibrary>}
   */
  static async open(filePath, {
    id = libraryIdFor(filePath),
    maxGenericBooks = 2000,
    log = console.log,
    warn = log,
    contentCache,
    contentCacheBytes = CONTENT_CACHE_BYTES,
    archiveOptions,
    cacheDir,
    onChange,
  } = {}) {
    const archive = await ZimArchive.open(filePath, { clusterCacheBytes: ARCHIVE_CLUSTER_CACHE_BYTES, ...archiveOptions });
    try {
      const lib = new ArchiveLibrary({
        id, filePath, archive, log, warn, maxGenericBooks, cacheDir, onChange,
        contentCache: contentCache ?? createContentCache(contentCacheBytes),
      });
      await lib.books(); // catalog now: `kind` is final and errors surface at scan time
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
    return this.kind === 'wikisource' ? { ...base, indexing: this._indexing ? { ...this._indexing } : null } : base;
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
        return {
          id: this.id,
          file: this.file,
          kind: this.kind,
          // The client needs something to show; the metadata title is optional in ZIM files.
          title: field('title') ?? this.file.replace(/\.zim$/i, ''),
          description: field('description'),
          longDescription: field('longDescription'),
          language: field('language'),
          date: field('date'),
          creator: field('creator'),
          publisher: field('publisher'),
          name: field('name'),
          bookCount: books.length,
          illustration: illustration ? zimUrl(this.id, illustration.path) : null,
          shelves: this._shelves.slice(),
          ...(this.kind === 'wikisource' ? { genres: this._genres ?? [] } : {}),
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
   * @returns {Promise<{ meta: object, chunks: Chunk[] } | undefined>} undefined for an unknown book
   * @throws {LibraryError} (status 404) when the book has nothing readable
   */
  async content(bookId) {
    const id = String(bookId);
    await this.books();
    const rec = this._byId.get(id);
    if (!rec) return undefined;
    const key = this._cacheKey(id);
    const cached = this._contentCache.get(key);
    if (cached) return cached;
    let pending = this._inflight.get(id);
    if (!pending) {
      pending = (async () => {
        const content = await this._convert(rec);
        this._contentCache.set(key, content);
        return content;
      })();
      const done = () => this._inflight.delete(id);
      pending.then(done, done);
      this._inflight.set(id, pending);
    }
    return pending;
  }

  /**
   * A file inside a book's EPUB (images and other resources of EPUB-only books).
   * @param {string} bookId
   * @param {string} filePath zip-root-relative path, e.g. 'OEBPS/images/fig1.png'
   * @returns {Promise<{ data: Buffer, mime: string } | null>}
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
    this.kind = 'generic';
    return this._genericCatalog();
  }

  // ------------------------------------------------------------------------------------------
  // Wikisource: multi-part works from a cached index (built in the background on first open)

  async _wikisourceCatalog() {
    const file = indexPath(this._cacheDir, this.archive);
    const idx = await loadIndex(file, this.archive);
    if (idx) {
      this._indexing = null;
      return this._booksFromIndex(idx);
    }
    // No index yet: serve an empty shelf while it is built, then announce the new catalogue.
    this._startIndexing(file);
    this._shelves = [];
    this._genres = [];
    return [];
  }

  _startIndexing(file) {
    if (this._indexTask) return;
    const weights = { scan: [0, 0.25], works: [0.25, 0.3], authors: [0.55, 0.45], done: [1, 0] };
    this._indexing = { stage: 'scan', progress: 0 };
    this._log(`${this.file}: indexing Wikisource works in the background (first open only, a few minutes)…`);
    const t0 = performance.now();
    this._indexTask = buildIndex(this.archive, {
      onProgress: (stage, f) => {
        const [base, span] = weights[stage] ?? [0, 0];
        this._indexing = { stage, progress: Math.min(1, base + span * f) };
      },
      log: (m) => this._log(`${this.file}:${m}`),
    }).then(async (idx) => {
      if (this._closed) return;
      await saveIndex(file, idx).catch((err) => this._warn(`${this.file}: cannot cache the Wikisource index (${err.message})`));
      this._indexing = null;
      this._books = null;
      this._info = null;
      this._byId.clear();
      const books = await this.books();
      this._log(`${this.file}: Wikisource index ready: ${books.length} works (${Math.round((performance.now() - t0) / 1000)} s)`);
      this._onChange?.();
    }).catch((err) => {
      if (this._closed) return;
      this._indexing = { stage: 'failed', progress: 0, error: err.message };
      this._warn(`${this.file}: Wikisource indexing failed: ${err.message}`);
    }).finally(() => {
      this._indexTask = null;
    });
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

  async _convert(rec) {
    const { book } = rec;
    let blocks;
    let source;
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
      await this._fixImages(blocks, {
        lookup: (p) => this._zimImage(p),
        fallback: null,
        url: (p) => zimUrl(this.id, p),
      });
    } else if (rec.html) {
      const content = await this.archive.getContent(rec.html);
      if (!content) throw new LibraryError(`book ${book.id}: HTML entry has no content`);
      // Relative links resolve against the entry that actually holds the HTML (after redirects).
      ({ blocks } = htmlToBlocks(decodeHtml(content.data), { docPath: content.entry.path }));
      source = 'html';
      await this._fixImages(blocks, {
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
      await this._fixImages(blocks, {
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

  /** Image facts for an archive path: exists (and is an image), natural size if sniffable. */
  async _zimImage(archivePath) {
    const cached = this._imageInfo.get(archivePath);
    if (cached) return cached;
    let info = { ok: false };
    const entry = await this.archive.findPath(archivePath);
    if (entry) {
      const target = await this.archive.resolveRedirect(entry).catch(() => null);
      if (target && target.mime && /^image\//i.test(target.mime)) {
        const content = await this.archive.getContent(target).catch(() => null);
        if (content) info = { ok: true, ...(imageSize(content.data) ?? {}) };
      }
    }
    this._imageInfo.set(archivePath, info);
    return info;
  }

  /**
   * Checks every image block: fills missing w/h from the image bytes, rewrites `src` to a client
   * URL, and replaces images that are not in the archive with their alt text (or drops them).
   * Works in place on `blocks`.
   */
  async _fixImages(blocks, { lookup, fallback, url }) {
    const imgs = [];
    for (let i = 0; i < blocks.length; i++) if (blocks[i].t === 'img') imgs.push(i);
    if (!imgs.length) return;
    const resolved = new Map(); // src → { path, info } (books repeat decorative images)
    const resolve = async (src) => {
      let r = resolved.get(src);
      if (!r) {
        r = (async () => {
          let info = await lookup(src);
          let p = src;
          if (!info.ok && fallback) {
            const alt = fallback(src);
            if (alt && alt !== src) {
              const altInfo = await lookup(alt);
              if (altInfo.ok) {
                info = altInfo;
                p = alt;
              }
            }
          }
          return { path: p, info };
        })();
        resolved.set(src, r);
      }
      return r;
    };
    const drop = new Set();
    await mapLimit(imgs, IMAGE_PROBE_CONCURRENCY, async (i) => {
      const blk = blocks[i];
      if (blk.src.startsWith('data:')) {
        if (!(blk.w && blk.h)) {
          const size = dataUriSize(blk.src);
          if (size) Object.assign(blk, fillSize(blk, size));
        }
        return;
      }
      const { path: p, info } = await resolve(blk.src);
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
    });
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
    const buf = m[1] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
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

/** All ZIM libraries of one directory. Create with `Library.scan()`. */
export class Library {
  /** @private Use Library.scan(). */
  constructor(dir, contentCache, opts) {
    /** Absolute path of the scanned directory. */
    this.dir = dir;
    this._libs = [];
    this._byId = new Map();
    this._files = new Map(); // file name -> { lib, size, mtimeMs }
    this._failed = new Map(); // file name -> "size:mtime" of the last failed attempt
    this._splitWarned = new Set();
    this._opts = opts;
    this._scanning = null;
    this._rescanAgain = false;
    this._watcher = null;
    this._debounce = null;
    this._interval = null;
    this.contentCache = contentCache;
    /** Increments whenever the set of libraries changes (clients poll it to re-shelve). */
    this.generation = 0;
  }

  /**
   * Lists `*.zim` files in `dir` (case-insensitive, not recursive) and opens each one. Files
   * that cannot be opened are logged and skipped; split archives (.zimaa…) are reported as
   * unsupported.
   * @param {string} dir
   * @param {object} [opts]
   * @param {number} [opts.maxGenericBooks=2000]
   * @param {(msg: string) => void} [opts.log=console.log] progress / information
   * @param {(msg: string) => void} [opts.warn=log] skipped files and problems with archive data
   * @param {number} [opts.contentCacheBytes=314572800] budget for converted books (all archives)
   * @param {object} [opts.archiveOptions] passed to ZimArchive.open (default cluster cache 64 MB)
   * @param {string} [opts.cacheDir] where derived indexes are cached (default <project>/.cache)
   * @returns {Promise<Library>}
   */
  static async scan(dir, {
    maxGenericBooks = 2000,
    log = console.log,
    warn = log,
    contentCacheBytes = CONTENT_CACHE_BYTES,
    archiveOptions,
    cacheDir = DEFAULT_CACHE_DIR,
  } = {}) {
    const abs = path.resolve(dir);
    await fs.readdir(abs); // fail early (and loudly) on a missing or unreadable directory
    const lib = new Library(abs, createContentCache(contentCacheBytes), { maxGenericBooks, log, warn, archiveOptions, cacheDir });
    await lib.rescan({ quiet: true });
    return lib;
  }

  /**
   * Re-reads the directory: opens new `.zim` files, closes removed ones and reopens files whose
   * size or modification time changed (a replaced archive keeps its library id). Concurrent calls
   * share one scan; a call arriving during a scan triggers one more pass after it.
   * @param {{ quiet?: boolean }} [opts] quiet: no summary line (used by the initial scan)
   * @returns {Promise<{ generation: number, added: string[], removed: string[], reopened: string[], failed: string[] }>}
   */
  rescan(opts = {}) {
    if (this._scanning) {
      this._rescanAgain = true;
      return this._scanning;
    }
    this._scanning = (async () => {
      const total = { added: [], removed: [], reopened: [], failed: [] };
      do {
        this._rescanAgain = false;
        const r = await this._rescanOnce(opts);
        for (const k of Object.keys(total)) total[k].push(...r[k]);
      } while (this._rescanAgain);
      return { generation: this.generation, ...total };
    })().finally(() => {
      this._scanning = null;
    });
    return this._scanning;
  }

  async _rescanOnce({ quiet = false } = {}) {
    const { log, warn, maxGenericBooks, archiveOptions, cacheDir } = this._opts;
    const dirents = await fs.readdir(this.dir, { withFileTypes: true });
    const names = dirents.filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const present = new Map();
    for (const name of names) {
      if (/\.zim[a-z]{2}$/i.test(name)) {
        const stem = name.slice(0, -2);
        if (!this._splitWarned.has(stem)) {
          this._splitWarned.add(stem);
          warn(`${stem}aa…: split ZIM archives are not supported (join the parts into one .zim file)`);
        }
        continue;
      }
      if (!/\.zim$/i.test(name)) continue;
      const st = await fs.stat(path.join(this.dir, name)).catch(() => null);
      if (st && st.isFile()) present.set(name, st);
    }

    const added = [];
    const removed = [];
    const reopened = [];
    const failed = [];
    const reuseIds = new Map(); // file name -> library id kept across a reopen
    for (const [name, entry] of [...this._files]) {
      const st = present.get(name);
      if (st && st.size === entry.size && st.mtimeMs === entry.mtimeMs) continue;
      this._files.delete(name);
      this._libs = this._libs.filter((l) => l !== entry.lib);
      this._byId.delete(entry.lib.id);
      await entry.lib.close().catch(() => {});
      if (st) reuseIds.set(name, entry.lib.id);
      else {
        removed.push(entry.lib.id);
        log(`${name}: removed`);
      }
    }
    for (const name of [...this._failed.keys()]) if (!present.has(name)) this._failed.delete(name);

    for (const [name, st] of present) {
      if (this._files.has(name)) continue;
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (this._failed.get(name) === stamp) continue; // unchanged since it last failed: skip quietly
      let id = reuseIds.get(name);
      if (!id) {
        const base = libraryIdFor(name);
        id = base;
        for (let n = 2; this._byId.has(id); n++) id = `${base}-${n}`;
      }
      const t0 = performance.now();
      try {
        const lib = await ArchiveLibrary.open(path.join(this.dir, name), {
          id, maxGenericBooks, log, warn, contentCache: this.contentCache, archiveOptions, cacheDir,
          // A background index finishing changes the catalogue: clients poll `generation`.
          onChange: () => { this.generation++; },
        });
        this._files.set(name, { lib, size: st.size, mtimeMs: st.mtimeMs });
        this._byId.set(id, lib);
        this._libs.push(lib);
        this._failed.delete(name);
        (reuseIds.has(name) ? reopened : added).push(id);
        const count = (await lib.books()).length;
        log(`${name}: ${lib.kind} library, ${count} book(s) (${Math.round(performance.now() - t0)} ms)`);
      } catch (err) {
        // A file that is still being copied or downloaded fails here; it is retried as soon as
        // its size or modification time changes.
        this._failed.set(name, stamp);
        failed.push(name);
        warn(`${name}: skipped, cannot open: ${err.message}`);
      }
    }
    // Keep file-name order, like the initial scan.
    const rank = new Map([...this._files.keys()].sort().map((n, i) => [this._files.get(n).lib, i]));
    this._libs.sort((a, b) => rank.get(a) - rank.get(b));
    if (added.length || removed.length || reopened.length || this.generation === 0) this.generation++;
    if (!quiet && (added.length || removed.length || reopened.length)) {
      log(`Rescan: ${added.length} added, ${removed.length} removed, ${reopened.length} reopened (${this._libs.length} libraries)`);
    }
    return { added, removed, reopened, failed };
  }

  /**
   * Rescans automatically when `.zim` files appear, change or disappear: a debounced fs.watch on
   * the directory (a finished browser download is a rename to *.zim) plus a slow periodic pass in
   * case the platform drops watch events (network drives).
   * @param {{ debounceMs?: number, intervalMs?: number }} [opts]
   * @returns {() => void} stops watching
   */
  watch({ debounceMs = 2500, intervalMs = 60000 } = {}) {
    this.unwatch();
    const schedule = () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this.rescan().catch((e) => this._opts.warn(`Rescan failed: ${e.message}`));
      }, debounceMs);
      this._debounce.unref?.();
    };
    try {
      this._watcher = fsWatch(this.dir, { persistent: false }, (event, filename) => {
        if (!filename || /\.zim([a-z]{2})?$/i.test(String(filename))) schedule();
      });
      this._watcher.on('error', () => {
        this._watcher?.close();
        this._watcher = null;
      });
    } catch (err) {
      this._opts.warn(`Cannot watch ${this.dir} (${err.message}); rescanning every ${Math.round(intervalMs / 1000)} s instead`);
    }
    this._interval = setInterval(schedule, intervalMs);
    this._interval.unref?.();
    return () => this.unwatch();
  }

  /** Stops automatic rescans. */
  unwatch() {
    this._watcher?.close();
    this._watcher = null;
    clearTimeout(this._debounce);
    clearInterval(this._interval);
    this._debounce = null;
    this._interval = null;
  }

  /** @returns {ArchiveLibrary[]} in file-name order */
  list() {
    return this._libs.slice();
  }

  /**
   * @param {string} libId
   * @returns {ArchiveLibrary|undefined}
   */
  get(libId) {
    return this._byId.get(libId);
  }

  /** Stops watching and closes every archive. */
  async close() {
    this.unwatch();
    if (this._scanning) await this._scanning.catch(() => {});
    await Promise.allSettled(this._libs.map((l) => l.close()));
    this.contentCache.clear();
  }
}
