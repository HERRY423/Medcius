// Explicit local import; no download and no mutation tool in the MCP surface.
import { readFileSync, statSync } from 'node:fs';
import { importCrosswalk } from '../plugins/medcius/servers/china-codes/src/crosswalk-store.mjs';
const [file, expected_digest, review_id, source_file] = process.argv.slice(2);
try {
  if (!file || !expected_digest || !review_id || statSync(file).size > 32 * 1024 * 1024) throw new Error('IMPORT_ARGUMENT_OR_SIZE_INVALID');
  if (source_file && statSync(source_file).size > 32 * 1024 * 1024) throw new Error('SOURCE_SIZE_INVALID');
  console.log(JSON.stringify(importCrosswalk(JSON.parse(readFileSync(file, 'utf8')), { expected_digest, review_id,
    source_bytes: source_file ? readFileSync(source_file) : undefined })));
} catch { console.error('Crosswalk import rejected; check size, schema, digest, review ID and immutable pack ID. No source content logged.'); process.exitCode = 1; }
