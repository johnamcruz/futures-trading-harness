'use strict';

/**
 * The model's stop line on a managed cycle (manage-position): one line starting `STOP <price|hold>: <reason>`, every
 * cycle a position is open. Only a line that starts with STOP decides (the phase-2 parser's line-start rule: a STOP
 * quoted in prose never does); the last such line wins. The reason's first word is classified against the closed list
 * the skill teaches; anything else is `other`. A missing or unreadable line is read as hold and reported as a process
 * failure by the caller: it never blocks the cycle and never moves a stop (the model's modify_order does that, gated).
 *
 *   REASONS                     the reasons the skill teaches
 *   parseStopLine(text)         { stated: true, hold, stop (price or null), reason, text } | { stated: false, why }
 */

const REASONS = Object.freeze(['protected-swing', 'choch-against', 'displacement-against', 'weakening', 'hold']);
const LINE = /^[ \t]*STOP[ \t]+(hold|\d[\d,]*(?:\.\d+)?)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim;

function parseStopLine(text) {
  const lines = [...String(text || '').matchAll(LINE)];
  if (!lines.length) return { stated: false, why: /^[ \t]*STOP\b/im.test(String(text || '')) ? 'a STOP line that is not "STOP <price|hold>: <reason>"' : 'no STOP line' };
  const [, what, why] = lines[lines.length - 1];
  const hold = what.toLowerCase() === 'hold';
  const stop = hold ? null : Number(what.replace(/,/g, ''));
  const first = why.toLowerCase().split(/[\s:;,.]+/)[0];
  return { stated: true, hold, stop, reason: REASONS.includes(first) ? first : 'other', text: why };
}

module.exports = { REASONS, parseStopLine };
