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
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');

// The shipped round-number steps only (never the developer's home): what the runner passes with no override.
const STEPS = defaultRoundSteps();

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const at = n => BARS.slice(0, n);
const build = (n, prev = null, extra = {}) => B.buildBriefing({ symbol: 'NQ', bars: at(n), minutes: 3, prev, roundSteps: STEPS, ...extra });

test('nextClose: candles from the 18:00 ET session open; sessionWindow: the session-timing skill\'s windows', () => {
  // 2026-06-01 14:57Z is 10:57 ET (EDT): the 15m candle closes 11:00 ET, the 1h at 11:00 ET, the 3m at 11:00 ET.
  const t = new Date('2026-06-01T14:57:00Z');
  assert.strictEqual(B.nextClose(t, 15).toISOString(), '2026-06-01T15:00:00.000Z');
  assert.strictEqual(B.nextClose(new Date('2026-06-01T15:00:00Z'), 15).toISOString(), '2026-06-01T15:15:00.000Z', 'a close at the boundary starts the next candle');
  assert.strictEqual(B.nextClose(new Date('2026-06-01T15:01:00Z'), 60).toISOString(), '2026-06-01T16:00:00.000Z');
  // 4h candles from 18:00 ET: 18, 22, 02, 06, 10, 14 ET; at 10:57 ET the next close is 14:00 ET.
  assert.strictEqual(B.nextClose(t, 240).toISOString(), '2026-06-01T18:00:00.000Z');
  assert.deepStrictEqual(B.sessionWindow(t), { name: 'opening drive', until: new Date('2026-06-01T15:00:00Z'), entries: 'allowed', marketOpen: true, text: 'opening drive (market open, entries allowed) until 11:00 ET', refusal: null });
  assert.strictEqual(B.sessionWindow(new Date('2026-06-01T16:00:00Z')).name, 'lunch lull');
  assert.strictEqual(B.sessionWindow(new Date('2026-06-01T20:30:00Z')).name, 'daily break');
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

test('a candidate shows the field values its fired rules read; the cached m15, h1 and day parts are the same with or without them', () => {
  const rules = { long: [{ rule: 'field("a.b") >= 0.3', ok: true, values: { 'field("a.b")': 0.4166666 } }, { rule: 'field("a.b")[1] < 0.3 & close > 0', ok: true, values: { 'field("a.b")[1]': null } }, { rule: 'close > 0', ok: true }], short: [{ rule: 'field("c") < 0', ok: false, values: { 'field("c")': 5 } }] };
  const orb = { name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, exit: { trailActivateR: 2 } };
  const withValues = build(1300, null, { scan: [{ ...orb, rules }] });
  const without = build(1300, null, { scan: [{ ...orb, rules: { long: rules.long.map(({ rule, ok }) => ({ rule, ok })), short: [] } }] });
  // The fired side only (the short side's values are not this candidate's), 4 significant digits, a missing one named.
  assert.strictEqual(withValues.sections.m3.data.candidates[0].values, 'field("a.b")=0.4167, field("a.b")[1]=missing');
  assert.ok(!('values' in without.sections.m3.data.candidates[0]), 'no field read, no values key');
  assert.match(B.renderBriefing(withValues, { now: new Date(withValues.closedAt) }), /- orb long: .* Values: field\("a\.b"\)=0\.4167, field\("a\.b"\)\[1\]=missing\.\n/);
  assert.doesNotMatch(B.renderBriefing(without, { now: new Date(without.closedAt) }), /Values:/);
  for (const part of ['m15', 'h1', 'day']) assert.deepStrictEqual(withValues.sections[part], without.sections[part], `${part}: the report cache's parts never see the values`);
  // A short candidate shows its short side's values, never the long side's; at most 6, the rest counted.
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`field("f${k}")`, k]));
  const short = build(1300, null, { scan: [{ ...orb, direction: 'short', rules: { long: rules.long, short: [{ rule: 'x', ok: true, values: many }] } }] });
  assert.strictEqual(short.sections.m3.data.candidates[0].values, 'field("f0")=0, field("f1")=1, field("f2")=2, field("f3")=3, field("f4")=4, field("f5")=5, +2 more');
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
  // A fixed clock: the suite's shifted clock keeps running from process start, so on a slow run the
  // briefing (valid one bar) would read as expired. These tests are about the briefing, not the clock.
  const now = () => new Date(b.closedAt);
  assert.match(barBriefing({ symbol: 'NQ' }, { env, now }).text, /^Bar briefing NQ 3m/);
  assert.deepStrictEqual(JSON.parse(barBriefing({ symbol: 'NQ', json: true }, { env, now }).text).sections.m3.version, b.sections.m3.version);
  assert.match(barBriefing({ symbol: 'ES' }, { env, now }).text, /^No bar briefing for ES: .*Take the market facts from the bars yourself/);
  assert.throws(() => barBriefing({ symbol: '../x' }, { env, now }), /--symbol/);
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
  const record = briefingRecorder(home, { timeframe: 3 }, () => new Date(b.closedAt), { FTH_HOME: home });
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
  // The gate's clock is unknown too: no entries, and a candidate is blocked by the window first.
  assert.deepStrictEqual([m3.windowEntries, m3.windowRefusal], ['none', 'the gate config can\'t be read (config unreadable): entries refused until it can']);
  assert.match(m3.candidates[0].blocked, /^no-entry window: .* \(market open, no entries\) until /);
});

test('the runner passes its home\'s round-number steps, read once per bar close, to the first briefing and every timeframe\'s', () => {
  const { briefingRecorder } = require('../../scripts/lib/runner-wiring');
  const { FILE_NAME } = require('../../scripts/lib/trading/round-numbers');
  const home = tmpDir();
  const file = path.join(home, FILE_NAME);
  fs.writeFileSync(file, JSON.stringify({ steps: { NQ: 50 } }));
  const record = briefingRecorder(home, { timeframe: 3 }, () => new Date(), { FTH_HOME: home }, { frames: [{ lane: -1, minutes: 15 }, { lane: 1, minutes: 3 }] });
  const rounds = nl => [...nl.above, ...nl.below].filter(x => /round number/.test(x.name)).map(x => x.price).sort((a, c) => a - c);
  record({ symbol: 'NQ', bars: at(300) }, [], null);
  // The override (50), not the default (100): price 27013 sits between 27000 and 27050.
  assert.deepStrictEqual(rounds(B.readBriefing(home, 'NQ').sections.m3.data.nearestLiquidity), [27000, 27050]);
  const f15 = rounds(B.readFrameBriefing(home, 'NQ', 15).sections.bar.data.nearestLiquidity);
  assert.ok(f15.length && f15.every(x => x % 50 === 0) && f15.some(x => x % 100 !== 0), `15m on the same steps: ${f15}`);
  // Edited mid-bar: a timeframe of the same bar close still gets the steps the bar started with.
  fs.writeFileSync(file, JSON.stringify({ steps: { NQ: 0.1 } }));
  record({ symbol: 'NQ', lane: 1, minutes: 3, bars: at(300) }, [], null);
  assert.deepStrictEqual(rounds(B.readFrameBriefing(home, 'NQ', 3).sections.bar.data.nearestLiquidity), [27000, 27050]);
  // The next bar reads the edit: refused, so none, and the briefing says why.
  record({ symbol: 'NQ', bars: at(301) }, [], null);
  const next = B.readBriefing(home, 'NQ');
  assert.deepStrictEqual(rounds(next.sections.m3.data.nearestLiquidity), []);
  assert.match(next.sections.m3.data.nearestLiquidity.roundNumbers, /MNQ step 0\.1 is not a whole number of its 0\.25 ticks/);
  assert.match(B.renderBriefing(next, { now: new Date(next.closedAt) }), /^- Round numbers: none \(.*MNQ step 0\.1 /m);
});

test('the runner\'s briefing step reads the gate\'s clock from its env: FTH_NO_ENTRY_WINDOWS and FTH_ENTRY_HOURS reach the window', () => {
  const { briefingRecorder } = require('../../scripts/lib/runner-wiring');
  // The bar opening 13:33Z closes 09:36 ET: the opening drive, entries allowed by default.
  const bars = BARS.slice(0, BARS.findIndex(x => x.t === '2026-04-27T13:33:00.000Z') + 1);
  const m3 = env => {
    const home = tmpDir();
    briefingRecorder(home, { timeframe: 3 }, () => new Date(), { FTH_HOME: home, ...env })({ symbol: 'NQ', bars }, [], null);
    const d = B.readBriefing(home, 'NQ').sections.m3.data;
    return [d.windowEntries, d.windowText];
  };
  assert.deepStrictEqual(m3({}), ['allowed', 'opening drive (market open, entries allowed) until 11:00 ET']);
  assert.deepStrictEqual(m3({ FTH_NO_ENTRY_WINDOWS: '09:30-09:45@America/New_York' }), ['none', 'opening drive (market open, no entries) until 09:45 ET']);
  assert.deepStrictEqual(m3({ FTH_ENTRY_HOURS: '10:00-15:00@America/New_York' }), ['none', 'opening drive (market open, no entries) until 10:00 ET']);
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
  for (const re of [/^Summary \(NQ 3m, \d{2}:\d{2} ET\):$/m, /^- Session: [a-z ]+ \(market (open|closed), (entries allowed|no entries)\) until \d{2}:\d{2} ET\.$/m, /^- Price [\d.]+\. 1R = ([\d.]+) pts \(0\.5 x 3m ATR\(20\) ([\d.]+), the 3m reference stop\)/m, /^- Trend rule: /m,
    /^- Alignment: long \w+, short \w+\. Regime: /m, /^- VWAP \(\w+\): price (above|below|at), [\d.]+ x 3m ATR\(14\) away/m, /^- News: next CPI at /m, /^- Room above \(R = the 3m reference stop\): /m, /^- Room below \(R = the 3m reference stop\): /m,
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

// Seen in replays (2026-06-01): "opening drive" read as the no-entry opening print, with invented ends ("until 09:42 ET",
// "until 10:00 ET") at 09:36, 09:39 and 09:54, a live verdict overlooked at 09:54; and "before the 18:00 ET session open"
// at 08:00. Every window states whether the market is open, whether entries are allowed, and until when.
test('session windows state their own scope: market open or closed, entries allowed or not, and until when', () => {
  const at = (iso) => B.sessionWindow(new Date(iso));
  const cases = [
    // 2026-06-01 is EDT (UTC-4).
    ['2026-06-01T12:00:00Z', 'london', 'allowed', true, 'london (market open, entries allowed) until 09:30 ET'],
    ['2026-06-01T13:32:00Z', 'opening print', 'none', true, 'opening print (market open, no entries) until 09:35 ET'],
    ['2026-06-01T13:36:00Z', 'opening drive', 'allowed', true, 'opening drive (market open, entries allowed) until 11:00 ET'],
    ['2026-06-01T13:39:00Z', 'opening drive', 'allowed', true, 'opening drive (market open, entries allowed) until 11:00 ET'],
    ['2026-06-01T13:54:00Z', 'opening drive', 'allowed', true, 'opening drive (market open, entries allowed) until 11:00 ET'],
    ['2026-06-01T16:00:00Z', 'lunch lull', 'allowed', true, 'lunch lull (market open, entries allowed) until 13:30 ET'],
    ['2026-06-01T19:47:00Z', 'into the close', 'none', true, 'into the close (market open, no entries) until 16:00 ET'],
    ['2026-06-01T21:30:00Z', 'daily break', 'none', false, 'daily break (market closed, no entries) until 18:00 ET'],
    ['2026-06-01T22:03:00Z', 'asia', 'allowed', true, 'asia (market open, entries allowed) until 03:00 ET'],
    ['2026-06-02T05:00:00Z', 'asia', 'allowed', true, 'asia (market open, entries allowed) until 03:00 ET'],
  ];
  for (const [iso, name, entries, marketOpen, text] of cases) {
    const w = at(iso);
    assert.deepStrictEqual([w.name, w.entries, w.marketOpen, w.text], [name, entries, marketOpen, text], iso);
  }
  // A no-entry window carries the gate's reason.
  assert.strictEqual(at('2026-06-01T13:32:00Z').refusal, 'New entries are not allowed during 09:30-09:35@America/New_York.');
});

test('the window\'s entries are the gate\'s clock: FTH_ENTRY_HOURS and FTH_NO_ENTRY_WINDOWS move them, and the end where they change', () => {
  const { loadConfig } = require('../../scripts/lib/trading/config');
  const clock = env => { const c = loadConfig(env); return { entryHours: c.entryHours, noEntryWindows: c.noEntryWindows }; };
  const w = (iso, env) => { const x = B.sessionWindow(new Date(iso), clock(env)); return [x.entries, x.text]; };
  // Entries only in New York: 08:00 ET is London with no entries, until the New York open.
  assert.deepStrictEqual(w('2026-06-01T12:00:00Z', { FTH_ENTRY_HOURS: 'ny' }), ['none', 'london (market open, no entries) until 09:30 ET']);
  assert.match(B.sessionWindow(new Date('2026-06-01T12:00:00Z'), clock({ FTH_ENTRY_HOURS: 'ny' })).refusal, /^New entries only during ny .*\(FTH_ENTRY_HOURS\)\.$/);
  // A longer opening window: 09:36 is the opening drive with no entries until 09:45, then entries until 11:00.
  const longer = { FTH_NO_ENTRY_WINDOWS: '09:30-09:45@America/New_York,15:45-16:00@America/New_York' };
  assert.deepStrictEqual(w('2026-06-01T13:36:00Z', longer), ['none', 'opening drive (market open, no entries) until 09:45 ET']);
  assert.deepStrictEqual(w('2026-06-01T13:45:00Z', longer), ['allowed', 'opening drive (market open, entries allowed) until 11:00 ET']);
  // An allowed window ends early where a configured no-entry window starts inside it.
  assert.deepStrictEqual(w('2026-06-01T16:00:00Z', { FTH_NO_ENTRY_WINDOWS: '12:15-12:30@America/New_York' }), ['allowed', 'lunch lull (market open, entries allowed) until 12:15 ET']);
  // No no-entry windows: the opening print allows entries (what the gate does); an invalid config refuses them all.
  assert.deepStrictEqual(w('2026-06-01T13:32:00Z', { FTH_NO_ENTRY_WINDOWS: '' }), ['allowed', 'opening print (market open, entries allowed) until 09:35 ET']);
  assert.deepStrictEqual(w('2026-06-01T13:36:00Z', { FTH_NO_ENTRY_WINDOWS: 'whenever' }), ['none', 'opening drive (market open, no entries) until 11:00 ET']);
  // The daily break is closed whatever the config.
  assert.deepStrictEqual(w('2026-06-01T21:30:00Z', { FTH_NO_ENTRY_WINDOWS: '' }), ['none', 'daily break (market closed, no entries) until 18:00 ET']);
  // The briefing takes the clock it is given.
  const bars = BARS.slice(0, BARS.findIndex(x => x.t === '2026-04-27T13:33:00.000Z') + 1);
  const d = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, clock: clock(longer) }).sections.m3.data;
  assert.deepStrictEqual([d.et, d.windowEntries, d.windowText], ['09:36', 'none', 'opening drive (market open, no entries) until 09:45 ET']);
});

test('the briefing states the window with its scope, in the JSON and the summary; a candidate in a no-entry window says which and until when', () => {
  // The fixture is EDT: a bar opening 13:33Z closes 09:36 ET (n = its index + 1).
  const n = iso => BARS.findIndex(x => x.t === iso) + 1;
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', entryRef: 1, stopDistance: 10, mtf: { style: 'trend', longAllowed: true }, confluence: { with: [], against: [] }, exit: { trailActivateR: 2 } }];
  const cases = [
    ['2026-04-27T11:57:00.000Z', '08:00', 'london', 'allowed', true, 'london (market open, entries allowed) until 09:30 ET'],
    ['2026-04-27T13:30:00.000Z', '09:33', 'opening print', 'none', true, 'opening print (market open, no entries) until 09:35 ET'],
    ['2026-04-27T13:33:00.000Z', '09:36', 'opening drive', 'allowed', true, 'opening drive (market open, entries allowed) until 11:00 ET'],
    ['2026-04-27T13:51:00.000Z', '09:54', 'opening drive', 'allowed', true, 'opening drive (market open, entries allowed) until 11:00 ET'],
    ['2026-04-27T19:45:00.000Z', '15:48', 'into the close', 'none', true, 'into the close (market open, no entries) until 16:00 ET'],
  ];
  for (const [bar, et, name, entries, marketOpen, text] of cases) {
    const b = build(n(bar), null, { scan, blackouts: { items: [] } });
    const d = b.sections.m3.data;
    assert.deepStrictEqual([d.et, d.window, d.windowEntries, d.marketOpen, d.windowText], [et, name, entries, marketOpen, text], bar);
    const out = B.renderBriefing(b, { now: new Date(b.closedAt) });
    assert.ok(out.includes(`\n- Session: ${text}.\n`), `${bar}: the summary's session line`);
    const c = d.candidates[0];
    if (entries === 'none') assert.strictEqual(c.blocked, `no-entry window: ${text}`, bar);
    else assert.ok(!('blocked' in c), `${bar}: entries allowed, not blocked`);
  }
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
  // A fixed clock: the suite's shifted clock keeps running from process start, so on a slow run the
  // briefing (valid one bar) would read as expired. These tests are about the briefing, not the clock.
  const now = () => new Date(b.closedAt);
  assert.match(barBriefing({ symbol: 'MNQ:2026-09' }, { env, now }).text, /^Note: you asked for MNQ:2026-09; this briefing is for NQ:2026-06/);
  assert.doesNotMatch(barBriefing({ symbol: 'MNQ:2026-06' }, { env, now }).text, /^Note:/);
  assert.doesNotMatch(barBriefing({ symbol: 'MNQ' }, { env, now }).text, /^Note:/);
});

test('round numbers are on the family\'s configured step (round-numbers.js; defaults 100 on NQ, 25 on ES, 10 on M2K), none for an unlisted root', () => {
  const rounds = symbol => {
    const nl = B.buildBriefing({ symbol, bars: at(300), minutes: 3, roundSteps: STEPS }).sections.m3.data.nearestLiquidity;
    return [...nl.above, ...nl.below].filter(x => /round number/.test(x.name)).map(x => x.price).sort((a, b) => a - b);
  };
  // Price 27013: the multiples of each family's step just below and above it.
  assert.deepStrictEqual(rounds('NQ'), [27000, 27100]);
  assert.deepStrictEqual(rounds('MNQ'), [27000, 27100], 'the micro shares its mini\'s step');
  assert.deepStrictEqual(rounds('ES'), [27000, 27025]);
  assert.deepStrictEqual(rounds('M2K:2026-06'), [27010, 27020], 'a contract by month uses its root\'s step');
  assert.deepStrictEqual(rounds('XYZ'), [], 'no step, no round numbers (never another family\'s)');
});

test('price on a round number: that one is `at` (in the summary too), with the next one above and the next below', () => {
  // Bar 679 closes at 27100: on ES's 25 step, 27100 is at price, 27125 above and 27075 below.
  const b = B.buildBriefing({ symbol: 'ES', bars: at(679), minutes: 3, roundSteps: STEPS });
  const nl = b.sections.m3.data.nearestLiquidity;
  assert.strictEqual(b.price, 27100);
  assert.deepStrictEqual(nl.at, [{ name: 'round number', price: 27100, points: 0, R: 0 }]);
  assert.ok(nl.above.some(x => x.name === 'round number' && x.price === 27125), JSON.stringify(nl.above));
  // 27075 merges with the prior VAH 27075.17 (within a tick): one level, both names.
  assert.ok(nl.below.some(x => /round number/.test(x.name) && Math.abs(x.price - 27075) <= 0.25), JSON.stringify(nl.below));
  assert.match(B.renderBriefing(b, { now: new Date(b.closedAt) }), /^- At price: round number 27100\.$/m);
  // Off a round number, or with no step: no `at`, and no summary line.
  assert.strictEqual(B.buildBriefing({ symbol: 'ES', bars: at(300), minutes: 3, roundSteps: STEPS }).sections.m3.data.nearestLiquidity.at, undefined);
  const none = B.buildBriefing({ symbol: 'XYZ', bars: at(679), minutes: 3, roundSteps: STEPS });
  assert.strictEqual(none.sections.m3.data.nearestLiquidity.at, undefined);
  assert.doesNotMatch(B.renderBriefing(none, { now: new Date(none.closedAt) }), /At price/);
});

test('the briefing takes the loaded round-number steps: an override moves the levels; a refused step shows none and says why', () => {
  const { resolveRoundSteps } = require('../../scripts/lib/trading/round-numbers');
  const rounds = (symbol, roundSteps) => {
    const b = B.buildBriefing({ symbol, bars: at(300), minutes: 3, roundSteps });
    const nl = b.sections.m3.data.nearestLiquidity;
    return { b, nl, prices: [...nl.above, ...nl.below].filter(x => /round number/.test(x.name)).map(x => x.price).sort((a, c) => a - c) };
  };
  assert.deepStrictEqual(rounds('NQ', resolveRoundSteps({ steps: { NQ: 50 } })).prices, [27000, 27050]);
  const refused = rounds('NQ', resolveRoundSteps({ steps: { NQ: 0.1 } }));
  assert.deepStrictEqual(refused.prices, []);
  assert.match(refused.nl.roundNumbers, /MNQ step 0\.1 is not a whole number of its 0\.25 ticks/);
  assert.match(B.renderBriefing(refused.b, { now: new Date(refused.b.closedAt) }), /^- Round numbers: none \(defaults: MNQ step 0\.1 /m);
  assert.strictEqual(rounds('NQ', resolveRoundSteps({ steps: { NQ: 100 } })).nl.roundNumbers, undefined, 'no refusal, no field');
});

test('roundNumbers: below and above price, or on one (at) with the next each side; only positive prices; no step, none', () => {
  assert.deepStrictEqual(B.roundNumbers(27013, 100), { at: null, levels: [27000, 27100] });
  assert.deepStrictEqual(B.roundNumbers(27100, 25), { at: 27100, levels: [27075, 27125] });
  // A step over price: no round number at or below zero.
  assert.deepStrictEqual(B.roundNumbers(27013, 30000), { at: null, levels: [30000] });
  assert.deepStrictEqual(B.roundNumbers(30000, 30000), { at: 30000, levels: [60000] });
  assert.deepStrictEqual(B.roundNumbers(27013, null), { at: null, levels: [] });
  assert.deepStrictEqual(B.roundNumbers(27013, 0), { at: null, levels: [] });
});

test('round numbers show on the contract\'s tick like every other level: SI 0.125 on its 0.005 tick is 27.125, never 27.13', () => {
  const { resolveRoundSteps } = require('../../scripts/lib/trading/round-numbers');
  const steps = resolveRoundSteps(null, { steps: { SI: 0.125 } });
  assert.deepStrictEqual(steps.errors, []);
  // NQ bars scaled to silver prices: bar 504 closes 27125, so 27.125 (on the 0.125 step).
  const scaled = at(504).map(b => ({ ...b, o: b.o / 1000, h: b.h / 1000, l: b.l / 1000, c: b.c / 1000 }));
  const b = B.buildBriefing({ symbol: 'SI', bars: scaled, minutes: 3, roundSteps: steps });
  const nl = b.sections.m3.data.nearestLiquidity;
  assert.strictEqual(b.price, 27.125);
  assert.deepStrictEqual(nl.at, [{ name: 'round number', price: 27.125, points: 0, R: 0 }]);
  const rounds = [...nl.above, ...nl.below].filter(x => /round number/.test(x.name)).map(x => x.price);
  for (const p of rounds) assert.ok([27, 27.25].includes(p), `${p}`);
  assert.doesNotMatch(JSON.stringify(nl), /27\.13\b/);
  assert.match(B.renderBriefing(b, { now: new Date(b.closedAt) }), /^- At price: round number 27\.125\.$/m);
  // Off a round number: the neighbour above 27.013 is 27.125 in the room, on the tick too.
  const off = B.buildBriefing({ symbol: 'SI', bars: scaled.slice(0, 300), minutes: 3, roundSteps: steps });
  const above = off.sections.m3.data.nearestLiquidity.above.filter(x => /round number/.test(x.name)).map(x => x.price);
  assert.strictEqual(off.price, 27.013);
  assert.deepStrictEqual(above, [27.125]);
  assert.match(B.renderBriefing(off, { now: new Date(off.closedAt) }), /round number 27\.125 \(/);
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
  assert.strictEqual(fact('short', up), 'a reversal strategy fading the prevailing 4h up trend: the trend rule allows it; the priority order, step 2 (strategy-library), decides it (level, size, target)');
  assert.strictEqual(fact('long', down), 'a reversal strategy fading the prevailing 4h down trend: the trend rule allows it; the priority order, step 2 (strategy-library), decides it (level, size, target)');
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

test('completed-candle facts: per timeframe in m3 and a summary line each, the levels at the briefing\'s own values, 5m unavailable on 3m bars; frames share the runner\'s', () => {
  const b = build(1300);
  const d = b.sections.m3.data;
  assert.deepStrictEqual(Object.keys(d.candles), ['3m', '5m', '15m', '1h']);
  assert.match(d.candles['5m'].unavailable, /not whole 3m bars/);
  const c15 = d.candles['15m'];
  // The last completed 15m candle: closed by this bar's close, never the one forming.
  assert.ok(Date.parse(c15.closedAt) <= Date.parse(b.closedAt) && Date.parse(c15.closedAt) > Date.parse(b.closedAt) - 15 * 60000);
  assert.strictEqual(d.candles['3m'].closedAt, b.closedAt, 'the 3m candle is the bar itself');
  // Every level it met is one the briefing names (at that value), its previous candle, or a CRT range.
  for (const tf of ['3m', '15m', '1h']) {
    for (const [name, rel] of Object.entries(d.candles[tf].levels)) {
      assert.match(rel, /^(touched|broke (above|below)|rejected: closed back (above|below))$/, `${tf} ${name}`);
      assert.match(name, /^(prior|session|VWAP|overnight|IB|opening range|15m swing|1h swing|round number|previous|CRT)/);
    }
  }
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  assert.match(text, /\n- 15m \(closed \d\d:\d\d\): [a-z ]+/);
  // No 1m lane: the 5m line is left out of the summary (the JSON says why).
  assert.ok(!/\n- 5m/.test(text));
  // The detail leaves out the 3m candle's OHLCV (it is the bar above) and the unavailable 5m.
  const detail = JSON.parse(text.split('\n').find(l => l.startsWith('  candles: ')).slice('  candles: '.length));
  assert.deepStrictEqual([Object.keys(detail), 'o' in detail['3m'], 'o' in detail['15m']], [['3m', '15m', '1h'], false, true]);
  assert.match(text, /\n- Next swing above \(R = the reference stop\): .*; below: /);
  // The detail leaves out what the summary says in full.
  assert.ok(!/\n {2}swingTargets: /.test(text));
  // An analyst's 15m briefing points to the runner's candle facts and swing targets (they read the session's levels,
  // one value each, on the runner's bars), whether or not it closed with the runner's bar.
  const n = BARS.findIndex((x, i) => i > 1300 && new Date(Date.parse(x.t) + 180000).getUTCMinutes() % 15 === 0) + 1;
  const first = build(n);
  const whole = B.wholeBars(at(n), 15);
  for (const f of [B.buildFrameBriefing({ symbol: 'NQ', bars: whole, minutes: 15, first }), B.buildFrameBriefing({ symbol: 'NQ', bars: whole.slice(0, -1), minutes: 15, first })]) {
    assert.match(f.sections.bar.data.candles, /in the runner's 3m bar briefing \(bar_briefing without a timeframe\)/);
    assert.ok(!('swingTargets' in f.sections.bar.data));
    assert.match(B.renderFrameBriefing(f, first, { now: new Date(f.closedAt) }), /- Completed candles and swing targets: in the runner's 3m bar briefing/);
  }
});

test('completed candles read the levels as they stood at their close: an hour that closed before the opening range has none of it; the snapshot\'s levels as of a bar are the briefing\'s own on that bar', () => {
  const { levelsAsOf } = require('../../scripts/lib/trading/market-snapshot');
  const etHm = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const i = BARS.findIndex((x, k) => k > 1000 && etHm(x.t) === '09:48');
  const bars = at(i + 1);
  const pre = BARS.findIndex((x, k) => k > i - 30 && etHm(x.t) === '08:57');
  // At the 08:57 bar: no opening range, no IB, the session VWAP applies.
  const x = levelsAsOf(bars, pre);
  assert.deepStrictEqual([x.openingRange, x.vwapApplies], [null, 'session']);
  assert.ok(!x.ib || x.ib.high === null || x.ib.high === undefined);
  // At the 09:48 bar the opening range exists; the last completed hour (08:00-09:00) never meets it.
  const b = build(i + 1);
  const d = b.sections.m3.data;
  assert.ok(d.today.openingRange, 'the opening range exists now');
  assert.strictEqual(etHm(d.candles['1h'].closedAt), '09:00');
  assert.ok(Object.keys(d.candles['1h'].levels).every(n => !/^(opening range|IB|VWAP \(rth\))/.test(n)), JSON.stringify(d.candles['1h'].levels));
  // The snapshot's levels as of the last bar are the briefing's own (one value per level).
  const now = levelsAsOf(bars, i);
  assert.strictEqual(now.vwapApplies, d.vwap.applies);
  assert.strictEqual(Math.round(now.vwapSession * 100) / 100, d.vwap.session);
  assert.deepStrictEqual(now.openingRange, { high: d.today.openingRange.high, low: d.today.openingRange.low });
  assert.deepStrictEqual(now.overnight, d.overnight);
  // The profiles are shown on the tick (the computed level is to the cent): the same level within half a tick.
  const near = (x, y, what) => assert.ok(Math.abs(x - y) <= 0.125 + 1e-9, `${what}: ${x} vs ${y}`);
  const pp = b.sections.day.data.priorProfile;
  for (const k of ['poc', 'vah', 'val']) { near(now.sessionProfile[k], d.sessionProfile[k], `session ${k}`); near(now.priorProfile[k], pp[k], `prior ${k}`); }
});

test('5m from 1m bars in the briefing: with them the 5m candle, without them unavailable and why; 1m bars after the close never read', () => {
  const n = 1300;
  const b3 = at(n);
  const ones = b3.slice(-60).flatMap(x => [0, 1, 2].map(k => ({ t: new Date(Date.parse(x.t) + k * 60000).toISOString(), o: x.o, h: x.h, l: x.l, c: x.c, v: 1 })));
  const plain = B.buildBriefing({ symbol: 'NQ', bars: b3, minutes: 3 });
  const withFine = B.buildBriefing({ symbol: 'NQ', bars: b3, minutes: 3, fineBars: ones }).sections.m3.data.candles['5m'];
  assert.ok(withFine.closedAt && !withFine.unavailable);
  assert.ok(Date.parse(withFine.closedAt) <= Date.parse(plain.closedAt));
  const later = [...ones, { t: new Date(Date.parse(ones.at(-1).t) + 60000).toISOString(), o: 1, h: 99999, l: 1, c: 2, v: 9 }];
  assert.deepStrictEqual(B.buildBriefing({ symbol: 'NQ', bars: b3, minutes: 3, fineBars: later }).sections.m3.data.candles['5m'], withFine);
  assert.match(plain.sections.m3.data.candles['5m'].unavailable, /no 1m bars configured/);
});

test('a completed candle never reacts to a fixed level its own bars made: fixed levels as of its open, moving ones at its close', () => {
  const { levelsAsOf } = require('../../scripts/lib/trading/market-snapshot');
  const { relation, RELATION_TEXT } = require('../../scripts/lib/trading/candle-facts');
  let checked = 0;
  for (let n = 400; n < BARS.length; n += 23) {
    const bars = at(n);
    const d = build(n).sections.m3.data;
    for (const tf of ['15m', '1h']) {
      const c = d.candles[tf];
      if (!c || c.unavailable) continue;
      const first = bars.findIndex(x => Date.parse(x.t) >= Date.parse(c.t));
      if (first <= 0) continue;
      const open = levelsAsOf(bars, first - 1);
      const close = levelsAsOf(bars, bars.findIndex(x => Date.parse(x.t) + 180000 >= Date.parse(c.closedAt)));
      for (const [side, k] of [['high', 'overnight high'], ['low', 'overnight low']]) {
        const made = close.overnight && (!open.overnight || open.overnight[side] !== close.overnight[side]) && close.overnight[side] === (side === 'high' ? c.h : c.l);
        // A candle that made the overnight extreme is read against the one before it (as it stood at its open), never
        // its own: the relation shown is the one to that earlier value, and none without one.
        if (made && k in c.levels) {
          assert.ok(open.overnight, `${tf} ${c.t}: no ${k} before it`);
          const r = relation(c, open.overnight[side], NaN);
          assert.notStrictEqual(r.relation, 'none');
          if (r.relation !== 'touched' && c.o !== open.overnight[side]) assert.strictEqual(c.levels[k], RELATION_TEXT[r.relation][r.dir], `${tf} ${c.t}`);
        }
        checked += 1;
      }
      // The opening range or IB that formed inside it is no level for it.
      if (!open.openingRange) assert.ok(!Object.keys(c.levels).some(x => /^opening range/.test(x)), `${tf} ${c.t}: ${JSON.stringify(c.levels)}`);
      if (!open.ib || open.ib.high === null || open.ib.high === undefined) assert.ok(!Object.keys(c.levels).some(x => /^IB/.test(x)), `${tf} ${c.t}`);
      assert.ok(Object.keys(c.levels).length <= 4, 'at most four relations');
    }
  }
  assert.ok(checked > 50, `${checked}`);
});

test('the first candles after the opening range forms react to it (complete at their open): the 09:45 candles on the golden days, the 04-23 and 04-24 rejections', () => {
  const G = require('../fixtures/golden-bars');
  const s = G.SERIES.find(x => x.label === 'MNQ 3m');
  const bars = G.load(s).map(({ ms: _ms, ...x }) => x);
  const etOf = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const at957 = day => bars.findIndex(b => etOf(b.t) === `${day}, 09:57`);
  const brief = i => B.buildBriefing({ symbol: s.symbol, bars: bars.slice(0, i + 1), minutes: 3, blackouts: { items: [] } }).sections.m3.data;
  // 04-23: the 09:45-10:00 15m candle traded to 27102.75 and closed 27016.75, back below the opening range high 27068.
  const d23 = brief(at957('04-23'));
  assert.strictEqual(d23.today.openingRange.high, 27068);
  assert.deepStrictEqual([d23.candles['15m'].h, d23.candles['15m'].c], [27102.75, 27016.75]);
  assert.strictEqual(d23.candles['15m'].levels['opening range high'], 'rejected: closed back below');
  // 04-24: down to 27130.25, closed 27193.75, back above the opening range low 27176.25.
  const d24 = brief(at957('04-24'));
  assert.strictEqual(d24.candles['15m'].levels['opening range low'], 'rejected: closed back above');
  // Every 09:45 candle (3m on the 09:45 bar, 15m on the 09:57 bar) whose range holds an opening-range edge lists it,
  // unless the cap of four took its place.
  let seen = 0;
  for (const day of ['04-23', '04-24', '04-27']) {
    for (const [i, tf] of [[at957(day) - 4, '3m'], [at957(day), '15m']]) {
      const d = brief(i);
      const c = d.candles[tf];
      assert.match(etOf(c.t), /09:45$/);
      const edges = ['high', 'low'].filter(k => d.today.openingRange[k] >= c.l && d.today.openingRange[k] <= c.h);
      for (const k of edges) {
        assert.ok(`opening range ${k}` in c.levels || c.moreLevels > 0, `${day} ${tf}: ${JSON.stringify(c.levels)}`);
        seen += 1;
      }
    }
  }
  assert.ok(seen >= 4, `${seen}`);
});

test('the briefing at a new session\'s first candle (18:00 ET, Sunday too) agrees with the rules: no last-session opening range, IB or overnight; the prior RTH day is the one that just closed', () => {
  const { levelsAsOf } = require('../../scripts/lib/trading/market-snapshot');
  const { relation, RELATION_TEXT } = require('../../scripts/lib/trading/candle-facts');
  const etHm = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const opens = BARS.map((b, i) => [i, etHm(b.t)]).filter(([, e]) => /18:00$/.test(e));
  assert.ok(opens.some(([, e]) => /^Sun/.test(e)));
  for (const [i, e] of opens) {
    const bars = at(i + 1);
    const c = build(i + 1).sections.m3.data.candles['3m'];
    assert.match(etHm(c.t), /18:00$/);
    assert.ok(!Object.keys(c.levels).some(n => /^(opening range|IB|overnight)/.test(n)), `${e}: ${JSON.stringify(c.levels)}`);
    // Its prior day: the RTH day that just closed (as the 18:00 bar's snapshot reads it), never the one before.
    const prior = levelsAsOf(bars, i).priorRth;
    const last = BARS.findLastIndex((x, k) => k < i && /15:57$/.test(etHm(x.t)));
    const before = last >= 0 ? levelsAsOf(bars, last).priorRth : null;
    assert.ok(prior, `${e}: a prior day`);
    if (before) assert.notStrictEqual(prior.day, before.day, `${e}: the prior day is the one that closed at 16:00`);
    for (const k of ['high', 'low', 'close']) {
      const r = relation(c, prior[k], NaN);
      const name = `prior RTH ${k}`;
      if (r.relation === 'none') assert.ok(!(name in c.levels));
      else if (r.relation !== 'touched' && c.o !== prior[k]) assert.ok(!(name in c.levels) ? c.moreLevels > 0 : c.levels[name] === RELATION_TEXT[r.relation][r.dir], `${e} ${name}`);
    }
  }
});

test('an 18:00 candle that trades through the last session\'s overnight range shows no stale overnight, IB or opening-range reaction (the session guard)', () => {
  const G = require('../fixtures/golden-bars');
  const s = G.SERIES.find(x => x.label === 'MNQ 3m');
  // A copy of the fixture's bars (never the golden data): Sunday's 18:00 bar's low pushed down through Friday's
  // overnight high and IB, so without the guard the bar would read as rejecting them.
  const bars = G.load(s).map(({ ms: _ms, ...x }) => ({ ...x }));
  const etOf = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const i = bars.findIndex(b => etOf(b.t) === 'Sun 18:00');
  assert.ok(i > 0, 'a Sunday open in the fixture');
  bars[i] = { ...bars[i], l: 27360 };
  const { levelsAsOf } = require('../../scripts/lib/trading/market-snapshot');
  const before = levelsAsOf(bars, i - 1);
  // The edit makes the bar trade through the last session's overnight high (its open above it, its close above it).
  assert.ok(before.overnight && bars[i].l < before.overnight.high && bars[i].c > before.overnight.high && bars[i].o > before.overnight.high, JSON.stringify(before.overnight));
  const c = B.buildBriefing({ symbol: s.symbol, bars: bars.slice(0, i + 1), minutes: 3, blackouts: { items: [] } }).sections.m3.data.candles['3m'];
  assert.match(etOf(c.t), /^Sun 18:00$/);
  assert.ok(!Object.keys(c.levels).some(n => /^(overnight|IB|opening range)/.test(n)), JSON.stringify(c.levels));
});
