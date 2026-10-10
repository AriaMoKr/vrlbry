// "Copy debug info" (public/js/debug-info.js): the error log and the report, with a fake page.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { debugReport, noteError, recentErrors, startErrorLog } from '../public/js/debug-info.js';

const event = (type, props) => Object.assign(new Event(type), props);

describe('debug info', () => {
  const target = new EventTarget();
  const printed = [];
  const con = { error: (...a) => printed.push(['error', ...a]), warn: (...a) => printed.push(['warn', ...a]) };
  startErrorLog({ target, con });

  it('keeps the last errors: uncaught, rejected, failed loads, console.error / warn', () => {
    target.dispatchEvent(event('error', { message: 'boom', filename: 'http://x/js/a.js', lineno: 3, colno: 7 }));
    target.dispatchEvent(event('unhandledrejection', { reason: new Error('nope') }));
    target.src = 'http://x/missing.png'; // an element whose load failed: no message
    target.dispatchEvent(event('error', {}));
    delete target.src;
    con.error('chunk failed', { status: 404 });
    const errors = recentErrors();
    assert.deepEqual(errors.map((e) => e.kind), ['error', 'rejection', 'load', 'error']);
    assert.equal(errors[0].message, 'boom');
    assert.equal(errors[0].where, 'http://x/js/a.js:3:7');
    assert.match(errors[1].message, /^Error: nope \| at /);
    assert.equal(errors[2].message, 'failed to load http://x/missing.png');
    assert.equal(errors[3].message, 'chunk failed {"status":404}');
    assert.ok(errors.every((e) => typeof e.t === 'number'));
    assert.deepEqual(printed, [['error', 'chunk failed', { status: 404 }]], 'still printed');
  });

  it('keeps only the last 20, each at most 300 characters', () => {
    for (let i = 0; i < 25; i++) con.warn(`w${i}`, 'x'.repeat(i === 24 ? 400 : 0));
    const errors = recentErrors();
    assert.equal(errors.length, 20);
    assert.equal(errors[0].message, 'w5 ');
    assert.equal(errors.at(-1).message.length, 301);
    assert.ok(errors.at(-1).message.endsWith('…'));
  });

  it('keeps and prints what only the page showed: an error toast, a ZIM that did not open with its address', () => {
    const [kept, shown] = [recentErrors().length, printed.length];
    noteError('open', 'https://ariamokr.github.io/vrlbry/zims/x.zim: x.zim: the server does not serve parts of the file (no range requests)');
    noteError('toast', 'x.zim: the server does not serve parts of the file (no range requests).');
    assert.equal(recentErrors().length, Math.min(20, kept + 2), 'kept once each, not again as console lines');
    // Printed too, for those who copy the console instead: the failed open as an error.
    assert.deepEqual(printed.slice(shown), [
      ['error', '[vrlbry] Could not open: https://ariamokr.github.io/vrlbry/zims/x.zim: x.zim: the server does not serve parts of the file (no range requests)'],
      ['warn', '[vrlbry] Shown: x.zim: the server does not serve parts of the file (no range requests).'],
    ]);
    const [open, toast] = recentErrors().slice(-2);
    assert.equal(open.kind, 'open');
    assert.match(open.message, /^https:\/\/ariamokr\.github\.io\/vrlbry\/zims\/x\.zim: .*no range requests/);
    assert.equal(toast.kind, 'toast');
    assert.equal(typeof open.t, 'number');
  });

  it('reports what it can, part by part', () => {
    const gl = {
      RENDERER: 1, MAX_TEXTURE_SIZE: 2,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 3 }),
      getParameter: (p) => ({ 1: 'masked', 2: 8192, 3: 'Adreno (TM) 740' }[p]),
    };
    const book = { libId: 'wp', id: 'v3', title: 'Banana – Éclair' };
    const shownLeft = { c: 2, p: 4 };
    const app = {
      version: '2026-10-05T12:00:00.000Z',
      renderer: { getContext: () => gl, info: { render: { calls: 87 } }, xr: { isPresenting: false } },
      xrDevice: null,
      settings: { place: 'demo', rooms: {}, sort: 'title', fontScale: 1.2, theme: 'night', readScale: 1, readDistance: 0.5, smoothMove: true, sound: false },
      world: { shelves: { cases: new Array(6) } },
      controls: { viewpoint: () => ({ x: 1.25, z: -3.5, eye: 1.6, yaw: 0.785, pitch: -0.1 }) },
      interaction: {
        state: 'read', book, libraries: [{ id: 'wp', kind: 'wikipedia' }], booksByLib: { wp: [book, {}] },
        reader: { labelOf: (ref) => `page ${ref.p + 1}`, anchorOf: (ref) => ({ c: ref.c, b: 17 }) }, _currentRef: () => shownLeft,
        _cur: { spread: { left: shownLeft, right: { c: 2, p: 5 } } },
        uiState: () => ({ kiosk: { tab: 'search', search: 'banana', scroll: { 'search-results': 2 } }, inspect: false, toolbar: true, contents: { scroll: 40 }, hover: null }),
      },
      overlay: { reportUi: () => ({ card: 'collapsed', search: { q: 'ban', open: true }, update: false, loading: null, toasts: [] }) },
    };
    const r = debugReport(app);
    assert.equal(r.app, 'vrlbry');
    assert.equal(r.version, app.version);
    assert.deepEqual(r.gpu, { renderer: 'Adreno (TM) 740', maxTextureSize: 8192, drawCalls: 87 });
    assert.deepEqual(r.libraries, ['wp (wikipedia, 2)']);
    assert.deepEqual(r.view, {
      state: 'read', place: 'demo', room: null, sort: 'title', bookcases: 6,
      viewpoint: { x: 1.25, z: -3.5, eye: 1.6, yaw: 0.785, pitch: -0.1 },
    });
    assert.deepEqual(r.book, { library: 'wp', id: 'v3', title: 'Banana – Éclair', at: 'page 5', anchor: { c: 2, b: 17 }, side: 'left' });
    // The dialogs: the page's menus (as when the help was opened) and the 3D panels.
    assert.deepEqual(r.ui, {
      page: { card: 'collapsed', search: { q: 'ban', open: true }, update: false, loading: null, toasts: [] },
      kiosk: { tab: 'search', search: 'banana', scroll: { 'search-results': 2 } },
      inspect: false, toolbar: true, contents: { scroll: 40 }, hover: null,
    });
    assert.equal(r.settings.theme, 'night');
    assert.equal(r.errors.length, 20);
    assert.equal(r.xr.emulated, false);
    assert.match(r.url, /^unavailable/, 'Node has no location: that part only');
    // Before the app exists (loading, or loading failed): still a report.
    const early = debugReport(undefined, { overlay: app.overlay });
    assert.equal(early.version, null);
    assert.equal(early.ui.page.card, 'collapsed', 'the page’s menus exist before the app');
    assert.match(early.view, /^unavailable/);
    assert.equal(early.errors.length, 20);
    assert.doesNotThrow(() => JSON.stringify(early));
  });
});
