'use strict';

/**
 * The read audit over every decision, by where the read came from (read-audit.js `coded`): the model's own STATE line
 * (`model`) or, when it left it out, the briefing's labels restated by code (`coded`, trading/coded-read.js). A
 * measurement only; nothing that decides reads it. The two are never merged: a coded read is the labels restated, so it can
 * never be a misread, and a figure says which source it rests on.
 *
 *   adherence      the STATE line on how many of the run's trade cycles (an open trade's too): the model's share
 *   fourOutcomes   the audit's classes as the owner reads them: misread, acted wrong, market turned, acted right; passes
 *                  apart; `other` the rest (a small loss, a breakeven)
 *   bySource       per source: the classes, and the entries' net R with and without the best trade
 *   byEntryClass   the entries by the coded entry class A-D (coded-read.js: no signal, chop outnumbers trend, trend only, both)
 *   byTrendSignal  the entries by each trend signal they had (T1, T2, T3, T7: coded-read.js), an entry under every one it had
 *   dayClass       every decision by the coded day class (trend, chop, mixed, unknown)
 * An entry's cell: n (every entry), knownR (those with a recorded trade R), netR and meanR over the known only (never a
 * missing R as 0), best (the one best trade), withoutBestR (the net without it).
 *
 *   sourceReport(rows)        the report from read-audit.js rows (auditDecision with coded: true)
 *   renderSourceReport(s)     its text
 */

const { SIGNALS } = require('../trading/coded-read');
const { round4 } = require('../prop/stats');

const fin = Number.isFinite;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const sum = xs => xs.reduce((a, x) => a + x, 0);

function entriesCell(rows) {
  const entries = rows.filter(r => r.kind === 'entry');
  const known = entries.map(r => (isObj(r.outcome) ? r.outcome.R : null)).filter(fin);
  const net = known.length ? sum(known) : null;
  const best = known.length ? Math.max(...known) : null;
  return { n: entries.length, knownR: known.length, netR: net === null ? null : round4(net), meanR: net === null ? null : round4(net / known.length), best, withoutBestR: net === null ? null : round4(net - best) };
}

const tally = (rows, keyOf) => rows.reduce((m, r) => { const k = keyOf(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
const OUTCOME_OF = { misread: 'misread', 'acted-wrong': 'acted-wrong', 'market-turned': 'market-turned', 'acted-right': 'acted-right', passed: 'passed' };

function sourceReport(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(isObj);
  const withSource = s => list.filter(r => r.source === s);
  const model = withSource('model');
  const coded = withSource('coded');
  const sorted = list.filter(r => r.class);
  const entries = list.filter(r => r.kind === 'entry');
  const four = { misread: 0, 'acted-wrong': 0, 'market-turned': 0, 'acted-right': 0, passed: 0, other: 0 };
  for (const r of sorted) four[OUTCOME_OF[r.class] || 'other'] += 1;
  const bySource = Object.fromEntries([['model', model], ['coded', coded]].map(([k, rs]) => [k, { n: rs.length, classes: tally(rs, r => r.class), entries: entriesCell(rs) }]));
  const codedOf = r => (isObj(r.coded) ? r.coded : null);
  const byEntryClass = Object.fromEntries(['A', 'B', 'C', 'D'].map(c => [c, entriesCell(entries.filter(r => codedOf(r) && codedOf(r).cls === c))]));
  const trendKeys = SIGNALS.filter(s => s.kind === 'trend').map(s => s.key);
  const byTrendSignal = Object.fromEntries(trendKeys.map(k => [k, entriesCell(entries.filter(r => codedOf(r) && codedOf(r).trend.includes(k)))]));
  const dayClass = { trend: 0, chop: 0, mixed: 0, unknown: 0 };
  for (const r of list.filter(x => x.kind !== 'in-trade')) dayClass[codedOf(r) ? codedOf(r).day : 'unknown'] += 1;
  return {
    adherence: { decisions: list.length, model: model.length, coded: coded.length, none: list.length - model.length - coded.length, rate: list.length ? round4(model.length / list.length) : null },
    fourOutcomes: four, bySource, all: { entries: entriesCell(list), classes: tally(sorted, r => r.class) }, byEntryClass, byTrendSignal, dayClass,
  };
}

const rr = x => (x === null || x === undefined ? '-' : `${x > 0 ? '+' : ''}${x}R`);
const cell = c => `n ${c.n}, R known ${c.knownR}, net ${rr(c.netR)}, mean ${rr(c.meanR)}, best ${rr(c.best)}, without the best trade ${rr(c.withoutBestR)}`;
const pct = x => (x === null ? '-' : `${Math.round(x * 100)}%`);

function renderSourceReport(s) {
  const a = s.adherence;
  const out = [
    `By source of the read: STATE line on ${a.model} of ${a.decisions} decisions (${pct(a.rate)}); read from the labels by code (coded) on ${a.coded}; none on ${a.none}`,
    '  coded = the briefing\'s labels restated (coded-read.js): never a misread, so its misread count is 0 by construction; the model\'s own line is the only read that can be wrong.',
    `  four outcomes: ${Object.entries(s.fourOutcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  ];
  for (const k of ['model', 'coded']) {
    const b = s.bySource[k];
    out.push(`  ${k}: n ${b.n}; classes ${Object.entries(b.classes).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`, `      entries ${cell(b.entries)}`);
  }
  out.push(`  all entries ${cell(s.all.entries)}`, `Day class (coded): ${Object.entries(s.dayClass).map(([k, n]) => `${k} ${n}`).join(', ')}`, 'Entries by the coded entry class (A no signal, B chop outnumbers trend, C trend only, D both):');
  for (const [k, c] of Object.entries(s.byEntryClass)) out.push(`  entry class ${k}: ${cell(c)}`);
  out.push('Entries by the trend signal they had (T1 Day so far directional, T2 15m frame, T3 3m regime, T7 IB day type):');
  for (const [k, c] of Object.entries(s.byTrendSignal)) out.push(`  ${k}: ${cell(c)}`);
  return out.join('\n');
}

module.exports = { sourceReport, renderSourceReport };
