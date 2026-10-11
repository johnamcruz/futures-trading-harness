'use strict';

/**
 * A small, dependency-free JSON Schema checker for the subset the harness
 * tools' input schemas use (registry.js):
 *
 *   type            'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
 *   enum            the value is one of these (strict equality)
 *   object          properties, required, additionalProperties (false or a schema)
 *   string          minLength, maxLength, pattern
 *   integer/number  minimum, maximum (finite numbers only)
 *   array           items, minItems, maxItems
 *   anyOf           at least one of these schemas
 *
 * validate(schema, value) -> [message]: empty when the value fits. Any other
 * schema keyword throws (a schema the checker can't enforce must not pass
 * silently). The checker never echoes a long value back: strings are clipped.
 */

const KNOWN = new Set(['type', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'anyOf', 'default']);

const show = v => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function fitsType(type, v) {
  if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'object') return typeOf(v) === 'object';
  if (type === 'array') return Array.isArray(v);
  if (type === 'string' || type === 'boolean') return typeof v === type;
  throw new Error(`validate: unsupported type ${type}`);
}

function check(schema, v, at, errors) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`validate: unsupported schema keyword ${k}`);
  const where = at || 'arguments';
  if (schema.anyOf) {
    if (!schema.anyOf.some(s => check(s, v, at, []).length === 0)) errors.push(`${where}: ${schema.description || 'does not fit any allowed form'} (got ${show(v)})`);
    return errors;
  }
  if (schema.type && !fitsType(schema.type, v)) {
    errors.push(`${where}: must be ${/^[aeiou]/.test(schema.type) ? 'an' : 'a'} ${schema.type} (got ${typeOf(v)})`);
    return errors;
  }
  if (schema.enum && !schema.enum.some(e => e === v)) errors.push(`${where}: must be one of ${schema.enum.map(show).join(', ')}`);
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${where}: at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errors.push(`${where}: at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${where}: must match ${schema.pattern} (got ${show(v)})`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${where}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${where}: at most ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${where}: at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${where}: at most ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, `${where}[${i}]`, errors));
  }
  if (typeOf(v) === 'object' && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!Object.prototype.hasOwnProperty.call(v, k)) errors.push(`${at ? `${at}.` : ''}${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      const name = `${at ? `${at}.` : ''}${k}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) check(props[k], x, name, errors);
      else if (schema.additionalProperties === false) errors.push(`${show(name)}: unknown argument${Object.keys(props).length ? ` (known: ${Object.keys(props).join(', ')})` : ' (this tool takes none)'}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, x, name, errors);
    }
  }
  return errors;
}

function validate(schema, value) {
  return check(schema, value, '', []);
}

module.exports = { validate };
