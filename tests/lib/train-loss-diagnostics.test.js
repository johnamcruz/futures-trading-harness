'use strict';

// The round report's loss diagnostics (scripts/lib/train/loss-diagnostics.js): losers past -1R and their cause, the win
// rate against its break-even line, chop drag by the entry's reaction and level kind, and the exits that cut a trend or
// gave one back; and the entry read they split on (scripts/lib/train/entry-reaction.js). Report only: nothing in the
// loop's decision paths reads them, wired into iteration-report.js's mastery read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const LD = require('../../scripts/lib/train/loss-diagnostics');
const ER = require('../../scripts/lib/train/entry-reaction');
const RS = require('../../scripts/lib/train/risk-stats');
const IR = require('../../scripts/lib/train/iteration-report');
const TREND_REPORT = require('../../scripts/lib/tunables').training().trendReport;

const ROOT = path.join(__dirname, '..', '..');
const TOL = TREND_REPORT.loserToleranceR;
const fill = (stopR, openR, priceR, tickR = null) => ({ stopR, openR, priceR, tickR });
const exit = (r, x = {}) => ({ side: 'long', entryAt: 'T', exitBy: 'initial-stop', cls: 'right', late: false, r, peakR: 0.2, leftR: null, lateR: null, fill: fill(-1, -0.5, r), ...x });

// --- the cause ------------------------------------------------------------------------------------------------------

test('causeOf: from the fill facts only; unknown whenever they can\'t tell', () => {
  assert.strictEqual(LD.causeOf(exit(-1.2), TOL), 'stop slippage', 'filled past the stop, its bar opening inside it');
  assert.strictEqual(LD.causeOf(exit(-1.6, { fill: fill(-1, -1.6, -1.6) }), TOL), 'gap through the stop');
  assert.strictEqual(LD.causeOf(exit(-2, { exitBy: 'model-stop', fill: fill(-2, -1.5, -2) }), TOL), 'stop beyond the initial risk');
  for (const by of ['model-exit', 'runner-exit', 'target']) assert.strictEqual(LD.causeOf(exit(-1.3, { exitBy: by, fill: fill(null, -1, -1.3) }), TOL), 'exit not at the stop', by);
  // The facts can't tell: an unattributed exit, no fill, the stop or open unknown, a fill at the stop past -1R anyway.
  assert.strictEqual(LD.causeOf(exit(-1.3, { exitBy: 'unattributed' }), TOL), 'unknown');
  assert.strictEqual(LD.causeOf(exit(-1.3, { fill: null }), TOL), 'unknown');
  assert.strictEqual(LD.causeOf(exit(-1.3, { fill: fill(null, -0.5, -1.3) }), TOL), 'unknown');
  assert.strictEqual(LD.causeOf(exit(-1.3, { fill: fill(-1, null, -1.3) }), TOL), 'unknown', 'gap or slippage: the bar unknown');
  assert.strictEqual(LD.causeOf(exit(-1.3, { fill: fill(-1, -0.5, -1) }), TOL), 'unknown', 'filled at the stop: the R basis, not the fill');
  assert.strictEqual(LD.causeOf(null, TOL), 'unknown');
});

// --- losers past -1R --------------------------------------------------------------------------------------------------

test('losersPastOne: count, share, worst, tolerance one tick in R when known, else the config\'s; causes', () => {
  const list = [
    exit(2, { exitBy: 'runner-trail', fill: fill(0.5, 1, 2) }),
    exit(-1), // at the stop: not past
    exit(-1.02, { fill: fill(-1, -0.5, -1.02, 0.025) }), // within one tick (0.025R)
    exit(-1.04, { fill: fill(-1, -0.5, -1.04, 0.025) }), // past one tick
    exit(-1.04), // tick unknown: within the config's tolerance
    exit(-1.6, { fill: fill(-1, -1.6, -1.6) }),
    exit(null),
  ];
  const l = LD.losersPastOne(list, { toleranceR: 0.05 });
  assert.deepStrictEqual([l.n, l.unknown, l.losers, l.past, l.share, l.worstR, l.byTick, l.byConfig], [6, 1, 5, 2, 0.4, -1.6, 2, 3]);
  assert.deepStrictEqual(l.causes, { 'stop slippage': 1, 'gap through the stop': 1 });
  assert.deepStrictEqual(l.trades.map(t => [t.r, t.toleranceR, t.cause]), [[-1.04, 0.025, 'stop slippage'], [-1.6, 0.05, 'gap through the stop']]);
  // No loser, no trade, unknown exits.
  const won = LD.losersPastOne([exit(1), exit(0)], { toleranceR: 0.05 });
  assert.deepStrictEqual([won.losers, won.past, won.share, won.worstR, won.trades], [0, 0, null, null, []]);
  assert.deepStrictEqual(LD.losersPastOne([], { toleranceR: 0.05 }).n, 0);
  assert.strictEqual(LD.losersPastOne(null, { toleranceR: 0.05 }), null);
  assert.throws(() => LD.losersPastOne([], {}), /loserToleranceR/);
});

test('losersPastOne: a one-tick slip is never past -1R by rounding: the fill\'s price R when known, else the broker\'s R within half its unit', () => {
  // One 0.25 tick on a 20-point stop is 0.0125R: the broker's R rounds a -1.0125R loss to -1.013 (3 decimals).
  const tick = 0.0125;
  const one = (r, priceR) => LD.losersPastOne([exit(r, { fill: fill(-1, -0.5, priceR, tick) })], { toleranceR: 0.05 }).past;
  assert.strictEqual(one(-1.013, null), 0, 'no price R: the broker\'s -1.013 is within its rounding of one tick');
  assert.strictEqual(one(-1.013, -1.0125), 0, 'the fill\'s own price R: exactly one tick');
  assert.strictEqual(one(-1.013, -1.04), 1, 'the price R past one tick');
  assert.strictEqual(one(-1.014, null), 1, 'past the rounding: past -1R');
  // The unit is the side's (the most decimals stated), never one R printed short: -1.100 prints -1.1, still past.
  assert.strictEqual(LD.losersPastOne([exit(-1.1, { fill: fill(-1, -0.5, null, tick) }), exit(-1.013, { fill: fill(-1, -0.5, null, tick) })], { toleranceR: 0.05 }).past, 1);
  // The tick unknown: the config's tolerance, no rounding allowance beside it: -1.1 is past -1.05.
  assert.strictEqual(LD.losersPastOne([exit(-1.1, { fill: fill(-1, -0.5, null) })], { toleranceR: 0.05 }).past, 1);
  assert.strictEqual(LD.losersPastOne([exit(-1.04, { fill: fill(-1, -0.5, null) })], { toleranceR: 0.05 }).past, 0);
});

test('losersPastOne: on the stop the trade held when the fill says it (trade-basis.js), else the broker\'s R', () => {
  // The broker's -0.9R on a bracket wider than the plan's stop the runner moved it to is -1.2R on the stop it held.
  const held = exit(-0.9, { fill: { basis: 'held stop', r: -1.2, stopR: -1, openR: -0.5, priceR: -1.2, tickR: null } });
  const l = LD.losersPastOne([held], { toleranceR: 0.05 });
  assert.deepStrictEqual([l.losers, l.past, l.worstR, l.trades[0].r, l.trades[0].cause], [1, 1, -1.2, -1.2, 'stop slippage']);
});

// --- break-even -------------------------------------------------------------------------------------------------------

test('breakEven: (1 - scratch share) / (1 + payoff) with |avg loss| as one unit; the margin in points; below when negative', () => {
  // Payoff 2, no scratch: break-even 1/3. A 20% win rate (2 of 10) is 13.33 points below it.
  const trades = [2, -1, -1, 2, -1, -1, -1, -1, -1, -1].map(r => ({ r }));
  const below = LD.breakEven(RS.riskStats(trades), trades);
  assert.deepStrictEqual(below, { winRate: 0.2, payoff: 2, scratchShare: 0, breakEven: 0.3333, marginPp: -13.33, below: true });
  const above = LD.breakEven({ winRate: 0.5, payoff: 1.1667 });
  assert.deepStrictEqual([above.breakEven, above.marginPp, above.below], [0.4615, 3.85, false]);
  // No win or no loss (payoff unknown), no trade, no stats: n/a, never a line from nothing.
  assert.deepStrictEqual(LD.breakEven(RS.riskStats([-1, -1]), [-1, -1]), { winRate: 0, payoff: null, scratchShare: 0, breakEven: null, marginPp: null, below: null });
  assert.deepStrictEqual(LD.breakEven(RS.riskStats([1]), [1]), { winRate: 1, payoff: null, scratchShare: 0, breakEven: null, marginPp: null, below: null });
  // Scratches (R 0) are in the win rate's n: zero expectancy is at (1 - z) / (1 + payoff). 2, -1, 0, 0: payoff 2, z 0.5,
  // win rate 25%, break-even 0.5 / 3 = 16.67%: 8.33 points above (a line of 1 / 3 would call it 8.33 below).
  const sc = [2, -1, 0, 0];
  const withScratch = LD.breakEven(RS.riskStats(sc), sc);
  assert.deepStrictEqual(withScratch, { winRate: 0.25, payoff: 2, scratchShare: 0.5, breakEven: 0.1667, marginPp: 8.33, below: false });
  // The line is zero expectancy: the win rate at it with this payoff and these scratches nets 0R.
  assert.ok(Math.abs(withScratch.breakEven * 2 - (1 - 0.5 - withScratch.breakEven)) < 1e-3);
  assert.strictEqual(LD.breakEven(RS.riskStats([])).breakEven, null);
  assert.strictEqual(LD.breakEven(null), null);
});

// --- chop drag ----------------------------------------------------------------------------------------------------------

const entry = (r, read, x = {}) => ({ at: 'T', side: 'long', kind: 'none', leg: null, r, peakR: 0.1, read, ...x });
const rd = (reaction, keyLevel = true) => ({ reaction, tf: '15m', level: keyLevel === null ? null : 'prior vah', keyLevel });

test('chopDrag: by the entry\'s reaction and level kind; R, win rate, false starts, legs caught, small n', () => {
  const list = [
    entry(2, rd('long-wick rejection'), { kind: 'in-trend', leg: 'L1', peakR: 2.5 }),
    entry(-1, rd('long-wick rejection'), { kind: 'in-trend', leg: 'L1' }), // the same leg: one leg caught
    entry(-1, rd('plain', false)),
    entry(-1, rd('plain', false), { peakR: 0.9 }), // peaked past the false-start line: a loser, not a false start
    entry(1, rd('none', null), { kind: 'in-trend', leg: 'L2', peakR: null }), // peak unknown: out of the false-start share
    entry(null, rd('unknown')),
    entry(-1, null), // no compose record joined
  ];
  const c = LD.chopDrag(list, { falseStartPeakR: 0.5, smallN: 3 });
  assert.deepStrictEqual(c.coverage, { entries: 7, recorded: 6, reaction: 5 });
  assert.deepStrictEqual(Object.keys(c.byReaction), ['long-wick rejection', 'plain', 'none', 'unknown', 'not recorded'], 'the owner\'s order');
  assert.deepStrictEqual(c.byReaction['long-wick rejection'], { n: 2, meanR: 0.5, winRate: 0.5, falseStarts: 1, of: 2, falseStartShare: 0.5, legsCaught: 1, small: true });
  assert.deepStrictEqual(c.byReaction.plain, { n: 2, meanR: -1, winRate: 0, falseStarts: 1, of: 2, falseStartShare: 0.5, legsCaught: 0, small: true });
  assert.deepStrictEqual([c.byReaction.none.of, c.byReaction.none.legsCaught], [0, 1]);
  assert.deepStrictEqual([c.byReaction.unknown.meanR, c.byReaction.unknown.winRate], [null, null], 'no known R: n/a, never 0');
  assert.deepStrictEqual(Object.keys(c.byLevel), ['key', 'not key', 'no level']);
  assert.deepStrictEqual([c.byLevel.key.n, c.byLevel['not key'].n, c.byLevel['no level'].n], [3, 2, 2]);
  assert.strictEqual(c.byLevel.key.small, false, 'n 3 is not under 3');
  // No entry, none known, the config's numbers required.
  assert.deepStrictEqual(LD.chopDrag([], { falseStartPeakR: 0.5, smallN: 30 }), { coverage: { entries: 0, recorded: 0, reaction: 0 }, byReaction: {}, byLevel: {} });
  assert.strictEqual(LD.chopDrag(null, { falseStartPeakR: 0.5, smallN: 30 }), null);
  assert.throws(() => LD.chopDrag([], { falseStartPeakR: 0.5 }), /smallN/);
});

test('exitTotals: the exit scorecard\'s cut-a-trend and late totals over every exit kind', () => {
  assert.deepStrictEqual(LD.exitTotals({ byExit: { 'model-exit': { n: 3, cut: 2, leftR: 3.5, late: 1, givebackR: 0.4 }, 'runner-trail': { n: 2, cut: 0, leftR: 0, late: 1, givebackR: 1.1 } } }), { n: 5, cut: 2, leftR: 3.5, late: 2, givebackR: 1.5 });
  assert.deepStrictEqual(LD.exitTotals({ byExit: {} }), { n: 0, cut: 0, leftR: 0, late: 0, givebackR: 0 });
  assert.strictEqual(LD.exitTotals(null), null);
});

test('diagnostics: one side, on the config\'s values; the scored exits\' cut and late from their own numbers', () => {
  const exits = [exit(0.5, { exitBy: 'model-exit', cls: 'cut', leftR: 2, fill: fill(null, 0, 0.5) }), exit(-1.6, { fill: fill(-1, -1.6, -1.6) }), exit(1, { exitBy: 'runner-trail', late: true, lateR: 0.7, peakR: 3, fill: fill(0.5, 1, 1) })];
  const d = LD.diagnostics({ exits, entries: [entry(-1, rd('plain'))], risk: RS.riskStats([0.5, -1.6, 1].map(r => ({ r }))) });
  assert.strictEqual(d.losers.toleranceR, TOL);
  assert.deepStrictEqual([d.losers.past, d.losers.causes], [1, { 'gap through the stop': 1 }]);
  assert.deepStrictEqual(d.exits, { n: 3, cut: 1, leftR: 2, late: 1, givebackR: 0.7 });
  assert.strictEqual(d.chop.byReaction.plain.small, TREND_REPORT.smallN > 1);
  assert.strictEqual(d.breakEven.payoff, 0.4688);
  // Nothing known: each part null, said n/a.
  const none = LD.diagnostics({});
  assert.deepStrictEqual(none, { losers: null, breakEven: null, chop: null, exits: null });
  const lines = LD.lossLines(none, 'champion');
  assert.deepStrictEqual(lines, [
    '    champion, losers past -1R: n/a (exits unknown)',
    '    champion, win rate vs break-even: n/a (trades unknown)',
    '    champion, chop drag: n/a (entries unknown)',
    '    champion, exits: n/a (exits unknown)',
  ]);
  for (const l of LD.lossLines(d, 'champion')) assert.doesNotMatch(l, /Infinity|NaN|undefined|null/, l);
  // No peak R known in a bucket: its false starts n/a, never 0/0.
  const noPeak = LD.lossLines({ ...d, chop: LD.chopDrag([entry(-1, rd('plain'), { peakR: null })], { falseStartPeakR: 0.5, smallN: 30 }) }, 'champion');
  assert.match(noPeak.find(x => /chop drag by reaction/.test(x)), /plain n 1: -1R a trade, win 0%, false starts n\/a \(no peak R\), legs caught 0/);
  assert.ok(noPeak.every(x => !/ 0\/0/.test(x)));
  // No known R in a bucket (an open trade): n/a a trade, never "n/aR".
  const noR = LD.lossLines({ ...d, chop: LD.chopDrag([entry(null, rd('breakout'), { peakR: null })], { falseStartPeakR: 0.5, smallN: 30 }) }, 'champion');
  assert.match(noR.find(x => /chop drag by reaction/.test(x)), /breakout n 1: n\/a a trade, win n\/a, /);
  assert.ok(noR.every(x => !/n\/aR/.test(x)));
  assert.deepStrictEqual(LD.lossLines(null, 'x'), []);
});

// --- the entry read ---------------------------------------------------------------------------------------------------

const briefing = relations => ({ sections: { m3: { data: { candles: { '15m': { relations } } } } } });
const record = (reads, x = {}) => ({ id: 'r1', root: 'MNQ', bar: '2022-03-07T15:00:00.000Z', side: 'short', reads, ...x });
const r = (step, read) => ({ step, skill: 's', read, why: 'w' });

test('entry read: the setup step\'s rejection, break or sweep; the briefing\'s reaction at its level; the level\'s kind', () => {
  const b = briefing([{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down', reaction: 'long-wick rejection' }, { name: 'previous high', price: 101, rel: 'broke', dir: 'up', reaction: 'breakout' }]);
  const reads = [r('bias', '1h down'), r('location', 'at prior vah'), r('setup', '15m rejected prior vah down'), r('entry', '3m bos down')];
  assert.deepStrictEqual(ER.readOf(record(reads), b), { reaction: 'long-wick rejection', tf: '15m', level: 'prior vah', keyLevel: true });
  // The setup step first, whatever the order the reads came in; a level that is no key level.
  assert.deepStrictEqual(ER.readOf(record([r('entry', '15m rejected prior vah down'), r('setup', '15m broke previous high up')]), b), { reaction: 'breakout', tf: '15m', level: 'previous high', keyLevel: false });
  // A fair value gap's edge is a key level; no rejection, break or sweep read: 'none', the location's level kept.
  assert.strictEqual(ER.readOf(record([r('setup', '15m rejected 15m fvg low up')]), b).keyLevel, true);
  assert.deepStrictEqual(ER.readOf(record([r('location', 'at vwap rth'), r('setup', '15m compression break down')]), b), { reaction: 'none', tf: null, level: 'vwap rth', keyLevel: true });
  assert.deepStrictEqual(ER.readOf(record([r('setup', '15m cisd down')]), b), { reaction: 'none', tf: null, level: null, keyLevel: null });
  // The briefing can't say (not rebuilt, the level not met, no reaction there): unknown, never read from the words.
  assert.strictEqual(ER.readOf(record(reads), null).reaction, 'unknown');
  assert.strictEqual(ER.readOf(record([r('setup', '15m rejected overnight high down')]), b).reaction, 'unknown');
  assert.strictEqual(ER.readOf(record([{ ...r('setup', '15m rejected prior vah down'), why: 'an engulfing rejection' }]), briefing([{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down' }])).reaction, 'unknown');
  assert.deepStrictEqual(ER.readOf(null, b), { reaction: 'none', tf: null, level: null, keyLevel: null });
});

test('withReads: each entry joined to its compose record; no record: not recorded; a failing rebuild: unknown', () => {
  const rec = record([r('setup', '15m rejected prior vah down')]);
  const b = briefing([{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down', reaction: 'conflicting' }]);
  const seen = [];
  const out = ER.withReads([{ at: 'a', record: 'r1' }, { at: 'b', record: 'gone' }, { at: 'c', record: null }], { records: new Map([['r1', rec]]), briefingAt: (root, bar) => { seen.push([root, bar]); return b; } });
  assert.deepStrictEqual(out.map(e => e.read.reaction), ['conflicting', 'not recorded', 'not recorded']);
  assert.deepStrictEqual(seen, [['MNQ', rec.bar]], 'the briefing at the record\'s own bar');
  assert.strictEqual(out[0].at, 'a', 'the entry kept');
  const broken = ER.withReads([{ record: 'r1' }], { records: new Map([['r1', rec]]), briefingAt: () => { throw new Error('x'); } });
  assert.strictEqual(broken[0].read.reaction, 'unknown');
  assert.deepStrictEqual(ER.withReads(null, {}), []);
});

test('readerFor: a run with no compose records or config reads none (never throws)', () => {
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-er-'));
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const x = ER.readerFor({ runDir });
  assert.deepStrictEqual([x.records.size, x.briefingAt], [0, null]);
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  const y = ER.readerFor({ runDir });
  assert.strictEqual(y.briefingAt('MNQ', '2022-03-07T15:00:00.000Z'), null, 'no bars: no briefing');
  fs.rmSync(home, { recursive: true, force: true });
});

// The production join: a run home's compose record and bars, through readerFor (trade-lifecycle readRecords, trend-facts
// barsOf, skill-usage briefingFrom) and withReads (reaction-echo echoOf), as the probe round's trend step runs it.
function runHome() {
  const os = require('os');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const m1 = [];
  let p = 21500;
  for (let d = 0; d < 3; d += 1) {
    const s = Date.parse('2026-04-20T13:30:00Z') + d * 86400000;
    for (let i = 0; i < 390; i += 1) { const o = p; const c = Math.round((o + (rnd() - 0.5) * 8) * 4) / 4; m1.push({ t: new Date(s + i * 60000).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: 100 }); p = c; }
  }
  const m3 = [];
  for (let i = 0; i + 3 <= m1.length; i += 3) { const g = m1.slice(i, i + 3); m3.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[2].c, v: 300 }); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-er-join-'));
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'));
  const write = (b3, b1) => { fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify(b3)); fs.writeFileSync(path.join(home, 'data-1m.json'), JSON.stringify(b1)); };
  write(m3, m1);
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  return { home, runDir, m1, m3, write, barsFiles: { MNQ: path.join(home, 'data-1m.json') } };
}

test('entry read, the production join: the record\'s 5m read gets the label the briefing gave it, built only from bars closed by then', () => {
  const LC = require('../../scripts/lib/trading/trade-lifecycle');
  const { levelName } = require('../../scripts/lib/trading/composed-reads');
  const h = runHome();
  try {
    // A bar whose 5m candle (built from the one-minute bars) met a level with a known reaction, as the live briefing has it.
    const reader = ER.readerFor({ runDir: h.runDir, barsFiles: h.barsFiles });
    let bar = null;
    let rel = null;
    for (const b of h.m3.slice(-60)) {
      const br = reader.briefingAt('MNQ', b.t);
      const c = br && br.sections.m3.data.candles['5m'];
      const x = c && Array.isArray(c.relations) ? c.relations.find(y => (y.rel === 'rejected' || y.rel === 'broke') && y.dir && y.reaction && y.reaction !== 'unknown') : null;
      if (x) { bar = b.t; rel = x; break; }
    }
    assert.ok(rel, 'the fixture holds a 5m reaction');
    const read = `5m ${rel.rel} ${levelName(rel.name)} ${rel.dir}`;
    const side = rel.dir === 'up' ? 'long' : 'short';
    const record = LC.buildRecord({ at: new Date(Date.parse(bar) + 180000).toISOString(), root: 'MNQ', symbol: 'MNQ', side, briefing: { asOf: bar, minutes: 3, sections: {} }, checked: { ok: true, problems: [], reads: [{ step: 'bias', skill: 's', read: '1h up', why: 'w', kind: 'trend' }, { step: 'setup', skill: 's', read, why: 'w', kind: 'relation' }], signature: null, skillSignature: null, context: null } });
    LC.appendRecord(h.home, record);
    const entries = [{ at: record.at, side, record: record.id, kind: 'none', leg: null, r: -1, peakR: 0.1 }];
    const got = ER.withReads(entries, ER.readerFor({ runDir: h.runDir, barsFiles: h.barsFiles }))[0].read;
    assert.deepStrictEqual([got.reaction, got.tf, got.level], [rel.reaction, '5m', levelName(rel.name)]);
    // Without the run's one-minute bars no 5m candle is built: unknown, never a label made up.
    assert.strictEqual(ER.withReads(entries, ER.readerFor({ runDir: h.runDir }))[0].read.reaction, 'unknown');
    // No look-ahead: every bar after the record's bar changed, the label and the briefing's candle stay the same.
    const close = Date.parse(bar) + 180000;
    const wild = x => (Date.parse(x.t) >= close ? { ...x, o: x.o + 400, h: x.h + 900, l: x.l - 900, c: x.c - 400 } : x);
    const before = ER.readerFor({ runDir: h.runDir, barsFiles: h.barsFiles }).briefingAt('MNQ', bar).sections.m3.data.candles['5m'];
    h.write(h.m3.map(wild), h.m1.map(wild));
    const after = ER.readerFor({ runDir: h.runDir, barsFiles: h.barsFiles });
    assert.deepStrictEqual(after.briefingAt('MNQ', bar).sections.m3.data.candles['5m'], before);
    assert.strictEqual(ER.withReads(entries, after)[0].read.reaction, rel.reaction);
    // fineBarsOf: the data file's one-minute bars when the run holds none; a file of another bar size gives none.
    const got1 = ER.fineBarsOf(h.home, h.runDir, 'MNQ', h.barsFiles);
    assert.deepStrictEqual([got1.bars.length, got1.source], [h.m1.length, 'file']);
    fs.writeFileSync(path.join(h.home, 'data-3m.json'), JSON.stringify(h.m3));
    assert.deepStrictEqual(ER.fineBarsOf(h.home, h.runDir, 'MNQ', { MNQ: path.join(h.home, 'data-3m.json') }), { bars: [], source: null });
    // A data file that is gone: no briefing, unknown, never a throw.
    assert.strictEqual(ER.withReads(entries, ER.readerFor({ runDir: h.runDir, barsFiles: { MNQ: path.join(h.home, 'gone.json') } }))[0].read.reaction, 'unknown');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('entry read: a data file on another price basis (back-adjusted) never lends its bars: the own-bars label or unknown', () => {
  const LC = require('../../scripts/lib/trading/trade-lifecycle');
  const { levelName } = require('../../scripts/lib/trading/composed-reads');
  const h = runHome();
  try {
    // The census file's prices a constant 3345.75 points off the run's own bars.
    const shifted = h.m1.map(x => ({ ...x, o: x.o + 3345.75, h: x.h + 3345.75, l: x.l + 3345.75, c: x.c + 3345.75 }));
    const adjusted = path.join(h.home, 'adjusted-1m.json');
    fs.writeFileSync(adjusted, JSON.stringify(shifted));
    const own = ER.readerFor({ runDir: h.runDir });
    const viaFile = ER.readerFor({ runDir: h.runDir, barsFiles: { MNQ: adjusted } });
    const bar = h.m3[h.m3.length - 40].t;
    // The base frames read the run's own bars either way (the file never replaces them); its fine bars are refused.
    assert.deepStrictEqual(viaFile.briefingAt('MNQ', bar).sections.m3.data.candles['15m'], own.briefingAt('MNQ', bar).sections.m3.data.candles['15m']);
    assert.ok(!ER.sameBasis(shifted, h.m3.find(x => x.t === bar), 3));
    assert.ok(ER.sameBasis(h.m1, h.m3.find(x => x.t === bar), 3));
    // Every 15m reaction the own bars give is the label through the adjusted file; every 5m read is unknown.
    let checked = 0;
    for (const b of h.m3.slice(-30)) {
      const c = own.briefingAt('MNQ', b.t).sections.m3.data.candles;
      for (const tf of ['15m', '5m']) {
        const x = c[tf] && Array.isArray(c[tf].relations) ? c[tf].relations.find(y => (y.rel === 'rejected' || y.rel === 'broke') && y.dir) : null;
        const f = tf === '5m' ? (h.m1.length ? ER.readerFor({ runDir: h.runDir, barsFiles: h.barsFiles }).briefingAt('MNQ', b.t).sections.m3.data.candles['5m'] : null) : null;
        const y = tf === '5m' && f && Array.isArray(f.relations) ? f.relations.find(z => (z.rel === 'rejected' || z.rel === 'broke') && z.dir) : x;
        if (!y) continue;
        const rec = LC.buildRecord({ at: b.t, root: 'MNQ', symbol: 'MNQ', side: y.dir === 'up' ? 'long' : 'short', briefing: { asOf: b.t, minutes: 3, sections: {} }, checked: { ok: true, problems: [], reads: [{ step: 'setup', skill: 's', read: `${tf} ${y.rel} ${levelName(y.name)} ${y.dir}`, why: 'w', kind: 'relation' }], signature: null, skillSignature: null, context: null } });
        const got = ER.withReads([{ record: rec.id }], { records: new Map([[rec.id, rec]]), briefingAt: viaFile.briefingAt })[0].read.reaction;
        assert.strictEqual(got, tf === '5m' ? 'unknown' : (y.reaction || 'unknown'), `${b.t} ${tf}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 2, `checked ${checked}`);
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

// --- the report's wiring ----------------------------------------------------------------------------------------------

const ride = { legs: 4, caught: 1, catchRate: 0.25, rCaught: 2, rAvailable: 10 };
const T = rr => ({ r: rr });
const champExits = [exit(2, { exitBy: 'runner-trail', cls: 'cut', leftR: 1.5, fill: fill(0.5, 1, 2) }), exit(-1), exit(-1.6, { entryAt: '2022-03-07T15:06:00.000Z', fill: fill(-1, -1.6, -1.6) }), exit(1, { exitBy: 'runner-trail', late: true, lateR: 0.5, peakR: 3, fill: fill(0.5, 1, 1) })];
const champEntries = [entry(2, rd('long-wick rejection'), { kind: 'in-trend', leg: 'L1', peakR: 2.5 }), entry(-1, rd('plain', false)), entry(-1.6, rd('plain', false)), entry(1, null)];
const probeReport = (over = {}) => ({
  iteration: 2, curriculum: 'trend',
  trend: {
    set: 'f', batch: { index: 1, size: 4, trigger: 'start' }, probe: { days: [], legs: [] }, confirm: { days: [], legs: [] },
    exits: { byExit: { 'model-exit': { n: 4, cut: 3, leftR: 4.5, late: 0, givebackR: 0 } } },
    champion: { ride, blows: 0, controls: null, trades: [2, -1, -1.6, 1].map(T), exits: champExits, entryRows: champEntries, ...(over.champion || {}) },
  },
  composed: { id: 'c1', verdict: 'helped', trend: { ride, blows: 0, controls: null, trades: [1, -1].map(T), exits: [exit(1, { cls: 'right' }), exit(-1)], entryRows: [], ...(over.composed || {}) } },
});

test('the round report: losses, break-even and chop beside the risk, per side; an old record unchanged', () => {
  const rec = IR.build({ probeReport: probeReport() });
  const l = rec.mastery.loss;
  assert.deepStrictEqual([l.champion.losers.past, l.champion.losers.worstR, l.champion.losers.causes], [1, -1.6, { 'gap through the stop': 1 }]);
  assert.deepStrictEqual(l.champion.breakEven, LD.breakEven(rec.mastery.risk.champion.trend, probeReport().trend.champion.trades));
  assert.strictEqual(l.champion.breakEven.below, false);
  assert.deepStrictEqual(l.champion.chop.coverage, { entries: 4, recorded: 3, reaction: 3 });
  assert.deepStrictEqual(l.champion.exits, { n: 4, cut: 1, leftR: 1.5, late: 1, givebackR: 0.5 });
  assert.deepStrictEqual(l.probeExits, { n: 4, cut: 3, leftR: 4.5, late: 0, givebackR: 0 });
  assert.strictEqual(l.composed.id, 'c1');
  assert.deepStrictEqual([l.composed.losers.past, l.composed.chop.coverage.entries], [0, 0]);
  const lines = IR.masteryLines(rec);
  const at = lines.indexOf('  Losses, break-even and chop (trend confirm half, per trade; diagnostics only: pass rate with 0 blows decides):');
  assert.ok(at > 0, lines.join('\n'));
  assert.deepStrictEqual(lines.slice(at + 1), [
    ...LD.lossLines(l.champion, 'champion'),
    ...LD.lossLines(l.composed, 'combined c1'),
    '    champion, probe half exits: cut a trend 3 of 4 (4.5R left), late 0 (0R given back past the lock)',
  ]);
  assert.strictEqual(lines[at + 1], `    champion, losers past -1R: 1 of 2 loser(s) (50%) past -1R, worst -1.6R (tolerance one tick in R on 0, ${TOL}R on 2: tick unknown); cause: gap through the stop 1; 2022-03-07T15:06:00.000Z long -1.6R gap through the stop`);
  assert.match(lines[at + 2], /^ {4}champion, win rate vs break-even: win rate 50% vs break-even \d+(\.\d+)?% \(\(1 - scratch share 0%\) \/ \(1 \+ payoff [\d.]+\), \|avg loss\| = 1 unit\): margin [+-][\d.]+pp/);
  assert.match(lines[at + 3], /^ {4}champion, chop drag by reaction \(3 of 4 entries joined to a compose record, 3 read: the briefing's reaction, or no reaction read\): long-wick rejection n 1: 2R a trade, win 100%, false starts 0\/1, legs caught 1 \(small n, no conclusion\); plain n 2: /);
  assert.match(lines[at + 4], /^ {4}champion, chop drag by level: key n 1: .*; not key n 2: .*; no level n 1: /);
  assert.ok(lines.every(x => !/Infinity|NaN|undefined/.test(x)));
  // A probe report from before the exits and entries were kept: n/a, never zero.
  const old = IR.build({ probeReport: probeReport({ champion: { exits: undefined, entryRows: undefined } }) });
  assert.deepStrictEqual([old.mastery.loss.champion.losers, old.mastery.loss.champion.chop], [null, null]);
  // A record from before the loss diagnostics: its lines as they were.
  const { loss: _loss, ...before } = rec.mastery;
  assert.deepStrictEqual(IR.masteryLines({ ...rec, mastery: before }), lines.slice(0, at));
  // No combined change: the champion's lines alone.
  const solo = IR.build({ probeReport: { ...probeReport(), composed: null } });
  assert.strictEqual(solo.mastery.loss.composed, null);
  assert.strictEqual(IR.masteryLines(solo).filter(x => /^ {4}combined/.test(x)).length, 0);
});

// --- nothing decides on them ----------------------------------------------------------------------------------------

test('diagnostics only: no screen, keep rule, promotion, proposer or prompt module imports loss-diagnostics or entry-reaction', () => {
  const lib = path.join(ROOT, 'scripts', 'lib');
  const train = path.join(lib, 'train');
  // The modules that judge, screen, propose, find, compose, promote or build a prompt (as train-risk-stats.test.js).
  const deciding = ['screen.js', 'model-verifier.js', 'proposer.js', 'findings.js', 'trend-screen.js', 'trend-findings.js', 'exit-findings.js', 'paired.js', 'ab-compare.js', 'compose.js', 'proposal.js', 'lessons.js', 'evaluator.js', 'selection.js', 'first-try.js', 'rulebook-guard.js', 'agent-edit.js', 'probe-edit.js', 'plan.js', 'flow.js', 'trend-facts.js', 'curriculum.js']
    .map(f => path.join(train, f));
  const prop = fs.readdirSync(path.join(lib, 'prop')).map(f => path.join(lib, 'prop', f));
  const trading = fs.readdirSync(path.join(lib, 'trading')).map(f => path.join(lib, 'trading', f));
  const imports = name => f => new RegExp(`require\\(\\s*['"][^'"]*${name}['"]\\s*\\)`).test(fs.readFileSync(f, 'utf8'));
  for (const f of [...deciding, ...prop]) assert.ok(fs.existsSync(f), f);
  for (const name of ['loss-diagnostics', 'entry-reaction']) assert.deepStrictEqual([...deciding, ...prop, ...trading].filter(imports(name)).map(f => path.relative(ROOT, f)), [], name);
  // Who does: the report for the read, the probe round's trend step for the entry reads alone.
  const users = name => fs.readdirSync(lib, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(lib, f)).filter(imports(name)).map(f => path.relative(lib, f)).sort();
  assert.deepStrictEqual(users('loss-diagnostics'), ['train/iteration-report.js']);
  assert.deepStrictEqual(users('entry-reaction'), ['train/probe.js']);
  const probe = fs.readFileSync(path.join(train, 'probe.js'), 'utf8');
  assert.deepStrictEqual([...new Set([...probe.matchAll(/\bER\.(\w+)/g)].map(m => m[1]))].sort(), ['readerFor', 'withReads'], 'the probe round only records the entry reads');
});
