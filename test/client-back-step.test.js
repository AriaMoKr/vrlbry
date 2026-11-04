// One step back on a TV's remote (public/js/back-step.js): from what is open, the latest first, and
// the book's history entries left to the app's own Back, so that Back takes one step, not two.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backStep } from '../public/js/back-step.js';

describe('Back, one step at a time', () => {
  it('has none to take while walking the room: the app goes back a page', () => {
    assert.equal(backStep({ state: 'browse' }), null);
    assert.equal(backStep({ state: 'browse', typing: true }), 'typing', 'typing on the stand stops first');
  });

  it('closes the contents, goes back along the links, then puts the book back', () => {
    const open = { state: 'read', entry: false, level: 0 };
    assert.equal(backStep({ ...open, toc: true, trail: 2 }), 'toc');
    assert.equal(backStep({ ...open, trail: 2 }), 'link');
    assert.equal(backStep({ ...open }), 'away');
    assert.equal(backStep({ state: 'inspect' }), 'away', 'a book in hand');
    assert.equal(backStep({ state: 'opening' }), 'away', 'one being opened: its opening stops, and it goes back');
    assert.equal(backStep({ state: 'busy' }), 'away', 'one on its way: put away once it is there');
  });

  it('leaves the book and its links to the app when their history entries are there', () => {
    // A book taken out after a key press: its entry, and each link's, is the app's Back.
    assert.equal(backStep({ state: 'inspect', entry: true, level: 1 }), 'history');
    assert.equal(backStep({ state: 'read', entry: true, level: 1 }), 'history');
    assert.equal(backStep({ state: 'read', entry: true, level: 3, trail: 2 }), 'history');
    assert.equal(backStep({ state: 'busy', entry: true, level: 1 }), 'history', 'coming out');
    // The contents have no entry: a step of their own.
    assert.equal(backStep({ state: 'read', entry: true, level: 3, trail: 2, toc: true }), 'toc');
    // Its entries taken back out (put away by a step, or by the app's Back): the step waits for it.
    assert.equal(backStep({ state: 'busy', entry: true, level: 0 }), 'away');
  });

  it('puts back a book whose entry the app would pass over', () => {
    // Taken out with a gamepad alone, on a page nobody pressed a key on: Back would leave the page.
    assert.equal(backStep({ state: 'read', entry: false, level: 1 }), 'away');
    assert.equal(backStep({ state: 'read', entry: false, level: 2, trail: 1 }), 'link');
  });

  it('in the text view: its contents, the links followed there, then the view itself', () => {
    const text = { state: 'read', textView: true };
    assert.equal(backStep({ ...text, textToc: true, trail: 1, entry: true, level: 2 }), 'text-toc');
    assert.equal(backStep({ ...text, trail: 1, entry: true, level: 2 }), 'history');
    assert.equal(backStep({ ...text, trail: 1, entry: false, level: 2 }), 'link');
    assert.equal(backStep({ ...text, entry: true, level: 1 }), 'text', 'then the 3D book again, before it is put back');
    assert.equal(backStep({ ...text, toc: true }), 'text', 'the 3D contents behind it wait');
  });
});
