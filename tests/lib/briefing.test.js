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

test('invalidation: a close through a section\'s level, or a range spike, recomputes it before it expires', () => {
  // A bar whose next bar is inside the same 15m and 1h candle, so nothing expires: only invalidation can refresh.
  let n = 1300;
  while (Date.parse(build(n).sections.m15.validUntil) <= Date.parse(build(n + 1).closedAt) || Date.parse(build(n).sections.h1.validUntil) <= Date.parse(build(n + 1).closedAt)) n += 1;
  const prev = build(n);
  assert.strictEqual(build(n + 1, prev).sections.m15.version, prev.sections.m15.version, 'control: kept');
  const [name, price] = prev.sections.m15.levels[0];
  // The previous close put on the other side of the level the section rests on.
  const crossed = { ...prev, price: price + (BARS[n].c > price ? -1000 : 1000) };
  const b = build(n + 1, crossed);
  assert.strictEqual(b.sections.m15.reason, `a close through the ${name} ${price}`);
  assert.notStrictEqual(b.sections.m15.version, prev.sections.m15.version);
  // A spike: a bar whose range is over twice ATR(14) refreshes m15 and h1, not the day's levels.
  const bars = at(n + 1).map(x => ({ ...x }));
  const last = bars[bars.length - 1];
  last.h = last.c + 500; last.l = last.c - 500;
  const spiked = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, prev });
  for (const s of ['m15', 'h1']) assert.match(spiked.sections[s].reason, /^a bar range of \d/, s);
  assert.strictEqual(spiked.sections.day.version, prev.sections.day.version, 'the day\'s levels stand');
});

test('another symbol, bar size, or an older briefing is never reused', () => {
  const prev = build(1300);
  for (const p of [{ ...prev, symbol: 'ES' }, { ...prev, minutes: 1 }, { ...prev, closedAt: '2099-01-01T00:00:00.000Z' }]) {
    const b = build(1301, p);
    for (const name of B.SECTIONS) assert.strictEqual(b.sections[name].reason, 'new', name);
  }
});

test('m3 holds the per-bar facts: ET time and window, VWAP side, location against the cached levels, the scan\'s candidates', () => {
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: ['bos'], against: [] } }, { name: 'bos', candidate: false }];
  const b = build(1300, null, { scan });
  const d = b.sections.m3.data;
  assert.match(d.et, /^\d{2}:\d{2}$/);
  assert.ok(B.WINDOWS.some(w => w[2] === d.window));
  assert.ok(['above', 'below'].includes(d.vwap.side));
  assert.ok(['above', 'below'].includes(d.priceVsEmaFast));
  assert.deepStrictEqual(d.candidates, [{ name: 'orb', direction: 'long', status: 'active', confluence: { with: ['bos'], against: [] } }]);
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
  assert.match(barBriefing({ symbol: 'ES' }, { env }).text, /No bar briefing for ES yet/);
  assert.throws(() => barBriefing({ symbol: '../x' }, { env }), /--symbol/);
  fs.writeFileSync(B.briefingFile(home, 'ES'), '{not json');
  assert.strictEqual(B.readBriefing(home, 'ES'), null);
});
