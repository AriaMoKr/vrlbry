// Gamepad reading (public/js/xr/gamepad.js): dead zones, triggers, button edges, pad choice.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stick, readPad, firstPad, BUTTONS, DEADZONE } from '../public/js/xr/gamepad.js';

/** A Gamepad-like snapshot with the given axes and pressed button names (and trigger values). */
function pad({ axes = [0, 0, 0, 0], pressed = [], lt = 0, rt = 0, mapping = 'standard', connected = true } = {}) {
  const buttons = BUTTONS.map((name) => ({ pressed: pressed.includes(name), value: pressed.includes(name) ? 1 : 0 }));
  buttons[6] = { pressed: lt > 0.5, value: lt };
  buttons[7] = { pressed: rt > 0.5, value: rt };
  return { axes, buttons, mapping, connected };
}

describe('gamepad', () => {
  it('ignores stick drift inside the dead zone and ramps smoothly outside it', () => {
    assert.deepEqual(stick(0.1, -0.1), { x: 0, y: 0 });
    assert.deepEqual(stick(1, 0), { x: 1, y: 0 });
    const half = stick(0.5, 0);
    assert.ok(Math.abs(half.x - (0.5 - DEADZONE) / (1 - DEADZONE)) < 1e-9);
    const diag = stick(0.9, 0.9); // beyond the unit circle: capped at length 1
    assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-9);
    assert.deepEqual(stick(), { x: 0, y: 0 });
  });

  it('reads sticks, triggers and button edges', () => {
    let s = readPad(pad({ axes: [0, -1, 0.6, 0], pressed: ['a'], rt: 0.7 }));
    assert.deepEqual(s.move, { x: 0, y: -1 });
    assert.ok(s.look.x > 0.4);
    assert.equal(s.rt, 0.7);
    assert.equal(s.buttons.rt, true, 'a trigger past half counts as pressed');
    assert.deepEqual(s.down, ['a', 'rt']);
    // Held: no new edge. Released: an up edge.
    s = readPad(pad({ pressed: ['a'], rt: 0.7 }), s.buttons);
    assert.deepEqual(s.down, []);
    s = readPad(pad({ pressed: ['b'] }), s.buttons);
    assert.deepEqual(s.down, ['b']);
    assert.deepEqual(s.up, ['a', 'rt']);
  });

  it('copes with pads that have fewer buttons or axes', () => {
    const s = readPad({ axes: [0.5], buttons: [{ pressed: true, value: 1 }], connected: true });
    assert.ok(s.move.x > 0);
    assert.deepEqual(s.look, { x: 0, y: 0 });
    assert.deepEqual(s.down, ['a']);
    assert.equal(s.rt, 0);
  });

  it('picks the first connected pad, preferring the standard mapping', () => {
    const odd = pad({ mapping: '' });
    const std = pad();
    assert.equal(firstPad([null, odd, std]), std);
    assert.equal(firstPad([odd, pad({ connected: false })]), odd);
    assert.equal(firstPad([null, null]), null);
    assert.equal(firstPad(undefined), null);
  });
});
