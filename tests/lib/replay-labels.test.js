'use strict';

// Labels from a replay run (scripts/lib/replay/labels.js), on synthetic run dirs: no real data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { labelRun, writeLabels, roundTrips, outcomeOf, atrAt, teacherAction, stopOf, summaryText } = require('../../scripts/lib/replay/labels');

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
function makeRun({ steps, barList = bars(), budget, manifest = {}, symbols = ['MNQ'] } = {}) {
  const home = path.join(tmpDir(), 'replays', RUN);
  const runDir = path.join(home, 'replay', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-10'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId: RUN, hash: 'c'.repeat(64), harness: 'custom', model: 'teacher-1', daysDone: [DAY], finished: true, ...manifest }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols, timeframe: 3, account: '7' }));
  const journal = [];
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: barList }));
  const lines = [];
  const gate = [];
  const scans = [];
  for (const [i, s] of steps.entries()) {
    const t = s.t || at(s.k);
    const barT = iso(t - 2000 - 180000);
    const wall = WALL0 + i * 60000;
    const rec = { v: 1, t: iso(t), day: DAY, kind: s.kind || 'trade', asked: s.kind || 'trade', ran: [], cycles: [], refusals: [], errors: [], bars: symbols.map(symbol => ({ symbol, lastBarT: barT })), trades: s.trades || [], since: iso(t - 180000) };
    for (const j of s.journal || []) journal.push({ ts: iso(t), accountId: 7, contractId: 'BT.MNQ', ...j });
    if (s.interrupted) Object.assign(rec, { interrupted: true, trades: null, bars: undefined });
    if (s.scan) scans.push({ at: iso(t), symbol: 'MNQ', contractId: 'MNQ', bar: { t: barT, c: 20000 }, ...(s.scanDecision ? { decision: s.scanDecision } : {}), candidates: s.scan.map(x => x.name), results: s.scan.map(x => ({ name: x.name, candidate: true, direction: x.direction, ...(x.status ? { status: x.status } : {}), stopDistance: x.stopDistance === undefined ? 10 : x.stopDistance })) });
    if (s.cycle) {
      const c = s.cycle;
      const file = path.join(home, 'logs', 'cycles', '2026-10-10', `${String(i).padStart(6, '0')}-trade.json`);
      const transcript = c.transcript !== undefined ? c.transcript : (c.orders || []).map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}-${j}`, name: `mcp__broker__${o.tool}`, input: o.input }] } })).join('\n');
      const result = c.result || 'CYCLE RESULT: done';
      const account = c.noAccount ? null : { id: 7, balance: 50000, positions: c.positions || [], workingOrders: c.workingOrders || 0, attempts: c.attempts || [] };
      const action = c.action || 'trade';
      // The open trades the runner read (open-trades.js): each position's working stop, 10 points away unless given.
      const openTrades = (c.positions || []).map(p => ({ contractId: p.contractId, side: p.side, stop: 'stop' in c ? c.stop : p.averagePrice - (p.side === 'long' ? 10 : -10) }));
      if (!c.noLog) fs.writeFileSync(file, JSON.stringify({ at: iso(wall), action, prompt: `p${i}`, context: { symbols: symbols.map(symbol => ({ symbol, bar: { t: barT, c: 20000 } })), account, openTrades }, transcript }));
      rec.ran.push({ action, ok: c.ok !== false && c.ranOk !== false, timedOut: Boolean(c.timedOut), result, symbols });
      if (!c.noLog) rec.cycles.push({ action, at: iso(wall), ok: c.ok !== false, timedOut: Boolean(c.timedOut), durationMs: 30000, result, promptHash: `hash${i}`, file: c.file || file });
      for (const [j, o] of (c.orders || []).entries()) {
        // close_position is never gated: no record, as live.
        if (o.gate === 'none' || (o.tool === 'close_position' && !o.gate)) continue;
        for (const g of [].concat(o.gate || { source: 'gateway', decision: 'allowed', violations: [] })) {
          gate.push({ ts: iso(wall + (o.atMs ?? 1000 + j * 100)), tool: g.source === 'hook' ? undefined : o.tool, ...g, contractId: o.input.contractId, rationale: o.input.rationale });
        }
      }
    }
    lines.push(rec);
  }
  fs.writeFileSync(path.join(runDir, `${DAY}.jsonl`), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), gate.map(g => `${JSON.stringify(g)}\n`).join(''));
  fs.writeFileSync(path.join(home, 'logs', `scans-${DAY}.jsonl`), scans.map(g => `${JSON.stringify(g)}\n`).join(''));
  fs.mkdirSync(path.join(runDir, 'broker'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'broker', 'journal.jsonl'), journal.map(g => `${JSON.stringify(g)}\n`).join(''));
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
  assert.deepStrictEqual(L[0].teacher.stop, { ticks: 40, points: 10, atr: 10, ratio: 1, multiple: 1, outOfRange: false });
  assert.deepStrictEqual([L[0].teacher.size.riskUsd, L[0].teacher.size.step], [20, 0.5]);
  assert.deepStrictEqual(L[0].gate, { decision: 'allowed', by: null, checks: [] });
  assert.deepStrictEqual([L[0].outcome.filled, L[0].outcome.result, L[0].outcome.r, L[0].outcome.net, L[0].outcome.maeR, L[0].outcome.mfeR], [true, 'win', 2, 39.26, -0.25, 2.5]);
  assert.strictEqual(L[0].outcome.entryTime, iso(T0 + 60000));
  assert.deepStrictEqual(L[0].clone, { ok: true, reasons: [] });
  assert.strictEqual(L[0].result, 'CYCLE RESULT: long MNQ');
  const { strategiesHash, ...prov } = L[0].provenance;
  assert.deepStrictEqual(prov, { harness: 'custom', model: 'teacher-1', configHash: 'c'.repeat(64), bars: 'run home', specs: 'table', promptHash: 'hash0', cycleFile: 'logs/cycles/2026-10-10/000000-trade.json' });
  assert.match(strategiesHash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(labelRun(runDir, { budgetUsd: 40, strategies: [{ ...STRATEGIES[0], risk: { min_rr: 3 } }] }).labels[0].provenance.strategiesHash, strategiesHash, 'another exit, another hash');
  assert.strictEqual(L[0].teacher.orders[0].args, undefined);
  assert.strictEqual(L[0].teacher.orders[0].stopTicks, 40);

  // Managed: tighten, hold, exit, each in the open trade (its outcome attached).
  assert.deepStrictEqual([L[1].decision, L[1].teacher.action, L[1].gate.decision, L[1].clone.ok], ['in-trade', 'tighten', 'allowed', true]);
  assert.deepStrictEqual([L[2].decision, L[2].teacher.action, L[2].gate.decision], ['in-trade', 'hold', 'none']);
  // The close has no gate record (close_position is never gated): ungated, and cloneable.
  assert.deepStrictEqual([L[3].decision, L[3].teacher.action, L[3].gate.decision, L[3].clone.ok], ['in-trade', 'exit', 'ungated', true]);
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
  assert.deepStrictEqual(L[5].teacher.stop, { ticks: 80, points: 20, atr: 10, ratio: 2, multiple: 2, outOfRange: false });
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
  assert.deepStrictEqual(L[8].clone.reasons, ['limit entry'], 'its 2R target is orb\'s own exit');

  // No cycle while orb fired: not a teacher decision. Its long would have been flat to end of day (a small loss).
  assert.deepStrictEqual([L[9].decision, L[9].teacher, L[9].candidates.length], ['no-cycle', null, 1]);
  assert.deepStrictEqual([L[9].counterfactual.exitReason, L[9].counterfactual.R, L[9].counterfactual.result], ['eod', -0.025, 'loss']);
  assert.strictEqual(L[10].decision, 'housekeeping');

  assert.deepStrictEqual(
    [summary.labels, summary.decisions, summary.taken, summary.skipped, summary.refused, summary.wins, summary.losses, summary.uncloneable, summary.unmapped, summary.noCycle, summary.noCycleWithCandidates, summary.interrupted, summary.housekeeping],
    [11, 8, 3, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1],
  );
  assert.deepStrictEqual([summary.holds, summary.tightens, summary.exits, summary.unfilled], [1, 1, 1, 1]);
  assert.deepStrictEqual(summary.uncloneableBy, { 'limit entry': 1 });
  assert.deepStrictEqual(
    [summary.takenWon, summary.takenLost, summary.skippedWouldWin, summary.skippedWouldLose, summary.noCycleWouldWin, summary.noCycleWouldLose, summary.unsimulated],
    [1, 1, 1, 0, 0, 1, 0],
  );
  assert.match(summaryText(summary), /decisions 8, taken 3, unknownOutcome 0, skipped 1, refused 1, wins 1, losses 1, uncloneable 1, unmapped 0/);
});

test('labels: no ATR (too few bars closed by t) leaves the stop unmapped and counts it', () => {
  const { runDir } = makeRun({ barList: bars(10), steps: [{ k: 0, cycle: { orders: [LONG] } }] });
  const { labels, summary } = labelRun(runDir);
  assert.deepStrictEqual(labels[0].teacher.stop, { ticks: 40, points: 10, atr: null, ratio: null, multiple: null, outOfRange: false });
  assert.deepStrictEqual(labels[0].clone, { ok: false, reasons: ['stop not mapped to ATR'] });
  assert.strictEqual(summary.unmapped, 1);
  // No budget given and no prop attempt: the size step is unknown, counted.
  assert.strictEqual(labels[0].teacher.size.step, null);
  assert.strictEqual(summary.unsized, 1);
});

test('labels: a prop attempt alone sets no budget (its sizing needs state the run doesn\'t record): the step is unknown', () => {
  const { runDir } = makeRun({ steps: [{ k: 0, cycle: { orders: [LONG], attempts: [{ account: 'topstep_50k', status: 'active', cushion: 200, entryBlock: null }] } }] });
  const { labels, summary } = labelRun(runDir);
  assert.deepStrictEqual([labels[0].teacher.size.budgetUsd, labels[0].teacher.size.step, summary.unsized], [null, null, 1]);
  // Over the budget: the step is the whole budget, flagged.
  const over = labelRun(runDir, { budgetUsd: 10 }).labels[0].teacher.size;
  assert.deepStrictEqual([over.ratio, over.step, over.overBudget], [2, 1, true]);
  const under = labelRun(runDir, { budgetUsd: 80 }).labels[0].teacher.size;
  assert.deepStrictEqual([under.ratio, under.step, under.overBudget], [0.25, 0.25, false]);
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
  // The data the run replayed (--bars), when given, is the series both read: the original bars give the original labels.
  const other = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES, outcomeBars: { MNQ: bars().map(b => ({ ...b, ms: Date.parse(b.t) })) } }).labels;
  assert.deepStrictEqual(other.map(decisionTime), before.map(decisionTime));
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

test('labels: an order with order_plan\'s arguments and rationale: joined, its stop mapped, its strategy target cloneable', () => {
  const { buildPlan } = require('../../scripts/lib/trading/order-plan');
  const { exitPlan } = require('../../scripts/lib/trading/evaluator');
  const { specFor } = require('../../scripts/lib/trading/contracts');
  const { args } = buildPlan({ name: 'orb', side: 'long', contract: 'MNQ', spec: specFor('MNQ'), entryRef: 20000, stop: 40, stopDistance: 10, exit: exitPlan(STRATEGIES[0]), minRR: 2, size: 1, sizeWhy: 'fixed', accountId: 7 });
  assert.match(args.rationale, /^setup:orb long at market from 20000\.00 \(the signal bar's close\), stop 19990\.00 \(40 ticks\), target 20020\.00 \(80 ticks\)/);
  const plan = { tool: 'place_order', input: args };
  const own = { tool: 'place_order', input: { ...args, takeProfitBracket: { ticks: 100, type: 'limit' }, rationale: args.rationale.replace('20020.00 (80', '20025.00 (100') } };
  const run = makeRun({ steps: [
    { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [plan] } },
    { k: 1, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [plan], transcript: 'plain text' } },
    { k: 2, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [own] } },
  ] });
  const { labels } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  // With the transcript: the arguments joined to the gate's record; brackets read; the 2R target is orb's own exit.
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].teacher.setup, labels[0].gate.decision, labels[0].teacher.orders.length, labels[0].teacher.orders[0].argsKnown], ['long', 'orb', 'allowed', 1, true]);
  assert.deepStrictEqual(labels[0].teacher.stop, { ticks: 40, points: 10, atr: 10, ratio: 1, multiple: 1, outOfRange: false });
  assert.deepStrictEqual(labels[0].teacher.target, { ticks: 80, from: 'strategy' });
  assert.deepStrictEqual(labels[0].clone, { ok: true, reasons: [] });
  // From the gate's record alone: the stop is the rationale's price (19990), not the "(40 ticks)" after it.
  assert.deepStrictEqual([labels[1].teacher.orders[0].rationaleStop, labels[1].teacher.stop.points, labels[1].teacher.stop.multiple], [19990, 10, 1]);
  // A target other than the strategy's: the teacher's, kept out of cloning.
  assert.deepStrictEqual(labels[2].teacher.target, { ticks: 100, from: 'teacher' });
  assert.deepStrictEqual(labels[2].clone.reasons, ['explicit target']);
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
  const o = x => ({ tool: 'place_order', riskReducing: false, argsKnown: true, type: 'market', side: 'buy', targetTicks: null, limitPrice: null, rationale: '', gate: { decision: 'allowed' }, broker: { decision: 'unknown' }, ...x });
  assert.strictEqual(teacherAction([], false).action, 'none');
  assert.strictEqual(teacherAction([o({ side: 'sell' })], false).action, 'short');
  assert.deepStrictEqual(teacherAction([o({ type: 'stop' })], false).reasons, ['stop entry']);
  assert.deepStrictEqual(teacherAction([o(), o()], false).reasons, ['several entries']);
  assert.strictEqual(teacherAction([o({ riskReducing: true, rationale: '[protect] stop' })], true).action, 'tighten');
  assert.deepStrictEqual(teacherAction([{ tool: 'modify_order', argsKnown: true, stopPrice: null, trailPrice: null, limitPrice: 21000, gate: { decision: 'allowed' } }], true), { action: 'hold', order: null, reasons: ['target change'] });
  // Refused tries, then one that went through: one decision, not several entries.
  const refused = o({ gate: { decision: 'refused' }, side: 'sell' });
  const brokerRefused = o({ broker: { decision: 'refused' }, size: 27 });
  const placed = o({ broker: { decision: 'accepted' }, size: 1 });
  const a = teacherAction([refused, refused, brokerRefused, placed], false);
  assert.deepStrictEqual([a.order, a.reasons, a.priorRefusals, a.action], [placed, [], 3, 'long']);
  // Refused only: the last intent, refused.
  assert.strictEqual(teacherAction([refused, brokerRefused], false).order, brokerRefused);
});

// Review findings: each test fails without the code it names.

const BLOCK = (check, message = check) => ({ source: 'gateway', decision: 'blocked', violations: [{ check, message }] });
// The gateway's order tracker refusing a call the gate allowed (order-markers.js prepareSend), and the gate's own order-pending.
const TRACKER = BLOCK('order-pending', 'customTag "fth-1" is in use by an order of unknown outcome on this account. Send the entry with another customTag (or none).');
const GATE_PENDING = BLOCK('order-pending', 'The outcome of an order is unknown: buy 1 MNQ sent 1 s ago (customTag fth-1). The broker may hold a position...');
const order = (rationale, x = {}) => ({ tool: 'place_order', input: { ...LONG.input, rationale, ...x } });

test('labels: refused tries, then a retry that fills - the retry is the action, not "several entries"', () => {
  const run = makeRun({ steps: [
    { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [
      { ...order('setup:orb long try one, stop 19990.3'), gate: BLOCK('order-consistency') },
      { ...order('setup:orb long try two, stop 19990.3'), gate: BLOCK('order-consistency') },
      order('setup:orb long, stop 19990'),
    ] } },
    { k: 1, cycle: { positions: LONG_POS }, trades: [fill(1, 0, 20000, null)] },
    { k: 2, cycle: {}, trades: [fill(5, 1, 19990, -20)] },
  ] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].gate.decision, labels[0].teacher.priorRefusals, labels[0].clone.reasons], ['long', 'allowed', 2, []]);
  assert.deepStrictEqual([labels[0].outcome.result, labels[0].outcome.r], ['loss', -1]);
  assert.deepStrictEqual([summary.taken, summary.losses, summary.refused, summary.priorRefusals], [1, 1, 0, 2]);
});

test('labels: an entry the gate allowed but the broker refused (its journal), then one that filled - the filled one is the action', () => {
  const big = order('setup:orb long size 27, stop 19990', { size: 27 });
  const one = order('setup:orb long size 1, stop 19990');
  const run = makeRun({ steps: [
    { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [big, one] }, journal: [
      { kind: 'order_blocked', text: `Order size 27 exceeds BACKTESTER_MAX_ORDER_SIZE (1). | rationale: ${big.input.rationale}` },
      { kind: 'order_placed', text: one.input.rationale, orderId: 5, data: { request: {}, result: { orderId: 5, success: true, errorCode: 0 } } },
    ] },
    { k: 1, cycle: { positions: LONG_POS }, trades: [fill(1, 0, 20000, null, { orderId: 5 })] },
    { k: 2, cycle: {}, trades: [fill(5, 1, 20020, 40)] },
  ] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  const L = labels[0];
  assert.deepStrictEqual([L.teacher.action, L.gate.decision, L.teacher.priorRefusals, L.clone.reasons, L.teacher.size.contracts], ['long', 'allowed', 1, [], 1]);
  assert.deepStrictEqual(L.teacher.orders.map(o => o.broker.decision), ['refused', 'accepted']);
  assert.deepStrictEqual([L.outcome.result, L.outcome.r, summary.wins, summary.brokerRefused], ['win', 2, 1, 0]);
});

test('labels: an intent the broker refused is a refused label with the candidates\' counterfactual', () => {
  const big = order('setup:orb long size 27, stop 19990', { size: 27 });
  const run = makeRun({ steps: [
    { k: 4, scan: [{ name: 'orb', direction: 'long', stopDistance: null }, { name: 'orb', direction: 'short' }], cycle: { orders: [big] }, journal: [
      { kind: 'order_blocked', text: `Order size 27 exceeds BACKTESTER_MAX_ORDER_SIZE (1). | rationale: ${big.input.rationale}` },
    ] },
  ] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  const L = labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by, L.gate.brokerReason, L.outcome.result], ['refused', 'broker', 'Order size 27 exceeds BACKTESTER_MAX_ORDER_SIZE (1).', 'refused']);
  assert.strictEqual(L.counterfactualFor, 'refused intent');
  assert.strictEqual(L.counterfactuals.length, 2);
  // Its own setup and side (orb long) stands for it, though it has no stop distance (unsimulated).
  assert.deepStrictEqual([L.counterfactual.direction, L.counterfactual.simulated], ['long', false]);
  assert.deepStrictEqual([summary.refused, summary.brokerRefused, summary.taken], [1, 1, 0]);
});

test('labels: a skip\'s counterfactual is the backtester\'s pick - the first candidate with a stop distance', () => {
  const run = makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'long', stopDistance: null }, { name: 'orb', direction: 'short' }], cycle: {} }] });
  const L = labelRun(run.runDir, { strategies: STRATEGIES }).labels[0];
  assert.deepStrictEqual([L.counterfactualFor, L.counterfactual.direction, L.counterfactual.result], ['skip', 'short', 'win']);
});

test('labels: an order the gate allowed and the gateway then refused (its order tracker) is one refused order', () => {
  const o = order('setup:orb long, stop 19990');
  const run = makeRun({ steps: [{ k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [{ ...o, gate: [{ source: 'gateway', decision: 'allowed', violations: [] }, TRACKER] }] } }] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.strictEqual(labels[0].teacher.orders.length, 1);
  assert.deepStrictEqual([labels[0].gate.decision, labels[0].gate.checks, labels[0].outcome.result, summary.taken], ['refused', ['order-pending'], 'refused', 0]);
});

test('labels: a failed or timed-out cycle is no skip and never cloned', () => {
  const run = makeRun({ steps: [
    { k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { ok: false } },
    { k: 5, scan: [{ name: 'orb', direction: 'short' }], cycle: { timedOut: true } },
  ] });
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual(labels.map(l => [l.cycleFailed, l.clone.ok, l.clone.reasons, l.counterfactual]), [['cycle failed', false, ['cycle failed'], null], ['cycle timed out', false, ['cycle timed out'], null]]);
  assert.deepStrictEqual([summary.skipped, summary.skippedWouldWin, summary.standAside, summary.cycleFailed], [0, 0, 0, 2]);
});

test('labels: an NQ order on an MNQ run is sized with NQ\'s tick value', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [order('setup:orb long, stop 19990', { contractId: 'NQ' })] } }] });
  const L = labelRun(run.runDir, { budgetUsd: 400 }).labels[0];
  // 40 ticks x $5 = $200: half the budget (MNQ's $0.50 would have made it $20).
  assert.deepStrictEqual([L.teacher.size.riskUsd, L.teacher.size.step], [200, 0.5]);
});

test('labels: malformed lines (null, arrays) in the gate log, the scans log and a day file are skipped', () => {
  const run = makeRun({ steps: [{ k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [LONG] } }] });
  for (const f of [path.join(run.home, 'logs', 'gate-log.jsonl'), path.join(run.home, 'logs', `scans-${DAY}.jsonl`), path.join(run.runDir, `${DAY}.jsonl`)]) fs.appendFileSync(f, 'null\n[1]\n7\n');
  const dayFile = path.join(run.runDir, `${DAY}.jsonl`);
  const rec = JSON.parse(fs.readFileSync(dayFile, 'utf8').split('\n')[0]);
  fs.appendFileSync(dayFile, `${JSON.stringify({ ...rec, t: iso(at(1)), cycles: [null], ran: [null], bars: [null], trades: [null] })}\n`);
  const { labels } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual(labels.map(l => l.decision), ['flat', 'no-cycle']);
});

test('labels: a run that isn\'t finished is refused in place; --out elsewhere (never in the run home) labels it', () => {
  const run = makeRun({ manifest: { daysDone: [] }, steps: [{ k: 0, cycle: {} }] });
  assert.throws(() => labelRun(run.runDir), /not finished \(day 2026-03-03 is not done\)/);
  assert.throws(() => writeLabels(run.runDir), /not finished/);
  assert.throws(() => writeLabels(run.runDir, { outDir: path.join(run.home, 'labels') }), /inside the run home/);
  const out = path.join(path.dirname(path.dirname(run.home)), 'labels-out');
  const { file, summary } = writeLabels(run.runDir, { outDir: out });
  assert.ok(file.startsWith(out) && fs.existsSync(file));
  assert.strictEqual(summary.unfinished, 'day 2026-03-03 is not done');
  assert.ok(!fs.existsSync(path.join(run.runDir, 'labels.jsonl')));
  const pending = makeRun({ manifest: { pending: { t: iso(at(1)) } }, steps: [{ k: 0, cycle: {} }] });
  assert.throws(() => labelRun(pending.runDir), /a step at .* was interrupted/);
});

test('labels: the cycle file is read from the run home, not wherever the log line points', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [LONG] } }] });
  // The log line points at another folder's copy with an open position in it: never read.
  const dayFile = path.join(run.runDir, `${DAY}.jsonl`);
  const rec = JSON.parse(fs.readFileSync(dayFile, 'utf8').trim());
  const real = rec.cycles[0].file;
  const decoy = path.join(tmpDir(), 'logs', 'cycles', '2026-10-10', path.basename(real));
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  const doc = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(decoy, JSON.stringify({ ...doc, context: { ...doc.context, account: { positions: LONG_POS } } }));
  rec.cycles[0].file = decoy;
  fs.writeFileSync(dayFile, `${JSON.stringify(rec)}\n`);
  assert.strictEqual(labelRun(run.runDir).labels[0].decision, 'flat');
});

test('labels: the position from fills (no account in the context) reads only fills through t', () => {
  const run = makeRun({ steps: [
    { k: 0, cycle: { noAccount: true }, trades: [fill(-1, 0, 20000, null)] },
    { k: 1, cycle: { noAccount: true }, trades: [fill(2, 1, 20000, 0)] },
    // A fill after this decision time reported in its line (a broker reporting early): not seen at t.
    { k: 2, cycle: { noAccount: true }, trades: [fill(7, 0, 20000, null)] },
  ] });
  const { labels } = labelRun(run.runDir);
  assert.deepStrictEqual(labels.map(l => [l.decision, l.position.source]), [['in-trade', 'fills'], ['flat', 'fills'], ['flat', 'fills']]);
});

test('labels: entries join to fills - the latest entry before an opening takes it, the same trading day only', () => {
  const run = makeRun({ steps: [
    { k: 0, cycle: { orders: [order('setup:orb long first, stop 19990')] } },
    { k: 1, cycle: { orders: [order('setup:orb long second, stop 19990')] } },
    { k: 2, cycle: { positions: LONG_POS }, trades: [fill(4, 0, 20000, null)] },
    { k: 3, cycle: {}, trades: [fill(8, 1, 20010, 20)] },
    // An entry late in the day whose only opening comes the next trading day: unfilled.
    { t: Date.parse(`${DAY}T20:47:02Z`), cycle: { orders: [order('setup:orb long late, stop 19990')] } },
    { t: Date.parse(`${DAY}T20:50:02Z`), kind: 'eod' },
    { t: Date.parse('2026-03-03T23:33:02Z'), cycle: { positions: LONG_POS }, trades: [fill(9 * 60, 0, 20000, null, { id: 'next-day' })] },
  ] });
  const { labels } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual(labels.slice(0, 2).map(l => l.outcome.result), ['unfilled', 'win']);
  assert.strictEqual(labels[4].outcome.result, 'unfilled');
});

test('labels: an in-trade decision gets the round trip open at its time, not an earlier closed one', () => {
  const run = makeRun({ steps: [
    { k: 0, cycle: { orders: [LONG] } },
    { k: 3, cycle: {}, trades: [fill(1, 0, 20000, null), fill(5, 1, 20010, 20)] },
    { k: 4, cycle: { orders: [order('setup:orb long again, stop 19990')] } },
    { k: 5, cycle: { positions: LONG_POS }, trades: [fill(13, 0, 20000, null, { id: 'b' })] },
    { k: 6, cycle: {}, trades: [fill(17, 1, 19990, -20, { id: 'c' })] },
  ] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  assert.deepStrictEqual([L[3].decision, L[3].outcome.pnl, L[3].outcome.result], ['in-trade', -20, 'loss']);
});

test('labels: a fill reported twice counts once; a voided fill not at all', () => {
  const open = fill(1, 0, 20000, null);
  const run = makeRun({ steps: [
    { k: 0, cycle: { orders: [LONG] } },
    { k: 1, cycle: { positions: LONG_POS }, trades: [open, fill(2, 1, 20100, 200, { id: 'void', voided: true })] },
    { k: 2, cycle: {}, trades: [open, fill(4, 1, 20010, 20)] },
  ] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([L.outcome.pnl, L.outcome.size, L.outcome.fees, L.outcome.result], [20, 1, 0.74, 'win']);
});

test('labels: gate records are bound to their cycle\'s duration; the rest are counted', () => {
  // The record 40 s after a 30 s cycle (past its slack, before the next cycle): no order of the cycle.
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [{ ...LONG, atMs: 40000 }] } }, { k: 1, cycle: {} }] });
  const { labels, summary } = labelRun(run.runDir);
  assert.deepStrictEqual([labels[0].teacher.orders.map(o => o.gate.decision), labels[0].teacher.action], [['not-logged'], 'long']);
  assert.strictEqual(summary.gateRecordsOutsideCycles, 1);
});

test('labels: an order naming no contract (modify, cancel) goes to the only symbol, never a guess among several', () => {
  const modify = { tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice: 20000 } };
  const one = labelRun(makeRun({ steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [modify] } }] }).runDir);
  assert.strictEqual(one.labels[0].teacher.action, 'tighten');
  const two = labelRun(makeRun({ symbols: ['MES', 'MNQ'], steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [modify] } }] }).runDir);
  assert.deepStrictEqual(two.labels.map(l => [l.symbol, l.teacher.action]), [['MES', 'none'], ['MNQ', 'hold']]);
  assert.strictEqual(two.summary.unattributedOrders, 1);
});

test('labels: a trade cycle with no cycle log line is a decision whose orders are unknown', () => {
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { noLog: true } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.decision, L.clone.reasons], ['flat', ['no cycle log']]);
});

test('labels: the stop\'s ATR is the student\'s (rl/observation.js atr20 over the whole series), bar for bar', () => {
  const { marketFeatures } = require('../../scripts/lib/rl/observation');
  const list = bars(160).map((b, i) => ({ ...b, h: b.h + (i % 7), l: b.l - (i % 5), c: b.c + (i % 3) })).map(b => ({ ...b, ms: Date.parse(b.t) }));
  const atr20 = marketFeatures(list).atr20;
  for (const i of [19, 60, 120, 159]) assert.ok(Math.abs(atrAt(list, 180000, list[i].ms + 180000) - atr20[i]) < 1e-9, `bar ${i}`);
});

test('labels: a stop for a limit or stop entry is measured from its own price; on the wrong side it is no stop', () => {
  const { specFor } = require('../../scripts/lib/trading/contracts');
  const base = { tool: 'place_order', side: 'buy', stopTicks: null, rationaleStop: 19980, limitPrice: null, stopPrice: null };
  assert.strictEqual(stopOf({ ...base, type: 'limit', limitPrice: 19990 }, specFor('MNQ'), 20000, 10).points, 10);
  assert.strictEqual(stopOf({ ...base, type: 'stop', stopPrice: 20010 }, specFor('MNQ'), 20000, 10).points, 30);
  assert.strictEqual(stopOf({ ...base, type: 'market' }, specFor('MNQ'), 20000, 10).points, 20);
  // A long's stop above its entry: no stop (never its distance turned around).
  const wrong = stopOf({ ...base, type: 'market', rationaleStop: 20010 }, specFor('MNQ'), 20000, 10);
  assert.deepStrictEqual([wrong.points, wrong.multiple], [null, null]);
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { orders: [order('setup:orb long, stop 20010', { stopLossBracket: undefined })] } }] }).runDir).labels[0];
  assert.deepStrictEqual(L.clone.reasons, ['no stop']);
});

test('labels: a stop far outside the ATR multiples is out of range (unmapped), not snapped to the end bucket', () => {
  const { specFor } = require('../../scripts/lib/trading/contracts');
  const o = { tool: 'place_order', side: 'buy', type: 'market', stopTicks: 5, rationaleStop: null };
  const tight = stopOf(o, specFor('MNQ'), 20000, 10);
  assert.deepStrictEqual([tight.multiple, tight.outOfRange], [null, true], '1.25 points = 0.125 ATR');
  assert.strictEqual(stopOf({ ...o, stopTicks: 200 }, specFor('MNQ'), 20000, 10).outOfRange, true, '5 ATR');
  assert.strictEqual(stopOf({ ...o, stopTicks: 16 }, specFor('MNQ'), 20000, 10).multiple, 0.5, '0.4 ATR is still 0.5');
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [order('setup:orb long tight, stop 19998.75', { stopLossBracket: { ticks: 5, type: 'stop' } })] } }] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual([labels[0].clone.reasons, summary.unmapped, summary.stopOutOfRange], [['stop out of ATR range'], 1, 1]);
});

test('labels: the transcript\'s calls join the gate\'s records by rationale, not by order', () => {
  const a = order('setup:orb long A, stop 19990', { stopLossBracket: { ticks: 40, type: 'stop' } });
  const b = order('setup:orb long B, stop 19990', { stopLossBracket: { ticks: 60, type: 'stop' } });
  // The gate saw B refused first, then A allowed; the transcript lists A before B.
  const transcript = [a, b].map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `x${j}`, name: 'mcp__broker__place_order', input: o.input }] } })).join('\n');
  const run = makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [{ ...b, gate: BLOCK('plan-required') }, a] } }] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual(L.teacher.orders.map(o => [o.rationale.slice(0, 16), o.stopTicks, o.gate.decision]), [['setup:orb long B', 60, 'refused'], ['setup:orb long A', 40, 'allowed']]);
  assert.strictEqual(L.teacher.stop.ticks, 40);
});

test('labels: an opencode transcript gives the orders their arguments', () => {
  const transcript = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_place_order', state: { status: 'completed', input: LONG.input } } });
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [LONG] } }] }).runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([L.teacher.orders[0].argsKnown, L.teacher.size.step, L.clone.reasons], [true, 0.5, []]);
});

// Review round 2 findings.

test('labels: a run stopped at a day\'s boundary (every day so far done) is not finished: refused in place', () => {
  const run = makeRun({ manifest: { finished: undefined }, steps: [{ k: 0, cycle: {} }] });
  assert.throws(() => labelRun(run.runDir), /the driver has not finished the run/);
  assert.throws(() => writeLabels(run.runDir), /not finished/);
});

test('labels: an allowed order then a gate-check block of the same call is two orders; only a tracker block within a second pairs', () => {
  const o = order('setup:orb long, stop 19990');
  const allowed = { source: 'gateway', decision: 'allowed', violations: [] };
  const labelsOf = gate => labelRun(makeRun({ steps: [{ k: 0, cycle: { orders: [{ ...o, gate }] } }] }).runDir, { budgetUsd: 40 }).labels[0];
  // A retry the gate refused (max-position): the allowed one stands.
  const retry = labelsOf([allowed, BLOCK('max-position')]);
  assert.deepStrictEqual([retry.teacher.orders.map(x => x.gate.decision), retry.gate.decision, retry.teacher.priorRefusals], [['allowed', 'refused'], 'allowed', 1]);
  // A tracker block more than a second later is another call too.
  const late = labelRun(makeRun({ steps: [{ k: 0, cycle: { orders: [{ ...o, gate: allowed, atMs: 1000 }, { ...o, gate: TRACKER, atMs: 2500 }] } }] }).runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual(late.teacher.orders.map(x => x.gate.decision), ['allowed', 'refused']);
  // The gate's own order-pending (a second identical call while the first is in flight) is another call: the first stands.
  const parallel = labelsOf([allowed, GATE_PENDING]);
  assert.deepStrictEqual([parallel.teacher.orders.map(x => x.gate.decision), parallel.gate.decision], [['allowed', 'refused'], 'allowed']);
});

test('labels: --bars data gives the stop its ATR when the run home has too few bars', () => {
  const run = makeRun({ barList: bars(10), steps: [{ k: 0, cycle: { orders: [LONG] } }] });
  assert.strictEqual(labelRun(run.runDir).labels[0].teacher.stop.multiple, null);
  const L = labelRun(run.runDir, { outcomeBars: { MNQ: bars().map(b => ({ ...b, ms: Date.parse(b.t) })) } }).labels[0];
  assert.deepStrictEqual([L.teacher.stop.atr, L.teacher.stop.multiple], [10, 1]);
});

test('labels: the folder guards - a child named "..x" is inside; letter case and symlinks reach the same folder', () => {
  const run = makeRun({ manifest: { daysDone: [] }, steps: [{ k: 0, cycle: {} }] });
  assert.throws(() => writeLabels(run.runDir, { outDir: path.join(run.home, '..x') }), /inside the run home/);
  // Its parent is not inside it.
  assert.ok(writeLabels(run.runDir, { outDir: path.dirname(run.home) }).file.startsWith(path.dirname(run.home)));
  // The repository guard: a run dir under the repository in a folder named "..x".
  const repo = tmpDir();
  const inner = path.join(repo, '..x', 'replays', RUN);
  fs.mkdirSync(path.dirname(inner), { recursive: true });
  fs.cpSync(run.home, inner, { recursive: true });
  assert.throws(() => writeLabels(path.join(inner, 'replay', RUN), { root: repo, outDir: path.join(tmpDir(), 'o') }), /inside the repository/);
  // A symlink to the run home.
  const link = path.join(tmpDir(), 'link');
  fs.symlinkSync(run.home, link);
  assert.throws(() => writeLabels(run.runDir, { outDir: path.join(link, 'x') }), /inside the run home/);
  // Another letter case, where the volume folds case.
  const upper = run.home.toUpperCase();
  if (upper !== run.home && fs.existsSync(upper)) assert.throws(() => writeLabels(run.runDir, { outDir: path.join(upper, 'x') }), /inside the run home/);
});

test('labels: entries join round trips by the broker\'s order id; a known id never takes another order\'s opening', () => {
  const a = order('setup:orb long A, stop 19990');
  const b = order('setup:orb long B, stop 19990');
  const placed = (o, id) => ({ kind: 'order_placed', text: o.input.rationale, data: { request: {}, result: { orderId: id, success: true } } });
  const run = makeRun({ steps: [
    { k: 0, cycle: { orders: [a] }, journal: [placed(a, 5)] },
    { k: 1, cycle: { orders: [b] }, journal: [placed(b, 6)] },
    { k: 2, cycle: { positions: LONG_POS }, trades: [fill(4, 0, 20000, null, { orderId: 5 })] },
    { k: 3, cycle: {}, trades: [fill(8, 1, 20010, 20)] },
    // An accepted order (id 8) that never filled, then an opening by order 7 nobody's journal names.
    { k: 4, cycle: { orders: [order('setup:orb long C, stop 19990')] }, journal: [placed(order('setup:orb long C, stop 19990'), 8)] },
    { k: 5, cycle: { positions: LONG_POS }, trades: [fill(13, 0, 20000, null, { id: 'o7', orderId: 7 })] },
  ] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  assert.deepStrictEqual([L[0].outcome.result, L[1].outcome.result, L[4].outcome.result], ['win', 'unfilled', 'unfilled']);
});

test('labels: the broker\'s journal is read from t to the next decision time only', () => {
  const r0 = order('setup:orb long zero, stop 19990');
  const r1 = order('setup:orb long one, stop 19990');
  const placed = o => ({ kind: 'order_placed', text: o.input.rationale, data: { request: {}, result: { orderId: 9, success: true } } });
  // Each order's record sits in the other decision's window.
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [r0] }, journal: [placed(r1)] }, { k: 1, cycle: { orders: [r1] }, journal: [placed(r0)] }] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  assert.deepStrictEqual(L.map(l => l.teacher.orders[0].broker.decision), ['unknown', 'unknown']);
});

test('labels: the entry the broker accepted is the action, even when another went through after it', () => {
  const a = order('setup:orb long accepted, stop 19990');
  const b = order('setup:orb long unknown fate, stop 19990', { stopLossBracket: { ticks: 60, type: 'stop' } });
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [a, b] }, journal: [{ kind: 'order_placed', text: a.input.rationale, data: { request: {}, result: { orderId: 5, success: true } } }] }] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([L.teacher.stop.ticks, L.clone.reasons], [40, ['several entries']]);
});

test('labels: a cycle the step reports failed (its ran record) is failed though its log line says ok', () => {
  const run = makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { ranOk: false } }] });
  const L = labelRun(run.runDir, { strategies: STRATEGIES }).labels[0];
  assert.deepStrictEqual([L.cycleFailed, L.counterfactual], ['cycle failed', null]);
});

test('labels: an order the gate never logged is neither taken nor cloned', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { orders: [{ ...LONG, gate: 'none' }] }, scan: [{ name: 'orb', direction: 'long' }] }] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual([labels[0].gate.decision, labels[0].outcome.result, labels[0].clone.reasons, labels[0].counterfactual, summary.taken], ['not-logged', 'not logged', ['no gate record'], null, 0]);
});

test('labels: flat, a modify of a working order is no skip and never cloned', () => {
  const run = makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { orders: [{ tool: 'modify_order', input: { accountId: 7, orderId: 3, limitPrice: 19995 } }] } }] });
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].clone.reasons, labels[0].counterfactual, summary.skipped], ['none', ['working-order change'], null, 0]);
});

test('labels: the broker\'s journal is matched on the contract too', () => {
  const r = 'setup:orb long, stop 19990';
  const mnq = order(r);
  const mes = order(r, { contractId: 'MES' });
  const run = makeRun({ symbols: ['MES', 'MNQ'], steps: [{ k: 0, cycle: { orders: [mnq, mes] }, journal: [
    { kind: 'order_blocked', contractId: 'MNQ', text: `size too big | rationale: ${r}` },
    { kind: 'order_placed', contractId: 'MES', text: r, data: { request: {}, result: { orderId: 4, success: true } } },
  ] }] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels;
  assert.deepStrictEqual(L.map(l => [l.symbol, l.gate.decision, l.gate.by]), [['MES', 'allowed', null], ['MNQ', 'refused', 'broker']]);
});

test('labels: a no-cycle bar while in a position gets no flat-entry counterfactual', () => {
  const run = makeRun({ steps: [
    { k: 0, cycle: { orders: [LONG] } },
    { k: 1, scan: [{ name: 'orb', direction: 'long' }], trades: [fill(1, 0, 20000, null)] },
    { k: 2, scan: [{ name: 'orb', direction: 'long' }], trades: [fill(5, 1, 20010, 20)] },
  ] });
  const L = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES }).labels;
  assert.deepStrictEqual(L.slice(1).map(l => [l.decision, l.position.side, l.counterfactualFor]), [['no-cycle', 'long', null], ['no-cycle', null, 'no cycle']]);
});

test('labels: a call that came back an error (no broker record) never became an order', () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__broker__place_order', input: LONG.input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'invalid arguments' }] } }),
  ].join('\n');
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [LONG] } }] }).runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by, L.gate.brokerReason], ['refused', 'broker', 'invalid arguments']);
});

// Review round 3 findings.

test('labels: with several symbols, a modify naming no contract is resolved by its order id; else every label of the cycle says so', () => {
  const modify = id => ({ tool: 'modify_order', input: { accountId: 7, orderId: id, stopPrice: 20000 } });
  const resolved = makeRun({ symbols: ['MES', 'MNQ'], steps: [
    { k: 0, cycle: { orders: [order('setup:orb long, stop 19990')] }, journal: [{ kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long, stop 19990', data: { request: {}, result: { orderId: 2, success: true } } }] },
    { k: 1, cycle: { positions: LONG_POS, orders: [modify(2)] } },
  ] });
  const r = labelRun(resolved.runDir).labels.filter(l => l.t === iso(at(1)));
  assert.deepStrictEqual(r.map(l => [l.symbol, l.teacher.action, l.clone.reasons]), [['MES', 'none', []], ['MNQ', 'tighten', []]]);
  const unknown = makeRun({ symbols: ['MES', 'MNQ'], steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { orders: [modify(9)] } }] });
  const { labels, summary } = labelRun(unknown.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual(labels.map(l => [l.symbol, l.clone.reasons, l.counterfactual]), [['MES', ['unattributed order'], null], ['MNQ', ['unattributed order'], null]]);
  assert.deepStrictEqual([summary.skipped, summary.standAside, summary.holds], [0, 0, 0]);
  // In a trade too: never counted as a hold.
  const inTrade = labelRun(makeRun({ symbols: ['MES', 'MNQ'], steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [modify(9)] } }] }).runDir);
  assert.deepStrictEqual([inTrade.labels[1].teacher.action, inTrade.labels[1].clone.reasons, inTrade.summary.holds], ['hold', ['unattributed order'], 0]);
});

test('labels: a symlinked run dir reads (and guards) its real run home', () => {
  const run = makeRun({ manifest: { daysDone: [] }, steps: [{ k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { orders: [LONG] } }] });
  const link = path.join(tmpDir(), 'run-link');
  fs.symlinkSync(run.runDir, link);
  const { labels } = labelRun(link, { budgetUsd: 40, unfinished: true });
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].gate.decision, labels[0].candidates.length], ['long', 'allowed', 1]);
  assert.throws(() => writeLabels(link, { outDir: path.join(run.home, 'out') }), /inside the run home/);
});

test('labels: a trade time while the kill switch was on is its own kind', () => {
  const run = makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }] }] });
  const dayFile = path.join(run.runDir, `${DAY}.jsonl`);
  fs.writeFileSync(dayFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(dayFile, 'utf8')), killSwitch: 'on' })}\n`);
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual([labels[0].decision, labels[0].clone.reasons, labels[0].counterfactual, summary.killSwitch, summary.noCycle], ['kill-switch', ['kill switch on'], null, 1, 0]);
});

test('labels: --bars files are named in the provenance by their hash', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: {} }] });
  const file = path.join(path.dirname(run.home), 'MNQ-3m.json');
  fs.writeFileSync(file, JSON.stringify(bars()));
  writeLabels(run.runDir, { barsFiles: { MNQ: file } });
  const L = JSON.parse(fs.readFileSync(path.join(run.runDir, 'labels.jsonl'), 'utf8').trim());
  assert.deepStrictEqual(L.provenance.bars, { MNQ: require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
});

test('labels: a trade cycle with no cycle log line is no skip', () => {
  const { labels, summary } = labelRun(makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { noLog: true } }] }).runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual([labels[0].counterfactual, summary.skipped, summary.skippedWouldWin], [null, 0, 0]);
});

test('labels: a modify that widens the stop is flagged, never cloned; one against an unknown stop is unknown', () => {
  const modify = stopPrice => ({ tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice } });
  const run = makeRun({ steps: [
    // The long's working stop is 19990 (open-trades): 19980 widens it, 19995 tightens it.
    { k: 0, cycle: { positions: LONG_POS, orders: [modify(19980)] } },
    { k: 1, cycle: { positions: LONG_POS, orders: [modify(19995)] } },
    { k: 2, cycle: { positions: SHORT_POS, orders: [modify(20015)] } },
    { k: 3, cycle: { positions: SHORT_POS, stop: null, orders: [modify(20005)] } },
  ] });
  const L = labelRun(run.runDir).labels;
  assert.deepStrictEqual(L.map(l => [l.teacher.action, l.clone.reasons]), [
    ['tighten', ['stop widened']], ['tighten', []], ['tighten', ['stop widened']], ['tighten', ['stop change unknown']],
  ]);
});

// After the rebase onto #38 (broker specs) and #39 (opencode).

test('labels: tick specs are the ones the run recorded from its broker (contracts-<broker>.json), else the static table', () => {
  // The broker reported MNQ as the table has it; nothing for MES.
  const specs = JSON.stringify({ ids: {}, front: {}, specs: { MNQ: { tickSize: 0.25, tickValue: 0.5 } } });
  const mnq = makeRun({ manifest: { broker: 'sim' }, steps: [{ k: 0, cycle: { orders: [LONG] } }] });
  fs.writeFileSync(path.join(mnq.home, 'contracts-sim.json'), specs);
  const a = labelRun(mnq.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([a.teacher.size.riskUsd, a.provenance.specs, a.clone.reasons], [20, 'broker', []]);
  // A broker spec unlike the table ($1 a tick): live refuses entries on it; measured with the table, flagged.
  fs.writeFileSync(path.join(mnq.home, 'contracts-sim.json'), JSON.stringify({ ids: {}, front: {}, specs: { MNQ: { tickSize: 0.25, tickValue: 1 } } }));
  const m = labelRun(mnq.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([m.teacher.size.riskUsd, m.provenance.specs, m.clone.reasons], [20, 'mismatch', ['broker spec mismatch']]);
  const mes = makeRun({ symbols: ['MES'], manifest: { broker: 'sim' }, steps: [{ k: 0, cycle: { orders: [order('setup:orb long, stop 19990', { contractId: 'MES' })] } }] });
  fs.writeFileSync(path.join(mes.home, 'contracts-sim.json'), specs);
  const b = labelRun(mes.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([b.teacher.size.riskUsd, b.provenance.specs], [50, 'table'], 'MES from the table: 40 ticks x $1.25');
});

test('labels: an order opencode stopped itself (a permission rule) is no order', () => {
  const ev = state => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_place_order', state } });
  const transcript = ev({ status: 'error', input: LONG.input, error: 'The user has specified a rule which prevents you from using this specific tool call.' });
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [{ ...LONG, gate: 'none' }] } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.teacher.action, L.teacher.orders], ['none', []]);
});

// Review round 4 findings.

test('labels: an exit or a tighten whose call came back an error is refused (it never changed the account)', () => {
  const failedCall = (tool, input) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: `mcp__broker__${tool}`, input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'PositionNotFound' }] } }),
  ].join('\n');
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] done' } };
  const modify = { tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice: 20000 } };
  const run = makeRun({ steps: [
    { k: 0, cycle: { positions: LONG_POS, transcript: failedCall('close_position', close.input), orders: [close] } },
    { k: 1, cycle: { positions: LONG_POS, transcript: failedCall('modify_order', modify.input), orders: [modify] } },
  ] });
  const L = labelRun(run.runDir).labels;
  assert.deepStrictEqual(L.map(l => [l.teacher.action, l.gate.decision, l.gate.by, l.gate.brokerReason]), [
    ['exit', 'refused', 'broker', 'PositionNotFound'], ['tighten', 'refused', 'broker', 'PositionNotFound'],
  ]);
});

test('labels: flat, an exit or a protective order is no skip', () => {
  const run = makeRun({ steps: [
    { k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { orders: [{ tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] flat' } }] } },
    { k: 5, scan: [{ name: 'orb', direction: 'short' }], cycle: { orders: [order('[exit] flatten what is left')] } },
  ] });
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual(labels.map(l => [l.teacher.action, l.clone.reasons, l.counterfactual]), [['none', ['exit while flat'], null], ['none', ['exit while flat'], null]]);
  assert.strictEqual(summary.skipped, 0);
});

// Review round 5 findings.

test('labels: Codex announces each call before it completes - counted once, joined to its gate record, its fill joined', () => {
  const ev = (type, status) => JSON.stringify({ type, item: { id: 'm1', type: 'mcp_tool_call', server: 'broker', tool: 'place_order', arguments: LONG.input, status } });
  const transcript = [ev('item.started', 'in_progress'), ev('item.completed', 'completed')].join('\n');
  const run = makeRun({ steps: [
    { k: 0, cycle: { transcript, orders: [LONG] } },
    { k: 1, cycle: { positions: LONG_POS }, trades: [fill(1, 0, 20000, null)] },
    { k: 2, cycle: {}, trades: [fill(5, 1, 20010, 20)] },
  ] });
  const L = labelRun(run.runDir, { budgetUsd: 40 }).labels[0];
  assert.deepStrictEqual([L.teacher.orders.length, L.gate.decision, L.clone.reasons, L.outcome.result], [1, 'allowed', [], 'win']);
});

test('labels: an exit or a tighten that failed, then a retry that went through, is the retry', () => {
  const claude = (calls, errors) => calls.map((c, j) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${j}`, name: `mcp__broker__${c.tool}`, input: c.input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${j}`, is_error: errors[j], content: errors[j] ? 'busy' : 'ok' }] } }),
  ].join('\n')).join('\n');
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] done' } };
  const modify = { tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice: 20000 } };
  const exitOrder = order('[exit] flatten the long');
  const run = makeRun({ steps: [
    { k: 0, cycle: { positions: LONG_POS, transcript: claude([close, close], [true, false]), orders: [close, close] } },
    { k: 1, cycle: { positions: LONG_POS, transcript: claude([modify, modify], [true, false]), orders: [modify, modify] } },
    // An [exit] order the gate refused, then a close that went through.
    { k: 2, cycle: { positions: LONG_POS, transcript: claude([exitOrder, close], [true, false]), orders: [{ ...exitOrder, gate: BLOCK('max-position') }, close] } },
  ] });
  const { labels, summary } = labelRun(run.runDir);
  assert.deepStrictEqual(labels.map(l => [l.teacher.action, l.gate.decision, l.teacher.priorRefusals, l.clone.ok]), [['exit', 'ungated', 1, true], ['tighten', 'allowed', 1, true], ['exit', 'ungated', 1, true]]);
  assert.strictEqual(summary.refused, 0);
});

test('labels: an order another PreToolUse hook blocked is refused by the hook', () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__broker__place_order', input: LONG.input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'PreToolUse:mcp__broker__place_order hook error: blocked by policy' }] } }),
  ].join('\n');
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [{ ...LONG, gate: 'none' }] } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by], ['refused', 'hook']);
});

test('labels: an interrupted last line\'s fills are counted unread', () => {
  const { summary } = labelRun(makeRun({ steps: [{ k: 0, cycle: {} }, { k: 1, interrupted: true }] }).runDir);
  assert.strictEqual(summary.fillsUnread, 1);
  assert.strictEqual(labelRun(makeRun({ steps: [{ k: 0, interrupted: true }, { k: 1, cycle: {} }] }).runDir).summary.fillsUnread, 0, 'the next line reads them');
});

// Review round 6 findings.

test('labels: a close whose call came back an error but whose fill shows it went through; a timed-out one with nothing to show is unknown', () => {
  const failed = (input, error) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__broker__close_position', input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: error }] } }),
  ].join('\n');
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] done' } };
  const run = makeRun({ steps: [
    { k: 0, cycle: { positions: LONG_POS, transcript: failed(close.input, 'timed out awaiting tools/call'), orders: [close] } },
    { k: 1, cycle: {}, trades: [fill(1, 1, 20010, 20, { id: 'close' })] },
    { k: 2, cycle: { positions: LONG_POS, transcript: failed(close.input, 'timed out awaiting tools/call'), orders: [close] } },
    { k: 3, cycle: { positions: LONG_POS } },
  ] });
  const L = labelRun(run.runDir).labels;
  assert.deepStrictEqual([L[0].teacher.action, L[0].gate.decision, L[0].clone.reasons], ['exit', 'ungated', []], 'the fill shows the close');
  assert.deepStrictEqual([L[2].teacher.action, L[2].gate.decision, L[2].clone.reasons], ['exit', 'ungated', ['outcome unknown: client timeout']]);
});

// Review round 7 findings.

test('labels: orders naming the broker\'s own contract id resolve through the run\'s translator cache', () => {
  const bt = { ...LONG, input: { ...LONG.input, contractId: 'BT.MNQ' } };
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'BT.MNQ', reason: '[exit] done' } };
  const run = makeRun({ manifest: { broker: 'backtester' }, steps: [
    { k: 0, cycle: { orders: [bt] } },
    { k: 1, cycle: { positions: LONG_POS, orders: [close] }, trades: [fill(1, 0, 20000, null, { contractId: 'BT.MNQ' })] },
    { k: 2, cycle: {}, trades: [fill(4, 1, 20010, 20, { contractId: 'BT.MNQ' })] },
  ] });
  fs.writeFileSync(path.join(run.home, 'contracts-backtester.json'), JSON.stringify({ ids: { 'BT.MNQ': { root: 'MNQ', month: '2026-03' } }, front: {} }));
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40 });
  assert.deepStrictEqual(labels.slice(0, 2).map(l => [l.decision, l.teacher.action, l.clone.reasons]), [['flat', 'long', []], ['in-trade', 'exit', []]]);
  assert.deepStrictEqual([labels[0].outcome.result, labels[0].teacher.size.riskUsd, summary.unattributedOrders, summary.unmatchedOpenings], ['win', 20, 0, 0]);
});

test('labels: an order on a family the line hasn\'t (a mistyped id) flags every label of the cycle', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [{ tool: 'close_position', input: { accountId: 7, contractId: 'MNQZ9', reason: '[exit] x' } }] } }] });
  const { labels, summary } = labelRun(run.runDir);
  assert.deepStrictEqual([labels[0].teacher.action, labels[0].clone.reasons, summary.holds, summary.unattributedOrders], ['hold', ['unattributed order'], 0, 1]);
  assert.match(summaryText(summary), /unattributedOrders 1, unmatchedOpenings 0/);
});

test('labels: several modifies in a cycle are compared step by step', () => {
  const modify = stopPrice => ({ tool: 'modify_order', input: { accountId: 7, orderId: 2, stopPrice } });
  // Working stop 19990: up to 19998 (tighter), then back to 19995 (wider than the step before, still above the start).
  const run = makeRun({ steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [modify(19998), modify(19995)] } }] });
  assert.deepStrictEqual(labelRun(run.runDir).labels[0].clone.reasons, ['stop widened']);
});

test('labels: a hook block that mentions a timeout is the hook\'s refusal', () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__broker__place_order', input: LONG.input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'PreToolUse hook error: the policy check timed out' }] } }),
  ].join('\n');
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript, orders: [{ ...LONG, gate: 'none' }] } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by], ['refused', 'hook']);
});

// Review round 8: points round 7 left untested.

const claudeCall = (tool, input, error) => [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: `mcp__broker__${tool}`, input }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: error }] } }),
].join('\n');

test('labels: an entry the gate allowed whose call timed out, with no journal record and no fill, is unknown, not taken', () => {
  const run = makeRun({ steps: [
    { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { transcript: claudeCall('place_order', LONG.input, 'MCP error -32001: Request timed out'), orders: [LONG] } },
    { k: 1, cycle: {} },
  ] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  const L = labels[0];
  assert.deepStrictEqual([L.teacher.action, L.gate.decision, L.gate.by, L.outcome.result, L.counterfactualFor, L.counterfactual.reason], ['long', 'allowed', null, 'unknown', 'outcome unknown', 'outcome unknown']);
  assert.deepStrictEqual([L.clone.ok, L.clone.reasons], [false, ['outcome unknown: client timeout']]);
  assert.deepStrictEqual([summary.entries, summary.taken, summary.unknownOutcome, summary.unfilled, summary.refused], [1, 0, 1, 0, 0]);
  assert.match(summaryText(summary), /taken 0, unknownOutcome 1,/);
});

test('labels: an entry whose call timed out but whose fill joined is taken, its outcome known', () => {
  const run = makeRun({ steps: [
    { k: 0, scan: [{ name: 'orb', direction: 'long' }], cycle: { transcript: claudeCall('place_order', LONG.input, 'Request timed out'), orders: [LONG] } },
    { k: 1, cycle: { positions: LONG_POS }, trades: [fill(1, 0, 20000, null)] },
    { k: 2, cycle: {}, trades: [fill(5, 1, 20010, 20)] },
  ] });
  const { labels, summary } = labelRun(run.runDir, { budgetUsd: 40, strategies: STRATEGIES });
  assert.deepStrictEqual([labels[0].outcome.result, labels[0].clone.reasons, summary.taken, summary.unknownOutcome], ['win', [], 1, 0]);
});

test('labels: a close that timed out went through only when a closing fill on its family, not a bracket\'s, comes by the next decision time', () => {
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] done' } };
  const label = (trades, error = 'Request timed out') => labelRun(makeRun({ steps: [
    { k: 0, cycle: { positions: LONG_POS, transcript: claudeCall('close_position', close.input, error), orders: [close] } },
    { k: 1, cycle: { positions: LONG_POS }, trades: trades.k1 || [] },
    { k: 2, cycle: { positions: LONG_POS }, trades: trades.k2 || [] },
  ] }).runDir).labels[0];
  const fate = L => [L.teacher.action, L.gate.decision, L.gate.by, L.clone.reasons];
  const unknown = ['exit', 'ungated', null, ['outcome unknown: client timeout']];
  // A closing fill after the next decision time (k=1 at 3 minutes): another close's.
  assert.deepStrictEqual(fate(label({ k2: [fill(4, 1, 20010, 20)] })), unknown);
  // An opening fill (no profitAndLoss) by the next decision time.
  assert.deepStrictEqual(fate(label({ k1: [fill(1, 1, 20010, null)] })), unknown);
  // A closing fill on another family.
  assert.deepStrictEqual(fate(label({ k1: [fill(1, 1, 5000, 20, { contractId: 'MES' })] })), unknown);
  // The bracket stop's own fill (its round trip's reason).
  assert.deepStrictEqual(fate(label({ k1: [fill(1, 1, 19990, -20, { roundTrip: { reason: 'stop' } })] })), unknown);
  // The control: a closing fill on MNQ by the next decision time.
  assert.deepStrictEqual(fate(label({ k1: [fill(1, 1, 20010, 20)] })), ['exit', 'ungated', null, []]);
  // The broker's definite answer (no timeout): refused, whatever fill follows (the bracket's own).
  assert.deepStrictEqual(fate(label({ k1: [fill(1, 1, 20010, 20)] }, 'OrderRejected: Trading is disabled')), ['exit', 'refused', 'broker', []]);
});

test('labels: of two exits that both went through, the last is the action', () => {
  const close = { tool: 'close_position', input: { accountId: 7, contractId: 'MNQ', reason: '[exit] done' } };
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [close, order('[exit] flatten what is left')] } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.teacher.action, L.gate.decision, L.teacher.priorRefusals], ['exit', 'allowed', 0]);
  const R = labelRun(makeRun({ steps: [{ k: 0, cycle: { positions: LONG_POS, orders: [order('[exit] flatten'), close] } }] }).runDir).labels[0];
  assert.deepStrictEqual([R.teacher.action, R.gate.decision], ['exit', 'ungated']);
});

test('labels: a hook\'s refusal carries its text', () => {
  const L = labelRun(makeRun({ steps: [{ k: 0, cycle: { transcript: claudeCall('place_order', LONG.input, 'PreToolUse hook error: blocked by policy'), orders: [{ ...LONG, gate: 'none' }] } }] }).runDir).labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by, L.gate.brokerReason], ['refused', 'hook', 'PreToolUse hook error: blocked by policy']);
});

test('labels: a failed call of a gated tool with no gate record never reached the gateway - refused by the client, not the broker', () => {
  const run = makeRun({ steps: [{ k: 0, cycle: { transcript: claudeCall('place_order', LONG.input, 'Permission to use mcp__broker__place_order has been denied.'), orders: [{ ...LONG, gate: 'none' }] } }] });
  const { labels, summary } = labelRun(run.runDir);
  const L = labels[0];
  assert.deepStrictEqual([L.gate.decision, L.gate.by, L.gate.brokerReason, L.clone.reasons.includes('no gate record'), summary.brokerRefused],
    ['refused', 'client', 'Permission to use mcp__broker__place_order has been denied.', true, 0]);
});

test('labels: a paper strategy (the gate refuses its entries) is no candidate unless the run is in paper mode; a bar the runner passed on has none', () => {
  const strategies = [...STRATEGIES, { name: 'crt_1h', valid: true, status: 'paper', signal: 'rules', risk: { min_rr: 2 }, exit: {} }].map(x => ({ status: 'active', ...x }));
  const steps = [
    { k: 4, scan: [{ name: 'crt_1h', direction: 'long' }, { name: 'orb', direction: 'short' }], cycle: {} },
    // A no-cycle bar where only the paper strategy fired; then one where the runner's scan decided not to run.
    { k: 5, scan: [{ name: 'crt_1h', direction: 'long' }] },
    { k: 6, scan: [{ name: 'ghost', direction: 'long' }], scanDecision: { run: false, reason: 'no strategy fired and flat' } },
    // The scan's own status first.
    { k: 7, scan: [{ name: 'orb', direction: 'long', status: 'paper' }] },
  ];
  const { labels, summary } = labelRun(makeRun({ steps }).runDir, { strategies });
  assert.deepStrictEqual(labels[0].candidates, [{ name: 'orb', direction: 'short' }]);
  assert.deepStrictEqual([labels[0].counterfactualFor, labels[0].counterfactuals.length, labels[0].counterfactual.strategy], ['skip', 1, 'orb']);
  assert.deepStrictEqual([labels[1].candidates, labels[2].candidates, labels[3].candidates, summary.noCycleWithCandidates], [[], [], [], 0]);
  // Paper mode: every strategy fires (its plans are journalled), but the gate refuses every live entry: no skip, never cloned.
  const paper = makeRun({ steps });
  const cfgFile = path.join(paper.runDir, 'autotrader.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), paper: true }));
  const P = labelRun(paper.runDir, { strategies });
  assert.deepStrictEqual([P.labels[0].candidates.map(c => c.name), P.labels[0].clone.reasons, P.labels[0].counterfactual, P.summary.skipped], [['crt_1h', 'orb'], ['paper mode'], null, 0]);
});

test('labels: flat with a working order, or in a manage-only cycle, standing aside is no skip and never cloned', () => {
  const run = makeRun({ steps: [
    { k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { workingOrders: 1 } },
    { k: 5, scan: [{ name: 'orb', direction: 'short' }], cycle: { action: 'manage' } },
    { k: 6, scan: [{ name: 'orb', direction: 'short' }], cycle: { action: 'manage', positions: LONG_POS } },
  ] });
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual(labels.map(l => [l.decision, l.teacher.action, l.clone.ok, l.clone.reasons, l.counterfactual]), [
    ['flat', 'none', false, ['working order'], null], ['flat', 'none', false, ['manage-only'], null], ['in-trade', 'hold', true, [], null],
  ]);
  assert.deepStrictEqual([summary.skipped, summary.standAside, summary.holds], [0, 0, 1]);
});

test('labels: the run\'s translator cache is read once per root, not once per fill', () => {
  const steps = [{ k: 0, cycle: { orders: [{ ...LONG, input: { ...LONG.input, contractId: 'BT.MNQ' } }] } }];
  for (let k = 1; k < 12; k += 1) steps.push({ k, cycle: k % 2 ? { positions: LONG_POS } : {}, trades: [fill(3 * k - 2, k % 2 ? 0 : 1, 20000, k % 2 ? null : 1, { id: `f${k}`, contractId: 'BT.MNQ' })] });
  const run = makeRun({ manifest: { broker: 'backtester' }, steps });
  const cache = path.join(run.home, 'contracts-backtester.json');
  fs.writeFileSync(cache, JSON.stringify({ ids: { 'BT.MNQ': { root: 'MNQ', month: '2026-03' } }, front: {} }));
  const read = fs.readFileSync;
  let n = 0;
  fs.readFileSync = function counted(file, ...rest) {
    if (String(file).endsWith(path.basename(cache))) n += 1;
    return read.call(this, file, ...rest);
  };
  try {
    labelRun(run.runDir, { budgetUsd: 40 });
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(n > 0 && n <= 3, `read ${n} times`);
});

test('labels: the account\'s working orders flag a flat symbol only while no other family holds a position (its brackets)', () => {
  const MES_POS = [{ contractId: 'MES', side: 'long', size: 1, averagePrice: 5000 }];
  const run = makeRun({ steps: [
    { k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: { positions: MES_POS, workingOrders: 2 } },
    { k: 5, scan: [{ name: 'orb', direction: 'short' }], cycle: { workingOrders: 1 } },
  ] });
  const L = labelRun(run.runDir, { strategies: STRATEGIES }).labels;
  assert.deepStrictEqual(L.map(l => [l.decision, l.clone.reasons, l.counterfactualFor]), [['flat', [], 'skip'], ['flat', ['working order'], null]]);
});

test('labels: flat when the policy\'s screen failed (no verdict: the gate refuses its strategies), standing aside is no skip', () => {
  const run = makeRun({ steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: {} }, { k: 5, scan: [{ name: 'orb', direction: 'short' }], cycle: {} }] });
  const file = fs.readdirSync(path.join(run.home, 'logs', 'cycles', '2026-10-10')).sort()[0];
  const full = path.join(run.home, 'logs', 'cycles', '2026-10-10', file);
  const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  doc.context.unavailable = ['MNQ policy screen (account check failed: timeout): no verdict, so no entry for orb this bar'];
  fs.writeFileSync(full, JSON.stringify(doc));
  const { labels, summary } = labelRun(run.runDir, { strategies: STRATEGIES });
  assert.deepStrictEqual(labels.map(l => [l.clone.reasons, l.counterfactualFor]), [[['policy screen failed'], null], [[], 'skip']]);
  assert.strictEqual(summary.skipped, 1);
  // With two symbols, only the one whose screen failed.
  const two = makeRun({ symbols: ['MES', 'MNQ'], steps: [{ k: 4, scan: [{ name: 'orb', direction: 'short' }], cycle: {} }] });
  const dir = path.join(two.home, 'logs', 'cycles', '2026-10-10');
  const f2 = path.join(dir, fs.readdirSync(dir)[0]);
  const d2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  d2.context.unavailable = ['MES policy screen (account check failed: timeout): no verdict, so no entry for orb this bar'];
  fs.writeFileSync(f2, JSON.stringify(d2));
  assert.deepStrictEqual(labelRun(two.runDir, { strategies: STRATEGIES }).labels.map(l => [l.symbol, l.clone.reasons]), [['MES', ['policy screen failed']], ['MNQ', []]]);
});
