'use strict';

// The Market state (scripts/lib/trading/market-state.js, feat/chop-read, MARKET-STATE-SPEC and the owner's words: "trend,
// chop, ranging"; "keep it simple and call it chop if it fails reversal"; "a 15m BOS could look like a 3m CHoCH followed by
// another CHoCH"; BOS is continuation, CHoCH a potential reversal, relative to the last break): what the 3m market is
// doing, the precedence applied once, printed as one summary line with the pullback read and the 4h + 1h beside it. A
// read, not a filter (tests/plugin/market-state-readers.test.js).

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../scripts/lib/trading/market-state');

const TH = { crossesChop: 5 };
const LEG = { origin: 21361.25, extreme: 21437.5 };
const pb = (o = {}) => ({ frame: '15m', side: 'long', leg: { ...LEG, atr: 4 }, depth: 0.28, pastOrigin: false, counter: { bars: 6 }, swing: {}, against: {}, ...o });
const T = m => new Date(Date.UTC(2026, 0, 6, 15, m)).toISOString(); // 10:mm ET (EST)
const brk = (kind, direction, level, m = 30) => ({ kind, direction, level, barsAgo: 2, at: T(m) });
const PAIR = { last: brk('CHoCH', 'up', 21558.25, 30), previous: brk('CHoCH', 'down', 21497.75, 18) };
const PAIR_DN = { last: brk('CHoCH', 'down', 21481.25, 30), previous: brk('CHoCH', 'up', 21500.75, 18) };
const ONE = { last: brk('CHoCH', 'up', 21512.25, 30), previous: brk('BOS', 'down', 21497.75, 18) };
const BOS_UP = { last: brk('BOS', 'up', 21566.25, 36), previous: brk('BOS', 'up', 21540.25, 18) };
const BOS_DN = { last: brk('BOS', 'down', 21470.25, 36), previous: brk('CHoCH', 'down', 21490.25, 18) };
const day = (read, vwapCrosses) => (read === 'too early' ? { status: 'too early', vwapCrosses } : { status: 'read', read, vwapCrosses });
// The briefing's CISD (cisdBlock): its confirming candle's close, confirmedClose.
const cisd = (dir, closed, status = 'waiting') => ({ '3m': { dir, level: 21550, confirmedClose: closed, status } });
const b = ({ h4 = 'up', h1 = 'up', m15, pullback, lastBreak, soFar, minutes = 3, m3 = {}, sections = {}, closedAt } = {}) => ({
  minutes, ...(closedAt ? { closedAt } : {}),
  sections: {
    h1: { data: { ...(h4 === 'none' ? {} : { h4: { trend: h4 } }), ...(h1 === 'none' ? {} : { h1: { trend: h1 } }) } },
    ...(m15 ? { m15: { data: { frame: { trend: m15 } } } } : {}),
    m3: { data: { ...(pullback === undefined ? {} : { pullback }), ...(lastBreak ? { lastBreak } : {}), ...(soFar ? { today: { soFar } } : {}), ...m3 } },
    ...sections,
  },
});
const S = o => M.stateOf(b(o), TH);
const st = o => S(o).state;
const word = o => M.classWordOf(S(o));
const line = o => M.marketStateLine(S(o));

test('the owner\'s words for the last two breaks: BOS a continuation, CHoCH a potential reversal; CHoCH then BOS confirmed; CHoCH then CHoCH a failed reversal', () => {
  assert.deepStrictEqual(M.readingOf(BOS_UP.last, BOS_UP.previous), { reading: '3m BOS up (continuation)', pair: false });
  assert.deepStrictEqual(M.readingOf(BOS_DN.last, BOS_DN.previous), { reading: '3m CHoCH down then BOS down (confirmed transition down)', pair: false });
  assert.deepStrictEqual(M.readingOf(ONE.last, ONE.previous), { reading: '3m BOS down then CHoCH up (potential reversal, unconfirmed)', pair: false });
  assert.deepStrictEqual(M.readingOf(PAIR.last, PAIR.previous), { reading: '3m CHoCH down then CHoCH up (failed reversal)', pair: true });
  assert.deepStrictEqual(M.readingOf(brk('CHoCH', 'up'), null), { reading: '3m CHoCH up (potential reversal, unconfirmed)', pair: false });
  assert.deepStrictEqual(M.readingOf(brk('BOS', 'up'), null), { reading: '3m BOS up (continuation)', pair: false });
  assert.deepStrictEqual(M.readingOf(null, null), { reading: '', pair: false });
});

test('chop = the CHoCH pair (a failed reversal), no pullback read, no 15m confirmation, no confirmed turn; rotational and the crosses are context only', () => {
  assert.strictEqual(st({ lastBreak: PAIR }), 'chop', 'the pair alone is chop');
  assert.strictEqual(line({ lastBreak: PAIR }), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (failed reversal); 4h+1h up');
  assert.strictEqual(line({ lastBreak: PAIR, soFar: day('rotational', 7) }), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (failed reversal); Day so far rotational, RTH VWAP crosses 7; 4h+1h up');
  assert.strictEqual(line({ lastBreak: PAIR, soFar: day('mixed', 4) }), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (failed reversal); 4h+1h up', 'crosses under the threshold: not printed');
  assert.strictEqual(line({ lastBreak: PAIR, soFar: day('too early', 6) }), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (failed reversal); RTH VWAP crosses 6; 4h+1h up');
  assert.strictEqual(st({ lastBreak: PAIR, h4: 'range' }), 'chop', 'aligned or not');
  assert.strictEqual(st({ lastBreak: ONE, soFar: day('rotational', 9) }), 'ranging', 'one CHoCH is never chop, rotational or not');
  assert.strictEqual(st({ soFar: day('rotational', 9) }), 'ranging', 'no break: ranging');
  assert.throws(() => M.stateOf(b({ lastBreak: PAIR }), {}), /crossesChop/, 'never a literal');
});

test('the pullback guard: no chop while a pullback read is active (an open Pullback line, or the early 15m read); the pair there is ranging', () => {
  assert.strictEqual(st({ lastBreak: PAIR, pullback: pb() }), 'ranging');
  assert.strictEqual(line({ lastBreak: PAIR, pullback: pb() }), 'Market state (3m): ranging: 3m CHoCH down then CHoCH up (inside the pullback: the watch); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(word({ lastBreak: PAIR, pullback: pb() }), 'trend-up');
  assert.strictEqual(st({ lastBreak: PAIR, pullback: pb({ side: 'short' }) }), 'ranging', 'any open Pullback line');
  assert.strictEqual(st({ lastBreak: PAIR, pullback: pb({ pastOrigin: true }) }), 'chop', 'a given-back line is not open');
  assert.strictEqual(st({ lastBreak: PAIR, pullback: pb({ pastOrigin: undefined, depth: 1.1 }) }), 'chop', 'an older record: depth >= 1 is given back');
  // The early read: 15m up, the pair ending down under 4h + 1h up (against them).
  assert.strictEqual(st({ lastBreak: PAIR_DN, m15: 'up' }), 'ranging');
  assert.strictEqual(word({ lastBreak: PAIR_DN, m15: 'up' }), 'trend-up');
  assert.strictEqual(st({ lastBreak: PAIR_DN, m15: 'range' }), 'chop', 'the 15m not trending their way: no read, no confirmation');
});

// Top-down (the owner: "A 15m BOS could look like a 3m CHoCH followed by another CHoCH"): the 3m pair is the 15m
// continuation when the 15m confirms the way it ends: its last break a BOS that way, known at or before the decision close,
// or its frame trending that way. With the 15m ranging or breaking the other way: chop.
test('the 15m guard: a 3m CHoCH pair ending the way the 15m breaks (a BOS known by the close) or trends is the 15m continuation, not chop', () => {
  const m15 = (last, trend = 'range') => ({ m15: { data: { frame: { trend }, lastBreak: { last, previous: null } } } });
  const bos15 = (dir, knownAt, kind = 'BOS') => ({ kind, direction: dir, level: 21540, at: T(15), knownAt });
  const at = (o, closedAt) => M.stateOf(b({ ...o, closedAt }), TH);
  const up = at({ lastBreak: PAIR, sections: m15(bos15('up', T(30))) });
  assert.deepStrictEqual([up.state, up.way, M.classWordOf(up)], ['trend', 'up', 'trend-up']);
  assert.strictEqual(M.marketStateLine(up), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up = the 15m BOS up (continuation); 4h+1h up');
  const tr = at({ lastBreak: PAIR, sections: m15(null, 'up') });
  assert.deepStrictEqual([tr.state, M.marketStateLine(tr)], ['trend', 'Market state (3m): trend up: 3m CHoCH down then CHoCH up = the 15m trend up (continuation); 4h+1h up']);
  assert.strictEqual(at({ lastBreak: PAIR, sections: m15(null, 'range') }).state, 'chop', 'the 15m ranging: chop');
  assert.strictEqual(at({ lastBreak: PAIR, sections: m15(bos15('down', T(30)), 'down') }).state, 'chop', 'the 15m breaking the other way: chop');
  assert.strictEqual(at({ lastBreak: PAIR, sections: m15(bos15('up', T(30), 'CHoCH')) }).state, 'chop', 'a 15m CHoCH up is no BOS');
  assert.strictEqual(at({ lastBreak: PAIR, sections: m15(bos15('up', T(45))) }, T(40)).state, 'chop', 'a 15m BOS known after the close is never read (causal)');
  assert.strictEqual(at({ lastBreak: PAIR, sections: m15(bos15('up', T(39))) }, T(40)).state, 'trend', 'known by the close');
  assert.strictEqual(at({ lastBreak: PAIR_DN, h4: 'down', h1: 'down', sections: m15(bos15('down', T(30))) }).way, 'down', 'the mirror');
  assert.strictEqual(M.classWordOf(at({ lastBreak: PAIR, h4: 'down', h1: 'down', sections: m15(null, 'up') })), 'unclear', 'a 15m continuation up under 4h + 1h down: never counter');
});

test('trend: the last break a BOS (a continuation, or a confirmed transition), or a CHoCH confirmed by a live 3m CISD on a later candle; it ends a chop (causal)', () => {
  assert.deepStrictEqual([st({ lastBreak: BOS_UP }), S({ lastBreak: BOS_UP }).way], ['trend', 'up']);
  assert.deepStrictEqual([st({ lastBreak: BOS_DN }), S({ lastBreak: BOS_DN }).way], ['trend', 'down'], 'a 3m trend against the 4h + 1h is still the 3m trend');
  const c = closed => ({ lastBreak: PAIR, m3: { cisd: cisd('bullish', closed) } });
  assert.deepStrictEqual([st(c(T(36))), S(c(T(36))).way], ['trend', 'up']);
  assert.strictEqual(line(c(T(36))), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up (failed reversal), then a 3m CISD up (confirmed); the chop ended; 4h+1h up');
  assert.strictEqual(st(c(T(33))), 'chop', 'closed with the CHoCH\'s own candle (opened 10:30, closed 10:33): not after it');
  assert.strictEqual(st(c(T(27))), 'chop', 'before the CHoCH');
  assert.strictEqual(st({ lastBreak: PAIR, m3: { cisd: cisd('bearish', T(36)) } }), 'chop', 'the other way');
  for (const x of ['void', 'expired', 'weak']) assert.strictEqual(st({ lastBreak: PAIR, m3: { cisd: cisd('bullish', T(36), x) } }), 'chop', `a ${x} CISD is dead`);
  for (const x of ['touched', 'bounced']) assert.strictEqual(st({ lastBreak: PAIR, m3: { cisd: cisd('bullish', T(36), x) } }), 'trend', `a ${x} CISD is live`);
  assert.strictEqual(st({ lastBreak: PAIR, m3: { cisd: { '3m': 'none in these bars' } } }), 'chop');
  assert.strictEqual(line({ lastBreak: ONE, m3: { cisd: cisd('bullish', T(36)) } }), 'Market state (3m): trend up: 3m BOS down then CHoCH up (potential reversal, unconfirmed), then a 3m CISD up (confirmed); 4h+1h up', 'one CHoCH confirmed: no chop to end');
  assert.strictEqual(word({ ...c(T(36)), h4: 'range' }), 'unclear', 'the turn never overrides the alignment');
  assert.strictEqual(word({ ...c(T(36)), h4: 'down', h1: 'down' }), 'unclear', 'a trend up under 4h + 1h down: unclear, never counter');
});

test('a CHoCH and a close beyond the initial balance it rotated in: trend; the IB complete, the previous break inside it', () => {
  const ib = { ibHigh: 21560, ibLow: 21480 };
  const at = (price, today = ib, o = {}) => ({ lastBreak: PAIR, ...o, m3: { price, today: { ...today, soFar: day('rotational', 7) } } });
  assert.strictEqual(line(at(21563.25)), 'Market state (3m): trend up: 3m CHoCH down then CHoCH up (failed reversal), then a close above the IB high 21560 (confirmed); the chop ended; 4h+1h up');
  assert.strictEqual(line(at(21559.75)), 'Market state (3m): chop: 3m CHoCH down then CHoCH up (failed reversal); Day so far rotational, RTH VWAP crosses 7; 4h+1h up', 'inside the range');
  assert.strictEqual(st(at(21563.25, { ibHigh: null, ibLow: null })), 'chop', 'the IB not complete: before 10:30 only a BOS or CISD ends it');
  const above = { last: brk('CHoCH', 'up', 21570.25, 30), previous: brk('CHoCH', 'down', 21562.75, 18) };
  assert.strictEqual(st(at(21573.25, ib, { lastBreak: above })), 'chop', 'both breaks beyond the IB: a new chop there');
  const down = { last: brk('CHoCH', 'down', 21562.25, 30), previous: brk('CHoCH', 'up', 21540.75, 18) };
  assert.strictEqual(st(at(21561.25, ib, { lastBreak: down })), 'chop', 'above the IB but the last break down');
  assert.strictEqual(line(at(21477.75, ib, { lastBreak: PAIR_DN, h4: 'down', h1: 'down' })), 'Market state (3m): trend down: 3m CHoCH up then CHoCH down (failed reversal), then a close below the IB low 21480 (confirmed); the chop ended; 4h+1h down');
});

// The structure audit (2026-11-15): at 28% of decision bars the previous break was a premarket drift. The RTH state pair
// reads only breaks whose candle closed at or after 09:30 ET; before the second RTH break: ranging, not enough structure.
test('the RTH pair: breaks closed before 09:30 ET do not count; fewer than two RTH breaks: ranging (not enough RTH structure)', () => {
  const pre = { kind: 'CHoCH', direction: 'down', level: 21497.75, barsAgo: 30, at: new Date(Date.UTC(2026, 0, 6, 14, 15)).toISOString() }; // 09:15 ET
  const S2 = (lastBreak, closedAt = T(40)) => M.stateOf(b({ lastBreak, closedAt }), TH);
  const one = S2({ last: PAIR.last, previous: pre });
  assert.deepStrictEqual([one.state, M.marketStateLine(one)], ['ranging', 'Market state (3m): ranging: 3m CHoCH up (potential reversal, unconfirmed), the only RTH break (not enough RTH structure); 4h+1h up']);
  const none = S2({ last: { ...pre, kind: 'BOS' }, previous: pre });
  assert.strictEqual(M.marketStateLine(none), 'Market state (3m): ranging: no RTH 3m break yet (not enough RTH structure); 4h+1h up');
  assert.strictEqual(S2(PAIR).state, 'chop', 'both in RTH: the pair counts');
  const bosFirst = S2({ last: BOS_UP.last, previous: pre });
  assert.deepStrictEqual([bosFirst.state, M.marketStateLine(bosFirst)], ['ranging', 'Market state (3m): ranging: 3m BOS up (continuation), the only RTH break (not enough RTH structure); 4h+1h up'], 'one RTH BOS is not yet a trend');
  const edge = { kind: 'CHoCH', direction: 'down', level: 21497.75, barsAgo: 20, at: new Date(Date.UTC(2026, 0, 6, 14, 27)).toISOString() }; // closed 09:30
  assert.strictEqual(S2({ last: PAIR.last, previous: edge }).state, 'chop', 'closed at 09:30: an RTH break');
  const prior = { last: { ...PAIR.last, at: new Date(Date.UTC(2026, 0, 5, 15, 30)).toISOString() }, previous: { ...PAIR.previous, at: new Date(Date.UTC(2026, 0, 5, 15, 18)).toISOString() } };
  assert.strictEqual(S2(prior, new Date(Date.UTC(2026, 0, 6, 5, 45)).toISOString()).state, 'ranging', 'overnight: yesterday\'s RTH breaks are not this trading day\'s');
});

test('the trend facts print the age of the last BOS (the model reads it; never demoted in code)', () => {
  const s = M.stateOf(b({ lastBreak: BOS_UP, closedAt: T(75) }), TH);
  assert.deepStrictEqual([s.state, s.age], ['trend', 36]);
  assert.strictEqual(M.marketStateLine(s), 'Market state (3m): trend up: 3m BOS up (continuation), 36 min ago; 4h+1h up');
  assert.strictEqual(M.marketStateLine(M.stateOf(b({ lastBreak: BOS_DN, closedAt: T(39) }), TH)), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down), 0 min ago; 4h+1h up');
});

test('ranging prints its 3m breaks and whether price is inside the complete IB; the alignment printed, not aligned named', () => {
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21512, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); inside the IB 21480-21540; 4h+1h up');
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21475, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); 4h+1h up');
  assert.strictEqual(line({ lastBreak: ONE, m3: { price: 21545, today: { ibHigh: 21540, ibLow: 21480 } } }), 'Market state (3m): trend up: 3m BOS down then CHoCH up (potential reversal, unconfirmed), then a close above the IB high 21540 (confirmed); 4h+1h up', 'a close above the IB: a confirmed turn');
  assert.strictEqual(line({}), 'Market state (3m): ranging: no 3m break printed; 4h+1h up');
  assert.strictEqual(line({ h4: 'range' }), 'Market state (3m): ranging: no 3m break printed; 4h range, 1h up (not aligned)');
  assert.strictEqual(line({ h4: 'none' }), 'Market state (3m): ranging: no 3m break printed; 4h unknown, 1h up (not aligned)');
});

test('the pullback read is no state: printed under trend or ranging; the open line supersedes the early read', () => {
  assert.strictEqual(line({ lastBreak: BOS_UP, pullback: pb() }), 'Market state (3m): trend up: 3m BOS up (continuation); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(line({ lastBreak: ONE, pullback: pb({ leg: { ...LEG, atr: 0.5 } }) }), 'Market state (3m): ranging: 3m BOS down then CHoCH up (potential reversal, unconfirmed); pullback (long leg 21361.25 -> 21437.5, small leg); 4h+1h up');
  assert.strictEqual(line({ lastBreak: BOS_UP, pullback: pb({ pastOrigin: true }) }), 'Market state (3m): trend up: 3m BOS up (continuation); 4h+1h up', 'given back: no read');
  const e = { lastBreak: BOS_DN, m15: 'up' };
  assert.deepStrictEqual([st(e), word(e)], ['trend', 'trend-up'], 'the owner: 15m up, 3m down could mean pullback');
  assert.strictEqual(line(e), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); 15m up: a pullback in the 15m trend; 4h+1h up');
  assert.strictEqual(line({ ...e, pullback: pb() }), 'Market state (3m): trend down: 3m CHoCH down then BOS down (confirmed transition down); pullback (long leg 21361.25 -> 21437.5, depth 28%); 4h+1h up');
  assert.strictEqual(S({ ...e, h4: 'range' }).early, false, 'no alignment: no read');
  assert.strictEqual(S({ lastBreak: BOS_UP, m15: 'up' }).early, false, 'the 3m with the trend: no pullback');
});

test('classWordOf: chop -> chop; not aligned -> unclear; a pullback read their way -> that trend class; trend their way or ranging under them -> that trend class; a 3m trend against with no pullback read -> unclear (never counter)', () => {
  assert.strictEqual(word({ lastBreak: PAIR }), 'chop');
  assert.strictEqual(word({ lastBreak: PAIR, h4: 'range' }), 'chop');
  assert.strictEqual(word({ lastBreak: BOS_UP }), 'trend-up');
  assert.strictEqual(word({ lastBreak: BOS_DN, h4: 'down', h1: 'down' }), 'trend-down');
  assert.strictEqual(word({ lastBreak: ONE }), 'trend-up', 'ranging under an aligned 4h + 1h');
  assert.strictEqual(word({}), 'trend-up');
  // The audit's 66 moments (3.3%): aligned, the 3m trend against, no Pullback line, no 15m-trend read: unclear.
  assert.strictEqual(word({ lastBreak: BOS_DN }), 'unclear');
  assert.strictEqual(word({ lastBreak: BOS_DN, m15: 'range' }), 'unclear');
  assert.strictEqual(word({ lastBreak: BOS_UP, h4: 'range' }), 'unclear', 'not aligned');
  // The q101 shape (decision (b)): an open long Pullback, the last 3m break a BOS down: the pullback, not a trend down.
  assert.deepStrictEqual([st({ lastBreak: BOS_DN, pullback: pb() }), word({ lastBreak: BOS_DN, pullback: pb() })], ['trend', 'trend-up']);
  assert.strictEqual(word({ lastBreak: BOS_DN, pullback: pb(), h4: 'down', h1: 'down' }), 'trend-down');
  assert.strictEqual(word({ lastBreak: BOS_UP, pullback: pb({ side: 'short' }) }), 'trend-up', 'a short leg under 4h + 1h up: the 3m trend up decides');
  assert.strictEqual(word({ lastBreak: BOS_DN, pullback: pb(), h4: 'range' }), 'unclear');
  assert.strictEqual(M.classWordOf(null), null);
});

// The audit's finding A: the unit tests passed a CISD field the briefing never has. Here the CISD is the real briefing's.
test('turnOf reads the real briefing\'s CISD (cisdBlock: confirmedClose), not a field it lacks', () => {
  const path = require('path');
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
  let found = null;
  for (let n = 400; n < bars.length && !found; n += 25) {
    const br = B.buildBriefing({ symbol: 'NQ', bars: bars.slice(0, n), minutes: 3 });
    const c = br.sections.m3.data.cisd && br.sections.m3.data.cisd['3m'];
    if (c && typeof c === 'object' && !['void', 'expired', 'weak'].includes(c.status)) found = c;
  }
  assert.ok(found, 'a live 3m CISD in the fixture');
  assert.ok('confirmedClose' in found && !('confirmedAt' in found), 'the briefing carries confirmedClose');
  const dir = { bullish: 'up', bearish: 'down' }[found.dir];
  const before = { kind: 'CHoCH', direction: dir, level: 1, at: new Date(Date.parse(found.confirmedClose) - 4 * 180000).toISOString() };
  assert.deepStrictEqual(M.turnOf({ last: before, previous: null, cisd3m: found, minutes: 3 }), { by: 'cisd', dir });
  const same = { ...before, at: new Date(Date.parse(found.confirmedClose) - 180000).toISOString() };
  assert.strictEqual(M.turnOf({ last: same, previous: null, cisd3m: found, minutes: 3 }), null, 'the CHoCH\'s own candle');
});

test('stateOf: off the entry lane or without a 1h part: null; readState has no lane guard; never the Bias line\'s word', () => {
  assert.strictEqual(M.stateOf(b({ minutes: 15 }), TH), null);
  assert.strictEqual(M.stateOf({ minutes: 3, sections: {} }, TH), null);
  assert.strictEqual(M.stateOf(null, TH), null);
  assert.strictEqual(M.readState({ sections: { h1: { data: {} } } }, TH).state, 'ranging');
  assert.strictEqual(M.marketStateLine(null), null);
  for (const o of [{}, { pullback: pb() }, { h4: 'range' }, { lastBreak: PAIR }]) assert.doesNotMatch(line(o), /\bside\b/);
});

// One threshold value, two homes (PREREG addendum 14, D1): the line prints the crosses at the briefing's
// config/analysis.json regime.rangeCrosses; the recognition key passes its frozen signals.crossesChop; they stay equal.
test('the briefing\'s crosses threshold equals the recognition key\'s', () => {
  const { analysis } = require('../../scripts/lib/tunables');
  const rec = require('../../config/recognition.json');
  assert.strictEqual(analysis().regime.rangeCrosses, rec.signals.crossesChop);
});
