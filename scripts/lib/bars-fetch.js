'use strict';

/**
 * Fetch closed bars for a symbol into a file the harness scripts read
 * (market-snapshot, mtf, strategies scan), so an agent never pastes thousands
 * of bars through a tool reply and never sees the credentials: scripts/bars.js
 * loads them from the user's .env and calls this.
 *
 * The file is projectx get_bars JSON ({ contractId, barSize, count, bars }),
 * the same shape as the autonomous runner's bars file.
 */

const fs = require('fs');
const path = require('path');
const { normalizeBars } = require('./trading/indicators');

const MAX_COUNT = 20000; // ProjectX's retrieveBars limit per request

/** Problems with the request: [message]. */
function requestErrors({ symbol, timeframe, daily, count }) {
  const errors = [];
  if (!/^[A-Z0-9]+$/.test(String(symbol || ''))) errors.push('--symbol: a contract root, e.g. MNQ');
  if (!daily && !(Number.isInteger(timeframe) && timeframe >= 1 && timeframe <= 60)) errors.push('--timeframe: minutes per bar, 1 to 60 (or --daily)');
  if (!(Number.isInteger(count) && count >= 3 && count <= MAX_COUNT)) errors.push(`--count: 3 to ${MAX_COUNT} bars`);
  return errors;
}

/** The default file: /tmp/fth/<SYMBOL>-<tf>m.json or -1d.json. */
const defaultOut = (symbol, timeframe, daily) => path.join('/tmp/fth', `${symbol}-${daily ? '1d' : `${timeframe}m`}.json`);

/**
 * { file, contractId, count, first, last, closedAt } after writing the bars.
 * `client`: projectx-rest (activeContract, closedBars).
 */
async function fetchBarsToFile({ client, symbol, timeframe = 3, daily = false, count = 2000, out = null, now = new Date() }) {
  const errors = requestErrors({ symbol, timeframe, daily, count });
  if (errors.length) throw new Error(errors.join('; '));
  const contract = await client.activeContract(symbol);
  const raw = await client.closedBars(contract.id, { minutes: timeframe, limit: count, now, daily });
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`only ${bars.length} closed bars for ${contract.id}; the market may be closed or the contract new`);
  const file = path.resolve(out || defaultOut(symbol, timeframe, daily));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ contractId: contract.id, barSize: daily ? '1 day' : `${timeframe} minute`, count: bars.length, bars }));
  fs.renameSync(tmp, file);
  const last = bars[bars.length - 1];
  const step = daily ? 864e5 : timeframe * 60000;
  return { file, contractId: contract.id, tickSize: contract.tickSize, tickValue: contract.tickValue, count: bars.length, first: bars[0].t, last: last.t, closedAt: new Date(Date.parse(last.t) + step).toISOString(), bars };
}

module.exports = { MAX_COUNT, requestErrors, defaultOut, fetchBarsToFile };
