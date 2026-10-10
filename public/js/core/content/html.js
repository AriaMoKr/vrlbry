// HTML → reader blocks (SPEC §3.3, block model §3.5), chunking + TOC, image size sniffing.
//
// The converter is a streaming state machine driven by htmlparser2's Parser callbacks: no DOM is
// built, so a 30 MB dictionary converts in linear time with memory proportional to the output.

import { platform } from '../platform.js';

/** Run style bits (§3.5). */
export const STYLE = Object.freeze({
  italic: 1, bold: 2, mono: 4, sup: 8, sub: 16, smallcaps: 32, underline: 64, smaller: 128, larger: 256,
});

const NBSP = '\u00a0';
const PLACEHOLDER_TEXT = '(This book has no readable text.)';

// HTML collapses only ASCII whitespace; U+00A0 and other Unicode spaces must survive.
const WS_TEST = /[\t\n\f\r ]/;
const WS_RUN = /[\t\n\f\r ]+/g;
const ALL_WS = /^[\t\n\f\r ]*$/;
const SHY = /\u00ad/g;
const INVISIBLE_CHARS = /[^\t\n\f\r ]/g;
// "Visible" = anything but whitespace (incl. NBSP) and zero-width characters.
const VISIBLE = /[^\s\u200b-\u200d\u2060\ufeff]/;

// ---------------------------------------------------------------------------------------------
// Element classification tables

const SKIP_TAGS = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed',
  'applet', 'button', 'select', 'input', 'textarea', 'option', 'optgroup', 'datalist', 'output',
  'audio', 'video', 'canvas', 'map', 'noframes', 'frameset', 'frame', 'dialog', 'progress', 'meter',
]);

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'menu', 'dir',
  'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'colgroup', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'aside', 'nav',
  'main', 'center', 'address', 'hgroup', 'details', 'summary', 'fieldset', 'legend', 'form',
  'body', 'html',
]);

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const TAG_BITS = {
  i: 1, em: 1, cite: 1, var: 1, dfn: 1, address: 1,
  b: 2, strong: 2, dt: 2,
  code: 4, tt: 4, kbd: 4, samp: 4,
  sup: 8, sub: 16,
  u: 64, ins: 64,
  small: 128, big: 256,
};

// Page-number markers (PG uses many spellings). Matched case-insensitively against class tokens.
const PAGE_CLASSES = new Set([
  'pagenum', 'pageno', 'pagenumber', 'pgnum', 'pgnm', 'pgn', 'pgno', 'xxpgno', 'nopagenum',
  'folionum', 'x-ebookmaker-pageno', 'pb',
]);
// Generic words that only mean "page number" on inline elements.
const PAGE_CLASSES_INLINE = new Set(['page', 'pn']);
// Navigation links ("back to contents") that float beside headings in browsers and would glue
// onto the heading text here.
const NAV_CLASSES = new Set(['totoc', 'toclink', 'return', 'back', 'backlink', 'back-link', 'linkback', 'totop', 'gotop']);

// MediaWiki / mwoffliner page chrome (Wikisource and other wiki ZIMs): navigation, edit links,
// category boxes, licence banners, the ZIM footer. Class tokens (lower-cased) and element ids.
const MW_CHROME_CLASSES = new Set([
  'ws-noexport', 'noprint', 'mw-editsection', 'navbox', 'catlinks', 'printfooter', 'zim-footer',
  'licensecontainer', 'licensebanner', 'pr_quality', 'mw-jump-link', 'mw-indicators', 'mw-cite-backlink',
  'mw-empty-elt', 'sidebar', 'ambox', 'side-box', 'sistersitebox', 'portalbox',
]);
const MW_CHROME_IDS = new Set([
  'firstHeading', 'contentSub', 'mw-content-subtitle', 'siteSub', 'catlinks', 'jump-to-nav',
  'mw-navigation', 'footer', 'mw-panel', 'mw-head', 'mw-page-base', 'mw-head-base', 'toc-toggle',
]);

// Inline images (SPEC §3.5 image runs) stay in the line of text: MediaWiki's inline formulas (sized
// in ex in their style) and small images with an explicit size. A block holding nothing but
// images still becomes image blocks.
const INLINE_IMG_MAX_H = 32;
const EX_PX = 8; // CSS px per ex at a 16 px font, as the SVG sniffer assumes
const RE_MATH_INLINE = /(?:^|\s)mwe-math-fallback-image-inline(?:\s|$)/;
const RE_INVERT = /(?:^|\s)(?:mw-invert|skin-invert)(?:\s|$)/;
const RE_INFOBOX = /(?:^|\s)infobox(?:\s|$)/;
const OBJ = '￼'; // the text of an image run
const FACTS_TITLE = 'Quick facts';
const FORMULAS = new WeakSet(); // image-run objects of formulas (sized in ex: they scale with the text)
const BLOCK_IDS = new WeakMap(); // block → every element id in it (its `id` is only the first)
// Parsoid's element ids in mwoffliner pages ("mwATE"): nothing links to them, and a section's
// wrapper would otherwise give its heading block that id instead of the section's ("History").
const PARSOID_ID = /^mw[A-Za-z0-9_-]{2,5}$/;

const RE_VERSE = /^(poem|poetry|stanza|verse|linegroup|lines$|lines-container|lg-container)/i;
const RE_STANZA = /^stanza/i;
const RE_INDENT = /^(?:i|in|indent)(\d{1,2})$/;
const RE_QUOTE = /^(?:blockquot|blockquote|quote|quotation|bq\d?)$/i;
const RE_RIGHT = /^(?:r|right\d?|[a-z]*-right|text-?right|align-?right|verseright|capright|rightsc|righthalf)$/i;
const RE_LINENUM = /^linenum\d*$/i;

// ---------------------------------------------------------------------------------------------
// Minimal CSS support: only simple `.cls` / `tag.cls` selectors at the top level (at-rule blocks
// such as @media print are ignored, so print-only `display:none` rules do not hide content).

/**
 * Parses CSS declarations into the subset of properties the converter understands.
 * @param {string} text declaration list (`a: b; c: d`)
 * @returns {object|null} props or null when nothing relevant
 */
function parseDecls(text) {
  let props = null;
  for (const decl of text.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim().toLowerCase();
    if (value.endsWith('!important')) value = value.slice(0, -10).trim();
    const set = (k, v) => { (props ??= {})[k] = v; };
    switch (prop) {
      case 'display':
        if (value === 'none') set('hidden', true);
        else if (value === 'block') set('block', true);
        break;
      case 'visibility':
        // Invisible text still takes up room; PG uses it to align verse/ditto columns.
        if (value === 'hidden' || value === 'collapse') set('blank', true);
        break;
      case 'text-align':
        if (value === 'center' || value === '-moz-center' || value === '-webkit-center') set('align', 'c');
        else if (value === 'right' || value === 'end') set('align', 'r');
        else if (value === 'left' || value === 'justify' || value === 'start') set('align', '');
        break;
      case 'font-style':
        if (value === 'italic' || value === 'oblique') set('italic', true);
        else if (value === 'normal') set('italic', false);
        break;
      case 'font-weight':
        if (value === 'bold' || value === 'bolder' || /^[6-9]00$/.test(value)) set('bold', true);
        else if (value === 'normal' || value === 'lighter' || /^[1-4]00$/.test(value)) set('bold', false);
        break;
      case 'font-variant':
      case 'font-variant-caps':
        if (value.includes('small-caps')) set('smallcaps', true);
        else if (value === 'normal') set('smallcaps', false);
        break;
      case 'text-decoration':
      case 'text-decoration-line':
        if (value.includes('underline')) set('underline', true);
        else if (value === 'none') set('underline', false);
        break;
      case 'vertical-align':
        if (value === 'super') set('sup', true);
        else if (value === 'sub') set('sub', true);
        break;
      case 'font-family':
        if (value.includes('mono') || value.includes('courier')) set('mono', true);
        break;
      case 'font-size': {
        const size = fontSizeClass(value);
        if (size) set('size', size);
        break;
      }
      case 'list-style':
      case 'list-style-type':
        if (/(^|\s)none(\s|$)/.test(value)) set('nomarker', true);
        else if (/lower-(alpha|latin)/.test(value)) set('listType', 'a');
        else if (/upper-(alpha|latin)/.test(value)) set('listType', 'A');
        else if (/lower-roman/.test(value)) set('listType', 'i');
        else if (/upper-roman/.test(value)) set('listType', 'I');
        else if (/decimal/.test(value)) set('listType', '1');
        break;
      default:
    }
  }
  return props;
}

/** Maps a CSS font-size value to 'smaller' / 'larger' / null. */
function fontSizeClass(v) {
  if (v === 'smaller' || v === 'small' || v === 'x-small' || v === 'xx-small') return 'smaller';
  if (v === 'larger' || v === 'large' || v === 'x-large' || v === 'xx-large' || v === 'xxx-large') return 'larger';
  const m = /^(\d*\.?\d+)(%|em|rem)$/.exec(v);
  if (!m) return null;
  const pct = m[2] === '%' ? +m[1] : +m[1] * 100;
  if (pct <= 90) return 'smaller';
  if (pct >= 115) return 'larger';
  return null;
}

/**
 * Collects simple class rules from a stylesheet into `map` (key `.cls` or `tag.cls`; bare `ul`,
 * `ol`, `li` keys are kept for list-style only).
 */
function parseCss(css, map) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
  const n = css.length;
  let i = 0;
  while (i < n) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let prelude = css.slice(i, open);
    const semi = prelude.lastIndexOf(';'); // statement at-rules (@import …;) before the rule
    if (semi >= 0) prelude = prelude.slice(semi + 1);
    prelude = prelude.trim();
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      const c = css.charCodeAt(j);
      if (c === 123) depth++;
      else if (c === 125) depth--;
      j++;
    }
    const body = css.slice(open + 1, depth === 0 ? j - 1 : j);
    i = j;
    if (prelude.startsWith('@')) continue;
    const props = parseDecls(body);
    if (!props) continue;
    for (const raw of prelude.split(',')) {
      const sel = raw.trim();
      const m = /^([a-zA-Z][a-zA-Z0-9]*)?\.([\w-]+)$/.exec(sel);
      if (m) {
        const key = (m[1] ? m[1].toLowerCase() : '') + '.' + m[2];
        map.set(key, { ...map.get(key), ...props });
      } else if (/^(ul|ol|li)$/i.test(sel) && props.nomarker !== undefined) {
        map.set(sel.toLowerCase(), { nomarker: props.nomarker });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Element info: everything the state machine needs to know about one start tag.

const NO_INFO = Object.freeze({
  skip: 0, // 1 = drop the subtree, 2 = drop it but keep collecting its ids (page numbers)
  set: 0, // style bits switched on
  clear: 0, // style bits switched off (font-style: normal...)
  align: undefined, // 'c' | 'r' | '' (explicit left/justify) | undefined (inherit)
  quote: 0, verse: false, stanza: false, verseLine: false, indent: -1, line: false,
  caption: false, blank: false, boiler: false, nomarker: false, listType: null,
});

/** Applies parsed CSS props onto a mutable info object. */
function applyProps(info, p) {
  if (p.hidden) info.skip = 1;
  if (p.blank) info.blank = true;
  if (p.align !== undefined) info.align = p.align;
  const bit = (flag, b) => {
    if (flag === true) { info.set |= b; info.clear &= ~b; } else if (flag === false) { info.clear |= b; info.set &= ~b; }
  };
  bit(p.italic, 1); bit(p.bold, 2); bit(p.mono, 4); bit(p.sup, 8); bit(p.sub, 16);
  bit(p.smallcaps, 32); bit(p.underline, 64);
  if (p.size === 'smaller') bit(true, 128);
  else if (p.size === 'larger') bit(true, 256);
  if (p.block) info.line = true;
  if (p.nomarker !== undefined) info.nomarker = p.nomarker;
  if (p.listType) info.listType = p.listType;
}

/** Computes info from tag + class attribute (cacheable: no per-element attributes involved). */
function classInfo(name, cls, css) {
  const info = { ...NO_INFO };
  if (TAG_BITS[name]) info.set = TAG_BITS[name];
  if (name === 'center' || name === 'caption') info.align = 'c';
  if (name === 'figcaption') { info.caption = true; }
  if (name === 'blockquote' || name === 'dd') info.quote = 1;
  if (css.size && (name === 'ul' || name === 'ol' || name === 'li')) {
    const p = css.get(name);
    if (p) info.nomarker = p.nomarker;
  }
  if (!cls) return info;
  // Index tables put page references in td.pageno; hr.pb is a visible rule: keep those.
  const pageMarkerTag = name !== 'td' && name !== 'th' && name !== 'hr';
  const inline = !BLOCK_TAGS.has(name);
  // Drop caps are often hidden and replaced by a CSS background image we cannot show.
  const dropcap = /drop-?cap/i.test(cls);
  for (const tok of cls.split(/\s+/)) {
    if (!tok) continue;
    const low = tok.toLowerCase();
    if (low.startsWith('zim_') || MW_CHROME_CLASSES.has(low)) { info.skip = 1; return info; }
    if (pageMarkerTag && (PAGE_CLASSES.has(low) || (inline && PAGE_CLASSES_INLINE.has(low)))) {
      info.skip = 2; // keep collecting ids: they are link targets (#Page_12)
      return info;
    }
    if (low === 'pg-boilerplate') info.boiler = true;
    if (name === 'span' && RE_LINENUM.test(tok)) { info.skip = 1; return info; }
    if ((name === 'a' || name === 'span') && NAV_CLASSES.has(low)) { info.skip = 1; return info; }
    if (low.includes('smcap') || low.includes('small-caps') || low.includes('smallcaps') || low === 'sc') info.set |= 32;
    if (low === 'xhtml_big') info.set |= 256;
    if (low === 'c' || low === 'ctr' || low.includes('center') || low.includes('centre')) info.align = 'c';
    else if (RE_RIGHT.test(low)) info.align = 'r';
    if (RE_QUOTE.test(low)) info.quote = 1;
    if (RE_VERSE.test(low)) {
      info.verse = true;
      if (RE_STANZA.test(low)) info.stanza = true;
    }
    const im = RE_INDENT.exec(low);
    if (im) {
      info.indent = Math.min(+im[1], 20);
      if (name === 'span' && low.startsWith('i') && !low.startsWith('in')) info.verseLine = true;
    }
    if (low === 'caption') info.caption = true;
    if (css.size) {
      const a = css.get('.' + tok);
      if (a) applyProps(info, a);
      const b = css.get(name + '.' + tok);
      if (b) applyProps(info, b);
      if (dropcap) { info.skip = 0; info.blank = false; }
      if (info.skip) return info;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------------------------
// Run builder: whitespace collapsing, line breaks, indentation, run merging.

/**
 * Copies a string out of the parser's source. htmlparser2 hands out V8 sliced strings (text and
 * attribute values) that would keep the whole, possibly 60 MB, document alive while converted
 * blocks sit in a cache; concatenating with a prefix and slicing it off forces V8 to flatten into
 * a fresh string. Strings shorter than 13 chars are never sliced/cons strings in V8.
 */
function own(s) {
  return s.length < 13 ? s : (' ' + s).slice(1);
}

class Runs {
  constructor() {
    /** @type {Array<[string, number] | [string, number, object]>} */
    this.r = [];
    this.sp = -1; // pending collapsed space: style bits of the whitespace, or -1
    this.spLink = null; // the link the pending space lies in
    this.nl = 0; // pending hard line breaks
    this.ind = 0; // pending indentation level for the next line start
    this.vis = false; // has visible (non-whitespace) content
    this.len = 0; // characters so far
    this.done = false;
  }

  atLineStart() {
    return this.r.length === 0 || this.nl > 0;
  }

  /** Appends text; the text of a link (`link`: the run's link object, §3.5) is a run of its own. */
  push(text, bits, link = null) {
    this.len += text.length;
    const r = this.r;
    const last = r[r.length - 1];
    if (last !== undefined && last[1] === bits && (link ? last[2] === link : last.length === 2)) last[0] += text;
    else r.push(link ? [text, bits, link] : [text, bits]);
  }

  /** Appends HTML text (not inside pre): collapses ASCII whitespace runs to one space. */
  text(s, bits, link = null) {
    if (this.done) return;
    // replace() yields a fresh string; untouched long text must be copied out of the source.
    const t = WS_TEST.test(s) ? s.replace(WS_RUN, ' ') : own(s);
    const n = t.length;
    if (n === 0) return;
    const lead = t.charCodeAt(0) === 32;
    const trail = n > 1 && t.charCodeAt(n - 1) === 32;
    if (lead) this.space(bits, link);
    const core = lead || trail ? t.slice(lead ? 1 : 0, trail ? n - 1 : n) : t;
    if (core.length === 0) return;
    this.word(core, bits, link);
    if (trail) this.space(bits, link);
  }

  /** Records collapsible whitespace; it materializes only if more content follows on the line. */
  space(bits, link = null) {
    if (this.r.length !== 0 && this.nl === 0 && this.sp < 0) {
      this.sp = bits;
      this.spLink = link;
    }
  }

  /** Materializes pending line breaks and indentation before new content. */
  lead(bits) {
    const r = this.r;
    if (this.nl > 0) {
      // Newlines attach to the preceding run so a line break never starts a new styled run.
      const nl = this.nl > 1 ? '\n\n' : '\n';
      const last = r[r.length - 1];
      if (last.length === 2) last[0] += nl;
      else r.push([nl, last[1]]); // after an image
      this.nl = 0;
      this.sp = -1;
    }
    if (this.ind > 0) {
      if (this.sp < 0) this.push(NBSP.repeat(2 * this.ind), bits);
      this.ind = 0;
    }
  }

  /** Appends text that has no leading/trailing collapsible whitespace. */
  word(core, bits, link = null) {
    this.lead(bits);
    if (this.sp >= 0) {
      if (this.sp === bits && this.spLink === link) core = ' ' + core;
      else this.push(' ', this.sp, this.spLink === link ? link : null);
      this.sp = -1;
    }
    this.push(core, bits, link);
    if (!this.vis && VISIBLE.test(core)) this.vis = true;
  }

  /**
   * An inline image: a run of one U+FFFC carrying { src, w, h, va?, alt?, inv? } (SPEC §3.5), and
   * its link's fields when it lies in one.
   */
  image(img, bits, link = null) {
    if (this.done) return;
    this.lead(bits);
    if (this.sp >= 0) {
      this.push(' ', this.sp, this.spLink === link ? link : null);
      this.sp = -1;
    }
    if (link) Object.assign(img, link);
    this.r.push([OBJ, bits, img]);
    this.len += 1;
    this.vis = true;
  }

  /** Explicit `<br>`: ignored at the start of the block; trailing ones are dropped at finish(). */
  br() {
    if (this.done || this.r.length === 0) return;
    this.nl++;
    this.sp = -1;
    this.ind = 0;
  }

  /** Implicit line break (block element inside a heading/cell, verse line element). */
  softBreak() {
    if (this.done || this.r.length === 0) return;
    if (this.nl === 0) this.nl = 1;
    this.sp = -1;
  }

  /** Requests indentation for the line about to start. */
  indent(level) {
    if (level > 0 && this.atLineStart()) this.ind = level;
  }

  /** @returns {Array<[string, number]>|null} the runs, or null when nothing visible */
  finish() {
    this.done = true;
    if (!this.vis) return null;
    const r = this.r;
    // Drop blank (whitespace/NBSP-only) leading and trailing lines.
    while (r.length) {
      const m = /^\s*\n/.exec(r[0][0]);
      if (!m) break;
      r[0][0] = r[0][0].slice(m[0].length);
      if (r[0][0] === '') r.shift();
      else break;
    }
    while (r.length) {
      const last = r[r.length - 1];
      const m = /\n\s*$/.exec(last[0]);
      if (!m) break;
      last[0] = last[0].slice(0, m.index);
      if (last[0] === '') r.pop();
      else break;
    }
    return r.length ? r : null;
  }
}

/** An image run (§3.5): its third element is the image; a link's text run has one too. */
export function isImageRun(run) {
  return run.length > 2 && run[2].src !== undefined;
}

/** Appends `src` runs to `dst`, merging the boundary runs when their styles match. */
function appendRuns(dst, src) {
  let i = 0;
  const last = dst[dst.length - 1];
  if (last && src.length && src[0][1] === last[1] && last.length === 2 && src[0].length === 2) {
    last[0] += src[0][0];
    i = 1;
  }
  for (; i < src.length; i++) dst.push(src[i]);
}

/** The images of runs that hold nothing visible besides images, else null. */
function imagesOnly(r) {
  let imgs = null;
  for (const run of r) {
    if (isImageRun(run)) (imgs ??= []).push(run[2]);
    else if (VISIBLE.test(run[0])) return null;
  }
  return imgs;
}

/** An image block for an inline image that stands alone; a formula stays sized with the text (`em`). */
function imageBlock(img, q) {
  const blk = { t: 'img', src: img.src, w: Math.max(1, Math.round(img.w)), h: Math.max(1, Math.round(img.h)) };
  if (FORMULAS.has(img)) blk.em = 1;
  if (img.alt) blk.alt = img.alt;
  if (img.inv) blk.inv = 1;
  if (q) blk.q = q;
  return blk;
}

/** Inline size of an <img> (CSS px at a 16 px font), or null for a block image. */
function inlineSize(attribs) {
  const cls = attribs.class;
  const inv = !!cls && RE_INVERT.test(cls);
  if (cls && RE_MATH_INLINE.test(cls)) {
    const st = attribs.style ?? '';
    const w = exLength(st, 'width');
    const h = exLength(st, 'height');
    if (w > 0 && h > 0) {
      return { w: round1(w * EX_PX), h: round1(h * EX_PX), va: round1(exLength(st, 'vertical-align') * EX_PX), inv, formula: true };
    }
  }
  const w = numericAttr(attribs.width);
  const h = numericAttr(attribs.height);
  if (w && h && h <= INLINE_IMG_MAX_H) return { w, h, va: 0, inv };
  return null;
}

/** A CSS length in ex from an inline style, or 0. */
function exLength(style, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?\\d*\\.?\\d+)ex`, 'i').exec(style);
  return m ? +m[1] : 0;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// List markers

function alpha(n) {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'],
    [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of table) while (n >= v) { s += r; n -= v; }
  return s;
}

function listMarker(n, type) {
  switch (type) {
    case 'a': return (n > 0 ? alpha(n) : String(n)) + '.';
    case 'A': return (n > 0 ? alpha(n).toUpperCase() : String(n)) + '.';
    case 'i': return roman(n) + '.';
    case 'I': return roman(n).toUpperCase() + '.';
    default: return n + '.';
  }
}

// ---------------------------------------------------------------------------------------------
// The converter

// Frame kinds (bit flags) decide what happens when the element closes.
const K_BLOCK = 1; // ends the current block (or soft-breaks inside a heading/cell)
const K_CAPTURE = 2; // <title> / <style>
const K_LINE = 4; // verse line element / display:block inline: soft break on close
const K_TABLE = 8;
const K_ROW = 16;
const K_CELL = 32;
const K_PRE = 64;
const K_NESTED = 128; // structure of a table nested in a cell, flattened into that cell

// Block structure that cannot live in a table cell's runs. Meeting it in a row that is not part
// of a data grid means the table lays out the page (old PG books wrap whole chapters in one
// cell): that row is turned back into normal flow instead of becoming one giant unsplittable
// `tr`. Rows of real grids keep their cells (the structure is flattened into line breaks) unless
// a cell grows beyond LAYOUT_CELL_CHARS.
const LAYOUT_TRIGGERS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'hr', 'menu', 'dir',
]);
const LAYOUT_CELL_BLOCKS = 3; // the 3rd <p>/<div> inside one cell
const LAYOUT_CELL_CHARS = 2000;

const ROOT_CTX = Object.freeze({
  bits: 0, skip: 0, foreign: false, align: undefined, q: 0, verse: null, verseOuter: null,
  stanza: null, heading: 0, pre: false, list: null, li: null, table: null, cell: null, nest: 0,
  blockFrame: null, blank: false, link: null,
});

/** The cell receiving inline content, unless its row was turned into normal flow. */
function liveCell(ctx) {
  const cell = ctx.cell;
  return cell !== null && !cell.flow ? cell : null;
}

class Converter {
  constructor(docPath) {
    this.docPath = docPath;
    this.out = [];
    this.title = null;
    this.css = new Map();
    this.infoCache = new Map();
    this.stack = [{ name: '#root', ctx: ROOT_CTX, kind: 0, mark: 0 }];
    this.cur = null; // block being built: { t, l, a, q, v, vg, stanza, li, id, runs }
    this.pendingId = null;
    this.pendingIndent = 0;
    this.capture = null; // 'title' | 'css'
    this.capBuf = '';
    this.pre = null; // { buf, q, id }
    this.deferred = []; // images met inside <pre>, emitted after it
    this.tableCount = 0;
    this.lastVerse = null; // { vg, q, a, blk } for merging verse lines into one block
    this.emitted = 0;
    this.ids = null; // ids noted since the last block went out (placeIds)
    this.box = null; // the MediaWiki infobox being captured: { main, frame }
    this.facts = null; // its blocks, waiting for the end of the lead section
  }

  get top() {
    return this.stack[this.stack.length - 1];
  }

  info(name, attribs) {
    const cls = attribs.class;
    const key = cls ? name + ' ' + cls : name;
    let info = this.infoCache.get(key);
    if (info === undefined) {
      info = classInfo(name, cls, this.css);
      this.infoCache.set(key, info);
    }
    const style = attribs.style;
    const hidden = attribs.hidden !== undefined || (attribs.id !== undefined && MW_CHROME_IDS.has(attribs.id));
    const pgHeader = attribs.id === 'pg-header' || (info.boiler && attribs.id !== 'pg-footer');
    if (style || hidden || pgHeader) {
      info = { ...info };
      if (style) {
        const p = parseDecls(style);
        if (p) applyProps(info, p);
      }
      if (hidden || pgHeader) info.skip = 1;
    }
    return info;
  }

  // --- id handling ---------------------------------------------------------------------------

  noteId(id) {
    if (!id || PARSOID_ID.test(id)) return;
    (this.ids ??= []).push(own(id));
    const ctx = this.top.ctx;
    if (this.cur && !liveCell(ctx) && !ctx.pre) {
      if (!this.cur.id) this.cur.id = id;
    } else if (!this.pendingId) {
      this.pendingId = id;
    }
  }

  takeId(blk) {
    if (this.pendingId) {
      blk.id = own(this.pendingId);
      this.pendingId = null;
    }
    return blk;
  }

  // --- output ----------------------------------------------------------------------------------

  emit(blk) {
    if (blk.t === 'hr') {
      const prev = this.out[this.out.length - 1];
      if (prev && prev.t === 'hr') return;
    }
    if (this.facts && !this.box && blk.t === 'h' && blk.l <= 2) this.emitFacts();
    this.placeIds(blk);
    this.out.push(blk);
    this.emitted++;
  }

  /**
   * The ids noted since the last block went out belong to `blk` (BLOCK_IDS): an id inside a
   * paragraph, or before a block. (Rows are buffered until their table ends: theirs go to its first.)
   */
  placeIds(blk) {
    const ids = this.ids;
    if (!ids) return;
    this.ids = null;
    const had = BLOCK_IDS.get(blk);
    BLOCK_IDS.set(blk, had ? had.concat(ids) : ids);
  }

  // --- MediaWiki infoboxes -----------------------------------------------------------------------
  // A Wikipedia article starts with its infobox (a table of facts, flags and icons). It is laid
  // out in a book as: its first image at the top (with its caption), the article's lead, then the
  // rest of the infobox under "Quick facts" before the first section.

  startInfobox(frame) {
    this.box = { main: this.out, frame };
    this.out = [];
  }

  endInfobox() {
    const blocks = this.out;
    this.out = this.box.main;
    this.box = null;
    const i = blocks.findIndex((b) => b.t === 'img');
    if (i >= 0) {
      const [img] = blocks.splice(i, 1);
      this.emit(img);
      // A one-cell row right after the image is its caption.
      const next = blocks[i];
      const cells = next?.t === 'tr' ? next.c.filter((c) => c.length) : [];
      if (cells.length === 1 && next.c.length === 1) {
        blocks.splice(i, 1);
        const r = []; // the caption's runs, smaller
        for (const run of cells[0]) {
          const bits = run[1] | 128;
          const last = r[r.length - 1];
          if (run.length > 2) r.push([run[0], bits, run[2]]);
          else if (last && last.length === 2 && last[1] === bits) last[0] += run[0];
          else r.push([run[0], bits]);
        }
        this.emit({ t: 'p', r, a: 'c' });
      }
    }
    if (blocks.some((b) => b.t !== 'hr')) (this.facts ??= []).push(...blocks);
  }

  emitFacts() {
    const facts = this.facts;
    this.facts = null;
    this.out.push({ t: 'h', l: 2, r: [[FACTS_TITLE, 0]] });
    for (const b of facts) this.out.push(b);
    this.emitted += facts.length + 1;
  }

  startBlock(ctx) {
    const b = {
      t: 'p', l: 0, a: ctx.align || '', q: ctx.q, v: 0, vg: null, stanza: null, li: null,
      id: this.pendingId, runs: new Runs(),
    };
    this.pendingId = null;
    if (ctx.heading) {
      b.t = 'h';
      b.l = ctx.heading;
    } else if (ctx.li) {
      b.t = 'li';
      b.li = ctx.li;
    } else if (ctx.verse) {
      b.v = 1;
      // A verse container that is itself the block element (div.stanza holding <br/>-separated
      // lines) groups with its enclosing container; otherwise lines group by their container.
      b.vg = ctx.verse === ctx.blockFrame ? ctx.verseOuter : ctx.verse;
      b.stanza = ctx.stanza;
    }
    if (this.pendingIndent) {
      b.runs.indent(this.pendingIndent);
      this.pendingIndent = 0;
    }
    this.cur = b;
    return b;
  }

  flush() {
    const b = this.cur;
    if (!b) return;
    this.cur = null;
    const r = b.runs.finish();
    if (!r) {
      if (b.v) this.lastVerse = null; // blank line inside a poem separates stanzas
      if (b.id && !this.pendingId) this.pendingId = b.id;
      return;
    }
    const imgs = imagesOnly(r);
    if (imgs) {
      // Small images standing alone (a formula on its own line, an ornament): image blocks.
      imgs.forEach((img, i) => {
        const blk = imageBlock(img, b.q);
        if (i === 0 && b.id) blk.id = own(b.id);
        this.emit(blk);
      });
      this.lastVerse = null;
      return;
    }
    let blk;
    if (b.t === 'h') {
      blk = { t: 'h', l: b.l, r };
      if (b.a) blk.a = b.a;
    } else if (b.t === 'li') {
      blk = { t: 'li', r, d: b.li.depth, m: b.li.used ? '' : b.li.marker };
      b.li.used = true;
      if (b.q) blk.q = b.q;
    } else {
      blk = { t: 'p', r };
      if (b.a) blk.a = b.a;
      if (b.q) blk.q = b.q;
      if (b.v) {
        blk.v = 1;
        const stanzaStart = b.stanza !== null && b.stanza.pending;
        if (b.stanza) b.stanza.pending = false;
        const lv = this.lastVerse;
        if (!stanzaStart && b.vg && lv && lv.vg === b.vg && lv.q === b.q && lv.a === b.a &&
            this.out[this.out.length - 1] === lv.blk) {
          const dst = lv.blk.r;
          const last = dst[dst.length - 1];
          if (last.length === 2) last[0] += '\n';
          else dst.push(['\n', last[1]]);
          appendRuns(dst, r);
          if (!lv.blk.id && b.id) lv.blk.id = own(b.id);
          this.placeIds(lv.blk);
          this.emitted++;
          return;
        }
      }
    }
    if (b.id) blk.id = own(b.id);
    this.emit(blk);
    this.lastVerse = b.v && b.vg ? { vg: b.vg, q: b.q, a: b.a, blk } : null;
  }

  /** The run sink for inline content, creating a block lazily. */
  sink(ctx) {
    const cell = liveCell(ctx);
    if (cell) return cell.runs;
    return (this.cur ?? this.startBlock(ctx)).runs;
  }

  /** Soft line break in the current inline context, if any content exists. */
  softBreak(ctx) {
    const cell = liveCell(ctx);
    if (cell) cell.runs.softBreak();
    else if (this.cur) this.cur.runs.softBreak();
  }

  emitDeferred() {
    if (!this.deferred.length) return;
    const imgs = this.deferred;
    this.deferred = [];
    for (const img of imgs) this.emit(img);
  }

  /** Alt text of an image that cannot be shown, or of <math alttext>. */
  altText(text, ctx, asParagraph) {
    text = text.replace(WS_RUN, ' ').trim();
    if (!text) return;
    const cell = liveCell(ctx);
    if (cell || ctx.pre || !asParagraph) {
      if (ctx.pre && !cell) this.pre.buf += text;
      else this.sink(ctx).text(text, ctx.bits | (asParagraph ? 1 : 0), ctx.link);
      return;
    }
    this.flush();
    const blk = this.takeId({ t: 'p', r: [[own(text), 1]] });
    if (ctx.align) blk.a = ctx.align;
    if (ctx.q) blk.q = ctx.q;
    this.emit(blk);
  }

  image(attribs, ctx) {
    if (ctx.blank) return;
    const src = resolveHref(attribs.src ?? '', this.docPath);
    const alt = (attribs.alt ?? '').replace(SHY, '').replace(WS_RUN, ' ').trim();
    if (!src) {
      if (alt) this.altText(alt, ctx, true);
      return;
    }
    const inline = ctx.pre ? null : inlineSize(attribs);
    if (inline) {
      const img = { src: own(src), w: inline.w, h: inline.h };
      if (inline.va) img.va = inline.va;
      if (alt) img.alt = own(alt);
      if (inline.inv) img.inv = 1;
      if (inline.formula) FORMULAS.add(img);
      this.sink(ctx).image(img, ctx.bits, ctx.link);
      return;
    }
    const blk = { t: 'img', src: own(src) };
    const w = numericAttr(attribs.width);
    const h = numericAttr(attribs.height);
    if (w) blk.w = w;
    if (h) blk.h = h;
    if (alt) blk.alt = own(alt);
    if (ctx.q) blk.q = ctx.q;
    const cell = liveCell(ctx);
    if (cell) {
      // Images cannot sit in a row: they go before the row when nothing precedes them in it
      // (image-above-caption layouts), after it otherwise.
      if (attribs.id) blk.id = own(attribs.id);
      const row = cell.row;
      const before = cell.runs.r.length === 0 && row.cells.every((c) => c.length === 0);
      (before ? row.imgsBefore : row.imgs).push(blk);
      return;
    }
    if (ctx.pre) {
      if (attribs.id) blk.id = own(attribs.id);
      this.deferred.push(blk);
      return;
    }
    this.flush();
    this.takeId(blk);
    if (!blk.id && attribs.id) blk.id = own(attribs.id);
    this.emit(blk);
  }

  // --- tables ----------------------------------------------------------------------------------
  // Rows are buffered per table until it ends: a table where no row has two filled cells is a
  // layout device (image + caption, a framed poem) and is emitted as paragraphs instead.

  startRow(table, ctx) {
    if (table.row) this.endRow(table);
    const row = {
      cells: [], aligns: [], th: true, q: ctx.q, id: this.pendingId, imgs: [], imgsBefore: [],
      flow: false,
    };
    this.pendingId = null;
    table.row = row;
    return row;
  }

  startCell(table, ctx, isTh, align) {
    if (!table.row) this.startRow(table, ctx);
    this.endCell(table);
    const row = table.row;
    const cell = { runs: new Runs(), table, row, align, blocks: 0, flow: row.flow };
    if (row.flow) return cell; // a cell of a flow row is a plain block container
    table.cell = cell;
    if (!isTh) row.th = false;
    if (this.pendingIndent) {
      cell.runs.indent(this.pendingIndent);
      this.pendingIndent = 0;
    }
    return cell;
  }

  endCell(table) {
    const cell = table.cell;
    if (!cell) return;
    table.cell = null;
    cell.row.cells.push(cell.runs.finish() ?? []);
    cell.row.aligns.push(cell.align);
  }

  endRow(table) {
    const row = table.row;
    if (!row) return;
    this.endCell(table);
    table.row = null;
    if (row.flow) return;
    let filled = 0;
    for (const c of row.cells) if (c.length) filled++;
    if (filled > 1) table.multi = true;
    table.buf.push(row);
  }

  endTable(table) {
    this.endRow(table);
    this.emitRows(table, table.multi);
  }

  /** Emits buffered rows as `tr` blocks (asGrid) or as one paragraph per filled cell. */
  emitRows(table, asGrid) {
    const rows = table.buf;
    table.buf = [];
    for (const row of rows) {
      let id = row.id;
      for (const img of row.imgsBefore) this.emit(img);
      if (asGrid) {
        if (row.cells.some((c) => c.length)) {
          const blk = { t: 'tr', c: row.cells, g: table.g };
          if (row.th && row.cells.length) blk.hd = true;
          if (row.q) blk.q = row.q;
          if (id) blk.id = own(id);
          id = null;
          this.emit(blk);
        }
      } else {
        row.cells.forEach((c, i) => {
          if (!c.length) return;
          const imgs = imagesOnly(c);
          if (imgs) {
            for (const img of imgs) {
              const blk = imageBlock(img, row.q);
              if (id) blk.id = own(id);
              id = null;
              this.emit(blk);
            }
            return;
          }
          const blk = { t: 'p', r: c };
          if (row.aligns[i]) blk.a = row.aligns[i];
          if (row.q) blk.q = row.q;
          if (id) blk.id = own(id);
          id = null;
          this.emit(blk);
        });
      }
      for (const img of row.imgs) this.emit(img);
      if (id && !this.pendingId) this.pendingId = id;
    }
  }

  /** Turns the current row of a layout table into normal flow (see LAYOUT_TRIGGERS). */
  rowToFlow(table) {
    const row = table.row;
    if (!row || row.flow) return;
    this.emitRows(table, table.multi); // keep document order
    row.flow = true;
    const cell = table.cell;
    table.cell = null;
    if (cell) {
      const r = cell.runs.finish();
      if (r) {
        row.cells.push(r);
        row.aligns.push(cell.align);
      }
      cell.flow = true; // what is still to come in this cell becomes normal blocks
    }
    table.buf = [{ ...row }];
    this.emitRows(table, false);
    row.cells = [];
    row.aligns = [];
    row.imgs = [];
    row.imgsBefore = [];
  }

  // --- parser callbacks --------------------------------------------------------------------------

  onopentag(name, attribs) {
    const parent = this.top;
    const pctx = parent.ctx;
    const frame = { name, ctx: pctx, kind: 0, mark: 0 };

    // Raw-text capture works even inside skipped <head>.
    if ((name === 'title' || name === 'style') && !pctx.foreign) {
      this.capture = name === 'title' ? 'title' : 'css';
      this.capBuf = '';
      frame.kind = K_CAPTURE;
      if (name === 'style' || pctx.skip) frame.ctx = pctx.skip ? pctx : skipCtx(pctx, 1);
      this.stack.push(frame);
      return;
    }

    if (pctx.skip) {
      if (pctx.skip === 2) this.noteId(attribs.id || (name === 'a' ? attribs.name : undefined));
      if ((name === 'svg' || name === 'math') && !pctx.foreign) frame.ctx = { ...pctx, foreign: true };
      this.stack.push(frame);
      return;
    }

    if (SKIP_TAGS.has(name)) {
      if (name === 'math' && attribs.alttext) this.altText(attribs.alttext, pctx, false);
      frame.ctx = skipCtx(pctx, 1, name === 'svg' || name === 'math');
      this.stack.push(frame);
      return;
    }

    const info = this.info(name, attribs);
    if (info.skip) {
      if (info.skip === 2) this.noteId(attribs.id || (name === 'a' ? attribs.name : undefined));
      frame.ctx = skipCtx(pctx, info.skip);
      this.stack.push(frame);
      return;
    }

    const heading = HEADING_LEVEL[name] || 0;
    let ctx = pctx;
    const mut = () => (ctx === pctx ? (ctx = { ...pctx }) : ctx);

    const bits = (pctx.bits & ~info.clear) | info.set | (info.caption ? 128 : 0);
    if (bits !== pctx.bits) mut().bits = bits;
    if (name === 'a' && attribs.href !== undefined) {
      const href = linkTarget(attribs.href, this.docPath);
      mut().link = href ? { href: own(href) } : null; // one object per link: its runs share it
    }
    if (info.caption) mut().align = 'c';
    else if (info.align !== undefined) mut().align = info.align;
    if (info.quote) mut().q = pctx.q + 1;
    if (info.blank) mut().blank = true;
    if (info.verse) {
      mut();
      ctx.verseOuter = pctx.verse;
      ctx.verse = frame;
      if (info.stanza) {
        frame.pending = true;
        ctx.stanza = frame;
      }
    }

    if (BLOCK_TAGS.has(name) || name === 'img' || name === 'br' || name === 'hr') {
      // structure() may refine the context through mut() (which updates `ctx` above).
      this.structure(name, attribs, info, frame, pctx, heading, mut);
    }

    if (info.line || (info.verseLine && ctx.verse)) {
      frame.kind |= K_LINE;
      this.softBreak(ctx);
    }
    if (info.indent > 0) {
      const cell = liveCell(ctx);
      if (cell) cell.runs.indent(info.indent);
      else if (this.cur && !ctx.pre) this.cur.runs.indent(info.indent);
      else if (!ctx.pre) this.pendingIndent = info.indent;
    }

    frame.ctx = ctx;
    frame.mark = this.emitted;
    this.stack.push(frame);
    const id = name === 'img' ? undefined : attribs.id || (name === 'a' ? attribs.name : undefined);
    if (id) this.noteId(id);
  }

  /**
   * Handles block-level / void structural elements on open; sets frame.kind and refines ctx.
   * Inside a table cell, block elements become line breaks in the cell; inside a heading, line
   * breaks in the heading; inside <pre> they carry no structure.
   */
  structure(name, attribs, info, frame, pctx, heading, mut) {
    const cell = liveCell(pctx);
    if (name === 'br') {
      if (cell) {
        if (cell.runs.len > LAYOUT_CELL_CHARS) this.rowToFlow(cell.table);
        else cell.runs.br();
      } else if (pctx.pre) {
        this.pre.buf += '\n';
      } else if (this.cur) {
        this.cur.runs.br();
      }
      return;
    }
    if (pctx.pre && !cell) {
      if (name === 'img') this.image(attribs, pctx);
      return;
    }

    const tableTag = name === 'td' || name === 'th' || name === 'tr';
    if (cell && !(tableTag && pctx.nest === 0)) {
      if (name === 'img') {
        this.image(attribs, pctx);
        return;
      }
      const structural = LAYOUT_TRIGGERS.has(name) ||
        ((name === 'p' || name === 'div') && ++cell.blocks >= LAYOUT_CELL_BLOCKS);
      if (cell.runs.len > LAYOUT_CELL_CHARS ||
          (structural && !cell.table.multi && cell.row.cells.every((c) => c.length === 0))) {
        this.rowToFlow(cell.table);
        this.structure(name, attribs, info, frame, pctx, heading, mut); // now as normal flow
        return;
      }
      // Flattened into the cell's runs (including a nested data table, SPEC §3.3).
      const runs = cell.runs;
      if (name === 'td' || name === 'th') {
        runs.space(0);
        frame.kind = K_NESTED;
        return;
      }
      runs.softBreak();
      frame.kind = K_BLOCK | (name === 'table' || name === 'tr' ? K_NESTED : 0);
      if (name === 'table') mut().nest = pctx.nest + 1;
      if (name === 'li') {
        const marker = this.nextMarker(pctx, attribs, info);
        if (marker) runs.text(marker + ' ', pctx.bits);
      }
      return;
    }

    if (name === 'img') {
      this.image(attribs, pctx);
      return;
    }

    if (pctx.heading && !heading && name !== 'table' && name !== 'hr') {
      // e.g. <h2>Title<div>subtitle</div></h2>: stay in the heading block.
      if (this.cur) this.cur.runs.softBreak();
      frame.kind = K_BLOCK;
      return;
    }

    if (name === 'hr') {
      if (pctx.heading) return;
      this.flush();
      this.emit({ t: 'hr' });
      return;
    }

    // (A cell/row start inside a live cell of the same table only happens with malformed nesting,
    // <td><p>…<td>: it is treated as the next cell/row.)
    if (tableTag && pctx.table) {
      const table = pctx.table;
      this.flush();
      if (name === 'tr') {
        frame.kind = K_ROW;
        frame.table = table;
        frame.row = this.startRow(table, pctx);
        return;
      }
      const newCell = this.startCell(table, pctx, name === 'th', mut().align || '');
      frame.kind = K_CELL;
      frame.cell = newCell;
      const ctx = mut();
      ctx.cell = newCell;
      ctx.li = null;
      ctx.heading = 0;
      return;
    }

    this.flush();
    frame.kind = K_BLOCK;
    const ctx = mut();
    ctx.blockFrame = frame;

    if (heading) {
      ctx.heading = heading;
      return;
    }
    switch (name) {
      case 'table': {
        const table = { g: ++this.tableCount, row: null, cell: null, buf: [], multi: false };
        ctx.table = table;
        ctx.cell = null;
        ctx.nest = 0;
        frame.kind = K_BLOCK | K_TABLE;
        frame.table = table;
        if (!this.box && attribs.class && RE_INFOBOX.test(attribs.class)) this.startInfobox(frame);
        break;
      }
      case 'ul': case 'ol': case 'menu': case 'dir': {
        const ordered = name === 'ol';
        const type = info.listType ?? (ordered ? attribs.type : null) ?? '1';
        const start = ordered ? parseInt(attribs.start, 10) : NaN;
        ctx.list = {
          ordered, type, next: Number.isFinite(start) ? start : 1,
          depth: (pctx.list ? pctx.list.depth : 0) + 1, nomarker: info.nomarker,
        };
        ctx.li = null;
        break;
      }
      case 'li':
        ctx.li = {
          marker: this.nextMarker(pctx, attribs, info), used: false, depth: pctx.list ? pctx.list.depth : 1,
        };
        break;
      case 'pre':
        this.pre = { buf: '', q: pctx.q, id: this.pendingId };
        this.pendingId = null;
        ctx.pre = true;
        frame.kind = K_PRE;
        break;
      default:
        // td/th/tr outside any table behave like plain block containers.
    }
  }

  nextMarker(pctx, attribs, info) {
    const list = pctx.list;
    if (!list) return info.nomarker ? '' : '\u2022';
    const value = parseInt(attribs.value, 10);
    if (list.ordered) {
      if (Number.isFinite(value)) list.next = value;
      const n = list.next++;
      if (list.nomarker || info.nomarker) return '';
      return listMarker(n, info.listType ?? list.type);
    }
    return list.nomarker || info.nomarker ? '' : '\u2022';
  }

  ontext(text) {
    if (this.capture) {
      this.capBuf += text;
      return;
    }
    const ctx = this.top.ctx;
    if (ctx.skip) return;
    if (text.indexOf('\u00ad') >= 0) text = text.replace(SHY, '');
    if (ctx.blank) text = text.replace(INVISIBLE_CHARS, NBSP);
    const cell = liveCell(ctx);
    if (cell) {
      cell.runs.text(text, ctx.bits, ctx.link);
      return;
    }
    if (ctx.pre) {
      this.pre.buf += text;
      return;
    }
    if (!this.cur && ALL_WS.test(text)) return;
    (this.cur ?? this.startBlock(ctx)).runs.text(text, ctx.bits, ctx.link);
  }

  onclosetag(name) {
    const frame = this.stack.pop();
    if (this.stack.length === 0) { // never pop the root (defensive: unbalanced events)
      this.stack.push(frame);
      return;
    }
    const kind = frame.kind;
    if (kind === 0) return;
    if (kind & K_CAPTURE) {
      if (this.capture === 'title') {
        const t = this.capBuf.replace(SHY, '').replace(WS_RUN, ' ').trim();
        if (this.title === null && t) this.title = own(t);
      } else if (this.capture === 'css') {
        parseCss(this.capBuf, this.css);
        this.infoCache.clear();
      }
      this.capture = null;
      this.capBuf = '';
      return;
    }
    const ctx = frame.ctx; // the element's own context
    const pctx = this.top.ctx;
    if (kind & K_LINE) this.softBreak(ctx);
    if (kind & K_NESTED) {
      const cell = liveCell(pctx);
      if (cell && name !== 'td' && name !== 'th') cell.runs.softBreak();
      return;
    }
    if (kind & K_CELL) {
      const cell = frame.cell;
      if (cell.flow) this.flush();
      else if (cell.table.cell === cell) this.endCell(cell.table);
      return;
    }
    if (kind & K_ROW) {
      const table = frame.table;
      if (frame.row.flow) this.flush();
      if (table.row === frame.row) this.endRow(table);
      return;
    }
    if (kind & K_TABLE) {
      this.flush();
      this.endTable(frame.table);
      if (this.box?.frame === frame) this.endInfobox();
      return;
    }
    if (kind & K_PRE) {
      this.endPre();
      return;
    }
    if (kind & K_BLOCK) {
      const cell = liveCell(pctx);
      if (cell) {
        cell.runs.softBreak();
      } else if (pctx.heading && !HEADING_LEVEL[name]) {
        if (this.cur) this.cur.runs.softBreak(); // block nested in a heading
      } else {
        this.flush();
        // An element that produced nothing inside a poem (spacer <div class="line"></div>,
        // <p>&nbsp;</p>) separates stanzas.
        if (ctx.verse && this.emitted === frame.mark) this.lastVerse = null;
      }
    }
  }

  endPre() {
    const pre = this.pre;
    this.pre = null;
    if (!pre) return;
    let x = pre.buf.replace(/\r\n?/g, '\n');
    if (x.charCodeAt(0) === 10) x = x.slice(1);
    x = x.replace(/[ \t\n\r\f]+$/, '');
    if (x.includes('\t')) x = expandTabs(x);
    if (VISIBLE.test(x)) {
      const blk = { t: 'pre', x: own(x) };
      if (pre.q) blk.q = pre.q;
      const id = pre.id ?? this.pendingId;
      if (id) blk.id = own(id);
      if (!pre.id) this.pendingId = null;
      this.emit(blk);
    }
    this.emitDeferred();
  }

  onend() {
    // htmlparser2 closes all open elements before onend; flush whatever is left.
    if (this.pre) this.endPre();
    this.flush();
    this.emitDeferred();
    if (this.box) this.endInfobox(); // unclosed
    if (this.facts) this.emitFacts();
  }
}

function skipCtx(pctx, level, foreign = pctx.foreign) {
  return { ...pctx, skip: level, foreign };
}

function numericAttr(v) {
  if (v === undefined) return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(v);
  if (!m) return 0;
  const n = Math.round(+m[1]);
  return n > 0 ? n : 0;
}

function expandTabs(x) {
  return x.split('\n').map((line) => {
    if (!line.includes('\t')) return line;
    let out = '';
    for (const ch of line) {
      if (ch === '\t') out += ' '.repeat(8 - (out.length % 8));
      else out += ch;
    }
    return out;
  }).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Converts one HTML (or XHTML) document into reader blocks (SPEC §3.3 / §3.5).
 * @param {string} html document source
 * @param {{ docPath: string }} opts archive path of the document (resolves images and links)
 * @returns {{ title: string|null, blocks: object[], ids: Map<string, object> }} ids: the block
 *   each element id of the document is in (what links point at: linkDocs)
 */
export function htmlToBlocks(html, { docPath = '' } = {}) {
  if (typeof html !== 'string') html = html ? platform.utf8(html) : '';
  if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);
  const conv = new Converter(docPath);
  const parser = new platform.Parser(conv, { decodeEntities: true, recognizeSelfClosing: true, lowerCaseTags: true });
  parser.end(html);
  const ids = new Map();
  for (const blk of conv.out) {
    if (blk.id && !ids.has(blk.id)) ids.set(blk.id, blk);
    for (const id of BLOCK_IDS.get(blk) ?? []) if (!ids.has(id)) ids.set(id, blk);
  }
  return { title: conv.title, blocks: conv.out, ids };
}

/**
 * Character weight of a block for chunking and progress: text length; img = 600; hr = 50.
 * @param {object} block
 * @returns {number}
 */
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

const TOC_MAX = 2000;
const TOC_TITLE_MAX = 120;

/**
 * Groups blocks into chunks and builds the TOC from headings (SPEC §3.5).
 * A chunk closes when it holds ≥ targetChars and the next block is a heading of level ≤ 2, when it
 * reaches 1.5 × targetChars (at any block boundary), or at maxBlocks blocks.
 * @param {object[]} blocks
 * @param {{ targetChars?: number, maxBlocks?: number }} [opts]
 * Links that linkDocs tied to blocks get their `at` here (placeLinks).
 * @returns {{ chunks: Array<{start: number, chars: number, blocks: object[]}>,
 *   toc: Array<{title: string, level: number, c: number, b: number}>, totalChars: number,
 *   tocTruncated: boolean, where: Map<object, [number, number]> }} where: each block's chunk and
 *   index in it
 */
export function chunkBlocks(blocks, { targetChars = 40000, maxBlocks = 3000 } = {}) {
  if (!blocks || blocks.length === 0) {
    const placeholder = { t: 'p', r: [[PLACEHOLDER_TEXT, 0]] };
    const chars = blockChars(placeholder);
    return { chunks: [{ start: 0, chars, blocks: [placeholder] }], toc: [], totalChars: chars, tocTruncated: false, where: new Map() };
  }
  let tocMaxLevel = 3;
  if (!blocks.some((b) => b.t === 'h' && b.l <= 3)) tocMaxLevel = 4;

  const chunks = [];
  const toc = [];
  let tocTruncated = false;
  let cur = [];
  let curChars = 0;
  let total = 0;
  const hardLimit = 1.5 * targetChars;
  for (const block of blocks) {
    if (cur.length > 0) {
      const nextIsBreak = block.t === 'h' && block.l <= 2;
      if ((curChars >= targetChars && nextIsBreak) || curChars >= hardLimit || cur.length >= maxBlocks) {
        chunks.push({ start: total - curChars, chars: curChars, blocks: cur });
        cur = [];
        curChars = 0;
      }
    }
    if (block.t === 'h' && block.l <= tocMaxLevel) {
      if (toc.length < TOC_MAX) {
        const title = tocTitle(block);
        if (title) toc.push({ title, level: block.l, c: chunks.length, b: cur.length });
      } else {
        tocTruncated = true;
      }
    }
    const n = blockChars(block);
    cur.push(block);
    curChars += n;
    total += n;
  }
  if (cur.length) chunks.push({ start: total - curChars, chars: curChars, blocks: cur });
  const where = new Map();
  chunks.forEach((ch, c) => ch.blocks.forEach((b, i) => where.set(b, [c, i])));
  placeLinks(blocks, (b) => where.get(b));
  return { chunks, toc, totalChars: total, tocTruncated, where };
}

function tocTitle(block) {
  let s = '';
  for (const run of block.r) if (!isImageRun(run)) s += run[0];
  s = s.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (s.length > TOC_TITLE_MAX) s = s.slice(0, TOC_TITLE_MAX - 1).trimEnd() + '\u2026';
  return s;
}

// ---------------------------------------------------------------------------------------------
// Image size sniffing

const SVG_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, ex: 8 };

function svgLength(v) {
  if (v === undefined) return 0;
  const m = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|em|ex)?\s*$/i.exec(v);
  if (!m) return 0;
  return +m[1] * SVG_UNITS[(m[2] || '').toLowerCase()];
}

function svgSize(buf) {
  const head = platform.utf8(buf, 0, Math.min(buf.length, 65536));
  const tag = /<svg\b[^>]*>/i.exec(head);
  if (!tag) return null;
  const attr = (n) => {
    const m = new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag[0]);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  let w = svgLength(attr('width'));
  let h = svgLength(attr('height'));
  const vb = attr('viewBox');
  if ((!w || !h) && vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) {
      if (w && !h) h = (w * p[3]) / p[2];
      else if (h && !w) w = (h * p[2]) / p[3];
      else { w = p[2]; h = p[3]; }
    }
  }
  if (!(w > 0 && h > 0)) return null;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function jpegSize(b) {
  let i = 2;
  const n = b.length;
  while (i + 3 < n) {
    if (b[i] !== 0xff) { i++; continue; } // tolerate garbage between segments
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any SOF
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= n) return null;
      const h = (b[i + 5] << 8) | b[i + 6];
      const w = (b[i + 7] << 8) | b[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Image dimensions from file header bytes: PNG, JPEG (SOFn scan), GIF, WebP (VP8/VP8L/VP8X), BMP,
 * SVG (width/height or viewBox).
 * @param {Uint8Array} buf
 * @returns {{ w: number, h: number } | null}
 */
export function imageSize(buf) {
  if (!buf || buf.length < 10) return buf && buf.length ? svgSizeSafe(buf) : null;
  const b = buf;
  const u16le = (o) => b[o] | (b[o + 1] << 8);
  const u32be = (o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const u32le = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
  const ok = (w, h) => (w > 0 && h > 0 ? { w, h } : null);

  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    return ok(u32be(16), u32be(20));
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return ok(u16le(6), u16le(8));
  // WebP
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8 ') {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (fourcc === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
      return ok(w, h);
    }
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return ok(w, h);
    }
    return null;
  }
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const dib = u32le(14);
    if (dib === 12) return ok(u16le(18), u16le(20));
    if (dib >= 40) {
      const w = u32le(18) | 0;
      const h = u32le(22) | 0;
      return ok(Math.abs(w), Math.abs(h));
    }
    return null;
  }
  return svgSizeSafe(b);
}

function svgSizeSafe(b) {
  // Only bother decoding when the head looks like markup.
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  if (b[i] !== 0x3c) return null; // '<'
  try {
    return svgSize(b);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Link resolution

/**
 * Resolves a (possibly percent-encoded, relative) link against a document path.
 * Returns a normalized archive path ('C/37134_logo.png'), or null for external (scheme:) / empty
 * links. data: URIs are returned unchanged. Strips ?query and #fragment. Handles ./ ../ and a
 * leading /.
 * @param {string} href
 * @param {string} docPath e.g. 'C/The Elements of Style.37134' or 'OEBPS/chapter1.xhtml'
 * @returns {string|null}
 */
export function resolveHref(href, docPath) {
  if (typeof href !== 'string') return null;
  href = href.trim();
  if (!href) return null;
  if (/^data:/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const cut = href.search(/[?#]/);
  if (cut >= 0) href = href.slice(0, cut);
  if (!href) return null;
  const parts = [];
  if (!href.startsWith('/') && docPath) {
    const base = String(docPath).split('/');
    base.pop(); // the document itself
    for (const seg of base) if (seg) parts.push(seg);
  }
  for (const raw of href.split('/')) {
    let seg = raw;
    if (seg.includes('%')) {
      try {
        seg = decodeURIComponent(seg);
      } catch {
        // malformed escape: keep the raw segment
      }
    }
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Where a link goes (SPEC §3.5): '#<id>' for a place in the same document, '<archive path>' or
 * '<archive path>#<id>' for another document, null for nothing to follow (an external or empty
 * link, a link to the document itself without a place). The fragment is percent-decoded, as ids
 * are written.
 * @param {string} href
 * @param {string} docPath
 * @returns {string|null}
 */
export function linkTarget(href, docPath) {
  if (typeof href !== 'string') return null;
  href = href.trim();
  const hash = href.indexOf('#');
  let frag = hash >= 0 ? href.slice(hash + 1) : '';
  if (frag.includes('%')) {
    try {
      frag = decodeURIComponent(frag);
    } catch {
      // malformed escape: keep it as written
    }
  }
  const before = hash >= 0 ? href.slice(0, hash) : href;
  if (!before.replace(/\?.*$/, '')) return frag ? `#${frag}` : null;
  const path = resolveHref(before, docPath);
  if (!path || path.startsWith('data:')) return null;
  if (path === docPath) return frag ? `#${frag}` : null;
  return frag ? `${path}#${frag}` : path;
}

const LINK_TARGET = new WeakMap(); // link object → the block it leads to (linkDocs → placeLinks)

/** Calls fn(run) for every run of a block (a paragraph's, or each table cell's). */
function eachRun(block, fn) {
  if (block.r) for (const run of block.r) fn(run);
  else if (block.c) for (const cell of block.c) for (const run of cell) fn(run);
}

/**
 * Merges a block's neighbouring plain runs of the same style (§3.5), as after a link was dropped
 * and its text became plain.
 * @param {object} block
 */
export function mergeRuns(block) {
  const merge = (runs) => {
    let w = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const last = w > 0 ? runs[w - 1] : null;
      if (last && last.length === 2 && run.length === 2 && last[1] === run[1]) last[0] += run[0];
      else runs[w++] = run;
    }
    runs.length = w;
  };
  if (block.r) merge(block.r);
  else if (block.c) block.c.forEach(merge);
}

/** A run's link object (§3.5), or null. */
function linkOf(run) {
  const x = run.length > 2 ? run[2] : null;
  return x && (x.href !== undefined || x.at !== undefined || x.to !== undefined) ? x : null;
}

/** Drops a run's link (its text stays). */
function unlink(run, x) {
  delete x.href;
  delete x.at;
  delete x.to;
  if (x.src === undefined) run.length = 2;
}

/**
 * Resolves the links of a book made of documents converted one by one (htmlToBlocks): a link to a
 * place in the book is tied to the block it leads to (placeLinks, after chunking, makes that `at`:
 * [chunk, block]); a link elsewhere keeps its `href` (resolved when followed: the library's
 * resolveLink) when `keep` says so, else it is dropped and its text stays. A link to a document
 * leads to its `top` block (Wikisource: the part's heading), or to the block of its #id.
 * @param {Array<{ path: string, blocks: object[], ids: Map<string, object>, top?: object }>} docs
 * @param {{ keep?: boolean | ((path: string) => boolean) }} [opts]
 */
export function linkDocs(docs, { keep = false } = {}) {
  const byPath = new Map();
  for (const d of docs) if (!byPath.has(d.path)) byPath.set(d.path, d);
  const keeps = typeof keep === 'function' ? keep : () => keep;
  const seen = new Set(); // link objects already resolved (the runs of one link share one)
  for (const doc of docs) {
    for (const block of doc.blocks) {
      let dropped = false;
      eachRun(block, (run) => {
        const x = linkOf(run);
        if (!x) return;
        if (!seen.has(x)) {
          seen.add(x);
          const href = x.href;
          const hash = href.indexOf('#');
          const path = hash < 0 ? href : href.slice(0, hash);
          const id = hash < 0 ? '' : href.slice(hash + 1);
          const target = path ? byPath.get(path) : doc;
          if (target) {
            const to = (id && target.ids.get(id)) || (path && target !== doc ? target.top ?? target.blocks[0] : null);
            if (to) LINK_TARGET.set(x, to);
            else delete x.href; // a place the document does not have
          } else if (!path || !keeps(path)) {
            delete x.href;
          }
        }
        if (x.href === undefined && !LINK_TARGET.has(x)) {
          unlink(run, x);
          dropped = true;
        }
      });
      if (dropped) mergeRuns(block);
    }
  }
}

/**
 * Turns the links linkDocs tied to blocks into `at`: [chunk, block] (§3.5), with `where(block)`
 * saying where a block ended up (undefined: dropped, e.g. a missing image; its links go too).
 * @param {object[]} blocks
 * @param {(block: object) => [number, number] | undefined} where
 */
export function placeLinks(blocks, where) {
  for (const block of blocks) {
    let dropped = false;
    eachRun(block, (run) => {
      const x = linkOf(run);
      if (!x) {
        if (run.length > 2 && run[2].src === undefined) { // a link dropped by an earlier run
          run.length = 2;
          dropped = true;
        }
        return;
      }
      if (x.at !== undefined) return;
      const target = LINK_TARGET.get(x);
      if (!target) return;
      const at = where(target);
      if (at) {
        delete x.href;
        x.at = at;
      } else {
        unlink(run, x);
        dropped = true;
      }
    });
    if (dropped) mergeRuns(block);
  }
}
