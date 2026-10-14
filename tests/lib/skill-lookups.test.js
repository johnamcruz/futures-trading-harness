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

test('skillsInTranscript: a whole-skill skill_lookup in the session\'s transcript counts as a load; a refusal or an error never', () => {
  const ev = (tool, input, output, status = 'completed') => JSON.stringify({ type: 'tool_use', part: { tool, state: { status, input, output } } });
  const read = skill => `<skill name="${skill}">\nbody\n</skill>\n`;
  assert.deepStrictEqual([...SL.skillsInTranscript([ev('harness_skill_lookup', { skill: 'liquidity-concepts' }, read('liquidity-concepts')), ev('harness_skill_lookup', { skill: 'x' }, read('x'), 'error')].join('\n'))], ['liquidity-concepts']);
  // Tightened: a completed call counts only when its reply is the skill. An error reply (an unknown skill), a
  // refused {skill, query} call (schema-valid, refused by the operation), and a reply with no output count as no load.
  const none = [
    ev('harness_skill_lookup', { skill: 'trade-session' }, '[skill-lookup] no skill "trade-session" (skills/<name>/SKILL.md)\n'),
    ev('harness_skill_lookup', { skill: 'trade-session', query: 'x' }, '[skill-lookup] --query lists skills; --skill reads one: give one of them\n'),
    ev('harness_skill_lookup', { skill: 'trade-session' }, undefined),
    ev('harness_skill_lookup', { skill: 'trade-session' }, 'Every skill of the harness (44); <skill name="trade-session">'),
  ];
  assert.deepStrictEqual([...SL.skillsInTranscript(none.join('\n'))], []);
});

test('through the MCP tool: a listing with a role and a required skill\'s name as query records nothing and meets no lookup', async () => {
  const { callTool } = require('../../scripts/lib/harness-tools/protocol');
  const transcript = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const env = { FTH_CYCLE_TRANSCRIPT: transcript };
  const role = 'market-structure-analyst';
  const required = require('../../scripts/lib/role-skills').requiredByRole(path.resolve(__dirname, '..', '..'), 'index');
  const call = { role, start: Date.now() - 1000, end: Date.now() + 60000 };
  const rev = m3([{ trendRule: 'reversal' }]);
  assert.ok(L.unmetLookups(call, { records: [], required, m3: rev }).includes('pullback-vs-reversal'), 'required on a reversal');
  const listed = await callTool('skill_lookup', { role, query: 'pullback-vs-reversal' }, { env });
  assert.ok(!listed.isError, listed.content[0].text);
  assert.match(listed.content[0].text, /^- pullback-vs-reversal: /m);
  assert.strictEqual(fs.existsSync(L.lookupsFile(transcript)), false, 'no lookups file');
  assert.ok(L.unmetLookups(call, { records: L.readLookups(transcript), required, m3: rev }).includes('pullback-vs-reversal'));
  // The control: the same role reading the skill through the tool is recorded and meets it.
  const readOne = await callTool('skill_lookup', { role, skill: 'pullback-vs-reversal' }, { env });
  assert.ok(!readOne.isError, readOne.content[0].text);
  assert.ok(!L.unmetLookups(call, { records: L.readLookups(transcript), required, m3: rev }).includes('pullback-vs-reversal'));
  // A refused {skill, query} call reads nothing and records nothing.
  const t2 = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const refused = await callTool('skill_lookup', { role, skill: 'pullback-vs-reversal', query: 'x' }, { env: { FTH_CYCLE_TRANSCRIPT: t2 } });
  assert.strictEqual(refused.isError, true);
  assert.strictEqual(fs.existsSync(L.lookupsFile(t2)), false);
});

test('a catalog listing (skill_lookup without skill) satisfies no required lookup and no required load', () => {
  const { skillLookup } = require('../../scripts/lib/harness-tools/skills');
  const transcript = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const env = { FTH_CYCLE_TRANSCRIPT: transcript };
  const role = 'market-structure-analyst';
  // The role lists every skill, and filters by a required one's name, inside its call: nothing is recorded.
  skillLookup({ role }, { env, wallNow: () => T + 15 });
  skillLookup({ role, query: 'pullback-vs-reversal' }, { env, wallNow: () => T + 16 });
  const records = L.readLookups(transcript);
  assert.deepStrictEqual(records, []);
  const required = require('../../scripts/lib/role-skills').requiredByRole(path.resolve(__dirname, '..', '..'), 'index');
  const unmet = L.unmetLookups({ role, start: T + 10, end: T + 20 }, { records, required, m3: m3([{ trendRule: 'reversal' }]) });
  assert.ok(unmet.includes('pullback-vs-reversal'), JSON.stringify(unmet));
  // The same calls in the session's transcript count as no skill load either (the head trader's skills-loaded check).
  const ev = input => JSON.stringify({ type: 'tool_use', part: { tool: 'harness_skill_lookup', state: { status: 'completed', input } } });
  assert.deepStrictEqual([...SL.skillsInTranscript([ev({}), ev({ query: 'trade-session' }), ev({ role, query: 'strategy-library' })].join('\n'))], []);
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
  assert.match(checkRolesRan(file, 'full', [], stale), /market-structure-analyst reported without looking up breakout-vs-fakeout, mtf-breakout/);
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
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, {}), [], 'full mode: the cache as before');
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
