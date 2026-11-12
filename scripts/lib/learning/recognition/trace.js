'use strict';

/**
 * The recognition test's per-candle trace (docs/TRAINING.md, "The recognition test"): for one candle (a head cycle's bar
 * close), the harness's own briefing at that close (skill-usage.js briefingFrom: the bar and the `count` before it, and
 * the 1m bars closed by the close; never a later bar), the present key on it (key.js), and for each side the confluence
 * the harness itself verifies there (train/trend-facts.js barFacts, with the plan and entry rule compose_check uses, as
 * trend-facts.attachFacts builds them). Read-only measurement: nothing that decides reads it. No R, no later price.
 *
 * Confirmed = barFacts.valid for the side (THE one confirmation rule: the window allows entries, the trend rule allows
 * the side, the entry rule incl. declaredOf, a standard plan or a combination of verified reads passes R:R, room and the
 * stop floor). Beside it, never a second definition: the required flow steps met (bias, location, setup, stop, target;
 * the entry is optional, compose-hints.js repairOf) and declaredOf. The prop size chain is not checked (sizeFits null).
 *
 *   REQUIRED
 *   checkContext({ tree, root, inAttempt })   { tick, plan, entryRule } (throws without a contract spec or trade_lifecycle)
 *   tracer({ bars, fine, root, minutes, count, roundSteps, blackouts, ctx, thresholds })
 *       -> closeMs => { closeMs, bar, key, sides: { long, short } } | null (no bar closing there)
 */

const { briefingFrom } = require('../skill-usage');
const TF = require('../../train/trend-facts');
const { specFor, familyRoot } = require('../../trading/contracts');
const { loadStrategies } = require('../../trading/strategies');
const { STRATEGY, stopRuleOf } = require('../../trading/trade-lifecycle');
const { entryRuleOf } = require('../../trading/entry-rule');
const { STEPS } = require('../../trading/composed-reads');
const { MINUTE } = require('../../backtest/data');
const K = require('./key');

const REQUIRED = Object.freeze(['bias', 'location', 'setup', 'stop', 'target']);
const SIDES = ['long', 'short'];

function checkContext({ tree, root, inAttempt }) {
  const spec = specFor(root);
  const strategies = loadStrategies(tree, {}).strategies;
  const doc = strategies.find(s => s.name === STRATEGY);
  if (!spec || !doc || !doc.valid) throw new Error(`recognition trace: no ${spec ? STRATEGY : 'contract spec'} to check plans with (${root})`);
  const plan = { size: 1, tickValue: spec.tickValue, minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd, stopRule: stopRuleOf(doc.risk), suggestion: inAttempt === true };
  // The entry rule of the policy that trades the attempt (as compose_check reads it), as trend-facts.attachFacts.
  const policy = inAttempt ? strategies.find(s => s.valid && s.signal === 'policy' && (s.strategies || []).includes(STRATEGY) && s.instruments.some(x => familyRoot(x) === familyRoot(root))) : null;
  return { tick: spec.tickSize, plan, entryRule: policy ? entryRuleOf(policy.entry) : null };
}

function sideTrace(briefing, side, ctx, missing, key) {
  const f = TF.barFacts({ briefing, side, tick: ctx.tick, plan: ctx.plan, entryRule: ctx.entryRule, missing });
  const met = STEPS.filter(s => (f.verified && f.verified[s] ? f.verified[s] : []).length);
  return {
    met, required: [...REQUIRED], reqMet: REQUIRED.filter(s => met.includes(s)).length, reqTotal: REQUIRED.length,
    confirmed: f.valid === true, why: f.why || null, via: f.via || null, known: f.known !== false, declared: key.facts.declared[side],
    // The verified reads per flow step (the confluence items met, in the harness's own read grammar), and the plan's.
    reads: Object.fromEntries(met.map(s => [s, [...f.verified[s]]])), planReads: f.planReads || null,
  };
}

function tracer({ bars, fine = null, root, minutes, count, roundSteps = null, blackouts = null, ctx, thresholds }) {
  const fineBars = Array.isArray(fine) && fine.length ? fine : null;
  const build = briefingFrom(bars, { root, minutes, count, roundSteps, fineBars, blackouts });
  const missing = TF.missingFrames({ minutes, fineBars });
  const step = minutes * MINUTE;
  return closeMs => {
    const bar = new Date(closeMs - step).toISOString();
    const briefing = build(root, bar);
    if (!briefing) return null;
    const key = K.presentKey(briefing, thresholds);
    const sides = {};
    for (const s of SIDES) {
      try { sides[s] = sideTrace(briefing, s, ctx, missing, key); } catch (e) { sides[s] = { error: String(e.message), met: [], required: [...REQUIRED], reqMet: 0, reqTotal: REQUIRED.length, confirmed: false, declared: key.facts.declared[s] }; }
    }
    return { closeMs, bar, key, sides };
  };
}

module.exports = { REQUIRED, checkContext, tracer };
