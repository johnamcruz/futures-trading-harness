'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRun, STOPS } = require('../../scripts/lib/orchestrate/engine');

const fake = (answers) => ({
  calls: [],
  async run(role, request, opts) {
    this.calls.push({ role, request, opts });
    const a = answers[role];
    const next = Array.isArray(a) ? a.shift() : a;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  },
});
const good = { ok: true, text: 'report', tools: ['harness_bar_briefing'], output: 'o', transcript: '/t' };

test('agent: one role\'s run as an envelope that never rejects: completed, invalid, failed, timed_out; retried up to `retries`', async () => {
  const e = fake({ a: good, b: [{ ok: false }, good], c: [{ ok: false, timedOut: true }, { ok: false, timedOut: true }], d: new Error('spawn') });
  const r = createRun({ engine: e });
  const a = await r.agent('a', 'req a');
  assert.deepStrictEqual([a.ok, a.stop, a.attempts, a.text, a.tools, a.transcript], [true, 'completed', 1, 'report', ['harness_bar_briefing'], '/t']);
  const b = await r.agent('b', 'req b', { retries: 1 });
  assert.deepStrictEqual([b.ok, b.stop, b.attempts], [true, 'completed', 2]);
  const c = await r.agent('c', 'req c', { retries: 1 });
  assert.deepStrictEqual([c.ok, c.stop, c.why, c.attempts], [false, 'timed_out', 'timed out', 2]);
  const d = await r.agent('d', 'req d');
  assert.deepStrictEqual([d.ok, d.stop, d.why], [false, 'failed', 'the run failed (spawn)']);
  // A check that fails: invalid, tried again, and its reason kept.
  const v = createRun({ engine: fake({ x: good }) });
  const x = await v.agent('x', 'req', { retries: 2, accept: [() => null, (role, res) => (res.text === 'report' ? 'not good enough' : null)] });
  assert.deepStrictEqual([x.ok, x.stop, x.why, x.attempts], [false, 'invalid', 'not good enough', 3]);
  assert.ok(STOPS.includes(x.stop));
});

test('agent: cancelled before or during a run is cancelled, never retried; misuse is a TypeError', async () => {
  const ac = new AbortController();
  ac.abort();
  const e = fake({ a: good });
  const r = createRun({ engine: e, signal: ac.signal });
  const a = await r.agent('a', 'req', { retries: 3 });
  assert.deepStrictEqual([a.ok, a.stop, a.attempts, e.calls.length], [false, 'cancelled', 0, 0]);
  const mid = new AbortController();
  const m = createRun({ engine: fake({ a: () => { mid.abort(); return good; } }), signal: mid.signal });
  const ma = await m.agent('a', 'req', { retries: 3 });
  assert.deepStrictEqual([ma.stop, ma.attempts], ['cancelled', 1]);
  assert.throws(() => createRun({}), TypeError);
  const ok = createRun({ engine: fake({}) });
  await assert.rejects(ok.agent('', 'req'), TypeError);
  await assert.rejects(ok.agent('a', ''), TypeError);
  await assert.rejects(ok.agent('a', 'req', { retries: -1 }), TypeError);
  await assert.rejects(ok.agent('a', 'req', { accept: ['x'] }), TypeError);
  await assert.rejects(ok.parallel([1]), TypeError);
  await assert.rejects(ok.parallel([], { concurrency: 0 }), TypeError);
});

test('parallel: at most `concurrency` at once, results in the tasks\' order; events pair each agent\'s start and end by seq, in its phase', async () => {
  let running = 0;
  let most = 0;
  const events = [];
  const slow = ms => async () => { running += 1; most = Math.max(most, running); await new Promise(res => setTimeout(res, ms)); running -= 1; return good; };
  const r = createRun({ engine: fake({ a: slow(15), b: slow(5), c: slow(5), d: slow(5) }), onEvent: e => events.push(e) });
  r.phase('desk');
  const out = await r.parallel(['a', 'b', 'c', 'd'].map(role => () => r.agent(role, `req ${role}`)), { concurrency: 2 });
  assert.ok(most <= 2, `${most} at once`);
  assert.deepStrictEqual(out.map(o => o.role), ['a', 'b', 'c', 'd']);
  const starts = events.filter(e => e.type === 'agent-start');
  const ends = events.filter(e => e.type === 'agent-end');
  assert.deepStrictEqual(starts.map(e => e.seq).sort(), ends.map(e => e.seq).sort());
  assert.ok(events.every(e => e.type === 'phase' || e.phase === 'desk'));
  // A task that throws (misuse) stops new tasks, awaits the running ones, then throws.
  const started = [];
  const p = createRun({ engine: fake({}) });
  const tasks = [0, 1, 2, 3].map(i => async () => { started.push(i); await new Promise(res => setTimeout(res, 5)); if (i === 0) throw new Error('misuse'); return i; });
  await assert.rejects(p.parallel(tasks, { concurrency: 2 }), /misuse/);
  assert.deepStrictEqual(started.sort(), [0, 1], 'no task started after the error');
  // A check that throws is an invalid result with its reason, and the start still has its end.
  const ev = [];
  const t = createRun({ engine: fake({ a: good }), onEvent: e => ev.push(e) });
  const tr = await t.agent('a', 'req', { accept: [() => { throw new Error('bad check'); }] });
  assert.deepStrictEqual([tr.stop, tr.why], ['invalid', 'a check failed (bad check)']);
  assert.deepStrictEqual(ev.map(e => e.type), ['agent-start', 'agent-end']);
  // An observer that throws never breaks the run.
  const q = createRun({ engine: fake({ a: good }), onEvent: () => { throw new Error('observer'); } });
  assert.strictEqual((await q.agent('a', 'req')).ok, true);
});
