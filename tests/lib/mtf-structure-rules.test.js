'use strict';

// The owner's structure rules the MTF lines are built on, pinned exactly (the final review, M2 and M3): the parent CHoCH
// fails only on a CLOSE through its ORIGIN past the tie (a wick is nothing; a close back through the level it broke is a
// warning only); the parent's protected swing breaks only on a close past the tie; while transitioning, only a break
// in the CHoCH's direction confirms the turn (a break the old way resumes the old structure); CONFIRMED REVERSAL needs a
// setup close past its own tie. Synthetic parent candles with injected breaks and a flat ATR (the tie is exactly 1
// point), so every boundary is tie-exact.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../scripts/lib/trading/mtf-structure');
const W = require('../fixtures/mtf-structure/world');
const { analysis } = require('../../scripts/lib/tunables');

const AN = analysis();
const EQ = AN.marketState.equalAtr;
const TIE = 1; // ATR x equalAtr on every parent candle
const T0 = Date.parse('2022-01-04T15:00:00Z');

/** Parent candles from [h, l, c] rows (known at their own index) and the injected breaks; returns the series per bar. */
function run(rows, breaks) {
  const parent = rows.map(([h, l, c], i) => ({ t: new Date(T0 + i * 3600000).toISOString(), o: c, h, l, c, first: i, known: i }));
  const prims = { breaksOf: () => breaks.map(b => ({ ...b, swingAt: parent[b.swing].t, at: parent[b.i].t })), findCisds: () => [], atr: cs => cs.map(() => TIE / EQ) };
  return M.parentSeries({ exec: parent, parent, equalAtr: EQ, k: 1, prims });
}
// An up structure: BOS up at candle 3 (its protected low 100, candle 2), then a CHoCH down at candle 6 through 105 from
// the swing at candle 4 (its origin, the CHoCH's protected high, 120 at candle 5). Candle 7 is the case under test.
const UP = [[112, 104, 108], [114, 106, 110], [111, 100, 106], [118, 107, 116], [117, 106, 110], [120, 108, 112], [113, 103, 104]];
const BREAKS = [{ direction: 'up', kind: 'BOS', level: 115, swing: 1, i: 3 }, { direction: 'down', kind: 'CHoCH', level: 105, swing: 4, i: 6 }];
const at7 = (row, extra = []) => {
  const r = run([...UP, row], [...BREAKS, ...extra]);
  return { s: r.series[7], ev: r.events[7].map(e => e.type) };
};

test('the setup: a BOS up makes the bias (protected low 100), the CHoCH down at 105 makes it transitioning, its origin 120', () => {
  const r = run(UP, BREAKS);
  assert.equal(r.series[3].mode, 'bias');
  assert.equal(r.series[3].level, 100);
  assert.equal(r.series[6].mode, 'transitioning');
  assert.equal(r.series[6].old.level, 100);
  assert.equal(r.series[6].against.prot.level, 120);
});

test('M2: the CHoCH fails only on a parent CLOSE through its origin past the tie; at the tie it stands; a wick is nothing', () => {
  // A close exactly at the origin + tie: the CHoCH stands.
  let x = at7([122, 110, 120 + TIE]);
  assert.equal(x.s.mode, 'transitioning');
  assert.ok(!x.ev.includes('choch-invalidated'));
  // A close past the tie: the CHoCH is invalidated, the old up structure returns (its protected low 100), via the rule.
  x = at7([122, 110, 120 + TIE + 0.25]);
  assert.deepEqual(x.ev, ['choch-invalidated']);
  assert.equal(x.s.mode, 'bias');
  assert.equal(x.s.d, 1);
  assert.equal(x.s.level, 100);
  assert.equal(x.s.via, 'choch invalidated');
  // A wick far through the origin with the close below it: nothing (still transitioning, no invalidation).
  x = at7([135, 104, 104.5]);
  assert.equal(x.s.mode, 'transitioning');
  assert.ok(!x.ev.includes('choch-invalidated'));
});

test('M2: a close back through the level the CHoCH broke (105) is a warning only: the CHoCH stands, its failed break recorded', () => {
  const x = at7([112, 104, 110]);
  assert.deepEqual(x.ev, ['choch-failed']);
  assert.equal(x.s.mode, 'transitioning');
  assert.equal(x.s.against.prot.level, 120);
  assert.equal(x.s.failedBreak.level, 105);
});

test('the real fixtures\' lines are pinned (every bar of the four committed days, both lines, the sides and Bias reads varied): a change to any structure rule shows here', () => {
  // A golden over 35,200 printed lines: a rule change (the CHoCH origin rule, a tie, the turn confirmation) changes
  // hundreds of them. A deliberate change regenerates these numbers and is explained like any golden.
  const fs = require('fs');
  const path = require('path');
  const zlib = require('zlib');
  const crypto = require('crypto');
  const GF = require('../../scripts/lib/eval/goal-fixture');
  const CFG = AN.mtfStructure;
  const OPTS = { tick: 0.25, bufferTicks: 1, equalAtr: EQ, k: AN.indicators.swingK, depth: CFG.depth, sideMode: 'rule', warmBars: CFG.warmBars, hierarchy: CFG.hierarchy };
  const all = [];
  for (const d of ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12']) {
    const bars = GF.decodeBars(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mtf-structure', `${d}.json.gz`)))).bars);
    const sides = ['long', 'short', null];
    const reads = ['up', 'down', 'range'];
    const recs = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: M.levelsOf(CFG), sideAt: j => sides[j % 3], biasAt: j => ({ '4h': reads[j % 3], '1h': reads[(j + 1) % 3] }) });
    recs.forEach(r => { if (r) all.push(...M.mtfLines(r, { lineBytes: CFG.lineBytes, primaryBytes: CFG.primaryBytes })); });
  }
  const count = re => all.filter(l => re.test(l)).length;
  assert.deepEqual({ lines: all.length, warning: count(/a warning, not a reversal/), invalidated: count(/stage INVALIDATED/), confirmed: count(/stage CONFIRMED REVERSAL/) }, { lines: 35200, warning: 3892, invalidated: 104, confirmed: 2714 });
  assert.equal(crypto.createHash('sha256').update(all.join('\n')).digest('hex'), 'bedc0f0cb76dc1a783c4e9ba30e513a4db47762856bf66b9f31f92fbbab9650a');
});

test('M3: the parent protected swing breaks only on a CLOSE past its tie: at 100 - tie it holds, past it the structure is invalid', () => {
  const rows = UP.slice(0, 4);
  let r = run([...rows, [104, 98, 100 - TIE]], [BREAKS[0]]);
  assert.equal(r.series[4].mode, 'bias');
  assert.deepEqual(r.events[4], []);
  r = run([...rows, [104, 98, 100 - TIE - 0.25]], [BREAKS[0]]);
  assert.deepEqual(r.events[4].map(e => e.type), ['invalid']);
  assert.equal(r.series[4].mode, 'none');
  // A wick far below with the close above: holds.
  r = run([...rows, [104, 80, 101]], [BREAKS[0]]);
  assert.equal(r.series[4].mode, 'bias');
});

test('M3: while transitioning, a break the OLD way resumes the old structure; only a break the CHoCH\'s way confirms the turn', () => {
  // A BOS up at candle 7 (the old way): resumed by break, the up structure with the new protected low.
  let x = at7([126, 110, 124], [{ direction: 'up', kind: 'BOS', level: 118, swing: 5, i: 7 }]);
  assert.ok(x.ev.includes('resumed-by-break'), x.ev.join());
  assert.equal(x.s.mode, 'bias');
  assert.equal(x.s.d, 1);
  // A BOS down at candle 7 (the CHoCH's way) with the close above the old protected low: the turn is confirmed down.
  x = at7([106, 101, 102], [{ direction: 'down', kind: 'BOS', level: 103, swing: 6, i: 7 }]);
  assert.ok(x.ev.includes('turn-confirmed'), x.ev.join());
  assert.equal(x.s.d, -1);
});

test('M3: CONFIRMED REVERSAL needs a setup close past its own tie (the world: a 15m close 146.5 over the protected high 145)', () => {
  const named = w => ({ ...w, level: { ...w.level, name: '1h>15m' }, below: { ...w.below, name: '15m>3m' } });
  const stageAt = setupTie => {
    const w = W.world({ keys: W.KEYS, events: W.EVENTS, atr: { setup: setupTie / EQ } });
    const v = named(w);
    const R = M.recordsOf({ tick: 0.25, bufferTicks: 1, equalAtr: EQ, k: AN.indicators.swingK, depth: AN.mtfStructure.depth, sideMode: 'rule', warmBars: 0, hierarchy: AN.mtfStructure.hierarchy, bars: v.bars, minutes: v.base, levels: [v.level, v.below], side: 'long', prims: v.prims });
    return R[w.end(35)].levels[0].stage;
  };
  assert.equal(stageAt(1.5), 'REVERSING', 'a close exactly at the protected high + tie is not through it');
  assert.equal(stageAt(1.25), 'CONFIRMED REVERSAL');
});
