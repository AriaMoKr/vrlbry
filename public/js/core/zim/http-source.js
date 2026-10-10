// A ZIM byte source over HTTP range requests (ZimArchive.open(url); milestone 3, SPEC §2.6):
// reads a remote ZIM, a Kiwix mirror's say, a few bytes at a time, never whole. Works in browsers
// (the server must allow CORS, as mirror.download.kiwix.org does) and on Node (which has fetch).
//
// Only the `Range` header is sent: Kiwix's mirror allows no other in a CORS request (not
// `If-Range`), so a file replaced mid-session (a new edition at the same URL) is caught after the
// fact instead: every answer's total size (Content-Range) and Last-Modified must match the first.
//
// A browser keeps range answers in its HTTP cache, but once it holds a URL it serializes range
// requests on it: 8 reads at once took 1.3 s instead of 0.17 s (Chrome and Quest Browser, the
// Kiwix mirror). So a request made while others run bypasses the cache (`no-store`); one on its
// own (an open, a binary search's step) uses it, and the next visit is served from it.
// Once the file changed on the server, though, the cache answers for the old version (GitHub
// Pages keeps answers fresh for 10 minutes and re-uploads the site's identical ZIM files with
// each deploy, new dates and tags and all: the site's files failed to open just after one).
// Chrome completes a range it holds part of with `If-Range` and the old version's tag, and the
// server rightly sends the whole new file (200); or Chrome answers a 206 shorter than it says.
// So the probe, which decides the edition, always goes past the cache, and a cached answer that
// is whole, short or of another edition is asked again past it before it counts: only an answer
// from the server itself says the file changed.
//
// Through a proxy (`via`, optional: tools/zim-proxy/, which reads the mirror nearest the visitor):
// the same reads go there first, and on the first failure (unreachable, an error, no ranges, a
// wrong answer) to the file's own address for good. The source stays the file's (`url`, its name,
// the edition checked against the first answer): the block cache and the page see no difference.

/** Thrown for what an HTTP source cannot do: no ranges, a changed file, a failing server. */
export class HttpSourceError extends Error {
  constructor(message, { status = null, cause, edition = false } = {}) {
    super(message, { cause });
    this.status = status;
    /** True when the file changed on the server (another edition): reading it elsewhere would not help. */
    this.edition = edition;
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parses `bytes <start>-<end>/<total>` (total may be `*`). */
function contentRange(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header ?? '').trim());
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) } : null;
}

/** A file name for messages: the URL's last path segment, decoded. */
function nameOf(url) {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'archive.zim';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export class HttpSource {
  /**
   * Opens a URL: one small ranged read learns its size and that ranges work.
   * @param {string} url
   * @param {{ fetch?: typeof fetch, maxInFlight?: number, retries?: number, timeoutMs?: number,
   *   via?: string|null, onFallback?: (err: Error) => void }} [opts]
   *   fetch: for tests; maxInFlight: requests at once (browsers allow 6 per host over HTTP/1.1);
   *   retries: per read, on network errors, timeouts and 408/429/5xx, with growing waits; via: the
   *   same file through a proxy, read first (the open's probe once, a read twice, then `url` for
   *   good); onFallback: called once, when the proxy is given up
   * @returns {Promise<HttpSource>}
   * @throws {HttpSourceError} when the server does not serve ranges or the file is not there
   */
  static async open(url, opts = {}) {
    const source = new HttpSource(String(url), opts);
    await source._probe();
    return source;
  }

  constructor(url, {
    fetch: fetchImpl = globalThis.fetch, maxInFlight = 6, retries = 3, timeoutMs = 30000, via = null, onFallback = null,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new HttpSourceError('no fetch() here');
    this.url = url;
    this.name = nameOf(url);
    this.size = 0;
    /** Last-Modified of the first answer: every later one must match (the same edition). */
    this.lastModified = null;
    /** The proxy read through, or null (none, or given up: `viaError` says why). */
    this.via = via ? String(via) : null;
    this.viaError = null;
    /** Reads made (`viaReads` of them through the proxy) and bytes received (for measurements). */
    this.stats = { reads: 0, bytes: 0, retries: 0, viaReads: 0, uncached: 0 }; // uncached: asked again past the browser cache
    this._onFallback = onFallback;
    // Called as a plain function: a browser's fetch throws "Illegal invocation" when called as
    // another object's method (this._fetch(…)).
    this._fetch = (input, init) => fetchImpl(input, init);
    this._retries = retries;
    this._timeoutMs = timeoutMs;
    this._max = Math.max(1, maxInFlight);
    this._running = 0;
    this._queue = [];
    this._closed = false;
    this._abort = new AbortController();
  }

  async _probe() {
    // The ZIM header's first bytes: a server that ignores Range answers 200 with the whole file
    // (gigabytes), which is cancelled at once.
    let { bytes, range, total } = await this._get(0, 80, { probe: true });
    if (this.via && !(total ?? range?.total)) { // a proxy that hides the size: the file's own address may not
      this._giveUpVia(this.via, new HttpSourceError(`${this.name}: the proxy does not say how big the file is`));
      ({ bytes, range, total } = await this._get(0, 80, { probe: true }));
    }
    this.size = total ?? range?.total ?? null;
    if (!this.size) throw new HttpSourceError(`${this.name}: the server does not say how big the file is`);
    if (bytes.length === 0) throw new HttpSourceError(`${this.name}: the file is empty`);
  }

  /** `length` bytes at `position`, fewer at the end of the file. */
  async read(position, length) {
    const end = Math.min(this.size, position + length);
    if (end <= position) return new Uint8Array(0);
    return (await this._get(position, end - position)).bytes;
  }

  async close() {
    this._closed = true;
    this._abort.abort();
    for (const waiter of this._queue.splice(0)) waiter.reject(new HttpSourceError(`${this.name}: closed`));
  }

  /** A slot among maxInFlight requests at once. */
  async _slot() {
    if (this._running < this._max) {
      this._running++;
      return;
    }
    await new Promise((resolve, reject) => this._queue.push({ resolve, reject }));
    this._running++;
  }

  _release() {
    this._running--;
    this._queue.shift()?.resolve();
  }

  /** One ranged GET with retries, through the proxy while there is one: { bytes, range, total }. */
  async _get(position, length, { probe = false } = {}) {
    if (this._closed) throw new HttpSourceError(`${this.name}: closed`);
    await this._slot();
    try {
      const via = this.via;
      if (via) {
        try {
          const got = await this._attempts(via, position, length, probe, probe ? 0 : 1);
          this.stats.viaReads++;
          return got;
        } catch (err) {
          // Whatever went wrong there, the file's own address may do better, unless the file
          // itself changed (or this source is closed).
          if (this._closed || err.edition) throw err;
          this._giveUpVia(via, err);
        }
      }
      return await this._attempts(this.url, position, length, probe, this._retries);
    } finally {
      this._release();
    }
  }

  async _attempts(target, position, length, probe, retries) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._once(target, position, length, probe);
      } catch (err) {
        // Network errors and timeouts (also while the body arrives) are tried again; a closed
        // source, a refusal or a changed file are not.
        const retry = !this._closed && attempt < retries && (err.retry || !(err instanceof HttpSourceError));
        if (!retry) throw err instanceof HttpSourceError ? err : new HttpSourceError(`${this.name}: ${err.message}`, { cause: err });
        this.stats.retries++;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  _giveUpVia(via, err) {
    if (this.via !== via) return; // another read gave it up first
    this.via = null;
    this.viaError = err.message;
    try {
      this._onFallback?.(err);
    } catch {
      // the caller's
    }
  }

  async _once(target, position, length, probe, fresh = probe) {
    // Closed meanwhile (close() may come between a read's call and its request): no request.
    if (this._closed) throw new HttpSourceError(`${this.name}: closed`);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this._timeoutMs);
    const onClose = () => timeout.abort();
    this._abort.signal.addEventListener('abort', onClose);
    try {
      let res;
      try {
        res = await this._fetch(target, {
          headers: { Range: `bytes=${position}-${position + length - 1}` },
          signal: timeout.signal,
          // Others running (this one counts too): past the browser's cache, which would queue it.
          ...(fresh || this._running > 1 ? { cache: 'no-store' } : {}),
        });
      } catch (err) {
        if (this._closed) throw new HttpSourceError(`${this.name}: closed`, { cause: err });
        // A timeout or a network error: worth another try. (A browser reports a CORS refusal
        // as the same TypeError: after the retries, say what it may be.)
        throw Object.assign(new HttpSourceError(`${this.name}: cannot reach the server (${err.message}); `
          + 'if it is another site, it may not allow this page to read it (CORS)', { cause: err }), { retry: true });
      }
      if (res.status === 200) {
        await res.body?.cancel().catch(() => {});
        // From the browser's cache, a changed file's whole (see the top): ask past it.
        if (!fresh) return this._again(target, position, length, probe);
        throw new HttpSourceError(probe ? `${this.name}: the server does not serve parts of the file (no range requests)`
          : `${this.name}: the server sent the whole file instead of a part`, { status: 200 });
      }
      if (res.status !== 206) {
        await res.body?.cancel().catch(() => {});
        const err = new HttpSourceError(`${this.name}: HTTP ${res.status}${res.status === 404 ? ' (not found)' : ''}`, { status: res.status });
        if (RETRY_STATUS.has(res.status)) err.retry = true;
        throw err;
      }
      const range = contentRange(res.headers.get('content-range'));
      const modified = res.headers.get('last-modified');
      if (probe) this.lastModified = modified;
      else {
        const sized = range?.total != null && range.total !== this.size;
        const dated = modified && this.lastModified && modified !== this.lastModified;
        // The browser's cache may still hold the edition before (see the top): ask past it.
        if ((sized || dated) && !fresh) {
          await res.body?.cancel().catch(() => {});
          return this._again(target, position, length, probe);
        }
        if (sized) {
          throw new HttpSourceError(`${this.name}: the file changed on the server (its size is now ${range.total} bytes): open it again`, { edition: true });
        }
        if (dated) {
          throw new HttpSourceError(`${this.name}: the file changed on the server (modified ${modified}): open it again`, { edition: true });
        }
      }
      if (range && range.start !== position) {
        throw new HttpSourceError(`${this.name}: the server answered bytes from ${range.start}, not ${position}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (this._closed) throw new HttpSourceError(`${this.name}: closed`);
      // As many bytes as asked for (or as the file has from there), else the browser's cache
      // pieced together what it could (see the top): ask past it, and again later if it persists.
      const want = range ? range.end - range.start + 1 : this.size ? Math.min(length, this.size - position) : bytes.length;
      if (bytes.length !== want) {
        if (!fresh) return this._again(target, position, length, probe);
        throw Object.assign(new HttpSourceError(`${this.name}: ${bytes.length} bytes came instead of ${want}`), { retry: true });
      }
      this.stats.reads++;
      this.stats.bytes += bytes.length;
      // The probe's total: Content-Range when the page may read it, else a HEAD's length.
      let total = range?.total ?? null;
      if (probe && total == null) total = await this._headLength(target);
      return { bytes, range, total };
    } finally {
      clearTimeout(timer);
      this._abort.signal.removeEventListener('abort', onClose);
    }
  }

  /** _once again, past the browser's cache (this attempt's timer is cleared as it returns). */
  _again(target, position, length, probe) {
    this.stats.uncached++;
    return this._once(target, position, length, probe, true);
  }

  /** The file's size from a HEAD request (Content-Length is readable across origins). */
  async _headLength(target) {
    const res = await this._fetch(target, { method: 'HEAD', signal: this._abort.signal }).catch(() => null);
    const n = Number(res?.headers.get('content-length'));
    return res?.ok && Number.isFinite(n) && n > 0 ? n : null;
  }
}
