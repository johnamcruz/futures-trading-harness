'use strict';

// prepareAhead "on" (PR B2) in the runner's cycle glue (cycle-run.js runCycle `confirm`): the confirm is the head
// trader's real run at the close: its argv the head trader's whole plus --resume <prepare session> --fork-session, the
// close's cycle env with FTH_CONFIRM_BASE, the prompt the cycle's own (its pre-collected reads included: the at-close
// facts first) then the plan's line and the confirm rule; within its own bound. A confirm that errors or times out
// before a compose falls back to the full head trader's run (the old path's own prompt, argv and env), its failure in the
// result's `confirm` only; one that composed never runs the head trader again.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { validateConfig, buildCommand } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'on', headSkillsInPrompt: true });
const out = (text, session) => [
  { type: 'system', subtype: 'init', session_id: session },
  { type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: session },
  { type: 'result', subtype: 'success', result: text, session_id: session },
].map(e => JSON.stringify(e)).join('\n');
const SUFFIX = '\n\nYour plan said: scenario 1: SCENARIO 1: P1 "15m rejected prior vah up" → TAKE if a | PASS if b\nThe candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.';

/** A run per call: `plays[i]` its result ({ ok, timedOut, text }); every call's argv and options seen. */
function runOf(seen, plays) {
  return async (argv, o) => {
    const p = plays[Math.min(seen.length, plays.length - 1)];
    seen.push({ argv, o });
    // A run's skill and experience lookups, next to its transcript (the cycle log removes them; a failed confirm has none).
    if (p.lookups && o.env.FTH_CYCLE_TRANSCRIPT) for (const f of [`${o.env.FTH_CYCLE_TRANSCRIPT}.lookups.jsonl`, require('../../scripts/lib/learning/experience-lookups').lookupsFile(o.env.FTH_CYCLE_TRANSCRIPT)]) { require('fs').mkdirSync(path.dirname(f), { recursive: true }); require('fs').writeFileSync(f, '{}\n'); }
    if (p.hang) await new Promise(r => setTimeout(r, p.hang));
    const text = p.text || 'CYCLE RESULT: no-trade - the candle did not meet it';
    return { ok: p.ok !== false, timedOut: Boolean(p.timedOut), code: p.ok === false ? 1 : 0, output: out(text, 's'), stdout: out(text, 's') };
  };
}
function setup() {
  const home = tmpDir();
  const base = path.join(home, 'prepare', 'MNQ-20260428T041200000Z.json');
  return { home, base, env: { FTH_HOME: home, HOME: home, PATH: process.env.PATH, FTH_GATE_LOG: path.join(home, 'gate.jsonl') }, context: { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-04-28T04:12:00.000Z' } }] } };
}
const deps = (s, run, extra = {}) => ({ root: ROOT, home: s.home, env: s.env, run, guard: () => true, ...extra });

test('runCycle confirm: the head trader\'s argv whole plus the fork of the prepare\'s session; the close\'s cycle env with the base; the prompt the cycle\'s own, then the plan\'s line and the rule', async () => {
  const s = setup();
  const seen = [];
  const r = await runCycle(cfg, 'trade', 'CYCLE PROMPT', {}, { timeoutMs: 360000, context: s.context, confirm: { session: 'ses-prep', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(seen, [{}])));
  assert.strictEqual(seen.length, 1, 'one run: the confirm decided');
  const { argv, o } = seen[0];
  assert.deepStrictEqual(argv, buildCommand(cfg, `CYCLE PROMPT${SUFFIX}`, ROOT, s.env, { confirm: 'ses-prep' }));
  assert.strictEqual(o.env.FTH_CONFIRM_BASE, s.base);
  assert.strictEqual(o.env.FTH_GATE_LOG, s.env.FTH_GATE_LOG, 'the normal gate log');
  assert.ok(!('FTH_PREPARE' in o.env));
  assert.strictEqual(o.env.FTH_CYCLE_BARS, JSON.stringify({ MNQ: '2026-04-28T04:12:00.000Z' }), 'the close\'s bars');
  assert.strictEqual(o.timeoutMs, 90000, 'its own bound');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual({ outcome: r.confirm.outcome, fellBack: r.confirm.fellBack }, { outcome: 'done', fellBack: false });
});

test('runCycle confirm: the pre-collected reads stay with the at-close facts: the plan\'s line and the rule come after them', async () => {
  const s = setup();
  const seen = [];
  const precollect = () => ({ blocks: [{ tool: 'bar_briefing', args: { symbol: 'MNQ' }, text: 'BRIEFING AT CLOSE' }], missing: [] });
  // A cycle prompt ends with its result line (the reads go before it: autotrader.js withCycleData).
  const P = `CYCLE PROMPT${require('../../scripts/lib/autotrader').RESULT_LINE}`;
  await runCycle(cfg, 'trade', P, {}, { timeoutMs: 360000, context: s.context, precollect, confirm: { session: 'ses-prep', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(seen, [{}])));
  const prompt = seen[0].argv[seen[0].argv.indexOf('-p') + 1];
  assert.ok(prompt.startsWith('CYCLE PROMPT'), 'the cycle\'s prompt first');
  assert.ok(prompt.indexOf('BRIEFING AT CLOSE') > 0 && prompt.indexOf('BRIEFING AT CLOSE') < prompt.indexOf('Your plan said'), 'the reads before the plan');
  assert.ok(prompt.endsWith(SUFFIX), 'the plan\'s line and the rule last');
});

test('runCycle confirm: one that errors or times out before a compose falls back to the full head trader\'s run, exactly the old path\'s (prompt, argv, env); its failure is the result\'s confirm only', async () => {
  for (const [what, play] of [['an error', { ok: false, lookups: true }], ['a timeout', { timedOut: true, lookups: true }]]) {
    const s = setup();
    const seen = [];
    const old = [];
    const r = await runCycle(cfg, 'trade', 'CYCLE PROMPT', {}, { timeoutMs: 360000, context: s.context, confirm: { session: 'ses-prep', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(seen, [play, { text: 'CYCLE RESULT: no-trade - nothing' }])));
    await runCycle(cfg, 'trade', 'CYCLE PROMPT', {}, { timeoutMs: 360000, context: s.context }, deps(s, runOf(old, [{ text: 'CYCLE RESULT: no-trade - nothing' }])));
    assert.strictEqual(seen.length, 2, what);
    assert.deepStrictEqual(seen[1].argv, old[0].argv, `${what}: the old path's argv`);
    // (Each run's own: its transcript, and the head prompt's attestation that names its cycle.)
    const envOf = o => Object.fromEntries(Object.entries(o.env).filter(([k]) => k !== 'FTH_CYCLE_TRANSCRIPT' && k !== 'FTH_HEAD_PROMPT'));
    assert.deepStrictEqual(envOf(seen[1].o), envOf(old[0].o), `${what}: the old path's env (no base)`);
    assert.ok(!('FTH_CONFIRM_BASE' in seen[1].o.env));
    assert.ok(seen[1].o.timeoutMs <= 360000 && seen[1].o.timeoutMs >= 360000 - 90000 - 5000, `${what}: what the cycle has left`);
    assert.strictEqual(r.result, 'CYCLE RESULT: no-trade - nothing');
    assert.deepStrictEqual({ outcome: r.confirm.outcome, fellBack: r.confirm.fellBack }, { outcome: play.ok === false ? 'error' : 'timeout', fellBack: true }, what);
    // The failed confirm's own lookups files are removed (no cycle log of its own removes them).
    const t = seen[0].o.env.FTH_CYCLE_TRANSCRIPT;
    for (const f of [`${t}.lookups.jsonl`, require('../../scripts/lib/learning/experience-lookups').lookupsFile(t)]) assert.ok(!require('fs').existsSync(f), `${what}: ${f} removed`);
  }
});

test('runCycle confirm: one that composed and then failed is never followed by a second head trader\'s run (no compose twice); its result is the cycle\'s', async () => {
  const s = setup();
  const seen = [];
  const r = await runCycle(cfg, 'trade', 'CYCLE PROMPT', {}, { timeoutMs: 360000, context: s.context, confirm: { session: 'ses-prep', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => true } }, deps(s, runOf(seen, [{ ok: false }])));
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual({ outcome: r.confirm.outcome, fellBack: r.confirm.fellBack }, { outcome: 'error', fellBack: false });
});

test('runCycle confirm: never run with less than the head trader\'s floor left after it (cycle.timeoutMinMinutes), and never without its base in its env: the full head trader runs instead', async () => {
  const s = setup();
  const minHead = require('../../scripts/lib/tunables').runner().cycle.timeoutMinMinutes * 60000;
  const seen = [];
  // The cycle's limit leaves the confirm only what is above the head trader's floor.
  await runCycle(cfg, 'trade', 'P', {}, { timeoutMs: minHead + 30000, context: s.context, confirm: { session: 'x', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(seen, [{}])));
  assert.strictEqual(seen[0].o.timeoutMs, 30000);
  // None above the floor: no confirm at all.
  const none = [];
  const r = await runCycle(cfg, 'trade', 'P', {}, { timeoutMs: minHead, context: s.context, confirm: { session: 'x', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(none, [{}])));
  assert.strictEqual(none.length, 1);
  assert.ok(!none[0].argv.includes('--resume'));
  assert.deepStrictEqual({ outcome: r.confirm.outcome, fellBack: r.confirm.fellBack }, { outcome: 'no-time', fellBack: true });
  // A base the env would not carry (not in <home>/prepare/): the full head trader, never a confirm without its base.
  const bad = [];
  const r2 = await runCycle(cfg, 'trade', 'P', {}, { timeoutMs: 360000, context: s.context, confirm: { session: 'x', base: path.join(s.home, 'elsewhere.json'), suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, runOf(bad, [{}])));
  assert.strictEqual(bad.length, 1);
  assert.ok(!bad[0].argv.includes('--resume'));
  assert.deepStrictEqual({ outcome: r2.confirm.outcome, fellBack: r2.confirm.fellBack }, { outcome: 'no-base', fellBack: true });
});

test('runCycle without confirm: exactly as before (no resume, no base, no confirm field)', async () => {
  const s = setup();
  const seen = [];
  const r = await runCycle(cfg, 'trade', 'P', {}, { timeoutMs: 360000, context: s.context }, deps(s, runOf(seen, [{}])));
  assert.ok(!seen[0].argv.includes('--resume') && !('FTH_CONFIRM_BASE' in seen[0].o.env));
  assert.ok(!('confirm' in r));
});

test('runCycle confirm: one that errs or times out before a compose keeps what it did (its tool calls, the tail of its output, capped) in its result\'s confirm and the day log, so a fallback can be told why', async () => {
  const s = setup();
  const T = require('../../scripts/lib/tunables').runner().prepare;
  const big = 'x'.repeat(T.confirmTailChars * 3);
  const failing = async (argv, o) => {
    if (!argv.includes('--resume')) return { ok: true, timedOut: false, code: 0, output: out('CYCLE RESULT: no-trade - nothing', 's'), stdout: out('CYCLE RESULT: no-trade - nothing', 's') };
    const lines = [{ type: 'system', subtype: 'init', session_id: 'f' }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__harness__bar_briefing', input: { symbol: 'MNQ' } }] } }, { type: 'assistant', message: { content: [{ type: 'text', text: big }] } }, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded' }].map(e => JSON.stringify(e)).join('\n');
    void o;
    return { ok: false, timedOut: false, code: 1, output: lines, stdout: lines };
  };
  const logged = [];
  const r = await runCycle(cfg, 'trade', 'CYCLE PROMPT', {}, { timeoutMs: 360000, context: s.context, confirm: { session: 'ses-prep', base: s.base, suffix: SUFFIX, timeoutMs: 90000, composed: () => false } }, deps(s, failing, { appendLog: (_now, text) => logged.push(text) }));
  assert.strictEqual(r.confirm.fellBack, true);
  assert.deepStrictEqual(r.confirm.tools, ['mcp__harness__bar_briefing']);
  assert.ok(typeof r.confirm.tail === 'string' && r.confirm.tail.length <= T.confirmTailChars, 'capped');
  assert.match(r.confirm.tail, /API Error: overloaded/, 'the end of its output');
  // The day log has the failed confirm's run before the full head trader's.
  assert.ok(logged.length === 2 && /the confirm \(failed before a compose: error;/.test(logged[0]) && /API Error: overloaded/.test(logged[0]), logged.map(x => x.slice(0, 120)).join(' | '));
});
