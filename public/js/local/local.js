// The page's side of the local library: ZIM files opened in this browser (step 2, SPEC §2.6),
// read by worker.js with the shared core. api.js sends the requests for libraries whose id starts
// with '~' here, and asks here for their images (imageSource). The worker starts with the first
// file; until then nothing is loaded. Opened files last until the page is reloaded.

let worker = null;
let seq = 0;
const pending = new Map(); // request id → { resolve, reject }
const listeners = new Set();
let opened = 0;

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
    const p = pending.get(data.id);
    if (!p) return;
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

function call(method, args = {}) {
  start();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

/**
 * Opens ZIM files (File objects from a picker or a drop), one after the other.
 * @param {Iterable<File>} files
 * @returns {Promise<Array<{ name: string, id?: string, title?: string, kind?: string, books?: number, error?: string }>>}
 */
export async function openFiles(files) {
  const results = [];
  for (const file of files) {
    try {
      results.push({ name: file.name, ...(await call('open', { file })) });
      opened++;
    } catch (err) {
      results.push({ name: file.name, error: err.message });
    }
  }
  if (results.some((r) => r.id)) for (const fn of listeners) fn();
  return results;
}

/** Calls fn when local libraries were opened (the catalogue changed). */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The local libraries: { generation, libraries: [info] }. Starts nothing when none are open. */
export function catalog() {
  return opened ? call('catalog') : Promise.resolve({ generation: 0, libraries: [] });
}

export const books = (lib) => call('books', { lib });
export const meta = (lib, book) => call('meta', { lib, book });
/** A chunk's JSON, as bytes. */
export const chunk = (lib, book, n) => call('chunk', { lib, book, n });
/** An image of a local library: { bytes, mime }, or null. */
export const image = (url) => call('image', { url });
