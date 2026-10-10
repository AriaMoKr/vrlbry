// An edge proxy for ZIMs read from the web (milestone 3 step 7, SPEC §2.6; optional): a Cloudflare
// Worker that answers a page's range reads of Kiwix's files from the mirror nearest the visitor,
// with the CORS headers only Kiwix's own mirror sends. Measured from California (TODO, milestone 3
// step 7): a read takes 165-180 ms from Kiwix's mirror in France and 80 ms from one in Wisconsin,
// and the top 1M opened in 0.7 s instead of 2.4-4.3 s, searched in 3.3 s instead of 7.4 s.
//
// GET /zim/<folder>/<file>.zim with a `Range: bytes=<start>-<end>` header, as the page's HTTP
// source (public/js/core/zim/http-source.js) sends: the answer is a mirror's 206, streamed through.
// Only ranges, only Kiwix's files and only these mirrors: no Range, an open or too long range, or
// another path is refused, so it relays no whole files and goes nowhere else. The mirrors hold
// different subsets (rsync'd from Kiwix's, the same size and Last-Modified everywhere: the page's
// edition check holds whichever answers): one without the file (404), failing, too slow or
// ignoring the range is passed over for the next, and remembered per file for a while. The page
// uses this only when its site names it (`--zim-proxy`, tools/build-pages.mjs) and reads Kiwix's
// mirror directly when it fails.
//
// Only the pages of the sites in ALLOWED_ORIGINS (wrangler.toml) may use it: a browser names the
// page's origin in every cross-origin request, so another site's page cannot spend this one's
// daily requests (the free plan's 100,000: over them Cloudflare answers an error, and the page
// reads Kiwix's mirror directly). A request without an allowed Origin is refused (403); "*"
// allows any.
//
// Deploy: `npx wrangler deploy` in this folder (wrangler.toml), with a Cloudflare account.

/** The mirrors (Kiwix's MirrorBrain list, from a file's .meta4): where each one's /zim/ is. */
export const MIRRORS = {
  kiwix: 'https://mirror.download.kiwix.org/zim/', // France; the only one with CORS; holds everything
  nluug: 'https://ftp.nluug.nl/pub/kiwix/zim/', // the Netherlands
  driftlessWi: 'https://wi.mirror.driftle.ss/kiwix/zim/', // Wisconsin
  driftlessNy: 'https://ny.mirror.driftle.ss/kiwix/zim/', // New York
  wikimedia: 'https://dumps.wikimedia.org/kiwix/zim/', // Virginia; no Gutenberg
  yourOrg: 'https://ftpmirror.your.org/pub/kiwix/zim/', // Illinois; no Gutenberg
  mblibrary: 'https://mirror-sites-in.mblibrary.info/mirror-sites/download.kiwix.org/zim/', // India
};

const AMERICAS = ['driftlessWi', 'driftlessNy', 'wikimedia', 'yourOrg', 'kiwix', 'nluug'];
const EUROPE = ['kiwix', 'nluug', 'driftlessNy', 'wikimedia', 'driftlessWi', 'yourOrg'];
/** Which mirrors to try first, by the visitor's continent (Cloudflare's `request.cf.continent`). */
const BY_CONTINENT = {
  NA: AMERICAS, SA: AMERICAS, OC: AMERICAS, AN: AMERICAS,
  EU: EUROPE, AF: EUROPE,
  AS: ['mblibrary', 'kiwix', 'nluug', 'driftlessWi', 'driftlessNy', 'wikimedia'],
};

/** The longest range relayed: the page reads at most a cluster (4 MB) at once; index builds read more. */
export const MAX_RANGE_BYTES = 64 * 1024 * 1024;
/** How long a mirror may take to start answering before the next is tried. */
const MIRROR_TIMEOUT_MS = 8000;
/** How long a mirror that failed for a file is passed over for it. */
const SKIP_MS = 10 * 60 * 1000;
/** Mirrors that failed per file (`<mirror> <path>` → until when), kept while the Worker's isolate lives. */
const SKIPPED = new Map();
const SKIPPED_MAX = 4096;

const FILE_PATH = /^\/zim\/[A-Za-z0-9._-]+\/[A-Za-z0-9._%+-]+\.zim$/;
const RANGE = /^bytes=(\d+)-(\d+)$/;

const EXPOSE = 'Content-Range, Content-Length, Last-Modified, ETag, X-Mirror';
/** What is passed on from a mirror's answer. */
const KEEP = ['content-range', 'content-length', 'content-type', 'last-modified', 'etag', 'accept-ranges', 'cache-control'];

/** The mirrors in the order to try them for a continent. */
export function mirrorsFor(continent) {
  return BY_CONTINENT[continent] ?? EUROPE;
}

function skip(skipped, key, until) {
  if (skipped.size >= SKIPPED_MAX) skipped.clear();
  skipped.set(key, until);
}

function answer(status, message, headers = {}) {
  return new Response(message ? `${message}\n` : null, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

/**
 * The Access-Control-Allow-Origin for a request's Origin: '*' when any is allowed, the origin
 * itself when it is listed, else null.
 * @param {string|null} origin
 * @param {string} allowed origins separated by commas or spaces ("https://user.github.io"); a
 *   port of `*` matches any port ("http://localhost:*"); "*" alone matches any origin
 */
export function allowOrigin(origin, allowed) {
  const list = String(allowed ?? '').split(/[\s,]+/).filter(Boolean);
  if (list.includes('*')) return '*';
  if (!origin) return null;
  for (const entry of list) {
    if (entry === origin) return origin;
    const m = /^(https?:\/\/[^/:]+):\*$/.exec(entry);
    if (m && (origin === m[1] || (origin.startsWith(`${m[1]}:`) && /^\d+$/.test(origin.slice(m[1].length + 1))))) return origin;
  }
  return null;
}

/**
 * The proxy itself, for the Worker and tests.
 * @param {Request} request
 * @param {{ fetch?: typeof fetch, continent?: string, skipped?: Map<string, number>, now?: () => number,
 *   timeoutMs?: number, origins?: string }} [opts] fetch: the mirrors' (tests); continent: the
 *   visitor's; skipped: `<mirror> <path>` → until when it is passed over (kept between requests);
 *   origins: the pages allowed (allowOrigin; any by default, the Worker's from ALLOWED_ORIGINS)
 * @returns {Promise<Response>}
 */
export async function handle(request, {
  fetch: fetchImpl = (...a) => globalThis.fetch(...a), continent = request.cf?.continent, skipped = SKIPPED,
  now = Date.now, timeoutMs = MIRROR_TIMEOUT_MS, origins = '*',
} = {}) {
  const url = new URL(request.url);
  const origin = allowOrigin(request.headers.get('origin'), origins);
  if (!origin) return answer(403, 'this proxy serves the pages of its own sites only');
  const CORS = {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': EXPOSE,
    ...(origin === '*' ? {} : { vary: 'Origin' }),
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range', 'access-control-max-age': '86400' },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405, 'only GET and HEAD', { ...CORS, allow: 'GET, HEAD, OPTIONS' });
  if (!FILE_PATH.test(url.pathname)) return answer(404, 'only Kiwix\'s ZIM files: /zim/<folder>/<file>.zim', CORS);
  const range = request.headers.get('range');
  const m = RANGE.exec(range ?? '');
  if (request.method === 'GET') {
    if (!m) return answer(416, 'a Range header is needed: bytes=<start>-<end> (parts of the file, not all of it)', CORS);
    if (Number(m[2]) < Number(m[1]) || Number(m[2]) - Number(m[1]) + 1 > MAX_RANGE_BYTES) {
      return answer(416, `a range of 1 to ${MAX_RANGE_BYTES} bytes`, CORS);
    }
  }
  const path = url.pathname.slice('/zim/'.length);
  const t = now();
  const order = mirrorsFor(continent);
  // Those passed over for this file last, not left out: when all fail, each gets its try.
  const tries = [...order.filter((k) => !(skipped.get(`${k} ${path}`) > t)), ...order.filter((k) => skipped.get(`${k} ${path}`) > t)];
  let last = null;
  for (const key of tries) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(MIRRORS[key] + path, {
        method: request.method,
        headers: range ? { range } : {},
        signal: timeout.signal,
        redirect: 'follow',
      });
    } catch (err) {
      last = `${key}: ${err.message}`;
      skip(skipped, `${key} ${path}`, t + SKIP_MS);
      continue;
    } finally {
      clearTimeout(timer);
    }
    // A part for a GET, the file's headers for a HEAD: anything else (not there, failing, the
    // whole file when a range was asked) is the next mirror's to answer.
    const good = request.method === 'HEAD' ? res.status === 200 || res.status === 206 : res.status === 206;
    if (!good) {
      await res.body?.cancel().catch(() => {});
      last = `${key}: HTTP ${res.status}`;
      skip(skipped, `${key} ${path}`, t + SKIP_MS);
      continue;
    }
    skipped.delete(`${key} ${path}`);
    const headers = { ...CORS, 'x-mirror': new URL(MIRRORS[key]).hostname };
    for (const h of KEEP) {
      const v = res.headers.get(h);
      if (v != null) headers[h] = v;
    }
    return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers });
  }
  return answer(502, `no mirror answered (${last})`, CORS);
}

export default {
  fetch(request, env) {
    return handle(request, { origins: env?.ALLOWED_ORIGINS ?? '*' });
  },
};
