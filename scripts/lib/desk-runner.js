'use strict';

/**
 * The runner's desk: in a full trade cycle the runner itself runs the roles the cycle must launch (the three analysts
 * and risk-manager phase 1, less those the report cache serves: trading/desk-check.js expectedRoles), each as its own
 * harness run, and gives the head trader their reports, as the report cache's are given (the prompt and
 * FTH_CYCLE_CACHED, which the order gate counts). After the DeepSeek harness's workflow engine: code fans the work out
 * to subagents and collects their results; the model doesn't choose whether the desk runs. In the PPC runs of
 * 2026-10-16 the 9B head trader, left to launch the desk itself, skipped it in most cycles (a no-trade from no tool
 * call at all, or analysing alone), and about one role report in six came from a role that read no data.
 *
 *   deskRequest(role, { symbol, contractId, at, timeframe })   the one request each role gets, built in code
 *   readData(output, { harnessServer, brokerServer })           true when the run read market or account data (a
 *       completed broker call, a file read, or a harness tool other than a skill or past-decision lookup)
 *   finalText(output)                                           the run's final message
 *   reportProblem(role, text)                                   why a report isn't one (empty, or not the role's
 *       own report shape), or null
 *   runDesk({ roles, runRole, concurrency, retries, request })  { reports, missing }: every role run, at most
 *       `concurrency` at once; a run that failed, read nothing or returned no report is run again up to `retries`
 *       times, then missing (never a rejection: the cycle goes on, and the order gate refuses an entry without it).
 *       runRole(role, text) -> { ok, timedOut, output, transcript } (the harness run; the caller's).
 */

const { ANALYSTS } = require('./trading/roles-ran');

/** The harness tools that read no market or account data: skills and the record of past decisions. */
const NOT_DATA = Object.freeze(['skill_lookup', 'experience_lookup']);
const RISK_MANAGER = 'risk-manager';

function deskRequest(role, { symbol, contractId = null, at, timeframe }) {
  const what = `${symbol}${contractId ? ` (contractId ${contractId})` : ''}`;
  const when = `the ${timeframe}-minute bar that closed by ${at}`;
  if (role === RISK_MANAGER) return `Phase 1, risk state, for ${what} at ${when}. Read the account and limits yourself (your phase 1 calls); no plan yet. Report in your phase 1 output format.`;
  return `Your report for ${what} at ${when}. Read your own data first (bar_briefing for ${symbol}, then what your method needs). Report in your output format, its Data line first.`;
}

/** opencode's JSON events of one run: the tool calls that completed. */
function completedTools(output) {
  const tools = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch (_err) { continue; }
    const p = e && e.part;
    if (e && e.type === 'tool_use' && p && typeof p.tool === 'string' && p.state && p.state.status === 'completed') tools.push(p.tool);
  }
  return tools;
}

function readData(output, { harnessServer = 'harness', brokerServer = 'broker' } = {}) {
  return completedTools(output).some(t => t.startsWith(`${brokerServer}_`) || t === 'read'
    || (t.startsWith(`${harnessServer}_`) && !NOT_DATA.includes(t.slice(harnessServer.length + 1))));
}

function finalText(output) {
  const texts = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch (_err) { continue; }
    if (e && e.type === 'text' && e.part && typeof e.part.text === 'string') texts.push(e.part.text);
  }
  return texts.length ? texts[texts.length - 1].trim() : '';
}

function reportProblem(role, text) {
  if (typeof text !== 'string' || !text.trim()) return 'no report';
  if (ANALYSTS.includes(role) && !/^\s*Data:/m.test(text)) return 'no Data line (its report names what it rests on)';
  if (role === RISK_MANAGER && !/Risk state/i.test(text)) return 'not a phase 1 risk state';
  return null;
}

async function runDesk({ roles = [], runRole, concurrency = 1, retries = 0, request = null } = {}) {
  const reports = [];
  const missing = [];
  const queue = [...new Set(roles)];
  const one = async role => {
    let why = 'not run';
    for (let tries = 1; tries <= retries + 1; tries += 1) {
      const started = Date.now();
      let res;
      try {
        res = await runRole(role, request ? request(role) : role);
      } catch (err) {
        why = `the run failed (${err && err.message ? err.message : err})`;
        continue;
      }
      const output = res ? res.output : '';
      const text = finalText(output);
      if (!res || !res.ok) why = res && res.timedOut ? 'timed out' : 'the run failed';
      else if (!readData(output)) why = 'read no data';
      else why = reportProblem(role, text);
      if (!why) { reports.push({ role, text, output, transcript: res.transcript || null, ms: Date.now() - started, tries }); return; }
    }
    missing.push({ role, why, tries: retries + 1 });
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  const order = r => queue.length + roles.indexOf(r.role);
  return { reports: reports.sort((a, b) => order(a) - order(b)), missing };
}

module.exports = { NOT_DATA, deskRequest, readData, finalText, reportProblem, runDesk };
