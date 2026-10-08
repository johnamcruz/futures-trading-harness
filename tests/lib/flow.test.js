'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createFlowBook, withFlow, flowCsv, parseFlowCsv } = require('../../scripts/lib/trading/flow');
const { createHub, RS } = require('../../scripts/lib/signalr');
const { createRecorder, readFlow } = require('../../scripts/lib/orderflow-recorder');
const { barDelta, ofi, normalizeBars } = require('../../scripts/lib/trading/indicators');
const { loadBars, aggregate } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const M = 60000;
const T0 = Date.UTC(2026, 9, 8, 14, 0);
const C = 'CON.F.US.MNQ.Z26';
const at = (min, sec = 0) => new Date(T0 + min * M + sec * 1000).toISOString();

test('prints without a type are classified against the quote: at/above the ask buys, at/below the bid sells, else by the mid, then the tick rule', () => {
  const b = createFlowBook();
  b.connected(C, T0 - M);
  b.quote(C, { bestBid: 100, bestAsk: 100.25 });
  b.trades(C, [
    { price: 100.25, volume: 3, timestamp: at(0, 1) },
    { price: 100, volume: 2, timestamp: at(0, 2) },
    { price: 100.5, volume: 1, timestamp: at(0, 3) },
  ], T0 + 5000);
  b.quote(C, { bestBid: 100, bestAsk: 100.5 });
  b.trades(C, [{ price: 100.25, volume: 4, timestamp: at(0, 4) }], T0 + 6000); // at the mid: tick rule, down from 100.5
  const m = b.finished(C, { now: T0 + M, graceMs: 0 }).find(r => r.t === T0);
  assert.deepStrictEqual(m, { t: T0, bv: 4, sv: 6 });
});

test('the hub\'s trade type is the aggressor side (0 buy, 1 sell) and wins over the quote', () => {
  const b = createFlowBook();
  b.connected(C, T0 - M);
  b.quote(C, { bestBid: 100, bestAsk: 100.25 });
  b.trades(C, [{ price: 100, volume: 5, type: 0, timestamp: at(0, 1) }, { price: 100.25, volume: 2, type: 1, timestamp: at(0, 2) }], T0 + 3000);
  assert.deepStrictEqual(b.finished(C, { now: T0 + M, graceMs: 0 }).find(r => r.t === T0), { t: T0, bv: 5, sv: 2 });
});

test('a minute counts only when the hub was connected for all of it; quiet minutes are zero only near a print', () => {
  const b = createFlowBook();
  b.connected(C, T0 + 30000); // connected mid-minute 0
  b.quote(C, { bestBid: 100, bestAsk: 100.25 });
  b.trades(C, [{ price: 100.25, volume: 1, timestamp: at(0, 40) }, { price: 100.25, volume: 2, timestamp: at(1, 5) }], T0 + 70000);
  b.disconnected(T0 + 2 * M + 30000); // drops mid-minute 2
  const rows = b.finished(C, { now: T0 + 5 * M });
  assert.deepStrictEqual(rows, [{ t: T0 + M, bv: 2, sv: 0 }], 'minute 0 started before the connection; minute 2 has a gap');
  // Quiet minutes after a print are zero; a feed silent past the stale window is unknown.
  const quiet = createFlowBook();
  quiet.connected(C, T0);
  quiet.trades(C, [{ price: 100, volume: 1, type: 0, timestamp: at(0, 5) }], T0 + 6000);
  const got = quiet.finished(C, { now: T0 + 20 * M });
  assert.deepStrictEqual(got.map(r => (r.t - T0) / M), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(got[1], { t: T0 + M, bv: 0, sv: 0 });
  const silent = createFlowBook();
  silent.connected(C, T0);
  assert.deepStrictEqual(silent.finished(C, { now: T0 + 3 * M }), [], 'connected but no print yet: unknown');
});

test('bars get flow only when every minute is known; CSV round-trips', () => {
  const map = new Map([[T0, { bv: 3, sv: 1 }], [T0 + M, { bv: 0, sv: 2 }], [T0 + 2 * M, { bv: 1, sv: 1 }]]);
  const bars = [{ t: at(0), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: at(3), o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const out = withFlow(bars, map, 3);
  assert.deepStrictEqual([out[0].bv, out[0].sv, out[1].bv], [4, 4, undefined]);
  assert.deepStrictEqual(parseFlowCsv(flowCsv([{ t: T0, bv: 1.5, sv: 2 }])), [{ t: T0, bv: 1.5, sv: 2 }]);
});

test('real flow replaces the bar-shape estimate in delta and ofi', () => {
  const bars = normalizeBars([{ t: at(0), o: 10, h: 11, l: 9, c: 11, v: 10, bv: 2, sv: 8 }, { t: at(1), o: 11, h: 12, l: 10, c: 12, v: 10 }]);
  assert.deepStrictEqual(barDelta(bars), [-6, 10], 'real flow on the first bar, the estimate on the second');
  assert.strictEqual(ofi(bars, 1)[0], -0.6);
});

test('data files: buy/sell volume (or delta) columns load, and aggregate only where every minute has flow', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.csv');
  fs.writeFileSync(file, `time,open,high,low,close,volume,buy_volume,sell_volume\n${at(0)},1,2,0,1,10,6,4\n${at(1)},1,2,0,1,10,3,7\n${at(2)},1,2,0,1,10,,\n${at(3)},1,2,0,1,10,5,5\n`);
  const bars = loadBars(file);
  assert.deepStrictEqual(bars.map(b => [b.bv, b.sv]), [[6, 4], [3, 7], [undefined, undefined], [5, 5]]);
  const agg = aggregate(bars, { unit: 2, unitNumber: 2, nowMs: T0 + 4 * M });
  assert.deepStrictEqual(agg.map(b => [b.bv, b.sv]), [[9, 11], [undefined, undefined]]);
  const dfile = path.join(dir, 'd.csv');
  fs.writeFileSync(dfile, `time,open,high,low,close,volume,delta\n${at(0)},1,2,0,1,10,4\n`);
  assert.deepStrictEqual(loadBars(dfile).map(b => [b.bv, b.sv]), [[7, 3]]);
});

/** A fake WebSocket speaking the server side of SignalR. */
function fakeSockets() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      setImmediate(() => { this.readyState = 1; this.onopen && this.onopen(); });
    }
    send(text) {
      this.sent.push(text);
      for (const part of text.split(RS).filter(Boolean)) {
        const msg = JSON.parse(part);
        if (msg.protocol) this.push({});
        else if (msg.type === 1) this.push({ type: 3, invocationId: msg.invocationId, result: null });
      }
    }
    push(msg) { setImmediate(() => this.onmessage && this.onmessage({ data: JSON.stringify(msg) + RS })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; setImmediate(() => this.onclose && this.onclose()); }
  }
  return { FakeWS, sockets };
}

test('signalr: handshake, invoke, server events, and resubscribe after a reconnect', async () => {
  const { FakeWS, sockets } = fakeSockets();
  const seen = [];
  let connects = 0;
  let drops = 0;
  const hub = createHub({
    url: 'https://rtc.example.com/hubs/market', getToken: async () => 'tok', WebSocketImpl: FakeWS,
    onConnected: async h => { connects += 1; await h.invoke('SubscribeContractTrades', C); },
    onDisconnected: () => { drops += 1; },
  });
  hub.on('GatewayTrade', (id, data) => seen.push([id, data]));
  await hub.start();
  assert.match(sockets[0].url, /^wss:\/\/rtc\.example\.com\/hubs\/market\?access_token=tok$/);
  assert.ok(sockets[0].sent.some(s => s.includes('"target":"SubscribeContractTrades"')));
  sockets[0].push({ type: 1, target: 'GatewayTrade', arguments: [C, [{ price: 1, volume: 2 }]] });
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(seen, [[C, [{ price: 1, volume: 2 }]]]);
  sockets[0].close();
  await new Promise(r => setTimeout(r, 1200)); // first backoff is 1 s
  assert.deepStrictEqual([drops, connects, sockets.length], [1, 2, 2]);
  hub.close();
});

test('recorder: subscribes, writes finished minutes to the flow file, and annotates bars', async () => {
  const home = tmpDir();
  let now = T0 - 30000;
  const handlers = {};
  const invoked = [];
  const fakeHub = ({ onConnected }) => ({
    on: (name, fn) => { handlers[name] = fn; },
    invoke: async (target, id) => { invoked.push([target, id]); },
    start: () => onConnected(fakeHubApi),
    close: () => {},
    get connected() { return true; },
  });
  let fakeHubApi = null;
  const recorder = createRecorder({ home, getToken: async () => 't', now: () => now, hubFactory: opts => (fakeHubApi = fakeHub(opts)) });
  recorder.follow(C);
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(invoked, [['SubscribeContractQuotes', C], ['SubscribeContractTrades', C]]);
  handlers.GatewayQuote(C, { bestBid: 100, bestAsk: 100.25 });
  now = T0 + 10000;
  handlers.GatewayTrade(C, [{ price: 100.25, volume: 3, timestamp: at(0, 10) }, { price: 100, volume: 1, timestamp: at(0, 20) }]);
  now = T0 + 3 * M + 11000; // after the flush grace
  const bars = recorder.annotate(C, [{ t: at(0), o: 100, h: 100.25, l: 100, c: 100.25, v: 4 }], 3);
  assert.deepStrictEqual([bars[0].bv, bars[0].sv], [3, 1]);
  assert.deepStrictEqual(readFlow(home, C).map(r => [r.t, r.bv, r.sv]), [[T0, 3, 1], [T0 + M, 0, 0], [T0 + 2 * M, 0, 0]]);
  recorder.annotate(C, [], 3);
  assert.strictEqual(readFlow(home, C).length, 3, 'minutes are written once');
  recorder.close();
});

test('flow that misses most of a bar\'s volume is not used; the estimate is', () => {
  const bars = normalizeBars([{ t: at(0), o: 10, h: 11, l: 9, c: 11, v: 2000, bv: 30, sv: 10 }]);
  assert.deepStrictEqual(barDelta(bars), [2000], 'bar-shape estimate (close at the high), not the partial flow');
});

test('signalr: a failed handshake still schedules a reconnect; coverage ends at the last message', async () => {
  const { FakeWS, sockets } = fakeSockets();
  let fail = true;
  class Flaky extends FakeWS {
    send(text) {
      if (fail && text.includes('"protocol"')) { this.push({ error: 'denied' }); return; }
      super.send(text);
    }
  }
  const drops = [];
  const hub = createHub({ url: 'https://h.example.com/hubs/market', getToken: async () => 't', WebSocketImpl: Flaky, onDisconnected: at2 => drops.push(at2) });
  await hub.start();
  assert.strictEqual(hub.connected, false);
  fail = false;
  await new Promise(r => setTimeout(r, 1300));
  assert.strictEqual(hub.connected, true, 'retried after the failed handshake');
  assert.strictEqual(sockets.length, 2);
  hub.close();
});

test('recorded zero minutes reloaded after a restart do not count as prints', () => {
  const b = createFlowBook();
  b.load(C, [{ t: T0, bv: 3, sv: 1 }, ...[1, 2, 3, 4, 5].map(k => ({ t: T0 + k * M, bv: 0, sv: 0 }))]);
  b.connected(C, T0 + 6 * M);
  const known = b.finished(C, { now: T0 + 15 * M, graceMs: 0 }).map(r => (r.t - T0) / M);
  assert.ok(!known.includes(6), 'silent since minute 0: minute 6 is past the stale window, unknown');
});
