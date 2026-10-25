'use strict';

/**
 * Phase 2's restatement (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The entry, the second workflow"; owner-approved
 * 2026-10-24: never lose an approved setup to the reading): when risk-manager phase 2's report holds an approving
 * VERDICT line and the strict reading still refuses it (roles-ran.js approvalReadAsVeto: it reads as a veto; or it
 * approves with no size the reading can take: approvedSize's error), the runner asks phase 2 once to restate two lines,
 * `Size: <n>` and its VERDICT line (orchestrate/requests.js restate), and reads the answer with the same strict readers.
 * Nothing here loosens a reading: the answer is read by verdictOf and approvedSize, its size is bound by every size the
 * first report stated (restateCeiling: it never grows), its facts are the first report's, every item (the runner may
 * move the FACTS block last, never drop, add or edit a fact), and the record the gate reads is composed so the bound
 * and those facts are what the gate's phase2-size and phase2-facts checks read.
 *
 *   restateDue(text)   { kind: 'reads-as-veto' | 'size-unreadable', why, ceiling } | null
 *       why       what was unreadable, in the report's own words (the line that reads as a refusal, or the Size line),
 *                 never the reader's internals: what the request names
 *       ceiling   the most the restatement may approve (roles-ran.js restateCeiling: the VERDICT line's size and every
 *                 size and cut its Size lines state, the smallest); none stated: null (no restatement)
 *     null: a VERDICT line that refuses or says veto (a real veto, roles-ran.js verdictLineRefuses), no approving
 *     VERDICT line, an approval that reads fine, a report that states no size to bound it
 *   readRestatement(first, answer, ceiling, { root, symbols })
 *       { outcome: 'approved', size, line, text }   size = min(the answer's size, ceiling); `line` the VERDICT line the
 *                                                   executor and the journal get (its size the bound: rewritten when the
 *                                                   answer said more); `text` the decisive record: the answer (its FACTS
 *                                                   lines dropped), `Size: <ceiling>`, then the first report's FACTS
 *                                                   block whole (its VERDICT and Size lines out), read again by verdictOf
 *                                                   and approvedSize (it must approve exactly `size`), its fact items
 *                                                   exactly the first report's
 *       { outcome: 'vetoed', line }                 a veto in the answer is a veto (its decisive line)
 *       { outcome: 'unreadable', why }              anything else: no trade; also a first report with no single FACTS
 *                                                   line, or about another cycle symbol (`symbols`) than `root`
 */

const { verdictOf, approvalReadAsVeto, approvedSize, restateCeiling, verdictLineRefuses, decisiveLine } = require('./roles-ran');
const { factsFrom, factsLines, dropFactsLabels, checkFacts, otherSymbols } = require('./fact-claims');

// The line an approvedSize error names, in its own quotes (the error's last quoted span), else ''.
const quoted = err => { const s = String(err || ''); const a = s.indexOf('"'); const b = s.lastIndexOf('"'); return a >= 0 && b > a ? s.slice(a + 1, b) : ''; };
// A VERDICT or Size line (after markup, a bullet or a number): not a fact, wherever it sits in the FACTS block.
const VERDICT_OR_SIZE = /^[\s>#*_`|+\-•]*(?:\d+[.)][\s>#*_`|]*)?[*_`]*(?:VERDICT|Size)\b[*_`]*\s*[:=]/i;
const withoutVerdictOrSize = text => String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n').filter(l => !VERDICT_OR_SIZE.test(l.replace(/\p{Cf}/gu, ''))).join('\n').trim();

function restateDue(text) {
  if (verdictLineRefuses(text)) return null;
  const v = verdictOf(text);
  let due;
  if (v === 'VETO') {
    if (!approvalReadAsVeto(text)) return null;
    const line = decisiveLine(text);
    due = { kind: 'reads-as-veto', why: `your VERDICT line approves, but ${line ? `the line "${line}"` : 'another line'} reads as a refusal` };
  } else if (v === 'APPROVE') {
    const a = approvedSize(text);
    if (!a.error) return null;
    const line = quoted(a.error).replace(/\s+/g, ' ').trim();
    due = { kind: 'size-unreadable', why: `your size can't be read as one whole number${line ? ` (the line "${line}")` : ''}` };
  } else {
    return null;
  }
  const c = restateCeiling(text);
  return c.error ? null : { ...due, ceiling: c.size };
}

function readRestatement(first, answer, ceiling, { root = null, symbols = [] } = {}) {
  if (!(Number.isInteger(ceiling) && ceiling >= 1)) return { outcome: 'unreadable', why: 'no size bounds the restatement' };
  // The first report's facts, as the gate would read them: one FACTS line, about this order's symbol.
  if (checkFacts(first, null).labels !== 1) return { outcome: 'unreadable', why: 'the first report has no single FACTS line' };
  if (root && otherSymbols(first, root, symbols).length) return { outcome: 'unreadable', why: `the first report is about ${otherSymbols(first, root, symbols).join(', ')}, not ${root}` };
  const said = dropFactsLabels(answer);
  if (!said) return { outcome: 'unreadable', why: 'no restatement' };
  const v = verdictOf(said);
  if (v === null) return { outcome: 'unreadable', why: 'the restatement has no VERDICT line' };
  if (v === 'VETO') {
    // An approval that still reads as a veto is no answer (one restatement only); a veto is the verdict.
    if (approvalReadAsVeto(said)) return { outcome: 'unreadable', why: 'the restatement approves and still reads as a veto' };
    return { outcome: 'vetoed', line: decisiveLine(said) };
  }
  const a = approvedSize(said);
  if (a.error) return { outcome: 'unreadable', why: `the restatement states no size that can be read (${a.error})` };
  const size = Math.min(a.size, ceiling);
  const facts = withoutVerdictOrSize(factsFrom(first));
  const text = [said, `Size: ${ceiling}`, facts].join('\n');
  // The decisive record is read again as the gate reads it: one approval, exactly the bound size, the first report's facts.
  const back = verdictOf(text) === 'APPROVE' ? approvedSize(text) : { error: 'not an approval' };
  if (back.error || back.size !== size) return { outcome: 'unreadable', why: 'the restatement with the first report\'s facts is no single approval of its size' };
  if (JSON.stringify(factsLines(text)) !== JSON.stringify(factsLines(withoutVerdictOrSize(first)))) return { outcome: 'unreadable', why: 'the decisive record\'s facts are not the first report\'s' };
  const said1 = decisiveLine(said);
  const line = a.size === size ? said1 : `VERDICT: APPROVE - size ${size}, restated (it said ${a.size}; at most the ${ceiling} the first report stated)`;
  return { outcome: 'approved', size, line, text };
}

module.exports = { restateDue, readRestatement };
