'use strict';

/**
 * The model's risk record (the "your risk record" section of experience_lookup): the outcomes of the model's own risk
 * decisions (standing down, sizing under the ceiling, exiting early, stopping for the day) by account state, as code
 * measured them on practice-train days: counts and outcomes only, never advice. Counterfactual, and said so:
 * prop/risk-actions.js scoreRiskActions reverts one kind of action and replays the same Monte Carlo paths; the index
 * keeps, per day, what that day's actions changed.
 *
 * The index (buildRiskIndex): one entry per practice-train day { day, role, cells: { '<kind>|<state>': { n, savedBlows,
 * causedBlows, costPasses, gainedPasses } } } (riskDayEntry makes one from a day's scoreRiskActions result), hashed.
 * Practice-train only: an entry of practice-validate, test or final (its day, or the role it names) is refused, at the
 * build and again when it is read. Walk-forward by day (riskCellAt): a bar sees only the days strictly before its
 * session. Off by default: the model sees it only when the replay config enables riskRecordDisplay (kept in the pin:
 * riskShown; pinning alone shows nothing). A cell under minN paths reads "too few", never a count of outcomes.
 *
 *   riskDayEntry(day, result, { role })          the entry of one day's scoreRiskActions result
 *   buildRiskIndex(entries, { minN, now, sources })   the index document, with its hash (sources, when given: the runs
 *                                                and settings it was built from, learning/risk-record-build.js; hashed)
 *   readRiskIndex(file), writeRiskIndex(dir, doc), pinRiskRecord(runHome, file, { display }), loadPinnedRiskRecord(home)
 *   riskPin(home)                                the run's pin { file, hash, display }, or null
 *   riskShown(home)                              whether the run's pin enables the display
 *   riskCellAt(doc, kind, state, before)         the summed cell for days before `before`, or { n, enough: false }
 *   riskRecordLines(doc, before)                 the section's lines (the heading first)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertUse } = require('./splits');
const { KINDS, STATES } = require('../prop/risk-actions');
const { HELD_OUT } = require('../prop/risk-attribution');

const VERSION = 1;
const KIND = 'risk-record-index';
const PINNED = 'risk-record-pinned.json';
const MIN_N = require('../tunables').training().riskRecord.minN; // config/training.json (only rises)
const FIELDS = Object.freeze(['n', 'savedBlows', 'causedBlows', 'costPasses', 'gainedPasses']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** A practice-train session date (the guard's index use). */
function assertTrainDay(day) {
  if (!DAY.test(String(day))) throw new Error(`risk record: a session date YYYY-MM-DD, not ${String(day)}`);
  assertUse('index', day, new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
}

/** One day's entry from its scoreRiskActions result: what its actions changed, by kind and state. */
function riskDayEntry(day, result, { role = null } = {}) {
  const sealed = HELD_OUT.find(r => r === role || (result && result.look && r === result.look.role));
  if (sealed) throw new Error(`a ${sealed} run's outcomes are judged, never shown to the model: no risk record`);
  if (!result || !isObj(result.actions)) throw new Error('riskDayEntry: a scoreRiskActions result');
  assertTrainDay(day);
  const cells = {};
  for (const kind of KINDS) {
    for (const state of STATES) {
      const row = result.actions[kind] && result.actions[kind].byState[state];
      if (!row || !(row.applied > 0)) continue;
      cells[`${kind}|${state}`] = { n: row.applied, savedBlows: row.savedBlows || 0, causedBlows: row.causedBlows || 0, costPasses: row.costPasses || 0, gainedPasses: row.gainedPasses || 0 };
    }
  }
  return { day, role: 'practice-train', cells };
}

function indexHash(doc) {
  const { builtAt: _b, hash: _h, ...rest } = doc;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function checkEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('risk record: entries are a list');
  const seen = new Set();
  for (const e of entries) {
    if (!isObj(e) || !isObj(e.cells)) throw new Error('risk record: an entry is { day, role, cells }');
    if (e.role !== 'practice-train') throw new Error(`risk record: ${e.day} is a ${String(e.role)} entry; practice-train only`);
    assertTrainDay(e.day);
    if (seen.has(e.day)) throw new Error(`risk record: ${e.day} twice`);
    seen.add(e.day);
    for (const [k, c] of Object.entries(e.cells)) {
      const [kind, state] = k.split('|');
      if (!KINDS.includes(kind) || !STATES.includes(state) || !isObj(c) || !FIELDS.every(f => Number.isInteger(c[f]) && c[f] >= 0)) throw new Error(`risk record: ${e.day} cell "${k}" is not a kind|state of whole counts`);
    }
  }
}

function buildRiskIndex(entries, { minN = MIN_N, now = new Date(), sources = null } = {}) {
  if (!(Number.isInteger(minN) && minN >= 1)) throw new Error('minN: a whole number from 1');
  if (sources !== null && !isObj(sources)) throw new Error('sources: what the record was built from, an object');
  checkEntries(entries);
  const sorted = [...entries].sort((a, b) => (a.day < b.day ? -1 : 1)).map(e => ({ day: e.day, role: 'practice-train', cells: Object.fromEntries(Object.entries(e.cells).sort(([a], [b]) => a.localeCompare(b))) }));
  const doc = { v: VERSION, kind: KIND, builtAt: now.toISOString(), counterfactual: true, walkForward: true, roles: ['practice-train'], minN, days: sorted.length, ...(sources ? { sources } : {}), entries: sorted };
  return { ...doc, hash: indexHash(doc) };
}

function readRiskIndex(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.kind !== KIND || typeof doc.hash !== 'string') throw new Error(`${file}: not a risk record index`);
  if (doc.v !== VERSION || doc.walkForward !== true || JSON.stringify(doc.roles) !== JSON.stringify(['practice-train'])) throw new Error(`${file}: a risk record index of version ${doc.v}, not ${VERSION} (walk-forward, practice-train): rebuild it`);
  if (indexHash(doc) !== doc.hash) throw new Error(`${file}: its content doesn't match its hash (changed after it was built)`);
  checkEntries(doc.entries);
  return doc;
}

function writeRiskIndex(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `risk-record-${doc.hash.slice(0, 16)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Pin an index for a run (its own copy); a run keeps the one it pinned and whether the model is shown it. */
function pinRiskRecord(runHome, file, { display = false, comparisonArm = false } = {}) {
  if (typeof display !== 'boolean') throw new Error('display: true or false');
  if (typeof comparisonArm !== 'boolean') throw new Error('comparisonArm: true or false');
  const doc = readRiskIndex(file);
  const dir = path.join(runHome, 'experience');
  let pinned = null;
  try { pinned = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { /* none yet */ }
  if (pinned && pinned.hash !== doc.hash) throw new Error(`this run pinned risk record ${String(pinned.hash).slice(0, 16)}; a run keeps its risk record (start another runId for ${doc.hash.slice(0, 16)})`);
  if (pinned && (pinned.display === true) !== display) throw new Error(`this run pinned its risk record with the display ${pinned.display === true ? 'on' : 'off'}; a run keeps it (start another runId to change it)`);
  if (pinned && (pinned.comparisonArm === true) !== comparisonArm) throw new Error(`this run pinned its risk record ${pinned.comparisonArm === true ? 'as' : 'not as'} a declared comparison arm; a run keeps it (start another runId to change it)`);
  const copy = writeRiskIndex(dir, doc);
  fs.writeFileSync(path.join(dir, PINNED), `${JSON.stringify({ file: path.basename(copy), hash: doc.hash, display, comparisonArm })}\n`);
  return { file: copy, hash: doc.hash, display, comparisonArm };
}

/** The run's pin ({ file, hash, display }), or null when none is pinned (or it can't be read). */
function riskPin(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'experience', PINNED), 'utf8')); } catch (_err) { return null; }
}

/** Whether the run's pin enables the display: only an explicit `display: true` does. */
function riskShown(home) {
  const pin = riskPin(home);
  return Boolean(pin) && pin.display === true;
}

/** The run's pinned index (hash checked), or null when none is pinned. */
function loadPinnedRiskRecord(home) {
  const dir = path.join(home, 'experience');
  let pin;
  try { pin = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { return null; }
  if (!pin || !/^risk-record-[0-9a-f]{16}\.json$/.test(String(pin.file))) throw new Error('the pinned risk record is not a risk record file');
  const doc = readRiskIndex(path.join(dir, pin.file));
  if (doc.hash !== pin.hash) throw new Error(`the pinned risk record's hash ${String(pin.hash).slice(0, 16)} is not its file's ${doc.hash.slice(0, 16)}`);
  return doc;
}

/** The cell summed over the days strictly before `before` (a session date), or { n, enough: false } under minN. */
function riskCellAt(doc, kind, state, before) {
  const sum = Object.fromEntries(FIELDS.map(f => [f, 0]));
  for (const e of doc.entries) {
    if (before !== null && !(e.day < before)) continue;
    const c = e.cells[`${kind}|${state}`];
    if (c) for (const f of FIELDS) sum[f] += c[f];
  }
  return sum.n >= doc.minN ? { ...sum, enough: true } : { n: sum.n, enough: false };
}

const WORDS = { pass: 'standing down', 'size-down': 'sizing under the ceiling', 'early-exit': 'exiting early', 'day-stop': 'stopping for the day' };
const STATE_WORDS = { fresh: 'fresh (first session)', mid: 'mid-attempt', 'near-target': 'near the target', 'near-mll': 'near the max loss', all: 'after losses' };
const blows = n => `${n} ${n === 1 ? 'blow' : 'blows'}`;
const passes = n => `${n} ${n === 1 ? 'pass' : 'passes'}`;
/** Shown: the four account states for standing down, sizing and exiting, and stopping for the day after losses. */
const ROWS = Object.freeze([
  ...['fresh', 'mid', 'near-target', 'near-mll'].flatMap(state => ['pass', 'size-down', 'early-exit'].map(kind => [state, kind])),
  ['all', 'day-stop'],
]);

function riskRecordLines(doc, before) {
  const head = `Your risk record (counterfactual, practice-train days before ${before} only: each of your risk decisions reverted over the same Monte Carlo paths; n = paths it changed; under ${doc.minN} is too few):`;
  return [head, ...ROWS.map(([state, kind]) => {
    const c = riskCellAt(doc, kind, state, before);
    const label = `- ${STATE_WORDS[state]}, ${WORDS[kind]}`;
    return c.enough
      ? `${label}: n ${c.n}, saved ${blows(c.savedBlows)}, caused ${c.causedBlows}, cost ${passes(c.costPasses)}, gained ${c.gainedPasses}`
      : `${label}: too few`;
  })];
}

module.exports = { VERSION, KIND, MIN_N, riskDayEntry, buildRiskIndex, readRiskIndex, writeRiskIndex, pinRiskRecord, loadPinnedRiskRecord, riskPin, riskShown, riskCellAt, riskRecordLines };
