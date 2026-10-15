'use strict';

/**
 * The prop Monte Carlo's size, the one home (config/runner.json monteCarlo, read here): the resampled attempt paths and the bootstrap repetitions every entry
 * point defaults to (prop/evaluator.js scoreStream, scoreArms and scorePaired; prop/model-score.js; the training
 * loop's model score, train/model-verifier.js; learning/risk-record-build.js; prop/account-states.js), so a result's
 * confidence never depends on which entry point ran. A size is never clamped quietly: one above the maximum is
 * refused (checkSize), and a caller that wants a smaller run says so.
 *
 *   MC_SIZE                      { paths, reps }: the default
 *   MC_MAX                       the most paths or repetitions a run may ask for
 *   checkSize({ paths, reps })   throws when either is not a whole number from 0 to MC_MAX
 */

const MC = require('../tunables').runner().monteCarlo;
const MC_SIZE = Object.freeze({ paths: MC.paths, reps: MC.reps });
const MC_MAX = MC.max; // tighten-only: it may only fall

function checkSize({ paths, reps } = {}) {
  for (const [k, v] of [['paths', paths], ['reps', reps]]) {
    if (v === undefined) continue;
    if (!(Number.isInteger(v) && v >= 0)) throw new Error(`${k}: a whole number, 0 or more, not ${String(v)}`);
    if (v > MC_MAX) throw new Error(`${k}: ${v} is above the Monte Carlo's maximum (${MC_MAX}); ask for at most ${MC_MAX}, never clamped quietly`);
  }
}

module.exports = { MC_SIZE, MC_MAX, checkSize };
