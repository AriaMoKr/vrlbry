// Bootstrap (SPEC §5.7): renderer, camera rig, XR session, loading, frame loop.

import * as THREE from 'three';
import { getCatalog, getBooks, getVersion, getChunk, imageSource, rescan as requestRescan } from './api.js';
import { TextView } from './ui/text-view.js';
import * as localLibrary from './local/local.js';
import { World } from './world/world.js';
import { Controls } from './xr/controls.js';
import { Interaction, DEFAULT_SETTINGS } from './interaction.js';
import { Overlay } from './ui/overlay.js';
import { audio } from './audio.js';
import { freezeStorage, load, save } from './util/storage.js';
import { progressText } from './util/progress.js';
import { handleStore, pickFiles, reopen, supportsHandles } from './local/handles.js';
import { fileNameOf, onKiwixMirror, zimUrl } from './local/zim-url.js';
import { defaultLanguage, kiwixCatalog } from './local/kiwix.js';
import { idbStore } from './local/idb-store.js';
import { PLAYER, SCENE_LABEL, XR_FRAME_RATE } from './config.js';
import { doorOf, wayOut } from './hallway.js';
import { loadNav, NAV_KEY, navDefaults } from './nav.js';
import { ACCESS_KEY, loadAccess, watchMotion } from '../vendor/common/access.js';
import { Together } from './together.js';
import { sessionText, spaceOf } from './together-space.js';
import { roomFromUrl } from '../vendor/layersharedsession/room.js';
import { leaveUrl } from '../vendor/common/door.js';
import { placeFromSearch, placeHref } from './place-url.js';
import { BackHistory } from '../vendor/common/back-history.js';
import { tvMode } from '../vendor/common/tv.js';
import { LibraryRemote } from './ui/remote.js';
import { collectionsFor, LOCAL_PLACE } from './rooms.js';
import { perf } from './perf.js';
import { copyText, debugReport, startErrorLog, noteError, saveFile, screenshot, screenshotName } from './debug-info.js';
import { resetStoredData } from './reset.js';
import { parseScene, restoreScene, saveScene, savedScene } from './scene.js';

startErrorLog(); // first: the debug report lists the page's last errors
const params = new URLSearchParams(location.search);
/** localStorage itself (the Hallway's keys are not under storage.js's prefix), or null where it cannot be read. */
const localStore = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
// The way out: to the Hallway, or to the place that linked here naming itself (?back=, hallway.js).
const way = wayOut(location.search);
const overlay = new Overlay({ root: document.getElementById('overlay'), wayOut: way });
// A TV (the Hallway's Android TV app, or ?tv=emulate: common's tv.js, SPEC §5.9): walked with its
// remote (ui/remote.js), the card for the ten-foot view (style.css, html.tv), no VR.
const tv = tvMode();
document.documentElement.classList.toggle('tv', tv);
overlay.setTV(tv);
// Registered before anything can fail: the error screen offers the report too.
overlay.onDebugInfo(async () => {
  const text = JSON.stringify(debugReport(window.__vrlbry, { overlay }), null, 2);
  overlay.showDebugInfo(text, await copyText(text));
});
// "Save screenshot" beside it: the 3D view as the GPU draws it (debug-info.js screenshot).
overlay.onScreenshot(async () => {
  const blob = await screenshot(window.__vrlbry).catch(() => null);
  if (!blob) {
    overlay.showToast('There is no 3D view to capture.', 'error', 5000);
    return;
  }
  const name = screenshotName();
  saveFile(blob, name);
  overlay.showToast(`Saved ${name}: attach it to your bug report.`, 'info', 6000);
});

// Dev: emulate a Quest 3 with IWER (must happen before anything queries navigator.xr).
let xrDevice = null;
if (params.get('xr') === 'emulate' || params.has('emulate')) {
  try {
    const { XRDevice, metaQuest3 } = await import(new URL('../vendor/iwer/iwer.module.js', import.meta.url).href);
    xrDevice = new XRDevice(metaQuest3);
    // Chromium exposes a native navigator.xr even without a headset; replace it on request.
    xrDevice.installRuntime({ forceInstall: true });
    console.info('[vrlbry] IWER WebXR emulation installed (Meta Quest 3).');
  } catch (err) {
    console.warn('[vrlbry] IWER emulation unavailable:', err);
  }
}

/** Tags each book with its library id (search and rooms need it for books not on the shelves). */
function withLib(books, libId) {
  for (const b of books) b.libId = libId;
  return books;
}

async function start() {
  overlay.setLoading('Opening the library…', 0.02);
  let renderer;
  try {
    // ?aa=0 (no antialiasing) and ?dpr=<n> (the pixel ratio's cap) are for trying a browser whose
    // view stays blank: a Pixel 11's Vivaldi drew frames but never showed them.
    renderer = new THREE.WebGLRenderer({ antialias: params.get('aa') !== '0', powerPreference: 'high-performance' });
  } catch (err) {
    overlay.setError('This browser cannot show 3D graphics (WebGL is unavailable).');
    throw err;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, Number(params.get('dpr')) || 2)); // 2 at most, a TV's too (as the Hallway's)
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  // Quest 3 is the target: native resolution (no supersampling) and moderate fixed foveation keep
  // the GPU within budget; the reading position is central, where foveation does not blur.
  renderer.xr.setFramebufferScaleFactor(1.0);
  renderer.xr.setFoveation(0.5);
  // The 3D view, named for a screen reader (the overlay's controls are the page's own elements).
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', SCENE_LABEL);
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0906);
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.03, 120);
  camera.position.set(0, PLAYER.eyeHeight, 0);
  const rig = new THREE.Group();
  rig.name = 'rig';
  rig.add(camera);
  scene.add(rig);

  const settings = { ...DEFAULT_SETTINGS, ...load('settings', {}) };
  audio.setEnabled(settings.sound);

  // Catalogue.
  overlay.setLoading('Reading the catalogue…', 0.08);
  const catalog = await getCatalog();
  let generation = catalog.generation;
  let libraries = catalog.libraries;
  let booksByLib = {};
  let done = 0;
  await Promise.all(libraries.map(async (lib) => {
    booksByLib[lib.id] = withLib(await getBooks(lib.id), lib.id);
    done++;
    overlay.setLoading(`Reading the catalogue… (${done}/${libraries.length})`, 0.1 + 0.4 * (done / Math.max(1, libraries.length)));
  }));
  overlay.setLibraries(libraries, booksByLib);

  // World.
  overlay.setLoading('Shelving the books…', 0.55);
  await new Promise((r) => setTimeout(r, 0)); // let the overlay paint before the heavy build
  // Online (a static build), a first visit opens the demo set when the site has it.
  if (catalog.static && !load('settings', {}).place) settings.place = 'demo';
  // A link naming a place and room (place-url.js; the address names the room shown) opens there.
  const linked = placeFromSearch(location.search, libraries);
  if (linked) {
    settings.place = linked.place;
    if (linked.room) (settings.rooms ||= {})[linked.place] = linked.room;
  }
  // The place saved last time: one of the libraries read from the web is not open yet (they are
  // reopened below), so the first build falls back, and openLocalFiles puts it back afterwards.
  const savedPlace = settings.place;
  const world = new World({ renderer, scene });
  world.setDoor(doorOf(way)); // the door back, in the wall behind the spawn point (world/door.js)
  if (catalog.static) world.emptyText = ['No books here yet', 'This online version has no libraries yet'];
  const firstShelved = collectionsFor(libraries, booksByLib, settings);
  await world.build(firstShelved, { sort: settings.sort });
  const startPlace = settings.place; // what the first build shelved (savedPlace, or its fallback)

  const controls = new Controls({ renderer, camera, rig, scene, world, domElement: renderer.domElement });
  controls.teleportTo(world.spawn.position, world.spawn.yaw);
  const interaction = new Interaction({ renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings, wayOut: way, nav: loadNav(localStore(), navDefaults(settings)), access: loadAccess(localStore()) });
  if (catalog.static) {
    // A build without a server (GitHub Pages, tools/build-pages.mjs): nothing to rescan.
    interaction.setStatic(true);
    overlay.setStatic(true);
  }

  // XR session handling.
  let session = null;
  async function enterVR() {
    audio.init();
    if (session) return session.end();
    if (!navigator.xr) return;
    try {
      session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
      });
      session.addEventListener('end', () => { session = null; });
      await renderer.xr.setSession(session);
    } catch (err) {
      session = null;
      console.error(err);
      overlay.showToast(`Could not start VR: ${err.message}`, 'error', 6000);
    }
  }
  // The text view of the open book (ui/text-view.js, SPEC §5.8): on a screen only; entering VR
  // closes it, so in a headset nothing changes.
  const textView = new TextView({
    root: document.getElementById('overlay'), interaction, getChunk, imageSource, tv,
    announce: (text) => overlay.announce(text),
    // Back to the button that opened it, or to the search once the book is put back (the button
    // goes); on a TV to the 3D view, walking again.
    returnFocus: (away) => (tv ? renderer.domElement : document.querySelector(away ? '.ov-search input' : '.ov-textview')),
  });
  interaction.textView = textView;
  overlay.onTextView(() => textView.toggle());
  overlay.setTextViewPref(settings.textView, (on) => {
    settings.textView = on;
    save('settings', settings);
    if (on && interaction.state === 'read') textView.open();
  });
  renderer.xr.addEventListener('sessionstart', () => textView.close());
  renderer.xr.addEventListener('sessionstart', () => {
    overlay.hide();
    interaction.onPresentingChange();
    setFrameRate(renderer.xr.getSession());
  });
  renderer.xr.addEventListener('sessionend', () => {
    overlay.show();
    controls.onSessionEnd();
    interaction.onPresentingChange();
  });
  /** Asks for XR_FRAME_RATE (or ?hz=), as the nearest rate the headset supports. */
  function setFrameRate(s) {
    const rates = s?.supportedFrameRates;
    if (!s?.updateTargetFrameRate || !rates?.length) return;
    const want = Number(params.get('hz')) || XR_FRAME_RATE;
    const rate = [...rates].reduce((best, r) => (Math.abs(r - want) < Math.abs(best - want) ? r : best));
    if (s.frameRate === rate) return;
    s.updateTargetFrameRate(rate).catch((err) => console.warn(`vrlbry: cannot switch to ${rate} Hz: ${err.message}`));
  }
  interaction.onExitVR = () => renderer.xr.getSession()?.end();
  interaction.onReload = () => location.reload();
  // The way out (hallway.js): leaving in VR, Quest Browser can keep the visitor in VR there, on
  // this page's origin only (the Hallway takes a granted session, as this page does below).
  // The shared session (together.js): joined when the address names a room (an invitation, or the
  // Hallway's door), left for now while going out by the door, whose link carries the room on, and
  // out of any once the visitor has left it (common's leaveUrl; its README, "Going in": keep `room`
  // on every link back).
  const together = new Together({ scene, camera, renderer, hands: () => controls.xrInputs });
  interaction.together = together;
  together.reduceMotion = interaction.reduced;
  const wayOutUrl = () => leaveUrl(way, together.room);
  const sessionNote = (text) => {
    overlay.showToast(text, 'info', 4000);
    if (renderer.xr.isPresenting) interaction.notice(text, '', 3);
  };
  together.onChange = () => {
    // On a TV its invite as text, to type on a phone or a computer (nothing to copy it with there).
    overlay.setSession(sessionText({ room: together.room, active: together.active, company: together.active ? together.company() : {} }), tv ? together.inviteLink : '');
    overlay.setWayOutHref(wayOutUrl());
    interaction.sessionChanged();
  };
  together.onNotice = sessionNote;
  const leaveSession = () => {
    together.stop();
    sessionNote('You left the shared session');
  };
  overlay.onLeaveSession(leaveSession);
  interaction.onLeaveSession = leaveSession;
  interaction.onLeaving = () => together.pause();
  interaction.onCameBack = () => together.resume();
  // Leaving another way (the card's link, the address bar, closing the tab): out of it too.
  addEventListener('pagehide', () => together.pause());
  interaction.onHallway = () => { location.href = wayOutUrl(); };
  together.onChange(); // the card's link: out of any session until one is joined
  // Back from there with the browser's Back, this page restored from its cache as it was left (dark,
  // in the doorway): in front of the door again.
  // The Hallway's movement choice may have changed there meanwhile, or in another tab (nav.js).
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    interaction.setNav(loadNav(localStore(), navDefaults(settings)), { store: false });
    interaction.setAccess(loadAccess(localStore()), { store: false });
    interaction.cameBack();
    together.resume();
  });
  addEventListener('storage', (e) => {
    if (e.key === NAV_KEY) interaction.setNav(loadNav(localStore(), navDefaults(settings)), { store: false });
    if (e.key === ACCESS_KEY) interaction.setAccess(loadAccess(localStore()), { store: false });
  });
  // The accessibility settings (common's access.js, every site's): the help dialog's choices, and
  // the system's reduced-motion preference changing while motion follows it.
  overlay.onAccess((change) => interaction.setAccess({ ...interaction.access, ...change }));
  watchMotion(() => interaction._applyAccess());
  // The browser's Back (its button, a phone's back gesture, Quest Browser's) along the links
  // followed in a book, as the toolbar's ↩ Back, then putting the book away (common's
  // back-history.js). Its fields keep the names vrlbry's own copy gave them (prefix), so the
  // entries already in visitors' tabs stay its own.
  const backHistory = new BackHistory({
    history, load: performance.timeOrigin,
    onBack: (depth) => interaction.backTo(depth),
    onAway: () => interaction.putAway(),
    prefix: 'vrlbry',
  });
  interaction.backHistory = backHistory;
  // The book's buttons in the card (a TV's, for the letter keys a remote has not got).
  overlay.onBookKey((key, code) => interaction.pressKey(key, code));
  // A TV's remote (SPEC §5.9): OK the gamepad's A at the middle of the view, the aim dot shown
  // without a pad, up and down scrolling the list the dot is on, Back one step back
  // (interaction.step), and the app asking the page what Back and Menu do (answerApp).
  if (tv) {
    const remote = new LibraryRemote({ canvas: renderer.domElement, overlay, textView, interaction });
    remote.answerApp(tv);
    interaction.tv = true;
    controls.aimMiddle = true;
    controls.scrollKey = (dir) => interaction.scrollUnderDot(dir);
    controls.onPadBack = () => remote.padBack();
    renderer.domElement.setAttribute('aria-describedby', 'ov-hint'); // what the remote does now
  }
  // The address names the place and room shown (place-url.js), replaced as they change (no history
  // entry per room), so it can be bookmarked, shared or reloaded. Back and Forward can land on an
  // entry from before the last change (a book's, a link's, the page's): its address is put right.
  let shown = null;
  const nameShown = () => {
    const href = shown && placeHref(location.href, shown.place, shown.room);
    if (href && href !== location.href) {
      try { history.replaceState(history.state, '', href); } catch { /* an address that cannot change (a sandbox) */ }
    }
  };
  const showPlace = (place, room) => {
    together.setSpace(spaceOf(place, room)); // where in the library, for the shared session
    shown = { place, room };
    nameShown();
  };
  addEventListener('popstate', (e) => {
    backHistory.popstate(e.state);
    nameShown();
  });
  interaction.onShelved = showPlace;
  showPlace(settings.place, firstShelved.length === 1 ? firstShelved[0].room : null);
  const invited = roomFromUrl(location.href);
  if (invited) together.start(invited);
  // Scenes (scene.js): one saved in the browser (Save / Restore scene in the help dialog and on the
  // kiosk), or pasted into the help dialog (a saved scene or a debug report).
  const tell = (msg, kind = 'info') => {
    overlay.showToast(msg, kind, 4000);
    if (renderer.xr.isPresenting) interaction.notice(msg, '', 3);
  };
  const showSaved = () => {
    const scene = savedScene();
    const text = scene?.at ? `Saved ${new Date(scene.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${scene.label ? ` · ${scene.label}` : ''}` : null;
    overlay.setSavedScene(text);
    interaction.setSavedScene(text);
  };
  async function showScene(scene) {
    overlay.showHelp(false);
    try {
      await restoreScene(window.__vrlbry, scene);
      tell('Scene restored');
    } catch (err) {
      tell(`Could not restore the scene: ${err.message}`, 'error');
    }
  }
  const sceneActions = {
    save() {
      try {
        saveScene(window.__vrlbry);
        showSaved();
        tell('Scene saved');
      } catch (err) {
        tell(`Could not save the scene: ${err.message}`, 'error');
      }
    },
    restore() {
      const scene = savedScene();
      if (scene) showScene(scene);
      else tell('No saved scene');
    },
    restoreText(text) {
      try {
        showScene(parseScene(text));
      } catch (err) {
        tell(`Could not restore: ${err.message}`, 'error');
      }
    },
  };
  overlay.onScene(sceneActions);
  overlay.onView({ reset: () => interaction.resetView(), toFront: () => interaction.bookToFront() });
  // The browser can take the graphics context back (a phone short of memory, a GPU reset): the
  // view goes black while the page goes on. three asks for it back; until then, say so (the error
  // toast also goes into "Copy debug info"). Its textures come back with it (tried with
  // WEBGL_lose_context).
  let lostView = null;
  renderer.domElement.addEventListener('webglcontextlost', () => {
    lostView?.close();
    lostView = overlay.showToast('The 3D view stopped: the browser took back its graphics memory. If it does not come back, reload the page.', 'error', Infinity);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    lostView?.close();
    lostView = null;
    console.warn('[vrlbry] The 3D view is back (WebGL context restored).');
    overlay.showToast('The 3D view is back.', 'info', 4000);
  });
  interaction.onSaveScene = sceneActions.save;
  interaction.onRestoreScene = sceneActions.restore;
  // "Reset stored data" (reset.js; the help dialog and the kiosk): nothing is saved from here on
  // and the worker that writes the indexes and the cache stops, the parts chosen are cleared, and
  // the page reloads, so nothing it holds in memory is written back.
  async function resetStored(parts) {
    overlay.showHelp(false);
    const busy = overlay.showToast('Clearing what this site keeps in this browser…', 'busy', Infinity);
    if (renderer.xr.isPresenting) interaction.notice('Clearing stored data', 'The page reloads', 10);
    freezeStorage();
    localLibrary.stop();
    const { databases } = await resetStoredData(parts);
    const left = Object.entries(databases).filter(([, s]) => s !== 'deleted').map(([name, s]) => `${name} (${s})`);
    if (left.length) {
      console.warn(`[vrlbry] Reset: not cleared yet: ${left.join(', ')}`);
      busy.update('Another tab of this site still uses part of it: it is cleared once that tab is closed. Reloading…');
      await new Promise((r) => setTimeout(r, 3000));
    }
    location.reload();
  }
  overlay.onReset(resetStored);
  interaction.onResetStored = resetStored;
  showSaved();
  controls.addEventListener('gamepad', (e) => overlay.setGamepad(e.detail.active));
  // When the website last changed, fetched once: it tells which version this page is running.
  let loadedVersion = null;
  getVersion().then(({ changed }) => {
    if (!changed) return;
    loadedVersion = changed;
    const text = `Updated ${new Date(changed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    overlay.setVersion(text);
    interaction.setVersion(text);
  }).catch(() => {});
  overlay.onEnterVR(enterVR);
  overlay.onSearchPick((book) => interaction.searchPick(book));
  overlay.onArticlePick((libId, article) => interaction.openArticle(libId, article.book, article.n));
  overlay.onTextPick((libId, hit) => interaction.openText(libId, hit));

  // Folder rescans: the server bumps `generation` when ZIM files are added or removed; poll it and
  // re-shelve (the rebuild waits until no book is open).
  let refreshing = false;
  let refreshAgain = false; // a refresh was asked for while one was being applied
  // The web addresses reopened as the page starts (filled in below): their libraries are not new
  // to the visitor, so the first time each appears it gets no "New library" toast.
  const reopenedQuietly = new Set();
  async function applyCatalog(next, { manual = false } = {}) {
    if (refreshing) { // one is being applied: fetch and apply the newest once it is done
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const oldById = new Map(libraries.map((l) => [l.id, l]));
      const nextBooks = {};
      for (const lib of next.libraries) {
        const old = oldById.get(lib.id);
        // Keep book lists of unchanged libraries; refetch new or replaced ones.
        nextBooks[lib.id] = old && JSON.stringify(old) === JSON.stringify(lib) && booksByLib[lib.id]
          ? booksByLib[lib.id] : withLib(await getBooks(lib.id), lib.id);
      }
      const added = next.libraries.filter((l) => !oldById.has(l.id));
      const removed = libraries.filter((l) => !next.libraries.some((n) => n.id === l.id));
      generation = next.generation;
      libraries = next.libraries;
      booksByLib = nextBooks;
      overlay.setLibraries(libraries, booksByLib);
      overlay.refreshKiwix?.(); // its Open buttons follow what is open
      for (const l of added) {
        if (l.indexing) continue; // its indexing toast says so (local), or the card does (server)
        // The site's own files (every visit) and the addresses reopened as the page starts are
        // not new, and the status box showed them opening: three toasts greeted every visitor.
        if (l.site || reopenedQuietly.delete(l.url)) continue;
        overlay.showToast(`New library: ${l.title} (${(nextBooks[l.id]?.length || 0).toLocaleString()} books) — shelving…`, 'info', 6000);
      }
      for (const l of removed) overlay.showToast(`Library removed: ${l.title}`, 'info', 5000);
      if (manual && !added.length && !removed.length) overlay.showToast('No new ZIM files found.');
      await new Promise((r) => setTimeout(r, 50)); // let the toast paint before the rebuild
      const now = await interaction.setCatalog(libraries, booksByLib);
      if (!now && (added.length || removed.length)) overlay.showToast('The shelves will be updated when you put the book back.');
    } catch (err) {
      console.warn('[vrlbry] catalogue refresh failed', err);
      if (manual) overlay.showToast(`Rescan failed: ${err.message}`, 'error');
    } finally {
      refreshing = false;
      // A refresh asked for meanwhile (a local library's index finished) runs now, rather than
      // waiting for the next poll, which a hidden page never runs.
      if (refreshAgain) {
        refreshAgain = false;
        setTimeout(refreshCatalog, 0);
      }
    }
  }
  async function rescanNow() {
    overlay.showToast('Rescanning the folder…', 'info', 2000);
    try {
      const r = await requestRescan();
      await applyCatalog({ generation: r.generation, libraries: r.libraries }, { manual: true });
    } catch (err) {
      overlay.showToast(`Rescan failed: ${err.message}`, 'error');
    }
  }
  overlay.onRescan(rescanNow);
  interaction.onRescan = rescanNow;

  // ZIM files opened in this browser (step 2: the local library, local/local.js), from the file
  // picker, a drop or __vrlbry.openZim, or from web addresses (strings, as zim-url.js makes them:
  // openUrls): shelved like the server's as soon as they are open. `reopening`: the web addresses
  // remembered from last time, opened as the page starts (the place is then put back, not moved).
  // `site`: the site's own ZIM files (catalog.zims), opened with every visit: not remembered.
  async function openLocalFiles(files, fileHandles = [], { reopening = false, site = false } = {}) {
    const picked = [...files].map((file, i) => ({ file, handle: fileHandles[i] ?? null }))
      .filter(({ file }) => typeof file === 'string' || /\.zim$/i.test(file.name ?? '') || !file.name);
    const zims = picked.map((p) => p.file);
    if (!zims.length) {
      overlay.showToast('Only .zim files can be opened.', 'error');
      return [];
    }
    // In the status box until every file is open (a big file on a Quest takes a while), with the
    // seconds so far and, from the worker's progress, about how long is left, and with several
    // files a Stop that opens no more; then the catalogue's "New library" toast follows.
    const name = localLibrary.sourceName;
    const job = {
      label: zims.length === 1 ? name(zims[0]) : `${zims.length} ZIM files`,
      t0: performance.now(), fraction: null, stoppable: zims.length > 1, stopping: false,
    };
    openings.add(job);
    renderStatus();
    let results;
    try {
      results = await localLibrary.openFiles(zims, {
        site,
        // The site's own files open at once (read from the site, they mostly wait on the network:
        // on a Quest the main site's three took ~10 s one after another); others one by one.
        concurrency: site ? zims.length : 1,
        stopped: () => job.stopping,
        onFile: (file, i) => {
          if (zims.length > 1 && !site) {
            job.label = `${name(file)} (${i + 1} of ${zims.length})`;
            renderStatus();
          }
        },
        onProgress: (f) => {
          job.fraction = f;
          renderStatus();
        },
        // Its title for its index build's row, as soon as this one file is open.
        onOpened: (r) => {
          const b = r.id && builds.get(r.id);
          if (b && r.title) {
            b.title = r.title;
            b.file = r.name;
            renderStatus();
          }
        },
      });
    } finally {
      openings.delete(job);
      renderStatus();
    }
    for (const r of results) {
      if (!r.error) continue;
      // Kiwix's other mirrors send no CORS headers: the same file on its own mirror can be read.
      const mirror = r.url && /CORS/.test(r.error) ? onKiwixMirror(r.url) : null;
      const hint = mirror ? ` Kiwix's own mirror lets pages read its files: ${mirror}` : '';
      // For "Copy debug info": which address failed (the toast names the file only).
      noteError('open', `${r.url ?? r.name}: ${r.error}`);
      // (The site's own files open with every visit: theirs "did not open", not "reopen".)
      const lead = site ? 'This site’s file did not open: ' : reopening ? 'Not reopened: ' : '';
      overlay.showToast(`${lead}${r.error}.${hint}`, 'error', mirror ? 15000 : 9000);
      // In VR the page's toasts are out of sight (a ZIM opened from the kiosk's Kiwix tab).
      if (controls.presenting) interaction.notice(`Could not open ${r.name}`, r.error, 8);
    }
    // Web addresses that opened are remembered and reopen with the page; one that did not reopen
    // stays remembered (the network may be down) and is offered on the "Last time" line.
    if (!site) rememberUrls(results.filter((r) => r.id && r.url));
    if (reopening && !site) {
      notReopened = results.filter((r) => r.error && r.url).map((r) => ({ url: r.url, name: r.name }));
      showRemembered();
    }
    const skipped = results.filter((r) => r.skipped).length;
    if (skipped) overlay.showToast(`Stopped: ${skipped} file${skipped === 1 ? '' : 's'} not opened.`, 'info', 5000);
    // A row for each build still under way. Not from the open's own snapshot alone: files open
    // one after another, and a small file's build may end while the next ones open (a toast for
    // it then never heard from the worker again and stood at 0 % for good, issue #1).
    for (const r of results) {
      if (!r.id || !r.indexing) continue;
      const seen = indexingSeen.get(r.id);
      if (seen !== 'done') trackIndexing(r.id, r.title, seen ?? r.indexing, r.name);
    }
    // Remembered (their handles kept), to be reopened after a reload: the ones that opened.
    const keep = picked.filter((p, i) => p.handle && results[i]?.id).map((p) => p.handle);
    if (keep.length) rememberFiles(keep);
    const added = results.filter((r) => r.id);
    if (added.length) {
      // Shelve the new library, or the files opened here together when there are several: the
      // catalogue's rebuild goes to that room. Reopened as the page starts, the place saved last
      // time comes back instead (unless the person has gone elsewhere meanwhile).
      if (interaction.state === 'browse') {
        // Not for the site's own files: the place saved may come from another of the sites that
        // share this origin (the same ZIM opened there has the same id), and a first visit of the
        // main site then showed Golf alone instead of its Demo set.
        // The site's own files do count when the address names one of them (place-url.js).
        const back = reopening && (!site || linked?.place === savedPlace) && savedPlace !== startPlace && settings.place === startPlace
          && (savedPlace === LOCAL_PLACE.id ? added.length > 1 : added.some((r) => r.id === savedPlace));
        if (back) settings.place = savedPlace;
        else if (!reopening) settings.place = added.length > 1 ? LOCAL_PLACE.id : added[0].id;
        save('settings', settings);
      }
      await applyCatalog(await getCatalog());
    }
    return results;
  }
  overlay.onOpenFiles(openLocalFiles);
  // ZIMs from the web (milestone 3: Kiwix's mirror), typed or pasted in the card, a dropped link or
  // __vrlbry.openUrl: read where they are, a few kilobytes at a time. Each address goes through
  // zim-url.js (Kiwix's download links become its mirror's, which lets a page read them).
  /** Whether a ZIM at this address is open: the same address, or the site's own copy of the same file. */
  const isOpen = (url) => libraries.some((l) => l.url === url || (l.site && fileNameOf(l.url) === fileNameOf(url)));
  async function openUrls(inputs) {
    const urls = [];
    for (const input of inputs) {
      const r = zimUrl(input);
      if (r.error) overlay.showToast(r.error, 'error', 8000);
      else if (isOpen(r.url) || urls.includes(r.url)) overlay.showToast(`${r.name} is already open.`, 'info', 5000);
      else urls.push(r.url);
    }
    return urls.length ? openLocalFiles(urls) : [];
  }
  overlay.onOpenUrl((input) => openUrls([input]));
  // Kiwix's library (milestone 3 step 5; optional): the ZIMs this app reads well, from Kiwix's
  // catalogue, in the card's dialog and on the kiosk's Kiwix tab (VR has no file picker and no
  // keyboard for an address). Its kind and language are remembered in the settings.
  // Its index labels need the names of the indexes kept in this browser: the worker's store
  // (local/idb-store.js), read from here (none without IndexedDB).
  let keptIndexes = null;
  const kiwix = kiwixCatalog({
    localIndexes: () => {
      keptIndexes ??= idbStore();
      return keptIndexes.names();
    },
  });
  const kiwixPrefs = () => ({ kind: settings.kiwix?.kind ?? 'gutenberg', lang: settings.kiwix?.lang ?? defaultLanguage() });
  const setKiwixPrefs = ({ kind, lang }) => {
    settings.kiwix = { kind, lang };
    save('settings', settings);
  };
  const kiwixOpen = (url) => isOpen(url);
  overlay.setKiwix({ catalog: kiwix, onOpen: (url) => openUrls([url]), isOpen: kiwixOpen, prefs: kiwixPrefs, setPrefs: setKiwixPrefs });
  interaction.setKiwix({ catalog: kiwix, prefs: kiwixPrefs, setPrefs: setKiwixPrefs, isOpen: kiwixOpen }, (url) => openUrls([url]));
  // The web addresses opened here, reopened with the page (no permission needed, unlike files):
  // [{ url, name }] in localStorage, in the order first opened; a library's × forgets its own.
  const remembered = () => {
    const list = load('zimUrls', []);
    return Array.isArray(list) ? list.filter((r) => typeof r?.url === 'string') : [];
  };
  let notReopened = []; // remembered addresses that did not open this time: on the "Last time" line
  function rememberUrls(opened) {
    if (!opened.length) return;
    const list = remembered();
    for (const r of opened) if (!list.some((k) => k.url === r.url)) list.push({ url: r.url, name: r.name });
    save('zimUrls', list);
  }
  function forgetUrls(urls) {
    save('zimUrls', remembered().filter((r) => !urls.includes(r.url)));
    notReopened = notReopened.filter((r) => !urls.includes(r.url));
  }
  // Files opened once can be reopened after a reload where the browser gives file handles (the
  // File System Access API: desktop Chrome and Edge, Quest Browser): the picker then goes through
  // it, the handles are kept (local/handles.js), and the card offers "Last time: … Reopen".
  const fileHandles = supportsHandles() ? handleStore() : null;
  // The "Last time" line: files whose handles are kept, and web addresses that did not reopen.
  async function showRemembered() {
    const files = fileHandles ? await fileHandles.list().catch(() => []) : [];
    overlay.setRemembered([...files.map((e) => e.name), ...notReopened.map((r) => r.name)]);
  }
  function rememberFiles(handles) {
    fileHandles?.remember(handles).then(showRemembered).catch(() => {});
  }
  if (fileHandles) overlay.onPickFiles(pickFiles);
  overlay.onReopen(async () => {
    const urls = notReopened.map((r) => r.url);
    notReopened = [];
    let files = [];
    let handles = [];
    if (fileHandles) {
      const entries = await fileHandles.list().catch(() => []);
      let failed;
      ({ files, handles, failed } = await reopen(entries));
      for (const name of failed) {
        overlay.showToast(`${name} could not be opened again: pick it afresh.`, 'error', 7000);
        fileHandles.forget(name).catch(() => {});
      }
    }
    overlay.setRemembered([]);
    if (files.length || urls.length) await openLocalFiles([...files, ...urls], handles, { reopening: !files.length });
  });
  overlay.onForget(() => {
    fileHandles?.forgetAll().catch(() => {});
    forgetUrls(notReopened.map((r) => r.url));
    overlay.setRemembered([]);
  });
  showRemembered();
  // What the local library is doing, in one status box at the page's foot (overlay.setStatus):
  // files being opened (its head line, bar and Stop), and the index builds of Wikipedia and
  // Wikisource files (a big one takes minutes on a headset), a row each behind a toggle with its
  // bar, the time so far and about how long is left, and a × that stops it and closes the file.
  // The worker builds them one at a time, the smallest first ("waiting" meanwhile), and says how
  // each goes (local.onIndexing).
  const openings = new Set(); // { label, t0, fraction, stoppable, stopping }: files being opened (openLocalFiles)
  const builds = new Map(); // lib id → { title, file, info, t0 (when it started, not while waiting) }
  let buildsReady = 0; // finished since the box appeared, for its summary and overall bar
  const indexingSeen = new Map(); // lib id → what the worker last said: { stage, progress }, or 'done' (ready, failed or closed)
  function trackIndexing(id, title, info, file) {
    if (!info || info.done || info.stage === 'failed') {
      if (builds.delete(id) && !info?.error) buildsReady++;
      if (info?.stage === 'failed') overlay.showToast(`Could not index ${title}: ${info.error}`, 'error', 9000);
      return renderStatus();
    }
    let b = builds.get(id);
    if (!b) builds.set(id, b = { title, file, t0: null });
    if (title && title !== id) b.title = title;
    if (file) b.file = file;
    if (info.stage !== 'queued') b.t0 ??= performance.now();
    b.info = info;
    renderStatus();
  }
  function renderStatus() {
    if (!builds.size) buildsReady = 0;
    const job = [...openings].at(-1);
    if (!builds.size && !job) return overlay.setStatus(null);
    const rows = [...builds].map(([id, b]) => {
      const waiting = b.info.stage === 'queued';
      const time = b.t0 === null ? '' : progressText(performance.now() - b.t0, b.info.progress, { estimating: true }).replace(/^ · /, '');
      return { id, title: b.title, waiting, fraction: waiting ? 0 : b.info.progress, line: waiting ? 'waiting' : time || 'starting' };
    });
    let summary;
    let fraction;
    if (job) { // opening files comes first: their builds wait for them
      summary = `Opening ${job.label}…${progressText(performance.now() - job.t0, job.fraction, { estimating: true })}`
        + `${rows.length ? ` · ${rows.length} to index` : ''}`;
      fraction = job.fraction ?? 0;
    } else {
      const now = rows.find((r) => !r.waiting);
      const waiting = rows.filter((r) => r.waiting).length;
      summary = rows.length === 1
        ? `Indexing ${rows[0].title}${now ? ` · ${now.line}` : ' · waiting'}`
        : `Indexing ${rows.length} files${buildsReady ? ` · ${buildsReady} ready` : ''}${now ? ` · ${now.title}: ${now.line}` : ''}${waiting ? ` · ${waiting} waiting` : ''}`;
      fraction = (buildsReady + rows.reduce((s, r) => s + r.fraction, 0)) / (buildsReady + rows.length);
    }
    const stop = job?.stoppable ? { label: job.stopping ? 'Stopping…' : 'Stop', disabled: job.stopping } : null;
    overlay.setStatus({ summary, fraction, stop, rows });
  }
  setInterval(() => { if (builds.size || openings.size) renderStatus(); }, 1000);
  overlay.onStopOpening(() => {
    const job = [...openings].at(-1);
    if (job?.stoppable) {
      job.stopping = true;
      renderStatus();
    }
  });
  const cancelled = new Set(); // lib ids closed with a row's ×: their builds' last words are ignored
  localLibrary.onIndexing(({ id, file, ...info }) => {
    if (cancelled.has(id)) return;
    indexingSeen.set(id, info.done || info.stage === 'failed' ? 'done' : info);
    // Before its open answers, a build is named by its file.
    const title = builds.get(id)?.title ?? libraries.find((l) => l.id === id)?.title ?? (file ? file.replace(/\.zim$/i, '') : id);
    trackIndexing(id, title, info, file);
  });
  // A status row's × or a local library's × in the card: close it (stopping its index build, if
  // one runs), and forget it for "Reopen" or, read from the web, for the next page load.
  async function closeLocal(id) {
    const lib = libraries.find((l) => l.id === id);
    const file = builds.get(id)?.file ?? lib?.file;
    cancelled.add(id);
    indexingSeen.set(id, 'done');
    builds.delete(id);
    renderStatus();
    await localLibrary.close(id).catch(() => {});
    if (lib?.url) forgetUrls([lib.url]);
    else if (file && fileHandles) await fileHandles.forget(file).catch(() => {});
    showRemembered();
    await refreshCatalog();
  }
  overlay.onIndexingCancel(closeLocal);
  overlay.onCloseLibrary(closeLocal);
  // The web addresses opened before reopen now, in the background (the status box says so); the
  // place saved last time comes back once its library is open (openLocalFiles).
  const reopenUrls = remembered().map((r) => r.url);
  for (const url of reopenUrls) reopenedQuietly.add(url);
  // The site's own ZIM files first (a static build's --zim-files: on the main site, part of the
  // demo set ships as ZIM files, read from the site itself like web addresses): opened with every
  // visit, in the Demo set (rooms.js), neither remembered nor in "Opened here".
  const siteZims = (catalog.zims ?? []).map((z) => new URL(z.path, location.href).href);
  (async () => {
    if (siteZims.length) await openLocalFiles(siteZims, [], { reopening: true, site: true });
    if (reopenUrls.length) await openLocalFiles(reopenUrls, [], { reopening: true });
  })().catch((err) => console.warn('[vrlbry] reopening', err));
  // A new version of the site (a deploy, or edited client files) means this page runs old code, and
  // new data may need the new code: a page left open across a deploy once took a new ZIM into the
  // catalogue but not into the Demo set, whose list was in the old rooms.js. So once the version
  // changes, catalogue changes are no longer applied, and the page asks to be reloaded.
  // The banner and the VR notice can be turned off ("Don't show again", or the help dialog's
  // checkbox: settings.updateNotices); the kiosk's footer note and highlighted reload stay.
  let outdated = false;
  const notices = () => settings.updateNotices !== false;
  const showUpdate = () => overlay.showUpdate({
    onReload: () => location.reload(),
    onNever: () => {
      setUpdateNotices(false);
      overlay.showToast('Update notices are off. The help (?) can turn them back on.', 'info', 6000);
    },
  });
  function setUpdateNotices(on) {
    settings.updateNotices = on;
    save('settings', settings);
    overlay.setUpdateNotices(on);
    if (!on) overlay.hideUpdate();
    else if (outdated) showUpdate();
  }
  overlay.setUpdateNotices(notices(), setUpdateNotices);
  async function isOutdated() {
    if (outdated || !loadedVersion) return outdated;
    const { changed } = await getVersion();
    if (changed && changed !== loadedVersion) {
      outdated = true;
      if (notices()) showUpdate();
      interaction.setOutdated(true, { notice: notices() });
    }
    return outdated;
  }
  async function refreshCatalog() {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    try {
      if (await isOutdated()) return;
      const c = await getCatalog();
      if (c.generation !== generation) await applyCatalog(c);
      else if (JSON.stringify(c.libraries) !== JSON.stringify(libraries)) {
        // Same books, new details (e.g. indexing progress): refresh the texts only.
        libraries = c.libraries;
        overlay.setLibraries(libraries, booksByLib);
        interaction.updateLibraries(libraries);
      }
    } catch { /* server briefly unavailable: try again next time */ }
  }
  setInterval(() => {
    if (document.visibilityState === 'visible' || renderer.xr.isPresenting) refreshCatalog();
  }, 10000);
  // A local library's index finished (a Wikipedia file opened here): its books are there now.
  localLibrary.onChange(refreshCatalog);
  if (!tv && navigator.xr?.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => overlay.setVRSupported(ok)).catch(() => overlay.setVRSupported(false));
  }

  const resize = () => {
    if (renderer.xr.isPresenting) return; // the XR session owns the framebuffer size
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    interaction.onResize(); // an open book: one page upright, two across ('auto')
  };
  addEventListener('resize', resize);
  renderer.xr.addEventListener('sessionend', resize);

  // Frame loop.
  const timer = new THREE.Timer();
  const step = (dt) => {
    controls.update(dt);
    interaction.update(dt);
    world.update(dt, camera);
    together.update(performance.now()); // the others in the session, and where this visitor is
  };
  renderer.setAnimationLoop((time) => {
    const start = perf.enabled ? performance.now() : 0;
    timer.update(time);
    const dt = Math.min(0.1, timer.getDelta());
    if (perf.enabled) perf.beforeFrame(dt);
    step(dt);
    renderer.render(scene, camera);
    if (perf.enabled) perf.afterFrame(time, start, renderer.info.render);
  });
  // Walked in from another page's immersive session (a door of the Hallway): Quest Browser grants
  // this page a session without a click (sessiongranted; index.html notes one that came while the
  // library was loading), taken as the Enter VR button would, so the visitor stays in VR. A grant
  // lasts ~5 s from the page's start (SPEC §5.7), so the startup above must stay well within that.
  const takeGranted = () => { if (!session && !renderer.xr.isPresenting) enterVR(); };
  if (!tv) {
    if (window.vrlbryXrGranted) takeGranted();
    navigator.xr?.addEventListener?.('sessiongranted', takeGranted);
  }

  window.__vrlbry = {
    renderer, scene, camera, rig, world, controls, interaction, overlay, xrDevice, settings, enterVR, together,
    /** When the site's files last changed as of this page load (GET /api/version), or null. */
    get version() { return loadedVersion; },
    /** Advances the app by n frames of dt seconds and renders (for automated tests). */
    tick(dt = 1 / 60, n = 1) {
      for (let i = 0; i < n; i++) step(dt);
      renderer.render(scene, camera);
    },
    /**
     * Dev: shows this page what a "Copy debug info" report's sender saw (scene.js restoreScene:
     * place, room, sort, reading settings, viewpoint, the book and page, the dialogs). Pasting the
     * report into the help dialog does the same.
     */
    reproduce: (report) => restoreScene(window.__vrlbry, report),
    /** Opens ZIM files in the browser's local library (a File, Blob or a list): as the file picker does. */
    openZim: (files) => openLocalFiles(files instanceof Blob ? [files] : [...files]),
    /** Opens a ZIM from a web address (or a list), as the card's address field does. */
    openUrl: (urls) => openUrls(typeof urls === 'string' ? [urls] : [...urls]),
  };
  // ?perf: record frame timing and events for tools/quest-perf.mjs (window.__vrlbry.perf).
  if (params.has('perf')) {
    perf.start({
      renderer,
      context: () => ({
        place: settings.place, rooms: settings.rooms, sort: settings.sort, state: interaction.state,
        room: world.room?.kind ?? null, bookcases: world.shelves.cases.length, books: world.shelves.books().length,
        lod: world.shelves.lodStats(), atlasWorker: !!world.shelves._worker,
      }),
    });
    perf.run = async (only) => (await import('./perf-scenarios.js')).runScenarios(window.__vrlbry, { only });
    window.__vrlbry.perf = perf;
    overlay.showToast('Recording performance (?perf)', 'info', 4000);
  }
  overlay.setLoading(null);
  if (!libraries.length && !reopenUrls.length) { // (web addresses opened before are reopening)
    overlay.showToast(catalog.static ? 'This online version has no books of its own: open a ZIM file or a ZIM\'s web address here, or run vrlbry yourself.'
      : 'No .zim files found in the server folder.', catalog.static ? 'info' : 'error', 8000);
  }
}

start().catch((err) => {
  console.error(err);
  overlay.setError(`Something went wrong while opening the library: ${err.message}`);
});
