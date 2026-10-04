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
import {
  drawSpine, drawPlate, makeSpineCanvas, newCanvas, canvasTexture, makeWoodCanvas, makePageEdgeCanvas,
  bookColors, SPINE_PPM,
} from './textures.js';

const { width: W, height: H, depth: D, shelves: ROWS, bottom: BOTTOM, side: SIDE, board: BOARD } = BOOKCASE;
export const TOP_TRIM = 0.14;
export const ROW_PITCH = (H - BOTTOM - TOP_TRIM) / ROWS;
const PAD = 0.012; // clearance between the side panels and the outermost books
export const USABLE = W - 2 * SIDE - 2 * PAD;
const ATLAS_W = 2048;
const STRIPE = 6; // px of plain cloth right of each spine in the atlas (covers sample it)
const ROW_H = Math.ceil(0.31 * SPINE_PPM) + 4;
const LABEL = { w: 440, h: 80 }; // label plate in the atlas (px)
const PLATE = { w: 0.42, h: 0.064 }; // label plate on the bookcase (m)
const Y90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
// Spine atlas levels of detail (scale of the full-resolution layout). Low is drawn instantly when a
// room is built; mid (small but real titles) is painted for every bookcase, nearest first; high
// (legible titles) only for the few bookcases near enough to read — on a Quest 3 spine titles are
// legible within ~4 m. Painting is spread over frames (JOB_BUDGET_MS each), so walking or switching
// rooms never stalls rendering; dropping a level is just a texture swap.
const LEVELS = { low: 0.125, mid: 0.25, high: 1 };
const HIGH_BUDGET = 6; // sharp atlases kept at once (~16 MB of GPU memory each)
const HIGH_RANGE = 4.5; // metres (horizontal) within which a bookcase gets a sharp atlas
const HYSTERESIS = 1.5; // metres of slack before a sharp atlas is dropped or displaced
const JOB_BUDGET_MS = 3; // canvas painting per frame

/** Height of the surface books stand on, for shelf row r counted from the top (0 = top row). */
export function rowSurface(r) {
  return BOTTOM + (ROWS - 1 - r) * ROW_PITCH;
}

const keyOf = (book) => `${book.libId}\n${book.id}`;

/**
 * Distributes sorted books into bookcases: rows top→bottom, books left→right, with small
 * deterministic gaps. Rows are filled evenly (~85 %) rather than packed, so the last bookcase is
 * never nearly empty and shelves look lived-in.
 * @param {object[]} books sorted book descriptors (with libId)
 * @returns {Array<{ items: Array<{ book, dims, row: number, x: number }> }>} x = book centre
 */
export function packBookcases(books) {
  const entries = books.map((book) => ({
    book, dims: bookDims(book), gap: 0.0015 + 0.003 * hash01(String(book.id), 'gap'),
  }));
  const total = entries.reduce((s, e) => s + e.dims.w + e.gap, 0);
  const rowsNeeded = Math.max(1, Math.ceil(total / (USABLE * 0.85)));
  const caseCount = Math.ceil(rowsNeeded / ROWS);
  const target = Math.min(USABLE, total / (caseCount * ROWS)); // per-row length goal
  const cases = [];
  let cur = null;
  let row = ROWS;
  let x = 0;
  let filled = 0;
  for (const { book, dims, gap } of entries) {
    // New row when the book does not fit, or when this row has reached its share and the book
    // would overshoot it by more than half its own thickness.
    const overshoot = filled + dims.w - target > dims.w / 2;
    const globalRow = (cases.length - 1) * ROWS + row; // the last planned row takes any overflow
    if (!cur || x + dims.w > USABLE / 2 + 1e-6 || (filled > 0 && overshoot && globalRow < caseCount * ROWS - 1)) {
      filled = 0;
      row++;
      x = -USABLE / 2;
      if (!cur || row >= ROWS) {
        cur = { items: [] };
        cases.push(cur);
        row = 0;
      }
    }
    cur.items.push({ book, dims, row, x: x + dims.w / 2 });
    x += dims.w + gap;
    filled += dims.w + gap;
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
    : (bk) => cap(titleKey(bk.title), 2);
  return `${key(a)} – ${key(b)}`;
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
// Atlas

/** Packs spine cells (+ label + page-edge patch) into an atlas layout (full-res pixel units). */
function atlasLayout(items) {
  const cells = [];
  let x = 0;
  let y = 0;
  for (const it of items) {
    const w = Math.max(16, Math.round(it.dims.w * SPINE_PPM));
    const h = Math.round(it.dims.h * SPINE_PPM);
    if (x + w + STRIPE > ATLAS_W) {
      x = 0;
      y += ROW_H;
    }
    cells.push({ x, y, w, h });
    x += w + STRIPE + 2;
  }
  const labelY = y + ROW_H;
  const label = { x: 0, y: labelY, w: LABEL.w, h: LABEL.h };
  const page = { x: LABEL.w + 8, y: labelY, w: 64, h: LABEL.h };
  const height = Math.ceil((labelY + LABEL.h + 2) / 4) * 4;
  return { cells, label, page, width: ATLAS_W, height };
}

let pageEdge = null;

/**
 * Paints an atlas at `scale` (1 = full resolution) incrementally: `step(budgetMs)` paints spines
 * until the time budget is used and returns true once the atlas is complete.
 */
function atlasPainter(layout, items, labelText, scale) {
  const c = newCanvas(Math.max(4, Math.round(layout.width * scale)), Math.max(4, Math.round(layout.height * scale)));
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = '#2a1a10';
  g.fillRect(0, 0, layout.width, layout.height);
  const detailed = scale >= 0.2;
  let i = 0;
  let done = false;
  return {
    canvas: c,
    step(budgetMs = Infinity) {
      if (done) return true;
      const t0 = performance.now();
      while (i < items.length) {
        const it = items[i];
        const cell = layout.cells[i++];
        const col = bookColors(it.book);
        g.fillStyle = col.cloth;
        g.fillRect(cell.x + cell.w, cell.y, STRIPE, cell.h);
        if (detailed) drawSpine(g, it.book, cell.x, cell.y, cell.w, cell.h);
        else {
          g.fillRect(cell.x, cell.y, cell.w, cell.h);
          g.fillStyle = col.gilt;
          g.fillRect(cell.x + cell.w * 0.15, cell.y + cell.h * 0.2, cell.w * 0.7, cell.h * 0.55);
        }
        if (performance.now() - t0 > budgetMs) return false;
      }
      drawPlate(g, layout.label.x, layout.label.y, layout.label.w, layout.label.h, labelText || '');
      pageEdge ||= makePageEdgeCanvas({ w: 64, h: 64 });
      g.drawImage(pageEdge, layout.page.x, layout.page.y, layout.page.w, layout.page.h);
      done = true;
      return true;
    },
  };
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

export class Bookshelves {
  /**
   * @param {{ renderer: THREE.WebGLRenderer }} o
   */
  constructor({ renderer }) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'bookshelves';
    this.cases = [];
    this._records = new Map(); // key -> record
    this._order = [];
    this._highlight = null;
    this._lodTimer = 0;
    this._job = null; // atlas being painted: { cs, level, painter }
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
      // Low level now (cheap: coloured bands); mid/high are painted progressively by update().
      const low = atlasPainter(layout, cs.items, cs.label, LEVELS.low);
      low.step();
      const tex = canvasTexture(low.canvas, { anisotropy: 1 });
      const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
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
        textures: { low: tex, mid: null, high: null }, records, original, position: cs.position.clone(), yaw: cs.yaw,
        box: new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2), new THREE.Vector3(W / 2, H, D / 2 + 0.05)),
        back: new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2), new THREE.Vector3(W / 2, H, -D / 2 + 0.02)),
      });
    });
    if (woodParts.length) {
      const woodGeo = mergeGeometries(woodParts);
      woodParts.forEach((p) => p.dispose());
      this.woodMesh = new THREE.Mesh(woodGeo, getWoodMaterial());
      this.woodMesh.name = 'bookcase-wood';
      this.woodMesh.matrixAutoUpdate = false;
      this.group.add(this.woodMesh);
    }
  }

  /** Book descriptors in shelf order. */
  books() {
    return this._order.slice();
  }

  _rec(book) {
    return book ? this._records.get(keyOf(book)) : undefined;
  }

  /** Nearest visible book hit by the raycaster (front-facing bookcases only). */
  raycast(raycaster) {
    let best = null;
    const ray = this._ray;
    const hit = this._tmp;
    for (const cs of this.cases) {
      this._inv.copy(cs.group.matrixWorld).invert();
      ray.copy(raycaster.ray).applyMatrix4(this._inv);
      if (ray.direction.z >= 0) continue; // looking at the bookcase from behind / edge-on
      if (!ray.intersectBox(cs.box, hit)) continue;
      const near = ray.origin.distanceTo(hit);
      if (best && near > best.distance) continue;
      let limit = Infinity;
      if (ray.intersectBox(cs.back, hit)) limit = ray.origin.distanceTo(hit);
      for (const rec of cs.records) {
        if (rec.hidden) continue;
        if (!ray.intersectBox(rec.box, hit)) continue;
        const d = ray.origin.distanceTo(hit);
        if (d > limit || d > raycaster.far || d < raycaster.near) continue;
        if (!best || d < best.distance) best = { book: rec.book, distance: d, point: hit.clone().applyMatrix4(cs.group.matrixWorld) };
      }
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
    if (this._job) {
      if (this._job.painter.step(JOB_BUDGET_MS)) this._finishJob();
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
    if (!small && far && far.d > HIGH_RANGE + HYSTERESIS) return this._dropHigh(far.cs);
    const want = ranked.find((r) => (small || r.d < HIGH_RANGE) && !r.cs.textures.high);
    if (want) {
      if (sharp.length < HIGH_BUDGET) return this._startJob(want.cs, 'high');
      if (want.d < far.d - HYSTERESIS) {
        this._dropHigh(far.cs);
        return this._startJob(want.cs, 'high');
      }
    }
    if (small) return;
    const mid = ranked.find((r) => !r.cs.textures.mid);
    if (mid) this._startJob(mid.cs, 'mid');
  }

  _startJob(cs, level) {
    this._job = { cs, level, painter: atlasPainter(cs.layout, cs.items, cs.label, LEVELS[level]) };
  }

  _finishJob() {
    const { cs, level, painter } = this._job;
    this._job = null;
    const aniso = level === 'high' ? Math.min(4, this.renderer.capabilities.getMaxAnisotropy()) : 2;
    cs.textures[level] = canvasTexture(painter.canvas, { anisotropy: aniso });
    this._applyTexture(cs);
  }

  _dropHigh(cs) {
    cs.textures.high?.dispose();
    cs.textures.high = null;
    this._applyTexture(cs);
  }

  /** Shows the best atlas a bookcase has. */
  _applyTexture(cs) {
    const t = cs.textures.high || cs.textures.mid || cs.textures.low;
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
    for (const cs of this.cases) {
      cs.mesh.geometry.dispose();
      cs.material.dispose();
      cs.highlightMaterial?.dispose();
      for (const t of Object.values(cs.textures)) t?.dispose();
    }
    if (this.woodMesh) {
      this.woodMesh.geometry.dispose();
      this.woodMesh = null;
    }
    this.group.clear();
    this.cases = [];
    this._records.clear();
    this._order = [];
  }
}

export const BOOKCASE_DIMS = { W, H, D, ROWS, TOP_TRIM, ROW_PITCH };
