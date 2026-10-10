// Kiwix's library (public/js/local/kiwix.js, milestone 3 step 5): the OPDS feeds read into entries
// as the app lists them, from trimmed copies of the real feeds (test/fixtures/opds/), and the
// catalogue object's caching, languages, prebuilt indexes and failures.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALOG_ORIGIN, defaultLanguage, kiwixCatalog, needsIndex, parseEntries, parseLanguages, sizeText } from '../public/js/local/kiwix.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opds');
const feed = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');
const MIRROR = 'https://mirror.download.kiwix.org/zim';

/** A fetch answering the catalogue's URLs from the fixtures, counting what it is asked. */
function fakeFetch({ fail = new Set(), indexes = null } = {}) {
  const asked = [];
  const f = async (url) => {
    asked.push(String(url));
    const u = new URL(url);
    const answer = (status, body = '') => ({ ok: status === 200, status, text: async () => body });
    if (fail.has(u.searchParams.get('category') ?? u.pathname)) return answer(503);
    if (u.pathname === '/catalog/v2/entries') return answer(200, feed(u.searchParams.get('category')));
    if (u.pathname === '/catalog/v2/languages') return answer(200, feed('languages'));
    if (u.pathname.endsWith('/indexes/list.json')) return indexes ? answer(200, JSON.stringify(indexes)) : answer(404);
    return answer(404);
  };
  f.asked = asked;
  return f;
}

describe('Kiwix\'s library (kiwix.js)', () => {
  it('reads a feed\'s entries as the app shows them, read from Kiwix\'s mirror', () => {
    const wp = parseEntries(feed('wikipedia'));
    assert.equal(wp.length, 10);
    const mini = wp.find((e) => e.name === 'wikipedia_en_chemistry' && e.flavour === 'mini');
    assert.deepEqual({ ...mini, summary: mini.summary.slice(0, 20) }, {
      uuid: mini.uuid, name: 'wikipedia_en_chemistry', kind: 'wikipedia', flavour: 'mini', zimTitle: 'Chemistry by Wikipedia',
      summary: 'A selection of Wikip', about: mini.summary, languages: ['eng'], title: 'Chemistry by Wikipedia (introductions)',
      articles: mini.articles, size: 24776704, date: '2026-07',
      url: `${MIRROR}/wikipedia/wikipedia_en_chemistry_mini_2026-07.zim`,
      illustration: `${CATALOG_ORIGIN}/catalog/v2/illustration/${mini.uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}/?size=48`,
    });
    assert.match(mini.uuid, /^[0-9a-f]{32}$/);
    assert.ok(mini.articles > 1000);
    // A topic's editions: the fullest first, under one title.
    assert.deepEqual(wp.filter((e) => e.name === 'wikipedia_en_chemistry').map((e) => e.title),
      ['Chemistry by Wikipedia', 'Chemistry by Wikipedia (no pictures)', 'Chemistry by Wikipedia (introductions)']);
    assert.ok(wp.find((e) => e.name === 'wikipedia_en_100').title === 'Wikipedia 100', 'no flavour: the title as it is');
    assert.deepEqual(wp.find((e) => e.name === 'wikipedia_fr_all').languages, ['fra']);
    // In title order (the app's, not the feed's), a topic's editions together, the fullest first.
    assert.deepEqual(wp.map((e) => `${e.name}:${e.flavour}`), [
      'wikipedia_en_chemistry:maxi', 'wikipedia_en_chemistry:nopic', 'wikipedia_en_chemistry:mini', 'wikipedia_en_ray-charles:mini',
      'wikipedia_en_all:nopic', 'wikipedia_fr_all:maxi', 'wikipedia_fr_all:nopic', 'wikipedia_fr_all:mini', 'wikipedia_en_100:',
      'wikipedia_en_top1m:maxi',
    ]);
  });

  it('names Gutenberg\'s collections by their class, and its whole ones as such', () => {
    const g = parseEntries(feed('gutenberg'));
    assert.deepEqual(g.map((e) => [e.name, e.title]), [
      ['gutenberg_en_all', 'Gutenberg · every book'],
      ['gutenberg_mul_all', 'Gutenberg · every book in every language'],
      ['gutenberg_en_lcc-pd', 'Gutenberg · Germanic and Scandinavian languages (PD)'],
      ['gutenberg_en_lcc-p', 'Gutenberg · Language and literature (P)'],
    ]);
    const mul = g.find((e) => e.name === 'gutenberg_mul_all');
    assert.ok(mul.languages.length > 20 && mul.languages.includes('fra'), 'listed under each of its languages');
    assert.equal(g.find((e) => e.name === 'gutenberg_en_lcc-p').url, `${MIRROR}/gutenberg/gutenberg_en_lcc-p_2026-03.zim`);
    assert.equal(g.find((e) => e.name === 'gutenberg_en_lcc-p').about, '', 'its summary is in its title');
    assert.match(g.find((e) => e.name === 'gutenberg_en_all').about, /All books in English/);
  });

  it('reads language names, and picks the browser\'s language', () => {
    assert.deepEqual([...parseLanguages(feed('languages'))].sort(), [['deu', 'Deutsch'], ['eng', 'English'], ['fra', 'français']]);
    assert.equal(defaultLanguage(['fr-CH', 'en']), 'fra');
    assert.equal(defaultLanguage(['xx', 'de-DE']), 'deu');
    assert.equal(defaultLanguage([]), 'eng');
    assert.equal(defaultLanguage(['tlh']), 'eng', 'unknown: English');
  });

  it('marks a big Wikipedia or Wikisource without a prebuilt index', () => {
    const wp = parseEntries(feed('wikipedia'));
    const by = (name, flavour) => wp.find((e) => e.name === name && e.flavour === flavour);
    assert.equal(needsIndex(by('wikipedia_en_chemistry', 'mini')), false, '25 MB: built in the browser');
    assert.equal(needsIndex(by('wikipedia_en_chemistry', 'maxi')), true, '514 MB');
    assert.equal(needsIndex(by('wikipedia_en_top1m', 'maxi'), new Set([by('wikipedia_en_top1m', 'maxi').uuid])), false, 'its index is on the site');
    assert.equal(needsIndex(parseEntries(feed('gutenberg')).find((e) => e.name === 'gutenberg_en_all')), false, 'Gutenberg needs none');
    assert.equal(sizeText(24776704), '25 MB');
    assert.equal(sizeText(4532683039), '4.5 GB');
    assert.equal(sizeText(49385356288), '49 GB');
    assert.equal(sizeText(null), '');
  });

  it('lists a kind in a language, reading each feed once, with its languages', async () => {
    const top1m = parseEntries(feed('wikipedia')).find((e) => e.name === 'wikipedia_en_top1m').uuid;
    const fetch = fakeFetch({ indexes: { indexes: [`wikipedia-${top1m}.v4.json`] } });
    const cat = kiwixCatalog({ fetch, indexList: 'https://site.example/indexes/list.json' });
    const en = await cat.view('wikipedia', 'eng');
    assert.equal(en.entries.length, 7);
    assert.deepEqual(en.languages, [{ code: 'eng', name: 'English', count: 7 }, { code: 'fra', name: 'français', count: 3 }]);
    assert.equal(en.entries.find((e) => e.name === 'wikipedia_en_top1m').needsIndex, false, 'prebuilt here');
    assert.equal(en.entries.find((e) => e.name === 'wikipedia_en_all').needsIndex, true);
    assert.deepEqual(en.entries.map((e) => e.needsIndex), [false, false, false, false, true, true, true], 'those that open here first');
    const fr = await cat.view('wikipedia', 'fra');
    assert.deepEqual(fr.entries.map((e) => e.name), ['wikipedia_fr_all', 'wikipedia_fr_all', 'wikipedia_fr_all']);
    assert.equal(fetch.asked.filter((u) => /category=wikipedia/.test(u)).length, 1, 'the feed was read once');
    assert.equal(fetch.asked.filter((u) => /languages/.test(u)).length, 1);
    assert.deepEqual((await cat.view('gutenberg', 'fra')).entries.map((e) => e.name), ['gutenberg_mul_all']);
  });

  it('says when the catalogue cannot be reached, and tries again when asked again', async () => {
    const fails = new Set(['wikisource']);
    const fetch = fakeFetch({ fail: fails });
    const cat = kiwixCatalog({ fetch, indexList: null });
    await assert.rejects(cat.view('wikisource', 'eng'), /HTTP 503/);
    fails.clear();
    assert.equal((await cat.view('wikisource', 'eng')).entries.length, 2);
    // Without language names or a list of indexes it still lists (codes for names).
    const noNames = kiwixCatalog({ fetch: fakeFetch({ fail: new Set(['/catalog/v2/languages']) }), indexList: 'https://site.example/indexes/list.json' });
    const v = await noNames.view('wikisource', 'eng');
    assert.deepEqual(v.languages[0], { code: 'eng', name: 'eng', count: 2 });
    // No answer in time.
    const slow = kiwixCatalog({ fetch: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 20, indexList: null });
    await assert.rejects(slow.entries('gutenberg'), /no answer/);
  });
});
