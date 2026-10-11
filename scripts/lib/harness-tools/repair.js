'use strict';

/**
 * Repair a harness tool call's arguments against the tool's input schema
 * (registry.js) before they are checked (validate.js). Callers often send a
 * number or a boolean as a string ("3", "true"); this turns those, and only
 * those, into the value the schema declares:
 *
 *   - a string that is exactly a JSON integer literal ("3", "-2") becomes a
 *     number where the schema (or one of its anyOf forms) takes an integer
 *     or a number; a decimal literal ("1.5") only where it takes a number.
 *     No exponent, hex, leading zeros, spaces inside, or "+"; surrounding
 *     spaces and tabs (only) are ignored; an integer must be a safe integer.
 *   - "true" / "false" (also with surrounding spaces) become booleans where
 *     the schema takes a boolean.
 *   - inside objects (declared properties) and arrays (items), the same.
 *
 * A string the schema already accepts as it is (e.g. "daily" in an enum, or
 * any string where the schema takes a string) is never changed. Nothing else
 * is changed either: no key is added or dropped, nothing is parsed out of a
 * string. The repaired value is then validated as usual, so a repaired value
 * out of range is still refused. Never mutates its input.
 */

const { validate } = require('./validate');

const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)\.\d+$/;
const MAX_DEPTH = 16;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The scalar types a schema takes, through anyOf. */
function types(schema, depth = 0) {
  const out = new Set();
  if (!isObject(schema) || depth > MAX_DEPTH) return out;
  if (typeof schema.type === 'string') out.add(schema.type);
  if (Array.isArray(schema.anyOf)) for (const s of schema.anyOf) for (const t of types(s, depth + 1)) out.add(t);
  return out;
}

/** The number or boolean a string stands for under this schema, or the string itself. */
function scalar(schema, v) {
  const t = types(schema);
  const s = v.replace(/^[ \t]+|[ \t]+$/g, '');
  let coerced;
  if ((t.has('integer') || t.has('number')) && INTEGER.test(s) && Number.isSafeInteger(Number(s))) coerced = Number(s);
  else if (t.has('number') && DECIMAL.test(s) && Number.isFinite(Number(s))) coerced = Number(s);
  else if (t.has('boolean') && (s === 'true' || s === 'false')) coerced = s === 'true';
  else return v;
  // A string the schema takes as it is (with or without the spaces) stays a string.
  return validate(schema, v).length === 0 || validate(schema, s).length === 0 ? v : coerced;
}

function walk(schema, v, depth) {
  if (!isObject(schema) || depth > MAX_DEPTH) return v;
  if (typeof v === 'string') return scalar(schema, v);
  if (Array.isArray(v)) {
    if (!isObject(schema.items) || schema.type !== 'array') return v;
    return v.map(x => walk(schema.items, x, depth + 1));
  }
  if (isObject(v) && schema.type === 'object' && isObject(schema.properties)) {
    const out = { ...v };
    for (const k of Object.keys(v)) if (own(schema.properties, k)) out[k] = walk(schema.properties[k], v[k], depth + 1);
    return out;
  }
  return v;
}

/** The arguments with numbers and booleans sent as strings turned into what the schema declares. */
function repair(schema, value) {
  return walk(schema, value, 0);
}

module.exports = { repair };
