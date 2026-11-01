'use strict';

// compose_check (scripts/lib/harness-tools/compose.js, the harness tool and scripts/compose-check.js): the reads checked
// against the cycle bar's briefing only, the plan in code, and every call appended to the record under FTH_HOME
// (never the repository), refused calls too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { composeCheck, parseArgv } = require('../../scripts/lib/harness-tools/compose');
const { BY_NAME } = require('../../scripts/lib/harness-tools/registry');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { readRecords, recordFile } = require('../../scripts/lib/trading/trade-lifecycle');
const { loadStrategies, checkStrategyForOrder, validateStrategy } = require('../../scripts/lib/trading/strategies');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const { scenario1, SCENARIO_1 } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const BAR = '2026-04-23T14:57:00.000Z';

function setup({ cycleBar = BAR, briefing = scenario1() } = {}) {
  const home = tmpDir();
  // The broker's tick specs, as the translator records them: compose_check prices the stop with them only.
  recordBrokerSpecs(home);
  if (briefing) writeBriefing(home, briefing);
  const env = { FTH_HOME: home, ...(cycleBar ? { FTH_CYCLE_BARS: JSON.stringify({ MNQ: cycleBar }) } : {}) };
  return { home, ctx: { env, now: () => new Date('2026-04-23T15:00:05Z') } };
}

test('compose_check prices the stop with the broker\'s recorded tick specs only: none, or one that differs from the table, is NOT OK (never the table)', () => {
  const fsx = require('fs');
  const { home, ctx } = setup();
  for (const f of fsx.readdirSync(home).filter(x => /^contracts-.*\.json$/.test(x))) fsx.rmSync(require('path').join(home, f));
  const none = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
  assert.match(none.text, /PROBLEM: no tick specs from the broker for MNQ[^]*compose_check prices the stop with the broker's tick specs only[^]*NOT OK/);
  // A server spec that differs from the table (a units mix-up): refused until they agree.
  recordBrokerSpecs(home, { specs: { MNQ: { tickSize: 0.25, tickValue: 5 } } });
  const odd = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
  assert.match(odd.text, /PROBLEM: [^\n]*MNQ[^]*NOT OK/);
  assert.doesNotMatch(odd.text, /OK: every read verified/);
});

test('compose_check: scenario 1 is OK, the plan in code, one record appended per call', () => {
  const { home, ctx } = setup();
  const r = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
  assert.ok(!r.code);
  assert.match(r.text, /entry limit 21540.25; stop 21512.5 [^]*111 ticks[^]*R:R 2.08[^]*size 1 risking \$55.5/);
  assert.match(r.text, /OK: every read verified/);
  const [rec] = readRecords(home, 'MNQ');
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(rec.bar, BAR);
  // The shipped valid_bars (2): two 3m bars after the bar's 15:00 close, not the next close (15:03).
  assert.strictEqual(rec.expiresAt, '2026-04-23T15:06:00.000Z');
  assert.strictEqual(rec.at, '2026-04-23T15:00:05.000Z');
  assert.strictEqual(rec.plan.size, 1);
  assert.strictEqual(rec.plan.maxSize, 5, 'the shipped strategy\'s $300 cap over $55.50 a contract');
  assert.strictEqual(rec.signature, 'bias:1h-bos-up+bias:above-prior-rth-range+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:1h-swing-1.5-2.5r');
  assert.strictEqual(rec.context.trendSide, 'with');
  // Under FTH_HOME, never the repository.
  assert.ok(recordFile(home, 'MNQ', '2026-04-23').startsWith(home) && fs.existsSync(recordFile(home, 'MNQ', '2026-04-23')));
  // Append-only: a second call adds a line.
  composeCheck({ symbol: 'MNQ', side: 'short', reads: SCENARIO_1, size: 1 }, ctx);
  const all = readRecords(home, 'MNQ');
  assert.deepStrictEqual(all.map(x => [x.side, x.ok]), [['long', true], ['short', false]]);
});

test('compose_check: a false read, an unknown skill or a size over the cap is recorded NOT OK', () => {
  const { home, ctx } = setup();
  const one = reads => composeCheck({ symbol: 'MNQ', side: 'long', reads, size: 1 }, ctx);
  assert.match(one(SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior VAH down' } : x))).text, /FALSE setup[^]*NOT OK/);
  assert.match(one(SCENARIO_1.map((x, i) => (i === 0 ? { ...x, skill: 'astrology' } : x))).text, /no skill named astrology[^]*NOT OK/);
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 6 }, ctx).text, /PROBLEM: size 6 risks \$333, over the strategy's risk.max_risk_usd \$300/);
  assert.deepStrictEqual(readRecords(home, 'MNQ').map(x => x.ok), [false, false, false]);
});

test('compose_check: no cycle bar, another bar\'s briefing or none: refused and recorded, never checked against a guess', () => {
  for (const [opts, why] of [[{ cycleBar: null }, /no cycle bar for MNQ/], [{ cycleBar: '2026-04-23T15:00:00.000Z' }, /briefing is for the bar at 2026-04-23T14:57:00.000Z, not the cycle's/], [{ briefing: null }, /no bar briefing for MNQ/]]) {
    const { home, ctx } = setup(opts);
    const r = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
    assert.match(r.text, why);
    assert.match(r.text, /NOT OK/);
    const [rec] = readRecords(home, 'MNQ');
    assert.strictEqual(rec.ok, false);
    assert.deepStrictEqual(rec.reads, []);
  }
  // Under a replay clock, never a briefing of a bar that closed after it.
  const { home, ctx } = setup();
  ctx.replayAt = () => new Date('2026-04-23T14:59:00Z');
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx).text, /NOT OK/);
  assert.strictEqual(readRecords(home, 'MNQ')[0].ok, false);
});

test('compose_check: arguments refused before anything is recorded; the CLI\'s argv', () => {
  const { home, ctx } = setup();
  assert.throws(() => composeCheck({ symbol: 'mnq', side: 'long', reads: [], size: 1 }, ctx), /--symbol/);
  assert.throws(() => composeCheck({ symbol: 'MNQ', side: 'flat', reads: [], size: 1 }, ctx), /--side/);
  assert.throws(() => composeCheck({ symbol: 'MNQ', side: 'long', reads: 'x', size: 1 }, ctx), /--reads/);
  assert.ok(!fs.existsSync(path.join(home, 'trade-lifecycle')));
  assert.deepStrictEqual(parseArgv(['--symbol', 'MNQ', '--side=long', '--size', '2', '--reads', '[{"step":"bias"}]']), { symbol: 'MNQ', side: 'long', size: 2, reads: [{ step: 'bias' }] });
  assert.throws(() => parseArgv(['--reads', '{bad']), /--reads: JSON/);
  assert.throws(() => parseArgv(['--bogus']), /unknown argument/);
});

test('the tool: its schema takes the reads and a size and refuses the rest', () => {
  const t = BY_NAME.get('compose_check');
  const ok = { symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 };
  assert.deepStrictEqual(validate(t.inputSchema, ok), []);
  assert.deepStrictEqual(t.args(ok), ok);
  for (const bad of [{ ...ok, size: 0 }, { ...ok, size: 1.5 }, { ...ok, reads: [] }, { ...ok, reads: [{ step: 'exit', skill: 'x', read: 'y' }] },
    { ...ok, reads: [{ step: 'bias', read: 'y' }] }, { ...ok, extra: 1 }, { ...ok, reads: [{ ...SCENARIO_1[0], field: 'h1' }] }, { symbol: 'MNQ', side: 'long', reads: SCENARIO_1 }]) {
    assert.ok(validate(t.inputSchema, bad).length, JSON.stringify(bad).slice(0, 80));
  }
});

test('the trade_lifecycle strategy: signal composed, active, max_risk_usd required; the strategy check takes it (the gate\'s composed-reads check judges its entries)', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'trade_lifecycle');
  assert.ok(s && s.valid, s && s.errors.join('; '));
  assert.strictEqual(s.signal, 'composed');
  assert.strictEqual(s.status, 'active');
  const body = '## When to Use\n## How It Works\n## Examples\n';
  const RULE = { stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 };
  const base = { name: 'x', description: 'a composed strategy for the schema test, forty chars', status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'composed', risk: { stop: 'structure', min_rr: 2, max_risk_usd: 100, ...RULE }, valid_bars: 2 };
  assert.deepStrictEqual(validateStrategy(base, body, 'x'), []);
  assert.strictEqual(s.valid_bars, 2, 'the shipped plan validity: two base bars');
  // valid_bars: required for composed, a whole number from 1 to 3 (the default briefing age refuses past it anyway); no other signal has it.
  for (const bad of [undefined, 0, 4, 1.5, '2']) {
    const { valid_bars: _drop, ...rest } = base;
    assert.ok(validateStrategy(bad === undefined ? rest : { ...base, valid_bars: bad }, body, 'x').some(e => /valid_bars: required for signal: composed/.test(e)), String(bad));
  }
  for (const ok of [1, 3]) assert.deepStrictEqual(validateStrategy({ ...base, valid_bars: ok }, body, 'x'), [], String(ok));
  assert.ok(validateStrategy({ ...base, signal: 'manual', valid_bars: 2, risk: { stop: 'atr:0.5', min_rr: 2 } }, body, 'x').some(e => /valid_bars: only for signal: composed/.test(e)));
  assert.ok(validateStrategy({ ...base, risk: { stop: 'structure', min_rr: 2, ...RULE } }, body, 'x').some(e => /max_risk_usd: required for signal: composed/.test(e)));
  assert.ok(validateStrategy({ ...base, risk: { stop: 'atr:0.5', min_rr: 2, max_risk_usd: 100, ...RULE } }, body, 'x').some(e => /risk.stop: structure/.test(e)));
  assert.ok(validateStrategy({ ...base, exit: { target_r: 2 } }, body, 'x').some(e => /exit: not for signal: composed/.test(e)));
  // The stop rule (the numbers' one home): each key required for composed, in its range; no other signal has one.
  for (const [k, bad] of [['stop_buffer_ticks', -1], ['stop_buffer_ticks', 0.5], ['stop_floor_ticks', 0], ['stop_floor_ticks', '8'], ['stop_floor_atr', -0.1], ['stop_floor_atr', null]]) {
    assert.ok(validateStrategy({ ...base, risk: { ...base.risk, [k]: bad } }, body, 'x').some(e => new RegExp(`risk\\.${k}: required for signal: composed`).test(e)), `${k} ${bad}`);
    const { [k]: _gone, ...without } = base.risk;
    assert.ok(validateStrategy({ ...base, risk: without }, body, 'x').some(e => new RegExp(`risk\\.${k}: required for signal: composed`).test(e)), `${k} missing`);
    assert.ok(validateStrategy({ ...base, signal: 'manual', valid_bars: undefined, risk: { stop: 'atr:0.5', min_rr: 2, [k]: RULE[k] } }, body, 'x').some(e => new RegExp(`risk\\.${k}: only for signal: composed`).test(e)), `${k} on manual`);
  }
  assert.deepStrictEqual({ buffer: s.risk.stop_buffer_ticks, ticks: s.risk.stop_floor_ticks, atr: s.risk.stop_floor_atr }, { buffer: 1, ticks: 8, atr: 0.25 }, 'the shipped stop rule');
  // The strategy check passes it; composed-reads (lifecycle-gate.js) judges the entry on its record.
  assert.strictEqual(checkStrategyForOrder([s], 'trade_lifecycle', 'MNQ', new Date('2026-04-23T15:00:05Z'), 'buy'), null);
});

test('compose_check in a prop attempt: no size fits (the floor all in over the cap) is NOT OK with one HINT; a floor that fits, or no attempt, is unchanged', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  // A plugin root with the shipped trade_lifecycle (its cap as given), the shipped prop_portfolio and its account.
  const pluginRoot = cap => {
    const r = tmpDir();
    const lc = fs.readFileSync(path.join(ROOT, 'strategies', 'trade_lifecycle', 'STRATEGY.md'), 'utf8');
    assert.match(lc, /^ {2}max_risk_usd: 300 /m);
    fs.mkdirSync(path.join(r, 'strategies', 'trade_lifecycle'), { recursive: true });
    fs.writeFileSync(path.join(r, 'strategies', 'trade_lifecycle', 'STRATEGY.md'), lc.replace(/^ {2}max_risk_usd: 300 /m, `  max_risk_usd: ${cap} `));
    // prop_portfolio and the setup it lists beside trade_lifecycle (without it the policy is invalid).
    for (const n of ['prop_portfolio', 'momentum_continuation']) fs.cpSync(path.join(ROOT, 'strategies', n), path.join(r, 'strategies', n), { recursive: true });
    const acct = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').account;
    fs.cpSync(path.join(ROOT, 'accounts', acct), path.join(r, 'accounts', acct), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'skills'), path.join(r, 'skills'));
    return { r, acct };
  };
  // The 4h up beside scenario 1's 1h up: the shipped entry rule (the 4h and the 1h must agree) holds; this test is of the size.
  const agreeing = () => { const b = scenario1(); b.sections.h1.data.h4 = { trend: 'up' }; return b; };
  const run = (cap, attempt) => {
    const { home, ctx } = setup({ briefing: agreeing() });
    const { r, acct } = pluginRoot(cap);
    const account = accountNamed(r, acct, {});
    if (attempt) prop.startAttempt(home, account, new Date('2026-04-23T13:00:00Z'));
    // `healthy`: a snapshot at the starting balance, no loss today (the floor stretch's health); else none (unreadable).
    if (attempt === 'healthy') prop.snapshot(home, account, account.starting_balance, new Date('2026-04-23T13:01:00Z'));
    const out = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, { ...ctx, root: r });
    return { text: out.text, rec: readRecords(home, 'MNQ').pop() };
  };
  // Scenario 1's 111-tick stop, all in (the rulebook's floor 3, its 1 tick of slippage, $0.37 a side):
  // (111 + 1) x $0.50 + $0.74 = $56.74 a contract, 3 of them $170.22. Under a $150 cap: (97 + 1) x $0.50 + $0.74 = $49.74
  // (3: $149.22) fits, 98 ticks ($50.24; 3: $150.72) doesn't: the widest stop is 97 ticks, 24.25 points.
  const tight = run(150, true);
  assert.strictEqual(tight.rec.ok, false);
  assert.match(tight.text, /- PROBLEM: no size fits: the floor of 3 MNQ \(prop_portfolio's rulebook, sizing.min_contracts\) at \$56\.74 a contract all in \(the 111-tick stop with its slippage, and fees both ways\) is \$170\.22, over trade_lifecycle's risk.max_risk_usd \$150/);
  // The rulebook's floor stretch would take the floor, but this attempt has no snapshot: its health can't be read, so
  // NOT OK, and the hint names the stretch's widest stop too ((500 / 3 - $1.24) / $0.50 = 330 ticks), only while healthy.
  assert.match(tight.text, /\$150; the floor stretch to \$500\.00 applies only while the attempt is healthy \(no deficit, no loss today\): the attempt state is unreadable/);
  assert.deepStrictEqual(tight.text.split('\n').filter(l => l.startsWith('- HINT')), ['- HINT size: no size fits: 3 MNQ need a stop of 97 ticks (24.25 points) or less under the $150 cap; the floor at up to $500 (a stop of 330 ticks, 82.5 points, or less) only while the attempt is healthy (no deficit, no loss today); use a closer structural stop or skip']);
  // Healthy (a snapshot at the start, no loss today): the stretch takes the floor ($170.22 within $500): OK.
  const healthy = run(150, 'healthy');
  assert.strictEqual(healthy.rec.ok, true, healthy.text);
  assert.doesNotMatch(healthy.text, /no size fits/);
  assert.match(tight.text, /NOT OK: no entry on this record/);
  assert.ok(tight.rec.problems[0].startsWith('no size fits:'), 'recorded with the record');
  // The shipped $300 cap: 3 at $170.22 fits: OK, as before.
  const shipped = run(300, true);
  assert.strictEqual(shipped.rec.ok, true, shipped.text);
  assert.doesNotMatch(shipped.text, /no size fits/);
  // No attempt: never this refusal (outside an attempt the stated size and the cap decide, unchanged).
  const plain = run(150, false);
  assert.strictEqual(plain.rec.ok, true, plain.text);
  assert.doesNotMatch(plain.text, /no size fits/);
});

test('compose_check in a prop attempt holds the policy\'s entry rule (its rulebook\'s entry): NOT OK on this bar\'s regime; off, or no attempt, unchanged', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const run = ({ regime, on, attempt = true, h4 = 'up' }) => {
    const b = scenario1();
    b.sections.m3.data.regime = { primary: regime, volatility: 'normal' };
    // The 4h up beside the 1h up (the shipped bias_agree holds), unless `h4` says otherwise.
    b.sections.h1.data.h4 = { trend: h4 };
    const { home, ctx } = setup({ briefing: b });
    const r = tmpDir();
    for (const s of ['trade_lifecycle', 'prop_portfolio', 'momentum_continuation']) fs.cpSync(path.join(ROOT, 'strategies', s), path.join(r, 'strategies', s), { recursive: true });
    const acct = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').account;
    fs.cpSync(path.join(ROOT, 'accounts', acct), path.join(r, 'accounts', acct), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'skills'), path.join(r, 'skills'));
    const book = path.join(r, 'accounts', acct, 'RULEBOOK.md');
    const text = fs.readFileSync(book, 'utf8');
    assert.match(text, /^ {6}regime_against: off /m, 'shipped off');
    if (on) fs.writeFileSync(book, text.replace(/^( {6}regime_against: )off/m, '$1on'));
    const account = accountNamed(r, acct, {});
    if (attempt) {
      prop.startAttempt(home, account, new Date('2026-04-23T13:00:00Z'));
      prop.snapshot(home, account, account.starting_balance, new Date('2026-04-23T13:01:00Z'));
    }
    const out = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 3 }, { ...ctx, root: r });
    return { text: out.text, rec: readRecords(home, 'MNQ').pop() };
  };
  const against = run({ regime: 'trend-down', on: true });
  assert.strictEqual(against.rec.ok, false);
  assert.match(against.text, /- PROBLEM: entry rule: the regime is trend-down, against the long: wait until it stops trending against it/);
  assert.ok(against.rec.problems.some(x => /^entry rule:/.test(x)), 'recorded with the record');
  assert.strictEqual(run({ regime: 'trend-up', on: true }).rec.ok, true, 'with it: OK');
  assert.strictEqual(run({ regime: 'trend-down', on: false }).rec.ok, true, 'shipped off: unchanged');
  assert.strictEqual(run({ regime: 'trend-down', on: true, attempt: false }).rec.ok, true, 'no attempt: no policy, no rule');
  // The shipped bias_agree (neutral-15m-declared): scenario 1's own 4h range beside its 1h up goes (the 1h trends the
  // side's way, the 4h not against it); a 4h down against it is NOT OK, naming the rule; no attempt: unchanged.
  assert.strictEqual(run({ regime: 'trend-up', on: false, h4: 'range' }).rec.ok, true, 'BG: the 1h up, the 4h ranging');
  const against4h = run({ regime: 'trend-up', on: false, h4: 'down' });
  assert.strictEqual(against4h.rec.ok, false);
  assert.match(against4h.text, /- PROBLEM: entry rule: the 4h trend is down, against the long: the bias frames \(4h, 1h\) set the side/);
  assert.strictEqual(run({ regime: 'trend-up', on: false, h4: 'down', attempt: false }).rec.ok, true, 'no attempt: no policy, no rule');
});

test('compose_check: the briefing\'s bar (FTH_CYCLE_BRIEFING_BARS) comes before the cycle\'s lane bar (FTH_CYCLE_BARS)', () => {
  const { home, ctx } = setup({ cycleBar: '2026-04-23T14:58:00.000Z' });
  ctx.env.FTH_CYCLE_BRIEFING_BARS = JSON.stringify({ MNQ: BAR });
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx).text, /OK: every read verified/);
  ctx.env.FTH_CYCLE_BRIEFING_BARS = JSON.stringify({ MNQ: '2026-04-23T14:58:00.000Z' });
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx).text, /not the cycle's 2026-04-23T14:58:00.000Z[^]*NOT OK/);
  assert.deepStrictEqual(readRecords(home, 'MNQ').map(x => x.ok), [true, false]);
});

test('compose_check in a prop attempt: the shipped entry rule holds the setup to the 15m or higher (a 3m setup alone NOT OK, the 15m OK); no attempt, unchanged', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const run = (setupRead, attempt = true) => {
    const b = scenario1();
    b.sections.h1.data.h4 = { trend: 'up' };
    const { home, ctx } = setup({ briefing: b });
    const r = tmpDir();
    for (const s of ['trade_lifecycle', 'prop_portfolio', 'momentum_continuation']) fs.cpSync(path.join(ROOT, 'strategies', s), path.join(r, 'strategies', s), { recursive: true });
    const acct = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').account;
    fs.cpSync(path.join(ROOT, 'accounts', acct), path.join(r, 'accounts', acct), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'skills'), path.join(r, 'skills'));
    const account = accountNamed(r, acct, {});
    if (attempt) {
      prop.startAttempt(home, account, new Date('2026-04-23T13:00:00Z'));
      prop.snapshot(home, account, account.starting_balance, new Date('2026-04-23T13:01:00Z'));
    }
    const reads = SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, read: setupRead } : x));
    const out = composeCheck({ symbol: 'MNQ', side: 'long', reads, size: 3 }, { ...ctx, root: r });
    return { text: out.text, rec: readRecords(home, 'MNQ').pop() };
  };
  const three = run('3m broke prior VAH up');
  assert.strictEqual(three.rec.ok, false);
  assert.match(three.text, /- PROBLEM: entry rule: the setup must be on the 15m or higher \(a 3m read only times the entry\)/);
  assert.strictEqual(run('15m rejected prior VAH up').rec.ok, true);
  assert.doesNotMatch(run('3m broke prior VAH up', false).text, /the setup must be on the 15m or higher/, 'no attempt: no policy, no rule');
});

test('compose_check: a composed rejection carries the briefing\'s reaction (REACTION) and, autonomous with candle-reading unread, a READ FIRST line; the record and its OK unchanged', () => {
  const { home, ctx } = setup();
  const plain = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
  assert.match(plain.text, /\n- REACTION 15m rejected up prior VAH: [a-z -]+ \(/);
  assert.match(plain.text, /OK: every read verified/);
  assert.doesNotMatch(plain.text, /READ FIRST/, 'not autonomous: the gate requires none, so no warning');
  const warned = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, { ...ctx, env: { ...ctx.env, FTH_AUTONOMOUS: '1' } });
  assert.match(warned.text, /\n- READ FIRST: this record's reads need [^\n]*candle-reading[^\n]*then compose again/);
  assert.match(warned.text, /OK: every read verified/);
  // The records: OK both times, identical but for their time and id (the lines are the reply's only).
  const [a, b] = readRecords(home, 'MNQ');
  assert.deepStrictEqual([a.ok, b.ok, a.signature === b.signature, a.problems.length, b.problems.length], [true, true, true, 0, 0]);
  // A NOT OK record keeps its NOT OK (the lines never turn it).
  const bad = composeCheck({ symbol: 'MNQ', side: 'short', reads: SCENARIO_1, size: 1 }, { ...ctx, env: { ...ctx.env, FTH_AUTONOMOUS: '1' } });
  assert.match(bad.text, /NOT OK/);
});

test('compose_check: READ FIRST reads the bar\'s compose records as the gate does: a recompose without a rejection after one with it still names candle-reading', () => {
  const { ctx } = setup();
  const auto = { ...ctx, env: { ...ctx.env, FTH_AUTONOMOUS: '1' } };
  const noRejection = SCENARIO_1.map(r => (r.step === 'setup' ? { ...r, read: '15m touched prior vah' } : r));
  // Alone on its bar, a record without a rejection, break or sweep needs no candle-reading.
  const fresh = setup();
  assert.doesNotMatch(composeCheck({ symbol: 'MNQ', side: 'long', reads: noRejection, size: 1 }, { ...fresh.ctx, env: { ...fresh.ctx.env, FTH_AUTONOMOUS: '1' } }).text, /READ FIRST: [^\n]*candle-reading/);
  // After a rejection's record on the same bar: the gate's composed facts still hold it, so the warning names it.
  composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, auto);
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: noRejection, size: 1 }, auto).text, /READ FIRST: [^\n]*candle-reading/);
});
