# The Librarian: experiments

Experiments with an AI librarian in vrlbry, on the local branch `librarian` (not pushed, not on
GitHub Pages). Nothing here is built yet: these are the proposals, cheapest first, each one
something to try on its own.

The model is the Librarian of Neal Stephenson's *Snow Crash* (1992): a daemon who fronts a vast
library in the Metaverse, appears as a pleasant silver-haired man in a sweater and tie, and finds,
retrieves and cross-references anything at once, but will not speculate or draw conclusions. He
can only find things; what they mean is the reader's to work out.

## The experiments

### 1. A librarian at the desk, no AI yet

A figure near the kiosk takes a question and answers it with the search the app already has
(titles and authors: `search.js`; Wikipedia articles and their redirects: `searchIndex`,
`searchRedirects`), then leads you to the book: walks to the shelf or lights a path, and hands it
to you (`interaction.ensureShelved`, `interaction.openArticle`). It can speak its answers with the
browser's speech synthesis (`speechSynthesis`).

This builds the body, the conversation panel (`ui/panel.js`; `interaction.notice` for a word in
the headset) and the "take me there" part that every later experiment reuses. It works offline and
on the Quest.

### 2. "I can only find things": answers with citations

A language model gets the library as tools: search titles, search articles, search the full text
(Kiwix's Xapian indexes, below), read a chunk of a book or article (`ArchiveLibrary.chunk`), open
a book at a passage. Like Stephenson's Librarian,
it never speculates: every statement points to a source, a book and a block anchor `{c, b}`, and
selecting the source opens the book at that exact paragraph. This is the core of the idea, and the
citation rule also keeps the model from making things up.

- It runs through the Node server (a route beside `server/http.js`'s), because the static site
  cannot hold an API key. The key goes in the server's environment, set by hand, never through
  chat; or a local model (Ollama) instead.
- It is opt-in: a question sent to a hosted model leaves the device.
- It would use Claude Haiku 5.5 (`claude-haiku-5-5`) or Sonnet 5.5 (`claude-sonnet-5-5`).

### 3. Cross-references between libraries

While you read *Moby-Dick* from Gutenberg, the librarian offers the Wikipedia article on Melville,
his other works on Wikisource, and the articles a passage mentions. A first version can match
titles and authors without any AI; the model from experiment 2 can add looser connections later.
This makes the separate ZIMs feel like one library.

### 4. Voice in VR

VR has no keyboard, so speaking is the natural way in: hold a controller button
(`xr/controls.js` `button` events), speak, hear the answer. The first step is a measurement:
whether Quest Browser supports the browser's speech recognition (`SpeechRecognition`) at all. If
not, the options are speech recognition on the server, or a small Whisper model in the browser
(heavy).

### 5. A model on the device

A probe of whether a small language model runs in the browser over WebGPU, on the desktop and on
the Quest: tokens per second, memory, and whether the room still holds 72 Hz (measured with
`tools/quest-perf.mjs`). Nothing would leave the device, but the Quest probably cannot do both at
once. This tells us whether that route is open at all.

## Where to start

1, then 2. Experiment 1 settles the figure, the panel and walking you to the book; experiment 2
then plugs a model into the same desk, and its citation rule is what makes it the Librarian rather
than a chatbot.

To decide before experiment 2: a hosted model with an API key, or a local model.

## Ground rules

These follow the project's own (CLAUDE.md, TODO.md):

- **Optional.** The library works exactly as now without the librarian; no model, server or
  network service is ever required to open and read a book.
- **No telemetry.** The page reports nothing about its visitors. A question goes to a model only
  when someone asks one, opted in, and nothing is logged beyond that.
- **The Quest is the target.** The figure and its panel stay within the draw-call budget, per-frame
  code allocates nothing, and nothing heavy runs in one frame.
- **English first.**

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
| Audio | `.mid`/`.midi` (4,465), `.mp3` (2,069), `.mp4` audio (32), `.ogg` (14), `.wav` (3); pages' `<audio>` is dropped |
| Sheet music | `.ly` LilyPond (539), `.mxl` MusicXML (420), `.mscz` MuseScore (28), `.denemo` (28), `.mus` Finale (24) |
| Video | `.mpg` (2), `.avi` (1); pages' `<video>` is dropped |
| Pictures browsers cannot show, or unreferenced | `.psd` (3), `.xcf` (1), `.ico` (1, Gutenberg's favicon) |
| Fonts | `.ttf` (15), `.otf` (2), `.woff` (1), `.eot` (1) |
| Styles and scripts | `.css` (199), `.js` (the other ~77 k: Gutenberg's per-author lists `auth_<id>_by_popularity.js`, the sites' own scripts), `.xsl` (4) |
| Kiwix's own indexes | Xapian full-text and title search (`X/fulltext/xapian`, `X/title/xapian`), title listings (`X/listing/titleOrdered/…`): no extensions |
| Archives and strays | `.zip` (5), `.bin` (5), `.bak` (4), `.ini` (4), `.exe` (1, a pngcrush), `.lnk` (1), `.jbf` (1) |

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

Built on this branch: the server's `--kiwix-serve <url>` (SPEC §3.7, §4: routes `text` and
`find`), the overlay's "In the text" results and `interaction.openText`.

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
node server/index.js --kiwix-serve http://192.168.50.204:8095/
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
Pages site get none (only option 4 would reach them).
