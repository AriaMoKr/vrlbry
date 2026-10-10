// The versions of the derived indexes (core/wikipedia.js, core/wikisource.js), which their names
// carry: here, without imports, so that the page (Kiwix's library, local/kiwix.js) names an index
// as the core does and tells a usable one from a stale one. Bump a version when its index's format
// or what it holds changes: a stale index is otherwise trusted.

/** The Wikipedia index (§2.5): bump when the format or what counts as an article changes. */
export const WIKIPEDIA_INDEX_VERSION = 4;
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
