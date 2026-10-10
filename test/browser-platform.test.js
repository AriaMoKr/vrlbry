// The core's platform in a browser (public/js/local/browser-platform.js): fzstd with the input cut
// at the end of the first zstd frame, fflate for zlib and raw deflate, truncation reported the way
// the ZIM reader retries on (code 'Z_BUF_ERROR'). Built here from node_modules, as the worker
// builds it from /vendor/.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';
import { inflateSync, unzlibSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { browserPlatform, zstdFrameEnd } from '../public/js/local/browser-platform.js';

const libs = { zstdDecompress, unzlibSync, inflateSync, Parser };
const text = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(4000));

describe('browser platform', () => {
  it('finds the end of a zstd frame, so bytes after it are not read as another frame', () => {
    for (const opts of [{}, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: 0 } }]) {
      const frame = zlib.zstdCompressSync(text, opts);
      assert.equal(zstdFrameEnd(frame), frame.length);
      const followed = Buffer.concat([frame, Buffer.from('directory entries and more'), Buffer.alloc(100, 0xff)]);
      assert.equal(zstdFrameEnd(followed), frame.length);
      assert.equal(zstdFrameEnd(frame.subarray(0, frame.length - 1)), -1, 'truncated');
      assert.equal(zstdFrameEnd(frame.subarray(0, 4)), 4, 'too short to be a frame: left to fzstd');
    }
    assert.equal(zstdFrameEnd(Buffer.from('not zstd at all')), 15);
  });

  it('decompresses zstd and zlib, and reports truncation as Z_BUF_ERROR', async () => {
    const p = browserPlatform(libs);
    const frame = zlib.zstdCompressSync(text);
    const followed = Buffer.concat([frame, Buffer.from('trailing bytes of the file')]);
    assert.deepEqual(Buffer.from(await p.zstd(followed)), text);
    await assert.rejects(p.zstd(frame.subarray(0, frame.length >> 1)), { code: 'Z_BUF_ERROR' });
    await assert.rejects(p.zstd(Buffer.from('not zstd at all')), (err) => err.code !== 'Z_BUF_ERROR');

    const deflated = zlib.deflateSync(text);
    assert.deepEqual(Buffer.from(await p.inflate(deflated)), text);
    await assert.rejects(p.inflate(deflated.subarray(0, deflated.length >> 1)), { code: 'Z_BUF_ERROR' });

    assert.deepEqual(Buffer.from(p.inflateRaw(zlib.deflateRawSync(text))), text);
    assert.equal(p.Parser, Parser);
  });
});
