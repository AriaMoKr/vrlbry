// The shared session: its pure parts (public/js/together-space.js: where in the library a visitor
// is, and the session in words), and the library's own over layersharedsession's controller
// (public/js/together.js), with a stand-in for its session module: who is here (the same room of
// the library), elsewhere in it or away, and what is said.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { createBuffer, emptyPose, PART, pushSample, setPart } from 'layersharedsession/pose.js';
import './helpers/vendor.js';
import { DOOR_ID } from '../public/js/config.js';
import { APP_ID, companyText, noticeText, PAGE_ID, sessionText, spaceKey, spaceOf } from '../public/js/together-space.js';

describe('the shared session', () => {
  it('is the Hallway\'s, with this page as its door', () => {
    assert.equal(APP_ID, 'ariamokr-layersharedsession-test');
    assert.equal(PAGE_ID, DOOR_ID, 'the page is its door (config.js)');
    // layersharedsession takes keys of at most 64 characters, and page ids of [a-z0-9-].
    assert.equal(spaceKey('u8yhkfn3h6as'), `${DOOR_ID}.space.u8yhkfn3h6as`);
    assert.ok(`${'x'.repeat(32)}.space.u8yhkfn3h6as`.length <= 64, 'the longest page id too');
    assert.match(PAGE_ID, /^[a-z0-9-]{1,32}$/);
  });

  it('tells rooms of the library apart: place, genre, letter and page', () => {
    assert.equal(spaceOf('demo'), spaceOf('demo', null));
    assert.equal(spaceOf('demo', { genre: null, letter: null }), spaceOf('demo'));
    assert.equal(spaceOf('demo', { page: 0 }), spaceOf('demo'));
    const rooms = [
      spaceOf('demo'), spaceOf('*'), spaceOf('~gutenberg_en_all_2025-11'),
      spaceOf('wikisource_en_all_maxi_2026-09', { genre: 'Poetry' }),
      spaceOf('wikisource_en_all_maxi_2026-09', { letter: 'A' }),
      spaceOf('wikisource_en_all_maxi_2026-09', { genre: 'Poetry', letter: 'A' }),
      spaceOf('wikisource_en_all_maxi_2026-09', { genre: 'Poetry', letter: 'A', page: 1 }),
      spaceOf(null),
    ];
    assert.equal(new Set(rooms).size, rooms.length);
  });

  it('says who else is in it, and what they did', () => {
    assert.equal(companyText({}), 'Just you so far');
    assert.equal(companyText({ here: 2 }), 'With you: 2 here');
    assert.equal(companyText({ here: 1, nearby: 1, away: 3, connecting: 2 }), 'With you: 1 here, 1 elsewhere in the library, 3 in another place');
    assert.equal(companyText({ away: 1 }), 'With you: 1 in another place');
    assert.equal(sessionText({ room: null, active: false }), '');
    assert.equal(sessionText({ room: 'k3vd-q8hn', active: true, company: { here: 1 } }), 'Shared session k3vd-q8hn · With you: 1 here');
    assert.equal(sessionText({ room: 'k3vd-q8hn', active: false }), 'Shared session k3vd-q8hn', 'paused, going out by the door');
    const ada = { name: 'Ada', page: PAGE_ID };
    assert.equal(noticeText({ kind: 'join', peer: ada }), 'Ada is in the library');
    assert.equal(noticeText({ kind: 'join', peer: { name: 'Ben', page: 'hallway' } }), 'Ben is in the session');
    assert.equal(noticeText({ kind: 'arrive', peer: ada, from: 'hallway' }), 'Ada came into the library');
    assert.equal(noticeText({ kind: 'leave', peer: { name: null } }), 'Someone left the session');
    assert.equal(noticeText({ kind: 'wave', peer: ada }), 'Ada waved');
  });
});

// ---------------------------------------------------------------------------------------------
// The library's session over the layer's controller

const store = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)) };
};
globalThis.document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({ measureText: (text) => ({ width: text.length * 20 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }),
};
globalThis.window ??= { sessionStorage: store(), localStorage: store() };
globalThis.location ??= { href: 'https://example.test/vrlbry/?place=demo' };
globalThis.history ??= { state: null, replaceState(state, _title, href) { this.state = state; location.href = href; } };

const { Together } = await import('../public/js/together.js');

/** A pose buffer with a head in it, so that the avatar can be placed. */
function posed(buffer) {
  const pose = emptyPose();
  setPart(pose, PART.head, new THREE.Vector3(1, 1.6, 1), new THREE.Quaternion());
  pushSample(buffer, 0, pose);
  return buffer;
}

/** The layer's session module's stand-in: what it was told, and the others played. */
function standIn(o) {
  const listeners = new Map();
  const s = {
    o,
    self: { memberId: o.identity.memberId, name: o.identity.name, page: o.page },
    peers: new Map(),
    relays: { open: 1, total: 3 },
    shared: new Map(),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, detail) { for (const fn of listeners.get(type) ?? []) fn(detail); },
    channel: () => ({ send() {}, on: () => () => {} }),
    setPose() {},
    tick() {},
    get: (key) => s.shared.get(key),
    set: (key, value) => void s.shared.set(key, value),
    leave: () => Promise.resolve(),
    /** Another visitor's hello: on `page`, standing in `space` (their shared value). */
    hello(peerId, page, space, name = `Name ${peerId}`) {
      const first = !s.peers.has(peerId);
      const p = s.peers.get(peerId) ?? { peerId, rtt: null, buffer: posed(createBuffer()) };
      Object.assign(p, { memberId: `member${peerId}`, name, color: '#3366cc', page });
      s.peers.set(peerId, p);
      if (space !== undefined) s.shared.set(spaceKey(p.memberId), space);
      s.emit(first ? 'join' : 'update', p);
      return p;
    },
  };
  return s;
}

/** A session of the library's, joined in `room`, standing in `space`. */
async function joined(space) {
  let session = null;
  const notices = [];
  let changes = 0;
  const t = new Together({ scene: new THREE.Scene(), camera: null, renderer: null, hands: null, joinSession: (o) => (session = standIn(o)) });
  t.onNotice = (text) => notices.push(text);
  t.onChange = () => changes++;
  t.setSpace(space);
  t.start('k3vd-q8hn');
  await new Promise((resolve) => setImmediate(resolve));
  return { t, s: session, notices, changes: () => changes };
}

describe('the library\'s shared session', () => {
  const poetry = spaceOf('wikisource_en_all_maxi_2026-09', { genre: 'Poetry' });
  const novels = spaceOf('wikisource_en_all_maxi_2026-09', { genre: 'Novels' });

  it('joins as this library\'s page and tells the others where in it this visitor is', async () => {
    const { t, s } = await joined(poetry);
    assert.equal(s.o.appId, APP_ID);
    assert.equal(s.o.page, PAGE_ID);
    assert.equal(s.get(spaceKey(s.self.memberId)), poetry, 'its space, on joining');
    t.setSpace(novels);
    assert.equal(s.get(spaceKey(s.self.memberId)), novels, 'and when it moves');
    s.self.memberId = 'replaced';
    s.emit('self', s.self);
    assert.equal(s.get(spaceKey('replaced')), novels, 'and under a member id replaced (another tab had it)');
    await t.stop();
  });

  it('counts those in its room here, the rest of the library nearby, other pages away, and draws only those here', async () => {
    const { t, s } = await joined(poetry);
    s.hello('a', PAGE_ID, poetry);
    s.hello('b', PAGE_ID, novels);
    s.hello('c', 'hallway');
    assert.deepEqual(t.company(), { here: 1, nearby: 1, away: 1, connecting: 0 });
    t.update(0);
    const shown = (id) => t.layer.avatars.get(id).group.visible;
    assert.deepEqual([shown('a'), shown('b')], [true, false], 'in the same room drawn, elsewhere not');
    s.shared.set(spaceKey('memberb'), poetry); // b walks into this room
    t.update(16);
    assert.deepEqual(t.company(), { here: 2, nearby: 0, away: 1, connecting: 0 });
    assert.equal(shown('b'), true);
    t.setSpace(novels); // and this visitor into another
    t.update(32);
    assert.deepEqual(t.company(), { here: 0, nearby: 2, away: 1, connecting: 0 });
    assert.deepEqual([shown('a'), shown('b')], [false, false]);
    await t.stop();
  });

  it('says who came and went, and redraws when someone moves between rooms', async () => {
    const { t, s, notices, changes } = await joined(poetry);
    s.hello('a', PAGE_ID, poetry, 'Ada');
    s.hello('c', 'hallway', undefined, 'Cy');
    s.hello('c', PAGE_ID, novels, 'Cy');
    assert.deepEqual(notices, ['Ada is in the library', 'Cy is in the session', 'Cy came into the library']);
    const before = changes();
    s.emit('shared', { key: spaceKey('membera'), value: novels });
    assert.equal(changes(), before + 1, 'a space changed: redrawn');
    s.emit('shared', { key: 'other.key', value: 1 });
    assert.equal(changes(), before + 1, 'other shared values: not');
    await t.stop();
  });
});
