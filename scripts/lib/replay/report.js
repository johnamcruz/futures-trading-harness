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
 *
 *   summarize(days)            { months: [row], total: row }
 *   toMarkdown(summary, manifest)   report.md
 *   toText(summary)            the terminal table
 */

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

function summarize(days) {
  const months = new Map();
  const total = blankRow('total');
  const open = new Map();
  for (const day of Object.keys(days).sort()) {
    const key = day.slice(0, 7);
    if (!months.has(key)) months.set(key, blankRow(key));
    const rows = [months.get(key), total];
    for (const rec of days[day]) {
      const trades = tradesOf(rec.trades, open);
      for (const row of rows) {
        row.points += 1;
        for (const c of rec.ran || []) {
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
  return { months: [...months.values()].map(finish), total: finish(total) };
}

const pct = x => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const fix = (x, d = 2) => (x === null ? '-' : x.toFixed(d));
const usd = x => (x === null ? '-' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const refusalText = r => Object.entries(r.refusals).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

const HEAD = ['month', 'times', 'cycles', 'failed', 'stand-aside', 'trades', 'win rate', 'mean R (n)', 'expectancy', 'net', 'MAE R', 'MFE R', 'refusals by check', 'replay-clock'];
const cells = r => [r.key, r.points, r.cycles, r.failed, pct(r.standAsideRate), r.trades, pct(r.winRate), `${fix(r.meanR)} (${r.tradesWithR})`, usd(r.expectancy), usd(r.net), fix(r.meanMaeR), fix(r.meanMfeR), refusalText(r), r.replayClockRefusals];

function toMarkdown(summary, manifest = {}) {
  const rows = [...summary.months, summary.total].map(r => `| ${cells(r).join(' | ')} |`);
  return [
    `# Replay ${manifest.runId || ''}`.trim(), '',
    `- Broker: ${manifest.broker || '?'}; window ${manifest.start || '?'} to ${manifest.end || '?'}`,
    `- Harness: ${manifest.harness || '?'}${manifest.model ? ` (model ${manifest.model})` : ''}; config hash ${String(manifest.hash || '').slice(0, 12)}`,
    `- Days done: ${(manifest.daysDone || []).length}; last decision time ${manifest.lastT || 'none'}`, '',
    `| ${HEAD.join(' | ')} |`, `| ${HEAD.map(() => '---').join(' | ')} |`, ...rows, '',
    'Stand-aside: trade cycles whose result was no-trade. Trades: closed round trips (net of fees); R from the initial stop. Refusals: the order gate\'s, by check; replay-clock refusals are the replay\'s own plumbing, not the trader\'s.', '',
  ].join('\n');
}

function toText(summary) {
  const all = [HEAD, ...[...summary.months, summary.total].map(r => cells(r).map(String))];
  const width = HEAD.map((_, i) => Math.max(...all.map(r => r[i].length)));
  return `${all.map(r => r.map((c, i) => c.padEnd(width[i])).join('  ').trimEnd()).join('\n')}\n`;
}

module.exports = { summarize, tradesOf, toMarkdown, toText };
