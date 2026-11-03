// Application state machine (SPEC §5.6): browse → inspect → read, the kiosk, tooltips, and the
// mapping of every input (XR, mouse, keyboard, touch) onto those states.

import * as THREE from 'three';
import { Book3D } from './world/book3d.js';
import { MAX_BOOKCASES } from './world/world.js';
import { BookReader, THEMES } from './reader/reader.js';
import {
  currentRef, currentSide, fitOnePage, isPage, nextSpread, pageViewSetting, prevSpread, sameSpread, singlePage, spreadAt,
} from './reader/spreads.js';
import { bookIndex, matchBooks, findArticles } from './search.js';
import { Panel, Label, UI } from '../vendor/common/panel.js';
import { audio } from './audio.js';
import { perf } from './perf.js';
import { load, save } from './util/storage.js';
import { progressText } from './util/progress.js';
import { isLocal } from './local/local.js';
import { resolveLink } from './api.js';
import { makeRoom } from './world/room-ahead.js';
import { RESET_PARTS, defaultResetParts } from './reset.js';
import { wayOut as defaultWayOut } from './hallway.js';
import { saveNav } from './nav.js';
import { comfortButtons, nextMotion } from './comfort.js';
import { ACCESS_DEFAULTS, normalizeAccess, reduceMotion, saveAccess } from '../vendor/common/access.js';
import { sessionText } from './together-space.js';
import { backStep } from './back-step.js';
import { KINDS as KIWIX_KINDS, indexLabel, sizeText } from './local/kiwix.js';
import { letterOf, SORT_MODES, inTitleOrder, thumbIndex } from './util/books.js';
import { PAGE_PX, READ } from './config.js';
import {
  ALL_PLACE, capNote, collectionsFor, currentPlace, facetsOf, genreLabel, groupPlaces, isFaceted, normRoom, pagesOf, placeBookCount, placeFor, roomLabel, sameRoom, unitOf, ROOM_CAP,
} from './rooms.js';

const UP = new THREE.Vector3(0, 1, 0);
const THEME_ORDER = ['paper', 'sepia', 'night'];
const FONT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];
const TOC_THUMBS_MIN = 30; // contents entries before a list in title order gets a thumb index
const TOC_THUMBS = 9; // its stops
const SEARCH_KEYS = ['1234567890', 'qwertyuiop', "asdfghjkl'", 'zxcvbnm-.,'];
const SEARCH_DELAY = 250; // ms after the last key before searching
const OPENING_LINE = 'Preparing its pages'; // the inspect panel's line while a book opens (read)
const CANCELLED = Symbol('cancelled'); // read(): Put back pressed while the book was opening
const OPENING_BAR_MS = 200; // the opening progress bar's repaints, at most one per this long
const LINK_MARKS = 4; // lines of a link that the hover band covers
const TV_REACH = 2.2; // m: a TV remote's up and down scroll a stand's list the dot is on from this near, else walk

const _plane = new THREE.Plane();
const _from = new THREE.Vector3();
const _toward = new THREE.Vector3();
const _ray = new THREE.Ray();
const _onPlane = new THREE.Vector3();
const _normal = new THREE.Vector3();
// Reused by _hitTest every frame (no new arrays per pointer per frame).
const _meshes = [];
const _hits = [];
const _head = new THREE.Vector3();
const _uv = { x: 0, y: 0 };

/** Where a ray meets a panel's plane, as panel uv (beyond 0..1 off the panel), or null: the same object each time. */
function panelUv(panel, ray) {
  const m = panel.mesh;
  m.updateMatrixWorld();
  _normal.set(0, 0, 1).transformDirection(m.matrixWorld);
  _plane.setFromNormalAndCoplanarPoint(_normal, m.getWorldPosition(_onPlane));
  if (!ray.intersectPlane(_plane, _onPlane)) return null;
  m.worldToLocal(_onPlane);
  _uv.x = _onPlane.x / panel.width + 0.5;
  _uv.y = _onPlane.y / panel.height + 0.5;
  return _uv;
}

/** The reader's toolbar: its width (m), and how far below the page's foot its own foot is (m). */
const TOOLBAR_W = 0.72;
const TOOLBAR_DROP = 0.15;
/** The contents panel's size (m). */
const TOC_W = 0.42;
const TOC_H = 0.56;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const DEFAULT_SETTINGS = {
  sort: 'title', fontScale: 1, theme: 'paper', smoothMove: true, sound: true, readScale: 1, readDistance: READ.distance,
  pageView: 'auto', // one page or two at a time (reader/spreads.js singlePage): 'auto', 'single' or 'spread'
  updateNotices: true, // tell when the site has been updated (main.js; "Don't show again" turns it off)
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
   * @param {ReturnType<defaultWayOut>} [o.wayOut] where the catalogue stand's "← Hallway" leads (hallway.js)
   * @param {{ move: string, turn: string }} [o.nav] how to move and turn in VR (nav.js: common's loadNav)
   * @param {{ motion: string, vignette: boolean, seated: boolean }} [o.access] the accessibility
   *   settings (common's access.js loadAccess)
   */
  constructor({ renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings, wayOut = defaultWayOut(), nav, access }) {
    Object.assign(this, { renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings, wayOut });
    this.nav = { move: settings.smoothMove === false ? 'teleport' : 'smooth', turn: 'snap', ...nav };
    controls.setNav(this.nav);
    settings.smoothMove = this.nav.move === 'smooth'; // saved with the next change
    // The accessibility settings, every site's (common's access.js, `hallway.access`): with less
    // motion the view's eased moves cut (_ease) and its fades blink (_fadeTo); the vignette and
    // the seated eye height are the controls'.
    this.access = normalizeAccess(access ?? ACCESS_DEFAULTS);
    this.reduced = false;
    this._applyAccess();
    this.state = 'browse';
    this.book = null; // book descriptor in inspect/read
    this.book3d = null;
    this.reader = null;
    this.holder = new THREE.Group(); // book + its panels while inspecting/reading
    this.holder.name = 'holder';
    scene.add(this.holder);
    this._tweens = [];
    this._hover = new Map(); // pointer id -> the panel under it, or null (no object per frame: GC on a Quest)
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
    /** Set by main.js: leaves by the way out (this.wayOut: the Hallway, or the place that linked here). */
    this.onHallway = null;
    /** Set by main.js: (place, room) after every rebuild of the shelves; the address names them (place-url.js). */
    this.onShelved = null;
    /** Set by main.js: the shared session (together.js), shown on the kiosk while in one. */
    this.together = null;
    /** Set by main.js: the text view of the open book on a screen (ui/text-view.js, SPEC §5.8). */
    this.textView = null;
    this._leaving = false; // going out by the way out (leave)
    this._leaveTimer = 0;
    this._version = ''; // "Updated …": when the website last changed (setVersion)
    this._outdated = false; // the site changed since this page loaded (setOutdated)
    this._savedScene = null; // "Saved …" of the browser's saved scene (setSavedScene), or null
    this.onSaveScene = null;
    this.onRestoreScene = null;
    this._exitHold = null; // { name, t } while B/Y is held to leave VR
    // Where links were followed from, latest last (back()): { libId, id, at, page, fontScale, side }.
    this._trail = [];
    this._trailBase = 0; // places dropped from the trail's start (it keeps 100): links deep at its first
    /** Set by main.js: the browser's Back along the trail (common's back-history.js). */
    this.backHistory = null;
    this._following = false; // a link being looked up (resolveLink)
    this._linkMarks = null; // the bands over the link under a pointer (_markLink)
    this._bookEntry = false; // the book's history entries are ones the app's Back comes to (step)
    // A TV's remote (SPEC §5.9; main.js, ui/remote.js): OK is useMiddle, Back is step, and ↑ ↓
    // scroll the list the dot is on (scrollUnderDot). tv set by main.js; inCard by ui/remote.js (the
    // page's card has the focus, so the dot goes).
    this.tv = false;
    this.inCard = false;
    this._dotPanel = null; // the panel, and its list that scrolls, under the dot (when near enough)
    this._dotList = null;
    /** Set by ui/remote.js: fn(on) as the dot comes onto such a list, or leaves it (the hint). */
    this.onDotList = null;

    this.tooltip = new Label({ width: 0.56, height: 0.13 });
    this.tooltip.visible = false;
    scene.add(this.tooltip.mesh);

    this._buildKiosk();
    this._buildInspectPanel();
    this._buildToolbar();
    this._buildToc();
    // The panels a pointer can be over (all, or only the inspect panel while a book opens): fixed
    // arrays, so the per-frame hit test and update make none.
    this._panels = [this.kiosk, this.inspectPanel, this.toolbar, this.tocPanel];
    this._openingPanels = [this.inspectPanel];
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
    this._kioskTabPicked = false; // a tab was chosen (or restored): Kiwix's arrival no longer moves it
    this._search = { q: '', results: [], pending: false, token: 0, timer: 0 };
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
    const placesScroll = p.get('places')?.scroll; // kept across refills (indexing progress, rescans)
    // The genre list's scroll, kept across refills of the same place's Rooms tab (_fillRoomsTab).
    this._genresScroll = p.get('room-genres') ? { place: this._genresListFor, scroll: p.get('room-genres').scroll } : null;
    p.clear();
    p.add({ type: 'text', x: pad, y: 26, w: W - 2 * pad, h: 54, text: 'Catalogue', size: 46, weight: '600', serif: true, color: UI.accent });
    // The header's buttons, right to left. With all of them (a server's library, in VR) Rescan is
    // shortened, or the way out's would reach the title; that one takes the room left (another
    // place's name is longer), at most 260.
    let right = W - pad;
    if (!this.staticSite) {
      const tight = this.controls.presenting;
      right -= tight ? 150 : 230;
      p.add({
        id: 'rescan', type: 'button', x: right, y: 24, w: tight ? 150 : 230, h: 56, label: tight ? '⟳ Rescan' : '⟳ Rescan folder', size: 24,
        onClick: () => this.onRescan?.(),
      });
    }
    if (this.controls.presenting) {
      right -= 12 + 170;
      p.add({ id: 'exit-vr', type: 'button', x: right, y: 24, w: 170, h: 56, label: 'Exit VR', size: 24, onClick: () => this.onExitVR?.() });
    }
    right -= 12 + 190;
    p.add({
      id: 'reload', type: 'button', x: right, y: 24, w: 190, h: 56, label: '↻ Reload page', size: 24,
      active: this._outdated, onClick: () => this.onReload?.(),
    });
    const hw = Math.min(260, right - 12 - 270);
    p.add({ id: 'hallway', type: 'button', x: right - 12 - hw, y: 24, w: hw, h: 56, label: this.wayOut.label, size: 24, onClick: () => this.leave() });
    const place = this._place();
    // Rooms exist when there is more than one library, or a library too big to shelve whole.
    const hasRooms = this.libraries.length > 1 || (place && isFaceted(place, this.booksByLib[place.id]));
    if (!hasRooms && this._kioskTab === 'rooms') this._kioskTab = 'shelves';
    let y = 96;
    if (!this.kiwix && this._kioskTab === 'kiwix') this._kioskTab = 'shelves';
    const tabs = [['shelves', 'Shelves & settings'], ...(hasRooms ? [['rooms', 'Rooms']] : []), ['search', 'Search'],
      ...(this.kiwix ? [['kiwix', 'Kiwix']] : [])];
    const tw = (W - 2 * pad - 12 * (tabs.length - 1)) / tabs.length;
    tabs.forEach(([id, label], i) => {
      p.add({
        id: `tab-${id}`, type: 'button', x: pad + i * (tw + 12), y, w: tw, h: 54, label, size: tabs.length > 3 ? 22 : 25,
        active: this._kioskTab === id,
        onClick: () => {
          this._kioskTab = id;
          this._kioskTabPicked = true;
          this._search.focus = id === 'search';
          this._resetForm = null; // another tab, or the same again: the reset's choice is left
          this._fillKiosk();
        },
      });
    });
    y += 74;
    if (this._kioskTab === 'rooms') this._fillRoomsTab(p, y, pad, place, placesScroll);
    else if (this._kioskTab === 'search') this._fillSearchTab(p, y, pad);
    else if (this._kioskTab === 'kiwix') this._fillKiwixTab(p, y, pad);
    else this._fillShelvesTab(p, y, pad, place);
    // In VR a file cannot be picked or downloaded: say where that is done (the page's library
    // card has the button and a link to an example ZIM). Not over the newer-version notice.
    if (this.controls.presenting && !this._outdated) {
      p.add({
        id: 'own-zims', type: 'text', x: pad, y: p.h - 40, w: W - 2 * pad - 270, h: 28, size: 20, color: UI.muted, maxLines: 1,
        text: this.kiwix ? 'More ZIMs: the Kiwix tab, or exit VR to open a file or a web address'
          : 'More ZIMs: exit VR, then open a file or a web address on the page',
      });
    }
    if (this._version || this._outdated) {
      const text = this._outdated ? 'A newer version of this site is available: reload the page' : this._version;
      p.add({ id: 'version', type: 'text', x: pad, y: p.h - 40, w: W - 2 * pad, h: 28, text, size: 21, color: this._outdated ? UI.accent : UI.muted, align: 'right', maxLines: 1 });
    }
  }

  /**
   * Kiwix's library for the kiosk's Kiwix tab (main.js): { catalog, prefs(), setPrefs(p),
   * isOpen(url) }, and onOpenUrl(url) to open a ZIM from the web.
   */
  setKiwix(kiwix, onOpenUrl) {
    this.kiwix = kiwix;
    this.onOpenUrl = onOpenUrl;
    // The kiosk opens on Kiwix's library: more to read is what a new visitor most likely wants.
    if (!this._kioskTabPicked) this._kioskTab = 'kiwix';
    this._fillKiosk();
  }

  /** A build without a server (GitHub Pages): nothing to rescan. */
  setStatic(on) {
    this.staticSite = !!on;
    this._fillKiosk();
  }

  /** Shows when the website last changed, at the foot of the kiosk. */
  setVersion(text) {
    this._version = text;
    this._fillKiosk();
  }

  /**
   * The 3D panels (debug report): the kiosk's tab, search and scrolled lists, which of the inspect
   * panel, reader toolbar and contents are shown (and how far the contents are scrolled), and the
   * book under the pointer. restoreUi() puts the kiosk and contents back (__vrlbry.reproduce).
   */
  uiState() {
    const scrolled = (panel) => Object.fromEntries(panel.elements
      .filter((e) => e.type === 'list' && e.id && e.scroll).map((e) => [e.id, e.scroll]));
    const hover = this._hoveredBook;
    return {
      kiosk: {
        tab: this._kioskTab, search: this._search.q || null, typing: !!this._search.focus, scroll: scrolled(this.kiosk),
        ...(this._resetForm ? { reset: { ...this._resetForm } } : {}), // the reset's choice, when it is open
      },
      inspect: !!this.inspectPanel.visible,
      toolbar: !!this.toolbar.visible,
      contents: this.tocPanel.visible ? { scroll: this.tocPanel.get('list')?.scroll ?? 0 } : null,
      hover: hover ? { library: hover.libId, id: hover.id, title: hover.title } : null,
    };
  }

  /** Puts back a uiState(): the kiosk's tab, search (run again) and scrolling; the contents of an open book. */
  async restoreUi(ui) {
    const k = ui?.kiosk;
    if (k) {
      if (k.tab) {
        this._kioskTab = k.tab;
        this._kioskTabPicked = true;
      }
      const st = this._search;
      clearTimeout(st.timer);
      st.focus = false; // a restored scene does not take the keyboard
      st.q = k.search || '';
      st.pending = !!st.q.trim();
      st.results = [];
      if (st.pending) await this._runSearch(++st.token);
      // The reset's choice as it was shown (only shown: nothing is cleared).
      this._resetForm = k.reset ? { ...defaultResetParts(), ...k.reset } : null;
      this._fillKiosk();
      for (const [id, rows] of Object.entries(k.scroll || {})) {
        const el = this.kiosk.get(id);
        if (el) el.scroll = rows;
      }
      this.kiosk.markDirty();
    }
    if (ui?.contents && this.state === 'read') {
      this.toggleToc(true);
      const list = this.tocPanel.get('list');
      if (list) list.scroll = ui.contents.scroll;
      this.tocPanel.markDirty();
    }
  }

  /** The saved scene's description ("Saved …"), or null when there is none (Restore scene disabled). */
  setSavedScene(text) {
    this._savedScene = text ?? null;
    this._fillKiosk();
  }

  /** The site changed since this page loaded: the kiosk asks for a reload (and says so in VR, unless notices are off). */
  setOutdated(on, { notice = true } = {}) {
    this._outdated = !!on;
    this._fillKiosk();
    if (on && notice && this.controls.presenting) this.notice('This site has been updated', 'Reload the page (on the catalogue stand) to see the changes', 6);
  }

  /**
   * "Reset stored data" on the kiosk (the help dialog has the same; reset.js): each part kept or
   * cleared at a tap, then Clear and reload (onResetStored). The headset has no other way.
   */
  _fillResetForm(p, y0, pad) {
    const W = p.w;
    const form = this._resetForm;
    let y = y0;
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 44, text: 'Reset stored data', size: 34, weight: '600', serif: true, color: UI.accent });
    y += 54;
    p.add({
      type: 'text', x: pad, y, w: W - 2 * pad, h: 66, size: 24, color: UI.muted, maxLines: 2,
      text: `What this site keeps in this browser. Tap a part to keep it or clear it; the page then reloads${this.controls.presenting ? ', and you leave VR' : ''}.`,
    });
    y += 84;
    for (const part of RESET_PARTS) {
      const on = !!form[part.id];
      p.add({
        id: `reset-${part.id}`, type: 'button', x: pad, y, w: W - 2 * pad, h: 64, label: `${on ? 'Clear' : 'Keep'}: ${part.label}`, size: 24,
        active: on,
        onClick: () => {
          form[part.id] = !on;
          this._fillKiosk();
        },
      });
      y += 76;
    }
    y += 16;
    p.add({
      id: 'reset-go', type: 'button', x: pad, y, w: 340, h: 60, label: 'Clear and reload', size: 26,
      disabled: !Object.values(form).some(Boolean), onClick: () => this.onResetStored?.({ ...form }),
    });
    p.add({
      id: 'reset-cancel', type: 'button', x: pad + 356, y, w: 220, h: 60, label: 'Cancel', size: 26,
      onClick: () => {
        this._resetForm = null;
        this._fillKiosk();
      },
    });
  }

  _fillShelvesTab(p, y0, pad, place) {
    if (this._resetForm) return this._fillResetForm(p, y0, pad);
    const W = p.w;
    const shelved = this.world.shelves.books();
    const room = place && this.settings.rooms?.[place.id];
    const libLine = !place ? 'No libraries'
      : room && isFaceted(place, this.booksByLib[place.id])
        ? `${place.title} · ${roomLabel(room)} · ${shelved.length.toLocaleString()} on the shelves`
        : `${place.title} · ${shelved.length.toLocaleString()} ${shelved.length === 1 ? unitOf(place).slice(0, -1) : unitOf(place)}`;
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
    p.add({ type: 'button', x: pad, y, w: 260, h: 60, label: '✦ Surprise me', size: 28, onClick: () => this.surprise() });
    p.add({
      id: 'sound', type: 'button', x: pad + 272, y, w: 190, h: 60, label: this.settings.sound ? 'Sound on' : 'Sound off', size: 26,
      active: this.settings.sound, onClick: () => this.toggleSound(),
    });
    // How to move and turn in VR: the Hallway's choice, shared with it (nav.js).
    p.add({ id: 'smooth', type: 'button', x: pad + 474, y, w: 220, h: 60, size: 24, ...this._moveButton(), onClick: () => this.toggleSmooth() });
    p.add({ id: 'turn', type: 'button', x: pad + 706, y, w: W - 2 * pad - 706, h: 60, size: 24, ...this._turnButton(), onClick: () => this.toggleTurn() });
    // Comfort: less motion, the vignette, seated (common's access.js, shared with the Hallway).
    y += 72;
    const comfort = comfortButtons(this.access, this.reduced);
    const cw = (W - 2 * pad - 24) / 3;
    p.add({ id: 'motion', type: 'button', x: pad, y, w: cw, h: 56, size: 24, ...comfort.motion, onClick: () => this.toggleMotion() });
    p.add({ id: 'vignette', type: 'button', x: pad + cw + 12, y, w: cw, h: 56, size: 24, ...comfort.vignette, onClick: () => this.toggleVignette() });
    p.add({ id: 'seated', type: 'button', x: pad + 2 * (cw + 12), y, w: cw, h: 56, size: 24, ...comfort.seated, onClick: () => this.toggleSeated() });
    // Save / restore the scene (scene.js; the same as in the help dialog, for the headset), and
    // Reset… (reset.js): this tab becomes the choice of what to clear.
    y += 80;
    p.add({ id: 'scene-save', type: 'button', x: pad, y, w: 220, h: 56, label: 'Save scene', size: 26, onClick: () => this.onSaveScene?.() });
    p.add({
      id: 'scene-restore', type: 'button', x: pad + 234, y, w: 220, h: 56, label: 'Restore scene', size: 26,
      disabled: !this._savedScene, onClick: () => this.onRestoreScene?.(),
    });
    p.add({
      id: 'reset', type: 'button', x: pad + 468, y, w: 170, h: 56, label: 'Reset…', size: 26,
      onClick: () => {
        this._resetForm = defaultResetParts();
        this._fillKiosk();
      },
    });
    p.add({
      id: 'scene-note', type: 'text', x: pad + 652, y: y + 4, w: W - 2 * pad - 652, h: 50, text: this._savedScene ?? 'No saved scene',
      size: 20, color: UI.muted, maxLines: 2,
    });
    // The shared session (together.js), while in one: who else is in it, and a way out of it.
    if (this.together?.room) {
      y += 76;
      p.add({ id: 'session-text', type: 'text', x: pad, y: y + 2, w: W - 2 * pad - 250, h: 54, text: this._sessionText(), size: 22, color: UI.text, maxLines: 2 });
      p.add({ id: 'session-leave', type: 'button', x: W - pad - 236, y, w: 236, h: 56, label: 'Leave session', size: 24, onClick: () => this.onLeaveSession?.() });
    }
    const recent = this._recentBooks().slice(0, 3);
    y += 76;
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

  /**
   * Search in VR: an on-screen keyboard, the query, and results — books (go to it and take it
   * out) and Wikipedia articles (open the volume at the article).
   */
  _fillSearchTab(p, y0, pad) {
    const W = p.w;
    const st = this._search;
    // The field takes the physical keyboard (desktop) while it has focus, shown by the caret: from
    // opening the tab, clicking the field or any key below, until Escape or a click elsewhere.
    p.add({
      id: 'search-field', type: 'button', x: pad, y: y0, w: W - 2 * pad, h: 60, radius: 14, label: '',
      color: 'rgba(255,255,255,0.08)', onClick: () => this._focusSearch(true),
    });
    const caret = st.focus ? '|' : '';
    p.add({
      id: 'search-q', type: 'text', x: pad + 18, y: y0 + 13, w: W - 2 * pad - 36, h: 40, size: 30, maxLines: 1,
      text: st.q ? `${st.q}${caret}` : `${caret}${caret ? ' ' : ''}Type a title, an author or an article…`,
      color: st.q ? UI.text : UI.muted,
    });
    const gap = 8;
    const kw = (W - 2 * pad - 9 * gap) / 10;
    const kh = 56;
    let y = y0 + 76;
    SEARCH_KEYS.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        p.add({ type: 'button', x: pad + c * (kw + gap), y: y + r * (kh + gap), w: kw, h: kh, label: ch.toUpperCase(), size: 28, onClick: () => this.typeSearch(ch) });
      });
    });
    y += SEARCH_KEYS.length * (kh + gap);
    p.add({ type: 'button', x: pad, y, w: 6 * (kw + gap) - gap, h: kh, label: 'Space', size: 24, onClick: () => this.typeSearch(' ') });
    p.add({ type: 'button', x: pad + 6 * (kw + gap), y, w: 2 * (kw + gap) - gap, h: kh, label: '⌫', size: 30, onClick: () => this.typeSearch('backspace') });
    p.add({ type: 'button', x: pad + 8 * (kw + gap), y, w: 2 * (kw + gap) - gap, h: kh, label: 'Clear', size: 24, onClick: () => this.typeSearch(null) });
    y += kh + 18;
    if (!st.results.length) {
      const text = !st.q.trim() ? 'Results appear as you type.' : st.pending ? 'Searching…' : 'Nothing found.';
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 34, text, size: 26, color: UI.muted });
      return;
    }
    const multi = this.libraries.length > 1;
    p.add({
      id: 'search-results', type: 'list', x: pad, y, w: W - 2 * pad, h: p.h - y - 52, rowH: 70, size: 26,
      items: st.results.map((e) => (e.article
        ? { label: e.article.from ? `${e.article.from} → ${e.article.title}` : e.article.title, sub: `${e.lib.title} · Volume ${e.article.book.slice(1)}`, onClick: () => this.openArticle(e.lib.id, e.article.book, e.article.n) }
        : { label: e.book.title, sub: [e.book.author, multi ? e.lib.title : null].filter(Boolean).join(' · '), onClick: () => this.searchPick(e.book, { take: true }) })),
    });
  }

  /** Gives the kiosk's search field the keyboard (or takes it away). */
  _focusSearch(on) {
    if (this._search.focus === on) return;
    this._search.focus = on;
    if (this._kioskTab === 'search') this._fillKiosk();
  }

  /** Enter in the kiosk's search: the first result, as if it were picked. */
  _openFirstSearchResult() {
    const e = this._search.results[0];
    if (!e) return;
    this._focusSearch(false);
    if (e.article) this.openArticle(e.lib.id, e.article.book, e.article.n);
    else this.searchPick(e.book, { take: true });
  }

  /** A key of the kiosk keyboard (or the physical one): a character, 'backspace', or null (clear). */
  typeSearch(ch) {
    const st = this._search;
    st.focus = true;
    if (ch === null) st.q = '';
    else if (ch === 'backspace') st.q = st.q.slice(0, -1);
    else if (st.q.length < 60 && !(ch === ' ' && (!st.q || st.q.endsWith(' ')))) st.q += ch;
    const token = ++st.token;
    clearTimeout(st.timer);
    st.pending = !!st.q.trim();
    if (!st.pending) st.results = [];
    else st.timer = setTimeout(() => this._runSearch(token), SEARCH_DELAY);
    this._fillKiosk();
  }

  async _runSearch(token) {
    const st = this._search;
    const books = matchBooks(bookIndex(this.libraries, this.booksByLib), st.q, 12);
    st.results = books;
    if (this._kioskTab === 'search') this._fillKiosk();
    const articles = await findArticles(this.libraries, st.q, 6);
    if (token !== st.token) return;
    if (articles.length) st.results = [...books.slice(0, 6), ...articles];
    st.pending = false;
    if (this._kioskTab === 'search') this._fillKiosk();
  }

  _fillRoomsTab(p, y0, pad, place, placesScroll) {
    const W = p.w;
    let y = y0;
    // One room per library, after the places that shelve several together (the demo set, when its
    // ZIMs are here, and with several libraries all of them). A scrolling list: a folder can hold
    // dozens of libraries, and buttons in a grid ran off the panel (28 libraries hid the demo set,
    // all libraries and the room filters below the kiosk's edge).
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 32, text: 'Libraries', size: 24, color: UI.muted });
    y += 38;
    const groups = groupPlaces(this.libraries);
    const places = [...groups, ...this.libraries];
    const books = place ? this.booksByLib[place.id] || [] : [];
    const faceted = !!place && isFaceted(place, books);
    // Rows: a large library's filters need the space below; otherwise the list takes it, leaving
    // two lines for the note and the foot of the kiosk.
    const rowH = 58;
    const space = faceted ? 4 * rowH : p.h - y - 160;
    const rows = Math.max(3, Math.min(places.length, Math.floor(space / rowH)));
    // Scrolled to the place shown, unless the list was scrolled while showing the same place.
    const current = places.findIndex((l) => l.id === place?.id);
    const keep = placesScroll != null && this._placesListFor === place?.id;
    this._placesListFor = place?.id;
    p.add({
      id: 'places', type: 'list', x: pad, y, w: W - 2 * pad, h: rows * rowH, rowH, size: 24,
      scroll: keep ? placesScroll : Math.max(0, current - 1),
      items: places.map((lib) => {
        const n = placeBookCount(lib, this.libraries, this.booksByLib);
        const busy = lib.indexing && lib.indexing.stage !== 'failed';
        return {
          label: lib.title,
          right: busy ? (lib.indexing.stage === 'queued' ? 'waiting to index' : `indexing ${Math.round((lib.indexing.progress || 0) * 100)}%`)
            : `${n.toLocaleString()} ${n === 1 ? unitOf(lib).slice(0, -1) : unitOf(lib)}`,
          active: place?.id === lib.id, disabled: !n,
          onClick: () => this.setPlace(lib.id),
        };
      }),
    });
    y += rows * rowH + 14;
    if (!place) return;
    if (!faceted) {
      const capped = this.world.sections.some((s) => s.shown < s.books);
      const text = capped
        ? `${place.title} share ${MAX_BOOKCASES} bookcases here: the small libraries whole, the first books of the large ones.`
        : place === ALL_PLACE ? 'All libraries are shelved whole in this room.'
          : groups.includes(place) ? `The ${place.title.toLowerCase()} is shelved whole in this room.`
            : `${place.title} is shelved whole in this room.`;
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 90, text, size: 26, color: UI.muted, maxLines: 2 });
      return;
    }
    // …and a large library is browsed through two filters, a genre and a title letter, each
    // switched on, swapped or (tapped again) off independently.
    const room = normRoom(this.settings.rooms?.[place.id]) || { genre: null, letter: null };
    const { genres, letters } = facetsOf(books, room);
    const total = genres.reduce((n, g) => n + (!room.genre || g.name === room.genre ? g.count : 0), 0);
    const pages = pagesOf(total);
    const page = Math.min(room.page ?? 0, pages - 1);
    const filtered = !!(room.genre || room.letter || page);
    p.add({
      type: 'text', x: pad, y: y + 6, w: W - 2 * pad - (filtered ? 230 : 0), h: 34, size: 24, color: UI.text, maxLines: 1,
      text: `Now: ${roomLabel(room)} · ${total.toLocaleString()} works${capNote(place, total, page)}`,
    });
    if (filtered) {
      p.add({
        id: 'room-clear', type: 'button', x: W - pad - 220, y, w: 220, h: 46, label: '✕ Clear filters', size: 21,
        onClick: () => this.setRoom(place.id, { genre: null, letter: null }),
      });
    }
    y += 54;
    // A room holding more than the shelves take: its pages of ROOM_CAP (by popularity for Gutenberg).
    if (pages > 1) {
      const n = ROOM_CAP.toLocaleString();
      const bw = 250;
      p.add({
        id: 'room-prev', type: 'button', x: pad, y, w: bw, h: 46, label: `◀ Previous ${n}`, size: 21,
        disabled: page === 0, onClick: () => this.turnPage(place.id, -1),
      });
      p.add({
        type: 'text', x: pad + bw + 10, y: y + 8, w: W - 2 * pad - 2 * bw - 20, h: 30, size: 21, color: UI.muted, maxLines: 1, align: 'center',
        text: `Page ${page + 1} of ${pages}`,
      });
      p.add({
        id: 'room-next', type: 'button', x: W - pad - bw, y, w: bw, h: 46, label: `Next ${n} ▶`, size: 21,
        disabled: page >= pages - 1, onClick: () => this.turnPage(place.id, 1),
      });
      y += 54;
    }
    p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 30, text: 'Genre · tap again to remove', size: 21, color: UI.muted, maxLines: 1 });
    y += 34;
    // Every genre in a list, named (Gutenberg's LCC classes: genreLabel), largest first: 40 for
    // English Gutenberg, which a grid of buttons could neither show all of nor name.
    const genreRowH = 48;
    const genreRows = Math.max(3, Math.floor((p.h - y - 200) / genreRowH)); // below it: the letters (~146 px) and the footer
    const activeAt = genres.findIndex((g) => g.name === room.genre);
    const genresScroll = this._genresScroll;
    const keepGenres = genresScroll && genresScroll.place === place.id;
    this._genresListFor = place.id;
    p.add({
      id: 'room-genres', type: 'list', x: pad, y, w: W - 2 * pad, h: genreRows * genreRowH, rowH: genreRowH, size: 22,
      scroll: keepGenres ? genresScroll.scroll : Math.max(0, activeAt - 1),
      items: genres.map((g) => {
        const active = room.genre === g.name;
        return {
          label: genreLabel(g.name),
          right: g.count.toLocaleString(),
          active, disabled: !active && !g.count,
          onClick: () => this.toggleFilter(place.id, 'genre', g.name),
        };
      }),
    });
    y += genreRows * genreRowH + 8;
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

  /**
   * Kiwix's library in VR (milestone 3 step 5; local/kiwix.js), where no file can be picked and no
   * address typed: the ZIMs this library reads well, by kind and language; a row opens one from
   * the web (onOpenUrl). `this.kiwix` is given by main.js: { catalog, prefs(), setPrefs(p),
   * isOpen(url) }. The page's dialog (ui/kiwix-dialog.js) is the same list.
   */
  _fillKiwixTab(p, y0, pad) {
    const W = p.w;
    const k = this.kiwix;
    const { kind, lang } = k.prefs();
    const key = `${kind}|${lang}`;
    // Read when the kind or language changes; again in the background (the shown list stays) when
    // the libraries changed (their Open marks, and an index now kept here).
    if (this._kiwixView?.key !== key || this._kiwixView.stale) {
      const shown = this._kiwixView?.key === key ? this._kiwixView.view : null;
      this._kiwixView = shown ? { key, view: shown } : { key, loading: true };
      k.catalog.view(kind, lang).then((view) => ({ key, view }), (err) => ({ key, error: err.message })).then((st) => {
        if (this._kiwixView?.key !== key) return;
        this._kiwixView = st;
        if (this._kioskTab === 'kiwix') this._fillKiosk();
      });
    }
    const st = this._kiwixView;
    let y = y0;
    const bw = (W - 2 * pad - 10 * (KIWIX_KINDS.length - 1)) / KIWIX_KINDS.length;
    KIWIX_KINDS.forEach((kd, i) => {
      p.add({
        id: `kiwix-kind-${kd.id}`, type: 'button', x: pad + i * (bw + 10), y, w: bw, h: 50, label: kd.label, size: 24,
        active: kind === kd.id,
        onClick: () => {
          this._kiwixPicking = false;
          k.setPrefs({ kind: kd.id, lang });
          this._fillKiosk();
        },
      });
    });
    y += 62;
    const langName = st.view?.languages.find((l) => l.code === lang)?.name ?? lang;
    p.add({ type: 'text', x: pad, y: y + 8, w: W - 2 * pad - 250, h: 34, text: `Language: ${langName}`, size: 24, color: UI.text, maxLines: 1 });
    p.add({
      id: 'kiwix-lang', type: 'button', x: W - pad - 240, y, w: 240, h: 48, size: 22, disabled: !st.view,
      label: this._kiwixPicking ? 'Back to the list' : 'Change language',
      onClick: () => {
        this._kiwixPicking = !this._kiwixPicking;
        this._fillKiosk();
      },
    });
    y += 62;
    const listH = Math.max(140, p.h - y - 64);
    if (st.loading) {
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 40, text: "Reading Kiwix's catalogue…", size: 24, color: UI.muted });
      return;
    }
    if (st.error) {
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 100, size: 24, color: UI.muted, maxLines: 3,
        text: `Kiwix's catalogue cannot be reached (${st.error}). Outside VR a ZIM's web address can still be typed, or a file opened.` });
      p.add({ id: 'kiwix-retry', type: 'button', x: pad, y: y + 110, w: 200, h: 48, label: 'Try again', size: 22,
        onClick: () => { this._kiwixView = null; this._fillKiosk(); } });
      return;
    }
    if (this._kiwixPicking) {
      const rowH = 58;
      const current = st.view.languages.findIndex((l) => l.code === lang);
      p.add({
        id: 'kiwix-langs', type: 'list', x: pad, y, w: W - 2 * pad, h: Math.floor(listH / rowH) * rowH, rowH, size: 24,
        scroll: Math.max(0, current - 1),
        items: st.view.languages.map((l) => ({
          label: l.name, right: String(l.count), active: l.code === lang,
          onClick: () => {
            this._kiwixPicking = false;
            k.setPrefs({ kind, lang: l.code });
            this._fillKiosk();
          },
        })),
      });
      return;
    }
    const entries = st.view.entries;
    if (!entries.length) {
      p.add({ type: 'text', x: pad, y, w: W - 2 * pad, h: 70, size: 24, color: UI.muted, maxLines: 2,
        text: `No ${KIWIX_KINDS.find((x) => x.id === kind)?.label ?? ''} ZIMs in this language: change it above.` });
      return;
    }
    const rowH = 72;
    p.add({
      id: 'kiwix-list', type: 'list', x: pad, y, w: W - 2 * pad, h: Math.floor(listH / rowH) * rowH, rowH, size: 24,
      items: entries.map((e) => {
        const open = k.isOpen(e.url);
        return {
          label: e.title,
          // Where its index comes from first (a Wikipedia or Wikisource; "needs an index" is on the right).
          sub: [e.needsIndex ? '' : indexLabel(e)?.text, e.date, e.about].filter(Boolean).join(' · '),
          right: open ? 'open' : e.needsIndex ? 'needs an index' : sizeText(e.size),
          active: open, disabled: open || e.needsIndex,
          onClick: () => {
            this.notice(`Opening ${e.title}`, "Read from Kiwix's mirror, a little at a time", 5);
            this.onOpenUrl?.(e.url);
          },
        };
      }),
    });
  }

  /** Library info changed without a rebuild (e.g. indexing progress): refresh the kiosk text. */
  updateLibraries(libraries) {
    this.libraries = libraries;
    if (this._kiwixView?.view) this._kiwixView.stale = true;
    if (this._kioskTab === 'rooms' || this._kioskTab === 'kiwix') this._fillKiosk();
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
    const lib = groupPlaces(this.libraries).find((g) => g.id === libId) ?? this.libraries.find((l) => l.id === libId);
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
    delete room.page; // another room: from its first page
    return this.setRoom(libId, room);
  }

  /** Shelves the next (`delta` 1) or previous (-1) page of a large library's room. */
  turnPage(libId, delta) {
    const room = normRoom(this.settings.rooms?.[libId]) || { genre: null, letter: null };
    return this.setRoom(libId, normRoom({ ...room, page: Math.max(0, (room.page ?? 0) + delta) }) ?? room);
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

  /**
   * The inspect panel: the book's details, then its buttons. While it is being opened (`opening`:
   * the line under "Opening…", which _showOpening counts up, with a progress bar once there is
   * progress) only Put back, which cancels; with `error`, why it could not be opened, under the
   * buttons.
   */
  _fillInspect(book, { opening = null, error = null } = {}) {
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
    if (opening) {
      p.add({ type: 'text', x: pad, y: by, w: W - 2 * pad, h: 44, text: 'Opening…', size: 32, weight: '600', maxLines: 1 });
      p.add({ id: 'opening', type: 'text', x: pad, y: by + 46, w: W - 2 * pad, h: 34, text: opening, size: 24, color: UI.muted, maxLines: 1 });
      // A progress bar, once the conversion reports how far it is (local books only).
      p.add({ id: 'opening-track', type: 'rect', x: pad, y: by + 86, w: W - 2 * pad, h: 10, radius: 5, color: 'rgba(255,255,255,0.12)', hidden: true });
      p.add({ id: 'opening-bar', type: 'rect', x: pad, y: by + 86, w: 0, h: 10, radius: 5, color: UI.accent, hidden: true });
      p.add({ type: 'button', x: pad, y: by + 108, w: W - 2 * pad, h: 60, label: 'Put back', size: 26, onClick: () => this._cancelOpening?.() });
      return;
    }
    if (error) p.add({ type: 'text', x: pad, y: by + 158, w: W - 2 * pad, h: 64, text: error, size: 22, color: '#e2a08f', maxLines: 2 });
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

  /**
   * Per frame while a book opens (read): the seconds so far and the progress bar on the inspect
   * panel. The bar is repainted at most every OPENING_BAR_MS (each repaint uploads the panel).
   */
  _showOpening(o) {
    const p = this.inspectPanel;
    const now = performance.now();
    const s = Math.floor((now - o.t0) / 1000);
    if (s >= 1 && s !== o.shown) { // once a second: the seconds so far and about how long is left
      o.shown = s;
      // Only a local book's conversion reports progress, so only there is an estimate coming.
      p.set('opening', { text: OPENING_LINE + progressText(now - o.t0, o.f, { estimating: isLocal(this.book.libId) }) });
    }
    if (o.f !== null && o.f !== o.drawnF && (now - o.drawnAt >= OPENING_BAR_MS || o.f >= 1)) {
      o.drawnF = o.f;
      o.drawnAt = now;
      const track = p.set('opening-track', { hidden: false });
      p.set('opening-bar', { hidden: false, w: Math.max(track.h, Math.round(track.w * Math.min(1, o.f))) });
    }
  }

  _buildToolbar() {
    const p = new Panel({ width: TOOLBAR_W, height: 0.13, pxPerMeter: 1300 });
    p.visible = false;
    p.mesh.name = 'toolbar';
    this.toolbar = p;
    this.holder.add(p.mesh);
    const W = p.w;
    const pad = 18;
    p.add({ id: 'slider', type: 'slider', x: pad + 10, y: 10, w: W - 2 * pad - 230, h: 48, value: 0, onClick: (v) => this.jumpToProgress(v) });
    p.add({ id: 'back', type: 'button', x: pad, y: 8, w: 132, h: 52, label: '↩ Back', size: 26, hidden: true, onClick: () => this.goBack() });
    p.add({ id: 'label', type: 'text', x: W - pad - 210, y: 16, w: 210, h: 40, text: '', size: 26, align: 'right', color: UI.muted });
    const by = 68;
    const bh = 84;
    const defs = [
      ['prev', '◀', 88, () => this.turn(-1)],
      ['next', '▶', 88, () => this.turn(1)],
      ['toc', 'Contents', 146, () => this.toggleToc()],
      ['smaller', 'A−', 84, () => this.changeFont(-1)],
      ['larger', 'A+', 84, () => this.changeFont(1)],
      ['pages', '1 page', 136, () => this.togglePages()], // the other view (_showPagesButton)
      ['theme', 'Theme', 108, () => this.cycleTheme()],
      ['close', '✕', 84, () => this.closeBook()],
    ];
    const total = defs.reduce((s, d) => s + d[2], 0);
    const gap = (W - 2 * pad - total) / (defs.length - 1);
    let x = pad;
    for (const [id, label, w, fn] of defs) {
      p.add({ id, type: 'button', x, y: by, w, h: bh, label, size: ['toc', 'pages', 'theme'].includes(id) ? 28 : 34, onClick: fn });
      x += w + gap;
    }
  }

  _buildToc() {
    const p = new Panel({ width: TOC_W, height: TOC_H, pxPerMeter: 1300 });
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
    // The entry being read: highlighted, and the list opens there.
    const c = this._currentRef()?.c ?? 0;
    let current = -1;
    toc.forEach((e, i) => { if (e.c <= c) current = i; });
    // A long contents list in title order (a Wikipedia volume's 1,000 articles) gets a thumb
    // index beside it: evenly spaced stops labelled with how their titles start.
    const titles = toc.map((e) => e.title);
    const listY = 96;
    const listH = p.h - 120;
    const stops = toc.length > TOC_THUMBS_MIN && inTitleOrder(titles) ? thumbIndex(titles, TOC_THUMBS) : [];
    const thumbW = stops.length ? 96 : 0;
    stops.forEach(({ index, label }, k) => {
      const h = listH / TOC_THUMBS;
      p.add({
        type: 'button', x: 20, y: listY + k * h, w: thumbW - 12, h: h - 6, label, size: 24,
        onClick: () => {
          p.get('list').scroll = index;
          p.markDirty();
        },
      });
    });
    p.add({
      id: 'list', type: 'list', x: 20 + thumbW, y: listY, w: p.w - 40 - thumbW, h: listH, rowH: 64, size: 26, serif: true,
      scroll: Math.max(0, current - 3),
      items: toc.map((e, i) => ({ label: e.title, indent: e.level - minLevel, active: i === current, onClick: () => this.jumpToToc(e) })),
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
    // Press and release: dragging a list's scroll bar on a panel (mouse, finger, controller, hand).
    c.addEventListener('selectstart', (e) => this._pressStart(e.detail.pointer));
    c.addEventListener('selectend', (e) => this._pressEnd(e.detail.pointer));
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
      // A thumbstick press (walking is off while a book is out): the book in front of the eyes.
      if (pressed && name === 'stick' && (this.state === 'inspect' || this.state === 'read')) this.bookToFront();
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
    const meshes = _meshes;
    meshes.length = 0;
    for (const p of this.state === 'opening' ? this._openingPanels : this._panels) if (p.visible && p.mesh.parent) meshes.push(p.mesh);
    _hits.length = 0;
    const ph = rc.intersectObjects(meshes, false, _hits)[0];
    if (ph) best = { kind: 'panel', panel: ph.object.userData.panel, uv: ph.uv, distance: ph.distance };
    // The door back (world/door.js): its opening leads out, its frame stops the laser as a wall does.
    const door = this.state === 'browse' ? this.world.door?.raycast(rc.ray) : null;
    if (door && door.distance < rc.far && (!best || door.distance < best.distance)) {
      best = { kind: door.opening ? 'door' : 'solid', distance: door.distance };
    }
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
    // So do the walls, floor, ceiling and furniture.
    const solid = this.world.raycastSolid(rc.ray);
    if (solid < rc.far && (!best || solid < best.distance)) best = { kind: 'solid', distance: solid };
    return best;
  }

  /** A press on a panel's scroll bar starts dragging its thumb; looking around waits meanwhile. */
  _pressStart(pointer) {
    this._swallowSelect = null;
    if (this.state === 'busy' || pointer.teleporting || this._panelDrag) return;
    const hit = this._hitTest(pointer);
    if (hit?.kind !== 'panel' || !hit.panel.pressAt(hit.uv.x, hit.uv.y)) return;
    this._panelDrag = { pointer, panel: hit.panel, look: this.controls.lookEnabled };
    this.controls.lookEnabled = false;
  }

  _pressEnd(pointer) {
    if (this._panelDrag?.pointer !== pointer) return;
    this._endPanelDrag();
    // The release's click belongs to the drag, not to whatever is under the pointer now.
    this._swallowSelect = pointer;
  }

  _endPanelDrag() {
    const d = this._panelDrag;
    if (!d) return;
    d.panel.release();
    this.controls.lookEnabled = d.look;
    this._panelDrag = null;
  }

  _select(pointer) {
    if (this._panelDrag?.pointer === pointer) return;
    if (this._swallowSelect === pointer) {
      this._swallowSelect = null;
      return;
    }
    if (this.state === 'busy' || pointer.teleporting) return;
    const hit = this._hitTest(pointer);
    if (this._search.focus && !(hit?.kind === 'panel' && hit.panel === this.kiosk)) this._focusSearch(false);
    if (!hit) return;
    if (hit.kind === 'panel') {
      if (hit.panel.click(hit.uv.x, hit.uv.y)) audio.click();
    } else if (hit.kind === 'book' && this.state === 'browse') {
      this.pick(hit.book);
    } else if (hit.kind === 'door' && this.state === 'browse') {
      this.leave();
    } else if (hit.kind === 'held' && this.state === 'inspect') {
      if (this.book.readable) this.read();
    } else if (hit.kind === 'page' && this.state === 'read') {
      const found = this._linkUnder(hit);
      if (found) this.followLink(found.link);
      // One page at a time, its left part turns back too: the left page is often off the screen.
      else this.turn(hit.side === 'left' || (this._single && hit.uv && hit.uv.x < 0.3) ? -1 : 1);
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
      if (![...this._hover.values()].includes(this.kiosk)) return;
      // The list under the pointer, else the tab's own list.
      const el = this.kiosk.hover;
      const id = el?.type === 'list' && el.id ? el.id
        : { rooms: 'places', search: 'search-results', shelves: 'recent', kiwix: this._kiwixPicking ? 'kiwix-langs' : 'kiwix-list' }[this._kioskTab];
      this.kiosk.scrollList(id, Math.sign(deltaY));
    }
  }

  _key({ key, code, text }) {
    if (this.state === 'busy') return;
    if (key === 'Home' && !text) {
      this.resetView();
      return;
    }
    if (text && this.state === 'browse') {
      if (key === 'Escape') this._focusSearch(false);
      else if (key === 'Enter') this._openFirstSearchResult();
      else if (key === 'Backspace') this.typeSearch('backspace');
      else this.typeSearch(key);
      return;
    }
    if (this.state === 'read') {
      if (['ArrowRight', 'PageDown', ' '].includes(key)) this.turn(1);
      else if (['ArrowLeft', 'PageUp'].includes(key)) this.turn(-1);
      else if (key === '+' || key === '=') this.changeFont(1);
      else if (key === '-') this.changeFont(-1);
      else if (key === 'Backspace') this.back();
      else if (key === 'Escape') {
        if (this.tocPanel.visible) this.toggleToc(false);
        else this.closeBook();
      } else if (code === 'KeyC') this.toggleToc();
      else if (code === 'KeyT') this.textView?.toggle(); // a screen's text view (not in a headset)
      else if (code === 'KeyF') this.bookToFront();
      else if (code === 'KeyN') this.cycleTheme();
      else if (code === 'KeyP') this.togglePages();
    } else if (this.state === 'inspect') {
      if (key === 'Enter' || key === ' ') {
        if (this.book.readable) this.read();
      } else if (code === 'KeyT' && this.textView && this.book.readable) {
        this.textView.openOnRead(); // read, straight into the text view (a screen's)
        this.read();
      } else if (key === 'Escape' || key === 'Backspace') this.putBack();
      else if (code === 'KeyF') this.bookToFront();
    } else if (this.state === 'opening' && (key === 'Escape' || key === 'Backspace')) {
      this._cancelOpening?.();
    }
  }

  /** B/Y/Backspace: one step back (in a book: along the links followed, then it closes). */
  back() {
    if (this.state === 'read') {
      if (this.tocPanel.visible) this.toggleToc(false);
      else if (this._trail.length) this.goBack();
      else this.closeBook();
    } else if (this.state === 'inspect') this.putBack();
    else if (this.state === 'opening') this._cancelOpening?.();
  }

  // ===========================================================================================
  // A TV's remote (SPEC §5.9: common's tv.js Remote, ui/remote.js)

  /**
   * Back while walking, the Remote's step: one step back (back-step.js), as B and Escape take one;
   * false for none here, or for one through the book's history entries, which the app's own Back
   * goes back through (then the browser's: back-history.js), so Back takes one step, not two.
   */
  step() {
    const tv = this.textView;
    const what = backStep({
      state: this.state, textView: !!tv?.isOpen, textToc: !!tv?.tocOpen, toc: this.tocPanel.visible,
      trail: this._trail.length, typing: !!this._search.focus, level: this.backHistory?.level ?? 0, entry: this._bookEntry,
    });
    if (what === 'text-toc') tv.closeToc();
    else if (what === 'text') tv.close();
    else if (what === 'typing') this._focusSearch(false);
    else if (what === 'toc') this.toggleToc(false);
    else if (what === 'link') this.goBack();
    else if (what === 'away') this.putAway();
    else return false;
    return true;
  }

  /**
   * OK while walking (the Remote's use): the gamepad's A at the middle of the view (a book on a
   * shelf, the stand, the door). A book in hand is read, as Enter does; an open one turns a page,
   * as the middle of a spread is its gutter (its contents, over the page on a TV, take the A).
   */
  useMiddle() {
    audio.init();
    if (this.state === 'inspect') {
      if (this.book.readable) this.read();
    } else if (this.state === 'read' && !this.tocPanel.visible) {
      this.turn(1);
    } else {
      this._select(this.controls.aimPointer);
    }
  }

  /**
   * ↑ ↓ on a TV while walking (controls.scrollKey): the list the dot is on scrolls a row, when it
   * has more rows than it shows and the stand is near (or it is the contents of the book being
   * read); false to walk.
   */
  scrollUnderDot(dir) {
    if (!this._dotList || this.state === 'busy') return false;
    this._dotPanel.scrollBy(this._dotList, dir);
    return true;
  }

  /** A key's button in the page's card (overlay.js, a TV's: the letter keys, Enter, Esc). */
  pressKey(key, code = key) {
    this._key({ key, code });
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

  /** An eased move of the view or a book: a _tween, or a cut with less motion (its end at once). */
  _ease(duration, step) {
    if (!this.reduced) return this._tween(duration, step);
    step(1);
    return Promise.resolve();
  }

  /** Animates an object's world transform to a target (position, quaternion, scale) with an arc. */
  async _fly(obj, toPos, toQuat, toScale, duration = 0.55, arc = 0.12) {
    const fromPos = obj.position.clone();
    const fromQuat = obj.quaternion.clone();
    const fromScale = obj.scale.x;
    await this._ease(duration, (t) => {
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
    // The browser's Back puts it away (back-history.js). Chromium passes over that entry when the
    // page has had no key press or click yet (a gamepad alone): then a TV's Back is a step (step).
    if (!this.backHistory?.level) this._bookEntry = navigator.userActivation?.hasBeenActive ?? true;
    this.backHistory?.bookOut();
    this._setHover(null);
    this.controls.locomotionEnabled = false;
    const tr = this.world.shelves.getBookTransform(book);
    // Room for it and its panel first: close to a bookcase they ended behind its back board.
    const k = await this._makeRoom(this._inspectOffsets(tr.dims));
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

    const { target, quat: face } = this._inspectPose(k);
    this.holder.position.copy(target);
    this.holder.quaternion.copy(face);
    this.holder.scale.setScalar(k); // nearer to make room: smaller too, so it looks the same
    this.holder.updateMatrixWorld(true);
    const quat = this.holder.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12));
    await this._fly(b3.group, target, quat, 1.25 * k, 0.6, 0.1);
    this.holder.attach(b3.group);

    this._fillInspect(book);
    const p = this.inspectPanel;
    p.mesh.position.set(tr.dims.d * 0.62 + 0.21, 0.02, 0.02);
    p.mesh.rotation.set(0, -0.25, 0);
    p.visible = true;
    this.state = 'inspect';
    this.overlay?.setBookOut?.(true);
    // Said when it stays in hand: a caller that opens it at once (an article found, a link, a
    // recent book) has called read() before this runs.
    setTimeout(() => { if (this.state === 'inspect' && this.book === book) this.textView?.bookInHand(); }, 0);
  }

  /** Returns the book to its shelf (keepTrail: a link leads to another book: back() returns). */
  async putBack({ keepTrail = false } = {}) {
    if (this.state !== 'inspect' && this.state !== 'read') return;
    if (!keepTrail) {
      this._putAways = (this._putAways || 0) + 1; // putAway: this book is away
      // The book is put away: the browser's Back no longer closes it or goes along its links
      // (back-history.js).
      this.backHistory?.cleared();
      this._bookEntry = false;
      this._trail = [];
      this._trailBase = 0;
    }
    this._showBack();
    this._markLink(null);
    this.textView?.bookClosing(keepTrail);
    const book = this.book;
    const b3 = this.book3d;
    // Forget the spreads, or the next book finds every page canvas still in use.
    this._prepToken = (this._prepToken || 0) + 1;
    this._cur = this._next = this._prev = null;
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
    this.overlay?.setBookOut?.(false);
    if (this._pendingCatalog) await this._rebuildWorld(); // a rescan arrived while reading
    else this._fillKiosk(); // refresh "recently read"
  }

  // ===========================================================================================
  // Reading

  /**
   * Opens the inspected book for reading: at the saved position, at the start (fromStart), at
   * a block anchor (at: { c, b, f? }, e.g. a Wikipedia article found by search; f: a place's id,
   * from a link), or at a page (page: { c, p }, a link trail's, laid out at the same font size).
   * `side` ('left' or 'right') puts that page on that side of the spread, as it was when a debug report was made:
   * turning pairs pages one after another, while the page number decides otherwise, and page
   * numbers are partly estimated, so the pairing depends on how the page was reached. `pages`
   * (1 or 2, a scene's) shows the book one page or two at a time, whatever the setting says.
   */
  async read({ fromStart = false, at = null, side = null, page = null, pages = null } = {}) {
    if (this.state !== 'inspect' || !this.book.readable) return;
    const book = this.book;
    const b3 = this.book3d;
    const reader = new BookReader({ libId: book.libId, book, fontScale: this.settings.fontScale, theme: this.settings.theme });
    this.reader = reader;
    this.toolbar.set('label', { text: 'Opening…' });
    // Preparing a book can take a while (a big one from a ZIM file opened on a Quest took half a
    // minute), so meanwhile the inspect panel says so, counting the seconds, and its Put back
    // cancels. In 'opening' only that panel takes input.
    this.state = 'opening';
    this._opening = { t0: performance.now(), shown: 0, f: null, drawnF: null, drawnAt: 0 };
    const opening = this._opening;
    this._fillInspect(book, { opening: OPENING_LINE });
    const cancelled = new Promise((resolve) => { this._cancelOpening = () => resolve(CANCELLED); });
    const t0 = performance.now();
    let startRef;
    let failure = null;
    try {
      startRef = await Promise.race([cancelled, (async () => {
        await reader.load({ onProgress: (f) => { opening.f = f; } });
        if (page) return page;
        const pos = at ?? (!fromStart && load(`pos:${book.libId}:${book.id}`, null));
        return pos ? this._refFor(reader, pos) : reader.firstRef();
      })()]);
    } catch (err) {
      failure = err;
    }
    this._opening = null;
    this._cancelOpening = null;
    if (failure || startRef === CANCELLED) {
      reader.dispose();
      this.reader = null;
      this.state = 'inspect';
      if (!failure) return this.putBack();
      console.error(failure);
      this.overlay?.showToast(`Could not open this book: ${failure.message}`, 'error');
      this._fillInspect(book, { error: `Could not open this book: ${failure.message}` });
      return;
    }
    perf.event('book-load', { t: t0, ms: performance.now() - t0, chunks: reader.chunkCount });
    this.state = 'busy';
    this.inspectPanel.visible = false;

    // One page at a time or two (reader/spreads.js singlePage).
    this._single = pages ? pages === 1 : this._singleWanted();
    this._showPagesButton();
    // Reading pose (_readingTarget): in front of the eyes, a little below, facing them, with room for
    // the spread and its toolbar made first (nearer and smaller by k when needed).
    this._readScale = b3.readingScale * (this.settings.readScale || 1);
    const { target, quat, k } = await this._readingTarget();
    this.overlay?.setReading(true);
    this.scene.attach(b3.group);
    this.holder.position.copy(target);
    this.holder.quaternion.copy(quat);
    this.holder.scale.setScalar(k);
    this.holder.updateMatrixWorld(true);
    // The cover swings open around a fixed spine (_bookX: at the spread's centre, or half a page
    // left of the page read), so the closed book lands where the right-hand page will be.
    b3.centerWhenOpen = false;
    const x = this._bookX();
    const flyTarget = target.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(quat), x * k);
    await this._fly(b3.group, flyTarget, quat, this._readScale * k, 0.5, 0.05);
    this.holder.attach(b3.group);
    b3.group.position.set(x, 0, 0);
    b3.group.quaternion.identity();
    b3.setSingle(this._single);

    const shown = await this._renderSpread(await this._spreadAt(startRef, side));
    this._cur = shown;
    b3.setPages(shown.left, shown.right);
    audio.open();
    await b3.open();
    this._placeReadingPanels();
    this.toolbar.visible = true;
    this.state = 'read';
    this._afterTurn();
    this.textView?.bookOpened(); // its title said; the text view opened when kept on
  }

  /**
   * How far in front of the eyes (and below them) an open book sits: in a headset the distance
   * chosen with the stick (settings.readDistance); on a flat screen far enough that the whole
   * spread fits the screen's width (portrait phones) and height, a little higher; in the
   * single-page view, the page as large as the screen's width and height allow with its toolbar
   * under it (fitOnePage).
   * @returns {{ dist: number, drop: number, flat: boolean }}
   */
  _readingPose() {
    const flat = !this.controls.presenting;
    if (!flat) return { dist: this.settings.readDistance || READ.distance, drop: READ.drop, flat };
    const page = READ.pageWidth * (this.settings.readScale || 1);
    const vt = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const aspect = this.camera.aspect;
    if (this._single) {
      const fit = fitOnePage({
        pageW: page * 1.06, pageH: page * (PAGE_PX.h / PAGE_PX.w) * 1.04, vt, aspect,
        toolbarW: TOOLBAR_W, toolbarDrop: TOOLBAR_DROP,
      });
      return { dist: fit.dist, drop: fit.drop, flat };
    }
    const half = page * 1.06;
    return { dist: Math.max(0.64, half / (vt * aspect), (half * 1.45 * 0.5 + 0.36) / vt), drop: 0.04, flat };
  }

  /**
   * Where the open book goes, in front of the viewer, with room made first: { target, quat, k }
   * (k ≤ 1: nearer and smaller, _makeRoom). It faces the eyes; on a flat screen, whose view is
   * levelled, it faces the screen square on: tilted towards eyes below it, its top edge came
   * nearer and larger (the single-page view's page, above the eyes, ran off the top).
   */
  async _readingTarget() {
    const pose = this._readingPose();
    const k = await this._makeRoom(this._readOffsets(pose, this._readScale));
    const { eye, fwd } = this._viewerFrame();
    const target = eye.clone().addScaledVector(fwd, pose.dist * k);
    target.y = eye.y - pose.drop * k;
    if (pose.flat) this.controls.pitch = 0;
    const facing = pose.flat ? new THREE.Vector3(eye.x, target.y, eye.z) : eye;
    return { target, quat: this._faceQuat(target, facing), k };
  }

  /**
   * Where the open book sits in the holder (its x): the spine, about which it opens (at the book's
   * x = −d/2), at the holder's centre; in the single-page view half a page left of it, so the page
   * read (on the right) is in front.
   */
  _bookX() {
    const b3 = this.book3d;
    return ((b3.dims.d - (this._single ? b3.pageSize.w : 0)) / 2) * this._readScale;
  }

  /** Points of a pose (holder-local [x, y, z]) placed at `target` facing the eyes, as vectors from them. */
  _poseOffsets(eye, target, locals) {
    const quat = this._faceQuat(target, eye);
    return locals.map(([x, y, z]) => new THREE.Vector3(x, y, z).applyQuaternion(quat).add(target).sub(eye));
  }

  /** The book in hand and its info panel (pick), `k` nearer: { eye, target, quat }. */
  _inspectPose(k = 1) {
    const { eye, fwd, right } = this._viewerFrame();
    const target = eye.clone().addScaledVector(fwd, 0.62 * k).addScaledVector(right, -0.12 * k);
    target.y = eye.y - 0.16 * k;
    return { eye, target, quat: this._faceQuat(target, eye) };
  }

  /** Points of the inspect pose (its centre first, the cover's corners, the info panel's). */
  _inspectOffsets(dims) {
    const { eye, target } = this._inspectPose();
    const bw = dims.d * 0.625; // the cover (1.25 ×), half
    const bh = dims.h * 0.625;
    const px = dims.d * 0.62 + 0.21; // the panel (0.36 × 0.41 m) beside it
    return this._poseOffsets(eye, target, [
      [0, 0, 0], [-bw, -bh, 0], [bw, -bh, 0], [-bw, bh, 0], [bw, bh, 0],
      [px + 0.18, -0.19, 0.02], [px + 0.18, 0.23, 0.02],
    ]);
  }

  /** Points of the reading pose (the spread's centre first, its corners, the toolbar's foot). */
  _readOffsets({ dist, drop }, scale) {
    const { eye, fwd } = this._viewerFrame();
    const target = eye.clone().addScaledVector(fwd, dist);
    target.y = eye.y - drop;
    const { w, h } = this.book3d.pageSize;
    const sw = w * scale;
    const sh = (h * scale) / 2;
    const x0 = this._single ? -sw / 2 : -sw; // the right-hand page alone, or both
    const x1 = this._single ? sw / 2 : sw;
    return this._poseOffsets(eye, target, [
      [0, 0, 0], [x0, -sh, 0], [x1, -sh, 0], [x0, sh, 0], [x1, sh, 0],
      [-0.33, -sh - 0.15, 0.05], [0.33, -sh - 0.15, 0.05],
    ]);
  }

  /**
   * Distance from `e` along `o`'s direction to a wall, furniture or a bookcase (Infinity: none).
   * A bookcase counts as a closed box: a book held inside its open front was hidden by its boards.
   */
  _obstacle(e, o) {
    _from.set(e.x, e.y, e.z);
    _toward.set(o.x, o.y, o.z).normalize();
    _ray.set(_from, _toward);
    return Math.min(this.world.raycastSolid(_ray), this.world.shelves.boxDistance(_ray));
  }

  /**
   * Makes room in front of the viewer for something about to be placed there (`offsets`: its
   * points as vectors from the eyes, room-ahead.js): steps the viewer back where something stands
   * too near (and they can stand), and returns how much nearer (k ≤ 1) it must come for the rest.
   */
  async _makeRoom(offsets) {
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const feet = this.controls.viewerPosition(new THREE.Vector3());
    const back = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (back.lengthSq() < 1e-6) back.set(0, 0, -1);
    back.normalize().negate();
    const t0 = performance.now();
    const room = makeRoom({
      eye, feet, dir: back, offsets,
      // In a headset nearer is tiring to focus on; a flat screen can show it close.
      nearest: this.controls.presenting ? 0.25 : 0.12,
      free: (e, o) => this._obstacle(e, o),
      canStand: (x, z) => this.world.isWalkable(x, z),
      inRoom: (x, z) => this.world.room?.walkable(x, z) ?? true,
    });
    perf.event('room', { t: t0, ms: performance.now() - t0, back: room.back, k: room.k });
    if (room.back > 0) await this._stepBack(back.multiplyScalar(room.back));
    return room.k;
  }

  /** Moves the viewer by `delta` (horizontal): a short glide; in a headset a quick fade instead. */
  async _stepBack(delta) {
    const C = this.controls;
    const from = C.viewerPosition(new THREE.Vector3());
    const to = from.clone().add(delta);
    if (C.presenting) {
      await this._fadeTo(1, 0.12);
      C.teleportTo(to);
      await this._fadeTo(0, 0.2);
    } else {
      const at = new THREE.Vector3();
      await this._ease(0.3, (t) => C.teleportTo(at.lerpVectors(from, to, easeInOut(t))));
    }
  }

  /**
   * Brings the book that is out, with its panels, in front of the viewer again (F, a thumbstick
   * press, the help dialog): where it was taken out or opened, room made as then.
   */
  async bookToFront() {
    const state = this.state;
    if ((state !== 'inspect' && state !== 'read') || this._turnBusy || this._following || !this.book3d) return;
    this.state = 'busy';
    this._markLink(null);
    try {
      let target;
      let quat;
      let k;
      if (state === 'inspect') {
        k = await this._makeRoom(this._inspectOffsets(this.book3d.dims));
        ({ target, quat } = this._inspectPose(k));
      } else {
        ({ target, quat, k } = await this._readingTarget());
      }
      await this._fly(this.holder, target, quat, k, 0.4, 0.02);
      if (state === 'read') this._placeReadingPanels(); // a flat screen's toolbar fits its width there
    } finally {
      this.state = state;
    }
  }

  /**
   * A book that is out goes back on its shelf (the browser's Back past the book's entry:
   * back-history.js; Reset view), once what is under way has finished: a book coming out or
   * going in, a link being followed. One being opened is cancelled. Only the book out now: once
   * it is away (a cancelled opening puts it back), a book taken out after is left out.
   */
  async putAway() {
    const away = this._putAways;
    for (let i = 0; i < 400; i++) {
      if (this.state === 'opening') this._cancelOpening?.();
      if (this.state !== 'busy' && this.state !== 'opening' && !this._following) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this._putAways === away && (this.state === 'inspect' || this.state === 'read')) await this.putBack();
  }

  /**
   * Back to the start (Home, the help dialog's Reset view): a book that is out goes back on its
   * shelf, the viewer stands at the entrance looking into the room, level, and the reading
   * distance and size are as they first were.
   */
  async resetView() {
    await this.putAway();
    if (this.state !== 'browse') return;
    this.settings.readDistance = READ.distance;
    this.settings.readScale = 1;
    save('settings', this.settings);
    this._focusSearch(false);
    const { position, yaw } = this.world.spawn;
    this.controls.setViewpoint({ x: position.x, z: position.z, yaw, pitch: 0 });
  }

  /**
   * The toolbar under the page(s) and the contents beside them, on a flat screen kept within its
   * width: the toolbar scaled down (it is wider than a page), the contents over the page when it
   * would be off the screen beside the book (a phone upright).
   */
  _placeReadingPanels() {
    const b3 = this.book3d;
    const s = this._readScale;
    const ph = b3.pageSize.h * s;
    const pw = b3.pageSize.w * s;
    const half = this._viewHalfWidth();
    const ts = Math.min(1, (0.96 * this._viewHalfWidth(0.03)) / (TOOLBAR_W / 2));
    const bar = this.toolbar.mesh;
    bar.scale.setScalar(ts);
    bar.position.set(0, -ph / 2 - 0.085 * ts, 0.03);
    bar.rotation.set(-0.35, 0, 0);
    const toc = this.tocPanel.mesh;
    const beside = (this._single ? -pw / 2 : -pw) - 0.24; // left of the page(s), turned towards the reader
    // On a TV over the page, where the dot is: the remote's ↑ ↓ scroll it and OK picks (useMiddle).
    if (!this.tv && beside - TOC_W / 2 >= -0.98 * half) {
      toc.position.set(beside, 0, 0.08);
      toc.rotation.set(0, 0.45, 0);
      toc.scale.setScalar(1);
    } else {
      toc.position.set(0, 0, 0.06);
      toc.rotation.set(0, 0, 0);
      toc.scale.setScalar(Math.min(1, (0.96 * this._viewHalfWidth(0.06)) / (TOC_W / 2), (0.96 * ph) / TOC_H));
    }
  }

  /**
   * Half the width a flat screen shows at the open book (or `z` in front of it), in the holder's
   * units; Infinity in a headset.
   */
  _viewHalfWidth(z = 0) {
    if (this.controls.presenting) return Infinity;
    const d = this.camera.getWorldPosition(_from).distanceTo(this.holder.position) / this.holder.scale.x;
    return (d - z) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
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
    } else {
      this._placeReadingPanels(); // the toolbar and contents within the screen's width at the new distance
    }
  }

  _adjustScale(delta) {
    if (!this.book3d) return;
    const base = this.book3d.readingScale;
    const rel = Math.max(READ.minScale, Math.min(READ.maxScale, (this._readScale / base) * (1 + delta)));
    this._readScale = base * rel;
    this.book3d.group.scale.setScalar(this._readScale);
    this.book3d.group.position.x = this._bookX(); // the spine (or the page read) stays in front
    this.settings.readScale = rel;
    this._placeReadingPanels();
    this._saveSettingsSoon();
  }

  _saveSettingsSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => save('settings', this.settings), 400);
  }

  // Spreads (reader/spreads.js): { left, right }, each a PageRef, 'ex' (the ex-libris endpaper),
  // 'blank' (the single-page view's left side, not shown) or null. this._single: one page at a time.

  /** The spread with page `ref` on `side` ('left' / 'right'; two pages only), or as the page number pairs it (null). */
  _spreadAt(ref, side = null) {
    return spreadAt(this.reader, ref, { single: this._single, side });
  }

  /** The page of a block anchor { c, b, f? }: f, a place's id (a link's #id), wins when found. */
  async _refFor(reader, at) {
    let b = at.b ?? 0;
    if (at.f) b = (await reader.blockOfId(at.c, at.f)) ?? b;
    return reader.refForAnchor({ c: at.c, b });
  }

  _nextSpread(s) {
    return nextSpread(this.reader, s, { single: this._single });
  }

  _prevSpread(s) {
    return prevSpread(this.reader, s, { single: this._single });
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

  /** Draws a spread on free canvases: { spread, left, right }; one page at a time has no left canvas (none shown). */
  async _renderSpread(spread) {
    const r = this.reader;
    if (this._single) {
      const [rc] = this._freeCanvases(1);
      await (isPage(spread.right) ? r.render(spread.right, rc, { side: 'right' }) : r.renderBlank(rc, { side: 'right' }));
      return { spread, left: null, right: rc };
    }
    const [lc, rc] = this._freeCanvases(2);
    await Promise.all([
      spread.left === 'ex' ? this._drawExLibris(lc) : r.render(spread.left, lc, { side: 'left' }),
      isPage(spread.right) ? r.render(spread.right, rc, { side: 'right' }) : r.renderBlank(rc, { side: 'right' }),
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

  /** Jumps to a page (TOC, slider, recent, a link) with a turn animation in the right direction. */
  async _jump(ref, side = null) {
    if (this.state !== 'read' || this._turnBusy) return;
    this._turnBusy = true;
    try {
      this._prepToken = (this._prepToken || 0) + 1;
      this._next = null;
      this._prev = null;
      const s = await this._spreadAt(ref, side);
      const shown = await this._renderSpread(s);
      const curRef = currentRef(this._cur.spread);
      const r = this.reader;
      const dir = !isPage(curRef) || r.progressOf(ref) >= r.progressOf(curRef) ? 1 : -1;
      this._cur = shown;
      audio.pageTurn();
      await this.book3d.turn(dir, { left: shown.left, right: shown.right });
      this._afterTurn();
    } finally {
      this._turnBusy = false;
    }
  }

  /** The link under a pointer's hit on a page: { link, rect, side } (rect in page pixels), or null. */
  _linkUnder(hit) {
    const r = this.reader;
    const ref = this._cur?.spread?.[hit.side];
    if (!r || !isPage(ref) || !hit.uv || this._turnBusy) return null;
    const found = r.linkAt(ref, hit.uv.x * r.width, (1 - hit.uv.y) * r.height);
    return found && { ...found, side: hit.side };
  }

  /**
   * Where the reader is, to come back to (the trail): the page, and the text view's own place when
   * it is open (`view`, the block at its top: the page may begin blocks before it).
   * @param {{ c: number, b: number } | null} [view]
   */
  _here(view = null) {
    const s = this._cur.spread;
    const side = currentSide(s);
    const page = s[side];
    return {
      libId: this.book.libId, id: this.book.id, at: this.reader.anchorOf(page), side,
      page: { c: page.c, p: page.p }, fontScale: this.reader.fontScale,
      ...(view ? { view: { c: view.c, b: view.b } } : {}),
    };
  }

  /**
   * Follows a link of the open book (SPEC §3.5): `at` is a place in it, `to` one in another of
   * the library's books, `href` is asked of the library first (resolveLink). Where the reader was
   * goes on the trail, for back(): with `view`, the text view's place, which Back brings it to.
   * @param {object} link
   * @param {{ view?: { c: number, b: number } | null }} [options]
   */
  async followLink(link, { view = null } = {}) {
    if (this.state !== 'read' || this._turnBusy || this._following) return;
    this._following = true; // one link at a time: a second tap waits for nothing
    try {
      const book = this.book;
      let dest;
      if (Array.isArray(link.at)) {
        dest = { libId: book.libId, id: book.id, at: { c: link.at[0], b: link.at[1] } };
      } else {
        let to = link.to ?? null;
        if (!to && link.href) {
          this.toolbar.set('label', { text: 'Following…' });
          to = await resolveLink(book.libId, book.id, link.href).catch((err) => {
            console.warn('link', err);
            return null;
          });
          if (this.state !== 'read' || this.book !== book) return; // closed meanwhile
          if (!to) this._afterTurn(); // the label back
        }
        if (!to) {
          this.notice('Not in this library', 'That link leads to a page this file does not have', 3);
          return;
        }
        dest = { libId: book.libId, id: to.book, at: { c: to.c, b: to.b ?? 0, ...(to.f ? { f: to.f } : {}) } };
      }
      audio.click();
      const from = this._here(view);
      this._trail.push(from);
      if (this._trail.length > 100) {
        this._trail.shift();
        this._trailBase++;
      }
      const shown = await this._goTo(dest);
      if (!shown && this._trail.at(-1) === from) this._trail.pop();
      // The browser's Back comes back here too (back-history.js).
      else if (shown) this.backHistory?.pushed(this._trailBase + this._trail.length);
    } finally {
      this._following = false;
      this._showBack();
    }
  }

  /**
   * Back along the links followed (the toolbar's Back, B/Y, Backspace): through the browser's
   * history when the link has an entry there (its popstate comes back as backTo), else at once.
   */
  async goBack() {
    if (this.state !== 'read' || this._turnBusy || this._following || !this._trail.length) return;
    if (this.backHistory?.back()) return;
    this._following = true;
    try {
      await this._goTo(this._trail.pop());
    } finally {
      this._following = false;
      this._showBack();
    }
  }

  /**
   * Back to where the trail was `depth` links deep (the browser's Back, back-history.js): one link
   * back, or several at once. Waits for a link or a page turn in progress.
   * @returns {Promise<boolean>} false when the trail has no such place (the book closed meanwhile)
   */
  async backTo(depth) {
    const i = depth - this._trailBase;
    if (this.state !== 'read' || i < 0 || i >= this._trail.length) return false;
    if (this._following || this._turnBusy) {
      await new Promise((r) => setTimeout(r, 120));
      return this.backTo(depth);
    }
    this._following = true;
    try {
      const dest = this._trail[i];
      this._trail.length = i;
      await this._goTo(dest);
      return true;
    } finally {
      this._following = false;
      this._showBack();
    }
  }

  /**
   * Shows a place { libId, id, at, page?, fontScale?, side?, view? }: in the open book with a turn,
   * in another of the library's books by putting this one back and taking that one out (a Wikipedia
   * volume, a Wikisource work). `page` (a trail's) is used while the font size is the same. A
   * trail's `view` (followed from the text view) is the place while the view is open: it shows
   * that block again, not the page's first, and the 3D book goes there at another font size.
   * @returns {Promise<boolean>} whether the place is shown
   */
  async _goTo(dest) {
    const at = (this.textView?.isOpen && dest.view) || dest.at;
    this.textView?.aim(at); // the text view shows the place, not a spread's left page
    try {
      return await this._goToNow(at === dest.at ? dest : { ...dest, at });
    } finally {
      this.textView?.aim(null);
    }
  }

  async _goToNow(dest) {
    const book = this.book;
    const page = dest.page && dest.fontScale === this.settings.fontScale ? dest.page : null;
    if (dest.libId === book.libId && dest.id === book.id) {
      await this._jump(page ?? await this._refFor(this.reader, dest.at), page ? dest.side : null);
      return true;
    }
    const target = (this.booksByLib[dest.libId] || []).find((b) => b.id === dest.id);
    if (!target) {
      this.notice('Not on the shelves', 'The book that link leads to is not in this library', 3);
      return false;
    }
    await this.putBack({ keepTrail: true });
    if (this.state !== 'browse') return false;
    if (!(await this.ensureShelved(target))) {
      this.overlay?.showToast('That book is not on the shelves.', 'error');
      return false;
    }
    await this.pick(target);
    if (this.state !== 'inspect') return false;
    await this.read({ at: dest.at, page, side: page ? dest.side : null });
    return this.state === 'read';
  }

  /** The toolbar's Back button, shown while there is somewhere to go back to. */
  _showBack() {
    const on = this._trail.length > 0;
    const W = this.toolbar.w;
    const pad = 18;
    this.toolbar.set('back', { hidden: !on });
    this.overlay?.setBookButtons?.({ back: on });
    this.toolbar.set('slider', on ? { x: pad + 146, w: W - 2 * pad - 230 - 136 } : { x: pad + 10, w: W - 2 * pad - 230 });
  }

  /**
   * Translucent bands over the link a pointer is on (found: _linkUnder's), a band per line, on its
   * page: meshes in front of the page, so the page itself is not drawn again. null hides them.
   */
  _markLink(found) {
    const b3 = this.book3d;
    const rects = found && b3 && this.state === 'read' ? found.rects.slice(0, LINK_MARKS) : [];
    if (!this._linkMarks) {
      if (!rects.length) return;
      // One material and geometry for all; a link rarely spans more than LINK_MARKS lines.
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false });
      const geo = new THREE.PlaneGeometry(1, 1);
      this._linkMarks = Array.from({ length: LINK_MARKS }, () => {
        const m = new THREE.Mesh(geo, mat);
        m.name = 'link-mark';
        m.visible = false;
        return m;
      });
    }
    const marks = this._linkMarks;
    for (let i = rects.length; i < marks.length; i++) marks[i].visible = false;
    if (!rects.length) return;
    const page = found.side === 'left' ? b3.leftPage : b3.rightPage;
    const { width: pw, height: ph } = page.geometry.parameters;
    const r = this.reader;
    const pad = 4;
    marks[0].material.color.set(THEMES[r.theme].link);
    rects.forEach(({ x, y, w, h }, i) => {
      const m = marks[i];
      if (m.parent !== page) page.add(m);
      m.scale.set(((w + 2 * pad) / r.width) * pw, ((h + 2 * pad) / r.height) * ph, 1);
      m.position.set(((x + w / 2) / r.width - 0.5) * pw, (0.5 - (y + h / 2) / r.height) * ph, 0.0005);
      m.visible = true;
    });
  }

  async jumpToToc(entry) {
    this.toggleToc(false);
    this.textView?.aim({ c: entry.c, b: entry.b });
    try {
      await this._jump(await this.reader.refForToc(entry));
    } finally {
      this.textView?.aim(null); // not kept for a later turn when the jump was refused
    }
  }

  async jumpToProgress(v) {
    await this._jump(await this.reader.refForProgress(v));
  }

  _currentRef() {
    return currentRef(this._cur?.spread);
  }

  /** After the shown spread changed: toolbar, saved position, recent list, neighbours. */
  _afterTurn() {
    const r = this.reader;
    const ref = this._currentRef();
    if (!r || !ref) return;
    const label = r.labelOf(isPage(this._cur.spread.right) ? this._cur.spread.right : ref);
    this.toolbar.set('label', { text: label });
    this.toolbar.set('slider', { value: r.progressOf(ref) });
    this.toolbar.set('prev', { disabled: this._cur.spread.left === 'ex' });
    const book = this.book;
    save(`pos:${book.libId}:${book.id}`, { ...r.anchorOf(ref), t: Date.now(), label });
    const recent = load('recent', []).filter((e) => !(e.libId === book.libId && e.id === book.id));
    recent.unshift({ libId: book.libId, id: book.id, t: Date.now() });
    save('recent', recent.slice(0, 20));
    this._prepareNeighbours().catch((e) => console.warn('prepare', e));
    this.textView?.follow(); // the text view keeps in step
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

  /** A theme by name (the text view's choice): paper, sepia or night. */
  async setTheme(name) {
    if (this.state !== 'read' || this._turnBusy || !THEME_ORDER.includes(name) || name === this.settings.theme) return;
    this.settings.theme = name;
    save('settings', this.settings);
    this.reader.setTheme(name);
    await this._redraw();
  }

  /** Whether the spread shown holds some of block b of part c (anchor { c, b }). */
  _showsBlock({ c, b }) {
    const s = this._cur?.spread;
    return !!s && [s.left, s.right].some((p) => {
      const on = isPage(p) && p.c === c ? this.reader.blocksOn(p) : null;
      return !!on && on.first <= b && b <= on.last;
    });
  }

  /**
   * Opens the book at a block anchor { c, b } (the text view's place, a part's start), unless the
   * spread shown holds that block already; inPlace: without a turn (the text view covers the
   * book). Whether it moved.
   */
  async jumpToAnchor(anchor, { inPlace = false } = {}) {
    if (this.state !== 'read' || this._turnBusy || this._showsBlock(anchor)) return false;
    const ref = await this.reader.refForAnchor(anchor);
    await (inPlace ? this._jumpInPlace(ref) : this._jump(ref));
    return true;
  }

  async cycleTheme() {
    if (this.state !== 'read' || this._turnBusy) return;
    const t = THEME_ORDER[(THEME_ORDER.indexOf(this.settings.theme) + 1) % THEME_ORDER.length];
    this.settings.theme = t;
    save('settings', this.settings);
    this.reader.setTheme(t);
    await this._redraw();
  }

  /** Whether the single-page view is wanted now: the setting, 'auto' deciding by the screen. */
  _singleWanted(setting = this.settings.pageView) {
    return singlePage(setting, { presenting: this.controls.presenting, aspect: this.camera.aspect });
  }

  /** The toolbar's button names the other view. */
  _showPagesButton() {
    this.toolbar.set('pages', { label: this._single ? '2 pages' : '1 page' });
    this.overlay?.setBookButtons?.({ pages: this._single ? '2 pages' : '1 page' });
  }

  /**
   * One page at a time or two (the toolbar's button, P): the other view, at the page being read.
   * Kept as the setting, or as 'auto' when it is what 'auto' gives on this screen.
   */
  async togglePages() {
    if (this.state !== 'read' || this._turnBusy) return;
    const single = !this._single;
    this.settings.pageView = pageViewSetting(single, this._singleWanted('auto'));
    save('settings', this.settings);
    await this._showSingle(single);
  }

  /** Shows the open book one page (single) or two at a time, at the page being read. */
  async _showSingle(single) {
    if (this.state !== 'read' || this._turnBusy || single === this._single) return;
    this.state = 'busy';
    this._markLink(null);
    try {
      const ref = this._currentRef();
      this._single = single;
      this._showPagesButton();
      audio.click();
      this.book3d.setSingle(single);
      await this._jumpInPlace(ref);
      await this._reframe();
    } finally {
      this.state = 'read';
    }
  }

  /**
   * After the view changed: the book slides so the page read is in front (_bookX), and on a flat
   * screen comes to where it fits again (a headset keeps where it was put).
   */
  async _reframe() {
    const g = this.book3d.group;
    const from = g.position.x;
    const to = this._bookX();
    const moves = [this._ease(0.35, (t) => { g.position.x = from + (to - from) * easeInOut(t); })];
    if (!this.controls.presenting) {
      const { target, quat, k } = await this._readingTarget();
      moves.push(this._fly(this.holder, target, quat, k, 0.35, 0));
    }
    await Promise.all(moves);
    this._placeReadingPanels();
  }

  /** The screen changed shape (main.js): an open book follows 'auto' (one page upright, two across). */
  onResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this.state === 'read' && !this.controls.presenting && this._singleWanted() !== this._single) {
        this._showSingle(!this._single).catch((e) => console.warn('pages', e));
      }
    }, 300);
  }

  /**
   * Re-renders the current position without a turn animation (font / theme changes): the spread
   * of `ref`, or `spread` as it is (_redraw).
   */
  async _jumpInPlace(ref, spread = null) {
    this._turnBusy = true;
    try {
      this._prepToken = (this._prepToken || 0) + 1;
      this._next = null;
      this._prev = null;
      const shown = await this._renderSpread(spread ?? await this._spreadAt(ref));
      this._cur = shown;
      this.book3d.setPages(shown.left, shown.right);
      this._afterTurn();
    } finally {
      this._turnBusy = false;
    }
  }

  /**
   * Draws the spread shown again, its pages as they are (a theme changed: nothing moves). Found
   * again from the page read they could pair otherwise, since spreadAt pairs pages by their number
   * and the numbers before the part read are estimates until its layout is in: a theme and then
   * another stood the book a page back each time, behind the text view too.
   */
  _redraw() {
    return this._jumpInPlace(null, this._cur.spread);
  }

  toggleToc(show = !this.tocPanel.visible) {
    if (show) this._fillToc();
    this.tocPanel.visible = show && this.state === 'read';
    this.toolbar.set('toc', { active: this.tocPanel.visible });
    this.overlay?.setBookButtons?.({ toc: this.tocPanel.visible });
  }

  /** Closes the book and puts it back on the shelf. */
  async closeBook() {
    if (this.state !== 'read') return;
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
    if (this._kiwixView?.view) this._kiwixView.stale = true; // Kiwix's list: its Open marks and index labels
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
      // A room with no books yet because its libraries are being indexed says so.
      const emptyText = !collections.length && this.libraries.some((l) => l.indexing)
        ? ['Indexing…', 'The shelves fill as each library is ready'] : null;
      const built = this.world.build(collections, { sort: this.settings.sort, emptyText });
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
      this.onShelved?.(this.settings.place, collections.length === 1 ? collections[0].room : null);
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

  /** Article search result: take its Wikipedia volume off the shelf and open it at the article. */
  async openArticle(libId, bookId, n) {
    if (this.state === 'inspect' || this.state === 'read') await this.putBack();
    if (this.state !== 'browse') return;
    const book = (this.booksByLib[libId] || []).find((b) => b.id === bookId);
    if (!book || !(await this.ensureShelved(book))) {
      this.overlay?.showToast('That volume is not on the shelves.', 'error');
      return;
    }
    this.showBook(book);
    await this._tween(0.4, () => {});
    await this.pick(book);
    if (this.state === 'inspect') await this.read({ at: { c: n, b: 0 } });
  }

  /**
   * A short message floating in front of the viewer for `seconds`: unlike the DOM overlay's
   * toasts, it shows in the headset too.
   */
  notice(title, sub = '', seconds = 4) {
    if (!this._notice) {
      this._notice = new Label({ width: 0.8, height: 0.16 });
      this._notice.mesh.name = 'notice';
      this._notice.mesh.position.set(0, -0.08, -1.1); // head-locked, a little below the eyes
      this.camera.add(this._notice.mesh);
    }
    this._notice.setText(title, sub);
    this._notice.visible = true;
    this._noticeUntil = this._time + seconds;
  }

  /** Search result: go there and highlight it; take it out (by default on non-XR). */
  async searchPick(book, { take = !this.controls.presenting } = {}) {
    if (this.state === 'inspect' || this.state === 'read') await this.putBack();
    if (this.state !== 'browse') return;
    if (!(await this.ensureShelved(book))) {
      this.overlay?.showToast('That book is not on the shelves.', 'error');
      return;
    }
    this.showBook(book);
    if (take) {
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

  /** The shared session changed (together.js): the kiosk's line about it. */
  sessionChanged() {
    if (this._kioskTab !== 'shelves' || this._resetForm) return;
    const shown = !!this.kiosk.get('session-text');
    if (shown !== !!this.together?.room) this._fillKiosk();
    else if (shown) this.kiosk.set('session-text', { text: this._sessionText() });
  }

  _sessionText() {
    const t = this.together;
    return sessionText({ room: t.room, active: t.active, company: t.active ? t.company() : {} });
  }

  /** Motion as the system prefers, less, or full (common's access.js `motion`). */
  toggleMotion() {
    this.setAccess({ ...this.access, motion: nextMotion(this.access.motion) });
  }

  /** The comfort vignette while moving or turning smoothly in VR, or none. */
  toggleVignette() {
    this.setAccess({ ...this.access, vignette: !this.access.vignette });
  }

  /** Seated: the eye 0.45 m higher in VR (common's eyeLift), or standing. */
  toggleSeated() {
    this.setAccess({ ...this.access, seated: !this.access.seated });
  }

  /**
   * The accessibility settings: kept where every site reads them (common's saveAccess,
   * `hallway.access`) unless they came from there, and applied (_applyAccess).
   * @param {{ motion?: string, vignette?: boolean, seated?: boolean }} access
   * @param {{ store?: boolean }} [o] store: false when they came from storage
   */
  setAccess(access, { store = true } = {}) {
    this.access = normalizeAccess(access);
    if (store) saveAccess(this.access); // false without storage: this visit only
    this._applyAccess();
  }

  /**
   * Applies the settings, and the system's preference when motion follows it (main.js calls this
   * again when that changes): less motion here and in the world (the door's shimmer held), the
   * vignette and the eye height in the controls, and both menus.
   */
  _applyAccess() {
    this.reduced = reduceMotion(this.access);
    this.world.reducedMotion = this.reduced;
    if (this.together) this.together.reduceMotion = this.reduced; // a visitor's wave without the bob
    this.controls.setAccess?.(this.access);
    this.overlay?.setAccess?.(this.access);
    if (this.kiosk) {
      const b = comfortButtons(this.access, this.reduced);
      this.kiosk.set('motion', b.motion);
      this.kiosk.set('vignette', b.vignette);
      this.kiosk.set('seated', b.seated);
    }
  }

  /** Walking with the stick, or teleporting only (nav.js: the Hallway's `move`). */
  toggleSmooth() {
    this.setNav({ ...this.nav, move: this.nav.move === 'smooth' ? 'teleport' : 'smooth' });
  }

  /** Turning in steps, or smoothly while the stick is held (nav.js: the Hallway's `turn`). */
  toggleTurn() {
    this.setNav({ ...this.nav, turn: this.nav.turn === 'snap' ? 'smooth' : 'snap' });
  }

  /**
   * How to move and turn in VR: to the controls, the kiosk, the Hallway's key (nav.js), and
   * `settings.smoothMove` (older pages and debug reports read it).
   * @param {{ move: string, turn: string }} nav
   * @param {{ store?: boolean }} [o] store: false when it came from storage
   */
  setNav(nav, { store = true } = {}) {
    this.nav = { move: nav.move === 'teleport' ? 'teleport' : 'smooth', turn: nav.turn === 'smooth' ? 'smooth' : 'snap' };
    this.controls.setNav(this.nav);
    if (store) {
      saveNav(this.nav); // false without storage: this visit only
    }
    if (this.settings.smoothMove !== (this.nav.move === 'smooth')) {
      this.settings.smoothMove = this.nav.move === 'smooth';
      save('settings', this.settings);
    }
    this.kiosk.set('smooth', this._moveButton());
    this.kiosk.set('turn', this._turnButton());
  }

  _moveButton() {
    const smooth = this.nav.move === 'smooth';
    return { label: smooth ? 'Stick walking' : 'Teleport only', active: smooth };
  }

  _turnButton() {
    const snap = this.nav.turn === 'snap';
    return { label: snap ? 'Snap turning' : 'Smooth turning', active: !snap };
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
    // With less motion a blink: dark (or clear) at once.
    if (!this.reduced) await this._tween(duration, (t) => { m.material.opacity = from + (target - from) * t; });
    m.material.opacity = target;
    m.visible = target > 0;
  }

  // ===========================================================================================
  // The way out: the door back (world/door.js) and the stand's button

  /**
   * Goes out by the way out (this.wayOut: the Hallway, or the place that linked here): the view
   * fades, then onHallway (main.js) goes there. In VR, Quest Browser keeps the visitor in VR there
   * when it is on this origin (SPEC §5.7).
   */
  async leave() {
    if (this._leaving || !this.onHallway || this.state !== 'browse') return;
    this._leaving = true;
    this.state = 'busy';
    this.onLeaving?.(); // main.js: out of the shared session now, so the others see it at once
    await this._fadeTo(1, this.controls.presenting ? 0.3 : 0.4);
    this.onHallway();
    // Still here a while later (the navigation was stopped, or failed): back in the room.
    clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => this.cameBack(), 12000);
  }

  /**
   * Back from the way out without having left (a navigation that did not happen, or the browser's
   * Back restoring this page from its cache: main.js, pageshow): in front of the door, facing the
   * room, out of the dark.
   */
  cameBack() {
    if (!this._leaving) return;
    clearTimeout(this._leaveTimer);
    this._leaving = false;
    this.onCameBack?.(); // main.js: back in the shared session
    const spot = this.world.door?.inFront(1.1);
    if (spot) this.controls.teleportTo(spot.position, spot.yaw);
    this.state = 'browse';
    this._fadeTo(0, 0.6);
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
    if (this._opening) this._showOpening(this._opening);
    this._updateExitHold(dt);

    if (this._grab) {
      const p = this._grab.pointer.object3D;
      p.updateMatrixWorld(true);
      const m = p.matrixWorld.clone().multiply(this._grab.offset);
      m.decompose(this.holder.position, this.holder.quaternion, new THREE.Vector3());
    }

    // Pointer hover. Per-frame code allocates as little as it can: garbage collection pauses were
    // most of the dropped frames on a Quest.
    let hoverBook = null;
    let hoverLink = null;
    let hoverDoor = false;
    let dotPanel = null;
    let dotList = null;
    for (const pointer of this.controls.pointers) {
      const hit = this.state === 'busy' || pointer.teleporting ? null : this._hitTest(pointer);
      pointer.setHitDistance(hit ? hit.distance : null);
      const prev = this._hover.get(pointer.id);
      if (prev && prev !== hit?.panel) prev.pointerLeave();
      let interactive = false;
      if (hit?.kind === 'panel') {
        interactive = hit.panel.pointerMove(hit.uv.x, hit.uv.y);
        // A TV's dot on a list that scrolls: the remote's ↑ ↓ are its (scrollUnderDot).
        const el = this.tv && pointer.id === 'gamepad' ? hit.panel.hover : null;
        if (el && hit.panel.scrolls(el) && (this.state !== 'browse' || hit.distance <= TV_REACH)) {
          dotPanel = hit.panel;
          dotList = el;
        }
      } else if (hit?.kind === 'book') {
        hoverBook = hit.book;
        interactive = true;
      } else if (hit?.kind === 'door') {
        hoverDoor = true;
        interactive = true;
      } else if (hit?.kind === 'page' || hit?.kind === 'held') {
        interactive = true;
        if (hit.kind === 'page' && !hoverLink) hoverLink = this._linkUnder(hit);
      }
      pointer.setHovering(interactive);
      this._hover.set(pointer.id, hit?.kind === 'panel' ? hit.panel : null);
    }
    this._markLink(hoverLink);
    if (dotList !== this._dotList) {
      this._dotPanel = dotPanel;
      this._dotList = dotList;
      this.onDotList?.(!!dotList);
    }
    // A TV's dot: while walking the room or holding a book, and on the contents of one being read.
    if (this.tv) this.controls.aimShown = !this.inCard && !this.textView?.isOpen && (this.state !== 'read' || this.tocPanel.visible);
    const door = this.world.door;
    if (door) {
      door.hover = hoverDoor;
      // Walked (or leant) through the doorway: out.
      if (this.state === 'browse' && !this._leaving && door.crossed(this.camera.getWorldPosition(_head).x, _head.z)) this.leave();
    }
    this.controls.textEntry = !!this._search.focus && this.state === 'browse' && this._kioskTab === 'search'
      && this.kiosk.visible && !this.controls.presenting;
    // A scroll bar being dragged follows its pointer, also off the panel (onto its plane).
    if (this._panelDrag) {
      const { pointer, panel } = this._panelDrag;
      if (!panel.visible || !this.controls.pointers.includes(pointer)) this._endPanelDrag();
      else {
        const uv = panelUv(panel, pointer.raycaster.ray);
        if (uv) panel.dragTo(uv.x, uv.y);
      }
    }
    if (this.state === 'browse') {
      // A book highlighted by a jump/search stays highlighted for a few seconds even though the
      // ray (which, after a teleport, usually points at the shelf) hovers other books.
      if (this._highlightUntil <= this._time) this._setHover(hoverBook);
    } else if (this._hoveredBook) {
      this._setHover(null, true);
    }
    if (this.tooltip.visible) this.camera.getWorldQuaternion(this.tooltip.mesh.quaternion);

    for (const p of this._panels) if (p.visible) p.update();
    if (this.tooltip.visible) this.tooltip.panel.update();
    if (this._notice?.visible && this._time >= this._noticeUntil) this._notice.visible = false;
  }
}

