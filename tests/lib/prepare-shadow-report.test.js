'use strict';

// Prepare ahead's shadow log read back (scripts/lib/prepare-shadow-report.js; scripts/prepare-shadow.js): from a run
// home's cycle records, the agreement with the full cycle, the prepare and confirm times, the void and outside-plan
// rates by kind, the deadline aborts, and the tokens.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../../scripts/lib/prepare-shadow-report');

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-shadow-report-'));
const usage = (i, c) => ({ total: { input: i, cacheRead: c, cacheCreation: 1, output: 2 } });

/** A home with cycle records on two days, one prepare field each (or none). */
function home(records) {
  const h = tmp();
  records.forEach((r, i) => {
    const dir = path.join(h, 'logs', 'cycles', r.day || '2026-05-04');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${String(100000 + i)}-trade.json`), JSON.stringify({ action: 'trade', result: 'CYCLE RESULT: no-trade - x', ...(r.prepare ? { prepare: r.prepare } : {}) }));
  });
  return h;
}
const made = (outcome, ms, extra = {}) => ({ outcome, ms, ...extra });
const valid = (agrees, ms, decision = 'take') => ({ status: 'valid', planId: 'p', prepareMs: 40000, match: { k: 1, read: 'r' }, confirm: { outcome: 'done', decision: { decision }, ms, usage: usage(5, 90), denied: ['Agent'], gateRefusals: 1 }, full: { decision: 'pass' }, agreesWithFull: agrees });

const RECORDS = [
  { prepare: { shadow: { status: 'none', reason: 'no-plan', planId: null }, made: made('done', 40000, { usage: usage(10, 100), denied: ['mcp__harness__compose_check', 'mcp__broker__place_order'], gateRefusals: 1 }) } },
  { prepare: { shadow: valid(true, 6000), made: made('done', 50000, { usage: usage(10, 100) }) } },
  { prepare: { shadow: valid(false, 8000), made: made('aborted', 160000) } },
  { prepare: { shadow: { status: 'void', reason: 'facts', planId: 'p' }, made: made('skipped', undefined, { why: 'not-flat' }) } },
  { prepare: { shadow: { status: 'outside', fired: ['15m rejected vwap up'], unplannedKinds: { vwap: 1 }, planId: 'p' }, made: made('skipped', undefined, { why: 'nothing-can-fire' }) } },
  { prepare: { shadow: { status: 'void', reason: 'htf-close:h1', planId: 'p', ifHourIgnored: { status: 'valid', match: 'matched', read: 'r' } }, made: made('error', 100, { why: 'the run failed' }) }, day: '2026-05-05' },
  { prepare: { shadow: valid(null, 4000), made: made('done', 30000) }, day: '2026-05-05' },
  {}, // the key off: no prepare field
];

test('shadow report: counts by status and reason, the agreement against the full cycle, the times and the tokens', () => {
  const rep = R.report(R.readRecords(home(RECORDS)));
  assert.strictEqual(rep.cycles, 8);
  assert.strictEqual(rep.shadowed, 7, 'records with a prepare field');
  assert.deepStrictEqual(rep.status, { none: 1, valid: 3, void: 2, outside: 1 });
  assert.deepStrictEqual(rep.voidBy, { facts: 1, 'htf-close:h1': 1 });
  // Rates over the closes that had a plan (valid, void, outside, nothing-fired).
  assert.strictEqual(rep.planned, 6);
  assert.strictEqual(rep.rates.void, 2 / 6);
  assert.strictEqual(rep.rates.outside, 1 / 6);
  assert.deepStrictEqual(rep.outsideByKind, { vwap: 1 });
  // The agreement: of the confirms with a verdict both ways.
  assert.deepStrictEqual(rep.agreement, { agree: 1, disagree: 1, unknown: 1, rate: 0.5 });
  assert.deepStrictEqual(rep.confirmMs, { n: 3, median: 6000, p90: 8000, max: 8000 });
  // The prepares: outcomes, why skipped, the times of those done or aborted, the deadline aborts.
  assert.deepStrictEqual(rep.made, { done: 3, aborted: 1, skipped: 2, error: 1 });
  assert.deepStrictEqual(rep.skippedBy, { 'not-flat': 1, 'nothing-can-fire': 1 });
  assert.deepStrictEqual(rep.prepareMs, { n: 4, median: 40000, p90: 160000, max: 160000 });
  assert.strictEqual(rep.aborted, 1);
  assert.deepStrictEqual(rep.tokens.prepare, { input: 20, cacheRead: 200, cacheCreation: 2, output: 4 });
  assert.deepStrictEqual(rep.tokens.confirm, { input: 15, cacheRead: 270, cacheCreation: 3, output: 6 });
  // The forbidden-tool attempts: the CLI's denials by tool, and the gate's refusals in the shadow's log.
  // The hourly-close counterfactual: of the plans void only by the 1h close, those valid and matched without it.
  assert.deepStrictEqual(rep.hourClose, { void: 1, wouldBeValid: 1, wouldMatch: 1 });
  assert.deepStrictEqual(rep.forbidden, { denied: { 'mcp__harness__compose_check': 1, 'mcp__broker__place_order': 1, Agent: 3 }, attempted: {}, gateRefusals: 4 });
  // One day.
  assert.strictEqual(R.report(R.readRecords(home(RECORDS), { from: '2026-05-05', to: '2026-05-05' })).shadowed, 2);
});

test('shadow report: the agreement rate can be low (it reports disagreement, never hides it); none to judge is null', () => {
  const rep = R.report(R.readRecords(home([{ prepare: { shadow: valid(false, 1), made: made('done', 1) } }, { prepare: { shadow: valid(false, 1), made: made('done', 1) } }])));
  assert.deepStrictEqual(rep.agreement, { agree: 0, disagree: 2, unknown: 0, rate: 0 });
  assert.strictEqual(R.report([]).agreement.rate, null);
  assert.strictEqual(R.report([]).rates.void, null);
});

test('shadow report: the text says each figure; the CLI prints it for a home (or JSON), and refuses a missing home', () => {
  const h = home(RECORDS);
  const text = R.text(R.report(R.readRecords(h)));
  for (const s of ['agreement with the full cycle: 1 of 2 (50%)', 'void 2 of 6 planned closes (33%)', 'outside the plan 1 (17%): vwap 1', 'prepare ms: median 40000, p90 160000', 'aborted at the deadline: 1', 'forbidden tool attempts: denied Agent 3, mcp__broker__place_order 1, mcp__harness__compose_check 1; gate refusals 4; attempted (transcripts) none']) assert.ok(text.includes(s), s);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shadow.js'), '--home', h], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(cli.stdout.trim(), text.trim());
  const json = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shadow.js'), '--home', h, '--json'], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(json.stdout).shadowed, 7);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shadow.js'), '--home', path.join(h, 'none')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /no cycle records/);
});

// --- "on" runs (PR B2): the path each close took, close to order by the desk ran or cached, late refusals, outside by kind --

const onRec = (on, made = { outcome: 'done', ms: 30000, forbidden: [] }) => ({ prepare: { mode: 'on', on, made } });
const ON = [
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'done', ms: 7000, fellBack: false }, closeToOrderMs: 20000, desk: 'cached', late: [], unplannedKinds: {} }),
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'done', ms: 9000, fellBack: false }, closeToOrderMs: 40000, desk: 'ran', late: ['chased-entry'], unplannedKinds: {} }),
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'error', ms: 3000, fellBack: true }, closeToOrderMs: 90000, desk: 'cached', late: ['missed-entry'], unplannedKinds: {} }),
  onRec({ mode: 'on', path: 'outside', closeToOrderMs: 70000, desk: 'cached', unplannedKinds: { vwap: 2, fvg: 1 } }),
  onRec({ mode: 'on', path: 'void', reason: 'htf-close:h1', closeToOrderMs: null, desk: 'none', unplannedKinds: {} }, { outcome: 'done', ms: 30000, forbidden: ['mcp__harness__compose_check', 'Agent'] }),
  onRec({ mode: 'on', path: 'no-plan', closeToOrderMs: 30000, desk: 'cached', unplannedKinds: {} }),
];

test('report "on": the path shares, the confirm outcomes and fallbacks, close to order (median, p90) by desk ran and cached, the late refusals by kind, outside the plan by level kind, the forbidden attempts', () => {
  const rep = R.report(R.readRecords(home(ON)));
  const on = rep.on;
  assert.strictEqual(on.closes, 6);
  assert.deepStrictEqual(on.paths, { confirm: 3, outside: 1, void: 1, 'no-plan': 1 });
  assert.deepStrictEqual(on.shares, { confirm: 3 / 6, outside: 1 / 6, void: 1 / 6, 'no-plan': 1 / 6 });
  assert.deepStrictEqual(on.voidBy, { 'htf-close:h1': 1 });
  assert.deepStrictEqual(on.confirms, { done: 2, error: 1, fellBack: 1 });
  // Close to order, of the closes that ordered: all, and by whether the desk ran this close or was served cached.
  assert.deepStrictEqual(on.closeToOrder.all, { n: 5, median: 40000, p90: 90000, max: 90000 });
  assert.deepStrictEqual(on.closeToOrder.deskRan, { n: 1, median: 40000, p90: 40000, max: 40000 });
  assert.deepStrictEqual(on.closeToOrder.deskCached, { n: 4, median: 30000, p90: 90000, max: 90000 });
  assert.deepStrictEqual(on.closeToOrder.confirmed, { n: 2, median: 20000, p90: 40000, max: 40000 }, 'the closes the confirm decided');
  assert.deepStrictEqual(on.late, { 'chased-entry': 1, 'missed-entry': 1 });
  assert.deepStrictEqual(on.outsideByKind, { vwap: 2, fvg: 1 });
  assert.deepStrictEqual(rep.forbidden.attempted, { 'mcp__harness__compose_check': 1, Agent: 1 });
  const text = R.text(rep);
  for (const s of ['"on": 6 closes: confirm 3 (50%), outside 1 (17%), void 1 (17%), no-plan 1 (17%)', 'close to order ms: median 40000, p90 90000', 'desk ran: median 40000', 'desk cached: median 30000', 'late refusals: chased-entry 1, missed-entry 1', 'outside the plan by kind: vwap 2, fvg 1', 'confirms: done 2, error 1, fellBack 1']) assert.ok(text.includes(s), `${s}\n${text}`);
});

// The confirm's own turn and the entry's parts (PR A2): each close with its path, desk, close to order and timings.
const turn = (turnMs, turnTo, runMs, readsMs = 0) => ({ turnMs, turnTo, composes: turnTo === 'compose' ? 1 : 0, runMs, readsMs });
const ON2 = [
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'done', ms: 30000, fellBack: false, ...turn(6000, 'compose', 9000, 300) }, closeToOrderMs: 40000, desk: 'cached', phase2Ms: 22000, executorMs: 6000 }),
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'done', ms: 32000, fellBack: false, ...turn(10000, 'compose', 14000, 500) }, closeToOrderMs: 80000, desk: 'ran', phase2Ms: 24000, executorMs: 7000 }),
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'done', ms: 5000, fellBack: false, ...turn(4000, 'result', 5000) }, closeToOrderMs: null, desk: 'cached', phase2Ms: null, executorMs: null }),
  onRec({ mode: 'on', path: 'confirm', confirm: { outcome: 'timeout', ms: 90000, fellBack: true, turnMs: null, turnTo: null, composes: null, runMs: null, readsMs: null }, closeToOrderMs: 150000, desk: 'cached', phase2Ms: 23000, executorMs: 6000 }),
  onRec({ mode: 'on', path: 'outside', closeToOrderMs: 70000, desk: 'cached', unplannedKinds: { vwap: 1 }, phase2Ms: 21000, executorMs: 5000 }),
  onRec({ mode: 'on', path: 'outside', closeToOrderMs: 100000, desk: 'ran', unplannedKinds: { fvg: 1 }, phase2Ms: 25000, executorMs: 8000 }),
  onRec({ mode: 'on', path: 'void', reason: 'htf-close:h1', closeToOrderMs: 90000, desk: 'cached', phase2Ms: 20000, executorMs: 6000 }),
];

test('report "on": the confirm turn\'s own time (median, p90; where it ended), and close to order split by the path (the confirm, each fallback by its reason) and by desk ran or cached; phase 2 and the executor by the confirm and the fallback', () => {
  const on = R.report(R.readRecords(home(ON2))).on;
  // The turns of the confirms that decided (not those that fell back): spawn to the compose's result, or to the pass.
  assert.deepStrictEqual(on.confirmTurn, {
    ms: { n: 3, median: 6000, p90: 10000, max: 10000 }, runMs: { n: 3, median: 9000, p90: 14000, max: 14000 }, readsMs: { n: 3, median: 300, p90: 500, max: 500 }, to: { compose: 2, result: 1 },
  });
  const by = on.closeToOrder.byPath;
  assert.deepStrictEqual(Object.keys(by).sort(), ['confirm', 'fallback:confirm-timeout', 'fallback:outside', 'fallback:void:htf-close:h1']);
  assert.deepStrictEqual(by.confirm, { all: { n: 2, median: 40000, p90: 80000, max: 80000 }, deskRan: { n: 1, median: 80000, p90: 80000, max: 80000 }, deskCached: { n: 1, median: 40000, p90: 40000, max: 40000 } });
  assert.deepStrictEqual(by['fallback:outside'], { all: { n: 2, median: 70000, p90: 100000, max: 100000 }, deskRan: { n: 1, median: 100000, p90: 100000, max: 100000 }, deskCached: { n: 1, median: 70000, p90: 70000, max: 70000 } });
  assert.deepStrictEqual(by['fallback:confirm-timeout'].all, { n: 1, median: 150000, p90: 150000, max: 150000 });
  assert.deepStrictEqual(by['fallback:void:htf-close:h1'].deskCached, { n: 1, median: 90000, p90: 90000, max: 90000 });
  // The confirm and the fallback pooled, by desk.
  assert.deepStrictEqual(on.closeToOrder.fallback, { all: { n: 4, median: 90000, p90: 150000, max: 150000 }, deskRan: { n: 1, median: 100000, p90: 100000, max: 100000 }, deskCached: { n: 3, median: 90000, p90: 150000, max: 150000 } });
  // Phase 2 and the executor: the confirm's entries and the fallbacks' apart.
  assert.deepStrictEqual(on.phase2Ms, { confirm: { n: 2, median: 22000, p90: 24000, max: 24000 }, fallback: { n: 4, median: 21000, p90: 25000, max: 25000 } });
  assert.deepStrictEqual(on.executorMs, { confirm: { n: 2, median: 6000, p90: 7000, max: 7000 }, fallback: { n: 4, median: 6000, p90: 8000, max: 8000 } });
  const text = R.text({ ...R.report(R.readRecords(home(ON2))) });
  for (const s of [
    '"on" confirm turn ms (spawn to its compose\'s result, or its pass): median 6000, p90 10000, max 10000 (n 3); ended at: compose 2, result 1; its run: median 9000',
    '"on" close to order ms by path: confirm: median 40000, p90 80000, max 80000 (n 2) (desk ran: median 80000, p90 80000, max 80000 (n 1); desk cached: median 40000, p90 40000, max 40000 (n 1))',
    'fallback:outside: median 70000, p90 100000',
    '"on" phase 2 ms: confirm median 22000, p90 24000, max 24000 (n 2); fallback median 21000',
    '"on" executor ms: confirm median 6000',
  ]) assert.ok(text.includes(s), `${s}\n${text}`);
});

test('report "on": records from before the turn was timed (no turn, no phase 2 fields) read as none, never as zero', () => {
  const on = R.report(R.readRecords(home(ON))).on;
  assert.deepStrictEqual(on.confirmTurn, { ms: { n: 0, median: null, p90: null, max: null }, runMs: { n: 0, median: null, p90: null, max: null }, readsMs: { n: 0, median: null, p90: null, max: null }, to: {} });
  assert.deepStrictEqual(on.phase2Ms.confirm.n, 0);
  assert.strictEqual(on.closeToOrder.byPath.confirm.all.n, 2);
});

test('report: a shadow-only home says nothing of "on" (and an "on" home nothing of the shadow\'s agreement)', () => {
  assert.strictEqual(R.report(R.readRecords(home(RECORDS))).on, null);
  assert.ok(!R.text(R.report(R.readRecords(home(RECORDS)))).includes('"on":'));
  assert.strictEqual(R.report(R.readRecords(home(ON))).shadowed, 6, 'records with a prepare field');
});
