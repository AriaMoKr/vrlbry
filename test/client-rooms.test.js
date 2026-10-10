import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { EXAMPLE_ZIM } from '../public/js/local/local.js';
import {
  ROOM_CAP, ALL_PLACE, DEMO_PLACE, DEMO_LIBRARIES, LOCAL_PLACE, groupPlaces, isDemoLibrary, isLocalLibrary, placeBookCount, isFaceted, facetsOf, inRoom, defaultRoom, roomFor, roomLabel, sameRoom, normRoom, shelfCollections, collectionsFor,
  genreLabel, LCC_NAMES, capNote, pagesOf,
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

  it('counts genres and letters; picks Novels first, else all the books (the most read first)', () => {
    const books = works(100, (i) => (i < 60 ? 'Court decisions' : i < 90 ? 'Novels' : 'Poetry'));
    const f = facetsOf(books);
    assert.deepEqual(f.genres.map((g) => [g.name, g.count]), [['Court decisions', 60], ['Novels', 30], ['Poetry', 10]]);
    assert.equal(f.letters.reduce((n, l) => n + l.count, 0), 100);
    assert.deepEqual(defaultRoom(books), { genre: 'Novels', letter: null });
    assert.deepEqual(defaultRoom(works(5, () => 'Poetry')), { genre: null, letter: null }, 'all the books, not the largest genre');
    // A big Gutenberg ZIM opened on class A (encyclopedias, periodicals), its largest genre under the cap.
    const gutenberg = works(ROOM_CAP * 2, (i) => (i < ROOM_CAP + 5 ? 'PS' : i < ROOM_CAP + 2900 ? 'A' : 'PR'));
    assert.deepEqual(defaultRoom(gutenberg), { genre: null, letter: null });
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
    // Gutenberg's genres are LCC classes, shown by name.
    assert.equal(roomLabel({ genre: 'PS', letter: null }), 'American literature');
    assert.equal(roomLabel({ genre: 'PZ', letter: 'B' }), "Fiction and children's books, titles starting with B");
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
    assert.equal(cols[0].subtitle, 'All books · 20 works', 'no Novels: all its books');
    assert.deepEqual(settings.rooms, { ws: { genre: null, letter: null } });
    // A place that disappeared (rescan) falls back; an empty library is skipped.
    settings.place = 'gone';
    assert.equal(currentPlace([ws, pg], { pg: pgBooks, ws: [] }, settings).id, 'pg');
    assert.equal(settings.place, 'pg');
    assert.deepEqual(collectionsFor([], {}, { sort: 'title' }), []);
  });

  it('falls back to the Demo set, when there is one, from a place that is not here', () => {
    // The main site's first visit with Golf saved as the place (by another site sharing the
    // origin, where the same ZIM has the same id): Golf is not open yet, so the Demo set.
    const demoP = { id: 'gutenberg_en_lcc-p_2026-03', kind: 'gutenberg', title: 'P' };
    const demoW = { id: 'wikipedia_en_100_2026-08', kind: 'wikipedia', title: 'W', articles: 100 };
    const books = { [demoP.id]: pgBooks, [demoW.id]: [{ id: 'v1', title: 'A', volume: 1 }] };
    const settings = { place: '~wikipedia_en_golf_maxi_2026-07', sort: 'title' };
    assert.equal(currentPlace([demoP, demoW], books, settings), DEMO_PLACE);
    assert.equal(settings.place, DEMO_PLACE.id);
    // Without a demo set: the first library with books, as before.
    const other = { place: 'gone', sort: 'title' };
    assert.equal(currentPlace([pg, ws], { pg: pgBooks, ws: [] }, other).id, 'pg');
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

  it('agrees with the GitHub Pages build on what the demo set is', () => {
    // tools/demo-set.txt is what the Pages workflow downloads; DEMO_LIBRARIES is what the Demo
    // set place shelves together. Each must name the other's ZIMs.
    // Each line: an address, then "file" when the site ships the ZIM itself (else pre-rendered).
    const lines = fs.readFileSync(new URL('../tools/demo-set.txt', import.meta.url), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
    assert.ok(lines.every((l) => l.length === 1 || (l.length === 2 && l[1] === 'file')), 'an address and "file", or the address alone');
    const urls = lines.map((l) => l[0]);
    const ids = urls.map((u) => u.split('/').pop().replace(/\.zim$/, ''));
    // The site's own ZIM files are opened in the browser: their ids start with '~'.
    for (const id of ids) assert.equal(isDemoLibrary({ id: `~${id}`, site: true }), true, `~${id}`);
    for (const id of ids) assert.equal(isDemoLibrary({ id }), true, `${id} is downloaded for the site but not in DEMO_LIBRARIES`);
    for (const name of DEMO_LIBRARIES) {
      assert.ok(ids.some((id) => isDemoLibrary({ id }) && id.startsWith(name)), `${name} is in DEMO_LIBRARIES but not in tools/demo-set.txt`);
    }
    // The example offered for opening in the browser is a demo-set ZIM: an address the workflow
    // keeps using (Kiwix replaces old dated files), and one the local library can open (Gutenberg).
    assert.ok(urls.includes(EXAMPLE_ZIM.url), `${EXAMPLE_ZIM.url} is not in tools/demo-set.txt`);
    assert.match(EXAMPLE_ZIM.url, /\/gutenberg_[^/]+\.zim$/);
  });

  it('has no all-libraries place where it would be the demo set again', () => {
    const demo = [
      { id: 'gutenberg_en_lcc-p_2026-03', kind: 'gutenberg', title: 'P' },
      { id: 'wikipedia_en_100_2026-08', kind: 'wikipedia', title: '100' },
    ];
    assert.deepEqual(groupPlaces(demo), [DEMO_PLACE]);
    const books = { [demo[0].id]: [{ id: 'b' }], [demo[1].id]: [{ id: 'v1' }] };
    const settings = { place: ALL_PLACE.id };
    assert.equal(currentPlace(demo, books, settings), DEMO_PLACE, 'a saved all-libraries place opens the demo set');
    assert.equal(settings.place, DEMO_PLACE.id);
    assert.deepEqual(groupPlaces([...demo, { id: 'mine', kind: 'generic', title: 'Mine' }]), [DEMO_PLACE, ALL_PLACE]);
  });

  it('shelves the libraries opened here together, once there are two', () => {
    const a = { id: '~gutenberg_en_lcc-p_2026-03', kind: 'gutenberg', title: 'P' };
    const b = { id: '~wikipedia_en_chemistry_mini_2026-07', kind: 'wikipedia', title: 'Chemistry', articles: 9254 };
    const server = { id: 'gutenberg_en_lcc-pe_2026-03', kind: 'gutenberg', title: 'PE' };
    assert.equal(isLocalLibrary(a), true);
    assert.equal(isLocalLibrary(server), false);
    assert.equal(isDemoLibrary(b), false, 'a file opened here is not the demo set, even with its name');
    // The site's own ZIM files (the main site ships part of its demo set as files) are.
    const siteFile = { ...b, site: true };
    assert.equal(isDemoLibrary(siteFile), true);
    assert.equal(isLocalLibrary(siteFile), false, 'not "Opened here"');
    assert.deepEqual(groupPlaces([a, siteFile]), [DEMO_PLACE, ALL_PLACE], 'the site file in the Demo set; one file opened here is no "Opened here"');
    assert.deepEqual(groupPlaces([a]), [], 'one file: its own room');
    assert.deepEqual(groupPlaces([a, b]), [LOCAL_PLACE], 'no all-libraries place: it would be the same');
    assert.deepEqual(groupPlaces([server, a, b]), [LOCAL_PLACE, ALL_PLACE]);
    const vols = [1, 2].map((v) => ({ id: 'v' + v, title: 'Range ' + (3 - v), volume: v }));
    const books = { [a.id]: pgBooks, [b.id]: vols, [server.id]: pgBooks };
    const settings = { sort: 'title', place: LOCAL_PLACE.id };
    assert.equal(currentPlace([server, a, b], books, settings), LOCAL_PLACE);
    const cols = collectionsFor([server, a, b], books, settings);
    assert.deepEqual(cols.map((c) => c.library.id), [a.id, b.id], 'both files, not the server\'s');
    // A saved all-libraries place, where every library was opened here, is this place.
    const all = { place: ALL_PLACE.id };
    assert.equal(currentPlace([a, b], books, all), LOCAL_PLACE);
    // Down to one file (the other closed): its room.
    const one = { place: LOCAL_PLACE.id };
    assert.equal(currentPlace([server, a], books, one).id, server.id, 'falls back as for a removed library');
  });

  it('shelves the demo set together when its libraries are here', () => {
    const demoPg = { id: 'gutenberg_en_lcc-p_2026-03', kind: 'gutenberg', title: 'Language and literature' };
    const demoWp = { id: 'wikipedia_en_mathematics_mini_2026-06', kind: 'wikipedia', title: 'Mathematics', articles: 23326 };
    const other = { id: 'gutenberg_en_lcc-pe_2026-03', kind: 'gutenberg', title: 'PE' };
    assert.equal(isDemoLibrary(demoPg), true);
    assert.equal(isDemoLibrary(other), false, 'lcc-pe is not lcc-p');
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_physics_mini_2026-07' }), true);
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_chemistry_mini_2026-07' }), true);
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_physics_nopic_2026-07' }), false, 'only the mini editions');
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_100_2026-08' }), true);
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_100_2027-01' }), true, 'a newer edition');
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_100_mini_2026-08' }), false, 'another flavour');
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_medicine_mini_2026-04' }), true);
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_golf_maxi_2026-07' }), true);
    assert.equal(isDemoLibrary({ id: 'wikipedia_en_golf_mini_2026-07' }), false, 'only the edition in the demo set');
    const vols = [1, 2].map((v) => ({ id: 'v' + v, title: 'Range ' + (3 - v), volume: v }));
    const books = { [demoPg.id]: pgBooks, [demoWp.id]: vols, [other.id]: pgBooks };
    const libs = [other, demoPg, demoWp];
    assert.deepEqual(groupPlaces(libs), [DEMO_PLACE, ALL_PLACE]);
    assert.deepEqual(groupPlaces([other]), [], 'no demo set without its ZIMs, no hall with one library');
    const settings = { sort: 'title', place: DEMO_PLACE.id };
    assert.equal(currentPlace(libs, books, settings), DEMO_PLACE);
    const cols = collectionsFor(libs, books, settings);
    assert.deepEqual(cols.map((c) => [c.library.id, c.books.length, c.ordered]), [[demoPg.id, 10, false], [demoWp.id, 2, true]]);
    assert.equal(cols[1].subtitle, '2 volumes · 23,326 articles');
    assert.equal(placeBookCount(DEMO_PLACE, libs, books), 12);
    // Without its ZIMs the place falls back to a library.
    const s2 = { sort: 'title', place: DEMO_PLACE.id };
    assert.equal(currentPlace([other], books, s2), other);
  });

  it('knows where a book lives', () => {
    const wsBooks = works(20, () => 'Poetry');
    const books = { pg: pgBooks.map((b) => ({ ...b, libId: 'pg' })), ws: wsBooks };
    assert.deepEqual(placeFor(books.pg[0], [pg, ws], books), { libId: 'pg', room: null });
    assert.deepEqual(placeFor(wsBooks[3], [pg, ws], books), { libId: 'ws', room: { genre: 'Poetry', letter: null } });
    assert.equal(placeFor({ id: 'x', libId: 'nope' }, [pg, ws], books), null);
  });
});

describe('rooms: Gutenberg genres by name', () => {
  it('names every LCC class English Gutenberg shelves by, each differently, and leaves other genres alone', () => {
    // gutenberg_en_all_2025-11's lcc_shelves.js
    const used = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'PA', 'PB', 'PC', 'PD', 'PE', 'PF', 'PG', 'PH',
      'PJ', 'PK', 'PL', 'PM', 'PN', 'PQ', 'PR', 'PS', 'PT', 'PZ', 'Q', 'R', 'S', 'T', 'U', 'V', 'Z'];
    for (const code of used) assert.ok(LCC_NAMES[code], code);
    const names = used.map(genreLabel);
    assert.equal(new Set(names).size, used.length, 'no two alike (E and F are both "History of the Americas" at Kiwix)');
    assert.equal(genreLabel('PR'), 'English literature');
    assert.equal(genreLabel('Novels'), 'Novels', 'a Wikisource genre as it is');
    assert.equal(genreLabel('Other works'), 'Other works');
  });
});

describe('rooms: a capped Gutenberg room shelves its most read books', () => {
  // Two and a half rooms of Gutenberg books (25,000 with the cap at 10,000), half of them American
  // literature: ranked by popularity in reverse title order, so that the first by title are the
  // least read.
  const N = 2 * ROOM_CAP + ROOM_CAP / 2;
  const fmt = (n) => n.toLocaleString();
  const titleOf = (i) => `T${String(i).padStart(5, '0')}`;
  const pgBig = Array.from({ length: N }, (_, i) => ({ id: `g${i}`, title: titleOf(i), author: 'X', shelf: i % 2 ? 'PS' : 'PR', rank: N - i, libId: 'big' }));
  const big = { id: 'big', kind: 'gutenberg', title: 'Gutenberg · every book (EN)' };

  it('in the chosen order, the most read of the room (all books, or a capped genre)', () => {
    const [all] = shelfCollections([big], { big: pgBig }, { big: { genre: null, letter: null } }, 'title');
    assert.equal(all.total, N);
    assert.equal(all.capped, true);
    assert.equal(all.books.length, ROOM_CAP);
    assert.ok(all.books.every((b) => b.rank <= ROOM_CAP), 'the most read');
    assert.deepEqual(all.books.map((b) => b.title), [...all.books.map((b) => b.title)].sort(), 'in title order');
    const [ps] = shelfCollections([big], { big: pgBig }, { big: { genre: 'PS', letter: null } }, 'title');
    assert.equal(ps.total, N / 2);
    const psRanks = pgBig.filter((b) => b.shelf === 'PS').map((b) => b.rank).sort((a, b) => a - b);
    assert.ok(ps.books.every((b) => b.shelf === 'PS' && b.rank <= psRanks[ROOM_CAP - 1]), 'the most read of the genre');
    // By popularity: the same books, in that order.
    const [pop] = shelfCollections([big], { big: pgBig }, { big: { genre: null, letter: null } }, 'popularity');
    assert.deepEqual(new Set(pop.books), new Set(all.books));
    assert.equal(pop.books[0].rank, 1);
  });

  it('elsewhere the first in the shelf order, and the note says which', () => {
    const generic = { id: 'gen', kind: 'generic', title: 'Generic' };
    const genBooks = pgBig.map((b) => ({ ...b, libId: 'gen' }));
    const [g] = shelfCollections([generic], { gen: genBooks }, { gen: { genre: null, letter: null } }, 'title');
    assert.deepEqual(g.books.map((b) => b.title), genBooks.map((b) => b.title).sort().slice(0, ROOM_CAP), 'its rank is no popularity');
    assert.equal(capNote(big, N), ` (the ${fmt(ROOM_CAP)} most read)`);
    assert.equal(capNote(generic, N), ` (first ${fmt(ROOM_CAP)})`);
    assert.equal(capNote(big, ROOM_CAP), '');
  });

  it('shelves a room a page at a time: the next most read, and so on', () => {
    const shelve = (room, sort = 'title') => {
      const rooms = { big: room };
      const [c] = shelfCollections([big], { big: pgBig }, rooms, sort);
      return { ...c, saved: rooms.big };
    };
    assert.equal(pagesOf(N), 3);
    const pages = [0, 1, 2].map((page) => shelve({ genre: null, letter: null, ...(page ? { page } : {}) }));
    assert.deepEqual(pages.map((c) => [c.page, c.pages, c.books.length]), [[0, 3, ROOM_CAP], [1, 3, ROOM_CAP], [2, 3, N - 2 * ROOM_CAP]]);
    for (const [i, c] of pages.entries()) {
      const ranks = c.books.map((b) => b.rank);
      assert.ok(Math.min(...ranks) === i * ROOM_CAP + 1 && Math.max(...ranks) === Math.min(N, (i + 1) * ROOM_CAP), `page ${i}: ranks ${i * ROOM_CAP + 1}-`);
      assert.deepEqual(c.books.map((b) => b.title), [...c.books.map((b) => b.title)].sort(), 'in title order');
    }
    assert.equal(new Set(pages.flatMap((c) => c.books)).size, N, 'every book on one page');
    // Past the last page (the room shrank): its last, and saved so.
    const past = shelve({ genre: 'PS', letter: null, page: 5 });
    assert.equal(past.page, 1);
    assert.deepEqual(past.saved, { genre: 'PS', letter: null, page: 1 });
    // By popularity: the same bands, in that order.
    assert.deepEqual(shelve({ genre: null, letter: null, page: 1 }, 'popularity').books.map((b) => b.rank), Array.from({ length: ROOM_CAP }, (_, i) => ROOM_CAP + i + 1));
    // The note says which page.
    assert.equal(capNote(big, N, 1), ` (most read ${fmt(ROOM_CAP + 1)}–${fmt(2 * ROOM_CAP)})`);
    assert.equal(capNote(big, N, 2), ` (most read ${fmt(2 * ROOM_CAP + 1)}–${fmt(N)})`, 'the last page, partly full');
    assert.equal(capNote({ kind: 'generic' }, N, 1), ` (${fmt(ROOM_CAP + 1)}–${fmt(2 * ROOM_CAP)})`);
    assert.equal(collectionsFor([big], { big: pgBig }, { place: 'big', sort: 'title', rooms: { big: { genre: null, letter: null, page: 2 } } })[0].subtitle,
      `All books · ${fmt(N)} works (most read ${fmt(2 * ROOM_CAP + 1)}–${fmt(N)})`);
  });

  it('keeps a page only past the first, and tells rooms apart by it', () => {
    assert.deepEqual(normRoom({ genre: 'PS', letter: null, page: 0 }), { genre: 'PS', letter: null });
    assert.deepEqual(normRoom({ genre: 'PS', letter: null, page: 2 }), { genre: 'PS', letter: null, page: 2 });
    assert.deepEqual(normRoom({ genre: 'PS', page: -1 }), { genre: 'PS', letter: null });
    assert.equal(sameRoom({ genre: 'PS', letter: null }, { genre: 'PS', letter: null, page: 1 }), false);
    assert.equal(sameRoom({ genre: 'PS', letter: null, page: 0 }, { genre: 'PS', letter: null }), true);
  });
});
