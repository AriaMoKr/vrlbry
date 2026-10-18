# The Librarian: experiments

Experiments with an AI librarian in vrlbry, on the local branch `librarian` (not pushed, not on
GitHub Pages). Nothing here is built yet: these are the proposals, cheapest first, each one
something to try on its own.

The model is the Librarian of Neal Stephenson's *Snow Crash* (1992): a daemon who fronts a vast
library in the Metaverse, appears as a pleasant silver-haired man in a sweater and tie, and finds,
retrieves and cross-references anything at once, but will not speculate or draw conclusions. He
can only find things; what they mean is the reader's to work out.

## The experiments

### 1. A librarian at the desk, no AI yet

A figure near the kiosk takes a question and answers it with the search the app already has
(titles and authors: `search.js`; Wikipedia articles and their redirects: `searchIndex`,
`searchRedirects`), then leads you to the book: walks to the shelf or lights a path, and hands it
to you (`interaction.ensureShelved`, `interaction.openArticle`). It can speak its answers with the
browser's speech synthesis (`speechSynthesis`).

This builds the body, the conversation panel (`ui/panel.js`; `interaction.notice` for a word in
the headset) and the "take me there" part that every later experiment reuses. It works offline and
on the Quest.

### 2. "I can only find things": answers with citations

A language model gets the library as tools: search titles, search articles, read a chunk of a
book or article (`ArchiveLibrary.chunk`), open a book at a passage. Like Stephenson's Librarian,
it never speculates: every statement points to a source, a book and a block anchor `{c, b}`, and
selecting the source opens the book at that exact paragraph. This is the core of the idea, and the
citation rule also keeps the model from making things up.

- It runs through the Node server (a route beside `server/http.js`'s), because the static site
  cannot hold an API key. The key goes in the server's environment, set by hand, never through
  chat; or a local model (Ollama) instead.
- It is opt-in: a question sent to a hosted model leaves the device.
- It would use Claude Haiku 5.5 (`claude-haiku-5-5`) or Sonnet 5.5 (`claude-sonnet-5-5`).

### 3. Cross-references between libraries

While you read *Moby-Dick* from Gutenberg, the librarian offers the Wikipedia article on Melville,
his other works on Wikisource, and the articles a passage mentions. A first version can match
titles and authors without any AI; the model from experiment 2 can add looser connections later.
This makes the separate ZIMs feel like one library.

### 4. Voice in VR

VR has no keyboard, so speaking is the natural way in: hold a controller button
(`xr/controls.js` `button` events), speak, hear the answer. The first step is a measurement:
whether Quest Browser supports the browser's speech recognition (`SpeechRecognition`) at all. If
not, the options are speech recognition on the server, or a small Whisper model in the browser
(heavy).

### 5. A model on the device

A probe of whether a small language model runs in the browser over WebGPU, on the desktop and on
the Quest: tokens per second, memory, and whether the room still holds 72 Hz (measured with
`tools/quest-perf.mjs`). Nothing would leave the device, but the Quest probably cannot do both at
once. This tells us whether that route is open at all.

## Where to start

1, then 2. Experiment 1 settles the figure, the panel and walking you to the book; experiment 2
then plugs a model into the same desk, and its citation rule is what makes it the Librarian rather
than a chatbot.

To decide before experiment 2: a hosted model with an API key, or a local model.

## Ground rules

These follow the project's own (CLAUDE.md, TODO.md):

- **Optional.** The library works exactly as now without the librarian; no model, server or
  network service is ever required to open and read a book.
- **No telemetry.** The page reports nothing about its visitors. A question goes to a model only
  when someone asks one, opted in, and nothing is logged beyond that.
- **The Quest is the target.** The figure and its panel stay within the draw-call budget, per-frame
  code allocates nothing, and nothing heavy runs in one frame.
- **English first.**
