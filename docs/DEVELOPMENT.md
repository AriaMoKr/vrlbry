# Developing vrlbry

The README covers running and using vrlbry; this is for working on it. [SPEC.md](../SPEC.md) is the
contract between the modules, [TODO.md](../TODO.md) lists open work, and
[CLAUDE.md](../CLAUDE.md) is a dense map of the code.

## Tests and dev pages

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

## The online version (GitHub Pages)

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

`--zim-files <folder>` instead puts the ZIM files themselves on the site: the page opens them
in the browser with every visit, reading them from the site as it reads ZIMs from the web, with
their indexes built at deploy time.

The workflow in `.github/workflows/pages.yml` runs the tests, downloads the demo set (the ZIMs
listed in `tools/demo-set.txt`: Gutenberg LCC-P, the Wikipedia Mathematics, Physics, Chemistry
and Medicine minis, Wikipedia 100, and Golf with pictures, cached between runs) and publishes it
on every push to `main`; enable it once in the repository's Settings → Pages → Source: *GitHub
Actions*. Each demo ZIM is on the site in its smaller form: LCC-P, Chemistry, Medicine and
Wikipedia 100 pre-rendered, Mathematics, Physics and Golf as ZIM files (the second word `file`
in the list), about 460 MB (pre-rendering all seven made 605 MB in 176,000 files; Pages allows
1 GB). The site also ships the prebuilt indexes this repository has (its release "indexes" and
the workflow's cache), as many as fit in 950 MB, and reads Kiwix's files through the edge proxy
when the repository variable `ZIM_PROXY` names one. It needs nothing from any other site.

## Reading ZIMs from the web

A Wikipedia or Wikisource read from the web needs a prebuilt index unless it is small: building
one reads most of the file. The site publishes those of `tools/indexes.txt` under `indexes/`:
`node tools/build-indexes.mjs --zims <folder>` builds them from local copies of the ZIMs into
`.indexes/` (or `--web`, from Kiwix's mirror), and the Pages workflow ships those it has, as many
as fit (see `.github/workflows/pages.yml`).

Kiwix's own mirror is in France, so from far away every read costs a long round trip. An
optional edge proxy, `tools/zim-proxy/` (a Cloudflare Worker), reads the mirror nearest each
visitor instead and adds the CORS headers the other mirrors lack: from California the top 1M
Wikipedia opened in 0.8 s instead of 2.4-4.3 s. It relays only parts of Kiwix's files, from
those mirrors, and only for the pages of the sites listed in `tools/zim-proxy/wrangler.toml`
(`ALLOWED_ORIGINS`). Cloudflare's free plan (no card needed) allows 100,000 requests a day;
past that the Worker answers an error and the page reads Kiwix's mirror directly, as it does
whenever the proxy fails. To deploy it with your Cloudflare account:

```bash
cd tools/zim-proxy
npx wrangler login
npx wrangler deploy
```

The deploy prints its address, `https://vrlbry-zim-proxy.<your subdomain>.workers.dev`. Set the
repository variable `ZIM_PROXY` to it (Settings → Secrets and variables → Actions → Variables),
and the next Pages build names it in the page. To try it before that, add
`?zimproxy=<its address>` to the site's address. `node tools/zim-proxy/serve.mjs` runs it on
this machine instead, for `http://localhost:8080/?zimproxy=http://localhost:8090/`.

Why only Kiwix's own mirror can be read from a page, and what the others would need, is in
[MIRRORS.md](MIRRORS.md).

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

`--open` opens `http://localhost:8080/?perf` in Quest Browser (through `adb reverse`). Press
**Enter VR** (the headset acts as if worn while `run` lasts: it overrides the proximity sensor
and gives it back at the end; `--no-prox` leaves it alone); the script then runs a fixed set of scenarios: standing in
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
