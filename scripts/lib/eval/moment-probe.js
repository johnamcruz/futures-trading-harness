'use strict';

/**
 * The moment probe: a skill fix is checked in minutes, not by a long replay (owner rule, 2026-11-07). Pick recorded
 * moments whose answer is known (a recorded cycle: its prompt, the outcome it should have), ask the model once under
 * the old skills (the recorded prompt) and once under the new (the prompt with the new tree's skill blocks), and
 * compare. Two sets:
 *   change  moments where the old answer was wrong and the fix should move it (`want`: the outcome it should reach)
 *   hold    moments where the old answer was right (an entry that banked R) and the fix must not flip it
 * It screens, a long replay confirms: a few moments cannot prove a gain. Nothing here calls a model: `ask` is injected
 * (the CLI, scripts/moment-probe.js, spawns the user's runner argv).
 *
 *   swapSkills(prompt, bodyOf)  -> { prompt, swapped }  each <skill name="N"> block whose bodyOf(N) differs, replaced
 *   outcomeOf(text)             -> the last `CYCLE RESULT: <outcome> - ...` outcome, or null
 *   enters(outcome)             -> planned or executed
 *   judge(moment, old, new)     -> { verdict }  fixed | unchanged | already | broke | held | unanswered (probeMoments adds untestable)
 *   summarize(rows)             -> counts by set and verdict; `ok`: nothing broke or is unanswered, something is fixed
 *   probeMoments({ moments, bodyOf, ask }) -> { rows, summary }
 *   momentFromCycle(log, { id, set, want }) -> a moment from a recorded cycle log (logs/cycles/DAY/HHMMSS-trade.json)
 *   treeBodyOf(root)            -> bodyOf(name): the body of root's skills/<name>/SKILL.md, or null
 *   PROBE_SUFFIX                the one instruction ending both arms' prompts: the tools are off, so the decision is a line
 */

const fs = require('fs');
const path = require('path');
const { cycleResult } = require('../autotrader');
const { parseFrontmatter } = require('../frontmatter');

const BLOCK = /<skill name="([a-z0-9][a-z0-9-]{0,63})">\n([\s\S]*?)\n<\/skill>/g;

function swapSkills(prompt, bodyOf) {
  const swapped = [];
  const out = String(prompt).replace(BLOCK, (whole, name, old) => {
    const body = bodyOf(name);
    if (typeof body !== 'string' || body.trim() === old.trim()) return whole;
    swapped.push(name);
    return `<skill name="${name}">\n${body.trim()}\n</skill>`;
  });
  return { prompt: out, swapped };
}

function outcomeOf(text) {
  const line = cycleResult(String(text || ''));
  const m = line && /CYCLE RESULT:\s*([a-z-]+)/.exec(line);
  return m ? m[1] : null;
}

const enters = outcome => outcome === 'planned' || outcome === 'executed';
const norm = o => (enters(o) ? 'planned' : o);

/** The commonest outcome of several asks (planned and executed are one); null on a tie or when none answered. */
function majorityOutcome(outcomes) {
  const n = {};
  for (const o of outcomes) if (o) n[norm(o)] = (n[norm(o)] || 0) + 1;
  const ranked = Object.entries(n).sort((a, b) => b[1] - a[1]);
  return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
}

/** One moment's verdict. A "hold" moment compares entering (planned vs executed is no flip); a "change" moment, the outcome. */
function judge(moment, before, after) {
  if (before === null || after === null) return { verdict: 'unanswered' };
  if (moment.set === 'hold') return { verdict: enters(before) === enters(after) && (enters(before) || before === after) ? 'held' : 'broke' };
  const same = (a, b) => a === b || (enters(a) && enters(b));
  if (same(after, moment.want)) return { verdict: same(before, moment.want) ? 'already' : 'fixed' };
  return { verdict: same(before, moment.want) ? 'broke' : 'unchanged' };
}

function summarize(rows) {
  const count = (set, v) => rows.filter(r => r.set === set && r.verdict === v).length;
  const change = { total: rows.filter(r => r.set === 'change').length };
  const hold = { total: rows.filter(r => r.set === 'hold').length };
  for (const v of ['fixed', 'unchanged', 'already', 'broke', 'unanswered', 'untestable', 'uncalibrated']) change[v] = count('change', v);
  for (const v of ['held', 'broke', 'unanswered', 'untestable', 'uncalibrated']) hold[v] = count('hold', v);
  const ok = rows.length > 0 && change.broke === 0 && change.unanswered === 0 && hold.broke === 0 && hold.unanswered === 0 && change.fixed > 0;
  return { change, hold, ok };
}

async function probeMoments({ moments, bodyOf, ask, k = 1 }) {
  const rows = [];
  for (const m of moments) {
    const { prompt: next, swapped } = swapSkills(m.prompt, bodyOf);
    // The fix cannot reach a prompt that holds none of the changed skills: reported, never asked, never a pass.
    if (!swapped.length) { rows.push({ id: m.id, set: m.set, want: m.want, before: null, after: null, swapped, verdict: 'untestable' }); continue; }
    const answers = (prompt, arm) => Promise.all(Array.from({ length: k }, async () => {
      try { return outcomeOf((await ask(prompt, { id: m.id, arm })).text); } catch { return null; }
    }));
    const before = majorityOutcome(await answers(m.prompt, 'old'));
    // Calibration: the tool-less model must reproduce what the real cycle did, or its verdict here means nothing.
    if (m.recorded && before !== norm(m.recorded)) { rows.push({ id: m.id, set: m.set, want: m.want, before, after: null, swapped, verdict: 'uncalibrated' }); continue; }
    const after = majorityOutcome(await answers(next, 'new'));
    rows.push({ id: m.id, set: m.set, want: m.want, before, after, swapped, ...judge(m, before, after) });
  }
  return { rows, summary: summarize(rows) };
}

const SETS = ['change', 'hold'];
const WANTS = ['planned', 'executed', 'no-trade', 'managed', 'flattened', 'blocked'];
// The recorded cycle decided through compose_check; a probe has no tools, so it asks for the decision as the closing line.
const PROBE_SUFFIX = '\n\nPROBE: the harness tools are not available in this session, so compose_check cannot run. Decide from the data above alone. End with exactly one line: CYCLE RESULT: planned - <reason> if you would compose an entry on this bar now (name the side), or CYCLE RESULT: no-trade - <reason> if you would not.\n';

function momentFromCycle(log, { id, set, want }) {
  if (!SETS.includes(set)) throw new Error(`moment ${id}: set: one of ${SETS.join(', ')}`);
  if (!WANTS.includes(want)) throw new Error(`moment ${id}: want: one of ${WANTS.join(', ')}`);
  const argv = Array.isArray(log.argv) ? log.argv : [];
  const at = flag => { const i = argv.indexOf(flag); return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null; };
  const system = at('--append-system-prompt-file');
  if (!system) throw new Error(`moment ${id}: its recorded argv names no system prompt file (--append-system-prompt-file)`);
  if (typeof log.prompt !== 'string' || !log.prompt) throw new Error(`moment ${id}: the cycle log holds no prompt`);
  return { id, set, want, prompt: log.prompt + PROBE_SUFFIX, system, model: at('--model'), recorded: outcomeOf(log.result) ? norm(outcomeOf(log.result)) : null };
}

function treeBodyOf(root) {
  return name => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name))) return null;
    const file = path.join(root, 'skills', name, 'SKILL.md');
    return fs.existsSync(file) ? parseFrontmatter(fs.readFileSync(file, 'utf8')).body.trim() : null;
  };
}

module.exports = { swapSkills, outcomeOf, enters, majorityOutcome, judge, summarize, probeMoments, momentFromCycle, treeBodyOf, PROBE_SUFFIX };
