import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const descriptors = ['model_quantized.onnx', 'config.json', 'tokenizer.json'];
const metadataFields = ['model_id', 'revision', 'tenant_id', 'license', 'license_review_ref', 'clinical_validation_ref'];

export async function loadClinicalPhiManifest(directory, digest, baseline) {
  if (!isSha256(digest)) throw new Error('PHI_CLINICAL_NER_MANIFEST_PIN_REQUIRED');
  const bytes = await readFile(join(directory, 'clinical-model-manifest.json'));
  if (sha256(bytes) !== digest) throw new Error('PHI_CLINICAL_NER_MANIFEST_MISMATCH');
  const manifest = JSON.parse(bytes);
  if (manifest?.schema_version !== 'medcius.cn-clinical-phi-assets.v1'
    || manifest.model_kind !== 'clinical_phi_ner' || manifest.language !== 'zh-Hans'
    || metadataFields.some(field => typeof manifest[field] !== 'string' || !manifest[field].trim()
      || manifest[field].length > 256 || /[\r\n]/.test(manifest[field]))
    || [baseline.model_id, baseline.upstream_model].includes(manifest.model_id)
    || !manifest.files || Object.keys(manifest.files).length !== descriptors.length
    || !descriptors.every(name => isSha256(manifest.files[name]?.sha256)
      && Number.isSafeInteger(manifest.files[name].bytes) && manifest.files[name].bytes > 0)
    || manifest.files['model_quantized.onnx'].sha256 === baseline.files['model_quantized.onnx'].sha256) {
    throw new Error('PHI_CLINICAL_NER_MANIFEST_INVALID');
  }
  if (!['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0'].includes(manifest.license)) {
    throw new Error('PHI_CLINICAL_NER_PERMISSIVE_LICENSE_REQUIRED');
  }
  return manifest;
}

export function validateClinicalPhiLabels(labels) {
  const classes = ['PERSON', 'ADDRESS', 'ORGANIZATION', 'CONTACT', 'IDENTIFIER'];
  const tags = Object.values(labels);
  if (!tags.includes('O') || new Set(tags).size !== tags.length
    || tags.some((tag, index) => labels[index] !== tag)
    || tags.some(tag => typeof tag !== 'string'
      || (tag !== 'O' && !/^[BIESUL]-(PERSON|ADDRESS|ORGANIZATION|CONTACT|IDENTIFIER)$/.test(tag)))
    || !classes.every(label => tags.some(tag => tag.endsWith('-' + label)))) {
    throw new Error('PHI_CLINICAL_NER_LABEL_CONTRACT_INVALID');
  }
}
