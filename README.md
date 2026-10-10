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
- **Wikipedia** (mwoffliner): a room of encyclopedia volumes, each holding 1,000 articles in
  title order with a matching blue-and-gilt binding, the volume number and title range on the
  spine, and every article starting on a fresh page. The search box finds articles by title and
  opens the right volume at that article. Infoboxes become a "Quick facts" section after the
  introduction, and formulas sit in the text. The first time a Wikipedia ZIM is opened, its
  articles are indexed in the background (about a minute for Simple English).

Other ZIM files also work: their HTML articles become the books, up to 2,000 per file (`--max-generic`).

## Run it

You need Node.js 22.15 or newer.

```bash
npm install
```

```bash
npm start
```

That serves every `.zim` file in the current folder at <http://localhost:8080>. For a VR headset,
start it with HTTPS as well (HTTP stays on 8080, HTTPS is added on 8443):

```bash
npm run start:https
```

Other options:

```bash
node server/index.js --dir /path/to/zims --port 8080
```

| Option | Meaning |
| --- | --- |
| `--dir <path>` | folder with `.zim` files (default: current folder) |
| `--port <n>` | HTTP port (default 8080; the next free port is used if it is busy) |
| `--host <addr>` | interface to listen on (default: all, so a headset on your network can connect) |
| `--https` | also serve HTTPS, on port 8443, with a self-signed certificate (cached in `.cert/`) |
| `--https-port <n>` | HTTPS port (default 8443) |
| `--no-http` | with `--https`: serve HTTPS only |
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
when it is done. The index is cached in `.cache/`, so later starts are instant. A very large
Gutenberg ZIM (all 56,000 English books) takes about half a minute to open before the server
answers.

Each library is its own **room**: the hall shows one collection at a time, and the **Rooms** tab of
the catalogue stand switches between them. A library as large as Wikisource is narrowed down with
two filters that can be used together or alone: a genre (Novels, Poetry, Drama, History &
biography, Court decisions, …) and the letter titles start with — say, poems starting with A.
Tap a filter again to remove it; with both removed you get the whole library. Up to 3,000 books
are shelved at a time. As an experiment, **All libraries** puts all your libraries in one big
hall of up to 200 bookcases: small libraries whole, and the first books of the large ones
(each large library gets an equal share). You stay where you are while the shelves change around you. Search still
covers every book of every library: picking one that is not on the shelves takes you to its
room.

## Using a VR headset

WebXR only runs on a secure page. On the computer itself `http://localhost` counts as secure. A
headset on your Wi-Fi needs one of these:

- **HTTPS:** start with `npm run start:https`, then open `https://<your-computer's-IP>:8443` in the
  headset browser (the server prints the address). The certificate is self-signed, so the browser
  warns once; choose to proceed.
- **USB (Quest):** connect the headset, run `adb reverse tcp:8080 tcp:8080`, and open
  `http://localhost:8080` in the headset browser.

Then press **Enter VR**.

## Controls

| | Desktop | Touch | Gamepad | VR |
| --- | --- | --- | --- | --- |
| Look | drag the mouse | drag one finger | right stick | turn your head |
| Move | W A S D / arrows, Q E to turn, Shift to hurry | drag two fingers | left stick (click it to hurry) | right stick forward: teleport arc · flick right stick: snap turn · left stick: walk |
| Take a book | click it | tap it | aim the crosshair, **A** | point and pull the trigger (or pinch) |
| Read | click the book or **Read** | tap **Read** | **A** | trigger on the book, or **A** |
| Turn pages | ← → Space, or click a page | swipe, or tap a page | bumpers, or D-pad ← → | flick the right stick, or trigger on a page |
| Text size, theme, contents | + / −, toolbar | toolbar | D-pad ↑ ↓ · **Y** · **X** | toolbar |
| Book distance / size | mouse wheel | pinch | triggers | right stick up/down · left stick up/down · grip to move the book |
| Close / put back | Esc | **✕** / **Put back** | **B** | **B** or **Y** |
| Leave VR | | | | hold **B** or **Y** for a second while browsing, or **Exit VR** on the catalogue stand (or the headset's Meta button) |

A gamepad (Xbox, PlayStation or another Bluetooth pad) works on a desktop or a phone; it takes
over as soon as you use it, and moving the mouse hands control back.

The catalogue stand next to where you start lets you re-shelve the books by title, author or
popularity, jump to a letter, pick a book at random ("Surprise me"), reopen recently read books,
filter a large library by genre and title letter, rescan the folder, and reload the page (handy
in a headset, where the browser's own controls are out of reach). Its footer, and the library
card, show when the app's files last changed ("Updated …"), so you can tell which version a page
is running. The search box (desktop and phone), or the kiosk's Search tab with its on-screen
keyboard (in a headset), finds any book by title or author and takes you to it, and any
Wikipedia article by title and opens its volume there. Your reading position, text size, theme and
rooms are remembered in the browser.

To report a problem, open the help (**?**) and press **Copy debug info**, then paste the result
into your message: it says which browser, graphics and version of the site you have, where you
were, and the page's last errors. If the library fails to open, the error screen has the same
button.

**Save scene** (in the help, or on the catalogue stand in a headset) remembers where you are:
the room, where you stand and look, the book you have open and its page, and the menus.
**Restore scene** takes you back there. In the help you can also paste a scene, or a debug report
someone sent you, and restore it: you see what they saw.

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

## Online version (GitHub Pages)

The same client can run as a static website, without the Node server:

```bash
npm run build:pages
```

This writes `dist/`: the client, the few Three.js and IWER files it imports, and static answers
in place of the API. The page addresses everything relative to itself, so it works under a path
such as `https://<user>.github.io/vrlbry/`. Module URLs carry a version tag, so a plain reload
picks up a new deploy even though Pages lets browsers cache files for 10 minutes. A page left open
notices a new deploy within 10 seconds and offers to reload.

`npm run build:pages -- --zims <folder>` also pre-renders the ZIMs in that folder: the server runs
inside the build and every answer the client can ask for (book lists, each book's chunks, the
images) is saved as a file, so the site needs nothing but static hosting. Searching Wikipedia
articles then happens in the browser, over a saved title list (by title only: redirects are not
included). A first visit opens the *Demo set* place when the site has it.

The workflow in `.github/workflows/pages.yml` runs the tests, downloads the demo set (the ZIMs
listed in `tools/demo-set.txt`: Gutenberg LCC-P, the Wikipedia Mathematics, Physics, Chemistry
and Medicine minis, Wikipedia 100, and Golf with pictures, cached between runs), builds with
`--zims` and publishes it on every push to `main`; enable it once in the repository's Settings →
Pages → Source: *GitHub Actions*. The demo set makes a site of about 605 MB in 176,000 files
(Pages allows 1 GB).

### Your own ZIM files, without the server

"Open ZIM files…" under the library list (or dropping `.zim` files on the page) reads ZIMs from
your own device in the browser, in the online version as well as beside a server's libraries:
nothing is uploaded, and only the parts of the file a page needs are read, so even very large
files open quickly. A Wikipedia or Wikisource ZIM is indexed in the browser the first time (a
big one takes minutes on a headset) and the index is kept. The files stay open until the page
is reloaded; where the browser allows it (desktop Chrome and Edge, Quest Browser) the card
offers to reopen them. On a Quest, open them before entering VR.

A ZIM can also be read straight from the web, without downloading it: paste its address into
the field under the button (or drop its link on the page), or read the example from the card.
Kiwix's download links work: they are turned into the same file on Kiwix's own mirror,
`mirror.download.kiwix.org`, the one that lets a web page read its files (its other mirrors do
not). Only what is shown is fetched, a few kilobytes at a time: opening a Gutenberg ZIM takes a
few seconds, the 49 GB top-million Wikipedia about six. Web addresses reopen by themselves when
the page loads; a library's × closes it. A Wikipedia or Wikisource from the web needs a
prebuilt index unless it is small (building one reads most of the file).

## Measuring performance on a Quest

`/?perf` turns on a recorder in the page: every frame's timing, room switches, atlas painting,
page turns, long tasks and memory. `tools/quest-perf.mjs` reads it from the headset over adb,
together with the headset's own per-second numbers (FPS, stale frames, CPU/GPU load,
temperature), the browser's memory and the battery, and saves one JSON file in `perf/`. While
the scenarios run it also traces garbage collection, and shows per scenario how many dropped
frames happened during a GC pause.

Connect the Quest by USB (or adb over Wi-Fi), allow USB debugging for this computer, keep the
server running, then:

```bash
node tools/quest-perf.mjs run --open
```

`--open` opens `http://localhost:8080/?perf` in Quest Browser (through `adb reverse`). Put the
headset on and press **Enter VR**; the script then runs a fixed set of scenarios: standing in
the smallest room, gliding along the aisles of a 3,000-book room, switching filters, entering,
standing in and walking the all-libraries hall, and reading 20 pages; with a Wikipedia, also
walking its largest room and reading a volume, including its longest article. They take about
five minutes, move you around smoothly, and put your settings back at the end. If the open page has
no `?perf`, or was loaded before the app last changed, `run` reloads it first (you then press
**Enter VR** again), so the numbers always describe the current version. Use `--only
small-idle,read` to run some of them.

```bash
node tools/quest-perf.mjs dump
```

`dump` saves what was recorded while you used the library yourself (opened with `?perf`), and
`status` just checks the connection. `node tools/quest-perf.mjs --help` lists all options;
`--cdp http://127.0.0.1:9222` runs the same against a desktop browser started with
`--remote-debugging-port=9222` (with `?xr=emulate&perf` for an emulated headset).

[SPEC.md](SPEC.md) describes the module contracts (ZIM reader, content format, HTTP API, client
modules); [CLAUDE.md](CLAUDE.md) is a shorter architecture overview; [TODO.md](TODO.md) lists open
work.
