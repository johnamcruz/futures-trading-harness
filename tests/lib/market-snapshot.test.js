'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { snapshot } = require('../../scripts/lib/trading/market-snapshot');

// 3-min bars: a flat overnight, then an RTH opening range and an upside breakout.
function session() {
  const bars = [];
  let t = Date.UTC(2026, 9, 6, 22, 0); // 18:00 ET
  const push = (o, h, l, c, v = 100) => { bars.push({ t: new Date(t).toISOString(), o, h, l, c, v }); t += 180000; };
  while (t < Date.UTC(2026, 9, 7, 13, 30)) push(100, 100.5, 99.5, 100);
  for (let i = 0; i < 5; i += 1) push(100, 101, 99, 100); // OR 09:30-09:45 ET: 99..101
  for (let i = 0; i < 20; i += 1) push(100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.2 + i * 0.1);
  return bars;
}

test('snapshot reports trend, levels, and the reference stop', () => {
  const s = snapshot({ bars: session() });
  assert.strictEqual(s.levels.openingRange.high, 101);
  assert.strictEqual(s.levels.openingRange.low, 99);
  assert.deepStrictEqual(s.levels.overnight, { high: 100.5, low: 99.5 });
  assert.ok(s.levels.vwapRth > 99 && s.levels.vwapRth < 103);
  assert.ok(s.referenceStop.distance > 0);
  assert.strictEqual(s.signals, undefined, 'triggers come from the strategies\' rules, not the snapshot');
});

test('snapshot rejects too few bars', () => {
  assert.throws(() => snapshot([]), /at least 3 bars/);
});

test('CLI reads a file and validates parameters', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fth-')), 'bars.json');
  fs.writeFileSync(file, JSON.stringify({ bars: session() }));
  const cli = path.resolve(__dirname, '..', '..', 'scripts', 'market-snapshot.js');
  const ok = spawnSync(process.execPath, [cli, file, '--orbMinutes=30'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).params.orbMinutes, 30);
  const bad = spawnSync(process.execPath, [cli, file, '--nope=1'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown parameter/);
});

test('snapshot: participation, VWAP crosses and distance, swings, equal highs, open FVGs; flags in either form', () => {
  const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
  const t0 = Date.parse('2025-03-10T13:30:00Z'); // 09:30 ET
  // A bar before the open, so today's RTH VWAP is a whole session.
  const rows = [{ t: new Date(t0 - 180000).toISOString(), o: 100, h: 100.5, l: 99.5, c: 100, v: 50 }];
  for (let k = 0; k < 60; k += 1) {
    const c = 100 + (k % 10 < 5 ? k % 10 : 10 - (k % 10)); // a zigzag: swing highs at 105, equal
    rows.push({ t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 0.5, l: c - 0.5, c, v: k < 5 ? 100 : 50 });
  }
  // A bullish gap 3 bars from the end that nothing has filled, its middle bar a strong displacement candle.
  rows.push({ t: new Date(t0 + 60 * 180000).toISOString(), o: 101, h: 101.5, l: 100.5, c: 101, v: 200 });
  rows.push({ t: new Date(t0 + 61 * 180000).toISOString(), o: 101.5, h: 104, l: 101.25, c: 103.75, v: 200 });
  rows.push({ t: new Date(t0 + 62 * 180000).toISOString(), o: 104, h: 105, l: 103.5, c: 105, v: 200 });
  const s = snapshot(rows);
  assert.strictEqual(s.participation.relVolLastVsOpeningRange, 2, 'opening range bars averaged 100');
  assert.strictEqual(s.participation.relVolLast3VsPrior20, 4);
  assert.strictEqual(s.vwap.applies, 'rth');
  assert.ok(s.vwap.rthCrossesLast30 > 0);
  assert.ok(s.liquidity.swingHighs.length > 0 && s.liquidity.equalHighs.length > 0);
  assert.deepStrictEqual(s.liquidity.openFvgs.at(-1), { side: 'bullish', low: 101.5, high: 103.5, at: rows[62].t });
  const path = require('path');
  const { spawnSync } = require('child_process');
  const csv = path.resolve(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv');
  const cli = args => spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'market-snapshot.js'), csv, ...args], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(cli(['--orbMinutes', '30']).stdout).params.orbMinutes, 30);
  assert.strictEqual(JSON.parse(cli(['--orbMinutes=20']).stdout).params.orbMinutes, 20);
  assert.match(cli(['--bogus', '1']).stderr, /unknown parameter --bogus/);
  // The volume profile block, on the real bars: prior RTH day, session, rolling.
  const vpBlock = JSON.parse(cli([]).stdout).volumeProfile;
  for (const k of ['priorRth', 'session', 'rolling']) {
    const x = vpBlock[k];
    assert.ok(x && x.val < x.poc && x.poc < x.vah, `${k}: ${JSON.stringify(x)}`);
    assert.ok(['above value', 'inside value', 'below value'].includes(x.price));
  }
  assert.strictEqual(vpBlock.rolling.bars, 360);
  assert.match(vpBlock.note, /bar-based approximation/);
});

test('snapshot levels: a day or overnight session the data starts partway into gives no levels', () => {
  const { levels } = require('../../scripts/lib/trading/market-snapshot');
  const at = iso => ({ t: iso, o: 100, h: 101, l: 99, c: 100, v: 1 });
  // Data starting at 12:00 ET on Tuesday: Tuesday's RTH is partial, the overnight too.
  const bars = ['2026-10-06T16:00:00Z', '2026-10-06T19:00:00Z', '2026-10-06T22:30:00Z', '2026-10-07T12:00:00Z'].map(at);
  bars[1].h = 150;
  const l = levels(bars);
  assert.strictEqual(l.priorRth, null, 'Tuesday began at noon in the data: not a whole day');
  assert.deepStrictEqual(l.overnight, { high: 101, low: 99 }, 'the overnight session from 18:00 Tue is whole');
  const late = levels(['2026-10-06T23:00:00Z', '2026-10-07T12:00:00Z'].map(at));
  assert.strictEqual(late.overnight, null, 'data starting after 18:00 ET: the overnight is partial');
});

test('participation counts by trading day: the evening (from the 18:00 ET open) has no opening range; midday and the close use the day\'s own', () => {
  // Sunday 18:00 ET to 21:27 (volume 50), Monday's RTH (opening range volume 200, then 100), Monday 18:00 to 21:27 (100).
  const bars = [];
  const add = (from, to, v) => { for (let t = from; t < to; t += 180000) bars.push({ t: new Date(t).toISOString(), o: 100, h: 100.5, l: 99.5, c: 100, v }); };
  const et = (d, h, m) => Date.UTC(2026, 9, d, h + 4, m); // October: ET = UTC-4
  add(et(11, 18, 0), et(11, 21, 30), 50);
  add(et(12, 9, 30), et(12, 9, 45), 200);
  add(et(12, 9, 45), et(12, 16, 0), 100);
  add(et(12, 18, 0), et(12, 21, 30), 100);
  const evening = snapshot({ bars }).participation;
  assert.strictEqual(evening.relVolLastVsOpeningRange, null, 'Tuesday\'s trading day: its range hasn\'t opened');
  assert.strictEqual(evening.relVolLast3VsOpeningRange, null);
  // Same minute a day earlier (the same bar whether days split at 18:00 or midnight): 21:27 ET Monday vs Sunday, 100 / 50.
  assert.strictEqual(evening.relVolVsSameTimePriorDay, 2);
  const midday = snapshot({ bars: bars.filter(b => Date.parse(b.t) <= et(12, 10, 0)) }).participation;
  assert.strictEqual(midday.relVolLastVsOpeningRange, 0.5, 'Monday\'s own range (100 / 200)');
  const breakTime = snapshot({ bars: bars.filter(b => Date.parse(b.t) < et(12, 16, 0)) }).participation;
  assert.strictEqual(breakTime.relVolLastVsOpeningRange, 0.5, 'still Monday\'s range at the close');
});

test('priorDayCandle: the prior RTH day as a daily candle: direction, close location, and close against the day before', () => {
  const { priorDayCandle, levels } = require('../../scripts/lib/trading/market-snapshot');
  const et = (d, h, m) => new Date(Date.UTC(2026, 9, d, h + 4, m)).toISOString(); // October: ET = UTC-4
  // A whole RTH day as three 3m bars: the 09:30 bar (its open), a bar making its high and low, and the 15:57 bar (its close).
  const day = (d, o, h, l, c) => [{ t: et(d, 9, 30), o, h: o, l: o, c: o, v: 1 },
    { t: et(d, 12, 0), o, h, l, c: o, v: 1 }, { t: et(d, 15, 57), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 }];
  const after = d => ({ t: et(d, 18, 0), o: 1, h: 1, l: 1, c: 1, v: 1 });
  const monday = day(12, 105, 110, 100, 108);
  // Tuesday opens 104, trades 102-120, closes 119: up, the top third, above Monday's high.
  const up = [...monday, ...day(13, 104, 120, 102, 119), after(13)];
  const c = priorDayCandle(up);
  assert.deepStrictEqual(c, { day: '2026-10-13', open: 104, dir: 'up', closeLocation: 'top', dayBefore: { day: '2026-10-12', high: 110, low: 100 }, closeVsDayBefore: 'above its high' });
  // The same day as levels().priorRth (the briefing's day.priorRth): one prior day, one value.
  assert.strictEqual(c.day, levels(up).priorRth.day);
  assert.strictEqual(levels(up).priorRth.close, 119);
  // Down, the bottom third, below the day before's low; inside its range; flat in the middle.
  const down = priorDayCandle([...monday, ...day(13, 104, 106, 90, 91), after(13)]);
  assert.deepStrictEqual([down.dir, down.closeLocation, down.closeVsDayBefore], ['down', 'bottom', 'below its low']);
  const inside = priorDayCandle([...monday, ...day(13, 104, 109, 99, 104), after(13)]);
  assert.deepStrictEqual([inside.dir, inside.closeLocation, inside.closeVsDayBefore], ['flat', 'middle', 'inside its range']);
  // Before Tuesday's 16:00 ET close, Monday is the prior day; its day before isn't in the bars: null.
  const mid = priorDayCandle([...monday, ...day(13, 104, 120, 102, 119).slice(0, 2)]);
  assert.deepStrictEqual([mid.day, mid.dayBefore, mid.closeVsDayBefore], ['2026-10-12', null, null]);
  // A partial day before (no 09:30 bar): no day before. No whole prior day, or no bars: null.
  assert.strictEqual(priorDayCandle([...monday.slice(1), ...day(13, 104, 120, 102, 119), after(13)]).dayBefore, null);
  assert.strictEqual(priorDayCandle([...day(13, 104, 120, 102, 119).slice(1), after(13)]), null);
  assert.strictEqual(priorDayCandle([]), null);
});

test('priorDayCandle: causal at every bar of the fixtures: the cut bars give what the days complete by then give, and it changes only at the RTH close', () => {
  const path = require('path');
  const { priorDayCandle, levels } = require('../../scripts/lib/trading/market-snapshot');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const etParts = t => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
  };
  for (const f of ['NQ-3m.csv', 'RTY-3m.csv']) {
    const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', f));
    const ets = bars.map(b => etParts(b.t));
    let seen = 0;
    let changes = 0;
    let prev = null;
    for (let i = 0; i < bars.length; i += 1) {
      const cut = bars.slice(0, i + 1);
      const got = priorDayCandle(cut);
      // An independent reference read from the FULL series: the RTH days (09:30-16:00 ET) whose close has passed by bar i.
      const days = new Map();
      for (let j = 0; j < bars.length; j += 1) {
        const e = ets[j];
        if (e.minute < 570 || e.minute >= 960) continue;
        if (!(e.day < ets[i].day || (e.day === ets[i].day && ets[i].minute >= 960))) continue;
        const d = days.get(e.day) || { o: bars[j].o, h: -Infinity, l: Infinity, c: null, whole: e.minute === 570 };
        d.h = Math.max(d.h, bars[j].h); d.l = Math.min(d.l, bars[j].l); d.c = bars[j].c;
        days.set(e.day, d);
      }
      const keys = [...days.keys()].sort();
      const k = keys.map(x => days.get(x).whole).lastIndexOf(true);
      if (k < 0) { assert.strictEqual(got, null, `${f} bar ${i}`); continue; }
      const p = days.get(keys[k]);
      const q = k > 0 && days.get(keys[k - 1]).whole ? days.get(keys[k - 1]) : null;
      seen += 1;
      assert.strictEqual(got.day, keys[k], `${f} bar ${i}`);
      assert.strictEqual(got.day, levels(cut).priorRth.day, `${f} bar ${i}: the briefing's prior RTH day`);
      assert.strictEqual(got.open, p.o);
      assert.strictEqual(got.dir, p.c > p.o ? 'up' : p.c < p.o ? 'down' : 'flat');
      const at = (p.c - p.l) / (p.h - p.l);
      assert.strictEqual(got.closeLocation, at >= 2 / 3 ? 'top' : at <= 1 / 3 ? 'bottom' : 'middle', `${f} bar ${i}`);
      assert.strictEqual(got.closeVsDayBefore, !q ? null : p.c > q.h ? 'above its high' : p.c < q.l ? 'below its low' : 'inside its range', `${f} bar ${i}`);
      if (prev && JSON.stringify(prev) !== JSON.stringify(got)) {
        changes += 1;
        // It changes only on the first bar at or after a 16:00 ET close.
        assert.ok(ets[i].minute >= 960 || ets[i].day !== ets[i - 1].day, `${f} bar ${i}: changed mid-session`);
      }
      prev = got;
    }
    assert.ok(seen > 200 && changes >= 2, `${f}: ${seen} bars with a prior day, ${changes} changes`);
  }
});
