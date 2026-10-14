'use strict';

/**
 * The training loop's archive (docs/LEARNED-RULEBOOK.md R27, R28): every proposal the loop judged, kept or
 * not, with what it changed, the panel and windows it was judged on, the seeds and repeats, the champion's
 * commit, both sides' metrics, the paired tests and the verdict, so any result can be reproduced and no
 * proposal is ever retried blind. Append-only JSON lines (<loop dir>/archive.jsonl); an entry is never
 * rewritten.
 *
 *   appendEntry(file, entry)            one line; refuses an entry without proposalId, iteration and verdict
 *   readArchive(file)                   [entry]
 *   judgedBefore(entries, proposalId)   the earlier entry for the same change (judged on tuning), or null
 *   leaders(entries)                    a small, diverse set of kept changes: the best per targeted category
 *   prBody(entry, { loopId })           the pull request description draft for a kept change (never sent)
 */

const fs = require('fs');
const path = require('path');

const VERSION = 1;

function appendEntry(file, entry) {
  if (!entry || typeof entry.proposalId !== 'string' || !Number.isInteger(entry.iteration) || typeof entry.verdict !== 'string') {
    throw new Error('an archive entry names its proposalId, iteration and verdict');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ v: VERSION, ...entry })}\n`);
}

function readArchive(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter(l => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`${file}: line ${i + 1} is unreadable; the archive is append-only, fix it by hand`, { cause: err });
    }
  });
}

const judgedBefore = (entries, id) => entries.find(e => e.proposalId === id && e.phase !== 'held-out') || null;

/** The kept change with the largest effect per targeted category (ties: the earlier one). */
function leaders(entries) {
  const best = {};
  for (const e of entries.filter(x => x.verdict === 'kept' && x.tests && x.tests.target)) {
    for (const t of (e.proposal && e.proposal.targets) || []) {
      if (!best[t] || e.tests.target.effect > best[t].tests.target.effect) best[t] = e;
    }
  }
  return Object.entries(best).map(([category, e]) => ({ category, proposalId: e.proposalId, iteration: e.iteration, effect: e.tests.target.effect }));
}

const fence = s => String(s).replace(/```/g, "'''");

function prBody(entry, { loopId }) {
  const p = entry.proposal;
  const t = entry.tests;
  const harm = Object.entries(t.harm).map(([k, x]) => `| ${k} | ${x.b} | ${x.c} | ${x.pWorse} |`);
  return [
    `## Training loop: ${p.targets.join(', ')} (${entry.proposalId})`, '',
    `Proposed by the training loop \`${loopId}\`, iteration ${entry.iteration}, and judged by code (the paired re-run), not by the model that proposed it.`, '',
    `**Expects:** ${p.expects}`, '',
    p.why ? `**Why (the proposer's reading of the flagged decisions):** ${p.why}\n` : null,
    '### Edits', '',
    ...p.edits.flatMap(e => [`- \`${e.file}\``, '', '```text', `- ${fence(e.find)}`, `+ ${fence(e.replace)}`, '```', '']),
    `Generated adapters regenerated with \`node scripts/sync-harness.js\`: ${entry.files.filter(f => !p.edits.some(e => e.file === f)).length} file(s).`, '',
    '### Paired re-run on tuning windows', '',
    `- Champion commit: \`${entry.baseCommit || 'working tree'}\`; windows: ${entry.windows.map(w => `${w.from}..${w.to}`).join(', ')}`,
    `- Panel: ${entry.panel.flagged} flagged and ${entry.panel.control} control decision times, ${entry.repeats} repeat(s), seed ${entry.seed}`,
    `- Pairs: ${t.pairs}; targeted measure: fixed ${t.target.b}, broke ${t.target.c}, effect ${t.target.effect}, p ${t.target.pBetter}`,
    `- Blows on the candidate's side: ${t.blows}`, '',
    '| category | fixed | broken | p (worse) |', '| --- | ---: | ---: | ---: |', ...harm, '',
    `Verdict: **${entry.verdict}**: ${entry.reasons.join('; ')}`, '',
    `Evaluator (step 9): ${entry.evaluator && entry.evaluator.available ? 'run' : `not run (${(entry.evaluator && entry.evaluator.why) || 'unavailable'})`}.`,
    'Held-out judging: not done. It is a separate step that spends the look budget (`train-loop.js judge --held-out-look`).', '',
    '### Before merging', '',
    '- [ ] `npm run verify` passes (run it after the loop and any replay have stopped)',
    '- [ ] Adversarial review of the whole diff (CLAUDE.md, "Before a pull request")',
    '- [ ] The owner approves the change (R25)', '',
  ].filter(x => x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { VERSION, appendEntry, readArchive, judgedBefore, leaders, prBody };
