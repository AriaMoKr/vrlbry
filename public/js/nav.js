// @ts-check
// How the viewer moves in VR (SPEC §5.6 "Kiosk panel"): the Hallway's choice, which its control
// panel keeps in localStorage as `hallway.nav` = { move: 'smooth' | 'teleport', turn: 'snap' |
// 'smooth' }, read and written by AriaMoKr/common's nav.js (its README, "Moving in VR"). The sites
// on this origin (the Hallway, outside, music, vrlbry) share it, so a visitor's choice comes with
// them through the doors, and a change on the kiosk here is kept there too. Before anyone has
// stored one, vrlbry's own older setting (`settings.smoothMove`) decides how to move (navDefaults).
// It is the Hallway's key, not this site's: "Reset stored data" (reset.js) leaves it. Pure.

import { NAV_DEFAULTS } from '../vendor/common/nav.js';

export { loadNav, NAV_DEFAULTS, NAV_KEY, normalizeNav, saveNav } from '../vendor/common/nav.js';

/**
 * The choice for a visitor who has stored none yet (common's loadNav `defaults`): moving as
 * vrlbry's older setting says, turning in steps.
 * @param {{ smoothMove?: boolean }} [settings] vrlbry's settings
 */
export function navDefaults(settings = {}) {
  return { ...NAV_DEFAULTS, move: settings.smoothMove === false ? 'teleport' : 'smooth' };
}
