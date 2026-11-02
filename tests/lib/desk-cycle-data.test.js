'use strict';

// The desk's pre-collected reads and the cycle's store (scripts/lib/cycle-data.js createStore, collectDesk; the runner
// config's cycleDataInPrompt, Claude Code only), and the desk's brief reports (deskBriefReports): every read made once a
// cycle in the runner's store and handed to each role that reads it, byte for byte the tool's own output; the read-data
// check credits a role only from the runner's own record for that role; the brief instruction leaves every consumer of
// a desk report satisfied by a minimal valid report.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CD = require('../../scripts/lib/cycle-data');
const B = require('../../scripts/lib/trading/briefing');
const RC = require('../../scripts/lib/trading/report-cache');
const RR = require('../../scripts/lib/trading/runner-roles');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { callTool } = require('../../scripts/lib/harness-tools/protocol');
const { validateConfig, childEnv, prompts } = require('../../scripts/lib/autotrader');
const { CHECKS, collectedFor } = require('../../scripts/lib/orchestrate/checks');
const { REQUESTS, BRIEF } = require('../../scripts/lib/orchestrate/requests');
const { deskFor } = require('../../scripts/lib/runner-wiring');
const { openAdapter } = require('../../scripts/lib/broker/adapter');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const exchange = require('../fixtures/mock-exchange');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
const ROLES = [...ANALYSTS, 'risk-manager'];
const ON = (o = {}) => validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], cycleDataInPrompt: true, ...o });

/** A harness home with this bar's briefing; the cycle's context (as runner.js gives the desk) and its roles' environment. */
function home({ bar = null, extra = {} } = {}) {
  const h = tmpDir();
  const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1300), minutes: 3, roundSteps: defaultRoundSteps() });
  B.writeBriefing(h, b);
  const base = { FTH_HOME: h, HOME: h, NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt, ...extra };
  const context = { action: 'trade', manageOnly: false, cachedRoles: [], symbols: [{ symbol: 'MNQ', bar: { t: bar || b.asOf, contractId: 'MNQ', file: '/b.json' } }] };
  const env = childEnv(ON(), ROOT, base, context);
  return { h, b, base, context, env };
}

/** A broker that answers every read with its name and arguments, counting them. */
function countingBroker(over = {}) {
  const calls = [];
  return { calls, readText: async (t, a) => { calls.push([t, a]); return over[t] ? over[t](a) : { text: `${t} ${JSON.stringify(a)}`, isError: false }; } };
}
const countingTool = () => {
  const calls = [];
  const fn = async (n, a, o) => { calls.push([n, a]); return callTool(n, a, o); };
  fn.calls = calls;
  return fn;
};

test('the desk\'s reads are each role\'s agent body\'s, with its arguments; the primary read is the briefing or the account snapshot', () => {
  const o = { symbol: 'MNQ', contractId: 'MNQ', accountId: 7, since: '2026-04-26T22:00:00.000Z' };
  const reads = r => CD.deskReads(r, o).map(x => `${x.tool} ${JSON.stringify(x.args)}`);
  assert.deepStrictEqual(reads('market-structure-analyst'), ['bar_briefing {"symbol":"MNQ"}', 'strategies_list {}']);
  assert.deepStrictEqual(reads('trend-momentum-analyst'), ['bar_briefing {"symbol":"MNQ"}']);
  assert.deepStrictEqual(reads('volume-liquidity-analyst'), ['bar_briefing {"symbol":"MNQ"}', 'get_quote {"contractId":"MNQ"}']);
  assert.deepStrictEqual(reads('risk-manager'), ['get_server_config {}', 'list_accounts {}', 'get_account_snapshot {"accountId":7}', 'journal_read {"kind":"review","since":"2026-04-26T22:00:00.000Z"}', 'lessons {"kind":"lesson"}', 'combine_status {}']);
  assert.deepStrictEqual(CD.deskReads('risk-manager', { symbol: 'MNQ', since: o.since }).map(x => x.tool), ['get_server_config', 'list_accounts', 'journal_read', 'lessons', 'combine_status'], 'no account: no snapshot');
  assert.deepStrictEqual(CD.deskReads('trade-executor', o), []);
  // Each body names them (agents/*.md): the reads are its own, never ones it doesn't make.
  const body = n => fs.readFileSync(path.join(ROOT, 'agents', `${n}.md`), 'utf8');
  for (const r of ROLES) for (const x of CD.deskReads(r, o)) assert.ok(body(r).includes(`\`${x.tool}`), `${r}: ${x.tool}`);
  assert.match(body('risk-manager'), /`journal_read` today's `review` entries[^]*The harness tool `lessons`: advice, with its record\./);
});

test('the store: one read per key per cycle, a read several roles share made once; the head trader takes the same entry, the account read again', async () => {
  const w = home();
  const tool = countingTool();
  const broker = countingBroker();
  const store = CD.createStore({ root: ROOT, broker, callTool: tool, now: () => new Date(w.b.closedAt) });
  const since = '2026-04-26T22:00:00.000Z';
  const desk = await CD.collectDesk({ roles: ROLES, symbol: 'MNQ', contractId: 'MNQ', accountId: 7, env: w.env, store, since });
  // One bar_briefing for the three analysts; every key once.
  assert.deepStrictEqual(tool.calls.filter(c => c[0] === 'bar_briefing').length, 1);
  assert.deepStrictEqual(tool.calls.map(c => c[0]).sort(), ['bar_briefing', 'combine_status', 'lessons', 'strategies_list']);
  assert.deepStrictEqual(broker.calls.map(c => c[0]), ['get_quote', 'get_server_config', 'list_accounts', 'get_account_snapshot', 'journal_read']);
  assert.strictEqual(store.made, 9);
  for (const r of ROLES) assert.strictEqual(desk[r].primaryOk, true, r);
  const brief = r => desk[r].blocks.find(b => b.tool === 'bar_briefing');
  assert.ok(ANALYSTS.every(r => brief(r) && brief(r).text === brief(ANALYSTS[0]).text));
  // Filled again for the same keys: nothing read again.
  await CD.collectDesk({ roles: ROLES, symbol: 'MNQ', contractId: 'MNQ', accountId: 7, env: w.env, store, since });
  assert.strictEqual(store.made, 9);
  // The head trader (its own run's environment: the same cycle's, its own variables apart): the briefing from the same
  // entry (no read made, the same sha); the account, its positions and its orders read again (they change with fills).
  const headEnv = childEnv(ON(), ROOT, w.base, { ...w.context, cachedRoles: ['risk-manager'], rolesFile: '/r.json', cycleId: '0123456789abcdef' });
  assert.strictEqual(CD.cycleOf(headEnv), store.cycle, 'the head trader\'s run is the same cycle\'s');
  const head = await CD.collect({ symbols: ['MNQ'], accountId: 7, env: headEnv, root: ROOT, store });
  assert.strictEqual(tool.calls.filter(c => c[0] === 'bar_briefing').length, 1, 'the briefing not read again');
  assert.strictEqual(CD.sha256(head.blocks[0].text), CD.sha256(brief('trend-momentum-analyst').text));
  assert.strictEqual(head.blocks[0].text, brief('market-structure-analyst').text);
  assert.deepStrictEqual(broker.calls.slice(5).map(c => c[0]), [...CD.READS], 'the account\'s reads made again for the head trader');
  assert.strictEqual(broker.calls.filter(c => c[0] === 'get_account_snapshot').length, 2);
  // In one fill a key read once, whatever its arguments' order.
  const s2 = CD.createStore({ root: ROOT, broker: countingBroker(), callTool: countingTool() });
  const got = await s2.fill([{ tool: 'journal_read', args: { kind: 'review', limit: 5 } }, { tool: 'journal_read', args: { limit: 5, kind: 'review' } }], { env: w.env });
  assert.strictEqual(s2.made, 1);
  assert.strictEqual(got[0], got[1]);
});

test('a store of another cycle is never used: its fill is refused, the head trader reads its own, the desk gets no block and no credit', async () => {
  const w = home();
  const other = home();
  const tool = countingTool();
  const store = CD.createStore({ root: ROOT, broker: countingBroker(), callTool: tool });
  await CD.collectDesk({ roles: ['trend-momentum-analyst'], symbol: 'MNQ', env: w.env, store });
  const made = store.made;
  assert.strictEqual(store.fill([{ tool: 'bar_briefing', args: { symbol: 'MNQ' } }], { env: other.env }), null);
  assert.strictEqual(store.matches(other.env), false);
  // The next bar's cycle in the same home: another cycle too.
  const next = childEnv(ON(), ROOT, w.base, { ...w.context, symbols: [{ symbol: 'MNQ', bar: { t: BARS[1300].t, contractId: 'MNQ' } }] });
  assert.strictEqual(store.matches(next), false);
  const head = await CD.collect({ symbols: ['MNQ'], env: other.env, root: ROOT, store, callTool: tool });
  assert.strictEqual(store.made, made, 'nothing read into the other cycle\'s store');
  assert.strictEqual(head.blocks[0].text, (await callTool('bar_briefing', { symbol: 'MNQ' }, { env: other.env, root: ROOT })).content[0].text, 'its own read');
  const d = await CD.collectDesk({ roles: ['trend-momentum-analyst'], symbol: 'MNQ', env: other.env, store });
  assert.deepStrictEqual([d['trend-momentum-analyst'].blocks, d['trend-momentum-analyst'].primaryOk], [[], false]);
  assert.match(CD.deskText('trend-momentum-analyst', d['trend-momentum-analyst']), /could not be made \(the cycle's store is another cycle's\): make your reads yourself/);
  // No store at all: the same.
  assert.strictEqual((await CD.collectDesk({ roles: ['risk-manager'], symbol: 'MNQ', env: w.env, store: null }))['risk-manager'].primaryOk, false);
});

test('byte identity: each desk block is exactly its tool\'s output with that role\'s own run\'s environment (harness tools) and the gateway\'s passthrough (broker reads)', async () => {
  const h = tmpDir();
  recordBrokerSpecs(h, { broker: 'mock', roots: ['MNQ', 'NQ', 'MES', 'ES'] });
  const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1300), minutes: 3, roundSteps: defaultRoundSteps() });
  B.writeBriefing(h, b);
  const state = path.join(h, 'exchange.json');
  const journal = path.join(h, 'journal.jsonl');
  // Yesterday's end-of-day restriction (advice now, with its record), another run's lesson stamped after the harness
  // clock (a later replay or the live account in the same journal: never this run's), and today's lesson.
  const yesterday = new Date(Date.parse(b.closedAt) - 86400000).toISOString();
  const later = '2099-01-02T15:00:00.000Z';
  fs.writeFileSync(journal, `${JSON.stringify({ ts: yesterday, kind: 'lesson', text: 'Rule: no long entries until the restriction is lifted in the journal' })}\n${JSON.stringify({ ts: later, kind: 'lesson', text: 'another run: skip shorts until lifted' })}\n${JSON.stringify({ ts: b.closedAt, kind: 'review', text: 'a loss' })}\n${JSON.stringify({ ts: b.closedAt, kind: 'lesson', text: 'wait for the close' })}\n`);
  fs.writeFileSync(path.join(h, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: [process.execPath, SERVER], journal, allowedAccountsEnv: 'MOCK_ALLOWED_ACCOUNTS' } } }));
  exchange.initState(state, { nowMs: Date.parse(b.closedAt) });
  const base = { PATH: process.env.PATH, HOME: h, FTH_HOME: h, MOCK_STATE: state, MOCK_JOURNAL: journal, MOCK_ALLOWED_ACCOUNTS: '7', NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt, FTH_GATE_LOG: path.join(h, 'gate.jsonl'), FTH_KILL_SWITCH_FILE: path.join(h, 'STOP') };
  const context = { action: 'trade', manageOnly: false, cachedRoles: [], symbols: [{ symbol: 'MNQ', bar: { t: b.asOf, contractId: 'MNQ' } }] };
  const cfg = ON();
  const adapter = openAdapter({ root: ROOT, env: base, timeoutMs: 20000 });
  const gw = createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js')], env: base, cwd: ROOT, timeoutMs: 20000 });
  try {
    const store = CD.createStore({ root: ROOT, broker: adapter, now: () => new Date(b.closedAt) });
    const since = require('../../scripts/lib/trading/clock').tradingDayStart(new Date(b.closedAt)).toISOString();
    const desk = await CD.collectDesk({ roles: ROLES, symbol: 'MNQ', contractId: 'MNQ', accountId: 7, env: childEnv(cfg, ROOT, base, context), store, since });
    for (const role of ROLES) {
      assert.deepStrictEqual(desk[role].missing, [], role);
      // The role's own run's environment (cycle-run.js runRole: the context with its role).
      const roleEnv = childEnv(cfg, ROOT, base, { ...context, roleRun: role });
      for (const blk of desk[role].blocks) {
        const raw = ['bar_briefing', 'strategies_list', 'combine_status', 'lessons'].includes(blk.tool)
          ? await callTool(blk.tool, blk.args, { env: roleEnv, root: ROOT })
          : await gw.request('tools/call', { name: blk.tool, arguments: blk.args });
        assert.strictEqual(raw.content.length, 1, `${role} ${blk.tool}`);
        assert.strictEqual(blk.text, raw.content[0].text, `${role} ${blk.tool} ${JSON.stringify(blk.args)}`);
        // In its request: the body between the block's header and footer is that text.
        const req = REQUESTS.desk(role, { symbol: 'MNQ', contractId: 'MNQ', at: b.closedAt, timeframe: 3, precollected: desk });
        assert.ok(req.includes(`\n--- ${blk.tool} ${JSON.stringify(blk.args)} as of ${blk.asOf} ---\n${raw.content[0].text}\n--- end of ${blk.tool} ${JSON.stringify(blk.args)} (sha256 ${CD.sha256(raw.content[0].text)}) ---`), `${role} ${blk.tool} in its request`);
      }
    }
    const lessonsText = desk['risk-manager'].blocks.find(x => x.tool === 'lessons').text;
    assert.match(lessonsText, /lesson from \d{4}-\d{2}-\d{2} \([^)]*\): advice, weigh it: wait for the close/);
    // The earlier day's restriction only as advice with its record, flagged broad; another run's later lesson in no
    // role's reads; no raw journal lesson in any.
    assert.match(lessonsText, /lesson from \d{4}-\d{2}-\d{2} \([^)]*broad[^)]*\): advice, weigh it: Rule: no long entries until the restriction is lifted/);
    for (const role of ROLES) assert.ok(desk[role].blocks.every(x => !/another run/.test(x.text) && !(x.tool === 'journal_read' && /restriction is lifted/.test(x.text))), role);
    assert.doesNotMatch(desk['risk-manager'].blocks.find(x => x.args.kind === 'review').text, /wait for the close/);
    // journal_read is the journal's one read: readText sends it; journal_add (a write) never.
    await assert.rejects(adapter.readText('journal_add', { kind: 'lesson', text: 'x' }), /not a read of the broker interface/);
    assert.strictEqual(fs.readFileSync(journal, 'utf8').trim().split('\n').length, 4);
  } finally {
    adapter.close();
    gw.close();
  }
});

test('read-data: credit only from the runner\'s own ok record for that role; never another role\'s, a failed read, another bar\'s briefing or the request', async () => {
  const rd = CHECKS['read-data'];
  const none = { text: 'Data: bar_briefing m3@x', tools: [] };
  const own = role => ({ precollected: { [role]: { blocks: [{ tool: 'bar_briefing' }], missing: [], primaryOk: true } } });
  for (const role of ROLES) {
    assert.strictEqual(rd(role, none, {}), 'read no data', `${role}: [] tools, no record`);
    assert.strictEqual(rd(role, none, undefined), 'read no data');
    assert.strictEqual(rd(role, none, own(role)), null, `${role}: its own ok record`);
    const otherRole = ROLES.find(r => r !== role);
    assert.strictEqual(rd(role, none, own(otherRole)), 'read no data', `${role}: another role's record`);
    for (const v of [false, 'true', 1, null, undefined]) assert.strictEqual(rd(role, none, { precollected: { [role]: { blocks: [], primaryOk: v } } }), 'read no data', `${role} primaryOk ${v}`);
    // Its own read still counts, with or without a record (as before).
    assert.strictEqual(rd(role, { tools: ['harness_bar_briefing'] }, {}), null);
  }
  // An inherited record (a prototype's) is no record of the role's.
  assert.strictEqual(collectedFor('risk-manager', { precollected: Object.create({ 'risk-manager': { primaryOk: true } }) }), false);
  // Through the collection: a failed broker read gives phase 1 no credit; another bar's briefing gives no analyst any.
  const w = home();
  const failed = await CD.collectDesk({ roles: ROLES, symbol: 'MNQ', contractId: 'MNQ', accountId: 7, env: w.env, store: CD.createStore({ root: ROOT, broker: countingBroker({ get_account_snapshot: () => ({ text: 'denied', isError: true }) }) }) });
  assert.strictEqual(failed['risk-manager'].primaryOk, false);
  assert.strictEqual(rd('risk-manager', none, { precollected: failed }), 'read no data');
  assert.match(CD.deskText('risk-manager', failed['risk-manager']), /Not collected: get_account_snapshot \{"accountId":7\} \(the broker answered with an error \(denied\)\); read it yourself if you need it\./);
  for (const r of ANALYSTS) assert.strictEqual(rd(r, none, { precollected: failed }), null, `${r}: its briefing was read`);
  // A throw, and no raw read, the same.
  for (const broker of [countingBroker({ get_account_snapshot: () => Promise.reject(new Error('gone')) }), {}]) {
    const d = await CD.collectDesk({ roles: ['risk-manager'], symbol: 'MNQ', accountId: 7, env: w.env, store: CD.createStore({ root: ROOT, broker }) });
    assert.strictEqual(rd('risk-manager', none, { precollected: d }), 'read no data');
  }
  // No account in the runner config: no snapshot, a line, no credit.
  const noAcct = await CD.collectDesk({ roles: ['risk-manager'], symbol: 'MNQ', env: w.env, store: CD.createStore({ root: ROOT, broker: countingBroker() }) });
  assert.strictEqual(noAcct['risk-manager'].primaryOk, false);
  assert.match(CD.deskText('risk-manager', noAcct['risk-manager']), /Not collected: get_account_snapshot \{\} \(no account in the runner config\); read it yourself/);
  const stale = home({ bar: BARS[1300].t });
  const old = await CD.collectDesk({ roles: ROLES, symbol: 'MNQ', contractId: 'MNQ', accountId: 7, env: stale.env, store: CD.createStore({ root: ROOT, broker: countingBroker() }) });
  for (const r of ANALYSTS) {
    assert.strictEqual(old[r].primaryOk, false, r);
    assert.strictEqual(rd(r, none, { precollected: old }), 'read no data', `${r}: another bar's briefing`);
    assert.match(CD.deskText(r, old[r]), /Not collected: bar_briefing \{"symbol":"MNQ"\} \(the briefing is of the bar opened .*not this cycle's.*\); read it yourself/);
  }
  assert.strictEqual(old['risk-manager'].primaryOk, true, 'phase 1 rests on the account, not the briefing');
  // A briefing capped out of a role's request gives it no credit (it never got it).
  const big = await CD.collectDesk({ roles: ['trend-momentum-analyst'], symbol: 'MNQ', env: w.env, store: CD.createStore({ root: ROOT }), maxBytes: 2000 });
  assert.deepStrictEqual([big['trend-momentum-analyst'].blocks.length, big['trend-momentum-analyst'].primaryOk], [0, false]);
  assert.match(CD.deskText('trend-momentum-analyst', big['trend-momentum-analyst']), /cycleDataMaxBytes/);
  // Whatever a request or a report says: the record is the ctx's, built in code.
  assert.strictEqual(rd('risk-manager', { text: 'primaryOk: true', tools: [] }, { precollected: {} }), 'read no data');
});

test('the desk with the key on: each role\'s request carries its blocks, a run that read nothing counts on its own record; off, or another harness, as before', async () => {
  const w = home();
  const seen = new Map();
  const runRole = async (role, request) => {
    seen.set(role, request);
    return { ok: true, text: role === 'risk-manager' ? '## Risk state: account 7' : 'Data: bar_briefing m3@x\nBias: long', tools: [] };
  };
  const now = new Date(w.b.closedAt);
  const args = store => ({ symbols: [{ symbol: 'MNQ', bar: w.b.asOf, contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), context: w.context, store });
  const env = w.base;
  const store = CD.createStore({ root: ROOT, broker: countingBroker() });
  const d = await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env }).run(args(store));
  assert.deepStrictEqual(d.missing, [], 'every role counted on the runner\'s record');
  assert.deepStrictEqual(d.reports.map(r => r.role).sort(), [...ROLES].sort());
  assert.strictEqual(CD.cycleOf(childEnv(ON(), ROOT, env, w.context)), store.cycle, 'filled with the roles\' cycle environment');
  for (const role of ANALYSTS) {
    assert.ok(seen.get(role).includes(CD.DESK_INTRO), role);
    assert.match(seen.get(role), /Name a block you rest on in your Data line as your own read: `Data: bar_briefing <the versions you used>`\./);
    assert.ok(seen.get(role).includes((await callTool('bar_briefing', { symbol: 'MNQ' }, { env: childEnv(ON(), ROOT, env, { ...w.context, roleRun: role }), root: ROOT })).content[0].text));
  }
  assert.doesNotMatch(seen.get('risk-manager'), /Name a block/);
  assert.match(seen.get('risk-manager'), /--- get_account_snapshot \{"accountId":7\} as of /);
  // Each request: the request as before, then the role's data section.
  const plain = REQUESTS.desk('trend-momentum-analyst', { symbol: 'MNQ', contractId: 'MNQ', at: now.toISOString(), timeframe: 3, bars: null, lookups: {} });
  assert.ok(seen.get('trend-momentum-analyst').startsWith(plain));
  // A briefing of another bar: the analysts that read nothing don't count (tried again, then missing).
  const stale = home({ bar: BARS[1300].t });
  const d2 = await deskFor({ home: stale.h, cfg: ON(), root: ROOT, runRole, env: stale.base }).run({ ...args(CD.createStore({ root: ROOT, broker: countingBroker() })), context: stale.context });
  assert.deepStrictEqual(d2.missing.map(m => [m.role, m.why]).sort(), ANALYSTS.map(r => [r, 'read no data']));
  // Off (the key absent), or no store: no reads made, the requests as before, a run that read nothing doesn't count.
  for (const [cfg, s] of [[validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'] }), CD.createStore({ root: ROOT, broker: countingBroker() })], [ON(), null]]) {
    seen.clear();
    const off = await deskFor({ home: w.h, cfg, root: ROOT, runRole, env }).run(args(s));
    assert.deepStrictEqual(off.missing.map(m => m.why), ROLES.map(() => 'read no data'));
    assert.ok(!seen.get('trend-momentum-analyst').includes('This cycle\'s reads'));
    if (s) assert.strictEqual(s.made, 0, 'no store written with the key off');
  }
  // Several symbols: none collected (the desk runs one-symbol cycles; a role's reads are one symbol's).
  seen.clear();
  const s3 = CD.createStore({ root: ROOT, broker: countingBroker() });
  await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env }).run({ ...args(s3), symbols: [{ symbol: 'MNQ' }, { symbol: 'MES' }] });
  assert.strictEqual(s3.made, 0);
});

test('the desk\'s reads stay inside the desk\'s time: too slow or out of time, every role a line and no credit, never an error', async () => {
  const w = home();
  const slow = { readText: () => new Promise(() => {}) };
  const seen = new Map();
  const runRole = async (role, request) => { seen.set(role, request); return { ok: true, text: '## Risk state: account 7', tools: [] }; };
  const now = new Date(w.b.closedAt);
  const d = await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString(), context: w.context, store: CD.createStore({ root: ROOT, broker: slow }), budgetMs: 200 });
  assert.match(seen.get('risk-manager'), /could not be made \(the reads took longer than the 0 s the desk could spare\): make your reads yourself/);
  assert.deepStrictEqual(d.missing.map(m => m.why), ['read no data']);
  // The desk's signal: the same.
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  const got = await Promise.race([
    (async () => { const r = await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString(), context: w.context, store: CD.createStore({ root: ROOT, broker: slow }), signal: stop.signal }); return r; })(),
    new Promise(resolve => { setTimeout(() => resolve('hung'), 5000); }),
  ]);
  assert.notStrictEqual(got, 'hung');
});

test('the report cache serves a report whose Data line names the block\'s versions', async () => {
  const w = home();
  const desk = await CD.collectDesk({ roles: ['trend-momentum-analyst'], symbol: 'MNQ', env: w.env, store: CD.createStore({ root: ROOT }) });
  const text = desk['trend-momentum-analyst'].blocks[0].text;
  const versions = ['m3', 'm15', 'h1', 'day'].map(p => (new RegExp(`\\b(${p}@\\S+?),? `).exec(text) || [])[1]);
  assert.ok(versions.every(Boolean), 'the block names each part\'s version');
  const report = `## Trend: MNQ\nData: bar_briefing ${versions.join(', ')}\nBias: long`;
  const symbols = [{ symbol: 'MNQ', contractId: null, bar: w.b.asOf }];
  const briefings = { MNQ: w.b };
  const now = new Date(w.b.closedAt);
  const cache = RC.recordReports({ prev: null, output: '', fresh: [{ role: 'trend-momentum-analyst', text: report }], briefings, symbols, account: null, day: 'd', now });
  assert.ok(cache.analysts['trend-momentum-analyst'], 'recorded');
  const served = RC.serveReports({ cache, briefings, symbols, account: null, day: 'd', now });
  assert.deepStrictEqual(served.roles, ['trend-momentum-analyst']);
  assert.strictEqual(served.reports[0].text, report);
});

test('deskBriefReports: each desk request asks for the report block alone; a minimal valid report satisfies every consumer of a desk report', async () => {
  const w = home();
  const base = { symbol: 'MNQ', contractId: 'MNQ', at: w.b.closedAt, timeframe: 3 };
  for (const role of ROLES) {
    const plain = REQUESTS.desk(role, base);
    assert.strictEqual(REQUESTS.desk(role, { ...base, brief: false }), plain);
    assert.strictEqual(REQUESTS.desk(role, { ...base, brief: 'yes' }), plain, 'only true');
    assert.strictEqual(REQUESTS.desk(role, { ...base, brief: true }), `${plain}${BRIEF}`, role);
  }
  assert.match(BRIEF, /^ Write only your report block, in the output format your role defines, with no preamble or narration/);
  // The runner config's key, Claude Code only: the desk's requests carry it.
  const seen = new Map();
  const ver = w.b.sections;
  const minimal = {
    'market-structure-analyst': `## Structure: MNQ MNQ @ 13:18 ET\nData: bar_briefing ${ver.m3.version}, ${ver.m15.version}, ${ver.h1.version}, ${ver.day.version}\nBias: long (confidence: medium)`,
    'trend-momentum-analyst': `## Trend: MNQ\nData: bar_briefing ${ver.m3.version}, ${ver.m15.version}, ${ver.h1.version}, ${ver.day.version}\nBias: long`,
    'volume-liquidity-analyst': `## Volume: MNQ\nData: bar_briefing ${ver.m3.version}, ${ver.m15.version}, ${ver.h1.version}, ${ver.day.version}\nLiquidity above: 27500 - equal highs`,
    'risk-manager': '## Risk state: account 7 @ 13:18 ET\nTradable: yes\nAttempt: practice_50k active, cushion $1200, budget $300',
  };
  const runRole = async (role, request) => { seen.set(role, request); return { ok: true, text: minimal[role], tools: role === 'risk-manager' ? ['broker_get_account_snapshot'] : ['harness_bar_briefing'] }; };
  const now = new Date(w.b.closedAt);
  const cfg = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], deskBriefReports: true });
  const d = await deskFor({ home: w.h, cfg, root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), context: w.context });
  for (const role of ROLES) assert.ok(seen.get(role).endsWith(BRIEF), role);
  // The desk's acceptance checks: every report counts.
  assert.deepStrictEqual(d.missing, []);
  assert.deepStrictEqual(d.recorded.slice().sort(), [...ROLES].sort());
  for (const role of ROLES) assert.strictEqual(CHECKS['report-shape'](role, { text: minimal[role] }), null, role);
  // The order gate's credit: the runner's record of each run (runner-roles.js asRoleCalls).
  const calls = RR.asRoleCalls(RR.readRoleRuns(d.rolesFile));
  assert.deepStrictEqual(calls.calls.map(c => c.role).sort(), [...ROLES].sort());
  // The report cache: each analyst's versions, recorded and served (phase 1, live data, never cached).
  const account = { id: 7, balance: 50000, positions: [], orders: [], attempts: [{ account: 'practice_50k', status: 'active' }] };
  const symbols = [{ symbol: 'MNQ', contractId: null, bar: w.b.asOf }];
  const cache = RC.recordReports({ prev: null, output: '', fresh: d.reports, briefings: { MNQ: w.b }, symbols, account, day: 'd', now });
  assert.deepStrictEqual(Object.keys(cache.analysts).sort(), ANALYSTS);
  assert.ok(!cache.phase1, 'phase 1 never cached');
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: w.b }, symbols, account, day: 'd', now }).roles.sort(), [...ANALYSTS].sort());
  // The head trader's prompt: each report given whole.
  const p = prompts(cfg, now, ROOT).trade([{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }], { cached: { roles: ROLES, reports: d.reports } });
  for (const role of ROLES) assert.ok(p.includes(minimal[role]), role);
  // Off: no instruction.
  seen.clear();
  await deskFor({ home: w.h, cfg: validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'] }), root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), context: w.context });
  for (const role of ROLES) assert.ok(!seen.get(role).includes(BRIEF), role);
});

test('each entry\'s kind: a preload read may be made before the close (the seam), a read of the closing bar never; the cycle\'s fill takes the preloaded entry', async () => {
  assert.deepStrictEqual([...CD.PRELOAD], ['strategies_list']);
  for (const t of ['bar_briefing', 'combine_status', 'get_quote', 'get_server_config', 'list_accounts', 'journal_read', ...CD.READS]) assert.strictEqual(CD.kindOf(t), 'close', t);
  const w = home();
  const tool = countingTool();
  const broker = countingBroker();
  const store = CD.createStore({ root: ROOT, broker, callTool: tool });
  // Before the close (a preloader runs between cycles): only the preload reads are made.
  const pre = await store.preload([...CD.deskReads('market-structure-analyst', { symbol: 'MNQ' }), ...CD.deskReads('risk-manager', { symbol: 'MNQ', accountId: 7 })], { env: w.env });
  assert.deepStrictEqual(tool.calls.map(c => c[0]), ['strategies_list'], 'no close read made early (look-ahead)');
  assert.deepStrictEqual(broker.calls, [], 'no account, journal or server read made early');
  assert.deepStrictEqual(pre.filter(e => e.ok).map(e => [e.tool, e.kind]), [['strategies_list', 'preload']]);
  assert.ok(pre.filter(e => !e.ok).every(e => e.kind === 'close' && e.why === 'a read of the closing bar: made only at its close'));
  assert.strictEqual(store.cycle, null, 'a preload fixes no cycle');
  // At the close: the cycle's fill makes the close reads and takes the preloaded one as made.
  const d = await CD.collectDesk({ roles: ['market-structure-analyst'], symbol: 'MNQ', env: w.env, store });
  assert.deepStrictEqual(tool.calls.map(c => c[0]), ['strategies_list', 'bar_briefing']);
  assert.strictEqual(d['market-structure-analyst'].blocks.find(b => b.tool === 'strategies_list').text, pre[1].text);
  assert.strictEqual(pre[1].text, (await callTool('strategies_list', {}, { env: w.env, root: ROOT })).content[0].text, 'byte for byte the tool\'s');
  assert.ok(d['market-structure-analyst'].blocks.find(b => b.tool === 'bar_briefing'));
});

/** An analyst on 15m bars: its briefing written beside the runner's, the cycle's context naming it (runner.js deskContext). */
function framed({ cycleAt = null, write = true, frameBars = 1300, extra = {} } = {}) {
  const w = home({ extra });
  const { candles } = require('../../scripts/lib/trading/mtf');
  const whole = candles(BARS.slice(0, frameBars), 15).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  if (write) B.writeFrameBriefing(w.h, B.buildFrameBriefing({ symbol: 'NQ', contractId: null, bars: whole, minutes: 15, first: w.b }));
  const context = { ...w.context, cycleAt: cycleAt || w.b.closedAt, frames: [{ role: 'trend-momentum-analyst', timeframe: '15m' }] };
  return { ...w, context, env: childEnv(ON(), ROOT, w.base, context) };
}

test('an own-timeframe briefing of a bar that closed after the replay clock gives no credit (no look-ahead), though it would hold at the cycle\'s start', async () => {
  const tma = 'trend-momentum-analyst';
  const frames = { [tma]: '15m' };
  // A replay broker (its config says replay), so FTH_REPLAY_NOW is the harness's clock.
  const dir = tmpDir();
  const brokers = path.join(dir, 'replay-brokers.json');
  fs.writeFileSync(brokers, JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  // The 15m briefing is built on bars past the runner's (its bar closed later); the cycle's start is set at its close,
  // so it holds there (frameHolds), and only the replay clock, at the runner's bar's close, is before it.
  const probe = framed({ frameBars: 1320 });
  const f = B.readFrameBriefing(probe.h, 'MNQ', 15);
  assert.ok(Date.parse(f.closedAt) > Date.parse(probe.b.closedAt), 'the frame\'s bar closed after the runner\'s');
  const w = framed({ frameBars: 1320, cycleAt: f.closedAt, extra: { FTH_BROKERS_FILE: brokers, FTH_REPLAY_NOW: probe.b.closedAt } });
  assert.strictEqual(CD.briefingServed(w.env, 'MNQ').briefing.asOf, w.b.asOf, 'the runner\'s briefing is this cycle\'s under the replay clock');
  const served = CD.frameServed(w.env, 'MNQ', '15m');
  assert.ok(!served.briefing && /after the replay clock/.test(served.why), JSON.stringify(served));
  const d = await CD.collectDesk({ roles: [tma], symbol: 'MNQ', env: w.env, store: CD.createStore({ root: ROOT }), frames });
  assert.strictEqual(d[tma].primaryOk, false);
  assert.strictEqual(CHECKS['read-data'](tma, { text: 'Data: bar_briefing bar15m@x', tools: [] }, { precollected: d }), 'read no data');
  assert.ok(!d[tma].blocks.some(b => b.args.timeframe), 'no block of it');
  // The tool agrees: it doesn't serve it either.
  assert.match((await callTool('bar_briefing', { symbol: 'MNQ', timeframe: '15m' }, { env: w.env, root: ROOT })).content[0].text, /not served/);
  // At the frame's own close, the same briefing is credited.
  const later = framed({ frameBars: 1320, cycleAt: f.closedAt, extra: { FTH_BROKERS_FILE: brokers, FTH_REPLAY_NOW: f.closedAt } });
  const ok = await CD.collectDesk({ roles: [tma], symbol: 'MNQ', env: later.env, store: CD.createStore({ root: ROOT }), frames });
  assert.strictEqual(ok[tma].primaryOk, true);
});

test('a preloaded read that failed is tried again by the cycle\'s fill', async () => {
  const w = home();
  let n = 0;
  const flaky = async (name, a, o) => { if (name === 'strategies_list' && (n += 1) === 1) throw new Error('flake'); return callTool(name, a, o); };
  const store = CD.createStore({ root: ROOT, callTool: flaky });
  const [pre] = await store.preload([{ tool: 'strategies_list', args: {} }], { env: w.env });
  assert.deepStrictEqual([pre.ok, pre.kind], [false, 'preload']);
  const d = await CD.collectDesk({ roles: ['market-structure-analyst'], symbol: 'MNQ', env: w.env, store });
  assert.strictEqual(n, 2, 'read again at the close');
  assert.strictEqual(d['market-structure-analyst'].blocks.find(b => b.tool === 'strategies_list').text, (await callTool('strategies_list', {}, { env: w.env, root: ROOT })).content[0].text);
  // A preload that succeeded is taken as made.
  const ok = CD.createStore({ root: ROOT, callTool: flaky });
  await ok.preload([{ tool: 'strategies_list', args: {} }], { env: w.env });
  await CD.collectDesk({ roles: ['market-structure-analyst'], symbol: 'MNQ', env: w.env, store: ok });
  assert.strictEqual(n, 3);
});

test('an analyst on its own timeframe: its timeframe\'s briefing is its primary read, credited only when it is the one holding at the cycle\'s start', async () => {
  const rd = CHECKS['read-data'];
  const none = { text: 'Data: bar_briefing bar15m@x', tools: [] };
  const frames = { 'trend-momentum-analyst': '15m' };
  const tma = 'trend-momentum-analyst';
  assert.deepStrictEqual(CD.deskReads(tma, { symbol: 'MNQ', timeframe: '15m' }).map(x => x.args), [{ symbol: 'MNQ', timeframe: '15m' }, { symbol: 'MNQ' }]);
  const w = framed();
  const d = await CD.collectDesk({ roles: [tma, 'market-structure-analyst'], symbol: 'MNQ', env: w.env, store: CD.createStore({ root: ROOT }), frames });
  assert.strictEqual(d[tma].primaryOk, true);
  assert.deepStrictEqual(d[tma].blocks.map(b => b.args), [{ symbol: 'MNQ', timeframe: '15m' }, { symbol: 'MNQ' }]);
  const roleEnv = childEnv(ON(), ROOT, w.base, { ...w.context, roleRun: tma });
  const raw = await callTool('bar_briefing', { symbol: 'MNQ', timeframe: '15m' }, { env: roleEnv, root: ROOT });
  assert.strictEqual(d[tma].blocks[0].text, raw.content[0].text, 'byte for byte the tool\'s, with its run\'s environment');
  assert.match(raw.content[0].text, /15m/);
  assert.strictEqual(rd(tma, none, { precollected: d }), null);
  assert.deepStrictEqual(d['market-structure-analyst'].blocks.map(b => b.args), [{ symbol: 'MNQ' }, {}], 'an analyst without a frame: as before');
  // No 15m briefing built: the runner's briefing alone is no credit for it (it reads its own timeframe's itself).
  const nof = framed({ write: false });
  const d2 = await CD.collectDesk({ roles: [tma], symbol: 'MNQ', env: nof.env, store: CD.createStore({ root: ROOT }), frames });
  assert.deepStrictEqual([d2[tma].primaryOk, d2[tma].blocks.map(b => b.args)], [false, [{ symbol: 'MNQ' }]]);
  assert.strictEqual(rd(tma, none, { precollected: d2 }), 'read no data');
  assert.match(CD.deskText(tma, d2[tma]), /Not collected: bar_briefing \{"symbol":"MNQ","timeframe":"15m"\} \(no 15m bar briefing\); read it yourself/);
  // A 15m bar that no longer holds at the cycle's start, or no cycle start: no credit.
  for (const env of [framed({ cycleAt: new Date(Date.parse(w.b.closedAt) + 3600000).toISOString() }).env, (() => { const { FTH_CYCLE_AT: _a, ...e } = w.env; return e; })()]) {
    const d3 = await CD.collectDesk({ roles: [tma], symbol: 'MNQ', env, store: CD.createStore({ root: ROOT }), frames });
    assert.strictEqual(d3[tma].primaryOk, false);
  }
  // Through the desk: the cycle's context.frames gives the role its timeframe's read; a run that called nothing counts.
  const seen = new Map();
  const runRole = async (role, request) => { seen.set(role, request); return { ok: true, text: 'Data: bar_briefing bar15m@x\nBias: long', tools: [] }; };
  const now = new Date(w.b.closedAt);
  const run = await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: [tma], now, at: now.toISOString(), context: w.context, store: CD.createStore({ root: ROOT }) });
  assert.deepStrictEqual(run.missing, []);
  assert.ok(seen.get(tma).includes('--- bar_briefing {"symbol":"MNQ","timeframe":"15m"} as of'));
  const run2 = await deskFor({ home: nof.h, cfg: ON(), root: ROOT, runRole, env: nof.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: [tma], now, at: now.toISOString(), context: nof.context, store: CD.createStore({ root: ROOT }) });
  assert.deepStrictEqual(run2.missing.map(m => m.why), ['read no data']);
});

test('a read that failed is tried again by a later reader in the cycle: the desk\'s briefing read throws once, the head trader gets its block', async () => {
  const w = home();
  let n = 0;
  const flaky = async (name, a, o) => { if (name === 'bar_briefing' && (n += 1) === 1) throw new Error('flake'); return callTool(name, a, o); };
  const store = CD.createStore({ root: ROOT, callTool: flaky });
  const d = await CD.collectDesk({ roles: ['trend-momentum-analyst'], symbol: 'MNQ', env: w.env, store });
  assert.strictEqual(d['trend-momentum-analyst'].primaryOk, false);
  const head = await CD.collect({ symbols: ['MNQ'], env: w.env, root: ROOT, store });
  assert.deepStrictEqual([head.blocks.map(b => b.tool), head.missing], [['bar_briefing'], []]);
  assert.strictEqual(head.blocks[0].text, (await callTool('bar_briefing', { symbol: 'MNQ' }, { env: w.env, root: ROOT })).content[0].text);
  assert.strictEqual(n, 2);
  // A read that succeeded is not read again; one fill never reads a key twice.
  await CD.collect({ symbols: ['MNQ'], env: w.env, root: ROOT, store });
  assert.strictEqual(n, 2);
});

test('phase 1 reads today\'s reviews (since the trading day\'s start, the cycle\'s clock) and the lessons through the harness tool, never the raw journal', async () => {
  const { tradingDayStart } = require('../../scripts/lib/trading/clock');
  assert.deepStrictEqual(CD.deskReads('risk-manager', { symbol: 'MNQ', since: '2026-04-26T22:00:00.000Z' }).filter(x => x.tool === 'journal_read').map(x => x.args), [{ kind: 'review', since: '2026-04-26T22:00:00.000Z' }]);
  assert.ok(CD.deskReads('risk-manager', { symbol: 'MNQ' }).some(x => x.tool === 'lessons'));
  const w = home();
  const broker = countingBroker();
  const now = new Date(w.b.closedAt);
  const runRole = async () => ({ ok: true, text: '## Risk state: account 7', tools: [] });
  await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString(), context: w.context, store: CD.createStore({ root: ROOT, broker }) });
  const journal = broker.calls.filter(c => c[0] === 'journal_read').map(c => c[1]);
  assert.deepStrictEqual(journal, [{ kind: 'review', since: tradingDayStart(now).toISOString() }]);
  assert.ok(Date.parse(journal[0].since) <= now.getTime() && now.getTime() - Date.parse(journal[0].since) < 86400000);
});

test('a desk whose time is already spent makes no read', async () => {
  const w = home();
  const store = CD.createStore({ root: ROOT, broker: countingBroker() });
  const stop = new AbortController();
  stop.abort();
  const now = new Date(w.b.closedAt);
  const d = await deskFor({ home: w.h, cfg: ON(), root: ROOT, runRole: async () => ({ ok: true, text: 'x', tools: [] }), env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), context: w.context, store, signal: stop.signal });
  assert.strictEqual(store.made, 0);
  assert.ok(d.missing.every(m => m.stop === 'cancelled'));
});

test('with roleSkillsInPrompt too: each role\'s request carries its reads and its run\'s skills record comes through the desk\'s results', async () => {
  const w = home();
  const seen = new Map();
  const skills = { mode: 'prompt', embedded: ['trader-process'] };
  const runRole = async (role, request) => { seen.set(role, request); return { ok: true, text: role === 'risk-manager' ? '## Risk state: account 7' : 'Data: bar_briefing m3@x\nBias: long', tools: [], skills }; };
  const now = new Date(w.b.closedAt);
  const cfg = ON({ roleSkillsInPrompt: true, deskBriefReports: true });
  const d = await deskFor({ home: w.h, cfg, root: ROOT, runRole, env: w.base }).run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ROLES, now, at: now.toISOString(), context: w.context, store: CD.createStore({ root: ROOT, broker: countingBroker() }) });
  assert.deepStrictEqual(d.missing, []);
  assert.ok(d.results.every(r => r.skills === skills), 'the skills record kept per role');
  for (const role of ROLES) assert.ok(seen.get(role).includes(CD.DESK_INTRO) && seen.get(role).includes(BRIEF), role);
});
