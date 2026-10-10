// DOM overlay for non-VR use (SPEC §5.6): library card, search, Enter VR, help, loading, toasts.
// Hidden while an immersive session is running.

import { imageSource } from '../api.js';
import { EXAMPLE_ZIM, MORE_ZIMS_URL, isLocalUrl } from '../local/local.js';
import { droppedHandles } from '../local/handles.js';
import { KiwixDialog } from './kiwix-dialog.js';
import { bookIndex, matchBooks, findArticles } from '../search.js';
import { load, save } from '../util/storage.js';

const ARTICLE_RESULTS = 8; // per Wikipedia library

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

const HELP = {
  desktop: [
    ['Look around', 'Drag with the mouse'],
    ['Walk', 'W A S D or ↑ ↓ · turn with ← → or Q E · Shift to hurry'],
    ['Take a book', 'Click it on the shelf'],
    ['Read', 'Click the book or “Read” · turn pages with ← → / Space / click a page'],
    ['Text size', '+ / − or the A− A+ buttons'],
    ['Put it back', 'Esc or “Put back”'],
    ['Search', 'The box at the top, or type on the catalogue stand’s Search tab (Esc to stop typing)'],
  ],
  touch: [
    ['Look around', 'Drag with one finger'],
    ['Walk', 'Drag with two fingers'],
    ['Take a book', 'Tap it on the shelf'],
    ['Read', 'Tap “Read” · swipe or tap the page edges to turn'],
    ['Put it back', 'Tap “Put back”'],
  ],
  gamepad: [
    ['Look around', 'Right stick'],
    ['Walk', 'Left stick · click it to hurry'],
    ['Take a book', 'Aim the crosshair, press A'],
    ['Read', 'A · turn pages with the bumpers or ← → on the D-pad'],
    ['Text size, contents, theme', 'D-pad ↑ ↓ · X · Y'],
    ['Book distance', 'Triggers'],
    ['Put it back', 'B'],
  ],
  vr: [
    ['Point & select', 'Aim the ray, pull the trigger (or pinch with hand tracking)'],
    ['Teleport', 'Push the right stick forward, aim the arc, release'],
    ['Turn', 'Flick the right stick left / right · left stick walks'],
    ['Read', 'Flick the right stick or trigger a page to turn · grip to move the book'],
    ['Book distance / size', 'Right stick up/down · left stick up/down'],
    ['Close / put back', 'B or Y button'],
    ['Leave VR', 'Hold B or Y for a second while browsing, or “Exit VR” on the catalogue stand'],
  ],
};

export class Overlay {
  /** @param {{ root: HTMLElement }} o */
  constructor({ root }) {
    this.root = root;
    this.mode = 'desktop';
    this._pick = null;
    this._enterVR = null;
    this._index = [];
    this._results = [];
    this._sel = -1;
    this._libraries = [];
    this._books = []; // book results of the current query
    this._articles = []; // article results of the current query
    this._searchToken = 0;
    this._searchTimer = 0;
    this._pickArticle = null;
    root.innerHTML = `
      <div class="ov-loading" role="status" aria-live="polite">
        <div class="ov-logo">vrlbry</div>
        <div class="ov-loading-text">Opening the library…</div>
        <div class="ov-progress"><div class="ov-progress-bar"></div></div>
        <button class="ov-loading-debug" hidden>Copy debug info</button>
      </div>
      <section class="ov-card" aria-label="Library">
        <header><span class="ov-brand">vrlbry</span><span class="ov-version"></span><span class="ov-tools"><button class="ov-rescan" aria-label="Rescan the ZIM folder" title="Rescan the ZIM folder">⟳</button><button class="ov-collapse" aria-label="Collapse" title="Collapse">–</button></span></header>
        <div class="ov-libs"></div>
        <div class="ov-open">
          <button class="ov-open-btn" title="Read ZIM files from this device, in the browser">Open ZIM files…</button>
          <input class="ov-open-input" type="file" accept=".zim" multiple hidden>
          <form class="ov-url" autocomplete="off">
            <input class="ov-url-input" type="text" inputmode="url" spellcheck="false" autocapitalize="off"
              placeholder="or the web address of a ZIM file" aria-label="Web address of a ZIM file">
            <button type="submit" title="Read it from the web, a little at a time">Open</button>
          </form>
          <button class="ov-kiwix-btn" hidden title="The ZIMs this library reads well, from library.kiwix.org">Browse Kiwix's library…</button>
          <div class="ov-reopen" hidden>Last time: <span class="ov-reopen-names"></span>
            <button class="ov-reopen-btn">Reopen</button><button class="ov-reopen-forget" title="Forget these files">Forget</button></div>
          <div class="ov-open-hint">No ZIM file yet? Read
            <button class="ov-try-btn" type="button" title="Read it from Kiwix's mirror, a little at a time">${esc(EXAMPLE_ZIM.title)}</button>
            from Kiwix, or <a href="${esc(EXAMPLE_ZIM.url)}" target="_blank" rel="noopener">download it</a>
            (${esc(EXAMPLE_ZIM.size)}) and open it here.
            <a href="${esc(MORE_ZIMS_URL)}" target="_blank" rel="noopener">More Gutenberg ZIMs</a>: paste one's address above.</div>
        </div>
      </section>
      <div class="ov-drop" hidden>Drop ZIM files, or a ZIM's link, to open them</div>
      <div class="ov-search" role="search">
        <input type="search" placeholder="Find a book, author or article…" aria-label="Find a book or article" autocomplete="off" spellcheck="false">
        <ul class="ov-results" role="listbox" hidden></ul>
      </div>
      <div class="ov-bottom">
        <button class="ov-help-btn" aria-label="Controls help" title="Controls">?</button>
        <button class="ov-vr" hidden>Enter VR</button>
      </div>
      <div class="ov-hint"></div>
      <div class="ov-help" role="dialog" aria-label="Controls" hidden>
        <div class="ov-help-inner">
          <header><h2>How to use the library</h2><button class="ov-help-close" aria-label="Close">×</button></header>
          <div class="ov-help-body"></div>
          <label class="ov-update-pref"><input type="checkbox" checked> Tell me when this site has been updated</label>
          <footer class="ov-debug">
            <div><button class="ov-debug-btn">Copy debug info</button><span class="ov-debug-note">Something wrong? Copy this and paste it into your bug report.</span></div>
            <div><button class="ov-scene-save">Save scene</button><button class="ov-scene-restore" disabled>Restore scene</button><button class="ov-scene-paste">Paste a scene…</button><span class="ov-scene-note">No saved scene</span></div>
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
    this.$('.ov-debug-btn').onclick = () => this._debug?.();
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
    input.addEventListener('focus', () => this._search(input.value));
    document.addEventListener('pointerdown', (e) => {
      if (!this.$('.ov-search').contains(e.target)) this.$('.ov-results').hidden = true;
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
    this._index = bookIndex(libraries, booksByLib);
    this._libraries = libraries;
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
    this.$('.ov-hint').textContent = this._pad ? 'Right stick to look · left stick to walk · A takes a book'
      : this.mode === 'touch' ? 'Drag to look · two fingers to walk · tap a book'
        : 'Drag to look · WASD to walk · click a book';
  }

  _renderHelp() {
    const sections = [[this.mode === 'touch' ? 'Touch' : 'Mouse & keyboard', HELP[this.mode]]];
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
      else this.$('.ov-results').hidden = true;
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
  showToast(msg, kind = 'info', ms = 3500) {
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
  setReading(on) { this.root.classList.toggle('ov-reading', !!on); }

  _search(q) {
    const list = this.$('.ov-results');
    const s = q.trim().toLowerCase();
    const token = ++this._searchToken;
    clearTimeout(this._searchTimer);
    this._articles = [];
    if (!s) {
      list.hidden = true;
      this._results = [];
      return;
    }
    // Wikipedia articles: from the server (millions of titles), a moment after typing stops.
    this._searchTimer = setTimeout(async () => {
      const found = await findArticles(this._libraries, q, ARTICLE_RESULTS);
      if (token !== this._searchToken || !found.length) return;
      this._articles = found;
      this._showResults();
    }, 150);
    this._books = matchBooks(this._index, q, 12);
    this._showResults();
  }

  /** Lists the book results, then the article results (fewer books once articles arrive). */
  _showResults() {
    const list = this.$('.ov-results');
    const books = this._articles.length ? this._books.slice(0, 6) : this._books;
    this._results = [...books, ...this._articles];
    this._sel = this._results.length ? 0 : -1;
    list.innerHTML = this._results.length
      ? this._results.map((e, i) => (e.article ? `
        <li role="option" data-i="${i}" class="${i === this._sel ? 'sel' : ''}">
          ${e.lib.illustration ? `<img class="ov-r-icon" ${imgSrc(e.lib.illustration)} alt="" width="34" height="34">` : '<span class="ov-nocover"></span>'}
          <div><div class="ov-r-title">${e.article.from ? `${esc(e.article.from)} → ` : ''}${esc(e.article.title)}</div><div class="ov-r-sub">${esc(e.lib.title)} · Volume ${esc(e.article.book.slice(1))}</div></div>
        </li>` : `
        <li role="option" data-i="${i}" class="${i === this._sel ? 'sel' : ''}">
          ${e.book.cover ? `<img ${imgSrc(e.book.cover)} alt="" loading="lazy" width="34" height="48">` : '<span class="ov-nocover"></span>'}
          <div><div class="ov-r-title">${esc(e.book.title)}</div><div class="ov-r-sub">${esc(e.book.author || '')}${this._multi() ? ' · ' + esc(e.lib.title) : ''}</div></div>
        </li>`)).join('')
      : '<li class="ov-empty">No matching books</li>';
    fillLocalImages(list);
    list.hidden = false;
    list.querySelectorAll('li[data-i]').forEach((li) => {
      li.onclick = () => this._choose(+li.dataset.i);
    });
  }

  _multi() {
    return new Set(this._index.map((e) => e.lib.id)).size > 1;
  }

  _searchKey(e) {
    const list = this.$('.ov-results');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this._results.length) return;
      this._sel = (this._sel + (e.key === 'ArrowDown' ? 1 : -1) + this._results.length) % this._results.length;
      list.querySelectorAll('li[data-i]').forEach((li, i) => li.classList.toggle('sel', i === this._sel));
      list.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (this._sel >= 0) this._choose(this._sel);
    } else if (e.key === 'Escape') {
      list.hidden = true;
      e.target.blur();
    }
  }

  _choose(i) {
    const e = this._results[i];
    if (!e) return;
    this.$('.ov-results').hidden = true;
    const input = this.$('.ov-search input');
    input.blur();
    if (e.article) this._pickArticle?.(e.lib.id, e.article);
    else this._pick?.(e.book);
  }
}
