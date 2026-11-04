// How the viewer moves in VR (public/js/nav.js, common's nav.js): the Hallway's choice, shared
// through its key, and vrlbry's older setting before one is stored.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './helpers/vendor.js'; // nav.js imports ../vendor/common/nav.js

const { loadNav, NAV_DEFAULTS, NAV_KEY, navDefaults, normalizeNav, saveNav } = await import('../public/js/nav.js');

/** A localStorage stand-in: a Map behind getItem / setItem, or one that refuses. */
const store = (entries = {}, { blocked = false } = {}) => {
  const m = new Map(Object.entries(entries));
  return {
    m,
    getItem: (k) => {
      if (blocked) throw new Error('SecurityError');
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (blocked) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
  };
};

describe('the movement choice', () => {
  it('is read from the Hallway\'s key, as the Hallway writes it', () => {
    assert.equal(NAV_KEY, 'hallway.nav');
    assert.deepEqual(NAV_DEFAULTS, { move: 'smooth', turn: 'snap' });
    assert.deepEqual(loadNav(store({ 'hallway.nav': '{"move":"teleport","turn":"smooth"}' })), { move: 'teleport', turn: 'smooth' });
    // The stored choice wins over this site's older setting.
    assert.deepEqual(loadNav(store({ 'hallway.nav': '{"move":"smooth","turn":"snap"}' }), navDefaults({ smoothMove: false })), { move: 'smooth', turn: 'snap' });
  });

  it('falls back to this site\'s own setting, then to the defaults', () => {
    assert.deepEqual(navDefaults(), { move: 'smooth', turn: 'snap' });
    assert.deepEqual(navDefaults({ smoothMove: true }), { move: 'smooth', turn: 'snap' });
    assert.deepEqual(loadNav(store(), navDefaults()), { move: 'smooth', turn: 'snap' });
    assert.deepEqual(loadNav(store(), navDefaults({ smoothMove: false })), { move: 'teleport', turn: 'snap' });
    assert.deepEqual(loadNav(null, navDefaults({ smoothMove: false })), { move: 'teleport', turn: 'snap' }, 'no storage');
    assert.deepEqual(loadNav(store({}, { blocked: true }), navDefaults()), { move: 'smooth', turn: 'snap' }, 'storage refused');
    assert.deepEqual(loadNav(store({ 'hallway.nav': 'not json' }), navDefaults({ smoothMove: false })), { move: 'teleport', turn: 'snap' });
    // Unknown or missing values: the defaults, value by value.
    assert.deepEqual(loadNav(store({ 'hallway.nav': '{"move":"fly"}' }), navDefaults({ smoothMove: false })), { move: 'teleport', turn: 'snap' });
    assert.deepEqual(loadNav(store({ 'hallway.nav': '{"turn":"smooth"}' }), navDefaults()), { move: 'smooth', turn: 'smooth' });
    assert.deepEqual(normalizeNav(null), NAV_DEFAULTS);
    assert.deepEqual(normalizeNav(['teleport']), NAV_DEFAULTS);
  });

  it('is kept under the Hallway\'s key, complete and valid', () => {
    const s = store();
    assert.equal(saveNav({ move: 'teleport', turn: 'sideways', extra: 1 }, s), true);
    assert.deepEqual(JSON.parse(s.m.get('hallway.nav')), { move: 'teleport', turn: 'snap' });
    assert.deepEqual(loadNav(s), { move: 'teleport', turn: 'snap' });
    assert.equal(saveNav({ move: 'teleport' }, store({}, { blocked: true })), false);
    assert.equal(saveNav({ move: 'teleport' }, null), false);
  });
});
