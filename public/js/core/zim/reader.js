/**
 * Low-level ZIM reader (§2.1, §3.1), shared by the server and the browser (core/platform.js).
 *
 * Everything is read with positional reads on one byte source (a file on Node, a Blob or File in
 * a browser: `{ name, size, read(position, length), close() }`); nothing reads a whole file.
 * Uncompressed clusters are never loaded whole (only the two blob offsets and the blob bytes);
 * compressed clusters are decompressed asynchronously (the platform's zstd/zlib, xz in JS),
 * cached in a byte-budgeted LRU, and concurrent requests for one cluster share one decompression.
 */
import { platform } from '../platform.js';
import { allOnes64, bytesEqual, compareBytes, u16, u32, u64 as u64Raw } from '../util/bytes.js';
import { LRUCache } from '../util/lru.js';
import { BlobSource } from './blob-source.js';
import { xzDecompress } from './xz.js';

/** Any problem with the ZIM file itself (bad magic, truncation, corrupt structures, ranges). */
export class ZimError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ZimError';
  }
}

const ZIM_MAGIC = 0x044d495a;
const HEADER_SIZE = 80;
const NO_PAGE = 0xffffffff;
const MIME_REDIRECT = 0xffff;
const MIME_LINKTARGET = 0xfffe;
const MIME_DELETED = 0xfffd;

const COMP_NONE_0 = 0;
const COMP_NONE = 1;
const COMP_ZLIB = 2;
const COMP_BZIP2 = 3;
const COMP_XZ = 4;
const COMP_ZSTD = 5;

/** URL pointers are read in pages of this many entries (8 KiB) and cached. */
const PTR_PAGE_BITS = 10;
const PTR_PAGE_SIZE = 1 << PTR_PAGE_BITS;
/** First guess for a directory entry's size; long URLs/titles trigger a bigger re-read. */
const DIRENT_GUESS = 512;
const DIRENT_MAX = 1 << 20;
/** entries(): number of directory entries fetched per batch. */
const ITER_BATCH = 512;
/** entries(): dirents closer together than this are fetched with one read. */
const ITER_SPAN = 256 * 1024;
/** Reads smaller than this are served from cached, aligned blocks of this size (_readBlocks). */
const READ_BLOCK = 64 * 1024;
/** Default byte budget of the block cache. */
const BLOCK_CACHE_BYTES = 8 * 1024 * 1024;
/**
 * First read size for a compressed cluster whose end is not another cluster's start (see
 * _decompressCluster); grows x4 until the cluster decompresses completely.
 */
const TAIL_WINDOW = 4 * 1024 * 1024;

/** Private: raw sort key (namespace byte + URL bytes) kept on cached entries. */
const KEY = Symbol('zimKey');

/**
 * @typedef {object} Entry
 * @property {number} index        position in the URL pointer list
 * @property {string} ns           namespace character
 * @property {string} url
 * @property {string} path         `${ns}/${url}`
 * @property {string} title        falls back to url
 * @property {number} mimeIndex    raw MIME field (0xFFFF redirect, 0xFFFE/0xFFFD special)
 * @property {string|null} mime    null for redirects and special entries
 * @property {boolean} isRedirect
 * @property {number|null} redirectIndex
 * @property {number|null} cluster
 * @property {number|null} blob
 */

/** A 64-bit header field: null when all ones (absent). */
function u64(buf, off) {
  return allOnes64(buf, off) ? null : u64Raw(buf, off);
}

function makeKey(ns, url) {
  if (typeof ns !== 'string' || ns.length !== 1) throw new ZimError(`invalid namespace ${JSON.stringify(ns)}`);
  const code = ns.charCodeAt(0);
  if (code > 0x7f) throw new ZimError(`invalid namespace ${JSON.stringify(ns)}`);
  const urlBytes = platform.encodeUtf8(String(url));
  const key = new Uint8Array(urlBytes.length + 1);
  key[0] = code;
  key.set(urlBytes, 1);
  return key;
}

/**
 * Parses one directory entry from buf[off...]. Returns null when buf ends before the entry does
 * (the caller then re-reads with a larger buffer).
 */
function parseDirent(buf, off, index, mimeTypes) {
  if (off + 8 > buf.length) return null;
  const mimeIndex = u16(buf, off);
  const paramLen = buf[off + 2];
  const nsByte = buf[off + 3];
  let pos;
  let redirectIndex = null;
  let cluster = null;
  let blob = null;
  if (mimeIndex === MIME_REDIRECT) {
    if (off + 12 > buf.length) return null;
    redirectIndex = u32(buf, off + 8);
    pos = off + 12;
  } else if (mimeIndex === MIME_LINKTARGET || mimeIndex === MIME_DELETED) {
    pos = off + 8;
  } else {
    if (off + 16 > buf.length) return null;
    cluster = u32(buf, off + 8);
    blob = u32(buf, off + 12);
    pos = off + 16;
  }
  const urlEnd = buf.indexOf(0, pos);
  if (urlEnd < 0) return null;
  const titleEnd = buf.indexOf(0, urlEnd + 1);
  if (titleEnd < 0 || titleEnd + 1 + paramLen > buf.length) return null;

  let mime = null;
  if (redirectIndex === null && cluster !== null) {
    mime = mimeTypes[mimeIndex];
    if (mime === undefined) throw new ZimError(`entry ${index}: invalid MIME type index ${mimeIndex}`);
  }
  const ns = String.fromCharCode(nsByte);
  const url = platform.utf8(buf, pos, urlEnd);
  const title = titleEnd > urlEnd + 1 ? platform.utf8(buf, urlEnd + 1, titleEnd) : url;
  const key = new Uint8Array(urlEnd - pos + 1);
  key[0] = nsByte;
  key.set(buf.subarray(pos, urlEnd), 1);
  const entry = {
    index, ns, url, path: `${ns}/${url}`, title, mimeIndex, mime,
    isRedirect: redirectIndex !== null, redirectIndex, cluster, blob,
  };
  Object.defineProperty(entry, KEY, { value: key });
  return entry;
}

/** Number of the smallest element of sorted `arr` that is > v (arr.length if none). */
function upperBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2); // entry counts can exceed 2^31
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Reads one blob offset from a cluster offset table. */
function readOffset(buf, pos, extended) {
  return extended ? u64Raw(buf, pos) : u32(buf, pos);
}

/** True when decompressed cluster data is at least as long as its offset table says. */
function clusterDataComplete(data, extended) {
  const offSize = extended ? 8 : 4;
  if (data.length < offSize) return false;
  const first = readOffset(data, 0, extended);
  if (first < offSize || first > data.length) return false;
  return readOffset(data, first - offSize, extended) <= data.length;
}

/** A ZIM archive opened for reading. Create with `ZimArchive.open()`. */
export class ZimArchive {
  /** @private Use ZimArchive.open(). */
  constructor(source, opts) {
    /** The file's path (Node) or name (a browser File): for messages. @type {string} */
    this.filePath = source.name;
    this.fileSize = source.size;
    this._source = source;
    this._closed = false;
    /**
     * { major, minor, uuid (32 hex chars), entryCount, clusterCount, mainPage, layoutPage,
     *   urlPtrPos, titlePtrPos, clusterPtrPos, mimeListPos, checksumPos }. Page indexes are null
     * when 0xFFFFFFFF; positions are Numbers, or null when the field is all ones (absent — e.g.
     * titlePtrPos in files written by libzim >= 7).
     */
    this.header = null;
    /** @type {string[]} */
    this.mimeTypes = [];
    this.newNamespaceScheme = false;
    this.entryCount = 0;
    this.clusterCount = 0;
    this._clusterOffsets = null; // Float64Array, by cluster number
    this._boundaries = null; // Float64Array, sorted: every known section/cluster start + file size
    this._sectionStarts = null; // Set of the non-cluster boundaries
    this._ptrPages = new LRUCache({ maxEntries: 2048 });
    this._ptrPagesInflight = new Map();
    this._blocks = new LRUCache({ maxBytes: opts.blockCacheBytes, sizeOf: (b) => b.length + 32 }); // block number → bytes
    this._blocksInflight = new Map();
    this._wholeClusterBytes = opts.wholeClusterBytes;
    this._blobsWanted = new LRUCache({ maxEntries: 4096 }); // cluster → blobs asked of it so far (_readWhole)
    this._tailWindow = opts.tailWindowBytes;
    this._dirents = new LRUCache({ maxEntries: opts.direntCacheEntries });
    this._clusterInfo = new LRUCache({ maxEntries: 65536 });
    this._clusters = new LRUCache({
      maxBytes: opts.clusterCacheBytes,
      sizeOf: (c) => c.data.length + 64,
    });
    this._clustersInflight = new Map();
    this._metadata = null;
  }

  /**
   * Opens and validates a ZIM file: reads the header, the MIME list and the cluster pointer list
   * (URL pointers are paged in lazily, so opening is fast even for huge archives).
   * @param {string|Blob|{ name: string, size: number, read: (position: number, length: number) => Promise<Uint8Array>, close?: () => Promise<void> }} input
   *   a file path (the platform opens it: Node only), a Blob or File, or a byte source whose
   *   read() resolves with `length` bytes, fewer only at the end
   * @param {object} [opts]
   * @param {number} [opts.clusterCacheBytes=268435456] budget for decompressed clusters
   * @param {number} [opts.direntCacheEntries=50000] number of parsed directory entries to cache
   * @param {number} [opts.blockCacheBytes=8388608] budget for the block cache (_readBlocks), which
   *   serves every read under 64 KB: dirents, URL pointers, cluster heads, small blobs; 0 reads
   *   each from the source
   * @param {number} [opts.wholeClusterBytes=0] an uncompressed cluster up to this big is read whole
   *   into the cluster cache when a blob of it is wanted (_readWhole), not blob by blob
   * @param {number} [opts.tailWindowBytes=4194304] first read size for a compressed cluster whose
   *   end is not exactly known (advanced; mainly for tests)
   * @returns {Promise<ZimArchive>}
   * @throws {ZimError} for files that are not ZIM files, truncated or structurally invalid
   */
  static async open(input, {
    clusterCacheBytes = 256 * 1024 * 1024,
    direntCacheEntries = 50000,
    blockCacheBytes = BLOCK_CACHE_BYTES,
    wholeClusterBytes = 0,
    tailWindowBytes = TAIL_WINDOW,
  } = {}) {
    const name = typeof input === 'string' ? input : input?.name || 'archive';
    let source;
    try {
      if (typeof input === 'string') source = await platform.openFile(input);
      else if (typeof Blob !== 'undefined' && input instanceof Blob) source = new BlobSource(input);
      else source = input;
    } catch (err) {
      throw new ZimError(`cannot open ${name}: ${err.message}`, { cause: err });
    }
    try {
      const zim = new ZimArchive(source, { clusterCacheBytes, direntCacheEntries, blockCacheBytes, wholeClusterBytes, tailWindowBytes });
      await zim._init();
      return zim;
    } catch (err) {
      await Promise.resolve(source.close?.()).catch(() => {});
      if (err instanceof ZimError) throw err;
      throw new ZimError(`cannot read ZIM file ${name}: ${err.message}`, { cause: err });
    }
  }

  /** Closes the file. Later calls on this archive throw ZimError. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._clusters.clear();
    this._dirents.clear();
    this._blocks.clear();
    await this._source.close?.();
  }

  async _init() {
    const size = this.fileSize;
    if (size < HEADER_SIZE) throw new ZimError(`${this.filePath}: not a ZIM file (too small)`);
    const h = await this._read(0, HEADER_SIZE);
    if (u32(h, 0) !== ZIM_MAGIC) throw new ZimError(`${this.filePath}: not a ZIM file (bad magic)`);
    const major = u16(h, 4);
    const minor = u16(h, 6);
    if (major < 4 || major > 6) throw new ZimError(`${this.filePath}: unsupported ZIM version ${major}.${minor}`);
    const mainPage = u32(h, 64);
    const layoutPage = u32(h, 68);
    const header = {
      major,
      minor,
      uuid: platform.hex(h, 8, 24),
      entryCount: u32(h, 24),
      clusterCount: u32(h, 28),
      urlPtrPos: u64(h, 32),
      titlePtrPos: u64(h, 40),
      clusterPtrPos: u64(h, 48),
      mimeListPos: u64(h, 56),
      mainPage: mainPage === NO_PAGE ? null : mainPage,
      layoutPage: layoutPage === NO_PAGE ? null : layoutPage,
      checksumPos: u64(h, 72),
    };
    this.header = header;
    this.entryCount = header.entryCount;
    this.clusterCount = header.clusterCount;

    const truncated = (what) => new ZimError(`${this.filePath}: ZIM file is truncated or corrupt (${what} beyond end of file)`);
    if (header.urlPtrPos === null || header.urlPtrPos + header.entryCount * 8 > size) throw truncated('URL pointer list');
    if (header.clusterPtrPos === null || header.clusterPtrPos + header.clusterCount * 8 > size) {
      throw truncated('cluster pointer list');
    }
    if (header.mimeListPos === null || header.mimeListPos >= size) throw truncated('MIME type list');
    // A checksum position of 0 means "none" in very old files.
    if (header.checksumPos && header.checksumPos + 16 > size) throw truncated('checksum');

    this.mimeTypes = await this._readMimeList(header.mimeListPos);

    // Cluster pointers, plus the sorted set of every known start position: a cluster ends where
    // the next thing in the file begins (§2.1).
    const n = header.clusterCount;
    const offsets = new Float64Array(n);
    if (n > 0) {
      const buf = await this._read(header.clusterPtrPos, n * 8);
      for (let i = 0; i < n; i++) {
        const off = u64Raw(buf, i * 8);
        if (off < HEADER_SIZE || off >= size) throw truncated(`cluster ${i}`);
        offsets[i] = off;
      }
    }
    this._clusterOffsets = offsets;
    const bounds = [size];
    for (const pos of [header.urlPtrPos, header.titlePtrPos, header.clusterPtrPos, header.mimeListPos, header.checksumPos]) {
      if (pos !== null && pos > 0 && pos < size) bounds.push(pos);
    }
    const all = new Float64Array(n + bounds.length);
    all.set(offsets);
    all.set(bounds, n);
    all.sort();
    this._boundaries = all;
    this._sectionStarts = new Set(bounds);

    // New scheme (libzim >= 7): content lives in 'C'. Old-scheme files never use 'C'.
    const firstC = await this.lowerBound('C', '');
    this.newNamespaceScheme = firstC < this.entryCount && (await this.getEntryByIndex(firstC)).ns === 'C';
  }

  async _readMimeList(pos) {
    const types = [];
    let chunk = 4096;
    for (;;) {
      const len = Math.min(chunk, this.fileSize - pos);
      const buf = await this._read(pos, len);
      types.length = 0;
      let start = 0;
      let done = false;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0) continue;
        if (i === start) {
          done = true;
          break;
        }
        types.push(platform.utf8(buf, start, i));
        start = i + 1;
      }
      if (done) return types;
      if (len < chunk || chunk >= DIRENT_MAX) throw new ZimError(`${this.filePath}: corrupt MIME type list`);
      chunk *= 4;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Raw I/O

  /**
   * Reads exactly `length` bytes at `position` (throws ZimError at end of file). A read under
   * READ_BLOCK bytes comes from the block cache (_readBlocks), a bigger one from the source.
   */
  async _read(position, length) {
    if (this._closed) throw new ZimError(`${this.filePath}: archive is closed`);
    if (length < READ_BLOCK && this._blocks.maxBytes > 0) return this._readBlocks(position, length);
    return this._readRaw(position, length);
  }

  /** One read from the source, of exactly `length` bytes. */
  async _readRaw(position, length) {
    const buf = await this._source.read(position, length);
    if (buf.length < length) {
      throw new ZimError(`${this.filePath}: unexpected end of file reading ${length} bytes at ${position}`);
    }
    return buf;
  }

  /**
   * A small read served from the block cache: aligned READ_BLOCK-byte blocks, each read once
   * while cached (blockCacheBytes). On a File in a browser a read costs about the same however
   * small (on a Quest 3 ~65 ms alone, ~11 ms each when 8 or more run at once; a 4 MB read only
   * 87 ms), so what counts is how many reads are made: a lookup is a binary search reading one
   * dirent per step (opening a 4.5 GB Gutenberg ZIM made 3,200 such reads over 1.7 MB of
   * directory), a book's size at open two tiny reads from its cluster's head, a picture's bytes
   * two or three. The bytes returned are the cache's: do not modify them.
   */
  async _readBlocks(position, length) {
    const first = Math.floor(position / READ_BLOCK);
    const last = Math.floor((position + length - 1) / READ_BLOCK);
    const short = () => new ZimError(`${this.filePath}: unexpected end of file reading ${length} bytes at ${position}`);
    if (first === last) {
      const block = await this._block(first);
      const from = position - first * READ_BLOCK;
      if (from + length > block.length) throw short();
      return block.subarray(from, from + length);
    }
    const out = platform.alloc(length);
    let filled = 0;
    for (let b = first; b <= last; b++) {
      const block = await this._block(b);
      const from = b === first ? position - first * READ_BLOCK : 0;
      const n = Math.min(block.length - from, length - filled);
      if (n <= 0) throw short();
      out.set(block.subarray(from, from + n), filled);
      filled += n;
    }
    if (filled < length) throw short();
    return out;
  }

  /** Block number `b` of the block cache, read once; concurrent callers share the read. */
  async _block(b) {
    const cached = this._blocks.get(b);
    if (cached) return cached;
    let pending = this._blocksInflight.get(b);
    if (!pending) {
      pending = (async () => {
        const start = b * READ_BLOCK;
        const block = await this._readRaw(start, Math.min(READ_BLOCK, this.fileSize - start));
        this._blocks.set(b, block);
        return block;
      })();
      const done = () => this._blocksInflight.delete(b);
      pending.then(done, done);
      this._blocksInflight.set(b, pending);
    }
    return pending;
  }

  // ------------------------------------------------------------------------------------------
  // Directory entries

  async _ptrPage(page) {
    const cached = this._ptrPages.get(page);
    if (cached) return cached;
    let pending = this._ptrPagesInflight.get(page);
    if (!pending) {
      pending = (async () => {
        const first = page * PTR_PAGE_SIZE;
        const count = Math.min(PTR_PAGE_SIZE, this.entryCount - first);
        const buf = await this._read(this.header.urlPtrPos + first * 8, count * 8);
        const ptrs = new Float64Array(count);
        for (let i = 0; i < count; i++) ptrs[i] = u64Raw(buf, i * 8);
        this._ptrPages.set(page, ptrs);
        return ptrs;
      })();
      const done = () => this._ptrPagesInflight.delete(page);
      pending.then(done, done);
      this._ptrPagesInflight.set(page, pending);
    }
    return pending;
  }

  async _direntPtr(index) {
    const page = await this._ptrPage(index >>> PTR_PAGE_BITS);
    return page[index & (PTR_PAGE_SIZE - 1)];
  }

  _checkIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entryCount) {
      throw new ZimError(`${this.filePath}: entry index ${index} out of range (0..${this.entryCount - 1})`);
    }
  }

  async _readDirentAt(ptr, index) {
    let len = DIRENT_GUESS;
    for (;;) {
      const avail = this.fileSize - ptr;
      if (avail < 8) throw new ZimError(`${this.filePath}: directory entry ${index} beyond end of file`);
      const buf = await this._read(ptr, Math.min(len, avail));
      const entry = parseDirent(buf, 0, index, this.mimeTypes);
      if (entry) return entry;
      if (len >= avail || len >= DIRENT_MAX) {
        throw new ZimError(`${this.filePath}: directory entry ${index} is truncated or corrupt`);
      }
      len *= 8;
    }
  }

  /**
   * Returns the directory entry at `index` (URL pointer order).
   * The returned objects are shared with the cache: treat them as read-only.
   * @param {number} index
   * @returns {Promise<Entry>}
   */
  async getEntryByIndex(index) {
    const cached = this._dirents.get(index);
    if (cached) return cached;
    this._checkIndex(index);
    const entry = await this._readDirentAt(await this._direntPtr(index), index);
    this._dirents.set(index, entry);
    return entry;
  }

  /**
   * First index whose (namespace, URL) is >= (ns, urlPrefix), comparing UTF-8 bytes like libzim
   * (JS string comparison is UTF-16 order, which differs for astral characters).
   * @param {string} ns
   * @param {string} urlPrefix
   * @returns {Promise<number>} entryCount if every entry sorts before
   */
  async lowerBound(ns, urlPrefix) {
    return this._lowerBoundKey(makeKey(ns, urlPrefix));
  }

  async _lowerBoundKey(key) {
    let lo = 0;
    let hi = this.entryCount;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2); // entry counts can exceed 2^31
      const entry = await this.getEntryByIndex(mid);
      if (compareBytes(entry[KEY], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Exact lookup by namespace and URL (binary search over the URL pointer list).
   * @param {string} ns
   * @param {string} url
   * @returns {Promise<Entry|null>}
   */
  async findEntry(ns, url) {
    const key = makeKey(ns, url);
    const i = await this._lowerBoundKey(key);
    if (i >= this.entryCount) return null;
    const entry = await this.getEntryByIndex(i);
    return bytesEqual(entry[KEY], key) ? entry : null;
  }

  /**
   * Looks up a full archive path: 'C/foo/bar' → namespace 'C', URL 'foo/bar'.
   * @param {string} path
   * @returns {Promise<Entry|null>} null if absent or not of the form '<ns>/<url>'
   */
  async findPath(path) {
    if (typeof path !== 'string') return null;
    const p = path.startsWith('/') ? path.slice(1) : path;
    if (p.length < 2 || p[1] !== '/' || p.charCodeAt(0) > 0x7f) return null;
    return this.findEntry(p[0], p.slice(2));
  }

  /**
   * Looks a URL up in several namespaces (new and old scheme) and returns the first hit.
   * @param {string} url
   * @param {string[]} [namespaces=['C','A','I','-']]
   * @returns {Promise<Entry|null>}
   */
  async findContentPath(url, namespaces = ['C', 'A', 'I', '-']) {
    for (const ns of namespaces) {
      const entry = await this.findEntry(ns, url);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Follows a redirect chain to the final entry.
   * @param {Entry} entry
   * @param {number} [maxHops=16]
   * @returns {Promise<Entry>}
   * @throws {ZimError} on loops, chains longer than maxHops, or out-of-range targets
   */
  async resolveRedirect(entry, maxHops = 16) {
    let current = entry;
    const seen = new Set([current.index]);
    while (current.isRedirect) {
      if (seen.size > maxHops) {
        throw new ZimError(`${this.filePath}: redirect chain from ${entry.path} longer than ${maxHops} hops`);
      }
      const target = current.redirectIndex;
      if (seen.has(target)) throw new ZimError(`${this.filePath}: redirect loop at ${entry.path}`);
      if (!Number.isInteger(target) || target < 0 || target >= this.entryCount) {
        throw new ZimError(`${this.filePath}: ${current.path} redirects to invalid index ${target}`);
      }
      seen.add(target);
      current = await this.getEntryByIndex(target);
    }
    return current;
  }

  /**
   * Reads an entry's content, following redirects.
   * @param {Entry|string} entryOrPath an Entry or a full path such as 'C/index.html'
   * @returns {Promise<{ entry: Entry, mime: string, data: Uint8Array } | null>} null if the path is
   *   absent or the entry has no content (linktarget / deleted entries)
   */
  async getContent(entryOrPath) {
    const start = typeof entryOrPath === 'string' ? await this.findPath(entryOrPath) : entryOrPath;
    if (!start) return null;
    const entry = await this.resolveRedirect(start);
    if (entry.cluster === null) return null;
    const data = await this._readBlob(entry.cluster, entry.blob);
    return { entry, mime: entry.mime, data };
  }

  /**
   * Size in bytes of an entry's content (redirects followed).
   * Uncompressed clusters: reads two offsets only. Compressed clusters: decompresses the cluster,
   * unless `cheapOnly` is set and it is not cached, in which case null is returned.
   * @param {Entry} entry
   * @param {{ cheapOnly?: boolean }} [opts]
   * @returns {Promise<number|null>} null when unknown (cheapOnly) or the entry has no content
   */
  async getBlobSize(entry, { cheapOnly = false } = {}) {
    const target = await this.resolveRedirect(entry);
    if (target.cluster === null) return null;
    const info = await this._getClusterInfo(target.cluster);
    let cluster = this._clusters.get(target.cluster);
    if (!cluster && !info.compressed) { // never read whole for a size alone (_readWhole)
      const [start, end] = await this._uncompressedBlobRange(info, target.blob);
      return end - start;
    }
    if (!cluster) {
      if (cheapOnly) return null;
      cluster = await this._loadCluster(target.cluster, info);
    }
    const [start, end] = this._blobRange(cluster, target.cluster, target.blob);
    return end - start;
  }

  /**
   * The sizes of some blobs of one cluster, and the first `head` bytes of each (all of a smaller
   * one), from one decompression and without directory entries: for passes over a whole archive
   * in cluster order (the Wikipedia index), where re-reading each entry cost more than the
   * decompression. `cache: false` leaves the cluster cache alone (each cluster is used once).
   * Content of a compressed cluster is a view into its data: use it before the next call.
   * @param {number} clusterIndex
   * @param {number[]} blobs
   * @param {{ head?: number, cache?: boolean }} [opts] head 0: sizes only (data null)
   * @returns {Promise<Array<{ size: number, data: Uint8Array|null }>>}
   */
  async clusterBlobs(clusterIndex, blobs, { head = 0, cache = true } = {}) {
    const info = await this._getClusterInfo(clusterIndex);
    if (!info.compressed) {
      return Promise.all(blobs.map(async (blob) => {
        const [start, end] = await this._uncompressedBlobRange(info, blob);
        const n = Math.min(end - start, head);
        return { size: end - start, data: !head ? null : n > 0 ? await this._read(start, n) : platform.alloc(0) };
      }));
    }
    let cluster = this._clusters.get(clusterIndex);
    if (!cluster && cache) cluster = await this._loadCluster(clusterIndex, info);
    if (!cluster) {
      const data = await this._decompressCluster(info);
      cluster = { data, extended: info.extended, blobCount: this._validateOffsets(data, info.extended, clusterIndex) };
    }
    return blobs.map((blob) => {
      const [start, end] = this._blobRange(cluster, clusterIndex, blob);
      return { size: end - start, data: head ? cluster.data.subarray(start, Math.min(end, start + head)) : null };
    });
  }

  /**
   * All metadata ('M' namespace) entries with a text/* MIME type, decoded as UTF-8.
   * @returns {Promise<Record<string, string>>} a fresh object on every call
   */
  async getMetadata() {
    if (!this._metadata) {
      this._metadata = (async () => {
        const meta = {};
        for await (const entry of this.entries(await this.lowerBound('M', ''), await this.lowerBound('N', ''))) {
          const target = entry.isRedirect ? await this.resolveRedirect(entry) : entry;
          if (target.cluster === null || !target.mime || !target.mime.startsWith('text/')) continue;
          meta[entry.url] = platform.utf8(await this._readBlob(target.cluster, target.blob));
        }
        return meta;
      })();
      this._metadata.catch(() => { this._metadata = null; });
    }
    return { ...(await this._metadata) };
  }

  /**
   * The main page: header.mainPage (or, failing that, 'W/mainPage'), with redirects resolved.
   * @returns {Promise<Entry|null>}
   */
  async getMainEntry() {
    const index = this.header.mainPage;
    let entry = null;
    if (index !== null && index < this.entryCount) entry = await this.getEntryByIndex(index);
    else if (this.newNamespaceScheme) entry = await this.findEntry('W', 'mainPage');
    return entry ? this.resolveRedirect(entry) : null;
  }

  /**
   * Iterates directory entries in index (URL) order. Reads URL pointers and directory entries in
   * batches, so a full scan costs few system calls.
   * @param {number} [start=0]
   * @param {number} [end=entryCount]
   * @returns {AsyncGenerator<Entry>}
   */
  async *entries(start = 0, end = this.entryCount) {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.entryCount, Math.floor(end));
    for (let i = from; i < to; i += ITER_BATCH) {
      const batch = await this._readEntryBatch(i, Math.min(to, i + ITER_BATCH));
      for (const entry of batch) yield entry;
    }
  }

  async _readEntryBatch(start, end) {
    const out = new Array(end - start);
    const missing = [];
    for (let i = start; i < end; i++) {
      const cached = this._dirents.get(i);
      if (cached) out[i - start] = cached;
      else missing.push({ index: i, ptr: await this._direntPtr(i) });
    }
    // Dirents are usually laid out contiguously: read neighbouring ones with one read.
    missing.sort((a, b) => a.ptr - b.ptr);
    let k = 0;
    while (k < missing.length) {
      const first = missing[k].ptr;
      let last = k;
      while (last + 1 < missing.length && missing[last + 1].ptr - first <= ITER_SPAN) last++;
      const readEnd = Math.min(this.fileSize, missing[last].ptr + DIRENT_GUESS);
      const buf = first < this.fileSize ? await this._read(first, readEnd - first) : platform.alloc(0);
      for (let m = k; m <= last; m++) {
        const { index, ptr } = missing[m];
        const entry = parseDirent(buf, ptr - first, index, this.mimeTypes) ??
          await this._readDirentAt(ptr, index);
        this._dirents.set(index, entry);
        out[index - start] = entry;
      }
      k = last + 1;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Clusters and blobs

  _clusterEnd(start) {
    const i = upperBound(this._boundaries, start);
    return i < this._boundaries.length ? this._boundaries[i] : this.fileSize;
  }

  /** Compression byte + (for uncompressed clusters) the blob count, cached per cluster. */
  async _getClusterInfo(clusterIndex) {
    const cached = this._clusterInfo.get(clusterIndex);
    if (cached) return cached;
    if (!Number.isInteger(clusterIndex) || clusterIndex < 0 || clusterIndex >= this.clusterCount) {
      throw new ZimError(`${this.filePath}: cluster ${clusterIndex} out of range (0..${this.clusterCount - 1})`);
    }
    const start = this._clusterOffsets[clusterIndex];
    const end = this._clusterEnd(start);
    const head = await this._read(start, Math.min(9, end - start));
    const comp = head[0] & 0x0f;
    const extended = (head[0] & 0x10) !== 0;
    const info = {
      index: clusterIndex, start, end, comp, extended, compressed: comp > COMP_NONE, blobCount: 0,
      // false when the range runs up to a section start instead of the next cluster: then it may
      // include unrelated bytes, e.g. all directory entries (libzim writes them after the clusters).
      exactEnd: !this._sectionStarts.has(end),
    };
    if (comp === COMP_NONE || comp === COMP_NONE_0) {
      const offSize = extended ? 8 : 4;
      if (head.length < 1 + offSize) throw new ZimError(`${this.filePath}: cluster ${clusterIndex} is truncated`);
      const first = readOffset(head, 1, extended);
      if (first % offSize !== 0 || first < offSize || start + 1 + first > end) {
        throw new ZimError(`${this.filePath}: cluster ${clusterIndex} has a corrupt offset table`);
      }
      info.blobCount = first / offSize - 1;
    } else if (comp !== COMP_ZLIB && comp !== COMP_BZIP2 && comp !== COMP_XZ && comp !== COMP_ZSTD) {
      throw new ZimError(`${this.filePath}: cluster ${clusterIndex} has unknown compression type ${comp}`);
    }
    this._clusterInfo.set(clusterIndex, info);
    return info;
  }

  /** Absolute file range [start, end) of a blob in an uncompressed cluster (2 offsets read). */
  async _uncompressedBlobRange(info, blob) {
    if (!Number.isInteger(blob) || blob < 0 || blob >= info.blobCount) {
      throw new ZimError(`${this.filePath}: blob ${blob} out of range in cluster ${info.index} (${info.blobCount} blobs)`);
    }
    const offSize = info.extended ? 8 : 4;
    const base = info.start + 1;
    const buf = await this._read(base + blob * offSize, 2 * offSize);
    const a = readOffset(buf, 0, info.extended);
    const b = readOffset(buf, offSize, info.extended);
    if (b < a || base + b > info.end) {
      throw new ZimError(`${this.filePath}: cluster ${info.index} has a corrupt offset table`);
    }
    return [base + a, base + b];
  }

  /** [start, end) of a blob inside a decompressed cluster's data. */
  _blobRange(cluster, clusterIndex, blob) {
    if (!Number.isInteger(blob) || blob < 0 || blob >= cluster.blobCount) {
      throw new ZimError(`${this.filePath}: blob ${blob} out of range in cluster ${clusterIndex} (${cluster.blobCount} blobs)`);
    }
    const offSize = cluster.extended ? 8 : 4;
    return [readOffset(cluster.data, blob * offSize, cluster.extended),
      readOffset(cluster.data, (blob + 1) * offSize, cluster.extended)];
  }

  async _readBlob(clusterIndex, blob) {
    const info = await this._getClusterInfo(clusterIndex);
    let cluster = this._clusters.get(clusterIndex);
    if (!cluster && !info.compressed && !this._readWhole(info, blob)) {
      const [start, end] = await this._uncompressedBlobRange(info, blob);
      if (end <= start) return platform.alloc(0);
      const data = await this._read(start, end - start);
      // A small read is a view of a cached block (_readBlocks): copied, as callers may keep or
      // modify the data.
      return end - start < READ_BLOCK ? platform.copy(data) : data;
    }
    cluster ??= await this._loadCluster(clusterIndex, info);
    const [start, end] = this._blobRange(cluster, clusterIndex, blob);
    // Copy: callers may keep or modify the data, and a slice would pin the whole cluster in
    // memory after the LRU has dropped it.
    return platform.copy(cluster.data.subarray(start, end));
  }

  /**
   * Whether an uncompressed cluster is now read whole into the cluster cache (wholeClusterBytes)
   * rather than blob by blob: in a browser a File read costs about the same however big (on a
   * Quest 3 a 4 MB read 87 ms, an 8-byte one 70 ms), and a book's pictures share a few clusters
   * (The Book of the Cat: 362 pictures, each read on its own, took 13 s). Only from the second
   * blob wanted of a cluster: a book whose pictures lie one per cluster (Wild Spain: 125 in 65)
   * would otherwise read a whole cluster for each, 118 MB for 2.4 MB of pictures. Never for a
   * size alone (getBlobSize): sizing every book at open would read gigabytes. The server leaves
   * it off: its reads are cheap, and images and EPUBs can be tens of MB.
   */
  _readWhole(info, blob) {
    if (!(info.end - info.start - 1 <= this._wholeClusterBytes)) return false;
    const wanted = this._blobsWanted.get(info.index) ?? new Set();
    wanted.add(blob);
    this._blobsWanted.set(info.index, wanted);
    return wanted.size > 1;
  }

  /**
   * Loads a cluster into the cache, deduplicating concurrent requests: decompressed, or an
   * uncompressed one read whole (_readWhole).
   */
  _loadCluster(clusterIndex, info) {
    let pending = this._clustersInflight.get(clusterIndex);
    if (pending) return pending;
    pending = (async () => {
      const data = info.compressed ? await this._decompressCluster(info) : await this._read(info.start + 1, info.end - info.start - 1);
      const cluster = { data, extended: info.extended, blobCount: 0 };
      cluster.blobCount = this._validateOffsets(data, info.extended, clusterIndex);
      this._clusters.set(clusterIndex, cluster);
      return cluster;
    })();
    const done = () => this._clustersInflight.delete(clusterIndex);
    pending.then(done, done);
    this._clustersInflight.set(clusterIndex, pending);
    return pending;
  }

  /**
   * Reads and decompresses a cluster. When the cluster's end is not exactly known, reading the
   * whole range could mean reading gigabytes of directory entries, so it is read in growing
   * windows until the data is complete — like libzim, which streams and stops at the end.
   * Completeness is judged by the offset table itself (its last offset is the data size), because
   * Node's zstd returns truncated output without an error.
   */
  async _decompressCluster(info) {
    const clusterIndex = info.index;
    const total = info.end - info.start - 1;
    let len = info.exactEnd ? total : Math.min(total, Math.max(1, this._tailWindow));
    for (;;) {
      const raw = await this._read(info.start + 1, len);
      let data = null;
      let error = null;
      try {
        data = await this._decompress(info.comp, raw, clusterIndex);
      } catch (err) {
        if (err instanceof ZimError) throw err;
        error = err;
      }
      if (data && clusterDataComplete(data, info.extended)) return data;
      const truncated = error ? error.code === 'Z_BUF_ERROR' || error.code === 'ERR_XZ_TRUNCATED' : true;
      if (len < total && truncated) {
        len = Math.min(total, len * 4);
        continue;
      }
      if (error) {
        throw new ZimError(`${this.filePath}: cannot decompress cluster ${clusterIndex}: ${error.message}`, { cause: error });
      }
      return data; // incomplete: _validateOffsets reports it as corrupt
    }
  }

  async _decompress(comp, raw, clusterIndex) {
    switch (comp) {
      case COMP_ZSTD:
        return platform.zstd(raw);
      case COMP_ZLIB:
        return platform.inflate(raw);
      case COMP_XZ:
        // The computed cluster range can include unrelated trailing bytes (e.g. directory
        // entries after the last cluster), which libzim never looks at either.
        return xzDecompress(raw, { ignoreTrailing: true });
      case COMP_BZIP2:
        throw new ZimError(`${this.filePath}: cluster ${clusterIndex} uses bzip2 compression, which is not supported`);
      default:
        throw new ZimError(`${this.filePath}: cluster ${clusterIndex} has unknown compression type ${comp}`);
    }
  }

  /** Checks a decompressed offset table; returns the blob count. */
  _validateOffsets(data, extended, clusterIndex) {
    const offSize = extended ? 8 : 4;
    const corrupt = () => new ZimError(`${this.filePath}: cluster ${clusterIndex} has a corrupt offset table`);
    if (data.length < offSize) throw corrupt();
    const first = readOffset(data, 0, extended);
    if (first % offSize !== 0 || first < offSize || first > data.length) throw corrupt();
    const count = first / offSize;
    let prev = first;
    for (let i = 1; i < count; i++) {
      const off = readOffset(data, i * offSize, extended);
      if (off < prev || off > data.length) throw corrupt();
      prev = off;
    }
    return count - 1;
  }
}
