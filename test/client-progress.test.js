import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progressText, timeLeft } from '../public/js/util/progress.js';

describe('progress indicators: time so far and left (util/progress.js)', () => {
  it('estimates nothing until enough is known', () => {
    assert.equal(timeLeft(5000, null), '');
    assert.equal(timeLeft(5000, 0), '');
    assert.equal(timeLeft(5000, 0.02), '', 'under 3 % done');
    assert.equal(timeLeft(1000, 0.5), '', 'under 1.5 s so far');
    assert.equal(timeLeft(5000, 1), '', 'done');
  });

  it('rounds the estimate up, coarser the longer it is', () => {
    assert.equal(timeLeft(2000, 0.5), 'about 2 s left');
    assert.equal(timeLeft(10000, 0.5), 'about 10 s left');
    assert.equal(timeLeft(10000, 0.25), 'about 30 s left');
    assert.equal(timeLeft(10000, 0.24), 'about 35 s left', '31.7 s, to the next 5 s');
    assert.equal(timeLeft(30000, 0.2), 'about 2 min left');
    assert.equal(timeLeft(60000, 0.5), 'about 1 min left');
    assert.equal(timeLeft(60000, 0.01 + 0.02), 'about 33 min left');
    assert.equal(timeLeft(600000, 0.1), 'about 1 h 30 min left');
    assert.equal(timeLeft(3600000, 0.5), 'about 1 h left');
  });

  it('writes the indicator text: the seconds so far, then the estimate', () => {
    assert.equal(progressText(400, null), '', 'the first second');
    assert.equal(progressText(1200, null), ' · 1 s');
    assert.equal(progressText(12500, null), ' · 12 s', 'no fraction: no estimate');
    assert.equal(progressText(12500, 0.25), ' · 12 s · about 40 s left');
    assert.equal(progressText(12500, 1), ' · 12 s');
  });
});
