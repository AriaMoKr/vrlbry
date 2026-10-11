// "Copy debug info" (the help dialog, and the error screen when loading fails): a short report for
// a bug seen on someone else's computer, without opening the browser's console. Browser, graphics,
// the site's version, where in the app they are, and the page's last errors. No reading history
// or other personal data. The scene part (view, book, reading settings, dialogs) is scene.js's,
// so a report can be restored like a saved scene.

import { part, sceneOf } from './scene.js';

const MAX_ERRORS = 20;
const MAX_TEXT = 300;
const errors = [];
/** The console's own error and warn (startErrorLog wraps them): noteError prints without being kept twice. */
const raw = {
  error: (...a) => globalThis.console?.error?.(...a),
  warn: (...a) => globalThis.console?.warn?.(...a),
};

const short = (s) => {
  const text = String(s ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
};

/** An error or console argument as text: an Error's first stack lines, else JSON or String. */
function describe(value) {
  if (value instanceof Error) {
    return value.stack ? value.stack.split('\n').slice(0, 3).map((l) => l.trim()).join(' | ') : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function remember(kind, message, where = null) {
  errors.push({ t: Math.round(performance.now() / 100) / 10, kind, message: short(message), ...(where ? { where } : {}) });
  if (errors.length > MAX_ERRORS) errors.shift();
}

/**
 * Starts keeping the page's last errors for the report: uncaught errors, rejected promises,
 * elements that failed to load, and console.error / console.warn calls (still printed as before).
 * @param {{ target?: EventTarget, con?: Console }} [o] the window and console (tests pass fakes)
 */
export function startErrorLog({ target = globalThis, con = globalThis.console } = {}) {
  target.addEventListener?.('error', (e) => {
    if (e.error || e.message) {
      remember('error', e.error ? describe(e.error) : e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null);
    } else if (e.target?.src || e.target?.href) {
      remember('load', `failed to load ${e.target.src || e.target.href}`);
    }
  }, true); // capture: an element's load error does not bubble
  target.addEventListener?.('unhandledrejection', (e) => remember('rejection', describe(e.reason)));
  for (const level of ['error', 'warn']) {
    const real = con[level];
    raw[level] = (...args) => real.apply(con, args);
    con[level] = (...args) => {
      remember(level, args.map(describe).join(' '));
      real.apply(con, args);
    };
  }
}

/**
 * Keeps a message for the report, and prints it to the console (for those who copy the console
 * instead): what the page showed as an error (a toast, printed as a warning), or a ZIM that failed
 * to open, with its full address (an error; the toast names the file only).
 */
export function noteError(kind, message) {
  remember(kind, message);
  (kind === 'open' ? raw.error : raw.warn)(`[vrlbry] ${kind === 'open' ? 'Could not open' : 'Shown'}: ${message}`);
}

/** The errors kept so far, oldest first (t: seconds since the page started loading). */
export const recentErrors = () => errors.slice();

/**
 * What the GPU draws: three pixels (centre, lower middle, upper left) of a frame rendered now, as
 * hex. A view that is drawn but never shown (a Pixel 11's Vivaldi showed the page's background,
 * #17120d, where the scene's is #0d0906) then reads as the room's colours, one drawn black as black.
 */
function drawnPixels(app) {
  const r = app.renderer;
  if (r.xr.isPresenting) return null; // the headset's framebuffer is not the canvas's
  r.setRenderTarget(null);
  r.render(app.scene, app.camera);
  const gl = r.getContext();
  const px = new Uint8Array(4);
  return [[0.5, 0.5], [0.5, 0.2], [0.2, 0.8]].map(([x, y]) => {
    gl.readPixels(Math.floor(gl.drawingBufferWidth * x), Math.floor(gl.drawingBufferHeight * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return `#${[...px.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  });
}

/**
 * The report. Every part is collected on its own, so a broken one (or a page that failed before
 * the app existed) still leaves the rest.
 * @param {object} [app] window.__vrlbry (absent while loading or when loading failed)
 * @param {{ overlay?: object }} [o] the page's overlay, which exists before the app does
 * @returns {object}
 */
export function debugReport(app, { overlay = app?.overlay } = {}) {
  const I = app?.interaction;
  const r = app?.renderer;
  const s = app?.settings;
  const scene = sceneOf(app, { overlay });
  return {
    app: 'vrlbry',
    at: new Date().toISOString(),
    url: part(() => location.href),
    version: app?.version ?? null, // when the site's files last changed, as of this page's load
    uptime: Math.round(performance.now() / 1000),
    browser: part(() => ({
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: [innerWidth, innerHeight],
      devicePixelRatio,
      touchPoints: navigator.maxTouchPoints,
      memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    })),
    gpu: part(() => {
      const gl = r.getContext();
      // A lost context (the browser took back the graphics memory: the view goes black) answers
      // null to every question.
      if (gl.isContextLost?.()) return { contextLost: true, drawCalls: r.info.render.calls };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        version: gl.getParameter(gl.VERSION),
        renderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        antialias: gl.getContextAttributes()?.antialias ?? null,
        buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        canvas: [r.domElement.clientWidth, r.domElement.clientHeight],
        drawCalls: r.info.render.calls,
        pixels: part(() => drawnPixels(app)),
      };
    }),
    xr: part(() => ({ api: 'xr' in navigator, emulated: !!app.xrDevice, presenting: !!r.xr.isPresenting })),
    libraries: part(() => I.libraries.map((l) => `${l.id} (${l.kind}, ${(I.booksByLib[l.id] || []).length})`)),
    // The scene: restoring the report (pasted into the help dialog, or __vrlbry.reproduce) shows it.
    view: scene.view,
    book: scene.book,
    ui: scene.ui,
    settings: part(() => ({
      ...scene.settings, smoothMove: s.smoothMove, sound: s.sound, updateNotices: s.updateNotices,
    })),
    errors: recentErrors(),
  };
}

/** Copies text to the clipboard. False when the browser does not allow it (copy it by hand then). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard API (not a secure context, e.g. http://<LAN address>) or not allowed
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
