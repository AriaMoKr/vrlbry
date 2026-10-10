// Files opened once, reopened after a reload (SPEC §2.6): the File System Access API gives a
// handle for a picked or dropped file (showOpenFilePicker, DataTransferItem.getAsFileSystemHandle;
// desktop Chrome and Edge, and Quest Browser), a handle can be kept in IndexedDB, and on the next
// load the page asks for it again (requestPermission, within a tap) and reads the file. A browser
// without the API (Firefox, Safari) keeps nothing: the file is picked again. Handles are kept by
// file name; the page's own database ('vrlbry-files'), apart from the worker's indexes.

const DB = 'vrlbry-files';
const STORE = 'handles';

/** Whether this browser can hand out file handles (and so remember files). */
export const supportsHandles = () => typeof globalThis.showOpenFilePicker === 'function' && typeof globalThis.FileSystemFileHandle === 'function';

const settle = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
});

/**
 * The handles' store: remember(handles), list(), forget(name), reopen(entries). Takes the
 * IndexedDB factory (tests pass fake-indexeddb's) and handles as the API gives them (duck-typed
 * in tests: { name, queryPermission(), requestPermission(), getFile() }).
 * @param {{ indexedDB?: IDBFactory }} [opts]
 */
export function handleStore({ indexedDB: factory = globalThis.indexedDB } = {}) {
  let opening = null;
  const open = () => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`cannot open IndexedDB ${DB}`));
        req.onblocked = () => reject(new Error(`IndexedDB ${DB} is blocked`));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  const transact = async (mode, fn) => {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    return result;
  };
  return {
    /** Keeps these handles (by name; a name already kept is replaced). */
    remember: (handles) => transact('readwrite', (os) => {
      const at = Date.now();
      for (const handle of handles) os.put({ name: handle.name, handle, at });
    }).then(() => {}),
    /** The handles kept, oldest first: [{ name, handle, at }]. */
    list: () => transact('readonly', (os) => settle(os.getAll())).then((all) => all.sort((a, b) => a.at - b.at)),
    forget: (name) => transact('readwrite', (os) => settle(os.delete(name))).then(() => {}),
    forgetAll: () => transact('readwrite', (os) => settle(os.clear())).then(() => {}),
  };
}

/**
 * Picks ZIM files with the browser's handle-giving picker: { files, handles }, or null when the
 * person cancelled. Throws when the picker is not available (use the file input then).
 */
export async function pickFiles() {
  let handles;
  try {
    handles = await globalThis.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'ZIM files', accept: { 'application/octet-stream': ['.zim'] } }],
    });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
  const files = await Promise.all(handles.map((h) => h.getFile()));
  return { files, handles };
}

/**
 * The handles of a drop's files (null for each the browser cannot give), alongside its files.
 * @param {DataTransfer} dataTransfer
 */
export async function droppedHandles(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])].filter((it) => it.kind === 'file');
  return Promise.all(items.map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null))));
}

/**
 * Reads remembered files again: asks each handle for permission (within a tap: the browser
 * shows a prompt) and gets its File. Returns the files that could be read and the names that
 * could not (permission refused, file gone).
 * @param {Array<{ name: string, handle: object }>} entries
 * @returns {Promise<{ files: File[], handles: object[], failed: string[] }>}
 */
export async function reopen(entries) {
  const files = [];
  const handles = [];
  const failed = [];
  for (const { name, handle } of entries) {
    try {
      let state = await handle.queryPermission({ mode: 'read' });
      if (state !== 'granted') state = await handle.requestPermission({ mode: 'read' });
      if (state !== 'granted') throw new Error('not allowed');
      files.push(await handle.getFile());
      handles.push(handle);
    } catch {
      failed.push(name);
    }
  }
  return { files, handles, failed };
}
