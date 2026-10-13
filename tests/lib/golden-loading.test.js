'use strict';

// Golden regression: loading. Bars that carry a broker's own nested fields load, normalize, aggregate and
// serialize through every loader (the broker adapter's history and closed bars, the bars file the scripts
// write, backtest loadBars / normalizeBars / aggregate, which refuses them unless told to drop them) with OHLCV
// identical to the same bars without them,
// and the fields pass through untouched; and every strategy and account parses as pinned.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { TEST_ACCOUNTS, tmpDir } = require('../helpers');
const { loadBars, readBarsArg, aggregate } = require('../../scripts/lib/backtest/data');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const { createAdapter } = require('../../scripts/lib/broker/adapter');
const { fetchBarsToFile } = require('../../scripts/lib/bars-fetch');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');

/** A broker MCP client serving `bars` (minute bars) from get_bars by time window, as a replay or live server does. */
function servingClient(bars, { minutes = 3 } = {}) {
  const calls = [];
  const mcp = {
    async call(name, args) {
      calls.push([name, { ...args }]);
      if (name === 'search_contracts') return [{ id: args.searchText, name: `${args.searchText}Z6`, tickSize: 0.25, tickValue: 0.5, activeContract: true }];
      if (name !== 'get_bars') throw new Error(`unexpected ${name}`);
      const from = Date.parse(args.startTime);
      const to = Date.parse(args.endTime);
      // Closed bars only: a bar is served once its close is at or before endTime; newest first, as a server may send them.
      const out = bars.filter(b => Date.parse(b.t) >= from && Date.parse(b.t) + minutes * 60000 <= to).slice(-args.limit);
      return { bars: JSON.parse(JSON.stringify(out)).reverse() };
    },
  };
  return { adapter: createAdapter({ mcp }), calls };
}

/** Every loader's view of one series: [label, bars]. */
async function viaLoaders(raw, minutes) {
  const dir = tmpDir();
  const out = [];
  out.push(['normalizeBars', normalizeBars(raw)]);
  out.push(['normalizeBars get_bars reply', normalizeBars({ bars: raw })]);
  const reply = path.join(dir, 'reply.json');
  fs.writeFileSync(reply, JSON.stringify({ contractId: 'MNQ', bars: raw }));
  out.push(['loadBars get_bars JSON file', loadBars(reply)]);
  const array = path.join(dir, 'array.json');
  fs.writeFileSync(array, JSON.stringify(raw));
  out.push(['readBarsArg JSON array file', readBarsArg(array)]);
  // Serialized and read back (the bars file is JSON).
  out.push(['JSON round trip', normalizeBars(JSON.parse(JSON.stringify(normalizeBars(raw))))]);
  const lastClose = Date.parse(raw.at(-1).t) + minutes * 60000;
  const { adapter } = servingClient(raw, { minutes });
  out.push(['adapter closedBars', await adapter.closedBars('MNQ', { minutes, limit: 400, now: new Date(lastClose) })]);
  out.push(['adapter history', await adapter.history('MNQ', { from: new Date(Date.parse(raw[0].t)), to: new Date(lastClose), timeframe: minutes })]);
  // The bars file the scripts and harness tools write (bars-fetch), then read back as the agents and scans read it.
  const env = { FTH_HOME: dir };
  const fetched = await fetchBarsToFile({ client: adapter, symbol: 'MNQ', timeframe: minutes, count: 400, now: new Date(lastClose), env, outDir: path.join(dir, 'bars-scratch') });
  out.push(['bars file (fetchBarsToFile)', JSON.parse(fs.readFileSync(fetched.file, 'utf8')).bars]);
  out.push(['bars file read by loadBars', loadBars(fetched.file)]);
  out.push(['aggregate 15m (fields dropped)', aggregate(loadBars(reply), { unit: 2, unitNumber: 15, nowMs: lastClose, extraFields: 'drop' })]);
  out.push(['aggregate 1h (fields dropped)', aggregate(loadBars(reply), { unit: 3, unitNumber: 1, nowMs: lastClose, extraFields: 'drop' })]);
  // Without 'drop', bars that carry the broker's fields are refused (the harness can't combine them); plain ones aggregate.
  let byDefault;
  try { byDefault = aggregate(loadBars(reply), { unit: 2, unitNumber: 15, nowMs: lastClose }); } catch (err) { byDefault = err.message; }
  out.push(['aggregate 15m (default)', byDefault]);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('every loader gives the same OHLCV with and without a broker\'s nested bar fields, and keeps the fields', async () => {
  const lines = [];
  for (const s of G.SERIES) {
    const plain = G.served(G.load(s));
    const ext = G.broker(G.load(s)).map(({ ms, ...rest }) => rest); // eslint-disable-line no-unused-vars
    const [a, b] = [await viaLoaders(plain, s.minutes), await viaLoaders(ext, s.minutes)];
    assert.deepStrictEqual(a.map(x => x[0]), b.map(x => x[0]));
    for (let k = 0; k < a.length; k += 1) {
      const [label, bars] = a[k];
      const withFields = b[k][1];
      if (label === 'aggregate 15m (default)') {
        assert.ok(Array.isArray(bars) && bars.length > 3, `${s.label}: plain bars aggregate by default`);
        assert.match(String(withFields), /carry the broker's own fields \(ext, flow\).*fetch bars at the timeframe you need from the broker/, `${s.label}: refused with the broker's fields`);
        lines.push(`${s.label} ${label}: plain ${bars.length} bars ohlcv ${G.digest(G.ohlcv(bars))}; with the broker's fields refused: ${withFields}`);
        continue;
      }
      assert.ok(bars.length >= 3, `${s.symbol} ${label}: bars`);
      assert.deepStrictEqual(G.ohlcv(withFields), G.ohlcv(bars), `${s.symbol} ${label}: OHLCV with the broker's fields is the same`);
      assert.ok(bars.every(x => !('ext' in x) && !('flow' in x)), `${s.symbol} ${label}: no fields where none were served`);
      // A built (aggregated) bar carries no broker fields: only the broker knows what they mean over a longer bar.
      const aggregated = label.startsWith('aggregate');
      const byTime = new Map(ext.map(x => [Date.parse(x.t), x]));
      for (const x of withFields) {
        if (aggregated) assert.ok(!('ext' in x) && !('flow' in x), `${s.symbol} ${label}: a built bar has no broker fields`);
        else assert.deepStrictEqual([x.ext, x.flow], [byTime.get(Date.parse(x.t)).ext, byTime.get(Date.parse(x.t)).flow], `${s.symbol} ${label}: the broker's fields as served, at ${x.t}`);
      }
      lines.push(`${s.label} ${label}: ${bars.length} bars ${G.ohlcv(bars)[0].t} .. ${G.ohlcv(bars).at(-1).t} ohlcv ${G.digest(G.ohlcv(bars))} fields ${aggregated ? 'none (built bars)' : 'kept'}`);
    }
  }
  assertGolden('loading-bars.txt', lines.join('\n'));
});

test('the adapter asks the broker for the same bars whatever fields its bars carry', async () => {
  const s = G.SERIES[0];
  const plain = G.served(G.load(s));
  const ask = async bars => {
    const { adapter, calls } = servingClient(bars);
    const last = Date.parse(bars.at(-1).t) + 3 * 60000;
    await adapter.closedBars('MNQ', { minutes: 3, limit: 400, now: new Date(last) });
    await adapter.history('MNQ', { from: new Date(Date.parse(bars[0].t)), to: new Date(last), timeframe: 3 });
    return calls;
  };
  const calls = await ask(plain);
  assert.deepStrictEqual(await ask(G.broker(plain)), calls);
  assertGolden('loading-requests.txt', calls.map(([name, args]) => `${name} ${JSON.stringify(args)}`).join('\n'));
});

/** A parsed document as pinned: every field but its path, its body by size and hash, compiled rules by hash. */
function pinned(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc).sort(([a], [b]) => a.localeCompare(b))) {
    if (k === 'file') continue;
    if (k === 'body') out.body = `${String(v).length} chars sha256:${G.digest(String(v))}`;
    else if (/^compiled/.test(k)) out[k] = v === null || v === undefined ? v : `sha256:${G.digest(v)}`;
    else out[k] = v;
  }
  return out;
}

test('every strategy and account loads and validates as pinned (shipped, fixture accounts, and the fixture strategy)', () => {
  const shipped = loadStrategies(G.ROOT, {});
  const withFixture = loadStrategies(G.ROOT, { FTH_STRATEGIES_DIRS: G.EXT_STRATEGIES });
  assert.deepStrictEqual(shipped.problems, []);
  assert.ok(shipped.strategies.every(s => s.valid), shipped.strategies.filter(s => !s.valid).map(s => `${s.name}: ${s.errors.join('; ')}`).join('\n'));
  // The fixture strategy adds itself and changes no other.
  assert.deepStrictEqual(withFixture.strategies.filter(s => s.name !== 'ext_reader').map(pinned), shipped.strategies.map(pinned));
  assert.ok(withFixture.strategies.find(s => s.name === 'ext_reader').valid);
  const accounts = loadAccounts(G.ROOT, {});
  const fixture = loadAccounts(G.ROOT, { FTH_ACCOUNTS_DIRS: TEST_ACCOUNTS });
  assert.deepStrictEqual(accounts.problems, []);
  const text = [
    `strategies (${shipped.strategies.length}): ${shipped.strategies.map(s => s.name).join(', ')}`,
    ...withFixture.strategies.map(s => `strategy ${s.name}: ${JSON.stringify(pinned(s), null, 2)}`),
    `accounts (${fixture.accounts.length}): ${fixture.accounts.map(a => a.name).join(', ')}`,
    ...fixture.accounts.map(a => `account ${a.name}: ${JSON.stringify(pinned(a), null, 2)}`),
    `problems: ${JSON.stringify([...shipped.problems, ...accounts.problems, ...fixture.problems])}`,
  ];
  assertGolden('loading-documents.txt', text.join('\n'));
});
