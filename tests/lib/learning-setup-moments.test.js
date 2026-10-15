'use strict';

// Setup-focused practice's bar selector (scripts/lib/learning/setup-moments.js): the config, the reactions it counts,
// the reaction and confirmation window, the seeded quiet sample, management first, and causality on fixture bars.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../fixtures/golden-bars');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const M = require('../../scripts/lib/learning/setup-moments');

const candle = (extra = {}) => ({ t: '2026-04-27T14:30:00.000Z', closedAt: '2026-04-27T14:45:00.000Z', relations: [], fvgRelations: [], sweep: null, ...extra });
const CLOSE = Date.parse('2026-04-27T14:45:00.000Z');

test('validatePractice: defaults filled, every field checked, unknown keys refused', () => {
  assert.deepStrictEqual(M.validatePractice(undefined), { practice: null, errors: [] });
  assert.deepStrictEqual(M.validatePractice({}).practice, { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 0, levels: 'key', reactions: ['rejected', 'broke'] });
  assert.deepStrictEqual(M.validatePractice({ setupTf: 60, reactions: ['broke', 'rejected', 'broke'], seed: 7 }).practice.reactions, ['rejected', 'broke']);
  for (const bad of [[], 'x', { mode: 'full' }, { setupTf: 3 }, { quietSample: 1.5 }, { quietSample: '0.1' }, { seed: 1.5 }, { levels: 'all' }, { reactions: [] }, { reactions: ['touched'] }, { extra: 1 }]) {
    const r = M.validatePractice(bad);
    assert.strictEqual(r.practice, null, JSON.stringify(bad));
    assert.ok(r.errors.length, JSON.stringify(bad));
  }
});

test('reactionsOf: fixed key levels and gap edges by default; moving, previous-candle and sweeps only with levels wide', () => {
  const c = candle({
    relations: [
      { name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down' },
      { name: 'VWAP (session)', price: 99, rel: 'broke', dir: 'up' },
      { name: 'previous 15m high', price: 101, rel: 'rejected', dir: 'down' },
      { name: 'previous 15m low', price: 95, rel: 'broke', dir: 'down' },
      { name: 'overnight low', price: 94, rel: 'touched', dir: null },
      { name: 'round number 100', price: 100, rel: 'rejected', dir: 'down' },
    ],
    fvgRelations: [{ name: '15m fvg low', price: 97, side: 'bull', rel: 'broke', dir: 'down' }],
    sweep: { of: 'previous 15m high', closedBack: true, closedBeyond: null },
  });
  assert.deepStrictEqual(M.reactionsOf(c).map(r => `${r.kind}:${r.name}:${r.rel}`), ['level:prior VAH:rejected', 'fvg:15m fvg low:broke']);
  assert.deepStrictEqual(M.reactionsOf(c, { levels: 'wide' }).map(r => `${r.kind}:${r.name}:${r.rel}`), ['level:prior VAH:rejected', 'level:VWAP (session):broke', 'previous:previous 15m high:rejected', 'fvg:15m fvg low:broke', 'sweep:previous 15m high:swept']);
  assert.deepStrictEqual(M.reactionsOf(c, { reactions: ['broke'] }).map(r => r.name), ['15m fvg low']);
  assert.strictEqual(M.reactionsOf(c, { levels: 'wide' }).at(-1).dir, 'down', 'a swept high closed back: down');
  assert.deepStrictEqual(M.reactionsOf(null), []);
});

test('setupMoment: reaction on the closing bar, confirmation after it, none without a key level, unavailable said', () => {
  const candles = { '15m': candle({ relations: [{ name: 'IB high', price: 100, rel: 'broke', dir: 'up' }] }) };
  const rx = M.setupMoment(candles, { setupTf: 15, barClose: CLOSE });
  assert.strictEqual(rx.moment, true);
  assert.strictEqual(rx.phase, 'reaction');
  assert.match(rx.reason, /15m broke IB high, reaction/);
  assert.strictEqual(M.setupMoment(candles, { barClose: new Date(CLOSE + 6 * 60000).toISOString() }).phase, 'confirmation');
  const quiet = M.setupMoment({ '15m': candle() }, { barClose: CLOSE });
  assert.deepStrictEqual([quiet.available, quiet.moment, quiet.phase], [true, false, null]);
  const none = M.setupMoment({ '15m': { unavailable: 'no completed candle in the bars yet' } }, { barClose: CLOSE });
  assert.deepStrictEqual([none.available, none.moment], [false, false]);
  assert.match(none.reason, /no completed candle in the bars yet/);
  assert.strictEqual(M.setupMoment({ '15m': candle({ relations: [{ name: 'IB high', price: 1, rel: 'broke', dir: 'up' }] }) }, { setupTf: 60, barClose: CLOSE }).available, false, 'the 1h candle is read for setupTf 60');
});

test('quietPick: deterministic by seed, symbol and bar; about the rate; 0 and 1 are none and all', () => {
  const bars = Array.from({ length: 4000 }, (_, i) => new Date(CLOSE + i * 180000).toISOString());
  const pick = seed => bars.filter(bar => M.quietPick({ seed, symbol: 'MNQ', bar, rate: 0.15 }));
  assert.deepStrictEqual(pick(1), pick(1), 'the same seed picks the same bars');
  assert.notDeepStrictEqual(pick(1), pick(2), 'another seed picks others');
  const share = pick(1).length / bars.length;
  assert.ok(share > 0.12 && share < 0.18, `share ${share}`);
  assert.strictEqual(bars.filter(bar => M.quietPick({ seed: 1, symbol: 'MNQ', bar, rate: 0 })).length, 0);
  assert.strictEqual(bars.filter(bar => M.quietPick({ seed: 1, symbol: 'MNQ', bar, rate: 1 })).length, bars.length);
});

test('selectBar: management first, then a moment, an unreadable setup candle runs, then the quiet sample, else none', () => {
  const practice = M.validatePractice({ quietSample: 0 }).practice;
  const moment = { '15m': candle({ relations: [{ name: 'overnight low', price: 1, rel: 'rejected', dir: 'up' }] }) };
  const flat = { '15m': candle() };
  const base = { practice, symbol: 'MNQ', bar: '2026-04-27T14:42:00.000Z', barClose: CLOSE };
  assert.strictEqual(M.selectBar({ ...base, candles: flat, open: true }).why, 'manage');
  assert.strictEqual(M.selectBar({ ...base, candles: moment }).why, 'moment');
  assert.deepStrictEqual(M.selectBar({ ...base, candles: null }).run, true);
  assert.strictEqual(M.selectBar({ ...base, candles: null }).why, 'unavailable');
  const skip = M.selectBar({ ...base, candles: flat });
  assert.deepStrictEqual([skip.run, skip.why], [false, 'none']);
  assert.strictEqual(M.selectBar({ ...base, practice: { ...practice, quietSample: 1 }, candles: flat }).why, 'quiet');
  assert.match(M.practiceLine(practice), /setup-focused practice: cycles only at 15m candles that rejected or broke a fixed key level/);
});

// The fixture bars (tests/fixtures/parity NQ 3m), briefed bar by bar as the runner briefs them.
const BARS = G.load(G.SERIES[0]).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
const candlesAt = (bars, i) => buildBriefing({ symbol: 'MNQ', bars: bars.slice(Math.max(0, i - 500), i + 1), minutes: 3, now: new Date(Date.parse(bars[i].t) + 180000) }).sections.m3.data.candles;
const closeOf = (bars, i) => Date.parse(bars[i].t) + 180000;

test('on fixture bars: a real reaction is found on the bar that completes it, and its window runs to the next 15m close', () => {
  const practice = M.validatePractice({ quietSample: 0 }).practice;
  // A 15m close in the fixture's RTH whose candle reacted at a fixed key level.
  let found = null;
  for (let i = 900; i < 1100 && !found; i += 1) {
    if (closeOf(BARS, i) % (15 * 60000) !== 0) continue;
    const s = M.selectBar({ practice, candles: candlesAt(BARS, i), symbol: 'MNQ', bar: BARS[i].t, barClose: closeOf(BARS, i) });
    if (s.why === 'moment') found = { i, s };
  }
  assert.ok(found, 'a reaction in the fixture');
  assert.strictEqual(found.s.moment.phase, 'reaction');
  assert.ok(found.s.moment.reactions.every(r => r.kind === 'fvg' || M.KEY_LEVEL.test(r.name)), JSON.stringify(found.s.moment.reactions));
  const windowOf = k => M.selectBar({ practice, candles: candlesAt(BARS, found.i + k), symbol: 'MNQ', bar: BARS[found.i + k].t, barClose: closeOf(BARS, found.i + k) });
  for (let k = 1; k <= 4; k += 1) {
    const w = windowOf(k);
    assert.deepStrictEqual([w.why, w.moment.phase, w.moment.candle.closedAt], ['moment', 'confirmation', found.s.moment.candle.closedAt], `bar +${k}`);
  }
  // The next 15m close supersedes it: the candle read is the new one.
  assert.notStrictEqual(windowOf(5).moment.candle.closedAt, found.s.moment.candle.closedAt);
});

test('causal: a bar\'s selection never changes when the bars after it change (cut-bar test)', () => {
  const practice = M.validatePractice({ quietSample: 0.15, seed: 3 }).practice;
  const cut = 1000;
  // Every bar after the cut moved far away: a selector reading the future would change its answers.
  const changed = BARS.map((b, i) => (i <= cut ? b : { ...b, o: b.o + 400, h: b.h + 900, l: b.l - 900, c: b.c - 400 }));
  for (let i = cut - 12; i <= cut; i += 1) {
    const a = M.selectBar({ practice, candles: candlesAt(BARS, i), symbol: 'MNQ', bar: BARS[i].t, barClose: closeOf(BARS, i) });
    const b = M.selectBar({ practice, candles: candlesAt(changed.slice(0, cut + 40), i), symbol: 'MNQ', bar: BARS[i].t, barClose: closeOf(BARS, i) });
    assert.deepStrictEqual(b, a, `bar ${i}`);
  }
});
