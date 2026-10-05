// Text layout engine for book pages (SPEC §5.2). Pure: blocks (§3.5) + metrics + a text
// measurer in, pages of positioned draw items out. Rendering a page is then just drawing items,
// so pagination is deterministic for a given (chunk, size, fontScale).
//
// Pipeline per chunk: blocks → "boxes" (unbreakable vertical units: one text line, one image,
// one table row …, each with spacing and keep rules) → pages (boxes with y offsets).

export const STYLE = Object.freeze({
  ITALIC: 1, BOLD: 2, MONO: 4, SUP: 8, SUB: 16, SMALLCAPS: 32, UNDERLINE: 64, SMALLER: 128, LARGER: 256,
});

export const FONTS = {
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif", "Droid Serif", "Times New Roman", serif',
  mono: '"DejaVu Sans Mono", Menlo, Consolas, "Noto Sans Mono", "Droid Sans Mono", "Courier New", monospace',
};

const NBSP = ' ';

/**
 * Page geometry and type sizes for a canvas of width×height pixels.
 * @param {{ width: number, height: number, fontScale?: number }} o
 */
export function makeMetrics({ width, height, fontScale = 1 }) {
  const k = width / 1024;
  const size = 30 * k * fontScale;
  const marginX = Math.round(86 * k);
  const top = Math.round(120 * k);
  const bottom = Math.round(118 * k);
  return {
    width, height, k, fontScale, size,
    lineHeight: Math.round(size * 1.45),
    marginX, top, bottom,
    textWidth: width - 2 * marginX,
    textHeight: height - top - bottom,
    headerY: Math.round(70 * k),
    footerY: height - Math.round(56 * k),
    em: size,
  };
}

/** Width cache over a private 2D context (so callers' ctx.font changes never interfere). */
export class Measurer {
  constructor() {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    this.ctx = canvas.getContext('2d');
    this.font = '';
    this.caches = new Map();
  }

  /** Advance width of `text` in CSS `font`. */
  width(text, font) {
    let cache = this.caches.get(font);
    if (!cache) {
      cache = new Map();
      this.caches.set(font, cache);
    }
    let w = cache.get(text);
    if (w === undefined) {
      if (this.font !== font) {
        this.ctx.font = font;
        this.font = font;
      }
      w = this.ctx.measureText(text).width;
      if (cache.size < 60000) cache.set(text, w);
    }
    return w;
  }
}

let sharedMeasurer = null;
/** Process-wide measurer (word widths are font-dependent only, so sharing is safe). */
export function getMeasurer() {
  if (!sharedMeasurer) sharedMeasurer = new Measurer();
  return sharedMeasurer;
}

/** Character weight of a block, identical to the server's (progress maths depends on it). */
export function blockChars(block) {
  switch (block.t) {
    case 'img': return 600;
    case 'hr': return 50;
    case 'pre': return block.x.length;
    case 'tr': {
      let n = 0;
      for (const cell of block.c) for (const run of cell) n += run[0].length;
      return n;
    }
    default: {
      let n = 0;
      if (block.r) for (const run of block.r) n += run[0].length;
      return n;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fonts

const fontCache = new Map();

/**
 * Font descriptor for style bits at a base pixel size.
 * @returns {{ font: string, px: number, dy: number, u: boolean }}
 */
function fontFor(bits, basePx, bold = false, mono = false) {
  const key = `${bits}|${basePx}|${bold ? 1 : 0}|${mono ? 1 : 0}`;
  let f = fontCache.get(key);
  if (f) return f;
  let px = basePx;
  if (bits & STYLE.SMALLER) px *= 0.86;
  if (bits & STYLE.LARGER) px *= 1.18;
  if (bits & (STYLE.SUP | STYLE.SUB)) px *= 0.66;
  const isMono = mono || (bits & STYLE.MONO);
  if (isMono) px *= 0.88;
  const italic = bits & STYLE.ITALIC ? 'italic ' : '';
  const weight = bold || (bits & STYLE.BOLD) ? 'bold ' : '';
  px = Math.round(px * 10) / 10;
  const dy = bits & STYLE.SUP ? -0.38 * basePx : bits & STYLE.SUB ? 0.2 * basePx : 0;
  f = { font: `${italic}${weight}${px}px ${isMono ? FONTS.mono : FONTS.serif}`, px, dy, u: !!(bits & STYLE.UNDERLINE) };
  fontCache.set(key, f);
  return f;
}

/** Small-caps variant: lowercase letters drawn as capitals at ~78 % size. */
function smallCapsFont(f) {
  const key = 'sc|' + f.font;
  let s = fontCache.get(key);
  if (!s) {
    const px = Math.round(f.px * 0.78 * 10) / 10;
    s = { ...f, px, font: f.font.replace(/[\d.]+px/, `${px}px`) };
    fontCache.set(key, s);
  }
  return s;
}

/** Same font, marked so tokenize() splits its text into capitals + small capitals. */
function smallCapsFlagged(f) {
  const key = 'scflag|' + f.font;
  let s = fontCache.get(key);
  if (!s) {
    s = { ...f, sc: true };
    fontCache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Tokens: words (one or more styled pieces), breakable spaces, hard breaks

/**
 * @typedef {{ text: string, f: object, w: number }} Piece
 * @typedef {{ k: 'w', pieces: Piece[], w: number } | { k: 's', w: number } | { k: 'br' }} Token
 */

/** Inline image sizes are CSS px at this font size (SPEC §3.5); they scale with the text. */
const INLINE_REF_PX = 16;

/** A piece for an inline image run, scaled to the text and to at most `maxH` tall. */
function imagePiece(img, f, basePx, maxH) {
  let k = basePx / INLINE_REF_PX;
  if (img.h * k > maxH) k = maxH / img.h;
  const w = Math.max(1, img.w * k);
  const h = Math.max(1, img.h * k);
  return { text: '', f, w, img: { src: img.src, alt: img.alt || '', inv: !!img.inv, w, h, va: (img.va || 0) * k } };
}

/** Shrinks an image piece to `w` wide. */
function shrinkImage(p, w) {
  const k = w / p.w;
  p.w = w;
  p.img = { ...p.img, w, h: p.img.h * k, va: p.img.va * k };
}

function pushPieces(pieces, text, f, m) {
  if (!text) return;
  if (f.sc) {
    // Split into runs of lowercase (→ small capitals) and everything else.
    const re = /(\p{Ll}+)|([^\p{Ll}]+)/gu;
    let mm;
    while ((mm = re.exec(text))) {
      if (mm[1]) {
        const sf = smallCapsFont(f);
        const t = mm[1].toUpperCase();
        pieces.push({ text: t, f: sf, w: m.width(t, sf.font) });
      } else {
        pieces.push({ text: mm[2], f, w: m.width(mm[2], f.font) });
      }
    }
    return;
  }
  const last = pieces[pieces.length - 1];
  if (last && last.f === f && !last.img) {
    last.text += text;
    last.w = m.width(last.text, f.font);
  } else {
    pieces.push({ text, f, w: m.width(text, f.font) });
  }
}

/**
 * Splits runs into tokens. Only U+0020 and newlines break; NBSP stays inside words. An image run
 * is one piece of a word, so punctuation right after a formula stays with it.
 * @param {Array<[string, number] | [string, number, object]>} runs
 * @param {number} [imgMaxH] height limit for inline images
 */
function tokenize(runs, basePx, bold, mono, m, imgMaxH = Infinity) {
  const tokens = [];
  let pieces = [];
  const flush = () => {
    if (!pieces.length) return;
    let w = 0;
    for (const p of pieces) w += p.w;
    tokens.push({ k: 'w', pieces, w });
    pieces = [];
  };
  for (const [text, bits, img] of runs) {
    if (!text) continue;
    let f = fontFor(bits, basePx, bold, mono);
    if (img) {
      pieces.push(imagePiece(img, f, basePx, imgMaxH));
      continue;
    }
    if (bits & STYLE.SMALLCAPS) f = smallCapsFlagged(f);
    const parts = text.split(/(\n| +)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') {
        flush();
        tokens.push({ k: 'br' });
      } else if (part[0] === ' ') {
        flush();
        const prev = tokens[tokens.length - 1];
        if (prev && prev.k === 's') continue;
        tokens.push({ k: 's', w: m.width(' ', f.font) });
      } else {
        pushPieces(pieces, part, f, m);
      }
    }
  }
  flush();
  // Trim spaces at the edges and around hard breaks.
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 's') {
      const prev = out[out.length - 1];
      const next = tokens[i + 1];
      if (!prev || prev.k === 'br' || !next || next.k === 'br') continue;
    }
    out.push(t);
  }
  return out;
}

/** Splits an over-long word into pieces that each fit `avail` (character-level). */
function splitWord(word, avail, m) {
  const parts = [];
  let cur = [];
  let curW = 0;
  for (const p of word.pieces) {
    if (p.img) {
      // Images are never split: one wider than the line shrinks to fit it.
      const img = { ...p };
      if (img.w > avail) shrinkImage(img, avail);
      if (curW + img.w > avail && curW > 0) {
        parts.push(finishWord(cur, m));
        cur = [];
        curW = 0;
      }
      cur.push(img);
      curW += img.w;
      continue;
    }
    for (const ch of p.text) {
      const w = m.width(ch, p.f.font);
      if (curW + w > avail && curW > 0) {
        parts.push(finishWord(cur, m));
        cur = [];
        curW = 0;
      }
      const last = cur[cur.length - 1];
      if (last && last.f === p.f && !last.img) last.text += ch;
      else cur.push({ text: ch, f: p.f, w: 0 });
      curW += w;
    }
  }
  if (cur.length) parts.push(finishWord(cur, m));
  return parts;
}

function finishWord(pieces, m) {
  let w = 0;
  for (const p of pieces) {
    if (!p.img) p.w = m.width(p.text, p.f.font);
    w += p.w;
  }
  return { k: 'w', pieces, w };
}

/**
 * Greedy line breaking.
 * @param {Token[]} tokens
 * @param {number | ((index: number, cont: boolean) => number)} widthFor available width, or a
 *   function of (line index, is-continuation-of-a-soft-wrap)
 * @returns {Array<{ items: Token[], w: number, spaces: number, hard: boolean, cont: boolean }>}
 *   `hard` = ended by a hard break or the paragraph end (never justified); `cont` = the line
 *   continues a soft-wrapped line (verse hangs these).
 */
function breakLines(tokens, widthFor, m) {
  const lines = [];
  let cur = [];
  let curW = 0;
  let spaces = 0;
  let pending = null;
  let cont = false;
  const lineAvail = typeof widthFor === 'number' ? () => widthFor : () => widthFor(lines.length, cont);
  const endLine = (hard) => {
    lines.push({ items: cur, w: curW, spaces, hard, cont });
    cont = !hard;
    cur = [];
    curW = 0;
    spaces = 0;
    pending = null;
  };
  for (const t of tokens) {
    if (t.k === 's') {
      if (cur.length) pending = t;
      continue;
    }
    if (t.k === 'br') {
      endLine(true);
      continue;
    }
    const need = (cur.length && pending ? pending.w : 0) + t.w;
    if (curW + need <= lineAvail() + 0.01) {
      if (cur.length && pending) {
        cur.push(pending);
        spaces++;
      }
      cur.push(t);
      curW += need;
      pending = null;
      continue;
    }
    if (cur.length) endLine(false);
    if (t.w <= lineAvail() + 0.01) {
      cur.push(t);
      curW = t.w;
    } else {
      const parts = splitWord(t, lineAvail(), m);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) endLine(false);
        cur.push(parts[i]);
        curW = parts[i].w;
      }
    }
  }
  if (cur.length || !lines.length) endLine(true);
  else lines[lines.length - 1].hard = true;
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Boxes

/**
 * @typedef {object} Box
 * @property {number} h          height (px)
 * @property {number} before     space wanted above (collapses with previous `after`)
 * @property {number} after      space wanted below
 * @property {number} block      chunk-local block index
 * @property {number} line       line index within the block
 * @property {number} lines      line count of the block
 * @property {boolean} keep      keep with next box (headings)
 * @property {Array<object>} items draw items, coordinates relative to the box top-left of the text area
 */

/** Positions one broken line into draw items. */
function lineItems(line, x0, avail, align, justify, baseline) {
  const items = [];
  let extra = 0;
  if (justify && !line.hard && line.spaces > 0) {
    extra = (avail - line.w) / line.spaces;
  }
  let x = x0;
  if (align === 'c') x = x0 + Math.max(0, (avail - line.w) / 2);
  else if (align === 'r') x = x0 + Math.max(0, avail - line.w);
  // Merge consecutive same-font pieces into one fillText when not justifying (fewer draw calls).
  let run = null;
  const emit = (text, f, w) => {
    if (!extra && run && run.f === f) {
      run.text += text;
      run.w += w;
    } else {
      run = { k: 't', x, y: baseline + f.dy, text, f, w };
      items.push(run);
    }
    x += w;
  };
  for (const t of line.items) {
    if (t.k === 's') {
      if (extra) {
        x += t.w + extra;
        run = null;
      } else if (run) {
        run.text += ' ';
        run.w += t.w;
        x += t.w;
      } else {
        x += t.w;
      }
      continue;
    }
    for (const p of t.pieces) {
      if (p.img) {
        // Bottom at the baseline, moved by its vertical-align (positive raises).
        const im = p.img;
        items.push({ k: 'img', x, y: baseline - im.va - im.h, w: im.w, h: im.h, src: im.src, alt: im.alt, inv: im.inv });
        x += p.w;
        run = null;
      } else {
        emit(p.text, p.f, p.w);
      }
    }
  }
  return items.map((it) => (it.k === 'img' ? it : { k: 't', x: it.x, y: it.y, text: it.text, font: it.f.font, u: it.f.u ? it.w : 0 }));
}

/**
 * Grows a line box to hold its inline images (a tall formula): moves the items down when an
 * image reaches above the line, and returns the box height.
 */
function fitImages(items, lh) {
  let top = 0;
  let bottom = lh;
  for (const it of items) {
    if (it.k !== 'img') continue;
    top = Math.min(top, it.y - 2);
    bottom = Math.max(bottom, it.y + it.h + 2);
  }
  if (top < 0) for (const it of items) it.y -= top;
  return bottom - top;
}

function textBoxes(block, bi, ctx) {
  const { M, m, prev } = ctx;
  const em = M.size;
  const q = block.q || 0;
  let left = q * 1.8 * em;
  let right = q * 1.0 * em;
  let basePx = em;
  let bold = false;
  let align = block.a || null;
  let justify = !align;
  let firstIndent = 0;
  let hang = 0;
  let lh = M.lineHeight;
  let before = 0.3 * em;
  let after = 0.3 * em;
  let keep = false;
  let marker = null;

  if (block.t === 'h') {
    const scale = [0, 1.62, 1.36, 1.17, 1.05, 1.0, 0.95][block.l] || 1;
    basePx = em * scale;
    bold = block.l >= 3;
    lh = Math.round(basePx * 1.28);
    align = block.a || (block.l <= 3 ? 'c' : null);
    justify = false;
    before = (block.l <= 2 ? 2.2 : 1.4) * em;
    after = (block.l <= 2 ? 0.9 : 0.6) * em;
    keep = true;
  } else if (block.t === 'li') {
    const d = Math.max(1, block.d || 1);
    left += (d - 1) * 1.6 * em;
    marker = block.m || '';
    hang = 1.6 * em;
    justify = false;
    before = 0.12 * em;
    after = 0.12 * em;
  } else if (block.v) {
    justify = false;
    hang = 1.6 * em;
    before = 0.15 * em;
    after = 0.15 * em;
    if (prev && !prev.v) before = 0.7 * em;
  } else if (!align) {
    // Body paragraph: small gap, first-line indent when following another body paragraph.
    after = 0.12 * em;
    if (prev && prev.t === 'p' && !prev.a && !prev.v) {
      firstIndent = 1.4 * em;
      before = 0.12 * em;
    } else {
      before = 0.4 * em;
    }
  } else {
    before = 0.5 * em;
    after = 0.5 * em;
  }

  const avail = M.textWidth - left - right;
  const tokens = tokenize(block.r || [], basePx, bold, false, m, M.textHeight * 0.5);
  if (!tokens.length && block.t !== 'p') return [];
  // [x offset, width] of line i. Lists hang every line behind the marker; verse hangs only the
  // continuations of soft-wrapped lines; body text indents the paragraph's first line.
  const geom = (i, cont) => {
    if (marker !== null) return [left + hang, avail - hang];
    if (hang) return cont ? [left + hang, avail - hang] : [left, avail];
    if (i === 0) return [left + firstIndent, avail - firstIndent];
    return [left, avail];
  };
  const lines = breakLines(tokens, (i, cont) => geom(i, cont)[1], m);
  const baseline = Math.round((lh - basePx) / 2 + basePx * 0.8);
  const boxes = [];
  for (let i = 0; i < lines.length; i++) {
    const [x0, a] = geom(i, lines[i].cont);
    const items = lineItems(lines[i], x0, a, align, justify, baseline);
    if (i === 0 && marker) {
      const mf = fontFor(0, basePx);
      const mw = m.width(marker, mf.font);
      items.push({ k: 't', x: left + hang - mw - 0.45 * em, y: baseline, text: marker, font: mf.font, u: 0 });
    }
    const h = fitImages(items, lh);
    boxes.push({ h, before: i === 0 ? before : 0, after: i === lines.length - 1 ? after : 0, block: bi, line: i, lines: lines.length, keep, items });
  }
  return boxes;
}

function preBoxes(block, bi, ctx) {
  const { M, m } = ctx;
  const em = M.size;
  const q = block.q || 0;
  const left = q * 1.8 * em;
  const avail = M.textWidth - left - q * em;
  const raw = block.x.replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  let px = em;
  let f = fontFor(0, px, false, true);
  let longest = 0;
  for (const l of raw) longest = Math.max(longest, m.width(l, f.font));
  if (longest > avail) {
    px = Math.max(em * 0.58, (em * avail) / longest);
    f = fontFor(0, Math.floor(px * 10) / 10, false, true);
  }
  const lh = Math.round(f.px * 1.38);
  const baseline = Math.round((lh - f.px) / 2 + f.px * 0.8);
  const lines = [];
  for (const l of raw) {
    if (m.width(l, f.font) <= avail + 0.5) {
      lines.push(l);
      continue;
    }
    // Still too wide at the minimum size: wrap by characters.
    let cur = '';
    for (const ch of l) {
      if (m.width(cur + ch, f.font) > avail && cur) {
        lines.push(cur);
        cur = ch;
      } else cur += ch;
    }
    lines.push(cur);
  }
  return lines.map((text, i) => ({
    h: lh, before: i === 0 ? 0.5 * em : 0, after: i === lines.length - 1 ? 0.5 * em : 0,
    block: bi, line: i, lines: lines.length, keep: false,
    items: text.trim() ? [{ k: 't', x: left, y: baseline, text, font: f.font, u: 0 }] : [],
  }));
}

function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(8 - (out.length % 8));
    else out += ch;
  }
  return out;
}

function imageBox(block, bi, ctx) {
  const { M } = ctx;
  const em = M.size;
  const q = block.q || 0;
  const left = q * 1.8 * em;
  const avail = M.textWidth - left - q * em;
  const nw = block.w || block._w || 400;
  const nh = block.h || block._h || 300;
  // Pages are ~1024 px wide like a typical screen, so natural size is about right; small images
  // get a modest boost (they were authored for low-DPI screens), large ones are capped.
  const maxH = M.textHeight - 0.4 * em;
  // `em` images (a formula on its own line) are sized like inline images, with the text.
  const scale = Math.min(block.em ? em / INLINE_REF_PX : nw < 160 ? 1.6 : 1.25, avail / nw, maxH / nh);
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  return [{
    h, before: 0.7 * em, after: 0.7 * em, block: bi, line: 0, lines: 1, keep: false,
    img: { nw, nh, avail, maxH },
    items: [{ k: 'img', x: left + (avail - w) / 2, y: 0, w, h, src: block.src, alt: block.alt || '', inv: !!block.inv }],
  }];
}

function hrBox(block, bi, ctx) {
  const { M } = ctx;
  const em = M.size;
  const w = M.textWidth * 0.28;
  return [{
    h: Math.round(0.9 * em), before: 0.6 * em, after: 0.6 * em, block: bi, line: 0, lines: 1, keep: false,
    items: [{ k: 'rule', x: (M.textWidth - w) / 2, y: Math.round(0.45 * em), w, lw: Math.max(1, M.k * 1.5) }],
  }];
}

const NUMERIC = /^[\s\d.,:;–—\-()[\]ivxlcdmIVXLCDM*†‡§¶pP]*$/;

/** Lays out a run of `tr` blocks (one table group) into one box per row. */
function tableBoxes(rows, firstIndex, ctx) {
  const { M, m } = ctx;
  const em = M.size;
  const q = rows[0].q || 0;
  const left = q * 1.8 * em;
  const avail = M.textWidth - left - q * em;
  const ncol = Math.max(1, ...rows.map((r) => r.c.length));
  const gap = 0.9 * em;

  const attempt = (scale) => {
    const basePx = em * 0.92 * scale;
    const cells = rows.map((r) => {
      const out = new Array(ncol).fill(null);
      // Ragged rows (colspan is not transmitted): keep the first cells left, the last cell in the
      // last column — page-number columns stay aligned.
      r.c.forEach((cell, i) => {
        const col = i === r.c.length - 1 && r.c.length < ncol ? ncol - 1 : i;
        out[col] = tokenize(cell, basePx, !!r.hd, false, m, Math.round(basePx * 1.34) - 2);
      });
      return out;
    });
    const nat = new Array(ncol).fill(0);
    const min = new Array(ncol).fill(0);
    for (const row of cells) {
      row.forEach((toks, col) => {
        if (!toks) return;
        let lineW = 0;
        for (const t of toks) {
          if (t.k === 'br') {
            nat[col] = Math.max(nat[col], lineW);
            lineW = 0;
          } else {
            lineW += t.w;
            if (t.k === 'w') min[col] = Math.max(min[col], t.w);
          }
        }
        nat[col] = Math.max(nat[col], lineW);
      });
    }
    const totalGap = gap * (ncol - 1);
    const sumMin = min.reduce((a, b) => a + b, 0);
    const sumNat = nat.reduce((a, b) => a + b, 0);
    if (sumMin + totalGap > avail) return null;
    let widths;
    if (sumNat + totalGap <= avail) widths = nat.slice();
    else {
      const spare = avail - totalGap - sumMin;
      const want = sumNat - sumMin || 1;
      widths = min.map((mn, i) => mn + (spare * (nat[i] - mn)) / want);
    }
    return { cells, widths, basePx };
  };

  let fit = attempt(1) || attempt(0.85) || attempt(0.72);
  const boxes = [];
  if (!fit) {
    // Too many/wide columns: stack each row's cells as separate lines.
    rows.forEach((r, ri) => {
      const runs = [];
      r.c.forEach((cell, i) => {
        if (!cell.length) return;
        if (runs.length) runs.push(['\n', 0]);
        for (const run of cell) {
          const bits = run[1] | (i === 0 ? STYLE.BOLD : 0);
          runs.push(run.length > 2 ? [run[0], bits, run[2]] : [run[0], bits]);
        }
      });
      const b = textBoxes({ t: 'p', r: runs, a: undefined, v: 1, q }, firstIndex + ri, { ...ctx, prev: null });
      boxes.push(...b);
    });
    return boxes;
  }
  const { cells, widths, basePx } = fit;
  const lh = Math.round(basePx * 1.34);
  const baseline = Math.round((lh - basePx) / 2 + basePx * 0.8);
  const used = widths.reduce((a, b) => a + b, 0) + gap * (ncol - 1);
  const x0 = left + Math.max(0, (avail - used) / 2);
  const colX = [];
  let x = x0;
  for (let i = 0; i < ncol; i++) {
    colX.push(x);
    x += widths[i] + gap;
  }
  // Right-align columns that only hold numbers / page references.
  const rightAlign = widths.map((_, col) => rows.every((r, ri) => {
    const toks = cells[ri][col];
    if (!toks) return true;
    const text = toks.filter((t) => t.k === 'w').map((t) => t.pieces.map((p) => p.text).join('')).join(' ');
    return text.length <= 8 && NUMERIC.test(text);
  }) && rows.some((r, ri) => cells[ri][col]?.length));
  const lw = Math.max(1, M.k * 1.2);
  rows.forEach((r, ri) => {
    const cellLines = cells[ri].map((toks, col) => (toks ? breakLines(toks, widths[col], m) : []));
    const n = Math.max(1, ...cellLines.map((l) => l.length));
    const pad = Math.round(0.18 * em);
    const items = [];
    cellLines.forEach((lines, col) => {
      lines.forEach((line, li) => {
        for (const it of lineItems(line, colX[col], widths[col], rightAlign[col] ? 'r' : null, false, pad + li * lh + baseline)) {
          if (it.k === 'img') it.y = pad + li * lh + (lh - it.h) / 2; // capped to the line: centred in it
          items.push(it);
        }
      });
    });
    const h = n * lh + 2 * pad;
    if (ri === 0) items.push({ k: 'rule', x: x0, y: 0, w: used, lw });
    if (r.hd || ri === rows.length - 1) items.push({ k: 'rule', x: x0, y: h, w: used, lw });
    boxes.push({
      h, before: ri === 0 ? 0.6 * em : 0, after: ri === rows.length - 1 ? 0.7 * em : 0,
      block: firstIndex + ri, line: 0, lines: 1, keep: !!r.hd, items,
    });
  });
  return boxes;
}

/**
 * Appends the boxes of block i (of a whole table group when it is a `tr`) to `boxes`.
 * @returns {number} the index of the next block to lay out
 */
function blockBoxes(blocks, i, M, m, boxes) {
  const b = blocks[i];
  const ctx = { M, m, prev: i > 0 ? blocks[i - 1] : null };
  let out;
  let next = i + 1;
  switch (b.t) {
    case 'h': case 'p': case 'li': out = textBoxes(b, i, ctx); break;
    case 'pre': out = preBoxes(b, i, ctx); break;
    case 'img': out = imageBox(b, i, ctx); break;
    case 'hr': out = hrBox(b, i, ctx); break;
    case 'tr': {
      while (next < blocks.length && blocks[next].t === 'tr' && blocks[next].g === b.g) next++;
      out = tableBoxes(blocks.slice(i, next), i, ctx);
      break;
    }
    default: out = [];
  }
  for (const box of out) boxes.push(box);
  return next;
}

/**
 * Lays out the blocks of one chunk into boxes.
 * @param {object[]} blocks
 * @param {object} M metrics from makeMetrics
 * @param {Measurer} m
 */
export function layoutBoxes(blocks, M, m = getMeasurer()) {
  const boxes = [];
  for (let i = 0; i < blocks.length;) i = blockBoxes(blocks, i, M, m, boxes);
  return boxes;
}

// ---------------------------------------------------------------------------------------------
// Pagination

/**
 * @typedef {object} Page
 * @property {Array<{ y: number, box: Box }>} boxes
 * @property {number} firstBlock
 * @property {number} lastBlock
 * @property {number} charStart  chunk-local character offset of the page start (approximate)
 */

/**
 * Distributes boxes over pages: never splits a box, keeps headings with what follows, avoids
 * single orphan/widow lines, shrinks an image to fit the remaining space when that is not much.
 * @returns {Page[]}
 */
export function paginate(boxes, blocks, M) {
  const pager = new Paginator(blocks, M);
  pager.run(boxes, true);
  return pager.pages;
}

/**
 * Pagination that can run while the boxes are still being laid out: `run` closes every page
 * whose end is already decided and stops at the first page that needs more boxes, so the result
 * is the same as paginating all the boxes at once.
 */
class Paginator {
  constructor(blocks, M) {
    this.blocks = blocks;
    this.M = M;
    this.blockStart = new Array(blocks.length + 1);
    this.blockStart[0] = 0;
    for (let i = 0; i < blocks.length; i++) this.blockStart[i + 1] = this.blockStart[i] + blockChars(blocks[i]);
    /** @type {Page[]} */
    this.pages = [];
    this.start = 0; // first box of the next page
  }

  /**
   * Closes the pages that `boxes` so far decide.
   * @param {Box[]} boxes all boxes laid out so far (later calls pass the same, longer array)
   * @param {boolean} final no more boxes will come: the last page closes too
   */
  run(boxes, final) {
    const { blocks, M, blockStart, pages } = this;
    const avail = M.textHeight;
    let start = this.start;
    while (start < boxes.length) {
      let y = 0;
      let end = start;
      let prevAfter = 0;
      let filled = false; // page closed by shrinking an image into the remaining space
      const placed = [];
      for (; end < boxes.length; end++) {
        const b = boxes[end];
        const gap = placed.length ? Math.max(prevAfter, b.before) : 0;
        if (y + gap + b.h <= avail || !placed.length) {
          placed.push({ y: y + gap, box: b });
          y += gap + b.h;
          prevAfter = b.after;
          continue;
        }
        // An image that almost fits is scaled down instead of leaving a large hole.
        if (b.img) {
          const room = avail - y - gap;
          const s = room / b.h;
          if (s >= 0.62 && room > avail * 0.3) {
            const img = b.items[0];
            const w = Math.round(img.w * s);
            const nb = { ...b, h: Math.floor(room), items: [{ ...img, w, h: Math.floor(room), x: img.x + (img.w - w) / 2 }] };
            boxes[end] = nb;
            placed.push({ y: y + gap, box: nb });
            y = avail;
            end++;
            filled = true;
          }
        }
        break;
      }
      // Every box so far fits: the page stays open until more boxes (or the end) arrive.
      if (!filled && end >= boxes.length && !final) break;
      // Choose the break point (end = first box on the next page).
      if (!filled && end < boxes.length && end - start > 1) {
        let brk = end;
        const nb = boxes[brk];
        const pb = boxes[brk - 1];
        // Widow: don't carry only the last line of a paragraph over.
        if (nb.block === pb.block && nb.line === nb.lines - 1 && nb.lines >= 3 && pb.line >= 1) brk--;
        // Orphan: don't leave only the first line of a paragraph at the bottom.
        const ob = boxes[brk - 1];
        if (brk - 1 > start && ob.line === 0 && ob.lines >= 2 && boxes[brk].block === ob.block) brk--;
        // Keep headings (and table header rows) with what follows.
        while (brk - 1 > start && boxes[brk - 1].keep) brk--;
        if (brk > start) {
          while (placed.length > brk - start) placed.pop();
          end = brk;
        }
      }
      const first = placed[0].box;
      const last = placed[placed.length - 1].box;
      const bc = blockChars(blocks[first.block]);
      pages.push({
        boxes: placed,
        firstBlock: first.block,
        firstLine: first.line,
        lastBlock: last.block,
        charStart: blockStart[first.block] + (first.lines > 1 ? Math.round((bc * first.line) / first.lines) : 0),
      });
      start = end;
    }
    this.start = start;
    if (final && !pages.length) pages.push({ boxes: [], firstBlock: 0, firstLine: 0, lastBlock: 0, charStart: 0 });
  }
}

/**
 * One chunk's layout, done a few blocks at a time (`step`) so a long chunk (a Wikipedia article
 * can be 240,000 characters, six times a normal chunk) never blocks a frame. `pages` grows as
 * pages are decided, and ends up exactly as layoutChunk's.
 */
export class ChunkLayout {
  constructor(blocks, M, m = getMeasurer()) {
    this.blocks = blocks;
    this.M = M;
    this.m = m;
    this.boxes = [];
    this._next = 0; // next block to lay out
    this._pager = new Paginator(blocks, M);
    /** @type {Page[]} */
    this.pages = this._pager.pages;
    this.done = false;
  }

  /**
   * Lays out blocks until `budgetMs` has passed (at least one block), then closes the pages
   * they decide.
   * @returns {boolean} true once the whole chunk is laid out
   */
  step(budgetMs = Infinity) {
    if (this.done) return true;
    const { blocks, M, m, boxes } = this;
    const t0 = performance.now();
    while (this._next < blocks.length) {
      this._next = blockBoxes(blocks, this._next, M, m, boxes);
      if (performance.now() - t0 >= budgetMs) break;
    }
    this.done = this._next >= blocks.length;
    this._pager.run(boxes, this.done);
    return this.done;
  }
}

/** Convenience: blocks → pages. */
export function layoutChunk(blocks, M, m = getMeasurer()) {
  const L = new ChunkLayout(blocks, M, m);
  L.step();
  return L.pages;
}

export { NBSP };
