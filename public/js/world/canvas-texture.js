// Textures from canvases (or from ImageBitmaps painted by the atlas worker) with the settings every
// world texture wants.

import * as THREE from 'three';

const isBitmap = (image) => typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;

/**
 * @param {HTMLCanvasElement|ImageBitmap} image an ImageBitmap must already be flipped vertically
 *   (createImageBitmap's imageOrientation: 'flipY'): WebGL ignores flipY for bitmaps
 */
export function canvasTexture(image, { repeat = null, anisotropy = 4, srgb = true } = {}) {
  let t;
  if (isBitmap(image)) {
    t = new THREE.Texture(image);
    t.flipY = false;
    t.needsUpdate = true;
  } else {
    t = new THREE.CanvasTexture(image);
  }
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Disposes a texture and frees its ImageBitmap, if it has one. */
export function disposeTexture(t) {
  if (!t) return;
  t.dispose();
  if (isBitmap(t.image)) t.image.close();
}
