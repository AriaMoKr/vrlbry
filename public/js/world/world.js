// World facade (SPEC §5.3): turns libraries + books into a room with bookcases, and answers
// spatial questions (spawn, kiosk spot, walkability, collisions).
//
// Yaw conventions: an object placed with `yaw` has rotation.y = yaw, so its local +Z (its front)
// faces (sin yaw, 0, cos yaw). A viewer with `yaw` has rig rotation.y = yaw and looks along
// (−sin yaw, 0, −cos yaw). A viewer facing an object's front therefore has the object's yaw.

import * as THREE from 'three';
import { BOOKCASE, PLAYER } from '../config.js';
import { sortBooks } from '../util/books.js';
import { Bookshelves, packBookcases, rangeLabel } from './shelves.js';
import { createRotunda, createHall, disposeRoom } from './room.js';
import { canvasTexture, makeSignCanvas } from './textures.js';

const CASE_GAP = 0.06; // between neighbouring bookcases
const ROTUNDA_MAX_CASES = 22;
// Books; above this (~10 bookcases) only the nearest bookcases get sharp spine atlases, which
// keeps GPU texture memory bounded on headsets.
const LAZY_THRESHOLD = 1200;

export class World {
  /**
   * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene }} o
   */
  constructor({ renderer, scene }) {
    this.renderer = renderer;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);
    this.shelves = new Bookshelves({ renderer });
    this.group.add(this.shelves.group);
    this.room = null;
    this.signs = [];
    this.teleportTargets = [];
    this.spawn = { position: new THREE.Vector3(0, 0, 2), yaw: 0 };
    this.kiosk = { position: new THREE.Vector3(1, 0, 1), yaw: 0 };
    this.sections = [];
    this._colliders = [];
    this._footprints = [];
  }

  /**
   * (Re)builds the library.
   * @param {Array<{ library: object, books: object[] }>} collections
   * @param {{ sort?: 'title'|'author'|'popularity' }} [opts]
   */
  async build(collections, { sort = 'title' } = {}) {
    this.sort = sort;
    // Pack each library into its own run of bookcases.
    const cases = [];
    this.sections = [];
    let total = 0;
    for (const { library, books, subtitle } of collections) {
      for (const b of books) b.libId = library.id;
      const packed = packBookcases(sortBooks(books, sort));
      if (!packed.length) continue;
      this.sections.push({ library, first: cases.length, count: packed.length, books: books.length, subtitle });
      for (const p of packed) cases.push({ ...p, label: rangeLabel(p.items, sort), libId: library.id });
      total += books.length;
    }

    // Tear down the previous room.
    if (this.room) disposeRoom(this.room);
    for (const s of this.signs) {
      s.geometry.dispose();
      s.material.map.dispose();
      s.material.dispose();
      s.removeFromParent();
    }
    this.signs = [];

    const n = cases.length;
    if (n <= ROTUNDA_MAX_CASES) this._layoutRotunda(cases);
    else this._layoutHall(cases);
    this.shelves.build(cases, { lazy: total > LAZY_THRESHOLD });
    this._footprints = this.shelves.footprints();
    this._makeSigns(cases);
    if (!n) this._emptySign();
    this.group.updateMatrixWorld(true);
  }

  _layoutRotunda(cases) {
    const n = cases.length;
    const step = BOOKCASE.width + CASE_GAP;
    // Radius: cases may use up to ~70 % of the wall; keep a comfortable minimum room size.
    const R = Math.max(3.8, (n * step) / (0.7 * 2 * Math.PI) + BOOKCASE.depth);
    const rc = R - BOOKCASE.depth / 2 - 0.04;
    const da = step / rc;
    const a0 = -((n - 1) / 2) * da;
    cases.forEach((cs, i) => {
      const a = a0 + i * da;
      cs.position = new THREE.Vector3(Math.sin(a) * rc, 0, -Math.cos(a) * rc);
      cs.yaw = -a;
    });
    // Windows evenly around the rest of the wall, kept clear of the bookcase run.
    const half = n ? (n * da) / 2 + 0.5 / R : 0;
    const free = 2 * Math.PI - 2 * half;
    const count = Math.max(2, Math.floor((free * R) / 2.3));
    const windowAngles = [];
    for (let i = 0; i < count; i++) windowAngles.push(half + ((i + 0.5) / count) * free);

    this.spawn = { position: new THREE.Vector3(0, 0, Math.min(1.6, R * 0.35)), yaw: 0 };
    const kp = new THREE.Vector3(Math.min(1.45, R * 0.36), 0, this.spawn.position.z - 1.4);
    this.kiosk = { position: kp, yaw: Math.atan2(this.spawn.position.x - kp.x, this.spawn.position.z - kp.z) };
    this.room = createRotunda({ R, windowAngles, kiosk: this.kiosk });
    this._finishRoom();
  }

  _layoutHall(cases) {
    const n = cases.length;
    const K = Math.max(4, Math.min(12, Math.ceil(Math.sqrt(n / 2))));
    const rows = Math.ceil(n / (2 * K));
    const aisle = 2.4;
    const pitch = 2 * BOOKCASE.depth + aisle;
    const step = BOOKCASE.width + 0.02;
    const zFirst = -2.5;
    let i = 0;
    for (let r = 0; r < rows && i < n; r++) {
      const zc = zFirst - r * pitch;
      for (let k = 0; k < K && i < n; k++, i++) {
        cases[i].position = new THREE.Vector3((k - (K - 1) / 2) * step, 0, zc + BOOKCASE.depth / 2);
        cases[i].yaw = 0;
      }
      for (let k = K - 1; k >= 0 && i < n; k--, i++) {
        cases[i].position = new THREE.Vector3((k - (K - 1) / 2) * step, 0, zc - BOOKCASE.depth / 2);
        cases[i].yaw = Math.PI;
      }
    }
    const halfW = (K * step) / 2 + 2.6;
    const maxZ = 4.5;
    const minZ = zFirst - (rows - 1) * pitch - BOOKCASE.depth - aisle;
    this.spawn = { position: new THREE.Vector3(0, 0, maxZ - 1.4), yaw: 0 };
    const kp = new THREE.Vector3(1.3, 0, maxZ - 2.6);
    this.kiosk = { position: kp, yaw: Math.atan2(this.spawn.position.x - kp.x, this.spawn.position.z - kp.z) };
    this.room = createHall({ minX: -halfW, maxX: halfW, minZ, maxZ, kiosk: this.kiosk });
    this._finishRoom();
  }

  _finishRoom() {
    this.group.add(this.room.group);
    this.teleportTargets = [this.room.floor];
    this._colliders = this.room.colliders;
  }

  _makeSigns(cases) {
    for (const sec of this.sections) {
      const cs = cases[sec.first];
      const lib = sec.library;
      const canvas = makeSignCanvas(lib.title || lib.name || lib.id,
        sec.subtitle ?? [lib.description, `${sec.books} book${sec.books === 1 ? '' : 's'}`].filter(Boolean).join(' · '));
      const mat = new THREE.MeshLambertMaterial({ map: canvasTexture(canvas, { anisotropy: 8 }), emissive: 0x221608 });
      const w = Math.min(2.2, BOOKCASE.width * Math.min(2, sec.count) - 0.1);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), mat);
      // Centred over the section's first bookcases (two when it has two or more).
      const next = cases[sec.first + Math.min(1, sec.count - 1)];
      const other = Math.abs(next.yaw - cs.yaw) < 0.5 ? next : cs; // never span back-to-back cases
      const pos = cs.position.clone().add(other.position).multiplyScalar(0.5);
      sign.position.set(pos.x, BOOKCASE.height + w / 8 + 0.08, pos.z);
      sign.rotation.y = (cs.yaw + other.yaw) / 2;
      sign.translateZ(BOOKCASE.depth / 2 - 0.02);
      sign.rotation.x = 0; // keep upright
      sign.name = 'section-sign';
      this.group.add(sign);
      this.signs.push(sign);
    }
  }

  _emptySign() {
    const canvas = makeSignCanvas('No ZIM files found', 'Put .zim files in the server folder and reload');
    const mat = new THREE.MeshLambertMaterial({ map: canvasTexture(canvas), emissive: 0x221608 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.5), mat);
    sign.position.set(0, 1.8, -2.5);
    this.group.add(sign);
    this.signs.push(sign);
  }

  /** True when a person can stand at (x, z). */
  isWalkable(x, z) {
    if (!this.room || !this.room.walkable(x, z)) return false;
    const p = { x, z };
    return !this._collides(p, 0.2);
  }

  _collides(p, radius) {
    for (const c of this._colliders) {
      if (Math.hypot(p.x - c.x, p.z - c.z) < c.r + radius) return true;
    }
    for (const f of this._footprints) {
      const dx = p.x - f.position.x;
      const dz = p.z - f.position.z;
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) < f.halfW + radius && Math.abs(lz) < f.halfD + radius) return true;
    }
    return false;
  }

  /**
   * Resolves a move from `from` to `to` against walls, bookcases and furniture (XZ plane).
   * @returns {THREE.Vector3} new position (y copied from `to`)
   */
  constrain(from, to, radius = PLAYER.radius) {
    const p = to.clone();
    if (!this.room) return p;
    for (let iter = 0; iter < 3; iter++) {
      this.room.boundary(p, radius);
      for (const c of this._colliders) {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + radius;
        if (d < min) {
          const k = d > 1e-6 ? min / d : 0;
          p.x = c.x + (d > 1e-6 ? dx * k : min);
          p.z = c.z + (d > 1e-6 ? dz * k : 0);
        }
      }
      for (const f of this._footprints) {
        // Circle vs oriented box: push out along the shortest axis in the box frame.
        const dx = p.x - f.position.x;
        const dz = p.z - f.position.z;
        const c = Math.cos(f.yaw);
        const s = Math.sin(f.yaw);
        let lx = dx * c - dz * s;
        let lz = dx * s + dz * c;
        const cx = Math.max(-f.halfW, Math.min(f.halfW, lx));
        const cz = Math.max(-f.halfD, Math.min(f.halfD, lz));
        const ox = lx - cx;
        const oz = lz - cz;
        const d = Math.hypot(ox, oz);
        if (d >= radius) continue;
        if (d > 1e-6) {
          lx = cx + (ox / d) * radius;
          lz = cz + (oz / d) * radius;
        } else {
          // Centre inside the box: leave by the nearest face.
          const px = f.halfW - Math.abs(lx);
          const pz = f.halfD - Math.abs(lz);
          if (px < pz) lx = Math.sign(lx || 1) * (f.halfW + radius);
          else lz = Math.sign(lz || 1) * (f.halfD + radius);
        }
        p.x = f.position.x + lx * c + lz * s;
        p.z = f.position.z - lx * s + lz * c;
      }
    }
    // If something is still in the way (corner pockets), stay put.
    if (this._collides(p, radius * 0.9) && !this._collides(from, radius * 0.9)) return from.clone().setY(to.y);
    return p;
  }

  /** Per-frame: room ambience and spine-atlas LOD. */
  update(dt, camera) {
    this.room?.update(dt);
    this.shelves.update(dt, camera);
  }

  dispose() {
    if (this.room) disposeRoom(this.room);
    this.shelves.dispose();
    for (const s of this.signs) {
      s.geometry.dispose();
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.group.removeFromParent();
  }
}
