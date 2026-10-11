'use strict';

/**
 * Tick specs for common CME futures: the static table offline code uses
 * (backtests, RL training, the env server), where there is no broker. Live and
 * replay trading take tick specs from the broker (broker-specs.js); a broker
 * spec that differs from this table is reported, since training would then
 * not equal live. Silver per CME's contract specs: SI 5,000 oz and SIL (Micro
 * Silver) 1,000 oz, both $0.005/oz, so $25.00 and $5.00 a tick.
 */
const CONTRACT_SPECS = {
  MNQ: { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 },
  MES: { tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 },
  MYM: { tickSize: 1, tickValue: 0.5, feesPerSide: 0.37 },
  M2K: { tickSize: 0.1, tickValue: 0.5, feesPerSide: 0.37 },
  MGC: { tickSize: 0.1, tickValue: 1, feesPerSide: 0.37 },
  SIL: { tickSize: 0.005, tickValue: 5, feesPerSide: 0.37 },
  NQ: { tickSize: 0.25, tickValue: 5, feesPerSide: 1.4 },
  ES: { tickSize: 0.25, tickValue: 12.5, feesPerSide: 1.4 },
  YM: { tickSize: 1, tickValue: 5, feesPerSide: 1.4 },
  RTY: { tickSize: 0.1, tickValue: 5, feesPerSide: 1.4 },
  GC: { tickSize: 0.1, tickValue: 10, feesPerSide: 1.4 },
  SI: { tickSize: 0.005, tickValue: 25, feesPerSide: 1.4 },
};

/** The spec for a contract root (MNQ), or null. */
function specFor(root) {
  return CONTRACT_SPECS[String(root || '').toUpperCase()] || null;
}

/**
 * Micro and mini contracts on the same underlying (same price, same tick size;
 * the mini is worth `ratio` micros: 10, or 5 for silver). Bars are the family's; a trade picks one.
 */
const FAMILIES = [
  { micro: 'MNQ', mini: 'NQ' },
  { micro: 'MES', mini: 'ES' },
  { micro: 'MYM', mini: 'YM' },
  { micro: 'M2K', mini: 'RTY' },
  { micro: 'MGC', mini: 'GC' },
  { micro: 'SIL', mini: 'SI' }, // 1,000 oz and 5,000 oz: the "mini" is worth 5 micros
];

/** The micro/mini family of a root ({ micro, mini, ratio }), or null. */
function familyOf(root) {
  const r = String(root || '').toUpperCase();
  const f = FAMILIES.find(x => x.micro === r || x.mini === r);
  return f ? { ...f, ratio: Math.round(CONTRACT_SPECS[f.mini].tickValue / CONTRACT_SPECS[f.micro].tickValue) } : null;
}

/** One key per micro/mini family (its micro root), else the root itself: MNQ and NQ -> MNQ. */
const familyRoot = root => (familyOf(root) ? familyOf(root).micro : String(root || '').toUpperCase());

module.exports = { CONTRACT_SPECS, FAMILIES, specFor, familyOf, familyRoot };
