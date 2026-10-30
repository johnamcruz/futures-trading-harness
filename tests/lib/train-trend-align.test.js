'use strict';

// Which census legs enter a trend pool (scripts/lib/train/trend-align.js) and how far a leg's window reaches
// (trend-windows.js reach): the 4h and the 1h at the leg's start read causally by the policy's own check, the opening
// print's legs, the plan's line; every default today's.

const test = require('node:test');
const assert = require('node:assert');
const TA = require('../../scripts/lib/train/trend-align');
const TW = require('../../scripts/lib/train/trend-windows');
const PC = require('../../scripts/lib/train/probe-config');
const { validateConfig } = require('../../scripts/lib/autotrader');

const STEP = 180000;
/** 3m bars from `from` for `days` days, the close moving `drift` points a bar (a steady trend: every frame its way). */
function bars(from, days, drift, start = 20000) {
  const out = [];
  const t0 = Date.parse(from);
  for (let i = 0; i < (days * 86400000) / STEP; i += 1) {
    const c = start + drift * i + (i % 2 ? 1 : -1);
    out.push({ t: new Date(t0 + i * STEP).toISOString(), o: c - drift, h: c + 2, l: c - 2, c, v: 100 });
  }
  return out;
}
const UP = bars('2022-02-20T00:00:00.000Z', 16, 0.5);
const leg = (side, start, end) => ({ id: `${start.slice(0, 10)}|${side}|${start}`, day: start.slice(0, 10), side, start, end, points: 30 });

test('trendsAt: the 4h and the 1h as of the bars closed by the leg\'s start bar\'s open; never the leg\'s own bars (no look-ahead)', () => {
  const s = TA.htfSeries(UP);
  const start = '2022-03-07T15:00:00.000Z';
  assert.deepStrictEqual(TA.trendsAt(s, start), { '4h': 'up', '1h': 'up' });
  // The bars from the leg's start on replaced by a crash: the read at its start is the same (only bars before it count).
  const cut = UP.findIndex(b => b.t === start);
  const crash = [...UP.slice(0, cut), ...bars(start, 2, -40, UP[cut].c).map(b => ({ ...b }))];
  assert.deepStrictEqual(TA.trendsAt(TA.htfSeries(crash), start), { '4h': 'up', '1h': 'up' });
  // The index read is the bar before the start bar (its close is the start bar's open).
  assert.strictEqual(TA.lastBefore(s.times, Date.parse(start)), cut - 1);
  // Before any history: unknown (null), never a guess.
  assert.deepStrictEqual(TA.trendsAt(s, '2022-02-20T00:00:00.000Z'), { '4h': null, '1h': null });
  // A long series down: both down.
  assert.deepStrictEqual(TA.trendsAt(TA.htfSeries(bars('2022-02-20T00:00:00.000Z', 16, -0.5, 30000)), start), { '4h': 'down', '1h': 'down' });
});

test('aligned: the policy\'s own check (bias_frames [4h, 1h], bias_agree on): both the side\'s way, else not; unknown: not', () => {
  const T = ['up', 'range', 'down', null];
  for (const a of T) for (const b of T) {
    assert.strictEqual(TA.aligned('long', { '4h': a, '1h': b }), a === 'up' && b === 'up', `long ${a}/${b}`);
    assert.strictEqual(TA.aligned('short', { '4h': a, '1h': b }), a === 'down' && b === 'down', `short ${a}/${b}`);
  }
});

test('the opening print: the runner\'s first no-entry window holding the cash open; a leg inside it, or of 3 bars or fewer starting in it', () => {
  const w = TA.openingWindow();
  assert.deepStrictEqual([w.start, w.end, w.timeZone], [570, 575, 'America/New_York'], 'config/runner.json gate.noEntryWindows: 09:30-09:35');
  assert.strictEqual(TA.openingWindow(['15:45-16:00@America/New_York']), null, 'none holds the open');
  const o = { window: w, minutes: 3, maxBars: 3 };
  // 2022-03-07 (EST): 09:30 ET is 14:30Z.
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:30:00.000Z', '2022-03-07T14:33:00.000Z'), o), true, 'starts and ends inside');
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:33:00.000Z', '2022-03-07T14:39:00.000Z'), o), true, '3 bars from inside');
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:33:00.000Z', '2022-03-07T14:42:00.000Z'), o), false, '4 bars: catchable');
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:36:00.000Z', '2022-03-07T14:39:00.000Z'), o), false, 'starts after it');
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:30:00.000Z', '2022-03-07T14:42:00.000Z'), { ...o, maxBars: 5 }), true, 'the bar count is config (trendSet.openingMaxBars)');
  assert.strictEqual(TA.inOpening(leg('long', '2022-03-07T14:30:00.000Z', '2022-03-07T14:33:00.000Z'), { ...o, window: null }), false);
});

test('filterLegs: align htf keeps the legs both frames trend the way of; opening drop leaves out the opening print; all and keep: every leg, in order', () => {
  const series = TA.htfSeries(UP);
  const L = [leg('long', '2022-03-07T15:00:00.000Z', '2022-03-07T15:30:00.000Z'), leg('short', '2022-03-07T15:30:00.000Z', '2022-03-07T16:00:00.000Z'), leg('long', '2022-03-08T14:30:00.000Z', '2022-03-08T14:33:00.000Z'), leg('long', '2022-02-20T00:30:00.000Z', '2022-02-20T01:00:00.000Z')];
  const spans = Object.fromEntries(L.map(g => [g.id, g]));
  const ids = L.map(g => g.id);
  const opt = { series, minutes: 3, window: TA.openingWindow(), maxBars: 3 };
  assert.deepStrictEqual(TA.filterLegs(ids, spans, opt), { kept: ids, dropped: { align: [], opening: [] } }, 'the defaults: every leg');
  const htf = TA.filterLegs(ids, spans, { ...opt, align: 'htf' });
  assert.deepStrictEqual(htf.kept, [ids[0], ids[2]]);
  assert.deepStrictEqual(htf.dropped.align, [ids[1], ids[3]], 'the short against both, and a leg before any history (unknown)');
  const both = TA.filterLegs(ids, spans, { ...opt, align: 'htf', opening: 'drop' });
  assert.deepStrictEqual([both.kept, both.dropped], [[ids[0]], { align: [ids[1], ids[3]], opening: [ids[2]] }]);
  assert.throws(() => TA.filterLegs(ids, spans, { ...opt, align: 'htf', series: null }), /align htf: the bars/);
  assert.throws(() => TA.filterLegs(ids, spans, { ...opt, align: 'any' }), /align: all or htf/);
  assert.throws(() => TA.filterLegs(ids, spans, { ...opt, opening: 'cut' }), /opening: keep or drop/);
  assert.throws(() => TA.filterLegs(['x'], spans, opt), /no span for leg x/);
});

test('a leg window\'s reach: catch (the default, today\'s) through its catch window; end through its end bar; nothing else', () => {
  const TRADER = validateConfig({ harness: 'claude', model: 'm', symbols: ['MNQ'], account: '1', timeframe: 3, premarketAt: '', sessions: ['09:30-12:00@America/New_York'] });
  const DAY = '2022-03-07';
  const closes = TW.dayCloses(TRADER, DAY);
  const A = leg('long', `${DAY}T14:42:00.000Z`, `${DAY}T15:30:00.000Z`);
  const O = { day: DAY, closes, minutes: 3, seed: 1, leadBars: 4, controlPerLeg: 1, catchShare: 0.5, legs: [A] };
  const span = w => [new Date(w.from).toISOString(), new Date(w.to).toISOString()];
  const legW = r => r.windows.find(w => w.kind === 'leg');
  assert.deepStrictEqual(span(legW(TW.windowsFor(O))), [`${DAY}T14:30:00.000Z`, `${DAY}T15:06:00.000Z`], 'today\'s: the first half');
  assert.deepStrictEqual(span(legW(TW.windowsFor({ ...O, reach: 'catch' }))), span(legW(TW.windowsFor(O))));
  const end = TW.windowsFor({ ...O, reach: 'end' });
  assert.deepStrictEqual(span(legW(end)), [`${DAY}T14:30:00.000Z`, `${DAY}T15:33:00.000Z`], 'through the end bar\'s close (15:30 + 3 min)');
  // Its control window is as long (the same length, clear of the leg): the cost per leg grows with it.
  const ctl = end.windows.find(w => w.kind === 'control');
  assert.strictEqual(ctl.to - ctl.from, legW(end).to - legW(end).from);
  assert.throws(() => TW.windowsFor({ ...O, reach: 'half' }), /reach catch or end/);
  assert.strictEqual(require('../../scripts/lib/tunables').training().trendWindows.reach, 'catch', 'the shipped default: today\'s');
});

test('probe.trend align, bars, opening, reach: resolved with the pool filtered and said; the defaults unchanged; bad values refused', () => {
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
  const curated = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
  const order = [leg('long', '2022-03-07T15:00:00.000Z', '2022-03-07T15:30:00.000Z'), leg('short', '2022-03-07T15:30:00.000Z', '2022-03-07T16:00:00.000Z'), leg('long', '2022-03-08T14:30:00.000Z', '2022-03-08T14:33:00.000Z'), leg('long', '2022-03-09T15:00:00.000Z', '2022-03-09T15:30:00.000Z')];
  const set = { kind: 'leg-census', fingerprint: 'fp', order };
  const base = { replay: curated, windows: [{ from: '2022-03-01', to: '2022-03-05' }] };
  const read = [];
  const go = t => PC.resolveProbe({ ...base, trend: { replay: { stage: 1 }, census: 'c.json', from: '2022-03-06', to: '2022-03-10', ...t } }, {
    read: x => x, readCensus: () => set, readBars: (file, minutes) => { read.push([file, minutes]); return UP; }, resolvePath: p => `/abs/${p}`, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: [],
  });
  const plain = go({}).trend;
  assert.deepStrictEqual([plain.set.legs, plain.set.filter, plain.reach], [order.map(g => g.id), { align: 'all', opening: 'keep', pool: 4, dropped: { align: 0, opening: 0 } }, 'catch'], 'the defaults: every leg, to its catch window');
  assert.deepStrictEqual(read, [], 'no bars read without align htf');
  const all = go({ align: 'htf', bars: 'MNQ-3m.csv', opening: 'drop', reach: 'end' }).trend;
  assert.deepStrictEqual(read, [['/abs/MNQ-3m.csv', 3]], 'the bars file, at the trend replay\'s base timeframe');
  assert.deepStrictEqual(all.set.legs, [order[0].id, order[3].id]);
  assert.deepStrictEqual(all.set.filter, { align: 'htf', opening: 'drop', pool: 4, dropped: { align: 1, opening: 1 }, bars: 'MNQ-3m.csv' });
  assert.strictEqual(all.reach, 'end');
  assert.deepStrictEqual(all.set.days, ['2022-03-07', '2022-03-09']);
  // The dropped legs stay census legs: their spans are kept (no control window enters them), on a kept leg's day.
  assert.ok(all.set.spans[order[1].id], 'the dropped short beside a kept leg');
  assert.throws(() => go({ align: 'htf' }), /probe.trend.bars: align htf reads the 4h and 1h trend/);
  assert.throws(() => go({ bars: 'x.csv' }), /probe.trend.bars: read only with align htf/);
  assert.throws(() => go({ align: 'yes' }), /probe.trend.align: all or htf, not "yes"/);
  assert.throws(() => go({ opening: 'cut' }), /probe.trend.opening: keep or drop, not "cut"/);
  assert.throws(() => go({ reach: 'half' }), /probe.trend.reach: catch or end, not "half"/);
  assert.throws(() => PC.resolveProbe({ ...base, trend: { replay: { stage: 1 }, census: 'c.json', from: '2022-03-06', to: '2022-03-10', align: 'htf', bars: 'x' } }, { read: x => x, readCensus: () => set, readBars: () => { throw new Error('no such file'); }, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: [] }), /probe.trend.bars: no such file/);
});
