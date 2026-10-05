import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROOM_CAP, ALL_PLACE, placeBookCount, isFaceted, facetsOf, inRoom, defaultRoom, roomFor, roomLabel, sameRoom, normRoom, shelfCollections, collectionsFor,
  currentPlace, placeFor,
} from '../public/js/rooms.js';

const works = (n, genreOf) => Array.from({ length: n }, (_, i) => ({
  id: `w${i}`, title: `${String.fromCharCode(65 + (i % 26))}work ${i}`, author: 'X', genre: genreOf(i), libId: 'ws',
}));

describe('rooms', () => {
  const ws = { id: 'ws', kind: 'wikisource', title: 'Wikisource' };
  const pg = { id: 'pg', kind: 'gutenberg', title: 'Gutenberg' };
  const pgBooks = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: `Book ${i}`, rank: i + 1 }));

  it('knows which libraries are browsed by rooms', () => {
    assert.equal(isFaceted(ws, []), true);
    assert.equal(isFaceted(pg, pgBooks), false);
    assert.equal(isFaceted({ kind: 'generic' }, new Array(ROOM_CAP + 1).fill({})), true);
  });

  it('counts genres and letters; picks Novels first, else the largest genre that fits', () => {
    const books = works(100, (i) => (i < 60 ? 'Court decisions' : i < 90 ? 'Novels' : 'Poetry'));
    const f = facetsOf(books);
    assert.deepEqual(f.genres.map((g) => [g.name, g.count]), [['Court decisions', 60], ['Novels', 30], ['Poetry', 10]]);
    assert.equal(f.letters.reduce((n, l) => n + l.count, 0), 100);
    assert.deepEqual(defaultRoom(books), { genre: 'Novels', letter: null });
    assert.deepEqual(defaultRoom(works(5, () => 'Poetry')), { genre: 'Poetry', letter: null });
    assert.equal(defaultRoom([]), null);
  });

  it('finds the room of a book: its genre, narrowed to its letter when the genre is too big', () => {
    const books = works(ROOM_CAP + 50, (i) => (i < ROOM_CAP + 10 ? 'Other works' : 'Poetry'));
    assert.deepEqual(roomFor(books[ROOM_CAP + 20], books), { genre: 'Poetry', letter: null });
    const big = books[3]; // in the oversized genre
    const room = roomFor(big, books);
    assert.deepEqual(room, { genre: 'Other works', letter: 'D' });
    assert.ok(inRoom(big, room));
    assert.ok(books.filter((b) => inRoom(b, room)).length <= ROOM_CAP);
  });

  it('combines a genre and a letter, either, or neither', () => {
    const books = works(260, (i) => (i % 2 ? 'Poetry' : 'Novels')); // titles A…Z in turn
    const count = (room) => books.filter((b) => inRoom(b, room)).length;
    assert.equal(count({ genre: 'Poetry', letter: null }), 130);
    assert.equal(count({ genre: null, letter: 'A' }), 10);
    assert.equal(count({ genre: 'Poetry', letter: 'B' }), 10, 'B titles are all odd, so poems');
    assert.equal(count({ genre: 'Poetry', letter: 'A' }), 0, 'A titles are all even, so novels');
    assert.equal(count({ genre: null, letter: null }), 260);
    assert.equal(roomLabel({ genre: 'Poetry', letter: null }), 'Poetry');
    assert.equal(roomLabel({ genre: null, letter: 'A' }), 'Titles starting with A');
    assert.equal(roomLabel({ genre: 'Poetry', letter: 'B' }), 'Poetry, titles starting with B');
    assert.equal(roomLabel({ genre: null, letter: null }), 'All books');
    assert.ok(sameRoom({ genre: 'Poetry', letter: null }, { genre: 'Poetry' }));
    assert.ok(!sameRoom({ genre: 'Poetry', letter: 'B' }, { genre: 'Poetry', letter: null }));
    // Counts for the kiosk: each filter's count keeps the other filter.
    const f = facetsOf(books, { genre: 'Poetry', letter: 'B' });
    assert.deepEqual(f.genres.map((g) => [g.name, g.count, g.total]), [['Novels', 0, 130], ['Poetry', 10, 130]]);
    assert.equal(f.letters.find((l) => l.letter === 'A').count, 0);
    assert.equal(f.letters.find((l) => l.letter === 'B').count, 10);
  });

  it('reads rooms saved before the filters could be combined', () => {
    assert.deepEqual(normRoom({ type: 'genre', value: 'Poetry' }), { genre: 'Poetry', letter: null });
    assert.deepEqual(normRoom({ type: 'letter', value: 'Q' }), { genre: null, letter: 'Q' });
    assert.deepEqual(normRoom({ genre: 'Drama' }), { genre: 'Drama', letter: null });
    assert.equal(normRoom(undefined), null);
    const rooms = { ws: { type: 'letter', value: 'B' } };
    const col = shelfCollections([{ id: 'ws', kind: 'wikisource' }], { ws: works(52, () => 'Poetry') }, rooms, 'title')[0];
    assert.deepEqual(rooms.ws, { genre: null, letter: 'B' }, 'converted in place');
    assert.equal(col.books.length, 2);
  });

  it('shelves a whole large library, capped, when both filters are off', () => {
    const rooms = { ws: { genre: null, letter: null } };
    const col = shelfCollections([{ id: 'ws', kind: 'wikisource' }], { ws: works(ROOM_CAP + 7, () => 'Poetry') }, rooms, 'title')[0];
    assert.deepEqual(rooms.ws, { genre: null, letter: null }, 'not replaced by the default room');
    assert.equal(col.total, ROOM_CAP + 7);
    assert.equal(col.books.length, ROOM_CAP);
    assert.equal(col.capped, true);
  });

  it('shelves whole ordinary libraries and one capped, sorted room of faceted ones', () => {
    const books = works(ROOM_CAP + 500, (i) => (i % 2 ? 'Novels' : 'Other works'));
    const rooms = {};
    const cols = shelfCollections([pg, ws], { pg: pgBooks, ws: books }, rooms, 'title');
    assert.equal(cols[0].books.length, 10);
    assert.equal(cols[0].room, null);
    assert.deepEqual(rooms.ws, { genre: 'Novels', letter: null }, 'default room filled in');
    assert.ok(cols[1].books.every((b) => b.genre === 'Novels'));
    assert.equal(cols[1].total, Math.floor((ROOM_CAP + 500) / 2));
    assert.equal(cols[1].capped, false);
    // An oversized room is capped and sorted.
    rooms.ws = { genre: 'Other works', letter: null };
    const many = works(ROOM_CAP * 2, () => 'Other works');
    const c2 = shelfCollections([ws], { ws: many }, rooms, 'title')[0];
    assert.equal(c2.books.length, ROOM_CAP);
    assert.equal(c2.capped, true);
    // A room that no longer exists falls back to the default.
    rooms.ws = { genre: 'Gone', letter: null };
    const c3 = shelfCollections([ws], { ws: books }, rooms, 'title')[0];
    assert.deepEqual(rooms.ws, { genre: 'Novels', letter: null });
    assert.ok(c3.books.length > 0);
  });

  it('shelves only the current place: one library, or one room of a large one', () => {
    const books = { pg: pgBooks, ws: works(20, () => 'Poetry') };
    const settings = { sort: 'title' };
    // Default place: the first library that has books.
    let cols = collectionsFor([pg, ws], books, settings);
    assert.equal(cols.length, 1);
    assert.equal(cols[0].library.id, 'pg');
    assert.equal(cols[0].books.length, 10);
    assert.equal(cols[0].subtitle, undefined);
    assert.equal(settings.place, 'pg');
    settings.place = 'ws';
    cols = collectionsFor([pg, ws], books, settings);
    assert.deepEqual(cols.map((c) => c.library.id), ['ws']);
    assert.equal(cols[0].subtitle, 'Poetry · 20 works');
    assert.deepEqual(settings.rooms, { ws: { genre: 'Poetry', letter: null } });
    // A place that disappeared (rescan) falls back; an empty library is skipped.
    settings.place = 'gone';
    assert.equal(currentPlace([ws, pg], { pg: pgBooks, ws: [] }, settings).id, 'pg');
    assert.equal(settings.place, 'pg');
    assert.deepEqual(collectionsFor([], {}, { sort: 'title' }), []);
  });

  it('can shelve every library whole in one hall', () => {
    const wp = { id: 'wp', kind: 'wikipedia', title: 'Wikipedia', articles: 2500 };
    const volumes = [1, 2, 3].map((v) => ({ id: `v${v}`, title: `Range ${4 - v}`, volume: v }));
    const books = { pg: pgBooks, ws: works(ROOM_CAP + 10, () => 'Poetry'), wp: volumes, empty: [] };
    const empty = { id: 'empty', kind: 'generic', title: 'Still indexing' };
    const settings = { sort: 'title', place: ALL_PLACE.id };
    assert.equal(currentPlace([pg, ws, wp, empty], books, settings), ALL_PLACE);
    const cols = collectionsFor([pg, ws, wp, empty], books, settings);
    assert.deepEqual(cols.map((c) => [c.library.id, c.books.length, c.room, c.capped, c.ordered]),
      [['pg', 10, null, false, false], ['ws', ROOM_CAP + 10, null, false, false], ['wp', 3, null, false, true]]);
    assert.equal(cols[2].books, volumes, 'Wikipedia volumes keep their own order');
    assert.equal(cols[2].subtitle, '3 volumes · 2,500 articles');
    assert.equal(placeBookCount(ALL_PLACE, [pg, ws, wp, empty], books), ROOM_CAP + 23);
    assert.equal(placeBookCount(ws, [pg, ws], books), ROOM_CAP + 10);
    // With a single library there is no such place.
    assert.equal(currentPlace([pg], books, settings).id, 'pg');
    assert.equal(settings.place, 'pg');
  });

  it('knows where a book lives', () => {
    const wsBooks = works(20, () => 'Poetry');
    const books = { pg: pgBooks.map((b) => ({ ...b, libId: 'pg' })), ws: wsBooks };
    assert.deepEqual(placeFor(books.pg[0], [pg, ws], books), { libId: 'pg', room: null });
    assert.deepEqual(placeFor(wsBooks[3], [pg, ws], books), { libId: 'ws', room: { genre: 'Poetry', letter: null } });
    assert.equal(placeFor({ id: 'x', libId: 'nope' }, [pg, ws], books), null);
  });
});
