# vrlbry — specification

A WebXR virtual library. A Node.js server scans a directory (default: the current working
directory) for `*.zim` files, exposes their books over a small HTTP API, and serves a Three.js
WebXR client that shows the books on bookshelves in a 3D library room. You can browse the shelves,
pull a book out, look at its cover, open it and read it page by page — in a VR headset (Quest
etc.), on a desktop (mouse + keyboard), or on a phone (touch).

This document is the contract between modules. Section numbers are referenced from code comments.
If you must deviate, keep the deviation minimal and report it.

---

## 1. Ground rules

- **Runtime:** Node.js ≥ 22.15 (uses built-in `zlib.zstdDecompress`). ES modules everywhere
  (`"type": "module"`). No build step, no bundler, no TypeScript.
- **Dependencies (already installed):** `three@0.186` (client), `htmlparser2@12` (server HTML
  parsing), `selfsigned@5` (server `--https`), dev: `iwer@2.5` (WebXR emulation for testing).
  Do not add other runtime dependencies. Node built-ins only otherwise.
- **Client** is plain ES modules served from `public/`. Three.js is loaded through an import map:
  `"three": "/vendor/three/build/three.module.js"`, `"three/addons/": "/vendor/three/examples/jsm/"`.
  The app must work fully **offline** (no CDN fetches required; optional CDN fetches such as
  controller GLB models must degrade gracefully).
- **Tests:** `npm test` = `node --test "test/*.test.js"` (built-in `node:test` + `node:assert/strict`). Test files are
  `test/*.test.js`. Tests that need the real ZIM in the repo root must `skip` when it is absent.
- **Style:** small focused modules, JSDoc on exported functions, 2-space indent, single quotes,
  semicolons. Comment *why*, not *what*.
- **Platform:** must work on Windows, macOS, Linux (use `path`, never hard-coded separators).

## 2. Data source: ZIM files

### 2.1 ZIM format essentials (openZIM spec, versions 5 and 6.x)

Header (little-endian, 80 bytes): `magic u32 = 0x044D495A`, `major u16`, `minor u16`,
`uuid 16B`, `entryCount u32`, `clusterCount u32`, `urlPtrPos u64`, `titlePtrPos u64`,
`clusterPtrPos u64`, `mimeListPos u64`, `mainPage u32` (0xFFFFFFFF = none), `layoutPage u32`,
`checksumPos u64`.

- MIME list at `mimeListPos`: NUL-terminated strings, ended by an empty string.
- URL pointer list: `entryCount × u64` file offsets of directory entries, **sorted by
  namespace char then URL, byte-wise on UTF-8**. Exact lookup = binary search.
- Directory entry: `mimetype u16`, `parameterLen u8`, `namespace char`, `revision u32`, then
  - redirect (`mimetype == 0xFFFF`): `redirectIndex u32`;
  - linktarget/deleted (`0xFFFE`/`0xFFFD`): nothing;
  - otherwise: `clusterNumber u32`, `blobNumber u32`;
  then `url\0`, `title\0` (empty title ⇒ title = url), then `parameterLen` bytes.
- Cluster pointer list: `clusterCount × u64`. A cluster runs from its offset to the next higher
  known offset (next cluster, or one of the section positions / file end). Cluster byte 0:
  low nibble = compression (0 or 1 none, 2 zlib, 3 bzip2 (unsupported → error), 4 xz/LZMA2,
  5 zstd); bit `0x10` = extended (u64 blob offsets instead of u32). After that byte: offset table
  (first offset / offsetSize = number of offsets = blobCount + 1), then blob data; blob *n* =
  `data[off[n] .. off[n+1])` with offsets relative to the start of the (decompressed) offset table.
- **Namespaces.** New scheme (`minor ≥ 1` files written by libzim 7+): all content in `C`,
  metadata in `M`, `W/mainPage` redirect, `X` = indexes. Old scheme: articles `A`, images `I`,
  assets `-`, metadata `M`. Readers must handle both.

### 2.2 The Gutenberg ZIM layout (gutenberg2zim 3.x — the file in this repo)

Reference file: `gutenberg_en_lcc-pe_2026-03.zim` (ZIM 6.3, 6926 entries, clusters
uncompressed or zstd, 258 books). Facts verified by inspection:

- Metadata `M/Title` = "Project Gutenberg Library", `M/Description` = "English language",
  `M/LongDescription`, `M/Language` = "eng", `M/Date`, `M/Creator`, `M/Publisher`, `M/Name`,
  `M/Scraper` = "gutenberg2zim-3.0.1", `M/Tags`, illustration `M/Illustration_48x48@1` (PNG).
- Book index: `C/full_by_popularity.js` (also `full_by_title.js`, per-author `auth_<id>_by_*.js`,
  per-shelf `lcc_shelf_<X>_by_*.js`), content
  `var json_data = [[title, author, formats, bookId, lccShelf], ...];` in popularity order
  (first = most popular). `formats` is a 3-char flag string: `[html, epub, pdf]`, e.g. `"110"` =
  HTML + EPUB, `"010"` = EPUB only (2 books in this file have no HTML).
  `C/authors.js`: `var authors_json_data = [[name, authorId], ...];`
  `C/lcc_shelves.js`: `var lcc_shelves_json_data = ["PE"];`
  `C/languages.js`: `var languages_json_data = [["English","en",258]];`
- Titles may contain MARC subfield markers: `"The slang dictionary : $b Etymological, historical…"`
  → main title `"The slang dictionary"`, subtitle `"Etymological, historical…"`.
- URL base of a book (from the ZIM's own `js/tools.js`):
  `base = title.replace("/", "-").substring(0, 230) + "." + bookId` (**first** `/` only — JS
  `String.replace` with a string pattern). Entries (namespace `C`):
  - `C/<base>` — book HTML (when formats[0] == '1');
  - `C/<base>.epub` — EPUB;
  - `C/<titlebase>_cover.<id>` — an HTML "cover page" (not needed);
  - `C/covers/<id>_cover_image.jpg` — cover image (present for all 258 books here);
  - images referenced by a book are siblings, e.g. `C/37134_logo.png`, referenced relatively
    (`src="37134_logo.png"`).
- Book HTML specifics: PG header/footer already removed; the scraper injects a nav
  `<div>` containing `span.zim_info`, `span.zim_epub`, `span.zim_up` → strip those. Page markers
  `a.pagenum` / `span.pagenum` (e.g. `<a class="pagenum" id="Page_3" title="3"> </a>`) → strip.
  Transcriber notes (`#tnote`), poems (`div.stanza` with `<br/>`s), tables (`table#toc`), `<pre>`,
  `<ins>`, `<small>`, `.small-caps` all occur.
- Sizes: median book HTML ≈ 106 KB; largest is **30.6 MB** (Webster's Unabridged), then 11 MB,
  7 MB … So book content is converted on the server and delivered in chunks.

Older gutenberg2zim (2.x) files use the old namespace scheme and `.html` suffixes. Support them
best-effort: look up the JSON index in namespaces `C`, `A`, `-`, `J` (also under a `js/` prefix);
resolve a book's HTML by trying `<base>`, `<base>.html` in `C` then `A`; cover by trying
`covers/<id>_cover_image.jpg`, `covers/<id>_cover.jpg` in `C` then `I`.

### 2.3 Non-Gutenberg ZIMs ("generic")

A ZIM with no Gutenberg JSON index that is not Wikisource (§2.4) is a *generic* library: its
books are its HTML article entries (mime `text/html`, namespace `C` or `A`, excluding redirects),
in URL-pointer order, capped at `maxGenericBooks` (default 2000; log what was dropped). Book id =
`e<entryIndex>`, title = entry title, author = ZIM `Creator`/`Publisher` metadata, no cover, rank
= position, shelf = null. Wikipedia ZIMs (mwoffliner, `Source` = `*.wikipedia.org`) end up here
for now, which shows only their first 2,000 articles; proper support is in `TODO.md`.

### 2.4 Wikisource ZIMs (mwoffliner)

Detected by metadata: `M/Source` ends with `wikisource.org`, or `M/Tags` contains `wikisource`.
Reference: `wikisource_en_all_maxi_2026-09.zim` (8.6 GB, 1.08M entries, 706,865 HTML pages,
mwoffliner 2.0). Facts verified by inspection:

- A work is a top-level page in `C` (no `/`, not in a namespace such as `Author:`, `Portal:`,
  `Category:`, `Index:`, `Page:`; `Translation:` *is* a work namespace) with its text in subpages
  (`Teeftallow` → `Teeftallow/Chapter_1` …, or `Work/Volume_I/Chapter_IV`). **Books = multi-part
  works** (top-level pages with ≥ 1 subpage): 17,693 here. Single pages (poems, speeches) are not
  books. Huge compilations exist (Alumni Oxonienses 63k subpages, Britannica 1911 37k).
- The main page links its parts in reading order (a contents list, sometimes a `wst-auxtoc`
  box); mwoffliner removed the Wikisource header template, so **pages carry no author**.
  `Author:` pages (46,932) link to their works. Each page embeds its categories in
  `RLCONF = {… "wgCategories": [...] …}` (e.g. `"1926 works"`, `"Novels"`, `"American novels"`,
  plus many maintenance categories).
- Page structure: content in `#mw-content-text .mw-parser-output` (text in `.prp-pages-output`
  blocks with `span.pagenum.ws-pagenum` page markers); chrome to strip: `header` with
  `h1#firstHeading`, `#contentSub` (breadcrumb), `.ws-noexport`, `.licenseContainer` /
  `.licenseBanner` (licence notice with a `PD-icon.svg.png`), `#catlinks`, `.zim-footer`.
- Images are WebP files under `C/_assets_/<hash>/…`; a work's main page usually starts with its
  cover / title-page image.

### 2.5 Wikipedia ZIMs (mwoffliner)

Detected by metadata: `M/Source` ends with `wikipedia.org`, or `M/Tags` contains `wikipedia`.
References: `wikipedia_en_100_2026-08.zim` ("Wikipedia 100", mwoffliner 1.17) and
`wikipedia_en-simple_all_maxi_2026-09.zim` (Simple English, 2.9 GB, mwoffliner 2.0). The target
is the maxi flavour (with images). A Wikipedia is its own room of encyclopedia volumes:

- **Articles** are the non-redirect HTML entries of the article namespace (`C`, or `A` in the
  old scheme), except the main page. Disambiguation and "List of …" pages are articles too.
- mwoffliner stores redirects to a *section* as tiny HTML pages (`<meta http-equiv="refresh">`,
  ~220 bytes), because ZIM redirects carry no fragment. They are redirects, not articles:
  Simple English has 285,214 articles plus 4,819 such pages, Wikipedia 100 has 101 plus 1,221.
- **Volumes** are runs of 1,000 consecutive articles (`VOLUME_SIZE`) in the app's title order
  (`titleKey` + a default `Intl.Collator`, as `util/books.js` sorts book titles), numbered
  1–N. Each article starts on a fresh page, as its own chunk.
- The index (`server/wikipedia.js`) reads no article text. It scans the directory, then reads each
  candidate's HTML size, decompressing every cluster once in cluster order: that recognises the
  redirect pages, and the sizes estimate article lengths. Then it sorts the titles and cuts the
  volumes. It is built in the background on first open and cached as
  `.cache/wikipedia-<uuid>.v<INDEX_VERSION>.json`: the entry indices in title order and their
  HTML sizes (both base64 `Uint32Array`s), and each volume's first and last title. Wikipedia
  100 takes under a second, Simple English 56 s.

## 3. Server

```
server/
  index.js            CLI entry (shebang). Parses args, scans dir, starts HTTP(S), prints URLs.
  http.js             createServer(library, opts) → node:http(s) request handler + routes + static.
  library.js          Library / ArchiveLibrary: catalog building, content conversion + caching,
                      folder rescans.
  wikisource.js       Wikisource works index (build/cache), genres, work assembly (§2.4, §3.8).
  zim/reader.js       ZimArchive: low-level ZIM reading.
  zim/xz.js           Pure-JS .xz (LZMA2) decoder.
  content/html.js     HTML → blocks, chunking, TOC, image size sniffing.
  content/epub.js     ZIP + EPUB parsing (for EPUB-only books).
  util/lru.js         Byte-budgeted LRU cache (shared helper; create if you need it).
```

### 3.1 `server/zim/reader.js`

```js
export class ZimError extends Error {}
export class ZimArchive {
  /** Opens and validates a ZIM file. Reads header, MIME list, pointer lists (lazily or eagerly). */
  static async open(filePath, { clusterCacheBytes = 256 * 1024 * 1024 } = {}): Promise<ZimArchive>
  async close()
  filePath: string
  header: { major, minor, uuid /* 32-char hex */, entryCount, clusterCount, mainPage /* index|null */,
            urlPtrPos, titlePtrPos, clusterPtrPos, mimeListPos, checksumPos }
  mimeTypes: string[]
  newNamespaceScheme: boolean       // true when content lives in namespace 'C'
  entryCount: number
  async getEntryByIndex(index): Promise<Entry>
  async findEntry(ns, url): Promise<Entry|null>          // exact match, binary search
  async findPath(path): Promise<Entry|null>              // 'C/foo/bar' → ns 'C', url 'foo/bar'
  async findContentPath(url, namespaces = ['C','A','I','-']): Promise<Entry|null> // first hit
  async resolveRedirect(entry, maxHops = 16): Promise<Entry>   // follows redirect chains; throws on loop
  async getContent(entryOrPath): Promise<{ entry, mime, data: Buffer } | null> // follows redirects
  async getBlobSize(entry, { cheapOnly = false } = {}): Promise<number|null>
       // uncompressed cluster: reads 2 offsets only. Compressed: decompresses (or returns
       // null when cheapOnly and the cluster is not already cached).
  async getMetadata(): Promise<Record<string,string>>  // all M/ entries with text/* mime, as UTF-8
  async getMainEntry(): Promise<Entry|null>           // header.mainPage, redirects resolved
  async *entries(start = 0, end = entryCount): AsyncGenerator<Entry> // index order, batched reads
  async lowerBound(ns, urlPrefix): Promise<number>    // first index with (ns,url) >= (ns,prefix)
}
/** Entry */
{ index, ns, url, path /* `${ns}/${url}` */, title /* falls back to url */, mimeIndex,
  mime /* string, or null for redirect/special */, isRedirect, redirectIndex /* or null */,
  cluster /* or null */, blob /* or null */ }
```

Requirements:
- Positional reads via `fs.promises` `FileHandle.read` (never load whole files). Works with files
  > 4 GB (offsets as Numbers from `readBigUInt64LE`).
- **Uncompressed clusters are never read whole**: read the needed offset-table entries and the blob
  byte range only (images/EPUBs can be tens of MB).
- Compressed clusters: decompress with `zlib.zstdDecompress` (promisified, async), `zlib.inflate`
  for type 2, `xzDecompress` for type 4. Cache decompressed clusters in a byte-budgeted LRU.
  Concurrent requests for the same cluster share one in-flight decompression.
- If `zlib.zstdDecompress` is missing (old Node), throw a clear `ZimError` mentioning Node ≥ 22.15.
- Directory entries: cache parsed entries in an LRU (count-based, e.g. 50k) — binary searches touch
  ~log2(n) entries.
- Bad magic / truncated file / out-of-range index → `ZimError` with a clear message.

### 3.2 `server/zim/xz.js`

```js
export function xzDecompress(input: Uint8Array): Buffer   // throws Error on corrupt data
```
Complete .xz container support as produced by `xz`/liblzma (and libzim): stream header/footer,
multiple blocks, multiple concatenated streams + stream padding, block header with optional
compressed/uncompressed sizes, filter chain **LZMA2 only** (others → clear error), check types
none / CRC32 / CRC64 / SHA-256 (skip check bytes; verifying CRC32 is a bonus), index skipped or
validated. LZMA2 chunk types: uncompressed (with/without dict reset), LZMA with
state/props/dict resets. Correct LZMA range decoder, literal coder with lc/lp/pb, match/rep
decoding, distances incl. align bits. Must be fast enough for multi-MB clusters (typed arrays,
no per-byte allocations; pre-size output when the block header gives the uncompressed size,
otherwise grow geometrically).

### 3.3 `server/content/html.js`

```js
/** Converts one HTML (or XHTML) document into reader blocks (§3.5). */
export function htmlToBlocks(html: string, { docPath }: { docPath: string }): { title: string|null, blocks: Block[] }
/** Groups blocks into chunks; builds TOC from headings. */
export function chunkBlocks(blocks: Block[], { targetChars = 40000, maxBlocks = 3000 } = {}):
    { chunks: Array<{ start, chars, blocks: Block[] }>, toc: TocEntry[], totalChars }
/** Character weight of a block for chunking/progress (text length; img = 600; hr = 50). */
export function blockChars(block): number
/** Image dimensions from file header bytes: PNG, JPEG (scan SOFn markers), GIF, WebP (VP8/VP8L/VP8X), BMP, SVG (width/height or viewBox). */
export function imageSize(buf: Uint8Array): { w: number, h: number } | null
/** Resolves a (possibly percent-encoded, relative) link against a document path. Returns a
 *  normalized archive path ('C/37134_logo.png'), or null for external (scheme:) / empty links.
 *  data: URIs are returned unchanged. Strips ?query and #fragment. Handles ./ ../ and leading /. */
export function resolveHref(href: string, docPath: string): string | null
```
`docPath` is the full archive path of the document including namespace for ZIM content
(`'C/The Elements of Style.37134'`), or the path inside the zip for EPUB documents
(`'OEBPS/chapter1.xhtml'`). Image `src` in output blocks is the **resolved archive path**
(the library layer rewrites it to a URL, §3.4).

Conversion rules:
- Parse with `htmlparser2` (`Parser`, `decodeEntities: true`, `recognizeSelfClosing: true`,
  `lowerCaseTags: true`). Must be robust to malformed HTML and fast on 30 MB input
  (linear time; no DOM building for the whole document is required — a streaming state machine
  is preferred; if you do build a tree, mind memory).
- Skip entirely: `head`, `script`, `style`, `noscript`, `template`, `svg`, `math` (keep alt text
  if any), `iframe`, `object`, `button`, `select`, `input`, `form` controls, elements with
  `hidden` attribute or inline `display:none`, `span.zim_info|zim_epub|zim_up` (and any element
  whose class starts with `zim_`), elements with class `pagenum`/`pageno`/`pagenumber`, links with
  class `pagenum`, `#pg-header`, `.pg-boilerplate` header (keep the PG license footer if present).
- Block-level elements create block boundaries: `p div h1–h6 blockquote pre ul ol li dl dt dd table
  thead tbody tfoot tr td th caption figure figcaption section article header footer aside nav main
  center address hr br(inside inline context → line break) img(standalone)`.
- Text: collapse whitespace runs to a single space outside `pre`; trim block edges; drop empty
  blocks. Convert `­` (soft hyphen) to nothing; keep ` `.
- `<br>` → a hard line break inside the current block (`"\n"` inside run text).
- Inline styles → run style bits (§3.5): `i em cite var dfn` italic; `b strong` bold;
  `code tt kbd samp` mono; `sup` sup; `sub` sub; class contains `smcap`/`small-caps`/`smallcaps`
  or `font-variant: small-caps` → smallcaps; `u ins` underline; `small` → smaller (bit); `big`
  and class `xhtml_big` → larger (bit). Nesting accumulates.
- Alignment: `center` element, `class` containing `center`/`centered`/`c` (exact token), or inline
  `text-align:center` → `a:'c'`; right similarly → `a:'r'`.
- Indentation: `blockquote` (and classes `blockquot`, `blockquote`, `quote`) increase `q` (quote
  depth) for contained blocks; poetry: lines inside `div.poem`/`div.stanza`/`.verse` get `v:1`
  (verse: no justification, no first-line indent); `span.i1`…`span.i9` / classes `indent1`…
  at line start add leading non-breaking spaces (2 per level).
- Lists: `li` → block `t:'li'` with `d` (nesting depth, 1-based) and `m` marker (`'•'` for `ul`,
  `'1.'`, `'2.'`… for `ol`, honoring `start`; `'a.'`/`'i.'` for `type`).
- Tables: each `tr` → block `t:'tr'` with `c: Run[][]` (one runs array per cell, colspan ignored),
  `g` = table group number (incrementing per `table` in the document), `hd: true` if all cells are
  `th`. Nested tables: flatten inner table text into the cell.
- `dt` → paragraph with bold; `dd` → paragraph with `q+1`.
- Headings `h1–h6` → `t:'h'`, `l` = level. Heading text containing only whitespace → dropped.
- Images: `img` → `t:'img'` block (`src` resolved via `resolveHref`, `alt`, `w`/`h` from numeric
  `width`/`height` attributes if present). An `img` inside running text still becomes its own
  block (splitting the paragraph). Skip images whose src resolves to null, except emit the alt
  text as an italic paragraph when non-empty. `figcaption` / `.caption` text following an image →
  paragraph `a:'c'` with smaller style.
- `hr` → `t:'hr'`. `pre` → `t:'pre'` with `x` = raw text (preserve whitespace/newlines; strip one
  leading newline; drop if blank).
- Element `id`s (and `a[name]`) inside a block → that block gets `id` = first such id (used for
  internal link targets; optional).
- `title`: `<title>` text if present.

### 3.4 `server/content/epub.js`

```js
/** Minimal ZIP reader (central directory; methods 0 store and 8 deflate via zlib.inflateRawSync; ZIP64 not required). */
export function readZip(buf: Buffer): { names: string[], has(name): boolean, get(name): Buffer | null }
/** Parses an EPUB 2/3: META-INF/container.xml → OPF → metadata (dc:title, dc:creator, dc:language) + manifest + spine. */
export function parseEpub(buf: Buffer): {
  title: string|null, author: string|null, language: string|null,
  docs: Array<{ path: string, html: string }>,    // spine order, XHTML documents only, UTF-8 decoded
  getFile(path: string): Buffer | null,
  mimeOf(path: string): string                  // from manifest media-type, else by extension
}
```
Paths are zip-root-relative and normalized (resolve OPF-relative hrefs, percent-decode).
Skip the Project Gutenberg "wrap" cover-only/ boilerplate docs only if trivially detectable
(optional). Never throw on a missing optional piece (no title, no creator); throw a clear Error
on a non-zip or missing OPF.

### 3.5 Blocks (the reader content model, shared by server and client)

A book is an array of blocks. Each block is a JSON object with a type tag `t`:

| t     | fields | meaning |
|-------|--------|---------|
| `'h'`   | `l` 1–6, `r` Run[], `a`?, `id`? | heading |
| `'p'`   | `r` Run[], `a`? `'c'|'r'`, `q`? int, `v`? 1, `id`? | paragraph (justified by default unless `v` or `a`) |
| `'li'`  | `r` Run[], `d` int ≥1, `m` string, `q`? | list item |
| `'tr'`  | `c` Run[][], `g` int, `hd`? bool, `q`? | table row |
| `'pre'` | `x` string, `q`? | preformatted text |
| `'img'` | `src` string, `w`? `h`? numbers (natural px), `alt`? string, `q`? | image |
| `'hr'`  | — | separator |

`Run` = `[text, styleBits]` tuple (compact on the wire), `styleBits` integer:
`1` italic, `2` bold, `4` mono, `8` sup, `16` sub, `32` smallcaps, `64` underline, `128` smaller,
`256` larger. Adjacent runs with equal bits are merged. Text may contain `"\n"` (hard break).
Optional fields are omitted when default (`a` absent = justified/left, `q` absent = 0).

`TocEntry` = `{ title: string, level: 1–6, c: chunkIndex, b: blockIndexWithinChunk }`.
TOC = headings with level ≤ 3 (if there are none, use level ≤ 4); cap at 2000 entries (log/flag
truncation with `tocTruncated: true` in meta). Title text = heading runs joined, `\n`→space,
trimmed, max 120 chars.

Chunking: walk blocks accumulating `blockChars`; close a chunk when it reaches `targetChars`
**and** the next block is a heading level ≤ 2, or at `1.5 × targetChars` at any block boundary, or
at `maxBlocks` blocks. Never split a block. `start` = cumulative chars before the chunk.
An empty book yields one chunk with one paragraph block `"(This book has no readable text.)"`.

### 3.6 `server/library.js`

```js
export class Library {
  static async scan(dir, { maxGenericBooks = 2000, log = console.log, warn = log,
                           contentCacheBytes, archiveOptions, cacheDir = '<project>/.cache' } = {}): Promise<Library>
  dir: string
  generation: number    // +1 whenever the set of libraries or a catalogue changes (clients poll it)
  list(): ArchiveLibrary[]
  get(libId): ArchiveLibrary | undefined
  async rescan(): Promise<{ generation, added: id[], removed: id[], reopened: id[], failed: name[] }>
  watch({ debounceMs = 2500, intervalMs = 60000 } = {}): () => void   // automatic rescans
  unwatch()
  async close()
}
export class ArchiveLibrary {
  id: string            // URL-safe slug from the filename without .zim: lowercase is NOT applied;
                        // characters outside [A-Za-z0-9._-] → '-'; de-duplicate with -2, -3…
  file: string          // basename
  archive: ZimArchive
  kind: 'gutenberg' | 'wikisource' | 'wikipedia' | 'generic'
  async info(): Promise<LibraryInfo>                     // §4 shape, cached (indexing progress live)
  async books(): Promise<Book[]>                         // §4 shape, cached
  async book(bookId): Promise<Book | undefined>
  async content(bookId): Promise<{ meta, chunks }>       // converted + cached (byte LRU ~300 MB total)
  async chunk(bookId, n): Promise<Chunk | null | undefined> // one chunk; Wikipedia articles on demand
  async resource(bookId, path): Promise<{ data, mime } | null>  // EPUB-internal files
}
```
- `scan` lists `*.zim` (case-insensitive, non-recursive), opens each; a file that fails to open is
  logged and skipped (never crash the server). Split archives (`.zimaa`…) are logged as unsupported.
- `rescan` re-reads the directory: opens new files, closes removed ones, and reopens a file whose
  size or mtime changed under the same library id. Concurrent calls share one scan (a call during
  a scan triggers one more pass). A file that failed to open (e.g. still downloading) is retried
  only after its size/mtime changes. `watch` = debounced `fs.watch` on the directory (a finished
  browser download is a rename to `*.zim`) + a periodic pass; `generation` increments when
  anything was added/removed/reopened, and when a library's catalogue changes on its own (a
  Wikisource index finished, §3.8).
- `content(bookId)`: gets the HTML (or, if the book has no HTML but has an EPUB, parses the EPUB
  and concatenates the spine documents' blocks), runs `htmlToBlocks`, fills missing image `w`/`h`
  by sniffing image bytes with `imageSize` (from the ZIM / EPUB; for large uncompressed images
  read only the first 64 KB is OK if you add a range read, else read whole), rewrites image `src`
  to client URLs (`/zim/<libId>/<archive path, each segment encodeURIComponent'd>` for ZIM paths;
  `/api/libraries/<libId>/books/<bookId>/res/<encoded path>` for EPUB-internal files; `data:` kept;
  missing images (not found in archive) → replaced by their alt text paragraph or dropped),
  then `chunkBlocks`. Concurrent calls for the same book share one conversion (in-flight map).
  Conversion of a 30 MB book must not block the event loop for more than a few hundred ms at a
  time is NOT required — but it must complete (< ~5 s) and be cached.
- Wikipedia volumes (§2.5): `content()` returns only the reading metadata. It has one chunk
  per article, with sizes estimated from the HTML size (`CHARS_PER_HTML_BYTE`), the article
  titles as `toc`, and `lazy: true`. `chunk(bookId, n)` converts article n when first asked for:
  its title as an `h` level 1 block (the page's own `h1#firstHeading` is chrome), then the
  article, with images fixed as above. It is cached in the same LRU under the book's key plus
  `#n`, and concurrent requests share one conversion. The HTTP chunk route always goes through
  `chunk()`.
- Images whose width and height the page already gives are only checked for existence, not
  read (`_zimImage(path, { size: false })`).
- Book `size`: `getBlobSize(epubEntry ?? htmlEntry, { cheapOnly: true })` (null if unknown).
  Never decompress whole archives at startup; `books()` must be fast (< 1 s for this file).

### 3.7 `server/http.js` and `server/index.js`

`export function createApp(library, { publicDir, vendorDirs, log })` → `(req, res) => void` handler.
`index.js` CLI:

```
node server/index.js [--dir <path>] [--port 8080] [--host 0.0.0.0] [--https] [--https-port 8443]
                     [--no-http] [--cert <file> --key <file>] [--max-generic 2000] [--no-watch] [--quiet]
```
- `--dir` defaults to `process.cwd()`. **Conventional ports: HTTP 8080 (`--port`), HTTPS 8443
  (`--https-port`).** `--https` (also implied by `--https-port`, `--cert`/`--key`) adds the HTTPS
  listener next to plain HTTP: one process, one shared `Library`, two servers; `--no-http` keeps
  HTTPS only. Each listener tries the next 10 ports when its port is busy. `main()` returns
  `{ server, servers, library, port, httpPort, httpsPort, urls, close }`.
- The directory is watched (`Library.watch`) unless `--no-watch`: ZIM files added, replaced or
  removed while the server runs are picked up, and clients re-shelve by themselves.
- `--https`: use `--cert/--key` if given, else generate a self-signed certificate with `selfsigned`
  (SAN: localhost, 127.0.0.1, all local IPv4 addresses) and cache it in `<project>/.cert/`
  (regenerate when expired or when the address set changes). WebXR needs a secure context:
  `localhost` is fine over HTTP; a headset on the LAN needs HTTPS.
- On start print: the libraries found (file, title, book count), and URLs for every listener
  (`http(s)://localhost:port` plus each LAN IPv4) with a hint about HTTPS for headsets. Graceful shutdown on SIGINT/SIGTERM.
- Never crash on a bad request: catch everything, respond 500 JSON, log.

### 3.8 `server/wikisource.js`

```js
export function isWikisource(meta): boolean
export function genreOf(categories): string        // first matching GENRES rule, else 'Other works'
export function yearOf(categories): number | null  // from "1926 works"
export function cleanCategories(categories)        // drops maintenance/licensing categories
export async function buildIndex(archive, { onProgress(stage, fraction), log }): Promise<Index>
export function indexPath(cacheDir, archive)       // <cacheDir>/wikisource-<uuid>.v<N>.json
export async function loadIndex(file, archive)     // null when absent / stale / other archive
export async function saveIndex(file, index)       // atomic (temp file + rename)
export async function collectWork(archive, rootUrl, { maxParts = 1200, maxBytes = 36e6, expectedParts })
    : Promise<{ parts: [{ url, path, html, depth }], truncated, total }>
// Index = { version, uuid, works: [[url, title, entryIndex, parts, coverPath|null, year|null, categories[], author|null]] }
```
- **Index build** (~110 s for the reference ZIM, run in the background by `ArchiveLibrary` on first
  open, then cached): (1) structure scan of all entries → works + subpage counts + `Author:`
  pages; (2) each work's main page, in cluster order (each cluster decompressed once):
  categories, year, cover = first image ≥ 120 px wide that is not page furniture (licence
  banner, `*.svg.png` icons, logos, ornaments), title-page text; (3) `Author:` pages → links to
  works (a link to a subpage credits its work). A work with several credits (author, translator,
  editor) gets the one whose surname appears on its title page, else the first.
- While the index is built the library's `books()` is empty and `info().indexing` =
  `{ stage: 'scan'|'works'|'authors', progress: 0..1 }` (`stage: 'failed', error` on failure);
  when it is ready the catalogue is rebuilt and `onChange` → `Library.generation++`.
- **Books**: id `w<entryIndex>`, `genre` (also `shelf`), `year`, `parts`, `rank: null`,
  `size = (parts + 1) × 30000` (shelf thickness follows length), `cover` (or null), `author`
  (or null).
- **Reading** (`content()`): `collectWork` = main page, then subpages depth-first in the order
  their parent links them; the main page may link any descendant, other pages only their own
  descendants (so in-text links to sibling chapters cannot reorder the book); if links cover less
  than half of the known subpages, unlinked ones are appended in natural order (`Chapter_2` <
  `Chapter_10`). Each part goes under its own heading (main page h1, depth 1 h2, deeper h3) and
  through `htmlToBlocks`, whose skip rules drop MediaWiki chrome (`.ws-noexport`, `.noprint`,
  `.mw-editsection`, `.navbox`, `.catlinks`, `.printfooter`, `.zim-footer`, `.licenseContainer`,
  `.licenseBanner`, `.pr_quality`, …; ids `firstHeading`, `contentSub`, `catlinks`, `footer`, …).
  Capped works end with a note "This edition includes the first N of M parts".

## 4. HTTP API

All JSON responses: `Content-Type: application/json; charset=utf-8`. Errors: `{ "error": "..." }`
with 400/404/500. Unknown `/api/*` → 404 JSON.

**`GET /api/libraries`** →
```json
{ "generation": 1, "libraries": [ {
  "id": "gutenberg_en_lcc-pe_2026-03", "file": "gutenberg_en_lcc-pe_2026-03.zim",
  "kind": "gutenberg", "title": "Project Gutenberg Library", "description": "English language",
  "longDescription": "English language studies, …", "language": "eng", "date": "2026-03-05",
  "creator": "gutenberg.org", "publisher": "openZIM", "name": "gutenberg_en_lcc-pe",
  "bookCount": 258, "illustration": "/zim/gutenberg_en_lcc-pe_2026-03/M/Illustration_48x48%401",
  "shelves": ["PE"] } ] }
```
(`illustration` null when absent; missing metadata fields are `null`.) `generation` changes when
libraries are added/removed/replaced or a catalogue finishes building: clients poll it and
re-fetch. Wikisource libraries (`"kind": "wikisource"`) add `"genres": [{ "name": "Novels",
"count": 1644 }, …]` (largest first; `shelves` = genre names) and `"indexing": null | { "stage",
"progress" }` (live; `bookCount` is 0 until the index is ready).

**`POST /api/rescan`** → rescans the ZIM folder now: `{ "generation", "added": [ids],
"removed": [ids], "reopened": [ids], "failed": [file names], "libraries": [ … ] }`. `GET` → 405.

**`GET /api/version`** → when the website last changed: `{ "changed": ISO-8601 | null, "file":
"js/interaction.js" | null }`, the newest modification time among the client files (`public/`,
dotfiles skipped), walked on every request since the files may change while the server runs.
`Cache-Control: no-store`.

**`GET /api/libraries/:lib/books`** →
```json
{ "library": "<libId>", "books": [ {
  "id": "37134", "title": "The Elements of Style", "subtitle": null,
  "fullTitle": "The Elements of Style", "author": "William Strunk", "authorId": "…" ,
  "rank": 3, "shelf": "PE", "language": "en",
  "formats": { "html": true, "epub": true, "pdf": false }, "readable": true,
  "cover": "/zim/<libId>/C/covers/37134_cover_image.jpg",
  "epub": "/zim/<libId>/C/The%20Elements%20of%20Style.37134.epub", "size": 123456 } ] }
```
`rank` = 1-based popularity position. `readable` = has HTML or EPUB that exists in the archive.
`cover`/`epub` null when absent (verify existence with `findPath`). Ids are strings.
`authorId`/`language`/`shelf` null when unknown. Wikisource books (§3.8) have `rank: null` and add
`"genre": "Novels", "year": 1926, "parts": 44` (`year` may be null); the full list is returned
(17,693 works ≈ 0.8 MB gzipped) and filtered into rooms by the client (§5.6). Wikipedia volumes
(§2.5) have `id: "v<N>"`, `title` = the range ("Aachen – Abbey", or one title),
`subtitle: "Volume N of M"`, `rank: N`, `size: null`, and add `"volume": N, "volumes": M,
"range": [first, last], "articles": 1000, "emblem": "<the archive's illustration URL>"`; the
library info of a Wikipedia adds `"articles"` (the total) and, like Wikisource, `"indexing"`.

**`GET /api/libraries/:lib/books/:id`** → reading metadata (triggers conversion):
```json
{ "library": "<libId>", "id": "37134", "title": "…", "subtitle": null, "author": "…",
  "cover": "…|null", "source": "html" | "epub", "totalChars": 123456,
  "chunks": [ { "start": 0, "chars": 40210, "blocks": 312 } ],
  "toc": [ { "title": "CONTENTS", "level": 2, "c": 0, "b": 14 } ], "tocTruncated": false }
```
A Wikipedia volume's metadata adds `"lazy": true`: its chunk sizes are estimates, and the reader
replaces each with the real character count when the chunk arrives (§5.2).

**`GET /api/libraries/:lib/books/:id/chunks/:n`** → `{ "index": n, "blocks": [ … ] }`
(400 for non-integer `n`, 404 out of range). Responses may be gzip-compressed when the request
accepts it (recommended: large chunks compress ~4×).

**`GET /api/libraries/:lib/books/:id/res/<path>`** → raw EPUB-internal file with its mime.

**`GET /zim/:lib/<archivePath>`** → raw entry content. `<archivePath>` is `ns/url` with each
segment percent-encoded (decode each segment, join with `/`). Follows ZIM redirects internally.
Headers: `Content-Type` from the entry mime (append `; charset=utf-8` for `text/*` without
charset), `Content-Length`, `ETag` (`"<uuid>-<entryIndex>"`), `Cache-Control: public,
max-age=86400`; honor `If-None-Match` (304) and single `Range: bytes=` requests (206) for audio.
HTML entries are served as-is (debug aid; the client never navigates to them).

**Static:** `/` → `public/index.html`; other paths → files under `public/`;
`/vendor/three/*` → `node_modules/three/*`; `/vendor/iwer/*` → `node_modules/iwer/build/*`.
Correct MIME types (`.js` → `text/javascript`, `.mjs`, `.css`, `.html`, `.json`, `.png`, `.jpg`,
`.svg`, `.woff2`, `.wasm`, `.glb`, `.hdr`, `.ico`…). Reject path traversal (`..`) with 400/404.
`Cache-Control: no-cache` for `public/` files (so edits show up), long cache for `/vendor/`.

## 5. Client

```
public/
  index.html             Landing overlay + canvas host, import map, Enter VR button.
  css/style.css
  reader-test.html       2D harness: pick a library/book, render pages on a <canvas>, arrows to flip.
  js/
    api.js               (exists) fetch wrappers for §4.
    config.js            (exists) shared constants.
    util/books.js        (exists) sorting (keys cached per book, sorted lists cached per array and
                         mode: never mutate a library's array), letters, bookDims, hashing.
    util/storage.js      safe localStorage get/set JSON (try/catch; namespaced STORAGE_PREFIX).
    reader/layout.js     text layout engine: blocks → positioned lines/items (pure, canvas measure).
    reader/reader.js     BookReader: chunk loading, pagination, page rendering to canvas.
    world/textures.js    procedural canvas art (wood, paper edges, spines, covers, signs); no three.js.
    world/canvas-texture.js  three.js textures from canvases / ImageBitmaps (canvasTexture, disposeTexture).
    world/atlas.js       spine atlas layout + painter (no three.js, shared with the worker).
    world/atlas-worker.js  module worker painting atlases on an OffscreenCanvas.
    world/room.js        the library room (floor, walls, ceiling, windows, lights, decor).
    world/shelves.js     bookcases + books (merged geometry, spine atlases), picking, locate.
    world/book3d.js      a single free-standing book: closed/open, cover, pages, page turn anim.
    world/world.js       World facade: builds room + shelves from libraries, layout, collisions.
    xr/controls.js       input: XR controllers/hands, desktop mouse+keyboard, touch; locomotion.
    ui/panel.js          canvas-texture UI panels with buttons/text, hover & click via UV.
    ui/overlay.js        DOM overlay: library info, search, help (non-VR); setReading(bool) fades it while a book is open.
    interaction.js       app state machine: browse → inspect → read; wires everything.
    rooms.js             which books are shelved: the current place (one library, or one room of a huge one).
    audio.js             tiny WebAudio synth: page turn, book slide/thud, UI click.
    perf.js              ?perf recorder (frame timing, events, segments), a no-op unless started (§5.7).
    perf-scenarios.js    built-in performance scenarios, loaded only by perf.run().
    main.js              bootstrap: renderer, scene, camera rig, XR session, loop, IWER dev flag.
```

### 5.1 Shared conventions
- Units metres, +Y up, the player starts at `world.spawn` facing `-Z` rotated by `spawn.yaw`.
- `renderer.outputColorSpace = SRGBColorSpace`; textures created from canvases set
  `colorSpace = SRGBColorSpace`, `anisotropy = renderer.capabilities.getMaxAnisotropy()` (cap 8)
  for text textures, mipmaps on.
- **Quest performance budget:** ≤ ~150 draw calls, ≤ ~500k triangles visible, no real-time shadows
  (fake with baked/gradient textures, AO-ish darkening), ≤ ~400 MB GPU textures. 72 fps target.
  Prefer `MeshLambertMaterial`/`MeshBasicMaterial`/`MeshStandardMaterial` sparingly.
- A *book descriptor* is the §4 book object plus `libId` (the client adds `book.libId`).
- Persisted settings (via `util/storage.js`): `settings` = `{ sort, fontScale, theme, snapTurn,
  smoothMove, sound, handedness }`, reading position `pos:<libId>:<bookId>` = `{ c, b, t }`
  (anchor + timestamp), `recent` = array of `{ libId, id, t }` (max 20).

### 5.2 Reader (`reader/layout.js`, `reader/reader.js`)

```js
export class BookReader {
  constructor({ libId, book, width = PAGE_PX.w, height = PAGE_PX.h, fontScale = 1, theme = 'paper', layoutStepMs = 4 })
  async load(): Promise<meta>                    // §4 reading metadata (via api.getBookMeta)
  meta
  firstRef(): PageRef                           // { c: 0, p: 0 }
  async next(ref): Promise<PageRef|null>        // null at end of book
  async prev(ref): Promise<PageRef|null>        // null at start
  async render(ref, canvas, { side }?): Promise<void> // draws the whole page; side 'left'|'right' adds the gutter shadow
  async renderBlank(canvas, { side }?)          // paper background only (e.g. left of page 1)
  pageNumber(ref): { n, estimated }; totalPages(): { n, estimated }
  anchorOf(ref): { c, b }                       // first block (chunk-local index) starting on/at the page
  async refForAnchor({ c, b }): Promise<PageRef>
  async refForToc(entry): Promise<PageRef>
  async refForProgress(fraction 0..1): Promise<PageRef>
  progressOf(ref): number                       // 0..1 by characters
  labelOf(ref): string                          // e.g. "12 / ≈340"
  fontScale; setFontScale(s)                    // clears layouts; callers re-resolve refs via anchors
  theme; setTheme('paper'|'sepia'|'night')
  dispose()
}
// PageRef = { c: chunkIndex, p: pageIndexWithinChunk }
```
- Each chunk is paginated independently (a chunk starts on a fresh page). Layout of a chunk is
  computed on first need and cached; neighbours are prefetched.
- A chunk is laid out in steps of ~`layoutStepMs` (`ChunkLayout.step` in layout.js), with a
  `setTimeout(0)` between steps so frames keep rendering. Each page is final as soon as it is
  decided, and the result is identical to a one-shot `layoutChunk`. Callers wait only for what
  they need: `render` and `next` for that page, `refForAnchor` / `refForProgress` until the
  target page, `prev` into the previous chunk for that whole chunk. A Wikipedia article can be
  240,000 characters (six normal chunks); laid out in one go it blocked a Quest 3 for 370 ms.
  `dispose` and `setFontScale` stop layouts in progress. Each finished layout is a `layout`
  perf event (wall time, work time, steps, pages).
- Page look: paper background (subtle vignette/grain baked once), margins ~8%, running header
  (book title, small caps, light) and footer (page label). Body serif font stack
  `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif`, base size
  ≈ 30px × fontScale at 1024 px width, line height 1.45. Justified paragraphs with first-line
  indent (except after headings / when `a`/`v` set), headings centered bold larger with space
  before, verse lines unjustified, lists with hanging markers, `pre` in monospace (shrink font to
  fit the longest line down to a minimum, then wrap), tables laid out with column widths from
  content (shrink font if needed; fall back to stacked cells), images scaled to fit the text box
  (keep aspect; never upscale beyond 2×; an image taller than the remaining space moves to the
  next page; images taller than a full page are scaled down to fit), `hr` as a short centered
  rule. Styles: italic/bold/mono/smallcaps (render uppercase at 0.8 size)/sup/sub/underline/
  smaller/larger. Hyphenation not required; break long words that do not fit a line.
- Lines must never be split across pages; a heading must not be the last thing on a page
  (keep-with-next). Widows/orphans: best-effort.
- Images are loaded with `new Image()` (`decoding = 'async'`) and decoded (`img.decode()`, off the
  main thread) before use, cached; `render` awaits images on
  that page (timeout 8 s → draw a placeholder box with alt text). Missing `w/h` → use the loaded
  image's natural size at layout time (layout may await image loads for that chunk).
- `reader-test.html` demonstrates the reader with a library/book picker, two-page spread view,
  arrow keys / buttons, font scale, theme, TOC dropdown, progress slider.

### 5.3 World (`world/*.js`)

```js
export class World {
  constructor({ renderer, scene })
  group: THREE.Group                         // added to scene by constructor
  async build(collections: Array<{ library, books }>, { sort = 'title' } = {}): Promise<void>
       // (re)builds shelves for all libraries; can be called again with another sort.
  shelves: Bookshelves
  teleportTargets: THREE.Object3D[]          // meshes a teleport ray may land on (floor)
  spawn: { position: THREE.Vector3, yaw: number }
  kiosk: { position: THREE.Vector3, yaw: number }   // where the catalog panel stands (facing yaw)
  constrain(from: Vector3, to: Vector3, radius = PLAYER.radius): Vector3   // walkable + collisions (XZ)
  isWalkable(x, z): boolean
  update(dt, camera)                         // per frame: lazy spine textures/LOD, ambient anims
  dispose()
}

export class Bookshelves {
  group: THREE.Group
  raycast(raycaster): { book, point, distance } | null     // nearest visible book hit
  getBookTransform(book): { position: Vector3, quaternion: Quaternion, dims: {w,h,d} } // world space, of the book in its slot
  hideBook(book); showBook(book)              // remove from / restore to its shelf (merged geometry)
  setHighlight(book | null)                   // hover highlight (e.g. slight pull-out + emissive tint)
  locate(book): { position: Vector3, yaw: number }   // a standing spot ~1.3 m in front of its bookcase, facing it
  books(): book[]                              // in shelf order
  makeSpineCanvas(book): HTMLCanvasElement     // same artwork as on the shelf (for Book3D)
}

export class Book3D {
  constructor({ book, dims, spineCanvas, renderer })
  group: THREE.Group                // origin at the book's centre; closed book: spine on -X, front cover faces +Z
  async loadCover(): Promise<void>  // uses book.cover URL or a generated cover; never rejects
  state: 'closed' | 'opening' | 'open' | 'closing'
  open(): Promise<void>; close(): Promise<void>     // animated (~0.6 s); when open the spread faces +Z
  setPages(leftCanvas | null, rightCanvas | null)   // uploads canvases to the open pages (CanvasTexture.needsUpdate)
  turn(direction: 1 | -1, { left, right }): Promise<void>  // animated page turn ending on the new spread
  pageSize: { w, h }                 // metres of one open page, unscaled (≈ dims.d × dims.h)
  readingScale: number               // group scale that makes one page READ.pageWidth wide
  centerWhenOpen: boolean            // true (default): content slides so the open spread is centred on
                                     // the origin; false: the spine stays at x = −d/2 while opening
  hitTestPages(raycaster): { side: 'left'|'right', uv: Vector2 } | null
  update(dt)
  dispose()
}
```
- **Layout:** one or more *sections* (one per library, in the order given), each a run of
  bookcases holding that library's books in the chosen sort order, left-to-right, top shelf to
  bottom. Books sit upright, spines facing out, packed with small random gaps; a shelf row is
  filled until the next book does not fit; occasional book leaning/lying stacks are optional decor.
  The top of each bookcase carries a small label with its range (e.g. `"Ab – Ch"` for title/author
  sort, `"#1 – #160"` for popularity); the first bookcase of a section has a larger section sign
  with the library title: a thin brass board with the text on its front and a plain plate (shared,
  no text) on its back and edges, so it is visible from behind too.
- **Room:** an inviting library hall sized to the content. ≤ ~24 bookcases: a rotunda (bookcases
  on a circle, facing inward, around a central area with the kiosk and a reading table/armchair
  decor); more: a rectangular hall with parallel aisles of double-sided bookcases. Warm lighting
  (hemisphere + a few point lights; no shadows), wooden floor, walls, tall windows or arches,
  ceiling. Procedural canvas textures only (no external image files required).
- **Spines:** canvas-rendered into atlases (e.g. 2048² per bookcase): base colour per book
  (palette of cloth/leather colours by hash), gilt bands, title (vertical, auto-fit, wrapping to
  2 lines for wide spines), author short name near the bottom. Must be legible at ~1.5 m in VR.
  **Quest 3 is the performance target** (development PCs are far faster: anything that stutters
  there is unusable on the headset). Atlases have three levels: *low* (1/8 scale, coloured bands
  and the label plate, requested for every bookcase by `build()`), *mid* (1/4 scale, small titles, ~1 MB, painted for every
  bookcase, nearest first) and *high* (full scale, legible titles, ~16 MB) only for at most 6
  bookcases within 4.5 m (horizontal), because spine titles are only legible that close on a
  Quest. A sharp atlas is dropped beyond 4.5 + 1.5 m, or displaced only by a bookcase at least
  1.5 m nearer (hysteresis: no repainting while standing or swaying). A room with at most 6
  bookcases (e.g. the 258-book Gutenberg room) fits the budget: all its bookcases get sharp
  atlases regardless of distance and keep them, and the mid level is skipped. A room of more than
  64 bookcases (only the all-libraries place) keeps mid atlases for the 64 nearest only, dropping
  one once it is more than 80th nearest. Every frame, the books of bookcases the viewer stands
  behind (behind the bookcase's mid-plane, where its back and side panels hide every book) are
  not drawn: about half of a hall. Atlases are painted in a module worker on an OffscreenCanvas
  (`atlas-worker.js`), and the main thread only uploads them. The worker returns an `ImageBitmap`
  in exactly the layout three.js uploads: `imageOrientation: 'flipY'` (WebGL ignores `flipY` for
  bitmaps), `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'`. With the defaults, the
  browser converted each bitmap on the main thread at `texImage2D`, and on a Quest 3 half of the
  uploads, small ones too, dropped a frame (3–4 % with matching options). Main-thread
  painting, even time-sliced, caused 15–80 ms frame spikes on a fast PC, because the browser
  defers canvas rasterization until the upload. The worker loads only relative modules
  (`atlas.js`, `textures.js`, `util/books.js`, `config.js`): module workers have no import map,
  so none of them may import three. Where module workers or OffscreenCanvas are missing, or the
  worker fails, painting falls back to the main thread, ~3 ms per frame
  (`atlasPainter().step()`), and low atlases are painted during `build()`. With the worker,
  `build()` posts every bookcase's low atlas at once; until one arrives the bookcase shows a
  shared plain placeholder texture, so the material always has a map and the swap needs no shader
  recompile. `shelves.ready()` resolves when all low atlases are in, and `World.build` waits for
  it (at most 3 s) while the room is still hidden behind the fade or the loading screen. Mid and
  high are painted one at a time after the lows (the worker works in order). Late results for a
  room that was rebuilt meanwhile are closed and dropped. Changing level is a texture
  swap (low and mid textures are kept). Spine text uses an offset dark copy, never `shadowBlur`
  (it blurs every glyph on the CPU).
- **Book3D:** cover image texture on the front (cover loaded from `book.cover`; fallback generated
  cover with title/author), spine artwork, page-edge texture, back cover. Opening rotates the front
  cover; when open, the two page planes show reader canvases, slightly curved/tilted is a bonus.
  Page turn: an animated page leaf flipping over (simple bend is enough).

### 5.4 Input (`xr/controls.js`)

```js
export class Controls extends EventTarget {
  constructor({ renderer, camera, rig /* THREE.Group containing camera */, scene, world, domElement })
  pointers: Pointer[]          // active pointers this frame
  update(dt)                   // per frame: poll gamepads, move rig (if locomotion enabled), update rays
  locomotionEnabled: boolean   // false while reading (sticks are then reported but do not move)
  teleportTo(position: Vector3, yaw?: number)   // moves the rig so the *viewer* stands there
  setRayVisible(visible)
  // events (CustomEvent detail):
  //   'select'      { pointer }      trigger / pinch / mouse click / tap
  //   'selectstart' { pointer }   'selectend' { pointer }
  //   'squeezestart'/'squeezeend' { pointer }     grip
  //   'axis'        { hand: 'left'|'right', x, y }      thumbstick, every frame when |v| > deadzone
  //   'flick'       { hand, dir: 'left'|'right'|'up'|'down' }   stick crosses threshold (edge-triggered)
  //   'button'      { hand, name: 'a'|'b'|'x'|'y'|'menu', pressed }
  //   'key'         { code, pressed }   desktop keyboard (only when not typing in a DOM input)
  //   'wheel'       { deltaY }
}
// Pointer = { id, kind: 'xr-controller'|'xr-hand'|'mouse'|'touch', hand: 'left'|'right'|null,
//             raycaster: THREE.Raycaster (world space), object3D?: THREE.Object3D (controller grip/ray) }
```
- **XR:** controllers via `renderer.xr.getController(i)`/`getControllerGrip(i)`; visible ray line +
  cursor dot (cursor placed by interaction at hit distance via `pointer.setHitDistance(d)` if you
  add it); controller models via `XRControllerModelFactory` (CDN profile assets; on failure show a
  simple procedural controller); hands via `XRHandModelFactory` with the procedural `'spheres'` or
  `'boxes'` profile (offline-safe). The ray stops where it meets something: a panel, a book, or a
  bookcase (`shelves.raycast`: bookcases are solid except for their open front, so a ray reaches
  books only through it and never passes through a back, side, top or shelf board into the next
  bookcase; this applies in every state, while books are pickable only when browsing).
  Locomotion when enabled: **right stick forward → teleport arc** (release to teleport onto
  `world.teleportTargets`, validated by `world.isWalkable`); while aiming, that controller's ray
  and cursor are hidden and `pointer.teleporting` keeps it from hovering or selecting; right stick
  left/right → snap turn (`PLAYER.snapTurn`), left stick → smooth move (optional setting, default
  on) constrained by `world.constrain`. When locomotion is disabled, sticks only emit events.
- **Desktop:** drag (any mouse button) to look; a press that does not move more than a few pixels
  is a click = select at the mouse position. No pointer lock: it fights the DOM overlay and is
  refused in embedded browsers. WASD/arrows move (constrained), Q/E or ←/→ turn, Shift runs.
  **Touch:** drag to look, tap = select at touch point, two-finger drag = move, pinch = `wheel`,
  horizontal swipe = `swipe` `{ dir }`. Pointers also have `setHovering(bool)`; extra events
  `teleport` and `turn` report locomotion.
  **Gamepad** (`xr/gamepad.js`, W3C standard mapping, desktop and phone only; not polled in XR):
  the first connected pad becomes active when used and inactive when the mouse moves, and emits
  `gamepad { active }`, which the overlay uses for its hint and help. While it is active, a
  pointer `gamepad` through the screen centre (crosshair `.pad-crosshair`) replaces the mouse
  pointer. The left stick walks (2 m/s; clicking it runs), and the right stick looks (2.4 / 1.6
  rad/s, radial dead zone 0.18). Buttons send the existing events, so `interaction.js` is
  unchanged:
  - A: `select` plus `button a`; B and Back: `button b`;
  - LB / RB and D-pad ← / →: `key` ArrowLeft / ArrowRight; D-pad ↑ / ↓: `key` `+` / `-`;
  - X: `key t` (contents); Y: `key n` (theme);
  - the triggers: a repeating `wheel` (100 · (RT − LT) every 0.12 s).
- XR controller gamepads follow xr-standard: buttons 0 trigger, 1 squeeze, 3 thumbstick press,
  4 A/X, 5 B/Y; axes 2/3 thumbstick.

### 5.5 Panels (`ui/panel.js`)

```js
export class Panel {
  constructor({ width, height /* metres */, pxPerMeter = 1200, background = 'rgba(25,20,16,0.92)', radius = 24 })
  mesh: THREE.Mesh          // PlaneGeometry; mesh.userData.panel = this
  canvas, ctx
  clear(); add(element); remove(id); get(id)
  // element = { id, type: 'button'|'text'|'image'|'list'|'slider', x, y, w, h (px), label, value,
  //             onClick(uvPx, element), disabled, active, font, color, align }
  redraw()                  // repaint (only when dirty — call markDirty())
  pointerMove(uv) / pointerLeave(); click(uv): boolean   // uv from raycast intersection (0..1)
  visible
}
```

### 5.6 Interaction (`interaction.js`) — the state machine

States: `browse` → `inspect` → `read` (and back).
- **browse:** pointers raycast shelves + panels. Hover a book → `shelves.setHighlight`, tooltip
  panel near the book with title / author. Select → book leaves its slot (`hideBook`, a `Book3D`
  at its slot transform) and flies (~0.5 s ease) to ~0.45 m in front of the viewer at chest height,
  turning to show the cover → **inspect**.
- **inspect:** info panel beside the book: title, subtitle, author, library, "Read" /
  "Continue (p. N)" / "Put back" buttons. In XR the book can be grabbed with squeeze and turned
  in the hand (bonus). Select on the book or "Read" → **read**. "Put back"/B/Esc → flies back to
  the slot, `showBook`, → **browse**.
- **read:** book moves to the reading pose (§`config.READ`), opens, shows the saved or first spread.
  Toolbar panel under the book: ◀ ▶, progress bar (click to jump), Contents, A− A+, theme, Close.
  Contents opens a scrollable TOC panel. Page turn: right-stick flick left/right, trigger on the
  right/left page, toolbar buttons, keyboard ←/→/PageUp/PageDown/Space, swipe on touch. Right stick
  up/down = move book nearer/farther, left stick up/down = scale (READ.minScale..maxScale), grip
  drag = reposition (bonus). Next spread is pre-rendered for instant turns. Saves position on every
  turn. Close/B/Esc → closes, flies back, → **browse**. Locomotion disabled while inspecting/reading.
- **Leaving VR**: an "Exit VR" button in the kiosk header (only while presenting), or holding
  B/Y for 1 s while browsing (a short press still means "back" when a book is out): a head-locked
  ring below the line of sight fills up (shown after 0.15 s, so taps do not flash it); releasing
  early cancels. Both end the XRSession (`interaction.onExitVR`).
- **Kiosk panel** (at `world.kiosk`, always available in browse; 1.0 × 1.0 m): "⟳ Rescan folder"
  button (`POST /api/rescan`), "↻ Reload page" (`interaction.onReload` → `location.reload()`; in
  VR the browser's own controls are out of reach, and a reload ends the session); at its foot,
  small and right-aligned, "Updated <date, time>" from `GET /api/version`, fetched once at load,
  so it tells which version the page is running; when there is more than one library or the
  current one is browsed by rooms, two tabs:
  - *Shelves & settings*: library summary, sort toggle Title/Author/Popularity (rebuilds shelves),
    A–Z letter grid over the shelved books (teleports to the first book with that letter via
    `shelves.locate` and highlights it for 4 s), "Surprise me" (random book), "Recently read"
    list (opens directly into read), settings toggles (sound, smooth move).
  - *Rooms*: one button per library (with its book count, or indexing progress), and for a
    library browsed by rooms the current room ("Now: Poetry, titles starting with A · 39 works")
    with a "✕ Clear filters" button, genre buttons and a title-letter grid. Genre and letter are
    independent toggles: tapping one sets or swaps that filter, tapping the active one removes
    it, and the other filter is kept. Counts show what the room would hold with that choice
    (a genre's count respects the current letter and vice versa); choices that would give an
    empty room are disabled.
  - Rebuilding from the kiosk (library, filters, sort) never moves the viewer: they keep their
    pose relative to the kiosk (`controls.followFrame`), which itself moves only when the room
    changes shape (rotunda ↔ hall, or a different rotunda radius). Only if that spot is no longer
    walkable do they go to the spawn point.
- **Rooms** (`rooms.js`): the hall shows one *place* at a time — each library is its own room
  (`settings.place`, default the first library with books); `collectionsFor()` returns that single
  collection. A Wikipedia library is shelved whole as its volumes, in their own order
  (`ordered`: never re-sorted, bookcase plates from the first and last article). It is never
  split by filters, and its sign reads "N volumes · M articles". With more than one library
  there is one more place, `ALL_PLACE`
  (`settings.place = '*'`), that shelves every library except Wikipedias (for now) in one hall,
  with no filters.
  - No room has more than `MAX_BOOKCASES` = 200 bookcases (`world.js`); in practice only this
    hall reaches the limit.
  - Libraries share the limit fairly (`shareBookcases`, max-min fair): each gets an equal share,
    and a library that needs less is shelved whole and leaves the rest to the others.
  - A library over its share shows the longest prefix of its sorted books that fits
    (`prefixForBookcases`), and its sign says "first N of M books".
  - With 79,000 books the hall would have needed 658 bookcases. On a Quest 3 that froze entry for
    5 s, cost ~400 draw calls per eye and ran at 56 fps; ~180 bookcases worked.
  - `packBookcases` aims each row at the remaining width over the remaining rows, so it uses
    exactly `bookcasesNeeded()` bookcases.
- A library is further browsed by rooms when `kind === 'wikisource'` or it has more
  than 3,000 books. It then shelves one room at a time, `{ genre, letter }` (each a string or
  null): the works of that genre whose title starts with that letter, either filter alone, or —
  both null — all works. A room is sorted by the current sort and capped at `ROOM_CAP` = 3,000
  books (the section sign says "(first 3,000)"). The default room is Novels if present, else the
  largest genre that fits. The current room per library is saved in `settings.rooms`; rooms
  saved in the earlier `{ type: 'genre' | 'letter', value }` shape are converted (`normRoom`).
  Ordinary libraries are shelved whole. Search results and "Recently read" entries that are not
  on the shelves first switch to the book's place and room (`placeFor` / `roomFor`: its genre,
  narrowed to its title letter when the genre is over the cap); every loaded book carries its
  `libId` for this.
- DOM overlay (non-VR): see `ui/overlay.js` — title with the same "Updated …" stamp, library
  cards (with indexing progress), a ⟳ rescan button, search box (filters by title / author across *all* books of all libraries;
  picking a result = switch room if needed, teleport to it and select it), Enter VR button
  (only when `immersive-vr` is supported), control help, loading progress, error toasts.

### 5.7 Bootstrap (`main.js`)

- `WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })`, `xr.enabled = true`,
  `setPixelRatio(min(devicePixelRatio, 2))`, `xr.setFramebufferScaleFactor(1.0)` (no
  supersampling on the Quest), `xr.setFoveation(0.5)`, reference space `local-floor`. On session
  start, `session.updateTargetFrameRate()` asks for `XR_FRAME_RATE` = 72 Hz (or `?hz=`), the
  nearest supported rate: Quest Browser starts at 90 Hz, where the Quest 3 dropped 3–8 % of
  frames even in ordinary rooms. Only one
  chandelier per room casts light (point lights cost per-pixel shading on the headset).
- Camera rig: `rig = new Group()` (moved by locomotion) containing `camera`; desktop eye height
  `PLAYER.eyeHeight` applied as camera y when not presenting (XR provides real head height).
- Session: `navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor',
  'bounded-floor', 'hand-tracking', 'layers'] })` from the Enter VR button; `renderer.xr.setSession`.
- Dev flag: `?xr=emulate` (or `?emulate=quest3`) dynamically imports `/vendor/iwer/iwer.module.js`
  and installs `new XRDevice(metaQuest3).installRuntime({ forceInstall: true })` **before**
  anything queries `navigator.xr` (Chromium has a native `navigator.xr` even without a headset);
  expose `window.__vrlbry = { renderer, scene, camera, rig, world, controls, interaction,
  overlay, xrDevice, settings, enterVR(), tick(dt, n) }` for automated testing in all modes.
  `tick` advances n frames manually (requestAnimationFrame does not run in a page that is not
  painted).
- Loading: fetch libraries → books (all libraries in parallel) → `world.build(collectionsFor(…))`
  → spawn → loop. Show progress in the overlay; on fatal errors show a readable message.
- Rebuilds (room switch, sort, rescan) fade to black (0.15 s), rebuild, wait a few frames and fade
  back (0.3 s): the first render of a new room uploads its geometry and textures at once (tens of
  ms even on a fast PC) and must happen in the dark in a headset. The fade and exit-ring shaders
  are compiled at startup (`renderer.compile`) so their first appearance does not stall. Room
  shells share materials and textures across rebuilds (tiling via UVs, no clones), and every room
  shape has exactly two point lights so switching never recompiles shaders. A room's windows are
  merged into three meshes (glass, frame wood, sill wood), not four per window.
- Catalogue updates: every 10 s (while the page is visible or in XR) poll `GET /api/libraries`;
  when `generation` changed, fetch the book lists of new or changed libraries, toast what was
  added/removed, update the overlay and call `interaction.setCatalog()`, which rebuilds the
  shelves now in browse or after the open book is put back. Info-only changes (indexing progress)
  just refresh texts.
- `renderer.setAnimationLoop(tick)`: `dt` clamped to 0.1 s; update order: controls → interaction →
  world → render.
- `?perf` (`perf.js`): a recorder, a no-op unless started, exposed as `__vrlbry.perf`.
  - Per frame (ring buffer, 20 min at 72 Hz): start time, interval between frame timestamps (XR
    or rAF time), main-thread cost of the callback, draw calls, triangles (both eyes in VR).
  - Events with durations: `rebuild` (fade-out, synchronous build, waiting for the low atlases),
    `lows`, `atlas` (per level, worker or main thread), `turn`, `layout` (one chunk), `render`
    (one page: drawing time, image count and image drawing time), `json` (parsing one API
    response).
  - Segments (scenarios), long tasks and JS heap samples.
  - `summary()` gives frame statistics per segment (fps, interval percentiles, dropped frames
    against the session's frame rate, JS cost, draw calls) and each rebuild's worst frame gap;
    `dump()` returns everything as JSON.
  - `perf.run(only)` loads `perf-scenarios.js`: small-idle, room-walk, filters, all-enter,
    all-idle, all-walk, read (small-idle and read use the smallest library that is not a
    Wikipedia), and, when a Wikipedia is present, wiki-walk and wiki-read in the largest one
    (wiki-read opens the middle volume, then jumps to its longest article). The viewer glides
    along the aisles at 1.2 m/s, and the settings are restored afterwards.
  - `tools/quest-perf.mjs` (Node, adb) forwards the Quest Browser's DevTools socket, runs or reads
    the recorder over CDP, adds the VrApi per-second log, `dumpsys meminfo` / `battery` snapshots
    (one at the end of each scenario) and device info, and writes `perf/quest-<time>.json`.
