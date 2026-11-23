'use strict';

/**
 * The gamma line: the one line the code computes from the user's local gamma source and prints in the cycle prompt, the
 * only thing the `gex-regime` skill reads. Recorded-only context: nothing here votes, sizes, gates or exits, and no gate,
 * risk, sizing, entry or exit code reads the source (only the runner's prompt and the briefing's flag do).
 *
 * The source is a directory (FTH_GAMMA_DIR, the user's own config, never committed, no default) of per-day files
 * `<YYYY-MM-DD>.json`: { day, asOf, instruments: { <root>: { net, gross, flip, callWall, putWall } } }. The levels are
 * in the instrument's points, net and gross plain numbers, asOf the prior trading day. The root is the cycle symbol's
 * mini (MNQ -> NQ, MES -> ES: contracts.js familyOf).
 *
 * The word is the code's: net < 0 and |net| / gross >= the cutoff (config/analysis.json gammaLine.unclearBelow):
 * negative; net > 0 and >= the cutoff: positive; below it: unclear. Anything missing or off prints NO line (never
 * "unknown"): an unset or missing dir, an unreadable or malformed file, a day that is not the cycle's New York date, an
 * asOf that is not before it (a look-ahead guard), a non-finite field, a gross that is not above 0.
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
const FIELDS = ['net', 'gross', 'flip', 'callWall', 'putWall'];
const WORDS = { negative: 'negative (soft)', positive: 'positive (soft)', unclear: 'unclear' };
const num = x => typeof x === 'number' && Number.isFinite(x);
const isDate = s => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

const etDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function wordFor(inst, cutoff = require('../tunables').analysis().gammaLine.unclearBelow) {
  if (!inst || typeof inst !== 'object' || !FIELDS.every(k => num(inst[k])) || !(inst.gross > 0)) return null;
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

function gammaFor({ dir, symbol, now, cutoff } = {}) {
  const d = String(dir || '').trim();
  if (!d || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const date = etDate(now);
  const doc = readDay(d, date);
  if (!doc || doc.day !== date || !isDate(doc.asOf) || !(doc.asOf < date)) return null;
  const root = String(symbol || '').split(':')[0].toUpperCase();
  const fam = familyOf(root);
  const key = fam ? fam.mini : root;
  const instruments = doc.instruments && typeof doc.instruments === 'object' ? doc.instruments : null;
  const inst = instruments && Object.prototype.hasOwnProperty.call(instruments, key) ? instruments[key] : null;
  const w = wordFor(inst, cutoff);
  if (!w) return null;
  const tick = tickOf(symbol);
  const lv = x => String(levelOnTick(x, tick));
  const line = `Gamma (code, as of prior close ${doc.asOf}): ${WORDS[w.word]}; net/gross ${w.ratio.toFixed(2)}; flip ${lv(inst.flip)}; call wall ${lv(inst.callWall)}; put wall ${lv(inst.putWall)}.`;
  return { word: w.word, line };
}

function gammaLines({ dir, symbols, now, cutoff } = {}) {
  const list = [...new Set((symbols || []).map(String))];
  const got = list.map(symbol => ({ symbol, g: gammaFor({ dir, symbol, now, cutoff }) })).filter(x => x.g);
  if (!got.length) return null;
  return got.map(x => (list.length > 1 ? `${x.symbol}: ${x.g.line}` : x.g.line)).join(' ');
}

module.exports = { gammaFor, gammaLines, wordFor, etDate };
