'use strict';

// The curated lists' trend labels from the trend-leg detector (curated-lists.js labelLegs, legsFor, buildLists' legs;
// replay/trend-capture.js legsOf): a moment at the start of a leg its way is a trend moment whatever its 1h/4h trend,
// each leg gets a moment first, and the label only chooses practice moments: a run pins its windows alone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/learning/curated-lists');
const { VERSION } = require('../../scripts/lib/learning/curated-moments');
const { load } = require('../fixtures/trend-moves');
const { tmpDir } = require('../helpers');

const SESSION = '09:30-12:00@America/New_York';
const { bars, legs: set } = load();
const legs = C.legsFor(bars.m3, { session: SESSION });
const MIN3 = 3 * 60000;

/** A scanned moment as curated-moments.js writes one (the fields the selection reads), labelled chop by its 1h/4h. */
function moment(bar, side, list = 'chop', id = `${bar}|${side}`) {
  const t = Date.parse(bar);
  return {
    v: VERSION, use: 'practice', id, root: 'MNQ', day: new Date(t + 6 * 3600000).toISOString().slice(0, 10), year: bar.slice(0, 4), reactionAt: bar, bar, minutes: 3, setupTf: 15, side, list,
    trend: { state: list, dir: null, h1: 'range', h4: 'range' }, reactionKind: 'rejection', skills: ['rejection'], aligned: ['rejection'], expected: 'pass', gate: null,
    outcome: { result: 'no-room' }, window: { from: new Date(t - 4 * MIN3).toISOString(), to: new Date(t + MIN3).toISOString() },
  };
}
const leg = id => set.legs.find(l => l.id === id);
const after = (l, n) => new Date(Date.parse(l.start) + n * MIN3).toISOString();

test('curated legs: a 1h/4h chop moment at the start of a detected leg its way is labelled trend-down or trend-up', () => {
  const down = leg('leg-03'); // a short leg on a day the 1h and 4h read range
  const up = leg('leg-10'); // a long leg on another such day
  const out = C.labelLegs([moment(after(down, 1), 'short'), moment(after(up, 1), 'long'), moment(after(up, 1), 'short'), moment(after(down, 1), 'long')], legs.legs);
  assert.deepStrictEqual(out.map(m => m.list), ['trend-down', 'trend-up', 'chop', 'chop']);
  assert.deepStrictEqual([out[0].trendList, out[0].trend.h1, out[0].trend.h4], ['chop', 'range', 'range'], 'the 1h/4h facts kept as context');
  assert.match(out[0].leg.id, /^\d{4}-\d{2}-\d{2}\|short\|/);
  // Past the leg's first part: no label.
  const l = legs.legs.find(g => g.side === 'long' && Date.parse(g.end) - Date.parse(g.start) >= 6 * MIN3);
  const late = new Date(Date.parse(l.end) - MIN3).toISOString();
  assert.strictEqual(C.labelLegs([moment(late, 'long')], legs.legs)[0].list, 'chop');
});

test('curated legs: every detected leg with a moment its way gets one in the list first, then the budget fills as before', () => {
  const ms = [];
  for (const g of legs.legs) for (let n = 0; n < 3; n += 1) ms.push(moment(new Date(Date.parse(g.start) + n * MIN3).toISOString(), g.side, 'chop', `${g.start}|${n}`));
  for (let n = 0; n < 6; n += 1) ms.push(moment(new Date(Date.parse(legs.legs[0].start) - (n + 40) * MIN3).toISOString(), 'long', 'chop', `other${n}`));
  const total = 40;
  const doc = C.buildLists(ms, { use: 'practice', total, legs, now: new Date('2026-10-23T00:00:00Z') });
  for (const name of ['trend-up', 'trend-down']) {
    const cov = doc.coverage[name].legs;
    assert.ok(cov.detected > 0 && cov.withMoment === cov.detected, name);
    assert.strictEqual(cov.covered, Math.min(cov.withMoment, doc.lists[name].length), `${name}: every leg represented within the list's budget`);
  }
  assert.deepStrictEqual(doc.options.legs, { detector: legs.detector, count: legs.legs.length });
  // Without legs the build is as before: no leg option, the 1h/4h labels.
  const plain = C.buildLists(ms, { use: 'practice', total, now: new Date('2026-10-23T00:00:00Z') });
  assert.ok(!('legs' in plain.options));
  assert.deepStrictEqual(plain.lists['trend-up'], []);
  assert.notStrictEqual(plain.fingerprint, doc.fingerprint, 'a labelled build is a new document');
});

test('curated legs: the label never reaches a run: the pin holds the windows only', () => {
  const ms = legs.legs.map((g, i) => moment(new Date(Date.parse(g.start) + MIN3).toISOString(), g.side, 'chop', `m${i}`));
  const doc = C.buildLists(ms, { use: 'practice', total: 20, legs, now: new Date('2026-10-23T00:00:00Z') });
  const dir = tmpDir();
  const file = C.writeLists(dir, doc);
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'learning-run.json'), JSON.stringify({ learning: true, role: 'practice-train', practice: { setupTf: 15 } }));
  C.pinCurated(home, { file, fingerprint: doc.fingerprint, list: 'mix' });
  const pinned = fs.readFileSync(path.join(home, 'experience', 'curated-pinned.json'), 'utf8');
  assert.deepStrictEqual(Object.keys(JSON.parse(pinned)).sort(), ['fingerprint', 'hash', 'kind', 'list', 'windows']);
  for (const word of ['trend-up', 'trend-down', 'leg', 'chop', 'outcome', 'points']) assert.ok(!pinned.includes(word), word);
});
