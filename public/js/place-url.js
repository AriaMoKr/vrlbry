// @ts-check
// The address says where the visitor is (SPEC §5.6 "Rooms"): the place, `?place=<library id>` or
// a group place's id (demo, local, *), and in a large library its room, `&genre=`, `&letter=` and
// `&page=` (from 2), kept up to date as the room changes (history.replaceState in main.js), so it
// can be bookmarked, shared or reloaded; a link naming them opens there. The page's other
// parameters (?back=, ?xr=, ?perf, …) are left as they are. Pure.

import { ALL_PLACE, DEMO_PLACE, LOCAL_PLACE, normRoom } from './rooms.js';

const KEYS = ['place', 'genre', 'letter', 'page'];
const GROUP_IDS = [ALL_PLACE.id, DEMO_PLACE.id, LOCAL_PLACE.id];
/** A library id without its edition's date ("wikipedia_en_100_2026-09" → "wikipedia_en_100"). */
const undated = (id) => String(id).replace(/_\d{4}-\d{2}$/, '');

/**
 * The address `href` naming `place` and its `room` (null: a whole library or a group place), the
 * other parameters kept.
 * @param {string} href
 * @param {string|null} place
 * @param {{ genre?: string|null, letter?: string|null, page?: number }|null} [room]
 * @returns {string}
 */
export function placeHref(href, place, room = null) {
  const url = new URL(href);
  for (const k of KEYS) url.searchParams.delete(k);
  if (place == null) return url.href;
  url.searchParams.set('place', place);
  const r = normRoom(room);
  if (r?.genre) url.searchParams.set('genre', r.genre);
  if (r?.letter) url.searchParams.set('letter', r.letter);
  if (r?.page) url.searchParams.set('page', String(r.page + 1));
  return url.href;
}

/**
 * The place and room an address names, or null when it names none here. A library is found by
 * its id, else by its name without the edition's date (the newest edition here: a link outlives
 * an edition); a group place and a library opened in a browser (`~…`, opened later as the page
 * starts) are taken as they are. The room is the whole library unless the address names one.
 * @param {string} search location.search
 * @param {Array<{ id: string }>} libraries
 * @returns {{ place: string, room: { genre: string|null, letter: string|null, page?: number }|null }|null}
 */
export function placeFromSearch(search, libraries) {
  const params = new URLSearchParams(search);
  const id = params.get('place');
  if (!id) return null;
  if (GROUP_IDS.includes(id)) return { place: id, room: null };
  const place = id.startsWith('~') ? id
    : libraries.find((l) => l.id === id)?.id
      ?? libraries.map((l) => l.id).filter((l) => !l.startsWith('~') && undated(l) === undated(id)).sort().pop()
      ?? null;
  if (!place) return null;
  const page = Math.max(0, (parseInt(params.get('page'), 10) || 1) - 1);
  return { place, room: normRoom({ genre: params.get('genre') || null, letter: params.get('letter') || null, page }) };
}
