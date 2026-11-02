// The text view (public/js/ui/text-view.js, SPEC §5.8): a chunk's blocks as DOM nodes (each block
// type, the styles, pictures' alt, every kind of link, an empty part), the block at the top of
// the view, the reading position's round trip: page → text view → page lands on the same block,
// and its themes (common's shell, TEXT_VIEW_CSS) in the reader's colours.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fakeDocument, inner, markup } from './helpers/fake-dom.js';
import './helpers/vendor.js'; // text-view.js extends ../../vendor/common/text-view.js

/** Width ∝ characters × font px (as in client-reader.test.js), for the reader's layout. */
const width = (text, font) => text.length * parseFloat(/([\d.]+)px/.exec(font)[1]) * 0.5;
globalThis.OffscreenCanvas = class {
  getContext() {
    return { font: '', measureText(text) { return { width: width(text, this.font) }; } };
  }
};

const { renderBlocks, runsText, topBlock } = await import('../public/js/ui/text-view.js');
const { BookReader, THEMES } = await import('../public/js/reader/reader.js');
const { TEXT_VIEW_CSS } = await import('../public/vendor/common/text-view.js');

/** renderBlocks into a fresh container: its markup, and what the links and pictures asked for. */
function render(blocks, c = 0) {
  const doc = fakeDocument();
  const box = doc.createElement('div');
  const followed = [];
  const images = [];
  renderBlocks(doc, box, blocks, { c, onLink: (link) => followed.push(link), image: (img, src) => images.push(src) });
  return { box, html: inner(box), followed, images };
}

describe('the text view: blocks as DOM', () => {
  it('shows headings below its own, paragraphs with their alignment, verse and indent', () => {
    const { html } = render([
      { t: 'h', l: 1, r: [['Chapter I', 0]] },
      { t: 'h', l: 6, r: [['Deep', 0]], a: 'c' },
      { t: 'p', r: [['A plain paragraph.', 0]] },
      { t: 'p', r: [['Centred', 0]], a: 'c' },
      { t: 'p', r: [['Roses are red,\nviolets are blue.', 0]], v: 1, q: 2 },
    ]);
    assert.equal(html, [
      '<h2 data-b="0" id="tv-0-0"><span>Chapter I</span></h2>',
      '<h3 data-b="1" id="tv-0-1" class="tv-ac"><span>Deep</span></h3>',
      '<p data-b="2" id="tv-0-2"><span>A plain paragraph.</span></p>',
      '<p data-b="3" id="tv-0-3" class="tv-ac"><span>Centred</span></p>',
      '<p data-b="4" id="tv-0-4" class="tv-verse" style="margin-inline-start: 3em"><span>Roses are red,<br>violets are blue.</span></p>',
    ].join(''));
  });

  it('starts a part\'s headings at h2 whatever their level, and leaves out the block to skip', () => {
    const doc = fakeDocument();
    const box = doc.createElement('div');
    const article = [{ t: 'h', l: 1, r: [['Chemistry', 0]] }, { t: 'h', l: 2, r: [['History', 0]] }, { t: 'h', l: 3, r: [['Antiquity', 0]] }, { t: 'p', r: [['Text', 0]] }];
    assert.equal(renderBlocks(doc, box, article, { c: 0, skip: 0 }), 3);
    assert.deepEqual(box.children.map((e) => e.tagName), ['H2', 'H3', 'P'], 'the article\'s title left out, its sections under the view\'s h1');
    assert.equal(box.children[0].getAttribute('data-b'), '1', 'the blocks keep their numbers');
    assert.equal(render([{ t: 'h', l: 3, r: [['Chapter I', 0]] }, { t: 'h', l: 4, r: [['Part', 0]] }]).html,
      '<h2 data-b="0" id="tv-0-0"><span>Chapter I</span></h2><h3 data-b="1" id="tv-0-1"><span>Part</span></h3>', 'a part starting at level 3');
    // A level the book leaves out is closed up (Moby Dick: h3, then h5), and the rest follow.
    const levels = (ls) => render(ls.map((l) => ({ t: 'h', l, r: [['H', 0]] }))).html.match(/<h\d/g).join(' ');
    assert.equal(levels([2, 3, 5, 3, 6, 2]), '<h2 <h3 <h4 <h3 <h4 <h2', 'never a level left out');
    assert.equal(levels([4, 2, 3]), '<h2 <h2 <h3', 'a part opening deeper than its highest level');
    const empty = doc.createElement('div');
    assert.equal(renderBlocks(doc, empty, [article[0]], { c: 0, skip: 0 }), 0);
    assert.equal(inner(empty), '<p>(Nothing to read in this part.)</p>');
  });

  it('shows each style bit as its element, nested', () => {
    const bits = [[1, 'em'], [2, 'strong'], [4, 'code'], [8, 'sup'], [16, 'sub'], [64, 'u'], [128, 'small']];
    for (const [bit, tag] of bits) {
      assert.equal(render([{ t: 'p', r: [['x', bit]] }]).html, `<p data-b="0" id="tv-0-0"><${tag}><span>x</span></${tag}></p>`, tag);
    }
    assert.equal(render([{ t: 'p', r: [['x', 32]] }]).html, '<p data-b="0" id="tv-0-0"><span class="tv-smallcaps"><span>x</span></span></p>');
    assert.equal(render([{ t: 'p', r: [['x', 1 | 2]] }]).html, '<p data-b="0" id="tv-0-0"><strong><em><span>x</span></em></strong></p>', 'bold italic');
  });

  it('builds lists by depth with their markers, and tables by group with header cells', () => {
    const { box } = render([
      { t: 'li', d: 1, m: '1.', r: [['One', 0]] },
      { t: 'li', d: 2, m: '•', r: [['Inner', 0]] },
      { t: 'li', d: 1, m: '2.', r: [['Two', 0]] },
      { t: 'tr', g: 1, hd: true, c: [[['Name', 0]], [['Year', 0]]] },
      { t: 'tr', g: 1, c: [[['Ada', 0]], [['1815', 0]]] },
      { t: 'tr', g: 2, c: [[['Another table', 0]]] },
    ]);
    const [ul, t1, t2] = box.children;
    assert.equal(ul.tagName, 'UL');
    assert.deepEqual(ul.children.map((li) => li.getAttribute('data-b')), ['0', '2'], 'two items at depth 1');
    assert.equal(markup(ul.children[0].children[2]), '<ul class="tv-list"><li data-b="1" id="tv-0-1"><span class="tv-marker">• </span><span>Inner</span></li></ul>', 'depth 2 inside the first item');
    assert.equal(ul.children[0].children[0].textContent, '1. ');
    assert.equal(inner(t1), '<thead><tr data-b="3" id="tv-0-3"><th scope="col"><span>Name</span></th><th scope="col"><span>Year</span></th></tr></thead><tbody><tr data-b="4" id="tv-0-4"><td><span>Ada</span></td><td><span>1815</span></td></tr></tbody>');
    assert.equal(t2.tagName, 'TABLE', 'a new group, a new table');
  });

  it('shows preformatted text, pictures with their alt, inline pictures and separators', () => {
    const { html, images } = render([
      { t: 'pre', x: 'let x = 1;\n  x++;' },
      { t: 'img', src: 'zim/lib/C/pic.png', w: 200, h: 100, alt: 'A map of the river' },
      { t: 'img', src: 'zim/lib/C/f.svg', em: 1, inv: 1 },
      { t: 'p', r: [['E = mc', 0], ['￼', 0, { src: 'zim/lib/C/sq.svg', w: 8, h: 12, alt: '²' }]] },
      { t: 'hr' },
    ]);
    assert.equal(html, [
      '<pre data-b="0" id="tv-0-0">let x = 1;\n  x++;</pre>',
      '<figure data-b="1" id="tv-0-1"><img alt="A map of the river" class="" width="200" height="100"></figure>',
      '<figure data-b="2" id="tv-0-2"><img alt="" class="tv-formula tv-inv"></figure>',
      '<p data-b="3" id="tv-0-3"><span>E = mc</span><img alt="²" class="tv-inline" width="8" height="12"></p>',
      '<hr data-b="4" id="tv-0-4">',
    ].join(''));
    assert.deepEqual(images, ['zim/lib/C/pic.png', 'zim/lib/C/f.svg', 'zim/lib/C/sq.svg'], 'every picture loaded as the reader loads it');
  });

  it('makes every kind of link a real link, one per link, which follows it', () => {
    const at = { at: [3, 12] };
    const href = { href: 'A/Chemistry#History' };
    const to = { to: { book: 'v7', c: 4 } };
    const { box, followed } = render([{ t: 'p', r: [['See ', 0], ['chapter ', 0, at], ['three', 2, at], [', ', 0], ['Chemistry', 0, href], [' and ', 0], ['￼', 0, { src: 'zim/x.png', w: 10, h: 10, alt: 'icon', ...to }], ['volume 7', 0, to]] }], 3);
    const links = box.findAll((e) => e.tagName === 'A');
    assert.deepEqual(links.map((a) => [a.getAttribute('href'), a.textContent]), [['#tv-3-12', 'chapter three'], ['#', 'Chemistry'], ['#', 'volume 7']]);
    assert.equal(links[2].children[0].tagName, 'IMG', 'a picture in a link is part of it');
    for (const a of links) assert.equal(a.click().defaultPrevented, true);
    assert.deepEqual(followed.map((l) => [l.at, l.href, l.to]), [[at.at, undefined, undefined], [undefined, href.href, undefined], [undefined, undefined, to.to]], 'each followed as the 3D reader follows it');
  });

  it('says so when a part is empty, and reads runs as text', () => {
    assert.equal(render([]).html, '<p>(Nothing to read in this part.)</p>');
    assert.equal(runsText([['  The\nTitle ', 0], ['￼', 0, { src: 'x' }], ['!', 1]]), 'The Title !');
  });
});

describe('the text view: the reading position', () => {
  it('finds the block at the top of the view, one cut by the top edge counting', () => {
    const rects = [0, 1, 2, 3].map((b) => ({ b, top: b * 100, bottom: b * 100 + 90 }));
    assert.equal(topBlock(rects, 0), 0);
    assert.equal(topBlock(rects, 150), 1, 'block 1 cut by the edge');
    assert.equal(topBlock(rects, 195), 2, 'in the gap after block 1');
    assert.equal(topBlock(rects, 250), 2, 'block 2 cut by the edge');
    assert.equal(topBlock(rects, 999), 3, 'past the end: the last');
    assert.equal(topBlock([], 10), 0);
  });

  it('goes page → text view → page and lands on the same block', async () => {
    const p = (text) => ({ t: 'p', r: [[text, 0]] });
    const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 9}`).join(' ');
    const blocks = [{ t: 'h', l: 1, r: [['Part', 0]] }, ...Array.from({ length: 60 }, (_, i) => p(words(30 + (i % 4) * 25)))];
    const meta = { id: 'tv', title: 'Round trip', chunks: [{ start: 0, chars: 99999, blocks: blocks.length }], totalChars: 99999, toc: [] };
    globalThis.fetch = async (url) => {
      const m = /\/books\/([^/]+)(?:\/chunks\/(\d+))?$/.exec(url);
      const body = m[2] === undefined ? meta : { index: 0, blocks: structuredClone(blocks) };
      return { ok: true, json: async () => structuredClone(body) };
    };
    const r = new BookReader({ libId: 'lib', book: { id: 'tv', title: 'Round trip' }, layoutStepMs: 0 });
    await r.load();
    const L = await r._layout(0);
    await L.complete();
    assert.ok(L.pages.length > 5, 'a part of many pages');
    // The page where a block starts, as the 3D book shows it.
    const pageOf = (b) => L.pages.findLastIndex((pg) => pg.firstBlock < b || (pg.firstBlock === b && pg.firstLine === 0));
    for (let page = 0; page < L.pages.length; page++) {
      // Opening the view: scrolled to the page's first block, which is then at its top.
      const a = r.anchorOf({ c: 0, p: page });
      const rects = blocks.map((_, b) => ({ b, top: b * 100 - a.b * 100, bottom: b * 100 - a.b * 100 + 90 }));
      const top = topBlock(rects, 0);
      assert.equal(top, a.b);
      // Closing it: the 3D book opens at that block.
      const back = await r.refForAnchor({ c: 0, b: top });
      assert.equal(back.p, pageOf(a.b), `page ${page}: back on the page where block ${a.b} starts`);
      assert.ok(back.p <= page && page - back.p <= 1, `page ${page}: the same page, or the one before when the block began there`);
    }
  });
});

describe('the text view: its themes', () => {
  it('has the reader\'s paper, ink and link colours in each theme of common\'s shell, each its color-scheme', () => {
    const block = (sel) => {
      const i = TEXT_VIEW_CSS.indexOf(`${sel} {`);
      assert.ok(i >= 0, sel);
      return TEXT_VIEW_CSS.slice(i, TEXT_VIEW_CSS.indexOf('}', i));
    };
    const vars = (text) => Object.fromEntries([...text.matchAll(/--tv-(paper|ink|link): (#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const css = { paper: block('.tv-view'), sepia: block('.tv-view[data-theme="sepia"]'), night: block('.tv-view[data-theme="night"]') };
    for (const name of Object.keys(THEMES)) {
      assert.deepEqual(vars(css[name]), { paper: THEMES[name].paper, ink: THEMES[name].ink, link: THEMES[name].link }, name);
    }
    // The select, slider and scroll bar drawn for the paper: light on paper (and sepia, which keeps it), dark at night.
    assert.match(css.paper, /color-scheme: light/);
    assert.doesNotMatch(css.sepia, /color-scheme/);
    assert.match(css.night, /color-scheme: dark/);
  });

  it('leaves the themes to the shell: style.css sets none of their colours', () => {
    const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /--tv-(paper|ink|link|rule):/, 'a theme of its own would override common\'s');
  });
});
