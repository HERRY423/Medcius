import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveNpmCli } from '../scripts/lib/npm-runtime.mjs';

for (const [name, binary, cli] of [
  ['Windows distribution', 'node.exe', 'node_modules/npm/bin/npm-cli.js'],
  ['Unix distribution / setup-node', 'bin/node', 'lib/node_modules/npm/bin/npm-cli.js'],
  ['Debian system layout', 'bin/node', 'share/nodejs/npm/bin/npm-cli.js'],
]) test(`npm resolves without a shell: ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'medcius-npm-layout-'));
  try {
    for (const p of [binary, cli]) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), '// synthetic layout fixture\n');
    }
    assert.equal(resolveNpmCli(join(root, binary)), realpathSync(join(root, cli)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing npm blocks deployment rather than selecting an unrelated executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'medcius-no-npm-'));
  try { assert.throws(() => resolveNpmCli(join(root, 'node')), /DEPLOY_NPM_RUNTIME_REQUIRED/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
