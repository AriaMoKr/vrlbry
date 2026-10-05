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
- **Wikipedia: the full English maxi** (~6.8 M articles, ~119 GB). At the top-1M rate its index
  would take roughly 1¾ hours: consider speeding up the size pass (e.g. decompressing clusters in
  worker threads), and check the memory of the 6.8 M-title sort.
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
- **All-libraries hall draw calls.** On the Quest: 380 → 104 standing (both eyes), 142 → 56
  walking, with one draw call per sign and no books drawn behind a nearer row. The room itself
  (chandeliers, walls, wainscots, ~31 calls per eye) could still be merged per material.
- **Server code review.** An earlier review recorded 5 minor findings that were never fixed, and
  3 of its reviewers never finished.
- **Possible: run without a server (GitHub Pages).** Reviewed 2026-10-05, not decided.
  - *Limits:* a Pages site is at most 1 GB (the source repo should be too), files at most 100 MB
    (git), 100 GB/month bandwidth (soft). Pages serves range requests (206, CORS `*`) and HTTPS,
    so WebXR works on the Quest without a self-signed certificate.
  - *Hostable ZIMs* (under 100 MB): Gutenberg LCC P, PB, PD, PF, PH, PK, PM (13–80 MB) and small
    Wikipedia subsets (Ray Charles, knots, chemistry/maths/physics minis), ~450 MB together.
    Larger ones would need splitting into parts under 100 MB.
  - *Or read Kiwix's copies directly:* `mirror.download.kiwix.org` allows cross-origin range
    reads (CORS `*`, Range in the preflight), so the client can open any catalogue ZIM, reading
    only what it needs. Not `download.kiwix.org`: it redirects to mirrors without CORS.
  - *Local ZIMs:* a file picker (and drag and drop on desktop); `File.slice` reads parts of even
    100 GB files. On the Quest, pick before entering VR; access probably lasts the session.
  - *How:* the library layer (ZIM reader, decompression, HTML conversion, chunking) in a Web
    Worker in the page, over a byte source (local File, HTTP range, or today's server), behind the
    same API the client uses now. Port: fs → byte source, Buffer → Uint8Array, zstd → a small JS
    decoder (e.g. fzstd), EPUB/zlib → DecompressionStream, htmlparser2 from a CDN (no build
    step). Images through a service worker or blob URLs. The Wikipedia/Wikisource indexes need a
    full pass: publish the prebuilt ones (`.cache/*.json`, 10.7 MB for the 1M Wikipedia) or index
    local files in the browser and cache the result.
  - *Phases:* local ZIMs (Gutenberg, generic) → remote ZIMs from a curated list → Wikipedia and
    Wikisource with prebuilt indexes. The Node server keeps working throughout.
  - *Step 0 (prepared 2026-10-05):* the client builds as a static site without books
    (`npm run build:pages` → `dist/`, 3 MB) and `.github/workflows/pages.yml` publishes it on
    pushes to `main`, at https://ariamokr.github.io/vrlbry/ once Pages' source is set to GitHub
    Actions.
  - *Step 1 (done):* the demo set is pre-rendered into the site (`build:pages -- --zims`):
    every book list, chunk and image as a static file (~140 MB, 43,000 files, ~1.5 min to
    build), with Wikipedia title search in the browser. No redirect aliases (the server searches
    those in the ZIM's URL index), and nothing beyond the files the build saved: reading ZIMs in
    the browser is the next step.
  - *Demo set* (chosen 2026-10-05, 93 MB together, both under the 100 MB file limit):
    - Gutenberg LCC-P, *Language and literature* (19 books, 37 MB):
      https://mirror.download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim
    - Wikipedia Mathematics, mini (~41,000 article introductions, 56 MB):
      https://mirror.download.kiwix.org/zim/wikipedia/wikipedia_en_mathematics_mini_2026-06.zim
    Both read fine from that mirror over range requests (metadata and the Gutenberg book index:
    ~20–30 requests, under 2 MB each). Use `download.kiwix.org/...` for plain downloads. With
    both in the folder, the kiosk's Rooms tab has a *Demo set* place shelving just them (19 books
    and 24 volumes of 23,326 articles: two bookcases).
