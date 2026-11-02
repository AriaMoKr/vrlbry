// @ts-check
// The accessibility settings in words (SPEC §5.6 "Kiosk panel"): AriaMoKr/common's access.js keeps
// them for every site on this origin under `hallway.access` = { motion: 'system' | 'reduce' |
// 'full', vignette, seated }; these are the kiosk's buttons and the help dialog's choices for them.
// It is the Hallway's key, not this site's: "Reset stored data" (reset.js) leaves it. Pure.

/** The motion setting's choices, in the order a button steps through them. */
export const MOTIONS = Object.freeze(['system', 'reduce', 'full']);

/** What each motion choice is called. */
export const MOTION_LABELS = Object.freeze({
  system: 'Motion: as the system',
  reduce: 'Less motion',
  full: 'Full motion',
});

/** The motion choice after `motion` (a kiosk button steps through them). */
export function nextMotion(motion) {
  const i = MOTIONS.indexOf(motion);
  return MOTIONS[(i + 1) % MOTIONS.length];
}

/**
 * The kiosk's three buttons for the settings: { motion, vignette, seated }, each { label, active }.
 * @param {{ motion: string, vignette: boolean, seated: boolean }} access
 * @param {boolean} reduced whether motion is reduced now (reduceMotion: the system's preference
 *   counts for 'system')
 */
export function comfortButtons(access, reduced) {
  return {
    motion: { label: MOTION_LABELS[access.motion] ?? MOTION_LABELS.system, active: reduced },
    vignette: { label: access.vignette ? 'Vignette when moving' : 'No vignette', active: !!access.vignette },
    seated: { label: access.seated ? 'Seated' : 'Standing', active: !!access.seated },
  };
}
