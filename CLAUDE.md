# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

vrlbry is a WebXR virtual library. A Node.js server scans a directory (default: the cwd) for `*.zim` files (openZIM archives; Project Gutenberg ones from gutenberg2zim and Wikisource ones from mwoffliner get special handling), exposes their books over a small JSON API, and serves a Three.js client. The client shelves the books in a 3D library room and lets you pull a book out, open it and read it page by page. It works in a VR headset, on a desktop (mouse + keyboard) or on a phone (touch).

**`SPEC.md` is the binding contract between modules** (section numbers like §3.5 are referenced from code comments). Keep it in sync when you change an interface, JSON shape or the block format.

## Commands

```bash
npm install                      # deps: three, htmlparser2, selfsigned; dev: iwer
npm start                        # = node server/index.js (serves ZIMs in the cwd over HTTP on :8080)
node server/index.js --dir <path> --port 8080 --host 0.0.0.0
npm run start:https              # HTTP :8080 + HTTPS :8443 in one process (self-signed cert in .cert/; needed for a headset over LAN)
node server/index.js --no-watch  # do not rescan the folder while running
npm test                         # = node --test "test/*.test.js" (a bare directory arg does not work)
node --test test/zim.test.js     # one test file
node --test --test-name-pattern="redirect" test/zim.test.js   # tests matching a name
```

- Node **≥ 22.15** is required, because the server uses the built-in `zlib.zstdDecompress`.
- There is no build step, bundler, linter or TypeScript. The client is plain ES modules in `public/`. An import map resolves `three` → `/vendor/three/build/three.module.js` and `three/addons/` → `/vendor/three/examples/jsm/`. The server maps `/vendor/three/*` to `node_modules/three/*` and `/vendor/iwer/*` to `node_modules/iwer/build/*`.
- Conventional ports: **HTTP 8080, HTTPS 8443** (`--port`, `--https-port`).
- WebXR needs a secure context. `http://localhost` works. A headset on the LAN needs `https://<ip>:8443`, or `adb reverse tcp:8080 tcp:8080`.
- The embedded browser pane rejects the self-signed certificate, so use the HTTP port (8080) for browser testing.
- Dev pages: `/reader-test.html` is a 2D reader built on the page renderer, and `/dev/world-test.html` shows the room with an orbit camera.
- **Scripted testing:**
  - Append `?xr=emulate` to the app URL to install Meta's IWER WebXR emulator (a virtual Quest 3). It is installed with `forceInstall`, because Chromium exposes a native `navigator.xr` even without a headset.
  - The app exposes `window.__vrlbry` (renderer, scene, camera, rig, world, controls, interaction, overlay, xrDevice, settings, `enterVR()`, `tick(dt, n)`).
  - `requestAnimationFrame` does not fire while the page is not painted (e.g. a hidden embedded browser pane), so animations and tweens stall. Drive frames with `__vrlbry.tick()`, and never `await` an animated action (pick, read, turn, close) without ticking.
  - In XR the XRSession drives frames. For tests in a hidden pane, replace `window.requestAnimationFrame` with a `setTimeout` version and restart the loop with `renderer.setAnimationLoop(() => __vrlbry.tick())`.

## Architecture: data flow end to end

```
*.zim ─► ZimArchive (server/zim) ─► Library/ArchiveLibrary (server/library.js) ─► HTTP API (server/http.js)
          (folder watched;            │ catalog: Gutenberg JSON index | Wikisource works index
           generation counter)        │          (server/wikisource.js, cached in .cache/) | generic HTML entries
                                       └ content: htmlToBlocks → chunkBlocks (server/content) + LRU cache
client: api.js ─► rooms.js (what to shelve) ─► World/Bookshelves ─► interaction.js state machine ─► Book3D
                └► BookReader (paginates blocks onto a 1024×1448 canvas) ─► Book3D page textures
```

### Server

- **`server/zim/reader.js` (`ZimArchive`)**: reads ZIM files with positional reads only.
  - Binary search over the URL pointer list compares **bytes** of (namespace char + UTF-8 URL), not JS strings. UTF-16 order differs for astral characters.
  - **Uncompressed clusters are never read whole.** Only the two offset-table entries and the blob byte range are read, because images and EPUBs can be tens of MB.
  - Compressed clusters (zstd = 5, xz = 4 via the pure-JS `server/zim/xz.js`, zlib = 2) are decompressed asynchronously into a byte-budgeted `LRUCache` (`server/util/lru.js`). Concurrent requests for the same cluster share one in-flight decompression.
  - Both namespace layouts are supported. The new scheme puts all content in `C`; the old scheme uses `A`/`I`/`-`.
- **Gutenberg catalog**: book list comes from `C/full_by_popularity.js` = `var json_data = [[title, author, formatsFlags, bookId, lccShelf], …]`, in popularity order.
  - `formatsFlags` is a `[html, epub, pdf]` string such as `"110"`. Some books are EPUB-only (`"010"`) and are made readable by parsing their EPUB (`server/content/epub.js`).
  - A book's entry URL mirrors the ZIM's own JS exactly: `title.replace("/", "-").substring(0, 230) + "." + id`. Only the **first** `/` is replaced, and the substring is in UTF-16 units. The HTML lives at that path, the EPUB at that path plus `.epub`, and the cover at `C/covers/<id>_cover_image.jpg`.
  - Titles may contain MARC ` : $b ` subtitle markers, which are split into title and subtitle.
  - A ZIM without that index falls back to "generic" mode: its HTML articles become the books, capped.
- **Wikisource catalog (`server/wikisource.js`, §2.4/§3.8)**: books are multi-part works (a top-level page with subpages; 17,693 in the English ZIM).
  - The works index needs a full pass over the archive (~110 s for 8.6 GB), so `ArchiveLibrary` builds it in the background on first open and caches it as `.cache/wikisource-<uuid>.v<N>.json`. Meanwhile `books()` is empty and `info().indexing` reports progress; on completion `onChange` bumps `Library.generation`. Bump `INDEX_VERSION` when the index format or build-time extraction changes.
  - mwoffliner strips the header template, so pages carry no author: authors come from `Author:` pages linking to works. Genre and year come from the categories embedded in each page (`"wgCategories"` in RLCONF), mapped at load time by `GENRES`, so genre rules can change without re-indexing.
  - Reading a work assembles the main page plus its subpages depth-first in link order (a non-root page may only pull in its own descendants), capped at 1200 parts / 36 MB.
- **Rescans**: `Library.rescan()` / `watch()` add, remove and reopen archives while running and bump `generation`. `GET /api/libraries` returns it and `POST /api/rescan` triggers a scan; clients poll every 10 s.
- **Content model (§3.5)**: book HTML is converted on the server into compact JSON **blocks**, then grouped into **chunks** (~40k chars) delivered one at a time. This is because one book in the reference ZIM is 30 MB of HTML.
  - Block types: `t` = `h` / `p` / `li` / `tr` / `pre` / `img` / `hr`.
  - Text is stored as `Run = [text, styleBits]` tuples. Style bits: 1 italic, 2 bold, 4 mono, 8 sup, 16 sub, 32 smallcaps, 64 underline, 128 smaller, 256 larger.
  - `"\n"` inside a run is a hard line break. Optional fields are omitted when they hold their default value.
  - The library layer rewrites image `src` from archive paths to client URLs: `/zim/<lib>/<ns>/<url>`, with each path segment percent-encoded. It also fills in missing image width/height by sniffing the image header bytes.
  - The converter strips scraper-injected nav (`span.zim_*`), page markers (`.pagenum`) and MediaWiki/mwoffliner chrome (`MW_CHROME_CLASSES` / `MW_CHROME_IDS` in `content/html.js`).

### Client (`public/js/`)

- **`reader/`**: `BookReader` paginates each chunk independently, so every chunk starts on a fresh page. It addresses pages as `PageRef = {c: chunk, p: pageInChunk}`, not as global page numbers, because only the chunks laid out so far have known page counts and the rest are estimated.
  - Durable positions (saved reading position, staying on the same text after a font change) use the block anchor `{c, b}` via `anchorOf` / `refForAnchor`.
- **`world/`**: `World` builds the room and `Bookshelves`.
  - Each bookcase's books are one merged `BufferGeometry` whose spines use a per-bookcase canvas atlas, which keeps draw calls within the Quest budget (≤ ~150).
  - **Quest 3 is the performance target; the development PC is far faster**, so anything that stutters on the PC is unusable on the headset. Atlases have three levels (`LEVELS` in `shelves.js`): low is drawn at build time, mid for every bookcase nearest-first, and high only for at most 6 bookcases within 4.5 m, with 1.5 m of hysteresis. A room of 6 or fewer bookcases is all sharp regardless of distance. Painting is time-sliced at ~3 ms per frame (`atlasPainter`), and dropping a level is a texture swap.
  - Never paint a whole atlas, or anything else heavy, in a single frame. Never use canvas `shadowBlur` on spine text.
  - More than 22 bookcases switches the rotunda to a hall with aisles.
  - Picking uses per-book bounding boxes. `hideBook` / `showBook` collapse or restore that book's vertices.
  - `Book3D` is the free-floating book used in the inspect and read states. Its local frame: front cover +Z, spine −X. Reading mode sets `centerWhenOpen = false`, so the cover swings open around a fixed spine.
- **`xr/controls.js`**: unifies XR controllers and hands, the mouse, and touch into `Pointer`s (each with a world-space `Raycaster`) plus events (`select`, `axis`, `flick`, `button`, `key`, `wheel`, `swipe`).
  - The desktop uses drag-to-look, not pointer lock, so the DOM overlay stays usable.
  - It also does locomotion (teleport arc, snap turn, smooth move), which is turned off outside the browse state.
- **`interaction.js`**: state machine `browse → inspect → read` (plus `busy` during animations). It owns the canvas-texture UI panels (`ui/panel.js`): the kiosk, the inspect panel, the reader toolbar and the table-of-contents list. The DOM overlay (`ui/overlay.js`) is only for non-VR use.
  - Page canvases come from a pool of 6: the shown spread plus the prepared next and previous spreads. `Book3D` keeps displaying (and turning) the canvases it was given, so never redraw a canvas that is on screen.
  - Background neighbour preparation is cancelled by bumping `_prepToken`.
- **`rooms.js`**: the hall shows one *place* at a time (`settings.place`): each library is its own room. Huge libraries (Wikisource, or more than 3,000 books) are browsed through a room `{ genre, letter }`, two independent filters that may each be null (both null = the whole library). A room is capped at 3,000 books and saved in `settings.rooms`; `normRoom` converts the older `{ type, value }` shape. The place and filters are chosen on the kiosk's Rooms tab.
  - Kiosk-driven rebuilds keep the viewer's pose relative to the kiosk (`controls.followFrame`), not the spawn point: the kiosk moves when the room changes shape.
  - Always build the world through `collectionsFor()`.
  - Search and recently read cover all books, so call `interaction.ensureShelved(book)` before locating a book that may be in another place or room. Every loaded book carries `libId` (`withLib` in `main.js`).
- **`util/books.js`**: holds the sort comparators, `letterOf` and `bookDims`. Both the shelf layout and the A–Z jump / interaction code **must** use these shared helpers so they agree on order and book sizes. Shared constants (dimensions, page size, reading pose) are in `config.js`.

## Testing notes

- Tests use `node:test` + `node:assert/strict`. Tests that need the real ZIM (`gutenberg_en_lcc-pe_2026-03.zim` in the repo root, ~795 MB, not committed) `skip` when it is absent.
- Synthetic ZIMs for unit tests are written by `test/helpers/zimwriter.js`. It supports both namespace layouts, all cluster compressions, extended clusters and redirects.
- `test/wikisource.test.js` builds a miniature mwoffliner-style archive (RLCONF categories, skin chrome, `Author:` pages). The real 8.6 GB Wikisource ZIM is not used by the test suite.
- `test/client-*.test.js` run the pure client modules (`util/books.js`, `reader/layout.js`, shelf packing, `rooms.js`) in Node. Layout tests use a fake text measurer, since Node has no canvas. Client `blockChars` must stay identical to the server's; a test checks this.
- The xz test vectors in `test/fixtures/xz/` (`<name>.xz` + expected `<name>.sha256`) are regenerated with `python test/fixtures/xz/generate.py`, which uses Python's `lzma` module.
