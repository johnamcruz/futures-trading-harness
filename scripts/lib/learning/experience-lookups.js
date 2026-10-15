'use strict';

/**
 * The record of experience_lookup calls (the composed-entry design, section 4.4), as trading/skill-lookups.js records
 * skill_lookup: while the runner's cycle runs (FTH_CYCLE_TRANSCRIPT set), one JSON line per answered call,
 * { at (ms), role, root, bar, side, signature, index }, in `<transcript>.experience.jsonl` next to the cycle's
 * transcript. The budget (D22): at most MAX_PER_BAR calls per cycle bar and root; a third is refused. Outside a
 * cycle nothing is recorded and no budget is counted (a person at a terminal). The gate doesn't require a lookup
 * yet (D15): the record is there for the scorecard and for when it does.
 *
 *   lookupsFile(transcript)                 the cycle's file
 *   recordExperienceLookup(env, entry, at)  append one (no cycle: nothing); true when written
 *   readExperienceLookups(transcript)       the lines, [] when none
 *   callsOnBar(env, root, bar)              how many calls this cycle already made for the root's bar
 *   reserveLookup(env, entry, at)           count and record one call under a lock; false when the budget is spent
 */

const fs = require('fs');

const MAX_PER_BAR = require('../tunables').training().experienceLookups.maxPerBar; // config/training.json, tighten-only
const MAX_BYTES = require('../tunables').runner().limits.experienceLookupsBytes; // config/runner.json

const lookupsFile = transcript => `${transcript}.experience.jsonl`;
const transcriptOf = env => String((env && env.FTH_CYCLE_TRANSCRIPT) || '').trim();

function recordExperienceLookup(env, entry, at = Date.now()) {
  const transcript = transcriptOf(env);
  if (!transcript) return false;
  fs.appendFileSync(lookupsFile(transcript), `${JSON.stringify({ at, ...entry })}\n`);
  return true;
}

function readExperienceLookups(transcript) {
  if (!transcript) return [];
  let text;
  try {
    const file = lookupsFile(transcript);
    if (fs.statSync(file).size > MAX_BYTES) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r && Number.isFinite(r.at) && typeof r.root === 'string') out.push(r);
    } catch (_err) { /* not a record */ }
  }
  return out;
}

const callsOnBar = (env, root, bar) => readExperienceLookups(transcriptOf(env)).filter(r => r.root === root && r.bar === bar).length;

const LOCK_WAIT_MS = 2000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Count and record one call atomically: under an exclusive lock beside the file (`<file>.lock`, O_EXCL), the call
 * is appended only while the bar's root has fewer than MAX_PER_BAR. true: taken (or no cycle: nothing counted or
 * recorded); false: the budget is spent. A lock still held after LOCK_WAIT_MS is refused (throws), never broken.
 */
function reserveLookup(env, entry, at = Date.now()) {
  const transcript = transcriptOf(env);
  if (!transcript) return true;
  const lock = `${lookupsFile(transcript)}.lock`;
  let fd = null;
  for (const until = Date.now() + LOCK_WAIT_MS; fd === null;) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST' || Date.now() > until) throw new Error(`experience_lookup: its record is locked (${lock}): ${err.code}`, { cause: err });
      sleep(10);
    }
  }
  try {
    if (callsOnBar(env, entry.root, entry.bar) >= MAX_PER_BAR) return false;
    return recordExperienceLookup(env, entry, at);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

module.exports = { MAX_PER_BAR, lookupsFile, recordExperienceLookup, readExperienceLookups, callsOnBar, reserveLookup };
