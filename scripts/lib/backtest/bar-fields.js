'use strict';

/**
 * Broker bar fields a backtest's bars don't carry, or carry on only some bars. A rules strategy may
 * read a field the broker puts on its bars (`field("a.b")` in its rules, stop or target); a CSV, or
 * bars the backtester builds from shorter ones, carries none, and the broker's own bars may carry it
 * on only part of a span (a null past the data it has for the field), so every condition on it is
 * false there. Such a run can pick differently from live and replay: the backtester says so.
 *
 *   fieldPaths(strategy)                  the dotted paths its rules, risk and exit read with field() (rules.js)
 *   carries(bar, path)                    the rules can read a value there (rules.js readField: a number or a boolean)
 *   fieldCoverage(strategies, markets, trades, { from })
 *                                         [{ strategy, path, coverage: { SYM: { bars, carried, share } }, symbols }]:
 *                                         each path a strategy reads, the share of each traded market's bars (from
 *                                         `from`, ms) that carry it, and `symbols`, the markets under 100%
 *   missingBarFields(...)                 the same, only the entries some market carries on under 100% of its bars
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
function fieldCoverage(strategies, markets, trades = () => true, { from = null } = {}) {
  const out = [];
  for (const s of strategies || []) {
    for (const p of fieldPaths(s)) {
      const coverage = {};
      for (const m of (markets || []).filter(x => trades(s, x.symbol))) {
        let n = 0;
        let carried = 0;
        for (const b of m.bars || []) {
          if (from !== null && Date.parse(b.t) < from) continue;
          n += 1;
          if (carries(b, p)) carried += 1;
        }
        coverage[m.symbol] = { bars: n, carried, share: n ? Math.floor((carried / n) * 10000) / 10000 : 0 };
      }
      if (!Object.keys(coverage).length) continue;
      out.push({ strategy: s.name, path: p, coverage, symbols: Object.keys(coverage).filter(sym => coverage[sym].bars === 0 || coverage[sym].carried < coverage[sym].bars) });
    }
  }
  return out;
}

function missingBarFields(strategies, markets, trades = () => true, opts = {}) {
  return fieldCoverage(strategies, markets, trades, opts).filter(x => x.symbols.length);
}

// Floored: 100% only when every bar carries it.
const pct = share => `${Math.floor(share * 1000) / 10}%`;
function describeMissing(m) {
  const cov = m.coverage || {};
  const none = m.symbols.filter(sym => !(cov[sym] && cov[sym].carried > 0));
  const some = m.symbols.filter(sym => cov[sym] && cov[sym].carried > 0);
  const parts = [...(none.length ? [`no ${none.join(', ')} bar`] : []), ...some.map(sym => `only ${pct(cov[sym].carried / cov[sym].bars)} of the ${sym} bars (${cov[sym].carried} of ${cov[sym].bars})`)];
  return `${m.strategy} reads field("${m.path}"), which ${parts.join(' and ')} in this data carr${parts.length === 1 && none.length ? 'ies' : 'y'}: `
    + 'its conditions on it are false on the others, so this run can pick differently from live and replay (bars from the broker '
    + 'at the strategy\'s timeframe carry it, unless the span runs past the broker\'s data for it; a CSV or bars built from shorter ones do not)';
}

/** One line per path and market: the share of the bars that carry it. */
const describeCoverage = c => Object.entries(c.coverage).map(([sym, x]) => `${c.strategy} field("${c.path}") on ${sym}: ${pct(x.bars ? x.carried / x.bars : 0)} of ${x.bars} bars`).join('; ');

module.exports = { fieldPaths, carries, fieldCoverage, missingBarFields, describeMissing, describeCoverage };
