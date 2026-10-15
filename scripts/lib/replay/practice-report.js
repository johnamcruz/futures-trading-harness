'use strict';

/**
 * A setup-focused practice run's counts for the replay report (learning/setup-moments.js; runner.js `practiced` writes
 * one practice_<why> event per bar it judged, which the store line's `events` carries): the bar decision times, the
 * setup moments found, the quiet sample, the bars managed (something open), the bars skipped (no cycle, the clock
 * advanced), the cycles run, and the time saved estimated as the skipped bars times the median duration of the run's
 * own trade cycles. Null for a run with no practice event (every bar ran, as live).
 *
 *   practiceSummary(days)        { bars, moments, quiet, managed, unavailable, skipped, cycles, medianCycleMs, savedMs } | null
 *   practiceMarkdown(p)          lines (none for null)
 *   practiceText(p)              one line ('' for null)
 */

const WHY = ['moment', 'quiet', 'manage', 'unavailable', 'none'];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The practice choice of one store line: the strongest one any symbol's bar got (a cycle for one runs the pass's). */
function choiceOf(rec) {
  const ev = new Set(rec.events || []);
  return WHY.find(w => ev.has(`practice_${w}`)) || null;
}

function practiceSummary(days) {
  const out = { bars: 0, moments: 0, quiet: 0, managed: 0, unavailable: 0, skipped: 0, cycles: 0, medianCycleMs: null, savedMs: null };
  const durations = [];
  let seen = false;
  for (const day of Object.keys(days || {}).sort()) {
    for (const rec of days[day] || []) {
      if (rec.kind !== 'trade') continue;
      for (const c of rec.cycles || []) if ((c.action === 'trade' || c.action === 'manage') && Number.isFinite(c.durationMs)) durations.push(c.durationMs);
      out.bars += 1;
      out.cycles += (rec.ran || []).filter(c => c.action === 'trade' || c.action === 'manage').length;
      const why = choiceOf(rec);
      if (!why) continue;
      seen = true;
      if (why === 'moment') out.moments += 1;
      else if (why === 'quiet') out.quiet += 1;
      else if (why === 'manage') out.managed += 1;
      else if (why === 'unavailable') out.unavailable += 1;
      else if (!(rec.ran || []).length) out.skipped += 1;
    }
  }
  if (!seen) return null;
  out.medianCycleMs = median(durations);
  out.savedMs = out.medianCycleMs === null ? null : out.skipped * out.medianCycleMs;
  return out;
}

const hours = ms => (ms === null ? 'unknown (no timed cycle)' : `${(ms / 3600000).toFixed(1)} h`);
const share = (k, n) => (n ? `${((k / n) * 100).toFixed(0)}%` : '-');

function practiceMarkdown(p) {
  if (!p) return [];
  return [
    '## Setup-focused practice', '',
    `- Bar decision times: ${p.bars}; cycles run: ${p.cycles}; bars skipped (no cycle, the clock advanced): ${p.skipped} (${share(p.skipped, p.bars)})`,
    `- Setup moments found: ${p.moments}; quiet sample: ${p.quiet}; managed (something open): ${p.managed}; setup candle unavailable (ran): ${p.unavailable}`,
    `- Estimated time saved: ${hours(p.savedMs)} (skipped bars x the median trade cycle, ${p.medianCycleMs === null ? '-' : `${(p.medianCycleMs / 1000).toFixed(0)} s`})`, '',
    'A setup-focused run is practice: its stand-aside rate, timing and per-day counts are not comparable bar for bar with a full-day run (a sealed evaluation runs every bar, as live).', '',
  ];
}

function practiceText(p) {
  if (!p) return '';
  return `setup-focused practice: ${p.bars} bars, ${p.cycles} cycles, ${p.skipped} skipped; ${p.moments} moments, ${p.quiet} quiet, ${p.managed} managed; saved about ${hours(p.savedMs)}\n`;
}

module.exports = { practiceSummary, practiceMarkdown, practiceText, choiceOf };
