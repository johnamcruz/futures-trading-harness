'use strict';

/**
 * The training loop's mechanical verifier (docs/LEARNED-RULEBOOK.md R26, first bullet; R28): the two-layer
 * evaluator of section 10 step 9 (prop/evaluate-run.js runEvaluation: prop/evaluator.js checkWindow for the
 * window and its look, prop/trade-stream.js tradeStream, then scoreStream, read by prop/promotion.js
 * gateFailures), run on the champion's tree and the candidate's, on the same windows, bar files and seed, so
 * the two are compared on equal terms (every random draw is seeded; the same stream and seed give the same
 * result).
 *
 * On the tuning windows (paired): the candidate fails on any blow (R8: a single blow rejects), on a gate
 * failure the champion doesn't have, or on a pass-rate lower bound no higher than the champion's (R8's objective; a tie,
 * the degenerate 0 of a short window included, shows nothing). On
 * held-out windows (`judge --held-out-look`): only the candidate is scored, as a judging look the evaluator
 * logs to the ledger before it reads a bar, and every gate failure counts (the promotion gate, absolute).
 *
 * The loop config's `evaluator`: { prop (the policy strategy), data ({ SYMBOL: bar file at its timeframe }),
 * and any of scripts/evaluate.js's settings: seed (default: the loop's), paths, reps, meanBlock, every, cuts,
 * entryDelayMs, faults, facts, and backtest options }. Without one the verifier is unavailable and a strategy or
 * rulebook change stays `blocked` (paired.js).
 *
 *   resolveEvaluator(raw, baseDir)        the validated config (bar files resolved), or null when none
 *   summarize(result)                     what the archive keeps of a result
 *   compare(champion, candidate)          [failure] of a candidate against the champion on one window
 *   evaluate({ cfg, windows, champion, candidate, seed, env, look, ledger, scratchLedger, run, coversOf })
 *                                         { available, covers, blows, failures, windows: [{ from, to, champion, candidate }] }
 *                                         covers: the strategy files its streams read; a change to any other strategy
 *                                         or to a rulebook is not screened by it (the verdict stays blocked)
 */

const fs = require('fs');
const path = require('path');
const { expandHome } = require('../paths');
const { gateFailures } = require('../prop/promotion');

const UNAVAILABLE = 'no evaluator in the loop config ("evaluator": the policy strategy and its bar files), so the mechanical verifier (section 10 step 9) is not run';

function resolveEvaluator(raw, baseDir = process.cwd()) {
  if (raw === undefined || raw === null) return null;
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('evaluator: an object { prop, data, ... }');
  if (typeof raw.prop !== 'string' || !raw.prop) errors.push('evaluator.prop: the policy strategy to evaluate');
  if (!raw.data || typeof raw.data !== 'object' || !Object.keys(raw.data).length) errors.push('evaluator.data: { SYMBOL: bar file } at the policy\'s timeframe');
  for (const k of ['from', 'to', 'look', 'ledger', 'newLedger']) if (k in raw) errors.push(`evaluator.${k}: set by the loop (its windows and its ledger)`);
  if (raw.seed !== undefined && !Number.isInteger(raw.seed)) errors.push('evaluator.seed: a whole number');
  if (errors.length) throw new Error(errors.join('\n'));
  const data = Object.fromEntries(Object.entries(raw.data).map(([s, f]) => [s, path.resolve(baseDir, expandHome(String(f)))]));
  return Object.freeze({ ...raw, data });
}

/** A gate failure's kind, so the same failure with other numbers is the same failure. */
const kind = f => (/^too small/.test(f) ? 'too small' : /^blows/.test(f) ? 'blows' : /^pass rate/.test(f) ? 'pass rate' : /^win rate/.test(f) ? 'win rate' : f);

function summarize(r) {
  const lowerBound = r && r.objective && Number.isFinite(r.objective.lowerBound) ? r.objective.lowerBound : null;
  return {
    attempts: r.attempts, passed: r.passed, blown: r.blown, passRate: r.passRate, lowerBound,
    medianDaysToPass: r.medianDaysToPass ?? null, gate: gateFailures(r), seed: r.inputs ? r.inputs.seed : null, look: r.look || null,
  };
}

/**
 * A candidate's failures against the champion on one window. A screened change must SHOW itself better: a pass-rate
 * lower bound that only ties the champion's (equal, including the degenerate 0 of a short window), that is missing
 * on either side, or that falls, fails it; so do a blow and a gate failure the champion lacks. `exempt`: the change
 * touches nothing the evaluator scores and both results are identical (a skill-only change: the paired test judges it).
 */
function compare(champion, candidate, { exempt = false } = {}) {
  const out = [];
  if (candidate.blown > 0) out.push(`${candidate.blown} blow(s) over the attempts scored (R8: a single blow rejects)`);
  if (exempt && JSON.stringify(champion) === JSON.stringify(candidate)) return out;
  const had = new Set(champion.gate.map(kind));
  for (const f of candidate.gate) if (!had.has(kind(f)) && kind(f) !== 'blows') out.push(`a gate failure the champion doesn't have: ${f}`);
  if (champion.lowerBound !== null && candidate.lowerBound !== null) {
    if (candidate.lowerBound < champion.lowerBound) out.push(`the pass-rate lower bound fell from ${champion.lowerBound} to ${candidate.lowerBound}`);
    else if (candidate.lowerBound === champion.lowerBound) out.push(`the pass-rate lower bound ties the champion's (${candidate.lowerBound}): a tie counts against the candidate, it shows nothing better`);
  } else {
    out.push(`no pass-rate bound to compare (champion ${champion.lowerBound}, candidate ${candidate.lowerBound}): nothing shows the candidate better`);
  }
  return out;
}

const runDefault = (raw, opts) => require('../prop/evaluate-run').runEvaluation(raw, opts);

/** The documents the evaluator's streams read: the policy strategy and the strategies it counts (no rulebook yet). */
function coversDefault(root, prop, env) {
  const p = require('../backtest/run').policyStrategy(root, prop, env);
  // Only the files loaded from this tree: a same-named strategy from a user's folder (FTH_STRATEGIES_DIRS) shadows
  // the tree's copy, so an edit to the tree's copy is not what the streams read.
  return [p.strategy, ...p.counted].map(s => path.relative(root, s.file || '').split(path.sep).join('/'))
    .filter(rel => /^strategies\/[^/]+\/STRATEGY\.md$/.test(rel));
}

/**
 * The verifier over the windows. champion: the champion's tree (null: held-out, the candidate alone). look and
 * ledger: the look the evaluator checks and logs for a window outside Train (tuning or judging) and the ledger
 * file. Every run gets the same seed: the config's, else the loop's.
 */
async function evaluate({ cfg, windows, champion = null, candidate, seed, proposal = null, env = process.env, look = null, ledger = null, scratchLedger = null, run = runDefault, coversOf = coversDefault, log = () => {} }) {
  if (!cfg) return { available: false, why: UNAVAILABLE };
  const { seed: own, ...rest } = cfg;
  const s = Number.isInteger(own) ? own : seed;
  const covers = [...new Set([...coversOf(candidate, cfg.prop, env), ...(champion ? coversOf(champion, cfg.prop, env) : [])])].sort();
  const out = { available: true, seed: s, covers, blows: 0, failures: [], windows: [] };
  // Whether the change edits anything the streams read (a strategy they count, or any rulebook): then only a
  // candidate shown better passes; a change that edits none of it may tie, when both results are identical.
  const touches = !proposal || (proposal.edits || []).some(e => covers.includes(e.file) || /RULEBOOK\.md$/.test(e.file));
  for (const w of windows) {
    // scratchLedger: a copy of the ledger as it was before the caller's own look (held-out judging), made fresh for
    // each scoring, so the evaluator checks the same look and logs nothing more: one judging, one look.
    const fresh = () => {
      if (scratchLedger) {
        // The loop's own scratch file: a lock a crashed scoring left on it is stale (the loop's lock is held).
        fs.rmSync(`${scratchLedger.file}.lock`, { force: true });
        fs.copyFileSync(ledger, scratchLedger.file);
      }
      return scratchLedger ? scratchLedger.file : ledger;
    };
    const raw = { ...rest, seed: s, from: w.from, to: w.to, ...(look && ledger ? { look } : {}) };
    const at = r => (look && ledger ? { ...r, ledger: fresh() } : r);
    const champ = champion ? summarize(run(at(raw), { root: champion, env, log })) : null;
    const cand = summarize(run(at(raw), { root: candidate, env, log }));
    const failures = champ ? compare(champ, cand, { exempt: !touches }) : [...(cand.blown > 0 ? [`${cand.blown} blow(s) over the attempts scored (R8: a single blow rejects)`] : []), ...cand.gate.filter(f => kind(f) !== 'blows')];
    out.blows += cand.blown;
    out.failures.push(...failures.map(f => `${w.from}..${w.to}: ${f}`));
    out.windows.push({ from: w.from, to: w.to, champion: champ, candidate: cand });
  }
  return out;
}

module.exports = { UNAVAILABLE, resolveEvaluator, summarize, compare, evaluate };
