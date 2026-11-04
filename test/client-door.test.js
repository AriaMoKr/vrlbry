// The door back (public/js/world/door.js): where it stands, passing through it, walking into it,
// pointing at it, and the rotunda's windows kept clear of it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import './helpers/vendor.js'; // door.js imports ../../vendor/common/portal.js

const {
  DOOR, doorCorridor, doorCrossed, doorLocal, doorPlace, doorWorld, rayDoor, viewParams, wallBehind, windowAnglesBesideDoor,
} = await import('../public/js/world/door.js');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const rotunda = { kind: 'rotunda', R: 4 };
const hall = { kind: 'hall', bounds: { minX: -9, maxX: 7, minZ: -30, maxZ: 4.5 } };
const ray = (from, to) => new THREE.Ray(new THREE.Vector3(...from), new THREE.Vector3(...to).sub(new THREE.Vector3(...from)).normalize());

describe('the door back', () => {
  it('stands against the wall behind the spawn point, facing the room', () => {
    assert.deepEqual(doorPlace(rotunda), { x: 0, z: 3.9, yaw: Math.PI });
    assert.deepEqual(doorPlace(hall), { x: -1, z: 4.46, yaw: Math.PI });
    assert.equal(doorPlace(null), null);
    // The wall behind: the hall's is flat, the rotunda's curves forward to the door's sides.
    const place = doorPlace(rotunda);
    assert.ok(near(wallBehind(rotunda, place, 0), -0.1));
    assert.ok(wallBehind(rotunda, place, 1.1) > 0 && wallBehind(rotunda, place, 1.1) < 0.1);
    assert.ok(near(wallBehind(hall, doorPlace(hall), 1.1), -0.04, 1e-12));
  });

  it('has a frame: out into the room is +z, to the right of someone facing it +x', () => {
    const place = doorPlace(rotunda);
    const p = doorLocal(place, 0, 0);
    assert.ok(near(p.x, 0) && near(p.z, 3.9), 'the room\'s middle is straight out');
    // Facing the door from the room (looking along +z), one's right is −x.
    assert.ok(doorLocal(place, -1, 3).x > 0);
    for (const [x, z] of [[0.3, 2.7], [-1.2, 3.4], [2, -1]]) {
      const l = doorLocal(place, x, z);
      const w = doorWorld(place, l.x, l.z);
      assert.ok(near(w.x, x) && near(w.z, z), `${x}, ${z}`);
    }
  });

  it('is passed through once a head is a little way into the doorway, between its jambs', () => {
    const place = doorPlace(rotunda);
    const at = (lx, lz) => doorWorld(place, lx, lz);
    const crossed = (lx, lz) => doorCrossed(place, at(lx, lz).x, at(lx, lz).z);
    assert.equal(crossed(0, 1), false, 'in front of it');
    assert.equal(crossed(0, DOOR.depth - 0.02), false, 'at its front');
    assert.equal(crossed(0, DOOR.depth - 0.08), true, 'a little way in');
    assert.equal(crossed(0.5, 0.05), true);
    assert.equal(crossed(0.7, 0.05), false, 'beside it, in the wall');
  });

  it('lets a walk go straight into the doorway, between the jambs and short of the portal', () => {
    const place = doorPlace(rotunda);
    const at = (lx, lz) => doorWorld(place, lx, lz);
    const into = doorCorridor(place, at(0.1, 0).x, at(0.1, 0).z);
    const l = doorLocal(place, into.x, into.z);
    assert.ok(near(l.x, 0.1) && near(l.z, 0.04), 'stopped short of the portal');
    assert.ok(doorCorridor(place, at(0, 0.9).x, at(0, 0.9).z), 'straight in front of it');
    assert.equal(doorCorridor(place, at(0.4, 0.1).x, at(0.4, 0.1).z), null, 'too near a jamb: the room\'s walls apply');
    assert.equal(doorCorridor(place, at(0, 2).x, at(0, 2).z), null, 'out in the room');
    // From the rotunda's spawn point a walk backwards reaches it.
    assert.ok(doorCorridor(place, 0, 3.75));
  });

  it('is pointed at through its opening, and its frame stops the laser', () => {
    const place = doorPlace(rotunda);
    const eye = [0, 1.6, 1.3];
    const front = place.z - DOOR.depth;
    const middle = rayDoor(place, ray(eye, [0, 1.2, place.z]));
    assert.equal(middle.opening, true);
    assert.ok(near(middle.distance, Math.hypot(front - 1.3, (1.2 - 1.6) * (front - 1.3) / (place.z - 1.3)), 1e-9));
    assert.equal(rayDoor(place, ray(eye, [-0.6, 1.2, place.z])).opening, false, 'its frame');
    assert.equal(rayDoor(place, ray(eye, [0, 3.2, place.z])), null, 'above it');
    assert.equal(rayDoor(place, ray(eye, [0, 1.2, -3])), null, 'looking away');
    assert.equal(rayDoor(place, ray([0, 1.6, place.z - 0.05], [0, 1.6, place.z + 1])), null, 'from inside the doorway');
  });

  it('keeps the rotunda\'s windows clear of it and its plaque, on both sides alike', () => {
    for (const [half, R] of [[0, 3.8], [1.2, 4.6], [2.3, 5.6]]) {
      const angles = windowAnglesBesideDoor(half, R);
      assert.equal(angles.length % 2, 0);
      for (const a of angles) {
        assert.ok(Math.abs(a - Math.PI) * R >= DOOR.clear - 1e-9, `${a} by the door (R ${R})`);
        assert.ok(a >= half && a <= 2 * Math.PI - half, `${a} among the bookcases`);
      }
    }
    assert.equal(windowAnglesBesideDoor(0, 3.8).length, 8);
  });

  it('takes the Hallway\'s view from its door when views.json gives one that makes sense', () => {
    const entry = { image: 'vrlbry.jpg', depth: 2.94, pictureHeight: 6.5, eye: 1.6, horizon: 0.6154, aspect: 2 };
    assert.deepEqual(viewParams(entry), entry);
    assert.equal(viewParams({ ...entry, aspect: undefined }).aspect, 2, 'a 2:1 picture unless it says');
    for (const bad of [null, {}, { ...entry, image: '' }, { ...entry, depth: -1 }, { ...entry, horizon: 2 }, { ...entry, eye: '1.6' }, { ...entry, pictureHeight: 1e6 }]) {
      assert.equal(viewParams(bad), null, JSON.stringify(bad));
    }
  });
});
