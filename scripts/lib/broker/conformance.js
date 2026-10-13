'use strict';

/**
 * Conformance of an MCP server to the broker MCP interface (interface.js):
 * the tool list, then read-only calls whose results are checked against the
 * fields the harness reads (a failed get_quote is a warning: only agents use it).
 * The contract's tickSize and tickValue must be sane (the harness trades with
 * the broker's tick specs: trading/broker-specs.js); one that differs from the
 * static table backtests and training use is a warning (training would not
 * equal live). Never calls an order tool or writes the journal.
 *
 * The dates it sends (search_trades' startTimestamp) are at the wall clock (`now`), or at the replay
 * clock when there is one: `replayAt` (the configured replay clock, harness-now.js replayAt), else a
 * server that reports replay mode (get_server_config.replay) and its replayed serverTime. Against a
 * replay server (or with a replay clock configured), get_bars must return no bar that closes after that
 * clock (no look-ahead).
 *
 *   checkConformance(mcp, { accountId, symbol, now, replayAt }) -> { ok, results: [{ check, ok, problems }] }
 */

const { TOOLS, validateTools, validateResult } = require('./interface');
const { tradingDayStart } = require('../trading/clock');
const { validSpec, specMismatch } = require('../trading/broker-specs');
const { parseTicker } = require('./translator');
const { closesAfter } = require('../trading/look-ahead');

async function checkConformance(mcp, { accountId = null, symbol = 'MNQ', now: wall = new Date(), replayAt = null } = {}) {
  const results = [];
  const record = (check, problems) => results.push({ check, ok: problems.length === 0, problems });
  const probe = async (check, name, args, { optional = false } = {}) => {
    try {
      const data = await mcp.call(name, args);
      record(check, validateResult(name, data));
      return data;
    } catch (err) {
      // An optional call may fail for reasons outside the server (no market data feed on the account): a warning.
      if (optional) results.push({ check: `${check} (warning: the harness doesn't need it)`, ok: true, problems: [err.message] });
      else record(check, [err.message]);
      return null;
    }
  };

  let tools;
  try {
    tools = await mcp.listTools();
    record('tools/list: every interface tool, with the input fields the harness sends', validateTools(tools));
  } catch (err) {
    record('tools/list', [err.message]);
    return { ok: false, results };
  }
  const extra = tools.map(t => t.name).filter(n => !TOOLS[n]);
  if (extra.length) results.push({ check: `extra tools (allowed; agents won't use them): ${extra.join(', ')}`, ok: true, problems: [] });

  const config = await probe('get_server_config', 'get_server_config', {});
  const { now, replay } = clockOf(config, { wall, replayAt, record, results });
  const accounts = await probe('list_accounts', 'list_accounts', { onlyActiveAccounts: false });
  const acct = accountId !== null ? Number(accountId) : (Array.isArray(accounts) && accounts[0] ? Number(accounts[0].id) : null);
  const contracts = await probe(`search_contracts ${symbol}`, 'search_contracts', { searchText: symbol, live: false });
  const active = Array.isArray(contracts) ? contracts.find(c => c.activeContract) : null;
  if (Array.isArray(contracts)) record(`search_contracts ${symbol}: an active contract`, active ? [] : [`no activeContract for ${symbol}`]);
  if (active) {
    const one = await probe('get_contract', 'get_contract', { contractId: active.id });
    if (one) {
      const v = validSpec(one);
      record('get_contract: tickSize above 0 and tickValue (USD) from 0.01 to 10,000 (the harness trades with these)', v ? [] : [`tickSize ${one.tickSize}, tickValue ${one.tickValue}`]);
      const t = parseTicker(one.name, now);
      const why = v && t ? specMismatch(t.root, v) : null;
      if (why) results.push({ check: 'get_contract: tick specs match the static table (warning: training would not equal live)', ok: true, problems: [why] });
    }
    const bars = await probe('get_bars (5 one-minute bars)', 'get_bars', { contractId: active.id, unit: 'minute', unitNumber: 1, limit: 5, includePartialBar: false });
    const list = bars && Array.isArray(bars.bars) ? bars.bars : [];
    const ordered = list.every((b, i) => i === 0 || Date.parse(list[i - 1].t) < Date.parse(b.t));
    if (bars) record('get_bars: oldest first', ordered ? [] : ['bars are not oldest first']);
    // A replay server serves only what had closed by its clock: a later bar is look-ahead.
    if (bars && replay) {
      const after = closesAfter(list, now, { stepMs: 60000 });
      record(`get_bars: no bar closes after the replay clock (${now.toISOString()})`, after.length ? [`${after.length} of ${list.length} bar(s) close after it (the first opened ${after[0].t}): look-ahead`] : []);
    }
    await probe('get_quote', 'get_quote', { contractId: active.id }, { optional: true });
  }
  if (acct === null) record('an account to read', ['no account: pass --account <id>']);
  else {
    await probe('get_account_snapshot', 'get_account_snapshot', { accountId: acct });
    await probe('list_open_positions', 'list_open_positions', { accountId: acct });
    await probe('list_open_orders', 'list_open_orders', { accountId: acct });
    const day = await probe('search_trades (the trading day)', 'search_trades', { accountId: acct });
    // A catch-up end of day reads the fills since a past day ended: startTimestamp must reach back, not be cut to today.
    const since = tradingDayStart(new Date(now.getTime() - 7 * 86400000)).toISOString();
    const week = await probe(`search_trades since ${since} (startTimestamp)`, 'search_trades', { accountId: acct, startTimestamp: since });
    if (Array.isArray(day) && Array.isArray(week)) {
      record('search_trades: a past startTimestamp is honoured (at least the trading day\'s fills, none before it)', [
        ...(week.length < day.length ? [`${week.length} fill(s) since ${since}, fewer than the trading day's ${day.length}: startTimestamp is narrowed or ignored`] : []),
        ...(week.some(f => Date.parse(f.creationTimestamp) < Date.parse(since)) ? [`fills before ${since}: startTimestamp is ignored`] : []),
      ]);
    }
  }
  await probe('journal_read', 'journal_read', { limit: 1 });
  return { ok: results.every(r => r.ok), results };
}

/**
 * The time the check dates its requests at: the configured replay clock, else a replay server's
 * serverTime (a replay server without a readable one fails), else the wall clock. { now, replay }.
 */
function clockOf(config, { wall, replayAt, record, results }) {
  const serverReplay = Boolean(config && config.replay === true);
  if (replayAt) {
    const why = serverReplay ? null : 'the server does not report replay mode (get_server_config.replay), yet a replay clock is set';
    results.push({ check: `replay clock: every date sent is at the configured replay clock (${replayAt.toISOString()})`, ok: true, problems: why ? [why] : [] });
    return { now: replayAt, replay: true }; // its bars are judged at the configured clock, whatever the server says
  }
  if (!serverReplay) return { now: wall, replay: false };
  const t = Date.parse(String(config.serverTime || ''));
  if (!Number.isFinite(t)) {
    record('replay clock: a replay server reports its replayed serverTime (get_server_config)', [`serverTime ${JSON.stringify(config.serverTime)} is not a time: the dates sent fall back to the wall clock`]);
    return { now: wall, replay: true };
  }
  const at = new Date(t);
  results.push({ check: `replay clock: every date sent is at the replay server's time (${at.toISOString()})`, ok: true, problems: [] });
  return { now: at, replay: true };
}

module.exports = { checkConformance };
