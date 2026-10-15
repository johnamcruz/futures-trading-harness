'use strict';

// A replay run's records as the verified-decision dataset reads them (scripts/lib/learning/decision-examples.js): the
// run dir (manifest, setup record, account states), each decision's cycle file (its prompt, an opencode transcript, its
// compose records) and the run's workspace/opencode.json (the roles' system prompts); and the scorecard records a
// score function returns for it.

const fs = require('fs');
const path = require('path');

const SYSTEM = { 'fth-head-trader': 'You are the head trader.\n', 'risk-manager': 'You are the risk manager.  \n' };
const DOCS = { harness: 'a'.repeat(64), skills: 'b'.repeat(64) };

function transcript({ headText = [], tasks = [] }) {
  let ts = 1791746657000;
  const ev = (type, part) => JSON.stringify({ type, timestamp: (ts += 10), sessionID: 'ses_1', part });
  const lines = [ev('step_start', { type: 'step-start' })];
  for (const t of tasks) {
    lines.push(ev('tool_use', { type: 'tool', tool: 'task', callID: `c${ts}`, state: { status: 'completed', input: { description: 'd', prompt: t.prompt, subagent_type: t.role }, output: `<task id="ses_c" state="completed">\n<task_result>\n${t.reply}\n</task_result>\n</task>` } }));
  }
  for (const text of headText) lines.push(ev('text', { type: 'text', text }));
  lines.push(ev('step_finish', { type: 'step-finish' }));
  return lines.join('\n');
}

/**
 * Writes a run under `home` and returns { runDir, records }. Each decision: { t, symbol?, kind ('take'|'pass'|'risk'),
 * action?, category?, expected?, record?, attempts? (compose records), prompt, headText?, tasks?, attempt?, gate? }.
 */
function writeRun(home, { runId = 'r1', start, end, decisions, states = null, documents = DOCS, stage = null, system = SYSTEM }) {
  const runDir = path.join(home, 'replay', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId, start, end, hash: `h-${runId}` }));
  fs.writeFileSync(path.join(runDir, 'setup.json'), JSON.stringify({ runId, documents, pinned: { stage } }));
  if (states) fs.writeFileSync(path.join(runDir, 'account-states.jsonl'), states.map(s => JSON.stringify({ kind: 'start', ...s })).join('\n'));
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(home, 'workspace', 'opencode.json'), JSON.stringify({ agent: Object.fromEntries(Object.entries(system).map(([k, p]) => [k, { prompt: p }])) }));
  const records = decisions.map((d, i) => {
    const day = d.day || d.t.slice(0, 10);
    const rel = `logs/cycles/${day}/${String(i).padStart(6, '0')}-trade.json`;
    fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
    const composed = d.composed || (d.record ? [{ symbol: d.symbol || 'MNQ', ...d.record }] : []);
    fs.writeFileSync(path.join(home, rel), JSON.stringify({ prompt: d.prompt, transcript: transcript(d), composed }));
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

module.exports = { SYSTEM, DOCS, transcript, writeRun };
