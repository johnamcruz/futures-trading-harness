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
 *   readerFor({ runDir, home, barsFiles })   { records, briefingAt } from a run's own files: its own base bars only (the
 *                                 bars it traded; a data file can be on another price basis, e.g. a back-adjusted
 *                                 census file), and one-minute bars for the frames built from them (5m, gaps): the run's
 *                                 own, else the data file's (barsFiles { SYMBOL: file }, the loop's evaluator.data) only
 *                                 at a record whose base bar they reproduce in o, h, l, c (the same basis). Runs today
 *                                 archive no one-minute bars and the loop's data file is back-adjusted, so a 5m or gap
 *                                 read reads unknown until runs archive their one-minute bars. None readable: no records;
 *                                 a file or bars that can't be read: no briefing (unknown), never a throw
 *   fineBarsOf(home, runDir, root, barsFiles)   { bars, source: 'run' | 'file' | null }: the run's one-minute bars, else
 *                                 the data file's, else none
 *   sameBasis(fine, base, minutes)   whether one-minute bars aggregate to that base bar exactly (o, h, l, c)
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

function fineBarsOf(home, runDir, root, barsFiles = {}) {
  const { barsOf } = require('./trend-facts');
  const own = barsOf(home, runDir, root, 1, {});
  if (own.length) return { bars: own, source: 'run' };
  const file = isObj(barsFiles) ? barsFiles[root] : null;
  if (!file) return { bars: [], source: null };
  // The data file's own one-minute bars (a file of another bar size, or none there, throws: none).
  try { return { bars: require('../replay/labels').outcomeBarsFrom(file, 1).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t)), source: 'file' }; } catch (_err) { return { bars: [], source: null }; }
}

/**
 * Whether one-minute bars are on the base bars' price basis at a base bar: their aggregate over it equals it in o, h, l,
 * c (a back-adjusted data file, a constant offset from the run's own bars, never is).
 */
function sameBasis(fine, base, minutes) {
  if (!isObj(base)) return false;
  const from = Date.parse(base.t);
  const to = from + minutes * 60000;
  const g = fine.filter(x => { const t = Date.parse(x.t); return t >= from && t < to; });
  if (!g.length || Date.parse(g[0].t) !== from) return false;
  return g[0].o === base.o && Math.max(...g.map(x => x.h)) === base.h && Math.min(...g.map(x => x.l)) === base.l && g[g.length - 1].c === base.c;
}

function readerFor({ runDir, home = path.resolve(runDir, '..', '..'), barsFiles = {} }) {
  const { readJson } = require('../harness-run');
  let records;
  try { records = new Map(require('../trading/trade-lifecycle').readRecords(home).map(r => [r.id, r])); } catch (_err) { records = new Map(); }
  const cfg = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const minutes = Number(cfg.timeframe) || null;
  const root = Array.isArray(cfg.symbols) && cfg.symbols.length ? String(cfg.symbols[0]).toUpperCase() : null;
  if (!minutes || !root) return { records, briefingAt: null };
  let ctx = null;
  const setup = () => {
    const { barsOf } = require('./trend-facts');
    const { briefingFrom } = require('../learning/skill-usage');
    // The run's own base bars only: the bars the run traded (a data file may be on another price basis).
    const bars = barsOf(home, runDir, root, minutes, {});
    if (!bars.length) return { build: () => null };
    const fine = minutes !== 1 ? fineBarsOf(home, runDir, root, barsFiles || {}) : { bars: [], source: null };
    const opts = { root, minutes, count: require('../autotrader').recordedBars({ ...cfg, timeframe: minutes }), roundSteps: require('../trading/round-numbers').loadRoundSteps({ FTH_HOME: home }), blackouts: require('../trading/check-order').readBlackouts(path.join(home, 'blackouts', 'blackouts.json')) };
    const plain = briefingFrom(bars, { ...opts, fineBars: null });
    const withFine = fine.bars.length ? briefingFrom(bars, { ...opts, fineBars: fine.bars }) : null;
    const byT = new Map(bars.map(b => [Date.parse(b.t), b]));
    return {
      // The fine bars only on the base bars' own basis at the record's bar (the run's own always are); else none: the
      // frames built from them read unknown, never a label from another price basis.
      build: (r, bar) => (withFine && (fine.source === 'run' || sameBasis(fine.bars, byT.get(Date.parse(bar)), minutes)) ? withFine : plain)(r, bar),
    };
  };
  const briefingAt = (r, bar) => {
    try {
      if (!ctx) ctx = setup();
      return ctx.build(r, bar);
    } catch (_err) {
      // A data file or bars that can't be read: no briefing (unknown), never a throw.
      ctx = ctx || { build: () => null };
      return null;
    }
  };
  return { records, briefingAt };
}

module.exports = { NOT_RECORDED, NONE, UNKNOWN, isKeyLevel, readOf, withReads, fineBarsOf, sameBasis, readerFor };
