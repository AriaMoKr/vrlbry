// DOM overlay for non-VR use (SPEC §5.6): library card, search, Enter VR, help, loading, toasts.
// Hidden while an immersive session is running. On a TV (SPEC §5.9) it is the remote's card: the
// book's buttons stand in for the letter keys, nothing opens a file from the device, and a shared
// session's invite is shown as text.

import { imageSource } from '../api.js';
import { EXAMPLE_ZIM, MORE_ZIMS_URL, isLocalUrl } from '../local/local.js';
import { droppedHandles } from '../local/handles.js';
import { KiwixDialog } from './kiwix-dialog.js';
import { bookIndex, matchBooks, asksArticles, findArticles } from '../search.js';
import { load, save } from '../util/storage.js';
import { noteError } from '../debug-info.js';
import { RESET_PARTS, defaultResetParts } from '../reset.js';
import { wayOut } from '../hallway.js';
import { MOTIONS, MOTION_LABELS } from '../comfort.js';

const ARTICLE_RESULTS = 8; // per Wikipedia library
const ARTICLE_WAIT = 10000; // ms a list with nothing in it waits for the articles (a stalled request), then says none came

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A web address's host, for a library read from the web ("mirror.download.kiwix.org"). */
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return 'the web'; } };

/** An <img>'s source attribute; a local library's image is loaded after rendering (fillLocalImages). */
const imgSrc = (url) => (isLocalUrl(url) ? `data-local-src="${esc(url)}"` : `src="${esc(url)}"`);

/** Loads the local library images rendered under `root` (blob URLs, released once loaded). */
function fillLocalImages(root) {
  for (const img of root.querySelectorAll('img[data-local-src]')) {
    const url = img.dataset.localSrc;
    img.removeAttribute('data-local-src');
    imageSource(url).then((source) => {
      if (!source.url) return;
      img.onload = img.onerror = () => source.release();
      img.src = source.url;
    }).catch(() => {});
  }
}

/** A TV's hint, by what the remote does now (_renderHint). */
const TV_HINTS = {
  walk: '↑ ↓ walk · ← → turn · OK takes the book at the dot · Menu: the card\nWith TalkBack: channel up and down walk, rewind and fast-forward turn',
  list: '↑ ↓ scroll the list · OK chooses · ← → turn away',
  hand: 'OK reads it · Back puts it back · Menu: more',
  read: '← → turn the pages · Menu: contents, text size and more · Back: one step back',
  toc: '↑ ↓ scroll the contents · OK goes there · Back closes them',
  card: '↑ ↓ from button to button · ← → change a choice · OK presses · Back: walk again',
};

const HELP = {
  desktop: [
    ['Look around', 'Drag with the mouse'],
    ['Walk', 'W A S D or ↑ ↓ · turn with ← → or Q E · Shift to hurry'],
    ['Take a book', 'Click it on the shelf'],
    ['Read', 'Click the book or “Read” · turn pages with ← → / Space / click a page'],
    ['Text size', '+ / − or the A− A+ buttons'],
    ['Text view', 'T with a book in hand or open: the part as a page of text (T or Esc: back to the book) · C: the contents'],
    ['One page or two', 'P or the “1 page” / “2 pages” button (one page when the window is taller than wide)'],
    ['Put it back', 'Esc or “Put back”'],
    ['Book out of sight', 'F, or “Bring the book in front of me” below'],
    ['Back to the start', 'Home, or “Reset view” below'],
    ['Search', 'The box at the top, or type on the catalogue stand’s Search tab (Esc to stop typing)'],
  ],
  touch: [
    ['Look around', 'Drag with one finger'],
    ['Walk', 'Drag with two fingers'],
    ['Take a book', 'Tap it on the shelf'],
    ['Read', 'Tap “Read” · swipe or tap the page edges to turn'],
    ['One page or two', '“1 page” / “2 pages” under the book (one page while the phone is upright)'],
    ['Text view', '“Text view” at the foot while reading: the part as a page of text'],
    ['Put it back', 'Tap “Put back”'],
    ['Book out of sight', '“Bring the book in front of me” below'],
  ],
  gamepad: [
    ['Look around', 'Right stick'],
    ['Walk', 'Left stick · click it to hurry'],
    ['Take a book', 'Aim the crosshair, press A'],
    ['Read', 'A · turn pages with the bumpers or ← → on the D-pad'],
    ['Text size, contents, theme', 'D-pad ↑ ↓ · X · Y'],
    ['Book distance', 'Triggers'],
    ['Put it back', 'B'],
    ['Book out of sight', 'Press the right stick'],
  ],
  tv: [
    ['Walk', '↑ ↓ · turn with ← →'],
    ['Take a book', 'Turn until the dot is on it, then OK'],
    ['Read', 'OK · turn the pages with ← →'],
    ['The card', 'Menu: this card, on this button first, and with a book out its buttons (contents, text view, theme, pages, text size) · ↑ ↓ from one to the next, ← → through a choice, OK presses'],
    ['Search', '↑ from this button to the box, OK to type with the keyboard · ↓ through the results, OK opens one · Back: the box again'],
    ['A list on the stand', 'Walk up to the stand, the dot on the list: ↑ ↓ scroll it, OK chooses'],
    ['The text view', '↑ ↓ scroll it, ← → turn the pages · OK: the links on the screen · Menu: its toolbar'],
    ['Back', 'One step back: the contents closed, back along the links, the text view closed, the book put back; in the card, walking again; else back to the Hallway'],
    ['With TalkBack', 'Channel up and down walk, rewind and fast-forward turn'],
  ],
  vr: [
    ['Point & select', 'Aim the ray, pull the trigger (or pinch with hand tracking)'],
    ['Teleport', 'Push the right stick forward, aim the arc, release'],
    ['Turn', 'Flick the right stick left / right · left stick walks'],
    ['Read', 'Flick the right stick or trigger a page to turn · grip to move the book'],
    ['Book distance / size', 'Right stick up/down · left stick up/down'],
    ['Close / put back', 'B or Y button'],
    ['Book out of sight', 'Press a thumbstick: it comes in front of you'],
    ['Leave VR', 'Hold B or Y for a second while browsing, or “Exit VR” on the catalogue stand'],
  ],
};

export class Overlay {
  /** @param {{ root: HTMLElement }} o */
  /** @param {{ root: HTMLElement, wayOut?: ReturnType<typeof wayOut> }} o wayOut: where "← Hallway" leads (hallway.js) */
  constructor({ root, wayOut: way = wayOut() }) {
    this.root = root;
    this.mode = 'desktop';
    this._pick = null;
    this._enterVR = null;
    this._index = null; // the search index, made at the first search (_bookIndex)
    this._results = [];
    this._sel = -1;
    this._libraries = [];
    this._booksByLib = {};
    this._books = []; // book results of the current query
    this._articles = []; // article results of the current query
    this._articlesDue = false; // the current query's articles still to come (its timer, then its request)
    this._downWaits = false; // a TV's ↓ in the box before any result had come: to the first once they do
    this._searchToken = 0;
    this._searchTimer = 0;
    this._dueTimer = 0; // the end of the list's wait for the articles (ARTICLE_WAIT)
    this._pickArticle = null;
    root.innerHTML = `
      <div class="ov-loading" role="status" aria-live="polite">
        <div class="ov-logo">vrlbry</div>
        <div class="ov-loading-text">Opening the library…</div>
        <div class="ov-progress"><div class="ov-progress-bar"></div></div>
        <button class="ov-loading-debug" hidden>Copy debug info</button>
      </div>
      <section class="ov-card" aria-label="Library">
        <header><span class="ov-brand">vrlbry</span><span class="ov-version"></span><span class="ov-tools"><a class="ov-hallway" href="${esc(way.url)}" title="${esc(way.title)}">${esc(way.label)}</a><button class="ov-rescan" aria-label="Rescan the ZIM folder" title="Rescan the ZIM folder">⟳</button><button class="ov-collapse" aria-label="Collapse" title="Collapse">–</button></span></header>
        <div class="ov-session" role="status" hidden><span class="ov-session-text"></span><button class="ov-session-leave" title="Leave the shared session">Leave</button>
          <div class="ov-session-invite" hidden>To join from a phone or a computer, open <span class="ov-invite-link"></span></div></div>
        <div class="ov-libs"></div>
        <div class="ov-open">
          <button class="ov-kiwix-btn" hidden title="The ZIMs this library reads well, from library.kiwix.org">Browse Kiwix's library…</button>
          <button class="ov-open-btn" title="Read ZIM files from this device, in the browser">Open ZIM files…</button>
          <input class="ov-open-input" type="file" accept=".zim" multiple hidden>
          <form class="ov-url" autocomplete="off">
            <input class="ov-url-input" type="text" inputmode="url" spellcheck="false" autocapitalize="off"
              placeholder="or the web address of a ZIM file" aria-label="Web address of a ZIM file">
            <button type="submit" title="Read it from the web, a little at a time">Open</button>
          </form>
          <div class="ov-reopen" hidden>Last time: <span class="ov-reopen-names"></span>
            <button class="ov-reopen-btn">Reopen</button><button class="ov-reopen-forget" title="Forget these files">Forget</button></div>
          <div class="ov-open-hint">No ZIM file yet? Read
            <button class="ov-try-btn" type="button" title="Read it from Kiwix's mirror, a little at a time">${esc(EXAMPLE_ZIM.title)}</button>
            from Kiwix<span class="ov-files">, or <a href="${esc(EXAMPLE_ZIM.url)}" target="_blank" rel="noopener">download it</a>
            (${esc(EXAMPLE_ZIM.size)}) and open it here.
            <a href="${esc(MORE_ZIMS_URL)}" target="_blank" rel="noopener">More Gutenberg ZIMs</a>: paste one's address above</span>.</div>
        </div>
      </section>
      <div class="ov-drop" hidden>Drop ZIM files, or a ZIM's link, to open them</div>
      <div class="ov-search" role="search">
        <input type="search" placeholder="Find a book, author or article…" aria-label="Find a book or article" autocomplete="off" spellcheck="false"
          role="combobox" aria-autocomplete="list" aria-controls="ov-results" aria-expanded="false">
        <ul class="ov-results" id="ov-results" role="listbox" aria-label="Search results" hidden></ul>
        <div class="ov-search-status ov-sr" role="status" aria-live="polite"></div>
      </div>
      <div class="ov-bottom">
        <button class="ov-help-btn" aria-label="Controls help" title="Controls">?</button>
        <span class="ov-book ov-book-hand" role="group" aria-label="The book in hand">
          <button data-key="Enter">Read</button><button data-key="t" data-code="KeyT">Read as text</button><button data-key="f" data-code="KeyF">In front of me</button><button data-key="Escape">Put back</button>
        </span>
        <span class="ov-book ov-book-open" role="group" aria-label="The open book">
          <button class="ov-b-toc" data-key="c" data-code="KeyC" aria-pressed="false">Contents</button><button data-key="-" data-code="Minus" aria-label="A− smaller text">A−</button><button data-key="+" data-code="Equal" aria-label="A+ larger text">A+</button><button data-key="n" data-code="KeyN">Theme</button><button class="ov-b-pages" data-key="p" data-code="KeyP">1 page</button><button data-key="f" data-code="KeyF">In front of me</button><button class="ov-b-back" data-key="Backspace" hidden>↩ Back</button><button data-key="Escape">Put back</button>
        </span>
        <button class="ov-textview" title="The part you are reading, as a page of text (T)">Text view</button>
        <button class="ov-vr" hidden>Enter VR</button>
      </div>
      <div class="ov-hint" id="ov-hint"></div>
      <div class="ov-help" role="dialog" aria-label="Controls" hidden>
        <div class="ov-help-inner">
          <header><h2>How to use the library</h2><button class="ov-help-close" aria-label="Close">×</button></header>
          <div class="ov-help-body"></div>
          <div class="ov-view">
            <button class="ov-view-book" hidden>Bring the book in front of me</button>
            <button class="ov-view-reset">Reset view</button>
            <span class="ov-view-note">Back to the start, looking into the room; a book that is out goes back on its shelf.</span>
          </div>
          <label class="ov-update-pref"><input type="checkbox" checked> Tell me when this site has been updated</label>
          <label class="ov-update-pref ov-textview-pref"><input type="checkbox"> Open books as text (the text view, at once)</label>
          <fieldset class="ov-comfort">
            <legend>Comfort <span class="ov-comfort-note">(kept for every site behind the Hallway's doors)</span></legend>
            <label>Motion <select class="ov-comfort-motion">${MOTIONS.map((m) => `<option value="${m}">${esc(MOTION_LABELS[m])}</option>`).join('')}</select></label>
            <label><input type="checkbox" class="ov-comfort-vignette"> A vignette while moving or turning smoothly in VR</label>
            <label><input type="checkbox" class="ov-comfort-seated"> Seated: my eyes 45 cm higher in VR</label>
          </fieldset>
          <footer class="ov-debug">
            <div><button class="ov-debug-btn">Copy debug info</button><button class="ov-shot-btn" title="The 3D view as a PNG, without this page's menus">Save screenshot</button><span class="ov-debug-note">Something wrong? Copy this and paste it into your bug report, with the screenshot.</span></div>
            <div><button class="ov-scene-save">Save scene</button><button class="ov-scene-restore" disabled>Restore scene</button><button class="ov-scene-paste">Paste a scene…</button><span class="ov-scene-note">No saved scene</span></div>
            <div><button class="ov-reset-btn" aria-expanded="false">Reset stored data…</button><span class="ov-reset-note">Start afresh: clear what this site keeps in this browser.</span></div>
            <fieldset class="ov-reset" hidden>
              <legend>Clear</legend>
              ${RESET_PARTS.map((p) => `<label><input type="checkbox" value="${esc(p.id)}"> ${esc(p.label)}</label>`).join('')}
              <div><button class="ov-reset-go">Clear and reload</button><button class="ov-reset-cancel">Cancel</button><span class="ov-reset-note">What is not ticked is kept. The page then reloads.</span></div>
            </fieldset>
            <textarea class="ov-debug-text" hidden aria-label="Debug info or a scene to restore" spellcheck="false" placeholder="Paste a debug report or a scene here"></textarea>
            <div class="ov-scene-text" hidden><button class="ov-scene-restore-text">Restore this scene</button><span class="ov-debug-note">Restores the place, view, book, page and dialogs in this text.</span></div>
          </footer>
        </div>
      </div>
      <div class="ov-update" role="status" hidden>
        <span>This site has been updated.</span>
        <button class="ov-update-btn">Reload</button>
        <button class="ov-update-never">Don't show again</button>
        <button class="ov-update-close" aria-label="Dismiss" title="Dismiss">×</button>
      </div>
      <div class="ov-toasts" aria-live="polite"></div>
      <div class="ov-announce ov-sr" role="status" aria-live="polite"></div>
      <section class="ov-status" aria-label="Your ZIM files" hidden>
        <div class="ov-status-head">
          <span class="ov-status-text" role="status"></span>
          <button class="ov-status-stop" hidden>Stop</button>
          <button class="ov-status-toggle" aria-expanded="false" title="Show each file">▸</button>
        </div>
        <div class="ov-toast-bar"><div></div></div>
        <ul class="ov-status-rows" hidden></ul>
      </section>`;
    this.$ = (sel) => root.querySelector(sel);
    // The book's buttons (a TV's card): each presses its key (interaction.pressKey).
    for (const b of root.querySelectorAll('.ov-book button')) b.onclick = () => this._bookKey?.(b.dataset.key, b.dataset.code ?? b.dataset.key);
    this.$('.ov-collapse').onclick = () => this.setCardCollapsed(!this.$('.ov-card').classList.contains('collapsed'));
    // A minimized library card stays minimized when the page is reloaded.
    if (load('card', 'open') === 'collapsed') this.setCardCollapsed(true);
    this.$('.ov-rescan').onclick = () => this._rescan?.();
    // ZIM files from this device (the local library, step 2): a picker, or dropped on the page.
    // A browser with the File System Access API picks through onPickFiles (handles, so the files
    // can be reopened after a reload: local/handles.js); the file input is the fallback.
    const picker = this.$('.ov-open-input');
    this.$('.ov-open-btn').onclick = async () => {
      if (this._pickFiles) {
        try {
          const picked = await this._pickFiles();
          if (picked?.files.length) this._openFiles?.(picked.files, picked.handles);
          return;
        } catch { /* no such picker after all: the input */ }
      }
      picker.click();
    };
    picker.onchange = () => {
      const files = [...picker.files];
      picker.value = ''; // the same file can be picked again
      if (files.length) this._openFiles?.(files, []);
    };
    // A ZIM's web address (milestone 3): read where it is, a little at a time.
    this.$('.ov-url').onsubmit = (e) => {
      e.preventDefault();
      const input = this.$('.ov-url-input');
      const typed = input.value.trim();
      if (!typed) return input.focus();
      input.value = '';
      this._openUrl?.(typed);
    };
    this.$('.ov-try-btn').onclick = () => this._openUrl?.(EXAMPLE_ZIM.url);
    this.$('.ov-kiwix-btn').onclick = () => this._kiwix?.show();
    // A local library's × in the list: close it (and forget it).
    this.$('.ov-libs').onclick = (e) => {
      const btn = e.target.closest('.ov-lib-close');
      if (btn) this._closeLibrary?.(btn.dataset.id);
    };
    this.$('.ov-reopen-btn').onclick = () => this._reopen?.();
    this.$('.ov-reopen-forget').onclick = () => this._forget?.();
    // The index builds' status box: its rows shown or not (remembered).
    this._statusOpen = load('statusOpen', false) === true;
    this.$('.ov-status-toggle').onclick = () => {
      this._statusOpen = !this._statusOpen;
      save('statusOpen', this._statusOpen);
      this._renderStatus();
    };
    this.$('.ov-status-stop').onclick = () => this._stopOpening?.();
    this.$('.ov-status-rows').onclick = (e) => {
      const btn = e.target.closest('.ov-status-cancel');
      if (btn) this._cancelIndexing?.(btn.dataset.id);
    };
    // Files, or a link (a ZIM's address, dragged from another page): text/uri-list.
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/uri-list');
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      this.$('.ov-drop').hidden = false;
    });
    document.addEventListener('dragleave', (e) => {
      if (hasFiles(e) && --dragDepth <= 0) {
        dragDepth = 0;
        this.$('.ov-drop').hidden = true;
      }
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      this.$('.ov-drop').hidden = true;
      const files = [...e.dataTransfer.files];
      if (!files.length) {
        const link = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
        if (link) this._openUrl?.(link);
        return;
      }
      // The handles must be asked for during the event; they arrive later.
      droppedHandles(e.dataTransfer).then((handles) => this._openFiles?.(files, handles));
    });
    // The debug report describes the page as it was when the help was opened: a click there (or
    // anywhere outside the search box) closes the search results, so the state is taken on
    // pointerdown, before that happens (capture phase).
    document.addEventListener('pointerdown', () => { this._uiBeforeClick = this.uiState(); }, true);
    this.$('.ov-help-btn').onclick = () => {
      this._uiAtHelp = this._uiBeforeClick ?? this.uiState();
      this.showHelp(true);
    };
    this.$('.ov-help-close').onclick = () => this.showHelp(false);
    this.$('.ov-help').onclick = (e) => {
      if (e.target === this.$('.ov-help')) this.showHelp(false);
    };
    this.$('.ov-vr').onclick = () => this._enterVR?.();
    // Both close the dialog first: what they do is to be seen behind it.
    this.$('.ov-view-reset').onclick = () => {
      this.showHelp(false);
      this._view?.reset();
    };
    this.$('.ov-view-book').onclick = () => {
      this.showHelp(false);
      this._view?.toFront();
    };
    this.$('.ov-debug-btn').onclick = () => this._debug?.();
    this.$('.ov-shot-btn').onclick = () => this._screenshot?.();
    // "Reset stored data…" opens the choice of parts (the defaults ticked); "Clear and reload" acts.
    const resetBoxes = () => [...this.$('.ov-reset').querySelectorAll('input[type=checkbox]')];
    const showReset = (on) => {
      this.$('.ov-reset').hidden = !on;
      this.$('.ov-reset-btn').setAttribute('aria-expanded', String(on));
      if (!on) return;
      const parts = defaultResetParts();
      for (const box of resetBoxes()) box.checked = parts[box.value];
      this.$('.ov-reset-go').disabled = false;
    };
    this.$('.ov-reset-btn').onclick = () => showReset(this.$('.ov-reset').hidden);
    this.$('.ov-reset-cancel').onclick = () => {
      showReset(false);
      this.$('.ov-reset-btn').focus(); // not lost with the button that hid itself
    };
    this.$('.ov-reset').onchange = () => { this.$('.ov-reset-go').disabled = !resetBoxes().some((b) => b.checked); };
    this.$('.ov-reset-go').onclick = () => {
      const parts = Object.fromEntries(resetBoxes().map((b) => [b.value, b.checked]));
      if (Object.values(parts).some(Boolean)) this._reset?.(parts);
    };
    this.$('.ov-scene-save').onclick = () => this._scene?.save();
    this.$('.ov-scene-restore').onclick = () => this._scene?.restore();
    this.$('.ov-scene-paste').onclick = () => {
      const ta = this.$('.ov-debug-text');
      ta.value = '';
      ta.hidden = false;
      this.$('.ov-scene-text').hidden = false;
      ta.focus();
    };
    this.$('.ov-scene-restore-text').onclick = () => this._scene?.restoreText(this.$('.ov-debug-text').value);
    this.$('.ov-loading-debug').onclick = () => {
      this._uiAtHelp = this._uiBeforeClick ?? this.uiState();
      this.showHelp(true);
      this._debug?.();
    };
    const input = this.$('.ov-search input');
    input.addEventListener('input', () => this._search(input.value));
    input.addEventListener('keydown', (e) => this._searchKey(e));
    input.addEventListener('focus', () => { if (!this._backToBox) this._search(input.value); });
    this.$('.ov-results').addEventListener('keydown', (e) => this._resultKey(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.$('.ov-search').contains(e.target)) this._showList(false);
    });
    this.setMode(matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop');
  }

  /** Shows the loading screen with a message and progress (0..1, or null = indeterminate); text null hides it. */
  setLoading(text, fraction = null) {
    const el = this.$('.ov-loading');
    if (text == null) {
      el.classList.add('done');
      setTimeout(() => { el.hidden = true; }, 600);
      return;
    }
    el.hidden = false;
    el.classList.remove('done');
    this.$('.ov-loading-text').textContent = text;
    const bar = this.$('.ov-progress-bar');
    bar.classList.toggle('indeterminate', fraction == null);
    bar.style.width = fraction == null ? '' : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  /** Shows a fatal error on the loading screen. */
  setError(message) {
    const el = this.$('.ov-loading');
    el.hidden = false;
    el.classList.remove('done');
    el.classList.add('error');
    this.$('.ov-loading-text').textContent = message;
    this.$('.ov-loading-debug').hidden = false;
  }

  /** cb() for "Copy debug info" (help dialog, error screen); it calls showDebugInfo. */
  onDebugInfo(cb) { this._debug = cb; }

  /** cb() for "Save screenshot" (help dialog). */
  onScreenshot(cb) { this._screenshot = cb; }

  /** cb(parts) for "Reset stored data" (help dialog): { settings, remembered, indexes, cache } to clear (reset.js). */
  onReset(cb) { this._reset = cb; }

  /** Handlers of the help dialog's view buttons: { reset(), toFront() }. */
  onView(handlers) { this._view = handlers; }

  /** A book is out (in hand or open): the help dialog offers to bring it in front of the eyes. */
  setBookOut(on) {
    this.$('.ov-view-book').hidden = !on;
    this.root.classList.toggle('ov-bookout', !!on);
    this._renderHint();
  }

  /** fn(key, code): a book's button in the card (a TV's), which does what that key does. */
  onBookKey(fn) { this._bookKey = fn; }

  /**
   * The open book's buttons as they are on its 3D toolbar: { back } (links followed), { pages }
   * (the other view's name), { toc } (the contents shown).
   */
  setBookButtons({ back, pages, toc } = {}) {
    if (back !== undefined) this.$('.ov-b-back').hidden = !back;
    if (pages !== undefined) this.$('.ov-b-pages').textContent = pages;
    if (toc !== undefined) this.$('.ov-b-toc').setAttribute('aria-pressed', String(!!toc));
  }

  /**
   * A TV (common's tvMode: SPEC §5.9): the hint and the help say what the remote does, and what a
   * file of this device would be opened with goes (style.css, html.tv).
   */
  setTV(on) {
    this.tv = !!on;
    this._renderHint();
    this._renderHelp();
  }

  /** What a TV's remote does now, for its hint: { card } (the card has the focus), { list } (↑ ↓ scroll the list at the dot). */
  setRemote({ card, list } = {}) {
    if (card !== undefined) this._tvCard = card;
    if (list !== undefined) this._tvList = list;
    this._renderHint();
  }

  /** The page's dialog that is open (Kiwix's library, the help), the card a TV's remote moves in; else null. */
  dialog() {
    if (this._kiwix?.visible) return this._kiwix.el;
    const help = this.$('.ov-help');
    return help.hidden ? null : help;
  }

  /** Closes the page's open dialog: the button that opens it, to go back to; null when none was open. */
  closeDialog() {
    if (this._kiwix?.visible) {
      this._kiwix.hide();
      return this.$('.ov-kiwix-btn');
    }
    if (!this.$('.ov-help').hidden) {
      this.showHelp(false);
      return this.$('.ov-help-btn');
    }
    return null;
  }

  /** Closes the page's dialogs, and the search's results (a TV's remote walking again). */
  closeDialogs() {
    while (this.closeDialog() !== null);
    if (!this.$('.ov-results').hidden) this._showList(false);
  }

  /**
   * Where a TV remote's Menu goes with nothing to come back to (common's first()): the book's first
   * button while one is out, else the Controls help, never a text box (its keyboard would come up).
   */
  remoteStart() {
    const cls = this.root.classList;
    if (cls.contains('ov-bookout')) return this.$(cls.contains('ov-reading') ? '.ov-book-open button' : '.ov-book-hand button');
    return this.$('.ov-help-btn');
  }

  /**
   * A key other than ↓ on a TV's remote in the card: a ↓ waiting in the search's box for its
   * results is given up (remote.js; also a key common's Remote takes itself, which the box never sees).
   */
  remoteKey() {
    this._downWaits = false;
  }

  /** Handlers of the help dialog's scene buttons: { save(), restore(), restoreText(text) }. */
  onScene(handlers) { this._scene = handlers; }

  /** The saved scene's description ("Saved …"), or null when there is none: Restore is disabled then. */
  setSavedScene(text) {
    this.$('.ov-scene-note').textContent = text ?? 'No saved scene';
    this.$('.ov-scene-restore').disabled = !text;
  }

  /** Shows the debug report in the help dialog; when copying failed, selected for copying by hand. */
  showDebugInfo(text, copied) {
    const ta = this.$('.ov-debug-text');
    ta.value = text;
    ta.hidden = false;
    this.$('.ov-scene-text').hidden = false; // a report is a scene too
    this.$('.ov-debug-note').textContent = copied ? 'Copied. Paste it into your bug report (this is all it contains).'
      : 'This browser did not allow copying: select the text below and copy it.';
    if (!copied) {
      ta.focus();
      ta.select();
    }
    ta.scrollTop = 0;
  }

  /**
   * @param {object[]} libraries
   * @param {Record<string, object[]>} booksByLib
   */
  setLibraries(libraries, booksByLib) {
    this._shown = [libraries, booksByLib];
    const total = libraries.reduce((n, l) => n + (booksByLib[l.id]?.length || 0), 0);
    this.$('.ov-libs').innerHTML = libraries.length
      ? libraries.map((l) => `
        <div class="ov-lib">
          ${l.illustration ? `<img ${imgSrc(l.illustration)} alt="" width="40" height="40">` : ''}
          <div class="ov-lib-body"><div class="ov-lib-title">${esc(l.title)}</div>
          <div class="ov-lib-desc">${esc(l.longDescription || (l.description && !String(l.title).includes(l.description) ? l.description : ''))}</div>
          <div class="ov-lib-meta">${l.indexing && l.indexing.stage !== 'failed'
            ? (l.indexing.stage === 'queued' ? 'waiting to index…' : `indexing… ${Math.round((l.indexing.progress || 0) * 100)}%`)
            : `${(booksByLib[l.id]?.length || 0).toLocaleString()} ${l.kind === 'wikisource' ? 'works' : l.kind === 'wikipedia' ? `volumes (${(l.articles ?? 0).toLocaleString()} articles)` : 'books'}`} · ${esc(l.file)}${l.site ? ' · from this site' : l.url ? ` · from ${esc(hostOf(l.url))}` : ''}</div></div>
          ${String(l.id).startsWith('~') ? `<button class="ov-lib-close" data-id="${esc(l.id)}" title="${l.site ? 'Close it (it opens again with the page)' : l.url ? 'Close it (and do not reopen it)' : 'Close this file'}" aria-label="Close ${esc(l.title)}">×</button>` : ''}
        </div>`).join('') + (libraries.length > 1 ? `<div class="ov-lib-meta">${total.toLocaleString()} books in ${libraries.length} libraries</div>` : '')
      : `<div class="ov-lib-desc">${this._static ? 'This online version has no books yet. Open a ZIM file from this device or the web below, or run vrlbry yourself (see the README).' : 'No .zim files were found in the server folder. Add some and reload, or open one from this device or the web below.'}</div>`;
    fillLocalImages(this.$('.ov-libs'));
    // The search index is made at the first search, not with every catalogue: an entry and two
    // strings per book (80,000 with a 60,000-book library open) that every full garbage
    // collection had to mark, also in VR, where this search is never used.
    this._index = null;
    this._libraries = libraries;
    this._booksByLib = booksByLib;
  }

  /** The search index of the current catalogue (search.js bookIndex; shared with the kiosk's). */
  _bookIndex() {
    return (this._index ??= bookIndex(this._libraries, this._booksByLib));
  }

  /** Shows when the website last changed (next to the brand). */
  setVersion(text) { this.$('.ov-version').textContent = text; }

  /**
   * The site changed since this page loaded (a new deploy): a banner with Reload, "Don't show
   * again" (onNever) and × (hides it for this page). No timeout: until reloaded the page runs old
   * code and no longer applies catalogue changes, which a silently vanished notice would not explain.
   */
  showUpdate({ onReload, onNever }) {
    const el = this.$('.ov-update');
    this.$('.ov-update-btn').onclick = onReload;
    this.$('.ov-update-close').onclick = () => { el.hidden = true; };
    this.$('.ov-update-never').onclick = () => {
      el.hidden = true;
      onNever?.();
    };
    el.hidden = false;
  }

  hideUpdate() { this.$('.ov-update').hidden = true; }

  /** The help dialog's comfort choices (common's access.js: motion, vignette, seated), as set. */
  setAccess(access) {
    this.$('.ov-comfort-motion').value = access.motion;
    this.$('.ov-comfort-vignette').checked = !!access.vignette;
    this.$('.ov-comfort-seated').checked = !!access.seated;
  }

  /** @param {(change: { motion?: string, vignette?: boolean, seated?: boolean }) => void} fn a choice made there */
  onAccess(fn) {
    this.$('.ov-comfort-motion').onchange = (e) => fn({ motion: e.target.value });
    this.$('.ov-comfort-vignette').onchange = (e) => fn({ vignette: e.target.checked });
    this.$('.ov-comfort-seated').onchange = (e) => fn({ seated: e.target.checked });
  }

  /** The help dialog's "Tell me when this site has been updated" (settings.updateNotices): onChange(on). */
  setUpdateNotices(on, onChange) {
    const box = this.$('.ov-update-pref input');
    box.checked = !!on;
    if (onChange) box.onchange = () => onChange(box.checked);
  }

  onSearchPick(cb) { this._pick = cb; }
  /** cb(libId, { title, book, n }) for a Wikipedia article chosen in the search results. */
  onArticlePick(cb) { this._pickArticle = cb; }
  onRescan(cb) { this._rescan = cb; }

  /**
   * What the local library is doing with the files opened here, in one box at the page's foot
   * (not a toast each: six of them covered the view, and an opening toast beside the box made
   * two): its head line (opening files, or indexing), an overall bar, a Stop while several files
   * open, and behind a toggle (remembered) a row per index build (a Wikipedia or Wikisource
   * file). null hides it.
   * @param {{ summary: string, fraction: number, stop?: { label: string, disabled?: boolean } | null,
   *   rows: Array<{ id: string, title: string, line: string, fraction: number, waiting: boolean }> } | null} status
   */
  setStatus(status) {
    this._status = status;
    this._renderStatus();
  }

  /** fn(libId): the × of a build's row (stop it and close that file). */
  onIndexingCancel(fn) { this._cancelIndexing = fn; }
  /** fn(): the head's Stop (open no more of the files being opened). */
  onStopOpening(fn) { this._stopOpening = fn; }

  _renderStatus() {
    const box = this.$('.ov-status');
    const s = this._status;
    box.hidden = !s;
    if (!s) return;
    const pct = (f) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
    this.$('.ov-status-text').textContent = s.summary;
    this.$('.ov-status > .ov-toast-bar > div').style.width = pct(s.fraction);
    const stop = this.$('.ov-status-stop');
    stop.hidden = !s.stop;
    if (s.stop) {
      stop.textContent = s.stop.label;
      stop.disabled = !!s.stop.disabled;
    }
    const toggle = this.$('.ov-status-toggle');
    toggle.hidden = !s.rows.length;
    toggle.textContent = this._statusOpen ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(this._statusOpen));
    toggle.title = this._statusOpen ? 'Hide the files' : 'Show each file';
    const list = this.$('.ov-status-rows');
    list.hidden = !this._statusOpen || !s.rows.length;
    if (list.hidden) return;
    list.innerHTML = s.rows.map((r) => `<li class="${r.waiting ? 'waiting' : ''}">
      <div class="ov-status-row"><span class="ov-status-title">${esc(r.title)}</span><span class="ov-status-line">${esc(r.line)}</span>
        <button class="ov-status-cancel" data-id="${esc(r.id)}" title="Stop and close this file" aria-label="Stop and close ${esc(r.title)}">×</button></div>
      <div class="ov-toast-bar"><div style="width:${pct(r.fraction)}"></div></div></li>`).join('');
  }

  /** cb(files, handles): ZIM files picked or dropped (handles: the File System Access API's, or null each). */
  onOpenFiles(cb) { this._openFiles = cb; }
  /** fn() → { files, handles } | null: the handle-giving picker the Open button uses when set. */
  onPickFiles(fn) { this._pickFiles = fn; }
  /** fn(text): a ZIM's web address typed, pasted or dropped (as given: the caller checks it). */
  onOpenUrl(fn) { this._openUrl = fn; }
  /** fn(libId): a local library's × in the list (close it, and forget it). */
  onCloseLibrary(fn) { this._closeLibrary = fn; }
  /**
   * Kiwix's library (ui/kiwix-dialog.js): the card's button shows it once this is given (the
   * catalogue and its callbacks: see KiwixDialog).
   */
  setKiwix(opts) {
    this._kiwix = new KiwixDialog(this.root, opts);
    this.$('.ov-kiwix-btn').hidden = false;
  }
  /** The libraries open changed: Kiwix's list marks them. */
  refreshKiwix() { this._kiwix?.refresh(); }
  onReopen(fn) { this._reopen = fn; }
  onForget(fn) { this._forget = fn; }
  /** The files remembered from last time (names), with Reopen and Forget; none hides the line. */
  setRemembered(names) {
    const line = this.$('.ov-reopen');
    line.hidden = !names.length;
    this.$('.ov-reopen-names').textContent = names.join(', ');
  }
  /** A build without a server (GitHub Pages): no rescan button. */
  setStatic(on) {
    this._static = !!on;
    this.$('.ov-rescan').hidden = this._static;
    if (this._shown) this.setLibraries(...this._shown);
  }
  onEnterVR(cb) { this._enterVR = cb; }

  setVRSupported(ok) {
    this.$('.ov-vr').hidden = !ok;
    this._vr = ok;
    this._renderHelp();
  }

  setMode(mode) {
    this.mode = mode;
    this._renderHint();
    this._renderHelp();
  }

  /** A gamepad is (or stops) driving the view: hint and help show its controls. */
  setGamepad(on) {
    this._pad = on;
    if (on) this._padSeen = true;
    this._renderHint();
    this._renderHelp();
  }

  _renderHint() {
    if (this.tv) {
      const cls = this.root.classList;
      const reading = cls.contains('ov-reading');
      const kind = this._tvCard ? 'card' : reading ? (this._tvList ? 'toc' : 'read') : cls.contains('ov-bookout') ? 'hand' : this._tvList ? 'list' : 'walk';
      this.$('.ov-hint').textContent = TV_HINTS[kind];
      return;
    }
    this.$('.ov-hint').textContent = this._pad ? 'Right stick to look · left stick to walk · A takes a book'
      : this.mode === 'touch' ? 'Drag to look · two fingers to walk · tap a book'
        : 'Drag to look · WASD to walk · click a book';
  }

  _renderHelp() {
    const sections = this.tv ? [['TV remote', HELP.tv]] : [[this.mode === 'touch' ? 'Touch' : 'Mouse & keyboard', HELP[this.mode]]];
    if (this._padSeen) sections.push(['Gamepad', HELP.gamepad]);
    if (this._vr) sections.push(['VR headset', HELP.vr]);
    this.$('.ov-help-body').innerHTML = sections.map(([title, rows]) => `
      <h3>${title}</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`).join('');
  }

  showHelp(show = true) {
    this.$('.ov-help').hidden = !show;
    if (show) this.$('.ov-help-close').focus();
    else this._uiAtHelp = null;
  }

  /**
   * The page's own menus (debug report): the library card, the search box and whether its results
   * are open, the update banner, the loading or error screen, the toasts on screen.
   */
  uiState() {
    const loading = this.$('.ov-loading');
    return {
      card: this.$('.ov-card').classList.contains('collapsed') ? 'collapsed' : 'open',
      search: { q: this.$('.ov-search input').value, open: !this.$('.ov-results').hidden },
      update: !this.$('.ov-update').hidden,
      kiwix: this._kiwix?.visible ? { ...this._kiwix._prefs() } : null,
      loading: loading.hidden || loading.classList.contains('done') ? null
        : { text: this.$('.ov-loading-text').textContent, error: loading.classList.contains('error') },
      toasts: [...this.root.querySelectorAll('.ov-toast:not(.out)')].map((t) => t.textContent),
    };
  }

  /** uiState() for the debug report: as it was when the help was opened, which the report comes from. */
  reportUi() { return this._uiAtHelp ?? this.uiState(); }

  /** Minimizes (or opens) the library card, remembered for the next page load. */
  setCardCollapsed(collapsed) {
    this.$('.ov-card').classList.toggle('collapsed', collapsed);
    const btn = this.$('.ov-collapse');
    btn.textContent = collapsed ? '+' : '–';
    btn.title = collapsed ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-label', btn.title);
    save('card', collapsed ? 'collapsed' : 'open');
  }

  /** Puts back the library card and the search box of a uiState() (__vrlbry.reproduce). */
  restoreUi(ui) {
    if (!ui) return;
    if (ui.card) this.setCardCollapsed(ui.card === 'collapsed');
    if (ui.search) {
      const input = this.$('.ov-search input');
      input.value = ui.search.q || '';
      if (ui.search.open && input.value) this._search(input.value);
      else this._showList(false);
    }
    if (this._kiwix) {
      if (ui.kiwix) {
        this._kiwix._setPrefs({ ...this._kiwix._prefs(), ...ui.kiwix });
        this._kiwix.show();
      } else this._kiwix.hide();
    }
  }

  /**
   * A short message at the bottom of the page for `ms`, or with Infinity until close(): for work
   * under way, with kind 'busy' (a spinner) and progress(fraction) (a bar, from its first call).
   * @returns {{ update: (msg: string) => void, progress: (fraction: number) => void, close: () => void }}
   */
  /**
   * The shared session (together.js): its line under the card's header, or '' to hide it; on a TV
   * with its invite link as text to type on another device (no copying there).
   */
  setSession(text, invite = '') {
    this.$('.ov-session').hidden = !text;
    this.$('.ov-session-text').textContent = text || '';
    this.$('.ov-session-invite').hidden = !(text && invite);
    this.$('.ov-invite-link').textContent = invite.replace(/^https?:\/\//, '');
  }

  /** @param {() => void} fn the session line's Leave */
  onLeaveSession(fn) {
    this.$('.ov-session-leave').onclick = fn;
  }

  /** Where "← Hallway" leads now: the way out, carrying a shared session's room. */
  setWayOutHref(url) {
    this.$('.ov-hallway').href = url;
  }

  showToast(msg, kind = 'info', ms = 3500) {
    if (kind === 'error') noteError('toast', msg); // in "Copy debug info"'s errors too
    const t = document.createElement('div');
    t.className = `ov-toast ${kind}`;
    const text = document.createTextNode(msg);
    t.append(text);
    this.$('.ov-toasts').appendChild(t);
    let bar = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      t.classList.add('out');
      setTimeout(() => t.remove(), 500);
    };
    if (Number.isFinite(ms)) setTimeout(close, ms);
    return {
      update: (msg2) => { text.data = msg2; },
      progress: (f) => {
        if (!bar) {
          const track = document.createElement('div');
          track.className = 'ov-toast-bar';
          bar = document.createElement('div');
          track.append(bar);
          t.append(track);
        }
        bar.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
      },
      close,
    };
  }

  hide() { this.root.classList.add('ov-hidden'); }
  show() { this.root.classList.remove('ov-hidden'); }

  /** Fades the card, search and hint away while a book is open (they cover the pages). */
  setReading(on) {
    this.root.classList.toggle('ov-reading', !!on);
    this._renderHint();
  }

  /** Says something politely to a screen reader (a book opening), once each time it is said. */
  announce(text) {
    const el = this.$('.ov-announce');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 50);
  }

  /** @param {() => void} fn the "Text view" button's (while a book is open on a screen) */
  onTextView(fn) {
    this.$('.ov-textview').onclick = fn;
  }

  /** The help dialog's "Open books as text" (settings.textView): onChange(on). */
  setTextViewPref(on, onChange) {
    const box = this.$('.ov-textview-pref input');
    box.checked = !!on;
    if (onChange) box.onchange = () => onChange(box.checked);
  }

  _search(q) {
    const s = q.trim().toLowerCase();
    const token = ++this._searchToken;
    clearTimeout(this._searchTimer);
    this._articles = [];
    if (!s) {
      this._showList(false);
      this._results = [];
      this._announce('');
      return;
    }
    // Wikipedia articles: from the server (millions of titles), a moment after typing stops. Until
    // they have come, a list with nothing in it yet waits for them (_showResults), for
    // ARTICLE_WAIT at most; articles that come after that are still listed.
    this._downWaits = false;
    clearTimeout(this._dueTimer);
    this._articlesDue = asksArticles(this._libraries, q);
    if (this._articlesDue) {
      this._searchTimer = setTimeout(async () => {
        const found = await findArticles(this._libraries, q, ARTICLE_RESULTS).catch((err) => {
          console.warn('[vrlbry] article search', err);
          return []; // none, as from a library that cannot answer (findArticles)
        });
        if (token !== this._searchToken) return;
        const late = !this._articlesDue; // after the list stopped waiting for them
        this._articlesDue = false;
        clearTimeout(this._dueTimer);
        if (!found.length && (late || this._results.length)) return; // the list as it is
        this._articles = found;
        this._showResults();
      }, 150);
      this._dueTimer = setTimeout(() => {
        if (token !== this._searchToken || !this._articlesDue) return;
        this._articlesDue = false; // none yet: an empty list says so, and a waiting ↓ is given up
        if (!this._results.length) this._showResults();
      }, ARTICLE_WAIT);
    }
    this._books = matchBooks(this._bookIndex(), q, 12);
    this._showResults();
  }

  /**
   * Lists the book results, then the article results (fewer books once articles arrive). With
   * nothing to list while the articles are still to come, the list waits for them: "Searching…",
   * shown and said, and aria-busy (a TV's ↓ then waits in the box: remote.js).
   */
  _showResults() {
    const list = this.$('.ov-results');
    const books = this._articles.length ? this._books.slice(0, 6) : this._books;
    this._results = [...books, ...this._articles];
    const waiting = this._articlesDue && !this._results.length;
    if (waiting) list.setAttribute('aria-busy', 'true');
    else list.removeAttribute('aria-busy');
    // On a TV a result can hold the focus (↓ from the box), and keeps it when the articles arrive.
    const focused = this.tv && list.contains(document.activeElement) ? Number(document.activeElement.dataset.i ?? -1) : -1;
    this._sel = this._results.length ? Math.min(Math.max(focused, 0), this._results.length - 1) : -1;
    const tab = this.tv ? ' tabindex="-1"' : '';
    list.innerHTML = this._results.length
      ? this._results.map((e, i) => (e.article ? `
        <li role="option" id="ov-result-${i}" aria-selected="${i === this._sel}" data-i="${i}" class="${i === this._sel ? 'sel' : ''}"${tab}>
          ${e.lib.illustration ? `<img class="ov-r-icon" ${imgSrc(e.lib.illustration)} alt="" width="34" height="34">` : '<span class="ov-nocover"></span>'}
          <div><div class="ov-r-title">${e.article.from ? `${esc(e.article.from)} → ` : ''}${esc(e.article.title)}</div><div class="ov-r-sub">${esc(e.lib.title)} · Volume ${esc(e.article.book.slice(1))}</div></div>
        </li>` : `
        <li role="option" id="ov-result-${i}" aria-selected="${i === this._sel}" data-i="${i}" class="${i === this._sel ? 'sel' : ''}"${tab}>
          ${e.book.cover ? `<img ${imgSrc(e.book.cover)} alt="" loading="lazy" width="34" height="48">` : '<span class="ov-nocover"></span>'}
          <div><div class="ov-r-title">${esc(e.book.title)}</div><div class="ov-r-sub">${esc(e.book.author || '')}${this._multi() ? ' · ' + esc(e.lib.title) : ''}</div></div>
        </li>`)).join('')
      : `<li class="ov-empty" role="option" aria-disabled="true" aria-selected="false">${waiting ? 'Searching…' : 'No matching books'}</li>`;
    fillLocalImages(list);
    this._showList(true);
    this._announce(this._results.length ? `${this._results.length} ${this._results.length === 1 ? 'result' : 'results'}` : waiting ? 'Searching…' : 'No results');
    list.querySelectorAll('li[data-i]').forEach((li) => {
      li.onclick = () => this._choose(+li.dataset.i);
    });
    if (focused >= 0) {
      if (this._sel >= 0) this._focusResult(this._sel);
      else this._toBox();
    } else if (this._downWaits && !waiting) {
      // The ↓ that waited in the box: on to the first result, if any came and the box still has the focus.
      this._downWaits = false;
      if (this._sel >= 0 && document.activeElement === this.$('.ov-search input')) this._focusResult(0);
    }
  }

  /** Whether more than one library has books (results then name their library). */
  _multi() {
    return this._libraries.filter((l) => this._booksByLib[l.id]?.length).length > 1;
  }

  _searchKey(e) {
    const list = this.$('.ov-results');
    if (e.key !== 'ArrowDown') this._downWaits = false; // another key on the box: a waiting ↓ given up
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this._results.length) {
        // On a TV ↓ before any result has come waits for them (the remote leaves it to the box
        // while the list is aria-busy), then goes to the first (_showResults).
        if (this.tv && e.key === 'ArrowDown' && list.getAttribute('aria-busy') === 'true') this._downWaits = true;
        return;
      }
      if (this.tv) {
        // On a TV the results take the focus, so OK presses one (on the box OK is the keyboard's).
        if (e.key === 'ArrowDown' && !list.hidden) this._focusResult(0);
        return;
      }
      this._sel = (this._sel + (e.key === 'ArrowDown' ? 1 : -1) + this._results.length) % this._results.length;
      this._markSel();
      list.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
      this._activeDescendant();
    } else if (e.key === 'Enter') {
      if (this._sel >= 0) this._choose(this._sel);
    } else if (e.key === 'Escape') {
      this._showList(false);
      if (!this.tv) e.target.blur(); // a TV's Back closes the list only (common's Remote)
    }
  }

  /**
   * A key on a result that holds the focus (a TV): ↑ ↓ from one to the next (staying at the last),
   * ↑ from the first back to the box, OK opens it, Escape (Back) closes them, back on the box.
   * @param {KeyboardEvent} e
   */
  _resultKey(e) {
    const li = /** @type {HTMLElement} */ (e.target).closest?.('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const to = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (to < 0) this._toBox();
      else this._focusResult(Math.min(to, this._results.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this._choose(i);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._showList(false);
      this._toBox();
    }
  }

  /** The focus on result i (a TV), highlighted as the one OK opens. */
  _focusResult(i) {
    this._sel = i;
    this._markSel();
    this.$(`#ov-result-${i}`)?.focus();
  }

  /** The focus back on the search's box from its results, the list left as it is (the keyboard's search key opens the first). */
  _toBox() {
    if (this._sel > 0) {
      this._sel = 0;
      this._markSel();
    }
    this._backToBox = true;
    this.$('.ov-search input').focus();
    this._backToBox = false;
    this._activeDescendant();
  }

  /** The highlighted result (`_sel`) marked: its class and aria-selected. */
  _markSel() {
    this.$('.ov-results').querySelectorAll('li[data-i]').forEach((li, i) => {
      li.classList.toggle('sel', i === this._sel);
      li.setAttribute('aria-selected', String(i === this._sel));
    });
  }

  /**
   * Shows or hides the results (the combobox pattern: the input's aria-expanded, and its
   * aria-activedescendant naming the highlighted result while they show).
   */
  _showList(open) {
    if (!open) {
      // Closed: the article results still to come stay away (they arrive 150 ms after a search),
      // a ↓ waiting for them is given up, and a status still to be said is dropped ("Searching…").
      this._searchToken++;
      clearTimeout(this._searchTimer);
      clearTimeout(this._dueTimer);
      clearTimeout(this._announceTimer);
      this._articlesDue = false;
      this._downWaits = false;
      this.$('.ov-results').removeAttribute('aria-busy');
    }
    this.$('.ov-results').hidden = !open;
    this.$('.ov-search input').setAttribute('aria-expanded', String(open));
    this._activeDescendant();
  }

  /** The input's aria-activedescendant: the highlighted result, while the results show. */
  _activeDescendant() {
    const input = this.$('.ov-search input');
    const open = !this.$('.ov-results').hidden;
    if (open && this._sel >= 0 && this._results?.[this._sel]) input.setAttribute('aria-activedescendant', `ov-result-${this._sel}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /**
   * The number of results for a screen reader (a polite status), said once typing pauses rather
   * than at every letter.
   */
  _announce(text) {
    clearTimeout(this._announceTimer);
    const status = this.$('.ov-search-status');
    if (!text) {
      status.textContent = '';
      return;
    }
    this._announceTimer = setTimeout(() => { status.textContent = text; }, 400);
  }

  _choose(i) {
    const e = this._results[i];
    if (!e) return;
    this._showList(false);
    const input = this.$('.ov-search input');
    input.blur();
    if (e.article) this._pickArticle?.(e.lib.id, e.article);
    else this._pick?.(e.book);
  }
}
