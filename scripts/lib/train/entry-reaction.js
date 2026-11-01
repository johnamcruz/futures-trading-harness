'use strict';

/**
 * The entry read of each filled entry, for the round report's chop drag by entry kind (train/loss-diagnostics.js):
 * the reaction of the setup candle at the entry's level and that level's kind. Analysis after the run only, never in
 * the live path and never shown to the model. Report only: no screen, keep rule, promotion or prompt reads it.
 *
 * An entry joins its compose record (the capture's `record`: the record id the runner's entry order names). The read
 * is the record's first rejection, break or sweep read, the setup step's first, then the location's, then the entry's
 * (composed-reads.js forms `<tf> rejected|broke <level> up|down`, `swept <level>`). Its reaction is the briefing's, at
 * the record's bar (reaction-echo.js echoOf on the briefing rebuilt by the runner's own code from the run's bars,
 * learning/skill-usage.js briefingFrom): candle-reaction.js's label, never one guessed from the read's words. The level
 * is that read's, else the record's first `at <level>` read; key when it is one of the setup moments' key levels
 * (learning/setup-moments.js KEY_LEVEL: the fixed session levels, the 1h and 15m swings, the VWAP) or a fair value gap's
 * edge, else not key.
 *
 *   NOT_RECORDED, NONE, UNKNOWN   the reaction when the entry has no compose record, when its record has no rejection,
 *                                 break or sweep read, when the briefing can't say (not rebuilt, or the candle unknown)
 *   readOf(record, briefing)      { reaction, tf, level, keyLevel } (pure; keyLevel true | false | null: no level read)
 *   withReads(entries, { records, briefingAt })   the entries, each with `read` (records: id -> record; briefingAt(root,
 *                                 bar) -> the briefing or null; never throws)
 *   readerFor({ runDir, home })   { records, briefingAt } from a run's own files (none readable: no records)
 */

const path = require('path');

const NOT_RECORDED = 'not recorded';
const NONE = 'none';
const UNKNOWN = 'unknown';
const STEP_ORDER = ['setup', 'location', 'entry'];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** The setup moments' key levels, by a read's lower-case name (the read names a level as the briefing does, lower case). */
function isKeyLevel(level) {
  const { KEY_LEVEL } = require('../learning/setup-moments');
  return new RegExp(KEY_LEVEL.source, 'i').test(level) || /\bfvg\b/i.test(level);
}

function readOf(record, briefing) {
  const { parseRead } = require('../trading/composed-reads');
  const { echoOf } = require('../trading/reaction-echo');
  const reads = isObj(record) && Array.isArray(record.reads) ? record.reads.filter(isObj) : [];
  const parsed = reads.map(r => { try { return { r, p: parseRead(String(r.read || '')) }; } catch (_err) { return { r, p: null }; } }).filter(x => x.p);
  const rank = x => { const i = STEP_ORDER.indexOf(x.r.step); return i < 0 ? STEP_ORDER.length : i; };
  const byStep = parsed.map((x, i) => ({ ...x, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  const reacting = byStep.find(x => (x.p.kind === 'relation' && (x.p.rel === 'rejected' || x.p.rel === 'broke')) || x.p.kind === 'swept');
  const at = byStep.find(x => x.p.kind === 'at');
  const level = reacting ? reacting.p.level : at ? at.p.level : null;
  let reaction = NONE;
  if (reacting) {
    let e;
    try { e = briefing ? echoOf({ read: reacting.r.read }, briefing) : null; } catch (_err) { e = null; }
    reaction = e && e.reaction ? e.reaction : UNKNOWN;
  }
  return { reaction, tf: reacting && reacting.p.tf ? reacting.p.tf : null, level: level || null, keyLevel: level ? isKeyLevel(level) : null };
}

function withReads(entries, { records = new Map(), briefingAt = null } = {}) {
  return (Array.isArray(entries) ? entries : []).map(e => {
    const rec = isObj(e) && e.record && records.get(e.record);
    if (!rec) return { ...e, read: { reaction: NOT_RECORDED, tf: null, level: null, keyLevel: null } };
    let b;
    try { b = typeof briefingAt === 'function' ? briefingAt(String(rec.root || rec.symbol || '').toUpperCase(), rec.bar) : null; } catch (_err) { b = null; }
    return { ...e, read: readOf(rec, b) };
  });
}

function readerFor({ runDir, home = path.resolve(runDir, '..', '..') }) {
  const { readJson } = require('../harness-run');
  let records;
  try { records = new Map(require('../trading/trade-lifecycle').readRecords(home).map(r => [r.id, r])); } catch (_err) { records = new Map(); }
  const cfg = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const minutes = Number(cfg.timeframe) || null;
  const root = Array.isArray(cfg.symbols) && cfg.symbols.length ? String(cfg.symbols[0]).toUpperCase() : null;
  if (!minutes || !root) return { records, briefingAt: null };
  let build = null;
  const briefingAt = (r, bar) => {
    if (!build) {
      const { barsOf } = require('./trend-facts');
      const { briefingFrom } = require('../learning/skill-usage');
      const bars = barsOf(home, runDir, root, minutes, {});
      const fine = minutes !== 1 ? barsOf(home, runDir, root, 1, {}) : [];
      build = bars.length ? briefingFrom(bars, { root, minutes, count: require('../autotrader').recordedBars({ ...cfg, timeframe: minutes }), roundSteps: require('../trading/round-numbers').loadRoundSteps({ FTH_HOME: home }), fineBars: fine.length ? fine : null, blackouts: require('../trading/check-order').readBlackouts(path.join(home, 'blackouts', 'blackouts.json')) }) : () => null;
    }
    return build(r, bar);
  };
  return { records, briefingAt };
}

module.exports = { NOT_RECORDED, NONE, UNKNOWN, isKeyLevel, readOf, withReads, readerFor };
