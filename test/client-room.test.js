// Laser stops (public/js/world/room.js raycast): rays from inside a room end at its walls, dome
// or ceiling, floor and furniture; and the sky in its windows. The rooms are built in Node with a
// stub canvas.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as THREE from 'three';
import { SUN_DIR } from 'common/sky.js';
import './helpers/vendor.js'; // room.js imports ../../vendor/common/sky.js

/** A canvas whose 2D context accepts every call (as in client-lod.test.js). */
function stubCanvas() {
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 6 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop === 'createPattern') return () => ({});
      if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (prop === 'canvas') return target.canvas;
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

let createRotunda;
let createHall;
let WALL_H;
let rotundaSkyYaw;
let roomMaterials;
before(async () => {
  globalThis.document ??= { createElement: (tag) => (tag === 'canvas' ? stubCanvas() : {}) };
  ({ createRotunda, createHall, WALL_H, rotundaSkyYaw, roomMaterials } = await import('../public/js/world/room.js'));
});

const ray = (o, d) => new THREE.Ray(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize());
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

describe('laser stops', () => {
  it('a rotunda: its wall, dome, floor and furniture', () => {
    const R = 8;
    const kiosk = { position: new THREE.Vector3(0, 0, -3), yaw: 0 };
    const room = createRotunda({ R, kiosk });
    // Away from the furniture (which sits at +x/+z and −x/+z, the kiosk at −z).
    near(room.raycast(ray([0, 1.6, 0], [0, 0, 1])), R, 'the wall straight ahead');
    near(room.raycast(ray([0, 1.6, 0], [0, -1, 0])), 1.6, 'the floor below');
    near(room.raycast(ray([0, 1.6, 0], [0, 1, 0])), WALL_H - 1.6 + R, 'the top of the dome');
    // The kiosk's stand (radius 0.32, 1 m tall) in front of the wall, but not above it.
    near(room.raycast(ray([0, 0.5, 0], [0, 0, -1])), 3 - 0.32, 'the stand');
    assert.ok(room.raycast(ray([0, 1.6, 0], [0, 0, -1])) > R - 1e-6, 'over the stand: the wall');
    // Looking down onto the stand's top.
    near(room.raycast(ray([0, 2, -3], [0, -1, 0])), 1, 'onto its top');
    // Standing inside a collider does not block every ray.
    near(room.raycast(ray([0, 0.5, -3], [0, 0, 1])), 3 + R, 'from inside the stand');
  });

  it('a hall: its walls, ceiling and floor', () => {
    const room = createHall({ minX: -5, maxX: 5, minZ: -12, maxZ: 3, kiosk: { position: new THREE.Vector3(0, 0, 2), yaw: 0 } });
    near(room.raycast(ray([1, 1.6, 0], [1, 0, 0])), 4, 'east wall');
    near(room.raycast(ray([1, 1.6, 0], [0, 0, -1])), 12, 'far end');
    near(room.raycast(ray([1, 1.6, 0], [0, 1, 0])), WALL_H - 1.6, 'ceiling');
    near(room.raycast(ray([1, 1.6, 0], [0, -1, 0])), 1.6, 'floor');
    near(room.raycast(ray([0, 0.5, 0], [0, 0, 1])), 2 - 0.32, 'the kiosk stand');
  });
});

describe('the sky in the windows', () => {
  // Where the sun stands in a room turned by yaw: its bearing from -z toward +x (common's README).
  const sunBearing = (yaw) => Math.atan2(SUN_DIR[0], -SUN_DIR[2]) - yaw;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  it('puts the rotunda\'s low sun beside its window most to the left, one sky for all its glass', () => {
    // Windows either side of the bookcases ahead (angle 0) and the door behind (π).
    const angles = [1.3, 2 * Math.PI - 1.3, 2.2, 2 * Math.PI - 2.2];
    const yaw = rotundaSkyYaw(angles);
    assert.ok(Math.abs(wrap(sunBearing(yaw)) - (-1.3 + 0.12)) < 1e-9, 'beside the left window nearest -90°');
    assert.equal(rotundaSkyYaw([]), 0);
    const room = createRotunda({ R: 6, windowAngles: angles, kiosk: null });
    const sky = roomMaterials().sky;
    assert.equal(sky.uniforms.uYaw.value, yaw);
    const glass = room.group.getObjectByName('windows');
    const skyUsers = [];
    room.group.traverse((o) => { if (o.material === sky) skyUsers.push(o); });
    assert.ok(glass && skyUsers.includes(glass) && skyUsers.length === 2, 'the windows\' glass and the oculus');
  });

  it('lays the hall out as the garden is', () => {
    createHall({ minX: -5, maxX: 5, minZ: -20, maxZ: 2, kiosk: null });
    assert.equal(roomMaterials().sky.uniforms.uYaw.value, 0);
  });
});
