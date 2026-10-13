'use strict';

// The scan is scoped to the bars' timeframe: the strategies_scan tool judges only the strategies on the bars'
// own timeframe (a 1m strategy is not a signal on 3m bars, nor the reverse), with the runner's own filter
// (trading/strategies.js onTimeframe, used by runner-wiring.js runnerScan), and refuses a strategy asked for by
// name on bars of another timeframe without evaluating it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const G = require('../fixtures/golden-bars');
const T = require('../../scripts/lib/trading/strategies');
const { runnerScan } = require('../../scripts/lib/runner-wiring');
const tool = require('../../scripts/lib/harness-tools/strategies');

const STRATEGIES = T.loadStrategies(G.ROOT, {}).strategies;
const N = 160; // bars per file
const byTf = tf => STRATEGIES.filter(s => s.valid && s.status !== 'disabled' && s.timeframe === tf);

/** A series' first N bars as a get_bars JSON file, with the time of its last bar's close. */
function barsFile(label) {
  const s = G.SERIES.find(x => x.label === label);
  const plain = G.load(s).slice(0, N);
  const file = path.join(tmpDir(), `${s.symbol}-${s.minutes}m.json`);
  fs.writeFileSync(file, JSON.stringify(G.served(G.broker(plain))));
  return { s, plain, file, now: new Date(plain[plain.length - 1].ms + s.minutes * 60000) };
}
const ctxAt = (now, symbol) => ({ env: { FTH_SYMBOLS: symbol }, now: () => new Date(now.getTime()) });
const json = text => JSON.parse(text);

const MIN = 60000;
const T0 = Date.UTC(2026, 3, 28, 14, 0);
const barAt = ms => ({ t: new Date(ms).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 });

test('barsStepMs: the smallest positive gap of the last 50 bars, null without one', () => {
  const at = m => barAt(T0 + m * MIN);
  assert.strictEqual(T.barsStepMs([at(0), at(3), at(6), at(30), at(33)]), 3 * MIN, 'a session break is longer than a bar');
  assert.strictEqual(T.barsStepMs([at(0)]), null);
  assert.strictEqual(T.barsStepMs([]), null);
});

test('barsStepMs on irregular bars: only the last 50 count; repeated times and breaks are not the step', () => {
  // A 1m gap at the start, then 3m bars with breaks of 6 and 15 minutes and a repeated bar time in the window.
  const times = [0, 1];
  for (let k = 0; times.length < 60; k += 1) times.push(times[times.length - 1] + (k % 11 === 5 ? 15 : k % 7 === 3 ? 6 : 3));
  const bars = times.map(m => barAt(T0 + m * MIN));
  bars.splice(55, 0, { ...bars[54] }); // the same bar time twice
  assert.strictEqual(T.barsStepMs(bars), 3 * MIN, 'the 1m gap is outside the last 50 bars');
  assert.strictEqual(T.barsStepMs(bars.slice(0, 50)), MIN, 'and the step when it is inside');
  // Only breaks in the window: the smallest of them.
  assert.strictEqual(T.barsStepMs([0, 6, 21, 27].map(m => barAt(T0 + m * MIN))), 6 * MIN);
});

test('barsTimeframe: the step as the runner names its timeframe (minutes), null when not whole minutes', () => {
  assert.deepStrictEqual([MIN, 3 * MIN, 60 * MIN, 30000, 90000, null, 0].map(T.barsTimeframe), ['1m', '3m', '60m', null, null, null, null]);
});

test('onTimeframe: the timeframe text as written (the runner\'s comparison); none for an unknown one', () => {
  const xs = [{ name: 'a', timeframe: '1m' }, { name: 'b', timeframe: '3m' }, { name: 'c', timeframe: '60m' }, { name: 'd', timeframe: '1h' }, { name: 'e' }];
  const names = tf => T.onTimeframe(xs, tf).map(x => x.name);
  assert.deepStrictEqual(names('1m'), ['a']);
  assert.deepStrictEqual(names('3m'), ['b']);
  assert.deepStrictEqual(names('60m'), ['c'], 'a 1h strategy is not on 60m bars');
  assert.deepStrictEqual(names('1h'), ['d']);
  assert.deepStrictEqual(names(null), []);
  assert.deepStrictEqual(names(''), []);
  assert.deepStrictEqual(names('2m'), []);
});

test('runnerScan: the strategies whose timeframe text is the runner\'s `${minutes}m`, no other spelling of it', () => {
  const base = STRATEGIES.find(s => s.valid && s.signal === 'rules' && s.timeframe === '3m' && s.instruments.includes('MNQ'));
  const as = (name, timeframe) => ({ ...base, name, timeframe });
  const xs = [as('t60m', '60m'), as('t1h', '1h'), as('t3m', '3m'), as('t1m', '1m')];
  const bars = Array.from({ length: 40 }, (_x, i) => ({ ...barAt(T0 + i * 60 * MIN), o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const names = minutes => runnerScan(xs, { timeframe: minutes, symbols: ['MNQ'] }, 'MNQ', bars, new Date(T0 + 40 * 60 * MIN)).map(r => r.name);
  assert.deepStrictEqual(names(60), ['t60m']);
  assert.deepStrictEqual(names(3), ['t3m']);
  assert.deepStrictEqual(names(1), ['t1m']);
  assert.deepStrictEqual(names(5), []);
});

test('strategies_scan on bars no strategy trades: says so and lists the timeframes there, scanning nothing', () => {
  const s = G.SERIES.find(x => x.label === 'MNQ 3m');
  const bars = G.served(G.load(s).slice(0, N)).map((b, i) => ({ ...b, t: new Date(T0 + i * 15 * MIN).toISOString() }));
  const file = path.join(tmpDir(), 'MNQ-15m.json');
  fs.writeFileSync(file, JSON.stringify(bars));
  const ctx = ctxAt(new Date(T0 + N * 15 * MIN), 'MNQ');
  const tfs = [...new Set(STRATEGIES.filter(x => x.valid && x.status !== 'disabled').map(x => x.timeframe))].sort();
  assert.ok(tfs.length >= 2 && !tfs.includes('15m'));
  const note = `no strategy trades 15m bars; strategies here trade ${tfs.join(', ')}: nothing was scanned\n`;
  assert.deepStrictEqual(tool.scan({ file, symbol: 'MNQ', view: 'summary' }, ctx), { text: note });
  assert.deepStrictEqual(tool.scan({ file, symbol: 'MNQ' }, ctx), { text: '[]\n', stderr: `[strategies] ${note}` }, 'the JSON stays JSON; the note on stderr');
  // Bars a strategy does trade get no note.
  const { file: f3, now } = barsFile('MNQ 3m');
  assert.strictEqual(tool.scan({ file: f3, symbol: 'MNQ', view: 'summary' }, ctxAt(now, 'MNQ')).stderr, undefined);
  assert.doesNotMatch(tool.scan({ file: f3, symbol: 'MNQ', view: 'summary' }, ctxAt(now, 'MNQ')).text, /no strategy trades/);
});

test('the shipped strategies are on both timeframes (else the tests below prove nothing)', () => {
  assert.ok(byTf('1m').some(s => s.signal === 'rules' && s.instruments.includes('MNQ')), 'a 1m rules strategy trading MNQ');
  assert.ok(byTf('3m').some(s => s.signal === 'rules' && s.instruments.includes('MNQ')), 'a 3m rules strategy trading MNQ');
});

for (const [label, tf, other] of [['MNQ 3m', '3m', '1m'], ['MNQ 1m', '1m', '3m']]) {
  test(`strategies_scan on ${tf} bars: only the ${tf} strategies, in every view`, () => {
    const { s, file, now } = barsFile(label);
    const ctx = ctxAt(now, s.symbol);
    const full = json(tool.scan({ file, symbol: s.symbol }, ctx).text);
    assert.ok(full.length > 0);
    const want = new Set(byTf(tf).map(x => x.name));
    for (const r of full) assert.ok(want.has(r.name), `${r.name} is not a ${tf} strategy`);
    const summary = tool.scan({ file, symbol: s.symbol, view: 'summary' }, ctx).text;
    for (const x of byTf(other)) assert.ok(!new RegExp(`\\b${x.name}\\b`).test(summary), `${x.name} (${other}) is not in the summary on ${tf} bars`);
  });

  test(`strategies_scan and the runner agree on ${tf} bars`, () => {
    const { s, plain, file, now } = barsFile(label);
    const fromTool = json(tool.scan({ file, symbol: s.symbol }, ctxAt(now, s.symbol)).text);
    const fromRunner = runnerScan(STRATEGIES, { timeframe: s.minutes, symbols: [s.symbol] }, s.symbol, G.broker(plain), now);
    assert.deepStrictEqual(fromTool, json(JSON.stringify(fromRunner)));
  });

  test(`strategies_scan name: a ${other} strategy on ${tf} bars is refused, not evaluated`, () => {
    const { s, file, now } = barsFile(label);
    const ctx = ctxAt(now, s.symbol);
    const pick = t => byTf(t).find(x => x.signal === 'rules' && x.instruments.includes(s.symbol));
    const asked = pick(other);
    const own = pick(tf);
    const refused = e => e.message === `${asked.name} trades ${other} bars, and these bars are ${tf}: not scanned (scan it on ${other} bars)` && !e.text;
    assert.throws(() => tool.scan({ file, symbol: s.symbol, view: 'one', name: asked.name }, ctx), refused);
    // Refused before any evaluation: on two bars (too few for a scan, which refuses them) the refusal is the same.
    const two = path.join(tmpDir(), 'two.json');
    fs.writeFileSync(two, JSON.stringify(json(fs.readFileSync(file, 'utf8')).slice(-2)));
    assert.throws(() => tool.scan({ file: two, symbol: s.symbol, view: 'one', name: own.name }, ctx), /need at least 3 bars/, 'a scan refuses two bars');
    assert.throws(() => tool.scan({ file: two, symbol: s.symbol, view: 'one', name: asked.name }, ctx), refused);
    // A strategy on the bars' own timeframe is still scanned by name.
    assert.strictEqual(json(tool.scan({ file, symbol: s.symbol, view: 'one', name: own.name }, ctx).text).name, own.name);
  });
}
