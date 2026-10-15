'use strict';

/**
 * compose_check (scripts/compose-check.js; the harness tool compose_check): the head trader's trade-lifecycle
 * combination, its reads checked against this cycle's bar briefing (trading/composed-reads.js) and its plan worked out
 * in code (trading/trade-lifecycle.js), appended as one record to <FTH_HOME>/trade-lifecycle/<ROOT>.jsonl. Read-only
 * but for that record; it places nothing and decides nothing (a calculator and a checker). Every call is recorded,
 * refused ones too, so the record covers what was tried.
 *
 * The briefing is the cycle bar's (FTH_CYCLE_BRIEFING_BARS, else FTH_CYCLE_BARS, from the runner): without a cycle bar
 * the call is refused, never checked against whatever briefing is current. The strategy document
 * (strategies/trade_lifecycle) gives risk.min_rr, risk.max_risk_usd and valid_bars (how many base bars after its bar's
 * close the record stays valid); one that is missing or invalid refuses.
 *
 *   compose_check { symbol, side, reads: [{ step, skill, read, why }], size }
 */

const { harnessHome } = require('../paths');
const { context, say } = require('./cli');
const { cycleBarOf } = require('./briefing');
const { skillCatalog } = require('./skills');
const { briefingFor } = require('../trading/fact-claims');
const { checkReads } = require('../trading/composed-reads');
const { STRATEGY, planOf, buildRecord, appendRecord, renderRecord } = require('../trading/trade-lifecycle');
const { loadStrategies } = require('../trading/strategies');
const { specFor } = require('../trading/contracts');
const { cycleId } = require('../trading/check-order');
const { briefingAfterClock } = require('../trading/look-ahead');

const USAGE = 'usage: compose-check.js --symbol MNQ --side long|short --size <contracts> --reads <JSON array of { step, skill, read, why }>';
const ROOT = /^[A-Z0-9]{1,8}$/;

function composeCheck({ symbol = null, side = null, reads = null, size = null } = {}, ctx) {
  const c = context(ctx);
  // Messages name the tool's arguments to a tool caller, the script's flags on the command line.
  const arg = name => say(c, `--${name}`, name);
  if (!ROOT.test(String(symbol || ''))) throw new Error(`${arg('symbol')}: a contract root, e.g. MNQ`);
  if (!['long', 'short'].includes(side)) throw new Error(`${arg('side')}: long or short`);
  if (!Array.isArray(reads)) throw new Error(`${arg('reads')}: an array of reads, each { step, skill, read, why }`);
  const home = harnessHome(c.env);
  const at = c.now().toISOString();
  const refused = problems => {
    const record = buildRecord({ at, root: symbol, symbol, side, problems, cycleId: cycleId(c.env) });
    appendRecord(home, record);
    return { text: renderRecord(record) };
  };
  const cycleBar = cycleBarOf(c.env, symbol, 'FTH_CYCLE_BRIEFING_BARS') || cycleBarOf(c.env, symbol);
  if (!cycleBar) return refused([`no cycle bar for ${symbol}: compose_check checks reads only in a runner cycle, against that bar's briefing`]);
  const got = briefingFor(home, symbol, { cycleBar });
  if (!got.briefing) return refused([got.why]);
  // Under a replay clock, never a briefing of a bar that closed after it (no look-ahead).
  const later = briefingAfterClock(got.briefing, c.replayAt());
  if (later) return refused([later]);
  const doc = loadStrategies(c.root, c.env).strategies.find(s => s.name === STRATEGY);
  if (!doc || !doc.valid) return refused([`strategies/${STRATEGY}/STRATEGY.md is ${doc ? `invalid (${(doc.errors || [])[0]})` : 'missing'}`]);
  const spec = specFor(symbol);
  const tick = spec ? spec.tickSize : null;
  const checked = checkReads({ reads, side, briefing: got.briefing, skills: skillCatalog(c.root).map(k => k.name), tick: tick || 0.25 });
  const planned = checked.stop && checked.target
    ? planOf({ checked, briefing: got.briefing, side, size, tick, tickValue: spec ? spec.tickValue : null, minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd })
    : null;
  const record = buildRecord({ at, root: symbol, symbol, side, briefing: got.briefing, checked, planned, cycleId: cycleId(c.env), validBars: doc.valid_bars });
  appendRecord(home, record);
  // A record that is not OK is an answer, not a failure: the text says what stands.
  return { text: renderRecord(record, checked) };
}

/** argv to { symbol, side, reads, size }. */
function parseArgv(argv) {
  const o = { symbol: null, side: null, reads: null, size: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const val = () => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag}: give its value (${USAGE})`);
      return v;
    };
    if (flag === '--symbol') o.symbol = val();
    else if (flag === '--side') o.side = val();
    else if (flag === '--size') o.size = Number(val());
    else if (flag === '--reads') {
      try { o.reads = JSON.parse(val()); } catch (err) { throw new Error(`${flag}: JSON (${err.message})`, { cause: err }); }
    } else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { compose_check: composeCheck };

module.exports = { OPS, USAGE, composeCheck, parseArgv };
