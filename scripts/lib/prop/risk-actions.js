'use strict';

/**
 * The model's risk actions inside the code's ceilings, each scored against its counterfactual through the same 30-day
 * Monte Carlo paths (prop/evaluator.js scoreArms). Code sets the ceilings (the verdict's size, the daily stops, the
 * gate); inside them the model decides, and this says whether each kind of decision raised or lowered the pass rate
 * and the blow rate, by the account state it met. Counterfactual throughout, and labelled so: it reverts one kind of
 * action and replays the same paths.
 *
 * The actions, from what the run recorded (prop/model-stream.js; no field added but the experience log's fill size and
 * counterfactual fill time):
 *   pass        a pass on a valid composed setup (an ok record, no fill, no gate refusal); the counterfactual takes it
 *               at the ceiling, its outcome the experience log's limitOutcome (the record's limit, stop and target)
 *   day-stop    such a pass after an entry of the same day closed at a loss (standing down before the code's daily
 *               stop); counterfactual as a pass
 *   size-down   an entry filled under the ceiling of the verdict it was sized under; the counterfactual takes the
 *               ceiling (the model's share is otherwise kept: the base sizes every entry at the model's own share)
 *   early-exit  an entry closed before its stop, its target and end of day; the counterfactual holds it to its bracket
 *               (limitOutcome's rule on the run's bars). A stop the model tightened, a trail the runner moved and a
 *               manual close are one action here: nothing recorded tells them apart (the closing order's origin would)
 * Only outcomes the run observed or limitOutcome's rule on the run's own bars: no other future data.
 *
 * The state (risk-attribution.js stateOf) is the Monte Carlo's own, as the path stands when the decision comes up:
 * each arm reverts its kind of action only in its state ('all': in any), so the difference is that state's actions'.
 *
 * The base is the model as it traded: every entry at its own share of the ceiling (never fewer than one contract when
 * it filled one), so its rates differ from the run's score (which sizes every entry at the full ceiling); each line
 * shows the base beside the difference. Like the score, an arm settles each trade alone: a pass taken, or an entry held
 * past the next one, is replayed after it, not beside it (the overlap a real score refuses is not checked here).
 *
 *   KINDS, STATES
 *   riskActionArms()                     { base, arms: { '<kind>|<state>': decide } } for scoreArms
 *   scoreRiskActions(stream, opts)       { counterfactual: true, base, actions: { kind: { n, byState: { state: row } } } }
 *       row: { applied (paths), diff: { passRate, blowRate } (the model's minus the counterfactual's, paired),
 *       savedBlows, causedBlows, costPasses, gainedPasses, effect: { pass, blow } ('raised' | 'lowered' | 'no significant') }
 *   riskActionRecord(result, { minN, maxBytes })   { kind, cells, text } at most 4 KB, each line with its sample size
 */

const { scoreArms } = require('./evaluator');
const { STATES: STATE_LIST, stateOf, HELD_OUT } = require('./risk-attribution');

const KINDS = Object.freeze(['pass', 'day-stop', 'size-down', 'early-exit']);
const STATES = Object.freeze([...STATE_LIST, 'all']);
const MAX_BYTES = 4096;

// The model's own share of the ceiling; a share that rounds to no contract still takes one (the model filled one).
const own = t => ({ fraction: t.sizeFraction ?? 1, keepOne: true });

/** The model's own decisions (base) and one arm per kind of action and state that reverts it there. */
function riskActionArms() {
  const base = t => (t.counterfactual ? null : own(t));
  const arms = {};
  for (const kind of KINDS) {
    for (const state of STATES) {
      arms[`${kind}|${state}`] = (t, { cs }) => {
        const here = state === 'all' || stateOf(cs) === state;
        const acts = t.actions || [];
        if (t.counterfactual) return here && acts.includes(kind) ? { fraction: 1, changed: true } : null;
        if (here && kind === 'size-down' && acts.includes('size-down')) return { fraction: 1, changed: true };
        if (here && kind === 'early-exit' && acts.includes('early-exit') && t.hold) return { ...own(t), trade: { ...t, ...t.hold }, changed: true };
        return own(t);
      };
    }
  }
  return { base, arms };
}

const effectOf = i => (i.lo > 0 ? 'raised' : i.hi < 0 ? 'lowered' : 'no significant');

function scoreRiskActions(stream, opts = {}) {
  const { base, arms } = riskActionArms();
  const r = scoreArms(stream, { ...opts, base, arms });
  const all = stream.days.flatMap(d => [...d.trades, ...(d.passed || [])]);
  const actions = {};
  for (const kind of KINDS) {
    const byState = {};
    for (const state of STATES) {
      const a = r.arms[`${kind}|${state}`];
      byState[state] = {
        applied: a.applied, diff: a.diff, savedBlows: a.saved, causedBlows: a.caused, costPasses: a.costPasses, gainedPasses: a.gainedPasses,
        effect: { pass: effectOf(a.diff.passRate), blow: effectOf(a.diff.blowRate) },
      };
    }
    actions[kind] = { n: all.filter(t => (t.actions || []).includes(kind)).length, byState };
  }
  return { counterfactual: true, base: r.base, actions, inputs: r.inputs, look: r.look };
}

const WORDS = { pass: 'standing down (a pass on a valid setup)', 'day-stop': 'stopping for the day after a loss', 'size-down': 'sizing under the ceiling', 'early-exit': 'exiting before the stop or target' };
const STATE_WORDS = { fresh: 'fresh (first session)', mid: 'mid-attempt', 'near-target': 'near the target', 'near-mll': 'near the max loss limit', all: 'in any state' };

/**
 * The per-state risk-action record, for the learning loop to show (off by default; prop/model-score.js): one line per
 * kind and state with at least minN paths it changed, e.g. "near the max loss limit, standing down (a pass on a valid
 * setup): n 30 paths, saved 4 blows, caused 0, cost 1 pass, gained 2". Counterfactual, and said so; at most maxBytes.
 */
function riskActionRecord(result, { minN = 10, maxBytes = MAX_BYTES, role = null } = {}) {
  if (!result || !result.actions) throw new Error('riskActionRecord: a scoreRiskActions result');
  // Validation, test and final outcomes choose or judge; the model never sees them (practice-train only).
  const sealed = HELD_OUT.find(r => r === role || (result.look && r === result.look.role));
  if (sealed) throw new Error(`a ${sealed} run's outcomes are judged, never shown to the model: no risk-action record`);
  const cells = [];
  for (const kind of KINDS) {
    for (const state of STATES) {
      const row = result.actions[kind].byState[state];
      if (row.applied >= minN) cells.push({ kind, state, n: row.applied, savedBlows: row.savedBlows, causedBlows: row.causedBlows, costPasses: row.costPasses, gainedPasses: row.gainedPasses });
    }
  }
  const head = 'Risk actions (counterfactual: the Monte Carlo replayed with each kind of your risk action reverted; n = paths it changed):';
  let lines = cells.sort((a, b) => b.n - a.n).map(c => `${STATE_WORDS[c.state]}, ${WORDS[c.kind]}: n ${c.n} paths, saved ${c.savedBlows} blows, caused ${c.causedBlows}, cost ${c.costPasses} passes, gained ${c.gainedPasses}`);
  const size = ls => Buffer.byteLength([head, ...ls].join('\n'), 'utf8');
  while (lines.length && size(lines) > maxBytes) lines = lines.slice(0, -1);
  return { kind: 'risk-action-record', version: 1, counterfactual: true, minN, cells, text: [head, ...lines].join('\n') };
}

module.exports = { KINDS, STATES, MAX_BYTES, riskActionArms, scoreRiskActions, riskActionRecord };
