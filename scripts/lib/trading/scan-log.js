'use strict';

/**
 * The runner's decision log: one JSON line per scanned bar, with every
 * strategy's verdict on it and why. A strategy that didn't fire says which of
 * its rules failed (or had no value yet), which filters failed, whether it was
 * in session and regime, and what its detectors saw (e.g. a CRT sweep's range,
 * extreme, and reason). Written to <FTH_HOME>/logs/scans-<day>.jsonl, so a
 * missed or unexpected trade can be traced bar by bar.
 */

const fs = require('fs');
const path = require('path');

/** One strategy's scan result, compact: what decided it. */
function summarizeResult(r) {
  const out = { name: r.name, candidate: Boolean(r.candidate) };
  if (r.direction) out.direction = r.direction;
  if (r.inSession === false) out.inSession = false;
  if (r.inRegime === false) out.inRegime = false;
  if (Array.isArray(r.filtersFailed) && r.filtersFailed.length) out.filtersFailed = r.filtersFailed;
  if (r.rules) {
    const failed = {};
    for (const side of ['long', 'short']) {
      const bad = (r.rules[side] || []).filter(x => !x.ok).map(x => (x.missing ? `${x.rule} (no value yet)` : x.rule));
      if (bad.length) failed[side] = bad;
    }
    if (Object.keys(failed).length) out.failed = failed;
  }
  if (r.stopDistance !== null && r.stopDistance !== undefined) out.stopDistance = r.stopDistance;
  if (r.targetDistance !== null && r.targetDistance !== undefined) out.targetDistance = r.targetDistance;
  if (r.detail) out.detail = r.detail;
  if (r.verdict) out.verdict = { action: r.verdict.action, maxSize: r.verdict.maxSize, contract: r.verdict.contract, reason: r.verdict.reason };
  if (r.note) out.note = r.note;
  if (r.mtf) out.mtf = { prevailing: r.mtf.prevailing, longAllowed: r.mtf.longAllowed, shortAllowed: r.mtf.shortAllowed };
  return out;
}

/** The record for one scanned bar. `decision` is the runner's { run, reason }. */
function scanRecord({ at, symbol, contractId, bar, results, decision }) {
  return {
    at: at instanceof Date ? at.toISOString() : at,
    symbol, contractId,
    bar: bar ? { t: bar.t, c: bar.c } : null,
    decision: decision ? { run: Boolean(decision.run), reason: decision.reason } : null,
    candidates: (results || []).filter(r => r.candidate).map(r => r.name),
    results: (results || []).map(summarizeResult),
  };
}

/** Append one JSON line; never throws (logging must not stop trading). Returns false on failure. */
function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { summarizeResult, scanRecord, appendJsonl };
