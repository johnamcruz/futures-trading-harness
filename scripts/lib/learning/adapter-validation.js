'use strict';

/**
 * An adapter's validation result, derived from the A/B comparison of its two practice-validate runs (adapters/README.md,
 * "Judge it"), never written by hand: an operator report read only by scripts/adapter.js validated, never by a tool, a
 * prompt or the runner.
 *
 *   onValidate(manifest)                       a run's window wholly in practice-validate
 *   deriveValidation({ manifest, tag, base, adapted, env, root, account, deps })   { status, runs, result, evidence },
 *                                              or throws (the validation stays pending)
 */

const fs = require('fs');
const path = require('path');
const { VALIDATIONS, recordDigest } = require('./adapter');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** A run's window wholly in practice-validate, by its manifest's start and its last instant (learning/splits.js). */
function onValidate(manifest) {
  const { roleOf } = require('./splits');
  try {
    return roleOf(new Date(manifest.start)) === 'practice-validate' && roleOf(new Date(Date.parse(manifest.end) - 1)) === 'practice-validate';
  } catch (_err) { return false; }
}

/**
 * The validation result, derived (never written by hand): the A/B comparison (train/ab-compare.js compareRuns, --field
 * adapter) of the base run and the adapted run, both finished replays on practice-validate (their windows and their
 * looks), differing only in the declared adapter, the adapted run's being THIS manifest (its tag) and the base's none.
 * Step 1 (the stage-1 exit test): no measure worse, and every criterion of replay/stage.js exitTest on the adapted run
 * passes (its experience log; process adherence from its scorecard). Step 2: no measure worse, and the FULL prop keep
 * rule (train/model-verifier.js decide, the training loop's one keep rule) on the pair as one held-out window: the
 * paired Monte Carlo (prop/model-score.js pairRuns, A the base, B the adapted), process adherence from the two
 * scorecards and the correct-read rate. Zero blows on the adapted side in its real attempts and its resampled paths;
 * `kept` is passed, `inconclusive` (a window too short to show anything, too few decisions) stays pending (throws),
 * anything else is failed. A resampled-only gain is never a pass. Any criterion failed, or no gain, is 'failed'; a
 * criterion that can't be read throws: it stays pending. Throws on any refusal (a run missing or unpaired).
 * evidence: each run's id, run dir and setup record digest (learning/adapter.js evidenceErrors checks them).
 * deps: { readSide, compareRuns, exitTest, pair(a, b, opts), readsOf(side, opts) } (tests).
 */
function deriveValidation({ manifest, tag, base, adapted, env = process.env, root = null, account = null, deps = {} }) {
  const AB = require('../train/ab-compare');
  const readSide = deps.readSide || AB.readSide;
  const compareRuns = deps.compareRuns || AB.compareRuns;
  const exitTest = deps.exitTest || require('../replay/stage').exitTest;
  const step = isObj(manifest) && isObj(manifest.training) ? manifest.training.step : null;
  if (step !== 1 && step !== 2) throw new Error('the manifest names no training step (1 or 2)');
  const sides = [['base', base], ['adapted', adapted]].map(([name, dir]) => {
    let side;
    try { side = readSide(dir); } catch (err) { throw new Error(`the ${name} run: ${err.message}`, { cause: err }); }
    if (!onValidate(side.manifest)) throw new Error(`the ${name} run ${side.runId} is not on practice-validate (${side.manifest.start} to ${side.manifest.end}): an adapter is validated there only`);
    if (!(side.gate && side.gate.role === 'practice-validate')) throw new Error(`the ${name} run ${side.runId} has no practice-validate learning decision (learning-run.json)`);
    if (!side.setup || !isObj(side.setup.config)) throw new Error(`the ${name} run ${side.runId} has no setup record`);
    return side;
  });
  const [a, b] = sides;
  if (a.setup.config.adapter !== undefined) throw new Error(`the base run ${a.runId} declares an adapter (${a.setup.config.adapter}): the base runs without one`);
  if (b.setup.config.adapter !== JSON.stringify(tag)) throw new Error(`the adapted run ${b.runId} ran adapter ${b.setup.config.adapter || 'none'}, not this manifest (${tag})`);
  const r = compareRuns(a.runDir, b.runDir, { field: 'adapter', env, root, account });
  if (r.refused) throw new Error(`the A/B comparison refused the pair: ${r.refusals.join('; ')}`);
  if (!(r.differs.length === 1 && r.differs[0].startsWith('adapter:'))) throw new Error(`the runs differ in more than the adapter (${r.differs.join('; ')})`);
  const rows = r.rows.map(x => ({ measure: x.measure, verdict: x.verdict, a: x.a, b: x.b }));
  const result = { kind: VALIDATIONS[step], compare: { a: r.a, b: r.b, result: r.result, rows } };
  const evidence = Object.fromEntries([['base', a], ['adapted', b]].map(([k, s]) => [k, { runId: s.runId, dir: s.runDir, setup: recordDigest(s.setup) }]));
  const done = (status, res) => ({ status, runs: [a.runId, b.runId], result: res, evidence });
  const worse = r.rows.filter(x => x.verdict === 'B worse').map(x => x.measure);
  if (worse.length) return done('failed', { ...result, why: `worse: ${worse.join(', ')}` });
  if (step === 1) {
    const sc = Array.isArray(b.scorecard) ? b.scorecard : null;
    const adherence = sc ? { agree: sc.filter(x => x && x.agrees === true).length, disagree: sc.filter(x => x && x.agrees === false).length } : null;
    const tests = exitTest({ decisions: b.decisions || [], adherence }).filter(t => t.status !== 'SANITY');
    const failed = tests.filter(t => t.status === 'FAIL');
    const open = tests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL');
    const out = { ...result, exitTest: tests };
    if (failed.length) return done('failed', { ...out, why: `the exit test failed: ${failed.map(t => t.test).join(', ')}` });
    if (open.length || !tests.length) throw new Error(`the stage-1 exit test can't be read on run ${b.runId} (${open.map(t => `${t.test} ${t.status}`).join(', ') || 'no criteria'}): the validation stays pending`);
    return done('passed', { ...out, why: 'every exit-test criterion passes; no measure worse' });
  }
  return keepRule({ a, b, result, done, env, root, account, deps });
}

/** The scorecard's records as the keep rule's decisions (train/loop.js scorecardDecisions' key and category). */
const scored = list => (Array.isArray(list) ? list : []).filter(x => isObj(x) && x.t && x.symbol && x.category).map(x => ({ key: `${x.t}|${x.symbol}`, category: x.category }));

/** The paired Monte Carlo of the base and adapted runs, under the account the A/B resolves (ab-compare.js defaultMc's). */
function defaultPair(a, b, { root, env, account }) {
  const M = require('../prop/model-score');
  const { loadAccounts, accountNamed } = require('../trading/accounts');
  const { strategies } = require('../trading/strategies').loadStrategies(root, env);
  let runner = {};
  try { runner = JSON.parse(fs.readFileSync(path.join(a.runDir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { /* none */ }
  const p = M.resolveAccount({ override: account, runnerAccount: runner.account, strategies, accounts: loadAccounts(root, env).accounts });
  if (!p.name) throw new Error(p.why);
  const acc = accountNamed(root, p.name, env);
  return M.pairRuns(a.runDir, b.runDir, { root, env, account: acc, policy: M.policyFor(strategies, acc.name) });
}

/** Step 2: the full keep rule (train/model-verifier.js decide) on the pair as one held-out window. */
function keepRule({ a, b, result, done, env, root, account, deps }) {
  const MV = require('../train/model-verifier');
  const pair = deps.pair || defaultPair;
  const readsOf = deps.readsOf || ((side, o) => MV.readsByKey(side.runDir, o));
  let mc;
  try { mc = pair(a, b, { root, env, account }); } catch (err) { throw new Error(`the paired Monte Carlo can't be scored (${err.message}): the validation stays pending`, { cause: err }); }
  const blows = isObj(mc) && isObj(mc.blows) ? mc.blows.b : undefined;
  if (!(Number.isInteger(blows) && blows >= 0)) throw new Error('the paired Monte Carlo gives no blow count for the adapted run: the validation stays pending');
  const realBlown = isObj(mc.b) && isObj(mc.b.real) && typeof mc.b.real.blown === 'number' ? mc.b.real.blown : 0;
  let rd = null;
  let readsWhy = null;
  try { rd = MV.reads(readsOf(a, { root, env }), readsOf(b, { root, env })); } catch (err) { readsWhy = err.message; }
  const window = { label: `${a.manifest.start}..${a.manifest.end}`, mc, adherence: MV.adherence(scored(a.scorecard), scored(b.scorecard)), reads: rd, readsWhy };
  const v = MV.decide([window], { heldOut: true });
  const out = { ...result, keep: { verdict: v.verdict, reasons: v.reasons, pooled: v.pooled, blows: { adapted: blows, adaptedReal: realBlown } } };
  // Zero blows on the adapted side, in its real attempts and its resampled paths: a hard rule, whatever else it gains.
  if (blows > 0 || realBlown > 0) return done('failed', { ...out, why: `the adapted run blows (${blows} over its real attempts and resampled paths): zero blows is a hard rule` });
  if (v.verdict === 'inconclusive') throw new Error(`the keep rule is inconclusive on the pair (${v.reasons.join('; ')}): the validation stays pending`);
  if (v.verdict !== 'kept') return done('failed', { ...out, why: `the keep rule: ${v.verdict} (${v.reasons.join('; ')})` });
  return done('passed', { ...out, why: `the keep rule keeps it: ${v.reasons.join('; ')}` });
}

module.exports = { onValidate, deriveValidation };
