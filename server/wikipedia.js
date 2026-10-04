// Wikipedia ZIMs (mwoffliner) as a room of encyclopedia volumes (SPEC §2.5): the articles in the
// app's title order, cut into volumes of VOLUME_SIZE consecutive articles. The index needs titles
// only (no article is read), so building it is a scan of the directory plus one sort; it is built
// in the background on first open and cached in .cache/ like the Wikisource index.

import fs from 'node:fs/promises';
import path from 'node:path';
import { titleKey } from '../public/js/util/books.js';

export const INDEX_VERSION = 3; // bump when the index format or what counts as an article changes
/** Articles per volume. */
export const VOLUME_SIZE = 1000;
/**
 * Estimated text characters per byte of an article's HTML (mwoffliner pages carry markup,
 * references and styles): the reader estimates page numbers from it until an article is loaded.
 */
export const CHARS_PER_HTML_BYTE = 0.15;

/** Estimated characters of an article from its HTML size. */
export function articleChars(htmlBytes) {
  return Math.max(200, Math.round((htmlBytes || 0) * CHARS_PER_HTML_BYTE));
}

const HTML_MIME = /^(text\/html|application\/xhtml\+xml)\b/i;

/** True for a Wikipedia ZIM: Source "*.wikipedia.org", or a "wikipedia" tag. */
export function isWikipedia(meta) {
  const src = String(meta?.Source ?? '');
  const tags = String(meta?.Tags ?? '');
  return /(^|\.)wikipedia\.org$/i.test(src) || /(^|;)\s*wikipedia\s*(;|$)/i.test(tags);
}

/** The same order as util/books.js sorts book titles (titleKey, then a default Intl.Collator). */
const collator = new Intl.Collator();

/**
 * Builds the article index: every non-redirect HTML entry of the article namespace except the
 * main page, in title order, and the volumes cut from it.
 * @param {import('./zim/reader.js').ZimArchive} archive
 * @param {{ volumeSize?: number, onProgress?: (stage: string, fraction: number) => void, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ version, uuid, ns, volumeSize, count, order: Uint32Array, sizes: Uint32Array, volumes: Array<[string, string]> }>}
 *   order: entry indices in title order; sizes: their HTML bytes; volumes: [first title, last title]
 */
export async function buildIndex(archive, { volumeSize = VOLUME_SIZE, onProgress = () => {}, log = () => {} } = {}) {
  const ns = archive.newNamespaceScheme ? 'C' : 'A';
  const start = await archive.lowerBound(ns, '');
  const end = await archive.lowerBound(String.fromCharCode(ns.charCodeAt(0) + 1), '');
  const main = await archive.getMainEntry().catch(() => null);
  const candidates = [];
  const total = Math.max(1, end - start);
  let seen = 0;
  for await (const e of archive.entries(start, end)) {
    if (++seen % 20000 === 0) onProgress('scan', seen / total);
    if (e.isRedirect || !e.mime || !HTML_MIME.test(e.mime)) continue;
    if (main && e.index === main.index) continue;
    candidates.push({ index: e.index, title: e.title || e.url, cluster: e.cluster, blob: e.blob });
  }
  onProgress('scan', 1);
  // mwoffliner stores redirects to a section as tiny HTML pages (<meta http-equiv="refresh">)
  // rather than ZIM redirects; they are redirects too. Their size gives them away, which needs
  // each page's cluster decompressed: in cluster order, every cluster is decompressed once.
  candidates.sort((a, b) => a.cluster - b.cluster || a.blob - b.blob);
  const entries = [];
  const titles = [];
  const bytes = [];
  let redirectPages = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (i % 2000 === 0) onProgress('sizes', i / candidates.length);
    const c = candidates[i];
    const size = await htmlSize(archive, c.index);
    if (size === REDIRECT) {
      redirectPages++;
      continue;
    }
    entries.push(c.index);
    titles.push(c.title);
    bytes.push(size);
  }
  onProgress('sizes', 1);
  log(` ${entries.length} articles (${redirectPages} redirect pages skipped); sorting titles…`);
  const keys = titles.map(titleKey);
  const perm = new Uint32Array(entries.length);
  for (let i = 0; i < perm.length; i++) perm[i] = i;
  perm.sort((a, b) => collator.compare(keys[a], keys[b]) || collator.compare(titles[a], titles[b]) || entries[a] - entries[b]);
  onProgress('sort', 1);
  const order = new Uint32Array(perm.length);
  const sizes = new Uint32Array(perm.length);
  for (let i = 0; i < perm.length; i++) {
    order[i] = entries[perm[i]];
    sizes[i] = Math.min(0xffffffff, bytes[perm[i]] || 0);
  }
  const volumes = [];
  for (let from = 0; from < perm.length; from += volumeSize) {
    const to = Math.min(perm.length, from + volumeSize);
    volumes.push([titles[perm[from]], titles[perm[to - 1]]]);
  }
  return { version: INDEX_VERSION, uuid: archive.header.uuid, ns, volumeSize, count: order.length, order, sizes, volumes };
}

/** Pages at most this big are checked for being a redirect page (real articles are far bigger). */
const REDIRECT_PAGE_MAX = 1024;

const REDIRECT = -1;

/** An HTML entry's size in bytes, or REDIRECT for a mwoffliner redirect page (a tiny page with a meta refresh). */
async function htmlSize(archive, index) {
  const entry = await archive.getEntryByIndex(index);
  const size = await archive.getBlobSize(entry);
  if (size === null || size > REDIRECT_PAGE_MAX) return size ?? 0;
  const content = await archive.getContent(entry);
  return content && /<meta[^>]+http-equiv=["']?refresh/i.test(content.data.toString('utf8')) ? REDIRECT : size;
}

/** True when an HTML entry is a mwoffliner redirect page. */
export async function isRedirectPage(archive, index) {
  return (await htmlSize(archive, index)) === REDIRECT;
}

export function indexPath(cacheDir, archive) {
  return path.join(cacheDir, `wikipedia-${archive.header.uuid}.v${INDEX_VERSION}.json`);
}

/** Loads a cached index (order decoded to a Uint32Array), or null when absent/stale/corrupt. */
export async function loadIndex(file, archive) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw?.version !== INDEX_VERSION || raw.uuid !== archive.header.uuid || !Array.isArray(raw.volumes)) return null;
    // Copied out of the Buffers: their offsets may be unaligned for a Uint32Array.
    const u32 = (b64) => new Uint32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
    const order = u32(raw.order);
    const sizes = u32(raw.sizes);
    if (order.length !== raw.count || sizes.length !== raw.count) return null;
    return { ...raw, order, sizes };
  } catch {
    return null;
  }
}

/** Saves an index atomically (temp file + rename); `order` and `sizes` are stored as base64. */
export async function saveIndex(file, idx) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  await fs.writeFile(tmp, JSON.stringify({ ...idx, order: b64(idx.order), sizes: b64(idx.sizes) }));
  await fs.rename(tmp, file);
}

/** The title of a volume: its range ("Aachen – Abbey"), or the one title of a one-article volume. */
export function volumeTitle([first, last]) {
  return first === last ? first : `${first} – ${last}`;
}
