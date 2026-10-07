// ZIP + EPUB parsing (SPEC §3.4), used for books whose only readable form is an EPUB.

import { platform } from '../platform.js';
import { u16, u32 } from '../util/bytes.js';
import { resolveHref } from './html.js';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes, flags) {
  // Bit 11 = UTF-8 names. Many tools write UTF-8 without the flag, so try it before CP437/latin1.
  if (flags & 0x800) return platform.utf8(bytes);
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return platform.latin1(bytes);
  }
}

/**
 * Minimal ZIP reader: central directory, methods 0 (store) and 8 (deflate). ZIP64 and
 * encryption are not supported (clear errors).
 * @param {Uint8Array} buf the whole archive
 * @returns {{ names: string[], has(name: string): boolean, get(name: string): Uint8Array|null }}
 */
export function readZip(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('readZip expects bytes (a Uint8Array)');
  if (buf.length < 22) throw new Error('Not a ZIP file (too short)');
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf[i] === 0x50 && u32(buf, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end of central directory not found)');
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  // Data prepended to the archive (self-extractors) shifts every stored offset by the same amount.
  const shift = eocd - cdSize - cdOffset;
  if (shift < 0) throw new Error('Corrupt ZIP (central directory out of range)');

  const entries = new Map();
  let p = cdOffset + shift;
  const end = eocd;
  while (p + 46 <= end && u32(buf, p) === SIG_CEN) {
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42) + shift;
    if (p + 46 + nameLen > end) throw new Error('Corrupt ZIP central directory');
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory
    if (!entries.has(name)) entries.set(name, { flags, method, csize, usize, local });
  }
  if (entries.size === 0 && total > 0) throw new Error('Corrupt ZIP central directory');

  function get(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (e.local + 30 > buf.length || u32(buf, e.local) !== SIG_LOC) {
      throw new Error(`Corrupt ZIP local header for ${name}`);
    }
    if (e.flags & 1) throw new Error(`Encrypted ZIP entry not supported: ${name}`);
    // Sizes come from the central directory: with a data descriptor (flag bit 3) the local
    // header carries zeros.
    const start = e.local + 30 + u16(buf, e.local + 26) + u16(buf, e.local + 28);
    if (start + e.csize > buf.length) throw new Error(`Truncated ZIP entry: ${name}`);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return platform.inflateRaw(data);
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    get,
  };
}

// ---------------------------------------------------------------------------------------------

const EXT_MIME = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  css: 'text/css', js: 'text/javascript', txt: 'text/plain', ncx: 'application/x-dtbncx+xml',
  opf: 'application/oebps-package+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4',
};

const XHTML_MIMES = new Set(['application/xhtml+xml', 'text/html', 'application/xml', 'text/xml']);

function extMime(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT_MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** Decodes an (X)HTML/XML document: BOM, then XML declaration / meta charset, else UTF-8. */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return platform.utf8(buf, 3);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = platform.latin1(buf, 0, Math.min(buf.length, 1024));
  const m = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) ||
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  const label = m ? m[1].toLowerCase() : 'utf-8';
  if (label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      // unknown label: fall back to UTF-8
    }
  }
  return platform.utf8(buf);
}

function localName(tag) {
  const i = tag.lastIndexOf(':');
  return (i >= 0 ? tag.slice(i + 1) : tag).toLowerCase();
}

function clean(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Parses container.xml → first OPF rootfile path. */
function findRootfile(xml) {
  let found = null;
  let fallback = null;
  const p = new platform.Parser({
    onopentag(name, a) {
      if (localName(name) !== 'rootfile' || !a['full-path']) return;
      const type = (a['media-type'] || '').toLowerCase();
      if (!found && type === 'application/oebps-package+xml') found = a['full-path'];
      if (!fallback) fallback = a['full-path'];
    },
  }, { xmlMode: true, decodeEntities: true });
  p.end(xml);
  return found ?? fallback;
}

/** Parses the OPF package document. */
function parseOpf(xml) {
  const meta = { title: null, creators: [], language: null };
  const roles = new Map(); // EPUB 3 `<meta refines="#id" property="role">`
  const manifest = new Map(); // id → { href, type, properties }
  const spine = []; // { idref, linear }
  let section = null;
  let capture = null; // { kind, id, role, text }
  let refine = null;
  const p = new platform.Parser({
    onopentag(name, a) {
      const ln = localName(name);
      if (ln === 'metadata' || ln === 'manifest' || ln === 'spine') {
        section = ln;
        return;
      }
      if (section === 'metadata') {
        if (ln === 'title' || ln === 'creator' || ln === 'language') {
          capture = { kind: ln, id: a.id, role: a['opf:role'] ?? a.role ?? null, text: '' };
        } else if (ln === 'meta' && a.refines && a.property === 'role') {
          refine = { id: a.refines.replace(/^#/, ''), text: '' };
        }
      } else if (section === 'manifest' && ln === 'item' && a.id && a.href) {
        manifest.set(a.id, { href: a.href, type: (a['media-type'] || '').toLowerCase(), properties: a.properties || '' });
      } else if (section === 'spine' && ln === 'itemref' && a.idref) {
        spine.push({ idref: a.idref, linear: (a.linear || 'yes').toLowerCase() !== 'no' });
      }
    },
    ontext(t) {
      if (capture) capture.text += t;
      else if (refine) refine.text += t;
    },
    onclosetag(name) {
      const ln = localName(name);
      if (capture && ln === capture.kind) {
        const text = clean(capture.text);
        if (text) {
          if (ln === 'title' && !meta.title) meta.title = text;
          else if (ln === 'language' && !meta.language) meta.language = text;
          else if (ln === 'creator') meta.creators.push({ text, id: capture.id, role: capture.role });
        }
        capture = null;
      } else if (refine && ln === 'meta') {
        roles.set(refine.id, refine.text.trim().toLowerCase());
        refine = null;
      } else if (ln === section) {
        section = null;
      }
    },
  }, { xmlMode: true, decodeEntities: true });
  p.end(xml);
  for (const c of meta.creators) {
    if (!c.role && c.id && roles.has(c.id)) c.role = roles.get(c.id);
  }
  return { meta, manifest, spine };
}

function isXhtml(path, type) {
  return XHTML_MIMES.has(type) || /\.(x?html?|xht)$/i.test(path);
}

/** True for a Project Gutenberg cover wrapper page (only an image/SVG, no text). */
function isCoverWrapper(id, path, html) {
  if (id !== 'coverpage-wrapper' && !/(^|\/)wrap\d+\.x?html?$/i.test(path)) return false;
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<(svg|script|style)[\s\S]*?<\/\1>/gi, '');
  return !/[^\s\u00a0]/.test(body.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ''));
}

/**
 * Parses an EPUB 2/3: META-INF/container.xml → OPF → metadata (dc:title, dc:creator,
 * dc:language) + manifest + spine.
 * Paths are zip-root-relative and normalized. Throws on a non-zip or a missing OPF; missing
 * optional pieces (title, creator, a spine document) never throw.
 * @param {Uint8Array} buf the .epub file
 * @returns {{ title: string|null, author: string|null, language: string|null,
 *   docs: Array<{ path: string, html: string }>, getFile(path: string): Uint8Array|null,
 *   mimeOf(path: string): string }}
 */
export function parseEpub(buf) {
  const zip = readZip(buf);
  const lower = new Map();
  for (const n of zip.names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);
  const actual = (path) => {
    if (!path) return null;
    if (zip.has(path)) return path;
    return lower.get(path.toLowerCase()) ?? null;
  };

  let opfPath = null;
  const containerName = actual('META-INF/container.xml');
  if (containerName) {
    const rootfile = findRootfile(decodeText(zip.get(containerName)));
    if (rootfile) opfPath = actual(resolveHref(rootfile, '') ?? rootfile);
  }
  if (!opfPath) opfPath = zip.names.find((n) => /\.opf$/i.test(n)) ?? null;
  if (!opfPath) throw new Error('Invalid EPUB: no OPF package document found');

  const { meta, manifest, spine } = parseOpf(decodeText(zip.get(opfPath)));

  const mimeByPath = new Map();
  const items = new Map(); // id → { path, type }
  for (const [id, item] of manifest) {
    const resolved = resolveHref(item.href, opfPath);
    if (!resolved || resolved.startsWith('data:')) continue;
    const path = actual(resolved) ?? resolved;
    items.set(id, { id, path, type: item.type });
    if (item.type) mimeByPath.set(path, item.type);
  }

  let refs = spine.filter((s) => s.linear);
  if (!refs.some((s) => items.has(s.idref))) refs = spine; // everything non-linear: read it all
  const docs = [];
  const seen = new Set();
  for (const ref of refs) {
    const item = items.get(ref.idref);
    if (!item || seen.has(item.path) || !isXhtml(item.path, item.type)) continue;
    seen.add(item.path);
    const data = zip.has(item.path) ? zip.get(item.path) : null;
    if (!data) continue; // listed but missing: skip rather than fail the whole book
    const html = decodeText(data);
    if (isCoverWrapper(item.id, item.path, html)) continue;
    docs.push({ path: item.path, html });
  }

  const authors = meta.creators.filter((c) => !c.role || c.role === 'aut');
  const author = (authors.length ? authors : meta.creators).map((c) => c.text);

  return {
    title: meta.title,
    author: author.length ? author.join(', ') : null,
    language: meta.language,
    docs,
    getFile(path) {
      if (typeof path !== 'string') return null;
      let name = actual(path.replace(/^\/+/, ''));
      if (!name && path.includes('%')) {
        try {
          name = actual(decodeURIComponent(path.replace(/^\/+/, '')));
        } catch {
          name = null;
        }
      }
      return name ? zip.get(name) : null;
    },
    mimeOf(path) {
      return mimeByPath.get(path) ?? mimeByPath.get(actual(path) ?? '') ?? extMime(path);
    },
  };
}
