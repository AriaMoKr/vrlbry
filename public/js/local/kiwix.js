// Kiwix's library (milestone 3, step 5; optional): the ZIMs this app reads well (Project
// Gutenberg, Wikipedia, Wikisource) as Kiwix's OPDS catalogue lists them (library.kiwix.org,
// which lets a page read it: CORS *), for the card's dialog (ui/kiwix-dialog.js) and the kiosk's
// Kiwix tab (interaction.js). Read live, one feed per kind with every language (100 KB to 1.5 MB,
// about 100 KB compressed, revalidated by its ETag), so it is never out of date and a language is
// chosen without another request. Read only once a visitor asks for a list (the dialog opened, the
// tab or its button pressed: `asked`), so a page left alone asks nothing of Kiwix's server, and
// kept for the page's life; each visit asks anew. When it cannot be reached the page says so, and
// web addresses and files still open: nothing else needs it.

import { indexNamesFor } from '../core/index-versions.js';
import { libraryTitle } from '../util/library-title.js';
import { URL_INDEX_BUILD_BYTES, zimUrl } from './zim-url.js';

export const CATALOG_ORIGIN = 'https://opds.library.kiwix.org';
/** The kinds listed, in this order. */
export const KINDS = Object.freeze([
  Object.freeze({ id: 'gutenberg', label: 'Gutenberg' }),
  Object.freeze({ id: 'wikipedia', label: 'Wikipedia' }),
  Object.freeze({ id: 'wikisource', label: 'Wikisource' }),
]);
/**
 * The prebuilt indexes this site has (tools/build-pages.mjs --indexes writes the list). In two
 * steps: the Pages build takes a new URL('….js…', import.meta.url) for a module to tag.
 */
const INDEX_LIST_URL = new URL('list.json', new URL('../../indexes/', import.meta.url));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => (
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name.toLowerCase()] ?? m));
/** An element's text (the first one named `tag`), decoded, or null. */
const textOf = (xml, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decode(m[1].trim()) : null;
};
/** Every <link>'s attributes. */
const linksOf = (xml) => [...xml.matchAll(/<link\b([^>]*?)\/?>/g)].map((m) => Object.fromEntries(
  [...m[1].matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)])));
const FLAVOURS = ['maxi', '', 'nopic', 'mini']; // a topic's editions, the fullest first
const collator = new Intl.Collator();

/**
 * The entries of an OPDS acquisition feed (libkiwix's /catalog/v2/entries), as the app lists them.
 * The feed is machine-written and regular, so it is read with patterns (no DOMParser in a worker
 * or in Node). Entries without a ZIM to read are left out.
 * @param {string} xml
 * @param {{ origin?: string }} [opts] where relative links (thumbnails) point
 * @returns {Array<{ uuid: string, name: string, kind: string, languages: string[], flavour: string,
 *   title: string, zimTitle: string, summary: string, about: string, articles: number|null, size: number|null,
 *   date: string|null, url: string, illustration: string|null }>} title: as the app shows the
 *   library (libraryTitle); uuid: 32 hex digits, as index names have it
 */
export function parseEntries(xml, { origin = CATALOG_ORIGIN } = {}) {
  const out = [];
  for (const [entry] of String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const links = linksOf(entry);
    const zim = links.find((l) => /acquisition/.test(l.rel ?? '') && /x-zim/.test(l.type ?? ''));
    const url = zim?.href ? zimUrl(zim.href, { pageProtocol: 'https:' }).url : null;
    if (!url) continue;
    const kind = textOf(entry, 'category') ?? '';
    const name = textOf(entry, 'name') ?? '';
    const flavour = textOf(entry, 'flavour') ?? '';
    const zimTitle = textOf(entry, 'title') ?? name;
    const summary = textOf(entry, 'summary') ?? '';
    const thumb = links.find((l) => /thumbnail/.test(l.rel ?? ''));
    const title = libraryTitle({ kind, title: zimTitle, description: summary, name, flavour });
    out.push({
      uuid: (textOf(entry, 'id') ?? '').replace(/^urn:uuid:/i, '').replace(/-/g, '').toLowerCase(),
      name, kind, flavour, zimTitle, summary,
      languages: (textOf(entry, 'language') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      // Gutenberg's whole collections have no class to be named by.
      title,
      // The summary, unless the title already says it (a Gutenberg class).
      about: summary && !title.toLowerCase().includes(summary.toLowerCase()) ? summary : '',
      articles: Number(textOf(entry, 'articleCount')) || null,
      size: Number(zim.length) || null,
      date: /_(\d{4}-\d{2})\.zim$/.exec(url)?.[1] ?? textOf(entry, 'dc:issued')?.slice(0, 7) ?? null,
      url,
      illustration: thumb?.href ? new URL(thumb.href, origin).href : null,
    });
  }
  // By title, a topic's editions together (its plain title), the fullest first.
  const group = (e) => (e.kind === 'wikipedia' ? e.zimTitle : e.title);
  return out.sort((a, b) => collator.compare(group(a), group(b))
    || FLAVOURS.indexOf(a.flavour) - FLAVOURS.indexOf(b.flavour) || collator.compare(a.name, b.name));
}

/** The languages feed (/catalog/v2/languages): ISO 639-3 code → name. */
export function parseLanguages(xml) {
  const names = new Map();
  for (const [entry] of String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const code = textOf(entry, 'dc:language');
    if (code) names.set(code, textOf(entry, 'title') ?? code);
  }
  return names;
}

/** ISO 639-1 → 639-3 for the languages a browser most often says (Kiwix names languages by the latter). */
const ISO3 = {
  en: 'eng', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', ru: 'rus', pl: 'pol', uk: 'ukr',
  cs: 'ces', sk: 'slk', hu: 'hun', ro: 'ron', bg: 'bul', el: 'ell', tr: 'tur', sv: 'swe', no: 'nor', nb: 'nob',
  nn: 'nno', da: 'dan', fi: 'fin', is: 'isl', et: 'est', lv: 'lav', lt: 'lit', hr: 'hrv', sr: 'srp', sl: 'slv',
  ca: 'cat', eu: 'eus', gl: 'glg', he: 'heb', ar: 'ara', fa: 'fas', hi: 'hin', bn: 'ben', ur: 'urd', ta: 'tam',
  te: 'tel', mr: 'mar', zh: 'zho', ja: 'jpn', ko: 'kor', vi: 'vie', th: 'tha', id: 'ind', ms: 'msa', sw: 'swa',
  eo: 'epo', la: 'lat',
};

/** The language to list first: the browser's, as Kiwix names it (English when unknown). */
export function defaultLanguage(langs = globalThis.navigator?.languages ?? []) {
  for (const tag of langs) {
    const code = ISO3[String(tag).toLowerCase().split('-')[0]];
    if (code) return code;
  }
  return 'eng';
}

/** How fast an index is built over the network, for an estimate: the build reads about 70 % of a file at 1 MB/s (measured from here). */
const BUILD_BYTES_PER_SECOND = 1e6 / 0.7;

/**
 * Where an entry's index would come from: 'here' (kept in this browser from an earlier open),
 * 'site' (this site has it prebuilt: fetched when opened), 'build' (small enough to be built in
 * the browser when first opened), 'missing' (too big, and nowhere: it cannot be read well), or
 * null for a kind without one (Gutenberg).
 * @param {object} entry
 * @param {{ site?: Set<string>, here?: Set<string> }} [available] index names (core/index-versions.js
 *   indexNamesFor: the current one, or an older one that is upgraded when read): the site's
 *   indexes/list.json, this browser's store
 * @returns {'here'|'site'|'build'|'missing'|null}
 */
export function indexState(entry, { site = new Set(), here = new Set() } = {}) {
  const names = indexNamesFor(entry.kind, entry.uuid);
  if (!names.length) return null;
  if (names.some((n) => here.has(n))) return 'here';
  if (names.some((n) => site.has(n))) return 'site';
  return (entry.size ?? 0) > URL_INDEX_BUILD_BYTES ? 'missing' : 'build';
}

/** True when the app reads an entry best with an index it has nowhere (a big Wikipedia or Wikisource). */
export function needsIndex(entry, available) {
  return indexState(entry, available) === 'missing';
}

/**
 * The label of an entry's index state, for the lists: { text, title } (title: what it means), or
 * null (Gutenberg).
 */
export function indexLabel(entry) {
  switch (entry.index) {
    case 'here': return { text: 'Indexed here', title: 'Its index is kept in this browser: it opens without building one' };
    case 'site': return { text: 'Index ready', title: 'This site has its index, fetched when it is opened instead of a build' };
    case 'build': {
      const s = ((entry.size ?? 0) / BUILD_BYTES_PER_SECOND);
      const time = s < 60 ? 'under a minute' : `about ${Math.round(s / 60)} min`;
      return { text: `Indexed on first open (${time})`, title: 'Small enough to be indexed in the browser: the first open reads most of the file once, then the index is kept' };
    }
    case 'missing': return { text: 'Needs an index', title: 'Too big to index in the browser, and this site has no index for it: download it and open the file instead' };
    default: return null;
  }
}

/**
 * Kiwix's library, read when first asked for and kept for the page's life (a failure is not kept:
 * asking again tries again). Nothing is read from Kiwix before a feed or the languages are asked
 * for (`asked`); the site's own list of indexes and this browser's store are not Kiwix's.
 * @param {{ fetch?: typeof fetch, origin?: string, timeoutMs?: number, indexList?: URL|string|null,
 *   localIndexes?: () => Promise<Iterable<string>> }} [opts] localIndexes: the names in this
 *   browser's store (local/idb-store.js), asked each time a list is shown (they change as ZIMs
 *   are opened); none when not given or failing
 */
export function kiwixCatalog({
  fetch: fetchImpl = (...a) => globalThis.fetch(...a), origin = CATALOG_ORIGIN, timeoutMs = 20000, indexList = INDEX_LIST_URL,
  localIndexes = null,
} = {}) {
  const feeds = new Map(); // kind → Promise<entries>
  let languageNames = null;
  let prebuilt = null;
  let asked = false; // a feed or the languages asked for: before that nothing is read from Kiwix
  const askers = []; // whenAsked's callbacks, called once
  const ask = () => {
    if (asked) return;
    asked = true;
    // After the asker's turn: a list being drawn asks, and a callback may draw again.
    if (askers.length) queueMicrotask(() => { for (const f of askers.splice(0)) f(); });
  };
  const get = async (url) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      throw new Error(abort.signal.aborted ? 'no answer' : err.message, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  };
  const kept = (map, key, load) => {
    let p = map.get(key);
    if (!p) {
      p = load();
      map.set(key, p);
      p.catch(() => map.delete(key));
    }
    return p;
  };
  return {
    /** Whether Kiwix's catalogue has been asked for (by a list shown): until then nothing was read from it. */
    get asked() { return asked; },
    /** Calls `f` once the catalogue is first asked for (soon, if it already has been), so another list can show it too. */
    whenAsked(f) {
      if (asked) queueMicrotask(f);
      else askers.push(f);
    },
    /** Every entry of a kind (all languages). */
    entries: (kind) => {
      ask();
      return kept(feeds, kind, async () => parseEntries(
        await get(`${origin}/catalog/v2/entries?category=${encodeURIComponent(kind)}&count=-1`), { origin }));
    },
    /** Language names (code → name); empty when they cannot be read (the codes are shown then). */
    languageNames() {
      ask();
      languageNames ??= get(`${origin}/catalog/v2/languages`).then(parseLanguages, () => {
        languageNames = null;
        return new Map();
      });
      return languageNames;
    },
    /** The names of the indexes this site has prebuilt (none when it has no list). */
    prebuilt() {
      prebuilt ??= (indexList ? get(String(indexList)).then((text) => new Set(JSON.parse(text).indexes ?? []))
        : Promise.resolve(new Set())).catch(() => new Set());
      return prebuilt;
    },
    /** The names of the indexes kept in this browser (read again each time). */
    async local() {
      return new Set(localIndexes ? await Promise.resolve().then(localIndexes).catch(() => []) : []);
    },
    /**
     * What a list shows: a kind's entries in one language, each with its `index` state
     * (indexState) and `needsIndex` (those last), and the languages it has ({ code, name, count },
     * most entries first). A flavour that needs an index is left out when another flavour of the
     * same selection opens here (`listed`).
     * @returns {Promise<{ entries: object[], languages: Array<{ code: string, name: string, count: number }> }>}
     */
    async view(kind, lang) {
      const [all, names, site, here] = await Promise.all([this.entries(kind), this.languageNames(), this.prebuilt(), this.local()]);
      const shown = listed(all.map((e) => {
        const index = indexState(e, { site, here });
        return { ...e, index, needsIndex: index === 'missing' };
      }));
      const counts = new Map();
      for (const e of shown) for (const l of e.languages) counts.set(l, (counts.get(l) ?? 0) + 1);
      const languages = [...counts].map(([code, count]) => ({ code, name: names.get(code) ?? code, count }))
        .sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
      // Those that open here first (each part in title order): most big Wikipedias need an index.
      const entries = shown.filter((e) => e.languages.includes(lang)).sort((a, b) => a.needsIndex - b.needsIndex);
      return { entries, languages };
    },
  };
}

/**
 * The entries a list offers: a flavour that needs an index nowhere to be had is left out when
 * another flavour of its selection (its `name`) opens here, since it would only say "Needs an
 * index" (the prebuilt indexes are made for one flavour of each big selection: tools/indexes.txt).
 * A selection none of whose flavours opens keeps them all, listed last.
 * @param {Array<{ name: string, needsIndex: boolean }>} entries
 */
export function listed(entries) {
  const opens = new Set(entries.filter((e) => !e.needsIndex).map((e) => e.name));
  return entries.filter((e) => !e.needsIndex || !opens.has(e.name));
}

/** "37 MB", "4.5 GB": an entry's size. */
export function sizeText(bytes) {
  if (!bytes) return '';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
