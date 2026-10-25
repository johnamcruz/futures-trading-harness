'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadBars, aggregate, barMinutes, epochMs, parseCsv } = require('../../scripts/lib/backtest/data');
const { excelSerialToMs } = require('../../scripts/lib/backtest/xlsx');
const { trailStep, snapStop } = require('../../scripts/lib/trading/trail');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const { runBacktest, validateBacktestConfig, policyStrategy } = require('../../scripts/lib/backtest/run');
const { stats, maxDrawdown } = require('../../scripts/lib/backtest/report');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir, TEST_ACCOUNTS, listPolicies, FX_STRATEGIES, FX_GOLDEN, TEST_SIZING, testSizing, TEST_FEE } = require('../helpers');

/** The fixture rules strategies fx_break and fx_cross (tests/fixtures/strategies-fx), loaded beside the shipped ones. */
const FX = { FTH_STRATEGIES_DIRS: FX_STRATEGIES };
/** With them, the rules of the strategies retired on 2026-10-14 (tests/fixtures/strategies-golden: fx_cisd_ote, fx_value_area, ...). */
const GOLD = { FTH_STRATEGIES_DIRS: `${FX_STRATEGIES},${FX_GOLDEN}` };

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(__dirname, '..', 'fixtures', 'data');

test('Parquet (pyarrow, pandas, polars, fastparquet; every codec and encoding) and Excel load the same bars as CSV', () => {
  const ref = loadBars(path.join(DATA, 'bars.csv'));
  assert.strictEqual(ref.length, 300);
  // ZSTD needs zlib.zstdDecompressSync (Node 22.15+): older Node says so instead of misreading the file.
  const zstd = typeof require('zlib').zstdDecompressSync === 'function';
  for (const f of fs.readdirSync(DATA).filter(x => x !== 'bars.csv')) {
    let bars;
    try {
      bars = loadBars(path.join(DATA, f));
    } catch (err) {
      if (!zstd && /ZSTD needs Node 22\.15\+/.test(err.message)) continue;
      throw err;
    }
    if (f === 'pyarrow-nulls.parquet') {
      assert.strictEqual(bars[5].v, 0, 'a missing volume reads as 0');
      assert.deepStrictEqual({ ...bars[5], v: ref[5].v }, ref[5]);
      continue;
    }
    assert.deepStrictEqual(bars, ref, f);
  }
});

test('times: ISO, naive UTC, epoch units, Excel serials; legacy .xls is refused', () => {
  assert.strictEqual(epochMs(1741611600), 1741611600000);
  assert.strictEqual(epochMs(1741611600000), 1741611600000);
  assert.strictEqual(epochMs(1741611600000000), 1741611600000);
  assert.strictEqual(epochMs(1741611600000000000), 1741611600000);
  assert.strictEqual(new Date(excelSerialToMs(45726.5625)).toISOString(), '2025-03-10T13:30:00.000Z');
  assert.strictEqual(parseCsv('Date,Open,High,Low,Close\n2025-03-10 13:30:00,1,2,0,1\n')[0].t, '2025-03-10T13:30:00.000Z');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'old.xls'), 'x');
  assert.throws(() => loadBars(path.join(dir, 'old.xls')), /save it as .xlsx/);
});

test('aggregate builds closed N-minute bars from finer bars', () => {
  const t0 = Date.parse('2025-03-10T13:30:00Z');
  const one = [[1, 2, 0, 1], [1, 3, 1, 2], [2, 2, 1, 1.5], [1.5, 4, 1, 3]].map(([o, h, l, c], i) => ({ t: new Date(t0 + i * 60000).toISOString(), ms: t0 + i * 60000, o, h, l, c, v: 10 }));
  assert.strictEqual(barMinutes(one), 1);
  const three = aggregate(one, { unit: 2, unitNumber: 3, nowMs: t0 + 4 * 60000 });
  assert.deepStrictEqual(three, [{ t: new Date(t0).toISOString(), o: 1, h: 3, l: 0, c: 1.5, v: 30 }]);
});

test('trailing stop: holds until +2R, then 0.5R behind the best price, ratchet only, tick-snapped', () => {
  const plan = { trailActivateR: 2, trailGivebackR: 0.5 };
  const long = { sign: 1, entry: 100, risk: 2, stop: 98, peakR: 0 };
  let r = trailStep(long, { h: 103.9, l: 101, c: 103 }, plan, 0.25);
  assert.deepStrictEqual([r.stop, r.active, r.close], [98, false, null], '1.95R: not active yet');
  r = trailStep({ ...long, peakR: r.peakR }, { h: 106, l: 105.2, c: 105.5 }, plan, 0.25);
  assert.deepStrictEqual([r.stop, r.active, r.close], [105, true, null], 'peak 3R: stop at 2.5R = 105');
  r = trailStep({ ...long, stop: 105, peakR: 3 }, { h: 105.5, l: 105.1, c: 105.2 }, plan, 0.25);
  assert.strictEqual(r.stop, 105, 'never loosens');
  r = trailStep({ ...long, stop: 105, peakR: 3 }, { h: 107, l: 104, c: 104.5 }, plan, 0.25);
  assert.deepStrictEqual(r.close, { price: 104.5, reason: 'trail' }, 'the bar went through the new stop: out at its close');
  const short = { sign: -1, entry: 100, risk: 2, stop: 102, peakR: 0 };
  r = trailStep(short, { h: 99, l: 95.1, c: 95.5 }, plan, 0.25);
  assert.strictEqual(r.stop, 96.25, 'short: 95.1 + 1 = 96.1, rounded up to the tick');
  assert.strictEqual(snapStop(96.1, 1, 0.25), 96);
});

/** A rules strategy that goes long when the close crosses above 100.5 (fires once on our bars). */
function strategy(extra = {}) {
  const rules = { long: ['close crosses_above 100.5'] };
  return {
    name: 'test', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules,
    compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, ...extra,
  };
}

/** 3m bars from 10:00 ET (14:00Z, EDT): flat at 100 (ATR 1), then the scripted path. */
function bars(path) {
  const t0 = Date.parse('2025-03-10T14:00:00Z');
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  return [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
}

const run = (path, s = strategy(), opts = {}) => runEngine([{ symbol: 'MNQ', bars: bars(path), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], {
  // The fill mechanics as the original bot: at the signal close, no slippage (the live-latency default has its own tests).
  timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, ...opts,
}).trades;

test('engine: entry at the signal close, stop at 1R, fixed target at min_rr', () => {
  const trades = run([[100, 101, 99.9, 101], [101, 101.5, 100.5, 101.2], [101.2, 103.5, 101, 103]]);
  assert.strictEqual(trades.length, 1);
  const t = trades[0];
  assert.deepStrictEqual([t.entry, t.initialStop, t.reason, t.exit, t.r], [101, 100, 'target', 103, 2]);
  assert.strictEqual(t.net, 4, '8 ticks x $0.50');
});

test('engine: a rules strategy listing the micro trades the mini\'s bars (as the live scan does), in the mini\'s dollars; nothing outside its families', () => {
  const path = [[100, 101, 99.9, 101], [101, 101.5, 100.5, 101.2], [101.2, 103.5, 101, 103]];
  const on = (symbol, tickValue, s = strategy()) => runEngine([{ symbol, bars: bars(path), tickSize: 0.25, tickValue, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  const nq = on('NQ', 5);
  assert.deepStrictEqual(nq.map(t => [t.contract, t.entry, t.exit, t.r, t.net]), [['NQ', 101, 103, 2, 40]], '8 ticks x $5.00');
  assert.deepStrictEqual(on('MNQ', 0.5).map(t => [t.entry, t.exit, t.r, t.net]), [[101, 103, 2, 4]], 'the same trade, a tenth of the dollars');
  assert.deepStrictEqual(on('ES', 12.5), [], 'another index');
  assert.deepStrictEqual(on('GC', 10), []);
  assert.deepStrictEqual(on('NQ', 5, strategy({ signal: 'manual' })), [], 'manual strategies are never backtested');
});

test('engine: a bar touching both stop and target is a loss; a gap through the stop fills at the open', () => {
  assert.deepStrictEqual(run([[100, 101, 99.9, 101], [101, 104, 99.5, 101]]).map(t => [t.reason, t.r]), [['stop', -1]]);
  assert.deepStrictEqual(run([[100, 101, 99.9, 101], [99, 99.5, 98, 98.5]]).map(t => [t.reason, t.exit, t.r]), [['stop', 99, -2]]);
});

test('engine: trend setups trail from +2R, giving back 0.5R', () => {
  const s = strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } });
  const trades = run([[100, 101, 99.9, 101], [101, 103.2, 102.8, 103], [103, 105, 104.6, 104.8], [104.8, 104.9, 104.4, 104.5]], s);
  assert.strictEqual(trades.length, 1);
  // Peak 105 (4R): stop 104.5 (3.5R), hit on the last bar.
  assert.deepStrictEqual([trades[0].reason, trades[0].exit, trades[0].r, trades[0].mfeR], ['trail', 104.5, 3.5, 4]);
});

test('engine: with harness rules, no entries outside sessions and a flatten at end of day', () => {
  const late = run([[100, 101, 99.9, 101], [101, 101.2, 100.8, 101]], strategy(), { gate: true, sessions: ['11:00-15:00@America/New_York'], gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '' }) });
  assert.deepStrictEqual(late, [], '10:03 ET is outside the session');
  const eod = run([[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1], [101.1, 101.2, 100.9, 101]], strategy(), {
    gate: true, sessions: ['10:00-15:00@America/New_York'], eodAt: '10:06@America/New_York', gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '' }),
  });
  assert.deepStrictEqual(eod.map(t => t.reason), ['eod']);
});

test('report: R stats as the original bot reports them, plus dollars and drawdown', () => {
  const trades = [{ r: 2, mfeR: 2.5, net: 40, fees: 0.74 }, { r: -1, mfeR: 0.5, net: -20, fees: 0.74 }, { r: -1, mfeR: 0.2, net: -20, fees: 0.74 }];
  const s = stats(trades);
  assert.deepStrictEqual([s.trades, s.winRate, s.meanR, s.sumR, s.profitFactorR, s.capture, s.netPnL], [3, 0.333, 0, 0, 1, 0, 0]);
  assert.strictEqual(maxDrawdown(trades), 40);
});

test('config: data, symbols and limits are validated', () => {
  assert.throws(() => validateBacktestConfig({ symbols: ['MNQ'] }, ROOT), /data:/);
  assert.throws(() => validateBacktestConfig({ symbols: ['XYZ'], feesPerSide: TEST_FEE, data: { XYZ: 'a.csv' } }, ROOT), /tickSize and tickValue/);
  // One contract per index, as the runner selects: MNQ or NQ, never both.
  assert.throws(() => validateBacktestConfig({ symbols: ['MNQ', 'NQ'], feesPerSide: TEST_FEE, data: { MNQ: 'a.csv', NQ: 'a.csv' } }, ROOT), /symbols: one contract per index \(MNQ or NQ, not both\)/);
  assert.strictEqual(validateBacktestConfig({ symbols: ['NQ', 'MES'], feesPerSide: TEST_FEE, data: { NQ: 'a.csv', MES: 'a.csv' } }, ROOT).markets.length, 2);
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, start: '2025-02-01', end: '2025-01-01' }, ROOT), /end must be after start/);
  const ok = validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' } }, ROOT);
  assert.deepStrictEqual([ok.markets[0].tickSize, ok.markets[0].tickValue], [0.25, 0.5]);
});

test('a backtest run on the parity data writes a report; trades match the live evaluator', () => {
  const dir = tmpDir();
  const { report, runDir } = runBacktest({
    symbols: ['MNQ'], timeframe: 3, feesPerSide: TEST_FEE, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') },
    strategies: ['fx_cross', 'fx_break'], gate: false, outDir: dir,
  }, { root: ROOT, outRoot: dir, env: FX });
  assert.ok(report.summary.trades > 10);
  assert.ok(report.trades.every(t => ['fx_cross', 'fx_break'].includes(t.strategy)));
  for (const f of ['report.md', 'report.json', 'trades.csv']) assert.ok(fs.existsSync(path.join(runDir, f)));
  // Every trade's R is consistent with its prices.
  for (const t of report.trades) assert.ok(Math.abs(t.r - (t.direction === 'long' ? 1 : -1) * (t.exit - t.entry) / t.risk) < 1e-3);

  // Where it came from: strategy hashes, the data file's hash and size, and the data audit.
  const pv = report.meta.provenance;
  assert.deepStrictEqual(Object.keys(pv.strategies).sort(), ['fx_break', 'fx_cross']);
  assert.match(pv.strategies.fx_break, /^[0-9a-f]{16}$/);
  assert.match(pv.data.MNQ.sha256, /^[0-9a-f]{16}$/);
  assert.ok(pv.data.MNQ.bytes > 0);
  assert.ok(report.meta.dataAudit.MNQ.bars > 1000);
  assert.match(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), /- Provenance: harness /);
});

test('engine: a trade closed by the trail is not followed by an entry on the same bar', () => {
  // The rule would fire again on the bar that the trail closes the trade on.
  const s = strategy({ rules: undefined, compiledRules: compileRules({ long: ['close > open'] }).compiled, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } });
  const trades = run([[100, 101, 99.9, 101], [101, 103.2, 102.8, 103], [103, 105, 103.8, 104]], s);
  const closeBar = trades.find(t => t.reason === 'trail');
  assert.ok(closeBar);
  assert.ok(!trades.some(t => t.entryTime === closeBar.exitTime), JSON.stringify(trades.map(t => [t.entryTime, t.exitTime, t.reason])));
});

test('engine: stops and targets on a 0.1 tick are exact (no float misses)', () => {
  const t0 = Date.parse('2025-03-10T14:00:00Z');
  const flat = Array.from({ length: 520 }, () => [2045, 2045.2, 2044.8, 2045]);
  const path = [[2045, 2045.2, 2044.9, 2045.1], [2045.1, 2045.2, 2044.9, 2045.0]];
  const bars = [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const s = strategy({ compiledRules: compileRules({ long: ['close crosses_above 2045.05'] }).compiled, risk: { stop: 'atr:0.5', min_rr: 2 } });
  const trades = runEngine([{ symbol: 'MNQ', bars, tickSize: 0.1, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.strictEqual(trades[0].initialStop, 2044.9);
  assert.strictEqual(trades[0].reason, 'stop', 'the low touches 2044.9 exactly');
});

test('config: bad sessions or eodAt are refused, not ignored; sizing is one or the other', () => {
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, sessions: ['9:35-15:00'] }, ROOT), /sessions:/);
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, eodAt: '3:50pm ET' }, ROOT), /eodAt:/);
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, size: 2, riskPerTrade: 100 }, ROOT), /use one/);
  const fees = validateBacktestConfig({ symbols: ['ES'], data: { ES: { file: 'a.csv', feesPerSide: 2.5 } }, feesPerSide: 0.37 }, ROOT);
  assert.strictEqual(fees.markets[0].feesPerSide, 2.5, 'the symbol\'s own fee wins');
});

test('data: empty price cells drop the row instead of reading as 0; epoch numbers in Excel-style columns', () => {
  const bars = parseCsv('time,open,high,low,close,volume\n2025-03-10T13:30:00Z,1,2,0.5,1.5,10\n2025-03-10T13:31:00Z,1,2,,,\n');
  const { normalizeBars } = require('../../scripts/lib/trading/indicators');
  assert.strictEqual(normalizeBars(bars).length, 1);
  const { tableToBars } = require('../../scripts/lib/backtest/data');
  assert.strictEqual(tableToBars(['time', 'open', 'high', 'low', 'close'], [[1741613400, 1, 2, 0, 1]], { excel: true })[0].t, '2025-03-10T13:30:00.000Z');
});

test('the gate limits come from the environment, as live', () => {
  const dir = tmpDir();
  const base = { symbols: ['MNQ'], timeframe: 3, feesPerSide: TEST_FEE, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: ['fx_break'], outDir: dir };
  const loose = runBacktest(base, { root: ROOT, outRoot: dir, env: { ...FX, FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '' } }).report.summary.trades;
  const capped = runBacktest(base, { root: ROOT, outRoot: dir, env: { ...FX, FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_MAX_ENTRIES_PER_DAY: '1' } }).report.trades;
  const perDay = new Map();
  for (const t of capped) perDay.set(t.entryTime.slice(0, 10), (perDay.get(t.entryTime.slice(0, 10)) || 0) + 1);
  assert.ok(loose > capped.length);
  assert.ok([...perDay.values()].every(n => n <= 2), 'at most one entry per trading day (a calendar day spans two)');
});

test('engine: a fixed target is measured from the unrounded stop distance, as the original bot', () => {
  // Stop 0.9 x ATR ~ 0.9045: 4 ticks of stop, but the 2R target is round(1.809 / 0.25) = 7 ticks.
  const trades = run([[100, 101, 99.9, 101], [101, 102.8, 100.8, 102.5]], strategy({ risk: { stop: 'atr:0.9', min_rr: 2 } }));
  assert.deepStrictEqual(trades.map(t => [t.initialStop, t.reason, t.exit]), [[100, 'target', 102.75]]);
});

test('engine: losses are counted from P&L before fees, as the live gate counts them', () => {
  const s = strategy({ exit: { target_r: 5, max_bars: 1 } });
  const path = [[100, 101, 99.9, 101], [101, 101.3, 100.9, 101.25], [101.25, 101.3, 99.9, 100], [100, 101, 99.9, 101], [101, 101.1, 100.9, 101]];
  const opts = { gate: true, sessions: ['09:30-16:00@America/New_York'], eodAt: '16:00@America/New_York', gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_MAX_DAILY_LOSSES: '1' }) };
  const trades = runEngine([{ symbol: 'MNQ', bars: bars(path), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 }], [s], { timeframe: 3, fill: 'close', slippageTicks: 0, ...opts }).trades;
  assert.ok(trades[0].pnl > 0 && trades[0].net < 0, 'a 1-tick win that fees turn negative');
  assert.strictEqual(trades.length, 2, 'it is not a loss: the second entry is allowed');
});

test('config: gate must be a boolean', () => {
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, gate: 'false' }, ROOT), /gate: true or false/);
});

test('market hours are a hard rule in backtests too: no entries outside them, no trade held overnight', () => {
  // gate: false drops the order-gate limits, never the market hours.
  const t0 = Date.parse('2025-03-10T19:57:00Z'); // 15:57 ET
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  const path = [[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1]];
  const mk = (rows, start) => rows.map(([o, h, l, c], i) => ({ t: new Date(start + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const late = runEngine([{ symbol: 'MNQ', bars: mk([...flat, ...path], t0 - 520 * 180000), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.deepStrictEqual(late, [], 'a 16:00 ET close is after end of day: no entry');
  // An entry at 10:03 with no more bars until the next morning: closed at that day's last bar.
  const day = Date.parse('2025-03-10T14:00:00Z');
  const rows = mk([...flat, [100, 101, 99.9, 101]], day - 520 * 180000);
  rows.push({ t: new Date(Date.parse('2025-03-11T14:00:00Z')).toISOString(), o: 90, h: 91, l: 89, c: 90, v: 1 });
  const held = runEngine([{ symbol: 'MNQ', bars: rows, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } })], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.deepStrictEqual(held.map(t => [t.reason, t.exit]), [['eod', 101]], 'not carried into the next day');
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, eodAt: null }, ROOT), /eodAt/);
  assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, sessions: ['00:00-23:59@America/New_York'] }, ROOT), /market session/);
});

test('strategies whose stop is an expression (fx_cisd_ote: cisd_risk(15)) are backtested', () => {
  // fx_cisd_ote (the retired cisd_ote's rules) is paper; the backtester runs any strategy that isn't disabled.
  const dir = tmpDir();
  const base = { symbols: ['MNQ'], timeframe: 3, feesPerSide: TEST_FEE, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: ['fx_cisd_ote'], outDir: dir, gate: false };
  const { report } = runBacktest(base, { root: ROOT, outRoot: dir, env: GOLD });
  assert.deepStrictEqual(report.skipped || {}, {});
  assert.ok(report.summary.trades > 0, 'fx_cisd_ote trades');
});

test('a stop expression with no positive distance makes no candidate', () => {
  const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
  const { compileExpression } = require('../../scripts/lib/trading/rules');
  const s = strategy({ risk: { stop: '-0.5 * atr(20)', min_rr: 2 }, compiledStop: compileExpression('-0.5 * atr(20)') });
  const b = bars([[100, 101, 99.9, 101]]).map(x => ({ ...x }));
  const r = createEvaluator(b).at(s, b.length - 1, { describe: false });
  assert.strictEqual(r.direction, 'long');
  assert.strictEqual(r.candidate, false);
  assert.match(r.filtersFailed.join(' '), /no positive distance/);
});

test('ticks round half to even, as the original bot (Python round)', () => {
  const { roundHalfEven } = require('../../scripts/lib/backtest/engine');
  assert.deepStrictEqual([32.5, 33.5, 32.4999, 32.6, 8.125 / 0.25].map(roundHalfEven), [32, 34, 32, 33, 32]);
});

test('backtests follow the exchange calendar: no trading on holidays, early close at 13:00 ET', () => {
  // 2025-03-10 is a Monday trading day; mark it closed, then early.
  const s = strategy();
  const path = [[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1]];
  const closed = run(path, s, { closedDates: ['2025-03-10'] });
  assert.deepStrictEqual(closed, [], 'holiday: no entry');
  const t0 = Date.parse('2025-03-10T17:00:00Z'); // 13:00 ET
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  const rows = [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const early = runEngine([{ symbol: 'MNQ', bars: rows, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, earlyCloseDates: ['2025-03-10'] }).trades;
  assert.deepStrictEqual(early, [], 'early close: no entry after 13:00 ET');
});

/** accounts/tiny: a copy of the test_50k fixture (profile and rulebook) with a 2-session attempt, under `accounts`. */
function tinyAccount(accounts) {
  fs.mkdirSync(path.join(accounts, 'tiny'), { recursive: true });
  fs.writeFileSync(path.join(accounts, 'tiny', 'ACCOUNT.md'), fs.readFileSync(path.join(TEST_ACCOUNTS, 'test_50k', 'ACCOUNT.md'), 'utf8')
    .replace('name: test_50k', 'name: tiny').replace(/sessions: 30 /, 'sessions: 2 '));
  fs.writeFileSync(path.join(accounts, 'tiny', 'RULEBOOK.md'), fs.readFileSync(path.join(TEST_ACCOUNTS, 'test_50k', 'RULEBOOK.md'), 'utf8').replace('name: test_50k', 'name: tiny'));
  return path.join(accounts, 'tiny');
}

test('the backtester has no prop runs: a config naming prop, every, account, sizing or a bundle is refused', () => {
  // The mechanical prop runs retired (docs/research/mechanical-prop-backtester.md); the policy's parts are elsewhere.
  for (const [k, v, msg] of [['prop', 'prop_portfolio', /prop: the backtester's prop runs are retired/], ['every', 5, /every: the backtester's prop runs are retired/],
    ['account', 'tiny', /comes from a policy strategy/], ['sizing', {}, /comes from a policy strategy/], ['bundle', 'p', /bundle: trained policy bundles are retired/]]) {
    assert.throws(() => validateBacktestConfig({ feesPerSide: TEST_FEE, data: { MNQ: 'a.csv' }, [k]: v }, ROOT), msg, k);
  }
});

test('policyStrategy trades what live trades: an active policy leaves out a paper component (still counted as disagreement); a paper policy keeps it', () => {
  const dir = tmpDir();
  const accounts = path.join(dir, 'accounts');
  const tiny = tinyAccount(accounts);
  const strategiesDir = path.join(dir, 'strategies');
  const policy = (name, list, status = 'active') => {
    listPolicies(tiny, [name]);
    fs.mkdirSync(path.join(strategiesDir, name), { recursive: true });
    fs.writeFileSync(path.join(strategiesDir, name, 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
      .replace('name: prop_portfolio', `name: ${name}`).replace(/^strategies: .*$/m, `strategies: [${list.join(', ')}]`).replace(/^account: .*$/m, 'account: tiny')
      .replace(/^status: active\b/m, `status: ${status}`));
  };
  // va_paper: a paper copy of the fixture fx_value_area; the fixture fx_break is active.
  fs.mkdirSync(path.join(strategiesDir, 'va_paper'), { recursive: true });
  fs.writeFileSync(path.join(strategiesDir, 'va_paper', 'STRATEGY.md'), fs.readFileSync(path.join(FX_GOLDEN, 'fx_value_area', 'STRATEGY.md'), 'utf8')
    .replace(/^name: fx_value_area$/m, 'name: va_paper').replace(/^status: active\b.*$/m, 'status: paper'));
  policy('prop_mixed', ['va_paper', 'fx_break']);
  policy('prop_mixed_paper', ['va_paper', 'fx_break'], 'paper');
  policy('prop_all_paper', ['va_paper']);
  const env = { FTH_ACCOUNTS_DIRS: accounts, FTH_STRATEGIES_DIRS: `${strategiesDir},${FX_STRATEGIES},${FX_GOLDEN}` };
  const names = xs => xs.map(s => s.name);
  const mixed = policyStrategy(ROOT, 'prop_mixed', env);
  assert.deepStrictEqual(names(mixed.components), ['fx_break']);
  assert.deepStrictEqual(mixed.leftOut.map(x => x.name), ['va_paper']);
  assert.match(mixed.leftOut[0].why, /va_paper has status "paper": prop_mixed trades only its active strategies live/);
  // ... but it still fires in the scan: it counts toward conflict, as live.
  assert.deepStrictEqual(names(mixed.counted), ['va_paper', 'fx_break']);
  const paper = policyStrategy(ROOT, 'prop_mixed_paper', env);
  assert.deepStrictEqual([names(paper.components), paper.leftOut], [['va_paper', 'fx_break'], []]);
  assert.throws(() => policyStrategy(ROOT, 'prop_all_paper', env), /prop: prop_all_paper trades none of its strategies/);
  assert.throws(() => policyStrategy(ROOT, 'fx_break', env), /a prop run needs a policy strategy \(signal: policy\)/);
  assert.throws(() => policyStrategy(ROOT, 'nope', env), /prop: nope is not a strategy/);
});

test('a plain backtest on a CSV says, in its log, report.json and report.md, that fx_value_area reads a bar field the data lacks; a market it doesn\'t list is not named', () => {
  const dir = tmpDir();
  const csv = path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv');
  const logs = [];
  // GC: the same prices under a root fx_value_area doesn't list (it trades the equity index micros).
  const va = loadStrategies(ROOT, GOLD).strategies.find(x => x.name === 'fx_value_area');
  assert.ok(!va.instruments.includes('GC') && !va.instruments.includes('MGC'));
  const { report, runDir } = runBacktest({ symbols: ['MNQ', 'GC'], timeframe: 3, feesPerSide: TEST_FEE, data: { MNQ: csv, GC: csv }, strategies: ['fx_value_area', 'fx_break'], gate: false, outDir: dir },
    { root: ROOT, outRoot: dir, env: GOLD, log: m => logs.push(m) });
  const [p] = require('../../scripts/lib/backtest/bar-fields').fieldPaths(va);
  const n = report.fieldCoverage[0].coverage.MNQ.bars;
  assert.ok(n > 0);
  // Coverage: the share of the MNQ bars in range that carry it (none, on a CSV); GC is not a market fx_value_area trades.
  const want = [{ strategy: 'fx_value_area', path: p, coverage: { MNQ: { bars: n, carried: 0, share: 0 } }, symbols: ['MNQ'] }];
  assert.deepStrictEqual(report.fieldCoverage, want);
  assert.deepStrictEqual(report.missingFields, want, 'fx_break reads none; GC is not a market fx_value_area trades');
  const json = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
  assert.deepStrictEqual([json.missingFields, json.fieldCoverage], [want, want]);
  const md = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(md, new RegExp(`## Bar fields missing from this data\\n\\n- fx_value_area reads field\\("${p.replace(/\./g, '\\.')}"\\), which no MNQ bar in this data carries:`));
  assert.ok(md.includes(`| fx_value_area | \`${p}\` | MNQ | 0% | 0 / ${n} |`), md);
  assert.ok(logs.includes(`field coverage: fx_value_area field("${p}") on MNQ: 0% of ${n} bars`), logs.join('\n'));
  assert.deepStrictEqual(logs.filter(l => /reads field\(/.test(l)).length, 1, logs.join('\n'));
  // Only GC: fx_value_area trades none of it, so nothing is said.
  const gcLogs = [];
  const gc = runBacktest({ symbols: ['GC'], timeframe: 3, feesPerSide: TEST_FEE, data: { GC: csv }, strategies: ['fx_value_area', 'fx_break'], gate: false, outDir: path.join(dir, 'gc') }, { root: ROOT, outRoot: dir, env: GOLD, log: m => gcLogs.push(m) });
  assert.strictEqual(gc.report.missingFields, undefined);
  assert.strictEqual(gc.report.fieldCoverage, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(gc.runDir, 'report.md'), 'utf8'), /Bar fields missing/);
  assert.ok(!gcLogs.some(l => /reads field\(/.test(l)));
});

test('engine (default fills): an entry fills at the next bar\'s open plus a tick of slippage; a gap through the stop expires it', () => {
  const live = { fill: 'next-open', slippageTicks: 1 };
  // The signal bar closes at 101; the next bar opens at 101.25: filled at 101.50, the stop 1R (ATR 1) below the fill.
  const [t] = run([[100.5, 101.2, 100.4, 101], [101.25, 104.5, 101, 104], [104, 104.5, 103.5, 104]], strategy({ exit: { target_r: 2 } }), live);
  assert.strictEqual(t.entry, 101.5);
  assert.strictEqual(t.initialStop, 100.5);
  assert.strictEqual(t.target, 103.5, '2R from the fill');
  assert.strictEqual(t.reason, 'target');
  assert.strictEqual(t.entryTime, bars([[0, 0, 0, 0], [0, 0, 0, 0]])[521].t, 'entered at the fill bar\'s open');
  // The next bar opens at 99.75, through the signal's stop (100): the setup is gone.
  const r = runEngine([{ symbol: 'MNQ', bars: bars([[100.5, 101.2, 100.4, 101], [99.75, 100, 99, 99.5], [99.5, 99.6, 99.4, 99.5]]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, ...live });
  assert.deepStrictEqual([r.trades.length, r.expired], [0, 1]);
  // A signal on the last bar of the data has no fill bar: expired, not a trade.
  const end = runEngine([{ symbol: 'MNQ', bars: bars([[100.5, 101.2, 100.4, 101]]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, ...live });
  assert.deepStrictEqual([end.trades.length, end.expired], [0, 1]);
});

test('report: confidence interval, edge verdict, Sharpe, MAE, losing streak, and hour/weekday breakdowns', () => {
  const { buildReport, toMarkdown, sharpe } = require('../../scripts/lib/backtest/report');
  const mk = (i, r, net) => ({
    symbol: 'MNQ', strategy: 'x', reason: 'stop', entryTime: new Date(Date.UTC(2025, 2, 10 + (i % 5), 14, 0)).toISOString(),
    exitTime: new Date(Date.UTC(2025, 2, 10 + (i % 5), 15, 0) + i * 1000).toISOString(), r, mfeR: Math.max(r, 0.5), maeR: -0.5, net, fees: 0.74, barsHeld: 4,
  });
  const few = buildReport([mk(0, 2, 20), mk(1, -1, -10), mk(2, -1, -10)], { fill: 'next-open', slippageTicks: 1 });
  assert.match(few.summary.edge, /anecdotal/);
  assert.strictEqual(few.summary.longestLosingStreak, 2);
  assert.deepStrictEqual([few.summary.meanMaeR, few.summary.worstMaeR, few.summary.avgBarsHeld], [-0.5, -0.5, 4]);
  assert.deepStrictEqual(Object.keys(few.byHour), ['10:00 ET']);
  assert.ok(Object.keys(few.byWeekday)[0].endsWith('-Mon'));
  const many = buildReport(Array.from({ length: 40 }, (_, i) => mk(i, i % 4 === 0 ? -1 : 1.5, i % 4 === 0 ? -10 : 15 + i)), { fill: 'close', slippageTicks: 0 });
  assert.strictEqual(many.summary.edge, 'positive');
  assert.ok(many.summary.meanRCI95[0] > 0 && many.summary.meanRCI95[1] > many.summary.meanRCI95[0]);
  assert.ok(many.summary.sharpe > 0);
  assert.strictEqual(sharpe([mk(0, 1, 10)]), null, 'one day is no Sharpe');
  const md = toMarkdown({ ...many, meta: { runId: 'r', symbols: ['MNQ'], timeframe: 3, start: 'a', end: 'b', strategies: ['x'], gate: true, fill: 'next-open', slippageTicks: 1, expired: 2 } });
  assert.match(md, /Edge: positive; mean R 95% interval/);
  assert.match(md, /at the next bar's open \(live latency\), 1 tick\(s\) of slippage per market fill; 2 setup\(s\) expired/);
  assert.match(md, /## By entry hour \(ET\)/);
});

test('data audit: missing bars inside market hours, jumps from an unadjusted roll, and malformed bars; the daily break is not a gap', () => {
  const { auditBars } = require('../../scripts/lib/backtest/data');
  const t0 = Date.parse('2025-03-10T14:00:00Z'); // 10:00 ET
  const at = k => new Date(t0 + k * 180000).toISOString();
  const rows = [];
  for (let k = 0; k < 60; k += 1) rows.push({ t: at(k), o: 100, h: 100.5, l: 99.5, c: 100 });
  // 4 bars missing at 13:00 ET, then a 60-point open jump (ATR about 1), then a bad bar.
  rows.splice(20, 4);
  rows.push({ t: at(60), o: 160, h: 160.5, l: 159.5, c: 160 });
  rows.push({ t: at(61), o: 160, h: 159, l: 160, c: 160 });
  // 16:00 ET close to 18:00 ET open: the daily break, not missing data.
  rows.push({ t: new Date(Date.parse('2025-03-10T22:00:00Z')).toISOString(), o: 160, h: 160.5, l: 159.5, c: 160 });
  const a = auditBars(rows, 3);
  assert.strictEqual(a.missing, 4);
  assert.deepStrictEqual(a.gaps[0], { after: at(19), before: at(24), bars: 4 });
  assert.strictEqual(a.jumps.length, 1);
  assert.strictEqual(a.jumps[0].t, at(60));
  assert.strictEqual(a.invalid, 1);
  assert.strictEqual(a.warnings.length, 3);
  assert.match(a.warnings[1], /jump more than 8 x ATR .* unadjusted roll/);
});

test('confluence: trades record how many strategies agreed; minConfluence and conflict: skip filter entries', () => {
  const a = strategy({ name: 'a' });
  const b = strategy({ name: 'b' });
  const shortRules = { short: ['close crosses_above 100.5'] };
  const c = strategy({ name: 'c', rules: shortRules, compiledRules: compileRules(shortRules).compiled });
  const path = [[100.5, 101.2, 100.4, 101], [101, 104.5, 100.9, 104], [104, 104.5, 103.5, 104]];
  const go = (list, opts = {}) => runEngine([{ symbol: 'MNQ', bars: bars(path), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], list, { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, ...opts }).trades;
  const [t] = go([a, b]);
  assert.deepStrictEqual([t.strategy, t.confluence, t.conflict], ['a', 2, 0]);
  assert.strictEqual(go([a]).length, 1);
  assert.strictEqual(go([a], { minConfluence: 2 }).length, 0, 'one strategy alone is not enough');
  assert.strictEqual(go([a, c]).length, 0, 'the default, as the live gate: a trend strategy does not enter against another signal');
  assert.strictEqual(go([{ ...a, mtf: 'reversal' }, c]).length, 1, 'a reversal strategy may');
  const [mixed] = go([a, c], { conflict: 'priority' });
  assert.deepStrictEqual([mixed.strategy, mixed.confluence, mixed.conflict], ['a', 1, 1]);
  assert.strictEqual(go([a, c], { conflict: 'skip' }).length, 0, 'strategies disagree: no entry');
  const { buildReport } = require('../../scripts/lib/backtest/report');
  assert.deepStrictEqual(Object.keys(buildReport([t, mixed], {}).byConfluence), ['1 agreeing, 1 against', '2 agreeing']);
});

test('bar-file errors never echo the file\'s content (a script run on a credentials file shows none of it)', () => {
  const { spawnSync } = require('child_process');
  const dir = tmpDir();
  // A credentials line (built here, so the repository's secret scan doesn't take it for a real one).
  const secret = ['API', 'KEY'].join('_') + ['=', 'hunter2', 'abcdef'].join('');
  const leaks = m => /hunter2|API_KEY|api_key/.test(m);
  const cases = {
    '.env': `${secret}\nOTHER=x\n`,
    'header.csv': `time,open,high,low,${secret}\n2026-01-02T14:30:00Z,1,2,0,1\n`,
    'cell.csv': `time,open,high,low,close\n${secret},1,2,0,1\n`,
    // V8's parse error quotes the text around the fault.
    'bad.json': `[${secret}]`,
    'obj.json': `{"a": ${secret}}`,
    // A free-text time V8 parses, off the minute: the error gives the parsed time, not the text.
    'offminute.json': JSON.stringify([{ t: `Jan 2 2026 14:30:30 (${secret})`, o: 1, h: 2, l: 0, c: 1 }]),
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    let message = null;
    try { loadBars(file); } catch (err) { message = err.message; }
    assert.ok(message, `${name} is refused`);
    assert.ok(!leaks(message), `${name}: ${message}`);
  }
  // What the error still says: the recognized columns and a count of the others, the row, the parsed time.
  assert.throws(() => loadBars(path.join(dir, 'header.csv')), /found: time, open, high, low, and 1 other column\(s\)/);
  assert.throws(() => loadBars(path.join(dir, '.env')), /found: none, and 1 other column\(s\)/);
  assert.throws(() => loadBars(path.join(dir, 'cell.csv')), /row 2: unreadable time$/);
  assert.throws(() => loadBars(path.join(dir, 'bad.json')), /bad\.json: not valid JSON$/);
  assert.throws(() => loadBars(path.join(dir, 'offminute.json')), /a bar at 20\d\d-\d\d-\d\dT\d\d:\d\d:30\.000Z is not on a minute boundary/);
  // Parquet and Excel: a column name, a sheet name, or a worksheet target from the file stays out of the error.
  const name = Buffer.from(secret);
  const thriftName = Buffer.concat([Buffer.from([name.length]), name]);
  // FileMetaData { 1: version 1, 2: schema [root (2 children), child] } in Thrift compact; child = nested or repeated.
  const parquet = child => {
    const meta = Buffer.concat([Buffer.from([0x15, 0x02, 0x19, 0x2c, 0x48, 6]), Buffer.from('schema'), Buffer.from([0x15, 0x02, 0x00]), child, Buffer.from([0x00, 0x00])]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(meta.length);
    return Buffer.concat([Buffer.from('PAR1'), meta, len, Buffer.from('PAR1')]);
  };
  fs.writeFileSync(path.join(dir, 'nested.parquet'), parquet(Buffer.concat([Buffer.from([0x48]), thriftName, Buffer.from([0x15, 0x02])])));
  fs.writeFileSync(path.join(dir, 'repeated.parquet'), parquet(Buffer.concat([Buffer.from([0x35, 0x04, 0x18]), thriftName])));
  assert.throws(() => loadBars(path.join(dir, 'nested.parquet')), /^Error: parquet: column 1 is nested, which is not supported$/);
  assert.throws(() => loadBars(path.join(dir, 'repeated.parquet')), /^Error: parquet: column 1 is repeated, which is not supported$/);
  // A stored (uncompressed) zip: the workbook names a sheet and a worksheet target that isn't there.
  const zip = entries => {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [n, body] of Object.entries(entries)) {
      const nb = Buffer.from(n);
      const data = Buffer.from(body);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nb.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nb.length, 28);
      cd.writeUInt32LE(offset, 42);
      locals.push(local, nb, data);
      central.push(cd, nb);
      offset += 30 + nb.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(entries).length, 8);
    eocd.writeUInt16LE(Object.keys(entries).length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  };
  fs.writeFileSync(path.join(dir, 'book.xlsx'), zip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${secret}" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="${secret}.xml"/></Relationships>`,
  }));
  assert.throws(() => loadBars(path.join(dir, 'book.xlsx')), /^Error: xlsx: the worksheet the workbook points to is missing$/);
  const { readXlsx } = require('../../scripts/lib/backtest/xlsx');
  assert.throws(() => readXlsx(path.join(dir, 'book.xlsx'), { sheet: 'Bars' }), /^Error: xlsx: no sheet named "Bars" \(the workbook has 1 sheet\(s\)\)$/);
  cases['nested.parquet'] = null;
  cases['book.xlsx'] = null;
  // Through the scripts agents run, on a file and on stdin.
  const script = (name, args, input = '') => spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH, FTH_HOME: dir } });
  for (const [name, args] of [['market-snapshot.js', []], ['mtf.js', []], ['strategies.js', ['scan']]]) {
    for (const file of Object.keys(cases)) {
      const r = script(name, [...args, path.join(dir, file)]);
      assert.strictEqual(r.status, 1, `${name} ${file}`);
      assert.ok(!leaks(r.stderr + r.stdout), `${name} ${file}: ${r.stderr}`);
    }
    const piped = script(name, [...args, '-'], `[${secret}]`);
    assert.strictEqual(piped.status, 1);
    assert.match(piped.stderr, /stdin: not valid JSON/);
    assert.ok(!leaks(piped.stderr + piped.stdout), piped.stderr);
  }
});

// Prop challenge runs of the engine: a seeded random walk on 3-minute bars, one rules strategy, a small account.
function propRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 3-minute bars, a seeded random walk with drift bursts, from Sunday 2026-01-04 18:00 ET for `days` calendar days. */
function propSeries(days, seed = 5) {
  const r = propRng(seed);
  const out = [];
  let px = 20000;
  const t0 = Date.parse('2026-01-04T23:00:00Z');
  for (let k = 0; k < (days * 1440) / 3; k += 1) {
    const drift = Math.sin(k / 90) * 0.6;
    const o = px;
    const c = Math.round((px + drift + (r() - 0.5) * 6) * 4) / 4;
    out.push({ t: new Date(t0 + k * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100 });
    px = c;
  }
  return out;
}
const propStrategy = (extra = {}) => {
  const rules = { long: ['close crosses_above ema(20)'], short: ['close crosses_below ema(20)'] };
  return {
    name: 'trendy', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules,
    compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, ...extra,
  };
};
const propAccount = (extra = {}) => ({
  name: 'mini', starting_balance: 50000, profit_target: 1500, max_loss: 1000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0,
  daily_loss_soft: 400, consistency_pct: 0, sessions: 4, max_contracts: { MNQ: 20 }, fees_per_side: { MNQ: 0.37 }, ...extra,
});
const propMarket = bars => ({ symbol: 'MNQ', bars, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 });
const propEngine = { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, gateConfig: loadConfig({}), window: 160, sizing: TEST_SIZING };

test('a run with an account is a prop challenge: sized from the cushion, ends on pass, blow, or timeout', () => {
  const bars = propSeries(30);
  const res = runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: propAccount(), start: Date.parse('2026-01-08T00:00:00Z') });
  assert.ok(['passed', 'blown', 'timeout'].includes(res.combine.status), res.combine.status);
  assert.ok(res.trades.length > 0);
  // 0.2 x cushion 1000 = $200 budget per trade.
  for (const t of res.trades.slice(0, 3)) assert.ok(t.size * (t.risk / 0.25) * 0.5 <= 200 * 1.5 + 1e-9, `size ${t.size} risk ${t.risk}`);
  // Sizing to the whole cushion still leaves a planned stop short of the floor.
  const whole = { ...propEngine, account: propAccount({ max_loss: 200, daily_loss_soft: 0, max_contracts: { MNQ: 1000 } }), sizing: testSizing({ cushion_frac: 1, min_size_guard: 10 }), start: Date.parse('2026-01-08T00:00:00Z') };
  const sized = runEngine([propMarket(bars)], [propStrategy()], whole);
  assert.notStrictEqual(sized.combine.status, 'blown');
  const first = sized.trades[0];
  assert.ok(first.size * ((first.risk / 0.25) * 0.5 + 0.74) < 200, 'the first trade risks less than the whole $200 cushion');
  // A stop that fills far past its price (slippage, a gap) blows inside the bar, liquidated at the floor.
  const tiny = runEngine([propMarket(bars)], [propStrategy()], { ...whole, slippageTicks: 400 });
  assert.strictEqual(tiny.combine.status, 'blown');
  assert.strictEqual(tiny.trades[tiny.trades.length - 1].reason, 'blow');
  assert.ok(tiny.combine.balance <= tiny.combine.floor + 1e-9);
});

test('a prop run sizes with the policy strategy\'s own stop_slippage_ticks, as live', () => {
  // The first trade of an attempt: $200 budget (0.2 x $1,000 cushion), a 14-tick stop. The default tick:
  // 15 x $0.50 = $7.50 + $0.74 = $8.24 a micro, 24 MNQ ($197.76); stop_slippage_ticks 3: 17 x $0.50 + $0.74 = $9.24, 21 ($194.04).
  // (Moved from the retired prop/challenge.js tests: the engine's account mode is layer 2's reference.)
  const bars = propSeries(40);
  const { tradingDays } = require('../../scripts/lib/prop/trade-stream');
  const start = tradingDays([{ bars: bars.map(b => ({ ms: Date.parse(b.t) })) }]).find(d => d >= Date.parse('2026-01-08T00:00:00Z'));
  const acct = propAccount({ max_contracts: { MNQ: 100 } });
  const first = sizing => {
    const t = runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: acct, sizing, start }).trades[0];
    return [t.size, Math.round(t.risk / 0.25)];
  };
  assert.deepStrictEqual(first(TEST_SIZING), [24, 14]);
  assert.deepStrictEqual(first(testSizing({ stop_slippage_ticks: 3 })), [21, 14]);
});

test('a prop run never sizes under the rulebook\'s floor (min_contracts), as the live verdict: fewer fit is a skip', () => {
  const bars = propSeries(40);
  const { tradingDays } = require('../../scripts/lib/prop/trade-stream');
  const start = tradingDays([{ bars: bars.map(b => ({ ms: Date.parse(b.t) })) }]).find(d => d >= Date.parse('2026-01-08T00:00:00Z'));
  // The account allows 2 MNQ at most: a floor of 2 trades at 2; a floor of 3 never trades (never sized up to it).
  const acct = propAccount({ max_contracts: { MNQ: 2 } });
  const run = min => runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: acct, sizing: testSizing({ min_contracts: min }), start }).trades;
  assert.ok(run(2).length > 0 && run(2).every(t => t.size === 2), JSON.stringify(run(2).map(t => t.size)));
  assert.deepStrictEqual(run(3), []);
  // The first trade at 24 MNQ (a $200 budget, 14-tick stop): a floor of 24 takes it, 25 skips it.
  const wide = propAccount({ max_contracts: { MNQ: 100 } });
  const first = min => runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: wide, sizing: testSizing({ min_contracts: min }), start }).trades[0];
  assert.strictEqual(first(24).size, 24);
  assert.ok(!first(25) || first(25).size >= 25, 'never under the floor');
  // The live entry's limits where the run states them (prop.limits, as prop/size-translate.js limits it): a $140 cap at
  // the 14-tick stop all in ((14 + 1) x $0.50 + $0.74 = $8.24 a contract) is floor(140 / 8.24) = 16, under the budget's
  // 24; the broker's max 6 under that.
  const limited = (limits, min = 1) => runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: wide, sizing: testSizing({ min_contracts: min }), start, prop: { limits } }).trades[0];
  assert.strictEqual(limited({ capUsd: 140, orderMax: null }).size, 16);
  assert.strictEqual(limited({ capUsd: 140, orderMax: 6 }).size, 6);
  assert.ok(!limited({ capUsd: 140, orderMax: 6 }, 7) || limited({ capUsd: 140, orderMax: 6 }, 7).size >= 7, 'under the floor after the limits: never sized up');
  // The floor stretch, as live (prop/size-translate.js limitPlan): a $20 cap fits 2 at $8.24, under a floor of 3
  // ($24.72 all in); a $30 stretch takes exactly 3 on the fresh (healthy) attempt's first trade; a $24 one doesn't.
  const stretched = stretch => runEngine([propMarket(bars)], [propStrategy()], { ...propEngine, account: wide, sizing: testSizing({ min_contracts: 3, floor_stretch_max_usd: stretch }), start, prop: { limits: { capUsd: 20, orderMax: null } } }).trades;
  const base = limited({ capUsd: 1000, orderMax: null });
  const s30 = stretched(30);
  assert.deepStrictEqual([s30[0].size, s30[0].entryTime], [3, base.entryTime]);
  assert.ok(!stretched(24).some(t => t.entryTime === base.entryTime), 'over the stretch: that setup skips');
  assert.ok(!stretched(0).some(t => t.entryTime === base.entryTime), 'off: skips as before');
});

test('a prop run folds the rulebook\'s multiplier items in, as the live verdict does: one whose fact it lacks skips every setup', () => {
  // (Moved from the retired backtester prop-run test: the engine computes no facts, so an enforced item fails closed.)
  const bars = propSeries(30);
  const opts = { ...propEngine, account: propAccount(), start: Date.parse('2026-01-08T00:00:00Z') };
  const exit = { trail_activate_r: 2, trail_giveback_r: 0.5 };
  const prop = multipliers => ({ strategy: { exit, ...(multipliers ? { multipliers } : {}) }, components: ['trendy'], contracts: 'micro' });
  const plain = runEngine([propMarket(bars)], [propStrategy()], { ...opts, prop: prop(null) });
  assert.ok(plain.trades.length > 0);
  const gated = runEngine([propMarket(bars)], [propStrategy()], { ...opts, prop: prop([{ item: 'multipliers', fact: 'probe', values: { ok: 1 } }]) });
  assert.deepStrictEqual(gated.trades, [], 'a multiplier item without its fact skips every setup (fails closed)');
});

test('a policy run picks only from the strategies it trades, but a left-out paper one still counts as disagreement, as in the live scan', () => {
  const bars = propSeries(30);
  const opts = { ...propEngine, account: propAccount(), start: Date.parse('2026-01-08T00:00:00Z') };
  const prop = { strategy: { exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }, components: ['trendy'], contracts: 'micro' };
  // contra (paper, listed first) fires the other side on every bar trendy fires.
  const flip = { long: ['close crosses_below ema(20)'], short: ['close crosses_above ema(20)'] };
  const contra = propStrategy({ name: 'contra', status: 'paper', mtf: 'reversal', rules: flip, compiledRules: compileRules(flip).compiled });
  const alone = runEngine([propMarket(bars)], [propStrategy()], { ...opts, prop });
  assert.ok(alone.trades.length > 0);
  // Counted: every trendy setup conflicts with contra's (conflict 'reversal', trendy is no reversal strategy): none taken.
  assert.deepStrictEqual(runEngine([propMarket(bars)], [contra, propStrategy()], { ...opts, prop }).trades, []);
  // contra on the same side instead: never picked (it is first and fires), so the trades are trendy's own,
  // with contra counted in their confluence.
  const same = runEngine([propMarket(bars)], [propStrategy({ name: 'contra', status: 'paper' }), propStrategy()], { ...opts, prop }).trades;
  assert.ok(same.length && same.every(t => t.confluence === 2), JSON.stringify(same.map(t => t.confluence)));
  assert.deepStrictEqual(same.map(t => ({ ...t, confluence: 1 })), alone.trades);
});

test('micros and minis: a policy strategy run sizes in micros, trades minis by its contract mode, and settles each at its own tick value', () => {
  const bars = propSeries(30);
  const acct = propAccount({ max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } });
  const wide = propStrategy({ exit: { trail_activate_r: 2, trail_giveback_r: 2 } });
  const prop = contracts => ({ strategy: { exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }, components: ['trendy'], contracts });
  const opts = { ...propEngine, account: acct, sizing: testSizing({ cushion_frac: 1 }), start: Date.parse('2026-01-08T00:00:00Z') };
  const micro = runEngine([propMarket(bars)], [wide], { ...opts, prop: prop('micro') });
  const auto = runEngine([propMarket(bars)], [wide], { ...opts, prop: prop('auto') });
  const mini = runEngine([propMarket(bars)], [wide], { ...opts, prop: prop('mini') });
  assert.ok(micro.trades.length && micro.trades.every(t => t.contract === 'MNQ'));
  assert.ok(mini.trades.length && mini.trades.every(t => t.contract === 'NQ'));
  assert.ok(auto.trades.some(t => t.contract === 'NQ') || auto.trades.every(t => t.contract === 'MNQ'));
  for (const t of mini.trades) {
    // NQ: $5 a tick, $1.40 a side.
    const ticks = Math.round(((t.direction === 'long' ? 1 : -1) * (t.exit - t.entry)) / 0.25);
    assert.ok(Math.abs(t.pnl - ticks * 5 * t.size) < 1e-6 && Math.abs(t.fees - 2.8 * t.size) < 1e-6, JSON.stringify(t));
  }
  // The policy strategy's exit applies (give-back 0.5), not its strategy's (2): the same trades as the strategy
  // with that exit traded alone in micros. Every setup the budget sizes is taken; nothing closes a trade early.
  const alone = runEngine([propMarket(bars)], [propStrategy()], opts);
  assert.deepStrictEqual(micro.trades, alone.trades);
  assert.ok(micro.trades.every(t => ['stop', 'target', 'trail', 'eod', 'end', 'blow', 'daily_limit', 'max_bars'].includes(t.reason)), [...new Set(micro.trades.map(t => t.reason))].join());
});

test('a policy\'s exit mode: target trades each setup on its strategy\'s own exit (a trail on top only when set); trail replaces it', () => {
  const bars = propSeries(30);
  const opts = { ...propEngine, account: propAccount(), sizing: testSizing({ cushion_frac: 1 }), start: Date.parse('2026-01-08T00:00:00Z') };
  // The component's own exit: a 3R target, no trail.
  const own = propStrategy({ exit: { target_r: 3 } });
  const run = exit => runEngine([propMarket(bars)], [own], { ...opts, prop: { strategy: { exit }, components: ['trendy'], contracts: 'micro' } }).trades;
  const alone = runEngine([propMarket(bars)], [own], opts).trades;
  assert.ok(alone.length > 0 && alone.some(t => t.reason === 'target'), [...new Set(alone.map(t => t.reason))].join());
  // Mode target: the very trades the strategy makes on its own exit.
  assert.deepStrictEqual(run({ mode: 'target' }), alone);
  // Mode trail (and a policy with no mode, as before): the trail replaces the target.
  const trailed = run({ mode: 'trail', trail_activate_r: 2, trail_giveback_r: 0.5 });
  assert.deepStrictEqual(run({ trail_activate_r: 2, trail_giveback_r: 0.5 }), trailed);
  assert.ok(!trailed.some(t => t.reason === 'target'));
  assert.notDeepStrictEqual(trailed, alone);
  // Mode target with a trail on top: the own target stays, the trail moves the stop.
  const both = run({ mode: 'target', trail_activate_r: 1, trail_giveback_r: 0.5 });
  const wanted = runEngine([propMarket(bars)], [propStrategy({ exit: { target_r: 3, trail_activate_r: 1, trail_giveback_r: 0.5 } })], opts).trades;
  assert.deepStrictEqual(both, wanted);
  // Mode target_then_trail: never closed at its own target; trailed past it (the stop locked at 3R - 0.5R), and a winner
  // that reached its target makes at least the lock less a tick of slippage, or its bar's close.
  const past = run({ mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'r', trail_r: 1 });
  assert.ok(past.length && !past.some(t => t.reason === 'target'), [...new Set(past.map(t => t.reason))].join());
  assert.ok(past.some(t => t.reason === 'trail' && t.r > 3), 'some ran past the target');
  const structure = run({ mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'structure', trail_r: 1, swing_tf: '15m' });
  assert.ok(structure.length && !structure.some(t => t.reason === 'target'));
});

test('a prop run\'s loss streak counts each trade\'s P&L before fees: a scratch (gross 0, net the fees) neither ends nor extends it', () => {
  // 3-minute bars from 09:30 ET: 30 flat bars (no signal), then a loss, a scratch, a loss, and a fourth setup.
  const t0 = Date.parse('2026-01-08T14:30:00Z');
  const bars = [];
  const bar = (o, h, l, c) => bars.push({ t: new Date(t0 + bars.length * 180000).toISOString(), o, h, l, c, v: 100 });
  for (let k = 0; k < 30; k += 1) bar(100, 100.5, 99.5, 100);
  // Each setup: a bar closing up (long at its close, 101), then the trade's one bar (max_bars 1): out at its close.
  for (const out of [100, 101, 100, 101]) { bar(100, 101.25, 99.75, 101); bar(101, 101.25, 99.75, out); }
  for (let k = 0; k < 5; k += 1) bar(100, 100.5, 99.5, 100);
  const rules = { long: ['close > open'] };
  const s = propStrategy({ rules, mtf: 'reversal', compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:5', min_rr: 2 }, exit: { target_r: 20, max_bars: 1 } });
  const run = stop => runEngine([propMarket(bars)], [s], { ...propEngine, window: 20, account: propAccount({ daily_loss_soft: 0, loss_streak_stop: stop }), sizing: testSizing({ cushion_frac: 0.2 }) }).trades;
  const all = run(0);
  assert.deepStrictEqual(all.map(t => Math.sign(t.pnl)), [-1, 0, -1, 0], 'a loss, a scratch, a loss, a scratch (off: every setup)');
  assert.ok(all[1].net < 0, 'the scratch lost its fees');
  // Stop 2: loss (1), scratch (still 1), loss (2): the fourth setup is refused. Counting the net, the scratch would be the second loss.
  assert.deepStrictEqual(run(2).map(t => Math.sign(t.pnl)), [-1, 0, -1]);
});

test('a prop run stops the session after the account\'s loss_streak_stop losing trades in a row, as the gate does', () => {
  const bars = propSeries(30);
  const opts = { ...propEngine, sizing: testSizing({ cushion_frac: 0.2 }), start: Date.parse('2026-01-08T00:00:00Z') };
  const off = runEngine([propMarket(bars)], [propStrategy()], { ...opts, account: propAccount({ daily_loss_soft: 0 }) }).trades;
  const on = runEngine([propMarket(bars)], [propStrategy()], { ...opts, account: propAccount({ daily_loss_soft: 0, loss_streak_stop: 1 }) }).trades;
  // With a stop of 1, no trade follows a loss on the same trading day.
  const day = t => require('../../scripts/lib/trading/clock').tradingDayKey(new Date(t.entryTime));
  for (let i = 1; i < on.length; i += 1) assert.ok(!(day(on[i]) === day(on[i - 1]) && on[i - 1].pnl < 0), `trade ${i} follows a loss the same session`);
  const lossThenMore = off.some((t, i) => i > 0 && day(t) === day(off[i - 1]) && off[i - 1].pnl < 0);
  assert.ok(lossThenMore, 'the series has a session that trades on after a loss');
  assert.ok(on.length < off.length);
});

test('backtest: a level target the fill leaves under min_rr is not traded (fx_value_area_reentry, min_rr: 2)', () => {
  // A balanced day-1 RTH session gives the prior value area; day 2 opens below it and closes back inside twice.
  const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
  const { profileSeries } = require('../../scripts/lib/trading/volume-profile');
  const s = loadStrategies(ROOT, GOLD).strategies.find(x => x.name === 'fx_value_area_reentry');
  assert.ok(s && s.risk.min_rr === 2 && s.exit.target && !s.exit.target_r, 'the fixture trades a level target with min_rr 2');
  const S = 180000;
  const bar = (ms, o, c, v = 100) => ({ t: new Date(ms).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v });
  const DAY1 = Date.UTC(2026, 9, 7, 13, 30); // 09:30 ET, 2026-10-07 (UTC-4)
  const DAY2 = DAY1 + 864e5;
  const bars = [bar(DAY1 - S, 100, 100)];
  for (let k = 0; k < 130; k += 1) {
    const c = 100 + 40 * Math.sin(k / 6) * (k % 2 ? 1 : 0.3);
    bars.push(bar(DAY1 + k * S, bars[bars.length - 1].c, c, 100 + Math.round(200 * Math.exp(-((c - 100) ** 2) / 200))));
  }
  for (let k = 0; k < 30; k += 1) bars.push(bar(DAY2 - (30 - k) * S, 0, 0));
  const p = profileSeries(bars, 'prior_rth').profile.at(-1);
  assert.ok(p && p.val < p.poc && p.poc < p.vah, 'day 1 has a value area');
  const v = p.val;
  // Overnight below value, then 09:30 opens under it and two closes come back inside.
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, v - 3, v - 3)));
  bars.push(bar(DAY2, v - 2, v + 1), bar(DAY2 + S, v + 1, v + 2));
  const ev = createEvaluator(bars);
  const fired = bars.map((b, i) => ev.at(s, i, { describe: false })).filter(r => r.direction);
  assert.strictEqual(fired.length, 1, 'the setup fires once');
  // The next bar opens so far up that the value area high is under 2R from the fill.
  const gapTo = p.vah - 1.5 * fired[0].stopDistance;
  const run = extra => runEngine([{ symbol: 'MNQ', bars: [...bars, ...extra], tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, window: 100 }).trades; // a short warm-up: these bars start a day before
  assert.strictEqual(run([bar(DAY2 + 2 * S, gapTo, gapTo)]).length, 0, 'gapped under 2R: skipped');
  assert.strictEqual(run([bar(DAY2 + 2 * S, v + 2, v + 2.5), bar(DAY2 + 3 * S, v + 2.5, p.vah + 1)]).length, 1, 'a normal fill trades');
});

test('one home: an account run takes its limits from the account (the backtest-only maxDailyLoss and maxContracts never apply), a plain run its own', () => {
  const { tradingDayKey } = require('../../scripts/lib/trading/clock');
  const bars = propSeries(30);
  const start = Date.parse('2026-01-08T00:00:00Z');
  const gated = { ...propEngine, gate: true, gateConfig: { ...loadConfig({}), maxDailyLosses: 99, maxConsecutiveLosses: 99, lossCooldownMin: 0, maxEntriesPerDay: 0, noEntryWindows: '' }, start };
  const dayOf = t => tradingDayKey(new Date(t.entryTime));
  // Entries taken with the day already down $1 or more (net, closed trades before it).
  const afterLoss = ts => ts.filter((t, i) => ts.slice(0, i).filter(p => dayOf(p) === dayOf(t)).reduce((a, p) => a + p.net, 0) <= -1).length;
  // A $1 realized-loss stop: a plain run ends each day at its first net loss.
  const plain = runEngine([propMarket(bars)], [propStrategy()], { ...gated, maxDailyLoss: 1 }).trades;
  assert.ok(plain.length > 0);
  assert.strictEqual(afterLoss(plain), 0, 'a plain run stops the day at its maxDailyLoss');
  assert.ok(afterLoss(runEngine([propMarket(bars)], [propStrategy()], { ...gated, maxDailyLoss: 0 }).trades) > 0, 'the fixture has days that trade on after a loss');
  // The same stop never reaches an account run: its daily limits are the account's (soft stop off, no firm limit here).
  const acct = propAccount({ daily_loss_soft: 0, daily_loss_limit: 0, max_loss: 100000, loss_streak_stop: 0 });
  const withAccount = runEngine([propMarket(bars)], [propStrategy()], { ...gated, maxDailyLoss: 1, account: acct }).trades;
  assert.ok(afterLoss(withAccount) > 0, 'an account run trades on after a loss: the backtest-only stop is not its limit');
  // maxContracts (backtest-only) never caps an account run: its size is the account's max_contracts and budget.
  const big = runEngine([propMarket(bars)], [propStrategy()], { ...gated, maxContracts: 1, account: acct, sizing: testSizing({ cushion_frac: 0.5 }) }).trades;
  assert.ok(big.some(t => t.size > 1), 'sized past the backtest-only maxContracts');
});

test('one home: a fee is never assumed: a plain run states it, an account run takes its profile\'s, a missing one is refused', () => {
  const bars = propSeries(10);
  const market = { ...propMarket(bars), feesPerSide: undefined };
  assert.throws(() => runEngine([market], [propStrategy()], propEngine), /MNQ: no fee per side .* a fee is never assumed/);
  assert.ok(Array.isArray(runEngine([market], [propStrategy()], { ...propEngine, feesPerSide: 0.5 }).trades), 'the run-wide fee prices it');
  assert.throws(() => runEngine([market], [propStrategy()], { ...propEngine, account: propAccount({ fees_per_side: {} }) }), /mini: no fees_per_side\.MNQ in its ACCOUNT\.md; a fee is never assumed/);
  // The account's fee prices the trade, never the market's own.
  const t = runEngine([{ ...market, feesPerSide: 9 }], [propStrategy()], { ...propEngine, account: propAccount({ fees_per_side: { MNQ: 0.6 } }), start: Date.parse('2026-01-08T00:00:00Z') }).trades[0];
  assert.strictEqual(t.fees, Math.round(2 * 0.6 * t.size * 100) / 100);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' } }, ROOT), /feesPerSide: no fee for MNQ; .* a fee is never assumed/);
  const acct = propAccount();
  assert.strictEqual(validateBacktestConfig({ data: { MNQ: 'a.csv' } }, ROOT, { account: acct }).markets[0].feesPerSide, 0.37, 'a policy run is priced with its account\'s fee');
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, feesPerSide: 0.1 }, ROOT, { account: acct }), /a policy run's fees are its account's/);
  for (const k of ['maxDailyLoss', 'maxContracts']) assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, [k]: 5 }, ROOT, { account: acct }), new RegExp(`${k}: a policy run's limits are its account's`));
});

test('one home: an account run without a whole sizing is refused, never sized by a code default', () => {
  const bars = propSeries(10);
  const EXIT1 = { trail_activate_r: 2, trail_giveback_r: 0.5 };
  const opts = { ...propEngine, account: propAccount(), start: Date.parse('2026-01-08T00:00:00Z') };
  for (const sizing of [null, {}, { cushion_frac: 0.2 }]) {
    assert.throws(() => runEngine([propMarket(bars)], [propStrategy()], { ...opts, sizing }), /mini: an account run sizes from a policy's rulebook entry/);
  }
  // The policy strategy's own sizing (the strategy loader's, from the rulebook) when the run states none.
  const viaPolicy = runEngine([propMarket(bars)], [propStrategy()], { ...opts, sizing: null, prop: { strategy: { sizing: TEST_SIZING, exit: EXIT1 }, components: ['trendy'], contracts: 'micro' } });
  assert.ok(viaPolicy.trades.length > 0);
  assert.deepStrictEqual(viaPolicy.trades.map(t => t.size), runEngine([propMarket(bars)], [propStrategy()], { ...opts, prop: { strategy: { exit: EXIT1 }, components: ['trendy'], contracts: 'micro' } }).trades.map(t => t.size));
});
