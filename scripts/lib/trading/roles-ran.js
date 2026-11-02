'use strict';

/**
 * Did this autonomous cycle run its roles before an entry? The trade-session
 * skill's full cycle runs the analysts (market structure, trend and momentum,
 * volume and liquidity) and risk-manager phase 1, then risk-manager phase 2 on
 * the plan; a lean cycle runs risk-manager phase 1, then phase 2. Each analyst
 * carries skills (bos-vs-choch, levels-and-reactions, vwap-volume-profile,
 * session-timing, trend-momentum-indicators, ...), and the risk-manager
 * carries position-sizing and prop-challenge-pacing, so a cycle that skips a
 * role decides without them. The gate refuses such an entry.
 *
 * The runner writes the cycle's transcript as the harness streams it
 * (FTH_CYCLE_TRANSCRIPT, a file per run) and names the cycle (FTH_CYCLE: full |
 * lean); a hook's transcript_path is read the same way, with its main
 * session's for a Claude subagent (the trade-executor places the order).
 *
 * A call counts once it returned without an error, in the foreground (a
 * background launch returns at once, before any report), in any of these
 * shapes, each with a start and an end in the transcript's own order:
 *
 *   - opencode `run --format json`: {type:'tool_use', part:{tool:'task',
 *     state:{status:'completed', input:{subagent_type}, time:{start, end}}}}
 *   - Claude stream-json and session files: message.content[] {type:'tool_use',
 *     name:'Task'|'Agent', id, input:{subagent_type}} (its line is the start),
 *     answered by {type:'tool_result', tool_use_id, is_error:false} (the end)
 *   - Qwen Code's parts: {functionCall:{id, name:'task', args:{subagent_type}}}
 *     answered by {functionResponse:{id, response:{output}}} with no error
 *
 * Only calls that started after the last trade-executor launch ended count (a
 * launch still running or in the background ends it at its start; the one
 * placing this order excepted), so each entry has its own round of reports.
 * opencode prints a call when it ends, so two trade-executors launched at once
 * both see the same round. The gateway covers the second entry. On the same
 * root (account-gate.js counts MNQ and NQ as one root), the account gate's
 * position-open (counting orders sent moments ago) and working-orders refuse
 * it, and order-gate.js's review-before-next-entry does once the first entry,
 * on that exact contract root, is journalled. On another root, prop-one-position
 * refuses it on a prop attempt (any open position, recent order, or working
 * order), and correlated-exposure refuses a same-direction equity-index entry
 * once the first position shows. Otherwise only the autonomous-trading skill's
 * one-entry rule and max-entries limit it.
 *
 * Roles the runner served from its report cache this cycle (FTH_CYCLE_CACHED, report-cache.js: an analyst's report
 * built on the briefing parts still current; phase 1 only while its live facts hold, by the runner's record the gate checks:
 * config.js cachedRoles, mcp-gateway.js) count as returned;
 * phase 2 is never cached and still starts after every analyst that ran.
 *
 * Roles the runner ran itself this cycle (its role record, FTH_CYCLE_ROLES, runner-roles.js: the desk's roles, each its
 * own harness run) are calls like the transcript's, with the run's wall-clock start and end and its report, merged in
 * before the round is judged, so every rule above applies to them unchanged: phase 1 is the first risk-manager call,
 * phase 2 one that starts after phase 1's end and every analyst's, the verdict and veto rules read its report, and a
 * recorded trade-executor run ends the round as a transcript launch does. Index mode: a recorded run counts only when
 * its recorded lookups hold the skills the bar requires of its role (skill-lookups.js unmetLookups). Only a run that
 * counted (ok) with a report is a call. No file, or one that can't be read: nothing is added (fails closed: the roles
 * it would have credited are missing). The record's times are wall-clock ms, so a transcript call or launch without
 * them can't be ordered against it: with a record, such a call refuses the entry and such a launch ends every round.
 *
 *   roleCalls(text)                              { calls: [{ role, start, end, text }] that count, launches: trade-executor launches }
 *   withRunnerRuns(found, runs)                  roleCalls' result with the runner's recorded runs merged in (runner-roles.js)
 *   cycleCalls(transcriptText, rolesFile)        roleCalls(transcriptText) with the record's runs: what the gate judges
 *   rolesInTranscript(text)                      Map role -> calls that count
 *   missingRoles(calls, cycle, cached)           what a cycle still lacks, as text, [] when complete
 *   checkRolesRan(transcriptPath, cycle, cached, lookups, rolesFile)   the gate's message, or null; `lookups`: (call) -> the
 *                                                required skills it didn't look up (skill-lookups.js lookupRule):
 *                                                such a call doesn't count; `rolesFile`: the runner's role record
 *   approvedPhase2(transcriptPath, cycle, cached, lookups, rolesFile) the phase-2 report that approves this entry, judged as
 *                                                checkRolesRan judges it: { text } | { error } | null
 *   approvalReadAsVeto(text)                     an approving VERDICT line in a report that reads as a veto: { why, line }
 *                                                | null (the runner's reporting; the gate's reading is verdictOf's)
 *   decisiveLine(text)                           the line verdictOf decided on (APPROVE: the first approving VERDICT line;
 *                                                VETO: the refusing one), trimmed, or '' (what the executor is handed)
 *   approvedSize(text)                           the size an approving report approves: { size } | { error } (fails closed)
 *   verdictSize(text)                            the size its approving VERDICT lines alone state (every size and cut on
 *                                                them binds): { size } | { error }
 *   verdictLineRefuses(text)                     a VERDICT-keyword line refuses or says veto: never restated
 *   restateCeiling(text)                         the most a restatement may approve: the VERDICT size and every Size line's
 *                                                whole size and cut, the smallest; { size } | { error } (none stated)
 *   sizeRefusal(report, size)                    the gate's phase2-size check: an entry over phase 2's approved size (or none
 *                                                readable) refuses; null when no phase 2 is required (report null)
 */

const fs = require('fs');
const { transcriptFiles } = require('./skills-loaded');
const { readRoleRuns, asRoleCalls } = require('./runner-roles');

const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
const CYCLES = ['full', 'lean'];
const TASK_TOOLS = new Set(['task', 'Task', 'Agent']);
const MAX_BYTES = require('../tunables').runner().limits.rolesRanBytes; // config/runner.json
const PHASE2 = 'risk-manager phase 2 (a second call, started after phase 1';
const EXECUTOR = 'trade-executor';
// Claude Code's answer when a subagent was launched in the background instead of run.
const LAUNCHED = /^\s*Async agent launched\b/i;
// The result's first text (an acknowledgment opens it; a report that merely mentions the words doesn't).
const resultText = c => (typeof c === 'string' ? c : Array.isArray(c) ? String((c.find(x => isObj(x) && typeof x.text === 'string') || {}).text || '') : '');

const roleOf = v => (typeof v === 'string' && v.trim() ? v.trim().split(':').pop() : null);
const isObj = v => Boolean(v) && typeof v === 'object';
const num = v => (Number.isFinite(v) ? v : null);
// A subagent's report: opencode wraps it in <task ...><task_result>...</task_result></task>; Claude's tool result is
// a string or text blocks; Qwen's response carries an output string.
const allText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => isObj(x) && typeof x.text === 'string').map(x => x.text).join('\n') : '');
// What Claude Code appends to a subagent's result, after the report: the agent's id with how to continue it, and its
// usage. Not the role's words: the report is read without them (a FACTS block would otherwise read them as facts).
const AGENT_FOOTER = /^[ \t]*agentId: \S+ \(use SendMessage\b[^\n]*$/gm;
const USAGE_BLOCK = /<usage>[^]*?<\/usage>/g;
const claudeReport = c => allText(c).replace(USAGE_BLOCK, '').replace(AGENT_FOOTER, '').replace(/\s+$/, '');
const taskResult = o => { const m = /<task_result>\n?([^]*?)\n?<\/task_result>/.exec(String(o || '')); return m ? m[1] : String(o || ''); };

/** The subagent calls that returned in the foreground without an error, with their start and end, in order. */
function roleCalls(text) {
  const calls = [];
  const launches = []; // trade-executor launches: { start, end (null while running or in the background), background, pending }
  const claude = new Map(); // tool_use id -> { role, start }
  const qwen = new Map(); // functionCall id -> { role, start }
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/subagent_type|tool_result|functionResponse/.test(line)) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!isObj(ev)) continue;
    // opencode: one event per finished call, with the call's own start and end times.
    const part = isObj(ev.part) ? ev.part : null;
    if (ev.type === 'tool_use' && part && TASK_TOOLS.has(part.tool) && isObj(part.state)) {
      const st = part.state;
      const input = isObj(st.input) ? st.input : {};
      const meta = isObj(st.metadata) ? st.metadata : {};
      const role = roleOf(input.subagent_type);
      const t = isObj(st.time) ? st.time : {};
      const background = input.background === true || meta.background === true || /<task\b[^>]*\bstate="(?!completed")/.test(String(st.output || ''));
      if (role === EXECUTOR) {
        // Every launch ends the round, whatever its state; without times it ends every round so far (fails closed).
        launches.push({ start: num(t.start) ?? Infinity, end: background ? null : (num(t.end) ?? Infinity), background });
      } else if (st.status === 'completed' && !background) {
        calls.push({ role, start: num(t.start) ?? i, end: num(t.end) ?? i, text: taskResult(st.output) });
      }
    }
    const msg = isObj(ev.message) ? ev.message : {};
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use' && TASK_TOOLS.has(c.name) && typeof c.id === 'string' && isObj(c.input)) {
        claude.set(c.id, { role: roleOf(c.input.subagent_type), start: i, background: c.input.run_in_background === true });
      }
      if (c.type === 'tool_result' && claude.has(c.tool_use_id)) {
        const call = claude.get(c.tool_use_id);
        // A launch acknowledgment (a subagent run in the background, by request or by default) is not a report.
        const ack = call.background || LAUNCHED.test(resultText(c.content));
        if (call.role === EXECUTOR) launches.push({ start: call.start, end: ack ? null : i, background: ack });
        else if (c.is_error !== true && !ack) calls.push({ role: call.role, start: call.start, end: i, text: claudeReport(c.content) });
        claude.delete(c.tool_use_id);
      }
    }
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      const fc = isObj(p) ? p.functionCall : null;
      const fr = isObj(p) ? p.functionResponse : null;
      if (msg.role === 'model' && isObj(fc) && TASK_TOOLS.has(fc.name) && typeof fc.id === 'string' && isObj(fc.args)) {
        qwen.set(fc.id, { role: roleOf(fc.args.subagent_type), start: i, background: fc.args.run_in_background === true });
      }
      if (msg.role === 'user' && isObj(fr) && qwen.has(fr.id)) {
        const call = qwen.get(fr.id);
        const r = fr.response;
        if (call.role === EXECUTOR) launches.push({ start: call.start, end: call.background ? null : i, background: call.background });
        else if (!call.background && isObj(r) && !Object.prototype.hasOwnProperty.call(r, 'error')) calls.push({ role: call.role, start: call.start, end: i, text: typeof r.output === 'string' ? r.output : '' });
        qwen.delete(fr.id);
      }
    }
  }
  for (const m of [claude, qwen]) {
    for (const c of m.values()) if (c.role === EXECUTOR) launches.push({ start: c.start, end: null, background: c.background, pending: !c.background });
  }
  return { calls: calls.filter(c => c.role), launches };
}

/** Wall-clock times (ms), as opencode's transcript and the runner's record carry them; not line positions. */
// skill-lookups.js's own test of a call's times (one definition), required where used: it requires this module's peers.
const wallClock = v => require('./skill-lookups').timed({ start: v, end: v });
const UNORDERED = 'a role call in the transcript without wall-clock times (it can\'t be ordered against the runner\'s role record)';

/**
 * roleCalls' result with the runner's recorded runs (runner-roles.js readRoleRuns) merged in: their ok reports as calls,
 * their trade-executor runs as launches. With none, `found` as it is. With some, a transcript launch timed by line
 * position ends every round (start and end Infinity; the one placing this order excepted), and a transcript call so
 * timed is `unordered` (assessRound refuses: fails closed).
 */
function withRunnerRuns(found, runs) {
  const rec = asRoleCalls(runs);
  if (!rec.calls.length && !rec.launches.length) return found;
  const launches = found.launches.map(l => (l.pending || wallClock(l.start) || l.start === Infinity ? l : { ...l, start: Infinity, end: l.end === null ? null : Infinity }));
  const unordered = found.calls.filter(c => !(wallClock(c.start) && wallClock(c.end))).length;
  return { calls: [...found.calls, ...rec.calls], launches: [...launches, ...rec.launches], unordered };
}

/** What the gate judges: the transcript's calls with the runner's role record (no file, or unreadable: none added). */
const cycleCalls = (text, rolesFile = null) => withRunnerRuns(roleCalls(text), readRoleRuns(rolesFile));

function rolesInTranscript(text) {
  const counts = new Map();
  for (const c of roleCalls(text).calls) counts.set(c.role, (counts.get(c.role) || 0) + 1);
  return counts;
}

/**
 * Phase 2's answer: the latest phase-2 report (the last to return) must say `VERDICT: APPROVE` (agents/risk-manager.md);
 * a VETO, or no verdict line, is not an approval (fails closed).
 */
const NOT_APPROVED = 'risk-manager phase 2 approving the plan (its latest verdict is not "VERDICT: APPROVE")';
// Decision lines, the one definition the approval (verdictOf) and the gate (verdictProblem) both use. A line is read
// plain: format characters dropped (markup, quotes and emoji are separators like any other). The word "verdict" or
// "decision" decides where it STARTS its line: only list markers, numbering, quote marks, markup, emoji, spaces and the
// labels plan, step, final, phase, risk and overall before it ("VERDICT:", "**Verdict:**", "- Decision:", "8 Decision:",
// "PLAN 8 Decision:", "**Step 8, decision:**", "Phase 2 VERDICT:"). Anywhere else on a line it never approves, and it
// refuses only when it states a refusal: a label separator after it (up to three words between: ':', '=', '|', an
// arrow, an ellipsis, a dash; "Sizing verdict: skip", "My decision here: skip") and the decision after that separator
// not approve/take, or with none, a refusal word or a number right after it ("Room is short; decision pass"), or at the
// line's end a refusal starting the next line (proseRefusal). Other prose ("the verdict's size", "the verdict ceiling",
// "a decision on ...") decides nothing. Owner-approved 2026-10-24 (a replay's approvals read as vetoes by prose naming
// the verdict). A decision occurrence: after it, qualifier tokens (final, phase, risk, overall, a
// number) and anything in (), [] or \u00ab\u00bb are skipped, then the first token after any separators (':', '-', '|', '/', '=',
// arrows, ellipses, spaces) is the decision. "is", "was", "to", "says" or "said" right after the word is prose: that
// occurrence isn't read (the veto rule still reads its line). Nothing after it: the
// next non-empty line's first token (a heading), unless that line holds the word itself. Only brackets after it: the
// bracketed token is the decision; only numbers: the number is (no letters, so it refuses). The order's own setup,
// side and size are what the gate checks, so several APPROVE lines are one approval, whatever else they say.
//   - any decision that isn't approve, approved, full (the prop verdict's action) or take (the trader-process "8
//     Decision: take") refuses; an approval is a verdict that says approve, approved or full;
//   - VETO (vetoed, vetoes) in capitals anywhere, or any case on a decision line, refuses ("a read, never a veto" doesn't).
// A markdown heading line (up to 3 spaces, 1 to 6 '#', a space) never approves: "## Phase 2: Plan verdict, MNQ short"
// decides nothing. It still refuses when its first word after the keyword is a refusal or a number ("## Decision: skip",
// "# Verdict" then "PASS"), and the veto rules read every line, headings too ("## VETO", "## Phase 2 verdict: veto").
// `full` is the prop verdict's own approving action (`skip` its other), so a model copying "verdict full" agrees.
const AGREE = new Set(['approve', 'approved', 'full', 'take']);
const APPROVE_WORDS = new Set(['approve', 'approved', 'full']);
const KEYWORD_ALL = /\b(verdict|decision)\b/gi;
// The keyword that starts its line: nothing but non-letters (markers, numbering, quotes, markup, emoji, spaces) and the
// labels before it. The index of that keyword, or -1.
const LINE_START = /^(?:[^\p{L}]|\b(?:plan|step|final|phase|risk|overall)\b)*?\b(?:verdict|decision)\b/iu;
const startIndex = l => { const m = LINE_START.exec(l); return m ? m[0].length - /(?:verdict|decision)$/i.exec(m[0])[0].length : -1; };
// A label separator after a keyword elsewhere on the line: markup, spaces, one bracket and up to three short words
// between ("My decision here: skip", "The decision for this cycle: stand aside"), then ':', '=', '|', an arrow, an
// ellipsis or a dash (a hyphen only spaced: "decision-making" is a word). The match ends at the separator.
const LABEL = /^(?:[\s*_]*(?:\([^)\n]*\)|\[[^\]\n]*\]))?(?:[\s*_]+[A-Za-z]{1,12}){0,3}?[\s*_]*(?:[:=|\u2192\u21d2\u2026\u2013\u2014]|->|\.{3}|-(?=\s))/;
const QUALIFIERS = new Set(['final', 'phase', 'risk', 'overall']);
const PROSE = new Set(['is', 'was', 'to', 'says', 'said']);
const BRACKETS = { '(': ')', '[': ']', '\u00ab': '\u00bb' };
const VETO_WORD = /\bveto(?:ed|es)?\b/i;
const VETO_CAPS = /\bVETO(?:ED|ES)?\b/;
const HEADING = /^\s{0,3}#{1,6}\s/;
// The refusals a heading still states ("## Decision: skip", "# Verdict: BLOCKED", "## Decision: 0 contracts"): its
// first word after the keyword, one of these or a number. Any other word ("## Phase 2: Plan verdict, MNQ short") is no
// decision, and a heading never approves.
const REFUSALS = new Set(['pass', 'passed', 'passing', 'reject', 'rejected', 'rejection', 'skip', 'skipped', 'wait', 'waiting', 'hold', 'holding', 'held',
  'defer', 'deferred', 'stand', 'standing', 'blocked', 'block', 'no', 'none', 'nogo', 'not', 'half', 'decline', 'declined', 'deny', 'denied', 'abort',
  'aborted', 'cancel', 'cancelled', 'canceled', 'avoid', 'flat', 'refuse', 'refused', 'stop', 'reduce', 'reduced', 'cut', 'partial', 'fail', 'failed',
  'pending', 'conditional', 'nothing', 'veto', 'vetoed', 'vetoes']);

/** A line read plain: format characters dropped (markup, quotes and emoji are separators the decision reader skips). */
const plainLine = l => String(l).replace(/\p{Cf}/gu, '');

/**
 * The decision after one occurrence of the word: { word } (lower case; '' when nothing follows on the line), or null
 * when the occurrence is prose ("the decision is ...").
 */
function decisionAfter(rest) {
  // "is", "was" or "to" right after the word (spaces only between): prose, not a decision.
  const lead = /^\s+([A-Za-z]+)\b/.exec(rest);
  if (lead && PROSE.has(lead[1].toLowerCase())) return null;
  let i = 0;
  let bracketed = null;
  let number = null;
  while (i < rest.length) {
    const c = rest[i];
    if (BRACKETS[c]) {
      const end = rest.indexOf(BRACKETS[c], i + 1);
      const inner = end === -1 ? rest.slice(i + 1) : rest.slice(i + 1, end);
      if (bracketed === null) bracketed = (/[A-Za-z0-9]+/.exec(inner) || [''])[0];
      i = end === -1 ? rest.length : end + 1;
      continue;
    }
    if (!/[A-Za-z0-9]/.test(c)) { i += 1; continue; }
    const tok = /^[A-Za-z0-9]+/.exec(rest.slice(i))[0];
    const lower = tok.toLowerCase();
    i += tok.length;
    if (/^\d+$/.test(tok)) { if (number === null) number = tok; continue; }
    if (QUALIFIERS.has(lower)) continue;
    return { word: lower };
  }
  if (bracketed !== null) return { word: bracketed.toLowerCase() };
  if (number !== null) return { word: number };
  return { word: '' };
}

/** A heading's first word after the keyword (after separators, brackets' marks and qualifiers), lower case, or ''. */
function firstWord(rest) {
  for (const m of String(rest).matchAll(/[A-Za-z0-9]+/g)) {
    const w = m[0].toLowerCase();
    if (!QUALIFIERS.has(w)) return w;
  }
  return '';
}

/**
 * The refusal a heading states after one occurrence of the word: { word, line } or null. Nothing after it on the line:
 * the next non-empty line's first word ("# Verdict" then "PASS"), unless that line holds the word itself.
 */
function headingRefusal(lines, i, rest) {
  const lead = /^\s+([A-Za-z]+)\b/.exec(rest);
  if (lead && PROSE.has(lead[1].toLowerCase())) return null;
  let word = firstWord(rest);
  let line = lines[i];
  if (!word) {
    const j = lines.findIndex((l, k) => k > i && l.trim());
    if (j === -1 || new RegExp(KEYWORD_ALL.source, 'i').test(lines[j])) return null;
    word = firstWord(lines[j]);
    line = `${lines[i]} ${lines[j]}`;
  }
  return REFUSALS.has(word) || /^\d/.test(word) ? { word, line } : null;
}

/**
 * The refusal a keyword in mid-line prose states with no separator after it: { word, line } or null. Its first word
 * (qualifiers skipped) is a refusal or a number ("Sizing verdict skip x0.5", "Net decision pass on room"), else null
 * (prose). Nothing after it on the line: the next non-empty line's first word, its numbering skipped ("2 Context:" is
 * no number), refuses when it is a refusal or that line is a bare number, unless that line holds the word itself.
 */
function proseRefusal(lines, i, rest) {
  if (/[A-Za-z0-9]/.test(rest)) {
    const lead = /^\s+([A-Za-z]+)\b/.exec(rest);
    const word = lead && PROSE.has(lead[1].toLowerCase()) ? '' : firstWord(rest);
    if (REFUSALS.has(word) || /^\d/.test(word)) return { word, line: lines[i] };
    return sentenceRefusal(lines[i], rest);
  }
  const j = lines.findIndex((l, k) => k > i && l.trim());
  if (j === -1 || new RegExp(KEYWORD_ALL.source, 'i').test(lines[j])) return null;
  const word = firstWord(lines[j].replace(/^[^A-Za-z0-9]*(?:(?:plan|step)\s+)?\d+[.):]?\s+(?=[A-Za-z])/i, ''));
  return REFUSALS.has(word) || /^[^A-Za-z0-9]*\d+[^A-Za-z0-9]*$/.test(lines[j]) ? { word, line: `${lines[i]} ${lines[j]}` } : null;
}

// A refusal anywhere in a sentence ("Overall the decision here today is pass", "My decision is pass", "Our decision was
// stand aside"). Narrower than REFUSALS: "not", "no", "cut", "half" and "hold" are ordinary sizing prose ("keep the
// verdict's size, so I am not cutting", "the verdict's size with no size step").
const SENTENCE_REFUSAL = /\b(?:pass(?:ed|ing)?|skip(?:ped|ping|s)?|stand(?:s|ing)?\s+aside|sit(?:ting)?\s+out|no[\s-]+(?:trade|entry|go)|nogo|veto(?:ed|es)?|reject(?:ed|s|ion)?|declin(?:e|ed|es|ing)|abort(?:ed|s)?|refus(?:e|ed|es)|den(?:y|ied|ies)|blocked)\b/i;
/**
 * The refusal a keyword's own sentence states after it, when its first word decides nothing: { word, line } or null.
 * The sentence ends at '.' or ';' before a space or the line's end.
 */
function sentenceRefusal(line, rest) {
  const m = SENTENCE_REFUSAL.exec(String(rest).split(/[.;](?=\s|$)/)[0]);
  return m ? { word: m[0].toLowerCase().split(/[\s-]+/)[0], line } : null;
}

/** Every decision in a text: [{ keyword, word (lower case), line }], one per occurrence of the word. */
function decisionLines(text) {
  const lines = String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n').map(plainLine);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    // A markdown heading ("## Phase 2: Plan verdict, MNQ short") never approves: it counts only when it refuses.
    const heading = HEADING.test(lines[i]);
    const start = startIndex(lines[i]);
    for (const m of lines[i].matchAll(KEYWORD_ALL)) {
      if (heading) {
        const refused = headingRefusal(lines, i, lines[i].slice(m.index + m[0].length)) || sentenceRefusal(lines[i], lines[i].slice(m.index + m[0].length));
        if (refused) out.push({ keyword: m[1].toLowerCase(), word: refused.word, line: refused.line });
        continue;
      }
      // Not at the line's start: it never approves. With a label separator after it, the decision after the separator
      // refuses; with none, a refusal word or a number right after it refuses ("Room is short; decision pass"), else
      // it is prose ("the verdict's size", "the verdict ceiling", "a decision on ...").
      const after = lines[i].slice(m.index + m[0].length);
      const label = m.index !== start;
      const sep = label ? LABEL.exec(after) : null;
      if (label && !sep) {
        const refused = proseRefusal(lines, i, after);
        if (refused) out.push({ keyword: m[1].toLowerCase(), word: refused.word, line: refused.line });
        continue;
      }
      const d = decisionAfter(sep ? ` :${after.slice(sep[0].length)}` : after);
      if (d === null) {
        // Prose after it ("Decision is skip", "the decision was to pass"): its sentence still refuses.
        const refused = sentenceRefusal(lines[i], after);
        if (refused) out.push({ keyword: m[1].toLowerCase(), word: refused.word, line: refused.line });
        continue;
      }
      let { word } = d;
      let line = lines[i];
      if (!word) {
        // A heading: the decision is the next non-empty line's first token, unless that line holds the word itself.
        const j = lines.findIndex((l, k) => k > i && l.trim());
        if (j !== -1 && new RegExp(KEYWORD_ALL.source, 'i').test(lines[j])) continue;
        word = j === -1 ? '' : decisionAfter(`:${lines[j]}`).word;
        line = `${lines[i]} ${j === -1 ? '' : lines[j]}`;
      }
      if (label && AGREE.has(word)) continue;
      out.push({ keyword: m[1].toLowerCase(), word, line });
    }
  }
  return out;
}

/** Why a report is no approval, or null: a decision other than approve/take, or a veto. */
function verdictProblem(text) {
  const lines = decisionLines(text);
  const other = lines.find(l => !AGREE.has(l.word));
  if (other) return `a ${other.keyword} line decides ${other.word || 'nothing'}, not APPROVE ("${other.line.trim().replace(/\s+/g, ' ').slice(0, 80)}")`;
  // The veto rule reads every line holding the word, prose too ("the verdict is veto").
  const keyed = String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n').map(plainLine).filter(l => /\b(?:verdict|decision)\b/i.test(l));
  if (lines.some(l => VETO_WORD.test(l.line)) || keyed.some(l => VETO_WORD.test(l))) return 'a decision line says veto';
  const plain = String(text || '').replace(/\p{Cf}/gu, '');
  if (VETO_CAPS.test(plain)) return 'the report says VETO';
  return null;
}

/** The report's verdict: 'APPROVE' (a verdict line approves and nothing refuses), 'VETO' (anything refuses), or null. */
function verdictOf(text) {
  if (verdictProblem(text)) return 'VETO';
  return decisionLines(text).some(l => l.keyword === 'verdict' && APPROVE_WORDS.has(l.word)) ? 'APPROVE' : null;
}

/**
 * A report that holds an approving VERDICT line and still reads as a veto (verdictOf: VETO; a model's looser wording,
 * "Decision: cut to size 1"): { why: verdictProblem's reason, line: the approving verdict line as written }, else null
 * (an approval, a plain veto, no verdict). Reporting only: what the gate reads is verdictOf's, unchanged.
 */
function approvalReadAsVeto(text) {
  if (verdictOf(text) !== 'VETO') return null;
  const ok = approvingLines(text)[0];
  return ok ? { why: verdictProblem(text), line: ok.line.trim() } : null;
}

/** The approving VERDICT lines, as decisionLines reads them: the ones verdictOf approves on and approvedSize sizes. */
const approvingLines = text => decisionLines(text).filter(l => l.keyword === 'verdict' && APPROVE_WORDS.has(l.word));

/**
 * The line a report's verdict was decided on (verdictOf's own reading, never a second one), trimmed, or '':
 *   APPROVE   the first approving VERDICT line (a markdown heading never is: "## Phase 2 verdict: MNQ long" decides nothing)
 *   VETO      the first decision line that refuses (not approve/take), else the first line saying veto
 *   none      '' (no verdict line)
 * What the runner hands the trade-executor and names in a veto's why.
 */
function decisiveLine(text) {
  const v = verdictOf(text);
  const one = l => String(l).trim().replace(/\s+/g, ' ');
  if (v === 'APPROVE') return one(approvingLines(text)[0].line);
  if (v !== 'VETO') return '';
  const lines = decisionLines(text);
  const refusing = lines.find(l => !AGREE.has(l.word)) || lines.find(l => VETO_WORD.test(l.line));
  if (refusing) return one(refusing.line);
  // The report says VETO elsewhere (verdictProblem's last rule): that line, as shown.
  const veto = plainLine(String(text || '')).split(/\r\n|\r|\n/).find(l => VETO_WORD.test(l));
  return veto ? one(veto) : '';
}

// "size <n>" on a verdict line, a "Size: <n>" line (a list bullet, number or quote mark before it), and on either a cut:
// "cut / cut back / trimmed / reduced / lowered / (scaled) down to [size] <n>", "→ ⇒ -> => <n>" ("to size <n>" on a
// verdict line is its "size <n>"). Each token must be a whole size of 1 or more.
const SIZE_SAID = /\bsize\s*[:=]?\s*([^\s,;)]+)/gi;
const SIZE_LINE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*Size[*_]*[ \t]*[:=][*_ \t]*([^\s,;(]+)(.*)$/gim;
const CUT_TO = /(?:\b(?:cut(?:\s+back)?|trimmed|reduced|lowered|down)\s+to(?:\s+size)?|\u2192|\u21d2|->|=>)\s*([^\s,;):]+)/gi;
// A prose Size line's words that state a size without a number: no size the gate can read (fails closed).
const SIZE_WORDS = new Set(['half', 'quarter', 'third', 'double', 'twice', 'zero', 'none', 'nil', 'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'min', 'minimum', 'max', 'maximum', 'floor', 'n/a', 'na', 'tbd', 'tba', 'unknown']);
const CUT_VERB = /\b(?:cut(?:s|ting)?|trim(?:s|med|ming)?|reduc(?:e|es|ed|ing)|lower(?:s|ed|ing)?|halv(?:e|es|ed|ing)|scal(?:e|es|ed|ing)\s+down)\b/gi;
// A distance, not a size, after a cut's number ("cut to 1 tick beyond", "to 40 points", "to 2R").
const UNIT_AFTER = /^\s*(?:ticks?|points?|pts?|%|R\b|x\b)/i;
// A cut the report doesn't make ("I'd cut", "would cut", "not cutting ... to"), or takes back ("but keep").
const NOT_MADE = /(?:\b(?:would|could|might|should|if|not|never)\s+(?:\w+\s+)?$|'d\s+(?:\w+\s+)?$|n't\s+(?:\w+\s+)?$)/i;
const TAKEN_BACK = /\bbut\s+(?:keep|hold|stay|leave)/i;
/**
 * A prose Size line's cuts: { sizes, bad }. CUT_TO's forms anywhere on it, and, in each sentence holding a cut verb,
 * every "to [size] <n>" after the verb ("I cut the translated 17 to 5": 5). Only a whole number reads as a size: a
 * distance (ticks, points, R, %), a dollar amount or a word after "to" is no cut ("the stop is cut to 1 tick beyond",
 * "risk cut to $150", "cut it to fit"), but a size word ("cut to half") and a cut the sentence doesn't make
 * ("I'd cut to 2 but ...", "cut to 2 but keep 3") are errors: a size the report rejects never binds (fails closed).
 */
function proseCuts(line) {
  const sizes = [];
  let bad = false;
  const take = (tok, tail) => {
    const t = String(tok || '');
    if (/^[A-Za-z]/.test(t)) { if (SIZE_WORDS.has(t.toLowerCase().replace(/[^a-z/]+$/, ''))) bad = true; return; }
    if (t.startsWith('$') || UNIT_AFTER.test(tail)) return;
    sizes.push(t);
  };
  const text = String(line);
  for (const m of text.matchAll(CUT_TO)) take(m[1], text.slice(m.index + m[0].length));
  for (const sentence of text.split(/[.;!?](?=\s|$)/)) {
    const verb = [...sentence.matchAll(CUT_VERB)][0];
    if (!verb) continue;
    const rest = sentence.slice(verb.index + verb[0].length);
    const targets = [...rest.matchAll(/\bto\s+(?:size\s+)?([^\s,;):]+)/gi)];
    for (const m of targets) take(m[1], rest.slice(m.index + m[0].length));
    if (targets.length && (NOT_MADE.test(sentence.slice(0, verb.index)) || TAKEN_BACK.test(rest))) bad = true;
  }
  return { sizes, bad };
}

/**
 * Every count a prose Size line holds (owner's review, 2026-10-24: broad, fail closed): each whole number that is no
 * amount, decimal, range, time, id, timeframe or distance ("$65.24", "$6,000", "2.74R", "10%", "10:12", "15m",
 * "x0.5", "40 ticks", "12 points"), and each number spelled one to twenty. Any of them under the binding size makes
 * the report two sizes: no trade, whatever the number counts ("2 of the last 11 reviews" too).
 */
const NUMBER_RUN = /\d+(?:[.,:]\d+)*/g;
const NOT_A_COUNT_AFTER = /^(?:[A-Za-z%]|[.,:]\d|\s*(?:ticks?|points?|pts?|R|x|ET|UTC|am|pm)\b|\s*%)/i;
const SPELLED = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const SPELLED_RE = new RegExp(`\\b(${SPELLED.join('|')})\\b`, 'gi');
// A share of a size, or a reduction without its number: no size the reader can read unless a cut gives the number.
const SHARE_WORD = /\b(?:half|halv(?:e|es|ed|ing)|quarter|third|fewer|minimum|reduc(?:e|es|ed|ing)\s+by)\b/i;
function countsIn(line) {
  const text = String(line);
  const out = [];
  for (const m of text.matchAll(NUMBER_RUN)) {
    if (/[.,:]/.test(m[0])) continue;
    if (/[\w$#/.\-\u2212]/.test(text[m.index - 1] || '')) continue;
    if (NOT_A_COUNT_AFTER.test(text.slice(m.index + m[0].length))) continue;
    out.push(Number(m[0]));
  }
  for (const m of text.matchAll(SPELLED_RE)) out.push(SPELLED.indexOf(m[1].toLowerCase()) + 1);
  return out;
}
/** A Size line's continuation: the lines after it up to a blank line, a bullet, a numbered item, a heading or a keyword line. */
function continuation(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (!l.trim() || /^\s*(?:[-*+]|\d+[.)]|#{1,6})\s/.test(l) || /^[\s>*_]*(?:VERDICT|FACTS|Size|PLAN|Decision)\b/i.test(l)) break;
    out.push(l);
  }
  return out.join(' ');
}
const SIZE_ONE = new RegExp(SIZE_LINE.source, 'i');
/** A number-led Size line's cuts (CUT_TO): a dollar amount or a distance after a cut is no size ("risk cut to $150"). */
function sizeLineCuts(line) {
  const out = [];
  for (const m of String(line).matchAll(CUT_TO)) {
    const t = m[1];
    if (/^[A-Za-z$]/.test(t) || UNIT_AFTER.test(line.slice(m.index + m[0].length))) continue;
    out.push(t);
  }
  return out;
}

/**
 * The size an approving report approves: { size } (a whole number, 1 or more), or { error }. Each approving VERDICT line
 * must say `size <n>` (agents/risk-manager.md); a `Size: <n>` line counts too, and every size and cut on either; the
 * smallest of them binds. A size that can't be read (none, 0, a fraction, a placeholder, a range, a word, markup before
 * it) is an error, never a size (fails closed). A Size line opening with a word is prose (owner-approved 2026-10-24:
 * "Size: order_plan gives 4 MNQ ... I cut to 3"): it states no size, and every cut in it binds (CUT_TO's, and proseCuts'
 * "cut ... to <n>", a whole number only, never a distance or an amount); a size word first ("half", "one", "none",
 * "n/a"), a cut it doesn't make ("I'd cut to 2", "but keep"), any count it holds (or its continuation lines) under the
 * binding size (countsIn: "go with 3 of the translated 8", "I take three") or a share word with no cut to read ("reduce
 * by half") is an error. The VERDICT line's size still binds, so a prose line only ever
 * lowers the size or refuses.
 */
function approvedSize(text) {
  const sizes = [];
  const bad = [];
  const read = (tok, line) => { const t = String(tok || '').replace(/[.*_]+$/, ''); return /^0*[1-9]\d*$/.test(t) ? sizes.push(Number(t)) : bad.push(line); };
  // Every number a line cuts to binds too ("size 2 cut to 1", "size 8 -> 1"): the smallest is the size.
  // A word after it is prose, not a size ("size within budget"); anything else must read as one.
  const word = tok => /^[A-Za-z]/.test(String(tok || ''));
  const cuts = (line, shown) => { for (const m of line.matchAll(CUT_TO)) if (!word(m[1])) read(m[1], shown); };
  const approving = approvingLines(text);
  if (!approving.length) return { error: 'no approving VERDICT line' };
  for (const l of approving) {
    const said = [...l.line.matchAll(SIZE_SAID)].filter(m => !word(m[1]));
    if (!said.length) bad.push(l.line.trim());
    for (const m of said) read(m[1], l.line.trim());
    cuts(l.line, l.line.trim());
  }
  const prose = [];
  const lines = String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = SIZE_ONE.exec(lines[i]);
    if (!m) continue;
    const shown = m[0].trim();
    // A Size line opening with a word is prose ("Size: order_plan gives 4 ..."), not a size: every cut in it still
    // binds (proseCuts); a size word ("half", "one", "none", "n/a") or a cut it doesn't make is no size (an error).
    if (word(m[1])) {
      if (SIZE_WORDS.has(m[1].toLowerCase().replace(/[^a-z/]+$/, ''))) bad.push(shown);
      const body = `${m[1]}${m[2]} ${continuation(lines, i)}`;
      const c = proseCuts(body);
      if (c.bad) bad.push(shown);
      for (const t of c.sizes) read(t, shown);
      prose.push({ body, cut: c.sizes.length > 0 });
      continue;
    }
    read(m[1], shown);
    for (const t of sizeLineCuts(m[2])) read(t, shown);
  }
  if (bad.length) return { error: `no whole size of 1 or more in "${bad[0].replace(/\s+/g, ' ')}"` };
  const size = Math.min(...sizes);
  // A prose Size line holding any other count under the size that binds ("go with 3 of the translated 8", "I take
  // three"), or a share of it with no cut to read ("reduce by half"): phase 2 said two sizes; no trade (fails closed).
  const under = prose.find(p => countsIn(p.body).some(n => n < size) || (SHARE_WORD.test(p.body) && !p.cut));
  if (under) return { error: `a Size line states a count under the ${size} it binds, or a share with no cut to it: "Size: ${under.body.replace(/\s+/g, ' ').trim()}"` };
  return { size };
}

/**
 * The size a report's approving VERDICT lines alone state, read as approvedSize reads them (every "size <n>" and cut on
 * them binds; a VERDICT line with no whole size is an error), its Size lines and prose left out: { size } | { error }.
 * The runner's bound when phase 2 restates a report it couldn't read (runner-entry.js, phase2-restate.js): a restated
 * size never exceeds it.
 */
function verdictSize(text) {
  const approving = approvingLines(text);
  if (!approving.length) return { error: 'no approving VERDICT line' };
  return approvedSize(approving.map(l => l.line.trim()).join('\n'));
}

/**
 * The report's own verdict refuses: a VERDICT-keyword decision line whose decision is no approval (decisionLines'
 * reading, its sentence-refusal rule too: "VERDICT: VETO - room", "The verdict is veto", "Sizing verdict: skip"), or a
 * line that starts with a veto ("VETO - room"). A veto word elsewhere on an approving VERDICT line ("size 3, no veto
 * needed", "(veto-free)") doesn't: such a report is restated and the answer read strictly (owner's goal, 2026-10-24:
 * never lose a good setup to the reading). The runner never restates a refusing report (phase2-restate.js).
 */
const STARTS_VETO = /^[\s>#*_`|+\-\u2022]*(?:\d+[.)][\s>#*_`|]*)?veto(?:ed|es)?\b/i;
function verdictLineRefuses(text) {
  if (decisionLines(text).some(l => l.keyword === 'verdict' && !AGREE.has(l.word))) return true;
  return String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n').some(l => STARTS_VETO.test(plainLine(l)));
}

/**
 * A Size line that states a size (approvedSize reads it as one: a number first, or a count, a spelled number or a
 * size word in it), not prose that only opens with "Size:" ("Size: vwap above"). The runner's decisive record leaves
 * such Size lines out of a FACTS block, and no other (phase2-restate.js).
 */
const SIZE_STATED = new RegExp(`\\d|\\b(?:${[...SIZE_WORDS].map(w => w.replace('/', '\\/')).join('|')}|${'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty'})\\b`, 'i');
function statesSize(line) {
  const m = SIZE_ONE.exec(String(line || ''));
  return Boolean(m) && SIZE_STATED.test(`${m[1]}${m[2]}`);
}

/** The approving VERDICT lines as written, trimmed (the ones verdictOf approves on and approvedSize sizes). */
const approvingVerdictLines = text => approvingLines(text).map(l => l.line.trim());

const SPELLED_CUT = new RegExp(`(?:\\bto(?:\\s+size)?|\u2192|\u21d2|->|=>)\\s*(${SPELLED.join('|')})\\b`, 'gi');
// A Size line's first word stating no size: the report stated none (no restatement).
const NO_SIZE = new Set(['zero', 'none', 'nil', 'no', 'n/a', 'na', 'unknown', 'tbd', 'tba']);
/**
 * The most a restatement may approve (phase2-restate.js): the smallest of the approving VERDICT lines' size
 * (verdictSize) and every whole size and cut the report's Size lines state, as approvedSize collects them (a
 * number-led line's number and cuts; a prose line's cuts, proseCuts, and a spelled number first); { size } | { error }.
 * A Size line stating no size (0, none, zero, nil, no, n/a, unknown) or one that isn't a whole size ("1.5", "<n>"): an
 * error (no restatement: the report stated no size to bound it). A prose cut the report doesn't make or a share word
 * ("I would cut to half") lowers nothing: the restatement says the size, never above this.
 */
function restateCeiling(text) {
  const v = verdictSize(text);
  if (v.error) return v;
  const sizes = [v.size];
  const whole = t => /^0*[1-9]\d*$/.test(String(t));
  const lines = String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = SIZE_ONE.exec(lines[i]);
    if (!m) continue;
    const shown = m[0].trim().replace(/\s+/g, ' ');
    const tok = String(m[1] || '').replace(/[.*_]+$/, '');
    const low = tok.toLowerCase().replace(/[^a-z/]+$/, '');
    if (NO_SIZE.has(low) || /^0+$/.test(tok)) return { error: `a Size line states no size ("${shown}")` };
    // A spelled size after "to" or an arrow anywhere on the line or its continuation ("three, cut to two"): it binds.
    for (const c of `${m[1]}${m[2]} ${continuation(lines, i)}`.matchAll(SPELLED_CUT)) sizes.push(SPELLED.indexOf(c[1].toLowerCase()) + 1);
    if (/^[A-Za-z]/.test(tok)) {
      if (SPELLED.includes(low)) sizes.push(SPELLED.indexOf(low) + 1);
      for (const t of proseCuts(`${m[1]}${m[2]} ${continuation(lines, i)}`).sizes) if (whole(t)) sizes.push(Number(t));
      continue;
    }
    if (!whole(tok)) return { error: `a Size line states no whole size ("${shown}")` };
    sizes.push(Number(tok));
    for (const t of sizeLineCuts(m[2])) if (whole(String(t).replace(/[.*_]+$/, ''))) sizes.push(Number(String(t).replace(/[.*_]+$/, '')));
  }
  return { size: Math.min(...sizes) };
}

/**
 * The gate's `phase2-size` check (tighten-only): an entry's size over the size its approving phase-2 report approved
 * (approvedSize), or none readable, refuses. `report`: approvedPhase2's answer (null: no phase 2 is required, none
 * checked; { error }: refused). The message, or null.
 */
function sizeRefusal(report, size) {
  if (!report) return null;
  if (report.error) return `The cycle's transcript can't be read (${report.error}), so the gate can't check the size risk-manager phase 2 approved: no entry this cycle.`;
  const a = approvedSize(report.text);
  if (a.error) return `Risk-manager phase 2's approval states no size the gate can read (${a.error}); its VERDICT line says "size <n>": no entry this cycle.`;
  if (!(Number.isInteger(size) && size >= 1 && size <= a.size)) return `size ${JSON.stringify(size)} is over the ${a.size} risk-manager phase 2 approved: an entry is at most phase 2's size (it only ever cuts one).`;
  return null;
}

/** Kept for callers that count decision lines. */
const verdictMatches = decisionLines;
const verdictLines = decisionLines;

/**
 * THE phase-2 report: the latest completed phase-2 report by end time, or null when there is none or two end together
 * (no single report can be told). The entry stands or falls on it alone: its verdict must approve, and its FACTS are
 * the ones the gate checks.
 */
function latestPhase2(phase2) {
  if (!phase2.length) return null;
  const sorted = phase2.slice().sort((a, b) => a.end - b.end);
  const last = sorted[sorted.length - 1];
  return sorted.length > 1 && sorted[sorted.length - 2].end === last.end ? null : last;
}

/**
 * When this entry's round started: the last trade-executor launch's end (else its start), the one placing this order
 * excepted (it may still be running: Claude, Qwen); -Infinity before any.
 */
function roundStart(launches = []) {
  const pending = launches.filter(l => l.pending);
  const current = pending[0] || null;
  return Math.max(-Infinity, ...launches.filter(l => l !== current).map(l => (l.end ?? l.start)));
}

/**
 * The round before this entry, from the calls since the last trade-executor call ended: { missing: what the cycle
 * still lacks, [] when complete; p2: the phase-2 reports that count }.
 */
function round({ calls = [], launches = [] }, cycle, cached = []) {
  if (!CYCLES.includes(cycle)) return { missing: [], p2: [] };
  // The trade-executor launch placing this order may still be running (Claude, Qwen: no result yet); any other
  // launch, finished, errored, running or in the background, ends the round: its end, else its start.
  const pending = launches.filter(l => l.pending);
  if (pending.length > 1) return { missing: [`one trade-executor at a time (${pending.length} running)`], p2: [] };
  const lastExec = roundStart(launches);
  const fresh = calls.filter(c => c.start > lastExec);
  const firstEnd = role => Math.min(...fresh.filter(c => c.role === role).map(c => c.end));
  const missing = [];
  // Roles served from the report cache count in the cycle's first round only: after a trade-executor launch (an
  // entry, or an attempt at one) the account and the plan changed, so every role runs again.
  const counted = lastExec === -Infinity ? cached : [];
  const needed = cycle === 'full' ? ANALYSTS.filter(r => !counted.includes(r)) : [];
  for (const r of needed) if (!fresh.some(c => c.role === r)) missing.push(r);
  const rm = fresh.filter(c => c.role === 'risk-manager');
  const ranAfter = needed.filter(r => fresh.some(c => c.role === r)).map(firstEnd);
  if (counted.includes('risk-manager')) {
    // Phase 1 served from the cache: phase 2 is a risk-manager call started after every analyst that ran.
    const p2 = rm.filter(c => c.start > Math.max(-Infinity, ...ranAfter));
    if (!p2.length) missing.push(`risk-manager phase 2 (started after ${needed.length ? 'the analysts' : 'the cached reports were given'})`);
    return { missing, p2 };
  }
  if (!rm.length) return { missing: [...missing, 'risk-manager phase 1', `${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`], p2: [] };
  // Phase 2 reviews the plan: it starts once phase 1 (and every analyst) has returned.
  const phase1End = Math.min(...rm.map(c => c.end));
  const after = Math.max(phase1End, ...ranAfter);
  const p2 = rm.filter(c => c.start > after);
  if (!p2.length) missing.push(`${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`);
  return { missing, p2 };
}

/**
 * The round judged once, for the roles check and the facts check alike (the same calls, the same cached list):
 * { missing, unmet, report }. Index mode (`lookups`, skill-lookups.js): a report whose role didn't look up a skill this
 * bar requires doesn't count toward the roles, and a cached role that needs one isn't counted as cached. The phase-2
 * report is the latest-ending COUNTED phase-2 call; it must approve, and no uncounted risk-manager veto may end at or
 * after it, or the entry is refused (NOT_APPROVED); `report` is it when it approves.
 */
function assessRound(found, cycle, cached = [], lookups = null) {
  const unmet = [];
  let calls = found.calls;
  if (typeof lookups === 'function') {
    // This round's calls only: a lookup made before the last trade-executor call counts for that entry, not this one.
    const inRound = found.calls.filter(c => c.start > roundStart(found.launches));
    calls = found.calls.filter(c => {
      const skills = lookups(c, inRound);
      if (skills.length) unmet.push(`${c.role} reported without looking up ${skills.join(', ')} (its skill index requires it on this bar, or on any bar when no current bar briefing shows the situation: skill_lookup with its role)`);
      return !skills.length;
    });
  }
  // A role served from the report cache made no lookup this cycle: not counted where one is required of it.
  const needs = typeof lookups === 'function' && typeof lookups.needs === 'function' ? lookups.needs : () => [];
  for (const r of cached) if (needs(r).length) unmet.push(`${r} was served from the report cache, which made no lookup of ${needs(r).join(', ')} this cycle`);
  const counted = cached.filter(r => !needs(r).length);
  const { missing, p2 } = round({ calls, launches: found.launches }, cycle, counted);
  // THE phase-2 report: the latest-ending COUNTED phase-2 call (round()'s set: after phase 1 and the analysts, with
  // its lookups); it must approve (main's rule: a veto, then a revised plan approved later, passes; the reverse doesn't).
  // An uncounted call (no lookups, started before phase 1 or the analysts returned) never approves; one that vetoes
  // and ends at or after the selected report refuses it.
  const latest = latestPhase2(p2);
  const lastExec = roundStart(found.launches);
  const counted2 = new Set(p2);
  const laterVeto = Boolean(latest) && found.calls.some(c => c.role === 'risk-manager' && c.start > lastExec && !counted2.has(c)
    && c.end >= latest.end && verdictOf(c.text) === 'VETO');
  const approves = Boolean(latest) && verdictOf(latest.text) === 'APPROVE' && !laterVeto;
  if (CYCLES.includes(cycle) && found.unordered) missing.unshift(UNORDERED);
  if (CYCLES.includes(cycle) && !missing.length && !approves) missing.push(NOT_APPROVED);
  return { missing, unmet, report: approves && !found.unordered ? latest : null };
}

/** What the cycle still lacks before this entry, from the calls since the last trade-executor call ended. */
const missingRoles = (rc, cycle, cached = []) => assessRound(rc, cycle, cached).missing;

/** The cycle's transcript (with its main session's, for a Claude subagent): { text }, or { error } when the named file can't be read. */
function readTranscript(transcriptPath) {
  // A Claude subagent's hook gets its own transcript: the roles ran in its main session's.
  const files = transcriptFiles(transcriptPath).reverse();
  const texts = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      texts.push(buf.toString('utf8'));
    } catch (err) {
      if (file === transcriptPath) return { error: err.code || err.message };
    }
  }
  return { text: texts.join('\n') };
}

/**
 * The phase-2 report that approves this entry, judged exactly as checkRolesRan judges it (assessRound, the same inputs):
 * { text }; { error } when the transcript can't be read; null when the round isn't complete or its latest phase-2
 * report doesn't approve (checkRolesRan refuses then).
 */
function approvedPhase2(transcriptPath, cycle, cached = [], lookups = null, rolesFile = null) {
  if (!transcriptPath || !CYCLES.includes(cycle)) return null;
  const t = readTranscript(transcriptPath);
  if (t.error) return { error: t.error };
  const { missing, report } = assessRound(cycleCalls(t.text, rolesFile), cycle, cached, lookups);
  return missing.length || !report ? null : { text: report.text };
}

/**
 * The gate's check: a message naming what hasn't returned, or null. No
 * transcript or no cycle (an interactive session) -> null. A transcript the
 * runner named but that can't be read -> refused (fails closed).
 */
function checkRolesRan(transcriptPath, cycle, cached = [], lookups = null, rolesFile = null) {
  if (!transcriptPath || !CYCLES.includes(cycle)) return null;
  const t = readTranscript(transcriptPath);
  if (t.error) return `The cycle's transcript can't be read (${t.error}), so the gate can't see which roles ran: no entry this cycle.`;
  const { missing, unmet } = assessRound(cycleCalls(t.text, rolesFile), cycle, cached, lookups);
  return missing.length
    ? `A ${cycle} cycle enters only after its roles report, in the foreground, since the last trade-executor call (trade-session skill); not returned yet: ${missing.join(', ')}${unmet.length ? ` (${[...new Set(unmet)].join('; ')})` : ''}. This refused trade-executor call ends the round: report the block and end the cycle (trade-session step 6); the next entry needs every role again, then risk-manager phase 2 approving its plan, before its trade-executor call (a role whose report the cycle prompt gave from the cache counts only before the cycle's first trade-executor call; where the harness refuses its launch, that next entry is the next cycle's).`
    : null;
}

module.exports = { ANALYSTS, roleCalls, withRunnerRuns, cycleCalls, rolesInTranscript, missingRoles, checkRolesRan, approvedPhase2, assessRound, round, latestPhase2, verdictOf, approvalReadAsVeto, decisiveLine, approvedSize, verdictSize, verdictLineRefuses, restateCeiling, statesSize, approvingVerdictLines, sizeRefusal, verdictMatches, verdictLines, decisionLines, verdictProblem };
