// Paints spine atlases off the main thread on an OffscreenCanvas (see AtlasWorker in shelves.js).
// In: { id, layout, items: [{ book: { id, title, author }, dims }], label, scale }.
// Out: { id, bitmap } with the ImageBitmap transferred, already flipped vertically (WebGL ignores
// flipY for bitmaps) and neither premultiplied nor color-converted, or { id, error }.

import { atlasPainter } from './atlas.js';

self.onmessage = async ({ data }) => {
  const { id, layout, items, label, scale } = data;
  try {
    const painter = atlasPainter(layout, items, label, scale);
    painter.step();
    // Exactly the layout three.js uploads (no flip, premultiplication or color conversion at
    // upload time): otherwise the browser converts the bitmap on the main thread at texImage2D,
    // and on a Quest half of the atlas uploads dropped a frame, small ones too.
    const bitmap = await createImageBitmap(painter.canvas, {
      imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
