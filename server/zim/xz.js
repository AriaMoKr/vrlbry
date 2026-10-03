/**
 * Pure-JS .xz decoder (LZMA2 filter only) — §3.2.
 *
 * Supports the complete container as written by xz / liblzma / libzim: stream header and footer,
 * any number of blocks, concatenated streams with stream padding, optional compressed /
 * uncompressed sizes in block headers, index validation, and the check types none, CRC32, CRC64
 * and SHA-256 (all verified; unknown check types are skipped like liblzma does).
 *
 * The whole input is in memory and the whole output is produced into one buffer, so the output
 * buffer doubles as the LZMA dictionary: no sliding window copy is needed. The block's LZMA2 chunk
 * headers carry exact sizes, so the output is sized exactly before decoding the block.
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const HEADER_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC_0 = 0x59; // 'Y'
const FOOTER_MAGIC_1 = 0x5a; // 'Z'
const FILTER_LZMA2 = 0x21;

/** Check field size in bytes per check type (xz file format §3.1.3). */
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];
const CHECK_CRC32 = 0x01;
const CHECK_CRC64 = 0x04;
const CHECK_SHA256 = 0x0a;

// ---------------------------------------------------------------------------------------------
// Checksums

let crc32Table = null;
/** CRC-32 (IEEE). Uses the native zlib.crc32 (Node >= 22.2) and falls back to a table. */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crc32Table) {
    crc32Table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

let crc64Lo = null;
let crc64Hi = null;
/**
 * CRC-64/XZ (ECMA-182 polynomial, reflected). JS has no fast 64-bit integers, so the table and
 * the register are kept as two 32-bit halves.
 * @returns {[number, number]} [low32, high32] of the final CRC
 */
function crc64(buf) {
  if (!crc64Lo) {
    crc64Lo = new Int32Array(256);
    crc64Hi = new Int32Array(256);
    const polyLo = 0xd7870f42 | 0;
    const polyHi = 0xc96c5795 | 0;
    for (let n = 0; n < 256; n++) {
      let lo = n;
      let hi = 0;
      for (let k = 0; k < 8; k++) {
        const odd = lo & 1;
        lo = (lo >>> 1) | (hi << 31);
        hi >>>= 1;
        if (odd) {
          lo ^= polyLo;
          hi ^= polyHi;
        }
      }
      crc64Lo[n] = lo;
      crc64Hi[n] = hi;
    }
  }
  const tLo = crc64Lo;
  const tHi = crc64Hi;
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < buf.length; i++) {
    const idx = (lo ^ buf[i]) & 0xff;
    lo = ((lo >>> 8) | (hi << 24)) ^ tLo[idx];
    hi = (hi >>> 8) ^ tHi[idx];
  }
  return [(lo ^ -1) >>> 0, (hi ^ -1) >>> 0];
}

function readU32LE(buf, pos) {
  return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
}

/**
 * Throws an Error with a machine-readable `code`: ERR_XZ_TRUNCATED (input ends early — more input
 * might help), ERR_XZ_UNSUPPORTED (valid but unsupported feature) or ERR_XZ_CORRUPT.
 */
function fail(msg) {
  const err = new Error(`xz: ${msg}`);
  err.code = msg.startsWith('unexpected end of input') ? 'ERR_XZ_TRUNCATED' :
    msg.startsWith('unsupported') ? 'ERR_XZ_UNSUPPORTED' : 'ERR_XZ_CORRUPT';
  throw err;
}

/** Verifies the block check field against the block's uncompressed data. */
function verifyCheck(checkType, data, input, pos) {
  if (checkType === CHECK_CRC32) {
    if (crc32(data) !== readU32LE(input, pos)) fail('CRC32 check failed (corrupt data)');
  } else if (checkType === CHECK_CRC64) {
    const [lo, hi] = crc64(data);
    if (lo !== readU32LE(input, pos) || hi !== readU32LE(input, pos + 4)) {
      fail('CRC64 check failed (corrupt data)');
    }
  } else if (checkType === CHECK_SHA256) {
    const digest = createHash('sha256').update(data).digest();
    for (let i = 0; i < 32; i++) {
      if (digest[i] !== input[pos + i]) fail('SHA-256 check failed (corrupt data)');
    }
  }
  // None (0x00) and reserved/unknown types: nothing to verify (liblzma skips unknown checks too).
}

// ---------------------------------------------------------------------------------------------
// LZMA decoder

// Offsets into one shared Uint16Array of probabilities (same layout idea as 7-zip's LzmaDec).
const NUM_STATES = 12;
const POS_STATES_MAX = 16;
const IS_MATCH = 0;
const IS_REP = IS_MATCH + NUM_STATES * POS_STATES_MAX;
const IS_REP_G0 = IS_REP + NUM_STATES;
const IS_REP_G1 = IS_REP_G0 + NUM_STATES;
const IS_REP_G2 = IS_REP_G1 + NUM_STATES;
const IS_REP0_LONG = IS_REP_G2 + NUM_STATES;
const POS_SLOT = IS_REP0_LONG + NUM_STATES * POS_STATES_MAX;
const SPEC_POS = POS_SLOT + 4 * 64;
const ALIGN = SPEC_POS + 114;
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + POS_STATES_MAX * 8;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * 8;
const LEN_CODER_SIZE = LEN_HIGH + 256;
const LEN_CODER = ALIGN + 16;
const REP_LEN_CODER = LEN_CODER + LEN_CODER_SIZE;
const LITERAL = REP_LEN_CODER + LEN_CODER_SIZE;
const PROBS_SIZE = LITERAL + (0x300 << 4); // lc + lp <= 4 in LZMA2

const PROB_INIT = 1024;

/** LZMA state that persists across the LZMA2 chunks of one block. */
class LzmaState {
  constructor() {
    this.probs = new Uint16Array(PROBS_SIZE);
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }

  /** Sets lc/lp/pb from the LZMA2 properties byte; returns false if invalid. */
  setProps(byte) {
    if (byte > (4 * 5 + 4) * 9 + 8) return false;
    const lc = byte % 9;
    const rest = (byte / 9) | 0;
    const lp = rest % 5;
    const pb = (rest / 5) | 0;
    if (lc + lp > 4) return false;
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    return true;
  }

  reset() {
    this.probs.fill(PROB_INIT, 0, LITERAL + (0x300 << (this.lc + this.lp)));
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }
}

/**
 * Decodes one LZMA2 "LZMA chunk": a fresh range-coder stream of exactly ipEnd - ip bytes that
 * produces exactly opEnd - op bytes into `out`. Bytes since `dictStart` form the dictionary.
 *
 * Everything hot is kept in local variables and the range-coder bit decode is written out inline
 * at every site: calling a helper (or a closure over the coder state) costs 2-3x in V8.
 *
 * `range`, `code` and `bound` are conceptually uint32 but are held as int32 (`| 0`), which keeps
 * V8 on small-integer fast paths (uint32 values >= 2^31 become heap numbers before the function
 * is optimized, which halves cold-start speed). Unsigned comparisons are done by flipping the sign
 * bit: `(a ^ -2147483648) < (b ^ -2147483648)` is `a < b` as uint32. `(range >>> 24) === 0` is the
 * usual "range < 2^24" normalization test.
 * Termination is guaranteed: every loop iteration writes >= 1 byte and op is bounded by opEnd.
 */
function decodeLzmaChunk(st, inp, ip, ipEnd, out, op, opEnd, dictStart) {
  if (ipEnd - ip < 5 || inp[ip] !== 0) fail('corrupt LZMA2 chunk (bad range coder init)');
  let code = (inp[ip + 1] << 24) | (inp[ip + 2] << 16) | (inp[ip + 3] << 8) | inp[ip + 4];
  let range = -1; // 0xFFFFFFFF
  ip += 5;

  const probs = st.probs;
  const lc = st.lc;
  const lcShift = 8 - lc;
  const lpMask = (1 << st.lp) - 1;
  const pbMask = (1 << st.pb) - 1;
  let state = st.state;
  let rep0 = st.rep0;
  let rep1 = st.rep1;
  let rep2 = st.rep2;
  let rep3 = st.rep3;
  let bound = 0;
  let p = 0;
  let pi = 0;

  while (op < opEnd) {
    const posState = (op - dictStart) & pbMask;

    // --- isMatch ---
    pi = IS_MATCH + (state << 4) + posState;
    if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
    p = probs[pi];
    bound = Math.imul(range >>> 11, p);
    if ((code ^ -2147483648) < (bound ^ -2147483648)) {
      range = bound;
      probs[pi] = p + ((2048 - p) >>> 5);

      // --- literal ---
      const pos = op - dictStart;
      const prevByte = pos > 0 ? out[op - 1] : 0;
      const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prevByte >>> lcShift));
      let symbol = 1;
      if (state < 7) {
        do {
          pi = base + symbol;
          if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
          p = probs[pi];
          bound = Math.imul(range >>> 11, p);
          if ((code ^ -2147483648) < (bound ^ -2147483648)) {
            range = bound;
            probs[pi] = p + ((2048 - p) >>> 5);
            symbol <<= 1;
          } else {
            range = (range - bound) | 0;
            code = (code - bound) | 0;
            probs[pi] = p - (p >>> 5);
            symbol = (symbol << 1) | 1;
          }
        } while (symbol < 0x100);
      } else {
        // "Matched" literal: the byte at distance rep0 steers the probabilities until the first
        // mismatching bit.
        let matchByte = out[op - rep0 - 1] << 1;
        let offset = 0x100;
        do {
          const matchBit = matchByte & offset;
          matchByte <<= 1;
          pi = base + offset + matchBit + symbol;
          if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
          p = probs[pi];
          bound = Math.imul(range >>> 11, p);
          if ((code ^ -2147483648) < (bound ^ -2147483648)) {
            range = bound;
            probs[pi] = p + ((2048 - p) >>> 5);
            symbol <<= 1;
            offset &= ~matchBit;
          } else {
            range = (range - bound) | 0;
            code = (code - bound) | 0;
            probs[pi] = p - (p >>> 5);
            symbol = (symbol << 1) | 1;
            offset = matchBit;
          }
        } while (symbol < 0x100);
      }
      out[op++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    range = (range - bound) | 0;
    code = (code - bound) | 0;
    probs[pi] = p - (p >>> 5);

    // --- isRep ---
    let lenBase;
    let isMatch;
    pi = IS_REP + state;
    if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
    p = probs[pi];
    bound = Math.imul(range >>> 11, p);
    if ((code ^ -2147483648) < (bound ^ -2147483648)) {
      range = bound;
      probs[pi] = p + ((2048 - p) >>> 5);
      // Plain match: the distance is decoded after the length.
      isMatch = true;
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      state = state < 7 ? 7 : 10;
      lenBase = LEN_CODER;
    } else {
      range = (range - bound) | 0;
      code = (code - bound) | 0;
      probs[pi] = p - (p >>> 5);
      isMatch = false;

      // --- isRepG0 ---
      pi = IS_REP_G0 + state;
      if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
      p = probs[pi];
      bound = Math.imul(range >>> 11, p);
      if ((code ^ -2147483648) < (bound ^ -2147483648)) {
        range = bound;
        probs[pi] = p + ((2048 - p) >>> 5);

        // --- isRep0Long ---
        pi = IS_REP0_LONG + (state << 4) + posState;
        if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
        p = probs[pi];
        bound = Math.imul(range >>> 11, p);
        if ((code ^ -2147483648) < (bound ^ -2147483648)) {
          range = bound;
          probs[pi] = p + ((2048 - p) >>> 5);
          // Short rep: one byte from distance rep0.
          if (rep0 >= op - dictStart) fail('corrupt data (distance beyond dictionary)');
          out[op] = out[op - rep0 - 1];
          op++;
          state = state < 7 ? 9 : 11;
          continue;
        }
        range = (range - bound) | 0;
        code = (code - bound) | 0;
        probs[pi] = p - (p >>> 5);
      } else {
        range = (range - bound) | 0;
        code = (code - bound) | 0;
        probs[pi] = p - (p >>> 5);
        let dist;

        // --- isRepG1 ---
        pi = IS_REP_G1 + state;
        if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
        p = probs[pi];
        bound = Math.imul(range >>> 11, p);
        if ((code ^ -2147483648) < (bound ^ -2147483648)) {
          range = bound;
          probs[pi] = p + ((2048 - p) >>> 5);
          dist = rep1;
        } else {
          range = (range - bound) | 0;
          code = (code - bound) | 0;
          probs[pi] = p - (p >>> 5);

          // --- isRepG2 ---
          pi = IS_REP_G2 + state;
          if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
          p = probs[pi];
          bound = Math.imul(range >>> 11, p);
          if ((code ^ -2147483648) < (bound ^ -2147483648)) {
            range = bound;
            probs[pi] = p + ((2048 - p) >>> 5);
            dist = rep2;
          } else {
            range = (range - bound) | 0;
            code = (code - bound) | 0;
            probs[pi] = p - (p >>> 5);
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      state = state < 7 ? 8 : 11;
      lenBase = REP_LEN_CODER;
    }

    // --- length ---
    let treeBase;
    let treeLimit;
    let len;
    pi = lenBase + LEN_CHOICE;
    if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
    p = probs[pi];
    bound = Math.imul(range >>> 11, p);
    if ((code ^ -2147483648) < (bound ^ -2147483648)) {
      range = bound;
      probs[pi] = p + ((2048 - p) >>> 5);
      treeBase = lenBase + LEN_LOW + (posState << 3);
      treeLimit = 8;
      len = 0;
    } else {
      range = (range - bound) | 0;
      code = (code - bound) | 0;
      probs[pi] = p - (p >>> 5);
      pi = lenBase + LEN_CHOICE2;
      if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
      p = probs[pi];
      bound = Math.imul(range >>> 11, p);
      if ((code ^ -2147483648) < (bound ^ -2147483648)) {
        range = bound;
        probs[pi] = p + ((2048 - p) >>> 5);
        treeBase = lenBase + LEN_MID + (posState << 3);
        treeLimit = 8;
        len = 8;
      } else {
        range = (range - bound) | 0;
        code = (code - bound) | 0;
        probs[pi] = p - (p >>> 5);
        treeBase = lenBase + LEN_HIGH;
        treeLimit = 256;
        len = 16;
      }
    }
    let sym = 1;
    do {
      pi = treeBase + sym;
      if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
      p = probs[pi];
      bound = Math.imul(range >>> 11, p);
      if ((code ^ -2147483648) < (bound ^ -2147483648)) {
        range = bound;
        probs[pi] = p + ((2048 - p) >>> 5);
        sym <<= 1;
      } else {
        range = (range - bound) | 0;
        code = (code - bound) | 0;
        probs[pi] = p - (p >>> 5);
        sym = (sym << 1) | 1;
      }
    } while (sym < treeLimit);
    len += sym - treeLimit; // 0-based; the real match length is len + 2

    // --- distance (plain matches only) ---
    if (isMatch) {
      treeBase = POS_SLOT + ((len < 4 ? len : 3) << 6);
      sym = 1;
      do {
        pi = treeBase + sym;
        if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
        p = probs[pi];
        bound = Math.imul(range >>> 11, p);
        if ((code ^ -2147483648) < (bound ^ -2147483648)) {
          range = bound;
          probs[pi] = p + ((2048 - p) >>> 5);
          sym <<= 1;
        } else {
          range = (range - bound) | 0;
          code = (code - bound) | 0;
          probs[pi] = p - (p >>> 5);
          sym = (sym << 1) | 1;
        }
      } while (sym < 64);
      const posSlot = sym - 64;
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const numDirect = (posSlot >>> 1) - 1;
        // Up to 3 << 30: must stay unsigned.
        let dist = ((2 | (posSlot & 1)) << numDirect) >>> 0;
        let revBits;
        if (posSlot < 14) {
          // Reverse bit tree over the "special" distance probabilities.
          treeBase = SPEC_POS + dist - posSlot - 1;
          revBits = numDirect;
        } else {
          // Direct (fixed probability) bits, then 4 reverse-coded align bits.
          let direct = 0;
          for (let n = numDirect - 4; n > 0; n--) {
            if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
            range >>>= 1;
            if ((code ^ -2147483648) >= (range ^ -2147483648)) {
              code = (code - range) | 0;
              direct = (direct << 1) | 1;
            } else {
              direct <<= 1;
            }
          }
          dist = (dist + (direct << 4)) >>> 0;
          treeBase = ALIGN;
          revBits = 4;
        }
        sym = 1;
        for (let i = 0; i < revBits; i++) {
          pi = treeBase + sym;
          if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
          p = probs[pi];
          bound = Math.imul(range >>> 11, p);
          if ((code ^ -2147483648) < (bound ^ -2147483648)) {
            range = bound;
            probs[pi] = p + ((2048 - p) >>> 5);
            sym <<= 1;
          } else {
            range = (range - bound) | 0;
            code = (code - bound) | 0;
            probs[pi] = p - (p >>> 5);
            sym = (sym << 1) | 1;
            dist += 1 << i;
          }
        }
        rep0 = dist;
      }
    }

    // --- copy the match ---
    len += 2;
    // Also rejects the end-of-payload marker (rep0 = 0xFFFFFFFF), which LZMA2 does not allow.
    if (rep0 >= op - dictStart) fail('corrupt data (distance beyond dictionary)');
    if (len > opEnd - op) fail('corrupt data (match crosses chunk boundary)');
    let src = op - rep0 - 1;
    if (len >= 64 && rep0 + 1 >= len) {
      out.copyWithin(op, src, src + len);
      op += len;
    } else {
      const end = op + len;
      while (op < end) out[op++] = out[src++];
    }
  }

  // The range decoder is kept normalized between symbols, so a valid chunk ends exactly at
  // ipEnd with code == 0 (same rule as liblzma / xz-embedded).
  if ((range >>> 24) === 0) { range <<= 8; code = (code << 8) | inp[ip++]; }
  if (ip !== ipEnd || code !== 0) fail('corrupt LZMA2 chunk (size or range coder mismatch)');

  st.state = state;
  st.rep0 = rep0;
  st.rep1 = rep1;
  st.rep2 = rep2;
  st.rep3 = rep3;
}

// ---------------------------------------------------------------------------------------------
// LZMA2 + container

/**
 * Walks the LZMA2 chunk headers (without decoding) to find the exact uncompressed size and the
 * end of the LZMA2 data. Lets us size the output buffer exactly before decoding.
 */
function scanLzma2(inp, p) {
  let total = 0;
  for (;;) {
    if (p >= inp.length) fail('unexpected end of input (LZMA2 data)');
    const c = inp[p];
    if (c === 0) return { size: total, end: p + 1 };
    if (c === 1 || c === 2) {
      if (p + 3 > inp.length) fail('unexpected end of input (LZMA2 chunk header)');
      const size = ((inp[p + 1] << 8) | inp[p + 2]) + 1;
      total += size;
      p += 3 + size;
    } else if (c >= 0x80) {
      if (p + 5 > inp.length) fail('unexpected end of input (LZMA2 chunk header)');
      total += (((c & 0x1f) << 16) | (inp[p + 1] << 8) | inp[p + 2]) + 1;
      p += (c >= 0xc0 ? 6 : 5) + ((inp[p + 3] << 8) | inp[p + 4]) + 1;
    } else {
      fail(`corrupt data (invalid LZMA2 control byte 0x${c.toString(16)})`);
    }
  }
}

/** Decodes the LZMA2 data of one block from inp[p] into out[op...]; returns the input end. */
function decodeLzma2(st, inp, p, out, op) {
  let dictStart = op;
  let needDictReset = true;
  let needProps = true;
  for (;;) {
    const c = inp[p++];
    if (c === 0) return p;
    if (c >= 0xe0 || c === 1) {
      needProps = true;
      needDictReset = false;
      dictStart = op;
    } else if (needDictReset) {
      fail('corrupt data (LZMA2 data does not start with a dictionary reset)');
    }
    if (c >= 0x80) {
      const usize = (((c & 0x1f) << 16) | (inp[p] << 8) | inp[p + 1]) + 1;
      const csize = ((inp[p + 2] << 8) | inp[p + 3]) + 1;
      p += 4;
      if (c >= 0xc0) {
        if (!st.setProps(inp[p++])) fail('corrupt data (invalid LZMA2 properties)');
        needProps = false;
        st.reset();
      } else if (needProps) {
        fail('corrupt data (LZMA2 chunk without required properties)');
      } else if (c >= 0xa0) {
        st.reset();
      }
      if (p + csize > inp.length) fail('unexpected end of input (LZMA2 chunk)');
      decodeLzmaChunk(st, inp, p, p + csize, out, op, op + usize, dictStart);
      p += csize;
      op += usize;
    } else {
      // Uncompressed chunk (scanLzma2 already rejected other control values).
      const size = ((inp[p] << 8) | inp[p + 1]) + 1;
      p += 2;
      if (p + size > inp.length) fail('unexpected end of input (LZMA2 uncompressed chunk)');
      out.set(inp.subarray(p, p + size), op);
      p += size;
      op += size;
    }
  }
}

/** Reads an xz variable-length integer; returns [value, newPos]. */
function readVarint(inp, p, limit) {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 9; i++) {
    if (p >= limit) fail(limit < inp.length ? 'corrupt data (integer crosses header end)' : 'unexpected end of input (integer)');
    const b = inp[p++];
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) {
      if (b === 0 && i > 0) fail('corrupt data (non-minimal integer encoding)');
      return [value, p];
    }
    mul *= 128;
  }
  return fail('corrupt data (integer too long)');
}

/**
 * Decodes one xz stream starting at `pos`.
 * @returns {number} position just past the stream footer
 */
function decodeStream(inp, pos, sink) {
  if (pos + 12 > inp.length) fail('unexpected end of input (stream header)');
  for (let i = 0; i < 6; i++) {
    if (inp[pos + i] !== HEADER_MAGIC[i]) fail('not an xz stream (bad magic)');
  }
  const flags0 = inp[pos + 6];
  const flags1 = inp[pos + 7];
  if (crc32(inp.subarray(pos + 6, pos + 8)) !== readU32LE(inp, pos + 8)) {
    fail('corrupt stream header (CRC32 mismatch)');
  }
  if (flags0 !== 0 || (flags1 & 0xf0) !== 0) fail('unsupported stream flags');
  const checkType = flags1 & 0x0f;
  const checkSize = CHECK_SIZES[checkType];
  pos += 12;

  const st = new LzmaState();
  const records = [];
  for (;;) {
    if (pos >= inp.length) fail('unexpected end of input (block header)');
    if (inp[pos] === 0x00) break; // index indicator

    // --- block header ---
    const blockStart = pos;
    const headerSize = (inp[pos] + 1) * 4;
    if (pos + headerSize > inp.length) fail('unexpected end of input (block header)');
    const headerEnd = pos + headerSize - 4;
    if (crc32(inp.subarray(pos, headerEnd)) !== readU32LE(inp, headerEnd)) {
      fail('corrupt block header (CRC32 mismatch)');
    }
    const bflags = inp[pos + 1];
    if (bflags & 0x3c) fail('unsupported block header flags');
    let p = pos + 2;
    let compressedSize = -1;
    let uncompressedSize = -1;
    if (bflags & 0x40) [compressedSize, p] = readVarint(inp, p, headerEnd);
    if (bflags & 0x80) [uncompressedSize, p] = readVarint(inp, p, headerEnd);
    const numFilters = (bflags & 3) + 1;
    let filterId = -1;
    let props = null;
    for (let f = 0; f < numFilters; f++) {
      let id;
      let propsSize;
      [id, p] = readVarint(inp, p, headerEnd);
      [propsSize, p] = readVarint(inp, p, headerEnd);
      if (p + propsSize > headerEnd) fail('corrupt block header (filter properties)');
      if (f === 0) {
        filterId = id;
        props = inp.subarray(p, p + propsSize);
      }
      p += propsSize;
    }
    if (numFilters !== 1 || filterId !== FILTER_LZMA2) {
      const name = filterId === FILTER_LZMA2 ? 'LZMA2 combined with other filters' :
        `filter 0x${filterId.toString(16)}`;
      fail(`unsupported ${name} (only a plain LZMA2 filter chain is supported)`);
    }
    if (props.length !== 1 || props[0] > 40) fail('corrupt block header (LZMA2 dictionary size)');
    for (; p < headerEnd; p++) if (inp[p] !== 0) fail('corrupt block header (non-zero padding)');

    // --- compressed data ---
    const dataStart = blockStart + headerSize;
    const scan = scanLzma2(inp, dataStart);
    if (uncompressedSize >= 0 && uncompressedSize !== scan.size) {
      fail('corrupt data (uncompressed size does not match block header)');
    }
    if (compressedSize >= 0 && compressedSize !== scan.end - dataStart) {
      fail('corrupt data (compressed size does not match block header)');
    }
    const outStart = sink.reserve(scan.size);
    const end = decodeLzma2(st, inp, dataStart, sink.buf, outStart);
    sink.pos = outStart + scan.size;

    // --- block padding + check ---
    pos = end;
    while ((pos - blockStart) & 3) {
      if (pos >= inp.length) fail('unexpected end of input (block padding)');
      if (inp[pos++] !== 0) fail('corrupt data (non-zero block padding)');
    }
    if (pos + checkSize > inp.length) fail('unexpected end of input (block check)');
    verifyCheck(checkType, sink.buf.subarray(outStart, outStart + scan.size), inp, pos);
    pos += checkSize;
    records.push(headerSize + (end - dataStart) + checkSize, scan.size);
  }

  // --- index ---
  const indexStart = pos;
  let p = pos + 1;
  let count;
  [count, p] = readVarint(inp, p, inp.length);
  if (count * 2 !== records.length) fail('corrupt index (block count mismatch)');
  for (let i = 0; i < records.length; i++) {
    let v;
    [v, p] = readVarint(inp, p, inp.length);
    if (v !== records[i]) fail('corrupt index (block size mismatch)');
  }
  while ((p - indexStart) & 3) {
    if (p >= inp.length) fail('unexpected end of input (index padding)');
    if (inp[p++] !== 0) fail('corrupt index (non-zero padding)');
  }
  if (p + 4 > inp.length) fail('unexpected end of input (index CRC32)');
  if (crc32(inp.subarray(indexStart, p)) !== readU32LE(inp, p)) fail('corrupt index (CRC32 mismatch)');
  p += 4;
  const indexSize = p - indexStart;

  // --- footer ---
  if (p + 12 > inp.length) fail('unexpected end of input (stream footer)');
  if (crc32(inp.subarray(p + 4, p + 10)) !== readU32LE(inp, p)) {
    fail('corrupt stream footer (CRC32 mismatch)');
  }
  if ((readU32LE(inp, p + 4) + 1) * 4 !== indexSize) fail('corrupt stream footer (backward size)');
  if (inp[p + 8] !== flags0 || inp[p + 9] !== flags1) fail('corrupt stream footer (flags mismatch)');
  if (inp[p + 10] !== FOOTER_MAGIC_0 || inp[p + 11] !== FOOTER_MAGIC_1) {
    fail('corrupt stream footer (bad magic)');
  }
  return p + 12;
}

/** Growable output buffer; exact-sized for the common single-block case. */
class Sink {
  constructor() {
    this.buf = null;
    this.pos = 0;
  }

  /** Makes room for n more bytes and returns the write position. */
  reserve(n) {
    const need = this.pos + n;
    if (!this.buf) {
      // allocUnsafe is fine: every byte below pos is written by the decoder before it is exposed.
      this.buf = Buffer.allocUnsafe(need);
    } else if (need > this.buf.length) {
      const grown = Buffer.allocUnsafe(Math.max(need, Math.min(this.buf.length * 2, 0x7fffffff)));
      this.buf.copy(grown, 0, 0, this.pos);
      this.buf = grown;
    }
    return this.pos;
  }
}

function startsWithMagic(inp, pos) {
  if (pos + 6 > inp.length) return false;
  for (let i = 0; i < 6; i++) if (inp[pos + i] !== HEADER_MAGIC[i]) return false;
  return true;
}

/**
 * Decompresses a complete .xz file (one or more streams, LZMA2 filter only).
 * @param {Uint8Array} input
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreTrailing=false] stop quietly at the first byte after a stream (and
 *   its padding) that does not start another stream, instead of failing. A ZIM cluster's byte
 *   range is only known as "up to the next known offset", which may include unrelated bytes.
 * @returns {Buffer} the uncompressed data
 * @throws {Error} on corrupt, truncated or unsupported input (never loops forever)
 */
export function xzDecompress(input, { ignoreTrailing = false } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('xzDecompress: input must be a Uint8Array');
  const sink = new Sink();
  let pos = 0;
  let streams = 0;
  while (pos < input.length) {
    if (streams > 0) {
      // Stream padding: null bytes in multiples of four between / after streams.
      const padStart = pos;
      while (pos < input.length && input[pos] === 0) pos++;
      if (ignoreTrailing && !startsWithMagic(input, pos)) break;
      if ((pos - padStart) & 3) fail('corrupt data (stream padding is not a multiple of 4 bytes)');
      if (pos === input.length) break;
    }
    pos = decodeStream(input, pos, sink);
    streams++;
  }
  if (streams === 0) fail('unexpected end of input (empty input)');
  if (!sink.buf) return Buffer.alloc(0);
  return sink.pos === sink.buf.length ? sink.buf : Buffer.from(sink.buf.subarray(0, sink.pos));
}
