'use strict';

/**
 * The data split windows, one canonical copy for everything that scores a
 * prop configuration on history: train (calibration and search), select
 * (choosing among candidates) and oos (the promotion gate,
 * prop/promotion.js). Each is [from, to): ISO dates, `to` exclusive. A
 * window changes only when the out-of-sample one is retired; out of sample
 * never overlaps train or select and never moves backward
 * (tests/lib/prop-splits.test.js).
 */

const SPLITS = Object.freeze({
  train: Object.freeze(['2021-01-01', '2023-07-01']),
  select: Object.freeze(['2023-07-01', '2024-07-01']),
  oos: Object.freeze(['2024-07-01', '2025-07-01']),
});

/** A window as ms: { from, to } (to exclusive). */
function windowMs(name) {
  const w = SPLITS[name];
  if (!w) throw new Error(`no split window "${name}" (${Object.keys(SPLITS).join(', ')})`);
  return { from: Date.parse(`${w[0]}T00:00:00Z`), to: Date.parse(`${w[1]}T00:00:00Z`) };
}

/** Whether two [from, to) windows share any time. */
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

module.exports = { SPLITS, windowMs, overlaps };
