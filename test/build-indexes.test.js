// Prebuilt indexes (tools/build-indexes.mjs, milestone 3 step 6): the listed ZIMs' current
// editions from Kiwix's catalogue (a fake one here), their indexes built from a copy or over HTTP
// (the range server), kept when present, pruned when no longer current, published with a list.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import '../server/platform-node.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import { buildListed, currentEditions, indexNameOf, readList, writeIndexList } from '../tools/build-indexes.mjs';
import { startRangeServer } from './helpers/range-server.js';
import { writeWikipediaZim } from './helpers/zim-fixtures.js';

let tmp;
let web;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-build-indexes-'));
  web = await startRangeServer();
});
after(async () => {
  await web.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const uuidOf = async (file) => {
  const z = await ZimArchive.open(file);
  const { uuid } = z.header;
  await z.close();
  return uuid;
};
const dashed = (uuid) => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** An OPDS feed of entries { uuid, name, flavour, href, size } (the parts the tool reads). */
const feed = (entries) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.map((e) => `
  <entry><id>urn:uuid:${dashed(e.uuid)}</id><title>${e.name}</title><summary>s</summary><language>eng</language>
    <name>${e.name}</name><flavour>${e.flavour}</flavour><category>wikipedia</category>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="${e.href}" length="${e.size}" /></entry>`).join('')}</feed>`;
/** A fetch answering the catalogue with `entries` (Wikipedias) and nothing for the other kinds. */
const catalogue = (entries) => async (url) => ({
  ok: true, status: 200,
  text: async () => feed(/category=wikipedia/.test(url) ? entries : []),
});

describe('prebuilt indexes (tools/build-indexes.mjs)', () => {
  it('reads the list, and finds the current edition of each in the catalogue', async () => {
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, '# comment\nwikipedia_en_test_maxi   # 1 GB\n\nwikipedia_en_gone_maxi\n');
    assert.deepEqual(readList(list), ['wikipedia_en_test_maxi', 'wikipedia_en_gone_maxi']);
    const entries = [
      { uuid: 'a'.repeat(32), name: 'wikipedia_en_test', flavour: 'maxi', href: 'https://download.kiwix.org/zim/wikipedia/wikipedia_en_test_maxi_2026-01.zim.meta4', size: 5 },
      { uuid: 'b'.repeat(32), name: 'wikipedia_en_test', flavour: 'nopic', href: 'https://download.kiwix.org/zim/wikipedia/wikipedia_en_test_nopic_2026-01.zim.meta4', size: 5 },
    ];
    const found = await currentEditions(readList(list), { fetch: catalogue(entries) });
    assert.equal(found[0].entry.url, 'https://mirror.download.kiwix.org/zim/wikipedia/wikipedia_en_test_maxi_2026-01.zim');
    assert.equal(found[0].entry.uuid, 'a'.repeat(32));
    assert.equal(found[1].entry, null, 'not in the catalogue');
    assert.equal(await indexNameOf(found[0].entry), `wikipedia-${'a'.repeat(32)}.v4.json`);
  });

  it('builds a missing index from a copy, keeps it, prunes old editions and publishes the list', async () => {
    const zims = path.join(tmp, 'zims');
    fs.mkdirSync(zims);
    const file = writeWikipediaZim(path.join(zims, 'wikipedia_en_test_maxi_2026-02.zim')).filePath;
    const uuid = await uuidOf(file);
    const entries = [{ uuid, name: 'wikipedia_en_test', flavour: 'maxi', href: 'https://download.kiwix.org/zim/wikipedia/wikipedia_en_test_maxi_2026-02.zim.meta4', size: fs.statSync(file).size }];
    const out = path.join(tmp, 'out');
    const site = path.join(tmp, 'site');
    const logs = [];
    const run = (opts) => buildListed({ bases: ['wikipedia_en_test_maxi', 'wikipedia_en_other_maxi'], out, zims, fetch: catalogue(entries), log: (m) => logs.push(m), ...opts });
    // An old edition's index, and one of a ZIM not listed: --prune removes both.
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `wikipedia-${'c'.repeat(32)}.v4.json`), '{}');
    const first = await run({ prune: true, publish: site });
    assert.deepEqual(first.built, ['wikipedia_en_test_maxi_2026-02.zim']);
    assert.deepEqual(first.unlisted, ['wikipedia_en_other_maxi']);
    const name = `wikipedia-${uuid}.v4.json`;
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')).count, 7, 'the fixture\'s 7 articles');
    assert.deepEqual(fs.readdirSync(out).sort(), ['.work', 'list.json', name]);
    assert.deepEqual(fs.readdirSync(path.join(out, '.work')).filter((n) => /\.part/.test(n)), [], 'no checkpoint left once built');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(site, 'list.json'), 'utf8')), { indexes: [name] });
    assert.ok(fs.existsSync(path.join(site, name)));
    // Again: kept, not built.
    const second = await run({});
    assert.deepEqual([second.kept, second.built], [['wikipedia_en_test_maxi_2026-02.zim'], []]);
    // Out of time (--hours): not started, reported missing (not failed).
    const late = await buildListed({ bases: ['wikipedia_en_test_maxi'], out: path.join(tmp, 'out-late'), zims, hours: 1e-12, fetch: catalogue(entries), log: () => {} });
    assert.deepEqual([late.missing, late.failed], [['wikipedia_en_test_maxi_2026-02.zim'], []]);
    // Without a copy, and without --web: reported missing.
    const third = await buildListed({ bases: ['wikipedia_en_test_maxi'], out: path.join(tmp, 'out2'), fetch: catalogue(entries), log: () => {} });
    assert.deepEqual(third.missing, ['wikipedia_en_test_maxi_2026-02.zim']);
  });

  it('builds an index over HTTP with --web (as from Kiwix\'s mirror)', async () => {
    const file = writeWikipediaZim(path.join(tmp, 'wikipedia_en_webtest_maxi_2026-03.zim')).filePath;
    const { url } = web.serve(file);
    const uuid = await uuidOf(file);
    const entries = [{ uuid, name: 'wikipedia_en_webtest', flavour: 'maxi', href: url, size: fs.statSync(file).size }];
    const out = path.join(tmp, 'out-web');
    const before = web.requests.length;
    const r = await buildListed({ bases: ['wikipedia_en_webtest_maxi'], out, web: true, fetch: catalogue(entries), log: () => {} });
    assert.deepEqual(r.built, ['wikipedia_en_webtest_maxi_2026-03.zim']);
    assert.ok(web.requests.length > before, 'read over HTTP');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, `wikipedia-${uuid}.v4.json`), 'utf8')).count, 7);
    assert.deepEqual(writeIndexList(out), [`wikipedia-${uuid}.v4.json`]);
  });
});
