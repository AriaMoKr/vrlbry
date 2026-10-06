// Canvas-texture UI panels for VR and desktop (SPEC §5.5): buttons, text, images, scrollable
// lists and sliders drawn onto a canvas that textures a plane. Hit testing works on the uv of a
// raycast intersection, so the same panel works with XR controllers, hands, mouse and touch.

import * as THREE from 'three';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif';

export const UI = {
  font: FONT,
  serif: SERIF,
  text: '#f1e6d0',
  muted: '#b6a487',
  accent: '#d9b26a',
  button: '#3a2e22',
  buttonHover: '#5b4630',
  buttonActive: '#8f6c34',
  border: 'rgba(217,178,106,0.45)',
};

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Wraps text into lines that fit `width`; the last allowed line gets an ellipsis. */
export function wrapText(g, text, width, maxLines = Infinity) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width <= width || !cur) cur = t;
      else {
        out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && g.measureText(last + '…').width > width) last = last.slice(0, -1);
    kept[maxLines - 1] = last.trimEnd() + '…';
    return kept;
  }
  return out;
}

export class Panel {
  /**
   * @param {object} o
   * @param {number} o.width metres
   * @param {number} o.height metres
   * @param {number} [o.pxPerMeter]
   * @param {string|null} [o.background]
   * @param {number} [o.radius] corner radius in px
   */
  constructor({ width, height, pxPerMeter = 1200, background = 'rgba(25,20,16,0.93)', radius = 28, anisotropy = 4 }) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    const scale = Math.min(1, 2048 / Math.max(width * pxPerMeter, height * pxPerMeter));
    this.canvas.width = Math.round(width * pxPerMeter * scale);
    this.canvas.height = Math.round(height * pxPerMeter * scale);
    this.ctx = this.canvas.getContext('2d');
    this.background = background;
    this.radius = radius;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = 10;
    this.elements = [];
    this.hover = null;
    this.dirty = true;
  }

  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }

  get visible() { return this.mesh.visible; }
  set visible(v) {
    this.mesh.visible = v;
    if (!v) this.pointerLeave();
  }

  clear() {
    this.elements = [];
    this.hover = null;
    // A scroll bar being dragged carries on with the list of the same id that replaces it.
    if (this._drag) this._drag.id = this._drag.el.id;
    this.markDirty();
  }

  /** Adds an element; returns it. Elements are drawn in insertion order. */
  add(el) {
    if (this._drag?.id && this._drag.id === el.id) {
      this._drag.el = el;
      this._drag.id = null;
    }
    this.elements.push(el);
    this.markDirty();
    return el;
  }

  remove(id) {
    this.elements = this.elements.filter((e) => e.id !== id);
    this.markDirty();
  }

  get(id) {
    return this.elements.find((e) => e.id === id);
  }

  /** Updates fields of an element by id. */
  set(id, fields) {
    const el = this.get(id);
    if (el) {
      Object.assign(el, fields);
      this.markDirty();
    }
    return el;
  }

  markDirty() {
    this.dirty = true;
  }

  /** Repaints if anything changed. Call once per frame (cheap when clean). */
  update() {
    if (this.dirty) this.redraw();
  }

  redraw() {
    this.dirty = false;
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    if (this.background) {
      roundRect(g, 2, 2, this.w - 4, this.h - 4, this.radius);
      g.fillStyle = this.background;
      g.fill();
      g.strokeStyle = UI.border;
      g.lineWidth = 3;
      g.stroke();
    }
    for (const el of this.elements) {
      if (el.hidden) continue;
      const fn = this[`_draw_${el.type}`];
      if (fn) fn.call(this, g, el);
    }
    this.texture.needsUpdate = true;
  }

  _font(el, size, weight = '') {
    return `${weight} ${size}px ${el.serif ? SERIF : FONT}`.trim();
  }

  _draw_rect(g, el) {
    roundRect(g, el.x, el.y, el.w, el.h, el.radius ?? 0);
    g.fillStyle = el.color || 'rgba(255,255,255,0.08)';
    g.fill();
  }

  _draw_text(g, el) {
    const size = el.size || 34;
    g.font = this._font(el, size, el.weight || '');
    g.fillStyle = el.color || UI.text;
    g.textBaseline = 'top';
    g.textAlign = el.align || 'left';
    const lines = wrapText(g, el.text, el.w, el.maxLines ?? Math.max(1, Math.floor(el.h / (size * 1.25))));
    const lh = size * 1.25;
    let y = el.y;
    if (el.valign === 'middle') y = el.y + (el.h - lines.length * lh) / 2;
    const x = el.align === 'center' ? el.x + el.w / 2 : el.align === 'right' ? el.x + el.w : el.x;
    for (const line of lines) {
      g.fillText(line, x, y);
      y += lh;
    }
  }

  _draw_image(g, el) {
    const img = el.image;
    if (!img || !(img.naturalWidth || img.width)) {
      roundRect(g, el.x, el.y, el.w, el.h, 8);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fill();
      return;
    }
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = Math.min(el.w / iw, el.h / ih);
    const w = iw * s;
    const h = ih * s;
    const x = el.x + (el.w - w) / 2;
    const y = el.y + (el.h - h) / 2;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 16;
    g.shadowOffsetY = 6;
    g.drawImage(img, x, y, w, h);
    g.restore();
  }

  _draw_button(g, el) {
    const hover = this.hover === el && !el.disabled;
    roundRect(g, el.x, el.y, el.w, el.h, el.radius ?? 16);
    g.fillStyle = el.disabled ? 'rgba(80,70,60,0.5)' : el.active ? UI.buttonActive : hover ? UI.buttonHover : (el.color || UI.button);
    g.fill();
    if (hover || el.active) {
      g.strokeStyle = UI.accent;
      g.lineWidth = 3;
      g.stroke();
    }
    const size = el.size || Math.min(40, el.h * 0.45);
    g.font = this._font(el, size, el.weight || '600');
    g.fillStyle = el.disabled ? '#857868' : UI.text;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = wrapText(g, el.label, el.w - 16, 1)[0];
    g.fillText(label, el.x + el.w / 2, el.y + el.h / 2 + 1);
  }

  _draw_slider(g, el) {
    const v = Math.max(0, Math.min(1, el.value || 0));
    const hover = this.hover === el;
    const barH = Math.max(8, el.h * 0.22);
    const y = el.y + (el.h - barH) / 2;
    roundRect(g, el.x, y, el.w, barH, barH / 2);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fill();
    roundRect(g, el.x, y, Math.max(barH, el.w * v), barH, barH / 2);
    g.fillStyle = UI.accent;
    g.fill();
    g.beginPath();
    g.arc(el.x + el.w * v, el.y + el.h / 2, hover ? barH * 1.3 : barH, 0, Math.PI * 2);
    g.fillStyle = '#f6e7c4';
    g.fill();
    if (hover && el.hoverValue != null) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(el.x + el.w * el.hoverValue - 1, el.y, 2, el.h);
    }
  }

  _draw_list(g, el) {
    const rowH = el.rowH || 64;
    const visible = Math.floor(el.h / rowH);
    const items = el.items || [];
    el.scroll = Math.max(0, Math.min(el.scroll || 0, Math.max(0, items.length - visible)));
    const barW = items.length > visible ? 56 : 0;
    for (let i = 0; i < visible && el.scroll + i < items.length; i++) {
      const it = items[el.scroll + i];
      const y = el.y + i * rowH;
      const hover = this.hover === el && el.hoverRow === i;
      if (hover || it.active) {
        roundRect(g, el.x, y + 2, el.w - barW - 8, rowH - 4, 10);
        g.fillStyle = it.active ? 'rgba(143,108,52,0.55)' : 'rgba(255,255,255,0.10)';
        g.fill();
      }
      const size = el.size || Math.min(32, rowH * 0.42);
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      const indent = (it.indent || 0) * size * 0.9;
      g.font = this._font(el, size, it.weight || '');
      g.fillStyle = it.disabled ? '#857868' : UI.text;
      const textW = el.w - barW - 28 - indent - (it.right ? 140 : 0);
      if (it.sub) {
        g.fillText(wrapText(g, it.label, textW, 1)[0], el.x + 14 + indent, y + rowH * 0.36);
        g.font = this._font(el, size * 0.72);
        g.fillStyle = UI.muted;
        g.fillText(wrapText(g, it.sub, textW, 1)[0], el.x + 14 + indent, y + rowH * 0.72);
      } else {
        g.fillText(wrapText(g, it.label, textW, 1)[0], el.x + 14 + indent, y + rowH / 2);
      }
      if (it.right) {
        g.font = this._font(el, size * 0.8);
        g.fillStyle = UI.muted;
        g.textAlign = 'right';
        g.fillText(it.right, el.x + el.w - barW - 18, y + rowH / 2);
      }
    }
    if (barW) {
      // Scroll arrows + position thumb.
      const bx = el.x + el.w - barW;
      for (const [label, by] of [['▲', el.y], ['▼', el.y + el.h - barW]]) {
        const hover = this.hover === el && el.hoverRow === (label === '▲' ? 'up' : 'down');
        roundRect(g, bx, by, barW, barW, 12);
        g.fillStyle = hover ? UI.buttonHover : UI.button;
        g.fill();
        g.fillStyle = UI.text;
        g.font = this._font(el, 26);
        g.textAlign = 'center';
        g.fillText(label, bx + barW / 2, by + barW / 2 + 1);
      }
      const sb = this._scrollBar(el);
      const hot = this._drag?.el === el || (this.hover === el && el.hoverRow === 'track');
      const tw = hot ? 20 : 12;
      roundRect(g, bx + barW / 2 - tw / 2, sb.thumbY, tw, sb.thumbH, tw / 2);
      g.fillStyle = hot ? 'rgba(232,196,124,0.95)' : 'rgba(217,178,106,0.6)';
      g.fill();
    }
  }

  /** Scrolls a list element by `rows` (positive = down). */
  scrollList(id, rows) {
    const el = this.get(id);
    if (!el) return;
    el.scroll = (el.scroll || 0) + rows;
    this.markDirty();
  }

  _toPx(uv) {
    return { x: uv.x * this.w, y: (1 - uv.y) * this.h };
  }

  _hit(p) {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (el.hidden || !['button', 'slider', 'list'].includes(el.type)) continue;
      if (p.x >= el.x && p.x <= el.x + el.w && p.y >= el.y && p.y <= el.y + el.h) return el;
    }
    return null;
  }

  _listRow(el, p) {
    const rowH = el.rowH || 64;
    const visible = Math.floor(el.h / rowH);
    const barW = (el.items || []).length > visible ? 56 : 0;
    if (barW && p.x >= el.x + el.w - barW) {
      if (p.y <= el.y + barW) return 'up';
      if (p.y >= el.y + el.h - barW) return 'down';
      return 'track';
    }
    return Math.floor((p.y - el.y) / rowH);
  }

  /**
   * A list's scroll bar, between its ▲ and ▼ (null when everything fits): the track, the thumb
   * (its height shows how much is visible) and the largest scroll.
   */
  _scrollBar(el) {
    const rowH = el.rowH || 64;
    const visible = Math.floor(el.h / rowH);
    const items = el.items || [];
    if (items.length <= visible) return null;
    const barW = 56;
    const trackY = el.y + barW + 8;
    const trackH = el.h - 2 * barW - 16;
    const max = items.length - visible;
    const thumbH = Math.max(30, trackH * (visible / items.length));
    return { x: el.x + el.w - barW, barW, trackY, trackH, thumbH, thumbY: trackY + (trackH - thumbH) * ((el.scroll || 0) / max), max, visible };
  }

  /**
   * A press at uv: on a list's scroll bar it starts dragging the thumb (pressing the track beside
   * the thumb first jumps a page towards the press). Returns true when it did; dragTo() and
   * release() follow.
   */
  pressAt(uv) {
    const p = this._toPx(uv);
    const el = this._hit(p);
    if (el?.type !== 'list' || el.disabled || this._listRow(el, p) !== 'track') return false;
    let sb = this._scrollBar(el);
    if (!sb) return false;
    if (p.y < sb.thumbY || p.y > sb.thumbY + sb.thumbH) {
      this.scrollList(el.id, (p.y < sb.thumbY ? -1 : 1) * Math.max(1, sb.visible - 1));
      el.scroll = Math.max(0, Math.min(el.scroll, sb.max));
      sb = this._scrollBar(el);
    }
    this._drag = { el, grab: Math.max(0, Math.min(sb.thumbH, p.y - sb.thumbY)) };
    this.markDirty();
    return true;
  }

  /** Moves a dragged scroll bar's thumb to follow uv (the pointer may leave the bar meanwhile). */
  dragTo(uv) {
    if (!this._drag) return;
    const { el, grab } = this._drag;
    const sb = this._scrollBar(el);
    if (!sb) return;
    const p = this._toPx(uv);
    const t = (p.y - grab - sb.trackY) / Math.max(1, sb.trackH - sb.thumbH);
    const scroll = Math.round(Math.max(0, Math.min(1, t)) * sb.max);
    if (scroll !== el.scroll) {
      el.scroll = scroll;
      this.markDirty();
    }
  }

  /** Ends a scroll bar drag. Returns true when one was going on. */
  release() {
    const was = !!this._drag;
    this._drag = null;
    if (was) this.markDirty();
    return was;
  }

  /** True while a scroll bar is being dragged. */
  get dragging() { return !!this._drag; }

  /** Hover feedback; returns true when over an interactive element. */
  pointerMove(uv) {
    const p = this._toPx(uv);
    const el = this._hit(p);
    let row = null;
    let hv = null;
    if (el?.type === 'list') row = this._listRow(el, p);
    if (el?.type === 'slider') hv = Math.max(0, Math.min(1, (p.x - el.x) / el.w));
    if (el !== this.hover || (el && (el.hoverRow !== row || el.hoverValue !== hv))) {
      if (this.hover && this.hover !== el) {
        this.hover.hoverRow = null;
        this.hover.hoverValue = null;
      }
      this.hover = el;
      if (el) {
        el.hoverRow = row;
        el.hoverValue = hv;
      }
      this.markDirty();
    }
    return !!el && !el.disabled;
  }

  pointerLeave() {
    if (this.hover) {
      this.hover.hoverRow = null;
      this.hover = null;
      this.markDirty();
    }
  }

  /** Activates the element under uv. Returns true if something handled the click. */
  click(uv) {
    const p = this._toPx(uv);
    const el = this._hit(p);
    if (!el || el.disabled) return false;
    if (el.type === 'button') el.onClick?.(el);
    else if (el.type === 'slider') {
      const v = Math.max(0, Math.min(1, (p.x - el.x) / el.w));
      el.value = v;
      this.markDirty();
      el.onClick?.(v, el);
    } else if (el.type === 'list') {
      const row = this._listRow(el, p);
      const rowH = el.rowH || 64;
      const visible = Math.floor(el.h / rowH);
      if (row === 'up') this.scrollList(el.id, -Math.max(1, visible - 1));
      else if (row === 'down') this.scrollList(el.id, Math.max(1, visible - 1));
      else if (typeof row === 'number') {
        const it = el.items[(el.scroll || 0) + row];
        if (it && !it.disabled) it.onClick?.(it);
        else return false;
      }
    }
    return true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.mesh.removeFromParent();
  }
}

/** Floating two-line label (tooltips, hints). */
export class Label {
  constructor({ width = 0.5, height = 0.12, pxPerMeter = 1400 } = {}) {
    this.panel = new Panel({ width, height, pxPerMeter, background: 'rgba(20,16,12,0.88)', radius: 22 });
    this.mesh = this.panel.mesh;
    this.mesh.renderOrder = 20;
    this.material = this.panel.material;
    this.material.depthTest = false;
    this.material.side = THREE.FrontSide;
    this._text = null;
  }

  setText(title, sub = '') {
    const key = title + '\n' + sub;
    if (key === this._text) return;
    this._text = key;
    const p = this.panel;
    p.clear();
    const pad = p.h * 0.12;
    p.add({ type: 'text', x: pad, y: pad * 0.9, w: p.w - 2 * pad, h: p.h * 0.45, text: title, size: Math.round(p.h * 0.3), weight: '600', serif: true, maxLines: 1 });
    if (sub) p.add({ type: 'text', x: pad, y: p.h * 0.56, w: p.w - 2 * pad, h: p.h * 0.36, text: sub, size: Math.round(p.h * 0.22), color: UI.muted, maxLines: 1 });
    p.redraw();
  }

  get visible() { return this.mesh.visible; }
  set visible(v) { this.mesh.visible = v; }

  dispose() {
    this.panel.dispose();
  }
}
