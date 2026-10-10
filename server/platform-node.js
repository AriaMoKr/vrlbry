// The shared core's platform on Node (public/js/core/platform.js): Buffers (so the server keeps
// Buffer's speed, and callers get Buffers as before), zlib's zstd and inflate on the libuv pool,
// crypto, htmlparser2, and files as byte sources. Import this before using the core on Node;
// the server's modules do.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { Parser } from 'htmlparser2';
import { provide } from '../public/js/core/platform.js';

const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

const gzip = promisify(zlib.gzip);
const zstd = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress)
  : () => Promise.reject(new Error('zstd needs Node.js >= 22.15 (zlib.zstdDecompress)'));

/** A file as a byte source: positional reads on one FileHandle. */
async function openFile(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    return {
      name: filePath,
      size,
      async read(position, length) {
        const buf = Buffer.allocUnsafe(length);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await fh.read(buf, done, length - done, position + done);
          if (bytesRead === 0) break; // end of file: fewer bytes
          done += bytesRead;
        }
        return done === length ? buf : buf.subarray(0, done);
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

/** The platform on Node (provided when this module is imported). */
export const nodePlatform = Object.freeze({
  alloc: (n) => Buffer.allocUnsafe(n),
  copy: (bytes) => Buffer.from(bytes),
  utf8: (bytes, start = 0, end = bytes.length) => asBuffer(bytes).toString('utf8', start, end),
  latin1: (bytes, start = 0, end = bytes.length) => asBuffer(bytes).toString('latin1', start, end),
  hex: (bytes, start = 0, end = bytes.length) => asBuffer(bytes).toString('hex', start, end),
  encodeUtf8: (text) => Buffer.from(text, 'utf8'),
  fromBase64: (text) => Buffer.from(text, 'base64'),
  toBase64: (bytes) => asBuffer(bytes).toString('base64'),
  indexOf: (hay, needle, from = 0) => asBuffer(hay).indexOf(needle, from),
  zstd,
  inflate: promisify(zlib.inflate),
  inflateRaw: (bytes) => zlib.inflateRawSync(bytes),
  crc32: typeof zlib.crc32 === 'function' ? (bytes) => zlib.crc32(bytes) >>> 0 : null,
  sha256: (bytes) => crypto.createHash('sha256').update(bytes).digest(),
  Parser,
  gzip: (bytes) => gzip(bytes, { level: 6 }),
  etag: (bytes) => `"${crypto.createHash('sha1').update(bytes).digest('base64url')}"`,
  openFile,
});

provide(nodePlatform);
