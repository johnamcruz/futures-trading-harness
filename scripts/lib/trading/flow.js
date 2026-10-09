'use strict';

/**
 * Order flow: 1-minute buy and sell (aggressor) volume, which the rules'
 * ofi(n) and delta(n) use instead of the bar-shape estimate. Recorded minutes
 * live in <FTH_HOME>/flow/<contractId>.csv (time,buy_volume,sell_volume); the
 * harness reads them, it doesn't record them (a broker MCP server may).
 */

const MINUTE = 60000;

/**
 * Attach buy/sell volume (bv, sv) to bars of `minutes` minutes from per-minute
 * flow. A bar gets flow only when every one of its minutes is known; a bar
 * with no volume needs none.
 */
function withFlow(bars, map, minutes) {
  return bars.map(b => {
    const start = Date.parse(b.t);
    let bv = 0;
    let sv = 0;
    for (let k = 0; k < minutes; k += 1) {
      const c = map.get(start + k * MINUTE);
      if (!c) return b;
      bv += c.bv;
      sv += c.sv;
    }
    return { ...b, bv, sv };
  });
}

/** Recorded flow as CSV (time,buy_volume,sell_volume), one row per minute. */
function flowCsv(rows) {
  return rows.map(r => `${new Date(r.t).toISOString()},${r.bv},${r.sv}\n`).join('');
}

function parseFlowCsv(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const [t, bv, sv] = line.trim().split(',');
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && Number.isFinite(Number(bv)) && Number.isFinite(Number(sv)) && bv !== '' && sv !== '') {
      out.push({ t: ms, bv: Number(bv), sv: Number(sv) });
    }
  }
  return out;
}

/** Recorded order flow on disk: <FTH_HOME>/flow/<contractId>.csv (time,buy_volume,sell_volume). */
function flowDir(home) {
  return require('path').join(home, 'flow');
}

function flowFile(home, contractId) {
  return require('path').join(flowDir(home), `${String(contractId).replace(/[^A-Za-z0-9._-]/g, '_')}.csv`);
}

/** Recorded minutes for a contract between from and to (ms), from its file. */
function readFlow(home, contractId, { from = -Infinity, to = Infinity } = {}) {
  let text;
  try {
    text = require('fs').readFileSync(flowFile(home, contractId), 'utf8');
  } catch (_err) {
    return [];
  }
  return parseFlowCsv(text).filter(r => r.t >= from && r.t < to);
}

module.exports = { withFlow, flowCsv, parseFlowCsv, flowDir, flowFile, readFlow, MINUTE };
