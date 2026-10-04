// Input (SPEC §5.4): XR controllers and hands, mouse + keyboard, touch — unified into pointers
// (world-space raycasters) and events, plus locomotion (teleport arc, snap turn, smooth move).
//
// Desktop uses drag-to-look rather than pointer lock (a deliberate deviation from the spec): it
// keeps the DOM overlay usable and works in embedded browsers where pointer lock is refused.

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { PLAYER } from '../config.js';

const DEADZONE = 0.15;
const FLICK_ON = 0.7;
const FLICK_OFF = 0.3;
const RAY_LENGTH = 5;
const DRAG_THRESHOLD = 6; // px before a press becomes a drag (look) instead of a click
const ARC_SPEED = 7.5;
const GRAVITY = 9.8;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

function makePointerVisual() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf3d9a0, transparent: true, opacity: 0.75 }));
  line.scale.z = RAY_LENGTH;
  line.name = 'pointer-ray';
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.006, 0.011, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
  );
  cursor.renderOrder = 30;
  cursor.position.z = -RAY_LENGTH;
  cursor.visible = false;
  return { line, cursor };
}

/** A fallback controller body shown until (or instead of) the profile model. */
function makeFallbackController() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x2b2b2e });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.11, 16), mat);
  body.rotation.x = Math.PI / 2 - 0.5;
  body.position.set(0, -0.01, 0.03);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 24), mat);
  ring.position.set(0, 0.015, -0.03);
  ring.rotation.x = 0.6;
  g.add(body, ring);
  g.name = 'fallback-controller';
  return g;
}

export class Controls extends EventTarget {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {THREE.Group} o.rig group containing the camera; locomotion moves it
   * @param {THREE.Scene} o.scene
   * @param {object} o.world World (constrain, isWalkable, teleportTargets)
   * @param {HTMLElement} o.domElement canvas
   */
  constructor({ renderer, camera, rig, scene, world, domElement }) {
    super();
    this.renderer = renderer;
    this.camera = camera;
    this.rig = rig;
    this.scene = scene;
    this.world = world;
    this.dom = domElement;
    this.locomotionEnabled = true;
    this.smoothMove = true;
    this.snapAngle = PLAYER.snapTurn;
    this.pointers = [];
    this.yaw = 0;
    this.pitch = 0;
    this._keys = new Set();
    this._xr = [];
    this._rayVisible = true;
    this._modelFactory = new XRControllerModelFactory();
    this._handFactory = new XRHandModelFactory();
    for (let i = 0; i < 2; i++) this._setupXR(i);

    // Mouse / touch pointer (one at a time).
    this._mouse = {
      pointer: this._makeScreenPointer('mouse'),
      ndc: new THREE.Vector2(),
      inside: false,
      down: null,
    };
    this._touches = new Map();
    this._bindDom();
    this._teleport = this._makeTeleportVisual();
    scene.add(this._teleport.group);
  }

  // -------------------------------------------------------------------------------------------
  // XR

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  _setupXR(i) {
    const xr = this.renderer.xr;
    const controller = xr.getController(i);
    const grip = xr.getControllerGrip(i);
    const hand = xr.getHand(i);
    this.rig.add(controller, grip, hand);
    const model = this._modelFactory.createControllerModel(grip);
    grip.add(model);
    const fallback = makeFallbackController();
    fallback.visible = false;
    grip.add(fallback);
    hand.add(this._handFactory.createHandModel(hand, 'spheres'));
    const visual = makePointerVisual();
    controller.add(visual.line, visual.cursor);
    const entry = {
      index: i, controller, grip, hand, model, fallback, visual, source: null, pointer: null,
      stick: { x: 0, y: 0 }, flicks: {}, buttons: [], aiming: false,
    };
    this._xr.push(entry);
    controller.addEventListener('connected', (e) => this._onConnected(entry, e.data));
    controller.addEventListener('disconnected', () => this._onDisconnected(entry));
    for (const type of ['selectstart', 'selectend', 'select', 'squeezestart', 'squeezeend']) {
      controller.addEventListener(type, () => {
        if (entry.pointer) this._emit(type, { pointer: entry.pointer });
      });
    }
  }

  _onConnected(entry, source) {
    entry.source = source;
    const isHand = !!source.hand;
    const pointer = {
      id: `xr-${entry.index}`,
      kind: isHand ? 'xr-hand' : 'xr-controller',
      hand: source.handedness === 'left' || source.handedness === 'right' ? source.handedness : null,
      raycaster: new THREE.Raycaster(),
      object3D: entry.controller,
      hovering: false,
      setHitDistance: (d) => {
        const len = d == null ? RAY_LENGTH : Math.max(0.02, d);
        entry.visual.line.scale.z = len;
        entry.visual.cursor.position.z = -len + 0.002;
        entry.visual.cursor.visible = d != null;
      },
      setHovering: (h) => {
        pointer.hovering = h;
        entry.visual.line.material.color.setHex(h ? 0xffd27a : 0xf3d9a0);
        entry.visual.line.material.opacity = h ? 0.95 : 0.6;
      },
    };
    pointer.raycaster.far = 30;
    entry.pointer = pointer;
    entry.visual.line.visible = source.targetRayMode === 'tracked-pointer' && this._rayVisible;
    entry.fallback.visible = !isHand;
    entry.buttons = [];
    entry.flicks = {};
  }

  _onDisconnected(entry) {
    entry.source = null;
    entry.pointer = null;
    entry.fallback.visible = false;
    entry.visual.line.visible = false;
    entry.visual.cursor.visible = false;
    if (entry.aiming) this._endAim(entry, false);
  }

  setRayVisible(visible) {
    this._rayVisible = visible;
    for (const e of this._xr) {
      if (e.source) e.visual.line.visible = visible && e.source.targetRayMode === 'tracked-pointer';
      if (!visible) e.visual.cursor.visible = false;
    }
  }

  _pollXR(dt) {
    for (const e of this._xr) {
      const src = e.source;
      if (!src || !e.pointer) continue;
      // Hide the fallback once the real model has loaded.
      if (e.fallback.visible && e.model.motionController) e.fallback.visible = false;
      // Ray from the controller's target ray space.
      e.controller.updateMatrixWorld();
      const rc = e.pointer.raycaster;
      rc.ray.origin.setFromMatrixPosition(e.controller.matrixWorld);
      rc.ray.direction.set(0, 0, -1).applyQuaternion(e.controller.getWorldQuaternion(_q)).normalize();
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = e.pointer.hand || (e.index === 0 ? 'left' : 'right');
      // xr-standard: axes 2/3 thumbstick (some runtimes report 0/1 only).
      const x = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
      const y = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
      e.stick.x = x;
      e.stick.y = y;
      if (Math.abs(x) > DEADZONE || Math.abs(y) > DEADZONE) this._emit('axis', { hand, x, y });
      this._flicks(e.flicks, hand, x, y);
      const names = { 4: hand === 'left' ? 'x' : 'a', 5: hand === 'left' ? 'y' : 'b', 3: 'stick', 12: 'menu' };
      gp.buttons.forEach((b, bi) => {
        const was = e.buttons[bi] || false;
        if (b.pressed !== was) {
          e.buttons[bi] = b.pressed;
          if (names[bi]) this._emit('button', { hand, name: names[bi], pressed: b.pressed });
        }
      });
      if (this.locomotionEnabled) this._xrLocomotion(e, hand, x, y, dt);
      else if (e.aiming) this._endAim(e, false);
    }
  }

  _flicks(state, hand, x, y) {
    const dirs = { left: -x, right: x, up: -y, down: y };
    for (const [dir, v] of Object.entries(dirs)) {
      if (!state[dir] && v > FLICK_ON) {
        state[dir] = true;
        this._emit('flick', { hand, dir });
      } else if (state[dir] && v < FLICK_OFF) {
        state[dir] = false;
      }
    }
  }

  _xrLocomotion(e, hand, x, y, dt) {
    if (hand === 'right') {
      // Teleport: push forward to aim, release to jump.
      if (!e.aiming && y < -0.6) e.aiming = true;
      if (e.aiming) {
        this._updateAim(e);
        if (y > -0.3) this._endAim(e, true);
      } else if (e.flicks.left && !e._turned) {
        e._turned = 'left';
        this.snapTurn(this.snapAngle);
      } else if (e.flicks.right && !e._turned) {
        e._turned = 'right';
        this.snapTurn(-this.snapAngle);
      }
      if (!e.flicks.left && !e.flicks.right) e._turned = null;
    } else if (this.smoothMove && (Math.abs(x) > DEADZONE || Math.abs(y) > DEADZONE)) {
      this._move(-y, x, PLAYER.walkSpeed * dt);
    }
  }

  _makeTeleportVisual() {
    const group = new THREE.Group();
    group.name = 'teleport';
    const n = 48;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.85 }));
    line.frustumCulled = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.27, 40),
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 12), ring.material);
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.z = -0.36;
    const target = new THREE.Group();
    target.add(ring, arrow);
    group.add(line, target);
    group.visible = false;
    return { group, line, target, n, point: null, valid: false };
  }

  _updateAim(e) {
    const t = this._teleport;
    const origin = e.pointer.raycaster.ray.origin.clone();
    const vel = e.pointer.raycaster.ray.direction.clone().multiplyScalar(ARC_SPEED);
    const pos = t.line.geometry.attributes.position;
    const rc = new THREE.Raycaster();
    let prev = origin.clone();
    let hit = null;
    let count = 0;
    for (let i = 0; i < t.n; i++) {
      const tt = i * 0.035;
      const p = origin.clone().addScaledVector(vel, tt);
      p.y -= 0.5 * GRAVITY * tt * tt;
      if (i > 0 && !hit) {
        const seg = p.clone().sub(prev);
        const len = seg.length();
        rc.set(prev, seg.normalize());
        rc.far = len;
        const h = rc.intersectObjects(this.world.teleportTargets, false)[0];
        if (h) {
          hit = h.point;
          pos.setXYZ(count++, hit.x, hit.y, hit.z);
          break;
        }
      }
      pos.setXYZ(count++, p.x, p.y, p.z);
      prev = p;
      if (p.y < -1) break;
    }
    for (let i = count; i < t.n; i++) pos.setXYZ(i, prev.x, prev.y, prev.z);
    pos.needsUpdate = true;
    t.line.geometry.setDrawRange(0, count);
    t.group.visible = true;
    t.valid = !!hit && this.world.isWalkable(hit.x, hit.z);
    t.point = hit;
    const color = t.valid ? 0x9be7ff : 0xff7a6b;
    t.line.material.color.setHex(color);
    t.target.children[0].material.color.setHex(color);
    t.target.visible = !!hit;
    if (hit) {
      t.target.position.set(hit.x, hit.y + 0.01, hit.z);
      // The arrow shows the facing after teleport (current head yaw).
      t.target.rotation.y = this._headYaw();
    }
  }

  _endAim(e, commit) {
    const t = this._teleport;
    e.aiming = false;
    t.group.visible = false;
    if (commit && t.valid && t.point) this.teleportTo(t.point);
  }

  // -------------------------------------------------------------------------------------------
  // Locomotion helpers

  _headYaw() {
    this.camera.getWorldDirection(_v);
    return Math.atan2(-_v.x, -_v.z);
  }

  /** Viewer position on the floor (world XZ, y = rig y). */
  viewerPosition(target = new THREE.Vector3()) {
    this.camera.getWorldPosition(target);
    target.y = this.rig.position.y;
    return target;
  }

  /**
   * Moves the rig so that the viewer stands at `position` (XZ), optionally facing `yaw`
   * (viewer yaw: looking along (−sin yaw, 0, −cos yaw)).
   */
  teleportTo(position, yaw) {
    if (yaw != null) {
      if (this.presenting) {
        const delta = yaw - this._headYaw();
        this._rotateAroundViewer(delta);
      } else {
        this.yaw = yaw;
        this.rig.rotation.y = yaw;
      }
    }
    this.rig.updateMatrixWorld(true);
    const viewer = this.viewerPosition(_v2);
    this.rig.position.x += position.x - viewer.x;
    this.rig.position.z += position.z - viewer.z;
    this.rig.updateMatrixWorld(true);
    this._emit('teleport', { position: position.clone() });
  }

  _rotateAroundViewer(angle) {
    const head = this.viewerPosition(new THREE.Vector3());
    this.rig.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(head);
    this.rig.rotation.y += angle;
    if (!this.presenting) this.yaw = this.rig.rotation.y;
    this.rig.updateMatrixWorld(true);
  }

  /** Rotates the viewer in place (positive = left). */
  snapTurn(angle) {
    this._rotateAroundViewer(angle);
    this._emit('turn', { angle });
  }

  /** Walks: forward/right are -1..1 relative to the head direction; `dist` metres. */
  _move(forward, right, dist) {
    const yaw = this._headYaw();
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dx = (fx * forward + -fz * right) * dist;
    const dz = (fz * forward + fx * right) * dist;
    const from = this.viewerPosition(new THREE.Vector3());
    const to = from.clone().add(new THREE.Vector3(dx, 0, dz));
    const ok = this.world.constrain(from, to, PLAYER.radius);
    this.rig.position.x += ok.x - from.x;
    this.rig.position.z += ok.z - from.z;
  }

  // -------------------------------------------------------------------------------------------
  // Desktop & touch

  _makeScreenPointer(kind) {
    const p = {
      id: kind, kind, hand: null, raycaster: new THREE.Raycaster(), object3D: null, hovering: false,
      setHitDistance() {}, setHovering: (h) => {
        p.hovering = h;
        this.dom.style.cursor = h ? 'pointer' : '';
      },
    };
    p.raycaster.far = 40;
    return p;
  }

  _setNdc(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    this._mouse.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  _bindDom() {
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (this.presenting) return;
      el.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'touch') return this._touchDown(e);
      this._setNdc(e.clientX, e.clientY);
      this._mouse.inside = true;
      this._mouse.down = { x: e.clientX, y: e.clientY, button: e.button, drag: false, yaw: this.yaw, pitch: this.pitch };
      if (e.button === 0) this._emit('selectstart', { pointer: this._mouse.pointer });
    });
    el.addEventListener('pointermove', (e) => {
      if (this.presenting) return;
      if (e.pointerType === 'touch') return this._touchMove(e);
      this._setNdc(e.clientX, e.clientY);
      this._mouse.inside = true;
      const d = this._mouse.down;
      if (d) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.drag && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.drag = true;
        if (d.drag && this.lookEnabled !== false) this._look(d.yaw, d.pitch, dx, dy);
      }
    });
    const up = (e) => {
      if (this.presenting) return;
      if (e.pointerType === 'touch') return this._touchUp(e);
      const d = this._mouse.down;
      this._mouse.down = null;
      if (!d) return;
      if (d.button === 0) {
        this._emit('selectend', { pointer: this._mouse.pointer });
        if (!d.drag) this._emit('select', { pointer: this._mouse.pointer });
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this._mouse.down) this._mouse.inside = false;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._emit('wheel', { deltaY: e.deltaY });
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown'].includes(e.key)) e.preventDefault();
      if (!e.repeat) this._emit('key', { code: e.code, key: e.key, pressed: true, shift: e.shiftKey });
      this._keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this._keys.delete(e.code);
      if (!isTyping(e)) this._emit('key', { code: e.code, key: e.key, pressed: false });
    });
    window.addEventListener('blur', () => this._keys.clear());
  }

  _look(baseYaw, basePitch, dx, dy) {
    const k = 0.0042;
    this.yaw = baseYaw + dx * k;
    this.pitch = Math.max(-1.35, Math.min(1.35, basePitch + dy * k));
  }

  _touchDown(e) {
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (this._touches.size === 1) this._touchLook = { yaw: this.yaw, pitch: this.pitch, x: e.clientX, y: e.clientY, moved: false };
    else this._touchLook = null;
    if (this._touches.size === 2) this._pinch = this._pinchDist();
  }

  _touchMove(e) {
    const t = this._touches.get(e.pointerId);
    if (!t) return;
    const px = t.x;
    const py = t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this._touches.size === 1 && this._touchLook) {
      const L = this._touchLook;
      const dx = e.clientX - L.x;
      const dy = e.clientY - L.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) L.moved = true;
      if (L.moved && this.lookEnabled !== false) this._look(L.yaw, L.pitch, dx, dy);
      this._emit('drag', { dx: e.clientX - px, dy: e.clientY - py, total: { x: dx, y: dy } });
    } else if (this._touches.size === 2) {
      // Two fingers: move (vertical = forward/back, horizontal = strafe); pinch = wheel.
      if (this.locomotionEnabled) this._move(-(e.clientY - py) * 0.004, (e.clientX - px) * 0.004, 1);
      const d = this._pinchDist();
      if (this._pinch && Math.abs(d - this._pinch) > 4) {
        this._emit('wheel', { deltaY: (this._pinch - d) * 2 });
        this._pinch = d;
      }
    }
  }

  _touchUp(e) {
    const t = this._touches.get(e.pointerId);
    this._touches.delete(e.pointerId);
    if (!t) return;
    const L = this._touchLook;
    if (this._touches.size === 0 && L && !L.moved && performance.now() - t.t < 600) {
      this._setNdc(t.x, t.y);
      this._updateScreenRay(this._mouse.pointer);
      this._emit('select', { pointer: this._mouse.pointer });
    } else if (this._touches.size === 0 && L && L.moved) {
      const dx = t.x - t.sx;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(t.y - t.sy) * 1.5) this._emit('swipe', { dir: dx < 0 ? 'left' : 'right' });
    }
    if (this._touches.size === 0) this._touchLook = null;
  }

  _pinchDist() {
    const [a, b] = [...this._touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  _updateScreenRay(p) {
    p.raycaster.setFromCamera(this._mouse.ndc, this.camera);
  }

  _desktopUpdate(dt) {
    this.rig.rotation.y = this.yaw;
    this.camera.rotation.set(this.pitch, 0, 0);
    this.camera.position.set(0, PLAYER.eyeHeight, 0);
    if (this.locomotionEnabled) {
      const k = this._keys;
      let f = 0;
      let r = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
      if (k.has('KeyD')) r += 1;
      if (k.has('KeyA')) r -= 1;
      let turn = 0;
      if (k.has('ArrowLeft') || k.has('KeyQ')) turn += 1;
      if (k.has('ArrowRight') || k.has('KeyE')) turn -= 1;
      if (turn) this.yaw += turn * 1.8 * dt;
      if (f || r) {
        const n = Math.hypot(f, r);
        const speed = PLAYER.walkSpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 1.9 : 1);
        this.rig.updateMatrixWorld(true);
        this._move(f / n, r / n, speed * dt);
      }
      this.rig.rotation.y = this.yaw;
    }
    this.rig.updateMatrixWorld(true);
    this._updateScreenRay(this._mouse.pointer);
  }

  /** Per frame: poll input, apply locomotion, refresh pointer rays and the active pointer list. */
  update(dt) {
    this.pointers.length = 0;
    if (this.presenting) {
      this._pollXR(dt);
      for (const e of this._xr) if (e.pointer) this.pointers.push(e.pointer);
    } else {
      this._desktopUpdate(dt);
      if (this._mouse.inside) this.pointers.push(this._mouse.pointer);
    }
  }

  /** Called when an XR session ends: restore the desktop camera pose facing the same way. */
  onSessionEnd() {
    this.yaw = this.rig.rotation.y;
    this.pitch = 0;
    for (const e of this._xr) if (e.aiming) this._endAim(e, false);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
