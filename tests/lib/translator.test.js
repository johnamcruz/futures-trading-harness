'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseTicker, parseStandardName, isStandardName, createTranslator, standardRoot, canonicalName, TranslationError } = require('../../scripts/lib/broker/translator');
const fs = require('fs');
const { contractRoot, contractMonthTag, mayBeRoot } = require('../../scripts/lib/trading/journal');
const { FAKE_BROKERS, tmpDir } = require('../helpers');

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
  assert.ok(!isStandardName('fake:MNQ:Z26') && !isStandardName('mnq') && isStandardName('M2K'));
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
  await assert.rejects(() => t.toBroker('fake:MNQ:Z26'), TranslationError);
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
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: 'fake:MNQ:Z25' }), { contractId: 'fake:MNQ:Z25' });
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: '4471923' }), { contractId: '4471923' }, 'all digits: a broker id, not a name');
  await t.toBroker('MNQ');
  assert.deepStrictEqual(await t.translateArgs('close_position', { contractId: 'b-101' }), { contractId: 'b-101' }, 'a known broker id');
  assert.ok(isStandardName('6E') && !isStandardName('4471923'));
  assert.deepStrictEqual(parseTicker('6EZ6', NOW), { root: '6E', month: '2026-12' });
});

test('a failed search keeps results translatable by the month\'s own name, never by yesterday\'s front month (the root may mean another month today)', async () => {
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
  assert.strictEqual(await nextDay.toStandard('b-101'), 'MNQ:2026-12', 'yesterday\'s front month, by its month');
  assert.strictEqual(await nextDay.toBroker('MNQ:2026-12'), 'b-101', 'which translates back without a search');
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
  assert.strictEqual(calls.filter(c => c[0] === 'search_contracts').length, 2, 'one search per root, for its front month (a list never sets one)');
  await t.translateResult('list_open_positions', [{ contractId: 'b-301' }, { contractId: 'b-301' }]);
  assert.strictEqual(calls.filter(c => c[0] === 'get_contract').length, 0, 'a contract known not to be a ticker isn\'t looked up again');
});

test('mayBeRoot: an id the gate can\'t name may be on any contract; the translator\'s lookups name ids first', () => {
  assert.ok(mayBeRoot('MNQ', 'MNQ') && mayBeRoot('MNQ:2027-03', 'MNQ') && mayBeRoot(undefined, 'MNQ'));
  assert.ok(!mayBeRoot('MES', 'MNQ'));
  assert.ok(mayBeRoot('fake:XYZ:Z26', 'MNQ'));
  // A broker whose ids look like names (MNQZ5): its lookups decide, not the name's shape.
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'contracts-fake.json'), JSON.stringify({ ids: { MNQZ5: { root: 'MNQ', month: '2025-12' } }, front: {} }));
  const prev = process.env.FTH_HOME;
  const prevBrokers = process.env.FTH_BROKERS_FILE;
  process.env.FTH_HOME = home;
  process.env.FTH_BROKERS_FILE = FAKE_BROKERS;
  try {
    assert.strictEqual(contractRoot('MNQZ5'), 'MNQ');
    assert.ok(mayBeRoot('MNQZ5', 'MNQ') && !mayBeRoot('MNQZ5', 'MES'));
  } finally {
    if (prev === undefined) delete process.env.FTH_HOME;
    else process.env.FTH_HOME = prev;
    if (prevBrokers === undefined) delete process.env.FTH_BROKERS_FILE;
    else process.env.FTH_BROKERS_FILE = prevBrokers;
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

test('canonicalName: every name for a contract becomes its one standard name (the front month by its root), from the cache only', () => {
  const cache = {
    ids: { 'fake:MNQ:Z26': { root: 'MNQ', month: '2026-12' }, 'fake:MNQ:H27': { root: 'MNQ', month: '2027-03' } },
    front: { MNQ: { id: 'fake:MNQ:Z26', month: '2026-12', day: '2026-10-07' } },
  };
  const day = '2026-10-07';
  assert.strictEqual(canonicalName('MNQ', cache, day), 'MNQ');
  assert.strictEqual(canonicalName('MNQ:2026-12', cache, day), 'MNQ', 'the front month by its month');
  assert.strictEqual(canonicalName('fake:MNQ:Z26', cache, day), 'MNQ', 'the front month by the broker id');
  assert.strictEqual(canonicalName('fake:MNQ:H27', cache, day), 'MNQ:2027-03');
  assert.strictEqual(canonicalName('MNQ:2027-03', cache, day), 'MNQ:2027-03');
  assert.strictEqual(canonicalName('ES:2026-12', cache, day), 'ES:2026-12', 'no front month known: as given');
  assert.strictEqual(canonicalName('fake:XYZ', cache, day), 'fake:XYZ');
  assert.strictEqual(canonicalName(undefined, cache, day), undefined);
  // The next trading day (or no day given), before its own lookup: the cached front month names nothing, so a month
  // is never taken for whatever the root means after a roll.
  for (const other of ['2026-10-08', undefined]) {
    assert.strictEqual(canonicalName('MNQ:2026-12', cache, other), 'MNQ:2026-12');
    assert.strictEqual(canonicalName('fake:MNQ:Z26', cache, other), 'MNQ:2026-12');
    assert.strictEqual(canonicalName('MNQ', cache, other), 'MNQ', 'a root stays a root: it never matches a month');
  }
});

test('tick specs: each contract the broker describes records its root\'s tickSize and tickValue in the local file', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const { call } = fakeBroker();
  const t = createTranslator({ call, cacheFile, now: () => NOW });
  await t.toBroker('MNQ'); // search_contracts MNQ: the front month's spec is kept, not the later month's
  const { brokerSpecFor } = require('../../scripts/lib/trading/broker-specs');
  const mnq = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs.MNQ;
  assert.deepStrictEqual(mnq, { tickSize: 0.25, tickValue: 0.5, name: 'MNQZ6', description: null, id: 'b-101', active: true, readAt: NOW.toISOString() });
  assert.strictEqual(brokerSpecFor(cacheFile, 'MNQ').tickValue, 0.5);
  assert.strictEqual(brokerSpecFor(cacheFile, 'NQ'), null, 'NQ not described yet');
  // get_contract for an id first seen in a result records its root's spec too.
  await t.translateResult('list_open_positions', [{ contractId: 'b-201', size: 1 }]);
  assert.deepStrictEqual([brokerSpecFor(cacheFile, 'NQ').tickSize, brokerSpecFor(cacheFile, 'NQ').tickValue, brokerSpecFor(cacheFile, 'NQ').id], [0.25, 5, 'b-201']);
  // A contract with no ticker records nothing (b-301 has no specs either).
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs).sort(), ['MNQ', 'NQ']);
});

test('tick specs: a malformed reply records nothing and never replaces a good spec; an old file without specs still works', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  // A file from before specs: ids and front months only.
  fs.writeFileSync(cacheFile, JSON.stringify({ ids: { 'b-102': { root: 'MNQ', month: '2027-03' } }, front: { MNQ: { id: 'b-101', month: '2026-12', day: '2026-10-07' } } }));
  const bad = [
    { id: 'm-1', name: 'MESZ6', tickSize: 0.25, tickValue: 0, activeContract: true },
    { id: 'm-2', name: 'ESZ6', tickSize: -0.25, tickValue: 12.5, activeContract: true },
    { id: 'm-3', name: 'RTYZ6', tickSize: 0.1, tickValue: 5e9, activeContract: true },
    { id: 'm-4', name: 'YMZ6', tickSize: '1', tickValue: 'five', activeContract: true },
    { id: 'm-5', name: 'M2KZ6', activeContract: true },
  ];
  const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  let list = bad;
  const t = createTranslator({ call: async () => reply(list), cacheFile, now: () => NOW });
  assert.strictEqual(await t.toBroker('MNQ'), 'b-101', 'the old file\'s front month still translates');
  assert.strictEqual(await t.toBroker('MNQ:2027-03'), 'b-102');
  const named = await t.translateResult('search_contracts', bad);
  assert.deepStrictEqual(named.map(c => c.id), ['MES', 'ES', 'RTY', 'YM', 'M2K'], 'still translated: only the spec is dropped');
  const { brokerSpecFor } = require('../../scripts/lib/trading/broker-specs');
  for (const r of ['MES', 'ES', 'RTY', 'YM', 'M2K']) assert.strictEqual(brokerSpecFor(cacheFile, r), null, r);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs, {});
  // A good reply records; a later malformed one leaves it as it was.
  list = [{ id: 'm-1', name: 'MESZ6', tickSize: 0.25, tickValue: 1.25, activeContract: true }];
  await t.translateResult('search_contracts', list);
  assert.strictEqual(brokerSpecFor(cacheFile, 'MES').tickValue, 1.25);
  await t.translateResult('get_contract', { id: 'm-1', name: 'MESZ6', tickSize: 0.25, tickValue: 0 });
  assert.strictEqual(brokerSpecFor(cacheFile, 'MES').tickValue, 1.25);
  // A hand-edited, poisoned file is not believed by the reader either.
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  raw.specs.MES.tickValue = 0;
  fs.writeFileSync(cacheFile, JSON.stringify(raw));
  assert.strictEqual(brokerSpecFor(cacheFile, 'MES'), null);
});

test('tick specs: a spec that differs from the static table is said on stderr, once; the later read wins across processes', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const odd = [{ id: 'x-1', name: 'MNQZ6', tickSize: 0.25, tickValue: 2, activeContract: true }];
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = s => { writes.push(String(s)); return true; };
  try {
    const t = createTranslator({ call: async () => reply(odd), cacheFile, now: () => NOW });
    await t.translateResult('search_contracts', odd);
    await t.translateResult('search_contracts', odd);
  } finally {
    process.stderr.write = orig;
  }
  const said = writes.filter(w => /WARNING MNQ: the broker's tick spec \(0\.25 = \$2\.00\) differs from the static table/.test(w));
  assert.strictEqual(said.length, 1, writes.join(''));
  // An older read (another process) never replaces a newer one in the shared file.
  const older = createTranslator({ call: async () => reply([]), cacheFile, now: () => new Date(NOW.getTime() - 60000) });
  await older.translateResult('search_contracts', [{ id: 'x-1', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }]);
  assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs.MNQ.tickValue, 2);
  const newer = createTranslator({ call: async () => reply([]), cacheFile, now: () => new Date(NOW.getTime() + 60000) });
  await newer.translateResult('search_contracts', [{ id: 'x-1', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }]);
  assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs.MNQ.tickValue, 0.5);
});

test('server limits: each get_server_config answer records the server\'s maxOrderSize in the local file; the later read wins; a bad one records null', async () => {
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const { brokerOrderLimit } = require('../../scripts/lib/trading/broker-specs');
  assert.strictEqual(brokerOrderLimit(cacheFile).maxOrderSize, null, 'nothing recorded yet');
  assert.match(brokerOrderLimit(cacheFile).why, /not recorded yet: call get_server_config/);
  const t = createTranslator({ call: async () => { throw new Error('no lookups'); }, cacheFile, now: () => NOW });
  const answer = { tradingEnabled: true, maxOrderSize: 3, maxPositionSize: 5, serverTime: NOW.toISOString() };
  assert.deepStrictEqual(await t.translateResult('get_server_config', answer), answer, 'the answer passes through unchanged');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).server, { maxOrderSize: 3, readAt: NOW.toISOString() });
  assert.deepStrictEqual(brokerOrderLimit(cacheFile), { maxOrderSize: 3, readAt: NOW.toISOString() });
  // An older read in another process never replaces it; a newer one does.
  const older = createTranslator({ call: async () => null, cacheFile, now: () => new Date(NOW.getTime() - 60000) });
  await older.translateResult('get_server_config', { ...answer, maxOrderSize: 40 });
  assert.strictEqual(brokerOrderLimit(cacheFile).maxOrderSize, 3);
  // A malformed answer (a fraction, zero, a string, missing) is recorded as no limit: entries wait for a valid one.
  for (const [i, bad] of [1.5, 0, '3', undefined, -2].entries()) {
    const later = createTranslator({ call: async () => null, cacheFile, now: () => new Date(NOW.getTime() + (i + 1) * 60000) });
    await later.translateResult('get_server_config', { ...answer, maxOrderSize: bad });
    assert.strictEqual(brokerOrderLimit(cacheFile).maxOrderSize, null, JSON.stringify(bad));
    assert.match(brokerOrderLimit(cacheFile).why, /no valid maxOrderSize/);
  }
  // The contract ids, front months and specs in the file are kept.
  fs.writeFileSync(cacheFile, JSON.stringify({ ids: { 'b-1': { root: 'MNQ', month: '2026-12' } }, front: {}, specs: {} }));
  await createTranslator({ call: async () => null, cacheFile, now: () => NOW }).translateResult('get_server_config', answer);
  const file = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepStrictEqual([file.ids['b-1'].root, file.server.maxOrderSize], ['MNQ', 3]);
  // A hand-edited, poisoned file is not believed by the reader either.
  fs.writeFileSync(cacheFile, JSON.stringify({ ...file, server: { maxOrderSize: 2.5, readAt: NOW.toISOString() } }));
  assert.strictEqual(brokerOrderLimit(cacheFile).maxOrderSize, null);
  fs.writeFileSync(cacheFile, JSON.stringify({ ...file, server: [5] }));
  assert.match(brokerOrderLimit(cacheFile).why, /not recorded yet/);
  assert.strictEqual(brokerOrderLimit(null).maxOrderSize, null, 'no broker configured');
});

test('one search answer listing several months keeps its front month\'s spec, even when the clock moves while it is recorded', async () => {
  // A clock that ticks a millisecond on every read: the months of one answer must still share one read time.
  let t = NOW.getTime();
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const tr = createTranslator({ call: fakeBroker().call, cacheFile, now: () => new Date(t++) });
  await tr.toBroker('MNQ');
  const mnq = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).specs.MNQ;
  assert.deepStrictEqual([mnq.id, mnq.name, mnq.active], ['b-101', 'MNQZ6', true], 'the active month (listed first), not the March one after it');
  // Listed the other way round, the active month still wins.
  const reversed = path.join(tmpDir(), 'contracts-fake.json');
  const call = async (name, args) => (name === 'search_contracts'
    ? { content: [{ type: 'text', text: JSON.stringify(CONTRACTS.filter(c => c.name.includes(args.searchText)).reverse()) }] } : fakeBroker().call(name, args));
  await createTranslator({ call, cacheFile: reversed, now: () => new Date(t++) }).toBroker('MNQ');
  assert.strictEqual(JSON.parse(fs.readFileSync(reversed, 'utf8')).specs.MNQ.id, 'b-101');
  // The agent's own search answer, passed up through the translator after today's front month is known: the same.
  const own = path.join(tmpDir(), 'contracts-fake.json');
  const tr2 = createTranslator({ call: fakeBroker().call, cacheFile: own, now: () => new Date(t++) });
  await tr2.toBroker('MNQ');
  await tr2.translateResult('search_contracts', CONTRACTS.filter(c => c.name.includes('MNQ')));
  assert.strictEqual(JSON.parse(fs.readFileSync(own, 'utf8')).specs.MNQ.id, 'b-101');
});

test('replay day files: a day\'s file reads the broker ids its siblings recorded (never their front month, specs or limits), so a broker fault never leaves a position unnamed', async () => {
  const { readCache } = require('../../scripts/lib/broker/translator');
  const home = tmpDir();
  const file = d => path.join(home, `contracts-fake.${d}.json`);
  // An earlier day looked MNQ up: December was its front month. Today (2026-10-08, after the roll) nothing has yet.
  fs.writeFileSync(file('2026-10-07'), JSON.stringify({
    ids: { 'b-101': { root: 'MNQ', month: '2026-12' }, bad: { root: 7 } }, front: { MNQ: { id: 'b-101', month: '2026-12', day: '2026-10-07' } },
    specs: { MNQ: { tickSize: 0.25, tickValue: 0.5, readAt: '2026-10-07T13:00:00Z' } }, server: { maxOrderSize: 5, readAt: '2026-10-07T13:00:00Z' },
  }));
  fs.writeFileSync(path.join(home, 'contracts-fake.json'), JSON.stringify({ ids: { 'b-102': { root: 'MNQ', month: '2027-03' } }, front: {} }));
  fs.writeFileSync(path.join(home, 'contracts-other.2026-10-07.json'), JSON.stringify({ ids: { 'o-1': { root: 'ES', month: '2026-12' } } }));
  fs.writeFileSync(file('2026-10-06'), 'not json');
  const today = readCache(file('2026-10-08'));
  assert.deepStrictEqual(today, { ids: { 'b-101': { root: 'MNQ', month: '2026-12' }, 'b-102': { root: 'MNQ', month: '2027-03' } }, front: {}, specs: {}, server: null }, 'ids only: the day\'s own front month, specs and limits are none yet');
  assert.strictEqual(canonicalName('b-101', today), 'MNQ:2026-12', 'by its own month, never another day\'s front month');
  assert.strictEqual(canonicalName('MNQ:2026-12', today), 'MNQ:2026-12');
  // The broker is down today: positions are still named, by month; an order by that month goes to that contract.
  const down = async () => ({ content: [{ type: 'text', text: 'down' }], isError: true });
  const t = createTranslator({ call: down, cacheFile: file('2026-10-08'), now: () => new Date('2026-10-08T14:30:00Z') });
  assert.deepStrictEqual(await t.translateResult('list_open_positions', [{ contractId: 'b-101', size: 1 }]), [{ contractId: 'MNQ:2026-12', size: 1 }]);
  assert.strictEqual((await t.translateArgs('place_order', { contractId: 'MNQ:2026-12' })).contractId, 'b-101');
  await assert.rejects(() => t.toBroker('MNQ'), /down/, 'the front month is never taken from another day: not sent');
  // The day's own entries win over a sibling's; the live file and other brokers' files are not day files' business.
  fs.writeFileSync(file('2026-10-08'), JSON.stringify({ ids: { 'b-101': { root: 'MNQ', month: '2026-12' } }, front: { MNQ: { id: 'b-102', month: '2027-03', day: '2026-10-08' } } }));
  assert.strictEqual(readCache(file('2026-10-08')).front.MNQ.id, 'b-102');
  assert.strictEqual(canonicalName('b-102', readCache(file('2026-10-08')), '2026-10-08'), 'MNQ');
  assert.deepStrictEqual(Object.keys(readCache(path.join(home, 'contracts-fake.json')).ids), ['b-102'], 'the live file reads only its own');
  // A sibling's id of a month already over on the day (an expired contract) is not reused; this month's still is.
  fs.writeFileSync(file('2026-09-20'), JSON.stringify({ ids: { 'b-099': { root: 'MNQ', month: '2026-09' }, 'b-100': { root: 'MNQ', month: '2026-10' } } }));
  // A day more than 30 days away is not read at all (reads stay small however many days a home holds).
  fs.writeFileSync(file('2026-08-03'), JSON.stringify({ ids: { 'b-098': { root: 'MNQ', month: '2026-12' } } }));
  assert.ok(!readCache(file('2026-10-08')).ids['b-098']);
  assert.deepStrictEqual(readCache(file('2026-08-04')).ids['b-098'], { root: 'MNQ', month: '2026-12' }, 'near it: read');
  assert.ok(!readCache(file('2026-10-08')).ids['b-099'], 'September is over on 2026-10-08');
  assert.deepStrictEqual(readCache(file('2026-10-08')).ids['b-100'], { root: 'MNQ', month: '2026-10' });
  assert.deepStrictEqual(readCache(file('2026-09-21')).ids['b-099'], { root: 'MNQ', month: '2026-09' }, 'still live in September');
  // A sibling that disagrees about an id (a bad write): the day's own entry wins.
  fs.writeFileSync(file('2026-10-07'), JSON.stringify({ ids: { 'b-101': { root: 'MNQ', month: '2027-06' } } }));
  assert.deepStrictEqual(readCache(file('2026-10-08')).ids['b-101'], { root: 'MNQ', month: '2026-12' });
});

test('replay day files: a day file reads only its own, the live file and the days within 30 of it, however many days the home holds', () => {
  const { readCache } = require('../../scripts/lib/broker/translator');
  const home = tmpDir();
  const base = Date.parse('2024-01-01T00:00:00Z');
  for (let i = 0; i < 1000; i += 1) {
    const d = new Date(base + i * 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(home, `contracts-fake.${d}.json`), JSON.stringify({ ids: { [`b-${i}`]: { root: 'MNQ', month: '2030-12' } }, front: {} }));
  }
  fs.writeFileSync(path.join(home, 'contracts-fake.json'), JSON.stringify({ ids: { live: { root: 'MNQ', month: '2030-12' } } }));
  const read = fs.readFileSync;
  const files = [];
  fs.readFileSync = (f, ...a) => { files.push(path.basename(String(f))); return read(f, ...a); };
  let ids;
  try {
    ids = readCache(path.join(home, 'contracts-fake.2025-06-01.json')).ids;
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(files.length <= 63, `${files.length} files read`);
  const i = (Date.parse('2025-06-01T00:00:00Z') - base) / 86400000;
  assert.ok(ids[`b-${i - 30}`] && ids[`b-${i + 30}`] && ids.live, 'the days within 30 and the live file');
  assert.ok(!ids[`b-${i - 31}`] && !ids[`b-${i + 31}`], 'not the others');
});

test('the front month across a roll: refreshed from the broker\'s active contract when the one on file is another day\'s; fixed for the trading day, across processes; a month name always keeps its month', async () => {
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  // Yesterday the front month was December; today the broker marks March active.
  fs.writeFileSync(cacheFile, JSON.stringify({ ids: { 'b-101': { root: 'MNQ', month: '2026-12' }, 'b-102': { root: 'MNQ', month: '2027-03' } }, front: { MNQ: { id: 'b-101', month: '2026-12', day: '2026-10-06' } } }));
  const rolled = [{ ...CONTRACTS[0], activeContract: false }, { ...CONTRACTS[1], activeContract: true }];
  let list = rolled;
  const calls = [];
  const call = async (name, args) => {
    calls.push(name);
    if (name === 'search_contracts') return { content: [{ type: 'text', text: JSON.stringify(list.filter(c => c.name.includes(args.searchText))) }] };
    throw new Error(`unexpected ${name}`);
  };
  const t = createTranslator({ call, cacheFile, now: () => NOW });
  assert.strictEqual(await t.toBroker('MNQ:2026-12'), 'b-101', 'a month name never goes to the front month');
  assert.deepStrictEqual(calls, [], 'by its cached id: no lookup');
  // An agent's own search answer marks March active: today's front month, no lookup of its own.
  const listed = await t.translateResult('search_contracts', rolled);
  assert.deepStrictEqual(listed.map(c => c.id), ['MNQ:2026-12', 'MNQ']);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(readJson(cacheFile).front.MNQ, { id: 'b-102', month: '2027-03', day: '2026-10-07' });
  assert.strictEqual(await t.toBroker('MNQ'), 'b-102');
  // The broker's flag moves back later the same day: the day's front month stays (a name never changes meaning in a
  // session), in this process and in another one that looks it up afresh.
  list = CONTRACTS;
  await t.translateResult('search_contracts', CONTRACTS);
  assert.strictEqual(await t.toBroker('MNQ'), 'b-102');
  const other = createTranslator({ call, cacheFile, now: () => NOW });
  assert.strictEqual(await other.toBroker('MNQ'), 'b-102', 'adopted from the file: no lookup');
  assert.deepStrictEqual(calls, []);
  // A process that looked it up the same day before reading the file: the first one recorded wins for both.
  const raced = path.join(tmpDir(), 'contracts-fake.json');
  const late = createTranslator({ call, cacheFile: raced, now: () => NOW });
  fs.writeFileSync(raced, JSON.stringify({ ids: { 'b-102': { root: 'MNQ', month: '2027-03' } }, front: { MNQ: { id: 'b-102', month: '2027-03', day: '2026-10-07' } } }));
  await late.toBroker('MNQ:2026-12'); // a lookup by month (December active in this answer) never moves the day's front month
  assert.strictEqual(await late.toBroker('MNQ'), 'b-102');
  assert.strictEqual(readJson(raced).front.MNQ.id, 'b-102');
});

test('only a search_contracts answer sets the day\'s front month: a list_available_contracts marking every month active never does, nor a get_contract flagged active (the agent\'s or the translator\'s own)', async () => {
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const cacheFile = path.join(tmpDir(), 'contracts-fake.json');
  const ids = { 'b-101': { root: 'MNQ', month: '2026-12' }, 'b-102': { root: 'MNQ', month: '2027-03' } };
  fs.writeFileSync(cacheFile, JSON.stringify({ ids, front: { MNQ: { id: 'b-102', month: '2027-03', day: '2026-10-06' } } }));
  const down = async () => ({ content: [{ type: 'text', text: 'down' }], isError: true });
  const t = createTranslator({ call: down, cacheFile, now: () => NOW });
  // Every month marked active (the list's fields are not the interface's): the expiring month is never pinned.
  await t.translateResult('list_available_contracts', CONTRACTS.slice(0, 2).map(c => ({ ...c, activeContract: true })));
  assert.deepStrictEqual(readJson(cacheFile).front.MNQ, { id: 'b-102', month: '2027-03', day: '2026-10-06' });
  // A get_contract flagged active (a stale flag, or two months flagged during the roll) records the contract only.
  const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const june = { id: 'b-103', name: 'MNQM7', tickSize: 0.25, tickValue: 0.5, activeContract: true };
  const own = createTranslator({ call: async (name, a) => (name === 'get_contract' ? reply({ ...june, id: a.contractId }) : down()), cacheFile, now: () => NOW });
  assert.strictEqual(await own.toStandard('b-103'), 'MNQ:2027-06', 'the translator\'s own get_contract: named by its month');
  await own.translateResult('get_contract', june);
  assert.deepStrictEqual(readJson(cacheFile).front.MNQ, { id: 'b-102', month: '2027-03', day: '2026-10-06' }, 'March stays: the day\'s first search decides');
  assert.deepStrictEqual(readJson(cacheFile).ids['b-103'], { root: 'MNQ', month: '2027-06' }, 'recorded');
  // The day's first search answer sets it.
  await own.translateResult('search_contracts', [{ ...CONTRACTS[1], activeContract: true }, { ...CONTRACTS[0], activeContract: false }]);
  assert.deepStrictEqual(readJson(cacheFile).front.MNQ, { id: 'b-102', month: '2027-03', day: '2026-10-07' });
});

test('canonicalName and monthName take the front month from the id the root is sent to: a cache file whose front month contradicts its id merges no months', () => {
  const { monthName } = require('../../scripts/lib/broker/translator');
  const day = '2026-10-07';
  const ids = { 'b-101': { root: 'MNQ', month: '2026-12' }, 'b-102': { root: 'MNQ', month: '2027-03' } };
  // Says December, but the root is sent to the March id.
  const corrupt = { ids, front: { MNQ: { id: 'b-102', month: '2026-12', day } } };
  assert.strictEqual(canonicalName('MNQ:2026-12', corrupt, day), 'MNQ:2026-12');
  assert.strictEqual(canonicalName('MNQ:2027-03', corrupt, day), 'MNQ:2027-03');
  assert.strictEqual(canonicalName('b-102', corrupt, day), 'MNQ:2027-03');
  assert.strictEqual(monthName('MNQ', corrupt, day), 'MNQ', 'no month the root can be trusted to mean');
  // A front id the file doesn't know, or of another root: no front month.
  for (const front of [{ id: 'b-999', month: '2026-12', day }, { id: 'b-101', month: '2026-12', day, root: 'x' }]) {
    const c = { ids: front.root ? { 'b-101': { root: 'NQ', month: '2026-12' } } : ids, front: { MNQ: front } };
    assert.strictEqual(canonicalName('MNQ:2026-12', c, day), 'MNQ:2026-12');
  }
  // A consistent file: the root and its month are one name; monthName gives the month back.
  const good = { ids, front: { MNQ: { id: 'b-102', month: '2027-03', day } } };
  assert.strictEqual(canonicalName('MNQ:2027-03', good, day), 'MNQ');
  assert.deepStrictEqual(['MNQ', 'MNQ:2026-12', 'b-102', 'MNQ:2027-03', 'x-1'].map(n => monthName(n, good, day)), ['MNQ:2027-03', 'MNQ:2026-12', 'MNQ:2027-03', 'MNQ:2027-03', 'x-1']);
  assert.strictEqual(monthName('MNQ', good, '2026-10-08'), 'MNQ', 'another day: the root is unresolved');
});
