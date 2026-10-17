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
 * built on the briefing parts still current, risk-manager phase 1 on the account unchanged) count as returned;
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
        else if (c.is_error !== true && !ack) calls.push({ role: call.role, start: call.start, end: i, text: allText(c.content) });
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
// plain: format characters dropped (markup, quotes and emoji are separators like any other). EVERY occurrence of the word "verdict" or
// "decision" on a line is read: after it, qualifier tokens (final, phase, risk, overall, a number) and anything in (),
// [] or \u00ab\u00bb are skipped, then the first token after any separators (':', '-', '|', '/', '=', arrows, ellipses, spaces) is
// the decision. "is", "was", "to", "says" or "said" right after the word is prose: that occurrence isn't read (the veto
// rule still reads its line). Nothing after it: the
// next non-empty line's first token (a heading), unless that line holds the word itself. Only brackets after it: the
// bracketed token is the decision; only numbers: the number is (no letters, so it refuses). The order's own setup,
// side and size are what the gate checks, so several APPROVE lines are one approval, whatever else they say.
//   - any decision that isn't approve, approved, full (the prop verdict's action) or take (the trader-process "8
//     Decision: take") refuses; an approval is a verdict that says approve, approved or full;
//   - VETO (vetoed, vetoes) in capitals anywhere, or any case on a decision line, refuses ("a read, never a veto" doesn't).
// `full` is the prop verdict's own approving action (`skip` its other), so a model copying "verdict full" agrees.
const AGREE = new Set(['approve', 'approved', 'full', 'take']);
const APPROVE_WORDS = new Set(['approve', 'approved', 'full']);
const KEYWORD_ALL = /\b(verdict|decision)\b/gi;
const QUALIFIERS = new Set(['final', 'phase', 'risk', 'overall']);
const PROSE = new Set(['is', 'was', 'to', 'says', 'said']);
const BRACKETS = { '(': ')', '[': ']', '\u00ab': '\u00bb' };
const VETO_WORD = /\bveto(?:ed|es)?\b/i;
const VETO_CAPS = /\bVETO(?:ED|ES)?\b/;

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

/** Every decision in a text: [{ keyword, word (lower case), line }], one per occurrence of the word. */
function decisionLines(text) {
  const lines = String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n').map(plainLine);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(KEYWORD_ALL)) {
      const d = decisionAfter(lines[i].slice(m.index + m[0].length));
      if (d === null) continue;
      let { word } = d;
      let line = lines[i];
      if (!word) {
        // A heading: the decision is the next non-empty line's first token, unless that line holds the word itself.
        const j = lines.findIndex((l, k) => k > i && l.trim());
        if (j !== -1 && new RegExp(KEYWORD_ALL.source, 'i').test(lines[j])) continue;
        word = j === -1 ? '' : decisionAfter(`:${lines[j]}`).word;
        line = `${lines[i]} ${j === -1 ? '' : lines[j]}`;
      }
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

module.exports = { ANALYSTS, roleCalls, withRunnerRuns, cycleCalls, rolesInTranscript, missingRoles, checkRolesRan, approvedPhase2, assessRound, round, latestPhase2, verdictOf, verdictMatches, verdictLines, decisionLines, verdictProblem };
