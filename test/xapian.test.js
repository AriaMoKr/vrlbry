// A ZIM's Xapian databases (public/js/core/zim/xapian.js, experimental). The pure parts always;
// the rest on a real Wikisource ZIM in the repo root when it is there (skipped otherwise).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import '../server/platform-node.js';
import { ZimArchive } from '../public/js/core/zim/reader.js';
import { docKey, XapianDb } from '../public/js/core/zim/xapian.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKISOURCE = path.join(REPO, 'wikisource_en_all_maxi_2026-09.zim');
const real = fs.existsSync(WIKISOURCE) ? false : 'the Wikisource ZIM is not in the repo root';

describe('Xapian keys and terms', () => {
  it('writes document numbers as keys that sort as the numbers do', () => {
    const nums = [0, 1, 255, 256, 0x7fff, 0x8000, 0x3fffff, 0x400000, 123456789];
    const keys = nums.map(docKey);
    assert.deepEqual([...docKey(1)], [0x00, 0x01]);
    assert.deepEqual([...docKey(648443)], [0x89, 0xe4, 0xfb], 'as Wikisource\'s index has it');
    for (let i = 1; i < keys.length; i++) assert.ok(Buffer.compare(Buffer.from(keys[i - 1]), Buffer.from(keys[i])) < 0, `${nums[i - 1]} < ${nums[i]}`);
  });

  it('takes a query\'s words in lower case, stemmed only in a full-text index', () => {
    const db = Object.create(XapianDb.prototype);
    db.kind = 'fulltext';
    db._stem = (w) => w.replace(/(ing|ed|s)$/, '');
    assert.deepEqual(db.terms('Harpooned WHALES, whales & Grey’s'), ['harpoon', 'whale', "grey'"]);
    db.kind = 'title';
    assert.deepEqual(db.terms('The Grey House'), ['the', 'grey', 'house']);
  });
});

describe('Xapian databases in a real ZIM', { skip: real }, () => {
  it('reads the full-text index: settings, a word\'s documents, ranked results and paths', async () => {
    const archive = await ZimArchive.open(WIKISOURCE);
    try {
      const db = await XapianDb.inArchive(archive, 'X/fulltext/xapian', { stem: (w) => (w === 'whales' ? 'whale' : w) });
      assert.equal(db.kind, 'fulltext');
      assert.equal(db.language, 'eng');
      assert.equal(db.docCount, 706864);
      assert.equal(db.blockSize, 8192);
      const whale = await db.postings('whale');
      assert.equal(whale.termfreq, 5641);
      let n = 1;
      let last = whale.did;
      while (await whale.next()) {
        assert.ok(whale.did > last, 'in order');
        last = whale.did;
        n++;
      }
      assert.equal(n, 5641, 'every chunk');
      assert.equal(await db.postings('whales'), null, 'stems only');
      const found = await db.search('white whales', { limit: 5 });
      assert.deepEqual(found.terms.map((t) => t.term), ['white', 'whale']);
      assert.equal(found.total, 3421);
      assert.equal(found.results[0].path, 'C/Popular_Science_Monthly/Volume_55/July_1899/White_Whales_in_Confinement');
      assert.ok(found.results.some((r) => r.path === 'C/Moby-Dick_(1851)_US_edition/Chapter_41'));
      assert.ok(found.results.every((r, i) => i === 0 || r.score <= found.results[i - 1].score), 'the best first');
      assert.equal((await db.search('whale zzyzzyx')).total, 0, 'a word no page has');
    } finally {
      await archive.close();
    }
  });

  it('reads the title index: plain words, and a document\'s path', async () => {
    const archive = await ZimArchive.open(WIKISOURCE);
    try {
      const db = await XapianDb.inArchive(archive, 'X/title/xapian');
      assert.equal(db.kind, 'title');
      assert.equal(await db.metadata('valuesmap'), 'title:0;targetPath:1');
      const found = await db.search('moby dick', { limit: 50 });
      assert.equal(found.total, 144);
      assert.ok(found.results.some((r) => r.path === 'C/Moby-Dick'));
      assert.equal(await db.path(648443), 'C/Telugu-English_Dictionary/రే');
    } finally {
      await archive.close();
    }
  });
});
