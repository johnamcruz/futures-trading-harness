'use strict';

/**
 * A cited setup end to end on real bars (tests/fixtures/momentum-continuation): the shipped scan fires
 * momentum_continuation on the census's 2021-05-24 09:48 ET candle; the bar briefing built from that scan lists it; the
 * model's reads cite it (`momentum_continuation fired up`) through compose_check, which records a market plan with its
 * own stop (one tick under the candle) and 2R target; order_plan gives the market order with those brackets; the order
 * gate's re-check lets exactly that order through, and refuses it where the scan did not fire (fails closed).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const FX = require('../fixtures/momentum-continuation');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { buildBriefing, writeBriefing } = require('../../scripts/lib/trading/briefing');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
const { readRecords } = require('../../scripts/lib/trading/trade-lifecycle');
const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { specFor } = require('../../scripts/lib/trading/contracts');
const { tmpDir, plan, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const ALL = loadStrategies(ROOT, {}).strategies;
const LIFECYCLE = ALL.find(s => s.name === 'trade_lifecycle');

/** The runner's world on the bar opened at `t`: the scan's results, the briefing written, the cycle bar and its close. */
function world(t) {
  const bars = FX.load();
  const i = bars.findIndex(b => b.t === t);
  const upto = bars.slice(0, i + 1);
  const closeMs = Date.parse(t) + 180000;
  const results = scan(ALL.filter(s => s.timeframe === '3m'), upto, { symbol: 'MNQ' });
  const b = buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: upto, minutes: 3, scan: results, roundSteps: defaultRoundSteps(), now: new Date(closeMs) });
  const home = tmpDir();
  recordBrokerSpecs(home); // the broker's tick specs, as the translator records them
  writeBriefing(home, b);
  const now = new Date(closeMs + 5000);
  return { home, bar: upto[i], b, results, now, cycleBars: { MNQ: t }, env: { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: t }) } };
}

/** The six reads, each true on the bar: the trend rule's side, the VWAP side as it is, the cited setup, its candle. */
const readsOn = (w, low) => [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: 'trend long allowed', why: 'the prevailing 4h up' },
  { step: 'location', skill: 'vwap-volume-profile', read: `vwap ${w.b.sections.m3.data.vwap.side}`, why: 'where price is' },
  { step: 'setup', skill: 'momentum-and-volume', read: 'momentum_continuation fired up', why: 'the momentum candle with the trend' },
  { step: 'entry', skill: 'momentum-and-volume', read: '3m momentum up', why: 'range, volume, close at the top' },
  { step: 'stop', skill: 'invalidation', read: `stop 3m low ${low}`, why: 'under the momentum candle' },
  { step: 'target', skill: 'take-profit', read: 'target 2r', why: 'its own 2R' },
];

test('e2e cited setup: real bars, the scan fires, compose_check cites it, order_plan gives a market order, the gate lets exactly it through', () => {
  const w = world('2021-05-24T13:48:00.000Z');
  const fired = w.results.find(r => r.name === 'momentum_continuation');
  assert.deepStrictEqual([fired.candidate, fired.direction, fired.stopDistance], [true, 'long', 14.5]);
  const cand = w.b.sections.m3.data.candidates.find(c => c.name === 'momentum_continuation');
  assert.deepStrictEqual([cand.direction, cand.stopPoints, cand.exit.targetR], ['long', 14.5, 2]);
  const out = composeCheck({ symbol: 'MNQ', side: 'long', reads: readsOn(w, w.bar.l), size: 3 }, { env: w.env, now: () => w.now, root: ROOT });
  assert.match(out.text, /OK: every read verified/, out.text);
  assert.match(out.text, /Plan \(code's arithmetic, momentum_continuation's own\): entry market from 16910; stop 16895\.5 \(3m-low 16895\.75, 1 tick beyond: 58 ticks/);
  const rec = readRecords(w.home, 'MNQ').at(-1);
  assert.deepStrictEqual([rec.ok, rec.plan.entry.type, rec.plan.stop.ticks, rec.plan.target.ticks, rec.plan.setup], [true, 'market', 58, 116, 'momentum_continuation']);
  const o = composedOrder({ home: w.home, root: 'MNQ', side: 'long', now: w.now, cycleBars: w.cycleBars, strategy: LIFECYCLE, strategies: ALL, accounts: [], specOf: specFor, accountId: 7, selected: ['MNQ'] });
  assert.deepStrictEqual([o.args.type, o.args.size, o.args.stopLossBracket.ticks, o.args.takeProfitBracket.ticks, 'limitPrice' in o.args], ['market', 3, 58, 116, false]);
  const config = { ...loadConfig({}), home: w.home, cycleBars: w.cycleBars, killSwitchFile: '/nonexistent/fth/STOP', mtfMaxAgeMin: 1e9 };
  const gate = input => evaluateOrder({ input, entries: [plan(7, { ts: w.now.toISOString() })], now: w.now, config, strategies: ALL }).violations.filter(v => ['composed-reads', 'cited-setup', 'max-risk', 'late-entry'].includes(v.check));
  assert.deepStrictEqual(gate(o.args), []);
  // The same trade as a limit, or under the setup's own tag: refused.
  assert.deepStrictEqual(gate({ ...o.args, type: 'limit', limitPrice: 16910 }).map(v => v.check), ['composed-reads']);
  assert.deepStrictEqual(gate({ ...o.args, rationale: 'setup:momentum_continuation long at market, stop 16895.50' }).map(v => v.check), ['cited-setup']);
});

test('e2e cited setup: on a candle the scan did not fire (09:45 ET, momentum against the trend), the fired read is false: NOT OK, no order', () => {
  const w = world('2021-05-24T13:45:00.000Z');
  assert.strictEqual(w.results.find(r => r.name === 'momentum_continuation').candidate, false);
  const out = composeCheck({ symbol: 'MNQ', side: 'long', reads: readsOn(w, w.bar.l), size: 3 }, { env: w.env, now: () => w.now, root: ROOT });
  assert.match(out.text, /FALSE setup \(momentum-and-volume\): "momentum_continuation fired up" - momentum_continuation did not fire on this bar/);
  assert.match(out.text, /NOT OK: no entry on this record/);
  // The record has no plan (no fired setup, and the 2R mark is false with levels ahead): no order.
  assert.throws(() => composedOrder({ home: w.home, root: 'MNQ', side: 'long', now: w.now, cycleBars: w.cycleBars, strategy: LIFECYCLE, strategies: ALL, accounts: [], specOf: specFor, accountId: 7, selected: ['MNQ'] }), /the compose record states no size/);
});
