'use strict';

/**
 * The goal regression's tier 2 world (tests/goal/tier2*.goal.js; docs/TRAINING.md, "The goal regression"): one fixture
 * session through the live path as the harness wires it (the decision-path world, tests/fixtures/decision-path.js): the
 * runner (runner-wiring.js wireRunner) at a replayed time, one pass per closed bar, its cycle run by the production glue
 * (cycle-run.js) with a deterministic mock policy in place of the model (scripted-model.js), the desk scripted, the
 * runner's entry running risk-manager phase 2 and the trade-executor through their own runs, the order through the real
 * gateway and gate to the mock exchange as a replay broker serving the fixture's bars (3m, and 1m built from them for
 * the late-entry check), in a running prop attempt on the shipped policy and account. Between passes the exchange's
 * price walks each bar's path (open, its far extreme, its other extreme, close: golden-bars.js toMinutes), so
 * stops, limits and brackets fill inside the bar as a replay broker's simulated fills do.
 *
 * The mock policy follows the plan exactly, every bar, from the briefing the runner wrote:
 *   flat, entries allowed: the side the Bias line gives (bias-line.js); the first setup that side's way, in order: a
 *   cited rules setup the scan fired on the bar (m3.candidates: momentum_continuation), else a setup on the "Setups to
 *   check" line (its quoted read: the 15m reaction, CISD or compression break) with the bar's confirming 3m read
 *   (setup-library.js entryRead); compose_check with that setup's reads (the briefing's Standard plan's reads when it
 *   plans that setup OK); OK: `planned`; NOT OK: no-trade with the first problem; nothing: no-trade
 *   phase 2: `VERDICT: APPROVE - size <the size its request names>` with true FACTS; the executor sends the runner's
 *   arguments as given; with a position: hold, never touch the stop (the runner's own exit manages it)
 *
 * It orders at the earliest the runner allows: no model latency is modelled (nothing waits, the replay clock is the pass's).
 *
 *   dayWorld(bars, day, { account, fault })   the world (a harness home, the exchange, the runner config); fault: a
 *                                              broker fault armed before the day's first order (FAULTS)
 *   runDay(w, { breaks })                      plays the day: { passes, events, logs, decisions } (decisions: per pass
 *                                              the mock's choice and why); breaks.latencyMs: the order-latency
 *                                              self-test's injected stub only (tests/goal/tier2-breaks.goal.js): the
 *                                              replay clock and the market moved on before the executor's order; the
 *                                              other breaks patch the shipped code itself (tests/goal/breaks.js)
 *   artifacts(w)                               { sent, faults, snaps, records, cycles, gate, fills, orders, calls,
 *                                              attempt } read from the home and the exchange
 */

const fs = require('fs');
const path = require('path');
const exchange = require('./mock-exchange');
const { scriptedModel } = require('./scripted-model');
const { toMinutes } = require('./golden-bars');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { openAdapter } = require('../../scripts/lib/broker/adapter');
const { wireRunner, closedBarsOnly } = require('../../scripts/lib/runner-wiring');
const { runCycle, runRole: realRunRole } = require('../../scripts/lib/cycle-run');
const { readBriefing, renderBriefing } = require('../../scripts/lib/trading/briefing');
const { biasSides, biasLine } = require('../../scripts/lib/trading/bias-line');
const { entryRead, runnerClock } = require('../../scripts/lib/learning/setup-library');
const { trendRuleOf } = require('../../scripts/lib/trading/reasons');
const { tradingDayKey, minutesOfDay } = require('../../scripts/lib/trading/clock');
const prop = require('../../scripts/lib/trading/prop-state');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { holidayDates } = require('../../scripts/lib/replay/schedule');
const { requiredFor, needed } = require('../../scripts/lib/trading/skill-lookups');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const MNQ_ID = 'fake:MNQ:Z26';
const STEP = 180000;
const SLIP = require('../../scripts/lib/replay/counterfactual').SLIPPAGE_TICKS * require('../../scripts/lib/trading/contracts').tickOf('MNQ');
const ET = 'America/New_York';
// The mock trades the curation session (config/replay.json trendCapture.curationSessions, the PPC trend set's and the
// mechanical tier's): passes from its start; after its entry window, passes only while something is open.
const CUR = require('../../scripts/lib/trading/clock').parseWindows(require('../../scripts/lib/tunables').replay().trendCapture.curationSessions.join(',')).windows[0];
// Entries in the session's first tier2.entryMinutes (config/training.json goalRegression.tier2): a quick run's window.
const SESSION = { from: CUR.start, entriesUntil: Math.min(CUR.end, CUR.start + require('../../scripts/lib/tunables').training().goalRegression.tier2.entryMinutes) };
const DECIDE_MS = 2000; // a replay's decision time: 2 s after its bar closed (decision-path.js decisionAt)

const iso = ms => new Date(ms).toISOString();
const minuteOf = ms => minutesOfDay(new Date(ms), ET);

function dayWorld(bars, day, { account, suggest = 3, fault = null, state = null, probe = false } = {}) {
  if (fault && !FAULTS[fault]) throw new Error(`fault ${fault}: one of ${Object.keys(FAULTS).join(', ')}`);
  const home = tmpDir();
  recordBrokerSpecs(home, { broker: 'replaymock', roots: ['MNQ', 'NQ', 'MES', 'ES'] });
  recordBrokerSpecs(home, { broker: 'replaymock', roots: ['MNQ', 'NQ', 'MES', 'ES'], day });
  const statePath = path.join(home, 'exchange.json');
  const journal = path.join(home, 'journal.jsonl');
  const clock = path.join(home, 'clock.json');
  fs.writeFileSync(journal, '');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'replaymock',
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, limits: { dailyLoss: 'MOCK_MAX_DAILY_LOSS', maxOrderSize: 'MOCK_MAX_ORDER_SIZE', maxPositionSize: 'MOCK_MAX_POSITION_SIZE' }, journal, allowedAccountsEnv: 'MOCK_ALLOWED_ACCOUNTS', env: ['MOCK_STATE', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_ALLOWED_ACCOUNTS', 'MOCK_MAX_ORDER_SIZE', 'MOCK_JOURNAL_CLOCK'] } },
  }));
  const list = bars.map(b => ({ ...b, ms: Date.parse(b.t) }));
  const dayBars = list.filter(b => tradingDayKey(new Date(b.ms)) === day);
  // The 1m bars the late-entry check reads (the newest closed one): the day's only, so the exchange's state stays small.
  const minute = toMinutes(dayBars).map(({ ms: _ms, ...b }) => b);
  const first = dayBars[0];
  exchange.initState(statePath, { nowMs: first.ms, prices: { [MNQ_ID]: first.o }, balance: account.starting_balance, bars: { [MNQ_ID]: bars, [`${MNQ_ID}@1m`]: minute } });
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, NODE_ENV: 'test',
    MOCK_STATE: statePath, MOCK_JOURNAL: journal, MOCK_CLOCK_FILE: clock, MOCK_REPLAY: '1', MOCK_ALLOWED_ACCOUNTS: '7', MOCK_MAX_ORDER_SIZE: '50', MOCK_JOURNAL_CLOCK: '1',
    FTH_GATE_LOG: path.join(home, 'gate.jsonl'), FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'),
    // A deliberate break (tests/goal/breaks.js) reaches every harness process the runner and the model start.
    ...(process.env.FTH_GOAL_BREAK ? { FTH_GOAL_BREAK: process.env.FTH_GOAL_BREAK, NODE_OPTIONS: `--require ${JSON.stringify(path.join(ROOT, 'tests', 'goal', 'breaks.js'))}` } : {}),
  };
  // The exchange calendar as the runner's clock has it (setup-library.js runnerClock): the day's closed and early dates.
  const h = holidayDates(new Date(`${day}T00:00:00Z`), new Date(`${day}T00:00:00Z`));
  const cfg = validateConfig({ harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: bars.length, closedDates: h.closed, earlyCloseDates: h.early });
  // A mid-attempt state (the state days): the attempt started a session earlier and closed it at `balance` (the
  // exchange's balance with it), so the cushion, the floor and the room to the target are that state's.
  if (state) {
    prop.startAttempt(home, account, new Date(first.ms - 86400000));
    prop.recordEndOfDay(home, account, account.starting_balance + state.pnl, state.prevDay);
    exchange.update(statePath, x => { x.balance = account.starting_balance + state.pnl; });
  } else prop.startAttempt(home, account, new Date(first.ms));
  // The runner's end of day for the session (setup-library.js runnerClock: its sessions and the calendar's early closes).
  const eodMs = runnerClock({ from: day, to: day }).eodOf(dayBars.at(-1).ms);
  return { probe, probes: [], sent: [], faults: [], snaps: [], fault, faulted: false, walkedTo: -Infinity, clockMs: first.ms, eodMs, home, state: statePath, journal, clock, env, cfg, day, list, dayBars, account, suggest, stateFile: path.join(home, 'runner-state.json') };
}

/** The quoted reads of the briefing's "Setups to check" line, each with the side it points. */
function listedSetups(summary) {
  const line = String(summary || '').split('\n').find(l => /^- Setups to check/.test(l));
  if (!line) return [];
  return [...line.matchAll(/"([^"]+)" \((long|short)/g)].map(m => ({ read: m[1], side: m[2] }));
}

// The briefing as the model reads it (briefing.js renderBriefing: its summary lines, the Bias line, Setups to check).
const summaryOf = b => (b && b.sections ? renderBriefing(b, { now: new Date(Date.parse(b.closedAt)) }) : '');
const m3Of = b => (b && b.sections && b.sections.m3 ? b.sections.m3.data : null);
const way = side => (side === 'long' ? 'up' : 'down');

/** The briefing's Standard plan reads for a side, when that plan is OK (setup-library.js planLine). */
function standardReads(summary, side) {
  const line = String(summary || '').split('\n').find(l => /^- Standard plan/.test(l));
  if (!line) return null;
  const part = line.split('; ').join(';').split(/(?=\b(?:long|short) ")/).find(p => p.startsWith(`${side} "`));
  if (!part || !/plan OK/.test(part)) return null;
  const reads = /reads (.*)$/.exec(part);
  return reads ? [...reads[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : null;
}

const SKILL = { bias: 'htf-to-ltf', location: 'vwap-volume-profile', setup: 'trade-lifecycle', entry: 'candle-reading', stop: 'invalidation', target: 'take-profit' };
const read = (step, text) => ({ step, skill: SKILL[step], read: text, why: `the mock policy's ${step}` });

/** The mock's choice on this bar's briefing: { side, setup, reads } or { pass: why }. */
function decide(b) {
  const m3 = m3Of(b);
  if (!m3) return { pass: 'no briefing' };
  if (m3.windowEntries !== 'allowed') return { pass: 'no entries in this window' };
  const sides = biasSides(b);
  const side = ['long', 'short'].find(s => sides[s] && !sides[s === 'long' ? 'short' : 'long']);
  if (!side) return { pass: 'the Bias line gives no side' };
  const summary = summaryOf(b);
  const cand = (m3.candidates || []).filter(c => c.direction === side);
  const listed = listedSetups(summary).filter(x => x.side === side);
  const vwap = m3.vwap && m3.vwap.side ? read('location', `vwap ${m3.vwap.side}`) : null;
  const c3 = m3.candles && m3.candles['3m'];
  const bias = read('bias', `trend ${side} allowed`);
  if (cand.length) {
    const c = cand[0];
    const entry = c3 && c3.momentum === way(side) ? `3m momentum ${way(side)}` : entryRead(c3, side, '3m');
    return { side, setup: `${c.name} fired ${way(side)}`, kind: 'cited', reads: [bias, vwap, read('setup', `${c.name} fired ${way(side)}`), read('entry', entry || `3m close ${side === 'long' ? 'top' : 'bottom'}`), read('stop', `stop 3m ${side === 'long' ? 'low' : 'high'} ${side === 'long' ? c3.l : c3.h}`), read('target', 'target 2r')].filter(Boolean) };
  }
  // The first valid listed setup: the one the briefing's Standard plan composes OK (its reads, as the briefing gives
  // them), else the first listed with the bar's confirming 3m read.
  const std = standardReads(summary, side);
  const planned = std ? listed.find(x => std.includes(x.read)) : null;
  if (planned) return { side, setup: planned.read, kind: 'standard', reads: std.map((r, i) => read(['bias', 'location', 'setup', 'entry', 'stop', 'target'][i] || 'setup', r)) };
  for (const x of listed) {
    const entry = entryRead(c3, side, '3m');
    const c15 = m3.candles && m3.candles['15m'];
    if (!entry || !c15) continue;
    return { side, setup: x.read, kind: 'listed', reads: [bias, vwap, read('setup', x.read), read('entry', entry), read('stop', `stop 15m ${side === 'long' ? 'low' : 'high'} ${side === 'long' ? c15.l : c15.h}`), read('target', 'target trail')].filter(Boolean) };
  }
  return { pass: listedSetups(summary).length || (m3.candidates || []).length ? 'no setup the side\'s way' : 'no setup listed' };
}

/** The head trader's cycle: the briefing, then the mock's choice composed, or a pass; with a position, hold. */
function headScript(w, decisions) {
  return () => {
    const b = readBriefing(w.home, 'MNQ');
    const open = exchange.read(w.state).positions.some(p => p.contractId === MNQ_ID);
    if (open) return [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, ...(w.probe && !w.probedOpen && w.lastArgs ? openProbes(w) : []), { result: 'CYCLE RESULT: managed - holding, the stop untouched (the runner\'s exit manages it)' }];
    const d = decide(b);
    // The counter-bias probe (a probe day): on the first bar the Bias line gives a side, before any compose or verdict, an
    // entry under the policy the other way: the policy's entry rule refuses it ([entry-rule]).
    const sides = biasSides(b);
    const biasSide = ['long', 'short'].find(x => sides[x] && !sides[x === 'long' ? 'short' : 'long']);
    const biasProbe = w.probe && !w.probedBias && biasSide && m3Of(b) && m3Of(b).windowEntries === 'allowed' ? (() => {
      w.probedBias = true;
      const other = biasSide === 'long' ? 'sell' : 'buy';
      return probeStep(w, 'counter-bias, no verdict', { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: other, type: 'market', size: w.suggest, stopLossBracket: { ticks: 80, type: 'stop' }, takeProfitBracket: { ticks: 160, type: 'limit' }, rationale: `setup:prop_portfolio ${other === 'buy' ? 'long' : 'short'} against the Bias line (a probe)` } });
    })() : [];
    // The no-15m-setup probe: a combination whose setup is a 3m read, composed before the plan's own (compose refuses it).
    const setupProbe = w.probe && !w.probedSetup && !d.pass ? (() => { w.probedSetup = true; return [{ harness: 'compose_check', args: { symbol: 'MNQ', side: d.side, reads: d.reads.map(r => (r.step === 'setup' ? { ...r, read: `3m bos ${d.side === 'long' ? 'up' : 'down'}` } : r)), size: w.suggest } }, { act: ctx => w.probes.push({ name: 'no 15m setup', kind: 'compose', text: String(ctx.results.compose_check || '') }) }]; })() : [];
    const bar = m3Of(b) && m3Of(b).bar ? m3Of(b).bar.t : null;
    decisions.push({ bar, bias: biasLine(b), ...d });
    if (d.pass) return [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, ...biasProbe, { result: `CYCLE RESULT: no-trade - ${d.pass}` }];
    // A composed rejection, break or sweep needs its reaction read (candle-reading: skills-loaded.js SITUATIONAL). The mock
    // composes first and reacts to compose_check's READ FIRST line as a live head trader would: it looks the skill up and
    // composes again (the warning's path, warn -> lookup -> compose again); without it the gate refuses the entry.
    const compose = { harness: 'compose_check', args: { symbol: 'MNQ', side: d.side, reads: d.reads, size: w.suggest } };
    const react = { then: ctx => (/READ FIRST: [^\n]*candle-reading/.test(String(ctx.results.compose_check || '')) ? [{ harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { ...compose }] : []) };
    return [
      { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
      ...biasProbe,
      ...setupProbe,
      compose,
      react,
      { result: ctx => {
        const text = String(ctx.results.compose_check || '');
        const ok = /OK: every read verified/.test(text) && !/NOT OK/.test(text);
        d.compose = ok ? 'ok' : (/^(?:FALSE|NOT OK|-).*$/m.exec(text) || [text.slice(0, 200)])[0];
        return ok ? `CYCLE RESULT: planned - trade_lifecycle ${d.side} ${w.suggest}` : `CYCLE RESULT: no-trade - compose_check refused: ${d.compose}`;
      } },
    ];
  };
}

const named = prompt => { const m = /The entry's size is (\d+) MNQ/.exec(prompt); return m ? Number(m[1]) : null; };
const requestedArgs = prompt => JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(prompt)[1]);

/** True FACTS by the briefing: the trend rule for the side, the VWAP side, the prior value (decision-path.js trueFacts). */
function trueFacts(w, side) {
  const m3 = m3Of(readBriefing(w.home, 'MNQ'));
  return [`trend ${side} ${trendRuleOf(m3.trendRule)[side] ? 'allowed' : 'blocked'}`, `vwap ${m3.vwap.side}`, `value ${m3.location.priorValue}`];
}

// A desk role's report, with the lookups its skill index requires on this bar (skill-lookups.js needed: the gate's rule).
const deskReport = (w, role) => ({
  ok: true, timedOut: false, output: '', lookups: needed(role, requiredFor(ROOT), m3Of(readBriefing(w.home, 'MNQ'))).map(r => r.skill),
  tools: [role === 'risk-manager' ? 'broker_get_account_snapshot' : 'harness_bar_briefing'],
  text: role === 'risk-manager' ? '## Risk state: account 7 @ now\nTradable: yes' : `## ${role}\nData: bar_briefing m3@x\nBias: per the Bias line`,
});

/** The runner's runRole: the desk scripted, phase 2 and the executor through the production glue (entry-workflow-e2e). */
function roles(w, at, opts) {
  const runRole = async (role, request, limits) => {
    const isPhase2 = role === 'risk-manager' && /^Phase 2, plan verdict/.test(request);
    const restate = role === 'risk-manager' && /^Phase 2, restate/.test(request);
    if (!isPhase2 && !restate && role !== 'trade-executor') return deskReport(w, role);
    const side = /trade_lifecycle (long|short)/.exec(request);
    const s = side ? side[1] : 'long';
    let script;
    if (isPhase2 || restate) {
      const size = named(request);
      const verdict = `APPROVE - size ${size ?? w.suggest}`;
      script = () => [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { result: () => `Phase 2 on the trade_lifecycle ${s} plan for MNQ.\nVERDICT: ${verdict}\nFACTS: ${trueFacts(w, s).join('; ')}` }];
    } else {
      // The order-latency self-test only (an injected stub, never in the normal run): the replay clock and the market
      // moved on before the executor's calls; nothing waits.
      if (opts.latencyMs) advance(w, opts.latencyMs);
      // A broker fault (the fault days): armed on the exchange around the day's first order (before it, or just after it
      // for the faults the order's own reads would use up first).
      const arm = !w.fault || w.faulted ? null : () => { w.faulted = true; exchange.update(w.state, x => Object.assign(x, FAULTS[w.fault].arm(x))); w.faults.push({ at: iso(w.clockMs), kind: w.fault }); };
      script = prompt => {
        const args = requestedArgs(prompt);
        w.lastArgs = args;
        return [
          { broker: 'get_account_snapshot', args: { accountId: 7 } },
          ...(arm && !FAULTS[w.fault].after ? [{ act: arm }] : []),
          // The negative probes (a probe day): entries the gate must refuse, each before the real order.
          ...(w.probe && !w.probedEntry ? entryProbes(w, args) : []),
          { broker: 'place_order', args },
          ...(arm && FAULTS[w.fault].after ? [{ act: arm }] : []),
          { result: ctx => { const c = ctx.calls.filter(x => x.tool === 'place_order').at(-1); return c && c.ok && !/Blocked by/.test(c.text) ? `EXECUTED\nOrders: ${c.text.slice(0, 120)}` : `BLOCKED\n${c ? c.text.slice(0, 600) : 'no reply'}`; } },
        ];
      };
    }
    const model = scriptedModel(script, { format: 'opencode' });
    const roleAt = iso(w.clockMs);
    // When the executor's order goes, by the replay clock (the trace's order step: seconds from the bar close).
    if (role === 'trade-executor') w.sent.push({ at: roleAt, barClose: iso(Date.parse(at) - DECIDE_MS) });
    return realRunRole(w.cfg, role, request, limits, { root: ROOT, home: w.home, env: { ...w.env, FTH_REPLAY_NOW: roleAt }, run: (argv, o2) => model(argv, o2) });
  };
  return runRole;
}

/**
 * The negative probes (a probe day, tests/goal/tier2-probes.goal.js): orders the gate must refuse, sent by the mock
 * through the real gateway, each reply kept with its refusal tags (w.probes). At the first entry, before the real order:
 * the side against the Bias line (not the record's: the entry rule), a size above the verdict's, one below the
 * rulebook's floor, the order with no bracket stop. With the position open, the next pass: a second entry (and its
 * record expired by then), and the bracket stop moved to loosen the risk.
 */
const probeStep = (w, name, call) => [call, { act: ctx => { const c = ctx.calls.at(-1); w.probes.push({ name, kind: call.broker, text: c ? c.text : 'no call', ok: Boolean(c && c.ok) }); } }];
function entryProbes(w, args) {
  w.probedEntry = true;
  const other = args.side === 'buy' ? 'sell' : 'buy';
  const { stopLossBracket: _s, ...bare } = args;
  return [
    ...probeStep(w, 'counter-bias', { broker: 'place_order', args: { ...args, side: other, rationale: `setup:prop_portfolio ${other === 'buy' ? 'long' : 'short'} against the bias (a probe)` } }),
    ...probeStep(w, 'size above the verdict', { broker: 'place_order', args: { ...args, size: args.size + 1 } }),
    ...probeStep(w, 'size below the floor', { broker: 'place_order', args: { ...args, size: 1 } }),
    ...probeStep(w, 'no bracket stop', { broker: 'place_order', args: bare }),
  ];
}
function openProbes(w) {
  w.probedOpen = true;
  const x = exchange.read(w.state);
  const stop = x.orders.find(o => o.status === 1 && o.contractId === MNQ_ID && o.type === 4);
  const loosen = stop ? stop.stopPrice + (stop.side === 1 ? -1 : 1) * cfgTicks(w) : null;
  return [
    ...probeStep(w, 'a second position while one is open', { broker: 'place_order', args: w.lastArgs }),
    ...(stop ? probeStep(w, 'the stop moved to loosen the risk', { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: loosen } }) : []),
  ];
}
// How far the loosening probe moves the stop: the stop's own distance again (twice the risk).
const cfgTicks = w => Math.abs(w.lastArgs.stopLossBracket.ticks) * 0.25;

/**
 * The broker faults of the fault days (tests/goal/tier2.goal.js), each armed on the mock exchange just before the day's
 * first order (mock-exchange.js's switches): the order's reply lost, the fill reported late, the stop's modify refused
 * or errored (the runner's first trail moves), a partial fill. Nothing waits: each is a reply or a read, not a delay.
 */
const FAULTS = Object.freeze({
  'lost-reply': { arm: () => ({ loseEntryReply: true }), disarm: () => ({ loseEntryReply: false }) },
  'late-fill': { after: true, arm: () => ({ latePositions: 3 }), disarm: () => ({}) },
  // The fill reported late for longer: the gate's own reads miss the position too (only its ledger knows the entry).
  'late-fill-long': { after: true, arm: () => ({ latePositions: 40 }), disarm: () => ({}) },
  'modify-refused': { after: true, arm: () => ({ modifyFaults: 2, modifyReply: 'refuse' }), disarm: () => ({}) },
  'modify-error': { after: true, arm: () => ({ modifyFaults: 2, modifyReply: 'error' }), disarm: () => ({}) },
  'partial-fill': { arm: () => ({ partialEntry: 1 }), disarm: () => ({}) },
});

/**
 * The replay clock `by` ms on from where it stands (a virtual offset: nothing waits): the clock file (the broker's
 * clock) moved, and every bar closed by then walked on the exchange (its stops and limits fill inside it).
 */
function advance(w, by) {
  if (!(by > 0)) return;
  const t = w.clockMs + by;
  for (const b of w.list.filter(x => x.ms + STEP > w.walkedTo && x.ms + STEP <= t)) { walk(w, b); w.walkedTo = b.ms + STEP; }
  w.clockMs = t;
  fs.writeFileSync(w.clock, JSON.stringify({ now: iso(t) }));
  exchange.update(w.state, x => { x.nowMs = t; });
}

/** One pass of the runner at `at`. */
async function pass(w, at, script, opts, sink) {
  const ms = Date.parse(at);
  w.clockMs = ms;
  fs.writeFileSync(w.clock, JSON.stringify({ now: at }));
  exchange.update(w.state, x => { x.nowMs = ms; });
  const env = { ...w.env, FTH_REPLAY_NOW: at };
  // The runner's clock: the pass's time (moved on only by the order-latency self-test's injected stub).
  const now = () => new Date(w.clockMs);
  const model = scriptedModel(script, { format: 'opencode' });
  const client = openAdapter({ root: ROOT, env, timeoutMs: 30000 });
  try {
    const runner = wireRunner({
      cfg: w.cfg, root: ROOT, home: w.home, env, client: closedBarsOnly(client, now), dataDir: w.cfg.dataDir, now,
      runRole: roles(w, at, opts),
      prop: require('../../scripts/lib/prop/live-runner').createPropHooks({ root: ROOT, env, home: w.home, client, accountId: w.cfg.account, strategies: () => require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, env).strategies, log: m => sink.logs.push(m) }),
      runCycle: async (action, prompt, limits) => runCycle(w.cfg, action, prompt, {}, limits, { root: ROOT, home: w.home, env, run: model, guard: () => true }),
      loadState: () => (fs.existsSync(w.stateFile) ? JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) : null),
      saveState: x => fs.writeFileSync(w.stateFile, JSON.stringify(x)),
      killSwitchFile: w.env.FTH_KILL_SWITCH_FILE, log: (m, level) => sink.logs.push(`${level || 'info'} ${m}`), event: e => sink.events.push({ at: iso(w.clockMs), ...e }),
    });
    await runner.step();
  } finally {
    client.close();
  }
  if (w.fault && w.faulted) exchange.update(w.state, x => Object.assign(x, FAULTS[w.fault].disarm(x)));
  // What the account held after the pass: the position and the stops covering it (the fault checks read these).
  const x = exchange.read(w.state);
  const pos = x.positions.find(p => p.contractId === MNQ_ID) || null;
  const stops = x.orders.filter(o => o.status === 1 && o.contractId === MNQ_ID && o.type === 4).map(o => ({ side: o.side, size: o.size, price: o.stopPrice }));
  w.snaps.push({ at: iso(w.clockMs), position: pos ? { side: pos.type === 1 ? 'long' : 'short', size: pos.size, price: pos.averagePrice } : null, stops });
}

/**
 * The bar's price path (open, its far extreme, its other extreme, close), walked on the exchange inside the bar. The
 * price moves continuously along each leg, as a replay broker's simulated fills see it: a working order the leg crosses
 * triggers at its own price (a stop one tick past it, the replay's stop slippage: replay/counterfactual.js
 * SLIPPAGE_TICKS; a limit at its limit), in the order the leg reaches them, never at the leg's far end.
 */
function walk(w, b) {
  const up = b.c >= b.o;
  // Nothing working: only the close matters (a market order fills at the price the bar closed at).
  const pts = openAt(w) ? [b.o, up ? b.l : b.h, up ? b.h : b.l, b.c] : [b.c];
  let prev = exchange.read(w.state).prices[MNQ_ID];
  pts.forEach((p, k) => {
    exchange.update(w.state, s => { s.nowMs = b.ms + Math.round((k * STEP) / pts.length); });
    const seen = new Set();
    for (let hit = triggerOn(w, prev, p); hit !== null && !seen.has(hit.level); hit = triggerOn(w, prev, p)) { seen.add(hit.level); exchange.setPrice(w.state, MNQ_ID, hit.at); prev = hit.level; }
    exchange.setPrice(w.state, MNQ_ID, p);
    prev = p;
  });
}

/** The first working order a move from `from` to `to` crosses: { level, at } (at: the price it fills from), or null. */
function triggerOn(w, from, to) {
  if (!Number.isFinite(from) || from === to) return null;
  const down = to < from;
  const between = x => (down ? x <= from && x >= to : x >= from && x <= to);
  const hits = exchange.read(w.state).orders.filter(o => o.status === 1 && o.contractId === MNQ_ID).flatMap(o => {
    if (o.type === 4 && (o.side === 1) === down && between(o.stopPrice) && o.stopPrice !== from) return [{ level: o.stopPrice, at: down ? Math.max(to, o.stopPrice - SLIP) : Math.min(to, o.stopPrice + SLIP) }];
    if (o.type === 1 && (o.side === 0) === down && between(o.limitPrice) && o.limitPrice !== from) return [{ level: o.limitPrice, at: o.limitPrice }];
    return [];
  }).sort((x, y) => Math.abs(x.level - from) - Math.abs(y.level - from));
  return hits[0] || null;
}

const openAt = w => { const s = exchange.read(w.state); return s.positions.some(p => p.contractId === MNQ_ID) || s.orders.some(o => o.status === 1 && o.contractId === MNQ_ID); };

async function runDay(w, { breaks = {} } = {}) {
  const sink = { logs: [], events: [], passes: 0 };
  const decisions = [];
  // Before the session: no pass (the policy trades the curation session; the price is the last close).
  let rth = false;
  for (const b of w.dayBars) {
    const close = b.ms + STEP;
    const m = minuteOf(close);
    if (close > w.eodMs && rth) break;
    if (m <= SESSION.from || close > w.eodMs) continue;
    rth = true;
    // A bar the replay clock already ran past (the latency self-test's stub): live polls only the newest bar after it.
    if (close <= w.walkedTo) continue;
    walk(w, b);
    w.walkedTo = close;
    const open = openAt(w);
    if (m > SESSION.entriesUntil && !open) continue;
    await pass(w, iso(close + DECIDE_MS), headScript(w, decisions), breaks, sink);
    sink.passes += 1;
  }
  // The end of the day: one pass after the session's close (the runner's flatten and the attempt's daily record).
  const last = w.dayBars.filter(b => b.ms + STEP <= w.eodMs).at(-1);
  await pass(w, iso(Math.max(last.ms + STEP + DECIDE_MS + STEP, w.walkedTo + DECIDE_MS)), headScript(w, decisions), breaks, sink);
  sink.passes += 1;
  return { ...sink, decisions };
}

const jsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function artifacts(w) {
  const s = exchange.read(w.state);
  const dir = path.join(w.home, 'logs');
  // Each cycle's line; an entry cycle's full entry record (its phase 2, sizes, timing) from the cycle's own file.
  const full = l => { try { return JSON.parse(fs.readFileSync(l.file, 'utf8')).entry || l.entry; } catch (_err) { return l.entry; } };
  const cycles = (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^cycles-.*\.jsonl$/.test(f)).sort().flatMap(f => jsonl(path.join(dir, f))) : [])
    .map(l => ({ at: l.at, result: l.result, timing: l.timing, ...(l.entry ? { entry: full(l) } : {}) }));
  const attempt = (() => { try { return prop.readAttempt(w.home, w.account.name); } catch (_err) { return null; } })();
  const records = TL.readRecords(w.home, 'MNQ').map(r => ({ id: r.id, at: r.at, ok: r.ok, side: r.side, cycleBar: r.bar, plan: r.plan, problems: r.problems }));
  const calls = s.calls.filter(c => ['place_order', 'modify_order', 'cancel_order', 'close_position'].includes(c.tool));
  const faultState = { latePositions: s.latePositions || 0, partialEntry: s.partialEntry || 0, modifyFaults: s.modifyFaults || 0 };
  return { probes: w.probes, faultState, sent: w.sent, faults: w.faults, snaps: w.snaps, records, cycles, gate: jsonl(w.env.FTH_GATE_LOG), fills: s.fills, orders: s.orders.map(({ brackets, ...o }) => ({ ...o, brackets })), calls, attempt };
}

module.exports = { MNQ_ID, STEP, SESSION, dayWorld, runDay, artifacts, decide, listedSetups, standardReads };
