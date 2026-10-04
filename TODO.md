# TODO

- **Load Wikipedia ZIMs.** A Wikipedia ZIM (mwoffliner, `Source` = `*.wikipedia.org`) currently
  falls back to generic mode: only its first 2,000 HTML articles in URL order (`--max-generic`).
  Needed:
  - detection, like `isWikisource`;
  - an article index built in the background and cached in `.cache/`, as for Wikisource.
    `wikipedia_en_all_maxi` has ~6.8 M articles (~100 GB), so expect a long first pass;
  - server-side paging and search. The client loads every book descriptor today, which cannot
    work for millions of articles: the catalogue, rooms, search and "recently read" all depend
    on it;
  - articles as short books (usually one chunk), with rooms by title letter or category. The
    200-bookcase cap (`MAX_BOOKCASES`) applies.
- **Gamepad support.** Only the gamepads built into the XR controllers are read (`src.gamepad` in
  `xr/controls.js`). A standard controller (Xbox, PlayStation or another Bluetooth pad, through
  `navigator.getGamepads()`) does nothing on desktop or phone. Map it like the VR controls:
  - left stick to walk, right stick to look and turn;
  - A to select or read, B to go back or put a book back;
  - shoulder buttons or the D-pad to turn pages;
  - a centre-of-screen pointer for picking books and using the kiosk panels.

  Emit the same `Controls` events so `interaction.js` needs no changes.
- **Dropped frames while walking.** A Quest 3 still drops ~4 % of frames walking an ordinary room
  and ~8 % in the all-libraries hall, with no clear cause since atlas uploads were fixed. Next:
  record GC and long-task timing per scenario (`?perf`, `tools/quest-perf.mjs`).
- **All-libraries hall draw calls.** Walking reaches ~134 draw calls per eye. Reduce them, or
  lower the 200-bookcase cap.
- **Laser through other objects.** Bookcases and panels stop the pointer ray; walls, the kiosk
  pedestal and the furniture do not.
- **Server code review.** An earlier review recorded 5 minor findings that were never fixed, and
  3 of its reviewers never finished.
