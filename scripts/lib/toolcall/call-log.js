'use strict';

/**
 * The tool-call layer's call log (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "One call log"): what the rules keep between a
 * session's calls, one state per rule and session.
 *
 * In memory for a harness whose rules run in-process (the opencode plugin, one per run): `createCallLog()`.
 *
 * In a file for one whose hooks start a process per call (Claude Code), the file is append-only: each process appends
 * one line, the call and when (appendEvent), and rebuilds the rules' state by replaying the lines before it through the
 * same rules (replayEvents). No process rewrites the file, so parallel hook processes (parallel tool calls) never lose
 * one another's update, and there is no lock to take over or leak. A line keeps only what the rules read: every string
 * longer than its digest becomes `sha256:<hex>` (compact), in the line and in the call the live process judges alike,
 * so a big result or argument (a bars reply, a file write) never makes a line large enough to tear or the replay slow,
 * and the rules (which read short fields and compare results for equality) see the same values live and replayed.
 *
 *   createCallLog()                      { state(rule, session), save() }
 *   readEvents(file)                     the file's events, oldest first ([] when none or unreadable lines skipped)
 *   appendEvent(file, event)             one line: { event: 'pre' | 'post', call, result, at }
 *   replayEvents(pipeline, events, clock)  each event through `pipeline` at its own time (clock.at), outcomes dropped
 *   compact(value)                       a copy with every long string replaced by its digest
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const digest = t => `sha256:${crypto.createHash('sha256').update(t).digest('hex')}`;
const DIGEST_LENGTH = digest('').length;
function compact(v) {
  if (typeof v === 'string') return v.length > DIGEST_LENGTH ? digest(v) : v;
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)]));
  return v;
}

function createCallLog() {
  const all = {};
  return {
    state(rule, session) {
      const key = `${rule}\u0000${String(session || '')}`;
      if (!all[key] || typeof all[key] !== 'object') all[key] = {};
      return all[key];
    },
    save() {},
  };
}

function readEvents(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_err) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && (e.event === 'pre' || e.event === 'post') && e.call && typeof e.call.tool === 'string') out.push(e);
    } catch (_err) { /* a torn or foreign line: skipped */ }
  }
  return out;
}

function appendEvent(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function replayEvents(pipeline, events, clock) {
  for (const e of events) {
    clock.at = e.at;
    const call = { ...e.call, args: e.call.args && typeof e.call.args === 'object' ? JSON.parse(JSON.stringify(e.call.args)) : e.call.args };
    if (e.event === 'pre') pipeline.before(call);
    else pipeline.after(call, e.result || {});
  }
}

module.exports = { createCallLog, readEvents, appendEvent, replayEvents, compact };
