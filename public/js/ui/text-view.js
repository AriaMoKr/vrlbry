// @ts-check
// The text view (SPEC §5.8): on a screen, the open book's current part as a page of text over
// the 3D view, for screen readers, the keyboard, zoom and phones. It shows the chunk the open
// page is in (a chapter-sized part, or one Wikipedia article), built from its blocks (§3.5) as
// DOM nodes and text, never as HTML. The 3D book stays the reading position: opening the view
// scrolls it to the open page's first block, turning pages keeps it in step, and closing it
// leaves the book open at the block at the top of the view. The view's own place is finer, the
// line within that block (its first word), which a size, Back and a turned phone bring back to
// the top, however tall the block. Its header is the reader's toolbar:
// contents, text size, theme, where the reader is, Back, Put back. On a TV (SPEC §5.9) the view
// itself holds the remote's focus while reading: ↑ ↓ scroll it, ← → turn the 3D book's pages, and
// its toolbar and links are the card that Menu and OK go into (ui/remote.js).
//
// The view itself, its toolbar, keys, place and CSS, is AriaMoKr/common's TextView (text-view.js,
// the shell music's and outside's views extend too); this module gives it the library's book.
// renderBlocks, topBlock, wordStarts and firstWordBelow are pure (a document passed in), for the
// tests; TextView is the page's.

import { TextView as Shell } from '../../vendor/common/text-view.js';

/**
 * The reader's driver, interaction.js's Interaction, with what the view reads of the two fields its
 * constructor sets with Object.assign, which tsc does not see.
 * @typedef {import('../interaction.js').Interaction & { controls: { presenting: boolean }, settings: { theme?: string, fontScale?: number, textView?: boolean } }} Interaction
 */

/** Style bits (§3.5) and the element each is shown with, outermost first. @type {[number, string, string | null][]} */
const STYLE_TAGS = [
  [256, 'span', 'tv-larger'],
  [128, 'small', null],
  [64, 'u', null],
  [32, 'span', 'tv-smallcaps'],
  [16, 'sub', null],
  [8, 'sup', null],
  [4, 'code', null],
  [2, 'strong', null],
  [1, 'em', null],
];

/** The image run's place-holding character (§3.5). */
const OBJ = '￼';

const isImageRun = (run) => !!run[2]?.src;
const linkOf = (run) => {
  const l = run[2];
  return l && (Array.isArray(l.at) || l.href || l.to) ? l : null;
};
/** Where a link leads (an image run in a link carries a copy of its fields: §3.5). */
const destination = (l) => JSON.stringify([l.at ?? null, l.href ?? null, l.to ?? null]);

/** Text with its hard breaks ("\n") as <br>s. */
function appendText(doc, el, text) {
  const parts = String(text).split('\n');
  parts.forEach((t, i) => {
    if (i) el.append(doc.createElement('br'));
    if (t) el.append(doc.createTextNode(t));
  });
}

/** One run's content: its text (or picture) inside its style elements. */
function runNode(doc, run, o) {
  let node;
  if (isImageRun(run)) {
    const r = run[2];
    node = doc.createElement('img');
    node.setAttribute('alt', r.alt ?? '');
    node.setAttribute('class', r.inv ? 'tv-inline tv-inv' : 'tv-inline');
    if (r.w) node.setAttribute('width', String(Math.round(r.w)));
    if (r.h) node.setAttribute('height', String(Math.round(r.h)));
    o.image?.(node, r.src);
  } else {
    node = doc.createElement('span');
    appendText(doc, node, run[0].replaceAll(OBJ, ''));
  }
  const bits = run[1] | 0;
  for (let i = STYLE_TAGS.length - 1; i >= 0; i--) {
    const [bit, tag, cls] = STYLE_TAGS[i];
    if (!(bits & bit)) continue;
    const wrap = doc.createElement(tag);
    if (cls) wrap.setAttribute('class', cls);
    wrap.append(node);
    node = wrap;
  }
  return node;
}

/**
 * Runs into an element: each run in its style elements; consecutive runs leading to one place (a
 * link's words and its pictures) as one real link, which onLink(link, event) follows.
 */
function appendRuns(doc, el, runs, o) {
  let a = null;
  let aLink = null;
  for (const run of runs || []) {
    const link = linkOf(run);
    if (link) {
      if (!aLink || destination(link) !== destination(aLink)) {
        a = doc.createElement('a');
        a.setAttribute('href', Array.isArray(link.at) ? `#tv-${link.at[0]}-${link.at[1]}` : '#');
        a.setAttribute('class', 'tv-link');
        const target = link;
        a.addEventListener?.('click', (e) => {
          e.preventDefault?.();
          o.onLink?.(target, e);
        });
        el.append(a);
        aLink = link;
      }
      a.append(runNode(doc, run, o));
    } else {
      a = null;
      aLink = null;
      el.append(runNode(doc, run, o));
    }
  }
}

/** The text of runs (a heading's, a contents entry's), pictures and breaks left out. */
export function runsText(runs) {
  return (runs || []).map((r) => (isImageRun(r) ? '' : r[0])).join('').replaceAll(OBJ, '').replace(/\s+/g, ' ').trim();
}

/**
 * A chunk's blocks (§3.5) as DOM nodes appended to `container`: `h` as headings below the view's
 * own (the part's highest level as h2, down to h6, never a level left out), `p` as paragraphs
 * (alignment, verse and indent kept), `li` as lists by depth with their markers, `tr` as tables
 * (rows grouped by `g`, header rows as `th`), `pre`, `img` (its alt, and the picture through
 * `image`), `hr`. Every block's element carries `data-b` (its index) and the id `tv-<c>-<b>`,
 * which links within the book point to. `skip`: a block left out (an article's title, which the
 * view's own title says).
 * @param {Document} doc
 * @param {Element} container
 * @param {object[]} blocks
 * @param {{ c: number, skip?: number, onLink?: (link: object, e: Event) => void, image?: (img: Element, src: string) => void }} o
 * @returns {number} how many blocks were shown
 */
export function renderBlocks(doc, container, blocks, o) {
  const c = o.c | 0;
  const skip = o.skip ?? -1;
  // Headings go in order under the view's h1 whatever level the part starts at (a chapter's l 2),
  // each at most one below the one before (a book's h3 then h5 would leave a level out).
  let top = 6;
  let above = 1;
  (blocks || []).forEach((block, b) => { if (block?.t === 'h' && b !== skip) top = Math.min(top, Math.max(1, block.l | 0)); });
  const mark = (el, b) => {
    el.setAttribute('data-b', String(b));
    el.setAttribute('id', `tv-${c}-${b}`);
    return el;
  };
  const indent = (el, q) => { if (q) el.setAttribute('style', `margin-inline-start: ${Math.min(q, 6) * 1.5}em`); };
  let lists = []; // the open lists, by depth
  let table = null; // the open table: { el, g, head, body }
  const endList = () => { lists = []; };
  const endTable = () => { table = null; };
  (blocks || []).forEach((block, b) => {
    if (b === skip) return;
    const t = block?.t;
    if (t !== 'li') endList();
    if (t !== 'tr') endTable();
    if (t === 'h') {
      const level = Math.min(6, above + 1, Math.max(2, (block.l | 0) - top + 2));
      above = level;
      const el = mark(doc.createElement(`h${level}`), b);
      if (block.a === 'c' || block.a === 'r') el.setAttribute('class', `tv-a${block.a}`);
      appendRuns(doc, el, block.r, o);
      container.append(el);
    } else if (t === 'p') {
      const el = mark(doc.createElement('p'), b);
      const cls = [block.v ? 'tv-verse' : '', block.a === 'c' || block.a === 'r' ? `tv-a${block.a}` : ''].filter(Boolean).join(' ');
      if (cls) el.setAttribute('class', cls);
      indent(el, block.q);
      appendRuns(doc, el, block.r, o);
      container.append(el);
    } else if (t === 'li') {
      const d = Math.max(1, block.d | 0);
      while (lists.length > d) lists.pop();
      while (lists.length < d) {
        const ul = doc.createElement('ul');
        ul.setAttribute('class', 'tv-list');
        const parent = lists.length ? lists[lists.length - 1].last ?? lists[lists.length - 1].el : container;
        parent.append(ul);
        lists.push({ el: ul, last: null });
      }
      const li = mark(doc.createElement('li'), b);
      if (block.m) {
        const m = doc.createElement('span');
        m.setAttribute('class', 'tv-marker');
        m.append(doc.createTextNode(`${block.m} `));
        li.append(m);
      }
      appendRuns(doc, li, block.r, o);
      lists[lists.length - 1].el.append(li);
      lists[lists.length - 1].last = li;
    } else if (t === 'tr') {
      if (!table || table.g !== block.g) {
        const el = doc.createElement('table');
        el.setAttribute('class', 'tv-table');
        indent(el, block.q);
        container.append(el);
        table = { el, g: block.g, head: null, body: null };
      }
      let section;
      if (block.hd && !table.body) section = table.head ??= (() => { const s = doc.createElement('thead'); table.el.append(s); return s; })();
      else section = table.body ??= (() => { const s = doc.createElement('tbody'); table.el.append(s); return s; })();
      const tr = mark(doc.createElement('tr'), b);
      for (const cell of block.c || []) {
        const td = doc.createElement(block.hd ? 'th' : 'td');
        if (block.hd) td.setAttribute('scope', 'col');
        appendRuns(doc, td, cell, o);
        tr.append(td);
      }
      section.append(tr);
    } else if (t === 'pre') {
      const el = mark(doc.createElement('pre'), b);
      indent(el, block.q);
      el.append(doc.createTextNode(block.x ?? ''));
      container.append(el);
    } else if (t === 'img') {
      const fig = mark(doc.createElement('figure'), b);
      indent(fig, block.q);
      const img = doc.createElement('img');
      img.setAttribute('alt', block.alt ?? '');
      img.setAttribute('class', block.inv ? (block.em ? 'tv-formula tv-inv' : 'tv-inv') : (block.em ? 'tv-formula' : ''));
      if (block.w) img.setAttribute('width', String(Math.round(block.w)));
      if (block.h) img.setAttribute('height', String(Math.round(block.h)));
      o.image?.(img, block.src);
      fig.append(img);
      container.append(fig);
    } else if (t === 'hr') {
      container.append(mark(doc.createElement('hr'), b));
    }
  });
  const shown = (blocks?.length ?? 0) - (skip >= 0 && skip < (blocks?.length ?? 0) ? 1 : 0);
  if (!shown) {
    const p = doc.createElement('p');
    p.append(doc.createTextNode('(Nothing to read in this part.)'));
    container.append(p);
  }
  return shown;
}

/**
 * The block at the top of the view: of the blocks' tops and bottoms (in the view's scrolled
 * coordinates, in order), the first that reaches below `top` (a block cut by the top edge
 * counts). 0 when there are none.
 * @param {Array<{ b: number, top: number, bottom: number }>} rects
 * @param {number} top
 */
export function topBlock(rects, top) {
  for (const r of rects) if (r.bottom > top + 1) return r.b;
  return rects.length ? rects[rects.length - 1].b : 0;
}

/**
 * The words of a block's element, as a place's `w` counts them: each [text node, where in it the
 * word starts], in order. A list inside an item is blocks of its own, and left out.
 * @param {Node} el
 * @returns {[Text, number][]}
 */
export function wordStarts(el) {
  /** @type {[Text, number][]} */
  const out = [];
  /** @param {Node} n */
  const walk = (n) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        const node = /** @type {Text} */ (c); // nodeType 3: a text node
        const re = /\S+/g;
        for (let m = re.exec(node.data); m; m = re.exec(node.data)) out.push([node, m.index]);
      } else if (c.nodeType === 1 && /** @type {Element} */ (c).getAttribute('data-b') == null) walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * The first of `count` words whose line reaches below `top`: lineBottom(i) is the foot of word i's
 * line, which only grows with i. The last when none does, 0 when there are none.
 * @param {number} count
 * @param {number} top
 * @param {(i: number) => number} lineBottom
 */
export function firstWordBelow(count, top, lineBottom) {
  let lo = 0;
  let hi = count - 1;
  if (count === 0 || lineBottom(hi) <= top + 1) return Math.max(0, count - 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineBottom(mid) > top + 1) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// The view on the page: common's shell (text-view.js) with the library's book

/**
 * A place in the open book: a part (chunk) c and a block b in it; in the view, w for the word on
 * the line at its top (wordStarts' count; left out when 0, the block's top), and f for an element
 * a link leads to (the 3D page finds it). The 3D book's own place is the block.
 * @typedef {{ c: number, b: number, w?: number, f?: string | null }} Place
 */

/** A picture of the part shown, loaded as the 3D reader loads it (api.imageSource). @typedef {{ url: string | null, release(): void }} ImageSource */

/**
 * The text view of the open book, on a screen: common's TextView, the book being interaction.js's
 * (`interaction`, the reader's driver). It calls follow() after every page turn or jump, aim()
 * before a jump to a place, bookClosing() and bookOpened() around a book, and toggle() for T.
 * @extends {Shell<Place>}
 */
export class TextView extends Shell {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root where the view goes (the overlay, inside the page's <main>)
   * @param {Interaction} o.interaction interaction.js's Interaction
   * @param {(libId: string, bookId: string, c: number) => Promise<object[]>} o.getChunk api.js
   * @param {(src: string) => Promise<ImageSource | null>} o.imageSource api.js
   * @param {(text: string) => void} o.announce a polite status (overlay.announce)
   * @param {(away: boolean) => HTMLElement | null | undefined} [o.returnFocus] where focus goes when
   *   the view closes (away: the book is being put back)
   * @param {boolean} [o.tv] a TV's remote (common's tvMode): the view holds the focus, not its title
   */
  constructor({ root, interaction, getChunk, imageSource, announce, returnFocus, tv = false }) {
    super({ root, tv, returnFocus });
    /** The reader's driver. */
    this.I = interaction;
    /** A part's blocks (§3.5). */
    this.getChunk = getChunk;
    /** A picture's source (a blob URL for a local book's). */
    this.imageSource = imageSource;
    /** A polite status, for a screen reader. */
    this.announce = announce;
    /** T with a book in hand: it goes straight into the view once open (openOnRead). */
    this._onRead = false;
    /** The pictures of the part shown, let go with it (_release). @type {ImageSource[]} */
    this._sources = [];
    /**
     * The reader's place as the shell last brought the 3D book there (jumpTo in place: _sync, before
     * a link): a link followed from the view keeps it on the trail, for Back. @type {Place | null}
     */
    this._shared = null;
    /** What placeTop and placeAt measure a word with, made when first needed. @type {Range | null} */
    this._range = null;
  }

  /**
   * Where a jump is going (a link, Back, the contents, a part, a size): { c, b?, w?, f? }, kept as
   * a place.
   * @param {Partial<Place> | null | undefined} at
   */
  aim(at) {
    super.aim(at && Number.isInteger(at.c)
      ? { c: /** @type {number} */ (at.c), b: at.b ?? 0, ...(at.w ? { w: at.w } : {}), f: at.f ?? null }
      : null);
  }

  /** Where a word ([text node, offset], wordStarts) is drawn: its first letter's box. @param {[Text, number]} word */
  _rangeRect([node, offset]) {
    const r = (this._range ??= this.doc.createRange());
    r.setStart(node, offset);
    r.setEnd(node, Math.min(node.data.length, offset + 1));
    return r.getBoundingClientRect();
  }

  /**
   * The book is being put back: the view closes, unless a link is taking the reader to another
   * book (keepTrail), whose part it shows once open.
   * @param {boolean} [keepTrail]
   */
  bookClosing(keepTrail) {
    this._onRead = false;
    if (!this.isOpen) return;
    if (keepTrail) this.$('.tv-body').replaceChildren(this.doc.createTextNode('Opening…'));
    else this.close({ keepPlace: false });
  }

  /**
   * A book is in hand (taken out, not opened at once): what it is and what comes next, said
   * politely. A screen only.
   */
  bookInHand() {
    const I = this.I;
    if (I.controls.presenting || !I.book) return;
    const next = I.book.readable ? 'Enter reads it, T as text, Esc puts it back.' : 'It cannot be read here. Esc puts it back.';
    this.announce?.(`${I.book.title}, in your hands. ${next}`);
  }

  /** T with a book in hand: it is read, and goes straight into the text view. */
  openOnRead() {
    if (!this.I.controls.presenting) this._onRead = true;
  }

  /** A book has opened: its title said politely; the view opened when the visitor keeps it on. */
  bookOpened() {
    const I = this.I;
    const part = this._partTitle(I.reader?.anchorOf(I._currentRef()).c ?? 0);
    const title = part ?? I.book?.title ?? 'The book';
    const wanted = (!!I.settings.textView || this._onRead) && !I.controls.presenting;
    this._onRead = false;
    this.announce?.(`${title} is open.${this.isOpen || wanted || I.controls.presenting ? '' : ' Text view: T.'}`);
    if (wanted && !this.isOpen) this.open();
  }

  /**
   * What the part shown is called: in a Wikipedia volume, whose parts are articles, the article's
   * title (its contents entry); elsewhere null (the book's title says it).
   * @param {number} c
   * @returns {string | null}
   */
  _partTitle(c) {
    if (!this._wikipedia()) return null;
    return this.I.reader?.meta?.toc?.find((/** @type {{ c: number }} */ e) => e.c === c)?.title ?? null;
  }

  /** Whether the open book is a Wikipedia volume (its parts are articles). */
  _wikipedia() {
    const I = this.I;
    return I.libraries?.find((/** @type {{ id: string }} */ l) => l.id === I.book?.libId)?.kind === 'wikipedia';
  }

  /**
   * A picture: loaded as the 3D reader loads it (api.imageSource), let go with its part.
   * @param {Element} img
   * @param {string} src
   */
  _image(img, src) {
    this.imageSource(src).then((source) => {
      if (!source?.url) return;
      this._sources.push(source);
      /** @type {HTMLImageElement} */ (img).src = source.url;
    }).catch(() => {});
  }

  /** Lets go of the pictures of the part shown before (local books' blob URLs). */
  _release() {
    for (const s of this._sources) s.release?.();
    this._sources = [];
  }

  // ── What the shell asks of the book ────────────────────────────────────────

  bookOpen() {
    return this.I.state === 'read' && !!this.I.reader;
  }

  presenting() {
    return !!this.I.controls.presenting;
  }

  bookKey() {
    const book = this.I.book;
    return book ? `${book.libId}\n${book.id}` : null;
  }

  partCount() {
    return this.I.reader?.chunkCount ?? 0;
  }

  /** @param {Place} place */
  partOf(place) {
    return place.c;
  }

  /** @param {number} c */
  partStart(c) {
    return { c, b: 0 };
  }

  /**
   * The part's blocks, as text (renderBlocks); the last part's pictures let go of. A Wikipedia
   * article is called by its title, and the view's own heading says it, so its first is left out.
   * @param {HTMLElement} body
   * @param {number} c
   * @param {{ onLink: (link: unknown) => void }} options
   */
  async renderPart(body, c, { onLink }) {
    const book = this.I.book;
    const blocks = /** @type {any[]} */ (await this.getChunk(book.libId, book.id, c));
    if (this.I.book !== book) return {}; // another book meanwhile: the shell drops this part
    this._release();
    const part = this._partTitle(c);
    renderBlocks(this.doc, body, blocks, {
      c,
      skip: part && blocks[0]?.t === 'h' && runsText(blocks[0].r) === part.replace(/\s+/g, ' ').trim() ? 0 : -1,
      onLink,
      image: (img, src) => this._image(img, src),
    });
    return { title: part ?? book.title, subtitle: part ? `Volume: ${book.title}` : '' };
  }

  placeShown() {
    const I = this.I;
    return I.reader ? I.reader.anchorOf(I._currentRef()) : null;
  }

  /** @param {Place} place */
  showsPlace(place) {
    return this.I._showsBlock(place);
  }

  /**
   * A place aimed at: its block and line, unless it named an element (f) the 3D page already found,
   * whose page's place it shows.
   * @param {Place} aim
   */
  placeAimed(aim) {
    const shown = this.placeShown();
    if (shown && aim.f && aim.c === shown.c) return shown;
    return aim.f ? { c: aim.c, b: 0 } : { c: aim.c, b: aim.b, ...(aim.w ? { w: aim.w } : {}) };
  }

  /**
   * Where a place is: the line with its word (the reader's line in a tall block), or its block's
   * top; the part's own top for its first block.
   * @param {Place} place
   */
  placeTop(place) {
    if (!(place.b > 0) && !place.w) return null;
    const target = this.$('.tv-body').querySelector(`[data-b="${place.b}"]`);
    if (!target) return null;
    const word = place.w && target.tagName !== 'TR' ? wordStarts(target)[place.w] : null;
    return (word ? this._rangeRect(word) : target.getBoundingClientRect()).top;
  }

  /**
   * The place at the view's top, top being the toolbar's foot: the block there (topBlock), and when
   * it began above the top, the word on its first line in sight. A table row's cells stand side by
   * side, their words not in order down the page: a row is its top.
   * @param {number} top
   */
  placeAt(top) {
    const rects = [];
    const nodes = [];
    for (const n of Array.from(this.$('.tv-body').querySelectorAll('[data-b]'))) {
      const r = n.getBoundingClientRect();
      // An item's own lines end where a list inside it begins (that list's items are blocks).
      const inner = n.tagName === 'LI' ? n.querySelector(':scope > ul') : null;
      const bottom = inner ? Math.min(r.bottom, inner.getBoundingClientRect().top) : r.bottom;
      rects.push({ b: Number(n.getAttribute('data-b')), top: r.top, bottom });
      nodes.push(n);
    }
    const b = topBlock(rects, top);
    const i = rects.findIndex((r) => r.b === b);
    if (i >= 0 && rects[i].top < top - 1 && nodes[i].tagName !== 'TR') {
      const words = wordStarts(nodes[i]);
      const w = firstWordBelow(words.length, top, (k) => this._rangeRect(words[k]).bottom);
      if (w > 0) return { c: this.part, b, w };
    }
    return { c: this.part, b };
  }

  /**
   * The 3D book to a place: to its block's page (its own place is the block, w the view's).
   * @param {Place} place
   * @param {{ inPlace: boolean }} options
   */
  jumpTo(place, { inPlace }) {
    if (inPlace) this._shared = place;
    return this.I.jumpToAnchor(place, { inPlace });
  }

  /** @param {number} dir */
  turnPage(dir) {
    return this.I.turn(dir);
  }

  /** @param {number} f */
  jumpToProgress(f) {
    return this.I.jumpToProgress(f);
  }

  /** @param {number} step */
  changeFont(step) {
    return this.I.changeFont(step);
  }

  /** @param {string} name */
  setTheme(name) {
    return this.I.setTheme(name);
  }

  goBack() {
    return this.I.goBack();
  }

  putBack() {
    return this.I.putBack();
  }

  /**
   * Back returns here: the shell has brought the 3D book to the reader's place, and the trail keeps
   * that place too (view), the block and line at the view's top, which the 3D page may begin blocks
   * before.
   * @param {unknown} link
   */
  followLink(link) {
    return this.I.followLink(/** @type {object} */ (link), { view: this.isOpen ? this._shared : null });
  }

  /** The book's contents (the reader's), by level; a Wikipedia volume's articles. */
  contents() {
    return (this.I.reader?.meta?.toc ?? []).map((/** @type {{ title: string, c: number, b: number, level?: number }} */ e) => ({
      title: e.title, place: { c: e.c, b: e.b }, level: e.level, href: `#tv-${e.c}-${e.b}`,
    }));
  }

  /** As the 3D contents goes there. @param {import('../../vendor/common/text-view.js').ContentsEntry<Place>} entry */
  useContents(entry) {
    return this.I.jumpToToc(entry.place);
  }

  label() {
    const I = this.I;
    return I.reader?.labelOf(I._currentRef()) ?? '';
  }

  progress() {
    const I = this.I;
    return I.reader?.progressOf(I._currentRef()) ?? 0;
  }

  hasTrail() {
    return !!this.I._trail?.length;
  }

  /**
   * The header, as the shell has it; but Back hidden with the focus on it (the trail gone back along
   * to its end, within the part shown) would drop the focus to the page: it goes to the view's home,
   * as after a Back into another part.
   * @protected
   */
  _header() {
    const back = this.$('.tv-back');
    const held = this.doc.activeElement === back;
    super._header();
    if (held && back.hidden) this._home().focus({ preventScroll: true });
  }

  /** A Wikipedia volume's parts are its articles, and are called so. */
  partWord() {
    return this._wikipedia() ? 'article' : 'part';
  }

  theme() {
    return this.I.settings.theme || 'paper';
  }

  fontScale() {
    return this.I.settings.fontScale || 1;
  }

  reduced() {
    return !!this.I.reduced;
  }
}
