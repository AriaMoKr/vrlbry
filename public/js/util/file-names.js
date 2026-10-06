// File names in the static build (GitHub Pages, tools/build-pages.mjs, SPEC §4). Each URL path
// segment is a file or folder of the same name, which Pages finds by decoding the request's path.
// Some names cannot be files on every system (Windows: quotes in Wikipedia image names), so the
// build stores those escaped, and the page asks for the escaped name.

/** Escaped everywhere: what Windows does not allow, path separators, and `%` (keeps names distinct). */
const ESCAPE = /[%"<>:|?*\\/\x00-\x1f\x7f]/g;
/** Windows device names, which no file may have, whatever its extension. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

const hex = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The file name a (decoded) URL path segment gets in the static build: unchanged when every
 * system can store it, else with the offending characters percent-escaped: `" < > : | ? * \ /`,
 * control characters and `%`, a final dot or space (Windows drops them), and the first letter of
 * a device name (CON, NUL, COM1…).
 * @param {string} name
 * @returns {string}
 */
export function fileName(name) {
  let out = name.replace(ESCAPE, hex).replace(/[. ]$/, hex);
  if (DEVICE.test(out)) out = hex(out[0]) + out.slice(1);
  return out;
}
