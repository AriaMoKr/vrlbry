// A single free-standing book (SPEC §5.3): closed with cover/spine/page edges, opens into a
// spread facing +Z, shows two page canvases and animates page turns with a bending leaf.
//
// Local frame (closed): page width d along X with the spine at −X, height along Y, thickness w
// along Z with the front cover facing +Z, origin at the book's centre. While opening, the content
// slides +d/2 in X so that the open spread is centred on the origin with the spine at x = 0.

import * as THREE from 'three';
import { canvasTexture } from './canvas-texture.js';
import { makeCoverCanvas, makePageEdgeCanvas, bookColors } from './textures.js';
import { READ } from '../config.js';

const OPEN_TIME = 0.65;
const TURN_TIME = 0.55;
const V_TILT = 0.11; // radians each half of the spread rises toward the reader
const LEAF_SEGMENTS = 24;
const EPS = 0.0008;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let edgeTexture = null;
function getEdgeTexture() {
  if (!edgeTexture) edgeTexture = canvasTexture(makePageEdgeCanvas({ w: 64, h: 256 }));
  return edgeTexture;
}

const coverCache = new Map(); // url -> Promise<THREE.Texture|null>
function loadCoverTexture(url) {
  if (!coverCache.has(url)) {
    coverCache.set(url, new Promise((resolve) => {
      new THREE.TextureLoader().load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      }, undefined, () => resolve(null));
    }));
  }
  return coverCache.get(url);
}

export class Book3D {
  /**
   * @param {object} o
   * @param {object} o.book book descriptor
   * @param {{ w: number, h: number, d: number }} o.dims thickness / height / depth in metres
   * @param {HTMLCanvasElement} o.spineCanvas
   * @param {THREE.WebGLRenderer} [o.renderer]
   */
  constructor({ book, dims, spineCanvas, renderer }) {
    this.book = book;
    this.dims = dims;
    this.state = 'closed';
    this.group = new THREE.Group();
    this.group.name = 'book3d';
    this._anim = [];
    this._textures = new Map(); // canvas -> CanvasTexture
    this._aniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
    this._left = null;
    this._right = null;

    const D = dims.d;
    const Hh = dims.h;
    const T = dims.w;
    const b = Math.min(0.0035, T * 0.14); // board thickness
    const o = 0.003; // board overhang
    this._b = b;
    const col = bookColors(book);
    this._cloth = new THREE.MeshLambertMaterial({ color: new THREE.Color(col.cloth).multiplyScalar(1.15) });
    this._paper = new THREE.MeshLambertMaterial({ color: 0xf1e8d4 });
    this._edges = new THREE.MeshLambertMaterial({ map: getEdgeTexture() });
    const coverTex = canvasTexture(makeCoverCanvas(book));
    this._coverMat = new THREE.MeshLambertMaterial({ map: coverTex });
    const spineTex = canvasTexture(spineCanvas, { anisotropy: this._aniso });
    this._spineMat = new THREE.MeshLambertMaterial({ map: spineTex });
    this._ownTextures = [coverTex, spineTex];

    // content: everything, slid +x while opening. hinge: the spine line (x = −D/2, z = 0).
    this.content = new THREE.Group();
    this.group.add(this.content);
    const hingeX = -D / 2;
    const pagesT = Math.max(0.002, T - 2 * b);
    const half = pagesT / 2;

    // Back half (static side): back board + back half of the pages, pivoting for the V tilt.
    this.backPivot = new THREE.Group();
    this.backPivot.position.set(hingeX, 0, 0);
    this.content.add(this.backPivot);
    const backBoard = new THREE.Mesh(new THREE.BoxGeometry(D + o, Hh + 2 * o, b), this._cloth);
    backBoard.position.set((D + o) / 2, 0, -half - b / 2);
    this.backPivot.add(backBoard);
    const backPages = new THREE.Mesh(new THREE.BoxGeometry(D - 0.002, Hh, half),
      [this._edges, this._paper, this._edges, this._edges, this._paper, this._paper]);
    backPages.position.set((D - 0.002) / 2, 0, -half / 2);
    this.backPivot.add(backPages);

    // Front half: front board + front half of the pages, swinging about the hinge.
    this.frontPivot = new THREE.Group();
    this.frontPivot.position.set(hingeX, 0, 0);
    this.content.add(this.frontPivot);
    const frontBoard = new THREE.Mesh(new THREE.BoxGeometry(D + o, Hh + 2 * o, b),
      [this._cloth, this._cloth, this._cloth, this._cloth, this._coverMat, this._paper]);
    frontBoard.position.set((D + o) / 2, 0, half + b / 2);
    this.frontPivot.add(frontBoard);
    const frontPages = new THREE.Mesh(new THREE.BoxGeometry(D - 0.002, Hh, half),
      [this._edges, this._paper, this._edges, this._edges, this._paper, this._paper]);
    frontPages.position.set((D - 0.002) / 2, 0, half / 2);
    this.frontPivot.add(frontPages);

    // Spine (closed only): spine artwork on its −X face.
    this.spine = new THREE.Mesh(new THREE.BoxGeometry(b, Hh + 2 * o, T),
      [this._cloth, this._spineMat, this._cloth, this._cloth, this._cloth, this._cloth]);
    this.spine.position.set(hingeX - b / 2, 0, 0);
    this.content.add(this.spine);

    // Page planes (shown when open). The left one sits on the front half's inner face (z = 0,
    // facing −Z while closed → +Z once swung open).
    const pw = D - 0.004;
    const ph = Hh - 0.004;
    this._pageW = pw;
    this._pageH = ph;
    const planeGeo = new THREE.PlaneGeometry(pw, ph);
    this._leftMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 });
    this._rightMat = this._leftMat.clone();
    this.leftPage = new THREE.Mesh(planeGeo, this._leftMat);
    this.leftPage.rotation.y = Math.PI;
    this.leftPage.position.set(pw / 2 + 0.001, 0, -EPS);
    this.leftPage.visible = false;
    this.leftPage.name = 'page-left';
    this.frontPivot.add(this.leftPage);
    this.rightPage = new THREE.Mesh(planeGeo, this._rightMat);
    this.rightPage.position.set(pw / 2 + 0.001, 0, EPS);
    this.rightPage.visible = false;
    this.rightPage.name = 'page-right';
    this.backPivot.add(this.rightPage);

    // Turning leaf: a bendable strip anchored at the hinge, front + back meshes sharing geometry.
    this._leafGeo = new THREE.PlaneGeometry(pw, ph, LEAF_SEGMENTS, 1);
    this._leafGeo.translate(pw / 2, 0, 0);
    this._leafBase = this._leafGeo.attributes.position.array.slice();
    this._leafFrontMat = new THREE.MeshLambertMaterial({ side: THREE.FrontSide, emissive: 0xffffff, emissiveIntensity: 0.45 });
    this._leafBackMat = new THREE.MeshLambertMaterial({ side: THREE.BackSide, emissive: 0xffffff, emissiveIntensity: 0.45 });
    this.leaf = new THREE.Group();
    this.leaf.position.set(hingeX, 0, 0);
    this.leaf.add(new THREE.Mesh(this._leafGeo, this._leafFrontMat), new THREE.Mesh(this._leafGeo, this._leafBackMat));
    this.leaf.visible = false;
    this.content.add(this.leaf);

    /**
     * true: the content slides so the open spread is centred on the group origin (the closed book
     * is centred too). false: the spine stays at local x = −d/2 throughout, so the cover swings
     * open around a fixed spine and the spread is centred on x = −d/2.
     */
    this.centerWhenOpen = true;
    this._openT = 0;
    this._applyOpen(0);
  }

  /** Unscaled size of one page when open (metres). */
  get pageSize() {
    return { w: this._pageW, h: this._pageH };
  }

  /** Scale that makes one open page READ.pageWidth wide. */
  get readingScale() {
    return READ.pageWidth / this.dims.d;
  }

  /** Loads the cover image (book.cover), keeping the generated cover on failure. Never rejects. */
  async loadCover() {
    if (!this.book.cover) return;
    const tex = await loadCoverTexture(this.book.cover);
    if (tex && this._coverMat) {
      this._coverMat.map = tex;
      this._coverMat.needsUpdate = true;
    }
  }

  _applyOpen(t) {
    const D = this.dims.d;
    this._openT = t;
    const e = ease(t);
    this.frontPivot.rotation.y = -(Math.PI - V_TILT) * e;
    this.backPivot.rotation.y = -V_TILT * e;
    this.content.position.x = this.centerWhenOpen ? (D / 2) * e : 0;
    this.spine.visible = t < 0.35;
    const showPages = t > 0.02;
    this.leftPage.visible = showPages && !!this._left;
    this.rightPage.visible = showPages && !!this._right;
  }

  _tween(duration, step) {
    return new Promise((resolve) => {
      this._anim.push({ t: 0, duration, step, resolve });
    });
  }

  /** Animates the front cover open; the spread then faces +Z. */
  async open() {
    if (this.state === 'open' || this.state === 'opening') return;
    this.state = 'opening';
    const from = this._openT;
    await this._tween(OPEN_TIME * (1 - from), (k) => this._applyOpen(from + (1 - from) * k));
    this.state = 'open';
  }

  /** Animates the book closed. */
  async close() {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    this.leaf.visible = false;
    const from = this._openT;
    await this._tween(OPEN_TIME * from, (k) => this._applyOpen(from * (1 - k)));
    this.state = 'closed';
  }

  _texture(canvas) {
    if (!canvas) return null;
    let t = this._textures.get(canvas);
    if (!t) {
      t = canvasTexture(canvas, { anisotropy: this._aniso });
      this._textures.set(canvas, t);
    } else {
      t.needsUpdate = true;
    }
    return t;
  }

  _flipped(tex) {
    if (!tex) return null;
    if (!tex.userData.flipped) {
      const f = tex.clone();
      f.repeat.x = -1;
      f.offset.x = 1;
      f.needsUpdate = true;
      tex.userData.flipped = f;
    } else if (tex.version !== tex.userData.flipped.version) {
      tex.userData.flipped.needsUpdate = true;
    }
    return tex.userData.flipped;
  }

  _setMap(mat, tex) {
    mat.map = tex;
    mat.emissiveMap = tex;
    mat.needsUpdate = true;
  }

  /**
   * Shows two canvases on the open pages (null = blank page). The canvases must stay unchanged
   * until the next setPages/turn: the book keeps showing (and turning) them.
   */
  setPages(leftCanvas, rightCanvas) {
    this._left = leftCanvas;
    this._right = rightCanvas;
    if (leftCanvas) this._setMap(this._leftMat, this._texture(leftCanvas));
    if (rightCanvas) this._setMap(this._rightMat, this._texture(rightCanvas));
    this.leftPage.visible = this._openT > 0.02 && !!leftCanvas;
    this.rightPage.visible = this._openT > 0.02 && !!rightCanvas;
  }

  /**
   * Turns a leaf: direction 1 = forward (right page flips to the left), −1 = backward.
   * `left`/`right` are the canvases of the spread shown afterwards.
   */
  async turn(direction, { left, right }) {
    if (this.state !== 'open') {
      this.setPages(left, right);
      return;
    }
    // Finish any running turn instantly so rapid flicks never stack leaves.
    if (this._turning) {
      for (const a of this._anim) a.t = a.duration;
      this.update(0);
    }
    this._turning = true;
    const oldLeft = this._left;
    const oldRight = this._right;
    const newLeftTex = this._texture(left);
    const newRightTex = this._texture(right);
    if (direction > 0) {
      // Leaf front = old right page, back = new left page; new right page is revealed beneath.
      this._setMap(this._leafFrontMat, this._texture(oldRight));
      this._setMap(this._leafBackMat, this._flipped(newLeftTex));
      if (right) this._setMap(this._rightMat, newRightTex);
      this.rightPage.visible = !!right;
    } else {
      this._setMap(this._leafBackMat, this._flipped(this._texture(oldLeft)));
      this._setMap(this._leafFrontMat, newRightTex);
      if (left) this._setMap(this._leftMat, newLeftTex);
      this.leftPage.visible = !!left;
    }
    this._leafFrontMat.visible = direction > 0 ? !!oldRight : !!right;
    this._leafBackMat.visible = direction > 0 ? !!left : !!oldLeft;
    this.leaf.visible = true;
    this._bendLeaf(direction > 0 ? 0 : 1, direction);
    await this._tween(TURN_TIME, (k) => this._bendLeaf(direction > 0 ? k : 1 - k, direction));
    this.leaf.visible = false;
    this.setPages(left, right);
    this._turning = false;
  }

  /** Bends the leaf for turn progress p (0 = lying on the right, 1 = lying on the left). */
  _bendLeaf(p, direction) {
    const pos = this._leafGeo.attributes.position;
    const a = pos.array;
    const base = this._leafBase;
    const pw = this._pageW;
    const phi = -(Math.PI - 2 * V_TILT) * p - V_TILT;
    const curl = 0.9 * Math.sin(Math.PI * p) * (direction > 0 ? -1 : 1);
    const lift = 0.002 + 0.01 * Math.sin(Math.PI * p);
    // Columns of the subdivided plane: integrate direction along u for a smooth bend.
    const cols = LEAF_SEGMENTS + 1;
    const xs = new Float32Array(cols);
    const zs = new Float32Array(cols);
    const du = pw / LEAF_SEGMENTS;
    let x = 0;
    let z = 0;
    for (let i = 0; i < cols; i++) {
      xs[i] = x;
      zs[i] = z;
      const u = (i + 0.5) / LEAF_SEGMENTS;
      const theta = phi + curl * Math.pow(u, 1.4) * 0.6;
      x += Math.cos(theta) * du;
      z += -Math.sin(theta) * du;
    }
    for (let v = 0; v < pos.count; v++) {
      const col = Math.round((base[v * 3] / pw) * LEAF_SEGMENTS);
      const c = Math.max(0, Math.min(LEAF_SEGMENTS, col));
      a[v * 3] = xs[c];
      a[v * 3 + 1] = base[v * 3 + 1];
      a[v * 3 + 2] = zs[c] + lift + EPS * 2;
    }
    pos.needsUpdate = true;
    this._leafGeo.computeVertexNormals();
    this._leafGeo.computeBoundingSphere();
  }

  /** Which page a ray hits, with uv (0..1, v up). */
  hitTestPages(raycaster) {
    if (this._openT < 0.9) return null;
    const targets = [this.leftPage, this.rightPage].filter((m) => m.visible);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return { side: hit.object === this.leftPage ? 'left' : 'right', uv: hit.uv, point: hit.point, distance: hit.distance };
  }

  /** Advances animations. Call every frame. */
  update(dt) {
    if (!this._anim.length) return;
    const done = [];
    for (const a of this._anim) {
      a.t = Math.min(a.duration, a.t + dt);
      a.step(a.duration > 0 ? a.t / a.duration : 1);
      if (a.t >= a.duration) done.push(a);
    }
    if (done.length) {
      this._anim = this._anim.filter((a) => !done.includes(a));
      for (const a of done) a.resolve();
    }
  }

  dispose() {
    this._anim = [];
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const t of this._textures.values()) {
      t.userData.flipped?.dispose();
      t.dispose();
    }
    this._textures.clear();
    // Generated cover and spine textures belong to this book; loaded cover images are cached
    // and shared between books, and the page-edge texture is shared by all books.
    for (const t of this._ownTextures) t.dispose();
    for (const m of [this._cloth, this._paper, this._edges, this._coverMat, this._spineMat, this._leftMat,
      this._rightMat, this._leafFrontMat, this._leafBackMat]) m.dispose();
    this.group.removeFromParent();
  }
}
