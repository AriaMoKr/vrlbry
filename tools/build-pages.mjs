#!/usr/bin/env node
// Builds the static site for GitHub Pages into dist/ (or --out <dir>): the client without the
// Node server. The page's API calls get static answers, and /vendor/ holds only the three.js and
// IWER files the client imports (followed from its imports), instead of the server mapping
// node_modules.
//
//   node tools/build-pages.mjs [--out dist] [--zims <folder>] [--indexes <folder>]
//
// --indexes builds the indexes of that folder's Wikipedia and Wikisource ZIMs into indexes/, for
// visitors who open those files in the browser (buildIndexes).
//
// Without --zims the site has no libraries. With it, the ZIMs in that folder are pre-rendered: the
// real server runs in this process, and every answer the client can ask for is saved as a file
// (api/libraries, then under api/library/<id>/: books.json, per book index.json and
// chunks/<n>.json, and for a Wikipedia titles.json, for searching articles in the browser), with
// every image they refer to under zim/. In static mode the client asks for those file names
// (api.js). Server URLs (/zim/…, /api/libraries/…) become the static site's (staticPath).
//
// Everything in the client is addressed relative to the page or to js/, so the site works under a
// path (https://<user>.github.io/vrlbry/) as well as at the root of the Node server.
//
// GitHub Pages lets browsers reuse every file for 10 minutes (max-age=600), and a reload only
// checks the page itself. So every module URL in the built site carries a version tag (?v=<hash>
// of the module group's files: the app, three, IWER), from index.html's script, stylesheet and
// import map through every relative import: a reload after a deploy loads the new modules, never
// a mix of old and new ones (versionUrls).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fileName } from '../public/js/util/file-names.js';
import { DEFAULT_VENDOR_DIRS, rewriteVendorImports, vendorFileOf, vendorUrlOf } from '../server/vendor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const THREE = DEFAULT_VENDOR_DIRS.three;
const IWER = DEFAULT_VENDOR_DIRS.iwer;
/** Pages of public/ that need the Node server's API (book lists, chunks): left out. */
const SERVER_ONLY = ['dev', 'reader-test.html'];

/** Copies a file, creating its directory. */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Copies a directory tree, skipping top-level entries named in `skip`. */
function copyTree(from, to, skip = []) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else copy(src, dst);
  }
}

/** The module specifiers a JS file imports (static, dynamic and re-exports), comments removed. */
export function importsOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = new Set();
  for (const m of code.matchAll(/(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs];
}

/** Resolves a specifier the way the page's import map does ('three', 'three/addons/…'), or relatively. */
function resolve(spec, fromFile) {
  if (spec === 'three') return path.join(THREE, 'build', 'three.module.js');
  if (spec.startsWith('three/addons/')) return path.join(THREE, 'examples', 'jsm', spec.slice('three/addons/'.length));
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  return null; // a URL or something else: not ours to copy
}

/** Every file reachable through imports from `entries` (absolute paths). */
function closure(entries, read = (file) => fs.readFileSync(file, 'utf8')) {
  const seen = new Set();
  const todo = [...entries];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`missing module: ${path.relative(ROOT, file)}`);
    seen.add(file);
    if (!/\.m?js$/.test(file)) continue;
    for (const spec of importsOf(read(file))) {
      const dep = resolve(spec, file);
      if (dep) todo.push(dep);
    }
  }
  return [...seen];
}

/**
 * Where a vendor package's file is in the site, under vendor/<name>/: [name, path inside] (its
 * URL, which may differ from its file name: vendorUrlOf), or null when `file` is in no package of
 * DEFAULT_VENDOR_DIRS but three's and IWER's (copied apart).
 */
function vendorPathOf(file) {
  for (const [name, dir] of Object.entries(DEFAULT_VENDOR_DIRS)) {
    if (name === 'three' || name === 'iwer') continue;
    const rel = path.relative(dir, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const url = vendorUrlOf(`${name}/${rel.split(path.sep).join('/')}`);
      return [name, url.slice(name.length + 1)];
    }
  }
  return null;
}

/** A vendor file's source with its bare imports made relative (server/vendor.js). */
function vendorSource(file) {
  const source = fs.readFileSync(file, 'utf8');
  const at = vendorPathOf(file);
  return at ? rewriteVendorImports(`${at[0]}/${at[1]}`, source) : source;
}

/** Relative specifiers of imports, re-exports and dynamic imports: (head)(quote)(specifier). */
const IMPORT_SPEC = /(\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"?]+)\2/g;
/** A module or worker addressed from the module itself: new URL('./x.js', import.meta.url). */
const MODULE_URL = /\bnew URL\(\s*(['"])(\.\.?\/[^'"?]+\.js)\1(\s*,\s*import\.meta\.url\s*\))/g;

/**
 * Adds ?v=<tag> to every relative module URL of a JS source: imports, re-exports, dynamic
 * imports and new URL('….js', import.meta.url). tagOf(specifier) gives the tag, or null to leave
 * the URL as it is. Bare specifiers ('three') are the import map's business.
 */
export function tagModuleUrls(source, tagOf) {
  const tagged = (spec) => {
    const tag = tagOf(spec);
    return tag ? `${spec}?v=${tag}` : spec;
  };
  return source
    .replace(IMPORT_SPEC, (_, head, q, spec) => `${head}${q}${tagged(spec)}${q}`)
    .replace(MODULE_URL, (_, q, spec, tail) => `new URL(${q}${tagged(spec)}${q}${tail}`);
}

/** Every file under dir (absolute paths), or none when it does not exist. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** A short hash of files (their paths relative to base, and contents) and of `extra` strings. */
function hashFiles(files, base, extra = []) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(path.relative(base, f).split(path.sep).join('/')).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  for (const e of extra) h.update(e).update('\0');
  return h.digest('hex').slice(0, 10);
}

/**
 * Tags every module URL of the built site in `out` with its group's version (see the top): the
 * app (js/ and css/), three and IWER, each hashed from its files before tagging. The app's tag also
 * covers the vendor tags, since its modules name them. A file gets the same URL from every module
 * that imports it, so nothing is loaded twice.
 * @returns {{ app: string, three: string, iwer: string }}
 */
function versionUrls(out) {
  const three = filesUnder(path.join(out, 'vendor', 'three'));
  const iwer = filesUnder(path.join(out, 'vendor', 'iwer'));
  const lib = filesUnder(path.join(out, 'vendor')).filter((f) => !three.includes(f) && !iwer.includes(f));
  const app = [...filesUnder(path.join(out, 'js')), ...filesUnder(path.join(out, 'css'))];
  const tags = { three: hashFiles(three, out), iwer: hashFiles(iwer, out), lib: hashFiles(lib, out) };
  tags.app = hashFiles(app, out, [tags.three, tags.iwer, tags.lib]);
  const tagFor = (file) => {
    const rel = path.relative(out, file).split(path.sep).join('/');
    if (rel.startsWith('vendor/three/')) return tags.three;
    if (rel.startsWith('vendor/iwer/')) return tags.iwer;
    if (rel.startsWith('vendor/')) return tags.lib;
    return tags.app;
  };
  for (const file of [...app, ...three, ...iwer, ...lib].filter((f) => /\.m?js$/.test(f))) {
    const source = fs.readFileSync(file, 'utf8');
    const tagged = tagModuleUrls(source, (spec) => tagFor(path.resolve(path.dirname(file), spec)));
    if (tagged !== source) fs.writeFileSync(file, tagged);
  }

  // index.html: the entry module, the stylesheet, and the import map. A prefix entry
  // ("three/addons/") cannot carry a query, so each add-on the app imports gets its own entry.
  const bare = new Set();
  for (const file of app.filter((f) => f.endsWith('.js'))) {
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) if (!/^(\.|\/|[a-z]+:)/.test(spec)) bare.add(spec);
  }
  const indexFile = path.join(out, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8')
    .replace(/(\b(?:src|href)=")((?:\.\/)?(?:js|css)\/[^"?]+)"/g, (_, attr, url) => `${attr}${url}?v=${tags.app}"`)
    .replace(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (_, open, json, close) => {
      const { imports } = JSON.parse(json);
      const mapped = {};
      for (const spec of bare) {
        const key = Object.keys(imports).filter((k) => k === spec || (k.endsWith('/') && spec.startsWith(k)))
          .sort((a, b) => b.length - a.length)[0];
        if (!key) throw new Error(`the import map has no entry for '${spec}'`);
        const url = imports[key] + spec.slice(key.length);
        mapped[spec] = `${url}?v=${tagFor(path.resolve(out, url))}`;
      }
      return open + JSON.stringify({ imports: { ...imports, ...mapped } }) + close;
    });
  fs.writeFileSync(indexFile, html);
  return tags;
}

/** When the site last changed: the last commit's time, else now. */
function changedAt() {
  try {
    return new Date(execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Runs fn over items, at most `limit` at a time. */
async function each(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Where a server URL lives in the static site, relative to its root: /zim/… → zim/…, and
 * /api/libraries/<id>/… → api/library/<id>/… (api/libraries itself is a file, the catalogue).
 */
export function staticPath(url) {
  return url.replace(/^\/api\/libraries\//, 'api/library/').replace(/^\//, '');
}

const decode = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // not percent-encoded after all
  }
};

/** Longest file name kept whole, in UTF-8 bytes (Linux and macOS allow 255, Windows 255 UTF-16 units). */
const MAX_NAME_BYTES = 200;

/**
 * fileName, shortened when too long for a file system (escaping makes names longer: Wikipedia
 * image names reach 240 bytes): the name's start, `~`, a hash of the whole name, its extension.
 */
export function storableName(name) {
  const file = fileName(name);
  if (Buffer.byteLength(file) <= MAX_NAME_BYTES) return file;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(file)?.[0] ?? '';
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
  const budget = MAX_NAME_BYTES - ext.length - hash.length - 1;
  let stem = '';
  let bytes = 0;
  for (const ch of file.slice(0, file.length - ext.length)) { // whole code points
    bytes += Buffer.byteLength(ch);
    if (bytes > budget) break;
    stem += ch;
  }
  return `${stem.replace(/%[0-9A-F]?$/, '')}~${hash}${ext}`; // never ending inside an escape
}

/**
 * The file a server URL is saved as, relative to the site's root: staticPath's segments decoded
 * (Pages decodes a request's path to find the file), as names every system can store.
 */
export function staticFile(url) {
  return staticPath(url).split('/').map((s) => storableName(decode(s))).join('/');
}

/**
 * A server URL as the static site's page asks for it: relative (staticPath), naming staticFile's
 * file. A segment whose file name differs is encoded once more, since Pages decodes it.
 */
export function staticUrl(url) {
  return staticPath(url).split('/').map((s) => {
    const name = decode(s);
    const file = storableName(name);
    return file === name ? s : encodeURIComponent(file);
  }).join('/');
}

/** Server URLs (whole JSON strings starting /zim/ or /api/libraries/) made the static site's (staticUrl). */
export function relativeUrls(json) {
  return json.replace(/"(\/(?:zim|api\/libraries)\/[^"\\]*)"/g, (_, url) => `"${staticUrl(url)}"`);
}

/** The image URLs (as the server writes them) that the blocks of a chunk refer to. */
export function blockImages(blocks, into = new Set()) {
  const run = (r) => {
    if (r[2]?.src) into.add(r[2].src);
  };
  for (const b of blocks) {
    if (b.t === 'img' && b.src) into.add(b.src);
    for (const r of b.r || []) run(r);
    for (const cell of b.c || []) for (const r of cell) run(r);
  }
  return into;
}

/**
 * Pre-renders the ZIMs of `dir` into `out`: runs the server in this process and saves its answers
 * as the static files api.js asks for in static mode, and every image they refer to.
 * @returns {Promise<{ libraries: number, books: number, chunks: number, images: number }>}
 */
export async function prerender(dir, out, { log = console.log } = {}) {
  const { Library } = await import('../server/library.js');
  const { createApp } = await import('../server/http.js');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-cache-'));
  const library = await Library.scan(dir, { log: () => {}, warn: log, cacheDir });
  const server = http.createServer(createApp(library, { log }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const enc = encodeURIComponent;
  // Uncompressed: gzipping 70,000 answers only to unzip them again took a minute (Medicine mini).
  const plain = { headers: { 'accept-encoding': 'identity' } };
  const get = async (p) => {
    const res = await fetch(base + p, plain);
    if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
    return res;
  };
  const made = new Set(); // folders already created: tens of thousands of files share a few
  const write = (file, data) => {
    const to = path.join(out, ...file.split('/'));
    const dir = path.dirname(to);
    if (!made.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    fs.writeFileSync(to, data);
  };
  const stats = { libraries: 0, books: 0, chunks: 0, images: 0 };
  try {
    // Indexes (Wikipedia volumes, Wikisource works) are built in the background on first open.
    for (const lib of library.list()) {
      for (let i = 0; (await lib.info()).indexing; i++) {
        if (i % 50 === 0) log(`  waiting for ${lib.id} to be indexed…`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const images = new Set();
    const catalog = await (await get('/api/libraries')).json();
    write('api/libraries', relativeUrls(JSON.stringify({ ...catalog, static: true })));
    for (const info of catalog.libraries) {
      stats.libraries++;
      if (info.illustration) images.add(info.illustration);
      const lib = `api/library/${fileName(info.id)}`;
      const booksText = await (await get(`/api/libraries/${enc(info.id)}/books`)).text();
      write(`${lib}/books.json`, relativeUrls(booksText));
      const { books } = JSON.parse(booksText);
      for (const b of books) for (const u of [b.cover, b.emblem]) if (u) images.add(u);
      const saveChunk = async (bookId, n) => {
        const text = await (await get(`/api/libraries/${enc(info.id)}/books/${enc(bookId)}/chunks/${n}`)).text();
        write(`${lib}/books/${fileName(bookId)}/chunks/${n}.json`, relativeUrls(text));
        blockImages(JSON.parse(text).blocks, images);
        stats.chunks++;
      };
      // A Wikipedia's articles are converted in the order the ZIM stores them, across volumes, so
      // that each cluster is decompressed once (articlesInStorageOrder); other books one by one.
      const storageOrder = await library.get(info.id).articlesInStorageOrder?.();
      await each(books.filter((b) => b.readable), 4, async (b) => {
        const metaText = await (await get(`/api/libraries/${enc(info.id)}/books/${enc(b.id)}`)).text();
        write(`${lib}/books/${fileName(b.id)}/index.json`, relativeUrls(metaText));
        const meta = JSON.parse(metaText);
        if (meta.cover) images.add(meta.cover);
        if (!storageOrder) await each(meta.chunks.map((_, n) => n), 8, (n) => saveChunk(b.id, n));
        stats.books++;
      });
      if (storageOrder) await each(storageOrder, 8, ([bookId, n]) => saveChunk(bookId, n));
      const titles = await library.get(info.id).articleTitles?.();
      if (titles) write(`${lib}/titles.json`, JSON.stringify(titles));
      log(`  ${info.id}: ${books.length} ${info.kind === 'wikipedia' ? 'volumes' : 'books'}`);
    }
    // The images, at their decoded paths (Pages decodes a request's path to find the file), with
    // names every system can store (staticFile, as the JSON names them: staticUrl).
    await each([...images], 16, async (src) => {
      if (!src.startsWith('/')) return; // data: URIs and the like stay inline
      const res = await fetch(base + src, plain);
      if (!res.ok) return log(`  missing image ${src} (HTTP ${res.status})`);
      write(staticFile(src), Buffer.from(await res.arrayBuffer()));
      stats.images++;
    });
    return stats;
  } finally {
    server.close();
    await library.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Builds the indexes of the Wikipedia and Wikisource ZIMs of `dir` (as the server does on first
 * open) and writes them to `out`/indexes/<name> (the name the core keeps them under, with the
 * ZIM's UUID), where the local library looks before building one (public/js/local/prebuilt.js):
 * a visitor who opens such a file skips the build, minutes on a headset for a big Wikipedia.
 * @returns {Promise<{ libraries: number, indexes: string[] }>}
 */
export async function buildIndexes(dir, out, { log = console.log } = {}) {
  const { Library } = await import('../server/library.js');
  const { indexName: wikipediaIndexName } = await import('../public/js/core/wikipedia.js');
  const { indexName: wikisourceIndexName } = await import('../public/js/core/wikisource.js');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-indexes-'));
  const library = await Library.scan(dir, { log: () => {}, warn: log, cacheDir });
  const indexes = [];
  try {
    for (const lib of library.list()) {
      const name = lib.kind === 'wikipedia' ? wikipediaIndexName(lib.archive) : lib.kind === 'wikisource' ? wikisourceIndexName(lib.archive) : null;
      if (!name) continue;
      for (let i = 0; (await lib.info()).indexing; i++) {
        if (i % 50 === 0) log(`  indexing ${lib.id}…`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const from = path.join(cacheDir, name);
      if (!fs.existsSync(from)) {
        log(`  ${lib.id}: no index was built`);
        continue;
      }
      fs.mkdirSync(path.join(out, 'indexes'), { recursive: true });
      fs.copyFileSync(from, path.join(out, 'indexes', name));
      indexes.push(name);
      log(`  ${lib.id}: indexes/${name} (${(fs.statSync(from).size / 1048576).toFixed(1)} MB)`);
    }
    // The list of what is there (with any index written before): Kiwix's library in the page
    // (local/kiwix.js) offers a big Wikipedia only when its index is here.
    if (indexes.length) {
      const all = fs.readdirSync(path.join(out, 'indexes')).filter((n) => n !== 'list.json').sort();
      fs.writeFileSync(path.join(out, 'indexes', 'list.json'), `${JSON.stringify({ indexes: all }, null, 1)}\n`);
    }
    return { libraries: library.list().length, indexes };
  } finally {
    await library.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function main() {
  const { values: opts } = parseArgs({ options: { out: { type: 'string', default: 'dist' }, zims: { type: 'string' }, indexes: { type: 'string' } } });
  const OUT = path.resolve(ROOT, opts.out);
  fs.rmSync(OUT, { recursive: true, force: true });
  copyTree(PUBLIC, OUT, SERVER_ONLY);

  // Vendor: what the client's own modules import from three, and IWER for ?xr=emulate.
  const clientModules = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) clientModules.push(p);
    }
  };
  walk(path.join(OUT, 'js'));
  const entries = new Set();
  for (const file of clientModules) {
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (spec === 'three' || spec.startsWith('three/addons/')) entries.add(resolve(spec, file));
    }
  }
  // The local library's worker has no import map: it names its vendor modules by relative URL
  // (../../vendor/<name>/…), and their bare imports are rewritten as the server does.
  const libEntries = new Set();
  const vendorOut = path.join(OUT, 'vendor');
  for (const file of clientModules) {
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const rel = path.relative(vendorOut, path.resolve(path.dirname(file), spec));
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const [name] = rel.split(path.sep);
      if (name === 'three' || name === 'iwer' || !DEFAULT_VENDOR_DIRS[name]) {
        throw new Error(`${path.relative(OUT, file)}: no vendor package for ${spec}`);
      }
      const inPackage = vendorFileOf(rel.split(path.sep).join('/')).split('/').slice(1);
      libEntries.add(path.join(DEFAULT_VENDOR_DIRS[name], ...inPackage));
    }
  }
  const vendor = [
    ...closure([...entries]).map((file) => [file, path.join(OUT, 'vendor', 'three', path.relative(THREE, file))]),
    ...closure([path.join(IWER, 'iwer.module.js')]).map((file) => [file, path.join(OUT, 'vendor', 'iwer', path.relative(IWER, file))]),
  ];
  for (const [from, to] of vendor) copy(from, to);
  const libs = closure([...libEntries], vendorSource);
  for (const from of libs) {
    const [name, rel] = vendorPathOf(from);
    const to = path.join(vendorOut, name, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (/\.m?js$/.test(from)) fs.writeFileSync(to, vendorSource(from));
    else fs.copyFileSync(from, to);
  }
  vendor.push(...libs);
  const tags = versionUrls(OUT);

  // The API's static answers: the libraries of --zims (or none), and when the site last changed.
  const api = path.join(OUT, 'api');
  fs.mkdirSync(api, { recursive: true });
  if (opts.zims) {
    console.log(`Pre-rendering the ZIMs in ${opts.zims}…`);
    const st = await prerender(path.resolve(opts.zims), OUT);
    console.log(`  ${st.libraries} libraries, ${st.books} books, ${st.chunks} chunks, ${st.images} images`);
  } else {
    fs.writeFileSync(path.join(api, 'libraries'), JSON.stringify({ generation: 0, libraries: [], static: true }));
  }
  if (opts.indexes) {
    console.log(`Building the indexes of the ZIMs in ${opts.indexes}…`);
    const st = await buildIndexes(path.resolve(opts.indexes), OUT);
    console.log(`  ${st.indexes.length} indexes of ${st.libraries} libraries`);
  }
  fs.writeFileSync(path.join(api, 'version'), JSON.stringify({ changed: changedAt(), file: null, static: true }));
  // Served as is (no Jekyll processing).
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  let files = 0;
  let bytes = 0;
  const count = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) count(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  count(OUT);
  console.log(`Built ${path.relative(ROOT, OUT) || OUT}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB `
    + `(${vendor.length} vendor modules; versions: app ${tags.app}, three ${tags.three}, IWER ${tags.iwer}, worker libraries ${tags.lib}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`build-pages: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
