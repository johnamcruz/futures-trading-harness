'use strict';

// Golden regression: the order gate's verdicts. A fixed set of orders - entries that pass and every kind of
// refusal, exits and protective orders, stop moves and size changes, the prop checks (combine, policy), and
// the gateway's account checks (exits that must reduce a real position, cancels, modifies, partial closes) -
// each with its verdict pinned: allowed or refused, the intent, and every check code and message in order.
// A changed reason, a check that stops firing, or a new one shows as a golden diff.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { evaluateOrder, evaluateModify } = require('../../scripts/lib/trading/order-gate');
const AG = require('../../scripts/lib/trading/account-gate');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { NOW, CONTRACT, minutesAgo, plan, placed, review, entryOrder: anyEntry, trendHome: anyHome, tmpDir, writeJournal, recordBrokerSpecs, FX_GOLDEN } = require('../helpers');
const { checkOrder } = require('../../scripts/lib/trading/check-order');
const { createServerAttestation } = require('../../scripts/lib/broker/allow-list');

// The shipped strategies (prop_portfolio, with no components) and the retired rules strategies as fixtures
// (tests/fixtures/strategies-golden): entries are tagged with the fixture fx_orb, the retired orb's rules.
const SHIPPED = loadStrategies(G.ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies;
const FIRED = [{ name: 'fx_orb', direction: 'long' }];
/** tests/helpers.js trendHome with fx_orb fired long (unless `fired` says otherwise). */
const trendHome = (home, opts = {}) => anyHome(home, { fired: FIRED, ...opts });
/** tests/helpers.js entryOrder tagged setup:fx_orb. */
const entryOrder = (extra = {}) => anyEntry({ rationale: 'setup:fx_orb break above OR high 21500, stop 21480, target 21540, risk $40', ...extra });
// As tests/lib/order-gate.test.js: a home with an up-trend record and fx_orb fired long; record ages unlimited.
const BASE = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home: trendHome(), mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
const gate = (input, entries, { now = NOW, config = BASE, blackouts, strategies = SHIPPED, accounts, journalTruncated } = {}) =>
  evaluateOrder({ input, entries, now, config, blackouts, strategies, accounts, journalTruncated });

// The prop challenge (as order-gate.test.js): a mini account, a policy strategy tagged setup:fx_orb over fx_cross.
const BAR = '2026-10-07T13:57:00Z';
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 },
};
const POLICY = { name: 'fx_orb', valid: true, errors: [], status: 'active', instruments: ['MNQ', 'NQ'], signal: 'policy', compiledRules: null, strategies: ['fx_cross'], account: 'mini', contracts: 'micro', timeframe: '3m' };
const EMA_CROSS = { name: 'fx_cross', valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ', 'NQ'], timeframe: '3m', mtf: 'trend' };
function propGate({ balance = 50000, policy = false, verdict = policy ? null : {} } = {}) {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  if (balance !== null) prop.snapshot(home, MINI, balance, new Date(NOW.getTime() - 60000));
  if (verdict) {
    prop.appendVerdict(home, {
      strategy: 'fx_orb', component: 'fx_cross', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
      maxSize: policy ? 3 : 50, bar: BAR, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(), ...verdict,
    });
  }
  return (input, { now = NOW } = {}) => gate(input, [plan()], { now, config: { ...BASE, home }, strategies: [POLICY, EMA_CROSS], accounts: [MINI] });
}

/** The gate with the shipped strategies and accounts and an attempt running on the shipped prop_portfolio's account. */
function shippedPolicyGate() {
  const accounts = loadAccounts(G.ROOT, {}).accounts;
  const acct = accounts.find(a => a.name === SHIPPED.find(s => s.name === 'prop_portfolio').account);
  const home = trendHome();
  prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, acct, acct.starting_balance, new Date(NOW.getTime() - 60000));
  return input => gate(input, [plan()], { config: { ...BASE, home }, accounts });
}

const killed = (() => { const f = path.join(tmpDir(), 'STOP'); fs.writeFileSync(f, ''); return { ...BASE, killSwitchFile: f }; })();
const at = iso => ({ now: new Date(iso) });
const ago = (iso, m) => new Date(Date.parse(iso) - m * 60000).toISOString();
const sell = (rationale, extra = {}) => entryOrder({ side: 'sell', rationale, ...extra });

/** [label, () => { intent, violations }] : the order gate (hook and gateway), in a fixed order. */
const ORDER_GATE = [
  ['entry: planned, tagged, bracketed (allowed)', () => gate(entryOrder(), [plan()])],
  ['entry: no tag, no bracket, no plan', () => gate(entryOrder({ rationale: 'looks strong, going long here', stopLossBracket: undefined }), [])],
  ['entry: stop only in the rationale', () => gate(entryOrder({ stopLossBracket: undefined, rationale: 'setup:fx_orb long, stop at 21480.25, target 21540' }), [plan()])],
  ['entry: a limit leg as the bracket', () => gate(entryOrder({ stopLossBracket: { ticks: 40, type: 'limit' } }), [plan()])],
  ['entry: a stale plan', () => gate(entryOrder(), [plan(121)])],
  ['entry: the tag not first', () => gate(entryOrder({ rationale: 'long setup:fx_orb, stop 21480' }), [plan()])],
  ['entry: paper mode', () => gate(entryOrder(), [plan()], { config: { ...BASE, paper: true } })],
  ['entry: the journal window truncated', () => gate(entryOrder(), [plan(5)], { journalTruncated: true })],
  ['entry: the opening print', () => gate(entryOrder(), [plan(1, { ts: '2026-10-07T13:31:00Z' })], { ...at('2026-10-07T13:32:00Z'), config: { ...BASE, home: trendHome(undefined, { closedAt: '2026-10-07T13:27:00.000Z' }) } })],
  ['entry: into the close', () => gate(entryOrder(), [plan(1, { ts: '2026-10-07T19:49:00Z' })], at('2026-10-07T19:50:00Z'))],
  ['entry: the market closed', () => gate(entryOrder(), [plan(1, { ts: ago('2026-10-07T20:05:00Z', 1) })], at('2026-10-07T20:05:00Z'))],
  ['entry: a news blackout', () => gate(entryOrder(), [plan()], { blackouts: { items: [{ start: minutesAgo(5), end: minutesAgo(-10), reason: 'CPI' }] } })],
  ['entry: an unreadable blackouts file', () => gate(entryOrder(), [plan()], { blackouts: { items: [], error: 'invalid JSON' } })],
  ['entry: two losses in a row (cooldown)', () => gate(entryOrder(), [plan(100), placed(90), review(80, 'loss'), placed(70), review(20, 'loss'), plan(5)])],
  ['entry: three losing trades today', () => gate(entryOrder(), [placed(200), review(190, 'loss'), placed(180), review(170, 'win'), placed(160), review(150, 'loss'), placed(140), review(130, 'win'), placed(120), review(100, 'loss'), plan(5)])],
  ['entry: the last entry not reviewed', () => gate(entryOrder(), [placed(30), plan(5)])],
  ['entry: the kill switch on', () => gate(entryOrder(), [plan()], { config: killed })],
  ['entry: an unknown strategy', () => gate(entryOrder({ rationale: 'setup:nope long, stop 21480' }), [plan()])],
  ['entry: a retired strategy (orb, 2026-10-14)', () => gate(entryOrder({ rationale: 'setup:orb long, stop 21480' }), [plan()], { config: { ...BASE, home: trendHome(undefined, { fired: [{ name: 'orb', direction: 'long' }] }) } })],
  ['entry: the shipped prop_portfolio with no verdict on a compose record (an attempt running)', () => shippedPolicyGate()(entryOrder({ rationale: 'setup:prop_portfolio long, stop 21480' }))],
  ['exit: under the shipped prop_portfolio, an attempt running (allowed)', () => shippedPolicyGate()(sell('[exit] flatten'))],
  ['entry: the side named is not the order side', () => gate(entryOrder({ rationale: 'setup:fx_orb short break, stop 21520' }), [plan()])],
  ['entry: stop on the wrong side of a limit entry', () => gate(entryOrder({ type: 'limit', limitPrice: 21500, rationale: 'setup:fx_orb long, stop 21510, target 21540' }), [plan()])],
  ['entry: against the prevailing trend', () => gate(entryOrder(), [plan()], { config: { ...BASE, home: trendHome(undefined, { biases: { 240: -1, 60: -1, 15: -1 } }) } })],
  ['entry: its trigger did not fire', () => gate(entryOrder(), [plan()], { config: { ...BASE, home: trendHome(undefined, { fired: [] }) } })],
  ['entry: no tick specs from the broker', () => gate(entryOrder(), [plan()], { config: { ...BASE, home: trendHome(undefined, { specs: false }) } })],
  ['entry: over the broker\'s max order size', () => gate(entryOrder({ size: 51 }), [plan()])],
  ['exit: flatten (allowed, never gated)', () => gate(sell('[exit] flatten'), [])],
  ['exit: with the kill switch on (allowed)', () => gate(sell('[exit] flatten'), [], { config: killed })],
  ['exit: market closed, paper, truncated journal (allowed)', () => gate(sell('[exit] flatten'), [], { ...at('2026-10-07T20:05:00Z'), config: { ...BASE, paper: true }, journalTruncated: true })],
  ['protect: a protective stop (allowed)', () => gate(sell('[protect] stop for the filled long', { type: 'stop', stopPrice: 21480 }), [])],
  ['protect: with no tick specs (allowed)', () => gate(sell('[protect] stop', { type: 'stop', stopPrice: 21480 }), [], { config: { ...BASE, home: trendHome(undefined, { specs: false }) } })],
  ['protect: with a bracket (allowed by this gate; the gateway refuses it)', () => gate(sell('[protect] stop', { type: 'stop', stopPrice: 21480, stopLossBracket: { ticks: 40, type: 'stop' } }), [])],
  ['modify: a size change without a reason', () => evaluateModify({ input: { orderId: 1, size: 1 }, config: BASE })],
  ['modify: a size change with a [protect] reason (allowed)', () => evaluateModify({ input: { orderId: 1, size: 1, reason: '[protect] cut the stop to 1 after scaling out' }, config: BASE })],
  ['modify: a stop move (allowed)', () => evaluateModify({ input: { orderId: 1, stopPrice: 21490 }, config: BASE })],
  ['prop: no attempt started', () => gate(entryOrder(), [plan()], { config: { ...BASE, home: trendHome() }, strategies: [POLICY, EMA_CROSS], accounts: [MINI] })],
  ['prop: no account snapshot', () => propGate({ balance: null })(entryOrder())],
  ['prop: a stale snapshot', () => propGate()(entryOrder(), { now: new Date(NOW.getTime() + 11 * 60000) })],
  ['prop: within the size budget (allowed)', () => propGate()(entryOrder({ size: 18 }))],
  ['prop: over the size budget', () => propGate()(entryOrder({ size: 19 }))],
  ['prop: past the soft daily limit', () => propGate({ balance: 49400 })(entryOrder())],
  ['policy: no verdict', () => propGate({ policy: true })(entryOrder())],
  ['policy: within its verdict (allowed)', () => propGate({ policy: true, verdict: {} })(entryOrder({ size: 3 }))],
  ['policy: over the verdict\'s size', () => propGate({ policy: true, verdict: {} })(entryOrder({ size: 4 }))],
  ['policy: another stop than the verdict\'s', () => propGate({ policy: true, verdict: {} })(entryOrder({ stopLossBracket: { ticks: 60, type: 'stop' } }))],
  ['policy: the other side', () => propGate({ policy: true, verdict: {} })(entryOrder({ side: 'sell' }))],
  ['policy: an expired verdict', () => propGate({ policy: true, verdict: {} })(entryOrder(), { now: new Date(NOW.getTime() + 3 * 60000) })],
  ['policy: a skipped setup', () => propGate({ policy: true, verdict: { action: 'skip', maxSize: 0, reason: 'cushion' } })(entryOrder())],
  ['prop: an exit during an attempt (allowed)', () => propGate({ balance: 49000 })(sell('[exit] flatten'))],
];

// The gateway's account checks (account-gate.js), over the live account it reads.
const long1 = [{ contractId: CONTRACT, type: 1, size: 1 }];
const restingStop = { id: 11, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 };
const order = (extra = {}) => ({ accountId: 1, contractId: CONTRACT, side: 'buy', type: 'market', size: 1, rationale: 'setup:fx_orb long, stop 1', ...extra });
const account = o => ({ violations: AG.evaluateAccount({ positions: [], orders: [], trades: [], config: BASE, now: NOW, ...o }) });
const ACCOUNT_GATE = [
  ['account: an entry while flat (allowed)', () => account({ input: order() })],
  ['account: an entry while a position is open', () => account({ input: order(), positions: long1 })],
  ['account: an [exit] while flat', () => account({ input: order({ rationale: '[exit] take profit' }) })],
  ['account: an [exit] on the position\'s side', () => account({ input: order({ rationale: '[exit] take profit' }), positions: long1 })],
  ['account: an [exit] larger than the position', () => account({ input: order({ side: 'sell', size: 2, rationale: '[exit] x' }), positions: long1 })],
  ['account: an [exit] that reduces it (allowed)', () => account({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1 })],
  ['account: a second resting [protect] stop', () => account({ input: order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop' }), positions: long1, orders: [restingStop] })],
  ['account: an [exit] with a bracket', () => account({ input: order({ side: 'sell', rationale: '[exit] x', stopLossBracket: { ticks: 40, type: 'stop' } }), positions: long1 })],
  ['account: two losses from real fills', () => account({ input: order(), trades: [{ contractId: CONTRACT, creationTimestamp: minutesAgo(30), profitAndLoss: -50 }, { contractId: CONTRACT, creationTimestamp: minutesAgo(10), profitAndLoss: -40 }] })],
  ['cancel: the last protective stop', () => ({ violations: AG.evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [restingStop], config: BASE, now: NOW }) })],
  ['cancel: a target, the stop stays (allowed)', () => ({ violations: AG.evaluateCancel({ input: { orderId: 12 }, positions: long1, orders: [restingStop, { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 1, limitPrice: 21540 }], config: BASE, now: NOW }) })],
  ['modify: a stop moved toward the market (allowed)', () => ({ violations: AG.evaluateModifyAccount({ input: { orderId: 11, stopPrice: 21490 }, positions: long1, orders: [restingStop], config: BASE, ledger: [], now: NOW }) })],
  ['modify: a stop moved away from the market', () => ({ violations: AG.evaluateModifyAccount({ input: { orderId: 11, stopPrice: 21470 }, positions: long1, orders: [restingStop], config: BASE, ledger: [], now: NOW }) })],
  ['partial close: within the position (allowed)', () => ({ violations: AG.evaluatePartialClose({ input: { accountId: 1, contractId: CONTRACT, size: 1 }, positions: long1, orders: [], config: BASE, ledger: [], now: NOW }) })],
  ['partial close: over the position', () => ({ violations: AG.evaluatePartialClose({ input: { accountId: 1, contractId: CONTRACT, size: 5 }, positions: long1, orders: [], config: BASE, ledger: [], now: NOW }) })],
  ['partial close: no position', () => ({ violations: AG.evaluatePartialClose({ input: { accountId: 1, contractId: CONTRACT, size: 1 }, positions: [], orders: [], config: BASE, ledger: [], now: NOW }) })],
];

function verdictText(cases) {
  return cases.map(([label, run]) => {
    const r = run();
    const v = r.violations || [];
    const head = `${label}: ${v.length ? 'REFUSED' : 'ALLOWED'}${r.intent ? ` (intent ${r.intent})` : ''}`;
    return [head, ...v.map(x => `  [${x.check}] ${x.message}`)].join('\n');
  }).join('\n');
}

test('the order gate\'s verdicts on a fixed set of orders are pinned (entries, refusals, exits, protect, modify, prop, policy)', () => {
  const text = verdictText(ORDER_GATE);
  // The allowed cases are the ones labelled so: a regression that refuses a risk-reducing order fails here too.
  for (const [label, run] of ORDER_GATE) assert.strictEqual(run().violations.length === 0, /\(allowed/.test(label), label);
  assertGolden('gate-verdicts.txt', text);
});

test('the gateway\'s account checks on a fixed set of orders are pinned (exits, protect, cancels, modifies, partial closes)', () => {
  for (const [label, run] of ACCOUNT_GATE) assert.strictEqual(run().violations.length === 0, /\(allowed\)/.test(label), label);
  assertGolden('gate-account-verdicts.txt', verdictText(ACCOUNT_GATE));
});

// --- The live allow-list (broker/allow-list.js): the hook's and gateway's local check (checkOrder), and the gateway's
// check against the server's own get_server_config (createServerAttestation). A live broker "sim" whose server reads
// SIM_ALLOWED (its allowedAccountsEnv) and is paper with SIM_TRADING=false (its paperEnv).
function allowListSetup({ allowedAccountsEnv = 'SIM_ALLOWED' } = {}) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'strategies', 'anytime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'anytime', 'STRATEGY.md'), [
    '---', 'name: anytime', 'description: Test strategy that is valid at any time of day for MNQ only.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const home = trendHome(undefined, { closedAt: '2026-10-07T14:27:00.000Z' });
  const journal = writeJournal(home, [{ ts: '2026-10-07T14:25:00.000Z', kind: 'plan', contractId: CONTRACT, text: 'plan' }]);
  const sim = { command: ['node', 'sim.js'], journal, paperEnv: { SIM_TRADING: 'false' }, ...(allowedAccountsEnv ? { allowedAccountsEnv } : {}) };
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim } }));
  recordBrokerSpecs(home, { broker: 'sim' });
  const env = {
    FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: '2026-10-07T14:30:00.000Z', FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_ENV_FILE: path.join(home, 'none.env'),
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_BROKERS_FILE: path.join(home, 'brokers.json'),
  };
  return { root, env, broker: { name: 'sim', ...sim } };
}
const ANYTIME = entryOrder({ rationale: 'setup:anytime long, stop 21480, target 21540, risk $40' });
const EXIT = entryOrder({ side: 'sell', rationale: '[exit] flatten' });
const PROTECT = entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
const local = (input, envOver = {}, setup = {}, opts = {}) => { const w = allowListSetup(setup); return checkOrder(input, { env: { ...w.env, ...envOver }, pluginRoot: w.root, ...opts }); };
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const SERVER = { tradingEnabled: true, allowedAccountIds: [1] };
/** The gateway's server check for an entry on account 1, the server answering `answer` (a config, or a thrown error). */
async function attested(answer, envOver = { SIM_ALLOWED: '1' }) {
  const w = allowListSetup();
  const call = async () => { if (answer instanceof Error) throw answer; return reply(answer); };
  return { violations: await createServerAttestation({ env: { ...w.env, ...envOver }, broker: w.broker, call }).violations({ accountId: 1 }, false) };
}

test('the live allow-list\'s verdicts are pinned: the local list, the server\'s attestation, paper claims, and exits that never need either', async () => {
  const cases = [
    ['local: account 1 on the list (allowed)', () => local(ANYTIME, { SIM_ALLOWED: '1' })],
    ['local: the broker names no allow-list variable', () => local(ANYTIME, { SIM_ALLOWED: '1' }, { allowedAccountsEnv: null })],
    ['local: no list set', () => local(ANYTIME)],
    ['local: an empty list', () => local(ANYTIME, { SIM_ALLOWED: '' })],
    ['local: "any"', () => local(ANYTIME, { SIM_ALLOWED: 'any' })],
    ['local: the account not on the list', () => local(ANYTIME, { SIM_ALLOWED: '2,3' })],
    ['local: a paper run, no list (allowed: the server refuses every order)', () => local(ANYTIME, { SIM_TRADING: 'false' })],
    ['local: an exit with no list (allowed)', () => local(EXIT)],
    ['local: a protective stop with no list (allowed)', () => local(PROTECT)],
    ['local: a cancel with no list (allowed)', () => local({ accountId: 1, orderId: 9 }, {}, {}, { tool: 'cancel_order' })],
    ['local: a partial close with no list (allowed)', () => local({ accountId: 1, contractId: CONTRACT, size: 1 }, {}, {}, { tool: 'partial_close_position' })],
  ];
  const server = [
    ['server: lists the account (allowed)', () => attested(SERVER)],
    ['server: does not attest (get_server_config fails)', () => attested(new Error('server down'))],
    ['server: does not attest (no tradingEnabled)', () => attested({ allowedAccountIds: [1] })],
    ['server: allows any account', () => attested({ tradingEnabled: true, allowedAccountIds: [] })],
    ['server: the account not among its allowed accounts', () => attested({ tradingEnabled: true, allowedAccountIds: [2] })],
    ['server: a paper claim the server contradicts (trading on, no local list)', () => attested(SERVER, { SIM_TRADING: 'false' })],
    ['server: trading off, a paper run it confirms (allowed)', () => attested({ tradingEnabled: false }, { SIM_TRADING: 'false' })],
  ];
  const rows = [...cases.map(([l, run]) => [l, run()]), ...await Promise.all(server.map(async ([l, run]) => [l, await run()]))];
  for (const [label, r] of rows) assert.strictEqual(r.violations.length === 0, /\(allowed/.test(label), label);
  assertGolden('gate-allow-list-verdicts.txt', rows.map(([label, r]) => [`${label}: ${r.violations.length ? 'REFUSED' : 'ALLOWED'}${r.intent ? ` (intent ${r.intent})` : ''}`, ...r.violations.map(x => `  [${x.check}] ${x.message}`)].join('\n')).join('\n'));
});
