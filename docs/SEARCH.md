# The ZIMs' contents and their search indexes

What Kiwix's ZIMs hold and which of it the library reads; then Kiwix's own search indexes
(Xapian) and the ways to use them: kiwix-serve beside the server (`--kiwix-serve`, in the app:
SPEC §3.7, §4, §5.6) and a reader of our own (`core/zim/xapian.js`, experimental). What is still
to do is in the TODO ("Full-text search").

## What the ZIMs hold, and what the library reads

Counted on 2026-10-18 over every entry of three ZIMs: Gutenberg `gutenberg_en_all_2023-08`,
Wikipedia `wikipedia_en_top1m_maxi_2026-04` and Wikisource `wikisource_en_all_maxi_2026-09`
(12 million entries, 4.3 million of them redirects). Other ZIMs may hold kinds these do not.

In Wikipedia and Wikisource nearly every picture is WebP under its original extension: 3.5 million
WebPs named `.jpg`, `.png` or `.gif`. The library goes by the bytes, not the name.

### Read by the library

| Type | Extensions | In the three ZIMs |
|---|---|---|
| Pages (books, articles, works) | `.html`, `.htm`; Wikipedia's and Wikisource's articles have none | 2.6 M (Gutenberg 132 k) |
| E-books | `.epub` (Gutenberg's EPUB-only books) | 57 k |
| Inside an EPUB | `.opf`, `.xhtml`/`.html`/`.xml`, and the pictures they show | |
| Gutenberg's catalogue | `.js` read as data: `full_by_popularity.js`, `authors.js`, `lcc_shelves.js`, `languages.js`, `lang_<code>_by_popularity.js` | a handful |
| Pictures | `.jpg`/`.jpeg`/`.jfif`, `.png` (6 animated APNGs too), `.gif`, `.webp`, `.svg`, `.bmp`; sizes sniffed for PNG, JPEG, GIF, WebP, BMP, SVG (`imageSize`) | WebP 3.5 M, JPEG 904 k, PNG 243 k, GIF 37 k, SVG 20 k, BMP 5 |
| Formulas | `.svg` (MediaWiki's formula SVGs, set into lines of text) | 338 k (Wikipedia) |
| Metadata | none: `M/Title`, `M/Description`, `M/Illustration_48x48@1`, … | |

The library's own files: `.zim` (opened), `.json` (indexes, the server's cache), `.png` (Save
screenshot).

### In the ZIMs, not read

| Type | Extensions (count) |
|---|---|
| Other e-book and document formats | `.pdf` (2,090: Gutenberg 2,063, Wikipedia 25, Wikisource 2; Gutenberg's are noticed, `formats.pdf`, never opened), `.mobi` (748), `.xml` (1,510, Gutenberg's book XML), `.txt` (7) |
| Audio | `.mid`/`.midi` (4,465), `.mp3` (2,069), `.mp4` audio (32), `.ogg` (14), `.wav` (3): all Gutenberg's (below); pages' `<audio>` is dropped |
| Sheet music | `.ly` LilyPond (539), `.mxl` MusicXML (420), `.mscz` MuseScore (28), `.denemo` (28), `.mus` Finale (24) |
| Video | `.mpg` (2), `.avi` (1); pages' `<video>` is dropped |
| Pictures browsers cannot show, or unreferenced | `.psd` (3), `.xcf` (1), `.ico` (1, Gutenberg's favicon) |
| Fonts | `.ttf` (15), `.otf` (2), `.woff` (1), `.eot` (1) |
| Styles and scripts | `.css` (199), `.js` (the other ~77 k: Gutenberg's per-author lists `auth_<id>_by_popularity.js`, the sites' own scripts), `.xsl` (4) |
| Kiwix's own indexes | Xapian full-text and title search (`X/fulltext/xapian`, `X/title/xapian`), title listings (`X/listing/titleOrdered/…`): no extensions |
| Archives and strays | `.zip` (5), `.bin` (5), `.bak` (4), `.ini` (4), `.exe` (1, a pngcrush), `.lnk` (1), `.jbf` (1) |

### Audio and video (2026-10-18)

Of the three ZIMs only Gutenberg's holds any: Wikipedia's and Wikisource's declare no audio or
video MIME type. `gutenberg_en_all_2023-08` has 6,586 such files, about 1 GB, in 402 books:

| Type | Files | Size |
|---|---|---|
| MIDI (`audio/midi`) | 4,465 | 6.4 MB |
| MP3 (`audio/mpeg`) | 2,069 | 942 MB |
| M4A (named `.mp4`) | 32 | 20.7 MB |
| WAV | 3 | 30.5 MB |
| Ogg | 14 | 7.3 MB |
| AVI | 1 | 11 MB |
| MPEG video | 2 | 0.6 MB |

A book links its files from the text (`<a href="music/music011.mid">`), not with `<audio>`: *The
Complete Opera Book* (40540) has 371 such links, *Principles of Orchestration* (33900) 407.

Kiwix also publishes Gutenberg one LCC class per ZIM. Each class ZIM's book list
(`C/full_by_popularity.js`, current editions, read from Kiwix's mirror; the all-books ZIM's own
shelf column is empty) gives where the 398 books with MIDI or MP3 files are:

| Class ZIM | Size | Books | MIDI | MP3 |
|---|---|---|---|---|
| `gutenberg_en_lcc-m_2026-03` (Music) | 3.99 GB | 103 | 2,932 | 1,750 (744 MB) |
| `gutenberg_en_lcc-g_2026-03` | 8.10 GB | 20 | 479 | 11 |
| `gutenberg_en_lcc-e_2026-03` | 10.20 GB | 16 | 251 | 24 |
| `gutenberg_en_lcc-pz_2026-03` | 19.77 GB | 41 | 203 | 88 |
| `gutenberg_en_lcc-a_2026-03` | 9.75 GB | 63 | 98 | 21 |
| `gutenberg_en_lcc-ps_2026-03` | 16.02 GB | 32 | 87 | 22 |
| `gutenberg_en_lcc-d_2025-12` | 40.25 GB | 40 | 80 | 43 |
| `gutenberg_en_lcc-pr_2026-03` | 16.15 GB | 27 | 79 | 58 |
| `gutenberg_en_lcc-l_2026-03` | 0.63 GB | 4 | 73 | 1 |
| `gutenberg_en_lcc-pn_2026-03` | 3.25 GB | 10 | 44 | 20 |
| `gutenberg_en_lcc-u_2026-03` | 1.29 GB | 1 | 42 | 0 |
| `gutenberg_en_lcc-f_2026-03` | 9.89 GB | 8 | 32 | 4 |
| `gutenberg_en_lcc-pe_2026-03` (the tests' reference ZIM) | 0.79 GB | 1 | 0 | 14 |

A few more hold a handful each (q, b, pm, r, s, pa, c, t, pt, h, n, v, j, pj; `lcc-pm`, 0.05 GB,
has 8 MIDI files in *The Esperantist*). *Society's Child (audiofile)* is in no class ZIM, only in
the all-books ones. The Music ZIM holds about 70 % of the files and 79 % of their bytes (*Principles
of Orchestration*, *The Complete Opera Book*, *Music: An Art and a Language*); the other classes'
are mostly folk and traditional songs (*Jamaican Song and Story*, Ojibwa *Mide'wiwin* songs,
nursery songs, *The English and Scottish Popular Ballads*). The current class ZIMs carry the
files themselves: `lcc-m_2026-03` has 407 of book 33900's 408 and all 371 of book 40540's.

## Kiwix's search indexes (Xapian)

Every Kiwix ZIM made by recent tools carries Xapian databases ("Glass" format, the file magic
`\x0f\x0dXapian Glass`), each one blob in an uncompressed cluster of its own, so any part of one
is a positional read into the ZIM, like everything else `core/zim` reads:

| ZIM | `X/fulltext/xapian` | `X/title/xapian` |
|---|---|---|
| Wikipedia top 1M maxi (49 GB) | 2,584 MB | 1,032 MB |
| Wikisource all maxi (8.6 GB) | 816 MB | 290 MB |
| Gutenberg all (77 GB, 2023) | 667 MB | none |

The full-text one finds the articles and books that contain words, ranked; the title one finds a
title by any of its words ("war peace" → *War and Peace*). The library's own search matches title
prefixes (Wikipedia's index and redirects) and the loaded books' metadata. A query reads a few
B-tree pages and posting lists, not the database, so it suits range reads.

Ways to use them, each optional (search without them stays as it is):

1. **kiwix-serve beside the Node server** (on the PC or the Pi 5): a server route forwards a query
   to its `/search` (HTML, or OpenSearch XML) or `/suggest` (JSON) for the same file and maps the
   results to articles the library opens. Small, a separate process (no licence questions), server
   mode only: not GitHub Pages, not files opened in the browser.
2. **libzim in the Node server** (`@openzim/libzim`, with `Searcher` and `SuggestionSearcher`):
   in-process, prebuilt for Linux and macOS (x64, arm, arm64: the Pi 5 yes, Windows needs libzim
   built), GPL-3.0 (an optional dependency, not bundled). Server mode only.
3. **libzim in WebAssembly in the browser's worker** (`openzim/javascript-libzim`, what Kiwix JS
   uses): reads a `File` (Emscripten WORKERFS), so the local library's files; not a URL, so not
   Kiwix's library from the web. GPL-3.0 shipped on an MIT site, several MB of WASM, and the
   prebuilt versions have no snippets.
4. **A read-only Glass reader in `core/`** (MIT, written from the format as Xapian documents it,
   not by translating Xapian's GPL code): B-tree pages, keys and tags, posting lists, BM25, an
   English stemmer (Snowball's), libzim's term and document-data conventions. Works wherever the
   library does: the server, files in the browser, and ZIMs read from the web through the block
   cache. The most work, and Glass is thinly documented; over the network a common word's long
   posting list would need a cap. Measure on the Quest.

To learn what it gives first, 1 on the Pi 5 is a day (done: below); 4 is the one that fits
vrlbry (`core/` reads everything itself, and GitHub Pages plus ZIMs from the web are its main
use).

### Probe 1: kiwix-serve on the Pi 5 (2026-10-18)

Built from it: the server's `--kiwix-serve <url>` (SPEC §3.7, §4: routes `text` and `find`),
the overlay's "In the text" results and `interaction.openText`.

**Setup.** Kiwix's own build, `kiwix-tools_linux-aarch64-3.8.2.tar.gz` (20 MB, md5 checked;
kiwix-serve 3.8.2, libkiwix 14.2.0, libzim 9.5.0, Xapian 1.4.23), unpacked in `~/kiwix-tools` on
the Pi 5 (Debian 13, 8 GB, NVMe; no sudo). It serves `~/Downloads`' ZIMs from a library file it
watches, so a ZIM added with `kiwix-manage` needs no restart:

```bash
K=~/kiwix-tools/kiwix-tools_linux-aarch64-3.8.2
$K/kiwix-manage ~/kiwix-tools/library.xml add ~/Downloads/<file>.zim
$K/kiwix-serve --daemon --port 8095 --monitorLibrary --library ~/kiwix-tools/library.xml
```

It is not a service: after a reboot the last line starts it again. The ZIMs are the PC's (the same
files, so the same UUIDs): Gutenberg all 2023-08 (already on the Pi), Wikisource all maxi 2026-09
(copied in 74 s) and Wikipedia top 1M maxi 2026-04 (49 GB, 7 min), plus the Pi's own Wikipedia
all mini 2024-04. Then on the PC:

```bash
node server/index.js --kiwix-serve http://<host>:8095/
```

**Measured** (the PC asking the Pi over the LAN):

| | Gutenberg | Wikisource | Wikipedia top 1M |
|---|---|---|---|
| kiwix-serve search alone | 0.13–0.22 s | 0.25 s | 0.08–0.13 s (a word in every page, "the": 3 s) |
| vrlbry's `text` (search and place the hits) | 0.13 s | 0.10 s | 0.08 s; 0.67 s cold |
| `find` (the hit's block) | ~1 s (the book converted) | ~1 s (the work converted) | ~50 ms (one article) |
| title suggestions by any word (`/suggest`) | none (no title index) | 25 ms | 89 ms |

**Found.**
- Results are Kiwix's, in Xapian's order: "white whale" in Wikipedia puts four dolphin and whale
  articles before *Mocha Dick*; in Gutenberg, whale books before *Moby-Dick*.
- Kiwix's snippet is not always the place to open: for "Queequeg harpoon razor" it is *Moby-Dick*'s
  contents list ("110. Queequeg in His Coffin"). So `find` ranks a book's blocks by the query's
  words first and uses the snippet to choose among them: that opens on the scene where Queequeg
  shaves with his harpoon.
- A Wikisource work is cut at 1,200 parts (§3.8), and Kiwix finds pages past the cut: *Popular
  Science Monthly* is one "work" in the library, cut long before volume 55's "White Whales in
  Confinement". Such a hit is reported (`beyond`: a notice, the book goes back), not opened at a
  wrong place.
- The list stays fast by placing a Wikisource hit only by its work; its part is placed when it is
  opened (placing every hit's part converted every work: 12 s for four hits).

**Not done in the probe.** The kiosk's Search tab (VR) does not show text hits yet; the words are
not highlighted on the page; no "more results"; libraries opened in the browser and the GitHub
Pages site get none (only option 4 would reach them). On a TV, ↓ pressed in the box before any
result had come (a query that only the text matches: the hits take about half a second) left the
box, as ↓ does with no results, and the hits that came after were dropped (since 2026-11-04 it
waits in the box for them: SPEC §5.9).

### Spike: reading the Xapian databases ourselves (option 4, 2026-10-18)

**Documentation.** None at the byte level. Xapian's [Administrator's Guide](https://xapian.org/docs/admin_notes.html)
says a Glass table is a B-tree of 8 KB blocks and that single-file databases are made by
compacting; the [Flint structure page](https://trac.xapian.org/wiki/FlintBackend/Structure)
(2009) lists the tables as sorted key/tag pairs. The exact layout is defined only by
xapian-core's code (GPL). So the format was worked out from the bytes of the ZIMs' databases,
without reading Xapian's code, and checked by lookups whose results hold the words looked up.
The notes are at the top of `tools/xapian-spike.mjs`, which does the lookups (Node, local files;
not used by the app).

**What is known now.** Blocks, branch and leaf items, values split over several items and
deflate-compressed values; the tables' roots in block 0 (read by a pattern, not yet properly); the
main table's keys (metadata such as `language`=`eng`, `data`=`fullPath`, `valuesmap`=`title:0;
targetPath:1`, values, terms); a term's posting list in chunks (counts, document numbers, how
often the word occurs in each); document numbers as keys; each document's data, its ZIM path.

**Measured** (local files, `node tools/xapian-spike.mjs <zim> <X path> <words>`):

| Index | Query | Documents | Block reads (terms + 12 paths) | Time |
|---|---|---|---|---|
| Wikisource titles (290 MB) | moby dick | 144 (the novel and its chapters) | 6 + 3 | 9 ms |
| Wikisource titles | war peace | 416 | 7 + 15 | 12 ms |
| Wikisource full text (816 MB) | whale | 5,641 of 706,864 pages, 7 chunks | 6 + 12 | 11 ms |
| Gutenberg full text (667 MB, 2023) | queequeg harpoon razor | 7 books, the same as kiwix-serve's | 11 + 10 | 15 ms |
| Wikipedia top 1M titles (1 GB) | everest | 139 | 4 + 15 | 7 ms |

A term costs its tree's depth in reads (3: root, branch, leaf) plus its chunks; a path 1–3 reads
(the tree's top blocks are shared). Over the network (a round trip 0.3–0.8 s, the reads of one
level in parallel) a two-word query and ten paths would take about 1–3 s; from a file on a Quest
(~65 ms a read alone, ~11 ms each in parallel) a fraction of a second. A word in nearly every page
("the") has a posting list of megabytes: it needs a cap or to be skipped, as search engines do.

**Not yet.**
- Ranking: results are in document order (the ZIM's path order). BM25 needs each document's length
  (likely the main table's `\0\xe0` chunks, not yet decoded) and the totals in block 0.
- Block 0 read properly, not by a pattern; a value continuing into the next leaf (not met yet).
- Term forms: the title index holds lower-case words ("grey's" too); the full-text index has no
  "Zwhale"-style stemmed terms, so how other word forms are found (stemming) is still to learn.
- Snippets (from the page's text, as `find` does now), prefix search ("every" → "everest" as
  typed), and the title index's positions table (phrases).

**Verdict.** Feasible. A reader in `core/` for lookups and document paths is a few hundred lines
and works on the server, on files in the browser and over HTTP range reads (the databases are
uncompressed blobs). Ranking and term forms are the next unknowns; then a measurement on a Quest
over the network.

### Step 2: ranking, word forms and the network (2026-10-18)

Now a module: `public/js/core/zim/xapian.js` (`XapianDb.inArchive(archive, 'X/fulltext/xapian',
{ stem })`, `search(q)`, `postings(term)`, `path(did)`, `prefetch`), measured with
`tools/xapian-measure.mjs` (Node: a file or an address; `--kiwix` compares with kiwix-serve) and
`public/dev/xapian-test.html` (a browser, through the proxy); tests in `test/xapian.test.js` (the
real-file ones skip without the Wikisource ZIM). Not used by the app yet.

**Decoded since the spike.** Block 0 in full: a 2-byte version, the UUID, the revision, the six
tables in order (postlist, docdata, termlist, position, spelling, synonym: root, level, entries,
block size, the least size compressed, the free list), then the totals (documents, length bounds,
total length: Wikisource's full text 1.25 billion words, ~1,770 a page). The documents' lengths are
a posting list under `\0\xe0`. A full-text index holds stems only ("whales", "whaling" → "whale";
"moby" → "mobi"), Snowball's English as Xapian stems; a title index holds plain lower-case words.
The measurements use the `porter2` package (MIT, Snowball's English; CommonJS, so not yet for the
browser: `npm install --no-save porter2`).

**Ranking.** Xapian's BM25 with its defaults (k1 1, b 0.5): candidates are the rarest word's
documents, scored without lengths, then the best 50 again with them. Against kiwix-serve's top 10
for six queries (white whale; harpooned whales; moby dick ahab; declaration of independence;
abraham lincoln speech; steam engine boiler), how many of ours are among theirs:

| Lengths read | Overlap with kiwix-serve |
|---|---|
| none, or 10 | 4 5 7 1 4 2 |
| 20 | 7 6 8 1 7 8 |
| 50 | 8 8 8 2 8 9 |

The outlier: "declaration of independence", whose rarest stem ("independ") is in 59,000 pages,
past the 20,000 candidates taken (in document order). Words that common need what Xapian does
(skipping documents that cannot reach the top) or fewer candidates by a better rule.

**The network.** A search reads the tree's levels in batches (`prefetch`): the words' lists, then
the chunks of the other words holding the rarest's documents, then 50 lengths, then 10 paths;
blocks up to 4 apart are read together, up to 256 KB. Wikisource's full-text index:

| From | Opening (archive + index) | A search, first time | Requests |
|---|---|---|---|
| a local file | — | 6–35 ms | — |
| Kiwix's mirror (France), Node | 2.0–3.4 s + 0.7 s | 4.0–7.6 s | 21–54 |
| a US mirror (Wisconsin: where the proxy goes from here), Node | 1.0 s + 0.4 s | 0.55–1.9 s (merging blocks 16 apart: best) | 12–80 |
| the browser through the proxy, 6 at once | 2.6 s + 0.5 s | 0.9–1.8 s | 21–48 |
| the browser through the proxy, 32 at once | | ~0.9 s (a new query) | 28 |
| the same query again | | 2 ms (all cached) | 0 |

Kiwix's French mirror answered slowly that day: 0.5 s to the first byte and 80–180 KB/s; the US
mirrors 0.1–0.15 s and 1.4–2.1 MB/s. Both speak HTTP/2, but the French one answered requests on
one connection no faster than one after another.

**Next:** in the TODO ("Full-text search"): the Quest, a stemmer for the browser, common words,
and the search in the local library's worker.
