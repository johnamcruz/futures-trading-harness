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
  // No order found: the setup on the table.
  const f = D.decisionEntry({ at: at(3), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(3, 100, { scan: [fired('orb', 'long', 2)] })], entries: [] });
  assert.deepStrictEqual([f.action, f.setup, f.side, f.stop], ['entered', 'orb', 'long', 2]);
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
const openTrade = (over = {}) => ({ contractId: 'MNQ', side: 'long', sign: 1, entry: 94, risk: 10, initialStop: 84, stop: 84, target: null, rNow: 0.2, openedAt: new Date(T0 + STEP + 20000).toISOString(), ...over });
const enteredAt0 = (over = {}) => ({ at: at(0), symbols: ['MNQ'], symbol: 'MNQ', tf: 3, bar: t(0), price: 100, tick: 0.25, contract: 'MNQ', action: 'entered', setup: 'orb', side: 'long', stop: 4, result: 'CYCLE RESULT: executed - orb long', ...over });

test('an entry\'s outcome is its real position: R from the fill while it is open, never "stopped" while the broker lists it', () => {
  // Decision close 100, fill 94, initial stop 84 (1R = 10): a low of 89.5 is no stop while the position is open.
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 100, 89.5, 96)];
  const h = D.withPositions([enteredAt0()], { trades: [openTrade({ rNow: 0.2 })], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  assert.deepStrictEqual([h[0].trade.state, h[0].trade.fill, h[0].trade.risk], ['open', 94, 10]);
  assert.match(D.historyLines(h, market(bars, 1))[0], /entered orb long @100: orb long; since -16t, open from 94, now \+0\.2R$/);
  // Not yet matched to a position: said so, no R from the decision's price.
  assert.match(D.historyLines([enteredAt0()], market(bars, 1))[0], /; since -16t, no position seen$/);
  // An account that could not be read closes nothing.
  const kept = D.withPositions(h, { trades: [], known: false, now: new Date(asOf(2)), market: market(bars, 1) });
  assert.strictEqual(kept[0].trade.state, 'open');
});

test('an entry the runner closed by its trail reads the runner\'s R, not the initial stop a later bar went through', () => {
  // The reviewer's case: a 2R/0.5R trail exits at +2R; a later bar falls through the initial stop.
  const bars = [bar(0, 99, 100, 99, 100), bar(1, 100, 125, 99, 120), bar(2, 120, 121, 80, 82)];
  const open = D.withPositions([enteredAt0()], { trades: [openTrade({ rNow: 2.6, stop: 114 })], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  const closes = { MNQ: { at: new Date(asOf(1) + 60000).toISOString(), r: 2 } };
  const closed = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2) + 5000), market: market(bars, 2), closes });
  assert.deepStrictEqual([closed[0].trade.state, closed[0].trade.r], ['closed', 2]);
  const line = D.historyLines(closed, market(bars, 2))[0];
  assert.match(line, /; since -72t, closed \+2R by the runner's exit$/);
  assert.doesNotMatch(line, /stopped|now/);
  // Closed by its working stop (a bracket fill): the stop's R from the fill; by its target likewise.
  const atStop = D.withPositions(open, { trades: [], known: true, now: new Date(asOf(2) + 5000), market: market(bars, 2) });
  assert.match(D.historyLines(atStop, market(bars, 2))[0], /closed \+2R at its stop$/);
  const tgt = D.withPositions([enteredAt0()], { trades: [openTrade({ rNow: 0.6, stop: 84, target: 124 })], known: true, now: new Date(asOf(0) + 5000), market: market(bars, 0) });
  const hit = D.withPositions(tgt, { trades: [], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  assert.match(D.historyLines(hit, market(bars, 1))[0], /closed \+3R at its target$/);
  // Gone with neither (a flatten by the agent): closed, no R guessed.
  const flat = D.withPositions(tgt, { trades: [], known: true, now: new Date(asOf(0) + 9000), market: market(bars, 0) });
  assert.match(D.historyLines(flat, market(bars, 0))[0], /closed$/);
  // A closed entry stays closed; a new position on the root is never claimed by it.
  const again = D.withPositions(closed, { trades: [openTrade({ openedAt: new Date(asOf(2) + 30000).toISOString() })], known: true, now: new Date(asOf(3)), market: market(bars, 2) });
  assert.strictEqual(again[0].trade.state, 'closed');
});

test('a failed journal read after an executed cycle: details unavailable, no setup guessed from the scan', () => {
  const e = D.decisionEntry({ at: at(0), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - orb long', items: [item(0, 100, { scan: [fired('keltner', 'short', 2)] })], journalFailed: true });
  assert.deepStrictEqual([e.action, e.setup, e.side, e.details], ['entered', undefined, undefined, 'unavailable']);
  assert.match(D.historyLines([e], [])[0], /^10:03 MNQ 3m entered \(details unavailable\) @100: orb long; no position seen$/);
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
  const short = D.withPositions([enteredAt0({ side: 'short' })], { trades: [openTrade({ side: 'short', sign: -1, entry: 100, risk: 2, stop: 102, rNow: 0.5 })], known: true, now: new Date(asOf(1) + 5000), market: market(bars, 1) });
  assert.match(D.historyLines(short, market(bars, 1))[0], /; since -4t, open from 100, now \+0\.5R$/);
  // A long position is not the short entry's.
  assert.strictEqual(D.withPositions([enteredAt0({ side: 'short' })], { trades: [openTrade()], known: true, now: new Date(asOf(1)), market: market(bars, 1) })[0].trade, undefined);
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
  // No order found on two symbols: the setup of the symbol the reason names.
  const mes = { ...item(1, 5000, { scan: [fired('orb', 'long', 2)] }), symbol: 'MES', contractId: 'MES' };
  const n = D.decisionEntry({ at: at(1), symbols: ['MES', 'MNQ'], result: 'CYCLE RESULT: executed - MNQ keltner short', items: [mes, item(1, 103, { scan: [fired('keltner', 'short', 2)] })] });
  assert.deepStrictEqual([n.symbol, n.setup], ['MNQ', 'keltner']);
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
