'use strict';

/**
 * Phase 2's restatement (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The entry, the second workflow"; owner-approved
 * 2026-10-24: never lose an approved setup to the reading): when risk-manager phase 2's report holds an approving
 * VERDICT line and the strict reading still refuses it (roles-ran.js approvalReadAsVeto: it reads as a veto; or it
 * approves with no size the reading can take: approvedSize's error), the runner asks phase 2 once to restate two lines,
 * `Size: <n>` and its VERDICT line (orchestrate/requests.js restate), and reads the answer with the same strict readers.
 * Nothing here loosens a reading: the answer is read by verdictOf and approvedSize, its size is bound by the first
 * report's own VERDICT line (verdictSize: it never grows), and the record the gate reads is composed so that bound is
 * what the gate's phase2-size check reads too.
 *
 *   restateDue(text)   { kind: 'reads-as-veto' | 'size-unreadable', why, ceiling } | null
 *       why       what was unreadable, in the report's own words (the line that reads as a refusal, or the Size line),
 *                 never the reader's internals: what the request names
 *       ceiling   the first report's approving VERDICT line size (verdictSize); none readable: null (no restatement:
 *                 nothing bounds the answer)
 *     null: a plain veto, no approving VERDICT line, an approval that reads fine
 *   readRestatement(first, answer, ceiling)
 *       { outcome: 'approved', size, line, text }   size = min(the answer's size, ceiling); `line` its VERDICT line;
 *                                                   `text` the decisive record: the answer (its FACTS lines dropped),
 *                                                   `Size: <ceiling>`, then the first report's FACTS block, read again
 *                                                   by verdictOf and approvedSize (it must approve exactly `size`)
 *       { outcome: 'vetoed', line }                 a veto in the answer is a veto (its decisive line)
 *       { outcome: 'unreadable', why }              anything else: no trade
 */

const { verdictOf, approvalReadAsVeto, approvedSize, verdictSize, decisiveLine } = require('./roles-ran');
const { factsBlock, dropFactsLabels } = require('./fact-claims');

// The line an approvedSize error names, in its own quotes (the error's last quoted span), else ''.
const quoted = err => { const s = String(err || ''); const a = s.indexOf('"'); const b = s.lastIndexOf('"'); return a >= 0 && b > a ? s.slice(a + 1, b) : ''; };

function restateDue(text) {
  const v = verdictOf(text);
  let due = null;
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
  const c = verdictSize(text);
  return c.error ? null : { ...due, ceiling: c.size };
}

function readRestatement(first, answer, ceiling) {
  if (!(Number.isInteger(ceiling) && ceiling >= 1)) return { outcome: 'unreadable', why: 'no size bounds the restatement' };
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
  const facts = factsBlock(first);
  const text = [said, `Size: ${ceiling}`, ...(facts ? [facts] : [])].join('\n');
  // The decisive record is read again as the gate reads it: one approval, exactly the bound size.
  const back = verdictOf(text) === 'APPROVE' ? approvedSize(text) : { error: 'not an approval' };
  if (back.error || back.size !== size) return { outcome: 'unreadable', why: 'the restatement with the first report\'s facts is no single approval of its size' };
  return { outcome: 'approved', size, line: decisiveLine(text), text };
}

module.exports = { restateDue, readRestatement };
