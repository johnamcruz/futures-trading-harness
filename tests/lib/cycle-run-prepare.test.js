'use strict';

// Prepare ahead, shadow mode (PR B1): one prepare or shadow-confirm run through the runner's glue (cycle-run.js
// runPrepare): the head trader's argv narrowed (autotrader.js), its own environment (FTH_PREPARE, its session record's
// file, its own transcript), the workspace the head trader runs in, its session from the SessionStart record or the
// stream, and its usage. And the cycle log's `prepare` field, added after the cycle (cycle-log.js amendCycleLog).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPrepare, runCycle } = require('../../scripts/lib/cycle-run');
const { validateConfig, buildCommand } = require('../../scripts/lib/autotrader');
const { amendCycleLog } = require('../../scripts/lib/cycle-log');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'shadow' });
const stream = (text, session = 'ses-1') => [
  { type: 'system', subtype: 'init', session_id: session },
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 5, output_tokens: 40 } }, session_id: session },
  { type: 'result', subtype: 'success', result: text, session_id: session, usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 5, output_tokens: 40 } },
].map(e => JSON.stringify(e)).join('\n');

function runOf(seen, { text = 'SCENARIO 1: P1 x → TAKE if a | PASS if b; reads: "r"; why: w\nPLAN END', session = 'ses-1', hook = true, ok = true } = {}) {
  return async (argv, o) => {
    seen.push({ argv, o });
    // As Claude Code's SessionStart hook: the session record in the runner's file.
    if (hook && o.env.FTH_PREPARE_SESSION) require('../../scripts/lib/prepare-ahead').recordSession(o.env, { session_id: session, transcript_path: `/t/${session}.jsonl`, source: argv.includes('--fork-session') ? 'fork' : 'startup' });
    const out = stream(text, session);
    return { ok, timedOut: false, code: ok ? 0 : 1, output: out, stdout: out };
  };
}

test('runPrepare: a prepare runs the narrowed head trader\'s argv in the head trader\'s workspace, with its own environment, and returns its text, session and usage', async () => {
  const home = tmpDir();
  const seen = [];
  const env = { FTH_HOME: home, HOME: home, PATH: process.env.PATH, FTH_CYCLE_ID: '0123456789abcdef', FTH_PREPARE: 'confirm' };
  const sessionFile = path.join(home, 'prepare', 'ses-a.json');
  const context = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] };
  const r = await runPrepare(cfg, 'prepare', 'PREP', { timeoutMs: 5000, context, sessionFile }, { root: ROOT, home, env, run: runOf(seen) });
  const { argv, o } = seen[0];
  assert.deepStrictEqual(argv, buildCommand(cfg, 'PREP', ROOT, o.env, { prepare: 'prepare' }));
  assert.strictEqual(o.cwd, path.join(ROOT, cfg.workdir), 'the head trader\'s workspace: --resume finds the session');
  assert.strictEqual(o.timeoutMs, 5000);
  assert.strictEqual(o.env.FTH_PREPARE, 'prepare');
  assert.strictEqual(o.env.FTH_PREPARE_SESSION, sessionFile);
  assert.ok(!('FTH_CYCLE_ID' in o.env), 'no cycle id: a prepare is no cycle\'s');
  assert.strictEqual(o.env.FTH_CYCLE_BARS, JSON.stringify({ MNQ: '2026-10-07T14:00:00.000Z' }));
  assert.ok(o.liveFile && o.liveFile === o.env.FTH_CYCLE_TRANSCRIPT, 'its own live transcript');
  assert.deepStrictEqual({ ok: r.ok, timedOut: r.timedOut, sessionId: r.sessionId, transcript: r.transcript, source: r.source }, { ok: true, timedOut: false, sessionId: 'ses-1', transcript: '/t/ses-1.jsonl', source: 'startup' });
  assert.match(r.text, /^SCENARIO 1: P1/);
  assert.deepStrictEqual(r.usage.total, { input: 10, cacheRead: 900, cacheCreation: 5, output: 40 });
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
});

test('runPrepare: the confirm resumes a fork of the prepare\'s session; its session is the fork\'s own', async () => {
  const home = tmpDir();
  const seen = [];
  const r = await runPrepare(cfg, 'confirm', 'CONF', { timeoutMs: 5000, context: { action: 'trade' }, resume: 'ses-1', sessionFile: path.join(home, 'prepare', 'c.json') }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run: runOf(seen, { text: 'DECISION: PASS - no', session: 'ses-2' }) });
  const { argv, o } = seen[0];
  const i = argv.indexOf('--resume');
  assert.deepStrictEqual(argv.slice(i, i + 3), ['--resume', 'ses-1', '--fork-session']);
  assert.strictEqual(o.env.FTH_PREPARE, 'confirm');
  assert.deepStrictEqual([r.sessionId, r.source], ['ses-2', 'fork']);
});

test('runPrepare: no session record (the hook did not run): the session from the stream, its transcript unknown; a failed run is not ok', async () => {
  const home = tmpDir();
  const a = await runPrepare(cfg, 'prepare', 'P', { timeoutMs: 5000, context: { action: 'trade' }, sessionFile: path.join(home, 'prepare', 'x.json') }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run: runOf([], { hook: false, session: 'ses-s' }) });
  assert.deepStrictEqual([a.sessionId, a.transcript], ['ses-s', null]);
  const b = await runPrepare(cfg, 'prepare', 'P', { timeoutMs: 5000, context: { action: 'trade' }, sessionFile: path.join(home, 'prepare', 'y.json') }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run: runOf([], { ok: false }) });
  assert.strictEqual(b.ok, false);
  // The signal reaches the run (the deadline aborts it).
  const ctl = new AbortController();
  const seen = [];
  await runPrepare(cfg, 'prepare', 'P', { timeoutMs: 5000, context: { action: 'trade' }, sessionFile: path.join(home, 'prepare', 'z.json'), signal: ctl.signal }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run: runOf(seen) });
  assert.strictEqual(seen[0].o.signal, ctl.signal);
  // Claude Code only.
  await assert.rejects(runPrepare(validateConfig({ harness: 'opencode' }), 'prepare', 'P', { timeoutMs: 1, context: {} }, { root: ROOT, home, env: {}, run: runOf([]) }), /Claude Code only/);
});

test('runCycle: onLog, when given, hears the cycle log\'s file once it is written; without it the cycle is as before', async () => {
  const home = tmpDir();
  const run = async () => ({ ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - x\n', stdout: 'CYCLE RESULT: no-trade - x\n' });
  const c = validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'] });
  const files = [];
  const deps = { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run, now: () => new Date('2026-10-07T14:03:02Z'), guard: () => true };
  const a = await runCycle(c, 'trade', 'p', {}, { timeoutMs: 1000, context: { action: 'trade' }, onLog: f => files.push(f) }, deps);
  assert.strictEqual(files.length, 1);
  assert.ok(fs.existsSync(files[0]) && files[0].startsWith(path.join(home, 'logs', 'cycles')));
  const b = await runCycle(c, 'trade', 'p', {}, { timeoutMs: 1000, context: { action: 'trade' } }, deps);
  assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'the same result either way');
});

test('amendCycleLog: the `prepare` field added to the cycle\'s record, whole (atomic), everything else byte-for-byte; a missing file is no record', () => {
  const home = tmpDir();
  const file = path.join(home, 'logs', 'cycles', '2026-10-07', '140302-trade.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { at: '2026-10-07T14:03:02.000Z', action: 'trade', result: 'CYCLE RESULT: no-trade - x', context: { a: 1 } };
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  assert.strictEqual(amendCycleLog(file, 'prepare', { shadow: { status: 'none' } }), true);
  const got = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(got, { ...body, prepare: { shadow: { status: 'none' } } });
  const { prepare: _p, ...rest } = got;
  assert.strictEqual(JSON.stringify(rest, null, 2), JSON.stringify(body, null, 2), 'the rest unchanged');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['140302-trade.json'], 'no temp file left');
  assert.strictEqual(amendCycleLog(path.join(home, 'none.json'), 'prepare', {}), false);
  // Only the prepare field may be added this way.
  assert.throws(() => amendCycleLog(file, 'result', 'x'), /only the prepare field/);
});
