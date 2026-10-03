import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { xzDecompress } from '../server/zim/xz.js';
import { xzStore } from './helpers/zimwriter.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xz');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const load = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.xz`));
const expected = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.sha256`), 'utf8').trim();

/** Deterministic PRNG (mulberry32) so corruption tests are reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Recomputes the CRC32 of the first block header (stream header is 12 bytes). */
function fixBlockHeaderCrc(buf) {
  const size = (buf[12] + 1) * 4;
  buf.writeUInt32LE(zlib.crc32(buf.subarray(12, 12 + size - 4)), 12 + size - 4);
}

const FIXTURE_NAMES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.xz')).map((f) => f.slice(0, -3)).sort();

describe('xzDecompress: fixtures produced by liblzma (Python lzma / xz CLI)', () => {
  it('has the expected fixture set', () => {
    for (const name of ['small_text', 'empty', 'one_byte', 'repeated', 'random', 'mixed_chunks',
      'preset0', 'preset6', 'preset9e', 'check_none', 'check_crc32', 'check_crc64', 'check_sha256',
      'lc0_lp2_pb0', 'lc4_lp0_pb4', 'lc1_lp3_pb1', 'lc4_text', 'dict_4k', 'dict_64m', 'concat',
      'padded', 'multiblock', 'multiblock_mt', 'speed_3mb', 'zim_cluster']) {
      assert.ok(FIXTURE_NAMES.includes(name), `missing fixture ${name}`);
    }
  });

  for (const name of FIXTURE_NAMES) {
    it(`decodes ${name}`, () => {
      const out = xzDecompress(load(name));
      assert.ok(Buffer.isBuffer(out));
      assert.equal(sha256(out), expected(name));
    });
  }

  it('decodes small_text to the exact text', () => {
    assert.equal(xzDecompress(load('small_text')).toString('utf8'),
      'Hello, xz! The quick brown fox jumps over the lazy dog.\n');
    assert.equal(xzDecompress(load('one_byte')).toString('latin1'), 'A');
    assert.equal(xzDecompress(load('empty')).length, 0);
  });

  it('decodes ~3 MB in well under a second', () => {
    const input = load('speed_3mb');
    const t0 = performance.now();
    const out = xzDecompress(input);
    const ms = performance.now() - t0;
    assert.equal(out.length, 3 * 1024 * 1024);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  });

  it('accepts Uint8Array input (not only Buffer)', () => {
    const buf = load('preset6');
    const u8 = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    assert.equal(sha256(xzDecompress(u8)), expected('preset6'));
  });
});

describe('xzDecompress: container edge cases', () => {
  it('rejects non-byte input and empty input', () => {
    assert.throws(() => xzDecompress('abc'), TypeError);
    assert.throws(() => xzDecompress(Buffer.alloc(0)), /xz: unexpected end of input/);
    assert.throws(() => xzDecompress(Buffer.from('not xz at all, really')), /bad magic/);
  });

  it('rejects trailing garbage unless ignoreTrailing is set', () => {
    const good = load('small_text');
    const withJunk = Buffer.concat([good, Buffer.from('trailing junk bytes')]);
    assert.throws(() => xzDecompress(withJunk), /xz:/);
    assert.equal(xzDecompress(withJunk, { ignoreTrailing: true }).toString(),
      'Hello, xz! The quick brown fox jumps over the lazy dog.\n');
    // Still decodes all concatenated streams in that mode.
    assert.equal(sha256(xzDecompress(load('concat'), { ignoreTrailing: true })), expected('concat'));
  });

  it('requires stream padding to be a multiple of four bytes', () => {
    const good = load('small_text');
    assert.ok(xzDecompress(Buffer.concat([good, Buffer.alloc(4)])));
    assert.ok(xzDecompress(Buffer.concat([good, Buffer.alloc(12), good])));
    assert.throws(() => xzDecompress(Buffer.concat([good, Buffer.alloc(3)])), /padding/);
    assert.throws(() => xzDecompress(Buffer.concat([good, Buffer.alloc(5), good])), /padding/);
  });

  it('refuses filters other than LZMA2 with a clear error', () => {
    for (const id of [0x03, 0x04, 0x0b]) {
      const buf = Buffer.from(load('small_text'));
      assert.equal(buf[14], 0x21, 'fixture layout: first filter id at byte 14');
      buf[14] = id;
      fixBlockHeaderCrc(buf);
      assert.throws(() => xzDecompress(buf), (err) => err.code === 'ERR_XZ_UNSUPPORTED' &&
        /only a plain LZMA2 filter chain/.test(err.message));
    }
  });

  it('round-trips the store-only encoder used by the ZIM writer (uncompressed LZMA2 chunks)', () => {
    const rnd = prng(7);
    for (const n of [0, 1, 65535, 65536, 65537, 200003]) {
      const data = Buffer.alloc(n);
      for (let i = 0; i < n; i++) data[i] = (rnd() * 256) | 0;
      assert.ok(xzDecompress(xzStore(data)).equals(data), `size ${n}`);
    }
  });
});

describe('xzDecompress: corrupt input throws (never hangs)', () => {
  it('detects corruption in every structural part', () => {
    const good = load('check_crc64');
    const blockHeaderSize = (good[12] + 1) * 4;
    const spots = {
      'stream header magic': 1,
      'stream flags': 7,
      'stream header CRC': 9,
      'block header': 13,
      'block header CRC': 12 + blockHeaderSize - 2,
      'LZMA2 data (early)': 12 + blockHeaderSize + 10,
      'LZMA2 data (middle)': good.length >> 1,
      'block check': good.length - 12 - 12 - 4,
      'index': good.length - 12 - 6,
      'footer backward size': good.length - 8,
      'footer magic': good.length - 1,
    };
    for (const [what, pos] of Object.entries(spots)) {
      const bad = Buffer.from(good);
      bad[pos] ^= 0x55;
      assert.throws(() => xzDecompress(bad), /^Error: xz: /, `${what} @${pos}`);
    }
  });

  it('reports a wrong CRC32 / CRC64 / SHA-256 check', () => {
    for (const [name, size] of [['check_crc32', 4], ['check_crc64', 8], ['check_sha256', 32]]) {
      const bad = Buffer.from(load(name));
      // The check field ends right before the index (which is 12 bytes here: 1 record + CRC32).
      bad[bad.length - 12 - 12 - size] ^= 1;
      assert.throws(() => xzDecompress(bad), /check failed/, name);
    }
  });

  it('reports truncation at any length', () => {
    const good = load('multiblock');
    for (let n = 0; n < good.length; n += 997) {
      assert.throws(() => xzDecompress(good.subarray(0, n)), /^Error: xz: /, `cut at ${n}`);
    }
    assert.throws(() => xzDecompress(good.subarray(0, good.length - 1)), (err) => err.code === 'ERR_XZ_TRUNCATED');
  });

  it('survives random mutations of several fixtures', () => {
    const rnd = prng(12345);
    const t0 = performance.now();
    let threw = 0;
    for (const name of ['preset6', 'mixed_chunks', 'lc4_lp0_pb4', 'dict_64m', 'multiblock_mt', 'check_none']) {
      const good = load(name);
      for (let k = 0; k < 40; k++) {
        const bad = Buffer.from(good);
        const flips = 1 + ((rnd() * 4) | 0);
        for (let f = 0; f < flips; f++) bad[(rnd() * bad.length) | 0] = (rnd() * 256) | 0;
        try {
          const out = xzDecompress(bad);
          assert.ok(Buffer.isBuffer(out)); // only possible when the damage went unnoticed (CHECK_NONE)
        } catch (err) {
          assert.match(err.message, /^xz: /);
          assert.ok(['ERR_XZ_CORRUPT', 'ERR_XZ_TRUNCATED', 'ERR_XZ_UNSUPPORTED'].includes(err.code), err.code);
          threw++;
        }
      }
    }
    assert.ok(threw >= 200, `only ${threw} of 240 corruptions detected`);
    assert.ok(performance.now() - t0 < 10000);
  });
});
