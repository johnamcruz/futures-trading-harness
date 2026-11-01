'use strict';

// Phase 2 started at the head trader's OK compose (scripts/lib/entry-overlap.js): started on the latest OK record,
// superseded when the head trader composes again, adopted only on the same key, request and snapshot; anything else
// dropped (its run stopped) and never adopted.

const test = require('node:test');
const assert = require('node:assert');
const { createOverlap } = require('../../scripts/lib/entry-overlap');

const SNAP = { record: 'A', bar: '2026-10-07T13:54:00.000Z', side: 'long', size: 1, briefing: '2026-10-07T13:54:00.000Z', bars: 'h1' };
const noTimers = { setInterval: () => ({}), clearInterval: () => {} };

function world(o = {}) {
  let key = o.key === undefined ? null : o.key;
  const started = [];
  const h = createOverlap({
    pollMs: 1, timers: noTimers,
    latest: () => { if (o.latestThrows) throw new Error('unreadable'); return key; },
    request: async k => (o.noRequest ? null : { request: `review ${k}`, snapshot: { ...SNAP, record: k } }),
    start: (request, signal) => {
      const run = { request, signal };
      started.push(run);
      return new Promise(resolve => { run.resolve = resolve; signal.addEventListener('abort', () => resolve({ ok: false, timedOut: false, text: '', tools: [], output: '', cancelled: true })); });
    },
  });
  return { h, started, set: k => { key = k; } };
}

test('createOverlap: nothing starts without an OK record; the latest OK record starts one run, once', async () => {
  const w = world();
  await w.h.tick();
  assert.strictEqual(w.started.length, 0);
  w.set('A');
  await w.h.tick();
  await w.h.tick();
  assert.deepStrictEqual(w.started.map(x => x.request), ['review A']);
  assert.deepStrictEqual(w.h.summary().map(x => [x.record, x.outcome]), [['A', 'running']]);
});

test('createOverlap: the head trader composes again: the first run stopped (superseded), one started on the new record; a not-OK latest stops it too', async () => {
  const w = world({ key: 'A' });
  await w.h.tick();
  w.set('B');
  await w.h.tick();
  assert.deepStrictEqual(w.started.map(x => [x.request, x.signal.aborted]), [['review A', true], ['review B', false]]);
  w.set(null);
  await w.h.tick();
  assert.strictEqual(w.started[1].signal.aborted, true);
  assert.deepStrictEqual(w.h.summary().map(x => [x.record, x.outcome]), [['A', 'superseded'], ['B', 'superseded']]);
  assert.match(w.h.summary()[1].why, /not OK/);
});

test('createOverlap: take adopts only the same key, request and snapshot; each mismatch drops the run (no adoption) and says what changed', async () => {
  for (const [name, take, why] of [
    ['another record', h => h.take('B', 'review B', { ...SNAP, record: 'B' }), /no phase 2 running on record B/],
    ['another request', h => h.take('A', 'review A, other reports', SNAP), /its request is not the one/],
    ['a stale bar', h => h.take('A', 'review A', { ...SNAP, bar: '2026-10-07T13:57:00.000Z' }), /changed since it started \(bar\)/],
    ['another side', h => h.take('A', 'review A', { ...SNAP, side: 'short' }), /\(side\)/],
    ['another size', h => h.take('A', 'review A', { ...SNAP, size: 2 }), /\(size\)/],
    ['a newer briefing', h => h.take('A', 'review A', { ...SNAP, briefing: '2026-10-07T13:57:00.000Z' }), /\(briefing\)/],
    ['another bars file snapshot', h => h.take('A', 'review A', { ...SNAP, bars: 'h2' }), /\(bars\)/],
    ['an unreadable bars file', h => h.take('A', 'review A', { ...SNAP, bars: { unreadable: 1 } }), /\(bars\)/],
  ]) {
    const w = world({ key: 'A' });
    await w.h.tick();
    const got = take(w.h);
    assert.strictEqual(got.run, null, name);
    assert.match(got.why, why, name);
    if (name !== 'another record') {
      assert.strictEqual(w.started[0].signal.aborted, true, `${name}: stopped`);
      assert.strictEqual(w.h.summary()[0].outcome, 'discarded', name);
      // Never adopted afterwards either.
      assert.strictEqual(w.h.take('A', 'review A', SNAP).run, null, `${name}: not adopted later`);
    } else {
      // The run on A is dropped when the cycle ends (cycle-run.js finish), never authorizing B.
      assert.deepStrictEqual(w.h.finish('the entry did not adopt it').map(x => x.outcome), ['discarded']);
    }
  }
  const w = world({ key: 'A' });
  await w.h.tick();
  const got = w.h.take('A', 'review A', SNAP);
  assert.ok(got.run && typeof got.run.start === 'number');
  w.started[0].resolve({ ok: true, text: 'VERDICT: APPROVE - size 1' });
  assert.deepStrictEqual(await got.run.promise, { ok: true, text: 'VERDICT: APPROVE - size 1' });
  assert.ok(got.run.end() >= got.run.start);
  assert.strictEqual(w.started[0].signal.aborted, false);
  assert.deepStrictEqual(w.h.finish('done').map(x => x.outcome), ['adopted'], 'finish never stops the adopted run');
});

test('createOverlap: finish stops and discards every run not adopted, with why; after halt nothing starts (a poll in flight included); an unreadable record or no request starts nothing', async () => {
  const w = world({ key: 'A' });
  await w.h.tick();
  assert.deepStrictEqual(w.h.finish('the head trader did not end planned (no-trade)').map(x => [x.outcome, x.why]), [['discarded', 'the head trader did not end planned (no-trade)']]);
  assert.strictEqual(w.started[0].signal.aborted, true);
  w.set('B');
  await w.h.tick();
  assert.strictEqual(w.started.length, 1, 'halted: no new run');
  // A poll in flight when the run ends starts nothing.
  const v = world({ key: 'A' });
  const p = v.h.tick();
  v.h.halt();
  await p;
  assert.strictEqual(v.started.length, 0);
  for (const o of [{ latestThrows: true }, { noRequest: true }]) {
    const x = world({ key: 'A', ...o });
    await x.h.tick();
    assert.strictEqual(x.started.length, 0, JSON.stringify(o));
  }
  assert.throws(() => createOverlap({ latest: () => null, request: async () => null, start: async () => ({}), pollMs: 0, timers: noTimers }), /pollMs/);
});

test('createOverlap: blocked (the kill switch on) starts nothing and stops a running run, saying why; a check that throws blocks', async () => {
  let why = 'the kill switch is on';
  const started = [];
  const h = createOverlap({
    pollMs: 1, timers: noTimers, latest: () => 'A', request: async k => ({ request: `review ${k}`, snapshot: SNAP }), blocked: () => why,
    start: (request, signal) => { started.push(signal); return new Promise(() => {}); },
  });
  await h.tick();
  assert.strictEqual(started.length, 0);
  why = null;
  await h.tick();
  assert.strictEqual(started.length, 1);
  why = 'the kill switch is on';
  await h.tick();
  assert.strictEqual(started[0].aborted, true);
  assert.deepStrictEqual(h.summary().map(x => [x.outcome, x.why]), [['discarded', 'the kill switch is on']]);
  const t = createOverlap({ pollMs: 1, timers: noTimers, latest: () => 'A', request: async () => ({ request: 'r', snapshot: SNAP }), blocked: () => { throw new Error('unreadable'); }, start: () => { started.push(null); return new Promise(() => {}); } });
  await t.tick();
  assert.strictEqual(started.length, 1, 'a failing check blocks');
});
