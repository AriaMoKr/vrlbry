// BookReader (SPEC §5.2): loads a book's chunks on demand, paginates each chunk independently
// with layout.js and renders pages onto a canvas (used as a texture on the 3D book's pages).
//
// Pages are addressed as PageRef { c: chunk, p: page within chunk } because page counts are only
// known for chunks laid out so far. Durable positions use block anchors { c, b }.

import { getBookMeta, getChunk, forgetBook } from '../api.js';
import { PAGE_PX } from '../config.js';
import { perf } from '../perf.js';
import { makeMetrics, ChunkLayout, getMeasurer, FONTS, blockChars } from './layout.js';

export const THEMES = {
  paper: { paper: '#f6efdf', ink: '#231d16', light: '#8a7a62', rule: '#b9a78a', grain: 0.045, vignette: 'rgba(120,90,40,0.16)', img: 1 },
  sepia: { paper: '#ecdcbc', ink: '#3b2a17', light: '#8c714b', rule: '#a68a5f', grain: 0.06, vignette: 'rgba(110,70,20,0.22)', img: 0.95 },
  night: { paper: '#24221f', ink: '#d9d0c0', light: '#8d8473', rule: '#5f574b', grain: 0.05, vignette: 'rgba(0,0,0,0.35)', img: 0.82 },
};

const LAYOUT_CACHE = 16;    // chunk layouts kept per reader (Webster's has ~800 chunks)
const IMAGE_TIMEOUT = 8000;
// Layout work per step. Laying out a 240,000-character Wikipedia article in one go blocked a
// Quest 3 for 370 ms; in steps, its first pages show at once and the rest follows between frames.
const LAYOUT_STEP_MS = 4;

/** Lets the browser render frames and handle input between layout steps. */
const breathe = () => new Promise((r) => setTimeout(r, 0));

/**
 * One chunk being laid out a step at a time. `pages` holds the pages decided so far; `page(p)`
 * and `complete()` wait for more.
 */
class ProgressiveLayout {
  constructor(blocks, metrics, stepMs = LAYOUT_STEP_MS) {
    this.blocks = blocks;
    this.stepMs = stepMs;
    this._layout = new ChunkLayout(blocks, metrics, getMeasurer());
    this.pages = this._layout.pages;
    this.done = false;
    this.cancelled = false;
    this.ms = 0; // layout time so far
    this.steps = 0;
    this.started = 0;
    this._waiters = [];
  }

  /** Lays out the chunk in steps; the first step runs at once. */
  async run(onDone) {
    this.started = performance.now();
    while (!this.cancelled) {
      const t0 = performance.now();
      this.done = this._layout.step(this.stepMs);
      this.ms += performance.now() - t0;
      this.steps++;
      if (this.done) onDone?.(this);
      this._wake();
      if (this.done) return;
      await breathe();
    }
  }

  /** Stops laying out (the book closed, or the font size changed); waiters get what exists. */
  cancel() {
    this.cancelled = true;
    this._wake();
  }

  /** Page p once it is decided, or null when the chunk has fewer pages. */
  async page(p) {
    while (p >= this.pages.length && !this.done && !this.cancelled) await this._step();
    return this.pages[p] ?? null;
  }

  /** Resolves when the whole chunk is laid out. */
  async complete() {
    while (!this.done && !this.cancelled) await this._step();
    return this;
  }

  _step() {
    return new Promise((r) => this._waiters.push(r));
  }

  _wake() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const r of waiters) r();
  }
}

const imageCache = new Map(); // src -> Promise<HTMLImageElement|null>

/** Loads an image once; resolves null on error or timeout (never rejects). */
function loadImage(src) {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      const timer = setTimeout(() => resolve(null), IMAGE_TIMEOUT);
      // Decoded before use, off the main thread: otherwise the page's drawImage decodes it there.
      img.onload = () => img.decode().catch(() => {}).then(() => { clearTimeout(timer); resolve(img); });
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
    imageCache.set(src, p);
    p.then((img) => { if (!img) imageCache.delete(src); }); // allow a retry later
    if (imageCache.size > 400) imageCache.delete(imageCache.keys().next().value);
  }
  return p;
}

const backgrounds = new Map(); // `${theme}|${w}x${h}` -> canvas

/** Paper background with grain and vignette, rendered once per theme and size. */
function paperBackground(themeName, w, h) {
  const key = `${themeName}|${w}x${h}`;
  let c = backgrounds.get(key);
  if (c) return c;
  const t = THEMES[themeName] || THEMES.paper;
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = t.paper;
  g.fillRect(0, 0, w, h);
  // Grain: a small noise tile repeated (cheap, and no visible pattern at this density).
  const tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const tg = tile.getContext('2d');
  const id = tg.createImageData(128, 128);
  let seed = 1234567;
  for (let i = 0; i < id.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = (seed >> 16) & 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  tg.putImageData(id, 0, 0);
  g.globalAlpha = t.grain;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(tile, 'repeat');
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  const r = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  r.addColorStop(0, 'rgba(0,0,0,0)');
  r.addColorStop(1, t.vignette);
  g.fillStyle = r;
  g.fillRect(0, 0, w, h);
  backgrounds.set(key, c);
  return c;
}

export class BookReader {
  /**
   * @param {object} o
   * @param {string} o.libId
   * @param {object} o.book book descriptor (needs id, title)
   * @param {number} [o.width] page canvas width
   * @param {number} [o.height] page canvas height
   * @param {number} [o.fontScale]
   * @param {'paper'|'sepia'|'night'} [o.theme]
   * @param {number} [o.layoutStepMs] layout work per step (tests use 0: one block per step)
   */
  constructor({ libId, book, width = PAGE_PX.w, height = PAGE_PX.h, fontScale = 1, theme = 'paper', layoutStepMs = LAYOUT_STEP_MS }) {
    this.libId = libId;
    this.book = book;
    this.width = width;
    this.height = height;
    this.fontScale = fontScale;
    this.theme = THEMES[theme] ? theme : 'paper';
    this.meta = null;
    this.metrics = makeMetrics({ width, height, fontScale });
    this.layoutStepMs = layoutStepMs;
    this._layouts = new Map(); // chunk -> Promise<Page[]> (insertion order = LRU order)
    this._pageCounts = new Map(); // chunk -> page count, survives layout eviction
    this._loading = null;
    this.stats = { lastLayoutMs: 0, lastRenderMs: 0 };
  }

  /** Fetches reading metadata (chunks, toc). Idempotent. */
  async load() {
    if (!this._loading) {
      this._loading = getBookMeta(this.libId, this.book.id).then((meta) => {
        this.meta = meta;
        return meta;
      });
      this._loading.catch(() => { this._loading = null; });
    }
    return this._loading;
  }

  get chunkCount() {
    return this.meta ? this.meta.chunks.length : 0;
  }

  firstRef() {
    return { c: 0, p: 0 };
  }

  /**
   * Chunk c's layout (cached, LRU), started as soon as the chunk arrives. Its `pages` are only
   * those decided so far: wait with `page(p)` or `complete()`.
   * @returns {Promise<ProgressiveLayout>}
   */
  _layout(c) {
    const key = c;
    let p = this._layouts.get(key);
    if (p) {
      this._layouts.delete(key);
      this._layouts.set(key, p);
      return p;
    }
    const fontScale = this.fontScale;
    const metrics = this.metrics;
    p = (async () => {
      await this.load();
      const blocks = await getChunk(this.libId, this.book.id, c);
      if (this.meta.lazy) this._exactChars(c, blocks);
      // Images without known size: load them first so the layout is exact.
      const missing = blocks.filter((b) => b.t === 'img' && !(b.w && b.h) && !b._w);
      if (missing.length) {
        await Promise.all(missing.map(async (b) => {
          const img = await loadImage(b.src);
          b._w = img ? img.naturalWidth : 400;
          b._h = img ? img.naturalHeight : 300;
        }));
      }
      const L = new ProgressiveLayout(blocks, metrics, this.layoutStepMs);
      if (this._disposed || fontScale !== this.fontScale) {
        L.cancel(); // nobody will read it
        return L;
      }
      this._remember(c, L);
      L.run((done) => {
        this.stats.lastLayoutMs = done.ms;
        perf.event('layout', {
          t: done.started, ms: performance.now() - done.started, workMs: done.ms, steps: done.steps,
          chunk: c, blocks: blocks.length, pages: done.pages.length,
        });
        if (fontScale === this.fontScale) this._pageCounts.set(c, done.pages.length);
      });
      return L;
    })();
    p.catch(() => { if (this._layouts.get(key) === p) this._layouts.delete(key); });
    this._layouts.set(key, p);
    while (this._layouts.size > LAYOUT_CACHE) this._layouts.delete(this._layouts.keys().next().value);
    // Warm the network cache for the next chunk (layout stays lazy).
    if (this.meta && c + 1 < this.meta.chunks.length) getChunk(this.libId, this.book.id, c + 1).catch(() => {});
    return p;
  }

  /**
   * A lazy book's chunk sizes (Wikipedia volumes: one article per chunk) are estimates until the
   * chunk arrives: replace one with its real character count, shifting the later starts. Only
   * page-number estimates and progress move; positions are anchored by block.
   */
  _exactChars(c, blocks) {
    const ch = this.meta.chunks[c];
    if (ch.exact) return;
    const chars = blocks.reduce((sum, b) => sum + blockChars(b), 0);
    const delta = chars - ch.chars;
    ch.chars = chars;
    ch.exact = true;
    for (let i = c + 1; i < this.meta.chunks.length; i++) this.meta.chunks[i].start += delta;
    this.meta.totalChars += delta;
  }

  _clampRef(ref) {
    const c = Math.max(0, Math.min(this.chunkCount - 1, ref?.c | 0));
    return { c, p: Math.max(0, ref?.p | 0) };
  }

  /** Next page, or null at the end of the book. */
  async next(ref) {
    await this.load();
    const { c, p } = this._clampRef(ref);
    const L = await this._layout(c);
    if (await L.page(p + 1)) return { c, p: p + 1 };
    if (c + 1 < this.chunkCount) return { c: c + 1, p: 0 };
    return null;
  }

  /** Previous page, or null at the start. */
  async prev(ref) {
    await this.load();
    const { c, p } = this._clampRef(ref);
    if (p > 0) return { c, p: p - 1 };
    if (c > 0) {
      const L = await (await this._layout(c - 1)).complete();
      return { c: c - 1, p: Math.max(0, L.pages.length - 1) };
    }
    return null;
  }

  /** Resolves a ref to its chunk layout and page (clamping p to the chunk's page count). */
  async _page(ref) {
    const r = this._clampRef(ref);
    const L = await this._layout(r.c);
    let p = r.p;
    let page = await L.page(p);
    if (!page) {
      p = Math.max(0, L.pages.length - 1);
      page = L.pages[p] ?? null;
    }
    return { L, page, ref: { c: r.c, p } };
  }

  /** The decided page of a remembered layout nearest to ref, or null. */
  _knownPage(r) {
    const known = this._settled?.get(r.c);
    return known?.pages[Math.min(r.p, known.pages.length - 1)] ?? null;
  }

  /** First block of the page as a durable anchor. */
  anchorOf(ref) {
    const r = this._clampRef(ref);
    const page = this._knownPage(r);
    return { c: r.c, b: page ? page.firstBlock : 0 };
  }

  /** Page containing the start of block b of chunk c. */
  async refForAnchor(anchor) {
    await this.load();
    const c = Math.max(0, Math.min(this.chunkCount - 1, anchor?.c | 0));
    const b = Math.max(0, anchor?.b | 0);
    const L = await this._layout(c);
    let p = 0;
    for (let i = 0; ; i++) {
      const page = await L.page(i);
      if (!page || page.firstBlock > b) break;
      if (page.firstBlock < b || page.firstLine === 0) p = i;
    }
    return { c, p };
  }

  refForToc(entry) {
    return this.refForAnchor({ c: entry.c, b: entry.b });
  }

  /** Page at a fraction (0..1) of the book's characters. */
  async refForProgress(fraction) {
    const meta = await this.load();
    const target = Math.max(0, Math.min(1, fraction)) * meta.totalChars;
    let c = meta.chunks.length - 1;
    for (let i = 0; i < meta.chunks.length; i++) {
      if (target < meta.chunks[i].start + meta.chunks[i].chars) { c = i; break; }
    }
    const L = await this._layout(c);
    const local = target - meta.chunks[c].start;
    let p = 0;
    for (let i = 0; ; i++) {
      const page = await L.page(i);
      if (!page || page.charStart > local) break;
      p = i;
    }
    return { c, p };
  }

  /** 0..1 by characters (exact for laid-out chunks, chunk start otherwise). */
  progressOf(ref) {
    if (!this.meta || !this.meta.totalChars) return 0;
    const r = this._clampRef(ref);
    const ch = this.meta.chunks[r.c];
    const page = this._knownPage(r);
    let local = 0;
    if (page) {
      local = page.charStart;
    } else {
      const n = this._pageCounts.get(r.c);
      if (n) local = (ch.chars * r.p) / n;
    }
    return Math.min(1, (ch.start + local) / this.meta.totalChars);
  }

  _charsPerPage() {
    let chars = 0;
    let pages = 0;
    for (const [c, n] of this._pageCounts) {
      chars += this.meta.chunks[c].chars;
      pages += n;
    }
    if (pages >= 2) return chars / pages;
    const M = this.metrics;
    return (M.textWidth / (M.size * 0.47)) * (M.textHeight / M.lineHeight) * 0.85;
  }

  /** 1-based page number from the book start, and whether it is estimated. */
  pageNumber(ref) {
    const r = this._clampRef(ref);
    let n = 0;
    let estimated = false;
    const cpp = this._charsPerPage();
    for (let i = 0; i < r.c; i++) {
      const known = this._pageCounts.get(i);
      if (known != null) n += known;
      else {
        n += Math.max(1, Math.round(this.meta.chunks[i].chars / cpp));
        estimated = true;
      }
    }
    return { n: n + r.p + 1, estimated };
  }

  /** Total pages (estimated unless every chunk has been laid out). */
  totalPages() {
    if (!this.meta) return { n: 0, estimated: true };
    const last = this.meta.chunks.length - 1;
    const { n, estimated } = this.pageNumber({ c: last, p: 0 });
    const lastCount = this._pageCounts.get(last);
    return {
      n: n - 1 + (lastCount ?? Math.max(1, Math.round(this.meta.chunks[last].chars / this._charsPerPage()))),
      estimated: estimated || lastCount == null,
    };
  }

  /** Human label, e.g. "12 / ≈340". */
  labelOf(ref) {
    if (!this.meta) return '';
    const cur = this.pageNumber(ref);
    const tot = this.totalPages();
    return `${cur.estimated ? '≈' : ''}${cur.n} / ${tot.estimated ? '≈' : ''}${Math.max(tot.n, cur.n)}`;
  }

  setFontScale(s) {
    if (s === this.fontScale) return;
    this.fontScale = s;
    this.metrics = makeMetrics({ width: this.width, height: this.height, fontScale: s });
    this._cancelLayouts();
    this._pageCounts.clear();
  }

  /** Forgets every layout, stopping those still in progress. */
  _cancelLayouts() {
    for (const p of this._layouts.values()) p.then((L) => L.cancel(), () => {});
    this._layouts.clear();
    this._settled?.clear();
  }

  setTheme(name) {
    if (THEMES[name]) this.theme = name;
  }

  /** Paper background only (e.g. the blank left side of the first spread). */
  async renderBlank(canvas, { side = null } = {}) {
    const g = this._prepare(canvas);
    g.drawImage(paperBackground(this.theme, this.width, this.height), 0, 0);
    this._gutter(g, side);
  }

  /**
   * Draws page `ref` onto `canvas` (resized to the page size if needed).
   * @param {{ side?: 'left'|'right'|null }} [opts] side adds the gutter shadow at the spine edge
   */
  async render(ref, canvas, { side = null } = {}) {
    const { L, page, ref: r } = await this._page(ref);
    if (!page) return this.renderBlank(canvas, { side }); // the layout was cancelled
    this._remember(r.c, L);
    // Load this page's images before drawing so a page is never half-painted.
    const imgs = new Map();
    await Promise.all(page.boxes.flatMap(({ box }) => box.items.filter((it) => it.k === 'img'))
      .map(async (it) => imgs.set(it.src, await loadImage(it.src))));

    const t0 = performance.now();
    const t = THEMES[this.theme];
    const M = this.metrics;
    const g = this._prepare(canvas);
    g.drawImage(paperBackground(this.theme, this.width, this.height), 0, 0);
    this._gutter(g, side);

    // Running header: title in small capitals, light.
    const title = (this.book.title || this.meta?.title || '').toUpperCase();
    g.fillStyle = t.light;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = `${Math.round(19 * M.k)}px ${FONTS.serif}`;
    g.fillText(ellipsize(g, title, M.textWidth * 0.8), this.width / 2, M.headerY);
    // Footer: page number.
    const num = this.pageNumber(r);
    g.font = `${Math.round(21 * M.k)}px ${FONTS.serif}`;
    g.fillText(`${num.estimated ? '≈ ' : ''}${num.n}`, this.width / 2, M.footerY);

    g.textAlign = 'left';
    g.save();
    g.beginPath();
    g.rect(M.marginX - 4, M.top - M.size, M.textWidth + 8, M.textHeight + M.size * 1.4);
    g.clip();
    g.translate(M.marginX, M.top);
    let font = '';
    g.fillStyle = t.ink;
    g.strokeStyle = t.rule;
    let images = 0;
    let imageMs = 0;
    for (const { y, box } of page.boxes) {
      for (const it of box.items) {
        if (it.k === 't') {
          if (it.font !== font) {
            g.font = it.font;
            font = it.font;
          }
          g.fillText(it.text, it.x, y + it.y);
          if (it.u) g.fillRect(it.x, y + it.y + 3 * M.k, it.u, Math.max(1, 1.2 * M.k));
        } else if (it.k === 'rule') {
          g.fillStyle = t.rule;
          g.fillRect(it.x, y + it.y - it.lw / 2, it.w, it.lw);
          g.fillStyle = t.ink;
        } else if (it.k === 'img') {
          const img = imgs.get(it.src);
          if (img) {
            const ti = performance.now();
            g.globalAlpha = t.img;
            // Black-on-transparent images (formulas) would vanish on dark paper.
            const invert = it.inv && this.theme === 'night';
            if (invert) g.filter = 'invert(1)';
            g.drawImage(img, it.x, y + it.y, it.w, it.h);
            if (invert) g.filter = 'none';
            g.globalAlpha = 1;
            imageMs += performance.now() - ti;
            images++;
          } else {
            this._placeholder(g, it, y);
            font = '';
          }
        }
      }
    }
    g.restore();
    this.stats.lastRenderMs = performance.now() - t0;
    perf.event('render', { t: t0, ms: this.stats.lastRenderMs, imageMs, images, chunk: r.c, page: r.p });
  }

  _placeholder(g, it, y) {
    const t = THEMES[this.theme];
    const M = this.metrics;
    g.save();
    g.strokeStyle = t.rule;
    g.lineWidth = Math.max(1, 1.5 * M.k);
    g.setLineDash([8 * M.k, 6 * M.k]);
    g.strokeRect(it.x, y + it.y, it.w, it.h);
    g.fillStyle = t.light;
    g.font = `italic ${Math.round(M.size * 0.8)}px ${FONTS.serif}`;
    g.textAlign = 'center';
    g.fillText(ellipsize(g, it.alt || 'image unavailable', it.w - 16), it.x + it.w / 2, y + it.y + it.h / 2);
    g.restore();
  }

  _prepare(canvas) {
    if (canvas.width !== this.width) canvas.width = this.width;
    if (canvas.height !== this.height) canvas.height = this.height;
    return canvas.getContext('2d');
  }

  _gutter(g, side) {
    if (!side) return;
    const w = this.width * 0.09;
    const night = this.theme === 'night';
    const x0 = side === 'left' ? this.width : 0;
    const grad = g.createLinearGradient(x0, 0, side === 'left' ? this.width - w : w, 0);
    grad.addColorStop(0, night ? 'rgba(0,0,0,0.45)' : 'rgba(70,45,10,0.28)');
    grad.addColorStop(0.35, night ? 'rgba(0,0,0,0.12)' : 'rgba(70,45,10,0.08)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(side === 'left' ? this.width - w : 0, 0, w, this.height);
  }

  /** Keeps resolved layouts addressable synchronously (anchorOf/progressOf are sync). */
  _remember(c, L) {
    if (!this._settled) this._settled = new Map();
    this._settled.delete(c);
    this._settled.set(c, L);
    while (this._settled.size > LAYOUT_CACHE) this._settled.delete(this._settled.keys().next().value);
  }

  dispose() {
    this._disposed = true;
    this._cancelLayouts();
    forgetBook(this.libId, this.book.id);
  }
}

function ellipsize(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}
