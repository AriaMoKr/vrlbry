// The local library's opening loop (public/js/local/local.js openEach): files one after another, or
// several at once (the site's own ZIM files), with the results in the list's order, progress as the
// average of each file's, and Stop and failures as before.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openEach } from '../public/js/local/local.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** An opener that takes `ms[i]` per file, reports half-way, and counts how many run at once. */
function opener(ms, { failAt = -1 } = {}) {
  const state = { running: 0, most: 0, order: [] };
  const open = async (file, i, progress) => {
    state.running++;
    state.most = Math.max(state.most, state.running);
    state.order.push(`start ${i}`);
    await new Promise((r) => setTimeout(r, ms[i] / 2));
    progress(0.5);
    await new Promise((r) => setTimeout(r, ms[i] / 2));
    state.running--;
    state.order.push(`end ${i}`);
    if (i === failAt) throw new Error(`file ${i} is broken`);
    return { id: `~${file}`, title: file };
  };
  return { open, state };
}

describe('local library: opening several files (openEach)', () => {
  it('opens one after another by default', async () => {
    const { open, state } = opener([20, 10, 10]);
    const results = await openEach(['a.zim', 'b.zim', 'c.zim'], open);
    assert.equal(state.most, 1);
    assert.deepEqual(state.order, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    assert.deepEqual(results.map((r) => r.id), ['~a.zim', '~b.zim', '~c.zim']);
  });

  it('opens them at once with a concurrency, the results still in the list\'s order', async () => {
    const { open, state } = opener([40, 10, 20]);
    const progress = [];
    const opened = [];
    const t = performance.now();
    const results = await openEach(['https://site.example/zims/a.zim', 'https://site.example/zims/b.zim', 'https://site.example/zims/c.zim'], open, {
      concurrency: 3, onProgress: (f) => progress.push(f), onOpened: (r) => opened.push(r.title),
    });
    assert.equal(state.most, 3, 'all three at once');
    assert.ok(performance.now() - t < 40 + 30, 'as long as the slowest, not the sum');
    assert.deepEqual(results.map((r) => r.name), ['a.zim', 'b.zim', 'c.zim'], 'in the list\'s order');
    assert.deepEqual(opened, ['https://site.example/zims/b.zim', 'https://site.example/zims/c.zim', 'https://site.example/zims/a.zim'],
      'each as soon as it is open');
    assert.ok(progress.every((f, i) => i === 0 || f >= progress[i - 1]), 'progress never goes back');
    assert.ok(progress.at(-1) > 0.5 && progress.at(-1) <= 1);
  });

  it('keeps to its concurrency, and keeps Stop and failures per file', async () => {
    const { open, state } = opener([10, 10, 10, 10, 10], { failAt: 1 });
    let stop = false;
    const results = await openEach(['a.zim', 'b.zim', 'c.zim', 'd.zim', 'e.zim'], open, {
      concurrency: 2,
      onOpened: (r) => { if (r.title === 'c.zim') stop = true; },
      stopped: () => stop,
    });
    assert.equal(state.most, 2);
    assert.match(results[1].error, /file 1 is broken/);
    assert.equal(results[0].id, '~a.zim');
    assert.equal(results[2].id, '~c.zim');
    assert.ok(results.slice(3).some((r) => r.skipped), 'none started once stopped');
    await tick();
  });
});
