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
