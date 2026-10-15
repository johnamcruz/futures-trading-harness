'use strict';

/**
 * A mock exchange for end-to-end tests: one account's positions, working
 * orders and fills, with market fills at the current price, bracket legs
 * (OCO: a filled leg cancels its sibling; a flat position cancels both), and
 * stops and limits that trigger when the test moves the price. Its state is a
 * JSON file shared by every copy of the mock MCP server (the runner's reads
 * and the gateway each start one) and by the test, under a lock.
 *
 * Broker faults and behaviours the test can switch on (state fields):
 *   dropCloses: n   the next n closes are accepted and never fill (a ghost close)
 *   holdCloses      closes are accepted and fill only on settle() (fill lag): a full close closes what is
 *                   open when it fills, unless closeSizedAtSend (a market order for the size open when it was
 *                   sent: two of them reverse the position); a partial close fills its size
 *   closeReply      'refuse': closes come back success: false and close nothing; 'error': a close is
 *                   taken (held, as holdCloses) but its reply is an error (a timeout after the broker took it)
 *   loseEntryReply  place_order is taken and filled, but no reply is sent (an order of unknown outcome)
 *   hideOrders      search_orders doesn't list orders yet (the broker is slow to show one)
 *   failBalance     list_accounts fails (the account's balance can't be read)
 *   keepLegs        bracket legs stay working after the position goes flat (legs not cancelled on flat)
 *   oddSize         positions are listed without a size
 * Stops fill at the price that reached them (a gap fills worse than the stop); limits at their limit.
 *
 *   initState(file, over)          a fresh account
 *   update(file, fn)               fn(state) under the lock; the state is saved
 *   read(file)                     the state
 *   setPrice(file, contract, p)    move the market (triggers stops and limits)
 *   settle(file)                   fill the closes held by holdCloses
 *   handle(file, tool, args, env)  a broker MCP tool call -> its result
 *
 * As a replay broker (the replay driver's end-to-end test): MOCK_CLOCK_FILE sets
 * the exchange's time from the driver's clock file on every call, MOCK_REPLAY=1
 * makes get_server_config report replay: true, and MOCK_STATE_DIR (instead of
 * MOCK_STATE) holds the state, created on first use from MOCK_INIT (JSON overrides).
 * MOCK_LEAK_BARS=1 serves a test's real bars past the clock too (a replay server that leaks the future).
 * MOCK_PRICE_FROM_BARS=1 moves each contract's price to the close of its last closed bar (s.bars[contractId], 3m) at the clock,
 * triggering stops and limits, as a replay server's simulated fills follow its data. MOCK_BALANCE_SCHEDULE=<file> is the
 * replay-only balance schedule the driver writes (a JSON list of { at, balance }): the balance is the latest entry's once the
 * clock has reached its `at`, as a replay broker applies it (a run with account states).
 */

const fs = require('fs');
const { tradingDayStart } = require('../../scripts/lib/trading/clock');

const ACCOUNT = 7;
const CONTRACTS = [
  { id: 'fake:MNQ:Z26', name: 'MNQZ6', description: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5, activeContract: true },
  { id: 'fake:MNQ:H27', name: 'MNQH7', description: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5, activeContract: false },
  { id: 'fake:NQ:Z26', name: 'NQZ6', description: 'E-mini Nasdaq-100', tickSize: 0.25, tickValue: 5, activeContract: true },
  { id: 'fake:MES:Z26', name: 'MESZ6', description: 'Micro E-mini S&P 500', tickSize: 0.25, tickValue: 1.25, activeContract: true },
];
const TYPE = { limit: 1, market: 2, stop: 4 };
const OK = { success: true, errorCode: 0, errorName: 'Success', errorMessage: null };
const fail = (errorCode, errorName) => ({ success: false, errorCode, errorName, errorMessage: errorName });

const iso = ms => new Date(ms).toISOString();
const contractOf = id => CONTRACTS.find(c => c.id === id);
const netOf = (s, id) => {
  const p = s.positions.find(x => x.contractId === id);
  return p ? (p.type === 1 ? 1 : -1) * p.size : 0;
};

function initState(file, over = {}) {
  const state = {
    nowMs: Date.parse('2026-10-07T14:00:00Z'), prices: { 'fake:MNQ:Z26': 21500, 'fake:MNQ:H27': 21600, 'fake:MES:Z26': 5800 },
    balance: 50000, nextId: 100, positions: [], orders: [], fills: [], dropCloses: 0, holdCloses: false, held: [], oddSize: false, calls: [], ...over,
  };
  fs.writeFileSync(file, JSON.stringify(state));
  return state;
}

function lock(file) {
  const dir = `${file}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 5000; i += 1) {
    try {
      fs.mkdirSync(dir);
      return () => fs.rmdirSync(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      Atomics.wait(wait, 0, 0, 2);
    }
  }
  throw new Error(`mock exchange: ${dir} stayed locked`);
}

function update(file, fn) {
  const release = lock(file);
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = fn(s);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s));
    fs.renameSync(`${file}.tmp`, file);
    return out;
  } finally {
    release();
  }
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A fill: the position, realized P&L on the part it closes, and OCO legs once flat. */
function fill(s, contractId, side, size, price, orderId) {
  const c = contractOf(contractId);
  const sign = side === 0 ? 1 : -1;
  const net = netOf(s, contractId);
  const old = s.positions.find(x => x.contractId === contractId);
  let pnl = null;
  if (net !== 0 && Math.sign(net) !== sign) {
    pnl = Math.round((price - old.averagePrice) * Math.sign(net) * Math.min(Math.abs(net), size) * (c.tickValue / c.tickSize) * 100) / 100;
    s.balance += pnl;
  }
  const fees = 0.37 * size;
  s.balance = Math.round((s.balance - fees) * 100) / 100; // the broker reports cents
  s.fills.push({ id: s.nextId++, orderId, accountId: ACCOUNT, contractId, creationTimestamp: iso(s.nowMs), price, profitAndLoss: pnl, fees, side, size, voided: false });
  const next = net + sign * size;
  s.positions = s.positions.filter(x => x.contractId !== contractId);
  if (next === 0) {
    // Flat: legs cancelled on flat, unless the broker leaves them.
    if (!s.keepLegs) for (const o of s.orders) if (o.status === 1 && o.contractId === contractId && o.parentId) o.status = 3;
    return;
  }
  const same = net !== 0 && Math.sign(next) === Math.sign(net);
  const avg = same && Math.abs(next) > Math.abs(net) ? (old.averagePrice * Math.abs(net) + price * size) / Math.abs(next) : same ? old.averagePrice : price;
  s.positions.push({ id: same ? old.id : s.nextId++, accountId: ACCOUNT, contractId, creationTimestamp: same ? old.creationTimestamp : iso(s.nowMs), type: next > 0 ? 1 : 2, size: Math.abs(next), averagePrice: avg });
}

function fillOrder(s, o, price) {
  o.status = 2;
  o.fillVolume = o.size;
  o.filledPrice = price;
  o.updateTimestamp = iso(s.nowMs);
  fill(s, o.contractId, o.side, o.size, price, o.id);
  // A filled leg cancels its sibling; a filled entry gets its bracket legs.
  if (o.parentId) for (const x of s.orders) if (x.parentId === o.parentId && x.id !== o.id && x.status === 1) x.status = 3;
  const tick = contractOf(o.contractId).tickSize;
  const dir = o.side === 0 ? 1 : -1;
  const leg = (type, ticks) => s.orders.push({
    id: s.nextId++, accountId: ACCOUNT, contractId: o.contractId, creationTimestamp: iso(s.nowMs), updateTimestamp: iso(s.nowMs), status: 1, type, side: 1 - o.side,
    size: o.size, limitPrice: type === 1 ? price + dir * ticks * tick : null, stopPrice: type === 4 ? price - dir * ticks * tick : null, fillVolume: 0, filledPrice: null, customTag: null, parentId: o.id,
  });
  if (o.brackets && o.brackets.stop) leg(4, o.brackets.stop);
  if (o.brackets && o.brackets.target) leg(1, o.brackets.target);
}

/** Working stops and limits the price has reached fill (a stop at its price, a limit at its limit). */
function match(s) {
  for (const o of s.orders.filter(x => x.status === 1)) {
    const p = s.prices[o.contractId];
    if (o.status !== 1) continue; // cancelled by an OCO sibling in this pass
    const buy = o.side === 0;
    if (o.type === 4 && (buy ? p >= o.stopPrice : p <= o.stopPrice)) fillOrder(s, o, p); // at the price that reached it
    if (o.type === 1 && (buy ? p <= o.limitPrice : p >= o.limitPrice)) fillOrder(s, o, o.limitPrice);
  }
}

const setPrice = (file, contractId, price) => update(file, s => { s.prices[contractId] = price; match(s); });

/** Fill the closes held back (holdCloses, closeReply 'error'): each a market order for the size and side it was sent with. */
const settle = file => update(file, s => {
  for (const h of s.held.splice(0)) {
    const size = h.size ?? Math.abs(netOf(s, h.contractId));
    if (size > 0) fill(s, h.contractId, h.size === null ? (netOf(s, h.contractId) > 0 ? 1 : 0) : h.side, size, s.prices[h.contractId], null);
  }
});

function bars(s, a, env = {}) {
  const step = (a.unit === 'day' ? 1440 : Number(a.unitNumber) || 1) * 60000;
  const end = Math.min(a.endTime ? Date.parse(a.endTime) : s.nowMs, s.nowMs);
  const start = a.startTime ? Date.parse(a.startTime) : end - step * (a.limit || 100);
  // Real bars when the test set them (s.bars[contractId], the bar size the test uses): closed ones up to now, so the
  // gate reads the same market the scan did (e.g. its regime check).
  // A bar size of its own (s.bars["<contractId>@1m"], e.g. a data lane's 1m bars) when the test set one.
  const sized = (s.bars || {})[`${a.contractId}@${step / 60000}m`];
  const real = Array.isArray(sized) ? sized : (s.bars || {})[a.contractId];
  if (Array.isArray(real)) {
    // As a broker does: with no startTime, the last `limit` closed bars by count (across breaks), else from startTime.
    // MOCK_LEAK_BARS=1: a non-conforming replay server that serves the bars after its clock too (look-ahead).
    const until = env.MOCK_LEAK_BARS === '1' ? Infinity : end;
    const closed = real.filter(b => Date.parse(b.t) + step <= until && (!a.startTime || Date.parse(b.t) >= start));
    return { contractId: a.contractId, barSize: `${a.unitNumber || 1} ${a.unit || 'minute'}`, count: Math.min(closed.length, a.limit || 100), bars: closed.slice(-(a.limit || 100)) };
  }
  const out = [];
  const price = s.prices[a.contractId] || 0;
  // Only closed bars (the harness asks without the partial one), flat at the current price.
  for (let t = Math.floor(start / step) * step; t + step <= end; t += step) out.push({ t: iso(t), o: price, h: price + 1, l: price - 1, c: price, v: 100 });
  return { contractId: a.contractId, barSize: `${a.unitNumber || 1} ${a.unit || 'minute'}`, count: Math.min(out.length, a.limit || 100), bars: out.slice(-(a.limit || 100)) };
}

const journal = (env, entry) => {
  if (env.MOCK_JOURNAL) fs.appendFileSync(env.MOCK_JOURNAL, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
};

/** A close (size null: the whole position) as the broker takes it: a market order for the size open now. */
function closeOrder(s, contractId, partial) {
  const net = netOf(s, contractId);
  if (net === 0 || (partial !== null && !(partial >= 1 && partial <= Math.abs(net)))) return fail(2, 'PositionNotFound');
  if (s.closeReply === 'refuse') return fail(3, 'Rejected');
  const order = { contractId, side: net > 0 ? 1 : 0, size: partial ?? (s.closeSizedAtSend ? Math.abs(net) : null) };
  if (s.dropCloses > 0) { s.dropCloses -= 1; return OK; } // accepted, never fills
  if (s.holdCloses || s.closeReply === 'error') {
    s.held.push(order);
    if (s.closeReply === 'error') throw new Error('HTTP 504 gateway timeout');
    return OK;
  }
  fill(s, contractId, order.side, order.size ?? Math.abs(net), s.prices[contractId], null);
  return OK;
}

/** A result the server never sends (the reply is lost). */
const NO_REPLY = { noReply: true };

// The order fields a broker server journals with order_placed (with the position before it).
const REQUEST_FIELDS = ['side', 'type', 'size', 'limitPrice', 'stopPrice', 'trailPrice', 'stopLossBracket', 'takeProfitBracket'];

const HANDLERS = {
  get_server_config: (s, a, env) => ({ ...(env.MOCK_REPLAY === '1' ? { replay: true } : {}), tradingEnabled: true, maxOrderSize: 5, maxPositionSize: 5, maxDailyLoss: 0, allowedAccountIds: [ACCOUNT], allowedSymbols: [], journalPath: env.MOCK_JOURNAL || null, tradingDayStartedAt: iso(s.nowMs - 3600000), serverTime: iso(s.nowMs) }),
  list_accounts: s => {
    if (s.failBalance) throw new Error('HTTP 503 service unavailable');
    return [{ id: ACCOUNT, name: 'MOCK-50K', balance: s.balance, canTrade: true, mcpTradingAllowed: true }];
  },
  get_account_snapshot: s => ({ account: { id: ACCOUNT, name: 'MOCK-50K', balance: s.balance, canTrade: true }, positions: HANDLERS.list_open_positions(s), openOrders: HANDLERS.list_open_orders(s), today: { realizedNetPnL: 0 } }),
  search_contracts: (s, a) => CONTRACTS.filter(c => c.name.startsWith(String(a.searchText || '').toUpperCase())),
  list_available_contracts: () => CONTRACTS,
  get_contract: (s, a) => contractOf(a.contractId) || null,
  get_bars: (s, a, env) => bars(s, a, env),
  get_quote: (s, a) => ({ contractId: a.contractId, quote: { bid: s.prices[a.contractId] - 0.25, ask: s.prices[a.contractId], last: s.prices[a.contractId] } }),
  list_open_positions: s => s.positions.map(p => (s.oddSize ? { ...p, size: undefined } : p)),
  list_open_orders: s => s.orders.filter(o => o.status === 1),
  search_orders: s => (s.hideOrders ? [] : s.orders),
  // From startTimestamp, by default the start of the trading day (the 18:00 ET open), as the interface says.
  search_trades: (s, a) => {
    const from = a.startTimestamp ? Date.parse(a.startTimestamp) : tradingDayStart(new Date(s.nowMs)).getTime();
    return s.fills.filter(f => Date.parse(f.creationTimestamp) >= from);
  },
  get_performance: s => ({ window: { start: iso(s.nowMs - 3600000), end: iso(s.nowMs) }, overall: { fills: s.fills.length }, byContract: {} }),
  place_order: (s, a, env) => {
    const c = contractOf(a.contractId);
    if (!c) return fail(8, 'ContractNotFound');
    const before = netOf(s, a.contractId);
    const o = {
      id: s.nextId++, accountId: ACCOUNT, contractId: a.contractId, creationTimestamp: iso(s.nowMs), updateTimestamp: iso(s.nowMs), status: 1, type: TYPE[a.type],
      side: a.side === 'buy' ? 0 : 1, size: Number(a.size), limitPrice: a.limitPrice ?? null, stopPrice: a.stopPrice ?? null, fillVolume: 0, filledPrice: null,
      customTag: a.customTag ?? null, parentId: null,
      brackets: { stop: a.stopLossBracket ? a.stopLossBracket.ticks : null, target: a.takeProfitBracket ? a.takeProfitBracket.ticks : null },
    };
    s.orders.push(o);
    if (o.type === 2) fillOrder(s, o, s.prices[a.contractId]);
    else match(s);
    // As the live server journals it (parity is one way: the mock matches live): data = { request, result }, the request
    // being the order's fields and the position before it, the order id at the top level.
    const request = { ...Object.fromEntries(REQUEST_FIELDS.filter(k => a[k] !== undefined && a[k] !== null).map(k => [k, a[k]])), positionBefore: before, sizeBefore: Math.abs(before) };
    journal(env, { kind: 'order_placed', text: a.rationale, accountId: a.accountId, contractId: a.contractId, orderId: o.id, data: { request, result: { ...OK, orderId: o.id } } });
    if (s.loseEntryReply) return NO_REPLY;
    return { orderId: o.id, ...OK };
  },
  modify_order: (s, a) => {
    const o = s.orders.find(x => x.id === Number(a.orderId) && x.status === 1);
    if (!o) return fail(2, 'OrderNotFound');
    if (a.stopPrice !== undefined) o.stopPrice = a.stopPrice;
    if (a.limitPrice !== undefined) o.limitPrice = a.limitPrice;
    if (a.size !== undefined) o.size = Number(a.size);
    match(s);
    return OK;
  },
  cancel_order: (s, a) => {
    const o = s.orders.find(x => x.id === Number(a.orderId) && x.status === 1);
    if (!o) return fail(2, 'OrderNotFound');
    o.status = 3;
    return OK;
  },
  close_position: (s, a) => closeOrder(s, a.contractId, null),
  partial_close_position: (s, a) => closeOrder(s, a.contractId, Number(a.size)),
  journal_add: (s, a, env) => {
    const entry = { ts: new Date().toISOString(), ...a };
    if (env.MOCK_JOURNAL) fs.appendFileSync(env.MOCK_JOURNAL, `${JSON.stringify(entry)}\n`);
    return entry;
  },
  journal_read: (s, a, env) => {
    if (!env.MOCK_JOURNAL || !fs.existsSync(env.MOCK_JOURNAL)) return [];
    return fs.readFileSync(env.MOCK_JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => !a.kind || e.kind === a.kind);
  },
};

/** MOCK_PRICE_FROM_BARS: the price of each contract with bars is its last closed 3m bar's close at the clock. */
function followBars(s) {
  for (const [id, series] of Object.entries(s.bars || {})) {
    if (id.includes('@') || !Array.isArray(series)) continue;
    let last = null;
    for (const b of series) if (Date.parse(b.t) + 180000 <= s.nowMs) last = b;
    if (last && s.prices[id] !== last.c) {
      s.prices[id] = last.c;
      match(s);
    }
  }
}

/** MOCK_BALANCE_SCHEDULE: the latest entry the clock has reached sets the balance, once (a fill after it moves it as usual). */
function applySchedule(s, file) {
  let schedule = [];
  try { schedule = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { /* none written yet */ }
  const due = schedule.filter(e => Date.parse(e.at) <= s.nowMs).at(-1);
  if (due && s.scheduleAt !== due.at) {
    s.balance = due.balance;
    s.scheduleAt = due.at;
  }
}

/** One tool call against the shared state; every call is logged in state.calls. */
function handle(file, tool, args = {}, env = process.env) {
  let thrown = null;
  const out = update(file, s => {
    // A replay broker's clock (MOCK_CLOCK_FILE, { now }), re-read on every call as a replay server does.
    if (env.MOCK_CLOCK_FILE) s.nowMs = Date.parse(JSON.parse(fs.readFileSync(env.MOCK_CLOCK_FILE, 'utf8')).now);
    if (env.MOCK_PRICE_FROM_BARS === '1') followBars(s);
    if (env.MOCK_BALANCE_SCHEDULE) applySchedule(s, env.MOCK_BALANCE_SCHEDULE);
    // With whether a position was open when the call came (an order cancelled while one was, say).
    s.calls.push({ tool, args, open: s.positions.length > 0 });
    if (!HANDLERS[tool]) throw new Error(`unknown tool ${tool}`);
    try {
      return HANDLERS[tool](s, args, env);
    } catch (err) {
      thrown = err; // the state change before it is kept (a timeout after the broker took the call)
      return null;
    }
  });
  if (thrown) throw thrown;
  return out;
}

module.exports = { ACCOUNT, CONTRACTS, HANDLERS, NO_REPLY, initState, update, read, setPrice, settle, handle };
