'use strict';

// Preflight end to end: scripts/preflight.js against the tests' fake broker server, started as the runner
// starts it (behind the contract translator). Read-only: no order tool reaches the server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FAKE_BROKERS, tmpDir } = require('../helpers');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { startAttempt } = require('../../scripts/lib/trading/prop-state');
const { fieldPaths, propProfiles } = require('../../scripts/lib/preflight');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const TIMEFRAME = 1;

function world() {
  const home = tmpDir();
  const config = path.join(home, 'autotrader.json');
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, '-e', '0', '{prompt}'], symbols: ['MNQ'], account: '7', paper: false, timeframe: TIMEFRAME }));
  const args = path.join(home, 'calls.jsonl');
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: SERVER,
    FAKE_BROKER_JOURNAL: path.join(home, 'journal.jsonl'), FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '7', FAKE_ARGS: args,
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_ENV_FILE: path.join(home, 'none.env'),
    FTH_LOCK_DIR: path.join(home, 'locks'), FTH_TEST_LOCKS: '1', FAKE_BROKER_API_URL: 'https://api.fake-broker.test',
  };
  // The prop profile the repo's policy strategies trade, and its size as the account's balance.
  const profiles = propProfiles(loadStrategies(ROOT, {}).strategies, loadAccounts(ROOT, {}).accounts, { symbols: ['MNQ'], timeframe: TIMEFRAME });
  env.FAKE_BALANCE = String(profiles.length ? profiles[0].starting_balance : 50000);
  return { home, config, env, args, profiles };
}

const run = (w, extraEnv = {}, flags = []) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'preflight.js'), '--config', w.config, ...flags], { env: { ...w.env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
};
const line = (out, check) => out.split('\n').find(l => l.slice(5).startsWith(check)) || '';
const toolsCalled = w => (fs.existsSync(w.args) ? fs.readFileSync(w.args, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).name) : []);

test('preflight e2e: ready (allow-list, broker through the translator, account, prop attempt, bar fields) exits 0; nothing is ordered', () => {
  const w = world();
  for (const p of w.profiles) startAttempt(w.home, p);
  // Bars carrying every field() path the 1-minute rules strategies read, so their check passes.
  const paths = loadStrategies(ROOT, {}).strategies.filter(s => s.valid && s.status !== 'disabled' && s.signal === 'rules' && s.timeframe === `${TIMEFRAME}m`).flatMap(fieldPaths);
  const set = (o, p) => { const keys = p.split('.'); let at = o; keys.slice(0, -1).forEach(k => { at = at[k] = at[k] || {}; }); at[keys[keys.length - 1]] = 0.5; return o; };
  const bars = Array.from({ length: 5 }, (_, k) => paths.reduce(set, { t: new Date(Date.now() - (6 - k) * 60000).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 10 }));
  fs.writeFileSync(path.join(w.home, 'bars.json'), JSON.stringify(bars));
  const r = run(w, { FAKE_BARS: path.join(w.home, 'bars.json') });
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /preflight passed/);
  for (const check of ['runner config', 'eodAt and sessions', 'allow-list', 'harness command', 'harness version', 'kill switch', 'broker trading', 'clock', 'account lock', 'account', 'account can trade', 'balance']) {
    assert.match(line(r.out, check), /^ok {3}/, `${check}\n${r.out}`);
  }
  assert.match(r.out, /ok {3}broker: tools\/list/);
  if (paths.length) assert.match(r.out, /ok {3}bar fields/);
  for (const p of w.profiles) assert.match(line(r.out, `prop attempt (${p.name})`), /^ok/);
  const called = toolsCalled(w);
  assert.ok(called.includes('get_server_config') && called.includes('get_bars'), called.join(','));
  assert.ok(!called.some(n => /^(place_order|modify_order|cancel_order|close_position|partial_close_position|journal_add)$/.test(n)), called.join(','));
  assert.ok(!fs.existsSync(path.join(w.home, 'journal.jsonl')), 'nothing journaled');
});

test('preflight e2e: an empty allow-list, the kill switch, a missing attempt and the wrong account size each fail it (exit 1); bars without the fields warn', () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, 'STOP'), 'halt');
  const r = run(w, { FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '', FAKE_BALANCE: '1000' }, ['--no-version']);
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'allow-list'), /^FAIL allow-list: FAKE_BROKER_ALLOWED_ACCOUNT_IDS is empty/);
  assert.match(line(r.out, 'broker trading'), /^FAIL/);
  assert.match(line(r.out, 'kill switch'), /^FAIL/);
  assert.doesNotMatch(r.out, /harness version/, '--no-version');
  for (const p of w.profiles) {
    assert.match(line(r.out, `prop attempt (${p.name})`), /^FAIL/);
    assert.match(line(r.out, `account size (${p.name})`), /^FAIL/);
  }
  const fields = loadStrategies(ROOT, {}).strategies.some(s => s.valid && s.status !== 'disabled' && s.signal === 'rules' && s.timeframe === `${TIMEFRAME}m` && fieldPaths(s).length);
  if (fields) assert.match(r.out, /warn bar fields .*carry no/);
  assert.match(r.out, /preflight FAILED/);
  // A paper run needs no allow-list.
  const paper = run({ ...w, config: (() => { const f = path.join(w.home, 'paper.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(w.config, 'utf8')), paper: true })); return f; })() }, { FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '' }, ['--no-version']);
  assert.match(line(paper.out, 'allow-list'), /^ok/);
  // Usage.
  assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'preflight.js')], { env: w.env, encoding: 'utf8' }).status, 2);
});
