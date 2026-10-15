'use strict';

// A replay run's records as the verified-decision dataset reads them (scripts/lib/learning/decision-examples.js): the
// run dir (manifest, setup record, account states), each decision's cycle file (its prompt, an opencode transcript, its
// compose records) and the run's workspace/opencode.json (the roles' system prompts); and the scorecard records a
// score function returns for it.

const fs = require('fs');
const path = require('path');

const SYSTEM = { 'fth-head-trader': 'You are the head trader.\n', 'risk-manager': 'You are the risk manager.  \n' };
const DOCS = { harness: 'a'.repeat(64), skills: 'b'.repeat(64) };
// The setup record's code digest (scripts/) and the run's exit plan (its manifest's exit record).
const CODE = 'd'.repeat(64);
const { exitRecord, BRACKETS } = require('../../scripts/lib/learning/experience-log');
const EXIT = exitRecord(BRACKETS);

function transcript({ headText = [], tasks = [], calls = [] }) {
  let ts = 1791746657000;
  const ev = (type, part) => JSON.stringify({ type, timestamp: (ts += 10), sessionID: 'ses_1', part });
  const lines = [ev('step_start', { type: 'step-start' })];
  // Tool calls the head trader made before its tasks: { tool, input, output } (or error).
  for (const c of calls) {
    lines.push(ev('tool_use', { type: 'tool', tool: c.tool, callID: c.id || `t${ts}`, state: c.error ? { status: 'error', input: c.input, error: c.error } : { status: 'completed', input: c.input, output: c.output } }));
  }
  for (const t of tasks) {
    lines.push(ev('tool_use', { type: 'tool', tool: 'task', callID: `c${ts}`, state: { status: 'completed', input: { description: 'd', prompt: t.prompt, subagent_type: t.role }, output: `<task id="ses_c" state="completed">\n<task_result>\n${t.reply}\n</task_result>\n</task>` } }));
  }
  for (const text of headText) lines.push(ev('text', { type: 'text', text }));
  lines.push(ev('step_finish', { type: 'step-finish' }));
  return lines.join('\n');
}

/**
 * Writes a run under `home` and returns { runDir, records }. Each decision: { t, symbol?, kind ('take'|'pass'|'risk'),
 * action?, category?, expected?, record?, attempts? (compose records), prompt, headText?, tasks?, calls?, attempt?, gate?,
 * ran? (the store line's ran: default one ok trade cycle), interrupted? }. `exit`: the manifest's exit record (null:
 * none, a run before the record); `code`: the setup record's code digest.
 */
function writeRun(home, { runId = 'r1', start, end, decisions, states = null, documents = DOCS, stage = null, system = SYSTEM, code = CODE, exit = EXIT }) {
  const runDir = path.join(home, 'replay', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId, start, end, hash: `h-${runId}`, ...(exit ? { exit } : {}) }));
  fs.writeFileSync(path.join(runDir, 'setup.json'), JSON.stringify({ runId, documents, code, pinned: { stage } }));
  if (states) fs.writeFileSync(path.join(runDir, 'account-states.jsonl'), states.map(s => JSON.stringify({ kind: 'start', ...s })).join('\n'));
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(home, 'workspace', 'opencode.json'), JSON.stringify({ agent: Object.fromEntries(Object.entries(system).map(([k, p]) => [k, { prompt: p }])) }));
  const records = decisions.map((d, i) => {
    const day = d.day || d.t.slice(0, 10);
    const rel = `logs/cycles/${day}/${String(i).padStart(6, '0')}-trade.json`;
    fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
    const composed = d.composed || (d.record ? [{ symbol: d.symbol || 'MNQ', ...d.record }] : []);
    fs.writeFileSync(path.join(home, rel), JSON.stringify({ prompt: d.prompt, transcript: transcript(d), composed }));
    // The replay store's line for the decision time (replay/store.js): its cycles' health.
    fs.appendFileSync(path.join(runDir, `${day}.jsonl`), `${JSON.stringify({ v: 1, t: d.t, day, kind: 'trade', ran: d.ran || [{ action: 'trade', ok: true, timedOut: false }], step: { code: 0, timedOut: false }, ...(d.interrupted ? { interrupted: true } : {}) })}\n`);
    const action = d.action || (d.kind === 'take' ? 'long' : d.kind === 'pass' ? 'none' : 'hold');
    return {
      t: d.t, day, symbol: d.symbol || 'MNQ', decision: d.kind === 'risk' ? 'in-trade' : 'flat', category: d.category || 'right', agrees: true,
      expected: d.expected || { decision: d.kind === 'take' ? 'take' : 'no-trade', decidedBy: d.kind === 'take' ? 'take' : 'no setup' },
      actual: { action, setup: 'trade_lifecycle', size: 1, gate: d.gate || null, result: 'x' },
      facts: { attempt: d.attempt || null }, provenance: { cycleFile: rel },
      outcome: { R: d.R ?? null },
    };
  });
  return { runDir, records, score: () => records };
}

module.exports = { SYSTEM, DOCS, CODE, EXIT, transcript, writeRun };
