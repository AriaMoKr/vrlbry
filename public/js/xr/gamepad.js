// Standard-layout gamepads (Xbox, PlayStation, most Bluetooth pads) through the Gamepad API, for
// desktop and phone (an XR session's controllers come through XRInputSource.gamepad instead).
// Pure: turns a Gamepad snapshot into dead-zoned sticks, triggers and button edges; xr/controls.js
// maps those onto the same events as mouse, keyboard and VR controllers.

/** Button names by index in the W3C "standard" mapping. */
export const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];
export const DEADZONE = 0.18;

/** A stick with a radial dead zone, rescaled so motion starts smoothly at its edge. */
export function stick(x = 0, y = 0, deadzone = DEADZONE) {
  const m = Math.hypot(x, y);
  if (m <= deadzone) return { x: 0, y: 0 };
  const k = Math.min(1, (m - deadzone) / (1 - deadzone)) / m;
  return { x: x * k, y: y * k };
}

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
  BUTTONS.forEach((name, i) => {
    const b = gp.buttons[i];
    buttons[name] = !!b && (b.pressed || b.value > 0.5);
  });
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

/** The first connected gamepad, preferring one with the standard mapping. */
export function firstPad(pads) {
  const list = [...(pads || [])].filter((g) => g && g.connected);
  return list.find((g) => g.mapping === 'standard') || list[0] || null;
}
