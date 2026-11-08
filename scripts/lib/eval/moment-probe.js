'use strict';

/**
 * The moment probe: a skill fix is checked in minutes, not by a long replay (owner rule, 2026-11-07). Pick recorded
 * moments whose answer is known (a recorded cycle: its prompt, the outcome it should have), ask the model once under
 * the old skills (the recorded prompt) and once under the new (the prompt with the new tree's skill blocks), and
 * compare. Two sets:
 *   change  moments where the old answer was wrong and the fix should move it (`want`: the outcome it should reach)
 *   hold    moments where the old answer was right (an entry that banked R) and the fix must not flip it
 * It screens, a long replay confirms: a few moments cannot prove a gain. Nothing here calls a model: `ask` is injected
 * (the CLI, scripts/moment-probe.js, spawns claude with probeArgs). Only a cycle of a Claude head run that wrote its system
 * prompt file (--append-system-prompt-file in its recorded argv) can be probed; the skills embedded in that system file are
 * never swapped, so an edit to one of them is always `untestable`.
 *
 *   swapSkills(prompt, bodyOf)  -> { prompt, swapped }  each <skill name="N"> block whose bodyOf(N) differs, replaced
 *   outcomeOf(text)             -> the last `CYCLE RESULT: <outcome> - ...` outcome, or null
 *   enters(outcome)             -> planned or executed
 *   judge(moment, old, new)     -> { verdict }  fixed | unchanged | already | broke | held | unanswered (probeMoments adds untestable)
 *   summarize(rows)             -> counts by set and verdict; `ok`: nothing broke or is unanswered, something is fixed, a hold moment held
 *   probeMoments({ moments, bodyOf, ask }) -> { rows, summary }
 *   momentFromCycle(log, { id, set, want }) -> a moment from a recorded cycle log (logs/cycles/DAY/HHMMSS-trade.json)
 *   probeArgs({ prompt, system, model }) -> the argv of one ask: the tools, user settings, MCP servers and session files off
 *   treeBodyOf(root)            -> bodyOf(name): the body of root's skills/<name>/SKILL.md, or null
 *   PROBE_SUFFIX                the one instruction ending both arms' prompts: the tools are off, so the decision is a line
 */

const fs = require('fs');
const path = require('path');
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
  // Only a line that starts with the label is the answer: a model quoting the label mid-line is not deciding.
  const found = String(text || '').split('\n').map(l => /^[\s*_`>-]*CYCLE RESULT:[*_` \t]*([a-z-]+)/.exec(l)).filter(Boolean);
  return found.length ? found.at(-1)[1] : null;
}

const enters = outcome => outcome === 'planned' || outcome === 'executed';
const norm = o => (enters(o) ? 'planned' : o);

/** The outcome more than half of ALL the asks gave (planned and executed are one); a failed ask counts against it, so null otherwise. */
function majorityOutcome(outcomes) {
  const n = {};
  for (const o of outcomes) if (o) n[norm(o)] = (n[norm(o)] || 0) + 1;
  const [top] = Object.entries(n).sort((a, b) => b[1] - a[1]);
  return top && top[1] > outcomes.length - top[1] ? top[0] : null;
}

/** One moment's verdict. A "hold" moment compares entering (planned vs executed is no flip); a "change" moment, the outcome. */
function judge(moment, before, after) {
  if (before === null || after === null) return { verdict: 'unanswered' };
  // A hold moment is an entry that banked R: one the model does not enter before the fix tests nothing.
  if (moment.set === 'hold') return enters(before) ? { verdict: enters(after) ? 'held' : 'broke' } : { verdict: 'uncalibrated' };
  const same = (a, b) => norm(a) === norm(b);
  if (same(after, moment.want)) return { verdict: same(before, moment.want) ? 'already' : 'fixed' };
  return { verdict: same(before, moment.want) ? 'broke' : 'unchanged' };
}

function summarize(rows) {
  const count = (set, v) => rows.filter(r => r.set === set && r.verdict === v).length;
  const change = { total: rows.filter(r => r.set === 'change').length };
  const hold = { total: rows.filter(r => r.set === 'hold').length };
  for (const v of ['fixed', 'unchanged', 'already', 'broke', 'unanswered', 'untestable', 'uncalibrated']) change[v] = count('change', v);
  for (const v of ['held', 'broke', 'unanswered', 'untestable', 'uncalibrated']) hold[v] = count('hold', v);
  const ok = rows.length > 0 && hold.held > 0 && change.broke === 0 && change.unanswered === 0 && hold.broke === 0 && hold.unanswered === 0 && change.fixed > 0;
  return { change, hold, ok };
}

async function probeMoments({ moments, bodyOf, ask, k = 1 }) {
  const ids = moments.map(m => String(m.id));
  if (new Set(ids).size !== ids.length) throw new Error('moments: duplicate id (each moment needs its own)');
  const rows = [];
  for (const m of moments) {
    const { prompt: next, swapped } = swapSkills(m.prompt, bodyOf);
    // The fix cannot reach a prompt that holds none of the changed skills: reported, never asked, never a pass.
    if (!swapped.length) { rows.push({ id: m.id, set: m.set, want: m.want, before: null, after: null, swapped, verdict: 'untestable' }); continue; }
    const errors = [];
    const answers = (prompt, arm) => Promise.all(Array.from({ length: k }, async () => {
      try { return outcomeOf((await ask(prompt, { id: m.id, arm })).text); } catch (e) { errors.push(String(e && e.message).split('\n')[0]); return null; }
    }));
    const row = (before, after, rest) => ({ id: m.id, set: m.set, want: m.want, before, after, swapped, ...(errors.length ? { errors: [...new Set(errors)] } : {}), ...rest });
    const before = majorityOutcome(await answers(m.prompt, 'old'));
    // Calibration: the tool-less model must reproduce what the real cycle did, or its verdict here means nothing.
    // No answer at all (every ask failed, or a tie) is no calibration: unanswered, never a quiet pass.
    if (m.recorded && before === null) { rows.push(row(before, null, { verdict: 'unanswered' })); continue; }
    if (m.recorded && before !== norm(m.recorded)) { rows.push(row(before, null, { verdict: 'uncalibrated' })); continue; }
    const after = majorityOutcome(await answers(next, 'new'));
    rows.push(row(before, after, judge(m, before, after)));
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
  const recorded = outcomeOf(log.result) ? norm(outcomeOf(log.result)) : null;
  if (!recorded) throw new Error(`moment ${id}: the cycle log holds no recorded CYCLE RESULT outcome to calibrate against`);
  if (set === 'hold' && !enters(recorded)) throw new Error(`moment ${id}: a hold moment is an entry that banked R, and this cycle recorded ${recorded}: the recorded cycle entered nothing`);
  return { id, set, want, prompt: log.prompt + PROBE_SUFFIX, system, model: at('--model'), recorded };
}

/** The argv of one ask: no tools, no user settings, no MCP servers, no session file (the context quiz's own flags). */
function probeArgs({ prompt, system, model }) {
  return ['-p', prompt, ...(model ? ['--model', model] : []), '--append-system-prompt-file', system, '--permission-mode', 'dontAsk',
    '--output-format', 'text', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];
}

function treeBodyOf(root) {
  return name => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name))) return null;
    const file = path.join(root, 'skills', name, 'SKILL.md');
    return fs.existsSync(file) ? parseFrontmatter(fs.readFileSync(file, 'utf8')).body.trim() : null;
  };
}

module.exports = { swapSkills, outcomeOf, enters, majorityOutcome, judge, summarize, probeMoments, momentFromCycle, treeBodyOf, probeArgs, PROBE_SUFFIX };
