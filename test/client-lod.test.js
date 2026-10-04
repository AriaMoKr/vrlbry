// Spine-atlas level of detail in Bookshelves (public/js/world/shelves.js), run in Node with a stub
// 2D canvas: budget, nearest-first upgrades, hysteresis (no thrashing), time-sliced painting.

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';

let Bookshelves;
let packBookcases;
let sortBooks;

/** A canvas whose 2D context accepts every call; measureText is proportional to length. */
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

before(async () => {
  globalThis.document ??= { createElement: (tag) => (tag === 'canvas' ? stubCanvas() : {}) };
  ({ Bookshelves, packBookcases } = await import('../public/js/world/shelves.js'));
  ({ sortBooks } = await import('../public/js/util/books.js'));
});

const renderer = { capabilities: { getMaxAnisotropy: () => 16 } };

function shelvesWith(nCases) {
  const books = Array.from({ length: nCases * 90 }, (_, i) => ({
    id: String(i), title: `Book ${i}`, author: `Author ${i % 50}`, libId: 'lib', size: 200000,
  }));
  const cases = packBookcases(sortBooks(books, 'title'));
  // A ring of bookcases around the origin, like the rotunda.
  const R = 7;
  cases.forEach((cs, i) => {
    const a = (i / cases.length) * Math.PI * 2;
    cs.position = new THREE.Vector3(Math.sin(a) * R, 0, -Math.cos(a) * R);
    cs.yaw = -a;
    cs.label = 'A – Z';
  });
  const shelves = new Bookshelves({ renderer });
  shelves.build(cases);
  return shelves;
}

function camAt(x, z) {
  const cam = new THREE.Object3D();
  cam.position.set(x, 1.6, z);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Runs the LOD for `frames` frames of 1/72 s. */
function run(shelves, cam, frames) {
  for (let i = 0; i < frames; i++) shelves.update(1 / 72, cam);
}

describe('spine atlas LOD', () => {
  it('starts low-res, paints mid atlases for all and sharp ones only near the viewer', () => {
    const shelves = shelvesWith(16);
    try {
      assert.deepEqual(shelves.lodStats(), { cases: shelves.cases.length, mid: 0, high: 0, painting: null });
      // Stand close to one bookcase: it (and close neighbours only) get sharp atlases.
      const near = shelves.cases[0].position;
      const cam = camAt(near.x * 0.7, near.z * 0.7);
      run(shelves, cam, 72 * 60);
      const stats = shelves.lodStats();
      assert.equal(stats.mid, shelves.cases.length, 'every bookcase got a mid atlas');
      assert.ok(stats.high >= 1 && stats.high <= 6, `sharp atlases within budget: ${stats.high}`);
      const sharp = shelves.cases.filter((cs) => cs.textures.high);
      for (const cs of sharp) {
        const d = Math.hypot(cs.position.x - cam.position.x, cs.position.z - cam.position.z);
        assert.ok(d < 4.5, `sharp only within reading range (${d.toFixed(2)} m)`);
      }
      assert.ok(shelves.cases[0].textures.high, 'the nearest bookcase is sharp');
      assert.equal(shelves.cases[0].material.map, shelves.cases[0].textures.high, 'and shows it');
    } finally {
      shelves.dispose();
    }
  });

  it('makes every bookcase of a small room sharp, even from far away, without mid atlases', () => {
    const shelves = shelvesWith(3);
    try {
      assert.equal(shelves.cases.length, 3);
      const cam = camAt(0, 0); // 7 m from every bookcase: beyond the reading range
      run(shelves, cam, 72 * 30);
      const stats = shelves.lodStats();
      assert.equal(stats.high, 3);
      assert.equal(stats.mid, 0);
      assert.equal(stats.painting, null);
      for (const cs of shelves.cases) assert.equal(cs.material.map, cs.textures.high);
      // Walking far away does not drop them.
      run(shelves, camAt(30, 30), 72 * 10);
      assert.equal(shelves.lodStats().high, 3);
    } finally {
      shelves.dispose();
    }
  });

  it('does not thrash: standing still or swaying causes no repaints once settled', () => {
    const shelves = shelvesWith(16);
    try {
      const p = shelves.cases[3].position;
      const base = { x: p.x * 0.75, z: p.z * 0.75 };
      run(shelves, camAt(base.x, base.z), 72 * 60);
      let painted = 0;
      const orig = shelves._startJob.bind(shelves);
      shelves._startJob = (cs, level) => { painted++; return orig(cs, level); };
      for (let i = 0; i < 72 * 20; i++) {
        const sway = Math.sin(i / 20) * 0.08;
        shelves.update(1 / 72, camAt(base.x + sway, base.z - sway));
      }
      assert.equal(painted, 0);
    } finally {
      shelves.dispose();
    }
  });

  it('walking around repaints a bounded number of atlases and drops far sharp ones', () => {
    const shelves = shelvesWith(20);
    try {
      run(shelves, camAt(0, 0), 72 * 60); // all mids done
      let high = 0;
      const orig = shelves._startJob.bind(shelves);
      shelves._startJob = (cs, level) => { if (level === 'high') high++; return orig(cs, level); };
      // Walk a full circle at 4.5 m radius over 30 s.
      for (let i = 0; i <= 72 * 30; i++) {
        const a = (i / (72 * 30)) * Math.PI * 2;
        shelves.update(1 / 72, camAt(Math.sin(a) * 4.5, -Math.cos(a) * 4.5));
        assert.ok(shelves.lodStats().high <= 6);
      }
      assert.ok(high <= shelves.cases.length + 6, `sharp repaints while walking: ${high}`);
      // Back to the middle (7 m from every bookcase, beyond range + hysteresis): sharp atlases go.
      run(shelves, camAt(0, 0), 72 * 10);
      assert.equal(shelves.lodStats().high, 0);
    } finally {
      shelves.dispose();
    }
  });
});
