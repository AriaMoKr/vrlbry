// Procedural canvas art for the world (SPEC §5.3): wood, plaster, floor planks, sky, page edges,
// book spines and generated covers. No image files are needed, so the app works offline.

import * as THREE from 'three';
import { hashString } from '../util/books.js';

export const SPINE_PPM = 1100; // spine texture pixels per metre (legible at ~1.5 m in VR)

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif", "Times New Roman", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

/** Cloth / leather colours for spines (deep, slightly desaturated library tones). */
const PALETTE = [
  '#5b1a1a', '#7a2323', '#8c3b1f', '#6b3a1e', '#4a2c1a', '#2f3b23', '#3e4f2a', '#1f3b33',
  '#1d3a4a', '#23314f', '#2b2846', '#432447', '#5a2a3c', '#704214', '#7c5b26', '#3b3b3b',
  '#1a1a1a', '#6e5a3f', '#8a6d3b', '#2c4a5c', '#55301f', '#3f2a1d', '#5c4b2a', '#20302a',
];
const GILT = ['#d8b45a', '#e3c77c', '#c9a14a', '#efe0b0'];

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** CanvasTexture with the settings every world texture wants. */
export function canvasTexture(canvas, { repeat = null, anisotropy = 4, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
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

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

/** Fine noise overlay, cheap enough for large canvases. */
function grain(g, w, h, alpha, seed = 7) {
  const tile = newCanvas(96, 96);
  const tg = tile.getContext('2d');
  const id = tg.createImageData(96, 96);
  const r = rng(seed);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = (r() * 255) | 0;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  tg.putImageData(id, 0, 0);
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(tile, 'repeat');
  g.fillRect(0, 0, w, h);
  g.restore();
}

/**
 * Wood grain: long wavy streaks along x.
 * @param {{ w?: number, h?: number, base?: string, dark?: string, light?: string, seed?: number, rings?: number }} o
 */
export function makeWoodCanvas({ w = 1024, h = 512, base = '#5a3720', dark = '#3a2213', light = '#7a4f2e', seed = 1, rings = 46 } = {}) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const r = rng(seed);
  for (let i = 0; i < rings; i++) {
    const y0 = r() * h;
    const amp = 2 + r() * 10;
    const freq = (0.5 + r() * 2) * Math.PI * 2 / w;
    const phase = r() * 10;
    g.strokeStyle = r() < 0.5 ? dark : light;
    g.globalAlpha = 0.18 + r() * 0.3;
    g.lineWidth = 0.6 + r() * 2.4;
    g.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = y0 + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 3.1 + phase * 2) * amp * 0.25;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // A few knots.
  for (let i = 0; i < 3; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = 4 + r() * 10;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad * 2.2);
    grd.addColorStop(0, dark);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.5;
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, rad * 2.5, rad, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  grain(g, w, h, 0.08, seed);
  return c;
}

/** Floor planks: staggered boards with seams and per-board tone variation. */
export function makePlankCanvas({ w = 1024, h = 1024, boards = 8, seed = 3 } = {}) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  const r = rng(seed);
  const bh = h / boards;
  const tones = ['#4a2e1c', '#553521', '#3f2717', '#5b3a24', '#4d301d'];
  for (let i = 0; i < boards; i++) {
    let x = -r() * w * 0.6;
    while (x < w) {
      const len = w * (0.45 + r() * 0.5);
      const wood = makeWoodCanvas({ w: 512, h: 64, base: tones[(r() * tones.length) | 0], dark: '#2a180c', light: '#6e4529', seed: (r() * 1e9) | 0, rings: 12 });
      g.drawImage(wood, x, i * bh, len, bh);
      g.fillStyle = 'rgba(15,8,3,0.85)';
      g.fillRect(x, i * bh, 2, bh);
      x += len;
    }
    g.fillStyle = 'rgba(15,8,3,0.9)';
    g.fillRect(0, i * bh, w, 2);
    g.fillStyle = 'rgba(255,220,170,0.05)';
    g.fillRect(0, i * bh + 2, w, 2);
  }
  grain(g, w, h, 0.06, seed);
  return c;
}

/** Warm plaster with soft mottling. */
export function makePlasterCanvas({ w = 512, h = 512, base = '#b9a88c', seed = 5 } = {}) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const r = rng(seed);
  for (let i = 0; i < 70; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = 20 + r() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const light = r() < 0.5;
    grd.addColorStop(0, light ? 'rgba(255,245,225,0.10)' : 'rgba(80,60,35,0.10)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  grain(g, w, h, 0.1, seed);
  return c;
}

/** Evening sky for the windows: deep blue to amber horizon, a few stars. */
export function makeSkyCanvas({ w = 256, h = 512 } = {}) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#0d1633');
  grd.addColorStop(0.45, '#2c3f73');
  grd.addColorStop(0.75, '#b9786a');
  grd.addColorStop(0.9, '#f0b36c');
  grd.addColorStop(1, '#f7cf8a');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  const r = rng(11);
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = 0.3 + r() * 0.7;
    g.fillStyle = '#fff';
    g.fillRect(r() * w, r() * h * 0.45, 1.5, 1.5);
  }
  g.globalAlpha = 1;
  // Distant tree line silhouette.
  g.fillStyle = '#1b1612';
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 6) g.lineTo(x, h * 0.92 - Math.abs(Math.sin(x * 0.07) * 18 + Math.sin(x * 0.21) * 8));
  g.lineTo(w, h);
  g.fill();
  return c;
}

/** Page-edge texture: fine horizontal lines on cream (used for the book block sides). */
export function makePageEdgeCanvas({ w = 64, h = 256 } = {}) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#e9dfc6';
  g.fillRect(0, 0, w, h);
  const r = rng(17);
  for (let y = 0; y < h; y += 2) {
    g.fillStyle = `rgba(120,95,60,${0.08 + r() * 0.14})`;
    g.fillRect(0, y, w, 1);
  }
  return c;
}

/** Colour scheme of a book's binding. */
export function bookColors(book) {
  const key = String(book.id) + '|' + (book.title || '');
  const cloth = PALETTE[hashString(key + 'c') % PALETTE.length];
  const gilt = GILT[hashString(key + 'g') % GILT.length];
  const style = hashString(key + 's') % 4; // 0 bands, 1 label, 2 raised bands, 3 plain gilt
  const label = PALETTE[(hashString(key + 'l') + 7) % PALETTE.length];
  return { cloth, gilt, style, label, dark: shade(cloth, 0.55), light: shade(cloth, 1.35) };
}

/** Short title for spines: main title without trailing subtitle clauses. */
export function spineTitle(book) {
  let t = (book.title || 'Untitled').replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.replace(/[,;:(].*$/, '').trim() || t;
  return t;
}

/** Short author for spines: surname (or "Anon."). */
export function spineAuthor(book) {
  const a = (book.author || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a) return ''; // unknown (e.g. no Author: page links to the work)
  if (/^anonymous$/i.test(a)) return 'Anon.';
  if (/^various$/i.test(a)) return 'Various';
  const parts = a.split(' ');
  return parts[parts.length - 1];
}

/** Splits text into at most `max` lines that each fit `width` at the current font. */
function wrapLines(g, text, width, max) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (g.measureText(t).width <= width || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  let last = out[max - 1] + ' ' + lines.slice(max).join(' ');
  while (g.measureText(last + '…').width > width && last.length > 1) last = last.slice(0, -1);
  out[max - 1] = last.trimEnd() + '…';
  return out;
}

/**
 * Draws a spine into a w×h pixel rectangle at (x, y). The spine reads top-to-bottom (rotated
 * 90° clockwise), as English books do.
 */
export function drawSpine(g, book, x, y, w, h) {
  const col = bookColors(book);
  const rnd = rng(hashString(String(book.id) + 'spine'));
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  // Cloth with a rounded-spine shading.
  const shadeGrad = g.createLinearGradient(0, 0, w, 0);
  shadeGrad.addColorStop(0, col.dark);
  shadeGrad.addColorStop(0.3, col.cloth);
  shadeGrad.addColorStop(0.55, col.light);
  shadeGrad.addColorStop(0.8, col.cloth);
  shadeGrad.addColorStop(1, col.dark);
  g.fillStyle = shadeGrad;
  g.fillRect(0, 0, w, h);
  // Cloth weave hint.
  g.globalAlpha = 0.07;
  g.fillStyle = '#000';
  for (let yy = 0; yy < h; yy += 3) g.fillRect(0, yy, w, 1);
  g.globalAlpha = 1;
  // Wear at head and tail.
  const wear = g.createLinearGradient(0, 0, 0, h);
  wear.addColorStop(0, 'rgba(0,0,0,0.35)');
  wear.addColorStop(0.04, 'rgba(0,0,0,0)');
  wear.addColorStop(0.96, 'rgba(0,0,0,0)');
  wear.addColorStop(1, 'rgba(0,0,0,0.4)');
  g.fillStyle = wear;
  g.fillRect(0, 0, w, h);

  const band = (yy, thick = Math.max(1.5, h * 0.006)) => {
    g.fillStyle = col.gilt;
    g.fillRect(w * 0.08, yy, w * 0.84, thick);
  };
  const titleTop = h * (col.style === 2 ? 0.2 : 0.14);
  const titleBottom = h * 0.8;
  if (col.style === 0 || col.style === 3) {
    band(h * 0.06);
    band(h * 0.075, Math.max(1, h * 0.003));
    band(h * 0.925, Math.max(1, h * 0.003));
    band(h * 0.94);
  } else if (col.style === 2) {
    // Raised bands: dark ridges with highlight.
    for (const f of [0.1, 0.17, 0.83, 0.9]) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, h * f, w, h * 0.012);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, h * f - 1, w, 1.5);
    }
  }
  if (col.style === 1) {
    // Leather title label.
    g.fillStyle = col.label;
    g.fillRect(w * 0.1, titleTop - h * 0.01, w * 0.8, titleBottom - titleTop + h * 0.02);
    g.strokeStyle = col.gilt;
    g.lineWidth = Math.max(1, w * 0.03);
    g.strokeRect(w * 0.14, titleTop, w * 0.72, titleBottom - titleTop);
  }

  // Title, rotated: we draw in a frame where +x runs down the spine.
  const len = titleBottom - titleTop - h * 0.02;
  g.save();
  g.translate(w / 2, titleTop + h * 0.01);
  g.rotate(Math.PI / 2);
  const title = spineTitle(book);
  let size = Math.min(w * 0.6, 32);
  let lines = [title];
  g.font = `600 ${size}px ${SERIF}`;
  if (g.measureText(title).width > len) {
    // Try two lines on thicker spines, else shrink, then ellipsize.
    const two = w > 34;
    if (two) {
      size = Math.min(w * 0.36, 26);
      g.font = `600 ${size}px ${SERIF}`;
      lines = wrapLines(g, title, len, 2);
      if (lines.length === 2 && g.measureText(lines[1]).width > len) lines = wrapLines(g, title, len, 2);
    } else {
      while (size > 9 && g.measureText(title).width > len) {
        size -= 1;
        g.font = `600 ${size}px ${SERIF}`;
      }
      lines = wrapLines(g, title, len, 1);
    }
  }
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const lh = size * 1.12;
  lines.forEach((line, i) => {
    const off = (i - (lines.length - 1) / 2) * lh;
    emboss(g, line, 0, -off, col.gilt);
  });
  g.restore();

  // Author at the tail, horizontal when the spine is thick enough, else rotated.
  const author = spineAuthor(book);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  let as = Math.min(w * 0.3, 15);
  g.font = `${as}px ${SERIF}`;
  if (g.measureText(author).width <= w * 0.82) {
    emboss(g, author, w / 2, h * 0.865, col.gilt);
  } else {
    g.save();
    g.translate(w / 2, h * 0.865);
    g.rotate(Math.PI / 2);
    as = Math.min(w * 0.42, 14);
    g.font = `${as}px ${SERIF}`;
    emboss(g, author.length > 14 ? author.slice(0, 13) + '…' : author, 0, 0, col.gilt);
    g.restore();
  }
  // A small ornament.
  if (rnd() < 0.5 && h > 200) {
    g.font = `${Math.min(w * 0.4, 16)}px ${SERIF}`;
    emboss(g, '❦', w / 2, h * 0.115, col.gilt);
  }
  g.restore();
}

/**
 * Gilt text with a crisp dark offset copy beneath it. (Canvas shadowBlur looks the same at
 * spine sizes but blurs every glyph on the CPU, which made atlas painting slow.)
 */
function emboss(g, text, x, y, color) {
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillText(text, x + 0.7, y + 0.9);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** Stand-alone canvas of one spine (for Book3D). */
export function makeSpineCanvas(book, dims, ppm = SPINE_PPM) {
  const w = Math.max(16, Math.round(dims.w * ppm));
  const h = Math.max(64, Math.round(dims.h * ppm));
  const c = newCanvas(w, h);
  drawSpine(c.getContext('2d'), book, 0, 0, w, h);
  return c;
}

/** Generated cover for books without a cover image: cloth, gilt frame, title, author. */
export function makeCoverCanvas(book, { w = 512, h = 720 } = {}) {
  const col = bookColors(book);
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, col.light);
  grd.addColorStop(0.5, col.cloth);
  grd.addColorStop(1, col.dark);
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 0.12, hashString(String(book.id)));
  g.strokeStyle = col.gilt;
  g.lineWidth = 4;
  g.strokeRect(28, 28, w - 56, h - 56);
  g.lineWidth = 1.5;
  g.strokeRect(40, 40, w - 80, h - 80);
  g.fillStyle = col.gilt;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = `600 44px ${SERIF}`;
  const lines = wrapLines(g, spineTitle(book), w - 120, 5);
  let y = h * 0.3;
  for (const l of lines) {
    g.fillText(l, w / 2, y);
    y += 54;
  }
  g.font = `italic 28px ${SERIF}`;
  g.fillText(book.author || '', w / 2, h - 110, w - 120);
  g.font = `34px ${SERIF}`;
  g.fillText('❦', w / 2, y + 30);
  return c;
}

/** Brass plate with engraved text (bookcase range labels, section signs). */
export function drawPlate(g, x, y, w, h, text, { sub = null, font = SERIF } = {}) {
  g.save();
  const grd = g.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, '#e2c47a');
  grd.addColorStop(0.5, '#b8913f');
  grd.addColorStop(1, '#8a6a2a');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#5e4517';
  g.lineWidth = Math.max(1, h * 0.04);
  g.strokeRect(x + h * 0.08, y + h * 0.08, w - h * 0.16, h - h * 0.16);
  g.fillStyle = '#2b1d08';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = h * (sub ? 0.42 : 0.55);
  g.font = `600 ${size}px ${font}`;
  while (g.measureText(text).width > w * 0.88 && size > 6) {
    size -= 1;
    g.font = `600 ${size}px ${font}`;
  }
  g.fillText(text, x + w / 2, y + h * (sub ? 0.4 : 0.52));
  if (sub) {
    let s2 = h * 0.22;
    g.font = `${s2}px ${font}`;
    while (g.measureText(sub).width > w * 0.88 && s2 > 6) {
      s2 -= 1;
      g.font = `${s2}px ${font}`;
    }
    g.fillText(sub, x + w / 2, y + h * 0.74);
  }
  g.restore();
}

/** Canvas for a section sign above a run of bookcases. */
export function makeSignCanvas(title, sub, { w = 1024, h = 256 } = {}) {
  const c = newCanvas(w, h);
  drawPlate(c.getContext('2d'), 0, 0, w, h, title, { sub });
  return c;
}

/** A soft round shadow decal (for fake contact shadows). */
export function makeShadowCanvas({ size = 128, strength = 0.55 } = {}) {
  const c = newCanvas(size, size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(0,0,0,${strength})`);
  grd.addColorStop(0.6, `rgba(0,0,0,${strength * 0.45})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Rug with a border pattern. */
export function makeRugCanvas({ size = 512, seed = 21 } = {}) {
  const c = newCanvas(size, size);
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = '#5a1f1f';
  g.fillRect(0, 0, size, size);
  const cx = size / 2;
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = ['#c9a35b', '#2d3b52', '#8c3b2a', '#e3d2a8'][i % 4];
    g.lineWidth = 6 + i * 2;
    g.beginPath();
    g.arc(cx, cx, size * 0.47 - i * 26, 0, Math.PI * 2);
    g.stroke();
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.fillStyle = i % 2 ? '#c9a35b' : '#2d3b52';
    g.beginPath();
    g.arc(cx + Math.cos(a) * size * 0.3, cx + Math.sin(a) * size * 0.3, 10 + r() * 4, 0, Math.PI * 2);
    g.fill();
  }
  grain(g, size, size, 0.18, seed);
  return c;
}

export { SERIF, SANS, shade };
