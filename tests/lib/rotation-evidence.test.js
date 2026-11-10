'use strict';

// The Rotation evidence line (trading/rotation-evidence.js in trading/briefing.js): four facts the briefing already
// computes, restated side by side as values (the RTH VWAP crosses of the VWAP line, the IB day type, the setup and entry
// candles' inside or doji, a 3m/5m/15m failed break of the previous high or low). No verdict, no threshold of its own;
// unknown is said as unknown, never 0 or no; only from the closed bars the briefing is built on; rendered text only (no
// new briefing field), so nothing the gate, compose_check or order_plan reads changes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/trading/rotation-evidence');
const B = require('../../scripts/lib/trading/briefing');
const { dayType } = require('../../scripts/lib/trading/day-context');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
// 2026-04-27 (the file's 3rd RTH session): the 10:57 ET bar (closed 11:00), the 09:36 ET bar, a Globex bar.
const RTH_N = 1254;
const EARLY_N = 1227;
const GLOBEX_N = 1000;
const FRAMES = { setup: '15m', entry: '3m' };
const clone = x => JSON.parse(JSON.stringify(x));
const build = (n, extra = {}) => B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, n), minutes: 3, ...extra });
const lineOf = text => text.split('\n').filter(l => l.startsWith('- Rotation evidence'));

const candle = (pattern, extra = {}) => ({ closedAt: 'x', pattern, sweep: null, ...extra });
const M3 = {
  vwap: { rthCrossesLast30: 7 },
  today: { dayType: 'neutral' },
  candles: {
    '3m': candle('doji', { sweep: { of: 'previous 3m high', closedBack: true, closedBeyond: null } }),
    '5m': candle('none', { sweep: { of: 'previous 5m low', closedBack: false, closedBeyond: 'low' } }),
    '15m': candle('bullish engulfing', { patterns: ['bullish engulfing', 'outside'], sweep: { of: 'previous 15m high and low', closedBack: true, closedBeyond: null } }),
  },
};

test('rotation evidence: the values as the briefing holds them, in a closed vocabulary', () => {
  assert.deepStrictEqual(R.rotationEvidence(M3, FRAMES), {
    vwapCrosses: 7, dayType: 'neutral', setupCandle: 'neither', entryCandle: 'doji',
    failedBreak: { '3m': 'high', '5m': 'no', '15m': 'high and low' },
  });
  // An inside pattern hidden behind a higher label is read from `patterns` (every pattern that holds).
  const both = clone(M3);
  both.candles['15m'] = candle('bearish engulfing', { patterns: ['bearish engulfing', 'inside', 'doji'] });
  both.candles['3m'] = candle('hammer', { patterns: ['hammer', 'doji'] });
  const e = R.rotationEvidence(both, FRAMES);
  assert.strictEqual(e.setupCandle, 'inside and doji');
  assert.strictEqual(e.entryCandle, 'doji');
  both.candles['15m'] = candle('inside');
  assert.strictEqual(R.rotationEvidence(both, FRAMES).setupCandle, 'inside');
  // The frames are the caller's (the chain's setup and entry frames).
  assert.strictEqual(R.rotationEvidence(M3, { setup: '3m', entry: '15m' }).setupCandle, 'doji');
  // Zero crosses is a value, said as 0.
  assert.strictEqual(R.rotationEvidence({ ...M3, vwap: { rthCrossesLast30: 0 } }, FRAMES).vwapCrosses, 0);
});

test('rotation evidence: anything missing, unavailable or off the vocabulary is unknown, never 0 or no', () => {
  const U = { vwapCrosses: null, dayType: null, setupCandle: null, entryCandle: null, failedBreak: { '3m': null, '5m': null, '15m': null } };
  assert.deepStrictEqual(R.rotationEvidence({}, FRAMES), U);
  assert.deepStrictEqual(R.rotationEvidence(null, FRAMES), U);
  assert.deepStrictEqual(R.rotationEvidence({ candles: 'not computed', vwap: { rthCrossesLast30: null }, today: { dayType: null } }, FRAMES), U);
  const odd = { vwap: { rthCrossesLast30: -1 }, today: { dayType: 'sideways' }, candles: {
    '3m': { unavailable: 'too few bars' }, '5m': { unavailable: 'not whole 3m bars; no 1m bars configured' },
    '15m': candle(undefined, { sweep: { of: 'previous 15m middle', closedBack: true } }),
  } };
  assert.deepStrictEqual(R.rotationEvidence(odd, FRAMES), U);
  for (const v of [1.5, NaN, '3', Infinity]) assert.strictEqual(R.rotationEvidence({ vwap: { rthCrossesLast30: v } }, FRAMES).vwapCrosses, null, String(v));
  // A candle with no sweep field at all (an older briefing) is unknown; sweep null (stayed inside) is no.
  assert.strictEqual(R.rotationEvidence({ candles: { '3m': { pattern: 'none' } } }, FRAMES).failedBreak['3m'], null);
  assert.strictEqual(R.rotationEvidence({ candles: { '3m': { pattern: 'none', sweep: null } } }, FRAMES).failedBreak['3m'], 'no');
  // An unavailable frame is unknown whatever else it carries.
  const gone = R.rotationEvidence({ candles: { '3m': { unavailable: 'x', pattern: 'inside', sweep: null } } }, FRAMES);
  assert.deepStrictEqual([gone.entryCandle, gone.failedBreak['3m']], [null, null]);
  const line = R.rotationLine(U, FRAMES);
  assert.ok(!/\b0\b|\bno\b|neither/.test(line), line);
  assert.strictEqual(line, '- Rotation evidence (values, not a verdict): RTH VWAP crosses unknown (the VWAP line\'s count); IB day type unknown; '
    + '15m setup candle unknown, 3m entry candle unknown; failed break (swept the previous high or low, closed back inside): 3m unknown, 5m unknown, 15m unknown.');
});

test('rotation evidence: the day types are day-context\'s, every one', () => {
  const seen = new Set();
  for (const [hi, lo] of [[110, 90], [130, 90], [104, 90], [100, 70], [100, 85], [110, 80], [100, 96], [100, 90]]) seen.add(dayType(100, 90, hi, lo));
  seen.add(dayType(100, 90, 112, 90, 100));
  assert.deepStrictEqual([...seen].sort(), [...R.DAY_TYPES].sort());
  for (const d of R.DAY_TYPES) assert.strictEqual(R.rotationEvidence({ today: { dayType: d } }, FRAMES).dayType, d);
});

test('rotation evidence: the line says the values and nothing to do with them', () => {
  const line = R.rotationLine(R.rotationEvidence(M3, FRAMES), FRAMES);
  assert.strictEqual(line, '- Rotation evidence (values, not a verdict): RTH VWAP crosses 7 (the VWAP line\'s count); IB day type neutral; '
    + '15m setup candle neither, 3m entry candle doji; failed break (swept the previous high or low, closed back inside): 3m high, 5m no, 15m high and low.');
  // No verdict, no advice, no threshold.
  assert.doesNotMatch(line, /\b(chop|range day|trend day|skip|pass|take|wait|avoid|should|weak|strong|rotational|likely)\b/i);
  assert.strictEqual(R.rotationLine(null, FRAMES), null);
});

test('in the briefing: one summary line after Trend declared?, in RTH on the runner\'s briefing only, never in the detail', () => {
  const b = build(RTH_N);
  const m3 = b.sections.m3.data;
  const text = B.renderBriefing(b);
  const lines = lineOf(text);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], R.rotationLine(R.rotationEvidence(m3, FRAMES), FRAMES));
  // The values are the briefing's own: the VWAP line's RTH count, the day type, the 15m inside, the 3m broke and held.
  assert.ok(text.includes(`the RTH VWAP ${m3.vwap.rthCrossesLast30}, `));
  assert.match(lines[0], new RegExp(`RTH VWAP crosses ${m3.vwap.rthCrossesLast30} .*IB day type ${m3.today.dayType};`));
  assert.match(lines[0], /15m setup candle inside, 3m entry candle neither; .*: 3m no, 5m unknown, 15m no\.$/);
  const at = s => text.indexOf(s);
  assert.ok(at('- Trend declared?') < at('- Rotation evidence') && at('- Rotation evidence') < at('Detail by timeframe:'));
  assert.ok(!/Rotation evidence|rotation/i.test(text.slice(at('Detail by timeframe:'))), 'no detail field');
  // Only the line is new: the rest of the text is what it was without it (no soFar: no line, all else equal).
  const t2 = clone(b);
  delete t2.sections.m3.data.today.soFar;
  const strip = s => s.split('\n').filter(l => !l.startsWith('- Rotation evidence') && !l.startsWith('- Day so far'));
  assert.deepStrictEqual(strip(B.renderBriefing(t2)), strip(text));
  assert.strictEqual(lineOf(B.renderBriefing(t2)).length, 0);
  // Early RTH: still one line (unknown day type before the IB); outside RTH and in a frame's briefing: none.
  const early = lineOf(B.renderBriefing(build(EARLY_N)));
  assert.strictEqual(early.length, 1);
  assert.match(early[0], /IB day type unknown;/);
  assert.strictEqual(lineOf(B.renderBriefing(build(GLOBEX_N))).length, 0);
  const f = B.buildFrameBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, RTH_N), minutes: 15, first: b });
  assert.strictEqual(lineOf(B.renderFrameBriefing(f, b)).length, 0);
});

test('no look-ahead: 1m bars after the cycle bar\'s close (poisoned) never change the line; later 3m bars are never read', () => {
  // A 1m lane builds the 5m candle; split each 3m bar into three 1m bars.
  const ones = [];
  for (const x of BARS.slice(0, RTH_N)) {
    const t = Date.parse(x.t);
    ones.push({ t: new Date(t).toISOString(), o: x.o, h: x.h, l: x.l, c: x.o, v: 1 });
    ones.push({ t: new Date(t + 60000).toISOString(), o: x.o, h: Math.max(x.o, x.c), l: Math.min(x.o, x.c), c: x.c, v: 1 });
    ones.push({ t: new Date(t + 120000).toISOString(), o: x.c, h: x.c, l: x.c, c: x.c, v: Math.max(1, x.v - 2) });
  }
  const last = Date.parse(BARS[RTH_N - 1].t) + 180000;
  // Wild bars after the close: a 5m candle built from them would sweep and close back inside.
  const poison = Array.from({ length: 30 }, (_, i) => ({ t: new Date(last + i * 60000).toISOString(), o: 1, h: 99999, l: 1, c: i % 2 ? 99999 : 1, v: 1e6 }));
  const clean = lineOf(B.renderBriefing(build(RTH_N, { fineBars: ones })));
  const dirty = lineOf(B.renderBriefing(build(RTH_N, { fineBars: [...ones, ...poison] })));
  assert.strictEqual(clean.length, 1);
  assert.doesNotMatch(clean[0], /5m unknown/, 'the 1m lane builds the 5m candle');
  assert.deepStrictEqual(dirty, clean);
  // The briefing at a bar from the bars cut at its close, and from a longer history cut the same: one line.
  assert.deepStrictEqual(lineOf(B.renderBriefing(build(RTH_N))), lineOf(B.renderBriefing(B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, RTH_N + 40).slice(0, RTH_N), minutes: 3 }))));
});

test('presented facts: rendered from fields the briefing already holds; no new field, and no decision path reads it', () => {
  // The line is text only: the briefing's JSON (what the gate, compose_check, order_plan and the trend rule read) holds
  // no new field, and only the renderer requires the module.
  const b = build(RTH_N);
  assert.doesNotMatch(JSON.stringify(b), /"rotation\w*"\s*:|evidence/i);
  const lib = path.join(ROOT, 'scripts', 'lib');
  const users = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && /rotation-evidence/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(lib, p).split(path.sep).join('/'));
    }
  };
  walk(lib);
  assert.deepStrictEqual(users, ['trading/briefing.js']);
});
