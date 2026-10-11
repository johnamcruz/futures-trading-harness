'use strict';

/**
 * The label dataset (the reasoning-trader design's stage 2, "Training"): the
 * teacher's labelled decisions (replay/labels.js) as rows the student policy
 * learns from. Each row is the student's observation at the label's decision
 * time, built by the code live trading and the challenge env use (rl/live.js
 * setupObservation and positionObservation over rl/observation.js), and the
 * teacher's decision mapped to the student's action space. What came after
 * the decision (the outcome, the counterfactual) is attached as targets,
 * never as an input.
 *
 * Read (all local): each run's labels.jsonl (in its run dir or the labeler's
 * --out), and from the run dir and its run home (<runDir>/../..): the day
 * files (fills), autotrader.json (timeframe, bars), the scans log (what fired,
 * with stops), the cycle files (the open trade the teacher saw), the bars.
 *
 * The observation at a label's decision time t, as live builds it then:
 *   bars     the runner's window: the last `bars` (autotrader.json, else
 *            autotrader.historyBars) bars closed at or before t, from the data
 *            the run replayed (--bars) or the run home; fewer: excluded.
 *   setup    the policy strategy's pick on that bar, as the live screen picks
 *            it: the first of its strategies, in its order, that fired with a
 *            stop distance (the scan logged by t); its stop, confluence and
 *            full size (combine.contractPlan) as live sizes it.
 *   account  the policy strategy's account profile as an attempt started on
 *            the run's first day, driven by the run's own round trips closed
 *            by t (net of fees), through prop-state.js stateFrom (as live).
 *   trade    in a trade: the open trade the cycle's context showed (entry,
 *            initial risk, setup, size, when it opened); its peak and trough R
 *            and bars held from the bars since it opened, as the runner counts.
 *
 * Modes (actions):
 *   student  the design's action space. Flat: 0 none, then long and short at
 *            each stop multiple (labels.js STOP_ATR_MULTIPLES of ATR(20)) and
 *            size step (SIZE_STEPS of the labeler's --budget):
 *            id = 1 + side x 24 + multiple x 4 + step (side 0 long, 1 short),
 *            1..48; in a trade: 49 hold, 50 tighten, 51 exit.
 *   env      today's challenge env (challenge-env.js ACTIONS): at the policy's
 *            setup 0 skip, 1 half, 2 full; in a trade past the ratchet 0
 *            hold, 1 close. The teacher's none is a skip; an entry on the
 *            pick's strategy and side is half or full by its size in micros
 *            against the policy's own half and full plans (the nearer); other
 *            entries, a tighten, a trade before the ratchet, and a flat bar
 *            with no pick have no env action and are excluded.
 *
 * Kept: a label the teacher decided (flat or in-trade) that the labeler
 * marked cloneable (clone.ok), and not a refused intent unless
 * includeRefused. Everything else is excluded and counted by reason.
 *
 *   buildDataset(inputs, { strategy, account, mode, includeRefused, barsFiles })   { header, rows, summary }
 *   writeDataset(file, built, { root })   writes the JSONL (header line, then rows) and <file>.summary.json
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { readRun, readLines } = require('../replay/store');
const labels = require('../replay/labels');
const { observationFields, observationVersion, buildObservation } = require('./observation');
const live = require('./live');
const { ACTIONS: ENV_ACTIONS, MASKS: ENV_MASKS } = require('./challenge-env');
const combine = require('../trading/combine');
const { exitPlan } = require('../trading/strategies');
const { parseStandardName } = require('../broker/translator');
const { familyRoot, familyOf } = require('../trading/contracts');
const { timeframeMs } = require('../trading/evaluator');
const { tradingDayKey } = require('../trading/clock');
const { historyBars } = require('../autotrader');
const { FILL_GRACE_MS } = require('../runner');
const { expandHome } = require('../paths');

const FORMAT = 'fth-label-dataset';
const VERSION = 1;
const LABELS_VERSION = 1; // the labels.jsonl version this reads (labels.js VERSION)
const { STOP_ATR_MULTIPLES: MULTIPLES, SIZE_STEPS: STEPS } = labels;
const SIDES = ['long', 'short'];
const FLAT_N = 1 + SIDES.length * MULTIPLES.length * STEPS.length;
const POSITION_ACTIONS = ['hold', 'tighten', 'exit'];

/** Each mode's action names (by id), kinds, and masks (by kind). */
const STUDENT = (() => {
  const flat = ['none', ...SIDES.flatMap(s => MULTIPLES.flatMap(m => STEPS.map(z => `${s}:${m}atr:${z}`)))];
  const actions = [...flat, ...POSITION_ACTIONS];
  return { actions, masks: { flat: actions.map((_, k) => (k < FLAT_N ? 1 : 0)), position: actions.map((_, k) => (k >= FLAT_N ? 1 : 0)) } };
})();
const ENV = { actions: ENV_ACTIONS, masks: ENV_MASKS };
const MODES = ['student', 'env'];

/** A flat entry's student action id, or null when its stop or size isn't on the grid. */
function studentEntryId(side, multiple, step) {
  const s = SIDES.indexOf(side);
  const m = MULTIPLES.indexOf(multiple);
  const z = STEPS.indexOf(step);
  return s < 0 || m < 0 || z < 0 ? null : 1 + s * MULTIPLES.length * STEPS.length + m * STEPS.length + z;
}

/**
 * The teacher's decision as the mode's action: { kind, action } or { excluded: reason }.
 * pick: the policy's setup on the bar (null: none); pastRatchet: in a trade, whether the env would ask;
 * sized (env, an entry): { teacher, half, full } the teacher's size and the policy's half and full plans, in micros.
 */
function mapAction(label, mode, { pick = null, pastRatchet = false, sized = null } = {}) {
  const t = label.teacher || {};
  const inTrade = label.decision === 'in-trade';
  if (mode === 'student') {
    if (inTrade) {
      const k = POSITION_ACTIONS.indexOf(t.action);
      return k < 0 ? { excluded: `unknown teacher action (${t.action})` } : { kind: 'position', action: FLAT_N + k };
    }
    if (t.action === 'none') return { kind: 'flat', action: 0 };
    if (!SIDES.includes(t.action)) return { excluded: `unknown teacher action (${t.action})` };
    const multiple = t.stop ? t.stop.multiple : null;
    const step = t.size ? t.size.step : null;
    if (!MULTIPLES.includes(multiple)) return { excluded: 'stop not mapped to an ATR multiple' };
    if (!STEPS.includes(step)) return { excluded: 'size step unknown (label the run with --budget)' };
    return { kind: 'flat', action: studentEntryId(t.action, multiple, step) };
  }
  if (inTrade) {
    if (t.action === 'tighten') return { excluded: 'tighten (env mode has none)' };
    if (!pastRatchet) return { excluded: 'before the ratchet (env mode asks only past it)' };
    if (t.action === 'hold') return { kind: 'position', action: ENV_ACTIONS.position.indexOf('hold') };
    if (t.action === 'exit') return { kind: 'position', action: ENV_ACTIONS.position.indexOf('close') };
    return { excluded: `unknown teacher action (${t.action})` };
  }
  if (!pick) return { excluded: 'no policy setup on the bar (env mode)' };
  if (t.action === 'none') return { kind: 'setup', action: ENV_ACTIONS.setup.indexOf('skip') };
  if (!SIDES.includes(t.action)) return { excluded: `unknown teacher action (${t.action})` };
  if (t.setup !== pick.name || t.action !== pick.direction) return { excluded: 'entry not on the policy setup (env mode)' };
  // half and full are the policy's own plan at this setup (live: plan(0.5) and plan(1)), in micro contracts:
  // the teacher's size goes to the nearer one (a tie to half, the smaller risk).
  if (!sized || !(sized.teacher > 0) || !(sized.full > 0)) return { excluded: 'entry size unknown against the policy plan (env mode)' };
  const half = sized.half > 0 && Math.abs(sized.teacher - sized.half) <= Math.abs(sized.teacher - sized.full);
  return { kind: 'setup', action: ENV_ACTIONS.setup.indexOf(half ? 'half' : 'full') };
}

/** Contracts in micros (a mini counts its family's ratio). */
const microEq = (root, size) => {
  const fam = familyOf(root);
  return fam && root === fam.mini ? size * fam.ratio : size;
};

/** The teacher's entry size in micros: the entry order the label's size is from (its contract), or null. */
function teacherMicros(label, rootOf) {
  const t = label.teacher || {};
  const size = t.size ? Number(t.size.contracts) : NaN;
  if (!(size > 0)) return null;
  const side = t.action === 'long' ? 'buy' : t.action === 'short' ? 'sell' : null;
  const o = (t.orders || []).filter(x => x && x.tool === 'place_order' && !x.riskReducing && Number(x.size) === size && x.side === side && (x.setup || null) === (t.setup || null)).pop();
  return o ? microEq(rootOf(o.contractId || label.symbol), size) : null;
}

/** Why a label is not a row before any observation is built (or null): not a decision, not cloneable, refused. */
function whyNot(label, { includeRefused = false } = {}) {
  if (label.decision !== 'flat' && label.decision !== 'in-trade') return `not a teacher decision (${label.decision})`;
  if (!label.clone || label.clone.ok !== true) return `not cloneable (${((label.clone && label.clone.reasons) || []).join(', ') || 'no reason given'})`;
  if (!label.teacher) return 'no teacher action';
  if (!includeRefused && label.gate && label.gate.decision === 'refused') return 'refused intent';
  return null;
}

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** The run's scans by symbol and bar time: [{ at, results }], in file order. */
function readScans(home) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(home, 'logs')).filter(n => /^scans-.*\.jsonl$/.test(n)).sort(); } catch (_err) { /* none */ }
  for (const n of names) {
    for (const s of readLines(path.join(home, 'logs', n))) {
      if (!isObj(s) || !isObj(s.bar) || !s.symbol) continue;
      const k = `${s.symbol}|${s.bar.t}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(s);
    }
  }
  return out;
}

/**
 * The attempt's record as live keeps it ({ days: [{ day, balance, pnl }], peak }) and the balance at t,
 * from the run's round trips closed at or before t: the account profile started on the run's first day.
 */
function attemptAt(account, runDays, closes, t, day) {
  const done = closes.filter(c => c.ms <= t);
  const through = d => account.starting_balance + done.filter(c => c.day <= d).reduce((a, c) => a + c.net, 0);
  const days = [];
  let prev = account.starting_balance;
  for (const d of runDays.filter(x => x < day)) {
    const balance = Math.round(through(d) * 100) / 100;
    days.push({ day: d, balance, pnl: Math.round((balance - prev) * 100) / 100 });
    prev = balance;
  }
  let run = account.starting_balance;
  let peak = run;
  for (const c of done) { run += c.net; peak = Math.max(peak, run); }
  return { record: { days, peak: Math.round(peak * 100) / 100 }, balance: Math.round(run * 100) / 100 };
}

/** The run's closed round trips: [{ ms, day, net }] (labels.js roundTrips and outcomeOf on the day files' fills). */
function closedTrips(days, cache) {
  const lines = Object.keys(days).sort().flatMap(d => days[d]).filter(isObj);
  return labels.roundTrips(labels.allFills(lines), cache).filter(rt => rt.closeMs !== null).map(rt => {
    const o = labels.outcomeOf(rt, null, cache);
    return { ms: rt.closeMs, day: tradingDayKey(new Date(rt.closeMs)), net: Number(o.net) || 0 };
  });
}

/** The open trade the cycle's context showed for this symbol's family, or null. */
function openTradeOf(home, label, rootOf) {
  const rel = label.provenance && label.provenance.cycleFile;
  if (!rel || !String(rel).startsWith('logs/cycles/')) return null;
  const doc = readJson(path.join(home, rel), null);
  const trades = doc && isObj(doc.context) && Array.isArray(doc.context.openTrades) ? doc.context.openTrades.filter(isObj) : [];
  return trades.find(x => familyRoot(rootOf(x.contractId)) === familyRoot(rootOf(label.symbol))) || null;
}

/**
 * Peak and trough R and bars held since the trade opened, on the bars closed by t, as the runner counts
 * them (runner.js: every bar that opened at or after the fill, less its grace for a fill seconds into a bar).
 */
function tradeProgress(bars, trade) {
  const from = Date.parse(trade.openedAt) - FILL_GRACE_MS;
  let peakR = 0;
  let troughR = 0;
  let barsHeld = 0;
  for (const b of bars) {
    if (!(Date.parse(b.t) >= from)) continue;
    const sign = trade.sign;
    peakR = Math.max(peakR, (sign * ((sign > 0 ? b.h : b.l) - trade.entry)) / trade.risk);
    troughR = Math.min(troughR, (sign * ((sign > 0 ? b.l : b.h) - trade.entry)) / trade.risk);
    barsHeld += 1;
  }
  return { peakR, troughR, barsHeld };
}

/** One run's rows and exclusions. */
function runRows(input, opts) {
  const { strategy, account, mode, includeRefused, barsFiles = {}, excluded } = opts;
  const runDir = labels.realDir(input.runDir);
  const { manifest, days } = readRun(runDir);
  const home = path.resolve(runDir, '..', '..');
  const cfg = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const tf = Number(cfg.timeframe) || null;
  if (!tf) throw new Error(`${runDir}: no runner timeframe (autotrader.json)`);
  const tfMs = tf * 60000;
  const asked = Number.isInteger(cfg.bars) && cfg.bars > 0 ? cfg.bars : historyBars(tf);
  // What the runner read: `asked` bars, or fewer when the broker caps a request (the runner's bars file records how many it got).
  const windows = new Map();
  const windowOf = sym => {
    if (!windows.has(sym)) {
      const doc = readJson(path.join(home, 'bars', `${sym}-${tf}m.json`), null);
      const got = doc && Array.isArray(doc.bars) ? doc.bars.length : Array.isArray(doc) ? doc.length : 0;
      windows.set(sym, got > 0 ? Math.min(asked, got) : asked);
    }
    return windows.get(sym);
  };
  const cache = labels.translatorCache(path.join(home, `contracts-${manifest.broker || ''}.json`));
  const rootOf = id => (id ? cache.root(String(id)) || (parseStandardName(String(id)) || { root: String(id).toUpperCase() }).root : null);
  // As live (broker-specs.js, live-runner.js): a broker spec unlike the static table is no spec (live skips the setup).
  const specOf = root => {
    const s = labels.contractSpec(root, null, cache);
    return s && s.source !== 'mismatch' ? { tickSize: s.tickSize, tickValue: s.tickValue, feesPerSide: s.feesPerSide } : null;
  };
  // The live screen needs specs for the root and both legs of its family (the plan may pick either).
  const familySpecs = root => [root, ...(familyOf(root) ? [familyOf(root).micro, familyOf(root).mini] : [])].every(r => specOf(r));
  const scans = readScans(home);
  const barsBySym = new Map();
  const barsFor = sym => {
    if (!barsBySym.has(sym)) barsBySym.set(sym, barsFiles[sym] ? labels.outcomeBarsFrom(barsFiles[sym], tf) : labels.loadBars(home, sym, tf));
    return barsBySym.get(sym);
  };
  const closes = closedTrips(days, cache);
  const runDays = Object.keys(days).sort();
  const plan = exitPlan(strategy);
  const rows = [];
  const exclude = (label, reason) => {
    excluded[reason] = (excluded[reason] || 0) + 1;
    return null;
  };
  for (const label of input.labels) {
    if (label.runId !== manifest.runId) throw new Error(`${input.labelsFile}: a label of run ${label.runId} beside run ${manifest.runId}`);
    const why = whyNot(label, { includeRefused });
    if (why) { exclude(label, why); continue; }
    const t = Date.parse(label.t);
    const spec = specOf(rootOf(label.symbol));
    if (!spec || !familySpecs(rootOf(label.symbol))) { exclude(label, 'no usable tick spec for the symbol or its family (live skips it)'); continue; }
    // The runner's window at t: the last `window` bars closed at or before t (never one after).
    const all = barsFor(label.symbol);
    const window = windowOf(label.symbol);
    let hi = -1;
    for (let lo = 0, top = all.length - 1; lo <= top;) {
      const mid = (lo + top) >> 1;
      if (Date.parse(all[mid].t) + tfMs <= t) { hi = mid; lo = mid + 1; } else top = mid - 1;
    }
    if (hi + 1 < window) { exclude(label, 'short bar history (fewer bars closed by t than the runner reads)'); continue; }
    const rawBars = all.slice(hi + 1 - window, hi + 1).map(({ t: bt, o, h, l, c, v }) => ({ t: bt, o, h, l, c, v }));
    if (label.barT && rawBars[rawBars.length - 1].t !== label.barT) { exclude(label, 'the decision bar is not the last bar closed by t'); continue; }
    const { record, balance } = attemptAt(account, runDays, closes, t, label.day);
    const cs = live.stateFrom(account, record, balance);
    if (cs.status !== 'active') { exclude(label, `attempt over (${cs.status})`); continue; }
    let obs;
    let kind;
    let pick = null;
    let pastRatchet = false;
    let sized = null;
    if (label.decision === 'flat') {
      const list = scans.get(`${label.symbol}|${label.barT}`) || [];
      const scan = list.filter(s => Date.parse(s.at) <= t).pop();
      if (!scan) { exclude(label, 'no scan logged for the bar by t'); continue; }
      const results = (Array.isArray(scan.results) ? scan.results : []).filter(isObj);
      // A scan a running policy screened (its components rewritten, its own row added) is not the raw scan live
      // observes: not read yet (no replay starts an attempt today), never silently a bar without a setup. Only a screen adds a
      // verdict (the policy's row, with a pick) or rewrites a component ("traded through"); every raw scan already has the
      // policy's own row (strategies.js scan), so its name alone says nothing. A screen with no pick rewrites nothing:
      // its observation equals the raw scan's.
      if (results.some(r => r.verdict || /^traded through/.test(String(r.note || '')))) { exclude(label, 'scan screened by a running policy (not read yet)'); continue; }
      const byName = new Map(results.map(r => [r.name, r]));
      // As the live screen (live-runner.js): the first of the policy's strategies that fired with a stop.
      pick = strategy.strategies.map(n => byName.get(n)).find(r => r && r.candidate && r.direction && r.stopDistance > 0) || null;
      if (combine.entryBlock(cs)) { exclude(label, 'the attempt blocks entries'); continue; }
      if (pick) {
        const s = live.setupObservation({ account, cs, strategy, component: pick.name, symbol: rootOf(label.symbol), rawBars, spec, scan: pick, results, specOf });
        if (!s.cp) { exclude(label, 'no size fits the setup'); continue; }
        obs = s.obs;
        const halfPlan = s.plan(0.5);
        sized = { teacher: teacherMicros(label, rootOf), full: microEq(s.cp.root, s.cp.size), half: halfPlan ? microEq(halfPlan.root, halfPlan.size) : 0 };
      } else {
        const book = live.liveBook(rawBars, spec, strategy.params);
        const i = book.bars.length - 1;
        obs = buildObservation({ cs, account, book, i, closeAt: new Date(Date.parse(book.bars[i].t) + (timeframeMs(strategy.timeframe) || 60000)), components: strategy.strategies });
      }
    } else {
      const trade = openTradeOf(home, label, rootOf);
      if (!trade || !(trade.risk > 0) || !Number.isFinite(trade.entry) || !(trade.sign === 1 || trade.sign === -1) || !Number.isFinite(Date.parse(trade.openedAt))) {
        exclude(label, 'trade state unknown (no open trade with an initial stop in the cycle context)');
        continue;
      }
      // Risk from the working stop (open-trades.js, when the entry named no stop) may be a trailed one: not the initial risk.
      if (!Number.isFinite(trade.initialStop) || (Array.isArray(trade.notes) && trade.notes.some(n => /initial stop unknown/.test(String(n))))) {
        exclude(label, 'initial stop unknown (risk from the working stop)');
        continue;
      }
      // A policy strategy's trade (setup:<policy>): live observes its component, which the context doesn't name.
      if (trade.setup === strategy.name) { exclude(label, 'a running policy\'s trade (not read yet)'); continue; }
      const progress = tradeProgress(rawBars, trade);
      pastRatchet = plan.trailActivateR !== null && progress.peakR >= plan.trailActivateR;
      obs = live.positionObservation({
        account, cs, strategy, rawBars, spec, specOf,
        pos: { sign: trade.sign, entry: trade.entry, risk: trade.risk, size: Number(trade.size) || 1, contract: rootOf(trade.contractId), component: trade.setup || null, ...progress },
      });
    }
    const mapped = mapAction(label, mode, { pick, pastRatchet, sized });
    if (mapped.excluded) { exclude(label, mapped.excluded); continue; }
    kind = mapped.kind;
    rows.push({
      key: label.key, runId: label.runId, t: label.t, symbol: label.symbol, kind, action: mapped.action, obs,
      teacher: { action: label.teacher.action, setup: label.teacher.setup || null, multiple: label.teacher.stop ? label.teacher.stop.multiple : null, step: label.teacher.size ? label.teacher.size.step : null, pick: pick ? pick.name : null,
        // Whether the observed setup is the one the teacher traded (an entry on another strategy or side is not).
        onPick: Boolean(pick) && label.teacher.setup === pick.name && label.teacher.action === pick.direction },
      // What came after the decision: targets and weights only, never an input.
      targets: {
        gate: label.gate ? label.gate.decision : null,
        outcome: label.outcome ? { result: label.outcome.result ?? null, net: label.outcome.net ?? null, r: label.outcome.r ?? null, maeR: label.outcome.maeR ?? null, mfeR: label.outcome.mfeR ?? null } : null,
        counterfactual: label.counterfactual ? { result: label.counterfactual.result ?? null, R: label.counterfactual.R ?? null, net: label.counterfactual.net ?? null, strategy: label.counterfactual.strategy ?? null } : null,
        counterfactualFor: label.counterfactualFor || null,
      },
      weight: 1,
    });
  }
  return { rows, run: { runId: manifest.runId, configHash: manifest.hash || null, labels: input.labels.length, rows: rows.length } };
}

/** A labels file: its labels (version-checked). */
function readLabels(file) {
  const out = [];
  for (const l of readLines(file)) {
    if (!isObj(l)) throw new Error(`${file}: a line that is not a label`);
    if (l.v !== LABELS_VERSION) throw new Error(`${file}: labels version ${l.v}; this reads version ${LABELS_VERSION} (relabel the run)`);
    out.push(l);
  }
  return out;
}

/**
 * Inputs: [{ runDir, labelsFile }] (labels default to <runDir>/labels.jsonl). The labels must be the
 * run's: the same run id and config hash as its manifest.
 */
function buildDataset(inputs, { strategy, account, mode = 'student', includeRefused = false, barsFiles = {} } = {}) {
  if (!MODES.includes(mode)) throw new Error(`mode: one of ${MODES.join(', ')}`);
  if (!strategy || strategy.signal !== 'policy' || !Array.isArray(strategy.strategies) || !strategy.strategies.length) throw new Error('strategy: a policy strategy (signal: policy, with strategies)');
  if (!account || account.name !== strategy.account) throw new Error(`account: the policy strategy's account profile (${strategy.account})`);
  if (!inputs.length) throw new Error('no labelled runs given');
  const excluded = {};
  const seen = new Set();
  const runs = [];
  let rows = [];
  for (const input of inputs) {
    const labelsFile = input.labelsFile || path.join(input.runDir, 'labels.jsonl');
    const { manifest } = readRun(labels.realDir(input.runDir));
    const list = readLabels(labelsFile);
    for (const l of list) {
      const hash = l.provenance && l.provenance.configHash;
      if (hash !== (manifest.hash || null)) throw new Error(`${labelsFile}: labels of config ${hash}, not run ${manifest.runId}'s (${manifest.hash}): label this run again`);
    }
    // A label seen in an earlier input (the same run given twice): counted, never twice in the data.
    const fresh = list.filter(l => {
      if (seen.has(l.key)) { excluded['duplicate label'] = (excluded['duplicate label'] || 0) + 1; return false; }
      seen.add(l.key);
      return true;
    });
    const r = runRows({ ...input, labelsFile, labels: fresh }, { strategy, account, mode, includeRefused, barsFiles, excluded });
    rows = rows.concat(r.rows);
    runs.push({ ...r.run, labelsFile: path.basename(labelsFile) });
  }
  rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || a.runId.localeCompare(b.runId) || String(a.symbol).localeCompare(String(b.symbol)) || a.key.localeCompare(b.key));
  const spaces = mode === 'student' ? STUDENT : ENV;
  const actionNames = mode === 'student' ? spaces.actions : null;
  const nameOf = r => (actionNames ? actionNames[r.action] : ENV_ACTIONS[r.kind === 'setup' ? 'setup' : 'position'][r.action]);
  const actionCounts = {};
  for (const r of rows) actionCounts[`${r.kind}:${nameOf(r)}`] = (actionCounts[`${r.kind}:${nameOf(r)}`] || 0) + 1;
  const fields = observationFields(strategy.strategies);
  const header = {
    format: FORMAT, version: VERSION, mode, obsVersion: observationVersion(strategy.strategies, strategy.params), obsFields: fields, obsDim: fields.length,
    actions: spaces.actions, actionN: mode === 'student' ? spaces.actions.length : 3, masks: spaces.masks,
    strategy: strategy.name, account: account.name, components: strategy.strategies, includeRefused,
    runs: runs.sort((a, b) => a.runId.localeCompare(b.runId)), rows: rows.length,
  };
  const summary = { ...header, actionCounts: Object.fromEntries(Object.entries(actionCounts).sort()), excluded: Object.fromEntries(Object.entries(excluded).sort()), labels: runs.reduce((a, r) => a + r.labels, 0) + (excluded['duplicate label'] || 0) };
  // The run homes (not written): a dataset holds what came after each decision, never where a resumed teacher reads.
  const homes = inputs.map(x => path.resolve(labels.realDir(x.runDir), '..', '..'));
  return { header, rows, summary, homes };
}

/** Write the dataset (JSONL: the header line, then one row per line) and <file>.summary.json, never inside the repository. */
function writeDataset(file, built, { root = null } = {}) {
  const out = path.resolve(expandHome(file));
  if (root && labels.inside(out, root)) throw new Error(`${out} is inside the repository (${root}): datasets are written outside it`);
  for (const home of built.homes || []) if (labels.inside(out, home)) throw new Error(`${out} is inside the run home ${home}: datasets hold what came after each decision; write them outside it`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, [JSON.stringify({ header: built.header }), ...built.rows.map(r => JSON.stringify(r))].join('\n') + '\n');
  fs.renameSync(tmp, out);
  const summaryFile = `${out.replace(/\.jsonl$/, '')}.summary.json`;
  writeJsonAtomic(summaryFile, built.summary);
  return { file: out, summaryFile };
}

/** One line for the CLI. */
const summaryText = s => `${s.rows} rows (${s.mode} mode) from ${s.labels} labels of ${s.runs.length} run(s); obs ${s.obsDim} fields, version ${s.obsVersion.slice(0, 12)}\n`
  + `actions: ${Object.entries(s.actionCounts).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}\n`
  + `excluded: ${Object.entries(s.excluded).map(([k, v]) => `${k} ${v}`).join('; ') || '-'}\n`;

module.exports = { FORMAT, VERSION, MODES, STUDENT, ENV, FLAT_N, studentEntryId, mapAction, microEq, teacherMicros, whyNot, attemptAt, tradeProgress, buildDataset, writeDataset, summaryText };
