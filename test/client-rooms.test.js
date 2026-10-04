import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROOM_CAP, isFaceted, facetsOf, inRoom, defaultRoom, roomFor, roomLabel, shelfCollections, collectionsFor, currentPlace, placeFor,
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
    assert.deepEqual(defaultRoom(books), { type: 'genre', value: 'Novels' });
    assert.deepEqual(defaultRoom(works(5, () => 'Poetry')), { type: 'genre', value: 'Poetry' });
    assert.equal(defaultRoom([]), null);
  });

  it('finds the room of a book: its genre, or its letter when the genre is too big', () => {
    const books = works(ROOM_CAP + 50, (i) => (i < ROOM_CAP + 10 ? 'Other works' : 'Poetry'));
    assert.deepEqual(roomFor(books[ROOM_CAP + 20], books), { type: 'genre', value: 'Poetry' });
    const big = books[3]; // in the oversized genre
    const room = roomFor(big, books);
    assert.equal(room.type, 'letter');
    assert.ok(inRoom(big, room));
    assert.equal(roomLabel(room), `Titles starting with ${room.value}`);
    assert.equal(roomLabel({ type: 'genre', value: 'Poetry' }), 'Poetry');
  });

  it('shelves whole ordinary libraries and one capped, sorted room of faceted ones', () => {
    const books = works(ROOM_CAP + 500, (i) => (i % 2 ? 'Novels' : 'Other works'));
    const rooms = {};
    const cols = shelfCollections([pg, ws], { pg: pgBooks, ws: books }, rooms, 'title');
    assert.equal(cols[0].books.length, 10);
    assert.equal(cols[0].room, null);
    assert.deepEqual(rooms.ws, { type: 'genre', value: 'Novels' }, 'default room filled in');
    assert.ok(cols[1].books.every((b) => b.genre === 'Novels'));
    assert.equal(cols[1].total, Math.floor((ROOM_CAP + 500) / 2));
    assert.equal(cols[1].capped, false);
    // An oversized room is capped and sorted.
    rooms.ws = { type: 'genre', value: 'Other works' };
    const many = works(ROOM_CAP * 2, () => 'Other works');
    const c2 = shelfCollections([ws], { ws: many }, rooms, 'title')[0];
    assert.equal(c2.books.length, ROOM_CAP);
    assert.equal(c2.capped, true);
    // A room that no longer exists falls back to the default.
    rooms.ws = { type: 'genre', value: 'Gone' };
    const c3 = shelfCollections([ws], { ws: books }, rooms, 'title')[0];
    assert.deepEqual(rooms.ws, { type: 'genre', value: 'Novels' });
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
    assert.deepEqual(settings.rooms, { ws: { type: 'genre', value: 'Poetry' } });
    // A place that disappeared (rescan) falls back; an empty library is skipped.
    settings.place = 'gone';
    assert.equal(currentPlace([ws, pg], { pg: pgBooks, ws: [] }, settings).id, 'pg');
    assert.equal(settings.place, 'pg');
    assert.deepEqual(collectionsFor([], {}, { sort: 'title' }), []);
  });

  it('knows where a book lives', () => {
    const wsBooks = works(20, () => 'Poetry');
    const books = { pg: pgBooks.map((b) => ({ ...b, libId: 'pg' })), ws: wsBooks };
    assert.deepEqual(placeFor(books.pg[0], [pg, ws], books), { libId: 'pg', room: null });
    assert.deepEqual(placeFor(wsBooks[3], [pg, ws], books), { libId: 'ws', room: { type: 'genre', value: 'Poetry' } });
    assert.equal(placeFor({ id: 'x', libId: 'nope' }, [pg, ws], books), null);
  });
});
