// Bootstrap (SPEC §5.7): renderer, camera rig, XR session, loading, frame loop.

import * as THREE from 'three';
import { getCatalog, getBooks, getVersion, rescan as requestRescan } from './api.js';
import * as localLibrary from './local/local.js';
import { World } from './world/world.js';
import { Controls } from './xr/controls.js';
import { Interaction, DEFAULT_SETTINGS } from './interaction.js';
import { Overlay } from './ui/overlay.js';
import { audio } from './audio.js';
import { load, save } from './util/storage.js';
import { progressText } from './util/progress.js';
import { PLAYER, XR_FRAME_RATE } from './config.js';
import { collectionsFor } from './rooms.js';
import { perf } from './perf.js';
import { copyText, debugReport, startErrorLog } from './debug-info.js';
import { parseScene, restoreScene, saveScene, savedScene } from './scene.js';

startErrorLog(); // first: the debug report lists the page's last errors
const params = new URLSearchParams(location.search);
const overlay = new Overlay({ root: document.getElementById('overlay') });
// Registered before anything can fail: the error screen offers the report too.
overlay.onDebugInfo(async () => {
  const text = JSON.stringify(debugReport(window.__vrlbry, { overlay }), null, 2);
  overlay.showDebugInfo(text, await copyText(text));
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
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    overlay.setError('This browser cannot show 3D graphics (WebGL is unavailable).');
    throw err;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  // Quest 3 is the target: native resolution (no supersampling) and moderate fixed foveation keep
  // the GPU within budget; the reading position is central, where foveation does not blur.
  renderer.xr.setFramebufferScaleFactor(1.0);
  renderer.xr.setFoveation(0.5);
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
  const world = new World({ renderer, scene });
  if (catalog.static) world.emptyText = ['No books here yet', 'This online version has no libraries yet'];
  await world.build(collectionsFor(libraries, booksByLib, settings), { sort: settings.sort });

  const controls = new Controls({ renderer, camera, rig, scene, world, domElement: renderer.domElement });
  controls.smoothMove = settings.smoothMove;
  controls.teleportTo(world.spawn.position, world.spawn.yaw);
  const interaction = new Interaction({ renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings });
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
  interaction.onSaveScene = sceneActions.save;
  interaction.onRestoreScene = sceneActions.restore;
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

  // Folder rescans: the server bumps `generation` when ZIM files are added or removed; poll it and
  // re-shelve (the rebuild waits until no book is open).
  let refreshing = false;
  async function applyCatalog(next, { manual = false } = {}) {
    if (refreshing) return;
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
      for (const l of added) overlay.showToast(`New library: ${l.title} (${(nextBooks[l.id]?.length || 0).toLocaleString()} books) — shelving…`, 'info', 6000);
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
  // picker, a drop or __vrlbry.openZim: shelved like the server's as soon as they are open.
  async function openLocalFiles(files) {
    const zims = files.filter((f) => /\.zim$/i.test(f.name ?? '') || !f.name);
    if (!zims.length) {
      overlay.showToast('Only .zim files can be opened.', 'error');
      return [];
    }
    // Shown until every file is open (a big file on a Quest takes a while), with the seconds so
    // far and, from the worker's progress, about how long is left; then the catalogue's "New
    // library" toast follows.
    const name = (f) => f.name || 'the ZIM file';
    let base = `Opening ${zims.length === 1 ? name(zims[0]) : `${zims.length} ZIM files`}…`;
    const status = overlay.showToast(base, 'busy', Infinity);
    const t0 = performance.now();
    let fraction = null;
    const tell = () => status.update(base + progressText(performance.now() - t0, fraction, { estimating: true }));
    const timer = setInterval(tell, 1000);
    let results;
    try {
      results = await localLibrary.openFiles(zims, {
        onFile: (file, i) => {
          if (zims.length > 1) {
            base = `Opening ${name(file)} (${i + 1} of ${zims.length})…`;
            tell();
          }
        },
        onProgress: (f) => {
          fraction = f;
          status.progress(f);
        },
      });
    } finally {
      clearInterval(timer);
      status.close();
    }
    for (const r of results) {
      if (r.error) overlay.showToast(r.error, 'error', 9000);
    }
    const added = results.filter((r) => r.id);
    if (added.length) {
      // Shelve the (first) new library: the catalogue's rebuild goes to its room.
      if (interaction.state === 'browse') {
        settings.place = added[0].id;
        save('settings', settings);
      }
      await applyCatalog(await getCatalog());
    }
    return results;
  }
  overlay.onOpenFiles(openLocalFiles);
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
    if (refreshing) return;
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
  if (navigator.xr?.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => overlay.setVRSupported(ok)).catch(() => overlay.setVRSupported(false));
  }

  const resize = () => {
    if (renderer.xr.isPresenting) return; // the XR session owns the framebuffer size
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', resize);
  renderer.xr.addEventListener('sessionend', resize);

  // Frame loop.
  const timer = new THREE.Timer();
  const step = (dt) => {
    controls.update(dt);
    interaction.update(dt);
    world.update(dt, camera);
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

  window.__vrlbry = {
    renderer, scene, camera, rig, world, controls, interaction, overlay, xrDevice, settings, enterVR,
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
  if (!libraries.length) {
    overlay.showToast(catalog.static ? 'This online version has no books yet. Run vrlbry yourself to read your ZIM files.'
      : 'No .zim files found in the server folder.', catalog.static ? 'info' : 'error', 8000);
  }
}

start().catch((err) => {
  console.error(err);
  overlay.setError(`Something went wrong while opening the library: ${err.message}`);
});
