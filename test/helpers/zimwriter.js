/**
 * Synthetic ZIM writer for tests (test helper, not production code).
 *
 * Produces spec-conformant ZIM files (openZIM 5 / 6.x) with configurable version, namespace
 * scheme (it simply writes the namespaces you give it), cluster compression (none / zstd / zlib /
 * xz / raw pre-built clusters), extended (64-bit offset) clusters, redirects, main page and two
 * physical layouts:
 *  - 'libzim': header, MIME list, clusters, dirents, URL pointers, [title pointers], cluster
 *    pointers, MD5 checksum (what libzim 7+ writes: dirents follow the last cluster);
 *  - 'zimlib': header, MIME list, URL pointers, [title pointers], cluster pointers, dirents,
 *    clusters, checksum (older writers: the last cluster runs up to the checksum).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const COMPRESSION_CODES = { none: 1, zlib: 2, bzip2: 3, xz: 4, zstd: 5 };

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function sortKey(ns, url) {
  return Buffer.concat([Buffer.from([ns.charCodeAt(0)]), Buffer.from(url, 'utf8')]);
}

function splitPath(path) {
  if (path[1] !== '/') throw new Error(`zimwriter: bad path ${path}`);
  return [path[0], path.slice(2)];
}

/** xz variable-length integer. */
function xzVarint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

/**
 * Minimal valid .xz encoder that stores data in LZMA2 *uncompressed* chunks (no real
 * compression). Good enough to build xz clusters for reader tests without a JS LZMA encoder.
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function xzStore(data) {
  const crc = (b) => u32(zlib.crc32(b));
  const flags = Buffer.from([0x00, 0x01]); // CRC32 check
  const streamHeader = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), flags, crc(flags)]);
  // Block header: size byte, flags (1 filter, no sizes), LZMA2 filter (id 0x21, 1 prop byte), padding.
  const bh = Buffer.from([0x02, 0x00, 0x21, 0x01, 0x16, 0x00, 0x00, 0x00]);
  const blockHeader = Buffer.concat([bh, crc(bh)]);
  const chunks = [];
  for (let pos = 0, first = true; pos < data.length; first = false) {
    const n = Math.min(65536, data.length - pos);
    chunks.push(Buffer.from([first ? 0x01 : 0x02, (n - 1) >> 8, (n - 1) & 0xff]), data.subarray(pos, pos + n));
    pos += n;
  }
  chunks.push(Buffer.from([0x00]));
  const lzma2 = Buffer.concat(chunks);
  const pad = Buffer.alloc((4 - (lzma2.length % 4)) % 4);
  const check = crc(data);
  const unpadded = blockHeader.length + lzma2.length + check.length;
  let index = Buffer.concat([Buffer.from([0x00]), xzVarint(1), xzVarint(unpadded), xzVarint(data.length)]);
  index = Buffer.concat([index, Buffer.alloc((4 - (index.length % 4)) % 4)]);
  index = Buffer.concat([index, crc(index)]);
  const footerBody = Buffer.concat([u32(index.length / 4 - 1), flags]);
  const footer = Buffer.concat([crc(footerBody), footerBody, Buffer.from('YZ')]);
  return Buffer.concat([streamHeader, blockHeader, lzma2, pad, check, index, footer]);
}

/**
 * @typedef {object} WriterEntry
 * @property {string} ns
 * @property {string} url
 * @property {string} [title]
 * @property {string} [mime]               required for content entries
 * @property {string|Buffer} [content]
 * @property {string} [redirectTo]         target path, e.g. 'C/other'
 * @property {number} [redirectIndex]      raw redirect index (for corrupt-file tests)
 * @property {'none'|'zstd'|'zlib'|'xz'|'bzip2'} [compression]  overrides the default
 * @property {boolean} [extended]          overrides the default
 * @property {string} [cluster]            entries with the same name share a cluster
 * @property {number} [rawCluster]         index into opts.rawClusters (with `blob`)
 * @property {number} [blob]
 * @property {number} [special]            0xFFFE (linktarget) / 0xFFFD (deleted) entry
 */

/**
 * Writes a ZIM file.
 * @param {string} filePath
 * @param {object} opts
 * @param {WriterEntry[]} opts.entries
 * @param {'new'|'old'} [opts.scheme] namespace scheme: sets the default minor version (new: 1,
 *   old: 0) and checks the namespaces used (new: C/M/W/X only; old: no C). Without it, entries are
 *   written as given.
 * @param {number} [opts.major=6]
 * @param {number} [opts.minor] default 1 (0 with scheme 'old')
 * @param {'none'|'zstd'|'zlib'|'xz'|'bzip2'} [opts.compression='zstd'] default cluster compression
 * @param {boolean} [opts.extended=false] default: 64-bit blob offsets
 * @param {number} [opts.blobsPerCluster=4]
 * @param {string|null} [opts.mainPage] path of the main page entry
 * @param {string|null} [opts.layoutPage]
 * @param {'libzim'|'zimlib'} [opts.layout='libzim']
 * @param {boolean} [opts.titleIndex=true] write a (v0) title pointer list (libzim refuses files
 *   without any title index)
 * @param {boolean} [opts.checksum=true]
 * @param {Buffer} [opts.uuid]
 * @param {Array<{ compression: number, extended?: boolean, data: Buffer }>} [opts.rawClusters]
 *   pre-built cluster bodies (written verbatim after the info byte)
 * @param {(raw: Buffer) => Buffer} [opts.xzEncode=xzStore]
 * @returns {{ filePath: string, entries: Array<WriterEntry & { index: number, path: string }>,
 *   indexOf: (path: string) => number, mimeTypes: string[], clusterCount: number,
 *   clusterOf: (path: string) => number, size: number }}
 */
export function writeZim(filePath, opts) {
  const {
    scheme, major = 6, minor = scheme === 'old' ? 0 : 1, compression = 'zstd', extended = false, blobsPerCluster = 4,
    mainPage = null, layoutPage = null, layout = 'libzim', titleIndex = true, checksum = true,
    uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex'), rawClusters = [], xzEncode = xzStore,
  } = opts;

  if (scheme !== undefined) {
    const allowed = scheme === 'new' ? /^[CMWX]$/ : /^[^C]$/;
    for (const e of opts.entries) {
      if (!allowed.test(e.ns)) throw new Error(`zimwriter: namespace ${e.ns} not allowed in the ${scheme} scheme`);
    }
  }

  // --- sort entries byte-wise by (namespace, URL) ---
  const entries = opts.entries.map((e) => ({ ...e, path: `${e.ns}/${e.url}`, _key: sortKey(e.ns, e.url) }));
  entries.sort((a, b) => Buffer.compare(a._key, b._key));
  const indexByPath = new Map();
  entries.forEach((e, i) => {
    if (indexByPath.has(e.path)) throw new Error(`zimwriter: duplicate path ${e.path}`);
    e.index = i;
    indexByPath.set(e.path, i);
  });
  const indexOf = (path) => {
    const i = indexByPath.get(path);
    if (i === undefined) throw new Error(`zimwriter: unknown path ${path}`);
    return i;
  };

  // --- MIME list ---
  const mimeTypes = [...new Set(entries.filter((e) => e.mime && e.redirectTo === undefined &&
    e.redirectIndex === undefined && e.special === undefined).map((e) => e.mime))].sort();

  // --- clusters: generated ones first, then the raw ones ---
  const groups = new Map();
  const auto = new Map();
  for (const e of entries) {
    if (e.redirectTo !== undefined || e.redirectIndex !== undefined || e.special !== undefined || e.rawCluster !== undefined) continue;
    const comp = e.compression ?? compression;
    const ext = e.extended ?? extended;
    let name = e.cluster;
    if (name === undefined) {
      const base = `${comp}|${ext}`;
      const state = auto.get(base) ?? { n: 0, count: 0 };
      if (state.count >= blobsPerCluster) {
        state.n++;
        state.count = 0;
      }
      state.count++;
      auto.set(base, state);
      name = `auto:${base}:${state.n}`;
    }
    if (!groups.has(name)) groups.set(name, { comp, ext, blobs: [] });
    const g = groups.get(name);
    e._cluster = [...groups.keys()].indexOf(name);
    e._blob = g.blobs.length;
    g.blobs.push(Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8'));
  }
  const clusterBufs = [];
  for (const g of groups.values()) {
    const offSize = g.ext ? 8 : 4;
    const table = [];
    let off = offSize * (g.blobs.length + 1);
    for (const b of g.blobs) {
      table.push(g.ext ? u64(off) : u32(off));
      off += b.length;
    }
    table.push(g.ext ? u64(off) : u32(off));
    const body = Buffer.concat([...table, ...g.blobs]);
    let packed;
    if (g.comp === 'none') packed = body;
    else if (g.comp === 'zstd') packed = zlib.zstdCompressSync(body);
    else if (g.comp === 'zlib') packed = zlib.deflateSync(body);
    else if (g.comp === 'xz') packed = xzEncode(body);
    else if (g.comp === 'bzip2') packed = body; // not really bzip2: the reader must refuse it anyway
    else throw new Error(`zimwriter: unknown compression ${g.comp}`);
    clusterBufs.push(Buffer.concat([Buffer.from([COMPRESSION_CODES[g.comp] | (g.ext ? 0x10 : 0)]), packed]));
  }
  const firstRaw = clusterBufs.length;
  for (const rc of rawClusters) {
    clusterBufs.push(Buffer.concat([Buffer.from([rc.compression | (rc.extended ? 0x10 : 0)]), rc.data]));
  }
  for (const e of entries) {
    if (e.rawCluster !== undefined) {
      e._cluster = firstRaw + e.rawCluster;
      e._blob = e.blob;
    }
  }

  // --- directory entries ---
  const direntBufs = entries.map((e) => {
    const strings = Buffer.concat([Buffer.from(e.url, 'utf8'), Buffer.from([0]),
      Buffer.from(e.title ?? '', 'utf8'), Buffer.from([0])]);
    const ns = e.ns.charCodeAt(0);
    if (e.redirectTo !== undefined || e.redirectIndex !== undefined) {
      const target = e.redirectIndex ?? indexOf(e.redirectTo);
      return Buffer.concat([u16(0xffff), Buffer.from([0, ns]), u32(0), u32(target), strings]);
    }
    if (e.special !== undefined) return Buffer.concat([u16(e.special), Buffer.from([0, ns]), u32(0), strings]);
    const mimeIndex = mimeTypes.indexOf(e.mime);
    if (mimeIndex < 0) throw new Error(`zimwriter: entry ${e.path} needs a mime`);
    return Buffer.concat([u16(mimeIndex), Buffer.from([0, ns]), u32(0), u32(e._cluster), u32(e._blob), strings]);
  });

  const mimeList = Buffer.concat([...mimeTypes.map((m) => Buffer.from(`${m}\0`, 'utf8')), Buffer.from([0])]);
  const titleOrder = entries.map((e) => e.index).sort((a, b) => {
    const ea = entries[a];
    const eb = entries[b];
    return Buffer.compare(sortKey(ea.ns, ea.title || ea.url), sortKey(eb.ns, eb.title || eb.url));
  });

  // --- layout ---
  const parts = [];
  let pos = 80;
  const place = (buf) => {
    const at = pos;
    parts.push(buf);
    pos += buf.length;
    return at;
  };
  const mimeListPos = place(mimeList);
  const direntPos = new Array(entries.length);
  const clusterPos = new Array(clusterBufs.length);
  let urlPtrPos;
  let titlePtrPos = null;
  let clusterPtrPos;
  const ptrList = (arr) => Buffer.concat(arr.map((p) => u64(p)));
  if (layout === 'libzim') {
    clusterBufs.forEach((b, i) => { clusterPos[i] = place(b); });
    direntBufs.forEach((b, i) => { direntPos[i] = place(b); });
    urlPtrPos = place(ptrList(direntPos));
    if (titleIndex) titlePtrPos = place(Buffer.concat(titleOrder.map((i) => u32(i))));
    clusterPtrPos = place(ptrList(clusterPos));
  } else if (layout === 'zimlib') {
    // Pointer lists first: their contents are only known after placing what follows, so
    // reserve space and fill in afterwards.
    const urlPtrs = Buffer.alloc(entries.length * 8);
    const clusterPtrs = Buffer.alloc(clusterBufs.length * 8);
    urlPtrPos = place(urlPtrs);
    if (titleIndex) titlePtrPos = place(Buffer.concat(titleOrder.map((i) => u32(i))));
    clusterPtrPos = place(clusterPtrs);
    direntBufs.forEach((b, i) => { direntPos[i] = place(b); });
    clusterBufs.forEach((b, i) => { clusterPos[i] = place(b); });
    direntPos.forEach((p, i) => urlPtrs.writeBigUInt64LE(BigInt(p), i * 8));
    clusterPos.forEach((p, i) => clusterPtrs.writeBigUInt64LE(BigInt(p), i * 8));
  } else {
    throw new Error(`zimwriter: unknown layout ${layout}`);
  }
  const checksumPos = checksum ? pos : 0;

  const header = Buffer.concat([
    u32(0x044d495a), u16(major), u16(minor), uuid,
    u32(entries.length), u32(clusterBufs.length),
    u64(urlPtrPos), titlePtrPos === null ? Buffer.alloc(8, 0xff) : u64(titlePtrPos),
    u64(clusterPtrPos), u64(mimeListPos),
    u32(mainPage === null ? 0xffffffff : indexOf(mainPage)),
    u32(layoutPage === null ? 0xffffffff : indexOf(layoutPage)),
    u64(checksumPos),
  ]);
  let file = Buffer.concat([header, ...parts]);
  if (checksum) file = Buffer.concat([file, crypto.createHash('md5').update(file).digest()]);
  fs.writeFileSync(filePath, file);

  const clusterOfIndex = (i) => entries[i]._cluster ?? null;
  return {
    filePath,
    entries: entries.map(({ _key, _cluster, _blob, ...rest }) => rest),
    indexOf,
    mimeTypes,
    clusterCount: clusterBufs.length,
    clusterOf: (path) => clusterOfIndex(indexOf(path)),
    size: file.length,
  };
}
