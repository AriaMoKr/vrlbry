// Derived indexes on disk (<project>/.cache/): the store the shared core keeps them in
// (core/library.js: Wikisource works, Wikipedia articles and its checkpoint). Names are file
// names inside the folder; a missing file reads as null. A browser has no such folder (the local
// library builds nothing yet that it keeps).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where derived indexes are cached by default: <project>/.cache. */
export const DEFAULT_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');

const absent = (err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
};

/**
 * @param {string} dir
 * @returns {{ dir: string, readText(name: string): Promise<string|null>, readBytes(name: string): Promise<Uint8Array|null>,
 *   writeText(name: string, text: string): Promise<void>, writeBytes(name: string, bytes: Uint8Array): Promise<void>,
 *   appendBytes(name: string, bytes: Uint8Array): Promise<void>, truncate(name: string, size: number): Promise<void>,
 *   remove(name: string): Promise<void> }}
 */
export function fileStore(dir) {
  const file = (name) => path.join(dir, name);
  return {
    dir,
    readText: (name) => fs.readFile(file(name), 'utf8').catch(absent),
    readBytes: (name) => fs.readFile(file(name)).catch(absent),
    /** Atomically (temp file + rename): a reader never sees half an index. */
    async writeText(name, text) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file(name)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file(name));
    },
    async writeBytes(name, bytes) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(name), bytes);
    },
    appendBytes: (name, bytes) => fs.appendFile(file(name), bytes),
    truncate: (name, size) => fs.truncate(file(name), size),
    remove: (name) => fs.rm(file(name), { force: true }),
  };
}
