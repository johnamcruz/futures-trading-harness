'use strict';

/**
 * A curated run's decisions weighted back to natural rates for the experience index (inverse-probability weighting).
 * A curated list picks its moments outcome-balanced (curated-lists.js: the standard's winners and losers kept level, a
 * pass share per list), so its decisions' win rate, mean R and MAE/MFE are the list's mix, not the market's. Each
 * decision stands for its moment's stratum, the moment's list and the standard's outcome (`outcome.result`: win, loss,
 * scratch, or the status of a moment the standard didn't trade):
 *
 *   weight(L, o) = (candidates of L with o / candidates of the run's frame) / (chosen of L with o / chosen of the frame)
 *
 * The frame is the lists the run stepped (its pinned list, or every list for the mix), so one list's weight is the
 * natural share of its outcome over its share as built, and the mix's also restores each list's natural share. Over
 * the chosen moments the weights average 1. The candidates' outcomes are the document's `coverage[L].candidateOutcomes`
 * (curated-lists.js coverageOf); a document built before it has none, and no weight is guessed: null.
 *
 * A decision's moment: the window (from, to] holding its bar's close (its bar plus the document's bar minutes, the
 * driver's rule on bar closes: curated-lists.js curatedPoints). None, or windows of two strata: null. A null weight
 * is counted, never rated (experience-index.js).
 *
 *   weigher(doc, list)                 { weightOf(decision), weights: { '<list>|<outcome>': w } }, or null without the counts
 *   weighCurated(lines, { home, docs })   a log's lines with `curated` and `weight` (null: none) when its run home pinned
 *                                      a curated list (docs: the lists documents given, matched by fingerprint); else as given
 */

const path = require('path');
const { LISTS, loadPinnedCurated } = require('./curated-lists');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const total = t => Object.values(t || {}).reduce((a, n) => a + (Number(n) || 0), 0);

function weigher(doc, list) {
  if (!isObj(doc) || !isObj(doc.lists) || !isObj(doc.coverage)) return null;
  const inMix = new Set(Array.isArray(doc.mix) ? doc.mix : []);
  const frame = list === 'mix' ? LISTS.filter(n => (doc.lists[n] || []).some(m => inMix.has(m.id))) : [list];
  if (!frame.length || frame.some(n => !isObj(doc.coverage[n]) || !isObj(doc.coverage[n].candidateOutcomes) || !isObj(doc.coverage[n].outcomes))) return null;
  const cands = frame.reduce((a, n) => a + total(doc.coverage[n].candidateOutcomes), 0);
  const chosen = frame.reduce((a, n) => a + total(doc.coverage[n].outcomes), 0);
  if (!(cands > 0 && chosen > 0)) return null;
  const weights = {};
  for (const n of frame) {
    for (const [o, k] of Object.entries(doc.coverage[n].outcomes)) {
      const c = Number(doc.coverage[n].candidateOutcomes[o]) || 0;
      if (k > 0) weights[`${n}|${o}`] = (c / cands) / (k / chosen);
    }
  }
  const step = (Number(doc.market && doc.market.minutes) || 0) * 60000; // the bar's minutes, in ms
  const windows = frame.flatMap(n => (doc.lists[n] || []).filter(m => m.window && (list !== 'mix' || inMix.has(m.id)))
    .map(m => ({ key: `${n}|${m.outcome && m.outcome.result}`, from: Date.parse(m.window.from), to: Date.parse(m.window.to) })));
  const weightOf = d => {
    const close = Date.parse((d && d.bar) || '') + step;
    if (!Number.isFinite(close) || !step) return null;
    const keys = [...new Set(windows.filter(w => close > w.from && close <= w.to).map(w => w.key))];
    return keys.length === 1 && Number.isFinite(weights[keys[0]]) ? weights[keys[0]] : null;
  };
  return { weightOf, weights };
}

function weighCurated(lines, { home, docs = [] }) {
  let pin;
  try { pin = loadPinnedCurated(path.resolve(home)); } catch (_err) { pin = { fingerprint: null, list: null }; }
  if (!pin) return lines;
  const doc = docs.find(x => x && x.fingerprint === pin.fingerprint) || null;
  const w = doc ? weigher(doc, pin.list) : null;
  return lines.map(d => ({ ...d, curated: true, weight: w ? w.weightOf(d) : null }));
}

module.exports = { weigher, weighCurated };
