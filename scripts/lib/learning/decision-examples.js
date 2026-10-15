'use strict';

/**
 * A replay run's decisions as fine-tuning material (learning/decision-dataset.js): each scored decision joined with
 * what the code verified about it and the exact prompts and responses of the roles that made it.
 *
 * Per scorecard record (replay/scorecard.js scoreRun, one per decision time and symbol):
 *   the decision   kind (take, pass, risk), action, the scorecard's category and expectation, the gate's refusal, the
 *                  cycle's compose record it is on (logs/cycles/<day>/<time>.json `composed`: its reads and their
 *                  checks, its plan), how many records the cycle tried, the plan's risk in dollars, and (stage 2) the
 *                  account call (decision-label.js accountCall on the attempt the cycle showed)
 *   balance keys   skill (the setup step's skill, else 'none'), the account state's practice bucket (the run's
 *                  account-states.jsonl, stage 2), the year
 *   turns          the roles' prompts and responses as the cycle recorded them (roleTurns)
 *
 * The roles' turns (roleTurns), faithful to what was recorded (texts byte for byte; a call's arguments faithful to the
 * parsed call):
 *   the head trader   user: the cycle's prompt, as given to the harness (the cycle file's `prompt`); then its whole turn
 *                     in order (headMessages), OpenAI-style: each model step an assistant message { content, tool_calls:
 *                     [{ id, type 'function', function { name, arguments } }] }, each call's result a tool message
 *                     { tool_call_id, content } (opencode's state.output, or state.error for a failed call; `task` calls
 *                     too, their content the wrapper the model read), ending in the final assistant text. `arguments`
 *                     is the call's recorded input as JSON (JSON.stringify of opencode's parsed input: faithful to the
 *                     parsed call, not its raw bytes); a repeated call id gives no head turn
 *   each subagent     (subagent: true) user: the prompt the head trader gave it (opencode's task call input);
 *                     assistant: the text it returned (the task result inside opencode's <task_result> wrapper). Its
 *                     claims are unchecked: the dataset trains on them only by name (decision-dataset.js roles)
 *   system            the role's own prompt from the run's workspace/opencode.json (the generated adapter the run
 *                     read), when that file holds one; never rebuilt from today's documents
 * A transcript the reader doesn't recognize, or a call it can't read whole, gives no head turn (nothing is guessed):
 * `faithful: false`. A decision whose cycle failed, timed out or was interrupted (cycleHealth: the run's store line for
 * its time, and its cycle file) carries `cycleFailed` (why), and none of its turns is faithful.
 *
 *   HEAD_ROLE
 *   taskResult(output)                     the subagent's text inside opencode's task wrapper, or null
 *   toolCall(part)                         { call, result } of an opencode tool_use part, or null
 *   headMessages(events)                   the head trader's messages after its prompt, or null (see above)
 *   cycleHealth(storeLine, cycleDoc)       why the cycle can't be trusted, or null
 *   roleTurns(doc, { systemPrompts })      [{ role, messages, faithful }]
 *   systemPromptsOf(home)                  { role: prompt } from <home>/workspace/opencode.json, {} without one
 *   runDecisions(runDir, { score, times, sample })   the run's decisions (see the head); `score(runDir)` -> scorecard
 *                                          records; `times`: only decisions at these times (a sample's); `sample`:
 *                                          { t, repeat, seed } recorded on each
 */

const fs = require('fs');
const path = require('path');
const { documents, isOpencodeEvent, resultText } = require('../transcript');
const { HEAD_AGENT } = require('../head-prompt');
const { familyRoot, specFor } = require('../trading/contracts');
const { readJson } = require('../harness-run');
const { accountCall } = require('./decision-label');

const HEAD_ROLE = HEAD_AGENT;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const TASK = /^<task\b[^>]*>\n<task_result>\n([\s\S]*)\n<\/task_result>\n<\/task>\s*$/;

function taskResult(output) {
  const m = TASK.exec(typeof output === 'string' ? output : '');
  return m ? m[1] : null;
}

function systemPromptsOf(home) {
  const cfg = readJson(path.join(home, 'workspace', 'opencode.json'), null);
  const agents = isObj(cfg) && isObj(cfg.agent) ? cfg.agent : {};
  return Object.fromEntries(Object.entries(agents).filter(([, a]) => isObj(a) && typeof a.prompt === 'string' && a.prompt).map(([k, a]) => [k, a.prompt]));
}

function chat(system, user, assistant) {
  return [...(typeof system === 'string' ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }, { role: 'assistant', content: assistant }];
}

/** A tool call as the model made it (OpenAI-style; its arguments faithful to the parsed call), and its result as the model read it, byte for byte. */
function toolCall(p) {
  const st = p.state;
  const id = typeof p.callID === 'string' && p.callID ? p.callID : null;
  if (!id || typeof p.tool !== 'string' || !p.tool || !isObj(st)) return null;
  const content = st.status === 'completed' ? resultText(st.output) : st.status === 'error' && typeof st.error === 'string' ? st.error : null;
  if (content === null) return null;
  return { call: { id, type: 'function', function: { name: p.tool, arguments: JSON.stringify(isObj(st.input) ? st.input : {}) } }, result: { role: 'tool', tool_call_id: id, content } };
}

/**
 * The head trader's whole turn, in order: the opencode events walked as they came, each model step's text and tool calls
 * one assistant message ({ content, tool_calls }), then each call's result as a tool message, then the final assistant
 * text. A text after a call within one step starts the next assistant message (the order is kept, never merged). Null
 * when any part can't be read faithfully (a call without its id, name or result, or a call id repeated) or the turn doesn't end in text.
 */
function headMessages(events) {
  const msgs = [];
  const ids = new Set();
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const m = { role: 'assistant', content: cur.texts.join('\n\n') };
    if (cur.calls.length) m.tool_calls = cur.calls.map(c => c.call);
    msgs.push(m, ...cur.calls.map(c => c.result));
    cur = null;
  };
  for (const e of events) {
    const p = e.part;
    if (e.type === 'step_start' || e.type === 'step_finish') { flush(); continue; }
    if (e.type === 'text' && isObj(p) && typeof p.text === 'string') {
      if (cur && cur.calls.length) flush();
      cur = cur || { texts: [], calls: [] };
      cur.texts.push(p.text);
    } else if (e.type === 'tool_use') {
      const c = isObj(p) ? toolCall(p) : null;
      // A call id seen before: which result answers which call is ambiguous, so the turn is not faithful.
      if (!c || ids.has(c.call.id)) return null;
      ids.add(c.call.id);
      cur = cur || { texts: [], calls: [] };
      cur.calls.push(c);
    }
  }
  flush();
  const last = msgs[msgs.length - 1];
  return last && last.role === 'assistant' && !last.tool_calls && last.content ? msgs : null;
}

function roleTurns(doc, { systemPrompts = {} } = {}) {
  if (!isObj(doc) || typeof doc.prompt !== 'string' || !doc.prompt) return [];
  const events = documents(doc.transcript).filter(isOpencodeEvent);
  const turns = [];
  const head = headMessages(events);
  const sys = systemPrompts[HEAD_ROLE];
  turns.push(head
    ? { role: HEAD_ROLE, messages: [...(typeof sys === 'string' ? [{ role: 'system', content: sys }] : []), { role: 'user', content: doc.prompt }, ...head], faithful: true }
    : { role: HEAD_ROLE, messages: null, faithful: false });
  for (const e of events) {
    const p = e.part;
    if (e.type !== 'tool_use' || !isObj(p) || p.tool !== 'task' || !isObj(p.state) || p.state.status !== 'completed') continue;
    const input = isObj(p.state.input) ? p.state.input : {};
    const role = typeof input.subagent_type === 'string' ? input.subagent_type : null;
    const reply = taskResult(resultText(p.state.output));
    if (!role || typeof input.prompt !== 'string' || !input.prompt || reply === null) { turns.push({ role: role || 'unknown', messages: null, faithful: false, subagent: true }); continue; }
    turns.push({ role, messages: chat(systemPrompts[role], input.prompt, reply), faithful: true, subagent: true });
  }
  return turns;
}

/**
 * Why the decision's cycle can't be trusted, or null: the replay store's line for its time (replay/store.js readRun)
 * says a cycle failed or timed out, the step timed out or was interrupted, or the cycle file itself says it failed. No
 * store line for the time, or one whose `ran` is missing or empty: unknown, so failed too (nothing is assumed clean).
 */
function cycleHealth(line, doc) {
  if (!isObj(line)) return 'no replay record of the decision time: whether its cycle ran cleanly is unknown';
  if (line.interrupted) return 'the step was interrupted';
  if (isObj(line.step) && line.step.timedOut) return 'the step timed out';
  // A clean step ran at least one cycle, and every one of them finished ok: none recorded is no evidence of a clean one.
  if (!Array.isArray(line.ran) || !line.ran.length) return 'no cycle is recorded as run at the decision time';
  if (line.ran.some(x => !isObj(x) || x.ok !== true || x.timedOut)) return 'a cycle failed or timed out';
  if (isObj(doc) && (doc.ok === false || doc.timedOut === true)) return 'the cycle record says it failed or timed out';
  return null;
}

/** The run's store lines by decision time (ISO), attempts folded (replay/store.js readRun). */
function storeLines(runDir) {
  try {
    const { days } = require('../replay/store').readRun(runDir);
    return new Map(Object.values(days).flat().filter(l => isObj(l) && l.t).map(l => [new Date(l.t).toISOString(), l]));
  } catch (_err) { return new Map(); }
}

/** The cycle's compose records for a symbol's family, in the order the cycle wrote them. */
const recordsFor = (doc, symbol) => (isObj(doc) && Array.isArray(doc.composed) ? doc.composed : [])
  .filter(c => isObj(c) && familyRoot(String(c.symbol || c.contract || symbol).split(':')[0].toUpperCase()) === familyRoot(String(symbol).split(':')[0].toUpperCase()));

function riskUsdOf(rec, symbol) {
  if (!isObj(rec)) return null;
  const spec = specFor(familyRoot(String(symbol).split(':')[0].toUpperCase())) || {};
  const tick = num(rec.tick) ?? num(spec.tickSize);
  const value = num(rec.tickValue) ?? num(spec.tickValue);
  const [e, s, n] = [num(rec.entry), num(rec.stop), num(rec.size)];
  if ([tick, value, e, s, n].some(x => x === null) || !(tick > 0)) return null;
  return Math.round((Math.abs(e - s) / tick) * value * n * 100) / 100;
}

const kindOf = r => (r.decision === 'in-trade' ? 'risk' : r.decision !== 'flat' ? null
  : ['long', 'short'].includes(r.actual && r.actual.action) ? 'take' : r.actual && r.actual.action === 'none' ? 'pass' : null);

function statesOf(runDir) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(runDir, 'account-states.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_e) { return []; } }); } catch (_err) { /* stage 1 */ }
  return lines.length ? require('../prop/account-states').dayWeights(lines) : null;
}

function runDecisions(runDir, { score, times = null, sample = null } = {}) {
  if (typeof score !== 'function') throw new Error('runDecisions: score(runDir) -> the scorecard records');
  const home = path.resolve(runDir, '..', '..');
  const manifest = readJson(path.join(runDir, 'manifest.json'), null);
  if (!manifest) throw new Error(`${runDir}: no manifest.json (a replay run dir)`);
  const states = statesOf(runDir);
  // Stage 2 (account state plus risk action): the run's pinned stage (train/ab-compare.js setup.json), or its account states.
  const setup = readJson(path.join(runDir, 'setup.json'), null);
  const stage = (setup && setup.pinned && setup.pinned.stage === 2) || states ? 2 : 1;
  const systemPrompts = systemPromptsOf(home);
  const at = times ? new Set(times.map(t => new Date(t).toISOString())) : null;
  // A position the runner closed (its trail or time stop) is the policy's exit, never the model's (prop/model-stream.js
  // runnerExit, the same rule the risk actions and the Monte Carlo read).
  const MS = require('../prop/model-stream');
  const policyExitOf = MS.runnerExit(MS.readEvents(home), MS.readRunnerExits(home));
  const lastT = new Map();
  const lines = storeLines(runDir);
  const out = [];
  for (const r of score(runDir)) {
    const kind = kindOf(r);
    const prev = lastT.get(r.symbol);
    lastT.set(r.symbol, r.t);
    if (!kind || (at && !at.has(new Date(r.t).toISOString()))) continue;
    const cycleFile = r.provenance && r.provenance.cycleFile;
    const doc = cycleFile && cycleFile.startsWith('logs/cycles/') ? readJson(path.join(home, cycleFile), null) : null;
    const recs = recordsFor(doc, r.symbol);
    const action = r.actual ? r.actual.action : null;
    const ok = recs.filter(c => c.ok === true && (kind !== 'take' || c.side === action));
    const record = ok.length ? ok[ok.length - 1] : kind === 'take' ? null : recs.length ? recs[recs.length - 1] : null;
    const riskUsd = riskUsdOf(record, r.symbol);
    const attempt = r.facts && r.facts.attempt;
    const state = states ? states.get(r.day) : null;
    // An exit in a trade: the runner's own close from the cycle before it to this one (plus the runner's tolerance)?
    const policyExit = kind === 'risk' && action === 'exit'
      ? policyExitOf({ root: familyRoot(String(r.symbol).split(':')[0].toUpperCase()), contract: r.symbol }, { entryTime: prev || new Date(Date.parse(r.t) - 3600000).toISOString(), exitTime: new Date(Date.parse(r.t) + MS.RUNNER_CLOSE_TOLERANCE_MS).toISOString(), exitPrice: NaN, tick: 0 })
      : null;
    const setupRead = record && Array.isArray(record.reads) ? record.reads.find(x => x && x.step === 'setup') : null;
    // A failed, timed-out or interrupted cycle: unverifiable (decision-label.js), and none of its turns faithful.
    const cycleFailed = cycleHealth(lines.get(new Date(r.t).toISOString()), doc);
    const turns = roleTurns(doc, { systemPrompts });
    out.push({
      key: `${new Date(r.t).toISOString()}|${r.symbol}`, runId: manifest.runId, t: new Date(r.t).toISOString(), day: r.day, symbol: r.symbol, kind, action,
      scorecard: { category: r.category, agrees: r.agrees }, expected: r.expected ? { decision: r.expected.decision, decidedBy: r.expected.decidedBy } : null,
      gate: { refused: Boolean(r.actual && r.actual.gate && r.actual.gate.decision === 'refused'), checks: (r.actual && r.actual.gate && r.actual.gate.checks) || [] },
      record, attempts: recs.length, riskUsd, policyExit,
      // A pass is judged by the account alone (its entry block, soft stop, no cushion or daily room left), never by a
      // plan it didn't take: a refused compose record's risk is not the model's trade.
      account: attempt ? accountCall(attempt, kind === 'pass' ? null : riskUsd) : null,
      stage, accountState: state ? state.bucket : null, skill: (setupRead && setupRead.skill) || 'none', year: String(r.day || '').slice(0, 4),
      sample, cycle: cycleFile || null, cycleFailed, turns: cycleFailed ? turns.map(t => ({ ...t, faithful: false })) : turns,
    });
  }
  return out;
}

module.exports = { HEAD_ROLE, taskResult, toolCall, headMessages, cycleHealth, roleTurns, systemPromptsOf, riskUsdOf, runDecisions };
