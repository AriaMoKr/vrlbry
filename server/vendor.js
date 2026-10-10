// The third-party modules the browser loads from /vendor/<name>/ (the server maps node_modules;
// tools/build-pages.mjs copies what the client imports): three and IWER for the page, and for the
// local library's worker (public/js/local/) htmlparser2, entities, fzstd and fflate.
//
// A module worker has no import map, so a vendor module's bare imports must become relative URLs:
// rewriteVendorImports does that for the ones the worker reaches (htmlparser2's Tokenizer imports
// "entities/decode"), when the server serves a file and when the build copies it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = (...p) => path.join(ROOT, 'node_modules', ...p);

/** /vendor/<name>/ → its folder. */
export const DEFAULT_VENDOR_DIRS = Object.freeze({
  three: modules('three'),
  iwer: modules('iwer', 'build'),
  htmlparser2: modules('htmlparser2'),
  entities: modules('entities'),
  fzstd: modules('fzstd'),
  fflate: modules('fflate'),
});

/** Bare specifiers that vendor modules import, and the file they mean under /vendor/. */
const BARE = Object.freeze({
  'entities/decode': 'entities/dist/decode.js',
});

/**
 * Vendor URLs served from a file of another name: fzstd's module is an .mjs file, and a static
 * host may not send .mjs as JavaScript (a module script then fails), so it is named .js.
 */
const ALIASES = Object.freeze({
  'fzstd/esm/index.js': 'fzstd/esm/index.mjs',
});
const FROM_FILE = Object.freeze(Object.fromEntries(Object.entries(ALIASES).map(([url, file]) => [file, url])));

/** The file (under /vendor/, i.e. <name>/<path in the package>) that a vendor URL path means. */
export function vendorFileOf(vendorPath) {
  return ALIASES[vendorPath] ?? vendorPath;
}

/** The vendor URL path a package file is served at (the inverse of vendorFileOf). */
export function vendorUrlOf(vendorFile) {
  return FROM_FILE[vendorFile] ?? vendorFile;
}

/** The module specifiers in import/export-from statements: (head)(quote)(specifier). */
const SPEC = /(\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

/**
 * A vendor module's source with its known bare imports made relative.
 * @param {string} vendorPath the file under /vendor/, e.g. 'htmlparser2/dist/Tokenizer.js'
 * @param {string} source
 * @returns {string} the same string when there is nothing to rewrite
 */
export function rewriteVendorImports(vendorPath, source) {
  const dir = path.posix.dirname(vendorPath);
  return source.replace(SPEC, (all, head, q, spec) => {
    const target = BARE[spec];
    if (!target) return all;
    let rel = path.posix.relative(dir, target);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${head}${q}${rel}${q}`;
  });
}
