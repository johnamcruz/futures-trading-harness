'use strict';

/**
 * Preflight: a read-only readiness check before a live or replay session
 * (scripts/preflight.js). It places no orders, cancels nothing, and writes no
 * harness state (only the contract translator refreshes its contract lookups,
 * as on every server start): the broker server is started as the runner starts
 * it (behind the contract translator) and asked read-only questions only. Each check
 * gives { check, status: 'ok' | 'warn' | 'fail', detail }; any fail fails it.
 *
 *   configChecks(raw, { root, read })         { cfg, results }: the runner config, eodAt, a live run's account, and
 *                                             the fine-tuning adapter it declares (learning/adapter.js adapterCheck, as
 *                                             a live run: a pending, failed, stale or invalid one is refused)
 *   allowListChecks(cfg, broker, env)         a live run's allow-list holds its account
 *   harnessChecks(cfg, root, env, deps)       the CLI harness command resolves (and answers --version)
 *   conformanceChecks(mcp, opts)              the broker MCP interface, through the translator (conformance.js)
 *   serverChecks({ cfg, broker, config, env, now })   the server trades the account; its clock agrees
 *   accountLockChecks({ cfg, broker, config, env, status })   no other runner (any harness home) trades the account
 *   accountChecks({ cfg, accounts, profiles, home })  the account exists, can trade, balance read, profile size
 *   laneChecks(cfg, strategies, home)        each lane: bar, trigger, strategies, policies; listed names on their lane's timeframe
 *   agentChecks(cfg, agents)                 each agent role's effective timeframe; a non-analyst off the first lane's, or an analyst on one it can't be given, fails
 *   propProfiles(strategies, accounts, cfg)  the prop profiles this run trades (active policy strategies, its lanes and symbols)
 *   propChecks({ profiles, home })            every prop account a policy strategy trades has its attempt started
 *   barFieldChecks({ strategies, cfg, barsBySymbol })   bars carry the field("...") paths active strategies read
 *   localChecks({ now, killSwitchFile, exists })        market hours, kill switch
 *   fieldPaths(strategy)                      the field("a.b") paths a strategy's rules read
 *   runPreflight({ raw, root, env, home, deps })        every check, in order -> { ok, results }
 *   formatReport({ ok, results })             the report as text
 */

const fs = require('fs');
const path = require('path');
const { validateConfig, buildCommand } = require('./autotrader');
const { activeBroker, translatedCommand } = require('./broker/config');
const { allowListProblem, allowList, normId } = require('./broker/allow-list');
const { liveRunBlocked, createAdapter } = require('./broker/adapter');
const { lockExemption, lockStatus, lockRefusal, serverIdentities, lockDir, lockDirProblem, lockDirWritable, apiUrlEnvProblem, normApi } = require('./account-lock');
const { createMcpClient } = require('./broker/mcp-client');
const { checkConformance } = require('./broker/conformance');
const { loadStrategies, retiredCopies } = require('./trading/strategies');
const { lanesOf, lanePolicies, retireLanes, laneStrategyErrors, signalLaneErrors, describeLane, agentTimeframes, agentErrors, omittedPolicyErrors } = require('./lanes');
const { loadAgents } = require('./harness-sync');
const { loadAccounts } = require('./trading/accounts');
const { readAttempt } = require('./trading/prop-state');
const { familyRoot } = require('./trading/contracts');
const { readField } = require('./trading/rules');
const { loadConfig } = require('./trading/config');
const { inMarketHours, MARKET_HOURS_LABEL } = require('./trading/clock');
const { resolveClock, SERVER_TIME_TOLERANCE_MS } = require('./trading/harness-now');

const r = (check, status, detail = '') => ({ check, status, detail });
const SAMPLE_BARS = require('./tunables').runner().runner.preflightSampleBars; // config/runner.json

/** The adapter check's readers (learning/adapter.js): the manifest, the spec, the harness's digests now. */
function adapterReaders(root) {
  const A = require('./learning/adapter');
  return { adapterManifest: A.readJsonFile, adapterSpec: () => A.readJsonFile(path.join(root, A.SPEC_FILE)), harnessDigests: () => A.currentDigests(root) };
}

function configChecks(raw, { root = path.resolve(__dirname, '..', '..'), read = null } = {}) {
  let cfg;
  try {
    cfg = validateConfig(raw);
  } catch (err) {
    return { cfg: null, results: [r('runner config', 'fail', err.message)] };
  }
  const results = [r('runner config', 'ok', `${cfg.harness} on ${cfg.symbols.join(',')} every ${cfg.timeframe}m bar, ${cfg.paper ? 'paper' : 'live'}`)];
  // validateConfig refuses a missing eodAt, sessions outside market hours, and sessions past eodAt.
  results.push(r('eodAt and sessions', 'ok', `end of day ${cfg.eodAt} (early closes ${cfg.earlyCloseEodAt}); sessions ${cfg.sessions.join(', ')} end by it`));
  if (!cfg.paper && !String(cfg.account || '').trim()) results.push(r('account', 'fail', 'a live run (paper: false) names its account ("account" in the runner config)'));
  // A declared fine-tuning adapter: a session outside the replay splits runs only a validated, current one.
  if (cfg.adapter) {
    const x = require('./learning/adapter').adapterCheck({ cfg, role: 'live', read: read || adapterReaders(root) });
    results.push(r('adapter', x.status === 'PASS' ? 'ok' : 'fail', x.detail));
  }
  return { cfg, results };
}

function allowListChecks(cfg, broker, env) {
  if (cfg.paper) return [r('allow-list', 'ok', 'paper: the broker server refuses every order, no allow-list needed')];
  if (broker.replay === true) return [r('allow-list', 'ok', `replay broker "${broker.name}": no allow-list needed (its server must confirm replay: below)`)];
  const why = cfg.account ? allowListProblem(broker, env, cfg.account) : 'no account to check';
  return [r('allow-list', why ? 'fail' : 'ok', why || `${allowList(broker, env).variable} holds account ${cfg.account}`)];
}

/** The executable for `cmd` on PATH (or the path itself), or null. */
function resolveCommand(cmd, env = process.env, exists = f => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch (_err) { return false; } }) {
  if (!cmd) return null;
  if (cmd.includes('/')) return exists(path.resolve(cmd)) ? path.resolve(cmd) : null;
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, cmd);
    if (exists(f)) return f;
  }
  return null;
}

/** The CLI harness the runner starts each cycle: its command resolves, and (when it answers) its version. LLM-agnostic. */
function harnessChecks(cfg, root, env, { resolve = resolveCommand, version = null } = {}) {
  let cmd;
  try {
    cmd = buildCommand(cfg, 'preflight', root, env)[0];
  } catch (err) {
    return [r('harness command', 'fail', err.message)];
  }
  const found = resolve(cmd, env);
  if (!found) return [r('harness command', 'fail', `${cmd} (harness "${cfg.harness}") is not on PATH: install it or fix "harness"/"command" in the runner config`)];
  const out = [r('harness command', 'ok', `${cmd} -> ${found}`)];
  if (version) {
    const v = version(found);
    out.push(v.ok ? r('harness version', 'ok', v.text) : r('harness version', 'warn', `${cmd} --version did not answer (${v.text}); the runner still starts it per cycle`));
  }
  return out;
}

async function conformanceChecks(mcp, opts) {
  const { results } = await checkConformance(mcp, opts);
  return results.map(x => r(`broker: ${x.check}`, !x.ok ? 'fail' : x.problems.length ? 'warn' : 'ok', x.problems.slice(0, 3).join('; ')));
}

function serverChecks({ cfg, broker, config, env, now }) {
  const out = [];
  if (cfg.paper) out.push(r('broker trading', 'ok', 'paper: the runner forwards the broker\'s paper settings'));
  else {
    const why = liveRunBlocked({ broker, config, env, accountId: cfg.account });
    out.push(r('broker trading', why ? 'fail' : 'ok', why || `the server trades account ${cfg.account || '(replay)'}`));
  }
  if (broker.replay === true && config && config.replay !== true) out.push(r('replay server', 'fail', `broker "${broker.name}" is a replay broker but its server does not report replay (get_server_config.replay)`));
  const t = Date.parse(String((config && config.serverTime) || ''));
  if (!Number.isFinite(t)) out.push(r('clock', 'fail', `the server reports no readable serverTime (${config && config.serverTime})`));
  else {
    const skew = Math.abs(t - now.getTime());
    out.push(r('clock', skew <= SERVER_TIME_TOLERANCE_MS ? 'ok' : 'fail', `harness ${now.toISOString()}, server ${new Date(t).toISOString()} (${Math.round(skew / 1000)} s apart, limit ${SERVER_TIME_TOLERANCE_MS / 60000} min)`));
  }
  return out;
}

/**
 * One runner per broker account (account-lock.js), read only: a live runner holding the account's lock (any of
 * its keys), from any harness home, an unreadable lock, a lock directory override outside tests, or a lock
 * directory that can't be written fails the check; a stale lock (its runner gone) is a warning, taken over at start.
 */
function accountLockChecks({ cfg, broker, config, env, status = lockStatus, writable = lockDirWritable }) {
  const exempt = lockExemption({ paper: cfg.paper, broker, config });
  if (exempt) return [r('account lock', 'ok', `${exempt}: no account lock taken (a ${exempt} run never blocks a live one)`)];
  if (normId(cfg.account) === null) return [];
  const problem = lockDirProblem(env) || writable(lockDir(env));
  if (problem) return [r('account lock', 'fail', `the account lock directory: ${problem}`)];
  const apiProblem = apiUrlEnvProblem(broker, env);
  if (apiProblem) return [r('account lock', 'fail', apiProblem)];
  if (!normApi(config && config.apiUrl)) return [r('account lock', 'fail', `the broker server reports no apiUrl that is a URL with a host (get_server_config: ${JSON.stringify(config && config.apiUrl)}), so its account can't be locked against another install of it: a live run refuses`)];
  const sts = serverIdentities({ broker, config, env }).map(server => status({ env, server, accountId: cfg.account }));
  const bad = sts.find(st => st.state === 'held' || st.state === 'unreadable');
  if (bad) return [r('account lock', 'fail', lockRefusal(bad.lock, bad.file, { broker, accountId: cfg.account }))];
  const stale = sts.find(st => st.state === 'stale');
  if (stale) return [r('account lock', 'warn', `${stale.file} is left by pid ${stale.lock.pid} (harness home ${stale.lock.home || '?'}), which is gone: the runner takes it over at start`)];
  return [r('account lock', 'ok', `no other runner trades account ${normId(cfg.account)} (${sts.map(st => st.file).join(', ')})`)];
}

/** The account named by the runner (else none), its trading flag and balance, and the size of the prop profile it trades. */
function accountChecks({ cfg, accounts, profiles }) {
  if (!cfg.account) return [r('account', cfg.paper ? 'warn' : 'fail', 'no account in the runner config: balance and positions are not read')];
  if (!Array.isArray(accounts)) return [r('account', 'fail', 'list_accounts did not answer with a list')];
  const want = normId(cfg.account); // as the gate compares them: "007" is account 7
  const a = want === null ? null : accounts.find(x => normId(x.id) === want);
  if (!a) return [r('account', 'fail', `account ${cfg.account} is not among the broker's accounts (${accounts.map(x => x.id).join(', ') || 'none'})`)];
  const out = [r('account', 'ok', `${a.id} ${a.name || ''}`.trim())];
  const tradable = a.canTrade === true && a.mcpTradingAllowed !== false;
  out.push(r('account can trade', tradable || cfg.paper ? 'ok' : 'fail', tradable ? 'canTrade' : `canTrade ${a.canTrade}, mcpTradingAllowed ${a.mcpTradingAllowed}`));
  const balance = Number(a.balance);
  if (!Number.isFinite(balance)) return [...out, r('balance', 'fail', `balance ${a.balance} is not a number`)];
  out.push(r('balance', 'ok', `$${balance.toFixed(2)}`));
  for (const p of profiles) {
    const lo = p.starting_balance - p.max_loss;
    const hi = p.starting_balance + p.profit_target;
    const fits = balance > lo && balance < hi;
    out.push(r(`account size (${p.name})`, fits ? 'ok' : 'fail', fits
      ? `balance within the profile's floor $${lo} and target $${hi}`
      : `balance $${balance.toFixed(2)} is outside $${lo} to $${hi} (a $${p.starting_balance} account): another size, blown or passed; pick the matching account or profile`));
  }
  return out;
}

/**
 * The prop account profiles this run trades: those of the policy strategies that aren't disabled, are in one of
 * its lanes (lanes.js: on the lane's timeframe, and listed when the lane lists policies), and trade one of its symbols (by index family: MNQ and NQ are one).
 */
function propProfiles(strategies, accounts, cfg) {
  const fams = new Set(cfg.symbols.map(familyRoot));
  const policies = lanesOf(cfg).flatMap(l => lanePolicies(strategies, l));
  const names = new Set(policies.filter(s => s.valid && s.status !== 'disabled'
    && (s.instruments || []).some(x => fams.has(familyRoot(x)))).map(s => s.account));
  return accounts.filter(a => a.valid && names.has(a.name));
}

/** Each lane of the runner (lanes.js): its bar, trigger, strategies and policies; a listed name off its lane fails. */
function laneChecks(cfg, strategies, home = null) {
  // A lane listing a retired strategy: the runner starts, but the lane enters nothing (lanes.js retireLanes): a failure here.
  const retired = retireLanes(cfg, strategies);
  // A user's own strategy under a retired name loads and trades (the owner's call): named, so a stale copy is noticed.
  const copies = retiredCopies(strategies);
  const lanes = lanesOf(cfg);
  const out = lanes.map((l, i) => r(`lane ${l.timeframe}m`, 'ok', `${describeLane(l, strategies)}${i === 0 && !cfg.lanes ? ' (from timeframe and trigger)' : ''}`));
  const running = a => Boolean(home && readAttempt(home, a));
  const why = [...laneStrategyErrors(lanes, strategies), ...signalLaneErrors(lanes, strategies), ...omittedPolicyErrors(cfg, strategies, running)];
  return [...out, ...(copies.length ? [r('retired-name copies', 'warn', copies.join('; '))] : []), ...(retired.length ? [r('retired strategies in lanes', 'fail', retired.join('; '))] : []), ...(why.length ? [r('lane strategies', 'fail', why.join('; '))] : [])];
}

/** Each agent role's effective timeframe (its config override, its agent file's, else the lane's); lanes.js agentErrors decides which fail. */
function agentChecks(cfg, agents) {
  const list = agentTimeframes(cfg, agents).map(t => `${t.role} ${t.timeframe}${t.from === 'lane' ? '' : ` (${t.from})`}`);
  const why = agentErrors(cfg, agents);
  return [r('agent timeframes', why.length ? 'fail' : 'ok', why.length ? why.join('; ') : list.join(', '))];
}

function propChecks({ profiles, home }) {
  return profiles.map(p => (readAttempt(home, p.name)
    ? r(`prop attempt (${p.name})`, 'ok', 'started')
    : r(`prop attempt (${p.name})`, 'fail', `no attempt started, so the gate refuses its strategies' entries: node scripts/combine.js start --account ${p.name}`)));
}

/** The field("a.b") paths in a strategy's rules. */
function fieldPaths(s) {
  const text = JSON.stringify((s && s.rules) || {});
  return [...new Set([...text.matchAll(/field\s*\(\s*\\?["']([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\\?["']\s*\)/g)].map(m => m[1]))];
}

function barFieldChecks({ strategies, cfg, barsBySymbol }) {
  const tf = `${cfg.timeframe}m`;
  const out = [];
  for (const s of strategies.filter(x => x.valid && x.status !== 'disabled' && x.signal === 'rules' && x.timeframe === tf)) {
    const paths = fieldPaths(s);
    if (!paths.length) continue;
    for (const [symbol, bars] of Object.entries(barsBySymbol)) {
      if (!Array.isArray(bars)) {
        out.push(r(`bar fields (${s.name}, ${symbol})`, 'warn', `no bars to check: ${bars}`));
        continue;
      }
      const missing = paths.filter(p => !bars.some(b => Number.isFinite(readField(b, p))));
      out.push(r(`bar fields (${s.name}, ${symbol})`, missing.length ? 'warn' : 'ok', missing.length
        ? `the last ${bars.length} bars carry no ${missing.join(', ')}: ${s.name} can't fire. Turn on the broker server's bar fields (its own settings; see its repo)`
        : `${paths.join(', ')} on the broker's bars`));
    }
  }
  return out;
}

function localChecks({ now, killSwitchFile, exists = fs.existsSync }) {
  return [
    r('market hours', inMarketHours(now) ? 'ok' : 'warn', inMarketHours(now) ? `open (${MARKET_HOURS_LABEL})` : `closed now (${MARKET_HOURS_LABEL}): the runner waits for the open`),
    exists(killSwitchFile) ? r('kill switch', 'fail', `${killSwitchFile} exists: no new cycles. Read why, then remove it`) : r('kill switch', 'ok', `off (${killSwitchFile})`),
  ];
}

/** Open the configured broker's server as the runner does (behind the contract translator), reads only. */
function openReadOnly({ broker, root, env, createClient = createMcpClient }) {
  const [command, ...args] = translatedCommand(broker);
  const mcp = createClient({ command, args, env, cwd: root, clientName: 'futures-trading-harness-preflight' });
  const refuse = { call: name => { throw new Error(`preflight places no orders (${name})`); }, close: () => {} };
  return { mcp, adapter: createAdapter({ mcp, writeMcp: refuse }) };
}

async function runPreflight({ raw, root, env = process.env, home = loadConfig(env).home, deps = {} }) {
  const results = [];
  const { cfg, results: cfgResults } = configChecks(raw, { root, read: deps.adapterRead || null });
  results.push(...cfgResults);
  if (!cfg) return finish(results);
  let broker;
  try {
    broker = activeBroker(env);
  } catch (err) {
    results.push(r('broker config', 'fail', err.message));
    return finish(results);
  }
  results.push(r('broker config', 'ok', `${broker.name}${broker.replay === true ? ' (replay)' : ''}`));
  results.push(...allowListChecks(cfg, broker, env));
  results.push(...harnessChecks(cfg, root, env, deps));
  const now = (deps.now || (() => resolveClock(env, { testClock: false }).now()))();
  results.push(...localChecks({ now, killSwitchFile: loadConfig(env).killSwitchFile }));
  const all = loadStrategies(root, env).strategies;
  results.push(...laneChecks(cfg, all, home));
  results.push(...agentChecks(cfg, (deps.agents || loadAgents)(root)));
  const profiles = propProfiles(all, loadAccounts(root, env).accounts, cfg);
  results.push(...propChecks({ profiles, home }));
  let opened;
  try {
    opened = (deps.open || openReadOnly)({ broker, root, env });
  } catch (err) {
    results.push(r('broker server', 'fail', err.message));
    return finish(results);
  }
  try {
    results.push(...await conformanceChecks(opened.mcp, { accountId: cfg.account || null, symbol: cfg.symbols[0], now }));
    const config = await opened.adapter.serverConfig().catch(err => ({ error: err.message }));
    results.push(...serverChecks({ cfg, broker, config, env, now }));
    results.push(...accountLockChecks({ cfg, broker, config, env, status: deps.lockStatus }));
    const accounts = await opened.mcp.call('list_accounts', { onlyActiveAccounts: false }).catch(() => null);
    results.push(...accountChecks({ cfg, accounts, profiles }));
    const barsBySymbol = {};
    for (const symbol of cfg.symbols) {
      try {
        const c = await opened.adapter.activeContract(symbol);
        barsBySymbol[symbol] = await opened.adapter.closedBars(c.id, { minutes: cfg.timeframe, limit: SAMPLE_BARS, now });
      } catch (err) {
        barsBySymbol[symbol] = err.message;
      }
    }
    results.push(...barFieldChecks({ strategies: all, cfg, barsBySymbol }));
  } finally {
    opened.adapter.close();
  }
  return finish(results);
}

function finish(results) {
  return { ok: results.every(x => x.status !== 'fail'), results };
}

function formatReport({ ok, results }) {
  const lines = results.map(x => `${x.status === 'fail' ? 'FAIL' : x.status === 'warn' ? 'warn' : 'ok  '} ${x.check}${x.detail ? `: ${x.detail}` : ''}`);
  const fails = results.filter(x => x.status === 'fail').length;
  lines.push(ok ? 'preflight passed: ready to start the runner' : `preflight FAILED: ${fails} check(s) to fix before starting the runner`);
  return `${lines.join('\n')}\n`;
}

module.exports = { laneChecks, agentChecks, propProfiles, configChecks, allowListChecks, resolveCommand, harnessChecks, conformanceChecks, serverChecks, accountLockChecks, accountChecks, propChecks, fieldPaths, barFieldChecks, localChecks, openReadOnly, runPreflight, formatReport };
