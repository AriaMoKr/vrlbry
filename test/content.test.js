// Tests for server/content/html.js (SPEC §3.3, §3.5).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { htmlToBlocks, chunkBlocks, blockChars, imageSize, resolveHref } from '../server/content/html.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'content');
const NBSP = '\u00a0';

const blocks = (html, docPath = 'C/doc') => htmlToBlocks(html, { docPath }).blocks;
const text = (b) => (b.r ? b.r.map((r) => r[0]).join('') : b.t === 'tr' ? b.c.map((c) => c.map((r) => r[0]).join('')).join(' | ') : b.x ?? '');
const allText = (bs) => bs.map(text).join('\n');

/** Structural validation of the §3.5 block model. Returns a list of problems. */
function validate(bs) {
  const keys = {
    h: ['t', 'l', 'r', 'a', 'id'], p: ['t', 'r', 'a', 'q', 'v', 'id'], li: ['t', 'r', 'd', 'm', 'q', 'id'],
    tr: ['t', 'c', 'g', 'hd', 'q', 'id'], pre: ['t', 'x', 'q', 'id'], img: ['t', 'src', 'w', 'h', 'em', 'alt', 'inv', 'q', 'id'], hr: ['t'],
  };
  const errs = [];
  const image = (run) => run.length === 3 && run[0] === '￼' && typeof run[2]?.src === 'string' && run[2].w > 0 && run[2].h > 0;
  const runs = (r, w) => {
    if (!Array.isArray(r) || r.length === 0) return errs.push(`${w}: empty runs`);
    r.forEach((run, i) => {
      if (!Array.isArray(run) || !(run.length === 2 || image(run)) || typeof run[0] !== 'string' || !Number.isInteger(run[1])) errs.push(`${w}: bad run`);
      else if (run[0] === '') errs.push(`${w}: empty run text`);
      else if (i > 0 && r[i - 1][1] === run[1] && run.length === 2 && r[i - 1].length === 2) errs.push(`${w}: unmerged runs`);
    });
    const t = r.map((x) => x[0]).join('');
    if (/^[ \n]|[ \n]$/.test(t)) errs.push(`${w}: untrimmed ${JSON.stringify(t)}`);
    if (/ {2}| \n|\n |\n\n\n|[\t\r\u00ad]/.test(t)) errs.push(`${w}: bad whitespace ${JSON.stringify(t)}`);
  };
  bs.forEach((b, i) => {
    const w = `#${i} ${b.t}`;
    if (!keys[b.t]) return errs.push(`${w}: unknown type`);
    for (const k of Object.keys(b)) if (!keys[b.t].includes(k)) errs.push(`${w}: unexpected key ${k}`);
    if ('a' in b && b.a !== 'c' && b.a !== 'r') errs.push(`${w}: bad a`);
    if ('q' in b && !(Number.isInteger(b.q) && b.q > 0)) errs.push(`${w}: bad q`);
    if ('v' in b && b.v !== 1) errs.push(`${w}: bad v`);
    if ('hd' in b && b.hd !== true) errs.push(`${w}: bad hd`);
    if (b.r) runs(b.r, w);
    if (b.t === 'tr') b.c.forEach((c, j) => c.length && runs(c, `${w} c${j}`));
  });
  return errs;
}

describe('resolveHref', () => {
  test('SPEC examples', () => {
    assert.equal(resolveHref('37134_logo.png', 'C/The Elements of Style.37134'), 'C/37134_logo.png');
    assert.equal(resolveHref('../I/x%20y.png', 'A/foo.html'), 'I/x y.png');
  });
  test('relative paths, ./ and ../', () => {
    assert.equal(resolveHref('images/a.png', 'OEBPS/text/ch1.xhtml'), 'OEBPS/text/images/a.png');
    assert.equal(resolveHref('./a.png', 'OEBPS/ch1.xhtml'), 'OEBPS/a.png');
    assert.equal(resolveHref('../images/a.png', 'OEBPS/text/ch1.xhtml'), 'OEBPS/images/a.png');
    assert.equal(resolveHref('../../../a.png', 'OEBPS/ch1.xhtml'), 'a.png'); // clamps at the root
    assert.equal(resolveHref('a//b/./c.png', 'X/doc'), 'X/a/b/c.png');
  });
  test('leading slash is archive-root relative', () => {
    assert.equal(resolveHref('/I/pic.jpg', 'A/some/doc'), 'I/pic.jpg');
  });
  test('strips query and fragment, decodes percent escapes', () => {
    assert.equal(resolveHref('pic.png?v=2#frag', 'C/doc'), 'C/pic.png');
    assert.equal(resolveHref('Caf%C3%A9.png', 'C/doc'), 'C/Caf\u00e9.png');
    assert.equal(resolveHref('bad%zzname.png', 'C/doc'), 'C/bad%zzname.png'); // malformed escape kept
  });
  test('external, empty and data: links', () => {
    assert.equal(resolveHref('http://example.com/a.png', 'C/doc'), null);
    assert.equal(resolveHref('https://example.com/a.png', 'C/doc'), null);
    assert.equal(resolveHref('mailto:a@b.c', 'C/doc'), null);
    assert.equal(resolveHref('//cdn.example.com/a.png', 'C/doc'), null);
    assert.equal(resolveHref('', 'C/doc'), null);
    assert.equal(resolveHref('   ', 'C/doc'), null);
    assert.equal(resolveHref('#Page_5', 'C/doc'), null);
    assert.equal(resolveHref(undefined, 'C/doc'), null);
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(resolveHref(data, 'C/doc'), data);
  });
});

describe('htmlToBlocks: text and whitespace', () => {
  test('whitespace collapses across inline boundaries without loss or doubling', () => {
    assert.deepEqual(blocks('<p>a <i>b</i> c</p>'), [{ t: 'p', r: [['a ', 0], ['b', 1], [' c', 0]] }]);
    assert.deepEqual(blocks('<p>a<i> b </i>c</p>'), [{ t: 'p', r: [['a', 0], [' b ', 1], ['c', 0]] }]);
    assert.deepEqual(blocks('<p>a <i> b</i></p>'), [{ t: 'p', r: [['a ', 0], ['b', 1]] }]);
    assert.deepEqual(blocks('<p>word<b>glued</b>on</p>'), [{ t: 'p', r: [['word', 0], ['glued', 2], ['on', 0]] }]);
    assert.deepEqual(blocks('<p>\n   lots   of\n\tspace\r\n </p>'), [{ t: 'p', r: [['lots of space', 0]] }]);
  });
  test('adjacent runs with equal styles are merged; nesting accumulates bits', () => {
    assert.deepEqual(blocks('<p><i>a</i><em>b</em> <b><i>c</i></b><sup>2</sup><sub>x</sub></p>'),
      [{ t: 'p', r: [['ab', 1], [' ', 0], ['c', 3], ['2', 8], ['x', 16]] }]);
    assert.deepEqual(blocks('<p><code>m</code><tt>t</tt><u>u</u><ins>i</ins><small>s</small><big>B</big><cite>c</cite><var>v</var><dfn>d</dfn><strong>S</strong><kbd>k</kbd><samp>s</samp></p>'),
      [{ t: 'p', r: [['mt', 4], ['ui', 64], ['s', 128], ['B', 256], ['cvd', 1], ['S', 2], ['ks', 4]] }]);
  });
  test('small caps from classes and inline style; larger from xhtml_big', () => {
    assert.deepEqual(blocks('<p><span class="smcap">a</span><span class="small-caps">b</span><span class="x smallcaps">c</span><span style="font-variant: small-caps">d</span><span class="xhtml_big">e</span></p>'),
      [{ t: 'p', r: [['abcd', 32], ['e', 256]] }]);
  });
  test('entities are decoded; NBSP survives, soft hyphens vanish', () => {
    assert.deepEqual(blocks('<p>a&nbsp;&nbsp;b &amp; c &#8212; &#x2014; &lt;tag&gt; co&shy;op\u00adera\u00adtion</p>'),
      [{ t: 'p', r: [[`a${NBSP}${NBSP}b & c \u2014 \u2014 <tag> cooperation`, 0]] }]);
  });
  test('<br> makes hard breaks, never leading/trailing blank lines', () => {
    assert.deepEqual(blocks('<p><br/>line one<br>\n  line two <br/><br/></p>'), [{ t: 'p', r: [['line one\nline two', 0]] }]);
    assert.deepEqual(blocks('<p>a<br/><br/>b</p>'), [{ t: 'p', r: [['a\n\nb', 0]] }]);
    assert.deepEqual(blocks('<p>a<br/><br/><br/><br/>b</p>'), [{ t: 'p', r: [['a\n\nb', 0]] }]); // at most one blank line
    assert.deepEqual(blocks('<p><i>one<br/></i>two</p>'), [{ t: 'p', r: [['one\n', 1], ['two', 0]] }]);
    assert.deepEqual(blocks('<p>a</br>b</p>'), [{ t: 'p', r: [['a\nb', 0]] }]); // </br> acts as <br>
  });
  test('empty and whitespace-only blocks are dropped', () => {
    assert.deepEqual(blocks('<p> </p><p>&nbsp;</p><div><span> </span></div><h2>  </h2><p>x</p>'), [{ t: 'p', r: [['x', 0]] }]);
  });
  test('title comes from <title>, BOM is ignored', () => {
    const r = htmlToBlocks('\ufeff<html><head><title> The\n Book </title></head><body><p>x</p></body></html>', { docPath: 'C/x' });
    assert.equal(r.title, 'The Book');
    assert.deepEqual(r.blocks, [{ t: 'p', r: [['x', 0]] }]);
    assert.equal(htmlToBlocks('<p>x</p>', { docPath: 'C/x' }).title, null);
  });
});

describe('htmlToBlocks: skip rules', () => {
  test('head, script, style, svg, forms, hidden elements', () => {
    const html = `<html><head><title>T</title><style>p{}</style><script>var x = "<p>no</p>";</script></head><body>
      <p>keep<script>bad()</script></p><noscript>ns</noscript><template><p>tpl</p></template>
      <svg><title>svg title</title><text>svg</text></svg><button>btn</button><select><option>o</option></select>
      <input value="v"/><textarea>ta</textarea><iframe>if</iframe><object>obj</object>
      <p hidden>hidden</p><p style="display:none">none</p><p style="color:red">shown</p></body></html>`;
    const r = htmlToBlocks(html, { docPath: 'C/x' });
    assert.equal(r.title, 'T');
    assert.deepEqual(r.blocks.map(text), ['keep', 'shown']);
  });
  test('math keeps its alt text', () => {
    assert.deepEqual(blocks('<p>so <math alttext="x^2"><mi>x</mi></math> holds</p>'), [{ t: 'p', r: [['so x^2 holds', 0]] }]);
  });
  test('zim_* nav and page numbers are stripped; page ids become anchors', () => {
    const html = `<div><span class="zim_info"><a href="x">i</a></span><span class="zim_epub"><a>EPUB</a></span>
      <span class="zim_up"><a href="#">up</a></span></div><span class="zim_whatever">zz</span>
      <p>(Oxford\n<a class="pagenum" href="" id="Page_6" title="6"> </a>\nUniversity Press)</p>
      <p>a <span class="pagenum"><a href="" id="Page_7">[Pg 7]</a></span>b<span class="pageno">8</span>c</p>
      <p><span class="pageNum" id="pb9">[<a href="#pb9">9</a>]</span>d</p>`;
    assert.deepEqual(blocks(html), [
      { t: 'p', r: [['(Oxford University Press)', 0]], id: 'Page_6' },
      { t: 'p', r: [['a bc', 0]], id: 'Page_7' },
      { t: 'p', r: [['d', 0]], id: 'pb9' },
    ]);
  });
  test('a page-number id between blocks anchors the next block', () => {
    assert.deepEqual(blocks('<p>one</p><p><span class="pagenum" id="Page_2">[2]</span></p><p>two</p>'),
      [{ t: 'p', r: [['one', 0]] }, { t: 'p', r: [['two', 0]], id: 'Page_2' }]);
  });
  test('PG header boilerplate is skipped, the license footer kept', () => {
    const html = `<section class="pg-boilerplate pgheader" id="pg-header"><h2>The Project Gutenberg eBook of X</h2></section>
      <p>Body</p><section class="pg-boilerplate pgheader" id="pg-footer"><h2>THE FULL PROJECT GUTENBERG LICENSE</h2></section>`;
    assert.deepEqual(blocks(html).map(text), ['Body', 'THE FULL PROJECT GUTENBERG LICENSE']);
  });
  test('top-level CSS class rules: display:none hides, visibility:hidden blanks, @media ignored', () => {
    const html = `<style>.hide { display: none } .inv { visibility: hidden } .it { font-style: italic }
      .ctr { text-align: center } @media print { .scr { display: none } } .dropcap { display: none }</style>
      <p class="hide">gone</p><p>Face.<span class="inv">That I</span> What?</p><p class="it ctr">styled</p>
      <p class="scr">screen</p><p><span class="dropcap">O</span>UR God</p>`;
    assert.deepEqual(blocks(html), [
      { t: 'p', r: [[`Face.${NBSP.repeat(4)} ${NBSP} What?`, 0]] },
      { t: 'p', r: [['styled', 1]], a: 'c' },
      { t: 'p', r: [['screen', 0]] },
      { t: 'p', r: [['OUR God', 0]] },
    ]);
  });
  test('navigation links beside headings are dropped', () => {
    assert.deepEqual(blocks('<h3>CARDINAL MERCIER<span class="totoc"><a href="#toc">ToC</a></span></h3>'),
      [{ t: 'h', l: 3, r: [['CARDINAL MERCIER', 0]] }]);
  });
});

describe('htmlToBlocks: block structure', () => {
  test('headings with level, id and line breaks; alignment', () => {
    assert.deepEqual(blocks('<h1><small>THE</small><br/>\nBOOK</h1><h2 id="c1">One</h2><h3><a id="x"></a>Two</h3>'), [
      { t: 'h', l: 1, r: [['THE\n', 128], ['BOOK', 0]] },
      { t: 'h', l: 2, r: [['One', 0]], id: 'c1' },
      { t: 'h', l: 3, r: [['Two', 0]], id: 'x' },
    ]);
    assert.deepEqual(blocks('<h2>Title<div>sub</div></h2>'), [{ t: 'h', l: 2, r: [['Title\nsub', 0]] }]);
  });
  test('alignment: center element, classes, inline style, explicit reset', () => {
    const bs = blocks(`<center><p>a</p></center><p class="center">b</p><p class="c">c</p><div class="figcenter"><p>d</p></div>
      <p style="text-align:center">e</p><p style="text-align: right">f</p><p class="right">g</p>
      <div class="center"><p style="text-align:left">h</p></div><p class="copyright">i</p>`);
    assert.deepEqual(bs.map((b) => [text(b), b.a ?? '']), [
      ['a', 'c'], ['b', 'c'], ['c', 'c'], ['d', 'c'], ['e', 'c'], ['f', 'r'], ['g', 'r'], ['h', ''], ['i', ''],
    ]);
  });
  test('blockquote / quote classes / dd raise q; dt is bold', () => {
    assert.deepEqual(blocks('<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote><div class="blockquot"><p>c</p></div><dl><dt>Term</dt><dd>Def</dd></dl>'), [
      { t: 'p', r: [['a', 0]], q: 1 },
      { t: 'p', r: [['b', 0]], q: 2 },
      { t: 'p', r: [['c', 0]], q: 1 },
      { t: 'p', r: [['Term', 2]] },
      { t: 'p', r: [['Def', 0]], q: 1 },
    ]);
  });
  test('nested block inside inline (malformed) splits the paragraph and keeps styles', () => {
    assert.deepEqual(blocks('<p><i>a <div>b</div> c</i></p>'),
      [{ t: 'p', r: [['a', 1]] }, { t: 'p', r: [['b', 1]] }, { t: 'p', r: [['c', 1]] }]);
  });
  test('implied end tags and unclosed elements', () => {
    assert.deepEqual(blocks('<p>one<p>two<ul><li>x<li>y</ul><p>three'), [
      { t: 'p', r: [['one', 0]] }, { t: 'p', r: [['two', 0]] },
      { t: 'li', r: [['x', 0]], d: 1, m: '\u2022' }, { t: 'li', r: [['y', 0]], d: 1, m: '\u2022' },
      { t: 'p', r: [['three', 0]] },
    ]);
    // </b> closes the <p> nested in it (htmlparser2 has no adoption agency), so "after" is a new block.
    assert.deepEqual(blocks('<p>stray</p></p></div><b>bold<p>para</b> after'), [
      { t: 'p', r: [['stray', 0]] }, { t: 'p', r: [['bold', 2]] }, { t: 'p', r: [['para', 2]] }, { t: 'p', r: [['after', 0]] },
    ]);
  });
  test('XHTML self-closing tags', () => {
    assert.deepEqual(blocks('<p>a<a id="n1"/>b<br/>c</p><div/><p>d</p>'),
      [{ t: 'p', r: [['ab\nc', 0]], id: 'n1' }, { t: 'p', r: [['d', 0]] }]);
  });
  test('lists: depth, bullets, ordered markers, start/type/value, continuation blocks', () => {
    const bs = blocks(`<ul><li>a<ul><li>b</li></ul>tail</li></ul>
      <ol start="3"><li>c</li><li value="7">d</li><li>e</li></ol>
      <ol type="a"><li>f</li><li>g</li></ol><ol type="I"><li>h</li><li>i</li><li>j</li><li>k</li></ol>
      <ul><li><p>p1</p><p>p2</p></li></ul><li>orphan</li>`);
    assert.deepEqual(bs.map((b) => [b.t, text(b), b.d, b.m]), [
      ['li', 'a', 1, '\u2022'], ['li', 'b', 2, '\u2022'], ['li', 'tail', 1, ''],
      ['li', 'c', 1, '3.'], ['li', 'd', 1, '7.'], ['li', 'e', 1, '8.'],
      ['li', 'f', 1, 'a.'], ['li', 'g', 1, 'b.'],
      ['li', 'h', 1, 'I.'], ['li', 'i', 1, 'II.'], ['li', 'j', 1, 'III.'], ['li', 'k', 1, 'IV.'],
      ['li', 'p1', 1, '\u2022'], ['li', 'p2', 1, ''],
      ['li', 'orphan', 1, '\u2022'],
    ]);
  });
  test('list-style none removes markers', () => {
    const bs = blocks('<style>ul { list-style-type: none }</style><ul><li>a</li></ul><ol style="list-style: none"><li>b</li></ol>');
    assert.deepEqual(bs.map((b) => b.m), ['', '']);
  });
  test('hr and pre', () => {
    assert.deepEqual(blocks('<p>a</p><hr/><hr/><pre>\n  x  <b>y</b>\n\tz\n\n</pre><pre>  \n </pre>'), [
      { t: 'p', r: [['a', 0]] }, { t: 'hr' }, { t: 'pre', x: '  x  y\n        z' },
    ]);
    assert.deepEqual(blocks('<blockquote><pre id="code">a &amp; b</pre></blockquote>'), [{ t: 'pre', x: 'a & b', q: 1, id: 'code' }]);
  });
});

describe('htmlToBlocks: verse', () => {
  test('stanza with span lines and <br>: one block per stanza, indentation by NBSP', () => {
    const bs = blocks(`<div class="poem"><div class="stanza">
      <span class="i0">Out of the night<br/></span>
      <span class="i2">Black as the pit<br/></span>
      </div><div class="stanza"><span class="i0">In the fell clutch<br/></span><span class="pn"><a id="Page_44">[44]</a></span>
      <span class="i1">I have not winced</span></div></div>`);
    assert.deepEqual(bs, [
      { t: 'p', r: [[`Out of the night\n${NBSP.repeat(4)}Black as the pit`, 0]], v: 1 },
      { t: 'p', r: [[`In the fell clutch\n${NBSP.repeat(2)}I have not winced`, 0]], v: 1, id: 'Page_44' },
    ]);
  });
  test('span lines without <br> still break (display:block in PG CSS)', () => {
    assert.deepEqual(blocks('<div class="stanza"><span class="i0">one</span> <span class="i0">two</span></div>'),
      [{ t: 'p', r: [['one\ntwo', 0]], v: 1 }]);
  });
  test('div.line lines merge into one block per stanza; alignment and stanzas separate', () => {
    const bs = blocks(`<div class="poetry"><div class="stanza">
      <div class="line">Sir, 'twas all one!<br/></div><div class="line indent4">Taming a sea-horse,<br/></div>
      <div class="line right">Lyrical Ballads</div></div>
      <div class="stanza"><div class="line">Second</div><div class="line">stanza</div></div></div><p>prose</p>`);
    assert.deepEqual(bs, [
      { t: 'p', r: [[`Sir, 'twas all one!\n${NBSP.repeat(8)}Taming a sea-horse,`, 0]], v: 1 },
      { t: 'p', r: [['Lyrical Ballads', 0]], a: 'r', v: 1 },
      { t: 'p', r: [['Second\nstanza', 0]], v: 1 },
      { t: 'p', r: [['prose', 0]] },
    ]);
  });
  test('p.stanza starts a stanza among <p> lines; empty lines split stanzas', () => {
    const bs = blocks(`<div class="poem"><p>l1</p><p class="two">l2</p><p class="stanza">s2 l1</p><p>s2 l2</p>
      <p>&nbsp;</p><p>s3 l1</p></div>`);
    assert.deepEqual(bs.map(text), ['l1\nl2', 's2 l1\ns2 l2', 's3 l1']);
    assert.ok(bs.every((b) => b.v === 1));
  });
});

describe('htmlToBlocks: tables', () => {
  test('rows become tr blocks with one runs array per cell; header rows; group per table', () => {
    const bs = blocks(`<table id="toc"><tr><th>Ch.</th><th>Title</th></tr>
      <tr><td>I.</td><td colspan="2"><span class="smcap">Intro</span> <i>x</i></td></tr>
      <tr><td> </td><td></td></tr></table>
      <table><tr><td>a</td><td>b</td></tr></table>`);
    assert.deepEqual(bs, [
      { t: 'tr', c: [[['Ch.', 0]], [['Title', 0]]], g: 1, hd: true, id: 'toc' },
      { t: 'tr', c: [[['I.', 0]], [['Intro', 32], [' ', 0], ['x', 1]]], g: 1 },
      { t: 'tr', c: [[['a', 0]], [['b', 0]]], g: 2 },
    ]);
  });
  test('nested data tables are flattened into the cell', () => {
    const bs = blocks('<table><tr><td>outer</td><td><table><tr><td>x</td><td>y</td></tr><tr><td>z</td></tr></table></td></tr></table>');
    assert.deepEqual(bs, [{ t: 'tr', c: [[['outer', 0]], [['x y\nz', 0]]], g: 1 }]);
  });
  test('cell content: line breaks for blocks, images moved out of the row', () => {
    const bs = blocks('<table><tr><td>a<p>b</p>c<br/>d</td><td>e<img src="i.png" alt="pic"/></td></tr></table>', 'C/doc');
    assert.deepEqual(bs, [
      { t: 'tr', c: [[['a\nb\nc\nd', 0]], [['e', 0]]], g: 1 },
      { t: 'img', src: 'C/i.png', alt: 'pic' },
    ]);
  });
  test('single-column layout tables become paragraphs (image above caption keeps its order)', () => {
    const bs = blocks('<table><tr><td><img src="f.png" width="10" height="20"/></td></tr><tr><td style="text-align:center"><b>Fig. 1</b></td></tr></table>');
    assert.deepEqual(bs, [{ t: 'img', src: 'C/f.png', w: 10, h: 20 }, { t: 'p', r: [['Fig. 1', 2]], a: 'c' }]);
  });
  test('a table wrapping whole chapters is turned back into flow', () => {
    const bs = blocks(`<table><tr><td><h2>CHAPTER I</h2><p>First para.</p><p>Second para.</p>
      <table><tr><td>w1</td><td>w2</td></tr></table><ul><li>item</li></ul></td></tr></table>`);
    assert.deepEqual(bs, [
      { t: 'h', l: 2, r: [['CHAPTER I', 0]] },
      { t: 'p', r: [['First para.', 0]] },
      { t: 'p', r: [['Second para.', 0]] },
      { t: 'tr', c: [[['w1', 0]], [['w2', 0]]], g: 2 },
      { t: 'li', r: [['item', 0]], d: 1, m: '\u2022' },
    ]);
  });
  test('structure inside a cell of a real grid is flattened, not linearized', () => {
    const bs = blocks('<table><tr><td>A</td><td>B</td></tr><tr><td>c</td><td><h3>Head</h3>d<hr/>e</td></tr></table>');
    assert.deepEqual(bs, [
      { t: 'tr', c: [[['A', 0]], [['B', 0]]], g: 1 },
      { t: 'tr', c: [[['c', 0]], [['Head\nd\ne', 0]]], g: 1 },
    ]);
  });
  test('malformed cell nesting (<td><p>\u2026<td>) starts the next cell', () => {
    assert.deepEqual(blocks('<table><tr><td><p>a<td>b</tr></table>'), [{ t: 'tr', c: [[['a', 0]], [['b', 0]]], g: 1 }]);
  });
});

describe('htmlToBlocks: images', () => {
  test('resolved src, numeric size attributes, alt, inline image splits the paragraph', () => {
    const bs = blocks('<p>before <img src="37134_logo.png" width="80" height="74px" alt=" Logo "/> after</p><img src="x.png" width="50%"/>', 'C/The Elements of Style.37134');
    assert.deepEqual(bs, [
      { t: 'p', r: [['before', 0]] },
      { t: 'img', src: 'C/37134_logo.png', w: 80, h: 74, alt: 'Logo' },
      { t: 'p', r: [['after', 0]] },
      { t: 'img', src: 'C/x.png' },
    ]);
  });
  test('unresolvable src: alt text as an italic paragraph, or nothing', () => {
    assert.deepEqual(blocks('<p>a</p><img src="http://x/y.png" alt="A map"/><img alt="no src"/><img src="" alt=""/>'), [
      { t: 'p', r: [['a', 0]] }, { t: 'p', r: [['A map', 1]] }, { t: 'p', r: [['no src', 1]] },
    ]);
  });
  test('figcaption and .caption are centered and smaller; data: URIs pass through', () => {
    const data = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const bs = blocks(`<figure><img src="${data}"/><figcaption>Cap <i>one</i></figcaption></figure>
      <div><img src="p.jpg"/><span class="caption">Cap two</span></div><blockquote><img src="q.jpg"/></blockquote>`);
    assert.deepEqual(bs, [
      { t: 'img', src: data },
      { t: 'p', r: [['Cap ', 128], ['one', 129]], a: 'c' },
      { t: 'img', src: 'C/p.jpg' },
      { t: 'p', r: [['Cap two', 128]], a: 'c' },
      { t: 'img', src: 'C/q.jpg', q: 1 },
    ]);
  });
});

describe('htmlToBlocks: inline images (image runs)', () => {
  const math = (alt, w, h, va) => `<span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display: none;"><math alttext="${alt}"><mi>x</mi></math></span><img src="./_assets_/m/${alt}.svg" class="mwe-math-fallback-image-inline mw-invert skin-invert" aria-hidden="true" style="vertical-align: ${va}ex; width:${w}ex; height:${h}ex;" alt="${alt}"></span>`;

  test('a MediaWiki formula stays in its sentence, sized from its ex style', () => {
    const bs = blocks(`<p>The state ${math('x', 1.5, 2, -0.5)}, and <b>more</b> ${math('y', 2, 2.5, 0)} here.</p>`, 'C/Kalman');
    assert.deepEqual(validate(bs), []);
    assert.deepEqual(bs, [{ t: 'p', r: [
      ['The state ', 0], ['￼', 0, { src: 'C/_assets_/m/x.svg', w: 12, h: 16, va: -4, alt: 'x', inv: 1 }], [', and ', 0], ['more', 2], [' ', 0],
      ['￼', 0, { src: 'C/_assets_/m/y.svg', w: 16, h: 20, alt: 'y', inv: 1 }], [' here.', 0],
    ] }]);
    assert.equal(blockChars(bs[0]), 'The state , and more  here.'.length + 2, 'an image run counts as one character');
  });

  test('small images with a size are inline; large ones still split the paragraph', () => {
    const bs = blocks('<p><img src="flag.png" width="23" height="15" alt="US"> United States <img src="big.png" width="200" height="150"> after</p>');
    assert.deepEqual(validate(bs), []);
    assert.deepEqual(bs, [
      { t: 'p', r: [['￼', 0, { src: 'C/flag.png', w: 23, h: 15, alt: 'US' }], [' United States', 0]] },
      { t: 'img', src: 'C/big.png', w: 200, h: 150 },
      { t: 'p', r: [['after', 0]] },
    ]);
  });

  test('a block of nothing but images becomes image blocks (a formula on its own line)', () => {
    const bs = blocks(`<dl><dd>${math('z', 4, 3, -1)}</dd></dl><div class="center"><img src="orn.png" width="300" height="20"></div>`);
    assert.deepEqual(validate(bs), []);
    assert.deepEqual(bs, [
      { t: 'img', src: 'C/_assets_/m/z.svg', w: 32, h: 24, em: 1, alt: 'z', inv: 1, q: 1 },
      { t: 'img', src: 'C/orn.png', w: 300, h: 20 },
    ]);
  });

  test('inline images in table cells, headings and verse lines', () => {
    const bs = blocks(`<h2>Area ${math('A', 1, 2, 0)}</h2><table><tr><td><img src="f.png" width="20" height="12"> France</td><td>67</td></tr></table>
      <div class="poem"><p>one ${math('a', 1, 1, 0)}<br>two</p></div>`);
    assert.deepEqual(validate(bs), []);
    assert.equal(bs[0].t, 'h');
    assert.equal(bs[0].r[1][2].src, 'C/_assets_/m/A.svg');
    assert.deepEqual(bs[1].c[0][0][2], { src: 'C/f.png', w: 20, h: 12 });
    assert.deepEqual(bs[2].r.map((r) => r[0]), ['one ', '￼', '\ntwo']);
    const { toc } = chunkBlocks(bs);
    assert.equal(toc[0].title, 'Area', 'no image in contents titles');
  });
});

describe('htmlToBlocks: MediaWiki infoboxes and sidebars', () => {
  const infobox = `<table class="infobox vcard"><caption class="infobox-title">Ants</caption>
    <tr><td colspan="2" class="infobox-image"><img src="ant.jpg" width="250" height="180" alt="An ant"><div class="infobox-caption">A worker ant</div></td></tr>
    <tr><th class="infobox-label">Kingdom</th><td class="infobox-data">Animalia</td></tr>
    <tr><th class="infobox-label">Order</th><td class="infobox-data">Hymenoptera</td></tr></table>`;
  const sidebar = '<table class="sidebar nomobile nowraplinks"><tr><td><ul><li>Series item 1</li><li>Series item 2</li></ul></td></tr></table>';

  test('the infobox image opens the article; its facts follow the lead; sidebars are dropped', () => {
    const bs = blocks(`<div class="mw-parser-output">${sidebar}${infobox}<p>Ants are insects.</p><p>They live in colonies.</p>
      <h2>Taxonomy</h2><p>Ants are wasps.</p></div>`);
    assert.deepEqual(validate(bs), []);
    assert.deepEqual(bs.map((b) => [b.t, b.src ?? text(b)]), [
      ['img', 'C/ant.jpg'],
      ['p', 'A worker ant'],
      ['p', 'Ants are insects.'],
      ['p', 'They live in colonies.'],
      ['h', 'Quick facts'],
      ['p', 'Ants'],
      ['tr', 'Kingdom | Animalia'],
      ['tr', 'Order | Hymenoptera'],
      ['h', 'Taxonomy'],
      ['p', 'Ants are wasps.'],
    ]);
    assert.equal(bs[1].a, 'c');
    assert.equal(bs[1].r[0][1] & 128, 128, 'the caption is smaller');
    assert.ok(!allText(bs).includes('Series item'));
  });

  test('without a section heading the facts go to the end; an infobox without an image moves whole', () => {
    const bs = blocks('<table class="infobox"><tr><th>Born</th><td>1900</td></tr><tr><th>Died</th><td>1990</td></tr></table><p>A life.</p>');
    assert.deepEqual(bs.map((b) => [b.t, text(b)]), [
      ['p', 'A life.'], ['h', 'Quick facts'], ['tr', 'Born | 1900'], ['tr', 'Died | 1990'],
    ]);
  });
});

describe('blockChars', () => {
  test('text length by type', () => {
    assert.equal(blockChars({ t: 'p', r: [['abc', 0], ['de', 1]] }), 5);
    assert.equal(blockChars({ t: 'h', l: 1, r: [['Title', 0]] }), 5);
    assert.equal(blockChars({ t: 'li', r: [['x', 0]], d: 1, m: '1.' }), 1);
    assert.equal(blockChars({ t: 'tr', c: [[['ab', 0]], [], [['c', 0]]], g: 1 }), 3);
    assert.equal(blockChars({ t: 'pre', x: 'a\nb' }), 3);
    assert.equal(blockChars({ t: 'img', src: 'C/x.png' }), 600);
    assert.equal(blockChars({ t: 'hr' }), 50);
  });
});

describe('chunkBlocks', () => {
  const para = (n, s = 'x') => ({ t: 'p', r: [[s.repeat(n), 0]] });
  const head = (l, s) => ({ t: 'h', l, r: [[s, 0]] });

  test('closes at targetChars only before a level \u2264 2 heading', () => {
    const bs = [head(1, 'A'), para(60), para(60), head(3, 'sub'), para(10), head(2, 'B'), para(10)];
    const { chunks, totalChars } = chunkBlocks(bs, { targetChars: 100 });
    assert.deepEqual(chunks.map((c) => c.blocks.length), [5, 2]);
    assert.deepEqual(chunks.map((c) => c.start), [0, 134]);
    assert.deepEqual(chunks.map((c) => c.chars), [134, 11]);
    assert.equal(totalChars, 145);
  });
  test('closes at 1.5 \u00d7 targetChars at any boundary and at maxBlocks; never splits blocks', () => {
    const { chunks } = chunkBlocks([para(90), para(90), para(500), para(1)], { targetChars: 100 });
    assert.deepEqual(chunks.map((c) => c.blocks.length), [2, 1, 1]);
    assert.deepEqual(chunks.map((c) => c.start), [0, 180, 680]);
    const many = Array.from({ length: 7 }, () => para(1));
    assert.deepEqual(chunkBlocks(many, { maxBlocks: 3 }).chunks.map((c) => c.blocks.length), [3, 3, 1]);
  });
  test('TOC: headings \u2264 3 with chunk/block positions, titles cleaned and capped', () => {
    const long = 'L'.repeat(200);
    const bs = [head(1, 'One\nLine'), para(150), head(4, 'deep'), head(2, long), head(3, '  spaced  ')];
    const { toc, tocTruncated } = chunkBlocks(bs, { targetChars: 100 });
    // chunk 0 = [h1, p] (158 ≥ 1.5 × 100); chunk 1 = [h4, h2] (204 ≥ 150); chunk 2 = [h3]
    assert.deepEqual(toc.map((t) => [t.title.length > 30 ? t.title.length : t.title, t.level, t.c, t.b]),
      [['One Line', 1, 0, 0], [120, 2, 1, 1], ['spaced', 3, 2, 0]]);
    assert.ok(toc[1].title.endsWith('\u2026'));
    assert.equal(tocTruncated, false);
  });
  test('TOC falls back to level 4 when there are no headings \u2264 3; caps at 2000', () => {
    assert.deepEqual(chunkBlocks([head(4, 'a'), head(5, 'b')]).toc.map((t) => t.title), ['a']);
    const bs = Array.from({ length: 2100 }, (_, i) => head(2, `h${i}`));
    const r = chunkBlocks(bs);
    assert.equal(r.toc.length, 2000);
    assert.equal(r.tocTruncated, true);
  });
  test('empty book yields one placeholder chunk', () => {
    const r = chunkBlocks([]);
    assert.equal(r.chunks.length, 1);
    assert.deepEqual(r.chunks[0].blocks, [{ t: 'p', r: [['(This book has no readable text.)', 0]] }]);
    assert.equal(r.chunks[0].start, 0);
    assert.equal(r.totalChars, r.chunks[0].chars);
    assert.deepEqual(r.toc, []);
  });
});

describe('imageSize', () => {
  const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  test('PNG', () => {
    assert.deepEqual(imageSize(png(80, 74)), { w: 80, h: 74 });
    assert.deepEqual(imageSize(png(70000, 3)), { w: 70000, h: 3 });
    assert.equal(imageSize(png(80, 74).subarray(0, 20)), null);
  });
  test('JPEG: skips APPn/DQT segments and fill bytes to the SOF', () => {
    const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
    const sof = (m) => seg(m, Buffer.from([8, 0x01, 0x2c, 0x02, 0x58, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.alloc(14)), seg(0xc4, Buffer.alloc(20)),
      Buffer.from([0xff]), seg(0xdb, Buffer.alloc(65)), sof(0xc2)]);
    assert.deepEqual(imageSize(jpg), { w: 600, h: 300 });
    const baseline = Buffer.concat([Buffer.from([0xff, 0xd8]), sof(0xc0)]);
    assert.deepEqual(imageSize(baseline), { w: 600, h: 300 });
    assert.equal(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.alloc(100))])), null);
  });
  test('GIF, BMP', () => {
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(321, 6);
    gif.writeUInt16LE(430, 8);
    assert.deepEqual(imageSize(gif), { w: 321, h: 430 });
    const bmp = Buffer.alloc(54);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(17, 18);
    bmp.writeInt32LE(-9, 22); // top-down bitmap
    assert.deepEqual(imageSize(bmp), { w: 17, h: 9 });
    const core = Buffer.alloc(26);
    core.write('BM', 0, 'latin1');
    core.writeUInt32LE(12, 14);
    core.writeUInt16LE(5, 18);
    core.writeUInt16LE(6, 20);
    assert.deepEqual(imageSize(core), { w: 5, h: 6 });
  });
  test('WebP VP8, VP8L, VP8X', () => {
    const riff = (fourcc, body) => {
      const b = Buffer.alloc(20 + body.length);
      b.write('RIFF', 0, 'latin1');
      b.writeUInt32LE(b.length - 8, 4);
      b.write('WEBP', 8, 'latin1');
      b.write(fourcc, 12, 'latin1');
      b.writeUInt32LE(body.length, 16);
      body.copy(b, 20);
      return b;
    };
    const vp8 = Buffer.alloc(20);
    Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8, 3);
    vp8.writeUInt16LE(400, 6);
    vp8.writeUInt16LE(300 | 0x4000, 8); // scale bits must be masked off
    assert.deepEqual(imageSize(riff('VP8 ', vp8)), { w: 400, h: 300 });
    const w = 1000;
    const h = 750;
    const bits = (w - 1) | ((h - 1) << 14);
    const vp8l = Buffer.alloc(10);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE(bits, 1);
    assert.deepEqual(imageSize(riff('VP8L', vp8l)), { w, h });
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(4999, 4, 3);
    vp8x.writeUIntLE(1, 7, 3);
    assert.deepEqual(imageSize(riff('VP8X', vp8x)), { w: 5000, h: 2 });
  });
  test('SVG: width/height with units, viewBox fallback', () => {
    const svg = (attrs) => Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`);
    assert.deepEqual(imageSize(svg('width="120" height="80px"')), { w: 120, h: 80 });
    assert.deepEqual(imageSize(svg('width="1in" height="72pt"')), { w: 96, h: 96 });
    assert.deepEqual(imageSize(svg('viewBox="0 0 354 600" width="100%" height="100%"')), { w: 354, h: 600 });
    assert.deepEqual(imageSize(svg("width='200' viewBox='0,0,100,50'")), { w: 200, h: 100 });
    assert.equal(imageSize(svg('width="100%"')), null);
  });
  test('unknown, empty and truncated input', () => {
    assert.equal(imageSize(Buffer.alloc(0)), null);
    assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
    assert.equal(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
    assert.equal(imageSize(null), null);
  });
  test('real PNG produced by zlib-compatible encoder', () => {
    // Minimal valid 2x3 RGBA PNG assembled here (signature, IHDR, IDAT, IEND).
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(3 * (1 + 2 * 4));
    const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    assert.deepEqual(imageSize(file), { w: 2, h: 3 });
  });
});

describe('real excerpts (fixtures extracted from the Gutenberg ZIM)', () => {
  test('The Elements of Style (37134)', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'elements-of-style-excerpt.html'), 'utf8');
    const { title, blocks: bs } = htmlToBlocks(html, { docPath: 'C/The Elements of Style.37134' });
    assert.equal(title, 'The Elements of Style');
    assert.deepEqual(validate(bs), []);
    const all = allText(bs);
    // zim nav, CSS, scripts and page numbers never leak into the text
    for (const junk of ['EPUB', 'fa-', 'zim', '{', 'pagenum', 'Page_']) assert.ok(!all.includes(junk), junk);
    assert.deepEqual(bs[0], { t: 'p', r: [["Transcriber's Notes:", 2]], a: 'c', id: 'tnote' });
    assert.deepEqual(bs[3], { t: 'h', l: 1, r: [['THE\n', 128], ['ELEMENTS OF STYLE', 0]] });
    assert.deepEqual(bs[4], { t: 'p', r: [['BY\n', 32], ['WILLIAM STRUNK, Jr.', 288]], a: 'c' });
    assert.deepEqual(bs.find((b) => b.t === 'img'), { t: 'img', src: 'C/37134_logo.png', w: 80, h: 74, id: 'img_images_logo.png' });
    const contents = bs.findIndex((b) => b.t === 'h' && text(b) === 'CONTENTS');
    assert.deepEqual(bs[contents], { t: 'h', l: 2, r: [['CONTENTS', 0]], id: 'Page_3' });
    const rows = bs.filter((b) => b.t === 'tr' && b.g === 1);
    assert.equal(rows.length, 26);
    assert.deepEqual(rows[1].c, [[['I.', 0]], [['Introductory', 32]], [['5', 0]]]);
    assert.deepEqual(rows[3].c[2], [['Form the possessive singular of nouns by adding ', 0], ["'s", 1]]);
    assert.ok(bs.some((b) => b.t === 'p' && text(b).includes('(Oxford University Press); George McLane Wood')));
    assert.ok(bs.some((b) => b.t === 'p' && b.id === 'Page_6'));
    const ins = bs.find((b) => text(b).startsWith('The writer\'s colleagues'));
    assert.deepEqual(ins.r.slice(0, 3), [["The writer's colleagues in the Department of English in Cornell University have greatly helped him in the preparation of his ", 0], ['manuscript.', 64], [` Mr. George McLane Wood has kindly consented to the inclusion under Rule${NBSP}10 of some material from his `, 0]]);
    // examples in div.example get the "smaller" bit from the book's own CSS (div.example { font-size: smaller })
    assert.deepEqual(bs.find((b) => text(b) === "Charles's friend"), { t: 'p', r: [["Charles's friend", 128]] });
    // the Browning excerpt: one verse block per stanza, indent4 → 8 NBSP
    const poems = bs.filter((b) => b.v === 1);
    assert.equal(poems.length, 2);
    assert.equal(text(poems[0]).split('\n').length, 7);
    assert.ok(text(poems[0]).startsWith("Sir, 'twas all one! My favour at her breast,\nThe dropping"));
    assert.ok(text(poems[1]).startsWith(`${NBSP.repeat(8)}Notice Neptune, though,\nTaming`));
    assert.ok(poems.every((b) => b.r.every((r) => r[1] === 128))); // .poetry { font-size: smaller }
    const { chunks, toc } = chunkBlocks(bs);
    assert.equal(chunks.length, 1);
    assert.deepEqual(toc.slice(0, 5).map((t) => [t.title, t.level]), [
      ['THE ELEMENTS OF STYLE', 1], ['CONTENTS', 2], ['I. INTRODUCTORY', 2], ['II. ELEMENTARY RULES OF USAGE', 2],
      ["1. Form the possessive singular of nouns by adding 's.", 3],
    ]);
  });

  test('Lest We Forget (36634): poems with page markers, TOC table, images', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'lest-we-forget-excerpt.html'), 'utf8');
    const { title, blocks: bs } = htmlToBlocks(html, { docPath: 'C/Lest We Forget: World War Stories.36634' });
    assert.equal(title, 'Lest We Forget: World War Stories');
    assert.deepEqual(validate(bs), []);
    const all = allText(bs);
    for (const junk of ['[44]', '[v]', '[vi]', 'ToC', 'EPUB']) assert.ok(!all.includes(junk), junk);
    const recessional = bs.findIndex((b) => b.t === 'h' && text(b) === 'RECESSIONAL');
    assert.deepEqual(bs[recessional + 1], {
      t: 'p', v: 1,
      r: [[`God of our fathers, known of old,\n${NBSP.repeat(4)}Lord of our far-flung battle-line,\nBeneath whose awful Hand we hold\n${NBSP.repeat(4)}Dominion over palm and pine\u2014\nLord God of Hosts, be with us yet,\nLest we forget\u2014lest we forget!`, 0]],
    });
    assert.equal(text(bs[recessional + 4]), `${NBSP.repeat(20)}RUDYARD KIPLING`); // span.i10
    const frontis = bs.find((b) => b.t === 'img' && b.src === 'C/36634_frontis.jpg');
    assert.equal(frontis.alt, '"Not My Soul"');
    const toc = bs.filter((b) => b.t === 'tr');
    assert.equal(toc.length, 48);
    assert.ok(toc.every((r) => r.g === toc[0].g));
    assert.deepEqual(toc[6].c, [[['6.', 0]], [['And the Cock Crew', 32]], [['Amelia Josephine Burr', 1]], [['57', 0]]]);
    assert.deepEqual(bs.find((b) => b.t === 'h' && text(b).startsWith('CARDINAL')), { t: 'h', l: 3, r: [['CARDINAL MERCIER', 0]] });
    const invictus = bs.find((b) => b.id === 'Page_44');
    assert.equal(invictus.v, 1);
    assert.ok(text(invictus).startsWith('It matters not how strait the gate,\n' + NBSP.repeat(4) + 'How charged'));
    assert.ok(bs.some((b) => b.t === 'p' && b.id === 'Page_vi' && text(b).startsWith('It may be used as a reading book')));
    assert.deepEqual(bs.find((b) => b.t === 'h' && text(b) === 'PREFACE'), { t: 'h', l: 3, r: [['PREFACE', 0]], id: 'PREFACE' });
  });
});

describe('robustness', () => {
  test('garbage and edge inputs never throw', () => {
    for (const html of ['', '<', '<<>>', '</p></div></table>', '<table><td>x', '<li>', '<pre>', '<svg><p>x', '&#xD800;&#0;', '<p>'.repeat(5000)]) {
      assert.doesNotThrow(() => htmlToBlocks(html, { docPath: 'C/x' }), html.slice(0, 20));
    }
    assert.deepEqual(blocks('<table><td>x'), [{ t: 'p', r: [['x', 0]] }]);
  });
  test('deep nesting and large documents convert in linear time', () => {
    const deep = '<div><span>'.repeat(3000) + 'deep' + '</span></div>'.repeat(3000);
    assert.deepEqual(blocks(deep), [{ t: 'p', r: [['deep', 0]] }]);
    const para = '<p>Lorem <i>ipsum</i> dolor sit amet, <b>consectetur</b> adipiscing elit.<br/>Second line.</p>\n';
    const big = '<html><body>' + para.repeat(40000) + '</body></html>'; // ~3.6 MB
    const t0 = performance.now();
    const bs = blocks(big);
    const ms = performance.now() - t0;
    assert.equal(bs.length, 40000);
    assert.ok(ms < 4000, `took ${ms} ms`);
  });
});
