// Stable launcher copied to the installation root. Resolve one immutable release
// before importing anything; an upgrade cannot mix modules in a running process.
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const active = JSON.parse(readFileSync(resolve(root, 'active-release.json'), 'utf8'));
if (!/^[0-9TZ-]+-[a-f0-9-]{36}$/.test(active.release)) throw new Error('DEPLOY_ACTIVE_RELEASE_INVALID');
const releases = resolve(root, 'releases');
const release = resolve(releases, active.release);
if (lstatSync(release).isSymbolicLink() || relative(realpathSync(releases), realpathSync(release)).startsWith(`..${sep}`))
  throw new Error('DEPLOY_ACTIVE_RELEASE_INVALID');
process.chdir(release);
await import(pathToFileURL(resolve(release, 'scripts/serve.mjs')).href);
