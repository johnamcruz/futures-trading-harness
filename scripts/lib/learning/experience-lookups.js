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
 */

const fs = require('fs');

const MAX_PER_BAR = 2;
const MAX_BYTES = 5 * 1024 * 1024;

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

module.exports = { MAX_PER_BAR, lookupsFile, recordExperienceLookup, readExperienceLookups, callsOnBar };
