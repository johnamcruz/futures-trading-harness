'use strict';

/**
 * Tier 2 of the goal regression (docs/TRAINING.md, "The goal regression"): its days through the live path, each as its
 * own process (tier2-day.js, `parallel` at once), read by scripts/lib/eval/goal-path.js and compared with main's tier 2
 * baseline (tests/fixtures/goal/baseline.json `tier2`). Used by tests/goal/tier2.goal.js (npm run goal:full) and as a CLI:
 *
 *   node tests/goal/tier2-run.js            the table, every lost or changed trade by category, the trace problems
 *   node tests/goal/tier2-run.js --write    the same, then main's tier 2 baseline written when nothing is worse
 *                                           (goal-path.js tier2RiseProblems) and every trace is whole
 *   node tests/goal/tier2-run.js --moves    the catch-the-move days against their golden, layer by layer
 *   node tests/goal/tier2-run.js --write-moves   the golden written from this code (a reviewed golden change)
 *
 *   tier2Days()                              the configured days (config/training.json goalRegression.tier2)
 *   allDays()                                every day tier 2's main run plays: its days and the move days, sorted (the
 *                                            CI shards split these: FTH_GOAL_SHARD, goal-path.js shardDays)
 *   baseOn(base, days)                       main's tier 2 on some days only (no summary: the aggregate judges the sum)
 *   moveBehaviour(golden, now, results)      [problem]: each move day behaving as its label says
 *   floorDays()                              the floor days: [{ day, bind }] (goal-synth.js floor)
 *   runDays(days, { breakName, latencyMs, fault, parallel, dir })   [day result] (tier2-day.js's JSON); latencyMs only for
 *                                            the order-latency self-test (an injected stub), fault a broker-fault day
 *   readTier2(results)                       { trades, summary, problems }: the trades, their summary, the trace problems
 *                                            and the sizing problems (sizingProblems: goal-sizing.js sizingChecks)
 *   judge(base, now, results)                { rows, changes, problems, fail }: base/now the tier 2 baselines' shape
 *   reportText(judged)                       the report: the table, then one line per change and per trace problem
 *   tracePath(dir)                           where a run's full trace JSON goes (outside the repository)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const GC = require('../../scripts/lib/eval/goal-check');
const GP = require('../../scripts/lib/eval/goal-path');
const GT = require('../../scripts/lib/eval/goal-trades');
const GS = require('../../scripts/lib/eval/goal-sizing');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG = () => require('../../scripts/lib/tunables').training().goalRegression.tier2;
// The fixture set of this run (FTH_GOAL_FIXTURE: ci, the committed slice, by default; real, the local one).
let SET = null;
const set = () => { SET = SET || GC.fixtureSet(GC.kindOf()); if (SET.missing) throw new Error(SET.missing); return SET; };
const BASELINE_FILE = () => set().baselineFile;

const tier2Days = () => GP.pickDays(set().doc.blocks, CFG());

function runOne(day, { breakName = null, latencyMs = 0, fault = null, state = null, probe = false, root = ROOT, dir }) {
  const out = path.join(dir, `${day}${breakName ? `-${breakName}` : ''}${latencyMs ? `-late${latencyMs}` : ''}${fault ? `-${fault}` : ''}${state ? `-${state.name}` : ''}-${crypto.randomBytes(4).toString('hex')}.json`);
  const env = { ...process.env, ...(breakName ? { FTH_GOAL_BREAK: breakName } : {}) };
  if (!breakName) delete env.FTH_GOAL_BREAK;
  delete env.NODE_OPTIONS;
  const args = [...(breakName ? ['--require', path.join(root, 'tests', 'goal', 'breaks.js')] : []), path.join(root, 'tests', 'goal', 'tier2-day.js'), JSON.stringify({ day, out, latencyMs, fault, state, probe })];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => (code === 0 ? resolve(JSON.parse(fs.readFileSync(out, 'utf8'))) : reject(new Error(`tier 2 day ${day}${breakName ? ` (${breakName})` : ''} failed (${code}): ${err.slice(-2000)}`))));
  });
}

async function runDays(days, { breakName = null, latencyMs = 0, fault = null, state = null, probe = false, root = ROOT, parallel = CFG().parallel, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-')) } = {}) {
  const out = new Array(days.length);
  let next = 0;
  const worker = async () => { while (next < days.length) { const i = next; next += 1; out[i] = await runOne(days[i], { breakName, latencyMs, fault, state, probe, root, dir }); } };
  await Promise.all(Array.from({ length: Math.min(parallel, days.length) }, worker));
  return out;
}

/** Each day's behaviour by its label (goal-path.js dayBehaviour). */
const behaviour = (results, trades) => results.map(d => GP.dayBehaviour(d, trades, { maxLossR: CFG().maxLossR }));
const dayLabels = results => results.map(d => ({ day: d.day, ...(d.label || {}) }));
const behaviourProblems = (base, now) => [...now.flatMap(b => b.problems), ...GP.caughtLost(base, now)];

function readTier2(results) {
  const P = GT.shippedOf(ROOT, {});
  const trades = results.flatMap(d => GP.dayTrades(d, { tick: d.tick }));
  const summary = GP.summarize(trades, {
    legs: results.flatMap(d => d.legs), mechanical: results.flatMap(d => d.mechanical), spanMs: P.setupMinutes * 60000, blows: results.filter(d => d.blown).length,
  });
  return { trades, summary, problems: [...trades.flatMap(GP.traceProblems), ...sizingProblems(results)], behaviour: behaviour(results, trades) };
}

/** Every sized or skipped entry of these days as the rulebook plans it, the simulator agreeing (goal-sizing.js). */
function sizingProblems(results) {
  const P = GT.shippedOf(ROOT, {});
  const account = require('../../scripts/lib/trading/accounts').accountNamed(ROOT, P.policy.account, {});
  return results.flatMap(d => GS.sizingChecks(d, GS.ctxOf(d, P, account)));
}

/** A trade as the baseline keeps it: its facts and its steps (the full trace stays out of the repository). */
const kept = t => ({ key: t.key, day: t.day, side: t.side, setup: t.setup, bar: t.bar, entry: t.entry, size: t.size, entryTime: t.entryTime, exitTime: t.exitTime, exitPrice: t.exitPrice, exitReason: t.exitReason, R: t.R, trail: t.trail, steps: t.steps });

function judge(base, now, results) {
  const tol = CFG().tolerance;
  // A day's own check (a mutation check) carries no summary: its trades and traces alone decide.
  const rows = base && base.summary ? GP.tier2Rows(base.summary, now.summary, tol) : [];
  const changes = base ? GP.compareTrades(base.trades, now.trades, results) : [];
  // The trend and non-trend behaviour: on every day the loss bound and no blow, and main's caught trend days still caught.
  const days = now.behaviour.map(b => b.day);
  const behaved = behaviourProblems(base ? (base.behaviour || []).filter(b => days.includes(b.day)) : [], now.behaviour);
  const fail = !base || now.problems.length > 0 || changes.length > 0 || rows.some(r => !r.ok) || behaved.length > 0;
  return { rows, changes, problems: now.problems, behaviour: behaved, fail, missingBaseline: !base };
}

function reportText(j) {
  const lines = [];
  if (j.missingBaseline) lines.push('no tier 2 baseline: node tests/goal/tier2-run.js --write');
  if (j.rows.length) lines.push(GC.renderTable(j.rows));
  for (const c of j.changes) lines.push(`(${c.category}) ${GP.CATEGORIES[c.category] || 'a new trade'}: ${c.key}: ${c.why}`);
  for (const p of j.problems) lines.push(`trace: ${p}`);
  for (const p of j.behaviour || []) lines.push(`behaviour: ${p}`);
  return lines.join('\n');
}

const tracePath = dir => path.join(dir, 'tier2-trace.json');

/**
 * The state days: the quick day's first trade from a mid-attempt state each (the cushion low, the target near), so the
 * rulebook's cushion_frac and near_target_usd bind: { name, pnl } from the account and the rulebook
 * (config goalRegression.tier2.states: the cushion left as a share of max_loss, the room to the target as a share of
 * near_target_usd).
 */
function stateDefs(root = ROOT) {
  const P = GT.shippedOf(root, {});
  const account = require('../../scripts/lib/trading/accounts').accountNamed(root, P.policy.account, {});
  const st = CFG().states;
  return [
    { name: 'fresh', pnl: 0 },
    { name: 'low-cushion', pnl: -Math.round((1 - st.cushionShare) * account.max_loss) },
    { name: 'near-target', pnl: Math.round(account.profit_target - st.targetShare * P.policy.sizing.near_target_usd) },
  ];
}
const quickDay = base => (base.trades.find(t => t.exitReason === 'stop') || base.trades[0]).day;
/** Each state's first entry size on the quick day: { name: size | null }. */
async function stateSizes(day, { root = ROOT, dir, names = null } = {}) {
  const defs = stateDefs(root).filter(d => !names || names.includes(d.name));
  const runs = await Promise.all(defs.map(state => runDays([day], { state, root, parallel: 1, dir }).then(r => [state.name, (GP.dayTrades(r[0], { tick: r[0].tick })[0] || {}).size ?? null])));
  return Object.fromEntries(runs);
}

/** main's tier 2 on some days only (a shard's or a day's own check): its trades there; the summary is the aggregate's. */
const baseOn = (base, days) => ({ ...base, summary: null, trades: base.trades.filter(t => days.includes(t.day)) });

// The move days: the configured real ones in the fixture, and the synthetic scenarios (a fakeout, a quiet day).
const moveDays = () => [...set().doc.blocks.filter(b => b.half === 'M').flatMap(b => b.sessions), ...set().synth.blocks.filter(b => b.half === 'M').flatMap(b => b.sessions)].sort();
/** Each move day's layers (goal-path.js moveLayers). */
function readMoves(results) {
  const exit = GT.shippedOf(ROOT, {}).exit.plan;
  return results.map(d => ({ day: d.day, label: d.label || null, scenario: d.scenario || null, layers: GP.moveLayers(d, { tick: d.tick, exit }) }));
}
/** The golden's move days against these: [{ day, diffs }] (no golden: every day differs). */
function judgeMoves(golden, now, tick) {
  return now.map(m => {
    const g = golden ? golden.scenarios.find(x => x.day === m.day) : null;
    return { day: m.day, diffs: g ? GP.moveDiff(g.layers, m.layers, { tick, shareTol: CFG().tolerance.moveShare }) : ['no golden for this day: node tests/goal/tier2-run.js --write-moves'] };
  });
}
const allDays = () => [...new Set([...tier2Days(), ...moveDays()])].sort();
/** The floor days (goal-synth.js floor): the term each binds, by its scenario. */
const floorDays = () => set().synth.blocks.filter(b => /^floor-/.test(b.scenario || '')).map(b => ({ day: b.sessions[0], bind: b.scenario.replace(/^floor-/, '') }));

/**
 * Each move day's behaviour by its label: a trend day the golden catches is caught and ridden (its R above 0); a
 * non-trend day has no entry, or a loss of at most the controlled 1R (the stop's slippage within maxLossR).
 */
function moveBehaviour(golden, now, results) {
  return now.map((m, i) => {
    const label = results[i].label || {};
    const g = golden ? golden.scenarios.find(x => x.day === m.day) : null;
    const L = m.layers;
    if (label.kind === 'trend' && g && g.layers && g.layers.capture.caught) return L && L.capture.caught && L.exit.R > 0 ? null : `${m.day} (trend): not caught and ridden (${L ? `${L.exit.R}R, caught ${L.capture.caught}` : 'no trade'})`;
    if (label.kind !== 'trend') return !L || L.exit.R >= -CFG().maxLossR ? null : `${m.day} (${label.kind}): a loss of ${L.exit.R}R, past the controlled -${CFG().maxLossR}R`;
    return null;
  }).filter(Boolean);
}

const readGolden = () => (fs.existsSync(set().goldenFile) ? JSON.parse(fs.readFileSync(set().goldenFile, 'utf8')) : null);

async function cli(argv) {
  const t0 = Date.now();
  if (argv.includes('--moves') || argv.includes('--write-moves')) {
    const results = await runDays(moveDays());
    const now = readMoves(results);
    const judged = judgeMoves(readGolden(), now, results[0].tick);
    for (const j of judged) process.stdout.write(`${j.day}: ${j.diffs.length ? j.diffs.join('\n  ') : 'as the golden'}\n`);
    process.stdout.write(`${results.length} move days, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    if (!argv.includes('--write-moves')) return judged.some(j => j.diffs.length) ? 1 : 0;
    fs.writeFileSync(set().goldenFile, `${JSON.stringify({ about: 'The golden catch-the-move scenarios (goal-path.js moveLayers): each move day\'s first trade through the live path with the plan-following mock, layer by layer, as main\'s code gives them. Written by node tests/goal/tier2-run.js --write-moves; a change is a golden change the pull request explains.', scenarios: now }, null, 2)}\n`);
    process.stdout.write(`${set().goldenFile} written\n`);
    return 0;
  }
  const days = tier2Days();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-'));
  const results = await runDays(days, { dir });
  const now = readTier2(results);
  fs.writeFileSync(tracePath(dir), JSON.stringify(now.trades.map(t => ({ key: t.key, trace: t.trace })), null, 1));
  const baseline = fs.existsSync(BASELINE_FILE()) ? JSON.parse(fs.readFileSync(BASELINE_FILE(), 'utf8')) : {};
  const j = judge(baseline.tier2 || null, now, results);
  process.stdout.write(`${reportText(j)}\n${days.length} days, ${now.trades.length} trades, ${((Date.now() - t0) / 1000).toFixed(0)} s; the full trace: ${tracePath(dir)}\n`);
  if (!argv.includes('--write')) return j.fail ? 1 : 0;
  if (now.problems.length) throw new Error('refused: a trace is not whole (its problems above): fix the path first');
  const rise = GP.tier2RiseProblems(baseline.tier2 && baseline.tier2.summary, now.summary);
  if (rise.length) throw new Error(`refused: a baseline only rises:\n${rise.join('\n')}`);
  // Sizes are exact: a trade of main's sized differently, or a state day's, is refused unless the change is said why.
  const why = argv.includes('--sizes-why') ? argv[argv.indexOf('--sizes-why') + 1] : null;
  const sizeOf = new Map(((baseline.tier2 && baseline.tier2.trades) || []).map(t => [t.key, t.size]));
  const states = await stateSizes(quickDay(now), { dir });
  const resized = [...now.trades.filter(t => sizeOf.has(t.key) && sizeOf.get(t.key) !== t.size).map(t => `${t.key}: ${sizeOf.get(t.key)} -> ${t.size}`),
    ...Object.entries(states).filter(([k, v]) => baseline.tier2 && baseline.tier2.states && baseline.tier2.states[k] !== undefined && baseline.tier2.states[k] !== v).map(([k, v]) => `state ${k}: ${baseline.tier2.states[k]} -> ${v}`)];
  if (resized.length && !(why && why.trim())) throw new Error(`refused: sizes changed (an intended change says why: --sizes-why "<why>"):\n${resized.join('\n')}`);
  fs.writeFileSync(BASELINE_FILE(), `${JSON.stringify({ ...baseline, tier2: { fixture: set().doc.hash, days, summary: now.summary, states, ...(resized.length ? { sizeChange: { why, trades: resized } } : {}), behaviour: now.behaviour.map(({ problems: _p, ...b }) => b), trades: now.trades.map(kept) } }, null, 2)}\n`);
  process.stdout.write(`${BASELINE_FILE()}: tier 2 written\n`);
  return 0;
}

if (require.main === module) cli(process.argv.slice(2)).then(c => { process.exitCode = c; }, err => { process.stderr.write(`${err.message}\n`); process.exitCode = 1; });

module.exports = { sizingProblems, allDays, baseOn, moveBehaviour, floorDays, stateDefs, quickDay, stateSizes, set, BASELINE_FILE, dayLabels, behaviourProblems, moveDays, readMoves, judgeMoves, readGolden, tier2Days, runDays, readTier2, judge, reportText, tracePath, kept };
