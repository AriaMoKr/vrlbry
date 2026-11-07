# TODO

- **Wikipedia ZIMs** (mwoffliner, `Source` = `*.wikipedia.org`; SPEC §2.5). The core is built
  (2026-10-04): detection, the index, volumes, articles converted on demand, the look. Decided:
  - Wikipedia is its own room of encyclopedia volumes. Each volume holds **1,000 consecutive
    articles**, and its spine shows its title range (e.g. "Aachen – Abbey").
  - Target the **maxi** ZIMs, which include images. English has ~6.8 M articles in ~110 GB,
    which makes ~6,800 volumes.
  - Articles are in the **app's title order** (`titleKey` + `Intl.Collator`, as in
    `util/books.js`), not the ZIM's byte order. The server sorts all titles once while indexing.
  - Each article starts on a **fresh page** (one chunk per article). A volume's contents list is
    its 1,000 article titles, with a thumb index ("Kad", "Kae", "Kal") beside it.
  - The index reads no article text: it reads every directory entry, then each page's HTML size
    (to drop mwoffliner's section-redirect pages and estimate lengths), sorts, cuts into
    volumes and caches in `.cache/`. Measured on this PC (2026-10-04):
    - Simple English maxi (2.9 GB, 285,214 articles): 56 s.
    - English top 1M maxi (`wikipedia_en_top1m_maxi_2026-04`, 46 GB): 999,593 articles in
      1,000 volumes, with 774,856 redirect pages skipped. 927 s (~15½ min): about 4 min for the
      directory scan, the rest mostly the size pass. The cached index is 10.7 MB.
  - **Articles = every non-redirect HTML entry** in the main namespace, except the ZIM's main
    page. That includes disambiguation pages (~4 %) and "List of …" pages. Skip images, CSS and
    scripts. Redirects stay out of the volumes, but article search could use them as aliases.
    Newer ZIMs also hold Category and Portal pages, which are left out (2026-10-06, SPEC §2.5).
  - **The look:**
    - One uniform binding for the whole set (e.g. deep blue cloth with gilt bands).
    - Uniform size: ~30 cm tall, 5 cm thick (~105 volumes per bookcase; English ≈ 65
      bookcases, one room under the 200 cap).
    - Spine: the volume number large at the top, the title range in the middle ("Aachen –
      Abbey", each end shortened to fit), "Wikipedia" at the foot.
    - Generated cover in the set's binding: "Wikipedia · The Free Encyclopedia", the volume
      number and range, with the ZIM's globe illustration as an emblem.
    - Volumes are numbered 1–N in title order. Bookcase plates show their first and last
      article ("Aa – Ac"), and the section sign reads "Wikipedia (English) · 6,800 volumes".
- **Wikipedia: the full English maxi** (`wikipedia_en_all_maxi_2026-08`, 119 GB, 30 M entries in
  293,473 clusters, 10.9 M HTML pages). Its first index build ran at ~400 pages/s in the size pass
  (~7 hours): each page re-read its directory entry (~1 ms) while a cluster's decompression
  (~6 ms) serves ~36 pages. Now the pass uses the scan's cluster/blob, decompresses several
  clusters at once, and resumes from a checkpoint (2026-10-06): ~28 min on this PC (scan 11½ min,
  sizes 16 min at ~10,000 pages/s, sort 17 s), at most ~1.8 GB in all (heap ~1.1 GB in the sort);
  a run stopped 4 % into the sizes resumed there. The cached index is ~100 MB. Its first count,
  9.67 M articles, included ~2.2 M Category and ~90,000 Portal pages, which are now left out
  (~7.3 M articles expected, ~7,300 volumes, ~70 bookcases). Next: open it in the app, and try
  its room on the Quest.
- **Merging back into the main site** (done on branch `merge-cloud`, 2026-10-10, for review;
  merge commit `cfc92f0`, then main's own workflow and the demo-set mix). The three Pages sites are flavours of
  one app; most of standalone's and cloud's features go back to main. Each site stays
  self-contained: none loads files from another (same origin or not), so any one can be removed
  without touching the others. Main keeps a demo set on the site itself, readable without Kiwix's
  mirrors or the proxy, and some prebuilt indexes, within GitHub Pages' 1 GB per site.
  - *The demo set measured* (pre-rendered as main's workflow does: 606 MB in 175,713 files, the
    app 4 MB): Golf (maxi) 216 MB pre-rendered against a 138 MB ZIM; Medicine 121 against 155;
    Mathematics 117 (81 MB of formula pictures) against 56; Physics 59 against 54; Wikipedia 100
    49 against 318 (the ZIM keeps every picture size); Gutenberg LCC-P 22 against 37; Chemistry
    19 against 24. Their indexes would be ~1-2 MB in all.
  - *Planned mix:* ZIM files for Golf, Mathematics and Physics (248 MB, read from the site itself
    by the local library: Pages answers range requests), pre-rendered Medicine, Wikipedia 100,
    LCC-P and Chemistry (210 MB): ~460 MB for the demo set, ~87,000 files instead of 175,700;
    with today's five big indexes (90 MB) ~550 MB in all. The pre-rendered half works without the
    worker; the files are the path an Android or Quest APK would use. Done: `tools/demo-set.txt`
    says which form each ZIM takes (a second word `file`), `build-pages.mjs --zim-files` ships
    the files with their indexes and names them in `api/libraries`, the page opens them with
    each visit (`site: true`: in the Demo set, not "Opened here"), and the workflow ships main's
    own prebuilt indexes within 950 MB (`build-indexes.mjs --ship --budget-mb`). Deployed
    2026-10-10 (main at e807c3a, then bc42ff5): the site 357 MB compressed (~553 MB) with the
    release's five big indexes and the demo set's three. *First visit on a Quest 3* (the live
    site, its localStorage cleared for the test and put back): the app up 1.6 s after the page
    was asked for, with the four pre-rendered libraries; the three ZIM files opened one after
    another, Golf at 4.8 s, Mathematics 6.2 s, Physics 9.7 s (all seven in the Demo set on 7
    bookcases); Quantum mechanics read from Physics in 1.3 s; 90 Hz; the page's process 239 to
    358 MB. The site's files now open at once (`openFiles`' `concurrency`, `openEach`: one batch,
    the hall rebuilt once): on the Quest (deployed at 15fbe0e) the app up at 1.5 s, Mathematics
    open at 5.0 s, Physics 5.3 s, Golf 5.8 s: all seven at 5.8 s instead of 9.7; Quantum mechanics
    read in 1.0 s; 90 Hz.
  - *GitHub Pages serves files over 100 MB* when a workflow deploys them (tested 2026-10-10 with a
    throwaway repo, pages-size-test: Golf's 138 MB and Wikipedia 100's 318 MB ZIMs, downloaded
    into the Pages artifact: whole sizes, range requests at both ends, the same bytes as Kiwix's;
    the app opened Golf from there and read Tiger Woods with its picture). Git's 100 MB limit
    does not apply: the files never enter the repo. Pages documents 1 GB per site, 100 GB a month
    of bandwidth and a 10-minute deploy timeout, no limit per file.
  - *A cold CDN cache costs seconds per big file* (tested the same day: Pages is served by Fastly,
    whose `x-cache`, `age` and `x-served-by` headers say which city's cache answered and whether
    it had the file). The first request for a file in each city (San Jose, Los Angeles, Burbank
    from here; the servers of a city share one cache) waits while Fastly fetches the whole file
    from GitHub, even for an 80-byte range: a 138 MB ZIM 2.1-3.8 s, a 318 MB one 4.4 s, a small
    file under 0.1 s. A range at the file's end does the same (3.6 and 6.6 s), and then every
    range of it, start and middle, is a hit (0.07-0.09 s): GitHub's Fastly service has no
    Segmented Caching (which would fetch and keep only the parts asked for), so files are cached,
    and presumably evicted, whole. Not tied to the deploy: 4 s after it 3.8 s, 15 min after 2.1 and 3.0 s, 45
    min after 2.7 s. Afterwards that city's copy stays: past its 10 minutes (`max-age=600`) it is
    only revalidated (~0.09 s), never fetched whole again (none evicted within the hour
    watched). So warming the cache after a deploy would not help: requests from the workflow's
    runner warm only the cities near it, and each city pays one miss per file per deploy (Golf:
    the app's first read of it waits ~3 s in a city that has not had it). Splitting the shipped
    ZIMs into parts would shorten that, but *decided* (2026-10-10): ZIM files stay exactly as
    Kiwix publishes them, the same size and hash (useful for caching across sites later);
    pre-rendering is the only transformation.
  - *After the merge* (2026-10-10): work goes on `main` directly; the standalone and cloud sites
    are parked (they served their purpose and may be used later), each still deploying from its
    own branch if pushed.
- **Links in books** (done 2026-10-10, SPEC §3.5). Tapping a link follows it: a Wikipedia's
  references and sections, Gutenberg's contents and footnotes and a Wikisource work's parts
  within the book (resolved as it is converted), a Wikipedia's other articles and a Wikisource's
  other works when followed (the library's `resolveLink`, the link route; a static build
  resolves them all beforehand). Another volume or work is swapped in (put back, taken out,
  opened at the place); "↩ Back", B/Y and Backspace go back along the links followed. Measured
  on the PC (dev server, Simple English): Einstein's 224 links resolve in 0.5 ms each; following
  one into another volume takes 3.6 s, most of it the put back / take out animations; within a
  book a link is a page turn (0.7 s). Wikipedia 100's static build resolved 1,485 links in its
  9 s. On a Quest 3 in VR (2026-10-10, 72 Hz): a link within the book 0.57 s, into another
  volume 3.6 s, back 3.5 s, 0.8-4.4 % of frames dropped; the hover mark costs under 0.1 ms. Later:
  - *Faster swaps:* following a link into another volume flies the book to its shelf and the
    other out (~3 s); a quicker exchange (the old volume vanishing onto its shelf, the new one
    arriving at once) may suit following many links.
  - *Fewer lookups over the network:* a link to another article costs a URL lookup and a title
    search (each a binary search: ~20 reads, ~2-6 s on Kiwix's mirror when nothing is cached).
    A link's `title` (mwoffliner writes it) could go straight to the title search.
  - *Other books' links:* Gutenberg links to other Gutenberg books, generic ZIMs' links between
    their articles, and EPUB links out of the book are dropped (in-book ones work).
  - *Long-press for where a link goes:* in VR a tooltip with the target's title before following.
- **Known issue: Vivaldi on a Pixel 11 shows a blank 3D view** (reported 2026-10-11). The page
  works (menus, toasts, the libraries load), but the 3D view stays the page's background. The
  debug report (with the GPU fields added for it) shows WebGL 2 on a PowerVR C-Series GPU (ANGLE
  on Vulkan), 20 draw calls and the room's colours read back from a drawn frame: drawn, never
  shown. A plain three.js demo (https://threejs.org/examples/#webgl_geometry_cube) is blank in
  Vivaldi too and works in Chrome on the same phone, as vrlbry does: Vivaldi's compositing of
  WebGL on that GPU, not the app. To report to Vivaldi with that demo. `?aa=0` (no antialiasing) and `?dpr=1` are left to try there; applying one
  automatically would need telling Vivaldi from Chrome, which on Android it does not say.
- **Prebuilt indexes, which next** (discussed 2026-10-11). Five of the 49 in `tools/indexes.txt`
  are built (Wikipedia 100, Simple English, the top 1M, Wikisource, the full English maxi), so
  Kiwix's library opens 22 of the 65 English Wikipedias from the web. Not all at once: every new
  Kiwix edition needs its own (monthly or so), and a build reads most of the file from the mirror
  (~60 GB for the list without the full English ones, ~65 GB more for those two). In order:
  1. ~~The compact format~~ (v5, done: a quarter of the size, SPEC §2.5).
  2. One flavour per selection, the maxi (reading from the web, the pictured one is the one to
     read), and the 18 topics' maxis: small indexes, mostly mirror bandwidth. *Ready
     (2026-10-11):* `tools/indexes.txt` lists the maxis first (20 missing, 33 GB of files), and
     Kiwix's library leaves out a selection's flavours that need an index once one of its
     flavours opens (`listed`). Cricket's built from the mirror here: a 0.1 MB index, 0.20 GB
     read in 212 s; at that rate the 20 maxis read ~17 GB in ~5 hours: one or two runs of the
     workflow with "prebuilt indexes" ticked (a stopped build resumes). Then 43 of the 67
     English Wikipedias and Wikisources open from the web (23 now), every selection by at least
     one flavour. *Run (2026-10-11):* one run built all 20 within its 5 hours and the site
     shipped 28 indexes; within the week Kiwix published October editions of 11 of the topics
     (chemistry, comics, cricket, geography, history, ice hockey, Indian cinema, molcell,
     physics, sociology, tennis), so on 2026-10-17 32 of the 67 open (15 by the site's index, 17
     built in the browser) and those 11 maxis (8.2 GB) need building again. Topics are
     republished every three months or so, so keeping up means a run per batch of new editions
     (the release holds what outlives the 7-day Actions cache). *Second run (2026-10-18, its
     full 5 hours):* the 11 October maxis built again, and 7 nopics and minis with them (step
     3), so the site ships 35 indexes and 50 of the 67 open (33 by the site's index, 17 built in
     the browser), every selection by at least one flavour. The 19 new indexes (9.3 MB) go
     into the release.
  3. The nopic and mini flavours later, if at all: they help those who downloaded such a copy
     and open it from their device (the site's index saves them a build in the browser).
     *Started (2026-10-18):* the second run above built Medicine nopic, the top and top 1M minis
     and nopics, and Simple English's mini and nopic. Left in `tools/indexes.txt`: 14 topic
     nopics and Wikisource's nopic (15 files, 14.8 GB), about one more run. The full English
     mini and nopic (14 and 53 GB) are not listed. *Third run (2026-10-18, its full 5 hours):*
     built nothing. Wikisource's nopic came first among those left and did not finish from
     Kiwix's mirror in 5 hours (the first run had ended on it too), and a Wikisource build has no
     checkpoint, so each run starts it again from nothing and the 14 topic nopics after it never
     come. It is now last in `tools/indexes.txt`; to build from a downloaded copy (`--zims`, a
     few minutes) and upload. Possibly later: a checkpoint for Wikisource builds, as Wikipedia's
     sizes pass has. *Then (2026-10-18):* Wikisource's nopic built here from a downloaded
     copy (108 s, 3.0 MB) and uploaded. The builds now have a workflow of their own
     (`indexes.yml`), apart from the deploys, which a run of 5 hours held back (a push waited for
     it), and they go the quickest first (`buildOrder`: Wikipedias by article count, Wikisources
     last), whatever the list's order. *Fourth run (2026-10-18, the first of `indexes.yml`):* built all 14 topic
     nopics in 2 h 36 min, saved them in the cache and deployed: the site ships 50 indexes, and
     every edition in `tools/indexes.txt` has one. The 14 (3.1 MB, taken from the site) go into the
     release.
  4. New editions rebuilt by the workflow when Kiwix's catalogue lists them, so the shipped
     indexes do not go stale one by one.
- **URL parameters for testing, and for settings** (asked 2026-10-11). Today there are a few,
  scattered (`?xr=emulate`, `?perf`, `?hz=`, `?roomcap=`, `?zimproxy=`, `?atlas=gpu`, `?aa=0`,
  `?dpr=`), read where each is used. Wanted:
  - *Library loading turned off, part by part, for testing:* the site's own ZIM files, reopening
    the remembered web addresses and files, the prebuilt indexes, the block cache (IndexedDB),
    the edge proxy (the built-in one, not only another set with `?zimproxy=`), Kiwix's catalogue,
    the server's libraries. Each optional layer (TODO, milestone 3) then has a switch that shows
    the page working without it.
  - *Opening straight into a place:* a given library (by id or ZIM name), room (genre, letter,
    page), sort, and a number of books (only the first n of a library; `?roomcap=` caps a room).
    *Place and room done (2026-10-18):* `?place=<id>&genre=&letter=&page=`, which the address
    now shows as the room changes (`place-url.js`); a link opens there. Left: sort, the first n.
  - *What the page keeps (asked 2026-10-11), three switches:* ignore it (read nothing, write
    nothing: every load is a first visit, and nothing of it stays), read but do not write (try
    things on top of the saved state without changing it: `util/storage.js` `freezeStorage` from
    the start), and clear it (what "Reset stored data" does, `reset.js`; which parts, all by
    default?), the parameter then taken out of the address (`history.replaceState`) so a reload
    does not clear again. To decide: whether IndexedDB (files opened, indexes, the web cache)
    follows the same switches or has its own; and a visible note while saving is off, so a tester
    knows why a setting does not stick.
  - *Possibly as settings/preferences:* the same names as a link that opens a library sorted by
    popularity, say, or a page of the help dialog. To decide: whether a parameter overrides the
    saved settings for this visit only (a test link must not change the visitor's own place or
    sort), and one module that reads them all, listed in the developer notes.
- **Reset stored data** (done 2026-10-10, `reset.js`, SPEC §5.6). The help dialog's "Reset stored
  data…" and the kiosk's "Reset…" offer four parts to clear or keep (settings and reading; files
  and addresses opened here; the indexes, kept by default; the web cache), then clear them and
  reload. On a Quest 3 in VR (2026-10-10): the kiosk's form fits and toggles, Cancel leaves it,
  and Clear and reload with the settings alone cleared them and kept the handles, indexes, cached
  blocks and remembered address; the page was back in 1.4-7.6 s (as polled over DevTools), out of
  VR, after a head-locked "Clearing stored data" notice (seen in the headset's screenshots). Possible later: each
  part's size (`navigator.storage.estimate()` gives only the total).
- **The kiosk opens on its Kiwix tab** (done 2026-10-10): the page starts on Kiwix's library,
  more to read being what a new visitor most likely wants. Possible later: remember a returning
  visitor's last tab.
- **Garbage collection pauses** are now the main source of dropped frames on a Quest 3. The
  atlas stalls are fixed (run 2026-10-05 03:37: walking the hall 9.1 % → 0.1 % dropped, an
  ordinary room 5.4 % → 1.8 %, no drop before an atlas arrived, down from 343 of 406), and of
  what is left, GC pauses were in 35 of 44 dropped frames walking an ordinary room, 72 of 86
  switching filters, and 61 of 68 entering the all-libraries hall (its rebuild).
  *2026-10-10, step 1* (a sampling heap profile per scenario over DevTools, objects already
  collected included): standing still allocated 4.1 MB/s, a filter switch 29 MB/s, entering the
  hall 420 MB in 2.3 s. Most of a still frame was three rebuilding the kiosk's program parameters
  4 times a frame (a transparent double-sided material is drawn in two passes, flagged
  needsUpdate around each, per eye: `forceSinglePass` on panels and rings); most of a room switch
  was the books' geometry pushed into growing arrays with a few dozen small arrays per book (now
  written straight into typed arrays: identical geometry, checked attribute by attribute). Also:
  hit tests, hover, controller polling, the teleport arc and the atlas LOD ranking reuse their
  objects; `behindRow` lost a destructuring for…of; windows are triangulated once per size; a
  book's box is made when a ray needs it; `hash01` hashes without joining strings; the author
  sort key is made only when sorting by author. Allocation after: standing still 2.3 MB/s (most of
  the rest is Chromium's WebGL bindings for three's uniforms: per draw call and eye), a filter
  switch 7 MB/s, entering the hall 63 MB. Runs (the dev server's four ZIMs and a 60,000-book
  Gutenberg from the web; `perf/quest-2026-10-11_*`): dropped frames 250 → 206 (1.4 → 1.2 %), GC
  pauses 324 → 217, dropped frames in a GC pause 161 → 113; room-walk 36 → 28, filters 74 → 57,
  entering the hall 41 → 28. Caching book sizes per book made it worse (a WeakMap entry per book
  of every library: the full collections grew longer); sizes are computed without objects instead
  (`bookWidth`). What is left: about one full collection (MajorGC) per scenario, 25-45 ms, after a
  room switch, when the previous room's records, packed items and geometry arrays become old
  garbage together.
  *Step 2* (a V8 trace of the GC sub-phases, and Blink's): in those pauses marking took 10-15
  ms, 5-8 of it ephemeron marking (a WeakMap's entries, done in the pause), with the heap at 60-68
  MB after collection. The sort keys' WeakMap held an entry per book (80,000): the keys now live on
  the book under a non-enumerable symbol (skipped by JSON, structuredClone and spreading), and the
  overlay's search index (an entry and two strings per book, made with every catalogue, in VR
  too) is made at the first search. Heap after collection 47-54 MB; pauses of 12 ms or more in
  the traced scenarios 9 → 3. Runs (`perf/quest-2026-10-11_*`, baseline → step 1 → step 2):
  dropped frames 250 → 206 → 179 (1.4 → 1.2 → 1.0 %), GC time 867 → 827 → 665 ms, dropped frames
  in a GC pause 161 → 113 → 93; room-walk 36 → 28 → 19, filters 74 → 57 → 48, the hall 41 → 28 →
  28, reading 45 → 48 → 40; the longest pause per scenario now mostly under 15 ms (was 20-49).
  What is left: young-generation collections landing on busy frames while a room is rebuilt
  (filters 34 of 48 drops, entering the hall 23 of 28, mostly behind the fade), and ~1-2 MB/s
  allocated per frame inside three's uniform uploads (per draw call and eye: fewer draw calls,
  or multiview, would cut it). Possible next: the room's furniture made once (chandelier, globe,
  reading corner: ~8 MB a switch), and less kept per room (the position copy for hidden books,
  smaller vertex types).
- **Reading: dropped frames while pages are prepared.** Reading in VR on a Quest 3 (2026-10-06,
  a local ZIM, step 2) dropped 2.6–2.7 % of frames at 72 Hz, while page turns themselves stayed
  smooth (1.3 %). The drops cluster where the reader prepares the next spreads on the main
  thread: 41 of 189 during layout steps (3.7 s of 100: about 6× the rate elsewhere), about half
  within a few frames of a page being drawn (4.5 ms typical, 16.6 ms worst), and one gap of
  ~100 ms when a book opens (its first chunk laid out and drawn at once). Not yet traced for GC
  (`quest-perf dump` does not; `run`'s read scenario does). Ideas: smaller layout steps while in
  VR, drawing pages in a worker on an OffscreenCanvas (as the spine atlases are), and showing
  the first spread before the rest of the first chunk is laid out.
- **Reading: a single-page view** (asked 2026-10-18). *Done (2026-10-18; SPEC §5.6 "One page or
  two", `reader/spreads.js`):* one page at a time, the page alone (the book's left half hidden
  once open, not a blank page beside it: asked 2026-10-18); a turn is the book's own leaf turn, one
  page at a time, the page going as it passes edge-on (a sliding page would have needed a second
  animation and looked wrong on a 3D book in VR). By
  default on a flat screen taller than wide (`settings.pageView` 'auto'); the toolbar's "1 page" /
  "2 pages" and P switch at the page being read, and an open book follows a phone turned. Page
  counts, the saved place and the pool of 6 canvases are unchanged (a spread's left canvas holds
  the blank). On a phone upright the page now fills ~90 % of the width (text ~1.9× as large as in
  the spread); on a wide window it is ~1.7× as large. Fixed with it: on a phone the toolbar was
  cut off at both sides and the contents were off the screen beside the book (now scaled to the
  width and shown over the page). Left: try it on a real phone and on the Quest (whether VR
  should default to it too).
- **A door back to the Hallway** (asked 2026-10-18). A door in the library, like the
  doors of the Hallway (https://ariamokr.github.io/hallway/), leading where the way out leads
  (`hallway.js` `wayOut`): the Hallway (`?from=vrlbry`, so the visitor arrives at this library's
  door) unless the link that brought them names another place (`?back=`, `?backname=`), its name
  then on the door. Through it in VR the visitor stays in VR (one origin: SPEC §5.7). To look at
  first: the Hallway's door (frame, sign, how it is entered: walked through or clicked) and where
  one fits in the rotunda and in the hall.
  *Done (2026-10-18; SPEC §5.3 "The door", §5.6):* `world/door.js` and the Hallway's portal
  shader (`world/portal.js`), against the wall behind the spawn point in both room shapes, a
  painted view down the Hallway through it, its plaque and sign in the Hallway's enamel; walked
  through, clicked or triggered, it fades and leaves (`interaction.leave`), and Back to a cached
  page puts the viewer in front of it again. Checked in the browser (both rooms, pointing, walking
  in, coming back) and on a Quest 3 (`quest-perf handover` through `leave`: 2 of 2 in VR). Not yet
  looked at in the headset by a person, nor measured with `quest-perf run`. *The view through it (2026-10-18):* the
  Hallway now renders and publishes the view out of each of its doors (AriaMoKr/hallway,
  `tools/door-views.mjs`, `views/views.json`), and the door shows vrlbry's (across the hall to the
  door opposite, as one would see it standing in that doorway); the painted view stays for when it
  cannot be read. To do there when the hall changes: run its tool again.
- **The Hallway's door contract, the rest** (its README, "Going in"; reported 2026-10-19).
  *Done (2026-10-19):* the way back from the Hallway's door says Hallway and shows its view
  (`hallway.js`); the VR movement choice is the Hallway's `hallway.nav`, shared both ways
  (`nav.js`, with smooth turning and left-stick teleporting); the shared session (`room`) is
  joined and the others in the same room of the library are drawn (`together.js`, SPEC §5.6
  "Together"), and the way out carries it on. Checked in the emulator and in two browser tabs
  (join, avatars from the other tab's pose, rooms apart, Leave, leaving and coming back). Not
  yet: in two headsets; starting a session here and an invite link (the Hallway's panel does
  it); names and waves (the Hallway's); the arrival pose the door sends (`dx`, `yaw`, `pitch`:
  arriving where the view through the door was taken), and taking the visit's parameters off
  the address once read (`back` is kept, as the way out reads it on a reload).
  *Shared packages (2026-10-21):* the door contract and the movement choice now come from
  AriaMoKr/common v0.1.0 (`door.js` `wayBack`, `hallwayViews`, `leaveUrl`; `nav.js`), the
  avatars from layersharedsession v0.2.0 (`avatars.js`), and the door id is one constant
  (`config.js` `DOOR_ID`). `leaveUrl` also fixed the way out after Leave, which kept the room the
  Hallway's link had. Still for later: common's `readVisit` (the arrival pose) and `withoutVisit`.
  *common v0.2.0 (2026-10-21):* the door's portal is common's (`portal.js`, `setView`;
  `world/portal.js` gone) and the gamepad's pieces too (`gamepad.js`; vrlbry's `readPad` stays).
  Checked in the browser: the Hallway's view through the door, its veil and glow; a stand-in pad
  walking, looking, its dead zone and A.
  *common v0.3.0 (2026-10-22):* the windows and the oculus show its afternoon sky (`sky.js`), the
  candles as they were. On a Quest 3, the same scenarios before and after (a synthetic 500-book
  library for the rotunda with windows): rotunda idle 70.5 → 71.2 fps (dropped 2.2 → 1.2 %), hall
  walk 71.6 → 71.7, all-libraries idle 68.3 → 69.0, all-libraries walk 72 → 72: one run each, no
  cost. Painting the panorama: 45-68 ms there, once. `public/social.jpg` and
  `docs/social-preview.jpg` taken again (2026-10-23): the same aisle, the afternoon in its window.
  *common v0.4.0 (2026-10-23):* the comfort settings (`access.js`, `hallway.access`) on the kiosk
  and in the help dialog; less motion cuts the eased moves, blinks the fades and holds the door's
  shimmer (the cover and page turns still move, as chosen); the vignette from smooth walking and
  turning; seated lifts the eye in VR. Checked in the browser and the emulator, and a Hallway
  choice holds after a reload. On a Quest 3 with the vignette forced fully closed all the time:
  rotunda idle 71.1 fps (dropped 1.2 %), hall walk 71.7 (0.4 %), all-libraries walk 72 (0 %),
  the same as without it. (A first run, in a long session, showed the hall walk at 60 fps and
  16.6 % dropped; repeated on a fresh page with the vignette still closed, it was 71.7 and 0.4 %.)
  *common v0.5.0 and layersharedsession v0.3.0 (2026-10-25):* the browser's Back is common's
  `BackHistory` (`prefix: 'vrlbry'`, so the entries in visitors' tabs stay its own; vrlbry's
  own tests passed against it before they went), and the shared session the layer's controller
  (`createTogether`), vrlbry's `together.js` keeping its space, its words and `setSpace`.
  quest-perf's `--cdp` became `--desktop`: a Chrome window of its own (common's
  `launchChrome`), drawing while covered (Chrome otherwise counts a covered window hidden: the
  first run waited for frames), closed at the end, also on Ctrl+C now (and the headset's sensor
  given back). The Pages and indexes workflows run on Node 24. Checked in the browser: Back
  with a book out and a link followed (the real button); two tabs in one session (in one room of
  the library each draws the other and counts them here; in different rooms neither is drawn,
  and each counts the other "elsewhere in the library"); `quest-perf status` and `run --only
  small-idle --desktop` (59.7 fps), the bad-password count 0 before and after. A profile can
  outlive `close()` when Chrome's helpers still hold its files (in `C:\msys64\tmp` under MSYS2,
  which nothing cleans).
- **Phones and screen readers** (reported 2026-10-23; done the same day). The library card did not
  scroll on a phone held sideways (667 × 375: 405 px tall on 375), so its last links were cut off;
  it now scrolls within the screen and, on a short screen, stops above the buttons at the foot,
  beside a search box that no longer covers it. The search box is a combobox with a polite result
  count, so a screen reader hears the highlighted result as the arrow keys move it. Checked at
  667 × 375 (every control in the card reachable and uncovered, axe clean) and 375 × 667, and in
  the accessibility tree ("Chemistry": "14 results", ArrowDown through each).
- **The text view** (requested 2026-10-23; done the same day; SPEC §5.8). The open book's part as a
  page of text on a screen: T, "Text view", or "Open books as text" in the help. It shares the
  reader's place with the 3D book: the 3D book follows the view's scrolling once it rests, so
  closing, a size, Back or a turn start from where the reader is. T now opens it, C (and a pad's
  X) the contents.
  - Checked in the browser:
    - a keyboard-only walk from the search box: open, T, a link and ↩ Back, the contents (1000
      articles, focus on the current one), Previous and Next part, PageDown, A+, the themes, Esc,
      and Put back (focus to the search box);
    - axe clean in paper, sepia and night, with and without the contents;
    - no sideways scroll at 320 × 568 (a two-row toolbar) or at 320 × 200 (400 % zoom; the
      toolbar slides away);
    - Enter VR closes it.
  - Not yet: a real screen reader (NVDA, VoiceOver, TalkBack), and a phone in the hand.
  - The saved position is still the 3D page's first block, so a reload opens the view at the top
    of that page, not at the exact block.
  - Fixed 2026-10-24: the place landed under the toolbar on opening (about three lines hidden),
    since the toolbar's height was read while the view was hidden (0); it is now set before each
    jump. And a book picked from the search is said ("…, in your hands. Enter reads it, T as
    text, Esc puts it back."), and T reads it straight into the view. Checked with the keys on
    "The Principles of Language-Study": the place starts at the toolbar's edge on a first opening
    and on reopening.
- **The browser's Back puts the book away** (requested 2026-10-24; done the same day; SPEC §5.6,
  "Links"). A book leaving its shelf now adds a history entry of its own under the links' ones,
  so Back goes back along the links followed and then puts the book away (it left the page
  before). Put back, Esc, B and Reset view take the entries out.
  - Checked in the browser with `history.back()` (the same popstate): a book only taken out; one
    being opened (cancelled); one read with a link in its volume and one into another volume
    (back, back, put away); Put back from the page; a book from search while another was open,
    with less motion.
  - The browser's own button checked the next day: a book picked from the search with the keys,
    opened as text with T, Back: put away, the view closed, the page kept. (Also reported working
    from a link in the text view.) Chrome's button skips entries a page added before any user
    gesture ([history manipulation intervention](https://chromium.googlesource.com/chromium/src/+/127.0.6533.99/docs/history_manipulation_intervention.md));
    a book always comes out after one.
  - The address: a room changed while a book is out (a link into another room's volume) changed
    only the entry then current, so Back showed the earlier room's address. Back and Forward now
    put the address right on the entry they land on (`main.js`, checked the same way).
- **The TV remote** (requested 2026-10-24; SPEC §5.9). The library in the Hallway's Android TV app
  (AriaMoKr/HallwayApp), walked and read with the remote: common v0.6.1's `tv.js` and the
  library's `ui/remote.js`. Checked in a browser with `?tv=emulate` and real key presses
  (2026-10-25, 2026-10-26; SPEC §5.9, Tests). On the TV itself (a Sony BRAVIA, over adb, the
  debug build of HallwayApp), the TV's session went through it with the remote (HallwayApp's
  README, "Behind the doors"; reported 2026-10-26): taking and reading a book, its buttons in
  the card, the stand's lists, the text view and Back one step at a time work; TalkBack reads
  the view and the card, and its channel and media keys walk. 60 fps with a book open, 57.5
  among the full shelves and 53.5 at the way in (the pixel ratio 2 at most, as the Hallway's).
  - Its four awkward things, done 2026-10-26 in a browser, for that session to check on the TV:
    Menu's first stop is no longer the search box (the Controls help, or the book's buttons),
    and the TV's keyboard stays down on a text box until OK (common v0.6.1, and the boxes the
    page focuses); ↓ takes the focus into the search's results, so OK opens one; ↓ past the
    text view's toolbar goes to a link on the screen, not the part's first; the walking hint
    has the TalkBack line.
  - ↓ in the search's box before its results had come (seen 2026-11-03, with a word only
    Wikipedia's articles match): it closed the list, dropping them, and went on to the Controls
    help. Now it waits in the box while they are on the way ("Searching…", `aria-busy`, 10 s at
    most) and goes to the first when they come (done 2026-11-03 in a browser, SPEC §5.9; for
    that session to check on the TV). It waits for the full-text hits too (2026-11-04).
  - A result with the focus kept its place in the list when the articles came, not the result:
    the books were cut to 6, so the focus on a 7th to 12th book went to an article, and a
    desktop's highlight went back to the first. Now the result stays, and a book after the 6th
    keeps every book listed (done 2026-11-05 in a browser, SPEC §5.6, §5.9; for that session to
    check on the TV). A full-text hit with the focus stays too when the articles come after the
    hits (2026-11-06).
  - Reading in 3D the spread is small on a TV (the reading pose of a desktop screen); the text
    view is the readable way for now.
- **The text view and the 3D panel on common's** (requested 2026-11-01; done the same day; SPEC
  §5.5, §5.8). common v0.6.1 → v0.8.1: `ui/panel.js` went for common's `panel.js`, and the text
  view is common's `TextView` with the library's book in a subclass (`ui/text-view.js`), as
  outside's and music's are to be. With it the first `tsconfig.json`: tsc in `npm test`, a file at
  a time (28 files with `// @ts-check`, the subclass first; CLAUDE.md, "Types").
  - New to the view: each theme's `color-scheme` (night's `dark`; it was `dark` in all three), A−
    and A+ named "A− smaller text" and "A+ larger text" (axe's `label-content-name-mismatch` found
    the old names), the place kept through a change of width, and the view put at its place again
    a frame after it opens. New to the panels: nothing allocated per ray, `set` drawing again only
    on a change, and a slider's mark cleared when the pointer leaves.
  - Checked live in headless Chrome (common's `launchChrome`; the bad-password count stayed 0),
    beside the old code (`eb0dfab`), with real keys, clicks and wheel turns: open and close at the
    place (the focus back on "Text view"), A+, A− and the themes, ← and →, the contents, a link
    and ↩ Back, the parts; 1280 × 800, 375 × 812, 740 × 360 and 320 × 256 with no sideways
    scroll and the toolbar sliding away on the short two; 1280 → 375 → 1280 twice with the same
    block at the top (the old code lost it at 375); `?tv=emulate` (the view keeps the focus, ↑ ↓
    scroll, Menu to the toolbar and out, OK to a link on the screen, Back to walking); the 3D
    toolbar, slider, contents scroll bar and tooltip by pointer, and with `?xr=emulate` by a
    controller (entering VR closes the view); axe with `label-content-name-mismatch` on: nothing,
    in the three themes, with and without the contents.
  - Not yet: a real headset, and the TV (that session's).
  - Seen alike before and after, and fixed after it the same day: a theme stood the 3D book a page
    back (1:18 → 1:8 → 1:0 at the first two, the view still at block 26, until the reader
    scrolled). It found the spread again from the page read, and pages pair by their number,
    estimated before the part read until its layout is in (≈31, then 31 when it was in): now the
    spread shown is drawn again as it is (`_redraw`; SPEC §5.2), in the 3D book (N) too. And ↩
    Back in the view, which hides itself at the trail's last step, dropped the focus to the page
    (`body`): it goes to the view's home (the title; on a TV the view, where walking again put it
    before; SPEC §5.8). The card's A− and A+ (a TV's) are named as the view's now. Checked live
    as above (a theme, N three times: the same spread, each in its own paper; the last Back, on a
    screen and with `?tv=emulate`), and the view's Back by a test. The card's ↩ Back on a TV is
    left as it is: its last step goes back to walking, as SPEC §5.9 has it.
- **↩ Back to the reader's place in the text view, common v0.8.3** (requested 2026-11-02; done
  the same day; SPEC §5.2, §5.8). A link followed from the middle of a part, with the view open,
  came back to the page's first block (Jespersen's *Language*, chapter III's part, from 164 px
  into block 3 to block 0): the trail kept only the 3D page. Its step now keeps the view's place
  as well (`view`, the block the shell brought the 3D book to before the link), which Back and
  the browser's Back aim the view at; in the 3D book alone Back goes to the page, as before.
  Nothing more was needed from common's shell. common v0.8.1 → v0.8.3: the view stays at its
  place while the 3D book's pages shown again show it (v0.8.2), and its own smooth scrolls leave
  the toolbar of a short screen in sight (v0.8.3).
  - A test: the trail itself (interaction.js) with common's shell, a stand-in reader and 3D turn;
    Back, the browser's Back, another font size, the view closed, a link of the 3D book's own.
  - Checked live in headless Chrome (the bad-password count stayed 0): at 1280 × 800 a link from
    the middle of a part and ↩ Back by its button, by Enter and by the browser's Back, each time
    the block left at the top (the reader was 164, 300 and 250 px into it); at
    740 × 360 A+ and A− clicked with the toolbar shown leave it shown; with `?tv=emulate` axe
    finds nothing with the card's book buttons out (the book in hand and open). The earlier
    checks (place, link, sizes, width, TV, themes, axe) as before.
- **The reader's line in the text view** (requested 2026-11-03; done the same day; SPEC §5.8). The
  view's place was a block, `{ c, b }`, and a block can be screens tall: wherever the view put the
  reader back (A+, A−, ↩ Back, a theme, a turned phone, opened again), the block's top came to the
  top, however far down it they were (Jespersen's *Language*, chapter III, block 27: 2,673 px at
  375 × 812 here). The place is now the block and the first word on the line at the top,
  `{ c, b, w }`, as outside's is (`placeAt`: `wordStarts`, `firstWordBelow` and a `Range`;
  `placeTop`: the top of that word's line), kept by `aim` and `placeAimed` and on the trail
  (`_here`'s `view`); the 3D book still goes to the block's page. Nothing new from common.
  - Tests: a block's words and the first in sight; over a layout of a 600-word block, A+ and A−,
    and a link then ↩ Back and the browser's Back, each bring the same word's line back to the
    top. Each part of the fix taken out in turn fails them.
  - Checked live in headless Chrome beside the code before (56d2e1c; the bad-password count
    stayed 0): at 375 × 812, from the middle of block 27, A+, A−, sepia, the phone turned to
    812 × 375 and back, Close and Text view again: the reader's word 0 px from the toolbar's foot
    after each (before: 598 to 1,608 px below it, the block's top at the top). At 1280 × 800, a
    link from 164, 377 and 470 px into block 3, then ↩ Back by its button, by Enter and by the
    browser's Back: the reader's line back at the top each time (before: 166, 382 and 463 px
    below). axe swept through the view (six places from top to end, and the contents) in each
    theme at 1280 × 800 and 375 × 812: nothing. The earlier checks as before; at 740 × 360 A+
    and A− keep the toolbar shown and now the line, within block 60.
- **Full-text search** (kiwix-serve's built 2026-10-18 and 2026-11-04, in the app since
  2026-11-06; SPEC §3.7, §4, §5.6; the measurements and the options in docs/SEARCH.md). With
  `--kiwix-serve <url>` the search lists hits in the text of the libraries whose ZIM kiwix-serve
  serves too, and a hit opens its book at the paragraph. Libraries opened in the browser and the
  GitHub Pages site get none: for them the ZIMs' Xapian indexes must be read in the page
  (`core/zim/xapian.js`, experimental, not used by the app yet). Next:
  - The Quest: `public/dev/xapian-test.html` there, over Wi-Fi through the proxy.
  - A stemmer for the browser (a full-text index holds Snowball-English stems): `porter2`
    wrapped as a module, or Snowball's English ported (BSD).
  - Common words: better candidates than the first 20,000 in document order ("declaration of
    independence": its rarest stem is in 59,000 pages, past the 20,000 taken).
  - Into the app: full-text search of the libraries opened from the web or from files (in the
    local library's worker), beside kiwix-serve's for the server's; snippets from the page's
    text (as `find` does), titles from the path or the title value.
  - Not done with kiwix-serve either: the kiosk's Search tab (VR) shows no text hits, the words
    are not highlighted on the page, no "more results".
- **The kiosk's search when the libraries change.** The overlay's list is made again when the
  libraries or their books change while it shows (`overlay._relist`, 2026-11-06: the main site's
  own ZIM files open a few seconds after the page, ~10 s on a Quest). The kiosk's Search tab (VR)
  is not: a query typed meanwhile keeps the results of the libraries it was typed for until it is
  typed again. `interaction.setCatalog` could run `_runSearch` again for a query shown.
- **The site's ZIM files carry two dates.** GitHub Pages' CDN gives each of the site's ZIM files
  one of two Last-Modified dates, 2 s apart, by the node that answers (2026-11-07, 1.5 h after a
  deploy: 03:33:46 and 03:33:48 GMT for all three, from nodes at San Jose, Los Angeles and
  Burbank alike; the ETag holds the date too). `HttpSource` takes an answer dated otherwise than
  the probe for a changed file ("the file changed on the server: open it again"), so a page whose
  reads reach two such nodes cannot read the file. A browser's reads go over one connection; it
  showed here through a local proxy whose reads went over several (the golf ZIM's articles were
  not found, and a file never opened). Whether one connection can meet both dates (a node
  fetching the file again once its copy is 10 minutes old, a connection made again) is not
  known. The block cache keys reads by the date too (`block-cache.js`), so a visit that probed
  the other date reads anew. To decide: dates within a minute or so as one edition (a deploy
  takes minutes, a new edition at a mirror's address comes days later), or the site's own files
  checked by size alone (each deploy uploads the same bytes).
- **All-libraries hall draw calls.** On the Quest: 380 → 104 standing (both eyes), 142 → 56
  walking, with one draw call per sign and no books drawn behind a nearer row. The room itself
  (chandeliers, walls, wainscots, ~31 calls per eye) could still be merged per material.
- **Server code review.** An earlier review recorded 5 minor findings that were never fixed, and
  3 of its reviewers never finished.
- **Update banner after a deploy** ("This site has been updated", `showUpdate` in main.js and
  overlay.js). Reported 2026-10-06 after deploying `e4a69f5`: the banner "didn't go away after
  10 seconds". By design it has no timeout: it stays until Reload, × or Don't show again. To
  check: whether it comes back after a reload of the new version (it should not: the page's
  `api/version` then matches), whether a reload during the deploy (new `api/version`, old files
  still served or cached) leaves a page that keeps seeing itself as outdated, and whether it
  should hide by itself once the page is current.
- **Low priority: PDF-only Gutenberg books.** Some books exist in a Gutenberg ZIM only as PDF
  (91 of the 56,424 in `gutenberg_en_all_2023-08`, mostly LaTeX-typeset mathematics such as
  *Calculus Made Easy*): they stand on the shelves but cannot be read ("This book has no readable
  text in the archive"; the server logs "N book(s) have neither HTML nor EPUB"). Ideas:
  - say so plainly: "N books are PDF only (not readable here)", in the log and on the book;
  - leave them off the shelves, or mark their spines, so that nobody takes one out for nothing;
  - show the PDF: pdf.js drawing each page onto the book's pages (a large library, and PDF pages
    do not reflow to the book's page size).
- **Possible: audio in Gutenberg books** (counted 2026-10-18). Of the local ZIMs only
  Gutenberg's has audio or video: `gutenberg_en_all_2023-08` holds 6,586 files (about 1 GB) in 402
  books, nearly all MIDI (4,465, 6.4 MB) and MP3 (2,069, 942 MB), plus a few M4A, Ogg, WAV, AVI
  and MPEG. Wikipedia `top1m_maxi` and Wikisource declare no audio or video type.
  - *How the books use them:* links in the text (`<a href="music/music011.mid">`), not `<audio>`
    (which `html.js` drops anyway). The converter keeps them as links, and since a Gutenberg link
    resolves only within the book (`resolveLink`), tapping one says "Not in this library", though
    the file has it.
  - *Where they are:* the class ZIM `gutenberg_en_lcc-m_2026-03` (Music, 3.99 GB) holds about
    70 % of the files and 79 % of their bytes (103 books: 2,932 MIDI, 1,750 MP3, 744 MB;
    *Principles of Orchestration*, *The Complete Opera Book*). The next are `lcc-g` (479 MIDI),
    `lcc-e` (251) and `lcc-pz` (203 MIDI, 88 MP3), mostly folk and traditional songs. The tests'
    reference ZIM `lcc-pe` has 14 MP3s in one book (*The Haliburton Primer*), and `lcc-pm`
    (0.05 GB) 8 MIDI files. Kiwix's current class ZIMs carry the files themselves.
  - *Ideas:* play MP3 (and M4A, Ogg, WAV) through the browser's `<audio>` or WebAudio from the
    entry's bytes (the server already answers `Range` requests on `/zim/`); MIDI needs a
    synthesizer (no browser plays it), so at most a small soundfont player, or nothing.
- **Possible: more in "Copy debug info"** (`debug-info.js`; it has browser, GPU, version, state,
  place, viewpoint, the open book and page, the dialogs and the last 20 errors; pasting it into
  the help dialog, or `__vrlbry.reproduce(report)`, restores that scene, see `scene.js`).
  Ideas, roughly by value:
  - ~~*A screenshot* of the 3D view~~ (done 2026-10-10: "Save screenshot", a PNG of a frame drawn
    for it; copying it as an image could follow).
  - *A "What went wrong?" box* whose text goes into the report.
  - *Recent actions:* the last 20–30 steps (room changed, book taken, opened, page turned), by id
    rather than title: how they got there.
  - *Smoothness:* frame times of the last ~10 s, long tasks (a lost WebGL context is reported
    since 2026-10-10: a toast, and `gpu.contextLost`).
  - *Failed downloads:* chunk, image or catalogue requests that failed, with their status (some
    fail without a console error, especially on the static site).
  - *Reading detail:* how much of the book is laid out (the shown page, its side and the text size
    are in the scene already).
  - *From VR:* nothing can be pasted in a headset; with the Node server, a kiosk button could send
    the report (POST) to be saved as a file on the PC. The static site has nowhere to send it.
- **GitHub Pages: the online version** (https://ariamokr.github.io/vrlbry/). Steps 0 and 1 are
  done; step 2, reading ZIMs in the browser, is possible but not decided.
  - *Limits:* the published site is at most 1 GB (plan with 1,000 MB: GitHub does not say which).
    The workflow downloads the ZIMs and never commits them, so git's 100 MB file limit does not
    apply. 100 GB/month bandwidth (soft). Pages serves range requests (206, CORS `*`) and HTTPS,
    so WebXR works on the Quest without a self-signed certificate.
  - *Step 0 (done 2026-10-05):* the client builds as a static site (`npm run build:pages` →
    `dist/`) and `.github/workflows/pages.yml` publishes it on pushes to `main`.
  - *Step 1 (done 2026-10-05):* the demo set is pre-rendered into the site (`build:pages --
    --zims`): every book list, chunk and image as a static file, ~605 MB in 176,000 files (~6
    min to build here, ~5 min a deploy), with Wikipedia title search in the browser. No redirect
    aliases (the server searches those in the ZIM's URL index), and only the demo set's ZIMs.
  - *The demo set:* the ZIMs in `tools/demo-set.txt` (what the workflow downloads), which the Demo
    set place (`DEMO_LIBRARIES` in `rooms.js`) shelves together; a test checks that the two name
    the same ZIMs. ZIM size, then size on the site:
    - Gutenberg LCC-P, Language and literature (19 books): 37 MB, 22 MB.
    - Wikipedia Mathematics, introductions (24 volumes, 23,326 articles): 56 MB, 117 MB (18,000
      formula images).
    - Wikipedia Physics, introductions (22 volumes, 21,811 articles): 54 MB, 59 MB.
    - Wikipedia Chemistry, introductions (10 volumes, 9,255 articles): 24 MB, 19 MB.
    - WikiMed Medicine, introductions (72 volumes, 71,519 articles): 155 MB, 121 MB (2 min to
      pre-render since articles are converted in storage order, 30 min before).
    - Wikipedia 100 (one volume of 101 full articles with pictures): 318 MB, 49 MB (the articles
      use 3,600 of its images).
    - Wikipedia Golf, with pictures (13 volumes, 12,160 articles): 138 MB, 216 MB.
    Converted sizes: Gutenberg ~0.6× the ZIM (its EPUB copies are not used), Wikipedia
    introductions 0.8–2.1×, Wikipedia with pictures 0.15× (Wikipedia 100) to 1.6× (Golf).
  - *Measured, not added* (MB on the site; about 350 MB is left): Gutenberg PA 279, PG 168,
    PL 69, PK 62, PB 29, PH 28, PM 22, PF 11, PD 5; Wikipedia with pictures: Climate change 228,
    Nollywood 26, Knots 24, Ray Charles 3; Climate change, introductions 6.
  - *Step 2: read ZIMs in the browser* (branch `vrlbry-standalone`), so the online version needs
    no pre-rendering and no longer has the 1 GB limit. *Milestone 1 done (2026-10-06):* local
    Gutenberg and generic ZIMs ("Open ZIM files…", or a drop), read by the shared core
    (`public/js/core/`, also the server's) in a worker over `File.slice`, with fzstd and fflate;
    images as blob URLs (SPEC §2.6). *Checked on a Quest 3 (2026-10-06,
    `perf/quest-2026-10-07_04-57-10.json`, Quest Browser 152):* the example ZIM downloaded from
    the card's link and opened from Downloads; reading two of its books in VR ran at 72 Hz with
    2.6–2.7 % of frames dropped, the worst gap when a book opened (98 and 124 ms: its first
    chunk laid out and drawn), the rest single gaps of 40–70 ms. All 21 page turns had the next
    pages ready (1.3 % dropped during the turn animations). Decompression runs in the worker
    and never showed: a chunk from it parsed in at most 3 ms (117 KB). The drops come while the
    reader prepares pages (41 of 189 during the 3.7 s of layout work, about half within a few
    frames of a page being drawn), as when reading from the server: see "Reading: dropped
    frames while pages are prepared". Browser memory 1.28 GB, JS heap 78 MB. Next:
    - *Milestone 2: Wikipedia and Wikisource in the browser.* A store in IndexedDB (the core
      takes any store), so an index is built once per file; the index build in the worker; a
      file's identity across reloads (its UUID). *Measured (2026-10-07,
      `perf/quest-index-bench-2026-10-07_18-*.json`):* the Wikipedia index build on the
      browser's platform (fzstd, fflate, TextDecoder, over a Blob, on one thread as in the
      worker) finds the same articles as on the server's. On a Quest 3 (Quest Browser 152, in a
      worker), then on the PC with the browser's platform and with the server's: Chemistry mini
      (25 MB) 3.4 s, 1.3 s, 0.3 s; Mathematics mini (58 MB) 12.9 s, 4.7 s, 1.9 s; Medicine mini
      (163 MB) 42 s, 13.6 s, 7.7 s; Golf (144 MB) 19.5 s, 10.8 s, 1.0 s; Simple English (3.1 GB)
      ~5 min (estimated), 125 s, 25 s; top 1M (49 GB) ~55 min (estimated), ~31 min
      (extrapolated from half), 5.6 min. The size pass dominates: it decompresses all of a
      Wikipedia's HTML (8.7 GB for Simple English, ~100 GB for the top 1M) to read each page's
      size and first 4 KB, and fzstd does ~40 MB/s on a Quest and ~80 MB/s on the PC, where the
      server runs six native zstd at once. The directory scan costs the same on both platforms,
      ~3.5× more on a Quest. The heap is as on the server (~200 MB for Simple English, ~500 MB
      for the top 1M). three's WASM zstd (`zstddec`) cannot be used: it needs the frame's
      content size, which no cluster frame declares (Golf, Medicine, top 1M, Gutenberg LCC-P
      sampled). Node's `fs.openAsBlob` reports a file over 4 GB with its size modulo 2³² (the
      unfixed nodejs/node#52585), so the bench read the top 1M through a FileHandle; the server
      never uses it.
      - *Plan:* build indexes in the browser for files up to a few GB (~5 min on a Quest, once
        per file, with progress) and ship prebuilt indexes for the big editions of a curated
        list. *Done (2026-10-07):* Wikipedia and Wikisource files open in the browser; the
        worker runs the same index build as the server (`ArchiveLibrary` with an `IndexQueue`)
        and keeps the index in IndexedDB (`local/idb-store.js`, the server's store interface,
        named by the ZIM's UUID: once per file, found again after a reload), and tells the page
        when it is done (`{ changed }` → `local.onChange` → the catalogue refreshes at once).
        Checked in the browser with Chemistry mini: indexing in 2.6 s, then 10 volumes; opened
        again after a reload in 0.8 s with no build. On the Quest: Chemistry mini indexed in
        8 s (the page rendering alongside), reopened from the store in 2.0 s, a volume read.
        Article search for local Wikipedias goes to the worker (the same search as the
        server's). The build's progress is a toast ("Indexing <title>… · 12 s · about 4 min
        left", with a bar) fed by the worker, besides the catalogue card and the kiosk's Rooms
        list at the 10 s poll. Wikisource too (a parity test on the fixture, and the Croatian
        Wikizvor, 56 MB, in the browser: 199 works indexed in 2 s, a work of 172 parts
        assembled in 3.6 s; the English one, 8.6 GB, would be a long build on a headset; on
        the Quest the Icelandic one, 28 MB, indexed in 4 s: 29 works). *To do:* authors come
        from `Author:` pages (`core/wikisource.js`), the English namespace prefix; other
        editions localise it (Icelandic "Höfundur:", Croatian "Autor:"), so their works have
        no authors ("authors matched for 0/29 works"), on the server too. Take the prefix from
        the ZIM's language (a small table), or match any namespace whose pages link to works.
        Prebuilt indexes: before building, the worker asks the site for `indexes/<name>`
        (`local/prebuilt.js`), and `build:pages --indexes <dir>` writes them for a folder of
        ZIMs (the standalone workflow's "demo indexes", for the demo set: a visitor who
        downloads one of those from Kiwix skips its build). The big editions' indexes (Simple
        English, the top 1M: 10.7 MB; a CI runner cannot download a 49 GB ZIM) are for the
        remote-ZIM repo to publish, with the same `indexes/<name>` layout. *Milestone 2 done.*
      - *To measure:* sizes from each cluster's offset table alone (decompressing only its
        first block), with redirect pages told by size and namespaces by title prefix (which
        is per language); a streaming WASM zstd, or two workers outside VR (the Quest gives a
        page 3 cores): perhaps 2× each.
      - *A file over 4 GB on a Quest (checked 2026-10-07):* Gutenberg LCC-S, Agriculture
        (4.53 GB, 729 books; its directory and book index lie in the last 0.5 % of the file, past
        4 GiB) opened from Downloads on the Pages site, and two books read, The Book of the Cat
        (362 pictures, its text at 4.34 GB) among them: `File` reads past 4 GiB work. But it was
        slow, and nothing said so: opening the file took about a minute, the cat book half a
        minute of looking frozen (hence the "Opening…" panel with Put back, then the progress
        bars with the time so far and left). Counted on the PC: the file made 4,656 reads
        (3,244 of them directory lookups, binary searches reading one dirent per step, 1,416
        for the books' sizes), the book 2,084 (1,266 directory, 818 for its pictures: 2–3 each
        plus the whole image to learn its size), and on the Quest every `File` read costs about
        the same however small, ~15–25 ms. The directory block cache (`ZimArchive._readDir`,
        64 KB blocks, 16 MB per local file) cut the file to 1,437 reads and the book to 824:
        measured on the Quest (dev server, `?perf`), the file opens in 34.7 s (from ~70) and the
        book in 13.3 s (from ~30). What was left were the cluster reads: 2 tiny ones per book
        for its size at open, 2–3 per picture when a book opens. *Measured on the Quest
        (`perf/quest-reads-2026-10-07_20-23.json`, a `File` read in a worker):* a read costs
        about the same however big, ~65–70 ms alone for 8 B up to 256 KB, 77 ms for 1 MB,
        87 ms for 4 MB; reads at once overlap up to about 4 (4 at once take no longer than 1),
        then the headset serves ~90 reads a second (8 or more at once: ~11.5 ms each); nearby
        or sequential reads cost the same as random ones. So the number of reads is what
        counts, and bytes are nearly free. Hence (commits `6275f9a`, `7b0ce38`): the block
        cache serves every read under 64 KB (a book's size at open: one read, shared by the
        books of a cluster), and the local library reads an uncompressed cluster up to 4 MB
        whole once a second blob of it is wanted (`wholeClusterBytes`; a book's pictures share
        a few clusters: the cat book's 362 pictures lie in 24). Counted on the PC: the file
        718 reads (from 4,656 this morning), the cat book 73 (from 2,084). On the Quest: the
        file opens in 19.4 s (from ~70), the book in 4.3 s (from ~30). Then (`838ffc2`) the
        handler opens the file once (the library takes the archive over) and books' sizes,
        which only set their thickness on the shelf (logarithmic), are estimated from the
        cluster pointers instead of read (`estimateSizes`: median 1.4–2.2× the real size,
        94–100 % within 10×, a median thickness change of 4–10 %): 28 reads instead of 738,
        and on the Quest the file opens in 3.0 s. So a 4.5 GB Gutenberg ZIM now opens in 3 s
        and a book of 362 pictures in 4 s, from a minute and half a minute this morning.
    - *Milestone 3: remote ZIMs* from Kiwix's mirror over HTTP range reads (a byte source like
      `BlobSource`), from a curated list. On branch `vrlbry-cloud` (repo AriaMoKr/vrlbry-cloud,
      site https://ariamokr.github.io/vrlbry-cloud/; both private since 2026-10-10, the site
      gone), started 2026-10-10. *Mirrors (checked
      2026-10-10, the top 1M's first 80 bytes):* Kiwix's MirrorBrain lists seven, each holding
      a different subset (Gutenberg LCC-P on 5, the full English Wikipedia on 6, the top 1M on
      all 7): mirror.download.kiwix.org (Kiwix's own, France), ftp.nluug.nl (NL),
      wi.mirror.driftle.ss and ny.mirror.driftle.ss (US), dumps.wikimedia.org (US),
      ftpmirror.your.org (US), mirror-sites-in.mblibrary.info. All seven answer range reads
      (206, `Content-Range`), but only mirror.download.kiwix.org sends CORS headers (`*`, `Range`
      allowed, `Content-Range` exposed): from a page in a browser the other six, and
      download.kiwix.org's redirect, are blocked. Its first read took 731 ms from California.
      Using the others needs a CORS proxy (step 7: `tools/zim-proxy/`, a Worker forwarding
      range requests), or their operators adding CORS (a few lines of nginx). The big editions' prebuilt indexes
      (`indexes/<name>`, `local/prebuilt.js`) belong here too. *Measured from a browser here
      (2026-10-10):* a 64 KB range read from mirror.download.kiwix.org takes 0.5–0.8 s (mostly
      waiting), 8 at once 3 s (about 3× better than in turn), 1 MB 4.4 s (235 KB/s), 4 × 1 MB at
      once ~400 KB/s: every read costs a round trip to France. Kiwix's OPDS catalogue
      (`library.kiwix.org` → `opds.library.kiwix.org/catalog/v2/entries`) sends CORS `*`: 1,301
      English ZIMs with sizes and links (`lb.download.kiwix.org/….zim.meta4`).
      - *Rule: every speed-up is optional.* Caches (the block cache, the index store),
        prebuilt indexes, a proxy and the catalogue only make things faster or easier: opening
        a file or a ZIM by URL must keep working with each of them absent, failing, blocked or
        off. Each is a fallback-safe wrapper around the plain path (as `withPrebuilt` falls back
        to building, `memoryStore` stands in for IndexedDB), each has a test with it missing or
        failing, and SPEC says which layers are optional.
      - *Plan:*
        1. *Done (2026-10-10):* an HTTP byte source (`core/zim/http-source.js`, beside
           `BlobSource`; `ZimArchive.open(url)`): the size from the first `Content-Range` (or a
           HEAD); a server that ignores `Range` is refused (a 200 would stream the whole file).
           The edition is checked, not pinned: the mirror allows no `If-Range` in a CORS
           request, so every answer's total size and Last-Modified must match the first's.
           Retries with backoff, at most 6 requests in flight, and a block size per archive
           (`blockBytes`). Tested against a local server (`test/http-source.test.js`).
        2. *Measured on the PC and a Quest 3 (2026-10-10):*
           Node and the built-in browser, from mirror.download.kiwix.org, with the local
           library's settings and the indexes built here: Gutenberg LCC-P (37 MB), Chemistry
           mini (25 MB), the top 1M (49 GB). A round trip took 0.3–0.8 s and one answer came
           at 100–700 KB/s, so both the number of reads one after another and the bytes count.
           At first the top 1M took 39 s to open (61 reads) and 65 s more to show Albert
           Einstein. What cost and what was done (`6a51178` and the next commit):
           - *The open's lookups:* the namespace scheme was checked with a binary search (28
             reads of the top 1M's directory), the metadata found with two more (28), and a
             Wikipedia looked for a Gutenberg index (8). Now the scheme comes from the version
             (as libzim), the directory's last 64 entries are read at open (the metadata lies
             13–17 from the end in every ZIM tried) and lookups after their first search those
             alone, and a Wikipedia or Wikisource skips the Gutenberg lookup. Top 1M: 8 reads.
           - *Two reads per compressed cluster* (its head's block, then the rest): now one when
             the entry's MIME type says compressed (`wholeCompressedBytes`). Also saves a read
             per cluster of a File on a Quest, index builds included.
           - *Image checks:* converting an article looked every image up (a binary search,
             ~6 reads each): Albert Einstein's 38 images made 244 reads, 39 s. With
             `checkImages: false` a sized image is not looked up (mwoffliner's are all there).
           - *Block size:* not bigger but smaller. Lookups touch scattered entries, so a 64 KB
             block mostly carries bytes nobody wants. Top 1M, search and article with checks:
             1 KB 12 s and 25 s, 2 KB 10 and 20, 4 KB 9 and 21, 8 KB 8 and 19, 16 KB 15 and
             31, 64 KB 21 and 39. Opens: 256 KB and 1 MB blocks were slower than 64 KB (11 vs
             14 vs 32 s for LCC-P). *Decided: 8 KB over HTTP*, 64 KB for files (a File read
             costs the same however small).
           - *Many entries at once* (a volume's 1,000 titles) were read one by one: with 8 KB
             blocks 76 reads. Now `getEntriesByIndex` reads neighbours together: 13–20 reads.
           - *Search:* the binary search now starts in the volume the volumes' titles point to
             (10 steps instead of 20 on the top 1M), results are read together, and the
             redirect spellings are searched at once.
           - *Pictures (Gutenberg's, sized by reading them):* The Story of the Alphabet's 126
             took 7.7 s read one by one (124 reads, 4.1 MB) and 16.2 s with clusters read whole
             (13 reads, 6.0 MB). *Decided: no whole uncompressed clusters over HTTP*
             (`wholeClusterBytes` 0).
           - *Directory in one go:* no. Chemistry's directory is 3.5 MB, more than its whole
             open costs now.
           - *Result (browser, cold, 8 KB blocks, no image checks):* LCC-P opens in 6.1 s and a
             book in 1.4 s; Chemistry opens in 3.3 s, a search takes 4.0 s, a volume 2.3 s, an
             article 1.2 s; the top 1M opens in 5.5 s, Albert Einstein is found in 9.7 s, his
             volume opens in 2.3 s and the article in 1.0 s (from 39 s + 65 s).
           - *On a Quest 3* (Quest Browser 152, over Wi-Fi, driven over adb and DevTools, cold):
             about the same as the PC's browser, so the network sets the pace, not the headset.
             LCC-P opens in 5.7 s, a book in 1.0 s; Chemistry opens in 2.1 s, searches in
             3.4 s, a volume 1.4 s, an article 0.7 s; the top 1M opens in 6.3 s, finds Albert
             Einstein in 9.9 s, his volume in 2.2 s, the article in 0.7 s. With the settings of
             files (64 KB blocks, image checks) the top 1M's search took 15.9 s and the article
             54.7 s.
           - *The browser's HTTP cache* keeps the mirror's range answers (it sends Last-Modified
             and no Cache-Control: heuristic freshness), Chrome and Quest Browser alike, but
             once it holds a URL it serializes range requests on it: 8 at once took 1.3 s
             instead of 0.17 s (in turn, 160 ms each). With it the Quest's second visit searched
             the top 1M in 18.5 s, without it (`no-store`) 9.9 s but every open from the network
             again. Now a request made while others run asks for `no-store` and one alone uses
             the cache: second visit on the Quest, LCC-P opens in 0.2 s, Chemistry in 0.1 s,
             the top 1M in 1.2 s (search 8.6 s, article 0.2 s).
           - *Still slow:* the search (33 reads on Chemistry, 110 on the top 1M: a binary
             search is a round trip per step, and each redirect is placed in title order by
             another). Step 6's indexes could carry what makes it free (titles, the redirects'
             positions), at the cost of their size.
        3. *Done (2026-10-10):* open by web address in the local library (SPEC §2.6 "From the
           web"): the card's address field, a dropped link, the example's "read it online",
           `__vrlbry.openUrl`. Kiwix's download links become its mirror's (`local/zim-url.js`);
           the worker opens an HTTP source as a File, with step 2's settings for URLs. The
           addresses that opened reopen as the page starts and the room saved last time comes
           back (in the browser: two libraries reopened in about a second); one that does not
           stays on the "Last time" line. A local library's × closes and forgets it. A server
           without CORS, ranges or the file is named in the error, and another Kiwix mirror's
           address gets the same file's on Kiwix's own. A remote Wikipedia or Wikisource with
           no index is indexed only up to 256 MB (`maxIndexBuildBytes`: building reads most of
           the file). Scans now read growing batches (512 up to 8,192 entries): the Chemistry
           mini's index over the network took 27 s instead of 47. Needs nothing else: no cache,
           index or proxy. Not yet: opening a web address in VR (the kiosk has no address
           entry; step 5's list is for that).
        4. *Done (2026-10-10):* a persistent block cache (optional, `local/block-cache.js`, SPEC
           §2.6 "Kept from the web"): every read of a web source kept in IndexedDB, under the
           file's edition (address, size, Last-Modified: the UUID is inside the file, known
           only after the first read) and the read's position and length, which repeat exactly
           on a second visit; 256 MB, oldest first; read-through, standing aside after 5
           failures in a row. On a Quest, second visit: the top 1M's search 0.1 s (8.6 s with
           the browser's cache alone), its volume's titles 0.0 s (2.1), Chemistry's search
           0.0 s (3.2); only the probe goes to the network. While testing, the index-queue test
           failed twice in some 20 full runs: Wikipedia fixtures all had one UUID, so two
           shared an index and checkpoint name, and the queue started the next build before the
           previous one had saved its index and removed its checkpoint. Now the fixtures' UUIDs
           come from their file names, a queued job includes the saving, and a build whose
           index appeared meanwhile (a copy of the ZIM, the same file opened twice) takes it.
           Not done: a way to see or clear the cache in the page (clearing the site's data
           does it).
        5. *Done (2026-10-10):* Kiwix's library to choose from (optional, SPEC §2.6 "Kiwix's
           library"): the ZIMs the app reads well (Gutenberg, Wikipedia, Wikisource) from Kiwix's
           OPDS catalogue, read live rather than curated into the repo (a copy would go stale:
           editions change monthly and old ones leave the mirror), in the card's dialog and on
           the kiosk's Kiwix tab in VR. Big Wikipedias without a prebuilt index on the site
           (`indexes/list.json`, now written by `--indexes`) are listed last and cannot be
           opened: 47 of the 65 English ones, which is what step 6 is for. On a Quest the list
           fills in about a second. Addresses and files still open without the catalogue.
        6. *Done and published (2026-10-10):* prebuilt indexes (optional, SPEC §2.6
           "Prebuilt indexes"): `tools/indexes.txt` lists the 49 English Wikipedias and
           Wikisources over 256 MB; `tools/build-indexes.mjs` builds the missing ones for their
           current editions (Kiwix's catalogue) from local copies (`--zims`) or from the mirror
           (`--web`), resumable, with `--hours`, `--prune` and `--publish`; the cloud workflow
           ships what the Actions cache and the release "indexes" hold, and builds missing ones
           from the mirror only when "prebuilt indexes" is ticked. Tried first: building an
           index from the ZIM's own list of articles (`X/listing/titleOrdered/v1`) without
           reading HTML. It holds every article, but also every ZIM redirect and mwoffliner's
           section-redirect pages (5.9 M entries for the top 1M's 1 M articles), and telling
           those pages apart needs their HTML. Built here from local copies (`.indexes/`):
           Wikipedia 100, Simple English, the top 1M, Wikisource, and the full English
           Wikipedia (maxi: 7,229,793 articles, built in 32 min, an index of 77 MB, 39 MB
           compressed). Tried on a Quest from a test build of the site: the top 1M opened from
           the web in 3.6 s with its index, the full English Wikipedia (127 GB) in 24 s (7,230
           volumes; the index came from this PC over adb, so the site's download of it is not
           counted). With them, Kiwix's library offers 21 of the 65 English Wikipedias instead
           of 18. *Published* as the release "indexes" and shipped by the workflow: on the live
           site (desktop browser) Kiwix's library offers 22 English Wikipedias, the top 1M opens
           from the web in 2.6 s and the full English Wikipedia in 16 s, each with its index
           downloaded from Pages (5.6 MB and 39 MB compressed). *For new editions:* build them
           (`node tools/build-indexes.mjs --zims <folder>`), `gh release upload indexes
           .indexes/*.json --clobber`, then push or run the workflow; or tick "prebuilt indexes"
           to build the rest from the mirror (about 60 GB of its bandwidth once without the three
           full English Wikipedias; over the web from here Cricket, 379 MB, read 0.20 GB in
           232 s). *Compact indexes (v5, done 2026-10-11):* the order as variable-length
           deltas and each size as one byte within 4 % (SPEC §2.5): the full English
           Wikipedia's index 73.9 → 20.5 MB (11.5 MB as Pages sends it gzipped), the top 1M
           10.2 → 2.9 MB, Simple English 2.9 → 0.8 MB, each order identical to v4's; read in
           0.1 s on a PC (Chrome's own base64 decoder where it has one: 5 ms instead of 459
           for that order). A v4 index is upgraded where found (a store, a site, `--out`), so
           the workflow turns the release's v4 files into v5 by itself and nothing is rebuilt;
           uploading v5 files to the release (and deleting the v4 ones) only saves it that
           step. *On a Quest 3* (a test copy of the site with the v5 indexes, a fresh origin): the full
           English Wikipedia (127 GB) opened from Kiwix's mirror in 17.3 s with its index fetched
           from the site (24 s with v4 before), 7.0 s once the index was kept in the browser; the
           index alone takes 1.55 s to fetch (20.5 MB, not gzipped, from this PC), 113 ms to read
           from IndexedDB and ~220 ms to decode (Quest Browser has Uint8Array.fromBase64); the
           rest is the ZIM read from the mirror. Possible next:
           deflate before base64 (20.5 → ~12.8 MB on disk, little less to download), and
           more indexes (which, and in what order: "Prebuilt indexes, which next" below).
           Later: other languages.
           *Shared storage, on purpose (decided 2026-10-10):* the three Pages sites (vrlbry,
           vrlbry-standalone, vrlbry-cloud; the other two private since 2026-10-10, their sites
           gone, the rule kept for when they return) are one origin, ariamokr.github.io, so they share
           localStorage (`vrlbry:` keys: settings, reading positions, recent, the card, the
           remembered web addresses) and IndexedDB (`vrlbry-local` indexes, `vrlbry-files`
           handles, `vrlbry-blocks`). They are flavours of one app: most features will be merged
           back into the main site, and the other two kept, at low priority, for trying new
           features or for particular needs. So no prefix per site; instead the stored formats
           stay compatible across them: (1) settings are loaded as `{ ...DEFAULT_SETTINGS,
           ...stored }` and saved whole, so a site keeps the fields it does not know (all three
           branches, checked 2026-10-10): never rebuild them from known keys only; (2) a changed
           shape stays readable by the older code (as `normRoom` reads rooms' old shape) or goes
           under a new key; (3) a database's version is never raised (older code opening version
           1 would fail with a VersionError and fall back to memory): new stores go in a new
           database; (4) derived data names carry their version (`core/index-versions.js`), so
           sites on different versions keep their own. Two of them open at once: the last to
           save its settings wins.
        7. *Done (2026-10-10, deployed at https://vrlbry-zim-proxy.vrlbry.workers.dev, Cloudflare's
           free plan, for the pages of ariamokr.github.io and localhost):* an edge proxy (`tools/zim-proxy/`, SPEC §2.6
           "Through an edge proxy"), measured first. *From here (California), on a warm
           connection:* a read from Kiwix's mirror takes 160-180 ms (curl and the browser alike,
           no preflight per read; HTTP/2), from the US mirrors 85-110 ms (Wisconsin 80-90),
           the Netherlands 300-380, India 290-310; 1 MB arrives at 1.0 MB/s from Kiwix's,
           1.8-2.0 MB/s from Wisconsin, New York and Wikimedia's. A TLS handshake costs two
           round trips more (Kiwix's 335-355 ms). Cloudflare's nearest edge is Los Angeles,
           35-45 ms away. All seven mirrors give a file the same size and Last-Modified;
           Wikimedia's and your.org have no Gutenberg. *The workload of step 2* (Node, cold, 8
           KB blocks, no image checks), Kiwix's mirror against Wisconsin's, two rounds each:
           LCC-P opens in 4.2-4.7 s against 1.8-1.9 s; Chemistry opens in 2.0-3.5 s against
           0.8, searches in 3.7 against 1.8; the top 1M opens in 2.4-4.3 s against 0.7-0.8,
           finds Albert Einstein in 7.3-7.5 s against 3.3-3.4, his volume's contents in 1.5-2.6
           s against 0.4 and the article in 1.2-3.0 s against 0.2. Through the proxy run here
           (`serve.mjs`, reading Wisconsin's): the same as Wisconsin's directly (top 1M 0.8 s
           and 3.4 s); from the browser, a fresh Gutenberg ZIM (LCC-PM, 11 reads) opened in 1.6
           s. *Through Cloudflare* (deployed; Los Angeles, reading Wisconsin's): a warm read
           100-120 ms; alternating with Kiwix's mirror, LCC-P opens in 1.5-1.9 s against
           5.1-6.2 s, Chemistry in 0.8 s against 2.1-3.5 and searches in 1.9 s against
           3.4-3.7; the top 1M opens in 0.9 s against 3.5-4.4, finds Albert Einstein in 4.3-4.4
           s against 7.5, his volume's contents in 0.5-0.6 s against 2.0-2.5 and the article in
           0.2-0.4 s against 1.0-1.2. On the live site (`?zimproxy=`), a Gutenberg ZIM never
           opened there (LCC-PK, 84 MB) opened in 1.6 s. Its certificate took 90 s after the
           first deploy. So it pays for visitors far from France (the Americas, Asia, Oceania),
           and the page picks nothing: the Worker chooses by continent. *To do:* the repository
           variable `ZIM_PROXY`, and a measurement on a Quest (step 8). *Later:* keeping popular reads at the edge (the Cache
           API, which needs a custom domain, not workers.dev; a 206 would be kept as a 200
           under a key of its own); asking the mirrors' operators for CORS (a few lines of
           nginx or Apache: docs/MIRRORS.md), which would make the proxy
           unnecessary. Kiwix's redirects already send CORS headers (`download.kiwix.org` →
           `lb.download.kiwix.org`, whose MirrorBrain sends California to
           `wi.mirror.driftle.ss`; preflights answered 204), so once the mirrors do too, the
           page could follow the redirect once per file (`response.url`) and read the mirror
           Kiwix picks; today the five nginx mirrors answer a preflight 405 and the Apache one
           200 without the headers (checked 2026-10-10). Cloudflare's free
           plan allows 100,000 requests a day (an article costs 20-40 reads, an index build
           over the web thousands).
        8. *Done (2026-10-10):* Quest checks and docs. On a Quest 3 (Quest Browser 152, Wi-Fi,
           California), the live site with the proxy deployed, driven over adb and DevTools; the
           headset's own state for the site (settings, reading positions) saved first and put
           back after. The core in the page with no caches (no block cache, no HTTP cache, an
           index store in memory), Kiwix's mirror against the proxy, two rounds each: a read on
           its own 202-205 ms against 110, 8 at once 529-723 ms against 156-169; LCC-P opens in
           7.3-8.8 s against 1.9-2.0 and a book in 1.4-2.1 s against 0.3-0.4; Chemistry, its
           index built on first open (131 reads, 10 MB), in 50-51 s against 9.6-10.1; the top
           1M opens in 6.1-7.4 s against 2.3-2.4, finds Albert Einstein in 10.3-11.4 s against
           4.6-5.0, his volume's contents in 2.1-2.7 s against 0.6-0.7 and the article in
           1.2-1.7 s against 0.3. The full English Wikipedia (its 77 MB index from the site)
           opens in 23.4 s against 17.5, searches in 11.4 s against 4.9, a volume in 1.3 s
           against 0.4 and the article in 1.6 s against 0.3 (190 MB of page heap after). The
           proxy unreachable: LCC-P read directly after one failed try (5.7 s). The app itself:
           a Gutenberg ZIM not opened there before (LCC-PB) opened through the site's proxy in
           3.7 s, shelves included, with no fallback. The kiosk's Kiwix tab: the 65 English
           Wikipedias listed in 1.2 s, labelled as on the PC (4 "Index ready", 18 "Indexed on
           first open", 43 "Needs an index"). Docs: SPEC §2.6 (From the web, Kiwix's library,
           Kept from the web, Through an edge proxy, Prebuilt indexes) and §3.1, README.
           *Milestone 3's plan is done.* Found after it (2026-10-10): the biggest Gutenberg
           ZIMs (`gutenberg_mul_all_2025-11`, 75,962 books in 68 languages, 253 GB;
           `gutenberg_en_all_2025-11`, 60,366 books) did not open from the web in 10 minutes:
           each book's HTML, EPUB and cover were looked up as it opened, a binary search each
           over a directory of 5.3 M entries. Now a list longer than 500 books from the web is
           made from the list alone, each book looked up when first opened (SPEC §3.6
           `bookLookups`): `gutenberg_mul_all` opens in 9.2 s in the browser (63 reads), a book
           in 1.8-5.1 s. The biggest Wikipedia stays the full English one: 7,230 volumes.
           *English first* (decided 2026-10-10): other languages come after the focused
           features. *On the Quest* (live site, through the proxy): `gutenberg_en_all_2025-11`
           (60,366 books) opened in 10.9 s, shelves included (genre A, 2,927 books on 27
           bookcases), 3.0 s again from the block cache; frames stayed at 90 Hz in the 2D view
           (450 in 5 s, none over 25 ms); the page's process grew from 237 to 512 MB; its
           book list arrived in 354 ms, the search index of 60,366 books built in 81 ms and a
           search took 10 ms; Moby Dick opened in 2.1 s, Pride and Prejudice in 11.7 s. That one
           has 164 pictures, each read whole to learn its size (25.7 MB); now sized from its
           first 16 KB (3.1 MB). It still makes 234 reads: from Node through the proxy 8.5 s
           with 6 requests in flight (HttpSource maxInFlight), 6.8-7.0 s with 12, 6.3 s with
           16, while sizing 8, 16 or 32 pictures at once made no difference. Six was for
           HTTP/1.1, but Kiwix's mirror and the proxy speak HTTP/2: worth measuring more in
           flight in a browser and on the Quest. *Seen there, and done (2026-10-10):* a library
           this big opened on genre "A" (General works: encyclopedias, periodicals; the
           biggest genre under the 3,000-book cap), and the genre buttons showed bare LCC codes
           ("PS · 11.2k"), 18 of the 40. Now the first room is all books, a Gutenberg room over
           the cap shelves its 3,000 most read in the chosen order (the default sort is by
           title, so "the first 3,000" were "$1,000 a Plate" and on), and the kiosk lists every
           genre by name (SPEC §5, rooms). On the Quest (live site): English Gutenberg opens on
           all books, its 3,000 most read (by popularity Frankenstein, Moby Dick, Romeo and
           Juliet first; by title the same books from "1000 Mythological Characters"), frames
           at 90 Hz; switching to title order took 2.1 s, choosing American literature from the
           list 1.9 s (its 3,000 most read of 11,188).
           *Pages (2026-10-10):* a room over 3,000 is shelved a page at a time (Gutenberg's by
           popularity: 1-3,000, 3,001-6,000…), with Previous / Next on the kiosk; the rest was
           reachable only through filters and search. *Bigger rooms, measured* (the page
           address's `?roomcap=<n>`; the dev server on the Quest over adb reverse, English
           Gutenberg through the proxy, the 2D view; switching from Medicine, 598 books, to all
           books): 3,000 books on 28 bookcases rebuilt in 0.76 s (the worst frame 111 ms, 2.6 %
           of frames dropped in the 4 s after), 6,000 on 55 in 0.94 s (178 ms, 4.0 %), 10,000
           on 92 in 1.12 s (256 ms, 5.4 %), 20,000 on 183 in 1.66 s (411 ms, 7.6 %; of it the
           build 417 ms and the low atlases 703 ms); walking the room after (room-walk) dropped
           1.3, 1.4, 1.5 and 0.6 %, with 34-40 draw calls (rows behind not drawn) and the
           browser's memory ~100 MB more at 20,000. *In VR* (worn, 72 Hz, both eyes; room-walk):
           3,000, 6,000, 10,000 and 20,000 books all walked at 71.6-71.7 fps, 0.5-0.7 % of
           frames dropped, 42-46 draw calls (max 72-84); each walk had one stall, growing with
           the room: 140, 203, 263, 461 ms (cause not traced: probably as the walk starts); a
           room switch took 0.93, 0.97, 1.19, 1.81 s, its worst frame 100, 189, 278, 500 ms, and
           2.2, 4.2, 5.5, 9 % of frames dropped in the 4 s after (atlases arriving). *Decided:
           10,000* (English Gutenberg in 7 pages instead of 21). *To trace:* that stall when a
           walk starts, and the build's worst frame (build and low atlases), which grow with the
           room. *Possible later:* the whole
           library on the shelves, only the bookcases near the viewer built as they walk (a
           virtual hall), instead of a cap and pages. Left for later: the items under steps 6 and 7 (a more
           compact index, other languages, keeping popular reads at the edge, CORS on the
           mirrors, then following Kiwix's redirect).
    - *Keep files across reloads (done 2026-10-08):* where the browser gives file handles (the
      File System Access API: desktop Chrome/Edge, and Quest Browser has it too) they are kept
      in IndexedDB and the card offers "Last time: … Reopen" (permission asked again within the
      tap, `local/handles.js`); elsewhere the file is picked again.
    - *In VR:* the kiosk cannot open files (a picker cannot show in an immersive session); it
      could list the files opened before entering VR.
    The notes from before it began:
    - *Kiwix's copies:* `mirror.download.kiwix.org` allows cross-origin range reads (CORS `*`,
      Range in the preflight), so the client can open any catalogue ZIM, reading only what it
      needs (LCC-P and Mathematics read fine: ~20–30 requests, under 2 MB each, for the metadata
      and the Gutenberg book index). Not `download.kiwix.org`: it redirects to mirrors without
      CORS (use it for plain downloads).
    - *Local ZIMs:* a file picker (and drag and drop on desktop); `File.slice` reads parts of
      even 100 GB files. On the Quest, pick before entering VR; access probably lasts the session.
    - *How:* the library layer (ZIM reader, decompression, HTML conversion, chunking) in a Web
      Worker in the page, over a byte source (local File, HTTP range, or today's server), behind
      the same API the client uses now. Port: fs → byte source, Buffer → Uint8Array, zstd → a
      small JS decoder (e.g. fzstd), EPUB/zlib → DecompressionStream, htmlparser2 from a CDN (no
      build step). Images through a service worker or blob URLs. The Wikipedia/Wikisource indexes
      need a full pass: publish the prebuilt ones (`.cache/*.json`, 10.7 MB for the 1M Wikipedia)
      or index local files in the browser and cache the result.
    - *Phases:* local ZIMs (Gutenberg, generic) → remote ZIMs from a curated list → Wikipedia and
      Wikisource with prebuilt indexes. The Node server keeps working throughout.
