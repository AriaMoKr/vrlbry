// Bootstrap (SPEC §5.7): renderer, camera rig, XR session, loading, frame loop.

import * as THREE from 'three';
import { getLibraries, getBooks } from './api.js';
import { World } from './world/world.js';
import { Controls } from './xr/controls.js';
import { Interaction, DEFAULT_SETTINGS } from './interaction.js';
import { Overlay } from './ui/overlay.js';
import { audio } from './audio.js';
import { load } from './util/storage.js';
import { PLAYER } from './config.js';

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
  renderer.xr.setFramebufferScaleFactor(1.2); // crisper page text in the headset
  renderer.xr.setFoveation(0.3);
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
  const libraries = await getLibraries();
  const booksByLib = {};
  let done = 0;
  await Promise.all(libraries.map(async (lib) => {
    booksByLib[lib.id] = await getBooks(lib.id);
    done++;
    overlay.setLoading(`Reading the catalogue… (${done}/${libraries.length})`, 0.1 + 0.4 * (done / Math.max(1, libraries.length)));
  }));
  overlay.setLibraries(libraries, booksByLib);

  // World.
  overlay.setLoading('Shelving the books…', 0.55);
  await new Promise((r) => setTimeout(r, 0)); // let the overlay paint before the heavy build
  const world = new World({ renderer, scene });
  await world.build(libraries.map((library) => ({ library, books: booksByLib[library.id] })), { sort: settings.sort });

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
