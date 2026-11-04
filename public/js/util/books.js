// @ts-check
// Shared, deterministic helpers about books: sorting, letters, physical dimensions, hashing.
// Used by both the world (shelf layout) and the interaction layer (A–Z jump), so they must agree.

import { BOOK } from '../config.js';

const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a 32-bit, continued over the string's UTF-16 units from hash h. */
function fnv(h, s) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}

/** FNV-1a 32-bit hash of a string -> unsigned int. */
export function hashString(s) {
  return fnv(FNV_OFFSET, s) >>> 0;
}

/**
 * Deterministic pseudo-random in [0,1) from a string + salt: the hash of salt + "\0" + s, without
 * making that string (room builds hash every book several times; the strings were garbage).
 */
export function hash01(s, salt = '') {
  return (fnv(Math.imul(fnv(FNV_OFFSET, salt), 0x01000193), s) >>> 0) / 4294967296;
}

/** hash01(a + "|" + b, salt), without making the string. */
function hash01Of(a, b, salt) {
  const h = Math.imul(fnv(Math.imul(fnv(FNV_OFFSET, salt), 0x01000193), a) ^ 124, 0x01000193);
  return (fnv(h, b) >>> 0) / 4294967296;
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
// kept on the book under a non-enumerable symbol: JSON, structuredClone and spreading skip it
// (books get serialized and copied). A WeakMap held them before, an entry per book (80,000 with
// a 60,000-book library open), and every full garbage collection on a Quest worked through those
// entries inside its pause (ephemeron marking: 5-8 ms of 15-28 ms). Recomputed if a title or
// author changes.
const KEYS = Symbol('vrlbry.sortKeys');

/** A book's cached sort keys: { t: titleKey, a: authorKey (made when first wanted: authorOf), id, book }. */
function keysOf(book) {
  let k = book[KEYS];
  if (!k || k.title !== book.title || k.author !== book.author) {
    k = { title: book.title, author: book.author, t: titleKey(book.title), a: null, id: String(book.id), book };
    try {
      Object.defineProperty(book, KEYS, { value: k, writable: true, configurable: true });
    } catch { /* a frozen book: its keys are made each time */ }
  }
  return k;
}

/** The author key of keysOf's keys: only sorting or lettering by author needs it. */
const authorOf = (k) => (k.a ??= authorKey(k.author));

// The same order as String#localeCompare without arguments, without its per-call setup.
const collator = new Intl.Collator();

function compareKeys(mode) {
  const byTitle = (x, y) => collator.compare(x.t, y.t) || collator.compare(x.id, y.id);
  if (mode === 'author') return (x, y) => collator.compare(authorOf(x), authorOf(y)) || byTitle(x, y);
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
  const key = mode === 'author' ? authorOf(k) : k.t;
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
  const id = String(book.id);
  const title = book.title || '';
  const h = BOOK.minH + (BOOK.maxH - BOOK.minH) * hash01Of(id, title, 'h');
  return { w: thickness(book, hash01Of(id, title, 't')), h, d: h * BOOK.depthRatio };
}

/**
 * bookDims(book).w alone, making nothing: a room build sums every book's thickness (the whole
 * library, to count its bookcases). Not cached: a cache entry per book of a 60,000-book library
 * made the full garbage collections, which also walk them, longer on a Quest.
 */
export function bookWidth(book) {
  if (book.volume) return BOOK.volume.w;
  return thickness(book, hash01Of(String(book.id), book.title || '', 't'));
}

/** Spine thickness: grows with the logarithm of the byte size when known, else from the hash r. */
function thickness(book, r) {
  if (book.size && book.size > 0) {
    // ~20 KB -> min thickness, ~20 MB -> max thickness.
    const f = Math.min(1, Math.max(0, (Math.log10(book.size) - 4.3) / 3));
    return BOOK.minT + (BOOK.maxT - BOOK.minT) * (0.85 * f + 0.15 * r);
  }
  return BOOK.minT + (BOOK.maxT - BOOK.minT) * (0.2 + 0.5 * r);
}
