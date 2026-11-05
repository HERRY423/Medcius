// Pinned upstream validator. No network access or silent tool fallback.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('./vendor/openai-plugin-validator/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', root)));
for (const file of provenance.files) {
  const bytes = readFileSync(new URL(file.name, root));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error('PLUGIN_VALIDATOR_INTEGRITY_FAILED');
  }
}
const result = spawnSync(process.env.MEDCIUS_PYTHON || 'python',
  [fileURLToPath(new URL('validate_plugin.py', root)), process.argv[2] || 'plugins/medcius'],
  { stdio:'inherit', env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}, timeout:30000 });
if (result.error) console.error('PLUGIN_VALIDATOR_RUNTIME_UNAVAILABLE');
process.exit(result.status === 0 && !result.error ? 0 : 1);
