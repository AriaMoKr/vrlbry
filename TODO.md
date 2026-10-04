# TODO

- **Load Wikipedia ZIMs.** A Wikipedia ZIM (mwoffliner, `Source` = `*.wikipedia.org`) currently
  falls back to generic mode: only its first 2,000 HTML articles in URL order (`--max-generic`).
  Planned look: Wikipedia is its own room of encyclopedia volumes. Each book covers a range of
  titles (its spine shows the range, e.g. "Aachen – Abbey") with about 1,000 pages per volume.
  Open questions are in the design discussion of 2026-10-04 (what a page is, which ZIM, title
  order, links, search, the all-libraries hall). Needed:
  - detection, like `isWikisource`;
  - an article index built in the background and cached in `.cache/`, as for Wikisource.
    `wikipedia_en_all_maxi` has ~6.8 M articles (~100 GB), so expect a long first pass;
  - volumes as the books: the index stores each volume's first and last article, and reading a
    volume streams its articles as chunks, each starting on a fresh page, with the article list
    as its contents. English needs roughly 5,000–9,000 volumes, a catalogue the client can load
    as it is, and at ~65 volumes per bookcase they may fit one room under the 200-bookcase cap;
  - server-side article search (title → volume and page), since the client cannot hold millions
    of article titles.
- **Dropped frames while walking.** A Quest 3 still drops ~4 % of frames walking an ordinary room
  and ~8 % in the all-libraries hall, with no clear cause since atlas uploads were fixed. Next:
  record GC and long-task timing per scenario (`?perf`, `tools/quest-perf.mjs`).
- **All-libraries hall draw calls.** Walking reaches ~134 draw calls per eye. Reduce them, or
  lower the 200-bookcase cap.
- **Laser through other objects.** Bookcases and panels stop the pointer ray; walls, the kiosk
  pedestal and the furniture do not.
- **Server code review.** An earlier review recorded 5 minor findings that were never fixed, and
  3 of its reviewers never finished.
