// The door back (SPEC §5.3 "The door"): a doorway like the Hallway's own
// (https://ariamokr.github.io/hallway/: a glowing opening onto the place beyond, a plaque beside
// it and a sign over it), standing against the wall behind the spawn point, the way one came in.
// It leads where the way out leads (hallway.js wayOut): the Hallway, or the place that linked
// here. Walking through it, clicking it, or pointing at it and pulling the trigger leaves
// (interaction.js leave()).
//
// A door's frame: origin at the middle of the sill at the back of the doorway (where the portal
// is), +z out into the room, +x to the right of someone facing it from the room. The pure
// functions (where it stands, its frame, passing through, walking into it, rays) take a placement
// { x, z, yaw } and run in Node; the Door class makes the meshes (a browser: canvases).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture } from './canvas-texture.js';
// The doorway's portal, the Hallway's (AriaMoKr/common portal.js): the picture as the far wall of a
// room behind the opening, with parallax, a veil and a rim glowing in the door's colour.
import { openingGeometry, placePortal, portalMaterial, setView } from '../../vendor/common/portal.js';
import { roomMaterials } from './room.js';

export const DOOR = {
  width: 1.1,
  height: 2.25,
  depth: 0.16, // the doorway, from the frame's front back to the portal
  casing: 0.1, // the frame around the opening
  threshold: 0.06, // how far past the frame's front a head goes to pass through
  shoulder: 0.2, // the jambs keep a walker's centre this far from them
  approach: 1.2, // in front of the doorway, where walking straight into it is allowed
  near: 1.7, // standing this near, the doorway glows a little
  clear: 2.3, // windows keep this far (metres along the wall) from its middle: the plaque is beside it
};

/** Where a room's door stands: against the wall behind the spawn point (+z), facing the room. */
export function doorPlace(room) {
  if (room?.kind === 'rotunda') return { x: 0, z: room.R - 0.1, yaw: Math.PI }; // the wall curves forward to its sides
  if (room?.kind === 'hall') return { x: (room.bounds.minX + room.bounds.maxX) / 2, z: room.bounds.maxZ - 0.04, yaw: Math.PI };
  return null;
}

/** (x, z) in a placed door's frame, written into out. */
export function doorLocal(place, x, z, out = { x: 0, z: 0 }) {
  const dx = x - place.x;
  const dz = z - place.z;
  const c = Math.cos(place.yaw);
  const s = Math.sin(place.yaw);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

/** A point of a placed door's frame in the world, written into out. */
export function doorWorld(place, lx, lz, out = { x: 0, z: 0 }) {
  const c = Math.cos(place.yaw);
  const s = Math.sin(place.yaw);
  out.x = place.x + lx * c + lz * s;
  out.z = place.z - lx * s + lz * c;
  return out;
}

/** The wall behind a placed door, `lx` to its side: its z in the door's frame. */
export function wallBehind(room, place, lx) {
  if (room.kind === 'rotunda') return place.z - Math.sqrt(Math.max(0, room.R * room.R - lx * lx));
  return place.z - room.bounds.maxZ;
}

const _p = { x: 0, z: 0 };

/** Whether a head at (x, z) has passed through the doorway. */
export function doorCrossed(place, x, z) {
  const p = doorLocal(place, x, z, _p);
  return Math.abs(p.x) < DOOR.width / 2 && p.z < DOOR.depth - DOOR.threshold && p.z > -1;
}

/**
 * A walk ending at (x, z) in the doorway's corridor (straight in front of it, between where its
 * jambs are, or inside it): that point kept between the jambs and short of the portal, written
 * into out; null when it is not there, and the room's own walls apply.
 */
export function doorCorridor(place, x, z, out = { x: 0, z: 0 }) {
  const p = doorLocal(place, x, z, _p);
  if (Math.abs(p.x) >= DOOR.width / 2 - DOOR.shoulder || p.z > DOOR.depth + DOOR.approach || p.z < -1) return null;
  return doorWorld(place, p.x, Math.max(0.04, p.z), out);
}

/**
 * A ray (world space, its direction normalized) against the door's front: the distance to it
 * and whether that is the opening (else the frame), written into out; null when it misses it or
 * starts inside the doorway.
 */
export function rayDoor(place, ray, out = { distance: 0, opening: false }) {
  const { origin: o, direction: d } = ray;
  const c = Math.cos(place.yaw);
  const s = Math.sin(place.yaw);
  const ox = (o.x - place.x) * c - (o.z - place.z) * s;
  const oz = (o.x - place.x) * s + (o.z - place.z) * c;
  const dx = d.x * c - d.z * s;
  const dz = d.x * s + d.z * c;
  if (dz > -1e-6 || oz < DOOR.depth) return null;
  const t = (DOOR.depth - oz) / dz;
  const x = ox + dx * t;
  const y = o.y + d.y * t;
  if (Math.abs(x) > DOOR.width / 2 + DOOR.casing || y < 0 || y > DOOR.height + DOOR.casing + 0.07) return null;
  out.distance = t;
  out.opening = Math.abs(x) < DOOR.width / 2 && y < DOOR.height;
  return out;
}

/**
 * The rotunda's window angles (0 = −z, increasing toward +x, as room.js takes them) in the wall
 * its bookcases leave free (they take `half` either side of −z), on both sides of the door at
 * angle π, each side filled evenly, about one window per 2.3 m.
 */
export function windowAnglesBesideDoor(half, R) {
  const side = Math.PI - DOOR.clear / R - half;
  const count = Math.max(0, Math.floor((side * R) / 2.3));
  const angles = [];
  for (let i = 0; i < count; i++) {
    const a = half + ((i + 0.5) / count) * side;
    angles.push(a, 2 * Math.PI - a);
  }
  return angles;
}

/**
 * An entry of the Hallway's views.json (its README, "The view from your door": the view out of
 * this library's door there, and how to hang it), checked: { image, depth, pictureHeight, eye,
 * horizon, aspect } with sizes in sensible ranges, else null.
 */
export function viewParams(entry) {
  if (!entry || typeof entry.image !== 'string' || !entry.image) return null;
  const n = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : null);
  const v = {
    image: entry.image,
    depth: n(entry.depth, 0.3, 30), pictureHeight: n(entry.pictureHeight, 0.5, 40), eye: n(entry.eye, 0, 3),
    horizon: n(entry.horizon, 0, 1), aspect: n(entry.aspect ?? 2, 0.25, 8),
  };
  return Object.values(v).every((x) => x !== null) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Pictures: the Hallway's look (its enamel signs, gold serif letters)

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const GOLD = '#e0bb72';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** The largest font (from size down) at which text fits maxWidth. */
function fit(g, text, maxWidth, size, style) {
  for (; size > 10; size -= 2) {
    g.font = `${style} ${size}px ${SERIF}`;
    if (g.measureText(text).width <= maxWidth) break;
  }
}

/** A sign's ground: a wooden edge, dark green enamel and a gold line. */
function enamel(g, w, h, inset) {
  g.fillStyle = '#2b1b10';
  g.fillRect(0, 0, w, h);
  const e = g.createLinearGradient(0, 0, 0, h);
  e.addColorStop(0, '#1b2e28');
  e.addColorStop(1, '#14231f');
  g.fillStyle = e;
  g.fillRect(inset, inset, w - inset * 2, h - inset * 2);
  g.strokeStyle = GOLD;
  g.lineWidth = 3;
  g.strokeRect(inset + 8, inset + 8, w - (inset + 8) * 2, h - (inset + 8) * 2);
}

/** The plaque beside the door: where it leads, and a line about it. 0.56 × 0.30 m. */
function plaqueCanvas(title, subtitle) {
  const W = 512;
  const H = 274;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  enamel(g, W, H, 12);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = GOLD;
  fit(g, title, W - 90, 84, '600');
  g.fillText(title, W / 2, 128);
  g.fillStyle = 'rgba(224,187,114,0.6)';
  g.fillRect(W / 2 - 60, 152, 120, 2);
  g.fillStyle = '#efe5cf';
  g.font = `28px ${SANS}`;
  let line = subtitle;
  while (line.length > 1 && g.measureText(line).width > W - 90) line = `${line.slice(0, -2)}…`;
  g.fillText(line, W / 2, 200);
  return c;
}

/** The sign over the door. 0.80 × 0.26 m. */
function signCanvas(text) {
  const W = 640;
  const H = 208;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  enamel(g, W, H, 9);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = GOLD;
  fit(g, text, W - 80, 104, '600');
  g.fillText(text, W / 2, H / 2 + 5);
  return c;
}

/**
 * The Hallway seen through the doorway: down its corridor (cream walls, a floor of cream and
 * green-black marble, lamps), its first door on the left glowing gold (this library's), dusk in
 * the end window. 2:1, the horizon at 56 % up, 3 m high: as the portal hangs it.
 */
function hallwayView() {
  const W = 1024;
  const H = 512;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const m = H / 3; // pixels per metre at the picture
  const vx = W / 2;
  const vy = H * (1 - 0.56); // eye height
  // A point x across, y up (m), d metres beyond the picture: where it is drawn.
  const k = (d) => 2.4 / (2.4 + d);
  const px = (x, d) => vx + x * m * k(d);
  const py = (y, d) => vy + (H - (y + 0.08) * m - vy) * k(d);
  const quad = (pts, fill) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) g.lineTo(q[0], q[1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  const half = 1.5;
  const top = 3.2;
  const far = 9.6;
  const near = -1.5; // nearer than the picture: the corridor fills it, edges and all (the portal stretches them)
  g.fillStyle = '#2a211a';
  g.fillRect(0, 0, W, H);
  // Ceiling, walls (lighter near), floor.
  quad([[px(-half, near), py(top, near)], [px(half, near), py(top, near)], [px(half, far), py(top, far)], [px(-half, far), py(top, far)]], '#b9ab8f');
  for (const side of [-1, 1]) {
    const wall = g.createLinearGradient(px(side * half, 0), 0, vx, 0);
    wall.addColorStop(0, '#d9ccb1');
    wall.addColorStop(1, '#8f8269');
    quad([[px(side * half, near), py(top, near)], [px(side * half, far), py(top, far)], [px(side * half, far), py(0, far)], [px(side * half, near), py(0, near)]], wall);
  }
  for (let d = near; d < far; d += 0.5) {
    for (let i = 0; i < 6; i++) {
      const x0 = -half + i * 0.5;
      const dark = (i + Math.round(d * 2) + 6) % 2 === 1;
      quad([[px(x0, d), py(0, d)], [px(x0 + 0.5, d), py(0, d)], [px(x0 + 0.5, d + 0.5), py(0, d + 0.5)], [px(x0, d + 0.5), py(0, d + 0.5)]], dark ? '#1d2a26' : '#d6cab4');
    }
  }
  // Doors along the walls: the first on the left is this library's, glowing gold.
  for (const [side, d, glow] of [[-1, 1.8, '#d9b26a'], [1, 1.8, null], [-1, 5.4, null], [1, 5.4, null]]) {
    const x = side * half;
    quad([[px(x, d - 0.55), py(0, d - 0.55)], [px(x, d - 0.55), py(2.25, d - 0.55)], [px(x, d + 0.55), py(2.25, d + 0.55)], [px(x, d + 0.55), py(0, d + 0.55)]], glow ?? '#4a2f1d');
  }
  // The end wall and its window at dusk.
  quad([[px(-half, far), py(top, far)], [px(half, far), py(top, far)], [px(half, far), py(0, far)], [px(-half, far), py(0, far)]], '#a59a80');
  const sky = g.createLinearGradient(0, py(2.85, far), 0, py(0.95, far));
  sky.addColorStop(0, '#253266');
  sky.addColorStop(0.7, '#8a5a7a');
  sky.addColorStop(1, '#f6c27e');
  quad([[px(-0.8, far), py(2.85, far)], [px(0.8, far), py(2.85, far)], [px(0.8, far), py(0.95, far)], [px(-0.8, far), py(0.95, far)]], sky);
  // Lamps down the middle, with their glow.
  for (const d of [0.4, 1.8 + 1.8, 5.4 + 1.8, 9.0]) {
    const x = px(0, d);
    const y = py(2.66, d);
    const r = 0.5 * m * k(d);
    const halo = g.createRadialGradient(x, y, 0, x, y, r);
    halo.addColorStop(0, 'rgba(255,243,216,1)');
    halo.addColorStop(0.25, 'rgba(255,226,170,0.8)');
    halo.addColorStop(1, 'rgba(255,217,168,0)');
    g.fillStyle = halo;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return c;
}

/** Another place seen through the doorway: its glow and its name. 2:1. */
function plainView(name, color) {
  const W = 1024;
  const H = 512;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H * 0.55, 10, W / 2, H * 0.55, W * 0.6);
  grad.addColorStop(0, color);
  grad.addColorStop(1, '#050403');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,248,235,0.9)';
  fit(g, name, W * 0.45, 96, '600');
  g.fillText(name, W / 2, H * 0.5);
  return c;
}

// ---------------------------------------------------------------------------------------------
// The meshes

const _head = new THREE.Vector3();
const _q = { x: 0, z: 0 };
const _hit = { distance: 0, opening: false };

export class Door {
  /**
   * @param {{ title: string, subtitle: string, sign: string, color: string, view: 'hallway'|'plain' }} o
   *   view: the Hallway's corridor, or another place's glow and name
   */
  constructor({ title, subtitle, sign, color, view }) {
    const { width: W, height: H, casing: C, depth: D } = DOOR;
    this.group = new THREE.Group();
    this.group.name = 'door';
    /** Where it stands ({ x, z, yaw }), or null in a room without one. */
    this.place = null;
    /** Set each frame by interaction.js: a pointer is on the doorway. */
    this.hover = false;
    this._glow = 0;
    const picture = canvasTexture(view === 'hallway' ? hallwayView() : plainView(title, color), { anisotropy: 4 });
    this.portal = new THREE.Mesh(openingGeometry(W, H), portalMaterial({
      map: picture, width: W, height: H, depth: 2.4, pictureHeight: 3, eye: 1.6, horizon: 0.56, color,
    }));
    this.portal.name = 'door-portal';
    // The frame: posts and head reaching back into the wall, a cornice over them, a threshold.
    const back = 0.14;
    const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const zc = (D - back) / 2;
    const frame = mergeGeometries([
      box(C, H + C, D + back, -(W + C) / 2, (H + C) / 2, zc),
      box(C, H + C, D + back, (W + C) / 2, (H + C) / 2, zc),
      box(W, C, D + back, 0, H + C / 2, zc),
      box(W + 2 * C + 0.12, 0.07, D + back + 0.05, 0, H + C + 0.035, zc + 0.025),
      box(W, 0.02, D, 0, 0.01, D / 2),
    ]);
    this.frame = new THREE.Mesh(frame, roomMaterials().wood);
    this.frame.name = 'door-frame';
    const signMaterial = (c) => new THREE.MeshBasicMaterial({ map: canvasTexture(c, { anisotropy: 8 }), color: 0xd8cebd });
    this.plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.3), signMaterial(plaqueCanvas(title, subtitle)));
    this.plaque.name = 'door-plaque';
    this.sign = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.26), signMaterial(signCanvas(sign)));
    this.sign.name = 'door-sign';
    this.group.add(this.portal, this.frame, this.plaque, this.sign);
  }

  /** Stands it in a room (room.js), or hides it in one without a place for it. */
  setRoom(room) {
    const p = doorPlace(room);
    this.place = p;
    this.group.visible = !!p;
    if (!p) return;
    this.group.position.set(p.x, 0, p.z);
    this.group.rotation.set(0, p.yaw, 0);
    // The plaque on the wall to its right, turned to the room's middle; the sign on the wall over it.
    const px = DOOR.width / 2 + DOOR.casing + 0.42;
    const pz = wallBehind(room, p, px) + 0.035;
    this.plaque.position.set(px, 1.5, pz);
    this.plaque.rotation.y = room.kind === 'rotunda' ? Math.atan2(-px, p.z - pz) : 0;
    this.sign.position.set(0, 2.62, Math.max(wallBehind(room, p, 0.4), wallBehind(room, p, -0.4)) + 0.03);
    this.group.updateMatrixWorld(true);
    placePortal(this.portal);
  }

  /** Per frame: the veil drifts, and the doorway brightens when pointed at or stood near. */
  /**
   * Per frame: the glow toward the viewer's nearness or pointing, and the portal's shimmer (held
   * with less motion: `still`, common's reduceMotion).
   */
  update(dt, camera, still = false) {
    if (!this.place) return;
    camera.getWorldPosition(_head);
    const p = doorLocal(this.place, _head.x, _head.z, _q);
    const near = Math.hypot(p.x, p.z - DOOR.depth) < DOOR.near;
    const target = this.hover ? 1 : near ? 0.45 : 0;
    this._glow += (target - this._glow) * (1 - Math.exp(-dt * 7));
    const u = this.portal.material.uniforms;
    u.uGlow.value = this._glow;
    if (!still) u.uTime.value += dt;
  }

  /**
   * The Hallway's own view out of this library's door there (`views` its views.json, `id` the
   * door's), in place of the painted one. Optional: when it cannot be read (offline, or none for
   * that door), the painting stays.
   * @returns {Promise<boolean>} whether it is shown
   */
  async loadView(views, id) {
    try {
      const res = await fetch(views, { cache: 'no-cache' });
      const v = res.ok ? viewParams((await res.json())?.views?.[id]) : null;
      if (!v) return false;
      const image = await fetch(new URL(v.image, res.url));
      if (!image.ok) return false;
      // Flipped and unconverted, as three would upload it (canvas-texture.js).
      const bitmap = await createImageBitmap(await image.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const painted = this.portal.material.uniforms.uMap.value;
      setView(this.portal.material, canvasTexture(bitmap, { anisotropy: 4 }), v);
      painted.dispose();
      return true;
    } catch (err) {
      console.warn(`vrlbry: the Hallway's view from this door could not be shown (${err.message})`);
      return false;
    }
  }

  /** A ray against it (rayDoor): { distance, opening }, reused, or null. */
  raycast(ray) {
    return this.place ? rayDoor(this.place, ray, _hit) : null;
  }

  /** Whether a head at (x, z) has passed through it. */
  crossed(x, z) {
    return !!this.place && doorCrossed(this.place, x, z);
  }

  /** Where to stand `distance` in front of it, facing the room: { position, yaw }. */
  inFront(distance) {
    if (!this.place) return null;
    const w = doorWorld(this.place, 0, DOOR.depth + distance, _q);
    return { position: new THREE.Vector3(w.x, 0, w.z), yaw: this.place.yaw + Math.PI };
  }
}
