'use strict';

// The broker's own bar fields as a briefing fact (trading/broker-fields.js): passed through untouched, the last 3
// bars', with no meaning given; causal; in the JSON in full and on one capped summary line.
const test = require('node:test');
const assert = require('node:assert');
const { brokerFieldsAt, brokerFieldsText, barFieldDocsOf, fieldPathsOf, LAST, MAX_BYTES, TEXT_MAX } = require('../../scripts/lib/trading/broker-fields');
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

// The server's own words for its bar fields (get_server_config barFields): printed verbatim, with the values as the server says
// to show them (a ratio to another value of the bar, rounded); nothing printed or invented when the server gives none.
const WORDS = { 'flow.windows.3.delta': { meaning: 'the 3-bar window\'s net signed volume, as a share of the bar volume', per: 'v', digits: 3 }, 'ext.b.flag': { meaning: 'a flag the server sets' }, 'flow.ofiTrade': { meaning: 'the bar\'s trade-based pressure, -1 to 1', digits: 2 } };

test('barFieldDocsOf: the valid entries as the server gave them; none given is none (never invented); a bad one is left out and says why', () => {
  assert.deepStrictEqual(barFieldDocsOf({}), { docs: null, dropped: [] });
  assert.deepStrictEqual(barFieldDocsOf(null), { docs: null, dropped: [] });
  assert.deepStrictEqual(barFieldDocsOf({ barFields: WORDS }), { docs: WORDS, dropped: [] });
  const r = barFieldDocsOf({ barFields: { ...WORDS, 'x.y': { meaning: '' }, 'x.z': { meaning: 'w'.repeat(TEXT_MAX + 1) } } });
  assert.deepStrictEqual(r.docs, WORDS);
  assert.strictEqual(r.dropped.length, 2);
  assert.match(r.dropped.join(), /x\.y: meaning/);
  assert.match(r.dropped.join(), new RegExp(`x\\.z: meaning is over ${TEXT_MAX} characters`));
  const many = Object.fromEntries(Array.from({ length: 9 }, (_x, k) => [`f.${k}`, { meaning: `m${k}` }]));
  const cut = barFieldDocsOf({ barFields: many });
  assert.strictEqual(Object.keys(cut.docs).length, require('../../scripts/lib/tunables').runner().prompt.brokerFieldsShown);
  assert.strictEqual(cut.dropped.length, 9 - Object.keys(cut.docs).length);
  assert.deepStrictEqual(barFieldDocsOf({ barFields: [] }).docs, null);
});

test('with the server\'s words: only the described fields, each with its meaning verbatim and its values as the server says; the raw line otherwise', () => {
  const bars = normalizeBars(BROKER.slice(0, 400));
  const i = bars.length - 1;
  const f = brokerFieldsAt(bars, i, { docs: WORDS });
  assert.deepStrictEqual(f.shown.map(s => s.path), ['flow.windows.3.delta', 'ext.b.flag', 'flow.ofiTrade']);
  const d = f.shown[0];
  assert.strictEqual(d.meaning, WORDS['flow.windows.3.delta'].meaning);
  d.values.forEach((x, k) => {
    const b = bars[i - 2 + k];
    const raw = b.flow.windows[3].delta;
    assert.strictEqual(x, raw === null ? null : Number((raw / b.v).toFixed(3)), `bar ${k}`);
  });
  assert.deepStrictEqual(f.shown[2].values, f.bars.map(b => (b.fields.flow.ofiTrade === null ? null : Number(b.fields.flow.ofiTrade.toFixed(2)))));
  assert.deepStrictEqual(f.shown[1].values, f.bars.map(b => b.fields.ext.b.flag));
  const line = brokerFieldsText(f);
  assert.ok(line.startsWith('- Broker bar fields as the broker describes them (last 3 bars, oldest first; the rest are in the JSON): flow.windows.3.delta per v '), line);
  assert.ok(line.includes(`(${WORDS['flow.ofiTrade'].meaning})`) && line.endsWith('.'));
  assert.doesNotMatch(line, /ext\.a|complete/, 'a field the server did not describe is not printed');
  // No words, or words for fields the bars do not carry: the line as before, nothing invented.
  assert.strictEqual(brokerFieldsAt(bars, i, { docs: null }).shown, undefined);
  assert.strictEqual(brokerFieldsAt(bars, i, { docs: { 'no.such': { meaning: 'm' } } }).shown, undefined);
  assert.deepStrictEqual(brokerFieldsAt(bars, i, { docs: null }), brokerFieldsAt(bars, i));
  assert.strictEqual(brokerFieldsText(brokerFieldsAt(bars, i, { docs: { 'no.such': { meaning: 'm' } } })), brokerFieldsText(brokerFieldsAt(bars, i)));
});

test('a ratio is shown only when both values are there: no volume, a zero volume or a value that is not a number gives null or the value as served', () => {
  const mk = (v, x) => ({ t: '2026-01-01T00:00:00Z', o: 1, h: 2, l: 0, c: 1, v, f: { x } });
  const docs = { 'f.x': { meaning: 'm', per: 'v', digits: 1 } };
  const at = (v, x) => brokerFieldsAt([mk(v, x)], 0, { last: 1, docs }).shown[0].values[0];
  assert.strictEqual(at(200, 50), 0.3);
  assert.strictEqual(at(200, -50), -0.3);
  assert.strictEqual(at(0, 5), null);
  assert.strictEqual(at(undefined, 5), null);
  assert.strictEqual(at(200, null), null);
  assert.strictEqual(at(200, 'n/a'), 'n/a');
  assert.strictEqual(at(3, true), true);
  // A tiny divisor never prints Infinity, and a divisor that is not above 0 gives no value.
  assert.strictEqual(at(1e-320, 1e10), null);
  assert.strictEqual(at(-200, 50), null);
  assert.strictEqual(at(5e-324, 1), null);
});

test('in the briefing: the summary line carries the server\'s words when given, in the JSON and the text; the other lines are unchanged', () => {
  const n = 400;
  const build = docs => B.buildBriefing({ symbol: 'MNQ', bars: BROKER.slice(0, n), minutes: 3, blackouts: { items: [] }, barFieldDocs: docs });
  const plain = build(null);
  const worded = build(WORDS);
  assert.deepStrictEqual(worded.sections.m3.data.brokerFields, brokerFieldsAt(normalizeBars(BROKER.slice(0, n)), n - 1, { docs: WORDS }));
  const now = new Date(worded.closedAt);
  const lines = B.renderBriefing({ ...worded, builtAt: plain.builtAt }, { now }).split('\n');
  const line = lines.find(l => l.startsWith('- Broker bar fields'));
  assert.strictEqual(line, brokerFieldsText(worded.sections.m3.data.brokerFields));
  assert.match(line, /describes them/);
  const base = B.renderBriefing(plain, { now }).split('\n');
  assert.deepStrictEqual(lines.filter(l => l !== line), base.filter(l => !l.startsWith('- Broker bar fields')));
});

test('wireRunner: the words the server gave (client.barFieldDocs) reach the briefing the runner writes; none given, the old line', async () => {
  const { wireRunner } = require('../../scripts/lib/runner-wiring');
  const { validateConfig } = require('../../scripts/lib/autotrader');
  const { tmpDir } = require('../helpers');
  const ROOT = require('path').resolve(__dirname, '..', '..');
  const bars = BROKER.slice(0, 400);
  const last = bars[bars.length - 1];
  const at = new Date(Date.parse(last.t) + 3 * 60000 + 2000);
  const run = async barFieldDocs => {
    const home = tmpDir();
    const client = { barFieldDocs, async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; }, async closedBars() { return bars; } };
    const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', trigger: 'bar' });
    const runner = wireRunner({ cfg, root: ROOT, home, env: { FTH_HOME: home }, client, dataDir: require('path').join(home, 'bars'), now: () => at, runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: require('path').join(home, 'STOP'), log: () => {}, event: () => {} });
    await runner.step();
    const b = B.readBriefing(home, 'MNQ');
    assert.ok(b, 'the runner wrote a briefing');
    return b.sections.m3.data.brokerFields;
  };
  const words = await run(WORDS);
  assert.deepStrictEqual(words.shown.map(s => s.path), Object.keys(WORDS));
  assert.strictEqual(words.shown[0].meaning, WORDS['flow.windows.3.delta'].meaning);
  assert.strictEqual((await run(null)).shown, undefined);
  assert.strictEqual((await run(undefined)).shown, undefined);
});
