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

test('skillsInTranscript: a whole-skill skill_lookup in the session\'s transcript counts as a load', () => {
  const ev = (tool, input, status = 'completed') => JSON.stringify({ type: 'tool_use', part: { tool, state: { status, input } } });
  assert.deepStrictEqual([...SL.skillsInTranscript([ev('harness_skill_lookup', { skill: 'liquidity-concepts' }), ev('harness_skill_lookup', { skill: 'x' }, 'error')].join('\n'))], ['liquidity-concepts']);
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
  look('market-structure-analyst', 'rejection');
  look('risk-manager', 'confluence-counting');
  look('risk-manager', 'invalidation');
  assert.match(checkRolesRan(file, 'full', [], rule()), /not returned yet: trend-momentum-analyst \(trend-momentum-analyst reported without looking up pullback-vs-reversal/);
  assert.strictEqual(checkRolesRan(file, 'full', []), null, 'without the rule (full mode)');
  look('trend-momentum-analyst', 'pullback-vs-reversal');
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null);
  // An old briefing (expired at the order's time): every situational skill of each index is required (fails closed).
  const stale = L.lookupRule({ home, transcript: file, contractId: 'MNQ', now: new Date('2026-10-07T15:00:00Z') });
  assert.match(checkRolesRan(file, 'full', [], stale), /market-structure-analyst reported without looking up breakout-vs-fakeout, breakout(?![\w-])/);
  assert.deepStrictEqual(stale.needs('risk-manager'), ['confluence-counting', 'invalidation']);
  assert.strictEqual(L.briefingFacts(home, 'MES', now), null, 'another root has no briefing');
  // A role served from the report cache made no lookup this cycle: not counted where one is required of it.
  const fresh = rule();
  assert.deepStrictEqual(fresh.needs('volume-liquidity-analyst'), []);
  const onlyP2 = path.join(dir, 'p2.jsonl');
  fs.writeFileSync(onlyP2, task('risk-manager', 3, 4));
  const cached = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];
  assert.match(checkRolesRan(onlyP2, 'full', cached, L.lookupRule({ home, transcript: onlyP2, contractId: 'MNQ', now })),
    /not returned yet: market-structure-analyst, trend-momentum-analyst[^]*market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, rejection/);
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
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role: 'volume-liquidity-analyst', skill: 'liquidity-concepts' }, T);
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
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, { FTH_ROLE_SKILLS: 'full' }), [], 'full mode: the cache as before');
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, {}).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst'], 'index is the default');
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, index).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst']);
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'allows' }])), now, index).sort(), ['market-structure-analyst', 'risk-manager']);
  assert.deepStrictEqual(lookupRoles(b(m3([])), now, index), [], 'no candidate: the cache serves every role');
  assert.deepStrictEqual(lookupRoles({ MNQ: null }, now, index).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst'], 'no briefing: every role with a situational index runs');
});

test('the head trader holds no skill_lookup: a lookup counts for the role it names, and only roles hold it', () => {
  const { sessionPermission } = require('../../scripts/lib/opencode');
  const p = sessionPermission(['risk-manager']);
  const keys = Object.keys(p);
  assert.strictEqual(p.harness_skill_lookup, 'deny');
  assert.ok(keys.indexOf('harness_skill_lookup') > keys.indexOf('harness_*'), 'after the wildcard: the last match wins');
});

test('cycleFacts: the runner\'s briefing with each closed lane\'s candidates (its briefing on its bar, else its signal record on its bar); neither, or no current briefing: null (every lookup)', () => {
  const now = new Date('2026-10-07T14:00:00Z');
  const first = { minutes: 3, sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data: m3([{ name: 'a', trendRule: 'allows' }]) } } };
  const t = '2026-10-07T13:59:00.000Z';
  const frame = (asOf, candidates) => () => ({ asOf, sections: { bar: { data: { candidates } } } });
  // No lane: the runner's briefing, as before; not current: null.
  assert.deepStrictEqual(L.cycleFacts({ first, now }), first.sections.m3.data);
  assert.strictEqual(L.cycleFacts({ first, now: new Date('2026-10-07T14:03:00Z') }), null);
  assert.strictEqual(L.cycleFacts({ first: null, now }), null);
  // The first lane's own minutes are the briefing itself: skipped.
  assert.deepStrictEqual(L.cycleFacts({ first, now, lanes: [{ minutes: 3, t }] }), first.sections.m3.data);
  // A lane's briefing on its bar: its candidates are added.
  const both = L.cycleFacts({ first, now, lanes: [{ minutes: 1, t }], readFrame: frame(t, [{ name: 'b', trendRule: 'reversal' }]) });
  assert.deepStrictEqual(both.candidates.map(c => c.name), ['a', 'b']);
  // Its briefing is another bar's: its signal record on the bar, each candidate under every trend rule.
  const sig = L.cycleFacts({ first, now, lanes: [{ minutes: 1, t }], readFrame: frame('x', []), readSignal: () => ({ asOf: t, candidates: [{ name: 'c', direction: 'long' }] }) });
  assert.deepStrictEqual(sig.candidates.filter(c => c.name === 'c').map(c => c.trendRule), ['reversal', 'allows', 'against']);
  // Neither on the bar (an older record, an unreadable one, none): null.
  for (const readSignal of [() => ({ asOf: 'older', candidates: [] }), () => ({ error: 'EACCES' }), () => null]) {
    assert.strictEqual(L.cycleFacts({ first, now, lanes: [{ minutes: 1, t }], readSignal }), null);
  }
  // lanesFor: the config's { ROOT: { minutes: t } } for a root of the family.
  assert.deepStrictEqual(L.lanesFor({ MNQ: { 1: t } }, 'MNQ'), [{ minutes: 1, t }]);
  assert.deepStrictEqual(L.lanesFor({}, 'MNQ'), []);
});

test('the runner\'s report cache and the gate agree on a lane\'s candidates: lookupRoles reads the closed lanes too', () => {
  const { lookupRoles } = require('../../scripts/lib/runner-wiring');
  const { writeFrameBriefing } = require('../../scripts/lib/trading/briefing');
  const { writeSignals } = require('../../scripts/lib/trading/signal-state');
  const home = tmpDir();
  const now = new Date('2026-10-07T14:00:00Z');
  const t = '2026-10-07T13:59:00.000Z';
  const b = { MNQ: { symbol: 'MNQ', minutes: 3, sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data: m3([]) } } } };
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home }), [], 'no lane, no candidate: the cache serves every role');
  // The 1m lane closed with a with-trend candidate (its briefing on the bar): those roles run.
  writeFrameBriefing(home, { symbol: 'MNQ', minutes: 1, asOf: t, sections: { bar: { data: { candidates: [{ name: 'x', trendRule: 'allows' }] } } } });
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 1: t } } }).sort(), ['market-structure-analyst', 'risk-manager']);
  assert.deepStrictEqual(lookupRoles(b, now, { FTH_ROLE_SKILLS: 'full' }, { home, laneBars: { MNQ: { 1: t } } }), [], 'full mode');
  // No briefing on the lane's bar, its record shows nothing fired: nothing required; no record on the bar: every role.
  const later = '2026-10-07T14:00:00.000Z';
  writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: later, closedAt: '2026-10-07T14:01:00.000Z', candidates: [] });
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 1: later } } }), []);
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 5: later } } }).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst']);
});
