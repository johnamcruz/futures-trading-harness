'use strict';

/** Tick specs for common CME futures (overridable per symbol). */
const CONTRACT_SPECS = {
  MNQ: { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 },
  MES: { tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 },
  MYM: { tickSize: 1, tickValue: 0.5, feesPerSide: 0.37 },
  M2K: { tickSize: 0.1, tickValue: 0.5, feesPerSide: 0.37 },
  MGC: { tickSize: 0.1, tickValue: 1, feesPerSide: 0.37 },
  NQ: { tickSize: 0.25, tickValue: 5, feesPerSide: 1.4 },
  ES: { tickSize: 0.25, tickValue: 12.5, feesPerSide: 1.4 },
  YM: { tickSize: 1, tickValue: 5, feesPerSide: 1.4 },
  RTY: { tickSize: 0.1, tickValue: 5, feesPerSide: 1.4 },
  GC: { tickSize: 0.1, tickValue: 10, feesPerSide: 1.4 },
};

/** The spec for a contract root (MNQ), or null. */
function specFor(root) {
  return CONTRACT_SPECS[String(root || '').toUpperCase()] || null;
}

/**
 * Micro and mini contracts on the same index (same price, same tick size;
 * the mini is worth 10 micros). Bars are the family's; a trade picks one.
 */
const FAMILIES = [
  { micro: 'MNQ', mini: 'NQ' },
  { micro: 'MES', mini: 'ES' },
  { micro: 'MYM', mini: 'YM' },
  { micro: 'M2K', mini: 'RTY' },
  { micro: 'MGC', mini: 'GC' },
];

/**
 * Contract ids (broker MCP interface) name a few minis by another symbol
 * (CON.F.US.ENQ.Z26 is NQ, EP is ES, GCE is GC); the micros use their root.
 */
const ID_SYMBOL = { NQ: 'ENQ', ES: 'EP', GC: 'GCE' };
const ROOT_OF_ID_SYMBOL = Object.fromEntries(Object.entries(ID_SYMBOL).map(([r, s]) => [s, r]));
/** The symbol segment in a contract id for a root (NQ -> ENQ). */
const idSymbol = root => ID_SYMBOL[String(root || '').toUpperCase()] || String(root || '').toUpperCase();
/** The root for a contract id symbol segment (ENQ -> NQ). */
const rootOfIdSymbol = sym => ROOT_OF_ID_SYMBOL[String(sym || '').toUpperCase()] || String(sym || '').toUpperCase();

/** The micro/mini family of a root ({ micro, mini, ratio }), or null. */
function familyOf(root) {
  const r = String(root || '').toUpperCase();
  const f = FAMILIES.find(x => x.micro === r || x.mini === r);
  return f ? { ...f, ratio: Math.round(CONTRACT_SPECS[f.mini].tickValue / CONTRACT_SPECS[f.micro].tickValue) } : null;
}

/** One key per micro/mini family (its micro root), else the root itself: MNQ and NQ -> MNQ. */
const familyRoot = root => (familyOf(root) ? familyOf(root).micro : String(root || '').toUpperCase());

module.exports = { CONTRACT_SPECS, FAMILIES, specFor, familyOf, familyRoot, idSymbol, rootOfIdSymbol };
