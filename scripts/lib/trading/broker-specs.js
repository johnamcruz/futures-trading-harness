'use strict';

/**
 * A contract's tick size and tick value, as the broker reports them. The
 * contract translator (broker/translator.js) records them in its local file
 * (<FTH_HOME>/contracts-<broker>.json, `specs`, one per root) whenever the
 * broker's server answers search_contracts or get_contract; this module only
 * reads that file, so the order gate and hooks may use it (local state, no
 * network). Live and replay trading take their specs from here; offline code
 * (backtests, training) keeps the static table in contracts.js, and a broker
 * spec that differs from it is reported (training would not equal live).
 *
 *   validSpec(c)                           { tickSize, tickValue } when both are sane numbers, else null
 *   brokerSpecFor(file, root)              the recorded spec of a root, or null
 *   brokerSpecs(file)                      root -> spec or null (none, or unlike the static table); .why(root)
 *   whyNoSpec(specOf, root)                the reason a source has none
 *   contractsFileFor(home, env)            the selected broker's file under a harness home, or null
 *   liveSpecs(env)                         the spec source of the selected broker (FTH_HOME, FTH_BROKER)
 *   noSpecsMessage(root)                   the refusal when none is recorded
 *   specMismatch(root, spec)               a message when the broker's spec differs from the static table, else null
 *   brokerOrderLimit(file)                 the server's recorded maxOrderSize (get_server_config), or null with why
 */

const { specFor } = require('./contracts');
const { harnessHome } = require('../paths');

// Sanity bounds: a reply outside them (a zero, a unit mix-up) is recorded as nothing.
const TICK_SIZE_MAX = 1e4;
const TICK_VALUE_MIN = 0.01;
const TICK_VALUE_MAX = 1e4;

const num = x => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);

/** { tickSize, tickValue } from a broker's contract (or a recorded spec) when both are sane, else null. */
function validSpec(c) {
  if (!c || typeof c !== 'object') return null;
  const tickSize = num(c.tickSize);
  const tickValue = num(c.tickValue);
  if (!(Number.isFinite(tickSize) && tickSize > 0 && tickSize <= TICK_SIZE_MAX)) return null;
  if (!(Number.isFinite(tickValue) && tickValue >= TICK_VALUE_MIN && tickValue <= TICK_VALUE_MAX)) return null;
  return { tickSize, tickValue };
}

/** The broker's recorded spec of a root (fees from the static table), or null. */
function brokerSpecFor(file, root) {
  if (!file) return null;
  const r = String(root || '').toUpperCase();
  const rec = require('../broker/translator').readCache(file).specs[r]; // lazy: the translator requires this module
  const v = validSpec(rec);
  if (!v) return null;
  const fees = (specFor(r) || {}).feesPerSide;
  return {
    ...v, ...(fees !== undefined ? { feesPerSide: fees } : {}),
    name: rec.name || null, description: rec.description || null, id: rec.id || null, readAt: rec.readAt || null, source: 'broker',
  };
}

/**
 * The spec source live code trades with: a root's recorded broker spec, or null when there is none or
 * when it differs from the static table (a broker fault, or a table that drifted: either way neither
 * number can be trusted to size a trade, so entries fail closed). source.why(root) says which.
 */
function brokerSpecs(file) {
  const source = root => {
    const spec = brokerSpecFor(file, root);
    return spec && !specMismatch(root, spec) ? spec : null;
  };
  source.why = root => {
    const spec = brokerSpecFor(file, root);
    const differs = spec && specMismatch(root, spec);
    return differs ? `${differs}; no entries on it until they agree` : noSpecsMessage(root);
  };
  return source;
}

/** Why a spec source has no spec for a root (the source's own reason, else the missing-spec message). */
const whyNoSpec = (specOf, root) => (specOf && typeof specOf.why === 'function' ? specOf.why(root) : noSpecsMessage(root));

/** The selected broker's contracts file under `home` (the env picks the broker), or null when no broker is configured. */
function contractsFileFor(home, env = process.env) {
  try {
    const { activeBroker, contractsCacheFile } = require('../broker/config');
    const at = { ...env, FTH_HOME: home }; // the home's brokers.json picks the broker, as for its translator
    return contractsCacheFile(activeBroker(at).name, at);
  } catch (_err) {
    return null; // no broker config: no specs, so entries are refused
  }
}

const liveSpecs = (env = process.env) => brokerSpecs(contractsFileFor(harnessHome(env), env));

/**
 * The server's max order size, as the translator recorded it from get_server_config in the same file:
 * { maxOrderSize, readAt } when the last answer had a whole number of 1 or more, else { maxOrderSize: null, why }.
 */
function brokerOrderLimit(file) {
  const rec = file ? require('../broker/translator').readCache(file).server : null; // lazy, as above
  const n = rec ? rec.maxOrderSize : undefined;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return { maxOrderSize: n, readAt: rec.readAt || null };
  return {
    maxOrderSize: null,
    why: rec
      ? 'the broker server\'s last get_server_config answer had no valid maxOrderSize (a whole number of contracts, 1 or more): the harness can\'t check the order size, so no entries until get_server_config reports one'
      : 'the broker server\'s max order size is not recorded yet: call get_server_config (the harness records its maxOrderSize), then try again',
  };
}

function noSpecsMessage(root) {
  const r = String(root || '').toUpperCase() || 'this contract';
  return `no tick specs from the broker for ${r} yet: call get_contract or search_contracts for ${r} first (the harness records the broker's tick size and value), then try again`;
}

const money = x => `$${Number(x).toFixed(2)}`;

/** A message when the broker's spec of a root differs from the static table (backtests, training), else null. */
function specMismatch(root, spec) {
  const r = String(root || '').toUpperCase();
  const table = specFor(r);
  const b = validSpec(spec);
  if (!table || !b) return null;
  const same = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
  if (same(b.tickSize, table.tickSize) && same(b.tickValue, table.tickValue)) return null;
  return `${r}: the broker's tick spec (${b.tickSize} = ${money(b.tickValue)}) differs from the static table backtests and training use `
    + `(${table.tickSize} = ${money(table.tickValue)}, scripts/lib/trading/contracts.js): training does not equal live; fix the table or the broker`;
}

module.exports = { TICK_SIZE_MAX, TICK_VALUE_MIN, TICK_VALUE_MAX, validSpec, brokerSpecFor, brokerSpecs, whyNoSpec, contractsFileFor, liveSpecs, noSpecsMessage, specMismatch, brokerOrderLimit };
