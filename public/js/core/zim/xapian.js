// @ts-check
// A ZIM's Xapian databases (experimental: docs/SEARCH.md, option 4). Kiwix's tools put a title
// index (X/title/xapian) and a full-text index (X/fulltext/xapian) in a ZIM: single-file Glass
// databases, each stored uncompressed, so any part of one is a positional read into the ZIM. This
// reads them in 8 KB blocks: term lookups, a ranked search (BM25) and each document's ZIM path.
// The format was worked out from the bytes of real ZIMs, not from Xapian's code (notes in
// docs/SEARCH.md and tools/xapian-spike.mjs).

import { platform } from '../platform.js';

const MAGIC = '\x0f\x0dXapian Glass';
const TABLES = ['postlist', 'docdata', 'termlist', 'position', 'spelling', 'synonym'];
const META = Uint8Array.of(0x00, 0xc0); // + name: the database's metadata
const DOCLEN = Uint8Array.of(0x00, 0xe0); // the documents' lengths, as a posting list
const HEAD = 11; // block header: u32 revision, u8 level, u16, u16, u16 directory end

/**
 * prefetch() reads the blocks it needs together when they lie within `runGap` blocks of each
 * other, up to `runBytes` a read: over HTTP each read waits ~0.1–0.5 s for its first byte, and a
 * table's leaves lie in key order; but the bytes between cost too (a mirror sends 0.1–2 MB/s).
 */
const RUN_GAP = 4;
const RUN_BYTES = 256 * 1024;

/** Xapian's BM25 defaults (k1, b, the least length relative to the average). */
const K1 = 1;
const B = 0.5;
const MIN_NORMLEN = 0.5;

export class XapianError extends Error {}

/** A varint (7 bits a byte, least significant first; the top bit says another follows). */
function varint(b, at) {
  let v = 0;
  let scale = 1;
  for (;;) {
    if (at.i >= b.length) throw new XapianError('truncated number');
    const x = b[at.i++];
    v += (x & 0x7f) * scale;
    if (x < 0x80) return v;
    scale *= 128;
  }
}

/** A document number as a key that sorts as numbers do: 2 bytes below 2^15, 3 below 2^22, else 4. */
export function docKey(did) {
  if (did < 0x8000) return Uint8Array.of(did >> 8, did & 0xff);
  if (did < 0x400000) return Uint8Array.of(0x80 | (did >> 16), (did >> 8) & 0xff, did & 0xff);
  return Uint8Array.of(0xc0 | (did >>> 24), (did >> 16) & 0xff, (did >> 8) & 0xff, did & 0xff);
}

function readDocKey(b, i = 0) {
  if (b[i] < 0x80) return (b[i] << 8) | b[i + 1];
  if (b[i] < 0xc0) return ((b[i] & 0x3f) << 16) | (b[i + 1] << 8) | b[i + 2];
  return (b[i] & 0x1f) * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Compares (key a, component ca) with (key b, component cb), bytes then component. */
function compare(a, ca, b, cb) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length || ca - cb;
}

const startsWith = (key, prefix) => key.length >= prefix.length && prefix.every((x, i) => key[i] === x);

/** One block's items, read in place: keys, components, children (branches) or tag bytes (leaves). */
class Block {
  constructor(n, bytes) {
    this.n = n;
    this.b = bytes;
    this.level = bytes[4];
    this.count = ((bytes[9] << 8 | bytes[10]) - HEAD) / 2;
  }

  _at(i) { return (this.b[HEAD + 2 * i] << 8) | this.b[HEAD + 2 * i + 1]; }

  key(i) {
    const o = this._at(i);
    return this.level > 0 ? this.b.subarray(o + 5, o + 5 + this.b[o + 4]) : this.b.subarray(o + 3, o + 3 + this.b[o + 2]);
  }

  /** The item's component number: 1 for a leaf item's first part. */
  comp(i) {
    const o = this._at(i);
    if (this.level > 0) {
      const k = o + 5 + this.b[o + 4];
      return (this.b[k] << 8) | this.b[k + 1];
    }
    if (this.b[o] & 0x20) return 1;
    const k = o + 3 + this.b[o + 2];
    return (this.b[k] << 8) | this.b[k + 1];
  }

  child(i) {
    const o = this._at(i);
    return ((this.b[o] << 24) >>> 0) + ((this.b[o + 1] << 16) | (this.b[o + 2] << 8) | this.b[o + 3]);
  }

  /** A leaf item: { last, compressed, tag } (the tag bytes of this component). */
  part(i) {
    const o = this._at(i);
    const h = (this.b[o] << 8) | this.b[o + 1];
    const first = (h & 0x2000) !== 0;
    const from = o + 3 + this.b[o + 2] + (first ? 0 : 2);
    return { last: (h & 0x4000) !== 0, compressed: (h & 0x8000) !== 0, tag: this.b.subarray(from, o + 3 + (h & 0x1fff)) };
  }

  /** The greatest i with (key(i), comp(i)) <= (key, comp); -1 when every item is greater. */
  find(key, comp) {
    let lo = -1;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (compare(this.key(mid), this.comp(mid), key, comp) <= 0) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * One of a ZIM's Xapian databases.
 * `XapianDb.inArchive(archive, 'X/fulltext/xapian', { stem })`, then `search(q)`.
 */
export class XapianDb {
  /**
   * @param {(position: number, length: number) => Promise<Uint8Array>} read the database's bytes
   *   (position 0: its start)
   * @param {number} size
   * @param {{ stem?: (word: string) => string, cacheBlocks?: number, runGap?: number, runBytes?: number }} [opts]
   *   stem: the language's stemmer for a full-text index, which holds stems only ("whales" is filed
   *   as "whale"); runGap, runBytes: how prefetch() joins reads (RUN_GAP)
   */
  static async open(read, size, opts = {}) {
    const db = new XapianDb(read, size, opts);
    await db._init();
    return db;
  }

  /**
   * The database at `path` in a ZIM ('X/fulltext/xapian', 'X/title/xapian'), or null when it has
   * none, or it is not stored as one uncompressed blob.
   * @param {import('./reader.js').ZimArchive} archive
   */
  static async inArchive(archive, path, opts) {
    const entry = await archive.findPath(path).catch(() => null);
    if (!entry || entry.isRedirect || entry.cluster === null) return null;
    const info = await archive._getClusterInfo(entry.cluster);
    if (info.compressed) return null;
    const [start, end] = await archive._uncompressedBlobRange(info, entry.blob);
    return XapianDb.open((pos, len) => archive._read(start + pos, len), end - start, opts);
  }

  constructor(read, size, { stem = null, cacheBlocks = 2048, runGap = RUN_GAP, runBytes = RUN_BYTES } = {}) {
    this._runGap = runGap;
    this._runBytes = runBytes;
    this._read = read;
    this.size = size;
    this._stem = stem;
    this._cacheBlocks = cacheBlocks;
    this._blocks = new Map(); // n -> Promise<Block>, least recently used first
    this._lengthHead = null; // the documents' lengths' list (a Promise of its head), from the first length()
    /** Blocks read so far, and the reads that fetched them (over HTTP, a request each). */
    this.reads = 0;
    this.requests = 0;
  }

  async _init() {
    const head = await this._read(0, Math.min(this.size, 1024));
    if (platform.utf8(head, 0, MAGIC.length) !== MAGIC) throw new XapianError('not a Xapian Glass database');
    const at = { i: MAGIC.length + 2 }; // + 2 bytes: the format's version
    this.uuid = [...head.subarray(at.i, at.i + 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
    at.i += 16;
    this.revision = varint(head, at);
    this.tables = {};
    for (const name of TABLES) {
      const root = varint(head, at);
      const flags = varint(head, at);
      const entries = varint(head, at);
      const blockSize = varint(head, at) * 2048;
      const compressMin = varint(head, at);
      const freeList = varint(head, at); // the free list's length, then the list
      at.i += freeList;
      this.tables[name] = { root, level: flags >> 2, empty: (flags & 1) !== 0, entries, blockSize, compressMin };
    }
    this.blockSize = this.tables.postlist.blockSize;
    if (this.blockSize < 2048 || this.size % this.blockSize) throw new XapianError(`unexpected block size ${this.blockSize}`);
    this.docCount = varint(head, at);
    varint(head, at); // the last document number, less the count
    this.lengthLower = varint(head, at);
    this.wdfUpper = varint(head, at);
    this.lengthUpper = varint(head, at);
    varint(head, at); // the oldest changeset
    this.totalLength = varint(head, at);
    this.averageLength = this.docCount ? this.totalLength / this.docCount : 1;
    this.kind = await this.metadata('kind'); // 'fulltext' or 'title' (libzim)
    this.language = await this.metadata('language');
  }

  /** Block `n`, cached (the most recently used kept). */
  _block(n) {
    let p = this._blocks.get(n);
    if (p) {
      this._blocks.delete(n);
      this._blocks.set(n, p);
      return p;
    }
    if (!(n > 0 && (n + 1) * this.blockSize <= this.size)) return Promise.reject(new XapianError(`block ${n} is outside the database`));
    this.reads++;
    this.requests++;
    p = this._read(n * this.blockSize, this.blockSize).then((bytes) => new Block(n, bytes));
    this._keep(n, p);
    return p;
  }

  _keep(n, p) {
    p.catch(() => this._blocks.delete(n));
    this._blocks.set(n, p);
    if (this._blocks.size > this._cacheBlocks) this._blocks.delete(this._blocks.keys().next().value);
  }

  /**
   * Blocks `ns`, those not cached read in runs: neighbours (RUN_GAP apart at most) with one read of
   * up to RUN_BYTES, the blocks between them kept too.
   */
  _blocksAt(ns) {
    const want = [...new Set(ns)].filter((n) => !this._blocks.has(n)).sort((a, b) => a - b);
    const most = Math.max(1, Math.floor(this._runBytes / this.blockSize));
    for (let i = 0; i < want.length;) {
      let j = i;
      while (j + 1 < want.length && want[j + 1] - want[j] <= this._runGap && want[j + 1] - want[i] < most) j++;
      const first = want[i];
      const count = want[j] - first + 1;
      if (count === 1) this._block(first);
      else {
        this.requests++;
        const run = this._read(first * this.blockSize, count * this.blockSize);
        for (let n = first; n < first + count; n++) {
          if (this._blocks.has(n)) continue;
          this.reads++;
          const off = (n - first) * this.blockSize;
          this._keep(n, run.then((bytes) => new Block(n, bytes.subarray(off, off + this.blockSize))));
        }
      }
      i = j + 1;
    }
    return Promise.all(ns.map((n) => this._block(n)));
  }

  /**
   * A cursor at the greatest item <= (key, comp) of a table: { path: [{ block, i }] } (root to
   * leaf), i = -1 before the first item.
   */
  async _seek(table, key, comp = 1) {
    const path = [];
    let block = await this._block(this.tables[table].root);
    for (;;) {
      const i = block.find(key, comp);
      path.push({ block, i });
      if (block.level === 0) return path;
      block = await this._block(block.child(Math.max(0, i)));
    }
  }

  /** Moves a cursor to the next leaf item; false at the table's end. */
  async _next(path) {
    const leaf = path[path.length - 1];
    if (leaf.i + 1 < leaf.block.count) {
      leaf.i++;
      return true;
    }
    let d = path.length - 2;
    while (d >= 0 && path[d].i + 1 >= path[d].block.count) d--;
    if (d < 0) return false;
    path[d].i++;
    for (let k = d + 1; k < path.length; k++) {
      path[k] = { block: await this._block(path[k - 1].block.child(path[k - 1].i)), i: 0 };
    }
    return true;
  }

  /** The whole tag of the item at a cursor (a first component), following its parts; inflated. */
  async _tag(path) {
    const leaf = path[path.length - 1];
    const key = leaf.block.key(leaf.i);
    const first = leaf.block.part(leaf.i);
    if (first.last) return first.compressed ? platform.inflateRaw(first.tag) : first.tag;
    const parts = [first.tag];
    for (;;) {
      if (!(await this._next(path))) throw new XapianError('a value ends past the table');
      const l = path[path.length - 1];
      if (compare(l.block.key(l.i), 0, key, 0) !== 0) throw new XapianError('a value is missing its last part');
      const part = l.block.part(l.i);
      parts.push(part.tag);
      if (part.last) break;
    }
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    n = 0;
    for (const p of parts) { out.set(p, n); n += p.length; }
    return first.compressed ? platform.inflateRaw(out) : out;
  }

  /**
   * Reads at once the blocks that finding these keys will read (each level of the tree in one
   * batch), so that the lookups after it read nothing: over HTTP a block is a round trip, and a
   * search's lookups one after another took 80 ms each. `range: [from, to]` also reads every leaf
   * whose keys may lie between from and to.
   * @param {string} table
   * @param {Uint8Array[]} keys
   */
  async prefetch(table, keys, { range = null } = {}) {
    let nodes = new Set([this.tables[table].root]);
    for (;;) {
      const blocks = await this._blocksAt([...nodes]);
      if (!blocks.length || blocks[0].level === 0) return;
      nodes = new Set();
      for (const b of blocks) {
        for (const key of keys) nodes.add(b.child(Math.max(0, b.find(key, 1))));
        if (range) {
          const from = Math.max(0, b.find(range[0], 1));
          const to = Math.max(0, b.find(range[1], 1));
          for (let i = from; i <= to; i++) nodes.add(b.child(i));
        }
      }
    }
  }

  /** The tag of `key` in a table, or null. */
  async get(table, key) {
    const path = await this._seek(table, key, 1);
    const leaf = path[path.length - 1];
    if (leaf.i < 0 || compare(leaf.block.key(leaf.i), 1, key, 1) !== 0 || leaf.block.comp(leaf.i) !== 1) return null;
    return this._tag(path);
  }

  /** A metadata value of the database ('kind', 'language', 'valuesmap', …), or null. */
  async metadata(name) {
    const tag = await this.get('postlist', concat(META, platform.encodeUtf8(name)));
    return tag ? platform.utf8(tag) : null;
  }

  /** A document's data: its ZIM path ('C/Moby-Dick'), or null. */
  async path(did) {
    const tag = await this.get('docdata', docKey(did));
    return tag ? platform.utf8(tag) : null;
  }

  /** The terms a query looks for here: its words, lower case, stemmed in a full-text index. */
  terms(q) {
    const words = String(q ?? '').toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    const out = words.map((w) => w.replace(/’/g, "'")).map((w) => (this.kind === 'fulltext' && this._stem ? this._stem(w) : w));
    return [...new Set(out)];
  }

  /** A term's posting list (a cursor over its documents in order), or null when no document has it. */
  async postings(term) {
    const head = await this._listHead(platform.encodeUtf8(term), true);
    return head ? new Postings(this, head) : null;
  }

  /**
   * A posting list's first chunk and what finds the others: `key` (the first chunk's), `prefix`
   * (the next chunks' keys are the prefix and their first document's docKey), termfreq,
   * collfreq, and the first chunk decoded. Null when there is none.
   */
  async _listHead(key, separated) {
    const tag = await this.get('postlist', key);
    if (!tag) return null;
    const at = { i: 0 };
    const termfreq = varint(tag, at);
    const collfreq = varint(tag, at);
    const first = decodeChunk(tag, at, varint(tag, at) + 1); // stored less one
    return { key, prefix: separated ? concat(key, Uint8Array.of(0)) : key, termfreq, collfreq, first: { ...first, key } };
  }

  /**
   * The chunk of a list that holds `did` if any does: the one whose first document is the greatest
   * <= did (the list's first chunk when did comes before the others).
   */
  async _chunkAt(head, did) {
    let path = await this._seek('postlist', concat(head.prefix, docKey(did)), 1);
    let leaf = path[path.length - 1];
    if (leaf.i < 0) return head.first;
    let key = leaf.block.key(leaf.i);
    if (!(startsWith(key, head.prefix) && key.length > head.prefix.length)) return head.first;
    if (leaf.block.comp(leaf.i) !== 1) { // a later part of that chunk's value: back to its first
      path = await this._seek('postlist', key, 1);
      leaf = path[path.length - 1];
      key = leaf.block.key(leaf.i);
    }
    return { ...decodeChunk(await this._tag(path), { i: 0 }, readDocKey(key, head.prefix.length)), key };
  }

  /** The chunk after `chunk` in its list, or null at the list's end. */
  async _chunkAfter(head, chunk) {
    if (chunk.last) return null;
    const path = await this._seek('postlist', chunk.key, 1);
    for (;;) {
      if (!(await this._next(path))) return null;
      const leaf = path[path.length - 1];
      const key = leaf.block.key(leaf.i);
      if (compare(key, 0, chunk.key, 0) === 0) continue; // the same chunk's later parts
      if (!(startsWith(key, head.prefix) && key.length > head.prefix.length)) return null;
      return { ...decodeChunk(await this._tag(path), { i: 0 }, readDocKey(key, head.prefix.length)), key };
    }
  }

  /** A document's length (its number of words); the average when it is not listed. */
  async length(did) {
    this._lengthHead ??= this._listHead(DOCLEN, false);
    const head = await this._lengthHead;
    if (!head) return this.averageLength;
    const chunk = await this._chunkAt(head, did);
    const k = indexOf(chunk.dids, did);
    return chunk.dids[k] === did ? chunk.wdfs[k] : this.averageLength;
  }

  /**
   * Documents holding every term of `q`, the best first (Xapian's BM25 with its defaults): scored
   * first without their lengths, then the best `rerank` again with them (a length costs a read
   * where the documents are far apart). The rarest term's documents are the candidates, at most
   * `maxCandidates` of them (in document order: `truncated` says so).
   * @returns {Promise<{ terms: Array<{ term: string, freq: number }>, total: number, truncated: boolean,
   *   results: Array<{ did: number, score: number, length: number, path: string|null }> }>}
   */
  async search(q, { limit = 10, rerank = 50, maxCandidates = 20000 } = {}) {
    const terms = this.terms(q);
    const lists = await Promise.all(terms.map((t) => this.postings(t)));
    const info = terms.map((term, i) => ({ term, freq: lists[i]?.termfreq ?? 0 }));
    if (!terms.length || lists.some((l) => !l)) return { terms: info, total: 0, truncated: false, results: [] };
    const N = this.docCount;
    const idf = lists.map((l) => Math.max(0.1, Math.log((N - l.termfreq + 0.5) / (l.termfreq + 0.5))));
    const order = lists.map((_, i) => i).sort((a, b) => lists[a].termfreq - lists[b].termfreq);
    const [lead, ...rest] = order;
    // The rarest term's documents are the candidates: its chunks read in one batch, then the
    // chunks of the other terms that would hold them in another.
    const leadHead = lists[lead]._head;
    if (!leadHead.first.last) {
      await this.prefetch('postlist', [], { range: [leadHead.prefix, concat(leadHead.prefix, Uint8Array.of(0xff))] });
    }
    const candidates = [];
    const leadWdfs = [];
    let truncated = false;
    for (let ok = true; ok; ok = await lists[lead].next()) {
      if (candidates.length >= maxCandidates) { truncated = true; break; }
      candidates.push(lists[lead].did);
      leadWdfs.push(lists[lead].wdf);
    }
    await Promise.all(rest.filter((j) => !lists[j]._head.first.last).map((j) => {
      const prefix = lists[j]._head.prefix;
      return this.prefetch('postlist', candidates.map((d) => concat(prefix, docKey(d))));
    }));
    const scored = [];
    let total = 0;
    const wdfs = new Array(lists.length);
    for (let c = 0; c < candidates.length; c++) {
      const did = candidates[c];
      wdfs[lead] = leadWdfs[c];
      let all = true;
      for (const j of rest) {
        if (!(await lists[j].skipTo(did)) || lists[j].did !== did) { all = false; break; }
        wdfs[j] = lists[j].wdf;
      }
      if (!all) continue;
      total++;
      let s = 0;
      for (let j = 0; j < lists.length; j++) s += idf[j] * ((K1 + 1) * wdfs[j]) / (K1 + wdfs[j]);
      scored.push({ did, s, wdfs: wdfs.slice() });
    }
    scored.sort((a, b) => b.s - a.s || a.did - b.did);
    const top = scored.slice(0, Math.max(limit, rerank));
    await this.prefetch('postlist', top.map((d) => concat(DOCLEN, docKey(d.did))));
    const lengths = await Promise.all(top.map((d) => this.length(d.did)));
    const results = top.map((d, k) => {
      const norm = Math.max(MIN_NORMLEN, lengths[k] / this.averageLength);
      let score = 0;
      for (let j = 0; j < lists.length; j++) score += idf[j] * ((K1 + 1) * d.wdfs[j]) / (K1 * ((1 - B) + B * norm) + d.wdfs[j]);
      return { did: d.did, score, length: lengths[k] };
    }).sort((a, b) => b.score - a.score || a.did - b.did).slice(0, limit);
    await this.prefetch('docdata', results.map((r) => docKey(r.did)));
    const paths = await Promise.all(results.map((r) => this.path(r.did)));
    return { terms: info, total, truncated, results: results.map((r, k) => ({ ...r, path: paths[k] })) };
  }
}

/**
 * A chunk of a posting list from `at`: '1' if it is the list's last, the last document less the
 * first, the first's wdf, then for each next document its distance less one and its wdf.
 * @returns {{ dids: number[], wdfs: number[], last: boolean }}
 */
function decodeChunk(tag, at, first) {
  const last = tag[at.i++] === 0x31;
  const span = varint(tag, at);
  const dids = [first];
  const wdfs = [varint(tag, at)];
  let did = first;
  while (at.i < tag.length) {
    did += varint(tag, at) + 1;
    dids.push(did);
    wdfs.push(varint(tag, at));
  }
  if (did - first !== span) throw new XapianError('a posting list chunk does not add up');
  return { dids, wdfs, last };
}

/** The first index whose document is >= did (dids.length when none is). */
function indexOf(dids, did) {
  let lo = 0;
  let hi = dids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dids[mid] < did) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A cursor over a posting list's documents, in order, with each one's wdf (`did`, `wdf`). */
class Postings {
  constructor(db, head) {
    this._db = db;
    this._head = head;
    this.termfreq = head.termfreq;
    this.collfreq = head.collfreq;
    this._at(head.first, 0);
  }

  _at(chunk, k) {
    this._chunk = chunk;
    this._k = k;
    this.did = chunk.dids[k];
    this.wdf = chunk.wdfs[k];
  }

  /** The next document; false at the list's end. */
  async next() {
    if (this._k + 1 < this._chunk.dids.length) {
      this._at(this._chunk, this._k + 1);
      return true;
    }
    const chunk = await this._db._chunkAfter(this._head, this._chunk);
    if (!chunk) return false;
    this._at(chunk, 0);
    return true;
  }

  /** Moves on to the first document >= did; false when there is none. */
  async skipTo(did) {
    if (did <= this.did) return true;
    let chunk = this._chunk;
    if (did > chunk.dids[chunk.dids.length - 1]) {
      if (chunk.last) return false;
      chunk = await this._db._chunkAt(this._head, did);
      if (did > chunk.dids[chunk.dids.length - 1]) {
        chunk = await this._db._chunkAfter(this._head, chunk);
        if (!chunk) return false;
      }
    }
    this._at(chunk, indexOf(chunk.dids, did));
    return true;
  }
}
