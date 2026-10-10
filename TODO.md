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
- **Wikipedia: follow links** (later). Tapping a link in an article goes to that article, taking
  its volume off the shelf if needed. The reader cannot follow links today.
- **Garbage collection pauses** are now the main source of dropped frames on a Quest 3. The
  atlas stalls are fixed (run 2026-10-05 03:37: walking the hall 9.1 % → 0.1 % dropped, an
  ordinary room 5.4 % → 1.8 %, no drop before an atlas arrived, down from 343 of 406), and of
  what is left, GC pauses were in 35 of 44 dropped frames walking an ordinary room, 72 of 86
  switching filters, and 61 of 68 entering the all-libraries hall (its rebuild). Next: find what
  allocates in those (`quest-perf run` traces GC per scenario; a heap profile of a room switch
  and of a walk), and allocate less: reuse objects in per-frame code, build rooms with fewer
  temporary arrays.
- **Reading: dropped frames while pages are prepared.** Reading in VR on a Quest 3 (2026-10-06,
  a local ZIM, step 2) dropped 2.6–2.7 % of frames at 72 Hz, while page turns themselves stayed
  smooth (1.3 %). The drops cluster where the reader prepares the next spreads on the main
  thread: 41 of 189 during layout steps (3.7 s of 100: about 6× the rate elsewhere), about half
  within a few frames of a page being drawn (4.5 ms typical, 16.6 ms worst), and one gap of
  ~100 ms when a book opens (its first chunk laid out and drawn at once). Not yet traced for GC
  (`quest-perf dump` does not; `run`'s read scenario does). Ideas: smaller layout steps while in
  VR, drawing pages in a worker on an OffscreenCanvas (as the spine atlases are), and showing
  the first spread before the rest of the first chunk is laid out.
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
- **Possible: more in "Copy debug info"** (`debug-info.js`; it has browser, GPU, version, state,
  place, viewpoint, the open book and page, the dialogs and the last 20 errors; pasting it into
  the help dialog, or `__vrlbry.reproduce(report)`, restores that scene, see `scene.js`).
  Ideas, roughly by value:
  - *A screenshot* of the 3D view (copied as an image, or saved as a PNG beside the text): the
    report does not show what the person saw.
  - *A "What went wrong?" box* whose text goes into the report.
  - *Recent actions:* the last 20–30 steps (room changed, book taken, opened, page turned), by id
    rather than title: how they got there.
  - *Smoothness:* frame times of the last ~10 s, long tasks, WebGL context loss.
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
      site https://ariamokr.github.io/vrlbry-cloud/), started 2026-10-10. *Mirrors (checked
      2026-10-10, the top 1M's first 80 bytes):* Kiwix's MirrorBrain lists seven, each holding
      a different subset (Gutenberg LCC-P on 5, the full English Wikipedia on 6, the top 1M on
      all 7): mirror.download.kiwix.org (Kiwix's own, France), ftp.nluug.nl (NL),
      wi.mirror.driftle.ss and ny.mirror.driftle.ss (US), dumps.wikimedia.org (US),
      ftpmirror.your.org (US), mirror-sites-in.mblibrary.info. All seven answer range reads
      (206, `Content-Range`), but only mirror.download.kiwix.org sends CORS headers (`*`, `Range`
      allowed, `Content-Range` exposed): from a page in a browser the other six, and
      download.kiwix.org's redirect, are blocked. Its first read took 731 ms from California.
      Using the others would need a CORS proxy (a small worker forwarding range requests), or
      their operators adding CORS (a few lines of nginx). The big editions' prebuilt indexes
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
        6. Prebuilt indexes for the curated Wikipedias and Wikisources (optional), under
           `indexes/` on this site: building one in the browser over the network means
           downloading all its HTML (12.7 GB for the top 1M). Built here or in CI, ~10 MB each
           (1 GB site limit), rebuilt for new editions. Without one, the index is built in the
           browser as today.
        7. Speed, if step 2 says so (optional): an edge proxy (e.g. a Cloudflare Worker) adding
           CORS and reading from the nearest mirror (a US one from here), or asking mirror
           operators to add CORS. Used only when configured; the direct URL otherwise.
        8. Quest checks and docs (SPEC §2.6 remote sources, README).
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
