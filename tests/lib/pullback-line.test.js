'use strict';

// The Pullback line's wiring (trading/pullback-read.js in trading/briefing.js): in the runner's briefing summary when
// price is against the trend rule's prevailing side on the 15m; a presented fact only, so the gate's composed-entry
// check, compose_check, the composed reads, order_plan, the gate's required skills and the trend rule are the same,
// byte for byte, whatever the line says or whether it is there.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const B = require('../../scripts/lib/trading/briefing');
const PR = require('../../scripts/lib/trading/pullback-read');
const { mtfRead } = require('../../scripts/lib/trading/mtf');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { composedRefusal } = require('../../scripts/lib/trading/lifecycle-gate');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { situationalSkills, SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const F = require('../fixtures/lifecycle');
const { SCENARIO_1, scenario1 } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const clone = x => JSON.parse(JSON.stringify(x));
// A counter-move in the fixture's bars (the 1h up, the 15m pulling back 46% of its leg), and one with the trend.
const AT = 900;
const WITH = 1000;
const DEEP = { side: 'short', frame: '15m', prevailing: '4h down', leg: { origin: 21600, extreme: 21500, at: '2026-10-07T13:00:00.000Z' }, depth: 1.2, close: 21620,
  swing: { '15m': { price: 21600, holds: false }, '1h': { price: 21640, holds: true } }, counter: { bars: 30, volRatio: 1.8, volume: 'rising', rangeRatio: 1.6 },
  against: { '15m': { kind: 'CHoCH', direction: 'up', level: 21590, barsAgo: 2 }, '1h': { kind: 'CHoCH', direction: 'up', level: 21610, barsAgo: 0 } }, stacked: true };
const withPb = (b, p) => { const c = clone(b); if (p === undefined) delete c.sections.m3.data.pullback; else c.sections.m3.data.pullback = p; return c; };
const lineOf = text => text.split('\n').filter(l => l.startsWith('- Pullback ('));

test('pullback line: the runner\'s briefing carries the read of its own bars, once in the summary, never in the detail', () => {
  const bars = BARS.slice(0, AT);
  const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars, minutes: 3 });
  const m3 = b.sections.m3.data;
  assert.ok(m3.pullback, 'a counter-move in the fixture');
  assert.deepStrictEqual(m3.pullback, PR.pullbackRead({ bars, base: 3, prevailing: mtfRead(bars).rule.prevailing }));
  assert.ok(m3.trendRule.includes(`prevailing ${m3.pullback.prevailing}`), 'the side the Trend rule line names');
  const text = B.renderBriefing(b);
  const lines = lineOf(text);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], PR.pullbackLine(m3.pullback));
  assert.ok(text.indexOf(lines[0]) < text.indexOf('Detail by timeframe:'));
  assert.ok(!/\n {2}pullback: /.test(text), 'the detail leaves it out (the summary says it)');
  // Another read is said; the rest of the text unchanged.
  const deep = B.renderBriefing(withPb(b, DEEP));
  assert.match(deep, /- Pullback \(15m, short leg 21600 -> 21500\): the leg given back past its origin; 30 bars since the extreme; swings since the extreme: 15m 21600 broken by a close, 1h 21640 holds; 15m break against: CHoCH up 21590 \(2 bars ago\), 1h: CHoCH up 21610 \(0 bars ago\); stacked\./);
  assert.deepStrictEqual(deep.split('\n').filter(l => !l.startsWith('- Pullback (')), text.split('\n').filter(l => !l.startsWith('- Pullback (')));
  // Without one (with the trend, or an older file), no line.
  assert.deepStrictEqual(lineOf(B.renderBriefing(withPb(b, undefined))), []);
});

test('pullback line: absent with the trend; and an analyst\'s frame briefing never carries one', () => {
  const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, WITH), minutes: 3 });
  assert.ok(/prevailing \S+ (?:up|down)/.test(b.sections.m3.data.trendRule), 'a prevailing side');
  assert.strictEqual(b.sections.m3.data.pullback, null, 'price with the trend: no counter-move');
  assert.deepStrictEqual(lineOf(B.renderBriefing(b)), []);
  const first = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, AT), minutes: 3 });
  const f = B.buildFrameBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, AT), minutes: 15, first });
  assert.ok(!('pullback' in f.sections.bar.data));
  assert.deepStrictEqual(lineOf(B.renderFrameBriefing(f, first)), []);
});

test('pullback line: no trend rule read yet (too few 4h candles): no line, even with a 15m counter-move', () => {
  const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, 300), minutes: 3 });
  assert.match(b.sections.m3.data.trendRule, /no 4h trend read yet/);
  assert.ok(PR.pullbackRead({ bars: BARS.slice(0, 300), base: 3, prevailing: mtfRead(BARS.slice(0, 300)).rule.prevailing }), 'the read itself sees one');
  assert.strictEqual(b.sections.m3.data.pullback, null);
});

test('pullback line: a swing it says broken (since the extreme) is broken in htfLevels (since it formed); unbroken there holds here', () => {
  let checked = 0;
  for (const n of [700, 900, 1100, 1300, 1499]) {
    const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, n), minutes: 3 });
    const m3 = b.sections.m3.data;
    if (!m3.pullback) continue;
    const type = m3.pullback.side === 'long' ? 'low' : 'high';
    for (const [tf, x] of Object.entries(m3.pullback.swing)) {
      const lv = x && (m3.htfLevels || []).find(l => l.name === `${tf} swing ${type}` && l.price === x.price);
      if (!lv) continue;
      // Closes since the extreme are a subset of closes since the swing formed.
      if (!x.holds) assert.ok(lv.brokenAt, `${n} ${tf} ${x.price}`);
      if (lv.brokenAt === null) assert.strictEqual(x.holds, true, `${n} ${tf} ${x.price}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 2, `swings checked ${checked}`);
});

test('pullback line: its swing counts closes since the extreme, htfLevels since the swing formed: both true, each says its rule', () => {
  // Recorded 2023-08-04 10:42 ET: the leg's own closes went above the 1h swing high 15558.25 before its extreme; none since.
  const bars = require('../fixtures/pullback/swing-before-leg-2023-08-04.json').map(([t, o, h, l, c, v]) => ({ t: `${t}:00.000Z`, o, h, l, c, v }));
  const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars, minutes: 3 });
  const lv = b.sections.m3.data.htfLevels.find(x => x.name === '1h swing high' && x.price === 15558.25);
  assert.strictEqual(lv.brokenAt, '2023-08-04T13:33:00.000Z', 'htfLevels: broken since the swing formed');
  const p = PR.pullbackRead({ bars, base: 3, prevailing: '4h down' });
  assert.ok(Date.parse(lv.brokenAt) < Date.parse(p.leg.at), 'broken before the extreme');
  assert.deepStrictEqual(p.swing['1h'], { price: 15558.25, holds: true });
  assert.match(PR.pullbackLine(p), /; swings since the extreme: 15m 15583\.5 holds, 1h 15558\.25 holds; /);
});

test('pullback line: the gate\'s composed-entry check, compose_check and the composed reads are the same whatever it says', () => {
  const DOC = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');
  const NOW = new Date('2026-10-07T14:00:02Z');
  const PB = clone(DEEP);
  const judge = p => {
    const home = tmpDir();
    F.writeScenario(home, { b: withPb(F.briefing(), p) });
    const r = composedRefusal({ name: 'trade_lifecycle', strategy: DOC, home, root: 'MNQ', input: F.order(), now: NOW, cycleBars: { MNQ: F.BAR }, entries: [], specOf: () => ({ tickSize: 0.25, tickValue: 0.5 }) });
    const { briefing, ...rest } = r;
    assert.ok(briefing && briefing.sections.m3);
    return JSON.stringify(rest);
  };
  const base = judge(undefined);
  assert.match(base, /"message":null/, 'scenario 1 stands');
  assert.strictEqual(judge(PB), base);
  assert.strictEqual(judge({ ...PB, side: 'long', stacked: false }), base);
  const compose = p => {
    const home = tmpDir();
    recordBrokerSpecs(home);
    B.writeBriefing(home, withPb(scenario1(), p));
    const ctx = { env: { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-04-23T14:57:00.000Z' }) }, now: () => new Date('2026-04-23T15:00:05Z') };
    return ['long', 'short'].map(side => composeCheck({ symbol: 'MNQ', side, reads: SCENARIO_1, size: 1 }, ctx).text).join('\n');
  };
  const c0 = compose(undefined);
  assert.match(c0, /OK: every read verified/);
  assert.strictEqual(compose(PB), c0);
  const reads = p => JSON.stringify(['long', 'short'].map(side => checkReads({ reads: SCENARIO_1, side, briefing: withPb(scenario1(), p) })));
  assert.strictEqual(reads(PB), reads(undefined));
});

test('pullback line: order_plan\'s composed order is the same whatever it says', () => {
  const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
  const { trendHome } = require('../helpers');
  const P = require('../fixtures/lifecycle-prop');
  const SPEC = r => (/^(M?NQ)$/.test(r) ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
  const plan = p => {
    const home = trendHome();
    F.writeScenario(home, { b: withPb(F.briefing(), p) });
    return JSON.stringify(composedOrder({ home, root: 'MNQ', side: 'long', now: P.NOW, cycleBars: { MNQ: F.BAR }, strategy: P.SHIPPED, strategies: [P.SHIPPED], accounts: [P.MINI], specOf: SPEC, accountId: 7, selected: ['MNQ'] }));
  };
  const base = plan(undefined);
  assert.match(base, /"limitPrice":21540.25/);
  assert.strictEqual(plan(DEEP), base);
});

test('pullback line: the gate\'s required skills and the trend rule never turn on it', () => {
  const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: BARS.slice(0, AT), minutes: 3 });
  const m3 = b.sections.m3.data;
  for (const p of [DEEP, undefined]) {
    const x = withPb(b, p).sections.m3.data;
    assert.deepStrictEqual(situationalSkills(x, SITUATIONAL), situationalSkills(m3, SITUATIONAL));
    assert.strictEqual(x.trendRule, m3.trendRule);
  }
  // No trigger of the gate's vocabulary reads it (the skill is required only on its own trigger, a reversal candidate,
  // as before; the line's embedding is never required).
  assert.ok(!SITUATIONAL.some(e => /pullback/.test(e.when)));
  assert.deepStrictEqual(SITUATIONAL.filter(e => e.skill === 'pullback-vs-reversal').map(e => e.when), ['candidate.trendRule=reversal']);
});
