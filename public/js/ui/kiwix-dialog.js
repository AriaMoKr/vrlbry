// Kiwix's library in the page (milestone 3, step 5; optional): the ZIMs this app reads well, by
// kind and language, from Kiwix's catalogue (local/kiwix.js). The card's "Browse Kiwix's
// library…" opens it (ui/overlay.js); Open reads one from the web (main.js openUrls). When the
// catalogue cannot be reached it says so, with Retry: web addresses and files still open. The
// kiosk's Kiwix tab (interaction.js) is the same list in VR.

import { KINDS, sizeText } from '../local/kiwix.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class KiwixDialog {
  /**
   * @param {HTMLElement} root where the dialog goes (the overlay's root)
   * @param {{ catalog: ReturnType<import('../local/kiwix.js').kiwixCatalog>, onOpen: (url: string) => void,
   *   isOpen: (url: string) => boolean, prefs: () => { kind: string, lang: string }, setPrefs: (p: { kind: string, lang: string }) => void }} opts
   */
  constructor(root, { catalog, onOpen, isOpen, prefs, setPrefs }) {
    this._catalog = catalog;
    this._onOpen = onOpen;
    this._isOpen = isOpen;
    this._prefs = prefs;
    this._setPrefs = setPrefs;
    this._token = 0;
    this._view = null;
    const el = document.createElement('div');
    el.className = 'ov-kiwix';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', "Kiwix's library");
    el.innerHTML = `
      <div class="ov-kiwix-inner">
        <header><h2>Kiwix's library</h2><button class="ov-kiwix-close" aria-label="Close">×</button></header>
        <p class="ov-kiwix-note">Books and encyclopedias this library reads well, from
          <a href="https://library.kiwix.org/" target="_blank" rel="noopener">library.kiwix.org</a>.
          Each is read from Kiwix's mirror a little at a time, as it is shown: nothing is downloaded whole.</p>
        <div class="ov-kiwix-filters">
          <div class="ov-kiwix-kinds" role="tablist">${KINDS.map((k) => `<button role="tab" data-kind="${k.id}">${esc(k.label)}</button>`).join('')}</div>
          <select class="ov-kiwix-lang" aria-label="Language"></select>
          <input class="ov-kiwix-find" type="search" placeholder="Filter" aria-label="Filter the list" autocomplete="off" spellcheck="false">
        </div>
        <div class="ov-kiwix-state" role="status"></div>
        <ul class="ov-kiwix-list"></ul>
      </div>`;
    root.appendChild(el);
    this.el = el;
    const $ = (s) => el.querySelector(s);
    this.$ = $;
    $('.ov-kiwix-close').onclick = () => this.hide();
    el.onclick = (e) => { if (e.target === el) this.hide(); };
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
    $('.ov-kiwix-kinds').onclick = (e) => {
      const kind = e.target.closest('[data-kind]')?.dataset.kind;
      if (kind && kind !== this._prefs().kind) {
        this._setPrefs({ ...this._prefs(), kind });
        this.render();
      }
    };
    $('.ov-kiwix-lang').onchange = (e) => {
      this._setPrefs({ ...this._prefs(), lang: e.target.value });
      this.render();
    };
    $('.ov-kiwix-find').oninput = () => this._renderList();
    $('.ov-kiwix-list').onclick = (e) => {
      const btn = e.target.closest('.ov-kiwix-open');
      if (!btn || btn.disabled) return;
      this.hide();
      this._onOpen(btn.dataset.url);
    };
    $('.ov-kiwix-state').onclick = (e) => { if (e.target.closest('.ov-kiwix-retry')) this.render(); };
  }

  get visible() { return !this.el.hidden; }

  show() {
    this.el.hidden = false;
    this.render();
    this.$('.ov-kiwix-find').focus();
  }

  hide() { this.el.hidden = true; }

  /** The libraries open changed: the Open buttons follow. */
  refresh() {
    if (this.visible && this._view) this._renderList();
  }

  /** Reads the list for the chosen kind and language (the catalogue keeps what it read). */
  async render() {
    const { kind, lang } = this._prefs();
    const token = ++this._token;
    for (const b of this.$('.ov-kiwix-kinds').children) b.setAttribute('aria-selected', String(b.dataset.kind === kind));
    this._state("Reading Kiwix's catalogue…");
    this.$('.ov-kiwix-list').innerHTML = '';
    let view;
    try {
      view = await this._catalog.view(kind, lang);
    } catch (err) {
      if (token !== this._token) return;
      this._view = null;
      this._state(`Kiwix's catalogue cannot be reached (${esc(err.message)}). You can still paste a ZIM's web address in the card, or open a file.
        <button class="ov-kiwix-retry">Retry</button>`, true);
      return;
    }
    if (token !== this._token) return;
    this._view = view;
    const select = this.$('.ov-kiwix-lang');
    const langs = view.languages.some((l) => l.code === lang) ? view.languages : [{ code: lang, name: lang, count: 0 }, ...view.languages];
    select.innerHTML = langs.map((l) => `<option value="${esc(l.code)}"${l.code === lang ? ' selected' : ''}>${esc(l.name)} (${l.count})</option>`).join('');
    this._renderList();
  }

  _state(html, error = false) {
    const el = this.$('.ov-kiwix-state');
    el.innerHTML = html;
    el.classList.toggle('error', error);
    el.hidden = !html;
  }

  _renderList() {
    const view = this._view;
    if (!view) return;
    const kind = KINDS.find((k) => k.id === this._prefs().kind)?.label ?? 'ZIM';
    const q = this.$('.ov-kiwix-find').value.trim().toLowerCase();
    const shown = q ? view.entries.filter((e) => `${e.title} ${e.summary} ${e.name}`.toLowerCase().includes(q)) : view.entries;
    this._state(!view.entries.length ? `No ${esc(kind)} ZIMs in this language: choose another.`
      : !shown.length ? 'Nothing matches the filter.' : '');
    this.$('.ov-kiwix-list').innerHTML = shown.map((e) => {
      const open = this._isOpen(e.url);
      const meta = [sizeText(e.size), e.date, e.kind === 'wikipedia' && e.articles ? `${e.articles.toLocaleString()} articles` : ''].filter(Boolean).join(' · ');
      const why = e.needsIndex ? 'Too big to index in the browser, and this site has no index for it: download it and open the file instead' : '';
      return `<li class="ov-kiwix-item${e.needsIndex ? ' big' : ''}">
        ${e.illustration ? `<img src="${esc(e.illustration)}" alt="" width="40" height="40" loading="lazy">` : '<span class="ov-kiwix-noimg"></span>'}
        <div class="ov-kiwix-body"><div class="ov-kiwix-title">${esc(e.title)}</div>
          ${e.about ? `<div class="ov-kiwix-summary">${esc(e.about)}</div>` : ''}
          <div class="ov-kiwix-meta">${esc(meta)}</div>
          ${why ? `<div class="ov-kiwix-warn">${esc(why)}</div>` : ''}</div>
        <button class="ov-kiwix-open" data-url="${esc(e.url)}"${open || e.needsIndex ? ' disabled' : ''}
          title="${esc(open ? 'Already open' : why || "Read it from Kiwix's mirror")}">${open ? 'Open ✓' : 'Open'}</button>
      </li>`;
    }).join('');
  }
}
