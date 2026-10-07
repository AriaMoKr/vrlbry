// The local library's Web Worker (local.js starts it): reads ZIM files opened in the browser with
// the shared core (local-handler.js), off the page's thread. A module worker has no import map,
// so the vendor modules are named by relative URL (/vendor/ on the server and on Pages).
//
// Messages in: { id, method, args }. Out: { id, value } or { id, error }, and { log } lines.

import { decompress } from '../../vendor/fzstd/esm/index.js';
import { inflateSync, unzlibSync } from '../../vendor/fflate/esm/browser.js';
import { Parser } from '../../vendor/htmlparser2/dist/Parser.js';
import { provide } from '../core/platform.js';
import { browserPlatform } from './browser-platform.js';
import { createLocalLibraries } from './local-handler.js';

provide(browserPlatform({ zstdDecompress: decompress, unzlibSync, inflateSync, Parser }));

const libraries = createLocalLibraries({
  log: (msg) => self.postMessage({ log: msg }),
  warn: (msg) => self.postMessage({ log: msg, warn: true }),
});

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    const { value, transfer = [] } = await libraries.call(method, args);
    self.postMessage({ id, value }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
