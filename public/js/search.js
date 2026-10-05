// Search (SPEC §5.6), shared by the DOM overlay and the kiosk's Search tab: books by title,
// subtitle and author across every library (in the client), and Wikipedia articles by title
// prefix (on the server, which holds the millions of titles).

import { searchArticles } from './api.js';

/** Lower case without accents, so "eclair" finds "Éclair". */
export function fold(s) {
  s = String(s ?? '');
  // Only non-ASCII text needs the (slower) normalization: 80,000 titles are folded at startup.
  if (/[^\x00-\x7f]/.test(s)) s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return s.toLowerCase();
}

const indexes = new WeakMap(); // booksByLib -> { libraries, index }

/**
 * The searchable form of every book (cached per catalogue, so the overlay and the kiosk share
 * one).
 * @returns {Array<{ book, lib, hay: string, title: string }>}
 */
export function bookIndex(libraries, booksByLib) {
  const hit = indexes.get(booksByLib);
  if (hit && hit.libraries === libraries) return hit.index;
  const index = [];
  for (const lib of libraries) {
    for (const book of booksByLib[lib.id] || []) {
      index.push({ book, lib, hay: fold(`${book.title} ${book.subtitle || ''} ${book.author || ''}`), title: fold(book.title) });
    }
  }
  indexes.set(booksByLib, { libraries, index });
  return index;
}

/**
 * Books matching every word of `q`: the title itself first, then titles starting with it as a
 * whole word ("Paris as It Was" before "Parish"), then titles starting or containing it, then
 * the rest; more popular books first among equals.
 * @returns {Array<{ book, lib }>}
 */
export function matchBooks(index, q, limit = 12) {
  const s = fold(q).trim().replace(/\s+/g, ' ');
  if (!s) return [];
  const terms = s.split(' ');
  const scored = [];
  for (const e of index) {
    if (!terms.every((t) => e.hay.includes(t))) continue;
    let score = 0;
    if (e.title === s) score += 200;
    else if (e.title.startsWith(s)) score += /[\p{L}\p{N}]/u.test(e.title.charAt(s.length)) ? 100 : 120;
    else if (e.title.includes(s)) score += 40;
    score -= (e.book.rank || 0) / 1e4;
    scored.push([score, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, e]) => e);
}

/**
 * Wikipedia articles whose titles start with `q`, from every Wikipedia library (failures give
 * no results rather than an error).
 * @returns {Promise<Array<{ article: { title, book, n }, lib }>>}
 */
export async function findArticles(libraries, q, perLibrary = 8) {
  const s = String(q ?? '').trim();
  if (fold(s).length < 2) return [];
  const wikis = libraries.filter((l) => l.kind === 'wikipedia');
  const found = await Promise.all(wikis.map((lib) => searchArticles(lib.id, s, perLibrary)
    .then((articles) => articles.map((article) => ({ article, lib })), () => [])));
  return found.flat();
}
