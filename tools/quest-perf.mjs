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

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'com.oculus.browser';

const HELP = `Usage: node tools/quest-perf.mjs <command> [options]

Commands:
  status   check adb, the headset and the vrlbry page
  dump     save what the page has recorded so far (use vrlbry with ?perf first)
  run      run the built-in scenarios in the page, then save the dump

Options:
  --open           open http://localhost:<port>/?perf in Quest Browser first (sets up adb reverse)
  --port <n>       the vrlbry server's local HTTP port for --open (default 8080)
  --only <a,b,…>   run only these scenarios (small-idle, room-walk, filters, all-enter, all-idle,
                   all-walk, read)
  --enter-vr       try to start the immersive session from here instead of waiting for you
  --allow-2d       run the scenarios even when the page is not in VR
  --out <dir>      where to write the dump (default perf/)
  --serial <id>    adb device serial, when several devices are connected
  --cdp <url>      use this DevTools endpoint instead of the headset (e.g. http://127.0.0.1:9222
                   for a desktop browser started with --remote-debugging-port); skips adb
  -h, --help       this help

The headset must be connected (USB or adb over Wi-Fi) with USB debugging allowed for this PC.
The scenarios move you around the library (smooth gliding along aisles): wearing the headset is
optional; the proximity sensor must think it is worn for the session to keep rendering.`;

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

/** Connects to the open vrlbry page (the one defining window.__vrlbry), waiting up to `waitMs`. */
async function connectPage(endpoint, { waitMs = 0 } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    for (const page of await listPages(endpoint).catch(() => [])) {
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
      serial: { type: 'string' }, cdp: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (opts.help || !['status', 'dump', 'run'].includes(command)) {
    console.log(HELP);
    process.exitCode = opts.help ? 0 : 1;
    return;
  }
  const useAdb = !opts.cdp;
  const dump = { tool: 'quest-perf', version: 1, command, startedAt: new Date().toISOString(), snapshots: [] };
  let release = async () => {};
  let logger = null;
  let cdp = null;
  try {
    if (useAdb) {
      await chooseDevice(opts);
      dump.device = { serial: opts.serial, ...(await deviceInfo(opts)) };
      console.log(`Headset: ${dump.device.model} (${opts.serial}) · build ${dump.device.build} · Quest Browser ${dump.device.browser ?? '?'}`);
      if (opts.open) {
        await adb(opts, 'reverse', `tcp:${opts.port}`, `tcp:${opts.port}`);
        await adb(opts, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${opts.port}/?perf`);
        console.log(`Opened http://localhost:${opts.port}/?perf in the headset.`);
      }
    }
    const fwd = useAdb ? await forwardDevtools(opts) : { endpoint: opts.cdp.replace(/\/$/, ''), release: async () => {} };
    release = fwd.release;
    ({ cdp } = await connectPage(fwd.endpoint, { waitMs: opts.open ? 60000 : 0 }));
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (e) => {
      const text = e.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (!text.startsWith('[perf]')) return;
      console.log(text);
      const end = text.match(/^\[perf\] end (\S+)/);
      if (end && useAdb) snapshot(opts, end[1]).then((s) => dump.snapshots.push(s));
    });

    let state = await cdp.eval(`(() => { const v = window.__vrlbry; return { url: location.href, perf: !!v.perf?.enabled, presenting: !!v.renderer.xr.isPresenting, place: v.settings.place }; })()`);
    if (!state.perf && command === 'status') {
      console.log(`Page: ${state.url}${state.presenting ? ' (in VR)' : ''} · not recording (open it with ?perf, or use run)`);
      return;
    }
    if (!state.perf) {
      if (command === 'dump') throw new Error('the page is not recording: open it with ?perf (or use run --open)');
      const url = new URL(state.url);
      url.searchParams.set('perf', '');
      console.log(`Reloading the page with ?perf: ${url}`);
      await cdp.eval(`location.replace(${JSON.stringify(url.href)})`).catch(() => {});
      cdp.close();
      await sleep(2000);
      ({ cdp } = await connectPage(fwd.endpoint, { waitMs: 60000 }));
      await cdp.send('Runtime.enable');
      await waitFor(() => cdp.eval('!!window.__vrlbry?.perf?.enabled'), 60000, 'the page to load');
      state = await cdp.eval(`({ url: location.href, perf: true, presenting: !!window.__vrlbry.renderer.xr.isPresenting })`);
    }
    console.log(`Page: ${state.url}${state.presenting ? ' (in VR)' : ''}`);

    if (command === 'status') {
      console.log(await cdp.eval('JSON.stringify(window.__vrlbry.perf.summary().overall)'));
      return;
    }

    if (command === 'run') {
      if (!state.presenting && !opts['allow-2d']) {
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
      await cdp.eval(`(async () => { const p = window.__vrlbry.perf; p.reset(); return p.run(${only}); })()`);
    }

    console.log('Collecting the dump…');
    dump.page = await cdp.eval('window.__vrlbry.perf.dump()');
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
    logger?.stop();
    cdp?.close();
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`quest-perf: ${err.message}`);
    process.exitCode = 1;
  });
}
