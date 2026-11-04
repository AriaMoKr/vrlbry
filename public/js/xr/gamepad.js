// Standard-layout gamepads (Xbox, PlayStation, most Bluetooth pads) through the Gamepad API, for
// desktop and phone (an XR session's controllers come through XRInputSource.gamepad instead).
// Pure: turns a Gamepad snapshot into dead-zoned sticks, triggers and button edges; xr/controls.js
// maps those onto the same events as mouse, keyboard and VR controllers. The pieces (the dead
// zone, the stick's scaling, what counts as held, the pad chosen) are AriaMoKr/common's
// gamepad.js, so a pad feels the same here as in the Hallway and outside; this reader of its own
// adds every button by name and the presses and releases since the last read.

import { BUTTONS, DEADZONE, firstPad, held, stick } from '../../vendor/common/gamepad.js';

export { BUTTONS, DEADZONE, firstPad, stick };

/**
 * Reads a gamepad.
 * @param {Gamepad} gp
 * @param {Record<string, boolean>} prev the previous call's `buttons`
 * @returns {{ move: {x, y}, look: {x, y}, lt: number, rt: number, buttons: Record<string, boolean>, down: string[], up: string[] }}
 *   move/look: left/right stick (x right, y down, -1..1); lt/rt: triggers 0..1; down/up: buttons
 *   pressed/released since `prev`
 */
export function readPad(gp, prev = {}) {
  const buttons = {};
  for (let i = 0; i < BUTTONS.length; i++) buttons[BUTTONS[i]] = held(gp, i);
  return {
    move: stick(gp.axes[0], gp.axes[1]),
    look: stick(gp.axes[2], gp.axes[3]),
    lt: gp.buttons[6]?.value ?? 0,
    rt: gp.buttons[7]?.value ?? 0,
    buttons,
    down: BUTTONS.filter((n) => buttons[n] && !prev[n]),
    up: BUTTONS.filter((n) => !buttons[n] && prev[n]),
  };
}
