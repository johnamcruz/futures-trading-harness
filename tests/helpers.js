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
 * A plugin root in `home` with the repo's strategies and accounts, the fixture fx_break (on paper with
 * `paper`) and fx_cross, and prop_portfolio trading fx_break first: a policy whose component fires long on
 * the parity bar (NQ-3m's 2026-04-28T04:09). No shipped 3-minute component fires there.
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
  fs.writeFileSync(path.join(root, 'strategies', 'prop_portfolio', 'STRATEGY.md'), policy.replace(/^strategies: \[/m, 'strategies: [fx_break, '));
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
function recordBrokerSpecs(home, { roots = null, broker = null, specs = {}, server } = {}) {
  if (!broker) {
    for (const b of new Set([FAKE_BROKER, shippedBroker().name])) recordBrokerSpecs(home, { roots, broker: b, specs, server });
    return path.join(home, `contracts-${FAKE_BROKER}.json`);
  }
  const { CONTRACT_SPECS } = require('../scripts/lib/trading/contracts');
  const file = path.join(home, `contracts-${broker}.json`);
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

module.exports = { NOW, CONTRACT, FAKE_BROKERS, FAKE_BROKER, TEST_ACCOUNTS, FX_STRATEGIES, fxPolicyRoot, brokerId, shippedBroker, homeBrokers, minutesAgo, tmpDir, trendHome, recordBrokerSpecs, writeJournal, plan, placed, review, entryOrder };
