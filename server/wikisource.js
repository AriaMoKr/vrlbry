// Wikisource ZIMs (mwoffliner): turns a wiki of ~700k pages into a catalogue of books.
//
// A "book" is a multi-part work: a top-level page (not in a namespace such as Author:) that has
// subpages ("Teeftallow" + "Teeftallow/Chapter_1"…). The index is built once per archive — a
// structure scan, then the works' own pages (categories → genre/year, first large image →
// cover, title-page text) and the Author: pages (which link to their works → author) — and
// cached on disk keyed by the archive UUID. Reading a work assembles its main page and subpages
// in table-of-contents order.

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHref } from './content/html.js';

export const INDEX_VERSION = 1;

/** MediaWiki namespaces that never hold works (Translation: does, so it is not listed). */
const NS_RE = /^(Author|Portal|Wikisource|Help|Category|Template|Index|Page|File|Image|Special|Talk|User|Module|MediaWiki|Draft|Media|TimedText|Gadget|Gadget definition|Topic)(?: talk)?:/;

/** Categories that describe the page, not the work (maintenance, licensing, tracking). */
const NOISE_CAT = /^(PD[- ]|Pages |Headers |Works with |Works using |Index |Subpages|Texts |Translations with|Possible copyright|Copyright|Deletion|Wikisource|Featured|Validated|Proofread|Not proofread|Problematic|Articles |Hidden |Template|Transcriptions|Simple |Undated works|Versions|Disambiguation|Ambiguous|Authors? |Works originally|Novels by |Speeches by |Main pages|Incomplete texts|Plain sisters|Borders using|Page breaks|Automated categorization|Case missing|Ready for export|Raw images|CC-|Works of uncertain|Modern works|Works by unknown)/i;

/** Drops maintenance categories (also applied when loading an index built with fewer rules). */
export function cleanCategories(cats) {
  return cats.filter((c) => typeof c === 'string' && !NOISE_CAT.test(c));
}

/** Genre shelves, in priority order: the first rule matching any category wins. */
export const GENRES = [
  ['Novels', /\bnovel/i],
  ['Short stories', /short stor|\bnovella/i],
  ['Poetry', /\bpoe(m|try|t)|\bverse|ballad|sonnet|\bodes?\b|hymn|songs?\b|lyric/i],
  ['Drama', /\bplays?\b|drama|tragedy|tragedies|comed(y|ies)|libretto|opera/i],
  ["Children's", /child|juvenile|fairy|nursery|fables?\b/i],
  ['Science fiction & fantasy', /science fiction|fantasy|utopia/i],
  ['Mystery & adventure', /mystery|detective|adventure|crime|horror|ghost|western/i],
  ['Religion & philosophy', /relig|bible|biblical|sermon|theolog|philosoph|christian|church|catholic|islam|buddh|hindu|jewish|spiritual|myth/i],
  ['History & biography', /histor|biograph|memoir|autobiograph|diar(y|ies)|obituar|genealog|war\b|wars\b/i],
  ['Science & medicine', /scien|medic|math|astronom|botan|zoolog|geolog|chemi|physic|natural|anatom|biolog|engineer|technolog|agricult/i],
  ['Court decisions', /court decision|supreme court|court of appeal|high court|privy council|\bcases\b/i],
  ['Law & politics', /\blaw\b|laws\b|legislat|treat(y|ies)|government|politic|constitution|court|\bacts?\b|executive order|statute|legal|parliament|congress|diplomac|proclamation/i],
  ['Speeches & letters', /speech|address|lecture|letters?\b|correspondence|oration/i],
  ['Essays', /essay|criticism|review/i],
  ['Travel & geography', /travel|geograph|voyage|exploration|description of/i],
  ['Reference', /encyclop|dictionar|reference|gazetteer|atlas|glossar|lexicon|handbook|manual/i],
  ['Periodicals', /periodical|magazine|journal|newspaper|gazette|annual report/i],
  ['Education', /educat|textbook|school|grammar|reader\b|primer/i],
];
export const OTHER_GENRE = 'Other works';

/** True for a Wikisource ZIM (by its metadata). */
export function isWikisource(meta) {
  const src = String(meta?.Source ?? '');
  const tags = String(meta?.Tags ?? '');
  return /wikisource\.org$/i.test(src) || /(^|;)\s*wikisource\s*(;|$)/i.test(tags);
}

/** Genre shelf of a work from its categories. */
export function genreOf(cats) {
  for (const [name, re] of GENRES) if (cats.some((c) => re.test(c))) return name;
  return OTHER_GENRE;
}

/** Publication year from categories like "1926 works". */
export function yearOf(cats) {
  for (const c of cats) {
    const m = /^(\d{3,4}) works$/.exec(c);
    if (m) return +m[1];
  }
  return null;
}

/** Content categories of a page (from mwoffliner's embedded RLCONF), maintenance ones removed. */
export function pageCategories(html) {
  const m = /"wgCategories":(\[[^\]]*\])/.exec(html);
  if (!m) return [];
  try {
    return cleanCategories(JSON.parse(m[1])).slice(0, 12);
  } catch {
    return [];
  }
}

/** The page's content area (skips skin chrome before it and categories/footer after it). */
function contentArea(html) {
  let start = html.indexOf('id="mw-content-text"');
  if (start < 0) start = html.indexOf('<body');
  let end = html.indexOf('id="catlinks"', start);
  if (end < 0) end = html.length;
  return html.slice(Math.max(0, start), end);
}

/** Images that are page furniture, not covers: licence/notice icons, logos, ornaments. */
const NOT_A_COVER = /\.svg\.png$|-icon\b|icon\.|copyright|logo|ornament|ambox|coat_of_arms|open_book|wikisource|wikipedia|commons|separator|divider|rule\b|flourish/i;

/**
 * First reasonably large image of the content (≥ 120 px wide) that is not page furniture: the
 * cover or title page. Images in the licence banner at the bottom never count.
 */
export function coverOf(html, docPath) {
  let area = contentArea(html);
  const lic = area.search(/class="[^"]*\blicenseContainer\b/);
  if (lic > 0) area = area.slice(0, lic);
  for (const m of area.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    const src = /\ssrc="([^"]+)"/.exec(tag)?.[1];
    const w = +(/\swidth="(\d+)"/.exec(tag)?.[1] ?? 0);
    const fw = +(/\sdata-file-width="(\d+)"/.exec(tag)?.[1] ?? 0);
    if (!src || Math.max(w, fw) < 120 || NOT_A_COVER.test(src)) continue;
    const p = resolveHref(src.replace(/&amp;/g, '&'), docPath);
    if (p && !p.startsWith('data:')) return p;
  }
  return null;
}

/** Plain text of the first part of a page (title page, used to tell co-credited authors apart). */
function snippet(html, max = 4000) {
  return contentArea(html).slice(0, 60000).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').slice(0, max);
}

const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Links from a page's content area, resolved to archive URLs in namespace C (document order, unique). */
export function contentLinks(html, docPath) {
  const out = [];
  const seen = new Set();
  for (const m of contentArea(html).matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const p = resolveHref(m[1].replace(/&amp;/g, '&'), docPath);
    if (!p || !p.startsWith('C/')) continue;
    const url = p.slice(2);
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function decode(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

/** Runs `fn` over items with bounded concurrency. */
async function eachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  }));
}

/**
 * Builds the works index of a Wikisource archive (takes a minute or few for a full ZIM).
 * @param {import('./zim/reader.js').ZimArchive} archive
 * @param {{ onProgress?: (stage: string, fraction: number) => void, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ version: number, uuid: string, works: Array<object> }>}
 */
export async function buildIndex(archive, { onProgress = () => {}, log = () => {} } = {}) {
  const t0 = performance.now();
  // 1. Structure: top-level pages, subpage counts per root, author pages.
  const top = new Map();
  const subs = new Map();
  const authorPages = [];
  let n = 0;
  const total = archive.entryCount;
  for await (const e of archive.entries()) {
    if ((++n & 0x7fff) === 0) onProgress('scan', n / total);
    if (e.ns !== 'C' || e.isRedirect || !e.mime || !e.mime.startsWith('text/html')) continue;
    const url = e.url;
    const ns = NS_RE.exec(url);
    if (ns) {
      if (ns[1] === 'Author' && !url.includes('/')) authorPages.push(e);
      continue;
    }
    if (url === 'Main_Page') continue;
    const slash = url.indexOf('/');
    if (slash < 0) top.set(url, e);
    else {
      const root = url.slice(0, slash);
      subs.set(root, (subs.get(root) || 0) + 1);
    }
  }
  const works = [];
  for (const [url, e] of top) {
    const parts = subs.get(url);
    if (parts) works.push({ url, title: e.title || url.replace(/_/g, ' '), index: e.index, cluster: e.cluster, blob: e.blob, parts });
  }
  top.clear();
  subs.clear();
  log(`  structure: ${works.length} multi-part works, ${authorPages.length} author pages (${Math.round((performance.now() - t0) / 1000)} s)`);

  // 2. Each work's main page: categories, cover, title-page text. Cluster order → each cluster
  //    is decompressed once.
  const byCluster = (a, b) => (a.cluster - b.cluster) || (a.blob - b.blob);
  works.sort(byCluster);
  const snippets = new Map();
  let done = 0;
  await eachLimit(works, 4, async (w) => {
    try {
      const c = await archive.getContent(`C/${w.url}`);
      if (c) {
        const html = decode(c.data);
        w.cats = pageCategories(html);
        w.year = yearOf(w.cats);
        w.cover = coverOf(html, c.entry.path);
        snippets.set(w.url, fold(snippet(html)));
      }
    } catch { /* unreadable page: keep the work, without metadata */ }
    if ((++done & 0x1ff) === 0) onProgress('works', done / works.length);
  });
  log(`  work pages read (${Math.round((performance.now() - t0) / 1000)} s)`);

  // 3. Author pages link to their works.
  const workSet = new Set(works.map((w) => w.url));
  const credits = new Map(); // work url -> [author names] in author-page order
  authorPages.sort(byCluster);
  done = 0;
  await eachLimit(authorPages, 4, async (a) => {
    try {
      const c = await archive.getContent(a);
      if (c) {
        const name = (a.title || a.url).replace(/^Author:/, '').replace(/_/g, ' ').trim();
        const html = decode(c.data);
        const mine = new Set();
        for (const url of contentLinks(html, c.entry.path)) {
          const root = url.split('/')[0];
          if (workSet.has(root)) mine.add(root);
        }
        for (const root of mine) {
          const list = credits.get(root);
          if (list) list.push(name);
          else credits.set(root, [name]);
        }
      }
    } catch { /* skip */ }
    if ((++done & 0x3ff) === 0) onProgress('authors', done / authorPages.length);
  });
  // Pick each work's author: the only credit, or among several (translators, editors, works
  // "about" someone) the one whose surname appears on the title page.
  for (const w of works) {
    const names = credits.get(w.url);
    if (!names) continue;
    if (names.length === 1) {
      w.author = names[0];
      continue;
    }
    const text = snippets.get(w.url) || '';
    const surname = (nm) => fold(nm.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).pop() || '');
    w.author = names.find((nm) => {
      const s = surname(nm);
      return s.length >= 3 && text.includes(s);
    }) || names[0];
  }
  works.sort((a, b) => a.index - b.index);
  log(`  authors matched for ${works.filter((w) => w.author).length}/${works.length} works (${Math.round((performance.now() - t0) / 1000)} s)`);
  onProgress('done', 1);
  return {
    version: INDEX_VERSION,
    uuid: archive.header.uuid,
    works: works.map((w) => [w.url, w.title, w.index, w.parts, w.cover ?? null, w.year ?? null, w.cats ?? [], w.author ?? null]),
  };
}

/** Index file path for an archive. */
export function indexPath(cacheDir, archive) {
  return path.join(cacheDir, `wikisource-${archive.header.uuid}.v${INDEX_VERSION}.json`);
}

/** Loads a cached index, or null when absent/stale/corrupt. */
export async function loadIndex(file, archive) {
  try {
    const idx = JSON.parse(await fs.readFile(file, 'utf8'));
    if (idx?.version !== INDEX_VERSION || idx.uuid !== archive.header.uuid || !Array.isArray(idx.works)) return null;
    return idx;
  } catch {
    return null;
  }
}

/** Saves an index atomically (temp file + rename). */
export async function saveIndex(file, idx) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(idx));
  await fs.rename(tmp, file);
}

/** Natural sort key: numbers compare by value ("Chapter_2" < "Chapter_10"). */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * The pages of a work in reading order: the main page, then subpages depth-first in the order
 * their parent links to them (the main page may link any descendant, other pages only their own
 * descendants, so in-text links to sibling chapters cannot reorder the book). Subpages nobody
 * links to are appended in natural order when the links found cover less than half of them.
 * @param {import('./zim/reader.js').ZimArchive} archive
 * @param {string} rootUrl URL of the work's main page in namespace C
 * @param {{ maxParts?: number, maxBytes?: number, expectedParts?: number }} [opts]
 * @returns {Promise<{ parts: Array<{ url: string, path: string, html: string, depth: number }>, truncated: boolean, total: number }>}
 */
export async function collectWork(archive, rootUrl, { maxParts = 1200, maxBytes = 36e6, expectedParts = 0 } = {}) {
  const parts = [];
  const seen = new Set();
  let bytes = 0;
  let truncated = false;
  const full = () => {
    if (parts.length >= maxParts || bytes >= maxBytes) truncated = true;
    return truncated;
  };
  const visit = async (url, depth) => {
    if (seen.has(url) || full()) return;
    seen.add(url);
    const c = await archive.getContent(`C/${url}`).catch(() => null);
    if (!c || !c.mime || !c.mime.startsWith('text/html')) return;
    const html = decode(c.data);
    bytes += html.length;
    parts.push({ url, path: c.entry.path, html, depth });
    const scope = depth === 0 ? `${rootUrl}/` : `${url}/`;
    for (const link of contentLinks(html, c.entry.path)) {
      if (link.startsWith(scope) && !seen.has(link)) await visit(link, depth + 1);
      if (truncated) return;
    }
  };
  await visit(rootUrl, 0);
  // Completeness: unlinked subpages (e.g. a TOC on a separate page), in natural order.
  if (!truncated && expectedParts && parts.length - 1 < expectedParts / 2) {
    const start = await archive.lowerBound('C', `${rootUrl}/`);
    const rest = [];
    for await (const e of archive.entries(start)) {
      if (e.ns !== 'C' || !e.url.startsWith(`${rootUrl}/`)) break;
      if (!e.isRedirect && !seen.has(e.url) && e.mime?.startsWith('text/html')) rest.push(e.url);
    }
    rest.sort(naturalCompare);
    for (const url of rest) {
      if (full()) break;
      await visit(url, Math.min(3, url.split('/').length - 1));
    }
  }
  return { parts, truncated, total: expectedParts + 1 };
}

/** Heading text for a part: its last path segment, readable. */
export function partTitle(url) {
  const seg = url.slice(url.lastIndexOf('/') + 1);
  return seg.replace(/_/g, ' ').trim();
}
