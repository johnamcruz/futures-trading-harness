'use strict';

/**
 * Risk attribution of the prop Monte Carlo (prop/evaluator.js, `attribution: true`): the attempts broken down by the
 * account state each decision met, so the risk skills (position sizing, pacing) can be taught from what cost attempts.
 *
 * The state (stateOf, shared with prop/account-states.js), from the account as the decision met it, first that holds:
 *   near-mll      the cushion to the floor at most NEAR_MLL of the max loss limit
 *   near-target   the profit at least NEAR_TARGET of the target
 *   fresh         the attempt's first session
 *   mid           any other
 *
 * Per state: the entries taken; the model's passes (decisions it passed on, counted at the state its day opened in:
 * a pass has no fill to time it by); the entries the account layer passed over (no size, a block); the mean R of
 * those taken; and how often a trade taken there was in an attempt that blew, or that passed, and how often it was
 * itself the blow (it reached the floor) or the daily stop.
 *
 * Decisions that cost attempts (`flagged`, by decision id, counted over the paths):
 *   near-mll-blown      taken near the max loss limit, in an attempt that blew
 *   daily-stop-extra    taken after a loss the same day, and it took the day to the daily limit or the soft stop
 *   near-target-forced  taken near the target, it lost, and the attempt did not pass
 * The account line's facts (combine.attemptFacts, the one function live shows) decide the daily-stop flag.
 *
 * Per state and context value (the record's alignment, biasSide, window, regime): the same counts, the cells the risk
 * record is built from (riskRecord): what the learning loop can show the model about its own trades by account state,
 * apart from its trade cells (each line with its sample size).
 *
 *   stateOf(cs)                     fresh | mid | near-target | near-mll
 *   createAttribution()             { observe(list) -> runAttempt hooks, end(status), result() }
 *   riskRecord(attribution, { minN, maxBytes })   { kind, version, cells, text } (text at most maxBytes, 4 KB)
 */

const combine = require('../trading/combine');

const STATES = Object.freeze(['fresh', 'mid', 'near-target', 'near-mll']);
const CUT = require('../tunables').replay().accountStates.cutoffs; // config/replay.json (the states the draw buckets)
const NEAR_MLL = CUT.nearMll;
const NEAR_TARGET = CUT.nearTarget;
const CELL_KEYS = Object.freeze(['alignment', 'biasSide', 'window', 'regime']);
const MAX_BYTES = require('../tunables').training().riskRecord.maxBytes; // config/training.json
/** The learning roles whose outcomes never reach the model as a record: validation chooses, test and final judge. */
const HELD_OUT = Object.freeze(['practice-validate', 'test', 'final']);

function stateOf(cs) {
  if (cs.balance - cs.floor <= NEAR_MLL * cs.maxLoss) return 'near-mll';
  if (cs.balance - cs.start >= NEAR_TARGET * cs.target) return 'near-target';
  if (!cs.days.length) return 'fresh';
  return 'mid';
}

const blankState = () => ({ taken: 0, passed: 0, skipped: 0, sumR: 0, withR: 0, ledToBlow: 0, ledToPass: 0, blewHere: 0, dailyStopHere: 0 });
const r4 = x => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

function createAttribution() {
  const states = Object.fromEntries(STATES.map(s => [s, blankState()]));
  const cells = new Map();
  const flags = new Map();
  let attempts = 0;
  let current = null;
  const flag = (t, kind, state) => {
    const k = `${t.id}|${kind}`;
    const f = flags.get(k) || { id: t.id, kind, state, bar: t.bar || null, symbol: t.symbol, count: 0 };
    f.count += 1;
    flags.set(k, f);
  };
  return {
    /** The hooks for one attempt over `list` (the attempt's days, in order). */
    observe(list) {
      current = { taken: [] };
      return {
        onDay: (cs, d) => { states[stateOf(cs)].passed += Number(list[d] && list[d].passes) || 0; },
        onSkip: ({ cs }) => { states[stateOf(cs)].skipped += 1; },
        onTrade: ({ before, after, trade, net, gross, forced, counters }) => {
          const st = stateOf(before);
          const facts = combine.attemptFacts(after, { ...counters, tradesToday: counters.tradesToday + 1, lossesToday: counters.lossesToday + (gross < 0 ? 1 : 0) });
          current.taken.push({ st, trade, net, forced, lossBefore: counters.lossesToday > 0, stopped: forced === 'daily' || after.dayStopped || facts.softRoom === 0 });
        },
      };
    },
    /** The attempt ended with `status`. */
    end(status) {
      attempts += 1;
      for (const x of current ? current.taken : []) {
        const s = states[x.st];
        s.taken += 1;
        if (Number.isFinite(x.trade.r)) { s.sumR += x.trade.r; s.withR += 1; }
        if (status === 'blown') s.ledToBlow += 1;
        if (status === 'passed') s.ledToPass += 1;
        if (x.forced === 'blow') s.blewHere += 1;
        if (x.forced === 'daily') s.dailyStopHere += 1;
        for (const k of CELL_KEYS) {
          const v = x.trade.facts && x.trade.facts[k] !== null && x.trade.facts[k] !== undefined ? String(x.trade.facts[k]) : null;
          if (v === null) continue;
          const key = `${x.st}|${k}|${v}`;
          const c = cells.get(key) || { state: x.st, key: k, value: v, n: 0, blows: 0, passes: 0, sumR: 0, withR: 0 };
          c.n += 1;
          if (status === 'blown') c.blows += 1;
          if (status === 'passed') c.passes += 1;
          if (Number.isFinite(x.trade.r)) { c.sumR += x.trade.r; c.withR += 1; }
          cells.set(key, c);
        }
        if (x.st === 'near-mll' && status === 'blown') flag(x.trade, 'near-mll-blown', x.st);
        if (x.lossBefore && x.stopped) flag(x.trade, 'daily-stop-extra', x.st);
        if (x.st === 'near-target' && x.net < 0 && status !== 'passed') flag(x.trade, 'near-target-forced', x.st);
      }
      current = null;
    },
    result() {
      const out = {};
      for (const [k, s] of Object.entries(states)) {
        out[k] = {
          taken: s.taken, passed: s.passed, skipped: s.skipped, meanR: s.withR ? r4(s.sumR / s.withR) : null,
          ledToBlow: s.ledToBlow, ledToPass: s.ledToPass, blowShare: s.taken ? r4(s.ledToBlow / s.taken) : null, passShare: s.taken ? r4(s.ledToPass / s.taken) : null,
          blewHere: s.blewHere, dailyStopHere: s.dailyStopHere,
        };
      }
      return {
        attempts, thresholds: { nearMll: NEAR_MLL, nearTarget: NEAR_TARGET }, states: out,
        cells: [...cells.values()].map(c => ({ state: c.state, key: c.key, value: c.value, n: c.n, blows: c.blows, passes: c.passes, meanR: c.withR ? r4(c.sumR / c.withR) : null }))
          .sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.key.localeCompare(b.key) || a.value.localeCompare(b.value)),
        flagged: [...flags.values()].sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id))).slice(0, 50),
      };
    },
  };
}

const STATE_WORDS = { fresh: 'fresh (first session)', mid: 'mid-attempt', 'near-target': 'near the target', 'near-mll': 'near the max loss limit' };

/**
 * The risk record: the attribution's cells with at least `minN` trades, as lines the learning loop can show, each with
 * its sample size ("near the max loss limit, alignment=counter: n 40, 9 in attempts that blew, 3 that passed, mean R
 * -0.42"), the whole text at most maxBytes (fewest-sample lines dropped first). For a model run's attribution: a test or
 * final role (the attribution's own, or `role`) is refused (the learning split's sealed windows; a mechanical pass's
 * schedule roles are not checked here). Counts over Monte Carlo paths: a trade
 * is counted once per path it was taken on. Kept apart from the model's trade cells.
 */
function riskRecord(attribution, { minN = require('../tunables').training().riskRecord.minN, maxBytes = MAX_BYTES, source = null, role = null } = {}) {
  if (!attribution || !attribution.states) throw new Error('riskRecord: a risk attribution (prop/evaluator.js, attribution: true)');
  // Validation, test and final outcomes choose or judge; the model never sees them (practice-train only).
  const sealed = HELD_OUT.find(r => r === role || r === attribution.role);
  if (sealed) throw new Error(`a ${sealed} run's outcomes are judged, never shown to the model: no risk record`);
  const line = (label, c) => `${label}: n ${c.n}, ${c.blows} in attempts that blew, ${c.passes} that passed, mean R ${c.meanR === null ? '-' : c.meanR}`;
  const stateLines = STATES.map(s => ({ n: attribution.states[s].taken, text: line(STATE_WORDS[s], { n: attribution.states[s].taken, blows: attribution.states[s].ledToBlow, passes: attribution.states[s].ledToPass, meanR: attribution.states[s].meanR }) })).filter(x => x.n >= minN);
  const cellLines = attribution.cells.filter(c => c.n >= minN).map(c => ({ n: c.n, text: line(`${STATE_WORDS[c.state]}, ${c.key}=${c.value}`, c) }));
  const head = `Risk record (prop Monte Carlo over ${attribution.attempts} attempts; counts per path, not per trade; apart from your trade record):`;
  let lines = [...stateLines, ...cellLines.sort((a, b) => b.n - a.n)];
  const size = ls => Buffer.byteLength([head, ...ls.map(l => l.text)].join('\n'), 'utf8');
  while (lines.length && size(lines) > maxBytes) lines = lines.slice(0, -1);
  return {
    kind: 'risk-record', version: 1, source, minN, thresholds: attribution.thresholds,
    cells: attribution.cells.filter(c => c.n >= minN), text: [head, ...lines.map(l => l.text)].join('\n'),
  };
}

module.exports = { STATES, HELD_OUT, NEAR_MLL, NEAR_TARGET, CELL_KEYS, MAX_BYTES, stateOf, createAttribution, riskRecord };
