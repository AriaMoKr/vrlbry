// The accessibility settings in words (public/js/comfort.js), over common's access.js.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCESS_DEFAULTS, ACCESS_KEY, loadAccess, reduceMotion } from 'common/access.js';
import { comfortButtons, MOTION_LABELS, MOTIONS, nextMotion } from '../public/js/comfort.js';

describe('the comfort settings', () => {
  it('names every motion choice common keeps, and steps through them', () => {
    assert.equal(ACCESS_KEY, 'hallway.access');
    assert.deepEqual([...MOTIONS].sort(), ['full', 'reduce', 'system']);
    for (const m of MOTIONS) assert.ok(MOTION_LABELS[m], m);
    assert.deepEqual([nextMotion('system'), nextMotion('reduce'), nextMotion('full'), nextMotion('nonsense')], ['reduce', 'full', 'system', 'system']);
  });

  it('shows the settings on the kiosk, motion lit when it is reduced now', () => {
    const b = comfortButtons(ACCESS_DEFAULTS, false);
    assert.deepEqual(b.motion, { label: 'Motion: as the system', active: false });
    assert.deepEqual(b.vignette, { label: 'Vignette when moving', active: true });
    assert.deepEqual(b.seated, { label: 'Standing', active: false });
    const s = comfortButtons({ motion: 'system', vignette: false, seated: true }, true);
    assert.deepEqual([s.motion.active, s.vignette, s.seated], [true, { label: 'No vignette', active: false }, { label: 'Seated', active: true }]);
    assert.equal(comfortButtons({ motion: 'reduce', vignette: true, seated: false }, true).motion.label, 'Less motion');
  });

  it('reads a choice made in the Hallway', () => {
    const store = { getItem: (k) => (k === 'hallway.access' ? '{"motion":"reduce","vignette":false,"seated":true}' : null) };
    const access = loadAccess(store);
    assert.deepEqual(access, { motion: 'reduce', vignette: false, seated: true });
    assert.equal(reduceMotion(access, null), true);
    assert.equal(reduceMotion({ ...access, motion: 'system' }, { matches: true }), true, 'the system asks for less');
    assert.equal(reduceMotion({ ...access, motion: 'full' }, { matches: true }), false);
  });
});
