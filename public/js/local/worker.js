// The local library's Web Worker (local.js starts it): reads ZIM files opened in the browser with
// the shared core (local-handler.js), off the page's thread. A module worker has no import map,
// so the vendor modules are named by relative URL (/vendor/ on the server and on Pages).
//
// Messages in: { id, method, args }. Out: { id, value } or { id, error }, { id, progress } (a
// fraction, at most every PROGRESS_MS, for an open or a book's meta), { indexing: { id, stage,
// progress } } as a library's index build moves on ({ id, done } once ready, `error` with stage
// 'failed'), { changed } when a library's catalogue changed on its own (its index finished),
// and { log } lines.

import { decompress } from '../../vendor/fzstd/esm/index.js';
import { inflateSync, unzlibSync } from '../../vendor/fflate/esm/browser.js';
import { Parser } from '../../vendor/htmlparser2/dist/Parser.js';
import { provide } from '../core/platform.js';
import { browserPlatform } from './browser-platform.js';
import { idbStore } from './idb-store.js';
import { createLocalLibraries } from './local-handler.js';
import { memoryStore, withPrebuilt } from './prebuilt.js';

provide(browserPlatform({ zstdDecompress: decompress, unzlibSync, inflateSync, Parser }));

const warn = (msg) => self.postMessage({ log: msg, warn: true });
// Derived indexes (a Wikipedia's) are kept in IndexedDB, so a file is indexed once; without it
// (a browser that blocks site data) they are kept in memory, for the page's life. Before an
// index is built, the site's indexes/ folder is asked for it (prebuilt.js).
let kept;
try {
  kept = idbStore();
} catch (err) {
  warn(`no IndexedDB (${err.message}): indexes are kept for this page only`);
  kept = memoryStore();
}
const INDEXES_URL = new URL('../../indexes/', import.meta.url);
const store = withPrebuilt(kept, async (name) => {
  const res = await fetch(new URL(name, INDEXES_URL));
  return res.ok ? res.text() : null;
});
// An index build's progress goes to the page at most every INDEXING_MS per library (it comes per
// cluster: thousands of times); a new stage, a failure and the end go at once.
const INDEXING_MS = 250;
const indexingSent = new Map(); // lib id → { at, stage }
const libraries = createLocalLibraries({
  log: (msg) => self.postMessage({ log: msg }),
  warn,
  store,
  onChange: () => self.postMessage({ changed: true }), // an index finished: the page refreshes its catalogue
  onIndexing: (id, info) => {
    const last = indexingSent.get(id);
    const now = performance.now();
    if (info && last && last.stage === info.stage && now - last.at < INDEXING_MS) return;
    indexingSent.set(id, { at: now, stage: info?.stage ?? null });
    if (!info) indexingSent.delete(id);
    self.postMessage({ indexing: { id, ...(info ?? { done: true }) } });
  },
});

const PROGRESS_MS = 100;

self.onmessage = async ({ data: { id, method, args } }) => {
  let last = -Infinity;
  const onProgress = (f) => {
    const now = performance.now();
    if (now - last < PROGRESS_MS && f < 1) return;
    last = now;
    self.postMessage({ id, progress: f });
  };
  try {
    const { value, transfer = [] } = await libraries.call(method, args, { onProgress });
    self.postMessage({ id, value }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
