#!/usr/bin/env python3
"""Regenerates the .xz fixtures used by test/xz.test.js (and the xz ZIM cluster fixture).

Each fixture is <name>.xz plus <name>.sha256 (hex SHA-256 of the expected decompressed bytes).
Only the Python standard library is needed; the multi-block fixtures additionally need the `xz`
command line tool (Git for Windows ships it), because Python's lzma module always writes a
single block per stream.

All input data is generated deterministically, so re-running produces the same expected hashes
(the .xz bytes may differ between liblzma versions, which is fine).

Usage:  python test/fixtures/xz/generate.py
"""
import hashlib
import json
import lzma
import os
import random
import shutil
import struct
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

WORDS = ('the of and to a in that is was he for it with as his on be at by had not are but from or '
         'have an they which one you were her all she there would their we him been has when who will '
         'more no if out so said what up its about into than them can only other new some could time '
         'these two may then do first any my now such like our over man me even most made after also '
         'did many before must through back years where much your way well down should because each '
         'just those people how too little state good very make world still own see men work long get '
         'here between both life being under never day same another know while last might us great old '
         'year off come since against go came right used take three dictionary grammar spelling word '
         'sentence vowel consonant syllable pronunciation orthography etymology idiom phrase clause '
         'adjective adverb preposition conjunction interjection participle gerund infinitive').split()


def text(n, seed):
    """Pseudo-English text with a Zipf-ish word distribution, punctuation and line breaks."""
    rnd = random.Random(seed)
    weights = [1.0 / (i + 1) for i in range(len(WORDS))]
    out = []
    size = 0
    sentence = 0
    while size < n:
        w = rnd.choices(WORDS, weights)[0]
        if sentence == 0:
            w = w.capitalize()
        sentence += 1
        if sentence > rnd.randint(6, 18):
            w += rnd.choice('.....!?;:')
            sentence = 0
        if rnd.random() < 0.01:
            w += ' ' + str(rnd.randint(1, 1900))
        if rnd.random() < 0.004:
            w += ' æsthetic naïve café — \U0001d518\U0001d52b\U0001d526'
        out.append(w)
        size += len(w.encode('utf-8')) + 1
        if rnd.random() < 0.06:
            out.append('\n')
    return ' '.join(out).encode('utf-8')[:n]


def html(n, seed):
    """Paragraphs of text() wrapped in typical book markup."""
    rnd = random.Random(seed)
    parts = []
    size = 0
    i = 0
    while size < n:
        para = text(rnd.randint(200, 1500), seed * 100000 + i).decode('utf-8', 'ignore').replace('\n', ' ')
        i += 1
        if rnd.random() < 0.05:
            p = f'<h2 id="chap{i}">CHAPTER {i}</h2>\n'
        elif rnd.random() < 0.1:
            p = (f'<div class="poem"><div class="stanza"><span class="i0">{para[:60]}<br /></span>\n'
                 f'<span class="i2">{para[60:120]}<br /></span></div></div>\n')
        else:
            p = f'<p class="calibre1"><a class="pagenum" id="Page_{i}" title="{i}"> </a>{para}</p>\n'
        parts.append(p)
        size += len(p.encode('utf-8'))
    return ''.join(parts).encode('utf-8')[:n]


def rand_bytes(n, seed):
    return random.Random(seed).randbytes(n)


def ints_le(n, seed):
    """Little-endian 32-bit integers with small deltas: structured binary for lp/pb tests."""
    rnd = random.Random(seed)
    v = 0
    parts = []
    for _ in range(n // 4):
        v = (v + rnd.randint(0, 300)) & 0xFFFFFFFF
        parts.append(struct.pack('<I', v))
    return b''.join(parts)


def write(name, xz_bytes, data):
    with open(os.path.join(HERE, name + '.xz'), 'wb') as f:
        f.write(xz_bytes)
    with open(os.path.join(HERE, name + '.sha256'), 'w', newline='\n') as f:
        f.write(hashlib.sha256(data).hexdigest() + '\n')
    print(f'{name:24s} {len(data):9d} -> {len(xz_bytes):8d}')


def xz(data, preset=6, check=lzma.CHECK_CRC64, filters=None):
    if filters is not None:
        return lzma.compress(data, format=lzma.FORMAT_XZ, check=check, filters=filters)
    return lzma.compress(data, format=lzma.FORMAT_XZ, check=check, preset=preset)


def lzma2(dict_size=1 << 20, lc=3, lp=0, pb=2, preset=6):
    return [{'id': lzma.FILTER_LZMA2, 'preset': preset, 'dict_size': dict_size, 'lc': lc, 'lp': lp, 'pb': pb}]


def xz_cli(data, *args):
    exe = shutil.which('xz')
    if not exe:
        return None
    return subprocess.run([exe, '-c', *args], input=data, stdout=subprocess.PIPE, check=True).stdout


def main():
    small = b'Hello, xz! The quick brown fox jumps over the lazy dog.\n'
    write('small_text', xz(small), small)
    write('empty', xz(b''), b'')
    write('one_byte', xz(b'A'), b'A')

    rep = (b'abcabcabd' * 50000) + bytes(300000)
    write('repeated', xz(rep, preset=9 | lzma.PRESET_EXTREME), rep)

    rnd = rand_bytes(100000, 1)
    write('random', xz(rnd), rnd)

    # Text / incompressible / text again: LZMA chunks, then uncompressed chunks without a dict
    # reset, then LZMA chunks that match against text before the uncompressed chunks.
    t1 = text(60000, 2)
    mixed = t1 + rand_bytes(70000, 3) + t1[1000:40000] + text(20000, 4)
    write('mixed_chunks', xz(mixed), mixed)

    med = text(150000, 5)
    write('preset0', xz(med, preset=0), med)
    write('preset6', xz(med, preset=6), med)
    write('preset9e', xz(med, preset=9 | lzma.PRESET_EXTREME), med)

    chk = text(50000, 6)
    write('check_none', xz(chk, check=lzma.CHECK_NONE), chk)
    write('check_crc32', xz(chk, check=lzma.CHECK_CRC32), chk)
    write('check_crc64', xz(chk, check=lzma.CHECK_CRC64), chk)
    write('check_sha256', xz(chk, check=lzma.CHECK_SHA256), chk)

    ints = ints_le(120000, 7)
    write('lc0_lp2_pb0', xz(ints, filters=lzma2(lc=0, lp=2, pb=0)), ints)
    write('lc4_lp0_pb4', xz(ints, filters=lzma2(lc=4, lp=0, pb=4)), ints)
    write('lc1_lp3_pb1', xz(ints, filters=lzma2(lc=1, lp=3, pb=1)), ints)
    lctext = text(80000, 8)
    write('lc4_text', xz(lctext, filters=lzma2(lc=4, lp=0, pb=0)), lctext)

    small_dict = text(100000, 9)
    write('dict_4k', xz(small_dict, filters=lzma2(dict_size=4096)), small_dict)
    # Long-distance repeat (distance ~250 KB): exercises direct bits + align bits of distances.
    far = text(250000, 10)
    far = far + far[:120000]
    write('dict_64m', xz(far, filters=lzma2(dict_size=64 << 20, preset=9)), far)

    a = text(30000, 11)
    b = text(20000, 12)
    write('concat', xz(a) + xz(b, check=lzma.CHECK_CRC32), a + b)
    write('padded', xz(a) + bytes(8) + xz(b) + bytes(4), a + b)

    mb = text(300000, 13)
    out = xz_cli(mb, '--block-size=64KiB', '-6')
    if out is not None:
        write('multiblock', out, mb)
        # Multi-threaded mode also stores sizes in the block headers; mix in incompressible data.
        mb2 = text(80000, 14) + rand_bytes(40000, 15) + text(80000, 16)
        write('multiblock_mt', xz_cli(mb2, '-T2', '--block-size=50000', '--check=sha256'), mb2)
    else:
        print('xz CLI not found: multi-block fixtures not generated')

    # ~3 MB of HTML-ish text for the speed test (like a ZIM cluster of book pages).
    big = html(3 * 1024 * 1024, 17)
    write('speed_3mb', xz(big, preset=6), big)

    # A ZIM cluster body compressed with xz (as libzim does: LZMA2, CRC32 check): offset table +
    # blobs. test/zim.test.js rebuilds the same blobs and asserts the decompressed body matches.
    blobs = [b'xz blob zero', b'', ('xz cluster text ' * 400).encode(), text(5000, 18)]
    off = 4 * (len(blobs) + 1)
    table = []
    for bl in blobs:
        table.append(struct.pack('<I', off))
        off += len(bl)
    table.append(struct.pack('<I', off))
    body = b''.join(table) + b''.join(blobs)
    write('zim_cluster', xz(body, check=lzma.CHECK_CRC32, preset=6), body)
    with open(os.path.join(HERE, 'zim_cluster.json'), 'w', newline='\n') as f:
        json.dump({'blobsSha256': [hashlib.sha256(bl).hexdigest() for bl in blobs],
                   'blobLengths': [len(bl) for bl in blobs]}, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
