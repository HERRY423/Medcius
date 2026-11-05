// P3 View-Database / Middleware Read-Only Connector (REG-ACTION-TRACKER R26).
//
// Covers the dominant form of legacy Chinese HIS integration: 信息科提供的只读
// 视图库 / 中间库账号（集成平台视图表、ETL 中间表）。The deployment injects a
// read-only SQL executor (`query`) bound to a whitelisted view account; this
// module performs no I/O itself and only ever BUILDS parameterized SELECT
// statements from a strict identifier whitelist. Any write shape is rejected
// before it can exist. Satisfies the ReadOnlyHospitalDataBridge connector
// contract (capabilities:["read"] + readPatient(context) -> six-field envelope).
//
// Security invariants (all fail-closed):
//   1. identifiers (table/column/order) must match /^[A-Za-z_][A-Za-z0-9_]*$/
//      — configuration itself can never inject SQL;
//   2. values only ever travel as bound parameters;
//   3. WHERE always forces tenant (multi-tenant isolation) and patient/encounter
//      scoping from the workflow context, never from caller-supplied strings;
//   4. the generated SQL is asserted to be a single SELECT statement.
// Row-level cross-patient contamination is re-checked by the bridge.

import { bindSourceOwnership } from "../clinical-boundary.mjs";
import { sourceLifecycle } from "./source-lifecycle.mjs";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const BRIDGE_KINDS = new Set(["patient", "encounter", "notes", "nis", "lis", "pacs", "his", "financial_access"]);

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new Error(`CONNECTOR_VIEWDB_IDENTIFIER_INVALID: ${label}=${JSON.stringify(value)}`);
  }
  return value;
}

function assertColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("CONNECTOR_VIEWDB_COLUMNS_REQUIRED");
  }
  return [...new Set(columns.map((column) => assertIdentifier(column, "column")))];
}

function buildSelectSql(config, context) {
  const select = [...new Set([...config.columns, config.patientColumn, config.encounterColumn, ...(config.tenantColumn ? [config.tenantColumn] : [])])];
  const params = [];
  const bind = value => {
    params.push(value);
    return config.dialect === 'postgresql' ? `$${params.length}` : config.dialect === 'sqlserver' ? `@p${params.length}` : config.dialect === 'oracle' ? `:${params.length}` : '?';
  };
  const top = config.dialect === 'sqlserver' ? `TOP (${bind(config.limit)}) ` : '';
  const where = [config.tenantColumn ? `${config.tenantColumn} = ${bind(context.tenant_id)}` : null,
    `${config.patientColumn} = ${bind(context.patient_id)}`,
    config.scope === 'patient' ? null : `${config.encounterColumn} = ${bind(context.encounter_id)}`].filter(Boolean);
  const sql = [
    `SELECT ${top}${select.join(", ")}`,
    `FROM ${config.table}`,
    `WHERE ${where.join(" AND ")}`,
    config.orderBy ? `ORDER BY ${config.orderBy}` : null,
    config.dialect === 'sqlserver' ? null : ['oracle', 'dameng'].includes(config.dialect) ? `FETCH FIRST ${bind(config.limit)} ROWS ONLY` : `LIMIT ${bind(config.limit)}`,
  ]
    .filter(Boolean)
    .join(" ");
  if (!/^SELECT\s/i.test(sql) || /;/.test(sql)) {
    throw new Error(`CONNECTOR_VIEWDB_SQL_SHAPE_REJECTED: ${sql.slice(0, 80)}`);
  }
  return { sql, params };
}

function buildEnvelope(connectorId, context, records, sourceVersion) {
  return {
    source_system: connectorId,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: new Date().toISOString(),
    source_version: sourceVersion,
    records,
    complete: records.complete !== false,
  };
}

/**
 * Create one read-only view-database connector.
 *
 * @param {object} options
 * @param {string} options.id - connector id (also the envelope source_system)
 * @param {string} options.kind - bridge kind (patient/encounter/lis/his/...)
 * @param {string} options.table - whitelisted view/table name
 * @param {string[]} options.columns - whitelisted column names (patient/encounter columns added automatically)
 * @param {(row: object, context: object) => object} [options.mapRow] - row -> bridge record; must keep `id`
 * @param {string} [options.patientColumn="patient_id"]
 * @param {string} [options.encounterColumn="encounter_id"]
 * @param {string|null} [options.tenantColumn="tenant_id"] - null requires fixedTenantId plus an externally isolated read-only account
 * @param {string|null} [options.fixedTenantId] reject any other tenant before query
 * @param {'sqlite'|'mysql'|'postgresql'|'sqlserver'|'oracle'} [options.dialect='sqlite']
 * @param {string|null} [options.schema] separately whitelisted database schema
 * @param {number} [options.timeoutMs=10000] hard timeout with AbortSignal
 * @param {number} [options.maxConcurrency=4] per-connector unresolved execution limit
 * @param {"encounter"|"patient"} [options.scope="encounter"]
 * @param {string} [options.orderBy] - whitelisted `<column> [ASC|DESC]`
 * @param {number} [options.limit=200]
 * @param {(sql: string, params: unknown[]) => Promise<Array<object>>} options.query - injected read-only executor
 * @param {string} [options.sourceVersion]
 */
export function createViewDbConnector(options) {
  const {
    id,
    kind,
    table,
    columns,
    mapRow = (row) => ({ ...row }),
    patientColumn = "patient_id",
    encounterColumn = "encounter_id",
    tenantColumn = "tenant_id",
    scope = "encounter",
    orderBy = null,
    limit = 200,
    query,
    sourceVersion = null,
    dialect = 'sqlite',
    schema = null,
    fixedTenantId = null,
    timeoutMs = 10000,
    maxConcurrency = 4,
    preserveRawLifecycle = true,
  } = options ?? {};

  if (typeof id !== "string" || !id.trim()) throw new Error("CONNECTOR_VIEWDB_ID_REQUIRED");
  if (!BRIDGE_KINDS.has(kind)) throw new Error(`CONNECTOR_VIEWDB_KIND_INVALID: ${kind}`);
  if (typeof query !== "function") throw new Error("CONNECTOR_VIEWDB_QUERY_REQUIRED");
  if (!["encounter", "patient"].includes(scope)) throw new Error("CONNECTOR_VIEWDB_SCOPE_INVALID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("CONNECTOR_VIEWDB_LIMIT_INVALID");
  if (!['sqlite', 'mysql', 'postgresql', 'sqlserver', 'oracle', 'dameng', 'oceanbase-mysql', 'oceanbase-oracle'].includes(dialect)) throw new Error('CONNECTOR_VIEWDB_DIALECT_INVALID');
  if (tenantColumn == null && (typeof fixedTenantId !== 'string' || !fixedTenantId.trim())) throw new Error('CONNECTOR_VIEWDB_FIXED_TENANT_REQUIRED');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('CONNECTOR_VIEWDB_TIMEOUT_INVALID');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) throw new Error('CONNECTOR_VIEWDB_CONCURRENCY_INVALID');

  const config = {
    table: schema == null ? assertIdentifier(table, 'table') : `${assertIdentifier(schema, 'schema')}.${assertIdentifier(table, 'table')}`,
    dialect: ({ 'oceanbase-mysql': 'mysql', 'oceanbase-oracle': 'oracle' })[dialect] ?? dialect,
    columns: assertColumns(columns),
    patientColumn: assertIdentifier(patientColumn, "patientColumn"),
    encounterColumn: assertIdentifier(encounterColumn, "encounterColumn"),
    tenantColumn: tenantColumn == null ? null : assertIdentifier(tenantColumn, "tenantColumn"),
    scope,
    orderBy: orderBy == null
      ? null
      : (() => {
          const match = /^([A-Za-z_][A-Za-z0-9_]{0,62})(?:\s+(ASC|DESC))?$/i.exec(String(orderBy).trim());
          if (!match) throw new Error(`CONNECTOR_VIEWDB_IDENTIFIER_INVALID: orderBy=${JSON.stringify(orderBy)}`);
          return `${match[1]}${match[2] ? ` ${match[2].toUpperCase()}` : ""}`;
        })(),
    limit,
  };
  let inflight = 0;

  return {
    id,
    kind,
    capabilities: ["read"],
    async readPatient(context) {
      for (const field of ["tenant_id", "patient_id", "encounter_id"]) {
        if (typeof context?.[field] !== "string" || !context[field].trim()) {
          throw new Error(`CONNECTOR_VIEWDB_CONTEXT_REQUIRED: ${field}`);
        }
      }
      if (fixedTenantId != null && context.tenant_id !== fixedTenantId) throw new Error('CONNECTOR_TENANT_MISMATCH');
      if (inflight >= maxConcurrency) throw new Error('CONNECTOR_VIEWDB_CONCURRENCY_LIMIT');
      const { sql, params } = buildSelectSql(config, context);
      const controller = new AbortController();
      let timer;
      inflight++;
      // Keep the slot occupied until the executor actually stops, even after timeout.
      const pending = Promise.resolve().then(() => query(sql, params, { signal: controller.signal, readOnly: true, dialect, sqlDialect: config.dialect }))
        .catch(() => { throw new Error('CONNECTOR_VIEWDB_QUERY_FAILED'); }).finally(() => { inflight--; });
      let rows;
      try {
        rows = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('CONNECTOR_VIEWDB_TIMEOUT'));
        }, timeoutMs); })]);
      } finally { clearTimeout(timer); }
      if (!Array.isArray(rows)) throw new Error(`CONNECTOR_VIEWDB_ROWS_INVALID: ${id}`);
      if (rows.length > config.limit) throw new Error('CONNECTOR_VIEWDB_ROW_LIMIT_EXCEEDED');
      const records = rows.map((row, index) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new Error(`CONNECTOR_VIEWDB_ROW_INVALID: ${id}[${index}]`);
        }
        const record = { ...(preserveRawLifecycle ? sourceLifecycle(row) : {}), ...mapRow(row, context) };
        if (!record?.id) throw new Error(`CONNECTOR_VIEWDB_RECORD_ID_REQUIRED: ${id}[${index}]`);
        const sourceId = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
        const sourcePatient = sourceId(row[config.patientColumn] ?? (kind === "patient" ? row.id : null));
        const sourceEncounter = sourceId(row[config.encounterColumn] ?? (kind === "encounter" ? row.id : null));
        return bindSourceOwnership(context, record, {
          patient_id: sourcePatient || null,
          encounter_id: sourceEncounter || null,
          tenant_id: config.tenantColumn ? sourceId(row[config.tenantColumn]) ?? null : null,
        }, {
          requirePatient: true,
          requireEncounter: kind !== "patient",
          policy: "query_scoped",
        });
      });
      // A full LIMIT-sized page does not prove the patient has no further rows.
      records.complete = rows.length < config.limit;
      return buildEnvelope(id, context, records, sourceVersion);
    },
  };
}

/** Deterministic default row mappers for the four standard view shapes. */
export const VIEWDB_ROW_MAPPERS = {
  patient: (row) => ({
    id: row.patient_id == null && row.id == null ? null : String(row.patient_id ?? row.id),
    name: row.name ?? null,
    gender: row.gender ?? row.sex ?? null,
    birth_date: row.birth_date ?? null,
  }),
  encounter: (row) => ({
    id: row.encounter_id == null && row.id == null ? null : String(row.encounter_id ?? row.id),
    status: row.status ?? null,
    class: row.encounter_class ?? null,
    period_start: row.admission_time ?? null,
    period_end: row.discharge_time ?? null,
  }),
  lis: (row) => ({
    id: row.id == null ? null : String(row.id),
    order_id: row.order_id ?? null,
    code: row.item_code ?? null,
    name: row.item_name ?? null,
    result_value: row.result_value ?? null,
    unit: row.unit ?? null,
    status: row.status ?? null,
    sample_time: row.sample_time ?? null,
    event_time: row.event_time ?? row.sample_time ?? null,
    reference_range_text: row.reference_range ?? null,
    is_critical: row.is_critical === 1 || row.is_critical === true || ["CR", "HH", "LL"].includes(String(row.abnormal_flag ?? "").toUpperCase()),
  }),
  his: (row) => ({
    id: row.id == null ? null : String(row.id),
    is_medication: true,
    drug_name: row.drug_name ?? null,
    dosage: row.dosage ?? null,
    route: row.route ?? null,
    frequency: row.frequency ?? null,
    authored_on: row.order_time ?? null,
    change_type: row.order_status ?? null,
    status: row.status ?? row.order_status ?? null,
  }),
};

/**
 * Create the standard four view-database connectors from one dialect config.
 * Dialect-specific deployments override `mappers` per kind or supply their own
 * `createViewDbConnector` configs.
 *
 * @param {object} options
 * @param {(sql: string, params: unknown[]) => Promise<Array<object>>} options.query
 * @param {object} options.tables - { patient, encounter, lis, his } view table names
 * @param {object} [options.columns] - per-kind whitelisted columns (falls back to mapper defaults)
 * @param {object} [options.mappers] - per-kind mapRow overrides
 */
export function createViewDbConnectors({ query, tables, columns = {}, mappers = {}, sourceVersion = null, limits = {},
  dialect = 'sqlite', schema = null, fixedTenantId = null, tenantColumn = 'tenant_id',
  patientColumn = 'patient_id', encounterColumn = 'encounter_id', timeoutMs = 10000, maxConcurrency = 4 }) {
  if (!tables || typeof tables !== "object") throw new Error("CONNECTOR_VIEWDB_TABLES_REQUIRED");
  const defs = [
    { id: "viewdb-patient", kind: "patient", scope: "patient", mapper: VIEWDB_ROW_MAPPERS.patient },
    { id: "viewdb-encounter", kind: "encounter", scope: "encounter", mapper: VIEWDB_ROW_MAPPERS.encounter },
    { id: "viewdb-lis", kind: "lis", scope: "encounter", mapper: VIEWDB_ROW_MAPPERS.lis },
    { id: "viewdb-his", kind: "his", scope: "encounter", mapper: VIEWDB_ROW_MAPPERS.his },
  ];
  const defaultColumns = {
    patient: ['patient_id', 'name', 'gender', 'birth_date'],
    encounter: ['encounter_id', 'status', 'encounter_class', 'admission_time', 'discharge_time'],
    lis: ['id', 'order_id', 'item_code', 'item_name', 'result_value', 'unit', 'status', 'sample_time', 'reference_range', 'is_critical'],
    his: ['id', 'drug_name', 'dosage', 'route', 'frequency', 'order_time', 'order_status'],
  };
  return defs.map(({ id, kind, scope, mapper }) => {
    const table = tables[kind];
    if (!table) throw new Error(`CONNECTOR_VIEWDB_TABLE_MISSING: ${kind}`);
    return createViewDbConnector({
      id,
      kind,
      table,
      columns: columns[kind] ?? defaultColumns[kind],
      mapRow: mappers[kind] ?? mapper,
      scope,
      query,
      sourceVersion,
      dialect, schema, fixedTenantId, tenantColumn, patientColumn, encounterColumn, timeoutMs, maxConcurrency,
      limit: limits[kind] ?? 200,
    });
  });
}
