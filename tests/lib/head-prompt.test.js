'use strict';

// The head trader's own prompt in opencode's index mode (scripts/lib/head-prompt.js): its per-cycle skills embedded,
// and the runner's attestation of them that the order gate checks (tests/lib/order-gate.test.js, the gate's side).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('../../scripts/lib/head-prompt');
const HS = require('../../scripts/lib/harness-sync');
const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const body = name => parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')).body.trim();
const index = JSON.parse(HS.expectedFiles(ROOT)['workspace/opencode.json']);
const full = JSON.parse(HS.expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);

test('CORE: the gate\'s lists first, then what the head trader reads every cycle (the runner\'s load list, trade-session steps 2 to 4)', () => {
  // trade_lifecycle is the one entry strategy: the composed entry's list, with trade-lifecycle and without the strategy
  // skills (a rules strategy's entry reads those with skill_lookup).
  const { REQUIRED_FOR_COMPOSED } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(H.CORE.slice(0, REQUIRED_FOR_COMPOSED.length + REQUIRED_AT_ENTRY.length), [...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY]);
  for (const s of ['strategy-library', 'strategy-scan', 'strategy-gate-checks']) assert.ok(!H.CORE.includes(s) && REQUIRED_FOR_ENTRY.includes(s), s);
  for (const s of ['autonomous-trading', 'trader-process', 'htf-to-ltf', 'bar-briefing', 'role-round', 'day-context']) assert.ok(H.CORE.includes(s), s);
  assert.strictEqual(new Set(H.CORE).size, H.CORE.length);
  for (const s of H.CORE) assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), s);
  // Situational skills stay out: read with skill_lookup when the cycle needs one.
  for (const s of ['manage-position', 'leftover-orders', 'lean-cycle', 'entry-outcome']) assert.ok(!H.CORE.includes(s), s);
});

test('CORE: the composed bar\'s reads the gate requires (SITUATIONAL taught in trade-lifecycle) are embedded last; trade-lifecycle reads right embedded or not', () => {
  const { SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(H.COMPOSED_READS, [...new Set(SITUATIONAL.filter(e => e.taughtIn).map(e => e.skill))]);
  assert.deepStrictEqual(H.COMPOSED_READS, ['confluence-counting', 'invalidation', 'rejection', 'breakout']);
  assert.deepStrictEqual(H.CORE.slice(-H.COMPOSED_READS.length), H.COMPOSED_READS);
  const prompt = index.agent[H.HEAD_AGENT].prompt;
  for (const s of H.COMPOSED_READS) assert.ok(prompt.includes(`<skill name="${s}">\n${body(s)}\n</skill>`), s);
  // Still not listed as a lookup the situation requires: embedded, they need none. The one the list names is candle-reading
  // (feat/sweep-candle-control, the owner: "Rejection should rely on candle reading", "It should use indexing"): a
  // composed rejection or break reads its reaction, looked up, never embedded.
  const head = prompt.split('## Your skills (already loaded)')[0];
  const list = head.slice(head.indexOf('Required by the situation'));
  assert.match(list, /- a composed read says a candle rejected a level, or a composed read says a candle broke a level, or a composed read says a level was swept: `candle-reading`/);
  for (const s of H.COMPOSED_READS) assert.ok(!list.includes(`\`${s}\``), `${s}: embedded, not listed`);
  assert.ok(!prompt.includes('<skill name="candle-reading">'), 'candle-reading: listed for lookup, never embedded');
  // trade-lifecycle no longer sends the head trader to look them up every bar: embedded, it doesn't; else it loads them
  // (full mode, another harness), with skill_lookup when it has no skill tool.
  const tl = body('trade-lifecycle').replace(/\s+/g, ' ');
  assert.doesNotMatch(tl, /Then read\*\* with `skill_lookup`/);
  assert.ok(tl.includes('**Then read** `confluence-counting` and `invalidation` whenever you composed on the bar, `rejection` when a read says a candle rejected a level, `breakout` when one says it broke one: in your prompt when it embeds them (don\'t look them up); else load each (no skill tool: `skill_lookup`; in index mode the gate requires them).'));
  // Its size, pinned: 59558 bytes before the composed reads were embedded (main at ac8fb6e3), 72143 with them, the owner's
  // explicit exception to the no-growth rule (perf/head-core-composed-skills); 72455 with the owner's approved
  // trade-lifecycle sentences (plan validity, CISD timing, the library display: +312); 72636 with the owner's approved
  // management row (feat/prop-portfolio-missing: the exit mode may let a winner run past its target: +181); 73246 with the
  // owner's approved reading of the risk record in experience_lookup (feat/risk-record-lookup: +610); 72767 with the
  // skills matched to the code (fix/skills-match-code: -479), 72763 after its review (main 73246); 72840 with the owner's approved [desk] line in role-round (feat/desk-before-compose:
  // the head trader composes only once the desk reported: +77); 72926 with the owner's approved runner's factual reviews
  // (fix/runner-writes-reviews: the [review] row in role-round and trade-session's unreviewed-entry line: +86); 73159
  // with the owner's approved runner's entry (feat/entry-workflow: one line each in role-round, trade-session,
  // trade-lifecycle and autonomous-trading, the route in full only in an entry cycle's prompt: +233); 72970 with the soft reads made
  // reads in the count (fix/confluence-not-vetoes: the room and VWAP-distance vetoes gone, the trend rule's allowed side first: -189),
  // then 73252 with the count's rule where the head trader reads it every cycle (trade-session, trade-lifecycle) and
  // confluence-counting loaded every cycle (+282; the owner's OK while performance holds), then 72968 with the
  // count of independent categories, not labels (the owner's duplicated-evidence principle: -284), then 73049 with the pullback neutral and the margin's size
  // (full at 2+, half at 1: +81, under main's 73159), then 73316 with a valid setup the trade (and 73364 with `planned` only when the prompt names the runner's entry, else the head trader places it: +48), the against
  // setting its size (the owner's decision, 2026-10-21: +267), then 73396 with compose first:
  // the plan, never the model, works out R:R (+80, the confluence table's compose-step notes dropped), then 73608 with decisive a 1h CHoCH against and
  // the briefing's Standard plan named (with the always-on decision rule's and every-cycle entry loads before it: +212), then 73727
  // with the owner's no-late-entry rule (2026-10-21) taught (fix/no-late-entry: trade-lifecycle's one [late-entry] line: +119, for the owner's OK),
  // then 74002 with the owner's size translation (feat/prop-min-contracts, 2026-10-23: in a prop attempt the size is translated
  // at entry; trade-lifecycle's line, the half as phase 2's cut in trade-session, confluence-counting, strategy-library: +278
  // over main's 73724), then 74227 with the owner's compression setup taught where the head trader composes (feat/compression,
  // the owner, 2026-10-24: "Make sure this skill is part of setup", taught in trade-lifecycle's setup list: its setup and stop
  // reads and their timing, breakout's pointer and invalidation's box stop source: +225). The owner's skip reasons
  // (feat/ppc-setup-rates: autonomous-trading's one SKIP line) fit under it with trade-session's manage-position line 3
  // bytes shorter. Then 75037 with the reaction at a level (feat/sweep-candle-control, owner-approved 2026-10-31: "This will
  // provide useful context. Not used in isolation for decision. It needs other confirmation"): rejection's and breakout's
  // reaction pointers (who took control, the close over the wick, context never the setup alone) and bar-briefing's
  // `reaction` and `confirmed` fields: +873 over main's 74164; then 75075 with conflicting's read in the owner's words
  // (mixed: needs other confirmation, the count or the next candle; +38); then 75155 (owner: rejection relies on candle-reading; the side is the candle's (q30); the owner: "It
  // should use indexing"): the Required-by-the-situation list naming candle-reading for a composed rejection or break,
  // trade-lifecycle's line to look it up, and rejection's and breakout's candle reads cut to a pointer (+80 net). It may
  // shrink; it grows only on an owner's OK. Then 75296 (round 7, owner-approved: "Include sweeps", "Warn early + embed"):
  // the Required list names a composed sweep too and says "or your own composed read", and trade-lifecycle's line names
  // the sweep and that the cycle's section may embed it and compose_check says so (+141).
  // Then 75379 (owner: q30 side confusion; side rule first): rejection's step 4 says the `rejected` relation is only the fact, a rejection only when its
  // reaction is a long-wick, engulfing or confirmed one (+83).
  // Then 75403 with fix/trail-swing-side-capture on it (the owner's 2026-10-30 decision: the setup is the entry): breakout's
  // retest-entry evidence and htf-to-ltf's next-3m-bar line, less trade-lifecycle's and setup-judgment's trimmed lines (+3),
  // and no skill left saying the next 3m close times the entry (rejection, breakout, trade-lifecycle, confluence-counting,
  // trader-process, pullback-vs-reversal: "on the next 3m bar", +21).
  assert.ok(Buffer.byteLength(prompt) <= 75403, `the head prompt is ${Buffer.byteLength(prompt)} bytes`);
  // Only the head trader's prompt grows: no other role's prompt embeds trade-lifecycle (the risk manager's embeds
  // confluence-counting and invalidation as before; its prompt is unchanged, pinned in trade-session-split.test.js).
  for (const [name, a] of Object.entries(index.agent)) if (name !== H.HEAD_AGENT && a.prompt) assert.ok(!a.prompt.includes('<skill name="trade-lifecycle">'), name);
});

test('headPlan/headPrompt: index mode embeds each core skill whole, as a load returns it; full mode has no prompt of its own', () => {
  assert.strictEqual(H.headPlan(ROOT, 'full'), null);
  const prompt = index.agent[H.HEAD_AGENT].prompt;
  assert.strictEqual(prompt, H.headPrompt(H.headPlan(ROOT, 'index')));
  for (const s of H.CORE) assert.ok(prompt.includes(`<skill name="${s}">\n${body(s)}\n</skill>`), s);
  assert.deepStrictEqual(H.embeddedSkills(prompt, ROOT), H.CORE);
  assert.ok(!('prompt' in full.agent[H.HEAD_AGENT]));
  // It still tells the cycle's steps (trade-session's, embedded), how to reach any other skill, and that the tool is gone.
  for (let n = 0; n <= 7; n += 1) assert.match(prompt, new RegExp(`^### ${n}\\. `, 'm'), `trade-session step ${n}`);
  const head = prompt.split('## Your skills (already loaded)')[0];
  assert.match(head, /skill_lookup \{"skill": "<name>"\}/);
  assert.match(head, /You have no skill tool\./);
  assert.match(head, /AGENTS\.md/);
  // Its index is AGENTS.md's Skills list (opencode loads AGENTS.md into its prompt): every skill the core names is in it.
  const agentsMd = HS.expectedFiles(ROOT)['workspace/AGENTS.md'];
  const names = fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));
  const named = new Set([...prompt.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]).filter(s => names.includes(s)));
  assert.ok(named.size > H.CORE.length);
  for (const s of named) assert.match(agentsMd, new RegExp(`^- \`${s}\` \\(skills/${s}/SKILL\\.md\\): `, 'm'), s);
  // Nothing embedded sends it to reload a skill it holds, or to a tool it lacks: trade-session step 0 and role-round
  // say a skill in its prompt counts and name skill_lookup without a skill tool; skill_lookup says the head trader gives no role.
  const flat = t => t.replace(/\s+/g, ' ');
  assert.match(flat(prompt), /one already in your prompt counts: don't reload it \(no skill tool: skill_lookup\)/);
  assert.match(flat(prompt), /load skills yourself \(your skill tool; none: skill_lookup or `SKILL\.md`\)/);
  const tool = require('../../scripts/lib/harness-tools/registry').BY_NAME.get('skill_lookup');
  assert.match(tool.description, /A role gives role \(its name\) in a cycle, the head trader none/);
  assert.match(head, /\(no role: that is the roles'\)/);
  // Stable: the same text every generation (a cached prefix).
  assert.strictEqual(H.headPrompt(H.headPlan(ROOT, 'index')), prompt);
});

test('headPrompt: a situational skill marked for the head trader is listed with its trigger', () => {
  const plan = { docs: [{ name: 'a', body: 'A' }] };
  assert.doesNotMatch(H.headPrompt(plan, []), /Required by the situation/);
  const p = H.headPrompt(plan, [{ when: 'news.inBlackout', skill: 'news-blackouts', head: true }, { when: 'candidate', skill: 'invalidation' }]);
  assert.match(p, /Required by the situation[^]*- a news blackout is in force: `news-blackouts`/);
  assert.doesNotMatch(p, /`invalidation`/);
});

test('embeddedSkills: only a skill\'s current text, whole and as a load returns it', () => {
  const ts = body('trade-session');
  assert.deepStrictEqual(H.embeddedSkills(`x\n<skill name="trade-session">\n${ts}\n</skill>\n`, ROOT), ['trade-session']);
  assert.deepStrictEqual(H.embeddedSkills(`<skill name="trade-session">\n${ts.slice(0, -1)}\n</skill>`, ROOT), [], 'cut short');
  assert.deepStrictEqual(H.embeddedSkills(`<skill name="trade-session">\n${ts} more\n</skill>`, ROOT), [], 'added to');
  assert.deepStrictEqual(H.embeddedSkills('<skill name="no-such-skill">\nx\n</skill>', ROOT), []);
  for (const v of [null, '', 42, {}]) assert.deepStrictEqual(H.embeddedSkills(v, ROOT), []);
});

test('attestation / parseAttestation: the run\'s file, its head prompt\'s hash and its embedded skills; anything malformed is none', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'opencode.json');
  fs.writeFileSync(file, HS.expectedFiles(ROOT)['workspace/opencode.json']);
  const att = H.attestation(file, ROOT);
  assert.deepStrictEqual(att, { config: file, sha256: H.sha256(index.agent[H.HEAD_AGENT].prompt), skills: H.CORE });
  assert.deepStrictEqual(H.parseAttestation(JSON.stringify(att)), att);
  // None: a full-mode file, a missing or broken one, a relative path or another file name.
  fs.writeFileSync(file, HS.expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  assert.strictEqual(H.attestation(file, ROOT), null);
  fs.writeFileSync(file, '{');
  assert.strictEqual(H.attestation(file, ROOT), null);
  assert.strictEqual(H.attestation(path.join(dir, 'gone', 'opencode.json'), ROOT), null);
  assert.strictEqual(H.headPromptIn('opencode.json'), null);
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, HS.expectedFiles(ROOT)['workspace/opencode.json']);
  assert.strictEqual(H.headPromptIn(other), null);
  for (const bad of [undefined, '', '{', 'null', '[]', JSON.stringify({ ...att, sha256: 'x' }), JSON.stringify({ ...att, skills: [] }), JSON.stringify({ ...att, skills: ['A B'] }), JSON.stringify({ ...att, skills: 'trade-session' }), JSON.stringify({ ...att, config: 7 })]) {
    assert.strictEqual(H.parseAttestation(bad), null, String(bad));
  }
});

test('isOpencodeTranscript / attestedSkills: an opencode stream and the attested file unchanged, or nothing', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'opencode.json');
  fs.writeFileSync(file, HS.expectedFiles(ROOT)['workspace/opencode.json']);
  const att = H.attestation(file, ROOT);
  const oc = path.join(dir, 'oc.jsonl');
  fs.writeFileSync(oc, `not json\n${JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } })}`);
  assert.strictEqual(H.isOpencodeTranscript(oc), true);
  assert.deepStrictEqual(H.attestedSkills(att, ROOT, { transcript: oc }), H.CORE);
  const claude = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(claude, `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: {} })}`);
  assert.strictEqual(H.isOpencodeTranscript(claude), false, 'its first event decides');
  assert.strictEqual(H.isOpencodeTranscript(path.join(dir, 'gone.jsonl')), false);
  assert.deepStrictEqual(H.attestedSkills(att, ROOT, { transcript: claude }), []);
  assert.deepStrictEqual(H.attestedSkills(att, ROOT, {}), []);
  assert.deepStrictEqual(H.attestedSkills(null, ROOT, { transcript: oc }), []);
  assert.deepStrictEqual(H.attestedSkills({ ...att, sha256: '0'.repeat(64) }, ROOT, { transcript: oc }), []);
  // Only what was attested, of what is embedded.
  assert.deepStrictEqual(H.attestedSkills({ ...att, skills: ['trade-plan', 'manage-position'] }, ROOT, { transcript: oc }), ['trade-plan']);
});
