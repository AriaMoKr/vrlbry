// The library room (SPEC §5.3): a rotunda for small collections, a hall with aisles for big
// ones, plus furniture and lighting. Procedural textures only; no real-time shadows (contact
// shadows are soft decals).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture } from './canvas-texture.js';
import {
  makePlankCanvas, makePlasterCanvas, makeWoodCanvas, makeSkyCanvas, makeShadowCanvas,
  makeRugCanvas, rng,
} from './textures.js';

export const WALL_H = 4.4;

/** Dark-to-clear gradient for the floor rim along the wall. */
function makeRimCanvas() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 64);
  return c;
}

/** Scales a geometry's UVs so a repeating texture tiles at a fixed real-world size. */
function tileUVs(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

/**
 * Shared materials and textures (created on first use, reused across rebuilds): switching rooms
 * re-uploads nothing to the GPU. Tiling is done in the geometry UVs, never by cloning textures.
 */
let M = null;
function materials() {
  if (M) return M;
  const plank = canvasTexture(makePlankCanvas({ w: 1024, h: 1024, boards: 8 }), { repeat: [1, 1], anisotropy: 8 });
  const plaster = canvasTexture(makePlasterCanvas({ w: 512, h: 512 }), { repeat: [1, 1] });
  const wood = canvasTexture(makeWoodCanvas({ w: 1024, h: 256, base: '#4a2a16', dark: '#28150a', light: '#6b4227', seed: 31 }), { repeat: [1, 1] });
  const sky = canvasTexture(makeSkyCanvas({ w: 256, h: 512 }));
  M = {
    plankTex: plank,
    plasterTex: plaster,
    floor: new THREE.MeshLambertMaterial({ map: plank }),
    wall: new THREE.MeshLambertMaterial({ map: plaster, side: THREE.BackSide }),
    wallFront: new THREE.MeshLambertMaterial({ map: plaster }),
    ceiling: new THREE.MeshLambertMaterial({ map: plaster, side: THREE.BackSide, color: 0xd9ccb4, emissive: 0x1c140c }),
    wood: new THREE.MeshLambertMaterial({ map: wood }),
    woodBack: new THREE.MeshLambertMaterial({ map: wood, side: THREE.BackSide }),
    darkWood: new THREE.MeshLambertMaterial({ map: wood, color: 0x8a7766 }),
    sky: new THREE.MeshBasicMaterial({ map: sky, toneMapped: false }),
    brass: new THREE.MeshLambertMaterial({ color: 0xb08d47, emissive: 0x2a1c08 }),
    leather: new THREE.MeshLambertMaterial({ color: 0x6e2a1f }),
    glow: new THREE.MeshBasicMaterial({ color: 0xffe0a8, toneMapped: false }),
    shade: new THREE.MeshLambertMaterial({ color: 0xe9c88f, emissive: 0x9a6a2a, side: THREE.DoubleSide }),
    shadow: new THREE.MeshBasicMaterial({ map: canvasTexture(makeShadowCanvas({ size: 128, strength: 0.6 })), transparent: true, depthWrite: false }),
    rug: new THREE.MeshLambertMaterial({ map: canvasTexture(makeRugCanvas({ size: 512 })) }),
    globe: new THREE.MeshLambertMaterial({ color: 0x9fb38a }),
    stand: new THREE.MeshLambertMaterial({ color: 0x3a2516 }),
    rimTex: canvasTexture(makeRimCanvas()),
  };
  return M;
}

function shadowDecal(group, x, z, sx, sz, rot = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), materials().shadow);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = rot;
  m.position.set(x, 0.004, z);
  m.renderOrder = 1;
  group.add(m);
  return m;
}

/** Arched window (frame, mullions, sill) facing +Z, bottom centre at the origin. */
/** One arched window's geometries in window space, by material: glass, dark wood, wood. */
function windowParts(width, height) {
  const r = width / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-r, 0);
  shape.lineTo(r, 0);
  shape.lineTo(r, height - r);
  shape.absarc(0, height - r, r, 0, Math.PI, false);
  shape.lineTo(-r, 0);
  const glassGeo = new THREE.ShapeGeometry(shape, 24);
  // ShapeGeometry UVs are in shape units: normalise for the sky texture.
  const uv = glassGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + r) / width, uv.getY(i) / height);
  const frameShape = new THREE.Shape();
  const fr = r + 0.09;
  frameShape.moveTo(-fr, -0.08);
  frameShape.lineTo(fr, -0.08);
  frameShape.lineTo(fr, height - r);
  frameShape.absarc(0, height - r, fr, 0, Math.PI, false);
  frameShape.lineTo(-fr, -0.08);
  frameShape.holes.push(shape);
  const frame = new THREE.ExtrudeGeometry(frameShape, { depth: 0.08, bevelEnabled: false, curveSegments: 24 });
  frame.translate(0, 0, -0.02);
  const bars = [];
  const bar = (w, h, x, y) => {
    const b = new THREE.BoxGeometry(w, h, 0.03);
    b.translate(x, y, 0.01);
    bars.push(b);
  };
  bar(0.035, height - 0.05, 0, (height - 0.05) / 2);
  for (const f of [0.3, 0.55]) bar(width, 0.03, 0, height * f);
  const sill = new THREE.BoxGeometry(width + 0.3, 0.06, 0.22);
  sill.translate(0, -0.1, 0.06);
  return { sky: [glassGeo], darkWood: [frame, ...bars], wood: [sill] };
}

/**
 * Adds a room's windows as three meshes (glass, dark wood, wood) rather than four per window: a
 * long hall has dozens of windows, and draw calls are the Quest's bottleneck.
 * @param {THREE.Group} group
 * @param {Array<{ width: number, height: number, x: number, y: number, z: number, yaw: number }>} windows
 */
function addWindows(group, windows) {
  if (!windows.length) return;
  const mats = materials();
  const parts = { sky: [], darkWood: [], wood: [] };
  const m = new THREE.Matrix4();
  for (const w of windows) {
    m.makeRotationY(w.yaw).setPosition(w.x, w.y, w.z);
    for (const [key, geos] of Object.entries(windowParts(w.width, w.height))) {
      for (const g of geos) {
        // mergeGeometries needs all-indexed or all-non-indexed input (ExtrudeGeometry is the latter).
        const flat = g.index ? g.toNonIndexed() : g;
        if (flat !== g) g.dispose();
        parts[key].push(flat.applyMatrix4(m));
      }
    }
  }
  for (const [key, geos] of Object.entries(parts)) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mats[key]);
    geos.forEach((g) => g.dispose());
    mesh.name = 'windows';
    group.add(mesh);
  }
}

/** Round reading table with a lamp and a few books; returns the lamp light. */
function makeReadingCorner(group, x, z, facing) {
  const mats = materials();
  const corner = new THREE.Group();
  corner.position.set(x, 0, z);
  corner.rotation.y = facing;
  group.add(corner);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 40), mats.wood);
  top.position.y = 0.74;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.7, 16), mats.darkWood);
  stem.position.y = 0.37;
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.04, 32), mats.darkWood);
  foot.position.y = 0.02;
  corner.add(top, stem, foot);
  // Lamp.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.03, 20), mats.brass);
  base.position.set(0.22, 0.775, -0.1);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 8), mats.brass);
  pole.position.set(0.22, 0.97, -0.1);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.15, 0.16, 24, 1, true), mats.shade);
  shade.position.set(0.22, 1.17, -0.1);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), mats.glow);
  bulb.position.set(0.22, 1.12, -0.1);
  corner.add(base, pole, shade, bulb);
  const lamp = new THREE.PointLight(0xffb468, 2.2, 5, 1.6);
  lamp.position.set(0.22, 1.1, -0.1);
  corner.add(lamp);
  // A small stack of books.
  const r = rng(77);
  let y = 0.76;
  for (let i = 0; i < 3; i++) {
    const h = 0.03 + r() * 0.02;
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2 + r() * 0.05, h, 0.27 + r() * 0.04),
      new THREE.MeshLambertMaterial({ color: ['#5b1a1a', '#23314f', '#2f3b23'][i] }));
    b.position.set(-0.18, y + h / 2, 0.1);
    b.rotation.y = (r() - 0.5) * 0.5;
    y += h;
    corner.add(b);
  }
  // Armchair beside the table.
  const chair = new THREE.Group();
  chair.position.set(-0.95, 0, 0.25);
  chair.rotation.y = 0.5;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.16, 0.7), mats.leather);
  seat.position.y = 0.42;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.16), mats.leather);
  back.position.set(0, 0.78, -0.3);
  back.rotation.x = -0.12;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.26, 0.72), mats.leather);
  armL.position.set(-0.36, 0.6, 0);
  const armR = armL.clone();
  armR.position.x = 0.36;
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.34, 0.66), mats.darkWood);
  plinth.position.y = 0.17;
  chair.add(seat, back, armL, armR, plinth);
  corner.add(chair);
  shadowDecal(corner, 0, 0, 1.5, 1.5);
  shadowDecal(corner, chair.position.x, chair.position.z, 1.2, 1.2, chair.rotation.y);
  corner.updateMatrixWorld(true);
  const chairWorld = chair.position.clone().applyMatrix4(corner.matrix);
  return { lamp, colliders: [
    { type: 'circle', x, z, r: 0.62, h: 0.78 },
    { type: 'circle', x: chairWorld.x, z: chairWorld.z, r: 0.5, h: 0.95 },
  ] };
}

/** A globe on a wooden stand. */
function makeGlobe(group, x, z) {
  const mats = materials();
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.62, 12), mats.stand);
  legs.position.y = 0.31;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.012, 8, 40), mats.brass);
  ring.position.y = 0.92;
  ring.rotation.y = Math.PI / 2;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 20), mats.globe);
  ball.position.y = 0.92;
  ball.rotation.z = 0.4;
  g.add(legs, ring, ball);
  group.add(g);
  shadowDecal(group, x, z, 0.8, 0.8);
  return { type: 'circle', x, z, r: 0.35, h: 1.2 };
}

/** The catalogue pedestal (the kiosk panel floats above it). */
function makePedestal(group, x, z, yaw) {
  const mats = materials();
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  const col = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.86, 0.3), mats.wood);
  col.position.y = 0.43;
  const capital = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.4), mats.darkWood);
  capital.position.y = 0.885;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.4), mats.darkWood);
  base.position.y = 0.03;
  const desk = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.035, 0.42), mats.wood);
  desk.position.set(0, 0.95, 0.02);
  desk.rotation.x = 0.35;
  g.add(col, capital, base, desk);
  group.add(g);
  shadowDecal(group, x, z, 0.9, 0.9);
  return { type: 'circle', x, z, r: 0.32, h: 1.0 };
}

/** Chandelier: brass ring with glowing candles and a warm point light. */
function makeChandelier(group, x, y, z, radius = 0.6, { light: withLight = true } = {}) {
  const mats = materials();
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.02, 8, 48), mats.brass);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.2, 6), mats.brass);
  chain.position.y = 0.6;
  g.add(chain);
  const candles = [];
  const flames = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = new THREE.CylinderGeometry(0.015, 0.015, 0.12, 8);
    c.translate(Math.cos(a) * radius, 0.07, Math.sin(a) * radius);
    candles.push(c);
    const f = new THREE.SphereGeometry(0.022, 8, 6);
    f.scale(1, 1.6, 1);
    f.translate(Math.cos(a) * radius, 0.16, Math.sin(a) * radius);
    flames.push(f);
  }
  g.add(new THREE.Mesh(mergeGeometries(candles), new THREE.MeshLambertMaterial({ color: 0xf2e6cc, emissive: 0x3a2a14 })));
  g.add(new THREE.Mesh(mergeGeometries(flames), mats.glow));
  group.add(g);
  if (!withLight) return null;
  const light = new THREE.PointLight(0xffc98a, 9, 14, 1.2);
  light.position.y = 0.1;
  g.add(light);
  return light;
}

/** Floating dust motes catching the warm light. */
function makeDust(group, cx, cz, radius, height) {
  const n = 260;
  const pos = new Float32Array(n * 3);
  const r = rng(99);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * radius;
    pos[i * 3] = cx + Math.cos(a) * d;
    pos[i * 3 + 1] = 0.3 + r() * height;
    pos[i * 3 + 2] = cz + Math.sin(a) * d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffe2b0, size: 0.012, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  group.add(pts);
  const phase = new Float32Array(n).map(() => r() * Math.PI * 2);
  let t = 0;
  return (dt) => {
    t += dt;
    const a = geo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      a[i * 3 + 1] += Math.sin(t * 0.3 + phase[i]) * 0.0008 + 0.0004;
      if (a[i * 3 + 1] > height + 0.3) a[i * 3 + 1] = 0.3;
      a[i * 3] += Math.cos(t * 0.2 + phase[i]) * 0.0005;
    }
    geo.attributes.position.needsUpdate = true;
  };
}

function commonLights(group) {
  const hemi = new THREE.HemisphereLight(0xffe6c4, 0x3a2414, 1.25);
  group.add(hemi);
  const fill = new THREE.AmbientLight(0x4a3a2c, 0.5);
  group.add(fill);
}

/**
 * Rotunda: circular wall of radius R with bookcases placed by the caller, windows at the given
 * angles (radians, 0 = −Z, increasing toward +X), a dome and a central reading area.
 * @returns {{ group, floor, walkable(x,z): boolean, boundary(p, radius), colliders, update(dt) }}
 */
export function createRotunda({ R, windowAngles = [], kiosk, decor = true }) {
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'room-rotunda';
  const seg = 96;
  const floorGeo = new THREE.CircleGeometry(R + 0.05, seg);
  floorGeo.rotateX(-Math.PI / 2);
  // Planks at ~0.17 m per board: scale UVs (CircleGeometry UVs span 0..1 over the diameter).
  const uv = floorGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (2 * R) / 1.4, uv.getY(i) * (2 * R) / 1.4);
  const floor = new THREE.Mesh(floorGeo, mats.floor);
  floor.name = 'floor';
  group.add(floor);
  // Darker rim where the floor meets the wall.
  const rim = new THREE.Mesh(new THREE.RingGeometry(R - 1.4, R + 0.05, seg, 1), new THREE.MeshBasicMaterial({ map: mats.rimTex, transparent: true, depthWrite: false }));
  // RingGeometry UV is planar; remap v to radial distance so the gradient runs outward.
  const ruv = rim.geometry.attributes.uv;
  const rpos = rim.geometry.attributes.position;
  for (let i = 0; i < ruv.count; i++) {
    const d = Math.hypot(rpos.getX(i), rpos.getY(i));
    ruv.setXY(i, 0.5, 1 - (d - (R - 1.4)) / 1.45);
  }
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.003;
  group.add(rim);

  const circ = 2 * Math.PI * R;
  const wallGeo = new THREE.CylinderGeometry(R, R, WALL_H, seg, 1, true);
  const wuv = wallGeo.attributes.uv;
  for (let i = 0; i < wuv.count; i++) wuv.setXY(i, wuv.getX(i) * circ / 2.2, wuv.getY(i) * WALL_H / 2.2);
  const wall = new THREE.Mesh(wallGeo, mats.wall);
  wall.position.y = WALL_H / 2;
  group.add(wall);
  const wainscot = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.012, R - 0.012, 1.0, seg, 1, true), mats.woodBack);
  wainscot.position.y = 0.5;
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.03, R - 0.03, 0.06, seg, 1, true), mats.woodBack);
  rail.position.y = 1.0;
  const cornice = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.06, R - 0.01, 0.28, seg, 1, true), mats.woodBack);
  cornice.position.y = WALL_H - 0.14;
  group.add(wainscot, rail, cornice);
  // Dome with an oculus.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, seg, 24, 0, Math.PI * 2, 0, Math.PI / 2), mats.ceiling);
  dome.scale.y = 0.5;
  dome.position.y = WALL_H;
  group.add(dome);
  const oculus = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40), mats.sky);
  oculus.rotation.x = Math.PI / 2;
  oculus.position.y = WALL_H + R * 0.5 - 0.02;
  group.add(oculus);

  const rr = R - 0.03;
  addWindows(group, windowAngles.map((a) => ({ width: 1.1, height: 2.4, x: Math.sin(a) * rr, y: 1.15, z: -Math.cos(a) * rr, yaw: -a })));

  commonLights(group);
  const chandelier = makeChandelier(group, 0, WALL_H - 0.5, 0, 0.7);
  const colliders = [];
  let lamp = null;
  if (decor) {
    const rug = new THREE.Mesh(new THREE.CircleGeometry(Math.min(1.9, R * 0.45), 64), mats.rug);
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.006;
    group.add(rug);
    const corner = makeReadingCorner(group, -Math.min(1.7, R * 0.45), Math.min(0.9, R * 0.25), 0.6);
    lamp = corner.lamp;
    colliders.push(...corner.colliders);
    colliders.push(makeGlobe(group, Math.min(2.0, R * 0.55), Math.min(1.4, R * 0.4)));
  }
  if (kiosk) colliders.push(makePedestal(group, kiosk.position.x, kiosk.position.z, kiosk.yaw));
  const dust = makeDust(group, 0, 0, R * 0.7, WALL_H - 0.8);
  let t = 0;

  const walkR = R - 0.45;
  return {
    group, floor, colliders, kind: 'rotunda', R,
    // Laser stop: the round wall, the dome above it, the floor, the furniture.
    raycast: (ray) => Math.min(
      rayCylinderExit(ray, 0, 0, R, WALL_H), raySphereExit(ray, 0, WALL_H, 0, R), rayFloor(ray), rayColliders(ray, colliders),
    ),
    walkable: (x, z) => Math.hypot(x, z) < walkR,
    boundary(p, radius) {
      const d = Math.hypot(p.x, p.z);
      const max = walkR - radius;
      if (d > max) {
        p.x *= max / d;
        p.z *= max / d;
      }
    },
    update(dt) {
      t += dt;
      dust(dt);
      chandelier.intensity = 9 + Math.sin(t * 7.3) * 0.15 + Math.sin(t * 13.1) * 0.1;
      if (lamp) lamp.intensity = 2.2 + Math.sin(t * 9.7) * 0.05;
    },
  };
}

/**
 * Rectangular hall for large collections: bounds in metres, windows along the long walls,
 * several chandeliers down the central aisle.
 */
export function createHall({ minX, maxX, minZ, maxZ, kiosk }) {
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'room-hall';
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const floor = new THREE.Mesh(tileUVs(new THREE.PlaneGeometry(w, d), w / 1.4, d / 1.4), mats.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.name = 'floor';
  group.add(floor);
  const walls = [
    [w, cx, maxZ, Math.PI], [w, cx, minZ, 0], [d, minX, cz, Math.PI / 2], [d, maxX, cz, -Math.PI / 2],
  ];
  for (const [len, x, z, rot] of walls) {
    const m = new THREE.Mesh(tileUVs(new THREE.PlaneGeometry(len, WALL_H), len / 2.2, WALL_H / 2.2), mats.wallFront);
    m.position.set(x, WALL_H / 2, z);
    m.rotation.y = rot;
    group.add(m);
    const wains = new THREE.Mesh(new THREE.BoxGeometry(len, 1.0, 0.03), mats.wood);
    wains.position.set(x, 0.5, z);
    wains.rotation.y = rot;
    wains.translateZ(0.015);
    group.add(wains);
  }
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mats.ceiling.clone());
  ceil.material.side = THREE.DoubleSide;
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(cx, WALL_H, cz);
  group.add(ceil);
  const windows = [];
  for (let z = maxZ - 2.5; z > minZ + 1.5; z -= 3.2) {
    for (const [x, yaw] of [[minX + 0.03, Math.PI / 2], [maxX - 0.03, -Math.PI / 2]]) windows.push({ width: 1.0, height: 2.2, x, y: 1.2, z, yaw });
  }
  addWindows(group, windows);
  commonLights(group);
  const lights = [];
  const n = Math.max(1, Math.min(3, Math.round(d / 8)));
  // Exactly two point lights in every room shape (here: the first two chandeliers, or one plus a
  // lamp-like fill): each light costs per-pixel shading on a Quest, and a different light count
  // would make three.js recompile every shader when switching rooms.
  for (let i = 0; i < n; i++) lights.push(makeChandelier(group, cx, WALL_H - 0.6, maxZ - (i + 0.5) * (d / n), 0.6, { light: i < 2 }));
  if (n === 1) {
    const fill = new THREE.PointLight(0xffb468, 2.2, 5, 1.6);
    fill.position.set(kiosk ? kiosk.position.x : cx, 1.6, kiosk ? kiosk.position.z : maxZ - 2);
    group.add(fill);
  }
  const colliders = [];
  if (kiosk) colliders.push(makePedestal(group, kiosk.position.x, kiosk.position.z, kiosk.yaw));
  const dust = makeDust(group, cx, maxZ - 3, 3, WALL_H - 1);
  const margin = 0.35;
  return {
    group, floor, colliders, kind: 'hall',
    // Laser stop: the four walls, the ceiling, the floor, the furniture.
    raycast: (ray) => Math.min(rayBoxExit(ray, minX, maxX, minZ, maxZ), rayFloor(ray), rayColliders(ray, colliders)),
    walkable: (x, z) => x > minX + margin && x < maxX - margin && z > minZ + margin && z < maxZ - margin,
    boundary(p, radius) {
      p.x = Math.min(maxX - margin - radius, Math.max(minX + margin + radius, p.x));
      p.z = Math.min(maxZ - margin - radius, Math.max(minZ + margin + radius, p.z));
    },
    update(dt) {
      dust(dt);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Laser stops: rays from inside the room against its walls, floor, ceiling and furniture, as
// simple shapes (the furniture's walking circles, with heights). Each returns the distance
// along the ray (direction normalized), or Infinity.

/** The floor (y = 0), seen from above. */
function rayFloor({ origin: o, direction: d }) {
  return d.y < -1e-6 && o.y > 0 ? -o.y / d.y : Infinity;
}

/** Leaving an upright cylinder of radius r around (cx, cz), below height h, from inside. */
function rayCylinderExit({ origin: o, direction: d }, cx, cz, r, h) {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-12) return Infinity;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const t = (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a;
  const y = o.y + t * d.y;
  return t > 0 && y >= 0 && y <= h ? t : Infinity;
}

/** The upper half of a sphere (a dome) seen from inside, above its centre height. */
function raySphereExit({ origin: o, direction: d }, cx, cy, cz, r) {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const t = -b + Math.sqrt(Math.max(0, b * b - c));
  return t > 0 && o.y + t * d.y >= cy ? t : Infinity;
}

/** Leaving a box room (walls at the bounds, ceiling at WALL_H) from inside. */
function rayBoxExit({ origin: o, direction: d }, minX, maxX, minZ, maxZ) {
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, (maxX - o.x) / d.x);
  else if (d.x < -1e-9) t = Math.min(t, (minX - o.x) / d.x);
  if (d.z > 1e-9) t = Math.min(t, (maxZ - o.z) / d.z);
  else if (d.z < -1e-9) t = Math.min(t, (minZ - o.z) / d.z);
  if (d.y > 1e-9) t = Math.min(t, (WALL_H - o.y) / d.y);
  return t > 0 ? t : Infinity;
}

/** The nearest piece of furniture: upright cylinders (sides and top), not when inside one. */
function rayColliders({ origin: o, direction: d }, colliders) {
  let best = Infinity;
  for (const c of colliders) {
    const h = c.h ?? 1;
    const ox = o.x - c.x;
    const oz = o.z - c.z;
    const c0 = ox * ox + oz * oz - c.r * c.r;
    if (c0 < 0 && o.y < h) continue; // standing in it
    const a = d.x * d.x + d.z * d.z;
    if (a > 1e-12 && c0 > 0) {
      const b = ox * d.x + oz * d.z;
      const disc = b * b - a * c0;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a; // entering the side
        const y = o.y + t * d.y;
        if (t > 0 && y >= 0 && y <= h) best = Math.min(best, t);
      }
    }
    if (d.y < -1e-6 && o.y > h) {
      const t = (h - o.y) / d.y; // onto the top
      const x = ox + t * d.x;
      const z = oz + t * d.z;
      if (x * x + z * z <= c.r * c.r) best = Math.min(best, t);
    }
  }
  return best;
}

/** Disposes geometries of a room group (shared materials/textures are kept for rebuilds). */
export function disposeRoom(room) {
  room.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && o.material !== M?.shadow && !Object.values(M || {}).includes(o.material)) {
      if (o.material.map && !Object.values(M || {}).includes(o.material.map)) o.material.map.dispose();
      o.material.dispose();
    }
  });
  room.group.removeFromParent();
}
