'use strict';

/**
 * The gamma line: the one line the code computes from the user's local gamma source and prints in the cycle prompt, the
 * only thing the `gex-regime` skill reads. Recorded-only context: nothing here votes, sizes, gates or exits, and no gate,
 * risk, sizing, entry or exit code reads the source (only the runner's prompt and the briefing's flag do).
 *
 * The source is a directory (FTH_GAMMA_DIR, the user's own config, never committed, no default) of per-day files
 * `<YYYY-MM-DD>.json`: { day, asOf, instruments: { <root>: { net, gross, flip, callWall, putWall } } }. The levels are
 * in the instrument's points, net and gross plain numbers, asOf the prior trading day. flip is optional (omitted: the
 * line says `flip none`); every other field is required and finite, the levels above 0, gross above 0, |net| <= gross. The root is the cycle symbol's
 * mini (MNQ -> NQ, MES -> ES: contracts.js familyOf).
 *
 * The word is the code's: net < 0 and |net| / gross >= the cutoff (config/analysis.json gammaLine.unclearBelow):
 * negative; net > 0 and >= the cutoff: positive; below it: unclear. Anything missing or off prints NO line (never
 * "unknown"): an unset or missing dir, an unreadable or malformed file, a day that is not the cycle's New York date, an
 * asOf that is not before it (a look-ahead guard) or more than gammaLine.maxAsOfGapDays days before it, an invalid
 * field (see above), a root with no contract spec. The line ends with a pointer to the skill (POINTER).
 *
 *   gammaFor({ dir, symbol, now, cutoff })     { word, line } or null
 *   gammaLines({ dir, symbols, now, cutoff })  the prompt's line (one per symbol with a source; prefixed with the symbol
 *                                              when several), or null
 *   wordFor(inst, cutoff)                      { word, ratio } or null
 *   etDate(now)                                the New York calendar date, YYYY-MM-DD
 */

const fs = require('fs');
const path = require('path');
const { familyOf, tickOf, levelOnTick } = require('./contracts');
const { MARKET_TZ } = require('./clock');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WORDS = { negative: 'negative (soft)', positive: 'positive (soft)', unclear: 'unclear' };
// The pointer the line carries itself (the skill is read from it, for every harness the gate cannot enforce it on).
const POINTER = 'Read gex-regime before using it.';
const num = x => typeof x === 'number' && Number.isFinite(x);
const level = x => num(x) && x > 0;
const isDate = s => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const gapDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const tunables = () => require('../tunables').analysis().gammaLine;

const etDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** { word, ratio } for a valid instrument entry, else null. flip is optional (absent: null); every other field is required. */
function wordFor(inst, cutoff = tunables().unclearBelow) {
  if (!inst || typeof inst !== 'object') return null;
  if (!num(inst.net) || !num(inst.gross) || !(inst.gross > 0) || Math.abs(inst.net) > inst.gross) return null;
  if (!level(inst.callWall) || !level(inst.putWall)) return null;
  if (inst.flip !== undefined && inst.flip !== null && !level(inst.flip)) return null;
  const ratio = Math.abs(inst.net) / inst.gross;
  const word = inst.net === 0 || ratio < cutoff ? 'unclear' : inst.net < 0 ? 'negative' : 'positive';
  return { word, ratio };
}

function readDay(dir, date) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch (_err) { return null; }
}

function gammaFor({ dir, symbol, now, cutoff, maxGap } = {}) {
  const d = String(dir || '').trim();
  if (!d || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const date = etDate(now);
  const doc = readDay(d, date);
  if (!doc || doc.day !== date || !isDate(doc.asOf) || !(doc.asOf < date)) return null;
  // Not older than the tunable's days (a stale file is no line); the look-ahead guard above is the other side.
  if (gapDays(doc.asOf, date) > (maxGap === undefined ? tunables().maxAsOfGapDays : maxGap)) return null;
  const root = String(symbol || '').split(':')[0].toUpperCase();
  const fam = familyOf(root);
  const key = fam ? fam.mini : root;
  // The contract's own tick (contracts.js): a root with no spec prints no line (a level can't be put on its tick).
  const tick = tickOf(symbol);
  if (!(tick > 0)) return null;
  const instruments = doc.instruments && typeof doc.instruments === 'object' ? doc.instruments : null;
  const inst = instruments && Object.prototype.hasOwnProperty.call(instruments, key) ? instruments[key] : null;
  const w = wordFor(inst, cutoff);
  if (!w) return null;
  const lv = x => String(levelOnTick(x, tick));
  const flip = inst.flip === undefined || inst.flip === null ? 'none' : lv(inst.flip);
  const line = `Gamma (code, as of prior close ${doc.asOf}): ${WORDS[w.word]}; net/gross ${w.ratio.toFixed(2)}; flip ${flip}; call wall ${lv(inst.callWall)}; put wall ${lv(inst.putWall)}. ${POINTER}`;
  return { word: w.word, line };
}

function gammaLines({ dir, symbols, now, cutoff, maxGap } = {}) {
  const list = [...new Set((symbols || []).map(String))];
  const got = list.map(symbol => ({ symbol, g: gammaFor({ dir, symbol, now, cutoff, maxGap }) })).filter(x => x.g);
  if (!got.length) return null;
  return got.map(x => (list.length > 1 ? `${x.symbol}: ${x.g.line}` : x.g.line)).join(' ');
}

module.exports = { gammaFor, gammaLines, wordFor, etDate, POINTER };
