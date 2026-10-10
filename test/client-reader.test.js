// BookReader (public/js/reader/reader.js) in Node: chunks are laid out a step at a time, so the
// first pages of a long chunk (a Wikipedia article) are available before the rest is laid out,
// and every answer matches a one-shot layout. fetch and the text measurer's canvas are faked.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Width ∝ characters × font px (as in client-layout.test.js). */
const width = (text, font) => text.length * parseFloat(/([\d.]+)px/.exec(font)[1]) * 0.5;
globalThis.OffscreenCanvas = class {
  getContext() {
    return { font: '', measureText(text) { return { width: width(text, this.font) }; } };
  }
};

const { BookReader } = await import('../public/js/reader/reader.js');
const { makeMetrics, layoutChunk, blockChars } = await import('../public/js/reader/layout.js');
const { PAGE_PX } = await import('../public/js/config.js');

const words = (n, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ');
const p = (text) => ({ t: 'p', r: [[text, 0]] });

/** A three-chunk book: short, long (an article of many pages), short. */
const CHUNKS = [
  [{ t: 'h', l: 1, r: [['Short', 0]] }, ...Array.from({ length: 8 }, () => p(words(60)))],
  [{ t: 'h', l: 1, r: [['Long', 0]] }, ...Array.from({ length: 400 }, (_, i) => p(words(40 + (i % 5) * 20)))],
  [{ t: 'h', l: 1, r: [['End', 0]] }, p(words(30))],
];
const chars = (blocks) => blocks.reduce((n, b) => n + blockChars(b), 0);

/** Serves the book; `lazy` gives estimated chunk sizes, as for a Wikipedia volume. */
function serve(id, { lazy = false } = {}) {
  let start = 0;
  const chunks = CHUNKS.map((blocks) => {
    const n = lazy ? 5000 : chars(blocks);
    const c = { start, chars: n, blocks: blocks.length };
    start += n;
    return c;
  });
  const meta = { id, title: 'Test', chunks, totalChars: start, toc: [], ...(lazy ? { lazy: true } : {}) };
  globalThis.fetch = async (url) => {
    const m = /\/books\/([^/]+)(?:\/chunks\/(\d+))?$/.exec(url);
    const body = m[2] === undefined ? meta : { index: +m[2], blocks: structuredClone(CHUNKS[+m[2]]) };
    return { ok: true, json: async () => structuredClone(body) };
  };
}

const M = makeMetrics({ width: PAGE_PX.w, height: PAGE_PX.h, fontScale: 1 });
const WHOLE = CHUNKS.map((blocks) => layoutChunk(structuredClone(blocks), M, { width }));

let n = 0;
/** A reader laying out one block per step, so a long chunk takes many steps. */
function open(opts) {
  const id = `b${++n}`; // a fresh book each time: api.js caches chunks per book
  serve(id, opts);
  return new BookReader({ libId: 'lib', book: { id, title: 'Test' }, layoutStepMs: 0 });
}

describe('reader', () => {
  it('serves the first pages of a long chunk before the rest is laid out', async () => {
    const r = open();
    assert.ok(WHOLE[1].length > 20, 'the long chunk has many pages');
    assert.deepEqual(await r.next({ c: 1, p: 0 }), { c: 1, p: 1 });
    const L = await r._layout(1);
    assert.equal(L.done, false, 'page 2 was ready long before the chunk');
    assert.ok(L.pages.length < WHOLE[1].length);
    assert.equal(r.anchorOf({ c: 1, p: 1 }).b, WHOLE[1][1].firstBlock, 'decided pages are addressable at once');
    // Going back from the next chunk needs the whole chunk: its last page.
    assert.deepEqual(await r.prev({ c: 2, p: 0 }), { c: 1, p: WHOLE[1].length - 1 });
    assert.equal(L.done, true);
    assert.equal(JSON.stringify(L.pages), JSON.stringify(WHOLE[1]), 'same pages as a one-shot layout');
    assert.deepEqual(await r.next({ c: 1, p: WHOLE[1].length - 1 }), { c: 2, p: 0 }, 'then on to the next chunk');
    assert.equal(r.totalPages().estimated, true, 'chunk 0 not laid out yet');
  });

  it('finds anchors and progress positions as a one-shot layout does', async () => {
    const r = open();
    for (const b of [0, 1, 37, 150, 399]) {
      let want = 0;
      WHOLE[1].forEach((pg, i) => { if (pg.firstBlock < b || (pg.firstBlock === b && pg.firstLine === 0)) want = i; });
      assert.deepEqual(await r.refForAnchor({ c: 1, b }), { c: 1, p: want }, `block ${b}`);
    }
    const total = CHUNKS.reduce((s, blocks) => s + chars(blocks), 0);
    for (const f of [0.1, 0.5, 0.9]) {
      const local = f * total - chars(CHUNKS[0]);
      let want = 0;
      WHOLE[1].forEach((pg, i) => { if (pg.charStart <= local) want = i; });
      assert.deepEqual(await r.refForProgress(f), { c: 1, p: want }, `progress ${f}`);
    }
  });

  it('stops laying out when the book closes or the font size changes', async () => {
    const r = open();
    await r.next({ c: 1, p: 0 });
    const L = await r._layout(1);
    r.dispose();
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(L.cancelled, true);
    const count = L.pages.length;
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(L.pages.length, count, 'no more steps after closing');
    assert.equal(await L.page(count + 5), null, 'waiters are released');

    const r2 = open();
    await r2.next({ c: 1, p: 0 });
    const old = await r2._layout(1);
    r2.setFontScale(1.4);
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(old.cancelled, true);
    const fresh = await r2._layout(1);
    assert.notEqual(fresh, old);
    await fresh.complete();
    assert.ok(fresh.pages.length > WHOLE[1].length, 'laid out again at the larger size');
  });

  it('replaces estimated chunk sizes with real ones as chunks arrive (lazy books)', async () => {
    const r = open({ lazy: true });
    await r.load();
    assert.equal(r.meta.totalChars, 15000);
    await r._layout(1);
    assert.equal(r.meta.chunks[1].chars, chars(CHUNKS[1]));
    assert.equal(r.meta.chunks[2].start, 5000 + chars(CHUNKS[1]));
    assert.equal(r.meta.totalChars, 10000 + chars(CHUNKS[1]));
  });

  it('finds the link under a point of a page shown (linkAt) and a place by its id (blockOfId)', async () => {
    const ln = { href: 'C/Insect' };
    const blocks = [
      { t: 'h', l: 1, r: [['Ants', 0]] },
      { t: 'p', r: [['Ants are ', 0], ['social insects', 0, ln], [' that live in colonies.', 0]] },
      { t: 'h', l: 2, r: [['Colonies', 0]], id: 'Colonies' },
      { t: 'h', l: 2, r: [['Life cycle', 0]], id: 'note-1' },
    ];
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => structuredClone(/\/chunks\//.test(url) ? { index: 0, blocks }
        : { id: 'linked', title: 'Links', chunks: [{ start: 0, chars: 70, blocks: blocks.length }], totalChars: 70, toc: [] }),
    });
    const r = new BookReader({ libId: 'lib', book: { id: 'linked', title: 'Links' }, layoutStepMs: 0 });
    const L = await (await r._layout(0)).complete();
    r._remember(0, L); // as render() does for a page shown
    const ref = { c: 0, p: 0 };
    const M = r.metrics;
    const [{ y: by, box }] = L.pages[0].boxes.filter(({ box: b }) => b.items.some((i) => i.ln));
    const item = box.items.find((i) => i.ln);
    const x = M.marginX + item.x + item.w / 2;
    const y = M.top + by + item.y - 0.3 * M.size;
    const found = r.linkAt(ref, x, y);
    assert.deepEqual(found.link, ln);
    assert.equal(found.rects.length, 1, 'one line');
    const [rect] = found.rects;
    assert.ok(rect.x <= x && x <= rect.x + rect.w && rect.y <= y && y <= rect.y + rect.h, JSON.stringify(rect));
    assert.deepEqual(r.linkAt(ref, M.marginX + item.x + item.w + 0.2 * M.size, y)?.link, ln, 'a little beside it still takes it');
    assert.equal(r.linkAt(ref, M.marginX + 2, y), null, 'the plain words before it');
    assert.equal(r.linkAt(ref, x, y + 4 * M.lineHeight), null, 'lines below');
    assert.equal(r.linkAt('ex', x, y), null);
    assert.equal(r.linkAt({ c: 0, p: 5 }, x, y)?.link.href, 'C/Insect', 'a page past the end is the last');
    assert.equal(await r.blockOfId(0, 'Colonies'), 2);
    assert.equal(await r.blockOfId(0, 'Life_cycle'), 3, 'a heading by its text, as MediaWiki names sections');
    assert.equal(await r.blockOfId(0, 'nowhere'), null);
  });
});
