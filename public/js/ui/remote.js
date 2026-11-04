// A TV's remote (SPEC §5.9): common's Remote, with the library's layers. The card the remote moves
// in is the page's open dialog (the help, Kiwix's library), else the text view's (its contents, or
// the whole view) while it is open, else the overlay; what holds the focus while walking is the
// text view while it is open, else the 3D view. OK while walking is the gamepad's A at the middle of
// the view (interaction.useMiddle); in the text view it goes to the links on the screen, and so
// does ↓ from its toolbar. Back is one step back (interaction.step), in the card a dialog or the
// contents closed first. Menu lands on the book's buttons while one is out, else on the Controls
// help (overlay.remoteStart), never on a text box. A text box keeps the TV's keyboard down until OK
// on it, whether the remote or the page put the focus there; the search's results take the real
// focus (↓ from its box), so OK opens one. Shared with music, so it gets what it uses from main.js.

import { keepsKey, keyOf, Remote } from '../../vendor/common/tv.js';

/** The text boxes, whose focus raises the TV's keyboard (as common's tv.js tells them). */
const TYPED = new Set(['text', 'search', 'url', 'email', 'number', 'password', 'tel', 'textarea']);
const typed = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && TYPED.has(el.type);

/** A combobox whose list is open. */
const openCombo = (el) => el?.getAttribute?.('role') === 'combobox' && el.getAttribute('aria-expanded') === 'true';

/** The listbox a combobox controls. */
const listOf = (combo) => document.getElementById(combo.getAttribute('aria-controls') ?? '');

/** Whether this is an option of a combobox's list (the search's results), holding the focus. */
function comboOption(el) {
  const list = el?.getAttribute?.('role') === 'option' ? el.closest('[role=listbox]') : null;
  return !!list?.id && !!document.querySelector(`[role=combobox][aria-controls="${list.id}"]`);
}

/** The keys an option with the focus keeps, for its own listener (overlay.js): from one to the next, OK, Escape. */
const OPTION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter', 'Escape']);

export class LibraryRemote extends Remote {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas the 3D view
   * @param {import('./overlay.js').Overlay} o.overlay the page's card
   * @param {import('./text-view.js').TextView} o.textView
   * @param {object} o.interaction its step (Back) and useMiddle (OK)
   */
  constructor({ canvas, overlay, textView, interaction }) {
    // The Remote's own listeners on the whole page: the focus falling to nowhere from any layer.
    super({ root: document.body, view: canvas, use: () => this._use(), step: () => interaction.step(), first: () => overlay.remoteStart() });
    this.overlay = overlay;
    this.textView = textView;
    this.I = interaction;
    this.onMode = (inCard) => {
      this._wasCard = inCard;
      interaction.inCard = inCard;
      if (!inCard) {
        // Walking again: what was open over the view closes.
        overlay.closeDialogs();
        if (textView.tocOpen) textView.closeToc();
      }
      overlay.setRemote({ card: inCard });
    };
    this._wasCard = false;
    document.addEventListener('focusin', (e) => {
      // A text box the page moved the focus onto from another control (a dialog opening, back from
      // the search's results): its keyboard kept down too, until OK, as one the remote steps onto.
      const el = /** @type {HTMLElement} */ (e.target);
      if (e.relatedTarget && typed(el) && el !== this._held?.el) this._hold(el);
      // The focus moved by the page itself (the text view opening or closing, a dialog): the mode follows.
      if (this.inCard !== this._wasCard) this.onMode(this.inCard);
    });
    // A click on a box whose keyboard is kept down (TalkBack's OK, which keeps the remote's): the keyboard up.
    document.addEventListener('click', (e) => {
      const el = this._held?.el;
      if (e.target !== el) return;
      this._release();
      el.blur();
      el.focus({ preventScroll: true });
    }, true);
    // The open book's contents chosen in the card: walking, the dot on them (↑ ↓ scroll, OK picks).
    overlay.root.querySelector('.ov-b-toc')?.addEventListener('click', () => {
      if (interaction.tocPanel?.visible) this.walk();
    });
    interaction.onDotList = (on) => overlay.setRemote({ list: on });
  }

  /** The card the remote moves in now (the Remote reads it at each key). */
  get root() {
    if (!this.overlay) return this._base;
    return this.overlay.dialog() ?? (this.textView.isOpen ? this.textView.layer() : this.overlay.root);
  }

  set root(el) {
    this._base = el;
  }

  /** What holds the focus while walking: the text view while it is open (and no dialog is), else the 3D view. */
  get view() {
    return this.textView?.isOpen && !this.overlay.dialog() ? this.textView.el : this._canvas;
  }

  set view(el) {
    this._canvas = el;
  }

  /** Walking; but the focus fallen to nowhere in an open dialog (a control that hid itself) stays in it. */
  walk() {
    const a = document.activeElement;
    if (this.overlay?.dialog() && (!a || a === document.body)) {
      const to = this._stops()[0];
      if (to) {
        to.focus();
        return;
      }
    }
    super.walk();
  }

  /** Back in the card: the search's results back to its box, a dialog or the text view's contents closed (back to what opened it), else as common's. */
  back() {
    const a = /** @type {HTMLElement} */ (document.activeElement);
    if (this.inCard && comboOption(a)) {
      this._send(a, 'Escape'); // the results closed, the focus back on the box (overlay.js)
      return true;
    }
    if (this.inCard && !keepsKey(a, 'Escape')) {
      const opener = this.overlay.closeDialog();
      if (opener !== null) {
        if (opener?.checkVisibility?.({ visibilityProperty: true })) opener.focus();
        else this.toCard();
        return true;
      }
      if (this.textView.tocOpen) {
        this.textView.closeToc(); // its button takes the focus
        return true;
      }
    }
    return super.back();
  }

  /** Menu: the text view's toolbar while it is open, else the card where it was left (a book's buttons while one is out: first()). */
  toCard() {
    if (this.textView.isOpen && !this.overlay.dialog()) {
      const to = this.textView.cardStart();
      if (to) {
        to.focus({ preventScroll: true });
        this.onMode(true);
        return;
      }
    }
    // While a book is out its buttons come first, unless the card was left among them.
    const book = (el) => !!el?.closest('.ov-book');
    if (book(this.overlay.remoteStart()) && !book(this._last)) this._last = null;
    super.toCard();
  }

  /** OK while walking: in the text view its first link on the screen, else the middle of the 3D view. */
  _use() {
    if (!this.textView.isOpen) {
      this.I.useMiddle();
      return;
    }
    const link = this.textView.linkHere();
    if (!link) {
      this.toCard();
      return;
    }
    link.focus({ preventScroll: true });
    this.onMode(true);
  }

  /**
   * The card's keys the library takes before common's Remote: a search result's own, ↑ ↓ out of
   * the search's box and its list, and ↑ ↓ between the text view's toolbar and its text.
   * @param {KeyboardEvent} e
   */
  _key(e) {
    const a = /** @type {HTMLElement} */ (document.activeElement);
    if (this.inCard && !(e.ctrlKey || e.altKey || e.metaKey)) {
      const key = keyOf(e);
      if (comboOption(a) && OPTION_KEYS.has(key)) {
        if (key === e.key) {
          this._kept = e; // the option's own (overlay.js), and no further (common's root listener)
        } else {
          // A spare key (TalkBack's channel keys): the arrow it stands for.
          e.preventDefault();
          e.stopPropagation();
          this._send(a, key);
        }
        return;
      }
      // ↑ from the search's box, or ↓ with no result to go to: the list closed, and on as from any control.
      if (openCombo(a) && (key === 'ArrowUp' || (key === 'ArrowDown' && !listOf(a)?.querySelector('[role=option]:not([aria-disabled=true])')))) {
        this._send(a, 'Escape');
      }
      if ((key === 'ArrowUp' || key === 'ArrowDown') && !keepsKey(a, key) && this._textStep(a, key)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    super._key(e);
  }

  /**
   * ↑ ↓ in the text view between its toolbar and the text. Down from the toolbar: the first stop on
   * the screen (a link, or the part's end), not the part's first, which the view would jump back
   * to; none on the screen, the focus stays. Up from the text when the stop before is off the
   * screen above: the toolbar's last. True when the key was taken.
   * @param {HTMLElement} a the focused control
   * @param {'ArrowUp' | 'ArrowDown'} key
   */
  _textStep(a, key) {
    const tv = this.textView;
    if (!tv?.isOpen || tv.tocOpen || this.overlay.dialog() || !tv.el.contains(a)) return false;
    const stops = this._stops();
    const at = stops.indexOf(a);
    if (at < 0) return false;
    if (key === 'ArrowDown') {
      if (!tv.inBar(a) || !stops[at + 1] || tv.inBar(stops[at + 1])) return false;
      stops.slice(at + 1).find((s) => tv.onScreen(s))?.focus({ preventScroll: true });
      return true;
    }
    const before = stops[at - 1];
    if (tv.inBar(a) || !before || tv.inBar(before) || tv.onScreen(before)) return false;
    stops.slice(0, at).filter((s) => tv.inBar(s)).pop()?.focus({ preventScroll: true });
    return true;
  }

  /**
   * A key sent to a control for its own listener, and no further (not the site's walking keys):
   * the remote has no Escape, and a spare key isn't an arrow.
   * @param {HTMLElement} el
   * @param {string} key
   */
  _send(el, key) {
    const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    this._kept = ev;
    el.dispatchEvent(ev);
  }

  /**
   * A focused text box's keyboard kept down until OK on it (common's _held, as its _focus does for
   * a box the remote steps onto).
   * @param {HTMLElement} el
   */
  _hold(el) {
    this._release();
    this._held = { el, mode: el.getAttribute('inputmode') };
    el.setAttribute('inputmode', 'none');
  }
}
