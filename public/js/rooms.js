// Rooms: the library hall shows one collection at a time. Each library is its own room (its
// "place"); very large libraries (Wikisource) are browsed through filters instead — a genre, a
// title letter, both ("Poetry starting with A") or neither — because 18,000 works are far too many
// to draw on a Quest. The visitor picks them at the kiosk. Pure helpers shared by main.js and
// interaction.js.
//
// A room of a large library is `{ genre: string|null, letter: string|null }`.

import { letterOf, sortBooks } from './util/books.js';

/** Most books a room shelves at once (~26 bookcases). */
export const ROOM_CAP = 3000;
/**
 * The place that shelves every library whole in one hall — no filters, no cap (an experiment:
 * ~18,000 books is ~160 bookcases, past the Quest's comfortable draw-call budget).
 */
export const ALL_PLACE = { id: '*', title: 'All libraries', kind: 'all' };
/**
 * The demo set (see TODO: a small set for a version without a server): its libraries shelved
 * together, like ALL_PLACE. Libraries are matched by their id (the file name) without its date, so
 * a newer edition of a demo ZIM still belongs to it, but another flavour does not
 * (wikipedia_en_100_mini_2026-08 is not wikipedia_en_100_).
 */
export const DEMO_PLACE = { id: 'demo', title: 'Demo set', kind: 'demo' };
export const DEMO_LIBRARIES = [
  'gutenberg_en_lcc-p_', 'wikipedia_en_mathematics_mini_', 'wikipedia_en_physics_mini_', 'wikipedia_en_chemistry_mini_',
  'wikipedia_en_100_', 'wikipedia_en_medicine_mini_',
];
export const isDemoLibrary = (library) => DEMO_LIBRARIES.some((name) => library.id.startsWith(name)
  && /^\d{4}-\d{2}$/.test(library.id.slice(name.length)));

/** Places that shelve several libraries together: which libraries each takes, and when it exists. */
const GROUPS = [
  { place: DEMO_PLACE, includes: isDemoLibrary, exists: (libraries) => libraries.some(isDemoLibrary) },
  { place: ALL_PLACE, includes: () => true, exists: (libraries) => libraries.length > 1 },
];
const groupOf = (place) => GROUPS.find((g) => g.place === place);

/** The places that shelve several libraries together, as available with these libraries. */
export function groupPlaces(libraries) {
  return GROUPS.filter((g) => g.exists(libraries)).map((g) => g.place);
}
/** Libraries with more books than this are browsed by rooms. */
export const FACET_MIN = 3000;

/** True when a library is browsed by rooms rather than shelved whole (never Wikipedia's volumes). */
export function isFaceted(library, books) {
  if (library.kind === 'wikipedia') return false;
  return library.kind === 'wikisource' || (books?.length ?? 0) > FACET_MIN;
}

/** What a library's books are called: works, volumes or books. */
export function unitOf(library) {
  return library.kind === 'wikisource' ? 'works' : library.kind === 'wikipedia' ? 'volumes' : 'books';
}

/** The section sign's subtitle of a Wikipedia: its volumes and articles. */
function volumesSubtitle(library, volumes) {
  return `${volumes.toLocaleString()} volume${volumes === 1 ? '' : 's'} · ${(library.articles ?? 0).toLocaleString()} articles`;
}

const genreOf = (b) => b.genre || b.shelf || 'Other works';

/**
 * A room in the current shape. Settings saved before the filters could be combined hold
 * `{ type: 'genre' | 'letter', value }`.
 */
export function normRoom(room) {
  if (!room) return null;
  if (room.type === 'genre') return { genre: room.value, letter: null };
  if (room.type === 'letter') return { genre: null, letter: room.value };
  return { genre: room.genre ?? null, letter: room.letter ?? null };
}

/**
 * Genre and title-letter counts of a library's books, genres largest first. Given the current
 * room, each count is what the room would hold with that filter chosen and the other one kept: a
 * genre counts only books with the room's letter, a letter only books of the room's genre.
 */
export function facetsOf(books, room = null) {
  const genres = new Map();
  const letters = new Map();
  for (const b of books) {
    const g = genreOf(b);
    const l = letterOf(b, 'title');
    if (!genres.has(g)) genres.set(g, { name: g, count: 0, total: 0 });
    if (!letters.has(l)) letters.set(l, { letter: l, count: 0 });
    const ge = genres.get(g);
    ge.total++;
    if (!room?.letter || l === room.letter) ge.count++;
    if (!room?.genre || g === room.genre) letters.get(l).count++;
  }
  return { genres: [...genres.values()].sort((a, b) => b.total - a.total), letters: [...letters.values()] };
}

/** Whether a book belongs to a room (every filter that is set must match). */
export function inRoom(book, room) {
  if (!room) return true;
  return (!room.genre || genreOf(book) === room.genre) && (!room.letter || letterOf(book, 'title') === room.letter);
}

/** A sensible first room: Novels if there are any, else the largest genre that fits a room. */
export function defaultRoom(books) {
  const { genres } = facetsOf(books);
  if (!genres.length) return null;
  const novels = genres.find((g) => g.name === 'Novels');
  const pick = novels || genres.find((g) => g.count <= ROOM_CAP && g.name !== 'Other works') || genres[0];
  return { genre: pick.name, letter: null };
}

/** The room that shows a given book: its genre, narrowed to its title letter when the genre is too big. */
export function roomFor(book, books) {
  const genre = genreOf(book);
  const count = books.reduce((n, b) => n + (genreOf(b) === genre ? 1 : 0), 0);
  return { genre, letter: count <= ROOM_CAP ? null : letterOf(book, 'title') };
}

/** Human label of a room. */
export function roomLabel(room) {
  if (!room?.genre && !room?.letter) return 'All books';
  if (!room.letter) return room.genre;
  return room.genre ? `${room.genre}, titles starting with ${room.letter}` : `Titles starting with ${room.letter}`;
}

export function sameRoom(a, b) {
  const x = normRoom(a);
  const y = normRoom(b);
  return !!x && !!y && x.genre === y.genre && x.letter === y.letter;
}

/**
 * The library currently shown (`settings.place`), falling back to the first library that has
 * books (then the first library) when it is unset or gone. Writes the choice back.
 * @returns {object|null} library descriptor
 */
export function currentPlace(libraries, booksByLib, settings) {
  const group = GROUPS.find((g) => g.place.id === settings.place);
  if (group?.exists(libraries)) return group.place;
  let lib = libraries.find((l) => l.id === settings.place);
  if (!lib) lib = libraries.find((l) => (booksByLib[l.id] || []).length) || libraries[0] || null;
  settings.place = lib?.id ?? null;
  return lib;
}

/**
 * What to shelve: the current place only — a whole ordinary library, or the current room of a
 * large one — with its section-sign subtitle. `settings.place` / `settings.rooms` receive
 * defaults.
 * @returns {Array<{ library, books, room, total, capped, subtitle }>} zero or one collection
 */
export function collectionsFor(libraries, booksByLib, settings) {
  settings.rooms ||= {};
  const lib = currentPlace(libraries, booksByLib, settings);
  if (!lib) return [];
  const group = groupOf(lib);
  if (group) {
    return libraries.filter((l) => group.includes(l) && booksByLib[l.id]?.length).map((library) => {
      const books = booksByLib[library.id];
      // Wikipedia volumes keep their own order (by article range) whatever the shelf order.
      const wiki = library.kind === 'wikipedia';
      return { library, books, room: null, total: books.length, capped: false, ordered: wiki, subtitle: wiki ? volumesSubtitle(library, books.length) : undefined };
    });
  }
  return shelfCollections([lib], booksByLib, settings.rooms, settings.sort).map((c) => ({
    ...c,
    subtitle: c.room
      ? `${roomLabel(c.room)} · ${c.total.toLocaleString()} works${c.capped ? ` (first ${ROOM_CAP.toLocaleString()})` : ''}`
      : lib.kind === 'wikipedia' ? volumesSubtitle(lib, c.total) : undefined,
  }));
}

/** Number of books a place shelves in total (every library of a group place). */
export function placeBookCount(place, libraries, booksByLib) {
  const group = groupOf(place);
  if (group) return libraries.reduce((n, l) => n + (group.includes(l) ? booksByLib[l.id]?.length || 0 : 0), 0);
  return booksByLib[place.id]?.length || 0;
}

/** The place (and room, for large libraries) where a book is shelved. */
export function placeFor(book, libraries, booksByLib) {
  const lib = libraries.find((l) => l.id === book.libId);
  if (!lib) return null;
  const all = booksByLib[lib.id] || [];
  return { libId: lib.id, room: isFaceted(lib, all) ? roomFor(book, all) : null };
}

/**
 * The collections to shelve: every book of ordinary libraries, the current room of faceted
 * ones (sorted and capped).
 * @param {object[]} libraries
 * @param {Record<string, object[]>} booksByLib
 * @param {Record<string, {genre: string|null, letter: string|null}>} rooms current room per faceted library (mutated: defaults filled in, old shapes converted)
 * @param {string} sort
 * @returns {Array<{ library, books, room, total, capped }>}
 */
export function shelfCollections(libraries, booksByLib, rooms, sort) {
  return libraries.map((library) => {
    const all = booksByLib[library.id] || [];
    // Wikipedia volumes come in their own order (numbered by title range): never re-sorted.
    if (!isFaceted(library, all)) return { library, books: all, room: null, total: all.length, capped: false, ordered: library.kind === 'wikipedia' };
    let room = normRoom(rooms[library.id]);
    if (!room || !all.some((b) => inRoom(b, room))) room = defaultRoom(all);
    if (room) rooms[library.id] = room;
    // Filter the library's (cached) sorted order rather than sorting the room on every switch.
    const matching = room ? sortBooks(all, sort).filter((b) => inRoom(b, room)) : [];
    return {
      library, room, total: matching.length, capped: matching.length > ROOM_CAP,
      books: matching.slice(0, ROOM_CAP),
    };
  });
}
