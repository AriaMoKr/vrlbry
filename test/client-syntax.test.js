// Every client module parses. Most are run by other tests, but some only in a browser (they import
// three, the DOM or the canvas): a syntax error there would reach the page first.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');

function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? modules(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

const check = (file) => new Promise((resolve) => {
  execFile(process.execPath, ['--check', file], (err, _out, stderr) => resolve(err ? `${path.relative(PUBLIC, file)}: ${stderr.split('\n').find((l) => /Error/.test(l)) ?? err.message}` : null));
});

describe('client modules', () => {
  it('all parse', async () => {
    const files = modules(PUBLIC);
    assert.ok(files.length > 40, `${files.length} modules`);
    const failed = [];
    for (let i = 0; i < files.length; i += 8) failed.push(...(await Promise.all(files.slice(i, i + 8).map(check))).filter(Boolean));
    assert.deepEqual(failed, []);
  });
});
