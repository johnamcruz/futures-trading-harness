'use strict';

/**
 * The decision-path world (tests/e2e/decision-path-e2e.test.js): the live runner as the harness wires it
 * (runner-wiring.js wireRunner) at a replayed time, one pass per decision time as a replay runs it, its cycle run by
 * the production glue (scripts/lib/cycle-run.js) with a scripted model (scripted-model.js) in place of the spawned
 * opencode. The broker is the mock exchange as a replay server (its clock the pass's time, replay: true), behind the
 * real adapter for the runner and the real order gateway for the model's orders; the bars are the parity series
 * (tests/fixtures/parity/NQ-3m.csv), where the fixture fx_break fires long on the 04:09 UTC bar (scenario 0).
 *
 * The expectations other branches in flight will change are kept here, each in one place, so a rebase is one edit:
 *   REQUIRED_LOOKUPS   the lookups each role's index requires on the fired bar (runner-wiring lookups, risk-manager skills)
 *   RESULT_ACTION      the decision history's action for a result word (the cycle-result mapping)
 *   headLoads(w)       what the head trader loads with the skill tool before deciding: in index mode (the default) none,
 *                      its per-cycle skills are embedded in its prompt on the runner's attestation (head-prompt.js);
 *                      in full mode (FTH_ROLE_SKILLS=full) the gate's lists and the others it reads every cycle
 *   CACHE_SERVED       the roles the report cache serves on the fired bar (the cache's lookups rule)
 *   SETUP              the setup on the table: the one strategy-specific fact (a test-only fixture strategy)
 */

const fs = require('fs');
const path = require('path');
const exchange = require('./mock-exchange');
const { scriptedModel } = require('./scripted-model');
const { tmpDir, recordBrokerSpecs, FX_STRATEGIES } = require('../helpers');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { openAdapter } = require('../../scripts/lib/broker/adapter');
const { wireRunner, closedBarsOnly } = require('../../scripts/lib/runner-wiring');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { readBriefing } = require('../../scripts/lib/trading/briefing');
const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const MNQ_ID = 'fake:MNQ:Z26';
const STEP = 180000;
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
// Scenario 0: the parity bar where fx_break fires long (tests/e2e/trading-e2e.test.js), the bar before it (nothing
// fired), and the bar after it (the position is managed). A decision time is 2 s after its bar closed, as a replay's.
const FIRED_BAR = '2026-04-28T04:09:00.000Z';
const QUIET_BAR = '2026-04-28T04:06:00.000Z';
const NEXT_BAR = '2026-04-28T04:12:00.000Z';
const decisionAt = bar => new Date(Date.parse(bar) + STEP + 2000).toISOString();
const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];

/*
 * The setup on the table at the fired bar: the one strategy-specific fact of these tests (a test-only fixture
 * strategy, tests/fixtures/strategies-fx). When the composed entry replaces strategies, this is the one edit.
 */
const SETUP = { strategy: 'fx_break', side: 'long', with: ['fx_cross'], trendRule: 'allows' };
// The lookups each role's skill index requires on the fired bar (a with-trend candidate: fx_break long, trend rule
// allows; skills-loaded.js SITUATIONAL, role-skills.js). The test also checks these against the code's own answer.
const REQUIRED_LOOKUPS = {
  'market-structure-analyst': ['breakout-vs-fakeout', 'breakout'],
  'trend-momentum-analyst': [],
  'volume-liquidity-analyst': [],
  // The risk manager embeds its situational skills (confluence-counting, invalidation) in its core: none to look up.
  'risk-manager': [],
};
// The decision history's action for a cycle's result word with a setup on the table (decision-history.js ACTIONS).
// `blocked` is scored as written only when the cycle made an order call or launched the trade-executor (autotrader.js
// scoreRun); a `blocked` without one is scored as no-trade, so skipped with a setup on the table.
const RESULT_ACTION = { executed: 'entered', 'no-trade': 'skipped', blocked: 'blocked', managed: 'managed' };
// What the head trader loads every cycle before deciding (trade-session step 0; the gate's REQUIRED_FOR_ENTRY).
const headLoads = w => (w.mode === 'full' ? [...REQUIRED_FOR_ENTRY, 'trader-process', 'htf-to-ltf'] : []);
// What it reads before an entry (setup-judgment, trade-plan): loaded in full mode, embedded in index mode.
const entryLoads = w => (w.mode === 'full' ? [...REQUIRED_AT_ENTRY] : []);
// A rules setup's entry also reads the strategy skills: in index mode the head trader's prompt embeds the composed
// entry's list (trade_lifecycle, the one shipped entry strategy), so it looks these up (full mode loads them above).
const STRATEGY_SKILLS = REQUIRED_FOR_ENTRY.filter(s => /^strategy-/.test(s));
const strategyReads = w => (w.mode === 'full' ? [] : STRATEGY_SKILLS);
// The roles the report cache serves on the fired bar after a quiet bar, in index mode (the default): risk-manager phase 1
// (the account unchanged; no lookup is required of it). The analysts' reports here name no briefing versions, so none is
// cached; a cached analyst is served only with lookups made under the same facts key (the e2e's cache cases).
const CACHE_SERVED = ['risk-manager'];

// The parity bars as 1m bars (golden-bars.js toMinutes: three per 3m bar, its path open, extreme, extreme, close),
// served at 1m for a data lane (lanes.js trigger "data").
const MINUTE_BARS = require('./golden-bars').toMinutes(BARS.map(b => ({ ...b, ms: Date.parse(b.t) }))).map(({ ms: _ms, ...b }) => b);

/**
 * A harness home on a replay mock exchange serving the parity bars; the runner's config and state file. `dataLane`:
 * the runner config adds a 1m data lane ({ timeframe: 1, trigger: "data" }), the exchange serving MINUTE_BARS at 1m.
 */
function world({ mode = 'index', dataLane = false } = {}) {
  const home = tmpDir();
  recordBrokerSpecs(home, { broker: 'replaymock', roots: ['MNQ', 'NQ', 'MES', 'ES'] });
  const state = path.join(home, 'exchange.json');
  const journal = path.join(home, 'journal.jsonl');
  const clock = path.join(home, 'clock.json');
  fs.writeFileSync(journal, '');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'replaymock',
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journal, allowedAccountsEnv: 'MOCK_ALLOWED_ACCOUNTS', env: ['MOCK_STATE', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_ALLOWED_ACCOUNTS'] } },
  }));
  exchange.initState(state, { nowMs: Date.parse(decisionAt(QUIET_BAR)), prices: { [MNQ_ID]: BARS[0].c }, bars: { [MNQ_ID]: BARS, ...(dataLane ? { [`${MNQ_ID}@1m`]: MINUTE_BARS } : {}) } });
  fs.mkdirSync(path.join(home, 'no-accounts'));
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, NODE_ENV: 'test',
    MOCK_STATE: state, MOCK_JOURNAL: journal, MOCK_CLOCK_FILE: clock, MOCK_REPLAY: '1', MOCK_ALLOWED_ACCOUNTS: '7',
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_GATE_LOG: path.join(home, 'gate.jsonl'), FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_STRATEGIES_DIRS: FX_STRATEGIES, FTH_ACCOUNTS_DIRS: path.join(home, 'no-accounts'),
    // The roles' and the head trader's skills: index (the default, no variable) or full, as the runner reads it.
    ...(mode === 'full' ? { FTH_ROLE_SKILLS: 'full' } : {}),
  };
  const cfg = validateConfig({ harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: 1400, ...(dataLane ? { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }] } : {}) });
  return { home, state, journal, clock, env, cfg, mode, stateFile: path.join(home, 'runner-state.json') };
}

/**
 * One pass of the live runner at `at` (a replay's decision time), the cycle played by `script` (scripted-model.js).
 * { ctx: the model's last cycle, ran: the cycles run, logs, events, state }.
 */
async function pass(w, at, script, o = {}) {
  const ms = Date.parse(at);
  fs.writeFileSync(w.clock, JSON.stringify({ now: at }));
  const last = BARS.filter(b => Date.parse(b.t) + STEP <= ms).at(-1);
  exchange.update(w.state, s => { s.nowMs = ms; s.prices[MNQ_ID] = last.c; });
  const env = { ...w.env, FTH_REPLAY_NOW: at };
  const now = () => new Date(ms);
  const model = scriptedModel(script);
  // `o.lateBy` (ms): a slow model, its final answer that much later (the result event's times shifted, the wall clock
  // the cycle's timing reads with it once the run returned): what the cycle log's timing sees of a cycle that overran.
  const slow = o.lateBy ? lateModel(model, o.lateBy) : null;
  const logs = [];
  const events = o.events || []; // `o.events`: the caller's array, to watch the runner's events while the cycle runs
  const ran = [];
  const client = openAdapter({ root: ROOT, env, timeoutMs: 30000 });
  try {
    const runner = wireRunner({
      cfg: w.cfg, root: ROOT, home: w.home, env, client: closedBarsOnly(client, now), dataDir: w.cfg.dataDir, now,
      runCycle: async (action, prompt, limits) => {
        const r = await runCycle(w.cfg, action, prompt, {}, limits, { root: ROOT, home: w.home, env, run: slow ? slow.run : model, guard: () => true, ...(slow ? { wallNow: slow.wallNow } : {}) });
        ran.push({ action, prompt, context: limits && limits.context, ...r });
        return r;
      },
      loadState: () => (fs.existsSync(w.stateFile) ? JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) : null),
      saveState: s => fs.writeFileSync(w.stateFile, JSON.stringify(s)),
      killSwitchFile: w.env.FTH_KILL_SWITCH_FILE, log: (m, level) => logs.push(`${level || 'info'} ${m}`), event: e => events.push(e),
    });
    await runner.step();
    return { ctx: model.last, ran, logs, events, state: fs.existsSync(w.stateFile) ? JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) : null };
  } finally {
    client.close();
  }
}

/** A model whose final answer (its text events) comes `lateBy` ms late, and the wall clock that ran on with it. */
function lateModel(model, lateBy) {
  let done = false;
  const shift = line => {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { return line; }
    if (!ev || ev.type !== 'text') return line;
    const t = ev.part && ev.part.time ? { time: { start: ev.part.time.start + lateBy, end: ev.part.time.end + lateBy } } : {};
    return JSON.stringify({ ...ev, timestamp: ev.timestamp + lateBy, part: { ...ev.part, ...t } });
  };
  return {
    run: async (argv, opts) => {
      const r = await model(argv, opts);
      done = true;
      const output = String(r.output || '').split('\n').map(shift).join('\n');
      return { ...r, output, stdout: output };
    },
    wallNow: () => Date.now() + (done ? lateBy : 0),
  };
}

/** The bar briefing's m3 version: the facts key of a pass without other lanes (skill-lookups.js factsKey). */
const m3Version = w => { const b = readBriefing(w.home, 'MNQ'); return b && b.sections && b.sections.m3 ? b.sections.m3.version : null; };

/** The bar briefing's m3 part as the runner wrote it for this pass. */
const m3Of = w => { const b = readBriefing(w.home, 'MNQ'); return b && b.sections && b.sections.m3 ? b.sections.m3.data : null; };

/** Phase-2 FACTS true by the briefing (each named by its field): the trend rule, the VWAP side, the prior value. */
function trueFacts(w) {
  const m3 = m3Of(w);
  const { trendRuleOf } = require('../../scripts/lib/trading/reasons');
  return [`trend long ${trendRuleOf(m3.trendRule).long ? 'allowed' : 'blocked'}`, `vwap ${m3.vwap.side}`, `value ${m3.location.priorValue}`];
}
const flip = { above: 'below', below: 'above', at: 'above', inside: 'above' };

/** The place_order arguments a model writes itself, without order_plan: the setup's side with an 18-tick stop. */
const manualArgs = rationale => ({ accountId: 7, contractId: 'MNQ', side: SETUP.side === 'long' ? 'buy' : 'sell', type: 'market', size: 1, stopLossBracket: { ticks: 18, type: 'stop' }, rationale });

/** A role's call with its required lookups (minus the ones `o` leaves out), or none when `o.dropRole` names it. */
function roleStep(o, name, report, phase = null) {
  if (o.dropRole === name || (phase && o.dropRole === phase)) return [];
  const leave = [...((o.noLookup || {})[name] || []), ...((o.outside || {})[name] || [])];
  return [{ role: name, lookups: (o.lookups || REQUIRED_LOOKUPS)[name].filter(s => !leave.includes(s)), report, ...(o.untimed ? { timed: false } : {}) }];
}

/** A report's Data line naming the bar briefing's current versions: what the report cache keys an analyst's report on. */
const dataLine = w => { const b = readBriefing(w.home, 'MNQ'); return `Data: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ')}`; };

/**
 * The head trader's cycle on a bar up to its decision: the loads, the bar briefing, the analysts and risk-manager
 * phase 1, each role's required lookups made inside its own call (`o.cacheable`: the analysts' reports name the
 * briefing's versions, so the report cache keeps them). What follows is the caller's.
 */
function roundSteps(w, o = {}) {
  const skip = new Set(o.skip || []);
  const loads = headLoads(w).filter(s => !skip.has(s));
  return [
    ...loads.map(s => ({ load: s })),
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    ...ANALYSTS.flatMap(a => roleStep(o, a, o.cacheable ? () => `${dataLine(w)}\nBias: long` : `${a}: Bias: long. Data: bar_briefing`)),
    ...roleStep(o, 'risk-manager', 'Phase 1: flat, budget 1 trade, no daily stop', 'phase1'),
  ];
}

/** The model reads the bar and passes (no plan, no phase 2): `CYCLE RESULT: no-trade - <why>`. */
const passCycle = (w, why, o = {}) => [...roundSteps(w, o), ...entryLoads(w).map(s => ({ load: s })), { result: `CYCLE RESULT: no-trade - ${why}` }];

/**
 * The full cycle that enters the setup on the fired bar (order_plan's arguments, sent as they are), every piece
 * present; `o` removes or changes one:
 *   skip: [skills not loaded]          noLookup: { role: [skills] } not looked up
 *   outside: { role: [skills] }        looked up naming the role, outside its calls
 *   dropRole: a role, 'phase1' or 'phase2' that never ran          untimed: true (role calls without times)
 *   facts: (w) => FACTS text           verdict: 'APPROVE' | 'VETO'          act: a step before the executor
 *   rationale: (plan) => text          plan: false (no journal plan)        manual: true (no order_plan: the model's
 *   own arguments, manualArgs)         lookups: the required lookups to make (default REQUIRED_LOOKUPS)
 *   pre: a step before anything else
 *   size: the order's size (default order_plan's)          result: the result line
 */
function entryCycle(w, o = {}) {
  // Read when phase 2 reports, from the briefing the runner wrote for this bar.
  const facts = () => (o.facts ? o.facts(w) : trueFacts(w).join('; '));
  const verdict = o.verdict || 'APPROVE';
  const plan = ctx => (o.manual ? { args: manualArgs(`setup:${SETUP.strategy} ${SETUP.side}, stop 27423.00`), stopPrice: 27423 } : planOf(ctx.results.order_plan));
  const rationale = o.rationale || (p => p.args.rationale);
  return [
    ...(o.pre ? [{ act: o.pre }] : []),
    ...roundSteps(w, o),
    ...Object.entries(o.outside || {}).flatMap(([as, skills]) => skills.map(s => ({ lookup: s, as }))),
    ...entryLoads(w).filter(s => !(o.skip || []).includes(s)).map(s => ({ load: s })),
    ...strategyReads(w).filter(s => !(o.skip || []).includes(s)).map(s => ({ lookup: s })),
    ...(o.manual ? [] : [{ harness: 'order_plan', args: ctx => ({ bars: path.join(ctx.env.FTH_BARS_DIR, 'MNQ-3m.json'), symbol: 'MNQ', strategy: SETUP.strategy, side: SETUP.side, accountId: 7 }) }]),
    ...(o.plan === false ? [] : [{ broker: 'journal_add', args: ctx => ({ kind: 'plan', contractId: 'MNQ', tags: [`setup:${SETUP.strategy}`, 'MNQ'], text: `${SETUP.strategy} ${SETUP.side}, stop ${plan(ctx).stopPrice}` }) }]),
    ...roleStep(o, 'risk-manager', () => `Phase 2 on the ${SETUP.strategy} ${SETUP.side} plan for MNQ.\nVERDICT: ${verdict} - size 1\nFACTS: ${facts()}`, 'phase2'),
    ...(o.act ? [{ act: o.act }] : []),
    ...(verdict === 'APPROVE' ? [{ executor: [{ broker: 'place_order', args: ctx => ({ ...plan(ctx).args, ...(o.size ? { size: o.size } : {}), rationale: rationale(plan(ctx)) }) }] }] : []),
    { result: o.result || (verdict === 'APPROVE' ? `CYCLE RESULT: executed - ${SETUP.strategy} ${SETUP.side} MNQ 1` : `CYCLE RESULT: no-trade - risk-manager vetoed the ${SETUP.strategy} ${SETUP.side}`) },
  ];
}

/** order_plan's reply as the model reads it: { args: the place_order arguments, stopPrice, ticks }. */
function planOf(text) {
  const m = /place_order arguments: (\{.*\})/.exec(String(text));
  if (!m) throw new Error(`order_plan gave no order: ${String(text).slice(0, 300)}`);
  const args = JSON.parse(m[1]);
  return { args, ticks: args.stopLossBracket.ticks, stopPrice: Number(/\| stop (\d+(?:\.\d+)?)/.exec(text)[1]), text: String(text) };
}

/** The gate's decisions (FTH_GATE_LOG). */
const gateLog = w => (fs.existsSync(w.env.FTH_GATE_LOG) ? fs.readFileSync(w.env.FTH_GATE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
/** The cycle log's summary lines (logs/cycles-<day>.jsonl) and records. */
function cycleLines(w) {
  const dir = path.join(w.home, 'logs');
  return fs.readdirSync(dir).filter(f => /^cycles-.*\.jsonl$/.test(f)).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
}
const position = w => exchange.read(w.state).positions.find(p => p.contractId === MNQ_ID) || null;
const working = w => exchange.read(w.state).orders.filter(o => o.status === 1 && o.contractId === MNQ_ID);
const placedAtBroker = w => exchange.read(w.state).calls.filter(c => c.tool === 'place_order');

module.exports = {
  ROOT, SETUP, MNQ_ID, STRATEGY_SKILLS, STEP, BARS, MINUTE_BARS, FIRED_BAR, QUIET_BAR, NEXT_BAR, ANALYSTS, REQUIRED_LOOKUPS, RESULT_ACTION, CACHE_SERVED, headLoads, entryLoads, decisionAt, world, pass, m3Of, m3Version, trueFacts, flip,
  entryCycle, passCycle, roundSteps, manualArgs, planOf, gateLog, cycleLines, position, working, placedAtBroker,
};
