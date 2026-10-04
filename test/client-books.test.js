import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  titleKey, authorKey, compareBooks, sortBooks, letterOf, bookDims, hashString,
} from '../public/js/util/books.js';
import { BOOK } from '../public/js/config.js';

const books = [
  { id: '1', title: 'The Elements of Style', author: 'William Strunk', rank: 3 },
  { id: '2', title: 'A Book About Words', author: 'G. F. (George Frederick) Graham', rank: 50 },
  { id: '3', title: "'Round the Year in Myth and Song", author: 'Florence Holbrook', rank: 9 },
  { id: '4', title: 'Webster’s Unabridged Dictionary', author: 'Various', rank: 1 },
  { id: '5', title: '1001 Questions and Answers', author: 'B. A. Hathaway', rank: 20 },
  { id: '6', title: 'Écrire et parler', author: 'Émile Zola', rank: 2 },
];

describe('util/books', () => {
  it('titleKey drops leading articles and punctuation, folds case and accents', () => {
    assert.equal(titleKey('The Elements of Style'), 'elements of style');
    assert.equal(titleKey('A Book About Words'), 'book about words');
    assert.equal(titleKey("'Round the Year"), 'round the year');
    assert.equal(titleKey('Écrire'), 'ecrire');
    assert.equal(titleKey(''), '');
  });

  it('authorKey sorts by surname, ignores parenthesised expansions, puts Various last', () => {
    assert.equal(authorKey('William Strunk'), 'strunk william');
    assert.equal(authorKey('G. F. (George Frederick) Graham'), 'graham g. f.');
    assert.ok(authorKey('Various') > authorKey('Émile Zola'));
    assert.equal(authorKey(''), '￿');
  });

  it('sort modes are total, stable and do not mutate the input', () => {
    const copy = books.slice();
    const byTitle = sortBooks(books, 'title').map((b) => b.id);
    assert.deepEqual(books, copy);
    assert.deepEqual(byTitle, ['5', '2', '6', '1', '3', '4']);
    assert.deepEqual(sortBooks(books, 'popularity').map((b) => b.id), ['4', '6', '1', '3', '5', '2']);
    assert.deepEqual(sortBooks(books, 'author').map((b) => b.id), ['2', '5', '3', '1', '6', '4']);
    // Ties broken by title then id.
    const tie = [{ id: 'b', title: 'Same', rank: 1 }, { id: 'a', title: 'Same', rank: 1 }];
    assert.deepEqual(tie.sort(compareBooks('popularity')).map((b) => b.id), ['a', 'b']);
  });

  it('letterOf gives A–Z, # for digits/other, null for popularity', () => {
    assert.equal(letterOf(books[0], 'title'), 'E');
    assert.equal(letterOf(books[4], 'title'), '#');
    assert.equal(letterOf(books[5], 'title'), 'E');
    assert.equal(letterOf(books[0], 'author'), 'S');
    assert.equal(letterOf(books[0], 'popularity'), null);
  });

  it('bookDims is deterministic and within the configured ranges', () => {
    for (const b of [...books, { id: 'x', title: 'Big', size: 30e6 }, { id: 'y', title: 'Small', size: 1000 }]) {
      const d1 = bookDims(b);
      const d2 = bookDims({ ...b });
      assert.deepEqual(d1, d2);
      assert.ok(d1.h >= BOOK.minH && d1.h <= BOOK.maxH);
      assert.ok(d1.w >= BOOK.minT && d1.w <= BOOK.maxT);
      assert.ok(Math.abs(d1.d - d1.h * BOOK.depthRatio) < 1e-12);
    }
    assert.ok(bookDims({ id: 'a', title: 't', size: 20e6 }).w > bookDims({ id: 'a', title: 't', size: 30e3 }).w);
  });

  it('hashString is FNV-1a', () => {
    assert.equal(hashString(''), 0x811c9dc5);
    assert.equal(hashString('a'), 0xe40c292c);
  });
});
