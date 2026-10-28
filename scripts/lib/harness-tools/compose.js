'use strict';

/**
 * compose_check (scripts/compose-check.js; the harness tool compose_check): the head trader's trade-lifecycle
 * combination, its reads checked against this cycle's bar briefing (trading/composed-reads.js) and its plan worked out
 * in code (trading/trade-lifecycle.js), appended as one record to <FTH_HOME>/trade-lifecycle/<ROOT>/<day>.jsonl. Read-only
 * but for that record; it places nothing and decides nothing (a calculator and a checker). Every call is recorded,
 * refused ones too, so the record covers what was tried.
 *
 * The briefing is the cycle bar's (FTH_CYCLE_BRIEFING_BARS, else FTH_CYCLE_BARS, from the runner): without a cycle bar
 * the call is refused, never checked against whatever briefing is current. The strategy document
 * (strategies/trade_lifecycle) gives risk.min_rr, risk.max_risk_usd and valid_bars (how many base bars after its bar's
 * close the record stays valid); one that is missing or invalid refuses. In a running prop attempt a record whose
 * stop no size fits (the rulebook's min_contracts all in over risk.max_risk_usd, and not within the floor stretch while
 * the attempt is healthy: size-translate.js noSizeFits) is NOT OK, with a HINT naming the widest stop that fits
 * (owner-approved 2026-10-24: order_plan could only skip it). In a running attempt the reads are also held to the
 * policy's entry rule (its rulebook's `entry`, entry-rule.js: the bias frames, the regime, the leg turned), as the
 * order gate's re-check holds them.
 *
 *   compose_check { symbol, side, reads: [{ step, skill, read, why }], size }
 */

const { harnessHome } = require('../paths');
const { context, say } = require('./cli');
const { cycleBarOf } = require('./briefing');
const { skillCatalog } = require('./skills');
const { briefingFor } = require('../trading/fact-claims');
const { checkReads } = require('../trading/composed-reads');
const { STRATEGY, planOf, stopRuleOf, buildRecord, appendRecord, renderRecord } = require('../trading/trade-lifecycle');
const { loadStrategies } = require('../trading/strategies');
const { specFor } = require('../trading/contracts');
const { cycleId } = require('../trading/check-order');
const { briefingAfterClock } = require('../trading/look-ahead');
const { attemptPolicy } = require('../trading/lifecycle-order');
const { hintsFor } = require('../trading/compose-hints');
const { standardPlans } = require('../learning/setup-library');
const { loadAccounts } = require('../trading/accounts');
const { noSizeFits } = require('../prop/size-translate');
const { entryRuleOf } = require('../trading/entry-rule');

/** A running prop attempt whose policy trades the composed strategy: its size is a suggestion, translated at entry. */
const inAttempt = (home, doc, strategies, root) => { try { return Boolean(attemptPolicy(home, doc, strategies, root)); } catch (_err) { return true; } };
/**
 * The entry rule of the policy trading the running attempt (its rulebook's `entry`, entry-rule.js), or null: no attempt,
 * every key off, or no policy found (the order gate then refuses the entry anyway: none trades the attempt).
 */
const entryRuleHere = (home, doc, strategies, root) => { try { const p = attemptPolicy(home, doc, strategies, root); return p ? entryRuleOf(p.entry) : null; } catch (_err) { return null; } };

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
  const all = loadStrategies(c.root, c.env).strategies;
  const doc = all.find(s => s.name === STRATEGY);
  if (!doc || !doc.valid) return refused([`strategies/${STRATEGY}/STRATEGY.md is ${doc ? `invalid (${(doc.errors || [])[0]})` : 'missing'}`]);
  const spec = specFor(symbol);
  const tick = spec ? spec.tickSize : null;
  const entryRule = entryRuleHere(home, doc, all, symbol);
  const checked = checkReads({ reads, side, briefing: got.briefing, skills: skillCatalog(c.root).map(k => k.name), tick: tick || 0.25, entryRule });
  const plan = { size, tickValue: spec ? spec.tickValue : null, minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd, stopRule: stopRuleOf(doc.risk), suggestion: inAttempt(home, doc, all, symbol) };
  const planned = checked.stop && checked.target ? planOf({ checked, briefing: got.briefing, side, tick, ...plan }) : null;
  const fits = noSizeFitsHere({ c, home, doc, all, symbol, planned, spec });
  const record = buildRecord({ at, root: symbol, symbol, side, briefing: got.briefing, checked, planned, problems: fits ? [fits.problem] : [], cycleId: cycleId(c.env), validBars: doc.valid_bars });
  appendRecord(home, record);
  // A record that is not OK is an answer, not a failure: the text says what stands, then what is TRUE on this bar
  // (compose-hints.js: never a verdict; a hint that can't be worked out is left out, the record unchanged).
  // The floor alone failing: its hint alone (the reads stand; a hint to compose them again would only fail again).
  const alone = fits && checked.ok && !planned.problems.length;
  const hints = record.ok ? [] : [...(alone ? [] : hintsOf({ checked, planned, briefing: got.briefing, side, tick, plan, spec, entryRule })), ...(fits ? [fits.hint] : [])];
  return { text: renderRecord(record, checked, hints) };
}

/**
 * In a running prop attempt, the record's stop no size fits (prop/size-translate.js noSizeFits, on the policy that
 * trades the attempt and its account): { problem, hint }, or null (no attempt, no policy or valid account, no plan:
 * order_plan still sizes, or refuses, the entry itself).
 */
function noSizeFitsHere({ c, home, doc, all, symbol, planned, spec }) {
  const p = planned && planned.plan;
  if (!p || !p.stop || !spec) return null;
  let policy = null;
  try { policy = attemptPolicy(home, doc, all, symbol); } catch (_err) { return null; }
  const account = policy ? loadAccounts(c.root, c.env).accounts.find(a => a.name === policy.account && a.valid) : null;
  // `home`: the attempt's snapshot, whose health the floor stretch reads (size-translate.js floorStretch).
  return account ? noSizeFits({ policy, account, capUsd: doc.risk.max_risk_usd, stop: p.stop, spec, root: symbol, strategy: STRATEGY, home }) : null;
}

/** A refusal's hints (compose-hints.js), with the briefing's standard plan for the side when it passes; none on any error. */
function hintsOf({ checked, planned, briefing, side, tick, plan, spec, entryRule = null }) {
  try {
    const standard = (standardPlans(briefing) || []).find(p => p.side === side && p.status === 'traded') || null;
    return hintsFor({ checked, planned, briefing, side, tick, plan: spec ? plan : null, standard, entryRule });
  } catch (_err) {
    return [];
  }
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
