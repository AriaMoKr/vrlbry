#!/usr/bin/env node
// Builds the static site for GitHub Pages into dist/ (or --out <dir>): the client without the
// Node server. The page's API calls get static answers (api/libraries: no libraries, "static";
// api/version: when the site last changed), and /vendor/ holds only the three.js and IWER files the
// client imports (followed from its imports), instead of the server mapping node_modules.
//
//   node tools/build-pages.mjs [--out dist]
//
// Everything in the client is addressed relative to the page or to js/, so the site works under a
// path (https://<user>.github.io/vrlbry/) as well as at the root of the Node server.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const IWER = path.join(ROOT, 'node_modules', 'iwer', 'build');
/** Pages of public/ that need the Node server's API (book lists, chunks): left out. */
const SERVER_ONLY = ['dev', 'reader-test.html'];

const { values: opts } = parseArgs({ options: { out: { type: 'string', default: 'dist' } } });
const OUT = path.resolve(ROOT, opts.out);

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

function main() {
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

  // The API's static answers: no libraries yet, and when the site last changed.
  const api = path.join(OUT, 'api');
  fs.mkdirSync(api, { recursive: true });
  fs.writeFileSync(path.join(api, 'libraries'), JSON.stringify({ generation: 0, libraries: [], static: true }));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
