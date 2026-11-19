'use strict';

/**
 * P1, the Part B-style read check of the MTF candidate lines (the mtf-entry skill), run with the model before any trading
 * replay: the probe asks a field-by-field report of the cycle's briefing; the scorer rebuilds each field from the cycle's
 * MTF record (trading/mtf-entry.js candidatesOf: the code that prints the lines, never their text) and grades the report
 * field by field. The bar: every field at or above BAR (95%) over the answers. Pure: no files, no model.
 *
 *   FIELDS                                 the report's fields, in order
 *   BAR                                    config/training.json mtfReadCheck.bar (0.95): each field's share must reach it
 *   probe()                                the question appended to the briefing
 *   expected(rec, mode, { price, at })   { FIELD: value } (strings; 'none' where the line prints none)
 *   grade(answer, expected)                { fields: { FIELD: { field, ok, got, want } } }: the last line given for a field is
 *                                          its answer; a field missing or hedged is wrong; numbers within their printed rounding
 *   summarize(grades)                      { n, fields: { FIELD: { right, n, share } }, failing, pass }
 */

const ME = require('../trading/mtf-entry');

const FIELDS = Object.freeze(['SIDE', 'READY', 'STAGE', 'EARLY', 'TRIGGER', 'TRIGGER_AGE', 'DRIFT_R', 'TURN', 'BOS_SINCE', 'IMPULSE_ATR', 'DISPLACED', 'CLEANNESS', 'RANK', 'DEPTH', 'STOP', 'PER_CONTRACT', 'WAITING', 'VOID', 'PULLBACK_DECIDED_BY']);
const BAR = require('../tunables').training().mtfReadCheck.bar; // config/training.json (the owner's 95%)
const NUMERIC = new Set(['BOS_SINCE', 'IMPULSE_ATR', 'DISPLACED', 'CLEANNESS', 'RANK', 'STOP', 'PER_CONTRACT', 'TRIGGER_AGE', 'DRIFT_R']);
const HEDGE = /\b(or|unclear|unknown|depends|maybe|either)\b/i;

function probe() {
  const ask = {
    SIDE: 'long or short (the 1h structure\'s side)', READY: 'the chosen candidate\'s model, or none (a waiting or void model is none)', STAGE: 'its stage word, or none',
    EARLY: 'yes or no for the chosen candidate; none without one', TRIGGER: '<frame> <CHoCH|CISD|BOS>, or none',
    TRIGGER_AGE: 'the chosen candidate\'s trigger age in minutes (0 when new this bar); none without a candidate',
    DRIFT_R: 'the chosen candidate\'s drift past the trigger in R (a number); none without a candidate', DEPTH: 'the chosen candidate\'s depth class (shallow, moderate, deep or breached); none without a candidate', TURN: 'fresh, old turn, no turn, or none', BOS_SINCE: 'the BOS count its context gives, or none',
    IMPULSE_ATR: 'the impulse in ATR, or none', DISPLACED: 'its displacement candles, or none', CLEANNESS: 'its cleanness, or none', RANK: 'its pullback number, or none',
    STOP: 'its structural stop price, or none', PER_CONTRACT: 'its dollars a contract all in, or none',
    WAITING: 'the waiting clause as printed, or none', VOID: 'yes if a candidate is void (stop traded, ran past, too old ...), else no', PULLBACK_DECIDED_BY: 'the frame whose line decides the pullback (15m or 3m)',
  };
  return ['Read the MTF lines of this briefing and report, reason first, then one line per field, exactly "FIELD: value":', ...FIELDS.map(f => `${f}: <${ask[f]}>`)].join('\n');
}

const str = x => (x === null || x === undefined ? 'none' : String(x));

function expected(rec, mode, { price = null, at = null } = {}) {
  const c = ME.candidatesOf(rec, mode, { at, price });
  const x = c.side1h ? c.chosen[c.side1h] : null;
  const mine = c.list.filter(y => y.side === c.side1h);
  const lines = ME.candidateLines(rec, mode, { price, sizing: rec && rec.sizing, at });
  const waiting = lines.find(l => l.startsWith('- MTF waiting: '));
  const per = x && Number.isFinite(price) ? ME.sizeHint({ stopPts: Math.abs(price - x.stop), ...(rec.sizing || {}) }).perContract : null;
  const t = x && x.turn;
  return {
    SIDE: str(c.side1h), READY: str(x && x.model), STAGE: str(x && x.stage), EARLY: x ? (x.early ? 'yes' : 'no') : 'none', TRIGGER: x ? `${x.trigger.frame} ${x.trigger.kind || 'break'}` : 'none',
    TRIGGER_AGE: str(x && x.age ? x.age.minAgo : null), DRIFT_R: str(x ? x.driftR : null),
    TURN: !t ? 'none' : t.choch ? (require('../trading/mtf-context').isFresh(t, x.turnSessions) ? 'fresh' : 'old turn') : 'no turn', BOS_SINCE: str(t ? t.bosCount : null), IMPULSE_ATR: str(x && x.impulse ? x.impulse.atr : null), DISPLACED: str(x && x.impulse ? x.impulse.displaced : null),
    CLEANNESS: str(x && x.impulse ? x.impulse.cleanness : null), RANK: str(x ? x.rank : null), DEPTH: str(x ? x.depthClass : null),
    STOP: str(x ? x.stop : null), PER_CONTRACT: str(per),
    WAITING: waiting ? waiting.slice('- MTF waiting: '.length).replace(/\.$/, '') : 'none', VOID: mine.some(y => y.withheld) ? 'yes' : 'no', PULLBACK_DECIDED_BY: '15m',
  };
}

// A value as compared: markup, a leading $ or #, a trailing period and a trailing parenthetical (the model's own gloss,
// "very deep (past 0.786)") dropped.
const clean = v => String(v).replace(/[`*_"]/g, '').replace(/^[$#]/, '').replace(/\.$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
// A number's own unit dropped (the line's: "0.35R", "3 min").
const asNum = v => { const n = Number(clean(v).replace(/[$,]/g, '').replace(/\s*(r|min|minutes?)$/, '')); return Number.isFinite(n) ? n : NaN; };

function grade(answer, exp) {
  const got = {};
  for (const line of String(answer || '').split('\n')) {
    const m = /^\s*[-*]?\s*([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && FIELDS.includes(m[1])) (got[m[1]] = got[m[1]] || []).push(m[2]);
  }
  const fields = {};
  for (const f of FIELDS) {
    // The last line given for a field is its answer (reason first: a "FIELD: ..." line inside the reasoning is not), as the
    // quiz grades its last answer line; the waiting clause may be copied with its "MTF waiting:" label.
    const vals = got[f] || [];
    const want = exp[f];
    const last = vals.length ? clean(vals[vals.length - 1]) : null;
    let one = last === null ? [] : [f === 'WAITING' ? last.replace(/^-?\s*mtf waiting:\s*/, '') : last];
    // A candidate whose depth is not printed ("depth not known"): "unknown" or "not known" says what the line says, and
    // reads as none (a post-hoc normalisation after the final Part B, the coordinator's ruling; DEPTH only).
    if (f === 'DEPTH' && want === 'none' && exp.READY && exp.READY !== 'none' && one.length && /^(unknown|not known)$/.test(one[0])) one = ['none'];
    // A free-text field (the waiting clause) is compared whole: its own words ("CHoCH or CISD") are no hedge.
    let ok = one.length === 1 && (f === 'WAITING' || !HEDGE.test(one[0]));
    if (ok) {
      if (NUMERIC.has(f) && want !== 'none') {
        const a = asNum(one[0]);
        const b = Number(want);
        const decimals = (String(want).split('.')[1] || '').length;
        ok = Number.isFinite(a) && a.toFixed(decimals) === b.toFixed(decimals);
      } else ok = one[0] === clean(want);
    }
    fields[f] = { field: f, ok, got: vals, want };
  }
  return { fields };
}

function summarize(grades) {
  const n = grades.length;
  const fields = {};
  for (const f of FIELDS) {
    const right = grades.filter(g => g.fields[f] && g.fields[f].ok).length;
    fields[f] = { right, n, share: n ? Math.round((right / n) * 1000) / 1000 : 0 };
  }
  const failing = FIELDS.filter(f => fields[f].share < BAR);
  return { n, fields, failing, pass: n > 0 && !failing.length };
}

module.exports = { FIELDS, BAR, probe, expected, grade, summarize };
