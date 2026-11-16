'use strict';

/**
 * The model's stop line on a managed cycle (manage-position): one line starting `STOP <price|hold>: <reason>`, every
 * cycle a position is open. Only a line that starts with STOP decides (the phase-2 parser's line-start rule: a STOP
 * quoted in prose never does); the last such line wins. The reason's first word is classified against the closed list
 * the skill teaches; anything else is `other`. A missing or unreadable line is read as hold and reported as a process
 * failure by the caller: it never blocks the cycle and never moves a stop (the model's modify_order does that, gated).
 *
 *   REASONS                     the reasons the skill teaches
 *   STOP_START                  a line that starts with STOP
 *   parseStopLine(text)         { stated: true, hold, stop (price or null), reason, text } | { stated: false, why }
 */

const REASONS = Object.freeze(['protected-swing', 'choch-against', 'displacement-against', 'weakening', 'hold']);
// A line start may carry markdown (a bullet, a quote, bold); STOP itself is upper case (prose's "stop" never counts).
/** A line that starts with STOP (markdown allowed before it): the lines a caller hands parseStopLine. */
const STOP_START = /^[ \t]*(?:[-*>][ \t]*)*(?:\*\*)?STOP\b/;
const LINE = /^[ \t]*(?:[-*>][ \t]*)*(?:\*\*)?STOP[ \t]+((?:[Hh][Oo][Ll][Dd])|\$?\d[\d,]*(?:\.\d+)?)[ \t]*:[ \t]*(\S.*?)[ \t]*(?:\*\*)?[ \t]*$/gm;

function parseStopLine(text) {
  const lines = [...String(text || '').matchAll(LINE)];
  if (!lines.length) return { stated: false, why: /^[ \t]*(?:[-*>][ \t]*)*(?:\*\*)?STOP\b/m.test(String(text || '')) ? 'a STOP line that is not "STOP <price|hold>: <reason>"' : 'no STOP line' };
  const [, what, why] = lines[lines.length - 1];
  const hold = what.toLowerCase() === 'hold';
  const stop = hold ? null : Number(what.replace(/[$,]/g, ''));
  const first = why.toLowerCase().split(/[\s:;,.]+/)[0];
  return { stated: true, hold, stop, reason: REASONS.includes(first) ? first : 'other', text: why };
}

module.exports = { REASONS, STOP_START, parseStopLine };
