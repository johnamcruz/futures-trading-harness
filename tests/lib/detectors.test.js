'use strict';

// The setup detectors (scripts/lib/trading/detectors): pure rules over one bar briefing that compose existing reads
// (named levels, rejected and broke relations, engulfing patterns, stops, targets, the room rule) into the with-trend
// plan the real check and plan pass, or say why not. Not wired into the briefing.

const test = require('node:test');
const assert = require('node:assert');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');
const D = require('../../scripts/lib/trading/detectors/index');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { planOf, stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const FX = require('../fixtures/trend-moves');

const PLAN = { size: 1, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: stopRuleOf({ stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 }), suggestion: false };
const CTX = { tick: 0.25, plan: PLAN };
const brief = (edit = () => {}) => { const b = scenario1(); b.sections.m3.data.windowEntries = 'allowed'; edit(b); return b; };
/** A firing's reads pass the real check and plan on the same briefing. */
function passes(d, b, side) {
  const ch = checkReads({ reads: d.reads.map(r => ({ step: r.step, skill: r.skill || 'x', read: r.read })), side, briefing: b, tick: 0.25 });
  const p = planOf({ checked: ch, briefing: b, side, tick: 0.25, ...PLAN });
  return ch.ok && Boolean(p.plan) && p.problems.every(x => /^size/.test(x));
}

test('detectors: rejection: the 15m rejection of a named level the trend\'s way, a later close the trend\'s way, the stop beyond the 15m candle', () => {
  const b = brief();
  const d = D.detect('rejection', b, 'long', CTX);
  assert.strictEqual(d.fires, true, d.why);
  assert.deepStrictEqual([d.setupRead, d.level, d.tf, d.entryRead, d.stop], ['15m rejected prior vah up', 'prior vah', '15m', '3m close top', 'stop 15m low 21512.75']);
  assert.ok(d.rr >= 2 && passes(d, b, 'long'));
});

test('detectors: breakout: the 15m break of a named level, entered only on a 3m close that holds beyond it', () => {
  const b = brief();
  const d = D.detect('breakout', b, 'long', CTX);
  assert.deepStrictEqual([d.fires, d.setupRead], [true, '15m broke vwap rth up']);
  assert.ok(passes(d, b, 'long'));
  // The 3m closed back under the level: no hold, no entry.
  const back = brief(x => { x.sections.m3.data.candles['15m'].relations = [{ name: 'VWAP (rth)', price: 21541, rel: 'broke', dir: 'up' }]; });
  assert.strictEqual(D.detect('breakout', back, 'long', CTX).fires, false);
});

test('detectors: the 15m engulfing at a level, closing in its trend third: the 3m entry, the stop beyond the 15m candle or the 3m one', () => {
  const eng = brief(x => { const c = x.sections.m3.data.candles['15m']; c.patterns = ['bullish engulfing']; c.closeLocation = 'top'; });
  const wide = D.detect('engulf-15m', eng, 'long', CTX);
  assert.deepStrictEqual([wide.fires, wide.setupRead, wide.stop], [true, '15m pattern bullish engulfing', 'stop 15m low 21512.75']);
  assert.ok(passes(wide, eng, 'long'));
  const tight = D.detect('engulf-15m-3m', eng, 'long', CTX);
  assert.deepStrictEqual([tight.fires, tight.stop], [true, 'stop 3m low 21529.75']);
  assert.ok(passes(tight, eng, 'long'));
  // Not in its trend-side third, or no engulfing: none.
  assert.strictEqual(D.detect('engulf-15m', brief(x => { const c = x.sections.m3.data.candles['15m']; c.patterns = ['bullish engulfing']; c.closeLocation = 'middle'; }), 'long', CTX).fires, false);
  assert.strictEqual(D.detect('engulf-15m', brief(), 'long', CTX).fires, false);
  // One contract over the cap (the $300 at a stop that wide): capped, never fired.
  const capped = D.detect('engulf-15m', eng, 'long', { tick: 0.25, plan: { ...PLAN, maxRiskUsd: 10 } });
  assert.deepStrictEqual([capped.fires, capped.capped], [false, true]);
});

test('detectors: none fires where the gate would refuse the side (the window shut, the trend rule against)', () => {
  for (const name of Object.keys(D.RULES)) {
    assert.strictEqual(D.detect(name, brief(b => { b.sections.m3.data.windowEntries = 'none'; }), 'long', CTX).fires, false, name);
    assert.strictEqual(D.detect(name, brief(), 'short', CTX).fires, false, `${name}: the trend rule allows no short`);
  }
  assert.throws(() => D.detect('nope', brief(), 'long', CTX), /no detector nope/);
});

test('detectors: the momentum-onset facts are the existing reads the trend\'s way (CISD, engulfing, volume high, momentum)', () => {
  assert.deepStrictEqual(D.onset(brief(), 'long'), { cisd: true, engulfing: false, volume: true, momentum: true });
  assert.deepStrictEqual(D.onset(brief(), 'short'), { cisd: false, engulfing: false, volume: true, momentum: false });
});

test('detectors: no look-ahead: a bar\'s verdict is the same from its own briefing however much later data exists', () => {
  const { bars } = FX.load();
  const t = '2021-05-05T14:27:00.000Z';
  const k = bars.m3.findIndex(b => b.t === t);
  const close = Date.parse(t) + 180000;
  const own = buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.m3.slice(0, k + 1), minutes: 3, fineBars: bars.m1.filter(b => Date.parse(b.t) + 60000 <= close), roundSteps: defaultRoundSteps(), now: new Date(close) });
  for (const name of Object.keys(D.RULES)) {
    for (const side of ['long', 'short']) assert.deepStrictEqual(D.detect(name, own, side, CTX), D.detect(name, FX.briefingAt(t), side, CTX), `${name} ${side}`);
  }
  for (const c of Object.values(own.sections.m3.data.candles)) if (c && c.closedAt) assert.ok(Date.parse(c.closedAt) <= close);
});

test('detectors wired: breakout with any 2 of the 4 onset facts, then rejection with momentum; the line plans what the check passes', () => {
  assert.deepStrictEqual(D.WIRED, [{ rule: 'breakout', onset: 'any 2 of 4' }, { rule: 'rejection', onset: 'momentum' }]);
  const b = brief();
  const ctx = D.wiredContext('MNQ');
  assert.deepStrictEqual([ctx.tick, ctx.plan.size, ctx.plan.tickValue, ctx.plan.minRR, ctx.plan.maxRiskUsd], [0.25, 1, 0.5, 2, 300]);
  const w = D.wiredPlan(b, 'long', ctx);
  assert.deepStrictEqual([w.rule, w.onset, w.setupRead], ['breakout', 'any 2 of 4', '15m broke vwap rth up']);
  assert.ok(passes(w, b, 'long'));
  const line = D.detectedLine(b, { et: () => '11:00' });
  assert.match(line, /^- Trend setups \(code, at a named level, the trend's way, as compose_check plans them; closed 11:00\): long "15m broke vwap rth up" \(breakout, momentum onset the trend's way\): plan OK: entry 21540\.25, stop [\d.]+ \(\d+t\), target [\d.]+, R:R [\d.]+; reads "[^"]+"(, "[^"]+")+\. OK -> compose_check with its reads; never estimate R:R\.$/);
  // Its filter off (no onset fact): no line; a side the standard plan already plans is skipped.
  // One onset fact only (the 15m CISD; no volume, no momentum): neither wired rule's filter holds.
  const flat = brief(x => { const c = x.sections.m3.data.candles['3m']; c.volRatio = 1; c.rangeAtr = 0.5; x.sections.m3.data.candles['15m'].volRatio = 1; });
  assert.deepStrictEqual(D.onset(flat, 'long'), { cisd: true, engulfing: false, volume: false, momentum: false });
  assert.strictEqual(D.wiredPlan(flat, 'long', ctx), null);
  assert.strictEqual(D.detectedLine(b, { skip: ['long'] }), null);
  assert.strictEqual(D.detectedLine({ ...b, symbol: 'ZZZ' }), null, 'no contract facts: none');
});

test('detectors wired: the opening range\'s and the initial balance\'s levels are none of the rejection or the breakout', () => {
  const or = brief(x => { x.sections.m3.data.candles['15m'].relations = [{ name: 'opening range high', price: 21530, rel: 'broke', dir: 'up' }, { name: 'IB high', price: 21533, rel: 'rejected', dir: 'up' }]; });
  for (const name of ['breakout', 'rejection']) assert.strictEqual(D.detect(name, or, 'long', CTX).fires, false, name);
});
