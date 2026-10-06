// Scenes: what a page shows, as data: the place, room and sort, the viewpoint, the book out and the
// page shown (and on which side of the spread), the reading settings, and the dialogs (the page's
// own menus and the 3D panels). "Save scene" / "Restore scene" (help dialog, kiosk) keep one in the
// browser; a "Copy debug info" report (debug-info.js) contains one, so pasting a report into the
// help dialog, or __vrlbry.reproduce(report), shows another page what its sender saw.

import { load, save } from './util/storage.js';

const KEY = 'scene';
/** The settings a scene carries: those that change what a book looks like. */
const READING = ['fontScale', 'theme', 'readScale', 'readDistance'];

/** Runs fn; a part that fails (or a page that failed before the app existed) leaves a note instead. */
export const part = (fn) => {
  try {
    return fn();
  } catch (err) {
    return `unavailable (${err.message})`;
  }
};

/**
 * The scene a page shows now, part by part.
 * @param {object} [app] window.__vrlbry (absent while loading or when loading failed)
 * @param {{ overlay?: object }} [o] the page's overlay, which exists before the app does
 * @returns {{ view, book, settings, ui }}
 */
export function sceneOf(app, { overlay = app?.overlay } = {}) {
  const I = app?.interaction;
  const s = app?.settings;
  return {
    view: part(() => ({
      state: I.state, place: s.place, room: s.rooms?.[s.place] ?? null, sort: s.sort,
      bookcases: app.world.shelves.cases.length, viewpoint: app.controls?.viewpoint?.() ?? null,
    })),
    // The page shown: its label, its block anchor and side, which a restore reopens the book at.
    book: part(() => {
      if (!I.book) return null;
      const ref = I.reader && I._currentRef();
      return {
        library: I.book.libId, id: I.book.id, title: I.book.title,
        at: ref ? I.reader.labelOf(ref) : null, anchor: ref ? I.reader.anchorOf(ref) : null,
        side: ref ? (ref === I._cur?.spread?.left ? 'left' : 'right') : null,
      };
    }),
    settings: part(() => Object.fromEntries(READING.filter((k) => s[k] != null).map((k) => [k, s[k]]))),
    // The dialogs: the page's own menus as they were when the help was opened, and the 3D panels.
    ui: part(() => ({ page: overlay?.reportUi?.() ?? null, ...(I?.uiState?.() ?? {}) })),
  };
}

/** A scene from pasted text (a saved scene or a debug report); throws when it is neither. */
export function parseScene(text) {
  let scene;
  try {
    scene = JSON.parse(String(text ?? '').trim());
  } catch {
    throw new Error('that is not a vrlbry scene or debug report (not JSON)');
  }
  if (!scene?.view || typeof scene.view !== 'object' || !('place' in scene.view)) {
    throw new Error('that is not a vrlbry scene or debug report');
  }
  return scene;
}

/**
 * Shows a scene: its place, room, sort and reading settings (saved, like choosing them on the
 * kiosk), its viewpoint, the book (opened at the same page, on the same side), and the dialogs.
 * A place this site does not have falls back to another library, as on load; a book it does not
 * have is left out.
 * @param {object} app window.__vrlbry
 * @param {object} scene a scene, a debug report, or a report's `view`
 * @returns {Promise<{ place: string|null, viewpoint: object, state: string, book: string|null }>}
 */
export async function restoreScene(app, scene) {
  const view = scene?.view ?? scene;
  if (!view || typeof view !== 'object' || !('place' in view)) throw new Error('not a vrlbry scene or debug report');
  const { interaction: I, controls, overlay, settings } = app;
  if (I.state === 'inspect') await I.putBack();
  if (I.state === 'read') await I.closeBook();
  if (I.state !== 'browse') throw new Error('the library is busy; try again in a moment');
  settings.rooms ||= {};
  if (view.sort) settings.sort = view.sort;
  settings.place = view.place;
  if (view.room) settings.rooms[view.place] = view.room;
  else delete settings.rooms[view.place];
  const s = scene?.settings;
  if (s && typeof s === 'object') for (const key of READING) if (s[key] != null) settings[key] = s[key];
  save('settings', settings);
  await I._rebuildWorld();
  // The viewpoint first: a book taken out is held in front of the viewer.
  if (view.viewpoint) controls.setViewpoint(view.viewpoint);
  const b = scene?.book;
  const book = b && typeof b === 'object' && (view.state === 'inspect' || view.state === 'read')
    ? (I.booksByLib[b.library] || []).find((x) => String(x.id) === String(b.id)) : null;
  if (book && I.world.shelves.books().includes(book)) {
    await I.pick(book);
    if (view.state === 'read') await I.read(b.anchor ? { at: b.anchor, side: b.side } : { fromStart: true });
  }
  overlay?.restoreUi(scene?.ui?.page);
  await I.restoreUi(scene?.ui);
  return { place: settings.place, viewpoint: controls.viewpoint(), state: I.state, book: I.book?.title ?? null };
}

/** Saves the page's scene as the browser's one saved scene (with when, and a short label). */
export function saveScene(app) {
  const I = app.interaction;
  const place = part(() => I._place()?.title ?? null);
  const label = [typeof place === 'string' ? place : null, I.book?.title].filter(Boolean).join(' · ');
  const scene = { app: 'vrlbry', scene: 1, at: new Date().toISOString(), label, ...sceneOf(app) };
  if (!save(KEY, scene)) throw new Error('this browser does not allow saving');
  return scene;
}

/** The browser's saved scene, or null. */
export const savedScene = () => load(KEY, null);
