// The card's lists drawn again with the keyboard's focus kept (public/js/ui/keep-focus.js, SPEC
// §5.6): the libraries with every catalogue, the status box's index builds once a second. Drawn in
// place, an item still listed keeps its elements, so its focused × keeps the focus without the
// focus moving (a screen reader is told nothing again); when its item goes, the × now in its place
// has it, else what the page names; a focus the pointer gave is let go, as before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { focusDocument } from './helpers/focus-dom.js';
import { keepFocus, drawInPlace, shown } from '../public/js/ui/keep-focus.js';

/** The card's libraries as overlay.js draws them: a × for each opened here, a total line. */
const libsHtml = (libs) => libs.map((l) => `
  <div class="ov-lib" data-key="lib ${l.id}">
    ${l.img ? `<img data-img="${l.img}" data-local-src="${l.img}" alt="" width="40" height="40">` : ''}
    <div class="ov-lib-body"><div class="ov-lib-title">${l.title ?? l.id}</div>
    <div class="ov-lib-meta">${l.meta ?? '12 books'}</div></div>
    <button class="ov-lib-close" data-id="${l.id}" aria-label="Close ${l.title ?? l.id}">×</button>
  </div>`).join('') + (libs.length > 1 ? `<div class="ov-lib-meta" data-key="total">${libs.length} libraries</div>` : '');

/** The status box's rows as overlay.js draws them. */
const rowsHtml = (rows) => rows.map((r) => `<li class="" data-key="${r.id}">
  <div class="ov-status-row"><span class="ov-status-title">${r.id}</span><span class="ov-status-line">${r.line ?? 'starting'}</span>
    <button class="ov-status-cancel" data-id="${r.id}" aria-label="Stop and close ${r.id}">×</button></div>
  <div class="ov-toast-bar"><div style="width:${r.pct ?? 0}%"></div></div></li>`).join('');

/** A page with the card's list and, under it, a way to open another file. */
function card() {
  const doc = focusDocument();
  doc.body.innerHTML = '<section class="ov-card"><div class="ov-libs"></div><div class="ov-open"><button class="ov-open-btn">Open ZIM files…</button></div></section>';
  return { doc, list: doc.body.querySelector('.ov-libs'), open: doc.body.querySelector('.ov-open-btn') };
}

const ids = (list) => list.querySelectorAll('.ov-lib-close').map((b) => b.dataset.id);
const x = (list, id) => list.querySelectorAll('.ov-lib-close').find((b) => b.dataset.id === id);
const lib = (id, more = {}) => ({ id, ...more });

/** The list drawn again as setLibraries does: the focus kept, else `rest`. */
function redraw(list, libs, rest = () => null) {
  const refocus = keepFocus(list, '.ov-lib-close');
  drawInPlace(list, libsHtml(libs));
  refocus(rest);
}

describe('drawInPlace', () => {
  it('keeps the elements of the items still listed, changing only what changed', () => {
    const { list } = card();
    drawInPlace(list, libsHtml([lib('a'), lib('b'), lib('c')]));
    const bClose = x(list, 'b');
    const bMeta = bClose.parentNode.querySelector('.ov-lib-meta');
    drawInPlace(list, libsHtml([lib('a'), lib('b', { meta: 'indexing… 40%' }), lib('c')]));
    assert.equal(x(list, 'b'), bClose, 'the same ×');
    assert.equal(bClose.parentNode.querySelector('.ov-lib-meta'), bMeta, 'the same line');
    assert.equal(bMeta.textContent, 'indexing… 40%');
    assert.deepEqual(ids(list), ['a', 'b', 'c']);
    assert.equal(list.querySelector('[data-key]') && list.children.at(-1).textContent, '3 libraries');
  });

  it('takes out the items gone and puts new ones in their place, in order', () => {
    const { list } = card();
    drawInPlace(list, libsHtml([lib('a'), lib('b'), lib('c')]));
    const [a, b, c] = ['a', 'b', 'c'].map((id) => x(list, id));
    drawInPlace(list, libsHtml([lib('a'), lib('c'), lib('d')]));
    assert.deepEqual(ids(list), ['a', 'c', 'd']);
    assert.equal(x(list, 'a'), a);
    assert.equal(x(list, 'c'), c);
    assert.equal(b.isConnected, false);
    drawInPlace(list, libsHtml([lib('z'), lib('a'), lib('c'), lib('d')]));
    assert.deepEqual(ids(list), ['z', 'a', 'c', 'd']);
    assert.equal(x(list, 'a'), a, 'kept when one comes before it');
    drawInPlace(list, libsHtml([lib('a')]));
    assert.deepEqual(ids(list), ['a']);
    assert.equal(list.children.length, 1, 'the total line gone with the others');
    drawInPlace(list, '<div class="ov-lib-desc" data-key="none">No books yet.</div>');
    assert.equal(list.textContent, 'No books yet.');
  });

  it('moves a kept item only when the order changed', () => {
    const { list } = card();
    drawInPlace(list, libsHtml([lib('a'), lib('b'), lib('c')]));
    const [a, b, c] = ['a', 'b', 'c'].map((id) => x(list, id));
    drawInPlace(list, libsHtml([lib('c'), lib('a'), lib('b')]));
    assert.deepEqual(ids(list), ['c', 'a', 'b']);
    assert.deepEqual(['a', 'b', 'c'].map((id) => x(list, id)), [a, b, c]);
  });

  it('keeps a picture once loaded (its src a blob URL) while it is the same one (data-img); another is made anew', () => {
    const { list } = card();
    drawInPlace(list, libsHtml([lib('a', { img: '/zim/~a/I/icon.png' })]));
    const img = list.querySelector('img');
    img.removeAttribute('data-local-src'); // as fillLocalImages does, the picture then loaded
    img.setAttribute('src', 'blob:1');
    drawInPlace(list, libsHtml([lib('a', { img: '/zim/~a/I/icon.png', meta: '13 books' })]));
    assert.equal(list.querySelector('img'), img);
    assert.equal(img.getAttribute('src'), 'blob:1');
    assert.equal(img.hasAttribute('data-local-src'), false, 'not loaded again');
    drawInPlace(list, libsHtml([lib('a', { img: '/zim/~a/I/other.png' })]));
    assert.notEqual(list.querySelector('img'), img);
    assert.equal(list.querySelector('img').getAttribute('data-local-src'), '/zim/~a/I/other.png');
  });
});

describe('keepFocus', () => {
  it('a × with the keyboard\'s focus keeps it through a redraw, the focus never moved', () => {
    const { doc, list } = card();
    redraw(list, [lib('a'), lib('b'), lib('c')]);
    const b = x(list, 'b');
    b.focus();
    const moves = doc.focusMoves;
    redraw(list, [lib('a'), lib('b', { meta: 'indexing… 50%' }), lib('c')]); // its details alone
    redraw(list, [lib('a'), lib('b'), lib('c')]);
    assert.equal(doc.activeElement, b);
    assert.equal(doc.focusMoves, moves, 'nothing to tell a screen reader again');
  });

  it('its library closed: the × now in its place has it, after the last the one before, with none left what the page gives', () => {
    const { doc, list, open } = card();
    redraw(list, [lib('a'), lib('b'), lib('c')]);
    x(list, 'b').focus();
    redraw(list, [lib('a'), lib('c')], () => open);
    assert.equal(doc.activeElement, x(list, 'c'), 'the next');
    redraw(list, [lib('a')], () => open);
    assert.equal(doc.activeElement, x(list, 'a'), 'the one before the last');
    redraw(list, [], () => open);
    assert.equal(doc.activeElement, open, 'near: the page\'s choice');
    assert.notEqual(doc.activeElement, doc.body);
  });

  it('a library added before it, or the list in another order: still on its ×', () => {
    const { doc, list } = card();
    redraw(list, [lib('a'), lib('b')]);
    const b = x(list, 'b');
    b.focus();
    redraw(list, [lib('new'), lib('a'), lib('b')]);
    assert.equal(doc.activeElement, b);
    redraw(list, [lib('b'), lib('new'), lib('a')]); // b moved: the focus lost, and given back
    assert.equal(doc.activeElement, b);
  });

  it('a focus the pointer gave is let go, as before: no other × takes it', () => {
    const { doc, list, open } = card();
    redraw(list, [lib('a'), lib('b'), lib('c')]);
    doc.keyboard = false; // a click
    x(list, 'b').focus();
    redraw(list, [lib('a'), lib('c')], () => open);
    assert.equal(doc.activeElement, doc.body);
  });

  it('a focus elsewhere is left where it is', () => {
    const { doc, list, open } = card();
    redraw(list, [lib('a'), lib('b')]);
    open.focus();
    redraw(list, [lib('a')], () => x(list, 'a'));
    assert.equal(doc.activeElement, open);
  });

  it('the status box: a row\'s × keeps the focus through the seconds; its row gone, the next; the rows gone, the head\'s buttons, then near', () => {
    const { doc, open } = card();
    const box = doc.createElement('section');
    box.innerHTML = `<div class="ov-status-head"><span class="ov-status-text"></span><button class="ov-status-stop" hidden>Stop</button>
      <button class="ov-status-toggle">▾</button></div><ul class="ov-status-rows"></ul>`;
    doc.body.appendChild(box);
    const rows = box.querySelector('.ov-status-rows');
    const toggle = box.querySelector('.ov-status-toggle');
    const stop = box.querySelector('.ov-status-stop');
    const sel = '.ov-status-stop:not(:disabled), .ov-status-toggle, .ov-status-cancel';
    // As overlay._renderStatus: the focus taken note of, the box drawn (Stop disabled once pressed), then kept.
    const render = (list, { stopping = false } = {}) => {
      const refocus = keepFocus(box, sel);
      stop.disabled = stopping;
      rows.hidden = !list.length;
      toggle.hidden = !list.length;
      if (!rows.hidden) drawInPlace(rows, rowsHtml(list));
      refocus(() => open);
    };
    render([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    const w2 = rows.querySelectorAll('.ov-status-cancel')[1];
    w2.focus();
    const moves = doc.focusMoves;
    for (let s = 1; s <= 5; s++) render([{ id: 'w1', line: 'waiting' }, { id: 'w2', line: `${s} s · estimating…`, pct: s * 3 }, { id: 'w3', line: 'waiting' }]);
    assert.equal(doc.activeElement, w2, 'the same × every second');
    assert.equal(doc.focusMoves, moves);
    assert.equal(w2.parentNode.querySelector('.ov-status-line').textContent, '5 s · estimating…');
    render([{ id: 'w1' }, { id: 'w3' }]);
    assert.equal(doc.activeElement.dataset.id, 'w3', 'its row gone: the next');
    render([{ id: 'w1' }]);
    assert.equal(doc.activeElement.dataset.id, 'w1');
    stop.hidden = false; // files opening meanwhile: Stop shows
    render([]);
    assert.equal(doc.activeElement, stop, 'the rows gone: the head\'s button left');
    render([], { stopping: true }); // pressed: "Stopping…", disabled
    assert.equal(doc.activeElement, open, 'Stop pressed and nothing else in the box: near');
  });

  it('Stop pressed while rows show: the next control, the toggle, has the focus', () => {
    const { doc, open } = card();
    const box = doc.createElement('section');
    box.innerHTML = '<button class="ov-status-stop">Stop</button><button class="ov-status-toggle">▾</button><ul class="ov-status-rows"></ul>';
    doc.body.appendChild(box);
    drawInPlace(box.querySelector('.ov-status-rows'), rowsHtml([{ id: 'w1' }]));
    const stop = box.querySelector('.ov-status-stop');
    stop.focus();
    const refocus = keepFocus(box, '.ov-status-stop:not(:disabled), .ov-status-toggle, .ov-status-cancel');
    stop.disabled = true;
    refocus(() => open);
    assert.equal(doc.activeElement, box.querySelector('.ov-status-toggle'));
  });

  it('the rows hidden with the focus in them: the toggle has it', () => {
    const { doc, open } = card();
    const box = doc.createElement('section');
    box.innerHTML = '<button class="ov-status-toggle">▾</button><ul class="ov-status-rows"></ul>';
    doc.body.appendChild(box);
    const rows = box.querySelector('.ov-status-rows');
    drawInPlace(rows, rowsHtml([{ id: 'w1' }, { id: 'w2' }]));
    rows.querySelectorAll('.ov-status-cancel')[1].focus();
    const refocus = keepFocus(box, '.ov-status-toggle, .ov-status-cancel');
    rows.hidden = true;
    refocus(() => open);
    assert.equal(doc.activeElement, box.querySelector('.ov-status-toggle'));
  });

  it('a state in the selector: the libraries\' list that no longer takes the focus ([tabindex]) hands it on', () => {
    const { doc, list, open } = card();
    list.setAttribute('tabindex', '0');
    list.focus();
    const refocus = keepFocus(doc.body.querySelector('.ov-card'), '.ov-libs[tabindex]');
    list.removeAttribute('tabindex');
    refocus(() => open);
    assert.equal(doc.activeElement, open);
  });

  it('shown: in the page and not hidden, nor inside something hidden', () => {
    const { doc, list, open } = card();
    assert.equal(shown(open), true);
    list.parentNode.hidden = true;
    assert.equal(shown(open), false);
    assert.equal(shown(doc.createElement('button')), false, 'not in the page');
    assert.equal(shown(null), false);
  });
});
