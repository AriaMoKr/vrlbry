// @ts-check
// Spreads (SPEC §5.6): what the open book shows, { left, right }, each a page (PageRef), 'ex'
// (the ex-libris endpaper before the first page), 'blank' or null (no page after the last). Two
// pages: pages paired by their number, odd ones on the right, turned two at a time. One page (the
// single-page view): the page on the right, turned one at a time; its left is 'ex' before the
// first page, else 'blank', and is not shown (the book's left half is hidden, Book3D.single).
// Pure: the reader (reader.js BookReader) is asked for neighbouring pages and page numbers.

/** Below this width-to-height ratio a flat screen gets the single-page view by default (portrait). */
export const SINGLE_BELOW_ASPECT = 1;

/** Whether `ref` is a page (not the endpaper, a blank or nothing). */
export const isPage = (ref) => !!ref && typeof ref === 'object';

/** The book's first page. */
const isFirst = (ref) => (ref.c | 0) <= 0 && (ref.p | 0) <= 0;

/**
 * Whether the single-page view is used. `setting` (settings.pageView): 'single', 'spread' or
 * 'auto': one page on a flat screen taller than wide (a phone upright, a narrow window), where a
 * spread would be small; two in a headset and on wider screens.
 */
export function singlePage(setting, { presenting = false, aspect = 1 } = {}) {
  if (setting === 'single') return true;
  if (setting === 'spread') return false;
  return !presenting && aspect < SINGLE_BELOW_ASPECT;
}

/**
 * Where the single-page view puts the page on a flat screen (the camera level): as near as the
 * page's width allows and the page with its toolbar under it still fit the height, the toolbar
 * scaled down to the screen's width (it is wider than a page), the two centred between a margin
 * at the top and a strip at the foot (the help button's corner). Lengths in metres, the page's
 * with a margin; `vt`: tan(half the vertical field of view); `toolbarW`: the toolbar's width,
 * `toolbarDrop`: how far its foot is below the page's at full size; `top` and `foot`: fractions
 * of the screen's half-height.
 * @returns {{ dist: number, drop: number, toolbar: number }} the distance; how far below the eyes
 *   the page's centre is (negative: above); the toolbar's scale
 */
export function fitOnePage({ pageW, pageH, vt, aspect, toolbarW, toolbarDrop, top = 0.03, foot = 0.18 }) {
  const byWidth = pageW / 2 / (vt * aspect);
  const toolbarAt = (d) => Math.min(1, (0.96 * d * vt * aspect) / (toolbarW / 2));
  let dist = byWidth;
  // Farther shows more width, so a larger toolbar, so a taller block: a few rounds settle it.
  for (let i = 0; i < 4; i++) dist = Math.max(byWidth, (pageH + toolbarDrop * toolbarAt(dist)) / ((2 - top - foot) * vt));
  const toolbar = toolbarAt(dist);
  const h = dist * vt;
  // The block's middle sits halfway between the margins; the page's centre is above the block's.
  return { dist, drop: -(((foot - top) * h) / 2 + (toolbarDrop * toolbar) / 2), toolbar };
}

/** The setting that gives `single` where `auto` (what 'auto' gives here) is the default: 'auto' when they agree. */
export const pageViewSetting = (single, auto) => (single === auto ? 'auto' : single ? 'single' : 'spread');

/** The single-page view's spread of page `ref`. */
const one = (ref) => ({ left: isFirst(ref) ? 'ex' : 'blank', right: ref });

/**
 * The spread that shows page `ref`. One page: on the right. Two: on `side` ('left' / 'right', as
 * when a debug report or a link trail was made), or as its page number pairs it (odd on the right).
 * @param {import('./reader.js').BookReader} reader
 */
export async function spreadAt(reader, ref, { single = false, side = null } = {}) {
  if (single) return one(ref);
  if (side === 'left') return { left: ref, right: await reader.next(ref) };
  if (side === 'right' || reader.pageNumber(ref).n % 2 === 1) return { left: (await reader.prev(ref)) || 'ex', right: ref };
  return { left: ref, right: await reader.next(ref) };
}

/** The spread after `s`, or null at the end. */
export async function nextSpread(reader, s, { single = false } = {}) {
  if (single) {
    const n = isPage(s.right) ? await reader.next(s.right) : null;
    return n ? one(n) : null;
  }
  const base = s.right || (isPage(s.left) ? s.left : null);
  if (!base) return null;
  const l = await reader.next(base);
  if (!l) return null;
  return { left: l, right: await reader.next(l) };
}

/** The spread before `s`, or null at the start. */
export async function prevSpread(reader, s, { single = false } = {}) {
  if (single) {
    const p = isPage(s.right) ? await reader.prev(s.right) : null;
    return p ? one(p) : null;
  }
  if (!isPage(s.left)) return null;
  const rr = await reader.prev(s.left);
  if (!rr) return { left: 'ex', right: s.left };
  return { left: (await reader.prev(rr)) || 'ex', right: rr };
}

/** The page being read: the left one of two, else the right (the single-page view's, the first page's). */
export const currentRef = (s) => (!s ? null : isPage(s.left) ? s.left : s.right);

/** The side of the page being read. */
export const currentSide = (s) => (isPage(s?.left) ? 'left' : 'right');

export function sameRef(a, b) {
  if (a === b) return true;
  if (!isPage(a) || !isPage(b)) return false;
  return a.c === b.c && a.p === b.p;
}

export const sameSpread = (a, b) => !!a && !!b && sameRef(a.left, b.left) && sameRef(a.right, b.right);
