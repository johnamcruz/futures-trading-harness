'use strict';

// Golden regression: caching. The report cache (trading/report-cache.js) is keyed on the bar briefing's m15, h1
// and day versions, the symbols and their contracts, the account's facts, the trading day and phase 1's age:
// every component changed on its own must miss, and nothing else may (a broker's extra bar fields build the same
// briefing, so the same keys and hits). The contract translator's cache (broker/translator.js) keys the front
// month on the trading day of the harness clock: under a replay, the replayed date, never the wall clock -
// in the library and through the translator process (scripts/contract-translator.js) a replay runs.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { homeBrokers, tmpDir } = require('../helpers');
const RC = require('../../scripts/lib/trading/report-cache');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
const { createTranslator, readCache } = require('../../scripts/lib/broker/translator');
const { recordNow } = require('../../scripts/lib/trading/harness-now');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');

const MNQ = G.load(G.SERIES[0]);
const N = 1246; // MNQ bar 1246 (10:36 ET) and the next one, 10:39 ET: the same 15m candle
const briefAt = (bars, n, prev = null) => buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.slice(0, n), minutes: 3, prev, blackouts: { items: [] }, now: new Date(Date.parse(bars[n - 1].t) + 180000) });
const task = (role, report, [s, e]) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: `<task id="s" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`, time: { start: s, end: e } } } });
const dataLine = b => `Data: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ')}`;
const ACCT = { id: 7, balance: 50000, positions: [], orders: [], workingOrders: 0, attempts: [{ account: 'mini', status: 'active', balance: 50000, floor: 48000, profit: 0, dayPnl: 0, entryBlock: null }] };
const DAY = '2026-04-27';
const sym = (b, extra = {}) => [{ symbol: 'MNQ', bar: b.asOf, contractId: 'MNQ', ...extra }];

/** The cache after one cycle at bar N-1 (every analyst built on the briefing, phase 1 confirming the attempt), and the next bar's briefing. */
function recorded(bars) {
  const a = briefAt(bars, N);
  const b = briefAt(bars, N + 1, a);
  const output = [
    ...ANALYSTS.map((r, k) => task(r, `${dataLine(a)}\nBias: long`, [10, 20 + k])),
    task('risk-manager', 'Phase 1\nAttempt: mini active, cushion $2,000; budget $400', [10, 15]),
  ].join('\n');
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  return { a, b, cache };
}

const withSection = (b, part, version) => ({ ...b, sections: { ...b.sections, [part]: { ...b.sections[part], version } } });
const roles = s => (s.roles.length ? s.roles.map(r => (r === 'risk-manager' ? 'phase1' : r.replace('-analyst', ''))).join(', ') : 'none');

/** Each input the keys are built from, changed alone: what is served then. */
function components({ a, b, cache }) {
  // The cache as recorded on an account with a position and its working stop and target (phase 1 rests on it), for
  // each of their fields changed alone.
  const POS = { contractId: 'MNQ', type: 1, size: 2, averagePrice: 27400 };
  const STOP = { id: 9, contractId: 'MNQ', type: 4, side: 1, size: 2, stopPrice: 27390 };
  const LIMIT = { id: 10, contractId: 'MNQ', type: 1, side: 1, size: 2, limitPrice: 27420 };
  const OPEN = { ...ACCT, positions: [POS], orders: [STOP, LIMIT], workingOrders: 2 };
  const recordedOpen = { ...cache, phase1: { ...cache.phase1, account: RC.accountKey(OPEN) } };
  const open = over => serve({ cache: recordedOpen, account: { ...OPEN, ...over } });
  const soon = new Date(Date.parse(cache.at) + 3 * 60000);
  const serve = (over = {}) => RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon, ...over });
  const other = briefAt(MNQ, N + 4, b); // two bars into the next 15m candle
  return [
    ['the next bar, nothing changed (all hit)', serve()],
    ['the m15 version', serve({ briefings: { MNQ: withSection(b, 'm15', 'm15@2026-04-27T14:45:00.000Z') } })],
    ['the h1 version', serve({ briefings: { MNQ: withSection(b, 'h1', 'h1@2026-04-27T15:00:00.000Z') } })],
    ['the day version', serve({ briefings: { MNQ: withSection(b, 'day', 'day@2026-04-27T20:03:00.000Z') } })],
    ['a later bar in the next 15m candle', serve({ briefings: { MNQ: other }, symbols: sym(other) })],
    ['a briefing of another bar than the cycle\'s', serve({ briefings: { MNQ: a } })],
    ['no briefing', serve({ briefings: {} })],
    ['another contract (a roll)', serve({ symbols: sym(b, { contractId: 'MNQ:2026-09' }) })],
    ['another symbol set (two symbols)', serve({ symbols: [...sym(b), { symbol: 'MES', bar: b.asOf, contractId: 'MES' }] })],
    ['the balance', serve({ account: { ...ACCT, balance: 49950 } })],
    ['a position', serve({ account: { ...ACCT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 27400 }] } })],
    ['the position and orders the cache was recorded with (all hit)', open({})],
    ['only the position\'s average price', open({ positions: [{ ...POS, averagePrice: 27400.25 }] })],
    ['only the position\'s size', open({ positions: [{ ...POS, size: 1 }] })],
    ['only the stop order\'s stop price', open({ orders: [{ ...STOP, stopPrice: 27390.25 }, LIMIT] })],
    ['only the target order\'s limit price', open({ orders: [STOP, { ...LIMIT, limitPrice: 27420.25 }] })],
    ['only an order\'s size', open({ orders: [STOP, { ...LIMIT, size: 1 }] })],
    ['a working order', serve({ account: { ...ACCT, orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 27390 }] } })],
    ['the working-order count', serve({ account: { ...ACCT, workingOrders: 1 } })],
    ['the account id', serve({ account: { ...ACCT, id: 8 } })],
    ['the attempt\'s day P&L', serve({ account: { ...ACCT, attempts: [{ ...ACCT.attempts[0], dayPnl: -50 }] } })],
    ['the attempt\'s entry block', serve({ account: { ...ACCT, attempts: [{ ...ACCT.attempts[0], entryBlock: 'soft daily limit' }] } })],
    ['an account not read', serve({ account: { id: 7, error: 'HTTP 502' } })],
    ['the trading day', serve({ day: '2026-04-28' })],
    ['phase 1 at 29 minutes old', serve({ now: new Date(Date.parse(cache.at) + 29 * 60000) })],
    ['phase 1 at 30 minutes old', serve({ now: new Date(Date.parse(cache.at) + 30 * 60000) })],
    ['no clock', serve({ now: null })],
  ];
}

const keysText = cache => JSON.stringify({
  symbols: cache.symbols,
  analysts: Object.fromEntries(Object.entries(cache.analysts).map(([r, x]) => [r, x.versions])),
  phase1: cache.phase1 && { account: cache.phase1.account, day: cache.phase1.day },
}, null, 2);

test('report cache: each key component changed alone misses (only what rests on it); unchanged inputs hit; the keys are pinned', () => {
  const r = recorded(MNQ);
  const rows = components(r);
  const all = rows[0][1].roles;
  assert.deepStrictEqual(all, [...ANALYSTS, 'risk-manager'], 'nothing changed: every cached role is served');
  for (const [label, s] of rows.slice(1)) {
    if (label === 'phase 1 at 29 minutes old' || /\(all hit\)$/.test(label)) assert.deepStrictEqual(s.roles, all, label);
    else assert.ok(s.roles.length < all.length, `${label}: misses`);
  }
  assertGolden('report-cache-keys.txt', [
    'Recorded after the cycle at bar 1245 (keys):', keysText(r.cache),
    'Served on the next bar when one input changes:',
    ...rows.map(([label, s]) => `  ${label}: ${roles(s)}`),
  ].join('\n'));
});

test('report cache: a broker\'s extra bar fields build the same briefing, so the same keys and the same hits', () => {
  const plain = recorded(MNQ);
  const ext = recorded(G.withExt(MNQ));
  assert.deepStrictEqual(ext.a, plain.a, 'the briefing');
  assert.deepStrictEqual(ext.b, plain.b);
  assert.strictEqual(keysText(ext.cache), keysText(plain.cache));
  assert.deepStrictEqual(components(ext).map(([l, s]) => [l, s.roles]), components(plain).map(([l, s]) => [l, s.roles]));
});

// --- The contract translator's cache under a replay clock. ---

const CONTRACTS = [
  { id: 'r-1', name: 'MNQM6', tickSize: 0.25, tickValue: 0.5, activeContract: true },
  { id: 'r-2', name: 'MNQU6', tickSize: 0.25, tickValue: 0.5, activeContract: false },
];
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const FAKE_SERVER = path.join(G.ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

/** A harness home whose broker is a replay broker (sim), and its env at `replayNow`. */
function replayHome() {
  const home = tmpDir();
  const env = { HOME: home, FTH_HOME: home };
  homeBrokers(home, { sim: { command: [process.execPath, FAKE_SERVER], replay: true, journal: path.join(home, 'journal.jsonl') } }, { broker: 'sim', env });
  return { home, env };
}

test('translator cache: the front month is keyed on the replayed trading day, never the wall clock; a new replayed day looks it up again', async () => {
  const { home, env } = replayHome();
  const cacheFile = path.join(home, 'contracts-sim.json');
  const calls = [];
  const call = async (name, args) => { calls.push(name); return reply(name === 'search_contracts' ? CONTRACTS.filter(c => c.name.startsWith(args.searchText)) : CONTRACTS.find(c => c.id === args.contractId)); };
  const steps = [];
  const at = async (label, replayNow) => {
    const e = { ...env, FTH_REPLAY_NOW: replayNow };
    const before = calls.length;
    // A new translator each time, as each replay pass's process starts one over the same cache file.
    const t = createTranslator({ call, cacheFile, now: () => recordNow(e) });
    const id = await t.toBroker('MNQ');
    const front = readCache(cacheFile).front.MNQ;
    steps.push(`${label} (FTH_REPLAY_NOW ${replayNow}): MNQ -> ${id}, ${calls.length > before ? `lookup ${calls.slice(before).join(', ')}` : 'cache hit'}, front month keyed on ${front.day}`);
    return front;
  };
  const wallDay = tradingDayKey(new Date());
  const f1 = await at('first pass', '2026-06-02T14:00:00Z');
  assert.strictEqual(f1.day, '2026-06-02');
  assert.notStrictEqual(f1.day, wallDay, 'the replayed day, not the wall clock\'s');
  await at('same replayed day, later', '2026-06-02T19:30:00Z');
  await at('after the 18:00 ET open: the next trading day', '2026-06-02T22:05:00Z');
  await at('the next replayed day', '2026-06-03T14:00:00Z');
  await at('the next replayed day, later', '2026-06-03T19:30:00Z');
  assert.deepStrictEqual(steps.map(s => /cache hit/.test(s)), [false, true, false, true, true]);
  assertGolden('translator-replay-cache.txt', steps.join('\n'));
});

// Finding (not fixed here): the cache file keeps the front month of the LATEST trading day it has seen (mergeCache:
// "the later trading day wins"), which assumes the clock only moves forward. A replay that goes back to an earlier
// day over the same cache file (a rerun in a reused home) looks the front month up on every call and answers with
// the later day's front month, which is the wrong contract if a roll lies between the two days. Replay runs start in
// a fresh home (replay/driver.js seedRunHome) and move forward, so it doesn't bite today.
test('translator cache: a rerun of an earlier replayed day keys the front month on that day and hits after one lookup', { todo: 'the cache keeps the latest day\'s front month (mergeCache): an earlier replayed day re-searches on every call and answers with the later day\'s front month' }, async () => {
  const { home, env } = replayHome();
  const cacheFile = path.join(home, 'contracts-sim.json');
  const calls = [];
  const call = async (name, args) => { calls.push(name); return reply(CONTRACTS.filter(c => c.name.startsWith(args.searchText))); };
  const toBroker = replayNow => createTranslator({ call, cacheFile, now: () => recordNow({ ...env, FTH_REPLAY_NOW: replayNow }) }).toBroker('MNQ');
  await toBroker('2026-06-03T14:00:00Z');
  await toBroker('2026-06-02T14:00:00Z');
  const before = calls.length;
  await toBroker('2026-06-02T15:00:00Z');
  assert.strictEqual(calls.length, before, 'the same replayed day again: a cache hit');
  assert.strictEqual(readCache(cacheFile).front.MNQ.day, '2026-06-02');
});

test('translator process (scripts/contract-translator.js) under a replay clock keys its cache on the replayed day', () => {
  const { home, env } = replayHome();
  const run = replayNow => spawnSync(process.execPath, [path.join(G.ROOT, 'scripts', 'contract-translator.js'), '--broker', 'sim', '--', process.execPath, FAKE_SERVER], {
    env: { PATH: process.env.PATH, ...env, FTH_REPLAY_NOW: replayNow },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contract', arguments: { contractId: 'MNQ' } } })}\n`,
    encoding: 'utf8', timeout: 30000,
  });
  const r = run('2026-06-02T14:00:00Z');
  assert.strictEqual(r.status, 0, r.stderr);
  const cache = JSON.parse(fs.readFileSync(path.join(home, 'contracts-sim.json'), 'utf8'));
  assert.strictEqual(cache.front.MNQ.day, '2026-06-02', 'the replayed trading day');
  assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).id, 1);
  assert.strictEqual(run('2026-06-03T14:00:00Z').status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'contracts-sim.json'), 'utf8')).front.MNQ.day, '2026-06-03');
});
