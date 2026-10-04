/**
 * HTTP request handler: the JSON API, raw ZIM entries and static files (SPEC §3.7, §4).
 *
 * Paths are split and percent-decoded segment by segment from the raw request URL. The WHATWG
 * URL parser is deliberately not used for routing: it resolves '..' and '%2e%2e' before we could
 * see them, which would hide traversal attempts and could map them onto other routes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { LibraryError } from './library.js';

const gzipAsync = promisify(zlib.gzip);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Default static roots: the client and the two vendored packages (§4). */
export const DEFAULT_PUBLIC_DIR = path.join(ROOT, 'public');
export const DEFAULT_VENDOR_DIRS = Object.freeze({
  three: path.join(ROOT, 'node_modules', 'three'),
  iwer: path.join(ROOT, 'node_modules', 'iwer', 'build'),
});

const JSON_TYPE = 'application/json; charset=utf-8';
/** JSON bodies below this size are not worth compressing. */
const GZIP_MIN_BYTES = 1024;
const ZIM_CACHE = 'public, max-age=86400';
const VENDOR_CACHE = 'public, max-age=604800';

/** MIME types for static files, by lowercase extension. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
});

/** Thrown for malformed requests (bad percent-encoding, traversal); answered with 400. */
class BadRequest extends Error {}

/**
 * Creates the request handler.
 * @param {import('./library.js').Library} library
 * @param {object} [opts]
 * @param {string} [opts.publicDir] client files (default: <project>/public)
 * @param {Record<string, string>} [opts.vendorDirs] `/vendor/<name>/*` → directory
 *   (default: three → node_modules/three, iwer → node_modules/iwer/build)
 * @param {(msg: string) => void} [opts.log=console.error] error log
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createApp(library, { publicDir = DEFAULT_PUBLIC_DIR, vendorDirs = DEFAULT_VENDOR_DIRS, log = console.error } = {}) {
  const publicRoot = path.resolve(publicDir);
  const vendorRoots = new Map(Object.entries(vendorDirs).map(([k, v]) => [k, path.resolve(v)]));
  // Serialized JSON (+ gzip, + ETag) of long-lived objects: book lists and reading metadata.
  const serialized = new WeakMap();

  const serialize = (value) => {
    let s = typeof value === 'object' && value !== null ? serialized.get(value) : undefined;
    if (!s) {
      s = new Body(Buffer.from(JSON.stringify(value), 'utf8'));
      if (typeof value === 'object' && value !== null) serialized.set(value, s);
    }
    return s;
  };

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const { segments, trailingSlash } = parsePath(req.url);
    const area = segments[0];
    // The one state-changing endpoint: re-read the ZIM folder (harmless if triggered by anyone).
    if (req.method === 'POST' && area === 'api' && segments[1] === 'rescan' && segments.length === 2) {
      const result = await library.rescan();
      const libraries = await Promise.all(library.list().map((l) => l.info()));
      return sendBody(req, res, serialize({ ...result, libraries }), { cacheControl: 'no-store' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      if (area === 'api' || area === 'zim') return sendError(req, res, 405, 'method not allowed');
      return sendText(req, res, 405, 'Method not allowed');
    }
    if (area === 'api') return api(req, res, segments.slice(1));
    if (area === 'zim') return zim(req, res, segments.slice(1));
    if (area === 'vendor') {
      const root = vendorRoots.get(segments[1]);
      if (!root || segments.length < 3) return sendText(req, res, 404, 'Not found');
      return serveFile(req, res, root, segments.slice(2), {
        trailingSlash, cacheControl: VENDOR_CACHE, urlPrefix: `/vendor/${encodeURIComponent(segments[1])}`,
      });
    }
    return serveFile(req, res, publicRoot, segments, { trailingSlash, cacheControl: 'no-cache', isRoot: true, urlPrefix: '' });
  }

  // ------------------------------------------------------------------------------------------
  // /api

  async function api(req, res, segs) {
    if (segs.length && segs[segs.length - 1] === '' && segs.length > 1) segs = segs.slice(0, -1);
    if (segs[0] === 'rescan' && segs.length === 1) {
      res.setHeader('Allow', 'POST');
      return sendError(req, res, 405, 'use POST to rescan');
    }
    if (segs[0] === 'version' && segs.length === 1) {
      const newest = await newestClientFile(publicRoot);
      return sendBody(req, res, serialize({
        changed: newest ? new Date(newest.mtimeMs).toISOString() : null,
        file: newest ? path.relative(publicRoot, newest.path).split(path.sep).join('/') : null,
      }), { cacheControl: 'no-store' });
    }
    if (segs[0] !== 'libraries') return sendError(req, res, 404, 'unknown API endpoint');
    if (segs.length === 1) {
      const libraries = await Promise.all(library.list().map((l) => l.info()));
      return sendBody(req, res, serialize({ generation: library.generation ?? 0, libraries }), { cacheControl: 'no-cache' });
    }
    const lib = library.get(segs[1]);
    if (segs.length < 3 || segs[2] !== 'books') return sendError(req, res, 404, 'unknown API endpoint');
    if (!lib) return sendError(req, res, 404, `unknown library: ${segs[1]}`);

    if (segs.length === 3) {
      const books = await lib.books();
      let wrapper = serialized.get(books);
      if (!wrapper) {
        wrapper = new Body(Buffer.from(JSON.stringify({ library: lib.id, books }), 'utf8'));
        serialized.set(books, wrapper);
      }
      return sendBody(req, res, wrapper, { cacheControl: 'no-cache' });
    }

    const bookId = segs[3];
    const book = await lib.book(bookId);
    if (!book) return sendError(req, res, 404, `unknown book: ${bookId}`);

    if (segs.length === 4) {
      const content = await lib.content(bookId);
      return sendBody(req, res, serialize(content.meta), { cacheControl: 'no-cache' });
    }

    if (segs[4] === 'chunks' && segs.length === 6) {
      const raw = segs[5];
      if (!/^\d{1,9}$/.test(raw)) return sendError(req, res, 400, `invalid chunk index: ${raw}`);
      const content = await lib.content(bookId);
      const n = Number(raw);
      const chunk = content.chunks[n];
      if (!chunk) return sendError(req, res, 404, `chunk ${n} out of range (0..${content.chunks.length - 1})`);
      return sendBody(req, res, new Body(chunk.json, { etag: `W/${chunk.etag}`, gzip: () => chunk.gzip() }), { cacheControl: 'no-cache' });
    }

    if (segs[4] === 'res' && segs.length >= 6) {
      const filePath = segs.slice(5).join('/');
      const found = await lib.resource(bookId, filePath);
      if (!found) return sendError(req, res, 404, `no such resource: ${filePath}`);
      const etag = `"${lib.archive.header.uuid}-${bookId}-${shortHash(filePath)}"`;
      return sendRaw(req, res, found.data, { type: withCharset(found.mime), etag, cacheControl: ZIM_CACHE });
    }
    return sendError(req, res, 404, 'unknown API endpoint');
  }

  // ------------------------------------------------------------------------------------------
  // /zim/:lib/<ns>/<url>

  async function zim(req, res, segs) {
    const lib = library.get(segs[0]);
    if (!lib) return sendError(req, res, 404, `unknown library: ${segs[0] ?? ''}`);
    const archivePath = segs.slice(1).join('/');
    const { archive } = lib;
    const entry = segs.length >= 3 ? await archive.findPath(archivePath) : null;
    if (!entry) return sendError(req, res, 404, `no such entry: ${archivePath}`);
    const target = await archive.resolveRedirect(entry);
    if (target.cluster === null) return sendError(req, res, 404, `entry has no content: ${archivePath}`);
    const etag = `"${archive.header.uuid}-${target.index}"`;
    // Answer revalidations before touching the content (which may need a decompression).
    if (notModified(req, etag)) return send304(res, etag, ZIM_CACHE);
    const content = await archive.getContent(target);
    if (!content) return sendError(req, res, 404, `entry has no content: ${archivePath}`);
    return sendRaw(req, res, content.data, { type: withCharset(content.mime), etag, cacheControl: ZIM_CACHE });
  }

  // ------------------------------------------------------------------------------------------
  // Static files

  async function serveFile(req, res, root, segs, { trailingSlash, cacheControl, isRoot = false, urlPrefix }) {
    const parts = segs.filter((s) => s !== '');
    for (const seg of parts) {
      // Decoded segments must be plain names: no traversal, no separators (either OS), no drive
      // letters / NTFS streams, no NULs, no dotfiles.
      if (seg === '.' || seg === '..' || /[/\\:\0]/.test(seg)) throw new BadRequest(`invalid path segment: ${seg}`);
      if (seg.startsWith('.')) return sendText(req, res, 404, 'Not found');
    }
    if (parts.length === 0 || trailingSlash) parts.push('index.html');
    let file = path.join(root, ...parts);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new BadRequest('path outside the served directory');

    let stat = await fs.promises.stat(file).catch(() => null);
    if (stat && stat.isDirectory()) {
      // '/dev' → '/dev/': relative links inside dev/index.html must resolve inside the folder.
      // The target is rebuilt from the validated segments (never echoed from the raw URL, which
      // could turn '//host' into an open redirect); the query string is kept.
      if (!trailingSlash) {
        const q = req.url.indexOf('?');
        const location = `${urlPrefix}/${parts.map(encodeURIComponent).join('/')}/${q >= 0 ? req.url.slice(q) : ''}`;
        return sendRedirect(req, res, location);
      }
      file = path.join(file, 'index.html');
      stat = await fs.promises.stat(file).catch(() => null);
    }
    if (!stat || !stat.isFile()) {
      if (isRoot && parts.length === 1 && parts[0] === 'index.html') {
        return sendText(req, res, 404, 'vrlbry: public/index.html not found (the client is not installed).');
      }
      return sendText(req, res, 404, 'Not found');
    }
    const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (notModified(req, etag)) return send304(res, etag, cacheControl);

    const range = parseRange(req, stat.size, etag);
    if (range === 'unsatisfiable') return send416(res, stat.size);
    const [start, end] = range ?? [0, stat.size - 1];
    res.statusCode = range ? 206 : 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    if (req.method === 'HEAD' || stat.size === 0) return void res.end();
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', (err) => {
        log(`static ${file}: ${err.message}`);
        res.destroy(err);
        resolve();
      });
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Responses

  async function sendBody(req, res, body, { cacheControl }) {
    const etag = body.etag;
    if (notModified(req, etag)) return send304(res, etag, cacheControl, true);
    let data = body.json;
    const gzip = data.length >= GZIP_MIN_BYTES && acceptsGzip(req);
    if (gzip) data = await body.gzip();
    res.statusCode = 200;
    res.setHeader('Content-Type', JSON_TYPE);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  return function handler(req, res) {
    handle(req, res).catch((err) => {
      const bad = err instanceof BadRequest;
      const status = bad ? 400 : err instanceof LibraryError ? err.status : 500;
      if (status >= 500) log(`${req.method} ${req.url}: ${err?.stack ?? err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Headers set for the failed response (type, length, ETag…) must not leak into the error.
      for (const name of res.getHeaderNames()) if (name !== 'x-content-type-options') res.removeHeader(name);
      const message = status >= 500 ? `internal error: ${err?.message ?? err}` : err.message;
      sendError(req, res, status, message);
    });
  };
}

/** A JSON body with lazily computed gzip and ETag. */
class Body {
  constructor(json, { etag, gzip } = {}) {
    this.json = json;
    this._etag = etag ?? null;
    this._gzipFn = gzip ?? null;
    this._gzip = null;
  }

  get etag() {
    this._etag ??= `W/"${crypto.createHash('sha1').update(this.json).digest('base64url')}"`;
    return this._etag;
  }

  gzip() {
    if (!this._gzip) {
      this._gzip = this._gzipFn ? this._gzipFn() : gzipAsync(this.json, { level: 6 });
      this._gzip.catch(() => { this._gzip = null; });
    }
    return this._gzip;
  }
}

/**
 * Splits a raw request target into percent-decoded path segments (first segment after '/').
 * @param {string} url raw `req.url`
 * @returns {{ segments: string[], trailingSlash: boolean }}
 * @throws {BadRequest} on malformed percent-encoding or a target that is not a path
 */
function parsePath(url) {
  let raw = url || '/';
  // Absolute-form targets (from proxies) carry the origin in front of the path.
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(raw);
  if (abs) raw = raw.slice(abs[0].length) || '/';
  const cut = raw.search(/[?#]/);
  if (cut >= 0) raw = raw.slice(0, cut);
  if (!raw.startsWith('/')) throw new BadRequest('request target must be a path');
  const segments = raw.slice(1).split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      throw new BadRequest(`malformed percent-encoding in ${JSON.stringify(seg)}`);
    }
  });
  return { segments, trailingSlash: raw.length > 1 && raw.endsWith('/') };
}

function withCharset(mime) {
  const type = mime || 'application/octet-stream';
  return /^text\//i.test(type) && !/;\s*charset=/i.test(type) ? `${type}; charset=utf-8` : type;
}

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('base64url').slice(0, 16);
}

/** True when the request's Accept-Encoding allows gzip (q-values honoured). */
function acceptsGzip(req) {
  const header = req.headers['accept-encoding'];
  if (!header) return false;
  let gzip = null;
  let star = null;
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (name === 'gzip' || name === 'x-gzip') gzip = Math.max(gzip ?? 0, q);
    else if (name === '*') star = q;
  }
  if (gzip !== null) return gzip > 0;
  return star !== null && star > 0;
}

/** If-None-Match handling with weak comparison (RFC 9110 §13.1.2). */
function notModified(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header || !etag) return false;
  if (header.trim() === '*') return true;
  const opaque = (t) => t.trim().replace(/^W\//, '');
  const want = opaque(etag);
  return header.split(',').some((t) => opaque(t) === want);
}

/**
 * A single `Range: bytes=` range → [start, end] (inclusive), null (serve everything), or
 * 'unsatisfiable'. Multiple ranges are answered with the whole body, which RFC 9110 allows.
 */
function parseRange(req, size, etag) {
  const header = req.headers.range;
  if (!header) return null;
  const ifRange = req.headers['if-range'];
  // If-Range with a validator that does not match (or any date, as we send no dates for
  // entries) means: send the whole, current representation.
  if (ifRange && (ifRange.trim() !== etag || etag.startsWith('W/'))) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null; // syntactically invalid: ignore
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return [start, end];
}

function sendRaw(req, res, data, { type, etag, cacheControl }) {
  if (notModified(req, etag)) return send304(res, etag, cacheControl);
  const size = data.length;
  const range = parseRange(req, size, etag);
  if (range === 'unsatisfiable') return send416(res, size);
  const [start, end] = range ?? [0, size - 1];
  const body = range ? data.subarray(start, end + 1) : data;
  res.statusCode = range ? 206 : 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  // Archive HTML/SVG is foreign content on our origin: never let its scripts run here.
  if (/^(text\/html|image\/svg|application\/xhtml|text\/xml|application\/xml)/i.test(type)) {
    res.setHeader('Content-Security-Policy', 'sandbox');
  }
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send304(res, etag, cacheControl, vary = false) {
  res.statusCode = 304;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  if (vary) res.setHeader('Vary', 'Accept-Encoding');
  res.end();
}

function send416(res, size) {
  res.statusCode = 416;
  res.setHeader('Content-Range', `bytes */${size}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Range not satisfiable');
}

/**
 * The most recently modified client file (dotfiles skipped), i.e. when the website last changed;
 * null for an empty folder. Walked on every request: the files change while the server runs.
 * @returns {Promise<{ path: string, mtimeMs: number }|null>}
 */
async function newestClientFile(dir) {
  let newest = null;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    const found = ent.isDirectory() ? await newestClientFile(p)
      : ent.isFile() ? { path: p, mtimeMs: (await fs.promises.stat(p)).mtimeMs } : null;
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
}

function sendError(req, res, status, message) {
  const body = Buffer.from(JSON.stringify({ error: message }), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_TYPE);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendRedirect(req, res, location) {
  const body = Buffer.from(`Moved to ${location}\n`, 'utf8');
  res.statusCode = 301;
  res.setHeader('Location', location);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-cache');
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(req, res, status, message) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : body);
}
