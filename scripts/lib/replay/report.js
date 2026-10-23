'use strict';

/**
 * A replay run's report, month by month (by trading day): decision times,
 * cycles, trades, win rate, mean R, expectancy, how often the trader stood
 * aside, the gate's real refusals by check, and MAE/MFE when the broker
 * reports them.
 *
 * Trades: the round trips the replay broker reports on closing fills
 * (`roundTrip`: net, r, maeR, mfeR, reason, as backtester-mcp sends them);
 * from a broker without them, each closing fill (profitAndLoss net of its
 * fees), its R from the opening fill's entry (the gateway's recorded stop
 * ticks, store.js) when there is one. A trade wins when its net is above zero.
 * Stand-aside: trade cycles whose CYCLE RESULT is no-trade. Refusals by
 * replay-clock are the replay's own plumbing, counted apart from the trader's.
 * A setup-focused practice run (learning/setup-moments.js): its moments, cycles, skipped bars and the time saved
 * (practice-report.js), and that it isn't comparable bar for bar with a full-day run.
 * Setup timing (cycle-timing.js timingReport, from each cycle's `timing`): bar close to decision and to order (median,
 * p90), overruns (decided after the next bar closed), setups decided in time, entered in time or missed, each role's
 * median time, and entries lost to expiry (the gate refused them: their compose record's time had run out); all bar
 * cycles, setup bars and quiet bars. Shown when a cycle carries timing. In a replay with its latency charged (the replay
 * config's `latency`) the latency is the run's own, as live; with a pinned replay clock it is projected (the clock at
 * the decision time plus the run's own time; fills at the bar).
 *
 * A continuous combine run (replay/combine-run.js): each attempt's start, sessions, outcome, profit, lowest cushion, worst
 * day and trades, the totals and the promotion gate's numbers, labelled practice (combineReport, from the run's folder).
 *
 *   summarize(days, { runDir })   { months: [row], total: row, timing, combine? } (runDir: the run's folder, for a combine run)
 *   toMarkdown(summary, manifest)   report.md
 *   toText(summary)            the terminal table
 */

const { timingReport } = require('../cycle-timing');
const { practiceSummary, practiceMarkdown, practiceText } = require('./practice-report');

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Every trade in a decision time's fills; `open` carries each contract's last opening fill across lines. */
function tradesOf(fills, open) {
  const out = [];
  for (const f of Array.isArray(fills) ? fills : []) {
    if (f.voided) continue;
    const rt = f.roundTrip && typeof f.roundTrip === 'object' ? f.roundTrip : null;
    if (rt) {
      out.push({ net: num(rt.net) ?? 0, r: num(rt.r), maeR: num(rt.maeR), mfeR: num(rt.mfeR), reason: rt.reason || null });
      continue;
    }
    if (f.profitAndLoss === null || f.profitAndLoss === undefined) {
      open.set(f.contractId, f);
      continue;
    }
    const entry = open.get(f.contractId);
    const e = entry && entry.entry;
    const risk = e && e.stopTicks && e.tickValue ? e.stopTicks * e.tickValue * Number(f.size || 1) : null;
    const pnl = Number(f.profitAndLoss);
    out.push({ net: pnl - Number(f.fees || 0), r: risk ? pnl / risk : null, maeR: num(f.maeR), mfeR: num(f.mfeR), reason: null });
  }
  return out;
}

function blankRow(key) {
  return { key, points: 0, cycles: 0, tradeCycles: 0, standAside: 0, failed: 0, trades: [], refusals: {}, replayClock: 0 };
}

function finish(row) {
  const t = row.trades;
  const wins = t.filter(x => x.net > 0).length;
  const rs = t.map(x => x.r).filter(x => x !== null);
  const maes = t.map(x => x.maeR).filter(x => x !== null);
  const mfes = t.map(x => x.mfeR).filter(x => x !== null);
  return {
    key: row.key, points: row.points, cycles: row.cycles, tradeCycles: row.tradeCycles, failed: row.failed,
    standAsideRate: row.tradeCycles ? row.standAside / row.tradeCycles : null,
    trades: t.length, wins, winRate: t.length ? wins / t.length : null,
    net: t.reduce((a, x) => a + x.net, 0), expectancy: mean(t.map(x => x.net)),
    meanR: mean(rs), tradesWithR: rs.length, meanMaeR: mean(maes), meanMfeR: mean(mfes),
    refusals: row.refusals, replayClockRefusals: row.replayClock,
  };
}

function summarize(days, { runDir = null } = {}) {
  const months = new Map();
  const total = blankRow('total');
  const open = new Map();
  const ran = [];
  for (const day of Object.keys(days).sort()) {
    const key = day.slice(0, 7);
    if (!months.has(key)) months.set(key, blankRow(key));
    const rows = [months.get(key), total];
    for (const rec of days[day]) {
      const trades = tradesOf(rec.trades, open);
      for (const row of rows) {
        row.points += 1;
        // A bar's pass that read no bar and ran no cycle while logging errors (driver.js counts it too).
        if (rec.kind === 'trade' && !(rec.ran || []).length && (rec.errors || []).length && (rec.bars || []).some(b => !b.lastBarT)) row.failed += 1;
        // A time's failed attempts before it ran (store.js foldAttempts): their cycles ran and failed; the time is one point.
        for (const c of (rec.retries || []).flatMap(a => a.ran || [])) {
          row.cycles += 1;
          if (!c.ok) row.failed += 1;
        }
        for (const c of rec.ran || []) {
          if (row === total) ran.push(c);
          row.cycles += 1;
          if (!c.ok) row.failed += 1;
          if (c.action === 'trade' || c.action === 'manage') {
            row.tradeCycles += 1;
            if (/^CYCLE RESULT:\s*no-trade\b/i.test(String(c.result || ''))) row.standAside += 1;
          }
        }
        for (const r of rec.refusals || []) {
          for (const check of r.checks.length ? r.checks : ['(none named)']) {
            if (check === 'replay-clock') row.replayClock += 1;
            else row.refusals[check] = (row.refusals[check] || 0) + 1;
          }
        }
        row.trades.push(...trades);
      }
    }
  }
  const practice = practiceSummary(days);
  const combine = runDir ? combineOf(runDir, days) : null;
  return { months: [...months.values()].map(finish), total: finish(total), timing: timingReport(ran), ...(practice ? { practice } : {}), ...(combine ? { combine } : {}) };
}

/** A combine run's attempts (combine-run.js combineReport), labelled with the run's learning role; null for any other run. */
function combineOf(runDir, days) {
  const path = require('path');
  const gate = require('../learning/run-gate').readLearningRun(path.resolve(runDir, '..', '..'));
  return require('./combine-run').combineReport(runDir, { days, role: gate ? gate.role || null : null });
}

const pct = x => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const fix = (x, d = 2) => (x === null ? '-' : x.toFixed(d));
const usd = x => (x === null ? '-' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const refusalText = r => Object.entries(r.refusals).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

const HEAD = ['month', 'times', 'cycles', 'failed', 'stand-aside', 'trades', 'win rate', 'mean R (n)', 'expectancy', 'net', 'MAE R', 'MFE R', 'refusals by check', 'replay-clock'];
const cells = r => [r.key, r.points, r.cycles, r.failed, pct(r.standAsideRate), r.trades, pct(r.winRate), `${fix(r.meanR)} (${r.tradesWithR})`, usd(r.expectancy), usd(r.net), fix(r.meanMaeR), fix(r.meanMfeR), refusalText(r), r.replayClockRefusals];

const secs = ms => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
const TIMING_HEAD = ['bars', 'cycles', 'close to decision p50 / p90', 'close to order p50 / p90 (n)', 'overran', 'decided in time', 'entered in time', 'missed (why)', 'no next bar', 'lost to expiry'];
const missedText = g => Object.entries(g.missedBy).map(([k, n]) => `${k} ${n}`).join(', ');
const timingCells = (name, g) => [name, g.cycles, `${secs(g.decision.median)} / ${secs(g.decision.p90)}`, `${secs(g.order.median)} / ${secs(g.order.p90)} (${g.order.n})`, g.overran, g.decidedInTime, g.enteredInTime, `${g.missed}${g.missed ? ` (${missedText(g)})` : ''}`, g.noDeadline, g.expired || 0];
const timingRows = t => [['all', t.all], ['setup bars', t.setup], ['quiet bars', t.quiet]].map(([n, g]) => timingCells(n, g).map(String));
const roleText = t => Object.entries(t.all.roleMedianMs).map(([r, ms]) => `${r} ${secs(ms)}`).join(', ') || 'none timed';
const hasTiming = summary => Boolean(summary.timing && summary.timing.all.cycles);
// Every replay cycle ran on a running replay clock (latency charged), or none did (projected); a mix says so.
const clockKind = a => (!a.replay ? null : a.charged === a.replay ? 'charged' : a.charged ? 'mixed' : 'projected');
const CLOCK_TEXT = {
  charged: 'In this replay the latency is CHARGED, as live: the replay clock ran with the wall clock from each decision time, so orders went, and compose records expired, at the bar close plus the cycle\'s own time.',
  projected: 'In this replay it is the PROJECTED live latency: the replay clock is pinned at the decision time, the run\'s own time is added, and the replay broker fills at the bar.',
  mixed: 'This replay has cycles with the latency charged (the replay clock ran with the wall clock) and cycles with it projected (the clock pinned at the decision time): the run changed its latency setting.',
};

/** The setup-timing block, as Markdown lines (none without timed cycles). */
function timingMarkdown(summary) {
  if (!hasTiming(summary)) return [];
  const t = summary.timing;
  return [
    '## Setup timing', '',
    `| ${TIMING_HEAD.join(' | ')} |`, `| ${TIMING_HEAD.map(() => '---').join(' | ')} |`, ...timingRows(t).map(r => `| ${r.join(' | ')} |`), '',
    `Role median: ${roleText(t)}.`, '',
    `Latency on the cycle's clock.${clockKind(t.all) ? ` ${CLOCK_TEXT[clockKind(t.all)]}` : ''} Overran: decided after the next bar closed. A setup (a candidate on the bar) is decided in time when an entry order or the decision line came before its bar was superseded, entered in time when the gate allowed an entry before then. No next bar: the next bar falls outside the session, so neither is counted. Lost to expiry: entry orders the gate refused because their compose record had expired (with the latency charged: lost to it).`, '',
  ];
}

function table(head, rows) {
  const all = [head, ...rows];
  const width = head.map((_, i) => Math.max(...all.map(r => String(r[i]).length)));
  return `${all.map(r => r.map((c, i) => String(c).padEnd(width[i])).join('  ').trimEnd()).join('\n')}\n`;
}

function toMarkdown(summary, manifest = {}) {
  const rows = [...summary.months, summary.total].map(r => `| ${cells(r).join(' | ')} |`);
  return [
    `# Replay ${manifest.runId || ''}`.trim(), '',
    `- Broker: ${manifest.broker || '?'}; window ${manifest.start || '?'} to ${manifest.end || '?'}`,
    `- Harness: ${manifest.harness || '?'}${manifest.model ? ` (model ${manifest.model})` : ''}; config hash ${String(manifest.hash || '').slice(0, 12)}`,
    `- Days done: ${(manifest.daysDone || []).length}; last decision time ${manifest.lastT || 'none'}`, '',
    `| ${HEAD.join(' | ')} |`, `| ${HEAD.map(() => '---').join(' | ')} |`, ...rows, '',
    'Stand-aside: trade cycles whose result was no-trade. Trades: closed round trips (net of fees); R from the initial stop. Refusals: the order gate\'s, by check; replay-clock refusals are the replay\'s own plumbing, not the trader\'s.', '',
    ...timingMarkdown(summary),
    ...practiceMarkdown(summary.practice || null),
    ...(summary.combine ? ['## Continuous combine', '', ...require('./combine-run').reportLines(summary.combine).map(l => `- ${l.trim()}`), ''] : []),
  ].join('\n');
}

function toText(summary) {
  const combine = summary.combine ? `${require('./combine-run').reportLines(summary.combine).join('\n')}\n` : '';
  const main = table(HEAD, [...summary.months, summary.total].map(r => cells(r).map(String))) + practiceText(summary.practice || null) + combine;
  if (!hasTiming(summary)) return main;
  const kind = clockKind(summary.timing.all);
  const note = kind === 'charged' ? ' (replay: latency charged, as live)' : kind === 'mixed' ? ' (replay: latency charged on some cycles, projected on others)' : kind ? ' (replay: projected live latency)' : '';
  return `${main}\nsetup timing${note}\n${table(TIMING_HEAD, timingRows(summary.timing))}role median: ${roleText(summary.timing)}\n`;
}

module.exports = { summarize, tradesOf, toMarkdown, toText };
