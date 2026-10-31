'use strict';

/**
 * The goal regression's deliberate breaks (tests/goal/tier2.goal.js, the mutation checks): preloaded (`--require`) into
 * the tier 2 day's process and, through NODE_OPTIONS, every harness process it starts (the harness tools, the order
 * gateway), so the break sits where a real regression would. FTH_GOAL_BREAK names one; none set: nothing changes.
 * Each patches one shipped module's export before any consumer reads it:
 *
 *   drop-setups      the briefing lists no setup: no "Setups to check" line (setup-moments.js checkLine) and no scan
 *                    candidate (strategies.js scan: none fired)                                     -> category a
 *   compose-refuse   compose_check refuses every combination (composed-reads.js checkReads: one problem added) -> b
 *   phase2-unread    the runner can't read phase 2's size on a valid `VERDICT: APPROVE - size n` (roles-ran.js
 *                    approvedSize)                                                                  -> c
 *   gate-refuse      the order gate refuses every entry (order-gate.js evaluateOrder: one violation added) -> d
 *   stale-trail      the runner's structure trail stands behind a stale swing (exit-trail.js swingAtBar on the bars
 *                    STALE_BARS before the bar)                                                     -> g
 *   no-micro-fallback  the sizing as it was before 2026-10-30 (budget first, then the cap): in auto mode the budget's
 *                    mini that the composed cap prices out sizes nothing (size-translate.js entryPlan replaced by
 *                    limitPlan on contractPlan) -> the sizing check (goal-sizing.js: the simulator skips a trade live sizes)
 * (Category e, the order's timing, is a world option: the clock runs on before the order, tests/fixtures/goal-world.js.)
 */

const path = require('path');

const LIB = path.resolve(__dirname, '..', '..', 'scripts', 'lib');
const STALE_BARS = 40;
const which = process.env.FTH_GOAL_BREAK || '';

if (which === 'drop-setups') {
  const SM = require(path.join(LIB, 'learning', 'setup-moments'));
  SM.checkLine = () => null;
  const ST = require(path.join(LIB, 'trading', 'strategies'));
  const scan = ST.scan;
  ST.scan = (...a) => scan(...a).map(r => ({ ...r, candidate: false }));
} else if (which === 'compose-refuse') {
  const CR = require(path.join(LIB, 'trading', 'composed-reads'));
  const check = CR.checkReads;
  CR.checkReads = (...a) => { const r = check(...a); return { ...r, ok: false, problems: [...r.problems, 'goal break: compose_check refuses this combination'] }; };
} else if (which === 'phase2-unread') {
  const RR = require(path.join(LIB, 'trading', 'roles-ran'));
  RR.approvedSize = () => ({ error: 'goal break: the approval\'s size is unreadable' });
} else if (which === 'gate-refuse') {
  const OG = require(path.join(LIB, 'trading', 'order-gate'));
  const evaluate = OG.evaluateOrder;
  OG.evaluateOrder = (o, ...rest) => {
    const r = evaluate(o, ...rest);
    const input = (o && o.input) || {};
    const entry = !input.stopPrice && !/^\s*\[(exit|protect)\]/.test(String(input.rationale || '')) && /^setup:/.test(String(input.rationale || ''));
    return entry ? { ...r, violations: [...(r.violations || []), { check: 'goal-break', message: 'goal break: the gate refuses this entry' }] } : r;
  };
} else if (which === 'stale-trail') {
  const ET = require(path.join(LIB, 'trading', 'exit-trail'));
  const at = ET.swingAtBar;
  ET.swingAtBar = (bars, bar, minutes, sign) => {
    const i = bars.indexOf(bar);
    const j = i - STALE_BARS;
    return j >= 0 ? at(bars.slice(0, j + 1), bars[j], minutes, sign) : at(bars, bar, minutes, sign);
  };
} else if (which === 'no-micro-fallback') {
  const ST = require(path.join(LIB, 'prop', 'size-translate'));
  const combine = require(path.join(LIB, 'trading', 'combine'));
  ST.entryPlan = (args, opts = {}) => ST.limitPlan(combine.contractPlan(args), { ...opts, minContracts: args.minContracts, ratio: args.ratio, miniRoot: args.legs && args.legs.mini ? args.legs.mini.root : null });
} else if (which) {
  throw new Error(`FTH_GOAL_BREAK=${which}: not a goal break (drop-setups, compose-refuse, phase2-unread, gate-refuse, stale-trail, no-micro-fallback)`);
}
