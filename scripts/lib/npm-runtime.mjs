import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// npm is adjacent to node.exe on Windows, but under prefix/lib on official
// Unix Node distributions (including actions/setup-node). Never invoke a shell.
export function resolveNpmCli(execPath = process.execPath) {
  const binary = existsSync(execPath) ? realpathSync(execPath) : execPath;
  const bin = dirname(binary);
  const candidates = [
    join(bin, 'node_modules/npm/bin/npm-cli.js'),
    join(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    join(bin, '../share/nodejs/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  throw new Error('DEPLOY_NPM_RUNTIME_REQUIRED');
}
