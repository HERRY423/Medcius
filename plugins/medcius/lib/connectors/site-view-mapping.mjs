// Declarative, data-only mapping. JSON is also the supported YAML 1.2 subset;
// arbitrary YAML tags, aliases, expressions, SQL fragments and code are rejected.
import { createViewDbConnector } from './viewdb-connector.mjs';
import { canonicalJson, sha256Hex } from '../../servers/shared/crypto.mjs';
import { ORDER_KINDS, EXECUTION_STATES } from '../order-execution.mjs';

const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const fields = new Set(('id patient_id encounter_id tenant_id name gender birth_date age status class period_start period_end '
  + 'version_id source_record_id updated_at recorded_at event_time resulted_at acknowledged_at acknowledged_version_id supersedes_id supersedes_version_id '
  + 'title text document_id content_type temperature systolic_bp diastolic_bp heart_rate spo2 respiratory_rate consciousness '
  + 'oral_intake_ml iv_intake_ml intake_ml output_ml urine_output_ml drain_output_ml drain_name drain_desc stool_count timestamp '
  + 'order_id code test_code test_name result_value unit ref_low ref_high reference_range_text is_critical sample_time '
  + 'is_medication drug_name dosage route frequency authored_on end_date stopped_at order_kind execution_status previous_execution_status '
  + 'record_kind administration_id performed_at administered_volume_ml order_type department purpose priority stop_reason '
  + 'modality study_time study_uid findings impression report_text ordered_at scheduled_time').split(' '));
const restrictedEnums = { order_kind: ORDER_KINDS, execution_status: EXECUTION_STATES, previous_execution_status: EXECUTION_STATES,
  record_kind: ['order', 'administration', 'nursing_measurement', 'planned_infusion', 'unknown'] };
const own = (o,k) => Object.hasOwn(o,k);
function fail(code) { throw new Error(`CONNECTOR_MAPPING_${code}`); }
function object(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('UNKNOWN_FIELD');
}
function safeName(name) { if (typeof name !== 'string' || !identifier.test(name)) fail('IDENTIFIER_INVALID'); return name; }
function offsetValid(value) { return typeof value === 'string' && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(value) && !/^[+-]14:(?!00)/.test(value); }
export function validateSiteViewMapping(input) {
  const mapping = typeof input === 'string' ? (() => {
    if (Buffer.byteLength(input) > 1024*1024) fail('SIZE_LIMIT');
    try { return JSON.parse(input); } catch { fail('JSON_YAML_SUBSET_REQUIRED'); }
  })() : structuredClone(input);
  keys(mapping, ['schema_version', 'mapping_id', 'version', 'tenant_id', 'data_class', 'review_ref', 'timezone_offset', 'views']);
  if (mapping.schema_version !== 1 || !['synthetic', 'site'].includes(mapping.data_class)
    || !['mapping_id', 'version', 'tenant_id'].every(k => typeof mapping[k] === 'string' && mapping[k].trim())
    || mapping.timezone_offset != null && !offsetValid(mapping.timezone_offset)) fail('HEADER_INVALID');
  if (!Array.isArray(mapping.views) || !mapping.views.length || mapping.views.length > 32) fail('VIEWS_INVALID');
  const ids = new Set();
  for (const view of mapping.views) {
    keys(view, ['id', 'kind', 'table', 'schema', 'scope', 'limit', 'order_by', 'fields']);
    safeName(view.id); safeName(view.table); if (view.schema != null) safeName(view.schema);
    if (ids.has(view.id)) fail('VIEW_ID_DUPLICATE'); ids.add(view.id);
    if (!['patient', 'encounter', 'notes', 'nis', 'lis', 'his', 'pacs'].includes(view.kind)) fail('KIND_INVALID');
    if (view.scope != null && !['patient', 'encounter'].includes(view.scope)) fail('SCOPE_INVALID');
    if (view.kind !== 'patient' && view.scope === 'patient') fail('ENCOUNTER_SCOPE_REQUIRED');
    if (view.limit != null && (!Number.isInteger(view.limit) || view.limit < 1 || view.limit > 1000)) fail('LIMIT_INVALID');
    if (view.order_by != null && !/^[A-Za-z_][A-Za-z0-9_]{0,62}(?: (?:ASC|DESC))?$/.test(view.order_by)) fail('ORDER_INVALID');
    if (!object(view.fields) || Object.keys(view.fields).length > 100) fail('FIELDS_INVALID');
    for (const key of ['id', 'patient_id', ...(view.kind === 'patient' ? [] : ['encounter_id'])]) {
      if (view.fields[key]?.type !== 'string' || view.fields[key].required !== true) fail('IDENTITY_MAPPING_REQUIRED');
    }
    for (const [field, def] of Object.entries(view.fields)) {
      if (!fields.has(field)) fail('TARGET_FIELD_INVALID');
      keys(def, ['column', 'type', 'required', 'values', 'format']); safeName(def.column);
      if (!['string', 'number', 'boolean', 'enum', 'datetime'].includes(def.type)) fail('TYPE_INVALID');
      if (def.required != null && typeof def.required !== 'boolean') fail('REQUIRED_INVALID');
      if (restrictedEnums[field] && def.type !== 'enum') fail('STATE_MAP_REQUIRED');
      if (['boolean', 'enum'].includes(def.type)) {
        if (!object(def.values) || !Object.keys(def.values).length || Object.keys(def.values).length > 1000) fail('ENUM_INVALID');
        for (const value of Object.values(def.values)) {
          if (def.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') fail('ENUM_VALUE_INVALID');
          if (restrictedEnums[field] && !restrictedEnums[field].includes(value)) fail('STATE_VALUE_INVALID');
        }
      } else if (def.values != null) fail('ENUM_TYPE_REQUIRED');
      if (def.type === 'datetime') {
        if (!['iso8601', 'local_datetime'].includes(def.format) || def.format === 'local_datetime' && !mapping.timezone_offset) fail('TIMEZONE_REQUIRED');
      } else if (def.format != null) fail('FORMAT_INVALID');
    }
  }
  return mapping;
}
function timestamp(raw, def, zone) {
  if (typeof raw !== 'string') return null; // configure the driver to return source timestamps, not machine-local Date coercions
  let value = raw;
  if (def.format === 'local_datetime') {
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) return null;
    value = `${value.replace(' ', 'T')}${zone}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = value.slice(0,10), date = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0,10) !== day
    || Number(value.slice(11,13)) > 23 || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
function convert(raw, def, zone) {
  if (raw == null || raw === '') return null;
  if (def.type === 'string') return typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : null;
  if (def.type === 'number') return (typeof raw === 'number' || typeof raw === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))
    && Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (def.type === 'datetime') return timestamp(raw, def, zone);
  return ['string','boolean','number'].includes(typeof raw) && own(def.values, String(raw)) ? def.values[String(raw)] : null;
}

export function createMappedViewConnectors({ mapping: input, query, fixedTenantId, dialect = 'sqlite',
  live = false, mappingApprovalVerifier = null, timeoutMs = 10000, maxConcurrency = 4 } = {}) {
  const mapping = validateSiteViewMapping(input), digest = sha256Hex(canonicalJson(mapping));
  if (mapping.tenant_id !== fixedTenantId) fail('TENANT_MISMATCH');
  if (live && (mapping.data_class !== 'site' || !mapping.review_ref || typeof mappingApprovalVerifier !== 'function'
    || mappingApprovalVerifier({ mapping: structuredClone(mapping), sha256: digest }) !== true)) fail('SITE_APPROVAL_REQUIRED');
  return mapping.views.map(view => {
    const connector = createViewDbConnector({ id: view.id, kind: view.kind, table: view.table, schema: view.schema,
      columns: Object.values(view.fields).map(f => f.column), patientColumn: view.fields.patient_id.column,
      encounterColumn: view.fields.encounter_id?.column ?? view.fields.patient_id.column,
      tenantColumn: view.fields.tenant_id?.column ?? null, fixedTenantId, dialect,
      sourceVersion: `${mapping.mapping_id}@${mapping.version}:${digest}`,
      scope: view.scope ?? (view.kind === 'patient' ? 'patient' : 'encounter'), limit: view.limit ?? 200,
      orderBy: view.order_by, timeoutMs, maxConcurrency, query,
      preserveRawLifecycle: false, // only mapped columns, including lifecycle, may enter a record
      mapRow(row) {
        const record = {}, gaps = [];
        for (const [field, def] of Object.entries(view.fields)) {
          const value = convert(own(row, def.column) ? row[def.column] : null, def, mapping.timezone_offset);
          if (value == null) {
            if (def.required) fail('REQUIRED_VALUE_UNAVAILABLE');
            if (row[def.column] != null && row[def.column] !== '') gaps.push({ field, reason: 'unmapped_or_invalid' });
          }
          record[field] = value == null && restrictedEnums[field] ? 'unknown' : value;
        }
        record.mapping_provenance = { mapping_id: mapping.mapping_id, version: mapping.version, sha256: digest,
          review_ref: mapping.review_ref ?? null, data_class: mapping.data_class, view_id: view.id,
          fields: Object.entries(view.fields).map(([field,def]) => ({ field, column: def.column })), gaps };
        return record;
      } });
    return { ...connector, async readPatient(context) {
      const result = await connector.readPatient(context);
      const gaps = result.records.flatMap(r => r.mapping_provenance.gaps);
      return { ...result, complete: result.complete && !gaps.length, parse_warnings: gaps };
    } };
  });
}
