'use strict';

// How a role's skills reach its opencode prompt (scripts/lib/role-skills.js): role-skills (the core, embedded) and
// role-index (indexed in index mode), the FTH_ROLE_SKILLS switch (full by default), the situational lookups, and the
// generated opencode.json in each mode.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RS = require('../../scripts/lib/role-skills');
const HS = require('../../scripts/lib/harness-sync');
const oc = require('../../scripts/lib/opencode');
const { SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');

const ROOT = path.resolve(__dirname, '..', '..');
const generated = mode => JSON.parse(HS.expectedFiles(ROOT, { mode })['workspace/opencode.json']);

test('modeOf: full by default; index; anything else refused', () => {
  assert.strictEqual(RS.modeOf({}), 'full');
  assert.strictEqual(RS.modeOf({ FTH_ROLE_SKILLS: ' ' }), 'full');
  assert.strictEqual(RS.modeOf({ FTH_ROLE_SKILLS: 'index' }), 'index');
  assert.throws(() => RS.modeOf({ FTH_ROLE_SKILLS: 'trimmed' }), /FTH_ROLE_SKILLS: one of full, index \(got "trimmed"\)/);
});

test('skillPlan: full embeds every skill of both lists; index embeds the core and lists the index with its required lookups', () => {
  const docs = [{ name: 'a', body: 'A', description: 'about a' }, { name: 'b', body: 'B', description: 'about b' }];
  const agent = { name: 'r', skills: ['a'], index: ['b'] };
  assert.deepStrictEqual(RS.skillPlan(agent, docs, 'full'), { mode: 'full', docs: [{ name: 'a', body: 'A' }, { name: 'b', body: 'B' }], indexed: [], required: [] });
  assert.deepStrictEqual(RS.skillPlan(agent, docs, 'index'), { mode: 'index', docs: [{ name: 'a', body: 'A' }], indexed: [{ name: 'b', description: 'about b' }], required: [] });
  // No role-index: index mode is the full prompt.
  assert.deepStrictEqual(RS.skillPlan({ name: 'r', skills: ['a', 'b'], index: [] }, docs, 'index').indexed, []);
  // A situational skill in the index is a required lookup, with its triggers.
  assert.deepStrictEqual(RS.requiredOf(['b', 'c'], [{ when: 'news.inBlackout', skill: 'b' }]), [{ skill: 'b', when: [{ key: 'news.inBlackout', value: null }] }]);
});

test('planErrors: an index skill that doesn\'t exist, one in both lists, or an index without skill_lookup fails', () => {
  const ok = { file: 'r.md', name: 'r', skills: ['a'], index: ['b'], tools: ['mcp__harness__skill_lookup'] };
  assert.deepStrictEqual(RS.planErrors([ok], ['a', 'b', ...SITUATIONAL.map(e => e.skill)]), []);
  const errs = a => RS.planErrors([{ ...ok, ...a }], ['a', 'b', ...SITUATIONAL.map(e => e.skill)]).join('\n');
  assert.match(errs({ index: ['zz'] }), /role-index skill "zz" has no skills\/zz\/SKILL\.md/);
  assert.match(errs({ index: ['a'] }), /"a" is in both role-skills and role-index/);
  assert.match(errs({ tools: [] }), /a role-index needs the tool mcp__harness__skill_lookup/);
  assert.match(RS.planErrors([ok], ['a', 'b']).join('\n'), /SITUATIONAL: no skill/);
  // A trigger naming a strategy must name one that exists (a retired strategy fails).
  const { SITUATIONAL: S } = require('../../scripts/lib/trading/skills-loaded');
  S.push({ when: 'candidate.name=retired_one', skill: 'a' });
  try {
    assert.match(RS.planErrors([ok], ['a', 'b', ...SITUATIONAL.map(e => e.skill)], ['orb']).join('\n'), /"candidate\.name=retired_one" names no strategy/);
    assert.deepStrictEqual(RS.planErrors([ok], ['a', 'b', ...SITUATIONAL.map(e => e.skill)], ['orb', 'retired_one']), []);
  } finally {
    S.pop();
  }
});

test('the agents: role-index skills exist, aren\'t core, and the role holds skill_lookup; the proof case indexes the basics skills', () => {
  const agents = HS.loadAgents(ROOT);
  assert.doesNotThrow(() => HS.checkRoleSkills(ROOT));
  // The proof case: the eleven basics skills, and cisd and fib-retracement since, are in the index of the roles that
  // carry them.
  const BASICS = ['trend-vs-range', 'pullback-vs-reversal', 'breakout-vs-fakeout', 'levels-and-reactions', 'momentum-and-volume',
    'absorption', 'invalidation', 'confluence-counting', 'candle-reading', 'mtf-rejection', 'mtf-breakout', 'cisd', 'fib-retracement'];
  // And the strategy-library split's pieces a role reads only when a cycle needs one (strategy-library, with the
  // priority order, stays core wherever it was).
  const SPLIT = ['strategy-scan', 'strategy-gate-checks'];
  assert.deepStrictEqual([...new Set(agents.flatMap(a => a.index))].sort(), [...BASICS, ...SPLIT].sort());
  for (const a of agents.filter(x => x.index.includes('strategy-scan') || x.skills.includes('strategy-scan'))) assert.ok(a.skills.includes('strategy-library'), `${a.name}: strategy-library core`);
  for (const a of agents) assert.deepStrictEqual(a.skills.filter(s => BASICS.includes(s)), [], `${a.name}: basics only in its index`);
  const req = RS.requiredByRole(ROOT, 'index');
  assert.deepStrictEqual(req.get('risk-manager'), [{ skill: 'confluence-counting', when: [{ key: 'candidate', value: null }] }, { skill: 'invalidation', when: [{ key: 'candidate', value: null }] }]);
  assert.deepStrictEqual(req.get('trend-momentum-analyst'), [{ skill: 'pullback-vs-reversal', when: [{ key: 'candidate.trendRule', value: 'reversal' }] }]);
  assert.strictEqual(req.get('volume-liquidity-analyst'), undefined, 'no situational skill in its index: it looks up as it judges');
  assert.strictEqual(RS.requiredByRole(ROOT, 'full').size, 0, 'full mode requires no lookup');
  assert.deepStrictEqual(RS.loadRoles(ROOT).map(a => [a.name, a.index]), agents.map(a => [a.name, a.index]));
});

test('opencode.json: the committed file is full; full embeds role-index skills too; index lists them, deterministically', () => {
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'workspace', 'opencode.json'), 'utf8'), HS.expectedFiles(ROOT)['workspace/opencode.json']);
  const full = generated('full');
  const index = generated('index');
  assert.strictEqual(HS.expectedFiles(ROOT, { mode: 'index' })['workspace/opencode.json'], HS.expectedFiles(ROOT, { mode: 'index' })['workspace/opencode.json'], 'stable');
  const ab = HS.agentSkills(ROOT, { file: 'x', skills: ['absorption'] })[0];
  const fullVl = full.agent['volume-liquidity-analyst'].prompt;
  const vl = index.agent['volume-liquidity-analyst'].prompt;
  assert.ok(fullVl.includes(`<skill name="absorption">\n${ab.body}\n</skill>`), 'full: embedded');
  assert.doesNotMatch(fullVl, /Look up as needed/, 'full: one load sentence, as before');
  assert.ok(!vl.includes('<skill name="absorption">'), 'index: not embedded');
  assert.ok(vl.includes('## Your skill index') && vl.includes(`- absorption: ${ab.description}`), 'index: one line, its description');
  assert.match(vl.replace(/\s+/g, ' '), /Your skills `vwap-volume-profile`, `liquidity-concepts`, `session-timing`, `market-snapshot`, `trader-process`, `harness-tools`, and `bar-briefing` are below, already loaded \(Your skills, at the end\)\. Look up as needed: `levels-and-reactions`, `momentum-and-volume`, and `absorption`, listed in Your skill index \(at the end\); read one with skill_lookup only when this cycle needs it\./);
  assert.match(vl, /`skill_lookup \{"skill": "<skill>", "role": "volume-liquidity-analyst"\}`/);
  assert.doesNotMatch(vl, /Required by the situation/);
  const rm = index.agent['risk-manager'].prompt;
  assert.match(rm, /Required by the situation[^]*- a setup fired \(the briefing lists a candidate\): `confluence-counting`\n- a setup fired \(the briefing lists a candidate\): `invalidation`/);
  assert.ok(vl.length < fullVl.length);
  // The core is embedded in full in both modes: every skill the body says to load.
  for (const a of HS.loadAgents(ROOT)) {
    for (const d of HS.agentSkills(ROOT, { ...a, index: [] })) assert.ok(index.agent[a.name].prompt.includes(`<skill name="${d.name}">\n${d.body}\n</skill>`), `${a.name}: ${d.name}`);
    // A role without an index has the same prompt in both modes.
    if (!a.index.length) assert.strictEqual(index.agent[a.name].prompt, full.agent[a.name].prompt, a.name);
  }
  // Only the prompts differ between the modes: permissions, servers and the rest are the same.
  const strip = c => JSON.stringify(c, (k, v) => (k === 'prompt' ? undefined : v));
  assert.strictEqual(strip(index), strip(full));
});

test('agentPrompt: the one load sentence (core and index) stays one in full mode and becomes two in index mode', () => {
  const body = 'Do it.\n\nLoad the skills `a`, `c`, and `b`.';
  const docs = [{ name: 'a', body: 'A' }, { name: 'b', body: 'B' }, { name: 'c', body: 'C', description: 'about c' }];
  const agent = { name: 'r', body, skills: ['a', 'b'], index: ['c'] };
  const full = oc.agentPrompt({ ...agent, skillDocs: docs, skillPlan: RS.skillPlan(agent, docs, 'full') });
  assert.match(full, /Your skills `a`, `c`, and `b` are below, already loaded \(Your skills, at the end\)\.\n/);
  assert.match(full, /<skill name="c">\nC\n<\/skill>/);
  const index = oc.agentPrompt({ ...agent, skillDocs: docs, skillPlan: RS.skillPlan(agent, docs, 'index') });
  assert.match(index, /Your skills `a` and `b` are below, already loaded \(Your skills, at the end\)\. Look up as needed: `c`, listed in Your skill index/);
  assert.doesNotMatch(index, /<skill name="c">/);
  assert.match(index, /- c: about c/);
  assert.doesNotMatch(index, /Required by the situation/, 'no situational skill in this index');
  // A body without its load sentence can't be split: an error, never a prompt that still loads the index.
  assert.throws(() => oc.agentPrompt({ ...agent, body: 'Do it.', skillDocs: docs, skillPlan: RS.skillPlan(agent, docs, 'index') }), /no "Load the skills \.\.\." sentence/);
  // A role whose skills are all indexed: only the look-up sentence.
  const all = { ...agent, skills: [], index: ['a', 'b', 'c'] };
  assert.match(oc.agentPrompt({ ...all, skillDocs: docs, skillPlan: RS.skillPlan(all, docs, 'index') }), /Do it\.\n\nLook up as needed: `a`, `b`, and `c`, listed/);
});

// Each role's skills as main loads them (its role-skills before role-index existed): no default behaviour changes.
// Added since: bos-vs-choch (core) for the market-structure and trend-momentum analysts; cisd and fib-retracement
// (indexed) for the market-structure analyst; from the strategy-library split, strategy-scan and strategy-gate-checks
// for the trading roles that load strategy-library, and strategy-gate-checks and harness-root for the strategy
// researcher (which reads no scan; the trading roles get the root from the prompt). No role's prompt grows.
// From the gate-refusals and order-mechanics splits (tests/plugin/gate-refusals-split.test.js,
// tests/plugin/order-mechanics-split.test.js): each role loads the pieces its body uses. Both roles load order-types and
// order-mechanics. The risk manager (it places no order) takes gate-refusals-limits and gate-refusals-cycle (the size,
// risk, prop and FACTS refusals its checks name); the executor gate-refusals (the order itself) and
// gate-refusals-positions (managing a position): the limits and cycle rows are the head trader's to act on.
// From the harness-tools split (tests/plugin/harness-tools-split.test.js): bar-briefing (core) for the analysts and the
// risk manager, and reason-check (core) for the risk manager (it references order-plan from its step 5).
const MAIN_SKILLS = {
  'market-structure-analyst': ['market-structure', 'multi-timeframe-analysis', 'market-snapshot', 'strategy-library', 'trader-process', 'trend-vs-range', 'bos-vs-choch', 'pullback-vs-reversal', 'breakout-vs-fakeout', 'levels-and-reactions', 'candle-reading', 'mtf-rejection', 'mtf-breakout', 'cisd', 'fib-retracement', 'harness-tools', 'strategy-scan', 'strategy-gate-checks', 'bar-briefing'],
  'news-calendar-analyst': ['session-timing', 'trader-process'],
  'risk-manager': ['position-sizing', 'prop-challenge-pacing', 'trading-agent-security', 'strategy-library', 'broker-mcp', 'order-types', 'order-mechanics', 'order-failures', 'trade-journal', 'gate-refusals-limits', 'gate-refusals-cycle', 'broker-refusals', 'trader-process', 'confluence-counting', 'invalidation', 'harness-tools', 'strategy-scan', 'strategy-gate-checks', 'bar-briefing', 'reason-check'],
  'strategy-researcher': ['strategy-authoring', 'strategy-library', 'strategy-gate-checks', 'harness-root'],
  'trade-executor': ['broker-mcp', 'order-types', 'order-mechanics', 'order-failures', 'order-rationale', 'trade-journal', 'gate-refusals', 'gate-refusals-positions', 'broker-refusals'],
  'trade-reviewer': ['trade-review', 'setup-expectancy'],
  'trend-momentum-analyst': ['trend-momentum-indicators', 'market-snapshot', 'strategy-library', 'trader-process', 'trend-vs-range', 'bos-vs-choch', 'momentum-and-volume', 'pullback-vs-reversal', 'harness-tools', 'strategy-scan', 'strategy-gate-checks', 'bar-briefing'],
  'volume-liquidity-analyst': ['vwap-volume-profile', 'liquidity-concepts', 'session-timing', 'market-snapshot', 'trader-process', 'levels-and-reactions', 'momentum-and-volume', 'absorption', 'harness-tools', 'bar-briefing'],
};

test('full mode: Claude (the canonical body), Codex and Qwen load the same skills as main for each role, in one load sentence; so does opencode', () => {
  const files = HS.expectedFiles(ROOT);
  const full = generated('full');
  const loads = text => {
    const m = /Load the\s+skills?\s+([^.]*)\./.exec(text.replace(/\s+/g, ' '));
    return m ? [...m[1].matchAll(/`([a-z-]+)`/g)].map(x => x[1]).sort() : null;
  };
  assert.deepStrictEqual(HS.loadAgents(ROOT).map(a => a.name).sort(), Object.keys(MAIN_SKILLS).sort());
  for (const [role, skills] of Object.entries(MAIN_SKILLS)) {
    const want = [...skills].sort();
    const claude = fs.readFileSync(path.join(ROOT, 'agents', `${role}.md`), 'utf8');
    const codex = files[`.codex/agents/${role}.toml`];
    const qwen = files[`qwen-extension/agents/${role}.md`];
    for (const [who, text] of [['Claude', claude], ['Codex', codex], ['Qwen', qwen]]) {
      assert.deepStrictEqual(loads(text), want, `${who} ${role}`);
      assert.doesNotMatch(text, /Look up as needed/, `${who} ${role}: no look-up sentence outside index mode`);
    }
    // Codex may read exactly those skill files.
    const readable = /except your skills \(([^)]*) under the harness root\)/.exec(codex);
    if (readable) assert.deepStrictEqual([...readable[1].matchAll(/skills\/([a-z-]+)\/SKILL\.md/g)].map(x => x[1]).sort(), want, `Codex ${role}: readable skills`);
    assert.deepStrictEqual([...full.agent[role].prompt.matchAll(/<skill name="([a-z-]+)">/g)].map(x => x[1]).sort(), want, `opencode ${role}: embedded`);
  }
});
