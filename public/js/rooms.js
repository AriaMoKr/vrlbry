// Rooms: the library hall shows one collection at a time. Each library is its own room (its
// "place"); very large libraries (Wikisource) are browsed through filters instead — a genre, a
// title letter, both ("Poetry starting with A") or neither — because 18,000 works are far too many
// to draw on a Quest. The visitor picks them at the kiosk. Pure helpers shared by main.js and
// interaction.js.
//
// A room of a large library is `{ genre: string|null, letter: string|null }`.

import { letterOf, sortBooks } from './util/books.js';

/**
 * Most books a room shelves at once (~92 bookcases; more are shelved a page at a time). Measured
 * on a Quest 3 in VR (TODO, milestone 3): walking stayed at 72 Hz with 42-46 draw calls whether a
 * room held 3,000, 6,000, 10,000 or 20,000 books; a room switch took 0.93, 0.97, 1.19 and 1.81 s,
 * its worst frame 100, 189, 278 and 500 ms. The page address's `?roomcap=<n>` (500-30,000) sets
 * another, for measuring.
 */
export const ROOM_CAP = (() => {
  let n = NaN;
  try {
    n = Number(new URLSearchParams(globalThis.location?.search ?? '').get('roomcap'));
  } catch {
    // no page address (Node)
  }
  return Number.isInteger(n) && n >= 500 && n <= 30000 ? n : 10000;
})();
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
  'wikipedia_en_100_', 'wikipedia_en_medicine_mini_', 'wikipedia_en_golf_maxi_',
];
export const isDemoLibrary = (library) => DEMO_LIBRARIES.some((name) => library.id.startsWith(name)
  && /^\d{4}-\d{2}$/.test(library.id.slice(name.length)));

/**
 * The libraries opened in this browser (ZIM files from the device, SPEC §2.6: ids start with
 * '~'), shelved together once there are two or more: opening several files at once goes there.
 */
export const LOCAL_PLACE = { id: 'local', title: 'Opened here', kind: 'local' };
export const isLocalLibrary = (library) => String(library.id).startsWith('~');

/** Places that shelve several libraries together: which libraries each takes, and when it exists. */
const GROUPS = [
  { place: DEMO_PLACE, includes: isDemoLibrary, exists: (libraries) => libraries.some(isDemoLibrary) },
  { place: LOCAL_PLACE, includes: isLocalLibrary, exists: (libraries) => libraries.filter(isLocalLibrary).length > 1 },
  // All libraries: not when they are all the demo set's (as on the GitHub Pages site) or all
  // opened here, where it would be one of those again.
  {
    place: ALL_PLACE,
    includes: () => true,
    exists: (libraries) => libraries.length > 1 && !libraries.every(isDemoLibrary) && !libraries.every(isLocalLibrary),
  },
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
 * The Library of Congress classes Gutenberg shelves its books by (a book's `shelf`, from the ZIM's
 * lcc_shelves.js: the 39 of gutenberg_en_all), by name: Kiwix's names for its Gutenberg ZIM of each
 * class, except E and F (both "History of the Americas" there), C and PZ (in plainer words).
 * Rooms and filters keep the codes (saved rooms stay valid); only what is shown is named.
 */
export const LCC_NAMES = Object.freeze({
  A: 'General works',
  B: 'Philosophy, psychology, religion',
  C: 'Biography, genealogy, archaeology',
  D: 'World history (Europe, Asia, Africa, Australia)',
  E: 'History of the Americas (general, United States)',
  F: 'History of the Americas (U.S. local, Canada, Latin America)',
  G: 'Geography, anthropology, recreation',
  H: 'Social sciences',
  J: 'Political science',
  K: 'Law',
  L: 'Education',
  M: 'Music and books on music',
  N: 'Fine arts',
  P: 'Language and literature',
  PA: 'Greek and Latin language and literature',
  PB: 'Modern and Celtic languages',
  PC: 'Romance languages',
  PD: 'Germanic and Scandinavian languages',
  PE: 'English language',
  PF: 'West Germanic languages',
  PG: 'Slavic, Baltic and Albanian languages',
  PH: 'Uralic and Basque languages',
  PJ: 'Oriental languages and literatures',
  PK: 'Indo-Iranian languages and literatures',
  PL: 'Eastern Asia, Africa, Oceania languages',
  PM: 'Hyperborean, Indian, and artificial languages',
  PN: 'Literature (general)',
  PQ: 'French, Italian, Spanish, Portuguese literature',
  PR: 'English literature',
  PS: 'American literature',
  PT: 'Germanic and Scandinavian literature',
  PZ: "Fiction and children's books",
  Q: 'Science',
  R: 'Medicine',
  S: 'Agriculture',
  T: 'Technology',
  U: 'Military science',
  V: 'Naval science',
  Z: 'Books, libraries, bibliography',
});

/** A genre as it is shown: an LCC class by its name, any other (Wikisource's) as it is. */
export function genreLabel(genre) {
  return LCC_NAMES[genre] ?? genre;
}

/**
 * A room in the current shape. Settings saved before the filters could be combined hold
 * `{ type: 'genre' | 'letter', value }`.
 */
export function normRoom(room) {
  if (!room) return null;
  if (room.type === 'genre') return { genre: room.value, letter: null };
  if (room.type === 'letter') return { genre: null, letter: room.value };
  // `page`: which ROOM_CAP of a room holding more are shelved (shelfCollections), kept only past the first.
  const page = Number.isInteger(room.page) && room.page > 0 ? room.page : 0;
  return { genre: room.genre ?? null, letter: room.letter ?? null, ...(page ? { page } : {}) };
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

/**
 * A sensible first room: Novels if there are any (Wikisource), else all the books, of which a
 * Gutenberg ZIM's room shelves the most read (shelfCollections). A big Gutenberg ZIM opened on its
 * largest genre that fitted the cap: class A, encyclopedias and periodicals.
 */
export function defaultRoom(books) {
  const { genres } = facetsOf(books);
  if (!genres.length) return null;
  const novels = genres.find((g) => g.name === 'Novels');
  return { genre: novels ? novels.name : null, letter: null };
}

/** The room that shows a given book: its genre, narrowed to its title letter when the genre is too big. */
export function roomFor(book, books) {
  const genre = genreOf(book);
  const count = books.reduce((n, b) => n + (genreOf(b) === genre ? 1 : 0), 0);
  return { genre, letter: count <= ROOM_CAP ? null : letterOf(book, 'title') };
}

/**
 * Whether a library's capped rooms shelve their most read books (ROOM_CAP of them, in the shelf
 * order) rather than the first in the shelf order: a Gutenberg ZIM's `rank` is its popularity
 * (full_by_popularity.js); other libraries' is their order in the archive, or none.
 */
export const capsByPopularity = (library) => library?.kind === 'gutenberg';

/**
 * What a room's count says when it holds more than are shelved (ROOM_CAP 10,000): " (the 10,000
 * most read)" or " (first 10,000)" on its first page, " (most read 10,001–20,000)" or
 * " (10,001–20,000)" past it, or ''.
 */
export function capNote(library, total, page = 0) {
  if (total <= ROOM_CAP) return '';
  const popular = capsByPopularity(library);
  if (!page) return popular ? ` (the ${ROOM_CAP.toLocaleString()} most read)` : ` (first ${ROOM_CAP.toLocaleString()})`;
  const range = `${(page * ROOM_CAP + 1).toLocaleString()}–${Math.min(total, (page + 1) * ROOM_CAP).toLocaleString()}`;
  return popular ? ` (most read ${range})` : ` (${range})`;
}

/** How many pages of ROOM_CAP a room of `total` books has (1 when it fits). */
export const pagesOf = (total) => Math.max(1, Math.ceil(total / ROOM_CAP));

/** Human label of a room. */
export function roomLabel(room) {
  if (!room?.genre && !room?.letter) return 'All books';
  if (!room.letter) return genreLabel(room.genre);
  return room.genre ? `${genreLabel(room.genre)}, titles starting with ${room.letter}` : `Titles starting with ${room.letter}`;
}

export function sameRoom(a, b) {
  const x = normRoom(a);
  const y = normRoom(b);
  return !!x && !!y && x.genre === y.genre && x.letter === y.letter && (x.page ?? 0) === (y.page ?? 0);
}

/**
 * The library currently shown (`settings.place`), falling back to the first library that has
 * books (then the first library) when it is unset or gone. Writes the choice back.
 * @returns {object|null} library descriptor
 */
export function currentPlace(libraries, booksByLib, settings) {
  // All libraries, where it would be the demo set again (see GROUPS), is the demo set.
  if (settings.place === ALL_PLACE.id && libraries.length > 1 && libraries.every(isDemoLibrary)) settings.place = DEMO_PLACE.id;
  if (settings.place === ALL_PLACE.id && libraries.length > 1 && libraries.every(isLocalLibrary)) settings.place = LOCAL_PLACE.id;
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
      ? `${roomLabel(c.room)} · ${c.total.toLocaleString()} works${capNote(lib, c.total, c.page)}`
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
    // A room holding more than ROOM_CAP is shelved a page at a time: a Gutenberg ZIM's by
    // popularity (its most read, then the next…: the cached popularity order), shelved in the
    // chosen order; another's in the chosen order itself.
    const pages = pagesOf(matching.length);
    const page = Math.min(room?.page ?? 0, pages - 1);
    if (room && (room.page ?? 0) !== page) rooms[library.id] = room = normRoom({ ...room, page });
    const from = page * ROOM_CAP;
    let books = matching.slice(from, from + ROOM_CAP);
    if (matching.length > ROOM_CAP && capsByPopularity(library) && sort !== 'popularity') {
      const band = new Set(sortBooks(all, 'popularity').filter((b) => inRoom(b, room)).slice(from, from + ROOM_CAP));
      books = matching.filter((b) => band.has(b));
    }
    return { library, room, total: matching.length, capped: matching.length > ROOM_CAP, page, pages, books };
  });
}
