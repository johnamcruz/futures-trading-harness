'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../../scripts/lib/cycle-timing');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { runHarness } = require('../../scripts/lib/harness-run');
const { validateConfig } = require('../../scripts/lib/autotrader');
const report = require('../../scripts/lib/replay/report');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// A 3m bar opened 04:09, closed 04:12; the next closes 04:15. The cycle starts 2 s after the close (a replay's time).
const BAR = '2026-04-28T04:09:00.000Z';
const CLOSE = Date.parse('2026-04-28T04:12:00.000Z');
const NEXT = Date.parse('2026-04-28T04:15:00.000Z');
const CYCLE_AT = CLOSE + 2000;
// The run's wall clock: started at W, each event at W + seconds.
const W = Date.parse('2026-10-14T20:00:00.000Z');
const w = s => W + s * 1000;
const SETUP_BAR = { symbols: [{ symbol: 'MNQ', bar: { t: BAR }, fired: [{ name: 'fx_break', direction: 'long' }] }] };
const QUIET = { symbols: [{ symbol: 'MNQ', bar: { t: BAR }, fired: [] }] };
const jsonl = evs => `${evs.map(e => JSON.stringify(e)).join('\n')}\n`;
const iso = ms => new Date(ms).toISOString();

// opencode run --format json: each finished task call with its own times; the head trader's text with its time.
const ocTask = (role, s, e, extra = {}) => ({ type: 'tool_use', timestamp: w(e), sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: role, ...extra }, output: '<task_result>ok</task_result>', time: { start: w(s), end: w(e) } } } });
const ocText = (text, s) => ({ type: 'text', timestamp: w(s), sessionID: 's', part: { type: 'text', text, time: { start: w(s), end: w(s) } } });
const OPENCODE = jsonl([
  { type: 'step_start', timestamp: w(0), sessionID: 's', part: { type: 'step-start' } },
  ocTask('market-structure-analyst', 1, 21), ocTask('trend-momentum-analyst', 1, 31), ocTask('risk-manager', 32, 40),
  ocTask('risk-manager', 41, 50), ocTask('trade-executor', 51, 55),
  ocText('CYCLE RESULT: executed - fx_break long MNQ 1', 56),
]);

test('timing, opencode: the roles\' own times, the decision at the executor\'s launch, the order from the gate log, on the replay clock', () => {
  const t = T.cycleTiming({ text: OPENCODE, context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(57), cycleAtMs: CYCLE_AT, replay: true, gate: [{ ms: w(53) }], ok: true, result: 'CYCLE RESULT: executed' });
  assert.deepStrictEqual([t.clock, t.barClose, t.nextBarClose, t.start, t.end], ['replay', iso(CLOSE), iso(NEXT), iso(CYCLE_AT), iso(CYCLE_AT + 57000)]);
  assert.deepStrictEqual(t.roles.map(r => [r.role, r.ms]), [['market-structure-analyst', 20000], ['trend-momentum-analyst', 30000], ['risk-manager', 8000], ['risk-manager', 9000], ['trade-executor', 4000]]);
  assert.strictEqual(t.roles[0].start, iso(CYCLE_AT + 1000));
  assert.deepStrictEqual([t.decision, t.decisionFrom, t.order, t.orders], [iso(CYCLE_AT + 51000), 'transcript', iso(CYCLE_AT + 53000), 1]);
  assert.deepStrictEqual(t.latencyMs, { start: 2000, decision: 53000, order: 55000 });
  assert.deepStrictEqual([t.overran, t.setup, t.setupCaught, t.setupMissed], [false, true, true, null]);
  // Ordered: bar close <= start <= the first role's start; the last report <= the decision <= order <= end.
  const ms = x => Date.parse(x);
  const reports = t.roles.filter(r => r.role !== 'trade-executor');
  const seq = [ms(t.barClose), ms(t.start), Math.min(...t.roles.map(r => ms(r.start))), Math.max(...reports.map(r => ms(r.end))), ms(t.decision), ms(t.order), ms(t.end)];
  assert.deepStrictEqual(seq, [...seq].sort((a, b) => a - b));
});

test('timing, opencode pass on a quiet bar: the decision is the result line; no setup, nothing caught or missed', () => {
  const t = T.cycleTiming({ text: jsonl([ocTask('risk-manager', 1, 9), ocText('CYCLE RESULT: no-trade - nothing fired', 10)]), context: QUIET, minutes: 3, startedMs: W, endedMs: w(11), cycleAtMs: CYCLE_AT, ok: true });
  assert.deepStrictEqual([t.clock, t.decision, t.order, t.orders, t.setup, t.overran], ['wall', iso(CYCLE_AT + 10000), null, 0, false, false]);
  assert.ok(!('setupCaught' in t) && !('setupMissed' in t));
  assert.strictEqual(t.latencyMs.decision, 12000);
});

// Claude stream-json: no event times; each line's arrival (harness-run lineTimes) times it.
const CLAUDE = jsonl([
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'market-structure-analyst' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Bias: long' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'risk-manager' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'failed' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o1', name: 'mcp__broker__place_order', input: { contractId: 'MNQ' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'CYCLE RESULT: executed - x' }] } },
  { type: 'result', result: 'CYCLE RESULT: executed - x' },
]);

test('timing, Claude stream-json: tool_use to tool_result by line arrival; an errored role kept as not ok; the order call in the transcript', () => {
  const lineTimes = [0, 2, 14, 15, 25, 30, 33, 34].map(w);
  const t = T.cycleTiming({ text: CLAUDE, lineTimes, context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(35), cycleAtMs: CYCLE_AT, ok: true });
  assert.deepStrictEqual(t.roles.map(r => [r.role, r.ms, r.ok]), [['market-structure-analyst', 12000, undefined], ['risk-manager', 10000, false]]);
  assert.deepStrictEqual([t.order, t.orders, t.decision], [iso(CYCLE_AT + 30000), 1, iso(CYCLE_AT + 30000)]);
  // Without line times or event times: no role time, the decision at the end of a run that wrote its result.
  const u = T.cycleTiming({ text: CLAUDE, context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(35), cycleAtMs: CYCLE_AT, ok: true, result: 'CYCLE RESULT: executed - x' });
  assert.deepStrictEqual([u.roles[0].ms, u.decision, u.decisionFrom, u.setupCaught], [null, iso(CYCLE_AT + 35000), 'end', true]);
});

test('timing, Claude session lines and Qwen parts: the events\' own ISO or ms timestamps', () => {
  const claude = jsonl([
    { type: 'assistant', timestamp: iso(w(1)), message: { content: [{ type: 'tool_use', id: 'a', name: 'Task', input: { subagent_type: 'volume-liquidity-analyst' } }] } },
    { type: 'user', timestamp: iso(w(7)), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'assistant', timestamp: iso(w(8)), message: { content: [{ type: 'text', text: 'CYCLE RESULT: no-trade - skip' }] } },
  ]);
  const c = T.transcriptTimes(claude);
  assert.deepStrictEqual([c.roles.map(r => [r.role, r.end - r.start]), c.decision], [[['volume-liquidity-analyst', 6000]], w(8)]);
  const qwen = jsonl([
    { timestamp: w(2), message: { role: 'model', parts: [{ functionCall: { id: 'q1', name: 'task', args: { subagent_type: 'risk-manager' } } }] } },
    { timestamp: w(9), message: { role: 'user', parts: [{ functionResponse: { id: 'q1', response: { output: 'Phase 1' } } }] } },
    { timestamp: w(10), message: { role: 'model', parts: [{ functionCall: { id: 'q2', name: 'task', args: { subagent_type: 'trend-momentum-analyst' } } }] } },
    { timestamp: w(12), message: { role: 'model', parts: [{ text: 'CYCLE RESULT: no-trade - nothing fired' }] } },
  ]);
  const q = T.transcriptTimes(qwen);
  // The call never answered: started, no end.
  assert.deepStrictEqual(q.roles.map(r => [r.role, r.start, r.end, r.ok]), [['risk-manager', w(2), w(9), true], ['trend-momentum-analyst', w(10), null, false]]);
  assert.strictEqual(q.decision, w(12));
});

test('timing, Qwen\'s JSON array (one document, no times): roles without times; the decision at the run\'s end', () => {
  const doc = JSON.stringify([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Task', input: { subagent_type: 'risk-manager' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'result', result: 'CYCLE RESULT: no-trade - nothing fired' },
  ]);
  const t = T.cycleTiming({ text: doc, lineTimes: [w(40)], context: QUIET, minutes: 3, startedMs: W, endedMs: w(40), cycleAtMs: W, ok: true, result: 'CYCLE RESULT: no-trade - nothing fired' });
  assert.deepStrictEqual([t.roles.map(r => [r.role, r.ms]), t.decision, t.decisionFrom], [[['risk-manager', null]], iso(w(40)), 'end']);
});

test('timing, a missed setup: the decision after the next bar closed (overran); a timeout or an error with no decision', () => {
  // The cycle started 2 s after the close and decided 200 s later: the bar was superseded at the next close.
  const late = T.cycleTiming({ text: jsonl([ocTask('risk-manager', 1, 150), ocText('CYCLE RESULT: no-trade - late', 200)]), context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(201), cycleAtMs: CYCLE_AT, ok: true });
  assert.deepStrictEqual([late.overran, late.setupCaught, late.setupMissed, late.latencyMs.decision], [true, false, 'overran', 202000]);
  assert.ok(Date.parse(late.end) > NEXT && Date.parse(late.decision) > NEXT);
  const timedOut = T.cycleTiming({ text: jsonl([ocTask('risk-manager', 1, 9)]), context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(360), cycleAtMs: CYCLE_AT, ok: false, timedOut: true });
  assert.deepStrictEqual([timedOut.decision, timedOut.overran, timedOut.setupCaught, timedOut.setupMissed], [null, true, false, 'timeout']);
  const failed = T.cycleTiming({ text: 'harness crashed', context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(5), cycleAtMs: CYCLE_AT, ok: false, result: 'CYCLE RESULT: no-trade - x' });
  assert.deepStrictEqual([failed.decision, failed.overran, failed.setupCaught, failed.setupMissed], [null, false, false, 'error']);
  // An order before the deadline catches the setup, whatever the result line's time.
  const ordered = T.cycleTiming({ text: jsonl([ocText('CYCLE RESULT: executed - x', 300)]), context: SETUP_BAR, minutes: 3, startedMs: W, endedMs: w(301), cycleAtMs: CYCLE_AT, gate: [{ ms: w(60) }], ok: true });
  assert.deepStrictEqual([ordered.decision, ordered.setupCaught, ordered.overran], [iso(CYCLE_AT + 60000), true, false]);
});

test('timing: bar windows by lane and symbol; a cycle without bars has no bar times and no setup', () => {
  const two = { symbols: [{ symbol: 'MNQ', lane: '1m', bar: { t: '2026-04-28T04:11:00.000Z' }, fired: [{ name: 'a' }] }, { symbol: 'MNQ', lane: '3m', bar: { t: BAR }, fired: [] }] };
  assert.deepStrictEqual(T.barWindow(two, 3), { barClose: CLOSE, nextClose: CLOSE + 60000, setup: true, deadline: CLOSE + 60000 });
  assert.deepStrictEqual(T.barWindow(null, 3), { barClose: null, nextClose: null, setup: false, deadline: null });
  const t = T.cycleTiming({ text: '', context: { action: 'premarket' }, minutes: 3, startedMs: W, endedMs: w(5), ok: true, result: 'CYCLE RESULT: premarket' });
  assert.deepStrictEqual([t.barClose, t.overran, t.setup, t.latencyMs.decision], [null, null, false, null]);
});

test('timing: the gate log\'s place_order decisions inside the run (hook refusals too), malformed lines skipped', () => {
  const file = path.join(tmpDir(), 'gate.jsonl');
  fs.writeFileSync(file, [
    { ts: iso(w(-5)), source: 'gateway', tool: 'place_order', decision: 'allowed' },
    { ts: iso(w(3)), source: 'hook', decision: 'blocked' },
    'not json', 'null',
    { ts: iso(w(4)), source: 'gateway', tool: 'cancel_order', decision: 'allowed' },
    { ts: iso(w(6)), source: 'gateway', tool: 'place_order', decision: 'allowed' },
    { ts: iso(w(90)), source: 'gateway', tool: 'place_order', decision: 'allowed' },
  ].map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'));
  assert.deepStrictEqual(T.gateOrders(file, W, w(10)), [{ ms: w(3), decision: 'blocked' }, { ms: w(6), decision: 'allowed' }]);
  assert.deepStrictEqual(T.gateOrders(path.join(tmpDir(), 'none.jsonl'), W, w(10)), []);
});

test('timing report: latencies, overruns, setups caught and missed, role medians; split by setup and quiet bars; shown in the replay report', () => {
  const at = (s, o = {}) => T.cycleTiming({ text: jsonl([ocTask('risk-manager', 1, s - 1), ocText('CYCLE RESULT: no-trade - x', s)]), minutes: 3, startedMs: W, endedMs: w(s + 1), cycleAtMs: CYCLE_AT, ok: true, ...o });
  const cycles = [at(20, { context: SETUP_BAR, gate: [{ ms: w(15) }] }), at(200, { context: SETUP_BAR }), at(40, { context: QUIET }), { timing: null }, {}].map(t => ({ timing: t && t.barClose ? t : null }));
  const r = T.timingReport(cycles);
  assert.deepStrictEqual([r.all.cycles, r.setup.cycles, r.quiet.cycles], [3, 2, 1]);
  assert.deepStrictEqual([r.setup.caught, r.setup.missed, r.setup.missedBy, r.all.overran], [1, 1, { overran: 1 }, 1]);
  assert.deepStrictEqual(r.setup.decision, { n: 2, median: 17000, p90: 202000 });
  assert.deepStrictEqual(r.setup.order, { n: 1, median: 17000, p90: 17000 });
  assert.deepStrictEqual(r.all.roleMedianMs, { 'risk-manager': 38000 });
  // The replay report carries it, and prints it under the month table only when a cycle has timing.
  const days = { '2026-04-28': [{ t: iso(CYCLE_AT), kind: 'trade', ran: cycles.slice(0, 3).map(c => ({ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x', ...c })) }] };
  const s = report.summarize(days);
  assert.deepStrictEqual(s.timing, r);
  const text = report.toText(s);
  assert.match(text, /\nsetup timing\nbars +cycles +close to decision p50 \/ p90 +close to order p50 \/ p90 \(n\) +overran +setups caught +missed \(why\)\n/);
  assert.match(text, /\nsetup bars +2 +17\.0s \/ 202\.0s +17\.0s \/ 17\.0s \(1\) +1 +1 +1 \(overran 1\)\n/);
  assert.match(text, /role median: risk-manager 38\.0s\n$/);
  assert.match(report.toMarkdown(s), /## Setup timing[\s\S]*\| quiet bars \| 1 \| 42\.0s \/ 42\.0s \| - \/ - \(0\) \| 0 \| 0 \| 0 \|/);
  const none = report.summarize({ '2026-04-28': [{ t: iso(CYCLE_AT), kind: 'trade', ran: [{ action: 'trade', ok: true }] }] });
  assert.ok(!/setup timing/i.test(report.toText(none) + report.toMarkdown(none)));
});

test('timing in the cycle log: cycle-run records the run\'s timeline on the wall clock live (a refused replay clock too)', async () => {
  for (const extra of [{}, { FTH_REPLAY_NOW: '2026-04-28T04:12:02Z' }]) {
    const home = tmpDir();
    let wall = W;
    const run = async () => {
      wall = w(30);
      return { ok: true, timedOut: false, code: 0, output: jsonl([ocTask('risk-manager', 2, 12), ocText('CYCLE RESULT: no-trade - skip', 29)]) };
    };
    const now = new Date(CYCLE_AT);
    const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'], timeframe: 3 });
    const env = { FTH_HOME: home, HOME: home, PATH: process.env.PATH, FTH_GATE_LOG: path.join(home, 'g.jsonl'), ...extra };
    fs.writeFileSync(env.FTH_GATE_LOG, `${JSON.stringify({ ts: iso(w(20)), source: 'gateway', tool: 'place_order', decision: 'blocked' })}\n`);
    await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 1000, context: SETUP_BAR }, { root: ROOT, home, env, run, now: () => now, wallNow: () => wall, guard: () => true });
    const dir = path.join(home, 'logs');
    const line = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.startsWith('cycles-'))), 'utf8').trim());
    assert.deepStrictEqual([line.timing.clock, line.timing.start, line.timing.decision, line.timing.order, line.timing.end], ['wall', iso(CYCLE_AT), iso(CYCLE_AT + 20000), iso(CYCLE_AT + 20000), iso(CYCLE_AT + 30000)]);
    assert.deepStrictEqual([line.timing.setupCaught, line.timing.roles[0].ms], [true, 10000]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(line.file, 'utf8')).timing, line.timing);
  }
});

test('harness run: each standard-output line\'s arrival time, in order (lineTimes)', async () => {
  // Each line is the time the child wrote it: its arrival is never before that, and arrivals are in order.
  const child = 'const p = () => process.stdout.write(Date.now() + "\\n"); p(); p(); setTimeout(p, 50); process.stderr.write("err\\n")';
  const r = await runHarness([process.execPath, '-e', child], { cwd: ROOT, env: { PATH: process.env.PATH }, timeoutMs: 10000 });
  const written = r.stdout.trim().split('\n').map(Number);
  assert.strictEqual(written.length, 3);
  assert.strictEqual(r.lineTimes.length, 3);
  assert.ok(r.lineTimes.every((t, i) => t >= written[i] && (i === 0 || t >= r.lineTimes[i - 1])), JSON.stringify({ written, at: r.lineTimes }));
  assert.ok(r.lineTimes[2] >= written[0] + 40, 'the late line arrived late');
});
