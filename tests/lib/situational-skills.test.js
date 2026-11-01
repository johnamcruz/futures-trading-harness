'use strict';

// A cycle's situational skills (scripts/lib/situational-skills.js): the skills each fact of the account and the bar
// briefing needs, by decision stage, embedded whole in the cycle's prompt within a byte budget, attested by the run's
// environment; a cycle in no situation as before, byte for byte.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SS = require('../../scripts/lib/situational-skills');
const HP = require('../../scripts/lib/head-prompt');
const SM = require('../../scripts/lib/learning/setup-moments');
const { validateConfig, prompts, childEnv, cycleLoaded } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-04-23T14:03:00.000Z');
const ITEMS = [{ symbol: 'MNQ', bar: { t: '2026-04-23T14:00:00.000Z', c: 21500, file: '/tmp/bars.json', contractId: 'MNQ' } }];
const FLAT = { id: 7, at: NOW.toISOString(), balance: 50000, positions: [], workingOrders: 0 };
const OPEN = { ...FLAT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }], workingOrders: 2, openTrades: ['Open trade MNQ long 1 @ 21500.'] };
const LONG_RULE = 'Trend rule: LONG allowed (prevailing 4h up); short only as a reversal';
const brief = m3 => ({ symbol: 'MNQ', minutes: 3, sections: { m3: { data: { windowEntries: 'allowed', trendRule: LONG_RULE, ...m3 } } } });
const expanding = (dir, levels = []) => ({ '15m': { state: 'expanding', box: { low: 21480, high: 21490, levels }, break: { dir, expansion: true } } });
const ids = facts => facts.map(f => f.id);
const LOADED = cycleLoaded(validateConfig({ harness: 'claude' }));

test('the table: every entry a known stage, its skills real skills, its facts fields a built briefing produces', () => {
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const B = require('../../scripts/lib/trading/briefing');
  const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
  const m3 = B.buildBriefing({ symbol: 'MNQ', contractId: 'MNQ', bars: bars.slice(0, 400), minutes: 3 }).sections.m3.data;
  for (const e of SS.TABLE) {
    assert.ok(SS.STAGES.includes(e.stage), e.id);
    for (const s of e.skills || []) assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), `${e.id}: ${s}`);
    for (const f of e.facts) assert.ok(f === 'account' || f in m3, `${e.id}: ${f} is no briefing field`);
  }
  assert.deepStrictEqual(SS.STAGES, ['management', 'setup', 'entry', 'risk', 'location', 'bias']);
  // The section is read from the skill itself: the "Declared yet?" part of trend-vs-range, whole, nothing after it.
  const text = SS.sectionOf(ROOT, SS.SECTIONS.declared);
  assert.ok(text.startsWith('**Declared yet?**') && HP.skillBody(ROOT, 'trend-vs-range').includes(text) && !text.includes('## Examples'), text);
});

test('each situation\'s facts: an open position is management only; a listed setup brings its setup, entry, risk and location stages; a refused window, bias only', () => {
  assert.deepStrictEqual(ids(SS.factsOf({ state: OPEN })), ['open']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: OPEN, briefings: [brief({ compression: expanding('up') })] })), ['open', 'day'], 'no flat stage while a trade is open');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up') })] })), ['compression', 'entry', 'risk', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]) })] })), ['compression', 'entry', 'risk', 'level', 'trend', 'day'], 'at a key level: its location stage too');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('down') })] })), ['trend', 'day'], 'a break against the trend rule lists nothing');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ cisd: { '15m': { dir: 'bullish', status: 'touched' } } })] })), ['cisd', 'entry', 'risk', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ cisd: { '15m': { dir: 'bullish', status: 'waiting' } } })] })), ['trend', 'day'], 'a CISD not yet live lists nothing');
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, attempts: [{ account: 'x' }] }, briefings: [brief({ compression: expanding('up') })] })), ['compression', 'entry', 'risk', 'attempt', 'trend', 'day']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ windowEntries: 'refused', compression: expanding('up') })] })), ['day', 'window']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ fvgs: { '5m': [{ retest: 'closed inside' }] }, sweeps: [{ name: 'equal highs' }], vwap: { side: 'above' }, lastBreak: { last: { kind: 'BOS' } } })] })), ['fvg', 'reaction', 'sweep', 'vwap', 'trend', 'day', 'structure'], 'a sweep: its reaction read too (candle-reading)');
  // Any candle's rejected or broke relation, or its sweep of the previous candle, setup listed or not: the reaction read.
  for (const c of [{ relations: [{ name: 'prior VAH', rel: 'rejected', dir: 'down' }] }, { relations: [{ name: 'IB high', rel: 'broke', dir: 'up' }] }, { sweep: { of: 'previous 15m high', closedBack: true } }]) {
    assert.ok(ids(SS.factsOf({ state: FLAT, briefings: [brief({ candles: { '15m': c } })] })).includes('reaction'), JSON.stringify(c));
  }
  assert.ok(!ids(SS.factsOf({ state: FLAT, briefings: [brief({ candles: { '15m': { relations: [{ name: 'VWAP (rth)', rel: 'touched' }] } } })] })).includes('reaction'), 'a touch only: none');
  assert.ok(!ids(SS.factsOf({ state: OPEN, briefings: [brief({ candles: { '15m': { relations: [{ name: 'prior VAH', rel: 'rejected', dir: 'down' }] } } })] })).includes('reaction'), 'a trade open: management only');
  assert.deepStrictEqual(ids(SS.factsOf({ state: FLAT, briefings: [brief({ declared: { long: { vwapAtr: 1, ema20Atr: 1, overnight: 'inside', dayMoveAtr: 1, regime: 'with' }, short: { vwapAtr: -1, ema20Atr: -1, overnight: 'inside', dayMoveAtr: -1, regime: 'against' } } })] })), ['declared', 'trend', 'day']);
  // No briefing and flat: nothing. An entry working: its outcome; flat with working orders: the leftovers.
  assert.deepStrictEqual(SS.factsOf({ state: FLAT }), []);
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, entryLines: ['entry MNQ buy 1 @ 21490'] } })), ['open', 'working']);
  assert.deepStrictEqual(ids(SS.factsOf({ state: { ...FLAT, workingOrders: 2 } })), ['leftover']);
});

test('choose: stage order under the budget, nothing the prompt already holds, the rest named (never dropped)', () => {
  const facts = SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]), vwap: { side: 'above' } })] });
  const all = SS.choose(ROOT, facts, { budget: 1e9, loaded: LOADED });
  assert.deepStrictEqual(all.skills, ['compression', 'candle-reading', 'momentum-and-volume', 'top-down-entry', 'invalidation', 'take-profit', 'position-sizing', 'levels-and-reactions', 'vwap-volume-profile', 'mtf-bias-filter', 'daily-bias']);
  assert.deepStrictEqual(all.stages, ['setup', 'entry', 'risk', 'location', 'bias']);
  for (const s of all.skills) assert.ok(!LOADED.includes(s), `${s} is in the prompt already`);
  assert.strictEqual(all.bytes, all.skills.reduce((n, s) => n + Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s))), 0));
  // The head prompt's CORE holds invalidation: with it, never embedded twice.
  assert.ok(!SS.choose(ROOT, facts, { budget: 1e9, loaded: [...LOADED, ...HP.CORE] }).skills.includes('invalidation'));
  // A budget for the setup and its entry only: the rest named, in order.
  const size = s => Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s)));
  // The soft budget counts the rest only (candle-reading, required, is held apart: see below).
  const small = SS.choose(ROOT, facts, { budget: size('compression') + size('momentum-and-volume'), loaded: LOADED });
  assert.deepStrictEqual(small.skills, ['compression', 'candle-reading', 'momentum-and-volume']);
  assert.deepStrictEqual(small.over, ['top-down-entry', 'invalidation', 'take-profit', 'position-sizing', 'levels-and-reactions', 'vwap-volume-profile', 'mtf-bias-filter', 'daily-bias']);
  const text = SS.situationText(ROOT, small);
  assert.ok(text.endsWith(' Also relevant now, read with your skill tool (or skill_lookup, without one): `top-down-entry`, `invalidation`, `take-profit`, `position-sizing`, `levels-and-reactions`, `vwap-volume-profile`, `mtf-bias-filter`, and `daily-bias`.'), text.slice(-200));
  // Strictly in order: a later skill small enough to fit after one that didn't is named, never taken in its place.
  const later = all.skills.slice(3).filter(s => size(s) < size('momentum-and-volume')).sort((x, y) => size(x) - size(y))[0];
  assert.ok(later, 'a later skill smaller than momentum-and-volume');
  const strict = SS.choose(ROOT, facts, { budget: size('compression') + size(later), loaded: LOADED });
  assert.deepStrictEqual(strict.skills, ['compression', 'candle-reading'], `${later} would fit, but it comes after momentum-and-volume`);
  assert.ok(strict.over.includes(later) && strict.over[0] === 'momentum-and-volume');
  // A skill the gate requires of the head (candle-reading, skills-loaded.js SITUATIONAL): never cut for the soft budget,
  // even after one that didn't fit; only the hard room (the prompt's limit) can leave it out, then named.
  const soft = SS.choose(ROOT, facts, { budget: size('compression'), loaded: LOADED });
  assert.deepStrictEqual(soft.skills, ['compression', 'candle-reading'], 'past the soft budget, still embedded');
  const hard = SS.choose(ROOT, facts, { budget: size('compression'), hard: size('compression'), loaded: LOADED });
  assert.deepStrictEqual([hard.skills, hard.over[0]], [['compression'], 'candle-reading']);
  // The prompt's line works on every harness: the skill tool, or skill_lookup where the head trader has none (opencode).
  for (const harness of ['claude', 'opencode']) {
    const p = prompts(validateConfig({ harness, account: '7', sessions: ['09:30-12:00@America/New_York'] }), NOW, ROOT).trade(ITEMS, { state: FLAT, cycleSkills: SS.situationText(ROOT, hard) });
    assert.match(p, /Also relevant now, read with your skill tool \(or skill_lookup, without one\): `candle-reading`/, harness);
  }
  // Management first: an open trade's exit skills before any context.
  const open = SS.choose(ROOT, SS.factsOf({ state: OPEN, briefings: [brief({})] }), { budget: size('manage-position') + size('pullback-vs-reversal') + size('take-profit'), loaded: LOADED });
  assert.deepStrictEqual([open.skills, open.over, open.stages], [['manage-position', 'pullback-vs-reversal', 'take-profit'], ['daily-bias'], ['management']]);
  // The committed budget.
  assert.strictEqual(require('../../scripts/lib/tunables').runner().prompt.situationalSkillBytes, 72000);
});

test('the Setups-to-check line: a compression break on an allowed side (at its key level when its box sits at one) and a tradeable 15m or 1h CISD, the stronger first; nothing against the trend rule, on the 3m or 5m, or outside the window', () => {
  // The 15m setup candle strong up (cisd.js's strong candle: its body, its close in the top third, its range), the 1h's not.
  const candles = { '15m': { closedAt: '2026-04-23T13:45:00.000Z', o: 100, h: 110, l: 99, c: 109.5, closeLocation: 'top', pattern: 'none', rangeAtr: 2 }, '1h': { closedAt: '2026-04-23T13:00:00.000Z', o: 100, h: 110, l: 99, c: 104, closeLocation: 'middle', pattern: 'bullish engulfing', rangeAtr: 2 } };
  const cisd = {
    '1h': { dir: 'bullish', status: 'bounced', displacement: 'strong', engulfing: false },
    '15m': { dir: 'bullish', status: 'touched', displacement: 'strong', engulfing: true, sweep: { name: 'overnight low', price: 21480 } },
    '5m': { dir: 'bullish', status: 'bounced', displacement: 'strong', engulfing: true },
    '3m': { dir: 'bearish', status: 'touched', displacement: 'strong', engulfing: false },
  };
  const m3 = brief({ candles, compression: expanding('up', [{ name: 'prior rth high', edge: 'inside' }, { name: 'overnight low', edge: 'top' }]), cisd }).sections.m3.data;
  assert.deepStrictEqual(SM.setupChecks(m3), [
    { kind: 'compression', tf: '15m', dir: 'up', side: 'long', read: '15m compression break up', level: 'overnight low' },
    { kind: 'cisd', tf: '15m', dir: 'up', side: 'long', read: '15m cisd up', status: 'touched OTE', displacement: 'strong', level: 'overnight low' },
    { kind: 'cisd', tf: '1h', dir: 'up', side: 'long', read: '1h cisd up', status: 'bounced OTE', displacement: 'strong' },
  ], 'the stronger setup candle first (its strength and close, an engulfing never ranked above it), then the higher frame; the 3m and 5m CISDs are no setups');
  assert.strictEqual(SM.checkLine({}, { barClose: 0, checks: SM.setupChecks(m3) }), '- Setups to check: "15m compression break up" (long, at overnight low); "15m cisd up" (long, strong displacement, touched OTE, at overnight low); "1h cisd up" (long, strong displacement, bounced OTE). Compose and check each (trade-lifecycle, compression, cisd); pass unless every read is true; SKIP each one you don\'t compose, with its reason.');
  // Only what can be traded now: waiting (unless freshly confirmed on the frame's last candle), void, expired: none.
  for (const status of ['waiting', 'void', 'expired', 'weak']) assert.deepStrictEqual(SM.setupChecks({ ...m3, compression: {}, cisd: { '15m': { ...cisd['15m'], status } } }), [], status);
  assert.deepStrictEqual(SM.setupChecks({ ...m3, compression: {}, cisd: { '15m': { ...cisd['15m'], status: 'waiting', confirmedClose: candles['15m'].closedAt } } }).map(c => c.status), ['fresh confirmation']);
  assert.deepStrictEqual(SM.setupChecks({ ...m3, compression: {}, cisd: { '15m': { ...cisd['15m'], status: 'waiting', confirmedClose: '2026-04-23T13:30:00.000Z' } } }), [], 'confirmed on an earlier candle: waiting, no setup yet');
  assert.deepStrictEqual(SM.setupChecks({ ...m3, cisd: {}, compression: expanding('up', [{ name: 'prior rth high', edge: 'inside' }]) }).map(c => c.level), [undefined], 'no level at an edge: none named');
  assert.deepStrictEqual(SM.setupChecks({ ...m3, windowEntries: 'refused' }), []);
  assert.deepStrictEqual(SM.setupChecks({ ...m3, trendRule: 'Trend rule: SHORT allowed (prevailing 4h down); long only as a reversal' }), [], 'against the trend rule: none (the 3m short CISD is no setup)');
  assert.strictEqual(SM.checkLine({}, { barClose: 0, checks: [] }), null);
  // A 3m or 5m CISD times the entry of a listed setup: the cisd skill in the entry stage.
  assert.ok(ids(SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up'), cisd: { '3m': cisd['5m'] } })] })).includes('cisd-timing'));
  assert.ok(!ids(SS.factsOf({ state: FLAT, briefings: [brief({ cisd: { '3m': cisd['5m'] } })] })).includes('cisd-timing'), 'no setup listed: nothing to time');
});

test('budgetFor and fit: the section gets what the prompt\'s limit leaves, never below 0; management kept first, the rest named, the whole within the limit', () => {
  assert.strictEqual(SS.budgetFor({ base: 2000, max: 126976, reserve: 48000 }), 76976);
  assert.strictEqual(SS.budgetFor({ base: 2000, max: 126976 }), 124976, 'no cycle data: nothing reserved');
  assert.strictEqual(SS.budgetFor({ base: 130000, max: 126976, reserve: 48000 }), 0);
  const facts = SS.factsOf({ state: OPEN, briefings: [brief({ vwap: { side: 'above' }, lastBreak: { last: { kind: 'BOS' } } })] });
  const size = s => Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s)));
  const exits = ['manage-position', 'pullback-vs-reversal', 'take-profit'];
  const base = 2000;
  const max = base + exits.reduce((n, s) => n + size(s), 0) + 1000;
  const got = SS.fit(ROOT, facts, { loaded: LOADED, base, max });
  assert.deepStrictEqual(got.skills, exits);
  assert.ok(got.over.length > 0, 'the rest named');
  assert.ok(base + Buffer.byteLength(SS.situationText(ROOT, got)) <= max);
  // With the cycle data's reserve too: still within the limit, the exit skills going last.
  const tight = SS.fit(ROOT, facts, { loaded: LOADED, base, max, reserve: size('take-profit') });
  assert.deepStrictEqual(tight.skills, ['manage-position', 'pullback-vs-reversal']);
  assert.ok(base + Buffer.byteLength(SS.situationText(ROOT, tight)) + size('take-profit') <= max);
  assert.deepStrictEqual(SS.fit(ROOT, facts, { loaded: LOADED, base: 1e6, max }).skills, [], 'no room: none embedded, every one named');
  // No slack: room for the exit skills' blocks but not the section's own words, so the last one goes.
  const exact = base + exits.reduce((n, s) => n + size(s), 0);
  const none = SS.fit(ROOT, facts, { loaded: LOADED, base, max: exact });
  assert.ok(!none.skills.includes('take-profit') && none.skills.length > 0, JSON.stringify(none.skills));
  assert.ok(base + Buffer.byteLength(SS.situationText(ROOT, none)) <= exact);
  // No slack beside a reserve (the cycle data still to come): the reserve is held in the fit, not only in the budget.
  const reserve = 5000;
  const held = SS.fit(ROOT, facts, { loaded: LOADED, base, max: exact + reserve, reserve });
  assert.ok(!held.skills.includes('take-profit') && held.skills.length > 0, JSON.stringify(held.skills));
  assert.ok(base + Buffer.byteLength(SS.situationText(ROOT, held)) + reserve <= exact + reserve);
});

test('the cycle prompt: a cycle in no situation is byte-identical to the prompt without a section; a situation\'s section sits before the result line', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', sessions: ['09:30-12:00@America/New_York'] });
  const P = prompts(cfg, NOW, ROOT);
  const flat = P.trade(ITEMS, { state: FLAT });
  assert.strictEqual(P.trade(ITEMS, { state: FLAT, cycleSkills: '' }), flat, 'no section: as before, byte for byte');
  assert.doesNotMatch(flat, /<skill name=/);
  assert.match(flat, /also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/, 'day-context on the every-cycle load list');
  const chosen = SS.choose(ROOT, SS.factsOf({ state: OPEN }), { loaded: LOADED });
  const text = SS.situationText(ROOT, chosen);
  const managed = P.trade(ITEMS, { state: OPEN, cycleSkills: text });
  assert.ok(managed.includes(text) && /CYCLE RESULT: <[^>]+> - <reason>\.$/.test(managed));
  assert.deepStrictEqual(HP.embeddedSkills(managed, ROOT), ['manage-position', 'pullback-vs-reversal', 'take-profit']);
  assert.strictEqual(managed.length, P.trade(ITEMS, { state: OPEN }).length + text.length);
});

test('childEnv: the run that has a section writes and attests it for its cycle; never a role run, a probe, an inherited value, or without one', () => {
  const cfg = validateConfig({ harness: 'claude' });
  const home = tmpDir();
  const base = { FTH_HOME: home, FTH_CYCLE_SKILLS: 'stale' };
  const chosen = SS.choose(ROOT, SS.factsOf({ state: OPEN }), { loaded: LOADED });
  assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, {})), 'none: an inherited one dropped');
  const env = childEnv(cfg, ROOT, base, { cycleSkills: chosen });
  const att = SS.parseAttestation(env.FTH_CYCLE_SKILLS);
  assert.ok(att, env.FTH_CYCLE_SKILLS);
  assert.deepStrictEqual(att.skills, chosen.skills);
  assert.strictEqual(att.cycle, require('../../scripts/lib/trading/check-order').cycleId(env));
  assert.strictEqual(fs.readFileSync(att.config, 'utf8'), SS.situationText(ROOT, chosen));
  for (const context of [{ cycleSkills: chosen, roleRun: 'trade-executor' }, { cycleSkills: chosen, probe: true }, { cycleSkills: 'yes' }]) {
    assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, context)), JSON.stringify(context).slice(0, 60));
  }
  assert.ok(SS.parseAttestation(childEnv(validateConfig({ harness: 'opencode' }), ROOT, base, { cycleSkills: chosen }).FTH_CYCLE_SKILLS));
  for (const harness of ['qwen', 'codex']) assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(validateConfig({ harness }), ROOT, base, { cycleSkills: chosen })), harness);
  // A section only (no whole skill): written, but nothing to attest.
  assert.ok(!('FTH_CYCLE_SKILLS' in childEnv(cfg, ROOT, base, { cycleSkills: { skills: [], sections: ['declared'] } })));
});

test('the attestation: one cycle, the runner\'s file name, the table\'s skills only; malformed values parse to null', () => {
  const home = tmpDir();
  const chosen = { skills: ['compression'], sections: [], over: [], why: ['a compression break on the Setups to check'] };
  const { file, text } = SS.writeSituation(home, ROOT, chosen);
  assert.match(path.basename(file), /^cycle-skills-[0-9a-f]{64}\.md$/);
  assert.strictEqual(SS.writeSituation(home, ROOT, chosen).file, file);
  assert.strictEqual(SS.writeSituation(home, ROOT, { skills: [] }), null);
  const att = SS.attestation({ file, text, root: ROOT, cycle: '0123456789abcdef' });
  assert.deepStrictEqual(SS.parseAttestation(JSON.stringify(att)), att);
  assert.strictEqual(SS.attestation({ file, text, root: ROOT, cycle: 'nope' }), null);
  for (const bad of ['', '{', '[]', JSON.stringify({ ...att, kind: 'x' }), JSON.stringify({ ...att, skills: [] }), JSON.stringify({ ...att, cycle: 'x' }), JSON.stringify({ ...att, sha256: 'abc' })]) {
    assert.strictEqual(SS.parseAttestation(bad), null, bad);
  }
});

test('the prompt\'s section sizes: a managed, a setup and a context-only cycle, each within the budget', () => {
  const budget = require('../../scripts/lib/tunables').runner().prompt.situationalSkillBytes;
  const cases = {
    managed: SS.factsOf({ state: OPEN, briefings: [brief({})] }),
    setup: SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up', [{ name: 'overnight low', edge: 'top' }]), vwap: { side: 'above' } })] }),
    context: SS.factsOf({ state: FLAT, briefings: [brief({ vwap: { side: 'above' } })] }),
  };
  for (const [name, facts] of Object.entries(cases)) {
    const chosen = SS.choose(ROOT, facts, { loaded: LOADED });
    assert.ok(chosen.bytes > 0 && chosen.bytes <= budget, `${name}: ${chosen.bytes}`);
    assert.ok(Buffer.byteLength(SS.situationText(ROOT, chosen)) < budget + 1000, name);
  }
});

test('availability: on every bar a candle rejects, breaks or sweeps a level, candle-reading is in the head\'s context (embedded), or, past the hard limit only, named on the Also-relevant-now line and warned by compose_check', () => {
  const RL = require('../../scripts/lib/trading/reaction-lookup');
  const size = s => Buffer.byteLength(HP.block(s, HP.skillBody(ROOT, s)));
  const triggers = [
    { candles: { '15m': { relations: [{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down' }] } } },
    { candles: { '1h': { relations: [{ name: 'IB high', price: 100, rel: 'broke', dir: 'up' }] } } },
    { candles: { '3m': { sweep: { of: 'previous 3m low', closedBack: true } } } },
    { sweeps: [{ name: 'prior RTH high' }] },
  ];
  for (const t of triggers) {
    const facts = SS.factsOf({ state: FLAT, briefings: [brief(t)] });
    // Any soft budget, even none: embedded while the hard limit has room.
    for (const budget of [1e9, 0]) assert.ok(SS.fit(ROOT, facts, { budget, base: 1000, max: 1e9, loaded: LOADED }).skills.includes('candle-reading'), `${JSON.stringify(t)}, budget ${budget}`);
    // The hard limit leaves no room: named, never dropped silently, and compose_check's warning names it.
    const tight = SS.fit(ROOT, facts, { base: 1000, max: 1000 + size('candle-reading') - 1, loaded: LOADED });
    assert.ok(!tight.skills.includes('candle-reading') && tight.over.includes('candle-reading'), JSON.stringify(t));
    assert.match(SS.situationText(ROOT, tight), /Also relevant now[^]*`candle-reading`/);
    assert.match(RL.warningFor(['15m rejected prior vah down'], { env: { FTH_AUTONOMOUS: '1' }, root: ROOT }), /candle-reading/);
  }
  // Hard room between compression's size and candle-reading's: compression embedded (nothing reserved for a skill that
  // can't fit), candle-reading named and warned.
  const both = SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up'), candles: { '15m': { relations: [{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down' }] } } })] });
  const between = SS.fit(ROOT, both, { base: 1000, max: 1000 + Math.floor((size('compression') + size('candle-reading')) / 2), loaded: LOADED });
  assert.ok(size('compression') < size('candle-reading'));
  assert.ok(between.skills.includes('compression') && !between.skills.includes('candle-reading') && between.over.includes('candle-reading'), JSON.stringify(between));
  assert.match(SS.situationText(ROOT, between), /Also relevant now[^]*`candle-reading`/);
  // A required skill is the last to go: the rest shrinks before it.
  const facts = SS.factsOf({ state: FLAT, briefings: [brief({ compression: expanding('up'), candles: { '15m': { relations: [{ name: 'prior VAH', price: 100, rel: 'rejected', dir: 'down' }] } } })] });
  const room = SS.fit(ROOT, facts, { base: 1000, max: 1000 + size('candle-reading') + 400, loaded: LOADED });
  assert.ok(room.skills.includes('candle-reading'), JSON.stringify(room.skills));
});
