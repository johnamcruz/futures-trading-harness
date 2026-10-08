'use strict';

/**
 * Simulated ProjectX broker for backtests. It answers the same Gateway REST
 * endpoints the real API does (see api.js), from historical 1-minute bars
 * and a simulated clock, so projectx-mcp, the MCP gateway, the order gate,
 * and the runner run unchanged and can't tell a replay from the market.
 *
 * Market model (conservative, documented in docs/BACKTESTING.md):
 *   - Only bars that have closed by the simulated time are visible.
 *   - Market orders fill at the last closed 1-minute bar's close, plus
 *     `slippageTicks` against you. Marketable limits fill at that close.
 *   - Resting orders are checked against each later 1-minute bar: stops
 *     trigger on a touch and fill at the worse of the stop and the bar open,
 *     plus slippage; limits need the price to trade through (or open
 *     beyond) them and fill at the better of the limit and the open.
 *   - Within one bar, stops are checked before limits, so a bar that
 *     touches both bracket legs is a loss.
 *   - Brackets (stopLossBracket / takeProfitBracket, in ticks) become an OCO
 *     pair when the entry fills. close_position leaves resting orders.
 *   - Fees per contract per side; P&L in USD from tickSize and tickValue.
 *   - Optional Topstep-style rules: a daily loss limit (flatten and lock
 *     until the next trading day) and a trailing maximum loss limit from the
 *     end-of-day balance high (flatten and lock for good).
 */

const { aggregate, MINUTE } = require('./data');
const { tradingDayStart, zonedParts } = require('../trading/clock');

const ORDER = { limit: 1, market: 2, stopLimit: 3, stop: 4, trailing: 5, joinBid: 6, joinAsk: 7 };
const STATUS = { open: 1, filled: 2, cancelled: 3, rejected: 5 };
const STALE_MS = 30 * MINUTE;
const round2 = x => Math.round(x * 100) / 100;

const ok = extra => ({ ...extra, success: true, errorCode: 0, errorMessage: null });
const fail = (errorCode, errorMessage, extra = {}) => ({ ...extra, success: false, errorCode, errorMessage });

/** CME equity futures are closed 17:00-18:00 ET Monday-Thursday and from Friday 17:00 to Sunday 18:00 ET. */
function marketOpen(ms) {
  const p = zonedParts(new Date(ms), 'America/New_York');
  const minute = p.hour * 60 + p.minute;
  if (p.weekday === 'Sat') return false;
  if (p.weekday === 'Sun') return minute >= 18 * 60;
  if (p.weekday === 'Fri') return minute < 17 * 60;
  return minute < 17 * 60 || minute >= 18 * 60;
}

function lowerBound(bars, ms) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class SimBroker {
  /**
   * @param {object} opts
   * @param {Array<{symbol, contractId, name?, tickSize, tickValue, bars}>} opts.instruments  bars: loadBars() output
   * @param {number} opts.startMs  simulated start time
   */
  constructor({
    instruments, startMs, startingBalance = 50000, slippageTicks = 1, feesPerSide = 0.37,
    accountId = 1, accountName = 'BACKTEST', dailyLossLimit = null, maxLossLimit = null,
  }) {
    if (!Array.isArray(instruments) || instruments.length === 0) throw new Error('SimBroker needs at least one instrument');
    this.contracts = new Map();
    for (const ins of instruments) {
      if (!(ins.tickSize > 0) || !(ins.tickValue > 0)) throw new Error(`${ins.symbol}: tickSize and tickValue must be positive`);
      this.contracts.set(ins.contractId, { ...ins, cursor: lowerBound(ins.bars, startMs - MINUTE + 1) });
    }
    this.now = startMs;
    this.slippageTicks = slippageTicks;
    this.feesPerSide = feesPerSide;
    this.account = { id: accountId, name: accountName, balance: startingBalance, canTrade: true, isVisible: true, simulated: true };
    this.startingBalance = startingBalance;
    this.dailyLossLimit = dailyLossLimit;
    this.maxLossLimit = maxLossLimit;
    this.eodHigh = startingBalance;
    this.lockedUntil = null; // ms; Infinity = account failed
    this.lockReason = null;
    this.orders = [];
    this.trades = [];
    this.positions = new Map(); // contractId -> { net, avg, openedAt, id }
    this.nextId = 1000;
    this.dayStart = tradingDayStart(new Date(startMs)).getTime();
    this.equityCurve = [];
    this.events = [];
  }

  // ── market data ──────────────────────────────────────────────────────

  /** The last 1-minute bar closed by now, or null. */
  lastBar(contractId) {
    const c = this.contracts.get(contractId);
    return c && c.cursor > 0 ? c.bars[c.cursor - 1] : null;
  }

  lastPrice(contractId) {
    const b = this.lastBar(contractId);
    return b ? b.c : null;
  }

  retrieveBars({ contractId, startTime, endTime, unit = 2, unitNumber = 1, limit = 1000, includePartialBar = false }) {
    const c = this.contracts.get(contractId);
    if (!c) return fail(1, `contract ${contractId} not found`, { bars: [] });
    const endMs = Math.min(endTime ? Date.parse(endTime) : this.now, this.now);
    const startMs = startTime ? Date.parse(startTime) : -Infinity;
    if (!Number.isFinite(endMs) || Number.isNaN(startMs)) return fail(2, 'invalid startTime or endTime', { bars: [] });
    let bars;
    try {
      // Daily bars may start up to a day before startTime; back up a day so the first one is whole.
      const from = lowerBound(c.bars, Number.isFinite(startMs) ? startMs - 864e5 : -Infinity);
      const to = lowerBound(c.bars, this.now - MINUTE + 1);
      bars = aggregate(c.bars.slice(from, to), { unit, unitNumber, nowMs: this.now, includePartial: includePartialBar });
    } catch (err) {
      return fail(2, err.message, { bars: [] });
    }
    const inWindow = bars.filter(b => {
      const t = Date.parse(b.t);
      return t >= startMs && t <= endMs;
    });
    // ProjectX returns the most recent `limit` bars, newest first.
    return ok({ bars: inWindow.slice(-Math.max(1, Math.min(Number(limit) || 1000, 20000))).reverse() });
  }

  // ── accounts and contracts ───────────────────────────────────────────

  contractInfo(c) {
    return {
      id: c.contractId, name: c.name || c.symbol, description: `${c.symbol} (backtest)`, tickSize: c.tickSize,
      tickValue: c.tickValue, activeContract: true, symbolId: `F.US.${c.symbol}`,
    };
  }

  searchContracts(searchText) {
    const q = String(searchText || '').toUpperCase();
    return [...this.contracts.values()]
      .filter(c => c.symbol.toUpperCase().includes(q) || c.contractId.toUpperCase().includes(q) || q.includes(c.symbol.toUpperCase()))
      .map(c => this.contractInfo(c));
  }

  accountView() {
    return { ...this.account, balance: round2(this.account.balance), canTrade: this.canTrade() };
  }

  canTrade() {
    return this.lockedUntil === null || this.now >= this.lockedUntil;
  }

  checkAccount(accountId) {
    if (Number(accountId) !== this.account.id) return 'account not found';
    return null;
  }

  // ── orders ───────────────────────────────────────────────────────────

  newId() {
    this.nextId += 1;
    return this.nextId;
  }

  placeOrder(body) {
    const accountErr = this.checkAccount(body.accountId);
    if (accountErr) return fail(1, accountErr, { orderId: null });
    const c = this.contracts.get(body.contractId);
    if (!c) return fail(8, `contract ${body.contractId} not found`, { orderId: null });
    if (!this.canTrade()) return fail(4, `account locked: ${this.lockReason}`, { orderId: null });
    const type = Number(body.type);
    const side = Number(body.side);
    const size = Number(body.size);
    if (![ORDER.limit, ORDER.market, ORDER.stop, ORDER.trailing, ORDER.joinBid, ORDER.joinAsk].includes(type)) return fail(2, `order type ${body.type} is not supported`, { orderId: null });
    if (side !== 0 && side !== 1) return fail(2, 'side must be 0 (buy) or 1 (sell)', { orderId: null });
    if (!Number.isInteger(size) || size <= 0) return fail(2, 'size must be a positive whole number', { orderId: null });
    const last = this.lastBar(body.contractId);
    if (!marketOpen(this.now) || !last || this.now - (last.ms + MINUTE) > STALE_MS) return fail(5, 'outside trading hours (no recent market data)', { orderId: null });
    const order = {
      id: this.newId(), accountId: this.account.id, contractId: body.contractId, creationTimestamp: new Date(this.now).toISOString(),
      updateTimestamp: new Date(this.now).toISOString(), status: STATUS.open, type, side, size,
      limitPrice: null, stopPrice: null, trailPrice: null, fillVolume: 0, filledPrice: null, customTag: body.customTag || null,
      placedAt: this.now, stopLossBracket: body.stopLossBracket || null, takeProfitBracket: body.takeProfitBracket || null, oco: null,
    };
    const priceErr = this.setPrices(order, body, c, last.c);
    if (priceErr) return fail(2, priceErr, { orderId: null });
    if (order.customTag && this.orders.some(o => o.customTag === order.customTag)) return fail(2, 'customTag must be unique', { orderId: null });
    this.orders.push(order);
    this.events.push({ at: order.creationTimestamp, kind: 'order', id: order.id, contractId: order.contractId, side, type, size });
    if (type === ORDER.market) this.fill(order, this.slip(last.c, side, c));
    else if (this.marketable(order, last.c)) this.fill(order, last.c);
    return ok({ orderId: order.id });
  }

  /** Set and validate price fields from a place/modify body. Returns an error message or null. */
  setPrices(order, body, c, lastPrice) {
    const num = v => (v === null || v === undefined ? null : Number(v));
    const onTick = p => Math.abs(Math.round(p / c.tickSize) * c.tickSize - p) < 1e-9;
    if (order.type === ORDER.limit) {
      const p = num(body.limitPrice) ?? order.limitPrice;
      if (!(p > 0) || !onTick(p)) return `limitPrice must be a positive multiple of the tick size ${c.tickSize}`;
      order.limitPrice = p;
    } else if (order.type === ORDER.joinBid || order.type === ORDER.joinAsk) {
      order.limitPrice = order.limitPrice ?? lastPrice; // no order book: join at the last price
    } else if (order.type === ORDER.stop) {
      const p = num(body.stopPrice) ?? order.stopPrice;
      if (!(p > 0) || !onTick(p)) return `stopPrice must be a positive multiple of the tick size ${c.tickSize}`;
      if (order.side === 0 ? p <= lastPrice : p >= lastPrice) return `a ${order.side === 0 ? 'buy' : 'sell'} stop must be ${order.side === 0 ? 'above' : 'below'} the market (last ${lastPrice})`;
      order.stopPrice = p;
    } else if (order.type === ORDER.trailing) {
      const p = num(body.trailPrice);
      if (p !== null) {
        if (!(p > 0) || (order.side === 0 ? p <= lastPrice : p >= lastPrice)) return `trailPrice must be a price level ${order.side === 0 ? 'above' : 'below'} the market (last ${lastPrice})`;
        order.trailDistance = Math.abs(lastPrice - p);
        order.stopPrice = p;
        order.trailPrice = order.trailDistance;
      }
    }
    if (body.size !== undefined && body.size !== null) {
      const size = Number(body.size);
      if (!Number.isInteger(size) || size <= 0) return 'size must be a positive whole number';
      order.size = size;
    }
    return null;
  }

  marketable(order, price) {
    if (order.limitPrice === null || ![ORDER.limit, ORDER.joinBid, ORDER.joinAsk].includes(order.type)) return false;
    return order.side === 0 ? price < order.limitPrice : price > order.limitPrice;
  }

  slip(price, side, c) {
    return price + (side === 0 ? 1 : -1) * this.slippageTicks * c.tickSize;
  }

  findOrder(body) {
    if (this.checkAccount(body.accountId)) return { err: fail(1, 'account not found') };
    const order = this.orders.find(o => o.id === Number(body.orderId));
    if (!order) return { err: fail(2, `order ${body.orderId} not found`) };
    if (order.status !== STATUS.open) return { err: fail(2, `order ${body.orderId} is not working`) };
    return { order };
  }

  modifyOrder(body) {
    const { order, err } = this.findOrder(body);
    if (err) return err;
    if (!this.canTrade()) return fail(6, `account locked: ${this.lockReason}`);
    const c = this.contracts.get(order.contractId);
    const draft = { ...order };
    const priceErr = this.setPrices(draft, body, c, this.lastPrice(order.contractId));
    if (priceErr) return fail(3, priceErr);
    Object.assign(order, draft, { updateTimestamp: new Date(this.now).toISOString() });
    if (this.marketable(order, this.lastPrice(order.contractId))) this.fill(order, this.lastPrice(order.contractId));
    return ok({});
  }

  cancelOrder(body) {
    const { order, err } = this.findOrder(body);
    if (err) return err;
    this.cancel(order);
    return ok({});
  }

  cancel(order) {
    order.status = STATUS.cancelled;
    order.updateTimestamp = new Date(this.now).toISOString();
  }

  publicOrder(o) {
    return {
      id: o.id, accountId: o.accountId, contractId: o.contractId, creationTimestamp: o.creationTimestamp, updateTimestamp: o.updateTimestamp,
      status: o.status, type: o.type, side: o.side, size: o.size, limitPrice: o.limitPrice, stopPrice: o.stopPrice,
      trailPrice: o.trailPrice, fillVolume: o.fillVolume, filledPrice: o.filledPrice, customTag: o.customTag,
    };
  }

  // ── positions and fills ──────────────────────────────────────────────

  net(contractId) {
    const p = this.positions.get(contractId);
    return p ? p.net : 0;
  }

  /** Fill an order completely at `price`, update the position, and record the trade. */
  fill(order, price) {
    const c = this.contracts.get(order.contractId);
    const px = Math.round(price / c.tickSize) * c.tickSize;
    order.status = STATUS.filled;
    order.fillVolume = order.size;
    order.filledPrice = px;
    order.updateTimestamp = new Date(this.now).toISOString();
    this.applyFill(order.contractId, order.side, order.size, px, order.id);
    if (order.oco) {
      for (const o of this.orders) if (o.oco === order.oco && o.id !== order.id && o.status === STATUS.open) this.cancel(o);
    }
    if (order.stopLossBracket || order.takeProfitBracket) this.attachBrackets(order, px, c);
  }

  attachBrackets(parent, px, c) {
    const exitSide = parent.side === 0 ? 1 : 0;
    const dir = parent.side === 0 ? 1 : -1;
    const oco = `oco-${parent.id}`;
    const leg = (bracket, sign) => {
      const ticks = Number(bracket.ticks);
      if (!(ticks > 0)) return;
      const type = Number(bracket.type) || (sign < 0 ? ORDER.stop : ORDER.limit);
      const level = px + sign * dir * ticks * c.tickSize;
      const o = {
        id: this.newId(), accountId: this.account.id, contractId: parent.contractId, creationTimestamp: new Date(this.now).toISOString(),
        updateTimestamp: new Date(this.now).toISOString(), status: STATUS.open, type, side: exitSide, size: parent.size,
        limitPrice: null, stopPrice: null, trailPrice: null, fillVolume: 0, filledPrice: null, customTag: null, placedAt: this.now, oco,
        stopLossBracket: null, takeProfitBracket: null,
      };
      if (type === ORDER.stop) o.stopPrice = level;
      else if (type === ORDER.trailing) { o.stopPrice = level; o.trailDistance = ticks * c.tickSize; o.trailPrice = o.trailDistance; } else o.limitPrice = level;
      this.orders.push(o);
    };
    if (parent.stopLossBracket) leg(parent.stopLossBracket, -1);
    if (parent.takeProfitBracket) leg(parent.takeProfitBracket, 1);
  }

  applyFill(contractId, side, size, price, orderId) {
    const c = this.contracts.get(contractId);
    const sign = side === 0 ? 1 : -1;
    const pos = this.positions.get(contractId) || { net: 0, avg: 0, id: this.newId(), openedAt: this.now };
    let pnl = null;
    if (pos.net === 0 || Math.sign(pos.net) === sign) {
      const total = Math.abs(pos.net) + size;
      pos.avg = (Math.abs(pos.net) * pos.avg + size * price) / total;
      if (pos.net === 0) pos.openedAt = this.now;
      pos.net += sign * size;
    } else {
      const closing = Math.min(size, Math.abs(pos.net));
      pnl = round2((price - pos.avg) * Math.sign(pos.net) * closing * (c.tickValue / c.tickSize));
      pos.net += sign * closing;
      const opening = size - closing;
      if (opening > 0) {
        pos.net = sign * opening;
        pos.avg = price;
        pos.openedAt = this.now;
        pos.id = this.newId();
      }
    }
    const fees = round2((c.feesPerSide ?? this.feesPerSide) * size);
    this.account.balance += (pnl || 0) - fees;
    if (pos.net === 0) this.positions.delete(contractId);
    else this.positions.set(contractId, pos);
    const trade = {
      id: this.newId(), accountId: this.account.id, contractId, creationTimestamp: new Date(this.now).toISOString(),
      price, profitAndLoss: pnl, fees, side, size, voided: false, orderId,
    };
    this.trades.push(trade);
    return trade;
  }

  /** Market order created by the broker itself (position close, liquidation). */
  marketClose(contractId, size, why) {
    const pos = this.positions.get(contractId);
    if (!pos) return;
    const c = this.contracts.get(contractId);
    const side = pos.net > 0 ? 1 : 0;
    const order = {
      id: this.newId(), accountId: this.account.id, contractId, creationTimestamp: new Date(this.now).toISOString(),
      updateTimestamp: new Date(this.now).toISOString(), status: STATUS.open, type: ORDER.market, side, size,
      limitPrice: null, stopPrice: null, trailPrice: null, fillVolume: 0, filledPrice: null, customTag: null, placedAt: this.now, oco: null,
    };
    this.orders.push(order);
    this.events.push({ at: order.creationTimestamp, kind: 'close', contractId, size, why });
    this.fill(order, this.slip(this.lastPrice(contractId), side, c));
  }

  closePosition(body, partial) {
    if (this.checkAccount(body.accountId)) return fail(1, 'account not found');
    const c = this.contracts.get(body.contractId);
    if (!c) return fail(3, `contract ${body.contractId} not found`);
    const pos = this.positions.get(body.contractId);
    if (!pos) return fail(2, 'no open position');
    if (!marketOpen(this.now) || !this.lastBar(body.contractId)) return fail(6, 'market closed or no price');
    const size = partial ? Number(body.size) : Math.abs(pos.net);
    if (!Number.isInteger(size) || size <= 0 || size > Math.abs(pos.net)) return fail(5, 'invalid close size');
    this.marketClose(body.contractId, size, partial ? 'partialCloseContract' : 'closeContract');
    return ok({});
  }

  positionsView() {
    return [...this.positions.entries()].map(([contractId, p]) => ({
      id: p.id, accountId: this.account.id, contractId, creationTimestamp: new Date(p.openedAt).toISOString(),
      type: p.net > 0 ? 1 : 2, size: Math.abs(p.net), averagePrice: Math.round(p.avg * 1e6) / 1e6,
    }));
  }

  unrealized() {
    let total = 0;
    for (const [contractId, p] of this.positions) {
      const c = this.contracts.get(contractId);
      const last = this.lastPrice(contractId);
      if (last !== null) total += (last - p.avg) * p.net * (c.tickValue / c.tickSize);
    }
    return total;
  }

  // ── simulated time ───────────────────────────────────────────────────

  /** Move the clock to `ms`, filling resting orders on every 1-minute bar that closes on the way. */
  advanceTo(ms) {
    if (ms < this.now) throw new Error('the simulated clock cannot go backwards');
    for (;;) {
      // Next 1-minute bar (across instruments) that closes by `ms`.
      let next = null;
      for (const c of this.contracts.values()) {
        const b = c.bars[c.cursor];
        if (b && b.ms + MINUTE <= ms && (!next || b.ms < next.bar.ms)) next = { c, bar: b };
      }
      if (!next) break;
      this.rollDay(next.bar.ms);
      next.c.cursor += 1;
      this.now = Math.max(this.now, next.bar.ms + MINUTE);
      this.processBar(next.c, next.bar);
      this.checkRiskRules();
    }
    this.rollDay(ms);
    this.now = ms;
  }

  /** At each 17:00 CT boundary: record the end-of-day balance and lift a daily lock. */
  rollDay(ms) {
    const start = tradingDayStart(new Date(ms)).getTime();
    if (start === this.dayStart) return;
    const eodBalance = this.account.balance + this.unrealized();
    this.eodHigh = Math.max(this.eodHigh, eodBalance);
    this.equityCurve.push({ day: new Date(this.dayStart).toISOString(), balance: round2(eodBalance) });
    this.dayStart = start;
  }

  processBar(c, bar) {
    const working = this.orders.filter(o => o.contractId === c.contractId && o.status === STATUS.open && o.placedAt < bar.ms + MINUTE && o.type !== ORDER.market);
    // Stops first: when one bar touches both bracket legs, assume the stop filled.
    const stops = working.filter(o => o.type === ORDER.stop || o.type === ORDER.trailing);
    const limits = working.filter(o => o.type !== ORDER.stop && o.type !== ORDER.trailing);
    for (const o of [...stops, ...limits]) {
      if (o.status !== STATUS.open) continue; // an OCO sibling filled
      if (o.type === ORDER.stop || o.type === ORDER.trailing) {
        const hit = o.side === 0 ? bar.h >= o.stopPrice : bar.l <= o.stopPrice;
        if (hit) {
          const base = o.side === 0 ? Math.max(bar.o, o.stopPrice) : Math.min(bar.o, o.stopPrice);
          this.fill(o, this.slip(base, o.side, c));
        } else if (o.type === ORDER.trailing && o.trailDistance) {
          const lvl = o.side === 0 ? bar.l + o.trailDistance : bar.h - o.trailDistance;
          o.stopPrice = Math.round((o.side === 0 ? Math.min(o.stopPrice, lvl) : Math.max(o.stopPrice, lvl)) / c.tickSize) * c.tickSize;
        }
      } else {
        const p = o.limitPrice;
        if (o.side === 0 && (bar.o <= p || bar.l < p)) this.fill(o, Math.min(bar.o, p));
        else if (o.side === 1 && (bar.o >= p || bar.h > p)) this.fill(o, Math.max(bar.o, p));
      }
    }
  }

  realizedToday() {
    return this.trades
      .filter(t => Date.parse(t.creationTimestamp) >= this.dayStart)
      .reduce((s, t) => s + (t.profitAndLoss || 0) - t.fees, 0);
  }

  /** Cancel every working order and close every position at market (end of a backtest). */
  flattenAll(reason) {
    for (const o of this.orders) if (o.status === STATUS.open) this.cancel(o);
    for (const [contractId, p] of [...this.positions]) {
      if (this.lastPrice(contractId) !== null) this.marketClose(contractId, Math.abs(p.net), reason);
    }
  }

  liquidate(reason, until) {
    for (const o of this.orders) if (o.status === STATUS.open) this.cancel(o);
    for (const [contractId, p] of [...this.positions]) this.marketClose(contractId, Math.abs(p.net), reason);
    this.lockedUntil = until;
    this.lockReason = reason;
    this.events.push({ at: new Date(this.now).toISOString(), kind: 'lock', reason });
  }

  checkRiskRules() {
    if (!this.canTrade() && this.positions.size === 0) return;
    const equity = this.account.balance + this.unrealized();
    if (this.maxLossLimit) {
      const floor = Math.min(this.eodHigh - this.maxLossLimit, this.startingBalance);
      if (equity <= floor) {
        this.liquidate(`maximum loss limit: equity ${round2(equity)} reached ${round2(floor)}`, Infinity);
        return;
      }
    }
    if (this.dailyLossLimit && this.realizedToday() + this.unrealized() <= -this.dailyLossLimit && this.canTrade()) {
      const nextDay = this.dayStart + 24 * 3600 * 1000; // lifted at the next 17:00 CT boundary (rollDay keeps dayStart in step)
      this.liquidate(`daily loss limit ${this.dailyLossLimit} reached`, nextDay);
    }
  }

  // ── REST dispatch ────────────────────────────────────────────────────

  /** Handle one Gateway API call. Returns the JSON body ProjectX would return. */
  handle(path, body = {}) {
    switch (path) {
      case '/api/Auth/loginKey': return ok({ token: 'backtest-token' });
      case '/api/Auth/validate': return ok({ newToken: 'backtest-token' });
      case '/api/Account/search': return ok({ accounts: [this.accountView()] });
      case '/api/Contract/search': return ok({ contracts: this.searchContracts(body.searchText) });
      case '/api/Contract/available': return ok({ contracts: [...this.contracts.values()].map(c => this.contractInfo(c)) });
      case '/api/Contract/searchById': {
        const c = this.contracts.get(body.contractId);
        return c ? ok({ contract: this.contractInfo(c) }) : fail(1, 'contract not found', { contract: null });
      }
      case '/api/History/retrieveBars': return this.retrieveBars(body);
      case '/api/Order/place': return this.placeOrder(body);
      case '/api/Order/modify': return this.modifyOrder(body);
      case '/api/Order/cancel': return this.cancelOrder(body);
      case '/api/Order/searchOpen':
        if (this.checkAccount(body.accountId)) return fail(1, 'account not found', { orders: [] });
        return ok({ orders: this.orders.filter(o => o.status === STATUS.open).map(o => this.publicOrder(o)) });
      case '/api/Order/search': {
        if (this.checkAccount(body.accountId)) return fail(1, 'account not found', { orders: [] });
        const [from, to] = this.window(body);
        return ok({ orders: this.orders.filter(o => this.inWindow(o.creationTimestamp, from, to)).map(o => this.publicOrder(o)) });
      }
      case '/api/Position/searchOpen':
        if (this.checkAccount(body.accountId)) return fail(1, 'account not found', { positions: [] });
        return ok({ positions: this.positionsView() });
      case '/api/Position/closeContract': return this.closePosition(body, false);
      case '/api/Position/partialCloseContract': return this.closePosition(body, true);
      case '/api/Trade/search': {
        if (this.checkAccount(body.accountId)) return fail(1, 'account not found', { trades: [] });
        const [from, to] = this.window(body);
        return ok({ trades: this.trades.filter(t => this.inWindow(t.creationTimestamp, from, to)) });
      }
      default: return null;
    }
  }

  window(body) {
    const from = body.startTimestamp ? Date.parse(body.startTimestamp) : -Infinity;
    const to = body.endTimestamp ? Date.parse(body.endTimestamp) : Infinity;
    return [from, to];
  }

  inWindow(iso, from, to) {
    const t = Date.parse(iso);
    return t >= from && t <= to && t <= this.now;
  }
}

module.exports = { SimBroker, ORDER, STATUS, marketOpen };
