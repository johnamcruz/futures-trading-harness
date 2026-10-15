'use strict';

/**
 * An adapter's validation result, derived from the A/B comparison of its two practice-validate runs (adapters/README.md,
 * "Judge it"), never written by hand: an operator report read only by scripts/adapter.js validated, never by a tool, a
 * prompt or the runner.
 *
 *   onValidate(manifest)                       a run's window wholly in practice-validate
 *   deriveValidation({ manifest, tag, base, adapted, env, root, account, deps })   { status, runs, result }, or throws
 *                                              (the validation stays pending)
 */

const { VALIDATIONS } = require('./adapter');

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
 * passes (its experience log; process adherence from its scorecard). Step 2 (the prop keep rule as the A/B reads it):
 * no measure worse, the paired Monte Carlo pass rate better, and zero blows on the adapted side. Any criterion failed,
 * or no gain, is 'failed'; a criterion that can't be read (too few decisions, no Monte Carlo) throws: it stays pending.
 * Throws on any refusal (a run missing or unpaired). deps: { readSide, compareRuns, exitTest } (tests).
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
  const worse = r.rows.filter(x => x.verdict === 'B worse').map(x => x.measure);
  if (worse.length) return { status: 'failed', runs: [a.runId, b.runId], result: { ...result, why: `worse: ${worse.join(', ')}` } };
  if (step === 1) {
    const sc = Array.isArray(b.scorecard) ? b.scorecard : null;
    const adherence = sc ? { agree: sc.filter(x => x && x.agrees === true).length, disagree: sc.filter(x => x && x.agrees === false).length } : null;
    const tests = exitTest({ decisions: b.decisions || [], adherence }).filter(t => t.status !== 'SANITY');
    const failed = tests.filter(t => t.status === 'FAIL');
    const open = tests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL');
    const out = { ...result, exitTest: tests };
    if (failed.length) return { status: 'failed', runs: [a.runId, b.runId], result: { ...out, why: `the exit test failed: ${failed.map(t => t.test).join(', ')}` } };
    if (open.length || !tests.length) throw new Error(`the stage-1 exit test can't be read on run ${b.runId} (${open.map(t => `${t.test} ${t.status}`).join(', ') || 'no criteria'}): the validation stays pending`);
    return { status: 'passed', runs: [a.runId, b.runId], result: { ...out, why: 'every exit-test criterion passes; no measure worse' } };
  }
  const pass = r.rows.find(x => x.measure === 'MC pass within 30 days');
  const blows = r.rows.find(x => x.measure === 'MC blow rate');
  if (!pass || !blows || pass.verdict === 'N/A' || typeof blows.b !== 'number') throw new Error(`no paired Monte Carlo on the pair (${pass ? pass.test : 'no row'}): the validation stays pending`);
  if (blows.b > 0) return { status: 'failed', runs: [a.runId, b.runId], result: { ...result, why: `the adapted run blows (rate ${blows.b}): zero blows is a hard rule` } };
  if (pass.verdict !== 'B better') return { status: 'failed', runs: [a.runId, b.runId], result: { ...result, why: `no gain in the pass rate (${pass.verdict}): no gain is not kept` } };
  return { status: 'passed', runs: [a.runId, b.runId], result: { ...result, why: 'pass rate better, zero blows, no measure worse' } };
}

module.exports = { onValidate, deriveValidation };
