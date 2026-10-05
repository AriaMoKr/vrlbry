// Spine atlases (SPEC §5.3): one canvas per bookcase holding every spine, a strip of cloth beside
// each (the covers sample it), the range label plate and a page-edge patch. No three.js here, so
// the atlas worker can paint them off the main thread (see Bookshelves).

import { SPINE_PPM, bookColors, drawSpine, drawPlate, makePageEdgeCanvas, newCanvas } from './textures.js';

const ATLAS_W = 2048;
export const STRIPE = 6; // px of plain cloth right of each spine in the atlas (covers sample it)
const ROW_H = Math.ceil(0.31 * SPINE_PPM) + 4;
const LABEL = { w: 440, h: 80 }; // label plate in the atlas (px)

/** Packs spine cells (+ label + page-edge patch) into an atlas layout (full-res pixel units). */
export function atlasLayout(items) {
  const cells = [];
  let x = 0;
  let y = 0;
  for (const it of items) {
    const w = Math.max(16, Math.round(it.dims.w * SPINE_PPM));
    const h = Math.round(it.dims.h * SPINE_PPM);
    if (x + w + STRIPE > ATLAS_W) {
      x = 0;
      y += ROW_H;
    }
    cells.push({ x, y, w, h });
    x += w + STRIPE + 2;
  }
  const labelY = y + ROW_H;
  const label = { x: 0, y: labelY, w: LABEL.w, h: LABEL.h };
  const page = { x: LABEL.w + 8, y: labelY, w: 64, h: LABEL.h };
  const height = Math.ceil((labelY + LABEL.h + 2) / 4) * 4;
  return { cells, label, page, width: ATLAS_W, height };
}

let pageEdge = null;

/**
 * Paints an atlas at `scale` (1 = full resolution) incrementally: `step(budgetMs)` paints spines
 * until the time budget is used and returns true once the atlas is complete.
 */
export function atlasPainter(layout, items, labelText, scale, { cpu = false } = {}) {
  const c = newCanvas(Math.max(4, Math.round(layout.width * scale)), Math.max(4, Math.round(layout.height * scale)));
  // cpu: a software canvas (rasterized on this thread). The worker uses it: a GPU canvas is
  // rasterized in the GPU process when its bitmap is taken, which the headset's frames also need.
  const g = c.getContext('2d', cpu ? { willReadFrequently: true } : undefined);
  g.scale(scale, scale);
  g.fillStyle = '#2a1a10';
  g.fillRect(0, 0, layout.width, layout.height);
  const detailed = scale >= 0.2;
  let i = 0;
  let done = false;
  return {
    canvas: c,
    step(budgetMs = Infinity) {
      if (done) return true;
      const t0 = performance.now();
      while (i < items.length) {
        const it = items[i];
        const cell = layout.cells[i++];
        const col = bookColors(it.book);
        g.fillStyle = col.cloth;
        g.fillRect(cell.x + cell.w, cell.y, STRIPE, cell.h);
        if (detailed) drawSpine(g, it.book, cell.x, cell.y, cell.w, cell.h);
        else {
          g.fillRect(cell.x, cell.y, cell.w, cell.h);
          g.fillStyle = col.gilt;
          g.fillRect(cell.x + cell.w * 0.15, cell.y + cell.h * 0.2, cell.w * 0.7, cell.h * 0.55);
        }
        if (performance.now() - t0 > budgetMs) return false;
      }
      drawPlate(g, layout.label.x, layout.label.y, layout.label.w, layout.label.h, labelText || '');
      pageEdge ||= makePageEdgeCanvas({ w: 64, h: 64 });
      g.drawImage(pageEdge, layout.page.x, layout.page.y, layout.page.w, layout.page.h);
      done = true;
      return true;
    },
  };
}
