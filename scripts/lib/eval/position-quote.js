'use strict';

/**
 * The field-reading score of an answer about an open trade (the Position line, trading/position-read.js): the R numbers
 * the answer states for the trade, each attributed to the field the words before it name (now, MFE or best, MAE or
 * worst, giveback, the stop or the lock), and whether it equals the line's value (to the cent of an R). The broker
 * snapshot's own R (its other risk basis) is flagged when the answer states it. For the behaviour check's field-reading
 * bar and the paired morning runs. Pure.
 *
 *   positionQuote(answer, read, { snapshot })   { quoted: [{ field, value, ok }], n, ok, share (null with none), snapshot }
 *     read: the Position read's numbers { nowR, mfeR, maeR, give, workR, atStopGive, lockR }; snapshot: R values of the
 *     broker snapshot's that must not appear
 */

const FIELDS = [
  ['give', /\b(?:give ?back|gives back|gave back|given back|giving back)\b/gi],
  ['mfe', /\b(?:mfe|best|peak)\b/gi],
  ['mae', /\b(?:mae|worst)\b/gi],
  ['stop', /\b(?:stop|lock)\b/gi],
  ['now', /\b(?:now|currently|at the close)\b/gi],
];
const R_NUMBER = /([-+]?\d+(?:\.\d+)?)\s?R\b/g;
const cents = x => Math.round(x * 100);
const near = (a, b) => cents(a) === cents(b); // to the cent of an R, as the line prints it

function wantOf(field, read) {
  if (field === 'give') return [read.give, read.atStopGive];
  if (field === 'mfe') return [read.mfeR];
  if (field === 'mae') return [read.maeR];
  if (field === 'stop') return [read.workR, read.lockR];
  return [read.nowR];
}

// "1R" as the unit's definition ("1R = 9.5 pts", "(9.5 pts = 1R)", "risks 1R"): no quoted value.
const DEFINES = /(?:=\s*|\brisks?\s+)$/;
const DEFINED = /^\s*(?:=|\()/;

function positionQuote(answer, read = {}, { snapshot = [] } = {}) {
  const text = String(answer || '').replace(/\u2212/g, '-'); // a typographic minus is a minus
  const quoted = [];
  for (const m of text.matchAll(R_NUMBER)) {
    // The field the clause before it names: the last field word since the clause began (a ';', '.', newline or ',').
    const before = text.slice(0, m.index);
    const clause = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n'), before.lastIndexOf(', '), before.search(/\.\s[^.]*$/)) + 1);
    // "1.84R off the best" (the line's stop clause): the stop's distance from the best, a giveback, never the best.
    const words = clause.replace(/\boff the best\b/gi, 'gives back');
    let field = /^\s+off the best\b/i.test(text.slice(m.index + m[0].length)) ? 'give' : null;
    let at = field ? Infinity : -1;
    for (const [name, re] of FIELDS) for (const w of words.matchAll(re)) if (w.index > at) { at = w.index; field = name; }
    if (!field) continue;
    if (/^[-+]?1$/.test(m[1]) && !/^[-+]/.test(m[1]) && (DEFINES.test(before) || DEFINED.test(text.slice(m.index + m[0].length)))) continue;
    const value = Number(m[1]);
    const want = wantOf(field, read).filter(Number.isFinite);
    quoted.push({ field, value, ok: want.some(x => near(x, value)) });
  }
  const values = [...text.matchAll(R_NUMBER)].map(m => Number(m[1]));
  const ok = quoted.filter(x => x.ok).length;
  return { quoted, n: quoted.length, ok, share: quoted.length ? Math.round((ok / quoted.length) * 1000) / 1000 : null, snapshot: (snapshot || []).filter(s => values.some(v => near(Math.abs(v), Math.abs(s)))) };
}

module.exports = { positionQuote };
