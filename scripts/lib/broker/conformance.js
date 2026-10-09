'use strict';

/**
 * Conformance of an MCP server to the broker MCP interface (interface.js):
 * the tool list, then read-only calls whose results are checked against the
 * fields the harness reads (a failed get_quote is a warning: only agents use it).
 * Never calls an order tool or writes the journal.
 *
 *   checkConformance(mcp, { accountId, symbol }) -> { ok, results: [{ check, ok, problems }] }
 */

const { TOOLS, validateTools, validateResult } = require('./interface');

async function checkConformance(mcp, { accountId = null, symbol = 'MNQ' } = {}) {
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

  await probe('get_server_config', 'get_server_config', {});
  const accounts = await probe('list_accounts', 'list_accounts', { onlyActiveAccounts: false });
  const acct = accountId !== null ? Number(accountId) : (Array.isArray(accounts) && accounts[0] ? Number(accounts[0].id) : null);
  const contracts = await probe(`search_contracts ${symbol}`, 'search_contracts', { searchText: symbol, live: false });
  const active = Array.isArray(contracts) ? contracts.find(c => c.activeContract) : null;
  if (Array.isArray(contracts)) record(`search_contracts ${symbol}: an active contract`, active ? [] : [`no activeContract for ${symbol}`]);
  if (active) {
    await probe('get_contract', 'get_contract', { contractId: active.id });
    const bars = await probe('get_bars (5 one-minute bars)', 'get_bars', { contractId: active.id, unit: 'minute', unitNumber: 1, limit: 5, includePartialBar: false });
    const list = bars && Array.isArray(bars.bars) ? bars.bars : [];
    const ordered = list.every((b, i) => i === 0 || Date.parse(list[i - 1].t) < Date.parse(b.t));
    if (bars) record('get_bars: oldest first', ordered ? [] : ['bars are not oldest first']);
    await probe('get_quote', 'get_quote', { contractId: active.id }, { optional: true });
  }
  if (acct === null) record('an account to read', ['no account: pass --account <id>']);
  else {
    await probe('get_account_snapshot', 'get_account_snapshot', { accountId: acct });
    await probe('list_open_positions', 'list_open_positions', { accountId: acct });
    await probe('list_open_orders', 'list_open_orders', { accountId: acct });
    await probe('search_trades (the trading day)', 'search_trades', { accountId: acct });
  }
  await probe('journal_read', 'journal_read', { limit: 1 });
  return { ok: results.every(r => r.ok), results };
}

module.exports = { checkConformance };
