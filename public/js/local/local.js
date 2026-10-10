// The page's side of the local library: ZIM files opened in this browser (step 2, SPEC §2.6),
// from this device or from a web address (milestone 3), read by worker.js with the shared core.
// api.js sends the requests for libraries whose id starts with '~' here, and asks here for their
// images (imageSource). The worker starts with the first file; until then nothing is loaded.
// Opened files last until the page is reloaded (main.js reopens web addresses then).

import { fileNameOf, proxiedUrl, zimProxyOf } from './zim-url.js';

let worker = null;
let seq = 0;
const pending = new Map(); // request id → { resolve, reject, onProgress? }
const listeners = new Set();
const indexingListeners = new Set();
let opened = 0;
/** The site's edge proxy for Kiwix's files (zim-url.js zimProxyOf; optional), or null. */
const ZIM_PROXY = zimProxyOf();

/**
 * A ZIM to try the local library with, from Kiwix (one of tools/demo-set.txt's, so the address is
 * one the Pages workflow keeps using; a test checks), and where more like it are.
 */
export const EXAMPLE_ZIM = Object.freeze({
  title: 'Gutenberg · Language and literature',
  url: 'https://download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim',
  size: '37 MB',
});
export const MORE_ZIMS_URL = 'https://download.kiwix.org/zim/gutenberg/';

/** True for a local library's id. */
export const isLocal = (libId) => String(libId ?? '').startsWith('~');

/** True for a local library's URL (/zim/~id/…, api/libraries/~id/books/…/res/…). */
export const isLocalUrl = (url) => /^(?:\.?\/)*(?:zim|api\/libraries)\/(?:~|%7e)/i.test(String(url ?? ''));

function start() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.log !== undefined) {
      (data.warn ? console.warn : console.info)(`[vrlbry local] ${data.log}`);
      return;
    }
    if (data.changed) { // a library's index finished: its catalogue entry and books are new
      for (const fn of listeners) fn();
      return;
    }
    if (data.indexing) { // a library's index build moved on
      for (const fn of indexingListeners) fn(data.indexing);
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    if (data.progress !== undefined) {
      p.onProgress?.(data.progress);
      return;
    }
    pending.delete(data.id);
    if ('error' in data) p.reject(new Error(data.error));
    else p.resolve(data.value);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'the local library could not start');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

function call(method, args = {}, { onProgress } = {}) {
  start();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, method, args });
  });
}

/** The name of what openFiles opens: a File's, or the file name a web address ends with. */
export const sourceName = (source) => (typeof source === 'string' ? fileNameOf(source) : source?.name) || 'the ZIM file';

/**
 * Opens ZIM files (File objects from a picker or a drop, or web addresses as zim-url.js makes
 * them), one after the other.
 * @param {Iterable<File|string>} files
 * @param {{ onFile?: (file: File, i: number) => void, onProgress?: (fraction: number) => void,
 *   onOpened?: (result: object) => void, stopped?: () => boolean, site?: boolean }} [opts]
 *   onFile: called as each file starts; onProgress: how far all of them are (each file's share by
 *   how much of its catalogue is built); onOpened: each file's result as soon as it is open;
 *   stopped: checked before each file: true opens no more (those left get `skipped: true`).
 *   Several files' index builds wait until all are open, then go smallest first. site: web
 *   addresses on this site that the site ships (main.js), marked so in the catalogue.
 * @returns {Promise<Array<{ name: string, id?: string, title?: string, kind?: string, books?: number, url?: string, error?: string, skipped?: true }>>}
 */
export async function openFiles(files, { onFile, onProgress, onOpened, stopped = () => false, site = false } = {}) {
  const list = [...files];
  const results = [];
  const batch = list.length > 1;
  if (batch) await call('hold');
  try {
    for (const [i, file] of list.entries()) {
      const name = sourceName(file);
      if (stopped()) {
        results.push({ name, skipped: true });
        continue;
      }
      onFile?.(file, i);
      onProgress?.(i / list.length);
      try {
        const what = typeof file === 'string' ? { url: file, via: proxiedUrl(file, ZIM_PROXY), ...(site ? { site: true } : {}) } : { file };
        results.push({ name, ...(await call('open', what, { onProgress: onProgress && ((f) => onProgress((i + f) / list.length)) })) });
        onOpened?.(results.at(-1));
        opened++;
      } catch (err) {
        results.push({ name, error: err.message, ...(typeof file === 'string' ? { url: file } : {}) });
      }
    }
  } finally {
    if (batch) await call('release').catch(() => {});
  }
  return results;
}

/** Closes a local library: stops its index build too (a cancel). */
export const close = (lib) => call('close', { lib });

/**
 * Calls fn when a local library's catalogue changed on its own: its index finished (a Wikipedia
 * or Wikisource file), so the catalogue's generation is new and it has books now. (Files just
 * opened are the caller's: openFiles answers them.)
 */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Calls fn({ id, file, stage, progress, error? } | { id, file, done }) as a local library's index build
 * moves on (a Wikipedia or Wikisource file: 'queued', then the stages of §2.4/§2.5, 'failed'
 * with `error`), for a progress indicator; `done` once the index is ready (onChange follows).
 */
export function onIndexing(fn) {
  indexingListeners.add(fn);
  return () => indexingListeners.delete(fn);
}

/** The local libraries: { generation, libraries: [info] }. Starts nothing when none are open. */
export function catalog() {
  return opened ? call('catalog') : Promise.resolve({ generation: 0, libraries: [] });
}

export const books = (lib) => call('books', { lib });
/** A local Wikipedia's articles whose titles (or other names) start with q: { title, book, n }. */
export const articles = (lib, q, limit) => call('articles', { lib, q, limit });
/** A book's reading metadata; `onProgress(fraction)` while the worker converts it. */
export const meta = (lib, book, { onProgress } = {}) => call('meta', { lib, book }, { onProgress });
/** A chunk's JSON, as bytes. */
export const chunk = (lib, book, n) => call('chunk', { lib, book, n });
/** An image of a local library: { bytes, mime }, or null. */
export const image = (url) => call('image', { url });
