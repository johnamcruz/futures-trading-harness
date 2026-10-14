'use strict';

// This bar's close against the session's levels (trading/level-closes.js): the VWAP and opening-range crosses, the
// closes in a row beyond or back inside prior value, placed with their owners in the briefing (m3.vwap.crossed,
// m3.today.openingRangeCrossed, m3.location.closesBeyondValue / backInsideValue) and the OTE bounce with the CISD
// (m3.cisd.<tf>.bounce, cisd.js); each only when it happened; the same tests the rules language runs; causal; rendered
// as one summary line within its cap.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { normalizeBars, atr: atrOf } = require('../../scripts/lib/trading/indicators');
const { levelCloses, crossed, valueSide, MAX_CLOSES } = require('../../scripts/lib/trading/level-closes');
const { cisdFacts } = require('../../scripts/lib/trading/cisd');
const { compileRules, evaluateRules, seriesSource, causalLevels } = require('../../scripts/lib/trading/rules');
const vp = require('../../scripts/lib/trading/volume-profile');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const NQ = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const RTY = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'RTY-3m.csv'));
const at = (bars, i) => levelCloses(bars, i, { levels: causalLevels(bars) });

test('crossed: the close through a level this bar, from at or behind it; a missing level or a reset is no cross', () => {
  const bars = normalizeBars([10, 12, 9, 9, 11].map((c, k) => ({ t: new Date(Date.UTC(2026, 9, 7, 14, 3 * k)).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 1 })));
  assert.deepStrictEqual([1, 2, 3, 4].map(i => crossed(bars, [11, 11, 11, 9, NaN], i)), ['up', 'down', null, null]);
  assert.strictEqual(crossed(bars, [9, 9, 9, 9, 10], 4), 'up', 'from on it');
  assert.strictEqual(crossed(bars, [9, 9, 9, 9, 10], 4, () => true), null, 'a level that started over');
});

test('valueSide: strictly beyond is above or below, strictly between is inside, an edge is neither', () => {
  const va = { vah: 110, val: 100 };
  assert.deepStrictEqual([111, 110, 105, 100, 99].map(c => valueSide(c, va)), ['above', 'at', 'inside', 'at', 'below']);
});

/** Each fact against the rules language's own test, bar by bar: never a disagreement. */
function agreement(bars) {
  const get = seriesSource(bars, {}, { barMinutes: 3 });
  const fires = (long, short, i) => evaluateRules(compileRules({ long, short }).compiled, bars, {}, { index: i, get, values: false }).direction;
  const dir = d => (d === 'long' ? 'up' : d === 'short' ? 'down' : null);
  const levels = causalLevels(bars);
  const seen = { rth: 0, session: 0, or: 0, beyond: 0, inside: 0, bounce: 0 };
  for (let i = 60; i < bars.length; i += 1) {
    const f = levelCloses(bars, i, { levels });
    const vw = f.vwapCrossed || {};
    assert.strictEqual(vw.rth || null, dir(fires(['close crosses_above vwap_rth'], ['close crosses_below vwap_rth'], i)), `bar ${i} rth`);
    assert.strictEqual(vw.session || null, dir(fires(['close crosses_above vwap_session'], ['close crosses_below vwap_session'], i)), `bar ${i} session`);
    assert.strictEqual(f.openingRangeCrossed || null, dir(fires(['close crosses_above or_high'], ['close crosses_below or_low'], i)), `bar ${i} or`);
    const two = dir(fires(['close > prior_vah', 'close[1] > prior_vah'], ['close < prior_val', 'close[1] < prior_val'], i));
    const b = f.closesBeyondValue;
    assert.strictEqual(b && b.closes >= 2 ? (b.side === 'above' ? 'up' : 'down') : null, two, `bar ${i} beyond value`);
    for (const [k, x] of [['rth', vw.rth], ['session', vw.session], ['or', f.openingRangeCrossed], ['beyond', b], ['inside', f.backInsideValue]]) if (x) seen[k] += 1;
    // The OTE bounce, as the briefing's CISD block reads it on the bars cut at this close.
    const rule = dir(fires(['cisd_entry(15) > 0'], ['cisd_entry(15) < 0'], i));
    if (rule || i % 37 === 0) {
      const cut = bars.slice(0, i + 1);
      const c = cisdFacts(cut, 15, { levels: causalLevels(cut), atr: atrOf(cut, 20) });
      assert.strictEqual(c.bounce || null, rule, `bar ${i} bounce`);
      if (rule) seen.bounce += 1;
    }
  }
  return seen;
}

test('the same tests as the rules language (crosses of the VWAPs and the opening range, two closes beyond value, the OTE bounce), bar by bar, on two symbols', () => {
  const a = agreement(NQ);
  const b = agreement(RTY);
  for (const k of ['rth', 'session', 'or', 'beyond', 'bounce']) assert.ok(a[k] + b[k] > 0, `${k} happens on the golden days`);
});

test('back inside value: the RTH open beyond prior value, this RTH day\'s closes inside it in a row', () => {
  let found = 0;
  const levels = causalLevels(RTY);
  const prior = vp.profileSeries(RTY, 'prior_rth', { options: vp.DEFAULTS });
  for (let i = 60; i < RTY.length; i += 1) {
    const r = levelCloses(RTY, i, { levels }).backInsideValue;
    if (!r) continue;
    found += 1;
    const va = { vah: prior.vah[i], val: prior.val[i] };
    assert.ok(r.opened === 'above' ? levels.rth_open[i] > va.vah : levels.rth_open[i] < va.val, `bar ${i}`);
    assert.ok(r.closes >= 1 && r.closes <= MAX_CLOSES);
    for (let k = i; k > i - r.closes; k -= 1) assert.strictEqual(valueSide(RTY[k].c, va), 'inside');
  }
  assert.ok(found > 0, 'on the RTY golden days (2025-02-21 opened above value)');
});

test('back inside value counts only today\'s RTH closes: overnight closes inside value, then a gap open above', () => {
  // Day 1 (Oct 6) RTH: closes 99-101 make the prior value area around 100. Overnight: closes at 100, inside value.
  // Day 2 (Oct 7) 09:30: opens at 108, above value, and closes at 100, back inside: the first close, not the 200th.
  const rows = [];
  const add = (fromMs, n, f) => { for (let k = 0; k < n; k += 1) rows.push(f(fromMs + k * 180000, k)); };
  rows.push({ t: Date.UTC(2026, 9, 6, 13, 27), o: 100, h: 100.25, l: 99.75, c: 100, v: 10 }); // a bar before the RTH open: day 1 whole
  add(Date.UTC(2026, 9, 6, 13, 30), 130, (t, k) => { const c = 99 + (k % 3); return { t, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }; });
  add(Date.UTC(2026, 9, 6, 22, 0), 230, t => ({ t, o: 100, h: 100.25, l: 99.75, c: 100, v: 10 }));
  rows.push({ t: Date.UTC(2026, 9, 7, 13, 30), o: 108, h: 108, l: 99.5, c: 100, v: 300 });
  rows.push({ t: Date.UTC(2026, 9, 7, 13, 33), o: 100, h: 100.5, l: 99.5, c: 100.25, v: 300 });
  const bars = normalizeBars(rows.map(r => ({ ...r, t: new Date(r.t).toISOString() })));
  const i = bars.length - 2;
  assert.ok(Date.parse(bars[i].t) === Date.UTC(2026, 9, 7, 13, 30));
  assert.deepStrictEqual(at(bars, i).backInsideValue, { opened: 'above', closes: 1 });
  assert.deepStrictEqual(at(bars, i + 1).backInsideValue, { opened: 'above', closes: 2 });
  assert.strictEqual(at(bars, i - 1).backInsideValue, undefined, 'overnight: not in RTH');
});

test('no look-ahead: the facts at a bar are the same with the later bars present or cut at its close', () => {
  for (let i = 120; i < NQ.length; i += 23) assert.deepStrictEqual(at(NQ, i), at(NQ.slice(0, i + 1), i), `bar ${i}`);
});

test('in the briefing: with their owners only when they happened, said once in the summary line (within its cap), never in the detail', () => {
  const CLOSES_LINE_MAX = 200;
  let most = 0;
  let shown = 0;
  for (const bars of [NQ, RTY]) {
    for (let n = 300; n <= bars.length; n += 17) {
      const cut = bars.slice(0, n);
      const b = B.buildBriefing({ symbol: bars === NQ ? 'NQ' : 'RTY', bars: cut, minutes: 3, blackouts: { items: [] } });
      const d = b.sections.m3.data;
      const f = at(normalizeBars(cut), n - 1);
      assert.deepStrictEqual(d.vwap.crossed, f.vwapCrossed);
      assert.deepStrictEqual(d.today.openingRangeCrossed, f.openingRangeCrossed);
      assert.deepStrictEqual([d.location.closesBeyondValue, d.location.backInsideValue], [f.closesBeyondValue, f.backInsideValue]);
      const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
      const line = text.split('\n').find(l => l.startsWith('- This bar\'s close: '));
      assert.strictEqual(Boolean(line), Object.keys(f).length > 0);
      if (line) { shown += 1; most = Math.max(most, Buffer.byteLength(line)); }
      assert.doesNotMatch(text, /"crossed"|openingRangeCrossed|closesBeyondValue|backInsideValue/, 'not in the detail');
    }
  }
  assert.ok(shown > 10, `shown on ${shown} bars`);
  assert.ok(most <= CLOSES_LINE_MAX, `the line is at most ${most} bytes`);
});
