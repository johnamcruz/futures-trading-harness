'use strict';

/**
 * Broker bar fields a backtest's bars don't carry. A rules strategy may read a field the broker puts
 * on its bars (`field("a.b")` in its rules, stop or target); a CSV, or bars the backtester builds from
 * shorter ones, carries none, so every condition on it is false there. Such a run can pick
 * differently from live and replay, whose bars carry the fields: the backtester says so.
 *
 *   fieldPaths(strategy)                  the dotted paths its rules, risk and exit read with field() (rules.js)
 *   carries(bar, path)                    the rules can read a value there (rules.js readField: a number or a boolean)
 *   missingBarFields(strategies, markets, trades)
 *                                         [{ strategy, path, symbols }]: a path no bar of a market it trades carries
 *   describeMissing(m)                    one line saying so
 */

const { readField, fieldPathsIn } = require('../trading/rules');

function strings(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
}

function fieldPaths(strategy) {
  const s = strategy || {};
  const paths = new Set();
  for (const text of strings([s.rules, s.risk, s.exit])) for (const p of fieldPathsIn(text)) paths.add(p);
  return [...paths].sort();
}

const carries = (bar, p) => !Number.isNaN(readField(bar, p));

/** `trades(strategy, symbol)`: whether the strategy trades that market (default: every one). */
function missingBarFields(strategies, markets, trades = () => true) {
  const out = [];
  for (const s of strategies || []) {
    for (const p of fieldPaths(s)) {
      const symbols = (markets || []).filter(m => trades(s, m.symbol) && !(m.bars || []).some(b => carries(b, p))).map(m => m.symbol);
      if (symbols.length) out.push({ strategy: s.name, path: p, symbols });
    }
  }
  return out;
}

const describeMissing = m => `${m.strategy} reads field("${m.path}"), which no ${m.symbols.join(', ')} bar in this data carries: `
  + 'its conditions on it are false here, so this run can pick differently from live and replay (bars from the broker carry it; '
  + 'a CSV or bars built from shorter ones do not)';

module.exports = { fieldPaths, carries, missingBarFields, describeMissing };
