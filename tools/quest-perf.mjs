#!/usr/bin/env node
// Collects vrlbry performance data from a Meta Quest over adb: the page's own recorder (?perf,
// public/js/perf.js) read through the Quest Browser's remote debugger, the headset's VrApi
// per-second log (FPS, stale frames, CPU/GPU load, temperature), the browser's memory and the
// battery. Writes one JSON dump to perf/ and prints a summary. Run with --help for usage.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { launchChrome } from 'common/tools/chrome.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'com.oculus.browser';

const HELP = `Usage: node tools/quest-perf.mjs <command> [options]

Commands:
  status   check adb, the headset and the vrlbry page
  dump     save what the page has recorded so far (use vrlbry with ?perf first)
  run      run the built-in scenarios in the page, then save the dump
  handover enter VR, take the page's way out and watch the next page: whether Quest Browser
           granted it a session and whether it took it, with the times (SPEC §5.7; no dump)

Options:
  --open           open http://localhost:<port>/?perf in Quest Browser first (sets up adb reverse)
  --port <n>       the vrlbry server's local HTTP port for --open (default 8080)
  --only <a,b,…>   run only these scenarios (small-idle, room-walk, filters, all-enter, all-idle,
                   all-walk, read, wiki-walk, wiki-read)
  --enter-vr       try to start the immersive session from here instead of waiting for you
  --allow-2d       run the scenarios even when the page is not in VR
  --out <dir>      where to write the dump (default perf/)
  --serial <id>    adb device serial, when several devices are connected
  --no-gc          do not trace garbage collection during run (on by default)
  --no-prox        leave the proximity sensor alone during run and handover (by default they make
                   the headset act as if worn, and give the sensor back at the end)
  --runs <n>       handover: how many times (default 3)
  --to <url>       handover: where the way out leads (default: the page itself; Quest Browser
                   grants only within one origin, so another one shows what a visitor gets there)
  --delay <ms>     handover: hold the next page's granted request back this long (a grant lasts
                   about 5 s from the page's start)
  --desktop        measure on this PC instead of the headset: a Chrome window of its own opens
                   http://localhost:<port>/?perf (common's launchChrome, on a new profile set up so
                   Windows sees no failed logon) and is closed at the end; skips adb, and the
                   scenarios run in 2D. It draws while covered, not while minimized or with the
                   screen locked. CHROME_PATH chooses the browser.
  -h, --help       this help

The headset must be connected (USB or adb over Wi-Fi) with USB debugging allowed for this PC.
The scenarios move you around the library (smooth gliding along aisles): wearing the headset is
optional. A headset nobody wears stops rendering, so run overrides its proximity sensor for the run
(PROXIMITY: as if worn, then the sensor given back, also when the run fails or is stopped; a
restart of the headset gives it back too). No tape on the sensor needed. handover starts VR from
here; the first time, Quest Browser asks in the headset to allow VR for the page's address.`;

/**
 * Meta's power manager broadcasts (adb): the headset acts as if worn, its proximity sensor
 * overridden (a headset nobody wears stops rendering its VR session and the browser's frames), and
 * the sensor given back. The override lasts until it is given back or the headset restarts.
 */
export const PROXIMITY = Object.freeze({
  worn: ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close'],
  sensor: ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.automation_disable'],
});

// ---------------------------------------------------------------------------------------------
// Parsing (exported for tests)

/** Abstract socket names from /proc/net/unix that are Chromium DevTools endpoints. */
export function devtoolsSockets(procNetUnix) {
  const names = new Set();
  for (const line of procNetUnix.split('\n')) {
    const m = line.match(/@(\S*devtools_remote\S*)\s*$/);
    if (m) names.add(m[1]);
  }
  // The browser's own socket first.
  return [...names].sort((a, b) => (a === 'chrome_devtools_remote' ? -1 : b === 'chrome_devtools_remote' ? 1 : a.localeCompare(b)));
}

const num = (s) => {
  const m = String(s ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * One VrApi per-second line ("FPS=72/72,Prd=45ms,…,GPU%=0.47,…"; fields vary by OS version).
 * @returns {object|null} { t?, fps, fpsTarget, stale, appMs, gpuPct, cpuPct, tempC, freeMB, raw }
 */
export function parseVrApiLine(line) {
  const at = line.indexOf('FPS=');
  if (at < 0) return null;
  const fields = {};
  for (const part of line.slice(at).trim().split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const [fps, fpsTarget] = (fields.FPS || '').split('/').map(Number);
  const epoch = line.match(/^\s*(\d{9,}\.\d+)/); // logcat -v epoch
  const pct = (v) => (v == null ? null : num(v) <= 1.5 ? Math.round(num(v) * 1000) / 10 : num(v)); // 0.47 → 47 %
  return {
    t: epoch ? Number(epoch[1]) : null,
    fps: Number.isFinite(fps) ? fps : null,
    fpsTarget: Number.isFinite(fpsTarget) ? fpsTarget : null,
    stale: num(fields.Stale),
    appMs: num(fields.App),
    gpuPct: pct(fields['GPU%']),
    cpuPct: pct(fields['CPU%']),
    tempC: num(fields.Temp),
    freeMB: num(fields.Free),
    levels: Object.entries(fields).find(([k]) => /^CPU\d*\/GPU$/.test(k))?.[1] ?? null,
    raw: line.slice(at).trim(),
  };
}

/** Memory (MB) of every Quest Browser process, from `dumpsys meminfo` (total PSS or RSS). */
export function parseMeminfo(text) {
  const processes = {};
  let section = false;
  for (const line of text.split('\n')) {
    if (/^Total (PSS|RSS) by process/.test(line.trim())) section = true;
    else if (section && /^Total .* by /.test(line.trim())) break;
    else if (section) {
      const m = line.match(/^\s*([\d,]+)K:\s+(\S+)/);
      if (m && m[2].startsWith(BROWSER)) processes[m[2]] = (processes[m[2]] || 0) + Number(m[1].replace(/,/g, ''));
    }
  }
  const totalKB = Object.values(processes).reduce((a, b) => a + b, 0);
  return { totalMB: Math.round(totalKB / 102.4) / 10, processes };
}

/** `adb devices` output (CRLF on Windows) as [{ serial, state }]. */
export function parseAdbDevices(text) {
  return text.split(/\r?\n/).slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map(([serial, state]) => ({ serial, state }));
}

/** adb over Wi-Fi: "ip:port", or an mDNS name. */
export const isNetworkSerial = (serial) => /:\d+$/.test(serial) || serial.startsWith('adb-');

/** Battery level (%) and temperature (°C) from `dumpsys battery`. */
export function parseBattery(text) {
  const level = num(text.match(/^\s*level:\s*(\d+)/m)?.[1]);
  const temp = num(text.match(/^\s*temperature:\s*(\d+)/m)?.[1]);
  return { level, tempC: temp == null ? null : temp / 10 };
}

/** Headline numbers from VrApi samples. */
export function summarizeVrApi(samples) {
  const s = samples.filter((x) => x.fps != null);
  if (!s.length) return null;
  const avg = (k) => {
    const v = s.map((x) => x[k]).filter((x) => x != null);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  return {
    seconds: s.length, fpsAvg: avg('fps'), fpsMin: Math.min(...s.map((x) => x.fps)), fpsTarget: s[s.length - 1].fpsTarget,
    staleTotal: s.reduce((n, x) => n + (x.stale || 0), 0), appMsAvg: avg('appMs'), gpuPctAvg: avg('gpuPct'), cpuPctAvg: avg('cpuPct'),
    tempCMax: Math.max(...s.map((x) => x.tempC ?? -Infinity)),
  };
}

// ---------------------------------------------------------------------------------------------
// Garbage collection, from a CDP trace of V8's own events

/** Trace categories: V8's GC events, and user timing for the clock-sync mark. */
export const GC_TRACE_CATEGORIES = ['v8', 'disabled-by-default-v8.gc', 'blink.user_timing'];
/** performance.mark() name that ties trace time to the page's performance.now(). */
export const TRACE_SYNC_MARK = 'vrlbry-trace-sync';
const GC_EVENT = /^(MinorGC|MajorGC|V8\.GC)/;
const GC_STEP = /IncrementalMarking|_HEAP_EXTERNAL_|PhantomHandle/; // small steps, not pauses

/** Trace events worth keeping (the rest is dropped as it streams in). */
export function keepTraceEvent(e) {
  return GC_EVENT.test(e.name) || e.name === TRACE_SYNC_MARK;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The page's main-thread GC pauses, in its performance.now() time. The sync mark (made with
 * performance.mark() at a known performance.now()) identifies the main thread and the clock
 * offset; nested and overlapping GC events (a GC and its phases) merge into one pause.
 * @param {object[]} events trace events (keepTraceEvent)
 * @param {number} markTime performance.now() of the sync mark
 * @returns {Array<{ t: number, ms: number, major: boolean, name: string }>|null} null without the sync mark
 */
export function gcPauses(events, markTime) {
  const mark = events.find((e) => e.name === TRACE_SYNC_MARK);
  if (!mark) return null;
  const offset = mark.ts / 1000 - markTime; // trace ms − performance.now()
  const spans = [];
  const open = new Map(); // name → begin ts of B/E pairs
  for (const e of events) {
    if (e.pid !== mark.pid || e.tid !== mark.tid || !GC_EVENT.test(e.name)) continue;
    if (e.ph === 'X') spans.push([e.ts, e.ts + (e.dur || 0), e.name]);
    else if (e.ph === 'B') open.set(e.name, e.ts);
    else if (e.ph === 'E' && open.has(e.name)) {
      spans.push([open.get(e.name), e.ts, e.name]);
      open.delete(e.name);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const pauses = [];
  for (const [start, end, name] of spans) {
    const major = !/minor|scaveng/i.test(name) && /major|mc|mark|compact/i.test(name);
    const last = pauses[pauses.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.major ||= major;
    } else {
      pauses.push({ start, end, major, name }); // named after its outermost event
    }
  }
  return pauses.map((p) => ({ t: round2(p.start / 1000 - offset), ms: round2((p.end - p.start) / 1000), major: p.major, name: p.name }));
}

/**
 * GC per recorder segment and overall: pauses (major ones too), their total and longest, and how
 * many of the dropped frames had a GC pause inside the gap — whether GC explains the drops.
 * Dropped frames are counted as the recorder counts them (perf.js summary).
 */
export function summarizeGc(pauses, page) {
  const expected = page.summary?.expectedIntervalMs || 1000 / 72;
  const F = page.frames || { t: [], interval: [] };
  const span = (t0, t1) => {
    const ps = pauses.filter((p) => p.t < t1 && p.t + p.ms > t0);
    let dropped = 0;
    let droppedWithGc = 0;
    for (let i = 0; i < F.t.length; i++) {
      const end = F.t[i];
      const iv = F.interval[i];
      if (end < t0 || end >= t1 || !(iv > expected * 1.5)) continue;
      const n = Math.round(iv / expected) - 1;
      dropped += n;
      if (ps.some((p) => p.t < end && p.t + p.ms > end - iv)) droppedWithGc += n;
    }
    const total = ps.reduce((s, p) => s + p.ms, 0);
    // Incremental marking runs in many small steps (well under 1 ms): counted apart from pauses.
    const full = ps.filter((p) => !GC_STEP.test(p.name));
    return {
      pauses: full.length, major: full.filter((p) => p.major).length, steps: ps.length - full.length, totalMs: round2(total),
      maxMs: round2(ps.reduce((m, p) => Math.max(m, p.ms), 0)), pctOfTime: round2((100 * total) / Math.max(1, t1 - t0)),
      dropped, droppedWithGc,
    };
  };
  const t0 = F.t.length ? F.t[0] - (F.interval[0] || 0) : 0;
  const t1 = F.t.length ? F.t[F.t.length - 1] + 1 : 0;
  return {
    overall: span(t0, t1),
    segments: (page.segments || []).filter((s) => s.t1 != null).map((s) => ({ name: s.name, ...span(s.t0, s.t1) })),
  };
}

/**
 * Dropped frames around spine atlas jobs (the "atlas" events: painted in the worker, then uploaded
 * in the frame that applies them), per segment and overall: of the jobs, how many had a dropped
 * frame in the 3 frames before the atlas was applied (the worker finishing and handing over its
 * bitmap) and in the apply frame or the next (the upload), with what chance alone would give.
 */
export function atlasStalls(page) {
  const expected = page.summary?.expectedIntervalMs || 1000 / 72;
  const F = page.frames || { t: [], interval: [] };
  const jobs = (page.events || []).filter((e) => e.name === 'atlas');
  const dropped = (i) => F.interval[i] > expected * 1.5;
  const span = (t0, t1) => {
    const idx = [];
    for (let i = 0; i < F.t.length; i++) if (F.t[i] >= t0 && F.t[i] < t1) idx.push(i);
    const rate = idx.length ? idx.filter(dropped).length / idx.length : 0;
    let n = 0;
    let before = 0;
    let after = 0;
    let k = 0;
    for (const e of [...jobs].sort((a, b) => a.t + a.ms - (b.t + b.ms))) {
      const applied = e.t + e.ms; // inside the frame that applies it
      if (applied < t0 || applied >= t1) continue;
      while (k < idx.length && F.t[idx[k]] < applied) k++; // idx[k]: the next frame
      if (k < 3 || k + 1 >= idx.length) continue;
      n++;
      if (dropped(idx[k - 1]) || dropped(idx[k - 2]) || dropped(idx[k - 3])) before++;
      if (dropped(idx[k]) || dropped(idx[k + 1])) after++;
    }
    return { jobs: n, before, after, chanceBefore: round2(n * (1 - (1 - rate) ** 3)), chanceAfter: round2(n * (1 - (1 - rate) ** 2)) };
  };
  const t0 = F.t.length ? F.t[0] : 0;
  const t1 = F.t.length ? F.t[F.t.length - 1] + 1 : 0;
  return {
    overall: span(t0, t1),
    segments: (page.segments || []).filter((s) => s.t1 != null).map((s) => ({ name: s.name, ...span(s.t0, s.t1) })),
  };
}

/**
 * Starts tracing V8's GC events in the page; stop() ends it and returns its GC pauses (in the
 * page's performance.now() time), or null when the browser does not trace.
 */
async function startGcTrace(cdp) {
  const events = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const e of value) if (keepTraceEvent(e)) events.push(e);
  });
  const complete = new Promise((resolve) => cdp.on('Tracing.tracingComplete', resolve));
  try {
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', includedCategories: GC_TRACE_CATEGORIES } });
  } catch (err) {
    console.log(`(no GC trace: ${err.message})`);
    return { stop: async () => null };
  }
  return {
    async stop() {
      const markTime = await cdp.eval(`performance.mark(${JSON.stringify(TRACE_SYNC_MARK)}).startTime`);
      await cdp.send('Tracing.end');
      await Promise.race([complete, new Promise((r) => setTimeout(r, 30000))]);
      return gcPauses(events, markTime);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The VR hand-over (handover, exported for tests): after a navigation from an immersive session,
// Quest Browser grants the next page a session without a click (sessiongranted, SPEC §5.7)

/**
 * The page a hand-over starts from: the open page's address without its query, its way out
 * (?back=) leading to `to`, else to the page itself.
 */
export function handoverStart(pageUrl, to) {
  const u = new URL(pageUrl);
  const self = `${u.origin}${u.pathname}`;
  const start = new URL(self);
  start.searchParams.set('back', to || self);
  start.searchParams.set('backname', 'hand-over test');
  return start.href;
}

/**
 * Runs before every document in the tab (Page.addScriptToEvaluateOnNewDocument), whatever its
 * site: notes in window.__handover (performance.now() times) when the page loaded, when the grant
 * came, and what became of the session it asked for. `delayMs` holds a granted request back that
 * long, to find how long a grant lasts.
 */
export function handoverProbe(delayMs = 0) {
  const delay = Math.max(0, Math.round(Number(delayMs) || 0));
  return `(() => {
  const ho = window.__handover = {};
  addEventListener('load', () => { ho.load = performance.now(); });
  const note = (m) => { (ho.errors ||= []).push(String(m).slice(0, 160)); };
  addEventListener('error', (e) => note(e.message || e.type));
  addEventListener('unhandledrejection', (e) => note(e.reason && e.reason.message || e.reason));
  const xr = navigator.xr;
  if (!xr || !xr.requestSession) return;
  xr.addEventListener('sessiongranted', () => { ho.granted = performance.now(); });
  const request = xr.requestSession.bind(xr);
  const ask = (args) => {
    ho.asked = performance.now();
    return request(...args).then((s) => {
      ho.started = performance.now();
      s.addEventListener('end', () => { ho.ended = performance.now(); });
      return s;
    }, (err) => { ho.failed = performance.now(); ho.error = String(err && err.message || err); throw err; });
  };
  xr.requestSession = (...args) => {
    ho.requested = performance.now();
    if (ho.granted == null || !${delay}) return ask(args);
    return new Promise((r) => setTimeout(r, ${delay})).then(() => ask(args));
  };
})();`;
}

/** One hand-over's outcome from the next page's window.__handover: a line, and whether it is in VR. */
export function describeHandover(ho) {
  const ms = (v) => `${Math.round(v)} ms`;
  const inVr = ho.started != null && ho.ended == null;
  const parts = [`load ${ho.load != null ? ms(ho.load) : '—'}`];
  if (ho.granted == null) parts.push('no grant (Quest Browser grants only within one origin)');
  else parts.push(`granted ${ms(ho.granted)}`);
  if (ho.requested == null) {
    if (ho.granted != null) parts.push('never asked for a session');
  } else {
    parts.push(`asked ${ms(ho.requested)}`);
    if (ho.asked != null && ho.asked - ho.requested >= 1) parts.push(`held back to ${ms(ho.asked)}`);
  }
  if (ho.started != null) parts.push(`started ${ms(ho.started)}`);
  if (ho.failed != null) parts.push(`refused ${ms(ho.failed)} (${ho.error})`);
  if (ho.ended != null) parts.push(`ended ${ms(ho.ended)}`);
  if (ho.errors?.length) parts.push(`errors: ${ho.errors.join('; ')}`);
  return { inVr, line: `${inVr ? 'in VR' : '2D'} · ${parts.join(' · ')} (times from the page's start)` };
}

// ---------------------------------------------------------------------------------------------
// adb

function adbArgs(opts, args) {
  return opts.serial ? ['-s', opts.serial, ...args] : args;
}

async function adb(opts, ...args) {
  const { stdout } = await execFileP('adb', adbArgs(opts, args), { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/**
 * Chooses the device every later adb call uses (sets opts.serial): the one given with --serial,
 * the only one connected, or, when one headset is connected both over USB and over Wi-Fi, the
 * USB connection (steadier for the log stream).
 */
async function chooseDevice(opts) {
  const all = parseAdbDevices(await adb({}, 'devices'));
  const ready = all.filter((d) => d.state === 'device');
  if (opts.serial) {
    if (!ready.some((d) => d.serial === opts.serial)) throw new Error(`adb device ${opts.serial} is not connected or not authorized`);
    return;
  }
  if (!ready.length) {
    throw new Error(all.some((d) => d.state === 'unauthorized')
      ? 'the headset has not allowed USB debugging for this PC yet: accept the prompt inside the headset'
      : 'no adb device: connect the headset (USB, or adb over Wi-Fi)');
  }
  if (ready.length > 1) {
    const ids = await Promise.all(ready.map((d) => adb({ serial: d.serial }, 'shell', 'getprop', 'ro.serialno').then((s) => s.trim(), () => d.serial)));
    if (new Set(ids).size > 1) {
      throw new Error(`several devices are connected (${ready.map((d) => d.serial).join(', ')}): choose one with --serial`);
    }
    ready.sort((a, b) => isNetworkSerial(a.serial) - isNetworkSerial(b.serial));
  }
  opts.serial = ready[0].serial;
}

async function deviceInfo(opts) {
  const prop = async (k) => (await adb(opts, 'shell', 'getprop', k)).trim();
  const pkg = await adb(opts, 'shell', 'dumpsys', 'package', BROWSER).catch(() => '');
  return {
    model: await prop('ro.product.model'),
    build: await prop('ro.build.display.id'),
    android: await prop('ro.build.version.release'),
    browser: pkg.match(/versionName=(\S+)/)?.[1] ?? null,
  };
}

async function snapshot(opts, label) {
  const [mem, bat] = await Promise.all([
    adb(opts, 'shell', 'dumpsys', 'meminfo').catch(() => ''),
    adb(opts, 'shell', 'dumpsys', 'battery').catch(() => ''),
  ]);
  return { label, at: new Date().toISOString(), memory: parseMeminfo(mem), battery: parseBattery(bat) };
}

/** Streams VrApi lines while running; stop() returns the parsed samples. */
function vrApiLogger(opts) {
  const samples = [];
  const proc = spawn('adb', adbArgs(opts, ['logcat', '-v', 'epoch', '-T', '1', '-s', 'VrApi:I']), { windowsHide: true });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const s = parseVrApiLine(l);
      if (s) samples.push(s);
    }
  });
  proc.on('error', () => {});
  return { samples, stop: () => { proc.kill(); return samples; } };
}

/** The VrApi lines already in the log buffer (for dump). */
async function vrApiBacklog(opts) {
  const out = await adb(opts, 'logcat', '-d', '-v', 'epoch', '-s', 'VrApi:I').catch(() => '');
  return out.split('\n').map(parseVrApiLine).filter(Boolean);
}

/** Forwards a free local port to the browser's DevTools socket. */
async function forwardDevtools(opts) {
  const sockets = devtoolsSockets(await adb(opts, 'shell', 'cat', '/proc/net/unix'));
  if (!sockets.length) throw new Error('no DevTools socket on the headset: is Quest Browser running?');
  const port = Number((await adb(opts, 'forward', 'tcp:0', `localabstract:${sockets[0]}`)).trim());
  return { endpoint: `http://127.0.0.1:${port}`, release: () => adb(opts, 'forward', '--remove', `tcp:${port}`).catch(() => {}) };
}

// ---------------------------------------------------------------------------------------------
// Chrome DevTools Protocol (Node ≥ 22 has a global WebSocket)

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('the page closed the connection'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluates an expression in the page (awaiting promises) and returns its JSON value. */
  async eval(expression, { userGesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluation failed');
    }
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function listPages(endpoint) {
  const res = await fetch(`${endpoint}/json/list`);
  if (!res.ok) throw new Error(`${endpoint}/json/list: ${res.status}`);
  return (await res.json()).filter((p) => p.type === 'page');
}

/**
 * Connects to the open vrlbry page (the one defining window.__vrlbry), waiting up to `waitMs`;
 * with `prefer`, only one whose address starts with it (the page --open opened, not another tab).
 */
async function connectPage(endpoint, { waitMs = 0, prefer = null } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    for (const page of await listPages(endpoint).catch(() => [])) {
      if (prefer && !page.url.startsWith(prefer)) continue;
      // Rebuild the socket URL on our forwarded port (Android may report a different host).
      const url = `${endpoint.replace(/^http/, 'ws')}/devtools/page/${page.id}`;
      const cdp = await Cdp.connect(url).catch(() => null);
      if (!cdp) continue;
      const ok = await cdp.eval('!!window.__vrlbry').catch(() => false);
      if (ok) return { cdp, page };
      cdp.close();
    }
    if (Date.now() >= until) throw new Error('no vrlbry page found: open vrlbry in the browser (or use --open)');
    await sleep(1500);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until fn() returns something truthy (polling), or throws after `ms`. */
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() >= until) throw new Error(`timed out waiting for ${what}`);
    await sleep(1500);
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

/** Polls the page every 100 ms until `expression` is truthy (its value), or null after `ms`. */
async function pollPage(cdp, expression, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await cdp.eval(expression).catch(() => null);
    if (v) return v;
    if (Date.now() >= until) return null;
    await sleep(100);
  }
}

/**
 * handover: from a fresh start page, enters VR, takes the way out as the stand's button does and
 * watches the next page (handoverProbe), `opts.runs` times.
 */
async function handover(cdp, opts) {
  const self = await cdp.eval('location.origin + location.pathname');
  const start = handoverStart(self, opts.to);
  const runs = Math.max(1, Number(opts.runs) || 3);
  const delay = Math.max(0, Number(opts.delay) || 0);
  const endSession = () => cdp.eval('window.__vrlbry?.renderer.xr.getSession()?.end(), true').catch(() => {});
  await cdp.send('Page.enable');
  // VR starts only in the tab in front (another window's tab may be).
  await cdp.send('Page.bringToFront').catch(() => {});
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: handoverProbe(delay) });
  console.log(`Hand-over from ${start}${delay ? `, a granted request held back ${delay} ms` : ''}:`);
  let inVr = 0;
  try {
    for (let run = 1; run <= runs; run++) {
      await endSession();
      await sleep(1500);
      await cdp.send('Page.navigate', { url: start });
      if (!(await pollPage(cdp, '!!(window.__handover && window.__vrlbry)', 60000))) throw new Error(`${start} did not load`);
      await sleep(2000);
      await cdp.eval('window.__vrlbry.enterVR(), true', { userGesture: true });
      if (!(await pollPage(cdp, 'window.__vrlbry.renderer.xr.isPresenting', 15000))) {
        throw new Error('could not enter VR from here: allow VR for this address in the headset (Quest Browser asks once per origin), then try again');
      }
      await sleep(2000);
      const way = await cdp.eval('window.__vrlbry.interaction.wayOut ?? null');
      if (!way) throw new Error('this vrlbry has no way out (an older version)');
      const before = await cdp.eval('performance.timeOrigin');
      // As the door and the stand's button do (leave: a fade, then the way out), else (an older
      // version) straight there.
      cdp.eval('(I => (I.leave ? I.leave() : I.onHallway(), true))(window.__vrlbry.interaction)', { userGesture: true }).catch(() => {});
      const arrived = await pollPage(cdp, `performance.timeOrigin !== ${before} && document.readyState !== 'loading' && location.href`, 20000);
      if (!arrived) throw new Error(`the way out (${way.url}) did not navigate`);
      // A grant lasts about 5 s from the page's start: wait past that (and the delay) for the outcome.
      await pollPage(cdp, 'window.__handover && (window.__handover.started != null || window.__handover.failed != null)', 8000 + delay);
      await sleep(2000);
      const result = describeHandover(await cdp.eval('({ ...window.__handover })'));
      if (result.inVr) inVr++;
      console.log(`  run ${run}: ${way.label} → ${arrived}\n    ${result.line}`);
    }
    console.log(`${inVr} of ${runs} stayed in VR.`);
  } finally {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    // Back to the library (from wherever the way out led), out of VR.
    if (!(await cdp.eval('!!window.__vrlbry').catch(() => false))) {
      await cdp.send('Page.navigate', { url: self }).catch(() => {});
      await pollPage(cdp, '!!window.__vrlbry', 30000);
    }
    await endSession();
  }
}

function printSummary(dump) {
  const s = dump.page?.summary;
  const eyes = dump.page?.environment?.xr?.presenting ? ' (both eyes)' : '';
  const line = (label, st) => {
    if (!st?.frames) return console.log(`  ${label.padEnd(12)} (no frames)`);
    console.log(`  ${label.padEnd(12)} ${String(st.fps).padStart(5)} fps · interval p50 ${st.intervalMs.p50} / p99 ${st.intervalMs.p99} / max ${st.intervalMs.max} ms`
      + ` · dropped ${st.dropped} (${st.droppedPct}%) · JS p95 ${st.costMs.p95} ms · draw calls ≤ ${st.drawCalls.max}${eyes}`);
  };
  if (s) {
    console.log(`\nPage (display interval ${s.expectedIntervalMs} ms):`);
    line('overall', s.overall);
    for (const seg of s.segments) line(seg.name, seg);
    if (s.rebuilds.length) {
      console.log('  room switches:');
      for (const r of s.rebuilds) {
        console.log(`    ${String(r.place).slice(0, 34).padEnd(34)} ${String(r.bookcases).padStart(4)} bookcases · total ${Math.round(r.ms)} ms`
          + ` (build ${Math.round(r.buildSyncMs)}, lows ${Math.round(r.lowsMs)}) · worst frame gap ${Math.round(r.worstGapMs)} ms`);
      }
    }
    for (const [name, e] of Object.entries(s.events)) {
      if (name !== 'rebuild') console.log(`  ${name.padEnd(12)} ×${e.count} · p50 ${e.msP50} ms · max ${e.msMax} ms`);
    }
    console.log(`  long tasks   ${s.longTasks.count} · max ${s.longTasks.maxMs} ms${s.memory ? ` · JS heap ${s.memory.usedMB} MB` : ''}`);
  }
  if (dump.gc) {
    // Garbage collection on the page's main thread: does it explain the dropped frames?
    console.log('\nGarbage collection (main thread):');
    const gcLine = (label, g) => console.log(`  ${label.padEnd(12)} ${String(g.pauses).padStart(4)} pauses (${g.major} major) + ${g.steps} marking steps · ${g.totalMs} ms = ${g.pctOfTime}% of the time`
      + ` · longest ${g.maxMs} ms · dropped frames in a GC pause: ${g.droppedWithGc} of ${g.dropped}`);
    gcLine('overall', dump.gc.summary.overall);
    for (const seg of dump.gc.summary.segments) gcLine(seg.name, seg);
  }
  if (dump.atlasStalls?.overall.jobs) {
    // Spine atlases: a drop just before one arrives was the worker handing over its bitmap.
    console.log('\nSpine atlas jobs: a dropped frame in the 3 frames before one arrived · in its upload frame or the next:');
    const atlasLine = (label, a) => console.log(`  ${label.padEnd(12)} ${String(a.jobs).padStart(4)} jobs · before ${a.before} (chance ${a.chanceBefore}) · upload ${a.after} (chance ${a.chanceAfter})`);
    atlasLine('overall', dump.atlasStalls.overall);
    for (const seg of dump.atlasStalls.segments) if (seg.jobs) atlasLine(seg.name, seg);
  }
  if (dump.vrapiSummary) {
    const v = dump.vrapiSummary;
    console.log(`\nHeadset (VrApi, ${v.seconds} s): ${v.fpsAvg} fps avg (min ${v.fpsMin}, target ${v.fpsTarget}) · stale ${v.staleTotal}`
      + ` · app ${v.appMsAvg} ms · GPU ${v.gpuPctAvg}% · CPU ${v.cpuPctAvg}% · max ${v.tempCMax} °C`);
  }
  for (const snap of dump.snapshots || []) {
    console.log(`  ${snap.label.padEnd(12)} browser memory ${snap.memory.totalMB} MB · battery ${snap.battery.level}% ${snap.battery.tempC} °C`);
  }
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      open: { type: 'boolean' }, port: { type: 'string', default: '8080' }, only: { type: 'string' },
      'enter-vr': { type: 'boolean' }, 'allow-2d': { type: 'boolean' }, out: { type: 'string', default: path.join(ROOT, 'perf') },
      serial: { type: 'string' }, desktop: { type: 'boolean' }, 'no-gc': { type: 'boolean' }, 'no-prox': { type: 'boolean' },
      runs: { type: 'string', default: '3' }, to: { type: 'string' }, delay: { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (opts.help || !['status', 'dump', 'run', 'handover'].includes(command)) {
    console.log(HELP);
    process.exitCode = opts.help ? 0 : 1;
    return;
  }
  const useAdb = !opts.desktop;
  const pageUrl = `http://localhost:${opts.port}/?perf`;
  const dump = { tool: 'quest-perf', version: 1, command, startedAt: new Date().toISOString(), snapshots: [] };
  let release = async () => {};
  let logger = null;
  let gcTrace = null;
  let cdp = null;
  let proximityHeld = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    logger?.stop();
    cdp?.close();
    await release();
    if (proximityHeld) {
      await adb(opts, ...PROXIMITY.sensor).then(() => console.log('The proximity sensor is back in charge.'),
        (err) => console.warn(`Could not give the proximity sensor back (${err.message}): restart the headset, or run adb ${PROXIMITY.sensor.join(' ')}`));
    }
  };
  // Stopped with Ctrl+C: the desktop's window closed and the headset's sensor given back all the same.
  const onSigint = () => {
    console.log('\nStopping…');
    cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSigint);
  try {
    if (useAdb) {
      await chooseDevice(opts);
      dump.device = { serial: opts.serial, ...(await deviceInfo(opts)) };
      console.log(`Headset: ${dump.device.model} (${opts.serial}) · build ${dump.device.build} · Quest Browser ${dump.device.browser ?? '?'}`);
      if ((command === 'run' || command === 'handover') && !opts['no-prox']) {
        await adb(opts, ...PROXIMITY.worn);
        proximityHeld = true;
        console.log(`The headset acts as if worn (its proximity sensor overridden) until the ${command} ends.`);
      }
      if (opts.open) {
        await adb(opts, 'reverse', `tcp:${opts.port}`, `tcp:${opts.port}`);
        await adb(opts, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl);
        console.log(`Opened ${pageUrl} in the headset.`);
      }
    }
    let fwd;
    if (useAdb) fwd = await forwardDevtools(opts);
    else {
      // A window of its own: current Chrome opens its DevTools port only on a new profile, and
      // launchChrome writes that profile's Local State first, so Windows sees no failed logon. It
      // keeps drawing when other windows cover it (Chrome would count it hidden and stop its frames,
      // and the scenarios would wait), though not while minimized or with the screen locked.
      const chrome = await launchChrome({
        headless: false,
        url: pageUrl,
        args: ['--window-size=1280,800', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
      });
      console.log(`Opened ${pageUrl} in a Chrome window of its own (${chrome.endpoint}).`);
      fwd = { endpoint: chrome.endpoint, release: () => chrome.close() };
    }
    release = fwd.release;
    const opened = opts.open || !useAdb;
    // Scenario progress from the page; a memory snapshot at the end of each scenario.
    const attach = async (c) => {
      await c.send('Runtime.enable');
      c.on('Runtime.consoleAPICalled', (e) => {
        const text = e.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (!text.startsWith('[perf]')) return;
        console.log(text);
        const end = text.match(/^\[perf\] end (\S+)/);
        if (end && useAdb) snapshot(opts, end[1]).then((s) => dump.snapshots.push(s));
      });
      return c;
    };
    ({ cdp } = await connectPage(fwd.endpoint, { waitMs: opened ? 60000 : 0, prefer: opened ? pageUrl : null }));
    if (command === 'handover') return await handover(cdp, opts);
    await attach(cdp);

    // Whether the page records (?perf) and runs the code the server has now: a page opened before
    // the last change would measure the old version.
    const pageState = () => cdp.eval(`(async () => {
      const v = window.__vrlbry;
      const server = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      return { url: location.href, perf: !!v.perf?.enabled, presenting: !!v.renderer.xr.isPresenting, loaded: v.version ?? null, current: server?.changed ?? null };
    })()`);
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown');
    let state = await pageState();
    const isStale = (st) => !!st.current && st.loaded !== st.current;
    const stale = isStale(state);
    const describe = (s) => `Page: ${s.url}${s.presenting ? ' (in VR)' : ''} · ${s.perf ? 'recording' : 'not recording'}`
      + ` · version ${when(s.loaded)}${isStale(s) ? ` (older than the server's ${when(s.current)}: reload it)` : ''}`;

    if (command === 'status') {
      console.log(describe(state));
      if (state.perf) console.log(await cdp.eval('JSON.stringify(window.__vrlbry.perf.summary().overall)'));
      return;
    }
    if (command === 'dump') {
      if (!state.perf) throw new Error('the page is not recording: open it with ?perf (or use run --open)');
      if (stale) console.warn(`Note: the page runs an older version (${when(state.loaded)}) than the server has (${when(state.current)}).`);
    }
    if (command === 'run' && (!state.perf || stale)) {
      const url = new URL(state.url);
      url.searchParams.set('perf', '');
      console.log(!state.perf ? `Reloading the page with ?perf: ${url}`
        : `The page runs an older version (${when(state.loaded)}; the server has ${when(state.current)}): reloading ${url}`);
      await cdp.eval(`location.replace(${JSON.stringify(url.href)})`).catch(() => {});
      cdp.close();
      await sleep(2000);
      ({ cdp } = await connectPage(fwd.endpoint, { waitMs: 60000 }));
      await attach(cdp);
      await waitFor(() => cdp.eval('!!window.__vrlbry?.perf?.enabled'), 60000, 'the page to load');
      await waitFor(() => cdp.eval('window.__vrlbry.version !== null'), 15000, 'the page version').catch(() => {});
      state = await pageState();
    }
    console.log(describe(state));

    if (command === 'run') {
      if (!state.presenting && useAdb && !opts['allow-2d']) {
        if (opts['enter-vr']) await cdp.eval('window.__vrlbry.enterVR()', { userGesture: true }).catch(() => {});
        if (!(await cdp.eval('window.__vrlbry.renderer.xr.isPresenting'))) {
          console.log('Waiting for VR: put the headset on and press Enter VR (up to 3 minutes)…');
        }
        await waitFor(() => cdp.eval('window.__vrlbry.renderer.xr.isPresenting'), 180000, 'Enter VR');
        await sleep(3000); // let the session settle
      }
      if (useAdb) {
        dump.snapshots.push(await snapshot(opts, 'start'));
        logger = vrApiLogger(opts);
      }
      const only = opts.only ? JSON.stringify(opts.only.split(',').map((s) => s.trim())) : 'null';
      console.log('Running scenarios…');
      gcTrace = opts['no-gc'] ? null : await startGcTrace(cdp);
      await cdp.eval(`(async () => { const p = window.__vrlbry.perf; p.reset(); return p.run(${only}); })()`);
    }

    console.log('Collecting the dump…');
    const pauses = await gcTrace?.stop();
    dump.page = await cdp.eval('window.__vrlbry.perf.dump()');
    if (pauses) dump.gc = { pauses, summary: summarizeGc(pauses, dump.page) };
    dump.atlasStalls = atlasStalls(dump.page);
    if (useAdb) {
      dump.vrapi = logger ? logger.stop() : await vrApiBacklog(opts);
      logger = null;
      dump.vrapiSummary = summarizeVrApi(dump.vrapi);
      dump.snapshots.push(await snapshot(opts, 'end'));
    }
    dump.finishedAt = new Date().toISOString();
    fs.mkdirSync(opts.out, { recursive: true });
    const file = path.join(opts.out, `quest-${dump.startedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}.json`);
    fs.writeFileSync(file, JSON.stringify(dump));
    printSummary(dump);
    const shown = path.relative(process.cwd(), file);
    console.log(`\nSaved ${shown.startsWith('..') ? file : shown} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`quest-perf: ${err.message}`);
    process.exitCode = 1;
  });
}
