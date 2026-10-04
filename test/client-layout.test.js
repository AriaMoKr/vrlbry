// Layout engine invariants (public/js/reader/layout.js) with a deterministic fake measurer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeMetrics, layoutBoxes, layoutChunk, paginate, blockChars as clientChars } from '../public/js/reader/layout.js';
import { blockChars as serverChars } from '../server/content/html.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ZIM = path.join(HERE, '..', 'gutenberg_en_lcc-pe_2026-03.zim');

/** Width ∝ characters × font px; monospace a little wider. */
const fake = {
  width(text, font) {
    const px = parseFloat(/([\d.]+)px/.exec(font)[1]);
    return text.length * px * (/mono/i.test(font) ? 0.6 : 0.5);
  },
};

const M = makeMetrics({ width: 1024, height: 1448, fontScale: 1 });
const words = (n, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ');
const p = (text, extra = {}) => ({ t: 'p', r: [[text, 0]], ...extra });

function checkPages(pages, blocks) {
  assert.ok(pages.length >= 1);
  let lastFirst = -1;
  for (const pg of pages) {
    assert.ok(pg.boxes.length > 0, 'no empty pages');
    assert.ok(pg.firstBlock >= lastFirst, 'pages advance monotonically');
    lastFirst = pg.firstBlock;
    for (const { y, box } of pg.boxes) {
      assert.ok(y >= 0);
      if (pg.boxes.length > 1) assert.ok(y + box.h <= M.textHeight + 0.5, 'boxes fit the text area');
      for (const it of box.items) {
        if (it.k === 't') {
          assert.ok(it.x >= -0.5, 'text starts inside the text area');
          assert.ok(it.x + fake.width(it.text, it.font) <= M.textWidth + 2, `text fits the line: "${it.text}"`);
        }
      }
    }
  }
  assert.ok(pages[pages.length - 1].lastBlock <= blocks.length - 1);
}

describe('reader layout', () => {
  it('blockChars matches the server (progress maths depends on it)', () => {
    const samples = [p('hello'), { t: 'h', l: 1, r: [['Title', 0]] }, { t: 'img', src: 'x' }, { t: 'hr' },
      { t: 'pre', x: 'a\nb' }, { t: 'tr', c: [[['ab', 0]], [['cde', 1]]], g: 1 }, { t: 'li', r: [['x', 0]], d: 1, m: '•' }];
    for (const b of samples) assert.equal(clientChars(b), serverChars(b));
  });

  it('paginates long text without overflow, splitting no line', () => {
    const blocks = Array.from({ length: 60 }, (_, i) => p(words(80 + (i % 5) * 30)));
    const pages = layoutChunk(blocks, M, fake);
    assert.ok(pages.length > 5);
    checkPages(pages, blocks);
  });

  it('justifies full lines exactly to the text width and leaves last lines ragged', () => {
    const boxes = layoutBoxes([p(words(200))], M, fake);
    const lineEnd = (box) => Math.max(...box.items.map((it) => it.x + fake.width(it.text, it.font)));
    for (const box of boxes.slice(0, -1)) assert.ok(Math.abs(lineEnd(box) - M.textWidth) < 1, 'justified');
    assert.ok(lineEnd(boxes[boxes.length - 1]) < M.textWidth - 1, 'last line ragged');
  });

  it('breaks words longer than a line', () => {
    const blocks = [p('x'.repeat(400))];
    const pages = layoutChunk(blocks, M, fake);
    checkPages(pages, blocks);
    assert.ok(pages[0].boxes.length > 1);
  });

  it('keeps headings with the following text', () => {
    // Fill a page almost completely, then a heading: it must move to the next page.
    const filler = Array.from({ length: 200 }, () => p(words(12)));
    const boxes = layoutBoxes(filler, M, fake);
    const pages0 = paginate(boxes, filler, M);
    const lastY = pages0[0].boxes.at(-1).y;
    assert.ok(lastY > 0);
    for (let n = 30; n < 60; n++) {
      const blocks = [...Array.from({ length: n }, () => p(words(12))), { t: 'h', l: 2, r: [['Chapter Two', 0]] }, p(words(150))];
      const pages = layoutChunk(blocks, M, fake);
      checkPages(pages, blocks);
      for (const pg of pages) {
        const last = pg.boxes.at(-1).box;
        if (pg !== pages.at(-1)) assert.equal(last.keep, false, `heading not stranded at page bottom (n=${n})`);
      }
    }
  });

  it('lays out tables, pre, lists, verse, images and rules', () => {
    const blocks = [
      { t: 'h', l: 1, r: [['Title', 0]] },
      { t: 'tr', c: [[['Name', 2]], [['Page', 2]]], g: 1, hd: true },
      ...Array.from({ length: 30 }, (_, i) => ({ t: 'tr', c: [[[`Row ${i} ${words(6)}`, 0]], [[String(i * 3), 0]]], g: 1 })),
      { t: 'pre', x: '  code line one\n' + 'w'.repeat(300) + '\n\tTabbed' },
      { t: 'li', r: [['First item ' + words(30), 0]], d: 1, m: '•' },
      { t: 'li', r: [['Nested', 0]], d: 2, m: '1.' },
      { t: 'p', r: [['Line one\nline two is longer ' + words(40), 1]], v: 1 },
      { t: 'img', src: '/a.png', w: 3000, h: 4000 },
      { t: 'img', src: '/b.png', w: 50, h: 40 },
      { t: 'hr' },
      { t: 'p', r: [['centered', 0]], a: 'c', q: 2 },
    ];
    const pages = layoutChunk(blocks, M, fake);
    checkPages(pages, blocks);
    const imgs = pages.flatMap((pg) => pg.boxes.flatMap(({ box }) => box.items.filter((i) => i.k === 'img')));
    assert.equal(imgs.length, 2);
    for (const im of imgs) {
      assert.ok(im.w <= M.textWidth + 0.5 && im.h <= M.textHeight + 0.5, 'images scaled to fit');
      assert.ok(im.x >= 0);
    }
    const big = imgs.find((i) => i.src === '/a.png');
    assert.ok(Math.abs(big.w / big.h - 0.75) < 0.01, 'aspect kept');
  });

  it('is deterministic and scales with fontScale', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => p(words(100 + i)));
    const a = layoutChunk(blocks, M, fake).map((pg) => pg.firstBlock + ':' + pg.boxes.length);
    const b = layoutChunk(blocks, M, fake).map((pg) => pg.firstBlock + ':' + pg.boxes.length);
    assert.deepEqual(a, b);
    const big = layoutChunk(blocks, makeMetrics({ width: 1024, height: 1448, fontScale: 1.6 }), fake);
    assert.ok(big.length > a.length);
  });

  it('handles real chunks from the reference ZIM', { skip: !fs.existsSync(REAL_ZIM) && 'real ZIM not present' }, async () => {
    // Open the reference archive itself: the repo folder may hold other ZIMs too.
    const { ArchiveLibrary } = await import('../server/library.js');
    const a = await ArchiveLibrary.open(REAL_ZIM, { log: () => {} });
    try {
      for (const id of ['37134', '10681', '11921', '44765', '26577']) {
        const { chunks } = await a.content(id);
        for (const ch of chunks.slice(0, 3)) {
          const pages = layoutChunk(ch.blocks, M, fake);
          checkPages(pages, ch.blocks);
          assert.equal(pages[0].charStart, 0);
        }
      }
    } finally {
      await a.close();
    }
  });
});
