'use strict';

/**
 * The failure taxonomy of the adherence scorecard (the learned-policy design's R19 and R25), on top of the
 * scorecard's classification (scorecard.js): everything here is decided by code from recorded facts, never by a
 * model, so the improvement loop's self-review reads failures the code found and the facts it found them on.
 *
 * The categories are R25's, no others: wrong-side entry, bad size, early close (R25's "premature close"),
 * excessive abstention, wrong stated reason, risk-rule rejection. What this module adds to them:
 *   severity       high | medium | low, from the category and its evidence (SEVERITY below)
 *   session timing a false claim about the session window ("opening print until 10:00" in the opening drive,
 *                  "session closed" at 10:48): the no-entry-window claims the reason checker (trading/reasons.js)
 *                  finds false. A misread, reported inside its category (wrong stated reason, or the false
 *                  grounds of an excessive abstention), never a category of its own.
 *   field check    a strategy whose rules read broker fields (field("a.b")): its field conditions evaluated on
 *                  the values the decision line recorded for that bar (R35). An entry on a setup the scan did
 *                  not list whose recorded values fail its own side's field conditions is a definite failure:
 *                  wrong-side entry when the other side's hold, else bad size (the order says no trade). A
 *                  setup the scan listed whose values say otherwise is a recording mismatch, never the
 *                  model's failure (it decided on what the scan showed).
 *   claim checks   the reason checks a cycle recorded (fact-checked reasons, R29), when its cycle record carries
 *                  them (`reasonChecks`: [{ kind, clause, check, why }]); else "not checked". A claim the
 *                  cycle's own check found false and the stated result still makes is a wrong stated reason.
 *   data           what the record lacks: values absent (a session from before they were recorded), a values
 *                  error, an archive error or a pruned archive, no scan of the bar, no rebuilt briefing.
 *                  Counted, never filled in.
 *
 *   SEVERITY, TYPES                               the table and the R25 categories in order
 *   fieldConditions(strategy, side)               the side's conditions that read only broker fields, compiled
 *   fieldCheck({ strategy, side, values, ... })   { status, evidence } of one setup's field conditions
 *   flowOf(label, facts, byName)                  the field check of a decision: the entry's setup, or each setup listed
 *   claimChecksOf(doc, result)                    the cycle's recorded claim checks against its stated result
 *   dataOf(label, facts)                          what the record lacks
 *   severityOf(record)                            high | medium | low | null (not a failure)
 *   timingOf(reasons)                             the false session-window claims
 *   flaggedEntry(record, ctx)                     one flagged decision, for the self-review
 *   failureSummary(records)                       counts and rates per run, per day and per type
 *   flaggedMarkdown(runId, entries)               the flagged decisions as Markdown
 */

const { compileItem, evaluateRules } = require('../trading/rules');

const TYPES = ['wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection'];
// Claims that, stated falsely, would stop a valid take (a hard stop, the trend rule, the room, a counter read).
const HARD_GROUNDS = new Set(['no-entry-window', 'nothing-fired', 'trend-blocks', 'no-attempt', 'no-verdict', 'verdict-skip', 'no-room', 'counter', 'entry-block']);
/**
 * Severity per category: high puts money on the wrong side or past the size the order allows; medium misses or cuts
 * a trade the rules allowed (or a refused order); low is a wrong word with a right decision. A false hard-stop ground
 * (a window, a trend rule, an attempt) is medium even with a right decision: the same misread stops valid trades.
 */
const SEVERITY = {
  'wrong-side entry': () => 'high',
  'bad size': r => ((r.expected && r.expected.ceiling === 0) || (r.flow && r.flow.status === 'inconsistent') ? 'high' : 'medium'),
  'early close': () => 'medium',
  'excessive abstention': () => 'medium',
  'risk-rule rejection': () => 'medium',
  'wrong stated reason': r => ((r.reasons && r.reasons.claims || []).some(c => c.check === false && !c.incidental && HARD_GROUNDS.has(c.kind))
    || ((r.claimChecks || {}).kept || []).some(c => HARD_GROUNDS.has(c.kind)) ? 'medium' : 'low'),
};

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const rate = (a, b) => (b ? Number((a / b).toFixed(4)) : null);

// ---------------------------------------------------------------------------------------------
// Field conditions on the recorded values

/**
 * Whether a compiled condition or group reads broker fields only (numbers aside), and not as a cross: a cross needs
 * the bar before, which the line records only for a look-back the rule writes, so it can't be checked.
 */
function fieldOnly(c) {
  if (c.group) return c.items.every(fieldOnly);
  if (c.op.startsWith('crosses_')) return false;
  const series = [...c.left, ...c.right].flatMap(t => t.factors).filter(f => f.kind === 'series');
  return series.length > 0 && series.every(f => f.key.startsWith('field:'));
}

/** The side's rule items that read only broker fields, compiled; a strategy whose items don't compile: none. */
function fieldConditions(strategy, side) {
  const list = strategy && isObj(strategy.rules) && Array.isArray(strategy.rules[side]) ? strategy.rules[side] : [];
  const out = [];
  for (const item of list) {
    let c;
    try { c = compileItem(item); } catch (_err) { continue; }
    if (fieldOnly(c)) out.push(c);
  }
  return out;
}

/** Whether a strategy's rules read any broker field, on either side. */
const readsFields = strategy => ['long', 'short'].some(side => fieldConditions(strategy, side).length > 0
  || (strategy && isObj(strategy.rules) && Array.isArray(strategy.rules[side]) && JSON.stringify(strategy.rules[side]).includes('field(')));

// The decision bar's index in the series the recorded values fill (any index past the 500-bar look-back works).
const AT = 500;
/** A series source over recorded values ({ "a.b": v, "a.b[2]": v }): field paths only, everything else unknown. */
function valuesSource(values) {
  const series = new Map();
  for (const [k, v] of Object.entries(values || {})) {
    const m = /^(.+?)(?:\[(\d+)\])?$/.exec(k);
    const key = `field:${m[1]}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key)[AT - Number(m[2] || 0)] = num(v) === null ? NaN : v;
  }
  return key => series.get(key) || [];
}

/** Each condition's result on the values: { rule, ok, missing } (a null value: the condition is false, as the scan reads it). */
function evaluate(conds, values) {
  return evaluateRules({ long: conds, short: [] }, [], {}, { index: AT, get: valuesSource(values) }).long;
}

/**
 * One setup's field conditions on the recorded values: status
 *   none         its rules read no broker field (not a field setup)
 *   absent       the line records no values (a session from before they were recorded)
 *   error        taking them failed on that line
 *   not recorded the line has values, none for this strategy
 *   holds        every field condition of the side holds
 *   fails        one fails, or reads a null (as the scan reads it, no value is a false condition)
 * and the evidence: each condition with its result and the values it read.
 */
function fieldCheck({ strategy, side, values, valuesAbsent = false, valuesError = null }) {
  if (!strategy || !readsFields(strategy)) return { status: 'none' };
  if (valuesAbsent) return { status: 'absent' };
  if (valuesError) return { status: 'error', error: valuesError };
  const own = isObj(values) && isObj(values[strategy.name]) ? values[strategy.name] : null;
  if (!own) return { status: 'not recorded' };
  const conds = fieldConditions(strategy, side);
  if (!conds.length) return { status: 'none' };
  const results = evaluate(conds, own);
  // complete: every condition of the side reads fields alone, so "holds" means the side fired.
  const complete = conds.length === strategy.rules[side].length;
  return { status: results.every(r => r.ok) ? 'holds' : 'fails', complete, conditions: results.map(r => ({ rule: r.rule, ok: r.ok, ...(r.missing ? { missing: true } : {}) })), values: own };
}

const other = side => (side === 'long' ? 'short' : 'long');

/**
 * The field check of a scored decision: for an entry, the setup it traded (a policy by its component); for a skip,
 * each setup the scan listed. `status`: none (no field setup), absent, error, not recorded, consistent (the values
 * agree with what the scan listed and the model did), inconsistent (an entry on a setup the scan did not list whose
 * own side fails on the values; `otherSide` true when the other side's conditions all read fields and hold on them),
 * mismatch (the scan listed a setup the
 * values say fails: the recording, never the model).
 */
function flowOf(label, facts, byName) {
  const act = label.teacher ? label.teacher.action : null;
  const base = { valuesAbsent: Boolean(label.valuesAbsent), valuesError: label.valuesError || null };
  const check = (name, side) => fieldCheck({ strategy: byName.get(name), side, values: label.values, ...base });
  if (label.decision !== 'flat') return { status: 'none', setups: [] };
  if (act === 'long' || act === 'short') {
    const setup = label.teacher.setup;
    const own = facts.setups.find(s => (s.name === setup || s.component === setup) && s.direction === act) || null;
    const name = own ? own.component || own.name : setup;
    const c = check(name, act);
    if (['none', 'absent', 'error', 'not recorded'].includes(c.status)) return { status: c.status, setups: c.status === 'none' ? [] : [{ strategy: name, side: act, ...c }] };
    // Listed: the scan fired it on that side (tradeable or not: either way the model saw it fire).
    const listed = Boolean(own && own.candidate) || (facts.fired || []).includes(`${name}|${act}`);
    if (c.status === 'holds') return { status: 'consistent', setups: [{ strategy: name, side: act, listed, ...c }] };
    if (listed) return { status: 'mismatch', setups: [{ strategy: name, side: act, listed, ...c }] };
    const o = check(name, other(act));
    return { status: 'inconsistent', otherSide: o.status === 'holds' && o.complete === true, setups: [{ strategy: name, side: act, listed, ...c }, { strategy: name, side: other(act), ...o }] };
  }
  const listed = facts.setups.filter(s => s.candidate).map(s => ({ name: s.component || s.name, side: s.direction }));
  const checks = listed.map(s => ({ strategy: s.name, side: s.side, listed: true, ...check(s.name, s.side) })).filter(c => c.status !== 'none');
  if (!checks.length) return { status: 'none', setups: [] };
  for (const s of ['absent', 'error', 'not recorded']) if (checks.every(c => c.status === s)) return { status: s, setups: checks };
  return { status: checks.some(c => c.status === 'fails') ? 'mismatch' : checks.every(c => c.status === 'holds') ? 'consistent' : 'not recorded', setups: checks };
}

// ---------------------------------------------------------------------------------------------
// Claim checks the cycle recorded, the data the record lacks, severity and timing

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The reason checks a cycle recorded (R29's fact-checked reasons: the cycle record's `reasonChecks`, each
 * { kind, clause, check, why }), against the result it stated: `kept` are the ones its own check found false whose
 * clause the stated result still makes. No such record: { status: 'not checked' }.
 */
function claimChecksOf(doc, result) {
  const list = isObj(doc) && Array.isArray(doc.reasonChecks) ? doc.reasonChecks.filter(isObj) : null;
  if (!list) return { status: 'not checked' };
  const checks = list.map(c => ({ kind: c.kind || null, clause: c.clause || null, check: c.check === true || c.check === false ? c.check : 'unchecked', why: c.why || null }));
  const text = norm(result);
  const kept = checks.filter(c => c.check === false && c.clause && text.includes(norm(c.clause)));
  return { status: 'checked', checks, false: checks.filter(c => c.check === false).length, kept };
}

/** What the record lacks at a decision: the field values, the archived bar, the scan, the rebuilt briefing. */
function dataOf(label, facts) {
  return {
    values: label.valuesAbsent ? 'absent' : label.valuesError ? 'error' : isObj(label.values) ? 'recorded' : 'none',
    archive: label.archivePruned ? 'pruned' : label.archiveError ? 'error' : label.archivedBar ? 'archived' : 'none',
    scanned: Boolean(facts.scanned), rebuilt: facts.setups.some(s => !s.composed) ? Boolean(facts.rebuilt) : null,
    ...(label.valuesError ? { valuesError: label.valuesError } : {}), ...(label.archiveError ? { archiveError: label.archiveError } : {}),
  };
}

/** high | medium | low for a failure; null when the record is right or unchecked. */
function severityOf(record) {
  const f = SEVERITY[record.category];
  return f ? f(record) : null;
}

/** The false claims about the session window: the June replays' timing misreads. */
const timingOf = reasons => (reasons.claims || []).filter(c => c.kind === 'no-entry-window' && c.check === false && !c.incidental);

// ---------------------------------------------------------------------------------------------
// Flagged decisions: what the model saw, what it did, what the code found

const setupLine = s => `${s.name}${s.component ? ` (${s.component})` : ''} ${s.direction}${s.candidate ? '' : ' (not tradeable)'}${s.verdict ? `, verdict ${s.verdict.action}${s.verdict.maxSize !== null ? ` ${s.verdict.maxSize}` : ''}` : ''}`;

/** The sentence the self-review reads first: when, what was said or done, what the code found. */
function reviewText(r, timing) {
  const parts = [`At ${r.facts.et} ET on ${r.day} (${r.symbol}), you ${r.actual.action === 'long' || r.actual.action === 'short' ? `entered ${r.actual.action}${r.actual.setup ? ` on ${r.actual.setup}` : ''}${r.actual.size ? ` with ${r.actual.size}` : ''}` : r.actual.action === 'exit' ? 'closed the trade' : r.actual.action === 'none' ? 'took no trade' : `did ${r.actual.action}`}`];
  if (r.actual.result) parts.push(` and stated: "${String(r.actual.result).replace(/^\s*CYCLE RESULT:\s*/i, '').replace(/\.\s*$/, '')}"`);
  parts.push(`. The code scored it ${r.category} (${r.severity})`);
  if (r.why.length) parts.push(`: ${r.why.join('; ')}`);
  const wrong = (r.reasons.claims || []).filter(c => c.check === false && !c.incidental);
  if (wrong.length) parts.push(`. False by the facts: ${wrong.map(c => `"${c.clause}" (${c.why})`).join('; ')}`);
  if (timing.length) parts.push('. This is a session-timing misread: the window and whether it allows entries are in the briefing');
  return `${parts.join('')}.`;
}

/**
 * One flagged decision. `ctx`: { runId, decisionFile, home } (the decision line's file, relative to the run home). The
 * pointers (`saw`) lead back to the record: the decision line (file and time), the cycle record (prompt and
 * transcript), the prompt's hash, and the scan log line of the bar.
 */
function flaggedEntry(r, { runId, decisionFile, home = null }) {
  const timing = timingOf(r.reasons);
  return {
    v: 1, runId, home: home || null, key: r.key, t: r.t, day: r.day, et: r.facts.et, symbol: r.symbol, barT: r.barT,
    failure: { category: r.category, severity: r.severity, step: r.expected.decidedBy, sessionTiming: timing.length > 0 },
    saw: {
      decisionLine: { file: decisionFile, t: r.t }, cycleFile: r.provenance ? r.provenance.cycleFile : null, promptHash: r.provenance ? r.provenance.promptHash : null,
      scanLog: { file: `logs/scans-${r.day}.jsonl`, symbol: r.symbol, bar: r.barT },
      window: r.facts.window, news: r.facts.news, trendRule: r.facts.trendRule,
      setups: r.facts.setups.map(setupLine), attempt: r.facts.attempt ? { status: r.facts.attempt.status, entryBlock: r.facts.attempt.entryBlock || null } : null,
    },
    did: { action: r.actual.action, setup: r.actual.setup, size: r.actual.size, stated: r.actual.result, gate: r.actual.gate },
    found: {
      expected: { decision: r.expected.decision, setup: r.expected.setup, direction: r.expected.direction || null, ceiling: r.expected.ceiling, decidedBy: r.expected.decidedBy },
      why: r.why,
      falseClaims: (r.reasons.claims || []).filter(c => c.check === false).map(c => ({ kind: c.kind, clause: c.clause, fact: c.why, incidental: Boolean(c.incidental) })),
      sessionTiming: timing.map(c => ({ clause: c.clause, fact: c.why })),
      fields: r.flow, claimChecks: r.claimChecks,
    },
    data: r.data,
    review: reviewText(r, timing),
  };
}

// ---------------------------------------------------------------------------------------------
// Summary

const zeroTypes = () => Object.fromEntries(TYPES.map(t => [t, 0]));

/**
 * Counts and rates per run, per session day and per failure type (a rate is of the decisions scored), with
 * severities, the session-timing misreads, the field checks, the claim checks and the data the record lacks.
 */
function failureSummary(records) {
  const run = Object.fromEntries(TYPES.map(t => [t, { n: 0, rate: null, high: 0, medium: 0, low: 0 }]));
  const days = {};
  const flow = {};
  const data = { valuesAbsent: 0, valuesError: 0, valuesNone: 0, archiveError: 0, archivePruned: 0, archiveNone: 0, notScanned: 0, notRebuilt: 0 };
  let timingDecisions = 0;
  let timingClaims = 0;
  let checked = 0;
  for (const r of records) {
    const d = days[r.day] || (days[r.day] = { decisions: 0, failures: 0, types: zeroTypes(), sessionTiming: 0 });
    d.decisions += 1;
    if (run[r.category]) {
      run[r.category].n += 1;
      run[r.category][r.severity] += 1;
      d.failures += 1;
      d.types[r.category] += 1;
    }
    const timing = timingOf(r.reasons);
    if (timing.length) { timingDecisions += 1; timingClaims += timing.length; d.sessionTiming += 1; }
    if (r.flow && r.flow.status !== 'none') flow[r.flow.status] = (flow[r.flow.status] || 0) + 1;
    if (r.claimChecks && r.claimChecks.status === 'checked') checked += 1;
    const x = r.data || {};
    if (x.values === 'absent') data.valuesAbsent += 1; else if (x.values === 'error') data.valuesError += 1; else if (x.values === 'none') data.valuesNone += 1;
    if (x.archive === 'error') data.archiveError += 1; else if (x.archive === 'pruned') data.archivePruned += 1; else if (x.archive === 'none') data.archiveNone += 1;
    if (x.scanned === false) data.notScanned += 1;
    if (x.rebuilt === false) data.notRebuilt += 1;
  }
  const n = records.length;
  for (const t of TYPES) run[t].rate = rate(run[t].n, n);
  const byDay = Object.keys(days).sort().map(day => {
    const d = days[day];
    return { day, decisions: d.decisions, failures: d.failures, failureRate: rate(d.failures, d.decisions), sessionTiming: d.sessionTiming,
      types: Object.fromEntries(TYPES.map(t => [t, { n: d.types[t], rate: rate(d.types[t], d.decisions) }])) };
  });
  const failures = TYPES.reduce((a, t) => a + run[t].n, 0);
  return {
    decisions: n, failures, failureRate: rate(failures, n), types: run, days: byDay,
    severity: { high: TYPES.reduce((a, t) => a + run[t].high, 0), medium: TYPES.reduce((a, t) => a + run[t].medium, 0), low: TYPES.reduce((a, t) => a + run[t].low, 0) },
    sessionTiming: { decisions: timingDecisions, claims: timingClaims, rate: rate(timingDecisions, n) },
    fields: Object.fromEntries(Object.keys(flow).sort().map(k => [k, flow[k]])),
    claimChecks: { checked, notChecked: n - checked },
    data,
  };
}

const pct = x => (x === null || x === undefined ? '-' : `${Math.round(x * 1000) / 10}%`);
const cell = x => (x === null || x === undefined ? '-' : String(x).replace(/\|/g, '\\|').replace(/\n/g, ' '));

/** The failure sections of the scorecard's report: per type, per day, timing, field checks, data. */
function failureMarkdown(f) {
  return [
    '## Failures by type', '',
    `${f.failures} failures in ${f.decisions} decisions (${pct(f.failureRate)}): ${f.severity.high} high, ${f.severity.medium} medium, ${f.severity.low} low severity.`, '',
    '| type | count | rate | high | medium | low |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...TYPES.map(t => `| ${t} | ${f.types[t].n} | ${pct(f.types[t].rate)} | ${f.types[t].high} | ${f.types[t].medium} | ${f.types[t].low} |`), '',
    '## Failures by session day', '',
    `| day | decisions | failures | rate | ${TYPES.join(' | ')} | session timing |`, `| --- | ---: | ---: | ---: | ${TYPES.map(() => '---:').join(' | ')} | ---: |`,
    ...f.days.map(d => `| ${d.day} | ${d.decisions} | ${d.failures} | ${pct(d.failureRate)} | ${TYPES.map(t => d.types[t].n).join(' | ')} | ${d.sessionTiming} |`), '',
    '## Session timing, field checks, claim checks, data', '',
    `Session-timing misreads (a false claim about the window): ${f.sessionTiming.decisions} decisions (${pct(f.sessionTiming.rate)}), ${f.sessionTiming.claims} claims.`,
    `Field checks (setups whose rules read broker fields, on the recorded values): ${Object.entries(f.fields).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    `Claim checks recorded by the cycle: ${f.claimChecks.checked} decisions; not checked ${f.claimChecks.notChecked}.`,
    `Data the record lacks: values absent ${f.data.valuesAbsent}, values error ${f.data.valuesError}, no values ${f.data.valuesNone}; archive error ${f.data.archiveError}, pruned ${f.data.archivePruned}, no archived bar ${f.data.archiveNone}; no scan ${f.data.notScanned}, briefing not rebuilt ${f.data.notRebuilt}.`, '',
  ].join('\n');
}

/** The flagged decisions as Markdown: one section each, the review sentence first. */
function flaggedMarkdown(runId, entries) {
  const home = entries.length ? entries[0].home : null;
  const out = [`# Flagged decisions: ${runId}`, '', `${entries.length} decisions the code flagged. Each: what the model saw (pointers into the record${home ? `, relative to the run home ${home}` : ''}), what it did, what the code found.`, ''];
  for (const e of entries) {
    out.push(`## ${e.day} ${e.et} ET ${e.symbol}: ${e.failure.category} (${e.failure.severity})`, '', e.review, '',
      `- Saw: window ${e.saw.window ? `${e.saw.window.name} until ${e.saw.window.until} ET, entries ${e.saw.window.entriesAllowed ? 'allowed' : 'not allowed'}` : 'unknown'}; trend rule ${e.saw.trendRule && e.saw.trendRule.prevailing ? e.saw.trendRule.prevailing : 'none'}; setups ${e.saw.setups.join('; ') || 'none'}.`,
      `- Record: ${e.saw.decisionLine.file} at ${e.t}; cycle ${cell(e.saw.cycleFile)}; prompt ${cell(e.saw.promptHash)}; scan ${e.saw.scanLog.file} bar ${cell(e.barT)}.`,
      `- Did: ${e.did.action}${e.did.setup ? ` ${e.did.setup}` : ''}${e.did.size ? ` ${e.did.size}` : ''}${e.did.gate && e.did.gate.decision ? `; gate ${e.did.gate.decision}` : ''}.`,
      `- Expected: ${e.found.expected.decision}${e.found.expected.setup ? ` ${e.found.expected.setup}` : ''}${e.found.expected.ceiling !== null && e.found.expected.ceiling !== undefined ? `, at most ${e.found.expected.ceiling}` : ''} (${cell(e.found.expected.decidedBy)}).`,
      `- Field check: ${e.found.fields ? e.found.fields.status : 'none'}; claim checks: ${e.found.claimChecks ? e.found.claimChecks.status : 'not checked'}; values ${e.data.values}, archive ${e.data.archive}.`, '');
  }
  return out.join('\n');
}

module.exports = { TYPES, SEVERITY, HARD_GROUNDS, fieldConditions, fieldCheck, flowOf, claimChecksOf, dataOf, severityOf, timingOf, flaggedEntry, failureSummary, failureMarkdown, flaggedMarkdown };
