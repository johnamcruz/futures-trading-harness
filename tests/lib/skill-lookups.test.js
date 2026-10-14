'use strict';

// The roles' skill lookups in a cycle and the gate's rule for them (scripts/lib/trading/skill-lookups.js), the
// situational triggers (skills-loaded.js), and a cycle's lookup stats.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../../scripts/lib/trading/skill-lookups');
const SL = require('../../scripts/lib/trading/skills-loaded');
const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { checkRolesRan } = require('../../scripts/lib/trading/roles-ran');
const { tmpDir } = require('../helpers');

const T = 1.8e12;
const m3 = (candidates, news = { inBlackout: false }) => ({ candidates, news });

test('triggers: each one fires on its briefing fact and not otherwise; the vocabulary is closed', () => {
  const t = SL.parseTrigger;
  assert.ok(SL.fires(t('candidate'), m3([{ name: 'orb' }])));
  assert.ok(!SL.fires(t('candidate'), m3([])));
  assert.ok(!SL.fires(t('candidate'), m3(null)), 'the scan failed: no candidate');
  assert.ok(SL.fires(t('candidate.trendRule=reversal'), m3([{ trendRule: 'allows' }, { trendRule: 'reversal' }])));
  assert.ok(!SL.fires(t('candidate.trendRule=reversal'), m3([{ trendRule: 'allows' }])));
  assert.ok(SL.fires(t('candidate.name=orb'), m3([{ name: 'orb' }])));
  assert.ok(!SL.fires(t('candidate.name=orb'), m3([{ name: 'bos' }])));
  assert.ok(SL.fires(t('candidate.blocked'), m3([{ blocked: 'news blackout' }])));
  assert.ok(!SL.fires(t('candidate.blocked'), m3([{}])));
  assert.ok(SL.fires(t('news.inBlackout'), m3([], { inBlackout: true })));
  assert.ok(!SL.fires(t('news.inBlackout'), m3([], { inBlackout: null })), 'unknown is not a blackout');
  assert.ok(!SL.fires(t('news.inBlackout'), null), 'no facts: nothing fires');
  assert.throws(() => t('position.open'), /unknown trigger/);
  assert.throws(() => t('candidate.trendRule=sideways'), /needs a valid value/);
  assert.throws(() => t('candidate=1'), /takes no value/);
  assert.throws(() => t('__proto__'), /unknown trigger/);
  assert.strictEqual(SL.describeTrigger(t('candidate.trendRule=reversal')), 'a candidate\'s trendRule is reversal');
  for (const e of SL.SITUATIONAL) assert.doesNotThrow(() => t(e.when), e.when);
  // The head trader's: only entries marked head.
  assert.deepStrictEqual(SL.situationalSkills(m3([{ trendRule: 'reversal' }]), [{ when: 'candidate.trendRule=reversal', skill: 'x', head: true }, { when: 'candidate', skill: 'z' }, { when: 'news.inBlackout', skill: 'y', head: true }]), ['x']);
  assert.deepStrictEqual(SL.situationalSkills(m3([{ trendRule: 'reversal' }])), [], 'none of the shipped entries is the head trader\'s');
  assert.deepStrictEqual(SL.situationalSkills(null), []);
});

test('triggers: candidate.fvgAhead fires on an open or partly filled gap beyond price in a candidate\'s direction, and fails closed', () => {
  const ahead = SL.parseTrigger('candidate.fvgAhead');
  const fire = (candidates, liquidity, price = 21500) => SL.fires(ahead, { candidates, liquidity, price, news: { inBlackout: false } });
  const above = { side: 'bearish', low: 21510, high: 21513 };
  const below = { side: 'bullish', low: 21487, high: 21490.5 };
  // A long: a gap above is ahead; one below is not. A short the mirror. Partly filled gaps (their unfilled part) count too.
  assert.ok(fire([{ direction: 'long' }], { openFvgs: [above], partlyFilledFvgs: [] }));
  assert.ok(!fire([{ direction: 'long' }], { openFvgs: [below], partlyFilledFvgs: [] }));
  assert.ok(fire([{ direction: 'short' }], { openFvgs: [], partlyFilledFvgs: [{ ...below, gapLow: 21487, gapHigh: 21493 }] }));
  assert.ok(!fire([{ direction: 'short' }], { openFvgs: [above], partlyFilledFvgs: [] }));
  // Any candidate with one ahead; none fired, or no gaps: nothing.
  assert.ok(fire([{ direction: 'short' }, { direction: 'long' }], { openFvgs: [above] }));
  assert.ok(!fire([], { openFvgs: [above] }));
  assert.ok(!fire([{ direction: 'long' }], { openFvgs: [], partlyFilledFvgs: [] }));
  assert.ok(!fire([{ direction: 'long' }], undefined), 'no liquidity facts: no gap listed');
  // A gap whose edge is at price is not beyond it.
  assert.ok(!fire([{ direction: 'long' }], { openFvgs: [{ low: 21490, high: 21500 }] }));
  // Unreadable with a gap listed: fires (the lookup is required).
  assert.ok(fire([{ direction: 'long' }], { openFvgs: [below] }, null), 'no price');
  assert.ok(fire([{ direction: 'long' }], { openFvgs: [below] }, '21500'), 'a price that is not a number');
  assert.ok(fire([{}], { openFvgs: [below] }), 'no direction');
  assert.ok(fire([{ direction: 'long' }], { openFvgs: [{ low: null, high: 21490.5 }] }), 'an edge missing');
  assert.ok(fire([{ direction: 'long' }], { openFvgs: [null] }), 'a gap that is not an object');
  assert.ok(fire([{ direction: 'long' }], { openFvgs: 'garbage' }), 'a list that is not a list');
  assert.throws(() => SL.parseTrigger('candidate.fvgAhead=1'), /takes no value/);
  assert.strictEqual(SL.describeTrigger(ahead), 'an open or partly filled fair value gap lies ahead of a candidate');
  // The shipped entry: the fair-value-gaps skill, for the roles that index it.
  assert.deepStrictEqual(SL.SITUATIONAL.filter(e => e.when === 'candidate.fvgAhead'), [{ when: 'candidate.fvgAhead', skill: 'fair-value-gaps' }]);
});

test('skillsInTranscript: a whole-skill skill_lookup in the session\'s transcript counts as a load', () => {
  const ev = (tool, input, status = 'completed') => JSON.stringify({ type: 'tool_use', part: { tool, state: { status, input } } });
  assert.deepStrictEqual([...SL.skillsInTranscript([ev('harness_skill_lookup', { skill: 'fair-value-gaps' }), ev('harness_skill_lookup', { skill: 'x' }, 'error')].join('\n'))], ['fair-value-gaps']);
});

test('recordLookup / readLookups: only in a runner\'s cycle and with a role; bad lines skipped', () => {
  const file = path.join(tmpDir(), 'cycle-transcript.jsonl');
  assert.strictEqual(L.recordLookup({}, { role: 'r', skill: 's' }), false, 'no cycle');
  assert.strictEqual(L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role: '', skill: 's' }), false, 'no role');
  assert.strictEqual(L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role: 'r', skill: 's' }, T), true);
  fs.appendFileSync(L.lookupsFile(file), 'garbage\n{"at":"x","role":"r","skill":"s"}\n');
  assert.deepStrictEqual(L.readLookups(file), [{ at: T, role: 'r', skill: 's' }]);
  assert.deepStrictEqual(L.readLookups(`${file}.none`), []);
  assert.deepStrictEqual(L.readLookups(null), []);
});

test('unmetLookups: required only when the trigger fires; met by the role\'s own lookup inside its call; untimed calls fail closed', () => {
  const required = new Map([['va', [{ skill: 'liq', when: [SL.parseTrigger('candidate.trendRule=reversal')] }]]]);
  const call = { role: 'va', start: T + 10, end: T + 20 };
  const rev = m3([{ trendRule: 'reversal' }]);
  assert.deepStrictEqual(L.unmetLookups(call, { records: [], required, m3: m3([{ trendRule: 'allows' }]) }), [], 'no trigger, nothing required');
  assert.deepStrictEqual(L.unmetLookups(call, { records: [], required, m3: null }), ['liq'], 'no current briefing: every one required (fails closed)');
  assert.deepStrictEqual(L.unmetLookups({ role: 'other', start: T, end: T + 1 }, { records: [], required, m3: rev }), [], 'a role with no index');
  assert.deepStrictEqual(L.unmetLookups(call, { records: [], required, m3: rev }), ['liq']);
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 25, role: 'va', skill: 'liq' }], required, m3: rev }), ['liq'], 'after its call');
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 15, role: 'xx', skill: 'liq' }], required, m3: rev }), ['liq'], 'another role');
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 15, role: 'va', skill: 'other' }], required, m3: rev }), ['liq'], 'another skill');
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 15, role: 'va', skill: 'liq' }], required, m3: rev }), []);
  // Line positions (a transcript without call times) can't show it.
  assert.deepStrictEqual(L.unmetLookups({ role: 'va', start: 3, end: 9 }, { records: [{ at: 5, role: 'va', skill: 'liq' }], required, m3: rev }), ['liq']);
  // Another call of the same role this cycle (risk-manager phase 1 and 2) shares its lookups; another role's doesn't.
  const later = { role: 'va', start: T + 30, end: T + 40 };
  const calls = [call, later, { role: 'xx', start: T + 50, end: T + 60 }];
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 35, role: 'va', skill: 'liq' }], required, m3: rev, calls }), []);
  assert.deepStrictEqual(L.unmetLookups(call, { records: [{ at: T + 55, role: 'va', skill: 'liq' }], required, m3: rev, calls }), ['liq']);
});

test('lookupRule + checkRolesRan: the briefing of the order\'s root decides; a report without its lookup doesn\'t count', () => {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  const file = path.join(dir, 'cycle-transcript.jsonl');
  const now = new Date('2026-10-07T14:00:00Z');
  const task = (role, s, e) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: 'VERDICT: APPROVE - size 1', time: { start: T + s, end: T + e } } } });
  fs.writeFileSync(file, [task('market-structure-analyst', 1, 2), task('trend-momentum-analyst', 1, 2), task('volume-liquidity-analyst', 1, 2), task('risk-manager', 1, 2), task('risk-manager', 3, 4)].join('\n'));
  // A reversal candidate: the trend analyst indexes pullback-vs-reversal (and the structure analyst and risk manager theirs).
  writeBriefing(home, { symbol: 'MNQ', sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data: m3([{ trendRule: 'reversal' }]) } } });
  const rule = () => L.lookupRule({ home, transcript: file, contractId: 'MNQ', now });
  const look = (role, skill) => L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + 1.5);
  look('market-structure-analyst', 'pullback-vs-reversal');
  look('market-structure-analyst', 'mtf-rejection');
  look('risk-manager', 'confluence-counting');
  look('risk-manager', 'invalidation');
  assert.match(checkRolesRan(file, 'full', [], rule()), /not returned yet: trend-momentum-analyst \(trend-momentum-analyst reported without looking up pullback-vs-reversal/);
  assert.strictEqual(checkRolesRan(file, 'full', []), null, 'without the rule (full mode)');
  look('trend-momentum-analyst', 'pullback-vs-reversal');
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null);
  // An old briefing (expired at the order's time): every situational skill of each index is required (fails closed).
  const stale = L.lookupRule({ home, transcript: file, contractId: 'MNQ', now: new Date('2026-10-07T15:00:00Z') });
  assert.match(checkRolesRan(file, 'full', [], stale), /market-structure-analyst reported without looking up breakout-vs-fakeout, fair-value-gaps, mtf-breakout/);
  assert.match(checkRolesRan(file, 'full', [], stale), /volume-liquidity-analyst reported without looking up fair-value-gaps/);
  assert.deepStrictEqual(stale.needs('risk-manager'), ['confluence-counting', 'invalidation']);
  assert.strictEqual(L.briefingFacts(home, 'MES', now), null, 'another root has no briefing');
  // A role served from the report cache made no lookup this cycle: not counted where one is required of it.
  const fresh = rule();
  assert.deepStrictEqual(fresh.needs('volume-liquidity-analyst'), []);
  const onlyP2 = path.join(dir, 'p2.jsonl');
  fs.writeFileSync(onlyP2, task('risk-manager', 3, 4));
  const cached = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];
  assert.match(checkRolesRan(onlyP2, 'full', cached, L.lookupRule({ home, transcript: onlyP2, contractId: 'MNQ', now })),
    /not returned yet: market-structure-analyst, trend-momentum-analyst[^]*market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, mtf-rejection/);
  assert.strictEqual(checkRolesRan(onlyP2, 'full', cached), null, 'full mode: the cache counts as before');
});

test('lookupStats: lookups by role, and how many reports a requirement applied to and met', () => {
  const required = new Map([['va', [{ skill: 'liq', when: [SL.parseTrigger('candidate')] }]]]);
  const calls = [{ role: 'va', start: T, end: T + 10 }, { role: 'va', start: T + 20, end: T + 30 }, { role: 'rm', start: T, end: T + 5 }];
  const records = [{ at: T + 5, role: 'va', skill: 'liq' }, { at: T + 6, role: 'rm', skill: 'x' }];
  // One lookup in either call of the role meets both (its calls share their lookups).
  assert.deepStrictEqual(L.lookupStats({ calls, records, required, m3: m3([{}]) }), { lookups: 2, byRole: { va: 1, rm: 1 }, requiredCalls: 2, met: 2 });
  assert.deepStrictEqual(L.lookupStats({ calls, records: records.slice(1), required, m3: m3([{}]) }), { lookups: 1, byRole: { rm: 1 }, requiredCalls: 2, met: 0 });
  assert.deepStrictEqual(L.lookupStats({ calls, records, required, m3: m3([]) }), { lookups: 2, byRole: { va: 1, rm: 1 }, requiredCalls: 0, met: 0 });
});

test('the cycle log records the cycle\'s lookups and removes the run\'s lookups file', () => {
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const home = tmpDir();
  const transcript = path.join(home, 'cycle-transcript.jsonl');
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role: 'volume-liquidity-analyst', skill: 'fair-value-gaps' }, T);
  const { summary } = writeCycleLog(home, { action: 'trade', harness: 'opencode', prompt: 'p', output: '', transcript, roleSkills: 'index' });
  assert.deepStrictEqual(summary.skillLookups, { mode: 'index', lookups: 1, byRole: { 'volume-liquidity-analyst': 1 }, requiredCalls: 0, met: 0 });
  assert.ok(!fs.existsSync(L.lookupsFile(transcript)));
  assert.strictEqual(writeCycleLog(home, { action: 'trade', harness: 'claude', prompt: 'p', output: '' }).summary.skillLookups, undefined, 'no transcript, no lookups');
});

test('the runner\'s report cache: in index mode a role a lookup is required of on this bar runs, not served from the cache', () => {
  const { lookupRoles } = require('../../scripts/lib/runner-wiring');
  const now = new Date('2026-10-07T14:00:00Z');
  const b = data => ({ MNQ: { symbol: 'MNQ', sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data } } } });
  const index = { FTH_ROLE_SKILLS: 'index' };
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, {}), [], 'full mode: the cache as before');
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, index).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst']);
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'allows' }])), now, index).sort(), ['market-structure-analyst', 'risk-manager']);
  assert.deepStrictEqual(lookupRoles(b(m3([])), now, index), [], 'no candidate: the cache serves every role');
  // A gap ahead of a with-trend long: the two roles that index fair-value-gaps, and the risk manager (a candidate).
  assert.deepStrictEqual(lookupRoles(b({ ...m3([{ direction: 'long', trendRule: 'allows' }]), price: 21500, liquidity: { openFvgs: [{ low: 21510, high: 21513 }], partlyFilledFvgs: [] } }), now, index).sort(),
    ['market-structure-analyst', 'risk-manager', 'volume-liquidity-analyst']);
  assert.deepStrictEqual(lookupRoles({ MNQ: null }, now, index).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'], 'no briefing: every role with a situational index runs');
});

test('the head trader holds no skill_lookup: a lookup counts for the role it names, and only roles hold it', () => {
  const { sessionPermission } = require('../../scripts/lib/opencode');
  const p = sessionPermission(['risk-manager']);
  const keys = Object.keys(p);
  assert.strictEqual(p.harness_skill_lookup, 'deny');
  assert.ok(keys.indexOf('harness_skill_lookup') > keys.indexOf('harness_*'), 'after the wildcard: the last match wins');
});
