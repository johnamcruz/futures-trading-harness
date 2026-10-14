'use strict';

// The decision history the cycle prompt shows (trading/decision-history.js): the entry the runner records per
// cycle, the compact lines, what happened since from closed bars only (no look-ahead), the collapse of repeated
// no-trades, old-format entries, and the size of ten lines.

const test = require('node:test');
const assert = require('node:assert');
const D = require('../../scripts/lib/trading/decision-history');
const { CYCLE_OUTCOMES, historyText } = require('../../scripts/lib/autotrader');

const STEP = 180000;
const T0 = Date.parse('2026-10-08T14:00:00Z'); // 10:00 ET
const t = k => new Date(T0 + k * STEP).toISOString();
const bar = (k, o, h, l, c) => ({ t: t(k), o, h, l, c, v: 100 });
// Bar k closes at T0 + (k + 1) * STEP; a cycle runs 5 s after.
const at = k => new Date(T0 + (k + 1) * STEP + 5000).toISOString();
const asOf = k => T0 + (k + 1) * STEP;
const market = (bars, k) => [{ symbol: 'MNQ', minutes: 3, bars, asOf: asOf(k) }];
const item = (k, c, extra = {}) => ({ symbol: 'MNQ', minutes: 3, tickSize: 0.25, contractId: 'MNQ', bar: { t: t(k), c }, scan: [], verdicts: [], ...extra });
const fired = (name, direction, stopDistance) => ({ name, direction, candidate: true, signal: 'rules', stopDistance });

test('every result outcome word has an action; a result line is read as the prompt asks for it', () => {
  assert.deepStrictEqual(Object.keys(D.ACTIONS).sort(), [...CYCLE_OUTCOMES].sort());
  assert.deepStrictEqual(D.parseResult('CYCLE RESULT: no-trade - nothing fired'), { word: 'no-trade', reason: 'nothing fired' });
  assert.deepStrictEqual(D.parseResult('CYCLE RESULT: *Managed*: stop held at ema_cross level'), { word: 'managed', reason: 'stop held at ema_cross level' });
  assert.deepStrictEqual(D.parseResult('CYCLE RESULT: (none reported)'), { word: null, reason: '(none reported)' });
  assert.deepStrictEqual(D.parseResult(null), { word: null, reason: 'no result' });
  assert.strictEqual(D.parseResult('CYCLE RESULT: no-trades - x').word, null);
});

test('the entry: a no-trade with a setup on the table is a skip, with its strategy, side and stop; a policy skip carries its reason', () => {
  const e = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - against the 15m trend', items: [item(3, 100, { scan: [fired('orb', 'long', 2)] })] });
  assert.deepStrictEqual(e, { at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - against the 15m trend', symbol: 'MNQ', tf: 3, bar: t(3), price: 100, tick: 0.25, contract: 'MNQ', action: 'skipped', setup: 'orb', side: 'long', stop: 2 });
  const v = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade', items: [item(3, 100, { verdicts: [{ strategy: 'pol', direction: 'short', action: 'skip', stopTicks: 12, reason: 'cushion too thin' }] })] });
  assert.strictEqual(v.action, 'skipped');
  assert.deepStrictEqual([v.setup, v.side, v.stop, v.why], ['pol', 'short', 3, 'cushion too thin']);
  assert.match(D.historyLines([v], [])[0], /^10:12 MNQ 3m skipped pol short @100: cushion too thin$/);
  // Nothing fired: a plain no-trade; a manage: managed; several lanes tagged.
  assert.strictEqual(D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - nothing', items: [item(3, 100)] }).action, 'no-trade');
  const m = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: managed - held', items: [item(3, 100)], lanes: ['3m', '1m'] });
  assert.deepStrictEqual([m.action, m.lanes, m.setup], ['managed', ['3m', '1m'], undefined]);
  // No bar: the result line only (as before).
  assert.deepStrictEqual(D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x', items: [] }), { at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x' });
});

test('a setup not taken: vetoed when the cycle\'s phase-2 report is a veto, else skipped (the model\'s own pass); a vetoed one keeps its counterfactual', () => {
  // Claude stream-json: a Task call to a role, answered by its report.
  let n = 0;
  const role = (r, text) => {
    n += 1;
    return [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Task', input: { subagent_type: r, prompt: 'p' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: text }] } }),
    ].join('\n');
  };
  const entry = output => D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x', items: [item(3, 100, { scan: [fired('orb', 'long', 2)] })], output });
  const phase1 = role('risk-manager', 'Phase 1: flat, budget 1 trade');
  const veto = role('risk-manager', 'Phase 2 on orb long.\nVERDICT: VETO - no room');
  const approve = role('risk-manager', 'Phase 2 on orb long.\nVERDICT: APPROVE - size 1');
  assert.strictEqual(entry([phase1, veto].join('\n')).action, 'vetoed');
  assert.strictEqual(entry([phase1, approve].join('\n')).action, 'skipped', 'approved, then the model passed: its own pass');
  assert.strictEqual(entry([phase1, approve, veto].join('\n')).action, 'vetoed', 'the latest phase-2 report decides');
  assert.strictEqual(entry([phase1, veto, approve].join('\n')).action, 'skipped');
  assert.strictEqual(entry(phase1).action, 'skipped', 'no phase 2: the model passed');
  assert.strictEqual(entry('').action, 'skipped', 'no transcript (a harness that shows no reports): a pass, as before');
  assert.strictEqual(entry('{"not": "a transcript"').action, 'skipped');
  // A veto with nothing on the table stays a plain no-trade; an analyst's "VETO" is no phase-2 report.
  assert.strictEqual(D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x', items: [item(3, 100)], output: veto }).action, 'no-trade');
  assert.strictEqual(entry(role('market-structure-analyst', 'VERDICT: VETO')).action, 'skipped');
  // Shown as vetoed, with whether it would have hit +1R or -1R first.
  const v = entry(veto);
  const up = [bar(3, 99, 100, 99, 100), bar(4, 100, 102.5, 99.5, 102)];
  assert.deepStrictEqual(D.historyLines([v], market(up, 4)), ['10:12 MNQ 3m vetoed orb long @100: x; since +8t, would hit +1R first']);
});

test('the entry of an executed cycle reads the order it placed: setup, side and the stop bracket; an earlier order, an exit or a refused one is not it', () => {
  const placed = (ts, text, extra = {}) => ({ ts, kind: 'order_placed', contractId: 'MNQ', text, data: { request: { side: 1, stopLossBracket: { ticks: 16, type: 'stop' } }, result: { success: true } }, ...extra });
  const entries = [
    placed(new Date(Date.parse(at(3)) - 60000).toISOString(), 'setup:old long'),
    placed(new Date(Date.parse(at(3)) + 1000).toISOString(), '[exit] setup:orb flatten'),
    { ...placed(new Date(Date.parse(at(3)) + 2000).toISOString(), 'setup:bad long'), data: { request: {}, result: { success: false } } },
    placed(new Date(Date.parse(at(3)) + 3000).toISOString(), 'setup:keltner short, stop 104'),
  ];
  const e = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - keltner short', items: [item(3, 100, { scan: [fired('orb', 'long', 2)] })], entries });
  assert.deepStrictEqual([e.action, e.setup, e.side, e.stop], ['entered', 'keltner', 'short', 4]);
  // No order of its own found (refused, never placed): nothing guessed from the scan, nothing credited later.
  const f = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(3, 100, { scan: [fired('orb', 'long', 2)] })], entries: [] });
  assert.deepStrictEqual([f.action, f.setup, f.side, f.stop, f.noOrder], ['entered', undefined, undefined, undefined, true]);
});

test('what happened since: ticks moved, and a skipped setup\'s +1R or -1R first (both in one bar: -1R), or neither yet', () => {
  const skip = side => ({ at: at(0), symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: t(0), price: 100, tick: 0.25, action: 'skipped', setup: 'orb', side, stop: 2, result: 'CYCLE RESULT: no-trade - x' });
  const up = [bar(0, 99, 100, 99, 100), bar(1, 100, 101, 99.5, 101), bar(2, 101, 102.5, 100.5, 102)];
  assert.strictEqual(D.outcome(skip('long'), market(up, 2)[0]), 'since +8t, would hit +1R first');
  assert.strictEqual(D.outcome(skip('short'), market(up, 2)[0]), 'since +8t, would hit -1R first');
  assert.strictEqual(D.outcome(skip('long'), market(up, 1)[0]), 'since +4t, neither +1R nor -1R yet');
  const both = [bar(0, 99, 100, 99, 100), bar(1, 100, 102, 98, 100.5)];
  assert.strictEqual(D.outcome(skip('long'), market(both, 1)[0]), 'since +2t, would hit -1R first');
  assert.strictEqual(D.outcome(skip('short'), market(both, 1)[0]), 'since +2t, would hit -1R first');
  // No bar closed since: nothing to say; no side or stop: ticks only.
  assert.strictEqual(D.outcome(skip('long'), market(up, 0)[0]), '');
  assert.strictEqual(D.outcome({ ...skip('long'), side: undefined, action: 'no-trade' }, market(up, 2)[0]), 'since +8t');
});

// An open trade as open-trades.js builds it from the broker's position.
// (its last close follows from rNow unless given: the history computes R now from the fill and the plan's risk).
const openTrade = (over = {}) => {
  const o = { contractId: 'MNQ', side: 'long', sign: 1, entry: 94, risk: 10, initialStop: 84, stop: 84, target: null, rNow: 0.2, size: 1, notes: [], openedAt: new Date(T0 + STEP + 20000).toISOString(), ...over };
  return o.last === undefined && Number.isFinite(o.rNow) ? { ...o, last: o.entry + (o.side === 'short' ? -1 : 1) * o.rNow * o.risk } : o;
};
const enteredAt0 = (over = {}) => ({ at: at(0), symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: t(0), price: 100, tick: 0.25, contract: 'MNQ', action: 'entered', setup: 'orb', side: 'long', stop: 10, entrySize: 1, flatAt: true, result: 'CYCLE RESULT: executed - orb long', ...over });

test('an entry\'s outcome is its real position: R from the fill while it is open, never "stopped" while the broker lists it', () => {
  // Decision close 100, fill 94, initial stop 84 (1R = 10): a low of 89.5 is no stop while the position is open.
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 100, 89.5, 96)];
  const h = D.withPositions([enteredAt0()], { trades: [openTrade({ rNow: 0.2 })], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  assert.deepStrictEqual([h[0].trade.state, h[0].trade.fill, h[0].trade.risk], ['open', 94, 10]);
  assert.match(D.historyLines(h, market(bars, 1))[0], /entered orb long @100: orb long; since -16t, open from 94, now \+0\.2R$/);
  // Not yet reconciled (the cycle right after the entry): said so, no R from the decision's price.
  assert.match(D.historyLines([enteredAt0()], market(bars, 1))[0], /; since -16t, no position seen yet$/);
  // The account's positions can't be read: "position state unavailable", never the last R; nothing closed.
  const blind = D.withPositions(h, { trades: [], known: false, now: new Date(asOf(2)), market: market(bars, 1) });
  assert.strictEqual(blind[0].trade.state, 'open');
  assert.match(D.historyLines(blind, market(bars, 1))[0], /; since -16t, position state unavailable$/);
  assert.match(D.historyLines(D.withPositions([enteredAt0()], { known: false, now: new Date(asOf(1)) }), [])[0], /position state unavailable$/);
  // Read again: open with the broker's R now.
  const back = D.withPositions(blind, { trades: [openTrade({ rNow: 0.5 })], known: true, now: new Date(asOf(2) + 5000), market: market(bars, 1) });
  assert.match(D.historyLines(back, market(bars, 1))[0], /open from 94, now \+0\.5R$/);
  // A position opened before the decision's bar is not this entry's.
  const before = D.withPositions([enteredAt0()], { trades: [openTrade({ openedAt: new Date(T0 - 60000).toISOString() })], known: true, now: new Date(asOf(1)), market: market(bars, 1) });
  assert.strictEqual(before[0].trade.state, 'unknown');
});

test('an entry matches its family\'s position, as the runner manages them (a mini from a micro\'s bars)', () => {
  const h = D.withPositions([enteredAt0()], { trades: [openTrade({ contractId: 'NQ' })], known: true, now: new Date(asOf(1)), market: [] });
  assert.deepStrictEqual([h[0].trade.state, h[0].trade.contractId], ['open', 'NQ']);
  // Another family is not.
  assert.strictEqual(D.withPositions([enteredAt0()], { trades: [openTrade({ contractId: 'MES' })], known: true, now: new Date(asOf(1)), market: [] })[0].trade.state, 'unknown');
});

test('two entries on one family: each position belongs to one entry, the latest opened since it', () => {
  const second = enteredAt0({ at: at(2), bar: t(2), price: 102 });
  const one = D.withPositions([enteredAt0(), second], { trades: [openTrade({ openedAt: new Date(asOf(2) + 20000).toISOString() })], known: true, now: new Date(asOf(3)), market: [] });
  assert.deepStrictEqual(one.map(x => x.trade.state), ['unknown', 'open']);
  // A position opened before the second entry's bar is the first's, not the second's.
  const both = D.withPositions([enteredAt0(), second], { trades: [openTrade({ openedAt: new Date(asOf(2) + 20000).toISOString() }), openTrade({ entry: 95, openedAt: new Date(asOf(0) + 20000).toISOString() })], known: true, now: new Date(asOf(3)), market: [] });
  assert.deepStrictEqual(both.map(x => [x.trade.state, x.trade.fill]), [['open', 95], ['open', 94]]);
  // A position opened after a later entry on the family is never an earlier entry's, even when the later one is closed.
  const closedSecond = { ...second, trade: { state: 'closed', r: 1, how: 'at its target' } };
  const later = D.withPositions([enteredAt0(), closedSecond], { trades: [openTrade({ openedAt: new Date(asOf(3)).toISOString() })], known: true, now: new Date(asOf(4)), market: [] });
  assert.strictEqual(later[0].trade.state, 'unknown');
  // With no open time to tell them apart, one position still goes to one entry only (the latest).
  const nul = D.withPositions([enteredAt0(), second], { trades: [openTrade({ openedAt: null })], known: true, now: new Date(asOf(3)), market: [] });
  assert.deepStrictEqual(nul.map(x => x.trade.state), ['unknown', 'open']);
});

// The runner's exit record of a position (runner.js trail or time stop: decision-history appendExit).
const exitOf = (over = {}) => ({ contractId: 'MNQ', side: 'long', openedAt: openTrade().openedAt, size: 1, at: new Date(asOf(1) + 60000).toISOString(), r: 2, ...over });

test('a closed trade\'s R comes only from the runner\'s exit record of that exact position, however late; never from bars', () => {
  // A 2R/0.5R trail exits at +2R; a later bar falls through the initial stop.
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 125, 99, 120), bar(2, 120, 121, 80, 82)];
  const open = D.withPositions([enteredAt0()], { trades: [openTrade({ rNow: 2.6, stop: 114 })], known: true, now: new Date(asOf(1) + 5000) });
  const closed = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2) + 5000), exits: [exitOf()] });
  assert.deepStrictEqual([closed[0].trade.state, closed[0].trade.r], ['closed', 2]);
  const line = D.historyLines(closed, market(bars, 2))[0];
  assert.match(line, /; since -72t, closed about \+2R \(the runner's exit, at the bar close\)$/);
  assert.doesNotMatch(line, /stopped|now|at its/);
  // Reported before the cycle that last saw it open (late): still this position's.
  assert.strictEqual(D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2) + 5000), exits: [exitOf({ at: new Date(asOf(1) + 1000).toISOString(), r: 2.4 })] })[0].trade.r, 2.4);
  // Not this position's (another opening time, side or contract, no opening time), or not reported yet: outcome unknown.
  for (const over of [{ openedAt: new Date(asOf(1) + 40000).toISOString() }, { side: 'short' }, { contractId: 'NQ' }, { openedAt: undefined }, { at: new Date(asOf(3)).toISOString() }]) {
    const x = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2) + 5000), exits: [exitOf(over)] });
    assert.match(D.historyLines(x, market(bars, 2))[0], /; since -72t, closed, outcome unknown$/, JSON.stringify(over));
  }
  // The review's repro: a stop seen at 90, trailed to 105 between reads, one bar through both, a broker fill at the
  // trailed stop (+0.5R) and no runner record: never "-1R at its stop", the outcome is unknown.
  const trailed = D.withPositions([enteredAt0()], { trades: [openTrade({ entry: 100, risk: 10, stop: 90, rNow: 1 })], known: true, now: new Date(asOf(0) + 5000) });
  const fell = D.withPositions(trailed, { trades: [], known: true, now: new Date(asOf(2) + 5000) });
  assert.match(D.historyLines(fell, market(bars, 2))[0], /closed, outcome unknown$/);
  // A closed entry stays closed, even with no open time to tell a new position apart.
  const noOpen = D.withPositions([enteredAt0()], { trades: [openTrade({ openedAt: null })], known: true, now: new Date(asOf(1)) });
  const gone = D.withPositions(noOpen, { trades: [], known: true, now: new Date(asOf(2) + 5000) });
  const again = D.withPositions(gone, { trades: [openTrade({ openedAt: null, entry: 120 })], known: true, now: new Date(asOf(3)) });
  assert.deepStrictEqual([again[0].trade.state, again[0].trade.fill], ['closed', 94]);
});

test('runner exit records are append-only, one per position: a later position on the contract never overwrites an earlier one\'s', () => {
  // The review's repro: A closed by the runner at +2R during a failed read, then B on the same contract closed at -1R.
  const a = exitOf({ r: 2 });
  const b = exitOf({ openedAt: new Date(asOf(2) + 20000).toISOString(), at: new Date(asOf(3)).toISOString(), r: -1 });
  const exits = D.appendExit(D.appendExit([], a), b);
  assert.deepStrictEqual(exits, [a, b]);
  const open = D.withPositions([enteredAt0()], { trades: [openTrade()], known: true, now: new Date(asOf(1)) });
  const blind = D.withPositions(open, { known: false, now: new Date(asOf(2)) });
  const after = D.withPositions(blind, { trades: [], known: true, now: new Date(asOf(4)), exits: D.exitRecords(exits, null) });
  assert.match(D.historyLines(after, [])[0], /closed about \+2R \(the runner's exit, at the bar close\)$/);
  // Bounded: the last EXITS_KEPT.
  let many = [];
  for (let k = 0; k < D.EXITS_KEPT + 5; k += 1) many = D.appendExit(many, exitOf({ r: k }));
  assert.strictEqual(many.length, D.EXITS_KEPT);
  assert.strictEqual(many[0].r, 5);
  // The older one-per-contract records read safely: one without the position's side and opening time credits nothing.
  assert.deepStrictEqual(D.exitRecords(undefined, { MNQ: { at: a.at, r: 2 } }), [{ contractId: 'MNQ', at: a.at, r: 2 }]);
  const legacy = D.withPositions(blind, { trades: [], known: true, now: new Date(asOf(4)), exits: D.exitRecords(undefined, { MNQ: { at: a.at, r: 2 } }) });
  assert.match(D.historyLines(legacy, [])[0], /closed, outcome unknown$/);
  // (one with the side and opening time but no closed size: not known to have closed it all, so not its R either)
  const noSize = D.withPositions(blind, { trades: [], known: true, now: new Date(asOf(4)), exits: D.exitRecords([], { MNQ: { at: a.at, r: 2, openedAt: a.openedAt, side: 'long' } }) });
  assert.match(D.historyLines(noSize, [])[0], /closed, outcome unknown$/);
  const legacyFull = D.withPositions(blind, { trades: [], known: true, now: new Date(asOf(4)), exits: D.exitRecords([], { MNQ: { at: a.at, r: 2, openedAt: a.openedAt, side: 'long', size: 1 } }) });
  assert.match(D.historyLines(legacyFull, [])[0], /closed about \+2R \(the runner's exit, at the bar close\)$/);
  assert.deepStrictEqual(D.exitRecords('junk', [1]), []);
});

test('a short\'s runner exit: the record\'s R as it is', () => {
  const open = D.withPositions([enteredAt0({ side: 'short' })], { trades: [openTrade({ side: 'short', sign: -1, entry: 100, risk: 5, stop: 105, rNow: 0 })], known: true, now: new Date(asOf(0) + 5000) });
  const closed = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2)), exits: [exitOf({ side: 'short', r: -1 })] });
  assert.match(D.historyLines(closed, [])[0], /closed about -1R \(the runner's exit, at the bar close\)$/);
});

test('a later flatten or reversal decides nothing about a position: only its exit record or the broker\'s positions do', () => {
  // A long seen open, then a reversal entry; the long gone later with no record: outcome unknown (never at the
  // reversal's price or fill, never from bars).
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 100, 97.5, 98), bar(2, 98, 98, 89, 89.5)];
  const open = D.withPositions([enteredAt0()], { trades: [openTrade({ entry: 100, risk: 10, stop: 90, rNow: 0 })], known: true, now: new Date(asOf(0) + 5000) });
  const flip = enteredAt0({ at: at(1), bar: t(1), price: 98, side: 'short', setup: 'bos' });
  const after = D.withPositions([...open, flip], { trades: [openTrade({ side: 'short', sign: -1, entry: 98, risk: 5, stop: 103, rNow: 1.7, openedAt: new Date(asOf(1) + 30000).toISOString() })], known: true, now: new Date(asOf(2) + 5000) });
  assert.deepStrictEqual(after.map(x => x.trade.state), ['closed', 'open']);
  assert.match(D.historyLines(after, market(bars, 2))[0], /closed, outcome unknown$/);
  // A refused flatten: the long still open after it, then its runner exit at -1R.
  const flat = { at: at(1), symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: t(1), price: 98, tick: 0.25, contract: 'MNQ', action: 'flattened', result: 'CYCLE RESULT: flattened - cut' };
  const kept = D.withPositions([...open, flat], { trades: [openTrade({ entry: 100, risk: 10, stop: 90, rNow: 0.3 })], known: true, now: new Date(asOf(2) + 5000) });
  assert.strictEqual(kept[0].trade.state, 'open');
  const gone = D.withPositions(kept, { trades: [], known: true, now: new Date(asOf(3) + 5000), exits: [exitOf({ at: new Date(asOf(3)).toISOString(), r: -1 })] });
  assert.match(D.historyLines(gone, [])[0], /closed about -1R \(the runner's exit, at the bar close\)$/);
  // An unfilled reversal is never credited with the long's exit.
  const still = D.withPositions([...open, flip], { trades: [openTrade({ entry: 100, risk: 10, stop: 90, rNow: 0.3 })], known: true, now: new Date(asOf(2) + 5000) });
  const closes = [exitOf({ at: new Date(asOf(2) + 30000).toISOString(), r: 1.2 })];
  const runnerClosed = D.withPositions(still, { trades: [], known: true, now: new Date(asOf(3) + 5000), exits: closes });
  assert.deepStrictEqual(runnerClosed.map(x => [x.trade.state, x.trade.r]), [['closed', 1.2], ['unknown', undefined]]);
});

test('a fill never seen open: "outcome unknown", or the runner\'s own exit of a position opened for that decision', () => {
  const e = D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(1)) });
  assert.match(D.historyLines(e, [])[0], /no open position seen: outcome unknown$/);
  const exit = (over = {}) => [exitOf({ contractId: 'NQ', at: new Date(asOf(0) + 60000).toISOString(), r: -1, openedAt: new Date(asOf(0) + 30000).toISOString(), ...over })];
  const own = D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(1)), exits: exit() });
  assert.match(D.historyLines(own, [])[0], /closed about -1R \(the runner's exit, at the bar close\)$/);
  // Opened exactly when the decision was made still counts (at or after it); a moment before it does not.
  assert.strictEqual(D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(1)), exits: exit({ openedAt: at(0) }) })[0].trade.state, 'closed');
  assert.strictEqual(D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(1)), exits: exit({ openedAt: new Date(Date.parse(at(0)) - 1000).toISOString() }) })[0].trade.state, 'unknown');
  // Not this decision's: no opening time, the other side, no side, opened before its bar, or reported after now.
  for (const over of [{ openedAt: undefined }, { side: 'short' }, { side: undefined }, { openedAt: new Date(T0 - 60000).toISOString() }, { at: new Date(asOf(2)).toISOString() }]) {
    assert.strictEqual(D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(1)), exits: exit(over) })[0].trade.state, 'unknown', JSON.stringify(over));
  }
  // Opened after a later entry on the family and side: that entry's, not this one's.
  const second = enteredAt0({ at: at(2), bar: t(2), price: 102 });
  const laterFill = exit({ openedAt: new Date(asOf(2) + 30000).toISOString(), at: new Date(asOf(2) + 60000).toISOString() });
  const two = D.withPositions([enteredAt0(), second], { trades: [], known: true, now: new Date(asOf(3)), exits: laterFill });
  assert.deepStrictEqual(two.map(x => x.trade.state), ['unknown', 'closed']);
  // A later entry of unknown side (its details unavailable) bounds it too, even once it is closed.
  const sideless = { ...enteredAt0({ at: at(2), bar: t(2), price: 102, side: undefined, setup: undefined, details: 'unavailable' }), trade: { state: 'closed', r: null } };
  assert.strictEqual(D.withPositions([enteredAt0(), sideless], { trades: [openTrade({ openedAt: new Date(asOf(2) + 30000).toISOString() })], known: true, now: new Date(asOf(3)) })[0].trade.state, 'unknown');
  // A limit that fills later is still matched.
  assert.strictEqual(D.withPositions(e, { trades: [openTrade()], known: true, now: new Date(asOf(2)) })[0].trade.state, 'open');
});

// A broker fill (search_trades): side 0 buy, 1 sell; profitAndLoss null on an opening fill.
const fillOf = (over = {}) => ({ id: 1, contractId: 'MNQ', creationTimestamp: new Date(asOf(1) + 30000).toISOString(), price: 84, profitAndLoss: -10, fees: 0.37, side: 1, size: 1, voided: false, orderId: 1, ...over });

// The decision's own opening fill (its entry order, 7): long 1 at 94 when the position opened.
const openingOf = (over = {}) => fillOf({ id: 50, side: 0, profitAndLoss: null, price: 94, creationTimestamp: openTrade().openedAt, orderId: 7, ...over });

test('a closed trade\'s R from its own fills, from the plan\'s risk: losers and winners alike, before the runner\'s record', () => {
  // Seen open: long 1 from 94; the plan's 1R = 10 (its stop distance).
  const open = D.withPositions([enteredAt0({ orderId: 7 })], { trades: [openTrade({ size: 1 })], known: true, now: new Date(asOf(1)) });
  const close = fills => D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2)), fills: fills && [openingOf(), ...fills] });
  assert.match(D.historyLines(close([fillOf()]), [])[0], /closed -1R$/);
  assert.match(D.historyLines(close([fillOf({ price: 114, profitAndLoss: 10 })]), [])[0], /closed \+2R$/);
  // The fills come before the runner's record (its R is the bar close's): "+1.8R", not "about +2R".
  const both = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf(), fillOf({ price: 112, profitAndLoss: 9 })], exits: [exitOf({ at: new Date(asOf(1) + 30000).toISOString() })] });
  assert.match(D.historyLines(both, [])[0], /closed \+1\.8R$/);
  // Not this position's close: voided, another contract of the family moving, the opening side, before it opened,
  // after now, more than its size (a reversal), or not a closing fill: no R (unknown, or the runner's record).
  for (const over of [{ voided: true }, { contractId: 'NQ' }, { side: 0 }, { creationTimestamp: new Date(T0).toISOString() }, { creationTimestamp: new Date(asOf(3)).toISOString() }, { size: 2 }, { profitAndLoss: null }]) {
    assert.match(D.historyLines(close([fillOf(over)]), [])[0], /closed, outcome unknown$/, JSON.stringify(over));
  }
  // A reversal's fill (more than the position) before a fill of its size: the position's close is not known.
  assert.match(D.historyLines(close([fillOf({ size: 2, price: 120 }), fillOf({ id: 2, creationTimestamp: new Date(asOf(1) + 40000).toISOString() })]), [])[0], /closed, outcome unknown$/);
  // Fills not read: unknown for a winner as for a loser.
  assert.match(D.historyLines(close(null), [])[0], /closed, outcome unknown$/);
  // A size-2 position closed in two fills: their size-weighted price.
  const two = D.withPositions([enteredAt0({ orderId: 7 })], { trades: [openTrade({ size: 2 })], known: true, now: new Date(asOf(1)) });
  const out = D.withPositions(two, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf({ size: 2 }), fillOf({ price: 114 }), fillOf({ id: 2, price: 116, creationTimestamp: new Date(asOf(1) + 40000).toISOString() })] });
  assert.match(D.historyLines(out, [])[0], /closed \+2\.1R$/);
  // Only one of the two: not closed by these fills.
  assert.match(D.historyLines(D.withPositions(two, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf({ size: 2 }), fillOf({ price: 114 })] }), [])[0], /closed, outcome unknown$/);
  // A short: its closing buy above the fill is a loss.
  const short = D.withPositions([enteredAt0({ side: 'short', stop: 5, orderId: 7 })], { trades: [openTrade({ side: 'short', sign: -1, entry: 100, risk: 5, size: 1 })], known: true, now: new Date(asOf(1)) });
  assert.match(D.historyLines(D.withPositions(short, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf({ side: 1, price: 100 }), fillOf({ side: 0, price: 105 })] }), [])[0], /closed -1R$/);
});

test('R divides by the plan\'s risk, never a trailed stop: frozen at the first sighting, unknown when not the plan\'s', () => {
  // The review's probe: entry 100, plan stop 10, trailed to 98 (open-trades measures to the working stop), target 110: +1R.
  const e = enteredAt0({ orderId: 7 });
  const seen = D.withPositions([e], { trades: [openTrade({ entry: 100, risk: 2, stop: 98, last: 105, notes: ['initial stop unknown: risk from the working stop'] })], known: true, now: new Date(asOf(1)) });
  assert.deepStrictEqual([seen[0].trade.risk, seen[0].trade.rNow], [10, 0.5]);
  const out = D.withPositions(seen, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf({ price: 100 }), fillOf({ price: 110, profitAndLoss: 10 })] });
  assert.match(D.historyLines(out, [])[0], /closed \+1R$/);
  // No stop distance on the decision: the first sighting's risk from its initial stop, kept though later reads trail.
  const bare = enteredAt0({ stop: undefined, orderId: 7 });
  const first = D.withPositions([bare], { trades: [openTrade({ entry: 100, risk: 10, last: 100 })], known: true, now: new Date(asOf(1)) });
  const later = D.withPositions(first, { trades: [openTrade({ entry: 100, risk: 2, stop: 98, last: 104, notes: ['initial stop unknown: risk from the working stop'] })], known: true, now: new Date(asOf(2)) });
  assert.deepStrictEqual([later[0].trade.risk, later[0].trade.rNow], [10, 0.4]);
  // First seen with only a working-stop risk: unknown, and so is its R.
  const blind = D.withPositions([bare], { trades: [openTrade({ entry: 100, risk: 2, last: 104, notes: ['initial stop unknown: risk from the working stop'] })], known: true, now: new Date(asOf(1)) });
  assert.deepStrictEqual([blind[0].trade.risk, blind[0].trade.rNow], [null, null]);
  assert.match(D.historyLines(blind, [])[0], /open from 100$/);
  const gone = D.withPositions(blind, { trades: [], known: true, now: new Date(asOf(2)), fills: [openingOf({ price: 100 }), fillOf({ price: 110, profitAndLoss: 10 })] });
  assert.match(D.historyLines(gone, [])[0], /closed, outcome unknown$/);
});

test('another order\'s fills are never the decision\'s: its own order opens it, the account flat before; else unknown', () => {
  // The review's probe: a manual long 1 @95, then the decision's long 1 @100 (order 7), then a manual sell 1 @96.
  const manual = fillOf({ id: 60, side: 0, profitAndLoss: null, price: 95, orderId: 99, creationTimestamp: new Date(Date.parse(at(0)) + 1000).toISOString() });
  const ours = fillOf({ id: 61, side: 0, profitAndLoss: null, price: 100, orderId: 7, creationTimestamp: new Date(Date.parse(at(0)) + 2000).toISOString() });
  const sell = fillOf({ id: 62, side: 1, profitAndLoss: 1, price: 96, orderId: 98, creationTimestamp: new Date(asOf(0) + 60000).toISOString() });
  const e = enteredAt0({ orderId: 7 });
  assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(1)), fills: [manual, ours, sell] })[0].trade.state, 'unknown');
  // The same with the manual fill after its own: a manual add, mixed.
  const after = { ...manual, creationTimestamp: new Date(Date.parse(at(0)) + 3000).toISOString() };
  assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(1)), fills: [ours, after, sell] })[0].trade.mixed, true);
  // Not flat when it was decided, or flatness unknown (an old entry): its fills can't be told apart.
  for (const over of [{ flatAt: false }, { flatAt: undefined }]) {
    assert.strictEqual(D.withPositions([enteredAt0({ orderId: 7, ...over })], { trades: [], known: true, now: new Date(asOf(1)), fills: [ours, { ...sell, size: 1 }] })[0].trade.state, 'unknown', JSON.stringify(over));
  }
  // No order id (journal without one): no fills are ever credited to it, a single order'"'"'s or not.
  const noId = enteredAt0();
  const one = D.withPositions([noId], { trades: [], known: true, now: new Date(asOf(1)), fills: [ours, fillOf({ id: 63, price: 110, profitAndLoss: 10, creationTimestamp: new Date(asOf(0) + 60000).toISOString() })] });
  assert.strictEqual(one[0].trade.state, 'unknown');
  assert.strictEqual(D.withPositions([noId], { trades: [], known: true, now: new Date(asOf(1)), fills: [ours, after, sell] })[0].trade.state, 'unknown');
  // A position seen at a size its own fills don't add up to: not told by them.
  const seen2 = D.withPositions([e], { trades: [openTrade({ size: 2, entry: 100, openedAt: ours.creationTimestamp })], known: true, now: new Date(asOf(0) + 30000) });
  assert.match(D.historyLines(D.withPositions(seen2, { trades: [], known: true, now: new Date(asOf(1)), fills: [ours, { ...sell, price: 110 }] }), [])[0], /closed, outcome unknown$/);
  // A closing fill or the other side's fill first: not its position.
  for (const first of [{ ...sell, creationTimestamp: new Date(Date.parse(at(0)) + 1000).toISOString() }, { ...manual, side: 1 }]) {
    assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(1)), fills: [first, ours, sell] })[0].trade.state, 'unknown', JSON.stringify(first));
  }
  // The decision's own order id, but another order filled first: not its position.
  assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(1)), fills: [{ ...ours, orderId: 8 }, sell] })[0].trade.state, 'unknown');
});

test('an entry records its order\'s id and whether the account was flat on its family when the cycle began', () => {
  const placed = { ts: at(0), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long', data: { request: { side: 'buy', stopLossBracket: { ticks: 40 } }, result: { success: true, orderId: 77 } } };
  const entry = positions => D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100)], entries: [placed], positions });
  assert.deepStrictEqual([entry([]).orderId, entry([]).flatAt], [77, true]);
  // Another family's position: still flat on this one; this family's (a mini for a micro decision): not flat.
  assert.strictEqual(entry([{ contractId: 'MES', type: 1, size: 1 }]).flatAt, true);
  assert.strictEqual(entry([{ contractId: 'NQ', type: 2, size: 1 }]).flatAt, false);
  // Positions not read: not known.
  assert.strictEqual('flatAt' in entry(null), false);
  // Only an entry carries it.
  assert.strictEqual('flatAt' in D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x', items: [item(0, 100)], positions: [] }), false);
});

test('a decision without a successful order of its own is credited nothing; fills are read only inside a decision\'s window', () => {
  // The review's repro: A "executed" at 10:03 but its order was refused (no order_placed success); B decided at 10:09
  // (order 90) fills at 104 and is stopped at 94. A never reads B's -1R.
  const refused = { ts: at(0), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long', data: { request: { side: 'buy' }, result: { success: false } } };
  const a = D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100, { scan: [fired('orb', 'long', 10)] })], entries: [refused], positions: [] });
  assert.deepStrictEqual([a.noOrder, a.setup, a.side, 'flatAt' in a, 'orderId' in a], [true, undefined, undefined, false, false]);
  const b = enteredAt0({ at: at(2), bar: t(2), price: 104, orderId: 90 });
  const fills = [
    fillOf({ id: 70, side: 0, profitAndLoss: null, price: 104, orderId: 90, creationTimestamp: new Date(Date.parse(at(2)) + 2000).toISOString() }),
    fillOf({ id: 71, side: 1, profitAndLoss: -10, price: 94, orderId: 91, creationTimestamp: new Date(asOf(2) + 60000).toISOString() }),
  ];
  const h = D.withPositions([a, b], { trades: [], known: true, now: new Date(asOf(3)), fills });
  assert.match(D.historyLines(h, [])[0], /entered @100: orb long; no order of its own seen: outcome unknown$/);
  assert.match(D.historyLines(h, [])[1], /closed -1R$/);
  assert.strictEqual(D.fillsNeededSince([a], new Date(asOf(3))), null);
  // Defense in depth: even its own order id, filled only after the next decision on its family and side was made,
  // is not credited to it.
  const same = D.withPositions([enteredAt0({ orderId: 90 }), { ...b, orderId: 92 }], { trades: [], known: true, now: new Date(asOf(3)), fills });
  assert.strictEqual(same[0].trade.state, 'unknown');
  // The same for one seen open with no opening time (the window can't place the position): its close is not told.
  const seen = D.withPositions([enteredAt0({ orderId: 90 })], { trades: [openTrade({ entry: 104, openedAt: null })], known: true, now: new Date(asOf(1)) });
  const gone = D.withPositions([...seen, { ...b, orderId: 92 }], { trades: [], known: true, now: new Date(asOf(3)), fills });
  assert.match(D.historyLines(gone, [])[0], /closed, outcome unknown$/);
  // Without an order id, fills with none either are never its own.
  const bare = fills.map(f => ({ ...f, orderId: undefined }));
  assert.strictEqual(D.withPositions([enteredAt0({ at: at(2), bar: t(2) })], { trades: [], known: true, now: new Date(asOf(3)), fills: bare })[0].trade.state, 'unknown');
  // A decision with no order of its own never claims a position either.
  const claim = D.withPositions([a], { trades: [openTrade({ openedAt: new Date(Date.parse(at(0)) + 20000).toISOString() })], known: true, now: new Date(asOf(1)) });
  assert.match(D.historyLines(claim, [])[0], /no order of its own seen: outcome unknown$/);
  assert.strictEqual(claim[0].trade, undefined);
});

test('a scale-out is still the decision\'s own: its R from every close, size-weighted, winners and losers alike', () => {
  // The review's repro: long 2 at 100 (order 7, plan 1R 10), seen at 2, then 1, then gone.
  const e = enteredAt0({ orderId: 7 });
  const opened = new Date(Date.parse(at(0)) + 2000).toISOString();
  const two = D.withPositions([e], { trades: [openTrade({ size: 2, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(0) + 30000) });
  const one = D.withPositions(two, { trades: [openTrade({ size: 1, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(1)) });
  assert.deepStrictEqual([one[0].trade.mixed, one[0].trade.scaledOut, one[0].trade.size, one[0].trade.cur], [undefined, true, 2, 1]);
  const open2 = fillOf({ id: 80, side: 0, profitAndLoss: null, price: 100, size: 2, orderId: 7, creationTimestamp: opened });
  const close = (a, b, fills = [open2, fillOf({ id: 81, price: a, profitAndLoss: 1, creationTimestamp: new Date(asOf(0) + 60000).toISOString() }), fillOf({ id: 82, price: b, profitAndLoss: 1, creationTimestamp: new Date(asOf(1) + 60000).toISOString() })]) =>
    D.withPositions(one, { trades: [], known: true, now: new Date(asOf(2)), fills });
  // A winner scaled out at +1R and 0R: +0.5R per contract.
  assert.match(D.historyLines(close(110, 100), [])[0], /closed \+0\.5R$/);
  // A loser scaled out at -0.6R and -1R: -0.8R per contract.
  assert.match(D.historyLines(close(94, 90), [])[0], /closed -0\.8R$/);
  // First seen only after its first partial close (at 1 of its 2): the fills still tell it.
  const late = D.withPositions([e], { trades: [openTrade({ size: 1, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(1)) });
  assert.match(D.historyLines(D.withPositions(late, { trades: [], known: true, now: new Date(asOf(2)), fills: [open2, fillOf({ id: 81, price: 110, profitAndLoss: 1, creationTimestamp: new Date(asOf(0) + 60000).toISOString() }), fillOf({ id: 82, price: 100, profitAndLoss: 0, creationTimestamp: new Date(asOf(1) + 60000).toISOString() })] }), [])[0], /closed \+0\.5R$/);
  // No fills: the runner's record (of the last close only) is not its R: unknown.
  const rec = D.withPositions(one, { trades: [], known: true, now: new Date(asOf(2)), exits: [exitOf({ openedAt: opened, at: new Date(asOf(1) + 60000).toISOString(), r: 0 })] });
  assert.match(D.historyLines(rec, [])[0], /closed, outcome unknown$/);
  // Grown back after the scale-out (2, 1, then 2): another order's fills: mixed.
  const back = D.withPositions(one, { trades: [openTrade({ size: 2, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(2)) });
  assert.strictEqual(back[0].trade.mixed, true);
  // Its own order filling again after a partial close: mixed too (the fills say so).
  const reopened = [open2, fillOf({ id: 83, price: 110, profitAndLoss: 1, creationTimestamp: new Date(asOf(0) + 60000).toISOString() }), fillOf({ id: 84, side: 0, profitAndLoss: null, price: 105, size: 1, orderId: 7, creationTimestamp: new Date(asOf(0) + 90000).toISOString() })];
  assert.strictEqual(D.withPositions(one, { trades: [], known: true, now: new Date(asOf(2)), fills: reopened })[0].trade.mixed, true);
});

test('a runner exit record is the R only when it closed the whole entry: a scale-out the history never saw leaves it unknown', () => {
  // The review's probes: long 2 (1R = 10), one out at +2R, the runner exits the other at +0.5R; true R +1.25R.
  // The record says size 1 of an entry of 2: not the R, and with no fills, unknown.
  const e = enteredAt0({ orderId: 7, entrySize: 2 });
  const opened = new Date(Date.parse(at(0)) + 2000).toISOString();
  const rec = [exitOf({ openedAt: opened, size: 1, r: 0.5, at: new Date(asOf(1) + 30000).toISOString() })];
  // (a) first seen only after the partial close, at 1.
  const late = D.withPositions([e], { trades: [openTrade({ size: 1, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(1)) });
  assert.match(D.historyLines(D.withPositions(late, { trades: [], known: true, now: new Date(asOf(2)), exits: rec }), [])[0], /closed, outcome unknown$/);
  // (b) seen at 2; the partial close and the runner's exit both between two cycles.
  const two = D.withPositions([e], { trades: [openTrade({ size: 2, entry: 100, openedAt: opened })], known: true, now: new Date(asOf(0) + 30000) });
  assert.match(D.historyLines(D.withPositions(two, { trades: [], known: true, now: new Date(asOf(2)), exits: rec }), [])[0], /closed, outcome unknown$/);
  // A record of the whole entry (size 2) is its R, "about".
  const whole = [exitOf({ openedAt: opened, size: 2, r: 1.2, at: new Date(asOf(1) + 30000).toISOString() })];
  assert.match(D.historyLines(D.withPositions(two, { trades: [], known: true, now: new Date(asOf(2)), exits: whole }), [])[0], /closed about \+1\.2R \(the runner's exit, at the bar close\)$/);
  // The same rule for a decision never seen open; and an entry of unknown size never takes a record.
  assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(2)), exits: rec })[0].trade.state, 'unknown');
  assert.strictEqual(D.withPositions([e], { trades: [], known: true, now: new Date(asOf(2)), exits: whole })[0].trade.r, 1.2);
  assert.strictEqual(D.withPositions([enteredAt0({ orderId: 7, entrySize: undefined })], { trades: [], known: true, now: new Date(asOf(2)), exits: whole })[0].trade.state, 'unknown');
  // The entry's size comes from its order (place_order's size).
  const placed = { ts: at(0), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long', data: { request: { side: 'buy', size: 2 }, result: { success: true, orderId: 7 } } };
  assert.strictEqual(D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100)], entries: [placed], positions: [] }).entrySize, 2);
});

test('an order id recorded at the journal entry\'s top level is read too', () => {
  const placed = { ts: at(0), kind: 'order_placed', contractId: 'MNQ', orderId: 55, text: 'setup:orb long', data: { request: { side: 'buy' }, result: { success: true } } };
  assert.strictEqual(D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100)], entries: [placed], positions: [] }).orderId, 55);
});

test('any position on the family, of any type, means the account was not flat', () => {
  const placed = { ts: at(0), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long', data: { request: { side: 'buy' }, result: { success: true, orderId: 5 } } };
  const entry = positions => D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100)], entries: [placed], positions });
  assert.strictEqual(entry([{ contractId: 'MNQ', type: 0, size: 1 }]).flatAt, false);
  assert.strictEqual(entry([{ contractId: 'MNQ', type: 1, size: 0 }]).flatAt, true);
});

test('a close the fills couldn\'t tell is final: the fills stop being read for it', () => {
  const open = D.withPositions([enteredAt0({ orderId: 7 })], { trades: [openTrade()], known: true, now: new Date(asOf(1)) });
  const unread = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2)), fills: null });
  assert.strictEqual(unread[0].trade.final, undefined, 'not read: still wanted');
  assert.strictEqual(D.fillsNeededSince(unread, new Date(asOf(2))), Date.parse(at(0)));
  const told = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2)), fills: [] });
  assert.strictEqual(told[0].trade.final, true);
  assert.strictEqual(D.fillsNeededSince(told, new Date(asOf(2))), null);
  // Never seen open: final after UNSEEN_READS reads that couldn't tell it (a limit never filled).
  let h = [enteredAt0()];
  for (let k = 0; k < D.UNSEEN_READS; k += 1) {
    assert.notStrictEqual(D.fillsNeededSince(h, new Date(asOf(2))), null, `read ${k}`);
    h = D.withPositions(h, { trades: [], known: true, now: new Date(asOf(2)), fills: [] });
  }
  assert.strictEqual(h[0].trade.final, true);
  assert.strictEqual(D.fillsNeededSince(h, new Date(asOf(2))), null);
  // Unread cycles don't count.
  assert.strictEqual(D.withPositions([enteredAt0()], { trades: [], known: true, now: new Date(asOf(2)), fills: null })[0].trade.reads, 0);
});
test('a scale-in: a second decision on the same side never claims the first one\'s position, and neither gets the other\'s R', () => {
  // The review's repro: A decided at 10:03:05 (bar 10:00), filled 10:03:08; B decided at 10:06:05 (bar 10:03), adds 1.
  const filled = new Date(Date.parse(at(0)) + 3000).toISOString();
  const a = D.withPositions([enteredAt0()], { trades: [openTrade({ size: 1, openedAt: filled })], known: true, now: new Date(asOf(0) + 30000) });
  assert.strictEqual(a[0].trade.state, 'open');
  const b = enteredAt0({ at: at(1), bar: t(1), price: 101 });
  const added = D.withPositions([...a, b], { trades: [openTrade({ size: 2, entry: 97.5, openedAt: filled })], known: true, now: new Date(asOf(1) + 30000) });
  assert.deepStrictEqual(added.map(x => x.trade.state), ['open', 'unknown']);
  assert.strictEqual(added[0].trade.mixed, true);
  // Gone, with the runner's record of that position and closing fills: no one decision's R.
  const exits = [exitOf({ openedAt: filled, at: new Date(asOf(2)).toISOString(), r: 1.3 })];
  const gone = D.withPositions(added, { trades: [], known: true, now: new Date(asOf(2) + 30000), exits, fills: [fillOf({ size: 2, price: 120, creationTimestamp: new Date(asOf(2)).toISOString() })] });
  assert.deepStrictEqual(gone.map(x => [x.trade.state, x.trade.r ?? null]), [['closed', null], ['unknown', null]]);
  assert.match(D.historyLines(gone, [])[0], /closed, outcome unknown$/);
  // Added to between the fill and its first sighting: the fills show it, so no R either.
  const late = D.withPositions([enteredAt0()], { trades: [openTrade({ size: 2, openedAt: filled })], known: true, now: new Date(asOf(1) + 30000) });
  const lateGone = D.withPositions(late, { trades: [], known: true, now: new Date(asOf(2) + 30000), fills: [fillOf({ side: 0, profitAndLoss: null, price: 101, creationTimestamp: new Date(asOf(0) + 60000).toISOString() }), fillOf({ size: 2, price: 120, creationTimestamp: new Date(asOf(2)).toISOString() })] });
  assert.match(D.historyLines(lateGone, [])[0], /closed, outcome unknown$/);
});

test('a fill never seen open: its own opening and closing fills in its window give its R from the plan\'s stop', () => {
  // Long, stop distance 4 (a decision flat when made): bought 100.25 at 10:03:07, sold 104.25 at 10:04:00: +1R.
  const opening = fillOf({ side: 0, profitAndLoss: null, price: 100.25, creationTimestamp: new Date(Date.parse(at(0)) + 2000).toISOString() });
  const closing = fillOf({ price: 104.25, profitAndLoss: 2, creationTimestamp: new Date(asOf(0) + 60000).toISOString() });
  const e = D.withPositions([enteredAt0({ stop: 4, orderId: 1 })], { trades: [], known: true, now: new Date(asOf(1)), fills: [opening, closing] });
  assert.match(D.historyLines(e, [])[0], /closed \+1R$/);
  assert.deepStrictEqual([e[0].trade.state, e[0].trade.r, e[0].trade.fill], ['closed', 1, 100.25]);
  // Opened before the decision was made, or on two contracts in its window, or a side it can't tell: unknown.
  const early = { ...opening, creationTimestamp: new Date(Date.parse(at(0)) - 1000).toISOString() };
  assert.strictEqual(D.withPositions([enteredAt0({ stop: 4, orderId: 1 })], { trades: [], known: true, now: new Date(asOf(1)), fills: [early, closing] })[0].trade.state, 'unknown');
  assert.strictEqual(D.withPositions([enteredAt0({ stop: 4, orderId: 1 })], { trades: [], known: true, now: new Date(asOf(1)), fills: [opening, { ...opening, id: 9, contractId: 'NQ' }, { ...closing, size: 2 }] })[0].trade.state, 'unknown');
  assert.strictEqual(D.withPositions([enteredAt0({ side: undefined, stop: 4, orderId: 1 })], { trades: [], known: true, now: new Date(asOf(1)), fills: [opening, closing] })[0].trade.state, 'unknown');
  // A record without a side never credits a decision of unknown side.
  assert.strictEqual(D.withPositions([enteredAt0({ side: undefined })], { trades: [], known: true, now: new Date(asOf(1)), exits: [exitOf({ side: undefined, at: new Date(asOf(0) + 60000).toISOString() })] })[0].trade.state, 'unknown');
});

test('fills are needed while one of the day\'s entered decisions is unresolved, from the earliest of them', () => {
  const resolved = { ...enteredAt0({ at: at(1) }), trade: { state: 'closed', r: 1 } };
  assert.strictEqual(D.fillsNeededSince([enteredAt0(), resolved], new Date(asOf(2))), Date.parse(at(0)));
  assert.strictEqual(D.fillsNeededSince([resolved], new Date(asOf(2))), null);
  assert.strictEqual(D.fillsNeededSince([{ ...enteredAt0(), trade: { state: 'closed', r: null, mixed: true } }], new Date(asOf(2))), null);
  // An earlier trading day's: not read for.
  assert.strictEqual(D.fillsNeededSince([enteredAt0({ at: new Date(T0 - 864e5).toISOString() })], new Date(asOf(2))), null);
  assert.strictEqual(D.fillsNeededSince([{ action: 'managed', at: at(0) }], new Date(asOf(2))), null);
});

test('a failed journal read after an executed cycle: details unavailable, no setup guessed from the scan', () => {
  const e = D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100, { scan: [fired('keltner', 'short', 2)] })], journalFailed: true });
  assert.deepStrictEqual([e.action, e.setup, e.side, e.details], ['entered', undefined, undefined, 'unavailable']);
  assert.match(D.historyLines([e], [])[0], /^10:03 MNQ 3m entered \(details unavailable\) @100: orb long; no position seen yet$/);
});

test('no look-ahead: a bar closing after this cycle\'s bar never changes the lines, whatever the list holds', () => {
  const skip = { at: at(0), symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: t(0), price: 100, tick: 0.25, action: 'skipped', setup: 'orb', side: 'long', stop: 2, result: 'CYCLE RESULT: no-trade - x' };
  const closed = [bar(0, 99, 100, 99, 100), bar(1, 100, 101, 99.5, 100.5)];
  const future = [...closed, bar(2, 100.5, 110, 90, 109)];
  const now = D.historyLines([skip], market(closed, 1));
  assert.deepStrictEqual(now, ['10:03 MNQ 3m skipped orb long @100: x; since +2t, neither +1R nor -1R yet']);
  assert.deepStrictEqual(D.historyLines([skip], market(future, 1)), now, 'the bar after the cycle\'s bar is not read');
  // A bar whose open is before asOf but whose close is after (still forming) is not read either.
  assert.deepStrictEqual(D.historyLines([skip], [{ ...market(future, 1)[0], asOf: asOf(1) + 60000 }]), now);
  // Once it has closed, it is.
  assert.notDeepStrictEqual(D.historyLines([skip], market(future, 2)), now);
});

test('repeats collapse: consecutive identical no-trades are one line with a count and a span; a different reason, symbol or a skip breaks the run', () => {
  const nt = (k, reason = 'nothing fired', sym = 'MNQ') => ({ at: at(k), symbols: [sym], symbol: sym, tf: 3, bar: t(k), price: 100 + k, tick: 0.25, action: 'no-trade', result: `CYCLE RESULT: no-trade - ${reason}` });
  const bars = Array.from({ length: 12 }, (_, k) => bar(k, 100 + k, 101 + k, 99 + k, 100 + k));
  const lines = D.historyLines([nt(0), nt(1), nt(2), nt(3, 'chop'), nt(4, 'chop', 'MES'), nt(5), { ...nt(6), action: 'skipped', setup: 'orb', side: 'long', stop: 1 }, nt(7), nt(8)], market(bars, 9));
  assert.deepStrictEqual(lines.map(l => l.replace(/; since.*/, '')), [
    '10:03-10:09 MNQ 3m no-trade ×3 @100: nothing fired',
    '10:12 MNQ 3m no-trade @103: chop',
    '10:15 MES 3m no-trade @104: chop',
    '10:18 MNQ 3m no-trade @105: nothing fired',
    '10:21 MNQ 3m skipped orb long @106: nothing fired',
    '10:24-10:27 MNQ 3m no-trade ×2 @107: nothing fired',
  ]);
  // The run's outcome is from its first decision.
  assert.match(lines[0], /; since \+36t$/);
});

test('old-format entries (a state from before the decision facts, or across a restart) render with what they have; bad entries do not throw', () => {
  const old = [
    { at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long 2 MNQ' },
    { at: at(1), symbols: ['MNQ', 'MES'], result: null },
    { at: 'not a time', symbols: ['MNQ'], result: 'CYCLE RESULT: blocked - the gate refused' },
    null,
    { at: at(2), symbols: ['MNQ'], result: 'CYCLE RESULT: planned - slow', lanes: ['15m'] },
  ];
  assert.deepStrictEqual(D.historyLines(old, market([], 3)), [
    '10:03 MNQ entered: orb long 2 MNQ',
    '10:06 MNQ,MES: no result',
    '? MNQ blocked: the gate refused',
    '10:09 MNQ 15m planned: slow',
  ]);
  // A state saved as JSON and read back renders the same.
  const e = D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - x', items: [item(0, 100, { scan: [fired('orb', 'long', 2)] })] });
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 103, 99.5, 103)];
  assert.deepStrictEqual(D.historyLines(JSON.parse(JSON.stringify([e])), market(bars, 1)), D.historyLines([e], market(bars, 1)));
});

test('the market: each item\'s closed bars (the runner\'s, else the prompt\'s recent ones) and its bar\'s close; an entry reads its own lane first', () => {
  const m = D.marketOf([{ symbol: 'MNQ', bar: { t: t(5), recent: [1] } }, { symbol: 'MNQ', minutes: 1, bar: { t: t(5) }, bars: [2] }], 3);
  assert.deepStrictEqual(m, [{ symbol: 'MNQ', minutes: 3, bars: [1], asOf: asOf(5), contractId: null }, { symbol: 'MNQ', minutes: 1, bars: [2], asOf: Date.parse(t(5)) + 60000, contractId: null }]);
  const e = { at: at(0), symbols: ['MNQ'], symbol: 'MNQ', tf: 1, bar: t(0), price: 100, tick: 0.25, action: 'no-trade', result: 'CYCLE RESULT: no-trade - x' };
  const three = { symbol: 'MNQ', minutes: 3, bars: [bar(1, 100, 100, 100, 110)], asOf: asOf(1) };
  const one = { symbol: 'MNQ', minutes: 1, bars: [{ t: t(1), o: 100, h: 100, l: 100, c: 101 }], asOf: Date.parse(t(1)) + 60000 };
  assert.match(D.historyLines([e], [three, one])[0], /since \+4t$/);
  assert.match(D.historyLines([e], [three])[0], /since \+40t$/);
});

test('ten decisions stay small: one compact line each, the block within 1,200 characters of the bare result lines', () => {
  const reasons = ['nothing fired', 'orb fired against the 15m trend, stood aside', 'stop held', 'trail moved to breakeven', 'chop inside the IB'];
  const bars = Array.from({ length: 30 }, (_, k) => bar(k, 21500 + k, 21504 + k, 21496 + k, 21501.25 + k));
  const history = Array.from({ length: 10 }, (_, k) => D.decisionEntry({
    at: at(k), symbols: ['MNQ'], result: `CYCLE RESULT: ${k % 2 ? 'no-trade' : 'managed'} - ${reasons[k % 5]} ${k}`,
    items: [item(k, bars[k].c, { scan: k % 2 ? [fired('keltner', 'short', 6.5)] : [] })],
  }));
  const text = historyText(history, false, market(bars, 12));
  const bare = history.map(h => h.result.replace('CYCLE RESULT: ', '')).join(' | ').length;
  assert.strictEqual(text.split(' | ').length, 10);
  assert.ok(text.length - bare <= 1200, `${text.length} vs ${bare} bare: +${text.length - bare}`);
  for (const l of D.historyLines(history, market(bars, 12))) assert.ok(l.length <= 160, l);
});

test('review fixes: a short position\'s R from its fill; string order sides', () => {
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 100.5, 98.5, 99)];
  const short = D.withPositions([enteredAt0({ side: 'short', stop: 2 })], { trades: [openTrade({ side: 'short', sign: -1, entry: 100, risk: 2, stop: 102, rNow: 0.5 })], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  assert.match(D.historyLines(short, market(bars, 1))[0], /; since -4t, open from 100, now \+0\.5R$/);
  // A long position is not the short entry's.
  assert.strictEqual(D.withPositions([enteredAt0({ side: 'short' })], { trades: [openTrade()], known: true, now: new Date(asOf(1)), market: market(bars, 1) })[0].trade.state, 'unknown');
  // The interface's place_order sides ('buy' | 'sell') and the take-profit bracket.
  const entries = [{ ts: at(0), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb MNQ sell 1', data: { request: { side: 'sell', stopLossBracket: { ticks: 8 }, takeProfitBracket: { ticks: 16 } }, result: { success: true } } }];
  const e = D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb short', items: [item(0, 100)], entries });
  assert.deepStrictEqual([e.setup, e.side, e.stop, e.target], ['orb', 'short', 2, 4]);
});

test('review fixes: outcomes stop at the decision\'s trading day and contract; an earlier day\'s decision carries its date', () => {
  // 15:45 ET on 2026-10-07 (bar 19:45Z), then the next morning's bars.
  const late = '2026-10-07T19:45:00.000Z';
  const e = { at: '2026-10-07T19:48:05.000Z', symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: late, price: 100, tick: 0.25, contract: 'MNQ:Z26', action: 'skipped', setup: 'orb', side: 'long', stop: 2, result: 'CYCLE RESULT: no-trade - late' };
  const next = [{ t: late, o: 100, h: 100, l: 100, c: 100 }, { t: '2026-10-07T19:48:00.000Z', o: 100, h: 100.5, l: 99.5, c: 100.5 }, ...[0, 1].map(k => bar(k, 90, 91, 89, 90))];
  const m = [{ symbol: 'MNQ', minutes: 3, bars: next, asOf: asOf(1), contractId: 'MNQ:Z26' }];
  assert.deepStrictEqual(D.historyLines([e], m), ['10-07 15:48 MNQ 3m skipped orb long @100: late; since +2t, neither +1R nor -1R yet']);
  // A roll since: no outcome on the new contract's prices.
  assert.deepStrictEqual(D.historyLines([e], [{ ...m[0], contractId: 'MNQ:H27' }]), ['10-07 15:48 MNQ 3m skipped orb long @100: late']);
});

test('review fixes: a manage or flatten names no setup and the symbol its reason names', () => {
  const mes = { ...item(1, 5000, { scan: [fired('orb', 'long', 2)] }), symbol: 'MES', contractId: 'MES' };
  const f = D.decisionEntry({ at: at(1), symbols: ['MES', 'MNQ'], result: 'CYCLE RESULT: flattened - MNQ cut', items: [mes, item(1, 103)] });
  assert.deepStrictEqual([f.symbol, f.action, f.setup, f.price], ['MNQ', 'flattened', undefined, 103]);
  const m = D.decisionEntry({ at: at(1), symbols: ['MNQ'], result: 'CYCLE RESULT: managed - trailed the long', items: [item(1, 103, { scan: [fired('keltner', 'short', 2)] })] });
  assert.deepStrictEqual([m.action, m.setup, m.side], ['managed', undefined, undefined]);
});

test('review fixes: an earlier cycle\'s order placed after this bar closed (a cycle that overran) is not this cycle\'s entry', () => {
  const order = (ts, text, side) => ({ ts, kind: 'order_placed', contractId: 'MNQ', text, data: { request: { side, stopLossBracket: { ticks: 20 } }, result: { success: true } } });
  // This cycle's bar closed at 10:06 (14:06Z); the previous cycle placed its order at 14:06:30; this one started at 14:06:40.
  const entries = [order('2026-10-08T14:06:30.000Z', 'setup:orb long', 'buy'), order('2026-10-08T14:07:30.000Z', 'setup:keltner short', 'sell')];
  const e = D.decisionEntry({ at: '2026-10-08T14:06:40.000Z', symbols: ['MNQ'], result: 'CYCLE RESULT: executed - keltner short', items: [item(1, 100)], entries });
  assert.deepStrictEqual([e.setup, e.side], ['keltner', 'short']);
  // A broker clock stamping the bar's close (before the cycle's start): the last order since the close.
  const early = D.decisionEntry({ at: '2026-10-08T14:06:40.000Z', symbols: ['MNQ'], result: 'CYCLE RESULT: executed - x', items: [item(1, 100)], entries: [order('2026-10-08T14:06:00.000Z', 'setup:bos long', 'buy')] });
  assert.strictEqual(early.setup, 'bos');
  // No order found on two symbols: the symbol the reason names, no setup guessed.
  const mes = { ...item(1, 5000, { scan: [fired('orb', 'long', 2)] }), symbol: 'MES', contractId: 'MES' };
  const n = D.decisionEntry({ at: at(1), symbols: ['MES', 'MNQ'], result: 'CYCLE RESULT: executed - MNQ keltner short', items: [mes, item(1, 103, { scan: [fired('keltner', 'short', 2)] })] });
  assert.deepStrictEqual([n.symbol, n.setup, n.noOrder], ['MNQ', undefined, true]);
});

test('review fixes: no-trades never collapse across trading days', () => {
  const nt = ts => ({ at: ts, symbols: ['MNQ'], symbol: 'MNQ', tf: 3, action: 'no-trade', result: 'CYCLE RESULT: no-trade - nothing fired' });
  assert.strictEqual(D.historyLines([nt('2026-10-07T19:57:05.000Z'), nt(at(0)), nt(at(1))], market([], 1)).length, 2);
});

test('review fixes: bad bars or entries never throw, and the prompt names a history it could not build', () => {
  const e = { at: at(0), symbols: 'MNQ', symbol: 'MNQ', tf: 3, bar: t(0), price: 100, tick: 0.25, action: 'skipped', why: 42, side: 'long', stop: 2, result: 'CYCLE RESULT: no-trade' };
  const lines = D.historyLines([e], market([null, { t: 'x' }, bar(1, 100, 'a', 99, 100), bar(1, 100, 101, 99, 100.5)], 1));
  assert.deepStrictEqual(lines, ['10:03 MNQ 3m skipped long @100: 42; since +2t, neither +1R nor -1R yet']);
  const bad = { get result() { throw new Error('corrupt entry'); }, at: at(0) };
  assert.strictEqual(historyText([bad]), ' Your last cycles: unavailable this cycle (corrupt entry).');
});
