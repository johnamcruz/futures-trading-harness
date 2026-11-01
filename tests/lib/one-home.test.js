'use strict';

// One home per value: each shared number has exactly one definition, its users read it, and a removed copy can't come
// back (the guard at the end scans scripts/ for the literals this replaced).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const combine = require('../../scripts/lib/trading/combine');
const accounts = require('../../scripts/lib/trading/accounts');
const clock = require('../../scripts/lib/trading/clock');
const timing = require('../../scripts/lib/trading/gate-timing');
const mc = require('../../scripts/lib/prop/mc-size');
const { TEST_SIZING, testSizing } = require('../helpers');

const REPO = path.resolve(__dirname, '..', '..');
const MNQ_LEGS = { micro: { root: 'MNQ', tickValue: 0.5, fee: 0.37, max: 50 }, mini: { root: 'NQ', tickValue: 5, fee: 1.4, max: 5 } };
const acct = (extra = {}) => ({
  name: 'unit', starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000,
  daily_loss_soft: 0, loss_streak_stop: 0, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 }, ...extra,
});

// ---- 1. Sizing: the rulebook's only ----

test('sizing has no code default: an incomplete sizing sizes nothing and is refused with what it lacks', () => {
  assert.strictEqual(combine.DEFAULT_SIZING, undefined, 'no code default sizing');
  assert.deepStrictEqual([...combine.SIZING_KEYS].sort(), Object.keys(TEST_SIZING).sort());
  const s = combine.start(acct());
  assert.strictEqual(combine.budget(s, TEST_SIZING), 400, '0.2 x $2,000 with a whole sizing');
  for (const z of [undefined, null, {}, { cushion_frac: 0.2 }, testSizing({ cap_usd: 'off' }), testSizing({ stop_slippage_ticks: 0 }), testSizing({ min_size_guard: -1 })]) {
    assert.strictEqual(combine.budget(s, z), 0, JSON.stringify(z));
    assert.ok(combine.sizingErrors(z).length > 0, JSON.stringify(z));
    assert.throws(() => combine.requireSizing(z, 'here'), /^Error: here: /);
  }
  assert.deepStrictEqual(combine.sizingErrors(TEST_SIZING), []);
  assert.strictEqual(combine.requireSizing(TEST_SIZING), TEST_SIZING);
  // The one-contract guard is the sizing's: none given never takes a contract over the budget.
  assert.strictEqual(combine.contracts(600, 800, 100, 1.5), 1);
  assert.strictEqual(combine.contracts(600, 800, 100), 0);
  assert.strictEqual(combine.contractPlan({ minContracts: 1, dollars: 20, stopTicks: 40, legs: MNQ_LEGS, mode: 'micro' }), null, 'a stop over the budget: no guard, no contract');
  assert.deepStrictEqual(combine.contractPlan({ minContracts: 1, dollars: 20, stopTicks: 40, legs: MNQ_LEGS, mode: 'micro', guard: 1.5 }), { root: 'MNQ', size: 1, riskPerContract: 21.24 });
});

test('sizing: the rulebook is the one home; the strategy loader hands each policy its rulebook entry, whole', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const rb = require('../../scripts/lib/trading/rulebook');
  const policies = loadStrategies(REPO, {}).strategies.filter(s => s.signal === 'policy');
  assert.ok(policies.length > 0);
  for (const p of policies) {
    const book = rb.loadRulebookFile(path.join(REPO, 'accounts', p.account, rb.FILE));
    assert.deepStrictEqual(p.sizing, rb.policyEntry(book, p.name).sizing, `${p.name}: the rulebook's sizing`);
    assert.deepStrictEqual(combine.sizingErrors(p.sizing), [], `${p.name}: whole`);
  }
  assert.strictEqual(rb.SIZING_KEYS, combine.SIZING_KEYS, 'one key list');
  assert.strictEqual(require('../../scripts/lib/trading/strategies').MAX_VALID_BARS, 5);
});

test('sizing: the live verdict and the gate refuse a policy without a whole sizing (fail closed, with the reason)', () => {
  const { decideSetup } = require('../../scripts/lib/prop/verdict');
  const bars = Array.from({ length: 50 }, (_, k) => ({ t: new Date(Date.parse('2026-10-07T13:00:00Z') + k * 180000).toISOString(), o: 21500, h: 21502, l: 21498, c: 21500, v: 100 }));
  const a = acct({ max_contracts: { MNQ: 50 } });
  const args = strategy => ({ account: a, cs: combine.start(a), strategy, component: 'x', symbol: 'MNQ', contractId: 'MNQ', rawBars: bars, spec: { tickSize: 0.25, tickValue: 0.5 }, scan: { direction: 'long', stopDistance: 10 }, now: new Date('2026-10-07T15:30:00Z') });
  const base = { name: 'p', timeframe: '3m', contracts: 'micro' };
  assert.strictEqual(decideSetup(args({ ...base, sizing: TEST_SIZING })).action, 'full');
  for (const sizing of [undefined, { cushion_frac: 0.2 }]) {
    const v = decideSetup(args({ ...base, sizing }));
    assert.deepStrictEqual([v.action, v.maxSize], ['skip', 0]);
    assert.match(v.reason, /p has no whole sizing from its account's rulebook/);
  }
  // A tradable leg without the account's fee: a skip, never a fee guessed.
  const noFee = decideSetup({ ...args({ ...base, sizing: TEST_SIZING }), account: { ...a, fees_per_side: {} } });
  assert.match(noFee.reason, /no fees_per_side\.MNQ in the unit profile/);
});

test('sizing and fees: the gate\'s budget refuses a policy without a whole sizing or a tradable leg without its fee', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { tmpDir } = require('../helpers');
  const a = acct();
  const home = tmpDir();
  const now = new Date('2026-10-07T14:00:00Z');
  prop.startAttempt(home, a, new Date(now.getTime() - 86400000));
  prop.snapshot(home, a, 50000, new Date(now.getTime() - 60000));
  const policy = sizing => ({ name: 'p', contracts: 'micro', sizing });
  assert.strictEqual(prop.budgetPlan(home, a, policy(TEST_SIZING), 'MNQ', 40).size, 18, '$400: 18 MNQ at $21.24');
  assert.match(prop.budgetPlan(home, a, policy({ cushion_frac: 0.2 }), 'MNQ', 40).error, /p has no whole sizing from its account's rulebook/);
  assert.match(prop.budgetPlan(home, a, policy(undefined), 'MNQ', 40).error, /p has no whole sizing/);
  assert.match(prop.budgetPlan(home, { ...a, fees_per_side: { NQ: 1.4 } }, policy(TEST_SIZING), 'MNQ', 40).error, /no fees_per_side\.MNQ in the unit profile/);
  assert.match(prop.budgetPlan(home, { ...a, fees_per_side: { MNQ: 0.37 } }, policy(TEST_SIZING), 'MNQ', 40).error, /no fees_per_side\.NQ/, 'the mini is tradable too');
});

// ---- 3. Fees: the account's only ----

test('fees: the account profile is the one home; the contract table and the broker spec carry none; a missing one is refused', () => {
  const { CONTRACT_SPECS } = require('../../scripts/lib/trading/contracts');
  for (const [root, spec] of Object.entries(CONTRACT_SPECS)) assert.strictEqual(spec.feesPerSide, undefined, root);
  assert.strictEqual(accounts.feePerSide(acct(), 'MNQ'), 0.37);
  assert.strictEqual(accounts.feePerSide(acct(), 'mnq'), 0.37);
  assert.strictEqual(accounts.feePerSide(acct({ fees_per_side: {} }), 'MNQ'), null);
  assert.strictEqual(accounts.feePerSide(acct({ fees_per_side: { MNQ: -1 } }), 'MNQ'), null);
  assert.strictEqual(accounts.feePerSide(acct({ fees_per_side: { MNQ: 'x' } }), 'MNQ'), null);
  assert.throws(() => accounts.requireFee(acct({ fees_per_side: {} }), 'MNQ'), /unit: no fees_per_side\.MNQ in its ACCOUNT\.md; a fee is never assumed/);
  // Every shipped account states a fee for every contract it may trade.
  for (const a of accounts.loadAccounts(REPO, {}).accounts) {
    for (const [root, max] of Object.entries(a.max_contracts || {})) if (max > 0) assert.ok(accounts.feePerSide(a, root) !== null, `${a.name}: ${root}`);
  }
  // The simulator's legs and the gate's: the account's fee; a tradable leg without one is refused, an untradable one needs none.
  const at = require('../../scripts/lib/prop/attempts');
  assert.strictEqual(at.legsFor(acct(), 'MNQ').legs.micro.fee, 0.37);
  assert.throws(() => at.legsFor(acct({ fees_per_side: { NQ: 1.4 } }), 'MNQ'), /no fees_per_side\.MNQ/);
  assert.strictEqual(at.legsFor(acct({ max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 } }), 'MNQ').legs.mini.fee, null, 'NQ untradable: no fee needed');
  const prop = require('../../scripts/lib/trading/prop-state');
  assert.strictEqual(prop.legOf(acct({ fees_per_side: {} }), 'MNQ').fee, null);
  // contractPlan never prices a leg without a fee (a null fee would count as $0).
  assert.strictEqual(combine.contractPlan({ minContracts: 1, dollars: 400, stopTicks: 40, legs: { micro: { ...MNQ_LEGS.micro, fee: null }, mini: null }, mode: 'micro' }), null);
});

test('fees: a counterfactual without a fee prices before fees and leaves its net unknown, never a guessed fee', () => {
  const { simulate } = require('../../scripts/lib/replay/counterfactual');
  const t0 = Date.parse('2026-03-10T14:00:00Z');
  const bars = [[100, 100.5, 99.5, 100], [100, 100.25, 99.75, 100], [100, 106, 99.9, 105.5]].map(([o, h, l, c], i) => ({ ms: t0 + i * 180000, o, h, l, c }));
  const strategy = { name: 'x', signal: 'rules', exit: { target_r: 2 }, risk: { stop: 'atr:1' } };
  const run = spec => simulate({ bars, tfMs: 180000, signalMs: t0, signalClose: 100, direction: 'long', stopDistance: 2, strategy, spec, eodMs: t0 + 86400000 });
  const priced = run({ tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 });
  const bare = run({ tickSize: 0.25, tickValue: 0.5 });
  assert.strictEqual(priced.simulated, true);
  assert.strictEqual(bare.net, null, 'no fee: the net is unknown');
  assert.strictEqual(bare.pnl, priced.pnl, 'the gross is the same');
  assert.strictEqual(priced.net, Math.round((priced.pnl - 0.74) * 100) / 100);
});

// ---- 4. Session times: clock.js ----

test('sessions: the boundaries and the runner\'s and backtester\'s session defaults have one home (clock.js)', () => {
  assert.deepStrictEqual([clock.RTH_OPEN_MIN, clock.RTH_CLOSE_MIN, clock.GLOBEX_OPEN_MIN], [570, 960, 1080]);
  assert.deepStrictEqual(clock.SESSION_DEFAULTS, { sessions: ['18:00-15:50@America/New_York'], eodAt: '15:50@America/New_York', earlyCloseEodAt: '12:50@America/New_York' });
  assert.ok(Object.isFrozen(clock.SESSION_DEFAULTS) && Object.isFrozen(clock.SESSION_DEFAULTS.sessions));
  for (const D of [require('../../scripts/lib/autotrader').DEFAULTS, require('../../scripts/lib/backtest/engine').DEFAULTS]) {
    assert.deepStrictEqual([D.sessions, D.eodAt, D.earlyCloseEodAt], [[...clock.SESSION_DEFAULTS.sessions], clock.SESSION_DEFAULTS.eodAt, clock.SESSION_DEFAULTS.earlyCloseEodAt]);
  }
});

// ---- 5. Gate and ledger timing ----

test('gate timing: one constant each, read by every user (the ledger TTL, the order grace, the call timeout)', () => {
  assert.deepStrictEqual([timing.PENDING_ORDER_TTL_MS, timing.ORDER_GRACE_MS, timing.CALL_TIMEOUT_MS], [30000, 120000, 15000]);
  const ag = require('../../scripts/lib/trading/account-gate');
  const now = new Date('2026-10-07T14:00:00Z');
  const entry = ago => [{ contractId: 'MNQ', at: now.getTime() - ago, sign: 1, size: 2, netBefore: 0 }];
  assert.strictEqual(ag.pendingNet(entry(timing.PENDING_ORDER_TTL_MS - 1), 'MNQ', 0, now), 2, 'pending inside the TTL');
  assert.strictEqual(ag.pendingNet(entry(timing.PENDING_ORDER_TTL_MS), 'MNQ', 0, now), 0, 'expired at the TTL');
  const { graceFor } = require('../../scripts/lib/trading/order-tracker');
  assert.strictEqual(graceFor({}, 200000), 200000 + timing.PENDING_ORDER_TTL_MS, 'a lane past the grace: the lane plus the TTL');
  assert.strictEqual(graceFor({}, 1000), timing.ORDER_GRACE_MS);
  assert.strictEqual(require('../../scripts/lib/trading/order-markers').GRACE_MS, timing.ORDER_GRACE_MS);
  assert.strictEqual(require('../../scripts/lib/trading/mcp-gateway').CALL_TIMEOUT_MS, timing.CALL_TIMEOUT_MS);
  assert.strictEqual(require('../../scripts/lib/broker/mcp-client').DEFAULT_TIMEOUT_MS, timing.CALL_TIMEOUT_MS);
  // The CLIs that can't be loaded here read it by name.
  assert.match(fs.readFileSync(path.join(REPO, 'scripts', 'mcp-gateway.js'), 'utf8'), /const \{ PENDING_ORDER_TTL_MS: LEDGER_TTL_MS \} = require\('\.\/lib\/trading\/gate-timing'\);/);
  assert.match(fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'runner.js'), 'utf8'), /const UNFLAT_GRACE_MS = ORDER_GRACE_MS;/);
  assert.match(fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'harness-tools', 'preflight.js'), 'utf8'), /timeoutMs = CALL_TIMEOUT_MS,/);
});

// ---- 6. The loss streak: two mechanisms, one documented default ----

test('loss streak: the gate\'s cooldown default has one home, tighten-only, and no shipped rulebook\'s session stop waits longer', () => {
  const config = require('../../scripts/lib/trading/config');
  assert.strictEqual(config.loadConfig({}).maxConsecutiveLosses, config.MAX_CONSECUTIVE_LOSSES);
  assert.ok(config.MAX_CONSECUTIVE_LOSSES <= 2, 'tighten-only: the cooldown default never rises past 2');
  const rb = require('../../scripts/lib/trading/rulebook');
  const books = fs.readdirSync(path.join(REPO, 'accounts')).map(a => rb.loadRulebookFile(path.join(REPO, 'accounts', a, rb.FILE))).filter(Boolean);
  assert.ok(books.length > 0);
  for (const b of books) {
    assert.ok(b.valid, b.file);
    assert.ok(b.loss_streak_stop !== rb.OFF && b.loss_streak_stop <= config.MAX_CONSECUTIVE_LOSSES, `${b.name}: loss_streak_stop ${b.loss_streak_stop}`);
  }
});

// ---- 7. The Monte Carlo's size ----

test('Monte Carlo: one default size for every entry point; a size above the maximum is refused, never clamped', () => {
  assert.deepStrictEqual(mc.MC_SIZE, { paths: 2000, reps: 2000 });
  assert.throws(() => mc.checkSize({ paths: mc.MC_MAX + 1 }), /never clamped quietly/);
  assert.throws(() => mc.checkSize({ reps: mc.MC_MAX + 1 }), /never clamped quietly/);
  assert.throws(() => mc.checkSize({ paths: 1.5 }), /a whole number/);
  mc.checkSize({ paths: 0, reps: mc.MC_MAX });
  assert.strictEqual(require('../../scripts/lib/prop/account-states').DEFAULTS.paths, mc.MC_SIZE.paths);
  assert.strictEqual(require('../../scripts/lib/train/model-verifier').resolveModelScore({ account: 'a' }).paths, mc.MC_SIZE.paths);
  // Every evaluator entry point and the scorers default to it (read from the source: their defaults are parameters).
  const src = f => fs.readFileSync(path.join(REPO, 'scripts', 'lib', ...f.split('/')), 'utf8');
  assert.strictEqual(src('prop/evaluator.js').match(/paths = MC_SIZE\.paths/g).length, 3, 'scoreStream, scoreArms, scorePaired');
  assert.strictEqual(src('prop/evaluator.js').match(/reps = MC_SIZE\.reps/g).length, 3);
  assert.strictEqual(src('prop/model-score.js').match(/paths = MC_SIZE\.paths, reps = MC_SIZE\.reps/g).length, 2, 'scoreRun, pairRuns');
  assert.match(src('learning/risk-record-build.js'), /const PATHS = MC_SIZE\.paths;\nconst REPS = MC_SIZE\.reps;/);
});

test('Monte Carlo: the evaluator refuses a size above the maximum instead of running a smaller one', () => {
  const { scoreStream, checkWindow } = require('../../scripts/lib/prop/evaluator');
  const stream = { days: [{ day: '2022-03-01', trades: [] }], trades: [], fieldBranch: [], entryDelayMs: 0, runtimeMs: 1 };
  const opts = { account: acct(), rulebook: { sizing: TEST_SIZING }, contracts: 'micro', seed: 1 };
  assert.throws(() => scoreStream(stream, { ...opts, pass: checkWindow({ from: '2022-03-01', to: '2022-03-02' }), paths: mc.MC_MAX + 1 }), /never clamped quietly/);
  assert.throws(() => scoreStream(stream, { ...opts, pass: checkWindow({ from: '2022-03-01', to: '2022-03-02' }), reps: mc.MC_MAX + 1 }), /never clamped quietly/);
  assert.throws(() => scoreStream(stream, { ...opts, rulebook: {}, pass: checkWindow({ from: '2022-03-01', to: '2022-03-02' }) }), /the Monte Carlo sizes from a policy's rulebook entry/);
});

// ---- 9. Smaller disagreements: the live value is the one value ----

test('the read\'s history and the runner\'s kept history: one window plus a named margin (live: 504 read, 514 kept)', () => {
  const mtf = require('../../scripts/lib/trading/mtf');
  assert.strictEqual(mtf.DEFAULTS.historyHours, 504);
  assert.strictEqual(mtf.HISTORY_HOURS, mtf.DEFAULTS.historyHours + 10);
});

test('ATR lengths: the reads\' ATR(14) and the stop ATR(20), one home each, read by their users', () => {
  const ind = require('../../scripts/lib/trading/indicators');
  assert.deepStrictEqual([ind.ATR_PERIOD, ind.STOP_ATR_PERIOD], [14, 20]);
  assert.strictEqual(require('../../scripts/lib/trading/mtf').DEFAULTS.atr, ind.ATR_PERIOD);
  assert.strictEqual(require('../../scripts/lib/trading/market-snapshot').PARAMS.atrStop, ind.STOP_ATR_PERIOD);
  assert.strictEqual(require('../../scripts/lib/replay/labels').ATR_PERIOD, ind.STOP_ATR_PERIOD);
});

test('volatility cutoffs: the trade stream\'s day regimes use the live regime\'s (regime.js REGIME_PARAMS)', () => {
  const { dayRegimes } = require('../../scripts/lib/prop/trade-stream');
  const { REGIME_PARAMS } = require('../../scripts/lib/trading/regime');
  const day = (k, range) => ({ ms: Date.parse('2022-03-01T15:00:00Z') + k * 86400000, h: 100 + range, l: 100 });
  // Ten days of range 10, then a day at the high cutoff and one just under it.
  const at = mult => {
    const bars = [...Array.from({ length: 10 }, (_, k) => day(k, 10)), day(10, 10 * mult)];
    return [...dayRegimes(bars, 180000).values()].at(-1);
  };
  assert.strictEqual(at(REGIME_PARAMS.highVol), 'high');
  assert.strictEqual(at(REGIME_PARAMS.highVol - 0.01), 'normal');
  assert.strictEqual(at(REGIME_PARAMS.lowVol), 'low');
  assert.strictEqual(at(REGIME_PARAMS.lowVol + 0.01), 'normal');
});

test('strategy numbers: the shipped trade_lifecycle keeps the owner\'s risk ceilings and stop floor (pinned; the value\'s one home is its STRATEGY.md)', () => {
  const { loadStrategyFile } = require('../../scripts/lib/trading/strategies');
  const s = loadStrategyFile(path.join(REPO, 'strategies', 'trade_lifecycle', 'STRATEGY.md'));
  assert.deepStrictEqual(s.errors || [], []);
  const d = s.data || s;
  assert.ok(d.risk.max_risk_usd <= 300, `max_risk_usd ${d.risk.max_risk_usd} is above the owner's $300 cap`);
  assert.ok(d.risk.min_rr >= 2, `min_rr ${d.risk.min_rr} is under 2`);
  assert.ok(d.valid_bars <= 5, `valid_bars ${d.valid_bars} is above 5`);
  // The stop's floor tightens as it grows: a smaller floor lets a closer stop through (a looser rule), so it may only rise.
  assert.ok(d.risk.stop_floor_ticks >= 8, `stop_floor_ticks ${d.risk.stop_floor_ticks} is under 8 (a smaller floor loosens the stop)`);
  assert.ok(d.risk.stop_floor_atr >= 0.25, `stop_floor_atr ${d.risk.stop_floor_atr} is under 0.25 (a smaller floor loosens the stop)`);
});

// ---- The guard: a removed copy never comes back ----

/** Every .js under scripts/ (the CLIs, hooks and the libraries). */
function scriptFiles() {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(REPO, 'scripts'));
  return out;
}

// The prop Monte Carlo's entry points (mc-size.js); other bootstraps (the field studies, the experience index) size their own.
const PROP_MC = /^scripts\/lib\/(?:prop\/(?:evaluator|model-score|account-states|risk-actions)|learning\/risk-record-build|train\/model-verifier)\.js$|^scripts\/(?:account-states|risk-record|model-score)\.js$/;
const TIMING = 'scripts/lib/trading/gate-timing.js';
// [what, pattern, the one file allowed to hold it (or null: none), the files it covers (default: all of scripts/)]
const REMOVED = [
  ['a fee fallback', /\?\?\s*0\.37\b|feesPerSide\s*=\s*0\.37\b|feesPerSide:\s*0\.37\b/, null],
  ['a code default sizing', /\bDEFAULT_SIZING\b/, null],
  ['the pending-order TTL', /\b(?:ttlMs\s*=|LEDGER_TTL_MS\s*=|e\.at\s*<|laneTimeoutMs\s*\+|PENDING_ORDER_TTL_MS\s*=)\s*30000\b/, TIMING],
  ['the order grace', /\b(?:GRACE_MS\s*=|fillAt\s*\+)\s*120000\b/, TIMING],
  ['a call timeout', /\b(?:CALL_TIMEOUT_MS|DEFAULT_TIMEOUT_MS|timeoutMs)\s*=\s*15000\b/, TIMING],
  ['a silent Monte Carlo clamp', /Math\.min\((?:paths|reps),/, null],
  ['a Monte Carlo default size', /\b(?:paths|reps)\s*[=:]\s*(?:500|1000|2000)\b|\b(?:PATHS|REPS)\s*=\s*\d/, 'scripts/lib/prop/mc-size.js', PROP_MC],
  ['a session boundary', /\b(?:9 \* 60 \+ 30|16 \* 60|18 \* 60)\b|\bconst (?:RTH_OPEN|RTH_CLOSE|GLOBEX_OPEN|SESSION_OPEN)\b/, 'scripts/lib/trading/clock.js'],
  ['a session or end-of-day default', /\b(?:eodAt|earlyCloseEodAt):\s*'\d|\bsessions:\s*\['\d/, 'scripts/lib/trading/clock.js'],
  ['a restated strategy number', /\bconst (?:MAX_RISK_USD|MIN_RR|MAX_VALID_BARS)\s*=/, 'scripts/lib/trading/strategies.js', /^scripts\/lib\/learning\/preflight\.js$/],
  ['a copy of the sizing keys', /\['cushion_frac', 'cap_usd'/, 'scripts/lib/trading/combine.js'],
  ['a copy of the ATR lengths', /\bconst (?:ATR_PERIOD|ATR_LEN|STOP_ATR_PERIOD)\s*=\s*\d|\batr\([^()]*,\s*(?:14|20)\)|\batr: 14\b|\batrStop: 20\b/, 'scripts/lib/trading/indicators.js'],
  ['a second history window', /\bHISTORY_HOURS\s*=\s*\d/, null],
  ['the trade stream\'s own volatility cutoffs', /\b(?:1\.25|0\.8)\s*\*\s*mean\b/, null],
  ['a session length in minutes', /\b18\s*\*\s*60\b/, 'scripts/lib/trading/clock.js'],
  ['a session minute used as a boundary', /(?:[<>]=?|[-+]|===?)\s*(?:570|960|1080)\b|\b(?:570|960|1080)\s*(?:[<>]=?|[-+]|===?)|\[\s*-?\d+,\s*(?:570|960|1080)\b|\b(?:570|960|1080)\s*,\s*(?:\d+|'[^']*')\s*\]/, 'scripts/lib/trading/clock.js'],
  ['a fee fallback by or', /(?:\?\?|\|\|)\s*0\.37\b/, null],
  ['a restated cushion fraction', /\bcushion_frac:\s*0\.\d/, null],
  ['a Monte Carlo path count', /\bpaths\s*[:=]\s*\d{3,}/, 'scripts/lib/prop/mc-size.js', /^scripts\/(?:lib\/(?:prop|learning|train)\/[^/]+|[^/]+)\.js$/],
  ['a loss streak default restated', /'FTH_MAX_CONSECUTIVE_LOSSES',\s*\d/, null],
];

test('guard: no removed literal or copy reappears anywhere in scripts/ (one home per value)', () => {
  const hits = [];
  for (const f of scriptFiles()) {
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return; // documentation may name a value
      for (const [what, re, home, scope] of REMOVED) if (rel !== home && (!scope || scope.test(rel)) && re.test(line)) hits.push(`${rel}:${i + 1}: ${what}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('guard: the guard catches what it claims (a planted copy of each is reported)', () => {
  const planted = [
    'const fee = spec.feesPerSide ?? 0.37;', 'const z = { ...DEFAULT_SIZING };', 'function f(ttlMs = 30000) {}', 'const GRACE_MS = 120000;',
    'const CALL_TIMEOUT_MS = 15000;', 'risk(s, { paths: Math.min(paths, 1000) });', 'function g({ paths = 1000 }) {}', 'const RTH_OPEN = 9 * 60 + 30;',
    "  eodAt: '15:50@America/New_York',", 'const MAX_RISK_USD = 300;', "const K = ['cushion_frac', 'cap_usd'];", 'const a = ind.atr(bars, 14);',
    'const HISTORY_HOURS = 250;', 'x = range >= 1.25 * mean;', "maxConsecutiveLosses: intEnv(env, 'FTH_MAX_CONSECUTIVE_LOSSES', 2, { min: 1 }),",
    'const open = 18 * 60;', 'if (m >= 960) return;', "[960, 1080, 'daily break'],", 'if (m < 570) return;', 'const f = cfg.fee || 0.37;', 'const f = cfg.fee ?? 0.37;',
    'const s = { cushion_frac: 0.3, cap_usd: 1 };', 'const r = run({ paths: 5000 });', 'const paths = 3000;',
  ];
  for (const line of planted) assert.ok(REMOVED.some(([, re]) => re.test(line)), line);
});
