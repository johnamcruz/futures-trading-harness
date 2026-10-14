'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../../scripts/lib/preflight');
const { tmpDir, homeBrokers } = require('../helpers');
const prop = require('../../scripts/lib/trading/prop-state');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-10-07T14:00:00Z'); // Wednesday 10:00 ET: market open
const LIVE = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'], paperEnv: { LIVE_TRADING: 'false' } };
const RAW = { harness: 'custom', command: ['agent', '{prompt}'], symbols: ['MNQ'], account: '7', paper: false, timeframe: 3 };
const PROFILE = { name: 'p100', starting_balance: 100000, max_loss: 3000, profit_target: 6000 };
const status = (results, check) => (results.find(x => x.check === check) || {}).status;

test('preflight config: valid, eodAt and sessions, a live run names its account; an invalid config fails', () => {
  const ok = P.configChecks(RAW);
  assert.deepStrictEqual(ok.results.map(x => x.status), ['ok', 'ok']);
  assert.match(ok.results[1].detail, /end of day 15:50@America\/New_York/);
  assert.strictEqual(status(P.configChecks({ ...RAW, account: '' }).results, 'account'), 'fail');
  assert.strictEqual(P.configChecks({ ...RAW, account: '', paper: true }).results.length, 2);
  const bad = P.configChecks({ ...RAW, eodAt: '' });
  assert.strictEqual(bad.cfg, null);
  assert.match(bad.results[0].detail, /eodAt: required/);
  assert.match(P.configChecks({ ...RAW, sessions: ['09:30-16:30@America/New_York'] }).results[0].detail, /sessions/);
});

test('preflight allow-list: live needs the account on the list; paper and a replay broker do not', () => {
  const cfg = P.configChecks(RAW).cfg;
  assert.strictEqual(P.allowListChecks(cfg, LIVE, { LIVE_ALLOWED: '7' })[0].status, 'ok');
  assert.match(P.allowListChecks(cfg, LIVE, {})[0].detail, /LIVE_ALLOWED is empty/);
  assert.match(P.allowListChecks(cfg, LIVE, { LIVE_ALLOWED: '8' })[0].detail, /account 7 is not in LIVE_ALLOWED/);
  assert.match(P.allowListChecks(cfg, { name: 'x' }, {})[0].detail, /allowedAccountsEnv/);
  assert.strictEqual(P.allowListChecks({ ...cfg, paper: true }, LIVE, {})[0].status, 'ok');
  assert.strictEqual(P.allowListChecks(cfg, { ...LIVE, replay: true }, {})[0].status, 'ok');
});

test('preflight harness: the CLI command resolves on PATH; its version is a warning only; no model is probed', () => {
  const cfg = P.configChecks(RAW).cfg;
  const dir = tmpDir();
  const bin = path.join(dir, 'agent');
  fs.writeFileSync(bin, '#!/bin/sh\necho agent 1.2\n', { mode: 0o755 });
  assert.strictEqual(P.resolveCommand('agent', { PATH: dir }), bin);
  assert.strictEqual(P.resolveCommand('agent', { PATH: tmpDir() }), null);
  assert.strictEqual(P.resolveCommand(bin, {}), bin);
  const r = P.harnessChecks(cfg, ROOT, { PATH: dir }, { version: () => ({ ok: true, text: 'agent 1.2' }) });
  assert.deepStrictEqual(r.map(x => [x.check, x.status]), [['harness command', 'ok'], ['harness version', 'ok']]);
  assert.strictEqual(P.harnessChecks(cfg, ROOT, { PATH: dir }, { version: () => ({ ok: false, text: 'exit 2' }) })[1].status, 'warn');
  const missing = P.harnessChecks(cfg, ROOT, { PATH: tmpDir() }, { version: () => assert.fail('not run when missing') });
  assert.deepStrictEqual(missing.map(x => x.status), ['fail']);
  assert.match(missing[0].detail, /agent \(harness "custom"\) is not on PATH/);
  // A named harness: its own CLI.
  const qwen = P.configChecks({ ...RAW, harness: 'qwen', command: null }).cfg;
  assert.match(P.harnessChecks(qwen, ROOT, { PATH: tmpDir() })[0].detail, /^qwen /);
});

test('preflight server: a live run needs a server that trades the account it lists; the clock agrees; a replay broker\'s server says replay', () => {
  const cfg = P.configChecks(RAW).cfg;
  const config = { tradingEnabled: true, allowedAccountIds: [7], serverTime: NOW.toISOString() };
  const run = (over = {}, env = { LIVE_ALLOWED: '7' }, broker = LIVE, c = cfg) => P.serverChecks({ cfg: c, broker, config: { ...config, ...over }, env, now: NOW });
  assert.deepStrictEqual(run().map(x => x.status), ['ok', 'ok']);
  assert.match(run({ tradingEnabled: false })[0].detail, /trading disabled/);
  assert.match(run({ allowedAccountIds: 'any' })[0].detail, /allows any account/);
  assert.match(run({}, {})[0].detail, /LIVE_ALLOWED is empty/);
  assert.strictEqual(run({ serverTime: new Date(NOW.getTime() + 6 * 60000).toISOString() })[1].status, 'fail');
  assert.strictEqual(run({ serverTime: undefined })[1].status, 'fail');
  assert.strictEqual(run({ tradingEnabled: false }, {}, LIVE, { ...cfg, paper: true })[0].status, 'ok', 'paper');
  const replay = run({ replay: true, allowedAccountIds: [] }, {}, { ...LIVE, replay: true });
  assert.deepStrictEqual(replay.map(x => x.status), ['ok', 'ok']);
  const fake = run({}, {}, { ...LIVE, replay: true });
  assert.ok(fake.some(x => x.check === 'replay server' && x.status === 'fail'));
});

test('preflight account: exists, can trade, balance read, and within the prop profile\'s size', () => {
  const cfg = P.configChecks(RAW).cfg;
  const acct = over => [{ id: 7, name: 'A', balance: 100250, canTrade: true, mcpTradingAllowed: true, ...over }];
  const ok = P.accountChecks({ cfg, accounts: acct(), profiles: [PROFILE] });
  assert.deepStrictEqual(ok.map(x => x.status), ['ok', 'ok', 'ok', 'ok']);
  assert.match(P.accountChecks({ cfg, accounts: [{ id: 8 }], profiles: [] })[0].detail, /account 7 is not among the broker's accounts \(8\)/);
  // Ids match as the gate matches them: "007" is account 7, and a non-id matches nothing.
  assert.strictEqual(P.accountChecks({ cfg: { ...cfg, account: '007' }, accounts: acct(), profiles: [] })[0].status, 'ok');
  assert.strictEqual(P.accountChecks({ cfg, accounts: acct({ id: '0007' }), profiles: [] })[0].status, 'ok');
  assert.strictEqual(P.accountChecks({ cfg: { ...cfg, account: '7x' }, accounts: acct(), profiles: [] })[0].status, 'fail');
  assert.strictEqual(P.accountChecks({ cfg, accounts: null, profiles: [] })[0].status, 'fail');
  assert.strictEqual(status(P.accountChecks({ cfg, accounts: acct({ canTrade: false }), profiles: [] }), 'account can trade'), 'fail');
  assert.strictEqual(status(P.accountChecks({ cfg: { ...cfg, paper: true }, accounts: acct({ canTrade: false }), profiles: [] }), 'account can trade'), 'ok');
  assert.strictEqual(status(P.accountChecks({ cfg, accounts: acct({ balance: 'n/a' }), profiles: [] }), 'balance'), 'fail');
  for (const balance of [50000, 97000, 106000, 150000]) {
    const r = P.accountChecks({ cfg, accounts: acct({ balance }), profiles: [PROFILE] });
    assert.strictEqual(status(r, 'account size (p100)'), 'fail', String(balance));
  }
  assert.strictEqual(P.accountChecks({ cfg: { ...cfg, account: '' }, accounts: acct(), profiles: [] })[0].status, 'fail');
  assert.strictEqual(P.accountChecks({ cfg: { ...cfg, account: '', paper: true }, accounts: acct(), profiles: [] })[0].status, 'warn');
});

test('preflight prop: every profile a policy strategy trades has its attempt started', () => {
  const home = tmpDir();
  assert.match(P.propChecks({ profiles: [PROFILE], home })[0].detail, /combine\.js start --account p100/);
  prop.startAttempt(home, PROFILE, NOW);
  assert.strictEqual(P.propChecks({ profiles: [PROFILE], home })[0].status, 'ok');
  assert.deepStrictEqual(P.propChecks({ profiles: [], home }), []);
});

test('preflight bar fields: an active rules strategy on the runner\'s timeframe needs its field() paths on the broker\'s bars (a warning)', () => {
  const cfg = P.configChecks(RAW).cfg;
  const strat = (over = {}) => ({ name: 's', valid: true, status: 'active', signal: 'rules', timeframe: '3m', rules: { long: ['field("a.b") > 0', { any: ['field(\'c\') < 1', 'close > open'] }], short: ['close < open'] }, ...over });
  assert.deepStrictEqual(P.fieldPaths(strat()), ['a.b', 'c']);
  assert.deepStrictEqual(P.fieldPaths(strat({ rules: { long: ['close > open'] } })), []);
  const bars = [{ t: '1', a: { b: 0.5 } }, { t: '2', c: 0 }];
  assert.deepStrictEqual(P.barFieldChecks({ strategies: [strat()], cfg, barsBySymbol: { MNQ: bars } }).map(x => x.status), ['ok']);
  const missing = P.barFieldChecks({ strategies: [strat()], cfg, barsBySymbol: { MNQ: [{ t: '1', a: { b: null } }] } });
  assert.strictEqual(missing[0].status, 'warn');
  assert.match(missing[0].detail, /carry no a\.b, c/);
  assert.strictEqual(P.barFieldChecks({ strategies: [strat()], cfg, barsBySymbol: { MNQ: 'no contract' } })[0].status, 'warn');
  // Not checked: another timeframe, disabled, invalid, or no field().
  for (const over of [{ timeframe: '1m' }, { status: 'disabled' }, { valid: false }, { rules: { long: ['close > open'] } }]) {
    assert.deepStrictEqual(P.barFieldChecks({ strategies: [strat(over)], cfg, barsBySymbol: { MNQ: [] } }), [], JSON.stringify(over));
  }
});

test('preflight local: market hours (a warning when closed) and the kill switch (a failure when on)', () => {
  assert.deepStrictEqual(P.localChecks({ now: NOW, killSwitchFile: '/x/STOP', exists: () => false }).map(x => x.status), ['ok', 'ok']);
  const sat = P.localChecks({ now: new Date('2026-10-10T15:00:00Z'), killSwitchFile: '/x/STOP', exists: () => true });
  assert.deepStrictEqual(sat.map(x => x.status), ['warn', 'fail']);
});

test('preflight run: every check through fakes, read-only (no order tool is ever called); any failure fails it', async () => {
  const home = tmpDir();
  const env = { PATH: tmpDir(), FTH_HOME: home, FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), LIVE_ALLOWED: '7', LIVE_API_URL: 'https://api.example.test', FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  homeBrokers(home, { live: { command: ['live-mcp'], allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'] } }, { env });
  const calls = [];
  const mcp = {
    listTools: async () => { throw new Error('down'); },
    call: async name => {
      calls.push(name);
      if (name === 'get_server_config') return { apiUrl: 'https://api.example.test', tradingEnabled: true, allowedAccountIds: [7], serverTime: NOW.toISOString() };
      if (name === 'list_accounts') return [{ id: 7, name: 'A', balance: 50000, canTrade: true, mcpTradingAllowed: true }];
      if (name === 'search_contracts') return [{ id: 'MNQ', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }];
      if (name === 'get_bars') return { bars: [] };
      throw new Error(`unexpected ${name}`);
    },
    close: () => calls.push('close'),
  };
  const { createAdapter } = require('../../scripts/lib/broker/adapter');
  const open = () => ({ mcp, adapter: createAdapter({ mcp, writeMcp: { call: n => assert.fail(`order call ${n}`), close: () => {} } }) });
  const report = await P.runPreflight({ raw: RAW, root: ROOT, env, home, deps: { now: () => NOW, open, resolve: () => '/bin/agent' } });
  assert.strictEqual(report.ok, false);
  const failed = report.results.filter(x => x.status === 'fail').map(x => x.check);
  assert.ok(failed.includes('broker: tools/list'), failed.join(', '));
  assert.ok(failed.some(c => /^prop attempt/.test(c)), 'the repo\'s policy strategies trade a prop profile, none started here');
  assert.ok(failed.some(c => /^account size/.test(c)), 'a 50k balance is not the profile\'s size');
  assert.strictEqual(status(report.results, 'allow-list'), 'ok');
  assert.strictEqual(status(report.results, 'broker trading'), 'ok');
  assert.strictEqual(status(report.results, 'clock'), 'ok');
  // The runner's lane and each agent role's timeframe are reported (lanes.js).
  assert.strictEqual(status(report.results, 'lane 3m'), 'ok');
  assert.match(report.results.find(x => x.check === 'lane 3m').detail, /^3m bars, trigger bar; strategies: .*cisd_ote.*; policies: prop_portfolio \(from timeframe and trigger\)$/);
  assert.strictEqual(status(report.results, 'agent timeframes'), 'ok');
  assert.match(report.results.find(x => x.check === 'agent timeframes').detail, /risk-manager 3m/);
  assert.strictEqual(status(report.results, 'account lock'), 'ok');
  assert.ok(!calls.some(n => /order|close_position|journal_add/.test(n)), calls.join(', '));
  assert.ok(calls.includes('close'), 'the server is closed after');
  assert.match(P.formatReport(report), /FAIL broker: tools\/list[\s\S]*preflight FAILED: \d+ check\(s\)/);
  assert.match(P.formatReport({ ok: true, results: [{ check: 'x', status: 'warn', detail: 'y' }] }), /^warn x: y\npreflight passed/);
  // A broken config stops before the broker is started.
  const bad = await P.runPreflight({ raw: { ...RAW, eodAt: '' }, root: ROOT, env, home, deps: { open: () => assert.fail('not opened') } });
  assert.deepStrictEqual(bad.results.map(x => x.status), ['fail']);
  // An unknown broker too.
  const unknown = await P.runPreflight({ raw: RAW, root: ROOT, env: { ...env, FTH_BROKER: 'nope' }, home, deps: { open: () => assert.fail('not opened') } });
  assert.match(unknown.results.find(x => x.check === 'broker config').detail, /unknown broker "nope"/);
});

test('preflight opens one read connection behind the translator and no write connection: every order call throws before any server', async () => {
  const opened = [];
  const sent = [];
  const createClient = opts => { opened.push(opts); return { call: async name => { sent.push(name); return []; }, listTools: async () => [], close: () => {} }; };
  const broker = { name: 'live', command: ['live-mcp', '--stdio'] };
  const { adapter } = P.openReadOnly({ broker, root: ROOT, env: {}, createClient });
  assert.strictEqual(opened.length, 1, 'one connection');
  assert.match(opened[0].args.join(' '), /contract-translator\.js --broker live -- live-mcp --stdio/);
  for (const [name, run] of [['cancel_order', () => adapter.cancelOrder(7, 9)], ['modify_order', () => adapter.modifyStop(7, 9, 21480)], ['close_position', () => adapter.closePosition(7, 'MNQ')]]) {
    await assert.rejects(run(), new RegExp(`preflight places no orders \\(${name}\\)`));
  }
  assert.deepStrictEqual(sent, [], 'no order call reached the server');
  await adapter.accountState(7);
  assert.deepStrictEqual(sent.sort(), ['list_open_orders', 'list_open_positions'], 'reads do');
});

test('preflight prop: only the profiles of policy strategies this run trades (not disabled, its timeframe, its symbols\' family)', () => {
  const accounts = [{ name: 'a', valid: true }, { name: 'b', valid: true }, { name: 'c', valid: true }, { name: 'd', valid: false }];
  const pol = over => ({ valid: true, signal: 'policy', status: 'active', timeframe: '1m', instruments: ['MNQ', 'NQ'], account: 'a', ...over });
  const strategies = [pol(), pol({ timeframe: '3m', account: 'b' }), pol({ status: 'disabled', account: 'c' }), pol({ account: 'd' }), pol({ instruments: ['MES'], account: 'c' }),
    { valid: true, signal: 'rules', status: 'active', timeframe: '1m', instruments: ['MNQ'], account: 'c' }];
  const cfg1 = P.configChecks({ ...RAW, timeframe: 1 }).cfg;
  assert.deepStrictEqual(P.propProfiles(strategies, accounts, cfg1).map(a => a.name), ['a']);
  assert.deepStrictEqual(P.propProfiles(strategies, accounts, { ...cfg1, symbols: ['NQ'] }).map(a => a.name), ['a'], 'the family');
  assert.deepStrictEqual(P.propProfiles(strategies, accounts, { ...cfg1, symbols: ['MES'] }).map(a => a.name), ['c']);
  assert.deepStrictEqual(P.propProfiles(strategies, accounts, P.configChecks(RAW).cfg).map(a => a.name), ['b']);
  assert.deepStrictEqual(P.propProfiles([pol({ status: 'paper' })], accounts, cfg1).map(a => a.name), ['a'], 'paper is not disabled');
});

test('preflight account lock: another runner (any harness home) on the account fails; a stale lock warns; paper and a confirmed replay are exempt; read only', async () => {
  const L = require('../../scripts/lib/account-lock');
  const os = require('os');
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test' };
  const cfg = { account: '7', paper: false };
  const check = (over = {}) => P.accountLockChecks({ cfg, broker: LIVE, config: { replay: false, apiUrl: 'https://api.example.test' }, env, ...over });
  assert.deepStrictEqual(check().map(x => x.status), ['ok']);
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), [], 'reads only');
  const held = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/a' });
  try {
    // Held by a live runner (this process stands in for it).
    const [res] = check({ status: o => L.lockStatus({ ...o, command: () => 'node /x/scripts/autotrader.js' }) });
    assert.strictEqual(res.status, 'fail');
    assert.match(res.detail, new RegExp(`account 7 on broker "live" is already traded by another runner \\(pid ${process.pid} on host .*, harness home /homes/a, started .*\\): one runner per broker account`));
    for (const [over, why] of [[{ cfg: { ...cfg, paper: true } }, /^paper/], [{ broker: { ...LIVE, replay: true }, config: { replay: true } }, /^replay/]]) {
      const [x] = check(over);
      assert.strictEqual(x.status, 'ok');
      assert.match(x.detail, why);
    }
    assert.strictEqual(check({ broker: { ...LIVE, replay: true }, config: { replay: false, apiUrl: 'https://api.example.test' }, status: o => L.lockStatus({ ...o, command: () => 'autotrader' }) })[0].status, 'fail', 'an unconfirmed replay is live');
  } finally {
    held.release();
  }
  const gone = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(held.file, JSON.stringify({ pid: Number(gone), host: os.hostname(), home: '/homes/old' }));
  const [stale] = check();
  assert.strictEqual(stale.status, 'warn');
  assert.match(stale.detail, /left by pid \d+ \(harness home \/homes\/old\), which is gone: the runner takes it over at start/);
  assert.ok(fs.existsSync(held.file), 'preflight never removes it');
  assert.deepStrictEqual(P.accountLockChecks({ cfg: { account: '', paper: false }, broker: LIVE, config: {}, env }), [], 'no account: the account check fails instead');
  const noApi = P.accountLockChecks({ cfg, broker: LIVE, config: { replay: false }, env });
  assert.deepStrictEqual(noApi.map(x => x.status), ['fail']);
  assert.match(noApi[0].detail, /reports no apiUrl/);
  const noEnv = P.accountLockChecks({ cfg, broker: { name: 'live' }, config: { apiUrl: 'https://api.example.test' }, env });
  assert.deepStrictEqual(noEnv.map(x => x.status), ['fail']);
  assert.match(noEnv[0].detail, /names no apiUrlEnv/);
  // An unreadable lock can't be judged: a failure, as at start.
  fs.writeFileSync(held.file, 'junk');
  const [unreadable] = check();
  assert.strictEqual(unreadable.status, 'fail');
  assert.match(unreadable.detail, /its lock file is unreadable/);
  // The lock directory: an override outside tests, or one that can't be written, fails.
  assert.match(P.accountLockChecks({ cfg, broker: LIVE, config: {}, env: { FTH_LOCK_DIR: env.FTH_LOCK_DIR } })[0].detail, /FTH_LOCK_DIR is set .*for tests only/);
  const unwritable = P.accountLockChecks({ cfg, broker: LIVE, config: {}, env, writable: () => '/x can\'t be written (EACCES)' });
  assert.deepStrictEqual(unwritable.map(x => [x.status, x.detail]), [['fail', 'the account lock directory: /x can\'t be written (EACCES)']]);
  // A run on the same API through another install (its apiUrl key held): a failure.
  fs.rmSync(held.file);
  const api = L.acquireAccountLocks({ env, broker: LIVE, servers: ['cmd:/elsewhere', 'api:https://api.example.test'], accountId: '7' });
  try {
    const [x] = check({ config: { apiUrl: 'https://api.example.test' }, status: o => L.lockStatus({ ...o, command: () => 'autotrader' }) });
    assert.strictEqual(x.status, 'fail');
  } finally {
    api.release();
  }
});
