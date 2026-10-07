/**
 * The ZIM libraries of a folder on disk (SPEC §2.2, §3.6). Each file is an `ArchiveLibrary`
 * (public/js/core/library.js, shared with the browser): this module opens them from files, keeps
 * their derived indexes in .cache/ (server/cache-store.js), and scans and watches the folder.
 */
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import './platform-node.js';
import { DEFAULT_CACHE_DIR, fileStore } from './cache-store.js';
import {
  ArchiveLibrary as CoreArchiveLibrary, CONTENT_CACHE_BYTES, createContentCache, libraryIdFor,
} from '../public/js/core/library.js';
import { IndexQueue } from '../public/js/core/util/index-queue.js';

export {
  LibraryError, createContentCache, gutenbergBase, libraryIdFor, libraryTitle, parseIndexScript, splitTitle, zimUrl,
} from '../public/js/core/library.js';
export { DEFAULT_CACHE_DIR } from './cache-store.js';

/** An archive library opened from a file, with its derived indexes cached in a folder. */
export class ArchiveLibrary extends CoreArchiveLibrary {
  /**
   * Opens a ZIM file: as the core's ArchiveLibrary.open, with `cacheDir` (default
   * <project>/.cache) as the store of its Wikisource / Wikipedia index.
   * @param {string} filePath
   * @param {object} [opts] see core/library.js; plus `cacheDir`
   * @returns {Promise<ArchiveLibrary>}
   */
  static open(filePath, { cacheDir = DEFAULT_CACHE_DIR, store, ...opts } = {}) {
    return super.open(filePath, { ...opts, store: store ?? fileStore(cacheDir) });
  }
}

/** All ZIM libraries of one directory. Create with `Library.scan()`. */
export class Library {
  /** @private Use Library.scan(). */
  constructor(dir, contentCache, opts) {
    /** Absolute path of the scanned directory. */
    this.dir = dir;
    this._libs = [];
    this._byId = new Map();
    this._files = new Map(); // file name -> { lib, size, mtimeMs }
    this._failed = new Map(); // file name -> "size:mtime" of the last failed attempt
    this._splitWarned = new Set();
    this._opts = opts;
    this._scanning = null;
    this._rescanAgain = false;
    this._watcher = null;
    this._debounce = null;
    this._interval = null;
    this.contentCache = contentCache;
    /** Background index builds of this folder's libraries, big archives one at a time. */
    this.indexQueue = new IndexQueue(opts.indexQueue);
    /** Increments whenever the set of libraries changes (clients poll it to re-shelve). */
    this.generation = 0;
  }

  /**
   * Lists `*.zim` files in `dir` (case-insensitive, not recursive) and opens each one. Files
   * that cannot be opened are logged and skipped; split archives (.zimaa…) are reported as
   * unsupported.
   * @param {string} dir
   * @param {object} [opts]
   * @param {number} [opts.maxGenericBooks=2000]
   * @param {(msg: string) => void} [opts.log=console.log] progress / information
   * @param {(msg: string) => void} [opts.warn=log] skipped files and problems with archive data
   * @param {number} [opts.contentCacheBytes=314572800] budget for converted books (all archives)
   * @param {object} [opts.archiveOptions] passed to ZimArchive.open (default cluster cache 64 MB)
   * @param {string} [opts.cacheDir] where derived indexes are cached (default <project>/.cache)
   * @param {{ smallBytes?: number }} [opts.indexQueue] IndexQueue options (archives indexed at once)
   * @returns {Promise<Library>}
   */
  static async scan(dir, {
    maxGenericBooks = 2000,
    log = console.log,
    warn = log,
    contentCacheBytes = CONTENT_CACHE_BYTES,
    archiveOptions,
    cacheDir = DEFAULT_CACHE_DIR,
    indexQueue,
  } = {}) {
    const abs = path.resolve(dir);
    await fs.readdir(abs); // fail early (and loudly) on a missing or unreadable directory
    const lib = new Library(abs, createContentCache(contentCacheBytes), { maxGenericBooks, log, warn, archiveOptions, cacheDir, indexQueue });
    await lib.rescan({ quiet: true });
    return lib;
  }

  /**
   * Re-reads the directory: opens new `.zim` files, closes removed ones and reopens files whose
   * size or modification time changed (a replaced archive keeps its library id). Concurrent calls
   * share one scan; a call arriving during a scan triggers one more pass after it.
   * @param {{ quiet?: boolean }} [opts] quiet: no summary line (used by the initial scan)
   * @returns {Promise<{ generation: number, added: string[], removed: string[], reopened: string[], failed: string[] }>}
   */
  rescan(opts = {}) {
    if (this._scanning) {
      this._rescanAgain = true;
      return this._scanning;
    }
    // No index build starts until every new archive is open, so the smallest goes first.
    this.indexQueue.hold();
    this._scanning = (async () => {
      const total = { added: [], removed: [], reopened: [], failed: [] };
      do {
        this._rescanAgain = false;
        const r = await this._rescanOnce(opts);
        for (const k of Object.keys(total)) total[k].push(...r[k]);
      } while (this._rescanAgain);
      return { generation: this.generation, ...total };
    })().finally(() => {
      this._scanning = null;
      this.indexQueue.release();
    });
    return this._scanning;
  }

  async _rescanOnce({ quiet = false } = {}) {
    const { log, warn, maxGenericBooks, archiveOptions, cacheDir } = this._opts;
    const dirents = await fs.readdir(this.dir, { withFileTypes: true });
    const names = dirents.filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const present = new Map();
    for (const name of names) {
      if (/\.zim[a-z]{2}$/i.test(name)) {
        const stem = name.slice(0, -2);
        if (!this._splitWarned.has(stem)) {
          this._splitWarned.add(stem);
          warn(`${stem}aa…: split ZIM archives are not supported (join the parts into one .zim file)`);
        }
        continue;
      }
      if (!/\.zim$/i.test(name)) continue;
      const st = await fs.stat(path.join(this.dir, name)).catch(() => null);
      if (st && st.isFile()) present.set(name, st);
    }

    const added = [];
    const removed = [];
    const reopened = [];
    const failed = [];
    const reuseIds = new Map(); // file name -> library id kept across a reopen
    for (const [name, entry] of [...this._files]) {
      const st = present.get(name);
      if (st && st.size === entry.size && st.mtimeMs === entry.mtimeMs) continue;
      this._files.delete(name);
      this._libs = this._libs.filter((l) => l !== entry.lib);
      this._byId.delete(entry.lib.id);
      await entry.lib.close().catch(() => {});
      if (st) reuseIds.set(name, entry.lib.id);
      else {
        removed.push(entry.lib.id);
        log(`${name}: removed`);
      }
    }
    for (const name of [...this._failed.keys()]) if (!present.has(name)) this._failed.delete(name);

    for (const [name, st] of present) {
      if (this._files.has(name)) continue;
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (this._failed.get(name) === stamp) continue; // unchanged since it last failed: skip quietly
      let id = reuseIds.get(name);
      if (!id) {
        const base = libraryIdFor(name);
        id = base;
        for (let n = 2; this._byId.has(id); n++) id = `${base}-${n}`;
      }
      const t0 = performance.now();
      try {
        const lib = await ArchiveLibrary.open(path.join(this.dir, name), {
          id, maxGenericBooks, log, warn, contentCache: this.contentCache, archiveOptions, cacheDir, indexQueue: this.indexQueue,
          // A background index finishing changes the catalogue: clients poll `generation`.
          onChange: () => { this.generation++; },
        });
        this._files.set(name, { lib, size: st.size, mtimeMs: st.mtimeMs });
        this._byId.set(id, lib);
        this._libs.push(lib);
        this._failed.delete(name);
        (reuseIds.has(name) ? reopened : added).push(id);
        const count = (await lib.books()).length;
        log(`${name}: ${lib.kind} library, ${count} book(s) (${Math.round(performance.now() - t0)} ms)`);
      } catch (err) {
        // A file that is still being copied or downloaded fails here; it is retried as soon as
        // its size or modification time changes.
        this._failed.set(name, stamp);
        failed.push(name);
        warn(`${name}: skipped, cannot open: ${err.message}`);
      }
    }
    // Keep file-name order, like the initial scan.
    const rank = new Map([...this._files.keys()].sort().map((n, i) => [this._files.get(n).lib, i]));
    this._libs.sort((a, b) => rank.get(a) - rank.get(b));
    if (added.length || removed.length || reopened.length || this.generation === 0) this.generation++;
    if (!quiet && (added.length || removed.length || reopened.length)) {
      log(`Rescan: ${added.length} added, ${removed.length} removed, ${reopened.length} reopened (${this._libs.length} libraries)`);
    }
    return { added, removed, reopened, failed };
  }

  /**
   * Rescans automatically when `.zim` files appear, change or disappear: a debounced fs.watch on
   * the directory (a finished browser download is a rename to *.zim) plus a slow periodic pass in
   * case the platform drops watch events (network drives).
   * @param {{ debounceMs?: number, intervalMs?: number }} [opts]
   * @returns {() => void} stops watching
   */
  watch({ debounceMs = 2500, intervalMs = 60000 } = {}) {
    this.unwatch();
    const schedule = () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this.rescan().catch((e) => this._opts.warn(`Rescan failed: ${e.message}`));
      }, debounceMs);
      this._debounce.unref?.();
    };
    try {
      this._watcher = fsWatch(this.dir, { persistent: false }, (event, filename) => {
        if (!filename || /\.zim([a-z]{2})?$/i.test(String(filename))) schedule();
      });
      this._watcher.on('error', () => {
        this._watcher?.close();
        this._watcher = null;
      });
    } catch (err) {
      this._opts.warn(`Cannot watch ${this.dir} (${err.message}); rescanning every ${Math.round(intervalMs / 1000)} s instead`);
    }
    this._interval = setInterval(schedule, intervalMs);
    this._interval.unref?.();
    return () => this.unwatch();
  }

  /** Stops automatic rescans. */
  unwatch() {
    this._watcher?.close();
    this._watcher = null;
    clearTimeout(this._debounce);
    clearInterval(this._interval);
    this._debounce = null;
    this._interval = null;
  }

  /** @returns {ArchiveLibrary[]} in file-name order */
  list() {
    return this._libs.slice();
  }

  /**
   * @param {string} libId
   * @returns {ArchiveLibrary|undefined}
   */
  get(libId) {
    return this._byId.get(libId);
  }

  /** Stops watching and closes every archive. */
  async close() {
    this.unwatch();
    if (this._scanning) await this._scanning.catch(() => {});
    await Promise.allSettled(this._libs.map((l) => l.close()));
    this.contentCache.clear();
  }
}
