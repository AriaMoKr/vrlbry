// The shared core's platform in a browser (core/platform.js), made from the libraries the local
// library's worker loads (worker.js): fzstd for zstd, fflate for zlib and raw deflate, and
// htmlparser2's Parser. They are passed in, so Node tests build the very same platform from
// node_modules. Imports nothing.

const truncated = (cause) => Object.assign(new Error('unexpected end of compressed data', { cause }), { code: 'Z_BUF_ERROR' });

/**
 * The end of the first zstd frame in `bytes`, or -1 when `bytes` stops before it. A ZIM cluster's
 * byte range can run on past its frame (the last cluster is read with what follows it in the
 * file), and fzstd would read those bytes as another frame. Not a zstd frame: the whole length
 * (fzstd then says what is wrong).
 */
export function zstdFrameEnd(bytes) {
  const n = bytes.length;
  if (n < 5 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) return n;
  const fhd = bytes[4];
  const singleSegment = (fhd >> 5) & 1;
  const fcsFlag = fhd >> 6;
  let p = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [singleSegment, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > n) return -1;
    const h = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
    const type = (h >> 1) & 3;
    p += 3 + (type === 1 ? 1 : h >>> 3);
    if (p > n) return -1;
    if (h & 1) break; // the last block
  }
  if ((fhd >> 2) & 1) p += 4; // content checksum
  return p > n ? -1 : p;
}

/**
 * @param {{ zstdDecompress: (bytes: Uint8Array) => Uint8Array, unzlibSync: (bytes: Uint8Array) => Uint8Array,
 *   inflateSync: (bytes: Uint8Array) => Uint8Array, Parser: Function }} libs fzstd's decompress,
 *   fflate's unzlibSync and inflateSync, htmlparser2's Parser
 * @returns {object} for provide()
 */
export function browserPlatform({ zstdDecompress, unzlibSync, inflateSync, Parser }) {
  return {
    async zstd(bytes) {
      const end = zstdFrameEnd(bytes);
      if (end < 0) throw truncated();
      try {
        return zstdDecompress(bytes.subarray(0, end));
      } catch (err) {
        throw err.code === 5 ? truncated(err) : err; // fzstd's UnexpectedEOF
      }
    },
    async inflate(bytes) {
      try {
        return unzlibSync(bytes);
      } catch (err) {
        throw err.code === 0 ? truncated(err) : err; // fflate's UnexpectedEOF
      }
    },
    inflateRaw: (bytes) => inflateSync(bytes),
    Parser,
  };
}
