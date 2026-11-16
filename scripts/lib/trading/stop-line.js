'use strict';

/**
 * The model's stop line on a managed cycle (manage-position): one line `STOP <price|hold>: <reason>`, on its own line,
 * every cycle a position is open. A line that starts with STOP decides (the phase-2 parser's line-start rule: a STOP
 * quoted in prose never does); the last such line wins. A model that wrote it at the end of its PLAN's `9 Manage:` line
 * instead is read too (`inline`): the last `STOP <price|hold>: <reason>` tail of a line that starts `9 Manage:` that begins
 * a clause (right after the label, a ";" or a "."), and only when no line-start line parses. Nothing else is recovered ("**9 Manage:**", "9. Manage:", a comma after STOP hold,
 * prose, the CYCLE RESULT line). An indented line after an arrow ("  -> STOP ...", a skill's example) is never a line
 * start; the model's own "-> STOP" at column 0 is.
 * The reason's first word is classified against the closed list the skill teaches; anything else is `other`. A missing
 * or unreadable line is read as hold and reported as a process failure by the caller: it never blocks the cycle and
 * never moves a stop (the model's modify_order does that, gated).
 *
 *   REASONS                     the reasons the skill teaches
 *   STOP_START                  a line that starts with STOP
 *   stopLines(text)             [{ text, inline }]: the STOP-led strings, the inline ones first (see above)
 *   parseStopLine(text)         { stated: true, hold, stop (price or null), reason, text, inline } | { stated: false, why }
 */

const REASONS = Object.freeze(['protected-swing', 'choch-against', 'displacement-against', 'weakening', 'hold']);
// A line start may carry markdown (a bullet, a quote, bold), never an arrow ("->": a quoted example); STOP itself is
// upper case (prose's "stop" never counts).
// "->" counts only at column 0 (a model's own line); an indented "  -> STOP" is a quoted example (the skills' form).
const PREFIX = String.raw`(?:->[ \t]*|[ \t]*(?:(?:-(?!>)|[*>])[ \t]*)*)(?:\*\*)?`;
const WHAT = String.raw`((?:[Hh][Oo][Ll][Dd])|\$?\d[\d,]*(?:\.\d+)?)`;
/** A line that starts with STOP (markdown allowed before it): the lines a caller hands parseStopLine. */
const STOP_START = new RegExp(`^${PREFIX}STOP\\b`);
const LINE = new RegExp(`^${PREFIX}STOP[ \\t]+${WHAT}[ \\t]*:[ \\t]*(\\S.*?)[ \\t]*(?:\\*\\*)?[ \\t]*$`);
const MANAGE = /^[ \t]*9 Manage:/;
// An inline STOP only at a clause start of the line: right after the label, a ";" or a "." ("I would STOP ..." never).
const INLINE = new RegExp(`(?<=(?:^[ \\t]*9 Manage:|[;.])[ \\t]*)STOP[ \\t]+${WHAT}[ \\t]*:[ \\t]*\\S`, 'g');

function stopLines(text) {
  const inline = [];
  const start = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (STOP_START.test(line)) { start.push({ text: line, inline: false }); continue; }
    if (!MANAGE.test(line)) continue;
    const all = [...line.matchAll(INLINE)];
    if (all.length) inline.push({ text: line.slice(all[all.length - 1].index).trim(), inline: true });
  }
  return [...inline, ...start];
}

function parseStopLine(text) {
  const xs = stopLines(text);
  const read = xs.map(x => ({ ...x, m: LINE.exec(x.text) })).filter(x => x.m);
  const pick = [...read].reverse().find(x => !x.inline) || read[read.length - 1];
  if (!pick) return { stated: false, why: xs.some(x => !x.inline) ? 'a STOP line that is not "STOP <price|hold>: <reason>"' : 'no STOP line' };
  const [, what, why] = pick.m;
  const hold = what.toLowerCase() === 'hold';
  const stop = hold ? null : Number(what.replace(/[$,]/g, ''));
  const first = why.toLowerCase().split(/[\s:;,.]+/)[0];
  return { stated: true, hold, stop, reason: REASONS.includes(first) ? first : 'other', text: why, inline: pick.inline };
}

module.exports = { REASONS, STOP_START, stopLines, parseStopLine };
