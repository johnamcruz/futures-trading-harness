'use strict';

// The broker's own bar fields as a briefing fact (trading/broker-fields.js): passed through untouched, the last 3
// bars', with no meaning given; causal; in the JSON in full and on one capped summary line.
const test = require('node:test');
const assert = require('node:assert');
const { brokerFieldsAt, brokerFieldsText, fieldPathsOf, LAST, MAX_BYTES, TEXT_MAX } = require('../../scripts/lib/trading/broker-fields');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const B = require('../../scripts/lib/trading/briefing');
const G = require('../fixtures/golden-bars');

const S = G.SERIES.find(s => s.label === 'MNQ 3m');
const PLAIN = G.served(G.load(S));
const BROKER = G.served(G.broker(G.load(S)));

test('fieldPathsOf: the dotted paths to every value, sorted; arrays and nulls are values', () => {
  assert.deepStrictEqual(fieldPathsOf({ b: { y: 1, x: null }, a: [1, 2], c: { d: { e: true } } }), ['a', 'b.x', 'b.y', 'c.d.e']);
  assert.deepStrictEqual(fieldPathsOf(null), []);
});

test('the last 3 bars\' own fields as served, oldest first, a copy; none on the bars is null; a bar without them says so', () => {
  const bars = normalizeBars(BROKER.slice(0, 400));
  const i = bars.length - 1;
  const f = brokerFieldsAt(bars, i);
  assert.strictEqual(f.bars.length, LAST);
  assert.deepStrictEqual(f.bars.map(x => x.t), bars.slice(-3).map(x => x.t));
  for (const [k, x] of f.bars.entries()) assert.deepStrictEqual(x.fields, { flow: bars[i - 2 + k].flow, ext: bars[i - 2 + k].ext });
  assert.ok(f.paths.includes('flow.windows.3.delta') && f.paths.includes('ext.b.flag'), f.paths.join(', '));
  f.bars[2].fields.ext.a = 99;
  assert.notStrictEqual(bars[i].ext.a, 99, 'a copy: the bars are never changed');
  assert.strictEqual(brokerFieldsAt(normalizeBars(PLAIN.slice(0, 400)), 399), null);
  // Only one bar of the three carries fields: the others are null, never a guess.
  const mixed = normalizeBars([...PLAIN.slice(0, 398), BROKER[398], PLAIN[399]]);
  assert.deepStrictEqual(brokerFieldsAt(mixed, 399).bars.map(x => x.fields === null), [true, false, true]);
  // A broker's large field keeps only its size.
  const big = normalizeBars(PLAIN.slice(0, 10).map((b, k) => (k === 9 ? { ...b, depth: 'x'.repeat(MAX_BYTES) } : b)));
  assert.match(brokerFieldsAt(big, 9).bars[2].omitted, new RegExp(`over ${MAX_BYTES}`));
  assert.deepStrictEqual(brokerFieldsAt(big, 9).paths, []);
  assert.strictEqual(brokerFieldsAt(big, 10), null, 'no bar');
});

test('no look-ahead: the fields at a bar are the same with the later bars present or cut at its close', () => {
  const bars = normalizeBars(BROKER);
  for (let i = 0; i < bars.length; i += 37) assert.deepStrictEqual(brokerFieldsAt(bars, i), brokerFieldsAt(bars.slice(0, i + 1), i), `bar ${i}`);
});

test('the summary line: each path with its value on each bar, oldest first; capped, the rest counted; none without fields', () => {
  const f = brokerFieldsAt(normalizeBars(BROKER.slice(0, 400)), 399);
  const line = brokerFieldsText(f);
  assert.ok(line.startsWith('- Broker bar fields (last 3 bars, oldest first): ext.a '), line);
  assert.ok(Buffer.byteLength(line) <= TEXT_MAX, `${Buffer.byteLength(line)} bytes`);
  assert.match(line, /; \+\d+ more\.$/, 'the rest counted');
  const bars = f.bars.map(b => b.fields);
  assert.ok(line.includes(`ext.a ${bars.map(x => x.ext.a).join('/')}`));
  assert.strictEqual(brokerFieldsText(null), null);
  assert.strictEqual(brokerFieldsText({ paths: [], bars: [] }), null);
  // One field too long for the cap on its own: the count, never a cut value.
  const long = { paths: ['a'], bars: [{ t: '1', fields: { a: 'x'.repeat(400) } }] };
  assert.strictEqual(brokerFieldsText(long), '- Broker bar fields (last 1 bars, oldest first): 1 field, too long for this line; in the JSON.');
});

test('in the briefing: m3.brokerFields from the broker\'s bars, null without them; the text differs only by the summary line, within its cap', () => {
  const BROKER_FIELDS_JSON_MAX = 1000;
  let most = 0;
  for (let n = 200; n <= BROKER.length; n += 97) {
    const build = bars => B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, n), minutes: 3, blackouts: { items: [] } });
    const withF = build(BROKER);
    const without = build(PLAIN);
    const d = withF.sections.m3.data.brokerFields;
    assert.deepStrictEqual(d, brokerFieldsAt(normalizeBars(BROKER.slice(0, n)), n - 1));
    assert.strictEqual(without.sections.m3.data.brokerFields, null);
    const now = new Date(withF.closedAt);
    const lines = B.renderBriefing({ ...withF, builtAt: without.builtAt }, { now }).split('\n');
    const line = lines.find(l => l.startsWith('- Broker bar fields'));
    assert.strictEqual(line, brokerFieldsText(d));
    assert.strictEqual(lines.filter(l => l !== line).join('\n'), B.renderBriefing(without, { now }), `bar ${n - 1}: only the line differs`);
    assert.ok(Buffer.byteLength(line) <= TEXT_MAX);
    most = Math.max(most, Buffer.byteLength(JSON.stringify(d)));
  }
  assert.ok(most <= BROKER_FIELDS_JSON_MAX, `brokerFields is at most ${most} bytes of JSON`);
});
