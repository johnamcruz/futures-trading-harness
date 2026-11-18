'use strict';

// The two `MTF structure` lines (mtf-structure.js mtfLines), spec v2 section 4: every stage's line both ways, every
// `Above:` form, every `Entry: none:` reason, the age forms, truthfulness (every price and time on a line is in the
// record), no ready entry with a traded stop, the byte budget and the cut order step by step, one stage word per line and
// always two lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('../../scripts/lib/trading/mtf-structure');
const GF = require('../../scripts/lib/eval/goal-fixture');
const { analysis } = require('../../scripts/lib/tunables');
const W = require('../fixtures/mtf-structure/world');

const AN = analysis();
const CFG = AN.mtfStructure;
const LEVELS = M.levelsOf(CFG);
const OPTS = { tick: 0.25, bufferTicks: 1, equalAtr: AN.marketState.equalAtr, k: AN.indicators.swingK, depth: CFG.depth, sideMode: 'rule', warmBars: CFG.warmBars, hierarchy: CFG.hierarchy };
const BUDGET = { lineBytes: CFG.lineBytes, primaryBytes: CFG.primaryBytes };
const clone = x => JSON.parse(JSON.stringify(x));

const named = w => ({ ...w, level: { ...w.level, name: '1h>15m' }, below: { ...w.below, name: '15m>3m' } });
function run(w, o = {}) {
  const v = named(w);
  return M.recordsOf({ ...OPTS, bars: v.bars, minutes: v.base, levels: [v.level, v.below], warmBars: 0, side: 'long', prims: v.prims, ...o });
}
const A = W.world({ keys: W.KEYS, events: W.EVENTS });
const RA = run(A);
const one = (rec, o = {}) => M.mtfLines(rec, o)[0];

function real(day) {
  return GF.decodeBars(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mtf-structure', `${day}.json.gz`)))).bars);
}
const etHm = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const REAL = new Map();
/** Each real fixture's records on every bar of its session window (09:30 ET on), with the Bias reads and side varied. */
function realRecs(day) {
  if (REAL.has(day)) return REAL.get(day);
  const bars = real(day);
  const sides = ['long', 'short', null];
  const reads = ['up', 'down', 'range'];
  const recs = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: LEVELS, sideAt: j => sides[j % 3], biasAt: j => ({ '4h': reads[j % 3], '1h': reads[(j + 1) % 3] }), keep: j => j >= bars.length - 60 });
  const out = recs.map((r, j) => ({ r, j })).filter(x => x.r && x.j >= bars.length - 60 && bars[x.j].t.startsWith(day) && etHm(Date.parse(bars[x.j].t) + 180000) >= '09:30');
  REAL.set(day, out);
  return out;
}
const DAYS = ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12'];

test('every primary stage\'s line, the parent up, exactly (the grammar of pilot round three, spec 4.2)', () => {
  const at = A.at;
  const head = '1h structure UP, 1h protected low 100 (the origin of the last 1h break) holds on 1h closes';
  const want = {
    [at(17, 0) - 1]: `stage NONE. ${head}. 15m pullback against the 1h: NONE. Entry: none.`,
    [at(17, 0)]: `stage POTENTIAL. ${head}. 15m pullback against the 1h: NONE yet (only a 3m CHoCH down 02:18 against the 1h; no 15m break down yet). Monitor only. Entry: none.`,
    [A.end(17)]: `stage DEVELOPING. ${head}. 15m pullback against the 1h: DOWN (15m CHoCH down 02:30, no 15m BOS down yet: not established); pullback low 147.5; depth shallow (0.05); price has not turned back up. Track only. Entry: none.`,
    [A.end(20)]: `stage ESTABLISHED. ${head}. 15m pullback against the 1h: DOWN (15m CHoCH down 02:30, BOS down 03:15); pullback low 140; depth shallow (0.2); its protected high 145. 3m: price has not turned back up (no 3m CHoCH or CISD up yet). Entry: none yet.`,
    [at(25, 1)]: `stage WEAKENING. ${head}. 15m pullback against the 1h: DOWN (15m CHoCH down 02:30, BOS down 03:15); pullback low 130; depth moderate (0.4); its protected high 145. 3m turning back UP with the 1h: CHoCH up 04:21. Entry: aggressive ready LONG new this bar, structural stop 129.75 (a structure level, not an order stop); balanced NOT ready (needs a 3m BOS up).`,
    [at(25, 3)]: `stage WEAKENING. ${head}. 15m pullback against the 1h: DOWN (15m CHoCH down 02:30, BOS down 03:15); pullback low 130; depth moderate (0.4); its protected high 145. 3m turning back UP with the 1h: CHoCH up 04:21. Entry: aggressive ready LONG since 04:21 (2 bars), structural stop 129.75 (a structure level, not an order stop); balanced NOT ready (needs a 3m BOS up).`,
    [at(27, 1)]: `stage REVERSING. ${head}. 15m pullback against the 1h: DOWN (15m CHoCH down 02:30, BOS down 03:15); pullback low 130; depth moderate (0.4); its protected high 145. 3m turned back UP with the 1h: CHoCH up 04:21, then BOS up 04:51. Entry: balanced ready LONG new this bar, structural stop 132.75 (a structure level, not an order stop) (aggressive structural stop 129.75).`,
    [A.end(35)]: `stage CONFIRMED REVERSAL. ${head}. 15m pullback against the 1h: DOWN, now over on the 15m: a 15m close 146.5 above its protected high 145 at 07:00; price back UP with the 1h; the 1h impulse high 150 not yet broken. Entry: none yet: conservative NOT ready (needs a 3m CHoCH down, then a 3m BOS up).`,
    [at(36, 2)]: `stage CONFIRMED REVERSAL. ${head}. 15m pullback against the 1h: DOWN, now over on the 15m: a 15m close 146.5 above its protected high 145 at 07:00; price back UP with the 1h; the 1h impulse high 150 not yet broken. Entry: none yet: conservative NOT ready (3m CHoCH down 07:06 seen; needs a 3m BOS up).`,
    [at(37, 2)]: `stage CONFIRMED REVERSAL. ${head}. 15m pullback against the 1h: DOWN, now over on the 15m: a 15m close 146.5 above its protected high 145 at 07:00; price back UP with the 1h; the 1h impulse high 150 not yet broken. Entry: conservative ready LONG since 07:21 (1 bar), structural stop 147.75 (a structure level, not an order stop) (the 15m CHoCH origin 130); 3m BOS up 07:21 after a 3m CHoCH down.`,
    [A.end(38)]: `stage COMPLETED. ${head}. 15m pullback against the 1h: NONE now (the last one, DOWN, is finished: a 15m close 151 above the 1h impulse high 150; the 1h up trend continued). Entry: none.`,
    [A.end(38) + 1]: `stage NONE. ${head}. 15m pullback against the 1h: NONE (last: COMPLETED, 07:45). Entry: none.`,
  };
  for (const [j, s] of Object.entries(want)) assert.equal(one(RA[j]), `- MTF structure 1h > 15m (primary): ${s}`, `bar ${j}`);
});

test('every stage both ways: the mirrored world prints the same lines with up and down, high and low, LONG and SHORT swapped and the prices about the pivot', () => {
  const RM = run(W.world({ keys: W.KEYS, events: W.EVENTS, mirror: true }), { side: 'short' });
  const swap = s => s.replace(/\b(UP|DOWN|up|down|high|low|LONG|SHORT|above|below|long|short)\b/g, w => ({ UP: 'DOWN', DOWN: 'UP', up: 'down', down: 'up', high: 'low', low: 'high', LONG: 'SHORT', SHORT: 'LONG', above: 'below', below: 'above', long: 'short', short: 'long' }[w]))
    .replace(/\b\d+(\.\d+)?\b(?![:)-] ?\d)/g, (n, _f, off, str) => (/\d\d:$/.test(str.slice(0, off)) || /\(\d?$/.test(str.slice(0, off)) && Number(n) < 1 ? n : String(300 - Number(n))));
  const seen = new Set();
  for (let j = 0; j < A.n; j += 1) {
    const [p, b] = M.mtfLines(RA[j]);
    const [pm, bm] = M.mtfLines(RM[j]);
    seen.add(RA[j].levels[0].stage);
    seen.add(RA[j].levels[1].stage);
    const strip = s => s.replace(/\((0\.\d+|1)\)/g, '(D)').replace(/\d\d:\d\d/g, 'T').replace(/\(\d+ bars?\)/g, '(n)');
    const hdr = s => s.replace(/^- MTF structure (below: )?[^:]*: /, '');
    assert.equal(strip(hdr(pm)), strip(swap(hdr(p))), `primary bar ${j}`);
    assert.equal(strip(hdr(bm)), strip(swap(hdr(b))), `below bar ${j}`);
  }
  for (const s of ['NONE', 'POTENTIAL', 'DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING', 'CONFIRMED REVERSAL', 'COMPLETED', 'INVALIDATED']) assert.ok(seen.has(s), s);
});

test('INVALIDATED (primary and below), the reset line, early weakening and the I8 fact on NONE and POTENTIAL', () => {
  const keys = W.KEYS.filter(([x]) => x < 20).concat([[20, W.pathAt(W.KEYS, 20)], [24, 90], [47, 90]]);
  const w = W.world({ keys, events: W.EVENTS.slice(0, 4), atr: { timing: 2000 } });
  const r = run(w);
  const j = r.findIndex(x => x && x.levels[0].stage === 'INVALIDATED');
  assert.ok(j > 0);
  assert.match(one(r[j]), /^- MTF structure 1h > 15m \(primary\): stage INVALIDATED\. A 1h close [\d.]+ below the 1h protected low 100: the 1h structure, UP until now, is broken\. 1h structure: none until the next 1h break\. Setup cancelled\. Entry: none\.$/);
  assert.match(one(r[j + 1]), /stage NONE\. 1h structure: none \(its protected swing broke; waiting for the next 1h break\)\. No 15m pullback read\. Entry: none\.$/);
  const reset = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(26, 0)]: { c: 129.25 } }, atr: { timing: 10 } });
  assert.match(one(run(reset)[A.at(26, 0)]), /stage ESTABLISHED\. .* 3m: the turn up failed \(a 3m close below the pullback low 130 at 04:33: reset\); price has not turned back up\. Entry: none yet\./);
  const minor = W.world({ keys: W.KEYS, events: [...W.EVENTS, { f: 'setup', at: 21, kind: 'CHoCH', dir: 1, swing: 20, level: 141.5 }] });
  assert.match(one(run(minor)[minor.end(21)]), /\. Early weakening: a 15m close above the minor high 141\.5\. Entry: none yet\./);
  const orphan = W.world({ keys: W.KEYS, events: [W.EVENTS[0], W.EVENTS[1], { f: 'setup', at: 17, kind: 'BOS', dir: -1, swing: 15 }] });
  assert.match(one(run(orphan)[orphan.end(17)]), /stage POTENTIAL\. .* 15m pullback against the 1h: NONE yet \(only a 3m CHoCH down 02:18 against the 1h; no 15m CHoCH down yet \(15m last break: BOS down, against the 1h; no CHoCH inside this structure\)\)\./);
  const orphan2 = W.world({ keys: W.KEYS, events: [W.EVENTS[0], { f: 'setup', at: 17, kind: 'BOS', dir: -1, swing: 15 }] });
  assert.match(one(run(orphan2)[orphan2.end(17)]), /stage NONE\. .* 15m pullback against the 1h: NONE \(15m last break: BOS down, against the 1h; no CHoCH inside this structure\)\. Entry: none\./);
  // The below line's INVALIDATED ends with its own none-until clause, no Setup cancelled, no Entry clause.
  const below = RA.map(x => M.mtfLines(x)[1]).find(l => /stage INVALIDATED/.test(l));
  assert.match(below, /^- MTF structure below: 15m > 3m \(context\): stage INVALIDATED\. A 15m close [\d.]+ above the 15m protected high [\d.]+: the 15m structure, DOWN until now, is broken\. 15m structure: none until the next 15m break\.$/);
});

test('every Entry: none: reason, and the entry\'s ages (new this bar, n bars, 1 bar; an earlier day\'s time with its date)', () => {
  const j = A.at(25, 1);
  assert.match(one(run(A, { side: 'short' })[j]), /Entry: none: against the side \(Bias: short only\)\./);
  assert.match(one(run(A, { side: null })[j]), /Entry: none: no side \(4h and 1h not aligned\)\./);
  const wick = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(26, 0)]: { l: 129.75, c: 131 } }, atr: { timing: 10 } });
  assert.match(one(run(wick)[A.at(26, 1)]), /stage WEAKENING\. .*Entry: none: the aggressive structural stop 129\.75 traded through at 04:33\./);
  const keys = [[0, 105], [4, 100], [16, 150], [24, 101], [44, 160], [47, 162]];
  const warn = W.world({ keys, events: W.EVENTS, overrides: { [A.at(24, 1)]: { l: 95, c: 101 }, [A.at(26, 2)]: { c: 99 } } });
  const wl = one(run(warn)[A.at(26, 2)]);
  assert.match(wl, /1h protected low 100 \(the origin of the last 1h break\) not broken on a 1h close; WARNING: a 3m close 99 below it at 04:39 \(the 1h close decides\)/);
  assert.match(wl, /Entry: none: a close is through the 1h protected low \(the 1h close decides\)\./);
  assert.match(one(RA[A.at(37, 2)]), /since 07:21 \(1 bar\)/);
  // An earlier ET day's time carries its date (real bars, 2022-03-07 at 00:00 ET: the 15m CHoCH of the evening before).
  const bars = real('2022-03-07');
  const j0 = bars.findIndex(b => b.t === '2022-03-07T04:57:00.000Z');
  const rec = M.mtfStructure({ ...OPTS, bars: bars.slice(0, j0 + 1), minutes: 3, levels: LEVELS, side: 'short' });
  assert.match(one(rec), /stage ESTABLISHED\. .*15m pullback against the 1h: UP \(15m CHoCH up 03-06 22:30, BOS up 00:00\);/);
});

test('every Above: form (SPEC v3: the primary\'s own 1h structure against the 4h): with, against, not broken (the primary INVALIDATED), no 1h structure, none, not enough history, the short form, the Bias disagreement; the 4h level\'s own instance never changes it', () => {
  const base = clone(RA[A.at(25, 1)]);
  const lv4 = patch => ({ name: '4h>1h', role: 'above', frames: { parent: '4h', setup: '1h', timing: '15m' }, partial: false, parent: { way: 'down', protected: { side: 'high', level: 14060.25 }, differs: false, biasRead: null }, stage: 'NONE', instance: null, ...patch });
  const above = (patch, primary) => {
    const r = clone(base);
    if (primary) r.levels[0] = { ...r.levels[0], ...primary };
    r.levels.unshift(lv4(patch));
    return one(r).replace(/^.* Above: /, 'Above: ');
  };
  const up = { parent: { way: 'up', protected: { side: 'low', level: 11836.5 }, differs: false } };
  // The primary's 1h structure is UP (the world's), so a 4h DOWN reads a 1h pullback UP, a 4h UP reads NONE.
  assert.equal(base.levels[0].parent.way, 'up');
  assert.equal(above(up), 'Above: 4h structure UP, 4h protected low 11836.5 holds on 4h closes; 1h pullback against the 4h: NONE (the 1h structure is UP, with the 4h).');
  assert.equal(above({}), 'Above: 4h structure DOWN, 4h protected high 14060.25 holds on 4h closes; 1h pullback against the 4h: UP (the 1h structure is UP, against the 4h DOWN).');
  // The 4h level's own stage and instance stay in the record and never print: the 2021-08-04 case (a 1h CHoCH against the
  // 1h structure is the primary head's warning, not a 1h pullback).
  const dev = { developing: { et: '08:00' }, established: { et: '10:00' } };
  for (const stage of ['POTENTIAL', 'DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING', 'CONFIRMED REVERSAL', 'COMPLETED']) {
    assert.equal(above({ ...up, stage, instance: dev }), above(up), stage);
    assert.equal(above({ stage, instance: dev }), above({}), stage);
  }
  const inv = { stage: 'INVALIDATED', invalidated: { close: 99, level: 100, way: 'up' } };
  assert.equal(above({ parent: { way: 'down', protected: { side: 'high', level: 13781 }, differs: false } }, inv), 'Above: 4h structure DOWN, not broken, 4h protected high 13781 holds on 4h closes; 1h pullback against the 4h: NONE (no 1h structure until the next 1h break).');
  assert.equal(above(up, { parent: null, stage: 'NONE' }), 'Above: 4h structure UP, 4h protected low 11836.5 holds on 4h closes; 1h pullback against the 4h: NONE (no 1h structure).');
  assert.equal(above(up, { partial: true }), 'Above: 4h structure UP, 4h protected low 11836.5 holds on 4h closes; 1h pullback against the 4h: NONE (no 1h structure).');
  assert.equal(above({ parent: null }), 'Above: 4h structure: none (its protected swing broke); 1h pullback against the 4h: NONE.');
  assert.equal(above({ partial: true }), 'Above: 4h structure: not enough history.');
  assert.equal(above({ parent: { way: 'down', protected: { side: 'high', level: 14060.25 }, differs: true, biasRead: 'range' } }), 'Above: 4h structure DOWN (its break record; the Bias line reads the 4h range), 4h protected high 14060.25 holds on 4h closes; 1h pullback against the 4h: UP (the 1h structure is UP, against the 4h DOWN).');
  // The short form (cut aboveShort).
  const short = (patch) => { const r = clone(base); r.levels.unshift(lv4(patch)); return M.mtfLines(r, { cut: M.CUTS.indexOf('aboveShort') + 1 })[0].replace(/^.* Above: /, 'Above: '); };
  assert.equal(short(up), 'Above: 4h structure UP; 1h pullback against the 4h: NONE.');
  assert.equal(short({}), 'Above: 4h structure DOWN; 1h pullback against the 4h: UP.');
});

test('aboveRelation: with, against, no 1h structure, the primary INVALIDATED, the level above partial or without a structure', () => {
  const lv = way => ({ partial: false, parent: { way }, stage: 'NONE' });
  const pr = (way, o = {}) => ({ partial: false, stage: 'ESTABLISHED', parent: way ? { way } : null, ...o });
  assert.deepEqual(M.aboveRelation(lv('up'), pr('up')), { way: 'up', setupWay: 'up', pullback: null });
  assert.deepEqual(M.aboveRelation(lv('down'), pr('up')), { way: 'down', setupWay: 'up', pullback: 'up' });
  assert.deepEqual(M.aboveRelation(lv('up'), pr('down')), { way: 'up', setupWay: 'down', pullback: 'down' });
  assert.deepEqual(M.aboveRelation(lv('up'), pr(null)), { way: 'up', setupWay: null, pullback: null });
  assert.deepEqual(M.aboveRelation(lv('up'), pr('down', { stage: 'INVALIDATED' })), { way: 'up', setupWay: null, pullback: null });
  assert.deepEqual(M.aboveRelation(lv('up'), pr('down', { partial: true })), { way: 'up', setupWay: null, pullback: null });
  assert.deepEqual(M.aboveRelation(lv('up'), null), { way: 'up', setupWay: null, pullback: null });
  assert.equal(M.aboveRelation({ partial: true, parent: { way: 'up' } }, pr('down')), null);
  assert.equal(M.aboveRelation({ partial: false, parent: null }, pr('down')), null);
  assert.equal(M.aboveRelation(null, pr('down')), null);
  // The level above's own stage is not read.
  for (const stage of ['DEVELOPING', 'ESTABLISHED', 'CONFIRMED REVERSAL']) assert.deepEqual(M.aboveRelation({ ...lv('up'), stage, instance: {} }, pr('up')).pullback, null);
});

test('the 1h head: the Bias disagreement at every stage, the parent CHoCH warning, not enough history', () => {
  const r = run(A, { bias: { '1h': 'down' } });
  for (const j of [A.at(17, 0) - 1, A.at(17, 0), A.end(17), A.end(20), A.at(25, 1), A.at(27, 1), A.end(35), A.end(38)]) {
    assert.match(one(r[j]), /1h structure UP \(its break record; the Bias line reads the 1h down: the side is the Bias line's\), 1h protected low 100/, `bar ${j}`);
  }
  assert.doesNotMatch(one(run(A, { bias: { '1h': 'up' } })[A.at(25, 1)]), /its break record/);
  const pt = W.world({ keys: W.KEYS, events: [...W.EVENTS.slice(0, 4), { f: 'parent', at: 6, kind: 'CHoCH', dir: -1, swing: 4, level: 140 }] });
  assert.match(one(run(pt)[pt.endP(6)]), /1h protected low 100 \(the origin of the last 1h break\) holds on 1h closes \(1h CHoCH down at 140: a warning, not a reversal\)\./);
  assert.match(one(run(A, { warmBars: 5 })[A.at(25, 1)]), /^- MTF structure 1h > 15m \(primary\): stage NONE\. Not enough 1h history\. Entry: none\.$/);
});

test('the cut order, step by step: each step leaves out its part and keeps every later one; the never-cut parts survive the last cut', () => {
  // A record holding every cuttable part: WEAKENING with a minor high, a parent CHoCH, a ready entry with its NOT ready
  // words, the Above clause, and a NONE below line with its last closure.
  const r = clone(RA[A.at(25, 1)]);
  const p = r.levels[0];
  p.instance.minor = { level: 141.5, et: '04:00' };
  p.parent.against = { kind: 'CHoCH', direction: 'down', level: 120 };
  p.parent.differs = true; p.parent.biasRead = 'range';
  r.levels[1] = { ...r.levels[1], stage: 'NONE', instance: null, last: { why: 'ended before established', et: '04:00' }, parent: { way: 'up', protected: { side: 'low', level: 125 }, differs: false } };
  r.levels.unshift({ name: '4h>1h', role: 'above', frames: { parent: '4h', setup: '1h', timing: '15m' }, partial: false, parent: { way: 'up', protected: { side: 'low', level: 90 }, differs: false }, stage: 'NONE', instance: null });
  const MARK = { belowShort: /3m pullback against the 15m: NONE \(last: ended before ESTABLISHED/, aboveShort: /Above: 4h structure UP, 4h protected low 90 holds on 4h closes/, origin: /\(the origin of the last 1h break\)/, depth: /; depth moderate \(0\.4\)/,
    last: /\(last: ended before ESTABLISHED/, early: /Early weakening/, protected: /its protected high 145/, parentChoch: /a warning, not a reversal/, notReady: /balanced NOT ready/ };
  assert.deepEqual(Object.keys(MARK), [...M.CUTS]);
  // `last` lives on the below line, which the first cut shortens: its own check uses a NONE primary.
  let prev = Infinity;
  for (let cut = 0; cut <= M.CUTS.length; cut += 1) {
    const text = M.mtfLines(r, { cut }).join('\n');
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes <= prev, `cut ${cut}: never longer`);
    prev = bytes;
    M.CUTS.forEach((name, i) => {
      if (name === 'last') return;
      if (i < cut) assert.doesNotMatch(text, MARK[name], `cut ${cut}: ${name} left out`);
      else assert.match(text, MARK[name], `cut ${cut}: ${name} kept`);
    });
    for (const keep of [/stage WEAKENING\./, /1h structure UP \(its break record; the Bias line reads the 1h range: the side is the Bias line's\), 1h protected low 100/, /15m pullback against the 1h: DOWN/, /aggressive ready LONG new this bar, structural stop 129\.75 \(a structure level, not an order stop\)/, /stage NONE\./]) assert.match(text, keep, `cut ${cut}`);
    assert.equal(M.mtfLines(r, { cut }).length, 2);
  }
  // The `last` step (5) on a NONE primary: other closures cut there, COMPLETED and INVALIDATED never.
  for (const [why, word, kept] of [['ended before established', 'ended before ESTABLISHED', false], ['completed', 'COMPLETED', true], ['invalidated', 'INVALIDATED', true]]) {
    const n = clone(RA[A.at(17, 0) - 1]);
    n.levels[0].last = { why, et: '07:45' };
    for (let cut = 0; cut <= M.CUTS.length; cut += 1) {
      const l = M.mtfLines(n, { cut })[0];
      const want = kept || cut <= M.CUTS.indexOf('last');
      assert.equal(new RegExp(`\\(last: ${word}, 07:45\\)`).test(l), want, `${why} at cut ${cut}`);
    }
  }
  // The warning and the reason after Entry: none: survive the last cut.
  const keys = [[0, 105], [4, 100], [16, 150], [24, 101], [44, 160], [47, 162]];
  const warn = run(W.world({ keys, events: W.EVENTS, overrides: { [A.at(24, 1)]: { l: 95, c: 101 }, [A.at(26, 2)]: { c: 99 } } }))[A.at(26, 2)];
  const last = M.mtfLines(warn, { cut: M.CUTS.length })[0];
  assert.match(last, /WARNING: a 3m close 99 below it at 04:39/);
  assert.match(last, /Entry: none: a close is through the 1h protected low/);
});

test('the byte budget: the lines are cut only as far as needed; the budget is met on every real in-window bar (or the last cut is reached)', () => {
  const r = clone(RA[A.at(25, 1)]);
  const full = M.mtfLines(r);
  const b0 = Buffer.byteLength(full[0]);
  assert.deepEqual(M.mtfLines(r, { primaryBytes: b0, lineBytes: Infinity }), full);
  const cutOne = M.mtfLines(r, { primaryBytes: b0 - 1, lineBytes: Infinity });
  assert.ok(Buffer.byteLength(cutOne[0]) <= b0 - 1);
  for (const d of DAYS) {
    for (const { r: rec, j } of realRecs(d)) {
      const ls = M.mtfLines(rec, BUDGET);
      const a = Buffer.byteLength(ls[0]);
      const fits = a <= BUDGET.primaryBytes && a + Buffer.byteLength(ls[1]) <= BUDGET.lineBytes;
      assert.ok(fits || ls.join() === M.mtfLines(rec, { cut: M.CUTS.length }).join(), `${d} bar ${j}: over the budget before the last cut`);
    }
  }
});

test('real bars: exactly one stage word per line, always two lines, every price and time on a line is in the record, and no ready entry whose structural stop has traded; each level\'s pullback phrase once; the Above clause\'s way is aboveRelation\'s', () => {
  let n = 0;
  const nAbove = { pb: 0, none: 0 };
  for (const d of DAYS) {
    for (const { r: rec, j } of realRecs(d)) {
      const ls = M.mtfLines(rec, BUDGET);
      assert.equal(ls.length, 2, `${d} ${j}`);
      for (const l of ls) assert.equal((l.match(/\bstage (NONE|POTENTIAL|DEVELOPING|ESTABLISHED|WEAKENING|REVERSING|CONFIRMED REVERSAL|COMPLETED|INVALIDATED)\b/g) || []).length, 1, `${d} ${j}: ${l}`);
      const nums = new Set();
      const ets = new Set();
      (function walk(o) {
        if (Array.isArray(o)) return o.forEach(walk);
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) { if (typeof v === 'number') nums.add(v); if (k === 'et') ets.add(v); walk(v); }
      }(rec));
      const text = ls.join('\n');
      for (const p of text.match(/\b\d{4,}(?:\.\d+)?\b/g) || []) assert.ok(nums.has(Number(p)), `${d} ${j}: price ${p} not in the record`);
      for (const t of text.match(/\b(?:\d\d-\d\d )?\d\d:\d\d\b/g) || []) assert.ok(ets.has(t), `${d} ${j}: time ${t} not in the record`);
      const p = rec.levels.find(x => x.role === 'primary');
      if (/ ready (LONG|SHORT)/.test(ls[0])) assert.ok(p.entry && !p.entryWithheld && !p.stopTraded, `${d} ${j}: ready printed with a withheld entry`);
      // SPEC v3: each level with a structure prints its pullback phrase exactly once, on its own line; none without one.
      const count = (s, re) => (s.match(re) || []).length;
      const b = rec.levels.find(x => x.role === 'below');
      const a = rec.levels.find(x => x.role === 'above');
      const has = lv => !lv.partial && !!lv.parent && lv.stage !== 'INVALIDATED';
      assert.equal(count(ls[0], /15m pullback against the 1h: (UP|DOWN|NONE)/g), has(p) ? 1 : 0, `${d} ${j}: ${ls[0]}`);
      assert.equal(count(ls[1], /3m pullback against the 15m: (UP|DOWN|NONE)/g), has(b) ? 1 : 0, `${d} ${j}: ${ls[1]}`);
      assert.equal(count(ls[0], /1h pullback against the 4h: (UP|DOWN|NONE)/g), a && !a.partial ? 1 : 0, `${d} ${j}: ${ls[0]}`);
      assert.equal(count(text, /pullback against the/g), count(text, /pullback against the \w+: (UP|DOWN|NONE)/g), `${d} ${j}`);
      // The Above clause's way is aboveRelation's.
      if (a && !a.partial) {
        const r = M.aboveRelation(a, p);
        const got = ls[0].match(/1h pullback against the 4h: (UP|DOWN|NONE)/)[1];
        assert.equal(got, r && r.pullback ? r.pullback.toUpperCase() : 'NONE', `${d} ${j}: ${ls[0]}`);
        if (r) nAbove[r.pullback ? 'pb' : 'none'] += 1;
      }
      n += 1;
    }
  }
  assert.ok(n > 150, `in-window bars read: ${n}`);
  // The four fixtures' 1h runs with the 4h on every window bar; the against way is the Above test's and gate 1's.
  assert.ok(nAbove.pb + nAbove.none > 150, `the Above clause checked: ${JSON.stringify(nAbove)}`);
});
