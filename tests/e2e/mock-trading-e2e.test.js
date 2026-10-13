'use strict';

/**
 * End to end on a mock exchange (tests/fixtures/mock-exchange.js), through the
 * production stack: the real order gateway (scripts/mcp-gateway.js) and the
 * contract translator in front of a broker MCP server, configured like any
 * broker (brokers.json); the runner on the real broker adapter (reads straight
 * to the server, orders through the gateway). The exchange fills market
 * orders at its price, works bracket legs (OCO), triggers stops and limits as
 * the test moves the price (a gap fills past the stop), and misbehaves on
 * cue: closes it loses, fills late, refuses, or takes with an error reply;
 * an entry whose reply is lost; positions listed without a size; a balance
 * it can't report.
 *
 * Covered: a long's whole life from a real strategy signal (a second entry,
 * a loosened and a removed stop refused; a tightened stop; partial closes in
 * and over size; a gap through the stop), a short's, a target, the runner's
 * trailing stop; closes in flight under three names for the contract, closes
 * refused or of unknown outcome, an entry of unknown outcome; the gateway on
 * a raw server; an unreadable position; holidays, the early close and the
 * calendar's end; the runner's end of day against a broker that loses or
 * delays its closes or leaves bracket legs behind; losses counted from real
 * fills; malformed brackets; order_plan's arguments sent as they are; a prop attempt's daily close (recorded once
 * flat, or missed and then refused); and a runner that crashed mid-day
 * catching up the next morning (and before a holiday).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const exchange = require('../fixtures/mock-exchange');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { openAdapter } = require('../../scripts/lib/broker/adapter');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { writeMtfRecord } = require('../../scripts/lib/trading/mtf-state');
const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { entryOrders } = require('../../scripts/lib/harness-run');
const { createPropHooks } = require('../../scripts/lib/prop/live-runner');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { plan: orderPlan } = require('../../scripts/lib/harness-tools/order-plan');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const MNQ_ID = 'fake:MNQ:Z26';
const STEP = 180000;
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
// The parity bar where bos fired long (tests/e2e/trading-e2e.test.js), and the moment just after it closed.
const FIRED_BAR = '2026-04-28T04:09:00.000Z';

/**
 * A harness home wired to the mock exchange as its broker, with the broker's tick specs recorded
 * (as the translator does at the runner's contract lookup); specs: false leaves them to be looked up.
 */
function world(at, over = {}, { specs = true } = {}) {
  const home = tmpDir();
  if (specs) recordBrokerSpecs(home, { broker: 'mock', roots: ['MNQ', 'NQ', 'MES', 'ES'] });
  const state = path.join(home, 'exchange.json');
  const journal = path.join(home, 'journal.jsonl');
  fs.writeFileSync(journal, '');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: [process.execPath, SERVER], journal, allowedAccountsEnv: 'MOCK_ALLOWED_ACCOUNTS' } } }));
  exchange.initState(state, { nowMs: Date.parse(at), ...over });
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, MOCK_STATE: state, MOCK_JOURNAL: journal, MOCK_ALLOWED_ACCOUNTS: '7', NODE_ENV: 'test', FTH_TEST_NOW: at,
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_GATE_LOG: path.join(home, 'gate.jsonl'), FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'),
  };
  return { home, state, journal, env };
}

/** An MCP client through the real gateway: what an agent's order calls go through. */
function gatewayClient(w) {
  return createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js')], env: w.env, cwd: ROOT, timeoutMs: 20000 });
}

/** The call's outcome: { ok, result } or { ok: false, error } (a gate block is an error naming its checks). */
async function attempt(client, tool, args) {
  try {
    return { ok: true, result: await client.call(tool, args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The violations of the gate's last blocked decision (FTH_GATE_LOG). */
function lastBlock(w) {
  const lines = fs.readFileSync(w.env.FTH_GATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.decision === 'blocked');
  return lines.at(-1).violations;
}

const position = (w, id = MNQ_ID) => exchange.read(w.state).positions.find(p => p.contractId === id) || null;
const working = (w, id = MNQ_ID) => exchange.read(w.state).orders.filter(o => o.status === 1 && o.contractId === id);

/** The gate's records for the bar where a real strategy fired, and the agent's plan: what an entry needs. */
function signalOnFiredBar(w) {
  const strategies = loadStrategies(ROOT, {}).strategies.filter(s => s.timeframe === '3m');
  const bars = BARS.filter(b => Date.parse(b.t) <= Date.parse(FIRED_BAR));
  const last = bars[bars.length - 1];
  const now = new Date(Date.parse(FIRED_BAR) + STEP + 20000);
  writeMtfRecord(w.home, 'MNQ', bars);
  const results = scan(strategies, { bars }, { symbol: 'MNQ', now });
  writeSignals(w.home, buildSignals(results, { symbol: 'MNQ', bar: last, stepMs: STEP, now }));
  const fired = results.find(r => r.name === 'bos' && r.candidate);
  assert.ok(fired, 'bos fired on the bar');
  fs.appendFileSync(w.journal, `${JSON.stringify({ ts: now.toISOString(), kind: 'plan', contractId: 'MNQ', tags: ['setup:bos', 'MNQ'], text: 'bos long on the break' })}\n`);
  // The broker's bars are the ones the scan read (the gateway's regime check fetches them).
  exchange.update(w.state, s => { s.prices[MNQ_ID] = last.c; s.bars = { ...(s.bars || {}), [MNQ_ID]: bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })) }; });
  // The window the gateway's regime check reads is the evaluator's: the last 500 closed bars, across breaks.
  const { barsRequest } = require('../../scripts/lib/trading/account-gate');
  const served = exchange.HANDLERS.get_bars(exchange.read(w.state), { ...barsRequest(MNQ_ID, '3m'), endTime: now.toISOString() });
  assert.deepStrictEqual(served.bars.map(b => b.t), bars.slice(-500).map(b => b.t));
  const ticks = Math.ceil(fired.stopDistance / 0.25);
  return { price: last.c, ticks, side: fired.direction, now };
}

test('mock trading: a trade\'s whole life through the gateway, from a real signal to a flat account', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString();
  const w = world(at, {}, { specs: false });
  const sig = signalOnFiredBar(w);
  assert.strictEqual(sig.side, 'long');
  const stop = sig.price - sig.ticks * 0.25;
  const entry = {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1,
    stopLossBracket: { ticks: sig.ticks, type: 'stop' }, takeProfitBracket: { ticks: sig.ticks * 2, type: 'limit' },
    rationale: `setup:bos long trigger on the closed bar, stop ${stop.toFixed(2)}, target ${(sig.price + sig.ticks * 0.5).toFixed(2)}`,
  };
  const gw = gatewayClient(w);
  try {
    // 0. No tick specs from the broker yet: the entry is refused, nothing reaches the broker. The
    // contract looked up (search_contracts through the gateway and the translator) records them.
    const early = await attempt(gw, 'place_order', entry);
    assert.ok(!early.ok && /\[contract-specs\] no tick specs from the broker for MNQ yet/.test(early.error), early.error);
    assert.ok(!exchange.read(w.state).calls.some(c => c.tool === 'place_order'));
    await gw.call('search_contracts', { searchText: 'MNQ' });
    const recorded = JSON.parse(fs.readFileSync(path.join(w.home, 'contracts-mock.json'), 'utf8')).specs.MNQ;
    assert.deepStrictEqual([recorded.tickSize, recorded.tickValue, recorded.id, recorded.name], [0.25, 0.5, MNQ_ID, 'MNQZ6']);
    // No max order size from the server yet either: refused until get_server_config records it (the exchange's is 5).
    const noLimit = await attempt(gw, 'place_order', entry);
    assert.ok(!noLimit.ok && /\[max-order-size\] the broker server's max order size is not recorded yet: call get_server_config/.test(noLimit.error), noLimit.error);
    await gw.call('get_server_config', {});
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.home, 'contracts-mock.json'), 'utf8')).server.maxOrderSize, 5);
    // Over it: refused by the gate, never sent to the broker.
    const big = await attempt(gw, 'place_order', { ...entry, size: 6 });
    assert.ok(!big.ok && /\[max-order-size\] size 6 over the broker's max order size 5 .*reduce the size to 5 or less/.test(big.error), big.error);
    assert.ok(!exchange.read(w.state).calls.some(c => c.tool === 'place_order'));
    // 1. The entry: allowed, filled at the market, with its bracket stop and target working.
    const placed = await attempt(gw, 'place_order', entry);
    assert.ok(placed.ok, placed.error);
    assert.deepStrictEqual([position(w).type, position(w).size, position(w).averagePrice], [1, 1, sig.price]);
    const legs = working(w);
    const stopLeg = legs.find(o => o.type === 4);
    assert.strictEqual(stopLeg.stopPrice, stop);
    assert.ok(legs.some(o => o.type === 1 && o.limitPrice === sig.price + sig.ticks * 0.5));
    // The broker only ever saw its own contract id.
    assert.ok(exchange.read(w.state).calls.filter(c => c.tool === 'place_order').every(c => c.args.contractId === MNQ_ID));

    // 2. A second entry while in the trade: refused, never sent.
    const again = await attempt(gw, 'place_order', entry);
    assert.match(again.error, /position-open/);
    assert.strictEqual(exchange.read(w.state).calls.filter(c => c.tool === 'place_order').length, 1);

    // 3. Loosening the stop (away from the market) and removing it: refused. Tightening it: allowed.
    assert.match((await attempt(gw, 'modify_order', { accountId: 7, orderId: stopLeg.id, stopPrice: stop - 10 })).error, /modify-protection/);
    assert.match((await attempt(gw, 'cancel_order', { accountId: 7, orderId: stopLeg.id })).error, /cancel-protection/);
    const tighter = stop + 2;
    assert.ok((await attempt(gw, 'modify_order', { accountId: 7, orderId: stopLeg.id, stopPrice: tighter })).ok);
    assert.strictEqual(working(w).find(o => o.id === stopLeg.id).stopPrice, tighter);

    // 4. Partial closes: over the position, a fraction, or a contract with no position are refused; none reached the broker.
    assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MNQ', size: 2 })).error, /partial-close.*over the open MNQ position \(1\)/);
    assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MNQ', size: 0.5 })).error, /partial-close/);
    assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MES', size: 1 })).error, /partial-close.*No open MES position/);
    assert.ok(!exchange.read(w.state).calls.some(c => c.tool === 'partial_close_position'));

    // 5. The market gaps through the tightened stop: stopped out at the gap price, worse than the stop; the target
    //    cancelled (OCO); the loss in the fills.
    exchange.setPrice(w.state, MNQ_ID, tighter - 5);
    assert.strictEqual(position(w), null);
    assert.deepStrictEqual(working(w), [], 'the target went with the stop (OCO)');
    const exit = exchange.read(w.state).fills.at(-1);
    assert.strictEqual(exit.price, tighter - 5, 'a gap fills past the stop');
    assert.strictEqual(exit.profitAndLoss, (tighter - 5 - sig.price) * 2, 'MNQ: $2 a point');
    assert.ok(exit.profitAndLoss < 0);

    // 6. Flat: the leftover-free account takes no exit; a cancel of an order that isn't there is the broker's refusal.
    assert.match((await attempt(gw, 'place_order', { ...entry, side: 'sell', type: 'market', stopLossBracket: undefined, takeProfitBracket: undefined, rationale: '[exit] flatten' })).error, /exposure|no open/i);
  } finally {
    gw.close();
  }
});

test('mock trading: order_plan\'s place_order arguments, sent as they are, pass the gateway and fill with the stop where it said', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString();
  const w = world(at);
  const sig = signalOnFiredBar(w);
  const file = path.join(w.home, 'MNQ-3m.json');
  fs.writeFileSync(file, JSON.stringify(BARS.filter(b => Date.parse(b.t) <= Date.parse(FIRED_BAR))));
  const plan = orderPlan({ file, symbol: 'MNQ', strategy: 'bos', side: sig.side, accountId: 7 }, { root: ROOT, env: w.env, now: () => sig.now, tool: true });
  assert.strictEqual(plan.args.stopLossBracket.ticks, sig.ticks, 'the same ticks as the stop distance, rounded away from the entry');
  const gw = gatewayClient(w);
  try {
    // The other side is refused by order_plan itself; the side that fired goes through the real gate.
    assert.throws(() => orderPlan({ file, symbol: 'MNQ', strategy: 'bos', side: 'short' }, { root: ROOT, env: w.env, now: () => sig.now }), /fired long/);
    const placed = await attempt(gw, 'place_order', plan.args);
    assert.ok(placed.ok, placed.error);
    assert.deepStrictEqual([position(w).type, position(w).size], [1, 1]);
    const stopLeg = working(w).find(o => o.type === 4);
    assert.strictEqual(stopLeg.stopPrice, plan.plan.stopPrice, 'filled at the signal close: the bracket stop is the planned price');
    assert.ok(stopLeg.stopPrice < position(w).averagePrice, 'a long\'s stop below the fill');
  } finally {
    gw.close();
  }
});

test('mock trading: a close is counted the moment it is sent, under any name for the contract; its stop can\'t be moved after it', async () => {
  for (const name of ['MNQ', 'MNQ:2026-12', MNQ_ID]) {
    const w = world('2026-10-07T14:30:00Z', { holdCloses: true });
    // A long with a protective stop, opened earlier.
    exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 2, stopLossBracket: { ticks: 40 } }, {});
    const stopId = working(w).find(o => o.type === 4).id;
    const gw = gatewayClient(w);
    try {
      // The translator learns the contract (as any first call does).
      await gw.call('search_contracts', { searchText: 'MNQ' });
      // A partial close named this way: allowed (1 of the 2), accepted, not filled yet.
      const part = await attempt(gw, 'partial_close_position', { accountId: 7, contractId: name, size: 1 });
      assert.ok(part.ok, `${name}: ${part.error}`);
      // Another partial close of 2 would reverse the 1 left once the first fills: refused, though the account still shows 2.
      assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MNQ', size: 2 })).error, /partial-close.*once recent orders fill/, name);
      // The full close: always goes. Then the stop works nothing once it fills: it can't be moved.
      assert.ok((await attempt(gw, 'close_position', { accountId: 7, contractId: name })).ok, name);
      assert.strictEqual(position(w).size, 2, 'the broker hasn\'t filled either close yet');
      assert.match((await attempt(gw, 'modify_order', { accountId: 7, orderId: stopId, stopPrice: 21495 })).error, /modify-entry.*once recent orders fill/, name);
      // The closes fill; the stop is a leftover the gateway lets the agent cancel.
      exchange.settle(w.state);
      assert.strictEqual(position(w), null);
      assert.ok((await attempt(gw, 'cancel_order', { accountId: 7, orderId: stopId })).ok, name);
      assert.deepStrictEqual(working(w), []);
    } finally {
      gw.close();
    }
  }
});

test('mock trading: a position listed without a size blocks every gated order, never reads as flat; close_position still goes', async () => {
  const w = world('2026-10-07T14:30:00Z');
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  exchange.update(w.state, s => { s.oddSize = true; });
  const stopId = working(w).find(o => o.type === 4).id;
  const gw = gatewayClient(w);
  try {
    const sell = { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten' };
    assert.match((await attempt(gw, 'place_order', sell)).error, /no valid size.*The order was not sent/);
    assert.match((await attempt(gw, 'cancel_order', { accountId: 7, orderId: stopId })).error, /no valid size/);
    assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MNQ', size: 1 })).error, /no valid size/);
    assert.ok((await attempt(gw, 'close_position', { accountId: 7, contractId: 'MNQ' })).ok);
    assert.strictEqual(position(w), null, 'closed');
  } finally {
    gw.close();
  }
});

test('mock trading: no entry on an exchange holiday, after an early close, or past the calendar\'s end; exits still go', async () => {
  const cases = [
    ['2026-07-03T14:00:00Z', /closed for the trading day 2026-07-03/, 'Independence Day (observed): closed, though CME runs a short session'],
    ['2026-01-19T15:00:00Z', /closed for the trading day 2026-01-19/, 'MLK Day: closed'],
    ['2026-11-27T18:10:00Z', /early close at 13:00 ET/, 'the day after Thanksgiving, 13:10 ET'],
    ['2028-01-05T15:00:00Z', /calendar ends 2027-12-31/, 'past the calendar: holidays unknown'],
  ];
  for (const [at, why, label] of cases) {
    const w = world(at);
    exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1 }, {});
    fs.appendFileSync(w.journal, `${JSON.stringify({ ts: at, kind: 'plan', contractId: 'MNQ', text: 'plan' })}\n`);
    const gw = gatewayClient(w);
    try {
      const r = await attempt(gw, 'place_order', { accountId: 7, contractId: 'MES', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:orb long, stop 5790.00' });
      assert.ok(!r.ok, label);
      // The whole decision is in the gate's log (the reply is cut short).
      const v = lastBlock(w).find(x => x.check === 'market-hours');
      assert.ok(v, label);
      assert.match(v.message, why, label);
      // An exit always goes, through the gate too: the long is flattened by an [exit] order.
      const exit = await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten before the close' });
      assert.ok(exit.ok, `${label}: ${exit.error}`);
      assert.strictEqual(position(w), null, label);
    } finally {
      gw.close();
    }
  }
});

/**
 * The runner on the real adapter against the mock exchange, on a simulated
 * clock (the exchange's clock follows it). A stand-in for the agents answers
 * every run. With `prop`, the runner keeps the prop attempt of the policy
 * strategy prop_portfolio (account topstep_100k) as scripts/autotrader.js
 * wires it; its day state is kept in <home>/runner-state.json, as the
 * autotrader keeps it across restarts.
 */
const PROP_STRATEGY = 'prop_portfolio';
const PROP_ACCOUNT = 'topstep_100k';
const propAccount = () => loadAccounts(ROOT, {}).accounts.find(a => a.name === PROP_ACCOUNT);

async function runDay(w, { from, until, cfg = {}, before = () => {}, withProp = false }) {
  const clockRef = { t: Date.parse(from) };
  const events = [];
  const logs = [];
  const runs = [];
  const stateFile = path.join(w.home, 'runner-state.json');
  const client = openAdapter({ root: ROOT, env: w.env, timeoutMs: 20000 });
  const log = (msg, level) => logs.push(`${level === 'error' ? 'ERROR' : 'INFO'} ${msg}`);
  const hooks = withProp ? createPropHooks({
    root: ROOT, env: w.env, home: w.home, client, accountId: '7', log,
    strategies: () => loadStrategies(ROOT, {}).strategies.filter(s => s.name === PROP_STRATEGY),
  }) : null;
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], ...cfg }), root: ROOT, client, prop: hooks,
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt) => { runs.push([action, new Date(clockRef.t).toISOString(), prompt]); return { ok: true, timedOut: false, result: `CYCLE RESULT: managed - ${action}` }; },
    isKillSwitchOn: () => false, createKillSwitch: () => events.push({ kind: 'kill_switch_created' }),
    loadState: () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null),
    saveState: s => fs.writeFileSync(stateFile, JSON.stringify(s)),
    writeBars: () => path.join(w.home, 'bars.json'), scanFor: () => [], scanLog: () => {},
    // As scripts/autotrader.js wires them: the entries the gateway let through, and the strategies' exit plans.
    entryOrders: () => entryOrders(w.home),
    strategyNamed: name => loadStrategies(ROOT, {}).strategies.find(x => x.name === name && x.valid) || null,
    event: ev => events.push(ev), log,
  });
  try {
    for (let guard = 0; clockRef.t < Date.parse(until) && guard < 2000; guard += 1) {
      exchange.update(w.state, s => { s.nowMs = clockRef.t; });
      before(clockRef.t);
      clockRef.t += Math.max(await runner.step(), 1000);
    }
  } finally {
    client.close();
  }
  return { events, logs, runs };
}

/** The bos long of the fired bar, placed through the gateway as an agent would. */
async function enterBos(w, { target = false } = {}) {
  const sig = signalOnFiredBar(w);
  const stop = sig.price - sig.ticks * 0.25;
  const gw = gatewayClient(w);
  try {
    const r = await attempt(gw, 'place_order', {
      accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: sig.ticks, type: 'stop' },
      ...(target ? { takeProfitBracket: { ticks: sig.ticks * 2, type: 'limit' } } : {}),
      rationale: `setup:bos long trigger on the closed bar, stop ${stop.toFixed(2)}${target ? `, target ${(sig.price + sig.ticks * 0.5).toFixed(2)}` : ''}`,
    });
    assert.ok(r.ok, r.error);
  } finally {
    gw.close();
  }
  return { ...sig, risk: sig.ticks * 0.25, stop };
}

function openLong(w) {
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 }, takeProfitBracket: { ticks: 80 } }, {});
}

test('mock trading: end of day flattens through the gateway and is done only once the account reads flat (a close the broker loses is sent again)', async () => {
  // The broker loses the first close and leaves bracket legs working once flat (the runner cancels them).
  const w = world('2026-10-07T19:48:00Z', { dropCloses: 1, keepLegs: true });
  openLong(w);
  const r = await runDay(w, { from: '2026-10-07T19:49:30Z', until: '2026-10-07T19:56:00Z' });
  const closes = exchange.read(w.state).calls.filter(c => c.tool === 'close_position');
  assert.strictEqual(closes.length, 2, 'the lost close, then one that filled');
  assert.ok(closes.every(c => c.args.contractId === MNQ_ID), 'through the translator');
  assert.strictEqual(position(w), null);
  assert.deepStrictEqual(working(w), [], 'the stop and target are gone');
  const kinds = r.events.map(e => e.kind);
  assert.ok(kinds.includes('flatten_unverified') && kinds.includes('flatten_verified'));
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
  assert.deepStrictEqual(r.runs.filter(x => x[0] === 'eod').length, 1, 'the agents\' end-of-day run happens once');
  assert.ok(!kinds.includes('kill_switch_created'));
  // The stop and target were cancelled, and only once the position was gone: never a stop of an open position.
  const cancels = exchange.read(w.state).calls.filter(c => c.tool === 'cancel_order');
  assert.strictEqual(cancels.length, 2);
  assert.ok(cancels.every(c => !c.open), JSON.stringify(cancels));
});

test('mock trading: a close that fills late is sent once, never twice (two would reverse the position)', async () => {
  // A close fills late, for the size open when it was sent (a market order): two would leave the account short.
  const w = world('2026-10-07T19:48:00Z', { holdCloses: true, closeSizedAtSend: true });
  openLong(w);
  let sentAt = null;
  const r = await runDay(w, {
    from: '2026-10-07T19:49:30Z', until: '2026-10-07T19:55:00Z',
    // The broker fills a close about 8 s after it accepted it (the runner steps 5 s apart: seen on the next step, filled 3 s on).
    before: t => {
      const s = exchange.read(w.state);
      if (s.held.length && sentAt === null) sentAt = t;
      if (sentAt !== null && t - sentAt >= 3000) { exchange.settle(w.state); sentAt = null; }
    },
  });
  assert.strictEqual(exchange.read(w.state).calls.filter(c => c.tool === 'close_position').length, 1);
  assert.strictEqual(position(w), null, 'flat, not short');
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
});

test('mock trading: a position whose size can\'t be read is flattened at end of day, never read as flat', async () => {
  const w = world('2026-10-07T19:48:00Z');
  openLong(w);
  exchange.update(w.state, s => { s.oddSize = true; });
  const r = await runDay(w, { from: '2026-10-07T19:49:30Z', until: '2026-10-07T19:54:00Z' });
  assert.strictEqual(position(w), null);
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
});

test('mock trading: on a holiday nothing trades and anything open is flattened; on an early close end of day comes at 12:50 ET', async () => {
  const holiday = world('2026-07-03T13:00:00Z');
  openLong(holiday);
  const h = await runDay(holiday, { from: '2026-07-03T13:30:00Z', until: '2026-07-03T13:45:00Z' });
  assert.deepStrictEqual(h.runs.filter(x => x[0] === 'trade'), [], 'no trade cycles on a holiday');
  assert.strictEqual(position(holiday), null, 'the outside-hours sweep closed it');

  const early = world('2026-11-27T17:40:00Z');
  openLong(early);
  const e = await runDay(early, { from: '2026-11-27T17:45:00Z', until: '2026-11-27T18:00:00Z', cfg: { earlyCloseEodAt: '12:50@America/New_York' } });
  const eod = e.runs.find(x => x[0] === 'eod');
  assert.ok(eod && eod[1] >= '2026-11-27T17:50:00' && eod[1] < '2026-11-27T17:52:00', JSON.stringify(e.runs));
  assert.strictEqual(position(early), null);
  assert.ok(!e.runs.some(x => x[0] === 'trade' && x[1] >= '2026-11-27T18:00:00'), 'no cycles after the early close');
});

test('mock trading: a winner at its target: the stop goes with it (OCO), the profit is in the fills', async () => {
  const w = world(new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString());
  const t = await enterBos(w, { target: true });
  exchange.setPrice(w.state, MNQ_ID, t.price + 2 * t.risk + 1);
  assert.strictEqual(position(w), null);
  assert.deepStrictEqual(working(w), []);
  const exit = exchange.read(w.state).fills.at(-1);
  assert.strictEqual(exit.price, t.price + 2 * t.risk);
  assert.strictEqual(exit.profitAndLoss, 2 * t.risk * 2, '2R on MNQ at $2 a point');
});

test('mock trading: the runner trails a winner\'s stop through the gateway (2R on, 0.5R back), and the trailed stop banks the profit', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000);
  const w = world(at.toISOString());
  const t = await enterBos(w);
  // From here the broker's bars follow the price this test sets (the entry's regime check read the real ones).
  exchange.update(w.state, s => { delete s.bars; });
  const startStop = working(w).find(o => o.type === 4).stopPrice;
  assert.strictEqual(startStop, t.stop);
  const up = t.price + 3 * t.risk;
  const r = await runDay(w, {
    from: new Date(at.getTime() + 1000).toISOString(), until: new Date(at.getTime() + 20 * 60000).toISOString(),
    before: ms => {
      // Up 3R after 4 minutes; after 12 minutes back down through where the trail left the stop.
      if (ms >= at.getTime() + 4 * 60000 && ms < at.getTime() + 12 * 60000) exchange.setPrice(w.state, MNQ_ID, up);
      // Then a quarter point under wherever the trail has the stop: it fills there.
      if (ms >= at.getTime() + 12 * 60000 && position(w)) exchange.setPrice(w.state, MNQ_ID, working(w).find(o => o.type === 4).stopPrice - 0.25);
    },
  });
  const moves = exchange.read(w.state).calls.filter(c => c.tool === 'modify_order');
  assert.ok(moves.length >= 1, `the runner moved the stop: ${r.logs.filter(l => /ERROR/.test(l)).join(' | ')}`);
  assert.ok(moves.every(m => m.args.stopPrice > startStop), 'only ever toward the market');
  assert.strictEqual(position(w), null, 'out on the trailed stop');
  const exit = exchange.read(w.state).fills.at(-1);
  assert.ok(exit.price >= t.price + 2 * t.risk, `the trail held at least 2R (exit ${exit.price}, entry ${t.price}, 1R ${t.risk})`);
  assert.ok(exit.profitAndLoss > 0);
  assert.ok(r.events.some(e => e.kind === 'position_managed' && e.setup === 'bos'));
});

test('mock trading: a close the broker refuses frees its stop; one whose reply errors (it may have filled) still holds it', async () => {
  for (const reply of ['refuse', 'error']) {
    const w = world('2026-10-07T14:30:00Z', { closeReply: reply });
    exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
    const stopId = working(w).find(o => o.type === 4).id;
    const gw = gatewayClient(w);
    try {
      const close = await attempt(gw, 'close_position', { accountId: 7, contractId: 'MNQ' });
      assert.strictEqual(position(w).size, 1, `${reply}: not filled yet`);
      const tighten = await attempt(gw, 'modify_order', { accountId: 7, orderId: stopId, stopPrice: 21495 });
      if (reply === 'refuse') {
        assert.deepStrictEqual([close.ok, close.result.success], [true, false]);
        assert.ok(tighten.ok, `refused: the position stays, and so does its stop to manage: ${tighten.error}`);
      } else {
        assert.match(close.error, /HTTP 504/);
        assert.match(tighten.error, /modify-entry.*once recent orders fill/, 'an unknown outcome counts as a close');
        // ... but never to unprotect a position the account still shows.
        assert.match((await attempt(gw, 'cancel_order', { accountId: 7, orderId: stopId })).error, /cancel-protection/);
        exchange.settle(w.state);
        assert.strictEqual(position(w), null, 'the broker had taken it');
      }
    } finally {
      gw.close();
    }
  }
});

test('mock trading: a gateway started on a raw broker server (no translator) compares names as the server gives them', async () => {
  const w = world('2026-10-07T14:30:00Z');
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1 }, {});
  // The translator has learned the contracts (another process's normal start).
  const normal = gatewayClient(w);
  await normal.call('search_contracts', { searchText: 'MNQ' });
  normal.close();
  const raw = createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js'), '--', process.execPath, SERVER], env: w.env, cwd: ROOT, timeoutMs: 20000 });
  try {
    const protect = await attempt(raw, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'sell', type: 'stop', size: 1, stopPrice: 21490, rationale: '[protect] stop for the long' });
    assert.ok(protect.ok, protect.error);
    assert.strictEqual(working(w).find(o => o.type === 4).stopPrice, 21490);
  } finally {
    raw.close();
  }
});

test('mock trading: an entry whose reply is lost is an order of unknown outcome: no second entry, the exit still goes', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString();
  // The broker takes the entry, its reply is lost, and its order list doesn't show it yet.
  const w = world(at, { loseEntryReply: true, hideOrders: true });
  w.env.FTH_LANE_TIMEOUT_MS = '1500';
  const sig = signalOnFiredBar(w);
  const entry = {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: sig.ticks, type: 'stop' },
    rationale: `setup:bos long trigger on the closed bar, stop ${(sig.price - sig.ticks * 0.25).toFixed(2)}`,
  };
  const gw = createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js')], env: w.env, cwd: ROOT, timeoutMs: 4000 });
  try {
    const first = await attempt(gw, 'place_order', entry);
    assert.ok(!first.ok, 'no reply');
    assert.strictEqual(position(w).size, 1, 'the broker took it');
    exchange.update(w.state, s => { s.loseEntryReply = false; });
    const second = await attempt(gw, 'place_order', entry);
    assert.ok(!second.ok);
    assert.ok(lastBlock(w).some(v => v.check === 'order-pending'), JSON.stringify(lastBlock(w)));
    assert.strictEqual(exchange.read(w.state).calls.filter(c => c.tool === 'place_order').length, 1, 'never sent twice');
    // Once the broker lists it (by the customTag the gateway gave it), it is settled as placed: no longer pending.
    exchange.update(w.state, s => { s.hideOrders = false; });
    const third = await attempt(gw, 'place_order', entry);
    assert.ok(!third.ok);
    assert.deepStrictEqual(lastBlock(w).map(v => v.check).filter(c => c === 'order-pending'), [], JSON.stringify(lastBlock(w)));
    assert.ok(lastBlock(w).some(v => v.check === 'position-open'));
    assert.ok(exchange.read(w.state).orders[0].customTag, 'the gateway tagged it');
    const exit = await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten the unknown entry' });
    assert.ok(exit.ok, exit.error);
    assert.strictEqual(position(w), null);
  } finally {
    gw.close();
  }
});

test('mock trading: a short through its life: its stop moves only down, a partial close over it is refused, a gap up fills worse', async () => {
  const w = world('2026-10-07T14:30:00Z');
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'sell', type: 'market', size: 1, stopLossBracket: { ticks: 40 }, takeProfitBracket: { ticks: 80 } }, {});
  const stop = working(w).find(o => o.type === 4);
  assert.deepStrictEqual([position(w).type, stop.side, stop.stopPrice], [2, 0, 21510], 'short 1 @ 21500, buy stop 40 ticks above');
  assert.strictEqual(working(w).find(o => o.type === 1).limitPrice, 21480, 'target 80 ticks below');
  const gw = gatewayClient(w);
  try {
    assert.match((await attempt(gw, 'modify_order', { accountId: 7, orderId: stop.id, stopPrice: 21520 })).error, /modify-protection/);
    assert.ok((await attempt(gw, 'modify_order', { accountId: 7, orderId: stop.id, stopPrice: 21505 })).ok);
    assert.match((await attempt(gw, 'partial_close_position', { accountId: 7, contractId: 'MNQ', size: 2 })).error, /partial-close/);
    // A sell would add to the short: no exit.
    assert.match((await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten' })).error, /exposure/);
  } finally {
    gw.close();
  }
  exchange.setPrice(w.state, MNQ_ID, 21508);
  assert.strictEqual(position(w), null);
  const exit = exchange.read(w.state).fills.at(-1);
  assert.deepStrictEqual([exit.side, exit.price, exit.profitAndLoss], [0, 21508, -16], 'bought back 8 points higher: -$16 on MNQ');
  assert.deepStrictEqual(working(w), [], 'the target went with it (OCO)');
});

/** A round trip at the broker: long 1 at the market, closed `points` away (a loss when negative). */
function roundTrip(w, points) {
  const price = exchange.read(w.state).prices[MNQ_ID];
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1 }, {});
  exchange.update(w.state, s => { s.prices[MNQ_ID] = price + points; });
  exchange.handle(w.state, 'close_position', { accountId: 7, contractId: MNQ_ID }, {});
  exchange.update(w.state, s => { s.prices[MNQ_ID] = price; });
}

const placed = w => exchange.read(w.state).calls.filter(c => c.tool === 'place_order').length;

/** A valid bos long on the fired bar (records and plan written), as an agent would send it. */
function bosEntry(sig, extra = {}) {
  const stop = sig.price - sig.ticks * 0.25;
  return {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: sig.ticks, type: 'stop' },
    rationale: `setup:bos long trigger on the closed bar, stop ${stop.toFixed(2)}`, ...extra,
  };
}

test('mock trading: losses counted from the broker\'s own fills stop new entries (a losing streak, then the day\'s loss count); a winner resets the streak', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString();
  // Three losing round trips this session: the journal knows nothing of them; the fills do.
  const w = world(at);
  const sig = signalOnFiredBar(w);
  for (let i = 0; i < 3; i += 1) roundTrip(w, -5);
  assert.deepStrictEqual(exchange.read(w.state).fills.filter(f => f.profitAndLoss !== null).map(f => f.profitAndLoss), [-10, -10, -10], '5 points on MNQ: -$10 each');
  const gw = gatewayClient(w);
  try {
    const before = placed(w);
    const r = await attempt(gw, 'place_order', bosEntry(sig));
    assert.ok(!r.ok);
    const checks = lastBlock(w).map(v => v.check);
    assert.ok(checks.includes('loss-streak') && checks.includes('daily-loss-count'), JSON.stringify(lastBlock(w)));
    assert.match(lastBlock(w).find(v => v.check === 'daily-loss-count').message, /3 losing closes this trading day \(from fills; limit 3\)/);
    assert.strictEqual(placed(w), before, 'never sent');
    // An exit still goes.
    exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1 }, {});
    assert.ok((await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] done for the day' })).ok);
  } finally {
    gw.close();
  }

  // The trading day starts at the 18:00 ET open, not at midnight. `at` is 00:12 ET Tuesday: the same three losses
  // at 15:00 ET Monday (Monday's day) don't count; at 19:00 ET Monday (Tuesday's day, the evening before) they do.
  const lossesAt = async iso => {
    const w3 = world(at);
    const sig3 = signalOnFiredBar(w3);
    exchange.update(w3.state, s => { s.nowMs = Date.parse(iso); });
    for (let i = 0; i < 3; i += 1) roundTrip(w3, -5);
    exchange.update(w3.state, s => { s.nowMs = Date.parse(at); });
    const gw3 = gatewayClient(w3);
    try {
      return { r: await attempt(gw3, 'place_order', bosEntry(sig3)), w: w3 };
    } finally {
      gw3.close();
    }
  };
  const before = await lossesAt('2026-04-27T19:00:00Z'); // Monday 15:00 ET
  assert.ok(before.r.ok, `losses on the previous trading day: ${before.r.error}`);
  const evening = await lossesAt('2026-04-27T23:00:00Z'); // Monday 19:00 ET
  assert.ok(!evening.r.ok, 'losses since the 18:00 ET open are today\'s');
  assert.ok(lastBlock(evening.w).some(v => v.check === 'daily-loss-count'), JSON.stringify(lastBlock(evening.w)));

  // Two losses, then a winner: no streak, under the day's limit: the same entry goes.
  const w2 = world(at);
  const sig2 = signalOnFiredBar(w2);
  roundTrip(w2, -5);
  roundTrip(w2, -5);
  roundTrip(w2, 8);
  const gw2 = gatewayClient(w2);
  try {
    const ok = await attempt(gw2, 'place_order', bosEntry(sig2));
    assert.ok(ok.ok, ok.error);
    assert.strictEqual(position(w2).size, 1);
  } finally {
    gw2.close();
  }
});

test('mock trading: a missing or malformed bracket and inconsistent prices are refused before the broker sees them; an [exit] can\'t carry a bracket', async () => {
  const at = new Date(Date.parse(FIRED_BAR) + STEP + 20000).toISOString();
  const w = world(at);
  const sig = signalOnFiredBar(w);
  const stop = sig.price - sig.ticks * 0.25;
  const gw = gatewayClient(w);
  try {
    const bad = [
      ['zero ticks', bosEntry(sig, { stopLossBracket: { ticks: 0, type: 'stop' } }), /stopLossBracket\.ticks must be a whole number of ticks above 0 \(got 0\)/],
      ['negative ticks', bosEntry(sig, { stopLossBracket: { ticks: -40, type: 'stop' } }), /stopLossBracket\.ticks must be a whole number/],
      ['a fraction of a tick', bosEntry(sig, { stopLossBracket: { ticks: 2.5, type: 'stop' } }), /stopLossBracket\.ticks must be a whole number/],
      ['a target bracket of 0', bosEntry(sig, { takeProfitBracket: { ticks: 0, type: 'limit' } }), /takeProfitBracket\.ticks must be a whole number/],
      ['target below the stop on a long', bosEntry(sig, { rationale: `setup:bos long trigger on the closed bar, stop ${(sig.price + 10).toFixed(2)}, target ${(sig.price - 10).toFixed(2)}` }),
        /a long needs the target above the stop/],
      ['a stop off the tick', bosEntry(sig, { rationale: `setup:bos long trigger on the closed bar, stop ${(stop + 0.1).toFixed(2)}` }), /stop .* is not on the 0\.25 tick/],
      ['a limit entry with its stop above it', bosEntry(sig, { type: 'limit', limitPrice: sig.price, rationale: `setup:bos long trigger on the closed bar, stop ${(sig.price + 5).toFixed(2)}` }),
        /the stop .* is on the wrong side of the buy entry/],
      ['brackets that don\'t span the stated stop and target', bosEntry(sig, {
        takeProfitBracket: { ticks: sig.ticks * 3, type: 'limit' },
        rationale: `setup:bos long trigger on the closed bar, stop ${stop.toFixed(2)}, target ${(sig.price + sig.ticks * 0.25).toFixed(2)}`,
      }), /the brackets span/],
    ];
    for (const [label, order, why] of bad) {
      const r = await attempt(gw, 'place_order', order);
      assert.ok(!r.ok, label);
      const v = lastBlock(w).find(x => x.check === 'order-consistency');
      assert.ok(v, `${label}: ${JSON.stringify(lastBlock(w))}`);
      assert.match(v.message, why, label);
    }
    // No bracket, the stop only in the rationale: no entry (every entry carries its stop as stopLossBracket).
    const unbracketed = await attempt(gw, 'place_order', bosEntry(sig, { stopLossBracket: undefined }));
    assert.ok(!unbracketed.ok);
    assert.ok(lastBlock(w).some(v => v.check === 'stop-defined' && /every entry carries its stop as stopLossBracket/.test(v.message)), JSON.stringify(lastBlock(w)));
    assert.strictEqual(placed(w), 0, 'none reached the broker');
    // The well-formed entry goes.
    const good = await attempt(gw, 'place_order', bosEntry(sig));
    assert.ok(good.ok, good.error);
    // An exit with a bracket would leave a working leg behind: refused. Without one it goes.
    const exitWithBracket = await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: '[exit] flatten' });
    assert.ok(!exitWithBracket.ok);
    assert.ok(lastBlock(w).some(v => v.check === 'exposure' && /take no stopLossBracket\/takeProfitBracket/.test(v.message)), JSON.stringify(lastBlock(w)));
    assert.ok((await attempt(gw, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten' })).ok);
    assert.strictEqual(position(w), null);
  } finally {
    gw.close();
  }
});

test('mock trading: a prop attempt\'s close is recorded at end of day once the account reads flat, at the broker\'s balance after the closing fill', async () => {
  const w = world('2026-10-07T19:30:00Z', { balance: 100000, dropCloses: 1 });
  prop.startAttempt(w.home, propAccount(), new Date('2026-10-07T13:00:00Z'));
  openLong(w);
  exchange.update(w.state, s => { s.prices[MNQ_ID] = 21495; }); // 5 points under the 21500 entry, above the 21490 stop
  const r = await runDay(w, { from: '2026-10-07T19:45:00Z', until: '2026-10-07T19:56:00Z', withProp: true });
  assert.strictEqual(position(w), null);
  const balance = exchange.read(w.state).balance;
  assert.strictEqual(balance, 100000 - 10 - 0.37 * 2, '-$10 on the trade, fees both sides');
  const rec = prop.readAttempt(w.home, PROP_ACCOUNT);
  assert.deepStrictEqual(rec.days.map(d => [d.day, d.balance]), [['2026-10-07', balance]]);
  // Recorded after the lost close was sent again and the account read flat, never before.
  const kinds = r.events.map(e => e.kind);
  assert.ok(!kinds.includes('close_record_failed'), 'never tried while a position was open');
  assert.ok(kinds.indexOf('close_recorded') > kinds.indexOf('flatten_verified') && kinds.indexOf('flatten_verified') > kinds.indexOf('flatten_unverified'), kinds.join(','));
});

test('mock trading: a close the runner can\'t record (the balance can\'t be read) is a missed close: the next day the prop attempt is blocked until it is recorded', async () => {
  const w = world('2026-10-07T19:30:00Z', { balance: 100000 });
  prop.startAttempt(w.home, propAccount(), new Date('2026-10-07T13:00:00Z'));
  // The day trades (a snapshot is taken), then the broker's balance goes unreadable through end of day.
  await runDay(w, { from: '2026-10-07T19:40:00Z', until: '2026-10-07T19:49:30Z', withProp: true });
  exchange.update(w.state, s => { s.failBalance = true; });
  const eod = await runDay(w, { from: '2026-10-07T19:49:30Z', until: '2026-10-07T20:10:00Z', withProp: true });
  assert.ok(eod.events.some(e => e.kind === 'close_record_failed'));
  assert.deepStrictEqual(prop.readAttempt(w.home, PROP_ACCOUNT).days, []);
  // The next morning the balance reads again: the runner's snapshot finds yesterday's close missing.
  exchange.update(w.state, s => { s.failBalance = false; });
  const at = '2026-10-08T13:45:00Z';
  await runDay(w, { from: '2026-10-08T13:40:00Z', until: at, withProp: true });
  const block = prop.combineBlock(w.home, PROP_ACCOUNT, new Date(at));
  assert.match(block || '', /the close of 2026-10-07 was never recorded/);
  // Recording it (combine.js record-day) clears the block.
  prop.recordEndOfDay(w.home, propAccount(), 100000, '2026-10-07');
  assert.doesNotMatch(prop.combineBlock(w.home, PROP_ACCOUNT, new Date(at)) || '', /never recorded/);
});

test('mock trading: a runner that crashed mid-day catches up the next morning: it flattens, reviews and records the missed day first, then trades the new one', async () => {
  const w = world('2026-10-07T14:00:00Z', { balance: 100000 });
  prop.startAttempt(w.home, propAccount(), new Date('2026-10-07T13:00:00Z'));
  openLong(w);
  // Day 1: the runner trades a few bars, then dies with the position open (no end of day).
  const day1 = await runDay(w, { from: '2026-10-07T14:00:30Z', until: '2026-10-07T14:15:00Z', withProp: true });
  assert.ok(day1.runs.some(x => x[0] === 'trade'), 'it traded');
  assert.ok(position(w), 'still open when it died');
  // The balance that day closed at (the open long's fees only), then the market falls 8 points overnight.
  const closeOfDay1 = exchange.read(w.state).balance;
  exchange.update(w.state, x => { x.prices[MNQ_ID] = 21492; });
  // Day 2, 08:00 ET: a new runner starts from the saved day state.
  const day2 = await runDay(w, { from: '2026-10-08T12:00:30Z', until: '2026-10-08T12:20:00Z', withProp: true });
  const first = day2.runs[0];
  assert.strictEqual(first[0], 'eod', JSON.stringify(day2.runs.map(x => x.slice(0, 2))));
  assert.match(first[2], /for the trading day ending 2026-10-07 \(a catch-up/);
  assert.strictEqual(position(w), null, 'flattened before anything else');
  const closes = exchange.read(w.state).calls.filter(c => c.tool === 'close_position');
  assert.ok(closes.length >= 1);
  // The missed day's close is its own balance: the overnight loss (-$16, fees) belongs to the day it was booked on.
  assert.deepStrictEqual(prop.readAttempt(w.home, PROP_ACCOUNT).days.map(d => [d.day, d.balance]), [['2026-10-07', closeOfDay1]]);
  assert.strictEqual(exchange.read(w.state).balance, Math.round((closeOfDay1 - 16 - 0.37) * 100) / 100, 'booked on day 2');
  assert.ok(day2.runs.some(x => x[0] === 'trade' && x[1] > first[1]), 'then the new day trades');

  // The same crash before a holiday: the catch-up still flattens; the holiday doesn't trade.
  const h = world('2026-11-25T14:00:00Z', { balance: 100000 });
  openLong(h);
  await runDay(h, { from: '2026-11-25T14:00:30Z', until: '2026-11-25T14:15:00Z' });
  const thanksgiving = await runDay(h, { from: '2026-11-26T14:00:30Z', until: '2026-11-26T14:20:00Z' });
  assert.strictEqual(thanksgiving.runs[0][0], 'eod');
  assert.match(thanksgiving.runs[0][2], /trading day ending 2026-11-25 \(a catch-up/);
  assert.deepStrictEqual(thanksgiving.runs.filter(x => x[0] === 'trade'), []);
  assert.strictEqual(position(h), null);
});
