// @ts-check
// Search (SPEC §5.6), shared by the DOM overlay and the kiosk's Search tab: books by title,
// subtitle and author across every library (in the client), Wikipedia articles by title prefix
// (on the server, which holds the millions of titles), and the full text of the libraries the
// server can search through kiwix-serve (`fulltext`).

import { searchArticles, searchText } from './api.js';

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
 * Whether findArticles asks for `q` at all: two letters or more, and a Wikipedia among the
 * libraries (the overlay's list waits for the articles only then).
 * @param {Array<{ kind?: string }>} libraries
 * @param {string} q
 */
export function asksArticles(libraries, q) {
  return fold(String(q ?? '').trim()).length >= 2 && libraries.some((l) => l.kind === 'wikipedia');
}

/**
 * Wikipedia articles whose titles start with `q`, from every Wikipedia library (failures give
 * no results rather than an error).
 * @returns {Promise<Array<{ article: { title, book, n }, lib }>>}
 */
export async function findArticles(libraries, q, perLibrary = 8) {
  if (!asksArticles(libraries, q)) return [];
  const s = String(q ?? '').trim();
  const wikis = libraries.filter((l) => l.kind === 'wikipedia');
  const found = await Promise.all(wikis.map((lib) => searchArticles(lib.id, s, perLibrary)
    .then((articles) => articles.map((article) => ({ article, lib })), () => [])));
  return found.flat();
}

/**
 * What a result is, the same for a result made anew (the catalogue changed and the books were
 * matched again, the articles asked again): its kind and library, then the book, the article
 * (and the name it was found by) or the hit's page.
 * @param {any} e an entry of matchBooks, findArticles or findInText
 * @returns {string}
 */
export function resultKey(e) {
  const lib = e.lib?.id ?? '';
  if (e.hit) return `t ${lib} ${e.hit.path ?? e.hit.title}`;
  if (e.article) return `a ${lib} ${e.article.title} ${e.article.from ?? ''}`;
  return `b ${lib} ${e.book?.id}`;
}

/**
 * The overlay's list of results: the books, then the others (the articles, then the text's
 * hits), with only the first 6 books once others have come, unless `held` (the result with the
 * focus or the highlight while the list is made again) is a later book: then all of them, so it
 * stays listed. `at` is where `held` is now, -1 for none; it is found by what it is (resultKey),
 * since a list made again for a changed catalogue holds new entries.
 * @template T
 * @param {T[]} books
 * @param {T[]} more
 * @param {T} [held]
 * @returns {{ results: T[], at: number }}
 */
export function listResults(books, more, held) {
  const key = held == null ? null : resultKey(held);
  const same = (/** @type {T} */ e) => e === held || (key !== null && resultKey(e) === key);
  const all = !more.length || books.findIndex(same) >= 6;
  const results = [...(all ? books : books.slice(0, 6)), ...more];
  return { results, at: results.findIndex(same) };
}

/**
 * Whether findInText asks for `q` at all: three letters or more, and a library with `fulltext`
 * among the libraries (the overlay's list waits for the hits only then).
 * @param {Array<{ fulltext?: boolean }>} libraries
 * @param {string} q
 */
export function asksText(libraries, q) {
  return fold(String(q ?? '').trim()).length >= 3 && libraries.some((l) => l.fulltext);
}

/**
 * Pages whose text holds the words of `q`, from every library with `fulltext` (the server's,
 * through kiwix-serve), in each library's order of relevance; failures give no results.
 * @returns {Promise<Array<{ hit: object, lib }>>}
 */
export async function findInText(libraries, q, perLibrary = 4) {
  if (!asksText(libraries, q)) return [];
  const s = String(q ?? '').trim();
  const searchable = libraries.filter((l) => l.fulltext);
  const found = await Promise.all(searchable.map((lib) => searchText(lib.id, s, perLibrary)
    .then((r) => r.results.map((hit) => ({ hit, lib })), () => [])));
  return found.flat();
}
