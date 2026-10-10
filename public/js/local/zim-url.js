// A ZIM's web address, as someone types or pastes it, made into one this page can read (milestone
// 3, SPEC §2.6): the local library opens it with range requests (core/zim/http-source.js). Used by
// the page (the address field, a dropped link, __vrlbry.openUrl) and the worker (names).

/**
 * The biggest Wikipedia or Wikisource read from the web whose index is built in the browser when
 * none is found (the store, the site's indexes/): building reads most of the file. The worker
 * (local-handler.js) keeps to it, and Kiwix's library (kiwix.js) marks bigger ones.
 */
export const URL_INDEX_BUILD_BYTES = 256 * 1024 * 1024;

/**
 * The most Gutenberg books whose files are looked up as a ZIM from the web opens (ArchiveLibrary
 * bookLookups): about 100 took 2-3 s over the network, so a longer list's books are made from the
 * list alone and looked up when first opened (gutenberg_mul_all's 76,000 took hours otherwise).
 */
export const URL_BOOK_LOOKUPS = 500;

/** Kiwix's own mirror: the one that lets a page read its files (CORS), and serves every ZIM. */
export const KIWIX_MIRROR = 'mirror.download.kiwix.org';

/** Hosts whose /zim/ files are the mirror's: Kiwix's download links redirect to mirrors without CORS. */
const KIWIX_DOWNLOAD = /^(?:lb\.)?download\.kiwix\.org$/i;
/** A catalogue's links next to the file itself (Metalink, torrent, checksums). */
const SIDE_FILE = /(\.zim)\.(?:meta4|torrent|sha256|md5|magnet)$/i;
/** Addresses an https page may still read over http (the browser trusts them). */
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** The file name an address ends with, decoded ("gutenberg_en_lcc-p_2026-03.zim"), or ''. */
export function fileNameOf(url) {
  let last = '';
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The same file on Kiwix's mirror, for an address on another Kiwix mirror (their paths end in
 * /zim/<folder>/<file>; the others send no CORS headers, so a page cannot read them), or null.
 */
export function onKiwixMirror(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === KIWIX_MIRROR) return null;
  const m = /\/zim\/([^/]+\/[^/]+\.zim)$/i.exec(u.pathname);
  return m ? `https://${KIWIX_MIRROR}/zim/${m[1]}` : null;
}

/**
 * The edge proxy the site names (milestone 3 step 7, optional; tools/zim-proxy/): the page's
 * `<meta name="vrlbry-zim-proxy" content="<base>">` (tools/build-pages.mjs --zim-proxy), or the
 * page address's `?zimproxy=<base>` to try one (`?zimproxy=off`: none). Null when none is named
 * or it is not an address this page may read.
 * @param {{ document?: Document, location?: Location }} [where]
 * @returns {string|null} the base, ending in '/'
 */
export function zimProxyOf({ document = globalThis.document, location = globalThis.location } = {}) {
  let named = null;
  try {
    named = new URL(location?.href ?? '').searchParams.get('zimproxy');
  } catch {
    // no page address (a worker, Node)
  }
  if (named === 'off' || named === '') return null;
  named ??= document?.querySelector?.('meta[name="vrlbry-zim-proxy"]')?.getAttribute('content') ?? null;
  if (!named) return null;
  try {
    const base = new URL(named, location?.href);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.test(base.hostname))) return null;
    base.search = '';
    base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return base.href;
  } catch {
    return null;
  }
}

/**
 * The same file through the proxy (`<base>zim/<folder>/<file>`) for one on Kiwix's mirror (the
 * proxy serves Kiwix's files only), or null.
 */
export function proxiedUrl(url, base) {
  if (!base) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/zim\/([^/]+\/[^/]+\.zim)$/i.exec(u.pathname);
  return u.hostname === KIWIX_MIRROR && u.protocol === 'https:' && m ? new URL(`zim/${m[1]}`, base).href : null;
}

/**
 * A ZIM's address made readable: https:// added when no scheme is typed, Kiwix's download links
 * (download.kiwix.org, lb.download.kiwix.org, and their .meta4 / .torrent / .sha256 / .md5 side
 * files) turned into the same file on Kiwix's mirror, the fragment dropped.
 * @param {string} input
 * @param {{ pageProtocol?: string }} [opts] the page's protocol ('https:' refuses http:// addresses,
 *   which the browser would block as mixed content)
 * @returns {{ url: string, name: string } | { error: string }}
 */
export function zimUrl(input, { pageProtocol = globalThis.location?.protocol } = {}) {
  const typed = String(input ?? '').trim();
  if (!typed) return { error: 'Type or paste the address of a ZIM file.' };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { error: `Not a web address: ${typed}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: `Not a web address: ${typed}` };
  if (KIWIX_DOWNLOAD.test(url.hostname) && url.pathname.startsWith('/zim/')) {
    url.protocol = 'https:';
    url.hostname = KIWIX_MIRROR;
    url.port = '';
  }
  url.pathname = url.pathname.replace(SIDE_FILE, '$1');
  url.hash = '';
  if (pageProtocol === 'https:' && url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) {
    return { error: `This page cannot read an http:// address (the browser blocks it on an https page): ${url.href}` };
  }
  const name = fileNameOf(url.href);
  if (!/\.zim$/i.test(name)) return { error: `Not the address of a .zim file: ${url.href}` };
  return { url: url.href, name };
}
