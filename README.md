# vrlbry

A virtual library for your ZIM files. vrlbry finds the `.zim` files in a folder and shelves their
books in a warm, candle-lit 3D reading room. Walk up to a shelf, pull a book out, look at its
cover, open it and read it page by page. It works in a VR headset (Meta Quest and other WebXR
browsers), on a desktop with mouse and keyboard, and on a phone.

It is built for [Project Gutenberg ZIMs](https://library.kiwix.org/) made by gutenberg2zim: you
get real covers, authors, popularity ranks and the books' own illustrations. Other ZIM files also
work; their HTML articles become the books.

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
| `--max-generic <n>` | max books listed from a non-Gutenberg ZIM (default 2000) |
| `--quiet` | print only problems and the address |

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
popularity, jump to a letter, pick a book at random ("Surprise me") and reopen recently read books.
The search box (desktop and phone) finds any book by title or author and takes you to it. Your
reading position, text size and theme are remembered in the browser.

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
  when it is not there.
- Dev pages: `/reader-test.html` (the page renderer as a 2D reader) and `/dev/world-test.html` (the
  room with an orbit camera).
- `/?xr=emulate` replaces WebXR with Meta's IWER emulator (a virtual Quest 3), so the VR controls
  can be exercised in a desktop browser. `window.__vrlbry` exposes the app for scripted tests;
  `__vrlbry.tick(dt, n)` advances frames manually when the page is not being painted.

[SPEC.md](SPEC.md) describes the module contracts (ZIM reader, content format, HTTP API, client
modules); [CLAUDE.md](CLAUDE.md) is a shorter architecture overview.
