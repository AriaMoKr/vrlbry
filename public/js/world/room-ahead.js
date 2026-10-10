// Room in front of the viewer for something about to be placed there: a book taken off a shelf
// (with its info panel) or opened (with its toolbar). Standing close to a bookcase put the book
// behind its back board, out of sight together with the buttons that would put it back. Pure:
// the obstacles, where one can stand and the room's walls are callbacks (interaction.js gives the
// world's raycasts), so it runs in Node.

/** Space kept between what is placed and what stands behind it (m). */
export const ROOM_MARGIN = 0.05;
/** What is placed comes no nearer than this (m, its centre) by default: closer is tiring to focus on. */
export const NEAREST = 0.3;
/** How finely, and how much further than needed, a spot to step back to is looked for (m). */
export const STEP = 0.025;
export const BEYOND = 0.3;

const add = (a, b, s = 1) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const len = (v) => Math.hypot(v.x, v.y, v.z);

/**
 * How to make room: step back `back` metres along `dir` (where the viewer can stand, without
 * crossing a wall), then bring the thing nearer by `k` (≤ 1: its distance and size both, so it
 * looks the same, only nearer), as little of either as fits it.
 * @param {object} o
 * @param {{x,y,z}} o.eye the eyes
 * @param {{x,z}} o.feet where the viewer stands
 * @param {{x,z}} o.dir the way back (a horizontal unit vector: away from where they look)
 * @param {Array<{x,y,z}>} o.offsets its points, as vectors from the eyes; the first is its centre
 * @param {(eye: {x,y,z}, offset: {x,y,z}) => number} o.free distance from `eye` towards
 *   `eye + offset` to the first obstacle (Infinity: none)
 * @param {(x: number, z: number) => boolean} o.canStand a spot to stand on (not in a bookcase)
 * @param {(x: number, z: number) => boolean} o.inRoom inside the room's walls
 * @returns {{ back: number, k: number }}
 */
export function makeRoom({ eye, feet, dir, offsets, free, canStand, inRoom, margin = ROOM_MARGIN, nearest = NEAREST, step = STEP, beyond = BEYOND }) {
  const d3 = { x: dir.x, y: 0, z: dir.z };
  // How much nearer than its points the obstacles are, seen from eyes `s` metres back.
  const shortfall = (s) => {
    const e = add(eye, d3, s);
    let worst = 0;
    for (const o of offsets) worst = Math.max(worst, len(o) + margin - free(e, o));
    return worst;
  };
  const need = shortfall(0);
  if (need <= 0) return { back: 0, k: 1 };
  // The nearest spot back that fits it; else the one that comes closest to fitting.
  let back = 0;
  let best = need;
  for (let s = step; s <= need + beyond + 1e-9; s += step) {
    if (!inRoom(feet.x + dir.x * s, feet.z + dir.z * s)) break; // a wall behind
    if (!canStand(feet.x + dir.x * s, feet.z + dir.z * s)) continue;
    const short = shortfall(s);
    if (short < best - 1e-9) {
      best = short;
      back = s;
    }
    if (short <= 0) break;
  }
  // What still does not fit comes nearer, as a whole.
  const e = add(eye, d3, back);
  let k = 1;
  for (const o of offsets) {
    const d = len(o);
    const room = free(e, o) - margin;
    if (d > room) k = Math.min(k, room / d);
  }
  const centre = len(offsets[0]);
  return { back, k: Math.max(k, centre > 0 ? Math.min(1, nearest / centre) : 1) };
}
