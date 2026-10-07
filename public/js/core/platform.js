// What the shared core (public/js/core: ZIM reading, conversion, catalogues) needs from where it
// runs, filled in once with provide(): on Node by server/platform-node.js (zlib, crypto, files,
// htmlparser2, and Buffers, so the server keeps Buffer's speed and its callers get Buffers), in a
// browser by the local library's worker (public/js/local/). Core modules import nothing from
// node: and no bare specifiers: a module worker has no import map.
//
// The defaults below work anywhere (plain Uint8Array, TextDecoder); the codecs and the HTML
// parser have none, and using one that was not provided throws.

const decoder = new TextDecoder();
const latin1Decoder = new TextDecoder('latin1');
const encoder = new TextEncoder();

const missing = (name) => () => {
  throw new Error(`platform: ${name} was not provided (call provide() from server/platform-node.js or the browser worker)`);
};

export const platform = {
  /** n uninitialised bytes (every byte is written before it is read). */
  alloc: (n) => new Uint8Array(n),
  /** A copy of `bytes` (that does not pin a larger buffer). */
  copy: (bytes) => bytes.slice(),
  /** UTF-8 text of bytes[start, end). */
  utf8: (bytes, start = 0, end = bytes.length) => decoder.decode(bytes.subarray(start, end)),
  /** Latin-1 text of bytes[start, end) (one character per byte). */
  latin1: (bytes, start = 0, end = bytes.length) => latin1Decoder.decode(bytes.subarray(start, end)),
  /** Lower-case hex of bytes[start, end). */
  hex: (bytes, start = 0, end = bytes.length) => {
    let s = '';
    for (let i = start; i < end; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  },
  /** UTF-8 bytes of a string. */
  encodeUtf8: (text) => encoder.encode(text),
  /** Bytes of a base64 string. */
  base64: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
  /** Position of the byte sequence `needle` in `hay` from `from`, or -1. */
  indexOf: (hay, needle, from = 0) => {
    const n = needle.length;
    if (n === 0) return Math.min(from, hay.length);
    const first = needle[0];
    for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - n; i = hay.indexOf(first, i + 1)) {
      let k = 1;
      while (k < n && hay[i + k] === needle[k]) k++;
      if (k === n) return i;
    }
    return -1;
  },
  /** zstd-decompressed bytes; a truncated input rejects with code 'Z_BUF_ERROR'. */
  zstd: missing('zstd'),
  /** zlib-decompressed bytes (ZIM clusters of compression 2); truncated input: code 'Z_BUF_ERROR'. */
  inflate: missing('inflate'),
  /** Raw-deflate-decompressed bytes, synchronously (zip/EPUB entries). */
  inflateRaw: missing('inflateRaw'),
  /** CRC-32 (IEEE), or null: xz.js then uses its own table. */
  crc32: null,
  /** SHA-256 digest bytes, or null: xz's SHA-256 checks are then skipped. */
  sha256: null,
  /** htmlparser2's Parser class. */
  Parser: null,
  /** A byte source for a file path (Node only; ZimArchive.open with a string). */
  openFile: missing('openFile'),
};

/** Fills in what this environment provides (see `platform`). */
export function provide(impl) {
  Object.assign(platform, impl);
}
