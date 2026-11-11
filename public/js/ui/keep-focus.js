// @ts-check
// Lists drawn again without losing the keyboard's focus (SPEC §5.6): the card's libraries are
// drawn again with every catalogue, and the status box's index builds once a second while files
// open or index. Drawn with innerHTML, a button of theirs with the focus went with the old list:
// the focus fell to <body>, or on a TV to the 3D view. Drawn in place, an item still listed keeps
// its elements, so its button keeps the focus and a screen reader is told nothing again; when its
// item goes, the focus goes to the one now in its place. Shared with music, as the overlay is.

const ELEMENT = 1; // Node.ELEMENT_NODE (no Node global in the tests' Node.js)

/**
 * Whether an element is in the page and drawn (not hidden, nor inside something hidden).
 * @param {Element | null | undefined} el
 */
export const shown = (el) => !!el?.isConnected && el.getClientRects().length > 0;

/**
 * Whether the keyboard gave this element its focus (`:focus-visible`), not the pointer.
 * @param {Element} el
 */
function byKeyboard(el) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false; // a browser without :focus-visible: the focus let go, as before
  }
}

/**
 * Before a part of the page is drawn again: when the keyboard's focus is on one of its controls
 * (`selector`), the function returned keeps it once the part is drawn: on the same control while
 * it is shown and still one of them (the selector may name a state: `[tabindex]`), else on the
 * one with its data-id, else on the one now in its place (the next, or else the last), else on
 * what `rest` gives. A focus the pointer gave is let go, as before: after a click on a ×, Enter or
 * Space must not press the next one.
 * @param {Element} part
 * @param {string} selector
 * @returns {(rest?: () => HTMLElement | null | undefined) => void}
 */
export function keepFocus(part, selector) {
  const doc = part.ownerDocument;
  const a = /** @type {HTMLElement | null} */ (doc.activeElement);
  if (!a || !part.contains(a) || !a.matches(selector) || !byKeyboard(a)) return () => {};
  const id = a.dataset.id;
  const controls = () => /** @type {HTMLElement[]} */ ([...part.querySelectorAll(selector)]).filter(shown);
  const at = controls().indexOf(a);
  return (rest) => {
    let to = shown(a) && a.matches(selector) ? a : null;
    if (!to) {
      const now = controls();
      to = (id !== undefined && now.find((b) => b.dataset.id === id)) || (at >= 0 && now[Math.min(at, now.length - 1)]) || rest?.() || null;
    }
    if (to && doc.activeElement !== to) to.focus();
  };
}

/**
 * Whether a kept node can become the new one in place: of the same kind, and an <img> showing the
 * same picture (its data-img: a local library's src is a blob URL once loaded, fillLocalImages).
 * @param {Node} a
 * @param {Node} b
 */
function same(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  return a.nodeName !== 'IMG' || /** @type {Element} */ (a).getAttribute('data-img') === /** @type {Element} */ (b).getAttribute('data-img');
}

/**
 * Makes a kept node like its new markup, changing only what differs: a text, an attribute, a
 * child of another kind made anew. An <img> of the same picture is left as it is.
 * @param {Node} a in the page
 * @param {Node} b from the new markup
 */
function morph(a, b) {
  if (!same(a, b)) {
    /** @type {ChildNode} */ (a).replaceWith(b);
    return;
  }
  if (a.nodeType !== ELEMENT) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeName === 'IMG') return;
  const ea = /** @type {Element} */ (a);
  const eb = /** @type {Element} */ (b);
  for (const name of ea.getAttributeNames()) if (!eb.hasAttribute(name)) ea.removeAttribute(name);
  for (const name of eb.getAttributeNames()) {
    const value = /** @type {string} */ (eb.getAttribute(name));
    if (ea.getAttribute(name) !== value) ea.setAttribute(name, value);
  }
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  bc.forEach((c, i) => (i < ac.length ? morph(ac[i], c) : a.appendChild(c)));
  for (const c of ac.slice(bc.length)) c.remove();
}

/**
 * Draws a list from its items' markup, in place. Each item (an element at the top of the markup)
 * carries data-key; one already listed keeps its element, made like its new markup (morph), so
 * a control in it keeps the focus. Items gone are taken out and new ones put in their place; a
 * kept one is moved only when the order changed (which loses a focus in it: keepFocus gives it
 * back).
 * @param {Element} list
 * @param {string} html
 */
export function drawInPlace(list, html) {
  const t = list.ownerDocument.createElement('template');
  t.innerHTML = html;
  const fresh = [...t.content.children];
  const byKey = new Map(fresh.map((el) => [el.getAttribute('data-key'), el]));
  /** @type {Map<string, Element>} */
  const kept = new Map();
  for (const node of [...list.childNodes]) {
    const key = node.nodeType === ELEMENT ? /** @type {Element} */ (node).getAttribute('data-key') : null;
    const to = key === null ? undefined : byKey.get(key);
    if (key !== null && to && same(node, to) && !kept.has(key)) kept.set(key, /** @type {Element} */ (node));
    else node.remove();
  }
  let at = list.firstChild;
  for (const el of fresh) {
    const was = kept.get(/** @type {string} */ (el.getAttribute('data-key')));
    if (was) morph(was, el);
    const node = was ?? el;
    if (node === at) at = node.nextSibling;
    else list.insertBefore(node, at);
  }
}
