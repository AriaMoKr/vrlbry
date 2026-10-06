// Canvas-texture panels (public/js/ui/panel.js) in Node, with a stub canvas: dragging a list's
// scroll bar (press on the thumb or the track, drag, release).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: () => () => ({ width: 0 }) }) }),
};
const { Panel } = await import('../public/js/ui/panel.js');

/** The kiosk's shape: 1000 × 1000 px, a list of 30 rows of which 10 show. */
function kiosk() {
  const p = new Panel({ width: 1, height: 1, pxPerMeter: 1000 });
  const items = Array.from({ length: 30 }, (_, i) => ({ label: `Place ${i}` }));
  const list = p.add({ id: 'places', type: 'list', x: 36, y: 208, w: 928, h: 580, rowH: 58, items, scroll: 0 });
  return { p, list };
}
/** uv of a panel pixel (panels hit-test by uv, y up). */
const at = (p, x, y) => ({ x: x / p.w, y: 1 - y / p.h });

describe('panel lists: dragging the scroll bar', () => {
  it('drags the thumb, also beyond the track, and releases', () => {
    const { p, list } = kiosk();
    const sb = p._scrollBar(list);
    assert.equal(sb.max, 20);
    const barX = sb.x + sb.barW / 2;
    assert.equal(p.pressAt(at(p, barX, sb.thumbY + 5)), true, 'on the thumb');
    assert.equal(p.dragging, true);
    p.dragTo(at(p, barX, sb.trackY + sb.trackH / 2 + 5)); // the thumb's top to the middle (as grabbed)
    assert.ok(Math.abs(list.scroll - Math.round(((sb.trackH / 2) / (sb.trackH - sb.thumbH)) * 20)) <= 1, String(list.scroll));
    p.dragTo(at(p, barX, 5000));
    assert.equal(list.scroll, 20, 'past the end: the last rows');
    p.dragTo(at(p, 2000, -500)); // off the panel altogether
    assert.equal(list.scroll, 0, 'past the start: the first rows');
    assert.equal(p.release(), true);
    assert.equal(p.dragging, false);
    assert.equal(p.release(), false);
  });

  it('pages towards a press on the track beside the thumb, then drags from there', () => {
    const { p, list } = kiosk();
    const sb = p._scrollBar(list);
    assert.equal(p.pressAt(at(p, sb.x + 20, sb.trackY + sb.trackH - 4)), true);
    assert.equal(list.scroll, 9, 'one page (the visible rows less one)');
    assert.equal(p.dragging, true);
  });

  it('leaves rows, the arrows and lists that fit to clicks', () => {
    const { p, list } = kiosk();
    assert.equal(p.pressAt(at(p, 300, 300)), false, 'a row');
    assert.equal(p.pressAt(at(p, list.x + list.w - 20, list.y + 10)), false, 'the ▲ button');
    const short = p.add({ id: 'short', type: 'list', x: 36, y: 820, w: 928, h: 116, rowH: 58, items: [{ label: 'a' }] });
    assert.equal(p._scrollBar(short), null);
    assert.equal(p.pressAt(at(p, short.x + short.w - 20, short.y + 50)), false, 'nothing to scroll');
  });

  it('keeps dragging when the panel is refilled with the same list', () => {
    const { p } = kiosk();
    const sb = p._scrollBar(p.get('places'));
    p.pressAt(at(p, sb.x + 20, sb.thumbY + 5));
    p.clear();
    const fresh = p.add({ id: 'places', type: 'list', x: 36, y: 208, w: 928, h: 580, rowH: 58, items: Array.from({ length: 30 }, () => ({ label: 'x' })), scroll: 0 });
    p.dragTo(at(p, sb.x + 20, 5000));
    assert.equal(fresh.scroll, 20);
  });
});
