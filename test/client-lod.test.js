// Bookshelves (public/js/world/shelves.js) run in Node with a stub 2D canvas: spine-atlas level of
// detail (budget, nearest-first upgrades, hysteresis, time-sliced painting), painting through the
// atlas worker (with a fake worker), and the partial vertex uploads behind hover highlights and
// hidden books.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { BOOKCASE } from '../public/js/config.js';

let Bookshelves;
let packBookcases;
let sortBooks;
let AtlasWorker;
let hallRows;
let behindRow;

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
  ({ Bookshelves, packBookcases, AtlasWorker, hallRows, behindRow } = await import('../public/js/world/shelves.js'));
  ({ sortBooks } = await import('../public/js/util/books.js'));
});

const renderer = { capabilities: { getMaxAnisotropy: () => 16 } };

function shelvesWith(nCases, opts = {}) {
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
  const shelves = new Bookshelves({ renderer, atlasWorker: null, ...opts });
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

  it('while walking: no new sharp atlases, mid ones at most once a second; catches up when still', () => {
    const shelves = shelvesWith(110); // more bookcases than the mid budget (64), like the hall
    try {
      assert.ok(shelves.cases.length > 64, `${shelves.cases.length} bookcases`);
      run(shelves, camAt(0, 0), 72 * 2);
      const started = [];
      const orig = shelves._startJob.bind(shelves);
      shelves._startJob = (cs, level) => { started.push([shelves._clock, level]); return orig(cs, level); };
      // Walk a straight line at 1.2 m/s for 10 s.
      for (let i = 0; i < 72 * 10; i++) shelves.update(1 / 72, camAt(-6 + (i / 72) * 1.2, 0));
      const walking = started.filter(([t]) => t > shelves._clock - 9.5); // once up to speed
      assert.equal(walking.filter(([, l]) => l === 'high').length, 0, 'no sharp atlases while walking');
      const mids = walking.filter(([, l]) => l === 'mid').map(([t]) => t);
      for (let k = 1; k < mids.length; k++) assert.ok(mids[k] - mids[k - 1] >= 0.99, 'mid atlases at most once a second');
      assert.ok(mids.length >= 5, `but some still come: ${mids.length}`);
      // Standing still, the sharp ones come at once.
      started.length = 0;
      run(shelves, camAt(6, 0), 72 * 3);
      assert.ok(started.some(([, l]) => l === 'high'), 'sharp atlases once still');
    } finally {
      shelves.dispose();
    }
  });
});

/** A stand-in for the atlas worker: answers each paint() on a later turn with a fake bitmap. */
function fakeWorker({ fail = false } = {}) {
  const w = {
    scales: [],
    images: [],
    paint(layout, items, label, scale) {
      w.scales.push(scale);
      const image = { width: 4, height: 4, closed: false, close() { this.closed = true; } };
      w.images.push(image);
      return new Promise((resolve, reject) => setImmediate(() => (fail ? reject(new Error('boom')) : resolve(image))));
    },
  };
  return w;
}

const turn = () => new Promise((r) => setImmediate(r));

/** A hall like World._layoutHall: rows of K bookcases back to back, aisles of 2.4 m. */
function hallCases(rows, K) {
  const { width: W, depth: D } = BOOKCASE;
  const step = W + 0.02;
  const cases = [];
  for (let r = 0; r < rows; r++) {
    const zc = -2.5 - r * (2 * D + 2.4);
    for (let k = 0; k < K; k++) cases.push({ position: new THREE.Vector3((k - (K - 1) / 2) * step, 0, zc + D / 2), yaw: 0, row: r, side: 'front', k });
    for (let k = K - 1; k >= 0; k--) cases.push({ position: new THREE.Vector3((k - (K - 1) / 2) * step, 0, zc - D / 2), yaw: Math.PI, row: r, side: 'back', k });
  }
  return cases;
}

describe('hall row culling', () => {
  const eye = (x, z, y = 1.6) => new THREE.Vector3(x, y, z);

  it('finds the rows of a hall, and none in a ring or a single row', () => {
    const cases = hallCases(3, 6);
    const rows = hallRows(cases);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].z, -2.5);
    assert.equal(rows[0].segments.length, 1, 'bookcases 2 cm apart make one solid stretch');
    assert.ok(Math.abs(rows[0].segments[0][1] - rows[0].segments[0][0] - (6 * 1.22 - 0.02)) < 1e-9);
    assert.equal(hallRows(hallCases(1, 6)), null);
    assert.equal(hallRows([{ position: new THREE.Vector3(1, 0, 0), yaw: 0.5 }, { position: new THREE.Vector3(0, 0, 1), yaw: 2 }]), null);
    // A gap wider than a few centimetres splits a row.
    const gappy = hallCases(2, 6).filter((cs) => !(cs.row === 0 && (cs.k === 2 || cs.k === 3)));
    assert.equal(hallRows(gappy)[0].segments.length, 2);
  });

  it('hides bookcases behind a nearer row, never those in view', () => {
    const cases = hallCases(3, 6);
    const rows = hallRows(cases);
    const at = (row, side, k) => cases.find((cs) => cs.row === row && cs.side === side && cs.k === k);
    // From the entrance: the first row's fronts show; the second row's fronts are behind it.
    assert.equal(behindRow(at(0, 'front', 2), eye(0, 3), rows), false);
    assert.equal(behindRow(at(1, 'front', 2), eye(0, 3), rows), true);
    assert.equal(behindRow(at(2, 'front', 0), eye(0, 3), rows), true);
    // Standing in the first aisle, facing the second row: it shows, the third does not.
    assert.equal(behindRow(at(1, 'front', 2), eye(0, -4.1), rows), false);
    assert.equal(behindRow(at(2, 'front', 2), eye(0, -4.1), rows), true);
    // Looking past the end of the first row (from beside the hall) the far bookcase shows.
    assert.equal(behindRow(at(1, 'front', 5), eye(7, 3), rows), false);
    // A gap in the first row lets the view through.
    const gappy = hallCases(3, 6).filter((cs) => !(cs.row === 0 && (cs.k === 2 || cs.k === 3)));
    const g = (row, side, k) => gappy.find((cs) => cs.row === row && cs.side === side && cs.k === k);
    assert.equal(behindRow(g(1, 'front', 2), eye(0, 3), hallRows(gappy)), false);
  });

  it('culls in update: behind rows, and nothing extra from above the rows', () => {
    const books = Array.from({ length: 10 * 90 }, (_, i) => ({ id: String(i), title: `Book ${i}`, author: 'A', libId: 'lib', size: 200000 }));
    const packed = packBookcases(sortBooks(books, 'title'));
    assert.ok(packed.length > 6 && packed.length <= 12, `${packed.length} bookcases fit 3 rows of 2 + 2`);
    const layout = hallCases(3, 2).slice(0, packed.length);
    packed.forEach((cs, i) => { cs.position = layout[i].position; cs.yaw = layout[i].yaw; cs.label = 'A'; });
    const shelves = new Bookshelves({ renderer, atlasWorker: null });
    shelves.build(packed);
    try {
      const shown = (cam) => {
        shelves.update(1 / 72, cam);
        return shelves.cases.filter((cs) => cs.mesh.visible).length;
      };
      const front = camAt(0, 3);
      assert.equal(shown(front), 2, 'only the first row’s two fronts');
      const high = new THREE.Object3D();
      high.position.set(0, 3, 3);
      high.updateMatrixWorld(true);
      assert.equal(shown(high), layout.filter((c) => c.yaw === 0).length, 'from above every front shows');
    } finally {
      shelves.dispose();
    }
  });
});

describe('atlas worker', () => {
  it('loads only relative modules (module workers have no import map, so no three.js)', () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        assert.ok(spec.startsWith('.'), `${path.basename(file)} imports ${spec}`);
        visit(path.resolve(path.dirname(file), spec));
      }
    };
    visit(fileURLToPath(new URL('../public/js/world/atlas-worker.js', import.meta.url)));
    assert.deepEqual([...seen].map((p) => path.basename(p)).sort(), ['atlas-worker.js', 'atlas.js', 'books.js', 'config.js', 'textures.js']);
  });

  it('paints every level in the worker, never on the main thread', async () => {
    const worker = fakeWorker();
    const shelves = shelvesWith(3, { atlasWorker: worker });
    try {
      // Built: low atlases requested for every bookcase, a placeholder shown meanwhile.
      assert.deepEqual(worker.scales, [0.125, 0.125, 0.125]);
      const placeholder = shelves.cases[0].material.map;
      assert.ok(shelves.cases.every((cs) => cs.material.map === placeholder && !cs.textures.low));
      await shelves.ready();
      for (const cs of shelves.cases) {
        assert.ok(worker.images.includes(cs.textures.low.image), 'low atlas from the worker');
        assert.equal(cs.material.map, cs.textures.low);
      }
      for (let i = 0; i < 50 && shelves.lodStats().high < 3; i++) {
        shelves.update(1 / 72, camAt(0, 0));
        assert.equal(shelves._job?.painter, undefined, 'no main-thread painter');
        await turn();
      }
      assert.equal(shelves.lodStats().high, 3);
      assert.deepEqual(worker.scales, [0.125, 0.125, 0.125, 1, 1, 1]);
      for (const cs of shelves.cases) assert.ok(worker.images.includes(cs.material.map.image), 'shows the worker bitmap');
    } finally {
      shelves.dispose();
    }
  });

  it('frees bitmaps that arrive after the room was rebuilt', async () => {
    const worker = fakeWorker();
    const shelves = shelvesWith(3, { atlasWorker: worker });
    shelves.update(1 / 72, camAt(0, 0));
    assert.ok(shelves._job, 'a sharp atlas is in flight too');
    shelves.dispose();
    await turn();
    assert.equal(worker.images.length, 4, 'three low, one sharp');
    assert.ok(worker.images.every((im) => im.closed));
  });

  it('sends the worker what the spine art needs, including a Wikipedia volume’s number and range', () => {
    const posted = [];
    const w = new AtlasWorker({ postMessage: (m) => posted.push(m) });
    const dims = { w: 0.05, h: 0.3, d: 0.2 };
    w.paint({}, [
      { book: { id: 'b1', title: 'A Book', author: 'Someone', cover: 'x.jpg', size: 1000 }, dims },
      { book: { id: 'v7', title: 'Aa – Ac', author: 'Wikipedia', volume: 7, range: ['Aa', 'Ac'], emblem: 'e.png' }, dims },
    ], 'Aa – Ac', 1);
    assert.deepEqual(posted[0].items.map((it) => it.book), [
      { id: 'b1', title: 'A Book', author: 'Someone' },
      { id: 'v7', title: 'Aa – Ac', author: 'Wikipedia', volume: 7, range: ['Aa', 'Ac'] },
    ]);
  });

  it('falls back to painting on the main thread when the worker fails', async () => {
    const shelves = shelvesWith(3, { atlasWorker: fakeWorker({ fail: true }) });
    const warn = console.warn;
    console.warn = () => {};
    try {
      shelves.update(1 / 72, camAt(0, 0));
      await turn();
      assert.equal(shelves._worker, null);
      assert.equal(shelves._job, null, 'the failed job is dropped');
      await shelves.ready();
      assert.ok(shelves.cases.every((cs) => cs.textures.low && cs.material.map === cs.textures.low), 'low atlases painted here instead');
      run(shelves, camAt(0, 0), 72 * 10);
      assert.equal(shelves.lodStats().high, 3, 'painted on the main thread instead');
    } finally {
      console.warn = warn;
      shelves.dispose();
    }
  });
});

describe('pointer rays on the shelves', () => {
  const D = BOOKCASE.depth;
  const ray = (origin, dir) => {
    const rc = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...dir).normalize());
    rc.far = 30;
    return rc;
  };

  it('reach books through the open front, and stop at the back panel when picking is off', () => {
    const shelves = shelvesWith(16); // a ring of radius 7; bookcase 0 at (0, 0, -7) faces the centre
    try {
      const hit = shelves.raycast(ray([0, 1.2, 0], [0, 0, -1]));
      assert.ok(hit.book, 'a book');
      assert.ok(hit.distance > 7 - D / 2 && hit.distance < 7 + D / 2, String(hit.distance));
      const wood = shelves.raycast(ray([0, 1.2, 0], [0, 0, -1]), { books: false });
      assert.equal(wood.book, null);
      assert.ok(Math.abs(wood.distance - (7 + D / 2 - 0.018)) < 1e-6, 'the back panel');
    } finally {
      shelves.dispose();
    }
  });

  it('never pass through a bookcase seen from behind into the one beyond', () => {
    const shelves = shelvesWith(16);
    try {
      // From behind bookcase 0, aiming across the ring at bookcase 8, whose books face this way.
      const hit = shelves.raycast(ray([0, 1.2, -20], [0, 0, 1]));
      assert.equal(hit.book, null);
      assert.ok(Math.abs(hit.distance - (13 - D / 2)) < 1e-6, 'stops at the back of bookcase 0');
      assert.ok(Math.abs(hit.point.z - (-7 - D / 2)) < 1e-6);
    } finally {
      shelves.dispose();
    }
  });

  it('stop at the side panels and at a shelf board', () => {
    const shelves = shelvesWith(1);
    try {
      const side = shelves.raycast(ray([-5, 1.2, -7], [1, 0, 0]));
      assert.equal(side.book, null);
      assert.ok(Math.abs(side.distance - (5 - BOOKCASE.width / 2)) < 1e-6);
      // Straight down through the open front, just in front of the books: the board's front lip.
      const down = shelves.raycast(ray([0, 1.9, -7 + D / 2 - 0.015], [0, -1, 0]));
      assert.equal(down.book, null);
      assert.ok(down.distance > 0.01 && down.distance < 0.6, `a board, not the floor: ${down.distance}`);
      // From inside the opening out through the open front: nothing of this bookcase is in the way.
      assert.equal(shelves.raycast(ray([0, 1.2, -7 + D / 2 - 0.015], [0, 0, 1])), null);
    } finally {
      shelves.dispose();
    }
  });
});

describe('huge rooms (all libraries in one hall)', () => {
  it('keeps mid atlases only for the nearest bookcases', () => {
    const shelves = shelvesWith(100);
    try {
      run(shelves, camAt(0, 0), 72 * 60);
      assert.equal(shelves.lodStats().mid, 64, 'the mid budget, then no more');
      // Walk to one side: far mid atlases go, near ones come, never more than budget + slack.
      for (let i = 0; i <= 72 * 30; i++) {
        shelves.update(1 / 72, camAt((i / (72 * 30)) * 6, 0));
        assert.ok(shelves.lodStats().mid <= 80);
      }
      run(shelves, camAt(6, 0), 72 * 30);
      const cam = camAt(6, 0).position;
      const byDistance = [...shelves.cases].sort((a, b) => a.position.distanceTo(cam) - b.position.distanceTo(cam));
      assert.ok(byDistance.slice(0, 64).every((cs) => cs.textures.mid || cs.textures.high), 'the nearest 64 all have one');
    } finally {
      shelves.dispose();
    }
  });

  it('hides the books of bookcases seen from behind', () => {
    const shelves = shelvesWith(16); // a ring of bookcases facing its centre
    try {
      shelves.update(1 / 72, camAt(0, 0));
      assert.ok(shelves.cases.every((cs) => cs.mesh.visible), 'all visible from the middle');
      shelves.update(1 / 72, camAt(0, -20)); // outside the ring, behind the bookcase at (0, -7)
      assert.equal(shelves.cases[0].mesh.visible, false);
      assert.equal(shelves.cases[8].mesh.visible, true, 'the one across the ring faces us');
    } finally {
      shelves.dispose();
    }
  });
});

/**
 * Mirrors three's WebGLAttributes upload of a position attribute: the first upload sends the whole
 * array; later ones (when the version changed) send only the update ranges, or everything if there
 * are none, and then clear the ranges.
 */
function gpuMirror(attr) {
  let gpu = null;
  let version = -1;
  return {
    upload() {
      if (!gpu) {
        gpu = attr.array.slice();
      } else if (version < attr.version) {
        if (!attr.updateRanges.length) gpu.set(attr.array);
        for (const r of attr.updateRanges) gpu.set(attr.array.subarray(r.start, r.start + r.count), r.start);
        attr.clearUpdateRanges();
      }
      version = attr.version;
      return gpu;
    },
  };
}

describe('shelf vertex uploads', () => {
  it('a book stays visible when the hover moves straight to its neighbour', () => {
    const shelves = shelvesWith(1);
    try {
      const cs = shelves.cases[0];
      const attr = cs.mesh.geometry.attributes.position;
      const gpu = gpuMirror(attr);
      gpu.upload();
      const [a, b, c] = cs.records.filter((r) => r.range.count).slice(0, 3).map((r) => r.book);
      const frame = (fn) => { fn(); return gpu.upload(); };
      // Sweeping the laser sideways along a shelf: one book to the next with no gap frame.
      for (const step of [() => shelves.setHighlight(a), () => shelves.setHighlight(b), () => shelves.setHighlight(c),
        () => shelves.setHighlight(null), () => { shelves.setHighlight(a); shelves.hideBook(a); },
        () => { shelves.showBook(a); shelves.setHighlight(b); }, () => shelves.setHighlight(null)]) {
        assert.deepEqual(frame(step), attr.array, 'the GPU copy matches the CPU vertices');
      }
      assert.deepEqual(attr.array, cs.original, 'every book back on the shelf');
    } finally {
      shelves.dispose();
    }
  });
});
