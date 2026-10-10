// A ZIM's web address as someone types or pastes it, made one the page can read
// (public/js/local/zim-url.js, milestone 3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileNameOf, onKiwixMirror, zimUrl } from '../public/js/local/zim-url.js';

const MIRROR = 'https://mirror.download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim';
const https = { pageProtocol: 'https:' };

describe('ZIM web addresses (zim-url.js)', () => {
  it('turns Kiwix\'s download links into its mirror\'s, which a page may read', () => {
    for (const typed of [
      MIRROR,
      'https://download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim',
      'http://download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim',
      'https://lb.download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim.meta4',
      'https://download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim.torrent',
      'https://download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim.sha256',
      '  download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim#x  ',
      'mirror.download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim',
    ]) {
      assert.deepEqual(zimUrl(typed, https), { url: MIRROR, name: 'gutenberg_en_lcc-p_2026-03.zim' }, typed);
    }
  });

  it('keeps other sites as they are, and names the file', () => {
    assert.deepEqual(zimUrl('https://example.org/files/My%20Library.zim?x=1', https), {
      url: 'https://example.org/files/My%20Library.zim?x=1', name: 'My Library.zim',
    });
    assert.equal(zimUrl('https://ftp.nluug.nl/pub/kiwix/zim/wikipedia/wikipedia_en_100_2026-08.zim', https).url,
      'https://ftp.nluug.nl/pub/kiwix/zim/wikipedia/wikipedia_en_100_2026-08.zim', 'only Kiwix\'s own download links are rewritten');
    assert.equal(fileNameOf('https://x.org/a/b%C3%A9.zim'), 'bé.zim');
    assert.equal(fileNameOf('not a url'), '');
  });

  it('finds a file of another Kiwix mirror on Kiwix\'s own (the one a page may read)', () => {
    assert.equal(onKiwixMirror('https://ftp.nluug.nl/pub/kiwix/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim'), MIRROR);
    assert.equal(onKiwixMirror('https://dumps.wikimedia.org/kiwix/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim'), MIRROR);
    assert.equal(onKiwixMirror(MIRROR), null, 'already there');
    assert.equal(onKiwixMirror('https://example.org/files/a.zim'), null, 'not a Kiwix layout');
    assert.equal(onKiwixMirror('nonsense'), null);
  });

  it('refuses what it cannot read, saying why', () => {
    assert.match(zimUrl('', https).error, /Type or paste/);
    assert.match(zimUrl('ftp://example.org/a.zim', https).error, /Not a web address/);
    assert.match(zimUrl('https://exa mple.org/a.zim', https).error, /Not a web address/);
    assert.match(zimUrl('https://example.org/books/', https).error, /Not the address of a \.zim file/);
    assert.match(zimUrl('https://example.org/a.pdf', https).error, /Not the address of a \.zim file/);
    // An https page cannot read http (mixed content), except from this machine.
    assert.match(zimUrl('http://example.org/a.zim', https).error, /cannot read an http:\/\/ address/);
    assert.equal(zimUrl('http://example.org/a.zim', { pageProtocol: 'http:' }).url, 'http://example.org/a.zim');
    assert.equal(zimUrl('http://localhost:8095/a.zim', https).url, 'http://localhost:8095/a.zim');
    assert.equal(zimUrl('http://127.0.0.1:8095/a.zim', https).url, 'http://127.0.0.1:8095/a.zim');
  });
});
