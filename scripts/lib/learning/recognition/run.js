'use strict';

/**
 * The recognition test over recorded runs (docs/TRAINING.md, "The recognition test"): for each frozen case, the runs'
 * head trade cycles on its day (each a candle: its bar close), the per-candle trace from the bars the run replayed, the
 * model's own read of the cycle, and the case's analysis. Read only: it reads run homes and a data file and returns a
 * document; it writes nothing and asks the model nothing. Nothing that decides reads it.
 *
 * The model's read of a cycle (readOf): its kind and side by the read audit's own rule (learning/cycle-kind.js kindOf,
 * the one home both read: a managed result is in the trade, an order the gate allowed is an entry, else a pass).
 * readOf is BROADER than the read audit: a cycle whose account holds an open position or a working order is in the
 * trade too (never a sit-out or an entry decision here; the read audit has the decision record for that). Its class
 * word and cites from the STATE record by equality (scorer.wordOf, citesOf), never from the line's text or prose. The
 * runs: cycle-kind.js replayDirs, one run home once (its cycle logs are the home's).
 *
 * The bars: the data file the run replayed (--bars SYMBOL=<file>, user-local; a 1m file gives the 1m lane the briefing
 * builds its 5m facts from), else the run home's own bars (trend-facts.js barsOf). The briefing's history is the run's
 * (autotrader.js recordedBars), with its round-number steps and blackouts, as trend-facts.attachFacts rebuilds it.
 *
 *   kindOf, replayDirs                                  learning/cycle-kind.js's (re-exported)
 *   readOf(cycle)                                       { kind, side, word, basis (its cites) }
 *   recognitionReport({ targets, barsFiles, tree, definitions, cases, casesSha256, fingerprint })
 *       -> { runs, casesSha256, definitions, coverage, cases (analyses, each with its run and the chop label beside the
 *          frozen one), summary, pass (hindsight: availableR only) }
 */


const path = require('path');
const TFX = require('../../train/trend-facts');
const { cyclesOf } = require('../../replay/trend-capture');
const { outcomeBarsFrom } = require('../../replay/labels');
const { readJson } = require('../../harness-run');
const { recordedBars } = require('../../autotrader');
const { tradingDayKey } = require('../../trading/clock');
const { kindOf, replayDirs } = require('../cycle-kind');
const RC = require('./config');
const T = require('./trace');
const A = require('./analyse');
const L = require('./label');
const S = require('./scorer');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const count = v => (Array.isArray(v) ? v.length : Number.isFinite(v) ? v : 0);

function readOf(cycle) {
  const k = kindOf({ decision: null, orders: isObj(cycle.summary) ? cycle.summary.orders : [], result: cycle.result });
  const acct = isObj(cycle.context) && isObj(cycle.context.account) ? cycle.context.account : null;
  const holding = acct && (count(acct.positions) > 0 || count(acct.workingOrders) > 0);
  const sr = isObj(cycle.stateRead) ? cycle.stateRead : null;
  return { kind: holding ? 'in-trade' : k.kind, side: holding ? null : k.side, word: S.wordOf(sr), basis: S.citesOf(sr) };
}

/** Each run home under the targets (once; its first replay run's config), with its trade cycles by day. */
function runsOf(targets) {
  const out = [];
  const homes = new Set();
  for (const t of targets) {
    for (const dir of replayDirs(t)) {
      const home = path.resolve(dir, '..', '..');
      if (homes.has(home)) continue;
      homes.add(home);
      const cfg = readJson(path.join(dir, 'autotrader.json'), {}) || {};
      const manifest = readJson(path.join(dir, 'manifest.json'), {}) || {};
      const byDay = new Map();
      for (const c of cyclesOf(home).filter(x => x.action === 'trade' && Number.isFinite(Date.parse(x.timing.barClose)))) {
        const day = tradingDayKey(new Date(Date.parse(c.timing.barClose) - 1));
        byDay.set(day, [...(byDay.get(day) || []), c]);
      }
      out.push({ dir, home, runId: manifest.runId || path.basename(dir), cfg, minutes: Number(cfg.timeframe) || null, symbol: Array.isArray(cfg.symbols) && cfg.symbols.length ? String(cfg.symbols[0]).toUpperCase() : null, byDay });
    }
  }
  return out;
}

/** The run's bars, briefing context and tracer, once a run. */
function tracerOf(run, { barsFiles, tree, definitions }) {
  if (run.tracer) return run;
  if (!run.minutes || !run.symbol) throw new Error(`${run.runId}: the run states no timeframe or symbol (autotrader.json)`);
  const file = isObj(barsFiles) ? barsFiles[run.symbol] : null;
  const bars = file ? outcomeBarsFrom(file, run.minutes) : TFX.barsOf(run.home, run.dir, run.symbol, run.minutes, {});
  let fine = null;
  if (run.minutes !== 1) {
    try { fine = file ? outcomeBarsFrom(file, 1) : TFX.barsOf(run.home, run.dir, run.symbol, 1, {}); } catch (_err) { fine = null; } // not 1m data: no 1m lane
  }
  const all = [...run.byDay.values()].flat();
  const inAttempt = all.some(c => isObj(c.context) && Array.isArray(c.context.attempts) && c.context.attempts.some(a => a && a.status === 'active'));
  const ctx = T.checkContext({ tree, root: run.symbol, inAttempt });
  const roundSteps = require('../../trading/round-numbers').loadRoundSteps({ FTH_HOME: run.home });
  const blackouts = require('../../trading/check-order').readBlackouts(path.join(run.home, 'blackouts', 'blackouts.json'));
  run.bars = bars;
  run.fine = fine && fine.length ? fine : null;
  run.tracer = T.tracer({ bars, fine: run.fine, root: run.symbol, minutes: run.minutes, count: recordedBars({ ...run.cfg, timeframe: run.minutes }), roundSteps, blackouts, ctx, thresholds: definitions.signals });
  return run;
}

/** The bars-only chop label recomputed on the run's base bars (the ATR warmed on every bar before the day), beside the frozen values. */
const labelOf = (run, c, definitions) => ({ frozen: c.label || null, recomputed: L.chopLabel(run.bars, { ...definitions.chopLabel, day: c.day }) });

function recognitionReport({ targets, barsFiles = {}, tree, definitions, cases, casesSha256, fingerprint }) {
  const runs = runsOf(targets);
  const analyses = [];
  for (const c of cases) {
    const holding = runs.filter(r => (r.byDay.get(c.day) || []).length);
    if (!holding.length) { analyses.push({ id: c.id, kind: c.kind, day: c.day, notInRuns: true, circular: c.circular, circularNote: c.circularNote }); continue; }
    const run = tracerOf(holding[0], { barsFiles, tree, definitions });
    const cycles = run.byDay.get(c.day).slice().sort((a, b) => Date.parse(a.timing.barClose) - Date.parse(b.timing.barClose));
    const candles = cycles.map(x => { const ms = Date.parse(x.timing.barClose); return { ms, trace: run.tracer(ms), read: readOf(x) }; });
    const cse = { ...c, startClose: RC.startCloseOf(c, run.minutes, definitions), endClose: RC.endCloseOf(c, run.minutes) };
    const a = A.analyse(cse, candles, { minutes: run.minutes });
    analyses.push({ ...a, day: c.day, run: run.runId, fineLane: Boolean(run.fine), alsoIn: holding.slice(1).map(r => r.runId), legCandles: c.legCandles, circular: c.circular, circularNote: c.circularNote, ...(c.kind === 'chop' ? { label: labelOf(run, c, definitions) } : {}) });
  }
  const scored = analyses.filter(a => !a.notInRuns);
  const cov = scored.reduce((m, a) => { for (const k of ['stated', 'unstated', 'invalid', 'absent', 'of']) m[k] += a.wordCoverage[k]; return m; }, { stated: 0, unstated: 0, invalid: 0, absent: 0, of: 0 });
  return {
    runs: runs.map(r => r.runId), casesSha256, definitions: fingerprint, coverage: cov,
    cases: analyses.map(({ _candles, _inLeg, ...a }) => a), summary: A.summarize(scored, { level: definitions.intervalLevel }),
    pass: cases.filter(c => c.kind === 'trend' && Number.isFinite(c.availableR)).map(c => ({ id: c.id, availableR: c.availableR })),
  };
}

module.exports = { kindOf, replayDirs, readOf, recognitionReport };
