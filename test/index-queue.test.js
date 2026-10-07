// IndexQueue: big archives' index builds one at a time, the smallest first; small ones at once.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IndexQueue } from '../public/js/core/util/index-queue.js';

/** A task that records its start and end, and finishes when `finish()` is called. */
function gate(name, events) {
  let finish;
  const done = new Promise((r) => { finish = r; });
  return {
    finish: (v = name) => finish(v),
    task: async () => {
      events.push(`start ${name}`);
      const v = await done;
      events.push(`end ${name}`);
      return v;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('IndexQueue', () => {
  it('runs big builds one at a time, the smallest waiting one next', async () => {
    const q = new IndexQueue({ smallBytes: 10 });
    const events = [];
    const a = gate('a', events);
    const b = gate('b', events);
    const c = gate('c', events);
    const ra = q.run(500, a.task);
    const rb = q.run(300, b.task);
    const rc = q.run(100, c.task);
    await tick();
    assert.deepEqual(events, ['start a'], 'the first starts at once, the others wait');
    assert.equal(q.waiting, 2);
    a.finish();
    assert.equal(await ra, 'a');
    await tick();
    assert.deepEqual(events, ['start a', 'end a', 'start c'], 'then the smallest waiting');
    c.finish();
    await rc;
    await tick();
    b.finish();
    await rb;
    assert.deepEqual(events, ['start a', 'end a', 'start c', 'end c', 'start b', 'end b']);
  });

  it('starts small builds at once, beside a big one', async () => {
    const q = new IndexQueue({ smallBytes: 10 });
    const events = [];
    const big = gate('big', events);
    const small = gate('small', events);
    q.run(500, big.task);
    const rs = q.run(5, small.task);
    await tick();
    assert.deepEqual(events, ['start big', 'start small']);
    assert.equal(q.queues(5), false);
    assert.equal(q.queues(500), true);
    small.finish();
    await rs;
    big.finish();
  });

  it('holds builds while a scan opens archives, then runs the smallest first', async () => {
    const q = new IndexQueue({ smallBytes: 0 });
    const events = [];
    const a = gate('a', events);
    const b = gate('b', events);
    q.hold();
    const ra = q.run(900, a.task);
    const rb = q.run(200, b.task);
    await tick();
    assert.deepEqual(events, [], 'nothing starts while held');
    q.release();
    await tick();
    assert.deepEqual(events, ['start b']);
    b.finish();
    await rb;
    await tick();
    a.finish();
    await ra;
    assert.deepEqual(events, ['start b', 'end b', 'start a', 'end a']);
  });

  it('goes on after a failed build, and skips a cancelled one', async () => {
    const q = new IndexQueue({ smallBytes: 0 });
    const events = [];
    const ok = gate('ok', events);
    let closed = false;
    const failing = q.run(100, async () => { events.push('start failing'); throw new Error('boom'); });
    const skipped = q.run(200, async () => { events.push('start skipped'); }, { cancelled: () => closed });
    const rok = q.run(300, ok.task);
    closed = true;
    await assert.rejects(failing, /boom/);
    await assert.rejects(skipped, /cancelled/);
    await tick();
    ok.finish();
    assert.equal(await rok, 'ok');
    assert.deepEqual(events, ['start failing', 'start ok', 'end ok']);
  });
});
