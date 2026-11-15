'use strict';

// The Market state (scripts/lib/trading/market-state.js, feat/chop-read, MARKET-STATE-SPEC and the owner's final word,
// "trend, chop, ranging"): what the 3m market is doing, the precedence applied once, printed as one summary line with
// the Pullback read and the 4h + 1h alignment beside it. A read, not a filter: nothing that decides reads it
// (tests/plugin/market-state-readers.test.js).

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../scripts/lib/trading/market-state');

const TH = { crossesChop: 5 };
const LEG = { origin: 21361.25, extreme: 21437.5 };
const pb = (o = {}) => ({ frame: '15m', side: 'long', leg: { ...LEG, atr: 4 }, depth: 0.28, pastOrigin: false, counter: { bars: 6 }, swing: {}, against: {}, ...o });
const T = m => new Date(Date.UTC(2026, 0, 6, 15, m)).toISOString();
const brk = (kind, direction, level, m = 30) => ({ kind, direction, level, barsAgo: 2, at: T(m) });
const PAIR = { last: brk('CHoCH', 'up', 21558.25, 30), previous: brk('CHoCH', 'down', 21497.75, 18) };
const ONE = { last: brk('CHoCH', 'up', 21512.25, 30), previous: brk('BOS', 'down', 21497.75, 18) };
const BOS_UP = { last: brk('BOS', 'up', 21566.25, 36), previous: brk('BOS', 'up', 21540.25, 18) };
const BOS_DN = { last: brk('BOS', 'down', 21470.25, 36), previous: brk('CHoCH', 'down', 21490.25, 18) };
const day = (read, vwapCrosses) => (read === 'too early' ? { status: 'too early', vwapCrosses } : { status: 'read', read, vwapCrosses });
const cisd = (dir, at, status = 'waiting') => ({ '3m': { dir, level: 21550, confirmedAt: at, status } });
const b = ({ h4 = 'up', h1 = 'up', m15, pullback, lastBreak, soFar, minutes = 3, m3 = {} } = {}) => ({
  minutes,
  sections: {
    h1: { data: { ...(h4 === 'none' ? {} : { h4: { trend: h4 } }), ...(h1 === 'none' ? {} : { h1: { trend: h1 } }) } },
    ...(m15 ? { m15: { data: { frame: { trend: m15 } } } } : {}),
    m3: { data: { ...(pullback === undefined ? {} : { pullback }), ...(lastBreak ? { lastBreak } : {}), ...(soFar ? { today: { soFar } } : {}), ...m3 } },
  },
});
const S = o => M.stateOf(b(o), TH);
const st = o => S(o).state;
const word = o => M.classWordOf(S(o));
const line = o => M.marketStateLine(S(o));
const CHOP = { lastBreak: PAIR, soFar: day('rotational', 7) };

test('chopMet: the 3m breaks both ways AND the Day so far rotational or its RTH VWAP crosses at the threshold; never one fact alone; no threshold refused', () => {
  const c = (lastBreak, soFar) => M.chopFacts({ lastBreak, soFar }, TH).met;
  assert.strictEqual(c(PAIR, day('rotational', 2)), true);
  assert.strictEqual(c(PAIR, day('mixed', 5)), true, 'the crosses decide at the threshold');
  assert.strictEqual(c(PAIR, day('mixed', 4)), false);
  assert.strictEqual(c(PAIR, day('too early', 6)), true, 'the crosses print while too early too');
  assert.strictEqual(c(ONE, day('rotational', 9)), false, 'one CHoCH is never chop');
  assert.strictEqual(c(PAIR, undefined), false, 'the pair alone is never chop');
  assert.strictEqual(c(undefined, day('rotational', 9)), false, 'rotational alone is never chop');
  assert.throws(() => M.chopMet({ bothWays: true, rotational: true }, {}), /crossesChop/, 'never a literal');
});

test('the state, once: chop (the facts, no open Pullback line, no confirmed turn) > trend (a BOS, or a confirmed CHoCH) > ranging; the alignment never decides it', () => {
  assert.strictEqual(st(CHOP), 'chop');
  assert.strictEqual(st({ ...CHOP, h4: 'range' }), 'chop', 'aligned or not');
  assert.strictEqual(st({ ...CHOP, pullback: pb() }), 'trend', 'an open Pullback line excludes chop: the pair back the 4h + 1h way is a failed reversal');
  assert.deepStrictEqual([st({ lastBreak: BOS_UP }), S({ lastBreak: BOS_UP }).way], ['trend', 'up']);
  assert.deepStrictEqual([st({ lastBreak: BOS_DN }), S({ lastBreak: BOS_DN }).way], ['trend', 'down'], 'a 3m trend against the 4h + 1h is still the 3m trend');
  assert.strictEqual(st({ lastBreak: BOS_UP, h4: 'range' }), 'trend', 'not aligned: still the 3m trend');
  assert.strictEqual(st({ lastBreak: ONE }), 'ranging', 'one CHoCH: ranging');
  assert.strictEqual(st({}), 'ranging', 'no break printed');
  assert.strictEqual(st({ lastBreak: ONE, soFar: day('rotational', 9) }), 'ranging', 'one chop fact: ranging');
  assert.strictEqual(st({ ...CHOP, pullback: pb({ pastOrigin: true }) }), 'chop', 'a given-back Pullback line is not open');
  assert.strictEqual(st({ ...CHOP, pullback: pb({ pastOrigin: undefined, depth: 1.1 }) }), 'chop', 'an older record: depth >= 1 is given back');
  assert.strictEqual(st({ ...CHOP, pullback: pb({ side: 'short' }) }), 'trend', 'any open Pullback line excludes chop');
  assert.strictEqual(st({ ...CHOP, pullback: pb(), h4: 'range' }), 'ranging', 'not aligned, the break before unknown: the pair unconfirmed');
});

test('a CHoCH then a BOS the same way is a BOS: trend (pinned)', () => {
  const lb = { last: brk('BOS', 'up', 21566.25, 36), previous: brk('CHoCH', 'up', 21558.25, 30) };
  assert.deepStrictEqual([st({ lastBreak: lb, soFar: day('rotational', 9) }), S({ lastBreak: lb }).way], ['trend', 'up']);
});

test('a CHoCH then a live 3m CISD the same way, confirmed on a later candle: trend; it ends a chop (causal)', () => {
  const c = at => ({ ...CHOP, m3: { cisd: cisd('bullish', at) } });
  assert.deepStrictEqual([st(c(T(36))), S(c(T(36))).way], ['trend', 'up']);
  assert.strictEqual(line(c(T(36))), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up back (failed reversal; continuation up), then a 3m CISD up (confirmed); the chop ended; 4h+1h up');
  assert.strictEqual(st(c(T(30))), 'chop', 'confirmed on the CHoCH\'s own candle: not after it');
  assert.strictEqual(st(c(T(24))), 'chop', 'before the CHoCH');
  assert.strictEqual(st({ ...CHOP, m3: { cisd: cisd('bearish', T(36)) } }), 'chop', 'the other way');
  for (const x of ['void', 'expired', 'weak']) assert.strictEqual(st({ ...CHOP, m3: { cisd: cisd('bullish', T(36), x) } }), 'chop', `a ${x} CISD is dead`);
  for (const x of ['touched', 'bounced']) assert.strictEqual(st({ ...CHOP, m3: { cisd: cisd('bullish', T(36), x) } }), 'trend', `a ${x} CISD is live`);
  assert.strictEqual(st({ ...CHOP, m3: { cisd: { '3m': 'none in these bars' } } }), 'chop');
  assert.strictEqual(line({ lastBreak: ONE, m3: { cisd: cisd('bullish', T(36)) } }), 'Market state (3m): trend up: 3m BOS down then CHoCH up (potential reversal, unconfirmed), then a 3m CISD up (confirmed); 4h+1h up', 'one CHoCH confirmed: a trend, no chop to end');
  assert.strictEqual(word({ ...c(T(36)), h4: 'range' }), 'unclear', 'the turn never overrides the alignment');
  assert.strictEqual(word({ ...c(T(36)), h4: 'down', h1: 'down' }), 'unclear', 'a trend up under 4h + 1h down: unclear, never counter');
});

test('a CHoCH and a close beyond the initial balance it rotated in: trend; the IB complete, the previous break inside it', () => {
  const ib = { ibHigh: 21560, ibLow: 21480 };
  const at = (price, today = ib, o = {}) => ({ ...CHOP, ...o, m3: { price, today: { ...today, soFar: day('rotational', 7) } } });
  assert.strictEqual(line(at(21563.25)), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up back (failed reversal; continuation up), then a close above the IB high 21560 (confirmed); the chop ended; 4h+1h up');
  assert.strictEqual(line(at(21559.75)), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (back and forth); Day so far rotational, RTH VWAP crosses 7; 4h+1h up', 'inside the range');
  assert.strictEqual(st(at(21563.25, { ibHigh: null, ibLow: null })), 'chop', 'the IB not complete: before 10:30 only a BOS or CISD ends it');
  const above = { last: brk('CHoCH', 'up', 21570.25, 30), previous: brk('CHoCH', 'down', 21562.75, 18) };
  assert.strictEqual(st(at(21573.25, ib, { lastBreak: above })), 'chop', 'both breaks beyond the IB: a new chop there');
  const down = { last: brk('CHoCH', 'down', 21562.25, 30), previous: brk('CHoCH', 'up', 21540.75, 18) };
  assert.strictEqual(st(at(21561.25, ib, { lastBreak: down })), 'chop', 'above the IB but the last break down');
  const low = { last: brk('CHoCH', 'down', 21481.25, 30), previous: brk('CHoCH', 'up', 21500.75, 18) };
  assert.strictEqual(line(at(21477.75, ib, { lastBreak: low, h4: 'down', h1: 'down' })), 'Market state (3m): trend down: 3m CHoCH up then CHoCH down back (failed reversal; continuation down), then a close below the IB low 21480 (confirmed); the chop ended; 4h+1h down');
});

test('ranging prints its 3m breaks and whether price is inside the complete IB', () => {
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21512, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); inside the IB 21480-21540; 4h+1h up');
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21475, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); 4h+1h up', 'below the IB, the last break up: no turn, not inside');
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21545, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): trend up: 3m BOS down then CHoCH up (potential reversal, unconfirmed), then a close above the IB high 21540 (confirmed); 4h+1h up', 'one CHoCH and a close above the IB: a confirmed turn');
  assert.strictEqual(line({}), 'Market state (3m): ranging: no 3m break printed; 4h+1h up');
  assert.strictEqual(line({ h4: 'range' }), 'Market state (3m): ranging: no 3m break printed; 4h range, 1h up (not aligned)');
  assert.strictEqual(line({ h4: 'none' }), 'Market state (3m): ranging: no 3m break printed; 4h unknown, 1h up (not aligned)');
});

test('the Pullback read is no state: printed under trend or ranging whenever its line is open; it never makes chop', () => {
  assert.strictEqual(line({ lastBreak: BOS_UP, pullback: pb() }), 'Market state (3m): trend up: 3m BOS up (continuation); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(line({ lastBreak: ONE, pullback: pb() }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(line({ ...CHOP, pullback: pb({ leg: { ...LEG, atr: 0.5 } }) }), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up back (failed reversal; continuation up); pullback (long leg 21361.25 -> 21437.5, small leg); 4h+1h up');
  assert.strictEqual(line({ lastBreak: BOS_UP, pullback: pb({ pastOrigin: true }) }), 'Market state (3m): trend up: 3m BOS up (continuation); 4h+1h up', 'given back: no read');
});

test('classWordOf: chop -> chop; not aligned -> unclear; a pullback the 4h + 1h way (open line, or the early 15m read) -> that trend class; trend the aligned way or ranging under them -> that trend class; a trend against -> unclear', () => {
  assert.strictEqual(word(CHOP), 'chop');
  assert.strictEqual(word({ ...CHOP, h4: 'range' }), 'chop');
  assert.strictEqual(word({ lastBreak: BOS_UP }), 'trend-up');
  assert.strictEqual(word({ lastBreak: BOS_DN, h4: 'down', h1: 'down' }), 'trend-down');
  assert.strictEqual(word({ lastBreak: ONE }), 'trend-up', 'ranging under an aligned 4h + 1h: a range day inside the trend');
  assert.strictEqual(word({}), 'trend-up');
  assert.strictEqual(word({ lastBreak: BOS_DN }), 'unclear', 'a 3m trend against the 4h + 1h, no pullback read');
  assert.strictEqual(word({ lastBreak: BOS_UP, h4: 'range' }), 'unclear', 'not aligned');
  assert.strictEqual(word({ lastBreak: ONE, h4: 'up', h1: 'down' }), 'unclear');
  // The q101 shape (decision (b)): 4h + 1h up, an open long Pullback, the last 3m break a BOS down: the pullback, not a trend down.
  const q101 = { lastBreak: BOS_DN, pullback: pb() };
  assert.deepStrictEqual([st(q101), word(q101)], ['trend', 'trend-up']);
  assert.strictEqual(line(q101), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(word({ lastBreak: ONE, pullback: pb() }), 'trend-up', 'a pullback under ranging');
  assert.strictEqual(word({ lastBreak: BOS_DN, pullback: pb(), h4: 'down', h1: 'down' }), 'trend-down', 'a long leg against 4h + 1h down: the 3m trend down, aligned');
  assert.strictEqual(word({ lastBreak: BOS_UP, pullback: pb({ side: 'short' }) }), 'trend-up', 'a short leg under 4h + 1h up: no pullback read the aligned way; the 3m trend up decides');
  assert.strictEqual(word({ lastBreak: BOS_DN, pullback: pb(), h4: 'range' }), 'unclear', 'a pullback with no alignment');
  assert.strictEqual(M.classWordOf(null), null);
});

// The owner: "15min up trend, 3min down trend could mean pullback" (before the Pullback line opens: it needs completed
// 15m candles after the extreme).
test('the early 15m pullback: the 15m trending the 4h + 1h way and the 3m trend against: a pullback read and the trend class; the open line supersedes it', () => {
  const e = { lastBreak: BOS_DN, m15: 'up' };
  assert.deepStrictEqual([st(e), word(e)], ['trend', 'trend-up']);
  assert.strictEqual(line(e), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); 15m up: a pullback in the 15m trend; 4h+1h up');
  assert.strictEqual(line({ ...e, m15: 'range' }), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); 4h+1h up', 'the 15m not trending the aligned way: no read');
  assert.strictEqual(word({ ...e, m15: 'range' }), 'unclear', 'then the table: a trend against');
  assert.strictEqual(word({ ...e, m15: 'down' }), 'unclear');
  assert.strictEqual(line({ ...e, pullback: pb() }), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up', 'the open line supersedes it');
  assert.strictEqual(S({ ...e, h4: 'range' }).early, false, 'no alignment: no read');
  assert.strictEqual(S({ lastBreak: BOS_UP, m15: 'up' }).early, false, 'the 3m with the trend: no pullback');
  assert.strictEqual(st({ ...CHOP, m15: 'up' }), 'chop', 'it never makes or breaks chop');
});

test('stateOf: off the entry lane or without a 1h part: null; readState has no lane guard', () => {
  assert.strictEqual(M.stateOf(b({ minutes: 15 }), TH), null);
  assert.strictEqual(M.stateOf({ minutes: 3, sections: {} }, TH), null);
  assert.strictEqual(M.stateOf(null, TH), null);
  assert.strictEqual(M.readState({ sections: { h1: { data: {} } } }, TH).state, 'ranging');
  assert.strictEqual(M.marketStateLine(null), null);
  for (const o of [{}, { pullback: pb() }, { h4: 'range' }, CHOP]) assert.doesNotMatch(line(o), /\bside\b/, 'never the Bias line\'s word');
});

// One threshold value, two homes (PREREG addendum 14, D1): the briefing passes config/analysis.json regime.rangeCrosses
// (a runtime tunable), the recognition key its frozen config/recognition.json signals.crossesChop; they stay equal.
test('the briefing\'s chop threshold equals the recognition key\'s', () => {
  const { analysis } = require('../../scripts/lib/tunables');
  const rec = require('../../config/recognition.json');
  assert.strictEqual(analysis().regime.rangeCrosses, rec.signals.crossesChop);
});

// The owner's structure-sequence reading (2026-11-14, his correction: "CHoCH then CHoCH = failed reversal"): his BOS and
// CHoCH are relative to the last break, as structure-events.js labels them (BOS continues it, CHoCH changes direction, a
// potential reversal). CHoCH then BOS the same way: a confirmed transition; a CHoCH against the trend, then a CHoCH back:
// one back-and-forth, a failed reversal (the trend continues), chop with the chop facts; repeated CHoCH with no BOS:
// unconfirmed, chop with the facts, else ranging. The trend before: the break before the pair, else the 4h + 1h way.
test('the owner\'s sequence reading (labels relative to the last break), every row: the state and the printed reading', () => {
  const B = (kind, direction, at) => ({ kind, direction, level: 21500, at: T(at) });
  const row = (lastBreak, o = {}) => { const s = S({ lastBreak, ...o }); return [s.state, s.way, M.marketStateLine(s)]; };
  // Bearish trend -> bullish CHoCH -> bullish BOS: a confirmed bullish transition.
  assert.deepStrictEqual(row({ last: B('BOS', 'up', 36), previous: B('CHoCH', 'up', 24), before: B('BOS', 'down', 12) }), ['trend', 'up', 'Market state (3m): trend up: 3m CHoCH up then BOS up (confirmed transition up); 4h+1h up']);
  // Bullish trend -> bearish CHoCH -> bearish BOS: a confirmed bearish transition.
  assert.deepStrictEqual(row({ last: B('BOS', 'down', 36), previous: B('CHoCH', 'down', 24), before: B('BOS', 'up', 12) }, { h4: 'down', h1: 'down' }), ['trend', 'down', 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); 4h+1h down']);
  // Up trend (a BOS run up) -> CHoCH down -> CHoCH back up: one back-and-forth, a failed reversal: the trend up continues;
  // with the chop facts (rotational or the crosses, no open Pullback line) it is chop.
  const fr = { last: B('CHoCH', 'up', 36), previous: B('CHoCH', 'down', 24), before: B('BOS', 'up', 12) };
  assert.deepStrictEqual(row(fr, { soFar: day('mixed', 2) }), ['trend', 'up', 'Market state (3m): trend up: 3m CHoCH down then CHoCH up back (failed reversal; continuation up); 4h+1h up']);
  assert.deepStrictEqual(row(fr, { soFar: day('rotational', 2) }), ['chop', null, 'Market state (3m): chop: 3m CHoCH down then CHoCH up (back and forth); Day so far rotational; 4h+1h up']);
  assert.strictEqual(row(fr, { soFar: day('rotational', 2), pullback: pb() })[0], 'trend', 'an open Pullback line: never chop, the failed reversal');
  assert.strictEqual(row(fr, { soFar: day('mixed', 2), h4: 'range' })[0], 'trend', 'the break before known: the 3m trend, whatever the 4h + 1h');
  // Down trend -> CHoCH up -> CHoCH back down: a failed reversal, the trend down continues.
  assert.deepStrictEqual(row({ last: B('CHoCH', 'down', 36), previous: B('CHoCH', 'up', 24), before: B('BOS', 'down', 12) }, { h4: 'down', h1: 'down' }), ['trend', 'down', 'Market state (3m): trend down: 3m CHoCH up then CHoCH down back (failed reversal; continuation down); 4h+1h down']);
  // Bullish trend -> bearish CHoCH, no bearish BOS yet: the reversal unconfirmed: ranging.
  assert.deepStrictEqual(row({ last: B('CHoCH', 'down', 36), previous: B('BOS', 'up', 24) }, { soFar: day('rotational', 9) }), ['ranging', null, 'Market state (3m): ranging: 3m BOS up then CHoCH down (potential reversal, unconfirmed); 4h+1h up']);
  // Bearish trend -> bullish CHoCH, no bullish BOS yet: ranging.
  assert.deepStrictEqual(row({ last: B('CHoCH', 'up', 36), previous: B('BOS', 'down', 24) }), ['ranging', null, 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); 4h+1h up']);
  // Repeated CHoCH (CHoCH, BOS back, CHoCH, ... no confirming BOS the new way): the code's CHoCH, CHoCH, CHoCH:
  // unconfirmed: chop with its facts, else ranging.
  const rep = { last: B('CHoCH', 'up', 36), previous: B('CHoCH', 'down', 24), before: B('CHoCH', 'up', 12) };
  assert.deepStrictEqual(row(rep, { soFar: day('rotational', 2) }), ['chop', null, 'Market state (3m): chop: 3m CHoCH down then CHoCH up (back and forth); Day so far rotational; 4h+1h up']);
  assert.deepStrictEqual(row(rep, { soFar: day('mixed', 2) }), ['ranging', null, 'Market state (3m): ranging: 3m breaks alternating down, up (repeated potential reversals, none confirmed); 4h+1h up']);
  const repD = { last: B('CHoCH', 'down', 36), previous: B('CHoCH', 'up', 24), before: B('CHoCH', 'down', 12) };
  assert.strictEqual(row(repD, { soFar: day('mixed', 6) })[0], 'chop');
  assert.strictEqual(row(repD, { soFar: day('mixed', 4) })[0], 'ranging');
  // The break before not printed (an older record, the quiz's two-break lines): the trend before taken as the 4h + 1h way.
  const two = { last: B('CHoCH', 'up', 36), previous: B('CHoCH', 'down', 24) };
  assert.deepStrictEqual(row(two, { soFar: day('mixed', 2) }).slice(0, 2), ['trend', 'up'], 'back the aligned way: a failed reversal');
  assert.deepStrictEqual(row(two, { soFar: day('mixed', 2), h4: 'down', h1: 'down' }).slice(0, 2), ['ranging', null], 'against the aligned way: unconfirmed');
  assert.deepStrictEqual(row(two, { soFar: day('mixed', 2), h4: 'range' }).slice(0, 2), ['ranging', null], 'not aligned: unconfirmed');
  assert.strictEqual(row(two, { soFar: day('rotational', 9) })[0], 'chop', 'with the chop facts: chop');
  // Two bullish BOS; one bullish BOS; one bullish CHoCH alone.
  assert.strictEqual(row({ last: B('BOS', 'up', 36), previous: B('BOS', 'up', 24) })[2], 'Market state (3m): trend up: 3m BOS up (continuation); 4h+1h up');
  assert.strictEqual(row({ last: B('BOS', 'up', 36), previous: null })[2], 'Market state (3m): trend up: 3m BOS up (continuation); 4h+1h up');
  assert.strictEqual(row({ last: B('CHoCH', 'up', 36), previous: null })[2], 'Market state (3m): ranging: 3m CHoCH up (potential reversal, unconfirmed); 4h+1h up');
});
