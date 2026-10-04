# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

vrlbry is a WebXR virtual library. A Node.js server scans a directory (default: the cwd) for `*.zim` files (openZIM archives, primarily Project Gutenberg ones produced by gutenberg2zim), exposes their books over a small JSON API, and serves a Three.js client. The client shelves the books in a 3D library room and lets you pull a book out, open it and read it page by page. It works in a VR headset, on a desktop (mouse + keyboard) or on a phone (touch).

**`SPEC.md` is the binding contract between modules** (section numbers like §3.5 are referenced from code comments). Keep it in sync when you change an interface, JSON shape or the block format.

## Commands

```bash
npm install                      # deps: three, htmlparser2, selfsigned; dev: iwer
npm start                        # = node server/index.js (serves ZIMs in the cwd on :8080)
node server/index.js --dir <path> --port 8080 --host 0.0.0.0
npm run start:https              # self-signed cert, cached in .cert/ (needed for a headset over LAN)
npm test                         # = node --test "test/*.test.js" (a bare directory arg does not work)
node --test test/zim.test.js     # one test file
node --test --test-name-pattern="redirect" test/zim.test.js   # tests matching a name
```

- Node **≥ 22.15** is required, because the server uses the built-in `zlib.zstdDecompress`.
- There is no build step, bundler, linter or TypeScript. The client is plain ES modules in `public/`. An import map resolves `three` → `/vendor/three/build/three.module.js` and `three/addons/` → `/vendor/three/examples/jsm/`. The server maps `/vendor/three/*` to `node_modules/three/*` and `/vendor/iwer/*` to `node_modules/iwer/build/*`.
- WebXR needs a secure context. `http://localhost` works. A headset on the LAN needs `--https`, or `adb reverse tcp:8080 tcp:8080`.
- Dev pages: `/reader-test.html` is a 2D harness for the page renderer, and `/dev/*` holds world/controls harnesses. Append `?xr=emulate` to the app URL to install Meta's IWER WebXR emulator, which lets you exercise VR code paths in a desktop browser. The app exposes `window.__vrlbry` (renderer, scene, world, controls, interaction, xrDevice, `enterVR()`) for scripted testing.

## Architecture: data flow end to end

```
*.zim ─► ZimArchive (server/zim) ─► Library/ArchiveLibrary (server/library.js) ─► HTTP API (server/http.js)
                                       │ catalog: Gutenberg JSON index or generic HTML entries
                                       └ content: htmlToBlocks → chunkBlocks (server/content) + LRU cache
client: api.js ─► World/Bookshelves (shelves) ─► interaction.js state machine ─► Book3D
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
- **Content model (§3.5)**: book HTML is converted on the server into compact JSON **blocks**, then grouped into **chunks** (~40k chars) delivered one at a time. This is because one book in the reference ZIM is 30 MB of HTML.
  - Block types: `t` = `h` / `p` / `li` / `tr` / `pre` / `img` / `hr`.
  - Text is stored as `Run = [text, styleBits]` tuples. Style bits: 1 italic, 2 bold, 4 mono, 8 sup, 16 sub, 32 smallcaps, 64 underline, 128 smaller, 256 larger.
  - `"\n"` inside a run is a hard line break. Optional fields are omitted when they hold their default value.
  - The library layer rewrites image `src` from archive paths to client URLs: `/zim/<lib>/<ns>/<url>`, with each path segment percent-encoded. It also fills in missing image width/height by sniffing the image header bytes.
  - The converter strips scraper-injected nav (`span.zim_*`) and page markers (`.pagenum`).

### Client (`public/js/`)

- **`reader/`**: `BookReader` paginates each chunk independently, so every chunk starts on a fresh page. It addresses pages as `PageRef = {c: chunk, p: pageInChunk}`, not as global page numbers, because only the chunks laid out so far have known page counts and the rest are estimated.
  - Durable positions (saved reading position, staying on the same text after a font change) use the block anchor `{c, b}` via `anchorOf` / `refForAnchor`.
- **`world/`**: `World` builds the room and `Bookshelves`.
  - Each bookcase's books are one merged `BufferGeometry` whose spines use a per-bookcase canvas atlas, which keeps draw calls within the Quest budget (≤ ~150).
  - Picking uses per-book bounding boxes. `hideBook` / `showBook` collapse or restore that book's vertices.
  - `Book3D` is the free-floating book used in the inspect and read states.
- **`xr/controls.js`**: unifies XR controllers and hands, desktop pointer-lock, and touch into `Pointer`s (each with a world-space `Raycaster`) plus events (`select`, `axis`, `flick`, `button`, `key`, `wheel`). It also does locomotion (teleport arc, snap turn, smooth move), which is turned off outside the browse state.
- **`interaction.js`**: state machine `browse → inspect → read`. It owns the canvas-texture UI panels (`ui/panel.js`): the kiosk, the inspect panel, the reader toolbar and the table-of-contents list. The DOM overlay (`ui/overlay.js`) is only for non-VR use.
- **`util/books.js`**: holds the sort comparators, `letterOf` and `bookDims`. Both the shelf layout and the A–Z jump / interaction code **must** use these shared helpers so they agree on order and book sizes. Shared constants (dimensions, page size, reading pose) are in `config.js`.

## Testing notes

- Tests use `node:test` + `node:assert/strict`. Tests that need the real ZIM (`gutenberg_en_lcc-pe_2026-03.zim` in the repo root, ~795 MB, not committed) `skip` when it is absent.
- Synthetic ZIMs for unit tests are written by `test/helpers/zimwriter.js`. It supports both namespace layouts, all cluster compressions, extended clusters and redirects.
- The xz test vectors in `test/fixtures/xz/` (`<name>.xz` + expected `<name>.sha256`) are regenerated with `python test/fixtures/xz/generate.py`, which uses Python's `lzma` module.
