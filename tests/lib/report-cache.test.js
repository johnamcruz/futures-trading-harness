'use strict';

// The analyst report cache (trading/report-cache.js): an analyst's report is reused while the briefing parts it
// names hold (until the next 15m close), risk-manager phase 1 while the account is unchanged; phase 2 never.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const RC = require('../../scripts/lib/trading/report-cache');
const B = require('../../scripts/lib/trading/briefing');
const { ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const brief = n => B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ:2026-06', bars: BARS.slice(0, n), minutes: 3 });
const sym = b => [{ symbol: 'MNQ', bar: b.asOf, contractId: 'MNQ:2026-06' }];
const data = b => `Data: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ')}`;
// opencode's task events, as the cycle's output carries them.
const task = (role, report, [start, end]) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: `<task id="s" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`, time: { start, end } } } });
const ACCT = { id: 7, balance: 100000, positions: [], orders: [], workingOrders: 0, attempts: [] };
const DAY = '2026-04-27';
// Three minutes after a cache was written: the next bar, well within phase 1's age.
const soon = c => new Date(Date.parse(c.at) + 3 * 60000);

/** A bar index whose next bar is in the same 15m candle (so m15, h1 and day hold), and one that crosses into the next. */
function pair() {
  for (let n = 1300; n < 1400; n += 1) {
    const a = brief(n);
    const b = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ:2026-06', bars: BARS.slice(0, n + 1), minutes: 3, prev: a });
    if (['m15', 'h1', 'day'].every(p => a.sections[p].version === b.sections[p].version)) return { n, a, b };
  }
  throw new Error('no pair');
}

test('reportVersions: the m15, h1 and day versions a report names in its Data line; none without all three', () => {
  const b = brief(1300);
  assert.deepStrictEqual(RC.reportVersions(`## Structure\n${data(b)}\nBias: long`), { m15: b.sections.m15.version, h1: b.sections.h1.version, day: b.sections.day.version });
  assert.strictEqual(RC.reportVersions('Data: get_bars, market_snapshot'), null, 'a fallback report (no briefing) is never cached');
  assert.strictEqual(RC.reportVersions(`Bias: long\n${data(b).replace(/, h1@[^,]+/, '')}`), null);
  assert.strictEqual(RC.reportVersions(''), null);
  // Shortened to each version's clock time (UTC, as the version reads): the current versions, given them; else none.
  const cur = { m15: b.sections.m15.version, h1: b.sections.h1.version, day: b.sections.day.version };
  const short = `Data: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => `${p}@${b.sections[p].version.slice(p.length + 12, p.length + 17)}`).join(', ')} (all from bar_briefing)`;
  assert.deepStrictEqual(RC.reportVersions(short, cur), cur);
  assert.strictEqual(RC.reportVersions(short), null, 'without the current versions a clock time names nothing');
  assert.strictEqual(RC.reportVersions(short.replace(/m15@\d\d:\d\d/, 'm15@23:59'), cur), null, 'another time');
});

test('an analyst\'s report is served while the briefing parts it was built on hold, then not', () => {
  const { n, a, b } = pair();
  const output = [
    task(ANALYSTS[0], `${data(a)}\nBias: long (high)`, [10, 20]),
    task(ANALYSTS[1], 'Data: get_bars\nBias: short', [10, 20]), // no briefing versions: not reusable
    task(ANALYSTS[2], `${data(a)}\nBias: neutral`, [10, 21]),
    task('risk-manager', 'Phase 1: budget 2 trades', [10, 15]),
    task('risk-manager', 'Phase 2: APPROVE', [30, 40]),
  ].join('\n');
  const now = new Date(a.closedAt);
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now });
  assert.deepStrictEqual(Object.keys(cache.analysts).sort(), [ANALYSTS[0], ANALYSTS[2]].sort());
  assert.strictEqual(cache.phase1.text, 'Phase 1: budget 2 trades', 'phase 1 is the cycle\'s first risk-manager call, never phase 2');
  // The next bar, same 15m candle: both analysts and phase 1 are served.
  const next = RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) });
  assert.deepStrictEqual(next.roles, [ANALYSTS[0], ANALYSTS[2], 'risk-manager']);
  assert.match(next.reports[0].text, /Bias: long \(high\)/);
  assert.strictEqual(next.reports[0].until, [b.sections.m15.validUntil, b.sections.h1.validUntil, b.sections.day.validUntil].sort()[0]);
  // After the next 15m close: a new m15 version, so no analyst report holds (phase 1 still does).
  let m = n + 1;
  let later = b;
  while (later.sections.m15.version === a.sections.m15.version) { m += 1; later = brief(m); }
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: later }, symbols: sym(later), account: ACCT, day: DAY, now: soon(cache) }).roles, ['risk-manager']);
  // A briefing for another bar than the cycle's: nothing of the analysts' is served.
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: a }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, ['risk-manager']);
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: {}, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, ['risk-manager']);
});

test('a first risk-manager report with a qualified verdict ("Final VERDICT: APPROVE") is phase 2, never cached as phase 1', () => {
  const { a } = pair();
  for (const verdict of ['Final VERDICT: APPROVE - size 1', 'Phase 2 VERDICT: APPROVE', '**Final Verdict:** APPROVE', '\u200bVERDICT: APPROVE']) {
    const output = task('risk-manager', `Plan review\n${verdict}`, [10, 15]);
    const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
    assert.strictEqual(cache.phase1, null, verdict);
  }
  const plain = RC.recordReports({ output: task('risk-manager', 'Phase 1: budget 2 trades', [10, 15]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  assert.strictEqual(plain.phase1.text, 'Phase 1: budget 2 trades', 'control: a report with no verdict is phase 1');
});

test('phase 1 is served only while the account is unchanged, on the same trading day', () => {
  const { a, b } = pair();
  const cache = RC.recordReports({ output: task('risk-manager', 'Phase 1', [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  const served = acct => RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: acct, day: DAY, now: soon(cache) }).roles;
  assert.deepStrictEqual(served(ACCT), ['risk-manager']);
  assert.deepStrictEqual(served({ ...ACCT, positions: [{ contractId: 'MNQ:2026-06', type: 1, size: 1, averagePrice: 21000 }] }), [], 'a fill');
  assert.deepStrictEqual(served({ ...ACCT, orders: [{ id: 9, contractId: 'MNQ:2026-06', type: 4, side: 1, size: 1, stopPrice: 20990 }] }), [], 'a working order');
  assert.deepStrictEqual(served({ ...ACCT, balance: 99950 }), [], 'a closed trade');
  assert.deepStrictEqual(served({ ...ACCT, attempts: [{ account: 'topstep_100k', status: 'running', dayPnl: -50 }] }), [], 'an attempt\'s day');
  assert.deepStrictEqual(served(null), [], 'no account read');
  assert.deepStrictEqual(served({ error: 'timeout' }), []);
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: '2026-04-28', now: soon(cache) }).roles, [], 'a new day');
});

test('another symbol set or contract never reuses; served roles keep their entry; phase 1 served is not re-recorded from phase 2', () => {
  const { a, b } = pair();
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), task('risk-manager', 'Phase 1', [1, 2])].join('\n');
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  const rolled = [{ symbol: 'MNQ', bar: b.asOf, contractId: 'MNQ:2026-09' }];
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: rolled, account: ACCT, day: DAY, now: soon(cache) }).roles, []);
  // The next cycle served both and ran only phase 2: the cache keeps the served entries, not phase 2 as phase 1.
  const again = RC.recordReports({ prev: cache, output: task('risk-manager', 'Phase 2: VETO', [5, 6]), served: [ANALYSTS[0], 'risk-manager'], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: new Date(b.closedAt) });
  assert.deepStrictEqual(again.analysts[ANALYSTS[0]], cache.analysts[ANALYSTS[0]]);
  assert.strictEqual(again.phase1.text, 'Phase 1');
  // Not served and not run: dropped.
  const dropped = RC.recordReports({ prev: cache, output: '', served: [], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: new Date(b.closedAt) });
  assert.deepStrictEqual([dropped.analysts, dropped.phase1], [{}, null]);
});

test('the cache file: written atomically, read back, an unreadable one is none; the gate accepts exactly the cacheable roles', () => {
  const home = tmpDir();
  assert.strictEqual(RC.readCache(home), null);
  RC.writeCache(home, { symbols: [], analysts: {}, phase1: null });
  assert.deepStrictEqual(RC.readCache(home), { symbols: [], analysts: {}, phase1: null });
  require('fs').writeFileSync(RC.cacheFile(home), '{not json');
  assert.strictEqual(RC.readCache(home), null);
  RC.removeCache(home);
  assert.strictEqual(RC.readCache(home), null);
  assert.deepStrictEqual(loadConfig({ FTH_CYCLE_CACHED: `${RC.CACHED_ROLES.join(',')},trade-executor,risk-manager phase 2,` }).cycleCached, RC.CACHED_ROLES);
  assert.deepStrictEqual(loadConfig({}).cycleCached, []);
});

test('the runner\'s report cache (runner-wiring reportCacheFor): opencode and Claude only; over the home\'s briefings; a lean cycle serves phase 1 alone', () => {
  const { reportCacheFor } = require('../../scripts/lib/runner-wiring');
  assert.strictEqual(reportCacheFor(tmpDir(), { harness: 'qwen', cycle: 'full' }), null);
  assert.strictEqual(reportCacheFor(tmpDir(), { harness: 'codex', cycle: 'full' }), null);
  const { a, b } = pair();
  const home = tmpDir();
  const rc = reportCacheFor(home, { harness: 'opencode', cycle: 'full' });
  B.writeBriefing(home, a);
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), task('risk-manager', 'Phase 1', [1, 2])].join('\n');
  rc.record({ symbols: sym(a), account: ACCT, now: new Date(a.closedAt), output, served: [] });
  B.writeBriefing(home, b);
  assert.deepStrictEqual(rc.serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0], 'risk-manager']);
  // Index mode (opencode only): a role a lookup is required of on this bar (a reversal candidate) is never served.
  const rev = JSON.parse(JSON.stringify(b));
  rev.sections.m3.data.candidates = [{ name: 'x', direction: 'long', trendRule: 'reversal' }];
  B.writeBriefing(home, rev);
  const index = { FTH_ROLE_SKILLS: 'index' };
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'opencode', cycle: 'full' }, [], {}).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0], 'risk-manager'], 'full mode: as before');
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'opencode', cycle: 'full' }, [], index).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, []);
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'claude', cycle: 'full' }, [], index).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0], 'risk-manager'], 'not an opencode run: no index mode');
  B.writeBriefing(home, b);
  const lean = reportCacheFor(home, { harness: 'claude', cycle: 'lean' });
  assert.deepStrictEqual(lean.serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, ['risk-manager']);
  // A cache that can't be written is removed: nothing stale is served.
  const ro = tmpDir();
  require('fs').mkdirSync(RC.cacheFile(ro)); // a directory where the file goes: the write fails
  const bad = reportCacheFor(ro, { harness: 'opencode', cycle: 'full' });
  assert.throws(() => bad.record({ symbols: sym(a), account: ACCT, now: new Date(a.closedAt), output, served: [] }));
});

test('review fixes: one-symbol cycles only for analysts; an account not read whole or a cycle with an entry gives no phase 1; a long report isn\'t cached', () => {
  const { a, b } = pair();
  const now = new Date(a.closedAt);
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), task('risk-manager', 'Phase 1', [1, 2])].join('\n');
  // Two symbols in the cycle: one analyst call can't show which symbols it covered, so no analyst report is cached or served.
  const MES = { ...a, symbol: 'MES' };
  const two = [...sym(a), { symbol: 'MES', bar: a.asOf, contractId: 'MES:2026-06' }];
  const c2 = RC.recordReports({ output, briefings: { MNQ: a, MES }, symbols: two, account: ACCT, day: DAY, now });
  assert.deepStrictEqual(c2.analysts, {});
  assert.deepStrictEqual(RC.serveReports({ cache: { ...c2, analysts: { [ANALYSTS[0]]: { text: 'x', versions: RC.reportVersions(data(b)) } } }, briefings: { MNQ: b, MES: { ...b, symbol: 'MES' } }, symbols: [...sym(b), { symbol: 'MES', bar: b.asOf, contractId: 'MES:2026-06' }], account: ACCT, day: DAY, now: soon(c2) }).roles, ['risk-manager']);
  // An account read without positions, orders or a balance is never "unchanged".
  for (const acct of [{ ...ACCT, positions: null }, { ...ACCT, orders: null }, { ...ACCT, balance: NaN }, { ...ACCT, error: 'timeout' }]) assert.strictEqual(RC.accountKey(acct), null, JSON.stringify(acct));
  // Two errored reads in a row: still never served.
  const err = { id: 7, error: 'timeout' };
  const ce = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: err, day: DAY, now });
  assert.strictEqual(ce.phase1, null);
  // A cycle that launched a trade-executor: no phase 1 from it (the account changed, or may have).
  const withExec = `${output}\n${task('trade-executor', 'placed', [5, 6])}`;
  assert.strictEqual(RC.recordReports({ output: withExec, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).phase1, null);
  assert.strictEqual(RC.recordReports({ prev: RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }), output: withExec, served: ['risk-manager'], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now }).phase1, null, 'not even a served one');
  // A report longer than the cache holds is not cached (never served cut).
  const long = `${data(a)}\n${'x'.repeat(9000)}\nBias: long`;
  assert.deepStrictEqual(RC.recordReports({ output: task(ANALYSTS[0], long, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).analysts, {});
  assert.strictEqual(RC.recordReports({ output: task('risk-manager', 'y'.repeat(9000), [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).phase1, null);
});

test('a report whose Data line gives the versions as clock times (m15@14:00) is cached and served like a full one', () => {
  const { a, b } = pair();
  const hhmm = p => a.sections[p].version.slice(p.length + 12, p.length + 17);
  const report = `Data: bar_briefing m3@${hhmm('m3')}, m15@${hhmm('m15')}, h1@${hhmm('h1')}, day@${hhmm('day')} (all from bar_briefing)\nBias: short (medium)`;
  const cache = RC.recordReports({ output: task(ANALYSTS[0], report, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  assert.deepStrictEqual(cache.analysts[ANALYSTS[0]].versions, { m15: a.sections.m15.version, h1: a.sections.h1.version, day: a.sections.day.version });
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, [ANALYSTS[0]]);
});

test('a risk-manager report carrying a verdict is a plan review, never cached as phase 1 (run C served a 10:03 VETO for 30 minutes)', () => {
  const { a } = pair();
  const now = new Date(a.closedAt);
  for (const v of ['VERDICT: VETO - mixed alignment', 'VERDICT: APPROVE - size 1', '**VERDICT:** VETO - room', '**VERDICT** - APPROVED', 'verdict: vetoed']) {
    assert.strictEqual(RC.recordReports({ output: task('risk-manager', `Checks\n${v}`, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).phase1, null, v);
  }
  assert.ok(RC.recordReports({ output: task('risk-manager', '## Risk state: 2 trades left, budget $900', [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).phase1, 'control: a state report is cached');
});

test('phase 1 that denies an active attempt is never cached nor served; a cached one expires; no clock, no phase 1', () => {
  const { a, b } = pair();
  const active = { ...ACCT, attempts: [{ account: 'topstep_100k', status: 'active', balance: 100000, floor: 97000, profit: 0, dayPnl: 0, entryBlock: null }] };
  // The June 1, 2026 replay: one report said the attempt was active and, two lines on, that none was running.
  const wrong = '## Risk state\n- topstep_100k attempt is active with $3,000 cushion\n- Both prop_flow_1m and prop_portfolio are loaded but no attempt is currently running\n**Next steps:** Wait for a prop attempt to be started (via combine.js start)';
  const now = new Date(a.closedAt);
  const record = (text, account) => RC.recordReports({ output: task('risk-manager', text, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account, day: DAY, now });
  assert.strictEqual(record(wrong, active).phase1, null, 'not cached: the next cycle runs phase 1 again');
  // Denials a small local model writes, alone or after a correct Attempt line: never cached.
  const line = 'Attempt: topstep_100k active, cushion $3,000, budget $900';
  for (const t of ['However, no prop attempt is running', 'no active attempt', 'the attempt is not running', 'Wait for a prop attempt to be started',
    'No prop attempt is running, so the standard position-sizing limits apply', 'no attempt running; daily limit $1,000 applies', 'Attempt: none listed',
    'Attempt: none', 'the attempt has not been started', "The attempt isn't running", 'attempt not started', 'Prop attempt: not started',
    "there isn't an active attempt", 'There is no running attempt']) {
    assert.strictEqual(RC.deniesActiveAttempt(t, active), true, t);
    assert.strictEqual(record(`${line}\n${t}`, active).phase1, null, t);
  }
  // Correct reports that mention an attempt's absent blocks are not denials (they would only cost a re-read).
  for (const t of ['topstep_100k attempt (active): no attempt-level block', 'Entries: allowed (no attempt block)', 'No attempt DLL breach', 'no attempts blown',
    'No attempt was blown', 'no attempt rule breached', 'No attempt restrictions', 'There is no attempt-level block']) {
    assert.strictEqual(RC.deniesActiveAttempt(t, active), false, t);
    assert.ok(record(`${line}\n${t}`, active).phase1, t);
  }
  // Phrasing can't be enumerated: a report that doesn't confirm the active attempt on its Attempt line is read again.
  assert.strictEqual(record('## Risk state\nBudget: per trade $900', active).phase1, null, 'no Attempt line');
  assert.strictEqual(record('Attempt: topstep_50k active', active).phase1, null, 'another account');
  assert.strictEqual(record('Attempt: topstep_100k blown', active).phase1, null, 'not as listed');
  assert.ok(record('**Attempt:** topstep_100k active, cushion $3,000', active).phase1, 'markdown bold');
  for (const t of ['Attempts: topstep_100k active', 'Prop attempt: topstep_100k active', '| Attempt | topstep_100k | active |', 'Attempt: topstep_100k (active), no entry block',
    'Attempt: topstep_100k active, cushion $3,000, budget $900, entry block: none', 'Attempt: topstep_100k active, cushion $3,000 | none listed']) {
    assert.ok(record(t, active).phase1, t);
  }
  // An Attempt line that names the account but says it isn't running doesn't confirm it.
  for (const t of ['Attempt: topstep_100k not active', 'Attempt: topstep_100k not started (should be active)', 'Attempt: topstep_100k listed active but not running',
    'Attempt: topstep_100k status: active? none running', 'Attempt: topstep_100k was active, now none', 'Attempt: topstep_100k active but not running',
    'Attempt: topstep_100k active, budget $900, none currently running']) {
    assert.strictEqual(record(t, active).phase1, null, t);
  }
  // Exact names: a longer account name never stands in for this one.
  const two = { ...ACCT, attempts: [...active.attempts, { account: 'topstep_100k-b', status: 'active' }] };
  assert.strictEqual(record('Attempt: topstep_100k-b active', two).phase1, null);
  assert.strictEqual(record('Attempt: old-topstep_100k active', active).phase1, null, 'a longer name ending in this one');
  // The status is the word right after the name: an active elsewhere on the line doesn't confirm it.
  assert.strictEqual(record('Attempt: topstep_100k blown, earlier active', active).phase1, null);
  assert.ok(record('Attempt: topstep_100k active\nAttempt: topstep_100k-b active', two).phase1);
  assert.strictEqual(RC.phase1Holds('Budget: per trade $900', ACCT), true, 'no active attempt: nothing to confirm');
  // With no active attempt the same words are true: cached as before.
  assert.strictEqual(record('no attempt is running', ACCT).phase1.text, 'no attempt is running');
  // A report that states the attempt as listed is cached and served on the next bar.
  const right = record('Attempt: topstep_100k active, cushion $3,000, budget $900', active);
  assert.ok(right.phase1);
  assert.deepStrictEqual(RC.serveReports({ cache: right, briefings: { MNQ: b }, symbols: sym(b), account: active, day: DAY, now: soon(right) }).roles, ['risk-manager']);
  // A wrong report already in a cache (an older harness wrote it) is never served.
  const poisoned = { ...right, phase1: { ...right.phase1, text: wrong } };
  assert.deepStrictEqual(RC.serveReports({ cache: poisoned, briefings: { MNQ: b }, symbols: sym(b), account: active, day: DAY, now: soon(poisoned) }).roles, []);
  // Phase 1 is read again at least every PHASE1_MAX_AGE_MS, even on an unchanged account; a future or missing clock serves none.
  const at = Date.parse(right.phase1.at);
  const serveAt = t => RC.serveReports({ cache: right, briefings: { MNQ: b }, symbols: sym(b), account: active, day: DAY, now: t }).roles;
  assert.deepStrictEqual(serveAt(new Date(at + RC.PHASE1_MAX_AGE_MS - 1)), ['risk-manager']);
  assert.deepStrictEqual(serveAt(new Date(at + RC.PHASE1_MAX_AGE_MS)), [], 'expired');
  assert.deepStrictEqual(serveAt(new Date(at - 1)), [], 'from the future');
  assert.deepStrictEqual(serveAt(undefined), [], 'no clock');
});
