// @ts-check
// The way out (SPEC §5.6 "Kiosk panel"): the card's and the catalogue stand's "← Hallway" lead to
// the Hallway, in front of this library's door (config.js DOOR_ID), or to whatever place has it
// behind one of its doors and says so in the link that brings visitors here:
//   https://ariamokr.github.io/vrlbry/?back=<that place's address>&backname=<its name>
// (both URL-encoded). The rules are the Hallway's door contract, in AriaMoKr/common (door.js
// wayBack; its README, "Linking back"): only http(s) addresses are taken, another place is named
// on the button (by `backname`, else its host), so a link cannot send visitors somewhere unsaid,
// and the Hallway's own doors (`from=hallway`, a `back` on the Hallway's own page) are the
// Hallway, kept as given (its `from` and a shared session's `room`). The door back in the room
// (world/door.js) leads there too, saying where (doorOf). Pure.

import { hallwayViews, wayBack } from '../vendor/common/door.js';
import { DOOR_ID } from './config.js';

/**
 * Where the way out leads, from the page's query string: common's wayBack for this library's door.
 * @param {string} search location.search
 * @returns {{ url: string, label: string, title: string, name: string, host: string, hallway: boolean }}
 */
export function wayOut(search = '') {
  return wayBack(search, DOOR_ID);
}

/**
 * What the door back (world/door.js) says and shows: the Hallway's corridor through it, or another
 * place's name, with its name on the plaque and the sign.
 * @param {ReturnType<typeof wayOut>} way
 */
export function doorOf(way) {
  if (!way.hallway) return { title: way.name, subtitle: way.host, sign: way.name, color: '#9cc6b4', view: 'plain', views: null, viewId: null };
  // The Hallway publishes the view out of each of its doors (common's README, "The view from your
  // door"): this library's is the one the way back's ?from= names, else this door's.
  const views = hallwayViews(way, DOOR_ID);
  return {
    title: 'Hallway', subtitle: 'Doors to other places', sign: 'Hallway', color: '#9cc6b4', view: 'hallway',
    views: views?.views ?? null, viewId: views?.id ?? null,
  };
}
