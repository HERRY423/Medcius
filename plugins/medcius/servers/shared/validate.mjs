// Medcius JSON-Schema-subset validator.
//
// Implements the keywords the tool and table schemas actually use — type
// (single or list), anyOf, enum, pattern, minLength/maxLength, minimum/
// maximum, minItems/maxItems, items, properties, required. One recursive walk
// driven by the schema itself; every failure names the path and the violated
// rule so the caller (a model) can correct and resend.

/** @typedef {Record<string, unknown>} Schema */

function complain(path, detail) {
  throw new Error(`${path || "arguments"} ${detail}`);
}

const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Validate a value against a schema; throws on the first violation.
 * @param {Schema} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {void}
 */
export function check(schema, value, path = "") {
  if (Array.isArray(schema.anyOf)) {
    const reasons = [];
    for (const variant of schema.anyOf) {
      try {
        check(variant, value, path);
        return;
      } catch (e) {
        reasons.push(e.message);
      }
    }
    complain(path, `matches none of the allowed forms (${reasons.join(" | ")})`);
  }

  const wanted =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (wanted.length && !wanted.some((t) => TYPES[t]?.(value)))
    complain(path, `must be ${wanted.join(" or ")}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    complain(path, `must be one of: ${schema.enum.join(", ")}`);

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      complain(path, `must be at least ${schema.minLength} character(s)`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      complain(path, `does not match required pattern ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      complain(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      complain(path, `must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      complain(path, `needs at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      complain(path, `allows at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`));
  }
  if (TYPES.object(value) && schema.properties) {
    for (const key of /** @type {string[]} */ (schema.required) ?? [])
      if (value[key] === undefined) complain(path, `is missing required field '${key}'`);
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) check(sub, value[key], path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Validate against an object schema, then return only the schema-declared
 * properties (unknown keys are dropped — handlers rely on this when they
 * rest-spread their arguments).
 * @param {string} name
 * @param {Schema} schema
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function checkAndStrip(name, schema, value) {
  const input = value ?? {};
  try {
    check(schema, input);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`, { cause: e });
  }
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of Object.keys(schema.properties ?? {})) if (input[key] !== undefined) out[key] = input[key];
  return out;
}
