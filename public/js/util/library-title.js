// A library's title as the app shows it (§4), from its ZIM's metadata or a catalogue entry (Kiwix's
// OPDS: local/kiwix.js): shared by the core (core/library.js) and the page. No imports, so a
// worker or the page can load it as it is.

/**
 * The title a library is shown by (§4), so that a folder of ZIMs can be told apart. The ZIM's own
 * title, except:
 * - Kiwix's Gutenberg ZIMs of one Library of Congress class (name `gutenberg_<lang>_lcc-<code>`)
 *   all say "Project Gutenberg Library": they are named by their class (the ZIM's description) and
 *   its code, e.g. "Gutenberg · English language (PE)";
 * - a Wikipedia topic comes in editions with one title: the mini one (each article's introduction)
 *   and the nopic one say so, e.g. "Physics by Wikipedia (introductions)"; the full one (maxi)
 *   keeps the plain title.
 * @param {{ kind: string, title: string, description: string|null, name: string|null, flavour?: string|null }} info
 * @returns {string}
 */
export function libraryTitle({ kind, title, description, name, flavour = null }) {
  const lcc = kind === 'gutenberg' && description && /^gutenberg_[a-z-]+_lcc-([a-z]+)$/i.exec(name ?? '');
  if (lcc) return `Gutenberg · ${description} (${lcc[1].toUpperCase()})`;
  const edition = kind === 'wikipedia' && { mini: 'introductions', nopic: 'no pictures' }[String(flavour ?? '').toLowerCase()];
  return edition ? `${title} (${edition})` : title;
}
