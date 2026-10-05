#!/usr/bin/env node
// Builds the static site for GitHub Pages into dist/ (or --out <dir>): the client without the
// Node server. The page's API calls get static answers, and /vendor/ holds only the three.js and
// IWER files the client imports (followed from its imports), instead of the server mapping
// node_modules.
//
//   node tools/build-pages.mjs [--out dist] [--zims <folder>]
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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const IWER = path.join(ROOT, 'node_modules', 'iwer', 'build');
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
function closure(entries) {
  const seen = new Set();
  const todo = [...entries];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`missing module: ${path.relative(ROOT, file)}`);
    seen.add(file);
    if (!file.endsWith('.js')) continue;
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      const dep = resolve(spec, file);
      if (dep) todo.push(dep);
    }
  }
  return [...seen];
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

/** Server URLs in a JSON text, made the static site's (staticPath). */
export function relativeUrls(json) {
  return json.replaceAll('"/zim/', '"zim/').replaceAll('"/api/libraries/', '"api/library/');
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
  const get = async (p) => {
    const res = await fetch(base + p);
    if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
    return res;
  };
  const write = (file, data) => {
    const to = path.join(out, ...file.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
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
      const lib = `api/library/${info.id}`;
      const booksText = await (await get(`/api/libraries/${enc(info.id)}/books`)).text();
      write(`${lib}/books.json`, relativeUrls(booksText));
      const { books } = JSON.parse(booksText);
      for (const b of books) for (const u of [b.cover, b.emblem]) if (u) images.add(u);
      await each(books.filter((b) => b.readable), 4, async (b) => {
        const bookPath = `/api/libraries/${enc(info.id)}/books/${enc(b.id)}`;
        const metaText = await (await get(bookPath)).text();
        write(`${lib}/books/${b.id}/index.json`, relativeUrls(metaText));
        const meta = JSON.parse(metaText);
        if (meta.cover) images.add(meta.cover);
        await each(meta.chunks.map((_, n) => n), 8, async (n) => {
          const text = await (await get(`${bookPath}/chunks/${n}`)).text();
          write(`${lib}/books/${b.id}/chunks/${n}.json`, relativeUrls(text));
          blockImages(JSON.parse(text).blocks, images);
          stats.chunks++;
        });
        stats.books++;
      });
      const titles = await library.get(info.id).articleTitles?.();
      if (titles) write(`${lib}/titles.json`, JSON.stringify(titles));
      log(`  ${info.id}: ${books.length} ${info.kind === 'wikipedia' ? 'volumes' : 'books'}`);
    }
    // The images, at their decoded paths: Pages decodes a request's path to find the file.
    await each([...images], 16, async (src) => {
      if (!src.startsWith('/')) return; // data: URIs and the like stay inline
      const res = await fetch(base + src);
      if (!res.ok) return log(`  missing image ${src} (HTTP ${res.status})`);
      write(staticPath(src).split('/').map(decodeURIComponent).join('/'), Buffer.from(await res.arrayBuffer()));
      stats.images++;
    });
    return stats;
  } finally {
    server.close();
    await library.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function main() {
  const { values: opts } = parseArgs({ options: { out: { type: 'string', default: 'dist' }, zims: { type: 'string' } } });
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
  const vendor = [
    ...closure([...entries]).map((file) => [file, path.join(OUT, 'vendor', 'three', path.relative(THREE, file))]),
    ...closure([path.join(IWER, 'iwer.module.js')]).map((file) => [file, path.join(OUT, 'vendor', 'iwer', path.relative(IWER, file))]),
  ];
  for (const [from, to] of vendor) copy(from, to);

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
    + `(${vendor.length} vendor modules).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`build-pages: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
