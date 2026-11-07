// Search (public/js/search.js), shared by the overlay and the kiosk: books in the client,
// Wikipedia articles and full-text hits from the server (fetch is faked).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold, bookIndex, matchBooks, asksArticles, findArticles, listResults, asksText, findInText } from '../public/js/search.js';

const pg = { id: 'pg', kind: 'gutenberg', title: 'Gutenberg' };
const wp = { id: 'wp', kind: 'wikipedia', title: 'Wikipedia' };
const ws = { id: 'ws', kind: 'wikisource', title: 'Wikisource' };
const book = (id, title, author, rank) => ({ id, title, author, rank });
const booksByLib = {
  pg: [
    book('1', 'Paris as It Was', 'Blagdon', 50),
    book('2', 'Notre-Dame de Paris', 'Victor Hugo', 5),
    book('3', 'Éclairs of Wit', 'Anon', 90),
    book('4', 'A Tale of Two Cities', 'Charles Dickens', 1),
  ],
  ws: [book('w1', 'Parish v. Murphree', 'John McLean', null)],
  wp: [book('v1', 'Aa – Zz', 'Wikipedia', 1)],
};
const libraries = [pg, ws, wp];

describe('search', () => {
  it('folds case and accents', () => {
    assert.equal(fold('Éclair Crème'), 'eclair creme');
    assert.equal(fold('ABC'), 'abc');
    assert.equal(fold(null), '');
  });

  it('matches every word, titles starting with the query first, popular first', () => {
    const index = bookIndex(libraries, booksByLib);
    assert.equal(bookIndex(libraries, booksByLib), index, 'one index per catalogue');
    assert.deepEqual(matchBooks(index, 'paris').map((e) => e.book.id), ['1', 'w1', '2']);
    assert.deepEqual(matchBooks(index, 'hugo paris').map((e) => e.book.id), ['2'], 'authors too, any word order');
    assert.deepEqual(matchBooks(index, 'eclair').map((e) => e.book.id), ['3'], 'without accents');
    assert.deepEqual(matchBooks(index, '  ').map((e) => e.book.id), []);
    assert.equal(matchBooks(index, 'a', 2).length, 2);
    assert.equal(matchBooks(index, 'paris')[1].lib, ws);
  });

  it('asks every Wikipedia library for articles, and survives failures', async () => {
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ library: 'wp', articles: [{ title: 'Paris', book: 'v706', n: 432 }] }) };
    };
    const found = await findArticles([...libraries, { ...wp, id: 'wp2' }], 'Paris ', 5);
    // Relative to the site root (js/api.js's parent), so the app also works under a path (GitHub Pages).
    assert.deepEqual(asked.map((u) => u.slice(u.indexOf('/api/'))), ['/api/libraries/wp/articles?q=Paris&limit=5', '/api/libraries/wp2/articles?q=Paris&limit=5']);
    assert.ok(asked.every((u) => u.includes('/public/api/')), asked[0]);
    assert.deepEqual(found.map((e) => [e.lib.id, e.article.title]), [['wp', 'Paris'], ['wp2', 'Paris']]);
    assert.deepEqual(await findArticles(libraries, 'p'), [], 'at least two letters');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await findArticles(libraries, 'paris'), []);
  });

  it('says when it asks for articles at all (the overlay waits for them only then)', async () => {
    assert.equal(asksArticles(libraries, 'pa'), true);
    assert.equal(asksArticles(libraries, ' p '), false, 'one letter');
    assert.equal(asksArticles(libraries, 'É'), false, 'one letter, folded');
    assert.equal(asksArticles([pg, ws], 'paris'), false, 'no Wikipedia');
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ articles: [] }) };
    };
    for (const [libs, q] of [[libraries, 'p'], [[pg, ws], 'paris'], [libraries, 'pa']]) {
      await findArticles(libs, q);
      assert.equal(asked.length > 0, asksArticles(libs, q), `${q}: asked as it says`);
      asked.length = 0;
    }
  });

  it('lists 6 books before the articles, all of them while a later one is held, and finds the held result', () => {
    const books = Array.from({ length: 12 }, (_, i) => ({ book: book(`b${i}`, `Book ${i}`) }));
    const articles = Array.from({ length: 8 }, (_, i) => ({ article: { title: `Article ${i}` } }));
    const ids = ({ results }) => results.map((e) => e.book?.id ?? e.article.title);
    assert.deepEqual(listResults(books, []), { results: books, at: -1 }, 'no articles: every book');
    const shown = listResults(books, articles);
    assert.deepEqual(ids(shown), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', ...articles.map((e) => e.article.title)]);
    assert.equal(shown.at, -1, 'nothing held');
    assert.equal(listResults(books, articles, books[2]).at, 2, 'a book among the first 6 stays where it was');
    const far = listResults(books, articles, books[8]);
    assert.deepEqual(ids(far).slice(0, 13), [...books.map((e) => e.book.id), 'Article 0'], 'a later book held: every book, then the articles');
    assert.equal(far.at, 8, 'the same book');
    assert.equal(listResults(books, articles, articles[3]).at, 9, 'an article held: found where it is now');
    assert.equal(listResults(books, [], books[11]).at, 11);
    assert.deepEqual(listResults(books, articles, { book: book('b2', 'Book 2') }), shown, 'another object is not held');
    assert.deepEqual(listResults([], articles, articles[0]), { results: articles, at: 0 });
    assert.deepEqual(listResults([], []), { results: [], at: -1 });
  });

  it('asks the libraries with full text for hits from three letters, as asksText says, and survives failures', async () => {
    const searchable = [{ ...pg, fulltext: true }, ws, wp];
    assert.equal(asksText(searchable, 'whale'), true);
    assert.equal(asksText(searchable, ' wh '), false, 'two letters');
    assert.equal(asksText(libraries, 'whale'), false, 'no library with full text');
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ total: 1, results: [{ title: 'Moby-Dick', snippet: [['whale', true]] }] }) };
    };
    for (const [libs, q] of [[searchable, 'wh'], [libraries, 'whale'], [searchable, 'whale ']]) {
      const found = await findInText(libs, q);
      assert.equal(asked.length > 0, asksText(libs, q), `${q}: asked as it says`);
      assert.equal(found.length > 0, asksText(libs, q), `${q}: hits only when asked`);
      asked.length = 0;
    }
    await findInText(searchable, 'whale ', 3);
    assert.deepEqual(asked.map((u) => u.slice(u.indexOf('/api/'))), ['/api/libraries/pg/text?q=whale&limit=3'], 'only the library with full text');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await findInText(searchable, 'whale'), []);
  });
});
