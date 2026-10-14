'use strict';

// What the model is shown, fixed at its source: a candidate's target as its own side's, the VWAP
// crosses labeled by their VWAP (the session count is the regime's), fair value gaps open or partly
// filled (with the part still unfilled), and the volume profile's levels on the contract's tick.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tickOf, onTick } = require('../../scripts/lib/trading/contracts');
const { sideTarget } = require('../../scripts/lib/trading/order-plan');
const { scanSummary } = require('../../scripts/lib/harness-tools/compact');
const { snapshot, fairValueGaps } = require('../../scripts/lib/trading/market-snapshot');
const { classifyRegime } = require('../../scripts/lib/trading/regime');
const B = require('../../scripts/lib/trading/briefing');
const { parseArgv } = require('../../scripts/lib/harness-tools/market-snapshot');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const onGrid = (x, tick) => Math.abs(x / tick - Math.round(x / tick)) < 1e-9;

test('onTick and tickOf: a price on the contract\'s tick, by its standard name; unchanged without a tick', () => {
  assert.strictEqual(onTick(27246.54, 0.25), 27246.5);
  assert.strictEqual(onTick(27414.32375, 0.25), 27414.25);
  assert.strictEqual(onTick(27455.855, 0.25), 27455.75);
  assert.strictEqual(onTick(2283.14, 0.1), 2283.1);
  assert.strictEqual(onTick(31.2374, 0.005), 31.235);
  assert.strictEqual(onTick(12.3456, null), 12.3456);
  assert.strictEqual(onTick(NaN, 0.25), null);
  assert.strictEqual(tickOf('MNQ'), 0.25);
  assert.strictEqual(tickOf('NQ:2026-03'), 0.25);
  assert.strictEqual(tickOf('M2K'), 0.1);
  assert.strictEqual(tickOf('ZZZ'), null);
  assert.strictEqual(tickOf(''), null);
});

test('sideTarget: a per-side target gives the side\'s own formula; a single one is both sides\'', () => {
  const both = { long: 'prior_vah - close', short: 'close - prior_val' };
  assert.strictEqual(sideTarget(both, 'short'), 'close - prior_val');
  assert.strictEqual(sideTarget(both, 'long'), 'prior_vah - close');
  assert.strictEqual(sideTarget(both, null), null);
  assert.strictEqual(sideTarget({ long: 'x' }, 'short'), null);
  assert.strictEqual(sideTarget('crt_target(60)', 'long'), 'crt_target(60)');
  assert.strictEqual(sideTarget(null, 'long'), null);
});

test('the compact scan renders a per-side target as the fired side\'s level, never [object Object]', () => {
  const r = {
    name: 'value_area', direction: 'short', candidate: true, status: 'active', timeframe: '3m', signal: 'rules',
    entryRef: 27394.25, stopDistance: 28, targetDistance: 147.5, minRR: 2,
    exit: { targetR: null, target: { long: 'prior_vah - close', short: 'close - prior_val' }, maxBars: 40 },
    confluence: { with: [], against: [] },
  };
  const text = scanSummary([r], { symbol: 'MNQ' });
  assert.doesNotMatch(text, /object Object/);
  assert.match(text, /exit: target level close - prior_val, at most 40 bars/);
  assert.doesNotMatch(text, /prior_vah/);
  const r2 = { ...r, direction: 'long', exit: { targetR: 2, target: null, maxBars: null } };
  assert.match(scanSummary([r2], { symbol: 'MNQ' }), /exit: target 2R/);
});

test('fairValueGaps: open (not traded back into), partly filled (the unfilled part), filled (dropped)', () => {
  const t = k => new Date(Date.UTC(2026, 9, 7, 14, 3 * k)).toISOString();
  const bar = (k, l, h) => ({ t: t(k), o: l, h, l, c: h, v: 1 });
  // A bullish gap 10-12 (bar 0 high 10, bar 2 low 12).
  const base = [bar(0, 9, 10), bar(1, 10, 13), bar(2, 12, 14)];
  assert.deepStrictEqual(fairValueGaps([...base, bar(3, 12.5, 15)]).open.map(g => [g.low, g.high]), [[10, 12]]);
  const partly = fairValueGaps([...base, bar(3, 11, 15)]);
  assert.deepStrictEqual(partly.open, []);
  assert.deepStrictEqual(partly.partly.map(g => [g.side, g.low, g.high, g.gapLow, g.gapHigh]), [['bullish', 10, 11, 10, 12]]);
  const filled = fairValueGaps([...base, bar(3, 9.75, 15)]);
  assert.deepStrictEqual([filled.open, filled.partly], [[], []]);
  // A bearish gap 12-14 (bar 0 low 14, bar 2 high 12), traded up into 13: 13-14 still unfilled.
  const down = [bar(0, 14, 15), bar(1, 11, 14.5), bar(2, 10, 12), bar(3, 10, 13)];
  assert.deepStrictEqual(fairValueGaps(down).partly.map(g => [g.side, g.low, g.high, g.gapLow, g.gapHigh]), [['bearish', 13, 14, 12, 14]]);
});

test('the snapshot\'s session VWAP crosses are the regime\'s own count, labeled by their VWAP', () => {
  for (const n of [600, 900, 1300]) {
    const bars = BARS.slice(0, n);
    const s = snapshot({ bars });
    const reg = classifyRegime(bars);
    assert.strictEqual(s.regime.metrics.sessionVwapCrosses, s.vwap.sessionCrossesLast30, `bar ${n}`);
    assert.strictEqual(reg.metrics.sessionVwapCrosses, s.vwap.sessionCrossesLast30);
    assert.ok(!('vwapCrosses' in s.regime.metrics), 'no unlabeled count');
    assert.ok(Number.isInteger(s.vwap.rthCrossesLast30));
  }
});

test('the briefing labels each crosses count by its VWAP and states the session one is the regime\'s', () => {
  const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1300), minutes: 3 });
  const vw = b.sections.m3.data.vwap;
  assert.ok(!('crossesLast30' in vw));
  assert.strictEqual(vw.sessionCrossesLast30, b.sections.m3.data.regime.metrics.sessionVwapCrosses);
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  assert.match(text, /Closes crossing a VWAP in the last 30 bars: the RTH VWAP \d+, the session VWAP \d+ \(the regime's count\)/);
});

test('the volume profile\'s levels come on the contract\'s tick with one; two decimals without', () => {
  const bars = BARS.slice(0, 1300);
  const s = snapshot({ bars, tickSize: 0.25 });
  for (const kind of ['priorRth', 'session']) {
    const p = s.volumeProfile[kind];
    for (const x of [p.poc, p.vah, p.val, p.low, p.high, ...p.hvn, ...p.lvn, p.hvnAbove, p.hvnBelow, p.lvnAbove, p.lvnBelow].filter(v => v !== null)) {
      assert.ok(onGrid(x, 0.25), `${kind} ${x}`);
    }
  }
  if (s.day && s.day.prior && Number.isFinite(s.day.prior.vah)) {
    assert.ok(onGrid(s.day.prior.vah, 0.25) && onGrid(s.day.prior.val, 0.25) && onGrid(s.day.prior.poc, 0.25));
  }
  const raw = snapshot({ bars });
  assert.ok([raw.volumeProfile.priorRth.poc, raw.volumeProfile.priorRth.vah].every(x => Math.round(x * 100) === x * 100 || Math.abs(Math.round(x * 100) - x * 100) < 1e-6));
  // The briefing's profiles and dealing ranges use the contract's tick.
  const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const pp = b.sections.day.data.priorProfile;
  if (pp) for (const x of [pp.poc, pp.vah, pp.val, ...pp.hvn, ...pp.lvn]) assert.ok(onGrid(x, 0.25), `prior profile ${x}`);
  const h1 = b.sections.h1.data.h1;
  if (h1 && h1.range) assert.ok(onGrid(h1.range.mid, 0.25), `range mid ${h1.range.mid}`);
});

test('market_snapshot takes the contract root (--symbol), not as an indicator parameter', () => {
  assert.deepStrictEqual(parseArgv(['b.json', '--symbol=mnq', '--orbMinutes=30']), { file: 'b.json', params: { orbMinutes: 30 }, symbol: 'MNQ' });
  assert.deepStrictEqual(parseArgv(['b.json']), { file: 'b.json', params: {} });
});

test('symbolOfBarsFile: the root a harness bars file is named for, else null', () => {
  const { symbolOfBarsFile } = require('../../scripts/lib/bars-fetch');
  assert.strictEqual(symbolOfBarsFile('/h/bars/MNQ-3m.json'), 'MNQ');
  assert.strictEqual(symbolOfBarsFile('/h/bars-scratch/MES-15m-trend.json'), 'MES');
  assert.strictEqual(symbolOfBarsFile('M2K-1d.json'), 'M2K');
  for (const f of ['-', '/h/bars.json', '/h/MNQ-3m.csv', '/h/mnq-3m.json', '/h/MNQ.json', null]) assert.strictEqual(symbolOfBarsFile(f), null, String(f));
});

test('market_snapshot puts the profile on the tick of the file\'s root or the symbol given; two decimals without either', () => {
  const fs = require('fs');
  const { snapshot: op } = require('../../scripts/lib/harness-tools/market-snapshot');
  const { tmpDir } = require('../helpers');
  const dir = tmpDir();
  const bars = BARS.slice(0, 1300).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const named = path.join(dir, 'MNQ-3m.json');
  const plain = path.join(dir, 'bars.json');
  for (const f of [named, plain]) fs.writeFileSync(f, JSON.stringify({ bars }));
  const prof = args => JSON.parse(op({ ...args, compact: true }).text).volumeProfile.priorRth;
  const levels = p => [p.poc, p.vah, p.val, ...p.hvn, ...p.lvn];
  assert.ok(levels(prof({ file: plain })).some(x => !onGrid(x, 0.25)), 'the fixture\'s profile has levels off the tick');
  assert.ok(levels(prof({ file: named })).every(x => onGrid(x, 0.25)), 'inferred from MNQ-3m.json');
  assert.ok(levels(prof({ file: plain, symbol: 'MNQ' })).every(x => onGrid(x, 0.25)), 'the symbol given');
  assert.deepStrictEqual(levels(prof({ file: plain, symbol: 'MNQ' })), levels(prof({ file: named })));
  // The levels on the tick are the briefing's own: one precision for one level.
  const b = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3 });
  const pp = b.sections.day.data.priorProfile;
  const p = prof({ file: named });
  assert.deepStrictEqual([pp.poc, pp.vah, pp.val, pp.hvn, pp.lvn], [p.poc, p.vah, p.val, p.hvn, p.lvn]);
  // ... and the day line's (market_snapshot's day.line, as the prompt's).
  const day = JSON.parse(op({ file: named, compact: true }).text).day;
  assert.deepStrictEqual([day.prior.val, day.prior.vah, day.prior.poc], [pp.val, pp.vah, pp.poc]);
  assert.ok(day.line.includes(`value area ${pp.val}-${pp.vah} (POC ${pp.poc})`), day.line);
});

test('the runner\'s prompt day line shows the prior value area and POC on the tick, as the briefing does', () => {
  const { dayLine } = require('../../scripts/lib/runner-wiring');
  // In RTH (the day so far) and overnight (against the prior day): the fixture's bar 1300 (13:15 ET) and 1401 (19:18 ET).
  for (const n of [1300, 1401]) {
    const bars = BARS.slice(0, n);
    const line = dayLine({ symbol: 'MNQ', tickSize: 0.25 }, bars);
    const pp = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3 }).sections.day.data.priorProfile;
    assert.ok(line.includes(`value area ${pp.val}-${pp.vah} (POC ${pp.poc})`), `bar ${n}: ${line}`);
    const m = /value area ([\d.]+)-([\d.]+) \(POC ([\d.]+)\)/.exec(line);
    for (const x of m.slice(1).map(Number)) assert.ok(onGrid(x, 0.25), `bar ${n}: ${x}`);
  }
  // A level within a hair of half a tick (the M2K fixture's prior VAL, 2257.95 to the cent): the line shows the
  // briefing's tick (levelOnTick), not the raw value's nearest tick (2258), overnight (bar 862) and in RTH (bar 1196).
  const rty = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'RTY-3m.csv'));
  for (const n of [862, 1196]) {
    const bars = rty.slice(0, n);
    const pp = B.buildBriefing({ symbol: 'M2K', bars, minutes: 3 }).sections.day.data.priorProfile;
    assert.strictEqual(pp.val, 2257.9);
    assert.match(dayLine({ symbol: 'M2K', tickSize: 0.1 }, bars), /value area 2257\.9-2269\.3 \(POC 2266\.8\)/, `bar ${n}`);
  }
});

test('levelOnTick: a computed level to the cent, then on the tick (one rule for every place a level is shown)', () => {
  const { levelOnTick } = require('../../scripts/lib/trading/contracts');
  assert.strictEqual(levelOnTick(27246.5375, 0.25), 27246.5);
  for (const x of [2257.9500001, 2257.949, 27414.32375, 27455.855]) {
    assert.strictEqual(levelOnTick(x, 0.1), onTick(Math.round(x * 100) / 100, 0.1));
    assert.strictEqual(levelOnTick(x, 0.25), onTick(Math.round(x * 100) / 100, 0.25));
  }
  assert.strictEqual(levelOnTick(null, 0.25), null);
  // A tick finer than a cent: rounded first at a tenth of the tick's last decimal, so a half-cent tick shows.
  assert.strictEqual(levelOnTick(31.2551, 0.005), 31.255);
  assert.strictEqual(levelOnTick(31.2574, 0.005), 31.255);
  assert.strictEqual(levelOnTick(31.2576, 0.005), 31.26);
  assert.strictEqual(levelOnTick(2257.94, 0.1), 2257.9);
  assert.strictEqual(levelOnTick(12.34, null), 12.34);
  // The prompt's day line (describeDay with a level) and the briefing show one price for a level.
  const { describeDay } = require('../../scripts/lib/trading/day-context');
  const d = { open: 27410.75, gap: -23.25, prior: { low: 27130.25, high: 27462.5, close: 27434, val: 27246.5375, poc: 27414.32375, vah: 27455.855 } };
  const line = describeDay(d, { round: x => onTick(x, 0.25), level: x => levelOnTick(x, 0.25) });
  assert.match(line, /value area 27246\.5-27455\.75 \(POC 27414\.25\)/);
});

test('the briefing shows partly filled FVGs with the open ones', () => {
  let partly = 0;
  for (const n of [600, 900, 1300]) {
    const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, n), minutes: 3 });
    const liq = b.sections.m3.data.liquidity;
    const s = snapshot({ bars: BARS.slice(0, n) });
    assert.deepStrictEqual(liq.openFvgs, s.liquidity.openFvgs);
    assert.deepStrictEqual(liq.partlyFilledFvgs, s.liquidity.partlyFilledFvgs);
    partly += liq.partlyFilledFvgs.length;
  }
  assert.ok(partly > 0, 'the fixture has partly filled gaps for the briefing to show');
});

test('tick rounding is display only: room, R and every candidate\'s levels ahead are those of the unrounded levels', () => {
  // NQ (a 0.25 tick) against a root with no tick in the table (levels shown to two decimals): both merge levels within
  // 0.25, so every decision input must be identical; only the shown profile prices may differ.
  const decisionFacts = b => {
    const m3 = b.sections.m3.data;
    const strip = list => (list || []).map(x => ({ name: x.name, points: x.points, R: x.R }));
    return {
      room: { above: strip(m3.nearestLiquidity.above), below: strip(m3.nearestLiquidity.below) },
      candidates: (m3.candidates || []).map(c => ({ name: c.name, inTheWay: c.inTheWay && { name: c.inTheWay.name, R: c.inTheWay.R }, needR: c.needR, ahead: strip(c.ahead), target: c.target })),
    };
  };
  let checked = 0;
  for (let n = 400; n <= 1400; n += 25) {
    const bars = BARS.slice(0, n);
    const price = bars[bars.length - 1].c;
    const scan = ['long', 'short'].map(direction => ({ name: `probe_${direction}`, candidate: true, direction, signal: 'rules', status: 'active', stopDistance: 9.5, entryRef: price, exit: { targetR: 2 }, minRR: 2, confluence: { with: [], against: [] } }));
    const a = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, scan });
    const z = B.buildBriefing({ symbol: 'ZZZ', bars, minutes: 3, scan });
    assert.deepStrictEqual(decisionFacts(a), decisionFacts(z), `bar ${n}`);
    // Distances come from the unrounded profile: a room level's points equal |level - price| at two decimals.
    const vp = snapshot({ bars }).volumeProfile.priorRth;
    for (const x of [...a.sections.m3.data.nearestLiquidity.above, ...a.sections.m3.data.nearestLiquidity.below]) {
      const raw = vp ? { 'prior VAH': vp.vah, 'prior VAL': vp.val, 'prior POC': vp.poc }[x.name] : undefined;
      if (Number.isFinite(raw)) {
        assert.strictEqual(x.points, Math.round(Math.abs(raw - price) * 100) / 100, `${x.name} at bar ${n}`);
        assert.ok(onGrid(x.price, 0.25), `${x.name} shown on the tick`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'some room level was a profile level');
});
