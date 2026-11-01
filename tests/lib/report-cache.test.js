'use strict';

// The analyst report cache (trading/report-cache.js): an analyst's report is reused while the briefing parts it
// names hold (until the next 15m close), under the role's own instructions and this root; phase 1 (live data) and
// phase 2 never.
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
  assert.strictEqual(cache.phase1, null, 'phase 1: no facts key given, none cached');
  // The next bar, same 15m candle: both analysts are served (phase 1 runs again).
  const next = RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) });
  assert.deepStrictEqual(next.roles, [ANALYSTS[0], ANALYSTS[2]]);
  assert.match(next.reports[0].text, /Bias: long \(high\)/);
  assert.strictEqual(next.reports[0].until, [b.sections.m15.validUntil, b.sections.h1.validUntil, b.sections.day.validUntil].sort()[0]);
  // After the next 15m close: a new m15 version, so no analyst report holds.
  let m = n + 1;
  let later = b;
  while (later.sections.m15.version === a.sections.m15.version) { m += 1; later = brief(m); }
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: later }, symbols: sym(later), account: ACCT, day: DAY, now: soon(cache) }).roles, []);
  // A briefing for another bar than the cycle's: nothing of the analysts' is served.
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: a }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, []);
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: {}, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, []);
});

test('an analyst\'s entry keeps its own call\'s lookups and the facts key of the cycle that made them; a served report carries both; a kept entry keeps its key', () => {
  const { a, b } = pair();
  const T = 1.8e12;
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [T + 10, T + 20]), task(ANALYSTS[1], `${data(a)}\nBias: long`, [T + 10, T + 20])].join('\n');
  const lookups = [{ at: T + 12, role: ANALYSTS[0], skill: 'rejection' }, { at: T + 25, role: ANALYSTS[1], skill: 'late' }, { at: T + 12, role: ANALYSTS[2], skill: 'other' }];
  const c = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt), lookups, lookupsKey: 'k-a' });
  assert.deepStrictEqual([c.analysts[ANALYSTS[0]].lookups, c.analysts[ANALYSTS[0]].lookupsKey], [['rejection'], 'k-a']);
  assert.deepStrictEqual(c.analysts[ANALYSTS[1]].lookups, [], 'a lookup after its call is not its report\'s');
  const s = RC.serveReports({ cache: c, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(c) });
  const r0 = s.reports.find(r => r.role === ANALYSTS[0]);
  assert.deepStrictEqual([r0.lookups, r0.lookupsKey], [['rejection'], 'k-a']);
  // Served on the next bar and recorded again: the entry is kept with its own key, not the new cycle's.
  const kept = RC.recordReports({ prev: c, output: '', served: [ANALYSTS[0]], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(c), lookups: [], lookupsKey: 'k-b' });
  assert.strictEqual(kept.analysts[ANALYSTS[0]].lookupsKey, 'k-a');
  // An entry from before keys were kept: served with none.
  const old = { ...c, analysts: { [ANALYSTS[0]]: { ...c.analysts[ANALYSTS[0]], lookupsKey: undefined } } };
  assert.strictEqual(RC.serveReports({ cache: old, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(c) }).reports.find(r => r.role === ANALYSTS[0]).lookupsKey, null);
});

test('another symbol set or contract never reuses; served roles keep their entry; a phase 2 report is never recorded as anything', () => {
  const { a, b } = pair();
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), task('risk-manager', 'Phase 1', [1, 2])].join('\n');
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  const rolled = [{ symbol: 'MNQ', bar: b.asOf, contractId: 'MNQ:2026-09' }];
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: rolled, account: ACCT, day: DAY, now: soon(cache) }).roles, []);
  // The next cycle served both and ran only phase 2: the cache keeps the served entries, not phase 2 as phase 1.
  const again = RC.recordReports({ prev: cache, output: task('risk-manager', 'Phase 2: VETO', [5, 6]), served: [ANALYSTS[0]], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: new Date(b.closedAt) });
  assert.deepStrictEqual(again.analysts[ANALYSTS[0]], cache.analysts[ANALYSTS[0]]);
  assert.strictEqual(again.phase1, null);
  // Not served and not run: dropped.
  const dropped = RC.recordReports({ prev: cache, output: '', served: [], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: new Date(b.closedAt) });
  assert.deepStrictEqual(dropped.analysts, {});
});

test('the cache file: written atomically, read back, an unreadable one is none; the gate accepts exactly the cacheable roles', () => {
  const home = tmpDir();
  assert.strictEqual(RC.readCache(home), null);
  RC.writeCache(home, { symbols: [], analysts: {} });
  assert.deepStrictEqual(RC.readCache(home), { symbols: [], analysts: {} });
  require('fs').writeFileSync(RC.cacheFile(home), '{not json');
  assert.strictEqual(RC.readCache(home), null);
  RC.removeCache(home);
  assert.strictEqual(RC.readCache(home), null);
  // Phase 1 counts as cached only with the runner's record of its facts (phase1-facts.js; the gate tests): named alone, not.
  assert.deepStrictEqual(loadConfig({ FTH_CYCLE_CACHED: `${RC.CACHED_ROLES.join(',')},trade-executor,risk-manager phase 2,` }).cycleCached, ANALYSTS);
  assert.deepStrictEqual(loadConfig({}).cycleCached, []);
});

test('the runner\'s report cache (runner-wiring reportCacheFor): opencode and Claude only; over the home\'s briefings; a lean cycle serves nothing (phase 1 is never cached)', () => {
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
  assert.deepStrictEqual(rc.serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0]]);
  // Index mode (opencode only): a role a lookup is required of on this bar (a reversal candidate) is not served when its
  // cached report made no lookup (these calls carry no wall-clock times).
  const rev = JSON.parse(JSON.stringify(b));
  rev.sections.m3.data.candidates = [{ name: 'x', direction: 'long', trendRule: 'reversal' }];
  B.writeBriefing(home, rev);
  const index = { FTH_ROLE_SKILLS: 'index' };
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'opencode', cycle: 'full' }, [], { FTH_ROLE_SKILLS: 'full' }).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0]], 'full mode: as before');
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'opencode', cycle: 'full' }, [], index).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, []);
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'opencode', cycle: 'full' }, [], {}).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [], 'index is the default');
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'claude', cycle: 'full' }, [], index).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0]], 'not an opencode run: no index mode');
  B.writeBriefing(home, b);
  const lean = reportCacheFor(home, { harness: 'claude', cycle: 'lean' });
  assert.deepStrictEqual(lean.serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, []);
  // A cache that can't be written is removed: nothing stale is served.
  const ro = tmpDir();
  require('fs').mkdirSync(RC.cacheFile(ro)); // a directory where the file goes: the write fails
  const bad = reportCacheFor(ro, { harness: 'opencode', cycle: 'full' });
  assert.throws(() => bad.record({ symbols: sym(a), account: ACCT, now: new Date(a.closedAt), output, served: [] }));
});

test('review fixes: one-symbol cycles only for analysts; a long report isn\'t cached', () => {
  const { a, b } = pair();
  const now = new Date(a.closedAt);
  const output = [task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), task('risk-manager', 'Phase 1', [1, 2])].join('\n');
  // Two symbols in the cycle: one analyst call can't show which symbols it covered, so no analyst report is cached or served.
  const MES = { ...a, symbol: 'MES' };
  const two = [...sym(a), { symbol: 'MES', bar: a.asOf, contractId: 'MES:2026-06' }];
  const c2 = RC.recordReports({ output, briefings: { MNQ: a, MES }, symbols: two, account: ACCT, day: DAY, now });
  assert.deepStrictEqual(c2.analysts, {});
  assert.deepStrictEqual(RC.serveReports({ cache: { ...c2, analysts: { [ANALYSTS[0]]: { text: 'x', versions: RC.reportVersions(data(b)) } } }, briefings: { MNQ: b, MES: { ...b, symbol: 'MES' } }, symbols: [...sym(b), { symbol: 'MES', bar: b.asOf, contractId: 'MES:2026-06' }], account: ACCT, day: DAY, now: soon(c2) }).roles, []);
  // A report longer than the cache holds is not cached (never served cut).
  const long = `${data(a)}\n${'x'.repeat(9000)}\nBias: long`;
  assert.deepStrictEqual(RC.recordReports({ output: task(ANALYSTS[0], long, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now }).analysts, {});
});

test('a report whose Data line gives the versions as clock times (m15@14:00) is cached and served like a full one', () => {
  const { a, b } = pair();
  const hhmm = p => a.sections[p].version.slice(p.length + 12, p.length + 17);
  const report = `Data: bar_briefing m3@${hhmm('m3')}, m15@${hhmm('m15')}, h1@${hhmm('h1')}, day@${hhmm('day')} (all from bar_briefing)\nBias: short (medium)`;
  const cache = RC.recordReports({ output: task(ANALYSTS[0], report, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  assert.deepStrictEqual(cache.analysts[ANALYSTS[0]].versions, { m15: a.sections.m15.version, h1: a.sections.h1.version, day: a.sections.day.version });
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) }).roles, [ANALYSTS[0]]);
});

test('the desk\'s reports (the runner ran those roles) are recorded as the roles\' own, with their own lookups, and served the next bar', () => {
  const { a, b } = pair();
  const now = new Date(a.closedAt);
  const fresh = [
    { role: ANALYSTS[0], text: `${data(a)}\nBias: long (high)`, lookups: ['rejection', 'breakout', 'rejection'] },
    { role: 'risk-manager', text: '## Risk state: account 7\nPhase 1: budget 2 trades', lookups: [] },
  ];
  const cache = RC.recordReports({ output: '', fresh, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now, lookupsKey: 'k' });
  assert.deepStrictEqual(Object.keys(cache.analysts), [ANALYSTS[0]]);
  assert.deepStrictEqual([cache.analysts[ANALYSTS[0]].lookups, cache.analysts[ANALYSTS[0]].lookupsKey], [['breakout', 'rejection'], 'k']);
  assert.strictEqual(cache.phase1, null, 'phase 1: no facts key, none');
  const next = RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache) });
  assert.deepStrictEqual(next.roles, [ANALYSTS[0]]);
});

test('freshness pin: an analyst\'s report is served only on its own 15m bar, whatever the clock says and across a restart (the cache file read back); a report built on an older bar is never served', () => {
  const { n, a, b } = pair();
  const output = task(ANALYSTS[0], `${data(a)}\nBias: long (high)`, [10, 20]);
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  // A restart: the cache as the next runner reads it from the harness home.
  const home = tmpDir();
  RC.writeCache(home, cache);
  const back = RC.readCache(home);
  let m = n + 1;
  let later = b;
  while (later.sections.m15.version === a.sections.m15.version) { m += 1; later = brief(m); }
  // Clocks: the cache's own time, far behind, far ahead; none of them serves a report past its 15m bar, all serve it inside.
  for (const now of [soon(cache), new Date(Date.parse(cache.at) - 86400000), new Date(Date.parse(cache.at) + 86400000), null]) {
    assert.deepStrictEqual(RC.serveReports({ cache: back, briefings: { MNQ: b }, symbols: sym(b), account: null, day: DAY, now }).roles, [ANALYSTS[0]], `inside its 15m bar (${now && now.toISOString()})`);
    assert.deepStrictEqual(RC.serveReports({ cache: back, briefings: { MNQ: later }, symbols: sym(later), account: null, day: DAY, now }).roles, [], `after the next 15m close (${now && now.toISOString()})`);
  }
  // Built on an older bar than the cycle's (the cache holds an earlier 15m bar's report): never served on the new one.
  const old = RC.recordReports({ output: task(ANALYSTS[0], `${data(a)}\nBias: long`, [10, 20]), briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt) });
  assert.deepStrictEqual(RC.serveReports({ cache: old, briefings: { MNQ: later }, symbols: sym(later), account: null, day: DAY, now: soon(old) }).roles, []);
  // A briefing that isn't the cycle's bar's (a missing bar: the newest briefing is an older bar's): nothing served.
  assert.deepStrictEqual(RC.serveReports({ cache: back, briefings: { MNQ: a }, symbols: sym(later), account: null, day: DAY, now: soon(cache) }).roles, []);
});

test('freshness: an analyst\'s report is keyed by its instructions; an edit of its agent file or one of its skills, or a cache from before the key, is a miss', () => {
  const { a, b } = pair();
  const root = tmpDir();
  const ROOT = path.join(__dirname, '..', '..');
  for (const d of ['agents', 'skills']) require('fs').cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  const keys = () => Object.fromEntries(ANALYSTS.map(r => [r, RC.roleKey(root, r)]));
  const k0 = keys();
  assert.ok(ANALYSTS.every(r => /^[0-9a-f]{64}$/.test(k0[r])), 'every analyst has a key');
  assert.deepStrictEqual(keys(), k0, 'unchanged: the same key');
  const output = ANALYSTS.map(r => task(r, `${data(a)}\nBias: long`, [1, 2])).join('\n');
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), now: new Date(a.closedAt), bodyKeys: k0 });
  const serve = (c, bodyKeys) => RC.serveReports({ cache: c, briefings: { MNQ: b }, symbols: sym(b), now: soon(c), bodyKeys }).roles;
  assert.deepStrictEqual(serve(cache, k0), [...ANALYSTS]);
  // The first analyst's agent file edited, then the second's first role-skill: each misses alone.
  const agentFile = path.join(root, 'agents', `${ANALYSTS[0]}.md`);
  require('fs').appendFileSync(agentFile, '\nAn edited line.\n');
  const k1 = keys();
  assert.notStrictEqual(k1[ANALYSTS[0]], k0[ANALYSTS[0]]);
  assert.deepStrictEqual(serve(cache, k1), ANALYSTS.filter(r => r !== ANALYSTS[0]));
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const fm = parseFrontmatter(require('fs').readFileSync(path.join(root, 'agents', `${ANALYSTS[1]}.md`), 'utf8')).data['role-skills'];
  const skill = (Array.isArray(fm) ? fm : String(fm).split(','))[0].trim();
  require('fs').appendFileSync(path.join(root, 'skills', skill, 'SKILL.md'), '\n- An edited line.\n');
  const k2 = keys();
  assert.notStrictEqual(k2[ANALYSTS[1]], k1[ANALYSTS[1]], `${skill} edited`);
  assert.ok(!serve(cache, k2).includes(ANALYSTS[1]));
  // A cache from before the key (no body on its entries) under a keyed runner: a miss. A served entry recorded again
  // under a new key is dropped, never carried over.
  const old = { ...cache, analysts: Object.fromEntries(Object.entries(cache.analysts).map(([r, e]) => [r, { ...e, body: undefined }])) };
  assert.deepStrictEqual(serve(old, k0), []);
  const carried = RC.recordReports({ prev: cache, output: '', served: [ANALYSTS[0]], briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), bodyKeys: k1 });
  assert.deepStrictEqual(carried.analysts, {});
});

test('freshness: the cache is scoped to its harness root: another root\'s or checkout\'s cache (a home it wrote) serves nothing', () => {
  const { a, b } = pair();
  const r1 = tmpDir();
  const r2 = tmpDir();
  assert.notStrictEqual(RC.scopeOf(r1), RC.scopeOf(r2));
  assert.strictEqual(RC.scopeOf(r1), RC.scopeOf(path.join(r1, '.')), 'its real path');
  const cache = RC.recordReports({ output: task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), now: new Date(a.closedAt), scope: RC.scopeOf(r1) });
  const serve = scope => RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), scope }).roles;
  assert.deepStrictEqual(serve(RC.scopeOf(r1)), [ANALYSTS[0]]);
  assert.deepStrictEqual(serve(RC.scopeOf(r2)), [], 'another root');
  assert.deepStrictEqual(serve(null), [], 'a scoped cache under an unscoped reader');
  assert.deepStrictEqual(RC.serveReports({ cache: { ...cache, scope: undefined }, briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), scope: RC.scopeOf(r1) }).roles, [], 'a cache from before the scope');
  // Recorded under another root: nothing kept from the other one.
  assert.deepStrictEqual(RC.recordReports({ prev: cache, output: '', served: [ANALYSTS[0]], briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), scope: RC.scopeOf(r2) }).analysts, {});
  // Through the runner's wiring: a home another root wrote serves nothing to this one.
  const { reportCacheFor } = require('../../scripts/lib/runner-wiring');
  const ROOT = path.join(__dirname, '..', '..');
  const home = tmpDir();
  B.writeBriefing(home, a);
  reportCacheFor(home, { harness: 'claude', cycle: 'full' }, [], {}, ROOT).record({ symbols: sym(a), account: ACCT, now: new Date(a.closedAt), output: task(ANALYSTS[0], `${data(a)}\nBias: long`, [1, 2]), served: [] });
  B.writeBriefing(home, b);
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'claude', cycle: 'full' }, [], {}, ROOT).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [ANALYSTS[0]]);
  const other = tmpDir();
  for (const d of ['agents', 'skills']) require('fs').cpSync(path.join(ROOT, d), path.join(other, d), { recursive: true });
  assert.deepStrictEqual(reportCacheFor(home, { harness: 'claude', cycle: 'full' }, [], {}, other).serve({ symbols: sym(b), account: ACCT, now: new Date(b.closedAt) }).roles, [], 'the same documents, another checkout');
});


// --- The smart phase-1 cache: served only under its live facts' key (phase1-facts.js). ---

const P1F = require('../../scripts/lib/trading/phase1-facts');
const p1In = (b, over = {}) => ({ account: ACCT, day: DAY, trades: [], barClose: Date.parse(b.asOf) + 180000, barMinutes: 3, cooldown: { maxConsecutiveLosses: 2, lossCooldownMin: 30 }, windowEntries: 'allowed', lessons: [], reviewed: [], ...over });
const p1Of = (b, over) => { const facts = P1F.phase1Facts(p1In(b, over)); return facts ? { facts, key: P1F.factsKey(facts) } : null; };

test('phase 1 is served only under its live facts\' key: equal, the report; any fact changed (a balance, a position, a cooldown that ended), a fresh run', () => {
  const { a, b } = pair();
  const output = task('risk-manager', '## Risk state: account 7\nP&L today $0\nStreak: 0; cooldown none\nAttempt: none', [1, 2]);
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt), phase1: p1Of(a) });
  assert.strictEqual(cache.phase1.factsKey, p1Of(a).key);
  const serve = phase1 => RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache), phase1 }).roles;
  assert.deepStrictEqual(serve(p1Of(b)), ['risk-manager'], 'the next bar, every fact the same');
  assert.deepStrictEqual(serve(p1Of(b, { account: { ...ACCT, balance: 99950 } })), [], 'a closed trade');
  assert.deepStrictEqual(serve(p1Of(b, { account: { ...ACCT, positions: [{ contractId: 'MNQ:2026-06', type: 1, size: 1, averagePrice: 21000 }] } })), [], 'a fill');
  assert.deepStrictEqual(serve(p1Of(b, { day: '2026-04-28' })), [], 'a new day');
  assert.deepStrictEqual(serve(null), [], 'no key (a read failed)');
  assert.deepStrictEqual(serve({ facts: {}, key: null }), []);
  // A cooldown recorded with 1 bar left, ending before the next bar: another key, phase 1 runs.
  const T0 = Date.parse(a.asOf) + 180000;
  const losses = [{ profitAndLoss: -50, creationTimestamp: new Date(T0 - 40 * 60000).toISOString() }, { profitAndLoss: -50, creationTimestamp: new Date(T0 - 28 * 60000).toISOString() }];
  const cooling = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt), phase1: p1Of(a, { trades: losses }) });
  assert.strictEqual(P1F.phase1Facts(p1In(a, { trades: losses })).loss.bars, 1);
  assert.deepStrictEqual(RC.serveReports({ cache: cooling, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cooling), phase1: p1Of(b, { trades: losses }) }).roles, [], 'the cooldown ended between the bars');
  // A report that denies an active attempt, or carries a verdict (phase 2's), is never recorded; nor from a cycle that
  // launched a trade-executor; nor with no key.
  const active = { ...ACCT, attempts: [{ account: 'acct_a', status: 'active', balance: 100000, floor: 97000, profit: 0, dayPnl: 0, entryBlock: null }] };
  const rec = (text, over = {}) => RC.recordReports({ output: task('risk-manager', text, [1, 2]), briefings: { MNQ: a }, symbols: sym(a), account: active, day: DAY, now: new Date(a.closedAt), phase1: p1Of(a, { account: active }), ...over }).phase1;
  assert.ok(rec('Attempt: acct_a active, cushion $3,000'), 'control');
  assert.strictEqual(rec('Attempt: acct_a active\nbut no attempt is currently running'), null);
  assert.strictEqual(rec('Plan review\nVERDICT: APPROVE - size 1'), null);
  assert.strictEqual(rec('Attempt: acct_a active', { output: `${task('risk-manager', 'Attempt: acct_a active', [1, 2])}\n${task('trade-executor', 'placed', [5, 6])}` }), null);
  assert.strictEqual(rec('Attempt: acct_a active', { phase1: null }), null);
  // Two symbols: none.
  assert.strictEqual(rec('Attempt: acct_a active', { symbols: [...sym(a), { symbol: 'MES', bar: a.asOf, contractId: 'MES:2026-06' }], briefings: { MNQ: a, MES: { ...a, symbol: 'MES' } } }), null);
  // Under another risk-manager body (an edit): a miss.
  const bodied = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), account: ACCT, day: DAY, now: new Date(a.closedAt), phase1: p1Of(a), bodyKeys: { 'risk-manager': 'b1' } });
  const sb = bodyKeys => RC.serveReports({ cache: bodied, briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(bodied), phase1: p1Of(b), bodyKeys }).roles;
  assert.deepStrictEqual([sb({ 'risk-manager': 'b1' }), sb({ 'risk-manager': 'b2' })], [['risk-manager'], []]);
  // Served and recorded again under the same key: kept; under another: dropped.
  assert.ok(RC.recordReports({ prev: cache, output: '', served: ['risk-manager'], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache), phase1: p1Of(b) }).phase1);
  assert.strictEqual(RC.recordReports({ prev: cache, output: '', served: ['risk-manager'], briefings: { MNQ: b }, symbols: sym(b), account: ACCT, day: DAY, now: soon(cache), phase1: p1Of(b, { account: { ...ACCT, balance: 1 } }) }).phase1, null);
});

test('an unreadable key keys nothing (F4): a role whose agent or skill file can\'t be read, or no root, is neither served nor recorded', () => {
  const { a, b } = pair();
  const ROOT = path.join(__dirname, '..', '..');
  const root = tmpDir();
  for (const d of ['agents', 'skills']) require('fs').cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  // A role-skill folder missing: that role's key is null.
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const fm = parseFrontmatter(require('fs').readFileSync(path.join(root, 'agents', `${ANALYSTS[0]}.md`), 'utf8')).data['role-skills'];
  const skill = (Array.isArray(fm) ? fm : String(fm).split(','))[0].trim();
  require('fs').rmSync(path.join(root, 'skills', skill), { recursive: true });
  const keys = Object.fromEntries(RC.CACHED_ROLES.map(r => [r, RC.roleKey(root, r)]));
  assert.strictEqual(keys[ANALYSTS[0]], null, `${skill} missing`);
  const output = ANALYSTS.map(r => task(r, `${data(a)}\nBias: long`, [1, 2])).join('\n');
  const cache = RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), now: new Date(a.closedAt), bodyKeys: keys, scope: 's' });
  assert.ok(!(ANALYSTS[0] in cache.analysts), 'not recorded');
  assert.ok(ANALYSTS[1] in cache.analysts);
  // An entry written for it under some key (an older runner) is never served under a null key.
  const forged = { ...cache, analysts: { ...cache.analysts, [ANALYSTS[0]]: { ...cache.analysts[ANALYSTS[1]] } } };
  forged.analysts[ANALYSTS[0]].body = null;
  assert.ok(!RC.serveReports({ cache: forged, briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), bodyKeys: keys, scope: 's' }).roles.includes(ANALYSTS[0]));
  // No root resolved (scope null): nothing served, nothing recorded.
  assert.deepStrictEqual(RC.serveReports({ cache, briefings: { MNQ: b }, symbols: sym(b), now: soon(cache), bodyKeys: keys, scope: null }).roles, []);
  assert.deepStrictEqual(RC.recordReports({ output, briefings: { MNQ: a }, symbols: sym(a), now: new Date(a.closedAt), bodyKeys: keys, scope: null }).analysts, {});
  assert.strictEqual(RC.scopeOf(path.join(root, 'no-such-dir')), null);
});
