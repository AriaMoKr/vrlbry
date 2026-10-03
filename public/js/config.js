// Shared constants. Units are metres / radians unless noted. See SPEC.md §5.

export const BOOK = {
  minH: 0.23, maxH: 0.31,    // book height range
  minT: 0.026, maxT: 0.075,  // spine thickness range
  depthRatio: 0.7,           // depth = height * depthRatio
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

export const STORAGE_PREFIX = 'vrlbry:';
