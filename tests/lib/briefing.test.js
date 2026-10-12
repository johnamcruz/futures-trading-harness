'use strict';

// The bar briefing (trading/briefing.js): the analysis by timeframe, each part kept until its
// timeframe's next close or a close through one of its levels, with a version that changes only
// when the part is recomputed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { barBriefing } = require('../../scripts/lib/harness-tools/briefing');
const { tmpDir } = require('../helpers');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const at = n => BARS.slice(0, n);
const build = (n, prev = null, extra = {}) => B.buildBriefing({ symbol: 'NQ', bars: at(n), minutes: 3, prev, ...extra });

test('nextClose: candles from the 18:00 ET session open; sessionWindow: the session-timing skill\'s windows', () => {
  // 2026-06-01 14:57Z is 10:57 ET (EDT): the 15m candle closes 11:00 ET, the 1h at 11:00 ET, the 3m at 11:00 ET.
  const t = new Date('2026-06-01T14:57:00Z');
  assert.strictEqual(B.nextClose(t, 15).toISOString(), '2026-06-01T15:00:00.000Z');
  assert.strictEqual(B.nextClose(new Date('2026-06-01T15:00:00Z'), 15).toISOString(), '2026-06-01T15:15:00.000Z', 'a close at the boundary starts the next candle');
  assert.strictEqual(B.nextClose(new Date('2026-06-01T15:01:00Z'), 60).toISOString(), '2026-06-01T16:00:00.000Z');
  // 4h candles from 18:00 ET: 18, 22, 02, 06, 10, 14 ET; at 10:57 ET the next close is 14:00 ET.
  assert.strictEqual(B.nextClose(t, 240).toISOString(), '2026-06-01T18:00:00.000Z');
  assert.deepStrictEqual(B.sessionWindow(t), { name: 'opening drive', until: new Date('2026-06-01T15:00:00Z') });
  assert.strictEqual(B.sessionWindow(new Date('2026-06-01T16:00:00Z')).name, 'lunch lull');
  assert.strictEqual(B.sessionWindow(new Date('2026-06-01T20:30:00Z')).name, 'daily break (closed)');
});

test('a section is kept, same version, until its timeframe\'s next close; then recomputed as expired', () => {
  const first = build(1300);
  for (const name of B.SECTIONS) assert.strictEqual(first.sections[name].reason, 'new', name);
  let prev = first;
  const changes = { m3: 0, m15: 0 };
  for (let n = 1301; n <= 1320; n += 1) {
    const b = build(n, prev);
    // m3 is recomputed every bar; every kept section is the previous one, untouched.
    assert.notStrictEqual(b.sections.m3.version, prev.sections.m3.version);
    for (const name of B.SECTIONS) {
      if (b.sections[name].version === prev.sections[name].version) assert.deepStrictEqual(b.sections[name], prev.sections[name]);
      else if (name !== 'm3') {
        changes[name] = (changes[name] || 0) + 1;
        // A recomputed section says why: its time ran out, or one of its levels or a spike broke it.
        assert.match(b.sections[name].reason, /^(expired|a close through the |a bar range of )/);
        if (b.sections[name].reason === 'expired') assert.ok(Date.parse(prev.sections[name].validUntil) <= Date.parse(b.closedAt));
      }
      assert.ok(Date.parse(b.sections[name].validUntil) > Date.parse(b.closedAt), `${name} holds past this bar`);
    }
    prev = b;
  }
  // 20 bars of 3 minutes span four 15m closes.
  assert.ok(changes.m15 >= 4, `m15 refreshed ${changes.m15} times`);
});

test('sections change only on expiry: no early recompute, so a version holds until its timeframe\'s next close', () => {
  // A bar whose next bar is inside the same 15m and 1h candle: nothing expires, and even a wild previous close or a
  // range spike changes nothing (m15 and h1 read completed candles only; what moves with price is in m3).
  let n = 1300;
  while (Date.parse(build(n).sections.m15.validUntil) <= Date.parse(build(n + 1).closedAt) || Date.parse(build(n).sections.h1.validUntil) <= Date.parse(build(n + 1).closedAt)) n += 1;
  const prev = build(n);
  const bars = at(n + 1).map(x => ({ ...x }));
  const last = bars[bars.length - 1];
  last.h = last.c + 500; last.l = last.c - 500;
  const next = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, prev: { ...prev, price: prev.price + 1000 } });
  for (const s of ['m15', 'h1', 'day']) assert.strictEqual(next.sections[s].version, prev.sections[s].version, s);
  assert.notStrictEqual(next.sections.m3.version, prev.sections.m3.version);
  assert.strictEqual(next.sections.m3.data.bar.rangeAtr > 2, true, 'the spike shows in m3');
});

test('another symbol, bar size, or an older briefing is never reused', () => {
  const prev = build(1300);
  for (const p of [{ ...prev, symbol: 'ES' }, { ...prev, minutes: 1 }, { ...prev, closedAt: '2099-01-01T00:00:00.000Z' }]) {
    const b = build(1301, p);
    for (const name of B.SECTIONS) assert.strictEqual(b.sections[name].reason, 'new', name);
  }
});

test('m3 holds the per-bar facts: ET time and window, VWAP side, location against the cached levels, the scan\'s candidates', () => {
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: ['bos'], against: [] }, entryRef: 1, stopDistance: 10, exit: { trailActivateR: 2 } }, { name: 'bos', candidate: false }];
  const b = build(1300, null, { scan });
  const d = b.sections.m3.data;
  assert.match(d.et, /^\d{2}:\d{2}$/);
  assert.ok(B.WINDOWS.some(w => w[2] === d.window));
  assert.ok(['above', 'below'].includes(d.vwap.side));
  assert.ok(['above', 'below', 'at'].includes(d.priceVsEma9));
  assert.deepStrictEqual(d.candidates.map(c => [c.name, c.direction, c.status, c.confluence]), [['orb', 'long', 'active', { with: ['bos'], against: [] }]]);
  assert.match(d.trendRule, /^Trend rule:/);
  assert.ok('priorValue' in d.location && 'initialBalance' in d.location);
  // The cached sections hold levels, never where price is (that moves every bar).
  assert.doesNotMatch(JSON.stringify([b.sections.m15.data.sessionProfile, b.sections.day.data.priorProfile]), /"price"/);
});

test('render, write, read, and the bar_briefing tool', () => {
  const home = tmpDir();
  const b = build(1300);
  B.writeBriefing(home, b);
  assert.deepStrictEqual(B.readBriefing(home, 'MNQ'), JSON.parse(JSON.stringify(b)), 'MNQ and NQ share one briefing');
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  for (const name of B.SECTIONS) assert.match(text, new RegExp(`\\[${name}\\] version ${name}@`));
  assert.match(text, /reuse it, don't recompute/);
  assert.match(B.renderBriefing(b, { now: new Date('2099-01-01T00:00:00Z') }), /EXPIRED/);
  const env = { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt };
  assert.match(barBriefing({ symbol: 'NQ' }, { env }).text, /^Bar briefing NQ 3m/);
  assert.deepStrictEqual(JSON.parse(barBriefing({ symbol: 'NQ', json: true }, { env }).text).sections.m3.version, b.sections.m3.version);
  assert.match(barBriefing({ symbol: 'ES' }, { env }).text, /^No bar briefing for ES: .*Take the market facts from the bars yourself/);
  assert.throws(() => barBriefing({ symbol: '../x' }, { env }), /--symbol/);
  fs.writeFileSync(B.briefingFile(home, 'ES'), '{not json');
  assert.strictEqual(B.readBriefing(home, 'ES'), null);
});

test('every expiry is right: on every bar, a reused section equals a fresh computation of it (nothing in it changed while it held)', () => {
  let prev = null;
  const stale = {};
  let kept = 0;
  for (let n = 100; n <= BARS.length; n += 1) {
    const b = build(n, prev);
    const f = build(n);
    for (const s of B.SECTIONS) {
      if (!prev || b.sections[s].version !== prev.sections[s].version) continue;
      kept += 1;
      for (const [k, v] of Object.entries(b.sections[s].data)) if (JSON.stringify(v) !== JSON.stringify(f.sections[s].data[k])) stale[`${s}.${k}`] = (stale[`${s}.${k}`] || 0) + 1;
    }
    prev = b;
  }
  assert.ok(kept > 3000, `${kept} sections reused`);
  assert.deepStrictEqual(stale, {}, 'a value held past the point it changed: it belongs in a section with a shorter clock');
});

test('expiry instants: m3 one bar, m15 and h1 their candle\'s close, day the first bar after the 16:00 ET RTH close', () => {
  const b = build(1300);
  const closed = Date.parse(b.closedAt);
  assert.strictEqual(Date.parse(b.sections.m3.validUntil), closed + 180000);
  assert.strictEqual(b.sections.m15.validUntil, B.nextClose(new Date(closed), 15).toISOString());
  assert.strictEqual(b.sections.h1.validUntil, B.nextClose(new Date(closed), 60).toISOString());
  // The bar opening 15:57 ET closes 16:00: the prior RTH day rolls on the next bar (16:00-16:03), so it holds until 16:03.
  const open = new Date('2026-06-01T19:57:00Z'); // 15:57 EDT
  assert.strictEqual(B.nextRthRoll(open, 3).toISOString(), '2026-06-01T20:03:00.000Z');
  assert.strictEqual(B.nextRthRoll(new Date('2026-06-01T20:00:00Z'), 3).toISOString(), '2026-06-02T20:03:00.000Z', 'the 16:00 bar itself: tomorrow\'s');
  assert.strictEqual(B.nextRthRoll(new Date('2026-06-01T14:00:00Z'), 3).toISOString(), '2026-06-01T20:03:00.000Z');
});

test('m3: the VWAP side against the VWAP that applies (RTH in RTH), never "above" for a missing VWAP; a failed scan is unknown, not "nothing fired"', () => {
  for (let n = 1200; n < 1300; n += 7) {
    const d = build(n).sections.m3.data;
    const ref = d.vwap.applies === 'rth' ? d.vwap.rth : d.vwap.session;
    if (ref === null) assert.strictEqual(d.vwap.side, null);
    else assert.strictEqual(d.vwap.side, d.price > ref ? 'above' : d.price < ref ? 'below' : 'at', `bar ${n}`);
    // The side agrees with the sign of the distance in ATR (both from the same VWAP).
    if (d.vwap.distanceAtr > 0) assert.strictEqual(d.vwap.side, 'above');
    if (d.vwap.distanceAtr < 0) assert.strictEqual(d.vwap.side, 'below');
    const pv = d.location.priorValue;
    if (pv) assert.ok(['below', 'inside', 'above'].includes(pv));
  }
  const failed = build(1300, null, { scan: null, scanError: 'rules engine down' }).sections.m3.data;
  assert.strictEqual(failed.candidates, null);
  assert.strictEqual(failed.scanError, 'rules engine down');
  assert.deepStrictEqual(build(1300, null, { scan: [] }).sections.m3.data.candidates, []);
});

test('an old briefing is never served as this bar\'s; a failed build removes the file', () => {
  const home = tmpDir();
  const b = build(1300);
  B.writeBriefing(home, b);
  assert.ok(B.current(b, new Date(b.closedAt)));
  assert.ok(!B.current(b, new Date(b.sections.m3.validUntil)));
  const old = barBriefing({ symbol: 'NQ' }, { env: { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: '2099-01-01T00:00:00Z' } }).text;
  assert.match(old, /^The bar briefing for NQ is old \(its bar closed .*\): no current briefing\. Take the market facts from the bars yourself/);
  assert.doesNotMatch(old, /\[m3\]/);
  const { briefingRecorder } = require('../../scripts/lib/runner-wiring');
  const record = briefingRecorder(home, { timeframe: 3 }, () => new Date(b.closedAt));
  assert.throws(() => record({ symbol: 'NQ', bars: [] }, []), /need closed bars/);
  assert.strictEqual(B.readBriefing(home, 'NQ'), null, 'the earlier bar\'s briefing is gone');
  // The runner's step writes this bar's briefing from the bars it hands the cycle.
  record({ symbol: 'NQ', bars: at(1300) }, [], null);
  assert.strictEqual(B.readBriefing(home, 'NQ').sections.m3.version, b.sections.m3.version);
  // A config that can't be read: the news is unknown (the gate fails closed on it too), never "no blackout".
  const broken = new Proxy({}, { get() { throw new Error('config unreadable'); } });
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', entryRef: 1, stopDistance: 10, mtf: { style: 'trend', longAllowed: true }, confluence: { with: [], against: [] }, exit: {} }];
  const home2 = tmpDir();
  briefingRecorder(home2, { timeframe: 3 }, () => new Date(b.closedAt), broken)({ symbol: 'NQ', bars: at(1300) }, scan, null);
  const m3 = B.readBriefing(home2, 'NQ').sections.m3.data;
  assert.strictEqual(m3.news.inBlackout, null);
  assert.match(m3.news.error, /config unreadable/);
  assert.strictEqual(m3.candidates[0].blocked, 'news unknown (the blackouts file can\'t be read)');
});

test('the day section built on the 15:57 ET bar ends on the 16:03 bar; one built on the 16:00 bar holds to tomorrow\'s', () => {
  // Find the fixture's bars opening 15:57 and 16:00 ET, and check a fresh build's day expiry through buildBriefing.
  const et = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const i = BARS.findIndex((x, k) => k > 300 && et(x.t) === '15:57');
  assert.ok(i > 0 && et(BARS[i + 1].t) === '16:00', 'the fixture has the 15:57 and 16:00 bars');
  const at1557 = build(i + 1);
  assert.strictEqual(Date.parse(at1557.sections.day.validUntil), Date.parse(BARS[i + 1].t) + 3 * 60000, 'until the 16:00 bar closes (16:03)');
  const at1600 = build(i + 2);
  assert.ok(Date.parse(at1600.sections.day.validUntil) - Date.parse(BARS[i + 1].t) > 20 * 3600000, 'the next day\'s roll');
  assert.notDeepStrictEqual(at1600.sections.day.data.priorRth, at1557.sections.day.data.priorRth, 'the prior day rolled on the 16:00 bar');
});

test('in a cycle, the briefing is current exactly when it is for the bar the cycle decides (FTH_CYCLE_BARS), however long the cycle runs', () => {
  const home = tmpDir();
  const b = build(1300);
  B.writeBriefing(home, b);
  const late = '2099-01-01T00:00:00Z';
  const env = bars => ({ FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: late, FTH_CYCLE_BARS: JSON.stringify(bars) });
  // The cycle's own bar, an hour or a year later: still this cycle's briefing (MNQ and NQ are one family).
  const inCycle = barBriefing({ symbol: 'NQ' }, { env: env({ MNQ: b.asOf }) }).text;
  assert.match(inCycle, /^Bar briefing NQ 3m/);
  assert.doesNotMatch(inCycle, /EXPIRED/, 'rendered as of the cycle\'s bar: nothing reads as expired while the cycle decides it');
  // Another bar: old.
  assert.match(barBriefing({ symbol: 'NQ' }, { env: env({ NQ: '2026-01-01T00:00:00.000Z' }) }).text, /is old/);
  // Outside a cycle (or a cycle without this symbol), the clock decides.
  assert.match(barBriefing({ symbol: 'NQ' }, { env: env({ ES: b.asOf }) }).text, /is old/);
  const { childEnv, validateConfig } = require('../../scripts/lib/autotrader');
  const ctx = { symbols: [{ symbol: 'MNQ', bar: { t: b.asOf } }, { symbol: 'MES', bar: { t: '2026-01-01T00:00:00.000Z' } }] };
  assert.deepStrictEqual(JSON.parse(childEnv(validateConfig({}), '/r', { FTH_HOME: home }, ctx).FTH_CYCLE_BARS), { MNQ: b.asOf, MES: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(childEnv(validateConfig({}), '/r', { FTH_HOME: home, FTH_CYCLE_BARS: '{"MNQ":"x"}' }).FTH_CYCLE_BARS, undefined, 'never a stale one');
});

test('the briefing carries the structure events the analysts report: the latest BOS or CHoCH per timeframe with its age, sweeps, swings against price', () => {
  const b = build(1300);
  for (const s of ['m3', 'm15', 'h1']) {
    const lb = b.sections[s].data.lastBreak;
    assert.ok(lb && 'last' in lb && 'previous' in lb, s);
    if (lb.last) assert.ok(['BOS', 'CHoCH'].includes(lb.last.kind) && Number.isInteger(lb.last.barsAgo) && lb.last.barsAgo >= 0, s);
  }
  const d = b.sections.m3.data;
  for (const x of d.sweeps) assert.ok(['high', 'low'].includes(x.side) && x.name && Number.isFinite(x.price) && x.bars >= 1 && x.bars <= 3);
  // The 15m and 1h swings against price: still holding ones on their true side, and at most one broken per timeframe.
  for (const x of d.htfLevels) {
    assert.strictEqual(x.side, d.price > x.price ? 'below' : d.price < x.price ? 'above' : 'at');
  }
  for (const tf of ['15m', '1h']) assert.ok(d.htfLevels.filter(x => x.name.startsWith(tf) && x.brokenAt).length <= 1, tf);
  assert.ok(Array.isArray(d.untested1hSwings));
});

test('distances are in R: 1R is a setup\'s own stop, else the reference stop (0.5 x ATR(20)); the three nearest levels each side; a candidate\'s level in its way', () => {
  const d = build(1300).sections.m3.data;
  assert.strictEqual(d.oneR.points, d.referenceStop.distance);
  const { above, below } = d.nearestLiquidity;
  assert.ok(above.length <= 3 && below.length <= 3 && above.length + below.length > 0);
  for (const x of above) assert.ok(x.price > d.price && Math.abs(x.R - x.points / d.oneR.points) < 0.02);
  for (const x of below) assert.ok(x.price < d.price && Math.abs(x.R - x.points / d.oneR.points) < 0.02);
  for (let k = 1; k < above.length; k += 1) assert.ok(above[k].price >= above[k - 1].price, 'nearest first');
  // An equal-highs pool price already traded through is never a level in the way.
  for (const x of [...above, ...below]) if (x.name === 'equal highs') assert.ok(d.liquidity.equalHighs.some(p => p.price === x.price && !p.taken));
  // A candidate's level in its way, in its own R.
  const c = build(1300, null, { scan: [{ name: 'orb', candidate: true, direction: 'short', status: 'active', entryRef: d.price, stopDistance: 10, exit: { trailActivateR: 2 } }] }).sections.m3.data.candidates[0];
  assert.strictEqual(c.stopPoints, 10);
  if (c.inTheWay) assert.ok(c.inTheWay.price < d.price && Math.abs(c.inTheWay.R - c.inTheWay.points / 10) < 0.011);
  assert.strictEqual(c.exit.trailActivateR, 2);
});

test('a setup\'s facts, never a grade: the trend rule and the read for its side, the level in its way against the room it needs, confluence, VWAP side, window', () => {
  const levels = [['round number', 27300], ['day low', 27250], ['day high', 27400]];
  const base = { name: 'bos', direction: 'short', status: 'active', entryRef: 27325, stopDistance: 10, minRR: 1.5, exit: { trailActivateR: 2 }, mtf: { style: 'trend', shortAllowed: true, longAllowed: false }, confluence: { with: ['orb'], against: [] } };
  const g = (r, ctx = {}) => B.candidate({ ...base, ...r }, 27325, levels, { alignment: { short: 'aligned', long: 'counter' }, vwapSide: 'below', ...ctx });
  // Room: 27300 is 25 pts = 2.5R away, past the 2R trail activation.
  const a = g({});
  assert.deepStrictEqual([a.inTheWay.name, a.inTheWay.R, a.needR, a.trendRule, a.alignment, a.vwapSide], ['round number', 2.5, 2, 'allows', 'aligned', 'below']);
  assert.deepStrictEqual(a.facts, ['the trend rule allows a short', 'multi-timeframe read for a short: aligned', 'first level in its way: round number at 2.5R; it needs 2R (room past it)', 'confluence: with orb', 'price below the VWAP (its side)']);
  assert.ok(!('grade' in a) && !('why' in a) && !('blocked' in a));
  assert.match(g({ stopDistance: 16.67 }).facts[2], /round number at 1\.5R; it needs 2R \(the level comes first\)/);
  assert.deepStrictEqual(g({ mtf: { style: 'trend', shortAllowed: false } }).facts[0], 'against the trend rule for a short');
  assert.match(g({ mtf: { style: 'reversal', shortAllowed: false } }).facts[0], /^a reversal strategy, no prevailing trend read$/);
  assert.strictEqual(g({ confluence: { with: [], against: ['ema_cross'] } }).facts[3], 'confluence: none with it; against ema_cross');
  assert.strictEqual(g({}, { vwapSide: 'above' }).facts[4], 'price above the VWAP (the other side)');
  assert.strictEqual(g({}, { vwapSide: null }).facts[4], 'the VWAP unknown');
  assert.strictEqual(g({}, { lunch: true }).facts[5], 'lunch lull');
  assert.strictEqual(B.candidate({ ...base }, 27325, [], { alignment: { short: 'aligned' }, vwapSide: 'below' }).inTheWay, null);
  // Its levels ahead merge within the contract's tick: two names 0.25 apart are one level on MNQ, two on SIL (tick 0.005).
  const close = [['round number', 27300], ['day low', 27299.75]];
  assert.deepStrictEqual(B.candidate({ ...base }, 27325, close, {}).ahead.map(x => x.name), ['round number / day low']);
  assert.deepStrictEqual(B.candidate({ ...base }, 27325, close, { tick: 0.005 }).ahead.map(x => x.name), ['round number', 'day low']);
});

test('the rendered briefing opens with a plain-language summary: price and 1R, trend rule, alignment, VWAP, news, room each side, each setup with its facts', () => {
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, minRR: 2, exit: { trailActivateR: 2 }, mtf: { style: 'trend', longAllowed: true } }];
  const b = build(1300, null, { scan, blackouts: { items: [{ start: '2099-01-01T14:00:00Z', end: '2099-01-01T15:00:00Z', reason: 'CPI' }] } });
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  const summary = text.split('Detail by timeframe:')[0];
  for (const re of [/^Summary \(NQ 3m, \d{2}:\d{2} ET, .+ until \d{2}:\d{2}\):$/m, /^- Price [\d.]+\. 1R = [\d.]+ pts \(0\.5 x ATR\(20\), the reference stop\)/m, /^- Trend rule: /m,
    /^- Alignment: long \w+, short \w+\. Regime: /m, /^- VWAP \(\w+\): price (above|below|at), [\d.]+ ATR away/m, /^- News: next CPI at /m, /^- Room above \(R = the reference stop\): /m, /^- Room below \(R = the reference stop\): /m,
    /^ {2}- orb long: the trend rule allows a long; multi-timeframe read for a long: \w+; .+ Stop 10 pts \(its own 1R\); needs 2R of room; levels ahead in its R: /m]) assert.match(summary, re);
  assert.match(B.renderBriefing(build(1300, null, { scan: null }), { now: new Date(b.closedAt) }), /^- Setups: unknown \(the scan failed this bar\): no rules entry this bar\.$/m);
});

test('every expiry holds past 240 hours of bars too: a reused m15 or h1 equals a fresh one (the read is taken at each section\'s own close)', () => {
  // The fixture three times, a week apart (over 240 hours: the read's window slides), walked with the runner's 5000-bar window.
  const week = 7 * 86400000;
  const long = [0, 1, 2].flatMap(k => BARS.map(x => ({ ...x, t: new Date(Date.parse(x.t) + k * week).toISOString() })));
  let prev = null;
  const stale = {};
  for (let n = long.length - 160; n <= long.length; n += 1) {
    const bars = long.slice(Math.max(0, n - 5000), n);
    const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, prev });
    const f = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
    for (const s of ['m15', 'h1', 'day']) {
      if (!prev || b.sections[s].version !== prev.sections[s].version) continue;
      for (const [k, v] of Object.entries(b.sections[s].data)) if (JSON.stringify(v) !== JSON.stringify(f.sections[s].data[k])) stale[`${s}.${k}`] = (stale[`${s}.${k}`] || 0) + 1;
    }
    prev = b;
  }
  assert.deepStrictEqual(stale, {});
});

test('reuse is per contract: a roll to the next month recomputes every section', () => {
  const prev = { ...build(1300), contractId: 'NQ:2026-06' };
  const b = B.buildBriefing({ symbol: 'NQ', contractId: 'NQ:2026-09', bars: at(1301), minutes: 3, prev });
  for (const name of B.SECTIONS) assert.strictEqual(b.sections[name].reason, 'new', name);
  const same = B.buildBriefing({ symbol: 'NQ', contractId: 'NQ:2026-06', bars: at(1301), minutes: 3, prev });
  assert.strictEqual(same.sections.day.version, prev.sections.day.version);
});

test('session windows: Asia runs 18:00 to 03:00 ET across midnight', () => {
  for (const t of ['2026-06-01T22:03:00Z', '2026-06-02T03:30:00Z', '2026-06-02T06:59:00Z']) {
    const w = B.sessionWindow(new Date(t));
    assert.deepStrictEqual([w.name, w.until.toISOString()], ['asia', '2026-06-02T07:00:00.000Z'], t);
  }
  assert.strictEqual(B.sessionWindow(new Date('2026-06-02T07:00:00Z')).name, 'london');
});

test('news: the blackout in force or the next one; an unreadable file is unknown, never "no blackout"; a candidate in a blackout, with the news unknown, or in a no-entry window is blocked', () => {
  const t = Date.parse(build(1300).closedAt);
  const iso = m => new Date(t + m * 60000).toISOString();
  const news = items => build(1300, null, { blackouts: items }).sections.m3.data.news;
  assert.deepStrictEqual(news({ items: [{ start: iso(-5), end: iso(10), reason: 'CPI' }] }), { inBlackout: true, reason: 'CPI', until: iso(10) });
  assert.deepStrictEqual(news({ items: [{ start: iso(30), end: iso(40), reason: 'FOMC' }] }), { inBlackout: false, next: { reason: 'FOMC', start: iso(30), inMinutes: 30 } });
  assert.deepStrictEqual(news({ items: [] }), { inBlackout: false, next: null });
  assert.match(news({ items: [], error: 'EACCES' }).error, /can't be read \(EACCES\): the order gate refuses entries/);
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', entryRef: 1, stopDistance: 10, mtf: { style: 'trend', longAllowed: true }, confluence: { with: ['bos'], against: [] }, exit: { trailActivateR: 2 } }];
  const c = build(1300, null, { scan, blackouts: { items: [{ start: iso(-5), end: iso(10), reason: 'CPI' }] } }).sections.m3.data.candidates[0];
  assert.strictEqual(c.blocked, 'news blackout');
  const unknown = build(1300, null, { scan, blackouts: { items: [], error: 'invalid JSON' } }).sections.m3.data.candidates[0];
  assert.strictEqual(unknown.blocked, 'news unknown (the blackouts file can\'t be read)');
  assert.ok(!('blocked' in build(1300, null, { scan, blackouts: { items: [] } }).sections.m3.data.candidates[0]), 'no blackout: not blocked');
  assert.match(B.renderBriefing(build(1300, null, { scan, blackouts: { items: [], error: 'x' } }), { now: new Date(t) }), /orb long: .*\(blocked now: news unknown/);
  const lv = [['round number', 2000]];
  assert.strictEqual(B.candidate({ ...scan[0] }, 1000, lv, { noEntry: true, alignment: { long: 'aligned' }, vwapSide: 'above' }).blocked, 'no-entry window');
});

test('overnight levels are swept only in RTH (the range is final at 09:30 ET); nearest levels are ordered and merged within a tick', () => {
  // Every briefing outside RTH: no overnight sweep.
  for (let n = 300; n < BARS.length; n += 23) {
    const d = build(n).sections.m3.data;
    if (d.vwap.applies !== 'rth') assert.ok(!d.sweeps.some(x => /^overnight/.test(x.name)), `bar ${n}`);
    const { above, below } = d.nearestLiquidity;
    for (let k = 1; k < below.length; k += 1) assert.ok(below[k].price <= below[k - 1].price - 0.25, `below ordered and distinct, bar ${n}`);
    for (let k = 1; k < above.length; k += 1) assert.ok(above[k].price >= above[k - 1].price + 0.25, `above ordered and distinct, bar ${n}`);
  }
});

test('a candidate keeps its target (a level target\'s distance, or targetR x its stop) and its own levels ahead in its own R', () => {
  const base = { name: 'crt_1h', direction: 'short', status: 'active', entryRef: 27325, stopDistance: 62.08, minRR: 2, targetDistance: 129.75, exit: { target: 'range_low', maxBars: 40 }, mtf: { style: 'reversal' }, confluence: { with: [], against: [] } };
  const c = B.candidate(base, 27325, [['opening range high', 27356.75], ['round number', 27300], ['day low', 27250]], { alignment: { short: 'mixed' }, vwapSide: 'below' });
  assert.deepStrictEqual(c.target, { level: 'range_low', points: 129.75, R: 2.09 });
  assert.strictEqual(c.needR, 2.09, 'it needs room to its target');
  assert.deepStrictEqual(c.ahead.map(x => [x.name, x.R]), [['round number', 0.4], ['day low', 1.21]]);
  assert.deepStrictEqual(c.inTheWay, c.ahead[0]);
  const t = B.candidate({ ...base, targetDistance: undefined, exit: { targetR: 3 } }, 27325, [], {});
  assert.deepStrictEqual(t.target, { level: null, points: 186.24, R: 3 });
});

test('15m and 1h breaks: times are candle opens, as on the 3m, and knownAt is the breaking candle\'s close', () => {
  const b = build(1300);
  for (const [s, mins] of [['m15', 15], ['h1', 60]]) {
    for (const x of [b.sections[s].data.lastBreak.last, b.sections[s].data.lastBreak.previous].filter(Boolean)) {
      assert.strictEqual(Date.parse(x.knownAt) - Date.parse(x.at), mins * 60000, s);
      assert.strictEqual(Date.parse(x.at) % (mins * 60000), 0, `${s}: at is a candle open`);
    }
  }
});

test('equal lows traded through between their touches are taken (the pool is gone), not only after the last touch', () => {
  const bars = at(300);
  const d = build(300).sections.m3.data;
  const pool = d.liquidity.equalLows.find(x => x.price === 26940.25);
  assert.ok(pool && pool.taken, JSON.stringify(d.liquidity.equalLows));
  // The fixture's touches are 09:48Z and 11:33Z; only a bar between them trades below.
  assert.ok(bars.some(x => x.t > '2026-04-23T09:54:00' && x.t < '2026-04-23T11:27:00' && x.l < 26940.25), 'traded through between the touches');
  assert.ok(!bars.some(x => x.t > '2026-04-23T11:39:00' && x.l < 26940.25), 'never after the last touch');
});

test('bar_briefing by month: a note only when the month differs from the briefing\'s contract (a micro and its mini share a month)', () => {
  const home = tmpDir();
  const b = B.buildBriefing({ symbol: 'NQ', contractId: 'NQ:2026-06', bars: at(1300), minutes: 3 });
  B.writeBriefing(home, b);
  const env = { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt };
  assert.match(barBriefing({ symbol: 'MNQ:2026-09' }, { env }).text, /^Note: you asked for MNQ:2026-09; this briefing is for NQ:2026-06/);
  assert.doesNotMatch(barBriefing({ symbol: 'MNQ:2026-06' }, { env }).text, /^Note:/);
  assert.doesNotMatch(barBriefing({ symbol: 'MNQ' }, { env }).text, /^Note:/);
});

test('levels merge within the contract\'s own tick (contracts.js), in the nearest levels too; VWAP rounded; an unknown R spelled out', () => {
  const near = symbol => B.buildBriefing({ symbol, bars: at(370), minutes: 3 }).sections.m3.data.nearestLiquidity.below.map(x => x.name);
  // The opening range high 27068 and the last 3m swing low 27067: two levels a point apart on NQ, one on YM (tick 1).
  assert.ok(near('NQ').includes('opening range high') && near('NQ').includes('last 3m swing low'), near('NQ').join(' | '));
  assert.ok(near('YM').includes('opening range high / last 3m swing low'), near('YM').join(' | '));
  assert.ok(near('YM:2026-06').includes('opening range high / last 3m swing low'), 'a contract by month uses its root\'s tick');
  const d = build(370).sections.m3.data;
  for (const x of [...d.nearestLiquidity.above, ...d.nearestLiquidity.below]) assert.strictEqual(x.price, Math.round(x.price * 100) / 100, `${x.name} ${x.price}`);
  assert.ok([...d.nearestLiquidity.above, ...d.nearestLiquidity.below].some(x => /^VWAP/.test(x.name)), 'control: the VWAP is among them');
  // A candidate without a stop has no R: the summary says so.
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', entryRef: 1, stopDistance: null, mtf: { style: 'trend', longAllowed: true }, confluence: { with: [], against: [] }, exit: {} }];
  const text = B.renderBriefing(build(1300, null, { scan }), { now: new Date(build(1300).closedAt) });
  assert.match(text, /orb long: .*its stop is unknown, so no R/);
  assert.match(text, /levels ahead in its R: [^\n]*\(\d[\d.]* pts, R unknown\)/);
});

test('a reversal setup says whether it fades the prevailing trend (half size, nearest target) or goes with it, from the scan\'s own trend-rule summary', () => {
  const { ruleSummary } = require('../../scripts/lib/trading/mtf');
  const r = { name: 'crt_1h', status: 'active', entryRef: 100, stopDistance: 10, exit: {}, confluence: { with: [], against: [] } };
  const fact = (direction, biases) => B.candidate({ ...r, direction, mtf: ruleSummary(biases, 'reversal') }, 100, [], {}).facts[0];
  const up = { 240: 1, 60: 1, 15: -1 };
  const down = { 240: -1, 60: -1, 15: 1 };
  assert.strictEqual(fact('short', up), 'a reversal strategy fading the prevailing 4h up trend: the trend rule allows it, at half size and the nearest target (multi-timeframe-analysis, the counter row)');
  assert.strictEqual(fact('long', down), 'a reversal strategy fading the prevailing 4h down trend: the trend rule allows it, at half size and the nearest target (multi-timeframe-analysis, the counter row)');
  assert.strictEqual(fact('long', up), 'a reversal strategy, with the prevailing 4h up trend');
  assert.strictEqual(fact('short', { 240: 0, 60: -1, 15: 0 }), 'a reversal strategy, with the prevailing 1h down trend');
  assert.strictEqual(fact('long', { 240: 0, 60: 0, 15: 0 }), 'a reversal strategy, no prevailing trend read');
  assert.strictEqual(B.candidate({ ...r, direction: 'short', mtf: { style: 'trend', shortAllowed: true } }, 100, [], { vwapSide: 'at' }).facts[4], 'price at the VWAP');
});

test('news: a blackout entry without a valid start and end is unknown (the gate refuses entries), and blocks a candidate', () => {
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', entryRef: 1, stopDistance: 10, mtf: { style: 'trend', longAllowed: true }, confluence: { with: [], against: [] }, exit: {} }];
  const d = build(1300, null, { scan, blackouts: { items: [{ reason: 'CPI', start: 'garbage', end: '2099-01-01T00:00:00Z' }] } }).sections.m3.data;
  assert.strictEqual(d.news.inBlackout, null);
  assert.match(d.news.error, /an entry without a valid start and end\): the order gate refuses entries/);
  assert.strictEqual(d.candidates[0].blocked, 'news unknown (the blackouts file can\'t be read)');
});
