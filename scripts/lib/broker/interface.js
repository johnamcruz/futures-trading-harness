'use strict';

/**
 * The broker MCP interface as data: what every broker or prop-firm MCP server
 * implements. docs/BROKER-MCP-INTERFACE.md is the same contract in prose
 * (a test keeps them in step). Read by the adapter (broker/adapter.js), the
 * conformance checker (scripts/check-broker-mcp.js), and tests.
 *
 *   TOOLS      every tool: role (read | order | journal), its inputs (required
 *              ones marked), and the result fields the harness reads
 *   OUTCOMES   the errorCode tables of the order tools
 *   ENUMS, JOURNAL, GUARDRAILS, TRANSPORT
 *
 * validateTools(tools)            problems with a tools/list answer
 * validateResult(tool, data)      problems with a tool's parsed result
 */

const field = (type, required = false, note = '') => ({ type, required, note });
const outcome = { success: field('boolean', true), errorCode: field('number', true), errorName: field('string', true), errorMessage: field('string|null') };
const order = { '[].id': field('number', true), '[].contractId': field('string', true), '[].type': field('number', true, 'order type code'), '[].side': field('number', true, '0 buy, 1 sell'), '[].size': field('number', true), '[].status': field('number', true), '[].stopPrice': field('number|null'), '[].limitPrice': field('number|null') };
const contract = { id: field('string', true), name: field('string', true, 'ticker, e.g. MNQZ6'), tickSize: field('number', true), tickValue: field('number', true, 'USD per tick per contract'), activeContract: field('boolean', true, 'the front month') };
const listOf = fields => Object.fromEntries([['[]', field('array', true)], ...Object.entries(fields).map(([k, f]) => [`[].${k}`, f])]);

const TOOLS = {
  // Session and accounts.
  get_server_config: {
    role: 'read', input: {},
    result: { tradingEnabled: field('boolean', true), allowedAccountIds: field('array|string', true, 'integer[] or "any"'), allowedSymbols: field('array|string', true, 'string[] or "any"'), maxOrderSize: field('number', true), maxPositionSize: field('number', true), maxDailyLoss: field('number|string', true, 'number or "off"'), journalPath: field('string', true), tradingDayStartedAt: field('string', true), serverTime: field('string', true) },
  },
  list_accounts: {
    role: 'read', input: { onlyActiveAccounts: field('boolean', false, 'default true') },
    result: listOf({ id: field('number', true), name: field('string', true), balance: field('number', true), canTrade: field('boolean', true), mcpTradingAllowed: field('boolean', true) }),
  },
  get_account_snapshot: {
    role: 'read', input: { accountId: field('number', true) },
    result: { account: field('object|null', true), positions: field('array', true), openOrders: field('array', true), today: field('object', true, 'tradingDayStartedAt, realizedNetPnL, dailyLossLimit, remainingBeforeLimit, performance stats') },
  },
  // Market data.
  search_contracts: { role: 'read', input: { searchText: field('string', true), live: field('boolean', false, 'default false') }, result: listOf(contract) },
  get_contract: { role: 'read', input: { contractId: field('string', true) }, result: contract },
  list_available_contracts: { role: 'read', input: { live: field('boolean', false, 'default false') }, result: { '[]': field('array', true) } },
  get_bars: {
    role: 'read',
    input: {
      contractId: field('string', true), unit: field('string', false, 'second | minute | hour | day | week | month; default minute'), unitNumber: field('number', false, 'default 5'),
      limit: field('number', false, '1 to 20,000; default 100'), startTime: field('string', false, 'ISO'), endTime: field('string', false, 'ISO; default now'),
      includePartialBar: field('boolean', false, 'default false'), live: field('boolean', false, 'default false'),
    },
    result: { contractId: field('string', true), barSize: field('string', true), count: field('number', true), bars: field('array', true, 'oldest first'), 'bars[].t': field('string', true, 'bar open, UTC ISO'), 'bars[].o': field('number', true), 'bars[].h': field('number', true), 'bars[].l': field('number', true), 'bars[].c': field('number', true), 'bars[].v': field('number', true) },
  },
  get_quote: {
    role: 'read', input: { contractId: field('string', true), timeoutMs: field('number', false, '500 to 15,000; default 5,000') },
    result: { contractId: field('string', true), quote: field('object|null', true, 'lastPrice, bestBid, bestAsk, ...; null when the market is closed') },
  },
  // Positions, orders, fills (read).
  list_open_positions: {
    role: 'read', input: { accountId: field('number', true) },
    result: listOf({ id: field('number', true), contractId: field('string', true), creationTimestamp: field('string', true), type: field('number', true, '1 long, 2 short'), size: field('number', true), averagePrice: field('number', true) }),
  },
  list_open_orders: { role: 'read', input: { accountId: field('number', true) }, result: { '[]': field('array', true), ...order } },
  search_orders: { role: 'read', input: { accountId: field('number', true), startTimestamp: field('string', true), endTimestamp: field('string') }, result: { '[]': field('array', true), ...order } },
  search_trades: {
    role: 'read', input: { accountId: field('number', true), startTimestamp: field('string', false, 'default: the trading day start'), endTimestamp: field('string') },
    result: listOf({ id: field('number', true), contractId: field('string', true), creationTimestamp: field('string', true), price: field('number', true), profitAndLoss: field('number|null', true, 'null on an opening fill'), fees: field('number|null', true), side: field('number', true), size: field('number', true), voided: field('boolean', true), orderId: field('number', true) }),
  },
  get_performance: {
    role: 'read', input: { accountId: field('number', true), startTimestamp: field('string', false, 'default: the trading day start'), endTimestamp: field('string') },
    result: { window: field('object', true), overall: field('object', true), byContract: field('object', true) },
  },
  // Orders (write). The order gate reads every input named here.
  place_order: {
    role: 'order',
    input: {
      accountId: field('number', true), contractId: field('string', true), side: field('string', true, 'buy | sell'), type: field('string', true, 'market | limit | stop | trailing_stop | join_bid | join_ask'),
      size: field('number', true), limitPrice: field('number'), stopPrice: field('number'), trailPrice: field('number', false, 'an absolute price level'),
      stopLossBracket: field('object', false, '{ ticks, type }'), takeProfitBracket: field('object', false, '{ ticks, type }'), customTag: field('string'),
      rationale: field('string', true, 'at least 20 characters'),
    },
    result: { orderId: field('number|null', true), ...outcome },
  },
  modify_order: {
    role: 'order',
    input: { accountId: field('number', true), orderId: field('number', true), size: field('number'), limitPrice: field('number'), stopPrice: field('number'), trailPrice: field('number'), reason: field('string', false, 'journaled as a note') },
    result: outcome,
  },
  cancel_order: { role: 'order', input: { accountId: field('number', true), orderId: field('number', true) }, result: outcome },
  close_position: { role: 'order', input: { accountId: field('number', true), contractId: field('string', true), reason: field('string') }, result: outcome },
  partial_close_position: { role: 'order', input: { accountId: field('number', true), contractId: field('string', true), size: field('number', true), reason: field('string') }, result: outcome },
  // Journal.
  journal_add: {
    role: 'journal',
    input: { kind: field('string', true, 'plan | entry | exit | review | lesson | note'), text: field('string', true), accountId: field('number'), contractId: field('string'), orderId: field('number'), tags: field('array') },
    result: { ts: field('string', true), kind: field('string', true), text: field('string', true) },
  },
  journal_read: { role: 'journal', input: { kind: field('string'), tag: field('string'), contractId: field('string'), since: field('string'), limit: field('number', false, '1 to 500; default 50') }, result: { '[]': field('array', true) } },
};

const OUTCOMES = {
  place: { 0: 'Success', 1: 'AccountNotFound', 2: 'OrderRejected', 3: 'InsufficientFunds', 4: 'AccountViolation', 5: 'OutsideTradingHours', 6: 'OrderPending', 7: 'UnknownError', 8: 'ContractNotFound', 9: 'ContractNotActive', 10: 'AccountRejected' },
  edit: { 0: 'Success', 1: 'AccountNotFound', 2: 'OrderNotFound', 3: 'Rejected', 4: 'Pending', 5: 'UnknownError', 6: 'AccountRejected' },
  close: { 0: 'Success', 1: 'AccountNotFound', 2: 'PositionNotFound', 3: 'ContractNotFound', 4: 'ContractNotActive', 5: 'InvalidCloseSize', 6: 'OrderRejected', 7: 'OrderPending', 8: 'UnknownError', 9: 'AccountRejected' },
};

const TRANSPORT = {
  result: 'a tool returns its payload as JSON text in content[0].text',
  error: 'a failure returns isError: true with the reason as text; a guardrail refusal starts "Blocked by risk guardrail:"',
  refusal: 'a broker refusal is a result with success: false and its errorCode; place_order also sets isError',
  idPrefix: 'request ids starting "fth-gw-" are the gateway\'s own',
};

const ENUMS = {
  side: { buy: 0, sell: 1 },
  orderType: { limit: 1, market: 2, stop_limit: 3, stop: 4, trailing_stop: 5, join_bid: 6, join_ask: 7 },
  positionType: { long: 1, short: 2 },
  orderStatus: { none: 0, open: 1, filled: 2, cancelled: 3, expired: 4, rejected: 5, pending: 6 },
  barUnit: ['second', 'minute', 'hour', 'day', 'week', 'month'],
  contractId: 'CON.F.US.<SYMBOL>.<MONTH><YY>, e.g. CON.F.US.MNQ.Z26',
};

const JOURNAL = {
  format: 'JSONL, append-only, one entry per line: { ts, kind, text, accountId?, contractId?, orderId?, tags?, data? }',
  serverWritten: {
    order_placed: 'every place_order the broker answered: text = the rationale, data = { request, result }',
    order_blocked: 'a place_order a guardrail refused: the reason and the rationale',
    exit: 'close_position, partial_close_position: text = the reason, data = the outcome',
    note: 'modify_order with a reason',
  },
  agentWritten: ['plan', 'entry', 'exit', 'review', 'lesson', 'note'],
};

const GUARDRAILS = [
  'Trading enabled (off by default): every order tool.',
  'Account allowed (empty list = any): every order tool.',
  'Symbol allowed (empty list = any): place_order.',
  'Size within the max order size: place_order, modify_order with a size.',
  'Net position within the max, counting resting same-side entries: place_order that adds exposure.',
  'Today\'s realized net loss below the max daily loss: place_order that adds exposure.',
];

const typeOk = (spec, v) => spec.split('|').some(t => (t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t));

/** Problems with a tools/list answer: a required tool missing, or one without an input field the harness sends. */
function validateTools(tools) {
  const problems = [];
  const byName = new Map((tools || []).map(t => [t.name, t]));
  for (const [name, spec] of Object.entries(TOOLS)) {
    const t = byName.get(name);
    if (!t) {
      problems.push(`missing tool ${name}`);
      continue;
    }
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    for (const [k, f] of Object.entries(spec.input)) if (f.required && !(k in props)) problems.push(`${name}: no input field ${k}`);
  }
  return problems;
}

/** Problems with a tool's parsed result against the fields the harness reads ([] = each element of a list). */
function validateResult(name, data) {
  const spec = TOOLS[name];
  if (!spec) return [`unknown tool ${name}`];
  const problems = [];
  for (const [path, f] of Object.entries(spec.result)) {
    if (!f.required) continue;
    const m = /^(\w*)\[\](?:\.(\w+))?$/.exec(path);
    if (m) {
      const list = m[1] ? data && data[m[1]] : data;
      if (!Array.isArray(list)) {
        problems.push(`${name}: ${m[1] || 'the result'} is not a list`);
        continue;
      }
      if (m[2]) list.forEach((el, i) => { if (!typeOk(f.type, el && el[m[2]])) problems.push(`${name}: ${m[1] || ''}[${i}].${m[2]} is not ${f.type}`); });
    } else if (!typeOk(f.type, data && data[path])) problems.push(`${name}: ${path} is not ${f.type === 'array' ? 'a list' : f.type}`);
  }
  return [...new Set(problems)];
}

module.exports = { TRANSPORT, TOOLS, OUTCOMES, ENUMS, JOURNAL, GUARDRAILS, validateTools, validateResult };
