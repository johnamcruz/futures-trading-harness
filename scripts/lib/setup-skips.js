'use strict';

/**
 * Every listed setup composed or skipped with a reason (the owner: "I don't like skipping setups, so we need to make
 * sure we have reasons on setup skips"). The briefing's Setups-to-check line lists setups as compose reads; a cycle that
 * composes none of a listed setup says why in its final message, one line each, before its result line
 * (autonomous-trading step 6):
 *
 *   SKIP "<setup read>": <the deciding fact>
 *
 * The runner reads those lines after the cycle into its record (cycle-log.js `setupSkips`: [{ setup, reason }]). A
 * listed setup with no compose_check call on it and no SKIP line is recorded with reason null: a process miss, logged
 * (cycle-run.js), counted in the run's report, never a refusal and never a held exit. Nothing here reaches the gate.
 *
 *   parseSkips(text)                         [{ setup, reason }] from the SKIP lines (malformed ones ignored)
 *   setupSkips({ listed, composed, text })   [{ setup, reason }] for each listed setup no compose call composed: its
 *                                            stated reason, or null (composed: the cycle's compose records' reads)
 *   misses(skips)                            the listed setups skipped with no reason
 */

const LINE = /^[ \t>*-]*SKIP\s+"([^"\n]{3,120})"\s*:\s*(\S[^\n]{0,300}?)\s*$/gm;
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// A setup read without its timeframe ("15m rejected overnight low up" -> "rejected overnight low up"): a SKIP line that
// leaves the timeframe out still names the setup.
const bare = s => norm(s).replace(/^\d+[mh] /, '');

function parseSkips(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LINE)) out.push({ setup: norm(m[1]), reason: m[2].trim() });
  return out;
}

function setupSkips({ listed = [], composed = [], text = '' } = {}) {
  const done = new Set((Array.isArray(composed) ? composed : []).flatMap(c => (c && Array.isArray(c.reads) ? c.reads : []).map(r => norm(r && typeof r === 'object' ? r.read : r))));
  const said = parseSkips(text);
  return [...new Set((Array.isArray(listed) ? listed : []).map(norm).filter(Boolean))]
    .filter(s => !done.has(s))
    .map(setup => {
      const hit = said.find(x => x.setup === setup) || said.find(x => bare(x.setup) === bare(setup));
      return { setup, reason: hit ? hit.reason : null };
    });
}

const misses = skips => (Array.isArray(skips) ? skips : []).filter(s => s && s.reason === null);

module.exports = { parseSkips, setupSkips, misses };
