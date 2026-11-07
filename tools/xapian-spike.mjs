// Spike (docs/SEARCH.md, option 4): look up words in a ZIM's Xapian Glass database from
// JavaScript, reading 8 KB blocks, with a format worked out from the bytes. Not used by the app.
//   node tools/xapian-spike.mjs <file.zim> X/title/xapian|X/fulltext/xapian <word> [word...]
// Format worked out from the bytes (Xapian's code was not read), checked by lookups whose paths
// hold the words:
//   blocks of 8192 bytes; block 0: "\x0f\x0dXapian Glass", then each table's root info (root
//     block as a varint, a level byte = level << 2, the entry count as a varint, 04 = 8192 >> 11,
//     …; read here by that pattern), then statistics (the document count, …).
//   block: u32 revision, u8 level (0: leaf), u16, u16 (free space), u16 directory end; then u16
//     item offsets, in key order. Branch item: u32 child block, u8 key length, key, u16 component.
//     Leaf item: u16 (flags << 13 | length of key and tag), u8 key length, key, [u16 component
//     when not the first], tag. Flags: 1 first component, 2 last, 4 deflate-compressed (raw).
//   tables in a ZIM: postlist (metadata "\0\xc0<name>", value statistics "\0\xd0", values
//     "\0\xd8", the terms), docdata, and in a title index positions.
//   postlist: key = the term for its first chunk, term + "\0" + docid key for the next ones; a
//     first chunk's tag starts with varint termfreq, varint collection freq, varint first docid
//     less one (the next chunks' first docid is in their key); then '1' (last chunk) or '0',
//     varint last docid - first, varint wdf, and (varint gap - 1, varint wdf) per document.
//   docid key: 2 bytes below 2^15, 0x80|… and 3 bytes below 2^22, 0xc0|… and 4 bytes (big-endian).
//   docdata: key = docid key; tag = the document's ZIM path ("C/Moby-Dick"), often compressed.
import fs from 'node:fs';
import zlib from 'node:zlib';

await import('../server/platform-node.js');
const { ZimArchive } = await import('../public/js/core/zim/reader.js');

const [file, xpath, ...words] = process.argv.slice(2);
const archive = await ZimArchive.open(file);
const entry = await archive.findPath(xpath);
const [start, end] = await archive._uncompressedBlobRange(await archive._getClusterInfo(entry.cluster), entry.blob);
const fd = fs.openSync(file, 'r');
const B = 8192;
const cache = new Map();
let reads = 0;
const block = (k) => {
  let b = cache.get(k);
  if (!b) {
    reads++;
    b = Buffer.alloc(B);
    fs.readSync(fd, b, 0, B, start + k * B);
    cache.set(k, b);
  }
  return b;
};

function varint(b, at) {
  let v = 0;
  let shift = 0;
  for (;;) {
    const x = b[at.i++];
    v += (x & 0x7f) * 2 ** shift;
    if (x < 0x80) return v;
    shift += 7;
  }
}

// Block 0: the magic, then the tables' root infos. The roots are the varints just before a
// 0x08/0x04-ish level byte; for the spike, take the three roots this file has by scanning for the
// pattern "<root varint> <level byte> <entries varint> 04" (block size 8192 >> 11).
function roots() {
  const b = block(0);
  if (b.toString('latin1', 0, 14) !== '\x0f\x0dXapian Glass') throw new Error('not a Glass database');
  const found = [];
  for (let i = 14; i < 200 && found.length < 6; i++) {
    const at = { i };
    const root = varint(b, at);
    const levelByte = b[at.i++];
    const entries = varint(b, at);
    if (b[at.i] === 4 && root > 0 && root < (end - start) / B && (levelByte >> 2) > 0 && (levelByte & 3) === 0 && entries > 0) {
      found.push({ root, level: levelByte >> 2, entries, at: i });
      i = at.i;
    }
  }
  return found;
}

function items(b) {
  const level = b[4];
  const dirEnd = b.readUInt16BE(9);
  const out = [];
  for (let d = 11; d < dirEnd; d += 2) {
    const o = b.readUInt16BE(d);
    if (level > 0) {
      const kl = b[o + 4];
      out.push({ key: b.subarray(o + 5, o + 5 + kl), child: b.readUInt32BE(o) });
    } else {
      const h = b.readUInt16BE(o);
      const kl = b[o + 2];
      const first = (h & 0x2000) !== 0;
      const compOff = o + 3 + kl;
      out.push({ key: b.subarray(o + 3, o + 3 + kl), first, last: (h & 0x4000) !== 0, compressed: (h & 0x8000) !== 0, tag: b.subarray(first ? compOff : compOff + 2, o + 3 + (h & 0x1fff)) });
    }
  }
  return { level, items: out };
}

/** The tag of `key` in the tree at `root` (its components joined), or null. */
function get(root, key) {
  let k = root;
  for (;;) {
    const { level, items: its } = items(block(k));
    let lo = 0;
    let hi = its.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Buffer.compare(its[mid].key, key) <= 0) lo = mid;
      else hi = mid - 1;
    }
    if (level > 0) { k = its[lo].child; continue; }
    if (!its[lo].key.equals(key)) return null;
    // A long tag continues in the next items (and the next leaf: not handled in the spike).
    const parts = [];
    for (let i = lo; i < its.length && its[i].key.equals(key); i++) {
      parts.push(its[i].tag);
      if (its[i].last) return its[lo].compressed ? zlib.inflateRawSync(Buffer.concat(parts)) : Buffer.concat(parts);
    }
    throw new Error('tag continues in the next block (not in the spike)');
  }
}

/** A document number as a sortable key: 2 bytes below 2^15 (top bit 0), 3 below 2^22 (10…), 4 (110…). */
function docKey(did) {
  if (did < 2 ** 15) return Buffer.from([did >> 8, did & 0xff]);
  if (did < 2 ** 22) return Buffer.from([0x80 | (did >> 16), (did >> 8) & 0xff, did & 0xff]);
  return Buffer.from([0xc0 | (did >>> 24), (did >> 16) & 0xff, (did >> 8) & 0xff, did & 0xff]);
}

function readDocKey(b) {
  if (b[0] < 0x80) return (b[0] << 8) | b[1];
  if (b[0] < 0xc0) return ((b[0] & 0x3f) << 16) | (b[1] << 8) | b[2];
  return ((b[0] & 0x1f) * 2 ** 24) + ((b[1] << 16) | (b[2] << 8) | b[3]);
}

/** A term's documents [{ did, wdf }], every chunk: the first by the term, the next by term + 0 + first docid. */
function postings(root, term, { firstPlus = 0 } = {}) {
  const tkey = Buffer.from(term, 'utf8');
  let tag = get(root, tkey);
  if (!tag) return { termfreq: 0, docs: [], chunks: 0 };
  const at = { i: 0 };
  const termfreq = varint(tag, at);
  const collfreq = varint(tag, at);
  let did = varint(tag, at) + firstPlus;
  const docs = [];
  let chunks = 0;
  for (;;) {
    chunks++;
    const lastChunk = tag[at.i++] === 0x31;
    const span = varint(tag, at);
    const first = did;
    docs.push({ did, wdf: varint(tag, at) });
    while (at.i < tag.length) {
      did += varint(tag, at) + 1;
      docs.push({ did, wdf: varint(tag, at) });
    }
    if (did - first !== span) throw new Error(`span mismatch for ${term} (chunk ${chunks})`);
    if (lastChunk) break;
    // The next chunk: the first key after term + 0 + (this chunk's last docid).
    const next = nextAfter(root, Buffer.concat([tkey, Buffer.from([0]), docKey(did)]));
    if (!next || !next.key.subarray(0, tkey.length + 1).equals(Buffer.concat([tkey, Buffer.from([0])]))) throw new Error(`chunk after ${did} missing for ${term}`);
    did = readDocKey(next.key.subarray(tkey.length + 1));
    tag = next.tag;
    at.i = 0;
  }
  if (docs.length !== termfreq) throw new Error(`${term}: ${docs.length} docs, termfreq ${termfreq}`);
  return { termfreq, collfreq, docs, chunks };
}

/** The first item (whole tag) with key > `key`. */
function nextAfter(root, key) {
  const stack = [];
  let k = root;
  for (;;) {
    const { level, items: its } = items(block(k));
    let lo = 0;
    let hi = its.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Buffer.compare(its[mid].key, key) <= 0) lo = mid;
      else hi = mid - 1;
    }
    stack.push({ k, its, i: lo });
    if (level > 0) { k = its[lo].child; continue; }
    // In the leaf: the item after lo (or the first, if every key is greater).
    let i = Buffer.compare(its[lo].key, key) <= 0 ? lo + 1 : lo;
    while (i < its.length && its[i].key.equals(its[lo].key) && Buffer.compare(its[lo].key, key) <= 0) i++;
    if (i < its.length) return wholeTag(its, i);
    // Up the stack to the next subtree.
    stack.pop();
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i + 1 < top.its.length) {
        top.i++;
        let c = top.its[top.i].child;
        for (;;) {
          const b = items(block(c));
          if (b.level === 0) return wholeTag(b.items, 0);
          c = b.items[0].child;
        }
      }
      stack.pop();
    }
    return null;
  }
}

function wholeTag(its, i) {
  const parts = [];
  for (let j = i; j < its.length && its[j].key.equals(its[i].key); j++) {
    parts.push(its[j].tag);
    if (its[j].last) return { key: its[i].key, tag: its[i].compressed ? zlib.inflateRawSync(Buffer.concat(parts)) : Buffer.concat(parts) };
  }
  throw new Error('tag continues in the next block (not in the spike)');
}

const t0 = performance.now();
const tables = roots();
console.log('roots in block 0:', JSON.stringify(tables));
const postlistRoot = tables[0].root;
const docdataRoot = tables[1].root;
// Is the first docid stored as is, or less one? The paths of a rare term say.
const firstPlus = process.env.FIRST_PLUS ? Number(process.env.FIRST_PLUS) : 1; // stored less one
const lists = words.map((w) => ({ w, ...postings(postlistRoot, w.toLowerCase(), { firstPlus }) }));
for (const l of lists) console.log(`"${l.w}": termfreq ${l.termfreq} (collection ${l.collfreq}), ${l.docs.length} docs in ${l.chunks} chunk(s)`);
let docs = lists[0].docs.map((d) => d.did);
for (const l of lists.slice(1)) {
  const have = new Set(l.docs.map((d) => d.did));
  docs = docs.filter((d) => have.has(d));
}
const afterTerms = reads;
const pick = process.env.TAIL ? docs.slice(-Number(process.env.TAIL)) : docs.slice(0, 12);
const paths = pick.map((did) => {
  const tag = get(docdataRoot, docKey(did));
  return `${did} ${tag ? tag.toString('utf8') : '?'}`;
});
console.log(`${docs.length} documents with every word; ${afterTerms} block reads for the terms, ${reads - afterTerms} for ${pick.length} paths; ${(performance.now() - t0).toFixed(1)} ms`);
for (const p of paths) console.log('  ', p);
