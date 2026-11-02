// @ts-check
// Pure parts of the shared session (together.js), for the tests: where in the library a visitor
// is, so only those in the same room are drawn (each place and room is laid out on its own), and
// the session in words.

import { DOOR_ID } from './config.js';

/** This page in the session (layersharedsession's `page`; the Hallway is `hallway`): its door's id. */
export const PAGE_ID = DOOR_ID;
/** The app id every site in the session uses (the Hallway's together.js; layersharedsession's test page can watch). */
export const APP_ID = 'ariamokr-layersharedsession-test';

/** The shared value (layersharedsession's session.set) that says where a member is in the library. */
export const spaceKey = (memberId) => `${PAGE_ID}.space.${memberId}`;

/**
 * Where in the library: the place and its room's filters and page (rooms.js), which together
 * decide the room's layout. Visitors with the same one stand in the same room.
 * @param {string|null} place
 * @param {{ genre?: string|null, letter?: string|null, page?: number }|null} [room]
 */
export function spaceOf(place, room = null) {
  return JSON.stringify([place ?? null, room?.genre ?? null, room?.letter ?? null, room?.page || 0]);
}

/**
 * Who else is in the session, in words: "Just you so far", or "With you: 2 here, 1 elsewhere in
 * the library, 1 in another place".
 * @param {{ here?: number, nearby?: number, away?: number }} c the layer's company(): here, in
 *   this room; nearby, elsewhere in the library; away, on another page of the session (the
 *   Hallway, outside, …)
 */
export function companyText({ here = 0, nearby = 0, away = 0 }) {
  const parts = [];
  if (here) parts.push(`${here} here`);
  if (nearby) parts.push(`${nearby} elsewhere in the library`);
  if (away) parts.push(`${away} in another place`);
  return parts.length ? `With you: ${parts.join(', ')}` : 'Just you so far';
}

/**
 * The layer's notices in words: someone is in the library (or the session), came into it, left,
 * or waved.
 * @param {{ kind: 'join'|'arrive'|'leave'|'wave', peer: { name?: string|null, page?: string|null } }} n
 */
export function noticeText({ kind, peer }) {
  const name = peer?.name || 'Someone';
  if (kind === 'join') return peer?.page === PAGE_ID ? `${name} is in the library` : `${name} is in the session`;
  if (kind === 'arrive') return `${name} came into the library`;
  if (kind === 'leave') return `${name} left the session`;
  if (kind === 'wave') return `${name} waved`;
  return '';
}

/**
 * The line about the session on the kiosk and the library card: '' outside one.
 * @param {{ room: string|null, active: boolean, company?: Parameters<typeof companyText>[0] }} s
 *   active: joined (not paused while going out by the door)
 */
export function sessionText({ room, active, company = {} }) {
  if (!room) return '';
  return active ? `Shared session ${room} · ${companyText(company)}` : `Shared session ${room}`;
}
