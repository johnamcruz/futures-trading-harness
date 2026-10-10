'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseTicker, parseStandardName, isStandardName, createTranslator, standardRoot, TranslationError } = require('../../scripts/lib/broker/translator');
const { contractRoot, contractMonthTag } = require('../../scripts/lib/trading/journal');
const { tmpDir } = require('../helpers');

// A broker whose ids look nothing like the standard names: the translator learns them from its own answers.
const CONTRACTS = [
  { id: 'b-101', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true },
  { id: 'b-102', name: 'MNQH7', tickSize: 0.25, tickValue: 0.5, activeContract: false },
  { id: 'b-201', name: 'NQZ6', tickSize: 0.25, tickValue: 5, activeContract: true },
  { id: 'b-301', name: 'MNQ-OPT-123', activeContract: true },
];
function fakeBroker() {
  const calls = [];
  const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === 'search_contracts') return reply(CONTRACTS.filter(c => c.name.includes(args.searchText)));
    if (name === 'get_contract') {
      const c = CONTRACTS.find(x => x.id === args.contractId);
      return c ? reply(c) : { content: [{ type: 'text', text: 'not found' }], isError: true };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { call, calls };
}
const NOW = new Date('2026-10-07T14:00:00Z');

test('names: standard names (root, or root:YYYY-MM) and exchange tickers', () => {
  assert.deepStrictEqual(parseStandardName('MNQ'), { root: 'MNQ', month: null });
  assert.deepStrictEqual(parseStandardName('NQ:2026-03'), { root: 'NQ', month: '2026-03' });
  assert.strictEqual(parseStandardName('NQ:2026-13'), null);
  assert.ok(!isStandardName('CON.F.US.MNQ.Z26') && !isStandardName('mnq') && isStandardName('M2K'));
  assert.deepStrictEqual(parseTicker('MNQZ6', NOW), { root: 'MNQ', month: '2026-12' });
  assert.deepStrictEqual(parseTicker('NQH7', NOW), { root: 'NQ', month: '2027-03' });
  assert.deepStrictEqual(parseTicker('ESZ25', NOW), { root: 'ES', month: '2025-12' });
  assert.deepStrictEqual(parseTicker('M2KU6', NOW), { root: 'M2K', month: '2026-09' });
  assert.strictEqual(parseTicker('MNQ-OPT-123', NOW), null);
});

test('standard name -> the selected broker\'s id, and back, from that broker\'s own answers', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const { call, calls } = fakeBroker();
  const t = createTranslator({ call, cacheFile, now: () => NOW });
  assert.strictEqual(await t.toBroker('MNQ'), 'b-101', 'the front month: the one the broker marks active');
  assert.strictEqual(await t.toBroker('MNQ:2027-03'), 'b-102');
  assert.strictEqual(await t.toBroker('NQ'), 'b-201', 'a search for NQ also finds MNQ; only NQ tickers count');
  assert.strictEqual(await t.toStandard('b-101'), 'MNQ');
  assert.strictEqual(await t.toStandard('b-102'), 'MNQ:2027-03');
  assert.strictEqual(await t.toStandard('b-301'), 'b-301', 'not a futures ticker: left as is');
  await assert.rejects(() => t.toBroker('ES'), /no ES contract found at this broker/);
  await assert.rejects(() => t.toBroker('MNQ:2030-03'), /no MNQ contract for 2030-03/);
  await assert.rejects(() => t.toBroker('CON.F.US.MNQ.Z26'), TranslationError);
  // Cached for the trading day: no second search.
  const searches = calls.filter(c => c[0] === 'search_contracts').length;
  await t.toBroker('MNQ');
  assert.strictEqual(calls.filter(c => c[0] === 'search_contracts').length, searches);
  // Local readers (the gate, hooks) get the root of a broker id without a lookup.
  assert.strictEqual(standardRoot('b-201', cacheFile), 'NQ');
  assert.strictEqual(standardRoot('b-999', cacheFile), null);
});

test('an id first seen in a result is looked up with get_contract; tool args and results are translated', async () => {
  const { call, calls } = fakeBroker();
  const t = createTranslator({ call, cacheFile: path.join(tmpDir(), 'c.json'), now: () => NOW });
  const result = await t.translateResult('list_open_positions', [{ id: 1, contractId: 'b-102', size: 1 }, { id: 2, contractId: 'b-101', size: 2 }]);
  assert.deepStrictEqual(result.map(p => p.contractId), ['MNQ:2027-03', 'MNQ']);
  assert.ok(calls.some(c => c[0] === 'get_contract' && c[1].contractId === 'b-102'));
  // A contract tool's own ids are contract ids too; other ids aren't.
  const found = await t.translateResult('search_contracts', [CONTRACTS[0]]);
  assert.strictEqual(found[0].id, 'MNQ');
  assert.strictEqual((await t.translateResult('list_open_orders', [{ id: 'b-101', contractId: 'b-101' }]))[0].id, 'b-101');
  assert.deepStrictEqual(await t.translateArgs('place_order', { contractId: 'NQ', size: 1 }), { contractId: 'b-201', size: 1 });
  // The journal keeps the agent's own names.
  assert.deepStrictEqual(await t.translateArgs('journal_add', { contractId: 'NQ' }), { contractId: 'NQ' });
});

test('the front month is looked up again on a new trading day, and per broker', async () => {
  let now = NOW;
  const a = fakeBroker();
  const fileA = path.join(tmpDir(), 'contracts-a.json');
  const t = createTranslator({ call: a.call, cacheFile: fileA, now: () => now });
  await t.toBroker('MNQ');
  now = new Date('2026-10-08T22:30:00Z'); // after 17:00 CT: the next trading day
  await t.toBroker('MNQ');
  assert.strictEqual(a.calls.filter(c => c[0] === 'search_contracts').length, 2);
  // Another broker's translator has its own file and its own ids.
  assert.strictEqual(standardRoot('b-101', path.join(tmpDir(), 'contracts-b.json')), null);
});

test('the harness reads roots and months from standard names', () => {
  assert.deepStrictEqual([contractRoot('NQ:2026-03'), contractRoot('MNQ'), contractMonthTag('NQ:2026-03'), contractMonthTag('MNQ')], ['NQ', 'MNQ', '2026-03', '']);
  assert.strictEqual(contractRoot('unknown.id'), 'UNKNOWN.ID', 'an unknown id matches no strategy');
});
