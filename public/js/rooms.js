// Rooms: the library hall shows one collection at a time. Each library is its own room (its
// "place"); very large libraries (Wikisource) are further split into rooms of one genre or of the
// titles starting with a letter, because 18,000 works are far too many to draw on a Quest. The
// visitor picks the room at the kiosk. Pure helpers shared by main.js and interaction.js.

import { letterOf, sortBooks } from './util/books.js';

/** Most books a room shelves at once (~26 bookcases). */
export const ROOM_CAP = 3000;
/** Libraries with more books than this are browsed by rooms. */
export const FACET_MIN = 3000;

/** True when a library is browsed by rooms rather than shelved whole. */
export function isFaceted(library, books) {
  return library.kind === 'wikisource' || (books?.length ?? 0) > FACET_MIN;
}

/** Genre and title-letter counts of a library's books. */
export function facetsOf(books) {
  const genres = new Map();
  const letters = new Map();
  for (const b of books) {
    const g = b.genre || b.shelf || 'Other works';
    genres.set(g, (genres.get(g) || 0) + 1);
    const l = letterOf(b, 'title');
    letters.set(l, (letters.get(l) || 0) + 1);
  }
  return {
    genres: [...genres].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    letters: [...letters].map(([letter, count]) => ({ letter, count })),
  };
}

/** Whether a book belongs to a room. */
export function inRoom(book, room) {
  if (!room) return true;
  if (room.type === 'letter') return letterOf(book, 'title') === room.value;
  return (book.genre || book.shelf || 'Other works') === room.value;
}

/** A sensible first room: Novels if there are any, else the largest genre that fits a room. */
export function defaultRoom(books) {
  const { genres } = facetsOf(books);
  if (!genres.length) return null;
  const novels = genres.find((g) => g.name === 'Novels');
  const pick = novels || genres.find((g) => g.count <= ROOM_CAP && g.name !== 'Other works') || genres[0];
  return { type: 'genre', value: pick.name };
}

/** The room that shows a given book: its genre, or its title letter when the genre is too big. */
export function roomFor(book, books) {
  const genre = book.genre || book.shelf || 'Other works';
  const count = books.reduce((n, b) => n + ((b.genre || b.shelf || 'Other works') === genre ? 1 : 0), 0);
  return count <= ROOM_CAP ? { type: 'genre', value: genre } : { type: 'letter', value: letterOf(book, 'title') };
}

/** Human label of a room. */
export function roomLabel(room) {
  if (!room) return 'All books';
  return room.type === 'letter' ? `Titles starting with ${room.value}` : room.value;
}

export function sameRoom(a, b) {
  return !!a && !!b && a.type === b.type && a.value === b.value;
}

/**
 * The library currently shown (`settings.place`), falling back to the first library that has
 * books (then the first library) when it is unset or gone. Writes the choice back.
 * @returns {object|null} library descriptor
 */
export function currentPlace(libraries, booksByLib, settings) {
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
  return shelfCollections([lib], booksByLib, settings.rooms, settings.sort).map((c) => ({
    ...c,
    subtitle: c.room
      ? `${roomLabel(c.room)} · ${c.total.toLocaleString()} works${c.capped ? ` (first ${ROOM_CAP.toLocaleString()})` : ''}`
      : undefined,
  }));
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
 * @param {Record<string, {type: string, value: string}>} rooms current room per faceted library (mutated: defaults filled in)
 * @param {string} sort
 * @returns {Array<{ library, books, room, total, capped }>}
 */
export function shelfCollections(libraries, booksByLib, rooms, sort) {
  return libraries.map((library) => {
    const all = booksByLib[library.id] || [];
    if (!isFaceted(library, all)) return { library, books: all, room: null, total: all.length, capped: false };
    let room = rooms[library.id];
    if (!room || !all.some((b) => inRoom(b, room))) {
      room = defaultRoom(all);
      if (room) rooms[library.id] = room;
    }
    const matching = room ? sortBooks(all.filter((b) => inRoom(b, room)), sort) : [];
    return {
      library, room, total: matching.length, capped: matching.length > ROOM_CAP,
      books: matching.slice(0, ROOM_CAP),
    };
  });
}
