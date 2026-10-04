// Paints spine atlases off the main thread on an OffscreenCanvas (see AtlasWorker in shelves.js).
// In: { id, layout, items: [{ book: { id, title, author }, dims }], label, scale }.
// Out: { id, bitmap } with the ImageBitmap transferred and already flipped vertically (WebGL
// ignores flipY for bitmaps), or { id, error }.

import { atlasPainter } from './atlas.js';

self.onmessage = async ({ data }) => {
  const { id, layout, items, label, scale } = data;
  try {
    const painter = atlasPainter(layout, items, label, scale);
    painter.step();
    const bitmap = await createImageBitmap(painter.canvas, { imageOrientation: 'flipY' });
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
