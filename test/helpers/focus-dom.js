// A small document for lists drawn again with the keyboard's focus kept (public/js/ui/keep-focus.js):
// nodes that can be moved, replaced and removed (a removed node with the focus in it lets the focus
// fall to <body>, as a browser does), innerHTML through htmlparser2, the simple selectors the code
// uses (a tag, classes, [attr], :disabled, :not(:disabled), :focus-visible), what is shown (the
// hidden attribute) and the focus (document.activeElement; :focus-visible when the keyboard gave
// it, `keyboard`; each move counted, as each would be told to a screen reader). Not a browser:
// enough for the code under test.
import { Parser } from 'htmlparser2';

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);

class FakeNode {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get nextSibling() {
    const sibs = this.parentNode?.childNodes;
    return sibs ? sibs[sibs.indexOf(this) + 1] ?? null : null;
  }

  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  remove() {
    const p = this.parentNode;
    if (!p) return;
    const doc = this.ownerDocument;
    const lost = this.contains(doc.activeElement);
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
    if (lost) doc.activeElement = doc.body; // the focus falls to <body>
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, ref) {
    if (node.nodeType === 11) {
      for (const c of [...node.childNodes]) this.insertBefore(c, ref);
      return node;
    }
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: the reference is not a child of this node');
    node.remove();
    node.parentNode = this;
    if (ref) this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    else this.childNodes.push(node);
    return node;
  }

  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    const next = this.nextSibling === node ? node.nextSibling : this.nextSibling;
    this.remove();
    p.insertBefore(node, next);
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc, 3, '#text');
    this.nodeValue = String(data);
  }

  get textContent() {
    return this.nodeValue;
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc, tag === '#fragment' ? 11 : 1, tag === '#fragment' ? '#document-fragment' : tag.toUpperCase());
    this.attrs = new Map();
    if (tag === 'template') this.content = new FakeElement(doc, '#fragment');
  }

  get tagName() {
    return this.nodeName;
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  getAttributeNames() {
    return [...this.attrs.keys()];
  }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }

  get hidden() {
    return this.attrs.has('hidden');
  }

  set hidden(on) {
    if (on) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }

  get disabled() {
    return this.attrs.has('disabled');
  }

  set disabled(on) {
    if (on) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }

  /** Drawn when in the document and neither it nor what holds it is hidden. */
  getClientRects() {
    if (!this.isConnected) return [];
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.attrs.has('hidden')) return [];
    return [{}];
  }

  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    doc.focusMoves++;
  }

  matches(selector) {
    return selector.split(',').some((s) => matchOne(this, s.trim()));
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  set innerHTML(html) {
    const into = this.content ?? this;
    for (const c of [...into.childNodes]) c.remove();
    const doc = this.ownerDocument;
    let at = into;
    const parser = new Parser({
      onopentag(name, attrs) {
        const el = new FakeElement(doc, name);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        at.appendChild(el);
        if (!VOID.has(name)) at = el;
      },
      ontext(text) {
        at.appendChild(new FakeText(doc, text));
      },
      onclosetag(name) {
        if (!VOID.has(name) && at !== into) at = at.parentNode;
      },
    }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
    parser.write(html);
    parser.end();
  }
}

/** One compound selector: a tag, then classes, [attr], :disabled, :not(:disabled), :focus-visible. */
function matchOne(el, sel) {
  let rest = sel;
  const take = (re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  let m;
  if ((m = take(/^[a-z][\w-]*/i)) && el.nodeName !== m[0].toUpperCase()) return false;
  while (rest) {
    if ((m = take(/^\.([\w-]+)/))) {
      if (!(el.getAttribute('class') ?? '').split(/\s+/).includes(m[1])) return false;
    } else if ((m = take(/^\[([\w-]+)\]/))) {
      if (!el.hasAttribute(m[1])) return false;
    } else if (take(/^:not\(:disabled\)/)) {
      if (el.disabled) return false;
    } else if (take(/^:disabled/)) {
      if (!el.disabled) return false;
    } else if (take(/^:focus-visible/)) {
      if (el.ownerDocument.activeElement !== el || !el.ownerDocument.keyboard) return false;
    } else {
      throw new Error(`focus-dom: a selector it does not know: ${sel}`);
    }
  }
  return true;
}

/**
 * A document with a <body>, its focus on the body. `keyboard`: whether the focus is given by the
 * keyboard (then the focused element matches :focus-visible, as in a browser after a key); false,
 * as after a click. `focusMoves` counts the focus moved from one element to another.
 */
export function focusDocument() {
  const doc = { activeElement: null, keyboard: true, focusMoves: 0 };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.documentElement = new FakeElement(doc, 'html');
  doc.body = new FakeElement(doc, 'body');
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  return doc;
}
