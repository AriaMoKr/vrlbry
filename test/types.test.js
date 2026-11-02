// The page's modules type-checked as they are served (tsconfig.json: from their JSDoc, nothing
// built), the files that have joined with `// @ts-check`, as the template's test/types.test.js
// runs tsc: a failure shows tsc's own output. TypeScript is a devDependency here, so not finding it
// fails rather than skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

/** tsc on a project, failing with what it found. */
function check(project) {
  let tsc;
  try {
    tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  } catch {
    assert.fail('TypeScript is not installed: npm install');
  }
  try {
    execFileSync(process.execPath, [tsc, '-p', project, '--pretty', 'false'], { cwd: here, encoding: 'utf8' });
  } catch (e) {
    assert.fail(`tsc -p ${project}\n${e.stdout}${e.stderr}`);
  }
}

test('public/js/ type-checks: tsc -p tsconfig.json finds nothing in the files with // @ts-check', () => check('tsconfig.json'));
