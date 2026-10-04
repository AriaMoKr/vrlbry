import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  packBookcases, rangeLabel, USABLE, bookcasesNeeded, prefixForBookcases, shareBookcases,
} from '../public/js/world/shelves.js';
import { BOOKCASE } from '../public/js/config.js';
import { sortBooks } from '../public/js/util/books.js';

const make = (n) => Array.from({ length: n }, (_, i) => ({
  id: String(1000 + i), title: `Book ${String.fromCharCode(65 + (i % 26))}${i}`, author: `Author ${i % 37}`,
  rank: i + 1, size: 20000 + ((i * 7919) % 3_000_000), libId: 'lib',
}));

describe('capping a room at a number of bookcases', () => {
  it('knows how many bookcases packing will use', () => {
    for (const n of [0, 1, 90, 258, 3000, 9000]) {
      const books = sortBooks(make(n), 'title');
      assert.equal(bookcasesNeeded(books), packBookcases(books).length, `${n} books`);
    }
  });

  it('takes the longest prefix that fits a number of bookcases', () => {
    const books = sortBooks(make(9000), 'title');
    for (const q of [1, 3, 10, 40]) {
      const prefix = prefixForBookcases(books, q);
      assert.ok(prefix.length > 0 && prefix.length < books.length);
      assert.ok(packBookcases(prefix).length <= q, `fits ${q}`);
      assert.ok(bookcasesNeeded(books.slice(0, prefix.length + 1)) > q || prefix.length === books.length, 'one more would not');
      assert.deepEqual(prefix, books.slice(0, prefix.length), 'a prefix, in order');
    }
    assert.equal(prefixForBookcases(books, bookcasesNeeded(books)).length, books.length, 'enough room: all of it');
  });

  it('shares bookcases fairly: small libraries whole, the rest split evenly', () => {
    // The five libraries of the measured all-libraries hall.
    assert.deepEqual(shareBookcases([490, 3, 13, 26, 153], 200), [79, 3, 13, 26, 79]);
    assert.deepEqual(shareBookcases([10, 20], 200), [10, 20], 'everything fits');
    assert.deepEqual(shareBookcases([100, 100, 100], 200), [67, 67, 66]);
    assert.deepEqual(shareBookcases([0, 500], 200), [0, 200]);
    assert.deepEqual(shareBookcases([5, 5, 5], 2), [1, 1, 0], 'fewer bookcases than libraries');
    assert.deepEqual(shareBookcases([], 200), []);
  });
});

describe('shelf packing', () => {
  for (const n of [0, 1, 7, 258, 3000]) {
    it(`places each of ${n} books exactly once, inside the shelves`, () => {
      const books = sortBooks(make(n), 'title');
      const cases = packBookcases(books);
      const placed = cases.flatMap((c) => c.items.map((it) => it.book.id));
      assert.deepEqual(placed, books.map((b) => b.id), 'order preserved, nothing lost or duplicated');
      for (const c of cases) {
        assert.ok(c.items.length > 0, 'no empty bookcase');
        for (const it of c.items) {
          assert.ok(it.row >= 0 && it.row < BOOKCASE.shelves);
          assert.ok(it.x - it.dims.w / 2 >= -USABLE / 2 - 1e-9 && it.x + it.dims.w / 2 <= USABLE / 2 + 1e-9, 'inside the usable width');
        }
        // Books in a row do not overlap and go left to right.
        const rows = new Map();
        for (const it of c.items) rows.set(it.row, [...(rows.get(it.row) || []), it]);
        for (const row of rows.values()) {
          for (let i = 1; i < row.length; i++) {
            assert.ok(row[i].x - row[i].dims.w / 2 >= row[i - 1].x + row[i - 1].dims.w / 2 - 1e-9);
          }
        }
      }
    });
  }

  it('fills bookcases evenly (no nearly-empty last bookcase)', () => {
    const cases = packBookcases(sortBooks(make(258), 'title'));
    const counts = cases.map((c) => c.items.length);
    assert.ok(Math.min(...counts) >= Math.max(...counts) * 0.7, `even fill: ${counts}`);
  });

  it('is deterministic', () => {
    const a = packBookcases(make(300)).map((c) => c.items.map((i) => `${i.book.id}@${i.row}:${i.x.toFixed(6)}`).join());
    const b = packBookcases(make(300)).map((c) => c.items.map((i) => `${i.book.id}@${i.row}:${i.x.toFixed(6)}`).join());
    assert.deepEqual(a, b);
  });

  it('labels ranges per sort mode', () => {
    const items = [
      { book: { title: 'The Abbey', author: 'Jane Austen', rank: 4 } },
      { book: { title: 'Chronicles', author: 'Various', rank: 99 } },
    ];
    assert.equal(rangeLabel(items, 'title'), 'Ab – Ch');
    assert.equal(rangeLabel(items, 'author'), 'Aus – Vari');
    assert.equal(rangeLabel(items, 'popularity'), '#4 – #99');
    assert.equal(rangeLabel([], 'title'), '');
  });
});
