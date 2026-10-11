'use strict';

/**
 * Compact forms of the harness tools' larger results: what an agent reads by
 * default through the `harness` MCP server, so a reply stays small enough that
 * no harness moves it to a file the agent may not read. The scripts print the
 * full forms, unchanged; a tool returns them on request (detail, name, json).
 *
 *   scanSummary(results, { symbol, bar, specOf })   strategies_scan: the candidates first, then one line per strategy
 *   whyNot(result)                          why a scan result is not a candidate ('' when it is)
 *   recentLines(rows, { symbol })           strategies_recent: one line per bar
 *
 * strategies_list json and market_snapshot come back as JSON on one line (the
 * same content: strategies.js and market-snapshot.js, `compact`).
 *
 * A candidate's stop and target are given in points (the scan's distances are
 * prices) and in whole ticks for the symbol, rounded as an order rounds them
 * (trading/order-plan.js: a stop away from the entry, a target toward it),
 * with one contract's dollars at those ticks, so no reader takes points for
 * ticks. Tick specs come from `specOf` (root -> spec or null): the broker's
 * recorded ones (trading/broker-specs.js) for the harness tool; without one,
 * points only, and the line says to fetch the contract.
 */

const { noSpecsMessage } = require('../trading/broker-specs');
const { stopTicks, targetTicks, ticksText, distanceText, targetFor } = require('../trading/order-plan');

const num = x => (Number.isFinite(x) ? String(Math.round(x * 1e4) / 1e4) : '-');

/** The rules of one side that did not hold, by their text. */
const failedRules = rules => (Array.isArray(rules) ? rules.filter(r => r && r.ok === false).map(r => (String(r.rule).length > 100 ? `${String(r.rule).slice(0, 99)}…` : String(r.rule))) : []);

/** The first detector's own explanation (e.g. a CRT's "why"), if any. */
function detectorWhy(r) {
  const d = r && r.detail && typeof r.detail === 'object' ? Object.values(r.detail).find(x => x && typeof x.why === 'string') : null;
  return d ? d.why : '';
}

/** Why a result is not a candidate, in one line; '' for a candidate. */
function whyNot(r) {
  if (r.error) return `error: ${r.error}`;
  if (r.signal === 'policy') return r.note || 'a policy strategy';
  const reasons = [];
  if (r.signal === 'manual') {
    if (r.candidate) return 'manual: in session; evaluate its trigger from STRATEGY.md';
    reasons.push('manual');
  } else if (!r.direction) {
    const sides = ['long', 'short'].map(side => [side, failedRules(r.rules && r.rules[side])]).filter(([, f]) => f.length);
    reasons.push(sides.length ? `no rule set fired (${sides.map(([side, f]) => `${side}: ${f.join(', ')}`).join('; ')})` : 'no rule set fired');
    const why = detectorWhy(r);
    if (why) reasons.push(why);
  }
  if (r.candidate && !reasons.length) return '';
  if (r.inSession === false) reasons.push('outside its sessions');
  if (r.inRegime === false) reasons.push(`regime ${r.regime || 'unknown'} not in its regimes (${(r.regimes || []).join(', ')})`);
  if (Array.isArray(r.filtersFailed) && r.filtersFailed.length) reasons.push(`failed: ${r.filtersFailed.join('; ')}`);
  return reasons.join('; ') || 'not a candidate';
}

/** The candidate's stop and target, in points and ticks for the symbol (points only without its tick specs). */
function stopAndTarget(r, symbol, specOf) {
  const spec = symbol ? specOf(symbol) : null;
  const tick = spec ? spec.tickSize : null;
  const sTicks = spec ? stopTicks(r.stopDistance, tick) : null;
  const parts = [`stop ${Number.isFinite(r.stopDistance) && r.stopDistance > 0 ? distanceText(r.stopDistance, sTicks, symbol, spec) : 'none on this bar'}`];
  if (r.targetDistance !== undefined) {
    parts.push(`target ${Number.isFinite(r.targetDistance) && r.targetDistance > 0 ? distanceText(r.targetDistance, spec ? targetTicks(r.targetDistance, tick) : null, symbol, spec) : 'none on this bar'}`);
  } else if (sTicks && r.exit && r.exit.targetR !== null && r.exit.targetR !== undefined) {
    const t = targetFor(r.exit, sTicks, null, tick).ticks;
    if (t) parts.push(`target ${r.exit.targetR}R = ${ticksText(t, symbol, spec)}`);
  }
  if (!spec) parts.push(symbol ? noSpecsMessage(symbol) : 'no tick specs: no symbol given');
  return parts.join(', ');
}

/** One candidate, with what a plan needs from it. */
function candidateLine(r, symbol = '', specOf = () => null) {
  const x = r.exit || {};
  const exit = [
    x.targetR !== null && x.targetR !== undefined ? `target ${x.targetR}R` : '',
    x.target ? `target ${x.target}` : '',
    x.trailActivateR !== null && x.trailActivateR !== undefined ? `trail from ${x.trailActivateR}R giving back ${x.trailGivebackR ?? '-'}R` : '',
    x.maxBars ? `at most ${x.maxBars} bars` : '',
  ].filter(Boolean).join(', ');
  const c = r.confluence || { with: [], against: [] };
  const parts = [
    `${r.name} ${r.direction || '(manual: evaluate its trigger from STRATEGY.md)'}`,
    `${r.status}${r.status === 'paper' ? ' (plan only: the gate refuses a live entry)' : ''}, ${r.timeframe || '-'}, ${r.signal}${r.mtf ? `, mtf ${r.mtf.style}` : ''}`,
    // A manual strategy's side is the agent's call: which sides the trend rule leaves open (the gate enforces it).
    r.signal === 'manual' ? (r.mtf ? `trend rule: long ${r.mtf.longAllowed ? 'ok' : 'no'}, short ${r.mtf.shortAllowed ? 'ok' : 'no'}${r.mtf.reason ? ` (${r.mtf.reason})` : ''}` : 'trend rule: unknown') : `entryRef ${num(r.entryRef)}, ${stopAndTarget(r, symbol, specOf)}, minRR ${r.minRR ?? '-'}${exit ? `, exit: ${exit}` : ''}`,
    r.direction ? `with: ${c.with.join(', ') || 'none'}; against: ${c.against.join(', ') || 'none'}` : '',
    detectorWhy(r),
  ];
  return `  ${parts.filter(Boolean).join(' | ')}`;
}

/**
 * strategies_scan's compact form: the bar, the trend rule's frames, the
 * candidates (what fired) with what a plan needs, then one line per strategy:
 * name | status | timeframe | direction | candidate | why not.
 */
function scanSummary(results, { symbol = '', bar = null, specOf = () => null } = {}) {
  const list = Array.isArray(results) ? results : [];
  const fired = list.filter(r => r.candidate);
  const withMtf = list.find(r => r.mtf && r.mtf.frames);
  const withRegime = list.find(r => r.regime);
  const frames = withMtf ? Object.entries(withMtf.mtf.frames).map(([k, v]) => `${k} ${v}`).join(', ') : '';
  const lines = [
    `Scan${symbol ? ` of ${symbol}` : ''}${bar ? ` on the last closed bar (opened ${bar})` : ''}: ${list.length} strategies, ${fired.length} candidate${fired.length === 1 ? '' : 's'}.`
      + `${withRegime ? ` Regime ${withRegime.regime}.` : ''}${frames ? ` Trend ${frames}${withMtf.mtf.prevailing ? `, prevailing ${withMtf.mtf.prevailing}` : ''}.` : ''}`,
    fired.length ? 'Candidates:' : 'Candidates: none.',
    ...fired.map(r => candidateLine(r, symbol, specOf)),
    ...(fired.some(r => r.signal === 'rules') ? ['Exact order numbers (stop and target prices and ticks, size, $ risk, place_order arguments) for a strategy and side you choose: order_plan.'] : []),
    'Every strategy (name | status | timeframe | direction | candidate | why not):',
    ...list.map(r => `  ${[r.name, r.status || '-', r.timeframe || '-', r.direction || '-', r.candidate ? 'yes' : 'no', whyNot(r) || '-'].join(' | ')}`),
    'One strategy\'s full result: name; every strategy\'s (large): detail true.',
  ];
  return `${lines.join('\n')}\n`;
}

/** strategies_recent's compact form: each bar (open time, oldest first) and what fired on it. */
function recentLines(rows, { symbol = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return `${[
    `What fired${symbol ? ` on ${symbol}` : ''} on each of the last ${list.length} closed bars (bar open time, oldest first):`,
    ...list.map(r => `  ${r.bar} ${Array.isArray(r.fired) && r.fired.length ? r.fired.join(', ') : 'none'}`),
  ].join('\n')}\n`;
}

module.exports = { scanSummary, whyNot, recentLines };
