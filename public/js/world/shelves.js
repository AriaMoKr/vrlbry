// Bookcases and the books on them (SPEC §5.3).
//
// Performance model (Quest): all bookcase woodwork is one merged mesh; each bookcase's books are
// one merged mesh textured by that bookcase's spine atlas (which also holds its range label), so
// the whole library costs 1 + N draw calls. Picking uses per-book AABBs in bookcase space. A taken
// book is hidden by collapsing its vertices; a hovered book is drawn by a separate pulled-out copy.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOOKCASE } from '../config.js';
import { bookDims, hash01, titleKey, authorKey } from '../util/books.js';
import { makeSpineCanvas, makeWoodCanvas } from './textures.js';
import { canvasTexture, disposeTexture } from './canvas-texture.js';
import { atlasLayout, atlasPainter, STRIPE } from './atlas.js';
import { perf } from '../perf.js';

const { width: W, height: H, depth: D, shelves: ROWS, bottom: BOTTOM, side: SIDE, board: BOARD } = BOOKCASE;
export const TOP_TRIM = 0.14;
export const ROW_PITCH = (H - BOTTOM - TOP_TRIM) / ROWS;
const PAD = 0.012; // clearance between the side panels and the outermost books
export const USABLE = W - 2 * SIDE - 2 * PAD;
const PLATE = { w: 0.42, h: 0.064 }; // label plate on the bookcase (m)
// Where a pointer ray may travel inside a bookcase (bookcase space): its open front, between the
// side panels, the base and the frieze, back to the back panel. Everything else is wood, and so
// are the shelf boards (each with its front lip) crossing the opening.
const OPENING = new THREE.Box3(
  new THREE.Vector3(-W / 2 + SIDE, BOTTOM, -D / 2 + 0.018), new THREE.Vector3(W / 2 - SIDE, H - TOP_TRIM, D / 2 + 0.05),
);
const SHELF_BOARDS = Array.from({ length: ROWS - 1 }, (_, i) => {
  const y = BOTTOM + (i + 1) * ROW_PITCH;
  return new THREE.Box3(new THREE.Vector3(-W / 2 + SIDE, y - 0.034, -D / 2), new THREE.Vector3(W / 2 - SIDE, y, D / 2 - 0.01));
});
const _inner = new THREE.Ray();

/** Distance along a ray that starts inside (or on) a box to where it leaves the box. */
function exitDistance(ray, box) {
  let t = Infinity;
  for (const a of ['x', 'y', 'z']) {
    const d = ray.direction[a];
    if (Math.abs(d) > 1e-12) t = Math.min(t, ((d > 0 ? box.max[a] : box.min[a]) - ray.origin[a]) / d);
  }
  return Math.max(0, t);
}
const Y90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
// Spine atlas levels of detail (scale of the full-resolution layout). Low (coloured bands and the
// label plate) is requested for every bookcase when a room is built; mid (small but real titles) is
// painted for every bookcase, nearest first; high (legible titles) only for the few bookcases near
// enough to read — on a Quest 3 spine titles are legible within ~4 m. All levels are painted in a
// worker (AtlasWorker) where the browser allows; otherwise low is painted during build() and mid
// and high are spread over frames (JOB_BUDGET_MS each), so walking or switching rooms never stalls
// rendering. Dropping a level is just a texture swap.
const LEVELS = { low: 0.125, mid: 0.25, high: 1 };
const HIGH_BUDGET = 6; // sharp atlases kept at once (~16 MB of GPU memory each)
const HIGH_RANGE = 4.5; // metres (horizontal) within which a bookcase gets a sharp atlas
const HYSTERESIS = 1.5; // metres of slack before a sharp atlas is dropped or displaced
const JOB_BUDGET_MS = 3; // canvas painting per frame, when painting on the main thread
// In a room of more bookcases than this (only the all-libraries room), only the nearest MID_BUDGET
// keep a mid atlas (~1 MB of GPU memory each), dropped once more than MID_SLACK places further
// out; the rest show the low one.
const MID_BUDGET = 64;
const MID_SLACK = 16;
// While the viewer walks, atlases change less (each finished atlas risked a dropped frame on a
// Quest 3): no new sharp ones, and at most one mid atlas per MID_MOVING_INTERVAL s in a large
// room. Standing still, they catch up at once.
const MOVING_SPEED = 0.4; // m/s (horizontal, smoothed) above which the viewer is walking
const STILL_SPEED = 0.15; // … and below which they stand still again
const TELEPORT_SPEED = 10; // m/s: a jump this fast is a teleport, not walking
const MID_MOVING_INTERVAL = 1;
/** ?atlas=gpu: paint atlases on a GPU-backed canvas in the worker (the old way, for comparison). */
const ATLAS_GPU = typeof location !== 'undefined' && /[?&]atlas=gpu(&|$)/.test(location.search);

let placeholderTex = null;
/**
 * What a bookcase shows until its low atlas arrives from the worker: plain dark cloth. Sharing
 * one texture (never disposed) keeps the material's map set, so the atlas swaps in without a
 * shader recompile.
 */
function placeholder() {
  if (!placeholderTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const g = c.getContext('2d');
    g.fillStyle = '#3b2417';
    g.fillRect(0, 0, 4, 4);
    placeholderTex = canvasTexture(c, { anisotropy: 1 });
  }
  return placeholderTex;
}

/** Height of the surface books stand on, for shelf row r counted from the top (0 = top row). */
export function rowSurface(r) {
  return BOTTOM + (ROWS - 1 - r) * ROW_PITCH;
}

const keyOf = (book) => `${book.libId}\n${book.id}`;

/** A book's footprint on a shelf: its dimensions and the small deterministic gap after it. */
function shelfEntry(book) {
  return { book, dims: bookDims(book), gap: 0.0015 + 0.003 * hash01(String(book.id), 'gap') };
}
const ROW_FILL = USABLE * 0.85; // rows are filled to ~85 %, so shelves look lived-in

/** How many bookcases packBookcases uses for these books. */
export function bookcasesNeeded(books) {
  if (!books.length) return 0;
  const total = books.reduce((s, b) => { const e = shelfEntry(b); return s + e.dims.w + e.gap; }, 0);
  return Math.ceil(Math.max(1, Math.ceil(total / ROW_FILL)) / ROWS);
}

/** The longest prefix of (sorted) books that packBookcases fits into `cases` bookcases. */
export function prefixForBookcases(books, cases) {
  const limit = cases * ROWS * ROW_FILL;
  let total = 0;
  let n = 0;
  for (; n < books.length; n++) {
    const e = shelfEntry(books[n]);
    if (total + e.dims.w + e.gap > limit) break;
    total += e.dims.w + e.gap;
  }
  return books.slice(0, n);
}

/**
 * Shares `max` bookcases between libraries needing `needs[i]`: every library gets an equal
 * share; one that needs less is shelved whole and leaves the rest to the others (max-min fair).
 * @returns {number[]} bookcases per library (each ≤ its need, summing to ≤ max)
 */
export function shareBookcases(needs, max) {
  const quota = needs.map(() => 0);
  let left = max;
  let open = needs.map((_, i) => i).filter((i) => needs[i] > 0);
  while (open.length && left > 0) {
    const share = Math.floor(left / open.length);
    const whole = open.filter((i) => needs[i] - quota[i] <= share);
    if (whole.length) {
      for (const i of whole) {
        left -= needs[i] - quota[i];
        quota[i] = needs[i];
      }
      open = open.filter((i) => !whole.includes(i));
      continue;
    }
    for (const i of open) quota[i] += share;
    left -= share * open.length;
    for (const i of open.slice(0, left)) quota[i]++; // the remainder, one each, in order
    break;
  }
  return quota;
}

/**
 * Distributes sorted books into bookcases: rows top→bottom, books left→right, with small
 * deterministic gaps. Rows are filled evenly (~85 %) rather than packed, so the last bookcase is
 * never nearly empty and shelves look lived-in. Each row aims at the remaining width over the
 * remaining rows, so rows that end a little short do not pile up into an extra bookcase: the
 * result has exactly bookcasesNeeded() bookcases.
 * @param {object[]} books sorted book descriptors (with libId)
 * @returns {Array<{ items: Array<{ book, dims, row: number, x: number }> }>} x = book centre
 */
export function packBookcases(books) {
  const entries = books.map(shelfEntry);
  const total = entries.reduce((s, e) => s + e.dims.w + e.gap, 0);
  const rowsNeeded = Math.max(1, Math.ceil(total / ROW_FILL));
  const caseCount = Math.ceil(rowsNeeded / ROWS);
  const cases = [];
  let cur = null;
  let row = ROWS;
  let x = 0;
  let filled = 0;
  let target = 0; // this row's length goal
  let remaining = total; // width of the books not placed yet
  let rowsLeft = caseCount * ROWS; // planned rows not started yet
  for (const { book, dims, gap } of entries) {
    // New row when the book does not fit, or when this row has reached its share and the book
    // would overshoot it by more than half its own thickness (never on the last planned row,
    // which takes whatever is left).
    const overshoot = filled + dims.w - target > dims.w / 2;
    if (!cur || x + dims.w > USABLE / 2 + 1e-6 || (filled > 0 && overshoot && rowsLeft > 0)) {
      filled = 0;
      row++;
      x = -USABLE / 2;
      if (!cur || row >= ROWS) {
        cur = { items: [] };
        cases.push(cur);
        row = 0;
      }
      target = Math.min(USABLE, remaining / Math.max(1, rowsLeft));
      rowsLeft--;
    }
    cur.items.push({ book, dims, row, x: x + dims.w / 2 });
    x += dims.w + gap;
    filled += dims.w + gap;
    remaining -= dims.w + gap;
  }
  return cases;
}

/** Range label of a bookcase under a sort mode, e.g. "Ab – Ch", "Bar – Hob", "#1 – #138". */
export function rangeLabel(items, sort) {
  if (!items.length) return '';
  const a = items[0].book;
  const b = items[items.length - 1].book;
  if (sort === 'popularity' && a.rank != null && b.rank != null) return `#${a.rank} – #${b.rank}`;
  const key = sort === 'author'
    ? (bk) => {
      // Various / Anonymous sort last under a 'zzzz' key; show the real word instead.
      const k = authorKey(bk.author);
      return k.startsWith('zzzz ') ? cap(k.slice(5), 4) : cap(k.split(' ')[0], 3);
    }
    : (bk, end) => cap(titleKey(bk.range ? bk.range[end ? 1 : 0] : bk.title), 2); // volumes: first/last article
  return `${key(a, false)} – ${key(b, true)}`;
}

function cap(s, n) {
  const t = (s || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, n) || '#';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------------------------------------
// Woodwork

let woodMaterial = null;
function getWoodMaterial() {
  if (!woodMaterial) {
    const tex = canvasTexture(makeWoodCanvas({ w: 1024, h: 256, base: '#4b2b17', dark: '#2a160a', light: '#6a4126', seed: 9 }));
    woodMaterial = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  }
  return woodMaterial;
}

function shadedBox(w, h, d, x, y, z, shade) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3).fill(shade);
  // Faces facing the back panel / downward get darker: crude ambient occlusion.
  const nrm = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    let s = shade;
    if (nrm.getY(i) < -0.5) s *= 0.55;
    if (nrm.getZ(i) < -0.5) s *= 0.7;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

let woodPrototype = null;
/** One bookcase's woodwork in its local frame (floor centre origin, front facing +Z). */
function bookcaseWood() {
  if (woodPrototype) return woodPrototype;
  const parts = [];
  const inner = W - 2 * SIDE;
  parts.push(shadedBox(W, BOTTOM, D - 0.02, 0, BOTTOM / 2, -0.01, 0.75)); // plinth
  parts.push(shadedBox(W + 0.02, 0.02, D + 0.01, 0, 0.01, 0.0, 0.5)); // base shoe
  for (const s of [-1, 1]) parts.push(shadedBox(SIDE, H - TOP_TRIM + 0.01, D, s * (W / 2 - SIDE / 2), (H - TOP_TRIM) / 2, 0, 0.9));
  parts.push(shadedBox(inner, H - BOTTOM - TOP_TRIM, 0.018, 0, BOTTOM + (H - BOTTOM - TOP_TRIM) / 2, -D / 2 + 0.009, 0.42)); // back
  for (let i = 1; i < ROWS; i++) {
    const y = BOTTOM + i * ROW_PITCH;
    parts.push(shadedBox(inner, BOARD, D - 0.03, 0, y - BOARD / 2, -0.015, 0.82));
    parts.push(shadedBox(inner, 0.034, 0.02, 0, y - 0.017, D / 2 - 0.02, 0.95)); // front lip
  }
  // Crown: frieze + overhanging cornice + a small bead.
  parts.push(shadedBox(W, TOP_TRIM - 0.06, D, 0, H - TOP_TRIM + (TOP_TRIM - 0.06) / 2, 0, 0.92));
  parts.push(shadedBox(W + 0.08, 0.035, D + 0.05, 0, H - 0.0425, 0.025, 1.0));
  parts.push(shadedBox(W + 0.11, 0.025, D + 0.065, 0, H - 0.0125, 0.0325, 0.96));
  parts.push(shadedBox(W + 0.02, 0.015, D + 0.015, 0, H - TOP_TRIM + 0.0075, 0.0075, 0.85));
  woodPrototype = mergeGeometries(parts);
  return woodPrototype;
}

// ---------------------------------------------------------------------------------------------
// Book geometry

/** UV rect (normalized, v up) of a pixel rect in an atlas of size W×H. */
function uvRect(r, aw, ah, inset = 0.5) {
  return {
    u0: (r.x + inset) / aw, u1: (r.x + r.w - inset) / aw,
    v0: 1 - (r.y + r.h - inset) / ah, v1: 1 - (r.y + inset) / ah,
  };
}

/**
 * Appends one upright book (bookcase frame: thickness along x, depth along z, spine at +z).
 * @returns {{ start: number, count: number }} vertex range
 */
function appendBook(arr, cx, cy, cz, dims, spine, cloth, page, shade) {
  const hw = dims.w / 2;
  const hh = dims.h / 2;
  const hd = dims.d / 2;
  const start = arr.pos.length / 3;
  // [normal, 4 corners (ccw seen from outside), uv rect, uv mode, shade]
  const faces = [
    [[0, 0, 1], [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], spine, 1.0], // spine
    [[0, 1, 0], [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], page, 0.6], // top: page edges
    [[1, 0, 0], [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], cloth, 0.6], // front cover
    [[-1, 0, 0], [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]], cloth, 0.6], // back cover
    [[0, 0, -1], [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]], cloth, 0.3],
    [[0, -1, 0], [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]], cloth, 0.3],
  ];
  for (const [n, corners, r, s] of faces) {
    const base = arr.pos.length / 3;
    const uvs = [[r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]];
    corners.forEach(([x, y, z], i) => {
      arr.pos.push(cx + x, cy + y, cz + z);
      arr.nrm.push(n[0], n[1], n[2]);
      arr.uv.push(uvs[i][0], uvs[i][1]);
      const k = s * shade;
      arr.col.push(k, k, k);
    });
    arr.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { start, count: arr.pos.length / 3 - start };
}

function buildGeometry(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
  g.setIndex(arr.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---------------------------------------------------------------------------------------------

/**
 * Paints atlases in a module worker on an OffscreenCanvas (atlas-worker.js), so neither the
 * drawing nor the canvas rasterization it triggers runs on the main thread, which only uploads
 * the finished ImageBitmap. Even time-sliced, main-thread painting caused frame spikes: the
 * browser defers canvas rasterization to the upload.
 */
export class AtlasWorker {
  /** @returns {AtlasWorker|null} null where module workers or OffscreenCanvas are missing */
  static create() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
    try {
      return new AtlasWorker(new Worker(new URL('./atlas-worker.js', import.meta.url), { type: 'module' }));
    } catch {
      return null;
    }
  }

  constructor(worker) {
    this.worker = worker;
    this.pending = new Map();
    this.seq = 0;
    this.failed = null; // a worker that failed to start never answers: reject every later request
    worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (!p) data.bitmap?.close();
      else if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.bitmap);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.failed = new Error(e.message || 'the atlas worker failed to start');
      for (const p of this.pending.values()) p.reject(this.failed);
      this.pending.clear();
    };
  }

  /** @returns {Promise<ImageBitmap>} */
  paint(layout, items, label, scale) {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Only what the spine art reads (textures.js drawSpine): whole book descriptors would be
      // cloned for nothing. A Wikipedia volume's spine needs its number and range.
      const slim = items.map(({ book, dims }) => ({
        book: book.volume
          ? { id: book.id, title: book.title, author: book.author, volume: book.volume, range: book.range }
          : { id: book.id, title: book.title, author: book.author },
        dims,
      }));
      this.worker.postMessage({ id, layout, items: slim, label, scale, gpu: ATLAS_GPU });
    });
  }

  /** Stops the worker; requests still waiting are rejected (so callers can paint them elsewhere). */
  terminate() {
    this.worker.terminate();
    this.failed ||= new Error('the atlas worker was stopped');
    for (const p of this.pending.values()) p.reject(this.failed);
    this.pending.clear();
  }
}

/** Gaps in a row narrower than this still block the view (bookcases stand 2 cm apart). */
const ROW_GAP = 0.05;
/** Margin at a row's plane before it counts as hiding a bookcase: both eyes, the row's ends. */
const ROW_MARGIN = 0.1;

/**
 * The rows of a hall: bookcases back to back, facing ±z (yaw 0 or π). Each row is the plane
 * where their backs meet, and the solid stretches along it (`segments`, [x0, x1]). Each case
 * gets its row's `rowZ`. Null for other layouts (the rotunda) and for a single row.
 */
export function hallRows(cases) {
  if (!cases.length || !cases.every((cs) => cs.yaw === 0 || cs.yaw === Math.PI)) return null;
  const { width: W, depth: D } = BOOKCASE;
  const byZ = new Map();
  for (const cs of cases) {
    cs.rowZ = Math.round((cs.position.z + (cs.yaw === 0 ? -D / 2 : D / 2)) * 100) / 100;
    if (!byZ.has(cs.rowZ)) byZ.set(cs.rowZ, []);
    byZ.get(cs.rowZ).push([cs.position.x - W / 2, cs.position.x + W / 2]);
  }
  if (byZ.size < 2) return null;
  return [...byZ].map(([z, spans]) => {
    spans.sort((a, b) => a[0] - b[0]);
    const segments = [];
    for (const [x0, x1] of spans) {
      const last = segments[segments.length - 1];
      if (last && x0 <= last[1] + ROW_GAP) last[1] = Math.max(last[1], x1);
      else segments.push([x0, x1]);
    }
    return { z, segments };
  });
}

/**
 * True when a hall row stands between the viewer (below the top of the rows) and a bookcase's
 * front: the front, projected from the eye onto that row's plane, falls within one of its solid
 * stretches.
 */
export function behindRow(cs, cam, rows) {
  const { width: W, depth: D } = BOOKCASE;
  const fz = cs.position.z + (cs.yaw === 0 ? D / 2 : -D / 2); // the plane of its front
  for (const r of rows) {
    if (r.z === cs.rowZ || (r.z - cam.z) * (r.z - fz) >= 0) continue; // not in between
    const t = (r.z - cam.z) / (fz - cam.z);
    const xa = cam.x + (cs.position.x - W / 2 - cam.x) * t;
    const xb = cam.x + (cs.position.x + W / 2 - cam.x) * t;
    const lo = Math.min(xa, xb);
    const hi = Math.max(xa, xb);
    for (const [s0, s1] of r.segments) if (lo >= s0 + ROW_MARGIN && hi <= s1 - ROW_MARGIN) return true;
  }
  return false;
}

export class Bookshelves {
  /**
   * @param {{ renderer: THREE.WebGLRenderer, atlasWorker?: { paint(layout, items, label, scale): Promise<ImageBitmap> } | null }} o
   *   atlasWorker: defaults to a real worker when the browser supports one; null paints on the
   *   main thread (tests pass a fake)
   */
  constructor({ renderer, atlasWorker }) {
    this.renderer = renderer;
    this._worker = atlasWorker !== undefined ? atlasWorker : AtlasWorker.create();
    this.group = new THREE.Group();
    this.group.name = 'bookshelves';
    this.cases = [];
    this._rows = null; // hall rows, for culling bookcases behind them (hallRows)
    this._records = new Map(); // key -> record
    this._order = [];
    this._highlight = null;
    this._lodTimer = 0;
    this._job = null; // atlas being painted: { cs, level, painter } on the main thread, { cs, level, done, image } in the worker
    this._gen = 0; // bumped by every build/dispose: late worker results for an old room are dropped
    this._lows = Promise.resolve();
    this._ray = new THREE.Ray();
    this._inv = new THREE.Matrix4();
    this._tmp = new THREE.Vector3();
  }

  /**
   * Builds bookcases.
   * @param {Array<{ items, position: THREE.Vector3, yaw: number, label: string }>} cases packed
   *   bookcases (packBookcases) with their placement
   */
  build(cases) {
    this.dispose();
    const woodParts = [];
    cases.forEach((cs, ci) => {
      const g = new THREE.Group();
      g.position.copy(cs.position);
      g.rotation.y = cs.yaw;
      g.updateMatrixWorld(true);
      const wood = bookcaseWood().clone();
      wood.applyMatrix4(g.matrixWorld);
      woodParts.push(wood);

      const layout = atlasLayout(cs.items);
      const mat = new THREE.MeshLambertMaterial({ map: placeholder(), vertexColors: true });
      const arr = { pos: [], nrm: [], uv: [], col: [], idx: [] };
      const pageUV = uvRect(layout.page, layout.width, layout.height, 2);
      const records = [];
      cs.items.forEach((it, i) => {
        const cell = layout.cells[i];
        const spineUV = uvRect(cell, layout.width, layout.height);
        const clothUV = uvRect({ x: cell.x + cell.w + 1, y: cell.y + 4, w: STRIPE - 2, h: cell.h - 8 }, layout.width, layout.height);
        const surface = rowSurface(it.row);
        const jitter = 0.012 * hash01(String(it.book.id), 'z');
        const cz = D / 2 - 0.022 - jitter - it.dims.d / 2;
        const cy = surface + it.dims.h / 2;
        const shade = 0.82 + 0.18 * (1 - it.row / (ROWS - 1)); // lower rows a little darker
        const range = appendBook(arr, it.x, cy, cz, it.dims, spineUV, clothUV, pageUV, shade);
        const rec = {
          book: it.book, dims: it.dims, caseIndex: ci, row: it.row,
          center: new THREE.Vector3(it.x, cy, cz),
          box: new THREE.Box3(
            new THREE.Vector3(it.x - it.dims.w / 2, cy - it.dims.h / 2, cz - it.dims.d / 2),
            new THREE.Vector3(it.x + it.dims.w / 2, cy + it.dims.h / 2, cz + it.dims.d / 2),
          ),
          range, hidden: false,
        };
        records.push(rec);
        this._records.set(keyOf(it.book), rec);
        this._order.push(it.book);
      });
      // Range label plate on the frieze.
      const lab = uvRect(layout.label, layout.width, layout.height);
      const py = H - TOP_TRIM + (TOP_TRIM - 0.06) / 2 + 0.002;
      const pz = D / 2 + 0.002;
      const base = arr.pos.length / 3;
      [[-PLATE.w / 2, -PLATE.h / 2, lab.u0, lab.v0], [PLATE.w / 2, -PLATE.h / 2, lab.u1, lab.v0],
        [PLATE.w / 2, PLATE.h / 2, lab.u1, lab.v1], [-PLATE.w / 2, PLATE.h / 2, lab.u0, lab.v1]].forEach(([x, y, u, v]) => {
        arr.pos.push(x, py + y, pz);
        arr.nrm.push(0, 0, 1);
        arr.uv.push(u, v);
        arr.col.push(1.1, 1.1, 1.1);
      });
      arr.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);

      const geo = buildGeometry(arr);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `books-${ci}`;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
      g.matrixAutoUpdate = false;
      this.group.add(g);
      const original = geo.attributes.position.array.slice();
      this.cases.push({
        index: ci, group: g, mesh, material: mat, layout, items: cs.items, label: cs.label,
        textures: { low: null, mid: null, high: null }, records, original, position: cs.position.clone(), yaw: cs.yaw,
        box: new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2), new THREE.Vector3(W / 2, H, D / 2 + 0.05)),
      });
    });
    this._rows = hallRows(this.cases);
    if (woodParts.length) {
      const woodGeo = mergeGeometries(woodParts);
      woodParts.forEach((p) => p.dispose());
      this.woodMesh = new THREE.Mesh(woodGeo, getWoodMaterial());
      this.woodMesh.name = 'bookcase-wood';
      this.woodMesh.matrixAutoUpdate = false;
      this.group.add(this.woodMesh);
    }
    const gen = ++this._gen;
    const t0 = performance.now();
    this._lows = Promise.all(this.cases.map((cs) => this._paintLow(cs, gen)));
    this._lows.then(() => {
      if (gen === this._gen) perf.event('lows', { t: t0, ms: performance.now() - t0, bookcases: this.cases.length, worker: !!this._worker });
    });
  }

  /**
   * Resolves once every bookcase of the current room shows its low atlas (immediately when they
   * were painted on the main thread). World.build waits for it, behind the fade.
   */
  ready() {
    return this._lows;
  }

  /** A bookcase's low atlas: from the worker, or painted here and now without one. */
  async _paintLow(cs, gen) {
    if (this._worker) {
      try {
        const image = await this._worker.paint(cs.layout, cs.items, cs.label, LEVELS.low);
        if (gen !== this._gen) return void image.close?.();
        cs.textures.low = canvasTexture(image, { anisotropy: 1 });
        this._applyTexture(cs);
        return;
      } catch (err) {
        if (gen !== this._gen) return;
        this._workerFailed(err);
      }
    }
    const painter = atlasPainter(cs.layout, cs.items, cs.label, LEVELS.low);
    painter.step();
    cs.textures.low = canvasTexture(painter.canvas, { anisotropy: 1 });
    this._applyTexture(cs);
  }

  /** Never retries a failing worker: everything is painted on the main thread from then on. */
  _workerFailed(err) {
    if (!this._worker) return;
    console.warn(`vrlbry: atlas worker failed (${err.message}); painting on the main thread`);
    const worker = this._worker;
    this._worker = null;
    worker.terminate?.();
  }

  /** Book descriptors in shelf order. */
  books() {
    return this._order.slice();
  }

  _rec(book) {
    return book ? this._records.get(keyOf(book)) : undefined;
  }

  /**
   * What a pointer ray meets on the shelves: the nearest visible book (when `books`), else the
   * bookcase itself (`book: null`), which stops the laser. Bookcases are solid except for their
   * open front: a ray reaches books only through it, and never passes through a back, side, top
   * or shelf board into the bookcase behind.
   * @returns {{ book: object|null, distance: number, point: THREE.Vector3 }|null}
   */
  raycast(raycaster, { books = true } = {}) {
    let best = null;
    const ray = this._ray;
    const at = this._tmp;
    for (const cs of this.cases) {
      this._inv.copy(cs.group.matrixWorld).invert();
      ray.copy(raycaster.ray).applyMatrix4(this._inv);
      const inside = cs.box.containsPoint(ray.origin);
      if (!inside && !ray.intersectBox(cs.box, at)) continue;
      const entry = inside ? 0 : ray.origin.distanceTo(at);
      if (entry > raycaster.far || (best && entry >= best.distance)) continue;
      const p = inside ? ray.origin : at;
      // In the opening: entering through the open front, or starting inside it (a hand reaching in).
      const throughFront = inside ? OPENING.containsPoint(p)
        : ray.direction.z < 0 && p.z >= cs.box.max.z - 1e-6
          && p.x > OPENING.min.x && p.x < OPENING.max.x && p.y > OPENING.min.y && p.y < OPENING.max.y;
      let nearest = entry; // the frame, a side, the back or the top
      let book = null;
      if (throughFront) {
        // Wood where the ray leaves the opening (none if it leaves through the open front), or a
        // shelf board it crosses first.
        _inner.origin.copy(p);
        _inner.direction.copy(ray.direction);
        const out = exitDistance(_inner, OPENING);
        nearest = p.z + ray.direction.z * out >= OPENING.max.z - 1e-6 ? Infinity : entry + out;
        for (const board of SHELF_BOARDS) {
          if (ray.intersectBox(board, at)) nearest = Math.min(nearest, ray.origin.distanceTo(at));
        }
        if (books) {
          for (const rec of cs.records) {
            if (rec.hidden || !ray.intersectBox(rec.box, at)) continue;
            const d = ray.origin.distanceTo(at);
            if (d <= nearest) {
              nearest = d;
              book = rec.book;
            }
          }
        }
      }
      if (nearest === Infinity || nearest < raycaster.near || nearest > raycaster.far || (best && nearest >= best.distance)) continue;
      best = { book, distance: nearest, point: ray.at(nearest, new THREE.Vector3()).applyMatrix4(cs.group.matrixWorld) };
    }
    return best;
  }

  /**
   * Distance along a world ray to the nearest bookcase taken as a closed box, its open front
   * included (0 from inside one), or Infinity: where something held out in front of the eyes
   * must not be (raycast lets a ray into the opening, onto the books and the back board). Only
   * bookcases within `reach` metres of the ray's origin are looked at.
   * @param {THREE.Ray} worldRay
   */
  boxDistance(worldRay, reach = 3) {
    let best = Infinity;
    const ray = this._ray;
    const at = this._tmp;
    const r2 = (reach + BOOKCASE.width) ** 2;
    for (const cs of this.cases) {
      if (cs.group.position.distanceToSquared(worldRay.origin) > r2) continue;
      this._inv.copy(cs.group.matrixWorld).invert();
      ray.copy(worldRay).applyMatrix4(this._inv);
      if (cs.box.containsPoint(ray.origin)) return 0;
      if (ray.intersectBox(cs.box, at)) best = Math.min(best, ray.origin.distanceTo(at));
    }
    return best;
  }

  /** World transform of a book in its slot (Book3D frame: spine −X, front cover +Z). */
  getBookTransform(book) {
    const rec = this._rec(book);
    if (!rec) return null;
    const cs = this.cases[rec.caseIndex];
    const position = rec.center.clone().applyMatrix4(cs.group.matrixWorld);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), cs.yaw).multiply(Y90);
    return { position, quaternion, dims: { ...rec.dims } };
  }

  /** Removes a book from its shelf (e.g. while it is being read). */
  hideBook(book) {
    const rec = this._rec(book);
    if (!rec || rec.hidden) return;
    if (this._highlight?.rec === rec) this.setHighlight(null);
    rec.hidden = true;
    this._writeVertices(rec, true);
  }

  /** Puts a hidden book back. */
  showBook(book) {
    const rec = this._rec(book);
    if (!rec || !rec.hidden) return;
    rec.hidden = false;
    this._writeVertices(rec, false);
  }

  _writeVertices(rec, collapse) {
    const cs = this.cases[rec.caseIndex];
    const attr = cs.mesh.geometry.attributes.position;
    const a = attr.array;
    const { start, count } = rec.range;
    if (collapse) {
      const x = cs.original[start * 3];
      const y = cs.original[start * 3 + 1];
      const z = cs.original[start * 3 + 2];
      for (let i = start; i < start + count; i++) {
        a[i * 3] = x;
        a[i * 3 + 1] = y;
        a[i * 3 + 2] = z;
      }
    } else {
      a.set(cs.original.subarray(start * 3, (start + count) * 3), start * 3);
    }
    // Never clear the pending ranges: moving the hover straight to a neighbouring book restores
    // one book and collapses another in the same frame, and both must reach the GPU. three merges
    // the ranges on upload and clears them afterwards.
    attr.addUpdateRange(start * 3, count * 3);
    attr.needsUpdate = true;
  }

  /**
   * Hover highlight: the book slides ~4 cm out of the shelf and brightens. `null` clears it.
   */
  setHighlight(book) {
    const rec = this._rec(book);
    if (this._highlight && this._highlight.rec === rec) return;
    if (this._highlight) {
      const h = this._highlight;
      h.mesh.parent?.remove(h.mesh);
      h.mesh.geometry.dispose();
      if (!h.rec.hidden) this._writeVertices(h.rec, false);
      this._highlight = null;
    }
    if (!rec || rec.hidden) return;
    const cs = this.cases[rec.caseIndex];
    const src = cs.mesh.geometry;
    const { start, count } = rec.range;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'color']) {
      const at = src.attributes[name];
      const arr = (name === 'position' ? cs.original : at.array).slice(start * at.itemSize, (start + count) * at.itemSize);
      g.setAttribute(name, new THREE.BufferAttribute(arr, at.itemSize));
    }
    const idx = [];
    for (let f = 0; f < count / 4; f++) {
      const b = f * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setIndex(idx);
    g.translate(0, 0.004, 0.045);
    if (!cs.highlightMaterial) {
      cs.highlightMaterial = cs.material.clone();
      cs.highlightMaterial.emissive = new THREE.Color(0x3a2a14);
    }
    const mesh = new THREE.Mesh(g, cs.highlightMaterial);
    mesh.name = 'book-highlight';
    cs.group.add(mesh);
    mesh.updateMatrixWorld(true);
    this._writeVertices(rec, true);
    this._highlight = { rec, mesh };
  }

  /** A standing spot ~1.3 m in front of the book's bookcase, facing it. */
  locate(book) {
    const rec = this._rec(book);
    if (!rec) return null;
    const cs = this.cases[rec.caseIndex];
    const local = new THREE.Vector3(rec.center.x * 0.6, 0, D / 2 + 1.3);
    const position = local.applyMatrix4(cs.group.matrixWorld);
    position.y = 0;
    return { position, yaw: cs.yaw };
  }

  /** Same artwork as on the shelf, as a stand-alone canvas (for Book3D). */
  makeSpineCanvas(book) {
    return makeSpineCanvas(book, this._rec(book)?.dims || bookDims(book));
  }

  /** Bookcase footprints for collisions: { position, yaw, halfW, halfD }. */
  footprints() {
    return this.cases.map((cs) => ({ position: cs.position, yaw: cs.yaw, halfW: W / 2 + 0.05, halfD: D / 2 + 0.03 }));
  }

  /**
   * Spine-atlas level of detail (see LEVELS). Each call advances the atlas being painted by
   * JOB_BUDGET_MS; between jobs it picks the next one: a sharp atlas for the nearest bookcase in
   * reading range (displacing the farthest sharp one only when clearly nearer), else a mid atlas
   * for the nearest bookcase still without one. Sharp atlases far out of range are dropped.
   */
  update(dt, camera) {
    if (!camera || !this.cases.length) return;
    this._clock = (this._clock || 0) + dt;
    this._trackSpeed(camera.getWorldPosition(this._tmp), dt);
    this._cull(camera.getWorldPosition(this._tmp));
    if (this._job) {
      const job = this._job;
      if (job.painter ? job.painter.step(JOB_BUDGET_MS) : job.done) this._finishJob();
      return;
    }
    this._lodTimer -= dt;
    if (this._lodTimer > 0) return;
    this._lodTimer = 0.15;
    const cam = camera.getWorldPosition(this._tmp);
    const ranked = this.cases
      .map((cs) => ({ cs, d: Math.hypot(cs.position.x - cam.x, cs.position.z - cam.z) }))
      .sort((x, y) => x.d - y.d);
    // A small room fits the whole budget: every bookcase gets (and keeps) a sharp atlas, nearest
    // first, so titles are crisp from anywhere and the mid level is never needed.
    const small = this.cases.length <= HIGH_BUDGET;
    const sharp = ranked.filter((r) => r.cs.textures.high);
    const far = sharp[sharp.length - 1];
    if (!small && far && far.d > HIGH_RANGE + HYSTERESIS) return this._drop(far.cs, 'high');
    const want = ranked.find((r) => (small || r.d < HIGH_RANGE) && !r.cs.textures.high);
    if (want && (small || !this._moving)) {
      if (sharp.length < HIGH_BUDGET) return this._startJob(want.cs, 'high');
      if (want.d < far.d - HYSTERESIS) {
        this._drop(far.cs, 'high');
        return this._startJob(want.cs, 'high');
      }
    }
    if (small) return;
    let candidates = ranked;
    if (this.cases.length > MID_BUDGET) {
      for (const r of ranked.slice(MID_BUDGET + MID_SLACK)) if (r.cs.textures.mid) this._drop(r.cs, 'mid');
      candidates = ranked.slice(0, MID_BUDGET);
    }
    const mid = candidates.find((r) => !r.cs.textures.mid);
    if (!mid) return;
    if (this._moving && this.cases.length > MID_BUDGET && this._clock - (this._midAt ?? -Infinity) < MID_MOVING_INTERVAL) return;
    this._midAt = this._clock;
    this._startJob(mid.cs, 'mid');
  }

  /** The viewer's smoothed horizontal speed, and whether they are walking (with hysteresis). */
  _trackSpeed(cam, dt) {
    if (this._lastCam && dt > 0) {
      const v = Math.hypot(cam.x - this._lastCam.x, cam.z - this._lastCam.z) / dt;
      if (v < TELEPORT_SPEED) this._speed = (this._speed || 0) + (v - (this._speed || 0)) * Math.min(1, dt * 5);
    }
    (this._lastCam ||= new THREE.Vector3()).copy(cam);
    if (this._moving && this._speed < STILL_SPEED) {
      this._moving = false;
      this._lodTimer = 0; // catch up at once
    } else if (!this._moving && this._speed > MOVING_SPEED) {
      this._moving = true;
    }
  }

  /**
   * Hides the books the viewer cannot see, every frame: those of bookcases they stand behind
   * (behind the mid-plane, where the back and side panels cover every book; in a hall that is
   * half of them), and in a hall those behind a nearer row. That matters once a room has more
   * bookcases than the Quest's draw-call budget: at the hall's entrance only ~10 of the 100
   * bookcases facing the viewer can be seen at all.
   */
  _cull(cam) {
    // A row is a wall as tall as a bookcase: from below its top, nothing behind it shows over it.
    const rows = cam.y < BOOKCASE.height ? this._rows : null;
    for (const cs of this.cases) {
      const facing = (cam.x - cs.position.x) * Math.sin(cs.yaw) + (cam.z - cs.position.z) * Math.cos(cs.yaw) > 0;
      cs.mesh.visible = facing && !(rows && behindRow(cs, cam, rows));
    }
  }

  _startJob(cs, level) {
    const scale = LEVELS[level];
    if (!this._worker) {
      this._job = { cs, level, t0: performance.now(), painter: atlasPainter(cs.layout, cs.items, cs.label, scale) };
      return;
    }
    const job = { cs, level, t0: performance.now(), done: false, image: null };
    this._job = job;
    this._worker.paint(cs.layout, cs.items, cs.label, scale).then((image) => {
      if (this._job !== job) return image.close?.(); // the room was rebuilt meanwhile
      job.image = image;
      job.done = true;
    }, (err) => {
      this._workerFailed(err);
      if (this._job === job) this._job = null; // update() paints it again, on the main thread
    });
  }

  _finishJob() {
    const { cs, level, painter, image, t0 } = this._job;
    this._job = null;
    perf.event('atlas', { t: t0, ms: performance.now() - t0, level, worker: !painter });
    const aniso = level === 'high' ? Math.min(4, this.renderer.capabilities.getMaxAnisotropy()) : 2;
    const tex = canvasTexture(painter ? painter.canvas : image, { anisotropy: aniso });
    cs.textures[level] = tex;
    // Upload now, timed: otherwise it happens unseen inside the next render.
    const u0 = performance.now();
    this.renderer.initTexture?.(tex);
    perf.event('upload', { t: u0, ms: performance.now() - u0, level });
    this._applyTexture(cs);
  }

  _drop(cs, level) {
    disposeTexture(cs.textures[level]);
    cs.textures[level] = null;
    this._applyTexture(cs);
  }

  /** Shows the best atlas a bookcase has. */
  _applyTexture(cs) {
    const t = cs.textures.high || cs.textures.mid || cs.textures.low || placeholder();
    if (cs.material.map === t) return;
    cs.material.map = t;
    if (cs.highlightMaterial) cs.highlightMaterial.map = t;
  }

  /** Atlas levels currently held (diagnostics/tests). */
  lodStats() {
    const n = (k) => this.cases.filter((cs) => cs.textures[k]).length;
    return { cases: this.cases.length, mid: n('mid'), high: n('high'), painting: this._job ? this._job.level : null };
  }

  dispose() {
    this.setHighlight(null);
    this._job = null;
    this._gen++;
    for (const cs of this.cases) {
      cs.mesh.geometry.dispose();
      cs.material.dispose();
      cs.highlightMaterial?.dispose();
      for (const t of Object.values(cs.textures)) disposeTexture(t);
    }
    if (this.woodMesh) {
      this.woodMesh.geometry.dispose();
      this.woodMesh = null;
    }
    this.group.clear();
    this.cases = [];
    this._rows = null;
    this._records.clear();
    this._order = [];
  }
}

export const BOOKCASE_DIMS = { W, H, D, ROWS, TOP_TRIM, ROW_PITCH };
