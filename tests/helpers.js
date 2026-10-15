'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 2026-10-07 10:00 America/New_York (a Wednesday, outside default no-entry windows). */
const NOW = new Date('2026-10-07T14:00:00Z');
const CONTRACT = 'MNQ';
/**
 * The tests' broker config (FTH_BROKERS_FILE): a fake live broker, `fake`, is the default. Its
 * journal is FAKE_BROKER_JOURNAL and its server FAKE_BROKER_ENTRY. Tests never name a real
 * broker or its variables (tests/plugin/no-platform-specifics.test.js).
 */
const FAKE_BROKERS = path.join(__dirname, 'fixtures', 'brokers.json');
const FAKE_BROKER = 'fake';
/** Fixture prop accounts (test_50k, test_100k) for FTH_ACCOUNTS_DIRS, where a test needs no real account file. */
const TEST_ACCOUNTS = path.join(__dirname, 'fixtures', 'accounts');
/**
 * Fixture rules strategies (fx_break, fx_cross) for FTH_STRATEGIES_DIRS, where a test needs a generic rules
 * strategy that fires on a known parity bar (both fire long on NQ-3m's 2026-04-28T04:09 bar).
 */
const FX_STRATEGIES = path.join(__dirname, 'fixtures', 'strategies-fx');
/** Fixture rules strategies holding the rules of ports retired on 2026-10-13 (fx_keltner, fx_supertrend), for the parity test. */
const FX_PARITY = path.join(__dirname, 'fixtures', 'strategies-fx-parity');
/**
 * Fixture rules strategies holding the rules of every rules strategy retired on 2026-10-14, unchanged under fx_ names
 * (fx_orb, fx_cisd_ote, fx_vwap_reclaim, fx_crt_1h, fx_crt_4h, fx_value_area, fx_value_area_reentry,
 * fx_value_area_breakout: 3m; fx_ofi, fx_ofi_absorption: 1m, reading the broker's flow fields), for FTH_STRATEGIES_DIRS:
 * the decision goldens and the tests of the code they exercise (rules language, bar fields, detectors, targets).
 */
const FX_GOLDEN = path.join(__dirname, 'fixtures', 'strategies-golden');
/**
 * The broker the repo ships as the default (mcp-configs/brokers.json), read, never named: tests that
 * check the shipped config (a live broker's variables, the default) use it so no test names a platform.
 */
function shippedBroker() {
  const { DEFAULTS_FILE } = require('../scripts/lib/broker/config');
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  return { name: cfg.broker, ...cfg.brokers[cfg.broker] };
}

/**
 * A brokers.json in `home` that adds `brokers` (e.g. a replay broker "sim") to the tests' fake live
 * broker and selects `broker`; env.FTH_BROKERS_FILE (when an env is given) points at it.
 */
function homeBrokers(home, brokers, { broker = Object.keys(brokers)[0], env = null } = {}) {
  const fake = JSON.parse(fs.readFileSync(FAKE_BROKERS, 'utf8'));
  const file = path.join(home, 'brokers.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ broker, brokers: { ...fake.brokers, ...brokers } }));
  if (env) env.FTH_BROKERS_FILE = file;
  return file;
}

/**
 * The shipped prop_portfolio's document with the fixture components (fx_break, fx_cross by default) and `active`:
 * it lists none since its components retired (2026-10-14; it stays active, so it enters nothing), so a test of the policy code gives it some.
 */
function withComponents(doc, components = ['fx_break', 'fx_cross']) {
  if (!/^strategies: \[[^\]\n]*\]/m.test(doc) || !/^status: \w+/m.test(doc)) throw new Error('prop_portfolio has no strategies list or status');
  return doc.replace(/^strategies: \[[^\]\n]*\]/m, `strategies: [${components.join(', ')}]`).replace(/^status: \w+/m, 'status: active');
}

/**
 * The rulebook entry the retired prop_flow_1m (1-minute) traded with, as its account's RULEBOOK.md wrote it before
 * 2026-10-14 (a limit turned off says `off`): listPolicies' `from: 'prop_flow_1m'`, for a policy with no cap.
 */
const FLOW_POLICY = Object.freeze({
  sizing: Object.freeze({ cushion_frac: 0.2, min_size_guard: 1.5, cap_usd: 'off', drawdown_halve_usd: 'off', stop_slippage_ticks: 1, clock_k: 'off', r_per_session: 0.3 }),
  exit: Object.freeze({ mode: 'trail', trail_activate_r: 2, trail_giveback_r: 0.5, lock_giveback_r: 'off', trail_by: 'off', trail_r: 'off', swing_tf: 'off' }),
});

/**
 * A plugin root in `home` with the repo's strategies and accounts, the fixture fx_break (on paper with
 * `paper`) and fx_cross, and prop_portfolio active and trading them (fx_break first): a policy whose component
 * fires long on the parity bar (NQ-3m's 2026-04-28T04:09).
 */
function fxPolicyRoot(home, { paper = false } = {}) {
  const root = path.join(home, 'plugin');
  const repo = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, 'strategies'), { recursive: true });
  for (const d of fs.readdirSync(path.join(repo, 'strategies'))) {
    if (d !== 'prop_portfolio') fs.symlinkSync(path.join(repo, 'strategies', d), path.join(root, 'strategies', d));
  }
  fs.symlinkSync(path.join(repo, 'accounts'), path.join(root, 'accounts'));
  const copy = (name, edit = x => x) => {
    fs.mkdirSync(path.join(root, 'strategies', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'strategies', name, 'STRATEGY.md'), edit(fs.readFileSync(path.join(FX_STRATEGIES, name, 'STRATEGY.md'), 'utf8')));
  };
  copy('fx_break', doc => (paper ? doc.replace(/^status: active$/m, 'status: paper') : doc));
  copy('fx_cross');
  const policy = fs.readFileSync(path.join(repo, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8');
  if (!/^strategies: \[/m.test(policy)) throw new Error('prop_portfolio has no strategies list');
  fs.mkdirSync(path.join(root, 'strategies', 'prop_portfolio'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'prop_portfolio', 'STRATEGY.md'), withComponents(policy));
  return root;
}

/** A broker's own contract id for `root`: opaque to the harness (only the translator maps it). */
const brokerId = (root, month = 'Z26') => `fake:${root}:${month}`;

function minutesAgo(n, now = NOW) {
  return new Date(now.getTime() - n * 60000).toISOString();
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fth-test-'));
}

/**
 * The broker's tick specs for `roots`, as the contract translator records them
 * (contracts-<broker>.json, `specs`), so the gate has them for entries. By
 * default every root of the static table, at its values (what the broker reports).
 * And the server's order limits from get_server_config (`server`, the gate's
 * size check): maxOrderSize 50 unless `server` says otherwise; server: false
 * leaves them as they are (none in a new file). With no `broker`: for the tests' fake broker
 * (FTH_BROKERS_FILE=FAKE_BROKERS) and for the shipped default (an env that names no brokers file).
 */
function recordBrokerSpecs(home, { roots = null, broker = null, specs = {}, server, day = null } = {}) {
  if (!broker) {
    for (const b of new Set([FAKE_BROKER, shippedBroker().name])) recordBrokerSpecs(home, { roots, broker: b, specs, server, day });
    return path.join(home, `contracts-${FAKE_BROKER}.json`);
  }
  const { CONTRACT_SPECS } = require('../scripts/lib/trading/contracts');
  // `day`: a replayed day's file (broker/config.js contractsCacheFile under a replay clock).
  const file = path.join(home, `contracts-${broker}${day ? `.${day}` : ''}.json`);
  let data = { ids: {}, front: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    // a new file
  }
  data.specs = data.specs || {};
  for (const r of roots || Object.keys(CONTRACT_SPECS)) {
    const t = CONTRACT_SPECS[r] || {};
    data.specs[r] = { tickSize: t.tickSize, tickValue: t.tickValue, name: `${r}Z6`, description: null, id: brokerId(r), readAt: '2026-10-07T13:00:00.000Z', ...(specs[r] || {}) };
  }
  for (const [r, sp] of Object.entries(specs)) if (!data.specs[r]) data.specs[r] = { name: `${r}Z6`, id: brokerId(r), readAt: '2026-10-07T13:00:00.000Z', ...sp };
  // A replayed day's file also records that day's front month of each root, as a lookup of the root does.
  if (day) for (const r of roots || Object.keys(CONTRACT_SPECS)) data.front = { ...(data.front || {}), [r]: { id: brokerId(r), month: '2026-12', day } };
  if (server !== false && (server !== undefined || !data.server)) data.server = { maxOrderSize: 50, readAt: '2026-10-07T13:00:00.000Z', ...(server || {}) };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

/**
 * A harness home with a multi-timeframe record (mtf-state.js) and a signal
 * record (signal-state.js) for MNQ, so the gate's trend rule and trigger check
 * have a read, and the broker's tick specs (recordBrokerSpecs; specs: false
 * leaves them out). Default: every frame up, orb fired long, closed at closedAt.
 */
function trendHome(home = tmpDir(), { biases = { 240: 1, 60: 1, 15: 1 }, closedAt = '2026-10-07T13:57:00.000Z', symbol = 'MNQ', fired = [{ name: 'orb', direction: 'long' }], specs = true } = {}) {
  // The broker's tick specs, as the translator records them (the gate refuses entries without).
  if (specs) recordBrokerSpecs(home);
  fs.mkdirSync(path.join(home, 'mtf'), { recursive: true });
  fs.writeFileSync(path.join(home, 'mtf', `${symbol}.json`), JSON.stringify({ symbol, asOf: closedAt, closedAt, biases }));
  // And the signal record (signal-state.js): which rules strategies fired on that bar.
  fs.mkdirSync(path.join(home, 'signals'), { recursive: true });
  fs.writeFileSync(path.join(home, 'signals', `${symbol}-3m.json`), JSON.stringify({ symbol, timeframe: '3m', asOf: closedAt, closedAt, candidates: fired }));
  return home;
}

function writeJournal(dir, entries) {
  const file = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  return file;
}

function plan(minAgo = 10, extra = {}) {
  return { ts: minutesAgo(minAgo), kind: 'plan', contractId: CONTRACT, text: 'ORB long above 21500, stop 21480', ...extra };
}

function placed(minAgo, text = 'setup:orb long, stop 21480', success = true) {
  return { ts: minutesAgo(minAgo), kind: 'order_placed', contractId: CONTRACT, text, data: { result: { success } } };
}

function review(minAgo, result) {
  return { ts: minutesAgo(minAgo), kind: 'review', text: `closed ${result}`, tags: [`result:${result}`, 'setup:orb'] };
}

function entryOrder(extra = {}) {
  const o = {
    accountId: 1,
    contractId: CONTRACT,
    side: 'buy',
    type: 'market',
    size: 1,
    stopLossBracket: { ticks: 40, type: 'stop' },
    rationale: 'setup:orb break above OR high 21500, stop 21480, target 21540, risk $40',
    ...extra,
  };
  // Exits and protective stops carry no brackets (the gate refuses them).
  if (/^\s*\[(exit|protect)\]/i.test(o.rationale) && !('stopLossBracket' in extra)) delete o.stopLossBracket;
  return o;
}

/** The shipped policy `from` as loaded (its rulebook's sizing and exit). */
function shippedPolicy(from = 'prop_portfolio') {
  const { loadStrategies } = require('../scripts/lib/trading/strategies');
  return loadStrategies(path.join(__dirname, '..'), {}).strategies.find(x => x.name === from);
}

/**
 * Lists policies in the rulebook of the account folder `accountDir` (accounts/<name>): each with the shipped `from`
 * policy's sizing and exit, and `multipliers` (YAML list lines; none by default). One place, as the loaders require:
 * every account has a RULEBOOK.md beside its ACCOUNT.md, and every policy on it is listed there. Without a rulebook
 * yet one is written: the ACCOUNT.md's daily_loss_soft moves into it (else `soft`, else 0), its loss_streak_stop is `streak`
 * (off by default), with the shipped classification; each policy's exit is `exit` when given, else the shipped one's. Returns the rulebook's path.
 */
function listPolicies(accountDir, names = [], { from = 'prop_portfolio', soft = null, streak = 'off', multipliers = null, exit = null } = {}) {
  const RB = require('../scripts/lib/trading/rulebook');
  const file = path.join(accountDir, RB.FILE);
  if (!fs.existsSync(file)) {
    const profileFile = path.join(accountDir, 'ACCOUNT.md');
    const profile = fs.readFileSync(profileFile, 'utf8');
    const m = profile.match(/^daily_loss_soft: (\d+(?:\.\d+)?)[^\n]*\n/m);
    if (m) fs.writeFileSync(profileFile, profile.replace(m[0], ''));
    const kinds = k => Object.keys(RB.ITEMS).filter(i => (k === 'enforced') === Boolean(RB.ITEMS[i].enforcedBy)).join(', ');
    fs.writeFileSync(file, ['---', `name: ${path.basename(accountDir)}`, 'description: a test rulebook for a fixture account', 'learned: none',
      `daily_loss_soft: ${soft ?? (m ? m[1] : 0)}`, `loss_streak_stop: ${streak}`, `enforced: [${kinds('enforced')}]`, `taught: [${kinds('taught')}]`, '---',
      '', '## When to Use', '', '## How It Works', '', '## Examples', ''].join('\n'));
  }
  if (!names.length) return file;
  // The shipped entry as written (a limit turned off says `off`, never 0).
  const s = from === 'prop_flow_1m' ? FLOW_POLICY
    : RB.loadRulebookFile(path.join(__dirname, '..', 'accounts', shippedPolicy(from).account, RB.FILE)).policies[from];
  const map = (indent, o) => Object.entries(o).map(([k, v]) => `${indent}${k}: ${v}`);
  const block = names.flatMap(n => [`  ${n}:`, '    sizing:', ...map('      ', s.sizing), '    exit:', ...map('      ', exit || s.exit),
    ...(multipliers ? ['    multipliers:', ...multipliers] : ['    multipliers: []'])]).join('\n');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, /^policies:/m.test(text) ? text.replace(/^policies:[^\n]*\n/m, h => `${h}${block}\n`)
    : text.replace(/^enforced:/m, `policies:\n${block}\nenforced:`));
  return file;
}

/** A rulebook's text with its first policy's exit block set to `exit` (every key, as written: `off` for no value). */
function withExitBlock(text, exit) {
  if (!/^ {4}exit:\n(?: {6}.*\n)+/m.test(text)) throw new Error('no policy exit block');
  return text.replace(/^ {4}exit:\n(?: {6}.*\n)+/m, `    exit:\n${Object.entries(exit).map(([k, v]) => `      ${k}: ${v}\n`).join('')}`);
}

/** Every exit key at `off` but the ones given: an exit block for withExitBlock. */
const exitBlock = (over = {}) => ({ mode: 'target', trail_activate_r: 'off', trail_giveback_r: 'off', lock_giveback_r: 'off', trail_by: 'off', trail_r: 'off', swing_tf: 'off', ...over });

/**
 * A plugin root for tests: the shipped strategies (linked) and a copy of the shipped accounts with their rulebooks,
 * in which `policies` ({ name: account }) are listed (listPolicies).
 */
function rootWithPolicies(policies = {}, opts = {}) {
  const root = tmpDir();
  fs.symlinkSync(path.join(__dirname, '..', 'strategies'), path.join(root, 'strategies'));
  fs.cpSync(path.join(__dirname, '..', 'accounts'), path.join(root, 'accounts'), { recursive: true });
  for (const [name, account] of Object.entries(policies)) listPolicies(path.join(root, 'accounts', account), [name], opts);
  return root;
}

/**
 * A whole sizing for tests that size a prop attempt (combine.js SIZING_KEYS): the code has no default (a policy's
 * rulebook entry holds the real values), so a test states every key. Fixture numbers, not a shipped rulebook's.
 */
const TEST_SIZING = Object.freeze({ cushion_frac: 0.2, cap_usd: 0, clock_k: 0, r_per_session: 0.3, min_size_guard: 1.5, drawdown_halve_usd: 0, stop_slippage_ticks: 1 });
const testSizing = (extra = {}) => ({ ...TEST_SIZING, ...extra });
/** A plain backtest's fee per contract per side in tests: a fee is never assumed (no account, no contract-table fee). */
const TEST_FEE = 0.37;

/** The shipped trade_lifecycle strategy's stop rule (its STRATEGY.md risk: the numbers' one home; trade-lifecycle.js stopRuleOf). */
function lifecycleStopRule() {
  const doc = require('../scripts/lib/trading/strategies').loadStrategies(path.resolve(__dirname, '..'), {}).strategies.find(s => s.name === 'trade_lifecycle');
  return require('../scripts/lib/trading/trade-lifecycle').stopRuleOf(doc.risk);
}

module.exports = { lifecycleStopRule, TEST_SIZING, testSizing, TEST_FEE, withExitBlock, exitBlock, shippedPolicy, withComponents, FLOW_POLICY, FX_PARITY, FX_GOLDEN, listPolicies, rootWithPolicies, NOW, CONTRACT, FAKE_BROKERS, FAKE_BROKER, TEST_ACCOUNTS, FX_STRATEGIES, fxPolicyRoot, brokerId, shippedBroker, homeBrokers, minutesAgo, tmpDir, trendHome, recordBrokerSpecs, writeJournal, plan, placed, review, entryOrder };
