'use strict';

// No look-ahead under a replay clock (scripts/lib/trading/look-ahead.js): which bars close after the
// clock, the cut a fetch makes, the refusal a reader makes, the bar briefing's check, and the replay
// clock every bars tool reads (harness-now.js replayAt). Live (no clock) nothing changes. Part of the
// no-look-ahead suite (tests/e2e/no-look-ahead.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stepOf, closesAfter, cutAtClock, refuseAfterClock, briefingAfterClock, LookAheadError } = require('../../scripts/lib/trading/look-ahead');
const { replayAt, ReplayClockError } = require('../../scripts/lib/trading/harness-now');
const { tmpDir } = require('../helpers');

const bar = (t, extra = {}) => ({ t, o: 1, h: 2, l: 0, c: 1, v: 1, ...extra });
// Four 3-minute bars: 14:00, 14:03, 14:06, 14:09 (closing 14:03, 14:06, 14:09, 14:12).
const BARS = ['2026-10-07T14:00:00.000Z', '2026-10-07T14:03:00.000Z', '2026-10-07T14:06:00.000Z', '2026-10-07T14:09:00.000Z'].map(t => bar(t));

test('stepOf: the smallest gap between the last bars, as the scan names the timeframe', () => {
  assert.strictEqual(stepOf(BARS), 180000);
  assert.strictEqual(stepOf({ bars: BARS }), 180000, 'get_bars output too');
  assert.strictEqual(stepOf([BARS[0]]), null);
  // Newest first (as a non-conforming file might be): the same step, so a forming bar is still after the clock.
  assert.strictEqual(stepOf(BARS.slice().reverse()), 180000);
  assert.deepStrictEqual(closesAfter(BARS.slice().reverse(), new Date('2026-10-07T14:10:00Z')).map(b => b.t), [BARS[3].t]);
  // An overnight break is longer: still 3 minutes.
  assert.strictEqual(stepOf([bar('2026-10-06T19:57:00Z'), bar('2026-10-06T22:00:00Z'), bar('2026-10-06T22:03:00Z')]), 180000);
});

test('closesAfter: a bar closes at its open plus the step; at the clock is closed, a millisecond later is not', () => {
  assert.deepStrictEqual(closesAfter(BARS, null), [], 'live: nothing is after a clock');
  assert.deepStrictEqual(closesAfter(BARS, undefined), []);
  assert.deepStrictEqual(closesAfter(BARS, new Date('2026-10-07T14:12:00Z')), [], 'the last bar closes at the clock: visible');
  assert.deepStrictEqual(closesAfter(BARS, Date.parse('2026-10-07T14:11:59.999Z')).map(b => b.t), [BARS[3].t], 'one ms early: the last bar is still forming');
  assert.deepStrictEqual(closesAfter(BARS, new Date('2026-10-07T14:06:02Z')).map(b => b.t), [BARS[2].t, BARS[3].t]);
  // An explicit step (a fetch knows its bar size): daily bars close a day after they open.
  const daily = [bar('2026-10-05T00:00:00Z'), bar('2026-10-06T00:00:00Z'), bar('2026-10-07T00:00:00Z')];
  assert.deepStrictEqual(closesAfter(daily, new Date('2026-10-07T14:00:00Z'), { stepMs: 864e5 }).map(b => b.t), ['2026-10-07T00:00:00Z'], 'today\'s daily bar has not closed');
  // A lone bar (no step known) opened after the clock is after it.
  assert.strictEqual(closesAfter([bar('2026-10-07T15:00:00Z')], new Date('2026-10-07T14:00:00Z')).length, 1);
  // `time` instead of `t` (as normalizeBars reads it); a bar with no readable time is no bar to the readers.
  assert.strictEqual(closesAfter([bar('2026-10-07T14:00:00Z'), { time: '2026-10-07T14:03:00Z', o: 1, h: 1, l: 1, c: 1 }], new Date('2026-10-07T14:04:00Z')).length, 1);
  assert.strictEqual(closesAfter([bar('nope'), ...BARS.slice(0, 2)], new Date('2026-10-07T14:06:00Z')).length, 0);
  assert.throws(() => closesAfter(BARS, new Date('x')), LookAheadError);
});

test('cutAtClock: keeps only the bars closed by the clock (what a fetch writes); live, the same array', () => {
  assert.strictEqual(cutAtClock(BARS, null), BARS);
  assert.deepStrictEqual(cutAtClock(BARS, new Date('2026-10-07T14:09:02Z')).map(b => b.t), BARS.slice(0, 3).map(b => b.t));
  assert.deepStrictEqual(cutAtClock(BARS, new Date('2026-10-07T14:10:00Z'), { stepMs: 60000 }).map(b => b.t), BARS.map(b => b.t), 'the step given wins');
  assert.deepStrictEqual(cutAtClock([bar('nope'), BARS[0]], new Date('2026-10-07T15:00:00Z')).map(b => b.t), [BARS[0].t], 'an unreadable bar is dropped');
});

test('refuseAfterClock: the bars when none is after the clock; else a refusal naming them and the remedy', () => {
  assert.strictEqual(refuseAfterClock(BARS, null), BARS, 'live: unchanged, whatever the bars');
  assert.strictEqual(refuseAfterClock(BARS, new Date('2026-10-07T14:12:00Z')), BARS);
  assert.throws(() => refuseAfterClock(BARS, new Date('2026-10-07T14:06:02Z'), { what: 'the bars file /x/MNQ-3m.json' }), err => err instanceof LookAheadError
    && /^the bars file \/x\/MNQ-3m\.json: 2 bar\(s\) close after the replay clock \(2026-10-07T14:06:02\.000Z\), the first at 2026-10-07T14:09:00\.000Z and the last at 2026-10-07T14:12:00\.000Z\. A replayed decision sees only bars closed by the clock \(no look-ahead\): use the runner's bars file or bars_fetch, which cut at the clock; not read$/.test(err.message));
});

test('briefingAfterClock: a briefing whose bar closed after the clock is never served under it', () => {
  const b = { closedAt: '2026-10-07T14:09:00.000Z' };
  assert.strictEqual(briefingAfterClock(b, null), null, 'live');
  assert.strictEqual(briefingAfterClock(null, new Date()), null);
  assert.strictEqual(briefingAfterClock(b, new Date('2026-10-07T14:09:02Z')), null);
  assert.match(briefingAfterClock(b, new Date('2026-10-07T14:08:59Z')), /its bar closed 2026-10-07T14:09:00\.000Z, after the replay clock \(2026-10-07T14:08:59\.000Z\)/);
  assert.match(briefingAfterClock({ closedAt: 'garbage' }, new Date('2026-10-07T14:08:59Z')), /after the replay clock/, 'an unreadable close is never shown before the clock');
});

test('replayAt: null live (the broker config is not even read), the replayed time with a replay broker, refused otherwise', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], replay: true }, real: { command: ['node', 'real.js'] } } }));
  assert.strictEqual(replayAt({ FTH_BROKERS_FILE: '/nonexistent/brokers.json' }), null);
  assert.strictEqual(replayAt({ FTH_HOME: home, FTH_REPLAY_NOW: '' }), null);
  assert.strictEqual(replayAt({ FTH_HOME: home, FTH_REPLAY_NOW: '2026-10-07T14:06:02Z' }).toISOString(), '2026-10-07T14:06:02.000Z');
  assert.throws(() => replayAt({ FTH_HOME: home, FTH_BROKER: 'real', FTH_REPLAY_NOW: '2026-10-07T14:06:02Z' }), err => err instanceof ReplayClockError && /not a replay broker/.test(err.message));
  assert.throws(() => replayAt({ FTH_HOME: home, FTH_REPLAY_NOW: 'tomorrow' }), ReplayClockError);
});
