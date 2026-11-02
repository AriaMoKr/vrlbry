// Input (SPEC §5.4): XR controllers and hands, mouse + keyboard, touch — unified into pointers
// (world-space raycasters) and events, plus locomotion (teleport arc, snap or smooth turn, smooth
// move; how, by the Hallway's choice: nav.js, setNav). A TV's remote (SPEC §5.9) is the keyboard's
// arrows and Enter: keys are named by common's keyOf, as its OK has no code.
//
// Desktop uses drag-to-look rather than pointer lock (a deliberate deviation from the spec): it
// keeps the DOM overlay usable and works in embedded browsers where pointer lock is refused.

import * as THREE from 'three';
import { firstPad, readPad } from './gamepad.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { PLAYER } from '../config.js';
// The comfort vignette and the seated eye height: every site's (AriaMoKr/common access.js).
import { eyeLift, Vignette } from '../../vendor/common/access.js';
import { keyOf } from '../../vendor/common/tv.js';

const DEADZONE = 0.15;
const FLICK_ON = 0.7;
const FLICK_OFF = 0.3;
const RAY_LENGTH = 5;
const DRAG_THRESHOLD = 6; // px before a press becomes a drag (look) instead of a click
const ARC_SPEED = 7.5;
const GRAVITY = 9.8;
const SMOOTH_TURN = 1.6; // radians per second at full stick, turn 'smooth' (the Hallway's)

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _head = new THREE.Vector3();
/** The xr-standard buttons that raise 'button' events, per hand (fixed: _pollXR runs every frame). */
const BUTTON_NAMES = {
  left: { 4: 'x', 5: 'y', 3: 'stick', 12: 'menu' },
  right: { 4: 'a', 5: 'b', 3: 'stick', 12: 'menu' },
};
const SCREEN_CENTRE = new THREE.Vector2(0, 0);
const PAD_LOOK = { yaw: 2.4, pitch: 1.6 }; // rad/s at full right-stick deflection

function makePointerVisual() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf3d9a0, transparent: true, opacity: 0.75 }));
  line.scale.z = RAY_LENGTH;
  line.name = 'pointer-ray';
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.006, 0.011, 24),
    // forceSinglePass: one pass, not two with a program check each (see common's panel.js); flat.
    new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide, forceSinglePass: true }),
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
    /** How to move and turn in VR (nav.js, setNav): move 'smooth' | 'teleport', turn 'snap' | 'smooth'. */
    this.move = 'smooth';
    this.turn = 'snap';
    /** The comfort vignette (common's Vignette): closes in while the stick walks or turns smoothly in VR. */
    this.vignette = new Vignette(camera, true);
    /** How far the eye is raised in VR (common's eyeLift: seated). */
    this.eyeLift = 0;
    this._speed = 0; // this frame's smooth walking, m/s, and turning, rad/s (the vignette's)
    this._turnRate = 0;
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
    // True while a 3D text field takes the keyboard (the kiosk's search, set by interaction.js):
    // characters, Backspace, Enter and Escape are then text, not walking or turning.
    this.textEntry = false;
    // A TV's remote (main.js, ui/remote.js): the middle of the view is a pointer, as a gamepad's,
    // with its dot (aimShown: not while the page's card has the focus), and ↑ ↓ may be a list's
    // (scrollKey(dir) → true when it took the key: interaction.js scrollUnderDot).
    this.aimMiddle = false;
    this.aimShown = true;
    this.scrollKey = null;
    this._listKey = null; // the arrow a list took with its press, and takes until let go
    /** A gamepad's B: set on a TV (the remote's Back, padBack), else a 'button' b event. */
    this.onPadBack = null;
    this._pad = this._makePad();
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
    this._syncRay(entry);
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
    for (const e of this._xr) if (e.source) this._syncRay(e);
  }

  /**
   * Shows a controller's laser unless rays are off, it is not a tracked pointer, or it is aiming
   * a teleport: then the arc replaces the laser, and `pointer.teleporting` tells interaction.js
   * not to hover or select with it.
   */
  _syncRay(e) {
    const show = this._rayVisible && e.source?.targetRayMode === 'tracked-pointer' && !e.aiming;
    e.visual.line.visible = show;
    if (!show) e.visual.cursor.visible = false;
    if (e.pointer) e.pointer.teleporting = e.aiming;
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
      // Every frame, both controllers: no objects or closures made here (GC pauses on a Quest).
      const names = BUTTON_NAMES[hand === 'left' ? 'left' : 'right'];
      const buttons = gp.buttons;
      for (let bi = 0; bi < buttons.length; bi++) {
        const pressed = buttons[bi].pressed;
        if (pressed !== (e.buttons[bi] || false)) {
          e.buttons[bi] = pressed;
          if (names[bi]) this._emit('button', { hand, name: names[bi], pressed });
        }
      }
      if (this.locomotionEnabled) this._xrLocomotion(e, hand, x, y, dt);
      else if (e.aiming) this._endAim(e, false);
    }
  }

  _flicks(state, hand, x, y) {
    this._flick(state, hand, 'left', -x);
    this._flick(state, hand, 'right', x);
    this._flick(state, hand, 'up', -y);
    this._flick(state, hand, 'down', y);
  }

  _flick(state, hand, dir, v) {
    if (!state[dir] && v > FLICK_ON) {
      state[dir] = true;
      this._emit('flick', { hand, dir });
    } else if (state[dir] && v < FLICK_OFF) {
      state[dir] = false;
    }
  }

  /** The XR controllers, each { controller, source, … }: the shared session's hands (together.js). */
  get xrInputs() {
    return this._xr;
  }

  /** The accessibility settings (common's access.js): the vignette on or off, the seated eye height. */
  setAccess(access) {
    this.vignette.enabled = !!access.vignette;
    this.eyeLift = eyeLift(access);
  }

  /** Sets how to move and turn in VR (nav.js): move 'smooth' | 'teleport', turn 'snap' | 'smooth'. */
  setNav({ move, turn }) {
    this.move = move === 'teleport' ? 'teleport' : 'smooth';
    this.turn = turn === 'smooth' ? 'smooth' : 'snap';
    // A left stick that stops aiming: no arc left behind.
    if (this.move !== 'teleport') {
      for (const e of this._xr) if (e.aiming && (e.pointer?.hand || (e.index === 0 ? 'left' : 'right')) !== 'right') this._endAim(e, false);
    }
  }

  _xrLocomotion(e, hand, x, y, dt) {
    // Teleport: push forward to aim, release to jump. The right stick always; the left one too
    // when moving by teleport (as in the Hallway), one arc at a time.
    if ((hand === 'right' || this.move === 'teleport') && !e.aiming && y < -0.6 && !this._aiming()) {
      e.aiming = true;
      this._syncRay(e);
    }
    if (e.aiming) {
      this._updateAim(e);
      if (y > -0.3) this._endAim(e, true);
    }
    if (hand === 'right') {
      if (e.aiming) {
        // no turning while aiming
      } else if (this.turn === 'smooth') {
        // Held sideways (more than forward, which aims): turning while held.
        if (Math.abs(x) > DEADZONE && Math.abs(x) > Math.abs(y)) {
          this._rotateAroundViewer(-x * SMOOTH_TURN * dt);
          this._turnRate = Math.abs(x) * SMOOTH_TURN;
        }
      } else if (e.flicks.left && !e._turned) {
        e._turned = 'left';
        this.snapTurn(this.snapAngle);
      } else if (e.flicks.right && !e._turned) {
        e._turned = 'right';
        this.snapTurn(-this.snapAngle);
      }
      if (!e.flicks.left && !e.flicks.right) e._turned = null;
    } else if (this.move === 'smooth' && (Math.abs(x) > DEADZONE || Math.abs(y) > DEADZONE)) {
      this._move(-y, x, PLAYER.walkSpeed * dt);
      this._speed = PLAYER.walkSpeed * Math.min(1, Math.hypot(x, y));
    }
  }

  /** Whether a controller is aiming a teleport (the arc is one). */
  _aiming() {
    for (let i = 0; i < this._xr.length; i++) if (this._xr[i].aiming) return true;
    return false;
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
      // One pass (see common's panel.js): of one colour, the arrow's faces blend the same in any order.
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true }));
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
    // Every frame while aiming: vectors, raycaster and hit list reused (GC pauses on a Quest).
    const a = (t.aim ||= {
      origin: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), p: new THREE.Vector3(),
      seg: new THREE.Vector3(), point: new THREE.Vector3(), rc: new THREE.Raycaster(), hits: [],
    });
    const origin = a.origin.copy(e.pointer.raycaster.ray.origin);
    const vel = a.vel.copy(e.pointer.raycaster.ray.direction).multiplyScalar(ARC_SPEED);
    const pos = t.line.geometry.attributes.position;
    const rc = a.rc;
    const prev = a.prev.copy(origin);
    let hit = null;
    let count = 0;
    for (let i = 0; i < t.n; i++) {
      const tt = i * 0.035;
      const p = a.p.copy(origin).addScaledVector(vel, tt);
      p.y -= 0.5 * GRAVITY * tt * tt;
      if (i > 0 && !hit) {
        const seg = a.seg.copy(p).sub(prev);
        const len = seg.length();
        rc.set(prev, seg.normalize());
        rc.far = len;
        a.hits.length = 0;
        const h = rc.intersectObjects(this.world.teleportTargets, false, a.hits)[0];
        if (h) {
          hit = a.point.copy(h.point); // teleportTo copies it when the aim ends
          pos.setXYZ(count++, hit.x, hit.y, hit.z);
          break;
        }
      }
      pos.setXYZ(count++, p.x, p.y, p.z);
      prev.copy(p);
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
    this._syncRay(e);
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

  /**
   * Where the viewer stands and looks, for debug reports: floor position x/z and eye height (m),
   * and the view's yaw and pitch (radians; yaw as in teleportTo, pitch up positive).
   * @returns {{ x: number, z: number, eye: number, yaw: number, pitch: number }}
   */
  viewpoint() {
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
    return {
      x: round(eye.x, 2), z: round(eye.z, 2), eye: round(eye.y - this.rig.position.y, 2),
      yaw: round(Math.atan2(-dir.x, -dir.z), 3), pitch: round(Math.asin(Math.max(-1, Math.min(1, dir.y))), 3),
    };
  }

  /** Puts the viewer at a viewpoint() (its pitch only outside XR, where the head decides). */
  setViewpoint({ x, z, yaw, pitch }) {
    this.teleportTo(new THREE.Vector3(x, 0, z), yaw);
    if (!this.presenting && pitch != null) {
      this.pitch = Math.max(-1.35, Math.min(1.35, pitch));
      this.camera.rotation.set(this.pitch, 0, 0); // now, not at the next frame (_desktopUpdate)
      this.camera.updateMatrixWorld(true);
    }
  }

  /**
   * Moves the viewer rigidly along with a reference frame that went from `from` to `to`
   * ({ position, yaw }; e.g. the kiosk after a rebuild), so they keep their place relative to it.
   * Unlike teleportTo this never counters the head's own motion, so it is safe in XR at any time.
   */
  followFrame(from, to) {
    const turn = to.yaw - from.yaw;
    _v.set(this.rig.position.x - from.position.x, 0, this.rig.position.z - from.position.z)
      .applyAxisAngle(_up, turn);
    this.rig.position.x = to.position.x + _v.x;
    this.rig.position.z = to.position.z + _v.z;
    this.rig.rotation.y += turn;
    if (!this.presenting) this.yaw = this.rig.rotation.y;
    this.rig.updateMatrixWorld(true);
  }

  _rotateAroundViewer(angle) {
    // Every frame while turning smoothly: nothing allocated (GC pauses on a Quest).
    const head = this.viewerPosition(_head);
    this.rig.position.sub(head).applyAxisAngle(_up, angle).add(head);
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

  // -------------------------------------------------------------------------------------------
  // Gamepad (desktop & phone): left stick walks, right stick looks, a centre-of-screen pointer
  // (with a crosshair) aims, and buttons become the events mouse, keyboard and VR controllers send.

  _makePad() {
    const crosshair = document.createElement('div');
    crosshair.className = 'pad-crosshair';
    crosshair.hidden = true;
    (this.dom.parentElement || document.body).appendChild(crosshair);
    const pointer = {
      id: 'gamepad', kind: 'gamepad', hand: null, raycaster: new THREE.Raycaster(), object3D: null, hovering: false,
      setHitDistance() {},
      setHovering: (h) => {
        pointer.hovering = h;
        crosshair.classList.toggle('hover', h);
      },
    };
    pointer.raycaster.far = 40;
    return { pointer, crosshair, active: false, buttons: {}, state: null, wheelWait: 0 };
  }

  /** The pad takes over the pointer when used, and hands it back to the mouse when that moves. */
  _setPadActive(on) {
    const P = this._pad;
    if (P.active === on) return;
    P.active = on;
    P.crosshair.hidden = !on;
    if (!on) P.pointer.setHovering(false);
    this._emit('gamepad', { active: on });
  }

  /** Polls the pad: looking and walking now; button events after the rays are updated. */
  _pollPad(dt) {
    const P = this._pad;
    const gp = firstPad(navigator.getGamepads?.());
    P.state = null;
    if (!gp) {
      P.buttons = {};
      this._setPadActive(false);
      return;
    }
    const s = readPad(gp, P.buttons);
    P.buttons = s.buttons;
    if (s.down.length || s.move.x || s.move.y || s.look.x || s.look.y || s.lt > 0.15 || s.rt > 0.15) this._setPadActive(true);
    if (!P.active) return;
    P.state = s;
    if (this.lookEnabled !== false) {
      this.yaw -= s.look.x * PAD_LOOK.yaw * dt;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - s.look.y * PAD_LOOK.pitch * dt));
    }
    const m = Math.hypot(s.move.x, s.move.y);
    if (this.locomotionEnabled && m > 0) {
      this.rig.rotation.y = this.yaw;
      this.rig.updateMatrixWorld(true);
      this._move(-s.move.y / m, s.move.x / m, PLAYER.walkSpeed * (s.buttons.ls ? 1.9 : 1) * Math.min(1, m) * dt);
    }
  }

  _padEvents(dt) {
    const P = this._pad;
    const s = P.state;
    if (!s) return;
    const key = (k, code, pressed) => this._emit('key', { key: k, code, pressed });
    const each = (names, pressed) => {
      for (const name of names) {
        if (name === 'a') {
          if (pressed) this._emit('select', { pointer: P.pointer });
          this._emit('button', { hand: 'right', name: 'a', pressed });
        } else if (name === 'b' || name === 'back') {
          if (!this.onPadBack) this._emit('button', { hand: 'right', name: 'b', pressed });
          else if (pressed) this.onPadBack();
        }
        else if (name === 'x') key('c', 'KeyC', pressed); // contents
        else if (name === 'y') key('n', 'KeyN', pressed); // page theme
        else if (name === 'lb' || name === 'left') key('ArrowLeft', 'ArrowLeft', pressed);
        else if (name === 'rb' || name === 'right') key('ArrowRight', 'ArrowRight', pressed);
        else if (name === 'up') key('+', 'Equal', pressed); // text size
        else if (name === 'down') key('-', 'Minus', pressed);
        else if (name === 'rs') key('f', 'KeyF', pressed); // the book in front, as a headset's stick press
      }
    };
    each(s.down, true);
    each(s.up, false);
    // Triggers: book distance while reading, list scrolling at the kiosk; a wheel that repeats.
    const t = s.rt - s.lt;
    P.wheelWait -= dt;
    if (Math.abs(t) > 0.15 && P.wheelWait <= 0) {
      this._emit('wheel', { deltaY: 100 * t });
      P.wheelWait = 0.12;
    }
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
      this._setPadActive(false);
      el.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'touch') return this._touchDown(e);
      this._setNdc(e.clientX, e.clientY);
      this._mouse.inside = true;
      this._mouse.down = { x: e.clientX, y: e.clientY, button: e.button, drag: false, yaw: this.yaw, pitch: this.pitch };
      if (e.button === 0) {
        this._updateScreenRay(this._mouse.pointer); // aimed where pressed, not where the last frame was
        this._emit('selectstart', { pointer: this._mouse.pointer });
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.presenting) return;
      if (e.movementX || e.movementY) this._setPadActive(false);
      if (e.pointerType === 'touch') return this._touchMove(e);
      this._setNdc(e.clientX, e.clientY);
      this._mouse.inside = true;
      const d = this._mouse.down;
      if (d) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.drag && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.drag = true;
        // The mouse turns the view the way it is dragged (drag right: look right; up: look up),
        // as in desktop 3D apps; a finger drags the scene instead (_touchMove).
        if (d.drag && this.lookEnabled !== false) this._look(d.yaw, d.pitch, -dx, -dy);
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
      // A key the page has used already (the TV remote's OK: common's Remote, use()).
      if (isTyping(e) || pressesControl(e) || e.defaultPrevented) return;
      const code = keyOf(e);
      const text = this.textEntry && !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key.length === 1 || ['Backspace', 'Enter', 'Escape'].includes(e.key));
      // ↑ ↓ for the list the dot is on (a TV): its press decides, and its repeats follow it.
      if (this.scrollKey && !text && (code === 'ArrowUp' || code === 'ArrowDown')) {
        const dir = code === 'ArrowDown' ? 1 : -1;
        if (!e.repeat) this._listKey = this.scrollKey(dir) ? code : null;
        else if (this._listKey === code) this.scrollKey(dir);
        if (this._listKey === code) {
          e.preventDefault();
          return;
        }
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown'].includes(code) || (text && e.key === 'Backspace')) e.preventDefault();
      // Typed keys repeat while held, like in any text field.
      if (!e.repeat || text) this._emit('key', { code, key: e.key, pressed: true, shift: e.shiftKey, text });
      if (!text) this._keys.add(code);
    });
    window.addEventListener('keyup', (e) => {
      const code = keyOf(e);
      this._keys.delete(code);
      if (this._listKey === code) this._listKey = null;
      if (!isTyping(e)) this._emit('key', { code, key: e.key, pressed: false });
    });
    window.addEventListener('blur', () => this._keys.clear());
  }

  /** Turns the view by a drag of (dx, dy) pixels from where it started, grabbing the scene (touch). */
  _look(baseYaw, basePitch, dx, dy) {
    const k = 0.0042;
    this.yaw = baseYaw + dx * k;
    this.pitch = Math.max(-1.35, Math.min(1.35, basePitch + dy * k));
  }

  _touchDown(e) {
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (this._touches.size === 1) {
      this._touchLook = { yaw: this.yaw, pitch: this.pitch, x: e.clientX, y: e.clientY, moved: false };
      // One finger is a pointer too: pressed (e.g. on a scroll bar to drag it) and released, and
      // the active pointer while it touches.
      this._mouse.inside = true;
      this._setNdc(e.clientX, e.clientY);
      this._updateScreenRay(this._mouse.pointer);
      this._emit('selectstart', { pointer: this._mouse.pointer });
    } else {
      // A second finger: walking or pinching, so the first finger's press ends.
      if (this._touchLook) this._emit('selectend', { pointer: this._mouse.pointer });
      this._touchLook = null;
    }
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
      this._setNdc(e.clientX, e.clientY); // the pointer follows the finger
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
    if (this._touches.size === 0 && L) this._emit('selectend', { pointer: this._mouse.pointer });
    if (this._touches.size === 0) this._mouse.inside = false; // no hover left behind where it lifted
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
    this._pollPad(dt);
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
    if (this._pad.active || this.aimMiddle) this._pad.pointer.raycaster.setFromCamera(SCREEN_CENTRE, this.camera);
    this._padEvents(dt);
  }

  /** Per frame: poll input, apply locomotion, refresh pointer rays and the active pointer list. */
  update(dt) {
    this.pointers.length = 0;
    this._speed = 0;
    this._turnRate = 0;
    // Seated, the eye is raised in VR (and only there: a screen's view has its own height).
    const lift = this.presenting ? this.eyeLift : 0;
    if (this.rig.position.y !== lift) {
      this.rig.position.y = lift;
      this.rig.updateMatrixWorld(true);
    }
    if (this.presenting) {
      this._pollXR(dt);
      for (const e of this._xr) if (e.pointer) this.pointers.push(e.pointer);
      this.vignette.update(dt, this._speed, this._turnRate, true);
    } else {
      this.vignette.update(dt, 0, 0, false);
      this._desktopUpdate(dt);
      const P = this._pad;
      if (P.active || this.aimMiddle) this.pointers.push(P.pointer);
      if (!P.active && this._mouse.inside) this.pointers.push(this._mouse.pointer);
      const dot = P.active || (this.aimMiddle && this.aimShown);
      if (P.crosshair.hidden === dot) P.crosshair.hidden = !dot;
    }
  }

  /**
   * The pointer at the middle of the view (a gamepad's, and a TV remote's OK), its ray from the
   * camera as it is now: for a key pressed between frames.
   */
  get aimPointer() {
    this.camera.updateWorldMatrix(true, false);
    this._pad.pointer.raycaster.setFromCamera(SCREEN_CENTRE, this.camera);
    return this._pad.pointer;
  }

  /** Called when an XR session ends: restore the desktop camera pose facing the same way. */
  /** Whether a gamepad is driving the view (it is not polled in XR). */
  get gamepadActive() {
    return this._pad.active;
  }

  onSessionEnd() {
    this.yaw = this.rig.rotation.y;
    this.pitch = 0;
    for (const e of this._xr) if (e.aiming) this._endAim(e, false);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** Keys typed into a field, or pressed in something that handles its own (data-own-keys: the text view). */
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest?.('[data-own-keys]'));
}

/** Enter or Space on a button or link of the page (a TV's OK in the card): it presses that, not the view's key. */
function pressesControl(e) {
  return (e.key === 'Enter' || e.key === ' ') && !!e.target?.closest?.('button, a[href], summary, [role="button"]');
}
