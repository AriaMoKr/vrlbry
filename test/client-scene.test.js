// Scenes (public/js/scene.js): saving, parsing pasted text and restoring, with a fake page.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseScene, restoreScene, saveScene, savedScene, sceneOf } from '../public/js/scene.js';

/** A fake page: records what restoreScene asks of it, in order. */
function fakeApp({ state = 'browse', shelved = true } = {}) {
  const calls = [];
  const book = { libId: 'wp', id: 'v41', title: 'Bouelles – Brass band' };
  const settings = { place: 'gutenberg', rooms: { wp: { genre: null, letter: 'B' } }, sort: 'author', fontScale: 1, theme: 'paper', sound: true };
  const I = {
    state,
    booksByLib: { wp: [{ id: 'v40' }, book] },
    world: { shelves: { books: () => (shelved ? [book] : []), cases: [1, 2, 3] } },
    book: null,
    async putBack() { calls.push('putBack'); this.state = 'browse'; },
    async closeBook() { calls.push('closeBook'); this.state = 'browse'; },
    async _rebuildWorld() { calls.push(`rebuild ${settings.place} ${settings.sort} font ${settings.fontScale}`); },
    async pick(b) { calls.push(`pick ${b.id}`); this.state = 'inspect'; this.book = b; },
    async read(o) { calls.push(`read ${JSON.stringify(o)}`); this.state = 'read'; },
    async restoreUi(ui) { calls.push(`3d ui ${ui?.kiosk?.tab}`); },
    _place: () => ({ title: 'Wikipedia in simple English' }),
    uiState: () => ({ kiosk: { tab: 'search', search: 'moon', scroll: {} }, contents: null }),
  };
  const app = {
    interaction: I, settings,
    world: I.world,
    controls: {
      vp: null,
      setViewpoint(v) { calls.push(`viewpoint ${v.x},${v.z}`); this.vp = v; },
      viewpoint() { return this.vp; },
    },
    overlay: { restoreUi: (ui) => calls.push(`page ui ${ui?.card}`), reportUi: () => ({ card: 'collapsed' }) },
  };
  return { app, calls, book };
}

const SCENE = {
  view: { state: 'read', place: 'wp', room: null, sort: 'title', viewpoint: { x: 0.4, z: 0.2, yaw: -0.5, pitch: -0.3 } },
  book: { library: 'wp', id: 'v41', anchor: { c: 2, b: 0 }, side: 'left' },
  settings: { fontScale: 1.2, theme: 'night', sound: false },
  ui: { page: { card: 'collapsed' }, kiosk: { tab: 'search' } },
};

describe('scenes', () => {
  let stored;
  beforeEach(() => {
    stored = new Map();
    globalThis.localStorage = {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
    };
  });
  afterEach(() => { delete globalThis.localStorage; });

  it('restores in order: put the book back, the room, the viewpoint, the book at its page, the dialogs', async () => {
    const { app, calls } = fakeApp({ state: 'read' });
    const r = await restoreScene(app, SCENE);
    assert.deepEqual(calls, [
      'closeBook',
      'rebuild wp title font 1.2',
      'viewpoint 0.4,0.2',
      'pick v41',
      'read {"at":{"c":2,"b":0},"side":"left"}',
      'page ui collapsed',
      '3d ui search',
    ]);
    assert.equal(app.settings.theme, 'night', 'reading settings come along');
    assert.equal(app.settings.sound, true, 'other settings stay');
    assert.equal(app.settings.rooms.wp, undefined, 'no room in the scene: the library’s default');
    assert.equal(r.state, 'read');
    assert.equal(r.book, 'Bouelles – Brass band');
  });

  it('leaves out a book that is not on the shelves, and refuses what is not a scene', async () => {
    const { app, calls } = fakeApp({ shelved: false });
    await restoreScene(app, SCENE);
    assert.ok(!calls.some((c) => c.startsWith('pick')));
    await assert.rejects(restoreScene(app, { hello: 1 }), /not a vrlbry scene/);
    const busy = fakeApp({ state: 'busy' });
    await assert.rejects(restoreScene(busy.app, SCENE), /busy/);
  });

  it('parses pasted text: a scene or a debug report', () => {
    assert.equal(parseScene(` ${JSON.stringify({ app: 'vrlbry', errors: [], ...SCENE })}\n`).book.id, 'v41');
    assert.throws(() => parseScene('{"view": 1'), /not JSON/);
    assert.throws(() => parseScene('{"view": {"state": "browse"}}'), /not a vrlbry scene/);
  });

  it('saves one scene in the browser, with when and a label', () => {
    const { app } = fakeApp();
    app.interaction.book = { title: 'Bouelles – Brass band' };
    assert.equal(savedScene(), null);
    const scene = saveScene(app);
    assert.equal(scene.label, 'Wikipedia in simple English · Bouelles – Brass band');
    assert.ok(!Number.isNaN(Date.parse(scene.at)));
    const back = savedScene();
    assert.deepEqual(back, JSON.parse(JSON.stringify(scene)));
    assert.equal(back.ui.kiosk.tab, 'search');
    assert.deepEqual(back.settings, { fontScale: 1, theme: 'paper' }, 'only the reading settings');
    delete globalThis.localStorage;
    assert.throws(() => saveScene(app), /does not allow saving/);
  });

  it('describes a page that has not loaded yet', () => {
    const s = sceneOf(undefined, { overlay: { reportUi: () => ({ card: 'open' }) } });
    assert.match(s.view, /^unavailable/);
    assert.equal(s.ui.page.card, 'open');
  });
});
