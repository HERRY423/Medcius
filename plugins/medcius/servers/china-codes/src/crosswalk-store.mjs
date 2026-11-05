import { db, tx } from './db.mjs';
import { validateCrosswalk, terminologyDigest } from '../../../lib/terminology-crosswalk.mjs';
import { createHash } from 'node:crypto';

// Local operator import only. Never exposed as a writable MCP tool.
export function importCrosswalk(pack, { expected_digest, review_id, source_bytes } = {}) {
  validateCrosswalk(pack);
  const digest = terminologyDigest(pack);
  if (digest !== expected_digest || typeof review_id !== 'string' || !review_id.trim()) throw new Error('CROSSWALK_REVIEW_BINDING_REQUIRED');
  const sourceVerified = source_bytes instanceof Uint8Array && createHash('sha256').update(source_bytes).digest('hex') === pack.source.sha256;
  if (pack.data_class === 'official' && !sourceVerified) throw new Error('CROSSWALK_SOURCE_BYTES_REQUIRED');
  return tx(() => {
    const prior = db.prepare('SELECT digest FROM terminology_crosswalk_packs WHERE pack_id=?').get(pack.pack_id);
    if (prior && prior.digest !== digest) throw new Error('CROSSWALK_IMMUTABLE_PACK_CONFLICT');
    if (!prior) db.prepare('INSERT INTO terminology_crosswalk_packs(pack_id,digest,data_class,region,review_id,payload) VALUES(?,?,?,?,?,?)')
      .run(pack.pack_id, digest, pack.data_class, pack.region, review_id, JSON.stringify(pack));
    return { pack_id: pack.pack_id, digest, source_hash_verified: sourceVerified, status: prior ? 'already_present' : 'imported', production_ready: false };
  });
}
export function loadCrosswalk(packId) {
  const row = db.prepare('SELECT * FROM terminology_crosswalk_packs WHERE pack_id=?').get(packId);
  if (!row) return null;
  const pack = validateCrosswalk(JSON.parse(row.payload));
  if (terminologyDigest(pack) !== row.digest) throw new Error('CROSSWALK_INTEGRITY_FAILURE');
  return pack;
}
export function crosswalkInventory() {
  return db.prepare('SELECT pack_id,digest,data_class,region,review_id,imported_at FROM terminology_crosswalk_packs ORDER BY pack_id').all();
}
