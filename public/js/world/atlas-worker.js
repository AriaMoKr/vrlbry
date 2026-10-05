// Paints spine atlases off the main thread on an OffscreenCanvas (see AtlasWorker in shelves.js).
// In: { id, layout, items: [{ book: { id, title, author, volume?, range? }, dims }], label, scale, gpu }.
// Out: { id, bitmap } with the ImageBitmap transferred, already flipped vertically (WebGL ignores
// flipY for bitmaps) and neither premultiplied nor color-converted, or { id, error }.

import { atlasPainter } from './atlas.js';

self.onmessage = async ({ data }) => {
  const { id, layout, items, label, scale, gpu } = data;
  try {
    // On a software canvas unless asked (?atlas=gpu): finishing a GPU-backed atlas made the GPU
    // process rasterize it all at once, and the frame before the atlas arrived dropped in half
    // of the cases on a Quest 3.
    const painter = atlasPainter(layout, items, label, scale, { cpu: !gpu });
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
