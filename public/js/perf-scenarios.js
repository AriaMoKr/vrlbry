// Built-in performance scenarios (?perf), started by tools/quest-perf.mjs through
// window.__vrlbry.perf.run(). Each one is a recorder segment, so the dump breaks the numbers down
// per scenario. They drive the real app: room switches, walking (the rig glides along aisles),
// filter changes, reading, and the largest Wikipedia room. Settings are restored afterwards.

import { perf } from './perf.js';
import { facetsOf, isFaceted, ALL_PLACE } from './rooms.js';
import { BOOKCASE } from './config.js';
import { save } from './util/storage.js';

export const SCENARIOS = ['small-idle', 'room-walk', 'filters', 'all-enter', 'all-idle', 'all-walk', 'read', 'wiki-walk', 'wiki-read'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTICE_S = 3; // the starting notice, shown before the first scenario

/**
 * A loop through a room's free floor, as {x, z} points: in a hall up a side aisle, across the
 * middle aisle, down the other side and along the back; in a rotunda a circle around the middle.
 */
export function walkPath(world) {
  const cases = world.shelves.cases;
  if (!cases.length) return [];
  const { width: W, depth: D } = BOOKCASE;
  let pts;
  if (world.room?.kind === 'hall') {
    const xs = cases.map((c) => c.position.x);
    const zs = cases.map((c) => c.position.z);
    const left = Math.min(...xs) - W / 2 - 1.2;
    const right = Math.max(...xs) + W / 2 + 1.2;
    const front = Math.max(...zs) + D / 2 + 1.2;
    const back = Math.min(...zs) - D / 2 - 1.2;
    const rows = [...new Set(cases.filter((c) => Math.abs(c.yaw - Math.PI) < 1e-6).map((c) => c.position.z))].sort((a, b) => b - a);
    const aisle = rows.length ? rows[Math.floor((rows.length - 1) / 2)] - D / 2 - 1.2 : back;
    pts = [[right, front], [right, aisle], [left, aisle], [left, back], [right, back], [right, front]];
  } else {
    const r = 0.5 * Math.hypot(cases[0].position.x, cases[0].position.z);
    pts = Array.from({ length: 13 }, (_, i) => [Math.sin((i / 12) * 2 * Math.PI) * r, Math.cos((i / 12) * 2 * Math.PI) * r]);
  }
  return pts.map(([x, z]) => ({ x, z })).filter((p) => world.isWalkable(p.x, p.z));
}

/** Glides the viewer along points at `speed` m/s, moved every frame like stick walking. */
function glide(controls, points, speed = 1.2) {
  if (points.length < 2) return Promise.resolve();
  const toward = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z)); // viewer yaw facing from a to b
  controls.teleportTo(controls.rig.position.clone().set(points[0].x, 0, points[0].z), toward(points[0], points[1]));
  let i = 1;
  const head = controls.rig.position.clone();
  return new Promise((resolve) => {
    const off = perf.addHook((dt) => {
      controls.viewerPosition(head);
      const p = points[i];
      const dx = p.x - head.x;
      const dz = p.z - head.z;
      const d = Math.hypot(dx, dz);
      const step = speed * dt;
      const f = d <= step ? 1 : step / d;
      controls.rig.position.x += dx * f;
      controls.rig.position.z += dz * f;
      controls.rig.updateMatrixWorld(true);
      if (d <= step && ++i >= points.length) {
        off();
        resolve();
      }
    });
  });
}

/**
 * Runs the scenarios (all, or `only`), logging progress as "[perf] …" console lines.
 * @param {object} app window.__vrlbry
 * @param {{ only?: string[] }} [opts]
 * @returns {Promise<string[]>} the scenarios that ran
 */
export async function runScenarios(app, { only = null } = {}) {
  const { interaction: I, controls: C, world, settings } = app;
  const log = (msg) => console.info(`[perf] ${msg}`);
  const want = (name) => !only || only.includes(name);
  const ran = [];
  const saved = { place: settings.place, rooms: JSON.parse(JSON.stringify(settings.rooms || {})) };
  const libs = I.libraries.filter((l) => (I.booksByLib[l.id] || []).length);
  const bySize = [...libs].sort((a, b) => I.booksByLib[a.id].length - I.booksByLib[b.id].length);
  // The small room and the reading test use an ordinary library, so runs stay comparable;
  // Wikipedia has its own scenarios, in its largest room.
  const isWiki = (l) => l.kind === 'wikipedia';
  const small = bySize.find((l) => !isWiki(l)) ?? bySize[0];
  const wiki = [...bySize].reverse().find(isWiki);
  const faceted = [...bySize].reverse().find((l) => isFaceted(l, I.booksByLib[l.id]));

  /** Runs fn as a recorder segment; setup runs first, outside the segment. */
  const scenario = async (name, fn, setup = null) => {
    if (!want(name)) return;
    await setup?.();
    log(`begin ${name}`);
    perf.begin(name);
    try {
      await fn();
    } finally {
      perf.end();
      ran.push(name);
      log(`end ${name}`);
    }
  };
  const goTo = async (libId, room) => {
    if (I.state === 'inspect' || I.state === 'read') await I.putBack();
    await I.setPlace(libId, room);
  };
  const atSpawn = () => C.teleportTo(world.spawn.position, world.spawn.yaw);

  try {
    if (I.state === 'inspect' || I.state === 'read') await I.putBack();
    // Tell the wearer, in the headset, before anything moves (and before any measuring).
    I.notice('Performance test starting', 'The view moves by itself for a few minutes', NOTICE_S);
    await sleep(NOTICE_S * 1000 + 300);

    await scenario('small-idle', async () => {
      await goTo(small.id);
      atSpawn();
      await sleep(10000);
    });

    if (faceted) {
      await scenario('room-walk', async () => {
        await goTo(faceted.id, { genre: null, letter: null }); // the first 3,000 of the whole library
        await glide(C, walkPath(world));
      });
      await scenario('filters', async () => {
        await goTo(faceted.id);
        const [top] = facetsOf(I.booksByLib[faceted.id]).genres;
        for (const [key, value] of [['genre', top.name], ['letter', 'A'], ['letter', 'B'], ['genre', top.name], ['letter', 'B']]) {
          await I.toggleFilter(faceted.id, key, value);
          await sleep(2500);
        }
      });
    }

    if (libs.length > 1) {
      // Entered from the small room, so there is always a rebuild to measure.
      await scenario('all-enter', () => goTo(ALL_PLACE.id), () => settings.place === ALL_PLACE.id && goTo(small.id));
      await scenario('all-idle', async () => {
        if (settings.place !== ALL_PLACE.id) await goTo(ALL_PLACE.id);
        atSpawn();
        await sleep(10000);
      });
      await scenario('all-walk', async () => {
        if (settings.place !== ALL_PLACE.id) await goTo(ALL_PLACE.id);
        await glide(C, walkPath(world));
      });
    }

    await scenario('read', async () => {
      await goTo(small.id);
      const book = world.shelves.books().find((b) => b.readable);
      if (!book) return log('no readable book');
      I.showBook(book);
      await sleep(800);
      await I.pick(book);
      await sleep(600);
      await I.read();
      await sleep(2000);
      for (let i = 0; i < 20; i++) {
        await I.turn(1);
        await sleep(400);
      }
      await I.putBack();
    });

    if (wiki) {
      await scenario('wiki-walk', async () => {
        await goTo(wiki.id);
        await glide(C, walkPath(world));
      });
      await scenario('wiki-read', async () => {
        if (settings.place !== wiki.id) await goTo(wiki.id);
        const volumes = world.shelves.books();
        const book = volumes[Math.floor(volumes.length / 2)];
        if (!book) return log('no volume');
        I.showBook(book);
        await sleep(800);
        await I.pick(book);
        await sleep(600);
        await I.read({ fromStart: true });
        await sleep(2000);
        for (let i = 0; i < 6; i++) {
          await I.turn(1);
          await sleep(400);
        }
        // Jump to the volume's longest article (by its estimated size), the slowest to lay out.
        const meta = I.reader?.meta;
        let longest = 0;
        meta?.chunks.forEach((ch, i) => { if (ch.chars > meta.chunks[longest].chars) longest = i; });
        const entry = meta?.toc.find((t) => t.c === longest);
        if (entry) {
          await I.jumpToToc(entry);
          await sleep(2000);
          for (let i = 0; i < 10; i++) {
            await I.turn(1);
            await sleep(400);
          }
        }
        await I.putBack();
      });
    }
  } finally {
    // Back to where the visitor was.
    if (I.state === 'inspect' || I.state === 'read') await I.putBack();
    settings.rooms = saved.rooms;
    settings.place = saved.place;
    save('settings', settings);
    await I._rebuildWorld();
    atSpawn();
    I.notice('Performance test finished', 'Thank you: the results are being saved', 8);
    log('done');
  }
  return ran;
}
