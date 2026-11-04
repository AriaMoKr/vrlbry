// @ts-check
// Namespaced JSON localStorage. Storage can be unavailable (private mode, blocked site data,
// quota) — every access is guarded and falls back silently.

import { STORAGE_PREFIX } from '../config.js';

/** Reads `key` and parses it as JSON; returns `fallback` when missing or unreadable. */
export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let frozen = false;

/**
 * From now on nothing is stored: "Reset stored data" (reset.js) clears the storage and reloads
 * the page, and what the page holds in memory must not be written back meanwhile.
 */
export function freezeStorage() {
  frozen = true;
}

/** Stores `value` as JSON under `key`. Returns false if it could not be stored. */
export function save(key, value) {
  if (frozen) return false;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Removes `key`. */
export function remove(key) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch { /* storage unavailable */ }
}
