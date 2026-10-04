// Application state machine (SPEC §5.6): browse → inspect → read, the kiosk, tooltips, and the
// mapping of every input (XR, mouse, keyboard, touch) onto those states.

import * as THREE from 'three';
import { Book3D } from './world/book3d.js';
import { MAX_BOOKCASES } from './world/world.js';
import { BookReader, THEMES } from './reader/reader.js';
import { Panel, Label, UI } from './ui/panel.js';
import { audio } from './audio.js';
import { perf } from './perf.js';
import { load, save } from './util/storage.js';
import { letterOf, SORT_MODES } from './util/books.js';
import { PAGE_PX, READ } from './config.js';
import {
  ALL_PLACE, collectionsFor, currentPlace, facetsOf, isFaceted, normRoom, placeBookCount, placeFor, roomLabel, sameRoom, ROOM_CAP,
} from './rooms.js';

const UP = new THREE.Vector3(0, 1, 0);
const THEME_ORDER = ['paper', 'sepia', 'night'];
const FONT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const DEFAULT_SETTINGS = {
  sort: 'title', fontScale: 1, theme: 'paper', smoothMove: true, sound: true, readScale: 1, readDistance: READ.distance,
};

export class Interaction {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {THREE.Group} o.rig
   * @param {import('./world/world.js').World} o.world
   * @param {import('./xr/controls.js').Controls} o.controls
   * @param {import('./ui/overlay.js').Overlay} [o.overlay]
   * @param {object[]} o.libraries
   * @param {Record<string, object[]>} o.booksByLib
   * @param {object} o.settings persisted settings (mutated + saved here)
   */
  constructor({ renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings }) {
    Object.assign(this, { renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings });
    this.state = 'browse';
    this.book = null; // book descriptor in inspect/read
    this.book3d = null;
    this.reader = null;
    this.holder = new THREE.Group(); // book + its panels while inspecting/reading
    this.holder.name = 'holder';
    scene.add(this.holder);
    this._tweens = [];
    this._hover = new Map(); // pointer id -> { panel }
    this._hoveredBook = null;
    this._highlightUntil = 0;
    this._time = 0;
    this._grab = null;
    /** Set by main.js: asks the server to rescan its ZIM folder and re-shelves. */
    this.onRescan = null;
    /** Set by main.js: ends the immersive session. */
    this.onExitVR = null;
    /** Set by main.js: reloads the page (a headset's browser controls are out of reach in VR). */
    this.onReload = null;
    this._version = ''; // "Updated …": when the website last changed (setVersion)
    this._exitHold = null; // { name, t } while B/Y is held to leave VR

    this.tooltip = new Label({ width: 0.56, height: 0.13 });
    this.tooltip.visible = false;
    scene.add(this.tooltip.mesh);

    this._buildKiosk();
    this._buildInspectPanel();
    this._buildToolbar();
    this._buildToc();
    this._buildExitRing();
    this._buildFade();
    // Compile the shaders of overlays that appear later (fade, exit ring) now, behind the loading
    // screen: a first-use compile costs ~100 ms, which would freeze the start of the first fade.
    this._fade.visible = true;
    this._exitRing.mesh.visible = true;
    renderer.compile(scene, camera);
    this._fade.visible = false;
    this._exitRing.mesh.visible = false;

    this._canvases = Array.from({ length: 6 }, () => {
      const c = document.createElement('canvas');
      c.width = PAGE_PX.w;
      c.height = PAGE_PX.h;
      return c;
    });
    this._bind();
  }

  // ===========================================================================================
  // Panels

  _buildKiosk() {
    const p = new Panel({ width: 1.0, height: 1.0, pxPerMeter: 1000 });
    this.kiosk = p;
    this._kioskTab = 'shelves';
    p.mesh.name = 'kiosk';
    this.scene.add(p.mesh);
    this.placeKiosk();
    this._fillKiosk();
  }

  /** Re-places the kiosk after a world rebuild. */
  placeKiosk() {
    const k = this.world.kiosk;
    this.kiosk.mesh.position.copy(k.position).setY(1.47);
    this.kiosk.mesh.rotation.set(0, k.yaw, 0, 'YXZ');
    this.kiosk.mesh.rotateX(-0.12);
  }

  /** The library currently shown in the hall. */
  _place() {
    return currentPlace(this.libraries, this.booksByLib, this.settings);
  }

  _fillKiosk() {
    const p = this.kiosk;
    const W = p.w;
    const pad = 36;
    p.clear();
    p.add({ type: 'text', x: pad, y: 26, w: W - 2 * pad, h: 54, text: 'Catalogue', size: 46, weight: '600', serif: true, color: UI.accent });
    p.add({ id: 'rescan', type: 'button', x: W - pad - 230, y: 24, w: 230, h: 56, label: '⟳ Rescan folder', size: 24, onClick: () => this.onRescan?.() });
    let right = W - pad - 230;
    if (this.controls.presenting) {
      right -= 12 + 170;
      p.add({ id: 'exit-vr', type: 'button', x: right, y: 24, w: 170, h: 56, label: 'Exit VR', size: 24, onClick: () => this.onExitVR?.() });
    }
    p.add({ id: 'reload', type: 'button', x: right - 12 - 190, y: 24, w: 190, h: 56, label: '↻ Reload page', size: 24, onClick: () => this.onReload?.() });
    const place = this._place();
    // Rooms exist when there is more than one library, or a library too big to shelve whole.
    const hasRooms = this.libraries.length > 1 || (place && isFaceted(place, this.booksByLib[place.id]));
    if (!hasRooms) this._kioskTab = 'shelves';
    let y = 96;
    if (hasRooms) {
      const tabs = [['shelves', 'Shelves & settings'], ['rooms', 'Rooms']];
      const tw = (W - 2 * pad - 12) / 2;
      tabs.forEach(([id, label], i) => {
        p.add({
          id: `tab-${id}`, type: 'button', x: pad + i * (tw + 12), y, w: tw, h: 54, label, size: 25,
          active: this._kioskTab === id, onClick: () => { this._kioskTab = id; this._fillKiosk(); },
        });
      });
      y += 74;
    }
    if (this._kioskTab === 'rooms') this._fillRoomsTab(p, y, pad, place);
    else this._fillShelvesTab(p, y, pad, place);
    if (this._version) {
      p.add({ id: 'version', type: 'text', x: pad, y: p.h - 40, w: W - 2 * pad, h: 28, text: this._version, size: 21, color: UI.muted, align: 'right', maxLines: 1 });
    }
  }

  /** Shows when the website last changed, at the foot of the kiosk. */
  setVersion(text) {
    this._version = text;
    this._fillKiosk();
  }

  _fillShelvesTab(p, y0, pad, place) {
    const W = p.w;
    const shelved = this.world.shelves.books();
    const room = place && this.settings.rooms?.[place.id];
    const libLine = !place ? 'No libraries'
      : room && isFaceted(place, this.booksByLib[place.id])
        ? `${place.title} · ${roomLabel(room)} · ${shelved.length.toLocaleString()} on the shelves`
        : `${place.title} · ${shelved.length.toLocaleString()} books`;
    p.add({ type: 'text', x: pad, y: y0, w: W - 2 * pad, h: 36, text: libLine, size: 26, color: UI.muted, maxLines: 1 });

    // Sort toggle.
    let y = y0 + 52;
    p.add({ type: 'text', x: pad, y: y + 10, w: 200, h: 34, text: 'Shelve by', size: 26, color: UI.muted });
    const labels = { title: 'Title', author: 'Author', popularity: 'Popularity' };
    SORT_MODES.forEach((m, i) => {
      p.add({
        id: `sort-${m}`, type: 'button', x: pad + 160 + i * 205, y, w: 190, h: 56, label: labels[m], size: 26,
        active: this.settings.sort === m, onClick: () => this.setSort(m),
      });
    });

    // A–Z (or rank) jump grid over the books currently shelved.
    const sort = this.settings.sort;
    const keys = sort === 'popularity'
      ? ['#1', '#10', '#25', '#50', '#75', '#100', '#150', '#200', '#250', '#300', '#400', '#500', '#750', '#1000']
      : ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const present = new Set();
    let maxRank = 0;
    for (const b of shelved) {
      if (sort === 'popularity') maxRank = Math.max(maxRank, b.rank || 0);
      else present.add(letterOf(b, sort));
    }
    y += 78;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 34, text: sort === 'popularity' ? 'Go to rank' : `Go to ${sort === 'author' ? 'author' : 'title'} starting with`, size: 26, color: UI.muted });
    y += 42;
    const cols = 9;
    const bw = (W - 2 * pad - (cols - 1) * 10) / cols;
    keys.forEach((key, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const rank = sort === 'popularity' ? parseInt(key.slice(1), 10) : 0;
      const enabled = sort === 'popularity' ? rank <= maxRank : present.has(key);
      p.add({
        id: `jump-${key}`, type: 'button', x: pad + c * (bw + 10), y: y + r * 66, w: bw, h: 56, label: key, size: 28,
        disabled: !enabled, onClick: () => this.jumpTo(key),
      });
    });

    // Actions + recent.
    y += 3 * 66 + 18;
    p.add({ type: 'button', x: pad, y, w: 300, h: 60, label: '✦ Surprise me', size: 28, onClick: () => this.surprise() });
    p.add({
      id: 'sound', type: 'button', x: pad + 320, y, w: 220, h: 60, label: this.settings.sound ? 'Sound on' : 'Sound off', size: 26,
      active: this.settings.sound, onClick: () => this.toggleSound(),
    });
    p.add({
      id: 'smooth', type: 'button', x: pad + 560, y, w: W - 2 * pad - 560, h: 60, label: this.settings.smoothMove ? 'Stick walking' : 'Teleport only', size: 26,
      active: this.settings.smoothMove, onClick: () => this.toggleSmooth(),
    });
    const recent = this._recentBooks().slice(0, 3);
    y += 80;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 34, text: recent.length ? 'Recently read' : 'Pick any book from the shelves to start reading.', size: 26, color: UI.muted });
    if (recent.length) {
      p.add({
        id: 'recent', type: 'list', x: pad, y: y + 38, w: W - 2 * pad, h: Math.min(3 * 62, p.h - y - 60), rowH: 62, size: 26,
        items: recent.map(({ book, pos }) => ({
          label: book.title, sub: book.author, right: pos?.label || '', onClick: () => this.openRecent(book),
        })),
      });
    }
  }

  _fillRoomsTab(p, y0, pad, place) {
    const W = p.w;
    let y = y0;
    // One room per library…
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 32, text: 'Libraries', size: 24, color: UI.muted });
    y += 38;
    // With several libraries, one more place shelves them all together.
    const places = this.libraries.length > 1 ? [...this.libraries, ALL_PLACE] : this.libraries;
    const libCols = Math.min(2, Math.max(1, places.length));
    const lw = (W - 2 * pad - (libCols - 1) * 10) / libCols;
    places.forEach((lib, i) => {
      const n = placeBookCount(lib, this.libraries, this.booksByLib);
      const busy = lib.indexing && lib.indexing.stage !== 'failed';
      const count = busy ? `indexing ${Math.round((lib.indexing.progress || 0) * 100)}%`
        : `${n.toLocaleString()} ${lib.kind === 'wikisource' ? 'works' : 'books'}`;
      p.add({
        id: lib === ALL_PLACE ? 'place-all' : `place-${i}`, type: 'button', x: pad + (i % libCols) * (lw + 10), y: y + Math.floor(i / libCols) * 62,
        w: lw, h: 54, label: `${lib.title} · ${count}`, size: 23, active: place?.id === lib.id, disabled: !n,
        onClick: () => this.setPlace(lib.id),
      });
    });
    y += Math.ceil(places.length / libCols) * 62 + 12;
    if (!place) return;
    const books = this.booksByLib[place.id] || [];
    if (!isFaceted(place, books)) {
      const capped = this.world.sections.some((s) => s.shown < s.books);
      const text = capped
        ? `${place.title} share ${MAX_BOOKCASES} bookcases here: the small libraries whole, the first books of the large ones.`
        : `${place.title} ${place === ALL_PLACE ? 'are' : 'is'} shelved whole in this room.`;
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 90, text, size: 26, color: UI.muted, maxLines: 2 });
      return;
    }
    // …and a large library is browsed through two filters, a genre and a title letter, each
    // switched on, swapped or (tapped again) off independently.
    const room = normRoom(this.settings.rooms?.[place.id]) || { genre: null, letter: null };
    const { genres, letters } = facetsOf(books, room);
    const total = genres.reduce((n, g) => n + (!room.genre || g.name === room.genre ? g.count : 0), 0);
    const filtered = !!(room.genre || room.letter);
    p.add({
      type: 'text', x: pad, y: y + 6, w: W - 2 * pad - (filtered ? 230 : 0), h: 34, size: 24, color: UI.text, maxLines: 1,
      text: `Now: ${roomLabel(room)} · ${total.toLocaleString()} works${total > ROOM_CAP ? ` (first ${ROOM_CAP.toLocaleString()})` : ''}`,
    });
    if (filtered) {
      p.add({
        id: 'room-clear', type: 'button', x: W - pad - 220, y, w: 220, h: 46, label: '✕ Clear filters', size: 21,
        onClick: () => this.setRoom(place.id, { genre: null, letter: null }),
      });
    }
    y += 54;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 30, text: 'Genre · tap again to remove', size: 21, color: UI.muted, maxLines: 1 });
    y += 34;
    const cols = 3;
    const gw = (W - 2 * pad - (cols - 1) * 10) / cols;
    const rowsLeft = Math.max(2, Math.floor((p.h - y - 150) / 54));
    const shown = genres.slice(0, cols * rowsLeft);
    shown.forEach((g, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const active = room.genre === g.name;
      p.add({
        id: `room-g-${i}`, type: 'button', x: pad + c * (gw + 10), y: y + r * 54, w: gw, h: 48,
        label: `${g.name} · ${g.count > 999 ? (g.count / 1000).toFixed(1) + 'k' : g.count}`, size: 21,
        active, disabled: !active && !g.count,
        onClick: () => this.toggleFilter(place.id, 'genre', g.name),
      });
    });
    y += Math.ceil(shown.length / cols) * 54 + 8;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 30, text: `Title starts with · up to ${ROOM_CAP.toLocaleString()} works are shelved`, size: 21, color: UI.muted, maxLines: 1 });
    y += 34;
    const keys = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const counts = new Map(letters.map((l) => [l.letter, l.count]));
    const lc = 14;
    const kw = (W - 2 * pad - (lc - 1) * 6) / lc;
    keys.forEach((key, i) => {
      const r = Math.floor(i / lc);
      const c = i % lc;
      const active = room.letter === key;
      p.add({
        id: `room-l-${key}`, type: 'button', x: pad + c * (kw + 6), y: y + r * 52, w: kw, h: 46, label: key, size: 22,
        active, disabled: !active && !counts.get(key),
        onClick: () => this.toggleFilter(place.id, 'letter', key),
      });
    });
  }

  /** Library info changed without a rebuild (e.g. indexing progress): refresh the kiosk text. */
  updateLibraries(libraries) {
    this.libraries = libraries;
    if (this._kioskTab === 'rooms') this._fillKiosk();
  }

  /**
   * Shows another library (and, for a large one, a given room). The viewer stays where they are
   * (relative to the kiosk, see _rebuildWorld).
   * @param {string} libId
   * @param {{genre: string|null, letter: string|null}|null} [room]
   */
  async setPlace(libId, room = null) {
    if (this.state !== 'browse') return;
    this.settings.rooms ||= {};
    const same = this.settings.place === libId && (!room || sameRoom(this.settings.rooms[libId], room));
    if (same) return;
    this.settings.place = libId;
    if (room) this.settings.rooms[libId] = room;
    save('settings', this.settings);
    const lib = libId === ALL_PLACE.id ? ALL_PLACE : this.libraries.find((l) => l.id === libId);
    const label = room ? `${lib?.title ?? ''}: ${roomLabel(room)}` : lib?.title ?? '';
    this.overlay?.showToast(`Opening ${label}…`, 'info', 2500);
    await new Promise((r) => setTimeout(r, 30)); // let the toast show before the rebuild
    await this._rebuildWorld();
  }

  /** Shelves another room of a large library. */
  setRoom(libId, room) {
    return this.setPlace(libId, room);
  }

  /**
   * Switches one filter ('genre' or 'letter') of a large library's room to `value`, or off when
   * it already has that value; the other filter is kept.
   */
  toggleFilter(libId, key, value) {
    const room = normRoom(this.settings.rooms?.[libId]) || { genre: null, letter: null };
    room[key] = room[key] === value ? null : value;
    return this.setRoom(libId, room);
  }

  /** Makes sure a book is on the shelves, switching library / room if needed. */
  async ensureShelved(book) {
    if (this.world.shelves.locate(book)) return true;
    const where = placeFor(book, this.libraries, this.booksByLib);
    if (!where) return false;
    await this.setPlace(where.libId, where.room);
    return !!this.world.shelves.locate(book);
  }

  _buildInspectPanel() {
    const p = new Panel({ width: 0.36, height: 0.41, pxPerMeter: 1580 });
    p.visible = false;
    p.mesh.name = 'inspect-panel';
    this.inspectPanel = p;
    this.holder.add(p.mesh);
  }

  _fillInspect(book) {
    const p = this.inspectPanel;
    const W = p.w;
    const pad = 34;
    p.clear();
    let y = 30;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 150, text: book.title, size: 44, weight: '600', serif: true, maxLines: 3 });
    y += 160;
    if (book.subtitle) {
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 64, text: book.subtitle, size: 26, color: UI.muted, maxLines: 2, serif: true });
      y += 70;
    }
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 40, text: book.author || 'Unknown author', size: 32, maxLines: 1 });
    y += 48;
    const lib = this.libraries.find((l) => l.id === book.libId);
    const meta = [lib?.title, book.genre, book.year, book.rank ? `#${book.rank} most read` : null, book.parts ? `${book.parts} parts` : null].filter(Boolean).join(' · ');
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 64, text: meta, size: 24, color: UI.muted, maxLines: 2 });
    const pos = load(`pos:${book.libId}:${book.id}`, null);
    const by = p.h - 230;
    if (!book.readable) {
      p.add({ type: 'text', x: pad, y: by, w: W - 2 * pad, h: 80, text: 'This book has no readable text in the archive.', size: 26, color: '#e2a08f', maxLines: 2 });
    } else if (pos) {
      p.add({ type: 'button', x: pad, y: by, w: W - 2 * pad, h: 70, label: `Continue reading${pos.label ? ' · p. ' + pos.label.split(' /')[0] : ''}`, size: 30, color: '#6b4f27', onClick: () => this.read() });
      p.add({ type: 'button', x: pad, y: by + 80, w: (W - 2 * pad - 12) / 2, h: 60, label: 'Start over', size: 26, onClick: () => this.read({ fromStart: true }) });
    } else {
      p.add({ type: 'button', x: pad, y: by, w: W - 2 * pad, h: 80, label: 'Read', size: 34, color: '#6b4f27', onClick: () => this.read() });
    }
    p.add({ type: 'button', x: pos && book.readable ? pad + (W - 2 * pad + 12) / 2 : pad, y: by + (pos && book.readable ? 80 : 92), w: pos && book.readable ? (W - 2 * pad - 12) / 2 : W - 2 * pad, h: 60, label: 'Put back', size: 26, onClick: () => this.putBack() });
  }

  _buildToolbar() {
    const p = new Panel({ width: 0.66, height: 0.13, pxPerMeter: 1300 });
    p.visible = false;
    p.mesh.name = 'toolbar';
    this.toolbar = p;
    this.holder.add(p.mesh);
    const W = p.w;
    const pad = 18;
    p.add({ id: 'slider', type: 'slider', x: pad + 10, y: 10, w: W - 2 * pad - 230, h: 48, value: 0, onClick: (v) => this.jumpToProgress(v) });
    p.add({ id: 'label', type: 'text', x: W - pad - 210, y: 16, w: 210, h: 40, text: '', size: 26, align: 'right', color: UI.muted });
    const by = 68;
    const bh = 84;
    const defs = [
      ['prev', '◀', 100, () => this.turn(-1)],
      ['next', '▶', 100, () => this.turn(1)],
      ['toc', 'Contents', 160, () => this.toggleToc()],
      ['smaller', 'A−', 86, () => this.changeFont(-1)],
      ['larger', 'A+', 86, () => this.changeFont(1)],
      ['theme', 'Theme', 120, () => this.cycleTheme()],
      ['close', '✕', 86, () => this.closeBook()],
    ];
    const total = defs.reduce((s, d) => s + d[2], 0);
    const gap = (W - 2 * pad - total) / (defs.length - 1);
    let x = pad;
    for (const [id, label, w, fn] of defs) {
      p.add({ id, type: 'button', x, y: by, w, h: bh, label, size: id === 'toc' || id === 'theme' ? 28 : 34, onClick: fn });
      x += w + gap;
    }
  }

  _buildToc() {
    const p = new Panel({ width: 0.42, height: 0.56, pxPerMeter: 1300 });
    p.visible = false;
    p.mesh.name = 'toc';
    this.tocPanel = p;
    this.holder.add(p.mesh);
  }

  _fillToc() {
    const p = this.tocPanel;
    const meta = this.reader?.meta;
    p.clear();
    p.add({ type: 'text', x: 30, y: 24, w: p.w - 140, h: 50, text: 'Contents', size: 40, weight: '600', serif: true, color: UI.accent });
    p.add({ type: 'button', x: p.w - 100, y: 18, w: 70, h: 60, label: '✕', size: 32, onClick: () => this.toggleToc(false) });
    const toc = meta?.toc || [];
    if (!toc.length) {
      p.add({ type: 'text', x: 30, y: 100, w: p.w - 60, h: 100, text: 'This book has no table of contents.', size: 28, color: UI.muted });
      return;
    }
    const minLevel = Math.min(...toc.map((e) => e.level));
    p.add({
      id: 'list', type: 'list', x: 20, y: 96, w: p.w - 40, h: p.h - 120, rowH: 64, size: 26, serif: true,
      items: toc.map((e) => ({ label: e.title, indent: e.level - minLevel, onClick: () => this.jumpToToc(e) })),
    });
  }

  // ===========================================================================================
  // Input wiring

  _bind() {
    const c = this.controls;
    c.addEventListener('select', (e) => {
      audio.init();
      this._select(e.detail.pointer);
    });
    c.addEventListener('squeezestart', (e) => this._grabStart(e.detail.pointer));
    c.addEventListener('squeezeend', (e) => this._grabEnd(e.detail.pointer));
    c.addEventListener('flick', (e) => this._flick(e.detail));
    c.addEventListener('axis', (e) => this._axis(e.detail));
    c.addEventListener('button', (e) => {
      const { name, pressed } = e.detail;
      if (name === 'b' || name === 'y') {
        if (pressed && this.state === 'browse' && this.controls.presenting) {
          // Nothing to go back from: holding the button leaves VR (released early = cancel).
          this._exitHold = { name, t: 0 };
        } else if (pressed) {
          this.back();
        } else if (this._exitHold?.name === name) {
          this._cancelExitHold();
        }
      }
      if (pressed && name === 'a' && this.state === 'inspect') this.read();
    });
    c.addEventListener('key', (e) => {
      if (e.detail.pressed) this._key(e.detail);
    });
    c.addEventListener('wheel', (e) => this._wheel(e.detail.deltaY));
    c.addEventListener('swipe', (e) => {
      if (this.state === 'read') this.turn(e.detail.dir === 'left' ? 1 : -1);
    });
    window.addEventListener('pointerdown', () => audio.init(), { once: true });
  }

  /** Nearest thing under a pointer: panel, open-book page, book in hand, or shelf book. */
  _hitTest(pointer) {
    const rc = pointer.raycaster;
    let best = null;
    const panels = [this.kiosk, this.inspectPanel, this.toolbar, this.tocPanel].filter((p) => p.visible && p.mesh.parent);
    const ph = rc.intersectObjects(panels.map((p) => p.mesh), false)[0];
    if (ph) best = { kind: 'panel', panel: ph.object.userData.panel, uv: ph.uv, distance: ph.distance };
    if (this.book3d && (this.state === 'read' || this.state === 'inspect')) {
      if (this.state === 'read') {
        const pg = this.book3d.hitTestPages(rc);
        if (pg && (!best || pg.distance < best.distance)) best = { kind: 'page', side: pg.side, uv: pg.uv, distance: pg.distance };
      } else {
        const h = rc.intersectObject(this.book3d.group, true)[0];
        if (h && (!best || h.distance < best.distance)) best = { kind: 'held', distance: h.distance };
      }
    }
    // Bookcases stop the laser in every state; their books can be picked only while browsing.
    const sh = this.world.shelves.raycast(rc, { books: this.state === 'browse' });
    if (sh && (!best || sh.distance < best.distance)) {
      best = sh.book ? { kind: 'book', book: sh.book, distance: sh.distance } : { kind: 'solid', distance: sh.distance };
    }
    return best;
  }

  _select(pointer) {
    if (this.state === 'busy' || pointer.teleporting) return;
    const hit = this._hitTest(pointer);
    if (!hit) return;
    if (hit.kind === 'panel') {
      if (hit.panel.click(hit.uv)) audio.click();
    } else if (hit.kind === 'book' && this.state === 'browse') {
      this.pick(hit.book);
    } else if (hit.kind === 'held' && this.state === 'inspect') {
      if (this.book.readable) this.read();
    } else if (hit.kind === 'page' && this.state === 'read') {
      this.turn(hit.side === 'left' ? -1 : 1);
    }
  }

  _flick({ hand, dir }) {
    if (this.state === 'read' && hand === 'right') {
      if (dir === 'right') this.turn(1);
      else if (dir === 'left') this.turn(-1);
    } else if (this.state === 'browse' && this.tocPanel.visible) {
      // (TOC only exists in read mode; nothing here.)
    }
    if (this.tocPanel.visible && hand === 'left' && (dir === 'up' || dir === 'down')) this.tocPanel.scrollList('list', dir === 'down' ? 4 : -4);
  }

  _axis({ hand, y }) {
    if (this.state !== 'read' || this._grab) return;
    const dt = this._lastDt || 1 / 72;
    if (hand === 'right' && Math.abs(y) > 0.3) this._adjustDistance(y * 0.4 * dt);
    if (hand === 'left' && Math.abs(y) > 0.3 && !this.tocPanel.visible) this._adjustScale(-y * 0.8 * dt);
  }

  _wheel(deltaY) {
    if (this.state === 'read') {
      if (this.tocPanel.visible) this.tocPanel.scrollList('list', Math.sign(deltaY) * 2);
      else this._adjustDistance(deltaY * 0.0006);
    } else if (this.state === 'browse') {
      const panelHover = [...this._hover.values()].find((h) => h.panel === this.kiosk);
      if (panelHover) this.kiosk.scrollList('recent', Math.sign(deltaY));
    }
  }

  _key({ key, code }) {
    if (this.state === 'busy') return;
    if (this.state === 'read') {
      if (['ArrowRight', 'PageDown', ' '].includes(key)) this.turn(1);
      else if (['ArrowLeft', 'PageUp'].includes(key)) this.turn(-1);
      else if (key === '+' || key === '=') this.changeFont(1);
      else if (key === '-') this.changeFont(-1);
      else if (key === 'Escape' || key === 'Backspace') {
        if (this.tocPanel.visible) this.toggleToc(false);
        else this.closeBook();
      } else if (code === 'KeyT' || code === 'KeyC') this.toggleToc();
      else if (code === 'KeyN') this.cycleTheme();
    } else if (this.state === 'inspect') {
      if (key === 'Enter' || key === ' ') {
        if (this.book.readable) this.read();
      } else if (key === 'Escape' || key === 'Backspace') this.putBack();
    }
  }

  /** B/Y/Esc: one step back. */
  back() {
    if (this.state === 'read') {
      if (this.tocPanel.visible) this.toggleToc(false);
      else this.closeBook();
    } else if (this.state === 'inspect') this.putBack();
  }

  // ===========================================================================================
  // Viewer frame helpers

  /** Eye position and horizontal forward/right vectors of the viewer. */
  _viewerFrame() {
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const fwd = new THREE.Vector3(dir.x, 0, dir.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    return { eye, fwd, right };
  }

  _faceQuat(from, to) {
    const m = new THREE.Matrix4().lookAt(to, from, UP); // +Z of the result points at `to`
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  _tween(duration, step) {
    return new Promise((resolve) => this._tweens.push({ t: 0, duration, step, resolve }));
  }

  /** Animates an object's world transform to a target (position, quaternion, scale) with an arc. */
  async _fly(obj, toPos, toQuat, toScale, duration = 0.55, arc = 0.12) {
    const fromPos = obj.position.clone();
    const fromQuat = obj.quaternion.clone();
    const fromScale = obj.scale.x;
    await this._tween(duration, (t) => {
      const e = easeInOut(t);
      obj.position.lerpVectors(fromPos, toPos, e);
      obj.position.y += Math.sin(Math.PI * e) * arc;
      obj.quaternion.slerpQuaternions(fromQuat, toQuat, e);
      obj.scale.setScalar(fromScale + (toScale - fromScale) * e);
    });
  }

  // ===========================================================================================
  // Browse → inspect

  /** Takes a book off its shelf and brings it to the viewer. */
  async pick(book) {
    if (this.state !== 'browse') return;
    this.state = 'busy';
    this._setHover(null);
    this.controls.locomotionEnabled = false;
    const tr = this.world.shelves.getBookTransform(book);
    this.world.shelves.hideBook(book);
    this.book = book;
    const b3 = new Book3D({ book, dims: tr.dims, spineCanvas: this.world.shelves.makeSpineCanvas(book), renderer: this.renderer });
    this.book3d = b3;
    b3.loadCover();
    b3.group.position.copy(tr.position);
    b3.group.quaternion.copy(tr.quaternion);
    this.scene.add(b3.group);
    audio.slide();

    // Pull it straight out first, then fly to the viewer.
    const out = new THREE.Vector3(-1, 0, 0).applyQuaternion(tr.quaternion).multiplyScalar(tr.dims.d * 0.9);
    await this._fly(b3.group, tr.position.clone().add(out), tr.quaternion, 1, 0.28, 0);

    const { eye, fwd, right } = this._viewerFrame();
    const target = eye.clone().addScaledVector(fwd, 0.62).addScaledVector(right, -0.12);
    target.y = eye.y - 0.16;
    this.holder.position.copy(target);
    this.holder.quaternion.copy(this._faceQuat(target, eye));
    this.holder.scale.setScalar(1);
    this.holder.updateMatrixWorld(true);
    const quat = this.holder.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12));
    await this._fly(b3.group, target, quat, 1.25, 0.6, 0.1);
    this.holder.attach(b3.group);

    this._fillInspect(book);
    const p = this.inspectPanel;
    p.mesh.position.set(tr.dims.d * 0.62 + 0.21, 0.02, 0.02);
    p.mesh.rotation.set(0, -0.25, 0);
    p.visible = true;
    this.state = 'inspect';
  }

  /** Returns the book to its shelf. */
  async putBack() {
    if (this.state !== 'inspect' && this.state !== 'read') return;
    const book = this.book;
    const b3 = this.book3d;
    this.state = 'busy';
    this.inspectPanel.visible = false;
    this.toolbar.visible = false;
    this.tocPanel.visible = false;
    this.overlay?.setReading(false);
    if (b3.state !== 'closed') {
      audio.close();
      await b3.close();
    }
    this.scene.attach(b3.group);
    const tr = this.world.shelves.getBookTransform(book);
    const out = new THREE.Vector3(-1, 0, 0).applyQuaternion(tr.quaternion).multiplyScalar(tr.dims.d * 0.9);
    await this._fly(b3.group, tr.position.clone().add(out), tr.quaternion, 1, 0.55, 0.12);
    await this._fly(b3.group, tr.position, tr.quaternion, 1, 0.22, 0);
    audio.thud();
    this.world.shelves.showBook(book);
    b3.dispose();
    this.reader?.dispose();
    this.reader = null;
    this.book3d = null;
    this.book = null;
    this.state = 'browse';
    this.controls.locomotionEnabled = true;
    if (this._pendingCatalog) await this._rebuildWorld(); // a rescan arrived while reading
    else this._fillKiosk(); // refresh "recently read"
  }

  // ===========================================================================================
  // Reading

  /** Opens the inspected book for reading. */
  async read({ fromStart = false } = {}) {
    if (this.state !== 'inspect' || !this.book.readable) return;
    this.state = 'busy';
    this.inspectPanel.visible = false;
    const book = this.book;
    const b3 = this.book3d;
    const reader = new BookReader({ libId: book.libId, book, fontScale: this.settings.fontScale, theme: this.settings.theme });
    this.reader = reader;
    this.toolbar.set('label', { text: 'Opening…' });
    let startRef;
    try {
      await reader.load();
      const pos = !fromStart && load(`pos:${book.libId}:${book.id}`, null);
      startRef = pos ? await reader.refForAnchor(pos) : reader.firstRef();
    } catch (err) {
      console.error(err);
      this.overlay?.showToast(`Could not open this book: ${err.message}`, 'error');
      this.state = 'inspect';
      this.inspectPanel.visible = true;
      return;
    }

    // Reading pose: in front of the eyes, a little below, facing them. On a flat screen the book
    // sits higher and further so that it and its toolbar fit the (narrower) field of view.
    const { eye, fwd } = this._viewerFrame();
    const flat = !this.controls.presenting;
    let dist = this.settings.readDistance || READ.distance;
    if (flat) {
      // Far enough that the whole spread fits the screen's width (portrait phones) and height.
      const half = READ.pageWidth * (this.settings.readScale || 1) * 1.06;
      const vt = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const fitW = half / (vt * this.camera.aspect);
      const fitH = (half * 1.45 * 0.5 + 0.36) / vt;
      dist = Math.max(0.64, fitW, fitH);
    }
    const target = eye.clone().addScaledVector(fwd, dist);
    target.y = eye.y - (flat ? 0.04 : READ.drop);
    if (flat) this.controls.pitch = 0;
    this.overlay?.setReading(true);
    const quat = this._faceQuat(target, eye);
    this.scene.attach(b3.group);
    this.holder.position.copy(target);
    this.holder.quaternion.copy(quat);
    this.holder.updateMatrixWorld(true);
    this._readScale = b3.readingScale * (this.settings.readScale || 1);
    // The cover swings open around a fixed spine at the spread centre, so the closed book lands
    // on the right half of where the spread will be.
    b3.centerWhenOpen = false;
    const half = (b3.dims.d / 2) * this._readScale;
    const flyTarget = target.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(quat), half);
    await this._fly(b3.group, flyTarget, quat, this._readScale, 0.5, 0.05);
    this.holder.attach(b3.group);
    b3.group.position.set(half, 0, 0);
    b3.group.quaternion.identity();

    const spread = await this._spreadFor(startRef);
    const shown = await this._renderSpread(spread);
    this._cur = shown;
    b3.setPages(shown.left, shown.right);
    audio.open();
    await b3.open();
    this._placeReadingPanels();
    this.toolbar.visible = true;
    this.state = 'read';
    this._afterTurn();
  }

  _placeReadingPanels() {
    const b3 = this.book3d;
    const s = this._readScale;
    const ph = b3.pageSize.h * s;
    const pw = b3.pageSize.w * s;
    this.toolbar.mesh.position.set(0, -ph / 2 - 0.085, 0.03);
    this.toolbar.mesh.rotation.set(-0.35, 0, 0);
    this.tocPanel.mesh.position.set(-pw - 0.24, 0, 0.08);
    this.tocPanel.mesh.rotation.set(0, 0.45, 0);
  }

  _adjustDistance(delta) {
    const { eye } = this._viewerFrame();
    const to = this.holder.position.clone().sub(eye);
    const d = Math.max(0.3, Math.min(1.6, to.length() + delta));
    this.holder.position.copy(eye).addScaledVector(to.normalize(), d);
    // Only the headset distance is remembered; flat screens re-fit the spread every time.
    if (this.controls.presenting) {
      this.settings.readDistance = d;
      this._saveSettingsSoon();
    }
  }

  _adjustScale(delta) {
    if (!this.book3d) return;
    const base = this.book3d.readingScale;
    const rel = Math.max(READ.minScale, Math.min(READ.maxScale, (this._readScale / base) * (1 + delta)));
    this._readScale = base * rel;
    this.book3d.group.scale.setScalar(this._readScale);
    this.settings.readScale = rel;
    this._placeReadingPanels();
    this._saveSettingsSoon();
  }

  _saveSettingsSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => save('settings', this.settings), 400);
  }

  // Spreads: { left: PageRef | 'ex' (ex-libris endpaper) , right: PageRef | null }.

  async _spreadFor(ref) {
    const r = this.reader;
    const n = r.pageNumber(ref).n;
    if (n % 2 === 1) return { left: (await r.prev(ref)) || 'ex', right: ref };
    return { left: ref, right: await r.next(ref) };
  }

  async _nextSpread(s) {
    const r = this.reader;
    const base = s.right || (s.left !== 'ex' ? s.left : null);
    if (!base) return null;
    const l = await r.next(base);
    if (!l) return null;
    return { left: l, right: await r.next(l) };
  }

  async _prevSpread(s) {
    const r = this.reader;
    if (s.left === 'ex') return null;
    const rr = await r.prev(s.left);
    if (!rr) return { left: 'ex', right: s.left };
    return { left: (await r.prev(rr)) || 'ex', right: rr };
  }

  /** Canvases not used by the shown spread or the prepared neighbours. */
  _freeCanvases(n) {
    const used = new Set();
    for (const s of [this._cur, this._next, this._prev]) {
      if (s) {
        used.add(s.left);
        used.add(s.right);
      }
    }
    const free = this._canvases.filter((c) => !used.has(c));
    return free.slice(0, n);
  }

  async _renderSpread(spread) {
    const [lc, rc] = this._freeCanvases(2);
    const r = this.reader;
    await Promise.all([
      spread.left === 'ex' ? this._drawExLibris(lc) : r.render(spread.left, lc, { side: 'left' }),
      spread.right ? r.render(spread.right, rc, { side: 'right' }) : r.renderBlank(rc, { side: 'right' }),
    ]);
    return { spread, left: lc, right: rc };
  }

  async _drawExLibris(canvas) {
    await this.reader.renderBlank(canvas, { side: 'left' });
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const theme = THEMES[this.reader.theme];
    const book = this.book;
    const lib = this.libraries.find((l) => l.id === book.libId);
    const bx = w * 0.2;
    const by = h * 0.3;
    const bw = w * 0.6;
    const bh = h * 0.34;
    g.strokeStyle = theme.rule;
    g.lineWidth = 3;
    g.strokeRect(bx, by, bw, bh);
    g.lineWidth = 1.2;
    g.strokeRect(bx + 12, by + 12, bw - 24, bh - 24);
    g.fillStyle = theme.light;
    g.textAlign = 'center';
    g.font = `600 28px ${UI.serif}`;
    g.fillText('E X   L I B R I S', w / 2, by + 70);
    g.font = `48px ${UI.serif}`;
    g.fillText('❦', w / 2, by + 140);
    g.fillStyle = theme.ink;
    g.font = `italic 34px ${UI.serif}`;
    const title = book.title.length > 44 ? book.title.slice(0, 43) + '…' : book.title;
    g.fillText(title, w / 2, by + 210, bw - 60);
    g.fillStyle = theme.light;
    g.font = `26px ${UI.serif}`;
    g.fillText(book.author || '', w / 2, by + 256, bw - 60);
    g.font = `22px ${UI.serif}`;
    g.fillText(lib?.title || 'vrlbry', w / 2, by + bh - 34, bw - 60);
  }

  /** Prepares the neighbouring spreads so page turns are instant (reusing ones already drawn). */
  async _prepareNeighbours() {
    const token = (this._prepToken = (this._prepToken || 0) + 1);
    const cur = this._cur;
    if (!cur) return;
    const keep = [this._next, this._prev].filter((s) => s?.spread);
    this._next = null;
    this._prev = null;
    const reuse = (spread) => keep.find((s) => sameSpread(s.spread, spread));
    const ns = await this._nextSpread(cur.spread);
    if (token !== this._prepToken) return;
    const nextReady = ns && reuse(ns);
    if (nextReady) this._next = nextReady;
    const ps = await this._prevSpread(cur.spread);
    if (token !== this._prepToken) return;
    const prevReady = ps && reuse(ps);
    if (prevReady) this._prev = prevReady;
    if (!this._next) {
      const r = ns ? await this._renderSpread(ns) : { spread: null };
      if (token !== this._prepToken) return;
      this._next = r;
    }
    if (!this._prev) {
      const r = ps ? await this._renderSpread(ps) : { spread: null };
      if (token !== this._prepToken) return;
      this._prev = r;
    }
  }

  /** Turns one spread forward (1) or back (−1). */
  async turn(dir) {
    if (this.state !== 'read') return;
    if (this._turnBusy) {
      this._queuedTurn = dir;
      return;
    }
    this._turnBusy = true;
    const t0 = performance.now();
    try {
      // Cancel background preparation: it must not reassign neighbours while we turn.
      this._prepToken = (this._prepToken || 0) + 1;
      let target = dir > 0 ? this._next : this._prev;
      const prepared = !!target; // the neighbour spread was ready (else it is laid out now)
      if (!target) {
        // Neighbour not ready yet (fast flipping): compute it now.
        const s = dir > 0 ? await this._nextSpread(this._cur.spread) : await this._prevSpread(this._cur.spread);
        target = s ? await this._renderSpread(s) : { spread: null };
      }
      if (!target.spread) return;
      audio.pageTurn();
      const old = this._cur;
      this._cur = target;
      this._prev = dir > 0 ? old : null;
      this._next = dir > 0 ? null : old;
      await this.book3d.turn(dir, { left: target.left, right: target.right });
      this._afterTurn();
      perf.event('turn', { t: t0, ms: performance.now() - t0, prepared });
    } finally {
      this._turnBusy = false;
    }
    if (this._queuedTurn) {
      const q = this._queuedTurn;
      this._queuedTurn = 0;
      this.turn(q);
    }
  }

  /** Jumps to a page (TOC, slider, recent) with a turn animation in the right direction. */
  async _jump(ref) {
    if (this.state !== 'read' || this._turnBusy) return;
    this._turnBusy = true;
    try {
      this._prepToken = (this._prepToken || 0) + 1;
      this._next = null;
      this._prev = null;
      const s = await this._spreadFor(ref);
      const shown = await this._renderSpread(s);
      const curRef = this._cur.spread.right || this._cur.spread.left;
      const r = this.reader;
      const dir = curRef === 'ex' || r.progressOf(ref) >= r.progressOf(curRef) ? 1 : -1;
      this._cur = shown;
      audio.pageTurn();
      await this.book3d.turn(dir, { left: shown.left, right: shown.right });
      this._afterTurn();
    } finally {
      this._turnBusy = false;
    }
  }

  async jumpToToc(entry) {
    this.toggleToc(false);
    await this._jump(await this.reader.refForToc(entry));
  }

  async jumpToProgress(v) {
    await this._jump(await this.reader.refForProgress(v));
  }

  _currentRef() {
    const s = this._cur?.spread;
    if (!s) return null;
    return s.left !== 'ex' ? s.left : s.right;
  }

  /** After the shown spread changed: toolbar, saved position, recent list, neighbours. */
  _afterTurn() {
    const r = this.reader;
    const ref = this._currentRef();
    if (!r || !ref) return;
    const label = r.labelOf(this._cur.spread.right || ref);
    this.toolbar.set('label', { text: label });
    this.toolbar.set('slider', { value: r.progressOf(ref) });
    this.toolbar.set('prev', { disabled: this._cur.spread.left === 'ex' });
    const book = this.book;
    save(`pos:${book.libId}:${book.id}`, { ...r.anchorOf(ref), t: Date.now(), label });
    const recent = load('recent', []).filter((e) => !(e.libId === book.libId && e.id === book.id));
    recent.unshift({ libId: book.libId, id: book.id, t: Date.now() });
    save('recent', recent.slice(0, 20));
    this._prepareNeighbours().catch((e) => console.warn('prepare', e));
  }

  async changeFont(step) {
    if (this.state !== 'read' || this._turnBusy) return;
    const cur = this.settings.fontScale;
    let i = FONT_STEPS.findIndex((s) => s >= cur - 1e-6);
    if (i < 0) i = FONT_STEPS.length - 1;
    const next = FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, i + step))];
    if (next === cur) return;
    const anchor = this.reader.anchorOf(this._currentRef());
    this.settings.fontScale = next;
    save('settings', this.settings);
    this.reader.setFontScale(next);
    await this._jumpInPlace(await this.reader.refForAnchor(anchor));
  }

  async cycleTheme() {
    if (this.state !== 'read' || this._turnBusy) return;
    const t = THEME_ORDER[(THEME_ORDER.indexOf(this.settings.theme) + 1) % THEME_ORDER.length];
    this.settings.theme = t;
    save('settings', this.settings);
    this.reader.setTheme(t);
    await this._jumpInPlace(this._currentRef());
  }

  /** Re-renders the current position without a turn animation (font / theme changes). */
  async _jumpInPlace(ref) {
    this._turnBusy = true;
    try {
      this._prepToken = (this._prepToken || 0) + 1;
      this._next = null;
      this._prev = null;
      const shown = await this._renderSpread(await this._spreadFor(ref));
      this._cur = shown;
      this.book3d.setPages(shown.left, shown.right);
      this._afterTurn();
    } finally {
      this._turnBusy = false;
    }
  }

  toggleToc(show = !this.tocPanel.visible) {
    if (show) this._fillToc();
    this.tocPanel.visible = show && this.state === 'read';
    this.toolbar.set('toc', { active: this.tocPanel.visible });
  }

  /** Closes the book and puts it back on the shelf. */
  async closeBook() {
    if (this.state !== 'read') return;
    this._prepToken = (this._prepToken || 0) + 1;
    this._cur = this._next = this._prev = null;
    await this.putBack();
  }

  // ===========================================================================================
  // Kiosk actions

  async setSort(mode) {
    if (mode === this.settings.sort || this.state !== 'browse') return;
    this.settings.sort = mode;
    save('settings', this.settings);
    await this._rebuildWorld();
  }

  /**
   * Replaces the catalogue (after a folder rescan). The shelves are rebuilt right away when
   * browsing, otherwise as soon as the open book is put back.
   * @returns {Promise<boolean>} true if rebuilt now
   */
  async setCatalog(libraries, booksByLib) {
    this.libraries = libraries;
    this.booksByLib = booksByLib;
    if (this.state !== 'browse') {
      this._pendingCatalog = true;
      return false;
    }
    await this._rebuildWorld();
    return true;
  }

  /**
   * Rebuilds the shelves for the current place/room/sort. The viewer keeps their place relative
   * to the kiosk: that is where they usually stand when choosing a room or sort, and the kiosk
   * itself moves when the room changes shape (it stays put for most changes, and so do they).
   * Only when that spot ends up inside a bookcase or outside the walls do they go to the spawn
   * point.
   */
  async _rebuildWorld() {
    this._pendingCatalog = false;
    this.state = 'busy';
    const t = { start: performance.now() };
    try {
      await this._fadeTo(1, 0.15);
      t.dark = performance.now();
      const kiosk = { position: this.world.kiosk.position.clone(), yaw: this.world.kiosk.yaw };
      this._hoveredBook = null;
      this._highlightUntil = 0;
      this.tooltip.visible = false;
      const collections = collectionsFor(this.libraries, this.booksByLib, this.settings);
      const built = this.world.build(collections, { sort: this.settings.sort });
      t.built = performance.now(); // the synchronous part: packing, geometry, signs
      await built; // the low atlases from the worker
      t.ready = performance.now();
      this.placeKiosk();
      const to = this.world.kiosk;
      const viewer = this.controls.viewerPosition(new THREE.Vector3())
        .sub(kiosk.position).applyAxisAngle(UP, to.yaw - kiosk.yaw).add(to.position);
      if (this.world.isWalkable(viewer.x, viewer.z)) this.controls.followFrame(kiosk, to);
      else this.controls.teleportTo(this.world.spawn.position, this.world.spawn.yaw);
      this._fillKiosk();
      await this._tween(0.08, () => {}); // a few frames in the dark: the heavy first render
      await this._fadeTo(0, 0.3);
      perf.event('rebuild', {
        t: t.start, ms: performance.now() - t.start, place: this.settings.place, bookcases: this.world.shelves.cases.length,
        fadeOutMs: t.dark - t.start, buildSyncMs: t.built - t.dark, lowsMs: t.ready - t.built,
      });
    } finally {
      this._fade.material.opacity = 0;
      this._fade.visible = false;
      this.state = 'browse';
    }
  }

  /** Teleports in front of the first book with the given letter (or rank key "#N"). */
  jumpTo(key) {
    if (this.state !== 'browse') return;
    const sort = this.settings.sort;
    const books = this.world.shelves.books();
    let book;
    if (sort === 'popularity') {
      const rank = parseInt(key.slice(1), 10);
      book = books.find((b) => (b.rank || 0) >= rank);
    } else {
      book = books.find((b) => letterOf(b, sort) === key);
    }
    if (book) this.showBook(book);
  }

  /** Teleports to a book's bookcase and highlights it for a few seconds. */
  showBook(book) {
    const loc = this.world.shelves.locate(book);
    if (!loc) return;
    this.controls.teleportTo(loc.position, loc.yaw);
    this._setHover(book, true);
    this._highlightUntil = this._time + 4;
  }

  async surprise() {
    if (this.state !== 'browse') return;
    const books = this.world.shelves.books().filter((b) => b.readable);
    if (!books.length) return;
    const book = books[Math.floor(Math.random() * books.length)];
    this.showBook(book);
    await this._tween(0.6, () => {});
    await this.pick(book);
  }

  /** From the kiosk's recent list (or search): go to the book and open it for reading. */
  async openRecent(book) {
    if (this.state !== 'browse') return;
    if (!(await this.ensureShelved(book))) return;
    this.showBook(book);
    await this._tween(0.4, () => {});
    await this.pick(book);
    if (this.state === 'inspect' && book.readable) await this.read();
  }

  /** Overlay search result: go there, highlight, and take it out on non-XR. */
  async searchPick(book) {
    if (this.state === 'inspect' || this.state === 'read') await this.putBack();
    if (this.state !== 'browse') return;
    if (!(await this.ensureShelved(book))) {
      this.overlay?.showToast('That book is not on the shelves.', 'error');
      return;
    }
    this.showBook(book);
    if (!this.controls.presenting) {
      await this._tween(0.5, () => {});
      await this.pick(book);
    }
  }

  toggleSound() {
    this.settings.sound = !this.settings.sound;
    audio.setEnabled(this.settings.sound);
    save('settings', this.settings);
    this.kiosk.set('sound', { label: this.settings.sound ? 'Sound on' : 'Sound off', active: this.settings.sound });
  }

  toggleSmooth() {
    this.settings.smoothMove = !this.settings.smoothMove;
    this.controls.smoothMove = this.settings.smoothMove;
    save('settings', this.settings);
    this.kiosk.set('smooth', { label: this.settings.smoothMove ? 'Stick walking' : 'Teleport only', active: this.settings.smoothMove });
  }

  _recentBooks() {
    const out = [];
    for (const e of load('recent', [])) {
      const book = (this.booksByLib[e.libId] || []).find((b) => b.id === e.id);
      if (book) out.push({ book, pos: load(`pos:${e.libId}:${e.id}`, null) });
    }
    return out;
  }

  // ===========================================================================================
  // Grab (XR grip) — move the held/open book around

  _grabStart(pointer) {
    if ((this.state !== 'read' && this.state !== 'inspect') || !pointer.object3D) return;
    pointer.object3D.updateMatrixWorld(true);
    const inv = pointer.object3D.matrixWorld.clone().invert();
    this._grab = { pointer, offset: inv.multiply(this.holder.matrixWorld) };
  }

  _grabEnd(pointer) {
    if (this._grab?.pointer === pointer) this._grab = null;
  }

  // ===========================================================================================
  // Hover

  _setHover(book, sticky = false) {
    if (book === this._hoveredBook) return;
    if (!sticky && this._highlightUntil > this._time && this._hoveredBook && !book) return;
    this._hoveredBook = book;
    this.world.shelves.setHighlight(book);
    if (!book) {
      this.tooltip.visible = false;
      return;
    }
    this.tooltip.setText(book.title, book.author || '');
    const tr = this.world.shelves.getBookTransform(book);
    const out = new THREE.Vector3(-1, 0, 0).applyQuaternion(tr.quaternion);
    this.tooltip.mesh.position.copy(tr.position).addScaledVector(out, 0.28);
    this.tooltip.mesh.position.y += tr.dims.h / 2 + 0.1;
    this.tooltip.visible = true;
  }

  // ===========================================================================================
  // Fade to black around rebuilds: the first frame of a new room uploads its geometry and
  // textures at once (tens of ms even on a fast PC); in a headset that stall must happen in the
  // dark, or the world judders.

  _buildFade() {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    mesh.name = 'fade';
    mesh.position.z = -0.12;
    mesh.renderOrder = 1000; // over panels, tooltips and the exit ring
    mesh.visible = false;
    this.camera.add(mesh);
    this._fade = mesh;
  }

  async _fadeTo(target, duration) {
    const m = this._fade;
    const from = m.material.opacity;
    m.visible = true;
    await this._tween(duration, (t) => { m.material.opacity = from + (target - from) * t; });
    m.material.opacity = target;
    m.visible = target > 0;
  }

  // ===========================================================================================
  // Leaving VR: kiosk button, or hold B/Y while browsing (a filling ring shows the hold)

  _buildExitRing() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.14),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    mesh.name = 'exit-ring';
    mesh.renderOrder = 40;
    mesh.position.set(0, -0.06, -0.6); // just below the line of sight, head-locked
    mesh.visible = false;
    this.camera.add(mesh);
    this._exitRing = { mesh, canvas, texture };
  }

  _drawExitRing(progress) {
    const { canvas, texture } = this._exitRing;
    const g = canvas.getContext('2d');
    const c = canvas.width / 2;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(20,16,12,0.82)';
    g.beginPath();
    g.arc(c, c, 120, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 16;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.arc(c, c, 100, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = UI.accent;
    g.beginPath();
    g.arc(c, c, 100, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
    g.stroke();
    g.fillStyle = UI.text;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `600 40px ${UI.font}`;
    g.fillText('Exit VR', c, c - 8);
    g.font = `24px ${UI.font}`;
    g.fillStyle = UI.muted;
    g.fillText('keep holding', c, c + 34);
    texture.needsUpdate = true;
  }

  static get EXIT_HOLD_SECONDS() { return 1.0; }

  _updateExitHold(dt) {
    const hold = this._exitHold;
    if (!hold) return;
    if (this.state !== 'browse' || !this.controls.presenting) return this._cancelExitHold();
    hold.t += dt;
    const p = hold.t / Interaction.EXIT_HOLD_SECONDS;
    // Show the ring only after a moment, so a quick tap does not flash it.
    this._exitRing.mesh.visible = hold.t > 0.15;
    if (this._exitRing.mesh.visible) this._drawExitRing(p);
    if (p >= 1) {
      this._cancelExitHold();
      audio.click();
      this.onExitVR?.();
    }
  }

  _cancelExitHold() {
    this._exitHold = null;
    if (this._exitRing) this._exitRing.mesh.visible = false;
  }

  /** Called by main.js when an immersive session starts or ends. */
  onPresentingChange() {
    this._cancelExitHold();
    this._fillKiosk(); // the Exit VR button only exists in VR
  }

  /** Per frame. */
  update(dt) {
    this._time += dt;
    this._lastDt = dt;
    if (this._tweens.length) {
      const done = [];
      for (const tw of this._tweens) {
        tw.t = Math.min(tw.duration, tw.t + dt);
        tw.step(tw.duration > 0 ? tw.t / tw.duration : 1);
        if (tw.t >= tw.duration) done.push(tw);
      }
      if (done.length) {
        this._tweens = this._tweens.filter((t) => !done.includes(t));
        for (const t of done) t.resolve();
      }
    }
    this.book3d?.update(dt);
    this._updateExitHold(dt);

    if (this._grab) {
      const p = this._grab.pointer.object3D;
      p.updateMatrixWorld(true);
      const m = p.matrixWorld.clone().multiply(this._grab.offset);
      m.decompose(this.holder.position, this.holder.quaternion, new THREE.Vector3());
    }

    // Pointer hover.
    let hoverBook = null;
    const seen = new Set();
    for (const pointer of this.controls.pointers) {
      const hit = this.state === 'busy' || pointer.teleporting ? null : this._hitTest(pointer);
      pointer.setHitDistance(hit ? hit.distance : null);
      const prev = this._hover.get(pointer.id);
      if (prev?.panel && prev.panel !== hit?.panel) prev.panel.pointerLeave();
      let interactive = false;
      if (hit?.kind === 'panel') {
        interactive = hit.panel.pointerMove(hit.uv);
        seen.add(hit.panel);
      } else if (hit?.kind === 'book') {
        hoverBook = hit.book;
        interactive = true;
      } else if (hit?.kind === 'page' || hit?.kind === 'held') {
        interactive = true;
      }
      pointer.setHovering(interactive);
      this._hover.set(pointer.id, { panel: hit?.kind === 'panel' ? hit.panel : null });
    }
    if (this.state === 'browse') {
      // A book highlighted by a jump/search stays highlighted for a few seconds even though the
      // ray (which, after a teleport, usually points at the shelf) hovers other books.
      if (this._highlightUntil <= this._time) this._setHover(hoverBook);
    } else if (this._hoveredBook) {
      this._setHover(null, true);
    }
    if (this.tooltip.visible) this.tooltip.mesh.quaternion.copy(this.camera.getWorldQuaternion(new THREE.Quaternion()));

    for (const p of [this.kiosk, this.inspectPanel, this.toolbar, this.tocPanel]) if (p.visible) p.update();
    if (this.tooltip.visible) this.tooltip.panel.update();
  }
}

function sameRef(a, b) {
  if (a === b) return true;
  if (!a || !b || a === 'ex' || b === 'ex') return false;
  return a.c === b.c && a.p === b.p;
}

function sameSpread(a, b) {
  return !!a && !!b && sameRef(a.left, b.left) && sameRef(a.right, b.right);
}

