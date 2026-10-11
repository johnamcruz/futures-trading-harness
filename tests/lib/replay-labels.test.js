'use strict';

// Labels from a replay run (scripts/lib/replay/labels.js), on synthetic run dirs: no real data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { labelRun, writeLabels, roundTrips, outcomeOf, atrAt, teacherAction, summaryText } = require('../../scripts/lib/replay/labels');

const DAY = '2026-03-03';
const RUN = 'r1';
const iso = ms => new Date(ms).toISOString();
const T0 = Date.parse(`${DAY}T14:30:02Z`); // a decision time: the 14:27 bar closed at 14:30
const at = k => T0 + k * 180000; // the k-th decision time (3-minute bars)
const WALL0 = Date.parse('2026-10-11T00:00:00Z'); // the wall clock the cycles and the gate log ran on

/**
 * 3-minute MNQ bars from 13:00Z to 21:00Z (past the 15:50 ET end of day): each one 10 points high to
 * low (ATR 10), but the 14:54 bar, which drops to 19970.
 */
function bars(n = 160) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ t: iso(Date.parse(`${DAY}T13:00:00Z`) + i * 180000), o: 20000, h: 20005, l: 19995, c: 20000, v: 100 });
  return out.map(b => (b.t === `${DAY}T14:54:00.000Z` ? { ...b, l: 19970 } : b));
}
// The strategies' exits: orb's target is 2R (its min_rr).
const STRATEGIES = [{ name: 'orb', valid: true, signal: 'rules', risk: { min_rr: 2 }, exit: {} }];

/**
 * A run home with its run dir. steps: [{ k, kind, cycle: { orders: [{ tool, input, gate }], positions, transcript }, scan, trades, interrupted, noCycle }]
 */
function makeRun({ steps, barList = bars(), budget } = {}) {
  const home = path.join(tmpDir(), 'replays', RUN);
  const runDir = path.join(home, 'replay', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-10'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId: RUN, hash: 'c'.repeat(64), harness: 'custom', model: 'teacher-1', daysDone: [DAY] }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols: ['MNQ'], timeframe: 3, account: '7' }));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: barList }));
  const lines = [];
  const gate = [];
  const scans = [];
  for (const [i, s] of steps.entries()) {
    const t = s.t || at(s.k);
    const barT = iso(t - 2000 - 180000);
    const wall = WALL0 + i * 60000;
    const rec = { v: 1, t: iso(t), day: DAY, kind: s.kind || 'trade', asked: s.kind || 'trade', ran: [], cycles: [], refusals: [], errors: [], bars: [{ symbol: 'MNQ', lastBarT: barT }], trades: s.trades || [], since: iso(t - 180000) };
    if (s.interrupted) Object.assign(rec, { interrupted: true, trades: null, bars: undefined });
    if (s.scan) scans.push({ at: iso(t), symbol: 'MNQ', contractId: 'MNQ', bar: { t: barT, c: 20000 }, candidates: s.scan.map(x => x.name), results: s.scan.map(x => ({ name: x.name, candidate: true, direction: x.direction, stopDistance: 10 })) });
    if (s.cycle) {
      const c = s.cycle;
      const file = path.join(home, 'logs', 'cycles', '2026-10-10', `${String(i).padStart(6, '0')}-trade.json`);
      const transcript = c.transcript !== undefined ? c.transcript : (c.orders || []).map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}-${j}`, name: `mcp__broker__${o.tool}`, input: o.input }] } })).join('\n');
      const result = c.result || 'CYCLE RESULT: done';
      fs.writeFileSync(file, JSON.stringify({ at: iso(wall), action: 'trade', prompt: `p${i}`, context: { symbols: [{ symbol: 'MNQ', bar: { t: barT, c: 20000 } }], account: { id: 7, balance: 50000, positions: c.positions || [], attempts: c.attempts || [] } }, transcript }));
      rec.ran.push({ action: 'trade', ok: true, result, symbols: ['MNQ'] });
      rec.cycles.push({ action: 'trade', at: iso(wall), ok: true, durationMs: 30000, result, promptHash: `hash${i}`, file });
      for (const [j, o] of (c.orders || []).entries()) {
        if (o.gate === 'none') continue;
        const g = o.gate || { source: 'gateway', decision: 'allowed', violations: [] };
        gate.push({ ts: iso(wall + 1000 + j * 100), tool: g.source === 'hook' ? undefined : o.tool, ...g, contractId: o.input.contractId, rationale: o.input.rationale });
        if (g.decision === 'blocked') rec.refusals.push({ ts: iso(wall + 1000), source: g.source, tool: null, contractId: o.input.contractId, checks: g.violations.map(v => v.check) });
      }
    }
    lines.push(rec);
  }
  fs.writeFileSync(path.join(runDir, `${DAY}.jsonl`), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), gate.map(g => `${JSON.stringify(g)}\n`).join(''));
  fs.writeFileSync(path.join(home, 'logs', `scans-${DAY}.jsonl`), scans.map(g => `${JSON.stringify(g)}\n`).join(''));
  return { home, runDir, budget };
}

const LONG = { tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:orb long above the range, stop 19990' } };
const fill = (min, side, price, pnl, extra = {}) => ({ id: `${min}-${side}`, contractId: 'MNQ', creationTimestamp: iso(T0 + min * 60000), price, profitAndLoss: pnl, fees: 0.37, side, size: 1, voided: false, orderId: 1, ...extra });
const LONG_POS = [{ contractId: 'MNQ', side: 'long', size: 1, averagePrice: 20000 }];
const SHORT_POS = [{ contractId: 'MNQ', side: 'short', size: 1, averagePrice: 20000 }];

/** The whole day: winner, managed, skipped, short loser, interrupted, refused, limit entry, no cycle, end of day. */
function fullRun() {
  return makeRun({
    steps: [
      // 0: a long at the market with a 40-tick (10 point = 1 ATR) stop: filled at 14:31, closed at 14:40 for +$40 (a broker round trip says 2R).
      { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [LONG], result: 'CYCLE RESULT: long MNQ' } },
      // 1: in the trade, the stop moved up: tighten. Fills since the last time: the entry.
      { k: 1, cycle: { positions: LONG_POS, orders: [{ tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice: 20000 } }] }, trades: [fill(1, 0, 20000, null, { entry: { setup: 'orb', stopTicks: 40, tickValue: 0.5 } })] },
      // 2: in the trade, nothing sent: hold.
      { k: 2, cycle: { positions: LONG_POS } },
      // 3: in the trade, closed: exit. The close fills at 14:40 (next line's fills).
      { k: 3, cycle: { positions: LONG_POS, orders: [{ tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] target zone' } }] } },
      // 4: flat, orb fired short, nothing sent: skipped.
      { k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: {}, trades: [fill(10, 1, 20020, 40, { roundTrip: { net: 39.26, r: 2, maeR: -0.25, mfeR: 2.5, reason: 'exit' } })] },
      // 5: a short at the market, stop from the rationale (20020 over a 20000 close: 20 points = 2 ATR); stopped out for -$20.
      { k: 5, cycle: { orders: [{ tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: 'setup:vwap short at the reject, stop 20020' } }] } },
      // 6: interrupted (the driver stopped mid-step): flagged, recorded from logs with no cycle.
      { k: 6, interrupted: true },
      // 7: flat again (the short's fills arrive here), a long refused by the hook: the intent kept, flagged refused.
      { k: 7, cycle: { orders: [{ ...LONG, input: { ...LONG.input, rationale: 'setup:orb long again, stop 19990' }, gate: { source: 'hook', decision: 'blocked', violations: [{ check: 'plan-required', message: 'no plan' }] } }] }, trades: [fill(16, 1, 20000, null), fill(20, 0, 20010, -20)] },
      // 8: a limit entry: uncloneable, never filled.
      { k: 8, cycle: { orders: [{ tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice: 19990, size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, takeProfitBracket: { ticks: 80, type: 'limit' }, rationale: 'setup:orb long on a pullback, stop 19980' } }] } },
      // 9: a trade time with no cycle, while orb fired: counted, not a teacher decision.
      { k: 9, scan: [{ name: 'orb', direction: 'long' }] },
      // 10: end of day.
      { t: Date.parse(`${DAY}T20:50:02Z`), kind: 'eod' },
    ],
  });
}

const byK = labels => Object.fromEntries(labels.map((l, i) => [i, l]));

test('labels: a taken winner, managed, skipped, a short loser, refused, limit entry, no cycle, interrupted, end of day', () => {
  const { runDir } = fullRun();
  const { labels, summary } = labelRun(runDir, { budgetUsd: 40, strategies: STRATEGIES });
  assert.strictEqual(labels.length, 11, 'one label per decision time (one symbol)');
  const L = byK(labels);

  // The winner: long, setup orb, a 1 ATR stop, half the budget; filled and closed for 2R (the broker's round trip).
  assert.strictEqual(L[0].decision, 'flat');
  assert.deepStrictEqual(L[0].candidates, [{ name: 'orb', direction: 'long' }]);
  assert.strictEqual(L[0].teacher.action, 'long');
  assert.strictEqual(L[0].teacher.setup, 'orb');
  assert.deepStrictEqual(L[0].teacher.stop, { ticks: 40, points: 10, atr: 10, ratio: 1, multiple: 1 });
  assert.deepStrictEqual([L[0].teacher.size.riskUsd, L[0].teacher.size.step], [20, 0.5]);
  assert.deepStrictEqual(L[0].gate, { decision: 'allowed', checks: [] });
  assert.deepStrictEqual([L[0].outcome.filled, L[0].outcome.result, L[0].outcome.r, L[0].outcome.net, L[0].outcome.maeR, L[0].outcome.mfeR], [true, 'win', 2, 39.26, -0.25, 2.5]);
  assert.strictEqual(L[0].outcome.entryTime, iso(T0 + 60000));
  assert.deepStrictEqual(L[0].clone, { ok: true, reasons: [] });
  assert.strictEqual(L[0].result, 'CYCLE RESULT: long MNQ');
  assert.deepStrictEqual(L[0].provenance, { harness: 'custom', model: 'teacher-1', configHash: 'c'.repeat(64), promptHash: 'hash0', cycleFile: 'logs/cycles/2026-10-10/000000-trade.json' });
  assert.strictEqual(L[0].teacher.orders[0].args, undefined);
  assert.strictEqual(L[0].teacher.orders[0].stopTicks, 40);

  // Managed: tighten, hold, exit, each in the open trade (its outcome attached).
  assert.deepStrictEqual([L[1].decision, L[1].teacher.action, L[1].gate.decision, L[1].clone.ok], ['in-trade', 'tighten', 'allowed', true]);
  assert.deepStrictEqual([L[2].decision, L[2].teacher.action, L[2].gate.decision], ['in-trade', 'hold', 'none']);
  assert.deepStrictEqual([L[3].decision, L[3].teacher.action, L[3].clone.ok], ['in-trade', 'exit', true]);
  assert.strictEqual(L[3].outcome.result, 'win');
  assert.deepStrictEqual(L[1].position, { side: 'long', size: 1, source: 'context' });

  // Skipped: flat, a candidate fired, no entry.
  assert.deepStrictEqual([L[4].decision, L[4].teacher.action, L[4].candidates], ['flat', 'none', [{ name: 'orb', direction: 'short' }]]);
  assert.strictEqual(L[4].clone.ok, true);
  // ... and orb's own short would have won: in at the 14:42 bar's open less a tick, 2R target hit by the 14:54 drop.
  const cf4 = L[4].counterfactual;
  assert.deepStrictEqual([cf4.strategy, cf4.entry, cf4.stop, cf4.target, cf4.exitReason, cf4.R, cf4.result, cf4.simulated], ['orb', 19999.75, 20009.75, 19979.75, 'target', 2, 'win', true]);
  assert.deepStrictEqual(L[4].counterfactuals, [cf4]);

  // The taken trades carry the same fields from their fills.
  assert.deepStrictEqual([L[0].counterfactual.source, L[0].counterfactual.entry, L[0].counterfactual.stop, L[0].counterfactual.R, L[0].counterfactual.pnl, L[0].counterfactual.result], ['fills', 20000, 19990, 2, 40, 'win']);
  assert.deepStrictEqual([L[5].counterfactual.entry, L[5].counterfactual.stop, L[5].counterfactual.R, L[5].counterfactual.result], [20000, 20020, -0.5, 'loss']);
  assert.strictEqual(L[1].counterfactual, null, 'none on a managed decision');

  // The short loser: R negative (-$20 on a $40 risk: 80 ticks x $0.50), its stop 2 ATR, the full budget.
  assert.strictEqual(L[5].teacher.action, 'short');
  assert.deepStrictEqual(L[5].teacher.stop, { ticks: 80, points: 20, atr: 10, ratio: 2, multiple: 2 });
  assert.strictEqual(L[5].teacher.size.step, 1);
  assert.deepStrictEqual([L[5].outcome.result, L[5].outcome.r, L[5].outcome.pnl, L[5].outcome.net, L[5].outcome.side], ['loss', -0.5, -20, -20.74, 'sell']);

  // Interrupted: flagged, no cycle, out of cloning.
  assert.deepStrictEqual([L[6].interrupted, L[6].decision, L[6].teacher], [true, 'no-cycle', null]);
  assert.ok(L[6].clone.reasons.includes('interrupted'));

  // Refused: the intent kept (long, orb), flagged refused with the check; no outcome but refused.
  assert.deepStrictEqual([L[7].teacher.action, L[7].gate.decision, L[7].gate.checks, L[7].outcome.result], ['long', 'refused', ['plan-required'], 'refused']);
  assert.strictEqual(L[7].clone.ok, true, 'cloneable as intent; the BC config decides on refused ones');

  // The limit entry with a target: uncloneable, counted; never filled.
  assert.deepStrictEqual([L[8].teacher.action, L[8].clone.ok, L[8].outcome.result], ['long', false, 'unfilled']);
  assert.deepStrictEqual(L[8].clone.reasons, ['limit entry', 'explicit target']);

  // No cycle while orb fired: not a teacher decision. Its long would have been flat to end of day (a small loss).
  assert.deepStrictEqual([L[9].decision, L[9].teacher, L[9].candidates.length], ['no-cycle', null, 1]);
  assert.deepStrictEqual([L[9].counterfactual.exitReason, L[9].counterfactual.R, L[9].counterfactual.result], ['eod', -0.025, 'loss']);
  assert.strictEqual(L[10].decision, 'housekeeping');

  assert.deepStrictEqual(
    [summary.labels, summary.decisions, summary.taken, summary.skipped, summary.refused, summary.wins, summary.losses, summary.uncloneable, summary.unmapped, summary.noCycle, summary.noCycleWithCandidates, summary.interrupted, summary.housekeeping],
    [11, 8, 3, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1],
  );
  assert.deepStrictEqual([summary.holds, summary.tightens, summary.exits, summary.unfilled], [1, 1, 1, 1]);
  assert.deepStrictEqual(summary.uncloneableBy, { 'explicit target': 1, 'limit entry': 1 });
  assert.deepStrictEqual(
    [summary.takenWon, summary.takenLost, summary.skippedWouldWin, summary.skippedWouldLose, summary.noCycleWouldWin, summary.noCycleWouldLose, summary.unsimulated],
    [1, 1, 1, 0, 0, 1, 0],
  );
  assert.match(summaryText(summary), /decisions 8, taken 3, skipped 1, refused 1, wins 1, losses 1, uncloneable 1, unmapped 0/);
});

test('labels: no ATR (too few bars closed by t) leaves the stop unmapped and counts it', () => {
  const { runDir } = makeRun({ barList: bars(10), steps: [{ k: 0, cycle: { orders: [LONG] } }] });
  const { labels, summary } = labelRun(runDir);
  assert.deepStrictEqual(labels[0].teacher.stop, { ticks: 40, points: 10, atr: null, ratio: null, multiple: null });
  assert.deepStrictEqual(labels[0].clone, { ok: false, reasons: ['stop not mapped to ATR'] });
  assert.strictEqual(summary.unmapped, 1);
  // No budget given and no prop attempt: the size step is unknown, counted.
  assert.strictEqual(labels[0].teacher.size.step, null);
  assert.strictEqual(summary.unsized, 1);
});

test('labels: an active prop attempt sets the budget (the default share of its cushion)', () => {
  const { runDir } = makeRun({ steps: [{ k: 0, cycle: { orders: [LONG], attempts: [{ account: 'topstep_50k', status: 'active', cushion: 200, entryBlock: null }] } }] });
  const { labels } = labelRun(runDir);
  assert.deepStrictEqual([labels[0].teacher.size.budgetUsd, labels[0].teacher.size.ratio, labels[0].teacher.size.step], [40, 0.5, 0.5]);
});

test('labels: no lookahead - bars and scans after t never change an earlier label', () => {
  const run = fullRun();
  const before = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  // A wild bar right after the first decision time, and a later scan of the first bar naming another strategy.
  const file = path.join(run.home, 'bars', 'MNQ-3m.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.bars = doc.bars.map(b => (b.t === iso(T0 - 2000) ? { ...b, h: 20500, l: 19500 } : b));
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.appendFileSync(path.join(run.home, 'logs', `scans-${DAY}.jsonl`), `${JSON.stringify({ at: iso(T0 + 60000), symbol: 'MNQ', bar: { t: iso(T0 - 182000), c: 1 }, results: [{ name: 'late', candidate: true, direction: 'short' }] })}\n`);
  const after = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  assert.deepStrictEqual(after[0], before[0], 'the first label sees only what was there at its time');
  // The bar does reach a later decision's ATR (it closed before it): the guard isn't vacuous.
  assert.notStrictEqual(after[5].teacher.stop.atr, before[5].teacher.stop.atr);
});

test('labels: future bars change counterfactuals only, never a decision-time field', () => {
  const run = fullRun();
  const decisionTime = l => { const { outcome: _o, counterfactual: _c, counterfactuals: _cs, ...rest } = l; return rest; };
  const before = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES }).labels;
  // Every bar after the skipped decision (14:42) rallies 30 points: orb's short now stops out.
  const file = path.join(run.home, 'bars', 'MNQ-3m.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.bars = doc.bars.map(b => (Date.parse(b.t) >= at(4) ? { ...b, h: b.h + 30, l: 19995 } : b));
  fs.writeFileSync(file, JSON.stringify(doc));
  const after = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES }).labels;
  // Every decision made before the changed bars closed (14:48) reads the same; later ones may (their ATR saw them).
  const early = l => Date.parse(l.t) < at(4) + 6 * 60000;
  assert.strictEqual(before.filter(early).length, 6);
  assert.deepStrictEqual(after.filter(early).map(decisionTime), before.filter(early).map(decisionTime));
  assert.deepStrictEqual([before[4].counterfactual.result, after[4].counterfactual.result], ['win', 'loss'], 'the counterfactual did see the change');
  // Bars given for the outcomes (the data the run replayed) are read for counterfactuals only.
  const other = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES, outcomeBars: { MNQ: bars().map(b => ({ ...b, ms: Date.parse(b.t) })) } }).labels;
  assert.deepStrictEqual(other.map(decisionTime), after.map(decisionTime));
  assert.strictEqual(other[4].counterfactual.result, 'win');
  // Without the strategy file the counterfactual can't be simulated: counted.
  const none = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual([none.labels[4].counterfactual.simulated, none.labels[4].counterfactual.reason, none.summary.unsimulated, none.summary.skippedUnsimulated], [false, 'strategy not found', 2, 1]);
});

test('labels: deterministic and idempotent; written in the run dir, refused inside the repository', () => {
  const run = fullRun();
  const a = writeLabels(run.runDir, { budgetUsd: 40 });
  const first = fs.readFileSync(a.file, 'utf8');
  const firstSummary = fs.readFileSync(path.join(run.runDir, 'labels-summary.json'), 'utf8');
  writeLabels(run.runDir, { budgetUsd: 40 });
  assert.strictEqual(fs.readFileSync(a.file, 'utf8'), first);
  assert.strictEqual(fs.readFileSync(path.join(run.runDir, 'labels-summary.json'), 'utf8'), firstSummary);
  assert.strictEqual(first.trim().split('\n').length, 11);
  assert.deepStrictEqual(fs.readdirSync(run.runDir).filter(f => f.endsWith('.tmp')), []);
  // A run dir inside the repository (root) is refused before anything is written.
  const root = path.dirname(path.dirname(run.home));
  assert.throws(() => writeLabels(run.runDir, { root }), /inside the repository/);
});

test('labels: --bars data (one-minute bars, aggregated to the run\'s bars) walks the counterfactuals', () => {
  const run = fullRun();
  const minutes = [];
  for (let m = Date.parse(`${DAY}T13:00:00Z`); m < Date.parse(`${DAY}T21:00:00Z`); m += 60000) {
    minutes.push({ t: iso(m), o: 20000, h: 20005, l: iso(m) === `${DAY}T14:55:00.000Z` ? 19970 : 19995, c: 20000, v: 10 });
  }
  const file = path.join(path.dirname(run.home), 'MNQ-1m.json');
  fs.writeFileSync(file, JSON.stringify(minutes));
  // The run home's bars say nothing happened: only the data file has the drop.
  fs.writeFileSync(path.join(run.home, 'bars', 'MNQ-3m.json'), JSON.stringify({ bars: bars().map(b => ({ ...b, l: 19995 })) }));
  const { summary } = writeLabels(run.runDir, { budgetUsd: 40, strategies: STRATEGIES, barsFiles: { MNQ: file } });
  assert.strictEqual(summary.skippedWouldWin, 1);
  const five = path.join(path.dirname(run.home), 'MNQ-5m.json');
  fs.writeFileSync(five, JSON.stringify(minutes.filter((_, i) => i % 5 === 0)));
  assert.throws(() => writeLabels(run.runDir, { strategies: STRATEGIES, barsFiles: { MNQ: five } }), /5-minute bars; the run trades 3-minute bars/);
});

test('labels: a torn last line is counted; the decision times before it are labelled', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: {} }] });
  fs.appendFileSync(path.join(run.runDir, `${DAY}.jsonl`), '{"t":"2026-03-03T14:33:02.000Z","day":');
  const { labels, summary } = labelRun(run.runDir);
  assert.strictEqual(labels.length, 1);
  assert.strictEqual(summary.torn, 1);
});

test('labels: an entry while in a trade, a partial exit and a cancel are kept out of cloning', () => {
  const add = { ...LONG, input: { ...LONG.input, rationale: 'setup:orb long add, stop 19990' } };
  const partial = { tool: 'partial_close_position', input: { accountId: 7, contractId: 'MNQ', size: 1, reason: '[exit] half off' } };
  const cancel = { tool: 'cancel_order', input: { accountId: 7, orderId: 9 } };
  const run = makeRun({ steps: [{ k: 0, cycle: { positions: SHORT_POS, orders: [add, partial, cancel] } }] });
  const { labels } = labelRun(run.runDir);
  assert.strictEqual(labels[0].decision, 'in-trade');
  assert.strictEqual(labels[0].teacher.action, 'exit');
  assert.deepStrictEqual(labels[0].clone.reasons.sort(), ['entry while in a trade', 'order cancel', 'partial exit']);
});

test('labels: orders seen only by the gate (a transcript with no tool calls) keep the intent but not the arguments', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [LONG], transcript: 'plain text, no tool calls' } }] });
  const { labels } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].gate.decision, labels[0].teacher.orders[0].argsKnown], ['long', 'allowed', false]);
  assert.ok(labels[0].clone.reasons.includes('order arguments unknown'));
  // The rationale's stop still maps: 19990 under the bar's 20000 close is 10 points, 1 ATR.
  assert.strictEqual(labels[0].teacher.stop.multiple, 1);
});

test('labels: round trips and R from fills - long and short signs, a position from before the run', () => {
  const longWin = roundTrips([{ contractId: 'MNQ', side: 0, size: 1, price: 100, profitAndLoss: null, ms: 1 }, { contractId: 'MNQ', side: 1, size: 1, price: 110, profitAndLoss: 20, fees: 0.5, ms: 2 }]);
  assert.deepStrictEqual([outcomeOf(longWin[0], 40).r, outcomeOf(longWin[0], 40).result, longWin[0].side], [1, 'win', 'buy']);
  const shortLoss = roundTrips([{ contractId: 'MNQ', side: 1, size: 2, price: 100, profitAndLoss: null, ms: 1 }, { contractId: 'MNQ', side: 0, size: 2, price: 105, profitAndLoss: -20, ms: 2 }]);
  assert.deepStrictEqual([outcomeOf(shortLoss[0], 20).r, outcomeOf(shortLoss[0], 20).result, shortLoss[0].side], [-1, 'loss', 'sell'], '$20 lost on 2 contracts x 20 ticks x $0.50');
  const before = roundTrips([{ contractId: 'MNQ', side: 1, size: 1, price: 110, profitAndLoss: 20, ms: 2 }]);
  assert.deepStrictEqual([before[0].openMs, before[0].side, outcomeOf(before[0], null).openKnown, outcomeOf(before[0], null).r], [null, 'buy', false, null]);
  const open = roundTrips([{ contractId: 'MNQ', side: 0, size: 1, price: 100, profitAndLoss: null, ms: 1 }]);
  assert.strictEqual(outcomeOf(open[0], 40).result, 'open');
});

test('labels: ATR from bars closed at or before t only', () => {
  const list = bars(30).map(b => ({ ...b, ms: Date.parse(b.t) }));
  const tfMs = 180000;
  assert.strictEqual(atrAt(list, tfMs, Date.parse(list[19].t) + tfMs - 1), null, '19 bars closed: no ATR(20)');
  assert.strictEqual(atrAt(list, tfMs, Date.parse(list[19].t) + tfMs), 10);
});

test('labels: teacher actions', () => {
  const o = x => ({ tool: 'place_order', riskReducing: false, argsKnown: true, type: 'market', side: 'buy', targetTicks: null, limitPrice: null, rationale: '', ...x });
  assert.strictEqual(teacherAction([], false).action, 'none');
  assert.strictEqual(teacherAction([o({ side: 'sell' })], false).action, 'short');
  assert.deepStrictEqual(teacherAction([o({ type: 'stop' })], false).reasons, ['stop entry']);
  assert.deepStrictEqual(teacherAction([o(), o()], false).reasons, ['several entries']);
  assert.strictEqual(teacherAction([o({ riskReducing: true, rationale: '[protect] stop' })], true).action, 'tighten');
  assert.deepStrictEqual(teacherAction([{ tool: 'modify_order', argsKnown: true, stopPrice: null, trailPrice: null, limitPrice: 21000 }], true), { action: 'hold', order: null, reasons: ['target change'] });
});
