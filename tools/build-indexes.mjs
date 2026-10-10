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
//
// The ZIMs are those of tools/indexes.txt, in their current editions as Kiwix's catalogue lists
// them. An index already in --out (named by the edition's UUID) is kept; a missing one is built
// from a copy in --zims (the same file name) or, with --web, read from Kiwix's mirror (slow and
// heavy on the mirror: tens of GB for the big ones, hence opt-in). --hours stops starting builds
// after that long. --prune deletes indexes of editions no longer current. --publish copies the
// indexes into a site's indexes/ folder. --out and --publish get a list.json of what is there.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

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

/** Writes `dir`/list.json: the index files there (Kiwix's library in the page reads it). */
export function writeIndexList(dir) {
  const indexes = fs.readdirSync(dir).filter((n) => /^(wikipedia|wikisource)-[0-9a-f]{32}\.v\d+\.json$/.test(n)).sort();
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
  const summary = { kept: [], built: [], missing: [], failed: [], unlisted: [] };
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
    const local = zims && path.join(zims, file);
    const source = local && fs.existsSync(local) ? local : web ? entry.url : null;
    if (!source) {
      log(`${file}: no index yet (no copy in --zims${web ? '' : '; --web reads it from the mirror'})`);
      summary.missing.push(file);
      continue;
    }
    if (performance.now() > until) {
      log(`${file}: out of time (--hours)`);
      summary.missing.push(file);
      continue;
    }
    log(`${file}: building its index from ${source === local ? 'the copy here' : "Kiwix's mirror"} (${((entry.size ?? 0) / 1e9).toFixed(1)} GB)…`);
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
  log(`kept ${summary.kept.length}, built ${summary.built.length}, missing ${summary.missing.length}, failed ${summary.failed.length}, not in the catalogue ${summary.unlisted.length}`);
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
    },
  });
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
