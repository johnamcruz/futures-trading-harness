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
    if (!x.brokenAt) assert.ok(x.type === 'high' ? x.price >= Math.min(d.price, x.price) : true);
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
