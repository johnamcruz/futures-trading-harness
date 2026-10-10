'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseTicker, parseStandardName, isStandardName, createTranslator, standardRoot, TranslationError } = require('../../scripts/lib/broker/translator');
const fs = require('fs');
const { contractRoot, contractMonthTag, mayBeRoot } = require('../../scripts/lib/trading/journal');
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

test('a broker id the translator could not name still goes through, so it can be closed', async () => {
  const { call } = fakeBroker();
  const t = createTranslator({ call, cacheFile: path.join(tmpDir(), 'c.json'), now: () => NOW });
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: 'CON.F.US.MNQ.Z25' }), { contractId: 'CON.F.US.MNQ.Z25' });
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: '4471923' }), { contractId: '4471923' }, 'all digits: a broker id, not a name');
  await t.toBroker('MNQ');
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: 'b-101' }), { contractId: 'b-101' }, 'a known broker id');
  assert.ok(isStandardName('6E') && !isStandardName('4471923'));
  assert.deepStrictEqual(parseTicker('6EZ6', NOW), { root: '6E', month: '2026-12' });
});

test('a failed search keeps results translatable: yesterday\'s front month, else the month\'s own name', async () => {
  const { call } = fakeBroker();
  let down = false;
  const flaky = async (name, args) => {
    if (down && name === 'search_contracts') return { content: [{ type: 'text', text: 'rate limited' }], isError: true };
    return call(name, args);
  };
  const t = createTranslator({ call: flaky, cacheFile: path.join(tmpDir(), 'c.json'), now: () => NOW });
  down = true;
  assert.strictEqual(await t.toStandard('b-102'), 'MNQ:2027-03');
  assert.strictEqual(await t.toBroker('MNQ:2027-03'), 'b-102', 'the month name translates back without a search');
  down = false;
  await t.toBroker('MNQ');
  const shared = path.join(tmpDir(), 'd.json');
  const later = createTranslator({ call: flaky, cacheFile: shared, now: () => new Date(NOW.getTime() + 86400000) });
  await later.toBroker('MNQ');
  down = true;
  const nextDay = createTranslator({ call: flaky, cacheFile: shared, now: () => new Date(NOW.getTime() + 2 * 86400000) });
  assert.strictEqual(await nextDay.toStandard('b-101'), 'MNQ', 'yesterday\'s front month');
});

test('two translators on one cache file keep each other\'s ids and agree on the front month', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const a = fakeBroker();
  const b = fakeBroker();
  const ta = createTranslator({ call: a.call, cacheFile, now: () => NOW });
  const tb = createTranslator({ call: b.call, cacheFile, now: () => NOW });
  await ta.toBroker('NQ');
  await tb.toBroker('MNQ:2027-03');
  assert.strictEqual(standardRoot('b-201', cacheFile), 'NQ', 'the first process\'s id survives the second\'s write');
  assert.strictEqual(standardRoot('b-102', cacheFile), 'MNQ');
  // The gateway adopts the front month the runner looked up today: no search of its own.
  const fresh = path.join(tmpDir(), 'contracts-fake.json');
  const gateway = createTranslator({ call: async () => { throw new Error('no lookups'); }, cacheFile: fresh, now: () => NOW });
  const runner = createTranslator({ call: fakeBroker().call, cacheFile: fresh, now: () => NOW });
  await runner.toBroker('MNQ');
  assert.strictEqual(await gateway.toBroker('MNQ'), 'b-101', 'read from the file the runner wrote after the gateway started');
});

test('contract lists are learned from their own tickers, one pass, no lookup per id', async () => {
  const { call, calls } = fakeBroker();
  const t = createTranslator({ call, cacheFile: path.join(tmpDir(), 'c.json'), now: () => NOW });
  const listed = await t.translateResult('list_available_contracts', CONTRACTS);
  assert.deepStrictEqual(listed.map(c => c.id), ['MNQ', 'MNQ:2027-03', 'NQ', 'b-301']);
  assert.strictEqual(calls.filter(c => c[0] === 'get_contract').length, 0);
  assert.strictEqual(calls.filter(c => c[0] === 'search_contracts').length, 2, 'one search per root, for its front month');
  await t.translateResult('list_open_positions', [{ contractId: 'b-301' }, { contractId: 'b-301' }]);
  assert.strictEqual(calls.filter(c => c[0] === 'get_contract').length, 0, 'a contract known not to be a ticker isn\'t looked up again');
});

test('mayBeRoot: an id the gate can\'t name may be on any contract; the translator\'s lookups name ids first', () => {
  assert.ok(mayBeRoot('MNQ', 'MNQ') && mayBeRoot('MNQ:2027-03', 'MNQ') && mayBeRoot(undefined, 'MNQ'));
  assert.ok(!mayBeRoot('MES', 'MNQ'));
  assert.ok(mayBeRoot('CON.F.US.XYZ.Z26', 'MNQ'));
  // A broker whose ids look like names (MNQZ5): its lookups decide, not the name's shape.
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'contracts-topstepx.json'), JSON.stringify({ ids: { MNQZ5: { root: 'MNQ', month: '2025-12' } }, front: {} }));
  const prev = process.env.FTH_HOME;
  process.env.FTH_HOME = home;
  try {
    assert.strictEqual(contractRoot('MNQZ5'), 'MNQ');
    assert.ok(mayBeRoot('MNQZ5', 'MNQ') && !mayBeRoot('MNQZ5', 'MES'));
  } finally {
    if (prev === undefined) delete process.env.FTH_HOME;
    else process.env.FTH_HOME = prev;
  }
});

test('a lower-case or padded name is refused with its standard form, not sent to the broker', async () => {
  const t = createTranslator({ call: fakeBroker().call, cacheFile: path.join(tmpDir(), 'c.json'), now: () => NOW });
  await assert.rejects(() => t.translateArgs('place_order', { contractId: 'mnq' }), /write it as MNQ/);
  await assert.rejects(() => t.translateArgs('place_order', { contractId: 'MNQ ' }), /write it as MNQ/);
  assert.strictEqual(parseTicker('1Z5', NOW), null, 'a root needs a letter');
  assert.strictEqual(parseTicker('ABCDEFGZ5', NOW), null, 'a root has at most 6 characters');
});

test('cache: a front month without a day is ignored; a cache that can\'t be written costs lookups, not answers', async () => {
  const dir = tmpDir();
  const cacheFile = path.join(dir, 'c.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ ids: {}, front: { MNQ: { id: 'b-102' } } }));
  const t = createTranslator({ call: fakeBroker().call, cacheFile, now: () => NOW });
  assert.strictEqual(await t.toBroker('MNQ'), 'b-101');
  const blocked = path.join(dir, 'file');
  fs.writeFileSync(blocked, '');
  const u = createTranslator({ call: fakeBroker().call, cacheFile: path.join(blocked, 'c.json'), now: () => NOW });
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual(await u.toBroker('MNQ'), 'b-101');
    assert.deepStrictEqual((await u.translateResult('list_open_positions', [{ contractId: 'b-102' }]))[0].contractId, 'MNQ:2027-03');
  } finally {
    process.stderr.write = write;
  }
});
