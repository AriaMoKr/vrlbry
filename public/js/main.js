// Bootstrap (SPEC §5.7): renderer, camera rig, XR session, loading, frame loop.

import * as THREE from 'three';
import { getCatalog, getBooks, rescan as requestRescan } from './api.js';
import { World } from './world/world.js';
import { Controls } from './xr/controls.js';
import { Interaction, DEFAULT_SETTINGS } from './interaction.js';
import { Overlay } from './ui/overlay.js';
import { audio } from './audio.js';
import { load } from './util/storage.js';
import { PLAYER } from './config.js';
import { collectionsFor } from './rooms.js';

const params = new URLSearchParams(location.search);
const overlay = new Overlay({ root: document.getElementById('overlay') });

// Dev: emulate a Quest 3 with IWER (must happen before anything queries navigator.xr).
let xrDevice = null;
if (params.get('xr') === 'emulate' || params.has('emulate')) {
  try {
    const { XRDevice, metaQuest3 } = await import('/vendor/iwer/iwer.module.js');
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
  const world = new World({ renderer, scene });
  await world.build(collectionsFor(libraries, booksByLib, settings), { sort: settings.sort });

  const controls = new Controls({ renderer, camera, rig, scene, world, domElement: renderer.domElement });
  controls.smoothMove = settings.smoothMove;
  controls.teleportTo(world.spawn.position, world.spawn.yaw);
  const interaction = new Interaction({ renderer, scene, camera, rig, world, controls, overlay, libraries, booksByLib, settings });

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
  });
  renderer.xr.addEventListener('sessionend', () => {
    overlay.show();
    controls.onSessionEnd();
  });
  overlay.onEnterVR(enterVR);
  overlay.onSearchPick((book) => interaction.searchPick(book));

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
  setInterval(async () => {
    if (refreshing || (document.visibilityState !== 'visible' && !renderer.xr.isPresenting)) return;
    try {
      const c = await getCatalog();
      if (c.generation !== generation) await applyCatalog(c);
      else if (JSON.stringify(c.libraries) !== JSON.stringify(libraries)) {
        // Same books, new details (e.g. indexing progress): refresh the texts only.
        libraries = c.libraries;
        overlay.setLibraries(libraries, booksByLib);
        interaction.updateLibraries(libraries);
      }
    } catch { /* server briefly unavailable: try again next time */ }
  }, 10000);
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
    timer.update(time);
    const dt = Math.min(0.1, timer.getDelta());
    step(dt);
    renderer.render(scene, camera);
  });

  window.__vrlbry = {
    renderer, scene, camera, rig, world, controls, interaction, overlay, xrDevice, settings, enterVR,
    /** Advances the app by n frames of dt seconds and renders (for automated tests). */
    tick(dt = 1 / 60, n = 1) {
      for (let i = 0; i < n; i++) step(dt);
      renderer.render(scene, camera);
    },
  };
  overlay.setLoading(null);
  if (!libraries.length) overlay.showToast('No .zim files found in the server folder.', 'error', 8000);
}

start().catch((err) => {
  console.error(err);
  overlay.setError(`Something went wrong while opening the library: ${err.message}`);
});
