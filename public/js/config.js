// @ts-check
// Shared constants. Units are metres / radians unless noted. See SPEC.md §5.

export const BOOK = {
  minH: 0.23, maxH: 0.31,    // book height range
  minT: 0.026, maxT: 0.075,  // spine thickness range
  depthRatio: 0.7,           // depth = height * depthRatio
  volume: { w: 0.05, h: 0.3 }, // an encyclopedia volume (Wikipedia, SPEC §2.5): one size for all
};

export const BOOKCASE = {
  width: 1.2,       // outer width
  height: 2.3,      // outer height
  depth: 0.4,       // outer depth
  shelves: 6,       // shelf rows per bookcase
  bottom: 0.12,     // height of the lowest shelf surface above the floor
  side: 0.04,       // side panel thickness
  board: 0.025,     // shelf board thickness
};

// Canvas size of one rendered book page (pixels). Aspect ~ 1 : 1.414.
export const PAGE_PX = { w: 1024, h: 1448 };

// Reading pose of an open book relative to the viewer when READ mode starts.
export const READ = {
  pageWidth: 0.30,        // metres, one page (the open spread is twice this)
  distance: 0.6,          // metres in front of the eyes
  drop: 0.2,              // metres below eye height
  tilt: 0.35,             // radians the spread is tilted back to face the eyes
  minScale: 0.6, maxScale: 2.5,
};

export const PLAYER = {
  eyeHeight: 1.6,          // desktop / mobile camera height
  radius: 0.25,            // collision radius
  walkSpeed: 2.0,          // m/s
  snapTurn: Math.PI / 6,   // radians per snap
};

// Display refresh rate asked for in VR (the nearest one the headset supports). Quest Browser
// starts sessions at 90 Hz; 72 Hz gives each frame 13.9 ms instead of 11.1 ms, and the Quest 3
// dropped 3–8 % of frames at 90 Hz even in ordinary rooms. ?hz=90 overrides it for experiments.
export const XR_FRAME_RATE = 72;

export const STORAGE_PREFIX = 'vrlbry:';

/**
 * This library's door in the Hallway (https://github.com/AriaMoKr/hallway: a WebXR corridor whose
 * doors lead to other environments): the way back names it (?from=, common's hallwayUrl), so the
 * visitor arrives in front of its door, and it is this page in a shared session (together-space.js).
 * The one site-specific id: a site made from this one changes it here (and in index.html's
 * <noscript> link, which a test checks against it).
 */
export const DOOR_ID = 'vrlbry';

/** What the 3D view shows, for a screen reader (the canvas's aria-label, role img): this site's own words. */
export const SCENE_LABEL = 'A candle-lit library: bookcases, a reading table and a door back to the Hallway';
