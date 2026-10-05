// The GitHub Pages build (tools/build-pages.mjs): the client without the Node server, under a path.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsOf } from '../tools/build-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let out;
before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrlbry-pages-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-pages.mjs'), '--out', out], { cwd: ROOT });
});
after(() => fs.rmSync(out, { recursive: true, force: true }));

/** Every file under dir, relative, with forward slashes. */
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? files(path.join(dir, e.name), base)
    : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
}

describe('GitHub Pages build', () => {
  it('reads static, dynamic and re-exported imports, not those in comments', () => {
    const src = `import a from './a.js';\nimport './side.js';\nexport { b } from '../b.js';\nconst c = await import('./c.js');
      /* import { no } from './block.js'; */\n// import x from './line.js';\nimport * as THREE from 'three';`;
    assert.deepEqual(importsOf(src).sort(), ['../b.js', './a.js', './c.js', './side.js', 'three']);
  });

  it('builds the client, the vendor files it imports, and static API answers', () => {
    const all = files(out);
    assert.ok(all.includes('index.html') && all.includes('.nojekyll'));
    assert.ok(!all.some((f) => f.startsWith('dev/') || f === 'reader-test.html'), 'pages that need the server are left out');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'api', 'libraries'), 'utf8')), { generation: 0, libraries: [], static: true });
    const version = JSON.parse(fs.readFileSync(path.join(out, 'api', 'version'), 'utf8'));
    assert.equal(version.static, true);
    assert.ok(!Number.isNaN(Date.parse(version.changed)));
    for (const f of ['vendor/three/build/three.module.js', 'vendor/three/build/three.core.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js', 'vendor/iwer/iwer.module.js']) {
      assert.ok(all.includes(f), f);
    }
    // Under a path (https://<user>.github.io/vrlbry/), nothing may be addressed from the root.
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!/(?:href|src)="\//.test(html), 'no root-relative href/src');
    assert.ok(html.includes('"three":"./vendor/three/build/three.module.js"'));
    // Every relative import of every module resolves to a file that was built.
    for (const f of all.filter((x) => x.endsWith('.js'))) {
      for (const spec of importsOf(fs.readFileSync(path.join(out, f), 'utf8'))) {
        if (spec.startsWith('/')) assert.fail(`${f} imports ${spec} from the root`);
        if (!spec.startsWith('.')) continue;
        const target = path.relative(out, path.resolve(path.dirname(path.join(out, f)), spec)).split(path.sep).join('/');
        assert.ok(all.includes(target), `${f} → ${spec}`);
      }
    }
  });
});
