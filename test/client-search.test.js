// Search (public/js/search.js), shared by the overlay and the kiosk: books in the client,
// Wikipedia articles from the server (fetch is faked).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold, bookIndex, matchBooks, findArticles } from '../public/js/search.js';

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
    assert.deepEqual(asked, ['/api/libraries/wp/articles?q=Paris&limit=5', '/api/libraries/wp2/articles?q=Paris&limit=5']);
    assert.deepEqual(found.map((e) => [e.lib.id, e.article.title]), [['wp', 'Paris'], ['wp2', 'Paris']]);
    assert.deepEqual(await findArticles(libraries, 'p'), [], 'at least two letters');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await findArticles(libraries, 'paris'), []);
  });
});
