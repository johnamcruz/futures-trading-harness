'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const fsy = require('../../scripts/lib/field-study');

const ROOT = path.resolve(__dirname, '..', '..');
const TICK = 0.25;
const MIN = 60000;

/** Standard normal from a seeded uniform source. */
function gauss(u) {
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/**
 * Synthetic 1-minute bars over `days` weekdays from 2022-02-07 (Train), 08:00-16:59 New York (13:00Z-21:59Z,
 * winter): `x.pred` on bar t sets the move from t to t+1 (a planted predictive field); `x.same` on bar t is
 * bar t's own move plus noise (contemporaneous only). Prices on the tick grid.
 */
function synthBars({ days = 30, seed = 1, strength = 2 } = {}) {
  const g = gauss(fsy.rng(seed));
  const bars = [];
  let c = 15000;
  let pred = g();
  let day = 0;
  for (let d = 0; day < days; d += 1) {
    const base = Date.parse('2022-02-07T13:00:00Z') + d * 86400000;
    const wd = new Date(base).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    day += 1;
    for (let m = 0; m < 540; m += 1) {
      const inc = Math.round(strength * pred + 2 * g());
      const o = c;
      c = o + inc * TICK;
      const nextPred = g();
      bars.push({ t: new Date(base + m * MIN).toISOString(), ms: base + m * MIN, o, h: Math.max(o, c) + TICK, l: Math.min(o, c) - TICK, c, v: 10, x: { pred: nextPred, same: inc + 0.5 * g() } });
      pred = nextPred;
    }
  }
  return bars;
}

const FIELDS = ['x.pred', 'x.same'].map(fsy.parseFieldSpec);
const table = (bars, fields = FIELDS, tf = 1) => fsy.joinChunks([fsy.columns(bars, fields)], { timeframeMin: tf });

test('field specs and horizons: dotted paths with an optional look-back; bad input refused', () => {
  assert.deepStrictEqual(fsy.parseFieldSpec('a.b.3.c'), { spec: 'a.b.3.c', path: 'a.b.3.c', shift: 0 });
  assert.deepStrictEqual(fsy.parseFieldSpec('a.b[2]'), { spec: 'a.b[2]', path: 'a.b', shift: 2 });
  for (const bad of ['', 'a..b', 'a.b[-1]', 'a b', '3a', 'a.b[x]']) assert.throws(() => fsy.parseFieldSpec(bad), /dotted path/, bad);
  assert.deepStrictEqual(fsy.parseHorizons('15,1,3,3'), [1, 3, 15]);
  for (const bad of ['0', '1.5', 'x', '', '1001']) assert.throws(() => fsy.parseHorizons(bad), /horizons/, bad);
});

test('a planted predictive field is found; a contemporaneous-only field is reported as not predictive', () => {
  const t = table(synthBars());
  const res = fsy.study(t, { fields: FIELDS, horizons: [1, 3], tick: TICK, reps: 200, seed: 3 });
  const get = (f, k) => res.find(r => r.field === f && r.horizon === k);
  const p1 = get('x.pred', 1);
  assert.ok(p1.pearson > 0.4 && p1.spearman > 0.4, `IC ${p1.pearson}`);
  assert.ok(p1.ci.pearson[0] > 0.3 && p1.ci.spearman[0] > 0.3, 'its interval excludes zero');
  assert.ok(p1.deciles[9].meanMove > 2 && p1.deciles[0].meanMove < -2 && p1.ci.top[0] > 0 && p1.ci.bottom[1] < 0);
  assert.ok(p1.hit > 0.65, `hit ${p1.hit}`);
  assert.ok(p1.thresholds.every(x => x.meanSigned > 2 && x.ci[0] > 2 && x.verdict === 'follow'));
  assert.deepStrictEqual(p1.survivesCost, ['follow at p80', 'follow at p90', 'follow at p95', 'follow at p99']);
  const s1 = get('x.same', 1);
  assert.ok(Math.abs(s1.pearson) < 0.05, `contemporaneous field IC ${s1.pearson}`);
  assert.ok(s1.ci.pearson[0] < 0 && s1.ci.pearson[1] > 0, `its interval holds zero: ${s1.pearson} ${s1.ci.pearson}`);
  assert.ok(s1.sameBar.pearson > 0.9 && /NOT predictive/.test(s1.sameBar.note), 'same-bar correlation, labelled');
  assert.deepStrictEqual(s1.survivesCost, [], 'nothing clears the cost');
  // The predictive field says nothing about its own bar's move.
  assert.ok(Math.abs(p1.sameBar.pearson) < 0.05);
});

test('no look-ahead: a field is read from bar t (or earlier, with [n]) only; changing later bars changes nothing at t', () => {
  const bars = synthBars({ days: 3 });
  const spec = [fsy.parseFieldSpec('x.same'), fsy.parseFieldSpec('x.same[1]')];
  const before = fsy.pairs(table(bars, spec), 0, 0, 5, TICK);
  const cut = 700;
  const later = bars.map((b, i) => (i > cut ? { ...b, x: { same: 1e6 + i, pred: 1e6 } } : b));
  const after = fsy.pairs(table(later, spec), 0, 0, 5, TICK);
  for (let m = 0; m < before.n; m += 1) {
    if (before.at[m] > cut) break;
    assert.strictEqual(after.x[m], before.x[m], `x at bar ${before.at[m]} moved when only later bars changed`);
    assert.strictEqual(before.x[m], bars[before.at[m]].x.same, 'x is bar t\'s own value');
  }
  // [1] is bar t-1's value, never across the start of a run (the first bar of each day has none).
  const t = table(bars, spec);
  const lag = fsy.pairs(t, 1, 1, 1, TICK);
  for (let m = 0; m < lag.n; m += 1) assert.strictEqual(lag.x[m], bars[lag.at[m] - 1].x.same);
  assert.strictEqual(lag.missing, 3, 'one bar a day has no previous bar in its run');
  // The forward move is close[t+k] - close[t] in ticks, the excursions over t+1..t+k.
  const m = 10;
  const i = before.at[m];
  assert.strictEqual(before.y[m], (bars[i + 5].c - bars[i].c) / TICK);
  assert.strictEqual(before.up[m], (Math.max(...bars.slice(i + 1, i + 6).map(b => b.h)) - bars[i].c) / TICK);
  assert.strictEqual(before.dn[m], (bars[i].c - Math.min(...bars.slice(i + 1, i + 6).map(b => b.l))) / TICK);
});

test('pairs never cross a chunk, a contract change, a trading day or a gap over 2x the timeframe; each is counted', () => {
  const bar = (iso, extra = {}) => ({ t: iso, ms: Date.parse(iso), o: 100, h: 101, l: 99, c: 100, v: 1, x: { pred: 1, same: 1 }, ...extra });
  const minutes = (start, n, extra) => Array.from({ length: n }, (_, i) => bar(new Date(Date.parse(start) + i * MIN).toISOString(), extra));
  // 10 bars, a 3-minute gap (above 2x 1 minute), 10 bars; a 2-minute gap is not a break.
  const a = [...minutes('2022-03-01T15:00:00Z', 10), ...minutes('2022-03-01T15:12:00Z', 5), ...minutes('2022-03-01T15:18:00Z', 5)];
  let t = table(a);
  assert.strictEqual(t.segments, 2);
  let P = fsy.pairs(t, 0, 0, 1, TICK);
  assert.deepStrictEqual([P.n, P.skipped, P.tail], [18, 1, 1]);
  // A contract change on the bars (roll) and a new chunk (file) each break a run.
  const b = [...minutes('2022-03-01T15:00:00Z', 5, { contractId: 'A' }), ...minutes('2022-03-01T15:05:00Z', 5, { contractId: 'B' })];
  t = table(b);
  assert.strictEqual(t.segments, 2);
  t = fsy.joinChunks([fsy.columns(minutes('2022-03-01T15:00:00Z', 5), FIELDS), fsy.columns(minutes('2022-03-01T15:05:00Z', 5), FIELDS)], { timeframeMin: 1 });
  P = fsy.pairs(t, 0, 0, 3, TICK);
  assert.deepStrictEqual([t.segments, P.n, P.skipped, P.tail], [2, 4, 3, 3]);
  // The session break: 16:59 ET and 18:00 ET are different trading days (and an hour apart); so are two
  // bars a minute apart either side of the 18:00 ET rollover, with no gap at all.
  t = table([bar('2022-03-01T21:59:00Z'), bar('2022-03-01T22:58:00Z'), bar('2022-03-01T22:59:00Z'), bar('2022-03-01T23:00:00Z')], FIELDS, 60);
  assert.strictEqual(t.segments, 2, 'the 18:00 ET rollover breaks the run even without a gap');
  assert.strictEqual(fsy.pairs(t, 0, 0, 1, TICK).skipped, 1);
  // Times out of order or repeated break a run instead of pairing backwards.
  t = table([bar('2022-03-01T15:00:00Z'), bar('2022-03-01T15:00:00Z')]);
  assert.strictEqual(t.segments, 2);
});

test('deciles: equal-count bins in field order, with mean, median, hit rate and excursions', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i - 49.5);
  const P = { n: 100, skipped: 0, tail: 0, missing: 0, x: Float64Array.from(xs), y: Float64Array.from(xs, v => v * 2), up: Float64Array.from(xs, v => (v > 0 ? 3 : 1)), dn: Float64Array.from(xs, v => (v > 0 ? 1 : 3)), same: Float64Array.from(xs, (_, i) => i % 7), day: Int32Array.from(xs, (_, i) => Math.floor(i / 10)), hour: new Int8Array(100), rth: new Uint8Array(100) };
  const s = fsy.summarize(P, { costTicks: 2 });
  assert.strictEqual(s.deciles.length, 10);
  assert.ok(s.deciles.every(d => d.n === 10));
  assert.deepStrictEqual(s.deciles.map(d => d.meanMove), s.deciles.map((_, d) => 2 * (d * 10 + 4.5 - 49.5)));
  assert.strictEqual(s.deciles[0].from, -49.5);
  assert.strictEqual(s.deciles[9].to, 49.5);
  assert.strictEqual(s.deciles[9].medianMove, 2 * 45);
  assert.ok(s.deciles.every((d, i) => d.hit === 1 && d.meanUp === (i < 5 ? 1 : 3) && d.meanDown === (i < 5 ? 3 : 1)));
  assert.ok(Math.abs(s.pearson - 1) < 1e-12 && Math.abs(s.spearman - 1) < 1e-12);
  // Spearman is on ranks: a monotone but curved relation is 1 there, below 1 for Pearson.
  const curved = fsy.summarize({ ...P, y: Float64Array.from(xs, v => v ** 5) }, {});
  assert.ok(Math.abs(curved.spearman - 1) < 1e-12 && curved.pearson < 0.9, `${curved.spearman} ${curved.pearson}`);
  assert.deepStrictEqual(Array.from(fsy.ranks([3, 1, 3, 2])), [3.5, 1, 3.5, 2], 'ties share their average rank');
  // Thresholds default to the p80/p90/p95/p99 of |field|; the cost line subtracts the round trip.
  assert.deepStrictEqual(s.thresholds.map(x => x.quantile), [0.8, 0.9, 0.95, 0.99]);
  const top = s.thresholds[3];
  assert.strictEqual(top.n, 2);
  assert.strictEqual(top.net, top.meanSigned - 2);
  assert.ok(s.thresholds.every(x => x.meanFavourable === 3 && x.meanAdverse === 1));
  // Given thresholds are used as given.
  const g = fsy.summarize(P, { thresholds: [0, 40], costTicks: 0 });
  assert.deepStrictEqual(g.thresholds.map(x => [x.level, x.n, x.quantile]), [[0, 100, null], [40, 20, null]]);
  // A flat move is a miss; a zero field is not counted.
  const flat = fsy.summarize({ ...P, y: new Float64Array(100) }, {});
  assert.strictEqual(flat.hit, 0);
  // Equal values share a decile, never split by time: a constant (or boolean) field fills one middle
  // decile and leaves the top and bottom empty, so no drift over the span passes for signal.
  const drift = { ...P, x: new Float64Array(100).fill(1), y: Float64Array.from(xs, (_, i) => i) };
  const k = fsy.summarize(drift, { boot: { reps: 50 } });
  assert.deepStrictEqual(k.deciles.map(d => d.n), [0, 0, 0, 0, 0, 100, 0, 0, 0, 0]);
  assert.strictEqual(k.topMinusBottom, null);
  assert.ok(k.ci.top === null && k.ci.bottom === null && k.deciles[9].meanMove === null);
  const two = fsy.summarize({ ...drift, x: Float64Array.from(xs, (_, i) => (i % 2 ? 1 : 0)) }, {});
  assert.deepStrictEqual(two.deciles.map(d => d.n).filter(Boolean), [50, 50]);
  assert.ok(two.deciles.every(d => !d.n || d.from === d.to), 'each value in one decile');
  // Without intervals nothing is claimed about the cost.
  assert.strictEqual(s.survivesCost, null);
  assert.ok(s.thresholds.every(x => x.ci === null && x.verdict === null));
});

test('the cost verdict: an interval wholly past the cost, either way; anything else claims nothing', () => {
  assert.strictEqual(fsy.costVerdict([2.1, 5], 2), 'follow');
  assert.strictEqual(fsy.costVerdict([-5, -2.1], 2), 'fade');
  for (const c of [[2, 5], [-5, -2], [-1, 3], [1.9, 9], null]) assert.strictEqual(fsy.costVerdict(c, 2), null, String(c));
  // A field whose sign runs against the move (fade): the planted field reversed.
  const bars = synthBars({ days: 20 }).map(b => ({ ...b, x: { pred: -b.x.pred, same: b.x.same } }));
  const [r] = fsy.study(table(bars), { fields: FIELDS.slice(0, 1), horizons: [1], tick: TICK, reps: 200 });
  assert.ok(r.pearson < -0.4 && r.thresholds.every(x => x.verdict === 'fade' && x.netFaded > 0));
  assert.deepStrictEqual(r.survivesCost, ['fade at p80', 'fade at p90', 'fade at p95', 'fade at p99']);
  // The interval of a threshold's mean is the bootstrap's over the same pairs: it holds the point estimate.
  assert.ok(r.thresholds.every(x => x.ci[0] <= x.meanSigned && x.meanSigned <= x.ci[1]));
});

test('bootstrap: seeded and deterministic, one trading day a block', () => {
  const t = table(synthBars({ days: 12 }));
  const P = fsy.pairs(t, 0, 0, 1, TICK);
  const a = fsy.summarize(P, { boot: { reps: 300, seed: 11 } });
  const b = fsy.summarize(P, { boot: { reps: 300, seed: 11 } });
  const c = fsy.summarize(P, { boot: { reps: 300, seed: 12 } });
  assert.deepStrictEqual(a.ci, b.ci);
  assert.notDeepStrictEqual(a.ci.pearson, c.ci.pearson);
  assert.strictEqual(a.ci.days, 12);
  assert.ok(a.ci.pearson[0] <= a.pearson && a.pearson <= a.ci.pearson[1]);
  // Blocks are days: with every pair on one day there is nothing to resample.
  assert.strictEqual(fsy.bootstrap({ ...P, day: new Int32Array(P.n) }, { rx: P.x, ry: P.y, reps: 10 }), null);
});

test('breakdowns: by New York hour and by session (RTH 09:30-16:00 ET vs overnight)', () => {
  const t = table(synthBars({ days: 5 }));
  const [r] = fsy.study(t, { fields: FIELDS.slice(0, 1), horizons: [1], tick: TICK, by: ['hour', 'session'], reps: 50 });
  assert.deepStrictEqual(r.by.session.map(g => g.key), ['overnight', 'rth']);
  const rth = r.by.session.find(g => g.key === 'rth');
  // 09:30-15:59 ET is 390 minutes a day (every one has a next bar: the day runs to 16:59).
  assert.strictEqual(rth.n, 5 * 390);
  assert.ok(rth.ci && rth.ci.spearman);
  assert.deepStrictEqual(r.by.hour.map(g => g.key), ['08', '09', '10', '11', '12', '13', '14', '15', '16']);
  assert.ok(r.by.hour.every(g => g.ci && g.thresholds.every(x => x.ci)), 'every group has its own intervals');
});

test('held-out discipline: Train runs freely; Select, Out-of-sample and reserved months are refused without a reason', () => {
  assert.deepStrictEqual(fsy.monthsBetween(Date.parse('2023-05-30T00:00:00Z'), Date.parse('2023-06-30T20:00:00Z')), ['2023-05', '2023-06']);
  const free = fsy.splitCheck(['2021-05', '2023-06']);
  assert.deepStrictEqual([free.heldOut, free.warning, free.months.map(m => m.role)], [[], null, ['train', 'train']]);
  for (const m of ['2023-07', '2024-06', '2024-07', '2025-08', '2026-08', '2027-02']) {
    assert.throws(() => fsy.splitCheck(['2023-06', m]), /refused: .*held-out-look/, m);
    assert.throws(() => fsy.splitCheck([m], { heldOutLook: '   ' }), /refused/, `${m}: a blank reason is no reason`);
  }
  const look = fsy.splitCheck(['2023-06', '2023-07'], { heldOutLook: 'parity check' });
  assert.deepStrictEqual(look.heldOut, ['2023-07']);
  assert.match(look.warning, /ledger \(R16\) only.*recordedLooks.*frozen/);
  assert.deepStrictEqual(fsy.splitCheck(['2020-12']).months[0].role, 'none');
  // An evening bar belongs to the next session: 2023-06-30 18:00 ET is July's first session.
  assert.deepStrictEqual(fsy.monthsBetween(Date.parse('2023-06-30T22:30:00Z'), Date.parse('2023-06-30T22:31:00Z')), ['2023-07']);
});

test('the CLI: reads bar files, writes Markdown and JSON, and refuses a held-out span', () => {
  const dir = tmpDir();
  const bars = synthBars({ days: 4 });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), bars.slice(0, 960).map(b => JSON.stringify({ ...b, ms: undefined })).join('\n'));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), bars.slice(960).map(b => JSON.stringify({ ...b, ms: undefined })).join('\n'));
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'field-study.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir } });
  const out = path.join(dir, 'out');
  const r = run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.pred,x.same[1]', '--horizons', '1,5', '--by', 'session', '--reps', '50', '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'field-study.json'), 'utf8'));
  assert.strictEqual(json.header.tick, 0.25);
  assert.strictEqual(json.header.timeframeMin, 1);
  assert.deepStrictEqual(json.header.months.map(m => m.role), ['train']);
  assert.strictEqual(json.results.length, 4);
  const md = fs.readFileSync(path.join(out, 'field-study.md'), 'utf8');
  assert.match(md, /contemporaneous, NOT predictive/);
  assert.match(md, /2022-02 train/);
  const late = bars.map(b => JSON.stringify({ ...b, ms: undefined, t: new Date(Date.parse(b.t) + 600 * 86400000).toISOString() }));
  fs.writeFileSync(path.join(dir, 'late.jsonl'), late.join('\n'));
  const refused = run(['--data', path.join(dir, 'late.jsonl'), '--symbol', 'MNQ', '--fields', 'x.pred']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /refused: .*select/);
  const looked = run(['--data', path.join(dir, 'late.jsonl'), '--symbol', 'MNQ', '--fields', 'x.pred', '--reps', '20', '--held-out-look', 'a test']);
  assert.strictEqual(looked.status, 0, looked.stderr);
  assert.match(looked.stderr, /WARNING: a held-out look/);
  // Its own report in a data directory is never read back as bars; a --timeframe the bars disagree with is warned.
  const fresh = path.join(dir, 'fresh');
  fs.mkdirSync(fresh);
  for (const f of ['a.jsonl', 'b.jsonl']) fs.copyFileSync(path.join(dir, f), path.join(fresh, f));
  fs.copyFileSync(path.join(out, 'field-study.json'), path.join(fresh, 'field-study.json'));
  const again = run(['--data', fresh, '--symbol', 'MNQ', '--fields', 'x.pred', '--reps', '20', '--timeframe', '3']);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stderr, /--timeframe 3 but the bars are mostly 1 minutes apart/);
  // Overlapping files would count minutes twice: refused.
  const lap = path.join(dir, 'lap');
  fs.mkdirSync(lap);
  fs.copyFileSync(path.join(dir, 'a.jsonl'), path.join(lap, 'a.jsonl'));
  fs.copyFileSync(path.join(dir, 'a.jsonl'), path.join(lap, 'b.jsonl'));
  const lapped = run(['--data', lap, '--symbol', 'MNQ', '--fields', 'x.pred']);
  assert.strictEqual(lapped.status, 1);
  assert.match(lapped.stderr, /overlap in time/);
  // A flag is never taken as another flag's value, and a flag is given once.
  const swallowed = run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.pred', '--held-out-look', '--out', out]);
  assert.match(swallowed.stderr, /--held-out-look needs a value/);
  assert.match(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.pred', '--fields', 'x.same']).stderr, /--fields given twice/);
  for (const bad of [['--data', dir, '--fields', 'x.pred'], ['--data', dir, '--symbol', 'MNQ', '--fields', 'x.pred', '--nope', '1'], ['--data', dir, '--symbol', 'MNQ']]) {
    assert.strictEqual(run(bad).status, 1, bad.join(' '));
  }
});
