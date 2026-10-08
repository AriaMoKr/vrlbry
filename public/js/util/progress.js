// Time on a progress indicator: how long so far and, once the fraction done says enough, about
// how long is left. Shared by the "Opening <file>…" toast (main.js) and the inspect panel's
// "Opening…" (interaction.js), so they read alike.

/** The fraction done below which, or the time before which, nothing is estimated. */
const ESTIMATE_MIN_FRACTION = 0.03;
const ESTIMATE_MIN_MS = 1500;

/**
 * About how long is left, from the time so far and the fraction done, as "about 20 s left" /
 * "about 2 min left" / "about 1 h 5 min left"; '' while too little is known (no fraction, under
 * ESTIMATE_MIN_FRACTION, or under ESTIMATE_MIN_MS so far). Seconds are rounded up, to 5 s past
 * 10 s, minutes to whole ones: the figure moves calmly rather than counting down.
 * @param {number} elapsedMs
 * @param {number|null} fraction 0..1
 */
export function timeLeft(elapsedMs, fraction) {
  if (fraction == null || !(fraction >= ESTIMATE_MIN_FRACTION) || elapsedMs < ESTIMATE_MIN_MS) return '';
  if (fraction >= 1) return '';
  const s = (elapsedMs * (1 - fraction)) / fraction / 1000;
  if (s < 10) return `about ${Math.max(1, Math.ceil(s))} s left`;
  if (s < 60) return `about ${Math.ceil(s / 5) * 5} s left`;
  const min = Math.ceil(s / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  return `about ${h} h${min % 60 ? ` ${min % 60} min` : ''} left`;
}

/**
 * What follows an indicator's text: " · 12 s" once a second has passed, then " · about 40 s
 * left" when there is an estimate (timeLeft); '' in the first second.
 * @param {number} elapsedMs
 * @param {number|null} fraction 0..1, or null when unknown
 */
export function progressText(elapsedMs, fraction) {
  const s = Math.floor(elapsedMs / 1000);
  if (s < 1) return '';
  const left = timeLeft(elapsedMs, fraction);
  return ` · ${s} s${left ? ` · ${left}` : ''}`;
}
