// Spreads (public/js/reader/spreads.js): one page at a time or two, with a fake reader, and where
// the single-page view puts the page on a flat screen.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  currentRef, currentSide, fitOnePage, isPage, nextSpread, pageViewSetting, prevSpread, sameSpread, singlePage, spreadAt,
} from '../public/js/reader/spreads.js';

/** A reader of chunks with `counts` pages each, as BookReader answers next/prev/pageNumber. */
function fakeReader(counts) {
  return {
    async next({ c, p }) {
      if (p + 1 < counts[c]) return { c, p: p + 1 };
      return c + 1 < counts.length ? { c: c + 1, p: 0 } : null;
    },
    async prev({ c, p }) {
      if (p > 0) return { c, p: p - 1 };
      return c > 0 ? { c: c - 1, p: counts[c - 1] - 1 } : null;
    },
    pageNumber({ c, p }) {
      let n = 0;
      for (let i = 0; i < c; i++) n += counts[i];
      return { n: n + p + 1, estimated: false };
    },
  };
}

const page = (ref) => (isPage(ref) ? `${ref.c}.${ref.p}` : String(ref));
const show = (s) => (s ? `${page(s.left)} | ${page(s.right)}` : 'none');

/** Every spread from `first` on, turning forward until the end. */
async function walk(reader, first, opts) {
  const seen = [];
  for (let s = first; s; s = await nextSpread(reader, s, opts)) seen.push(show(s));
  return seen;
}

describe('one page or two', () => {
  it('chooses the single-page view by the setting, or for a flat screen taller than wide', () => {
    assert.equal(singlePage('auto', { aspect: 0.46 }), true, 'a phone upright');
    assert.equal(singlePage('auto', { aspect: 1.78 }), false, 'a wide window');
    assert.equal(singlePage('auto', { aspect: 0.46, presenting: true }), false, 'a headset');
    assert.equal(singlePage('single', { aspect: 1.78 }), true);
    assert.equal(singlePage('spread', { aspect: 0.46 }), false);
    assert.equal(singlePage(undefined, { aspect: 0.8 }), true, 'settings saved before the setting existed');
  });

  it('keeps a choice as "auto" when it is what auto gives', () => {
    assert.equal(pageViewSetting(true, true), 'auto');
    assert.equal(pageViewSetting(false, false), 'auto');
    assert.equal(pageViewSetting(true, false), 'single');
    assert.equal(pageViewSetting(false, true), 'spread');
  });
});

describe('spreads', () => {
  const reader = fakeReader([3, 2, 1]); // pages 1–3, 4–5, 6

  it('pairs two pages by number, odd on the right, the ex-libris before the first', async () => {
    assert.equal(show(await spreadAt(reader, { c: 0, p: 0 })), 'ex | 0.0');
    assert.equal(show(await spreadAt(reader, { c: 0, p: 1 })), '0.1 | 0.2');
    assert.equal(show(await spreadAt(reader, { c: 0, p: 2 })), '0.1 | 0.2');
    assert.equal(show(await spreadAt(reader, { c: 2, p: 0 })), '2.0 | null', 'page 6, the last, on the left');
    assert.deepEqual(await walk(reader, await spreadAt(reader, { c: 0, p: 0 })), ['ex | 0.0', '0.1 | 0.2', '1.0 | 1.1', '2.0 | null']);
  });

  it('puts a page on the side asked for (a debug report, a link trail), two pages only', async () => {
    assert.equal(show(await spreadAt(reader, { c: 0, p: 2 }, { side: 'left' })), '0.2 | 1.0');
    assert.equal(show(await spreadAt(reader, { c: 0, p: 1 }, { side: 'right' })), '0.0 | 0.1');
    assert.equal(show(await spreadAt(reader, { c: 0, p: 1 }, { side: 'left', single: true })), 'blank | 0.1');
  });

  it('shows one page at a time on the right, a blank (the ex-libris first) on the left', async () => {
    const first = await spreadAt(reader, { c: 0, p: 0 }, { single: true });
    assert.deepEqual(await walk(reader, first, { single: true }),
      ['ex | 0.0', 'blank | 0.1', 'blank | 0.2', 'blank | 1.0', 'blank | 1.1', 'blank | 2.0']);
    // And back again, page by page, to the first.
    const back = [];
    for (let s = await spreadAt(reader, { c: 2, p: 0 }, { single: true }); s; s = await prevSpread(reader, s, { single: true })) back.push(page(s.right));
    assert.deepEqual(back, ['2.0', '1.1', '1.0', '0.2', '0.1', '0.0']);
  });

  it('turns two pages back as before: the ex-libris spread first', async () => {
    assert.equal(show(await prevSpread(reader, { left: { c: 1, p: 0 }, right: { c: 1, p: 1 } })), '0.1 | 0.2');
    assert.equal(show(await prevSpread(reader, { left: { c: 0, p: 1 }, right: { c: 0, p: 2 } })), 'ex | 0.0');
    assert.equal(await prevSpread(reader, { left: 'ex', right: { c: 0, p: 0 } }), null);
    assert.equal(show(await nextSpread(reader, { left: { c: 2, p: 0 }, right: null })), 'none', 'the last page on the left');
  });

  it('names the page being read: the left of two, else the right', () => {
    assert.deepEqual(currentRef({ left: { c: 0, p: 1 }, right: { c: 0, p: 2 } }), { c: 0, p: 1 });
    assert.deepEqual(currentRef({ left: 'ex', right: { c: 0, p: 0 } }), { c: 0, p: 0 });
    assert.deepEqual(currentRef({ left: 'blank', right: { c: 1, p: 0 } }), { c: 1, p: 0 });
    assert.equal(currentRef(null), null);
    assert.equal(currentSide({ left: 'blank', right: { c: 1, p: 0 } }), 'right');
    assert.equal(currentSide({ left: { c: 0, p: 1 }, right: null }), 'left');
    assert.ok(sameSpread({ left: 'blank', right: { c: 1, p: 0 } }, { left: 'blank', right: { c: 1, p: 0 } }));
    assert.ok(!sameSpread({ left: 'blank', right: { c: 1, p: 0 } }, { left: 'ex', right: { c: 1, p: 0 } }));
    assert.ok(!sameSpread({ left: { c: 0, p: 1 }, right: null }, { left: { c: 0, p: 1 }, right: { c: 0, p: 2 } }));
  });
});

describe('the single-page view on a flat screen', () => {
  const vt = Math.tan((35 * Math.PI) / 180); // a 70° vertical field of view, as main.js's camera
  const base = { pageW: 0.318, pageH: 0.441, vt, toolbarW: 0.72, toolbarDrop: 0.15 };
  const EPS = 1e-9;

  /** The page and toolbar within the screen. */
  function check(fit, aspect, { top = 0.03, foot = 0.18 } = {}) {
    const h = fit.dist * vt;
    const pageTop = -fit.drop + base.pageH / 2;
    const toolbarFoot = -fit.drop - base.pageH / 2 - base.toolbarDrop * fit.toolbar;
    assert.ok(base.pageW / 2 <= h * aspect + EPS, 'as wide as the screen at most');
    assert.ok(pageTop <= (1 - top) * h + EPS, 'below the top margin');
    assert.ok(toolbarFoot >= -(1 - foot) * h - EPS, 'the toolbar above the foot strip');
    assert.ok((0.72 / 2) * fit.toolbar <= 0.96 * fit.dist * vt * aspect + EPS, 'the toolbar within the width');
    return { h, pageTop, toolbarFoot };
  }

  it('makes the page as wide as a phone held upright, the toolbar scaled down to its width', () => {
    const aspect = 375 / 812;
    const fit = fitOnePage({ ...base, aspect });
    check(fit, aspect);
    assert.ok(Math.abs(base.pageW / 2 - fit.dist * vt * aspect) < 1e-6, 'the width decides');
    assert.ok(fit.toolbar < 0.5);
    assert.ok(fit.drop < 0, 'the page above the eyes, the toolbar under it');
  });

  it('makes it as tall as a wide window allows, the toolbar full size under it', () => {
    const aspect = 16 / 9;
    const fit = fitOnePage({ ...base, aspect });
    const { h, pageTop } = check(fit, aspect);
    assert.equal(fit.toolbar, 1);
    assert.ok(Math.abs(pageTop - 0.97 * h) < 1e-6, 'the height decides: the page reaches the top margin');
  });
});
