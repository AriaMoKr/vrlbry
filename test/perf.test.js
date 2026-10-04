// The ?perf recorder (public/js/perf.js) and the parsers of tools/quest-perf.mjs, in Node.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Recorder, MAX_FRAMES } from '../public/js/perf.js';
import {
  devtoolsSockets, parseVrApiLine, parseMeminfo, parseBattery, summarizeVrApi, parseAdbDevices, isNetworkSerial,
} from '../tools/quest-perf.mjs';

const HZ72 = 1000 / 72;

/** Feeds frames with the given intervals (ms), each starting now. */
function feed(rec, intervals, time = { now: 0 }) {
  for (const iv of intervals) {
    time.now += iv;
    rec.afterFrame(time.now, performance.now(), { calls: 120, triangles: 5000 });
  }
  return time;
}

describe('perf recorder', () => {
  it('records nothing while off', () => {
    const rec = new Recorder();
    rec.event('rebuild', { ms: 5 });
    rec.begin('x');
    assert.equal(rec.enabled, false);
    assert.equal(rec.events, undefined);
  });

  it('counts dropped frames against the display interval, per segment', () => {
    const rec = new Recorder();
    rec.start();
    try {
      const time = feed(rec, [HZ72]); // the first frame has no interval
      rec.begin('smooth');
      feed(rec, Array(72).fill(HZ72), time);
      rec.begin('janky'); // closes "smooth"
      feed(rec, [...Array(60).fill(HZ72), 3 * HZ72, 3 * HZ72, 10 * HZ72], time); // 2 + 2 + 9 frames missed
      rec.end();
      const s = rec.summary();
      assert.equal(Math.round(s.expectedIntervalMs * 100) / 100, Math.round(HZ72 * 100) / 100, 'median interval');
      const [smooth, janky] = s.segments;
      assert.equal(smooth.name, 'smooth');
      assert.equal(smooth.dropped, 0);
      assert.equal(smooth.frames, 72);
      assert.equal(janky.dropped, 13);
      assert.equal(janky.intervalMs.max, Math.round(10 * HZ72 * 100) / 100);
      assert.equal(janky.drawCalls.max, 120);
      assert.equal(s.overall.dropped, 13);
      assert.ok(s.overall.costMs.p50 >= 0);
    } finally {
      rec.stop();
    }
  });

  it('keeps timed events and finds the worst frame gap inside a rebuild', () => {
    const rec = new Recorder();
    rec.start();
    try {
      const t0 = performance.now();
      feed(rec, [HZ72, HZ72, 400, HZ72]);
      rec.event('rebuild', { t: t0, ms: performance.now() - t0 + 1, place: 'ws', bookcases: 26 });
      rec.event('atlas', { ms: 12, level: 'mid' });
      rec.event('atlas', { ms: 30, level: 'high' });
      const s = rec.summary();
      assert.equal(s.rebuilds.length, 1);
      assert.equal(s.rebuilds[0].place, 'ws');
      assert.equal(s.rebuilds[0].worstGapMs, 400);
      assert.deepEqual({ count: s.events.atlas.count, max: s.events.atlas.msMax }, { count: 2, max: 30 });
      const d = rec.dump();
      assert.equal(d.frames.interval.length, 4);
      assert.equal(d.events.length, 3);
      JSON.stringify(d); // plain JSON
    } finally {
      rec.stop();
    }
  });

  it('is a ring buffer: the newest frames, in order', () => {
    const rec = new Recorder();
    rec.start();
    try {
      feed(rec, Array(MAX_FRAMES + 500).fill(HZ72));
      const fr = rec.frames();
      assert.equal(fr.length, MAX_FRAMES);
      for (let i = 1; i < 1000; i++) assert.ok(fr[i].t >= fr[i - 1].t);
      assert.equal(rec.summary().overall.frames, MAX_FRAMES);
    } finally {
      rec.stop();
    }
  });

  it('runs frame hooks until they are removed', () => {
    const rec = new Recorder();
    const seen = [];
    const off = rec.addHook((dt) => seen.push(dt));
    rec.beforeFrame(0.01);
    off();
    rec.beforeFrame(0.02);
    assert.deepEqual(seen, [0.01]);
  });
});

describe('quest-perf parsers', () => {
  it('finds the browser DevTools socket', () => {
    const unix = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4242',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12346 @chrome_devtools_remote',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12347 /dev/socket/zygote',
    ].join('\n');
    assert.deepEqual(devtoolsSockets(unix), ['chrome_devtools_remote', 'webview_devtools_remote_4242']);
    assert.deepEqual(devtoolsSockets('nothing here'), []);
  });

  it('parses VrApi per-second lines', () => {
    const line = '1759561200.123  1234  1250 I VrApi   : FPS=71/72,Prd=45ms,Tear=0,Early=0,Stale=1,Stale2/5/10/max=0/0/0/0,VSnc=1,'
      + 'Lat=-1,Fov=0D,CPU4/GPU=3/3,1478/525MHz,OC=FF,TA=0/0/0,SP=N/N/N,Mem=1804MHz,Free=2836MB,PLS=0,Temp=31.0C/0.0C,'
      + 'TW=1.64ms,App=6.31ms,GD=0.00ms,CPU&GPU=8.94ms,LCnt=1(DR72,LM0),GPU%=0.47,CPU%=0.24(W0.27),DSF=1.00';
    const s = parseVrApiLine(line);
    assert.equal(s.t, 1759561200.123);
    assert.equal(s.fps, 71);
    assert.equal(s.fpsTarget, 72);
    assert.equal(s.stale, 1);
    assert.equal(s.appMs, 6.31);
    assert.equal(s.gpuPct, 47);
    assert.equal(s.cpuPct, 24);
    assert.equal(s.tempC, 31);
    assert.equal(s.freeMB, 2836);
    assert.equal(s.levels, '3/3');
    assert.equal(parseVrApiLine('I VrApi   : some other message'), null);
    const v = summarizeVrApi([s, { ...s, fps: 72, stale: 0, tempC: 33 }]);
    assert.deepEqual([v.seconds, v.fpsAvg, v.fpsMin, v.staleTotal, v.tempCMax], [2, 71.5, 71, 1, 33]);
    assert.equal(summarizeVrApi([]), null);
  });

  it('sums the browser processes in dumpsys meminfo', () => {
    const text = `Applications Memory Usage (in Kilobytes):

Total RSS by process:
    812,345K: com.oculus.browser:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0 (pid 4242)
    401,000K: com.oculus.browser (pid 4000 / activities)
    300,000K: com.oculus.vrshell (pid 1200)
     99,999K: com.oculus.browser:privileged_process0 (pid 4100)

Total RSS by OOM adjustment:
    999,999K: com.oculus.browser (pid 4000)
`;
    const m = parseMeminfo(text);
    assert.equal(Object.keys(m.processes).length, 3);
    assert.equal(m.totalMB, Math.round((812345 + 401000 + 99999) / 102.4) / 10);
  });

  it('lists adb devices from Windows output (CRLF), with their state', () => {
    const out = 'List of devices attached\r\n2G0YC1ZG3P071X\tdevice\r\n192.168.50.176:5555\tdevice\r\nABC\tunauthorized\r\n\r\n';
    assert.deepEqual(parseAdbDevices(out), [
      { serial: '2G0YC1ZG3P071X', state: 'device' }, { serial: '192.168.50.176:5555', state: 'device' }, { serial: 'ABC', state: 'unauthorized' },
    ]);
    assert.deepEqual(parseAdbDevices('List of devices attached\n\n'), []);
    assert.equal(isNetworkSerial('192.168.50.176:5555'), true);
    assert.equal(isNetworkSerial('adb-2G0YC1ZG3P071X-abc._adb-tls-connect._tcp'), true);
    assert.equal(isNetworkSerial('2G0YC1ZG3P071X'), false);
  });

  it('reads the battery level and temperature', () => {
    assert.deepEqual(parseBattery('Current Battery Service state:\n  AC powered: false\n  level: 87\n  temperature: 312\n'), { level: 87, tempC: 31.2 });
  });
});
