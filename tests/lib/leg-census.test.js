'use strict';

// The trend-leg census (scripts/lib/learning/leg-census.js): every detected leg with its first with-leg moment, in one
// seeded order; batches drawn from it are disjoint and cover the pool; a date filter; a curated list per batch.

const test = require('node:test');
const assert = require('node:assert');
const LC = require('../../scripts/lib/learning/leg-census');
const C = require('../../scripts/lib/learning/curated-lists');
const { VERSION } = require('../../scripts/lib/learning/curated-moments');
const { load } = require('../fixtures/trend-moves');
const { tmpDir } = require('../helpers');

const { bars } = load();
const legs = C.legsFor(bars.m3, { session: '09:30-12:00@America/New_York' });
const MIN3 = 3 * 60000;
const NOW = new Date('2026-10-23T00:00:00Z');

function moment(bar, side, id) {
  const t = Date.parse(bar);
  return {
    v: VERSION, use: 'practice', id, root: 'MNQ', day: new Date(t + 6 * 3600000).toISOString().slice(0, 10), year: bar.slice(0, 4), reactionAt: bar, bar, minutes: 3, setupTf: 15, side, list: 'chop',
    trend: { state: 'chop' }, reactionKind: 'rejection', skills: ['rejection'], aligned: [], expected: 'pass', gate: null, outcome: { result: 'no-room' },
    window: { from: new Date(t - 4 * MIN3).toISOString(), to: new Date(t + MIN3).toISOString() },
  };
}
// Every leg but the last has a with-leg moment on its second bar; one moment the other way, which no leg takes.
const moments = [...legs.legs.slice(0, -1).map((g, i) => moment(new Date(Date.parse(g.start) + MIN3).toISOString(), g.side, `m${i}`)),
  moment(new Date(Date.parse(legs.legs[0].start) + MIN3).toISOString(), legs.legs[0].side === 'long' ? 'short' : 'long', 'other')];

test('leg census: every leg in one seeded order, each with its first with-leg moment; the same seed the same order', () => {
  const a = LC.buildCensus(moments, legs, { use: 'practice', seed: 7, now: NOW });
  const firsts = C.legFirsts(C.labelLegs(moments, legs.legs));
  assert.ok(firsts.length > 8);
  assert.deepStrictEqual([a.kind, a.seed, a.legs, a.withMoment], ['leg-census', 7, legs.legs.length, firsts.length]);
  assert.deepStrictEqual(a.order.map(x => x.id).sort(), legs.legs.map(g => `${g.day}|${g.side}|${g.start}`).sort());
  assert.ok(a.order.every(x => !x.moment || (x.moment.leg.id === x.id && x.moment.list === (x.side === 'long' ? 'trend-up' : 'trend-down'))));
  const b = LC.buildCensus(moments, legs, { use: 'practice', seed: 7, now: NOW });
  assert.deepStrictEqual(b.order.map(x => x.id), a.order.map(x => x.id));
  assert.strictEqual(b.fingerprint, a.fingerprint);
  const other = LC.buildCensus(moments, legs, { use: 'practice', seed: 8, now: NOW });
  assert.notDeepStrictEqual(other.order.map(x => x.id), a.order.map(x => x.id), 'another seed, another order');
  assert.throws(() => LC.buildCensus(moments, legs, { use: 'practice', seed: 1.5 }), /seed is an integer/);
});

test('leg census: batches are disjoint and cover the pool in order; the date filter keeps its days only', () => {
  const doc = LC.buildCensus(moments, legs, { use: 'practice', seed: 3, now: NOW });
  const size = 4;
  const all = [];
  for (let k = 0; ; k += 1) {
    const b = LC.batch(doc, k, { size });
    if (!b.length) break;
    assert.ok(b.length <= size);
    all.push(...b.map(x => x.id));
  }
  assert.strictEqual(new Set(all).size, all.length, 'disjoint');
  assert.deepStrictEqual(all, doc.order.filter(x => x.moment).map(x => x.id), 'the pool in the census order');
  const day = doc.order.find(x => x.moment).day;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const one = LC.batch(doc, 0, { from: day, to: next, size: 100 });
  assert.ok(one.length > 0 && one.every(x => x.day === day));
  assert.strictEqual(LC.batch(doc, 0, { size: 100, withMoment: false }).length, doc.legs);
  assert.throws(() => LC.batch(doc, -1), /whole number/);
});

test('leg census: written and read back by its fingerprint; a batch builds one hashed curated list of its trend moments', () => {
  const doc = LC.buildCensus(moments, legs, { use: 'practice', seed: 3, now: NOW });
  const file = LC.writeCensus(tmpDir(), doc);
  assert.deepStrictEqual(LC.readCensus(file), doc);
  const fs = require('fs');
  fs.writeFileSync(file, JSON.stringify({ ...doc, seed: 4 }));
  assert.throws(() => LC.readCensus(file), /changed since it was built/);
  const b0 = LC.batch(doc, 0, { size: 5 }).map(e => e.moment);
  const b1 = LC.batch(doc, 1, { size: 5 }).map(e => e.moment);
  const list = k => C.buildLists(k ? b1 : b0, { use: 'practice', total: k ? b1.length : b0.length, census: { fingerprint: doc.fingerprint, seed: doc.seed, batch: k, size: 5 }, now: NOW });
  const l0 = list(0);
  const l1 = list(1);
  assert.deepStrictEqual(l0.mix.slice().sort(), b0.map(m => m.id).sort(), 'the batch is the list');
  assert.deepStrictEqual([...l0.lists['trend-end'], ...l0.lists.chop, ...l0.lists['counter-trend']], []);
  assert.deepStrictEqual(l0.options.census, { fingerprint: doc.fingerprint, seed: 3, batch: 0, size: 5 });
  assert.notStrictEqual(l0.fingerprint, l1.fingerprint);
  assert.ok(!l1.mix.some(id => l0.mix.includes(id)), 'batches disjoint');
});
