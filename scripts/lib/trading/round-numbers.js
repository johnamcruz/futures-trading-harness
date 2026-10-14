'use strict';

/**
 * Round-number steps: the spacing of the bar briefing's "round number" levels, per contract family
 * (the micro and the mini share one). Config, not code:
 *
 *   config/round-numbers.json          the shipped defaults: { "steps": { "NQ": 100, ... } }
 *   <FTH_HOME>/round-numbers.json      yours: overrides a family's step or adds one; null turns a family off
 *
 * A key is any root of the family (NQ or MNQ). A step is a whole number of the family's ticks (contracts.js),
 * from 1 to MAX_STEP_TICKS, so every round number is a tradable price and no step is absurd. An entry that isn't
 * is refused with its reason, and that family gets no round numbers (never a wrong step, never the default in its
 * place); a family not listed gets none. A file that can't be read or parsed turns every family off.
 *
 * Replay equals live: a replay run home is seeded with the steps as the user's home resolved them, refusals and
 * all (`resolved`, replay/driver.js seedRunHome), and reading that home gives back exactly that.
 *
 * resolveRoundSteps(defaults, overrides)   { steps: { MNQ: 100, MES: null, ... }, errors: [{ family, message }] } (pure)
 * loadRoundSteps(env)                      the same, from the two files (the home's may be a seeded `resolved` one)
 * defaultRoundSteps()                      the shipped defaults alone (no home): tests and offline use
 * seedFile(roundSteps)                     the `resolved` document a run home is seeded with
 * roundStepFor(root, roundSteps)           the step of a root's family, or null
 * roundStepError(root, roundSteps)         why that family has none, or null
 */

const fs = require('fs');
const path = require('path');
const { harnessHome } = require('../paths');
const { familyRoot, specFor } = require('./contracts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULTS_FILE = path.join(ROOT, 'config', 'round-numbers.json');
const FILE_NAME = 'round-numbers.json';
const ALL = '*'; // an error that turns every family off (a file that can't be read)
// The largest step, in ticks: 500 points on NQ and ES, 200 on RTY and GC, 10 on SI. A fixed cap, no live data.
const MAX_STEP_TICKS = 2000;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** One file's `steps` as { family: value } (keys normalized to the family), with its errors. */
function entries(doc, label) {
  const errors = [];
  const out = {};
  const steps = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.steps : undefined;
  if (steps === undefined) return { out, errors };
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
    return { out, errors: [{ family: ALL, message: `${label}: "steps" must be an object of family root to step; round numbers are off` }] };
  }
  for (const [key, value] of Object.entries(steps)) {
    const family = familyRoot(key);
    if (own(out, family) && out[family] !== value) {
      errors.push({ family, message: `${label}: ${family} is given twice with different steps; it gets no round numbers` });
      out[family] = undefined;
      continue;
    }
    out[family] = value;
  }
  return { out, errors };
}

/** The step a value gives a family (on its tick grid), or { error }. null: the family is off. */
function check(family, value, label) {
  if (value === null) return { step: null };
  const tick = (specFor(family) || {}).tickSize;
  if (!tick) return { error: `${label}: ${family} has no tick size in the contract table (contracts.js), so its step can't be checked; it gets no round numbers` };
  const ticks = typeof value === 'number' && Number.isFinite(value) ? value / tick : NaN;
  const whole = Math.round(ticks);
  // At least one tick, and on the tick grid within float error only (1e-12 of the step): 1e-300 is no step, and
  // 0.25000000001 is not 0.25.
  if (!(whole >= 1 && Math.abs(value - whole * tick) <= 1e-12 * Math.max(1, value))) {
    return { error: `${label}: ${family} step ${JSON.stringify(value)} is not a whole number of its ${tick} ticks of at least one tick; it gets no round numbers` };
  }
  if (whole > MAX_STEP_TICKS) {
    return { error: `${label}: ${family} step ${JSON.stringify(value)} is over ${MAX_STEP_TICKS} ticks (${round10(MAX_STEP_TICKS * tick)} points); it gets no round numbers` };
  }
  return { step: round10(whole * tick) };
}

const round10 = x => Math.round(x * 1e10) / 1e10;

/** The defaults laid under the overrides, each family's entry checked (the override's when it has one). */
function resolveRoundSteps(defaults, overrides = null, labels = { defaults: 'defaults', overrides: 'overrides' }) {
  const d = entries(defaults, labels.defaults);
  const o = entries(overrides, labels.overrides);
  const fileErrors = [...d.errors, ...o.errors].filter(e => e.family === ALL);
  const errors = [...fileErrors];
  const steps = {};
  for (const family of new Set([...Object.keys(d.out), ...Object.keys(o.out)])) {
    const [source, all, label] = own(o.out, family) ? [o.out, o.errors, labels.overrides] : [d.out, d.errors, labels.defaults];
    const twice = all.find(e => e.family === family);
    const r = twice ? { error: twice.message } : check(family, source[family], label);
    if (r.error) errors.push({ family, message: r.error });
    steps[family] = fileErrors.length || r.error ? null : r.step;
  }
  return { steps, errors };
}

function readJson(file, { optional }) {
  if (optional && !fs.existsSync(file)) return { doc: null };
  try {
    return { doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: `${file}: unreadable (${err.message.split('\n')[0]}); round numbers are off` };
  }
}

const allOff = (r, extra) => ({ steps: Object.fromEntries(Object.keys(r.steps).map(f => [f, null])), errors: [...r.errors, ...extra] });

/** A seeded run home's `resolved` document: its steps as they are (each re-checked) and its refusals. */
function fromResolved(doc, label) {
  const r = resolveRoundSteps(null, { steps: doc.steps }, { defaults: label, overrides: label });
  const refusals = Array.isArray(doc.errors) ? doc.errors.filter(e => e && typeof e.family === 'string' && typeof e.message === 'string') : [];
  const errors = [...r.errors, ...refusals.map(e => ({ family: e.family, message: e.message }))];
  // A file-wide refusal turned every family off when it was seeded; it does again, whatever the steps say. A family
  // with a refusal has no step, whatever the steps say (an edited seed never shows levels and "none" together).
  if (errors.some(e => e.family === ALL)) return allOff(r, refusals);
  const refused = new Set(errors.map(e => e.family));
  return { steps: Object.fromEntries(Object.entries(r.steps).map(([f, v]) => [f, refused.has(f) ? null : v])), errors };
}

/** The steps from the shipped defaults and the harness home's file (a seeded run home's file as resolved). */
function loadRoundSteps(env = process.env, { defaultsFile = DEFAULTS_FILE } = {}) {
  const userFile = path.join(harnessHome(env), FILE_NAME);
  const u = readJson(userFile, { optional: true });
  if (u.doc && u.doc.resolved === true) return fromResolved(u.doc, userFile);
  const d = readJson(defaultsFile, { optional: false });
  const r = resolveRoundSteps(d.doc, u.doc, { defaults: defaultsFile, overrides: userFile });
  const unreadable = [d.error, u.error].filter(Boolean).map(message => ({ family: ALL, message }));
  return unreadable.length ? allOff(r, unreadable) : r;
}

/** The shipped defaults alone, read from the repository (no harness home). */
function defaultRoundSteps({ defaultsFile = DEFAULTS_FILE } = {}) {
  const d = readJson(defaultsFile, { optional: false });
  const r = resolveRoundSteps(d.doc, null, { defaults: defaultsFile, overrides: defaultsFile });
  return d.error ? allOff(r, [{ family: ALL, message: d.error }]) : r;
}

/** What a replay run home is seeded with: the resolved steps and their refusals, read back as they are. */
const seedFile = roundSteps => ({ resolved: true, steps: { ...roundSteps.steps }, errors: roundSteps.errors.map(e => ({ ...e })) });

const roundStepFor = (root, roundSteps) => ((roundSteps && roundSteps.steps) || {})[familyRoot(root)] ?? null;

function roundStepError(root, roundSteps) {
  const family = familyRoot(root);
  const e = ((roundSteps && roundSteps.errors) || []).find(x => x.family === family || x.family === ALL);
  return e ? e.message : null;
}

module.exports = { DEFAULTS_FILE, FILE_NAME, MAX_STEP_TICKS, resolveRoundSteps, loadRoundSteps, defaultRoundSteps, seedFile, roundStepFor, roundStepError };
