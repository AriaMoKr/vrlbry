// Shared, deterministic helpers about books: sorting, letters, physical dimensions, hashing.
// Used by both the world (shelf layout) and the interaction layer (A–Z jump), so they must agree.

import { BOOK } from '../config.js';

/** FNV-1a 32-bit hash of a string -> unsigned int. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random in [0,1) from a string + salt. */
export function hash01(s, salt = '') {
  return hashString(salt + '\u0000' + s) / 4294967296;
}

const LEADING_ARTICLE = /^(the|a|an)\s+/i;
const STRIP = /^[^\p{L}\p{N}]+/u;

/** Normalized key for title sorting: drops leading articles and punctuation, case-folds. */
export function titleKey(title) {
  return (title || '').replace(STRIP, '').replace(LEADING_ARTICLE, '').replace(STRIP, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Author sort key, "Last, First" style: Gutenberg gives "First Middle Last" (sometimes with
 * parenthesised expansions, e.g. "J. R. Clark (John R. Clark) Hall"), so use the final word.
 */
export function authorKey(author) {
  const a = (author || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a) return '￿';
  if (/^(various|anonymous|unknown)$/i.test(a)) return 'zzzz ' + a.toLowerCase();
  const parts = a.split(' ');
  const last = parts.pop();
  return (last + ' ' + parts.join(' ')).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const SORT_MODES = ['title', 'author', 'popularity'];

// Sort keys cost regexes and Unicode normalization, and a sort needs ~2·n·log n of them (a
// 60,000-book library took 2 s to sort on a Quest), so each book's keys are computed once and
// kept here, off the book objects (which get serialized). Recomputed if a title/author changes.
const keyCache = new WeakMap();

/** A book's cached sort keys: { t: titleKey, a: authorKey, id, book }. */
function keysOf(book) {
  let k = keyCache.get(book);
  if (!k || k.title !== book.title || k.author !== book.author) {
    k = { title: book.title, author: book.author, t: titleKey(book.title), a: authorKey(book.author), id: String(book.id), book };
    keyCache.set(book, k);
  }
  return k;
}

// The same order as String#localeCompare without arguments, without its per-call setup.
const collator = new Intl.Collator();

function compareKeys(mode) {
  const byTitle = (x, y) => collator.compare(x.t, y.t) || collator.compare(x.id, y.id);
  if (mode === 'author') return (x, y) => collator.compare(x.a, y.a) || byTitle(x, y);
  if (mode === 'popularity') return (x, y) => (x.book.rank ?? 1e9) - (y.book.rank ?? 1e9) || byTitle(x, y);
  return byTitle;
}

/** Comparator for a sort mode. Ties are broken by title then id so order is total and stable. */
export function compareBooks(mode) {
  const cmp = compareKeys(mode);
  return (a, b) => cmp(keysOf(a), keysOf(b));
}

// Sorted copies of whole book lists, per list and mode: a library is sorted once, and its rooms
// are filtered from that order instead of being sorted again on every room switch.
const sortedCache = new WeakMap();

/** Returns a new array sorted by mode (cached per input array, which must not be mutated). */
export function sortBooks(books, mode) {
  let byMode = sortedCache.get(books);
  if (!byMode) sortedCache.set(books, (byMode = new Map()));
  let hit = byMode.get(mode);
  if (!hit || hit.length !== books.length) {
    hit = books.map(keysOf).sort(compareKeys(mode)).map((k) => k.book);
    byMode.set(mode, hit);
  }
  return hit.slice();
}

/**
 * Index letter of a book under a sort mode ('A'..'Z' or '#'), used for shelf range labels and
 * the A–Z jump. Popularity mode has no letters (returns null).
 */
export function letterOf(book, mode) {
  if (mode === 'popularity') return null;
  const k = keysOf(book);
  const key = mode === 'author' ? k.a : k.t;
  const c = key.charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** True when titles are in title order (as sortBooks sorts by title), e.g. a Wikipedia volume's contents. */
export function inTitleOrder(titles) {
  for (let i = 1; i < titles.length; i++) {
    if (collator.compare(titleKey(titles[i - 1]), titleKey(titles[i])) > 0) return false;
  }
  return true;
}

/**
 * A dictionary-style thumb index over titles in title order: `stops` evenly spaced entries, each
 * labelled with the shortest start of its title key (at most 4 letters) that tells it from the
 * stops on either side. A Wikipedia volume runs e.g. "Kad", "Kae", "Kaf", "Kal", where letters
 * alone would all read "K".
 * @returns {Array<{ index: number, label: string }>}
 */
export function thumbIndex(titles, stops) {
  const n = titles.length;
  const count = Math.min(stops, n);
  const at = Array.from({ length: count }, (_, k) => Math.floor((k * n) / count));
  const keys = at.map((i) => titleKey(titles[i]) || (titles[i] || '').toLowerCase());
  // Letters needed to tell a from b: up to and including their first difference.
  const needed = (a, b) => {
    if (b === undefined) return 1;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i + 1;
  };
  return at.map((index, k) => {
    const key = keys[k];
    const len = Math.max(1, Math.min(4, key.length, Math.max(needed(key, keys[k - 1]), needed(key, keys[k + 1]))));
    const label = key.slice(0, len);
    return { index, label: label.charAt(0).toUpperCase() + label.slice(1) };
  });
}

/**
 * Physical size of a book in metres: { w: spine thickness (x), h: height (y), d: depth (z) }.
 * Thickness grows with the logarithm of the book's byte size when known, else is hash-derived.
 */
export function bookDims(book) {
  if (book.volume) return { w: BOOK.volume.w, h: BOOK.volume.h, d: BOOK.volume.h * BOOK.depthRatio };
  const key = String(book.id) + '|' + (book.title || '');
  const r1 = hash01(key, 'h');
  const r2 = hash01(key, 't');
  const h = BOOK.minH + (BOOK.maxH - BOOK.minH) * r1;
  let t;
  if (book.size && book.size > 0) {
    // ~20 KB -> min thickness, ~20 MB -> max thickness.
    const f = Math.min(1, Math.max(0, (Math.log10(book.size) - 4.3) / 3));
    t = BOOK.minT + (BOOK.maxT - BOOK.minT) * (0.85 * f + 0.15 * r2);
  } else {
    t = BOOK.minT + (BOOK.maxT - BOOK.minT) * (0.2 + 0.5 * r2);
  }
  return { w: t, h, d: h * BOOK.depthRatio };
}
