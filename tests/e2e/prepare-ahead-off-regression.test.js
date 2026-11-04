'use strict';

/**
 * PERMANENT regression: prepare ahead off works exactly like the harness before it (the owner, 2026-11-03: "we need to
 * make sure we can toggle off prepare ahead and it works like the current harness"; "ensure we have regression to
 * confirm that"). The expected outputs are origin/main's own (tests/fixtures/prepare-off/main-outputs.json, written by
 * tests/fixtures/prepare-off/generate.js in a scratch checkout of main), never this branch's.
 *
 *   1. The key absent, "off", and (the old path's outputs) "shadow": byte for byte main's on a no-fill, a fill, a
 *      manage-only and an entry day: prompts, argv, child env, cycle records and lines (less their wall-clock fields),
 *      events, day-log lines, the gate log and the orders, every state file (the tool-call logs included), the broker's
 *      whole call log (reads included), the decision record, and (absent and off) the run fingerprint. In shadow, only the
 *      files the shadow writes are left out (outputs.js SHADOW_OWN), and the broker's call log may differ only by the
 *      shadow's own reads: main's log is that log with some reads taken out, never an order or a call out of order.
 *   2. Toggled on, then off: what the shadow left (plan files, session records, its gate log) never moves the old path.
 *   3. Off, prepare ahead's modules are never loaded: poisoned, the off day is still main's.
 *   4. A failure inside prepare ahead (an exception in the prepare or the confirm, a run that hangs until it is killed,
 *      a corrupt plan file, a lost session) never moves the old path; the error is in the prepare field only.
 *   5. The check can fail: a leak (an extra log line, an env var) is reported.
 */

// The user's home pinned before the harness loads (os.homedir is in the prompt and the deny rules), as generate.js
// pins it: the expected outputs hold on every machine (tests/e2e/prepare-ahead-off-portable.test.js).
process.env.HOME = require('../fixtures/prepare-off/outputs').PINNED_HOME;
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('../fixtures/prepare-off/outputs');
const { fakeClaude } = require('../fixtures/fake-claude-sessions');
const { runPrepare } = require('../../scripts/lib/cycle-run');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN = require('../fixtures/prepare-off/main-outputs.json');
const sameAs = (got, want, what) => assert.strictEqual(O.firstDiff(got, want), null, `${what}: ${JSON.stringify(O.firstDiff(got, want))}`);
/** The old path's outputs: all but the run fingerprint (shadow names its key there, by design) and the broker's call log. */
const oldOf = ({ fingerprint: _f, calls: _c, ...rest }) => rest;
const READ = /^(get_|list_|search_|journal_read )/;
/** Main's call log is the shadow's with only reads taken out (the shadow's own), in order: true, or the first problem. */
function onlyReadsAdded(got, want) {
  let i = 0;
  for (const c of got) {
    if (i < want.length && c === want[i]) { i += 1; continue; }
    if (!READ.test(c)) return `an extra call that is no read: ${c.slice(0, 200)}`;
  }
  return i === want.length ? true : `main's call ${i} is missing: ${String(want[i]).slice(0, 200)}`;
}
const NEXT_BAR = '2026-04-28T04:12:00.000Z';

/** The shadow's runs through the production glue, played by the fake CLI; `inject(kind)` may throw or fail a run. */
const shadowRuns = (inject = () => null) => w => {
  // Each run also tries an order (refused by dontAsk after the order gate's hook: its refusal is the shadow's gate log's).
  const order = { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:trade_lifecycle long' } };
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: (prompt, _env, { resumed }) => [order, { result: resumed ? 'DECISION: TAKE 1' : [...prompt.matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)].map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if a | PASS if b; reads: "${m[3]}"; why: w`).join('\n') }] });
  return env => async (c, kind, prompt, limits) => {
    const hit = inject(kind, w);
    if (hit === 'throw') throw new Error(`injected: the ${kind} crashed`);
    if (hit === 'hang') return { ok: false, timedOut: true, text: '', sessionId: null, transcript: null, source: null, usage: null, ms: limits.timeoutMs, denied: [], gateRefusals: 0, initMs: null };
    return runPrepare(c, kind, prompt, limits, { root: ROOT, home: w.home, env, run: fake });
  };
};
const shadowWith = (inject, extra = {}, beforePass = null) => ({ extra: { prepareAhead: 'shadow', ...extra }, runPrepare: shadowRuns(inject), own: O.SHADOW_OWN, ...(beforePass ? { beforePass } : {}) });
const shadowSame = (got, want, what) => { sameAs(oldOf(got), oldOf(want), what); assert.strictEqual(onlyReadsAdded(got.calls, want.calls), true, `${what}: the broker's calls`); };

test('off regression 1: the key absent is main, byte for byte, on every day (fingerprint included)', async () => {
  const got = await O.allDays({});
  for (const d of O.DAYS) sameAs(got[d], MAIN.days[d], d);
});

test('off regression 1: the key "off" is main, byte for byte, on every day (fingerprint included: "off" is no delivery)', async () => {
  const got = await O.allDays({ extra: { prepareAhead: 'off' } });
  for (const d of O.DAYS) sameAs(got[d], MAIN.days[d], d);
});

test('off regression 1: in "shadow" the old path\'s outputs are main\'s on every day (only the fingerprint names the key)', async () => {
  const got = await O.allDays(shadowWith(() => null));
  for (const d of O.DAYS) {
    shadowSame(got[d], MAIN.days[d], d);
    assert.strictEqual(got[d].fingerprint.delivery, `${MAIN.days[d].fingerprint.delivery},prepareAhead=shadow`);
  }
});

test('off regression 2: toggled on, then off: the shadow\'s leftovers (plans for every bar, a corrupt one, session records, its gate log) never move the old path', async () => {
  const plant = w => {
    const dir = path.join(w.home, 'prepare');
    fs.mkdirSync(dir, { recursive: true });
    for (const t of ['2026-04-28T04:06:00.000Z', '2026-04-28T04:09:00.000Z', NEXT_BAR]) {
      fs.writeFileSync(require('../../scripts/lib/prepare-ahead').planFile(w.home, 'MNQ', t), JSON.stringify({ v: 1, id: 'x', symbol: 'MNQ', bar: t, next: { t, closedAt: t }, session: { id: 'ses-old', transcript: null }, versions: {}, candidates: [], scenarios: [{ k: 1, id: 'P1' }], text: 'SCENARIO 1: P1 → TAKE if a | PASS if b' }));
    }
    fs.writeFileSync(path.join(dir, 'MNQ-junk.json'), '{"v":1,');
    fs.writeFileSync(path.join(dir, 'session-0123.json'), JSON.stringify({ sessionId: 'ses-old', transcript: '/gone', source: 'startup' }));
    fs.writeFileSync(path.join(dir, 'gate-log.jsonl'), `${JSON.stringify({ source: 'hook', tool: 'place_order', decision: 'blocked' })}\n`);
  };
  for (const extra of [{}, { prepareAhead: 'off' }]) {
    // The leftovers themselves are left out of the comparison (main has none), and checked unchanged.
    const planted = new Map();
    const got = await O.allDays({ extra, own: /^prepare\//, before: w => { plant(w); for (const f of fs.readdirSync(path.join(w.home, 'prepare'))) planted.set(f, fs.readFileSync(path.join(w.home, 'prepare', f), 'utf8')); planted.home = w.home; } });
    for (const d of O.DAYS) sameAs(got[d], MAIN.days[d], `${JSON.stringify(extra)} ${d}`);
    for (const [f, text] of planted) assert.strictEqual(fs.readFileSync(path.join(planted.home, 'prepare', f), 'utf8'), text, `${f} untouched`);
  }
});

test('off regression 2: a shadow run, then the same home restarted with the key off: the off passes are main\'s', async () => {
  // The first pass in shadow (its prepare's plan for 04:09 written), the later ones off, in one home.
  const { out } = await O.runDay('no-fill', { cfgAt: bar => (bar === '2026-04-28T04:06:00.000Z' ? { prepareAhead: 'shadow' } : {}), runPrepare: shadowRuns(), own: O.SHADOW_OWN });
  const main = MAIN.days['no-fill'];
  sameAs(out.passes.slice(1), main.passes.slice(1), 'the off passes');
  shadowSame(out, main, 'the day');
});

test('off regression 3: off, prepare ahead\'s modules are never loaded; poisoned (any use throws), the off day is still main\'s', () => {
  const lib = p => path.join(ROOT, 'scripts', 'lib', p);
  const mods = [lib('prepare-ahead.js'), lib('prepare-shadow.js'), lib('prepare-shadow-report.js'), lib('trading/next-close.js')];
  const script = `
    const Module = require('module');
    const mods = ${JSON.stringify(mods)};
    const poison = new Proxy({}, { get(_t, k) { if (k === Symbol.toPrimitive || k === 'then') return undefined; throw new Error('poisoned: ' + String(k)); } });
    for (const m of mods) Module._cache[m] = { id: m, filename: m, loaded: true, exports: poison, children: [], paths: [] };
    const O = require(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures', 'prepare-off', 'outputs.js'))});
    const MAIN = require(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures', 'prepare-off', 'main-outputs.json'))});
    (async () => {
      const res = {};
      for (const extra of [{}, { prepareAhead: 'off' }]) {
        // The shadow's runner wired as the CLI always wires it: off, it is never called.
        const got = await O.allDays({ extra, runPrepare: () => () => async () => { throw new Error('a shadow run while off'); } });
        res[JSON.stringify(extra)] = O.DAYS.map(d => O.firstDiff(got[d], MAIN.days[d]));
      }
      process.stdout.write(JSON.stringify(res));
    })().catch(e => { process.stdout.write(JSON.stringify({ error: e.stack })); });`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, timeout: 900000 });
  const res = JSON.parse(r.stdout);
  assert.ok(!res.error, res.error);
  for (const [k, diffs] of Object.entries(res)) assert.deepStrictEqual(diffs, O.DAYS.map(() => null), k);
  // And loaded without poison, off: none of them is in the process.
  const loaded = spawnSync(process.execPath, ['-e', `
    const O = require(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures', 'prepare-off', 'outputs.js'))});
    O.runDay('no-fill', { extra: { prepareAhead: 'off' } }).then(() => process.stdout.write(JSON.stringify(${JSON.stringify(mods)}.filter(m => require.cache[m]))));`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, timeout: 900000 });
  assert.deepStrictEqual(JSON.parse(loaded.stdout), []);
});

test('off regression 4: a failure inside prepare ahead never moves the old path; the error is in the prepare field only', async () => {
  const cases = {
    'the prepare throws': kind => (kind === 'prepare' ? 'throw' : null),
    'the confirm throws': kind => (kind === 'confirm' ? 'throw' : null),
    'the prepare hangs until killed': kind => (kind === 'prepare' ? 'hang' : null),
    'the confirm hangs until killed': kind => (kind === 'confirm' ? 'hang' : null),
    'a corrupt plan file before the close': [() => null, (bar, w) => { if (bar === NEXT_BAR) for (const f of fs.readdirSync(path.join(w.home, 'prepare')).filter(x => /^MNQ-/.test(x))) fs.writeFileSync(path.join(w.home, 'prepare', f), '{"v":1,'); }],
    'the session lost before the confirm': [() => null, (bar, w) => { if (bar === NEXT_BAR) fs.rmSync(path.join(w.home, 'claude-sessions'), { recursive: true, force: true }); }],
  };
  for (const [name, c] of Object.entries(cases)) {
    const [inject, beforePass] = Array.isArray(c) ? c : [c, null];
    const { w, out } = await O.runDay('no-fill', shadowWith(inject, {}, beforePass));
    shadowSame(out, MAIN.days['no-fill'], name);
    // The error, if any, is the prepare field's: every record's prepare field says what happened.
    const recs = fs.readdirSync(path.join(w.home, 'logs', 'cycles')).flatMap(d => fs.readdirSync(path.join(w.home, 'logs', 'cycles', d)).map(f => JSON.parse(fs.readFileSync(path.join(w.home, 'logs', 'cycles', d, f), 'utf8'))));
    const said = JSON.stringify(recs.map(r => r.prepare || null));
    if (/throws/.test(name)) assert.match(said, /injected: the (prepare|confirm) crashed|"outcome":"error"/, name);
  }
});

test('off regression 1 (the gate): on the entry day the old path\'s gate decision and orders are main\'s in every mode, and the shadow\'s order attempts land only in its own gate log', async () => {
  const main = MAIN.days.entry;
  assert.ok(main.gate.length >= 1, 'main\'s entry day has a gate decision to compare (not vacuous)');
  const { w, out } = await O.runDay('entry', shadowWith(() => null));
  assert.deepStrictEqual(out.gate, main.gate);
  assert.deepStrictEqual(out.orders, main.orders);
  const shadowLog = require('../../scripts/lib/prepare-ahead').shadowGateLog(w.home);
  const lines = fs.readFileSync(shadowLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.length >= 1 && lines.every(e => e.source === 'hook' && e.tool === 'place_order' && e.decision === 'blocked'), JSON.stringify(lines));
});

test('off regression 5: the check can fail: a leak (an extra day-log line, an env var, a state file) is reported against main', () => {
  const main = MAIN.days['no-fill'];
  const leak = f => { const x = JSON.parse(JSON.stringify(main)); f(x); return x; };
  assert.ok(O.firstDiff(leak(x => x.passes[1].logs.push('info prepare: shadow ran')), main), 'a log line');
  assert.ok(O.firstDiff(leak(x => { x.passes[1].env.FTH_PREPARE = 'prepare'; }), main), 'an env var');
  assert.ok(O.firstDiff(leak(x => x.state.push(['prepare-leak.json', '{}'])), main), 'a state file');
  assert.ok(O.firstDiff(leak(x => { x.fingerprint.delivery = `${x.fingerprint.delivery},prepareAhead=off`; }), main), 'the delivery token');
  assert.ok(O.firstDiff(leak(x => x.calls.push('get_account_snapshot {"accountId":7}')), main), 'an extra broker read');
  // In shadow, an extra order call or a missing call is refused; an extra read is the shadow's own.
  assert.strictEqual(onlyReadsAdded([...main.calls, 'get_account_snapshot {"accountId":7}'], main.calls), true);
  assert.match(String(onlyReadsAdded([...main.calls, 'place_order {"size":1}'], main.calls)), /no read/);
  assert.match(String(onlyReadsAdded(main.calls.slice(1), main.calls)), /missing/);
  assert.strictEqual(O.firstDiff(leak(() => {}), main), null, 'unchanged: no difference');
});
