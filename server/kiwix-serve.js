// Full-text search through Kiwix's own server (kiwix-serve; optional: `--kiwix-serve <url>`). It
// searches the Xapian indexes inside ZIM files, which the library does not read itself. A library
// whose file kiwix-serve also serves (the same UUID) can be searched (§4, full-text search).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Text with XML/HTML character references decoded. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 32 hex digits as a UUID with dashes, as kiwix-serve names books. */
export function dashedUuid(hex) {
  const h = String(hex).replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

/**
 * A snippet's HTML (kiwix-serve marks hits with <b>) as [text, hit] parts, entities decoded and any
 * other markup dropped.
 * @returns {Array<[string, 0|1]>}
 */
export function snippetParts(html) {
  const parts = [];
  let hit = 0;
  for (const piece of String(html).split(/(<\/?b>)/i)) {
    if (/^<b>$/i.test(piece)) hit = 1;
    else if (/^<\/b>$/i.test(piece)) hit = 0;
    else {
      const text = decodeEntities(piece.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ');
      if (text) parts.push([text, hit]);
    }
  }
  return parts;
}

/**
 * kiwix-serve's search answer (format=xml: OpenSearch RSS) as { total, results }: each result's
 * title, its path in the ZIM (after /content/<book>/, decoded), snippet parts and word count.
 * @param {string} xml
 * @returns {{ total: number, results: Array<{ title: string, path: string, snippet: Array<[string, 0|1]>, words: number|null }> }}
 */
export function parseSearchXml(xml) {
  // Written with thousands separators, as the word counts are ("4,000"; an estimate when large).
  const total = Number((/totalResults>([^<]*)</.exec(xml)?.[1] ?? '').replace(/\D/g, '')) || 0;
  const results = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = decodeEntities(tag(item, 'link') ?? '');
    const m = /\/content\/[^/]+\/(.+)$/.exec(link);
    if (!m) continue;
    let path;
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      continue;
    }
    const words = tag(item, 'wordCount');
    results.push({
      title: decodeEntities(tag(item, 'title') ?? path).trim(),
      path,
      snippet: snippetParts(tag(item, 'description') ?? ''),
      words: words ? Number(words.replace(/\D/g, '')) || null : null,
    });
  }
  return { total, results };
}

/**
 * A client of the kiwix-serve at `base`.
 * @param {string} base e.g. 'http://<host>:8095/'
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, catalogMs?: number }} [opts] catalogMs: how
 *   long the list of the books it serves is trusted
 */
export function kiwixServe(base, { fetch = globalThis.fetch, timeoutMs = 10_000, catalogMs = 60_000 } = {}) {
  const root = base.endsWith('/') ? base : `${base}/`;
  let books = null;
  let booksAt = 0;
  let pending = null;

  async function get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`kiwix-serve answered ${res.status} for ${url}`);
    return res.text();
  }

  return {
    url: root,

    /**
     * The UUIDs (32 hex digits) of the books it serves, asked again after catalogMs; empty when it
     * cannot be reached (asked again on the next call).
     * @returns {Promise<Set<string>>}
     */
    books() {
      if (books && Date.now() - booksAt < catalogMs) return Promise.resolve(books);
      pending ??= get(`${root}catalog/v2/entries?count=-1`)
        .then((xml) => {
          books = new Set([...xml.matchAll(/<id>urn:uuid:([0-9a-f-]{36})<\/id>/gi)].map((m) => m[1].replace(/-/g, '').toLowerCase()));
          booksAt = Date.now();
          return books;
        }, () => new Set())
        .finally(() => { pending = null; });
      return pending;
    },

    /**
     * Full-text search of one book.
     * @param {string} uuid its UUID (32 hex digits)
     * @param {string} q
     * @param {{ start?: number, limit?: number }} [opts]
     */
    async search(uuid, q, { start = 0, limit = 10 } = {}) {
      const url = `${root}search?books.id=${dashedUuid(uuid)}&pattern=${encodeURIComponent(q)}&format=xml&start=${start}&pageLength=${limit}`;
      return parseSearchXml(await get(url));
    },
  };
}
