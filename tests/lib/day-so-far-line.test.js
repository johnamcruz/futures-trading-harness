'use strict';

// The Day so far line and the RTH volatility's wiring (trading/day-so-far.js in trading/briefing.js): in the runner's
// briefing in RTH, from its own bars; presented facts only, so the gate's composed-entry check, compose_check,
// order_plan, the gate's required skills and the trend rule are the same, byte for byte, whatever they say or whether
// they are there.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const B = require('../../scripts/lib/trading/briefing');
const D = require('../../scripts/lib/trading/day-so-far');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { composedRefusal } = require('../../scripts/lib/trading/lifecycle-gate');
const { situationalSkills, SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const F = require('../fixtures/lifecycle');
const { SCENARIO_1, scenario1 } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
// 2026-04-27 (Monday, the file's 3rd RTH session): the 10:57 ET bar (closed 11:00; 10 bars since 09:30 index 1224) and
// the 09:36 ET bar (closed 09:39, too early); a Globex bar.
const RTH_N = 1254;
const EARLY_N = 1227;
const GLOBEX_N = 1000;
const clone = x => JSON.parse(JSON.stringify(x));
const DIRECTIONAL = { status: 'read', bars: 30, read: 'directional', direction: 'up', efficiency: 0.4, score: 2.19, vwapCrosses: 0, rangeAtr: 6, rangeVsAdr: 0.5, netAtr: 5 };
const ROTATIONAL = { status: 'read', bars: 30, read: 'rotational', direction: 'down', efficiency: 0.02, score: 0.11, vwapCrosses: 9, rangeAtr: 3, rangeVsAdr: 0.2, netAtr: -0.2 };
const VOL = { status: 'read', ratio: 1.6, word: 'high', sessions: 10, windowMinutes: 30 };
const withDay = (b, soFar, vol) => {
  const c = clone(b);
  const t = c.sections.m3.data.today || (c.sections.m3.data.today = {});
  if (soFar === undefined) delete t.soFar; else t.soFar = soFar;
  if (vol === undefined) delete t.rthVolatility; else t.rthVolatility = vol;
  return c;
};
const omitAdr = ({ rangeVsAdr: _adr, ...rest }) => rest;
const build = n =>B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, n), minutes: 3 });

test('day so far: the runner\'s briefing carries it in RTH from its own bars, once in the summary, never in the detail', () => {
  const b = build(RTH_N);
  const m3 = b.sections.m3.data;
  assert.strictEqual(m3.et, '11:00');
  // The 30 RTH bars 09:30-10:57, read by the module on the briefing's bars and its ATR(14).
  const { normalizeBars } = require('../../scripts/lib/trading/indicators');
  const own = D.daySoFar(normalizeBars(BARS.slice(0, RTH_N)), { minutes: 3, atr: m3.atr14 });
  assert.strictEqual(m3.today.soFar.status, 'read');
  assert.strictEqual(m3.today.soFar.bars, 30);
  assert.deepStrictEqual(omitAdr(m3.today.soFar), omitAdr(own));
  // One value per fact: its range in ADR is the day context's, its net move the Trend declared? line's day's move.
  assert.strictEqual(m3.today.soFar.rangeVsAdr, m3.today.rangeVsAdr);
  assert.strictEqual(m3.today.soFar.netAtr, m3.declared.long.dayMoveAtr);
  const text = B.renderBriefing(b);
  const lines = text.split('\n').filter(l => l.startsWith('- Day so far ('));
  assert.strictEqual(lines.length, 1);
  assert.ok(text.indexOf(lines[0]) < text.indexOf('Detail by timeframe:'));
  // Just before the Trend declared? line it points to.
  const at = s => text.indexOf(s);
  assert.ok(at('- Day so far (') < at('- Trend declared?'));
  assert.ok(!/"soFar"|"rthVolatility"/.test(text.slice(at('Detail by timeframe:'))), 'the detail leaves them out (the summary says them)');
  // Two prior sessions in the file: the RTH volatility is unknown, and says why, beside the regime's word.
  assert.strictEqual(m3.today.rthVolatility.status, 'unknown');
  assert.match(text, /volatility\. RTH volatility: unknown \(2 prior sessions with these minutes; needs 3\)\.\n/);
  // A read says itself; the rest of the text is unchanged.
  const other = B.renderBriefing(withDay(b, ROTATIONAL, VOL));
  assert.match(other, /- Day so far \(RTH since 09:30 ET, 30 3m bars; [^)]*\): rotational: efficiency 0\.02/);
  assert.match(other, /volatility\. RTH volatility: high \(the last 30 min's 3m bar range 1\.6x the same minutes' median on 10 prior sessions\)\.\n/);
  const strip = s => s.split('\n').filter(l => !l.startsWith('- Day so far (')).map(l => l.replace(/ RTH volatility: .*$/, ''));
  assert.deepStrictEqual(strip(other), strip(text));
  // Without them (an older file), no line and no suffix.
  const none = B.renderBriefing(withDay(b, undefined, undefined));
  assert.ok(!none.includes('- Day so far') && !none.includes('RTH volatility'));
});

test('day so far: too early at 09:36 ET; none outside RTH; none in an analyst\'s frame briefing', () => {
  const early = build(EARLY_N);
  assert.match(early.sections.m3.data.et, /^09:3/);
  assert.match(B.renderBriefing(early), /- Day so far \(RTH since 09:30 ET, \d 3m bars; [^)]*\): too early \(\d bars\), RTH VWAP crosses \d+; a read from 09:45 ET\./);
  const globex = build(GLOBEX_N);
  assert.ok(!('soFar' in (globex.sections.m3.data.today || {})));
  assert.ok(!B.renderBriefing(globex).includes('Day so far') && !B.renderBriefing(globex).includes('RTH volatility'));
  const first = build(RTH_N);
  const f = B.buildFrameBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, RTH_N), minutes: 15, first });
  assert.ok(!('soFar' in ((f.sections.bar.data || {}).today || {})));
  const text = B.renderFrameBriefing(f, first);
  assert.ok(!text.includes('- Day so far') && !text.includes('RTH volatility'));
});

test('day so far: the gate\'s composed-entry check and compose_check are the same whatever it says', () => {
  const DOC = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');
  const NOW = new Date('2026-10-07T14:00:02Z');
  const judge = (s, v) => {
    const home = tmpDir();
    F.writeScenario(home, { b: withDay(F.briefing(), s, v) });
    const r = composedRefusal({ name: 'trade_lifecycle', strategy: DOC, home, root: 'MNQ', input: F.order(), now: NOW, cycleBars: { MNQ: F.BAR }, entries: [], specOf: () => ({ tickSize: 0.25, tickValue: 0.5 }) });
    const { briefing, ...rest } = r;
    assert.ok(briefing && briefing.sections.m3);
    return JSON.stringify(rest);
  };
  const base = judge(undefined, undefined);
  assert.match(base, /"message":null/, 'scenario 1 stands');
  assert.strictEqual(judge(DIRECTIONAL, VOL), base);
  assert.strictEqual(judge(ROTATIONAL, { ...VOL, word: 'low', ratio: 0.5 }), base);
  const compose = (s, v) => {
    const home = tmpDir();
    recordBrokerSpecs(home);
    B.writeBriefing(home, withDay(scenario1(), s, v));
    const ctx = { env: { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-04-23T14:57:00.000Z' }) }, now: () => new Date('2026-04-23T15:00:05Z') };
    return ['long', 'short'].map(side => composeCheck({ symbol: 'MNQ', side, reads: SCENARIO_1, size: 1 }, ctx).text).join('\n');
  };
  const c0 = compose(undefined, undefined);
  assert.match(c0, /OK: every read verified/);
  assert.strictEqual(compose(DIRECTIONAL, VOL), c0);
  assert.strictEqual(compose(ROTATIONAL, { ...VOL, word: 'low', ratio: 0.5 }), c0);
});

test('day so far: order_plan\'s composed order is the same whatever it says', () => {
  const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
  const { trendHome } = require('../helpers');
  const P = require('../fixtures/lifecycle-prop');
  const SPEC = r => (/^(M?NQ)$/.test(r) ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
  const plan = (s, v) => {
    const home = trendHome();
    F.writeScenario(home, { b: withDay(F.briefing(), s, v) });
    return JSON.stringify(composedOrder({ home, root: 'MNQ', side: 'long', now: P.NOW, cycleBars: { MNQ: F.BAR }, strategy: P.SHIPPED, strategies: [P.SHIPPED], accounts: [P.MINI], specOf: SPEC, accountId: 7, selected: ['MNQ'] }));
  };
  const base = plan(undefined, undefined);
  assert.match(base, /"limitPrice":/);
  assert.strictEqual(plan(DIRECTIONAL, VOL), base);
  assert.strictEqual(plan(ROTATIONAL, { ...VOL, word: 'low', ratio: 0.5 }), base);
});

test('day so far: the gate\'s required skills, the trend rule and the regime never turn on it', () => {
  const b = build(RTH_N);
  const m3 = b.sections.m3.data;
  for (const [s, v] of [[DIRECTIONAL, VOL], [ROTATIONAL, { ...VOL, word: 'low' }], [undefined, undefined]]) {
    const x = withDay(b, s, v).sections.m3.data;
    assert.deepStrictEqual(situationalSkills(x, SITUATIONAL), situationalSkills(m3, SITUATIONAL));
    assert.strictEqual(x.trendRule, m3.trendRule);
  }
  // No trigger of the gate's vocabulary reads them; the regime's own volatility word is as it was.
  assert.ok(!SITUATIONAL.some(e => /soFar|rthVolatility/.test(e.when)));
  const { classifyRegime } = require('../../scripts/lib/trading/regime');
  const { normalizeBars } = require('../../scripts/lib/trading/indicators');
  assert.strictEqual(m3.regime.volatility, classifyRegime(normalizeBars(BARS.slice(0, RTH_N))).volatility);
});
