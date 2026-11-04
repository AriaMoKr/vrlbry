// Module resolution hooks (node:module register, from ./vendor.js): a file URL under public/vendor/
// is the package file the server serves there (server/vendor.js DEFAULT_VENDOR_DIRS, vendorFileOf).
// Everything else resolves as usual, so a vendor module's own imports (relative, or bare from
// node_modules) need nothing more.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_VENDOR_DIRS, vendorFileOf } from '../../server/vendor.js';

const VENDOR = `${pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'vendor')).href}/`;

export async function resolve(specifier, context, next) {
  if (context.parentURL?.startsWith('file:') && /^\.{1,2}\//.test(specifier)) {
    const url = new URL(specifier, context.parentURL).href;
    if (url.toLowerCase().startsWith(VENDOR.toLowerCase())) {
      const [name, ...rest] = vendorFileOf(decodeURIComponent(url.slice(VENDOR.length))).split('/');
      if (DEFAULT_VENDOR_DIRS[name]) return next(pathToFileURL(path.join(DEFAULT_VENDOR_DIRS[name], ...rest)).href, context);
    }
  }
  return next(specifier, context);
}
