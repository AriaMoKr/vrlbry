// Performance recorder, on with ?perf: frame timing, timed events (room rebuilds, atlas jobs, page
// turns), segments (scenarios), long tasks and JS memory, kept in memory and read by
// tools/quest-perf.mjs over the browser's remote debugger as window.__vrlbry.perf. While off (the
// default) every call returns at once, so the instrumentation costs nothing.

export const MAX_FRAMES = 72 * 60 * 20; // a ring buffer: the last 20 minutes at 72 Hz
const MAX_EVENTS = 20000;
const MEMORY_EVERY_MS = 2000;

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
/** Largest value (no spread: tens of thousands of frames would overflow the call stack). */
const maxOf = (values, start = -Infinity) => values.reduce((m, v) => (v > m ? v : m), start);

/** Percentiles (0..1) of an unsorted numeric array. */
function percentiles(values, ps) {
  const s = Float64Array.from(values).sort();
  return ps.map((p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null));
}

export class Recorder {
  constructor() {
    this.enabled = false;
    this._hooks = new Set();
  }

  /**
   * Starts recording.
   * @param {{ renderer?: object, context?: () => object }} o renderer: for the XR session and GL
   *   details; context: extra state to include in dumps (place, room, settings)
   */
  start({ renderer = null, context = null } = {}) {
    if (this.enabled) return;
    this.enabled = true;
    this.renderer = renderer;
    this.context = context;
    this.reset();
    try {
      this._longTasks = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this._push(this.longTasks, { t: round(e.startTime), ms: round(e.duration) });
      });
      this._longTasks.observe({ type: 'longtask', buffered: true });
    } catch { /* long tasks are not reported by this browser */ }
    this._memTimer = setInterval(() => this._sampleMemory(), MEMORY_EVERY_MS);
  }

  stop() {
    this.enabled = false;
    this._longTasks?.disconnect();
    clearInterval(this._memTimer);
  }

  reset() {
    this._t = new Float64Array(MAX_FRAMES); // performance.now() when the frame started
    this._interval = new Float32Array(MAX_FRAMES); // ms since the previous frame (frame timestamps)
    this._cost = new Float32Array(MAX_FRAMES); // ms of main-thread work in the frame callback
    this._calls = new Uint16Array(MAX_FRAMES);
    this._tris = new Uint32Array(MAX_FRAMES);
    this._n = 0; // frames recorded in total (the buffer holds the last MAX_FRAMES)
    this._prevTime = null;
    this.events = [];
    this.segments = [];
    this.longTasks = [];
    this.memory = [];
    this.startedAt = performance.now();
  }

  /** Calls fn(dt) at the start of every frame until the returned function is called. */
  addHook(fn) {
    this._hooks.add(fn);
    return () => this._hooks.delete(fn);
  }

  /** At the start of the frame callback (runs hooks such as scenario walking). */
  beforeFrame(dt) {
    for (const fn of this._hooks) fn(dt);
  }

  /**
   * At the end of the frame callback.
   * @param {number} time the frame timestamp passed to the animation loop (XR or rAF time)
   * @param {number} start performance.now() when the callback began
   * @param {{ calls: number, triangles: number }} [render] renderer.info.render
   */
  afterFrame(time, start, render) {
    const i = this._n % MAX_FRAMES;
    this._t[i] = start;
    this._interval[i] = this._prevTime == null ? 0 : time - this._prevTime;
    this._cost[i] = performance.now() - start;
    this._calls[i] = Math.min(65535, render?.calls ?? 0);
    this._tris[i] = render?.triangles ?? 0;
    this._prevTime = time;
    this._n++;
  }

  /** A timed event: `ms` is its duration when it has one; it started at `t` (default: now − ms). */
  event(name, data = {}) {
    if (!this.enabled) return;
    const ms = data.ms ?? 0;
    this._push(this.events, { name, t: round(data.t ?? performance.now() - ms), ...data, ms: round(ms) });
  }

  /** Starts a named segment (a scenario); end() closes the open one. */
  begin(name) {
    if (!this.enabled) return;
    this.end();
    this.segments.push({ name, t0: performance.now(), t1: null });
  }

  end() {
    const s = this.segments[this.segments.length - 1];
    if (s && s.t1 == null) s.t1 = performance.now();
  }

  _push(list, item) {
    if (list.length >= MAX_EVENTS) list.shift();
    list.push(item);
  }

  _sampleMemory() {
    const m = performance.memory; // Chromium only
    if (m) this._push(this.memory, { t: round(performance.now()), usedMB: round(m.usedJSHeapSize / 1048576, 1), totalMB: round(m.totalJSHeapSize / 1048576, 1) });
  }

  /** Recorded frames in time order, optionally only those starting in [t0, t1). */
  frames(t0 = -Infinity, t1 = Infinity) {
    const count = Math.min(this._n, MAX_FRAMES);
    const first = this._n - count;
    const out = [];
    for (let k = 0; k < count; k++) {
      const i = (first + k) % MAX_FRAMES;
      const t = this._t[i];
      if (t < t0 || t >= t1) continue;
      out.push({ t, interval: this._interval[i], cost: this._cost[i], calls: this._calls[i], tris: this._tris[i] });
    }
    return out;
  }

  /** The display's frame interval: from the XR session's frame rate, else the median interval. */
  expectedInterval() {
    const rate = this.renderer?.xr?.getSession?.()?.frameRate;
    if (rate) return 1000 / rate;
    const iv = this.frames().map((f) => f.interval).filter((v) => v > 0);
    return percentiles(iv, [0.5])[0] ?? 1000 / 60;
  }

  /** Frame statistics for frames starting in [t0, t1). */
  stats(t0 = -Infinity, t1 = Infinity, expected = this.expectedInterval()) {
    const fr = this.frames(t0, t1).filter((f) => f.interval > 0);
    if (!fr.length) return { frames: 0 };
    const iv = fr.map((f) => f.interval);
    const cost = fr.map((f) => f.cost);
    const [i50, i95, i99] = percentiles(iv, [0.5, 0.95, 0.99]);
    const [c50, c95] = percentiles(cost, [0.5, 0.95]);
    const seconds = iv.reduce((a, b) => a + b, 0) / 1000;
    const dropped = iv.reduce((n, v) => n + (v > expected * 1.5 ? Math.round(v / expected) - 1 : 0), 0);
    return {
      frames: fr.length,
      seconds: round(seconds, 1),
      fps: round(fr.length / seconds, 1),
      intervalMs: { p50: round(i50), p95: round(i95), p99: round(i99), max: round(maxOf(iv)) },
      costMs: { p50: round(c50), p95: round(c95), max: round(maxOf(cost)) },
      dropped,
      droppedPct: round((100 * dropped) / (fr.length + dropped), 1),
      drawCalls: { p50: percentiles(fr.map((f) => f.calls), [0.5])[0], max: maxOf(fr.map((f) => f.calls)) },
    };
  }

  /** Where the page runs: browser, XR session, GL limits. */
  environment() {
    const r = this.renderer;
    const session = r?.xr?.getSession?.();
    const gl = r?.getContext?.();
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const layer = session?.renderState?.baseLayer;
    return {
      userAgent: navigator.userAgent,
      devicePixelRatio: globalThis.devicePixelRatio,
      xr: session ? {
        presenting: !!r.xr.isPresenting,
        frameRate: session.frameRate ?? null,
        supportedFrameRates: session.supportedFrameRates ? Array.from(session.supportedFrameRates) : null,
        foveation: r.xr.getFoveation?.() ?? null,
        framebuffer: layer ? [layer.framebufferWidth, layer.framebufferHeight] : null,
        blendMode: session.environmentBlendMode ?? null,
      } : null,
      gl: gl ? {
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      } : null,
    };
  }

  /** Compact numbers for a quick look; dump() has everything. */
  summary() {
    const expected = this.expectedInterval();
    const events = {};
    for (const e of this.events) {
      const g = (events[e.name] ||= { count: 0, ms: [] });
      g.count++;
      g.ms.push(e.ms);
    }
    for (const g of Object.values(events)) {
      const [p50, max] = [percentiles(g.ms, [0.5])[0], maxOf(g.ms)];
      g.msP50 = round(p50);
      g.msMax = round(max);
      delete g.ms;
    }
    return {
      recordingSeconds: round((performance.now() - this.startedAt) / 1000, 1),
      expectedIntervalMs: round(expected),
      overall: this.stats(-Infinity, Infinity, expected),
      segments: this.segments.map((s) => ({ name: s.name, ...this.stats(s.t0, s.t1 ?? Infinity, expected) })),
      rebuilds: this.events.filter((e) => e.name === 'rebuild').map((e) => ({
        ...e, worstGapMs: round(maxOf(this.frames(e.t, e.t + e.ms + 50).map((f) => f.interval), 0)),
      })),
      events,
      longTasks: { count: this.longTasks.length, maxMs: maxOf(this.longTasks.map((l) => l.ms), 0) },
      memory: this.memory[this.memory.length - 1] ?? null,
    };
  }

  /** Everything recorded, as plain JSON (frame arrays are rounded to 0.01 ms). */
  dump() {
    const fr = this.frames();
    return {
      version: 1,
      at: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      environment: this.environment(),
      context: this.context?.() ?? null,
      summary: this.summary(),
      frames: {
        t: fr.map((f) => round(f.t)),
        interval: fr.map((f) => round(f.interval)),
        cost: fr.map((f) => round(f.cost)),
        calls: fr.map((f) => f.calls),
        tris: fr.map((f) => f.tris),
      },
      events: this.events,
      segments: this.segments.map((s) => ({ ...s, t0: round(s.t0), t1: s.t1 == null ? null : round(s.t1) })),
      longTasks: this.longTasks,
      memory: this.memory,
    };
  }
}

export const perf = new Recorder();
