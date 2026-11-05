import { readFileSync } from 'node:fs';

// Runtime metadata follows the same product version as the host manifests.
export const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'),
).version;
