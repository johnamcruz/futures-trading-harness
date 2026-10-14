'use strict';

/**
 * The trade lifecycle's record (the trade-lifecycle design: its record and plan): what compose_check
 * (harness-tools/compose.js) works out from the model's checked reads (composed-reads.js) and appends, one line per
 * call, to <FTH_HOME>/trade-lifecycle/<ROOT>.jsonl. Append-only, never in the repository, never read back as a
 * verdict: the order gate (PR C) re-runs the checker on a record's reads against the cycle bar's briefing and never
 * trusts its `ok`.
 *
 * The plan, in code, never the model's arithmetic:
 *   entry    a limit at the reference price (the briefing's last close), valid until the record expires (expiresAt:
 *            the next base-bar close, the briefing's m3.validUntil)
 *   stop     the verified invalidation level with D3's buffer: one tick beyond it, on the tick (a long's below, a
 *            short's above). Stop ticks = ceil(|entry - stop| / tick). D13's floor: at least max(8 ticks, 0.25 x
 *            ATR(20) of the base bars, half the briefing's 0.5 x ATR(20) reference stop); a closer stop is refused,
 *            never widened (a wider stop would not be the level the model named)
 *   target   the verified level, floored toward the entry on the tick
 *   R:R      target ticks over stop ticks, at least the strategy's risk.min_rr
 *   size     the model's stated size (contracts, from the sizing skills); its dollar risk at most the strategy's
 *            risk.max_risk_usd (required); maxSize the most that cap allows
 *   inTheWay the first level between the entry and the target (m3.nearestLiquidity) and its R
 *
 *   recordFile(home, root)                       the record file of a root's family (MNQ and NQ share one)
 *   planOf({ checked, briefing, side, size, tick, tickValue, minRR, maxRiskUsd })   { plan, problems }
 *   stopFloorTicks(briefing, tick)               D13's floor in ticks, or null when ATR(20) is unknown
 *   buildRecord({ ... })                         the record (schema: RECORD_KEYS)
 *   appendRecord(home, record) / readRecords(home, root)
 *   renderRecord(record)                         the record as text, for the model
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { familyRoot } = require('./contracts');
const { renderCheck } = require('./composed-reads');

const STRATEGY = 'trade_lifecycle';
const SCHEMA = 1;
const STOP_BUFFER_TICKS = 1; // D3
const FLOOR_TICKS = 8; // D13
const FLOOR_ATR = 0.25; // D13: 0.25 x ATR(20)
const MAX_SIZE = 100;
// lane: the bars the reads were checked on (the briefing's base timeframe); contract: the briefing's contract;
// exploratory: false until practice exploration (the learning loop's) is built.
const RECORD_KEYS = ['schema', 'id', 'at', 'strategy', 'root', 'symbol', 'contract', 'lane', 'side', 'bar', 'expiresAt', 'cycleId', 'exploratory', 'ok', 'problems', 'reads', 'signature', 'skillSignature', 'context', 'plan'];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round2 = x => Math.round(x * 100) / 100;

const recordFile = (home, root) => path.join(home, 'trade-lifecycle', `${familyRoot(root)}.jsonl`);

/** Prices on the tick: k ticks, as the tick's own decimals hold it. */
function ticker(tick) {
  const decimals = Math.max(0, (String(tick).split('.')[1] || '').length);
  const at = k => Number((k * tick).toFixed(decimals));
  return { at, down: x => at(Math.floor(x / tick + 1e-9)), up: x => at(Math.ceil(x / tick - 1e-9)) };
}

/** D13's floor in ticks: max(8, 0.25 x ATR(20)) (ATR(20) = twice the briefing's reference stop); null when unknown. */
function stopFloorTicks(b, tick) {
  const m3 = isObj(b) && isObj(b.sections) && isObj(b.sections.m3) ? b.sections.m3.data : null;
  const half = m3 && isObj(m3.referenceStop) ? num(m3.referenceStop.distance) : null;
  if (!(half > 0) || !(tick > 0)) return null;
  return Math.max(FLOOR_TICKS, Math.ceil((FLOOR_ATR * 2 * half) / tick - 1e-9));
}

/** The plan from the checked reads: { plan, problems } (plan null when it can't be worked out). */
function planOf({ checked, briefing, side, size, tick, tickValue, minRR = null, maxRiskUsd = null }) {
  const problems = [];
  if (!(tick > 0) || !(tickValue > 0)) return { plan: null, problems: ['the contract\'s tick size and value are unknown'] };
  const ref = checked ? num(checked.reference) : null;
  if (ref === null) return { plan: null, problems: ['no reference price (no bar briefing)'] };
  if (!checked.stop || !checked.target) return { plan: null, problems: ['no verified stop and target read'] };
  const t = ticker(tick);
  const long = side === 'long';
  const stopPrice = long ? t.at(Math.floor(checked.stop.level / tick + 1e-9) - STOP_BUFFER_TICKS) : t.at(Math.ceil(checked.stop.level / tick - 1e-9) + STOP_BUFFER_TICKS);
  const stopTicks = Math.ceil(Math.abs(ref - stopPrice) / tick - 1e-9);
  const targetPrice = long ? t.down(checked.target.level) : t.up(checked.target.level);
  const targetTicks = Math.round(Math.abs(targetPrice - ref) / tick);
  if ((long ? stopPrice >= ref : stopPrice <= ref)) problems.push(`the stop ${stopPrice} is not on the losing side of the entry ${ref}`);
  if (!(targetTicks > 0) || (long ? targetPrice <= ref : targetPrice >= ref)) problems.push(`the target ${targetPrice} is not on the winning side of the entry ${ref}`);
  const floor = stopFloorTicks(briefing, tick);
  if (floor === null) problems.push('ATR(20) is unknown, so the minimum stop (D13) can\'t be checked');
  else if (stopTicks < floor) problems.push(`the stop is ${stopTicks} ticks, under the minimum ${floor} (max of ${FLOOR_TICKS} ticks and ${FLOOR_ATR} x ATR(20)): refused, never widened; name a level further away, or pass`);
  // Compared unrounded (2.996 is under a min of 3); rounded only for display.
  const rawRR = stopTicks > 0 ? targetTicks / stopTicks : null;
  const rr = rawRR === null ? null : round2(rawRR);
  if (num(minRR) !== null && !(rawRR >= minRR)) problems.push(`R:R ${rawRR === null ? 'unknown' : rawRR.toFixed(3)} is under the strategy's min ${minRR}`);
  if (!(Number.isInteger(size) && size >= 1 && size <= MAX_SIZE)) problems.push(`size: a whole number of contracts, 1 to ${MAX_SIZE}`);
  const perContract = round2(stopTicks * tickValue);
  const riskUsd = Number.isInteger(size) ? round2(perContract * size) : null;
  if (num(maxRiskUsd) === null) problems.push(`the ${STRATEGY} strategy states no risk.max_risk_usd`);
  else if (riskUsd !== null && riskUsd > maxRiskUsd) problems.push(`size ${size} risks $${riskUsd}, over the strategy's risk.max_risk_usd $${maxRiskUsd} (at most ${Math.floor(maxRiskUsd / perContract)} at this stop)`);
  const between = x => (long ? x > ref && x < targetPrice : x < ref && x > targetPrice);
  const m3 = briefing.sections.m3.data;
  const near = isObj(m3.nearestLiquidity) && Array.isArray(m3.nearestLiquidity[long ? 'above' : 'below']) ? m3.nearestLiquidity[long ? 'above' : 'below'] : [];
  const way = near.find(x => isObj(x) && num(x.price) !== null && between(x.price) && Math.abs(x.price - targetPrice) > tick + 1e-9);
  return {
    problems,
    plan: {
      entry: { type: 'limit', price: ref },
      stop: { source: checked.stop.source, level: checked.stop.level, price: stopPrice, ticks: stopTicks, bufferTicks: STOP_BUFFER_TICKS, floorTicks: floor },
      target: { source: checked.target.source, level: checked.target.level, price: targetPrice, ticks: targetTicks },
      rr, inTheWay: way ? { name: way.name, price: way.price, R: round2(Math.abs(way.price - ref) / (stopTicks * tick)) } : null,
      size: Number.isInteger(size) ? size : null, riskUsd, perContractUsd: perContract,
      maxSize: num(maxRiskUsd) !== null && perContract > 0 ? Math.floor(maxRiskUsd / perContract) : null, tick, tickValue,
    },
  };
}

/** The record (RECORD_KEYS): the checked reads and the plan, ok only when both stand. */
function buildRecord({ at, root, symbol, side, briefing = null, checked = null, planned = null, problems = [], cycleId = null }) {
  const m3 = briefing && isObj(briefing.sections) && isObj(briefing.sections.m3) ? briefing.sections.m3 : null;
  const all = [...problems, ...(checked ? checked.problems : []), ...(planned ? planned.problems : [])];
  const reads = checked ? checked.reads.map(r => ({
    step: r.step, skill: r.skill, read: r.read, why: r.why, kind: r.kind, form: r.form, field: r.field, value: r.value, check: r.check, fact: r.fact, agrees: r.agrees, ...(r.reversal ? { reversal: true } : {}),
  })) : [];
  const ok = Boolean(checked && checked.ok && planned && planned.plan && !all.length);
  const body = {
    schema: SCHEMA, at, strategy: STRATEGY, root: familyRoot(root), symbol, contract: briefing ? briefing.contractId || null : null,
    lane: briefing && Number.isInteger(briefing.minutes) ? `${briefing.minutes}m` : null, side, bar: briefing ? briefing.asOf : null,
    expiresAt: m3 ? m3.validUntil : null, cycleId, exploratory: false,
    ok, problems: all, reads, signature: checked ? checked.signature : null, skillSignature: checked ? checked.skillSignature : null,
    context: checked ? checked.context : null, plan: planned ? planned.plan : null,
  };
  const id = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return Object.fromEntries(RECORD_KEYS.map(k => [k, k === 'id' ? id : body[k]]));
}

/** Append one record (one line); the file and its folder made as needed. */
function appendRecord(home, record) {
  const file = recordFile(home, record.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** Every record of a root's family, oldest first (an unreadable line is skipped; no file, none). */
function readRecords(home, root) {
  let text;
  try { text = fs.readFileSync(recordFile(home, root), 'utf8'); } catch (_err) { return []; }
  return text.split('\n').filter(Boolean).flatMap(l => { try { const r = JSON.parse(l); return isObj(r) ? [r] : []; } catch (_err) { return []; } });
}

/** The record as text: the checked reads, the plan and what stands. */
function renderRecord(r, checked = null) {
  const out = [`compose_check ${r.root} ${r.side || '?'} on the bar at ${r.bar || 'unknown'} (record ${r.id}, expires ${r.expiresAt || 'unknown'}):`];
  if (checked) out.push(renderCheck(checked).trimEnd());
  const p = r.plan;
  if (p) {
    out.push(`Plan (code's arithmetic): entry limit ${p.entry.price}; stop ${p.stop.price} (${p.stop.source} ${p.stop.level}, ${p.stop.bufferTicks} tick beyond: ${p.stop.ticks} ticks, minimum ${p.stop.floorTicks ?? 'unknown'}); target ${p.target.price} (${p.target.source} ${p.target.level}: ${p.target.ticks} ticks); R:R ${p.rr}; first level in the way: ${p.inTheWay ? `${p.inTheWay.name} ${p.inTheWay.price} at ${p.inTheWay.R}R` : 'none found'}; size ${p.size ?? '?'} risking $${p.riskUsd ?? '?'} ($${p.perContractUsd} a contract, at most ${p.maxSize ?? '?'} by risk.max_risk_usd).`);
  }
  for (const x of r.problems.filter(x => !(checked && checked.problems.includes(x)))) out.push(`- PROBLEM: ${x}`);
  out.push(r.ok ? `OK: every read verified and the plan stands (signature ${r.signature}). A calculator and a checker, not advice: whether to trade is yours.`
    : 'NOT OK: no entry on this record. Fix each read or problem named above, or pass.');
  return `${out.join('\n')}\n`;
}

module.exports = { STRATEGY, SCHEMA, RECORD_KEYS, STOP_BUFFER_TICKS, FLOOR_TICKS, FLOOR_ATR, MAX_SIZE, recordFile, stopFloorTicks, planOf, buildRecord, appendRecord, readRecords, renderRecord };
