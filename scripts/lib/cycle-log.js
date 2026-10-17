'use strict';

/**
 * What the model saw and did in each autonomous cycle, for debugging and for
 * reviews:
 *
 *   (<day>, <HHMMSS>: the cycle's own trading day and time, the replay clock's in a replay: cycleClock)
 *   <FTH_HOME>/logs/cycles/<day>/<HHMMSS>-<action>[-<n>].json   the whole cycle: the
 *       prompt it was given and what it was built from (context: each symbol's
 *       bar, trend, day, plan, what fired with its record; the account and open
 *       trades; news; the sections that were unavailable), the harness argv
 *       (prompt elided), the raw
 *       transcript, and the parsed summary
 *   <FTH_HOME>/logs/cycles-<day>.jsonl   one summary line per cycle: result,
 *       skills loaded, tool calls by name, shell commands, orders sent, and
 *       the skills an entry needed but the model never loaded, and the roles'
 *       skill lookups (skill-lookups.js: how many, by role, and the reports a
 *       bar's required lookup applied to and met)
 *   factCheck (in both, the line's counts only when there is a report): every
 *       risk-manager phase-2 report's FACTS checked against the briefing
 *       (trading/fact-claims.js cycleFactChecks), for review (the scorecard
 *       reads its own reasonChecks, not this record)
 *   desk (in both, when the runner gave one): the roles a full cycle had to launch, those that returned, those
 *       missing and the launches that failed (trading/desk-check.js), so a cycle decided without its desk shows
 *   entry (in both, when the runner ran its entry: runner-entry.js): its outcome (executed, blocked, vetoed,
 *       no-trade, expired, unknown, process-failure, error, not-run), the roles it ran, the compose record, any
 *       failure, and its timing (ms from the bar's close to the head trader's planned and to the order, each role's ms)
 *   timing (in both, when the runner gave one): when the cycle acted against
 *       its bar (cycle-timing.js: the bar's close, the roles' calls, the
 *       decision, the order, the end; latencies, overran, setup caught/missed)
 *
 * Transcripts: Claude Code runs with --output-format stream-json (one JSON
 * event per line, tool calls included); Codex with --json; Qwen Code with
 * --output-format json (one array, tool calls included, often through its
 * tool_call bridge: counted as the tool reached); opencode with run --format
 * json (one event per line, the main session's tool calls only: a subagent's
 * own calls, the trade-executor's orders among them, are not in it: the orders add the gateway's records of the
 * cycle's window, gateOrders); others as text. The parser (transcript.js) reads what it recognizes and never throws.
 */

const fs = require('fs');
const path = require('path');
const { tradingDayKey } = require('./trading/clock');
const { REQUIRED_FOR_ENTRY, REQUIRED_FOR_COMPOSED, REQUIRED_AT_ENTRY, skillName } = require('./trading/skills-loaded');
const { cycleFactChecks } = require('./trading/fact-claims');
const { resolveClock } = require('./trading/harness-now');
const { cycleLaneBarsOf } = require('./trading/config');
const { documents, unwrap, bridgeRefused, resultText, SHELL_TOOLS, isOpencodeEvent, opencodeCall, opencodeStopped } = require('./transcript');

const ENTRY_TOOL = /(^|__)place_order$/;
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;

/**
 * Every tool call in a transcript (Claude stream-json, Codex --json, Qwen's JSON array, opencode's JSON
 * events, its MCP tools named mcp__<server>__<tool>): [{ name, input, failed?, error?, stopped? }] (error: the
 * failed call's answer, cut to 300 characters).
 * A call through a bridge wrapper (Qwen's tool_call, transcript.js BRIDGE_TOOLS) counts as the tool it
 * reaches, with that tool's arguments; one the bridge refused never reached the tool and isn't counted.
 */
function toolCalls(output) {
  const calls = [];
  const byId = new Map();
  const codexById = new Map();
  for (const doc of documents(output)) {
    for (const ev of Array.isArray(doc) ? doc : [doc]) {
      if (!ev || typeof ev !== 'object') continue;
      // opencode: { type: 'tool_use', part: { tool, state: { input } } } once a call completed or errored.
      if (isOpencodeEvent(ev)) {
        if (ev.type === 'tool_use' && ev.part.type === 'tool') {
          const { name, input, result } = opencodeCall(ev.part);
          calls.push({ name, input, ...(result && result.isError ? { failed: true, error: String(result.text || '').slice(0, 300) } : {}), ...(opencodeStopped(ev.part) ? { stopped: true } : {}) });
        }
        continue;
      }
      // Claude Code and Qwen Code: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
      // answered by { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content }] } }.
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use') {
          const call = unwrap(String(c.name || ''), c.input);
          calls.push(call);
          if (c.id !== undefined && c.id !== null) byId.set(c.id, call);
        } else if (c && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
          if (bridgeRefused(byId.get(c.tool_use_id), c)) byId.get(c.tool_use_id).refused = true;
          else if (c.is_error === true) Object.assign(byId.get(c.tool_use_id), { failed: true, error: resultText(c.content).slice(0, 300) });
        }
      }
      // Codex --json: { type: 'item.started' | 'item.updated' | 'item.completed', item: { id, type: 'command_execution' |
      // 'mcp_tool_call', ... } }. One call per item id, its latest form (a call still in flight when the turn
      // ended, only started, still counts); an item with no id counts once it completed.
      const item = /^item\.(started|updated|completed)$/.test(String(ev.type)) || ev.type === undefined ? ev.item : null;
      if (!item || !['command_execution', 'mcp_tool_call'].includes(item.type)) continue;
      if ((item.id === undefined || item.id === null) && !(ev.type === 'item.completed' || ev.type === undefined)) continue;
      let call;
      if (item.type === 'command_execution') call = { name: 'Bash', input: { command: item.command } };
      else {
        // An error: a failed status, an error, or a result the tool marked as one (isError).
        const failed = item.status === 'failed' || Boolean(item.error) || Boolean(item.result && typeof item.result === 'object' && (item.result.isError || item.result.is_error));
        const error = !failed ? '' : item.error ? String(item.error.message || JSON.stringify(item.error)) : resultText(item.result && typeof item.result === 'object' ? item.result.content : item.result);
        call = { name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {}, ...(failed ? { failed: true, error: error.slice(0, 300) } : {}) };
      }
      const key = item.id !== undefined && item.id !== null ? `codex:${item.id}` : null;
      if (key && codexById.has(key)) {
        const prev = codexById.get(key);
        for (const k of Object.keys(prev)) delete prev[k];
        Object.assign(prev, call);
      } else {
        calls.push(call);
        if (key) codexById.set(key, call);
      }
    }
  }
  // failed: the call came back an error (opencode's error status, a Claude/Qwen is_error result, a Codex
  // failed status, error or isError result): still a call; a skill load that failed isn't counted from the
  // calls (summarize's text fallback may still find its name in the transcript). stopped: opencode stopped it
  // itself (an unavailable tool, a permission rule), so no tool (no broker) ever saw it; still counted here.
  return calls.filter(c => !c.refused).map(c => ({ name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {}, ...(c.failed ? { failed: true, error: c.error || '' } : {}), ...(c.stopped ? { stopped: true } : {}) }));
}

/**
 * The parsed summary of one cycle's transcript. `gate`: the gateway's place_order records of the cycle's window
 * (gateOrders): one the transcript has no call for (an opencode trade-executor's, in a session of its own) is among
 * the orders, as the gateway logged it (`via: 'gate-log'`, with its `gate` decision).
 */
function summarize(output, embedded = [], gate = []) {
  const calls = toolCalls(output);
  const tools = {};
  for (const c of calls) tools[c.name] = (tools[c.name] || 0) + 1;
  const skills = [...new Set(calls.filter(c => (c.name === 'Skill' || c.name === 'skill') && !c.failed).map(c => skillName(c.input.skill || c.input.command || c.input.name)).filter(Boolean))];
  // Plain-text or single-JSON transcripts: skill names written as "skill": "<name>".
  for (const m of String(output || '').matchAll(/"skill"\s*:\s*"([^"]+)"/g)) if (!skills.includes(skillName(m[1]))) skills.push(skillName(m[1]));
  const commands = calls.filter(c => SHELL_TOOLS.has(c.name) && c.input.command).map(c => String(c.input.command).slice(0, 300));
  const orders = calls.filter(c => ENTRY_TOOL.test(c.name)).map(c => ({
    contractId: c.input.contractId, side: c.input.side, size: c.input.size, type: c.input.type, rationale: String(c.input.rationale || '').slice(0, 200),
  }));
  // Each gateway record matched to one transcript order of its contract and rationale; the rest are the cycle's too.
  const seen = orders.map(o => `${String(o.contractId ?? '')}\n${o.rationale}`);
  for (const g of gate) {
    const rationale = String(g.rationale ?? '').slice(0, 200);
    const i = seen.indexOf(`${String(g.contractId ?? '')}\n${rationale}`);
    if (i !== -1) { seen[i] = null; continue; }
    orders.push({ contractId: g.contractId, side: g.side, size: g.size, type: g.type, rationale, gate: g.decision, via: 'gate-log' });
  }
  const entries = orders.filter(o => !RISK_REDUCING.test(o.rationale));
  return {
    skills,
    tools,
    commands,
    orders,
    // An entry sent without the skills a trade decision needs (a Claude transcript lists every Skill load): the
    // per-cycle ones (REQUIRED_FOR_ENTRY; a trade_lifecycle entry's: REQUIRED_FOR_COMPOSED, as the gate requires them),
    // then the ones read before an entry (REQUIRED_AT_ENTRY).
    // Skills the runner attested embedded in opencode's head-trader prompt (head-prompt.js) are not missing.
    missingSkills: entries.length && calls.length ? [...(entries.every(o => COMPOSED_TAG.test(o.rationale)) ? REQUIRED_FOR_COMPOSED : REQUIRED_FOR_ENTRY), ...REQUIRED_AT_ENTRY].filter(s => !skills.includes(s) && !embedded.includes(s)) : [],
    ...(embedded.length ? { embeddedSkills: embedded } : {}),
  };
}

// A trade_lifecycle entry: tagged with it, or with a policy and naming it (setup:prop_portfolio long trade_lifecycle ...).
const COMPOSED_TAG = /^\s*setup:(?:trade_lifecycle\b|[a-z0-9_-]+\s+(?:long|short)\s+trade_lifecycle\b)/i;

// The gate log's tail read for a cycle's orders (it grows for the life of the home; a cycle's records are its last).
const GATE_TAIL_BYTES = require('./tunables').runner().limits.gateTailBytes; // config/runner.json
// After the cycle's end, the slack for the log write (replay/labels.js GATE_SLACK_MS).
const GATE_SLACK_MS = require('./tunables').runner().session.gateSlackMs;

/**
 * The gateway's place_order records (the gate log, gateLogPath(env): harness-owned, stamped by the wall clock, the
 * standard contract names the agents send) from `fromMs` to `toMs`, a tracker refusal folded into the allowed record
 * it follows (replay/labels.js collapsePairs). The gateway's only: every order call passes it, and a hook's record of
 * the same call would count it twice. Only the records stamped with this cycle's id (check-order.js cycleId, from the
 * cycle env's FTH_CYCLE_TRANSCRIPT): another home's, account's or session's order sharing the log and the window is
 * never this cycle's; no id (no runner cycle), none. [] when the log can't be read.
 */
function gateOrders(env, fromMs, toMs) {
  try {
    const { gateLogPath, cycleId } = require('./trading/check-order');
    const id = cycleId(env);
    if (!id) return [];
    const file = gateLogPath(env);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const len = Math.min(size, GATE_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const recs = [];
    for (const line of text.split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch (_err) { continue; }
      if (!e || typeof e !== 'object' || e.source !== 'gateway' || e.tool !== 'place_order' || e.cycle !== id) continue;
      const ms = Date.parse(e.ts);
      if (Number.isFinite(ms) && ms >= fromMs && ms <= toMs) recs.push({ ...e, ms });
    }
    return require('./replay/labels').collapsePairs(recs);
  } catch (_err) {
    return [];
  }
}

/**
 * The cycle's own time and lanes, read from the cycle's environment (`env`: the one the runner gave the harness,
 * autotrader.js childEnv) as the order gate reads them there: the replay clock's time when one is in force
 * (FTH_REPLAY_NOW, trading/harness-now.js; unset or refused: `at`, the wall clock), and the lanes whose bar closed
 * (FTH_CYCLE_LANE_BARS, trading/config.js; set but unreadable: null, so every situational lookup is required, as the
 * gate). No env (a caller that gives none): `at` and one lane, as before. `replay`: the replay clock was in force;
 * `charged`: it ran with the wall clock (the replay driver's latency setting), so the cycle's time was charged; the
 * cycle's time is then the replay time at its wall start `wallMs` (default: `at`, the wall time the runner gives).
 */
function cycleClock(env, at, wallMs = at.getTime()) {
  if (!env) return { cycleAt: at, laneBars: {}, replay: false, charged: false };
  let cycleAt = at;
  let replay = false;
  let charged = false;
  try {
    const c = resolveClock(env, { testClock: false });
    // The replay time at the cycle's wall start `at`: the pinned time, or with a running replay clock
    // (FTH_REPLAY_WALL_START: latency charged) the time it had reached then, never the time this is written at.
    if (c.replay) [cycleAt, replay, charged] = [c.atWall(wallMs), true, c.running];
  } catch (_err) { /* the wall clock */ }
  return { cycleAt, laneBars: cycleLaneBarsOf(env.FTH_CYCLE_LANE_BARS), replay, charged };
}

/**
 * Write the cycle record and its summary line. Returns { file, summary, lookups } (lookups: the cycle's skill_lookup
 * records but the session's own (skill-lookups.js rolesOwn), read before the run's lookups file is removed, for the
 * report cache: report-cache.js recordReports).
 * Never throws (logging must not stop trading).
 * `at`: when the cycle started on the wall clock (its `at`: the replay store and labels window the gate log, which
 * the wall clock stamps, with it). `env`: the cycle's environment (cycleClock): its own time (`cycleAt`, the replay
 * clock's in a replay) files the record under its trading day and is the time the lookups and the fact checks read
 * the bar briefing at, with the cycle's lanes, the inputs the gate judged its entries on.
 */
function writeCycleLog(home, { at = new Date(), env = null, action, harness, prompt, context = null, argv = [], output = '', result = null, reportedResult = null, ok = null, timedOut = false, durationMs = null, transcript = null, roleSkills = null, headPrompt = null, timing = null, desk = null, entry = null }) {
  const { cycleAt, laneBars } = cycleClock(env, at);
  const day = tradingDayKey(cycleAt);
  // The head trader's embedded skills as the runner attested them (FTH_HEAD_PROMPT; the gate checks them per entry).
  const att = headPrompt ? require('./head-prompt').parseAttestation(headPrompt) : null;
  // `env`: the cycle's environment (cycle-run.js), whose gate log holds the orders the cycle's calls sent through the
  // gateway, from its start to its end (`durationMs`, else now) and the log write's slack.
  const end = at.getTime() + (Number.isFinite(durationMs) ? durationMs : Math.max(0, Date.now() - at.getTime())) + GATE_SLACK_MS;
  const summary = summarize(output, att ? att.skills : [], env ? gateOrders(env, at.getTime(), end) : []);
  let lookups = [];
  // The roles' own: a lookup the head trader made naming a role (sessionLookups) is never that role's, so it is never
  // stored with the role's cached report and credited on a later cycle (as the gate leaves it out: lookupRule).
  try { if (transcript) { const L = require('./trading/skill-lookups'); lookups = L.rolesOwn(L.readLookups(transcript), transcript); } } catch (_err) { /* none */ }
  // The roles' skill lookups (skill-lookups.js), with how many reports a bar's requirement applied to and met.
  if (transcript) summary.skillLookups = cycleLookups({ home, output, transcript, context, roleSkills, at: cycleAt, laneBars });
  // The cycle's experience_lookup calls (learning/experience-lookups.js), kept with the cycle: their file goes with it.
  const experience = transcript ? cycleExperienceLookups(transcript) : [];
  if (experience.length) summary.experienceLookups = experience;
  // Every risk-manager phase-2 report's FACTS checked against its cycle bar's briefing (fact-claims.js, R29), recorded
  // for review; the scorecard reads its own reasonChecks, not this record (wiring it in is a separate change). Never throws.
  const factCheck = cycleFactChecks({ home, output, context, now: cycleAt });
  // Every compose_check call the cycle made (trade-lifecycle.js records stamped with its id): its reads, each check,
  // the signatures, the plan, OK or not (the composed-entry design section 5). Never throws.
  let composed;
  try {
    const symbols = ((context && context.symbols) || []).map(x => x && x.symbol).filter(Boolean);
    composed = env ? require('./trading/lifecycle-runner').cycleComposed(home, require('./trading/check-order').cycleId(env), symbols, cycleAt) : [];
  } catch (_err) { composed = []; }
  const stamp = cycleAt.toISOString().slice(11, 19).replace(/:/g, '');
  const dir = path.join(home, 'logs', 'cycles', day);
  let file = path.join(dir, `${stamp}-${action}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
      // result: the line as scored (autotrader.js scoreRun); reportedResult: the agent's own, when scored otherwise.
      at: at.toISOString(), cycleAt: cycleAt.toISOString(), action, harness, ok, timedOut, durationMs, result, ...(reportedResult ? { reportedResult } : {}), summary, factCheck, ...(timing ? { timing } : {}), ...(desk ? { desk } : {}), ...(entry ? { entry } : {}),
      ...(composed.length ? { composed } : {}),
      // context: what the prompt was built from (runner.js), so a line can be checked against its inputs.
      prompt, context, argv: argv.map(a => (a === prompt ? '<prompt>' : a)), transcript: output,
    }, null, 2);
    // A time run again (a replayed decision time retried) keeps the earlier record: the next free name, taken
    // atomically (exclusive create), so two writers never share one.
    for (let n = 2; ; n += 1) {
      try {
        fs.writeFileSync(file, body, { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || n > 1000) throw err;
        file = path.join(dir, `${stamp}-${action}-${n}.json`);
      }
    }
    fs.appendFileSync(path.join(home, 'logs', `cycles-${day}.jsonl`), `${JSON.stringify({
      at: at.toISOString(), cycleAt: cycleAt.toISOString(), action, harness, ok, timedOut, durationMs, result, ...(reportedResult ? { reportedResult } : {}), file,
      promptChars: String(prompt || '').length, ...summary, commands: summary.commands.length,
      ...(factCheck.error || (factCheck.counts && factCheck.counts.reports) ? { factCheck: factCheck.counts || { error: factCheck.error } } : {}),
      ...(composed.length ? { composed: { calls: composed.length, ok: composed.filter(x => x.ok).length, signatures: [...new Set(composed.filter(x => x.ok).map(x => x.signature))] } } : {}),
      ...(timing ? { timing } : {}),
      ...(desk ? { desk } : {}),
      ...(entry ? { entry: { outcome: entry.outcome || null, ran: (entry.ran || []).map(x => x.role), ...(entry.record ? { record: entry.record } : {}), ...(entry.failure ? { failure: entry.failure } : {}), ...(entry.timing ? { timing: entry.timing } : {}) } } : {}),
    })}\n`);
  } catch (_err) {
    // best effort
  }
  return { file, summary, lookups };
}

/**
 * The cycle's skill lookups and their compliance (index mode: the bar's requirements, first symbol's briefing at the
 * cycle's own time `at`, with its lanes `laneBars`, as the gate reads them: skill-lookups.js briefingFacts).
 */
function cycleLookups({ home, output, transcript, context, roleSkills, at, laneBars = {} }) {
  try {
    const { readLookups, rolesOwn, lookupsFile, briefingFacts, requiredFor, lookupStats } = require('./trading/skill-lookups');
    const { cycleCalls } = require('./trading/roles-ran');
    const symbol = ((context && context.symbols) || []).map(x => x && x.symbol).find(Boolean);
    const m3 = symbol ? briefingFacts(home, symbol, at, laneBars) : null;
    const required = roleSkills === 'index' ? requiredFor(path.resolve(__dirname, '..', '..')) : new Map();
    // The roles' own: the head trader's lookups naming a role (rolesOwn) are not that role's adherence.
    const records = rolesOwn(readLookups(transcript), transcript);
    // The run's own file, read once: removed with its transcript (harness-run.js).
    try { fs.unlinkSync(lookupsFile(transcript)); } catch (_err) { /* none */ }
    return { mode: roleSkills || 'full', ...lookupStats({ calls: cycleCalls(output, (context && context.rolesFile) || null).calls, records, required, m3 }) };
  } catch (_err) {
    return null;
  }
}

/** The cycle's experience_lookup records, read once and their file removed (it lives beside the transcript). Never throws. */
function cycleExperienceLookups(transcript) {
  try {
    const { readExperienceLookups, lookupsFile } = require('./learning/experience-lookups');
    const records = readExperienceLookups(transcript);
    try { fs.unlinkSync(lookupsFile(transcript)); } catch (_err) { /* none */ }
    return records;
  } catch (_err) {
    return [];
  }
}

module.exports = { toolCalls, summarize, writeCycleLog, cycleLookups, cycleExperienceLookups, cycleClock, gateOrders, RISK_REDUCING };
