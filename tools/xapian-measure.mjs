#!/usr/bin/env node
// Measures searches of a ZIM's Xapian index with public/js/core/zim/xapian.js (docs/SEARCH.md,
// option 4), from a local file or over HTTP as the browser reads Kiwix's mirror, and compares the
// results with kiwix-serve's for the same file.
//   node tools/xapian-measure.mjs <file.zim | https://…/file.zim> [--title] [--kiwix <url> --book <name>]
//     [--limit 10] [--rerank 50] [--in-flight 6] [--h2] [--gap 4] [--run-kb 256] -- <query> [<query>…]
// --in-flight: HTTP requests at once (HttpSource's maxInFlight; 6 is HTTP/1.1's limit in a browser,
// over HTTP/2, which Kiwix's mirror and the proxy speak, a browser runs many more). --h2: send them
// over one HTTP/2 connection, as a browser does (Node's fetch speaks HTTP/1.1).
// The English stemmer is porter2 (npm install --no-save porter2), Snowball's English as Xapian's.
import http2 from 'node:http2';
import '../server/platform-node.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import { XapianDb } from '../public/js/core/zim/xapian.js';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const opts = sep < 0 ? args : args.slice(0, sep);
const queries = sep < 0 ? [] : args.slice(sep + 1);
const flag = (name, fallback = null) => {
  const i = opts.indexOf(name);
  return i < 0 ? fallback : opts[i + 1];
};
const source = opts.find((a, i) => !a.startsWith('--') && !opts[i - 1]?.startsWith('--') || i === 0 && !a.startsWith('--'));
const xpath = opts.includes('--title') ? 'X/title/xapian' : 'X/fulltext/xapian';
const limit = Number(flag('--limit', '10'));
const kiwix = flag('--kiwix');
const book = flag('--book');
const rerank = Number(flag('--rerank', '50'));
const inFlight = Number(flag('--in-flight', '6'));
const runGap = flag('--gap') === null ? undefined : Number(flag('--gap'));
const runBytes = flag('--run-kb') === null ? undefined : Number(flag('--run-kb')) * 1024;

/** A fetch over HTTP/2 (one connection per origin, requests multiplexed), enough for HttpSource. */
function h2fetch() {
  const sessions = new Map();
  return (url, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    let session = sessions.get(u.origin);
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(u.origin);
      session.on('error', () => sessions.delete(u.origin));
      session.unref();
      sessions.set(u.origin, session);
    }
    const headers = { ':method': init.method ?? 'GET', ':path': u.pathname + u.search };
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const req = session.request(headers);
    init.signal?.addEventListener('abort', () => req.close(http2.constants.NGHTTP2_CANCEL));
    const chunks = [];
    let head = null;
    req.on('response', (h) => { head = h; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = new Headers();
      for (const [k, v] of Object.entries(head ?? {})) if (!k.startsWith(':')) out.set(k, String(v));
      const status = head?.[':status'] ?? 502;
      resolve(new Response(init.method === 'HEAD' || status === 204 ? null : Buffer.concat(chunks), { status, headers: out }));
    });
    req.on('error', reject);
    req.end();
  });
}
const useH2 = opts.includes('--h2');

const { stem } = await import('porter2').catch(() => ({ stem: null }));
if (!stem) console.warn('porter2 is not installed (npm install --no-save porter2): full-text queries go unstemmed');

const remote = /^https?:/.test(source);
// As the local library reads a ZIM from a web address (local-handler.js URL_ARCHIVE).
const URL_ARCHIVE = { blockBytes: 8 * 1024, blockCacheBytes: 8 * 1024 * 1024, wholeClusterBytes: 0, wholeCompressedBytes: 4 * 1024 * 1024 };
let t0 = performance.now();
const archive = await ZimArchive.open(source, remote ? { ...URL_ARCHIVE, http: { maxInFlight: inFlight, ...(useH2 ? { fetch: h2fetch() } : {}) } } : {});
const tOpen = performance.now() - t0;
let db = null;
const requests = () => archive._source?.stats?.reads ?? db?.requests ?? 0;
const r0 = requests();
t0 = performance.now();
db = await XapianDb.inArchive(archive, xpath, { stem, runGap, runBytes });
if (!db) throw new Error(`${source} has no ${xpath} (or it is compressed)`);
console.log(`${source}: archive opened in ${tOpen.toFixed(0)} ms; ${xpath} (${(db.size / 1e6).toFixed(0)} MB, ${db.docCount} documents, kind ${db.kind}, language ${db.language}) in ${(performance.now() - t0).toFixed(0)} ms, ${db.reads} blocks, ${requests() - r0} requests`);

for (const q of queries) {
  const reads0 = db.reads;
  const req0 = requests();
  t0 = performance.now();
  const found = await db.search(q, { limit, rerank });
  const ms = performance.now() - t0;
  console.log(`\n"${q}": terms ${found.terms.map((t) => `${t.term} (${t.freq})`).join(', ')}; ${found.total} documents${found.truncated ? ' (candidates capped)' : ''}; ${ms.toFixed(0)} ms, ${db.reads - reads0} blocks, ${requests() - req0} requests`);
  let theirs = null;
  if (kiwix && book) {
    const url = `${kiwix.replace(/\/?$/, '/')}search?books.name=${encodeURIComponent(book)}&pattern=${encodeURIComponent(q)}&format=xml&pageLength=${limit}`;
    const xml = await (await fetch(url)).text();
    theirs = [...xml.matchAll(/<link>\/content\/[^/]+\/([^<]+)<\/link>/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
  }
  found.results.forEach((r, i) => {
    const path = (r.path ?? '?').replace(/^C\//, '');
    const rank = theirs ? theirs.indexOf(path) : -1;
    console.log(`  ${String(i + 1).padStart(2)}. ${r.score.toFixed(2).padStart(6)}  ${path}${theirs ? (rank >= 0 ? `  [kiwix #${rank + 1}]` : '  [not in kiwix\'s top]') : ''}`);
  });
  if (theirs) {
    const ours = new Set(found.results.map((r) => (r.path ?? '').replace(/^C\//, '')));
    console.log(`  kiwix-serve's top ${theirs.length}: ${theirs.filter((p) => ours.has(p)).length} also here; theirs: ${theirs.slice(0, 5).join(' | ')}`);
  }
}
await archive.close?.();
