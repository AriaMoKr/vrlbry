// @ts-check
// One step back (SPEC §5.9): what Back on a TV's remote does while walking (common's tv.js, the
// Remote's step), from what is open, the latest first. Pure, for the tests: interaction.step() does
// it. The book's history entries and its links' (common's back-history.js) are the app's own Back,
// which goes back through the page's history as a browser's Back does: a step for one of them would
// make Back take two steps, the step and then the page's.

/**
 * @typedef {'text-toc' | 'link' | 'text' | 'typing' | 'toc' | 'away' | 'history'} BackStep
 *   text-toc: the text view's contents closed; link: back along the links followed (goBack); text:
 *   the text view closed; typing: the stand's search no longer typed into; toc: the 3D book's
 *   contents closed; away: the book put back (or its opening stopped); history: the app's Back,
 *   through the book's entries (a link back, then the book put away)
 */

/**
 * The step Back takes, or null when there is none to take here: the app goes back a page (to the
 * Hallway's door, say).
 * @param {object} s
 * @param {string} s.state interaction.js's: 'browse', 'busy', 'inspect', 'opening' or 'read'
 * @param {boolean} [s.textView] the text view is open
 * @param {boolean} [s.textToc] its contents are open
 * @param {boolean} [s.toc] the 3D book's contents are open
 * @param {number} [s.trail] the links followed in the book (its trail)
 * @param {boolean} [s.typing] typing on the stand's Search tab
 * @param {number} [s.level] the book's history entries (BackHistory's level): 0 none, 1 the book's,
 *   1 + n n links deep
 * @param {boolean} [s.entry] those entries are ones the app's Back comes to: the page had a key
 *   press or a click when the book came out (Chromium passes over the entries of a page that had
 *   neither, so Back would leave the page instead)
 * @returns {BackStep | null}
 */
export function backStep({ state, textView = false, textToc = false, toc = false, trail = 0, typing = false, level = 0, entry = false }) {
  const history = entry && level > 0;
  if (textView) {
    // The text view's Escape (its contents, then itself), with the links followed in it first, as
    // the browser's Back goes back along them there.
    if (textToc) return 'text-toc';
    if (trail > 0) return history && level > 1 ? 'history' : 'link';
    return 'text';
  }
  if (state === 'browse') return typing ? 'typing' : null;
  if (state === 'read' && toc) return 'toc';
  if (history) return 'history';
  if (state === 'read' && trail > 0) return 'link';
  return 'away'; // in hand, open, opening, or on its way (putAway waits for it)
}
