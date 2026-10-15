'use strict';

/**
 * Tick specs for common CME futures: the static table offline code uses
 * (backtests, the prop simulator), where there is no broker. Live and
 * replay trading take tick specs from the broker (broker-specs.js); a broker
 * spec that differs from this table is reported, since training would then
 * not equal live. Silver per CME's contract specs: SI 5,000 oz and SIL (Micro
 * Silver) 1,000 oz, both $0.005/oz, so $25.00 and $5.00 a tick. No fee: a fee is the
 * account's (ACCOUNT.md fees_per_side, accounts.js feePerSide), never the table's.
 */
const CONTRACT_SPECS = {
  MNQ: { tickSize: 0.25, tickValue: 0.5 },
  MES: { tickSize: 0.25, tickValue: 1.25 },
  MYM: { tickSize: 1, tickValue: 0.5 },
  M2K: { tickSize: 0.1, tickValue: 0.5 },
  MGC: { tickSize: 0.1, tickValue: 1 },
  SIL: { tickSize: 0.005, tickValue: 5 },
  NQ: { tickSize: 0.25, tickValue: 5 },
  ES: { tickSize: 0.25, tickValue: 12.5 },
  YM: { tickSize: 1, tickValue: 5 },
  RTY: { tickSize: 0.1, tickValue: 5 },
  GC: { tickSize: 0.1, tickValue: 10 },
  SI: { tickSize: 0.005, tickValue: 25 },
};

/** The spec for a contract root (MNQ), or null. */
function specFor(root) {
  return CONTRACT_SPECS[String(root || '').toUpperCase()] || null;
}

/** The tick size of a symbol by its standard name (MNQ, MNQ:2026-03), or null for a root the table doesn't list. */
function tickOf(symbol) {
  const spec = specFor(String(symbol || '').split(':')[0]);
  return spec ? spec.tickSize : null;
}

/**
 * A price on the tick grid (the nearest tick), so a level the model reads is a
 * price it can trade (a profile row's center, 27246.54, is 27246.5 on a 0.25
 * tick). Null for a non-number; the value unchanged without a tick.
 */
function onTick(x, tick) {
  if (!Number.isFinite(x)) return null;
  if (!(tick > 0)) return x;
  const places = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(x / tick) * tick).toFixed(places));
}

/**
 * A computed level (a volume profile's POC, value area or node) as the model is shown it: rounded first at a
 * precision finer than the tick (the cent, as the snapshot computes levels, for a tick of a cent or more; a tenth of
 * the tick's last decimal for a finer tick, so 31.2551 on a 0.005 tick is 31.255), then onto the tick. One rule
 * wherever a level is shown (the briefing, market_snapshot, the prompt's day line), so a level never shows two prices.
 */
function levelOnTick(x, tick) {
  if (!Number.isFinite(x)) return null;
  if (!(tick > 0)) return x;
  const places = tick >= 0.01 ? 2 : (String(tick).split('.')[1] || '').length + 1;
  return onTick(Math.round(x * 10 ** places) / 10 ** places, tick);
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

/**
 * The contracts the user selected to trade: FTH_SYMBOLS, comma-separated roots
 * (the autonomous runner sets it from its config's symbols for the harness it
 * launches). One leg per micro/mini family: selecting MNQ means MNQ, never NQ.
 * Returns { symbols } (null when unset: unknown) or { error }. `required` (an
 * autonomous run, whose runner always sets it): unset is an error, not unknown.
 */
function parseSelection(value, { required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return required ? { error: 'FTH_SYMBOLS is not set in this autonomous run, so the selected contracts are unknown. The runner sets it from its symbols; the likely cause is a harness config installed before it was forwarded, which the user fixes by re-running node scripts/install.js --target <harness> (e.g. codex)' } : { symbols: null };
  }
  const list = String(value).split(',').map(x => x.trim().toUpperCase());
  if (!list.every(x => /^[A-Z0-9]+$/.test(x))) return { error: `FTH_SYMBOLS is not a comma-separated list of contract roots (got ${JSON.stringify(String(value))})` };
  const fams = list.map(familyRoot);
  if (new Set(fams).size !== fams.length) return { error: `FTH_SYMBOLS selects two contracts of one index (${list.join(', ')}): select one per index, e.g. MNQ or NQ` };
  return { symbols: list };
}

/** The selection in `env`: FTH_SYMBOLS, required in an autonomous run (FTH_AUTONOMOUS=1). */
const selectionOf = (env = process.env) => parseSelection(env.FTH_SYMBOLS, { required: env.FTH_AUTONOMOUS === '1' });

/** The selected symbols from the environment (null: none selected); an invalid or missing-but-required FTH_SYMBOLS throws. */
function selectedSymbols(env = process.env) {
  const sel = selectionOf(env);
  if (sel.error) throw new Error(sel.error);
  return sel.symbols;
}

/** The leg of `root`'s micro/mini family among `symbols` (NQ for MNQ when NQ is selected), else null. */
function selectedLeg(root, symbols) {
  const f = familyOf(root);
  if (!f || !Array.isArray(symbols)) return null;
  return symbols.find(x => x === f.micro || x === f.mini) || null;
}

module.exports = { CONTRACT_SPECS, FAMILIES, specFor, tickOf, onTick, levelOnTick, familyOf, familyRoot, parseSelection, selectionOf, selectedSymbols, selectedLeg };
