// @ts-check
// Finding a full-text search hit in a book's blocks (SPEC §4, full-text search). The reader opens
// at the block holding most of the query's words; among those, the one holding the words of the
// search engine's snippet (Xapian's, through kiwix-serve: an excerpt of the page around a hit) in a
// row. The snippet alone can point at a book's contents list, where every chapter title is.

/** The lower-case words of a text, without accents or punctuation. */
export function textWords(text) {
  let s = String(text ?? '');
  // Only non-ASCII text needs the (slower) normalization.
  if (/[^\x00-\x7f]/.test(s)) s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const IMAGE_RUN = '￼';

/** A block's text (§3.5): its runs (image runs as a space), a table row's cells, a pre's text. */
export function blockText(block) {
  if (block.t === 'pre') return block.x ?? '';
  if (block.t === 'tr') return (block.c ?? []).map(runsText).join(' ');
  return runsText(block.r);
}

function runsText(runs) {
  let s = '';
  // Runs are contiguous text (a word may change style halfway), so no space between them.
  for (const run of runs ?? []) s += run[0] === IMAGE_RUN ? ' ' : run[0];
  return s;
}

const WINDOW = 6; // words in a row to look for: enough to be unique in a book, few enough to fit a block

/**
 * What to look for from a snippet ([text, hit] parts; "..." where the engine left text out) and
 * the query: `words`, up to WINDOW words in a row from the piece around the first hit, `hits`, the
 * words the engine matched, and `terms`, the query's words (each once).
 * @param {Array<[string, boolean|number]>} parts
 * @param {string} [q]
 * @returns {{ words: string[], hits: string[], terms: string[] }}
 */
export function snippetTarget(parts, q = '') {
  const terms = [...new Set(textWords(q))];
  const hits = [...new Set(parts.filter(([, hit]) => hit).flatMap(([t]) => textWords(t)))];
  // \u0001 marks where the first hit starts, so its place survives the split into pieces.
  let marked = false;
  const text = parts.map(([t, hit]) => {
    if (!hit || marked) return t;
    marked = true;
    return `\u0001${t}`;
  }).join('');
  const pieces = text.split(/\.\.\.|…/).filter((p) => textWords(p).length);
  if (!pieces.length) return { words: [], hits, terms };
  const piece = pieces.find((p) => p.includes('\u0001')) ?? pieces.reduce((a, b) => (textWords(b).length > textWords(a).length ? b : a));
  const words = textWords(piece);
  const at = piece.includes('\u0001') ? textWords(piece.slice(0, piece.indexOf('\u0001'))).length : 0;
  // The hit and the words after it; words before it when the piece ends soon after.
  const start = Math.max(0, Math.min(at - 1, words.length - WINDOW));
  return { words: words.slice(start, start + WINDOW), hits, terms };
}

/**
 * Whether a block's words hold a query term, allowing other endings ("harpoon": "harpoons",
 * "harpooneer"), as the search engine's stemming does.
 */
function hasTerm(have, words, term) {
  if (have.has(term)) return true;
  if (term.length < 5) return false;
  const stem = term.slice(0, Math.max(4, term.length - 2));
  return words.some((w) => w.startsWith(stem));
}

/** Whether `words` holds `run` in a row. */
function holds(words, run) {
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer;
    return true;
  }
  return false;
}

/** The best score a block can have for `target` (findInBlocks). */
export function topScore({ words, hits, terms = [] }) {
  return terms.length * 10 + (words.length ? 5 : 0) + hits.length;
}

/**
 * The block from `from` that best matches `target`, the first among equals: 10 points per query
 * term it holds, 5 for the snippet's words in a row (`exact`), 1 per snippet hit word; null when
 * none scores.
 * @param {object[]} blocks
 * @param {{ words: string[], hits: string[], terms?: string[] }} target
 * @param {number} [from=0]
 * @returns {{ b: number, exact: boolean, score: number } | null}
 */
export function findInBlocks(blocks, target, from = 0) {
  const { words, hits, terms = [] } = target;
  const top = topScore(target);
  let best = null;
  for (let b = Math.max(0, from); b < blocks.length; b++) {
    const w = textWords(blockText(blocks[b]));
    if (!w.length) continue;
    const have = new Set(w);
    let score = 0;
    for (const t of terms) if (hasTerm(have, w, t)) score += 10;
    const exact = words.length > 0 && holds(w, words);
    if (exact) score += 5;
    for (const h of hits) if (have.has(h)) score++;
    if (score && (!best || score > best.score)) {
      best = { b, exact, score };
      if (score === top) break;
    }
  }
  return best;
}
