// Room in front of the viewer for a book taken out or opened (public/js/world/room-ahead.js):
// step back where one can stand, else (or for the rest) bring it nearer, as a whole.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeRoom } from '../public/js/world/room-ahead.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * The viewer at the origin looking along −z, a wall (or bookcase) across z = −d. Its points: the
 * centre 0.6 m ahead and a little below, and two corners.
 */
function scene(d, { canStand = () => true, inRoom = () => true } = {}) {
  const free = (e, o) => (o.z >= 0 ? Infinity : (e.z + d) / (-o.z / Math.hypot(o.x, o.y, o.z)));
  return {
    eye: { x: 0, y: 1.6, z: 0 }, feet: { x: 0, z: 0 }, dir: { x: 0, z: 1 },
    offsets: [{ x: 0, y: -0.2, z: -0.6 }, { x: -0.3, y: -0.4, z: -0.6 }, { x: 0.3, y: 0, z: -0.6 }],
    free, canStand, inRoom,
  };
}

describe('room ahead (a book in front of the eyes)', () => {
  it('leaves things as they are when there is room', () => {
    assert.deepEqual(makeRoom(scene(2)), { back: 0, k: 1 });
  });

  it('steps back just far enough (in steps of 2.5 cm), the book at its distance', () => {
    // The farthest point needs the wall 0.6 + 0.05 × 0.6 / |o| away: 0.347 m back for the centre.
    const { back, k } = makeRoom(scene(0.3));
    assert.ok(near(back, 0.35), back);
    assert.equal(k, 1);
  });

  it('steps over spots one cannot stand on (a bookcase\'s foot) to one that fits', () => {
    const { back, k } = makeRoom(scene(0.3, { canStand: (x, z) => z > 0.15 }));
    assert.ok(near(back, 0.35), back);
    assert.equal(k, 1);
  });

  it('with a wall behind, steps back as far as it can and brings the book nearer for the rest', () => {
    const { back, k } = makeRoom(scene(0.3, { inRoom: (x, z) => z <= 0.2 + 1e-9 }));
    assert.ok(near(back, 0.2), back);
    // The centre is the tightest: (0.5 × |o| / 0.6 − 0.05) / |o|.
    const o = Math.hypot(0.2, 0.6);
    assert.ok(near(k, ((0.5 * o) / 0.6 - 0.05) / o), k);
  });

  it('nowhere to stand: nearer only, never nearer than `nearest` (its centre)', () => {
    const o = Math.hypot(0.2, 0.6);
    const tight = makeRoom({ ...scene(0.3, { canStand: () => false }), nearest: 0.12 });
    assert.equal(tight.back, 0);
    assert.ok(near(tight.k, ((0.3 * o) / 0.6 - 0.05) / o), tight.k);
    const floored = makeRoom({ ...scene(0.05, { canStand: () => false }), nearest: 0.3 });
    assert.ok(near(floored.k, 0.3 / o), 'as near as allowed, even if it does not fit');
  });
});
