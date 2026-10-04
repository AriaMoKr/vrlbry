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
    its 1,000 article titles, so the contents panel needs a letter jump.
  - The index reads no article text: it reads every directory entry, then each page's HTML size
    (to drop mwoffliner's section-redirect pages and estimate lengths), sorts, cuts into
    volumes and caches in `.cache/`. Simple English takes 56 s; sorting ~6.8 M English titles
    costs memory and about a minute more.
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
- **Wikipedia: still to do.** A letter jump in the contents panel (a volume lists 1,000
  articles); trying the full English maxi (~6.8 M articles, ~119 GB; the index's directory scan,
  size pass and 6.8 M-title sort take memory and time); trying a volume on the Quest.
- **Wikipedia: follow links** (later). Tapping a link in an article goes to that article, taking
  its volume off the shelf if needed. The reader cannot follow links today.
- **Wikipedia: article search.** Typing an article title opens the right volume at that article.
  This needs a server endpoint, because the client cannot hold millions of titles; redirects
  could serve as aliases.
- **Wikipedia in the all-libraries hall.** It stays out for now. Decide later whether it gets a
  fair share of the 200 bookcases.
- **Dropped frames while walking.** A Quest 3 still drops ~4 % of frames walking an ordinary room
  and ~8 % in the all-libraries hall, with no clear cause since atlas uploads were fixed. Next:
  record GC and long-task timing per scenario (`?perf`, `tools/quest-perf.mjs`).
- **All-libraries hall draw calls.** Walking reaches ~134 draw calls per eye. Reduce them, or
  lower the 200-bookcase cap.
- **Laser through other objects.** Bookcases and panels stop the pointer ray; walls, the kiosk
  pedestal and the furniture do not.
- **Server code review.** An earlier review recorded 5 minor findings that were never fixed, and
  3 of its reviewers never finished.
