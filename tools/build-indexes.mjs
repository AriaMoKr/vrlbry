#!/usr/bin/env node
// Prebuilt indexes for the Wikipedias and Wikisources too big to index in the browser (milestone
// 3, step 6; optional): a visitor who opens one from the web (Kiwix's library, an address) finds
// its index under indexes/ on the site instead of a build that would read most of the file
// (12.7 GB of HTML for the top 1M). The local library looks there first (public/js/local/prebuilt.js),
// and Kiwix's library lists a big one as openable when indexes/list.json names its index
// (public/js/local/kiwix.js).
//
//   node tools/build-indexes.mjs [--out .indexes] [--zims <folder>] [--web] [--hours <n>] [--prune]
//                                [--publish <dir>] [--list tools/indexes.txt] [--only <base,…>]
//   node tools/build-indexes.mjs --ship <site> [--out .indexes] [--budget-mb <n>]
//
// The ZIMs are those of tools/indexes.txt, in their current editions as Kiwix's catalogue lists
// them. An index already in --out (named by the edition's UUID) is kept; a missing one is built
// from a copy in --zims (the same file name) or, with --web, read from Kiwix's mirror (slow and
// heavy on the mirror: tens of GB for the big ones, hence opt-in), the quickest first
// (buildOrder), whatever their order in the list. --hours stops starting builds after that long. --prune deletes indexes of editions no longer current. --publish copies the
// indexes into a site's indexes/ folder. --out and --publish get a list.json of what is there.
// --ship copies the indexes in --out into a built site, as many as fit in --budget-mb for the
// whole site (GitHub Pages: 1 GB per site), the smallest first (shipIndexes). An index of an older
// version that can be upgraded (core/index-versions.js WIKIPEDIA_UPGRADABLE) is upgraded instead
// of built; only current versions are listed and shipped, and --prune drops the older ones.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { indexNamesFor, isCurrentIndexName } from '../public/js/core/index-versions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPDS = 'https://opds.library.kiwix.org/catalog/v2/entries';
/** Kinds that need an index (the others are listed straight from the ZIM). */
const KINDS = ['wikipedia', 'wikisource'];

/** The ZIMs of an index list: one file name without its date per line ("wikipedia_en_top1m_maxi"); # comments. */
export function readList(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

/** The index file name of a catalogue entry (as core/wikipedia.js and core/wikisource.js name it). */
export async function indexNameOf(entry) {
  const { indexNameFor } = await import('../public/js/core/index-versions.js');
  return indexNameFor(entry.kind, entry.uuid);
}

/**
 * Upgrades an index file of an older version (v4) to the current one, beside it: seconds, where a
 * build reads most of the ZIM (half an hour for the full English Wikipedia from a local copy).
 */
export async function upgradeIndex(from, to) {
  await import('../server/platform-node.js');
  const { indexText, parseIndexV4 } = await import('../public/js/core/wikipedia.js');
  const uuid = /-([0-9a-f]{32})\.v\d+\.json$/.exec(path.basename(from))?.[1];
  const idx = parseIndexV4(fs.readFileSync(from, 'utf8'), uuid);
  if (!idx) throw new Error(`${path.basename(from)} is not an index that can be upgraded`);
  fs.writeFileSync(to, indexText(idx));
}

/** Bytes of every file under a folder. */
function dirBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

/**
 * Copies the prebuilt indexes in `from` into a built site's indexes/ (with its list.json), as many
 * as fit: the whole site stays within `budgetBytes` (GitHub Pages publishes at most 1 GB a site),
 * the smallest first, so a few big ones do not crowd out many small ones. One already there is
 * kept (the site's own: the demo set's).
 * @returns {{ shipped: string[], left: string[], siteBytes: number }}
 */
export function shipIndexes(from, site, { budgetBytes = Infinity, log = console.log } = {}) {
  const to = path.join(site, 'indexes');
  const files = (fs.existsSync(from) ? fs.readdirSync(from) : [])
    .filter((n) => isCurrentIndexName(n) && !fs.existsSync(path.join(to, n)))
    .map((n) => ({ name: n, size: fs.statSync(path.join(from, n)).size }))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  let siteBytes = dirBytes(site);
  const shipped = [];
  const left = [];
  for (const f of files) {
    if (siteBytes + f.size > budgetBytes) {
      left.push(f.name);
      continue;
    }
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(from, f.name), path.join(to, f.name));
    siteBytes += f.size;
    shipped.push(f.name);
  }
  if (fs.existsSync(to)) writeIndexList(to);
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
  log(`Shipped ${shipped.length} prebuilt indexes; the site is ${mb(siteBytes)}`
    + `${left.length ? `; ${left.length} left out to stay within ${mb(budgetBytes)}: ${left.join(', ')}` : ''}`);
  return { shipped, left, siteBytes };
}

/** Writes `dir`/list.json: the index files there in their current versions (Kiwix's library in the page reads it). */
export function writeIndexList(dir) {
  const indexes = fs.readdirSync(dir).filter(isCurrentIndexName).sort();
  fs.writeFileSync(path.join(dir, 'list.json'), `${JSON.stringify({ indexes }, null, 1)}\n`);
  return indexes;
}

/**
 * The current editions of the listed ZIMs, from Kiwix's catalogue: { base, entry } each, entry
 * null when the catalogue has none.
 * @param {string[]} bases file names without their date
 */
export async function currentEditions(bases, { fetch: fetchImpl = globalThis.fetch } = {}) {
  await import('../server/platform-node.js');
  const { parseEntries } = await import('../public/js/local/kiwix.js');
  const entries = [];
  for (const kind of KINDS) {
    const res = await fetchImpl(`${OPDS}?category=${kind}&count=-1`);
    if (!res.ok) throw new Error(`Kiwix's catalogue: HTTP ${res.status}`);
    entries.push(...parseEntries(await res.text()));
  }
  const fileOf = (e) => decodeURIComponent(e.url.split('/').pop());
  return bases.map((base) => ({
    base,
    entry: entries.find((e) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{4}-\\d{2}\\.zim$`).test(fileOf(e))) ?? null,
  }));
}

/**
 * The order the missing indexes are built in: the quickest first, so a run's hours build as many
 * as they can and a slow one cannot hold back the rest. A Wikipedia build reads every article's
 * HTML, so it takes about as long as its article count (the pictures are not read); one with no
 * count goes after those with one, by file size. A Wikisource build also follows each work's parts
 * across the file and has no checkpoint (from Kiwix's mirror its 3.9 GB nopic did not finish in
 * 5 hours, in two runs), so the Wikisources come last.
 * @template {{ entry: { kind: string, articles?: number|null, size?: number|null } }} T
 * @param {T[]} todo
 * @returns {T[]}
 */
export function buildOrder(todo) {
  const key = ({ entry }) => [entry.kind === 'wikisource' ? 1 : 0, entry.articles ? 0 : 1, entry.articles || 0, entry.size ?? Infinity];
  return [...todo].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

/**
 * Builds one index (as the server does on first open) from a file or a URL, into `out`.
 * @returns {Promise<{ seconds: number, bytes: number|null }>} bytes: read from the web, for a URL
 */
async function buildOne(source, name, out, { log, until = Infinity }) {
  const { ArchiveLibrary } = await import('../server/library.js');
  // The build's store: kept between runs, so that a Wikipedia build stopped at --hours (or by a
  // job's end) resumes its sizes pass from its checkpoint next time.
  const work = path.join(out, '.work');
  fs.mkdirSync(work, { recursive: true });
  const t0 = performance.now();
  // Over the network: 64 KB blocks and whole clusters read once (a build reads in order).
  const lib = await ArchiveLibrary.open(source, {
    cacheDir: work, log: () => {}, warn: log,
    archiveOptions: /^https?:/.test(source) ? { blockBytes: 64 * 1024, wholeCompressedBytes: 8 << 20, http: { maxInFlight: 8 } } : undefined,
  });
  try {
    let last = '';
    for (;;) {
      const ix = (await lib.info()).indexing;
      if (!ix) break;
      if (ix.stage === 'failed') throw new Error(ix.error);
      if (performance.now() > until) throw Object.assign(new Error('out of time (--hours): its progress is kept for the next run'), { outOfTime: true });
      const now = `${ix.stage} ${Math.floor((ix.progress ?? 0) * 10) * 10}%`;
      if (now !== last) log(`    ${now} (${Math.round((performance.now() - t0) / 1000)} s)`);
      last = now;
      await new Promise((r) => setTimeout(r, 250));
    }
    const built = path.join(work, name);
    if (!fs.existsSync(built)) throw new Error(`no index was built (${lib.kind} library?)`);
    fs.renameSync(built, path.join(out, name));
    return { seconds: (performance.now() - t0) / 1000, bytes: lib.archive._source?.stats?.bytes ?? null };
  } finally {
    await lib.close();
  }
}

/**
 * Builds the missing indexes of the listed ZIMs' current editions into `out` (see the head of this
 * file for the options), and writes list.json there (and in `publish`).
 * @returns {Promise<{ kept: string[], built: string[], missing: string[], failed: string[], unlisted: string[] }>}
 */
export async function buildListed({ bases, out, zims = null, web = false, hours = null, prune = false, publish = null, partial = false,
  fetch: fetchImpl = globalThis.fetch, log = (m) => console.log(m) }) {
  fs.mkdirSync(out, { recursive: true });
  const until = hours ? performance.now() + Number(hours) * 3600e3 : Infinity;
  const editions = await currentEditions(bases, { fetch: fetchImpl });
  const current = new Set();
  const summary = { kept: [], upgraded: [], built: [], missing: [], failed: [], unlisted: [] };
  const todo = [];
  for (const { base, entry } of editions) {
    if (!entry) {
      log(`${base}: not in Kiwix's catalogue`);
      summary.unlisted.push(base);
      continue;
    }
    const name = await indexNameOf(entry);
    current.add(name);
    const file = decodeURIComponent(entry.url.split('/').pop());
    if (fs.existsSync(path.join(out, name))) {
      summary.kept.push(file);
      continue;
    }
    // One of an older version (the release's, or an earlier run's): upgraded in seconds.
    const older = indexNamesFor(entry.kind, entry.uuid).slice(1).find((n) => fs.existsSync(path.join(out, n)));
    if (older) {
      try {
        await upgradeIndex(path.join(out, older), path.join(out, name));
        log(`${file}: ${older} upgraded to ${name} (${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB)`);
        summary.upgraded.push(file);
        continue;
      } catch (err) {
        log(`${file}: ${err.message}; building it instead`);
      }
    }
    const local = zims && path.join(zims, file);
    const source = local && fs.existsSync(local) ? local : web ? entry.url : null;
    if (!source) {
      log(`${file}: no index yet (no copy in --zims${web ? '' : '; --web reads it from the mirror'})`);
      summary.missing.push(file);
      continue;
    }
    todo.push({ file, name, entry, source, local });
  }
  const order = buildOrder(todo);
  if (order.length > 1) log(`to build, the quickest first: ${order.map((t) => t.file).join(', ')}`);
  for (const { file, name, entry, source, local } of order) {
    if (performance.now() > until) {
      log(`${file}: out of time (--hours)`);
      summary.missing.push(file);
      continue;
    }
    log(`${file}: building its index from ${source === local ? 'the copy here' : "Kiwix's mirror"} (${((entry.size ?? 0) / 1e9).toFixed(1)} GB${entry.articles ? `, ${entry.articles.toLocaleString('en')} articles` : ''})…`);
    try {
      const r = await buildOne(source, name, out, { log, until });
      const size = fs.statSync(path.join(out, name)).size;
      log(`  ${name}: ${(size / 1048576).toFixed(1)} MB in ${Math.round(r.seconds)} s${r.bytes != null ? `, ${(r.bytes / 1e9).toFixed(2)} GB read` : ''}`);
      summary.built.push(file);
    } catch (err) {
      log(`  ${err.outOfTime ? '' : 'failed: '}${err.message}`);
      (err.outOfTime ? summary.missing : summary.failed).push(file);
    }
  }
  // Only with the whole list: a partial one (--only) does not know every current edition.
  if (prune && !partial) {
    for (const n of fs.readdirSync(out)) {
      if (/^(wikipedia|wikisource)-[0-9a-f]{32}\.v\d+\.json$/.test(n) && !current.has(n)) {
        fs.rmSync(path.join(out, n));
        log(`pruned ${n} (not a current edition of the list)`);
      }
    }
  }
  const listed = writeIndexList(out);
  if (publish) {
    fs.mkdirSync(publish, { recursive: true });
    for (const n of listed) fs.copyFileSync(path.join(out, n), path.join(publish, n));
    log(`published ${listed.length} indexes to ${publish} (${writeIndexList(publish).length} there with any before)`);
  }
  log(`kept ${summary.kept.length}, upgraded ${summary.upgraded.length}, built ${summary.built.length}, missing ${summary.missing.length}, failed ${summary.failed.length}, not in the catalogue ${summary.unlisted.length}`);
  return summary;
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      list: { type: 'string', default: path.join(HERE, 'indexes.txt') },
      out: { type: 'string', default: '.indexes' },
      zims: { type: 'string' },
      web: { type: 'boolean', default: false },
      hours: { type: 'string' },
      only: { type: 'string' },
      prune: { type: 'boolean', default: false },
      publish: { type: 'string' },
      ship: { type: 'string' },
      'budget-mb': { type: 'string' },
    },
  });
  if (opts.ship) {
    const budget = opts['budget-mb'] ? Number(opts['budget-mb']) * 1048576 : Infinity;
    shipIndexes(path.resolve(opts.out), path.resolve(opts.ship), { budgetBytes: budget });
    return;
  }
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;
  const summary = await buildListed({
    bases: readList(opts.list).filter((b) => !only || only.has(b)), partial: !!only,
    out: path.resolve(opts.out), zims: opts.zims ? path.resolve(opts.zims) : null, web: opts.web, hours: opts.hours,
    prune: opts.prune, publish: opts.publish ? path.resolve(opts.publish) : null,
  });
  if (summary.failed.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
