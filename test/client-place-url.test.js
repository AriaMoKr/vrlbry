// The address naming the place and room shown (public/js/place-url.js).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeFromSearch, placeHref } from '../public/js/place-url.js';

const LIBS = [
  { id: 'gutenberg_en_all_2023-08' },
  { id: 'wikisource_en_all_maxi_2026-09' },
  { id: 'wikipedia_en_100_2026-08' },
  { id: 'wikipedia_en_100_2026-09' },
  { id: '~wikipedia_en_physics_mini_2026-10' },
];

describe('the address names the place and room', () => {
  it('writes the place, and a room\'s filters and page, keeping the other parameters', () => {
    const page = 'https://ariamokr.github.io/vrlbry/?back=https%3A%2F%2Fexample.org%2F&xr=emulate';
    assert.equal(placeHref(page, 'demo'), `${page}&place=demo`);
    const room = new URL(placeHref(page, 'wikisource_en_all_maxi_2026-09', { genre: 'Science fiction', letter: 'A', page: 2 }));
    assert.equal(room.origin + room.pathname, 'https://ariamokr.github.io/vrlbry/');
    assert.deepEqual([...room.searchParams], [
      ['back', 'https://example.org/'], ['xr', 'emulate'], ['place', 'wikisource_en_all_maxi_2026-09'],
      ['genre', 'Science fiction'], ['letter', 'A'], ['page', '3'],
    ]);
    // Another room replaces the last one's parameters; a whole library has none.
    const whole = placeHref(room.href, 'gutenberg_en_all_2023-08', { genre: null, letter: null });
    assert.equal(whole, `${page}&place=gutenberg_en_all_2023-08`);
    assert.equal(placeHref(whole, '*'), `${page}&place=*`);
    assert.equal(placeHref(whole, null), page);
    assert.equal(placeHref('http://localhost:8080/', '~wikipedia_en_physics_mini_2026-10'), 'http://localhost:8080/?place=%7Ewikipedia_en_physics_mini_2026-10');
  });

  it('reads them back: what it wrote is what it reads', () => {
    for (const [place, room] of [
      ['wikisource_en_all_maxi_2026-09', { genre: 'Science fiction', letter: 'A', page: 2 }],
      ['gutenberg_en_all_2023-08', { genre: 'PR', letter: null }],
      ['gutenberg_en_all_2023-08', { genre: null, letter: '#' }],
      ['~wikipedia_en_physics_mini_2026-10', { genre: null, letter: null }],
    ]) {
      const { search } = new URL(placeHref('http://localhost:8080/?perf', place, room));
      assert.deepEqual(placeFromSearch(search, LIBS), { place, room }, search);
    }
    for (const group of ['demo', 'local', '*']) assert.deepEqual(placeFromSearch(`?place=${group}&genre=PR`, LIBS), { place: group, room: null });
  });

  it('finds a library of another edition by its name, the newest here', () => {
    assert.equal(placeFromSearch('?place=wikipedia_en_100_2026-11', LIBS).place, 'wikipedia_en_100_2026-09');
    assert.equal(placeFromSearch('?place=wikipedia_en_100', LIBS).place, 'wikipedia_en_100_2026-09');
    assert.equal(placeFromSearch('?place=wikipedia_en_100_2026-08', LIBS).place, 'wikipedia_en_100_2026-08');
  });

  it('names nothing when the address names no place here', () => {
    for (const search of ['', '?back=https%3A%2F%2Fexample.org%2F', '?place=', '?place=wikipedia_en_physics_mini_2026-10', '?place=nothing']) {
      assert.equal(placeFromSearch(search, LIBS), null, search);
    }
    assert.deepEqual(placeFromSearch('?place=gutenberg_en_all_2023-08&page=0', LIBS).room, { genre: null, letter: null }, 'page 1 at the least');
  });
});
