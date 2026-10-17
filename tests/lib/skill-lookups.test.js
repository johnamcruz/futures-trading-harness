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
  assert.deepStrictEqual([...SL.skillsInTranscript([ev('harness_skill_lookup', { skill: 'fair-value-gaps' }, read('fair-value-gaps')), ev('harness_skill_lookup', { skill: 'x' }, read('x'), 'error')].join('\n'))], ['fair-value-gaps']);
  // Tightened: a completed call counts only when its reply is the skill. An error reply (an unknown skill), a
  // refused {skill, query} call (schema-valid, refused by the operation), and a reply with no output count as no load.
  const none = [
    ev('harness_skill_lookup', { skill: 'trade-session' }, '[skill-lookup] no skill "trade-session" (skills/<name>/SKILL.md)\n'),
    ev('harness_skill_lookup', { skill: 'trade-session', query: 'x' }, '[skill-lookup] --query lists skills; --skill reads one: give one of them\n'),
    ev('harness_skill_lookup', { skill: 'trade-session' }, undefined),
    ev('harness_skill_lookup', { skill: 'trade-session' }, 'Every skill of the harness (44); <skill name="trade-session">'),
  ];
  assert.deepStrictEqual([...SL.skillsInTranscript(none.join('\n'))], []);
  // The skill's reply after leading whitespace (a newline, spaces) is still the skill: it counts.
  assert.deepStrictEqual([...SL.skillsInTranscript(ev('harness_skill_lookup', { skill: 'invalidation' }, `\n  ${read('invalidation')}`))], ['invalidation']);
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

test('unmetLookups: a run the runner ran itself counts with its recorded lookups, under the same requirement; never the file\'s records in its times', () => {
  const required = new Map([['va', [{ skill: 'liq', when: [SL.parseTrigger('candidate.trendRule=reversal')] }]]]);
  const rev = m3([{ trendRule: 'reversal' }]);
  const ran = (lookups, role = 'va') => ({ role, start: T + 10, end: T + 20, text: 'r', lookups, source: 'runner' });
  assert.deepStrictEqual(L.unmetLookups(ran(['liq']), { records: [], required, m3: rev }), []);
  assert.deepStrictEqual(L.unmetLookups(ran([]), { records: [], required, m3: rev }), ['liq'], 'its run looked nothing up');
  assert.deepStrictEqual(L.unmetLookups(ran(['other']), { records: [], required, m3: rev }), ['liq'], 'another skill');
  assert.deepStrictEqual(L.unmetLookups(ran([]), { records: [{ at: T + 15, role: 'va', skill: 'liq' }], required, m3: rev }), ['liq'], 'the head session\'s file inside its times is not its run\'s');
  assert.deepStrictEqual(L.unmetLookups(ran(['liq']), { records: [], required, m3: null }), [], 'no briefing: every one required, and its lookups hold it');
  // A field named lookups on a transcript call (no runner source) is no lookup.
  assert.deepStrictEqual(L.unmetLookups({ role: 'va', start: T + 10, end: T + 20, lookups: ['liq'] }, { records: [], required, m3: rev }), ['liq']);
  // One role's calls share their lookups, whoever ran them (risk-manager phase 1 by the runner, phase 2 in the transcript).
  const p2 = { role: 'va', start: T + 30, end: T + 40 };
  assert.deepStrictEqual(L.unmetLookups(p2, { records: [], required, m3: rev, calls: [ran(['liq']), p2] }), []);
  assert.deepStrictEqual(L.unmetLookups(p2, { records: [], required, m3: rev, calls: [ran(['liq'], 'xx'), p2] }), ['liq'], 'another role\'s run');
});

test('lookupRule + checkRolesRan: the briefing of the order\'s root decides; a report without its lookup doesn\'t count', () => {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  const file = path.join(dir, 'cycle-transcript.jsonl');
  const now = new Date('2026-10-07T14:00:00Z');
  const task = (role, s, e) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: 'VERDICT: APPROVE - size 1', time: { start: T + s, end: T + e } } } });
  fs.writeFileSync(file, [task('market-structure-analyst', 1, 2), task('trend-momentum-analyst', 1, 2), task('volume-liquidity-analyst', 1, 2), task('risk-manager', 1, 2), task('risk-manager', 3, 4)].join('\n'));
  // A reversal candidate: the trend analyst indexes pullback-vs-reversal (and the structure analyst and risk manager theirs).
  writeBriefing(home, { symbol: 'MNQ', sections: { m3: { version: 'm3@2026-10-07T14:00:00.000Z', validUntil: '2026-10-07T14:03:00.000Z', data: m3([{ trendRule: 'reversal' }]) } } });
  const rule = () => L.lookupRule({ home, transcript: file, contractId: 'MNQ', now });
  const look = (role, skill) => L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + 1.5);
  look('market-structure-analyst', 'pullback-vs-reversal');
  look('market-structure-analyst', 'rejection');
  assert.match(checkRolesRan(file, 'full', [], rule()), /not returned yet: trend-momentum-analyst \(trend-momentum-analyst reported without looking up pullback-vs-reversal/);
  assert.strictEqual(checkRolesRan(file, 'full', []), null, 'without the rule (full mode)');
  look('trend-momentum-analyst', 'pullback-vs-reversal');
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null);
  // An old briefing (expired at the order's time): every situational skill of each index is required (fails closed).
  const stale = L.lookupRule({ home, transcript: file, contractId: 'MNQ', now: new Date('2026-10-07T15:00:00Z') });
  assert.match(checkRolesRan(file, 'full', [], stale), /market-structure-analyst reported without looking up breakout-vs-fakeout, breakout(?![\w-])/);
  // The risk manager carries its situational skills in its core: nothing is required of it, even without a briefing.
  assert.deepStrictEqual(stale.needs('risk-manager'), []);
  assert.deepStrictEqual(stale.needs('market-structure-analyst').sort(), ['breakout', 'breakout-vs-fakeout', 'pullback-vs-reversal', 'rejection']);
  assert.strictEqual(L.briefingFacts(home, 'MES', now), null, 'another root has no briefing');
  // A role served from the report cache made no lookup this cycle: not counted where one is required of it, unless the
  // call that produced its cached report made the lookups (cachedLookups, the runner's FTH_CYCLE_CACHED_LOOKUPS).
  const fresh = rule();
  assert.deepStrictEqual(fresh.needs('volume-liquidity-analyst'), []);
  const onlyP2 = path.join(dir, 'p2.jsonl');
  fs.writeFileSync(onlyP2, task('risk-manager', 3, 4));
  const cached = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];
  const p2Rule = cachedLookups => L.lookupRule({ home, transcript: onlyP2, contractId: 'MNQ', now, cachedLookups });
  assert.match(checkRolesRan(onlyP2, 'full', cached, p2Rule()),
    /not returned yet: market-structure-analyst, trend-momentum-analyst[^]*market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, rejection/);
  assert.strictEqual(checkRolesRan(onlyP2, 'full', cached), null, 'full mode: the cache counts as before');
  // The cached reports' own lookups: counted for that role only, only the skills it looked up, and only under this
  // order's facts key (the bar and lanes the requirement comes from).
  const KEY = L.briefingFactsKey(home, 'MNQ', now, {});
  assert.strictEqual(KEY, 'm3@2026-10-07T14:00:00.000Z');
  assert.strictEqual(L.briefingFactsKey(home, 'MNQ', now, { MNQ: { 1: '2026-10-07T13:59:00.000Z' } }), 'm3@2026-10-07T14:00:00.000Z|1@2026-10-07T13:59:00.000Z');
  assert.strictEqual(L.briefingFactsKey(home, 'MNQ', now, null), null, 'unreadable lanes');
  assert.strictEqual(L.briefingFactsKey(home, 'MNQ', new Date('2026-10-07T15:00:00Z')), null, 'no current briefing');
  const keyed = (o, key = KEY) => Object.fromEntries(Object.entries(o).map(([r, skills]) => [r, { skills, key }]));
  const both = keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] });
  assert.strictEqual(checkRolesRan(onlyP2, 'full', cached, p2Rule(both)), null);
  assert.match(checkRolesRan(onlyP2, 'full', cached, p2Rule({ ...both, ...keyed({ 'market-structure-analyst': ['pullback-vs-reversal'] }) })),
    /not returned yet: market-structure-analyst \(market-structure-analyst was served from the report cache, which made no lookup of rejection/);
  assert.match(checkRolesRan(onlyP2, 'full', cached, p2Rule(keyed({ 'volume-liquidity-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] }))),
    /market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, rejection/, 'another role\'s lookups never count');
  // Made under another key (an earlier bar, or another lane's bar), or with none: not counted (the reviewer's case: a
  // candidate that appeared after the report was made).
  for (const bad of [null, [], 'x', { 'market-structure-analyst': 'rejection' }, { ...both, ...keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'] }, 'm3@2026-10-07T13:51:00.000Z') },
    { ...both, 'market-structure-analyst': { skills: ['pullback-vs-reversal', 'rejection'] } }, { ...both, 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'] }]) {
    assert.match(checkRolesRan(onlyP2, 'full', cached, p2Rule(bad)) || '', /market-structure-analyst was served from the report cache/, JSON.stringify(bad));
  }
});

test('lookupsInCall: the role\'s own lookups inside the call\'s wall-clock times, sorted; another role, outside the times or an untimed call: none', () => {
  const call = { start: T + 10, end: T + 20 };
  const records = [{ at: T + 12, role: 'a', skill: 'z' }, { at: T + 15, role: 'a', skill: 'b' }, { at: T + 15, role: 'a', skill: 'b' }, { at: T + 25, role: 'a', skill: 'late' }, { at: T + 15, role: 'x', skill: 'other' }];
  assert.deepStrictEqual(L.lookupsInCall(records, 'a', call), ['b', 'z']);
  assert.deepStrictEqual(L.lookupsInCall(records, 'a', { start: 10, end: 20 }), [], 'line positions, not times: fails closed');
  assert.deepStrictEqual(L.lookupsInCall(records, 'a', null), []);
  assert.deepStrictEqual(L.lookupsInCall(null, 'a', call), []);
});

test('lookupRule: a lookup the session made itself in a role\'s name (the head trader holds skill_lookup in index mode) is never the role\'s', () => {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  const file = path.join(dir, 'cycle-transcript.jsonl');
  const now = new Date('2026-10-07T14:00:00Z');
  const task = (role, s, e) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: 'VERDICT: APPROVE - size 1', time: { start: T + s, end: T + e } } } });
  // The head trader's own skill_lookup, made in parallel with the trend analyst's call and naming that role.
  const own = (input, s) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'harness_skill_lookup', state: { status: 'completed', input, output: '<skill name="x">', time: { start: T + s, end: T + s } } } });
  const roles = [task('market-structure-analyst', 1, 2), task('trend-momentum-analyst', 1, 2), task('volume-liquidity-analyst', 1, 2), task('risk-manager', 1, 2), task('risk-manager', 3, 4)];
  writeBriefing(home, { symbol: 'MNQ', sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data: m3([{ trendRule: 'reversal' }]) } } });
  const look = (role, skill) => L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + 1.5);
  for (const [role, skill] of [['market-structure-analyst', 'pullback-vs-reversal'], ['market-structure-analyst', 'rejection'], ['risk-manager', 'confluence-counting'], ['risk-manager', 'invalidation'], ['trend-momentum-analyst', 'pullback-vs-reversal']]) look(role, skill);
  const rule = () => L.lookupRule({ home, transcript: file, contractId: 'MNQ', now });
  fs.writeFileSync(file, roles.join('\n'));
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null, 'the roles\' own lookups count');
  // The same record, but the session's transcript shows the head trader made it naming the role: not the role's.
  fs.writeFileSync(file, [...roles, own({ skill: 'pullback-vs-reversal', role: 'trend-momentum-analyst' }, 1.5)].join('\n'));
  assert.deepStrictEqual(L.sessionLookups(file), [{ role: 'trend-momentum-analyst', skill: 'pullback-vs-reversal', start: T + 1.5, end: T + 1.5 }]);
  assert.match(checkRolesRan(file, 'full', [], rule()), /trend-momentum-analyst reported without looking up pullback-vs-reversal/);
  // Only the session's own record goes: the role's own lookup of the same skill, made during its call, still counts.
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role: 'trend-momentum-analyst', skill: 'pullback-vs-reversal' }, T + 1.8);
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null);
  const recs = [{ at: T + 1.5, role: 'r', skill: 's' }, { at: T + 1.8, role: 'r', skill: 's' }, { at: T + 1.5, role: 'q', skill: 's' }];
  fs.writeFileSync(file, own({ skill: 's', role: 'r' }, 1.5));
  assert.deepStrictEqual(L.rolesOwn(recs, file), [recs[1], recs[2]]);
  // A session call without times: one record of its pair goes (fails closed), never all of them.
  fs.writeFileSync(file, JSON.stringify({ type: 'tool_use', part: { tool: 'harness_skill_lookup', state: { status: 'completed', input: { skill: 's', role: 'r' } } } }));
  assert.deepStrictEqual(L.rolesOwn(recs, file).length, 2);
  // Malformed events never throw and name nothing.
  fs.writeFileSync(file, ['{"type":"tool_use","note":"skill_lookup"}', 'null', '"skill_lookup"', '{"type":"tool_use","part":{"tool":"harness_skill_lookup"}}', '{"type":"tool_use","part":{"tool":"harness_skill_lookup","state":{"input":null}}}'].join('\n'));
  assert.deepStrictEqual(L.sessionLookups(file), []);
  fs.writeFileSync(file, roles.join('\n'));
  assert.deepStrictEqual(L.rolesOwn(recs, file), recs);
  // Its lookups without a role (its own reading) take nothing from any role.
  fs.writeFileSync(file, [...roles, own({ skill: 'pullback-vs-reversal' }, 1.5)].join('\n'));
  assert.deepStrictEqual(L.sessionLookups(file), []);
  assert.strictEqual(checkRolesRan(file, 'full', [], rule()), null);
  assert.deepStrictEqual(L.sessionLookups(path.join(dir, 'gone.jsonl')), []);
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
  const { summary, lookups } = writeCycleLog(home, { action: 'trade', harness: 'opencode', prompt: 'p', output: '', transcript, roleSkills: 'index' });
  // The records themselves, read before the file goes, for the report cache (each cached report keeps its own call's).
  assert.deepStrictEqual(lookups, [{ at: T, role: 'volume-liquidity-analyst', skill: 'fair-value-gaps' }]);
  assert.deepStrictEqual(summary.skillLookups, { mode: 'index', lookups: 1, byRole: { 'volume-liquidity-analyst': 1 }, requiredCalls: 0, met: 0 });
  assert.ok(!fs.existsSync(L.lookupsFile(transcript)));
  assert.strictEqual(writeCycleLog(home, { action: 'trade', harness: 'claude', prompt: 'p', output: '' }).summary.skillLookups, undefined, 'no transcript, no lookups');
  assert.deepStrictEqual(writeCycleLog(home, { action: 'trade', harness: 'claude', prompt: 'p', output: '' }).lookups, []);
});

test('the runner\'s report cache: in index mode a role a lookup is required of on this bar runs, not served from the cache', () => {
  const { lookupRoles } = require('../../scripts/lib/runner-wiring');
  const now = new Date('2026-10-07T14:00:00Z');
  const b = data => ({ MNQ: { symbol: 'MNQ', sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data } } } });
  const index = { FTH_ROLE_SKILLS: 'index' };
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, { FTH_ROLE_SKILLS: 'full' }), [], 'full mode: the cache as before');
  // The risk manager embeds its situational skills (no lookup of it): never among them.
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, {}).sort(), ['market-structure-analyst', 'trend-momentum-analyst'], 'index is the default');
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'reversal' }])), now, index).sort(), ['market-structure-analyst', 'trend-momentum-analyst']);
  assert.deepStrictEqual(lookupRoles(b(m3([{ trendRule: 'allows' }])), now, index).sort(), ['market-structure-analyst']);
  assert.deepStrictEqual(lookupRoles(b(m3([])), now, index), [], 'no candidate: the cache serves every role');
  assert.deepStrictEqual(lookupRoles({ MNQ: null }, now, index).sort(), ['market-structure-analyst', 'trend-momentum-analyst'], 'no briefing: every role with a situational index runs');
  // lookupNeeds: the skills, per role.
  const { lookupNeeds } = require('../../scripts/lib/runner-wiring');
  assert.deepStrictEqual(lookupNeeds(b(m3([{ trendRule: 'reversal' }])), now, index), { 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] });
  assert.deepStrictEqual(lookupNeeds(b(m3([{ trendRule: 'reversal' }])), now, { FTH_ROLE_SKILLS: 'full' }), {});
});

test('the runner\'s report cache in index mode: a cached report is served on a bar requiring lookups only when its own call made them; the cycle\'s env names them for the gate', () => {
  const { reportCacheFor } = require('../../scripts/lib/runner-wiring');
  const { writeBriefing: write } = require('../../scripts/lib/trading/briefing');
  const RC = require('../../scripts/lib/trading/report-cache');
  const home = tmpDir();
  const now = new Date('2026-10-07T14:00:00Z');
  const versions = { m3: 'm3@2026-10-07T13:57:00.000Z', m15: 'm15@2026-10-07T13:45:00.000Z', h1: 'h1@2026-10-07T13:00:00.000Z', day: 'day@2026-10-07T13:00:00.000Z' };
  const sec = (v, data = {}) => ({ version: v, validUntil: '2026-10-07T14:15:00.000Z', data });
  const brief = cands => ({ symbol: 'MNQ', asOf: '2026-10-07T13:57:00.000Z', minutes: 3, sections: { m3: sec(versions.m3, m3(cands)), m15: sec(versions.m15), h1: sec(versions.h1), day: sec(versions.day) } });
  const symbols = [{ symbol: 'MNQ', bar: '2026-10-07T13:57:00.000Z', contractId: 'MNQ' }];
  const data = `Data: bar_briefing ${Object.values(versions).join(', ')}`;
  const ms = 'market-structure-analyst';
  const tm = 'trend-momentum-analyst';
  const ev = (role, s, e) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: `${data}\nBias: long`, time: { start: T + s, end: T + e } } } });
  const cfg = { harness: 'opencode', cycle: 'full' };
  const rc = reportCacheFor(home, cfg, [], {});
  write(home, brief([{ trendRule: 'reversal' }]));
  // Recorded with the structure analyst's own lookups in its call (and one after it, which doesn't count); the trend
  // analyst looked nothing up.
  rc.record({ symbols, account: null, now, output: [ev(ms, 10, 20), ev(tm, 10, 20)].join('\n'), served: [], lookups: [{ at: T + 15, role: ms, skill: 'pullback-vs-reversal' }, { at: T + 15, role: ms, skill: 'rejection' }, { at: T + 30, role: tm, skill: 'pullback-vs-reversal' }] });
  assert.deepStrictEqual(RC.readCache(home).analysts[ms].lookups, ['pullback-vs-reversal', 'rejection']);
  assert.strictEqual(RC.readCache(home).analysts[ms].lookupsKey, versions.m3, 'under the facts key of the cycle that made them');
  assert.deepStrictEqual(RC.readCache(home).analysts[tm].lookups, []);
  const served = rc.serve({ symbols, account: null, now });
  assert.deepStrictEqual(served.roles, [ms], 'the trend analyst runs: its report made no lookup');
  // The gate's env for the cycle: the cached role's lookups with their key (autotrader childEnv), read back by the gate.
  const { childEnv, validateConfig } = require('../../scripts/lib/autotrader');
  const ctx = { action: 'trade', cachedRoles: served.roles, cachedLookups: Object.fromEntries(served.reports.map(r => [r.role, { skills: r.lookups, key: r.lookupsKey }])) };
  const env = childEnv(validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7' }), '/r', { FTH_CYCLE_CACHED_LOOKUPS: 'stale' }, ctx);
  const want = { [ms]: { skills: ['pullback-vs-reversal', 'rejection'], key: versions.m3 } };
  assert.deepStrictEqual(JSON.parse(env.FTH_CYCLE_CACHED_LOOKUPS), want);
  const { loadConfig } = require('../../scripts/lib/trading/config');
  assert.deepStrictEqual(loadConfig(env).cycleCachedLookups, want);
  assert.strictEqual(childEnv(validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7' }), '/r', { FTH_CYCLE_CACHED_LOOKUPS: 'stale' }, { action: 'trade' }).FTH_CYCLE_CACHED_LOOKUPS, undefined, 'none cached: never inherited');
  // The gate config: only cached roles, only skill names, a key required; unreadable: none.
  assert.deepStrictEqual(loadConfig({ FTH_CYCLE_CACHED: ms, FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify({ [ms]: { skills: ['a', 'B c', 7], key: 'k' }, [tm]: { skills: ['x'], key: 'k' } }) }).cycleCachedLookups, { [ms]: { skills: ['a'], key: 'k' } });
  for (const raw of ['{', '[]', '"x"', 'null', JSON.stringify({ [ms]: ['a'] }), JSON.stringify({ [ms]: { skills: ['a'] } }), JSON.stringify({ [ms]: { skills: ['a'], key: '' } })]) {
    assert.deepStrictEqual(loadConfig({ FTH_CYCLE_CACHED: ms, FTH_CYCLE_CACHED_LOOKUPS: raw }).cycleCachedLookups, {}, raw);
  }
  // The same bar with another lane's bar closed (a 1m candidate since): another key, so the structure analyst runs.
  assert.deepStrictEqual(rc.serve({ symbols, account: null, now, laneBars: { MNQ: { 1: '2026-10-07T13:59:00.000Z' } } }).roles, []);
  // The next 3m bar, the 15m view unchanged: with a candidate (a new one since the report) it runs; with none, served.
  const next = cands => ({ ...brief(cands), asOf: '2026-10-07T14:00:00.000Z', sections: { ...brief(cands).sections, m3: sec('m3@2026-10-07T14:00:00.000Z', m3(cands)) } });
  const nextSym = [{ ...symbols[0], bar: '2026-10-07T14:00:00.000Z' }];
  write(home, next([{ trendRule: 'reversal' }]));
  assert.deepStrictEqual(rc.serve({ symbols: nextSym, account: null, now }).roles, [], 'a candidate after the report: credited to none');
  write(home, next([]));
  assert.deepStrictEqual(rc.serve({ symbols: nextSym, account: null, now }).roles.sort(), [ms, tm]);
  // On the bar with no candidate both are served (nothing required); in full mode too.
  write(home, brief([]));
  assert.deepStrictEqual(rc.serve({ symbols, account: null, now }).roles.sort(), [ms, tm]);
  write(home, brief([{ trendRule: 'reversal' }]));
  assert.deepStrictEqual(reportCacheFor(home, cfg, [], { FTH_ROLE_SKILLS: 'full' }).serve({ symbols, account: null, now }).roles.sort(), [ms, tm]);
  // A cache entry recorded before lookups were kept (no lookups field), or without its key: not served where required.
  for (const drop of ['lookups', 'lookupsKey']) {
    const c = RC.readCache(home);
    const saved = c.analysts[ms][drop];
    delete c.analysts[ms][drop];
    RC.writeCache(home, c);
    assert.deepStrictEqual(rc.serve({ symbols, account: null, now }).roles, [], drop);
    c.analysts[ms][drop] = saved;
    RC.writeCache(home, c);
  }
  assert.deepStrictEqual(rc.serve({ symbols, account: null, now }).roles, [ms]);
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
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 1: t } } }).sort(), ['market-structure-analyst']);
  assert.deepStrictEqual(lookupRoles(b, now, { FTH_ROLE_SKILLS: 'full' }, { home, laneBars: { MNQ: { 1: t } } }), [], 'full mode');
  // No briefing on the lane's bar, its record shows nothing fired: nothing required; no record on the bar: every role.
  const later = '2026-10-07T14:00:00.000Z';
  writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: later, closedAt: '2026-10-07T14:01:00.000Z', candidates: [] });
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 1: later } } }), []);
  assert.deepStrictEqual(lookupRoles(b, now, {}, { home, laneBars: { MNQ: { 5: later } } }).sort(), ['market-structure-analyst', 'trend-momentum-analyst']);
});

test('cycleFacts: a lane\'s signal record gives its setups with their recorded trend rules; only an older record without them counts every trend rule', () => {
  const now = new Date('2026-10-07T14:00:00Z');
  const first = { minutes: 3, sections: { m3: { validUntil: '2026-10-07T14:03:00.000Z', data: m3([]) } } };
  const t = '2026-10-07T13:59:00.000Z';
  const facts = rec => L.cycleFacts({ first, now, lanes: [{ minutes: 1, t }], readSignal: () => rec });
  assert.deepStrictEqual(facts({ asOf: t, candidates: [{ name: 'x', direction: 'long' }], setups: [{ name: 'x', direction: 'long', trendRule: 'reversal' }] }).candidates, [{ name: 'x', direction: 'long', trendRule: 'reversal' }]);
  assert.deepStrictEqual(facts({ asOf: t, candidates: [], setups: [{ name: 'm', direction: 'short' }] }).candidates, [{ name: 'm', direction: 'short', trendRule: null }], 'unknown, as the briefing says it');
  assert.deepStrictEqual(facts({ asOf: t, candidates: [{ name: 'x', direction: 'long' }] }).candidates.map(c => c.trendRule), ['reversal', 'allows', 'against']);
  assert.strictEqual(facts({ asOf: t }), null, 'neither list: unknown');
  // briefingFacts with an unreadable lanes list (config.js null): null.
  assert.strictEqual(L.briefingFacts(tmpDir(), 'MNQ', now, null), null);
});

test('the cycle log\'s lookups for the report cache leave out the head trader\'s own, made naming a role during that role\'s call: never stored with its report', () => {
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const home = tmpDir();
  const transcript = path.join(home, 'cycle-transcript.jsonl');
  const role = 'market-structure-analyst';
  const call = { role, start: T, end: T + 10 };
  const task = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: 'report', time: { start: T, end: T + 10 } } } });
  // The head trader's own skill_lookup naming the analyst, inside the analyst's call (the transcript shows it as the
  // session's); the analyst's own lookup of another skill in the same call.
  const own = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'harness_skill_lookup', state: { status: 'completed', input: { skill: 'rejection', role }, output: '<skill name="rejection">', time: { start: T + 4, end: T + 6 } } } });
  fs.writeFileSync(transcript, [task, own].join('\n'));
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill: 'rejection' }, T + 5);
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill: 'breakout' }, T + 7);
  const { lookups, summary } = writeCycleLog(home, { action: 'trade', harness: 'opencode', prompt: 'p', output: '', transcript, roleSkills: 'index' });
  assert.deepStrictEqual(lookups, [{ at: T + 7, role, skill: 'breakout' }]);
  // The cycle log's adherence numbers count the role's own lookup only.
  assert.deepStrictEqual([summary.skillLookups.lookups, summary.skillLookups.byRole], [1, { [role]: 1 }]);
  // What the report cache stores with the analyst's report (report-cache.js recordReports): its own lookup only.
  assert.deepStrictEqual(L.lookupsInCall(lookups, role, call), ['breakout']);
  // Without the session's call in the transcript, both are the role's (the transcript can't show otherwise).
  fs.writeFileSync(transcript, task);
  L.recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill: 'rejection' }, T + 5);
  assert.deepStrictEqual(L.lookupsInCall(writeCycleLog(home, { action: 'trade', harness: 'opencode', prompt: 'p', output: '', transcript, roleSkills: 'index' }).lookups, role, call), ['rejection']);
});

test('cycleFacts / factsKey with the cycle\'s bar: the briefing on that bar holds past its validUntil; another bar\'s, an unreadable bar or no m3 never; without one, the clock decides', () => {
  const BAR = '2026-10-07T13:57:00.000Z';
  const first = (asOf, until) => ({ asOf, minutes: 3, sections: { m3: { version: `m3@${asOf}`, validUntil: until, data: { candidates: [{ name: 'orb', direction: 'long', trendRule: 'reversal' }] } } } });
  const later = new Date('2026-10-07T14:10:00.000Z');
  const b = first(BAR, '2026-10-07T14:00:00.000Z');
  // Past validUntil: the clock alone says no facts (every lookup required); the cycle's bar says these are its facts.
  assert.strictEqual(L.cycleFacts({ first: b, now: later }), null);
  assert.strictEqual(L.factsKey(b, later), null);
  assert.deepStrictEqual(L.cycleFacts({ first: b, now: later, cycleBar: BAR }), b.sections.m3.data);
  assert.strictEqual(L.factsKey(b, later, [], BAR), `m3@${BAR}`);
  assert.strictEqual(L.factsKey(b, later, [], '2026-10-07T13:57:00Z'), `m3@${BAR}`, 'the same instant, written differently');
  // Another bar, an unreadable one, a briefing without asOf or m3: none (fails closed), even while the clock holds.
  const early = new Date('2026-10-07T13:59:00.000Z');
  for (const [f, bar] of [[b, '2026-10-07T14:00:00.000Z'], [b, 'not a time'], [{ ...b, asOf: undefined }, BAR], [{ ...b, sections: {} }, BAR], [null, BAR]]) {
    assert.strictEqual(L.cycleFacts({ first: f, now: early, cycleBar: bar }), null, `${bar} ${JSON.stringify(f && f.asOf)}`);
    assert.strictEqual(L.factsKey(f, early, [], bar), null, bar);
  }
  // No cycle bar: the clock, as before.
  assert.deepStrictEqual(L.cycleFacts({ first: b, now: early }), b.sections.m3.data);
  // Over the home (the gate's view).
  const home = tmpDir();
  writeBriefing(home, { symbol: 'MNQ', ...b });
  assert.strictEqual(L.briefingFacts(home, 'MNQ', later), null);
  assert.deepStrictEqual(L.briefingFacts(home, 'MNQ', later, {}, BAR), b.sections.m3.data);
  assert.strictEqual(L.briefingFactsKey(home, 'MNQ', later, {}, BAR), `m3@${BAR}`);
  assert.strictEqual(L.briefingFacts(home, 'MNQ', later, null, BAR), null, 'unreadable lanes: none');
});

test('composed triggers: the head trader\'s compose records on the bar (cycleFacts m3.composed), keyed into factsKey; taught in trade-lifecycle, never a role\'s or the head prompt\'s', () => {
  const F = require('../fixtures/lifecycle');
  const { appendRecord } = require('../../scripts/lib/trading/trade-lifecycle');
  const t = SL.parseTrigger;
  const withRel = rel => ({ composed: [{ id: 'a', side: 'long', kinds: ['relation'], relations: [rel] }] });
  assert.ok(SL.fires(t('composed'), withRel('rejected')));
  assert.ok(!SL.fires(t('composed'), { composed: [] }) && !SL.fires(t('composed'), {}) && !SL.fires(t('composed'), null));
  assert.ok(SL.fires(t('composed.relation=rejected'), withRel('rejected')) && !SL.fires(t('composed.relation=broke'), withRel('rejected')));
  assert.throws(() => t('composed.relation=swept'), /needs a valid value/);
  // The records on the briefing's bar, parsed again (a record's own fields about itself are never read).
  const home = tmpDir();
  const now = new Date('2026-10-07T14:00:02Z');
  writeBriefing(home, F.briefing());
  assert.deepStrictEqual([L.composedAt(home, 'MNQ', F.BAR), L.briefingFacts(home, 'MNQ', now, {}).composed], [[], undefined]);
  const keyBefore = L.briefingFactsKey(home, 'MNQ', now, {});
  const rec = F.writeScenario(home, { write: false, reads: F.READS.map(x => (x.step === 'setup' ? { ...x, read: '15m broke prior vah up' } : x)) });
  appendRecord(home, { ...rec, id: 'liar', bar: F.BAR, kinds: ['relation'], relations: ['rejected'] });
  const facts = L.briefingFacts(home, 'MNQ', now, {});
  assert.deepStrictEqual(facts.composed.map(c => c.relations), [['broke'], ['broke']]);
  assert.deepStrictEqual(SL.situationalSkills(facts).sort(), ['breakout', 'confluence-counting', 'invalidation']);
  // Another record on the bar, another key: lookups made under the old one are not credited under the new.
  const keyAfter = L.briefingFactsKey(home, 'MNQ', now, {});
  assert.strictEqual(keyBefore, 'v-scenario-1');
  assert.strictEqual(keyAfter, `v-scenario-1|c:${rec.id}|c:liar`);
  assert.strictEqual(L.factsKey(F.briefing(), now, [], null, [{ id: 'b' }, { id: 'a' }]), 'v-scenario-1|c:a|c:b');
  // A record on another bar is not this bar's.
  appendRecord(tmpDir(), rec);
  assert.deepStrictEqual(L.composedAt(home, 'MNQ', '2026-10-07T13:54:00.000Z'), []);
  // The bar's day shard unreadable: no composed facts (a rules entry isn't refused for it), while the composed entry's
  // own check reads the same shard and refuses it (fails closed).
  const { recordFile } = require('../../scripts/lib/trading/trade-lifecycle');
  const broken = tmpDir();
  writeBriefing(broken, F.briefing());
  require('fs').mkdirSync(recordFile(broken, 'MNQ', '2026-10-07'), { recursive: true });
  assert.deepStrictEqual([L.composedAt(broken, 'MNQ', F.BAR), L.briefingFactsKey(broken, 'MNQ', now, {})], [[], 'v-scenario-1']);
  const doc = require('../../scripts/lib/trading/strategies').loadStrategies(path.resolve(__dirname, '..', '..'), {}).strategies.find(s => s.name === 'trade_lifecycle');
  const refused = require('../../scripts/lib/trading/lifecycle-gate').composedRefusal({ name: 'trade_lifecycle', strategy: doc, home: broken, root: 'MNQ', input: F.order(), now, cycleBars: { MNQ: F.BAR }, specOf: () => ({ tickSize: 0.25, tickValue: 0.5 }) });
  assert.match(refused.message, /can't be read \(EISDIR\)[^]*fails closed/);
  // No role's index requires a taught entry; the head prompt doesn't list one; trade-lifecycle names each.
  const roleSkills = require('../../scripts/lib/role-skills');
  const required = roleSkills.requiredByRole(path.resolve(__dirname, '..', '..'), 'index');
  for (const [role, list] of required) for (const r of list) assert.ok(!r.when.some(w => w.key.startsWith('composed')), `${role}: ${r.skill}`);
  const { headPrompt } = require('../../scripts/lib/head-prompt');
  assert.doesNotMatch(headPrompt({ docs: [] }), /compose/);
  const taught = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
  for (const e of SL.SITUATIONAL.filter(x => x.taughtIn)) {
    assert.strictEqual(e.taughtIn, 'trade-lifecycle');
    assert.strictEqual(e.head, true);
    assert.ok(taught.includes(`\`${e.skill}\``), `trade-lifecycle teaches ${e.skill}`);
  }
});
