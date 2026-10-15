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
 * The roles' turns (roleTurns), byte-faithful where recorded:
 *   the head trader   user: the cycle's prompt, as given to the harness (the cycle file's `prompt`); assistant: its
 *                     text parts in order (an opencode transcript's `text` events), joined by a blank line
 *   each subagent     user: the prompt the head trader gave it (opencode's task call input); assistant: the text it
 *                     returned (the task result inside opencode's <task_result> wrapper)
 *   system            the role's own prompt from the run's workspace/opencode.json (the generated adapter the run
 *                     read), when that file holds one; never rebuilt from today's documents
 * A transcript the reader doesn't recognize gives no head turn (nothing is guessed): `faithful: false`.
 *
 *   HEAD_ROLE
 *   taskResult(output)                     the subagent's text inside opencode's task wrapper, or null
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

function roleTurns(doc, { systemPrompts = {} } = {}) {
  if (!isObj(doc) || typeof doc.prompt !== 'string' || !doc.prompt) return [];
  const events = documents(doc.transcript).filter(isOpencodeEvent);
  const turns = [];
  const texts = events.filter(e => e.type === 'text' && isObj(e.part) && typeof e.part.text === 'string').map(e => e.part.text);
  turns.push(texts.length
    ? { role: HEAD_ROLE, messages: chat(systemPrompts[HEAD_ROLE], doc.prompt, texts.join('\n\n')), faithful: true }
    : { role: HEAD_ROLE, messages: null, faithful: false });
  for (const e of events) {
    const p = e.part;
    if (e.type !== 'tool_use' || !isObj(p) || p.tool !== 'task' || !isObj(p.state) || p.state.status !== 'completed') continue;
    const input = isObj(p.state.input) ? p.state.input : {};
    const role = typeof input.subagent_type === 'string' ? input.subagent_type : null;
    const reply = taskResult(resultText(p.state.output));
    if (!role || typeof input.prompt !== 'string' || !input.prompt || reply === null) { turns.push({ role: role || 'unknown', messages: null, faithful: false }); continue; }
    turns.push({ role, messages: chat(systemPrompts[role], input.prompt, reply), faithful: true });
  }
  return turns;
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
  const out = [];
  for (const r of score(runDir)) {
    const kind = kindOf(r);
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
    const setupRead = record && Array.isArray(record.reads) ? record.reads.find(x => x && x.step === 'setup') : null;
    out.push({
      key: `${new Date(r.t).toISOString()}|${r.symbol}`, runId: manifest.runId, t: new Date(r.t).toISOString(), day: r.day, symbol: r.symbol, kind, action,
      scorecard: { category: r.category, agrees: r.agrees }, expected: r.expected ? { decision: r.expected.decision, decidedBy: r.expected.decidedBy } : null,
      gate: { refused: Boolean(r.actual && r.actual.gate && r.actual.gate.decision === 'refused'), checks: (r.actual && r.actual.gate && r.actual.gate.checks) || [] },
      record, attempts: recs.length, riskUsd,
      account: attempt ? accountCall(attempt, riskUsd) : null,
      stage, accountState: state ? state.bucket : null, skill: (setupRead && setupRead.skill) || 'none', year: String(r.day || '').slice(0, 4),
      sample, cycle: cycleFile || null, turns: roleTurns(doc, { systemPrompts }),
    });
  }
  return out;
}

module.exports = { HEAD_ROLE, taskResult, roleTurns, systemPromptsOf, riskUsdOf, runDecisions };
