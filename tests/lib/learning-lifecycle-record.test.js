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
  assert.strictEqual(r.signatures.read, 'bias:1h-bos-up+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+stop:stop-15m-low+target:target-60m-swing');
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
