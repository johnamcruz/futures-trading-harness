'use strict';

/**
 * The training loop's config (JSON; mcp-configs/train-loop.example.json):
 *
 *   loopId          [A-Za-z0-9][A-Za-z0-9._-]{0,47}: the loop's name (its state, archive and branches carry it)
 *   replay          a replay config (replay/config.js; an object or a path relative to this file): the runner
 *                   config, broker and workDir every run of the loop uses; its runId, start and end are the
 *                   loop's (one run per window), and its workDir holds <loopId>/ (runs, checkpoints, trees, points)
 *   tuningWindows   [{ from, to }] session dates (YYYY-MM-DD, `to` exclusive), each inside one tuning unit of the
 *                   schedule (Train, or a walk-forward tuning quarter): the only months the loop runs on
 *   heldOutWindows  [{ from, to }] for `judge --held-out-look` only (judging looks, budgeted; never shown to the proposer)
 *   proposer        the runner config whose harness CLI proposes (an object or a path): buildCommand, as live
 *   repeats         decisions per point and side (1-20, default 3): the model's own noise is measured (R30)
 *   seed            the loop's seed (default 1): the control sample, each point's seed
 *   maxFlagged      flagged decisions per iteration (default 12); controlPoints: right ones (default 12)
 *   maxProposals    proposals per iteration (1-5, default 2)
 *   limits          { maxIterations (default 1), maxModelCalls (default 200), maxWallMinutes (default 240) }
 *   decision        tighter settings of the frozen decision rule (paired.js ruleFrom); never looser
 *   learning        the learning gate of its window runs (learning/run-gate.js, as replay.js run): { evaluation (required
 *                   for any window outside practice-train; each window's is <evaluation>.<label>), validate }; never reasoningFix; the candidate is the
 *                   loop's look's. A replay config with "learning": false declares runs that never teach
 *   evaluator       the mechanical verifier (train/evaluator.js): { prop, data: { SYMBOL: bar file }, ...settings };
 *                   none: a strategy or rulebook change stays blocked
 *   probe           Propose-Probe-Compose (train/probe-config.js, train/probe.js): { replay (a stage-1 curated practice
 *                   config), windows (practice-train), k, parallel }; needs modelScore (the combined change's keep rule)
 *   modelScore      the model-scoring verifier (train/model-verifier.js): { account, paths, reps, faults }: the challenger's
 *                   own replays of every window, judged against the champion's by the keep rule (the paired 30-day Monte
 *                   Carlo and the paired decision measures). With it, tuningWindows lie in practice-train and heldOutWindows
 *                   each in one held-back learning window (practice-validate, test, final), read through learning looks
 *
 *   resolveLoop(raw, { baseDir, env, root })   the resolved config, with `hash` (limits left out: they may be raised on resume)
 *   windowRange(w)                             { start, end } Dates: session `from`'s start to session `to`'s start
 *   replayFor(loop, { label, window })         the replay config for one window's run
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { expandHome } = require('../paths');
const { validateConfig } = require('../autotrader');
const { tradingDayStart } = require('../trading/clock');
const { ruleFrom } = require('./paired');
const { resolveEvaluator } = require('./evaluator');
const MV = require('./model-verifier');
const { resolveProbe } = require('./probe-config');

const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { maxIterations: [1, 1, 100], maxModelCalls: [200, 1, 100000], maxWallMinutes: [240, 1, 7 * 24 * 60] };

function readSpec(spec, baseDir, what) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) return spec;
  if (typeof spec !== 'string' || !spec) throw new Error(`${what}: an object or a path to a JSON file`);
  return JSON.parse(fs.readFileSync(path.resolve(baseDir, expandHome(spec)), 'utf8'));
}

/** Session date D starts at 18:00 New York time the evening before (clock.tradingDayStart). */
const sessionStart = d => tradingDayStart(new Date(`${d}T12:00:00Z`));
const windowRange = w => ({ start: sessionStart(w.from), end: sessionStart(w.to) });

function windowsErrors(list, key) {
  if (!Array.isArray(list) || !list.length) return [`${key}: one or more { from, to } session-date windows`];
  return list.flatMap((w, i) => (w && DATE.test(w.from) && DATE.test(w.to) && w.from < w.to && Object.keys(w).length === 2 ? [] : [`${key}[${i}]: { from, to }, YYYY-MM-DD, from before to`]));
}

function int(v, [def, min, max], key, errors) {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < min || v > max) errors.push(`${key}: a whole number from ${min} to ${max}`);
  return v;
}

const LEARNING_KEYS = ['evaluation', 'validate'];

/** The loop's learning settings (learning/run-gate.js), checked: null when none. */
function learningErrors(l, errors) {
  if (l === undefined || l === null) return null;
  if (typeof l !== 'object' || Array.isArray(l)) { errors.push(`learning: { ${LEARNING_KEYS.join(', ')} }`); return null; }
  for (const k of Object.keys(l)) if (!LEARNING_KEYS.includes(k)) errors.push(`learning.${k}: not a setting (${LEARNING_KEYS.join(', ')})`);
  if (l.evaluation !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(l.evaluation))) errors.push('learning.evaluation: an evaluation id (letters, digits, ".", "_", "-")');
  if (l.validate !== undefined && typeof l.validate !== 'boolean') errors.push('learning.validate: true or false');
  // A reasoning-fix look hides its outcomes; the loop reads every outcome (its scorecards, its paired test): refused.
  if (l.reasoningFix !== undefined) errors.push('learning.reasoningFix: refused in the training loop, which reads every outcome (a reasoning-fix look hides them)');
  return { ...l };
}

function resolveLoop(raw, { baseDir = process.cwd() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  if (!LOOP_ID.test(String(r.loopId || ''))) errors.push('loopId: letters, digits, ".", "_", "-" (up to 48), starting with a letter or digit');
  errors.push(...windowsErrors(r.tuningWindows, 'tuningWindows'));
  if (r.heldOutWindows !== undefined) errors.push(...windowsErrors(r.heldOutWindows, 'heldOutWindows'));
  let replay = null;
  let proposer = null;
  try { replay = readSpec(r.replay, baseDir, 'replay'); } catch (err) { errors.push(`replay: ${err.message}`); }
  try { proposer = validateConfig(readSpec(r.proposer, baseDir, 'proposer')); } catch (err) { errors.push(`proposer: ${err.message}`); }
  if (replay && !(typeof replay.workDir === 'string' && /^(\/|~\/)/.test(replay.workDir))) errors.push('replay.workDir: an absolute path or ~/...');
  const repeats = int(r.repeats, [3, 1, 20], 'repeats', errors);
  const seed = int(r.seed, [1, 0, 2147483646], 'seed', errors);
  const maxFlagged = int(r.maxFlagged, [12, 1, 500], 'maxFlagged', errors);
  const controlPoints = int(r.controlPoints, [12, 0, 500], 'controlPoints', errors);
  const maxProposals = int(r.maxProposals, [2, 1, 5], 'maxProposals', errors);
  const lim = r.limits && typeof r.limits === 'object' ? r.limits : {};
  for (const k of Object.keys(lim)) if (!(k in LIMITS)) errors.push(`limits.${k}: not a limit (${Object.keys(LIMITS).join(', ')})`);
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([k, spec]) => [k, int(lim[k], spec, `limits.${k}`, errors)]));
  let evaluator = null;
  try { evaluator = resolveEvaluator(r.evaluator, baseDir); } catch (err) { errors.push(err.message); }
  let rule = null;
  try { rule = ruleFrom(r.decision); } catch (err) { errors.push(err.message); }
  const learning = learningErrors(r.learning, errors);
  let probe = null;
  try { probe = resolveProbe(r.probe, { read: spec => readSpec(spec, baseDir, 'probe.replay'), modelScore: r.modelScore }); } catch (err) { errors.push(err.message); }
  let modelScore = null;
  try { modelScore = MV.resolveModelScore(r.modelScore); } catch (err) { errors.push(err.message); }
  if (modelScore) {
    errors.push(...MV.windowErrors(Array.isArray(r.tuningWindows) ? r.tuningWindows : [], Array.isArray(r.heldOutWindows) ? r.heldOutWindows : []));
    // Held-out runs take learning looks (learning/run-gate.js), which need the evaluation id their arms share.
    if (r.heldOutWindows && !(learning && learning.evaluation)) errors.push('learning.evaluation: the model-scored loop judges held out through learning looks, which need an evaluation id');
  }
  if (errors.length) throw new Error(`invalid training-loop config:\n- ${errors.join('\n- ')}`);
  // A replay config's autotrader given as a path resolves against this file's folder.
  if (typeof replay.autotrader === 'string') replay = { ...replay, autotrader: readSpec(replay.autotrader, baseDir, 'replay.autotrader') };
  const loop = {
    loopId: r.loopId, replay, proposer, tuningWindows: r.tuningWindows, heldOutWindows: r.heldOutWindows || null,
    repeats, seed, maxFlagged, controlPoints, maxProposals, limits, rule, evaluator,
    // Only when set: a loop without it keeps its hash (a resumed loop is the same loop).
    ...(learning ? { learning } : {}),
    ...(modelScore ? { modelScore } : {}),
    ...(probe ? { probe } : {}),
    workDir: path.join(path.resolve(expandHome(replay.workDir)), r.loopId),
  };
  const { limits: _l, ...identity } = loop;
  loop.hash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return loop;
}

/** The replay config of one window's run (label: champion-t0, champion-h1, ...). */
function replayFor(loop, { label, window }) {
  const { start, end } = windowRange(window);
  return { ...loop.replay, runId: `${loop.loopId}-${label}`, workDir: path.join(loop.workDir, 'runs'), start: start.toISOString(), end: end.toISOString() };
}

module.exports = { resolveLoop, windowRange, replayFor, LIMITS };
