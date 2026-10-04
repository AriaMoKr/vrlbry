# vrlbry

A virtual library for your ZIM files. vrlbry finds the `.zim` files in a folder and shelves their
books in a warm, candle-lit 3D reading room. Walk up to a shelf, pull a book out, look at its
cover, open it and read it page by page. It works in a VR headset (Meta Quest and other WebXR
browsers), on a desktop with mouse and keyboard, and on a phone.

It understands two kinds of [Kiwix ZIM files](https://library.kiwix.org/) especially well:

- **Project Gutenberg** (gutenberg2zim): real covers, authors, popularity ranks and the books' own
  illustrations.
- **Wikisource** (mwoffliner): every multi-part work — novels, collections, histories; 17,693 in
  the English ZIM — becomes one book with all its chapters in order, its cover, author, year and
  genre.

Other ZIM files also work; their HTML articles become the books.

## Run it

You need Node.js 22.15 or newer.

```bash
npm install
```

```bash
npm start
```

That serves every `.zim` file in the current folder at <http://localhost:8080>. Other options:

```bash
node server/index.js --dir /path/to/zims --port 8080
```

| Option | Meaning |
| --- | --- |
| `--dir <path>` | folder with `.zim` files (default: current folder) |
| `--port <n>` | port (default 8080; the next free port is used if it is busy) |
| `--host <addr>` | interface to listen on (default: all, so a headset on your network can connect) |
| `--https` | serve HTTPS with a self-signed certificate (cached in `.cert/`) |
| `--cert <file> --key <file>` | use your own certificate |
| `--max-generic <n>` | max books listed from other (non-Gutenberg, non-Wikisource) ZIMs (default 2000) |
| `--no-watch` | don't pick up `.zim` files added or removed while the server runs |
| `--quiet` | print only problems and the address |

## Adding books

Drop more `.zim` files into the folder at any time — no restart needed. The server notices new,
replaced and removed files within a few seconds (a download that is still in progress is
retried once it finishes), and open pages re-shelve by themselves within ~10 seconds. The ⟳
buttons on the library card and on the catalogue stand rescan immediately.

The first time a Wikisource ZIM is opened, the server indexes its works in the background (about
two minutes for the 8.6 GB English one); the library card shows the progress, and the books appear
when it is done. The index is cached in `.cache/`, so later starts are instant.

Each library is its own **room**: the hall shows one collection at a time, and the **Rooms** tab of
the catalogue stand switches between them. A library as large as Wikisource is split further,
into rooms of one genre (Novels, Poetry, Drama, History & biography, Court decisions, …) or of all
works whose title starts with a letter, up to 3,000 books each. Search still covers every book of
every library: picking one that is not on the shelves takes you to its room.

## Using a VR headset

WebXR only runs on a secure page. On the computer itself `http://localhost` counts as secure. A
headset on your Wi-Fi needs one of these:

- **HTTPS:** start with `npm run start:https`, then open `https://<your-computer's-IP>:8080` in the
  headset browser (the server prints the address). The certificate is self-signed, so the browser
  warns once; choose to proceed.
- **USB (Quest):** connect the headset, run `adb reverse tcp:8080 tcp:8080`, and open
  `http://localhost:8080` in the headset browser.

Then press **Enter VR**.

## Controls

| | Desktop | Touch | VR |
| --- | --- | --- | --- |
| Look | drag the mouse | drag one finger | turn your head |
| Move | W A S D / arrows, Q E to turn, Shift to hurry | drag two fingers | right stick forward: teleport arc · flick right stick: snap turn · left stick: walk |
| Take a book | click it | tap it | point and pull the trigger (or pinch) |
| Read | click the book or **Read** | tap **Read** | trigger on the book, or **A** |
| Turn pages | ← → Space, or click a page | swipe, or tap a page | flick the right stick, or trigger on a page |
| Text size, theme, contents | + / −, toolbar | toolbar | toolbar |
| Book distance / size | mouse wheel | pinch | right stick up/down · left stick up/down · grip to move the book |
| Close / put back | Esc | **✕** / **Put back** | **B** or **Y** |

The catalogue stand next to where you start lets you re-shelve the books by title, author or
popularity, jump to a letter, pick a book at random ("Surprise me"), reopen recently read books,
choose a room of a large library, and rescan the folder. The search box (desktop and phone) finds
any book by title or author and takes you to it. Your reading position, text size, theme and
rooms are remembered in the browser.

## Development

```bash
npm test
```

```bash
node --test test/zim.test.js
```

- No build step. The browser loads plain ES modules from `public/`; Three.js comes from
  `node_modules` via an import map.
- Tests that need the reference ZIM (`gutenberg_en_lcc-pe_2026-03.zim` in the repo root) are skipped
  when it is not there. Wikisource support is tested on a miniature synthetic archive.
- Dev pages: `/reader-test.html` (the page renderer as a 2D reader) and `/dev/world-test.html` (the
  room with an orbit camera).
- `/?xr=emulate` replaces WebXR with Meta's IWER emulator (a virtual Quest 3), so the VR controls
  can be exercised in a desktop browser. `window.__vrlbry` exposes the app for scripted tests;
  `__vrlbry.tick(dt, n)` advances frames manually when the page is not being painted.

[SPEC.md](SPEC.md) describes the module contracts (ZIM reader, content format, HTTP API, client
modules); [CLAUDE.md](CLAUDE.md) is a shorter architecture overview.
