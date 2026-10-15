'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/learning/lifecycle-record');
const { fromLifecycleRecord } = R;
const { record, tmpHome } = require('../fixtures/learning');

test('the adapter: the design\'s record to the loop\'s view (context, reads, plan, signatures)', () => {
  const r = R.fromLifecycleRecord(record());
  assert.strictEqual(r.root, 'MNQ');
  assert.strictEqual(r.side, 'long');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.context, { regime: 'trend-up', volatility: 'normal', window: 'ny-am', biasSide: 'with', alignment: 'aligned', dayType: 'normal' });
  assert.deepStrictEqual(r.plan, { entry: 100, stop: 98, target: 104, size: 1, rr: 2 });
  assert.strictEqual(r.signatures.skill, 'bias:bos-vs-choch+location:vwap-volume-profile+setup:rejection+entry:candle-reading+stop:invalidation+target:top-down-entry');
  assert.strictEqual(r.signatures.read, 'bias:1h-bos-up+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+stop:stop-15m-low+target:target-1h-swing');
  assert.strictEqual(r.reads[0].why, 'broke the last swing');
  assert.deepStrictEqual(R.CONTEXT_KEYS, ['regime', 'volatility', 'window', 'biasSide', 'alignment', 'dayType']);
});

test('the adapter: signatures are order-independent and price-free; the record\'s own win; flat fields and verification read', () => {
  const a = record();
  const b = { ...record({ stop: 97.25, target: 110 }), reads: record({ stop: 97.25, target: 110 }).reads.slice().reverse() };
  assert.strictEqual(R.fromLifecycleRecord(a).signatures.read, R.fromLifecycleRecord(b).signatures.read);
  assert.strictEqual(R.fromLifecycleRecord({ ...a, signatures: { skill: 'S', read: 'X' } }).signatures.read, 'X');
  assert.strictEqual(R.fromLifecycleRecord({ ...a, signature: 'Y' }).signatures.read, 'Y');
  const { plan: _p, ok: _o, ...flat } = a;
  const f = R.fromLifecycleRecord({ ...flat, entry: 50, stop: 49, target: 52, size: 2, verification: { ok: true, reasons: [] } });
  assert.deepStrictEqual([f.plan.entry, f.plan.stop, f.plan.target, f.plan.size, f.ok], [50, 49, 52, 2, true]);
  assert.strictEqual(R.fromLifecycleRecord({ ...a, context: { ...a.context, trendRule: 'Trend rule: short against the 1h trend' } }).context.biasSide, 'against');
  for (const bad of [null, [], { ...a, side: 'buy' }, { ...a, root: '' }, { ...a, bar: 'never' }]) assert.strictEqual(R.fromLifecycleRecord(bad), null);
  assert.strictEqual(R.fromLifecycleRecord({ ...a, ok: 'yes' }).ok, false, 'only true is verified');
});

test('readRecords: every root\'s file, oldest first, a torn line skipped; none: []', () => {
  const home = tmpHome();
  assert.deepStrictEqual(R.readRecords(home), []);
  fs.mkdirSync(R.recordsDir(home), { recursive: true });
  assert.strictEqual(R.recordsDir(home), path.join(home, 'trade-lifecycle'));
  fs.writeFileSync(path.join(R.recordsDir(home), 'MNQ.jsonl'), `${JSON.stringify(record({ at: '2023-03-15T14:06:00.000Z' }))}\n{torn\n`);
  fs.writeFileSync(path.join(R.recordsDir(home), 'MES.jsonl'), `${JSON.stringify(record({ root: 'MES' }))}\n`);
  fs.writeFileSync(path.join(R.recordsDir(home), 'notes.txt'), 'x');
  assert.deepStrictEqual(R.readRecords(home).map(r => r.root), ['MES', 'MNQ']);
});

test('the adapter reads the reads checker\'s field names: signature, skillSignature, trendSide, boolean checks, problems', () => {
  const a = record({ ok: false });
  const raw = { ...a, signatures: undefined, signature: 'bias:1h-bos-up', skillSignature: 'bias:bos-vs-choch', problems: ['a read is false'],
    context: { ...a.context, trendRule: undefined, trendSide: 'none' }, reads: a.reads.map((r, i) => ({ ...r, check: i !== 1 })) };
  delete raw.reasons;
  const r = fromLifecycleRecord(raw);
  assert.deepStrictEqual([r.signatures.read, r.signatures.skill, r.context.biasSide, r.reasons, r.reads[1].check, r.reads[0].check], ['bias:1h-bos-up', 'bias:bos-vs-choch', 'none', ['a read is false'], 'false', 'true']);
});

test('the adapter reads the record\'s plan objects (entry, stop, target with their price), its lane and contract; the run id from the run when absent', () => {
  const a = record();
  const raw = { ...a, schema: 1, lane: '3m', runId: undefined, plan: { entry: { type: 'limit', price: 100 }, stop: { source: '15m low', level: 98.25, price: 98, ticks: 8 }, target: { source: '1h swing', level: 104, price: 104, ticks: 16 }, rr: 2, size: 2, maxSize: 5 } };
  const r = fromLifecycleRecord(raw, { runId: 'run-x' });
  assert.deepStrictEqual([r.plan.entry, r.plan.stop, r.plan.target, r.plan.size, r.plan.rr, r.lane, r.contract, r.runId], [100, 98, 104, 2, 2, '3m', 'MNQ:2023-06', 'run-x']);
  assert.strictEqual(fromLifecycleRecord({ ...raw, plan: { ...raw.plan, entry: { limit: 99.75 } } }).plan.entry, 99.75);
  assert.strictEqual(fromLifecycleRecord({ ...raw, runId: 'own' }, { runId: 'run-x' }).runId, 'own');
});

test('the adapter keeps each read\'s normalized form (the record\'s, else the checker\'s parse), and the signature uses it', () => {
  const a = record();
  const spelled = { ...a, signatures: undefined, signature: undefined, reads: a.reads.map(r => (r.step === 'bias' ? { ...r, read: '60 min bos up' } : r.step === 'setup' ? { ...r, read: '15-min rejected prior VAH up' } : r)) };
  const r = fromLifecycleRecord(spelled);
  assert.deepStrictEqual(r.reads.slice(0, 3).map(x => x.form), ['1h bos up', 'at prior vah', '15m rejected prior vah up']);
  assert.strictEqual(r.signatures.read, fromLifecycleRecord({ ...a, signatures: undefined }).signatures.read, 'the same reads, however spelled');
  assert.strictEqual(fromLifecycleRecord({ ...a, reads: [{ step: 'bias', skill: 's', read: 'x', form: '1h up' }] }).reads[0].form, '1h up', 'the record\'s form first');
});
