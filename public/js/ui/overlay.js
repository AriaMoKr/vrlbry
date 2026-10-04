// DOM overlay for non-VR use (SPEC §5.6): library card, search, Enter VR, help, loading, toasts.
// Hidden while an immersive session is running.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HELP = {
  desktop: [
    ['Look around', 'Drag with the mouse'],
    ['Walk', 'W A S D or ↑ ↓ · turn with ← → or Q E · Shift to hurry'],
    ['Take a book', 'Click it on the shelf'],
    ['Read', 'Click the book or “Read” · turn pages with ← → / Space / click a page'],
    ['Text size', '+ / − or the A− A+ buttons'],
    ['Put it back', 'Esc or “Put back”'],
  ],
  touch: [
    ['Look around', 'Drag with one finger'],
    ['Walk', 'Drag with two fingers'],
    ['Take a book', 'Tap it on the shelf'],
    ['Read', 'Tap “Read” · swipe or tap the page edges to turn'],
    ['Put it back', 'Tap “Put back”'],
  ],
  vr: [
    ['Point & select', 'Aim the ray, pull the trigger (or pinch with hand tracking)'],
    ['Teleport', 'Push the right stick forward, aim the arc, release'],
    ['Turn', 'Flick the right stick left / right · left stick walks'],
    ['Read', 'Flick the right stick or trigger a page to turn · grip to move the book'],
    ['Book distance / size', 'Right stick up/down · left stick up/down'],
    ['Close / put back', 'B or Y button'],
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
    root.innerHTML = `
      <div class="ov-loading" role="status" aria-live="polite">
        <div class="ov-logo">vrlbry</div>
        <div class="ov-loading-text">Opening the library…</div>
        <div class="ov-progress"><div class="ov-progress-bar"></div></div>
      </div>
      <section class="ov-card" aria-label="Library">
        <header><span class="ov-brand">vrlbry</span><span class="ov-tools"><button class="ov-rescan" aria-label="Rescan the ZIM folder" title="Rescan the ZIM folder">⟳</button><button class="ov-collapse" aria-label="Collapse" title="Collapse">–</button></span></header>
        <div class="ov-libs"></div>
      </section>
      <div class="ov-search" role="search">
        <input type="search" placeholder="Find a book or author…" aria-label="Find a book" autocomplete="off" spellcheck="false">
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
        </div>
      </div>
      <div class="ov-toasts" aria-live="polite"></div>`;
    this.$ = (sel) => root.querySelector(sel);
    this.$('.ov-collapse').onclick = () => {
      const card = this.$('.ov-card');
      card.classList.toggle('collapsed');
      this.$('.ov-collapse').textContent = card.classList.contains('collapsed') ? '+' : '–';
    };
    this.$('.ov-rescan').onclick = () => this._rescan?.();
    this.$('.ov-help-btn').onclick = () => this.showHelp(true);
    this.$('.ov-help-close').onclick = () => this.showHelp(false);
    this.$('.ov-help').onclick = (e) => {
      if (e.target === this.$('.ov-help')) this.showHelp(false);
    };
    this.$('.ov-vr').onclick = () => this._enterVR?.();
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
  }

  /**
   * @param {object[]} libraries
   * @param {Record<string, object[]>} booksByLib
   */
  setLibraries(libraries, booksByLib) {
    const total = libraries.reduce((n, l) => n + (booksByLib[l.id]?.length || 0), 0);
    this.$('.ov-libs').innerHTML = libraries.length
      ? libraries.map((l) => `
        <div class="ov-lib">
          ${l.illustration ? `<img src="${esc(l.illustration)}" alt="" width="40" height="40">` : ''}
          <div><div class="ov-lib-title">${esc(l.title)}</div>
          <div class="ov-lib-desc">${esc(l.longDescription || l.description || '')}</div>
          <div class="ov-lib-meta">${l.indexing && l.indexing.stage !== 'failed'
            ? `indexing works… ${Math.round((l.indexing.progress || 0) * 100)}%`
            : `${(booksByLib[l.id]?.length || 0).toLocaleString()} ${l.kind === 'wikisource' ? 'works' : 'books'}`} · ${esc(l.file)}</div></div>
        </div>`).join('') + (libraries.length > 1 ? `<div class="ov-lib-meta">${total.toLocaleString()} books in ${libraries.length} libraries</div>` : '')
      : '<div class="ov-lib-desc">No .zim files were found in the server folder. Add some and reload.</div>';
    this._index = [];
    for (const l of libraries) {
      for (const b of booksByLib[l.id] || []) {
        this._index.push({ book: b, lib: l, hay: `${b.title} ${b.subtitle || ''} ${b.author || ''}`.toLowerCase(), title: (b.title || '').toLowerCase() });
      }
    }
  }

  onSearchPick(cb) { this._pick = cb; }
  onRescan(cb) { this._rescan = cb; }
  onEnterVR(cb) { this._enterVR = cb; }

  setVRSupported(ok) {
    this.$('.ov-vr').hidden = !ok;
    this._vr = ok;
    this._renderHelp();
  }

  setMode(mode) {
    this.mode = mode;
    this.$('.ov-hint').textContent = mode === 'touch'
      ? 'Drag to look · two fingers to walk · tap a book'
      : 'Drag to look · WASD to walk · click a book';
    this._renderHelp();
  }

  _renderHelp() {
    const sections = [[this.mode === 'touch' ? 'Touch' : 'Mouse & keyboard', HELP[this.mode]]];
    if (this._vr) sections.push(['VR headset', HELP.vr]);
    this.$('.ov-help-body').innerHTML = sections.map(([title, rows]) => `
      <h3>${title}</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`).join('');
  }

  showHelp(show = true) {
    this.$('.ov-help').hidden = !show;
    if (show) this.$('.ov-help-close').focus();
  }

  showToast(msg, kind = 'info', ms = 3500) {
    const t = document.createElement('div');
    t.className = `ov-toast ${kind}`;
    t.textContent = msg;
    this.$('.ov-toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 500);
  }

  hide() { this.root.classList.add('ov-hidden'); }
  show() { this.root.classList.remove('ov-hidden'); }

  /** Fades the card, search and hint away while a book is open (they cover the pages). */
  setReading(on) { this.root.classList.toggle('ov-reading', !!on); }

  _search(q) {
    const list = this.$('.ov-results');
    const s = q.trim().toLowerCase();
    if (!s) {
      list.hidden = true;
      this._results = [];
      return;
    }
    const terms = s.split(/\s+/);
    const scored = [];
    for (const e of this._index) {
      if (!terms.every((t) => e.hay.includes(t))) continue;
      let score = 0;
      if (e.title.startsWith(s)) score += 100;
      else if (e.title.includes(' ' + s) || e.title.includes(s)) score += 40;
      score -= (e.book.rank || 0) / 1e4;
      scored.push([score, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    this._results = scored.slice(0, 12).map((x) => x[1]);
    this._sel = this._results.length ? 0 : -1;
    list.innerHTML = this._results.length
      ? this._results.map((e, i) => `
        <li role="option" data-i="${i}" class="${i === this._sel ? 'sel' : ''}">
          ${e.book.cover ? `<img src="${esc(e.book.cover)}" alt="" loading="lazy" width="34" height="48">` : '<span class="ov-nocover"></span>'}
          <div><div class="ov-r-title">${esc(e.book.title)}</div><div class="ov-r-sub">${esc(e.book.author || '')}${this._multi() ? ' · ' + esc(e.lib.title) : ''}</div></div>
        </li>`).join('')
      : '<li class="ov-empty">No matching books</li>';
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
    this._pick?.(e.book);
  }
}
