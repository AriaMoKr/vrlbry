// @ts-check
// The versions of the derived indexes (core/wikipedia.js, core/wikisource.js), which their names
// carry: here, without imports, so that the page (Kiwix's library, local/kiwix.js) names an index
// as the core does and tells a usable one from a stale one. Bump a version when its index's format
// or what it holds changes: a stale index is otherwise trusted.

/**
 * The Wikipedia index (§2.5): bump when the format or what counts as an article changes. 5
 * (2026-10-11): the compact form, about a quarter of v4's size.
 */
export const WIKIPEDIA_INDEX_VERSION = 5;
/** Older Wikipedia index versions that are upgraded where found (core/wikipedia.js parseIndexV4), not rebuilt. */
export const WIKIPEDIA_UPGRADABLE = [4];
/** The Wikisource works index (§2.4). */
export const WIKISOURCE_INDEX_VERSION = 1;

/**
 * The name an index is kept under (a store, the site's indexes/): its kind, the ZIM's UUID (32 hex
 * digits) and the version; null for a kind without one.
 * @param {string} kind 'wikipedia' | 'wikisource'
 * @param {string} uuid
 * @returns {string|null}
 */
export function indexNameFor(kind, uuid) {
  if (kind === 'wikipedia') return `wikipedia-${uuid}.v${WIKIPEDIA_INDEX_VERSION}.json`;
  if (kind === 'wikisource') return `wikisource-${uuid}.v${WIKISOURCE_INDEX_VERSION}.json`;
  return null;
}

/**
 * The names an index may be found under: the current one first, then those of older versions
 * that are upgraded where found (a site, a store), so an index kept in one counts as there.
 * @returns {string[]} empty for a kind without one
 */
export function indexNamesFor(kind, uuid) {
  const name = indexNameFor(kind, uuid);
  if (!name) return [];
  return kind === 'wikipedia' ? [name, ...WIKIPEDIA_UPGRADABLE.map((v) => `wikipedia-${uuid}.v${v}.json`)] : [name];
}

/** True for an index file name in its kind's current version (shipped and listed; older ones are upgraded, not shipped). */
export function isCurrentIndexName(name) {
  const m = /^(wikipedia|wikisource)-([0-9a-f]{32})\.v\d+\.json$/.exec(name);
  return !!m && indexNameFor(m[1], m[2]) === name;
}
