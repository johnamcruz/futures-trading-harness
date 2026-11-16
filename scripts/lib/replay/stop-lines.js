'use strict';

/**
 * A run's STOP lines (manage-position: one `STOP <price|hold>: <reason>` line every managed cycle; runner.js records
 * each as a `stop_line` event, one per open trade a managed cycle; trading/stop-line.js parses it): how many, how many stated it (and of
 * them read from the end of the PLAN's `9 Manage:` line, `inline`), how many are missing (read as hold: a process
 * failure), and an alarm when the missing share is above the one threshold (config/replay.json
 * scorecard.maxMissingStopShare: the same 2% the PR's keep rule uses). A report, never a refusal.
 *
 *   stopLineSummary(events, { maxMissingShare })   { managed, stated, inline, missing, share, alarm, maxMissingShare } | null
 *   stopLinesOf(home)                              the summary of a run home's logs/events-*.jsonl, or null with none
 *   stopLinesLine(summary)                         one line for the report, or null
 */

const fs = require('fs');
const path = require('path');

const r3 = x => Math.round(x * 1000) / 1000;

function stopLineSummary(events, { maxMissingShare = require('../tunables').replay().scorecard.maxMissingStopShare } = {}) {
  const lines = (events || []).filter(e => e && e.kind === 'stop_line');
  if (!lines.length) return null;
  const stated = lines.filter(e => e.stated === true);
  const missing = lines.length - stated.length;
  const share = r3(missing / lines.length);
  return { managed: lines.length, stated: stated.length, inline: stated.filter(e => e.inline === true).length, missing, share, alarm: missing / lines.length > maxMissingShare, maxMissingShare };
}

function stopLinesOf(home) {
  const dir = path.join(home, 'logs');
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^events-.*\.jsonl$/.test(f)).sort(); } catch (_err) { return null; }
  const events = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('"stop_line"')) continue;
      try { events.push(JSON.parse(l)); } catch (_err) { /* a torn line: not counted */ }
    }
  }
  return stopLineSummary(events);
}

const pct = x => `${Math.round(x * 1000) / 10}%`;

function stopLinesLine(s) {
  if (!s) return null;
  return `STOP lines: ${s.managed} managed (one per open trade a cycle), ${s.stated} stated (${s.inline} read from the 9 Manage: line), ${s.missing} missing (${pct(s.share)})${s.alarm ? `: ALARM, above ${pct(s.maxMissingShare)} of them` : ''}.`;
}

module.exports = { stopLineSummary, stopLinesOf, stopLinesLine };
