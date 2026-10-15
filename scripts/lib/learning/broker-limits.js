'use strict';

/**
 * The broker-limits preflight check's logic: the replay broker's own guardrails (get_server_config: maxOrderSize,
 * maxPositionSize, maxDailyLoss; docs/BROKER-MCP-INTERFACE.md) against the account's (ACCOUNT.md max_contracts per
 * symbol, daily_loss_limit; trading/accounts.js accountLimits). The replay driver passes the account's limits to the
 * replay broker through the env variable names its brokers.json entry gives (`limits`; replay/config.js replayEnv);
 * this confirms the broker reports them. A replay broker left on its defaults would refuse or cap real-sized orders,
 * or stop the day early, so practice would not equal live. The harness reaches the broker only through the adapter.
 *
 *   compareLimits({ config, account, symbols, entry })  -> { status: 'PASS' | 'FAIL' | 'N/A', detail }
 *   missingMapping(entry)                               -> the limits a replay broker's entry names no variable for
 *   readBrokerConfig(root, env)                         -> the server's get_server_config answer, or { error } (synchronous)
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { accountLimits } = require('../trading/accounts');

const KEYS = Object.freeze(['dailyLoss', 'maxOrderSize', 'maxPositionSize']);
const SETTING = 'the account\'s ACCOUNT.md (the replay driver passes it to the broker; mcp-configs/README.md)';
const isSize = v => Number.isInteger(v) && v > 0;
const isLoss = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0) || v === 'off';
const money = v => (v === 'off' ? 'off' : `$${v}`);

/** The limits a replay broker's brokers.json entry names no env variable for ([] when all are mapped). */
function missingMapping(entry) {
  const m = entry && entry.limits && typeof entry.limits === 'object' ? entry.limits : {};
  return KEYS.filter(k => typeof m[k] !== 'string' || !m[k]);
}

function compareLimits({ config, account, symbols, entry }) {
  if (entry && entry.replay === true) {
    const miss = missingMapping(entry);
    if (miss.length) return { status: 'FAIL', detail: `the replay broker "${entry.name || 'broker'}" has no limits.${miss.join(', limits.')} in its brokers.json entry (the env variable name of each limit), so the account's limits can't be passed to it` };
  }
  if (!config || typeof config !== 'object') return { status: 'N/A', detail: 'the broker\'s configuration was not read' };
  if (config.replay !== true) return { status: 'N/A', detail: 'the broker is not a replay server (get_server_config does not report replay: true): its limits are its own' };
  if (!account) return { status: 'N/A', detail: 'no account profile to compare the broker\'s limits with' };
  const want = accountLimits(account, symbols);
  const bad = [];
  const na = [];
  for (const key of ['maxOrderSize', 'maxPositionSize']) {
    if (!isSize(config[key])) na.push(`${key} (get_server_config gives none)`);
    else if (want[key] === null) na.push(`${key} (the account states no max_contracts for ${(symbols || []).join(', ') || 'the run\'s symbols'})`);
    else if (config[key] < want[key]) bad.push(`${key} ${config[key]} is below the account's max_contracts ${want[key]} (${want.symbol}): set it from ${SETTING}`);
  }
  const limit = want.dailyLoss > 0 ? want.dailyLoss : 'off';
  if (!isLoss(config.maxDailyLoss)) na.push('maxDailyLoss (get_server_config gives none)');
  else if (config.maxDailyLoss !== limit) bad.push(`maxDailyLoss ${money(config.maxDailyLoss)} differs from the account's daily_loss_limit ${money(limit)}: set it from ${SETTING}`);
  const notJudged = na.length ? `; not judged: ${na.join('; ')}` : '';
  if (bad.length) return { status: 'FAIL', detail: `the replay broker's limits are not the account's: ${bad.join('; ')}${notJudged}` };
  if (na.length === KEYS.length) return { status: 'N/A', detail: `not judged: ${na.join('; ')}` };
  return { status: 'PASS', detail: `the replay broker's limits match the account's${notJudged}` };
}

/** get_server_config through the adapter, in a child (the preflight is synchronous); { error } when it can't be read. */
function readBrokerConfig(root, env = process.env, { timeoutMs = require('../tunables').runner().gate.laneTimeoutMs } = {}) {
  const adapter = path.join(__dirname, '..', 'broker', 'adapter.js');
  const code = 'const {withAdapter}=require(process.argv[1]);withAdapter({root:process.argv[2]},a=>a.serverConfig()).then(c=>{process.stdout.write(JSON.stringify(c))},e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})';
  const res = spawnSync(process.execPath, ['-e', code, adapter, root], { env, encoding: 'utf8', timeout: timeoutMs });
  if (res.status !== 0) return { error: String(res.stderr || res.error || 'no answer').trim().slice(0, 300) };
  try { return JSON.parse(res.stdout); } catch (_err) { return { error: 'get_server_config gave no JSON' }; }
}

module.exports = { compareLimits, readBrokerConfig, missingMapping, KEYS };
