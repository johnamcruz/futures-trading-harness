'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const AT = new Date('2026-10-07T14:03:02Z');

function deps(home, run, over = {}) {
  const out = [];
  const err = [];
  const logged = [];
  return {
    out, err, logged,
    deps: { root: ROOT, home, env: { FTH_HOME: home, HOME: home, PATH: process.env.PATH }, run, out: t => out.push(t), err: t => err.push(t), appendLog: (now, t) => logged.push(t), now: () => AT, guard: () => true, ...over },
  };
}

test('cycle run: the injected run gets the cycle\'s argv and environment, the transcript file live; the cycle log and the outcome follow', async () => {
  const home = tmpDir();
  const seen = [];
  const run = async (argv, o) => {
    seen.push({ argv, o });
    fs.mkdirSync(path.dirname(o.liveFile), { recursive: true });
    fs.appendFileSync(o.liveFile, '{"type":"text","part":{"type":"text","text":"x"}}\n');
    return { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - nothing fired\n', stdout: 'CYCLE RESULT: no-trade - nothing fired\n' };
  };
  const d = deps(home, run);
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const context = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] };
  const r = await runCycle(cfg, 'trade', 'the prompt', {}, { timeoutMs: 1000, context }, d.deps);
  assert.deepStrictEqual([r.ok, r.result], [true, 'CYCLE RESULT: no-trade - nothing fired']);
  const { argv, o } = seen[0];
  assert.deepStrictEqual(argv.slice(0, 4), ['opencode', 'run', '--format', 'json']);
  assert.strictEqual(argv.at(-1), 'the prompt');
  assert.strictEqual(o.timeoutMs, 1000);
  assert.strictEqual(o.cwd, path.join(ROOT, 'workspace'));
  assert.strictEqual(o.env.FTH_AUTONOMOUS, '1');
  assert.strictEqual(o.liveFile, o.env.FTH_CYCLE_TRANSCRIPT);
  assert.ok(o.liveFile.startsWith(path.join(home, 'logs')), o.liveFile);
  assert.strictEqual(o.env.FTH_CYCLE_BARS, JSON.stringify({ MNQ: '2026-10-07T14:00:00.000Z' }));
  // The cycle log, in the home given.
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([line.action, line.harness, line.result], ['trade', 'opencode', 'CYCLE RESULT: no-trade - nothing fired']);
  assert.ok(line.skillLookups, 'a streamed transcript: its lookups are counted');
  assert.ok(d.out.some(t => /cycle log .*cycles/.test(t)) && d.out.some(t => /no-trade - nothing fired/.test(t)));
  assert.match(d.logged[0], /===== 2026-10-07T14:03:02.000Z trade opencode/);
  // A full trade cycle that launched no role: decided without its desk, recorded and said (desk-check.js).
  assert.deepStrictEqual(line.desk, { expected: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], ran: [], missing: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], failed: [], complete: false, decided: true });
  assert.deepStrictEqual(d.err, ['[autotrader] [desk] this cycle was decided without market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager (no launch returned)\n']);
});

test('cycle run: the desk check counts the roles that returned, names a failed launch, skips the cached, and is quiet when the desk ran', async () => {
  const task = (role, status, t) => `${JSON.stringify({ type: 'tool_use', timestamp: t, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status, input: { subagent_type: role, description: 'd', prompt: 'p' }, ...(status === 'error' ? { error: 'Expected a string starting with "ses"' } : { output: 'report' }), time: { start: t, end: t + 1 } } } })}\n`;
  const said = `${JSON.stringify({ type: 'text', timestamp: 99, sessionID: 's', part: { type: 'text', text: 'CYCLE RESULT: no-trade - nothing fired' } })}\n`;
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const context = (cachedRoles = []) => ({ action: 'trade', cachedRoles, symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] });
  const cycle = async (output, ctx, res = {}) => {
    const home = tmpDir();
    const d = deps(home, async () => ({ ok: true, timedOut: false, code: 0, output, stdout: output, ...res }));
    await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 1000, context: ctx }, d.deps);
    return { line: JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim()), err: d.err.join('') };
  };
  const part = await cycle(`${task('market-structure-analyst', 'error', 1)}${task('market-structure-analyst', 'completed', 10)}${task('risk-manager', 'completed', 20)}${task('trend-momentum-analyst', 'error', 30)}${said}`, context());
  assert.deepStrictEqual([part.line.desk.ran, part.line.desk.missing, part.line.desk.failed, part.line.desk.complete], [['market-structure-analyst', 'risk-manager'], ['trend-momentum-analyst', 'volume-liquidity-analyst'], ['market-structure-analyst', 'trend-momentum-analyst'], false]);
  assert.match(part.err, /\[desk\] this cycle was decided without trend-momentum-analyst, volume-liquidity-analyst \(no launch returned\); launches that failed: market-structure-analyst, trend-momentum-analyst/);
  // The cached roles aren't expected; the rest returned: complete, nothing said.
  const cached = await cycle(`${task('trend-momentum-analyst', 'completed', 10)}${task('risk-manager', 'completed', 20)}${said}`, context(['market-structure-analyst', 'volume-liquidity-analyst']));
  assert.deepStrictEqual([cached.line.desk.expected, cached.line.desk.complete], [['trend-momentum-analyst', 'risk-manager'], true]);
  assert.doesNotMatch(cached.err, /\[desk\]/);
  // A manage-only cycle has no roster: nothing expected.
  const manage = await cycle(said, { ...context(), manageOnly: true });
  assert.deepStrictEqual([manage.line.desk.expected, manage.line.desk.complete], [[], true]);
  // A run that timed out decided nothing, and a cycle ended blocked had no entry to decide: recorded, not said.
  const late = await cycle(said, context(), { ok: false, timedOut: true });
  assert.deepStrictEqual([late.line.desk.complete, late.line.desk.decided], [false, false]);
  assert.doesNotMatch(late.err, /\[desk\]/);
  const blocked = `${JSON.stringify({ type: 'text', timestamp: 99, sessionID: 's', part: { type: 'text', text: 'CYCLE RESULT: blocked - [kill-switch] no new entries' } })}\n`;
  const stop = await cycle(blocked, context());
  assert.deepStrictEqual([stop.line.desk.complete, stop.line.desk.decided], [false, false]);
  assert.doesNotMatch(stop.err, /\[desk\]/);
});

test('cycle run: a dry run prints the argv only; a tripped workspace guard runs nothing but end of day; an entry without its skills is said', async () => {
  const home = tmpDir();
  let runs = 0;
  const entry = '{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"type":"tool","tool":"broker_place_order","state":{"status":"completed","input":{"contractId":"MNQ","side":"buy","rationale":"setup:orb long"},"output":"{}"}}}\n';
  const said = `${JSON.stringify({ type: 'text', timestamp: 2, sessionID: 's', part: { type: 'text', text: 'CYCLE RESULT: executed - orb long' } })}\n`;
  const run = async () => { runs += 1; return { ok: true, timedOut: false, code: 0, output: `${entry}${said}`, stdout: `${entry}${said}` }; };
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const dry = deps(home, run);
  assert.deepStrictEqual(await runCycle(cfg, 'trade', 'p', { dryRun: true }, {}, dry.deps), { ok: true, timedOut: false });
  assert.strictEqual(runs, 0);
  assert.match(dry.out[0], /^\["opencode","run"/);
  const tripped = deps(home, run, { guard: () => false });
  assert.deepStrictEqual(await runCycle(cfg, 'trade', 'p', {}, {}, tripped.deps), { ok: false, timedOut: false });
  assert.strictEqual(runs, 0);
  const eod = await runCycle(cfg, 'eod', 'p', {}, {}, tripped.deps);
  assert.strictEqual(runs, 1);
  assert.strictEqual(eod.ok, true, 'end of day runs and counts, the guard aside');
  // Full mode: the head trader loads its skills with the skill tool (none embedded), so an entry without them is said.
  const d = deps(home, run, { env: { FTH_HOME: home, HOME: home, PATH: process.env.PATH, FTH_ROLE_SKILLS: 'full' } });
  const r = await runCycle(cfg, 'trade', 'p', {}, {}, d.deps);
  assert.strictEqual(r.ok, true);
  assert.match(d.err.join(''), /an entry was sent without loading trade-session, multi-timeframe-analysis/);
});

test('cycle run: the workspace guard is required (never defaulted open), and the runner CLI passes its own', async () => {
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const d = deps(tmpDir(), async () => assert.fail('no run without a guard'), { guard: undefined });
  await assert.rejects(runCycle(cfg, 'trade', 'p', {}, {}, d.deps), /deps\.guard \(the workspace guard\) is required/);
  await assert.rejects(runCycle(cfg, 'trade', 'p', { dryRun: true }, {}, d.deps), /is required/, 'a dry run too');
  // scripts/autotrader.js wires its workspace guard (guardWorkspace) into every cycle.
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'autotrader.js'), 'utf8');
  assert.match(cli, /runCycleWith\(cfg, action, prompt, opts, limits, \{[\s\S]*?\bguard: \(killSwitchFile, when\) => guardWorkspace\(cfg, killSwitchFile, when\)/);
  assert.match(cli, /^function guardWorkspace\(cfg, killSwitchFile, when\) \{/m);
});

test('runRole: one desk role\'s own harness run (`--agent <role>`, the request its prompt), its final text, completed tools and lookups; opencode only', async () => {
  const { runRole } = require('../../scripts/lib/cycle-run');
  const home = tmpDir();
  const seen = [];
  const run = async (argv, o) => {
    seen.push({ argv, o });
    fs.mkdirSync(path.dirname(o.liveFile), { recursive: true });
    const { lookupsFile } = require('../../scripts/lib/trading/skill-lookups');
    // A lookup naming another role is no lookup of this one's (as the gate's rule reads them).
    fs.writeFileSync(lookupsFile(o.liveFile), `${JSON.stringify({ at: 1, role: 'risk-manager', skill: 'position-sizing' })}\n${JSON.stringify({ at: 2, role: 'market-structure-analyst', skill: 'breakout' })}\n`);
    const output = [
      JSON.stringify({ type: 'tool_use', part: { tool: 'broker_get_account_snapshot', state: { status: 'completed' } } }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'harness_combine_status', state: { status: 'error' } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '## Risk state: account 1' } }),
    ].join('\n');
    return { ok: true, timedOut: false, code: 0, output, stdout: output };
  };
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const r = await runRole(cfg, 'risk-manager', 'Phase 1, risk state, for MNQ', { timeoutMs: 5000, context: { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] } }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home, PATH: process.env.PATH }, run });
  const { argv, o } = seen[0];
  assert.deepStrictEqual(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2), ['--agent', 'risk-manager']);
  assert.strictEqual(argv.at(-1), 'Phase 1, risk state, for MNQ');
  assert.strictEqual(o.timeoutMs, 5000);
  assert.deepStrictEqual([r.ok, r.text, r.tools, r.lookups], [true, '## Risk state: account 1', ['broker_get_account_snapshot'], ['position-sizing']]);
  await assert.rejects(runRole(validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'] }), 'risk-manager', 'x', {}, { root: ROOT, run }), /opencode only/);
});

test('cycle run: the runner\'s entry runs after the head trader\'s run, within what is left of the limit and before the cycle log; its result is the cycle\'s; never after a failed run or with the kill switch on', async () => {
  const home = tmpDir();
  const out = 'CYCLE RESULT: planned - trade_lifecycle long 1\n';
  const run = async () => ({ ok: true, timedOut: false, code: 0, output: out, stdout: out });
  const cfg = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const context = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] };
  const seen = [];
  const entry = async a => { seen.push(a); return { result: 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ', entry: { outcome: 'executed', ran: [{ role: 'risk-manager' }, { role: 'trade-executor' }], record: 'r1' } }; };
  let wall = 1e12;
  const d = deps(home, async (...x) => { wall += 4000; return run(...x); }, { wallNow: () => wall });
  const r = await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 10000, context, entry }, d.deps);
  assert.deepStrictEqual([r.ok, r.result], [true, 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ']);
  assert.strictEqual(seen[0].result, 'CYCLE RESULT: planned - trade_lifecycle long 1', 'the head trader\'s own decision');
  assert.strictEqual(seen[0].output, out);
  assert.strictEqual(seen[0].budgetMs, 6000, 'the cycle\'s limit less what the head trader took');
  assert.ok(seen[0].env.FTH_CYCLE_TRANSCRIPT, 'the head trader\'s run\'s environment');
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([line.result, line.entry], ['CYCLE RESULT: executed - trade_lifecycle long 1 MNQ', { outcome: 'executed', ran: ['risk-manager', 'trade-executor'], record: 'r1' }]);
  // A failed head run, or the kill switch on before it: the entry never runs.
  seen.length = 0;
  const failed = deps(home, async () => ({ ok: false, timedOut: true, code: null, output: '', stdout: '' }));
  await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 10000, context, entry }, failed.deps);
  let guards = 0;
  const tripped = deps(home, run, { guard: () => (guards += 1) === 1 });
  const r2 = await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 10000, context, entry }, tripped.deps);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(r2.result, 'CYCLE RESULT: planned - trade_lifecycle long 1');
  // An entry that throws: logged, the head trader's result kept, no order.
  const boom = deps(home, run);
  const r3 = await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 10000, context, entry: async () => { throw new Error('x'); } }, boom.deps);
  assert.strictEqual(r3.result, 'CYCLE RESULT: planned - trade_lifecycle long 1');
  assert.ok(boom.err.some(t => /the runner's entry failed \(x\): no order/.test(t)));
});
