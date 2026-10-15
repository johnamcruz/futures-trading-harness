'use strict';

/**
 * The harness's committed config files: config/<name>.json, one file per area (config/schedule.json today), each
 * with its own schema. One loader for all of them, so every area fails the same way and is fingerprinted the same way:
 *
 * - Fail closed: a missing file, one that isn't JSON, or one its schema refuses throws a CriticalConfigError (a CRITICAL
 *   config error) naming the file and every problem at once, each with its key path, what is wrong and what is
 *   expected. Nothing falls back to a default: a caller that can't load its config refuses what it was asked to do.
 * - Fingerprint: the file's hash is the SHA-256 of its canonical JSON (keys sorted, no whitespace), so a reformat or
 *   a line-ending change is the same file and any change of a value is another. Runs and ledgers record it
 *   (fingerprintOf), so what each run and each look was taken under is on the record.
 * - Tighten only: a spec may mark keys (dotted paths) whose value may only tighten: 'down' (a ceiling, e.g. a look
 *   budget: lower is tighter), 'up' (a floor: higher is tighter), 'true' (a guard that stays on) or 'exact' (pinned:
 *   a value whose stricter direction differs by user, e.g. the gate's timing, may not change at all). A test pins each
 *   key's loosest value ever committed and refuses one past it (loosened), as tests/lib/prop-promotion.test.js
 *   pins the promotion gate's numbers.
 * - Shapes: shapeErrors(shape, value) checks a document against a declared shape (every key present, none unknown,
 *   each leaf its type and range), so a spec's validate can be one line (the `shapes` leaf builders).
 *
 * A spec: { name, validate(value) -> [error], tightenOnly: { 'a.b': 'down' | 'up' | 'true' | 'exact' } }.
 *
 *   CONFIG_DIR                          the repository's config/ directory
 *   canonicalJson(value)                the value as canonical JSON (keys sorted)
 *   hashOf(value)                       SHA-256 hex of canonicalJson(value)
 *   loadConfigFile(spec, { file })      { name, file, value (deep-frozen), hash }; throws a CriticalConfigError when
 *                                       missing, unreadable or refused
 *   CriticalConfigError                 the refusal: .refusals [{ name, file, problems }], .code 'FTH_CONFIG_CRITICAL';
 *                                       CriticalConfigError.of(errors, note): several as one (every problem listed)
 *   deepFreeze(value)                   the value, frozen all the way down
 *   fingerprintOf(loaded)               { name, version (the file's own `version`, or null), hash }
 *   valueAt(value, dotted)              the value at a dotted path (undefined when absent)
 *   loosened(spec, pinned, value)       [error] for each tighten-only key past its pinned value (or missing)
 *   shapes                              leaf builders: num({ min, max, int }), bool(), str(oneOf), list(item, { min, max }),
 *                                       record(item) (any keys, each an item), custom(check)
 *   shapeErrors(shape, value)           [error] for each key missing, unknown or out of its leaf's type or range
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');
const DIRECTIONS = Object.freeze(['down', 'up', 'true', 'exact']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hashOf = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

const CRITICAL = 'CRITICAL config error';

/** A refused config file (or several): every problem of every file, named by file and key path, in one message. */
class CriticalConfigError extends Error {
  constructor(refusals, note = '') {
    const lines = refusals.map(r => `the ${r.name} config (${r.file}) is refused: ${r.problems.join('; ')}; nothing that depends on it runs until it is fixed`);
    const count = refusals.reduce((n, r) => n + r.problems.length, 0);
    super(lines.length === 1 && !note
      ? `${CRITICAL}: ${lines[0]}`
      : `${CRITICAL} (${count} problem${count === 1 ? '' : 's'} in ${refusals.length} file${refusals.length === 1 ? '' : 's'}):\n${lines.join('\n')}${note ? `\n${note}` : ''}`);
    this.name = 'CriticalConfigError';
    this.code = 'FTH_CONFIG_CRITICAL';
    this.refusals = Object.freeze(refusals.map(r => Object.freeze({ ...r, problems: Object.freeze([...r.problems]) })));
  }

  /** Several refusals as one error (each file once), with a note on what still runs. */
  static of(errors, note = '') {
    const seen = new Map();
    for (const e of errors) for (const r of e.refusals) if (!seen.has(r.file)) seen.set(r.file, r);
    return new CriticalConfigError([...seen.values()], note);
  }
}

function checkSpec(spec) {
  if (!spec || typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(spec.name) || typeof spec.validate !== 'function') {
    throw new Error('a config spec: { name (lower-case), validate(value) -> [error], tightenOnly }');
  }
  for (const [k, dir] of Object.entries(spec.tightenOnly || {})) {
    if (!DIRECTIONS.includes(dir)) throw new Error(`${spec.name} config spec: tighten-only ${k} is ${String(dir)}, not one of ${DIRECTIONS.join(', ')}`);
  }
}

/** Load, parse and validate one config file. Throws (fail closed) on anything but a valid file. */
function loadConfigFile(spec, { file = null } = {}) {
  checkSpec(spec);
  const where = file || path.join(CONFIG_DIR, `${spec.name}.json`);
  const refuse = why => { throw new CriticalConfigError([{ name: spec.name, file: where, problems: Array.isArray(why) ? why : [why] }]); };
  let text;
  try { text = fs.readFileSync(where, 'utf8'); } catch (e) { return refuse(`it can't be read (${e.code || e.message})`); }
  let value;
  try { value = JSON.parse(text); } catch (e) { return refuse(`not JSON (${e.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('not a JSON object');
  let errors;
  try { errors = spec.validate(value); } catch (e) { errors = [e.message]; }
  if (!Array.isArray(errors)) errors = ['its schema check returned no list of errors'];
  if (errors.length) refuse(errors);
  return Object.freeze({ name: spec.name, file: where, value: deepFreeze(value), hash: hashOf(value) });
}

const fingerprintOf = loaded => Object.freeze({
  name: loaded.name, version: typeof loaded.value.version === 'string' ? loaded.value.version : null, hash: loaded.hash,
});

function valueAt(value, dotted) {
  let v = value;
  for (const k of String(dotted).split('.')) {
    if (!v || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/** The tighten-only keys past their pinned values: each key must be present and no looser than its pin. */
function loosened(spec, pinned, value) {
  checkSpec(spec);
  const out = [];
  const keys = Object.entries(spec.tightenOnly || {});
  for (const [k, dir] of keys) {
    if (!Object.prototype.hasOwnProperty.call(pinned || {}, k)) { out.push(`${spec.name}: tighten-only ${k} has no pinned value`); continue; }
    const pin = pinned[k];
    const v = valueAt(value, k);
    if (dir === 'true') {
      if (v !== true) out.push(`${spec.name}: ${k} is ${JSON.stringify(v)}; it is a guard that stays true`);
      continue;
    }
    if (dir === 'exact') {
      if (canonicalJson(v) !== canonicalJson(pin)) out.push(`${spec.name}: ${k} is ${JSON.stringify(v)}, not its pinned ${JSON.stringify(pin)}; it is pinned exactly`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) { out.push(`${spec.name}: ${k} is ${JSON.stringify(v)}, not a number`); continue; }
    if (dir === 'down' && v > pin) out.push(`${spec.name}: ${k} is ${v}, above its pinned ${pin}; it may only go down (tighten)`);
    if (dir === 'up' && v < pin) out.push(`${spec.name}: ${k} is ${v}, under its pinned ${pin}; it may only go up (tighten)`);
  }
  for (const k of Object.keys(pinned || {})) if (!keys.some(([x]) => x === k)) out.push(`${spec.name}: ${k} is pinned but no longer tighten-only`);
  return out;
}

// ---- Shapes: a document's declared keys and leaf types ----

const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const LEAF = Symbol('leaf');
const leaf = (check, describe) => Object.assign(check, { [LEAF]: true, describe });
const bound = (min, max) => {
  if (min === Number.MIN_VALUE) return max === Infinity ? ' above 0' : ` above 0, up to ${max}`;
  return min === -Infinity && max === Infinity ? '' : ` from ${min} to ${max}`;
};
/** What a shape expects, in words: a leaf's own description, or an object's keys. */
const expected = shape => (typeof shape === 'function' && shape[LEAF] ? shape.describe : `an object with ${Object.keys(shape).join(', ')}`);

const shapes = Object.freeze({
  /** A finite number, optionally whole, within [min, max]. */
  num: ({ min = -Infinity, max = Infinity, int = false } = {}) => {
    const want = `a ${int ? 'whole number' : 'number'}${bound(min, max)}`;
    return leaf(v => (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v)) || v < min || v > max ? want : null), want);
  },
  bool: () => leaf(v => (typeof v === 'boolean' ? null : 'true or false'), 'true or false'),
  /** A string, one of oneOf when given. */
  str: oneOf => {
    const want = oneOf ? `one of ${oneOf.join(', ')}` : 'a string';
    return leaf(v => (typeof v !== 'string' || !v || (oneOf && !oneOf.includes(v)) ? want : null), want);
  },
  /** A list of items (each a leaf or a shape), min to max long. */
  list: (item, { min = 0, max = Infinity } = {}) => {
    const want = `a list of ${min}${max === Infinity ? ' or more' : ` to ${max}`}`;
    return leaf((v, where) => {
      if (!Array.isArray(v) || v.length < min || v.length > max) return want;
      const errs = v.flatMap((x, i) => shapeErrors(item, x, `${where}[${i}]`));
      return errs.length ? errs : null;
    }, `${want}, each ${expected(item)}`);
  },
  /** A leaf of its own: check(value) -> null (fits) or what it should be; describe: what it expects. */
  custom: (check, describe = 'a valid value') => leaf(v => check(v), describe),
  /** An object with any keys, each value an item. */
  record: item => leaf((v, where) => {
    if (!isPlain(v)) return 'an object';
    const errs = Object.keys(v).flatMap(k => shapeErrors(item, v[k], `${where}.${k}`));
    return errs.length ? errs : null;
  }, `an object, each value ${expected(item)}`),
});

/** Every reason value doesn't fit shape (a leaf builder's check, or an object of shapes with exactly those keys). */
function shapeErrors(shape, value, where = '') {
  const at = where || '(root)';
  if (typeof shape === 'function' && shape[LEAF]) {
    const r = shape(value, at);
    if (r === null) return [];
    return Array.isArray(r) ? r : [`${at}: ${r}, not ${JSON.stringify(value)}`];
  }
  if (!isPlain(shape)) throw new Error(`${at}: a shape is a leaf builder or an object of shapes`);
  if (!isPlain(value)) return [`${at}: an object with ${Object.keys(shape).join(', ')}`];
  const out = [];
  for (const k of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) out.push(`${where ? `${where}.` : ''}${k}: missing (expected ${expected(shape[k])})`);
    else out.push(...shapeErrors(shape[k], value[k], `${where ? `${where}.` : ''}${k}`));
  }
  for (const k of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(shape, k)) out.push(`${where ? `${where}.` : ''}${k}: not a known key (expected only ${Object.keys(shape).join(', ')})`);
  return out;
}

module.exports = { CONFIG_DIR, DIRECTIONS, CriticalConfigError, deepFreeze, canonicalJson, hashOf, loadConfigFile, fingerprintOf, valueAt, loosened, shapes, shapeErrors };
