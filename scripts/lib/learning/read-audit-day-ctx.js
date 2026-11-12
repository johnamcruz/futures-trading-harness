'use strict';

/**
 * The read audit's day and ctx report (docs/TRAINING.md, "The read audit"): the head trader's own day class and structure
 * context (its STATE line's `day` and `ctx` words, trading/state-read.js) against labels computed from the bars after the
 * fact (read-audit.js dayCtxColumn: the day label is the Day so far read of the whole session window, the structure
 * label the first touch of one unit in the read's own side's way). A measurement only: nothing that decides reads it, the
 * labels are never in a prompt, and the read audit's classes are unchanged by it.
 *
 *   written      decisions, with a model read, with a day word, with a ctx word
 *   day          byLabel { trend|chop|mixed: { n, right, words } } (a day word on a labelled day; `early` names no class,
 *                so it is never right), byHour { <ET hour>: { <label>: { n, right } } }, copy (the day word against the
 *                Day so far word at the bar: n, same; apart when that word was too early and when it was a read),
 *                departures (the day word not the Day so far word: right, wrong vs the label, unscored when the word is
 *                early or the day has no label, so right + wrong + unscored = n; and the Day so far word itself right
 *                on the scored ones)
 *   ctx          byWord { <word>: { n, right, wrong, unscorable } }, right, scored, sameAsCoded (the labels' context word)
 *   preEntryBD   entries on a chop-labelled day while the read's own day word said chop, mixed or early
 *
 *   summarizeDayCtx(rows)   from read-audit.js rows (their dayCtx column)
 *   renderDayCtx(s)         its text
 */

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function summarizeDayCtx(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => isObj(r) && r.kind !== 'in-trade' && isObj(r.dayCtx));
  const modelRead = r => isObj(r.read) && r.read.status === 'read' && r.source !== 'coded';
  const withDay = list.filter(r => r.dayCtx.day.read);
  const withCtx = list.filter(r => r.dayCtx.ctx.read);
  const byLabel = {};
  const byHour = {};
  for (const r of withDay.filter(x => x.dayCtx.day.label)) {
    const { read, label, result, hour } = r.dayCtx.day;
    const b = byLabel[label] = byLabel[label] || { n: 0, right: 0, words: {} };
    b.n += 1;
    b.words[read] = (b.words[read] || 0) + 1;
    byHour[hour] = byHour[hour] || {};
    const h = byHour[hour][label] = byHour[hour][label] || { n: 0, right: 0 };
    h.n += 1;
    if (result === 'right') { b.right += 1; h.right += 1; }
  }
  const copied = withDay.filter(r => r.dayCtx.day.copy !== null);
  const copyOf = rs => ({ n: rs.length, same: rs.filter(r => r.dayCtx.day.copy).length });
  const dep = copied.filter(r => !r.dayCtx.day.copy);
  // Scored only on a class word against a day label (early names no class; no label, no score): the rest are unscored.
  const depScored = dep.filter(r => r.dayCtx.day.result === 'right' || r.dayCtx.day.result === 'wrong');
  const byWord = {};
  for (const r of withCtx) {
    const c = r.dayCtx.ctx;
    const w = byWord[c.read] = byWord[c.read] || { n: 0, right: 0, wrong: 0, unscorable: 0 };
    w.n += 1;
    w[c.result || 'unscorable'] += 1;
  }
  const scored = withCtx.filter(r => r.dayCtx.ctx.result);
  const bd = list.filter(r => r.dayCtx.preEntryBD === true);
  return {
    written: { decisions: list.length, withRead: list.filter(modelRead).length, day: withDay.length, ctx: withCtx.length },
    day: {
      byLabel, byHour,
      copy: { ...copyOf(copied), soFarEarly: copyOf(copied.filter(r => r.dayCtx.day.soFar === 'early')), soFarRead: copyOf(copied.filter(r => r.dayCtx.day.soFar !== 'early')) },
      departures: { n: dep.length, right: depScored.filter(r => r.dayCtx.day.result === 'right').length, wrong: depScored.filter(r => r.dayCtx.day.result === 'wrong').length,
        unscored: dep.length - depScored.length, soFarRight: depScored.filter(r => r.dayCtx.day.soFar === r.dayCtx.day.label).length },
    },
    ctx: { byWord, right: scored.filter(r => r.dayCtx.ctx.result === 'right').length, scored: scored.length, sameAsCoded: withCtx.filter(r => r.dayCtx.ctx.read === r.dayCtx.ctx.coded).length },
    preEntryBD: { n: bd.length, entries: bd.map(r => ({ day: r.day, t: r.t, side: r.side, read: r.dayCtx.day.read, R: isObj(r.outcome) ? r.outcome.R ?? null : null })) },
  };
}

const of = (a, n) => `${a} of ${n}`;
const tally = o => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

function renderDayCtx(s) {
  const w = s.written;
  const out = [
    `Day and ctx (the model's own STATE words, scored after the fact from the bars; beside the classes, never in them): day word on ${of(w.day, w.decisions)} decisions, ctx word on ${of(w.ctx, w.decisions)} (a model read on ${w.withRead})`,
    '  day read, its own words, vs the day label (the Day so far read of the whole session window; early names no class):',
  ];
  for (const [label, b] of Object.entries(s.day.byLabel)) out.push(`    ${label}-labelled days: its word ${label} on ${of(b.right, b.n)} (words: ${tally(b.words)})`);
  out.push(`    by hour (ET): ${Object.entries(s.day.byHour).sort().map(([h, m]) => `${h} ${Object.entries(m).map(([l, x]) => `${l} ${x.right}/${x.n}`).join(', ')}`).join('; ') || 'none'}`);
  const c = s.day.copy;
  const d = s.day.departures;
  out.push(`  copies the Day so far word on ${of(c.same, c.n)} (that word too early: ${of(c.soFarEarly.same, c.soFarEarly.n)}; a read: ${of(c.soFarRead.same, c.soFarRead.n)}); departures ${d.n}: right ${d.right}, wrong ${d.wrong}, unscored ${d.unscored} (early, or no day label), the Day so far word right on ${d.soFarRight} of the ${d.right + d.wrong} scored`);
  out.push(`  ctx vs the first touch in its own side's way (one unit, the read audit's window): right ${of(s.ctx.right, s.ctx.scored)}; by word ${Object.entries(s.ctx.byWord).map(([k, x]) => `${k} n ${x.n} right ${x.right} wrong ${x.wrong} unscorable ${x.unscorable}`).join('; ') || 'none'}; the labels' context word on ${s.ctx.sameAsCoded}`);
  out.push(`  pre-entry B/D entries: ${s.preEntryBD.n} (an entry on a chop-labelled day while its own day word said chop, mixed or early)${s.preEntryBD.entries.map(e => `; ${e.day} ${e.t} ${e.side || '-'} ${e.read} R ${e.R ?? '-'}`).join('')}`);
  return out.join('\n');
}

module.exports = { summarizeDayCtx, renderDayCtx };
